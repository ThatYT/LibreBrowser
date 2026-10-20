import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAssetCache } from "./cache";
import type { AssetFetcher } from "./fetch";
import { registerAssetRoutes, rejectPrivateAssetTarget } from "./route";
import { sealAssetToken } from "./token";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("asset route policy boundary", () => {
  it("routes browser objects without DNS and rejects unsupported schemes", async () => {
    const lookup = vi.fn(async () => []);
    await rejectPrivateAssetTarget("blob:https://reader.example/object", lookup);
    expect(lookup).not.toHaveBeenCalled();
    await expect(rejectPrivateAssetTarget("file:///etc/passwd", lookup)).rejects.toThrow();
  });
  it("decrypts the token and rejects private/cloud-metadata targets before fetching", async () => {
    const app = Fastify();
    const serverKey = randomBytes(32);
    const fetch = vi.fn<AssetFetcher["fetch"]>();
    const preHandler = vi.fn(async () => undefined);
    const dir = await mkdtemp(join(tmpdir(), "mirror-asset-route-test-"));
    dirs.push(dir);
    registerAssetRoutes(app, {
      serverKey,
      cache: createAssetCache(dir),
      fetcher: { fetch },
      preHandler,
    });
    const token = sealAssetToken(
      {
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        sessionId: "session-a",
        tabId: "tab-a",
      },
      serverKey,
    );

    const response = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Private asset target rejected" });
    expect(preHandler).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("checks every resolved address before fetching a hostname", async () => {
    const app = Fastify();
    const serverKey = randomBytes(32);
    const fetch = vi.fn<AssetFetcher["fetch"]>();
    const dir = await mkdtemp(join(tmpdir(), "mirror-asset-route-test-"));
    dirs.push(dir);
    registerAssetRoutes(app, {
      serverKey,
      cache: createAssetCache(dir),
      fetcher: { fetch },
      lookup: async () => [
        { address: "203.0.113.8", family: 4 },
        { address: "10.0.0.8", family: 4 },
      ],
    });
    const token = sealAssetToken(
      { url: "https://rebind.example/asset", sessionId: "session-a", tabId: "tab-a" },
      serverKey,
    );

    const response = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });

    expect(response.statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("serves a full response from the content cache on the next request", async () => {
    const app = Fastify();
    const serverKey = randomBytes(32);
    const fetch = vi.fn<AssetFetcher["fetch"]>(async () => ({
      statusCode: 200,
      headers: { "content-type": "image/webp" },
      body: Readable.from(["asset-body"]),
      lane: "cdp",
    }));
    const dir = await mkdtemp(join(tmpdir(), "mirror-asset-route-test-"));
    dirs.push(dir);
    registerAssetRoutes(app, {
      serverKey,
      cache: createAssetCache(dir),
      fetcher: { fetch },
      lookup: async () => [{ address: "203.0.113.8", family: 4 }],
    });
    const token = sealAssetToken(
      {
        url: "https://public.example/misleading.txt",
        sessionId: "session-a",
        tabId: "tab-a",
      },
      serverKey,
    );

    const first = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });
    const second = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });

    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("image/webp");
    expect(first.body).toBe("asset-body");
    expect(second.body).toBe("asset-body");
    expect(fetch).toHaveBeenCalledOnce();
    await app.close();
  });

  it.each(["font/woff2", "font/woff", "font/ttf", "font/otf"])(
    "serves %s with immutable long-lived browser caching",
    async (contentType) => {
      const app = Fastify();
      const serverKey = randomBytes(32);
      const fetch = vi.fn<AssetFetcher["fetch"]>(async () => ({
        statusCode: 200,
        headers: {
          "content-type": contentType,
          "cache-control": "private, max-age=0",
        },
        body: Readable.from([Buffer.from([0x77, 0x4f, 0x46, 0x32])]),
        lane: "cdp",
      }));
      const dir = await mkdtemp(join(tmpdir(), "mirror-asset-route-test-"));
      dirs.push(dir);
      registerAssetRoutes(app, {
        serverKey,
        cache: createAssetCache(dir),
        fetcher: { fetch },
        lookup: async () => [{ address: "203.0.113.8", family: 4 }],
      });
      const token = sealAssetToken(
        {
          url: "https://fonts.example/server-font",
          sessionId: "session-a",
          tabId: "tab-a",
        },
        serverKey,
      );

      const first = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });
      const cached = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });

      expect(first.statusCode).toBe(200);
      expect(first.headers["content-type"]).toBe(contentType);
      expect(first.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(cached.headers["content-type"]).toBe(contentType);
      expect(cached.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(fetch).toHaveBeenCalledOnce();
      await app.close();
    },
  );

  it("does not add immutable caching to non-font responses", async () => {
    const app = Fastify();
    const serverKey = randomBytes(32);
    const fetch = vi.fn<AssetFetcher["fetch"]>(async () => ({
      statusCode: 200,
      headers: { "content-type": "image/webp" },
      body: Readable.from(["image"]),
      lane: "cdp",
    }));
    const dir = await mkdtemp(join(tmpdir(), "mirror-asset-route-test-"));
    dirs.push(dir);
    registerAssetRoutes(app, {
      serverKey,
      cache: createAssetCache(dir),
      fetcher: { fetch },
      lookup: async () => [{ address: "203.0.113.8", family: 4 }],
    });
    const token = sealAssetToken(
      {
        url: "https://public.example/image",
        sessionId: "session-a",
        tabId: "tab-a",
      },
      serverKey,
    );

    const response = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });

    expect(response.headers["cache-control"]).toBeUndefined();
    await app.close();
  });
});
