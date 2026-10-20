import {
  EventType,
  IncrementalSource,
  decodeDown,
  type AgentMsg,
  type Down,
  type eventWithTime,
} from "@mirror/protocol";
import type { Protocol } from "puppeteer-core";
import { describe, expect, it, vi } from "vitest";

import type { FlatSessionEventMap } from "./browser/launch";
import { TabHub } from "./hub/tabhub";
import type { CdpSend, TargetRef } from "./types";
import { Fanout } from "./ws/server";
import { STALL_BYTES, ViewerConn, type ViewerSocket } from "./ws/viewerconn";
import { createScreencast } from "./px";

interface Call {
  sessionId: string;
  method: string;
  params?: Record<string, unknown>;
}

class MockBrowser {
  readonly calls: Call[] = [];
  private readonly attached = new Set<(target: TargetRef) => void>();
  private readonly detached = new Set<(target: TargetRef) => void>();
  private readonly events = new Map<
    keyof FlatSessionEventMap,
    Set<(sessionId: string, event: unknown) => void>
  >();

  readonly send: CdpSend = async (sessionId, method, params) => {
    this.calls.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
    return {};
  };

  onAttached(callback: (target: TargetRef) => void): void {
    this.attached.add(callback);
  }

  onDetached(callback: (target: TargetRef) => void): void {
    this.detached.add(callback);
  }

  onSessionEvent<K extends keyof FlatSessionEventMap>(
    method: K,
    callback: (sessionId: string, event: FlatSessionEventMap[K]) => void,
  ): () => void {
    const callbacks = this.events.get(method) ?? new Set();
    const erased = callback as (sessionId: string, event: unknown) => void;
    callbacks.add(erased);
    this.events.set(method, callbacks);
    return () => callbacks.delete(erased);
  }

  attach(target: TargetRef): void {
    for (const callback of this.attached) callback(target);
  }

  frame(sessionId: string, event: Protocol.Page.ScreencastFrameEvent): void {
    for (const callback of this.events.get("Page.screencastFrame") ?? []) {
      callback(sessionId, event);
    }
  }
}

class MockSocket implements ViewerSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  messages(): Down[] {
    return this.sent.map((message) => decodeDown(message));
  }
}

function rrweb(docId: number, e: eventWithTime): AgentMsg {
  return { kind: "rrweb", docId, e };
}

function frame(sessionId: number, data: string): Protocol.Page.ScreencastFrameEvent {
  return {
    sessionId,
    data,
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: 1920,
      deviceHeight: 1080,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    },
  };
}

describe("createScreencast", () => {
  it("keeps an early first frame and replays it on repeated pixel requests", async () => {
    const browser = new MockBrowser();
    const hub = new TabHub({ sessionId: "session", tabId: "tab-1" });
    const sent: Down[] = [];
    const send: CdpSend = async (session, method) => {
      if (method === "Page.startScreencast") browser.frame(session, frame(1, "first"));
      return {};
    };
    const controller = createScreencast({
      browser: {
        send,
        onAttached: browser.onAttached.bind(browser),
        onDetached: browser.onDetached.bind(browser),
        onSessionEvent: browser.onSessionEvent.bind(browser),
      },
      hubFor: () => hub,
      publish: (message) => sent.push(message),
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(sent.some((message) => message.t === "px" && message.data === "first")).toBe(true);
    expect(sent.slice(-2).map((message) => message.t)).toEqual(["mode", "px"]);
    sent.length = 0;
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(sent.map((message) => message.t)).toEqual(["mode", "px"]);
    controller.dispose();
  });

  it("toggles px/dom, acks every frame, drops backpressured frames, and leaves rrweb recording", async () => {
    const browser = new MockBrowser();
    const hub = new TabHub({ sessionId: "session", tabId: "tab-1" });
    hub.viewport = { w: 1280, h: 720, dpr: 2 };
    const fanout = new Fanout();
    const fastSocket = new MockSocket();
    const slowSocket = new MockSocket();
    const fast = new ViewerConn(fastSocket, () => hub.joinPayload());
    const slow = new ViewerConn(slowSocket, () => hub.joinPayload());
    fanout.addViewer(fast);
    fanout.addViewer(slow);
    const controller = createScreencast({
      browser,
      hubFor: (tabId) => (tabId === "tab-1" ? hub : undefined),
      publish: (message) => fanout.publish(message),
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });

    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(hub.mode).toBe("px");
    expect(browser.calls[0]).toEqual({
      sessionId: "cdp-1",
      method: "Page.startScreencast",
      params: {
        format: "jpeg",
        quality: 60,
        everyNthFrame: 1,
        maxWidth: 1280,
        maxHeight: 720,
      },
    });

    // The semantic recorder remains live in px mode: it opens and advances the same TabHub.
    hub.ingest({
      kind: "hello",
      docId: 1,
      url: "https://video.test/",
      isTop: true,
      ts: 1,
    });
    hub.ingest(
      rrweb(1, {
        type: EventType.Meta,
        timestamp: 1,
        data: { href: "https://video.test/", width: 1280, height: 720 },
      }),
    );
    hub.ingest(
      rrweb(1, {
        type: EventType.FullSnapshot,
        timestamp: 2,
        data: {
          node: { type: 0, id: 1, childNodes: [] },
          initialOffset: { top: 0, left: 0 },
        },
      }),
    );
    hub.ingest(
      rrweb(1, {
        type: EventType.IncrementalSnapshot,
        timestamp: 3,
        data: { source: IncrementalSource.Scroll, id: 0, x: 0, y: 42 },
      }),
    );
    expect(hub.seq).toBe(2);
    expect(hub.deltas).toHaveLength(1);

    fastSocket.sent.splice(0);
    slowSocket.sent.splice(0);
    slowSocket.bufferedAmount = STALL_BYTES + 1;
    browser.frame("cdp-1", frame(101, "jpeg-a"));
    browser.frame("cdp-1", frame(102, "jpeg-b"));

    const acknowledgements = browser.calls.filter(
      ({ method }) => method === "Page.screencastFrameAck",
    );
    expect(acknowledgements).toEqual([
      {
        sessionId: "cdp-1",
        method: "Page.screencastFrameAck",
        params: { sessionId: 101 },
      },
      {
        sessionId: "cdp-1",
        method: "Page.screencastFrameAck",
        params: { sessionId: 102 },
      },
    ]);
    expect(fastSocket.messages().filter((message) => message.t === "px")).toEqual([
      { t: "px", tab: "tab-1", data: "jpeg-a", w: 1280, h: 720 },
      { t: "px", tab: "tab-1", data: "jpeg-b", w: 1280, h: 720 },
    ]);
    expect(slowSocket.messages().filter((message) => message.t === "px")).toEqual([]);
    expect(slow.isStalled).toBe(true);

    await controller.handle({ t: "mode", tab: "tab-1", mode: "dom" });
    fanout.flushAll();
    expect(hub.mode).toBe("dom");
    expect(browser.calls.some(({ method }) => method === "Page.stopScreencast")).toBe(true);
    const fastMessages = fastSocket.messages();
    const domIndex = fastMessages.findIndex(
      (message) => message.t === "mode" && message.mode === "dom",
    );
    expect(domIndex).toBeGreaterThanOrEqual(0);
    expect(fastMessages.slice(domIndex + 1).some((message) => message.t === "resync")).toBe(true);
    expect(fastMessages.slice(domIndex + 1).some((message) => message.t === "snapshot")).toBe(true);
    expect(fastMessages.slice(domIndex + 1).some((message) => message.t === "delta")).toBe(true);

    // A frame already in flight when stop completes is still acknowledged and not forwarded.
    browser.frame("cdp-1", frame(103, "late-jpeg"));
    expect(
      browser.calls.filter(({ method }) => method === "Page.screencastFrameAck").at(-1),
    ).toEqual({
      sessionId: "cdp-1",
      method: "Page.screencastFrameAck",
      params: { sessionId: 103 },
    });
    expect(
      fastSocket.messages().some((message) => message.t === "px" && message.data === "late-jpeg"),
    ).toBe(false);

    controller.dispose();
    fanout.close();
  });

  it("serializes rapid mode transitions and reports unknown tabs", async () => {
    const browser = new MockBrowser();
    const hub = new TabHub({ sessionId: "session", tabId: "tab-1" });
    const controller = createScreencast({
      browser,
      hubFor: () => hub,
      publish: vi.fn(),
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });

    const toPx = controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    const toDom = controller.handle({ t: "mode", tab: "tab-1", mode: "dom" });
    await Promise.all([toPx, toDom]);

    expect(
      browser.calls
        .filter(
          ({ method }) => method === "Page.startScreencast" || method === "Page.stopScreencast",
        )
        .map(({ method }) => method),
    ).toEqual(["Page.startScreencast", "Page.stopScreencast"]);
    expect(controller.modeFor("tab-1")).toBe("dom");
    await expect(controller.handle({ t: "mode", tab: "missing", mode: "px" })).rejects.toThrow(
      "unknown screencast tab",
    );
    controller.dispose();
  });
});
