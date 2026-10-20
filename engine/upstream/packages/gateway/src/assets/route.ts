/**
 * Asset-proxy route GET /s/:sid/a/:token.
 *
 * SEC-2 supplies the optional preHandler. The default deliberately does nothing.
 *
 * ============================ THE ONE POLICY CHECK (§7.2) ============================
 * After token decryption, reject private/loopback/carrier-NAT/link-local targets, including
 * 169.254.169.254 cloud metadata. There are no other URL or content policy checks here.
 * ======================================================================================
 */
import type {
  FastifyInstance,
  FastifyReply,
  preHandlerAsyncHookHandler,
  preHandlerHookHandler,
} from "fastify";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { AssetCache, CachedAsset } from "./cache";
import type { AssetFetcher, AssetFetchResponse } from "./fetch";
import { openAssetToken, type AssetRef } from "./token";
import { rewriteFetchedStylesheet } from "./stylesheet";

interface AssetRouteParams {
  sid: string;
  "*": string;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type AssetTargetLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;
export type AssetPreHandler = preHandlerHookHandler | preHandlerAsyncHookHandler;

export interface AssetRouteDeps {
  /** LibreBrowser's isolated engine has no direct egress; both fetch lanes use its filtered proxy. */
  connectionPolicyEnforced?: boolean;
  serverKey: Buffer;
  cache: AssetCache;
  fetcher: AssetFetcher;
  preHandler?: AssetPreHandler;
  /** Test/deployment seam; all returned addresses are checked before fetching. */
  lookup?: AssetTargetLookup;
}

export function registerAssetRoutes(app: FastifyInstance, deps: AssetRouteDeps): void {
  const preHandler: AssetPreHandler = deps.preHandler ?? (async () => undefined);
  const lookup = deps.lookup ?? defaultLookup;

  app.get<{ Params: AssetRouteParams }>(
    // A wildcard preserves the public /:token shape while avoiding Fastify's 100-byte named
    // parameter ceiling; AES-GCM tokens are intentionally longer than that.
    "/s/:sid/a/*",
    { preHandler },
    async (request, reply) => {
      let ref: AssetRef;
      try {
        ref = openAssetToken(request.params["*"], deps.serverKey);
      } catch {
        return reply.code(400).send({ error: "Invalid asset token" });
      }
      if (ref.sessionId !== request.params.sid) {
        return reply.code(404).send({ error: "Asset session not found" });
      }

      try {
        if (deps.connectionPolicyEnforced) {
          const protocol = new URL(ref.url).protocol;
          if (protocol !== "http:" && protocol !== "https:" && protocol !== "blob:") throw new PrivateAssetTargetError();
        } else {
          await rejectPrivateAssetTarget(ref.url, lookup);
        }
      } catch (error) {
        if (error instanceof PrivateAssetTargetError) {
          return reply.code(403).send({ error: "Private asset target rejected" });
        }
        return reply.code(502).send({ error: "Asset target could not be resolved" });
      }

      const range = request.headers.range;
      const cacheKey = assetCacheKey(ref);
      if (range === undefined) {
        const cached = await deps.cache.get(cacheKey);
        if (cached !== undefined) return sendCached(reply, cached);
      }

      let response: AssetFetchResponse;
      try {
        response = await deps.fetcher.fetch({ ref, ...(range === undefined ? {} : { range }) });
        if (range === undefined)
          response = await rewriteFetchedStylesheet(response, ref, deps.serverKey);
      } catch {
        return reply.code(502).send({ error: "Asset fetch failed" });
      }

      if (range === undefined && response.statusCode === 200) {
        try {
          const stored = await deps.cache.put(cacheKey, response.body, {
            statusCode: response.statusCode,
            headers: response.headers,
          });
          return sendCached(reply, stored);
        } catch {
          return reply.code(502).send({ error: "Asset stream failed" });
        }
      }

      applyResponse(reply, response.statusCode, response.headers);
      return reply.send(response.body);
    },
  );
}

/** Resolve-then-check every address so a hostname cannot hide a private destination. */
export async function rejectPrivateAssetTarget(
  target: string,
  lookup: AssetTargetLookup = defaultLookup,
): Promise<void> {
  const parsed = new URL(target);
  // Object URLs belong to this browser, not DNS or a direct HTTP fallback.
  if (parsed.protocol === "blob:") return;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PrivateAssetTargetError();
  }
  const hostname = unbracket(parsed.hostname);
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily === 0 ? await lookup(hostname) : [{ address: hostname, family: literalFamily }];
  if (addresses.length === 0) throw new Error("Asset target resolved to no addresses");
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new PrivateAssetTargetError();
  }
}

class PrivateAssetTargetError extends Error {
  constructor() {
    super("Private asset target rejected");
    this.name = "PrivateAssetTargetError";
  }
}

async function defaultLookup(hostname: string): Promise<readonly ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function isPrivateAddress(address: string): boolean {
  const normalized = unbracket(address).toLowerCase();
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return false;

  const words = parseIpv6(normalized);
  if (words === undefined) return false;
  if (words.every((word) => word === 0)) return true;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  const first = words[0]!;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;

  const embeddedIpv4 =
    words.slice(0, 5).every((word) => word === 0) && (words[5] === 0 || words[5] === 0xffff);
  if (!embeddedIpv4) return false;
  return isPrivateIpv4(
    `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`,
  );
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || second === undefined) return false;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254)
  );
}

function parseIpv6(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const parsedLeft = parseHextets(left);
  const parsedRight = parseHextets(right);
  if (parsedLeft === undefined || parsedRight === undefined) return undefined;
  const missing = 8 - parsedLeft.length - parsedRight.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  return [...parsedLeft, ...Array.from({ length: missing }, () => 0), ...parsedRight];
}

function parseHextets(parts: string[]): number[] | undefined {
  const output: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    output.push(Number.parseInt(part, 16));
  }
  return output;
}

function sendCached(reply: FastifyReply, cached: CachedAsset): FastifyReply {
  applyResponse(reply, cached.statusCode, cached.headers);
  return reply.send(cached.createReadStream());
}

function applyResponse(
  reply: FastifyReply,
  statusCode: number,
  headers: Record<string, string | string[]>,
): void {
  reply.code(statusCode);
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) reply.header(name, value);
  }
  // Font bytes are content-addressed by their sealed source URL and can be retained by the
  // browser. Determine this only from the upstream Content-Type; never sniff the token URL.
  if (isFontContentType(headerValue(headers, "content-type"))) {
    reply.header("cache-control", IMMUTABLE_FONT_CACHE_CONTROL);
  }
}

const IMMUTABLE_FONT_CACHE_CONTROL = "private, max-age=31536000, immutable";
const FONT_CONTENT_TYPES = new Set(["font/woff2", "font/woff", "font/ttf", "font/otf"]);

function headerValue(
  headers: Record<string, string | string[]>,
  target: string,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== target) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function isFontContentType(value: string | undefined): boolean {
  return (
    value !== undefined && FONT_CONTENT_TYPES.has(value.split(";", 1)[0]!.trim().toLowerCase())
  );
}

const HOP_BY_HOP_HEADERS = new Set([
  // Upstream origin controls must not control the gateway origin.
  "set-cookie",
  "clear-site-data",
  "alt-svc",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function assetCacheKey(ref: AssetRef): string {
  return JSON.stringify([ref.sessionId, ref.tabId, ref.url]);
}

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
