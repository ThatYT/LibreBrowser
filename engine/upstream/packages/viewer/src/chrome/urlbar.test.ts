// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeNavigationUrl } from "./urlbar";

describe("P1 viewer navigation chrome", () => {
  it("adds a default scheme to host input", () => {
    expect(normalizeNavigationUrl(" example.com/path ")).toBe("https://example.com/path");
  });

  it("preserves explicit schemes and ignores an empty submission", () => {
    expect(normalizeNavigationUrl("http://example.test")).toBe("http://example.test");
    expect(normalizeNavigationUrl("about:blank")).toBe("about:blank");
    expect(normalizeNavigationUrl("   ")).toBeNull();
  });
});

  it("rejects malformed about URLs before Chromium navigation", () => {
    expect(normalizeNavigationUrl("about:blankhttps://www.google.com/")).toBeNull();
    expect(normalizeNavigationUrl("javascript:alert(1)")).toBeNull();
  });
