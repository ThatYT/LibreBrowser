/**
 * Scroll echo suppression.
 *
 * Per-node `userScrolling` flag (500ms decay after last local scroll); drop incoming rrweb
 * scroll events for that node while set. Server-originated scrolls (anchor jumps, SPA route
 * changes) still apply. Window scroll is nodeId 0 — special-case; iframes have their own
 * scrollers; throttle upstream `scroll` msgs per node (<=10Hz), not globally. Same mechanism
 * family as echo — both are pipeline stages.
 */
import {
  EventType,
  IncrementalSource,
  type eventWithTime,
  type TabId,
  type Up,
} from "@mirror/protocol";
import { isElement } from "../input/pointer";
import type { PipelineCtx, Stage } from "./index";

interface UserScrollState {
  lastLocalTs: number;
  lastSentTs: number;
  pending: { x: number; y: number } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ExpectedServerScroll {
  x: number;
  y: number;
  expiresAt: number;
}

interface DocumentScrollReconcile {
  snap(x: number, y: number): void;
  /** Preserve rrweb's smooth phase for this long before enforcing the exact server position. */
  settleMs: number;
}

interface PendingServerSnap {
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
  respectLocalSuppression: boolean;
}

/** Browser/scaling/anchoring differences below this distance are the same semantic position. */
export const SCROLL_MATCH_EPSILON_PX = 3;

export interface ScrollFilter extends Stage {
  localScroll(tab: TabId, nodeId: number, x: number, y: number): void;
  registerDocumentScroll(
    eventNodeId: number,
    nodeId: number,
    reconcile?: DocumentScrollReconcile,
  ): () => void;
  reset(): void;
}

export interface ScrollFilterOptions {
  send(message: Extract<Up, { t: "scroll" }>): void;
  now?: () => number;
  throttleMs?: number;
  suppressMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export function createScrollFilter(options: ScrollFilterOptions): ScrollFilter {
  const now = options.now ?? Date.now;
  const throttleMs = options.throttleMs ?? 100;
  const suppressMs = options.suppressMs ?? 500;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const userScrolling = new Map<number, UserScrollState>();
  const expectedServer = new Map<number, ExpectedServerScroll>();
  // rrweb identifies viewport scroll events by the serialized Document id. The wire protocol
  // deliberately uses nodeId 0 for the top window and the child documentElement id for iframe
  // windows, so native and replay events need an explicit key translation before reconciliation.
  const documentScrollNodes = new Map<number, { nodeId: number; token: object }>();
  const documentReconciles = new Map<
    number,
    { reconcile: DocumentScrollReconcile; token: object }
  >();
  const pendingServerSnaps = new Map<number, PendingServerSnap>();

  const expectServerScroll = (nodeId: number, x: number, y: number, timestamp: number) => {
    expectedServer.set(nodeId, { x, y, expiresAt: timestamp + 2_000 });
  };

  const snapAuthoritative = (nodeId: number, x: number, y: number, timestamp: number): boolean => {
    const registration = documentReconciles.get(nodeId);
    if (registration === undefined) return false;
    expectServerScroll(nodeId, x, y, timestamp);
    registration.reconcile.snap(x, y);
    return true;
  };

  const scheduleReconcile = (
    nodeId: number,
    x: number,
    y: number,
    delayMs: number,
    respectLocalSuppression: boolean,
  ) => {
    const previous = pendingServerSnaps.get(nodeId);
    if (previous !== undefined) cancel(previous.timer);
    const timer = schedule(
      () => {
        const pending = pendingServerSnaps.get(nodeId);
        if (pending?.timer !== timer) return;
        const local = userScrolling.get(nodeId);
        const remaining = local === undefined ? 0 : suppressMs - (now() - local.lastLocalTs);
        if (pending.respectLocalSuppression && remaining > 0) {
          scheduleReconcile(nodeId, pending.x, pending.y, remaining, true);
          return;
        }
        pendingServerSnaps.delete(nodeId);
        snapAuthoritative(nodeId, pending.x, pending.y, now());
      },
      Math.max(0, delayMs),
    );
    pendingServerSnaps.set(nodeId, { x, y, timer, respectLocalSuppression });
  };

  const filter = ((event: eventWithTime, ctx: PipelineCtx): eventWithTime | null => {
    if (event.type !== EventType.IncrementalSnapshot) return event;
    const data = event.data;
    if (data.source !== IncrementalSource.Scroll) return event;
    const nodeId = documentScrollNodes.get(data.id)?.nodeId ?? data.id;
    const local = userScrolling.get(nodeId);
    const reconcile = documentReconciles.get(nodeId)?.reconcile;
    if (local !== undefined && ctx.nowMs - local.lastLocalTs < suppressMs) {
      if (reconcile !== undefined) {
        scheduleReconcile(
          nodeId,
          data.x,
          data.y,
          suppressMs - (ctx.nowMs - local.lastLocalTs),
          true,
        );
      }
      return null;
    }
    if (reconcile !== undefined) {
      if (reconcile.settleMs === 0) {
        snapAuthoritative(nodeId, data.x, data.y, ctx.nowMs);
        return null;
      }
      expectServerScroll(nodeId, data.x, data.y, ctx.nowMs);
      scheduleReconcile(nodeId, data.x, data.y, reconcile.settleMs, false);
      return event;
    }
    expectServerScroll(nodeId, data.x, data.y, ctx.nowMs);
    return event;
  }) as ScrollFilter;

  const send = (tab: TabId, nodeId: number, state: UserScrollState, x: number, y: number) => {
    state.lastSentTs = now();
    state.pending = null;
    state.timer = null;
    options.send({ t: "scroll", tab, nodeId, x, y });
  };

  filter.localScroll = (tab, nodeId, x, y) => {
    const expected = expectedServer.get(nodeId);
    if (expected !== undefined) {
      if (expected.expiresAt >= now()) {
        if (
          Math.abs(expected.x - x) <= SCROLL_MATCH_EPSILON_PX &&
          Math.abs(expected.y - y) <= SCROLL_MATCH_EPSILON_PX
        ) {
          expectedServer.delete(nodeId);
        }
        // Smooth replay produces intermediate native scroll events before reaching the server
        // target. None of those steps are fresh user input and must be echoed upstream.
        return;
      }
      expectedServer.delete(nodeId);
    }

    const timestamp = now();
    const state = userScrolling.get(nodeId) ?? {
      lastLocalTs: timestamp,
      lastSentTs: Number.NEGATIVE_INFINITY,
      pending: null,
      timer: null,
    };
    state.lastLocalTs = timestamp;
    userScrolling.set(nodeId, state);

    const elapsed = timestamp - state.lastSentTs;
    if (elapsed >= throttleMs) {
      if (state.timer !== null) cancel(state.timer);
      send(tab, nodeId, state, x, y);
      return;
    }

    state.pending = { x, y };
    if (state.timer === null) {
      state.timer = schedule(
        () => {
          const current = userScrolling.get(nodeId);
          if (current === undefined || current.pending === null) return;
          send(tab, nodeId, current, current.pending.x, current.pending.y);
        },
        Math.max(0, throttleMs - elapsed),
      );
    }
  };

  filter.registerDocumentScroll = (eventNodeId, nodeId, reconcile) => {
    const token = {};
    documentScrollNodes.set(eventNodeId, { nodeId, token });
    if (reconcile !== undefined) documentReconciles.set(nodeId, { reconcile, token });
    return () => {
      if (documentScrollNodes.get(eventNodeId)?.token === token) {
        documentScrollNodes.delete(eventNodeId);
      }
      if (reconcile !== undefined && documentReconciles.get(nodeId)?.token === token) {
        documentReconciles.delete(nodeId);
      }
    };
  };

  filter.reset = () => {
    for (const state of userScrolling.values()) {
      if (state.timer !== null) cancel(state.timer);
    }
    for (const pending of pendingServerSnaps.values()) cancel(pending.timer);
    userScrolling.clear();
    expectedServer.clear();
    documentScrollNodes.clear();
    documentReconciles.clear();
    pendingServerSnaps.clear();
  };
  return filter;
}

export interface ScrollSyncOptions {
  doc: Document;
  rootDoc?: Document;
  tab: TabId;
  getNodeId(node: Node): number;
  filter: ScrollFilter;
}

/** Capture native mirror scrolling; wheel events themselves take the mutually exclusive D5 path. */
export function attachScrollSync(options: ScrollSyncOptions): () => void {
  const rootDoc = options.rootDoc ?? options.doc;
  const eventNodeId = options.getNodeId(options.doc);
  const nodeId = options.doc === rootDoc ? 0 : options.getNodeId(options.doc.documentElement);
  const view = options.doc.defaultView;
  const unregisterDocument =
    eventNodeId < 0 || nodeId < 0
      ? () => {}
      : options.filter.registerDocumentScroll(
          eventNodeId,
          nodeId,
          view !== null
            ? {
                snap: (x, y) => view.scrollTo({ left: x, top: y, behavior: "auto" }),
                settleMs: options.doc === rootDoc ? 0 : 500,
              }
            : undefined,
        );
  const onScroll = (event: Event) => {
    const target = resolveScrollTarget(event.target, options.doc, options.getNodeId, rootDoc);
    if (target !== null) options.filter.localScroll(options.tab, target.nodeId, target.x, target.y);
  };
  options.doc.addEventListener("scroll", onScroll, true);
  return () => {
    unregisterDocument();
    options.doc.removeEventListener("scroll", onScroll, true);
  };
}

export function resolveScrollTarget(
  target: EventTarget | null,
  doc: Document,
  getNodeId: (node: Node) => number,
  rootDoc: Document = doc,
): { nodeId: number; x: number; y: number } | null {
  if (
    target === doc ||
    target === doc.defaultView ||
    target === doc.documentElement ||
    target === doc.body ||
    target === doc.scrollingElement
  ) {
    const view = doc.defaultView;
    const root = doc.scrollingElement;
    const nodeId = doc === rootDoc ? 0 : getNodeId(doc.documentElement);
    if (nodeId < 0) return null;
    return {
      nodeId,
      x: view?.scrollX ?? root?.scrollLeft ?? 0,
      y: view?.scrollY ?? root?.scrollTop ?? 0,
    };
  }
  if (!isElement(target)) return null;
  let element: Element | null = target;
  while (element !== null) {
    const nodeId = getNodeId(element);
    if (nodeId >= 0) return { nodeId, x: target.scrollLeft, y: target.scrollTop };
    element = element.parentElement;
  }
  return null;
}
