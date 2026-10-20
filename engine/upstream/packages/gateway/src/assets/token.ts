/**
 * Signed asset-proxy tokens.
 *
 * token = AES-256-GCM of {url, sessionId, tabId} under a per-boot server key — opaque,
 * unforgeable, session-bound, carries the browser context to fetch in, and needs no lookup
 * table. URL-safe base64 on the wire.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface AssetRef {
  url: string;
  sessionId: string;
  tabId: string;
}

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
const AAD = Buffer.from("mirror-asset-token:v1", "utf8");

export function sealAssetToken(ref: AssetRef, key: Buffer): string {
  assertKey(key);
  assertAssetRef(ref);

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(ref), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION]), nonce, tag, ciphertext]).toString("base64url");
}

export function openAssetToken(token: string, key: Buffer): AssetRef {
  assertKey(key);

  try {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("bad encoding");
    const packed = Buffer.from(token, "base64url");
    if (packed.length <= HEADER_BYTES || packed.toString("base64url") !== token) {
      throw new Error("bad length");
    }
    if (packed[0] !== VERSION) throw new Error("bad version");

    const nonce = packed.subarray(1, 1 + NONCE_BYTES);
    const tag = packed.subarray(1 + NONCE_BYTES, HEADER_BYTES);
    const ciphertext = packed.subarray(HEADER_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const ref: unknown = JSON.parse(plaintext.toString("utf8"));
    assertAssetRef(ref);
    return ref;
  } catch {
    throw new Error("Invalid asset token");
  }
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TypeError("Asset token key must be a 32-byte Buffer");
  }
}

function assertAssetRef(value: unknown): asserts value is AssetRef {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Partial<AssetRef>).url !== "string" ||
    typeof (value as Partial<AssetRef>).sessionId !== "string" ||
    typeof (value as Partial<AssetRef>).tabId !== "string"
  ) {
    throw new TypeError("Invalid asset reference");
  }

  try {
    new URL((value as AssetRef).url);
  } catch {
    throw new TypeError("Asset URL must be absolute");
  }
}
