import { connectBrowser, type BrowserHandle } from "./launch";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

interface VersionResponse {
  webSocketDebuggerUrl: string;
}

export interface RemoteBrowserOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestJson?: (url: string) => Promise<unknown>;
  connect?: (webSocketEndpoint: string) => Promise<BrowserHandle>;
  resolveHost?: (hostname: string) => Promise<string>;
}

/**
 * Discover and connect to a Chromium DevTools endpoint without exposing CDP on the host.
 * Chromium commonly advertises a loopback websocket URL, so the configured HTTP authority
 * replaces the advertised authority before Puppeteer connects.
 */
export async function connectRemoteBrowser(
  cdpBaseUrl: string,
  options: RemoteBrowserOptions = {},
): Promise<BrowserHandle> {
  const base = parseBaseUrl(cdpBaseUrl);
  if (isIP(base.hostname) === 0) {
    const resolveHost = options.resolveHost ?? resolveFirstAddress;
    base.hostname = await resolveHost(base.hostname);
  }
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  const requestJson = options.requestJson ?? fetchJson;
  const connect = options.connect ?? connectBrowser;
  const versionUrl = new URL("json/version", base).href;
  const version = await waitForVersion(versionUrl, requestJson, timeoutMs, pollIntervalMs);
  const endpoint = new URL(version.webSocketDebuggerUrl);
  if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
    throw new Error("Chromium advertised an invalid websocket protocol");
  }
  endpoint.host = base.host;
  return connect(endpoint.href);
}

function parseBaseUrl(value: string): URL {
  const base = new URL(value.endsWith("/") ? value : `${value}/`);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("BROWSER_CDP_URL must use http or https");
  }
  if (base.username !== "" || base.password !== "") {
    throw new Error("BROWSER_CDP_URL must not contain credentials");
  }
  return base;
}

async function waitForVersion(
  url: string,
  requestJson: (url: string) => Promise<unknown>,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<VersionResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      const payload = await requestJson(url);
      if (
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as Record<string, unknown>).webSocketDebuggerUrl === "string"
      ) {
        return payload as VersionResponse;
      }
      lastError = new Error("CDP version response omitted webSocketDebuggerUrl");
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`Chromium CDP did not become ready within ${timeoutMs}ms`, { cause: lastError });
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`CDP readiness returned HTTP ${response.status}`);
  return response.json();
}

async function resolveFirstAddress(hostname: string): Promise<string> {
  return (await lookup(hostname)).address;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
