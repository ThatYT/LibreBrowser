/** Agent-side adapter for rrweb's canvas WebRTC record plugin. */
import { RRWebPluginCanvasWebRTCRecord } from "@rrweb/rrweb-plugin-canvas-webrtc-record";

export const RTC_SIGNAL_BINDING_NAME = "__mirror_rtc_emit";
export const RTC_SIGNAL_RECEIVER_KEY = Symbol.for("@mirror/agent/rtc-signal");

export interface CapturedRtcConstructors {
  RTCPeerConnection: typeof RTCPeerConnection | undefined;
  RTCSessionDescription: typeof RTCSessionDescription | undefined;
  RTCIceCandidate: typeof RTCIceCandidate | undefined;
}

interface MediaRequest {
  type: "canvas" | "video";
  id: number;
  rootId?: number;
}

interface SignalMessage {
  type: "signal";
  signal: RTCSessionDescriptionInit;
}

interface CloseMessage {
  type: "close";
}

type RtcMessage = MediaRequest | SignalMessage | CloseMessage;

interface ScopedRtcMessage {
  peer: string;
  lane: string;
  payload: RtcMessage;
}

interface DestroyablePeer {
  destroy(error?: Error): void;
}

interface RecordMirrors {
  nodeMirror: { getNode(id: number): Node | null };
  [key: string]: unknown;
}

type InitializedRecordPlugin = ReturnType<RRWebPluginCanvasWebRTCRecord["initPlugin"]>;

interface RecordPluginAdapter {
  initPlugin(): InitializedRecordPlugin;
  setupPeer(source?: WindowProxy): unknown;
  setupStream(id: number, rootId?: number): boolean | MediaStream;
  signalReceive(signal: RTCSessionDescriptionInit): void;
  peer?: DestroyablePeer | null;
}

export interface CanvasRtcRecord {
  plugin: InitializedRecordPlugin;
  /** Gateway -> recorder signaling entry point retained by the private bridge object. */
  receiveSignal(value: unknown): boolean;
  /** Remember an EME failure and notify every current/future viewer lane. */
  notifyVideoBlocked(id?: number): void;
}

export interface CanvasRtcRecordOptions {
  constructors: CapturedRtcConstructors;
  scope?: typeof globalThis;
  createPlugin?: (
    signalSendCallback: (signal: RTCSessionDescriptionInit) => void,
  ) => RecordPluginAdapter;
  /** Binding accessor retained off globalThis at document start. */
  signalBinding?: () => ((payload: string) => void) | undefined;
  /** Per-session randomized binding name used when Chromium exposes it after document-start. */
  signalBindingName?: string;
  /** Legacy test/plain-bundle compatibility; production keeps the receiver off globalThis. */
  exposeReceiver?: boolean;
  onError?: (error: unknown) => void;
}

interface Lane {
  peer: string;
  lane: string;
  plugin: RecordPluginAdapter;
  streams: Set<MediaStream>;
  detachPlugin: () => void;
}

export function captureRtcConstructors(scope: typeof globalThis): CapturedRtcConstructors {
  return {
    RTCPeerConnection: scope.RTCPeerConnection,
    RTCSessionDescription: scope.RTCSessionDescription,
    RTCIceCandidate: scope.RTCIceCandidate,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validScopeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function parsePayload(value: unknown): RtcMessage | null {
  if (!isRecord(value)) return null;
  if (value.type === "close") return { type: "close" };
  if (value.type === "canvas" || value.type === "video") {
    if (!Number.isSafeInteger(value.id) || (value.id as number) < 0) return null;
    if (
      value.rootId !== undefined &&
      (!Number.isSafeInteger(value.rootId) || (value.rootId as number) < 0)
    ) {
      return null;
    }
    return value as unknown as MediaRequest;
  }
  if (value.type === "signal" && isRecord(value.signal)) {
    return value as unknown as SignalMessage;
  }
  return null;
}

function parseMessage(value: unknown): ScopedRtcMessage | null {
  if (!isRecord(value) || !validScopeId(value.peer) || !validScopeId(value.lane)) return null;
  const payload = parsePayload(value.payload);
  return payload === null ? null : { peer: value.peer, lane: value.lane, payload };
}

function laneKey(peer: string, lane: string): string {
  return `${peer.length}:${peer}${lane}`;
}

function isMediaStream(value: unknown): value is MediaStream {
  return (
    isRecord(value) &&
    typeof value.getTracks === "function" &&
    typeof value.getVideoTracks === "function"
  );
}

function canCapture(node: Node | null): node is HTMLCanvasElement | HTMLVideoElement {
  if (node === null || node.nodeType !== 1) return false;
  const name = node.nodeName.toLowerCase();
  return (
    (name === "canvas" || name === "video") &&
    typeof (node as unknown as { captureStream?: unknown }).captureStream === "function"
  );
}

/**
 * Run the plugin's synchronous peer setup while exposing the constructors captured before page
 * code can replace them. simple-peer snapshots all three constructor references into the peer.
 */
function withCapturedRtc<T>(
  scope: typeof globalThis,
  constructors: CapturedRtcConstructors,
  callback: () => T,
): T {
  const keys = ["RTCPeerConnection", "RTCSessionDescription", "RTCIceCandidate"] as const;
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(scope, key)] as const);
  try {
    for (const key of keys) {
      const value = constructors[key];
      if (value === undefined) continue;
      Object.defineProperty(scope, key, {
        configurable: true,
        enumerable: previous.find(([candidate]) => candidate === key)?.[1]?.enumerable ?? true,
        value,
        writable: true,
      });
    }
    return callback();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) delete (scope as unknown as Record<string, unknown>)[key];
      else Object.defineProperty(scope, key, descriptor);
    }
  }
}

/**
 * rrweb 2.1.1 installs one anonymous message listener per record-plugin instance. Capture that
 * listener during construction so a closed viewer lane can remove it instead of leaking one
 * listener for every Replayer rebuild in the document.
 */
function createNativePlugin(
  scope: typeof globalThis,
  signalSendCallback: (signal: RTCSessionDescriptionInit) => void,
): { plugin: RecordPluginAdapter; detach: () => void } {
  const ownDescriptor = Object.getOwnPropertyDescriptor(scope, "addEventListener");
  const add = scope.addEventListener;
  const remove = scope.removeEventListener;
  const listeners: Array<{
    listener: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
  }> = [];
  Object.defineProperty(scope, "addEventListener", {
    configurable: true,
    enumerable: ownDescriptor?.enumerable ?? true,
    value(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "message")
        listeners.push({ listener, ...(options === undefined ? {} : { options }) });
      add.call(scope, type, listener, options);
    },
    writable: true,
  });

  let plugin: RecordPluginAdapter;
  try {
    plugin = new RRWebPluginCanvasWebRTCRecord({
      signalSendCallback,
    }) as unknown as RecordPluginAdapter;
  } finally {
    if (ownDescriptor === undefined)
      delete (scope as unknown as Record<string, unknown>).addEventListener;
    else Object.defineProperty(scope, "addEventListener", ownDescriptor);
  }
  return {
    plugin,
    detach() {
      for (const { listener, options } of listeners) {
        remove.call(scope, "message", listener, options);
      }
      listeners.length = 0;
    },
  };
}

export function installCanvasRtcRecord(options: CanvasRtcRecordOptions): CanvasRtcRecord {
  const scope = options.scope ?? globalThis;
  const pendingMessages: unknown[] = [];
  const lanes = new Map<string, Lane>();
  const blockedVideoIds = new Set<number>();
  let allVideoBlocked = false;
  let mirrors: RecordMirrors | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flushMessages = () => {
    flushTimer = undefined;
    const bindingName = options.signalBindingName ?? RTC_SIGNAL_BINDING_NAME;
    const binding =
      options.signalBinding?.() ??
      ((scope as unknown as Record<string, unknown>)[bindingName] as unknown);
    if (typeof binding !== "function") {
      if (pendingMessages.length > 0) flushTimer = setTimeout(flushMessages, 100);
      return;
    }
    while (pendingMessages.length > 0) {
      const message = pendingMessages.shift()!;
      try {
        (binding as (payload: string) => void)(JSON.stringify(message));
      } catch (error) {
        pendingMessages.unshift(message);
        options.onError?.(error);
        flushTimer = setTimeout(flushMessages, 100);
        return;
      }
    }
  };

  const send = (peer: string, lane: string, payload: unknown) => {
    pendingMessages.push({ peer, lane, payload });
    if (flushTimer === undefined) flushMessages();
  };

  const sendVideoNotice = (
    peer: string,
    lane: string,
    notice: "drm" | "unavailable",
    id?: number,
  ) => {
    send(peer, lane, {
      type: "video-notice",
      notice,
      ...(id === undefined ? {} : { id }),
    });
  };

  const stopStream = (stream: MediaStream) => {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  const disposeLane = (key: string) => {
    const state = lanes.get(key);
    if (state === undefined) return;
    lanes.delete(key);
    const peer = state.plugin.peer;
    try {
      peer?.destroy();
    } catch (error) {
      options.onError?.(error);
    }
    for (const stream of state.streams) stopStream(stream);
    state.streams.clear();
    state.detachPlugin();
  };

  const createLane = (peer: string, laneId: string): Lane => {
    const key = laneKey(peer, laneId);
    const existing = lanes.get(key);
    if (existing !== undefined) return existing;
    const signalSend = (signal: RTCSessionDescriptionInit) => {
      if (lanes.has(key)) send(peer, laneId, { type: "signal", signal });
    };
    const created = options.createPlugin
      ? { plugin: options.createPlugin(signalSend), detach: () => {} }
      : createNativePlugin(scope, signalSend);
    const plugin = created.plugin;

    // setupPeer is also called by signalReceive and setupStream. Protect all later peer creation
    // even if page code replaces WebRTC constructors after the agent initialized.
    const setupPeer = plugin.setupPeer.bind(plugin);
    plugin.setupPeer = ((source?: WindowProxy) =>
      withCapturedRtc(scope, options.constructors, () =>
        setupPeer(source),
      )) as typeof plugin.setupPeer;

    const state: Lane = {
      peer,
      lane: laneId,
      plugin,
      streams: new Set(),
      detachPlugin: created.detach,
    };
    lanes.set(key, state);
    const initialized = plugin.initPlugin() as InitializedRecordPlugin & {
      getMirror?: (value: RecordMirrors) => void;
    };
    if (mirrors !== null) initialized.getMirror?.(mirrors);
    return state;
  };

  const receiveSignal = (value: unknown): boolean => {
    const message = parseMessage(value);
    if (message === null) return false;
    const key = laneKey(message.peer, message.lane);
    if (message.payload.type === "close") {
      disposeLane(key);
      return true;
    }

    const state = createLane(message.peer, message.lane);
    try {
      if (message.payload.type === "signal") {
        const signal = message.payload.signal;
        withCapturedRtc(scope, options.constructors, () => state.plugin.signalReceive(signal));
        return true;
      }

      const request = message.payload;
      if (request.type === "video") {
        if (allVideoBlocked || blockedVideoIds.has(request.id)) {
          sendVideoNotice(message.peer, message.lane, "drm", request.id);
          if (state.streams.size === 0) disposeLane(key);
          return false;
        }
      }
      const node = mirrors?.nodeMirror.getNode(request.id) ?? null;
      // The 2.1.1 plugin's iframe postMessage protocol has no peer id. Refuse an ambiguous
      // cross-frame request rather than cross-wiring two authenticated viewers into one peer.
      if (!canCapture(node)) {
        if (request.type === "video") {
          sendVideoNotice(message.peer, message.lane, "unavailable", request.id);
        }
        if (state.streams.size === 0) disposeLane(key);
        return false;
      }
      const stream = withCapturedRtc(scope, options.constructors, () =>
        state.plugin.setupStream(request.id, request.rootId),
      );
      if (!isMediaStream(stream) || stream.getVideoTracks().length === 0) {
        if (isMediaStream(stream)) stopStream(stream);
        if (request.type === "video") {
          sendVideoNotice(message.peer, message.lane, "unavailable", request.id);
        }
        if (state.streams.size === 0) disposeLane(key);
        return false;
      }
      state.streams.add(stream);
      return true;
    } catch (error) {
      if (message.payload.type === "video") {
        const notice =
          error instanceof DOMException && error.name === "SecurityError" ? "drm" : "unavailable";
        sendVideoNotice(message.peer, message.lane, notice, message.payload.id);
      }
      if (state.streams.size === 0) disposeLane(key);
      options.onError?.(error);
      return false;
    }
  };
  if (options.exposeReceiver !== false) {
    (scope as unknown as Record<PropertyKey, unknown>)[RTC_SIGNAL_RECEIVER_KEY] = receiveSignal;
  }

  const plugin: InitializedRecordPlugin = {
    name: "@mirror/canvas-webrtc-multiplex",
    options: {},
    getMirror(value: RecordMirrors) {
      mirrors = value;
      for (const state of lanes.values()) {
        const initialized = state.plugin.initPlugin() as InitializedRecordPlugin & {
          getMirror?: (candidate: RecordMirrors) => void;
        };
        initialized.getMirror?.(value);
      }
    },
  } as InitializedRecordPlugin;

  return {
    plugin,
    receiveSignal,
    notifyVideoBlocked(id) {
      if (id === undefined) allVideoBlocked = true;
      else blockedVideoIds.add(id);
      for (const state of lanes.values()) {
        sendVideoNotice(state.peer, state.lane, "drm", id);
      }
    },
  };
}
