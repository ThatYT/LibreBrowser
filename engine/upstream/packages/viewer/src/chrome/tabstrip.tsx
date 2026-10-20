import { tr } from "../librebrowser-i18n";
/**
 * Viewer tab strip.
 * (Gateway half P2-TABS-G = gateway/src/session/tabs.ts, browser domain.)
 * Renders `tabs` Down msgs; sends `nav` activate/newtab/close.
 */
import type { Down, TabId, TabMeta, Up } from "@mirror/protocol";

type ChromeState = Extract<Down, { t: "chrome" }>;
type TabNav = Extract<Up, { t: "nav" }>;

export interface TabStripProps {
  tabs: readonly TabMeta[];
  chromeByTab?: Readonly<Record<TabId, ChromeState | undefined>>;
  send(message: TabNav): void;
  onActivate?(tab: TabId): void;
}

export function TabStrip({ tabs, chromeByTab = {}, send, onActivate }: TabStripProps) {
  const activeTab = tabs.find((tab) => tab.active) ?? tabs[0];
  const activate = (tab: TabId) => {
    onActivate?.(tab);
    send({ t: "nav", tab, action: "activate" });
  };

  return (
    <nav id="tabstrip" aria-label={tr("Browser tabs", "浏览器标签页")}>
      <div role="tablist">
        {tabs.map((tab) => {
          const chrome = chromeByTab[tab.id];
          const url = chrome?.url ?? tab.url;
          const loading = chrome?.loading ?? false;
          const label = tab.title || url || tr("New tab", "新标签页");
          return (
            <div
              className="browser-tab"
              data-active={tab.active || undefined}
              data-loading={loading || undefined}
              key={tab.id}
            >
              <button
                className="tab-activate"
                type="button"
                role="tab"
                aria-selected={tab.active}
                aria-controls="mirror-host"
                title={url}
                onClick={() => activate(tab.id)}
              >
                {tab.favicon === undefined ? (
                  <span className="tab-favicon-placeholder" aria-hidden="true" />
                ) : (
                  <img
                    className="tab-favicon"
                    src={tab.favicon}
                    alt=""
                    onLoad={(event) => {
                      event.currentTarget.hidden = false;
                    }}
                    onError={(event) => {
                      // The asset proxy intentionally preserves upstream failures. Hide the
                      // browser's broken-image glyph when a site's icon cannot be fetched.
                      event.currentTarget.hidden = true;
                    }}
                  />
                )}
                <span className="tab-title">{label}</span>
                <span className="tab-loading" aria-label={loading ? "Loading" : undefined} />
              </button>
              <button
                className="tab-close"
                type="button"
                aria-label={`${tr("Close", "关闭")} ${label}`}
                onClick={() => send({ t: "nav", tab: tab.id, action: "close" })}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button
        id="new-tab"
        type="button"
        aria-label={tr("New tab", "新标签页")}
        onClick={() => send({ t: "nav", tab: activeTab?.id ?? "", action: "newtab" })}
      >
        +
      </button>
    </nav>
  );
}
