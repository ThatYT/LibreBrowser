import { tr } from "../librebrowser-i18n";
/**
 * URL bar with back, forward, and reload controls.
 * (Gateway half P1-NAV-G = gateway/src/browser/nav.ts, browser domain. Split at the wire:
 * this component only sends `nav` Up msgs and renders `chrome` Down msgs.)
 */
import { useEffect, useState } from "preact/hooks";
import type { Down, TabId, Up } from "@mirror/protocol";

type ChromeState = Extract<Down, { t: "chrome" }>;
type NavAction = Extract<Up, { t: "nav" }>["action"];

export interface UrlBarProps {
  tab: TabId | null;
  chrome: ChromeState | null;
  send(message: Extract<Up, { t: "nav" }>): void;
}

export function UrlBar({ tab, chrome, send }: UrlBarProps) {
  const [value, setValue] = useState(chrome?.url ?? "");
  useEffect(() => setValue(chrome?.url ?? ""), [chrome?.url, tab]);
  const navigate = (action: NavAction, url?: string) => {
    if (tab === null) return;
    send(url === undefined ? { t: "nav", tab, action } : { t: "nav", tab, action, url });
  };

  return (
    <nav id="urlbar" aria-label={tr("Browser navigation", "浏览器导航")}>
      <button
        type="button"
        aria-label={tr("Back", "后退")}
        disabled={tab === null || !chrome?.canBack}
        onClick={() => navigate("back")}
      >
        ←
      </button>
      <button
        type="button"
        aria-label={tr("Forward", "前进")}
        disabled={tab === null || !chrome?.canFwd}
        onClick={() => navigate("fwd")}
      >
        →
      </button>
      <button
        type="button"
        aria-label={tr("Reload", "重新加载")}
        disabled={tab === null}
        onClick={() => navigate("reload")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 7v5h-5" /><path d="M20 12a8 8 0 1 0-2 5" /></svg>
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const url = normalizeNavigationUrl(value);
          const field = event.currentTarget.querySelector("input");
          if (url === null) {
            field?.setCustomValidity(tr("Enter a valid web address.", "请输入有效的网址。"));
            field?.reportValidity();
            return;
          }
          navigate("go", url);
        }}
      >
        <span
          className="loading-indicator"
          data-loading={chrome?.loading || undefined}
          aria-hidden="true"
        />
        <input
          aria-label={tr("Address", "地址")}
          type="text"
          value={value}
          disabled={tab === null}
          autoCapitalize="off"
          autoCorrect="off"
          spellcheck={false}
          onFocus={(event) => event.currentTarget.select()}
          onInput={(event) => { event.currentTarget.setCustomValidity(""); setValue(event.currentTarget.value); }}
        />
      </form>
    </nav>
  );
}

export function normalizeNavigationUrl(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;
  const url = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:", "file:", "data:"].includes(parsed.protocol) && url !== "about:blank") return null;
    return url;
  } catch { return null; }
}
