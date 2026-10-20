import { describe, expect, it, vi } from "vitest";

import type { CdpSend, TargetRef } from "../types";
import type { FlatSessionEventMap } from "./launch";
import {
  createNavigationController,
  createNavHandler,
  normalizeNavigationUrl,
  type ChromeMsg,
} from "./nav";

interface Call {
  sessionId: string;
  method: string;
  params?: Record<string, unknown>;
}

const history = (currentIndex: number) => ({
  currentIndex,
  entries: [
    { id: 10, url: "https://example.test/a" },
    { id: 20, url: "https://example.test/b" },
    { id: 30, url: "https://example.test/c" },
  ],
});

describe("createNavHandler", () => {
  it("normalizes URL input and maps go/reload onto the resolved flat session", async () => {
    const calls: Call[] = [];
    const send: CdpSend = async (sessionId, method, params) => {
      calls.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
      return {};
    };
    const handle = createNavHandler(send, (tab) => (tab === "tab-1" ? "session-1" : undefined));

    await handle({ t: "nav", tab: "tab-1", action: "go", url: " example.test/path " });
    await handle({ t: "nav", tab: "tab-1", action: "reload" });

    expect(calls).toEqual([
      {
        sessionId: "session-1",
        method: "Page.navigate",
        params: { url: "https://example.test/path" },
      },
      { sessionId: "session-1", method: "Page.reload" },
    ]);
    expect(normalizeNavigationUrl("http://plain.test/")).toBe("http://plain.test/");
    expect(normalizeNavigationUrl("//scheme-relative.test/x")).toBe(
      "https://scheme-relative.test/x",
    );
  });

  it("uses history entries for back/fwd and does nothing at history boundaries", async () => {
    const calls: Call[] = [];
    let currentIndex = 1;
    const send: CdpSend = async (sessionId, method, params) => {
      calls.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
      return method === "Page.getNavigationHistory" ? history(currentIndex) : {};
    };
    const handle = createNavHandler(send);

    await handle({ t: "nav", tab: "session-1", action: "back" });
    await handle({ t: "nav", tab: "session-1", action: "fwd" });
    currentIndex = 0;
    await handle({ t: "nav", tab: "session-1", action: "back" });
    currentIndex = 2;
    await handle({ t: "nav", tab: "session-1", action: "fwd" });

    expect(calls.filter(({ method }) => method === "Page.navigateToHistoryEntry")).toEqual([
      {
        sessionId: "session-1",
        method: "Page.navigateToHistoryEntry",
        params: { entryId: 10 },
      },
      {
        sessionId: "session-1",
        method: "Page.navigateToHistoryEntry",
        params: { entryId: 30 },
      },
    ]);
  });

  it("rejects missing URLs, unknown tabs, navigation errors, and future tab actions", async () => {
    const send = vi.fn<CdpSend>(async () => ({ errorText: "net::ERR_INVALID_URL" }));
    const handle = createNavHandler(send, (tab) => (tab === "known" ? "session" : undefined));

    await expect(handle({ t: "nav", tab: "known", action: "go" })).rejects.toThrow(
      "navigation URL is required",
    );
    await expect(
      handle({ t: "nav", tab: "known", action: "go", url: "https://bad.test" }),
    ).rejects.toThrow("Page.navigate failed");
    await expect(handle({ t: "nav", tab: "missing", action: "reload" })).rejects.toThrow(
      "unknown navigation tab",
    );
    await expect(handle({ t: "nav", tab: "known", action: "newtab" })).rejects.toThrow(
      "not implemented by P1-NAV-G",
    );
  });
});

type EventCallback<K extends keyof FlatSessionEventMap> = (
  sessionId: string,
  event: FlatSessionEventMap[K],
) => void;

class MockBrowser {
  readonly calls: Call[] = [];
  readonly attachedCallbacks: ((target: TargetRef) => void)[] = [];
  readonly detachedCallbacks: ((target: TargetRef) => void)[] = [];
  readonly eventCallbacks = new Map<
    keyof FlatSessionEventMap,
    Set<(sessionId: string, event: unknown) => void>
  >();
  currentHistory = history(0);

  readonly send: CdpSend = async (sessionId, method, params) => {
    this.calls.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-frame", url: "https://example.test/a" } } };
    }
    if (method === "Page.getNavigationHistory") return this.currentHistory;
    return {};
  };

  onAttached(callback: (target: TargetRef) => void): void {
    this.attachedCallbacks.push(callback);
  }

  onDetached(callback: (target: TargetRef) => void): void {
    this.detachedCallbacks.push(callback);
  }

  onSessionEvent<K extends keyof FlatSessionEventMap>(
    method: K,
    callback: EventCallback<K>,
  ): () => void {
    const callbacks = this.eventCallbacks.get(method) ?? new Set();
    const erased = callback as (sessionId: string, event: unknown) => void;
    callbacks.add(erased);
    this.eventCallbacks.set(method, callbacks);
    return () => callbacks.delete(erased);
  }

  attach(target: TargetRef): void {
    for (const callback of this.attachedCallbacks) callback(target);
  }

  detach(target: TargetRef): void {
    for (const callback of this.detachedCallbacks) callback(target);
  }

  emit<K extends keyof FlatSessionEventMap>(
    method: K,
    sessionId: string,
    event: FlatSessionEventMap[K],
  ): void {
    for (const callback of this.eventCallbacks.get(method) ?? []) callback(sessionId, event);
  }
}

async function waitForMessages(messages: ChromeMsg[], count: number): Promise<void> {
  await vi.waitFor(() => expect(messages).toHaveLength(count));
}

describe("createNavigationController", () => {
  it("emits redirect and SPA chrome updates with live history flags and loading state", async () => {
    const browser = new MockBrowser();
    const messages: ChromeMsg[] = [];
    const controller = createNavigationController(browser, (message) => messages.push(message));
    const page = { targetId: "tab-1", sessionId: "session-1", type: "page" as const };
    browser.attach(page);
    await waitForMessages(messages, 1);

    browser.currentHistory = history(1);
    browser.emit("Page.frameNavigated", "session-1", {
      frame: {
        id: "main-frame",
        loaderId: "loader-1",
        url: "https://example.test/redirected",
        domainAndRegistry: "example.test",
        securityOrigin: "https://example.test",
        mimeType: "text/html",
        secureContextType: "Secure",
        crossOriginIsolatedContextType: "NotIsolated",
        gatedAPIFeatures: [],
      },
      type: "Navigation",
    });
    await waitForMessages(messages, 2);
    expect(messages.at(-1)).toEqual({
      t: "chrome",
      tab: "tab-1",
      url: "https://example.test/redirected",
      loading: true,
      canBack: true,
      canFwd: true,
    });

    browser.currentHistory = history(2);
    const callsBeforeSpa = browser.calls.length;
    browser.emit("Page.navigatedWithinDocument", "session-1", {
      frameId: "main-frame",
      url: "https://example.test/spa-route",
      navigationType: "historyApi",
    });
    await waitForMessages(messages, 3);
    expect(messages.at(-1)).toEqual({
      t: "chrome",
      tab: "tab-1",
      url: "https://example.test/spa-route",
      loading: true,
      canBack: true,
      canFwd: false,
    });
    expect(browser.calls.slice(callsBeforeSpa).map(({ method }) => method)).toEqual([
      "Page.getNavigationHistory",
    ]);

    browser.emit("Page.lifecycleEvent", "session-1", {
      frameId: "main-frame",
      loaderId: "loader-1",
      name: "load",
      timestamp: 1,
    });
    await waitForMessages(messages, 4);
    expect(messages.at(-1)?.loading).toBe(false);

    controller.dispose();
  });

  it("ignores subframe events and removes target/session routing on detach", async () => {
    const browser = new MockBrowser();
    const messages: ChromeMsg[] = [];
    const controller = createNavigationController(browser, (message) => messages.push(message));
    const page = { targetId: "tab-1", sessionId: "session-1", type: "page" as const };
    browser.attach(page);
    await waitForMessages(messages, 1);

    browser.emit("Page.navigatedWithinDocument", "session-1", {
      frameId: "child-frame",
      url: "https://frame.test/ignored",
      navigationType: "historyApi",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toHaveLength(1);

    browser.detach(page);
    await expect(controller.handle({ t: "nav", tab: "tab-1", action: "reload" })).rejects.toThrow(
      "unknown navigation tab",
    );
    controller.dispose();
  });
});
