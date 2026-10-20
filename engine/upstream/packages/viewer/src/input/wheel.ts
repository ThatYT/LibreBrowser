/**
 * Wheel-event forwarding without double-applying local scroll.
 *
 * Intercept `wheel` in the mirror. Walk up for a scrollable ancestor and let the browser scroll
 * it locally; if nothing consumed it (scrollTop/scrollLeft unchanged and no scrollable ancestor
 * — the maps/canvas/wheel-hijack case), forward `ptr kind:"wheel"` with dx,dy. Consumed-locally
 * scrolls reach the server ONLY via the 10Hz `scroll` sync. One path or the other, never both.
 */
import type { TabId } from "@mirror/protocol";
import {
  eventMods,
  isElement,
  pointerPosition,
  resolvePointerTarget,
  type SendInput,
} from "./pointer";

interface ScrollCandidate {
  target: Element | Window;
  x: number;
  y: number;
}

export interface WheelCaptureOptions {
  doc: Document;
  rootDoc?: Document;
  tab: TabId;
  getNodeId(node: Node): number;
  send: SendInput;
  now?: () => number;
  settleMs?: number;
  movementEpsilonPx?: number;
  /** Schedule one verification tick; called repeatedly until movement or the settle deadline. */
  afterEvent?: (callback: () => void) => void;
}

export function attachWheelCapture(options: WheelCaptureOptions): () => void {
  const now = options.now ?? (() => options.doc.defaultView?.performance?.now() ?? Date.now());
  const settleMs = options.settleMs ?? 80;
  const movementEpsilonPx = options.movementEpsilonPx ?? 0.5;
  const afterEvent =
    options.afterEvent ??
    ((callback: () => void) => {
      const view = options.doc.defaultView;
      if (view !== null) view.requestAnimationFrame(callback);
      else setTimeout(callback, 16);
    });
  let active = true;

  const onWheel = (event: WheelEvent) => {
    if (!event.isTrusted) return;
    const candidates = scrollCandidates(event.target, options.doc, event.deltaX, event.deltaY);
    const forward = () => {
      const target = resolvePointerTarget(event.target, options.getNodeId);
      options.send({
        t: "ptr",
        tab: options.tab,
        kind: "wheel",
        ...pointerPosition(event, target, options.doc, options.rootDoc),
        buttons: event.buttons,
        mods: eventMods(event),
        dx: event.deltaX,
        dy: event.deltaY,
      });
    };

    if (candidates.length === 0) {
      event.preventDefault();
      forward();
      return;
    }

    const startedAt = now();
    const verifyConsumed = () => {
      if (!active) return;
      const consumed = candidates.some(({ target, x, y }) => {
        const next = scrollPosition(target, options.doc);
        return Math.abs(next.x - x) > movementEpsilonPx || Math.abs(next.y - y) > movementEpsilonPx;
      });
      if (consumed) return;
      if (now() - startedAt >= settleMs) {
        forward();
        return;
      }
      afterEvent(verifyConsumed);
    };
    afterEvent(verifyConsumed);
  };

  options.doc.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => {
    active = false;
    options.doc.removeEventListener("wheel", onWheel, true);
  };
}

export function scrollCandidates(
  target: EventTarget | null,
  doc: Document,
  dx: number,
  dy: number,
): ScrollCandidate[] {
  const result: ScrollCandidate[] = [];
  let element = isElement(target) ? target : null;
  while (element !== null) {
    const view = doc.defaultView;
    const style = view?.getComputedStyle(element);
    if (style !== undefined && canConsume(element, style, dx, dy)) {
      result.push({ target: element, x: element.scrollLeft, y: element.scrollTop });
    }
    element = element.parentElement;
  }

  const view = doc.defaultView;
  const root = doc.scrollingElement;
  if (
    view !== null &&
    root !== null &&
    canConsumeViewport(root, view.getComputedStyle(root), dx, dy)
  ) {
    result.push({ target: view, x: view.scrollX, y: view.scrollY });
  }
  return result;
}

function canConsumeViewport(
  element: Element,
  style: CSSStyleDeclaration,
  dx: number,
  dy: number,
): boolean {
  return (
    (!axisBlocked(style.overflowX) &&
      canMove(element.scrollLeft, element.scrollWidth - element.clientWidth, dx)) ||
    (!axisBlocked(style.overflowY) &&
      canMove(element.scrollTop, element.scrollHeight - element.clientHeight, dy))
  );
}

function canConsume(element: Element, style: CSSStyleDeclaration, dx: number, dy: number): boolean {
  return (
    (axisScrollable(style.overflowX) &&
      canMove(element.scrollLeft, element.scrollWidth - element.clientWidth, dx)) ||
    (axisScrollable(style.overflowY) &&
      canMove(element.scrollTop, element.scrollHeight - element.clientHeight, dy))
  );
}

function canMove(position: number, maximum: number, delta: number): boolean {
  return delta < 0 ? position > 0 : delta > 0 ? position < maximum : false;
}

function axisScrollable(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

function axisBlocked(overflow: string): boolean {
  return overflow === "hidden" || overflow === "clip";
}

function scrollPosition(target: Element | Window, doc: Document): { x: number; y: number } {
  if (target === doc.defaultView) {
    const view = target as Window;
    return { x: view.scrollX, y: view.scrollY };
  }
  const element = target as Element;
  return { x: element.scrollLeft, y: element.scrollTop };
}
