// @vitest-environment node
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import { createCanvasCompositor } from "./canvas";
import { createCanvasRtc, type CanvasRtcMessage } from "./canvas-rtc";
import type { VideoCompositor } from "./video";

function snapshotEvent(id: number): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: {
      source: IncrementalSource.CanvasMutation,
      id,
      type: 0,
      commands: [
        { property: "clearRect", args: [0, 0, 640, 360] },
        {
          property: "drawImage",
          args: [
            {
              rr_type: "ImageBitmap",
              args: [
                {
                  rr_type: "Blob",
                  data: [{ rr_type: "ArrayBuffer", base64: "AQ==" }],
                  type: "image/webp",
                },
              ],
            },
            0,
            0,
          ],
        },
      ],
    },
  } as eventWithTime;
}

function setup() {
  const sent: CanvasRtcMessage[] = [];
  const peerListeners = new Map<string, (error?: unknown) => void>();
  const peer = {
    on: (event: "error" | "close", listener: (error?: unknown) => void) =>
      void peerListeners.set(event, listener),
  };
  let canvasFound: ((canvas: HTMLCanvasElement, id: number) => void) | undefined;
  const fakePlugin = {
    peer,
    initPlugin: vi.fn(() => ({ handler: vi.fn() }) as never),
    signalReceive: vi.fn(),
    startStream: vi.fn(),
  };
  const cleanupTrack = vi.fn();
  const renderTrack = vi.fn(() => cleanupTrack);
  const rtc = createCanvasRtc({
    send: (message) => sent.push(message),
    createPlugin(callbacks) {
      canvasFound = callbacks.canvasFound;
      return fakePlugin;
    },
    renderTrack,
  });
  return {
    canvasFound: () => canvasFound!,
    cleanupTrack,
    fakePlugin,
    peerListeners,
    renderTrack,
    rtc,
    sent,
  };
}

describe("canvas WebRTC upgrade lane", () => {
  it("requests an upgrade when replay builds a canvas and suppresses snapshots after track arrival", async () => {
    const h = setup();
    const context = { clearRect: vi.fn(), drawImage: vi.fn() };
    const canvas = {
      nodeType: 1,
      nodeName: "CANVAS",
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const stream = { id: "live-stream" } as MediaStream;
    const mirror = {
      getReplayer: () => ({ getMirror: () => ({ getNode: () => canvas }) }),
    } as never;
    const compositor = createCanvasCompositor(mirror, {
      isLive: h.rtc.isLive,
      decodeBitmap: vi.fn(async () => ({}) as CanvasImageSource),
    });

    h.canvasFound()(canvas, 42);
    expect(h.sent).toEqual([{ type: "canvas", id: 42 }]);
    h.fakePlugin.startStream(canvas, stream);

    expect(h.renderTrack).toHaveBeenCalledWith(canvas, stream, expect.any(Function));
    expect(h.rtc.isLive(42)).toBe(true);
    await expect(compositor.apply(snapshotEvent(42))).resolves.toBe(false);
    expect(context.drawImage).not.toHaveBeenCalled();
    h.rtc.dispose();
  });

  it("keeps the canvas node and resumes snapshot painting when the peer fails", async () => {
    const h = setup();
    const context = { clearRect: vi.fn(), drawImage: vi.fn() };
    const canvas = {
      nodeType: 1,
      nodeName: "CANVAS",
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const stream = { id: "failed-stream" } as MediaStream;
    const mirror = {
      getReplayer: () => ({ getMirror: () => ({ getNode: () => canvas }) }),
    } as never;
    const bitmap = { close: vi.fn() } as unknown as CanvasImageSource & { close(): void };
    const compositor = createCanvasCompositor(mirror, {
      isLive: h.rtc.isLive,
      decodeBitmap: vi.fn(async () => bitmap),
    });

    h.canvasFound()(canvas, 7);
    expect(h.rtc.receive({ type: "signal", signal: { type: "offer", sdp: "v=0" } })).toBe(true);
    h.fakePlugin.startStream(canvas, stream);
    expect(h.rtc.isLive(7)).toBe(true);

    h.peerListeners.get("error")?.(new Error("connection failed"));
    expect(h.rtc.isLive(7)).toBe(false);
    expect(h.cleanupTrack).toHaveBeenCalledOnce();
    await expect(compositor.apply(snapshotEvent(7))).resolves.toBe(true);
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    h.rtc.dispose();
  });

  it("discovers an MSE video, requests it on the canvas RTC lane, and renders the full A/V stream", () => {
    const sent: CanvasRtcMessage[] = [];
    const fakePlugin = {
      peer: null,
      initPlugin: vi.fn(() => ({ onBuild: vi.fn() }) as never),
      signalReceive: vi.fn(),
      startStream: vi.fn(),
    };
    const cleanup = vi.fn();
    const videoCompositor = {
      onBuild: vi.fn(() => "rtc" as const),
      startStream: vi.fn(() => cleanup),
      showBlocked: vi.fn(),
      dispose: vi.fn(),
    } satisfies VideoCompositor;
    const rtc = createCanvasRtc({
      send: (message) => sent.push(message),
      createPlugin: () => fakePlugin,
      videoCompositor,
    });
    const video = { nodeType: 1, nodeName: "VIDEO" } as unknown as HTMLVideoElement;
    const audioTrack = { kind: "audio" } as MediaStreamTrack;
    const videoTrack = { kind: "video" } as MediaStreamTrack;
    const stream = {
      getTracks: () => [videoTrack, audioTrack],
    } as unknown as MediaStream;
    const replayPlugin = rtc.replayPlugin as unknown as {
      onBuild(node: Node, context: { id: number }): void;
    };

    replayPlugin.onBuild(video, { id: 51 });
    expect(sent).toEqual([{ type: "video", id: 51 }]);
    fakePlugin.startStream(video, stream);

    expect(videoCompositor.startStream).toHaveBeenCalledWith(video, stream, expect.any(Function));
    expect(stream.getTracks()).toEqual([videoTrack, audioTrack]);
    expect(rtc.isLive(51)).toBe(true);

    expect(rtc.receive({ type: "video-notice", notice: "drm", id: 51 })).toBe(true);
    expect(videoCompositor.showBlocked).toHaveBeenCalledWith(51, undefined, "drm");
    rtc.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(videoCompositor.dispose).toHaveBeenCalledOnce();
  });
});
