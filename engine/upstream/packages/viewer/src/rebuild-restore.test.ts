// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRebuildRestoreHooks } from "./rebuild-restore";

class FakeCollection<T> extends Array<T> {
  item(index: number): T | null {
    return this[index] ?? null;
  }
}

class FakeView {
  HTMLElement = FakeElement;
  scrollX = 0;
  scrollY = 0;

  scrollTo(options: ScrollToOptions) {
    this.scrollX = options.left ?? this.scrollX;
    this.scrollY = options.top ?? this.scrollY;
  }
}

class FakeElement {
  readonly children = new FakeCollection<FakeElement>();
  readonly childNodes = this.children as unknown as FakeCollection<Node>;
  parentElement: FakeElement | null = null;
  parentNode: FakeElement | null = null;
  scrollLeft = 0;
  scrollTop = 0;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selectionDirection: "forward" | "backward" | "none" | null = null;
  isContentEditable = false;
  contentDocument: FakeDocument | null = null;

  constructor(
    readonly owner: FakeDocument,
    readonly tagName: string,
    readonly id = "",
  ) {}

  get ownerDocument() {
    return this.owner;
  }

  append(child: FakeElement) {
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
  }

  focus() {
    this.owner.activeElement = this;
  }

  setSelectionRange(start: number, end: number, direction: "forward" | "backward" | "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }

  scrollTo(options: ScrollToOptions) {
    this.scrollLeft = options.left ?? this.scrollLeft;
    this.scrollTop = options.top ?? this.scrollTop;
  }
}

class FakeDocument {
  readonly defaultView = new FakeView();
  readonly documentElement = new FakeElement(this, "HTML");
  activeElement: FakeElement | null = null;

  getElementById(id: string): FakeElement | null {
    return this.querySelectorAll("*").find((element) => element.id === id) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      result.push(element);
      element.children.forEach(visit);
    };
    visit(this.documentElement);
    return selector === "iframe"
      ? result.filter((element) => element.tagName === "IFRAME")
      : result;
  }

  getSelection() {
    return null;
  }
}

function editableDocument() {
  const document = new FakeDocument();
  const body = new FakeElement(document, "BODY");
  const scroller = new FakeElement(document, "DIV", "editor-pane");
  const input = new FakeElement(document, "INPUT", "message");
  document.documentElement.append(body);
  body.append(scroller);
  scroller.append(input);
  return { document, scroller, input };
}

function framedEditableDocument() {
  const root = new FakeDocument();
  const body = new FakeElement(root, "BODY");
  const frame = new FakeElement(root, "IFRAME", "embed");
  const child = editableDocument();
  frame.contentDocument = child.document;
  root.documentElement.append(body);
  body.append(frame);
  root.activeElement = frame;
  return { root, frame, child };
}

describe("synthetic rrweb rebuild interaction restore", () => {
  it("re-focuses the editable and restores caret plus page/element scroll", () => {
    const before = editableDocument();
    before.document.defaultView.scrollTo({ left: 13, top: 47 });
    before.scroller.scrollTo({ left: 5, top: 29 });
    before.input.focus();
    before.input.setSelectionRange(2, 6, "backward");

    const iframe = {
      contentDocument: before.document,
      contentWindow: before.document.defaultView,
    } as unknown as HTMLIFrameElement;
    const hooks = createRebuildRestoreHooks();
    const restorePoint = hooks.capture(iframe);

    const after = editableDocument();
    Object.assign(iframe, {
      contentDocument: after.document,
      contentWindow: after.document.defaultView,
    });
    hooks.restore(iframe, restorePoint);

    expect(after.document.activeElement).toBe(after.input);
    expect([
      after.input.selectionStart,
      after.input.selectionEnd,
      after.input.selectionDirection,
    ]).toEqual([2, 6, "backward"]);
    expect([after.scroller.scrollLeft, after.scroller.scrollTop]).toEqual([5, 29]);
    expect([after.document.defaultView.scrollX, after.document.defaultView.scrollY]).toEqual([
      13, 47,
    ]);
  });

  it("restores focus, caret, and scroll in a nested same-origin document", () => {
    const before = framedEditableDocument();
    before.root.defaultView.scrollTo({ left: 3, top: 7 });
    before.child.document.defaultView.scrollTo({ left: 13, top: 47 });
    before.child.scroller.scrollTo({ left: 5, top: 29 });
    before.child.input.focus();
    before.child.input.setSelectionRange(1, 4, "forward");

    const iframe = { contentDocument: before.root } as unknown as HTMLIFrameElement;
    const hooks = createRebuildRestoreHooks();
    const restorePoint = hooks.capture(iframe);

    const after = framedEditableDocument();
    Object.assign(iframe, { contentDocument: after.root });
    hooks.restore(iframe, restorePoint);

    expect(after.child.document.activeElement).toBe(after.child.input);
    expect([
      after.child.input.selectionStart,
      after.child.input.selectionEnd,
      after.child.input.selectionDirection,
    ]).toEqual([1, 4, "forward"]);
    expect([after.child.scroller.scrollLeft, after.child.scroller.scrollTop]).toEqual([5, 29]);
    expect([
      after.child.document.defaultView.scrollX,
      after.child.document.defaultView.scrollY,
    ]).toEqual([13, 47]);
    expect([after.root.defaultView.scrollX, after.root.defaultView.scrollY]).toEqual([3, 7]);
  });
});
