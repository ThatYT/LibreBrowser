import { decodeDown, type Down, type Up } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import { createViewportAgreement } from "../hub/viewport";
import { createRoleManager, type RoleSender } from "./roles";

function collector(): { messages: Down[]; send: RoleSender } {
  const messages: Down[] = [];
  return {
    messages,
    send(msg, serialized) {
      expect(decodeDown(serialized)).toEqual(msg);
      messages.push(msg);
    },
  };
}

const key: Up = { t: "key", tab: "t1", kind: "down", key: "a", code: "KeyA", mods: 0 };

describe("SEC-2 roles", () => {
  it("drops a viewer-role connection's input server-side", async () => {
    const output = collector();
    const roles = createRoleManager();
    roles.connect({ sessionId: "s1", inviteRole: "viewer", viewerId: "viewer", ...output });
    const forward = vi.fn();

    expect(await roles.routeUp("viewer", key, forward)).toBe("dropped");
    expect(forward).not.toHaveBeenCalled();
    expect(roles.role("viewer")).toBe("viewer");
  });

  it("allows an authenticated read-only viewer's scoped media negotiation but no input", async () => {
    const output = collector();
    const roles = createRoleManager();
    roles.connect({ sessionId: "s1", inviteRole: "viewer", viewerId: "viewer", ...output });
    const forward = vi.fn();
    const rtc: Up = {
      t: "rtc-sig",
      tab: "t1",
      lane: "replayer-generation-1",
      payload: { type: "video", id: 9 },
    };

    expect(await roles.routeUp("viewer", rtc, forward)).toBe("forwarded");
    expect(forward).toHaveBeenCalledWith(rtc);
    expect(await roles.routeUp("viewer", key, forward)).toBe("dropped");
  });

  it("enforces one driver and broadcasts presence plus the current driver", () => {
    const first = collector();
    const second = collector();
    const roles = createRoleManager({ now: () => 123 });
    roles.connect({ sessionId: "s1", inviteRole: "driver", viewerId: "a", name: "A", ...first });
    roles.connect({ sessionId: "s1", inviteRole: "driver", viewerId: "b", name: "B", ...second });

    expect(roles.role("a")).toBe("driver");
    expect(roles.role("b")).toBe("viewer");
    expect(second.messages[0]).toEqual({
      t: "hello",
      viewerId: "b",
      role: "viewer",
      sessionId: "s1",
      serverTs: 123,
    });
    expect(second.messages).toContainEqual({ t: "driver", viewerId: "a" });
    expect(second.messages).toContainEqual({
      t: "presence",
      viewers: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });
  });

  it("transfers input rights and reruns D7 with the new driver's viewport", async () => {
    vi.useFakeTimers();
    try {
      const driver = collector();
      const viewer = collector();
      const sendMetrics = vi.fn(async () => ({}));
      const requestSnapshot = vi.fn();
      let agreement: ReturnType<typeof createViewportAgreement>;
      const onDriverChange = vi.fn((change) => {
        if (change.viewport !== undefined) agreement.handle(change.to, change.viewport);
      });
      const roles = createRoleManager({ onDriverChange });
      agreement = createViewportAgreement({
        send: sendMetrics,
        sessionFor: () => "cdp-1",
        hubFor: () => ({ viewport: null, requestSnapshot }),
        isDriver: (viewerId) => roles.isDriver(viewerId),
      });
      roles.connect({ sessionId: "s1", inviteRole: "driver", viewerId: "a", ...driver });
      roles.connect({ sessionId: "s1", inviteRole: "viewer", viewerId: "b", ...viewer });
      const targetView: Up = { t: "view", tab: "t1", w: 900, h: 700, dpr: 2 };
      expect(await roles.routeUp("b", targetView, vi.fn())).toBe("dropped");

      expect(await roles.routeUp("a", { t: "driver-transfer", to: "b" }, vi.fn())).toBe("handled");
      expect(onDriverChange).toHaveBeenCalledWith({
        sessionId: "s1",
        from: "a",
        to: "b",
        viewport: targetView,
        reason: "transfer",
      });
      expect(roles.isDriver("a")).toBe(false);
      expect(roles.isDriver("b")).toBe(true);
      expect(driver.messages).toContainEqual({ t: "driver", viewerId: "b" });
      expect(agreement.gate.allowsInput("b", "t1")).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      expect(sendMetrics).toHaveBeenCalledWith("cdp-1", "Emulation.setDeviceMetricsOverride", {
        width: 900,
        height: 700,
        deviceScaleFactor: 2,
        mobile: false,
      });
      expect(requestSnapshot).toHaveBeenCalledWith("viewport");

      const oldForward = vi.fn();
      const newForward = vi.fn();
      expect(await roles.routeUp("a", key, oldForward)).toBe("dropped");
      expect(await roles.routeUp("b", key, newForward)).toBe("forwarded");
      expect(oldForward).not.toHaveBeenCalled();
      expect(newForward).toHaveBeenCalledWith(key);
      agreement.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("allows another device of the same account to take control, but not a read-only invite",async()=>{
  const roles=createRoleManager();const output=collector();const forward=vi.fn();
  roles.connect({sessionId:'owner',inviteRole:'driver',viewerId:'first',...output});
  roles.connect({sessionId:'owner',inviteRole:'driver',viewerId:'second',...output});
  roles.connect({sessionId:'owner',inviteRole:'viewer',viewerId:'read-only',...output});
  expect(roles.isDriver('first')).toBe(true);
  expect(await roles.routeUp('read-only',{t:'driver-transfer',to:'read-only'},forward)).toBe('dropped');
  expect(await roles.routeUp('second',{t:'driver-transfer',to:'second'},forward)).toBe('handled');
  expect(roles.isDriver('second')).toBe(true);
  expect(roles.isDriver('first')).toBe(false);
});
