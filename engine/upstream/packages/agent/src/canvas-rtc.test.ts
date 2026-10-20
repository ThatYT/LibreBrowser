// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  captureRtcConstructors,
  installCanvasRtcRecord,
  RTC_SIGNAL_BINDING_NAME,
  RTC_SIGNAL_RECEIVER_KEY,
} from "./canvas-rtc";

describe("agent canvas WebRTC adapter", () => {
  it("uses the RTCPeerConnection constructor captured at agent initialization", () => {
    class CapturedPeer {}
    class ClobberedPeer {}
    class SessionDescription {}
    class IceCandidate {}
    const scope = {
      RTCPeerConnection: CapturedPeer,
      RTCSessionDescription: SessionDescription,
      RTCIceCandidate: IceCandidate,
      [RTC_SIGNAL_BINDING_NAME]: vi.fn(),
    } as unknown as typeof globalThis;
    const constructors = captureRtcConstructors(scope);
    scope.RTCPeerConnection = ClobberedPeer as unknown as typeof RTCPeerConnection;
    const observed: unknown[] = [];
    const fakePlugin = {
      initPlugin: vi.fn(() => ({ name: "rtc", options: {} }) as never),
      setupPeer: vi.fn(() => {
        observed.push(scope.RTCPeerConnection);
        return {} as never;
      }),
      setupStream: vi.fn(function (this: { setupPeer(): unknown }) {
        this.setupPeer();
        const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
        return {
          getTracks: () => [track],
          getVideoTracks: () => [track],
        } as unknown as MediaStream;
      }),
      signalReceive: vi.fn(),
    };

    const rtc = installCanvasRtcRecord({ constructors, scope, createPlugin: () => fakePlugin });
    rtc.plugin.getMirror?.({
      nodeMirror: {
        getNode: () => ({
          nodeType: 1,
          nodeName: "CANVAS",
          captureStream: vi.fn(),
        }),
      },
    } as never);
    const receive = (scope as unknown as Record<PropertyKey, unknown>)[RTC_SIGNAL_RECEIVER_KEY] as (
      payload: unknown,
    ) => boolean;

    expect(receive({ peer: "viewer-a", lane: "lane-a", payload: { type: "canvas", id: 9 } })).toBe(
      true,
    );
    expect(observed).toEqual([CapturedPeer]);
    expect(scope.RTCPeerConnection).toBe(ClobberedPeer);
  });

  it("routes a video captureStream, including its audio track, through the existing RTC plugin", () => {
    const binding = vi.fn();
    const audioTrack = { kind: "audio" };
    const videoTrack = { kind: "video" };
    const stream = {
      getTracks: () => [videoTrack, audioTrack],
      getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream;
    const video = { captureStream: vi.fn(() => stream) };
    const fakePlugin = {
      initPlugin: vi.fn(() => ({ name: "rtc", options: {} }) as never),
      setupPeer: vi.fn(),
      setupStream: vi.fn(() => video.captureStream()),
      signalReceive: vi.fn(),
    };
    const scope = {
      [RTC_SIGNAL_BINDING_NAME]: binding,
    } as unknown as typeof globalThis;

    const rtc = installCanvasRtcRecord({
      constructors: captureRtcConstructors(scope),
      scope,
      createPlugin: () => fakePlugin,
    });
    rtc.plugin.getMirror?.({
      nodeMirror: {
        getNode: () => ({
          nodeType: 1,
          nodeName: "VIDEO",
          captureStream: video.captureStream,
        }),
      },
    } as never);
    const receive = (scope as unknown as Record<PropertyKey, unknown>)[RTC_SIGNAL_RECEIVER_KEY] as (
      payload: unknown,
    ) => boolean;

    expect(receive({ peer: "viewer-a", lane: "lane-a", payload: { type: "video", id: 27 } })).toBe(
      true,
    );
    expect(fakePlugin.setupStream).toHaveBeenCalledWith(27, undefined);
    expect(video.captureStream).toHaveBeenCalledOnce();
    expect(stream.getTracks()).toEqual([videoTrack, audioTrack]);
  });

  it("turns a tainted video captureStream exception into the DRM/blocked notice", () => {
    const binding = vi.fn();
    const failure = new DOMException("Cannot capture tainted media", "SecurityError");
    const fakePlugin = {
      initPlugin: vi.fn(() => ({ name: "rtc", options: {} }) as never),
      setupPeer: vi.fn(),
      setupStream: vi.fn(() => {
        throw failure;
      }),
      signalReceive: vi.fn(),
    };
    const scope = {
      [RTC_SIGNAL_BINDING_NAME]: binding,
    } as unknown as typeof globalThis;
    const onError = vi.fn();

    const rtc = installCanvasRtcRecord({
      constructors: captureRtcConstructors(scope),
      scope,
      createPlugin: () => fakePlugin,
      onError,
    });
    rtc.plugin.getMirror?.({
      nodeMirror: {
        getNode: () => ({
          nodeType: 1,
          nodeName: "VIDEO",
          captureStream: vi.fn(),
        }),
      },
    } as never);
    const receive = (scope as unknown as Record<PropertyKey, unknown>)[RTC_SIGNAL_RECEIVER_KEY] as (
      payload: unknown,
    ) => boolean;

    expect(receive({ peer: "viewer-a", lane: "lane-a", payload: { type: "video", id: 31 } })).toBe(
      false,
    );
    expect(onError).toHaveBeenCalledWith(failure);
    expect(binding).toHaveBeenCalledWith(
      JSON.stringify({
        peer: "viewer-a",
        lane: "lane-a",
        payload: { type: "video-notice", notice: "drm", id: 31 },
      }),
    );
  });

  it("reports an unavailable video capture without creating a peer or crashing", () => {
    const binding = vi.fn();
    const setupPeer = vi.fn();
    const fakePlugin = {
      initPlugin: vi.fn(() => ({ name: "rtc", options: {} }) as never),
      setupPeer,
      setupStream: vi.fn(),
      signalReceive: vi.fn(),
    };
    const scope = {
      [RTC_SIGNAL_BINDING_NAME]: binding,
    } as unknown as typeof globalThis;
    const rtc = installCanvasRtcRecord({
      constructors: captureRtcConstructors(scope),
      scope,
      createPlugin: () => fakePlugin,
    });
    rtc.plugin.getMirror?.({
      nodeMirror: {
        getNode: () => ({ nodeType: 1, nodeName: "VIDEO", captureStream: undefined }),
      },
    } as never);
    const receive = (scope as unknown as Record<PropertyKey, unknown>)[RTC_SIGNAL_RECEIVER_KEY] as (
      payload: unknown,
    ) => boolean;

    expect(receive({ peer: "viewer-a", lane: "lane-a", payload: { type: "video", id: 32 } })).toBe(
      false,
    );
    expect(setupPeer).not.toHaveBeenCalled();
    expect(fakePlugin.setupStream).not.toHaveBeenCalled();
    expect(binding).toHaveBeenCalledWith(
      JSON.stringify({
        peer: "viewer-a",
        lane: "lane-a",
        payload: { type: "video-notice", notice: "unavailable", id: 32 },
      }),
    );
  });

  it("stops an audio-only capture and destroys the empty peer", () => {
    const binding = vi.fn();
    const audioTrack = { kind: "audio", stop: vi.fn() };
    const peer = { destroy: vi.fn() };
    const fakePlugin = {
      peer,
      initPlugin: vi.fn(() => ({ name: "rtc", options: {} }) as never),
      setupPeer: vi.fn(),
      setupStream: vi.fn(
        () =>
          ({
            getTracks: () => [audioTrack],
            getVideoTracks: () => [],
          }) as unknown as MediaStream,
      ),
      signalReceive: vi.fn(),
    };
    const scope = { [RTC_SIGNAL_BINDING_NAME]: binding } as unknown as typeof globalThis;
    const rtc = installCanvasRtcRecord({
      constructors: captureRtcConstructors(scope),
      scope,
      createPlugin: () => fakePlugin,
    });
    rtc.plugin.getMirror?.({
      nodeMirror: {
        getNode: () => ({ nodeType: 1, nodeName: "VIDEO", captureStream: vi.fn() }),
      },
    } as never);
    const receive = (scope as unknown as Record<PropertyKey, unknown>)[RTC_SIGNAL_RECEIVER_KEY] as (
      payload: unknown,
    ) => boolean;

    expect(receive({ peer: "viewer-a", lane: "lane-a", payload: { type: "video", id: 33 } })).toBe(
      false,
    );
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(peer.destroy).toHaveBeenCalledOnce();
    expect(binding).toHaveBeenCalledWith(
      JSON.stringify({
        peer: "viewer-a",
        lane: "lane-a",
        payload: { type: "video-notice", notice: "unavailable", id: 33 },
      }),
    );
  });

  it("owns an independent peer and captureStream per viewer lane and tears both down", () => {
    const binding = vi.fn();
    const peers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
    const tracks: Array<{ stop: ReturnType<typeof vi.fn>; kind: string }> = [];
    const plugins: Array<{
      peer: { destroy: ReturnType<typeof vi.fn> };
      initPlugin: ReturnType<typeof vi.fn>;
      setupPeer: ReturnType<typeof vi.fn>;
      setupStream: ReturnType<typeof vi.fn>;
      signalReceive: ReturnType<typeof vi.fn>;
    }> = [];
    const scope = { [RTC_SIGNAL_BINDING_NAME]: binding } as unknown as typeof globalThis;
    const rtc = installCanvasRtcRecord({
      constructors: captureRtcConstructors(scope),
      scope,
      createPlugin(signalSend) {
        const peer = { destroy: vi.fn() };
        const track = { kind: "video", stop: vi.fn() };
        const stream = {
          getTracks: () => [track],
          getVideoTracks: () => [track],
        } as unknown as MediaStream;
        const plugin = {
          peer,
          initPlugin: vi.fn(() => ({ getMirror: vi.fn() }) as never),
          setupPeer: vi.fn(),
          setupStream: vi.fn(() => stream),
          signalReceive: vi.fn((signal) => signalSend(signal)),
        };
        peers.push(peer);
        tracks.push(track);
        plugins.push(plugin);
        return plugin;
      },
    });
    rtc.plugin.getMirror?.({
      nodeMirror: {
        getNode: () => ({ nodeType: 1, nodeName: "VIDEO", captureStream: vi.fn() }),
      },
    } as never);
    const receive = (scope as unknown as Record<PropertyKey, unknown>)[RTC_SIGNAL_RECEIVER_KEY] as (
      payload: unknown,
    ) => boolean;

    expect(receive({ peer: "viewer-a", lane: "a1", payload: { type: "video", id: 1 } })).toBe(true);
    expect(receive({ peer: "viewer-b", lane: "b1", payload: { type: "video", id: 1 } })).toBe(true);
    expect(plugins).toHaveLength(2);

    expect(receive({ peer: "viewer-a", lane: "a1", payload: { type: "close" } })).toBe(true);
    expect(peers[0]?.destroy).toHaveBeenCalledOnce();
    expect(tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(peers[1]?.destroy).not.toHaveBeenCalled();
    expect(tracks[1]?.stop).not.toHaveBeenCalled();
  });
});
