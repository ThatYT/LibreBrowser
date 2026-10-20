/**
 * Gateway side of the download flow.
 * (Viewer half P3-DOWNLOADS-V = viewer/src/chrome/downloads.tsx, viewer domain.)
 *
 * Browser.setDownloadBehavior({behavior:"allowAndName", downloadPath, eventsEnabled:true});
 * map GUID -> suggestedFilename from downloadWillBegin (downloads from OOPIF subframes emit on
 * the BROWSER session, not the page session); `download` progress msgs; one-time random link
 * /s/:sid/d/:key — cookie-guarded via auth/middleware.ts (SEC-2), single redemption, filename
 * only ever used in Content-Disposition (path traversal via suggestedFilename is a bug even in
 * a trusted-viewer tool). Files reaped with the session.
 */
import type { Down } from "@mirror/protocol";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";

import type { SessionGuard } from "./auth/middleware";
import type { BrowserHandle, BrowserSessionEventMap } from "./browser/launch";

type DownloadMsg = Extract<Down, { t: "download" }>;

interface DownloadRecord {
  guid: string;
  name: string;
  href?: string;
}

interface DownloadClaim {
  filePath: string;
  name: string;
}

export interface DownloadManagerOptions {
  sessionId: string;
  browser: BrowserHandle;
  /** The session-owned directory passed to Chromium and removed by BrowserHostSession.remove(). */
  downloadDir: string;
  publish(message: DownloadMsg): void;
  /** Test seam; production keys are 192 random bits encoded for URLs. */
  createKey?: () => string;
  onError?: (error: unknown) => void;
}

export interface DownloadManager {
  readonly sessionId: string;
  /** Atomically consumes a completed download link. Intended for registerDownloadRoutes only. */
  claim(key: string): DownloadClaim | undefined;
  close(): void;
}

export interface DownloadRouteOptions {
  /** SEC-2's exact session-cookie guard; intentionally required with no permissive fallback. */
  preHandler: SessionGuard["preHandler"];
  managerFor(sessionId: string): DownloadManager | undefined;
}

interface DownloadRouteParams {
  sid: string;
  key: string;
}

export async function createDownloadManager(
  options: DownloadManagerOptions,
): Promise<DownloadManager> {
  const sessionId = nonEmpty(options.sessionId, "sessionId");
  const downloadDir = nonEmpty(options.downloadDir, "downloadDir");
  const sendBrowser = options.browser.sendBrowser;
  if (sendBrowser === undefined || options.browser.onBrowserEvent === undefined) {
    throw new Error("download flow requires browser/root CDP commands and events");
  }

  const report = options.onError ?? (() => undefined);
  const createKey = options.createKey ?? (() => randomBytes(24).toString("base64url"));
  const downloads = new Map<string, DownloadRecord>();
  const links = new Map<string, DownloadRecord>();
  let closed = false;

  const offWillBegin = options.browser.onBrowserEvent(
    "Browser.downloadWillBegin",
    (event: BrowserSessionEventMap["Browser.downloadWillBegin"]) => {
      if (closed) return;
      try {
        assertFileComponent(event.guid, "download GUID");
        downloads.set(event.guid, {
          guid: event.guid,
          name: event.suggestedFilename || "download",
        });
      } catch (error) {
        report(error);
      }
    },
  );
  const offProgress = options.browser.onBrowserEvent(
    "Browser.downloadProgress",
    (event: BrowserSessionEventMap["Browser.downloadProgress"]) => {
      if (closed) return;
      try {
        const record = downloads.get(event.guid);
        if (record === undefined) return;
        const state = wireState(event.state);
        if (state === "done" && record.href === undefined) {
          const key = uniqueKey(createKey, links);
          record.href = `/s/${encodeURIComponent(sessionId)}/d/${key}`;
          links.set(key, record);
        }
        options.publish({
          t: "download",
          id: event.guid,
          name: record.name,
          recv: event.receivedBytes,
          total: event.totalBytes,
          state,
          ...(record.href === undefined ? {} : { href: record.href }),
        });
      } catch (error) {
        report(error);
      }
    },
  );

  try {
    await sendBrowser("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });
  } catch (error) {
    offWillBegin();
    offProgress();
    throw error;
  }

  return {
    sessionId,
    claim(key) {
      if (closed) return undefined;
      const record = links.get(key);
      if (record === undefined) return undefined;
      // No await occurs between lookup and deletion, so concurrent requests cannot both win.
      links.delete(key);
      return {
        // allowAndName writes the GUID. The suggested filename never participates in this path.
        filePath: join(downloadDir, record.guid),
        name: record.name,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      offWillBegin();
      offProgress();
      downloads.clear();
      links.clear();
    },
  };
}

export function registerDownloadRoutes(app: FastifyInstance, options: DownloadRouteOptions): void {
  if (typeof options.preHandler !== "function") {
    throw new TypeError("download route requires the SEC-2 session preHandler");
  }

  app.get<{ Params: DownloadRouteParams }>(
    "/s/:sid/d/:key",
    { preHandler: options.preHandler },
    async (request, reply) => {
      const claim = options.managerFor(request.params.sid)?.claim(request.params.key);
      if (claim === undefined) {
        return reply.code(404).send({ error: "Download not found" });
      }
      reply.header("content-disposition", contentDisposition(claim.name));
      reply.type("application/octet-stream");
      return reply.send(createReadStream(claim.filePath));
    },
  );
}

function wireState(
  state: BrowserSessionEventMap["Browser.downloadProgress"]["state"],
): DownloadMsg["state"] {
  if (state === "inProgress") return "active";
  return state === "completed" ? "done" : "canceled";
}

function uniqueKey(createKey: () => string, links: Map<string, DownloadRecord>): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const key = createKey();
    if (key !== "" && /^[A-Za-z0-9_-]+$/.test(key) && !links.has(key)) return key;
  }
  throw new Error("could not mint a unique download key");
}

function assertFileComponent(value: string, name: string): void {
  if (
    value === "" ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`${name} must be one path component`);
  }
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\\r\n]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encode5987(name)}`;
}

function encode5987(value: string): string {
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    encoded += /^[A-Za-z0-9!#$&+.^_`|~-]$/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim() === "") throw new TypeError(`${name} must not be empty`);
  return value;
}
