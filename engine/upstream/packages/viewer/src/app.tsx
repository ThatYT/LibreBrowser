import { tr, connectionLabel } from "./librebrowser-i18n";
/** Viewer shell layout. */
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentMsg, Down, eventWithTime, TabId } from "@mirror/protocol";
import { EventType } from "@mirror/protocol";
import { createMirror, type Mirror } from "./mirror";
import { attachMirrorInput } from "./input";
import { EventPipeline } from "./pipeline";
import { createEchoFilter } from "./pipeline/echo";
import { createScrollFilter } from "./pipeline/scroll";
import { createRebuildRestoreHooks } from "./rebuild-restore";
import { TabStrip } from "./chrome/tabstrip";
import { UrlBar } from "./chrome/urlbar";
import { Presence } from "./chrome/presence";
import { ClipboardPrompt } from "./chrome/clipboard";
import {
  dismissDownload,
  DownloadTray,
  type DownloadEntry,
  updateDownloads,
} from "./chrome/downloads";
import { createPxView, type PxView } from "./pxview";
import { HudLayer } from "./hud";
import { createServerClock, DEFAULT_LIVE_BUFFER_MS } from "./clock";
import { createResyncController, type ResyncTabState, RESYNC_WINDOW_MS } from "./resync";
import { connectGateway, type GatewayConnectionState, type GatewaySocket } from "./ws";
import { createFileUploadRelay } from "./uploads";
import "@rrweb/replay/dist/style.css";
import "./app.css";

function gatewayUrl(): string {
  const url = new URL("/ws", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function configuredResyncWindowMs(): number {
  const raw = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_P2_RESYNC_WINDOW_MS;
  if (raw === undefined || raw === "") return RESYNC_WINDOW_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : RESYNC_WINDOW_MS;
}

async function replayFixture(path: string, mirror: Mirror): Promise<void> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
  const messages = (await response.json()) as AgentMsg[];
  const events = messages.flatMap((message): eventWithTime[] =>
    message.kind === "rrweb" ? [message.e] : [],
  );
  const snapshotEnd = events.findIndex((event) => event.type === EventType.FullSnapshot);
  if (snapshotEnd < 0) throw new Error("fixture has no FullSnapshot");
  const tab = "fixture-tab";
  mirror.handle({
    t: "snapshot",
    tab,
    epoch: 1,
    seq: snapshotEnd + 1,
    data: events.slice(0, snapshotEnd + 1),
  });
  const tail = events.slice(snapshotEnd + 1);
  if (tail.length > 0) {
    mirror.handle({
      t: "delta",
      tab,
      epoch: 1,
      seq: snapshotEnd + 2,
      data: tail,
    });
  }
}

export function App() {
  const hostRef = useRef<HTMLElement>(null);
  const socketRef = useRef<GatewaySocket | null>(null);
  const mirrorRef = useRef<Mirror | null>(null);
  const pxViewRef = useRef<PxView | null>(null);
  const dismissedDownloadIdsRef = useRef(new Set<string>());
  const [connection, setConnection] = useState<GatewayConnectionState>("connecting");
  const [activeTab, setActiveTab] = useState<TabId | null>(null);
  const [tabs, setTabs] = useState<Extract<Down, { t: "tabs" }>["tabs"]>([]);
  const [modeByTab, setModeByTab] = useState<Record<TabId, "dom" | "px" | undefined>>({});
  const [resyncByTab, setResyncByTab] = useState<Record<TabId, ResyncTabState | undefined>>({});
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [bufferMs, setBufferMs] = useState(DEFAULT_LIVE_BUFFER_MS);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [viewers, setViewers] = useState<Extract<Down, { t: "presence" }>["viewers"]>([]);
  const [clipboardText, setClipboardText] = useState<string | null>(null);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
  const [chromeByTab, setChromeByTab] = useState<
    Record<TabId, Extract<Down, { t: "chrome" }> | undefined>
  >({});

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let socket: GatewaySocket | null = null;
    let viewerId: string | null = null;
    let driver = false;
    let sessionId: string | null = null;
    let currentTab: TabId | null = null;
    let pxView: PxView | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let negotiating = true;
    let lastViewport: { tab: string; w: number; h: number; dpr: number } | null = null;
    host.dataset.inputReady = "false";
    const reportViewport = () => {
      resizeTimer = null;
      if (!driver || currentTab === null) return;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w <= 0 || h <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      if (lastViewport?.tab === currentTab && lastViewport.w === w && lastViewport.h === h && lastViewport.dpr === dpr) return;
      lastViewport = { tab: currentTab, w, h, dpr };
      negotiating = true;
      host.dataset.inputReady = "false";
      socket?.send({ t: "view", tab: currentTab, w, h, dpr });
    };
    const reportViewportNow = () => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = null;
      reportViewport();
    };
    const scheduleViewport = (delay = 300) => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(reportViewport, delay);
    };
    const echo = createEchoFilter();
    const uploads = createFileUploadRelay({
      onError: (error) => console.error("file upload failed", error),
    });
    const scroll = createScrollFilter({ send: (message) => socket?.send(message) });
    const pipeline = new EventPipeline()
      .use(echo)
      .use(scroll)
      .onReset(echo.reset)
      .onReset(scroll.reset);
    const restoreHooks = createRebuildRestoreHooks().use(echo.restoreHook);
    const clock = createServerClock({ bufferMs: DEFAULT_LIVE_BUFFER_MS });
    const resync = createResyncController({
      windowMs: configuredResyncWindowMs(),
      send: (message) => socket?.send(message),
      autoPx: () => { /* Pixel fallback is an explicit user choice in LibreBrowser. */ },
      onStateChange(state) {
        setResyncByTab((current) => ({ ...current, [state.tab]: state }));
      },
    });
    const mirror = createMirror({
      container: host,
      pipeline,
      clock,
      restoreHooks,
      rtc: {
        send(tab, lane, payload) {
          socket?.send({ t: "rtc-sig", tab, lane, payload });
        },
        onError(error) {
          console.warn("mirror media WebRTC unavailable", error);
        },
      },
      onSnapshotApplied(snapshot) {
        resync.recovered(snapshot.tab);
        // A follower may receive the driver's viewport snapshot while its replay is scaled.
        // Never pre-ack that geometry: queued follower input must stay gated across a transfer.
        if (driver && snapshot.reason === "viewport") {
          socket?.send({ t: "view-ack", tab: snapshot.tab, epoch: snapshot.epoch });
          negotiating = false;
          host.dataset.inputReady = "true";
        }
      },
      requestResync(tab, reason) {
        resync.request(tab, reason);
      },
      attachInteraction(tab, replayer) {
        return attachMirrorInput({
          replayer,
          tab,
          inputEnabled: () => !negotiating,
          send: (message) => socket?.send(message),
          onEditableFocus: echo.setFocused,
          onEditableInput: echo.input,
          onKeyDown: echo.keyDown,
          onFileSelection: (tab, input) => {
            if (driver) uploads.select(tab, input);
            else input.value = "";
          },
          scrollFilter: scroll,
        });
      },
    });
    mirrorRef.current = mirror;
    const ensurePxView = (): PxView => {
      if (pxView !== null) return pxView;
      pxView = createPxView({
        container: host,
        send: (message) => socket?.send(message),
        onEnterPx: () => mirror.teardown(),
      });
      if (currentTab !== null) pxView.selectTab(currentTab);
      pxViewRef.current = pxView;
      return pxView;
    };
    const resizeObserver = new ResizeObserver(() => {
      mirror.refreshViewportLayout();
      scheduleViewport();
    });
    resizeObserver.observe(host);
    const onWindowResize = () => scheduleViewport();
    window.addEventListener("resize", onWindowResize);
    const cleanup = () => {
      socket?.close();
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      socketRef.current = null;
      mirrorRef.current = null;
      pxViewRef.current = null;
      pxView?.destroy();
      pxView = null;
      resync.dispose();
      uploads.dispose();
      mirror.teardown();
    };

    const fixture = new URLSearchParams(window.location.search).get("fixture");
    if (fixture !== null) {
      setActiveTab("fixture-tab");
      setConnection("open");
      void replayFixture(fixture, mirror).catch((error: unknown) => {
        host.dataset.mirrorState = "error";
        host.textContent = error instanceof Error ? error.message : String(error);
      });
      return cleanup;
    }

    socket = connectGateway(
      gatewayUrl(),
      (message: Down) => {
        if (message.t === "px" || (message.t === "mode" && message.mode === "px")) {
          ensurePxView().handle(message);
        } else if (message.t === "mode") {
          pxView?.handle(message);
        }
        mirror.handle(message);
        if (message.t === "hello") {
          viewerId = message.viewerId;
          sessionId = message.sessionId;
          setViewerId(message.viewerId);
          driver = message.role === "driver";
          if (!driver) { negotiating = false; host.dataset.inputReady = "true"; }
          if (driver) setDriverId(message.viewerId);
          scheduleViewport(0);
        }
        if (message.t === "driver") {
          setDriverId(message.viewerId);
          const wasDriver = driver;
          driver = viewerId !== null && message.viewerId === viewerId;
          if (!driver) { uploads.clear(); negotiating = false; host.dataset.inputReady = "true"; }
          // Presence rebroadcasts the current driver on every join. Only a real role transition
          // needs a fresh measurement; resending an unchanged view rebuilds the remote epoch.
          if (driver && !wasDriver) { lastViewport = null; scheduleViewport(0); }
        }
        if (message.t === "presence") setViewers(message.viewers);
        if (message.t === "clip") {
          setClipboardText(message.text);
          setClipboardError(null);
        }
        if (message.t === "snapshot") {
          const tabChanged = currentTab !== message.tab;
          currentTab = message.tab;
          setActiveTab(message.tab);
          if (tabChanged) scheduleViewport(0);
        }
        if (message.t === "chrome") {
          setChromeByTab((current) => ({ ...current, [message.tab]: message }));
          setActiveTab((current) => current ?? message.tab);
        }
        if (message.t === "mode") {
          setModeByTab((current) => ({ ...current, [message.tab]: message.mode }));
        }
        if (message.t === "tabs") {
          setTabs(message.tabs);
          const active = message.tabs.find((tab) => tab.active);
          if (active !== undefined) {
            const tabChanged = currentTab !== active.id;
            currentTab = active.id;
            setActiveTab(active.id);
            pxView?.selectTab(active.id);
            if (mirror.getActiveTab() !== null && mirror.getActiveTab() !== active.id) {
              mirror.selectTab(active.id);
            }
            if (tabChanged) scheduleViewport(0);
          }
        }
        if (message.t === "download" && !dismissedDownloadIdsRef.current.has(message.id)) {
          setDownloads((current) => updateDownloads(current, message));
        }
        if (message.t === "filepick" && driver && sessionId !== null) {
          uploads.handlePick(message, sessionId);
        }
      },
      {
        onRttSample(sample) {
          clock.observeRtt(sample);
          setRttMs(sample);
          setBufferMs(clock.liveBufferMs());
        },
        onStateChange(state, reconnected) {
          setConnection(state);
          if (state === "closed") mirror.connectionLost();
          if (state === "open" && reconnected) {
            // D7: the new viewer identity has no acknowledged viewport. Put `view` on the wire
            // before recovery or queued input; the gateway epoch gate drops input until the
            // resulting viewport snapshot is acknowledged.
            lastViewport = null;
            reportViewportNow();
            mirror.connectionRestored();
          }
        },
        onProtocolError(error) {
          const tab = mirror.getActiveTab();
          if (tab !== null) resync.request(tab, error.message);
        },
      },
    );
    socketRef.current = socket;

    return cleanup;
  }, []);

  return (
    <div id="shell">
      <TabStrip
        tabs={tabs}
        chromeByTab={chromeByTab}
        onActivate={(tab) => {
          pxViewRef.current?.selectTab(tab);
          if (modeByTab[tab] !== "px") mirrorRef.current?.selectTab(tab);
          setActiveTab(tab);
        }}
        send={(message) => socketRef.current?.send(message)}
      />
      <UrlBar
        tab={activeTab}
        chrome={activeTab === null ? null : (chromeByTab[activeTab] ?? null)}
        send={(message) => socketRef.current?.send(message)}
      />
      <header id="connection-state" data-state={connection}>
        <span>{connectionLabel(connection)} · {activeTab !== null && modeByTab[activeTab] === "px" ? tr("Pixel fallback", "像素回退") : tr("Local DOM", "本地渲染")}</span>
        {viewers.length > 1 && <Presence
          viewers={viewers}
          viewerId={viewerId}
          driverId={driverId}
          send={(message) => socketRef.current?.send(message)}
        />}
        <button
          type="button"
          disabled={activeTab === null}
          onClick={() => {
            if (activeTab === null) return;
            socketRef.current?.send({
              t: "mode",
              tab: activeTab,
              mode: modeByTab[activeTab] === "px" ? "dom" : "px",
            });
          }}
        >
          {activeTab !== null && modeByTab[activeTab] === "px" ? tr("Local DOM", "本地渲染") : tr("Pixel fallback", "像素回退")}
        </button>
      </header>
      {activeTab !== null && resyncByTab[activeTab]?.storm && (
        <div id="compatibility-warning" role="alert">{tr("This page could not be mirrored reliably. Reload or choose pixel fallback.", "此网页无法稳定地本地渲染，请重新加载或选择像素回退。")}</div>
      )}
      <main id="mirror-host" ref={hostRef} />
      <HudLayer
        connection={connection}
        rttMs={rttMs}
        bufferMs={bufferMs}
        activeTab={activeTab}
        tabs={tabs}
        modeByTab={modeByTab}
        resyncByTab={resyncByTab}
        viewerId={viewerId}
        driverId={driverId}
      />
      <DownloadTray
        downloads={downloads}
        onDismiss={(id) => {
          dismissedDownloadIdsRef.current.add(id);
          setDownloads((current) => dismissDownload(current, id));
        }}
      />
      <ClipboardPrompt
        text={clipboardText}
        error={clipboardError}
        onCopied={() => {
          setClipboardText(null);
          setClipboardError(null);
        }}
        onCopyError={(error) => {
          setClipboardError(error instanceof Error ? error.message : "Clipboard write failed");
        }}
      />
    </div>
  );
}
