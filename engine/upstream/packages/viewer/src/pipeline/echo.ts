/**
 * Local-echo typing filter.
 *
 * Plain value controls suppress rrweb INPUT echoes and reconcile their scalar `.value` on decay.
 * Contenteditables edit natively too, but their value is a DOM subtree: suppress only rrweb
 * MUTATION records addressed into the active subtree, then let later authoritative mutations flow.
 * Never attempt a `.value` snap for contenteditable. Clear the node map on resync (register onReset).
 */
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import {
  deepActiveElement,
  isContenteditableEchoField,
  isEchoField,
  isValueEchoField,
  type EditableFocus,
} from "../input/keys";
import type { RebuildRestoreHook } from "../rebuild-restore";
import type { PipelineCtx, Stage } from "./index";

interface EditingState {
  element: HTMLElement;
  lastKeyTs: number;
  pendingServerValue?: string;
  subtreeNodeIds?: Set<number>;
  timer: ReturnType<typeof setTimeout> | null;
}

interface EchoRestoreState {
  nodeId: number;
  value: string;
  lastKeyTs: number;
  pendingServerValue?: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: "forward" | "backward" | "none" | null;
}

// @rrweb/types MouseInteractions.Focus/Blur. Protocol intentionally exports only the frozen rrweb
// event surface, so keep these replay-internal discriminators local to the viewer.
const MOUSE_INTERACTION_FOCUS_EVENTS = new Set([5, 6]);

export interface EchoFilter extends Stage {
  setFocused(focus: EditableFocus | null): void;
  input(focus: EditableFocus): void;
  keyDown(event: KeyboardEvent, focus: EditableFocus | null): void;
  getFocused(): EditableFocus | null;
  reset(): void;
  restoreHook: RebuildRestoreHook<EchoRestoreState>;
}

export interface EchoFilterOptions {
  decayMs?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export function createEchoFilter(options: EchoFilterOptions = {}): EchoFilter {
  const decayMs = options.decayMs ?? 1_000;
  const now = options.now ?? Date.now;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const nodes = new Map<number, EditingState>();
  let focused: EditableFocus | null = null;

  const clearState = (nodeId: number) => {
    const state = nodes.get(nodeId);
    if (state?.timer !== null && state?.timer !== undefined) cancel(state.timer);
    nodes.delete(nodeId);
  };

  const reconcile = (nodeId: number) => {
    const state = nodes.get(nodeId);
    if (state === undefined) return;
    if (
      isValueEchoField(state.element) &&
      state.pendingServerValue !== undefined &&
      state.element.value !== state.pendingServerValue
    ) {
      const preserveSelection = state.element.value.length === state.pendingServerValue.length;
      const selectionStart = preserveSelection ? state.element.selectionStart : null;
      const selectionEnd = preserveSelection ? state.element.selectionEnd : null;
      const selectionDirection = preserveSelection ? state.element.selectionDirection : null;
      state.element.value = state.pendingServerValue;
      if (selectionStart !== null && selectionEnd !== null) {
        try {
          state.element.setSelectionRange(
            selectionStart,
            selectionEnd,
            selectionDirection ?? "none",
          );
        } catch {
          // Inputs such as number fields do not expose a selection range.
        }
      }
    }
    clearState(nodeId);
  };

  const armDecay = (nodeId: number, state: EditingState) => {
    if (state.timer !== null) cancel(state.timer);
    const remaining = Math.max(0, decayMs - (now() - state.lastKeyTs));
    state.timer = schedule(() => {
      const current = nodes.get(nodeId);
      if (current !== state) return;
      if (now() - current.lastKeyTs < decayMs) {
        armDecay(nodeId, current);
        return;
      }
      reconcile(nodeId);
    }, remaining);
  };

  const filter = ((event: eventWithTime, ctx: PipelineCtx): eventWithTime | null => {
    if (event.type !== EventType.IncrementalSnapshot) return event;
    const data = event.data;
    if (
      data.source === IncrementalSource.MouseInteraction &&
      MOUSE_INTERACTION_FOCUS_EVENTS.has(data.type)
    ) {
      // Focus is local interaction state: trusted click/Tab already performed this transition in
      // the mirror before the authoritative recording echoes it back. Replaying delayed focus/blur
      // can redirect native keystrokes into an old field or leave the document body focused.
      return null;
    }
    if (data.source === IncrementalSource.Mutation) {
      const activeSubtrees: Set<number>[] = [];
      for (const [nodeId, state] of nodes) {
        if (state.subtreeNodeIds === undefined) continue;
        if (ctx.nowMs - state.lastKeyTs < decayMs) activeSubtrees.push(state.subtreeNodeIds);
        else clearState(nodeId);
      }
      if (activeSubtrees.length === 0) return event;

      const isSuppressed = (id: number) => activeSubtrees.some((ids) => ids.has(id));
      const adds = data.adds.filter((mutation) => {
        const suppressed = isSuppressed(mutation.parentId) || isSuppressed(mutation.node.id);
        if (suppressed) {
          for (const ids of activeSubtrees) {
            if (ids.has(mutation.parentId) || ids.has(mutation.node.id)) {
              collectSerializedNodeIds(mutation.node, ids);
            }
          }
        }
        return !suppressed;
      });
      // Adds can introduce ids referenced by another record in the same rrweb mutation batch.
      const texts = data.texts.filter((mutation) => !isSuppressed(mutation.id));
      const attributes = data.attributes.filter((mutation) => !isSuppressed(mutation.id));
      const removes = data.removes.filter(
        (mutation) => !isSuppressed(mutation.id) && !isSuppressed(mutation.parentId),
      );
      if (
        texts.length === data.texts.length &&
        attributes.length === data.attributes.length &&
        removes.length === data.removes.length &&
        adds.length === data.adds.length
      ) {
        return event;
      }
      if (
        texts.length === 0 &&
        attributes.length === 0 &&
        removes.length === 0 &&
        adds.length === 0
      ) {
        return null;
      }
      return { ...event, data: { ...data, texts, attributes, removes, adds } } as eventWithTime;
    }
    if (data.source !== IncrementalSource.Input || data.isChecked) return event;
    const state = nodes.get(data.id);
    if (state === undefined || !isValueEchoField(state.element)) return event;
    if (ctx.nowMs - state.lastKeyTs < decayMs) {
      state.pendingServerValue = data.text;
      return null;
    }
    clearState(data.id);
    return event;
  }) as EchoFilter;

  filter.setFocused = (focus) => {
    if (focused?.nodeId === focus?.nodeId && focused?.element === focus?.element) return;
    if (focused !== null) reconcile(focused.nodeId);
    focused = focus;
  };

  filter.input = (focus) => {
    filter.setFocused(focus);
    if (focus.nodeId < 0 || !isEchoField(focus.element)) return;
    const field = focus.element;
    const timestamp = now();
    const state = nodes.get(focus.nodeId) ?? {
      element: field,
      lastKeyTs: timestamp,
      timer: null,
    };
    state.element = field;
    state.lastKeyTs = timestamp;
    if (isContenteditableEchoField(field)) {
      state.pendingServerValue = undefined;
      state.subtreeNodeIds ??= new Set<number>();
      state.subtreeNodeIds.add(focus.nodeId);
      for (const id of focused?.subtreeNodeIds ?? []) state.subtreeNodeIds.add(id);
      for (const id of focus.subtreeNodeIds ?? []) state.subtreeNodeIds.add(id);
    } else {
      state.subtreeNodeIds = undefined;
    }
    nodes.set(focus.nodeId, state);
    armDecay(focus.nodeId, state);
  };

  filter.keyDown = (_event, focus) => {
    filter.setFocused(focus);
    // Enter is not an acknowledgement of earlier edits. Keep local text protected
    // until the ordinary reconciliation window; a delayed echo may be a prefix.
  };

  filter.getFocused = () => focused;
  filter.reset = () => {
    for (const nodeId of [...nodes.keys()]) clearState(nodeId);
    focused = null;
  };

  filter.restoreHook = {
    capture() {
      if (focused === null) return null;
      const state = nodes.get(focused.nodeId);
      if (
        state === undefined ||
        !isValueEchoField(focused.element) ||
        !isValueEchoField(state.element)
      ) {
        return null;
      }
      return {
        nodeId: focused.nodeId,
        value: state.element.value,
        lastKeyTs: state.lastKeyTs,
        pendingServerValue: state.pendingServerValue,
        selectionStart: state.element.selectionStart,
        selectionEnd: state.element.selectionEnd,
        selectionDirection: state.element.selectionDirection,
      };
    },
    restore(iframe, snapshot) {
      const root = iframe.contentDocument;
      const active = root === null ? null : deepActiveElement(root);
      if (active === null || !isValueEchoField(active)) return;
      active.value = snapshot.value;
      if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
        try {
          active.setSelectionRange(
            snapshot.selectionStart,
            snapshot.selectionEnd,
            snapshot.selectionDirection ?? "none",
          );
        } catch {
          // Inputs such as number fields do not expose a selection range.
        }
      }
      const state: EditingState = {
        element: active,
        lastKeyTs: snapshot.lastKeyTs,
        pendingServerValue: snapshot.pendingServerValue,
        timer: null,
      };
      nodes.set(snapshot.nodeId, state);
      focused = { element: active, nodeId: snapshot.nodeId };
      armDecay(snapshot.nodeId, state);
    },
  };

  return filter;
}

function collectSerializedNodeIds(
  node: { id: number; childNodes?: unknown[] },
  ids: Set<number>,
): void {
  ids.add(node.id);
  for (const child of node.childNodes ?? []) {
    collectSerializedNodeIds(child as { id: number; childNodes?: unknown[] }, ids);
  }
}
