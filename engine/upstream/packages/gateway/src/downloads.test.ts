import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mintInvite } from "./auth/invite";
import { createSessionGuard, SESSION_COOKIE } from "./auth/middleware";
import type { BrowserHandle, BrowserSessionEventMap, FlatSessionEventMap } from "./browser/launch";
import { createDownloadManager, registerDownloadRoutes } from "./downloads";
import type { TargetRef } from "./types";

const KEY = Buffer.from("download-route-test-key");
const NOW = 20_000;

class DownloadBrowser implements BrowserHandle {
  readonly send = vi.fn(async () => ({}));
  readonly sendBrowser = vi.fn(async () => ({}));
  private readonly browserCallbacks = new Map<string, Set<(event: never) => void>>();

  onSessionEvent<K extends keyof FlatSessionEventMap>(
    _method: K,
    _callback: (sessionId: string, event: FlatSessionEventMap[K]) => void,
  ): () => void {
    return () => undefined;
  }

  onBrowserEvent<K extends keyof BrowserSessionEventMap>(
    method: K,
    callback: (event: BrowserSessionEventMap[K]) => void,
  ): () => void {
    let callbacks = this.browserCallbacks.get(method);
    if (callbacks === undefined) {
      callbacks = new Set();
      this.browserCallbacks.set(method, callbacks);
    }
    const stored = callback as (event: never) => void;
    callbacks.add(stored);
    return () => callbacks?.delete(stored);
  }

  emit<K extends keyof BrowserSessionEventMap>(method: K, event: BrowserSessionEventMap[K]): void {
    for (const callback of this.browserCallbacks.get(method) ?? []) callback(event as never);
  }

  onAttached(_callback: (target: TargetRef) => void): void {}
  onDetached(_callback: (target: TargetRef) => void): void {}
  onTargetInfoChanged(_callback: Parameters<BrowserHandle["onTargetInfoChanged"]>[0]): void {}
  async close(): Promise<void> {}
}

const managers: Array<{ close(): void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("download flow", () => {
  it("configures the browser root and maps GUID filenames into progress messages", async () => {
    const browser = new DownloadBrowser();
    const published: unknown[] = [];
    const manager = await createDownloadManager({
      sessionId: "s1",
      browser,
      downloadDir: "/session/downloads",
      publish: (message) => published.push(message),
      createKey: () => "one-time-key",
    });
    managers.push(manager);

    expect(browser.sendBrowser).toHaveBeenCalledWith("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: "/session/downloads",
      eventsEnabled: true,
    });

    browser.emit("Browser.downloadWillBegin", {
      frameId: "oopif-frame",
      guid: "guid-1",
      url: "https://files.test/origin-name",
      suggestedFilename: "report.pdf",
    });
    browser.emit("Browser.downloadProgress", {
      guid: "guid-1",
      totalBytes: 100,
      receivedBytes: 35,
      state: "inProgress",
    });
    browser.emit("Browser.downloadProgress", {
      guid: "guid-1",
      totalBytes: 100,
      receivedBytes: 100,
      state: "completed",
    });

    expect(published).toEqual([
      {
        t: "download",
        id: "guid-1",
        name: "report.pdf",
        recv: 35,
        total: 100,
        state: "active",
      },
      {
        t: "download",
        id: "guid-1",
        name: "report.pdf",
        recv: 100,
        total: 100,
        state: "done",
        href: "/s/s1/d/one-time-key",
      },
    ]);
  });

  it("streams a completed GUID file once, guards it by cookie, and never uses the name as a path", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirror-download-test-"));
    tempDirs.push(root);
    const downloadDir = join(root, "downloads");
    await mkdir(downloadDir);
    await writeFile(join(downloadDir, "guid-safe"), "download bytes");

    const browser = new DownloadBrowser();
    const manager = await createDownloadManager({
      sessionId: "s1",
      browser,
      downloadDir,
      publish: () => undefined,
      createKey: () => "single-use",
    });
    managers.push(manager);
    browser.emit("Browser.downloadWillBegin", {
      frameId: "frame-1",
      guid: "guid-safe",
      url: "https://files.test/file",
      suggestedFilename: "../../outside.txt",
    });
    browser.emit("Browser.downloadProgress", {
      guid: "guid-safe",
      totalBytes: 14,
      receivedBytes: 14,
      state: "completed",
    });

    const app = Fastify();
    const guard = createSessionGuard({ key: KEY, now: () => NOW });
    registerDownloadRoutes(app, {
      preHandler: guard.preHandler,
      managerFor: (sessionId) => (sessionId === "s1" ? manager : undefined),
    });

    expect((await app.inject({ url: "/s/s1/d/single-use" })).statusCode).toBe(403);

    const token = mintInvite({ sid: "s1", role: "viewer", exp: NOW + 60 }, KEY);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    const first = await app.inject({ url: "/s/s1/d/single-use", headers });
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe("download bytes");
    expect(first.headers["content-disposition"]).toBe(
      "attachment; filename=\"../../outside.txt\"; filename*=UTF-8''..%2F..%2Foutside.txt",
    );
    expect((await app.inject({ url: "/s/s1/d/single-use", headers })).statusCode).toBe(404);

    await app.close();
  });
});
