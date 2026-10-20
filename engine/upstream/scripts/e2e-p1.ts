/**
 * Full-stack interactivity acceptance.
 *
 * Serves a local form, starts the real gateway/browser/agent/viewer stack, and drives only the
 * viewer UI. The gateway applies 20ms to each WebSocket direction (40ms application-frame RTT),
 * so local echo is exercised against delayed authoritative input mutations. Default: 10 runs.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventType, IncrementalSource } from "@mirror/protocol";
import { chromium, type Browser, type Page } from "playwright";

const RUNS_DEFAULT = 10;
const SIMULATED_RTT_MS = 40;
const START_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 20_000;
const POLL_MS = 25;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface GatewayState {
  tabs: Array<{ tab: string; epoch: number; docId: number; seq: number; url: string }>;
}

interface Submission {
  run: number;
  value: string;
  receivedAt: number;
}

interface RunResult {
  run: number;
  value: string;
  clickToPaintMs: number;
  keyFrames: number;
  inputEchoEvents: number;
}

interface WireObservation {
  sent: unknown[];
  inputEchoEvents: number;
}

function parseRuns(): number {
  const arg = process.argv.find((value) => value.startsWith("--runs="));
  const runs = Number(arg?.slice("--runs=".length) ?? RUNS_DEFAULT);
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  return runs;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return port;
}

async function waitFor<T>(
  description: string,
  timeoutMs: number,
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${detail}`);
}

function startDev(
  chromePath: string,
  gatewayPort: number,
  viewerPort: number,
): { child: ChildProcess; logs: () => string } {
  const child = spawn("pnpm", ["dev"], {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...process.env,
      CHROME_PATH: chromePath,
      CHROME_HEADFUL: "0",
      GATEWAY_PORT: String(gatewayPort),
      MIRROR_E2E: "1",
      MIRROR_E2E_WS_RTT_MS: String(SIMULATED_RTT_MS),
      VIEWER_PORT: String(viewerPort),
      VITE_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk: Buffer): void => {
    const text = chunk.toString();
    output = (output + text).slice(-200_000);
    if (process.env.E2E_P1_VERBOSE === "1") process.stderr.write(text);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, logs: () => output };
}

async function stopDev(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 10_000)),
  ]);
  if (stopped || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await exited;
}

async function jsonRequest<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), { cache: "no-store" });
  if (!response.ok)
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function currentTab(gatewayUrl: string): Promise<GatewayState["tabs"][number]> {
  return waitFor("gateway page target", START_TIMEOUT_MS, async () => {
    const state = await jsonRequest<GatewayState>(gatewayUrl, "/__e2e/state");
    return state.tabs[0];
  });
}

async function remoteValue<T>(gatewayUrl: string, tab: string, expression: string): Promise<T> {
  const response = await fetch(new URL("/__e2e/evaluate", gatewayUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab, expression }),
  });
  if (!response.ok)
    throw new Error(`remote evaluate returned ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { value: T }).value;
}

function observeWire(page: Page): WireObservation {
  const observation: WireObservation = { sent: [], inputEchoEvents: 0 };
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        observation.sent.push(JSON.parse(String(payload)) as unknown);
      } catch {
        // Only JSON application frames participate in this acceptance.
      }
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as { t?: unknown; data?: unknown };
        if (message.t !== "delta" || !Array.isArray(message.data)) return;
        observation.inputEchoEvents += message.data.filter(isInputEvent).length;
      } catch {
        // Only JSON application frames participate in this acceptance.
      }
    });
  });
  return observation;
}

function isInputEvent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const event = value as { type?: unknown; data?: { source?: unknown } };
  return (
    event.type === EventType.IncrementalSnapshot && event.data?.source === IncrementalSource.Input
  );
}

function messageTag(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tag = (value as { t?: unknown }).t;
  return typeof tag === "string" ? tag : undefined;
}

async function runFormRoundTrip(
  run: number,
  page: Page,
  gatewayUrl: string,
  siteUrl: string,
  submissions: Map<number, Submission>,
  wire: WireObservation,
): Promise<RunResult> {
  const value = `phase-one-run-${String(run).padStart(2, "0")}-local-echo`;
  const formUrl = `${siteUrl}/form?run=${run}`;
  const urlbar = page.locator('#urlbar input[aria-label="Address"]');
  await urlbar.fill(formUrl);
  await urlbar.press("Enter");

  await page.waitForFunction(
    ({ expectedRun }) => {
      const iframe = document.querySelector<HTMLIFrameElement>("#mirror-host iframe");
      return (
        document.querySelector<HTMLElement>("#mirror-host")?.dataset.mirrorState === "live" &&
        iframe?.contentDocument?.querySelector("#p1-form")?.getAttribute("data-run") === expectedRun
      );
    },
    { expectedRun: String(run) },
    { timeout: ACTION_TIMEOUT_MS },
  );
  const tab = await waitFor(`run ${run} target navigation`, ACTION_TIMEOUT_MS, async () => {
    const candidate = await currentTab(gatewayUrl);
    return candidate.url === formUrl ? candidate : undefined;
  });

  await waitFor(`run ${run} viewport acknowledgement`, ACTION_TIMEOUT_MS, () =>
    wire.sent.some((message) => messageTag(message) === "view-ack") ? true : undefined,
  );

  const frame = page.frameLocator("#mirror-host iframe");
  const input = frame.locator("#p1-message");
  await input.click();
  await waitFor(`run ${run} authoritative input focus`, ACTION_TIMEOUT_MS, async () =>
    (await remoteValue<string>(gatewayUrl, tab.tab, "document.activeElement?.id ?? ''")) ===
    "p1-message"
      ? true
      : undefined,
  );

  const sentBeforeTyping = wire.sent.length;
  const echoBeforeTyping = wire.inputEchoEvents;
  await page.keyboard.type(value);
  assert.equal(
    await input.inputValue(),
    value,
    `run ${run} local echo did not preserve typed value`,
  );

  let lastRemoteValue = "";
  try {
    await waitFor(`run ${run} authoritative typed value`, ACTION_TIMEOUT_MS, async () => {
      lastRemoteValue = await remoteValue<string>(
        gatewayUrl,
        tab.tab,
        "document.querySelector('#p1-message')?.value ?? ''",
      );
      return lastRemoteValue === value ? true : undefined;
    });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (last value ${JSON.stringify(lastRemoteValue)})`,
      { cause: error },
    );
  }
  await waitFor(`run ${run} rrweb input echo`, ACTION_TIMEOUT_MS, () =>
    wire.inputEchoEvents > echoBeforeTyping ? true : undefined,
  );
  assert.equal(
    await input.inputValue(),
    value,
    `run ${run} authoritative echo fought the optimistic local value`,
  );

  const keyFrames = wire.sent
    .slice(sentBeforeTyping)
    .filter((message) => messageTag(message) === "key").length;
  assert.equal(
    keyFrames,
    value.length * 2,
    `run ${run} did not send one key down/up pair per character`,
  );

  await page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>("#mirror-host iframe");
    const button = iframe?.contentDocument?.querySelector("#p1-submit");
    if (button === null || button === undefined)
      throw new Error("mirrored submit button is unavailable");
    const timing = window as typeof window & { __p1ClickAt?: number };
    timing.__p1ClickAt = undefined;
    button.addEventListener(
      "mousedown",
      () => {
        timing.__p1ClickAt = performance.now();
      },
      { capture: true, once: true },
    );
  });

  await frame.locator("#p1-submit").click();
  const submitted = await waitFor(`run ${run} server submission`, ACTION_TIMEOUT_MS, () =>
    submissions.get(run),
  );
  assert.equal(submitted.value, value, `run ${run} server recorded the wrong value`);

  const reflected = `Submitted value: ${value}`;
  await page.waitForFunction(
    ({ marker }) => {
      const iframe = document.querySelector<HTMLIFrameElement>("#mirror-host iframe");
      return (
        document.querySelector<HTMLElement>("#mirror-host")?.dataset.mirrorState === "live" &&
        (iframe?.contentDocument?.body?.innerText ?? "").includes(marker)
      );
    },
    { marker: reflected },
    { timeout: ACTION_TIMEOUT_MS },
  );
  const clickToPaintMs = await page.evaluate(async () => {
    // waitForFunction above polls on animation frames; one following frame crosses the paint
    // boundary without charging an unrelated extra refresh interval to the interaction.
    await new Promise<void>((resolvePaint) => requestAnimationFrame(() => resolvePaint()));
    const clickedAt = (window as typeof window & { __p1ClickAt?: number }).__p1ClickAt;
    if (clickedAt === undefined) throw new Error("viewer click timestamp was not captured");
    return performance.now() - clickedAt;
  });
  assert(Number.isFinite(clickToPaintMs) && clickToPaintMs >= 0);

  return {
    run,
    value,
    clickToPaintMs,
    keyFrames,
    inputEchoEvents: wire.inputEchoEvents - echoBeforeTyping,
  };
}

async function startTestSite(): Promise<{
  server: Server;
  url: string;
  submissions: Map<number, Submission>;
}> {
  const submissions = new Map<number, Submission>();
  const server = createServer((request, response) => {
    void handleTestSiteRequest(request, response, submissions).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}`, submissions };
}

async function handleTestSiteRequest(
  request: IncomingMessage,
  response: ServerResponse,
  submissions: Map<number, Submission>,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://p1.test");
  response.setHeader("cache-control", "no-store");

  if (request.method === "GET" && requestUrl.pathname === "/form") {
    const run = Number(requestUrl.searchParams.get("run"));
    if (!Number.isSafeInteger(run) || run < 1) {
      response.writeHead(400).end("invalid run");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>P1 form ${run}</title>
<style>body{font:20px system-ui;margin:48px}label,input,button{display:block}input{font:inherit;width:440px;margin:10px 0 18px;padding:10px}button{font:inherit;padding:10px 18px}</style>
</head><body><main><h1>Phase-1 form run ${run}</h1>
<form id="p1-form" data-run="${run}" method="post" action="/submit">
<input type="hidden" name="run" value="${run}">
<label for="p1-message">Message</label>
<input id="p1-message" name="message" type="text" autocomplete="off">
<button id="p1-submit" type="submit">Submit value</button>
</form></main></body></html>`);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/submit") {
    const body = await readBody(request);
    const form = new URLSearchParams(body);
    const run = Number(form.get("run"));
    const value = form.get("message") ?? "";
    if (!Number.isSafeInteger(run) || run < 1 || !/^phase-one-run-\d+-local-echo$/.test(value)) {
      response.writeHead(400).end("invalid submission");
      return;
    }
    submissions.set(run, { run, value, receivedAt: Date.now() });
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Submitted</title>
<style>body{font:24px system-ui;margin:48px}</style></head>
<body><main><h1 id="p1-result">Submitted value: ${value}</h1></main></body></html>`);
    return;
  }

  response.writeHead(404).end("not found");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

async function main(): Promise<void> {
  const chromePath = process.env.CHROME_PATH;
  if (chromePath === undefined || chromePath.trim() === "") {
    throw new Error("CHROME_PATH must point to the system Chromium executable");
  }
  await access(chromePath);

  const runs = parseRuns();
  const [gatewayPort, viewerPort] = await Promise.all([freePort(), freePort()]);
  assert.notEqual(gatewayPort, viewerPort);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const viewerUrl = `http://127.0.0.1:${viewerPort}`;
  const site = await startTestSite();
  const dev = startDev(chromePath, gatewayPort, viewerPort);
  let viewerBrowser: Browser | undefined;
  const viewerLogs: string[] = [];

  try {
    await waitFor("gateway health", START_TIMEOUT_MS, async () => {
      const response = await fetch(`${gatewayUrl}/healthz`);
      return response.ok ? true : undefined;
    });
    await waitFor("Vite viewer", START_TIMEOUT_MS, async () => {
      const response = await fetch(viewerUrl);
      return response.ok ? true : undefined;
    });
    if (dev.child.exitCode !== null) throw new Error(`pnpm dev exited early\n${dev.logs()}`);

    viewerBrowser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await viewerBrowser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (message) =>
      viewerLogs.push(`console.${message.type()}: ${message.text()}`),
    );
    page.on("pageerror", (error) => viewerLogs.push(`pageerror: ${error.message}`));
    const wire = observeWire(page);
    await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: START_TIMEOUT_MS });
    await page.waitForSelector('#connection-state[data-state="open"]', {
      timeout: START_TIMEOUT_MS,
    });
    await currentTab(gatewayUrl);

    const results: RunResult[] = [];
    for (let run = 1; run <= runs; run += 1) {
      const result = await runFormRoundTrip(
        run,
        page,
        gatewayUrl,
        site.url,
        site.submissions,
        wire,
      );
      results.push(result);
      console.log(
        `P1-E2E run ${run}/${runs} GREEN: value=${result.value}` +
          `, key-pairs=${result.keyFrames / 2}` +
          `, server-echo-events=${result.inputEchoEvents}` +
          `, click-to-paint=${result.clickToPaintMs.toFixed(1)}ms @ ${SIMULATED_RTT_MS}ms RTT`,
      );
    }

    const medianClickToPaintMs = median(results.map((result) => result.clickToPaintMs));
    console.log(
      `P1-E2E median click-to-paint=${medianClickToPaintMs.toFixed(1)}ms` +
        ` @ ${SIMULATED_RTT_MS}ms simulated gateway-WS RTT`,
    );
    assert(
      medianClickToPaintMs < 250,
      `median click-to-paint ${medianClickToPaintMs.toFixed(1)}ms must be <250ms`,
    );
    assert.equal(site.submissions.size, runs, "server did not record every form round-trip");
    console.log(`P1-E2E form round-trip ${results.length}/${runs} GREEN`);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `${cause.message}\n\n--- viewer log ---\n${viewerLogs.join("\n")}\n\n--- pnpm dev tail ---\n${dev.logs()}`,
      { cause },
    );
  } finally {
    await viewerBrowser?.close().catch(() => undefined);
    await stopDev(dev.child);
    await closeServer(site.server).catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
