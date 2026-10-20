/**
 * Full-stack local smoke test.
 *
 * Starts `pnpm dev`, launches a second system-Chromium instance for the viewer, drives the
 * authoritative pipe-connected browser through MIRROR_E2E-only gateway routes, and observes
 * the actual websocket frames delivered to the viewer. The SPA assertion must be satisfied by
 * deltas in the existing epoch; it deliberately never calls the forced-snapshot route. Run
 * `--runs=5` for the acceptance gate.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";

const START_TIMEOUT_MS = 60_000;
const NAV_TIMEOUT_MS = 75_000;
const POLL_MS = 100;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPA_MARKER = "Welcome to the React documentation!";

interface SnapshotFrame {
  t: "snapshot";
  tab: string;
  epoch: number;
  seq: number;
}

interface DeltaFrame {
  t: "delta";
  tab: string;
  epoch: number;
  seq: number;
  events: number;
}

type ObservedFrame = SnapshotFrame | DeltaFrame;

interface GatewayState {
  tabs: Array<{ tab: string; epoch: number; docId: number; seq: number; url: string }>;
}

interface PageResult {
  name: string;
  url: string;
  epoch: number;
  docId: number;
  textLength: number;
}

interface RunResult {
  run: number;
  elapsedMs: number;
  pages: PageResult[];
  spa: {
    from: string;
    to: string;
    docId: number;
    epoch: number;
    deltaFrames: number;
    deltaEvents: number;
  };
  latency: { rttMs: number; skewMs: number; eventToPaintMs: number };
}

interface ClockProbe {
  rttMs: number;
  /** Gateway wall clock minus viewer wall clock. */
  skewMs: number;
}

function parseRuns(): number {
  const arg = process.argv.find((value) => value.startsWith("--runs="));
  const runs = Number(arg?.slice("--runs=".length) ?? 1);
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  return runs;
}

async function freePort(): Promise<number> {
  const server = createServer();
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
      VIEWER_PORT: String(viewerPort),
      VITE_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk: Buffer): void => {
    const text = chunk.toString();
    output = (output + text).slice(-200_000);
    if (process.env.SMOKE_VERBOSE === "1") process.stderr.write(text);
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

async function jsonRequest<T>(baseUrl: string, path: string, body?: object): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok)
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function state(baseUrl: string): Promise<GatewayState> {
  return jsonRequest<GatewayState>(baseUrl, "/__e2e/state");
}

async function currentTab(baseUrl: string): Promise<GatewayState["tabs"][number]> {
  return waitFor(
    "gateway page target",
    START_TIMEOUT_MS,
    async () => (await state(baseUrl)).tabs[0],
  );
}

function maxEpoch(frames: readonly ObservedFrame[], tab: string): number {
  return frames.reduce(
    (max, frame) =>
      frame.t === "snapshot" && frame.tab === tab ? Math.max(max, frame.epoch) : max,
    0,
  );
}

async function mirrorText(page: Page, expected: string): Promise<string> {
  await page.waitForFunction(
    ({ marker }) => {
      const host = document.querySelector<HTMLElement>("#mirror-host");
      const iframe = host?.querySelector<HTMLIFrameElement>("iframe");
      const text = iframe?.contentDocument?.body?.innerText ?? "";
      return (
        host?.dataset.mirrorState === "live" && text.includes(marker) && text.trim().length > 0
      );
    },
    { marker: expected },
    { timeout: NAV_TIMEOUT_MS },
  );
  return page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>("#mirror-host iframe");
    return iframe?.contentDocument?.body?.innerText ?? "";
  });
}

async function currentMirrorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>("#mirror-host iframe");
    return iframe?.contentDocument?.body?.innerText ?? "";
  });
}

async function waitForSnapshot(
  frames: readonly ObservedFrame[],
  tab: string,
  afterEpoch: number,
): Promise<number> {
  return waitFor(`viewer snapshot epoch > ${afterEpoch}`, NAV_TIMEOUT_MS, () => {
    const epoch = maxEpoch(frames, tab);
    return epoch > afterEpoch ? epoch : undefined;
  });
}

async function hardNavigate(
  viewerUrl: string,
  page: Page,
  frames: readonly ObservedFrame[],
  name: string,
  url: string,
  marker: string,
): Promise<PageResult> {
  const before = await currentTab(viewerUrl);
  const beforeEpoch = maxEpoch(frames, before.tab);
  await jsonRequest(viewerUrl, "/__e2e/navigate", { tab: before.tab, url });
  await waitFor(`${name} target URL`, NAV_TIMEOUT_MS, async () => {
    const tab = await currentTab(viewerUrl);
    return tab.url.startsWith(url) ? tab : undefined;
  });
  const epoch = await waitForSnapshot(frames, before.tab, beforeEpoch);
  const text = await mirrorText(page, marker);
  const after = await currentTab(viewerUrl);
  assert(epoch > beforeEpoch, `${name} did not increment the viewer snapshot epoch`);
  assert(text.trim().length > 0, `${name} mirror innerText was empty`);
  return { name, url: after.url, epoch, docId: after.docId, textLength: text.trim().length };
}

async function remoteValue<T>(viewerUrl: string, tab: string, expression: string): Promise<T> {
  const response = await jsonRequest<{ value: T }>(viewerUrl, "/__e2e/evaluate", {
    tab,
    expression,
  });
  return response.value;
}

async function measureClock(page: Page): Promise<ClockProbe> {
  return page.evaluate(async () => {
    const samples: ClockProbe[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const sentAt = Date.now();
      const started = performance.now();
      const response = await fetch(`/__e2e/probe?sample=${sample}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`latency probe returned ${response.status}`);
      const body = (await response.json()) as { serverTs?: unknown };
      const receivedAt = Date.now();
      const rttMs = performance.now() - started;
      if (typeof body.serverTs !== "number") throw new Error("latency probe omitted serverTs");
      samples.push({
        rttMs,
        skewMs: body.serverTs - (sentAt + receivedAt) / 2,
      });
    }
    samples.sort((left, right) => left.rttMs - right.rttMs);
    return samples[0]!;
  });
}

async function runOnce(run: number, chromePath: string): Promise<RunResult> {
  const started = Date.now();
  const [gatewayPort, viewerPort] = await Promise.all([freePort(), freePort()]);
  assert.notEqual(gatewayPort, viewerPort);
  const viewerUrl = `http://127.0.0.1:${viewerPort}`;
  const dev = startDev(chromePath, gatewayPort, viewerPort);
  let viewerBrowser: Browser | undefined;
  const viewerLogs: string[] = [];

  try {
    await waitFor("gateway health", START_TIMEOUT_MS, async () => {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
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
    const frames: ObservedFrame[] = [];
    page.on("websocket", (socket) => {
      socket.on("socketerror", (error) => viewerLogs.push(`websocket error: ${error}`));
      socket.on("close", () => viewerLogs.push(`websocket closed: ${socket.url()}`));
      socket.on("framereceived", ({ payload }) => {
        try {
          const parsed = JSON.parse(String(payload)) as Partial<SnapshotFrame> & { t?: unknown };
          if (
            parsed.t === "snapshot" &&
            typeof parsed.tab === "string" &&
            typeof parsed.epoch === "number" &&
            typeof parsed.seq === "number"
          ) {
            frames.push({ t: "snapshot", tab: parsed.tab, epoch: parsed.epoch, seq: parsed.seq });
          } else if (
            parsed.t === "delta" &&
            typeof parsed.tab === "string" &&
            typeof parsed.epoch === "number" &&
            typeof parsed.seq === "number" &&
            Array.isArray((parsed as { data?: unknown }).data)
          ) {
            frames.push({
              t: "delta",
              tab: parsed.tab,
              epoch: parsed.epoch,
              seq: parsed.seq,
              events: (parsed as { data: unknown[] }).data.length,
            });
          }
        } catch {
          // Only JSON websocket application frames are relevant to this assertion.
        }
      });
    });
    await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: START_TIMEOUT_MS });
    await page.waitForSelector('#connection-state[data-state="open"]', {
      timeout: START_TIMEOUT_MS,
    });
    const clock = await measureClock(page);

    const pages: PageResult[] = [];
    pages.push(
      await hardNavigate(
        viewerUrl,
        page,
        frames,
        "Wikipedia",
        "https://en.wikipedia.org/wiki/Remote_desktop_software",
        "Remote desktop software",
      ),
    );
    pages.push(
      await hardNavigate(
        viewerUrl,
        page,
        frames,
        "Hacker News",
        "https://news.ycombinator.com/",
        "Hacker News",
      ),
    );
    pages.push(
      await hardNavigate(viewerUrl, page, frames, "React SPA", "https://react.dev/", "React"),
    );

    const spaBefore = await currentTab(viewerUrl);
    assert.equal(
      (await currentMirrorText(page)).includes(SPA_MARKER),
      false,
      `SPA marker was already present before the route change: ${SPA_MARKER}`,
    );
    await waitFor("React SPA /learn link", NAV_TIMEOUT_MS, async () => {
      const exists = await remoteValue<boolean>(
        viewerUrl,
        spaBefore.tab,
        "Boolean(document.querySelector('a[href=\"/learn\"]'))",
      );
      return exists ? true : undefined;
    });
    const spaEpoch = maxEpoch(frames, spaBefore.tab);
    assert(spaEpoch > 0, "React SPA had no viewer snapshot epoch");
    const frameIndexBeforeClick = frames.length;
    const clicked = await remoteValue<{ from: string; eventTs: number } | null>(
      viewerUrl,
      spaBefore.tab,
      `(() => {
        const link = document.querySelector('a[href="/learn"]');
        if (!(link instanceof HTMLAnchorElement)) return null;
        const before = location.href;
        const eventTs = Date.now();
        link.click();
        return { from: before, eventTs };
      })()`,
    );
    assert(clicked, "React SPA link was not clickable");
    await waitFor("React client-side route", NAV_TIMEOUT_MS, async () => {
      const pathname = await remoteValue<string>(viewerUrl, spaBefore.tab, "location.pathname");
      return pathname === "/learn" ? pathname : undefined;
    });
    const spaRouted = await currentTab(viewerUrl);
    assert.equal(
      spaRouted.docId,
      spaBefore.docId,
      "React route replaced the document; expected a client-side SPA navigation",
    );

    const spaText = await mirrorText(page, SPA_MARKER);
    assert(spaText.trim().length > 0, "React SPA mirror innerText was empty");
    const paintedAt = await page.evaluate(
      () =>
        new Promise<number>((resolvePaint) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolvePaint(Date.now()))),
        ),
    );
    const spaAfter = await currentTab(viewerUrl);
    assert.equal(spaAfter.docId, spaBefore.docId, "SPA deltas crossed a document epoch");
    assert.equal(spaAfter.epoch, spaBefore.epoch, "SPA route unexpectedly opened a gateway epoch");
    assert.equal(
      maxEpoch(frames, spaBefore.tab),
      spaEpoch,
      "SPA route unexpectedly delivered a viewer snapshot",
    );
    const spaFrames = frames.slice(frameIndexBeforeClick);
    assert.equal(
      spaFrames.some((frame) => frame.t === "snapshot" && frame.tab === spaBefore.tab),
      false,
      "SPA route was satisfied by a snapshot instead of deltas",
    );
    const spaDeltas = spaFrames.filter(
      (frame): frame is DeltaFrame =>
        frame.t === "delta" && frame.tab === spaBefore.tab && frame.epoch === spaEpoch,
    );
    assert(spaDeltas.length > 0, "SPA /learn content painted without a post-click delta frame");
    const deltaEvents = spaDeltas.reduce((total, frame) => total + frame.events, 0);
    assert(deltaEvents > 0, "SPA post-click delta frames contained no events");
    const eventToPaintMs = paintedAt - (clicked.eventTs - clock.skewMs);
    assert(
      Number.isFinite(eventToPaintMs) && eventToPaintMs >= 0,
      `invalid event-to-paint measurement ${eventToPaintMs}`,
    );

    return {
      run,
      elapsedMs: Date.now() - started,
      pages,
      spa: {
        from: clicked.from,
        to: spaAfter.url,
        docId: spaAfter.docId,
        epoch: spaEpoch,
        deltaFrames: spaDeltas.length,
        deltaEvents,
      },
      latency: { rttMs: clock.rttMs, skewMs: clock.skewMs, eventToPaintMs },
    };
  } catch (error) {
    const logs = dev.logs();
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `${cause.message}\n\n--- viewer log ---\n${viewerLogs.join("\n")}\n\n--- pnpm dev tail ---\n${logs}`,
      { cause },
    );
  } finally {
    await viewerBrowser?.close().catch(() => undefined);
    await stopDev(dev.child);
  }
}

async function main(): Promise<void> {
  const chromePath = process.env.CHROME_PATH;
  if (chromePath === undefined || chromePath.trim() === "") {
    throw new Error("CHROME_PATH must point to the system Chromium executable");
  }
  await access(chromePath);

  const runs = parseRuns();
  const results: RunResult[] = [];
  for (let run = 1; run <= runs; run += 1) {
    const result = await runOnce(run, chromePath);
    results.push(result);
    console.log(
      `P0-E2E run ${run}/${runs} GREEN in ${(result.elapsedMs / 1000).toFixed(1)}s: ` +
        result.pages
          .map((item) => `${item.name}=epoch${item.epoch}/${item.textLength}chars`)
          .join(", ") +
        `, React /learn SPA=DELTA epoch${result.spa.epoch}/doc${result.spa.docId}` +
        `/${result.spa.deltaFrames}frames/${result.spa.deltaEvents}events` +
        `, RTT=${result.latency.rttMs.toFixed(1)}ms` +
        `, skew=${result.latency.skewMs.toFixed(1)}ms` +
        `, event-to-paint=${result.latency.eventToPaintMs.toFixed(1)}ms`,
    );
  }
  const median = (values: number[]): number => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  };
  console.log(
    `Latency medians: RTT=${median(results.map((result) => result.latency.rttMs)).toFixed(1)}ms` +
      `, skew=${median(results.map((result) => result.latency.skewMs)).toFixed(1)}ms` +
      `, event-to-paint=${median(results.map((result) => result.latency.eventToPaintMs)).toFixed(
        1,
      )}ms`,
  );
  console.log(`P0-E2E ${results.length}/${runs} consecutive full-stack smoke runs GREEN`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
