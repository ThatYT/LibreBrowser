// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createVideoCompositor, DRM_VIDEO_NOTICE, videoTier } from "./video";

function fakeTrack(kind: "audio" | "video") {
  return {
    kind,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function fakeVideo(src: string | null) {
  const attributes = new Map<string, string>();
  if (src !== null) attributes.set("src", src);
  return {
    nodeType: 1,
    nodeName: "VIDEO",
    autoplay: false,
    controls: false,
    currentTime: 0,
    defaultMuted: false,
    muted: false,
    playsInline: false,
    srcObject: null,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    querySelectorAll: () => [],
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLVideoElement;
}

describe("viewer video tiers", () => {
  it("starts a proxied direct MP4 muted with native unmute/seek controls and keeps its Range URL", () => {
    const proxied = "/s/session-a/a/sealed-video-token";
    const video = fakeVideo(proxied);
    const compositor = createVideoCompositor();

    expect(compositor.onBuild(video, 8)).toBe("direct");
    expect(video.autoplay).toBe(true);
    expect(video.defaultMuted).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.play).toHaveBeenCalledOnce();

    // Native seeking retains the proxied src; the browser's byte request therefore reaches the
    // existing Lane-B Range route instead of being replaced by the RTC lane.
    video.currentTime = 37;
    expect(video.currentTime).toBe(37);
    expect(video.getAttribute("src")).toBe(proxied);
    expect(video.srcObject).toBeNull();
  });

  it("classifies MSE/blob players for RTC and assigns the original audio+video stream", () => {
    const video = fakeVideo("blob:https://player.example/media-source");
    const compositor = createVideoCompositor();
    const videoTrack = fakeTrack("video");
    const audioTrack = fakeTrack("audio");
    const stream = {
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [audioTrack],
      getTracks: () => [videoTrack, audioTrack],
    } as unknown as MediaStream;

    expect(videoTier(video)).toBe("rtc");
    expect(compositor.onBuild(video, 9)).toBe("rtc");
    const cleanup = compositor.startStream(video, stream, vi.fn());

    expect(video.srcObject).toBe(stream);
    expect(stream.getAudioTracks()).toEqual([audioTrack]);
    expect(video.muted).toBe(true);
    expect(video.controls).toBe(true);
    cleanup();
    expect(video.srcObject).toBeNull();
  });

  it("exposes the exact DRM notice to the viewer/HUD signal", () => {
    const onNotice = vi.fn();
    const compositor = createVideoCompositor({ onNotice });

    compositor.showBlocked(12, new DOMException("tainted", "SecurityError"), "drm");

    expect(onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ notice: "drm", id: 12, message: DRM_VIDEO_NOTICE }),
    );
    expect(DRM_VIDEO_NOTICE).toBe("Media unavailable in DOM view — use pixel view");
  });
});
