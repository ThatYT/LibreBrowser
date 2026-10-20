import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { CdpSend } from "../types";
import { createAssetFetcher, type DirectRequest, type DirectResponse } from "./fetch";
import type { AssetRef } from "./token";

const ref: AssetRef = {
  url: "https://assets.example/not-really-an-image.png",
  sessionId: "session-a",
  tabId: "tab-a",
};

describe("asset fetch lanes", () => {
  it("reads object URLs in bounded slices and releases the browser handle", async () => {
    const payload = Buffer.alloc(140000, 42);
    const send = vi.fn<CdpSend>(async (_session, method, params) => {
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate") return { result: { objectId: "blob" } };
      if (method === "Runtime.releaseObject") return {};
      if (method === "Runtime.callFunctionOn") {
        if (!params?.arguments)
          return { result: { value: { size: payload.length, type: "image/png" } } };
        const args = params.arguments as { value: number }[];
        expect(args[1]!.value).toBe(65536);
        return {
          result: {
            value: payload
              .subarray(args[0]!.value, args[0]!.value + args[1]!.value)
              .toString("base64"),
          },
        };
      }
      throw new Error(method);
    });
    const fetcher = createAssetFetcher({ send, sessionFor: () => "cdp", frameFor: () => "frame" });
    const response = await fetcher.fetch({
      ref: { ...ref, url: "blob:https://reader.example/id" },
    });
    const chunks: Buffer[] = [];
    for await (const bytes of response.body) chunks.push(bytes);
    expect(Buffer.concat(chunks)).toEqual(payload);
    expect(send.mock.calls.at(-1)?.[1]).toBe("Runtime.releaseObject");
  });

  it("never sends browser-owned object URLs to the direct HTTP fallback", async () => {
    const directRequest = vi.fn<DirectRequest>();
    const fetcher = createAssetFetcher({
      sessionFor: () => "cdp",
      frameFor: () => "frame",
      send: async () => {
        throw new Error("object was revoked");
      },
      directRequest,
    });
    await expect(
      fetcher.fetch({ ref: { ...ref, url: "blob:https://reader.example/id" } }),
    ).rejects.toThrow("revoked");
    expect(directRequest).not.toHaveBeenCalled();
  });

  it("falls back from any Lane-A setup error to Lane B with browser cookies and UA", async () => {
    const methods: string[] = [];
    const send: CdpSend = async (_sessionId, method) => {
      methods.push(method);
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "frame-a" } } };
      }
      if (method === "Network.loadNetworkResource") throw new Error("experimental failure");
      if (method === "Network.getCookies") {
        return { cookies: [{ name: "gate", value: "open" }] };
      }
      if (method === "Browser.getVersion") return { userAgent: "Browser UA" };
      throw new Error(`Unexpected CDP method ${method}`);
    };
    const directRequest = vi.fn<DirectRequest>(async (_url, options) => {
      expect(options.headers).toMatchObject({
        cookie: "gate=open",
        "user-agent": "Browser UA",
      });
      return directResponse("fallback", { "content-type": "text/plain" });
    });
    const fetcher = createAssetFetcher({
      send,
      sessionFor: () => "cdp-session-a",
      directRequest,
    });

    const response = await fetcher.fetch({ ref });

    expect(response.lane).toBe("direct");
    expect(await readBody(response.body)).toBe("fallback");
    expect(methods).toContain("Network.loadNetworkResource");
    expect(directRequest).toHaveBeenCalledOnce();
  });

  it("sends Range straight through Lane B and never attempts Lane A", async () => {
    const send = vi.fn<CdpSend>(async (_sessionId, method) => {
      if (method === "Network.getCookies") return { cookies: [] };
      if (method === "Browser.getVersion") return { userAgent: "Range UA" };
      throw new Error(`Lane A must not run for Range: ${method}`);
    });
    const directRequest = vi.fn<DirectRequest>(async (_url, options) => {
      expect(options.headers.range).toBe("bytes=500-999");
      return directResponse(
        "partial",
        {
          "content-type": "video/mp4",
          "content-range": "bytes 500-999/2000",
        },
        206,
      );
    });
    const fetcher = createAssetFetcher({
      send,
      sessionFor: () => "cdp-session-a",
      directRequest,
    });

    const response = await fetcher.fetch({ ref, range: "bytes=500-999" });

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 500-999/2000");
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      "Browser.getVersion",
      "Network.getCookies",
    ]);
  });

  it("streams decoded CDP chunks without stale upstream encoding or length headers", async () => {
    const chunks = [Buffer.from("first-"), Buffer.from("second")];
    let readIndex = 0;
    const send: CdpSend = async (_sessionId, method, params) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "frame-a" } } };
      }
      if (method === "Network.loadNetworkResource") {
        return {
          resource: {
            success: true,
            httpStatusCode: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Encoding": "br",
              "Content-Length": "5",
            },
            stream: "stream-a",
          },
        };
      }
      if (method === "IO.read") {
        expect(params?.size).toBe(64 * 1024);
        const chunk = chunks[readIndex++]!;
        return {
          data: chunk.toString("base64"),
          base64Encoded: true,
          eof: readIndex === chunks.length,
        };
      }
      if (method === "IO.close") return {};
      throw new Error(`Unexpected CDP method ${method}`);
    };
    const directRequest = vi.fn<DirectRequest>();
    const fetcher = createAssetFetcher({
      send,
      sessionFor: () => "cdp-session-a",
      directRequest,
    });

    const response = await fetcher.fetch({ ref });

    expect(response.lane).toBe("cdp");
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-length"]).toBeUndefined();
    expect(await readBody(response.body)).toBe("first-second");
    expect(directRequest).not.toHaveBeenCalled();
  });
});

function directResponse(
  body: string,
  headers: DirectResponse["headers"],
  statusCode = 200,
): DirectResponse {
  return { statusCode, headers, body: Readable.from([body]) };
}

async function readBody(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("LibreBrowser filtered asset redirects", () => {
  it("reselects cookies for each destination and retains Range", async () => {
    const send: CdpSend = async (_sid, method, params) => {
      if (method === 'Browser.getVersion') return {userAgent:'UA'};
      if (method === 'Network.getCookies') return {cookies: (params?.urls as string[])[0] === ref.url ? [{name:'private',value:'origin-one'}] : []};
      throw new Error(method);
    };
    const directRequest = vi.fn<DirectRequest>(async (url, options) => {
      if(url === ref.url) {
        expect(options.headers.cookie).toBe('private=origin-one');
        return {statusCode:302,headers:{location:'https://other.example/image.png'},body:Readable.from(['redirect'])};
      }
      expect(options.headers.cookie).toBeUndefined();
      expect(options.headers.range).toBe('bytes=0-10');
      return {statusCode:206,headers:{'content-type':'image/png'},body:Readable.from(['pixels'])};
    });
    const response=await createAssetFetcher({send,sessionFor:()=> 'cdp',directRequest}).fetch({ref,range:'bytes=0-10'});
    expect(await readBody(response.body)).toBe('pixels');
    expect(directRequest).toHaveBeenCalledTimes(2);
  });
});
