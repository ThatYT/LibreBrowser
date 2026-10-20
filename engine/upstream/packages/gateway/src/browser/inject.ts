/**
 * Browser-agent injection pipeline.
 *
 * On every attached page/iframe target run the D1 attach sequence IN THIS ORDER:
 *   Page.enable -> webdriver safeguard -> isolated bridge + MAIN agent new-document scripts ->
 *   Runtime.runIfWaitingForDebugger -> create isolated worlds and add context-scoped bindings
 * `runImmediately:true` covers attaching to an already-loaded document (first attach after
 * session start).
 *
 * Gotchas: Runtime.bindingCalled fires per execution context — dedupe by msgId. Commands and node
 * handles use Runtime.callFunctionOn against the acquired per-document bridge RemoteObject.
 */
import { createAgentBundle, DEFAULT_AGENT_CONFIG } from "@mirror/agent";

import type { TargetRef } from "../types";
import {
  agentBridgeChannel,
  ensureAgentBridgeChannel,
  isolatedAgentBridgeSource,
  type AgentBridgeChannel,
} from "./bridge";
import type { BrowserHandle } from "./launch";

/** Native AutomationControlled already returns false. This conditional fallback only changes the
 * descriptor if a future Chromium/embedder regresses despite the launch invariant. */
export const WEBDRIVER_NORMALIZER = `(() => {
  const prototype = Navigator.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "webdriver");
  if (navigator.webdriver === false || navigator.webdriver === undefined) return;
  Object.defineProperty(prototype, "webdriver", {
    configurable: descriptor?.configurable ?? true,
    enumerable: descriptor?.enumerable ?? true,
    get: () => false,
  });
})()`;

const injections = new WeakMap<BrowserHandle, Map<string, Promise<void>>>();
const rebindingBrowsers = new WeakSet<BrowserHandle>();

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}

async function bindIsolatedBridgeWorld(
  browser: BrowserHandle,
  sessionId: string,
  frameId: string,
  channel: AgentBridgeChannel,
): Promise<void> {
  const created = (await browser.send(sessionId, "Page.createIsolatedWorld", {
    frameId,
    worldName: channel.worldName,
    grantUniveralAccess: false,
  })) as { executionContextId?: number };
  if (created.executionContextId === undefined) {
    throw new Error(`Could not create recorder bridge world for frame ${frameId}`);
  }
  await browser.send(sessionId, "Runtime.addBinding", {
    name: channel.bindingName,
    executionContextId: created.executionContextId,
  });
  await browser.send(sessionId, "Runtime.addBinding", {
    name: channel.rtcBindingName,
    executionContextId: created.executionContextId,
  });
}

async function bindCurrentFrameTree(
  browser: BrowserHandle,
  sessionId: string,
  channel: AgentBridgeChannel,
): Promise<void> {
  const response = (await browser.send(sessionId, "Page.getFrameTree")) as {
    frameTree?: FrameTree;
  };
  if (response.frameTree === undefined) throw new Error("Page.getFrameTree returned no frame tree");
  const pending = [response.frameTree];
  while (pending.length > 0) {
    const tree = pending.shift()!;
    await bindIsolatedBridgeWorld(browser, sessionId, tree.frame.id, channel);
    pending.push(...(tree.childFrames ?? []));
  }
}

function ensureNavigationRebinding(browser: BrowserHandle): void {
  if (rebindingBrowsers.has(browser)) return;
  rebindingBrowsers.add(browser);
  browser.onSessionEvent("Page.frameNavigated", (sessionId, event) => {
    const channel = agentBridgeChannel(browser, sessionId);
    if (channel === undefined) return;
    // The MAIN agent can safely queue while this page-invisible world is created after commit.
    void bindIsolatedBridgeWorld(browser, sessionId, event.frame.id, channel).catch(
      () => undefined,
    );
  });
}

function injectionsFor(browser: BrowserHandle): Map<string, Promise<void>> {
  let browserInjections = injections.get(browser);
  if (browserInjections !== undefined) return browserInjections;

  const created = new Map<string, Promise<void>>();
  injections.set(browser, created);
  ensureNavigationRebinding(browser);
  browser.onDetached((target) => created.delete(target.sessionId));
  return created;
}

/** Inject once per flat session. Repeated callers share the same ordered attach promise. */
export function injectAgent(browser: BrowserHandle, target: TargetRef): Promise<void> {
  const browserInjections = injectionsFor(browser);

  const existing = browserInjections.get(target.sessionId);
  if (existing !== undefined) return existing;

  const injection = (async () => {
    const channel = ensureAgentBridgeChannel(browser, target.sessionId);
    const source = createAgentBundle({
      canvas: DEFAULT_AGENT_CONFIG.canvas,
      bridge: {
        bindingName: channel.bindingName,
        rtcBindingName: channel.rtcBindingName,
        bridgeKey: channel.bridgeKey,
        outboundEventName: channel.outboundEventName,
        inboundEventName: channel.inboundEventName,
        nodeResponseEventName: channel.nodeResponseEventName,
        readyEventName: channel.readyEventName,
      },
    });
    await browser.send(target.sessionId, "Page.enable");
    await browser.send(target.sessionId, "Page.addScriptToEvaluateOnNewDocument", {
      source: WEBDRIVER_NORMALIZER,
      runImmediately: true,
    });
    await browser.send(target.sessionId, "Page.addScriptToEvaluateOnNewDocument", {
      source: isolatedAgentBridgeSource(channel),
      worldName: channel.worldName,
      runImmediately: true,
    });
    await browser.send(target.sessionId, "Page.addScriptToEvaluateOnNewDocument", {
      source,
      runImmediately: true,
    });
    // Resume before creating the current isolated world: Page.createIsolatedWorld can wait on a
    // debugger-paused OOPIF, while its parent waits for that child to finish loading. The MAIN
    // agent queues safely until the context-scoped bridge becomes ready.
    await browser.send(target.sessionId, "Runtime.runIfWaitingForDebugger");
    // Runtime.bindingCalled does not require Runtime.enable. Scope both native bindings to the
    // isolated bridge context so no CDP binding property is ever installed in MAIN.
    await bindCurrentFrameTree(browser, target.sessionId, channel);
  })();
  browserInjections.set(target.sessionId, injection);
  return injection;
}
