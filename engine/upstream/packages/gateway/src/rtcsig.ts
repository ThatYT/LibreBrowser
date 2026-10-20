/**
 * Authenticated, tab-scoped WebRTC signaling relay.
 *
 * The gateway never parses SDP or ICE. It does attach the authenticated viewer id and a
 * Replayer-generation lane before evaluating the agent receiver, then targets agent responses
 * back to that one viewer. This is required because rrweb 2.1.1 owns one PeerConnection per
 * replay-plugin instance; broadcasting offers or answers would cross-wire multiple viewers.
 */
import type { Down, Up } from "@mirror/protocol";
import type { CdpSend, TargetEvents, TargetRef } from "./types";

export const RTC_SIGNAL_BINDING_NAME = "__mirror_rtc_emit";
export const RTC_SIGNAL_RECEIVER_SYMBOL = "@mirror/agent/rtc-signal";
export const MAX_RTC_SIGNAL_BYTES = 128 * 1024;

type RtcUp = Extract<Up, { t: "rtc-sig" }>;
type RtcDown = Extract<Down, { t: "rtc-sig" }>;

export interface RtcBindingEvent {
  name: string;
  payload: string;
}

export interface RtcSignalRelayOptions {
  send: CdpSend;
  /** Production's page-invisible RemoteObject bridge; unit/legacy harnesses use Runtime.evaluate. */
  callBridge?: (sessionId: string, method: "rtc", args: readonly unknown[]) => Promise<unknown>;
  bindingNameFor?: (sessionId: string) => string | undefined;
  targets: TargetEvents;
  onBindingCalled(cb: (sessionId: string, event: RtcBindingEvent) => void): () => void;
  /** Deliver signaling to one authenticated viewer connection, never through global fanout. */
  sendViewer(viewerId: string, message: RtcDown): boolean | void;
  onError?: (error: unknown) => void;
}

export interface RtcSignalRelay {
  /** Route an authorized viewer WS Up message to the page peer for that tab. */
  handleViewer(viewerId: string, message: RtcUp): Promise<boolean>;
  /** Close every agent peer owned by a disconnected authenticated viewer. */
  removeViewer(viewerId: string): void;
  dispose(): void;
}

interface AgentEnvelope {
  peer: string;
  lane: string;
  payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function serializedSize(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function validViewerPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "close") return true;
  if (value.type === "signal") return isRecord(value.signal);
  if (value.type !== "canvas" && value.type !== "video") return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 0) return false;
  return (
    value.rootId === undefined ||
    (Number.isSafeInteger(value.rootId) && (value.rootId as number) >= 0)
  );
}

function validAgentPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "signal") return isRecord(value.signal);
  return (
    value.type === "video-notice" &&
    (value.notice === "drm" || value.notice === "unavailable") &&
    (value.id === undefined || (Number.isSafeInteger(value.id) && (value.id as number) >= 0))
  );
}

function parseAgentEnvelope(raw: string): AgentEnvelope | null {
  if (Buffer.byteLength(raw) > MAX_RTC_SIGNAL_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !validId(value.peer) || !validId(value.lane)) return null;
  if (!validAgentPayload(value.payload)) return null;
  return { peer: value.peer, lane: value.lane, payload: value.payload };
}

function receiverExpression(peer: string, lane: string, payload: unknown): string {
  const envelope = { peer, lane, payload };
  return `(0,globalThis[Symbol.for(${JSON.stringify(RTC_SIGNAL_RECEIVER_SYMBOL)})])(${JSON.stringify(envelope)})`;
}

export function createRtcSignalRelay(options: RtcSignalRelayOptions): RtcSignalRelay {
  const pageByTab = new Map<string, TargetRef>();
  const tabBySession = new Map<string, string>();
  // A viewer has at most one live Replayer generation per tab.
  const lanesByViewer = new Map<string, Map<string, string>>();
  let disposed = false;

  const report = (error: unknown) => options.onError?.(error);

  const evaluate = (target: TargetRef, peer: string, lane: string, payload: unknown) =>
    options.callBridge === undefined
      ? options.send(target.sessionId, "Runtime.evaluate", {
          expression: receiverExpression(peer, lane, payload),
          awaitPromise: false,
        })
      : options.callBridge(target.sessionId, "rtc", [{ peer, lane, payload }]);

  const closeLane = (viewerId: string, tab: string, lane: string) => {
    const target = pageByTab.get(tab);
    if (target === undefined) return;
    void evaluate(target, viewerId, lane, { type: "close" }).catch(report);
  };

  const removeTabLanes = (tab: string) => {
    for (const [viewerId, lanes] of lanesByViewer) {
      lanes.delete(tab);
      if (lanes.size === 0) lanesByViewer.delete(viewerId);
    }
  };

  options.targets.onAttached((target) => {
    if (disposed || target.type !== "page") return;
    const previous = pageByTab.get(target.targetId);
    if (previous !== undefined && previous.sessionId !== target.sessionId) {
      tabBySession.delete(previous.sessionId);
      removeTabLanes(target.targetId);
    }
    pageByTab.set(target.targetId, target);
    tabBySession.set(target.sessionId, target.targetId);
    // Runtime.addBinding is deliberately owned by injectAgent, before the agent bundle executes.
  });
  options.targets.onDetached((target) => {
    if (pageByTab.get(target.targetId)?.sessionId !== target.sessionId) return;
    pageByTab.delete(target.targetId);
    tabBySession.delete(target.sessionId);
    removeTabLanes(target.targetId);
  });

  const unsubscribe = options.onBindingCalled((sessionId, event) => {
    if (disposed || event.name !== (options.bindingNameFor?.(sessionId) ?? RTC_SIGNAL_BINDING_NAME))
      return;
    const tab = tabBySession.get(sessionId);
    if (tab === undefined) return;
    const envelope = parseAgentEnvelope(event.payload);
    if (envelope === null) return;
    // Only a lane previously opened by this exact authenticated viewer is allowed back out to the
    // viewer connection. Production's randomized binding exists only in the isolated bridge world.
    if (lanesByViewer.get(envelope.peer)?.get(tab) !== envelope.lane) return;
    options.sendViewer(envelope.peer, {
      t: "rtc-sig",
      tab,
      lane: envelope.lane,
      from: "agent",
      payload: envelope.payload,
    });
  });

  const removeViewer = (viewerId: string) => {
    const lanes = lanesByViewer.get(viewerId);
    if (lanes === undefined) return;
    lanesByViewer.delete(viewerId);
    for (const [tab, lane] of lanes) closeLane(viewerId, tab, lane);
  };

  return {
    async handleViewer(viewerId, message) {
      if (disposed || !validId(viewerId) || !validId(message.lane)) return false;
      const size = serializedSize(message.payload);
      if (
        size === undefined ||
        size > MAX_RTC_SIGNAL_BYTES ||
        !validViewerPayload(message.payload)
      ) {
        return false;
      }
      const target = pageByTab.get(message.tab);
      if (target === undefined) return false;

      const lanes = lanesByViewer.get(viewerId) ?? new Map<string, string>();
      const previous = lanes.get(message.tab);
      const payloadType = (message.payload as { type: string }).type;

      // A delayed close or ICE candidate from a disposed Replayer must never replace or close
      // the current generation. Only media discovery is allowed to open a new lane.
      if (payloadType === "close") {
        if (previous !== message.lane) return false;
        lanes.delete(message.tab);
        if (lanes.size === 0) lanesByViewer.delete(viewerId);
        try {
          await evaluate(target, viewerId, message.lane, message.payload);
          return true;
        } catch (error) {
          report(error);
          return false;
        }
      }
      if (previous === undefined && payloadType === "signal") return false;
      if (previous !== undefined && previous !== message.lane) {
        if (payloadType === "signal") return false;
        await evaluate(target, viewerId, previous, { type: "close" }).catch(report);
      }
      lanes.set(message.tab, message.lane);
      lanesByViewer.set(viewerId, lanes);

      try {
        await evaluate(target, viewerId, message.lane, message.payload);
        return true;
      } catch (error) {
        if (lanes.get(message.tab) === message.lane) {
          lanes.delete(message.tab);
          if (lanes.size === 0) lanesByViewer.delete(viewerId);
        }
        report(error);
        return false;
      }
    },
    removeViewer,
    dispose() {
      if (disposed) return;
      for (const viewerId of [...lanesByViewer.keys()]) removeViewer(viewerId);
      disposed = true;
      unsubscribe();
      pageByTab.clear();
      tabBySession.clear();
      lanesByViewer.clear();
    },
  };
}
