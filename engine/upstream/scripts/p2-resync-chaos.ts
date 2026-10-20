/**
 * P2-RESYNC full-stack chaos acceptance.
 *
 * The gateway randomly drops 1% of batched deltas for this viewer. Each deterministic fixture is
 * mutated through the authoritative browser until several real seq gaps have recovered. A 10ms
 * observer fails on any missing/empty visible mirror; every recovery must converge to the latest
 * authoritative counter before the next mutation is allowed.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";

import { acquireHarnessLock, stopProcessGroup } from "./mirror-diff/harness";
import {
  closeFixtureSite,
  startFixtureSite,
  type FixtureDefinition,
} from "./mirror-diff/fixture-server";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const START_TIMEOUT_MS = 120_000;
const CONVERGENCE_TIMEOUT_MS = 30_000;
const POLL_MS = 25;
const CHAOS_RATE = 0.01;
const QUICK_WINDOW_MS = 3_000;
const PRODUCTION_WINDOW_MS = 30_000;
const DEFAULT_TARGET_RESYNCS = 50;

interface GatewayState {
  tabs: Array<{ tab: string; epoch: number; seq: number; url: string }>;
}

interface ChaosStats {
  deltaMessagesConsidered: number;
  deltaMessagesDropped: number;
  droppedByTab: Record<string, number>;
}

interface ViewerMonitor {
  enabled: boolean;
  samples: number;
  whiteScreens: number;
  lastFailure: string;
}

interface HarnessOptions {
  durationMs: number;
  targetResyncs: number;
  resyncWindowMs: number;
  tenMinutes: boolean;
}

function options(): HarnessOptions {
  const tenMinutes = process.argv.includes("--ten-minutes");
  const targetRaw = process.env.P2_RESYNC_CHAOS_TARGET;
  const targetResyncs = targetRaw === undefined ? DEFAULT_TARGET_RESYNCS : Number(targetRaw);
  if (!Number.isSafeInteger(targetResyncs) || targetResyncs < 1) {
    throw new Error("P2_RESYNC_CHAOS_TARGET must be a positive integer");
  }
  return {
    tenMinutes,
    targetResyncs,
    durationMs: tenMinutes ? 10 * 60_000 : 5 * 60_000,
    // Quick acceptance compresses only the controller's clock window. The production/default
    // command below exercises the authoritative 30-second policy for a full ten minutes.
    resyncWindowMs: tenMinutes ? PRODUCTION_WINDOW_MS : QUICK_WINDOW_MS,
  };
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return address.port;
}

function startDev(
  chromePath: string,
  gatewayPort: number,
  viewerPort: number,
  resyncWindowMs: number,
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
      P2_DIFF_CHAOS: "1",
      P2_DIFF_CHAOS_RATE: String(CHAOS_RATE),
      P2_DIFF_CHAOS_SEED: process.env.P2_DIFF_CHAOS_SEED ?? "p2-resync-committed-proof",
      VIEWER_PORT: String(viewerPort),
      VITE_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
      VITE_P2_RESYNC_WINDOW_MS: String(resyncWindowMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk: Buffer): void => {
    const value = chunk.toString();
    output = (output + value).slice(-200_000);
    if (process.env.P2_RESYNC_CHAOS_VERBOSE === "1") process.stderr.write(value);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, logs: () => output };
}

async function waitFor<T>(
  description: string,
  deadline: number,
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_MS);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${detail}`);
}

async function jsonRequest<T>(baseUrl: string, path: string): Promise<T> {
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

async function currentTab(gatewayUrl: string, deadline: number) {
  return waitFor("gateway page target", deadline, async () => {
    const state = await jsonRequest<GatewayState>(gatewayUrl, "/__e2e/state");
    return state.tabs[0];
  });
}

async function remoteEvaluate<T>(gatewayUrl: string, tab: string, expression: string): Promise<T> {
  const response = await postJson<{ value: T }>(gatewayUrl, "/__e2e/evaluate", {
    tab,
    expression,
  });
  return response.value;
}

async function viewerCounter(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#mirror-host iframe");
    const value = frame?.contentDocument?.querySelector("#p2-chaos-counter")?.textContent;
    if (value === null || value === undefined || value === "") return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  });
}

async function viewerRecoveryState(page: Page): Promise<{ total: number; storm: boolean }> {
  return page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>("#resync-hud");
    return {
      total: Number(hud?.dataset.resyncTotal ?? 0),
      storm: hud?.dataset.resyncStorm === "true",
    };
  });
}

async function setMutationClock(
  gatewayUrl: string,
  tab: string,
  running: boolean,
): Promise<number> {
  return remoteEvaluate<number>(
    gatewayUrl,
    tab,
    `(()=>{const scope=globalThis;const node=document.querySelector('#p2-chaos-counter');if(!node)throw new Error('counter missing');if(scope.__p2ChaosTimer===undefined){scope.__p2ChaosRun=false;scope.__p2ChaosTimer=setInterval(()=>{if(!scope.__p2ChaosRun)return;node.textContent=String(Number(node.textContent||0)+1)},35)}scope.__p2ChaosRun=${String(running)};return Number(node.textContent||0)})()`,
  );
}

async function monitor(page: Page, enabled?: boolean): Promise<ViewerMonitor> {
  return page.evaluate((nextEnabled) => {
    const target = window as typeof window & {
      __p2ResyncMonitor?: ViewerMonitor & { timer?: number };
    };
    let state = target.__p2ResyncMonitor;
    if (state === undefined) {
      state = { enabled: false, samples: 0, whiteScreens: 0, lastFailure: "" };
      target.__p2ResyncMonitor = state;
      state.timer = window.setInterval(() => {
        if (!state?.enabled) return;
        state.samples += 1;
        const host = document.querySelector<HTMLElement>("#mirror-host");
        const frame = host?.querySelector<HTMLIFrameElement>("iframe");
        const text = frame?.contentDocument?.body?.innerText?.trim() ?? "";
        if (
          host?.dataset.mirrorState !== "live" ||
          frame === null ||
          frame === undefined ||
          !text
        ) {
          state.whiteScreens += 1;
          state.lastFailure = JSON.stringify({
            mirrorState: host?.dataset.mirrorState ?? "missing-host",
            iframe: frame !== null && frame !== undefined,
            textLength: text.length,
          });
        }
      }, 10);
    }
    if (nextEnabled !== undefined) state.enabled = nextEnabled;
    return {
      enabled: state.enabled,
      samples: state.samples,
      whiteScreens: state.whiteScreens,
      lastFailure: state.lastFailure,
    };
  }, enabled);
}

async function navigateFixture(
  page: Page,
  gatewayUrl: string,
  tab: string,
  fixture: FixtureDefinition,
  fixtureUrl: string,
  deadline: number,
): Promise<void> {
  await monitor(page, false);
  await postJson(gatewayUrl, "/__e2e/navigate", { tab, url: fixtureUrl });
  await waitFor(`${fixture.label} authoritative navigation`, deadline, async () => {
    const current = await currentTab(gatewayUrl, deadline);
    return current.url === fixtureUrl ? true : undefined;
  });
  await page.waitForFunction(
    ({ marker }) => {
      const host = document.querySelector<HTMLElement>("#mirror-host");
      const frame = host?.querySelector<HTMLIFrameElement>("iframe");
      return (
        host?.dataset.mirrorState === "live" &&
        (frame?.contentDocument?.body?.innerText ?? "").includes(marker)
      );
    },
    { marker: fixture.marker },
    { timeout: START_TIMEOUT_MS },
  );

  await remoteEvaluate(
    gatewayUrl,
    tab,
    `(()=>{let node=document.querySelector('#p2-chaos-counter');if(!node){node=document.createElement('p');node.id='p2-chaos-counter';node.textContent='0';document.body.prepend(node)}return node.textContent})()`,
  );
  await postJson(gatewayUrl, "/__e2e/snapshot", { tab });
  await waitFor(`${fixture.label} chaos counter snapshot`, deadline, async () =>
    (await viewerCounter(page)) === 0 ? true : undefined,
  );
  await setMutationClock(gatewayUrl, tab, false);
  const initialMonitor = await monitor(page, true);
  if (initialMonitor.whiteScreens !== 0) {
    throw new Error(`white screen before ${fixture.label}: ${initialMonitor.lastFailure}`);
  }
}

async function runFixtureChaos(
  page: Page,
  gatewayUrl: string,
  tab: string,
  fixture: FixtureDefinition,
  desiredResyncs: number,
  deadline: number,
  resyncWindowMs: number,
  resyncTimes: number[],
): Promise<number> {
  const baseline = (await viewerRecoveryState(page)).total;
  let latestValue = await setMutationClock(gatewayUrl, tab, true);
  let clockRunning = true;
  let observedTotal = baseline;

  while (observedTotal - baseline < desiredResyncs) {
    if (Date.now() >= deadline) throw new Error(`chaos deadline expired in ${fixture.label}`);
    const state = await viewerRecoveryState(page);
    if (state.storm) throw new Error(`AUTO-PX stormed during paced chaos on ${fixture.label}`);
    if (state.total > observedTotal) {
      latestValue = await setMutationClock(gatewayUrl, tab, false);
      clockRunning = false;
      for (let value = observedTotal; value < state.total; value += 1) resyncTimes.push(Date.now());
      observedTotal = state.total;
      const converged = await waitFor(
        `${fixture.label} recovery convergence at ${latestValue}`,
        Math.min(deadline, Date.now() + CONVERGENCE_TIMEOUT_MS),
        async () => ((await viewerCounter(page)) === latestValue ? true : undefined),
      );
      assert(converged);
      const sample = await monitor(page);
      if (sample.whiteScreens !== 0) {
        throw new Error(`white screen during ${fixture.label}: ${sample.lastFailure}`);
      }
    }

    const cutoff = Date.now() - resyncWindowMs;
    while (resyncTimes.length > 0 && resyncTimes[0]! <= cutoff) resyncTimes.shift();
    if (resyncTimes.length >= 3) {
      await sleep(Math.max(1, resyncTimes[0]! + resyncWindowMs + 25 - Date.now()));
      if (!clockRunning) {
        await setMutationClock(gatewayUrl, tab, true);
        clockRunning = true;
      }
      continue;
    }
    if (!clockRunning) {
      await setMutationClock(gatewayUrl, tab, true);
      clockRunning = true;
    }
    const sample = await monitor(page);
    if (sample.whiteScreens !== 0) {
      throw new Error(`white screen during ${fixture.label}: ${sample.lastFailure}`);
    }
    await sleep(POLL_MS);
  }

  latestValue = await setMutationClock(gatewayUrl, tab, false);
  clockRunning = false;
  await waitFor(
    `${fixture.label} final convergence`,
    Math.min(deadline, Date.now() + CONVERGENCE_TIMEOUT_MS),
    async () => ((await viewerCounter(page)) === latestValue ? true : undefined),
  );
  await monitor(page, false);
  return observedTotal - baseline;
}

async function main(): Promise<void> {
  const run = options();
  const chromePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
  await access(chromePath);
  const releaseLock = await acquireHarnessLock();
  const site = await startFixtureSite();
  const [gatewayPort, viewerPort] = await Promise.all([freePort(), freePort()]);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const viewerUrl = `http://127.0.0.1:${viewerPort}`;
  const dev = startDev(chromePath, gatewayPort, viewerPort, run.resyncWindowMs);
  let viewerBrowser: Browser | undefined;
  const deadline = Date.now() + run.durationMs;

  try {
    await waitFor("gateway health", Date.now() + START_TIMEOUT_MS, async () => {
      const response = await fetch(`${gatewayUrl}/healthz`);
      return response.ok ? true : undefined;
    });
    await waitFor("Vite viewer", Date.now() + START_TIMEOUT_MS, async () => {
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
    await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: START_TIMEOUT_MS });
    await page.waitForSelector('#connection-state[data-state="open"]', {
      timeout: START_TIMEOUT_MS,
    });
    const tab = await currentTab(gatewayUrl, Date.now() + START_TIMEOUT_MS);
    const fixtures = site.fixtures;
    assert(fixtures.length > 0, "fixture list is empty");
    const quotient = Math.floor(run.targetResyncs / fixtures.length);
    const remainder = run.targetResyncs % fixtures.length;
    const resyncTimes: number[] = [];
    let recovered = 0;
    const fixtureCounts: Record<string, number> = {};

    for (let index = 0; index < fixtures.length; index += 1) {
      const fixture = fixtures[index]!;
      const target = quotient + (index < remainder ? 1 : 0);
      const fixtureUrl = fixture.url ?? `${site.url}${fixture.path}`;
      await navigateFixture(page, gatewayUrl, tab.tab, fixture, fixtureUrl, deadline);
      const count = await runFixtureChaos(
        page,
        gatewayUrl,
        tab.tab,
        fixture,
        target,
        deadline,
        run.resyncWindowMs,
        resyncTimes,
      );
      fixtureCounts[fixture.id] = count;
      recovered += count;
      console.error(`P2-RESYNC CHAOS ${fixture.label}: resyncs=${count} PASS`);
    }

    const [chaos, viewer, sampled] = await Promise.all([
      jsonRequest<ChaosStats>(gatewayUrl, "/__e2e/chaos"),
      viewerRecoveryState(page),
      monitor(page),
    ]);
    assert.equal(sampled.whiteScreens, 0, sampled.lastFailure);
    assert.equal(viewer.storm, false, "paced chaos unexpectedly entered AUTO-PX");
    assert(recovered >= run.targetResyncs, `only ${recovered} resyncs recovered`);
    assert(
      chaos.deltaMessagesDropped >= recovered,
      `gateway reports only ${chaos.deltaMessagesDropped} dropped deltas for ${recovered} resyncs`,
    );
    assert.equal(Object.keys(fixtureCounts).length, fixtures.length);
    process.stdout.write(
      `P2-RESYNC CHAOS: resyncs=${recovered} droppedDeltas=${chaos.deltaMessagesDropped} whiteScreens=0 stuckMirrors=0 fixtures=${fixtures.length}/${fixtures.length} windowMs=${run.resyncWindowMs} ${run.tenMinutes ? "10m" : "quick"} PASS\n`,
    );
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new Error(`${cause.message}\n\n--- pnpm dev tail ---\n${dev.logs()}`, { cause });
  } finally {
    await viewerBrowser?.close().catch(() => undefined);
    await stopProcessGroup(dev.child);
    await closeFixtureSite(site.server).catch(() => undefined);
    await releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

void main().catch((error: unknown) => {
  console.error("P2-RESYNC CHAOS FAIL:", error);
  process.exitCode = 1;
});
