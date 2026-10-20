// @vitest-environment node
import type { Down, Up } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import type { TargetRef } from "./types";
import {
  createRtcSignalRelay,
  RTC_SIGNAL_BINDING_NAME,
  RTC_SIGNAL_RECEIVER_SYMBOL,
  type RtcBindingEvent,
} from "./rtcsig";

function harness() {
  const attached = new Set<(target: TargetRef) => void>();
  const detached = new Set<(target: TargetRef) => void>();
  let bindingHandler: ((sessionId: string, event: RtcBindingEvent) => void) | undefined;
  const send = vi.fn(async () => ({}));
  const delivered: Array<{ viewerId: string; message: Extract<Down, { t: "rtc-sig" }> }> = [];
  const relay = createRtcSignalRelay({
    send,
    targets: {
      onAttached: (callback) => void attached.add(callback),
      onDetached: (callback) => void detached.add(callback),
    },
    onBindingCalled(callback) {
      bindingHandler = callback;
      return () => {
        bindingHandler = undefined;
      };
    },
    sendViewer: (viewerId, message) => void delivered.push({ viewerId, message }),
  });
  return { attached, detached, binding: () => bindingHandler, delivered, relay, send };
}

function receiverExpression(peer: string, lane: string, payload: unknown): string {
  return `(0,globalThis[Symbol.for(${JSON.stringify(RTC_SIGNAL_RECEIVER_SYMBOL)})])(${JSON.stringify({ peer, lane, payload })})`;
}

describe("canvas rtc-sig relay", () => {
  it("targets one authenticated viewer and tab in both directions", async () => {
    const h = harness();
    const first: TargetRef = { targetId: "tab-a", sessionId: "cdp-a", type: "page" };
    const second: TargetRef = { targetId: "tab-b", sessionId: "cdp-b", type: "page" };
    for (const callback of h.attached) {
      callback(first);
      callback(second);
    }

    const payload = { type: "video", id: 42 };
    const up: Extract<Up, { t: "rtc-sig" }> = {
      t: "rtc-sig",
      tab: "tab-b",
      lane: "generation-b1",
      payload,
    };
    await expect(h.relay.handleViewer("viewer-1", up)).resolves.toBe(true);
    expect(h.send).toHaveBeenLastCalledWith("cdp-b", "Runtime.evaluate", {
      expression: receiverExpression("viewer-1", "generation-b1", payload),
      awaitPromise: false,
    });

    h.binding()?.("cdp-b", {
      name: RTC_SIGNAL_BINDING_NAME,
      payload: JSON.stringify({
        peer: "viewer-1",
        lane: "generation-b1",
        payload: { type: "signal", signal: { sdp: "offer-b" } },
      }),
    });
    expect(h.delivered).toEqual([
      {
        viewerId: "viewer-1",
        message: {
          t: "rtc-sig",
          tab: "tab-b",
          lane: "generation-b1",
          from: "agent",
          payload: { type: "signal", signal: { sdp: "offer-b" } },
        },
      },
    ]);
    h.relay.dispose();
  });

  it("keeps viewers independent, closes replaced/disconnected lanes, and drops forged responses", async () => {
    const h = harness();
    const target: TargetRef = { targetId: "tab-a", sessionId: "cdp-a", type: "page" };
    for (const callback of h.attached) callback(target);

    const request = (viewer: string, lane: string) =>
      h.relay.handleViewer(viewer, {
        t: "rtc-sig",
        tab: "tab-a",
        lane,
        payload: { type: "canvas", id: 7 },
      });
    await request("viewer-1", "v1-old");
    await request("viewer-2", "v2-live");
    await request("viewer-1", "v1-new");
    expect(h.send).toHaveBeenCalledWith("cdp-a", "Runtime.evaluate", {
      expression: receiverExpression("viewer-1", "v1-old", { type: "close" }),
      awaitPromise: false,
    });

    const sendCount = h.send.mock.calls.length;
    await expect(
      h.relay.handleViewer("viewer-1", {
        t: "rtc-sig",
        tab: "tab-a",
        lane: "v1-old",
        payload: { type: "close" },
      }),
    ).resolves.toBe(false);
    await expect(
      h.relay.handleViewer("viewer-1", {
        t: "rtc-sig",
        tab: "tab-a",
        lane: "v1-old",
        payload: { type: "signal", signal: { candidate: "stale" } },
      }),
    ).resolves.toBe(false);
    expect(h.send).toHaveBeenCalledTimes(sendCount);

    const emit = (peer: string, lane: string) =>
      h.binding()?.("cdp-a", {
        name: RTC_SIGNAL_BINDING_NAME,
        payload: JSON.stringify({
          peer,
          lane,
          payload: { type: "signal", signal: { candidate: `${peer}-${lane}` } },
        }),
      });
    emit("viewer-1", "v1-old");
    emit("viewer-1", "v1-new");
    emit("viewer-2", "v2-live");
    emit("forged-viewer", "v1-new");
    expect(h.delivered.map(({ viewerId }) => viewerId)).toEqual(["viewer-1", "viewer-2"]);

    h.relay.removeViewer("viewer-2");
    expect(h.send).toHaveBeenLastCalledWith("cdp-a", "Runtime.evaluate", {
      expression: receiverExpression("viewer-2", "v2-live", { type: "close" }),
      awaitPromise: false,
    });
    h.relay.dispose();
  });

  it("does not leak detached, malformed, or unknown tabs into another page peer", async () => {
    const h = harness();
    const target: TargetRef = { targetId: "gone", sessionId: "old-session", type: "page" };
    for (const callback of h.attached) callback(target);
    for (const callback of h.detached) callback(target);

    await expect(
      h.relay.handleViewer("viewer", {
        t: "rtc-sig",
        tab: "gone",
        lane: "lane",
        payload: { type: "signal", signal: {} },
      }),
    ).resolves.toBe(false);
    await expect(
      h.relay.handleViewer("viewer", {
        t: "rtc-sig",
        tab: "gone",
        lane: "lane",
        payload: { any: true },
      }),
    ).resolves.toBe(false);
    h.binding()?.("old-session", { name: RTC_SIGNAL_BINDING_NAME, payload: "123" });
    expect(h.delivered).toEqual([]);
    h.relay.dispose();
  });

  it("rejects invalid and oversized signaling before evaluating page code", async () => {
    const h = harness();
    const target: TargetRef = { targetId: "tab-a", sessionId: "cdp-a", type: "page" };
    for (const callback of h.attached) callback(target);

    await expect(
      h.relay.handleViewer("viewer", {
        t: "rtc-sig",
        tab: "tab-a",
        lane: "lane",
        payload: { type: "unknown" },
      }),
    ).resolves.toBe(false);
    await expect(
      h.relay.handleViewer("viewer", {
        t: "rtc-sig",
        tab: "tab-a",
        lane: "lane",
        payload: { type: "signal", signal: { sdp: "x".repeat(128 * 1024) } },
      }),
    ).resolves.toBe(false);
    expect(h.send).not.toHaveBeenCalled();
    h.relay.dispose();
  });
});
