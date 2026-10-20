import { BINDING_NAME, encodeChunks, type AgentMsg, type eventWithTime } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";

import type { TargetRef } from "../types";
import { agentBridgeChannel } from "./bridge";
import { createAgentLink } from "./agentlink";
import type { BrowserHandle, BrowserTargetInfo, FlatSessionEventMap } from "./launch";

type BindingCallback = (
  sessionId: string,
  event: FlatSessionEventMap["Runtime.bindingCalled"],
) => void;

class MockBrowser implements BrowserHandle {
  readonly calls: { sessionId: string; method: string; params?: Record<string, unknown> }[] = [];
  private readonly attached = new Set<(target: TargetRef) => void>();
  private readonly detached = new Set<(target: TargetRef) => void>();
  private readonly bindings = new Set<BindingCallback>();

  constructor(readonly target: TargetRef) {}

  send = async (
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> => {
    this.calls.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: this.target.targetId } } };
    }
    if (method === "Page.createIsolatedWorld") return { executionContextId: 99 };
    if (method === "Runtime.evaluate" && typeof params?.contextId === "number") {
      return { result: { objectId: `bridge-${params.contextId}` } };
    }
    return {};
  };

  onSessionEvent<K extends keyof FlatSessionEventMap>(
    method: K,
    callback: (sessionId: string, event: FlatSessionEventMap[K]) => void,
  ): () => void {
    if (method !== "Runtime.bindingCalled") return () => undefined;
    const binding = callback as BindingCallback;
    this.bindings.add(binding);
    return () => this.bindings.delete(binding);
  }

  onAttached(callback: (target: TargetRef) => void): void {
    this.attached.add(callback);
    callback(this.target);
  }

  onDetached(callback: (target: TargetRef) => void): void {
    this.detached.add(callback);
  }

  onTargetInfoChanged(_callback: (info: BrowserTargetInfo) => void): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }

  emit(docId: number, msgId: number, msg: AgentMsg, executionContextId: number): void {
    for (const payload of encodeChunks(docId, msgId, JSON.stringify(msg), 32)) {
      this.emitPayload(payload, executionContextId);
    }
  }

  emitPayload(payload: string, executionContextId: number): void {
    for (const callback of this.bindings) {
      callback(this.target.sessionId, {
        name: agentBridgeChannel(this, this.target.sessionId)?.bindingName ?? BINDING_NAME,
        payload,
        executionContextId,
      });
    }
  }

  emitDuplicate(docId: number, msgId: number, msg: AgentMsg, executionContextId: number): void {
    this.emit(docId, msgId, msg, executionContextId);
    this.emit(docId, msgId, msg, executionContextId);
  }

  detach(): void {
    for (const callback of this.detached) callback(this.target);
  }
}

function hello(docId: number, isTop = true, url = `https://doc-${docId}.test/`): AgentMsg {
  return { kind: "hello", docId, url, isTop, ts: docId };
}

function rrweb(docId: number, marker: string): AgentMsg {
  const e: eventWithTime = {
    type: 5,
    timestamp: docId,
    data: { tag: "test", payload: { marker } },
  };
  return { kind: "rrweb", docId, e };
}

async function collect(stream: AsyncIterable<AgentMsg>): Promise<AgentMsg[]> {
  const result: AgentMsg[] = [];
  for await (const msg of stream) result.push(msg);
  return result;
}

async function waitForBridgeCalls(browser: MockBrowser, count: number): Promise<void> {
  await vi.waitFor(() =>
    expect(browser.calls.filter((call) => call.method === "Runtime.callFunctionOn")).toHaveLength(
      count,
    ),
  );
}

describe("createAgentLink", () => {
  it("reassembles a per-target stream, dedupes chunks, and drops stale document events", async () => {
    const target: TargetRef = { targetId: "page-1", sessionId: "session-1", type: "page" };
    const browser = new MockBrowser(target);
    const link = createAgentLink(browser);
    const stream = link.msgs(target.targetId);

    browser.emit(10, 0, hello(10), 100);
    browser.emitDuplicate(10, 1, rrweb(10, "old-current"), 100);
    // Same-process frame agents announce themselves on the page session but are not canonical.
    browser.emit(99, 0, hello(99, false), 101);
    browser.emit(20, 0, hello(20), 200);
    browser.emit(10, 2, rrweb(10, "stale"), 100);
    browser.emit(20, 1, rrweb(20, "new-current"), 200);
    browser.detach();

    const messages = await collect(stream);
    expect(messages).toEqual([
      hello(10),
      rrweb(10, "old-current"),
      hello(20),
      rrweb(20, "new-current"),
    ]);
  });

  it("accepts a new document when an SPA navigation reuses the context and resets msgId", async () => {
    const target: TargetRef = { targetId: "page-1", sessionId: "session-1", type: "page" };
    const browser = new MockBrowser(target);
    const link = createAgentLink(browser);
    const stream = link.msgs(target.targetId);

    browser.emit(10, 0, hello(10), 100);
    browser.emit(10, 1, rrweb(10, "old-current"), 100);

    // Chromium can reuse the execution context while a freshly injected agent restarts msgId.
    // M2 makes both collisions trivially distinct by document id.
    browser.emitPayload(encodeChunks(10, 0, JSON.stringify(hello(10)), 32)[0]!, 100);
    browser.emit(20, 0, hello(20), 100);
    browser.emit(10, 0, hello(10), 100);
    browser.emit(10, 1, rrweb(10, "late-stale"), 100);
    browser.emitDuplicate(20, 1, rrweb(20, "new-current"), 100);
    browser.detach();

    await expect(collect(stream)).resolves.toEqual([
      hello(10),
      rrweb(10, "old-current"),
      hello(20),
      rrweb(20, "new-current"),
    ]);
  });

  it("relays current-document clipboard messages as clip Down and drops stale ones", () => {
    const target: TargetRef = { targetId: "page-1", sessionId: "session-1", type: "page" };
    const browser = new MockBrowser(target);
    const publishClipboard = vi.fn();
    createAgentLink(browser, { publishClipboard });

    browser.emit(10, 0, hello(10), 100);
    browser.emit(
      10,
      1,
      { kind: "clip", docId: 10, text: "server copy" } as unknown as AgentMsg,
      100,
    );
    browser.emit(20, 0, hello(20), 200);
    browser.emit(
      10,
      2,
      { kind: "clip", docId: 10, text: "stale copy" } as unknown as AgentMsg,
      100,
    );

    expect(publishClipboard).toHaveBeenCalledOnce();
    expect(publishClipboard).toHaveBeenCalledWith({ t: "clip", text: "server copy" });
  });

  it("drops iframe about:blank hellos so commands survive the cross-site child lifecycle", async () => {
    const target: TargetRef = { targetId: "child-1", sessionId: "session-1", type: "iframe" };
    const browser = new MockBrowser(target);
    const link = createAgentLink(browser);
    const stream = link.msgs(target.targetId);

    browser.emit(10, 0, hello(10, false, "about:blank"), 100);
    await expect(link.sendCmd(target.targetId, { cmd: "ping" })).rejects.toThrow(
      "has not announced a document",
    );

    const bHello = hello(20, false, "https://b.test/child");
    browser.emit(20, 0, bHello, 200);
    const bPing = link.sendCmd(target.targetId, { cmd: "ping" });

    // Probe A3 observed this stale hello after the real-origin hello. Wait beyond the agent
    // emitter's roughly 200ms retry queue before proving the in-flight command still resolves.
    browser.emit(30, 0, hello(30, false, "about:blank"), 100);
    await new Promise((resolve) => setTimeout(resolve, 250));
    browser.emit(20, 1, { kind: "cmdres", reqId: 1, ok: true, data: "pong-b" }, 200);
    await expect(bPing).resolves.toEqual({ reqId: 1, ok: true, data: "pong-b" });

    const cHello = hello(40, false, "https://c.test/child");
    browser.emit(40, 0, cHello, 300);
    const cPing = link.sendCmd(target.targetId, { cmd: "ping" });
    await waitForBridgeCalls(browser, 2);
    browser.emit(40, 1, { kind: "cmdres", reqId: 2, ok: true, data: "pong-c" }, 300);
    await expect(cPing).resolves.toEqual({ reqId: 2, ok: true, data: "pong-c" });

    browser.detach();
    await expect(collect(stream)).resolves.toEqual([bHello, cHello]);
  });

  it("keeps about:blank page targets commandable", async () => {
    const target: TargetRef = { targetId: "popup-1", sessionId: "session-1", type: "page" };
    const browser = new MockBrowser(target);
    const link = createAgentLink(browser);

    browser.emit(10, 0, hello(10, true, "about:blank"), 100);
    const ping = link.sendCmd(target.targetId, { cmd: "ping" });
    await waitForBridgeCalls(browser, 1);
    browser.emit(10, 1, { kind: "cmdres", reqId: 1, ok: true, data: "pong" }, 100);

    await expect(ping).resolves.toEqual({ reqId: 1, ok: true, data: "pong" });
  });

  it("round-trips commands and rejects pending promises on navigation and detach", async () => {
    const target: TargetRef = { targetId: "page-1", sessionId: "session-1", type: "page" };
    const browser = new MockBrowser(target);
    const link = createAgentLink(browser);
    browser.emit(10, 0, hello(10), 100);

    const navigated = link.sendCmd(target.targetId, { cmd: "ping" });
    await vi.waitFor(() =>
      expect(browser.calls.some((call) => call.method === "Runtime.callFunctionOn")).toBe(true),
    );
    const firstCall = browser.calls.find((call) => call.method === "Runtime.callFunctionOn");
    expect(firstCall?.params).toMatchObject({
      awaitPromise: false,
      arguments: [{ value: "command" }, { value: [{ cmd: "ping", reqId: 1 }] }],
    });

    browser.emit(20, 0, hello(20), 200);
    await expect(navigated).rejects.toThrow("navigated");

    const ping = link.sendCmd(target.targetId, { cmd: "ping" });
    await waitForBridgeCalls(browser, 2);
    browser.emit(20, 1, { kind: "cmdres", reqId: 2, ok: true, data: "pong" }, 200);
    await expect(ping).resolves.toEqual({ reqId: 2, ok: true, data: "pong" });

    const detached = link.sendCmd(target.targetId, { cmd: "ping" });
    browser.detach();
    await expect(detached).rejects.toThrow("detached");
    await expect(link.sendCmd(target.targetId, { cmd: "ping" })).rejects.toThrow("detached");
  });

  it("rejects a command after the fixed three-second timeout", async () => {
    vi.useFakeTimers();
    try {
      const target: TargetRef = { targetId: "page-1", sessionId: "session-1", type: "page" };
      const browser = new MockBrowser(target);
      const link = createAgentLink(browser);
      browser.emit(10, 0, hello(10), 100);

      const timeout = expect(link.sendCmd(target.targetId, { cmd: "ping" })).rejects.toThrow(
        "timed out after 3000ms",
      );
      await vi.advanceTimersByTimeAsync(3_000);
      await timeout;
    } finally {
      vi.useRealTimers();
    }
  });
});
