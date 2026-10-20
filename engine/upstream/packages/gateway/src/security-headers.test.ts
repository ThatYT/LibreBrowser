import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerSecurityHeaders, SECURITY_HEADERS } from "./security-headers";

describe("security headers", () => {
  it("applies the browser-facing baseline to every response", async () => {
    const app = Fastify();
    registerSecurityHeaders(app);
    app.get("/", async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/" });

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers[name]).toBe(value);
    }
    await app.close();
  });

  it("does not replace a stricter route-specific value", async () => {
    const app = Fastify();
    registerSecurityHeaders(app);
    app.get("/", async (_request, reply) => {
      reply.header("referrer-policy", "same-origin");
      return { ok: true };
    });

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.headers["referrer-policy"]).toBe("same-origin");
    await app.close();
  });
});
