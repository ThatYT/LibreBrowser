import { randomBytes } from "node:crypto";

import type { Protocol } from "puppeteer-core";

import type { BrowserHandle } from "./launch";

export type AgentBridgeMethod = "command" | "node" | "rtc";

export interface AgentBridgeChannel {
  readonly bindingName: string;
  readonly rtcBindingName: string;
  readonly bridgeKey: string;
  readonly worldName: string;
  readonly outboundEventName: string;
  readonly inboundEventName: string;
  readonly nodeResponseEventName: string;
  readonly readyEventName: string;
  objectId?: string;
  executionContextId?: number;
}

const channels = new WeakMap<BrowserHandle, Map<string, AgentBridgeChannel>>();
const watched = new WeakSet<BrowserHandle>();

function randomPrivateName(): string {
  return `_${randomBytes(16).toString("hex")}`;
}

function channelsFor(browser: BrowserHandle): Map<string, AgentBridgeChannel> {
  let browserChannels = channels.get(browser);
  if (browserChannels === undefined) {
    browserChannels = new Map();
    channels.set(browser, browserChannels);
  }
  if (!watched.has(browser)) {
    watched.add(browser);
    browser.onDetached((target) => {
      const channel = browserChannels?.get(target.sessionId);
      browserChannels?.delete(target.sessionId);
      if (channel?.objectId !== undefined) {
        void browser
          .send(target.sessionId, "Runtime.releaseObject", { objectId: channel.objectId })
          .catch(() => undefined);
      }
    });
  }
  return browserChannels;
}

export function ensureAgentBridgeChannel(
  browser: BrowserHandle,
  sessionId: string,
): AgentBridgeChannel {
  const browserChannels = channelsFor(browser);
  let channel = browserChannels.get(sessionId);
  if (channel !== undefined) return channel;
  channel = {
    bindingName: randomPrivateName(),
    rtcBindingName: randomPrivateName(),
    bridgeKey: randomPrivateName(),
    worldName: randomPrivateName(),
    outboundEventName: randomPrivateName(),
    inboundEventName: randomPrivateName(),
    nodeResponseEventName: randomPrivateName(),
    readyEventName: randomPrivateName(),
  };
  browserChannels.set(sessionId, channel);
  return channel;
}

export function agentBridgeChannel(
  browser: BrowserHandle,
  sessionId: string,
): AgentBridgeChannel | undefined {
  return channels.get(browser)?.get(sessionId);
}

export function isolatedAgentBridgeSource(channel: AgentBridgeChannel): string {
  return `(() => {
    const bindingName = ${JSON.stringify(channel.bindingName)};
    const rtcBindingName = ${JSON.stringify(channel.rtcBindingName)};
    const bridgeKey = ${JSON.stringify(channel.bridgeKey)};
    const outboundEventName = ${JSON.stringify(channel.outboundEventName)};
    const inboundEventName = ${JSON.stringify(channel.inboundEventName)};
    const nodeResponseEventName = ${JSON.stringify(channel.nodeResponseEventName)};
    const readyEventName = ${JSON.stringify(channel.readyEventName)};
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
    const NativeCustomEvent = CustomEvent;
    const parse = JSON.parse;
    const stringify = JSON.stringify;
    let emitBinding;
    let rtcBinding;
    let nodeResult;
    let readyTimer;

    nativeAddEventListener.call(document, outboundEventName, (event) => {
      if (typeof event.detail !== "string") return;
      let envelope;
      try { envelope = parse(event.detail); } catch { return; }
      if (typeof envelope !== "object" || envelope === null ||
          typeof envelope.payload !== "string") return;
      const binding = envelope.lane === "agent" ? emitBinding :
        envelope.lane === "rtc" ? rtcBinding : undefined;
      if (typeof binding !== "function") return;
      if (readyTimer !== undefined) {
        clearInterval(readyTimer);
        readyTimer = undefined;
      }
      binding(envelope.payload);
    });
    nativeAddEventListener.call(document, nodeResponseEventName, (event) => {
      nodeResult = event.target;
    }, true);

    Object.defineProperty(globalThis, bridgeKey, {
      configurable: true,
      value: Object.freeze({
        command(value) {
          nativeDispatchEvent.call(document, new NativeCustomEvent(inboundEventName, {
            detail: stringify({ method: "command", args: [value] }),
          }));
        },
        node(nodeId) {
          nodeResult = undefined;
          nativeDispatchEvent.call(document, new NativeCustomEvent(inboundEventName, {
            detail: stringify({ method: "node", args: [nodeId] }),
          }));
          return nodeResult;
        },
        rtc(value) {
          nativeDispatchEvent.call(document, new NativeCustomEvent(inboundEventName, {
            detail: stringify({ method: "rtc", args: [value] }),
          }));
        },
      }),
    });

    const announceReady = () => {
      emitBinding = typeof globalThis[bindingName] === "function"
        ? globalThis[bindingName] : emitBinding;
      rtcBinding = typeof globalThis[rtcBindingName] === "function"
        ? globalThis[rtcBindingName] : rtcBinding;
      if (typeof emitBinding !== "function" || typeof rtcBinding !== "function") return;
      nativeDispatchEvent.call(document, new NativeCustomEvent(readyEventName));
    };
    readyTimer = setInterval(announceReady, 50);
    announceReady();
  })()`;
}

function acquisitionExpression(channel: AgentBridgeChannel): string {
  return `(() => {
    const bridgeKey = ${JSON.stringify(channel.bridgeKey)};
    const bridge = globalThis[bridgeKey];
    if (bridge === undefined) throw new Error("recorder bridge unavailable");
    try { delete globalThis[bridgeKey]; } catch {}
    return bridge;
  })()`;
}

interface RuntimeRemoteResult {
  result?: Protocol.Runtime.RemoteObject;
  exceptionDetails?: Protocol.Runtime.ExceptionDetails;
}

/**
 * Capture the isolated world's short-lived bridge as a DevTools RemoteObject and remove its global
 * property. Non-canonical same-process frame bridges are acquired only long enough to perform the
 * same cleanup, then released. No binding or bridge property is installed in the page's MAIN world.
 */
export async function acquireAgentBridge(
  browser: BrowserHandle,
  sessionId: string,
  executionContextId: number,
  retain: boolean,
): Promise<string> {
  const channel = ensureAgentBridgeChannel(browser, sessionId);
  const evaluated = (await browser.send(sessionId, "Runtime.evaluate", {
    expression: acquisitionExpression(channel),
    contextId: executionContextId,
    returnByValue: false,
    silent: true,
  })) as RuntimeRemoteResult;
  const objectId = evaluated.result?.objectId;
  if (evaluated.exceptionDetails !== undefined || objectId === undefined) {
    throw new Error(`Could not acquire recorder bridge for CDP session ${sessionId}`);
  }

  if (!retain) {
    await browser.send(sessionId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    return objectId;
  }

  const previousObjectId = channel.objectId;
  channel.objectId = objectId;
  channel.executionContextId = executionContextId;
  if (previousObjectId !== undefined && previousObjectId !== objectId) {
    await browser
      .send(sessionId, "Runtime.releaseObject", { objectId: previousObjectId })
      .catch(() => undefined);
  }
  return objectId;
}

export async function callAgentBridge(
  browser: BrowserHandle,
  sessionId: string,
  method: AgentBridgeMethod,
  args: readonly unknown[],
  options: { returnByValue?: boolean } = {},
): Promise<unknown> {
  const channel = agentBridgeChannel(browser, sessionId);
  if (channel?.objectId === undefined) {
    throw new Error(`Recorder bridge for CDP session ${sessionId} is not ready`);
  }
  return browser.send(sessionId, "Runtime.callFunctionOn", {
    objectId: channel.objectId,
    functionDeclaration: `function(method, args) { return this[method](...args); }`,
    arguments: [{ value: method }, { value: args }],
    awaitPromise: false,
    returnByValue: options.returnByValue ?? false,
    silent: true,
  });
}
