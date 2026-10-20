import {
  EventType,
  IncrementalSource,
  decodeDown,
  type AgentMsg,
  type Down,
  type eventWithTime,
} from "@mirror/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabHub } from "../hub/tabhub";
import { Fanout } from "./server";
import { RESUME_BYTES, STALL_BYTES, ViewerConn, type ViewerSocket } from "./viewerconn";

class MockSocket implements ViewerSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  take(): Down[] {
    return this.sent.splice(0).map((raw) => decodeDown(raw));
  }
}

function event(type: EventType, index: number): eventWithTime {
  if (type === EventType.Meta) {
    return {
      type,
      timestamp: index,
      data: { href: "https://example.test/", width: 1280, height: 720 },
    };
  }
  if (type === EventType.FullSnapshot) {
    return {
      type,
      timestamp: index,
      data: {
        node: { type: 0, id: 1, childNodes: [] },
        initialOffset: { top: 0, left: 0 },
      },
    };
  }
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: index,
    data: { source: IncrementalSource.Scroll, id: index, x: 0, y: index },
  };
}

function rrweb(e: eventWithTime): AgentMsg {
  return { kind: "rrweb", docId: 1, e };
}

function readyHub(): TabHub {
  const hub = new TabHub({ sessionId: "s1", tabId: "t1" });
  hub.ingest({
    kind: "hello",
    docId: 1,
    url: "https://example.test/",
    isTop: true,
    ts: 0,
  });
  hub.ingest(rrweb(event(EventType.Meta, 1)));
  hub.ingest(rrweb(event(EventType.FullSnapshot, 2)));
  return hub;
}

function publishEvent(hub: TabHub, fanout: Fanout, index: number): void {
  for (const msg of hub.ingest(rrweb(event(EventType.IncrementalSnapshot, index)))) {
    fanout.publish(msg);
  }
}

describe("P0-FANOUT", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("batches contiguous deltas for 30ms and broadcasts one byte-identical serialization", () => {
    const hub = readyHub();
    const fanout = new Fanout();
    const a = new MockSocket();
    const b = new MockSocket();
    fanout.addViewer(new ViewerConn(a, () => hub.joinPayload()));
    fanout.addViewer(new ViewerConn(b, () => hub.joinPayload()));
    a.take();
    b.take();

    publishEvent(hub, fanout, 10);
    publishEvent(hub, fanout, 11);
    vi.advanceTimersByTime(29);
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(a.sent).toEqual(b.sent);
    expect(a.sent).toHaveLength(1);
    expect(decodeDown(a.sent[0]!)).toMatchObject({
      t: "delta",
      tab: "t1",
      epoch: 1,
      seq: 2,
      data: [{ timestamp: 10 }, { timestamp: 11 }],
    });
    fanout.close();
  });

  it("stalls only the slow viewer, then drains into a fresh join payload", () => {
    const hub = readyHub();
    const fanout = new Fanout(30);
    const slowSocket = new MockSocket();
    const fastSocket = new MockSocket();
    const slow = new ViewerConn(slowSocket, () => hub.joinPayload(), { drainPollMs: 10 });
    const fast = new ViewerConn(fastSocket, () => hub.joinPayload(), { drainPollMs: 10 });
    fanout.addViewer(slow);
    fanout.addViewer(fast);
    slowSocket.take();
    fastSocket.take();

    slowSocket.bufferedAmount = STALL_BYTES + 1;
    publishEvent(hub, fanout, 20);
    vi.advanceTimersByTime(30);
    expect(slow.isStalled).toBe(true);
    expect(slowSocket.sent).toEqual([]);
    expect(fastSocket.take()).toMatchObject([{ t: "delta", seq: 2 }]);

    publishEvent(hub, fanout, 21);
    vi.advanceTimersByTime(5);
    expect(slowSocket.sent).toEqual([]);
    expect(fastSocket.sent).toEqual([]);

    slowSocket.bufferedAmount = RESUME_BYTES - 1;
    vi.advanceTimersByTime(5);
    expect(slow.isStalled).toBe(false);
    expect(fastSocket.take()).toMatchObject([{ t: "delta", seq: 3 }]);
    const recovery = slowSocket.take();
    expect(recovery.map((msg) => msg.t)).toEqual(["resync", "snapshot", "delta"]);
    expect(recovery[2]).toMatchObject({ t: "delta", seq: 2 });
    if (recovery[2]?.t === "delta") expect(recovery[2].data).toHaveLength(2);

    // The original batch timer was canceled by recovery; no overlapping tail arrives later.
    vi.advanceTimersByTime(30);
    expect(slowSocket.sent).toEqual([]);
    expect(fastSocket.sent).toEqual([]);

    publishEvent(hub, fanout, 22);
    vi.advanceTimersByTime(30);
    expect(slowSocket.sent).toEqual(fastSocket.sent);
    expect(decodeDown(slowSocket.sent[0]!)).toMatchObject({ t: "delta", seq: 4 });
    fanout.close();
  });

  it("does not replay a pending batch to a viewer whose join already contained it", () => {
    const hub = readyHub();
    const fanout = new Fanout();
    const existingSocket = new MockSocket();
    fanout.addViewer(new ViewerConn(existingSocket, () => hub.joinPayload()));
    existingSocket.take();

    publishEvent(hub, fanout, 30);
    const joiningSocket = new MockSocket();
    fanout.addViewer(new ViewerConn(joiningSocket, () => hub.joinPayload()));

    expect(existingSocket.take()).toMatchObject([{ t: "delta", seq: 2 }]);
    const joined = joiningSocket.take();
    expect(joined.map((msg) => msg.t)).toEqual(["resync", "snapshot", "delta"]);
    expect(joined[2]).toMatchObject({ t: "delta", seq: 2 });
    vi.advanceTimersByTime(30);
    expect(joiningSocket.sent).toEqual([]);
    fanout.close();
  });

  it("checks the strict backpressure boundaries before sending", () => {
    const socket = new MockSocket();
    const viewer = new ViewerConn(socket, () => [], { drainPollMs: 10 });
    const msg: Extract<Down, { t: "px" }> = { t: "px", tab: "t1", data: "x", w: 1, h: 1 };

    socket.bufferedAmount = STALL_BYTES;
    expect(viewer.send(msg, JSON.stringify(msg))).toBe(true);
    socket.take();
    socket.bufferedAmount = STALL_BYTES + 1;
    expect(viewer.send(msg, JSON.stringify(msg))).toBe(false);
    expect(viewer.isStalled).toBe(true);
    socket.bufferedAmount = RESUME_BYTES;
    vi.advanceTimersByTime(10);
    expect(viewer.isStalled).toBe(true);
    socket.bufferedAmount = RESUME_BYTES - 1;
    vi.advanceTimersByTime(10);
    expect(viewer.isStalled).toBe(false);
    viewer.dispose();
  });

  it("chaos mode drops selected delta messages for one viewer without changing peers", () => {
    const randomValues = [0.005, 0.5];
    const fanout = new Fanout(1, {
      dropRate: 0.01,
      random: () => randomValues.shift() ?? 1,
    });
    const first = new MockSocket();
    const second = new MockSocket();
    fanout.addViewer(new ViewerConn(first, () => []));
    fanout.addViewer(new ViewerConn(second, () => []));
    fanout.publish({
      t: "delta",
      tab: "chaos-tab",
      epoch: 1,
      seq: 1,
      data: [event(EventType.IncrementalSnapshot, 1)],
    });
    vi.advanceTimersByTime(1);

    expect(first.sent).toEqual([]);
    expect(second.take()).toMatchObject([{ t: "delta", tab: "chaos-tab", seq: 1 }]);
    expect(fanout.chaosStats).toEqual({
      deltaMessagesConsidered: 2,
      deltaMessagesDropped: 1,
      droppedByTab: { "chaos-tab": 1 },
    });
    fanout.close();
  });
});
