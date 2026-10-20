/**
 * ACCESS-GATE — outer, device-level password front door.
 *
 * This deliberately composes outside SEC-2's invite/session authorization. A successful
 * password exchange remembers only a signed issuance timestamp; the password is never stored in
 * a cookie (or logged).
 */
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const ACCESS_COOKIE = "__Host-mirror-access";
export const ACCESS_MAX_AGE_SECONDS = 60 * 24 * 60 * 60;

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const DEFAULT_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const FAILURE_RESET_MS = 15 * 60_000;

export interface AccessGateOptions {
  /** Defaults to MIRROR_ACCESS_PASSWORD. There is intentionally no built-in password. */
  password?: string;
  /** Defaults to MIRROR_ACCESS_SECRET, or a random value for this process boot. */
  secret?: Buffer;
  appPath?: string;
  maxAgeSeconds?: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  backoffMs?: number;
  /**
   * Extra `set-cookie` values to emit alongside the access cookie on a correct password.
   * The owner's single-user deployment uses this to grant the SEC-2 session in the same
   * exchange, so enrolling a device needs the password only — no separate invite link, whose
   * URL fragment was silently lost whenever the gate redirect ran first. The invite routes
   * stay available for minting narrower (e.g. read-only) sessions.
   */
  cookiesOnSuccess?: () => readonly string[];
}

export interface AccessGate {
  readonly cookieName: typeof ACCESS_COOKIE;
  readonly preHandler: preHandlerAsyncHookHandler;
  readonly authorizeUpgrade: (request: IncomingMessage) => boolean;
  registerRoutes(app: FastifyInstance): void;
  hasValidDevice(request: IncomingMessage): boolean;
}

interface GateBody {
  password?: unknown;
}

interface AccessPayload {
  issuedAt: number;
}

interface FailureState {
  failures: number;
  blockedUntil: number;
  lastFailure: number;
}

export function createAccessGate(options: AccessGateOptions = {}): AccessGate {
  const env = options.env ?? process.env;
  const password = options.password ?? env.MIRROR_ACCESS_PASSWORD;
  const configuredSecret = env.MIRROR_ACCESS_SECRET;
  const secret =
    options.secret ??
    (configuredSecret === undefined || configuredSecret === ""
      ? randomBytes(32)
      : Buffer.from(configuredSecret, "utf8"));
  const appPath = options.appPath ?? "/";
  const maxAgeSeconds = options.maxAgeSeconds ?? ACCESS_MAX_AGE_SECONDS;
  const now = options.now ?? Date.now;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  if (password === undefined || password.length === 0) {
    throw new TypeError("MIRROR_ACCESS_PASSWORD must be set to a non-empty value");
  }
  if (secret.length === 0) throw new TypeError("access HMAC secret must not be empty");
  if (!isOriginRelativePath(appPath)) {
    throw new TypeError("appPath must be an origin-relative path");
  }
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new RangeError("maxAgeSeconds must be a positive safe integer");
  }
  if (!Number.isSafeInteger(backoffMs) || backoffMs <= 0) {
    throw new RangeError("backoffMs must be a positive safe integer");
  }

  const failuresByIp = new Map<string, FailureState>();

  const hasValidDevice = (request: IncomingMessage): boolean => {
    const token = readCookie(request.headers.cookie, ACCESS_COOKIE);
    return token !== undefined && verifyAccessToken(token, secret, maxAgeSeconds, now());
  };

  const preHandler: preHandlerAsyncHookHandler = async (request, reply) => {
    if (isPublicPath(request.raw.url) || hasValidDevice(request.raw)) return;
    if (request.method === "GET" || request.method === "HEAD") {
      await reply.code(302).header("location", "/gate").send();
      return;
    }
    await reply
      .code(401)
      .header("location", "/gate")
      .send({ error: "Access password required", gate: "/gate" });
  };

  return {
    cookieName: ACCESS_COOKIE,
    preHandler,
    authorizeUpgrade: hasValidDevice,
    registerRoutes(app) {
      if (!app.hasContentTypeParser(FORM_CONTENT_TYPE)) {
        app.addContentTypeParser(
          FORM_CONTENT_TYPE,
          { parseAs: "string" },
          (_request, body, done) => {
            done(null, parseForm(typeof body === "string" ? body : body.toString("utf8")));
          },
        );
      }

      app.get("/gate", async (request, reply) => {
        if (hasValidDevice(request.raw)) {
          return reply.code(302).header("location", appPath).send();
        }
        return sendGatePage(reply, 200);
      });

      app.post<{ Body: GateBody }>("/gate", async (request, reply) => {
        const requestTime = now();
        const prior = failuresByIp.get(request.ip);
        if (prior !== undefined && requestTime - prior.lastFailure >= FAILURE_RESET_MS) {
          failuresByIp.delete(request.ip);
        } else if (prior !== undefined && requestTime < prior.blockedUntil) {
          const retryAfter = Math.max(1, Math.ceil((prior.blockedUntil - requestTime) / 1_000));
          reply.header("retry-after", String(retryAfter));
          return sendGatePage(reply, 429, "Too many attempts. Please wait and try again.");
        }

        const submitted = request.body?.password;
        if (typeof submitted !== "string" || !constantTimePasswordEqual(submitted, password)) {
          const failures = (failuresByIp.get(request.ip)?.failures ?? 0) + 1;
          const delay = Math.min(MAX_BACKOFF_MS, backoffMs * 2 ** Math.min(failures - 1, 16));
          failuresByIp.set(request.ip, {
            failures,
            blockedUntil: requestTime + delay,
            lastFailure: requestTime,
          });
          return sendGatePage(reply, 401, "Incorrect password.");
        }

        failuresByIp.delete(request.ip);
        const token = mintAccessToken(Math.floor(requestTime / 1_000), secret);
        reply.header(
          "set-cookie",
          `${ACCESS_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`,
        );
        for (const cookie of options.cookiesOnSuccess?.() ?? []) {
          reply.header("set-cookie", cookie);
        }
        return reply.code(303).header("location", appPath).send();
      });
    },
    hasValidDevice,
  };
}

function mintAccessToken(issuedAt: number, secret: Buffer): string {
  const payload = Buffer.from(
    JSON.stringify({ issuedAt } satisfies AccessPayload),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

function verifyAccessToken(
  token: string,
  secret: Buffer,
  maxAgeSeconds: number,
  nowMs: number,
): boolean {
  const pieces = token.split(".");
  if (pieces.length !== 2) return false;
  const [payload, encodedSignature] = pieces;
  if (!isBase64Url(payload) || !isBase64Url(encodedSignature)) return false;

  let signature: Buffer;
  let decoded: unknown;
  try {
    signature = Buffer.from(encodedSignature, "base64url");
    if (signature.toString("base64url") !== encodedSignature) return false;
    const payloadBytes = Buffer.from(payload, "base64url");
    if (payloadBytes.toString("base64url") !== payload) return false;
    decoded = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return false;
  }

  const expected = sign(payload, secret);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return false;
  if (!isAccessPayload(decoded)) return false;
  const nowSeconds = Math.floor(nowMs / 1_000);
  return decoded.issuedAt <= nowSeconds && nowSeconds - decoded.issuedAt < maxAgeSeconds;
}

function constantTimePasswordEqual(submitted: string, configured: string): boolean {
  const submittedDigest = createHash("sha256").update(submitted, "utf8").digest();
  const configuredDigest = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(submittedDigest, configuredDigest);
}

function sign(payload: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(payload, "ascii").digest();
}

function parseForm(body: string): GateBody {
  const form = new URLSearchParams(body);
  return { password: form.get("password") ?? undefined };
}

function sendGatePage(
  reply: Parameters<preHandlerAsyncHookHandler>[1],
  status: number,
  error?: string,
): unknown {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(gatePage(error));
}

function gatePage(error?: string): string {
  const errorMarkup = error === undefined ? "" : `<p role="alert">${escapeHtml(error)}</p>`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mirror access</title>
<main>
  <h1>Mirror access</h1>
  ${errorMarkup}
  <form method="post" action="/gate">
    <label>Password <input name="password" type="password" required autofocus autocomplete="current-password"></label>
    <button type="submit">Enter</button>
  </form>
</main>
</html>`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const piece of header.split(";")) {
    const separator = piece.indexOf("=");
    if (separator < 0 || piece.slice(0, separator).trim() !== name) continue;
    const value = piece.slice(separator + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

function isAccessPayload(value: unknown): value is AccessPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 &&
    Number.isSafeInteger(record.issuedAt) &&
    (record.issuedAt as number) >= 0
  );
}

function isBase64Url(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isOriginRelativePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

function isPublicPath(rawUrl: string | undefined): boolean {
  const path = new URL(rawUrl ?? "/", "http://gateway.invalid").pathname;
  return path === "/gate" || path === "/healthz";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
