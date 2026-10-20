/**
 * Per-viewer connection and backpressure handling.
 *
 * Backpressure rule (unit-test with a mock socket): if ws.bufferedAmount > STALL_BYTES, mark
 * the viewer stalled (stop deltas/px); when it drains below RESUME_BYTES, send `resync` +
 * current snapshot. Check bufferedAmount BEFORE send, not after. Slow viewers cost O(1) memory
 * and never affect other viewers. The rule applies to px frames too (P2-PX): drop, never queue.
 */
import { encodeMsg, type Down, type TabId } from "@mirror/protocol";

export const STALL_BYTES = 8 * 1024 * 1024;
export const RESUME_BYTES = 1 * 1024 * 1024;
const WS_OPEN = 1;

export interface ViewerSocket {
  readonly readyState: number;
  bufferedAmount: number;
  send(data: string): void;
}

export interface ViewerConnOpts {
  drainPollMs?: number;
}

interface ReplayCursor {
  epoch: number;
  nextSeq: number;
}

export class ViewerConn {
  private readonly cursors = new Map<TabId, ReplayCursor>();
  private readonly drainPollMs: number;
  private drainTimer: NodeJS.Timeout | null = null;
  private stalled = false;
  private disposed = false;
  private beforeResync: (() => void) | undefined;

  constructor(
    readonly socket: ViewerSocket,
    private readonly getJoinPayload: () => Down[],
    opts: ViewerConnOpts = {},
  ) {
    this.drainPollMs = opts.drainPollMs ?? 30;
    if (!Number.isSafeInteger(this.drainPollMs) || this.drainPollMs < 1) {
      throw new RangeError("drainPollMs must be a positive safe integer");
    }
  }

  get isStalled(): boolean {
    return this.stalled;
  }

  /** Fanout installs this to end any in-flight batch before a drain recovery snapshots state. */
  setBeforeResync(cb: (() => void) | undefined): void {
    this.beforeResync = cb;
  }

  /** Send a message already serialized once by the fan-out broadcaster. */
  send(msg: Down, serialized: string): boolean {
    if (!this.isOpen()) return false;
    if (msg.t === "delta" && this.wasAlreadyReplayed(msg)) return false;

    if (isDroppable(msg) && this.socket.bufferedAmount > STALL_BYTES) {
      this.markStalled();
      return false;
    }
    if (this.stalled && isDroppable(msg)) return false;

    this.socket.send(serialized);
    this.advanceCursor(msg);
    return true;
  }

  /** Initial join and drain recovery share the hub's canonical resync path. */
  sendJoinPayload(): void {
    if (!this.isOpen()) return;
    for (const msg of this.getJoinPayload()) {
      this.socket.send(encodeMsg(msg));
      this.advanceCursor(msg);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  private markStalled(): void {
    if (this.stalled) return;
    this.stalled = true;
    this.scheduleDrainCheck();
  }

  private scheduleDrainCheck(): void {
    if (this.disposed || this.drainTimer !== null) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (!this.isOpen()) return;
      if (this.socket.bufferedAmount >= RESUME_BYTES) {
        this.scheduleDrainCheck();
        return;
      }

      // Keep `stalled` true during the flush: this connection drops the pending tail while its
      // healthy peers receive it, then gets that same tail exactly once from joinPayload().
      this.beforeResync?.();
      this.stalled = false;
      this.sendJoinPayload();
    }, this.drainPollMs);
    this.drainTimer.unref();
  }

  private wasAlreadyReplayed(msg: Extract<Down, { t: "delta" }>): boolean {
    const cursor = this.cursors.get(msg.tab);
    return (
      cursor !== undefined &&
      cursor.epoch === msg.epoch &&
      msg.seq + msg.data.length <= cursor.nextSeq
    );
  }

  private advanceCursor(msg: Down): void {
    if (msg.t === "snapshot") {
      this.cursors.set(msg.tab, { epoch: msg.epoch, nextSeq: msg.seq + 1 });
    } else if (msg.t === "delta") {
      this.cursors.set(msg.tab, {
        epoch: msg.epoch,
        nextSeq: msg.seq + msg.data.length,
      });
    } else if (msg.t === "resync") {
      this.cursors.delete(msg.tab);
    }
  }

  private isOpen(): boolean {
    return !this.disposed && this.socket.readyState === WS_OPEN;
  }
}

function isDroppable(msg: Down): boolean {
  return msg.t === "delta" || msg.t === "px";
}
