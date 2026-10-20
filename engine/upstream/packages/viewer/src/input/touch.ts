import type { TabId } from "@mirror/protocol";
import { eventMods, pointerPosition, resolvePointerTarget, type SendInput } from "./pointer";
import { scrollCandidates } from "./wheel";

export interface TouchCaptureOptions {
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

const TOUCH_SLOP_PX = 10;

interface TouchGesture {
  mode: "pending" | "scroll-pan" | "hijack-wheel";
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  target: EventTarget;
  latestEvent: TouchEvent | null;
  latestTouch: Touch | null;
  verifyConsumed: (() => void) | null;
}

export function attachTouchCapture(options: TouchCaptureOptions): () => void {
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
  let gesture: TouchGesture | null = null;
  let active = true;

  const forwardWheel = (
    current: TouchGesture,
    touch: Touch,
    event: TouchEvent,
    dx: number,
    dy: number,
  ) => {
    const target = resolvePointerTarget(current.target, options.getNodeId);
    options.send({
      t: "ptr",
      tab: options.tab,
      kind: "wheel",
      ...pointerPosition(touch, target, options.doc, options.rootDoc),
      buttons: 0,
      mods: eventMods(event),
      dx,
      dy,
    });
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      gesture = null;
      return;
    }
    const touch = event.touches[0]!;
    gesture = {
      mode: "pending",
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      target: touch.target,
      latestEvent: null,
      latestTouch: null,
      verifyConsumed: null,
    };
  };

  const onTouchMove = (event: TouchEvent) => {
    if (gesture === null) return;
    if (event.touches.length !== 1) {
      gesture = null;
      return;
    }

    const touch = event.touches[0]!;
    if (gesture.mode === "pending") {
      const distance = Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY);
      if (distance <= TOUCH_SLOP_PX) return;

      const deltaX = -(touch.clientX - gesture.startX);
      const deltaY = -(touch.clientY - gesture.startY);
      const candidates = scrollCandidates(gesture.target, options.doc, deltaX, deltaY);
      if (candidates.length > 0) {
        gesture.mode = "scroll-pan";
        gesture.latestEvent = event;
        gesture.latestTouch = touch;
        const verifyingGesture = gesture;
        const startedAt = now();
        const verifyConsumed = () => {
          if (!active || gesture !== verifyingGesture || verifyingGesture.mode !== "scroll-pan") {
            return true;
          }
          const consumed = candidates.some(({ target, x, y }) => {
            const next = scrollPosition(target, options.doc);
            return (
              Math.abs(next.x - x) > movementEpsilonPx || Math.abs(next.y - y) > movementEpsilonPx
            );
          });
          if (consumed) {
            verifyingGesture.verifyConsumed = null;
            return true;
          }
          if (now() - startedAt < settleMs) return false;

          const latestEvent = verifyingGesture.latestEvent;
          const latestTouch = verifyingGesture.latestTouch;
          if (latestEvent === null || latestTouch === null) return true;
          verifyingGesture.mode = "hijack-wheel";
          verifyingGesture.verifyConsumed = null;
          latestEvent.preventDefault();
          forwardWheel(
            verifyingGesture,
            latestTouch,
            latestEvent,
            -(latestTouch.clientX - verifyingGesture.startX),
            -(latestTouch.clientY - verifyingGesture.startY),
          );
          verifyingGesture.lastX = latestTouch.clientX;
          verifyingGesture.lastY = latestTouch.clientY;
          return true;
        };
        const verifyAfterEvent = () => {
          if (!verifyConsumed()) afterEvent(verifyAfterEvent);
        };
        verifyingGesture.verifyConsumed = () => {
          verifyConsumed();
        };
        afterEvent(verifyAfterEvent);
        return;
      }
      gesture.mode = "hijack-wheel";
    }

    if (gesture.mode === "scroll-pan") {
      gesture.latestEvent = event;
      gesture.latestTouch = touch;
      gesture.verifyConsumed?.();
      return;
    }

    event.preventDefault();
    forwardWheel(
      gesture,
      touch,
      event,
      -(touch.clientX - gesture.lastX),
      -(touch.clientY - gesture.lastY),
    );
    gesture.lastX = touch.clientX;
    gesture.lastY = touch.clientY;
  };

  const clearGesture = () => {
    gesture = null;
  };

  const listenerOptions = { capture: true, passive: false } as const;
  options.doc.addEventListener("touchstart", onTouchStart, listenerOptions);
  options.doc.addEventListener("touchmove", onTouchMove, listenerOptions);
  options.doc.addEventListener("touchend", clearGesture, listenerOptions);
  options.doc.addEventListener("touchcancel", clearGesture, listenerOptions);
  return () => {
    active = false;
    gesture = null;
    options.doc.removeEventListener("touchstart", onTouchStart, true);
    options.doc.removeEventListener("touchmove", onTouchMove, true);
    options.doc.removeEventListener("touchend", clearGesture, true);
    options.doc.removeEventListener("touchcancel", clearGesture, true);
  };
}

function scrollPosition(target: Element | Window, doc: Document): { x: number; y: number } {
  if (target === doc.defaultView) {
    const view = target as Window;
    return { x: view.scrollX, y: view.scrollY };
  }
  const element = target as Element;
  return { x: element.scrollLeft, y: element.scrollTop };
}
