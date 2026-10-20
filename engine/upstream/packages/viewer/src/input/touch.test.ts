// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Up } from "@mirror/protocol";
import { attachKeyCapture } from "./keys";
import { attachTouchCapture, type TouchCaptureOptions } from "./touch";

type Listener = (event: never) => void;

class FakeElement {
  readonly nodeType = 1;
  parentElement: FakeElement | null = null;
  scrollLeft = 0;
  scrollTop = 0;
  scrollWidth = 100;
  scrollHeight = 100;
  clientWidth = 100;
  clientHeight = 100;
  overflowX = "visible";
  overflowY = "visible";
  tagName = "DIV";
  type = "text";
  disabled = false;
  readOnly = false;
  isContentEditable = false;
  childNodes: FakeElement[] = [];

  constructor(
    readonly nodeId: number,
    readonly rect = { left: 0, top: 0, width: 100, height: 100 },
  ) {}

  getBoundingClientRect() {
    return this.rect;
  }
}

class FakeDocument {
  readonly listeners = new Map<string, Set<Listener>>();
  activeElement: FakeElement | null = null;
  scrollingElement: FakeElement | null = null;
  readonly defaultView = {
    scrollX: 0,
    scrollY: 0,
    requestAnimationFrame: vi.fn(),
    getComputedStyle: (element: FakeElement) => ({
      overflowX: element.overflowX,
      overflowY: element.overflowY,
    }),
  };

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string, event: object) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

function touch(target: FakeElement, points: Array<{ x: number; y: number }>) {
  return {
    target,
    touches: points.map(({ x, y }) => ({ target, clientX: x, clientY: y })),
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
  };
}

function beforeInput(target: FakeElement, inputType: string) {
  return {
    target,
    inputType,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
  };
}

function attachTouch(
  doc: FakeDocument,
  sent: Up[],
  timing: Pick<TouchCaptureOptions, "now" | "settleMs" | "movementEpsilonPx" | "afterEvent"> = {},
) {
  return attachTouchCapture({
    doc: doc as unknown as Document,
    tab: "T1",
    getNodeId: (node) => (node as unknown as FakeElement).nodeId,
    send: (message) => sent.push(message),
    ...timing,
  });
}

beforeEach(() => vi.stubGlobal("Element", FakeElement));
afterEach(() => vi.unstubAllGlobals());

describe("mobile input capture", () => {
  it("does not duplicate physical Enter when beforeinput also reports a line break", () => {
    const doc = new FakeDocument();
    const input = new FakeElement(30);
    input.tagName = "INPUT";
    doc.activeElement = input;
    const sent: Up[] = [];
    attachKeyCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: () => 30,
      send: (message) => sent.push(message),
    });
    const key = {
      target: input,
      key: "Enter",
      code: "Enter",
      isTrusted: true,
      isComposing: false,
      preventDefault: vi.fn(),
    };
    doc.fire("keydown", key);
    doc.fire("beforeinput", beforeInput(input, "insertLineBreak"));
    doc.fire("keyup", key);
    expect(sent.map((message) => message.t)).toEqual(["key", "key"]);
  });

  it("leaves a scroll-pan local without preventing or forwarding it", () => {
    const doc = new FakeDocument();
    const scroller = new FakeElement(10);
    scroller.overflowY = "scroll";
    scroller.scrollHeight = 200;
    scroller.clientHeight = 100;
    const sent: Up[] = [];
    const checks: Array<() => void> = [];
    attachTouch(doc, sent, { afterEvent: (callback) => checks.push(callback) });

    doc.fire("touchstart", touch(scroller, [{ x: 40, y: 80 }]));
    const move = touch(scroller, [{ x: 40, y: 50 }]);
    doc.fire("touchmove", move);
    scroller.scrollTop = 30;
    checks.shift()?.();

    expect(sent).toHaveLength(0);
    expect(move.preventDefault).not.toHaveBeenCalled();
    expect(checks).toHaveLength(0);
  });

  it("forwards an eligible touch scroll only after the settle window expires without movement", () => {
    const doc = new FakeDocument();
    const scroller = new FakeElement(10);
    scroller.overflowY = "scroll";
    scroller.scrollHeight = 200;
    scroller.clientHeight = 100;
    const sent: Up[] = [];
    const checks: Array<() => void> = [];
    let now = 0;
    attachTouch(doc, sent, {
      now: () => now,
      settleMs: 48,
      afterEvent: (callback) => checks.push(callback),
    });

    doc.fire("touchstart", touch(scroller, [{ x: 40, y: 80 }]));
    const firstMove = touch(scroller, [{ x: 40, y: 50 }]);
    doc.fire("touchmove", firstMove);
    for (const frame of [16, 32, 48]) {
      now = frame;
      checks.shift()?.();
    }

    expect(sent).toMatchObject([{ t: "ptr", kind: "wheel", nodeId: 10, dy: 30 }]);
    expect(firstMove.preventDefault).toHaveBeenCalledOnce();
    expect(checks).toHaveLength(0);

    const secondMove = touch(scroller, [{ x: 40, y: 30 }]);
    doc.fire("touchmove", secondMove);
    expect(sent.at(-1)).toMatchObject({ t: "ptr", kind: "wheel", nodeId: 10, dy: 20 });
    expect(secondMove.preventDefault).toHaveBeenCalledOnce();
  });

  it("forwards a hijacked touch pan as exactly one natural-direction wheel step", () => {
    const doc = new FakeDocument();
    const target = new FakeElement(20);
    const sent: Up[] = [];
    attachTouch(doc, sent);

    doc.fire("touchstart", touch(target, [{ x: 20, y: 80 }]));
    const move = touch(target, [{ x: 24, y: 50 }]);
    doc.fire("touchmove", move);

    expect(sent).toEqual([
      {
        t: "ptr",
        tab: "T1",
        kind: "wheel",
        nodeId: 20,
        rx: 0.24,
        ry: 0.5,
        vx: 24,
        vy: 50,
        buttons: 0,
        mods: 0,
        dx: -4,
        dy: 30,
      },
    ]);
    expect(move.preventDefault).toHaveBeenCalledOnce();
  });

  it("does nothing while movement remains below the touch slop", () => {
    const doc = new FakeDocument();
    const target = new FakeElement(20);
    const sent: Up[] = [];
    attachTouch(doc, sent);

    doc.fire("touchstart", touch(target, [{ x: 20, y: 30 }]));
    const move = touch(target, [{ x: 25, y: 34 }]);
    doc.fire("touchmove", move);

    expect(sent).toHaveLength(0);
    expect(move.preventDefault).not.toHaveBeenCalled();
  });

  it("bails cleanly when a second touch joins the gesture", () => {
    const doc = new FakeDocument();
    const target = new FakeElement(20);
    const sent: Up[] = [];
    attachTouch(doc, sent);

    doc.fire("touchstart", touch(target, [{ x: 20, y: 80 }]));
    const move = touch(target, [
      { x: 20, y: 40 },
      { x: 60, y: 40 },
    ]);

    expect(() => doc.fire("touchmove", move)).not.toThrow();
    expect(sent).toHaveLength(0);
    expect(move.preventDefault).not.toHaveBeenCalled();
  });

  it("does not emit pointer messages for a sub-slop tap", () => {
    const doc = new FakeDocument();
    const target = new FakeElement(20);
    const sent: Up[] = [];
    attachTouch(doc, sent);

    const start = touch(target, [{ x: 20, y: 30 }]);
    const end = touch(target, []);
    doc.fire("touchstart", start);
    doc.fire("touchend", end);

    expect(sent).toHaveLength(0);
    expect(start.preventDefault).not.toHaveBeenCalled();
    expect(end.preventDefault).not.toHaveBeenCalled();
  });

  it("turns a textarea mobile line break into Enter down and up only", () => {
    const doc = new FakeDocument();
    const textarea = new FakeElement(30);
    textarea.tagName = "TEXTAREA";
    doc.activeElement = textarea;
    const sent: Up[] = [];
    attachKeyCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
    });
    const event = beforeInput(textarea, "insertLineBreak");

    doc.fire("beforeinput", event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      { t: "key", tab: "T1", kind: "down", key: "Enter", code: "Enter", mods: 0 },
      { t: "key", tab: "T1", kind: "up", key: "Enter", code: "Enter", mods: 0 },
    ]);
    expect(sent.some((message) => message.t === "value" || message.t === "text")).toBe(false);
  });

  it("leaves a mobile line break at a non-echo target untouched", () => {
    const doc = new FakeDocument();
    const target = new FakeElement(30);
    const sent: Up[] = [];
    attachKeyCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
    });
    const event = beforeInput(target, "insertLineBreak");

    doc.fire("beforeinput", event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});
