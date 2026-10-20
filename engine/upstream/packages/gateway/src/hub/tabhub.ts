/**
 * Per-tab EventHub. This remains pure logic, with no CDP or WebSocket imports, so synthetic
 * rrweb streams can exercise it in unit tests.
 *
 * Canonical live state = latest [Meta, FullSnapshot] + ordered delta buffer since it.
 * Reset triggers: deltas.length > 5000 || deltaBytes > 10MB || new docId || viewport change
 * -> fire needSnapshot -> on arrival: epoch++, clear buffer, broadcast fresh snapshot.
 * Cheap recovery is the invariant; never diff-repair.
 *
 * Gotchas: Meta (EventType.Meta) precedes FullSnapshot (EventType.FullSnapshot) — keep BOTH or
 * the replayer sizes the iframe wrong. Count deltaBytes on the serialized JSON actually sent.
 */
import {
  encodeMsg,
  EventType,
  type AgentMsg,
  type Down,
  type eventWithTime,
  type SnapshotReason,
  type TabId,
} from "@mirror/protocol";

/**
 * P2-REWRITE hook (assets domain). The assets domain implements this in ../assets/rewrite.ts
 * and integration wires it in main.ts — the hub calls it on every buffered event and NEVER
 * needs editing for it. Identity until then.
 */
export type RewriteStage = (
  e: eventWithTime,
  ctx: { sessionId: string; tabId: TabId },
) => eventWithTime;

export const identityRewrite: RewriteStage = (e) => e;

export interface TabHubOpts {
  sessionId: string;
  tabId: TabId;
  maxDeltaEvents?: number; // default 5000
  maxDeltaBytes?: number; // default 10MB
  snapshotRequestTimeoutMs?: number; // default 5000
  snapshotRetryMs?: number; // default 250; nav/resync retry base
  snapshotRetryMaxMs?: number; // default 5000; bounded exponential backoff
  trimIdleMs?: number; // default 750
  now?: () => number; // default Date.now
  rewrite?: RewriteStage; // default identityRewrite
}

export type NeedSnapshotListener = (reason: SnapshotReason) => unknown;

export class TabHub {
  readonly tabId: TabId;
  /** Gateway-assigned; bumps on: new docId, forced snapshot, viewport change (D4/D7). */
  epoch = 0;
  /** Current agent docId (per-document epoch from the page). */
  docId = 0;
  seq = 0;
  meta: eventWithTime | null = null;
  snapshot: eventWithTime | null = null;
  deltas: eventWithTime[] = [];
  deltaBytes = 0;
  lastInputAt = Number.NEGATIVE_INFINITY;
  mode: "dom" | "px" = "dom";
  viewport: { w: number; h: number; dpr: number } | null = null;

  private readonly sessionId: string;
  private readonly maxDeltaEvents: number;
  private readonly maxDeltaBytes: number;
  private readonly snapshotRequestTimeoutMs: number;
  private readonly snapshotRetryMs: number;
  private readonly snapshotRetryMaxMs: number;
  private readonly trimIdleMs: number;
  private readonly now: () => number;
  private readonly rewrite: RewriteStage;
  private readonly needSnapshotListeners = new Set<NeedSnapshotListener>();
  private hasDocument = false;
  private snapshotRequested = false;
  private snapshotRequestAttempt = 0;
  private snapshotRequestTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotRetryDelayMs: number;
  private trimTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSnapshotReason: SnapshotReason | null = null;
  private queuedSnapshotReason: SnapshotReason | null = null;
  private snapshotSeq = 0;
  private nextMeta: eventWithTime | null = null;
  private pendingFullSnapshot: eventWithTime | null = null;

  constructor(opts: TabHubOpts) {
    assertLimit("maxDeltaEvents", opts.maxDeltaEvents);
    assertLimit("maxDeltaBytes", opts.maxDeltaBytes);
    assertPositiveLimit("snapshotRequestTimeoutMs", opts.snapshotRequestTimeoutMs);
    assertPositiveLimit("snapshotRetryMs", opts.snapshotRetryMs);
    assertPositiveLimit("snapshotRetryMaxMs", opts.snapshotRetryMaxMs);
    assertLimit("trimIdleMs", opts.trimIdleMs);

    this.sessionId = opts.sessionId;
    this.tabId = opts.tabId;
    this.maxDeltaEvents = opts.maxDeltaEvents ?? 5_000;
    this.maxDeltaBytes = opts.maxDeltaBytes ?? 10 * 1024 * 1024;
    this.snapshotRequestTimeoutMs = opts.snapshotRequestTimeoutMs ?? 5_000;
    this.snapshotRetryMs = opts.snapshotRetryMs ?? 250;
    this.snapshotRetryMaxMs = opts.snapshotRetryMaxMs ?? 5_000;
    if (this.snapshotRetryMaxMs < this.snapshotRetryMs) {
      throw new RangeError("snapshotRetryMaxMs must be greater than or equal to snapshotRetryMs");
    }
    this.snapshotRetryDelayMs = this.snapshotRetryMs;
    this.trimIdleMs = opts.trimIdleMs ?? 750;
    this.now = opts.now ?? Date.now;
    this.rewrite = opts.rewrite ?? identityRewrite;
  }

  /**
   * Ingest one AgentMsg; returns the Down messages to broadcast (0..n).
   * Stale-docId events never reach here (AgentLink drops them), but a `hello` with a new docId
   * closes the old epoch.
   */
  ingest(msg: AgentMsg): Down[] {
    if (msg.kind === "cmdres") return [];

    if (msg.kind === "hello") {
      // Only a top-level recorder owns a tab's canonical stream (D2).
      if (!msg.isTop) return [];
      if (this.hasDocument && msg.docId === this.docId) return [];

      this.hasDocument = true;
      this.docId = msg.docId;
      this.meta = null;
      this.snapshot = null;
      this.deltas = [];
      this.deltaBytes = 0;
      this.snapshotSeq = 0;
      this.nextMeta = null;
      this.pendingFullSnapshot = null;
      this.pendingSnapshotReason = null;
      this.queuedSnapshotReason = null;
      this.clearTrimTimer();
      this.clearSnapshotRetry(true);
      this.clearSnapshotRequest();
      this.requestSnapshot("nav");
      return [];
    }

    // AgentLink normally enforces this boundary. Keeping it here too makes the pure hub safe
    // under navigation races and synthetic stream tests.
    if (!this.hasDocument || msg.docId !== this.docId) return [];

    const event = this.rewrite(msg.e, { sessionId: this.sessionId, tabId: this.tabId });

    if (event.type === EventType.Meta) {
      this.nextMeta = event;
      if (this.snapshot === null) this.meta = event;
      return this.openPendingSnapshot();
    }

    if (event.type === EventType.FullSnapshot) {
      this.pendingFullSnapshot = event;
      return this.openPendingSnapshot();
    }

    // No delta can be replayed safely until its document has a complete snapshot pair.
    if (this.meta === null || this.snapshot === null) return [];

    const seq = ++this.seq;
    const down: Down = {
      t: "delta",
      tab: this.tabId,
      epoch: this.epoch,
      seq,
      data: [event],
    };
    this.deltas.push(event);
    this.deltaBytes += utf8JsonBytes(down);

    if (this.deltas.length > this.maxDeltaEvents || this.deltaBytes > this.maxDeltaBytes) {
      this.maybeRequestTrimSnapshot();
    }

    return [down];
  }

  /**
   * Viewer join / resync — same code path (D4): [resync, snapshot(Meta+FullSnapshot@epoch),
   * one delta with the whole buffer]; caller then feeds the live tail.
   */
  joinPayload(): Down[] {
    const payload: Down[] = [{ t: "resync", tab: this.tabId }];
    if (this.meta === null || this.snapshot === null) return payload;

    payload.push({
      t: "snapshot",
      tab: this.tabId,
      epoch: this.epoch,
      seq: this.snapshotSeq,
      data: [this.meta, this.snapshot],
      reason: "resync",
    });
    if (this.deltas.length > 0) {
      payload.push({
        t: "delta",
        tab: this.tabId,
        epoch: this.epoch,
        // A batched delta is a contiguous range; seq identifies its first event.
        seq: this.snapshotSeq + 1,
        data: [...this.deltas],
      });
    }
    return payload;
  }

  /** Fired when thresholds/docId change require a fresh FullSnapshot (caller sends the cmd). */
  onNeedSnapshot(cb: NeedSnapshotListener): void {
    this.needSnapshotListeners.add(cb);
  }

  /** Record accepted driver activity so routine buffer trims wait for an idle moment. */
  noteInput(at = this.now()): void {
    if (!Number.isFinite(at)) throw new RangeError("input timestamp must be finite");
    this.lastInputAt = at;
    if (this.isOverDeltaLimit() && !this.snapshotRequested) this.maybeRequestTrimSnapshot();
  }

  /** Force a fresh snapshot for a semantic cause such as viewport geometry change. */
  requestSnapshot(reason: SnapshotReason): void {
    if (this.snapshotRequested) {
      if (reason !== this.pendingSnapshotReason) {
        this.queuedSnapshotReason = strongerReason(this.queuedSnapshotReason, reason);
      }
      return;
    }
    this.pendingSnapshotReason = strongerReason(this.pendingSnapshotReason, reason);
    this.clearTrimTimer();
    // A fresh semantic request supersedes a pending retry timer. Preserve its backoff until an
    // epoch succeeds or a new document resets the recovery chain.
    this.clearSnapshotRetry(false);
    this.snapshotRequested = true;
    const attempt = ++this.snapshotRequestAttempt;
    this.snapshotRequestTimer = setTimeout(
      () => this.failSnapshotRequest(attempt),
      this.snapshotRequestTimeoutMs,
    );
    this.snapshotRequestTimer.unref?.();

    const requestedReason = this.pendingSnapshotReason ?? reason;
    for (const listener of this.needSnapshotListeners) {
      try {
        Promise.resolve(listener(requestedReason)).catch(() => this.failSnapshotRequest(attempt));
      } catch {
        this.failSnapshotRequest(attempt);
      }
    }
  }

  private openPendingSnapshot(): Down[] {
    if (this.pendingFullSnapshot === null) return [];
    const meta = this.nextMeta ?? this.meta;
    if (meta === null) return [];

    this.meta = meta;
    this.snapshot = this.pendingFullSnapshot;
    this.nextMeta = null;
    this.pendingFullSnapshot = null;
    this.deltas = [];
    this.deltaBytes = 0;
    this.clearTrimTimer();
    this.clearSnapshotRequest();
    this.clearSnapshotRetry(true);
    this.epoch += 1;
    this.snapshotSeq = ++this.seq;
    const reason = this.pendingSnapshotReason ?? "resync";
    const queuedReason = this.queuedSnapshotReason;
    this.pendingSnapshotReason = null;
    this.queuedSnapshotReason = null;

    if (queuedReason !== null) this.requestSnapshot(queuedReason);

    return [
      {
        t: "snapshot",
        tab: this.tabId,
        epoch: this.epoch,
        seq: this.snapshotSeq,
        data: [this.meta, this.snapshot],
        reason,
      },
    ];
  }

  private maybeRequestTrimSnapshot(): void {
    if (!this.isOverDeltaLimit() || this.snapshotRequested) return;
    const waitMs = this.lastInputAt + this.trimIdleMs - this.now();
    if (waitMs <= 0) {
      this.requestSnapshot("trim");
      return;
    }

    this.clearTrimTimer();
    this.trimTimer = setTimeout(() => {
      this.trimTimer = undefined;
      this.maybeRequestTrimSnapshot();
    }, waitMs);
    this.trimTimer.unref?.();
  }

  private isOverDeltaLimit(): boolean {
    return this.deltas.length > this.maxDeltaEvents || this.deltaBytes > this.maxDeltaBytes;
  }

  private clearTrimTimer(): void {
    if (this.trimTimer !== undefined) clearTimeout(this.trimTimer);
    this.trimTimer = undefined;
  }

  private failSnapshotRequest(attempt: number): void {
    if (!this.snapshotRequested || attempt !== this.snapshotRequestAttempt) return;
    const reason = this.pendingSnapshotReason;
    this.clearSnapshotRequest();
    if (reason === "nav" || reason === "resync") this.scheduleSnapshotRetry(reason);
  }

  private clearSnapshotRequest(): void {
    this.snapshotRequested = false;
    this.snapshotRequestAttempt += 1;
    if (this.snapshotRequestTimer !== undefined) clearTimeout(this.snapshotRequestTimer);
    this.snapshotRequestTimer = undefined;
  }

  private scheduleSnapshotRetry(reason: "nav" | "resync"): void {
    this.clearSnapshotRetry(false);
    const docId = this.docId;
    const epoch = this.epoch;
    const delayMs = this.snapshotRetryDelayMs;
    this.snapshotRetryDelayMs =
      delayMs >= Math.ceil(this.snapshotRetryMaxMs / 2) ? this.snapshotRetryMaxMs : delayMs * 2;

    this.snapshotRetryTimer = setTimeout(() => {
      this.snapshotRetryTimer = undefined;
      if (!this.hasDocument || this.docId !== docId || this.epoch !== epoch) return;
      if (this.snapshotRequested) return;
      this.requestSnapshot(reason);
    }, delayMs);
    this.snapshotRetryTimer.unref?.();
  }

  private clearSnapshotRetry(resetBackoff: boolean): void {
    if (this.snapshotRetryTimer !== undefined) clearTimeout(this.snapshotRetryTimer);
    this.snapshotRetryTimer = undefined;
    if (resetBackoff) this.snapshotRetryDelayMs = this.snapshotRetryMs;
  }
}

const SNAPSHOT_REASON_PRIORITY: Record<SnapshotReason, number> = {
  trim: 0,
  resync: 1,
  viewport: 2,
  nav: 3,
};

function strongerReason(current: SnapshotReason | null, candidate: SnapshotReason): SnapshotReason {
  if (current === null || SNAPSHOT_REASON_PRIORITY[candidate] > SNAPSHOT_REASON_PRIORITY[current]) {
    return candidate;
  }
  return current;
}

function assertLimit(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveLimit(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function utf8JsonBytes(value: Down): number {
  return new TextEncoder().encode(encodeMsg(value)).byteLength;
}
