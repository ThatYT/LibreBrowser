/**
 * Keyboard capture and forwarding.
 *
 * keydown/keyup -> `key` msgs with CDP mods encoding (protocol Mod). Native text controls keep
 * editing and caret defaults; browser/page shortcuts that escape the field are contained.
 * Value-control paste is synchronized by change capture. Contenteditable paste and
 * composition commits are forwarded as text.
 */
import type { TabId } from "@mirror/protocol";
import type { ForwardedInputClock } from "./forwarded";
import { eventMods, isElement, type SendInput } from "./pointer";

export interface EditableFocus {
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement;
  nodeId: number;
  /** rrweb ids already present below an editing host, captured before native editing reshapes it. */
  subtreeNodeIds?: ReadonlySet<number>;
}

export interface KeyCaptureOptions {
  doc: Document;
  /** Root of the replay document set, used to resolve focus through iframe boundaries. */
  focusRoot?: Document;
  tab: TabId;
  getNodeId(node: Node): number;
  send: SendInput;
  forwardedClock?: ForwardedInputClock;
  now?: () => number;
  flushComposing?(target: Element): void;
  onEditableFocus?(focus: EditableFocus | null): void;
  onKeyDown?(event: KeyboardEvent, focus: EditableFocus | null): void;
}

/** Explicitly local browser/mirror shortcuts. They never reach the remote page. */
export const LOCAL_SHORTCUTS = new Set(["c", "f"]);

export function isLocalShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">,
): boolean {
  return (
    !event.altKey &&
    (event.ctrlKey || event.metaKey) &&
    LOCAL_SHORTCUTS.has(event.key.toLowerCase())
  );
}

export function isTextEditable(
  element: Element | null,
): element is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (element === null) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea") {
    const textarea = element as HTMLTextAreaElement;
    return !textarea.disabled && !textarea.readOnly;
  }
  if (tag === "input") {
    const input = element as HTMLInputElement;
    return (
      !input.disabled && !input.readOnly && !NON_TEXT_INPUT_TYPES.has(input.type.toLowerCase())
    );
  }
  return isContenteditableEchoField(element);
}

export function isValueEchoField(
  element: Element,
): element is HTMLInputElement | HTMLTextAreaElement {
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag !== "input") return false;
  const type = (element as HTMLInputElement).type.toLowerCase();
  return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit";
}

export function isContenteditableEchoField(element: Element): element is HTMLElement {
  return (element as HTMLElement).isContentEditable;
}

export function isEchoField(element: Element): element is HTMLElement {
  return isValueEchoField(element) || isContenteditableEchoField(element);
}

const NATIVE_EDITING_KEYS = new Set([
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const NATIVE_EDITING_SHORTCUTS = new Set(["a", "x", "z", "y", "v"]);
const FUNCTION_KEY = /^F(?:[1-9]|1\d|2[0-4])$/;

/** True only when a key default could leave the mirrored field or invoke viewer-browser UI. */
export function shouldPreventEchoFieldDefault(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
): boolean {
  if (event.key === "Escape" || FUNCTION_KEY.test(event.key)) return true;
  if (NATIVE_EDITING_KEYS.has(event.key)) return false;
  if (event.key === "Enter") {
    // LOAD-BEARING: F1's capture-phase submit containment kills input implicit form submission.
    return false;
  }
  if (event.key === "Tab") return event.altKey || event.ctrlKey || event.metaKey;
  if (event.ctrlKey || event.metaKey) {
    if (NATIVE_EDITING_SHORTCUTS.has(event.key.toLowerCase()) && !event.altKey) return false;
    // AltGraph is commonly reported as Ctrl+Alt; a produced character must keep its native edit.
    if (event.altKey && event.key.length === 1) return false;
    return true;
  }
  if (event.key.length === 1 || event.key === "Dead" || event.key === "Process") return false;
  return true;
}

export function attachKeyCapture(options: KeyCaptureOptions): () => void {
  const now = options.now ?? Date.now;
  let focused: EditableFocus | null = null;
  let enterDown = false;
  const notifyFocus = () => {
    const active = deepActiveElement(options.focusRoot ?? options.doc);
    if (!isTextEditable(active)) {
      focused = null;
      options.onEditableFocus?.(null);
      return;
    }
    focused = {
      element: active,
      nodeId: nearestNodeId(active, options.getNodeId),
      subtreeNodeIds: isContenteditableEchoField(active)
        ? collectSubtreeNodeIds(active, options.getNodeId)
        : undefined,
    };
    options.onEditableFocus?.(focused);
  };
  const onFocusIn = () => notifyFocus();
  const onFocusOut = (event: FocusEvent) => {
    const target = isElement(event.target) ? event.target : focused?.element;
    if (target !== undefined) options.flushComposing?.(target);
    queueMicrotask(notifyFocus);
  };
  const onKey = (event: KeyboardEvent, kind: "down" | "up") => {
    if (!event.isTrusted || event.isComposing || isLocalShortcut(event)) return;
    if (event.key === "Enter") enterDown = kind === "down";
    // A value control pastes locally and sends its resulting value. Forwarding
    // Ctrl/Cmd-V as well can paste the remote browser's unrelated clipboard.
    if (
      isElement(event.target) &&
      isValueEchoField(event.target) &&
      !event.altKey &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "v"
    )
      return;
    if (kind === "down") options.onKeyDown?.(event, focused);
    const target = isElement(event.target) ? event.target : focused?.element;
    if (kind === "down" && event.key === "Enter" && target !== undefined && isEchoField(target)) {
      options.flushComposing?.(target);
    }
    options.send({
      t: "key",
      tab: options.tab,
      kind,
      key: event.key,
      code: event.code,
      mods: eventMods(event),
    });
    // A key that types nothing on the remote (mobile soft-keyboard "Unidentified"/keyCode-229
    // placeholders resolve to text "" -> no-op dispatch) must NOT poison the forwarded-key clock;
    // otherwise it suppresses change.ts's value-sync — the ONLY lane that carries mobile text to
    // the remote — for every keystroke, so nothing ever reaches the field. Real character keys
    // (event.key.length === 1) and true-IME keys (isComposing, bailed above) are unaffected.
    if (
      kind === "down" &&
      target !== undefined &&
      isEchoField(target) &&
      event.key !== "Unidentified"
    ) {
      options.forwardedClock?.mark(nearestNodeId(target, options.getNodeId), now());
    }
    if (target === undefined || !isEchoField(target) || shouldPreventEchoFieldDefault(event)) {
      event.preventDefault();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => onKey(event, "down");
  const onKeyUp = (event: KeyboardEvent) => onKey(event, "up");
  const onBeforeInput = (event: InputEvent) => {
    if (
      (event.inputType !== "insertLineBreak" && event.inputType !== "insertParagraph") ||
      !isElement(event.target) ||
      !isEchoField(event.target)
    ) {
      return;
    }
    event.preventDefault();
    if (enterDown) return;
    options.flushComposing?.(event.target);
    const mods = eventMods(event as InputEvent & KeyboardEvent);
    options.send({
      t: "key",
      tab: options.tab,
      kind: "down",
      key: "Enter",
      code: "Enter",
      mods,
    });
    options.send({
      t: "key",
      tab: options.tab,
      kind: "up",
      key: "Enter",
      code: "Enter",
      mods,
    });
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!event.isTrusted) return;
    const target = isElement(event.target) ? event.target : focused?.element;
    if (target !== undefined && isValueEchoField(target)) {
      // The native input event carries the complete post-paste value, including
      // local selection replacement. It must not be suppressed by an earlier key.
      options.forwardedClock?.forget(nearestNodeId(target, options.getNodeId));
      return;
    }
    const insert = event.clipboardData?.getData("text/plain");
    if (insert === undefined) return;
    options.send({ t: "text", tab: options.tab, insert });
    if (target !== undefined && isEchoField(target)) {
      options.forwardedClock?.mark(nearestNodeId(target, options.getNodeId), now());
    } else {
      event.preventDefault();
    }
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    if (!event.isTrusted || !isElement(event.target) || !isContenteditableEchoField(event.target)) {
      return;
    }
    options.send({ t: "text", tab: options.tab, insert: event.data });
    options.forwardedClock?.mark(nearestNodeId(event.target, options.getNodeId), now());
  };

  options.doc.addEventListener("focusin", onFocusIn, true);
  options.doc.addEventListener("focusout", onFocusOut, true);
  options.doc.addEventListener("keydown", onKeyDown, true);
  options.doc.addEventListener("keyup", onKeyUp, true);
  options.doc.addEventListener("beforeinput", onBeforeInput, true);
  options.doc.addEventListener("paste", onPaste, true);
  options.doc.addEventListener("compositionend", onCompositionEnd, true);
  notifyFocus();
  return () => {
    options.doc.removeEventListener("focusin", onFocusIn, true);
    options.doc.removeEventListener("focusout", onFocusOut, true);
    options.doc.removeEventListener("keydown", onKeyDown, true);
    options.doc.removeEventListener("keyup", onKeyUp, true);
    options.doc.removeEventListener("beforeinput", onBeforeInput, true);
    options.doc.removeEventListener("paste", onPaste, true);
    options.doc.removeEventListener("compositionend", onCompositionEnd, true);
  };
}

/** Return the real focused element, descending through same-origin active iframe elements. */
export function deepActiveElement(root: Document): Element | null {
  let doc = root;
  let active: Element | null = null;
  const visited = new Set<Document>();
  while (!visited.has(doc)) {
    visited.add(doc);
    active = doc.activeElement;
    if (active === null || active.tagName.toLowerCase() !== "iframe") break;
    try {
      const child = (active as HTMLIFrameElement).contentDocument;
      if (child === null) break;
      doc = child;
    } catch {
      break;
    }
  }
  return active;
}

function nearestNodeId(element: Element, getNodeId: (node: Node) => number): number {
  let current: Element | null = element;
  while (current !== null) {
    const id = getNodeId(current);
    if (id >= 0) return id;
    current = current.parentElement;
  }
  return -1;
}

/** Capture ids before a contenteditable default can replace its text-node subtree. */
export function collectSubtreeNodeIds(
  element: Element,
  getNodeId: (node: Node) => number,
): ReadonlySet<number> {
  const ids = new Set<number>();
  const pending: Node[] = [element];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const id = getNodeId(node);
    if (id >= 0) ids.add(id);
    pending.push(...Array.from(node.childNodes));
  }
  return ids;
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);
