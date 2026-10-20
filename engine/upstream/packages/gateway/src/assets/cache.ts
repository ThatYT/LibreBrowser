/**
 * SHA-256 content-addressed disk cache with byte-bounded LRU eviction.
 * Bodies are streamed into temporary files while hashing; duplicate bytes share one blob.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";

export const DEFAULT_ASSET_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

export interface CacheMetadata {
  statusCode: number;
  headers: Record<string, string | string[]>;
}

export interface CachedAsset extends CacheMetadata {
  digest: string;
  size: number;
  path: string;
  createReadStream(): ReadStream;
}

export interface AssetCacheStats {
  hits: number;
  misses: number;
  blobs: number;
  bytes: number;
}

export interface AssetCache {
  get(key: string): Promise<CachedAsset | undefined>;
  put(key: string, body: AsyncIterable<Uint8Array>, metadata: CacheMetadata): Promise<CachedAsset>;
  stats(): AssetCacheStats;
}

interface BlobEntry {
  digest: string;
  size: number;
  path: string;
  lastAccess: number;
  keys: Set<string>;
}

interface KeyEntry extends CacheMetadata {
  digest: string;
}

export function createAssetCache(dir: string, maxBytes = DEFAULT_ASSET_CACHE_BYTES): AssetCache {
  if (dir.trim() === "") throw new TypeError("Asset cache directory must not be empty");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Asset cache maxBytes must be a positive safe integer");
  }

  const blobDir = join(dir, "sha256");
  const tempDir = join(dir, "tmp");
  const ready = Promise.all([
    mkdir(blobDir, { recursive: true }),
    mkdir(tempDir, { recursive: true }),
  ]);
  const blobs = new Map<string, BlobEntry>();
  const keys = new Map<string, KeyEntry>();
  let totalBytes = 0;
  let hits = 0;
  let misses = 0;
  let clock = 0;
  let mutation = Promise.resolve();

  const serialized = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutation;
    let release: (() => void) | undefined;
    mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  };

  const materialize = (keyEntry: KeyEntry, blob: BlobEntry): CachedAsset => ({
    statusCode: keyEntry.statusCode,
    headers: cloneHeaders(keyEntry.headers),
    digest: blob.digest,
    size: blob.size,
    path: blob.path,
    createReadStream: () => createReadStream(blob.path),
  });

  return {
    async get(key) {
      await ready;
      return serialized(async () => {
        const keyEntry = keys.get(key);
        const blob = keyEntry === undefined ? undefined : blobs.get(keyEntry.digest);
        if (keyEntry === undefined || blob === undefined) {
          misses += 1;
          return undefined;
        }
        try {
          await stat(blob.path);
        } catch {
          dropBlob(blob);
          misses += 1;
          return undefined;
        }
        hits += 1;
        blob.lastAccess = ++clock;
        return materialize(keyEntry, blob);
      });
    },

    async put(key, body, metadata) {
      await ready;
      const tempPath = join(tempDir, `${process.pid}-${randomBytes(12).toString("hex")}`);
      const hash = createHash("sha256");
      const output = createWriteStream(tempPath, { flags: "wx" });
      let size = 0;
      try {
        for await (const rawChunk of body) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          size += chunk.length;
          hash.update(chunk);
          if (!output.write(chunk)) await once(output, "drain");
        }
        output.end();
        await once(output, "close");
      } catch (error) {
        output.destroy();
        await rm(tempPath, { force: true });
        throw error;
      }

      const digest = hash.digest("hex");
      if (size > maxBytes) {
        // Oversized responses still stream from disk to the caller, but never violate the
        // cache's byte ceiling or displace the entire useful working set.
        return {
          statusCode: metadata.statusCode,
          headers: cloneHeaders(metadata.headers),
          digest,
          size,
          path: tempPath,
          createReadStream() {
            const input = createReadStream(tempPath);
            input.once("close", () => void rm(tempPath, { force: true }));
            return input;
          },
        };
      }
      return serialized(async () => {
        let blob = blobs.get(digest);
        if (blob === undefined) {
          const path = join(blobDir, digest);
          try {
            await rename(tempPath, path);
          } catch (error) {
            await rm(tempPath, { force: true });
            throw error;
          }
          blob = { digest, size, path, lastAccess: ++clock, keys: new Set() };
          blobs.set(digest, blob);
          totalBytes += size;
        } else {
          await rm(tempPath, { force: true });
          blob.lastAccess = ++clock;
        }

        const previous = keys.get(key);
        if (previous !== undefined && previous.digest !== digest) {
          const oldBlob = blobs.get(previous.digest);
          oldBlob?.keys.delete(key);
          if (oldBlob !== undefined && oldBlob.keys.size === 0) await removeBlob(oldBlob);
        }
        keys.set(key, {
          digest,
          statusCode: metadata.statusCode,
          headers: cloneHeaders(metadata.headers),
        });
        blob.keys.add(key);
        await evict(blob.digest);
        return materialize(keys.get(key)!, blob);
      });
    },

    stats() {
      return { hits, misses, blobs: blobs.size, bytes: totalBytes };
    },
  };

  async function evict(protectedDigest: string): Promise<void> {
    while (totalBytes > maxBytes && blobs.size > 1) {
      const victim = [...blobs.values()]
        .filter((blob) => blob.digest !== protectedDigest)
        .sort((left, right) => left.lastAccess - right.lastAccess)[0];
      if (victim === undefined) return;
      await removeBlob(victim);
    }
  }

  async function removeBlob(blob: BlobEntry): Promise<void> {
    dropBlob(blob);
    await rm(blob.path, { force: true });
  }

  function dropBlob(blob: BlobEntry): void {
    if (!blobs.delete(blob.digest)) return;
    totalBytes -= blob.size;
    for (const key of blob.keys) keys.delete(key);
  }
}

function cloneHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
}
