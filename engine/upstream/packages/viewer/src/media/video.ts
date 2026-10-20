/** Viewer video tiers for P3-VIDEO. */

export const MEDIA_UNAVAILABLE_NOTICE = "Media unavailable in DOM view — use pixel view";
/** Backward-compatible export for callers that used the earlier DRM-only notice name. */
export const DRM_VIDEO_NOTICE = MEDIA_UNAVAILABLE_NOTICE;

export interface VideoNotice {
  notice: "drm" | "unavailable";
  message: typeof MEDIA_UNAVAILABLE_NOTICE;
  id?: number;
  cause?: unknown;
}

export type VideoTier = "direct" | "rtc";

export interface VideoCompositorOptions {
  /** Trusted viewer document containing #viewer-hud-layer. */
  document?: Document;
  onNotice?: (notice: VideoNotice) => void;
  onError?: (error: unknown) => void;
}

export interface VideoCompositor {
  /** Prepare a mirrored video and report whether it should remain native or request RTC. */
  onBuild(video: HTMLVideoElement, id: number): VideoTier;
  /** Put the entire remote MediaStream on the mirrored video; audio stays in WebRTC A/V sync. */
  startStream(
    video: HTMLVideoElement,
    stream: MediaStream,
    onFailure: (error?: unknown) => void,
  ): () => void;
  showBlocked(id?: number, cause?: unknown, notice?: VideoNotice["notice"]): void;
  dispose(): void;
}

function isRtcOnlySource(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return (
    normalized === "" || normalized.startsWith("blob:") || normalized.startsWith("mediasource:")
  );
}

/** A real URL is replayed natively; absent/blob MSE sources must be captured at the agent. */
export function videoTier(video: HTMLVideoElement): VideoTier {
  const urls: string[] = [];
  const src = video.getAttribute("src");
  if (src !== null) urls.push(src);
  for (const source of video.querySelectorAll?.("source") ?? []) {
    const sourceSrc = source.getAttribute("src");
    if (sourceSrc !== null) urls.push(sourceSrc);
  }
  return urls.some((url) => !isRtcOnlySource(url)) ? "direct" : "rtc";
}

function prepareAutoplay(video: HTMLVideoElement): void {
  video.autoplay = true;
  video.defaultMuted = true;
  video.muted = true;
  video.playsInline = true;
  // Native controls are the user-gesture affordance that lets the viewer unmute or seek.
  video.controls = true;
}

function play(video: HTMLVideoElement, onError?: (error: unknown) => void): void {
  try {
    void video.play().catch(onError);
  } catch (error) {
    onError?.(error);
  }
}

function renderHudNotice(document: Document | undefined): HTMLElement | null {
  if (document === undefined) return null;
  const existing = document.querySelector<HTMLElement>("[data-mirror-video-notice]");
  if (existing !== null) return existing;
  const host = document.getElementById("viewer-hud-layer") ?? document.body;
  if (host === null) return null;
  host.dataset.mediaNotice = "unavailable";
  const notice = document.createElement("div");
  notice.dataset.mirrorVideoNotice = "unavailable";
  notice.setAttribute("role", "alert");
  notice.textContent = MEDIA_UNAVAILABLE_NOTICE;
  Object.assign(notice.style, {
    background: "#3b1217",
    border: "1px solid #ef6b78",
    borderRadius: "6px",
    color: "#fff",
    font: "600 13px/1.35 system-ui, sans-serif",
    margin: "8px",
    padding: "8px 10px",
    pointerEvents: "auto",
  });
  host.appendChild(notice);
  return notice;
}

function renderVideoNotice(video: HTMLVideoElement): HTMLElement | null {
  const document = video.ownerDocument;
  const parent = video.parentElement;
  if (parent === null) return null;
  const existing = parent.querySelector<HTMLElement>("[data-mirror-video-blocked='true']");
  if (existing !== null) return existing;
  const notice = document.createElement("div");
  notice.dataset.mirrorVideoBlocked = "true";
  notice.setAttribute("role", "alert");
  notice.textContent = MEDIA_UNAVAILABLE_NOTICE;
  const rect = video.getBoundingClientRect();
  Object.assign(notice.style, {
    alignItems: "center",
    background: "#111",
    color: "#fff",
    display: "flex",
    font: "600 14px/1.4 system-ui, sans-serif",
    height: `${Math.max(1, rect.height)}px`,
    justifyContent: "center",
    left: `${rect.left}px`,
    padding: "12px",
    position: "fixed",
    textAlign: "center",
    top: `${rect.top}px`,
    width: `${Math.max(1, rect.width)}px`,
    zIndex: "2147483647",
  });
  document.body.appendChild(notice);
  return notice;
}

export function createVideoCompositor(options: VideoCompositorOptions = {}): VideoCompositor {
  const videos = new Map<number, HTMLVideoElement>();
  const blockedIds = new Set<number>();
  const renderedNotices = new Set<HTMLElement>();
  let hudNotice: HTMLElement | null = null;
  let disposed = false;

  const showBlocked = (
    id?: number,
    cause?: unknown,
    noticeKind: VideoNotice["notice"] = "unavailable",
  ) => {
    if (disposed) return;
    if (id !== undefined) blockedIds.add(id);
    const notice: VideoNotice = {
      notice: noticeKind,
      message: MEDIA_UNAVAILABLE_NOTICE,
      ...(id === undefined ? {} : { id }),
      ...(cause === undefined ? {} : { cause }),
    };
    options.onNotice?.(notice);
    hudNotice ??= renderHudNotice(options.document ?? globalThis.document);
    if (id !== undefined) {
      const video = videos.get(id);
      if (video !== undefined) {
        video.pause();
        const rendered = renderVideoNotice(video);
        if (rendered !== null) renderedNotices.add(rendered);
      }
    }
  };

  return {
    onBuild(video, id) {
      if (disposed) return "direct";
      videos.set(id, video);
      prepareAutoplay(video);
      if (blockedIds.has(id)) showBlocked(id);
      const tier = videoTier(video);
      if (tier === "direct") play(video, options.onError);
      return tier;
    },
    startStream(video, stream, onFailure) {
      if (disposed) return () => {};
      prepareAutoplay(video);
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack === undefined) throw new Error("video WebRTC stream has no video track");
      const failed = () => onFailure(new Error("video WebRTC media track ended"));
      videoTrack.addEventListener("ended", failed, { once: true });
      video.addEventListener("error", failed, { once: true });
      // Assign the original stream, not a video-only copy: WebRTC timestamps keep audio/video synced.
      video.srcObject = stream;
      play(video, onFailure);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        videoTrack.removeEventListener("ended", failed);
        video.removeEventListener("error", failed);
        video.pause();
        if (video.srcObject === stream) video.srcObject = null;
      };
    },
    showBlocked,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const notice of renderedNotices) notice.remove();
      renderedNotices.clear();
      hudNotice?.remove();
      hudNotice = null;
      videos.clear();
      blockedIds.clear();
    },
  };
}
