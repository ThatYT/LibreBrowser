/**
 * Session-cookie guard.
 *
 * Guards: WS upgrade (at upgrade time, not first message), asset, download, and upload routes.
 * Consumers (assets P2-FETCH route, browser P3-DOWNLOADS-G route) take this as a fastify
 * preHandler dependency — they never implement auth themselves.
 */
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { IncomingMessage } from "node:http";
import { type Invite, verifyInvite } from "./invite";

export const SESSION_COOKIE = "__Host-mirror-session";

export interface SessionGuardOptions {
  key: Buffer;
  cookieName?: string;
  /** Where the fragment bridge redirects after its cookie has been set. */
  appPath?: string;
  now?: () => number;
}

export interface SessionGuard {
  readonly cookieName: string;
  readonly preHandler: preHandlerAsyncHookHandler;
  readonly authorizeUpgrade: (request: IncomingMessage) => boolean;
  registerJoinRoutes(app: FastifyInstance): void;
  session(request: IncomingMessage): Invite | null;
}

interface JoinBody {
  token?: unknown;
}

export function createSessionGuard(options: SessionGuardOptions): SessionGuard {
  // Validate the key eagerly instead of discovering a deployment error on the first request.
  verifyInvite("invalid", options.key, 0);
  const cookieName = options.cookieName ?? SESSION_COOKIE;
  const appPath = options.appPath ?? "/";
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  if (!isCookieName(cookieName)) throw new TypeError("invalid session cookie name");
  if (!appPath.startsWith("/") || appPath.startsWith("//")) {
    throw new TypeError("appPath must be an origin-relative path");
  }

  const session = (request: IncomingMessage): Invite | null => {
    const token = readCookie(request.headers.cookie, cookieName);
    return token === undefined ? null : verifyInvite(token, options.key, now());
  };

  const preHandler: preHandlerAsyncHookHandler = async (request, reply) => {
    const invite = session(request.raw);
    if (invite === null || !matchesRouteSession(request, invite.sid)) {
      await reply.code(403).send({ error: "Forbidden" });
    }
  };

  return {
    cookieName,
    preHandler,
    authorizeUpgrade: (request) => session(request) !== null,
    registerJoinRoutes(app) {
      app.get("/join", async (_request, reply) => {
        return reply.type("text/html; charset=utf-8").send(joinBridge(appPath));
      });
      app.post<{ Body: JoinBody }>("/join", async (request, reply) => {
        const token = request.body?.token;
        const invite = typeof token === "string" ? verifyInvite(token, options.key, now()) : null;
        if (invite === null) return reply.code(403).send({ error: "Forbidden" });

        const maxAge = Math.max(0, invite.exp - now());
        reply.header(
          "set-cookie",
          `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
        );
        return reply.code(204).send();
      });
    },
    session,
  };
}

/** Convenience export for route modules that need only the injectable Fastify slot. */
export function createSessionPreHandler(options: SessionGuardOptions): preHandlerAsyncHookHandler {
  return createSessionGuard(options).preHandler;
}

function matchesRouteSession(request: FastifyRequest, sid: string): boolean {
  const params = request.params;
  if (typeof params !== "object" || params === null) return true;
  const routeSid = (params as Record<string, unknown>).sid;
  return routeSid === undefined || routeSid === sid;
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

function isCookieName(value: string): boolean {
  return value.length > 0 && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

/**
 * Browsers never send a fragment in HTTP. This same-origin bridge moves it into a POST body,
 * scrubs it from browser history, then lets the server establish the HttpOnly cookie.
 */
function joinBridge(appPath: string): string {
  const destination = JSON.stringify(appPath).replaceAll("<", "\\u003c");
  return `<!doctype html>
<meta charset="utf-8">
<title>Joining session</title>
<p id="status">Joining session…</p>
<script>
(async () => {
  const token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  if (!token) throw new Error("Invite token missing");
  const response = await fetch("/join", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  if (!response.ok) throw new Error("Invite rejected");
  location.replace(${destination});
})().catch((error) => {
  document.getElementById("status").textContent = error.message;
});
</script>`;
}
