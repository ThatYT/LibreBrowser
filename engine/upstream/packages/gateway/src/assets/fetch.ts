/**
 * Asset fetch lanes.
 *
 * Lane A is the default and reads CDP's base64 IO stream in bounded chunks. Lane B is used
 * for Range requests and as the automatic fallback when Lane A cannot be established.
 * Browser-plane access is injected through CdpSend; this module never imports the browser.
 *
 * Content-Type is copied only from response headers. No URL-based inference happens here.
 */
import { Readable } from "node:stream";
import { request as undiciRequest } from "undici";

import type { CdpSend } from "../types";
import type { AssetRef } from "./token";

const IO_CHUNK_BYTES = 64 * 1024;

type HeaderValue = string | readonly string[] | undefined;

export interface AssetFetchRequest {
  ref: AssetRef;
  /** Forwarded byte-for-byte to Lane B. Its presence selects Lane B immediately. */
  range?: string;
}

export interface AssetFetchResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Readable;
  lane: "cdp" | "direct";
}

export interface DirectResponse {
  statusCode: number;
  headers: Record<string, HeaderValue>;
  body: AsyncIterable<Uint8Array>;
}

export type DirectRequest = (
  url: string,
  options: { headers: Record<string, string> },
) => Promise<DirectResponse>;

export interface AssetFetcherDeps {
  send: CdpSend;
  /** Resolve the token's stable tab id to its current flat CDP session. */
  sessionFor(ref: AssetRef): string | undefined | Promise<string | undefined>;
  /** Optional integration override; otherwise Page.getFrameTree supplies the valid frame id. */
  frameFor?: (ref: AssetRef, cdpSessionId: string) => string | Promise<string>;
  /** Optional integration override for a session-specific UA. */
  userAgentFor?: (ref: AssetRef, cdpSessionId: string) => string | Promise<string>;
  /** Test seam around undici.request. */
  directRequest?: DirectRequest;
}

export interface AssetFetcher {
  fetch(request: AssetFetchRequest): Promise<AssetFetchResponse>;
}

interface LoadResourceResult {
  resource?: {
    success?: unknown;
    netErrorName?: unknown;
    httpStatusCode?: unknown;
    stream?: unknown;
    headers?: unknown;
  };
}

interface IoReadResult {
  data?: unknown;
  base64Encoded?: unknown;
  eof?: unknown;
}

export function createAssetFetcher(deps: AssetFetcherDeps): AssetFetcher {
  const directRequest = deps.directRequest ?? defaultDirectRequest;

  return {
    async fetch(request) {
      const cdpSessionId = await deps.sessionFor(request.ref);
      if (cdpSessionId === undefined) {
        throw new Error(`Asset tab is not attached: ${request.ref.tabId}`);
      }

      if (new URL(request.ref.url).protocol === "blob:") {
        return fetchBrowserObject(deps, request.ref, cdpSessionId);
      }

      if (request.range !== undefined) {
        return fetchDirect(deps, directRequest, request, cdpSessionId);
      }

      try {
        return await fetchThroughCdp(deps, request.ref, cdpSessionId);
      } catch {
        return fetchDirect(deps, directRequest, request, cdpSessionId);
      }
    },
  };
}

/** Object URLs are capabilities in the originating browser, not network addresses.
 * Hold the Blob there and pull bounded slices; never copy an entire image into a
 * protocol message or attempt an HTTP fallback from another process.
 */
async function fetchBrowserObject(
  deps: AssetFetcherDeps,
  ref: AssetRef,
  sessionId: string,
): Promise<AssetFetchResponse> {
  const frameId = deps.frameFor
    ? await deps.frameFor(ref, sessionId)
    : await mainFrameId(deps.send, sessionId);
  const world = (await deps.send(sessionId, "Page.createIsolatedWorld", {
    frameId,
    worldName: "mirror-assets",
  })) as { executionContextId: number };
  const result = (await deps.send(sessionId, "Runtime.evaluate", {
    contextId: world.executionContextId,
    expression: `fetch(${JSON.stringify(ref.url)}).then(r => { if (!r.ok) throw new Error('Object unavailable'); return r.blob(); })`,
    awaitPromise: true,
    returnByValue: false,
  })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
  const objectId = result.result?.objectId;
  if (!objectId) throw new Error("Browser object is unavailable or revoked");
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await deps.send(sessionId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  };
  try {
    if (result.exceptionDetails) throw new Error("Browser object is unavailable or revoked");
    const metadata = (await deps.send(sessionId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){return {size:this.size,type:this.type}}",
      returnByValue: true,
    })) as { result?: { value?: { size: number; type: string } } };
    const info = metadata.result?.value;
    if (!info || !Number.isSafeInteger(info.size) || info.size < 0)
      throw new Error("Invalid browser object metadata");
    const body = Readable.from(
      (async function* () {
        try {
          for (let offset = 0; offset < info.size; offset += IO_CHUNK_BYTES) {
            const part = (await deps.send(sessionId, "Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: `async function(offset, size) {
              const bytes = new Uint8Array(await this.slice(offset, offset + size).arrayBuffer());
              let binary = ''; for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
              return btoa(binary);
            }`,
              arguments: [{ value: offset }, { value: IO_CHUNK_BYTES }],
              awaitPromise: true,
              returnByValue: true,
            })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
            if (part.exceptionDetails || typeof part.result?.value !== "string")
              throw new Error("Browser object read failed");
            yield Buffer.from(part.result.value, "base64");
          }
        } finally {
          await release();
        }
      })(),
    );
    body.once("close", () => void release());
    return {
      statusCode: 200,
      headers: {
        "content-type": info.type || "application/octet-stream",
        "content-length": String(info.size),
      },
      body,
      lane: "cdp",
    };
  } catch (error) {
    await release();
    throw error;
  }
}

async function fetchThroughCdp(
  deps: AssetFetcherDeps,
  ref: AssetRef,
  cdpSessionId: string,
): Promise<AssetFetchResponse> {
  const frameId = deps.frameFor
    ? await deps.frameFor(ref, cdpSessionId)
    : await mainFrameId(deps.send, cdpSessionId);
  const loaded = (await deps.send(cdpSessionId, "Network.loadNetworkResource", {
    frameId,
    url: ref.url,
    options: { includeCredentials: true, disableCache: false },
  })) as LoadResourceResult;
  const resource = loaded.resource;
  if (resource?.success !== true) {
    const detail = typeof resource?.netErrorName === "string" ? `: ${resource.netErrorName}` : "";
    throw new Error(`CDP asset load failed${detail}`);
  }

  const statusCode = positiveStatus(resource.httpStatusCode, 200);
  const headers = normalizeHeaders(resource.headers);
  if (statusCode >= 300 && statusCode < 400) {
    if (typeof resource.stream === "string") await closeCdpStream(deps.send, cdpSessionId, resource.stream);
    throw new Error("Follow asset redirects in the filtered direct fetch lane");
  }
  // Network.loadNetworkResource exposes the decoded representation on its IO stream but keeps
  // the upstream transfer headers. Forwarding (for example) `content-encoding: br` with decoded
  // favicon bytes makes the viewer decode them a second time; the original compressed length is
  // wrong for the same reason. Let the gateway frame the decoded body it actually sends.
  delete headers["content-encoding"];
  delete headers["content-length"];
  if (typeof resource.stream !== "string") {
    return { statusCode, headers, body: Readable.from([]), lane: "cdp" };
  }

  const handle = resource.stream;
  let first: { chunk: Buffer; eof: boolean };
  try {
    // Establish the IO stream before returning so experimental-CDP failures still fall back.
    first = await readCdpChunk(deps.send, cdpSessionId, handle);
  } catch (error) {
    await closeCdpStream(deps.send, cdpSessionId, handle);
    throw error;
  }

  const body = Readable.from(
    (async function* () {
      try {
        if (first.chunk.length > 0) yield first.chunk;
        let eof = first.eof;
        while (!eof) {
          const next = await readCdpChunk(deps.send, cdpSessionId, handle);
          if (next.chunk.length > 0) yield next.chunk;
          eof = next.eof;
        }
      } finally {
        await closeCdpStream(deps.send, cdpSessionId, handle);
      }
    })(),
  );
  return { statusCode, headers, body, lane: "cdp" };
}

async function fetchDirect(
  deps: AssetFetcherDeps,
  directRequest: DirectRequest,
  request: AssetFetchRequest,
  cdpSessionId: string,
): Promise<AssetFetchResponse> {
  const userAgent = deps.userAgentFor
    ? await deps.userAgentFor(request.ref, cdpSessionId)
    : await browserUserAgent(deps.send, cdpSessionId);
  let url = request.ref.url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Unsupported asset redirect");
    }
    // Re-select cookies at EACH destination; never forward one origin's Cookie header to another.
    const cookiesResult = await deps.send(cdpSessionId, "Network.getCookies", { urls: [url] });
    const headers: Record<string, string> = { "user-agent": userAgent };
    const cookie = cookieHeader(cookiesResult);
    if (cookie !== "") headers.cookie = cookie;
    if (request.range !== undefined) headers.range = request.range;
    const response = await directRequest(url, { headers });
    const normalized = normalizeHeaders(response.headers);
    const location = normalized.location;
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && typeof location === 'string') {
      // Consume at most one chunk; breaking closes Node's stream instead of buffering a body.
      for await (const _chunk of response.body) { break; }
      url = new URL(location, url).href;
      continue;
    }
    return { statusCode: positiveStatus(response.statusCode, 502), headers: normalized,
      body: Readable.from(response.body), lane: "direct" };
  }
  throw new Error("Too many asset redirects");
}

async function defaultDirectRequest(
  url: string,
  options: { headers: Record<string, string> },
): Promise<DirectResponse> {
  const response = await undiciRequest(url, {
    method: "GET",
    headers: options.headers,
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
  };
}

async function mainFrameId(send: CdpSend, cdpSessionId: string): Promise<string> {
  const result = (await send(cdpSessionId, "Page.getFrameTree")) as {
    frameTree?: { frame?: { id?: unknown } };
  };
  const frameId = result.frameTree?.frame?.id;
  if (typeof frameId !== "string" || frameId === "") {
    throw new Error("CDP did not return a valid main frame id");
  }
  return frameId;
}

async function browserUserAgent(send: CdpSend, cdpSessionId: string): Promise<string> {
  const result = (await send(cdpSessionId, "Browser.getVersion")) as { userAgent?: unknown };
  if (typeof result.userAgent !== "string" || result.userAgent === "") {
    throw new Error("CDP did not return the browser User-Agent");
  }
  return result.userAgent;
}

function cookieHeader(value: unknown): string {
  const cookies = record(value).cookies;
  if (!Array.isArray(cookies)) return "";
  return cookies
    .flatMap((cookie) => {
      const item = record(cookie);
      return typeof item.name === "string" && typeof item.value === "string"
        ? [`${item.name}=${item.value}`]
        : [];
    })
    .join("; ");
}

async function readCdpChunk(
  send: CdpSend,
  cdpSessionId: string,
  handle: string,
): Promise<{ chunk: Buffer; eof: boolean }> {
  const result = (await send(cdpSessionId, "IO.read", {
    handle,
    size: IO_CHUNK_BYTES,
  })) as IoReadResult;
  if (typeof result.data !== "string") throw new Error("CDP IO.read returned invalid data");
  return {
    chunk: Buffer.from(result.data, result.base64Encoded === true ? "base64" : "utf8"),
    eof: result.eof === true,
  };
}

async function closeCdpStream(send: CdpSend, cdpSessionId: string, handle: string): Promise<void> {
  await send(cdpSessionId, "IO.close", { handle }).catch(() => undefined);
}

function normalizeHeaders(value: unknown): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  if (Array.isArray(value)) {
    for (const header of value) {
      const item = record(header);
      if (typeof item.name === "string" && typeof item.value === "string") {
        output[item.name.toLowerCase()] = item.value;
      }
    }
    return output;
  }
  if (typeof value !== "object" || value === null) return output;
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw === "string") output[name.toLowerCase()] = raw;
    else if (Array.isArray(raw) && raw.every((part) => typeof part === "string")) {
      output[name.toLowerCase()] = raw;
    }
  }
  return output;
}

function positiveStatus(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
