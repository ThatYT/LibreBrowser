import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintInvite, verifyInvite } from "./invite";

const KEY = Buffer.from("sec-2-test-key");

describe("SEC-2 invite tokens", () => {
  it("round-trips a signed driver/viewer payload", () => {
    for (const role of ["driver", "viewer"] as const) {
      const invite = { sid: "session-a", role, exp: 2_000 };
      expect(verifyInvite(mintInvite(invite, KEY), KEY, 1_000)).toEqual(invite);
    }
  });

  it("rejects expired, garbled, and tampered tokens", () => {
    const token = mintInvite({ sid: "session-a", role: "viewer", exp: 1_000 }, KEY);
    expect(verifyInvite(token, KEY, 1_000)).toBeNull();
    expect(verifyInvite("not-a-token", KEY, 999)).toBeNull();
    expect(verifyInvite(`${token.slice(0, -1)}x`, KEY, 999)).toBeNull();
  });

  it("accepts no role beyond driver and viewer, even under a valid signature", () => {
    expect(() => mintInvite({ sid: "session-a", role: "admin", exp: 2_000 } as never, KEY)).toThrow(
      "invalid invite payload",
    );

    const payload = Buffer.from(
      JSON.stringify({ sid: "session-a", role: "admin", exp: 2_000 }),
    ).toString("base64url");
    const signature = createHmac("sha256", KEY).update(payload, "ascii").digest("base64url");
    expect(verifyInvite(`${payload}.${signature}`, KEY, 1_000)).toBeNull();
  });
});
