/**
 * Sandboxed rrweb mirror and stream-order state machine.
 *
 * The viewer never repairs a divergent document. Any gap or replay failure discards the entire
 * Replayer (including its iframe) when a fresh snapshot is ready (D10). The last known-good
 * iframe remains visible during recovery and is atomically replaced, so recovery never exposes
 * a white/status-only interval.
 */
import { Replayer } from "@rrweb/replay";
import { EventType, type Down, type eventWithTime, type TabId } from "@mirror/protocol";
import { createServerClock, type ServerClock } from "./clock";
import type { EventPipeline } from "./pipeline";
import {
  createRebuildRestoreHooks,
  type RebuildRestoreHooks,
  type RebuildRestorePoint,
} from "./rebuild-restore";
import { enforceReplayCursorPassthrough, REPLAY_CURSOR_PASSTHROUGH_RULE } from "./replay-cursor";
import {
  createCanvasRtc,
  type CanvasRtc,
  type CanvasRtcMessage,
  type CanvasRtcOptions,
} from "./media/canvas-rtc";

type Snapshot = Extract<Down, { t: "snapshot" }>;
type Delta = Extract<Down, { t: "delta" }>;

export interface Mirror {
  handle(msg: Down): void;
  connectionLost(): void;
  connectionRestored(): void;
  selectTab(tab: TabId): void;
  getActiveTab(): TabId | null;
  getIframe(): HTMLIFrameElement | null;
  getReplayer(): Replayer | null;
  observeRtt(rttMs: number): void;
  /** Recompute follower fit scaling after the outer viewer changes size. */
  refreshViewportLayout(): void;
  /** Tear down the Replayer and its iframe. */
  teardown(): void;
}

export interface MirrorOpts {
  container: HTMLElement;
  pipeline: EventPipeline;
  bufferMs?: number;
  requestResync(tab: TabId, reason: string): void;
  now?: () => number;
  minBufferMs?: number;
  adaptiveBuffer?: boolean;
  clock?: ServerClock;
  /** Shared with Phase-1 echo so predicted edit state can join the rebuild restore point. */
  restoreHooks?: RebuildRestoreHooks;
  /** Phase-1 listeners live inside this Replayer's iframe and must be renewed on rebuild. */
  attachInteraction?(tab: TabId, replayer: Replayer): () => void;
  onSnapshotApplied?(snapshot: Pick<Snapshot, "tab" | "epoch" | "reason">): void;
  /** WebRTC is created and destroyed with each Replayer generation. */
  rtc?: MirrorRtcOptions;
}

export interface MirrorRtcOptions {
  send(tab: TabId, lane: string, payload: CanvasRtcMessage | { type: "close" }): void;
  create?: (options: CanvasRtcOptions) => CanvasRtc;
  createLane?: () => string;
  onError?: (error: unknown) => void;
}

interface LiveRtc {
  lane: string;
  controller: CanvasRtc;
}

interface LiveState {
  tab: TabId;
  epoch: number;
  lastSeq: number;
  replayer: Replayer;
  stage: HTMLDivElement;
  mount: HTMLDivElement;
  detachInteraction: () => void;
  detachMediaRestore: () => void;
  rtc: LiveRtc | null;
}

interface MediaRestoreState {
  target: HTMLMediaElement;
  shouldPlay: boolean;
  currentTime: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
  loop: boolean;
}

function captureMediaState(iframe: HTMLIFrameElement): MediaRestoreState[] {
  const document = iframe.contentDocument;
  if (document === null) return [];
  return Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video"), (target) => ({
    target,
    shouldPlay: !target.paused,
    currentTime: target.currentTime,
    playbackRate: target.playbackRate,
    volume: target.volume,
    muted: target.muted,
    loop: target.loop,
  }));
}

function restoreMediaState(states: readonly MediaRestoreState[]): void {
  for (const state of states) {
    const { target } = state;
    // A malformed or not-yet-ready media resource must not turn a best-effort live resume into
    // snapshot recovery. Apply properties independently so muted autoplay still gets its chance.
    try {
      target.muted = state.muted;
    } catch {}
    try {
      target.loop = state.loop;
    } catch {}
    try {
      target.volume = state.volume;
    } catch {}
    try {
      target.playbackRate = state.playbackRate;
    } catch {}
    try {
      target.currentTime = state.currentTime;
    } catch {}
    if (!state.shouldPlay) continue;
    try {
      void target.play().catch(() => {
        // Audible autoplay can be rejected without a user gesture; retain the recorded mute state.
      });
    } catch {
      // Some media implementations can reject play() synchronously.
    }
  }
}

function armLiveMediaRestore(replayer: Replayer): {
  captureAfterSynchronousCast(): void;
  restoreAfterStartLive(): void;
  detach(): void;
} {
  let live = false;
  let fullSnapshotBuilt = false;
  let states: MediaRestoreState[] = [];
  const capture = () => {
    fullSnapshotBuilt = true;
    if (!live) states = captureMediaState(replayer.iframe);
  };
  // Keep this independent of armRestore(): media repair is unconditional, while interaction
  // restore is a conditional one-shot. Full snapshots cast after TO_LIVE need no repair because
  // rrweb's MediaManager already sees a non-paused player and applies their media state directly.
  replayer.on("fullsnapshot-rebuilded", capture);
  return {
    captureAfterSynchronousCast() {
      // A join buffer may contain media-interaction deltas after the FullSnapshot. Capture once
      // more after every synchronous event is cast so a later legitimate pause/play wins.
      if (fullSnapshotBuilt && !live) states = captureMediaState(replayer.iframe);
    },
    restoreAfterStartLive() {
      live = true;
      restoreMediaState(states);
      states = [];
    },
    detach() {
      live = true;
      states = [];
      replayer.off("fullsnapshot-rebuilded", capture);
    },
  };
}

export function createMirror(opts: MirrorOpts): Mirror {
  const now = opts.now ?? Date.now;
  const clock =
    opts.clock ??
    createServerClock({
      now,
      bufferMs: opts.bufferMs,
      minBufferMs: opts.minBufferMs,
      adaptive: opts.adaptiveBuffer,
    });
  const restoreHooks = opts.restoreHooks ?? createRebuildRestoreHooks();
  let activeTab: TabId | null = null;
  let state: LiveState | null = null;
  let resyncRequested = false;
  let pendingRestore: RebuildRestorePoint | null = null;
  let viewerId: string | null = null;
  let isDriver = true;
  let remoteViewport: { w: number; h: number } | null = null;

  const disposeRtc = (tab: TabId, rtc: LiveRtc | null) => {
    if (rtc === null) return;
    try {
      opts.rtc?.send(tab, rtc.lane, { type: "close" });
    } catch (error) {
      opts.rtc?.onError?.(error);
    }
    rtc.controller.dispose();
  };

  const applyViewportLayout = () => {
    const live = state;
    if (live === null) return;
    live.mount.dataset.viewportRole = isDriver ? "driver" : "follower";
    opts.container.dataset.viewportRole = isDriver ? "driver" : "follower";
    if (isDriver || remoteViewport === null) {
      live.mount.style.width = "";
      live.mount.style.height = "";
      live.mount.style.transform = "";
      return;
    }
    const scale = fitViewportScale(
      remoteViewport.w,
      remoteViewport.h,
      opts.container.clientWidth,
      opts.container.clientHeight,
    );
    live.mount.style.width = `${remoteViewport.w}px`;
    live.mount.style.height = `${remoteViewport.h}px`;
    live.mount.style.transform = `scale(${scale})`;
  };

  const captureInteraction = (live: LiveState | null = state) => {
    if (live !== null) pendingRestore = restoreHooks.capture(live.replayer.iframe);
  };

  const renderStatus = (message: string) => {
    opts.container.replaceChildren();
    opts.container.dataset.mirrorState = "waiting";
    const status = opts.container.ownerDocument.createElement("p");
    status.className = "mirror-status";
    status.setAttribute("role", "status");
    status.textContent = message;
    opts.container.appendChild(status);
  };

  const discard = (message: string, preserveInteraction = false) => {
    const oldState = state;
    if (preserveInteraction) captureInteraction(oldState);
    state = null;
    opts.pipeline.reset();
    if (oldState !== null) {
      const rtc = oldState.rtc;
      oldState.rtc = null;
      disposeRtc(oldState.tab, rtc);
      oldState.detachInteraction();
      oldState.detachMediaRestore();
      try {
        oldState.replayer.destroy();
      } catch {
        // The stage is removed below even if rrweb's irreversible destroy encounters bad state.
      }
      oldState.stage.remove();
    }
    renderStatus(message);
  };

  const requestFreshSnapshot = (tab: TabId, reason: string) => {
    if (resyncRequested) return;
    resyncRequested = true;
    opts.container.dataset.resyncPending = "true";
    opts.requestResync(tab, reason);
  };

  const runPipeline = (tab: TabId, event: eventWithTime): eventWithTime | null =>
    opts.pipeline.run(event, { tab, nowMs: now() });

  const addEvent = (live: LiveState, event: eventWithTime): boolean => {
    const processed = runPipeline(live.tab, event);
    if (processed === null) return true;
    try {
      live.replayer.addEvent(processed);
      return true;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      requestFreshSnapshot(live.tab, `replayer.addEvent: ${detail}`);
      return false;
    }
  };

  const armRestore = (
    replayer: Replayer,
    restorePoint: RebuildRestorePoint | null,
    hasFullSnapshot: boolean,
  ): (() => void) => {
    if (restorePoint === null) return () => {};
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      replayer.off("fullsnapshot-rebuilded", restore);
      restoreHooks.restore(replayer.iframe, restorePoint);
    };
    if (hasFullSnapshot) replayer.on("fullsnapshot-rebuilded", restore);
    else restore();
    return () => {
      replayer.off("fullsnapshot-rebuilded", restore);
      if (!restored) pendingRestore = restorePoint;
    };
  };

  const rebuild = (message: Snapshot) => {
    if (message.reason === "nav") pendingRestore = null;
    else captureInteraction();
    const restorePoint = pendingRestore;
    pendingRestore = null;
    // The teardown and replacement happen in one synchronous websocket task. Browsers cannot
    // paint or run the chaos sampler between these operations, so the last good frame remains on
    // screen until this task commits the new iframe without overlapping two rrweb instances.
    discard("Building the mirror…");
    activeTab = message.tab;
    const stage = opts.container.ownerDocument.createElement("div");
    stage.className = "mirror-stage";
    const mount = opts.container.ownerDocument.createElement("div");
    mount.className = "mirror-replayer";
    stage.appendChild(mount);
    opts.container.replaceChildren(stage);
    opts.container.dataset.mirrorState = "building";

    const initialEvents: eventWithTime[] = [];
    remoteViewport = extractSnapshotViewport(message) ?? remoteViewport;
    for (const event of message.data) {
      const processed = runPipeline(message.tab, event);
      if (processed !== null) initialEvents.push(processed);
    }

    let replayer: Replayer | null = null;
    let rtc: LiveRtc | null = null;
    let cancelRestore = () => {};
    let mediaRestore: ReturnType<typeof armLiveMediaRestore> | null = null;
    try {
      if (opts.rtc !== undefined) {
        const lane = opts.rtc.createLane?.() ?? createRtcLane();
        const controller = (opts.rtc.create ?? createCanvasRtc)({
          document: opts.container.ownerDocument,
          send: (payload) => opts.rtc?.send(message.tab, lane, payload),
          onError: opts.rtc.onError,
        });
        rtc = { lane, controller };
      }
      replayer = new Replayer(initialEvents, {
        root: mount,
        liveMode: true,
        UNSAFE_replayCanvas: false,
        mouseTail: false,
        // rrweb inserts these rules into the replay document again after every FullSnapshot.
        // Keep replay cursor chrome visible, but permanently remove it from hit testing.
        insertStyleRules: [REPLAY_CURSOR_PASSTHROUGH_RULE],
        // Old join-buffer deltas are applied synchronously. rrweb's virtual-DOM optimization
        // otherwise waits for a replay Flush event that live addEvent() does not emit.
        useVirtualDom: false,
        // The play()->pause()->startLive() bridge below is only a synchronous-cast-to-live
        // state hop (pause() is the sole state rrweb accepts TO_LIVE from). rrweb's default
        // pauseAnimation freezes CSS animations via `html.rrweb-paused *{animation-play-state:
        // paused}`, re-injected on every FullSnapshot while not in its internal "playing"
        // state — which includes our permanent live state. That blanks any site whose content
        // is revealed by a CSS entrance animation (opacity 0->1). This mirror never exposes a
        // paused/scrub UI, so keep author animations live.
        pauseAnimation: false,
        ...(rtc === null ? {} : { plugins: [rtc.controller.replayPlugin] }),
      });

      cancelRestore = armRestore(
        replayer,
        restorePoint,
        initialEvents.some((event) => event.type === EventType.FullSnapshot),
      );
      mediaRestore = armLiveMediaRestore(replayer);

      const sandboxTokens = Array.from(replayer.iframe.sandbox);
      if (sandboxTokens.length !== 1 || sandboxTokens[0] !== "allow-same-origin") {
        throw new Error(`unexpected replay sandbox: ${sandboxTokens.join(" ")}`);
      }
      // rrweb's replay-only default disables iframe scrolling and hit testing. Phase-1 installs
      // input listeners inside that document, so the live mirror must accept native interaction.
      replayer.enableInteract();
      enforceReplayCursorPassthrough(replayer.iframe);

      // Cast the snapshot synchronously before entering live mode. Buffered deltas then land
      // immediately if old, while live-tail events retain the configured jitter window.
      if (initialEvents.length > 0) {
        const firstTs = initialEvents[0]!.timestamp;
        const lastTs = initialEvents[initialEvents.length - 1]!.timestamp;
        replayer.play(Math.max(0, lastTs - firstTs + 1));
        mediaRestore.captureAfterSynchronousCast();
        replayer.pause();
      }
      replayer.startLive(clock.liveBaseline());
      mediaRestore.restoreAfterStartLive();
    } catch (cause) {
      cancelRestore();
      mediaRestore?.detach();
      disposeRtc(message.tab, rtc);
      rtc = null;
      try {
        replayer?.destroy();
      } catch {
        // mount.remove() below is the final cleanup path.
      }
      mount.remove();
      renderStatus("Mirror recovery requested…");
      resyncRequested = true;
      opts.container.dataset.resyncPending = "true";
      const detail = cause instanceof Error ? cause.message : String(cause);
      opts.requestResync(message.tab, `snapshot replay: ${detail}`);
      return;
    }

    state = {
      tab: message.tab,
      epoch: message.epoch,
      lastSeq: message.seq,
      replayer,
      stage,
      mount,
      detachInteraction: () => {},
      detachMediaRestore: mediaRestore.detach,
      rtc,
    };
    state.detachInteraction = opts.attachInteraction?.(message.tab, replayer) ?? (() => {});
    applyViewportLayout();
    resyncRequested = false;
    delete opts.container.dataset.resyncPending;
    opts.container.dataset.mirrorState = "live";
    opts.onSnapshotApplied?.(message);
  };

  const applyDelta = (message: Delta) => {
    if (resyncRequested) return;
    const live = state;
    if (live === null) {
      if (activeTab === null) activeTab = message.tab;
      requestFreshSnapshot(message.tab, "delta before snapshot");
      return;
    }
    if (message.tab !== live.tab) return;
    if (message.epoch !== live.epoch) {
      requestFreshSnapshot(message.tab, `epoch gap: expected ${live.epoch}, got ${message.epoch}`);
      return;
    }

    // Frozen protocol assumption: delta.seq is the first event's per-tab sequence.
    const expectedSeq = live.lastSeq + 1;
    if (message.seq !== expectedSeq || message.data.length === 0) {
      requestFreshSnapshot(
        message.tab,
        message.data.length === 0
          ? "empty delta"
          : `seq gap: expected ${expectedSeq}, got ${message.seq}`,
      );
      return;
    }

    for (const event of message.data) {
      if (!addEvent(live, event)) return;
    }
    live.lastSeq = message.seq + message.data.length - 1;
  };

  renderStatus("Waiting for a snapshot…");

  return {
    handle(msg) {
      const serverTs = (msg as Down & { serverTs?: unknown }).serverTs;
      if (typeof serverTs === "number") clock.observeServerTime(serverTs, now());
      switch (msg.t) {
        case "hello":
          viewerId = msg.viewerId;
          isDriver = msg.role === "driver";
          applyViewportLayout();
          break;
        case "driver":
          isDriver = viewerId !== null && msg.viewerId === viewerId;
          applyViewportLayout();
          break;
        case "snapshot":
          if (activeTab === null || msg.tab === activeTab) {
            if (state === null || msg.epoch > state.epoch || resyncRequested) {
              rebuild(msg);
            }
          }
          break;
        case "delta":
          if (activeTab === null || msg.tab === activeTab) applyDelta(msg);
          break;
        case "resync":
          if (activeTab === null || msg.tab === activeTab) {
            activeTab = msg.tab;
            resyncRequested = true;
            opts.container.dataset.resyncPending = "true";
          }
          break;
        case "rtc-sig": {
          const live = state;
          if (
            live !== null &&
            live.tab === msg.tab &&
            live.rtc !== null &&
            live.rtc.lane === msg.lane
          ) {
            live.rtc.controller.receive(msg.payload);
          }
          break;
        }
      }
    },
    connectionLost() {
      if (state?.rtc !== null && state !== null) {
        const rtc = state.rtc;
        state.rtc = null;
        disposeRtc(state.tab, rtc);
      }
      if (state === null) renderStatus("Connection lost. Reconnecting…");
      else opts.container.dataset.connectionStale = "true";
      resyncRequested = false;
    },
    connectionRestored() {
      delete opts.container.dataset.connectionStale;
      if (activeTab !== null) requestFreshSnapshot(activeTab, "ws reconnect");
    },
    selectTab(tab) {
      if (tab === activeTab) return;
      activeTab = tab;
      pendingRestore = null;
      discard("Switching tabs…");
      resyncRequested = false;
      requestFreshSnapshot(tab, "tab selected");
    },
    getActiveTab: () => activeTab,
    getIframe: () => state?.replayer.iframe ?? null,
    getReplayer: () => state?.replayer ?? null,
    observeRtt: (rttMs) => clock.observeRtt(rttMs),
    refreshViewportLayout: applyViewportLayout,
    teardown() {
      pendingRestore = null;
      discard("Mirror stopped.");
      delete opts.container.dataset.resyncPending;
      delete opts.container.dataset.connectionStale;
      activeTab = null;
    },
  };
}

function createRtcLane(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

export function fitViewportScale(
  viewportWidth: number,
  viewportHeight: number,
  availableWidth: number,
  availableHeight: number,
): number {
  if (viewportWidth <= 0 || viewportHeight <= 0 || availableWidth <= 0 || availableHeight <= 0) {
    return 1;
  }
  return Math.min(availableWidth / viewportWidth, availableHeight / viewportHeight);
}

export function extractSnapshotViewport(
  snapshot: Pick<Snapshot, "data">,
): { w: number; h: number } | null {
  for (const event of snapshot.data) {
    if (event.type !== EventType.Meta) continue;
    if (event.data.width > 0 && event.data.height > 0) {
      return { w: event.data.width, h: event.data.height };
    }
  }
  return null;
}
