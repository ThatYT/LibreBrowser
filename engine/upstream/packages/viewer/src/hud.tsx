import { tr } from "./librebrowser-i18n";
/** Compact connection diagnostics outside the mirrored document. */
import type { Down, TabId } from "@mirror/protocol";
import type { GatewayConnectionState } from "./ws";
import type { ResyncTabState } from "./resync";

type Tab = Extract<Down, { t: "tabs" }>["tabs"][number];

export interface HudProps {
  connection: GatewayConnectionState;
  rttMs: number | null;
  bufferMs: number;
  activeTab: TabId | null;
  tabs: readonly Tab[];
  modeByTab: Readonly<Record<TabId, "dom" | "px" | undefined>>;
  resyncByTab: Readonly<Record<TabId, ResyncTabState | undefined>>;
  viewerId: string | null;
  driverId: string | null;
}

export function HudLayer(props: HudProps) {
  return (
    <aside id="viewer-hud-layer" aria-label={tr("Viewer diagnostics", "连接诊断")}>
      <Hud {...props} />
    </aside>
  );
}

export function Hud({
  connection,
  rttMs,
  bufferMs,
  activeTab,
  tabs,
  modeByTab,
  resyncByTab,
  viewerId,
  driverId,
}: HudProps) {
  const states = Object.values(resyncByTab).filter(
    (state): state is ResyncTabState => state !== undefined,
  );
  const stateByTab = new Map(states.map((state) => [state.tab, state]));
  const stormTabs = states.filter((state) => state.storm).map((state) => state.tab);
  const totalResyncs = states.reduce((total, state) => total + state.totalResyncs, 0);
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  const tabIds = new Set<TabId>([
    ...tabs.map((tab) => tab.id),
    ...Object.keys(modeByTab),
    ...states.map((state) => state.tab),
  ]);
  const roundedRtt = rttMs === null ? null : Math.round(rttMs);
  const driver =
    driverId === null ? "Waiting…" : driverId === viewerId ? `${driverId} (you)` : driverId;

  return (
    <details
      id="resync-hud"
      class="connection-hud"
      data-connection={connection}
      data-resync-storm={stormTabs.length > 0 ? "true" : "false"}
      data-resync-storm-tabs={stormTabs.join(",")}
      data-resync-total={String(totalResyncs)}
      data-rtt-ms={roundedRtt === null ? "" : String(roundedRtt)}
    >
      <summary aria-label={tr("Toggle connection diagnostics", "显示连接诊断")}>
        <span class="hud-state-dot" aria-hidden="true" />
        <span>{roundedRtt === null ? "RTT —" : `${roundedRtt} ms`}</span>
        {stormTabs.length > 0 && <strong class="hud-storm-pill">DOM ISSUE</strong>}
      </summary>
      <section class="hud-panel">
        <dl class="hud-metrics">
          <div>
            <dt>{tr("Connection", "连接")}</dt>
            <dd>{connection}</dd>
          </div>
          <div>
            <dt>RTT</dt>
            <dd>{roundedRtt === null ? "Measuring…" : `${roundedRtt} ms`}</dd>
          </div>
          <div>
            <dt>{tr("Live buffer", "缓冲")}</dt>
            <dd>{Math.round(bufferMs)} ms</dd>
          </div>
          <div>
            <dt>{tr("Driver", "控制者")}</dt>
            <dd title={driverId ?? undefined}>{driver}</dd>
          </div>
          <div>
            <dt>{tr("Resyncs", "重新同步")}</dt>
            <dd>{totalResyncs}</dd>
          </div>
        </dl>

        {stormTabs.length > 0 && (
          <div class="hud-storm" role="alert">
            {tr("This page could not be mirrored reliably. Reload or choose pixel fallback.", "此网页无法稳定地本地渲染，请重新加载或选择像素回退。")}: {stormTabs.join(", ")}
          </div>
        )}

        <div class="hud-tabs" aria-label={tr("Tab modes", "标签页渲染模式")}>
          <h2>Tab modes</h2>
          {tabIds.size === 0 ? (
            <p>No tabs</p>
          ) : (
            <ul>
              {[...tabIds].map((tabId) => {
                const tab = tabById.get(tabId);
                const resync = stateByTab.get(tabId);
                return (
                  <li key={tabId} data-active={tabId === activeTab ? "true" : "false"}>
                    <span class="hud-tab-title" title={tab?.url ?? tabId}>
                      {tab?.title || tabId}
                    </span>
                    <span class="hud-mode" data-mode={modeByTab[tabId] ?? "dom"}>
                      {modeByTab[tabId] ?? "dom"}
                    </span>
                    <span class="hud-resync-count">{resync?.totalResyncs ?? 0} resync</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </details>
  );
}
