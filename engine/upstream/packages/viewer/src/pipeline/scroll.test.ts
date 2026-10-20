// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EventType, IncrementalSource, type eventWithTime, type Up } from "@mirror/protocol";
import { createScrollFilter } from "./scroll";

function scrollEvent(id: number, x: number, y: number): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: { source: IncrementalSource.Scroll, id, x, y },
  } as eventWithTime;
}

describe("P1 local-first scroll", () => {
  it("syncs upstream at no more than 10Hz per node and keeps the latest position", () => {
    let now = 0;
    const sent: Up[] = [];
    const timers: Array<() => void> = [];
    const filter = createScrollFilter({
      send: (message) => sent.push(message),
      now: () => now,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    });

    filter.localScroll("T1", 4, 0, 100);
    now = 20;
    filter.localScroll("T1", 4, 0, 140);
    now = 70;
    filter.localScroll("T1", 4, 0, 220);
    expect(sent).toMatchObject([{ t: "scroll", nodeId: 4, y: 100 }]);

    now = 100;
    timers[0]?.();
    expect(sent).toMatchObject([
      { t: "scroll", nodeId: 4, y: 100 },
      { t: "scroll", nodeId: 4, y: 220 },
    ]);
  });

  it("suppresses the server echo for 500ms without blocking later server-originated scrolls", () => {
    let now = 0;
    const sent: Up[] = [];
    const filter = createScrollFilter({ send: (message) => sent.push(message), now: () => now });
    filter.localScroll("T1", 8, 2, 90);

    now = 250;
    expect(filter(scrollEvent(8, 2, 90), { tab: "T1", nowMs: now })).toBeNull();
    now = 600;
    const server = scrollEvent(8, 0, 0);
    expect(filter(server, { tab: "T1", nowMs: now })).toBe(server);

    // The native scroll event caused by applying that server event is recognized, not echoed up.
    filter.localScroll("T1", 8, 0, 0);
    expect(sent).toHaveLength(1);
    filter.reset();
  });

  it("matches fractional and scaled native positions to the server scroll within a few pixels", () => {
    let now = 1_000;
    const sent: Up[] = [];
    const filter = createScrollFilter({ send: (message) => sent.push(message), now: () => now });
    const server = scrollEvent(8, 120.25, 450.5);

    expect(filter(server, { tab: "T1", nowMs: now })).toBe(server);
    now = 1_010;
    filter.localScroll("T1", 8, 122.9, 448);

    expect(sent).toEqual([]);
    filter.reset();
  });

  it("throttles independently per scroller, including the window node 0", () => {
    const sent: Up[] = [];
    const filter = createScrollFilter({ send: (message) => sent.push(message), now: () => 1 });
    filter.localScroll("T1", 0, 0, 50);
    filter.localScroll("T1", 12, 0, 75);
    expect(sent).toMatchObject([
      { nodeId: 0, y: 50 },
      { nodeId: 12, y: 75 },
    ]);
    filter.reset();
  });

  it("reconciles a suppressed top-window echo to the authoritative server position", () => {
    let now = 0;
    const sent: Up[] = [];
    const timers: Array<() => void> = [];
    const snapped: Array<{ x: number; y: number }> = [];
    const filter = createScrollFilter({
      send: (message) => sent.push(message),
      now: () => now,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    });
    filter.registerDocumentScroll(1, 0, {
      snap: (x, y) => snapped.push({ x, y }),
      settleMs: 0,
    });

    filter.localScroll("T1", 0, 0, 120);
    now = 250;
    expect(filter(scrollEvent(1, 0, 80), { tab: "T1", nowMs: now })).toBeNull();
    expect(snapped).toEqual([]);

    // Continued local motion extends the suppression deadline; the queued server state wins once
    // that newer local interaction has also gone quiet.
    now = 400;
    filter.localScroll("T1", 0, 0, 130);
    now = 500;
    timers[0]?.();
    expect(snapped).toEqual([]);
    now = 900;
    timers.at(-1)?.();
    expect(snapped).toEqual([{ x: 0, y: 80 }]);

    // The native event raised by the snap is an application acknowledgement, not new input.
    filter.localScroll("T1", 0, 0, 80);
    expect(sent).toMatchObject([
      { t: "scroll", nodeId: 0, y: 120 },
      { t: "scroll", nodeId: 0, y: 130 },
    ]);

    now = 1_000;
    expect(filter(scrollEvent(1, 0, 40), { tab: "T1", nowMs: now })).toBeNull();
    expect(snapped).toEqual([
      { x: 0, y: 80 },
      { x: 0, y: 40 },
    ]);
    filter.reset();
  });

  it("does not echo smooth child-window steps and snaps after its settle phase", () => {
    let now = 1_000;
    const sent: Up[] = [];
    const timers: Array<() => void> = [];
    const snapped: Array<{ x: number; y: number }> = [];
    const filter = createScrollFilter({
      send: (message) => sent.push(message),
      now: () => now,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    });
    filter.registerDocumentScroll(20, 10, {
      snap: (x, y) => snapped.push({ x, y }),
      settleMs: 500,
    });
    const server = scrollEvent(20, 0, 100);

    expect(filter(server, { tab: "T1", nowMs: now })).toBe(server);
    now = 1_010;
    filter.localScroll("T1", 10, 0, 12);
    now = 1_100;
    filter.localScroll("T1", 10, 0, 70);

    now = 1_500;
    timers.at(-1)?.();

    expect(sent).toEqual([]);
    expect(snapped).toEqual([{ x: 0, y: 100 }]);
    filter.reset();
  });
});
