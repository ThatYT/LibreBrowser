/** LibreBrowser adapter: one private engine per account. Never a public authentication service. */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { preHandlerAsyncHookHandler } from "fastify";
import { ProxyAgent, setGlobalDispatcher } from "undici";

export function engineSessionId(): string {
  const id = process.env.LIBREBROWSER_USER_ID ?? "";
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("LIBREBROWSER_USER_ID is required");
  return id;
}

export function configureEngineEgress(): void {
  const proxy = new URL(process.env.CHROME_PROXY_URL ?? "");
  if (proxy.protocol !== "http:" || proxy.username || proxy.password || proxy.pathname !== "/") {
    throw new Error("A private, filtered HTTP egress proxy is required");
  }
  // Includes credential-aware Range and fallback asset requests, not just Chromium traffic.
  setGlobalDispatcher(new ProxyAgent(proxy.href));
}

export function createEngineGuard(sessionId: string) {
  const token = process.env.LIBREBROWSER_ENGINE_TOKEN ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Private engine token is required");
  const expected = Buffer.from(token);
  const authorizeUpgrade = (request: IncomingMessage): boolean => {
    const supplied = request.headers["x-libre-engine-token"];
    return typeof supplied === "string" && /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(supplied), expected);
  };
  const preHandler: preHandlerAsyncHookHandler = async (request, reply) => {
    const sid = (request.params as { sid?: string } | undefined)?.sid;
    if (!authorizeUpgrade(request.raw) || (sid !== undefined && sid !== sessionId)) {
      await reply.code(403).send({ error: "Forbidden" });
    }
  };
  return { authorizeUpgrade, preHandler };
}
