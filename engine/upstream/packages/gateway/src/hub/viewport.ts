/**
 * Gateway viewport agreement.
 *
 * Driver `view` messages lock input immediately, debounce for 300ms, apply Chromium device
 * metrics, and force a viewport snapshot. Only an acknowledgement of the final viewport epoch
 * unlocks that viewer. Nav/trim/resync epochs never perturb the geometry gate (H3).
 */
import type { Down, SnapshotReason, TabId, Up } from "@mirror/protocol";
import type { CdpSend } from "../types";

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_SNAPSHOT_RETRY_MS = 5_500;
const MAX_VIEWPORT_DIMENSION = 10_000;
const MAX_DPR = 10;

type SnapshotDown = Extract<Down, { t: "snapshot" }>;
export type ViewportMsg = Extract<Up, { t: "view" } | { t: "view-ack" }>;

export interface ViewportHub {
  viewport: { w: number; h: number; dpr: number } | null;
  requestSnapshot(reason: SnapshotReason): void;
}

export interface ViewportAgreementDeps {
  send: CdpSend;
  sessionFor(tabId: TabId): string | undefined;
  hubFor(tabId: TabId): ViewportHub | undefined;
  isDriver(viewerId: string): boolean;
  debounceMs?: number;
  /** Slightly longer than TabHub's default request timeout, then recurring until recovery. */
  snapshotRetryMs?: number;
  now?: () => number;
  gate?: ViewportInputGate;
}

export interface ViewportAgreement {
  readonly gate: ViewportInputGate;
  /** True when a valid message was accepted into the negotiation/gate. */
  handle(viewerId: string, msg: ViewportMsg): boolean;
  /** Call before broadcasting each hub snapshot so a same-turn ack sees the new gate state. */
  noteSnapshot(snapshot: Pick<SnapshotDown, "tab" | "epoch" | "reason">): void;
  viewportFor(tabId: TabId): { w: number; h: number; dpr: number } | undefined;
  removeViewer(viewerId: string): void;
  dispose(): void;
}

/**
 * Input is gated only by geometry-changing viewport snapshots. General hub epochs also advance
 * for navigation and buffer trims; comparing an ack to the hub's current epoch would therefore
 * drop valid input after every routine trim.
 */
export class ViewportInputGate {
  private readonly requiredEpochs = new Map<TabId, number>();
  private readonly pendingTabs = new Set<TabId>();
  private readonly acknowledgedEpochs = new Map<string, Map<TabId, number>>();

  /** Lock at receipt of `view`, covering the debounce/CDP/snapshot transition window. */
  beginViewportChange(tabId: TabId): void {
    this.pendingTabs.add(tabId);
  }

  noteSnapshot(snapshot: Pick<SnapshotDown, "tab" | "epoch" | "reason">): void {
    if (!isViewportReason(snapshot.reason)) return;
    this.requiredEpochs.set(snapshot.tab, snapshot.epoch);
    this.pendingTabs.delete(snapshot.tab);
  }

  acknowledge(viewerId: string, tabId: TabId, epoch: number): boolean {
    if (this.pendingTabs.has(tabId) || this.requiredEpochs.get(tabId) !== epoch) return false;
    let viewerEpochs = this.acknowledgedEpochs.get(viewerId);
    if (viewerEpochs === undefined) {
      viewerEpochs = new Map();
      this.acknowledgedEpochs.set(viewerId, viewerEpochs);
    }
    viewerEpochs.set(tabId, epoch);
    return true;
  }

  allowsInput(viewerId: string, tabId: TabId): boolean {
    if (this.pendingTabs.has(tabId)) return false;
    const requiredEpoch = this.requiredEpochs.get(tabId);
    // Unknown tabs have never completed D7 negotiation, so there is no geometry agreement to
    // trust yet. The first viewport snapshot + matching ack is the only initial unlock path.
    return (
      requiredEpoch !== undefined &&
      this.acknowledgedEpochs.get(viewerId)?.get(tabId) === requiredEpoch
    );
  }

  removeViewer(viewerId: string): void {
    this.acknowledgedEpochs.delete(viewerId);
  }
}

interface RequestedViewport {
  revision: number;
  requestedAt: number;
  w: number;
  h: number;
  dpr: number;
}

interface TabNegotiation {
  desired: RequestedViewport;
  appliedRevision: number;
  applying: boolean;
  inFlight: boolean;
  debounceTimer?: ReturnType<typeof setTimeout>;
  snapshotRetryTimer?: ReturnType<typeof setTimeout>;
}

export function createViewportAgreement(deps: ViewportAgreementDeps): ViewportAgreement {
  const debounceMs = checkedDelay("debounceMs", deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const snapshotRetryMs = checkedDelay(
    "snapshotRetryMs",
    deps.snapshotRetryMs ?? DEFAULT_SNAPSHOT_RETRY_MS,
  );
  const now = deps.now ?? Date.now;
  const gate = deps.gate ?? new ViewportInputGate();
  const tabs = new Map<TabId, TabNegotiation>();
  let nextRevision = 0;
  let disposed = false;

  return {
    gate,
    handle(viewerId, msg) {
      if (disposed) return false;
      if (msg.t === "view-ack") return gate.acknowledge(viewerId, msg.tab, msg.epoch);
      if (!deps.isDriver(viewerId) || !isValidViewport(msg)) return false;

      const desired: RequestedViewport = {
        revision: ++nextRevision,
        requestedAt: now(),
        w: msg.w,
        h: msg.h,
        dpr: msg.dpr,
      };
      const state = tabs.get(msg.tab) ?? {
        desired,
        appliedRevision: 0,
        applying: false,
        inFlight: false,
      };
      state.desired = desired;
      tabs.set(msg.tab, state);
      gate.beginViewportChange(msg.tab);
      scheduleApply(msg.tab, state);
      return true;
    },
    noteSnapshot(snapshot) {
      if (!isViewportReason(snapshot.reason)) return;
      const state = tabs.get(snapshot.tab);
      if (state === undefined) {
        gate.noteSnapshot(snapshot);
        return;
      }

      if (state.inFlight) {
        state.inFlight = false;
        clearSnapshotRetry(state);
      }
      if (state.desired.revision > state.appliedRevision || state.applying) {
        // This snapshot belongs to an older override. Keep the pending lock and negotiate the
        // newest requested dimensions; acknowledging this epoch must not unlock stale geometry.
        scheduleApply(snapshot.tab, state);
        return;
      }
      gate.noteSnapshot(snapshot);
    },
    viewportFor(tabId) {
      const viewport = deps.hubFor(tabId)?.viewport;
      return viewport ?? undefined;
    },
    removeViewer(viewerId) {
      gate.removeViewer(viewerId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of tabs.values()) {
        clearDebounce(state);
        clearSnapshotRetry(state);
      }
      tabs.clear();
    },
  };

  function scheduleApply(tabId: TabId, state: TabNegotiation): void {
    if (disposed || state.inFlight || state.applying) return;
    clearDebounce(state);
    const waitMs = Math.max(0, state.desired.requestedAt + debounceMs - now());
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = undefined;
      void apply(tabId, state);
    }, waitMs);
    state.debounceTimer.unref?.();
  }

  async function apply(tabId: TabId, state: TabNegotiation): Promise<void> {
    if (disposed || state.inFlight || state.applying) return;
    const desired = state.desired;
    const sessionId = deps.sessionFor(tabId);
    const hub = deps.hubFor(tabId);
    if (sessionId === undefined || hub === undefined) return;

    state.applying = true;
    try {
      await deps.send(sessionId, "Emulation.setDeviceMetricsOverride", {
        width: desired.w,
        height: desired.h,
        deviceScaleFactor: desired.dpr,
        mobile: false,
      });
      if (disposed) return;
      hub.viewport = { w: desired.w, h: desired.h, dpr: desired.dpr };
      state.appliedRevision = desired.revision;
      state.inFlight = true;
      scheduleSnapshotRetry(tabId, state);
      hub.requestSnapshot("viewport");
    } catch {
      // Keep input locked and retry the latest request. A detached tab simply has no session on
      // the next attempt; a transient CDP failure cannot accidentally reopen stale input.
      if (state.desired.revision === desired.revision) state.desired.requestedAt = now();
    } finally {
      state.applying = false;
      if (!state.inFlight) scheduleApply(tabId, state);
    }
  }

  function scheduleSnapshotRetry(tabId: TabId, state: TabNegotiation): void {
    clearSnapshotRetry(state);
    state.snapshotRetryTimer = setTimeout(() => {
      state.snapshotRetryTimer = undefined;
      if (disposed || !state.inFlight) return;
      deps.hubFor(tabId)?.requestSnapshot("viewport");
      scheduleSnapshotRetry(tabId, state);
    }, snapshotRetryMs);
    state.snapshotRetryTimer.unref?.();
  }
}

function clearDebounce(state: TabNegotiation): void {
  if (state.debounceTimer !== undefined) clearTimeout(state.debounceTimer);
  state.debounceTimer = undefined;
}

function clearSnapshotRetry(state: TabNegotiation): void {
  if (state.snapshotRetryTimer !== undefined) clearTimeout(state.snapshotRetryTimer);
  state.snapshotRetryTimer = undefined;
}

function checkedDelay(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function isValidViewport(msg: Extract<ViewportMsg, { t: "view" }>): boolean {
  return (
    Number.isSafeInteger(msg.w) &&
    msg.w > 0 &&
    msg.w <= MAX_VIEWPORT_DIMENSION &&
    Number.isSafeInteger(msg.h) &&
    msg.h > 0 &&
    msg.h <= MAX_VIEWPORT_DIMENSION &&
    Number.isFinite(msg.dpr) &&
    msg.dpr > 0 &&
    msg.dpr <= MAX_DPR
  );
}

function isViewportReason(reason: SnapshotReason | undefined): reason is "viewport" {
  return reason === "viewport";
}
