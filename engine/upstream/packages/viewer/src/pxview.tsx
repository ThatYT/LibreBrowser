/**
 * Pixel fallback view.
 *
 * The mirror host is an imperative surface already (rrweb owns its iframe), so pixel mode uses
 * the same ownership model. The controller does not claim that surface until the first px frame.
 * Returning to dom removes an owned canvas; P2-PX-G immediately follows the mode message with a
 * canonical join snapshot, which rebuilds a fresh Replayer.
 */
import { Mod, type Down, type TabId, type Up } from "@mirror/protocol";

type ModeMessage = Extract<Down, { t: "mode" }>;
type PxFrame = Extract<Down, { t: "px" }>;
type PointerMessage = Extract<Up, { t: "ptr" }>;

export interface PxViewOptions {
  container: HTMLElement;
  send(message: Up): void;
  onEnterPx(tab: TabId): void;
  onEnterDom?(tab: TabId): void;
  createImage?: () => HTMLImageElement;
}

export interface PxView {
  handle(message: ModeMessage | PxFrame): void;
  selectTab(tab: TabId): void;
  getCanvas(): HTMLCanvasElement | null;
  destroy(): void;
}

export function createPxView(options: PxViewOptions): PxView {
  const modes = new Map<TabId, "dom" | "px">();
  let activeTab: TabId | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let detachInput = () => {};
  let cancelPaint = () => {};
  let destroyed = false;

  const removeCanvas = () => {
    cancelPaint();
    cancelPaint = () => {};
    detachInput();
    detachInput = () => {};
    canvas?.remove();
    canvas = null;
  };

  const enterPx = (tab: TabId): HTMLCanvasElement => {
    if (canvas !== null) return canvas;
    options.onEnterPx(tab);
    const next = options.container.ownerDocument.createElement("canvas");
    next.className = "px-canvas";
    next.tabIndex = 0;
    next.setAttribute("aria-label", "Pixel browser view");
    options.container.replaceChildren(next);
    options.container.dataset.mirrorState = "px";
    canvas = next;
    detachInput = attachPxInput({ canvas: next, tab, send: options.send });
    return next;
  };

  const enterDom = (tab: TabId) => {
    removeCanvas();
    options.container.dataset.mirrorState = "building";
    options.onEnterDom?.(tab);
  };

  return {
    handle(message) {
      if (destroyed) return;
      if (message.t === "mode") {
        modes.set(message.tab, message.mode);
        if (message.tab !== activeTab) return;
        // A mode announcement alone must not disturb rrweb's live iframe or its document-set
        // observers. Pixel mode claims the shared host only when an actual frame is available.
        if (message.mode === "dom" && canvas !== null) enterDom(message.tab);
        return;
      }
      if (message.tab !== activeTab || modes.get(message.tab) !== "px") return;
      const target = enterPx(message.tab);
      cancelPaint();
      cancelPaint = paintPxFrame(target, message, options.createImage);
    },
    selectTab(tab) {
      if (destroyed || tab === activeTab) return;
      removeCanvas();
      activeTab = tab;
    },
    getCanvas: () => canvas,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeCanvas();
      modes.clear();
      activeTab = null;
    },
  };
}

export function paintPxFrame(
  canvas: HTMLCanvasElement,
  frame: Pick<PxFrame, "data" | "w" | "h">,
  createImage: () => HTMLImageElement = () => new Image(),
): () => void {
  canvas.width = positiveDimension(frame.w);
  canvas.height = positiveDimension(frame.h);
  const context = canvas.getContext("2d");
  if (context === null) return () => {};
  const image = createImage();
  let live = true;
  image.onload = () => {
    if (!live) return;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  };
  image.src = frame.data.startsWith("data:") ? frame.data : `data:image/jpeg;base64,${frame.data}`;
  return () => {
    live = false;
    image.onload = null;
  };
}

interface PxInputOptions {
  canvas: HTMLCanvasElement;
  tab: TabId;
  send(message: Up): void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/** Attach input directly to the canvas; nodeId=-1 is the frozen wire's node-less sentinel. */
export function attachPxInput(options: PxInputOptions): () => void {
  const now = options.now ?? Date.now;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  let lastMoveAt = Number.NEGATIVE_INFINITY;
  let trailing: MouseEvent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const sendPointer = (event: MouseEvent | WheelEvent, kind: PointerMessage["kind"]) => {
    const { vx, vy } = rawCanvasPoint(options.canvas, event);
    options.send({
      t: "ptr",
      tab: options.tab,
      kind,
      nodeId: -1,
      rx: 0,
      ry: 0,
      vx,
      vy,
      button: mouseButton(event.button),
      buttons: event.buttons,
      mods: eventMods(event),
      clicks: event.detail >= 2 ? 2 : 1,
      ...(kind === "wheel"
        ? { dx: (event as WheelEvent).deltaX, dy: (event as WheelEvent).deltaY }
        : {}),
    });
  };
  const flushMove = () => {
    timer = null;
    const event = trailing;
    trailing = null;
    if (event === null) return;
    lastMoveAt = now();
    sendPointer(event, "move");
  };
  const onMove = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const elapsed = now() - lastMoveAt;
    if (elapsed >= 50) {
      if (timer !== null) cancel(timer);
      timer = null;
      trailing = null;
      lastMoveAt = now();
      sendPointer(event, "move");
    } else {
      trailing = event;
      if (timer === null) timer = schedule(flushMove, Math.max(0, 50 - elapsed));
    }
  };
  const onDown = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    options.canvas.focus();
    sendPointer(event, "down");
  };
  const onUp = (event: MouseEvent) => {
    if (event.isTrusted) sendPointer(event, "up");
  };
  const onWheel = (event: WheelEvent) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    sendPointer(event, "wheel");
  };
  const onKey = (event: KeyboardEvent, kind: "down" | "up") => {
    if (!event.isTrusted) return;
    event.preventDefault();
    options.send({
      t: "key",
      tab: options.tab,
      kind,
      key: event.key,
      code: event.code,
      mods: eventMods(event),
    });
  };
  const onKeyDown = (event: KeyboardEvent) => onKey(event, "down");
  const onKeyUp = (event: KeyboardEvent) => onKey(event, "up");
  const onContextMenu = (event: MouseEvent) => {
    if (event.isTrusted) event.preventDefault();
  };

  options.canvas.addEventListener("mousemove", onMove);
  options.canvas.addEventListener("mousedown", onDown);
  options.canvas.addEventListener("mouseup", onUp);
  options.canvas.addEventListener("wheel", onWheel, { passive: false });
  options.canvas.addEventListener("keydown", onKeyDown);
  options.canvas.addEventListener("keyup", onKeyUp);
  options.canvas.addEventListener("contextmenu", onContextMenu);
  return () => {
    options.canvas.removeEventListener("mousemove", onMove);
    options.canvas.removeEventListener("mousedown", onDown);
    options.canvas.removeEventListener("mouseup", onUp);
    options.canvas.removeEventListener("wheel", onWheel);
    options.canvas.removeEventListener("keydown", onKeyDown);
    options.canvas.removeEventListener("keyup", onKeyUp);
    options.canvas.removeEventListener("contextmenu", onContextMenu);
    if (timer !== null) cancel(timer);
  };
}

function rawCanvasPoint(
  canvas: HTMLCanvasElement,
  event: Pick<MouseEvent, "clientX" | "clientY">,
): { vx: number; vy: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    vx: scalePoint(event.clientX - rect.left, rect.width, canvas.width),
    vy: scalePoint(event.clientY - rect.top, rect.height, canvas.height),
  };
}

function scalePoint(offset: number, rendered: number, intrinsic: number): number {
  if (!Number.isFinite(rendered) || rendered <= 0) return 0;
  return Math.max(0, Math.min(intrinsic - Number.EPSILON, (offset / rendered) * intrinsic));
}

function positiveDimension(value: number): number {
  return Math.max(1, Math.round(Number.isFinite(value) ? value : 1));
}

function eventMods(
  event: Pick<MouseEvent | KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): number {
  return (
    (event.altKey ? Mod.Alt : 0) |
    (event.ctrlKey ? Mod.Ctrl : 0) |
    (event.metaKey ? Mod.Meta : 0) |
    (event.shiftKey ? Mod.Shift : 0)
  );
}

function mouseButton(button: number): 0 | 1 | 2 | undefined {
  return button === 0 || button === 1 || button === 2 ? button : undefined;
}
