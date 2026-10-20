// @vitest-environment node
import { describe, expect, it } from "vitest";
import { attachCompositionUnderline } from "./ime";

type Listener = (event: never) => void;

class FakeOverlay {
  className = "";
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  removed = false;

  setAttribute() {}
  remove() {
    this.removed = true;
  }
}

class FakeInput {
  readonly nodeType = 1;
  readonly tagName = "INPUT";
  readonly type = "text";
  readonly isContentEditable = false;
  disabled = false;
  readOnly = false;
  value = "漢";
  selectionStart: number | null = 1;
  selectionEnd: number | null = 1;
  scrollLeft = 0;
  scrollTop = 0;

  getBoundingClientRect() {
    return { left: 20, top: 30, right: 220, bottom: 54, width: 200, height: 24 };
  }
}

class FakeDocument {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly overlays: FakeOverlay[] = [];
  readonly body = {
    append: (overlay: FakeOverlay) => this.overlays.push(overlay),
  };
  readonly defaultView = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getComputedStyle: () => ({
      borderLeftWidth: "1px",
      borderTopWidth: "1px",
      paddingLeft: "4px",
      paddingTop: "2px",
      fontSize: "16px",
      lineHeight: "20px",
      font: "16px sans-serif",
    }),
  };

  createElement(tag: string) {
    if (tag === "canvas") {
      return {
        getContext: () => ({
          font: "",
          measureText: (text: string) => ({ width: [...text].length * 9 }),
        }),
      };
    }
    return new FakeOverlay();
  }

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

describe("P3-IME-V", () => {
  it("shows and updates a caret-positioned underline only during native composition", () => {
    const doc = new FakeDocument();
    const input = new FakeInput();
    const detach = attachCompositionUnderline({ doc: doc as unknown as Document });

    doc.fire("compositionstart", { target: input, isTrusted: true, data: "漢" });
    const underline = doc.overlays[0]!;
    expect(underline).toBeDefined();
    expect(underline.className).toBe("mirror-ime-composition-underline");
    expect(underline.dataset.composition).toBe("漢");
    expect(underline.style.left).toBe("25px");
    expect(underline.style.top).toBe("54px");
    expect(underline.style.borderBottom).toContain("2px solid");

    input.value = "漢字";
    input.selectionStart = 2;
    input.selectionEnd = 2;
    doc.fire("compositionupdate", { target: input, isTrusted: true, data: "漢字" });
    expect(underline.dataset.composition).toBe("漢字");
    expect(underline.style.width).toBe("18px");

    doc.fire("compositionend", { target: input, isTrusted: true, data: "漢字" });
    expect(underline.removed).toBe(true);

    detach();
    expect(doc.listeners.get("compositionstart")?.size).toBe(0);
  });
});
