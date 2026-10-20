import Fastify from "fastify";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mintInvite } from "./auth/invite";
import { createSessionGuard, SESSION_COOKIE } from "./auth/middleware";
import type { BrowserHandle, BrowserSessionEventMap, FlatSessionEventMap } from "./browser/launch";
import type { TargetRef } from "./types";
import { createUploadManager, registerUploadRoutes } from "./uploads";

const KEY = Buffer.from("upload-route-test-key");
const NOW = 30_000;

class UploadBrowser implements BrowserHandle {
  readonly calls: Array<{ sessionId: string; method: string; params?: Record<string, unknown> }> =
    [];
  private readonly sessionCallbacks = new Map<
    string,
    Set<(sessionId: string, event: never) => void>
  >();
  private readonly targets = new Map<string, TargetRef>();
  private readonly attachedCallbacks = new Set<(target: TargetRef) => void>();
  private readonly detachedCallbacks = new Set<(target: TargetRef) => void>();

  readonly send = vi.fn(
    async (sessionId: string, method: string, params?: Record<string, unknown>) => {
      this.calls.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
      if (method === "DOM.resolveNode") return { object: { objectId: "file-input-object" } };
      return {};
    },
  );

  attach(target: TargetRef): void {
    this.targets.set(target.targetId, target);
    for (const callback of this.attachedCallbacks) callback(target);
  }

  emit<K extends keyof FlatSessionEventMap>(
    method: K,
    sessionId: string,
    event: FlatSessionEventMap[K],
  ): void {
    for (const callback of this.sessionCallbacks.get(method) ?? []) {
      callback(sessionId, event as never);
    }
  }

  onSessionEvent<K extends keyof FlatSessionEventMap>(
    method: K,
    callback: (sessionId: string, event: FlatSessionEventMap[K]) => void,
  ): () => void {
    let callbacks = this.sessionCallbacks.get(method);
    if (callbacks === undefined) {
      callbacks = new Set();
      this.sessionCallbacks.set(method, callbacks);
    }
    const stored = callback as (sessionId: string, event: never) => void;
    callbacks.add(stored);
    return () => callbacks?.delete(stored);
  }

  onBrowserEvent<K extends keyof BrowserSessionEventMap>(
    _method: K,
    _callback: (event: BrowserSessionEventMap[K]) => void,
  ): () => void {
    return () => undefined;
  }

  onAttached(callback: (target: TargetRef) => void): void {
    this.attachedCallbacks.add(callback);
    for (const target of this.targets.values()) callback(target);
  }

  onDetached(callback: (target: TargetRef) => void): void {
    this.detachedCallbacks.add(callback);
  }

  onTargetInfoChanged(_callback: Parameters<BrowserHandle["onTargetInfoChanged"]>[0]): void {}
  async close(): Promise<void> {}
}

const managers: Array<{ close(): void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function pageTarget(): TargetRef {
  return { targetId: "tab-1", sessionId: "page-session", type: "page" };
}

function uploadHeaders(
  name: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/octet-stream",
    "x-mirror-file-index": "0",
    "x-mirror-file-count": "1",
    "x-mirror-file-size": "12",
    "x-mirror-total-size": "12",
    "x-mirror-file-name": encodeURIComponent(name),
    "x-mirror-file-type": encodeURIComponent("text/plain"),
    ...overrides,
  };
}

async function waitForFilePick(published: unknown[]): Promise<void> {
  await vi.waitFor(() => expect(published).toHaveLength(1));
}

describe("upload flow", () => {
  it("enables chooser interception on page sessions and re-enables it after navigation", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirror-upload-test-"));
    tempDirs.push(root);
    const browser = new UploadBrowser();
    browser.attach(pageTarget());
    const manager = await createUploadManager({
      sessionId: "s1",
      browser,
      uploadDir: join(root, "uploads"),
      publish: () => undefined,
    });
    managers.push(manager);

    expect(browser.send).toHaveBeenCalledWith("page-session", "Page.enable");
    expect(browser.send).toHaveBeenCalledWith(
      "page-session",
      "Page.setInterceptFileChooserDialog",
      { enabled: true },
    );

    browser.emit("Page.frameNavigated", "page-session", {
      frame: { id: "main-frame", parentId: undefined },
      type: "Navigation",
    } as FlatSessionEventMap["Page.frameNavigated"]);
    await vi.waitFor(() => {
      expect(
        browser.calls.filter((call) => call.method === "Page.setInterceptFileChooserDialog"),
      ).toHaveLength(2);
    });
  });

  it("guards and consumes a key once, sanitizes the name as a path, and sets the backend node", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirror-upload-test-"));
    tempDirs.push(root);
    const browser = new UploadBrowser();
    browser.attach(pageTarget());
    const published: unknown[] = [];
    const manager = await createUploadManager({
      sessionId: "s1",
      browser,
      uploadDir: join(root, "uploads"),
      publish: (message) => published.push(message),
      createKey: () => "single-use",
      maxFiles: 1,
      maxFileBytes: 12,
      maxTotalBytes: 12,
    });
    managers.push(manager);
    browser.emit("Page.fileChooserOpened", "page-session", {
      frameId: "main-frame",
      mode: "selectSingle",
      backendNodeId: 77,
    });
    await waitForFilePick(published);
    expect(published).toMatchObject([
      { t: "filepick", tab: "tab-1", key: "single-use", multiple: false },
    ]);

    const app = Fastify();
    const guard = createSessionGuard({ key: KEY, now: () => NOW });
    registerUploadRoutes(app, {
      preHandler: guard.preHandler,
      managerFor: (sessionId) => (sessionId === "s1" ? manager : undefined),
    });
    const request = {
      method: "POST" as const,
      url: "/s/s1/u/single-use",
      headers: uploadHeaders("../../outside.txt"),
      payload: "upload bytes",
    };

    expect((await app.inject(request)).statusCode).toBe(403);
    const token = mintInvite({ sid: "s1", role: "viewer", exp: NOW + 60 }, KEY);
    const authorized = {
      ...request,
      headers: { ...request.headers, cookie: `${SESSION_COOKIE}=${token}` },
    };
    const oversized = await app.inject({
      ...authorized,
      headers: {
        ...authorized.headers,
        "x-mirror-file-size": "13",
        "x-mirror-total-size": "13",
      },
      payload: "too many bytes",
    });
    expect(oversized.statusCode).toBe(413);
    expect((await app.inject(authorized)).statusCode).toBe(204);

    const expectedPath = join(root, "uploads", "single-use", "0", ".._.._outside.txt");
    expect(await readFile(expectedPath, "utf8")).toBe("upload bytes");
    expect(browser.send).toHaveBeenCalledWith("page-session", "DOM.setFileInputFiles", {
      files: [expectedPath],
      backendNodeId: 77,
    });
    expect((await app.inject(authorized)).statusCode).toBe(404);
    await app.close();
  });

  it("streams multiple files in order to the OOPIF session that owns the chooser node", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirror-upload-test-"));
    tempDirs.push(root);
    const browser = new UploadBrowser();
    browser.attach(pageTarget());
    browser.attach({
      targetId: "frame-1",
      sessionId: "frame-session",
      type: "iframe",
    });
    const published: unknown[] = [];
    const manager = await createUploadManager({
      sessionId: "s1",
      browser,
      uploadDir: join(root, "uploads"),
      publish: (message) => published.push(message),
      createKey: () => "multiple-key",
    });
    managers.push(manager);
    browser.emit("Page.fileChooserOpened", "page-session", {
      frameId: "frame-1",
      mode: "selectMultiple",
      backendNodeId: 91,
    });
    await waitForFilePick(published);

    const app = Fastify();
    const guard = createSessionGuard({ key: KEY, now: () => NOW });
    registerUploadRoutes(app, {
      preHandler: guard.preHandler,
      managerFor: () => manager,
    });
    const token = mintInvite({ sid: "s1", role: "driver", exp: NOW + 60 }, KEY);
    const baseHeaders = {
      cookie: `${SESSION_COOKIE}=${token}`,
      "x-mirror-file-count": "2",
      "x-mirror-total-size": "6",
      "x-mirror-file-type": "",
      "content-type": "application/octet-stream",
    };
    const first = await app.inject({
      method: "POST",
      url: "/s/s1/u/multiple-key",
      headers: {
        ...baseHeaders,
        "x-mirror-file-index": "0",
        "x-mirror-file-size": "3",
        "x-mirror-file-name": "a.txt",
      },
      payload: "one",
    });
    expect(first.statusCode).toBe(204);
    expect(browser.calls.some((call) => call.method === "DOM.setFileInputFiles")).toBe(false);

    const second = await app.inject({
      method: "POST",
      url: "/s/s1/u/multiple-key",
      headers: {
        ...baseHeaders,
        "x-mirror-file-index": "1",
        "x-mirror-file-size": "3",
        "x-mirror-file-name": "b.txt",
      },
      payload: "two",
    });
    expect(second.statusCode).toBe(204);
    expect(browser.send).toHaveBeenCalledWith("frame-session", "DOM.setFileInputFiles", {
      files: [
        join(root, "uploads", "multiple-key", "0", "a.txt"),
        join(root, "uploads", "multiple-key", "1", "b.txt"),
      ],
      backendNodeId: 91,
    });
    await app.close();
  });

  it("times out an unclaimed chooser by resolving its backend node and emitting cancel", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "mirror-upload-test-"));
    tempDirs.push(root);
    const browser = new UploadBrowser();
    browser.attach(pageTarget());
    const published: unknown[] = [];
    const manager = await createUploadManager({
      sessionId: "s1",
      browser,
      uploadDir: join(root, "uploads"),
      publish: (message) => published.push(message),
      createKey: () => "expires",
      chooserTimeoutMs: 50,
    });
    managers.push(manager);
    browser.emit("Page.fileChooserOpened", "page-session", {
      frameId: "main-frame",
      mode: "selectSingle",
      backendNodeId: 103,
    });
    await waitForFilePick(published);

    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => {
      expect(browser.send).toHaveBeenCalledWith("page-session", "DOM.resolveNode", {
        backendNodeId: 103,
      });
      expect(browser.send).toHaveBeenCalledWith("page-session", "Runtime.callFunctionOn", {
        objectId: "file-input-object",
        functionDeclaration: "function(){this.dispatchEvent(new Event('cancel',{bubbles:true}));}",
        returnByValue: true,
      });
    });
  });
});
