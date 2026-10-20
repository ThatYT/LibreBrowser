import type { Down } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import { createViewportAgreement, ViewportInputGate, type ViewportHub } from "./viewport";

function snapshot(epoch: number, reason: Extract<Down, { t: "snapshot" }>["reason"]) {
  return { tab: "t1", epoch, reason };
}

describe("ViewportInputGate", () => {
  it("locks input only for viewport epochs, not routine trim or navigation epochs", () => {
    const gate = new ViewportInputGate();

    gate.noteSnapshot(snapshot(2, "viewport"));
    expect(gate.allowsInput("driver", "t1")).toBe(false);
    gate.acknowledge("driver", "t1", 2);
    expect(gate.allowsInput("driver", "t1")).toBe(true);

    gate.noteSnapshot(snapshot(3, "trim"));
    gate.acknowledge("driver", "t1", 3);
    gate.noteSnapshot(snapshot(4, "nav"));
    gate.noteSnapshot(snapshot(4, "resync"));
    expect(gate.allowsInput("driver", "t1")).toBe(true);

    gate.noteSnapshot(snapshot(5, "viewport"));
    expect(gate.allowsInput("driver", "t1")).toBe(false);
    gate.acknowledge("driver", "t1", 5);
    expect(gate.allowsInput("driver", "t1")).toBe(true);
  });

  it("tracks acknowledgements independently per viewer and tab", () => {
    const gate = new ViewportInputGate();
    gate.noteSnapshot({ tab: "t1", epoch: 7, reason: "viewport" });
    gate.noteSnapshot({ tab: "t2", epoch: 3, reason: "viewport" });
    gate.acknowledge("a", "t1", 7);

    expect(gate.allowsInput("a", "t1")).toBe(true);
    expect(gate.allowsInput("a", "t2")).toBe(false);
    expect(gate.allowsInput("b", "t1")).toBe(false);

    gate.removeViewer("a");
    expect(gate.allowsInput("a", "t1")).toBe(false);
  });

  it("treats a reconnected socket as a new unacknowledged viewer", () => {
    const gate = new ViewportInputGate();
    gate.noteSnapshot({ tab: "t1", epoch: 12, reason: "viewport" });
    expect(gate.acknowledge("socket-before-drop", "t1", 12)).toBe(true);
    expect(gate.allowsInput("socket-before-drop", "t1")).toBe(true);

    gate.removeViewer("socket-before-drop");
    expect(gate.allowsInput("socket-after-reconnect", "t1")).toBe(false);
    gate.beginViewportChange("t1");
    expect(gate.acknowledge("socket-after-reconnect", "t1", 12)).toBe(false);
    gate.noteSnapshot({ tab: "t1", epoch: 13, reason: "viewport" });
    expect(gate.acknowledge("socket-after-reconnect", "t1", 13)).toBe(true);
    expect(gate.allowsInput("socket-after-reconnect", "t1")).toBe(true);
  });

  it("locks immediately when a viewport transition begins", () => {
    const gate = new ViewportInputGate();
    expect(gate.allowsInput("driver", "t1")).toBe(false);
    gate.beginViewportChange("t1");
    expect(gate.allowsInput("driver", "t1")).toBe(false);
    expect(gate.acknowledge("driver", "t1", 1)).toBe(false);
    gate.noteSnapshot(snapshot(1, "viewport"));
    expect(gate.allowsInput("driver", "t1")).toBe(false);
    expect(gate.acknowledge("driver", "t1", 1)).toBe(true);
    expect(gate.allowsInput("driver", "t1")).toBe(true);
  });
});

describe("ViewportAgreement", () => {
  it("debounces the driver's latest metrics, forces a snapshot, and gates until ack", async () => {
    vi.useFakeTimers();
    try {
      const calls: { method: string; params?: Record<string, unknown> }[] = [];
      const reasons: string[] = [];
      const hub: ViewportHub = {
        viewport: null,
        requestSnapshot: (reason) => reasons.push(reason),
      };
      const agreement = createViewportAgreement({
        send: async (_sessionId, method, params) => {
          calls.push({ method, params });
          return {};
        },
        sessionFor: () => "session-1",
        hubFor: () => hub,
        isDriver: (viewerId) => viewerId === "driver",
      });

      expect(agreement.handle("follower", { t: "view", tab: "t1", w: 500, h: 400, dpr: 1 })).toBe(
        false,
      );
      expect(agreement.handle("driver", { t: "view", tab: "t1", w: 700, h: 500, dpr: 1 })).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(200);
      agreement.handle("driver", { t: "view", tab: "t1", w: 800, h: 600, dpr: 2 });
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);
      await vi.advanceTimersByTimeAsync(299);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(calls).toEqual([
        {
          method: "Emulation.setDeviceMetricsOverride",
          params: { width: 800, height: 600, deviceScaleFactor: 2, mobile: false },
        },
      ]);
      expect(hub.viewport).toEqual({ w: 800, h: 600, dpr: 2 });
      expect(agreement.viewportFor("t1")).toEqual({ w: 800, h: 600, dpr: 2 });
      expect(reasons).toEqual(["viewport"]);
      expect(agreement.handle("driver", { t: "view-ack", tab: "t1", epoch: 7 })).toBe(false);

      agreement.noteSnapshot({ tab: "t1", epoch: 7, reason: "viewport" });
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);
      expect(agreement.handle("driver", { t: "view-ack", tab: "t1", epoch: 7 })).toBe(true);
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(true);

      agreement.noteSnapshot({ tab: "t1", epoch: 8, reason: "trim" });
      agreement.noteSnapshot({ tab: "t1", epoch: 9, reason: "nav" });
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(true);
      agreement.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not unlock an obsolete viewport epoch when a newer resize is pending", async () => {
    vi.useFakeTimers();
    try {
      const appliedWidths: number[] = [];
      const hub: ViewportHub = { viewport: null, requestSnapshot: vi.fn() };
      const agreement = createViewportAgreement({
        send: async (_sessionId, _method, params) => {
          appliedWidths.push(params?.width as number);
          return {};
        },
        sessionFor: () => "session-1",
        hubFor: () => hub,
        isDriver: () => true,
        debounceMs: 10,
      });

      agreement.handle("driver", { t: "view", tab: "t1", w: 600, h: 400, dpr: 1 });
      await vi.advanceTimersByTimeAsync(10);
      expect(appliedWidths).toEqual([600]);

      agreement.handle("driver", { t: "view", tab: "t1", w: 900, h: 700, dpr: 1.5 });
      await vi.advanceTimersByTimeAsync(10);
      expect(appliedWidths).toEqual([600]);
      agreement.noteSnapshot({ tab: "t1", epoch: 3, reason: "viewport" });
      expect(agreement.handle("driver", { t: "view-ack", tab: "t1", epoch: 3 })).toBe(false);
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);

      await vi.advanceTimersByTimeAsync(0);
      expect(appliedWidths).toEqual([600, 900]);
      agreement.noteSnapshot({ tab: "t1", epoch: 4, reason: "viewport" });
      expect(agreement.handle("driver", { t: "view-ack", tab: "t1", epoch: 4 })).toBe(true);
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(true);
      agreement.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a missing viewport snapshot without reopening input", async () => {
    vi.useFakeTimers();
    try {
      const hub: ViewportHub = { viewport: null, requestSnapshot: vi.fn() };
      const agreement = createViewportAgreement({
        send: async () => ({}),
        sessionFor: () => "session-1",
        hubFor: () => hub,
        isDriver: () => true,
        debounceMs: 5,
        snapshotRetryMs: 20,
      });
      agreement.handle("driver", { t: "view", tab: "t1", w: 640, h: 480, dpr: 1 });
      await vi.advanceTimersByTimeAsync(5);
      expect(hub.requestSnapshot).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(hub.requestSnapshot).toHaveBeenCalledTimes(2);
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);
      agreement.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid metrics before locking or touching CDP", async () => {
    const send = vi.fn(async () => ({}));
    const agreement = createViewportAgreement({
      send,
      sessionFor: () => "session-1",
      hubFor: () => ({ viewport: null, requestSnapshot: vi.fn() }),
      isDriver: () => true,
    });
    expect(agreement.handle("driver", { t: "view", tab: "t1", w: 0, h: 600, dpr: 1 })).toBe(false);
    expect(
      agreement.handle("driver", { t: "view", tab: "t1", w: 800, h: 600, dpr: Infinity }),
    ).toBe(false);
    expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);
    expect(send).not.toHaveBeenCalled();
    agreement.dispose();
  });
});
