/**
 * Reusable state capture/restore around rrweb full-snapshot rebuilds.
 *
 * Phase-1 echo can register another hook in this collection. The built-in hook deliberately
 * captures only interaction state: focused editable, caret/selection, and non-zero scroll
 * positions. It does not copy page content across the trusted rrweb mirror boundary.
 */

interface ElementAddress {
  id: string | null;
  path: number[];
}

interface NodeAddress {
  path: number[];
}

interface InputSelection {
  kind: "input";
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}

interface RangeSelection {
  kind: "range";
  start: NodeAddress;
  startOffset: number;
  end: NodeAddress;
  endOffset: number;
}

interface ScrollState {
  target: ElementAddress;
  left: number;
  top: number;
}

interface DocumentAddress {
  frames: ElementAddress[];
}

interface AddressedElement {
  document: DocumentAddress;
  element: ElementAddress;
}

interface DocumentScrollState {
  document: DocumentAddress;
  scrollX: number;
  scrollY: number;
  elements: ScrollState[];
}

interface InteractionState {
  active: AddressedElement | null;
  selection: InputSelection | RangeSelection | null;
  documents: DocumentScrollState[];
}

export interface RebuildRestoreHook<State = unknown> {
  capture(iframe: HTMLIFrameElement): State | null;
  restore(iframe: HTMLIFrameElement, state: State): void;
}

interface CapturedHook {
  hook: RebuildRestoreHook<unknown>;
  state: unknown;
}

export type RebuildRestorePoint = CapturedHook[];

export class RebuildRestoreHooks {
  private readonly hooks: Array<RebuildRestoreHook<unknown>> = [];

  use<State>(hook: RebuildRestoreHook<State>): this {
    this.hooks.push(hook as RebuildRestoreHook<unknown>);
    return this;
  }

  capture(iframe: HTMLIFrameElement): RebuildRestorePoint {
    const captured: RebuildRestorePoint = [];
    for (const hook of this.hooks) {
      try {
        const state = hook.capture(iframe);
        if (state !== null) captured.push({ hook, state });
      } catch {
        // A page with an unusual DOM must not turn best-effort interaction restore into a resync.
      }
    }
    return captured;
  }

  restore(iframe: HTMLIFrameElement, point: RebuildRestorePoint): void {
    for (const { hook, state } of point) {
      try {
        hook.restore(iframe, state);
      } catch {
        // Other registered restore hooks still get their chance.
      }
    }
  }
}

function elementAddress(element: Element, document: Document): ElementAddress | null {
  const path: number[] = [];
  let current: Element | null = element;
  while (current !== document.documentElement) {
    const parent: Element | null = current.parentElement;
    if (parent === null) return null;
    const index = Array.prototype.indexOf.call(parent.children, current) as number;
    if (index < 0) return null;
    path.unshift(index);
    current = parent;
  }
  return { id: element.id || null, path };
}

function resolveElement(address: ElementAddress, document: Document): HTMLElement | null {
  if (address.id !== null) {
    const byId = document.getElementById(address.id);
    if (byId instanceof document.defaultView!.HTMLElement) return byId;
  }
  let current: Element = document.documentElement;
  for (const index of address.path) {
    const child = current.children.item(index);
    if (child === null) return null;
    current = child;
  }
  return current instanceof document.defaultView!.HTMLElement ? current : null;
}

function resolveDocument(address: DocumentAddress, root: Document): Document | null {
  let document = root;
  for (const frameAddress of address.frames) {
    const frame = resolveElement(frameAddress, document);
    if (frame === null || frame.tagName.toLowerCase() !== "iframe") return null;
    try {
      const child = (frame as HTMLIFrameElement).contentDocument;
      if (child === null) return null;
      document = child;
    } catch {
      return null;
    }
  }
  return document;
}

function walkDocuments(
  document: Document,
  address: DocumentAddress,
  visit: (document: Document, address: DocumentAddress) => void,
  seen = new Set<Document>(),
): void {
  if (seen.has(document)) return;
  seen.add(document);
  visit(document, address);
  for (const frame of document.querySelectorAll("iframe")) {
    const frameAddress = elementAddress(frame, document);
    if (frameAddress === null) continue;
    try {
      const child = frame.contentDocument;
      if (child !== null) {
        walkDocuments(child, { frames: [...address.frames, frameAddress] }, visit, seen);
      }
    } catch {
      // Cross-origin documents are not part of the same-origin replay document set.
    }
  }
}

function deepActiveElement(root: Document): Element | null {
  let document = root;
  let active: Element | null = null;
  const seen = new Set<Document>();
  while (!seen.has(document)) {
    seen.add(document);
    active = document.activeElement;
    if (active === null || active.tagName.toLowerCase() !== "iframe") break;
    try {
      const child = (active as HTMLIFrameElement).contentDocument;
      if (child === null) break;
      document = child;
    } catch {
      break;
    }
  }
  return active;
}

function nodeAddress(node: Node, root: Node): NodeAddress | null {
  const path: number[] = [];
  let current: Node | null = node;
  while (current !== root) {
    const parent: Node | null = current.parentNode;
    if (parent === null) return null;
    const index = Array.prototype.indexOf.call(parent.childNodes, current) as number;
    if (index < 0) return null;
    path.unshift(index);
    current = parent;
  }
  return { path };
}

function resolveNode(address: NodeAddress, root: Node): Node | null {
  let current = root;
  for (const index of address.path) {
    const child = current.childNodes.item(index);
    if (child === null) return null;
    current = child;
  }
  return current;
}

function isEditable(element: Element): element is HTMLElement {
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || (element as HTMLElement).isContentEditable;
}

function captureSelection(
  document: Document,
  active: HTMLElement,
): InputSelection | RangeSelection | null {
  if ("selectionStart" in active && "selectionEnd" in active) {
    const field = active as HTMLInputElement | HTMLTextAreaElement;
    if (field.selectionStart === null || field.selectionEnd === null) return null;
    return {
      kind: "input",
      start: field.selectionStart,
      end: field.selectionEnd,
      direction: field.selectionDirection ?? "none",
    };
  }

  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = nodeAddress(range.startContainer, active);
  const end = nodeAddress(range.endContainer, active);
  if (start === null || end === null) return null;
  return {
    kind: "range",
    start,
    startOffset: range.startOffset,
    end,
    endOffset: range.endOffset,
  };
}

function restoreSelection(
  document: Document,
  active: HTMLElement,
  state: InputSelection | RangeSelection,
): void {
  if (state.kind === "input") {
    if ("setSelectionRange" in active) {
      (active as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(
        state.start,
        state.end,
        state.direction,
      );
    }
    return;
  }

  const start = resolveNode(state.start, active);
  const end = resolveNode(state.end, active);
  if (start === null || end === null) return;
  const range = document.createRange();
  range.setStart(start, state.startOffset);
  range.setEnd(end, state.endOffset);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export const interactionRestoreHook: RebuildRestoreHook<InteractionState> = {
  capture(iframe) {
    const root = iframe.contentDocument;
    if (root === null || root.documentElement === null) return null;

    const activeElement = deepActiveElement(root);
    const active = activeElement !== null && isEditable(activeElement) ? activeElement : null;
    let activeAddress: AddressedElement | null = null;
    const documents: DocumentScrollState[] = [];
    walkDocuments(root, { frames: [] }, (document, address) => {
      const view = document.defaultView;
      if (view === null || document.documentElement === null) return;
      const elements: ScrollState[] = [];
      for (const element of document.querySelectorAll("*")) {
        if (element.scrollLeft === 0 && element.scrollTop === 0) continue;
        const target = elementAddress(element, document);
        if (target !== null) {
          elements.push({ target, left: element.scrollLeft, top: element.scrollTop });
        }
      }
      documents.push({
        document: address,
        scrollX: view.scrollX,
        scrollY: view.scrollY,
        elements,
      });
      if (active?.ownerDocument === document) {
        const element = elementAddress(active, document);
        if (element !== null) activeAddress = { document: address, element };
      }
    });

    return {
      active: activeAddress,
      selection: active === null ? null : captureSelection(active.ownerDocument, active),
      documents,
    };
  },
  restore(iframe, state) {
    const root = iframe.contentDocument;
    if (root === null || root.documentElement === null) return;

    const activeDocument =
      state.active === null ? null : resolveDocument(state.active.document, root);
    const active =
      state.active === null || activeDocument === null
        ? null
        : resolveElement(state.active.element, activeDocument);
    if (active !== null) {
      try {
        active.focus({ preventScroll: true });
      } catch {
        active.focus();
      }
      if (state.selection !== null) restoreSelection(active.ownerDocument, active, state.selection);
    }

    for (const documentState of state.documents) {
      const document = resolveDocument(documentState.document, root);
      const view = document?.defaultView;
      if (document === null || view === null || view === undefined) continue;
      for (const scroll of documentState.elements) {
        const element = resolveElement(scroll.target, document);
        element?.scrollTo({ left: scroll.left, top: scroll.top, behavior: "auto" });
      }
      view.scrollTo({
        left: documentState.scrollX,
        top: documentState.scrollY,
        behavior: "auto",
      });
    }
  },
};

export function createRebuildRestoreHooks(): RebuildRestoreHooks {
  return new RebuildRestoreHooks().use(interactionRestoreHook);
}
