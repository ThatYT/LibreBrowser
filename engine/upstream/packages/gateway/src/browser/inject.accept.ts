/**
 * Live acceptance for P0-INJECT.
 *
 * Run from the repository root:
 *   pnpm -F @mirror/gateway exec tsx src/browser/inject.accept.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { AgentMsg } from "@mirror/protocol";

import type { TargetRef } from "../types";
import { createAgentLink } from "./agentlink";
import { launchBrowser } from "./launch";

const TIMEOUT_MS = 20_000;

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function startXvfb(): Promise<ChildProcess | undefined> {
  if (process.env.DISPLAY) return undefined;
  const displayNumber = 600 + (process.pid % 300);
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
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html>
      <html><head><title>${path}</title></head>
      <body><main data-page="${path}">hard navigation ${path}</main>
      <script>setTimeout(() => document.body.dataset.ready = ${JSON.stringify(path)}, 0)</script>
      </body></html>`);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
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

async function nextDocument(
  iterator: AsyncIterator<AgentMsg>,
  expectedUrl: string,
  currentDoc: { value?: number },
): Promise<{ docId: number; rrwebEvents: number }> {
  const deadline = Date.now() + TIMEOUT_MS;
  let matchedDocId: number | undefined;
  let rrwebEvents = 0;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${expectedUrl}`)),
        remaining,
      );
    });
    const result = await Promise.race([iterator.next(), timeout]).finally(() =>
      clearTimeout(timer),
    );
    assert(!result.done, `target detached while waiting for ${expectedUrl}`);
    const msg = result.value;
    if (msg.kind === "hello") {
      currentDoc.value = msg.docId;
      if (msg.url === expectedUrl) matchedDocId = msg.docId;
      continue;
    }
    if (msg.kind !== "rrweb") continue;
    assert.equal(msg.docId, currentDoc.value, `stale docId ${msg.docId} passed downstream`);
    if (msg.docId === matchedDocId && ++rrwebEvents >= 2) {
      return { docId: matchedDocId, rrwebEvents };
    }
  }
  throw new Error(`Timed out waiting for events from ${expectedUrl}`);
}

async function main(): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "mirror-p0-inject-"));
  const xvfb = await startXvfb();
  const server = fixtureServer();
  const port = await listen(server);
  const browser = await launchBrowser({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headful: true,
    userDataDir: profile,
  });
  const link = createAgentLink(browser);
  const targets = new Map<string, TargetRef>();

  try {
    browser.onAttached((target) => targets.set(target.targetId, target));
    await waitFor("initial page target", () =>
      [...targets.values()].some((target) => target.type === "page"),
    );
    const page = [...targets.values()].find((target) => target.type === "page");
    assert(page);
    const iterator = link.msgs(page.targetId)[Symbol.asyncIterator]();
    const currentDoc: { value?: number } = {};
    const documents: { docId: number; rrwebEvents: number }[] = [];

    for (const path of ["/page-1", "/page-2", "/page-3"]) {
      const url = `http://127.0.0.1:${port}${path}`;
      await browser.send(page.sessionId, "Page.navigate", { url });
      const document = await nextDocument(iterator, url, currentDoc);
      documents.push(document);
      console.log(`hello docId=${document.docId} url=${url}; rrweb=${document.rrwebEvents}`);
    }

    assert.equal(new Set(documents.map(({ docId }) => docId)).size, 3, "docIds were not distinct");
    // Warm the Runtime.evaluate path once; the D1 latency budget is the steady-state local-pipe
    // round trip, not Chromium's first-command/JIT setup cost.
    assert.deepEqual(await link.sendCmd(page.targetId, { cmd: "ping" }), {
      reqId: 1,
      ok: true,
      data: "pong",
    });
    const started = performance.now();
    const pong = await link.sendCmd(page.targetId, { cmd: "ping" });
    const roundTripMs = performance.now() - started;
    assert.deepEqual(pong, { reqId: 2, ok: true, data: "pong" });
    assert(roundTripMs < 20, `ping round trip ${roundTripMs.toFixed(2)}ms exceeded 20ms`);
    console.log(
      `P0-INJECT accept: 3 hard navigations, 3 distinct docIds, zero stale events, ping ${roundTripMs.toFixed(2)}ms`,
    );
  } finally {
    await browser.close();
    await closeServer(server);
    xvfb?.kill("SIGTERM");
    await rm(profile, { force: true, recursive: true });
  }
}

await main();
