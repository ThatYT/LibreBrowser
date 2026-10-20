/**
 * Holistic local-stack acceptance.
 *
 * One real gateway/browser/agent/viewer stack is kept alive while this script exercises the v1
 * feature spine. The OOPIF Chromium wrapper is reused so the cross-site fixture is a genuine
 * iframe target. Fan-out is checked twice: six real viewer pages receive one live mutation, then
 * the production Fanout/ViewerConn path is instrumented to prove one serialization per broadcast.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeDown,
  EventType,
  IncrementalSource,
  type AgentMsg,
  type Down,
  type eventWithTime,
} from "@mirror/protocol";
import { chromium, type Browser, type Frame, type FrameLocator, type Page } from "playwright";

import { mintInvite } from "../packages/gateway/src/auth/invite";
import { SESSION_COOKIE } from "../packages/gateway/src/auth/middleware";
import { TabHub } from "../packages/gateway/src/hub/tabhub";
import { Fanout } from "../packages/gateway/src/ws/server";
import { ViewerConn, type ViewerSocket } from "../packages/gateway/src/ws/viewerconn";
import { closeFixtureSite, startFixtureSite, type FixtureSite } from "./mirror-diff/fixture-server";
import { acquireHarnessLock, stopProcessGroup } from "./mirror-diff/harness";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME_WRAPPER = resolve(REPO_ROOT, "scripts/mirror-diff/chromium-oopif-wrapper.sh");
const START_TIMEOUT_MS = 120_000;
const ACTION_TIMEOUT_MS = 45_000;
const SHORT_TIMEOUT_MS = 8_000;
const POLL_MS = 100;
const FANOUT_MUTATIONS = 200;
const TEST_DOWNLOAD = Buffer.from("v1 acceptance one-time download\n", "utf8");
const E2E_AUTH_SECRET = "v1-acceptance-local-secret";

interface GatewayState {
  tabs: Array<{ tab: string; epoch: number; docId: number; seq: number; url: string }>;
}

interface FeatureResult {
  feature: string;
  status: "PASS" | "FAIL";
  detail: string;
  durationMs: number;
}

interface WireLog {
  received: string[];
  sent: string[];
  snapshots: Array<{ tab: string; epoch: number }>;
}

interface FanoutMeasurement {
  viewers: number;
  broadcasts: number;
  serializations: number;
  writes: number;
  serializeUsPerBroadcast: number;
  writeUsPerFollower: number;
  totalUsPerBroadcast: number;
}

class MeasuredSocket implements ViewerSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  writeNs = 0n;

  send(data: string): void {
    const started = process.hrtime.bigint();
    this.sent.push(data);
    this.writeNs += process.hrtime.bigint() - started;
  }

  clear(): void {
    this.sent.length = 0;
    this.writeNs = 0n;
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.href.replace(/\/$/, "");
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
  const suffix = lastError === undefined ? "" : `: ${errorDetail(lastError)}`;
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), { cache: "no-store" });
  if (!response.ok)
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function currentTab(gatewayUrl: string): Promise<GatewayState["tabs"][number]> {
  return waitFor("gateway page target", START_TIMEOUT_MS, async () => {
    const state = await getJson<GatewayState>(gatewayUrl, "/__e2e/state");
    return state.tabs[0];
  });
}

async function remoteValue<T>(gatewayUrl: string, tab: string, expression: string): Promise<T> {
  return (await postJson<{ value: T }>(gatewayUrl, "/__e2e/evaluate", { tab, expression })).value;
}

async function rectFallbackCount(gatewayUrl: string, tab: string): Promise<number> {
  const stats = await getJson<{ rectFallbacks?: unknown }>(
    gatewayUrl,
    `/__e2e/input-stats?tab=${encodeURIComponent(tab)}`,
  );
  assert(
    typeof stats.rectFallbacks === "number" && Number.isSafeInteger(stats.rectFallbacks),
    "rect-fallback counter was not an integer",
  );
  return stats.rectFallbacks;
}

async function waitForOopifInputReady(
  viewer: Page,
  child: FrameLocator,
  sourceChild: Frame,
  gatewayUrl: string,
  tab: string,
): Promise<number> {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  let probes = 0;
  let stableSince: number | undefined;
  while (Date.now() < deadline) {
    probes += 1;
    const before = await rectFallbackCount(gatewayUrl, tab);
    try {
      await child.locator("#field-a").click({ timeout: 3_000 });
      await waitFor("authoritative OOPIF field-a focus", 3_000, async () =>
        (await sourceChild.evaluate(() => document.activeElement?.id)) === "field-a"
          ? true
          : undefined,
      );
      await viewer.keyboard.press("Tab");
      await waitFor("authoritative OOPIF field-b focus", 3_000, async () =>
        (await sourceChild.evaluate(() => document.activeElement?.id)) === "field-b"
          ? true
          : undefined,
      );
      const after = await rectFallbackCount(gatewayUrl, tab);
      if (after === before) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= 1_000) return probes;
      } else {
        stableSince = undefined;
      }
    } catch {
      stableSince = undefined;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
  }
  throw new Error(`OOPIF resolve readiness did not stabilize after ${probes} probes`);
}

function startDev(
  chromePath: string,
  gatewayPort: number,
  viewerPort: number,
  cdpPort: number,
): { child: ChildProcess; logs: () => string } {
  const child = spawn("pnpm", ["dev"], {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...process.env,
      CHROME_PATH: CHROME_WRAPPER,
      CHROME_HEADFUL: "0",
      GATEWAY_PORT: String(gatewayPort),
      MIRROR_E2E: "1",
      P2_DIFF_CHROME_REAL: chromePath,
      P2_DIFF_CDP_PORT: String(cdpPort),
      VIEWER_PORT: String(viewerPort),
      VITE_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
      MIRROR_AUTH_SECRET: E2E_AUTH_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk: Buffer): void => {
    const text = chunk.toString();
    output = (output + text).slice(-250_000);
    if (process.env.V1_ACCEPTANCE_VERBOSE === "1") process.stderr.write(text);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, logs: () => output };
}

function observeWire(page: Page): WireLog {
  const log: WireLog = { received: [], sent: [], snapshots: [] };
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const raw = String(payload);
      log.received.push(raw);
      try {
        const message = JSON.parse(raw) as { t?: unknown; tab?: unknown; epoch?: unknown };
        if (
          message.t === "snapshot" &&
          typeof message.tab === "string" &&
          typeof message.epoch === "number"
        ) {
          log.snapshots.push({ tab: message.tab, epoch: message.epoch });
        }
      } catch {
        // Binary/control frames are irrelevant to this application-frame acceptance.
      }
    });
    socket.on("framesent", ({ payload }) => log.sent.push(String(payload)));
  });
  return log;
}

function mirrorTop(page: Page): FrameLocator {
  return page.frameLocator("#mirror-host iframe");
}

function mirrorChild(page: Page): FrameLocator {
  return mirrorTop(page).frameLocator("#oopif-frame");
}

async function authoritativeChild(page: Page, hostname: string): Promise<Frame> {
  return waitFor(`${hostname} authoritative child`, ACTION_TIMEOUT_MS, () =>
    page.frames().find((frame) => {
      if (frame.parentFrame() === null) return false;
      try {
        return new URL(frame.url()).hostname === hostname;
      } catch {
        return false;
      }
    }),
  );
}

async function navigateViewer(
  page: Page,
  gatewayUrl: string,
  url: string,
  marker: string,
): Promise<GatewayState["tabs"][number]> {
  const urlbar = page.locator('#urlbar input[aria-label="Address"]');
  await urlbar.fill(url);
  await urlbar.press("Enter");
  const tab = await waitFor(`authoritative navigation to ${url}`, ACTION_TIMEOUT_MS, async () => {
    const candidate = await currentTab(gatewayUrl);
    return normalizedUrl(candidate.url) === normalizedUrl(url) ? candidate : undefined;
  });
  await page.waitForFunction(
    ({ expected }) => {
      const host = document.querySelector<HTMLElement>("#mirror-host");
      const frame = host?.querySelector<HTMLIFrameElement>("iframe");
      return (
        host?.dataset.mirrorState === "live" &&
        (frame?.contentDocument?.body?.innerText ?? "").includes(expected)
      );
    },
    { expected: marker },
    { timeout: ACTION_TIMEOUT_MS },
  );
  return tab;
}

async function runFeature(
  results: FeatureResult[],
  feature: string,
  assertion: () => void | string | Promise<void | string>,
): Promise<boolean> {
  const started = performance.now();
  try {
    const returned = await assertion();
    const detail = typeof returned === "string" ? returned : "assertion satisfied";
    results.push({ feature, status: "PASS", detail, durationMs: performance.now() - started });
    return true;
  } catch (error) {
    results.push({
      feature,
      status: "FAIL",
      detail: errorDetail(error),
      durationMs: performance.now() - started,
    });
    return false;
  }
}

function printFeatureTable(results: readonly FeatureResult[]): void {
  const featureWidth = Math.max(
    "Feature".length,
    ...results.map((result) => result.feature.length),
  );
  const statusWidth = 6;
  const border = `+-${"-".repeat(featureWidth)}-+-${"-".repeat(statusWidth)}-+----------------------+`;
  console.log("\nV1 FULL-STACK FEATURE TABLE");
  console.log(border);
  console.log(
    `| ${"Feature".padEnd(featureWidth)} | ${"Result".padEnd(statusWidth)} | Detail               |`,
  );
  console.log(border);
  for (const result of results) {
    const detail = result.detail.replaceAll(/\s+/g, " ").slice(0, 160);
    console.log(
      `| ${result.feature.padEnd(featureWidth)} | ${result.status.padEnd(statusWidth)} | ${detail}`,
    );
  }
  console.log(border);
}

async function startAcceptanceSite(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    void handleAcceptanceRequest(request, response).catch((error: unknown) => {
      response.writeHead(500).end(errorDetail(error));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function handleAcceptanceRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://v1.test");
  response.setHeader("cache-control", "no-store");
  if (request.method === "GET" && url.pathname === "/v1") {
    const nav = url.searchParams.get("nav") === "1";
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>V1 integrated fixture</title>
      <style>body{font:18px system-ui;margin:32px}input,button{font:inherit;padding:8px}#scrollbox{height:110px;width:420px;overflow:auto;border:2px solid #345;margin:16px 0}.space{height:700px}</style></head>
      <body><main><h1 id="v1-marker">V1 integrated ${nav ? "navigation" : "mirror"} fixture</h1>
      <label>Integrated input <input id="v1-input" autocomplete="off"></label>
      <div id="scrollbox"><div class="space">scroll origin<br>${"convergence row<br>".repeat(30)}scroll end</div></div>
      <p id="mutation-target">mutation baseline</p>
      <a id="download-link" href="/download.bin" download="v1-acceptance.txt">Download acceptance bytes</a>
      </main></body></html>`);
    return;
  }
  if (request.method === "GET" && url.pathname === "/download.bin") {
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("content-disposition", 'attachment; filename="v1-acceptance.txt"');
    response.setHeader("content-length", String(TEST_DOWNLOAD.length));
    response.end(TEST_DOWNLOAD);
    return;
  }
  response.writeHead(404).end("not found");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
}

async function runFullStack(
  chromePath: string,
): Promise<{ results: FeatureResult[]; measurement?: FanoutMeasurement }> {
  const results: FeatureResult[] = [];
  const fixture: FixtureSite = await startFixtureSite();
  const acceptanceSite = await startAcceptanceSite();
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  assert.equal(new Set(ports).size, ports.length, "acceptance ports collided");
  const [gatewayPort, viewerPort, cdpPort] = ports;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const viewerUrl = `http://127.0.0.1:${viewerPort}`;
  const dev = startDev(chromePath, gatewayPort, viewerPort, cdpPort);
  let viewerBrowser: Browser | undefined;
  let authoritativeBrowser: Browser | undefined;
  const viewerErrors: string[] = [];
  let driver: Page | undefined;
  let driverWire: WireLog | undefined;
  let tab: GatewayState["tabs"][number] | undefined;

  try {
    await Promise.all([
      waitFor("gateway health", START_TIMEOUT_MS, async () =>
        (await fetch(`${gatewayUrl}/healthz`)).ok ? true : undefined,
      ),
      waitFor("viewer dev server", START_TIMEOUT_MS, async () =>
        (await fetch(viewerUrl)).ok ? true : undefined,
      ),
      waitFor("authoritative Chromium CDP endpoint", START_TIMEOUT_MS, async () =>
        (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok ? true : undefined,
      ),
    ]);
    if (dev.child.exitCode !== null) throw new Error(`pnpm dev exited early\n${dev.logs()}`);

    // The observer must not issue its own Browser.setDownloadBehavior: that would replace the
    // gateway's download directory and make the acceptance client mutate the behavior under test.
    const cdpObserverOptions = { noDefaults: true } as NonNullable<
      Parameters<typeof chromium.connectOverCDP>[1]
    > & { noDefaults: true };
    authoritativeBrowser = await chromium.connectOverCDP(
      `http://127.0.0.1:${cdpPort}`,
      cdpObserverOptions,
    );
    const sourcePage = authoritativeBrowser.contexts()[0]?.pages()[0];
    assert(sourcePage, "authoritative Chromium exposed no page");
    viewerBrowser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    driver = await viewerBrowser.newPage({ viewport: { width: 1280, height: 800 } });
    driver.setDefaultTimeout(ACTION_TIMEOUT_MS);
    driver.on("console", (message) => {
      if (message.type() === "error") viewerErrors.push(`console.error: ${message.text()}`);
    });
    driver.on("pageerror", (error) => viewerErrors.push(`pageerror: ${error.message}`));
    driverWire = observeWire(driver);
    await driver.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: START_TIMEOUT_MS });
    await driver.waitForSelector('#connection-state[data-state="open"]', {
      timeout: START_TIMEOUT_MS,
    });

    await runFeature(results, "live mirror", async () => {
      tab = await navigateViewer(
        driver!,
        gatewayUrl,
        `${acceptanceSite.url}/v1`,
        "V1 integrated mirror fixture",
      );
      const text = await mirrorTop(driver!).locator("body").innerText();
      assert(text.includes("Integrated input"), "mirror omitted the form");
      return `${text.trim().length} mirrored characters, epoch ${tab.epoch}`;
    });

    await runFeature(results, "navigation", async () => {
      tab = await navigateViewer(
        driver!,
        gatewayUrl,
        `${acceptanceSite.url}/v1?nav=1`,
        "V1 integrated navigation fixture",
      );
      assert(new URL(tab.url).searchParams.has("nav"));
      return `URL bar → ${tab.url}`;
    });

    await runFeature(results, "click + TYPE", async () => {
      assert(tab, "navigation prerequisite failed");
      const expected = "v1-integrated-type-exact";
      const input = mirrorTop(driver!).locator("#v1-input");
      await input.click();
      await driver!.keyboard.type(expected);
      await waitFor("authoritative integrated input", ACTION_TIMEOUT_MS, async () =>
        (await remoteValue<string>(
          gatewayUrl,
          tab!.tab,
          "document.querySelector('#v1-input')?.value ?? ''",
        )) === expected
          ? true
          : undefined,
      );
      assert.equal(await input.inputValue(), expected);
      return `server == mirror == ${JSON.stringify(expected)}`;
    });

    await runFeature(results, "scroll convergence", async () => {
      assert(tab, "navigation prerequisite failed");
      const scroller = mirrorTop(driver!).locator("#scrollbox");
      await scroller.hover();
      await driver!.mouse.wheel(0, 360);
      const converged = await waitFor(
        "server/mirror scroll convergence",
        ACTION_TIMEOUT_MS,
        async () => {
          const [server, mirror] = await Promise.all([
            remoteValue<number>(
              gatewayUrl,
              tab!.tab,
              "document.querySelector('#scrollbox')?.scrollTop ?? 0",
            ),
            scroller.evaluate((element) => element.scrollTop),
          ]);
          return server > 0 && mirror > 0 && Math.abs(server - mirror) <= 5
            ? { server, mirror }
            : undefined;
        },
      );
      return `server=${converged.server}, mirror=${converged.mirror}`;
    });

    await runFeature(results, "cross-origin OOPIF", async () => {
      const oopifUrl = `http://a.test:${fixture.port}/fixtures/oopif`;
      tab = await navigateViewer(driver!, gatewayUrl, oopifUrl, "a.test parent intact");
      await mirrorChild(driver!)
        .locator("#oopif-child-marker[data-site='b.test']")
        .waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
      const sourceChild = await authoritativeChild(sourcePage, "b.test");
      const child = mirrorChild(driver!);
      const probes = await waitForOopifInputReady(driver!, child, sourceChild, gatewayUrl, tab.tab);
      await child.locator("#action-link").click();
      await waitFor("authoritative OOPIF anchor", ACTION_TIMEOUT_MS, async () =>
        (await sourceChild.locator("#action-output").textContent()) === "Anchor activated on server"
          ? true
          : undefined,
      );
      const expected = "v1-oopif-interactive";
      await child.locator("#field-b").click();
      await driver!.keyboard.type(expected);
      await waitFor("OOPIF server/mirror input", ACTION_TIMEOUT_MS, async () => {
        const [server, mirror] = await Promise.all([
          sourceChild.locator("#field-b").inputValue(),
          child.locator("#field-b").inputValue(),
        ]);
        return server === expected && mirror === expected ? true : undefined;
      });
      return `b.test stitched, anchor trusted, server == mirror input (${probes} readiness probes)`;
    });

    await runFeature(results, "forced resync", async () => {
      assert(tab && driverWire, "OOPIF navigation prerequisite failed");
      const beforeEpoch = Math.max(
        0,
        ...driverWire.snapshots
          .filter((snapshot) => snapshot.tab === tab!.tab)
          .map((snapshot) => snapshot.epoch),
      );
      await driver!.evaluate(() => {
        const state = { whiteScreens: 0, timer: 0 };
        state.timer = window.setInterval(() => {
          const host = document.querySelector<HTMLElement>("#mirror-host");
          const frame = host?.querySelector<HTMLIFrameElement>("iframe");
          if (host?.dataset.mirrorState === "live" && !frame?.contentDocument?.body) {
            state.whiteScreens += 1;
          }
        }, 25);
        (window as typeof window & { __v1ResyncMonitor?: typeof state }).__v1ResyncMonitor = state;
      });
      await postJson(gatewayUrl, "/__e2e/snapshot", { tab: tab.tab });
      const epoch = await waitFor("fresh forced-resync snapshot", ACTION_TIMEOUT_MS, () => {
        const next = Math.max(
          0,
          ...driverWire!.snapshots
            .filter((snapshot) => snapshot.tab === tab!.tab)
            .map((snapshot) => snapshot.epoch),
        );
        return next > beforeEpoch ? next : undefined;
      });
      await mirrorChild(driver!)
        .locator("#oopif-child-marker[data-site='b.test']")
        .waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
      const whiteScreens = await driver!.evaluate(() => {
        const state = (
          window as typeof window & {
            __v1ResyncMonitor?: { whiteScreens: number; timer: number };
          }
        ).__v1ResyncMonitor;
        if (state === undefined) return -1;
        clearInterval(state.timer);
        return state.whiteScreens;
      });
      assert.equal(whiteScreens, 0, "forced resync exposed a white screen");
      return `epoch ${beforeEpoch} → ${epoch}, whiteScreens=0`;
    });

    await runFeature(results, "multi-tab open/switch/close", async () => {
      const initialTabs = driver!.locator("#tabstrip .browser-tab");
      await waitFor("initial tab metadata", SHORT_TIMEOUT_MS, async () =>
        (await initialTabs.count()) === 1 ? true : undefined,
      );
      await driver!.locator("#new-tab").click();
      await waitFor("second tab", ACTION_TIMEOUT_MS, async () =>
        (await initialTabs.count()) === 2 ? true : undefined,
      );
      const tabIds = await initialTabs
        .locator(".tab-activate")
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("title") ?? button.textContent ?? ""),
        );
      await initialTabs.nth(0).locator(".tab-activate").click();
      await waitFor("first tab activation", ACTION_TIMEOUT_MS, async () =>
        (await initialTabs.nth(0).getAttribute("data-active")) !== null ? true : undefined,
      );
      await initialTabs.nth(1).locator(".tab-close").click();
      await waitFor("tab close", ACTION_TIMEOUT_MS, async () =>
        (await initialTabs.count()) === 1 ? true : undefined,
      );
      return `opened/switched/closed (${tabIds.length} streamed tabs)`;
    });

    await runFeature(results, "px-mode round-trip", async () => {
      const toggle = driver!.getByRole("button", { name: "Use pixel view" });
      await toggle.click();
      await driver!.locator("#mirror-host canvas").waitFor({
        state: "visible",
        timeout: ACTION_TIMEOUT_MS,
      });
      await driver!.getByRole("button", { name: "Use DOM view" }).click();
      await driver!.locator("#mirror-host iframe").waitFor({
        state: "visible",
        timeout: ACTION_TIMEOUT_MS,
      });
      await mirrorChild(driver!)
        .locator("#oopif-child-marker[data-site='b.test']")
        .waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
      return "dom → px canvas → dom fresh snapshot";
    });

    await runFeature(results, "HUD RTT + mode", async () => {
      const hud = driver!.locator("#resync-hud");
      const rtt = await waitFor("HUD RTT sample", ACTION_TIMEOUT_MS, async () => {
        const value = await hud.getAttribute("data-rtt-ms");
        return value !== null && value !== "" && Number.isFinite(Number(value))
          ? Number(value)
          : undefined;
      });
      await hud.locator("summary").click();
      const mode = await hud.locator(".hud-mode").first().textContent();
      assert.equal(mode?.trim(), "dom", "HUD did not report DOM mode after round-trip");
      return `RTT=${rtt}ms, mode=dom`;
    });

    await runFeature(results, "one-time download", async () => {
      tab = await navigateViewer(
        driver!,
        gatewayUrl,
        `${acceptanceSite.url}/v1`,
        "V1 integrated mirror fixture",
      );
      await mirrorTop(driver!).locator("#download-link").click();
      const entry = driver!.locator('.download-entry[data-state="done"]');
      await entry.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
      const href = await entry.locator("a.download-save").getAttribute("href");
      assert(href, "completed download did not mint a link");
      const token = mintInvite(
        {
          sid: "dev",
          role: "driver",
          exp: Math.floor(Date.now() / 1_000) + 300,
        },
        Buffer.from(E2E_AUTH_SECRET),
      );
      const headers = { cookie: `${SESSION_COOKIE}=${token}` };
      const first = await fetch(new URL(href, gatewayUrl), { headers });
      const firstBody = Buffer.from(await first.arrayBuffer());
      assert.equal(
        first.status,
        200,
        `first download redemption failed: ${firstBody.toString("utf8")}`,
      );
      assert.deepEqual(firstBody, TEST_DOWNLOAD);
      const second = await fetch(new URL(href, gatewayUrl), { headers });
      assert.equal(second.status, 404, "one-time link was reusable");
      return `${TEST_DOWNLOAD.length} bytes; redemption 200 then 404`;
    });

    let measurement: FanoutMeasurement | undefined;
    const pages: Page[] = [driver!];
    const wires: WireLog[] = [driverWire!];
    await runFeature(results, "fan-out 1 + 5", async () => {
      assert(tab, "download navigation prerequisite failed");
      measurement = measureSingleStringify();
      assert.equal(measurement.serializations, measurement.broadcasts);
      assert.equal(measurement.writes, measurement.broadcasts * measurement.viewers);
      for (let index = 1; index < 6; index += 1) {
        const follower = await viewerBrowser!.newPage({ viewport: { width: 1024, height: 700 } });
        const wire = observeWire(follower);
        await follower.goto(viewerUrl, {
          waitUntil: "domcontentloaded",
          timeout: START_TIMEOUT_MS,
        });
        await follower.waitForSelector('#connection-state[data-state="open"]', {
          timeout: START_TIMEOUT_MS,
        });
        await mirrorTop(follower).locator("#v1-marker").waitFor({
          state: "visible",
          timeout: ACTION_TIMEOUT_MS,
        });
        pages.push(follower);
        wires.push(wire);
      }
      const marker = `fanout-${Date.now()}`;
      const starts = wires.map((wire) => wire.received.length);
      await remoteValue(
        gatewayUrl,
        tab!.tab,
        `(()=>{document.querySelector('#mutation-target').textContent=${JSON.stringify(marker)};return true})()`,
      );
      await waitFor("identical live mutation at all six viewers", ACTION_TIMEOUT_MS, () =>
        wires.every((wire, index) =>
          wire.received.slice(starts[index]).some((raw) => raw.includes(marker)),
        )
          ? true
          : undefined,
      );
      for (const page of pages) {
        await mirrorTop(page).locator("#mutation-target").filter({ hasText: marker }).waitFor({
          state: "visible",
          timeout: ACTION_TIMEOUT_MS,
        });
      }

      return (
        `6/6 live stream; ${measurement.serializations}/${measurement.broadcasts} serializations, ` +
        `${measurement.writeUsPerFollower.toFixed(2)}µs/follower write`
      );
    });

    await runFeature(results, "roles/presence", async () => {
      const presenceCount = await driver!.locator("#presence-chrome li").count();
      assert.equal(
        presenceCount,
        6,
        `6/6 viewers received the live stream, but presence listed ${presenceCount}/6`,
      );
      assert.equal(
        await driver!.locator("#presence-chrome").getAttribute("data-viewer-role"),
        "driver",
        "followers perturbed the driver role",
      );
      for (const follower of pages.slice(1)) {
        assert.equal(
          await follower.locator("#presence-chrome").getAttribute("data-viewer-role"),
          "follower",
          "additional viewer was not a follower",
        );
      }
      for (const follower of pages.slice(1)) await follower.close();
      await waitFor("followers leaving presence", SHORT_TIMEOUT_MS, async () =>
        (await driver!.locator("#presence-chrome li").count()) === 1 ? true : undefined,
      );
      assert.equal(
        await driver!.locator("#presence-chrome").getAttribute("data-viewer-role"),
        "driver",
        "follower departure perturbed the driver",
      );

      return "6 joined, 5 followers, driver stable; leaves converged to 1 driver";
    });

    return { results, ...(measurement === undefined ? {} : { measurement }) };
  } catch (error) {
    throw new Error(
      `${errorDetail(error)}\n\n--- viewer errors ---\n${viewerErrors.join("\n")}\n\n--- pnpm dev tail ---\n${dev.logs()}`,
      { cause: error },
    );
  } finally {
    await authoritativeBrowser?.close().catch(() => undefined);
    await viewerBrowser?.close().catch(() => undefined);
    await stopProcessGroup(dev.child);
    await closeFixtureSite(fixture.server).catch(() => undefined);
    await closeServer(acceptanceSite.server).catch(() => undefined);
  }
}

function mutationEvent(index: number): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: index + 10,
    data: {
      source: IncrementalSource.Mutation,
      texts: [{ id: 3, value: `fanout mutation ${index}` }],
      attributes: [],
      removes: [],
      adds: [],
    },
  };
}

function readyHub(): TabHub {
  const hub = new TabHub({ sessionId: "v1-load", tabId: "shared-tab" });
  hub.ingest({
    kind: "hello",
    docId: 1,
    url: "https://fanout.test/",
    isTop: true,
    ts: 1,
  });
  hub.ingest({
    kind: "rrweb",
    docId: 1,
    e: {
      type: EventType.Meta,
      timestamp: 2,
      data: { href: "https://fanout.test/", width: 1280, height: 720 },
    },
  });
  hub.ingest({
    kind: "rrweb",
    docId: 1,
    e: {
      type: EventType.FullSnapshot,
      timestamp: 3,
      data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
    },
  });
  return hub;
}

function measureSingleStringify(): FanoutMeasurement {
  const hub = readyHub();
  const fanout = new Fanout(1);
  const sockets = Array.from({ length: 6 }, () => new MeasuredSocket());
  const viewers = sockets.map((socket) => new ViewerConn(socket, () => hub.joinPayload()));
  const driver = viewers[0]!;
  fanout.addViewer(driver);
  for (const viewer of viewers.slice(1)) fanout.addViewer(viewer);
  for (const socket of sockets) socket.clear();

  let serializations = 0;
  let serializeNs = 0n;
  let insideBroadcast = false;
  const originalStringify = JSON.stringify;
  JSON.stringify = function instrumentedStringify(...args: Parameters<typeof JSON.stringify>) {
    const value = args[0] as { t?: unknown; tab?: unknown } | undefined;
    const measured = insideBroadcast && value?.t === "delta" && value.tab === "shared-tab";
    const started = measured ? process.hrtime.bigint() : 0n;
    const serialized = originalStringify.apply(JSON, args as [unknown, ...unknown[]]);
    if (measured) {
      serializations += 1;
      serializeNs += process.hrtime.bigint() - started;
    }
    return serialized;
  } as typeof JSON.stringify;

  const started = process.hrtime.bigint();
  try {
    for (let index = 0; index < FANOUT_MUTATIONS; index += 1) {
      const agentMessage: AgentMsg = { kind: "rrweb", docId: 1, e: mutationEvent(index) };
      const messages = hub.ingest(agentMessage);
      insideBroadcast = true;
      try {
        for (const message of messages) fanout.publish(message);
        fanout.flushAll();
      } finally {
        insideBroadcast = false;
      }
    }
  } finally {
    JSON.stringify = originalStringify;
  }
  const elapsedNs = process.hrtime.bigint() - started;
  const writes = sockets.reduce((total, socket) => total + socket.sent.length, 0);
  assert.equal(serializations, FANOUT_MUTATIONS, "fan-out serialized more than once per broadcast");
  assert.equal(
    writes,
    FANOUT_MUTATIONS * sockets.length,
    "not every viewer received every mutation",
  );
  for (let index = 0; index < FANOUT_MUTATIONS; index += 1) {
    const reference = sockets[0]!.sent[index];
    assert(reference, `driver missed mutation ${index}`);
    for (const socket of sockets.slice(1)) {
      assert.equal(socket.sent[index], reference, `follower stream diverged at mutation ${index}`);
    }
    const decoded: Down = decodeDown(reference);
    assert.equal(decoded.t, "delta");
  }

  const driverWrites = sockets[0]!.sent.length;
  for (const viewer of viewers.slice(1)) fanout.removeViewer(viewer);
  const finalMessage: AgentMsg = {
    kind: "rrweb",
    docId: 1,
    e: mutationEvent(FANOUT_MUTATIONS + 1),
  };
  for (const message of hub.ingest(finalMessage)) fanout.publish(message);
  fanout.flushAll();
  assert.equal(sockets[0]!.sent.length, driverWrites + 1, "follower departure perturbed driver");
  assert.equal(driver.isStalled, false, "healthy driver stalled during follower churn");
  fanout.close();

  const writeNs = sockets.reduce((total, socket) => total + socket.writeNs, 0n);
  return {
    viewers: sockets.length,
    broadcasts: FANOUT_MUTATIONS,
    serializations,
    writes,
    serializeUsPerBroadcast: Number(serializeNs) / FANOUT_MUTATIONS / 1_000,
    writeUsPerFollower: Number(writeNs) / writes / 1_000,
    totalUsPerBroadcast: Number(elapsedNs) / FANOUT_MUTATIONS / 1_000,
  };
}

function printFanoutMeasurement(measurement: FanoutMeasurement): void {
  console.log(
    `FAN-OUT MEASUREMENT: viewers=${measurement.viewers}, broadcasts=${measurement.broadcasts}, ` +
      `serializations=${measurement.serializations} (1.000/broadcast), writes=${measurement.writes}, ` +
      `serialize=${measurement.serializeUsPerBroadcast.toFixed(2)}µs/broadcast, ` +
      `WS-write=${measurement.writeUsPerFollower.toFixed(2)}µs/follower, ` +
      `total=${measurement.totalUsPerBroadcast.toFixed(2)}µs/broadcast PASS`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--fanout-measure-only")) {
    printFanoutMeasurement(measureSingleStringify());
    return;
  }
  const chromePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
  await Promise.all([access(chromePath), access(CHROME_WRAPPER)]);
  const releaseLock = await acquireHarnessLock();
  try {
    const { results, measurement } = await runFullStack(chromePath);
    printFeatureTable(results);
    if (measurement !== undefined) printFanoutMeasurement(measurement);
    const failed = results.filter((result) => result.status === "FAIL");
    assert.equal(
      failed.length,
      0,
      `V1 integrated smoke failed: ${failed.map((result) => `${result.feature}: ${result.detail}`).join("; ")}`,
    );
    console.log(`V1 ACCEPTANCE: ${results.length}/${results.length} FEATURES PASS`);
  } finally {
    await releaseLock();
  }
}

void main().catch((error: unknown) => {
  console.error("V1 ACCEPTANCE FAIL:", error);
  process.exitCode = 1;
});
