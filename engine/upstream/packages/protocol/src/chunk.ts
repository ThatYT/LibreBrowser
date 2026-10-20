/**
 * M2 chunk framing for the CDP binding channel (H2, design D1).
 *
 * CDP binding payloads are strings and large payloads degrade the pipe, so the agent chunks
 * at ~256KB:
 *
 *     payload := "M2|" docId "|" msgId "|" idx "|" total "|" slice
 *
 * `docId` is the agent's per-document epoch and `msgId` is its document-local counter. Carrying
 * both in every frame lets the gateway reassemble and deduplicate directly on `(docId, msgId)`;
 * no CDP execution-context inference is needed. Partials older than PARTIAL_TTL_MS (10s) are
 * discarded. The reassembled payload is JSON-parsed into an AgentMsg.
 *
 * NOTE: slices are measured in UTF-16 code units (JS string.length), which is what CDP binding
 * payload size is governed by after serialization; 256K code units keeps every framed payload
 * comfortably under CDP's limits. Slices may contain "|" — parseChunk only splits on the first
 * five separators.
 */
import type { AgentMsg } from "./agent";

export const CHUNK_PREFIX = "M2";
/** Max slice length in UTF-16 code units. */
export const CHUNK_SLICE_CHARS = 256 * 1024;
/** Partials older than this are discarded (D1). */
export const PARTIAL_TTL_MS = 10_000;
const RECENT_COMPLETED_MESSAGES = 1_024;
const MAX_DOC_ID = 0xffff_ffff;

/** Frame one JSON-encoded AgentMsg into 1..n binding payloads. */
export function encodeChunks(
  docId: number,
  msgId: number,
  json: string,
  sliceChars: number = CHUNK_SLICE_CHARS,
): string[] {
  if (!Number.isInteger(docId) || docId < 0 || docId > MAX_DOC_ID)
    throw new RangeError("docId must be a uint32");
  if (!Number.isInteger(msgId) || msgId < 0)
    throw new RangeError("msgId must be a non-negative integer");
  if (!Number.isInteger(sliceChars) || sliceChars <= 0)
    throw new RangeError("sliceChars must be > 0");
  const total = Math.max(1, Math.ceil(json.length / sliceChars));
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    out.push(
      `${CHUNK_PREFIX}|${docId}|${msgId}|${i}|${total}|${json.slice(i * sliceChars, (i + 1) * sliceChars)}`,
    );
  }
  return out;
}

export interface ParsedChunk {
  docId: number;
  msgId: number;
  idx: number;
  total: number;
  slice: string;
}

/** Parse one binding payload. Returns null for anything that is not a well-formed M2 chunk. */
export function parseChunk(payload: string): ParsedChunk | null {
  if (!payload.startsWith(CHUNK_PREFIX + "|")) return null;
  const a = CHUNK_PREFIX.length + 1;
  const b = payload.indexOf("|", a);
  if (b < 0) return null;
  const c = payload.indexOf("|", b + 1);
  if (c < 0) return null;
  const d = payload.indexOf("|", c + 1);
  if (d < 0) return null;
  const e = payload.indexOf("|", d + 1);
  if (e < 0) return null;
  const docId = Number(payload.slice(a, b));
  const msgId = Number(payload.slice(b + 1, c));
  const idx = Number(payload.slice(c + 1, d));
  const total = Number(payload.slice(d + 1, e));
  if (
    !Number.isInteger(docId) ||
    !Number.isInteger(msgId) ||
    !Number.isInteger(idx) ||
    !Number.isInteger(total)
  )
    return null;
  if (docId < 0 || docId > MAX_DOC_ID || msgId < 0 || total < 1 || idx < 0 || idx >= total)
    return null;
  return { docId, msgId, idx, total, slice: payload.slice(e + 1) };
}

interface Partial {
  total: number;
  slices: (string | undefined)[];
  received: number;
  firstSeen: number;
}

/**
 * Reassembles and deduplicates chunked binding payloads into AgentMsgs.
 *
 * Keys are `(docId, msgId)`. Out-of-order and duplicate chunks are handled, including msgId
 * reuse by interleaved document epochs. Partials older than PARTIAL_TTL_MS are swept on every
 * add(); completed-message dedup is bounded to the most recent 1024 pairs.
 *
 * Throws SyntaxError if a fully reassembled payload is not valid JSON — callers (P0-INJECT)
 * should catch and log; a malformed message is an agent bug, not a recoverable condition.
 */
export class ChunkReassembler {
  private readonly partials = new Map<string, Partial>();
  private readonly completed = new Set<string>();
  private readonly completedOrder: string[] = [];

  /** Feed one binding payload. Returns the AgentMsg when a message completes, else null. */
  add(payload: string, now: number = Date.now()): AgentMsg | null {
    this.sweep(now);
    const c = parseChunk(payload);
    if (c === null) return null;
    const key = this.key(c.docId, c.msgId);
    if (this.completed.has(key)) return null;

    if (c.total === 1) {
      const msg = JSON.parse(c.slice) as AgentMsg;
      this.rememberCompleted(key);
      return msg;
    }

    let p = this.partials.get(key);
    if (p === undefined || p.total !== c.total) {
      p = {
        total: c.total,
        slices: new Array<string | undefined>(c.total),
        received: 0,
        firstSeen: now,
      };
      this.partials.set(key, p);
    }
    if (p.slices[c.idx] === undefined) {
      p.slices[c.idx] = c.slice;
      p.received++;
    }
    if (p.received < p.total) return null;
    this.partials.delete(key);
    const msg = JSON.parse(p.slices.join("")) as AgentMsg;
    this.rememberCompleted(key);
    return msg;
  }

  /** Drop partials older than PARTIAL_TTL_MS. Called automatically by add(). */
  sweep(now: number = Date.now()): void {
    for (const [key, p] of this.partials) {
      if (now - p.firstSeen > PARTIAL_TTL_MS) this.partials.delete(key);
    }
  }

  get pendingCount(): number {
    return this.partials.size;
  }

  private key(docId: number, msgId: number): string {
    return `${docId}\0${msgId}`;
  }

  private rememberCompleted(key: string): void {
    this.completed.add(key);
    this.completedOrder.push(key);
    if (this.completedOrder.length <= RECENT_COMPLETED_MESSAGES) return;
    const expired = this.completedOrder.shift();
    if (expired !== undefined) this.completed.delete(expired);
  }
}
