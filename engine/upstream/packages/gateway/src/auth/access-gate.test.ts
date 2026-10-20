import Fastify from "fastify";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { ACCESS_COOKIE, ACCESS_MAX_AGE_SECONDS, createAccessGate } from "./access-gate";
import { mintInvite } from "./invite";
import { createSessionGuard } from "./middleware";

const SECRET = Buffer.from("access-gate-test-secret");
const NOW = 1_800_000_000_000;

describe("ACCESS-GATE device front door", () => {
  it("accepts the configured password and remembers the device with a signed strict cookie", async () => {
    const app = Fastify();
    const gate = createAccessGate({
      password: "owner-password",
      secret: SECRET,
      appPath: "/app",
      now: () => NOW,
    });
    app.addHook("preHandler", gate.preHandler);
    gate.registerRoutes(app);
    app.get("/app", async () => ({ ok: true }));

    const response = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ password: "owner-password" }).toString(),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/app");
    const setCookie = response.headers["set-cookie"];
    expect(setCookie).toMatch(
      new RegExp(
        `^${ACCESS_COOKIE}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ACCESS_MAX_AGE_SECONDS}$`,
      ),
    );
    expect(setCookie).not.toContain("owner-password");

    const cookie = cookiePair(setCookie);
    expect((await app.inject({ url: "/app", headers: { cookie } })).statusCode).toBe(200);
    const remembered = await app.inject({ url: "/gate", headers: { cookie } });
    expect(remembered.statusCode).toBe(302);
    expect(remembered.headers.location).toBe("/app");
    await app.close();
  });

  it("requires a configured password and honors the environment value", async () => {
    expect(() => createAccessGate({ env: {}, secret: SECRET })).toThrow(
      "MIRROR_ACCESS_PASSWORD must be set",
    );

    const app = Fastify();
    const gate = createAccessGate({
      env: { MIRROR_ACCESS_PASSWORD: "from-env" },
      secret: SECRET,
      now: () => NOW,
    });
    gate.registerRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ password: "from-env" }).toString(),
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers["set-cookie"]).toContain(`${ACCESS_COOKIE}=`);
    await app.close();
  });

  it("rejects a wrong password without a cookie and backs off repeated guesses by IP", async () => {
    const app = Fastify();
    const gate = createAccessGate({
      password: "correct",
      secret: SECRET,
      now: () => NOW,
      backoffMs: 1_000,
    });
    gate.registerRoutes(app);
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/gate",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "password=wrong",
      });

    const wrong = await attempt();
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    expect(wrong.body).toContain("Incorrect password");

    const repeated = await attempt();
    expect(repeated.statusCode).toBe(429);
    expect(repeated.headers["retry-after"]).toBe("1");
    expect(repeated.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("rejects a tampered cookie and expires an otherwise valid remembered device", async () => {
    let currentTime = NOW;
    const app = Fastify();
    const gate = createAccessGate({
      password: "correct",
      secret: SECRET,
      maxAgeSeconds: 60,
      now: () => currentTime,
    });
    app.addHook("preHandler", gate.preHandler);
    gate.registerRoutes(app);
    app.get("/app", async () => ({ ok: true }));

    const granted = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "password=correct",
    });
    const cookie = cookiePair(granted.headers["set-cookie"]);
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("a") ? "b" : "a"}`;

    const forgedResponse = await app.inject({ url: "/app", headers: { cookie: tampered } });
    expect(forgedResponse.statusCode).toBe(302);
    expect(forgedResponse.headers.location).toBe("/gate");

    currentTime += 60_000;
    const expiredResponse = await app.inject({ url: "/app", headers: { cookie } });
    expect(expiredResponse.statusCode).toBe(302);
    expect(expiredResponse.headers.location).toBe("/gate");
    await app.close();
  });

  it("redirects app GETs, rejects APIs and WS upgrades, and leaves gate and health public", async () => {
    const app = Fastify();
    const gate = createAccessGate({ password: "correct", secret: SECRET, now: () => NOW });
    app.addHook("preHandler", gate.preHandler);
    gate.registerRoutes(app);
    app.get("/healthz", async () => ({ ok: true }));
    app.get("/app", async () => ({ ok: true }));
    app.post("/api/action", async () => ({ ok: true }));

    const gatePage = await app.inject({ url: "/gate" });
    expect(gatePage.statusCode).toBe(200);
    expect(gatePage.body).toContain('type="password"');
    expect(await app.inject({ url: "/healthz" })).toMatchObject({ statusCode: 200 });

    const appEntry = await app.inject({ url: "/app" });
    expect(appEntry.statusCode).toBe(302);
    expect(appEntry.headers.location).toBe("/gate");
    const api = await app.inject({ method: "POST", url: "/api/action" });
    expect(api.statusCode).toBe(401);
    expect(api.headers.location).toBe("/gate");

    expect(gate.authorizeUpgrade(request())).toBe(false);
    expect(gate.authorizeUpgrade(request(`${ACCESS_COOKIE}=forged`))).toBe(false);
    await app.close();
  });

  it("keeps SEC-2 join underneath the device gate", async () => {
    const app = Fastify();
    const gate = createAccessGate({ password: "correct", secret: SECRET, now: () => NOW });
    const sessionGuard = createSessionGuard({ key: Buffer.from("session-secret") });
    app.addHook("preHandler", gate.preHandler);
    gate.registerRoutes(app);
    sessionGuard.registerJoinRoutes(app);

    const blocked = await app.inject({ url: "/join" });
    expect(blocked.statusCode).toBe(302);
    expect(blocked.headers.location).toBe("/gate");

    const granted = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "password=correct",
    });
    const joined = await app.inject({
      url: "/join",
      headers: { cookie: cookiePair(granted.headers["set-cookie"]) },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.body).toContain("location.hash.slice(1)");
    await app.close();
  });

  it("emits cookiesOnSuccess alongside the access cookie so the password alone authorizes a WS upgrade", async () => {
    const app = Fastify();
    const sessionGuard = createSessionGuard({ key: SECRET, now: () => Math.floor(NOW / 1_000) });
    const gate = createAccessGate({
      password: "owner-password",
      secret: SECRET,
      now: () => NOW,
      cookiesOnSuccess: () => [
        `${sessionGuard.cookieName}=${mintInvite(
          { sid: "dev", role: "driver", exp: Math.floor(NOW / 1_000) + 60 },
          SECRET,
        )}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60`,
      ],
    });
    app.addHook("preHandler", gate.preHandler);
    gate.registerRoutes(app);

    const response = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ password: "owner-password" }).toString(),
    });

    expect(response.statusCode).toBe(303);
    const cookies = response.headers["set-cookie"];
    expect(Array.isArray(cookies) ? cookies : [cookies]).toHaveLength(2);
    const jar = (Array.isArray(cookies) ? cookies : [String(cookies)])
      .map((header) => header.split(";", 1)[0])
      .join("; ");

    // Both guards must accept the single password exchange — no invite link required.
    expect(gate.hasValidDevice(request(jar))).toBe(true);
    expect(sessionGuard.authorizeUpgrade(request(jar))).toBe(true);
    await app.close();
  });
});

function cookiePair(setCookie: string | string[] | undefined): string {
  if (setCookie === undefined) throw new Error("expected a Set-Cookie header");
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const pair = header?.split(";", 1)[0];
  if (pair === undefined) throw new Error("expected a cookie value");
  return pair;
}

function request(cookie?: string): IncomingMessage {
  return { headers: cookie === undefined ? {} : { cookie } } as IncomingMessage;
}
