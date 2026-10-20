import type { AgentCmdInput, AgentMsg, CmdRes, Up } from "@mirror/protocol";
import { Mod } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AgentLink, CdpSend } from "../types";
import { createInputRelay, type InputMsg } from "./relay";

const pointer = (kind: "move" | "down" | "up" | "wheel"): Extract<Up, { t: "ptr" }> => ({
  t: "ptr",
  tab: "tab-1",
  kind,
  nodeId: 42,
  rx: 0.5,
  ry: 0.25,
  vx: 700,
  vy: 500,
  button: 0,
  buttons: kind === "up" ? 0 : 1,
  mods: Mod.Shift,
  clicks: 2,
  dx: 4,
  dy: 9,
});

function harness(
  options: {
    rect?: (call: number) => Promise<CmdRes>;
    driver?: string;
    allowed?: boolean;
    session?: string;
    rectTimeoutMs?: number;
  } = {},
) {
  const cdp: { sessionId: string; method: string; params?: Record<string, unknown> }[] = [];
  const commands: AgentCmdInput[] = [];
  const notes: string[] = [];
  let rectCalls = 0;
  const agentLink: AgentLink = {
    async *msgs(): AsyncIterable<AgentMsg> {},
    async sendCmd(_tabId, command) {
      commands.push(command);
      if (command.cmd === "resolve") {
        return { reqId: commands.length, ok: true, data: { kind: "local" } };
      }
      if (command.cmd === "rect") {
        rectCalls += 1;
        return (
          options.rect?.(rectCalls) ??
          Promise.resolve({
            reqId: rectCalls,
            ok: true,
            data: { x: 10, y: 20, w: 100, h: 80, visible: true },
          })
        );
      }
      return { reqId: commands.length, ok: true };
    },
  };
  const send: CdpSend = async (sessionId, method, params) => {
    cdp.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
    return {};
  };
  const relay = createInputRelay({
    agentLink,
    send,
    sessionFor: () => options.session ?? "session-1",
    isDriver: (viewerId) => viewerId === (options.driver ?? "driver"),
    allowsInput: () => options.allowed ?? true,
    noteInput: (tabId) => notes.push(tabId),
    viewportFor: () => ({ w: 640, h: 480 }),
    rectTimeoutMs: options.rectTimeoutMs ?? 10,
  });
  return { relay, cdp, commands, notes, rectCalls: () => rectCalls };
}

describe("InputRelay", () => {
  it("re-resolves down and up independently and preserves their wire order", async () => {
    let releaseFirstRect!: () => void;
    const firstRectReady = new Promise<void>((resolve) => (releaseFirstRect = resolve));
    const h = harness({
      rectTimeoutMs: 1_000,
      rect: async (call) => {
        if (call === 1) await firstRectReady;
        return {
          reqId: call,
          ok: true,
          data:
            call === 1
              ? { x: 10, y: 20, w: 100, h: 80, visible: true }
              : { x: 210, y: 120, w: 100, h: 80, visible: true },
        };
      },
    });

    const down = h.relay("driver", pointer("down"));
    const up = h.relay("driver", pointer("up"));
    await vi.waitFor(() => expect(h.rectCalls()).toBe(1));
    releaseFirstRect();
    await expect(Promise.all([down, up])).resolves.toEqual([true, true]);

    expect(h.commands).toEqual([
      { cmd: "resolve", nodeId: 42 },
      { cmd: "rect", nodeId: 42 },
      { cmd: "resolve", nodeId: 42 },
      { cmd: "rect", nodeId: 42 },
    ]);
    expect(h.cdp.map(({ params }) => params)).toEqual([
      expect.objectContaining({
        type: "mousePressed",
        x: 60,
        y: 40,
        button: "left",
        modifiers: Mod.Shift,
        clickCount: 2,
      }),
      expect.objectContaining({
        type: "mouseReleased",
        x: 260,
        y: 140,
        button: "left",
        modifiers: Mod.Shift,
        clickCount: 2,
      }),
    ]);
  });

  it("falls back to raw viewport coordinates only when rect resolution fails", async () => {
    const h = harness({
      rect: async (call) => ({ reqId: call, ok: false, err: "node gone" }),
    });
    await expect(h.relay("driver", pointer("down"))).resolves.toBe(true);
    expect(h.cdp[0]?.params).toMatchObject({ x: 640 - Number.EPSILON, y: 480 - Number.EPSILON });
    expect(h.relay.rectFallbacksFor("tab-1")).toBe(1);
  });

  it("falls back promptly when rect resolution times out", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ rect: () => new Promise<CmdRes>(() => undefined) });
      const dispatched = h.relay("driver", pointer("down"));
      await vi.advanceTimersByTimeAsync(10);
      await expect(dispatched).resolves.toBe(true);
      expect(h.cdp[0]?.params).toMatchObject({ x: 640 - Number.EPSILON, y: 480 - Number.EPSILON });
      expect(h.relay.rectFallbacksFor("tab-1")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards hover and the single wheel path through trusted CDP input", async () => {
    const h = harness();
    await h.relay("driver", pointer("move"));
    await h.relay("driver", pointer("wheel"));
    expect(h.cdp.map(({ params }) => params)).toEqual([
      expect.objectContaining({ type: "mouseMoved", button: "none", x: 60, y: 40 }),
      expect.objectContaining({
        type: "mouseWheel",
        button: "none",
        x: 60,
        y: 40,
        deltaX: 4,
        deltaY: 9,
      }),
    ]);
  });

  it("maps raw key pairs and reserves insertText for paste and IME commit text", async () => {
    const h = harness();
    const messages: InputMsg[] = [
      { t: "key", tab: "tab-1", kind: "down", key: "!", code: "Digit1", mods: Mod.Shift },
      { t: "key", tab: "tab-1", kind: "up", key: "!", code: "Digit1", mods: Mod.Shift },
      { t: "text", tab: "tab-1", insert: "pasted line one\npasted line two" },
      { t: "value", tab: "tab-1", nodeId: 8, value: "selected", commit: false },
      { t: "value", tab: "tab-1", nodeId: 9, value: "on", checked: true },
      {
        t: "value",
        tab: "tab-1",
        nodeId: 10,
        value: "beta",
        values: ["beta", "gamma"],
      },
      { t: "scroll", tab: "tab-1", nodeId: 7, x: 11, y: 22 },
      { t: "scroll", tab: "tab-1", nodeId: 0, x: 0, y: 300 },
    ];
    for (const msg of messages) await h.relay("driver", msg);

    expect(h.cdp).toEqual([
      {
        sessionId: "session-1",
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyDown",
          modifiers: Mod.Shift,
          key: "!",
          code: "Digit1",
          text: "!",
          unmodifiedText: "!",
          windowsVirtualKeyCode: 49,
          location: 0,
          isKeypad: false,
        },
      },
      {
        sessionId: "session-1",
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyUp",
          modifiers: Mod.Shift,
          key: "!",
          code: "Digit1",
          windowsVirtualKeyCode: 49,
          location: 0,
          isKeypad: false,
        },
      },
      {
        sessionId: "session-1",
        method: "Input.insertText",
        params: { text: "pasted line one\npasted line two" },
      },
    ]);
    expect(h.commands.slice(-9)).toEqual([
      { cmd: "resolve", nodeId: 8 },
      { cmd: "value", nodeId: 8, value: "selected", commit: false },
      { cmd: "resolve", nodeId: 9 },
      { cmd: "value", nodeId: 9, value: "on", checked: true },
      { cmd: "resolve", nodeId: 10 },
      { cmd: "value", nodeId: 10, value: "beta", values: ["beta", "gamma"] },
      { cmd: "resolve", nodeId: 7 },
      { cmd: "scroll", nodeId: 7, x: 11, y: 22 },
      { cmd: "scroll", nodeId: 0, x: 0, y: 300 },
    ]);
  });

  it("composes and clamps OOPIF rects while routing rect, value, and scroll to the child", async () => {
    const commands: { targetId: string; command: AgentCmdInput }[] = [];
    const cdp: { sessionId: string; method: string; params?: Record<string, unknown> }[] = [];
    const agentLink: AgentLink = {
      async *msgs(): AsyncIterable<AgentMsg> {},
      async sendCmd(targetId, command) {
        commands.push({ targetId, command });
        if (command.cmd === "resolve") {
          return targetId === "tab-1"
            ? {
                reqId: commands.length,
                ok: true,
                data: {
                  kind: "remote",
                  iframeNodeId: 5,
                  remoteId: command.nodeId - 35,
                },
              }
            : { reqId: commands.length, ok: true, data: { kind: "local" } };
        }
        if (command.cmd === "rect") {
          return targetId === "child-1"
            ? {
                reqId: commands.length,
                ok: true,
                data: { x: -20, y: 10, w: 80, h: 40, visible: true },
              }
            : {
                reqId: commands.length,
                ok: true,
                data: { x: 100, y: 50, w: 50, h: 50, visible: true },
              };
        }
        return { reqId: commands.length, ok: true };
      },
    };
    const send: CdpSend = async (sessionId, method, params) => {
      cdp.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
      if (method === "Runtime.evaluate") return { result: { objectId: "iframe-object" } };
      if (method === "DOM.describeNode") return { node: { frameId: "child-1" } };
      return {};
    };
    const relay = createInputRelay({
      agentLink,
      send,
      sessionFor: (targetId) =>
        targetId === "tab-1" ? "top-session" : targetId === "child-1" ? "child-session" : undefined,
      isDriver: () => true,
      allowsInput: () => true,
      noteInput: () => {},
      viewportFor: () => ({ w: 640, h: 480 }),
    });

    await expect(relay("driver", { ...pointer("down"), rx: 0, ry: 0 })).resolves.toBe(true);
    await expect(
      relay("driver", { t: "value", tab: "tab-1", nodeId: 43, value: "beta" }),
    ).resolves.toBe(true);
    await expect(
      relay("driver", { t: "scroll", tab: "tab-1", nodeId: 44, x: 3, y: 90 }),
    ).resolves.toBe(true);

    const mouse = cdp.find(({ method }) => method === "Input.dispatchMouseEvent");
    expect(mouse).toMatchObject({
      sessionId: "top-session",
      params: { x: 100.01, y: 60, type: "mousePressed" },
    });
    expect(relay.rectFallbacksFor("tab-1")).toBe(0);
    expect(commands).toContainEqual({
      targetId: "child-1",
      command: { cmd: "rect", nodeId: 7 },
    });
    expect(commands).toContainEqual({
      targetId: "child-1",
      command: { cmd: "value", nodeId: 8, value: "beta" },
    });
    expect(commands).toContainEqual({
      targetId: "child-1",
      command: { cmd: "scroll", nodeId: 9, x: 3, y: 90 },
    });
  });

  it("dispatches in-flight IME composition with the viewer selection", async () => {
    const h = harness();

    await expect(
      h.relay("driver", {
        t: "ime",
        tab: "tab-1",
        text: "にほ",
        selStart: 1,
        selEnd: 2,
      }),
    ).resolves.toBe(true);

    expect(h.cdp).toEqual([
      {
        sessionId: "session-1",
        method: "Input.imeSetComposition",
        params: { text: "にほ", selectionStart: 1, selectionEnd: 2 },
      },
    ]);
    expect(h.notes).toEqual(["tab-1"]);
  });

  it("drops follower, stale-viewport, and unknown-tab input including IME", async () => {
    const follower = harness();
    const stale = harness({ allowed: false });
    const detached = harness({ session: "" });
    // Make this explicit because an empty flat-session id is technically valid to the mock.
    const noSession = createInputRelay({
      agentLink: {
        async *msgs() {},
        async sendCmd() {
          return { reqId: 1, ok: true };
        },
      },
      send: vi.fn(),
      sessionFor: () => undefined,
      isDriver: () => true,
      allowsInput: () => true,
      noteInput: vi.fn(),
      viewportFor: () => ({ w: 1, h: 1 }),
    });

    await expect(follower.relay("viewer", pointer("down"))).resolves.toBe(false);
    await expect(stale.relay("driver", pointer("down"))).resolves.toBe(false);
    await expect(noSession("driver", pointer("down"))).resolves.toBe(false);
    await expect(
      follower.relay("viewer", {
        t: "ime",
        tab: "tab-1",
        text: "x",
        selStart: 0,
        selEnd: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      stale.relay("driver", {
        t: "ime",
        tab: "tab-1",
        text: "x",
        selStart: 0,
        selEnd: 1,
      }),
    ).resolves.toBe(false);
    expect(follower.cdp).toEqual([]);
    expect(stale.cdp).toEqual([]);
    expect(detached.notes).toEqual([]);
  });
});
