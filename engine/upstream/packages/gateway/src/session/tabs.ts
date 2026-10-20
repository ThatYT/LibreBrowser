/**
 * Gateway multi-tab lifecycle.
 * (Viewer half P2-TABS-V = viewer/src/chrome/tabstrip.tsx, viewer domain.)
 *
 * A tab is a top-level `page` target. Every attached page owns a TabHub and continuously
 * ingests its agent stream, including while it is in the background. Only the activated tab's
 * live hub output is published; activation publishes its canonical join payload first.
 */
import type { AgentLink } from "../types";
import type { Down, Up } from "@mirror/protocol";

import { sealAssetToken } from "../assets/token";
import { createRewriteStage } from "../assets/rewrite";
import { TabHub, type RewriteStage } from "../hub/tabhub";
import type { TargetRef } from "../types";
import type { BrowserHandle, BrowserTargetInfo } from "../browser/launch";

type TabNavMsg = Extract<Up, { t: "nav" }>;
type TabsMsg = Extract<Down, { t: "tabs" }>;

type TabBrowser = Pick<
  BrowserHandle,
  "send" | "sendBrowser" | "onAttached" | "onDetached" | "onTargetInfoChanged"
>;

export interface TabLifecycleOpts {
  browser: TabBrowser;
  agentLink: AgentLink;
  sessionId: string;
  assetTokenKey: Buffer;
  publish(msg: Down): void;
  rewrite?: RewriteStage;
  debounceMs?: number;
  createHub?: (target: TargetRef) => TabHub;
  onError?: (error: unknown) => void;
}

export interface TabLifecycle {
  readonly activeTabId: string | undefined;
  readonly size: number;
  hubs(): IterableIterator<TabHub>;
  hubFor(tabId: string): TabHub | undefined;
  /** Current metadata for a newly connected viewer; lifecycle changes still publish globally. */
  tabsMessage(): Promise<TabsMsg>;
  handle(msg: TabNavMsg): Promise<void>;
  dispose(): void;
}

interface EvaluationResult {
  result?: { value?: unknown };
}

interface TabState {
  target: TargetRef;
  hub: TabHub;
}

const FAVICON_EXPRESSION = `(() => {
  const icon = document.querySelector('link[rel~="icon" i]');
  return icon instanceof HTMLLinkElement && icon.href
    ? icon.href
    : new URL('/favicon.ico', location.href).href;
})()`;

export function createTabLifecycle(opts: TabLifecycleOpts): TabLifecycle {
  const debounceMs = opts.debounceMs ?? 75;
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0) {
    throw new RangeError("debounceMs must be a non-negative safe integer");
  }
  if (!Buffer.isBuffer(opts.assetTokenKey) || opts.assetTokenKey.length !== 32) {
    throw new TypeError("Asset token key must be a 32-byte Buffer");
  }
  const assetTokenKey = Buffer.from(opts.assetTokenKey);
  const tabs = new Map<string, TabState>();
  const targetInfo = new Map<string, BrowserTargetInfo>();
  const order: string[] = [];
  let activeTabId: string | undefined;
  let disposed = false;
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  let broadcastVersion = 0;

  const report = (error: unknown): void => opts.onError?.(error);
  const sendBrowser = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (opts.browser.sendBrowser === undefined) {
      return Promise.reject(new Error(`browser/root CDP command unavailable: ${method}`));
    }
    return opts.browser.sendBrowser(method, params);
  };

  const faviconFor = async (tabId: string, state: TabState): Promise<string | undefined> => {
    const info = targetInfo.get(tabId);
    let faviconUrl: string | undefined;
    try {
      const evaluated = (await opts.browser.send(state.target.sessionId, "Runtime.evaluate", {
        expression: FAVICON_EXPRESSION,
        returnByValue: true,
      })) as EvaluationResult;
      if (typeof evaluated.result?.value === "string") faviconUrl = evaluated.result.value;
    } catch {
      // A navigation can replace the execution context during the lookup. The target URL gives
      // a useful conventional fallback and the next info event schedules another lookup.
    }
    if (faviconUrl === undefined && info !== undefined) {
      try {
        faviconUrl = new URL("/favicon.ico", info.url).href;
      } catch {
        return undefined;
      }
    }
    if (faviconUrl === undefined || !/^https?:/i.test(faviconUrl)) return undefined;
    const token = sealAssetToken(
      { url: faviconUrl, sessionId: opts.sessionId, tabId },
      assetTokenKey,
    );
    return `/s/${encodeURIComponent(opts.sessionId)}/a/${token}`;
  };

  const tabsMessage = async (): Promise<TabsMsg> => {
    if (tabs.size === 0) await create(undefined);
    const metadata = await Promise.all(
      order.flatMap((tabId) => {
        const state = tabs.get(tabId);
        if (state === undefined) return [];
        return [
          (async () => {
            const info = targetInfo.get(tabId);
            const favicon = await faviconFor(tabId, state);
            return {
              id: tabId,
              url: info?.url ?? "",
              title: info?.title ?? "",
              ...(favicon === undefined ? {} : { favicon }),
              active: tabId === activeTabId,
            };
          })(),
        ];
      }),
    );
    return { t: "tabs", tabs: metadata };
  };

  const publishTabs = async (version: number): Promise<void> => {
    const message = await tabsMessage();
    if (disposed || version !== broadcastVersion) return;
    opts.publish(message);
  };

  const scheduleTabsBroadcast = (): void => {
    if (disposed) return;
    const version = ++broadcastVersion;
    if (broadcastTimer !== undefined) clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      void publishTabs(version).catch(report);
    }, debounceMs);
    broadcastTimer.unref?.();
  };

  const publishCatchUp = (state: TabState): void => {
    for (const down of state.hub.joinPayload()) opts.publish(down);
  };

  const activate = async (tabId: string): Promise<void> => {
    const state = tabs.get(tabId);
    if (state === undefined) throw new Error(`unknown tab ${tabId}`);
    await sendBrowser("Target.activateTarget", { targetId: tabId });
    if (disposed || tabs.get(tabId) !== state) return;
    const changed = activeTabId !== tabId;
    activeTabId = tabId;
    scheduleTabsBroadcast();
    if (changed) publishCatchUp(state);
  };

  const remove = (tabId: string): { wasActive: boolean; neighbor?: string } => {
    const index = order.indexOf(tabId);
    const wasActive = activeTabId === tabId;
    tabs.delete(tabId);
    targetInfo.delete(tabId);
    if (index >= 0) order.splice(index, 1);
    const neighbor = wasActive ? (order[index] ?? order[index - 1]) : undefined;
    if (wasActive) activeTabId = undefined;
    scheduleTabsBroadcast();
    return { wasActive, ...(neighbor === undefined ? {} : { neighbor }) };
  };

  const close = async (tabId: string): Promise<void> => {
    if (!tabs.has(tabId)) throw new Error(`unknown tab ${tabId}`);
    if (tabs.size === 1) await create(undefined);
    const result = (await sendBrowser("Target.closeTarget", { targetId: tabId })) as
      { success?: unknown } | undefined;
    if (result?.success === false) throw new Error(`Target.closeTarget rejected tab ${tabId}`);
    const { neighbor } = remove(tabId);
    if (neighbor !== undefined) await activate(neighbor);
  };

  const create = async (url: string | undefined): Promise<void> => {
    const result = (await sendBrowser("Target.createTarget", {
      url: url === undefined || url.trim() === "" ? "about:blank" : url,
    })) as { targetId?: unknown } | undefined;
    if (typeof result?.targetId !== "string") {
      throw new Error("Target.createTarget returned no targetId");
    }
    await sendBrowser("Target.activateTarget", { targetId: result.targetId });
    activeTabId = result.targetId;
    scheduleTabsBroadcast();
  };

  opts.browser.onTargetInfoChanged((info) => {
    if (disposed) return;
    targetInfo.set(info.targetId, info);
    if (tabs.has(info.targetId)) scheduleTabsBroadcast();
  });

  opts.browser.onDetached((target) => {
    if (disposed) return;
    if (target.type !== "page") {
      targetInfo.delete(target.targetId);
      return;
    }
    const state = tabs.get(target.targetId);
    if (state?.target.sessionId !== target.sessionId) return;
    const { neighbor } = remove(target.targetId);
    if (tabs.size === 0) void create(undefined).catch(report);
    if (neighbor !== undefined) void activate(neighbor).catch(report);
  });

  opts.browser.onAttached((target) => {
    if (disposed || target.type !== "page") return;
    const previous = tabs.get(target.targetId);
    if (previous?.target.sessionId === target.sessionId) return;
    if (previous !== undefined) tabs.delete(target.targetId);

    const hub =
      opts.createHub?.(target) ??
      new TabHub({
        sessionId: opts.sessionId,
        tabId: target.targetId,
        // Asset isolation is part of constructing a browser tab, not optional wiring in
        // an entrypoint. Each tab also owns its rewriter's document URL lifetime.
        rewrite: opts.rewrite ?? createRewriteStage(assetTokenKey),
      });
    const state = { target, hub };
    tabs.set(target.targetId, state);
    if (!order.includes(target.targetId)) order.push(target.targetId);
    activeTabId ??= target.targetId;
    hub.onNeedSnapshot(() =>
      opts.agentLink.sendCmd(target.targetId, { cmd: "snapshot" }).then((result) => {
        if (!result.ok) throw new Error(result.err ?? "snapshot command failed");
      }),
    );
    scheduleTabsBroadcast();

    void (async () => {
      try {
        for await (const msg of opts.agentLink.msgs(target.targetId)) {
          if (disposed || tabs.get(target.targetId) !== state) return;
          for (const down of hub.ingest(msg)) {
            if (activeTabId === target.targetId && hub.mode === "dom") opts.publish(down);
          }
        }
      } catch (error) {
        if (!disposed && tabs.get(target.targetId) === state) report(error);
      }
    })();
  });

  return {
    get activeTabId() {
      return activeTabId;
    },
    get size() {
      return tabs.size;
    },
    *hubs() {
      for (const { hub } of tabs.values()) yield hub;
    },
    hubFor(tabId) {
      return tabs.get(tabId)?.hub;
    },
    tabsMessage,
    async handle(msg) {
      switch (msg.action) {
        case "newtab":
          await create(msg.url);
          return;
        case "close":
          await close(msg.tab);
          return;
        case "activate":
          await activate(msg.tab);
          return;
        case "go":
        case "back":
        case "fwd":
        case "reload":
          throw new Error(`navigation action ${msg.action} belongs to P1-NAV-G`);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      broadcastVersion += 1;
      if (broadcastTimer !== undefined) clearTimeout(broadcastTimer);
      broadcastTimer = undefined;
      tabs.clear();
      targetInfo.clear();
      order.splice(0);
      activeTabId = undefined;
    },
  };
}
