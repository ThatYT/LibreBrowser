import {
  EventType,
  IncrementalSource,
  encodeMsg,
  type AgentMsg,
  type Down,
  type eventWithTime,
} from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabHub, type RewriteStage } from "./tabhub";

function hello(docId: number, isTop = true): AgentMsg {
  return { kind: "hello", docId, url: `https://doc-${docId}.example/`, isTop, ts: docId };
}

function meta(docId: number): eventWithTime {
  return {
    type: EventType.Meta,
    timestamp: docId * 1_000,
    data: { href: `https://doc-${docId}.example/`, width: 1280, height: 720 },
  };
}

function full(docId: number): eventWithTime {
  return {
    type: EventType.FullSnapshot,
    timestamp: docId * 1_000 + 1,
    data: {
      node: { type: 0, id: docId, childNodes: [] },
      initialOffset: { top: 0, left: 0 },
    },
  };
}

function delta(docId: number, index: number): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: docId * 1_000 + index + 2,
    data: { source: IncrementalSource.Scroll, id: index, x: 0, y: index },
  };
}

function rrweb(docId: number, e: eventWithTime): AgentMsg {
  return { kind: "rrweb", docId, e };
}

function snapshotMessage(messages: Down[]): Extract<Down, { t: "snapshot" }> {
  const message = messages.find((candidate) => candidate.t === "snapshot");
  if (message?.t !== "snapshot") throw new Error("expected snapshot message");
  return message;
}

function assertJoinInvariant(hub: TabHub): void {
  const payload = hub.joinPayload();
  expect(payload[0]).toEqual({ t: "resync", tab: hub.tabId });
  if (payload.length === 1) return;

  const snapshot = payload[1];
  expect(snapshot?.t).toBe("snapshot");
  if (snapshot?.t !== "snapshot") return;
  expect(snapshot.data.map((event) => event.type)).toEqual([
    EventType.Meta,
    EventType.FullSnapshot,
  ]);

  const batched = payload[2];
  if (batched === undefined) {
    expect(hub.seq).toBe(snapshot.seq);
    return;
  }
  expect(batched.t).toBe("delta");
  if (batched.t !== "delta") return;
  expect(batched.epoch).toBe(snapshot.epoch);
  expect(batched.seq).toBe(snapshot.seq + 1);
  expect(hub.seq).toBe(batched.seq + batched.data.length - 1);
}

describe("TabHub", () => {
  afterEach(() => vi.useRealTimers());

  it("opens an epoch with Meta + FullSnapshot and returns a contiguous join payload", () => {
    const hub = new TabHub({ sessionId: "s1", tabId: "t1" });
    let snapshotRequests = 0;
    hub.onNeedSnapshot(() => snapshotRequests++);

    expect(hub.ingest(hello(11))).toEqual([]);
    expect(snapshotRequests).toBe(1);
    expect(hub.joinPayload()).toEqual([{ t: "resync", tab: "t1" }]);
    expect(hub.ingest(rrweb(11, meta(11)))).toEqual([]);

    const opened = snapshotMessage(hub.ingest(rrweb(11, full(11))));
    expect(opened).toMatchObject({ t: "snapshot", tab: "t1", epoch: 1, seq: 1 });
    expect(opened.data.map((event) => event.type)).toEqual([
      EventType.Meta,
      EventType.FullSnapshot,
    ]);

    expect(hub.ingest(rrweb(11, delta(11, 0)))[0]).toMatchObject({
      t: "delta",
      epoch: 1,
      seq: 2,
    });
    expect(hub.ingest(rrweb(11, delta(11, 1)))[0]).toMatchObject({
      t: "delta",
      epoch: 1,
      seq: 3,
    });

    const joined = hub.joinPayload();
    expect(joined).toHaveLength(3);
    expect(joined[2]).toMatchObject({ t: "delta", epoch: 1, seq: 2 });
    if (joined[2]?.t === "delta") expect(joined[2].data).toHaveLength(2);
    assertJoinInvariant(hub);
  });

  it("invalidates the old document immediately and drops stale or child streams", () => {
    const hub = new TabHub({ sessionId: "s1", tabId: "t1" });
    let snapshotRequests = 0;
    hub.onNeedSnapshot(() => snapshotRequests++);

    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));
    hub.ingest(rrweb(1, delta(1, 0)));

    expect(hub.ingest(hello(2))).toEqual([]);
    expect(snapshotRequests).toBe(2);
    expect(hub.joinPayload()).toEqual([{ t: "resync", tab: "t1" }]);
    expect(hub.ingest(rrweb(1, delta(1, 99)))).toEqual([]);
    expect(hub.ingest(hello(200, false))).toEqual([]);
    expect(hub.docId).toBe(2);

    hub.ingest(rrweb(2, meta(2)));
    const reopened = snapshotMessage(hub.ingest(rrweb(2, full(2))));
    expect(reopened.epoch).toBe(2);
    expect(reopened.seq).toBe(3);
    assertJoinInvariant(hub);
  });

  it("requests one replacement snapshot after event or serialized-byte thresholds", () => {
    const eventHub = new TabHub({
      sessionId: "s1",
      tabId: "events",
      maxDeltaEvents: 2,
      maxDeltaBytes: Number.MAX_SAFE_INTEGER,
    });
    let eventRequests = 0;
    eventHub.onNeedSnapshot(() => eventRequests++);
    eventHub.ingest(hello(1));
    eventHub.ingest(rrweb(1, meta(1)));
    eventHub.ingest(rrweb(1, full(1)));
    expect(eventRequests).toBe(1);
    eventHub.ingest(rrweb(1, delta(1, 0)));
    eventHub.ingest(rrweb(1, delta(1, 1)));
    expect(eventRequests).toBe(1);
    eventHub.ingest(rrweb(1, delta(1, 2)));
    eventHub.ingest(rrweb(1, delta(1, 3)));
    expect(eventRequests).toBe(2);

    const nextSnapshot = snapshotMessage(eventHub.ingest(rrweb(1, full(1))));
    expect(nextSnapshot.epoch).toBe(2);
    expect(eventHub.deltas).toEqual([]);
    expect(eventHub.deltaBytes).toBe(0);

    const byteHub = new TabHub({
      sessionId: "s1",
      tabId: "bytes",
      maxDeltaEvents: Number.MAX_SAFE_INTEGER,
      maxDeltaBytes: 0,
    });
    let byteRequests = 0;
    byteHub.onNeedSnapshot(() => byteRequests++);
    byteHub.ingest(hello(2));
    byteHub.ingest(rrweb(2, meta(2)));
    byteHub.ingest(rrweb(2, full(2)));
    const unicodeDelta: eventWithTime = {
      type: EventType.Custom,
      timestamp: 2_002,
      data: { tag: "wire-bytes", payload: "🙂" },
    };
    const emitted = byteHub.ingest(rrweb(2, unicodeDelta));
    expect(byteRequests).toBe(2);
    expect(byteHub.deltaBytes).toBe(new TextEncoder().encode(encodeMsg(emitted[0]!)).byteLength);
  });

  it("labels navigation, trim, viewport, and resync snapshots with their cause", () => {
    const hub = new TabHub({ sessionId: "s1", tabId: "reasons", maxDeltaEvents: 0 });
    const requestedReasons: string[] = [];
    hub.onNeedSnapshot((reason) => requestedReasons.push(reason));

    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    const navigation = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(navigation.reason).toBe("nav");
    expect(snapshotMessage(hub.joinPayload()).reason).toBe("resync");

    hub.ingest(rrweb(1, delta(1, 0)));
    const trim = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(trim.reason).toBe("trim");

    hub.requestSnapshot("viewport");
    const viewport = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(viewport.reason).toBe("viewport");
    expect(requestedReasons).toEqual(["nav", "trim", "viewport"]);
  });

  it("queues a viewport snapshot behind an in-flight trim without mislabeling either", () => {
    const hub = new TabHub({ sessionId: "s1", tabId: "queued-reason", maxDeltaEvents: 0 });
    const requestedReasons: string[] = [];
    hub.onNeedSnapshot((reason) => requestedReasons.push(reason));
    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));

    hub.ingest(rrweb(1, delta(1, 0)));
    hub.requestSnapshot("viewport");
    expect(snapshotMessage(hub.ingest(rrweb(1, full(1)))).reason).toBe("trim");
    expect(requestedReasons).toEqual(["nav", "trim", "viewport"]);
    expect(snapshotMessage(hub.ingest(rrweb(1, full(1)))).reason).toBe("viewport");
  });

  it("defers a threshold trim until driver input has been idle for the quiet window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "idle-trim",
      maxDeltaEvents: 0,
      trimIdleMs: 750,
    });
    const requestedReasons: string[] = [];
    hub.onNeedSnapshot((reason) => requestedReasons.push(reason));
    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));

    hub.noteInput();
    hub.ingest(rrweb(1, delta(1, 0)));
    expect(requestedReasons).toEqual(["nav"]);
    vi.advanceTimersByTime(500);
    hub.noteInput();
    vi.advanceTimersByTime(749);
    expect(requestedReasons).toEqual(["nav"]);

    vi.advanceTimersByTime(1);
    expect(requestedReasons).toEqual(["nav", "trim"]);
    expect(hub.lastInputAt).toBe(1_500);
  });

  it("re-arms after a failed snapshot command and clears the bounded tail on retry", async () => {
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "retry",
      maxDeltaEvents: 2,
      maxDeltaBytes: Number.MAX_SAFE_INTEGER,
    });
    let requests = 0;
    hub.onNeedSnapshot(() => {
      requests += 1;
      if (requests === 2) return Promise.reject(new Error("snapshot command failed"));
    });

    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));
    for (let index = 0; index < 3; index++) hub.ingest(rrweb(1, delta(1, index)));
    expect(requests).toBe(2);

    await Promise.resolve();
    hub.ingest(rrweb(1, delta(1, 3)));
    expect(requests).toBe(3);

    hub.ingest(rrweb(1, full(1)));
    expect(hub.deltas).toEqual([]);
    expect(hub.deltaBytes).toBe(0);
  });

  it("times out a fire-and-forget snapshot request so the next breach retries", () => {
    vi.useFakeTimers();
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "timeout-retry",
      maxDeltaEvents: 0,
      snapshotRequestTimeoutMs: 25,
    });
    let requests = 0;
    hub.onNeedSnapshot(() => requests++);

    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));
    hub.ingest(rrweb(1, delta(1, 0)));
    expect(requests).toBe(2);

    vi.advanceTimersByTime(25);
    hub.ingest(rrweb(1, delta(1, 1)));
    expect(requests).toBe(3);
  });

  it("retries a timed-out navigation snapshot without waiting for a delta breach", async () => {
    vi.useFakeTimers();
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "nav-timeout-retry",
      snapshotRequestTimeoutMs: 25,
      snapshotRetryMs: 10,
      snapshotRetryMaxMs: 20,
    });
    const reasons: string[] = [];
    hub.onNeedSnapshot((reason) => reasons.push(reason));

    hub.ingest(hello(1));
    await vi.advanceTimersByTimeAsync(25);
    expect(reasons).toEqual(["nav"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(reasons).toEqual(["nav", "nav"]);

    hub.ingest(rrweb(1, meta(1)));
    const recovered = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(recovered.reason).toBe("nav");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed navigation snapshot with bounded backoff and eventually recovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "nav-retry",
      snapshotRequestTimeoutMs: 1_000,
      snapshotRetryMs: 10,
      snapshotRetryMaxMs: 25,
    });
    const attempts: Array<{ at: number; reason: string }> = [];
    hub.onNeedSnapshot((reason) => {
      attempts.push({ at: Date.now(), reason });
      if (attempts.length < 5) return Promise.reject(new Error("snapshot command failed"));
    });

    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    for (let index = 0; index < 1_000; index++) hub.ingest(rrweb(1, delta(1, index)));
    expect(hub.deltas).toEqual([]);
    expect(hub.deltaBytes).toBe(0);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(25);
    expect(attempts).toEqual([
      { at: 0, reason: "nav" },
      { at: 10, reason: "nav" },
      { at: 30, reason: "nav" },
      { at: 55, reason: "nav" },
      { at: 80, reason: "nav" },
    ]);

    const recovered = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(recovered).toMatchObject({ reason: "nav", epoch: 1 });
    expect(hub.deltas).toEqual([]);
    expect(hub.deltaBytes).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toHaveLength(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed resync snapshot and clears the buffered tail on recovery", async () => {
    vi.useFakeTimers();
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "resync-retry",
      snapshotRetryMs: 10,
      snapshotRetryMaxMs: 20,
    });
    const reasons: string[] = [];
    hub.onNeedSnapshot((reason) => {
      reasons.push(reason);
      if (
        reason === "resync" &&
        reasons.filter((candidate) => candidate === "resync").length === 1
      ) {
        return Promise.reject(new Error("resync snapshot failed"));
      }
    });
    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));
    hub.ingest(rrweb(1, delta(1, 0)));

    hub.requestSnapshot("resync");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(reasons).toEqual(["nav", "resync", "resync"]);

    const recovered = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(recovered.reason).toBe("resync");
    expect(hub.deltas).toEqual([]);
    expect(hub.deltaBytes).toBe(0);
  });

  it("cancels a stale navigation retry when a newer document supersedes it", async () => {
    vi.useFakeTimers();
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "superseded-nav",
      snapshotRequestTimeoutMs: 1_000,
      snapshotRetryMs: 50,
      snapshotRetryMaxMs: 100,
    });
    const attempts: Array<{ docId: number; reason: string }> = [];
    hub.onNeedSnapshot((reason) => {
      attempts.push({ docId: hub.docId, reason });
      if (hub.docId === 1) return Promise.reject(new Error("old document failed"));
    });

    hub.ingest(hello(1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(49);
    expect(attempts).toEqual([{ docId: 1, reason: "nav" }]);

    hub.ingest(hello(2));
    hub.ingest(rrweb(2, meta(2)));
    const recovered = snapshotMessage(hub.ingest(rrweb(2, full(2))));
    expect(recovered).toMatchObject({ reason: "nav", epoch: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(attempts).toEqual([
      { docId: 1, reason: "nav" },
      { docId: 2, reason: "nav" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the rewrite stage before storing and measuring every rrweb event", () => {
    const seen: Array<{ type: EventType; sessionId: string; tabId: string }> = [];
    const rewrite: RewriteStage = (event, context) => {
      seen.push({ type: event.type, ...context });
      return { ...event, timestamp: event.timestamp + 10 };
    };
    const hub = new TabHub({ sessionId: "session-x", tabId: "tab-x", rewrite });

    hub.ingest(hello(3));
    hub.ingest(rrweb(3, meta(3)));
    hub.ingest(rrweb(3, full(3)));
    hub.ingest(rrweb(3, delta(3, 0)));

    expect(seen).toEqual([
      { type: EventType.Meta, sessionId: "session-x", tabId: "tab-x" },
      { type: EventType.FullSnapshot, sessionId: "session-x", tabId: "tab-x" },
      { type: EventType.IncrementalSnapshot, sessionId: "session-x", tabId: "tab-x" },
    ]);
    expect(hub.meta?.timestamp).toBe(meta(3).timestamp + 10);
    expect(hub.snapshot?.timestamp).toBe(full(3).timestamp + 10);
    expect(hub.deltas[0]?.timestamp).toBe(delta(3, 0).timestamp + 10);
  });

  it("maintains the join invariant across deterministic navigation/threshold interleavings", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const hub = new TabHub({
        sessionId: `s${seed}`,
        tabId: `t${seed}`,
        maxDeltaEvents: 1 + (seed % 4),
      });
      let requests = 0;
      hub.onNeedSnapshot(() => requests++);

      for (let doc = 1; doc <= 6; doc++) {
        const docId = seed * 100 + doc;
        hub.ingest(hello(docId));
        hub.ingest(rrweb(docId - 1, delta(docId - 1, 999)));

        // Exercise both pair arrival orders without exposing an incomplete snapshot.
        if ((seed + doc) % 2 === 0) {
          hub.ingest(rrweb(docId, meta(docId)));
          hub.ingest(rrweb(docId, full(docId)));
        } else {
          hub.ingest(rrweb(docId, full(docId)));
          expect(hub.joinPayload()).toEqual([{ t: "resync", tab: `t${seed}` }]);
          hub.ingest(rrweb(docId, meta(docId)));
        }
        assertJoinInvariant(hub);

        const count = (seed * doc) % 8;
        for (let index = 0; index < count; index++) {
          const before = requests;
          hub.ingest(rrweb(docId, delta(docId, index)));
          assertJoinInvariant(hub);
          if (requests > before) {
            hub.ingest(rrweb(docId, full(docId)));
            assertJoinInvariant(hub);
          }
        }
      }
    }
  });

  it("validates configurable thresholds and ignores command responses", () => {
    expect(() => new TabHub({ sessionId: "s", tabId: "t", maxDeltaEvents: -1 })).toThrow(
      RangeError,
    );
    expect(() => new TabHub({ sessionId: "s", tabId: "t", maxDeltaBytes: 1.5 })).toThrow(
      RangeError,
    );
    expect(() => new TabHub({ sessionId: "s", tabId: "t", snapshotRequestTimeoutMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => new TabHub({ sessionId: "s", tabId: "t", snapshotRetryMs: 0 })).toThrow(
      RangeError,
    );
    expect(
      () =>
        new TabHub({
          sessionId: "s",
          tabId: "t",
          snapshotRetryMs: 20,
          snapshotRetryMaxMs: 10,
        }),
    ).toThrow(RangeError);
    expect(() => new TabHub({ sessionId: "s", tabId: "t", trimIdleMs: -1 })).toThrow(RangeError);

    const hub = new TabHub({ sessionId: "s", tabId: "t" });
    expect(() => hub.noteInput(Number.NaN)).toThrow(RangeError);
    expect(hub.ingest({ kind: "cmdres", reqId: 1, ok: true })).toEqual([]);
  });
});
