// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Up } from "@mirror/protocol";
import type { Replayer } from "@rrweb/replay";
import { attachMirrorInput } from ".";

type Listener = (event: never) => void;

class FakeMutationObserver {
  constructor(readonly callback: MutationCallback) {}
  observe() {}
  disconnect() {}
}

class FakeElement {
  readonly nodeType = 1;
  readonly listeners = new Map<string, Set<Listener>>();
  readonly descendants: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  contentDocument: FakeDocument | null = null;
  clientLeft = 0;
  clientTop = 0;
  scrollLeft = 0;
  scrollTop = 0;
  scrollWidth = 100;
  scrollHeight = 100;
  clientWidth = 100;
  clientHeight = 100;
  overflowX = "visible";
  overflowY = "visible";
  href: string | null = null;
  type = "text";
  value = "";
  disabled = false;
  readOnly = false;
  multiple = false;
  isContentEditable = false;

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly nodeId: number,
    readonly tagName = "DIV",
    readonly rect = { left: 0, top: 0, width: 100, height: 100 },
  ) {}

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string, event: object = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  getBoundingClientRect() {
    return this.rect;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === "iframe"
      ? this.descendants.filter((element) => element.tagName === "IFRAME")
      : [];
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
  readonly nodeType = 9;
  readonly listeners = new Map<string, Set<Listener>>();
  readonly elements: FakeElement[] = [];
  readonly animationFrames: Array<() => void> = [];
  activeElement: FakeElement | null = null;
  scrollingElement: FakeElement | null = null;
  documentElement: FakeElement;
  readonly defaultView: {
    MutationObserver: typeof FakeMutationObserver;
    frameElement: FakeElement | null;
    scrollX: number;
    scrollY: number;
    performance: { now(): number };
    requestAnimationFrame(callback: () => void): number;
    getComputedStyle(element: FakeElement): { overflowX: string; overflowY: string };
  };

  constructor(frameElement: FakeElement | null = null) {
    this.documentElement = new FakeElement(this, 1, "HTML");
    this.defaultView = {
      MutationObserver: FakeMutationObserver,
      frameElement,
      scrollX: 0,
      scrollY: 0,
      performance: { now: () => 0 },
      requestAnimationFrame: (callback) => {
        this.animationFrames.push(callback);
        return this.animationFrames.length;
      },
      getComputedStyle: (element) => ({
        overflowX: element.overflowX,
        overflowY: element.overflowY,
      }),
    };
  }

  add(element: FakeElement) {
    this.elements.push(element);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === "iframe"
      ? this.elements.filter((element) => element.tagName === "IFRAME")
      : [];
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

  flushAnimationFrame() {
    const callbacks = this.animationFrames.splice(0);
    for (const callback of callbacks) callback();
  }
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

function keyboard(target: FakeElement) {
  return {
    target,
    isTrusted: true,
    isComposing: false,
    key: "q",
    code: "KeyQ",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
  };
}

describe("mirror input document set", () => {
  it("relays child input, contains child links, composes coordinates, and follows document swaps", () => {
    const root = new FakeDocument();
    const frame = new FakeElement(root, 10, "IFRAME", {
      left: 100,
      top: 200,
      width: 300,
      height: 200,
    });
    frame.clientLeft = 2;
    frame.clientTop = 3;
    const child = new FakeDocument(frame);
    frame.contentDocument = child;
    root.add(frame);
    root.activeElement = frame;

    const input = new FakeElement(child, 41, "INPUT");
    const link = new FakeElement(child, 42, "A");
    link.href = "https://private.example/path";
    child.activeElement = input;
    child.add(input);
    child.add(link);

    const sent: Up[] = [];
    const replayer = {
      iframe: { contentDocument: root },
      getMirror: () => ({ getId: (node: Node) => (node as unknown as FakeElement).nodeId }),
    } as unknown as Replayer;
    const detach = attachMirrorInput({
      replayer,
      tab: "T1",
      send: (message) => sent.push(message),
    });

    child.fire("keydown", keyboard(input));
    child.fire("mousedown", mouse(link));
    child.fire("mouseup", mouse(link, { buttons: 0 }));
    const click = mouse(link, { buttons: 0 });
    child.fire("click", click);

    expect(sent).toMatchObject([
      { t: "key", kind: "down", key: "q" },
      { t: "ptr", kind: "down", nodeId: 42, vx: 137, vy: 248 },
      { t: "ptr", kind: "up", nodeId: 42, vx: 137, vy: 248 },
    ]);
    expect(click.preventDefault).toHaveBeenCalledOnce();

    // rrweb's document.open() rebuild retains Document identity but clears its listeners.
    child.listeners.clear();
    root.flushAnimationFrame();
    child.fire("keydown", keyboard(input));
    expect(sent.at(-1)).toMatchObject({ t: "key", kind: "down", key: "q" });

    const swappedWithoutLoad = new FakeDocument(frame);
    const swappedWithoutLoadInput = new FakeElement(swappedWithoutLoad, 51, "INPUT");
    swappedWithoutLoad.activeElement = swappedWithoutLoadInput;
    frame.contentDocument = swappedWithoutLoad;
    root.flushAnimationFrame();
    swappedWithoutLoad.fire("keydown", keyboard(swappedWithoutLoadInput));
    expect(sent.at(-1)).toMatchObject({ t: "key", kind: "down", key: "q" });

    const swapped = new FakeDocument(frame);
    const swappedInput = new FakeElement(swapped, 52, "INPUT");
    swapped.activeElement = swappedInput;
    frame.contentDocument = swapped;
    frame.fire("load");
    swapped.fire("keydown", keyboard(swappedInput));
    expect(sent.at(-1)).toMatchObject({ t: "key", kind: "down", key: "q" });

    detach();
    expect(child.listeners.get("keydown")?.size).toBe(0);
    expect(swappedWithoutLoad.listeners.get("keydown")?.size).toBe(0);
    expect(swapped.listeners.get("keydown")?.size).toBe(0);
    expect(frame.listeners.get("load")?.size).toBe(0);
  });
});
