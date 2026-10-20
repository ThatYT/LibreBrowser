import Fastify from "fastify";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { mintInvite } from "./invite";
import { createSessionGuard, SESSION_COOKIE } from "./middleware";

const KEY = Buffer.from("sec-2-middleware-key");
const NOW = 10_000;

describe("SEC-2 session middleware", () => {
  it("exchanges only a fragment-carried token for a strict HttpOnly cookie", async () => {
    const app = Fastify();
    const guard = createSessionGuard({ key: KEY, appPath: "/app", now: () => NOW });
    guard.registerJoinRoutes(app);
    const token = mintInvite({ sid: "s1", role: "driver", exp: NOW + 600 }, KEY);

    const bridge = await app.inject({ method: "GET", url: `/join?token=${token}` });
    expect(bridge.statusCode).toBe(200);
    expect(bridge.headers["set-cookie"]).toBeUndefined();
    expect(bridge.body).toContain("location.hash.slice(1)");
    expect(bridge.body).toContain('method: "POST"');
    expect(bridge.body).not.toContain("URLSearchParams");

    const joined = await app.inject({
      method: "POST",
      url: "/join",
      payload: { token },
    });
    expect(joined.statusCode).toBe(204);
    expect(joined.headers["set-cookie"]).toBe(
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`,
    );
    await app.close();
  });

  it("returns 403 for expired and garbled invite exchanges", async () => {
    const app = Fastify();
    createSessionGuard({ key: KEY, now: () => NOW }).registerJoinRoutes(app);
    const expired = mintInvite({ sid: "s1", role: "viewer", exp: NOW }, KEY);

    for (const token of [expired, "garbled"]) {
      const response = await app.inject({ method: "POST", url: "/join", payload: { token } });
      expect(response.statusCode).toBe(403);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    await app.close();
  });

  it("guards Fastify routes by cookie and route session id", async () => {
    const app = Fastify();
    const guard = createSessionGuard({ key: KEY, now: () => NOW });
    app.get<{ Params: { sid: string } }>(
      "/s/:sid/file",
      { preHandler: guard.preHandler },
      async () => ({ ok: true }),
    );
    const token = mintInvite({ sid: "s1", role: "viewer", exp: NOW + 60 }, KEY);
    const cookie = `${SESSION_COOKIE}=${token}`;

    expect((await app.inject({ url: "/s/s1/file" })).statusCode).toBe(403);
    expect((await app.inject({ url: "/s/s2/file", headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/s/s1/file", headers: { cookie } })).statusCode).toBe(200);
    await app.close();
  });

  it("authorizes WS requests from the cookie at upgrade time", () => {
    const guard = createSessionGuard({ key: KEY, now: () => NOW });
    const token = mintInvite({ sid: "s1", role: "viewer", exp: NOW + 60 }, KEY);
    const request = (cookie?: string): IncomingMessage =>
      ({ headers: cookie === undefined ? {} : { cookie } }) as IncomingMessage;

    expect(guard.authorizeUpgrade(request())).toBe(false);
    expect(guard.authorizeUpgrade(request(`${SESSION_COOKIE}=garbled`))).toBe(false);
    expect(guard.authorizeUpgrade(request(`${SESSION_COOKIE}=${token}`))).toBe(true);
    expect(guard.session(request(`${SESSION_COOKIE}=${token}`))).toEqual({
      sid: "s1",
      role: "viewer",
      exp: NOW + 60,
    });
  });
});
