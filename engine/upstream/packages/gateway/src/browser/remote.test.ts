import { describe, expect, it, vi } from "vitest";

import type { BrowserHandle } from "./launch";
import { connectRemoteBrowser } from "./remote";

describe("remote Chromium discovery", () => {
  it("rewrites Chromium's loopback websocket authority to the configured private host", async () => {
    const browser = {} as BrowserHandle;
    const connect = vi.fn(async () => browser);
    const requestJson = vi.fn(async () => ({
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test",
    }));

    await expect(
      connectRemoteBrowser("http://chromium:9222", {
        requestJson,
        connect,
        resolveHost: async () => "172.30.0.2",
      }),
    ).resolves.toBe(browser);
    expect(requestJson).toHaveBeenCalledWith("http://172.30.0.2:9222/json/version");
    expect(connect).toHaveBeenCalledWith("ws://172.30.0.2:9222/devtools/browser/test");
  });

  it("rejects credential-bearing and non-HTTP discovery URLs", async () => {
    await expect(connectRemoteBrowser("ws://chromium:9222")).rejects.toThrow("http or https");
    await expect(connectRemoteBrowser("http://user:pass@chromium:9222")).rejects.toThrow(
      "must not contain credentials",
    );
  });

  it("reports a bounded readiness failure", async () => {
    await expect(
      connectRemoteBrowser("http://chromium:9222", {
        timeoutMs: 1,
        pollIntervalMs: 1,
        resolveHost: async () => "172.30.0.2",
        requestJson: async () => {
          throw new Error("not ready");
        },
      }),
    ).rejects.toThrow("did not become ready");
  });
});
