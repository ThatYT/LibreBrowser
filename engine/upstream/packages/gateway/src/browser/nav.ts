/**
 * Gateway navigation controls.
 * (Viewer half P1-NAV-V = viewer/src/chrome/urlbar.tsx, viewer domain. Split at the wire.)
 *
 * Map `nav` Up msgs -> Page.navigate / getNavigationHistory + navigateToHistoryEntry /
 * Page.reload; emit `chrome` Down msgs from Page.frameNavigated / navigatedWithinDocument /
 * lifecycleEvent (loading spinner). navigatedWithinDocument (SPA routing) updates the bar
 * WITHOUT an epoch bump. Normalize user input (add scheme).
 */
import type { Down, Up } from "@mirror/protocol";
import type { Protocol } from "puppeteer-core";

import type { CdpSend, TargetRef } from "../types";
import type { BrowserHandle } from "./launch";

type NavMsg = Extract<Up, { t: "nav" }>;
export type ChromeMsg = Extract<Down, { t: "chrome" }>;

type SessionResolver = (tabId: string) => string | undefined;

interface HistoryEntry {
  id: number;
  url: string;
}

interface NavigationHistory {
  currentIndex: number;
  entries: HistoryEntry[];
}

interface FrameTreeResult {
  frameTree?: { frame?: { id?: unknown; url?: unknown; urlFragment?: unknown } };
}

interface PageState {
  target: TargetRef;
  mainFrameId?: string;
  url: string;
  loading: boolean;
  canBack: boolean;
  canFwd: boolean;
  queue: Promise<void>;
}

export interface NavigationController {
  handle(msg: NavMsg): Promise<void>;
  dispose(): void;
}

/** Add a default scheme without turning the private URL bar into a search or policy layer. */
export function normalizeNavigationUrl(input: string): string {
  const url = input.trim();
  if (url === "") throw new Error("navigation URL is required");
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) {
    const parsed = new URL(url);
    if (!["http:", "https:", "file:", "data:"].includes(parsed.protocol) && url !== "about:blank") throw new Error("Unsupported navigation scheme");
    return url;
  }
  if (url.startsWith("//")) return `https:${url}`;
  return `https://${url}`;
}

function navigationHistory(value: unknown): NavigationHistory {
  if (typeof value !== "object" || value === null) {
    throw new Error("Page.getNavigationHistory returned no result");
  }
  const result = value as { currentIndex?: unknown; entries?: unknown };
  if (!Number.isInteger(result.currentIndex) || !Array.isArray(result.entries)) {
    throw new Error("Page.getNavigationHistory returned an invalid history");
  }
  const entries = result.entries.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Page.getNavigationHistory returned an invalid entry");
    }
    const candidate = entry as { id?: unknown; url?: unknown };
    if (!Number.isInteger(candidate.id) || typeof candidate.url !== "string") {
      throw new Error("Page.getNavigationHistory returned an invalid entry");
    }
    return { id: candidate.id as number, url: candidate.url };
  });
  const currentIndex = result.currentIndex as number;
  if (currentIndex < 0 || currentIndex >= entries.length) {
    throw new Error("Page.getNavigationHistory returned an invalid current index");
  }
  return { currentIndex, entries };
}

async function navigateHistory(send: CdpSend, sessionId: string, offset: -1 | 1): Promise<void> {
  const history = navigationHistory(await send(sessionId, "Page.getNavigationHistory"));
  const entry = history.entries[history.currentIndex + offset];
  if (entry === undefined) return;
  await send(sessionId, "Page.navigateToHistoryEntry", { entryId: entry.id });
}

export function createNavHandler(
  send: CdpSend,
  resolveSession: SessionResolver = (tabId) => tabId,
): (msg: NavMsg) => Promise<void> {
  return async (msg) => {
    const sessionId = resolveSession(msg.tab);
    if (sessionId === undefined) throw new Error(`unknown navigation tab ${msg.tab}`);

    switch (msg.action) {
      case "go": {
        const result = (await send(sessionId, "Page.navigate", {
          url: normalizeNavigationUrl(msg.url ?? ""),
        })) as { errorText?: unknown } | undefined;
        if (typeof result?.errorText === "string" && result.errorText !== "") {
          throw new Error(`Page.navigate failed: ${result.errorText}`);
        }
        return;
      }
      case "back":
        await navigateHistory(send, sessionId, -1);
        return;
      case "fwd":
        await navigateHistory(send, sessionId, 1);
        return;
      case "reload":
        await send(sessionId, "Page.reload");
        return;
      case "newtab":
      case "close":
      case "activate":
        // These actions belong to P2-TABS-G. Keeping them out of Page navigation prevents this
        // path from guessing at target-lifecycle behavior before browser bookkeeping completes.
        throw new Error(`navigation action ${msg.action} is not implemented by P1-NAV-G`);
    }
  };
}

function frameUrl(frame: Protocol.Page.Frame): string {
  return `${frame.url}${frame.urlFragment ?? ""}`;
}

/**
 * Owns the targetId -> flat-session mapping and the Page event lane for navigation chrome.
 * Same-document navigation only changes URL/history state and emits `chrome`; it deliberately
 * has no AgentLink/TabHub dependency, so an SPA pushState cannot bump epoch or request snapshot.
 */
export function createNavigationController(
  browser: Pick<BrowserHandle, "send" | "onAttached" | "onDetached" | "onSessionEvent">,
  emit: (msg: ChromeMsg) => void,
): NavigationController {
  const pagesByTab = new Map<string, PageState>();
  const pagesBySession = new Map<string, PageState>();
  const unsubscribers: (() => void)[] = [];
  let disposed = false;

  const emitState = (state: PageState): void => {
    if (disposed) return;
    emit({
      t: "chrome",
      tab: state.target.targetId,
      url: state.url,
      loading: state.loading,
      canBack: state.canBack,
      canFwd: state.canFwd,
    });
  };

  const refreshHistory = async (state: PageState, useHistoryUrl = false): Promise<void> => {
    const history = navigationHistory(
      await browser.send(state.target.sessionId, "Page.getNavigationHistory"),
    );
    state.canBack = history.currentIndex > 0;
    state.canFwd = history.currentIndex + 1 < history.entries.length;
    if (useHistoryUrl) state.url = history.entries[history.currentIndex]?.url ?? state.url;
  };

  const enqueue = (state: PageState, task: () => Promise<void>): void => {
    state.queue = state.queue
      .then(async () => {
        if (disposed || pagesBySession.get(state.target.sessionId) !== state) return;
        await task();
      })
      // A target can disappear between notification and history lookup. Chrome updates are
      // best-effort event delivery; command handling still propagates its errors to the caller.
      .catch(() => undefined);
  };

  unsubscribers.push(
    browser.onSessionEvent("Page.frameNavigated", (sessionId, event) => {
      const state = pagesBySession.get(sessionId);
      if (state === undefined || event.frame.parentId !== undefined) return;
      enqueue(state, async () => {
        state.mainFrameId = event.frame.id;
        state.url = frameUrl(event.frame);
        state.loading = true;
        await refreshHistory(state).catch(() => undefined);
        emitState(state);
      });
    }),
    browser.onSessionEvent("Page.navigatedWithinDocument", (sessionId, event) => {
      const state = pagesBySession.get(sessionId);
      if (state === undefined) return;
      enqueue(state, async () => {
        // Check inside the per-page queue: frameNavigated/getFrameTree immediately before this
        // event may be the operation that discovers the main-frame id.
        if (event.frameId !== state.mainFrameId) return;
        state.url = event.url;
        await refreshHistory(state).catch(() => undefined);
        emitState(state);
      });
    }),
    browser.onSessionEvent("Page.lifecycleEvent", (sessionId, event) => {
      const state = pagesBySession.get(sessionId);
      if (state === undefined || (event.name !== "init" && event.name !== "load")) {
        return;
      }
      enqueue(state, async () => {
        if (event.frameId !== state.mainFrameId) return;
        state.loading = event.name === "init";
        await refreshHistory(state).catch(() => undefined);
        emitState(state);
      });
    }),
  );

  browser.onDetached((target) => {
    const state = pagesByTab.get(target.targetId);
    if (state?.target.sessionId !== target.sessionId) return;
    pagesByTab.delete(target.targetId);
    pagesBySession.delete(target.sessionId);
  });

  browser.onAttached((target) => {
    if (disposed || target.type !== "page") return;
    const previous = pagesByTab.get(target.targetId);
    if (previous !== undefined) pagesBySession.delete(previous.target.sessionId);

    const state: PageState = {
      target,
      url: "",
      loading: false,
      canBack: false,
      canFwd: false,
      queue: Promise.resolve(),
    };
    pagesByTab.set(target.targetId, state);
    pagesBySession.set(target.sessionId, state);
    enqueue(state, async () => {
      await browser.send(target.sessionId, "Page.enable");
      await browser.send(target.sessionId, "Page.setLifecycleEventsEnabled", { enabled: true });
      const result = (await browser.send(target.sessionId, "Page.getFrameTree")) as FrameTreeResult;
      const frame = result.frameTree?.frame;
      if (typeof frame?.id === "string") state.mainFrameId = frame.id;
      if (typeof frame?.url === "string") {
        state.url = `${frame.url}${typeof frame.urlFragment === "string" ? frame.urlFragment : ""}`;
      }
      await refreshHistory(state, state.url === "").catch(() => undefined);
      emitState(state);
    });
  });

  const handle = createNavHandler(browser.send, (tabId) => pagesByTab.get(tabId)?.target.sessionId);
  return {
    handle,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      pagesByTab.clear();
      pagesBySession.clear();
    },
  };
}
