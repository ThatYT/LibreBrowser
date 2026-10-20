/**
 * Viewer <-> gateway wire protocol.
 *
 * Transport: one WebSocket per viewer per session, permessage-deflate on, JSON envelopes.
 * encodeMsg/decodeUp/decodeDown are the ONLY encode/decode choke points — if profiling ever
 * demands CBOR/msgpack, this module is the only place that changes. Don't pre-pay.
 *
 * ## seq semantics (D4, D10)
 * `seq` is per-tab and monotonic across `snapshot` and `delta` messages. The gateway assigns it;
 * the viewer treats any gap as divergence and MUST send `resync-req`, then discard all state for
 * that tab and rebuild from the next snapshot (tear down the Replayer + iframe entirely — never
 * reuse a Replayer instance across resyncs).
 *
 * ## epoch semantics (D4, D7)
 * `epoch` is gateway-assigned per tab. It bumps on: agent docId change (navigation), forced
 * snapshot (delta-buffer thresholds: >5000 events or >10MB), and viewport change. Every epoch
 * opens with a fresh `snapshot` message. Input gating (D7): the gateway DROPS input from any
 * viewer whose last `view-ack` epoch != the tab's current epoch — this single rule prevents
 * every "clicked on stale layout" bug.
 *
 * ## key-event rule (D3)
 * Everything keyboard goes as raw `key` down/up pairs, translated server-side through a vendored
 * US layout table into Input.dispatchKeyEvent. `text` (-> Input.insertText) is reserved for
 * exactly two producers: IME commit and paste. Local echo is a viewer-side prediction layer, not
 * a different server path.
 *
 * ## backpressure (D4)
 * If a viewer's ws.bufferedAmount > 8MB the gateway marks it stalled: stop deltas/px; when
 * drained below 1MB, send `resync` + current snapshot. Slow viewers cost O(1) memory.
 */
import type { eventWithTime } from "./rrweb";

/** A tab is identified by its CDP targetId. */
export type TabId = string;

/**
 * Modifier bitfield — CDP's encoding, used verbatim on the wire:
 * Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
 */
export const Mod = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const;
export type Mods = number;

export interface TabMeta {
  id: TabId;
  url: string;
  title: string;
  favicon?: string;
  active: boolean;
}

export interface PresenceEntry {
  id: string;
  name: string;
}

export type SnapshotReason = "nav" | "viewport" | "trim" | "resync";

/** Gateway -> viewer. */
export type Down =
  | {
      t: "hello";
      viewerId: string;
      role: "driver" | "viewer";
      sessionId: string;
      /** Gateway wall-clock reference for viewer clock-skew estimation. */
      serverTs?: number;
    }
  /** Application-level RTT echo; browser JS cannot observe WebSocket control-frame pong timing. */
  | { t: "pong"; id: number; sentTs: number; serverTs: number }
  | { t: "tabs"; tabs: TabMeta[] }
  | { t: "chrome"; tab: TabId; url: string; loading: boolean; canBack: boolean; canFwd: boolean }
  /** data = [Meta, FullSnapshot]; seq = the snapshot's seq; opens `epoch`. */
  | {
      t: "snapshot";
      tab: TabId;
      epoch: number;
      seq: number;
      data: eventWithTime[];
      /** Why this epoch was opened; optional during the additive H2 rollout. */
      reason?: SnapshotReason;
    }
  /** Batched <=30ms on the gateway. */
  | { t: "delta"; tab: TabId; epoch: number; seq: number; data: eventWithTime[] }
  /** Gateway-initiated: discard all state for the tab; a fresh snapshot follows. */
  | { t: "resync"; tab: TabId }
  | { t: "mode"; tab: TabId; mode: "dom" | "px" }
  /** Pixel-fallback frame (base64 JPEG), viewport-sized. */
  | { t: "px"; tab: TabId; data: string; w: number; h: number }
  /**
   * One agent -> viewer WebRTC signaling lane. `lane` identifies a single Replayer generation;
   * the gateway delivers it only to the authenticated viewer that opened that lane.
   */
  | { t: "rtc-sig"; tab: TabId; lane: string; from: "agent"; payload: unknown }
  | {
      t: "download";
      id: string;
      name: string;
      recv: number;
      total: number;
      state: "active" | "done" | "canceled";
      href?: string;
    }
  /** Authorizes one bounded HTTP upload batch for the intercepted remote file input. */
  | {
      t: "filepick";
      tab: TabId;
      key: string;
      multiple: boolean;
      maxFiles: number;
      maxFileBytes: number;
      maxTotalBytes: number;
    }
  /** Announces the current driver's viewerId. */
  | { t: "driver"; viewerId: string }
  | { t: "clip"; text: string }
  | { t: "presence"; viewers: PresenceEntry[] };

/** Viewer -> gateway. */
export type Up =
  /** Application-level RTT probe echoed immediately by the gateway. */
  | { t: "ping"; id: number; sentTs: number }
  /** Driver viewport in CSS px + DPR -> Emulation.setDeviceMetricsOverride (D7). */
  | { t: "view"; tab: TabId; w: number; h: number; dpr: number }
  /** Ack of the snapshot epoch produced by a viewport change; unlocks input per D7. */
  | { t: "view-ack"; tab: TabId; epoch: number }
  | {
      t: "ptr";
      tab: TabId;
      kind: "move" | "down" | "up" | "wheel";
      nodeId: number;
      /** Position within the node, [0,1]. */
      rx: number;
      ry: number;
      /** Viewport px fallback (and the primary coords in px mode). */
      vx: number;
      vy: number;
      button?: 0 | 1 | 2;
      buttons: number;
      mods: Mods;
      /** Wheel deltas. */
      dx?: number;
      dy?: number;
      clicks?: 1 | 2;
    }
  | { t: "key"; tab: TabId; kind: "down" | "up"; key: string; code: string; mods: Mods }
  /** IME commit + paste ONLY (D3/D5) -> Input.insertText. */
  | { t: "text"; tab: TabId; insert: string }
  /** Committed value-control state -> agent native setter + input/change events. */
  | {
      t: "value";
      tab: TabId;
      nodeId: number;
      value: string;
      /** False for a native editing event; omitted preserves legacy committed-change behavior. */
      commit?: boolean;
      /** Checkbox/radio committed state; when present, `value` is not applied. */
      checked?: boolean;
      /** Multiple-select committed option values; when present, `value` is not applied. */
      values?: string[];
    }
  /** Composition in flight -> Input.imeSetComposition. */
  | { t: "ime"; tab: TabId; text: string; selStart: number; selEnd: number }
  /** <=10Hz per node; nodeId 0 = window scroll. */
  | { t: "scroll"; tab: TabId; nodeId: number; x: number; y: number }
  | {
      t: "nav";
      tab: TabId;
      action: "go" | "back" | "fwd" | "reload" | "newtab" | "close" | "activate";
      url?: string;
    }
  | { t: "mode"; tab: TabId; mode: "dom" | "px" }
  | { t: "resync-req"; tab: TabId; reason: string }
  | { t: "driver-transfer"; to: string }
  /**
   * Viewer -> agent WebRTC signaling. The gateway attaches the authenticated viewer identity;
   * clients must never put a viewer id on this envelope.
   */
  | { t: "rtc-sig"; tab: TabId; lane: string; payload: unknown }
  | { t: "clip"; text: string };

const DOWN_TAGS: ReadonlySet<string> = new Set([
  "hello",
  "pong",
  "tabs",
  "chrome",
  "snapshot",
  "delta",
  "resync",
  "mode",
  "px",
  "rtc-sig",
  "download",
  "filepick",
  "driver",
  "clip",
  "presence",
]);

const UP_TAGS: ReadonlySet<string> = new Set([
  "ping",
  "view",
  "view-ack",
  "ptr",
  "key",
  "text",
  "value",
  "ime",
  "scroll",
  "nav",
  "mode",
  "resync-req",
  "driver-transfer",
  "rtc-sig",
  "clip",
]);

/** Single serialization choke point (future CBOR switch lives here). */
export function encodeMsg(msg: Down | Up): string {
  return JSON.stringify(msg);
}

function decode(raw: string, tags: ReadonlySet<string>, dir: string): unknown {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`${dir}: not JSON`);
  }
  if (typeof obj !== "object" || obj === null || typeof (obj as { t?: unknown }).t !== "string") {
    throw new Error(`${dir}: missing tag`);
  }
  const t = (obj as { t: string }).t;
  if (!tags.has(t)) throw new Error(`${dir}: unknown tag "${t}"`);
  return obj;
}

/** Viewer side: decode a gateway message. Throws on unknown/garbled input. */
export function decodeDown(raw: string): Down {
  return decode(raw, DOWN_TAGS, "Down") as Down;
}

/** Gateway side: decode a viewer message. Throws on unknown/garbled input. */
export function decodeUp(raw: string): Up {
  return decode(raw, UP_TAGS, "Up") as Up;
}
