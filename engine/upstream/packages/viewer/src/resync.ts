/**
 * Per-tab divergence recovery policy.
 *
 * Mirror owns the mechanical Replayer swap. This controller owns when a recovery request may
 * leave the viewer: repeated requests are delayed with bounded exponential backoff and the fourth
 * request inside one rolling 30 second window degrades only that tab to pixel mode.
 */
import type { TabId, Up } from "@mirror/protocol";

export const RESYNC_WINDOW_MS = 30_000;
export const MAX_RESYNCS_PER_WINDOW = 3;
export const RESYNC_BACKOFF_BASE_MS = 250;
export const RESYNC_BACKOFF_MAX_MS = 5_000;

export interface ResyncTabState {
  tab: TabId;
  /** Requests actually sent to the gateway during this viewer lifetime. */
  totalResyncs: number;
  /** Requests sent inside the current rolling window. */
  recentResyncs: number;
  pending: boolean;
  backoffMs: number;
  storm: boolean;
}

export interface ResyncControllerOptions {
  send(message: Extract<Up, { t: "resync-req" }>): void;
  autoPx(tab: TabId): void;
  onStateChange?(state: ResyncTabState): void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  windowMs?: number;
  maxResyncs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface ResyncController {
  /** Returns false when an equivalent request is already pending or the tab is degraded. */
  request(tab: TabId, reason: string): boolean;
  /** Cancel a not-yet-sent request when another epoch repaired the mirror first. */
  recovered(tab: TabId): void;
  getState(tab: TabId): ResyncTabState;
  states(): ResyncTabState[];
  dispose(): void;
}

interface MutableTabState {
  sentAt: number[];
  totalResyncs: number;
  storm: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  pendingReason: string | null;
  backoffMs: number;
}

export function createResyncController(options: ResyncControllerOptions): ResyncController {
  const now = options.now ?? Date.now;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const windowMs = positiveInteger("windowMs", options.windowMs ?? RESYNC_WINDOW_MS);
  const maxResyncs = positiveInteger("maxResyncs", options.maxResyncs ?? MAX_RESYNCS_PER_WINDOW);
  const backoffBaseMs = positiveInteger(
    "backoffBaseMs",
    options.backoffBaseMs ?? RESYNC_BACKOFF_BASE_MS,
  );
  const backoffMaxMs = positiveInteger(
    "backoffMaxMs",
    options.backoffMaxMs ?? RESYNC_BACKOFF_MAX_MS,
  );
  if (backoffMaxMs < backoffBaseMs) {
    throw new RangeError("backoffMaxMs must be greater than or equal to backoffBaseMs");
  }

  const tabs = new Map<TabId, MutableTabState>();
  let disposed = false;

  const mutable = (tab: TabId): MutableTabState => {
    let state = tabs.get(tab);
    if (state === undefined) {
      state = {
        sentAt: [],
        totalResyncs: 0,
        storm: false,
        timer: null,
        pendingReason: null,
        backoffMs: 0,
      };
      tabs.set(tab, state);
    }
    prune(state, now(), windowMs);
    return state;
  };

  const snapshot = (tab: TabId, state = mutable(tab)): ResyncTabState => ({
    tab,
    totalResyncs: state.totalResyncs,
    recentResyncs: state.sentAt.length,
    pending: state.pendingReason !== null,
    backoffMs: state.backoffMs,
    storm: state.storm,
  });

  const notify = (tab: TabId, state: MutableTabState): void => {
    options.onStateChange?.(snapshot(tab, state));
  };

  const degrade = (tab: TabId, state: MutableTabState): void => {
    if (state.storm) return;
    if (state.timer !== null) cancel(state.timer);
    state.timer = null;
    state.pendingReason = null;
    state.backoffMs = 0;
    state.storm = true;
    notify(tab, state);
    options.autoPx(tab);
  };

  const dispatch = (tab: TabId, state: MutableTabState): void => {
    state.timer = null;
    const reason = state.pendingReason;
    state.pendingReason = null;
    if (disposed || reason === null || state.storm) return;
    prune(state, now(), windowMs);
    if (state.sentAt.length >= maxResyncs) {
      degrade(tab, state);
      return;
    }
    state.sentAt.push(now());
    state.totalResyncs += 1;
    state.backoffMs = 0;
    notify(tab, state);
    options.send({ t: "resync-req", tab, reason });
  };

  return {
    request(tab, reason) {
      if (disposed) return false;
      const state = mutable(tab);
      if (state.storm || state.pendingReason !== null) return false;
      if (state.sentAt.length >= maxResyncs) {
        degrade(tab, state);
        return false;
      }

      const delayMs =
        state.sentAt.length === 0
          ? 0
          : Math.min(backoffMaxMs, backoffBaseMs * 2 ** (state.sentAt.length - 1));
      state.pendingReason = reason;
      state.backoffMs = delayMs;
      notify(tab, state);
      if (delayMs === 0) dispatch(tab, state);
      else {
        state.timer = schedule(() => dispatch(tab, state), delayMs);
        state.timer.unref?.();
      }
      return true;
    },
    recovered(tab) {
      const state = tabs.get(tab);
      if (state === undefined || state.pendingReason === null) return;
      if (state.timer !== null) cancel(state.timer);
      state.timer = null;
      state.pendingReason = null;
      state.backoffMs = 0;
      notify(tab, state);
    },
    getState(tab) {
      return snapshot(tab);
    },
    states() {
      return [...tabs].map(([tab, state]) => snapshot(tab, state));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of tabs.values()) {
        if (state.timer !== null) cancel(state.timer);
      }
      tabs.clear();
    },
  };
}

function prune(state: MutableTabState, at: number, windowMs: number): void {
  const cutoff = at - windowMs;
  while (state.sentAt.length > 0 && state.sentAt[0]! <= cutoff) state.sentAt.shift();
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
