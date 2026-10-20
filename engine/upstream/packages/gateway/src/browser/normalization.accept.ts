/**
 * Real-Chrome acceptance for the ordinary-browser launch and recorder transport footprint.
 *
 * Run from the repository root after building @mirror/agent:
 *   pnpm -F @mirror/gateway exec tsx src/browser/normalization.accept.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMsg } from "@mirror/protocol";

import type { TargetRef } from "../types";
import { agentBridgeChannel } from "./bridge";
import { createAgentLink } from "./agentlink";
import { launchBrowser } from "./launch";

const TIMEOUT_MS = 20_000;

async function waitFor<T>(description: string, read: () => T | undefined | Promise<T | undefined>) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function startXvfb(): Promise<ChildProcess | undefined> {
  if (process.env.DISPLAY) return undefined;
  const displayNumber = 300 + (process.pid % 200);
  const display = `:${displayNumber}`;
  const child = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
    stdio: "ignore",
  });
  await waitFor("Xvfb", async () => {
    try {
      await access(`/tmp/.X11-unix/X${displayNumber}`);
      return true;
    } catch {
      return undefined;
    }
  });
  process.env.DISPLAY = display;
  return child;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

async function waitForHello(iterator: AsyncIterator<AgentMsg>, expectedUrl: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (true) {
          const next = await iterator.next();
          if (next.done) throw new Error("Agent stream ended before canonical hello");
          if (next.value.kind === "hello" && next.value.url === expectedUrl) return;
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for agent hello at ${expectedUrl}`)),
          TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

interface NormalizationProbe {
  initial: {
    webdriver: unknown;
    userAgent: string;
    fixed: string[];
    privateNames: string[];
    symbols: string[];
  };
  current: {
    webdriver: unknown;
    userAgent: string;
    fixed: string[];
    privateNames: string[];
    symbols: string[];
  };
  bridgePresent: boolean;
  stackGetterAccessed: boolean;
}

async function probeNormalization(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  sessionId: string,
  privateNames: readonly string[],
  bridgeKey: string,
): Promise<NormalizationProbe> {
  const evaluated = (await browser.send(sessionId, "Runtime.evaluate", {
    expression: `(async () => {
      let stackGetterAccessed = false;
      const error = new Error("runtime-leak-probe");
      Object.defineProperty(error, "stack", { get() { stackGetterAccessed = true; return ""; } });
      console.debug(error);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const fixedNames = ["__mirror_emit", "__mirror_rtc_emit", "__mirror_cmd", "__mirror_node"];
      const privateNames = ${JSON.stringify(privateNames)};
      return {
        current: {
          webdriver: navigator.webdriver,
          userAgent: navigator.userAgent,
          fixed: fixedNames.filter((name) => name in globalThis),
          privateNames: privateNames.filter((name) => name in globalThis),
          symbols: Object.getOwnPropertySymbols(globalThis)
            .map((symbol) => Symbol.keyFor(symbol) || symbol.description || "")
            .filter((name) => /mirror/i.test(name)),
        },
        initial: globalThis.__fixture_initial,
        bridgePresent: Object.prototype.hasOwnProperty.call(
          globalThis, ${JSON.stringify(bridgeKey)}),
        stackGetterAccessed,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: NormalizationProbe }; exceptionDetails?: unknown };
  assert.equal(evaluated.exceptionDetails, undefined);
  assert(evaluated.result?.value);
  return evaluated.result.value;
}

function assertNormalized(probe: NormalizationProbe): void {
  assert.equal(probe.initial.webdriver, false);
  assert.equal(probe.current.webdriver, false);
  assert(!probe.initial.userAgent.includes("HeadlessChrome"));
  assert(!probe.current.userAgent.includes("HeadlessChrome"));
  assert.deepEqual(probe.initial.fixed, []);
  assert.deepEqual(probe.current.fixed, []);
  assert.deepEqual(probe.initial.privateNames, []);
  assert.deepEqual(probe.current.privateNames, []);
  assert.deepEqual(probe.initial.symbols, []);
  assert.deepEqual(probe.current.symbols, []);
  assert.equal(probe.bridgePresent, false);
  assert.equal(probe.stackGetterAccessed, false);
}

async function main(): Promise<void> {
  let privateNames: string[] = [];
  const handler = (_request: unknown, response: import("node:http").ServerResponse) => {
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Cache-Control", "no-store");
    response.end(`<!doctype html><title>normalization fixture</title>
      <script>
        const privateNames = ${JSON.stringify(privateNames)};
        globalThis.__fixture_initial = {
          webdriver: navigator.webdriver,
          userAgent: navigator.userAgent,
          fixed: ["__mirror_emit", "__mirror_rtc_emit", "__mirror_cmd", "__mirror_node"]
            .filter((name) => name in globalThis),
          symbols: Object.getOwnPropertySymbols(globalThis)
            .map((symbol) => Symbol.keyFor(symbol) || symbol.description || "")
            .filter((name) => /mirror/i.test(name)),
          privateNames: privateNames.filter((name) => name in globalThis),
        };
      </script><main id="ready">ready</main>`);
  };
  const server = createServer(handler);
  const crossOriginServer = createServer(handler);
  const port = await listen(server);
  const crossOriginPort = await listen(crossOriginServer);
  const profile = await mkdtemp(join(tmpdir(), "mirror-normalization-"));
  const xvfb = await startXvfb();
  const browser = await launchBrowser({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headful: true,
    userDataDir: profile,
  });
  const sentMethods: string[] = [];
  const originalSend = browser.send;
  browser.send = async (sessionId, method, params) => {
    sentMethods.push(method);
    return originalSend(sessionId, method, params);
  };
  const targets = new Map<string, TargetRef>();
  browser.onAttached((target) => targets.set(target.targetId, target));
  const link = createAgentLink(browser);

  try {
    const page = await waitFor("page target", () =>
      [...targets.values()].find((target) => target.type === "page"),
    );
    const iterator = link.msgs(page.targetId)[Symbol.asyncIterator]();
    const channel = agentBridgeChannel(browser, page.sessionId);
    assert(channel);
    privateNames = [channel.bindingName, channel.rtcBindingName];
    const url = `http://127.0.0.1:${port}/`;
    await browser.send(page.sessionId, "Page.navigate", { url });
    await waitForHello(iterator, url);
    assert.deepEqual(await link.sendCmd(page.targetId, { cmd: "ping" }), {
      reqId: 1,
      ok: true,
      data: "pong",
    });
    assertNormalized(
      await probeNormalization(browser, page.sessionId, privateNames, channel.bridgeKey),
    );

    const crossOriginUrl = `http://127.0.0.1:${crossOriginPort}/`;
    await browser.send(page.sessionId, "Page.navigate", { url: crossOriginUrl });
    await waitForHello(iterator, crossOriginUrl);
    assert.deepEqual(await link.sendCmd(page.targetId, { cmd: "ping" }), {
      reqId: 2,
      ok: true,
      data: "pong",
    });
    assertNormalized(
      await probeNormalization(browser, page.sessionId, privateNames, channel.bridgeKey),
    );
    assert(!sentMethods.includes("Runtime.enable"));
    console.log(
      `normalization accept: webdriver=false; headful UA; no fixed/private globals or symbols; ` +
        `bridge removed; Runtime.enable absent before and after cross-origin navigation`,
    );
  } finally {
    await browser.close();
    xvfb?.kill("SIGTERM");
    await closeServer(server);
    await closeServer(crossOriginServer);
    await rm(profile, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
