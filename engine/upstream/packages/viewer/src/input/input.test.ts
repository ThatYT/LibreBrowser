// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeUp, encodeMsg, type Up } from "@mirror/protocol";
import { attachChangeCapture } from "./change";
import { attachDefaultActionContainment } from "./default-actions";
import { createForwardedInputClock } from "./forwarded";
import { attachKeyCapture, isLocalShortcut, shouldPreventEchoFieldDefault } from "./keys";
import {
  attachPointerCapture,
  pointerPosition,
  resolvePointerTarget,
  toRootViewport,
} from "./pointer";
import { attachWheelCapture } from "./wheel";

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
  href: string | null = null;
  type = "text";
  value = "";
  checked = false;
  disabled = false;
  readOnly = false;
  multiple = false;
  options: { selected: boolean; value: string }[] = [];
  isContentEditable = false;
  childNodes: FakeElement[] = [];

  constructor(
    readonly nodeId: number,
    readonly rect = { left: 0, top: 0, width: 100, height: 100 },
  ) {}

  getBoundingClientRect() {
    return this.rect;
  }

  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current !== null) {
      if (
        selector === "a[href],area[href]" &&
        (current.tagName === "A" || current.tagName === "AREA") &&
        current.href !== null
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
}

class FakeDocument {
  readonly listeners = new Map<string, Set<Listener>>();
  activeElement: FakeElement | null = null;
  scrollingElement: FakeElement | null = null;
  readonly defaultView = {
    scrollX: 0,
    scrollY: 0,
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

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { callback: () => void; runAt: number }>();
  const setTimer = ((callback: () => void, delay = 0) => {
    const id = nextId++;
    tasks.set(id, { callback, runAt: now + delay });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
    tasks.delete(timer as unknown as number);
  }) as unknown as typeof clearTimeout;
  const advance = (elapsed: number) => {
    const deadline = now + elapsed;
    for (;;) {
      let due: [number, { callback: () => void; runAt: number }] | undefined;
      for (const task of tasks) {
        if (task[1].runAt <= deadline && (due === undefined || task[1].runAt < due[1].runAt)) {
          due = task;
        }
      }
      if (due === undefined) break;
      tasks.delete(due[0]);
      now = due[1].runAt;
      due[1].callback();
    }
    now = deadline;
  };
  return { setTimer, clearTimer, advance, pending: () => tasks.size };
}

function mouse(target: FakeElement, overrides: Record<string, unknown> = {}) {
  return {
    target,
    isTrusted: true,
    clientX: 35,
    clientY: 45,
    button: 0,
    buttons: 1,
    detail: 1,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

function keyboard(target: FakeElement, key: string, overrides: Record<string, unknown> = {}) {
  return {
    target,
    isTrusted: true,
    isComposing: false,
    key,
    code: `Key${key.toUpperCase()}`,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => vi.stubGlobal("Element", FakeElement));
afterEach(() => vi.unstubAllGlobals());

describe("P1 input capture", () => {
  it("suppresses a trusted anchor click locally while preserving upstream pointer relay", () => {
    const doc = new FakeDocument();
    const link = new FakeElement(17, { left: 10, top: 20, width: 50, height: 50 });
    link.tagName = "A";
    link.href = "https://origin.example/private";
    const child = new FakeElement(-1);
    child.parentElement = link;
    const sent: Up[] = [];
    attachDefaultActionContainment({ doc: doc as unknown as Document });
    attachPointerCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
    });

    doc.fire("mousedown", mouse(child));
    doc.fire("mouseup", mouse(child, { buttons: 0 }));
    const click = mouse(child);
    doc.fire("click", click);

    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(sent).toMatchObject([
      { t: "ptr", kind: "down", nodeId: 17 },
      { t: "ptr", kind: "up", nodeId: 17 },
    ]);
  });

  it("suppresses middle-click link activation and form submission defaults", () => {
    const doc = new FakeDocument();
    const link = new FakeElement(17);
    link.tagName = "A";
    link.href = "https://origin.example/new-window";
    attachDefaultActionContainment({ doc: doc as unknown as Document });

    const auxclick = mouse(link, { button: 1, buttons: 0 });
    const submit = { isTrusted: true, preventDefault: vi.fn() };
    doc.fire("auxclick", auxclick);
    doc.fire("submit", submit);

    expect(auxclick.preventDefault).toHaveBeenCalledOnce();
    expect(submit.preventDefault).toHaveBeenCalledOnce();
  });

  it("resolves the nearest serialized ancestor and sends node-relative click coordinates", () => {
    const doc = new FakeDocument();
    const link = new FakeElement(17, { left: 10, top: 20, width: 50, height: 50 });
    const textWrapper = new FakeElement(-1);
    textWrapper.parentElement = link;
    const sent: Up[] = [];
    const detach = attachPointerCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
    });

    doc.fire("mousedown", mouse(textWrapper));
    doc.fire("mouseup", mouse(textWrapper, { buttons: 0 }));

    expect(sent).toMatchObject([
      { t: "ptr", kind: "down", nodeId: 17, rx: 0.5, ry: 0.5, vx: 35, vy: 45 },
      { t: "ptr", kind: "up", nodeId: 17, rx: 0.5, ry: 0.5, vx: 35, vy: 45 },
    ]);
    detach();
    expect(doc.listeners.get("mousedown")?.size).toBe(0);
  });

  it("does not retransmit synthetic rrweb pointer events", () => {
    const doc = new FakeDocument();
    const target = new FakeElement(17);
    const sent: Up[] = [];
    attachPointerCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
    });

    doc.fire("mousedown", mouse(target, { isTrusted: false }));
    doc.fire("mouseup", mouse(target, { isTrusted: false, buttons: 0 }));

    expect(sent).toEqual([]);
  });

  it("round-trips a trusted mirror select commit onto the value wire contract", () => {
    const doc = new FakeDocument();
    const select = new FakeElement(23);
    select.tagName = "SELECT";
    select.value = "second";
    const received: Up[] = [];
    attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => received.push(decodeUp(encodeMsg(message))),
      forwardedClock: createForwardedInputClock(),
    });

    doc.fire("change", { target: select, isTrusted: true });

    expect(received).toEqual([{ t: "value", tab: "T1", nodeId: 23, value: "second" }]);
  });

  it("forwards checked and multiple-select state without fighting actively typed text", () => {
    const doc = new FakeDocument();
    const sent: Up[] = [];
    let now = 100;
    const text = new FakeElement(30);
    text.tagName = "INPUT";
    text.value = "typed";
    const clock = createForwardedInputClock();
    const change = attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      forwardedClock: clock,
      now: () => now,
    });
    clock.mark(30, now);
    doc.fire("change", { target: text, isTrusted: true });

    const checkbox = new FakeElement(31);
    checkbox.tagName = "INPUT";
    checkbox.type = "checkbox";
    checkbox.value = "on";
    checkbox.checked = true;
    doc.fire("change", { target: checkbox, isTrusted: true });

    const radio = new FakeElement(32);
    radio.tagName = "INPUT";
    radio.type = "radio";
    radio.value = "second";
    radio.checked = true;
    doc.fire("change", { target: radio, isTrusted: true });

    const multiple = new FakeElement(33);
    multiple.tagName = "SELECT";
    multiple.multiple = true;
    multiple.value = "beta";
    multiple.options = [
      { value: "alpha", selected: false },
      { value: "beta", selected: true },
      { value: "gamma", selected: true },
    ];
    doc.fire("change", { target: multiple, isTrusted: true });
    expect(sent).toEqual([
      { t: "value", tab: "T1", nodeId: 31, value: "on", checked: true },
      { t: "value", tab: "T1", nodeId: 32, value: "second", checked: true },
      {
        t: "value",
        tab: "T1",
        nodeId: 33,
        value: "beta",
        values: ["beta", "gamma"],
      },
    ]);

    now = 1_101;
    doc.fire("change", { target: text, isTrusted: true });
    expect(sent.at(-1)).toEqual({ t: "value", tab: "T1", nodeId: 30, value: "typed" });

    change.dispose();
    expect(doc.listeners.get("change")?.size).toBe(0);
    expect(doc.listeners.get("input")?.size).toBe(0);
  });

  it("keeps Ctrl/Cmd-C and Ctrl/Cmd-F local through an explicit allowlist", () => {
    expect(isLocalShortcut({ key: "f", ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isLocalShortcut({ key: "C", ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isLocalShortcut({ key: "v", ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
  });

  it.each([
    ["printable", { key: "q" }, false],
    ["shift printable", { key: "Q", shiftKey: true }, false],
    ["word delete", { key: "Backspace", ctrlKey: true }, false],
    ["shift selection", { key: "ArrowLeft", shiftKey: true }, false],
    ["home", { key: "Home" }, false],
    ["page down", { key: "PageDown" }, false],
    ["enter", { key: "Enter" }, false],
    ["shift tab", { key: "Tab", shiftKey: true }, false],
    ["select all", { key: "a", ctrlKey: true }, false],
    ["undo", { key: "z", metaKey: true }, false],
    ["escape", { key: "Escape" }, true],
    ["function key", { key: "F5" }, true],
    ["browser location", { key: "l", ctrlKey: true }, true],
    ["browser tab", { key: "t", metaKey: true }, true],
  ])("applies the native editable default policy for %s", (_name, overrides, expected) => {
    expect(
      shouldPreventEchoFieldDefault({
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...overrides,
      }),
    ).toBe(expected);
  });

  it("forwards raw keys while containing only escaping defaults in echo fields", () => {
    const doc = new FakeDocument();
    const input = new FakeElement(39);
    input.tagName = "INPUT";
    doc.activeElement = input;
    const sent: Up[] = [];
    attachKeyCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      forwardedClock: createForwardedInputClock(),
    });

    const printable = keyboard(input, "q");
    const browserShortcut = keyboard(input, "l", { ctrlKey: true });
    const outside = new FakeElement(38);
    const outsidePrintable = keyboard(outside, "q");
    doc.fire("keydown", printable);
    doc.fire("keydown", browserShortcut);
    doc.fire("keydown", outsidePrintable);

    expect(printable.preventDefault).not.toHaveBeenCalled();
    expect(browserShortcut.preventDefault).toHaveBeenCalledOnce();
    expect(outsidePrintable.preventDefault).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(3);
    expect(sent).toMatchObject([
      { t: "key", kind: "down", key: "q" },
      { t: "key", kind: "down", key: "l" },
      { t: "key", kind: "down", key: "q" },
    ]);
  });

  it("lets printable contenteditable keys edit natively while containing browser shortcuts", () => {
    const doc = new FakeDocument();
    const contenteditable = new FakeElement(44);
    contenteditable.isContentEditable = true;
    doc.activeElement = contenteditable;
    const focused: number[] = [];
    attachKeyCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: () => {},
      onEditableFocus: (focus) => {
        if (focus !== null) focused.push(focus.nodeId);
      },
    });

    const printable = keyboard(contenteditable, "q");
    const browserShortcut = keyboard(contenteditable, "l", { ctrlKey: true });
    doc.fire("keydown", printable);
    doc.fire("keydown", browserShortcut);

    expect(focused).toEqual([44]);
    expect(printable.preventDefault).not.toHaveBeenCalled();
    expect(browserShortcut.preventDefault).toHaveBeenCalledOnce();
  });

  it("sends the complete native paste value without replaying the remote clipboard", () => {
    const doc = new FakeDocument();
    const input = new FakeElement(40);
    input.tagName = "INPUT";
    doc.activeElement = input;
    const sent: Up[] = [];
    let now = 100;
    const clock = createForwardedInputClock();
    attachKeyCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      forwardedClock: clock,
      now: () => now,
    });
    attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      forwardedClock: clock,
      now: () => now,
    });
    const paste = {
      target: input,
      isTrusted: true,
      clipboardData: { getData: () => "paste" },
      preventDefault: vi.fn(),
    };
    clock.mark(40, now);
    doc.fire("keydown", keyboard(input, "v", { ctrlKey: true }));
    expect(sent).toEqual([]);
    doc.fire("paste", paste);
    input.value = "prefix paste suffix";
    now = 101;
    doc.fire("input", { target: input, isTrusted: true });

    expect(paste.preventDefault).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { t: "value", commit: false, tab: "T1", nodeId: 40, value: "prefix paste suffix" },
    ]);
  });

  it("forwards an orphan native input through the existing value message once", () => {
    const doc = new FakeDocument();
    const input = new FakeElement(41);
    input.tagName = "INPUT";
    input.value = "spellchecked";
    const sent: Up[] = [];
    const inputs: number[] = [];
    const clock = createForwardedInputClock();
    attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      forwardedClock: clock,
      now: () => 500,
      onEditableInput: (focus) => inputs.push(focus.nodeId),
    });

    doc.fire("input", { target: input, isTrusted: true });
    doc.fire("change", { target: input, isTrusted: true });

    expect(inputs).toEqual([41]);
    expect(sent).toEqual([
      { t: "value", tab: "T1", nodeId: 41, value: "spellchecked", commit: false },
      { t: "value", tab: "T1", nodeId: 41, value: "spellchecked" },
    ]);
  });

  it("does not let a mobile Unidentified keydown poison the value-sync clock", () => {
    const doc = new FakeDocument();
    const input = new FakeElement(44);
    input.tagName = "INPUT";
    doc.activeElement = input;
    const sent: Up[] = [];
    const clock = createForwardedInputClock();
    attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      forwardedClock: clock,
      now: () => 500,
    });
    attachKeyCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      forwardedClock: clock,
      now: () => 500,
    });

    // Mobile soft keyboard: an "Unidentified" keydown types nothing on the remote, then the
    // input event carries the character locally. The Unidentified key must NOT mark the clock,
    // so the value-sync (the only lane that reaches the remote on mobile) is free to fire.
    input.value = "a";
    doc.fire("keydown", keyboard(input, "Unidentified"));
    doc.fire("input", { target: input, isTrusted: true });

    expect(sent).toContainEqual({ t: "value", commit: false, tab: "T1", nodeId: 44, value: "a" });

    // A value sync must not suppress the next value sync in the same typing window.
    for (const value of ["ab", "abc", "abcd", "abcde", "abcdef"]) {
      input.value = value;
      doc.fire("keydown", keyboard(input, "Unidentified"));
      doc.fire("input", { target: input, isTrusted: true });
      expect(sent.at(-1)).toEqual({ t: "value", commit: false, tab: "T1", nodeId: 44, value });
    }

    // Contrast: a real character key DOES mark the clock, suppressing the redundant value-sync
    // (the raw key already typed the character remotely) — existing desktop behavior preserved.
    const other = new FakeElement(45);
    other.tagName = "INPUT";
    other.value = "b";
    doc.activeElement = other;
    const before = sent.length;
    doc.fire("keydown", keyboard(other, "b"));
    doc.fire("input", { target: other, isTrusted: true });
    expect(sent.slice(before).some((m) => (m as { t: string }).t === "value")).toBe(false);
  });

  it("forwards native input and contenteditable composition commits without value duplicates", () => {
    const doc = new FakeDocument();
    const input = new FakeElement(42);
    input.tagName = "INPUT";
    doc.activeElement = input;
    const contenteditable = new FakeElement(43);
    contenteditable.isContentEditable = true;
    const sent: Up[] = [];
    const inputs: number[] = [];
    const clock = createForwardedInputClock();
    attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      forwardedClock: clock,
      onEditableInput: (focus) => inputs.push(focus.nodeId),
    });
    attachKeyCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      forwardedClock: clock,
    });

    doc.fire("compositionstart", { target: input, isTrusted: true, data: "" });
    input.value = "漢";
    doc.fire("input", { target: input, isTrusted: true, isComposing: true });
    input.value = "漢字";
    doc.fire("compositionend", { target: input, isTrusted: true, data: "漢字" });
    doc.fire("input", { target: input, isTrusted: true, isComposing: false });
    doc.fire("input", { target: contenteditable, isTrusted: true, isComposing: true });
    doc.fire("compositionend", { target: contenteditable, isTrusted: true, data: "編集" });

    expect(inputs).toEqual([42, 42, 43]);
    expect(sent).toEqual([
      { t: "value", commit: false, tab: "T1", nodeId: 42, value: "漢字" },
      { t: "text", tab: "T1", insert: "編集" },
    ]);
  });

  it("flushes a value field after composing input stays true without compositionend", () => {
    const doc = new FakeDocument();
    const input = new FakeElement(45);
    input.tagName = "INPUT";
    const sent: Up[] = [];
    const timers = createFakeTimers();
    const change = attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      composingFlushMs: 500,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    doc.fire("compositionstart", { target: input, isTrusted: true, data: "" });
    input.value = "漢";
    doc.fire("input", { target: input, isTrusted: true, isComposing: true });
    input.value = "漢字";
    doc.fire("input", { target: input, isTrusted: true, isComposing: true });

    timers.advance(499);
    expect(sent).toEqual([]);
    timers.advance(1);
    expect(sent).toEqual([{ t: "value", commit: false, tab: "T1", nodeId: 45, value: "漢字" }]);
    expect(timers.pending()).toBe(0);
    change.dispose();
  });

  it("self-heals a stale composing node on the next non-composing input", () => {
    const doc = new FakeDocument();
    const input = new FakeElement(46);
    input.tagName = "INPUT";
    input.value = "recovered";
    const sent: Up[] = [];
    const timers = createFakeTimers();
    const change = attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      composingFlushMs: 500,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    doc.fire("compositionstart", { target: input, isTrusted: true, data: "" });
    doc.fire("input", { target: input, isTrusted: true, isComposing: false });

    expect(sent).toEqual([
      { t: "value", commit: false, tab: "T1", nodeId: 46, value: "recovered" },
    ]);
    expect(timers.pending()).toBe(0);
    timers.advance(500);
    expect(sent).toHaveLength(1);
    change.dispose();
  });

  it("flushes a phantom composition before forwarding Enter keydown", () => {
    const doc = new FakeDocument();
    const input = new FakeElement(47);
    input.tagName = "INPUT";
    input.value = "committed";
    doc.activeElement = input;
    const sent: Up[] = [];
    const timers = createFakeTimers();
    const change = attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      composingFlushMs: 500,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const detachKeys = attachKeyCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      flushComposing: change.flush,
    });

    doc.fire("compositionstart", { target: input, isTrusted: true, data: "" });
    doc.fire("keydown", keyboard(input, "Enter", { code: "Enter" }));

    expect(sent).toEqual([
      { t: "value", commit: false, tab: "T1", nodeId: 47, value: "committed" },
      { t: "key", tab: "T1", kind: "down", key: "Enter", code: "Enter", mods: 0 },
    ]);
    expect(timers.pending()).toBe(0);
    detachKeys();
    change.dispose();
  });

  it("flushes a composing field before the focusout notification microtask", async () => {
    const doc = new FakeDocument();
    const input = new FakeElement(48);
    input.tagName = "INPUT";
    input.value = "blurred";
    doc.activeElement = input;
    const order: string[] = [];
    const timers = createFakeTimers();
    const change = attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => order.push(message.t),
      composingFlushMs: 500,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const detachKeys = attachKeyCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: () => {},
      flushComposing: (target) => {
        order.push("flush");
        change.flush(target);
      },
      onEditableFocus: (focus) => order.push(focus === null ? "focus:null" : "focus:field"),
    });
    order.length = 0;

    doc.fire("compositionstart", { target: input, isTrusted: true, data: "" });
    doc.activeElement = null;
    doc.fire("focusout", { target: input, isTrusted: true });

    expect(order).toEqual(["flush", "value"]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(order).toEqual(["flush", "value", "focus:null"]);
    detachKeys();
    change.dispose();
  });

  it("sends one immediate value and no text for a prompt value-field compositionend", () => {
    const doc = new FakeDocument();
    const input = new FakeElement(49);
    input.tagName = "INPUT";
    input.value = "完成";
    doc.activeElement = input;
    const sent: Up[] = [];
    const timers = createFakeTimers();
    const change = attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      composingFlushMs: 500,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const detachKeys = attachKeyCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
    });

    doc.fire("compositionstart", { target: input, isTrusted: true, data: "" });
    doc.fire("compositionend", { target: input, isTrusted: true, data: "完成" });

    expect(sent).toEqual([{ t: "value", commit: false, tab: "T1", nodeId: 49, value: "完成" }]);
    expect(timers.pending()).toBe(0);
    timers.advance(500);
    expect(sent).toHaveLength(1);
    detachKeys();
    change.dispose();
  });

  it("resets the idle timer across a legitimate multi-keystroke composing burst", () => {
    const doc = new FakeDocument();
    const input = new FakeElement(50);
    input.tagName = "INPUT";
    const sent: Up[] = [];
    const timers = createFakeTimers();
    const change = attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      composingFlushMs: 500,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    doc.fire("compositionstart", { target: input, isTrusted: true, data: "" });
    input.value = "に";
    doc.fire("input", { target: input, isTrusted: true, isComposing: true });
    timers.advance(300);
    input.value = "にほ";
    doc.fire("input", { target: input, isTrusted: true, isComposing: true });
    timers.advance(300);
    expect(sent).toEqual([]);
    input.value = "にほん";
    doc.fire("input", { target: input, isTrusted: true, isComposing: true });
    timers.advance(499);
    expect(sent).toEqual([]);
    timers.advance(1);

    expect(sent).toEqual([{ t: "value", commit: false, tab: "T1", nodeId: 50, value: "にほん" }]);
    change.dispose();
  });

  it("lets a scrollable div consume wheel locally and forwards wheel over a canvas-like target", () => {
    const doc = new FakeDocument();
    const scroller = new FakeElement(10);
    scroller.overflowY = "auto";
    scroller.scrollHeight = 500;
    const canvas = new FakeElement(20);
    const sent: Up[] = [];
    let after: (() => void) | null = null;
    attachWheelCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      afterEvent: (callback) => {
        after = callback;
      },
    });

    doc.fire("wheel", mouse(scroller, { deltaX: 0, deltaY: 80 }));
    scroller.scrollTop = 80;
    (after as (() => void) | null)?.();
    expect(sent).toEqual([]);

    const canvasWheel = mouse(canvas, { deltaX: 3, deltaY: 40 });
    doc.fire("wheel", canvasWheel);
    expect(sent).toMatchObject([{ t: "ptr", kind: "wheel", nodeId: 20, dx: 3, dy: 40 }]);
    expect(canvasWheel.preventDefault).toHaveBeenCalledOnce();
  });

  it("waits through an early animation frame for a smooth scroll to begin", () => {
    const doc = new FakeDocument();
    const scroller = new FakeElement(10);
    scroller.overflowY = "auto";
    scroller.scrollHeight = 500;
    const sent: Up[] = [];
    const checks: Array<() => void> = [];
    let now = 0;
    attachWheelCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      now: () => now,
      settleMs: 64,
      afterEvent: (callback) => checks.push(callback),
    });

    doc.fire("wheel", mouse(scroller, { deltaX: 0, deltaY: 80 }));
    now = 16;
    checks.shift()?.();
    expect(sent).toEqual([]);
    expect(checks).toHaveLength(1);

    scroller.scrollTop = 12;
    now = 32;
    checks.shift()?.();
    expect(sent).toEqual([]);
    expect(checks).toHaveLength(0);
  });

  it("forwards an eligible wheel target only after the settle window expires without movement", () => {
    const doc = new FakeDocument();
    const scroller = new FakeElement(10);
    scroller.overflowY = "auto";
    scroller.scrollHeight = 500;
    const sent: Up[] = [];
    const checks: Array<() => void> = [];
    let now = 0;
    attachWheelCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      now: () => now,
      settleMs: 48,
      afterEvent: (callback) => checks.push(callback),
    });

    doc.fire("wheel", mouse(scroller, { deltaX: 0, deltaY: 80 }));
    for (const frame of [16, 32, 48]) {
      now = frame;
      checks.shift()?.();
    }

    expect(sent).toMatchObject([{ t: "ptr", kind: "wheel", nodeId: 10, dy: 80 }]);
    expect(checks).toHaveLength(0);
  });

  it("treats an ordinary overflow-visible document viewport as locally scrollable", () => {
    const doc = new FakeDocument();
    const root = new FakeElement(1);
    root.scrollHeight = 900;
    doc.scrollingElement = root;
    const body = new FakeElement(2);
    body.parentElement = root;
    const sent: Up[] = [];
    let after: (() => void) | null = null;
    attachWheelCapture({
      doc: doc as unknown as Document,
      tab: "T1",
      getNodeId: (node) => (node as unknown as FakeElement).nodeId,
      send: (message) => sent.push(message),
      afterEvent: (callback) => {
        after = callback;
      },
    });

    doc.fire("wheel", mouse(body, { deltaX: 0, deltaY: 80 }));
    doc.defaultView.scrollY = 80;
    (after as (() => void) | null)?.();
    expect(sent).toEqual([]);
  });

  it("clamps fallback-relative coordinates", () => {
    const target = resolvePointerTarget(
      new FakeElement(1) as unknown as EventTarget,
      (node) => (node as unknown as FakeElement).nodeId,
    );
    expect(pointerPosition({ clientX: -50, clientY: 500 }, target)).toMatchObject({ rx: 0, ry: 1 });
  });

  it("keeps raw fallbacks in the replay viewport and out of viewer chrome", () => {
    const viewerFrame = {
      clientLeft: 2,
      clientTop: 2,
      offsetWidth: 804,
      offsetHeight: 604,
      getBoundingClientRect: () => ({ left: 0, top: 102, width: 804, height: 604 }),
    };
    const rootDoc = { defaultView: { frameElement: viewerFrame } } as unknown as Document;

    expect(toRootViewport(400, 250, rootDoc, rootDoc)).toEqual({
      clientX: 400,
      clientY: 250,
    });
  });

  it("composes a scaled nested iframe into replay-root coordinates", () => {
    const rootDoc = {} as Document;
    const frame = {
      clientLeft: 2,
      clientTop: 4,
      offsetWidth: 204,
      offsetHeight: 108,
      ownerDocument: rootDoc,
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 102, height: 54 }),
    };
    const childDoc = { defaultView: { frameElement: frame } } as unknown as Document;

    expect(toRootViewport(40, 20, childDoc, rootDoc)).toEqual({
      clientX: 121,
      clientY: 62,
    });
  });
});
