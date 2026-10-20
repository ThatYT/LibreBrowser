// @vitest-environment node
import type { Up } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import { createPxView } from "./pxview";

type Listener = (event: never) => void;

class FakeImage {
  onload: (() => void) | null = null;
  src = "";
}

class FakeCanvas {
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<Listener>>();
  className = "";
  tabIndex = -1;
  width = 300;
  height = 150;
  parent: FakeContainer | null = null;
  readonly drawImage = vi.fn();
  readonly focus = vi.fn();

  setAttribute() {}
  getContext(type: string) {
    return type === "2d" ? { drawImage: this.drawImage } : null;
  }
  getBoundingClientRect() {
    return { left: 10, top: 20, width: 400, height: 200 };
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
  remove() {
    if (this.parent?.child === this) this.parent.child = null;
    this.parent = null;
  }
}

class FakeContainer {
  readonly dataset: Record<string, string> = {};
  child: FakeCanvas | { kind: "mirror" } | null = { kind: "mirror" };
  readonly canvas = new FakeCanvas();
  replaceCount = 0;
  readonly ownerDocument = {
    createElement: (name: string) => {
      if (name !== "canvas") throw new Error(`unexpected element ${name}`);
      return this.canvas;
    },
  };

  replaceChildren(child?: FakeCanvas | { kind: "mirror" }) {
    this.replaceCount += 1;
    this.child = child ?? null;
    if (child instanceof FakeCanvas) child.parent = this;
  }
}

function mouse(overrides: Record<string, unknown> = {}) {
  return {
    isTrusted: true,
    clientX: 210,
    clientY: 120,
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

describe("P2 viewer pixel fallback", () => {
  it("paints JPEG frames, sends raw viewport input, and swaps cleanly back to a mirror", () => {
    const container = new FakeContainer();
    const images: FakeImage[] = [];
    const sent: Up[] = [];
    const enterPx = vi.fn(() => container.replaceChildren());
    const enterDom = vi.fn(() => container.replaceChildren({ kind: "mirror" }));
    const view = createPxView({
      container: container as unknown as HTMLElement,
      send: (message) => sent.push(message),
      onEnterPx: enterPx,
      onEnterDom: enterDom,
      createImage: () => {
        const image = new FakeImage();
        images.push(image);
        return image as unknown as HTMLImageElement;
      },
    });

    view.selectTab("tab-1");
    view.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(enterPx).not.toHaveBeenCalled();
    expect(container.child).toEqual({ kind: "mirror" });
    view.handle({ t: "px", tab: "tab-1", data: "jpeg-base64", w: 800, h: 400 });

    expect(enterPx).toHaveBeenCalledWith("tab-1");
    expect(container.child).toBe(container.canvas);
    expect(container.canvas.width).toBe(800);
    expect(container.canvas.height).toBe(400);
    expect(images[0]?.src).toBe("data:image/jpeg;base64,jpeg-base64");
    images[0]?.onload?.();
    expect(container.canvas.drawImage).toHaveBeenCalledWith(images[0], 0, 0, 800, 400);

    container.canvas.fire("mousedown", mouse());
    expect(sent).toEqual([
      {
        t: "ptr",
        tab: "tab-1",
        kind: "down",
        nodeId: -1,
        rx: 0,
        ry: 0,
        vx: 400,
        vy: 200,
        button: 0,
        buttons: 1,
        mods: 0,
        clicks: 1,
      },
    ]);

    view.handle({ t: "mode", tab: "tab-1", mode: "dom" });
    expect(enterDom).toHaveBeenCalledWith("tab-1");
    expect(view.getCanvas()).toBeNull();
    expect(container.child).toEqual({ kind: "mirror" });
    expect(container.canvas.listeners.get("mousedown")?.size).toBe(0);

    view.handle({ t: "px", tab: "tab-1", data: "late", w: 1, h: 1 });
    expect(images).toHaveLength(1);
  });

  it("leaves the mirror host untouched while DOM mode owns it", () => {
    const container = new FakeContainer();
    const enterPx = vi.fn();
    const enterDom = vi.fn();
    const view = createPxView({
      container: container as unknown as HTMLElement,
      send: vi.fn(),
      onEnterPx: enterPx,
      onEnterDom: enterDom,
    });

    view.selectTab("tab-1");
    view.handle({ t: "mode", tab: "tab-1", mode: "dom" });
    view.selectTab("tab-2");
    view.handle({ t: "mode", tab: "tab-2", mode: "px" });

    expect(container.replaceCount).toBe(0);
    expect(container.child).toEqual({ kind: "mirror" });
    expect(enterPx).not.toHaveBeenCalled();
    expect(enterDom).not.toHaveBeenCalled();
  });
});
