import { tr } from "../librebrowser-i18n";
/** Download UI outside the mirrored document. */
import type { Down } from "@mirror/protocol";

export type DownloadEntry = Extract<Down, { t: "download" }>;

export interface DownloadTrayProps {
  downloads: readonly DownloadEntry[];
  onDismiss: (id: string) => void;
}

/** Upsert a progress message without moving an existing download in the tray. */
export function updateDownloads(
  downloads: readonly DownloadEntry[],
  message: DownloadEntry,
): DownloadEntry[] {
  const index = downloads.findIndex((download) => download.id === message.id);
  if (index < 0) return [...downloads, message];
  const next = [...downloads];
  next[index] = message;
  return next;
}

export function dismissDownload(downloads: readonly DownloadEntry[], id: string): DownloadEntry[] {
  return downloads.filter((download) => download.id !== id);
}

function progressPercent(download: DownloadEntry): number | null {
  if (download.state === "done") return 100;
  if (download.total <= 0) return null;
  return Math.round(Math.min(1, Math.max(0, download.recv / download.total)) * 100);
}

function formatBytes(value: number): string {
  const safeValue = Math.max(0, value);
  if (safeValue < 1024) return `${safeValue} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = safeValue;
  let unit = "B";
  for (const candidate of units) {
    amount /= 1024;
    unit = candidate;
    if (amount < 1024) break;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function DownloadItem({
  download,
  onDismiss,
}: {
  download: DownloadEntry;
  onDismiss: (id: string) => void;
}) {
  const percent = progressPercent(download);
  const progressText =
    download.total > 0
      ? `${percent ?? 0}% · ${formatBytes(download.recv)} of ${formatBytes(download.total)}`
      : `${formatBytes(download.recv)} received`;

  return (
    <li class="download-entry" data-download-id={download.id} data-state={download.state}>
      <div class="download-entry-heading">
        <span class="download-name" title={download.name}>
          {download.name}
        </span>
        <button
          class="download-dismiss"
          type="button"
          aria-label={`Dismiss ${download.name}`}
          onClick={() => onDismiss(download.id)}
        >
          ×
        </button>
      </div>

      {download.state === "active" && (
        <>
          <progress
            aria-label={`Downloading ${download.name}`}
            max={download.total > 0 ? download.total : undefined}
            value={
              download.total > 0 ? Math.min(Math.max(0, download.recv), download.total) : undefined
            }
          />
          <span class="download-status" aria-live="polite">
            {progressText}
          </span>
        </>
      )}

      {download.state === "done" && (
        <div class="download-complete">
          <span class="download-status">{tr("Complete", "完成")}</span>
          {download.href === undefined ? (
            <span class="download-preparing">{tr("Preparing…", "准备中…")}</span>
          ) : (
            <a class="download-save" href={download.href} download={download.name}>
              {tr("Save", "保存")}
            </a>
          )}
        </div>
      )}

      {download.state === "canceled" && <span class="download-status">{tr("Canceled", "已取消")}</span>}
    </li>
  );
}

export function DownloadTray({ downloads, onDismiss }: DownloadTrayProps) {
  return (
    <aside
      id="download-tray-layer"
      aria-label={tr("Downloads", "下载")}
      aria-hidden={downloads.length === 0 ? "true" : undefined}
    >
      {downloads.length > 0 && (
        <section class="download-tray">
          <h2>Downloads</h2>
          <ul>
            {downloads.map((download) => (
              <DownloadItem key={download.id} download={download} onDismiss={onDismiss} />
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
