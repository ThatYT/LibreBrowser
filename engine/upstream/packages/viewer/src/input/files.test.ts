// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { attachFileCapture } from "./files";

type Listener = (event: never) => void;

class FakeElement {
  readonly nodeType = 1;
  tagName = "INPUT";
  type = "file";
}

class FakeDocument {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string, event: object): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("file input capture", () => {
  it("observes the trusted native picker change without canceling its default action", () => {
    vi.stubGlobal("Element", FakeElement);
    const doc = new FakeDocument();
    const selected: unknown[] = [];
    const input = new FakeElement();
    const detach = attachFileCapture({
      doc: doc as unknown as Document,
      tab: "tab-1",
      select: (tab, target) => selected.push({ tab, target }),
    });
    const event = { target: input, isTrusted: true, preventDefault: vi.fn() };

    doc.fire("change", event);
    expect(selected).toEqual([{ tab: "tab-1", target: input }]);
    expect(event.preventDefault).not.toHaveBeenCalled();
    detach();
    expect(doc.listeners.get("change")?.size).toBe(0);
  });

  it("ignores synthetic and non-file changes", () => {
    vi.stubGlobal("Element", FakeElement);
    const doc = new FakeDocument();
    const select = vi.fn();
    attachFileCapture({ doc: doc as unknown as Document, tab: "tab-1", select });
    const input = new FakeElement();
    doc.fire("change", { target: input, isTrusted: false });
    input.type = "text";
    doc.fire("change", { target: input, isTrusted: true });
    expect(select).not.toHaveBeenCalled();
  });
});
