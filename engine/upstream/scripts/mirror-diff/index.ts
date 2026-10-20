/**
 * Deterministic full-stack semantic fidelity gate.
 *
 * Starts the real gateway/browser/agent/viewer stack, serves deterministic structural fixtures,
 * samples only after network + DOM quiescence, and measures static and post-interaction fidelity.
 * Every action is sent through the trusted viewer input path.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type FrameLocator, type Page } from "playwright";
import { format as formatText } from "prettier";

import {
  QUIESCENCE_FUNCTION_SOURCE,
  SNAPSHOT_FUNCTION_SOURCE,
  type QuiescenceProbe,
} from "./browser-probes";
import {
  acquireHarnessLock,
  isTransientInfraFailure,
  stopProcessGroup,
  TRANSIENT_INFRA_EXIT_CODE,
} from "./harness";
import {
  closeFixtureSite,
  startFixtureSite,
  type FixtureDefinition,
  type FixtureSite,
} from "./fixture-server";
import { pollForStableConvergence } from "./convergence";
import { interactionStatesMatch, normalizeInnerText, scoreSnapshots } from "./score";
import { runOopifDiff } from "./oopif";
import type { DiffScore, DomSnapshot } from "./types";

const START_TIMEOUT_MS = 120_000;
const ACTION_TIMEOUT_MS = 60_000;
const QUIESCENCE_TIMEOUT_MS = 45_000;
const POLL_MS = 100;
const QUIET_FOR_MS = 700;
const NETWORK_IDLE_MS = 500;
const MAX_MUTATIONS_PER_SECOND = 2;
const INTERACTION_CONVERGENCE_TIMEOUT_MS = 4_000;
const INTERACTION_SETTLE_MS = 300;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = resolve(REPO_ROOT, "scripts/out");
const TYPE_VALUE = "mirror-diff";
const REAL_SITE_FIXTURES: FixtureDefinition[] = [
  {
    id: "live-wikipedia",
    label: "Live Wikipedia",
    path: "",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    marker: "Wikipedia",
    interactionProfile: "wikipedia",
  },
  {
    id: "live-hacker-news",
    label: "Live Hacker News",
    path: "",
    url: "https://news.ycombinator.com/",
    marker: "Hacker News",
    interactionProfile: "hacker-news",
  },
];

interface GatewayState {
  tabs: Array<{ tab: string; epoch: number; docId: number; seq: number; url: string }>;
}

interface SnapshotFrame {
  tab: string;
  epoch: number;
}

interface MediaPlaybackProbe {
  paused: boolean;
  muted: boolean;
  currentTime: number;
  duration: number;
}

interface Thresholds {
  staticScore: number;
  postInteractionScore: number;
  text: number;
  structure: number;
  interactionState: number;
}

interface PhaseResult {
  server: DomSnapshot;
  mirror: DomSnapshot;
  diff: DiffScore;
}

interface FixtureResult {
  id: string;
  label: string;
  structuralClass: string;
  static: PhaseResult;
  postInteraction: PhaseResult;
  interaction: {
    anchor: boolean;
    tabFocus: boolean;
    typedValue: string;
    selectedValue: string;
    scrollTop: number;
  };
  gate: { pass: boolean; failures: string[] };
}

interface Report {
  schemaVersion: 1;
  mode: "deterministic" | "real-sites";
  thresholds: Thresholds;
  quiescence: {
    quietForMs: number;
    networkIdleMs: number;
    maxMutationsPerSecond: number;
  };
  fixtures: FixtureResult[];
  overall: { staticScore: number; postInteractionScore: number; pass: boolean };
}

function envThreshold(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number from 0 through 1`);
  }
  return value;
}

function thresholds(): Thresholds {
  return {
    staticScore: envThreshold("P2_DIFF_STATIC_MIN", 0.97),
    postInteractionScore: envThreshold("P2_DIFF_POST_MIN", 0.95),
    text: envThreshold("P2_DIFF_TEXT_MIN", 0.95),
    structure: envThreshold("P2_DIFF_STRUCTURE_MIN", 0.95),
    interactionState: envThreshold("P2_DIFF_INTERACTION_MIN", 0.99),
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
    const value = chunk.toString();
    output = (output + value).slice(-200_000);
    if (process.env.P2_DIFF_VERBOSE === "1") process.stderr.write(value);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, logs: () => output };
}

async function stopDev(child: ChildProcess): Promise<void> {
  await stopProcessGroup(child);
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

async function currentTab(gatewayUrl: string): Promise<GatewayState["tabs"][number]> {
  return waitFor("gateway page target", START_TIMEOUT_MS, async () => {
    const state = await jsonRequest<GatewayState>(gatewayUrl, "/__e2e/state");
    return state.tabs[0];
  });
}

async function waitForInputReady(gatewayUrl: string, tab: string): Promise<void> {
  await waitFor("driver viewport acknowledgement", ACTION_TIMEOUT_MS, async () => {
    const state = await jsonRequest<{ inputReady?: unknown }>(
      gatewayUrl,
      `/__e2e/input-stats?tab=${encodeURIComponent(tab)}`,
    );
    return state.inputReady === true ? true : undefined;
  });
}

async function remoteValue<T>(gatewayUrl: string, tab: string, expression: string): Promise<T> {
  const response = await fetch(new URL("/__e2e/evaluate", gatewayUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab, expression }),
  });
  if (!response.ok) {
    throw new Error(`remote evaluate returned ${response.status}: ${await response.text()}`);
  }
  return ((await response.json()) as { value: T }).value;
}

function remoteMediaExpression(selector: string): string {
  return `(()=>{const media=document.querySelector(${JSON.stringify(selector)});return media?{paused:media.paused,muted:media.muted,currentTime:media.currentTime,duration:media.duration}:null})()`;
}

async function waitForAuthoritativeMedia(
  gatewayUrl: string,
  tab: string,
  selector: string,
): Promise<void> {
  await waitFor("authoritative muted autoplay", ACTION_TIMEOUT_MS, async () => {
    const state = await remoteValue<MediaPlaybackProbe | null>(
      gatewayUrl,
      tab,
      remoteMediaExpression(selector),
    );
    return state !== null && !state.paused && state.muted ? true : undefined;
  });
}

async function mirroredMediaProbe(
  page: Page,
  selector: string,
): Promise<MediaPlaybackProbe | null> {
  return page.evaluate((mediaSelector) => {
    const frame = document.querySelector<HTMLIFrameElement>("#mirror-host iframe");
    const media = frame?.contentDocument?.querySelector<HTMLMediaElement>(mediaSelector);
    return media
      ? {
          paused: media.paused,
          muted: media.muted,
          currentTime: media.currentTime,
          duration: media.duration,
        }
      : null;
  }, selector);
}

async function assertMirroredMediaAdvances(
  page: Page,
  selector: string,
  phase: string,
): Promise<void> {
  const first = await waitFor(`${phase} mirrored media playback`, ACTION_TIMEOUT_MS, async () => {
    const state = await mirroredMediaProbe(page, selector);
    return state !== null && !state.paused && state.muted && Number.isFinite(state.duration)
      ? state
      : undefined;
  });
  await waitFor(`${phase} mirrored media currentTime advancement`, ACTION_TIMEOUT_MS, async () => {
    const state = await mirroredMediaProbe(page, selector);
    if (state === null || state.paused || !state.muted) return undefined;
    const elapsed =
      state.currentTime >= first.currentTime
        ? state.currentTime - first.currentTime
        : state.currentTime + state.duration - first.currentTime;
    return elapsed >= 0.15 ? true : undefined;
  });
}

function trackSnapshots(page: Page): SnapshotFrame[] {
  const snapshots: SnapshotFrame[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as {
          t?: unknown;
          tab?: unknown;
          epoch?: unknown;
        };
        if (
          message.t === "snapshot" &&
          typeof message.tab === "string" &&
          typeof message.epoch === "number"
        ) {
          snapshots.push({ tab: message.tab, epoch: message.epoch });
        }
      } catch {
        // Binary frames and unrelated websocket traffic are outside this readiness probe.
      }
    });
  });
  return snapshots;
}

async function waitForFreshMirrorSnapshot(
  page: Page,
  gatewayUrl: string,
  tab: string,
  marker: string,
  snapshots: readonly SnapshotFrame[],
): Promise<void> {
  const beforeEpoch = (await currentTab(gatewayUrl)).epoch;
  await waitFor("agent recorder to accept an initial snapshot", START_TIMEOUT_MS, async () => {
    const response = await postJson<{ result: { ok?: boolean; err?: string } }>(
      gatewayUrl,
      "/__e2e/snapshot",
      { tab },
    );
    if (response.result.ok) return true;
    throw new Error(response.result.err ?? "snapshot command failed");
  });
  await waitFor("fresh snapshot delivery to the viewer", START_TIMEOUT_MS, async () => {
    const state = await currentTab(gatewayUrl);
    const delivered = snapshots.some(
      (snapshot) => snapshot.tab === tab && snapshot.epoch > beforeEpoch,
    );
    return state.epoch > beforeEpoch && delivered ? true : undefined;
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
    { timeout: START_TIMEOUT_MS },
  );
}

function mirrorExpression(functionSource: string): string {
  return `(()=>{const __name=(value)=>value;const frame=document.querySelector("#mirror-host iframe");const doc=frame?.contentDocument;return doc?(${functionSource})(doc):null})()`;
}

function remoteExpression(functionSource: string): string {
  return `(()=>{const __name=(value)=>value;return (${functionSource})(document)})()`;
}

async function waitForQuiescence(
  label: string,
  page: Page,
  gatewayUrl: string,
  tab: string,
  site: FixtureSite,
): Promise<void> {
  let stableSince: number | undefined;
  let previousServer: QuiescenceProbe | undefined;
  let previousMirror: QuiescenceProbe | undefined;
  let lastState = "no probe sample";
  try {
    await waitFor(`${label} quiescence`, QUIESCENCE_TIMEOUT_MS, async () => {
      const [server, mirror] = await Promise.all([
        remoteValue<QuiescenceProbe>(gatewayUrl, tab, remoteExpression(QUIESCENCE_FUNCTION_SOURCE)),
        page.evaluate<QuiescenceProbe | null>(mirrorExpression(QUIESCENCE_FUNCTION_SOURCE)),
      ]);
      if (!mirror) return undefined;
      const serverRate = mutationRate(previousServer, server);
      const mirrorRate = mutationRate(previousMirror, mirror);
      previousServer = server;
      previousMirror = mirror;
      const now = Date.now();
      const fixtureNetworkIdle =
        site.network.activeRequests === 0 && now - site.network.lastActivityAt >= NETWORK_IDLE_MS;
      const serverResourceAge = server.now - server.lastResourceAt;
      const mirrorResourceAge = mirror.now - mirror.lastResourceAt;
      const serverMutationAge = server.now - server.lastMutationAt;
      const mirrorMutationAge = mirror.now - mirror.lastMutationAt;
      const quiet =
        server.ready &&
        mirror.ready &&
        fixtureNetworkIdle &&
        serverResourceAge >= NETWORK_IDLE_MS &&
        mirrorResourceAge >= NETWORK_IDLE_MS &&
        serverMutationAge >= QUIET_FOR_MS &&
        mirrorMutationAge >= QUIET_FOR_MS &&
        serverRate <= MAX_MUTATIONS_PER_SECOND &&
        mirrorRate <= MAX_MUTATIONS_PER_SECOND;
      lastState = JSON.stringify({
        serverReady: server.ready,
        mirrorReady: mirror.ready,
        fixtureNetworkIdle,
        serverResourceAge,
        mirrorResourceAge,
        serverMutationAge,
        mirrorMutationAge,
        serverRate,
        mirrorRate,
      });
      if (!quiet) {
        stableSince = undefined;
        return undefined;
      }
      stableSince ??= now;
      return now - stableSince >= QUIET_FOR_MS ? true : undefined;
    });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; last=${lastState}`,
      {
        cause: error,
      },
    );
  }
}

function mutationRate(previous: QuiescenceProbe | undefined, current: QuiescenceProbe): number {
  if (!previous) return Number.POSITIVE_INFINITY;
  const elapsedSeconds = (current.now - previous.now) / 1_000;
  return elapsedSeconds <= 0
    ? Number.POSITIVE_INFINITY
    : (current.mutations - previous.mutations) / elapsedSeconds;
}

async function navigateFixture(
  page: Page,
  gatewayUrl: string,
  fixture: FixtureDefinition,
  fixtureUrl: string,
  snapshots: readonly SnapshotFrame[],
): Promise<GatewayState["tabs"][number]> {
  const urlbar = page.locator('#urlbar input[aria-label="Address"]');
  await urlbar.fill(fixtureUrl);
  await urlbar.press("Enter");
  const tab = await waitFor(
    `${fixture.label} authoritative navigation`,
    ACTION_TIMEOUT_MS,
    async () => {
      const candidate = await currentTab(gatewayUrl);
      return candidate.url === fixtureUrl ||
        (fixture.url !== undefined && candidate.url.startsWith(fixtureUrl))
        ? candidate
        : undefined;
    },
  );
  if (fixture.mediaSelector !== undefined) {
    await waitForAuthoritativeMedia(gatewayUrl, tab.tab, fixture.mediaSelector);
  }
  // Health/open only prove transport readiness. This request is retried until the injected agent's
  // rrweb recorder accepts it, and the harness then observes that exact fresh epoch in the viewer
  // plus materialized mirror content before any sample or interaction begins.
  await waitForFreshMirrorSnapshot(page, gatewayUrl, tab.tab, fixture.marker, snapshots);
  // A fresh navigation snapshot can arrive before the debounced device-metrics snapshot. Wait for
  // the viewer to apply and acknowledge that exact viewport epoch so the real geometry gate—not a
  // test-only bypass—has opened before the first trusted input.
  await waitForInputReady(gatewayUrl, tab.tab);
  return tab;
}

async function sample(
  page: Page,
  gatewayUrl: string,
  tab: string,
  phase: "static" | "post-interaction",
): Promise<PhaseResult> {
  const snapshots = await readSnapshots(page, gatewayUrl, tab);
  return scoreSample(snapshots, phase);
}

async function readSnapshots(
  page: Page,
  gatewayUrl: string,
  tab: string,
): Promise<{ server: DomSnapshot; mirror: DomSnapshot }> {
  const [server, mirror] = await Promise.all([
    remoteValue<DomSnapshot>(gatewayUrl, tab, remoteExpression(SNAPSHOT_FUNCTION_SOURCE)),
    page.evaluate<DomSnapshot | null>(mirrorExpression(SNAPSHOT_FUNCTION_SOURCE)),
  ]);
  assert(mirror, "mirror document disappeared while sampling");
  return { server, mirror };
}

function scoreSample(
  snapshots: { server: DomSnapshot; mirror: DomSnapshot },
  phase: "static" | "post-interaction",
): PhaseResult {
  const server = snapshots.server;
  const mirror = applyFault(snapshots.mirror);
  return { server, mirror, diff: scoreSnapshots(server, mirror, phase) };
}

async function samplePostInteractionWhenConverged(
  page: Page,
  gatewayUrl: string,
  tab: string,
  fixtureLabel: string,
): Promise<PhaseResult> {
  const result = await pollForStableConvergence({
    read: () => readSnapshots(page, gatewayUrl, tab),
    matches: ({ server, mirror }) => interactionStatesMatch(server, mirror),
    sameState: interactionStatesMatch,
    timeoutMs: INTERACTION_CONVERGENCE_TIMEOUT_MS,
    settleMs: INTERACTION_SETTLE_MS,
    pollMs: POLL_MS,
  });
  if (!result.converged) {
    // Preserve the final mismatched pair: scoring below must expose the divergence normally.
    console.error(
      `P2-DIFF ${fixtureLabel}: interaction state did not converge within ${INTERACTION_CONVERGENCE_TIMEOUT_MS}ms; sampling final state`,
    );
  }
  return scoreSample(result.sample, "post-interaction");
}

function applyFault(snapshot: DomSnapshot): DomSnapshot {
  const fault = process.env.P2_DIFF_FAULT;
  if (fault === undefined || fault === "") return snapshot;
  const broken = structuredClone(snapshot);
  if (fault === "drop-text") broken.text = "";
  else if (fault === "drop-controls") broken.controls = {};
  else if (fault === "drop-images") broken.imageCount = 0;
  else throw new Error(`unknown P2_DIFF_FAULT ${JSON.stringify(fault)}`);
  return broken;
}

function interactionFrame(page: Page, fixture: FixtureDefinition): FrameLocator {
  let frame = page.frameLocator("#mirror-host iframe");
  if (fixture.interactionFrame) frame = frame.frameLocator(fixture.interactionFrame);
  return frame;
}

function authoritativeInteractionDocument(fixture: FixtureDefinition): string {
  return fixture.interactionFrame
    ? `document.querySelector(${JSON.stringify(fixture.interactionFrame)})?.contentDocument`
    : "document";
}

async function driveInteractions(
  page: Page,
  gatewayUrl: string,
  tab: string,
  fixture: FixtureDefinition,
): Promise<FixtureResult["interaction"]> {
  if (fixture.interactionProfile !== undefined) {
    return driveRealSiteInteractions(page, gatewayUrl, tab, fixture);
  }
  const frame = interactionFrame(page, fixture);
  const remoteDocument = authoritativeInteractionDocument(fixture);
  await waitFor(`${fixture.label} mirror input attachment`, ACTION_TIMEOUT_MS, async () => {
    const attached = await frame.locator("body").evaluate((body) => {
      // The containment listener is one of all six document-set units. A harmless javascript:
      // anchor distinguishes "final rrweb document is attached" without navigating the mirror;
      // pointer capture ignores this untrusted diagnostic event.
      const probe = body.ownerDocument.createElement("a");
      probe.href = "javascript:void 0";
      body.append(probe);
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      probe.dispatchEvent(event);
      probe.remove();
      return event.defaultPrevented;
    });
    return attached ? true : undefined;
  });
  await frame.locator("#action-link").click();
  await waitFor(`${fixture.label} authoritative anchor click`, ACTION_TIMEOUT_MS, async () =>
    (await remoteValue<boolean>(
      gatewayUrl,
      tab,
      `(${remoteDocument}?.defaultView?.location.hash === "#interaction-target") || (${remoteDocument}?.querySelector("#action-output")?.textContent === "Anchor activated on server")`,
    ))
      ? true
      : undefined,
  );

  await frame.locator("#field-a").click();
  await page.keyboard.press("Tab");
  await waitFor(`${fixture.label} Tab focus`, ACTION_TIMEOUT_MS, async () =>
    (await remoteValue<string>(gatewayUrl, tab, `${remoteDocument}?.activeElement?.id ?? ""`)) ===
    "field-b"
      ? true
      : undefined,
  );
  await page.keyboard.type(TYPE_VALUE);
  await waitFor(`${fixture.label} authoritative typed value`, ACTION_TIMEOUT_MS, async () =>
    (await remoteValue<string>(
      gatewayUrl,
      tab,
      `${remoteDocument}?.querySelector("#field-b")?.value ?? ""`,
    )) === TYPE_VALUE
      ? true
      : undefined,
  );

  await page.keyboard.press("Tab");
  await waitFor(`${fixture.label} select focus`, ACTION_TIMEOUT_MS, async () =>
    (await remoteValue<string>(gatewayUrl, tab, `${remoteDocument}?.activeElement?.id ?? ""`)) ===
    "choice"
      ? true
      : undefined,
  );
  await page.keyboard.press("ArrowDown");
  await waitFor(`${fixture.label} select value`, ACTION_TIMEOUT_MS, async () => {
    const [serverValue, mirrorValue] = await Promise.all([
      remoteValue<string>(
        gatewayUrl,
        tab,
        `${remoteDocument}?.querySelector("#choice")?.value ?? ""`,
      ),
      frame.locator("#choice").inputValue(),
    ]);
    return serverValue === "beta" && mirrorValue === "beta" ? true : undefined;
  });

  const scroller = frame.locator("#scroll-surface");
  await scroller.hover();
  await page.mouse.wheel(0, 260);
  const scrollTop = await waitFor(`${fixture.label} scroll relay`, ACTION_TIMEOUT_MS, async () => {
    const [serverValue, mirrorValue] = await Promise.all([
      remoteValue<number>(
        gatewayUrl,
        tab,
        `${remoteDocument}?.querySelector("#scroll-surface")?.scrollTop ?? 0`,
      ),
      scroller.evaluate((element) => element.scrollTop),
    ]);
    return serverValue > 0 && mirrorValue > 0 ? serverValue : undefined;
  });

  return {
    anchor: true,
    tabFocus: true,
    typedValue: TYPE_VALUE,
    selectedValue: "beta",
    scrollTop,
  };
}

async function driveRealSiteInteractions(
  page: Page,
  gatewayUrl: string,
  tab: string,
  fixture: FixtureDefinition,
): Promise<FixtureResult["interaction"]> {
  const frame = page.frameLocator("#mirror-host iframe");
  const linkSelector =
    fixture.interactionProfile === "wikipedia"
      ? "#bodyContent a[href]:visible"
      : "a[href$='/newest']:visible";
  const beforeUrl = await remoteValue<string>(gatewayUrl, tab, "location.href");
  await frame.locator(linkSelector).first().click();
  await waitFor(`${fixture.label} authoritative link`, ACTION_TIMEOUT_MS, async () => {
    const currentUrl = await remoteValue<string>(gatewayUrl, tab, "location.href");
    return currentUrl !== beforeUrl ? true : undefined;
  });
  if (fixture.interactionProfile === "hacker-news") {
    await page.waitForFunction(
      () =>
        (
          document.querySelector<HTMLIFrameElement>("#mirror-host iframe")?.contentDocument?.body
            ?.innerText ?? ""
        ).includes("Hacker News"),
      undefined,
      { timeout: ACTION_TIMEOUT_MS },
    );
  }

  await frame.locator("body").hover();
  await page.mouse.wheel(0, 480);
  const scrollTop = await waitFor(`${fixture.label} live scroll`, ACTION_TIMEOUT_MS, async () => {
    const value = await remoteValue<number>(gatewayUrl, tab, "window.scrollY");
    return value > 0 ? value : undefined;
  });

  const input = frame
    .locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')
    .first();
  let tabFocus = false;
  if ((await input.count()) > 0) {
    await input.click();
    await page.keyboard.press("Tab");
    tabFocus = true;
  }

  const select = frame.locator("select:not([multiple])").first();
  let selectedValue = "<not-present>";
  if ((await select.count()) > 0) {
    await select.click();
    await page.keyboard.press("ArrowDown");
    selectedValue = await select.inputValue();
  }

  return {
    anchor: true,
    tabFocus,
    typedValue: "<not-mutated-live-site>",
    selectedValue,
    scrollTop,
  };
}

function gateFixture(result: Omit<FixtureResult, "gate">, limits: Thresholds): FixtureResult {
  const failures: string[] = [];
  const staticComponents = result.static.diff.components;
  const postComponents = result.postInteraction.diff.components;
  if (result.static.diff.score < limits.staticScore) {
    failures.push(
      `static score ${percent(result.static.diff.score)} < ${percent(limits.staticScore)}`,
    );
  }
  if (result.postInteraction.diff.score < limits.postInteractionScore) {
    failures.push(
      `post-interaction score ${percent(result.postInteraction.diff.score)} < ${percent(limits.postInteractionScore)}`,
    );
  }
  if (staticComponents.text < limits.text || postComponents.text < limits.text) {
    failures.push(`innerText similarity below ${percent(limits.text)}`);
  }
  for (const name of ["elements", "tags", "images"] as const) {
    if (staticComponents[name] < limits.structure || postComponents[name] < limits.structure) {
      failures.push(`${name} similarity below ${percent(limits.structure)}`);
    }
  }
  for (const name of ["controls", "activeElement", "scroll"] as const) {
    if (postComponents[name] < limits.interactionState) {
      failures.push(`${name} divergence (${percent(postComponents[name])})`);
    }
  }
  return { ...result, gate: { pass: failures.length === 0, failures } };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function markdown(report: Report): string {
  const lane =
    report.mode === "deterministic"
      ? "deterministic fidelity baseline"
      : "opt-in real-site fidelity report";
  const lines = [
    `# P2-DIFF ${lane}`,
    "",
    "Full-stack D12 score table after network/mutation quiescence. Every fixture runs the required trusted viewer-path anchor, Tab/form, select, and scroll interaction script before the second sample.",
    "",
    `Thresholds: static ≥ ${percent(report.thresholds.staticScore)}, post-interaction ≥ ${percent(report.thresholds.postInteractionScore)}, text ≥ ${percent(report.thresholds.text)}, structure ≥ ${percent(report.thresholds.structure)}, interaction state ≥ ${percent(report.thresholds.interactionState)}.`,
    "",
    "| Fixture | Static text | Static elems | Static tags | Static imgs | Static values | Static score | Post text | Post values | Active | Scroll | Post score | Gate |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|",
  ];
  for (const fixture of report.fixtures) {
    const before = fixture.static.diff;
    const after = fixture.postInteraction.diff;
    lines.push(
      `| ${fixture.label} | ${percent(before.components.text)} | ${percent(before.components.elements)} | ${percent(before.components.tags)} | ${percent(before.components.images)} | ${percent(before.components.controls)} | ${percent(before.score)} | ${percent(after.components.text)} | ${percent(after.components.controls)} | ${percent(after.components.activeElement)} | ${percent(after.components.scroll)} | ${percent(after.score)} | ${fixture.gate.pass ? "PASS" : "FAIL"} |`,
    );
  }
  lines.push(
    `| **Overall** |  |  |  |  |  | **${percent(report.overall.staticScore)}** |  |  |  |  | **${percent(report.overall.postInteractionScore)}** | **${report.overall.pass ? "PASS" : "FAIL"}** |`,
    "",
    "## Gate findings",
    "",
  );
  const failures = report.fixtures.flatMap((fixture) =>
    fixture.gate.failures.map((failure) => `- ${fixture.label}: ${failure}`),
  );
  lines.push(
    ...(failures.length === 0
      ? ["No threshold or interaction-state divergence detected."]
      : failures),
  );
  lines.push(
    "",
    `The machine-readable companion is \`scripts/out/${report.mode === "real-sites" ? "p2-diff-real" : "p2-diff"}.json\`. Scores compare explicit stable regions and recurse through same-origin frames and open shadow roots; dynamic/animated regions must opt out with \`data-diff-ignore\`.`,
    "",
  );
  return lines.join("\n");
}

/**
 * Absolute window scroll offsets can vary when Playwright scrolls a control into view, even when
 * server and mirror match exactly. Persist stable measurements and divergence keys, not incidental
 * matched coordinates, so the committed JSON is a reproducible baseline.
 */
function machineReport(report: Report): unknown {
  const summarizeSnapshot = (snapshot: DomSnapshot) => {
    const normalizedText = normalizeInnerText(snapshot.text);
    return {
      textLength: normalizedText.length,
      textSha256: createHash("sha256").update(normalizedText).digest("hex"),
      elementCount: snapshot.elementCount,
      tagCounts: snapshot.tagCounts,
      imageCount: snapshot.imageCount,
      controls: snapshot.controls,
      activeElement: snapshot.activeElement,
      scrollKeys: Object.keys(snapshot.scroll).sort(),
    };
  };
  const summarizePhase = (phase: PhaseResult) => ({
    score: phase.diff.score,
    components: phase.diff.components,
    differences: phase.diff.differences,
    measurements: {
      server: summarizeSnapshot(phase.server),
      mirror: summarizeSnapshot(phase.mirror),
    },
  });
  return {
    ...report,
    fixtures: report.fixtures.map((fixture) => ({
      ...fixture,
      static: summarizePhase(fixture.static),
      postInteraction: summarizePhase(fixture.postInteraction),
    })),
  };
}

async function main(): Promise<void> {
  const chromePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
  await access(chromePath);
  const releaseHarnessLock = await acquireHarnessLock();
  try {
    if (process.env.P2_DIFF_OOPIF === "1") {
      if (process.env.P2_DIFF_REAL_SITES === "1") {
        throw new Error("P2_DIFF_OOPIF and P2_DIFF_REAL_SITES are separate opt-in lanes");
      }
      const result = await runOopifDiff(chromePath);
      if (result !== "pass") {
        process.exitCode = result === "transient-infra" ? TRANSIENT_INFRA_EXIT_CODE : 1;
      }
      return;
    }
    await runSnapshotDiff(chromePath);
  } finally {
    await releaseHarnessLock();
  }
}

async function runSnapshotDiff(chromePath: string): Promise<void> {
  const limits = thresholds();
  const realSiteMode = process.env.P2_DIFF_REAL_SITES === "1";
  const [gatewayPort, viewerPort] = await Promise.all([freePort(), freePort()]);
  assert.notEqual(gatewayPort, viewerPort);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const viewerUrl = `http://127.0.0.1:${viewerPort}`;
  const site = await startFixtureSite();
  const dev = startDev(chromePath, gatewayPort, viewerPort);
  let viewerBrowser: Browser | undefined;
  const viewerLogs: string[] = [];
  let finalMarkdown: string | undefined;
  let report: Report | undefined;

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
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.on("console", (message) =>
      viewerLogs.push(`console.${message.type()}: ${message.text()}`),
    );
    page.on("pageerror", (error) => viewerLogs.push(`pageerror: ${error.message}`));
    const snapshots = trackSnapshots(page);
    await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: START_TIMEOUT_MS });
    await page.waitForSelector('#connection-state[data-state="open"]', {
      timeout: START_TIMEOUT_MS,
    });
    await currentTab(gatewayUrl);

    const fixtureFilter = process.env.P2_DIFF_FIXTURE;
    const availableFixtures = realSiteMode ? REAL_SITE_FIXTURES : site.fixtures;
    const fixtures = fixtureFilter
      ? availableFixtures.filter((fixture) => fixture.id === fixtureFilter)
      : availableFixtures;
    if (fixtures.length === 0) {
      throw new Error(`P2_DIFF_FIXTURE did not match a deterministic fixture: ${fixtureFilter}`);
    }
    const fixtureResults: FixtureResult[] = [];
    for (const fixture of fixtures) {
      const fixtureUrl = fixture.url ?? `${site.url}${fixture.path}`;
      const tab = await navigateFixture(page, gatewayUrl, fixture, fixtureUrl, snapshots);
      if (fixture.mediaSelector !== undefined) {
        await assertMirroredMediaAdvances(
          page,
          fixture.mediaSelector,
          `${fixture.label} initial connect`,
        );
        await waitForFreshMirrorSnapshot(page, gatewayUrl, tab.tab, fixture.marker, snapshots);
        await assertMirroredMediaAdvances(
          page,
          fixture.mediaSelector,
          `${fixture.label} mid-session resync`,
        );
      }
      await waitForQuiescence(`${fixture.label} static`, page, gatewayUrl, tab.tab, site);
      const staticResult = await sample(page, gatewayUrl, tab.tab, "static");
      const interaction = await driveInteractions(page, gatewayUrl, tab.tab, fixture);
      await waitForQuiescence(`${fixture.label} post-interaction`, page, gatewayUrl, tab.tab, site);
      const postInteraction = await samplePostInteractionWhenConverged(
        page,
        gatewayUrl,
        tab.tab,
        fixture.label,
      );
      const result = gateFixture(
        {
          id: fixture.id,
          label: fixture.label,
          structuralClass: fixture.label,
          static: staticResult,
          postInteraction,
          interaction,
        },
        limits,
      );
      fixtureResults.push(result);
      console.error(
        `P2-DIFF ${fixture.label}: static=${percent(staticResult.diff.score)} post=${percent(postInteraction.diff.score)} ${result.gate.pass ? "PASS" : "FAIL"}`,
      );
    }

    report = {
      schemaVersion: 1,
      mode: realSiteMode ? "real-sites" : "deterministic",
      thresholds: limits,
      quiescence: {
        quietForMs: QUIET_FOR_MS,
        networkIdleMs: NETWORK_IDLE_MS,
        maxMutationsPerSecond: MAX_MUTATIONS_PER_SECOND,
      },
      fixtures: fixtureResults,
      overall: {
        staticScore: average(fixtureResults.map((result) => result.static.diff.score)),
        postInteractionScore: average(
          fixtureResults.map((result) => result.postInteraction.diff.score),
        ),
        pass: fixtureResults.every((result) => result.gate.pass),
      },
    };
    const [formattedMarkdown, formattedJson] = await Promise.all([
      formatText(markdown(report), { parser: "markdown" }),
      formatText(JSON.stringify(machineReport(report)), { parser: "json" }),
    ]);
    finalMarkdown = formattedMarkdown;
    await mkdir(OUT_DIR, { recursive: true });
    const reportStem = realSiteMode ? "p2-diff-real" : "p2-diff";
    await Promise.all([
      writeFile(resolve(OUT_DIR, `${reportStem}.json`), formattedJson),
      writeFile(resolve(OUT_DIR, `${reportStem}.md`), finalMarkdown),
    ]);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `${cause.message}\n\n--- viewer log ---\n${viewerLogs.join("\n")}\n\n--- pnpm dev tail ---\n${dev.logs()}`,
      { cause },
    );
  } finally {
    await viewerBrowser?.close().catch(() => undefined);
    await stopDev(dev.child);
    await closeFixtureSite(site.server).catch(() => undefined);
  }

  assert(report && finalMarkdown);
  // Keep the table at the end of stdout so CI log collectors always capture the instrument.
  process.stdout.write(
    `${finalMarkdown}\nP2-DIFF GATE: ${report.overall.pass ? "PASS" : "FAIL"}\n`,
  );
  if (!report.overall.pass) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const transient = isTransientInfraFailure(error);
  console.error(`${transient ? "P2-DIFF TRANSIENT INFRA" : "P2-DIFF NON-RETRYABLE"}:`, error);
  process.exitCode = transient ? TRANSIENT_INFRA_EXIT_CODE : 1;
});
