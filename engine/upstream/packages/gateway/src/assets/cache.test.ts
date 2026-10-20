import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createAssetCache } from "./cache";

const dirs: string[] = [];
const metadata = { statusCode: 200, headers: { "content-type": "text/plain" } };

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("asset disk cache", () => {
  it("uses sha256 content addressing and deduplicates identical bodies", async () => {
    const cache = createAssetCache(await tempDir(), 1024);
    const first = await cache.put("first", Readable.from(["same bytes"]), metadata);
    const second = await cache.put("second", Readable.from(["same ", "bytes"]), metadata);

    expect(first.digest).toBe(createHash("sha256").update("same bytes").digest("hex"));
    expect(second.digest).toBe(first.digest);
    expect(second.path).toBe(first.path);
    expect(cache.stats()).toMatchObject({ blobs: 1, bytes: 10 });
    expect(await readFile(second.path, "utf8")).toBe("same bytes");
  });

  it("evicts the least-recently-used blob while retaining a touched entry", async () => {
    const cache = createAssetCache(await tempDir(), 6);
    await cache.put("a", Readable.from(["aaa"]), metadata);
    await cache.put("b", Readable.from(["bbb"]), metadata);
    expect(await cache.get("a")).toBeDefined(); // a is now newer than b
    await cache.put("c", Readable.from(["ccc"]), metadata);

    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("a")).toBeDefined();
    expect(await cache.get("c")).toBeDefined();
    expect(cache.stats()).toMatchObject({ blobs: 2, bytes: 6 });
  });

  it("streams an oversized body from disk without exceeding the cache ceiling", async () => {
    const cache = createAssetCache(await tempDir(), 3);
    const stored = await cache.put("large", Readable.from(["larger"]), metadata);

    expect(cache.stats()).toMatchObject({ blobs: 0, bytes: 0 });
    expect(await readStream(stored.createReadStream())).toBe("larger");
    expect(await cache.get("large")).toBeUndefined();
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mirror-asset-cache-test-"));
  dirs.push(dir);
  return dir;
}

async function readStream(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
