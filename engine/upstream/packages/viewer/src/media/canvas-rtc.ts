/** Viewer-side adapter for rrweb's canvas WebRTC replay plugin. */
import { RRWebPluginCanvasWebRTCReplay } from "@rrweb/rrweb-plugin-canvas-webrtc-replay";
import { createVideoCompositor, type VideoCompositor, type VideoNotice } from "./video";

interface MediaRequest {
  type: "canvas" | "video";
  id: number;
}

interface SignalMessage {
  type: "signal";
  signal: RTCSessionDescriptionInit;
}

export type CanvasRtcMessage = MediaRequest | SignalMessage;

interface ReplayPluginAdapter {
  initPlugin(): ReturnType<RRWebPluginCanvasWebRTCReplay["initPlugin"]>;
  signalReceive(signal: RTCSessionDescriptionInit): void;
  startStream(target: Element, stream: MediaStream): void;
  peer?: SignalPeer | null;
}

interface SignalPeer {
  on(event: "error" | "close", listener: (error?: unknown) => void): void;
  destroy?(error?: Error): void;
}

export type CanvasTrackRenderer = (
  canvas: HTMLCanvasElement,
  stream: MediaStream,
  onFailure: (error?: unknown) => void,
) => () => void;

export interface CanvasRtcOptions {
  send(message: CanvasRtcMessage): void;
  /** Trusted outer viewer document used for the explicit media-unavailable HUD notice. */
  document?: Document;
  createPlugin?: (callbacks: {
    canvasFound(canvas: HTMLCanvasElement, id: number): void;
    signalSend(signal: RTCSessionDescriptionInit): void;
  }) => ReplayPluginAdapter;
  renderTrack?: CanvasTrackRenderer;
  videoCompositor?: VideoCompositor;
  onVideoNotice?: (notice: VideoNotice) => void;
  onUpgrade?: (id: number) => void;
  onDowngrade?: (id: number, error?: unknown) => void;
  onError?: (error: unknown) => void;
}

export interface CanvasRtc {
  /** Pass this to Replayer's plugins array. UNSAFE_replayCanvas remains false. */
  replayPlugin: ReturnType<RRWebPluginCanvasWebRTCReplay["initPlugin"]>;
  /** Deliver one payload from a Down rtc-sig message. */
  receive(payload: unknown): boolean;
  /** Snapshot compositors use this to decide which per-canvas lane currently owns painting. */
  isLive(id: number): boolean;
  dispose(): void;
}

interface LiveLane {
  stream: MediaStream;
  cleanup: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSignal(value: unknown): RTCSessionDescriptionInit | null {
  if (!isRecord(value) || value.type !== "signal" || !isRecord(value.signal)) return null;
  return value.signal as unknown as RTCSessionDescriptionInit;
}

function parseVideoNotice(value: unknown): { notice: "drm" | "unavailable"; id?: number } | null {
  if (
    !isRecord(value) ||
    value.type !== "video-notice" ||
    (value.notice !== "drm" && value.notice !== "unavailable")
  ) {
    return null;
  }
  if (value.id === undefined) return { notice: value.notice };
  return Number.isSafeInteger(value.id) && (value.id as number) >= 0
    ? { notice: value.notice, id: value.id as number }
    : null;
}

function isCanvas(target: Element): target is HTMLCanvasElement {
  return target.nodeType === 1 && target.nodeName.toLowerCase() === "canvas";
}

function isVideo(target: Element): target is HTMLVideoElement {
  return target.nodeType === 1 && target.nodeName.toLowerCase() === "video";
}

function defaultRenderTrack(
  canvas: HTMLCanvasElement,
  stream: MediaStream,
  onFailure: (error?: unknown) => void,
): () => void {
  const context = canvas.getContext("2d");
  const track = stream.getVideoTracks()[0];
  if (context === null || track === undefined) throw new Error("canvas WebRTC stream has no video");

  const video = canvas.ownerDocument.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  let stopped = false;
  let videoFrame = 0;
  let animationFrame = 0;
  const ownerWindow = canvas.ownerDocument.defaultView;

  const paint = () => {
    if (stopped) return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
        if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
    }
    if ("requestVideoFrameCallback" in video) {
      videoFrame = video.requestVideoFrameCallback(paint);
    } else if (ownerWindow !== null) {
      animationFrame = ownerWindow.requestAnimationFrame(paint);
    }
  };
  const fail = () => onFailure(new Error("canvas WebRTC media track ended"));
  track.addEventListener("ended", fail, { once: true });
  video.addEventListener("error", fail, { once: true });
  void video.play().then(paint, onFailure);

  return () => {
    if (stopped) return;
    stopped = true;
    track.removeEventListener("ended", fail);
    video.removeEventListener("error", fail);
    if (videoFrame !== 0 && "cancelVideoFrameCallback" in video) {
      video.cancelVideoFrameCallback(videoFrame);
    }
    if (animationFrame !== 0) ownerWindow?.cancelAnimationFrame(animationFrame);
    video.pause();
    video.srcObject = null;
  };
}

export function createCanvasRtc(options: CanvasRtcOptions): CanvasRtc {
  const canvasIds = new WeakMap<object, number>();
  const videoIds = new WeakMap<object, number>();
  const live = new Map<number, LiveLane>();
  const renderedStreams = new WeakSet<object>();
  const observedPeers = new WeakSet<object>();
  const renderTrack = options.renderTrack ?? defaultRenderTrack;
  const video =
    options.videoCompositor ??
    createVideoCompositor({
      document: options.document,
      onNotice: options.onVideoNotice,
      onError: options.onError,
    });
  let disposed = false;

  const stopStream = (stream: MediaStream) => {
    const getTracks = (stream as MediaStream & { getTracks?: () => MediaStreamTrack[] }).getTracks;
    if (typeof getTracks !== "function") return;
    for (const track of getTracks.call(stream)) {
      try {
        track.stop();
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  const canvasFound = (canvas: HTMLCanvasElement, id: number) => {
    if (disposed || !Number.isSafeInteger(id) || id < 0) return;
    canvasIds.set(canvas, id);
    options.send({ type: "canvas", id });
  };
  const signalSend = (signal: RTCSessionDescriptionInit) => {
    if (!disposed) options.send({ type: "signal", signal });
  };
  const plugin: ReplayPluginAdapter =
    options.createPlugin?.({ canvasFound, signalSend }) ??
    (new RRWebPluginCanvasWebRTCReplay({
      canvasFoundCallback(canvas: HTMLCanvasElement, context: { id: number }) {
        canvasFound(canvas, context.id);
      },
      signalSendCallback: signalSend,
    }) as unknown as ReplayPluginAdapter);

  // Keep rrweb's canvas discovery intact and extend the same replay plugin to discover video
  // nodes. This avoids a second peer and lets its streamId/nodeId association work unchanged.
  const replayPlugin = plugin.initPlugin();
  const replayHooks = replayPlugin as unknown as {
    onBuild?: (
      node: { nodeType: number; nodeName: string },
      context: { id: number; [key: string]: unknown },
    ) => void;
  };
  const originalOnBuild = replayHooks.onBuild?.bind(replayPlugin);
  replayHooks.onBuild = (node, context) => {
    originalOnBuild?.(node, context);
    if (node.nodeType !== 1 || node.nodeName.toLowerCase() !== "video") return;
    const target = node as HTMLVideoElement;
    const id = context.id;
    if (!Number.isSafeInteger(id) || id < 0) return;
    videoIds.set(target, id);
    if (video.onBuild(target, id) === "rtc" && !disposed) options.send({ type: "video", id });
  };

  const downgrade = (id: number, stream: MediaStream, error?: unknown) => {
    const lane = live.get(id);
    if (lane?.stream !== stream) return;
    live.delete(id);
    lane.cleanup();
    stopStream(stream);
    options.onDowngrade?.(id, error);
  };
  const downgradeAll = (error?: unknown) => {
    for (const [id, lane] of [...live]) downgrade(id, lane.stream, error);
  };

  // The replay plugin still owns canvas discovery, signaling, stream/node association and peer
  // negotiation. Override only its final renderer so the canvas element is never replaced by a
  // video: retaining that exact node is what makes sampled snapshots a non-blank fallback.
  const originalStartStream = plugin.startStream.bind(plugin);
  plugin.startStream = (target: Element, stream: MediaStream) => {
    if (isVideo(target)) {
      const id = videoIds.get(target);
      if (id === undefined || renderedStreams.has(stream)) return;
      renderedStreams.add(stream);
      const previous = live.get(id);
      if (previous !== undefined) {
        previous.cleanup();
        stopStream(previous.stream);
      }
      const lane: LiveLane = { stream, cleanup: () => {} };
      live.set(id, lane);
      try {
        lane.cleanup = video.startStream(target, stream, (error) => downgrade(id, stream, error));
        options.onUpgrade?.(id);
      } catch (error) {
        live.delete(id);
        stopStream(stream);
        video.showBlocked(id, error);
        options.onError?.(error);
        options.onDowngrade?.(id, error);
      }
      return;
    }
    if (!isCanvas(target)) {
      originalStartStream(target, stream);
      return;
    }
    const id = canvasIds.get(target);
    if (id === undefined || renderedStreams.has(stream)) return;
    renderedStreams.add(stream);

    const previous = live.get(id);
    if (previous !== undefined) {
      previous.cleanup();
      stopStream(previous.stream);
    }
    const lane: LiveLane = { stream, cleanup: () => {} };
    live.set(id, lane);
    try {
      lane.cleanup = renderTrack(target, stream, (error) => downgrade(id, stream, error));
      options.onUpgrade?.(id);
    } catch (error) {
      live.delete(id);
      stopStream(stream);
      options.onError?.(error);
      options.onDowngrade?.(id, error);
    }
  };

  const observePeer = () => {
    const peer = plugin.peer;
    if (peer === null || peer === undefined || observedPeers.has(peer)) return;
    observedPeers.add(peer);
    peer.on("error", (error: unknown) => downgradeAll(error));
    peer.on("close", () => downgradeAll(new Error("canvas WebRTC peer closed")));
  };

  return {
    replayPlugin,
    receive(payload) {
      if (disposed) return false;
      const notice = parseVideoNotice(payload);
      if (notice !== null) {
        video.showBlocked(notice.id, undefined, notice.notice);
        return true;
      }
      const signal = parseSignal(payload);
      if (signal === null) return false;
      try {
        plugin.signalReceive(signal);
        observePeer();
        return true;
      } catch (error) {
        downgradeAll(error);
        options.onError?.(error);
        return false;
      }
    },
    isLive: (id) => live.has(id),
    dispose() {
      if (disposed) return;
      disposed = true;
      downgradeAll(new Error("canvas WebRTC disposed"));
      try {
        plugin.peer?.destroy?.();
      } catch (error) {
        options.onError?.(error);
      }
      video.dispose();
    },
  };
}
