import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { AssetFetchResponse } from "./fetch";
import { rewriteCssText } from "./rewrite";
import { sealAssetToken, type AssetRef } from "./token";

/** A fetched stylesheet is another resource graph, not opaque terminal bytes.
 * Resolve its references against its own URL, then serve a UTF-8 representation.
 * Limit parser input independently of the disk cache budget.
 */
export async function rewriteFetchedStylesheet(
  response: AssetFetchResponse,
  ref: AssetRef,
  key: Buffer,
): Promise<AssetFetchResponse> {
  const contentType = response.headers["content-type"];
  if (
    response.statusCode !== 200 ||
    typeof contentType !== "string" ||
    !/^text\/css(?:;|$)/i.test(contentType)
  )
    return response;
  const encoding = response.headers["content-encoding"];
  const decoder =
    encoding === "br"
      ? createBrotliDecompress()
      : encoding === "gzip"
        ? createGunzip()
        : encoding === "deflate"
          ? createInflate()
          : undefined;
  if (encoding && encoding !== "identity" && !decoder) {
    response.body.destroy();
    throw new Error("Unsupported stylesheet encoding");
  }
  const input = decoder ? response.body.compose(decoder) : response.body;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 8 * 1024 * 1024) throw new Error("Stylesheet exceeds parser budget");
      chunks.push(bytes);
    }
  } finally {
    response.body.destroy();
  }
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8";
  const css = new TextDecoder(charset).decode(Buffer.concat(chunks));
  const body = Buffer.from(
    rewriteCssText(
      css,
      (url) => `/s/${encodeURIComponent(ref.sessionId)}/a/${sealAssetToken({ ...ref, url }, key)}`,
      ref.url,
    ),
  );
  const headers: AssetFetchResponse["headers"] = {
    ...response.headers,
    "content-type": "text/css; charset=utf-8",
    "content-length": String(body.length),
  };
  for (const name of ["content-encoding", "etag", "content-md5", "digest"]) delete headers[name];
  return { ...response, headers, body: Readable.from([body]) };
}
