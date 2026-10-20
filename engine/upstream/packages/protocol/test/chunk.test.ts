import { describe, expect, it } from "vitest";
import {
  ChunkReassembler,
  encodeChunks,
  parseChunk,
  PARTIAL_TTL_MS,
  type AgentMsg,
} from "../src/index";

const hello: AgentMsg = {
  kind: "hello",
  docId: 123,
  url: "https://a.example/",
  isTop: true,
  ts: 1,
};

describe("encodeChunks / parseChunk", () => {
  it("round-trips a single-chunk M2 message with its document id", () => {
    const json = JSON.stringify(hello);
    const chunks = encodeChunks(123, 7, json);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(`M2|123|7|0|1|${json}`);
    expect(parseChunk(chunks[0]!)).toEqual({
      docId: 123,
      msgId: 7,
      idx: 0,
      total: 1,
      slice: json,
    });
  });

  it("splits large payloads and preserves document, order, and content", () => {
    const json = JSON.stringify({ kind: "rrweb", docId: 91, e: { data: "x".repeat(100) } });
    const chunks = encodeChunks(91, 3, json, 16);
    expect(chunks.length).toBe(Math.ceil(json.length / 16));
    expect(chunks.map((c) => parseChunk(c)!.slice).join("")).toBe(json);
    chunks.forEach((c, i) => {
      const p = parseChunk(c)!;
      expect(p.docId).toBe(91);
      expect(p.msgId).toBe(3);
      expect(p.idx).toBe(i);
      expect(p.total).toBe(chunks.length);
    });
  });

  it("tolerates '|' and newlines inside the slice", () => {
    const json = JSON.stringify({ kind: "cmdres", reqId: 1, ok: true, data: "a|b|c\nd||e" });
    for (const size of [4, 5, 1000]) {
      const chunks = encodeChunks(8, 0, json, size);
      expect(chunks.map((c) => parseChunk(c)!.slice).join("")).toBe(json);
    }
  });

  it("rejects malformed payloads and legacy M1 frames", () => {
    expect(parseChunk("")).toBeNull();
    expect(parseChunk("nonsense")).toBeNull();
    expect(parseChunk("M1|1|0|1|{}")).toBeNull();
    expect(parseChunk("M2|1|0|1|{}")).toBeNull(); // missing fifth separator
    expect(parseChunk("M2|x|1|0|1|{}")).toBeNull();
    expect(parseChunk("M2|1|x|0|1|{}")).toBeNull();
    expect(parseChunk("M2|1|1|2|2|{}")).toBeNull(); // idx >= total
    expect(parseChunk("M2|1|1|0|0|{}")).toBeNull(); // total < 1
    expect(parseChunk("M2|1.5|1|0|1|{}")).toBeNull();
  });

  it("validates encode args", () => {
    expect(() => encodeChunks(-1, 0, "{}")).toThrow(RangeError);
    expect(() => encodeChunks(0x1_0000_0000, 0, "{}")).toThrow(RangeError);
    expect(() => encodeChunks(1, -1, "{}")).toThrow(RangeError);
    expect(() => encodeChunks(1, 1, "{}", 0)).toThrow(RangeError);
  });
});

describe("ChunkReassembler", () => {
  it("reassembles a multi-chunk message delivered in order", () => {
    const r = new ChunkReassembler();
    const json = JSON.stringify(hello);
    const chunks = encodeChunks(123, 1, json, 8);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks.slice(0, -1)) expect(r.add(c)).toBeNull();
    expect(r.add(chunks[chunks.length - 1]!)).toEqual(hello);
    expect(r.pendingCount).toBe(0);
  });

  it("reassembles out-of-order delivery", () => {
    const r = new ChunkReassembler();
    const json = JSON.stringify(hello);
    const chunks = encodeChunks(123, 2, json, 8);
    let result: AgentMsg | null = null;
    for (const c of [...chunks].reverse()) result = r.add(c) ?? result;
    expect(result).toEqual(hello);
  });

  it("keeps interleaved messages separate by document id and message id", () => {
    const r = new ChunkReassembler();
    const a: AgentMsg = { kind: "cmdres", reqId: 10, ok: true, data: "AAAA".repeat(10) };
    const b: AgentMsg = { kind: "cmdres", reqId: 20, ok: true, data: "BBBB".repeat(10) };
    const c: AgentMsg = { kind: "cmdres", reqId: 30, ok: true, data: "CCCC".repeat(10) };
    const ca = encodeChunks(10, 1, JSON.stringify(a), 12);
    const cb = encodeChunks(10, 2, JSON.stringify(b), 12);
    // The new document reuses msgId 1 and must not collide with document 10.
    const cc = encodeChunks(20, 1, JSON.stringify(c), 12);

    const results: AgentMsg[] = [];
    const max = Math.max(ca.length, cb.length, cc.length);
    for (let i = 0; i < max; i++) {
      for (const chunks of [ca, cb, cc]) {
        const chunk = chunks[i];
        if (chunk !== undefined) {
          const out = r.add(chunk);
          if (out !== null) results.push(out);
        }
      }
    }
    expect(results).toContainEqual(a);
    expect(results).toContainEqual(b);
    expect(results).toContainEqual(c);
    expect(results).toHaveLength(3);
  });

  it("deduplicates chunks and completed messages by document id and message id", () => {
    const r = new ChunkReassembler();
    const json = JSON.stringify(hello);
    const chunks = encodeChunks(123, 5, json, Math.ceil(json.length / 2));
    expect(r.add(chunks[0]!)).toBeNull();
    expect(r.add(chunks[0]!)).toBeNull();
    expect(r.add(chunks[1]!)).toEqual(hello);
    for (const chunk of chunks) expect(r.add(chunk)).toBeNull();
  });

  it("admits a reused message id from a different document", () => {
    const r = new ChunkReassembler();
    expect(r.add(encodeChunks(123, 5, JSON.stringify(hello))[0]!)).toEqual(hello);
    const otherDoc = { ...hello, docId: 124 };
    expect(r.add(encodeChunks(124, 5, JSON.stringify(otherDoc))[0]!)).toEqual(otherDoc);
  });

  it("expires stale partials after PARTIAL_TTL_MS", () => {
    const r = new ChunkReassembler();
    const json = JSON.stringify(hello);
    const chunks = encodeChunks(123, 6, json, 8);
    const t0 = 1_000_000;
    expect(r.add(chunks[0]!, t0)).toBeNull();
    expect(r.pendingCount).toBe(1);
    const t1 = t0 + PARTIAL_TTL_MS + 1;
    let result: AgentMsg | null = null;
    for (const c of chunks.slice(1)) result = r.add(c, t1) ?? result;
    expect(result).toBeNull();
    result = null;
    for (const c of chunks) result = r.add(c, t1) ?? result;
    expect(result).toEqual(hello);
  });

  it("returns null for non-chunk payloads", () => {
    expect(new ChunkReassembler().add("garbage")).toBeNull();
  });
});
