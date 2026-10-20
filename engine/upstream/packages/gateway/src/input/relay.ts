/**
 * Gateway input dispatch.
 * The same relay handles IME composition and clipboard paste through CDP.
 *
 * Pointer coordinates are resolved against the live recorder mirror for every dispatch. Rects
 * are never retained, and a queued down/up pair therefore performs two independent lookups.
 */
import { type RectResult, type Up } from "@mirror/protocol";
import { resolveNode, type FrameHop, type ResolveNodeDeps } from "../browser/resolvenode";
import type { AgentLink, CdpSend } from "../types";
import { describeKey } from "./keymap";

const DEFAULT_RECT_TIMEOUT_MS = 100;
const IFRAME_EDGE_INSET_PX = 0.01;

export interface InputRelayDeps {
  agentLink: AgentLink;
  send: CdpSend;
  /** Private recorder bridge used for DOM RemoteObjects without a page-global helper. */
  callBridge?: ResolveNodeDeps["callBridge"];
  /** Live targetId -> CDP sessionId resolution comes from the browser TargetRegistry. */
  sessionFor(targetId: string): string | undefined;
  /** Role state is injected by the WS/roles composition; non-drivers are always rejected. */
  isDriver(viewerId: string): boolean;
  /** H3/D7's viewport-only epoch gate. */
  allowsInput(viewerId: string, tabId: string): boolean;
  /** Accepted activity delays routine trim snapshots without coupling the relay to TabHub. */
  noteInput(tabId: string): void;
  /** Current negotiated CSS-pixel viewport, used to clamp live rect coordinates. */
  viewportFor(tabId: string): { w: number; h: number } | undefined;
  rectTimeoutMs?: number;
}

export type InputMsg = Extract<
  Up,
  { t: "ptr" } | { t: "key" } | { t: "text" } | { t: "value" } | { t: "ime" } | { t: "scroll" }
>;

/** Resolves true only when an authorized message reached its authoritative dispatch path. */
export type InputRelay = ((viewerId: string, msg: InputMsg) => Promise<boolean>) & {
  /** Test-mode instrumentation; production callers need not expose it. */
  rectFallbacksFor(tabId: string): number;
};

export function createInputRelay(deps: InputRelayDeps): InputRelay {
  const rectTimeoutMs = deps.rectTimeoutMs ?? DEFAULT_RECT_TIMEOUT_MS;
  if (!Number.isSafeInteger(rectTimeoutMs) || rectTimeoutMs < 1) {
    throw new RangeError("rectTimeoutMs must be a positive safe integer");
  }

  // WebSocket callbacks may overlap. Serialize per tab so a fast `up` can never overtake a
  // slower `down` rect round-trip (the same ordering requirement applies to raw key pairs).
  const tabTails = new Map<string, Promise<void>>();
  const rectFallbacks = new Map<string, number>();
  const resolverDeps: ResolveNodeDeps = {
    agentLink: deps.agentLink,
    send: deps.send,
    ...(deps.callBridge === undefined ? {} : { callBridge: deps.callBridge }),
    sessionFor: deps.sessionFor,
  };

  const relay = ((viewerId, msg) => {
    const prior = tabTails.get(msg.tab) ?? Promise.resolve();
    const result = prior.then(() => dispatch(viewerId, msg));
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tabTails.set(msg.tab, tail);
    void tail.finally(() => {
      if (tabTails.get(msg.tab) === tail) tabTails.delete(msg.tab);
    });
    return result;
  }) as InputRelay;
  relay.rectFallbacksFor = (tabId) => rectFallbacks.get(tabId) ?? 0;
  return relay;

  async function dispatch(viewerId: string, msg: InputMsg): Promise<boolean> {
    if (!deps.isDriver(viewerId) || !deps.allowsInput(viewerId, msg.tab)) return false;

    const sessionId = deps.sessionFor(msg.tab);
    if (sessionId === undefined) return false;
    deps.noteInput(msg.tab);

    try {
      switch (msg.t) {
        case "ptr":
          await dispatchPointer(sessionId, msg);
          return true;
        case "key":
          await dispatchKey(sessionId, msg);
          return true;
        case "text":
          await deps.send(sessionId, "Input.insertText", { text: msg.insert });
          return true;
        case "ime":
          await deps.send(sessionId, "Input.imeSetComposition", {
            text: msg.text,
            selectionStart: msg.selStart,
            selectionEnd: msg.selEnd,
          });
          return true;
        case "value": {
          const resolved = await resolveNode(resolverDeps, msg.tab, msg.nodeId);
          const response = await deps.agentLink.sendCmd(resolved.targetId, {
            cmd: "value",
            nodeId: resolved.localId,
            value: msg.value,
            ...(msg.commit === undefined ? {} : { commit: msg.commit }),
            ...(msg.checked === undefined ? {} : { checked: msg.checked }),
            ...(msg.values === undefined ? {} : { values: msg.values }),
          });
          return response.ok;
        }
        case "scroll": {
          // Protocol nodeId 0 is the top-level window sentinel, not an rrweb mirror node.
          const resolved =
            msg.nodeId === 0
              ? { targetId: msg.tab, localId: 0 }
              : await resolveNode(resolverDeps, msg.tab, msg.nodeId);
          const response = await deps.agentLink.sendCmd(resolved.targetId, {
            cmd: "scroll",
            nodeId: resolved.localId,
            x: msg.x,
            y: msg.y,
          });
          return response.ok;
        }
      }
    } catch {
      // Navigation/detach can invalidate a session between authorization and dispatch. Input is
      // ephemeral; dropping that event is safer than turning a transient race into a WS failure.
      return false;
    }
  }

  async function dispatchPointer(
    sessionId: string,
    msg: Extract<InputMsg, { t: "ptr" }>,
  ): Promise<void> {
    const { x, y } = await resolvePoint(msg);
    const common: Record<string, unknown> = {
      x,
      y,
      modifiers: msg.mods,
      buttons: msg.buttons,
    };

    switch (msg.kind) {
      case "move":
        await deps.send(sessionId, "Input.dispatchMouseEvent", {
          ...common,
          type: "mouseMoved",
          button: "none",
        });
        return;
      case "wheel":
        await deps.send(sessionId, "Input.dispatchMouseEvent", {
          ...common,
          type: "mouseWheel",
          button: "none",
          deltaX: finiteOr(msg.dx, 0),
          deltaY: finiteOr(msg.dy, 0),
        });
        return;
      case "down":
      case "up":
        await deps.send(sessionId, "Input.dispatchMouseEvent", {
          ...common,
          type: msg.kind === "down" ? "mousePressed" : "mouseReleased",
          button: mouseButton(msg.button),
          clickCount: msg.clicks ?? 1,
        });
    }
  }

  async function resolvePoint(msg: Extract<InputMsg, { t: "ptr" }>): Promise<Point> {
    const fallback = clampToViewport(msg.tab, finiteOr(msg.vx, 0), finiteOr(msg.vy, 0));
    let resolvedRect: ResolvedRect;
    try {
      resolvedRect = await resolveRect(msg.tab, msg.nodeId);
    } catch {
      rectFallbacks.set(msg.tab, (rectFallbacks.get(msg.tab) ?? 0) + 1);
      return fallback;
    }

    // Clamp relative fractions as hostile/garbled wire values must not project beyond the node.
    const rx = clamp(finiteOr(msg.rx, 0), 0, 1);
    const ry = clamp(finiteOr(msg.ry, 0), 0, 1);
    let x = resolvedRect.rect.x + rx * resolvedRect.rect.w;
    let y = resolvedRect.rect.y + ry * resolvedRect.rect.h;
    if (resolvedRect.iframeClip !== undefined) {
      x = clampInto(x, resolvedRect.iframeClip.left, resolvedRect.iframeClip.right);
      y = clampInto(y, resolvedRect.iframeClip.top, resolvedRect.iframeClip.bottom);
    }
    return clampToViewport(msg.tab, x, y);
  }

  async function resolveRect(tabId: string, nodeId: number): Promise<ResolvedRect> {
    const resolved = await resolveNode(resolverDeps, tabId, nodeId);
    const response = await withTimeout(
      deps.agentLink.sendCmd(resolved.targetId, {
        cmd: "rect",
        nodeId: resolved.localId,
      }),
      rectTimeoutMs,
    );
    if (!response.ok || !isRectResult(response.data)) {
      throw new Error(response.err ?? "rect command failed");
    }
    if (resolved.frameHops.length === 0) return { rect: response.data };

    const iframeRects: RectResult[] = [];
    for (const hop of resolved.frameHops) {
      const iframeResponse = await withTimeout(
        deps.agentLink.sendCmd(hop.targetId, {
          cmd: "rect",
          nodeId: hop.iframeNodeId,
        }),
        rectTimeoutMs,
      );
      if (!iframeResponse.ok || !isRectResult(iframeResponse.data)) {
        throw new Error(iframeResponse.err ?? "iframe rect command failed");
      }
      iframeRects.push(iframeResponse.data);
    }
    return composeRemoteRect(response.data, resolved.frameHops, iframeRects);
  }

  function clampToViewport(tabId: string, x: number, y: number): Point {
    const viewport = deps.viewportFor(tabId);
    if (viewport === undefined) return { x: Math.max(0, x), y: Math.max(0, y) };
    return {
      x: clamp(x, 0, Math.max(0, viewport.w - Number.EPSILON)),
      y: clamp(y, 0, Math.max(0, viewport.h - Number.EPSILON)),
    };
  }

  async function dispatchKey(
    sessionId: string,
    msg: Extract<InputMsg, { t: "key" }>,
  ): Promise<void> {
    const description = describeKey(msg.code, msg.key, msg.mods);
    if (msg.kind === "up") {
      await deps.send(sessionId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: msg.mods,
        key: description.key,
        code: description.code,
        windowsVirtualKeyCode: description.keyCode,
        location: description.location,
        isKeypad: description.location === 3,
      });
      return;
    }

    await deps.send(sessionId, "Input.dispatchKeyEvent", {
      type: description.text ? "keyDown" : "rawKeyDown",
      modifiers: msg.mods,
      key: description.key,
      code: description.code,
      text: description.text,
      unmodifiedText: description.text,
      windowsVirtualKeyCode: description.keyCode,
      location: description.location,
      isKeypad: description.location === 3,
    });
  }
}

interface Point {
  x: number;
  y: number;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ResolvedRect {
  rect: RectResult;
  iframeClip?: Bounds;
}

function composeRemoteRect(
  childRect: RectResult,
  frameHops: readonly FrameHop[],
  iframeRects: readonly RectResult[],
): ResolvedRect {
  if (frameHops.length === 0 || frameHops.length !== iframeRects.length) {
    throw new Error("OOPIF rect composition received an invalid frame chain");
  }

  let x = childRect.x;
  let y = childRect.y;
  let iframeClip: Bounds | undefined;
  let visible = childRect.visible && childRect.w > 0 && childRect.h > 0;

  // Each child rect is relative to its own viewport. Walk inner-to-outer, translating both the
  // node and the accumulated clipping region through every iframe element.
  for (let index = iframeRects.length - 1; index >= 0; index -= 1) {
    const iframeRect = iframeRects[index]!;
    x += iframeRect.x;
    y += iframeRect.y;
    if (iframeClip !== undefined) {
      iframeClip = translateBounds(iframeClip, iframeRect.x, iframeRect.y);
    }

    const iframeBounds = boundsForRect(iframeRect);
    if (iframeBounds === undefined) {
      throw new Error("OOPIF iframe has an empty dispatch rect");
    }
    iframeClip =
      iframeClip === undefined ? iframeBounds : intersectBounds(iframeClip, iframeBounds);
    if (iframeClip === undefined) {
      throw new Error("Nested OOPIF iframe rects do not overlap");
    }
    visible = visible && iframeRect.visible;
  }

  const rect = { ...childRect, x, y };
  if (iframeClip === undefined) throw new Error("OOPIF rect composition produced no clip");
  visible = visible && intersectBounds(boundsForRect(rect), iframeClip) !== undefined;
  return { rect: { ...rect, visible }, iframeClip };
}

function boundsForRect(rect: Pick<RectResult, "x" | "y" | "w" | "h">): Bounds | undefined {
  if (rect.w <= 0 || rect.h <= 0) return undefined;
  return {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.w,
    bottom: rect.y + rect.h,
  };
}

function translateBounds(bounds: Bounds, x: number, y: number): Bounds {
  return {
    left: bounds.left + x,
    top: bounds.top + y,
    right: bounds.right + x,
    bottom: bounds.bottom + y,
  };
}

function intersectBounds(a: Bounds | undefined, b: Bounds): Bounds | undefined {
  if (a === undefined) return undefined;
  const intersection = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return intersection.right > intersection.left && intersection.bottom > intersection.top
    ? intersection
    : undefined;
}

function clampInto(value: number, min: number, max: number): number {
  if (!(max > min)) throw new Error("Cannot clamp into an empty OOPIF rect");
  const inset = Math.min(IFRAME_EDGE_INSET_PX, (max - min) / 2);
  return clamp(value, min + inset, max - inset);
}

function isRectResult(value: unknown): value is RectResult {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Partial<RectResult>;
  return (
    [rect.x, rect.y, rect.w, rect.h].every(
      (part) => typeof part === "number" && Number.isFinite(part),
    ) && typeof rect.visible === "boolean"
  );
}

function mouseButton(button: 0 | 1 | 2 | undefined): "left" | "middle" | "right" {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("rect command timed out")), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
