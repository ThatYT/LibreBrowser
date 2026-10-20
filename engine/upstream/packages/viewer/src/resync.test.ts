import { afterEach, describe, expect, it, vi } from "vitest";

import { createResyncController, RESYNC_WINDOW_MS } from "./resync";

describe("P2-RESYNC controller", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps rate and exponential backoff independently per tab", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sent: Array<{ tab: string; at: number }> = [];
    const controller = createResyncController({
      send: (message) => sent.push({ tab: message.tab, at: Date.now() }),
      autoPx: () => undefined,
    });

    expect(controller.request("A", "first gap")).toBe(true);
    expect(controller.request("B", "first gap")).toBe(true);
    expect(sent).toEqual([
      { tab: "A", at: 0 },
      { tab: "B", at: 0 },
    ]);

    expect(controller.request("A", "second gap")).toBe(true);
    expect(controller.getState("A")).toMatchObject({ pending: true, backoffMs: 250 });
    vi.advanceTimersByTime(249);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ tab: "A", at: 250 });

    expect(controller.request("A", "third gap")).toBe(true);
    expect(controller.getState("A")).toMatchObject({ pending: true, backoffMs: 500 });
    vi.advanceTimersByTime(500);
    expect(sent.at(-1)).toEqual({ tab: "A", at: 750 });
    expect(controller.getState("B")).toMatchObject({ recentResyncs: 1, storm: false });
    controller.dispose();
  });

  it("turns only the storming tab into AUTO-PX on the fourth request in 30 seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sent: string[] = [];
    const degraded: string[] = [];
    const controller = createResyncController({
      send: (message) => sent.push(message.tab),
      autoPx: (tab) => degraded.push(tab),
    });

    controller.request("storm", "one");
    controller.request("storm", "two");
    vi.advanceTimersByTime(250);
    controller.request("storm", "three");
    vi.advanceTimersByTime(500);
    expect(controller.request("storm", "four")).toBe(false);

    expect(sent).toEqual(["storm", "storm", "storm"]);
    expect(degraded).toEqual(["storm"]);
    expect(controller.getState("storm")).toMatchObject({
      totalResyncs: 3,
      recentResyncs: 3,
      pending: false,
      storm: true,
    });
    expect(controller.request("storm", "five")).toBe(false);
    expect(degraded).toEqual(["storm"]);

    controller.request("healthy", "one");
    expect(sent.at(-1)).toBe("healthy");
    expect(controller.getState("healthy").storm).toBe(false);
    controller.dispose();
  });

  it("expires the rolling window and cancels delayed work after independent recovery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const reasons: string[] = [];
    const controller = createResyncController({
      send: (message) => reasons.push(message.reason),
      autoPx: () => undefined,
    });

    controller.request("A", "one");
    controller.request("A", "obsolete");
    controller.recovered("A");
    vi.advanceTimersByTime(250);
    expect(reasons).toEqual(["one"]);

    vi.advanceTimersByTime(RESYNC_WINDOW_MS);
    controller.request("A", "fresh window");
    expect(reasons).toEqual(["one", "fresh window"]);
    expect(controller.getState("A")).toMatchObject({ recentResyncs: 1, storm: false });
    controller.dispose();
  });
});
