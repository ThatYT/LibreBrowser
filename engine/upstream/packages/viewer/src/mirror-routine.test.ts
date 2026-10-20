import type { eventWithTime } from "@mirror/protocol";
import { EventType } from "@mirror/protocol";
import { vi, describe, expect, it } from "vitest";

const fakeRrweb = vi.hoisted(() => {
  class FakeMediaElement {
    currentTime = 4.25;
    playbackRate = 1.5;
    volume = 0.4;
    muted = true;
    loop = true;
    playCalls = 0;
    pauseCalls = 0;
    mutedAtPlay: boolean[] = [];
    rejectPlay = false;
    throwPlay = false;

    constructor(public paused: boolean) {}

    play(): Promise<void> {
      this.playCalls += 1;
      this.mutedAtPlay.push(this.muted);
      if (this.throwPlay) throw new Error("synthetic synchronous autoplay rejection");
      if (this.rejectPlay) return Promise.reject(new Error("synthetic autoplay rejection"));
      this.paused = false;
      return Promise.resolve();
    }

    pause(): void {
      this.pauseCalls += 1;
      this.paused = true;
    }
  }

  class FakeReplayer {
    static instances: FakeReplayer[] = [];
    static throwNextAdd = false;
    static nextMediaElements: FakeMediaElement[] = [];
    static corruptMediaOnPause = false;
    readonly cursorStyle = {
      pointerEvents: "auto",
      priority: "",
      setProperty: (property: string, value: string, priority: string) => {
        if (property === "pointer-events") this.cursorStyle.pointerEvents = value;
        this.cursorStyle.priority = priority;
      },
    };
    readonly iframe: HTMLIFrameElement;
    readonly added: eventWithTime[] = [];
    readonly handlers = new Map<string, Set<() => void>>();
    readonly config: {
      insertStyleRules?: string[];
      pauseAnimation?: boolean;
      liveMode?: boolean;
      useVirtualDom?: boolean;
      plugins?: unknown[];
    };
    readonly initialEvents: eventWithTime[];
    readonly mediaElements: FakeMediaElement[];
    readonly iframeAttributes = new Map<string, string>();
    /** Ordered trace of the sync-cast-to-live bridge so a "fix" cannot silently drop pause(). */
    readonly calls: string[] = [];
    destroyed = false;

    constructor(events: eventWithTime[], config: FakeReplayer["config"]) {
      this.config = config;
      this.initialEvents = events;
      this.mediaElements = FakeReplayer.nextMediaElements;
      FakeReplayer.nextMediaElements = [];
      this.iframe = {
        sandbox: ["allow-same-origin"],
        style: { pointerEvents: "none" },
        contentDocument: {
          querySelectorAll: () => this.mediaElements,
        },
        setAttribute: vi.fn((name: string, value: string) => {
          this.iframeAttributes.set(name, value);
        }),
        getAttribute: (name: string) => this.iframeAttributes.get(name) ?? null,
        parentElement: {
          querySelectorAll: () => [{ style: this.cursorStyle }],
        },
      } as unknown as HTMLIFrameElement;
      FakeReplayer.instances.push(this);
    }

    on(event: string, handler: () => void) {
      const handlers = this.handlers.get(event) ?? new Set();
      handlers.add(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    off(event: string, handler: () => void) {
      this.handlers.get(event)?.delete(handler);
      return this;
    }

    play() {
      this.calls.push("play");
      if (this.initialEvents.some((event) => event.type === EventType.FullSnapshot)) {
        for (const handler of [...(this.handlers.get("fullsnapshot-rebuilded") ?? [])]) handler();
      }
    }
    pause() {
      this.calls.push("pause");
      for (const media of this.mediaElements) {
        media.pause();
        if (FakeReplayer.corruptMediaOnPause) {
          media.currentTime = 0;
          media.playbackRate = 1;
          media.volume = 1;
          media.muted = false;
          media.loop = false;
        }
      }
    }
    startLive() {
      this.calls.push("startLive");
    }

    enableInteract() {
      this.iframe.setAttribute("scrolling", "auto");
      this.iframe.style.pointerEvents = "auto";
    }

    addEvent(event: eventWithTime) {
      if (FakeReplayer.throwNextAdd) {
        FakeReplayer.throwNextAdd = false;
        throw new Error("synthetic add failure");
      }
      this.added.push(event);
      if (event.type === EventType.FullSnapshot) {
        for (const handler of [...(this.handlers.get("fullsnapshot-rebuilded") ?? [])]) handler();
      }
    }

    destroy() {
      this.destroyed = true;
    }
  }

  return { FakeMediaElement, FakeReplayer };
});

vi.mock("@rrweb/replay", () => ({ Replayer: fakeRrweb.FakeReplayer }));

import { createMirror } from "./mirror";
import { EventPipeline } from "./pipeline";
import { RebuildRestoreHooks } from "./rebuild-restore";
import { REPLAY_CURSOR_PASSTHROUGH_RULE } from "./replay-cursor";

class FakeElement {
  className = "";
  textContent = "";
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  clientWidth = 800;
  clientHeight = 600;
  readonly children: FakeElement[] = [];
  removed = false;

  constructor(readonly ownerDocument: FakeDocument) {}

  replaceChildren(...children: FakeElement[]) {
    this.children.splice(0, this.children.length, ...children);
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }

  setAttribute() {}

  remove() {
    this.removed = true;
  }
}

class FakeDocument {
  createElement() {
    return new FakeElement(this);
  }
}

function full(timestamp: number): eventWithTime {
  return { type: EventType.FullSnapshot, timestamp, data: {} } as eventWithTime;
}

function meta(timestamp: number, width: number, height: number): eventWithTime {
  return {
    type: EventType.Meta,
    timestamp,
    data: { href: "https://example.test/", width, height },
  } as eventWithTime;
}

function delta(timestamp: number): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp,
    data: { source: 3, id: 1, x: 0, y: 1 },
  } as eventWithTime;
}

describe("D10 recovery triggers", () => {
  it("rebuilds the Replayer for a trim epoch and runs interaction restore hooks", () => {
    fakeRrweb.FakeReplayer.instances.length = 0;
    const document = new FakeDocument();
    const container = new FakeElement(document) as unknown as HTMLElement;
    let captures = 0;
    let restores = 0;
    const mirror = createMirror({
      container,
      pipeline: new EventPipeline(),
      restoreHooks: new RebuildRestoreHooks().use({
        capture() {
          captures += 1;
          return { typing: true };
        },
        restore(_iframe, state) {
          if (state.typing) restores += 1;
        },
      }),
      requestResync: () => {},
      adaptiveBuffer: false,
    });

    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 1,
      seq: 1,
      reason: "nav",
      data: [full(1_000)],
    });
    const original = fakeRrweb.FakeReplayer.instances[0]!;
    expect(original.iframe.getAttribute("scrolling")).toBe("auto");
    expect(original.iframe.style.pointerEvents).toBe("auto");
    expect(original.config.insertStyleRules).toContain(REPLAY_CURSOR_PASSTHROUGH_RULE);
    expect(original.cursorStyle).toMatchObject({ pointerEvents: "none", priority: "important" });

    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 2,
      seq: 2,
      reason: "trim",
      data: [full(1_100)],
    });

    expect(fakeRrweb.FakeReplayer.instances).toHaveLength(2);
    expect(original.destroyed).toBe(true);
    expect(fakeRrweb.FakeReplayer.instances[1]!.initialEvents).toEqual([full(1_100)]);
    expect(captures).toBe(1);
    expect(restores).toBe(1);
  });

  it("disables rrweb pauseAnimation so CSS entrance animations stay live, keeping the cast-to-live order", () => {
    // Regression guard for the blank-SPA bug: rrweb's default pauseAnimation freezes CSS
    // animations (opacity 0->1 reveals) at their 0% keyframe, and the fix must NOT be a
    // deletion of the load-bearing pause() (that would strand the machine out of `live` and
    // drop the server-clock jitter baseline). Assert both halves.
    fakeRrweb.FakeReplayer.instances.length = 0;
    const document = new FakeDocument();
    const container = new FakeElement(document) as unknown as HTMLElement;
    const mirror = createMirror({
      container,
      pipeline: new EventPipeline(),
      requestResync: () => {},
      adaptiveBuffer: false,
    });

    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 1,
      seq: 1,
      reason: "nav",
      data: [meta(1_000, 800, 600), full(1_001)],
    });

    const replayer = fakeRrweb.FakeReplayer.instances[0]!;
    expect(replayer.config.pauseAnimation).toBe(false);
    expect(replayer.config.liveMode).toBe(true);
    expect(replayer.calls).toEqual(["play", "pause", "startLive"]);
  });

  it("restores recorded playback state after startLive and absorbs rejected autoplay", async () => {
    fakeRrweb.FakeReplayer.instances.length = 0;
    fakeRrweb.FakeReplayer.corruptMediaOnPause = true;
    const playing = new fakeRrweb.FakeMediaElement(false);
    playing.rejectPlay = true;
    const synchronouslyBlocked = new fakeRrweb.FakeMediaElement(false);
    synchronouslyBlocked.throwPlay = true;
    fakeRrweb.FakeReplayer.nextMediaElements = [playing, synchronouslyBlocked];
    const document = new FakeDocument();
    const container = new FakeElement(document) as unknown as HTMLElement;
    const mirror = createMirror({
      container,
      pipeline: new EventPipeline(),
      requestResync: () => {},
      adaptiveBuffer: false,
    });

    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 1,
      seq: 1,
      reason: "nav",
      data: [full(1_000)],
    });
    await Promise.resolve();

    expect(fakeRrweb.FakeReplayer.instances[0]!.calls).toEqual(["play", "pause", "startLive"]);
    expect(playing).toMatchObject({
      currentTime: 4.25,
      playbackRate: 1.5,
      volume: 0.4,
      muted: true,
      loop: true,
      pauseCalls: 1,
      playCalls: 1,
      mutedAtPlay: [true],
    });
    expect(synchronouslyBlocked).toMatchObject({ playCalls: 1, mutedAtPlay: [true] });
    expect((container as unknown as FakeElement).dataset.mirrorState).toBe("live");
    fakeRrweb.FakeReplayer.corruptMediaOnPause = false;
  });

  it("does not restart media left paused by a buffered media-interaction delta", () => {
    fakeRrweb.FakeReplayer.instances.length = 0;
    const paused = new fakeRrweb.FakeMediaElement(true);
    fakeRrweb.FakeReplayer.nextMediaElements = [paused];
    const document = new FakeDocument();
    const container = new FakeElement(document) as unknown as HTMLElement;
    const mirror = createMirror({
      container,
      pipeline: new EventPipeline(),
      requestResync: () => {},
      adaptiveBuffer: false,
    });

    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 1,
      seq: 2,
      reason: "resync",
      data: [full(1_000), delta(1_001)],
    });

    expect(paused.paused).toBe(true);
    expect(paused.pauseCalls).toBe(1);
    expect(paused.playCalls).toBe(0);
  });

  it.each(["nav", "trim", "viewport", "resync"] as const)(
    "resumes full-snapshot media after a %s rebuild",
    (reason) => {
      fakeRrweb.FakeReplayer.instances.length = 0;
      const first = new fakeRrweb.FakeMediaElement(false);
      fakeRrweb.FakeReplayer.nextMediaElements = [first];
      const document = new FakeDocument();
      const container = new FakeElement(document) as unknown as HTMLElement;
      const mirror = createMirror({
        container,
        pipeline: new EventPipeline(),
        requestResync: () => {},
        adaptiveBuffer: false,
      });
      mirror.handle({
        t: "snapshot",
        tab: "T1",
        epoch: 1,
        seq: 1,
        reason: "nav",
        data: [full(1_000)],
      });

      const rebuiltMedia = new fakeRrweb.FakeMediaElement(false);
      fakeRrweb.FakeReplayer.nextMediaElements = [rebuiltMedia];
      mirror.handle({ t: "resync", tab: "T1" });
      mirror.handle({
        t: "snapshot",
        tab: "T1",
        epoch: reason === "resync" ? 1 : 2,
        seq: 2,
        reason,
        data: [full(1_100)],
      });

      expect(first.playCalls).toBe(1);
      expect(rebuiltMedia.playCalls).toBe(1);
      expect(rebuiltMedia.paused).toBe(false);
    },
  );

  it.each(["nav", "trim", "viewport"] as const)(
    "rebuilds on every gateway %s epoch bump",
    (reason) => {
      fakeRrweb.FakeReplayer.instances.length = 0;
      const document = new FakeDocument();
      const container = new FakeElement(document) as unknown as HTMLElement;
      const mirror = createMirror({
        container,
        pipeline: new EventPipeline(),
        requestResync: () => {},
        adaptiveBuffer: false,
      });
      mirror.handle({
        t: "snapshot",
        tab: "T1",
        epoch: 1,
        seq: 1,
        reason: "nav",
        data: [full(1_000)],
      });
      const previous = fakeRrweb.FakeReplayer.instances[0]!;
      expect(previous.iframe.getAttribute("scrolling")).toBe("auto");
      mirror.handle({
        t: "snapshot",
        tab: "T1",
        epoch: 2,
        seq: 2,
        reason,
        data: [full(1_100)],
      });
      expect(fakeRrweb.FakeReplayer.instances).toHaveLength(2);
      expect(previous.destroyed).toBe(true);
      const rebuilt = fakeRrweb.FakeReplayer.instances[1]!;
      expect(rebuilt.iframe.getAttribute("scrolling")).toBe("auto");
      expect(mirror.getReplayer()).toBe(rebuilt);
    },
  );

  it("detects a seq gap, keeps the last good iframe visible, and rebuilds a same-epoch resync", () => {
    fakeRrweb.FakeReplayer.instances.length = 0;
    const document = new FakeDocument();
    const rawContainer = new FakeElement(document);
    const requests: string[] = [];
    const mirror = createMirror({
      container: rawContainer as unknown as HTMLElement,
      pipeline: new EventPipeline(),
      requestResync: (_tab, reason) => requests.push(reason),
      adaptiveBuffer: false,
    });
    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 1,
      seq: 1,
      reason: "nav",
      data: [full(1_000)],
    });
    const previous = fakeRrweb.FakeReplayer.instances[0]!;

    mirror.handle({ t: "delta", tab: "T1", epoch: 1, seq: 3, data: [delta(1_001)] });
    expect(requests).toEqual(["seq gap: expected 2, got 3"]);
    expect(mirror.getReplayer()).toBe(previous);
    expect(previous.destroyed).toBe(false);
    expect(rawContainer.dataset).toMatchObject({ mirrorState: "live", resyncPending: "true" });

    mirror.handle({ t: "resync", tab: "T1" });
    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 1,
      seq: 3,
      reason: "resync",
      data: [full(1_002)],
    });
    expect(previous.destroyed).toBe(true);
    expect(fakeRrweb.FakeReplayer.instances).toHaveLength(2);
    expect(rawContainer.dataset.resyncPending).toBeUndefined();
    expect(rawContainer.dataset.mirrorState).toBe("live");
  });

  it("turns a replayer.addEvent exception into a resync without blanking the mirror", () => {
    fakeRrweb.FakeReplayer.instances.length = 0;
    const document = new FakeDocument();
    const rawContainer = new FakeElement(document);
    const requests: string[] = [];
    const mirror = createMirror({
      container: rawContainer as unknown as HTMLElement,
      pipeline: new EventPipeline(),
      requestResync: (_tab, reason) => requests.push(reason),
      adaptiveBuffer: false,
    });
    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 1,
      seq: 1,
      reason: "nav",
      data: [full(1_000)],
    });
    const previous = fakeRrweb.FakeReplayer.instances[0]!;
    fakeRrweb.FakeReplayer.throwNextAdd = true;
    mirror.handle({ t: "delta", tab: "T1", epoch: 1, seq: 2, data: [delta(1_001)] });

    expect(requests).toEqual(["replayer.addEvent: synthetic add failure"]);
    expect(mirror.getReplayer()).toBe(previous);
    expect(previous.destroyed).toBe(false);
    expect(rawContainer.dataset.mirrorState).toBe("live");
  });

  it("keeps the mirror visible across a socket drop and requests reconnect recovery", () => {
    fakeRrweb.FakeReplayer.instances.length = 0;
    const document = new FakeDocument();
    const rawContainer = new FakeElement(document);
    const requests: string[] = [];
    const mirror = createMirror({
      container: rawContainer as unknown as HTMLElement,
      pipeline: new EventPipeline(),
      requestResync: (_tab, reason) => requests.push(reason),
      adaptiveBuffer: false,
    });
    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 1,
      seq: 1,
      reason: "nav",
      data: [full(1_000)],
    });
    const previous = mirror.getReplayer();
    mirror.connectionLost();
    expect(mirror.getReplayer()).toBe(previous);
    expect(rawContainer.dataset).toMatchObject({ mirrorState: "live", connectionStale: "true" });
    mirror.connectionRestored();
    expect(requests).toEqual(["ws reconnect"]);
    expect(rawContainer.dataset.connectionStale).toBeUndefined();
  });

  it("renews iframe interaction listeners after a routine document rebuild", () => {
    fakeRrweb.FakeReplayer.instances.length = 0;
    const document = new FakeDocument();
    const container = new FakeElement(document) as unknown as HTMLElement;
    let attached = 0;
    let detached = 0;
    const mirror = createMirror({
      container,
      pipeline: new EventPipeline(),
      attachInteraction() {
        attached += 1;
        return () => {
          detached += 1;
        };
      },
      requestResync: () => {},
      adaptiveBuffer: false,
    });

    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 1,
      seq: 1,
      reason: "nav",
      data: [full(1_000)],
    });
    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 2,
      seq: 2,
      reason: "trim",
      data: [full(1_100)],
    });

    expect({ attached, detached }).toEqual({ attached: 2, detached: 1 });
  });

  it("scopes one RTC controller to each Replayer generation and closes it on every lifecycle edge", () => {
    fakeRrweb.FakeReplayer.instances.length = 0;
    const document = new FakeDocument();
    const container = new FakeElement(document) as unknown as HTMLElement;
    const sent: Array<{ tab: string; lane: string; payload: unknown }> = [];
    const controllers: Array<{
      replayPlugin: { name: string };
      receive: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      isLive: ReturnType<typeof vi.fn>;
    }> = [];
    let lane = 0;
    const mirror = createMirror({
      container,
      pipeline: new EventPipeline(),
      requestResync: () => {},
      adaptiveBuffer: false,
      rtc: {
        createLane: () => `lane-${++lane}`,
        send: (tab, rtcLane, payload) => sent.push({ tab, lane: rtcLane, payload }),
        create: () => {
          const controller = {
            replayPlugin: { name: `plugin-${lane}` },
            receive: vi.fn(() => true),
            dispose: vi.fn(),
            isLive: vi.fn(() => false),
          };
          controllers.push(controller);
          return controller as never;
        },
      },
    });

    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 1,
      seq: 1,
      reason: "nav",
      data: [full(1_000)],
    });
    expect(fakeRrweb.FakeReplayer.instances[0]?.config.plugins).toEqual([
      controllers[0]?.replayPlugin,
    ]);
    mirror.handle({
      t: "rtc-sig",
      tab: "T1",
      lane: "stale-lane",
      from: "agent",
      payload: { type: "signal", signal: {} },
    });
    mirror.handle({
      t: "rtc-sig",
      tab: "T1",
      lane: "lane-1",
      from: "agent",
      payload: { type: "signal", signal: { sdp: "offer" } },
    });
    expect(controllers[0]?.receive).toHaveBeenCalledOnce();

    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 2,
      seq: 2,
      reason: "nav",
      data: [full(1_100)],
    });
    expect(controllers[0]?.dispose).toHaveBeenCalledOnce();
    expect(sent).toContainEqual({ tab: "T1", lane: "lane-1", payload: { type: "close" } });

    mirror.selectTab("T2");
    expect(controllers[1]?.dispose).toHaveBeenCalledOnce();
    expect(sent).toContainEqual({ tab: "T1", lane: "lane-2", payload: { type: "close" } });
    mirror.handle({
      t: "snapshot",
      tab: "T2",
      epoch: 1,
      seq: 1,
      reason: "nav",
      data: [full(1_200)],
    });
    mirror.connectionLost();
    expect(controllers[2]?.dispose).toHaveBeenCalledOnce();
    expect(sent).toContainEqual({ tab: "T2", lane: "lane-3", payload: { type: "close" } });
    expect(mirror.getReplayer()).not.toBeNull();
    mirror.teardown();
    expect(controllers[2]?.dispose).toHaveBeenCalledOnce();
  });

  it("reports an applied viewport epoch only after replay and CSS-scales a follower to fit", () => {
    fakeRrweb.FakeReplayer.instances.length = 0;
    const document = new FakeDocument();
    const container = new FakeElement(document) as unknown as HTMLElement;
    const applied: Array<{ epoch: number; reason?: string }> = [];
    const mirror = createMirror({
      container,
      pipeline: new EventPipeline(),
      onSnapshotApplied(snapshot) {
        applied.push({ epoch: snapshot.epoch, reason: snapshot.reason });
      },
      requestResync: () => {},
      adaptiveBuffer: false,
    });

    mirror.handle({
      t: "hello",
      viewerId: "follower-1",
      role: "viewer",
      sessionId: "S1",
    });
    mirror.handle({
      t: "snapshot",
      tab: "T1",
      epoch: 1,
      seq: 2,
      reason: "viewport",
      data: [meta(1_000, 1_600, 900), full(1_001)],
    });

    const stage = (container as unknown as FakeElement).children[0]!;
    const mount = stage.children[0]!;
    expect(stage.className).toBe("mirror-stage");
    expect(mount.dataset.viewportRole).toBe("follower");
    expect(mount.style).toMatchObject({
      width: "1600px",
      height: "900px",
      transform: "scale(0.5)",
    });
    expect(applied).toEqual([{ epoch: 1, reason: "viewport" }]);
  });
});
