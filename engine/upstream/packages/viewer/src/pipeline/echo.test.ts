// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import { EventPipeline } from "./index";
import { createEchoFilter } from "./echo";

class FakeInput {
  readonly nodeType = 1;
  readonly tagName = "INPUT";
  readonly type = "text";
  value = "";
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  selectionDirection: "forward" | "backward" | "none" | null = "none";

  setSelectionRange(start: number, end: number, direction: "forward" | "backward" | "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
}

class FakeContenteditable {
  readonly nodeType = 1;
  readonly tagName = "DIV";
  readonly isContentEditable = true;
  innerHTML = "";

  set value(_value: string) {
    throw new Error("contenteditable must never receive a scalar value snap");
  }
}

function inputEvent(id: number, text: string, isChecked = false): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: { source: IncrementalSource.Input, id, text, isChecked },
  } as eventWithTime;
}

function focusEvent(id: number, type: 5 | 6 = 5): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: { source: IncrementalSource.MouseInteraction, type, id, x: 0, y: 0 },
  } as eventWithTime;
}

function mutationEvent(
  texts: Array<{ id: number; value: string | null }>,
  adds: Array<{
    parentId: number;
    nextId: number | null;
    node: { id: number; type: number; textContent?: string };
  }> = [],
): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: {
      source: IncrementalSource.Mutation,
      texts,
      attributes: [],
      removes: [],
      adds,
    },
  } as eventWithTime;
}

describe("F5 native local typing echo", () => {
  it("suppresses server input during a native-input burst at simulated 150ms RTT", () => {
    let now = 0;
    const timers: Array<() => void> = [];
    const echo = createEchoFilter({
      now: () => now,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    });
    const pipeline = new EventPipeline().use(echo).onReset(echo.reset);
    const field = new FakeInput();
    const focus = { element: field as unknown as HTMLInputElement, nodeId: 41 };

    for (const [character, serverValue] of [
      ["a", "a"],
      ["b", "ab"],
      ["c", "abc"],
    ] as const) {
      field.value += character;
      field.selectionStart = field.value.length;
      field.selectionEnd = field.value.length;
      echo.input(focus);
      expect(field.value).toBe(serverValue);
      now += 150;
      expect(pipeline.run(inputEvent(41, serverValue), { tab: "T1", nowMs: now })).toBeNull();
      expect(field.value).toBe(serverValue);
    }

    now = 1_500;
    for (const callback of timers) callback();
    expect(field.value).toBe("abc");
  });

  it("reconciles the authoritative server value on blur and never suppresses checked state", () => {
    let now = 0;
    const echo = createEchoFilter({ now: () => now });
    const field = new FakeInput();
    const focus = { element: field as unknown as HTMLInputElement, nodeId: 7 };
    field.value = "x";
    echo.input(focus);
    now = 150;
    expect(echo(inputEvent(7, "server"), { tab: "T1", nowMs: now })).toBeNull();
    expect(echo(inputEvent(7, "", true), { tab: "T1", nowMs: now })).not.toBeNull();

    echo.setFocused(null);
    expect(field.value).toBe("server");
  });

  it("clears node suppression on pipeline reset", () => {
    const echo = createEchoFilter();
    const pipeline = new EventPipeline().use(echo).onReset(echo.reset);
    const field = new FakeInput();
    field.value = "a";
    echo.input({ element: field as unknown as HTMLInputElement, nodeId: 2 });
    pipeline.reset();
    const event = inputEvent(2, "remote");
    expect(pipeline.run(event, { tab: "T1", nowMs: Date.now() })).toBe(event);
  });

  it("does not arm suppression for a caret-only keydown", () => {
    const echo = createEchoFilter();
    const field = new FakeInput();
    const focus = { element: field as unknown as HTMLInputElement, nodeId: 3 };

    echo.keyDown({ key: "ArrowLeft" } as KeyboardEvent, focus);

    const event = inputEvent(3, "remote");
    expect(echo(event, { tab: "T1", nowMs: Date.now() })).toBe(event);
  });

  it("suppresses delayed focus and blur echoes so native focus remains local", () => {
    const echo = createEchoFilter();

    expect(echo(focusEvent(2), { tab: "T1", nowMs: Date.now() })).toBeNull();
    expect(echo(focusEvent(2, 6), { tab: "T1", nowMs: Date.now() })).toBeNull();
  });

  it("does not replace the submitted text with a delayed echo on Enter", () => {
    let now = 0;
    const echo = createEchoFilter({ now: () => now });
    const field = new FakeInput();
    field.value = "local";
    const focus = { element: field as unknown as HTMLInputElement, nodeId: 4 };
    echo.input(focus);
    now = 100;
    expect(echo(inputEvent(4, "server"), { tab: "T1", nowMs: now })).toBeNull();

    echo.keyDown({ key: "Enter" } as KeyboardEvent, focus);

    expect(field.value).toBe("local");
  });

  it("restores the predicted value through the H3 rebuild hook", () => {
    const echo = createEchoFilter();
    const before = new FakeInput();
    before.value = "a";
    before.selectionStart = 1;
    before.selectionEnd = 1;
    echo.input({ element: before as unknown as HTMLInputElement, nodeId: 9 });
    const snapshot = echo.restoreHook.capture({} as HTMLIFrameElement);
    expect(snapshot).not.toBeNull();
    echo.reset();

    const after = new FakeInput();
    const iframe = {
      contentDocument: { activeElement: after },
    } as unknown as HTMLIFrameElement;
    echo.restoreHook.restore(iframe, snapshot!);

    expect(after.value).toBe("a");
    expect(echo.getFocused()?.nodeId).toBe(9);
    echo.reset();
  });

  it("preserves the caret when an equal-length authoritative value snaps in", () => {
    let now = 0;
    const echo = createEchoFilter({ now: () => now });
    const field = new FakeInput();
    field.value = "local";
    field.selectionStart = 2;
    field.selectionEnd = 2;
    const focus = { element: field as unknown as HTMLInputElement, nodeId: 12 };
    echo.input(focus);
    now = 100;
    expect(echo(inputEvent(12, "SERVER"), { tab: "T1", nowMs: now })).toBeNull();

    echo.setFocused(null);

    expect(field.value).toBe("SERVER");
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(2);
  });

  it("suppresses only contenteditable subtree mutations during the native-edit window", () => {
    let now = 0;
    const echo = createEchoFilter({ now: () => now });
    const field = new FakeContenteditable();
    field.innerHTML = "local";
    const focus = {
      element: field as unknown as HTMLElement,
      nodeId: 20,
      subtreeNodeIds: new Set([20, 21]),
    };
    echo.setFocused(focus);
    echo.input(focus);

    now = 150;
    const mixed = mutationEvent([
      { id: 21, value: "server echo" },
      { id: 99, value: "unrelated" },
    ]);
    const filtered = echo(mixed, { tab: "T1", nowMs: now });

    expect(filtered).not.toBeNull();
    expect(filtered).not.toBe(mixed);
    expect((filtered!.data as { texts: Array<{ id: number }> }).texts).toEqual([
      { id: 99, value: "unrelated" },
    ]);
    expect(field.innerHTML).toBe("local");

    now = 1_001;
    const authoritative = mutationEvent([{ id: 21, value: "authoritative" }]);
    expect(echo(authoritative, { tab: "T1", nowMs: now })).toBe(authoritative);
  });

  it("tracks suppressed contenteditable additions and never applies value reconciliation", () => {
    let now = 0;
    const echo = createEchoFilter({ now: () => now });
    const field = new FakeContenteditable();
    field.innerHTML = "<b>local subtree</b>";
    const focus = {
      element: field as unknown as HTMLElement,
      nodeId: 30,
      subtreeNodeIds: new Set([30]),
    };
    echo.setFocused(focus);
    echo.input(focus);

    now = 100;
    expect(
      echo(
        mutationEvent(
          [{ id: 31, value: "same-batch server" }],
          [{ parentId: 30, nextId: null, node: { id: 31, type: 3, textContent: "server" } }],
        ),
        { tab: "T1", nowMs: now },
      ),
    ).toBeNull();
    expect(
      echo(mutationEvent([{ id: 31, value: "server 2" }]), { tab: "T1", nowMs: now }),
    ).toBeNull();

    expect(echo.restoreHook.capture({} as HTMLIFrameElement)).toBeNull();
    echo.setFocused(null);
    expect(field.innerHTML).toBe("<b>local subtree</b>");
  });
});
