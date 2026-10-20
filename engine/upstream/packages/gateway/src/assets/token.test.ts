import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openAssetToken, sealAssetToken, type AssetRef } from "./token";

describe("asset tokens", () => {
  const ref: AssetRef = {
    url: "https://assets.example/image.png?size=2#pixel",
    sessionId: "session-a",
    tabId: "tab-7",
  };

  it("round-trips an absolute URL and its session/browser binding as URL-safe AES-GCM", () => {
    const key = randomBytes(32);
    const token = sealAssetToken(ref, key);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");
    expect(openAssetToken(token, key)).toEqual(ref);
  });

  it("uses a fresh GCM nonce and rejects tampering or the wrong key", () => {
    const key = randomBytes(32);
    const first = sealAssetToken(ref, key);
    const second = sealAssetToken(ref, key);
    const last = first.at(-1)!;
    const tampered = `${first.slice(0, -1)}${last === "A" ? "B" : "A"}`;

    expect(first).not.toBe(second);
    expect(() => openAssetToken(tampered, key)).toThrow("Invalid asset token");
    expect(() => openAssetToken(first, randomBytes(32))).toThrow("Invalid asset token");
  });

  it("requires AES-256 keys and absolute URLs", () => {
    expect(() => sealAssetToken(ref, Buffer.alloc(31))).toThrow("32-byte Buffer");
    expect(() => sealAssetToken({ ...ref, url: "/relative.png" }, Buffer.alloc(32))).toThrow(
      "absolute",
    );
  });
});
