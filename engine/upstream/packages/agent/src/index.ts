/**
 * In-page agent entry point.
 *
 * Injected into EVERY attached target (top pages and OOPIFs) in the page's MAIN world via
 * Page.addScriptToEvaluateOnNewDocument.
 */
import {
  createRecordReadiness,
  createCommandHandler,
  type CrossOriginIframeMirror,
} from "./commands";
import { CMD_FN_NAME, EventType, MIRROR_NODE_FN_NAME } from "@mirror/protocol";
import { createEmitter, type BindingFn, type RuntimeBindingHandle } from "./emit";
import { installClosedShadowShim } from "./shadow";
import {
  AGENT_CONFIG_KEY,
  DEFAULT_AGENT_CONFIG,
  readAgentConfig,
  type AgentBridgeConfig,
} from "./config";
import { captureRtcConstructors, installCanvasRtcRecord } from "./canvas-rtc";
import { captureMediaKeySystemAccess, installVideoDrmMonitor } from "./video";
import { captureClipboardWrite, installClipboardHooks } from "./clipboard";
import { canStartCanvasSnapshotWorker } from "./canvas-snapshot";
import { record } from "@rrweb/record";
import {
  broadcastStitchSync,
  installStitchReadyListener,
  installStitchSyncListener,
  isCrossOriginChild,
} from "./stitch";

const LEGACY_GUARD = Symbol.for("@mirror/agent/installed");

interface MainWorldBridge {
  emitBinding: RuntimeBindingHandle;
  rtcBinding: RuntimeBindingHandle;
  install(handlers: {
    command(value: unknown): void;
    node(nodeId: number): Node | null;
    rtc(value: unknown): boolean;
  }): void;
}

function createMainWorldBridge(config: AgentBridgeConfig): MainWorldBridge {
  const nativeAddEventListener = EventTarget.prototype.addEventListener;
  const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
  const NativeCustomEvent = CustomEvent;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  let ready = false;

  nativeAddEventListener.call(document, config.readyEventName, () => {
    ready = true;
  });

  const eventBinding =
    (lane: "agent" | "rtc"): BindingFn =>
    (payload) => {
      nativeDispatchEvent.call(
        document,
        new NativeCustomEvent(config.outboundEventName, {
          detail: stringify({ lane, payload }),
        }),
      );
    };
  const emit = eventBinding("agent");
  const rtc = eventBinding("rtc");
  const bindingHandle = (binding: BindingFn): RuntimeBindingHandle => ({
    get: () => (ready ? binding : undefined),
  });

  return {
    emitBinding: bindingHandle(emit),
    rtcBinding: bindingHandle(rtc),
    install(handlers) {
      nativeAddEventListener.call(document, config.inboundEventName, (event) => {
        const detail = (event as CustomEvent<unknown>).detail;
        if (typeof detail !== "string") return;
        let envelope: unknown;
        try {
          envelope = parse(detail);
        } catch {
          return;
        }
        if (typeof envelope !== "object" || envelope === null) return;
        const method = (envelope as { method?: unknown }).method;
        const args = (envelope as { args?: unknown }).args;
        if (!Array.isArray(args)) return;
        if (method === "command") {
          handlers.command(args[0]);
          return;
        }
        if (method === "rtc") {
          handlers.rtc(args[0]);
          return;
        }
        if (method !== "node" || typeof args[0] !== "number") return;
        const node = handlers.node(args[0]);
        if (node === null) return;
        nativeDispatchEvent.call(node, new NativeCustomEvent(config.nodeResponseEventName));
      });
    },
  };
}

(() => {
  const w = window as unknown as Record<PropertyKey, unknown>;
  // Capture at the very start of agent initialization. The adapter uses these references for
  // every simple-peer setup even if page code later replaces the Window properties.
  const rtcConstructors = captureRtcConstructors(globalThis);
  const requestMediaKeySystemAccess = captureMediaKeySystemAccess(navigator);
  const clipboardWrite = captureClipboardWrite(navigator);
  const config = readAgentConfig(w[AGENT_CONFIG_KEY]);
  delete w[AGENT_CONFIG_KEY];
  // The checked-in default bundle remains usable by standalone agent fixtures. Production always
  // embeds fresh bridge names and never installs this named guard or the legacy command globals.
  const legacyBridge = config.bridge.bridgeKey === DEFAULT_AGENT_CONFIG.bridge.bridgeKey;
  if (legacyBridge && w[LEGACY_GUARD] === true) return;
  if (legacyBridge) w[LEGACY_GUARD] = true;
  const mainWorldBridge = legacyBridge ? undefined : createMainWorldBridge(config.bridge);
  const emitBinding = mainWorldBridge?.emitBinding;
  const rtcBinding = mainWorldBridge?.rtcBinding;

  // Must precede record() so rrweb's shadow observer and initial snapshot use the retained roots.
  installClosedShadowShim();

  // Per-document epoch (D1): random uint32, minted once per document.
  const docId = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const isTop = window === window.top;
  const emitter = createEmitter(docId, emitBinding, config.bridge.bindingName);
  if (isTop) installClipboardHooks({ capturedWrite: clipboardWrite, emitter });
  let crossOriginIframeMirror: CrossOriginIframeMirror | null = null;
  const recordReadiness = createRecordReadiness();
  const canvasRtc = installCanvasRtcRecord({
    constructors: rtcConstructors,
    ...(rtcBinding === undefined ? {} : { signalBinding: () => rtcBinding.get() }),
    signalBindingName: config.bridge.rtcBindingName,
    exposeReceiver: legacyBridge,
    onError: (error) => console.warn("mirror canvas WebRTC unavailable", error),
  });
  const videoDrm = installVideoDrmMonitor({
    requestMediaKeySystemAccess,
    onBlocked: (id) => canvasRtc.notifyVideoBlocked(id),
    onError: (error) => console.warn("mirror EME detection unavailable", error),
  });
  const recordCanvas = canStartCanvasSnapshotWorker();

  installStitchReadyListener(window);
  if (isCrossOriginChild()) {
    installStitchSyncListener(window, {
      isRecorderStarted: recordReadiness.isStarted,
      onRecorderStarted: recordReadiness.onStarted,
      takeFullSnapshot: () => record.takeFullSnapshot(true),
    });
  }

  const commandHandler = createCommandHandler(emitter, {
    getCrossOriginIframeMirror: () => crossOriginIframeMirror,
    recordReadiness,
  });
  const mirrorNode = (nodeId: number): Node | null => record.mirror.getNode(nodeId);
  if (legacyBridge) {
    w[CMD_FN_NAME] = commandHandler;
    w[MIRROR_NODE_FN_NAME] = mirrorNode;
  } else {
    mainWorldBridge!.install({
      command(value) {
        commandHandler(value as Parameters<typeof commandHandler>[0]);
      },
      node: mirrorNode,
      rtc: canvasRtc.receiveSignal,
    });
  }

  emitter.emit({ kind: "hello", docId, url: location.href, isTop, ts: Date.now() });

  record({
    recordCrossOriginIframes: true,
    recordCanvas,
    ...(recordCanvas
      ? {
          sampling: { canvas: config.canvas.fps },
          dataURLOptions: { type: "image/webp", quality: config.canvas.quality },
        }
      : {}),
    collectFonts: true,
    inlineStylesheet: true,
    inlineImages: false,
    maskAllInputs: false,
    maskInputOptions: { password: true },
    // rrweb 2.1.1 calls this option slimDOMOptions; an empty object explicitly disables every
    // slimming rule and is the pinned-version equivalent of the plan's `slimDOM: false`.
    slimDOMOptions: {},
    plugins: [
      canvasRtc.plugin,
      videoDrm.plugin,
      {
        name: "@mirror/cross-origin-iframe-mirror",
        options: {},
        getMirror: (mirrors) => {
          crossOriginIframeMirror = mirrors.crossOriginIframeMirror;
        },
        eventProcessor: (event) => {
          // rrweb processes this initial snapshot in both top-level and cross-origin child
          // recorders. Waiting snapshot commands resume in a microtask, after rrweb finishes the
          // current startup call stack and flips its internal recording flag.
          if (event.type === EventType.FullSnapshot) recordReadiness.markStarted();
          return event;
        },
      },
    ],
    emit: (e) => {
      // D2: child recorders forward through rrweb's parent handshake. Their direct binding
      // streams carry hello diagnostics only; the top-level stream remains canonical.
      if (isTop) {
        emitter.emit({ kind: "rrweb", docId, e });
        if (e.type === EventType.FullSnapshot) broadcastStitchSync();
      }
    },
  });
})();
