import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCESS_COOKIE, createAccessGate } from "./auth/access-gate";
import { gatewayHost, registerViewerStatic } from "./serving";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("gateway production serving", () => {
  it("serves the viewer index at root behind the access gate when dist exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirror-viewer-dist-test-"));
    roots.push(root);
    await writeFile(join(root, "index.html"), "<!doctype html><title>Mirror viewer</title>");

    const app = Fastify();
    const gate = createAccessGate({
      password: "correct",
      secret: Buffer.from("serving-test-secret"),
    });
    app.addHook("preHandler", gate.preHandler);
    gate.registerRoutes(app);
    expect(await registerViewerStatic(app, root)).toBe(true);
    app.get("/healthz", async () => ({ ok: true }));

    const blocked = await app.inject({ url: "/" });
    expect(blocked.statusCode).toBe(302);
    expect(blocked.headers.location).toBe("/gate");

    const granted = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "password=correct",
    });
    const setCookie = granted.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    expect(cookie).toContain(`${ACCESS_COOKIE}=`);

    const response = await app.inject({ url: "/", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<title>Mirror viewer</title>");
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    await app.close();
  });

  it("starts normally without registering static routes when dist is absent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mirror-missing-viewer-test-"));
    roots.push(parent);
    const app = Fastify();

    expect(await registerViewerStatic(app, join(parent, "dist"))).toBe(false);
    await app.ready();
    expect((await app.inject({ url: "/" })).statusCode).toBe(404);
    await app.close();
  });

  it("uses GATEWAY_HOST when configured and keeps the loopback default", () => {
    expect(gatewayHost({})).toBe("127.0.0.1");
    expect(gatewayHost({ GATEWAY_HOST: "172.19.0.1" })).toBe("172.19.0.1");
  });
});
