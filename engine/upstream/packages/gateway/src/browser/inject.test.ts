import { describe, expect, it, vi } from "vitest";

import type { TargetRef } from "../types";
import type { BrowserHandle, FlatSessionEventMap } from "./launch";
import { agentBridgeChannel, isolatedAgentBridgeSource } from "./bridge";
import { injectAgent, WEBDRIVER_NORMALIZER } from "./inject";

class RecordingBrowser implements BrowserHandle {
  readonly calls: { sessionId: string; method: string; params?: Record<string, unknown> }[] = [];
  private readonly detachedCallbacks = new Set<(target: TargetRef) => void>();
  private readonly frameNavigatedCallbacks = new Set<
    (sessionId: string, event: FlatSessionEventMap["Page.frameNavigated"]) => void
  >();

  send = async (
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> => {
    this.calls.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 101 };
    return {};
  };

  onSessionEvent<K extends keyof FlatSessionEventMap>(
    method: K,
    cb: (sessionId: string, event: FlatSessionEventMap[K]) => void,
  ): () => void {
    if (method === "Page.frameNavigated") {
      const callback = cb as (
        sessionId: string,
        event: FlatSessionEventMap["Page.frameNavigated"],
      ) => void;
      this.frameNavigatedCallbacks.add(callback);
      return () => this.frameNavigatedCallbacks.delete(callback);
    }
    return () => undefined;
  }

  onAttached(_cb: (target: TargetRef) => void): void {}
  onDetached(cb: (target: TargetRef) => void): void {
    this.detachedCallbacks.add(cb);
  }
  onTargetInfoChanged(_cb: Parameters<BrowserHandle["onTargetInfoChanged"]>[0]): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }

  detach(target: TargetRef): void {
    for (const callback of this.detachedCallbacks) callback(target);
  }

  navigate(sessionId: string): void {
    const event = {
      frame: { id: "frame-2" },
      type: "Navigation",
    } as unknown as FlatSessionEventMap["Page.frameNavigated"];
    for (const callback of this.frameNavigatedCallbacks) callback(sessionId, event);
  }
}

describe("injectAgent", () => {
  it("runs the frozen D1 sequence in exact order with the real agent bundle", async () => {
    const browser = new RecordingBrowser();
    const target: TargetRef = { targetId: "page-1", sessionId: "session-1", type: "page" };

    await injectAgent(browser, target);
    const channel = agentBridgeChannel(browser, target.sessionId);
    expect(channel).toBeDefined();
    const isolatedSource = browser.calls[2]?.params?.source;
    const agentSource = browser.calls[3]?.params?.source;
    expect(isolatedSource).toBe(isolatedAgentBridgeSource(channel!));
    expect(agentSource).toEqual(expect.any(String));
    expect(agentSource).toContain(JSON.stringify(channel!.bindingName));
    expect(agentSource).toContain(JSON.stringify(channel!.rtcBindingName));
    expect(agentSource).toContain(JSON.stringify(channel!.bridgeKey));

    expect(browser.calls).toEqual([
      { sessionId: "session-1", method: "Page.enable" },
      {
        sessionId: "session-1",
        method: "Page.addScriptToEvaluateOnNewDocument",
        params: { source: WEBDRIVER_NORMALIZER, runImmediately: true },
      },
      {
        sessionId: "session-1",
        method: "Page.addScriptToEvaluateOnNewDocument",
        params: {
          source: isolatedSource,
          worldName: channel!.worldName,
          runImmediately: true,
        },
      },
      {
        sessionId: "session-1",
        method: "Page.addScriptToEvaluateOnNewDocument",
        params: { source: agentSource, runImmediately: true },
      },
      {
        sessionId: "session-1",
        method: "Runtime.runIfWaitingForDebugger",
      },
      {
        sessionId: "session-1",
        method: "Page.getFrameTree",
      },
      {
        sessionId: "session-1",
        method: "Page.createIsolatedWorld",
        params: {
          frameId: "frame-1",
          worldName: channel!.worldName,
          grantUniveralAccess: false,
        },
      },
      {
        sessionId: "session-1",
        method: "Runtime.addBinding",
        params: { name: channel!.bindingName, executionContextId: 101 },
      },
      {
        sessionId: "session-1",
        method: "Runtime.addBinding",
        params: { name: channel!.rtcBindingName, executionContextId: 101 },
      },
    ]);
  });

  it("coalesces duplicate injection requests for one flat session", async () => {
    const browser = new RecordingBrowser();
    const target: TargetRef = { targetId: "page-1", sessionId: "session-1", type: "page" };

    await Promise.all([injectAgent(browser, target), injectAgent(browser, target)]);

    expect(browser.calls).toHaveLength(9);
    expect(vi.isMockFunction(browser.send)).toBe(false);
  });

  it("prunes a detached flat session from the browser-lifetime injection map", async () => {
    const browser = new RecordingBrowser();
    const target: TargetRef = { targetId: "frame-1", sessionId: "session-1", type: "iframe" };

    await injectAgent(browser, target);
    browser.detach(target);
    await injectAgent(browser, target);

    expect(browser.calls).toHaveLength(18);
  });

  it("recreates only the isolated binding world after a hard navigation", async () => {
    const browser = new RecordingBrowser();
    const target: TargetRef = { targetId: "page-1", sessionId: "session-1", type: "page" };
    await injectAgent(browser, target);
    const channel = agentBridgeChannel(browser, target.sessionId)!;
    browser.calls.splice(0);

    browser.navigate(target.sessionId);
    await vi.waitFor(() => expect(browser.calls).toHaveLength(3));

    expect(browser.calls).toEqual([
      {
        sessionId: target.sessionId,
        method: "Page.createIsolatedWorld",
        params: {
          frameId: "frame-2",
          worldName: channel.worldName,
          grantUniveralAccess: false,
        },
      },
      {
        sessionId: target.sessionId,
        method: "Runtime.addBinding",
        params: { name: channel.bindingName, executionContextId: 101 },
      },
      {
        sessionId: target.sessionId,
        method: "Runtime.addBinding",
        params: { name: channel.rtcBindingName, executionContextId: 101 },
      },
    ]);
    expect(browser.calls.some((call) => call.method === "Runtime.enable")).toBe(false);
  });
});
