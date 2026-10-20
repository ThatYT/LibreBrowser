import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { rewriteFetchedStylesheet } from "./stylesheet";
import { openAssetToken } from "./token";

describe("stylesheet resource graph", () => {
  it("rewrites nested imports and font URLs relative to the stylesheet, including compressed fallback bodies", async () => {
    const key = Buffer.alloc(32, 3);
    const ref = { sessionId: "s", tabId: "t", url: "https://cdn.example/css/main.css" };
    const response = await rewriteFetchedStylesheet(
      {
        statusCode: 200,
        lane: "direct",
        headers: { "content-type": "text/css", "content-encoding": "gzip", etag: "old" },
        body: Readable.from([gzipSync('@import "theme.css"; @font-face{src:url(../font.woff2)}')]),
      },
      ref,
      key,
    );
    let css = "";
    for await (const bytes of response.body) css += bytes.toString();
    const urls = [...css.matchAll(/\/s\/s\/a\/([\w-]+)/g)].map(
      (m) => openAssetToken(m[1]!, key).url,
    );
    expect(urls).toEqual(["https://cdn.example/css/theme.css", "https://cdn.example/font.woff2"]);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.etag).toBeUndefined();
    expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(css));
  });
});
