import { describe, expect, it } from "vitest";
import { decodeDown, decodeUp, encodeMsg, Mod, type Down, type Up } from "../src/index";

describe("wire envelope", () => {
  it("round-trips representative Down messages", () => {
    const msgs: Down[] = [
      { t: "hello", viewerId: "v1", role: "driver", sessionId: "s1", serverTs: 1_721_234_567 },
      { t: "pong", id: 7, sentTs: 1_721_234_500, serverTs: 1_721_234_567 },
      { t: "tabs", tabs: [{ id: "T1", url: "https://x/", title: "x", active: true }] },
      { t: "chrome", tab: "T1", url: "https://x/", loading: false, canBack: true, canFwd: false },
      { t: "snapshot", tab: "T1", epoch: 1, seq: 1, data: [], reason: "nav" },
      { t: "delta", tab: "T1", epoch: 1, seq: 2, data: [] },
      { t: "resync", tab: "T1" },
      { t: "mode", tab: "T1", mode: "px" },
      { t: "px", tab: "T1", data: "aGk=", w: 1280, h: 720 },
      {
        t: "rtc-sig",
        tab: "T1",
        lane: "replayer-generation-1",
        from: "agent",
        payload: { type: "signal", signal: { sdp: "offer" } },
      },
      { t: "download", id: "d1", name: "f.zip", recv: 10, total: 100, state: "active" },
      {
        t: "filepick",
        tab: "T1",
        key: "upload-key",
        multiple: true,
        maxFiles: 20,
        maxFileBytes: 104_857_600,
        maxTotalBytes: 524_288_000,
      },
      { t: "driver", viewerId: "v1" },
      { t: "presence", viewers: [{ id: "v1", name: "me" }] },
    ];
    for (const m of msgs) expect(decodeDown(encodeMsg(m))).toEqual(m);
  });

  it("round-trips representative Up messages", () => {
    const msgs: Up[] = [
      { t: "ping", id: 7, sentTs: 1_721_234_500 },
      { t: "view", tab: "T1", w: 1280, h: 720, dpr: 2 },
      { t: "view-ack", tab: "T1", epoch: 3 },
      {
        t: "ptr",
        tab: "T1",
        kind: "down",
        nodeId: 42,
        rx: 0.5,
        ry: 0.5,
        vx: 100,
        vy: 200,
        button: 0,
        buttons: 1,
        mods: Mod.Shift,
      },
      { t: "key", tab: "T1", kind: "down", key: "a", code: "KeyA", mods: 0 },
      { t: "text", tab: "T1", insert: "こんにちは" },
      { t: "value", tab: "T1", nodeId: 42, value: "committed-option" },
      { t: "value", tab: "T1", nodeId: 43, value: "on", checked: true },
      { t: "value", tab: "T1", nodeId: 44, value: "beta", values: ["beta", "gamma"] },
      { t: "ime", tab: "T1", text: "こん", selStart: 2, selEnd: 2 },
      { t: "scroll", tab: "T1", nodeId: 0, x: 0, y: 500 },
      { t: "nav", tab: "T1", action: "go", url: "https://x/" },
      { t: "resync-req", tab: "T1", reason: "seq gap" },
      { t: "driver-transfer", to: "v2" },
      {
        t: "rtc-sig",
        tab: "T1",
        lane: "replayer-generation-1",
        payload: { type: "video", id: 42 },
      },
    ];
    for (const m of msgs) expect(decodeUp(encodeMsg(m))).toEqual(m);
  });

  it("rejects unknown tags and cross-direction messages", () => {
    expect(() => decodeUp(JSON.stringify({ t: "snapshot" }))).toThrow(/unknown tag/);
    expect(() => decodeDown(JSON.stringify({ t: "view-ack" }))).toThrow(/unknown tag/);
    expect(() => decodeUp(JSON.stringify({ t: "evil" }))).toThrow(/unknown tag/);
    expect(() => decodeUp("not json")).toThrow(/not JSON/);
    expect(() => decodeUp("42")).toThrow(/missing tag/);
    // "mode", "rtc-sig", "clip" legitimately exist in both directions
    expect(decodeUp(encodeMsg({ t: "mode", tab: "T1", mode: "dom" }))).toBeTruthy();
    expect(decodeDown(encodeMsg({ t: "mode", tab: "T1", mode: "dom" }))).toBeTruthy();
  });

  it("uses CDP modifier encoding", () => {
    expect(Mod.Alt).toBe(1);
    expect(Mod.Ctrl).toBe(2);
    expect(Mod.Meta).toBe(4);
    expect(Mod.Shift).toBe(8);
  });
});
