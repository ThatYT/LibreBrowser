/**
 * Live acceptance for P0-LAUNCH.
 *
 * Run from the repository root:
 *   pnpm -F @mirror/gateway exec tsx src/browser/launch.accept.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TargetRef } from "../types";
import { launchBrowser } from "./launch";

const TIMEOUT_MS = 20_000;

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function startXvfb(): Promise<ChildProcess | undefined> {
  if (process.env.DISPLAY) return undefined;

  const displayNumber = 100 + (process.pid % 500);
  const display = `:${displayNumber}`;
  const child = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
    stdio: "ignore",
  });
  const socket = `/tmp/.X11-unix/X${displayNumber}`;
  await waitFor("Xvfb display", async () => {
    try {
      await access(socket);
      return true;
    } catch {
      return false;
    }
  });
  process.env.DISPLAY = display;
  return child;
}

function fixtureServer(): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    response.setHeader("Cache-Control", "no-store");

    if (path === "/worker.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end('postMessage("worker-ready")');
      return;
    }
    if (path === "/sw.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end('self.addEventListener("fetch", () => undefined)');
      return;
    }
    if (path === "/frame") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>OOPIF fixture</title><p>cross-site frame</p>");
      return;
    }
    if (path === "/popup") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Popup fixture</title><p>popup ready</p>");
      return;
    }

    const authority = request.headers.host ?? "main.test";
    const port = authority.slice(authority.lastIndexOf(":") + 1);
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html>
      <title>Launcher fixture</title>
      <iframe src="http://frame.test:${port}/frame"></iframe>
      <script>
        const worker = new Worker('/worker.js');
        worker.onmessage = (event) => document.body.dataset.worker = event.data;
        navigator.serviceWorker.register('/sw.js').then(
          () => document.body.dataset.serviceWorker = 'registered',
          (error) => document.body.dataset.serviceWorker = 'error:' + error,
        );
      </script>`);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "mirror-p0-launch-"));
  const xvfb = await startXvfb();
  const server = fixtureServer();
  const port = await listen(server);
  const browser = await launchBrowser({
    args: [
      "--no-proxy-server",
      "--site-per-process",
      "--host-resolver-rules=MAP frame.test 127.0.0.1",
    ],
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headful: true,
    userDataDir: profile,
  });

  const attached = new Map<string, TargetRef>();
  const active = new Map<string, TargetRef>();
  const ready = new Set<string>();
  const setupErrors: unknown[] = [];
  const infoChanges = new Set<string>();

  try {
    browser.onTargetInfoChanged((info) => infoChanges.add(info.targetId));
    browser.onDetached((target) => active.delete(target.targetId));
    browser.onAttached((target) => {
      console.log(
        `attached target=${target.targetId} session=${target.sessionId} type=${target.type}`,
      );
      assert(!attached.has(target.targetId), `duplicate attach for ${target.targetId}`);
      attached.set(target.targetId, target);
      active.set(target.targetId, target);
      void (async () => {
        await browser.send(target.sessionId, "Page.enable");
        await browser.send(target.sessionId, "Runtime.enable");
        await browser.send(target.sessionId, "Runtime.runIfWaitingForDebugger");
        ready.add(target.sessionId);
      })().catch((error: unknown) => setupErrors.push(error));
    });

    await waitFor("initial page target", () => attached.size > 0);
    const initialPage = [...attached.values()].find((target) => target.type === "page");
    assert(initialPage, "launcher did not attach the initial page");
    await waitFor("initial page resume", () => ready.has(initialPage.sessionId));
    await browser.send(initialPage.sessionId, "Page.navigate", {
      url: `http://127.0.0.1:${port}/`,
    });
    await waitFor("fixture document", async () => {
      const result = (await browser.send(initialPage.sessionId, "Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      return result.result?.value === "Launcher fixture";
    });
    const webglResult = (await browser.send(initialPage.sessionId, "Runtime.evaluate", {
      expression: `(() => {
        const probe = (contextType) => {
          const canvas = document.createElement("canvas");
          const context = canvas.getContext(contextType);
          if (context === null) return { exists: false, renderer: "" };
          const debugInfo = context.getExtension("WEBGL_debug_renderer_info");
          const renderer = debugInfo === null
            ? context.getParameter(context.RENDERER)
            : context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
          return { exists: true, renderer: typeof renderer === "string" ? renderer : "" };
        };
        return { webgl1: probe("webgl"), webgl2: probe("webgl2") };
      })()`,
      returnByValue: true,
    })) as {
      result?: {
        value?: {
          webgl1?: { exists?: unknown; renderer?: unknown };
          webgl2?: { exists?: unknown; renderer?: unknown };
        };
      };
    };
    const webgl = webglResult.result?.value;
    for (const [name, probe] of Object.entries({ webgl1: webgl?.webgl1, webgl2: webgl?.webgl2 })) {
      assert.equal(probe?.exists, true, `${name} context is unavailable`);
      assert.equal(
        typeof probe.renderer === "string" && probe.renderer.trim() !== "",
        true,
        `${name} renderer is empty`,
      );
    }
    console.log(
      `WebGL accept: webgl1=${JSON.stringify(webgl?.webgl1?.renderer)} ` +
        `webgl2=${JSON.stringify(webgl?.webgl2?.renderer)}`,
    );
    await browser.send(initialPage.sessionId, "Runtime.evaluate", {
      expression: `window.open('http://127.0.0.1:${port}/popup', '_blank')`,
      userGesture: true,
    });

    await waitFor("popup and OOPIF attachments", () => {
      const targets = [...attached.values()];
      return (
        targets.filter((target) => target.type === "page").length >= 2 &&
        targets.some((target) => target.type === "iframe")
      );
    });
    await waitFor("worker and service worker execution", async () => {
      const result = (await browser.send(initialPage.sessionId, "Runtime.evaluate", {
        expression: "document.body.dataset.worker + ':' + document.body.dataset.serviceWorker",
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      return result.result?.value === "worker-ready:registered";
    });

    assert.deepEqual(setupErrors, []);
    assert([...attached.values()].every((target) => ["page", "iframe"].includes(target.type)));
    assert(
      [...attached.values()].some((target) => target.openerTabId !== undefined),
      "popup attachment did not include its opener target",
    );
    assert(infoChanges.size > 0, "no typed target-info changes were emitted");

    for (const target of active.values()) {
      const result = (await browser.send(target.sessionId, "Runtime.evaluate", {
        expression: "6 * 7",
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      assert.equal(result.result?.value, 42, `target ${target.targetId} remained paused`);
    }

    const counts = [...attached.values()].reduce(
      (result, target) => {
        result[target.type] += 1;
        return result;
      },
      { page: 0, iframe: 0 },
    );
    console.log(
      `P0-LAUNCH accept: ${counts.page} page targets, ${counts.iframe} OOPIF targets; all resumed`,
    );
  } finally {
    await browser.close();
    await closeServer(server);
    xvfb?.kill("SIGTERM");
    await rm(profile, { force: true, recursive: true });
  }
}

await main();
