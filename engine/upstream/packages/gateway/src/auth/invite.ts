/**
 * Signed, expiring invite tokens for driver and viewer roles.
 *
 * HMAC-signed invite tokens {sid, role, exp} (node:crypto, no JWT library). Minted by
 * scripts/invite.ts. Token travels in the URL FRAGMENT (never query — keeps it out of access
 * logs); the /join fragment bridge validates it and sets an HttpOnly SameSite=Strict cookie.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type SessionRole = "driver" | "viewer";

export interface Invite {
  sid: string;
  role: SessionRole;
  exp: number;
}

export function mintInvite(invite: Invite, key: Buffer): string {
  assertKey(key);
  if (!isInvite(invite)) throw new TypeError("invalid invite payload");

  const payload = Buffer.from(JSON.stringify(invite), "utf8").toString("base64url");
  return `${payload}.${sign(payload, key).toString("base64url")}`;
}

/** `now` and `exp` are Unix seconds. Expiry is exclusive: exp <= now is expired. */
export function verifyInvite(
  token: string,
  key: Buffer,
  now = Math.floor(Date.now() / 1_000),
): Invite | null {
  assertKey(key);
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("now must be Unix seconds");

  const pieces = token.split(".");
  if (pieces.length !== 2) return null;
  const [payload, encodedSignature] = pieces;
  if (!isBase64Url(payload) || !isBase64Url(encodedSignature)) return null;

  let signature: Buffer;
  let decoded: unknown;
  try {
    signature = Buffer.from(encodedSignature, "base64url");
    if (signature.toString("base64url") !== encodedSignature) return null;
    const payloadBytes = Buffer.from(payload, "base64url");
    if (payloadBytes.toString("base64url") !== payload) return null;
    decoded = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }

  const expected = sign(payload, key);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  if (!isInvite(decoded) || decoded.exp <= now) return null;
  return decoded;
}

function sign(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payload, "ascii").digest();
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length === 0) throw new TypeError("HMAC key must not be empty");
}

function isBase64Url(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isInvite(value: unknown): value is Invite {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    typeof record.sid === "string" &&
    record.sid.length > 0 &&
    (record.role === "driver" || record.role === "viewer") &&
    Number.isSafeInteger(record.exp) &&
    (record.exp as number) > 0
  );
}
