/**
 * Committed value-control forwarding.
 *
 * Native controls in the inert mirror still perform local default actions. A trusted `change`
 * therefore has to reconcile the authoritative page explicitly. A shared forwarded-input clock
 * keeps ordinary typing out of this value lane while an orphan native edit (autofill, context
 * menu, spellcheck, or drop) falls back to it.
 */
import type { TabId } from "@mirror/protocol";
import { createForwardedInputClock, type ForwardedInputClock } from "./forwarded";
import {
  collectSubtreeNodeIds,
  isContenteditableEchoField,
  isEchoField,
  type EditableFocus,
} from "./keys";
import { isElement, resolvePointerTarget, type SendInput } from "./pointer";

const DEFAULT_TYPING_WINDOW_MS = 1_000;
const DEFAULT_ORPHAN_WINDOW_MS = 150;
const DEFAULT_COMPOSING_FLUSH_MS = 500;
const UNSUPPORTED_INPUT_TYPES = new Set(["button", "file", "hidden", "image", "reset", "submit"]);

export interface ChangeCaptureOptions {
  doc: Document;
  tab: TabId;
  getNodeId(node: Node): number;
  send: SendInput;
  forwardedClock?: ForwardedInputClock;
  now?: () => number;
  typingWindowMs?: number;
  orphanWindowMs?: number;
  composingFlushMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onEditableInput?(focus: EditableFocus): void;
}

type ValueControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function attachChangeCapture(options: ChangeCaptureOptions): {
  dispose(): void;
  flush(target: Element): void;
} {
  const now = options.now ?? Date.now;
  const typingWindowMs = options.typingWindowMs ?? DEFAULT_TYPING_WINDOW_MS;
  const orphanWindowMs = options.orphanWindowMs ?? DEFAULT_ORPHAN_WINDOW_MS;
  const composingFlushMs = options.composingFlushMs ?? DEFAULT_COMPOSING_FLUSH_MS;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const forwardedClock = options.forwardedClock ?? createForwardedInputClock();
  const valueClock = createForwardedInputClock();
  const lastValues = new WeakMap<ValueControl, string>();
  const composingNodes = new Set<number>();
  const composeFlushTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const resolveControl = (target: EventTarget | null) => {
    const control = valueControl(target);
    if (control === null) return null;
    const resolved = resolvePointerTarget(control, options.getNodeId);
    // Unlike pointer fallback, the agent value command must address the control itself.
    return resolved?.element === control ? { control, nodeId: resolved.nodeId } : null;
  };

  const sendValue = (control: ValueControl, nodeId: number, commit = false) => {
    const message: Extract<Parameters<SendInput>[0], { t: "value" }> = {
      t: "value",
      tab: options.tab,
      nodeId,
      value: control.value,
      ...(commit ? {} : { commit: false }),
    };
    const tag = control.tagName.toLowerCase();
    if (tag === "input") {
      const input = control as HTMLInputElement;
      const type = input.type.toLowerCase();
      if (type === "checkbox" || type === "radio") message.checked = input.checked;
    } else if (tag === "select" && (control as HTMLSelectElement).multiple) {
      const select = control as HTMLSelectElement;
      message.values = Array.from(select.options)
        .filter((option) => option.selected)
        .map((option) => option.value);
    }
    options.send(message);
    valueClock.mark(nodeId, now());
    lastValues.set(control, control.value);
    // Only raw key/text forwarding may suppress its matching native input event.
    // A value update has no future native input to consume: marking this clock
    // would drop the next soft-keyboard edits in a fast typing burst.
  };

  const cancelComposeFlush = (nodeId: number) => {
    const timer = composeFlushTimers.get(nodeId);
    if (timer === undefined) return;
    cancel(timer);
    composeFlushTimers.delete(nodeId);
  };

  const armComposeFlush = (control: ValueControl, nodeId: number) => {
    cancelComposeFlush(nodeId);
    const timer = schedule(() => {
      composeFlushTimers.delete(nodeId);
      composingNodes.delete(nodeId);
      sendValue(control, nodeId);
    }, composingFlushMs);
    composeFlushTimers.set(nodeId, timer);
  };

  const onInput = (event: Event) => {
    if (!event.isTrusted) return;
    if (isElement(event.target) && isContenteditableEchoField(event.target)) {
      const host = contenteditableHost(event.target);
      const resolved = resolvePointerTarget(host, options.getNodeId);
      if (resolved !== null) {
        options.onEditableInput?.({
          element: host,
          nodeId: resolved.nodeId,
          subtreeNodeIds: collectSubtreeNodeIds(host, options.getNodeId),
        });
      }
      // A contenteditable has no scalar value command. Its raw key/text relay is authoritative.
      return;
    }
    const resolved = resolveControl(event.target);
    if (resolved === null || !isEchoField(resolved.control)) return;
    options.onEditableInput?.({ element: resolved.control, nodeId: resolved.nodeId });
    const isComposing = (event as InputEvent).isComposing;
    if (composingNodes.has(resolved.nodeId) && !isComposing) {
      composingNodes.delete(resolved.nodeId);
      cancelComposeFlush(resolved.nodeId);
    }
    if (isComposing) {
      composingNodes.add(resolved.nodeId);
      armComposeFlush(resolved.control, resolved.nodeId);
      return;
    }
    const lastForwardedAt = forwardedClock.get(resolved.nodeId);
    if (lastForwardedAt !== undefined && now() - lastForwardedAt < orphanWindowMs) return;
    const lastValueAt = valueClock.get(resolved.nodeId);
    if (
      lastValueAt !== undefined &&
      now() - lastValueAt < orphanWindowMs &&
      lastValues.get(resolved.control) === resolved.control.value
    )
      return;
    sendValue(resolved.control, resolved.nodeId);
  };

  const onChange = (event: Event) => {
    if (!event.isTrusted) return;
    const resolved = resolveControl(event.target);
    if (resolved === null) return;
    const lastForwardedAt = forwardedClock.get(resolved.nodeId);
    if (
      isEchoField(resolved.control) &&
      lastForwardedAt !== undefined &&
      now() - lastForwardedAt < typingWindowMs
    ) {
      return;
    }
    sendValue(resolved.control, resolved.nodeId, true);
  };

  const onCompositionStart = (event: CompositionEvent) => {
    if (!event.isTrusted) return;
    const resolved = resolveControl(event.target);
    if (resolved === null || !isEchoField(resolved.control)) return;
    composingNodes.add(resolved.nodeId);
    armComposeFlush(resolved.control, resolved.nodeId);
  };

  const onCompositionEnd = (event: CompositionEvent) => {
    if (!event.isTrusted) return;
    const resolved = resolveControl(event.target);
    if (resolved === null || !isEchoField(resolved.control)) return;
    composingNodes.delete(resolved.nodeId);
    cancelComposeFlush(resolved.nodeId);
    sendValue(resolved.control, resolved.nodeId);
  };

  const flush = (target: Element) => {
    const resolved = resolveControl(target);
    if (resolved === null || !composingNodes.has(resolved.nodeId)) return;
    composingNodes.delete(resolved.nodeId);
    cancelComposeFlush(resolved.nodeId);
    sendValue(resolved.control, resolved.nodeId);
  };

  options.doc.addEventListener("input", onInput, true);
  options.doc.addEventListener("change", onChange, true);
  options.doc.addEventListener("compositionstart", onCompositionStart, true);
  options.doc.addEventListener("compositionend", onCompositionEnd, true);
  const dispose = () => {
    options.doc.removeEventListener("input", onInput, true);
    options.doc.removeEventListener("change", onChange, true);
    options.doc.removeEventListener("compositionstart", onCompositionStart, true);
    options.doc.removeEventListener("compositionend", onCompositionEnd, true);
    composingNodes.clear();
    for (const timer of composeFlushTimers.values()) cancel(timer);
    composeFlushTimers.clear();
  };
  return { dispose, flush };
}

function contenteditableHost(element: HTMLElement): HTMLElement {
  let host = element;
  while (host.parentElement !== null && isContenteditableEchoField(host.parentElement)) {
    host = host.parentElement;
  }
  return host;
}

function valueControl(target: EventTarget | null): ValueControl | null {
  if (!isElement(target)) return null;
  const tag = target.tagName.toLowerCase();
  if (tag === "select") {
    return target as HTMLSelectElement;
  }
  if (tag === "textarea") return target as HTMLTextAreaElement;
  if (tag !== "input") return null;
  const input = target as HTMLInputElement;
  return UNSUPPORTED_INPUT_TYPES.has(input.type.toLowerCase()) ? null : input;
}
