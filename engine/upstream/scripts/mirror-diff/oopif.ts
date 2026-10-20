/** Default-CI P2-OOPIF fidelity lane; also runnable alone through P2_DIFF_OOPIF=1. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type FrameLocator,
  type Page,
} from "playwright";
import { format as formatText } from "prettier";

import { pollForStableConvergence } from "./convergence";
import { closeFixtureSite, startFixtureSite } from "./fixture-server";
import { isTransientInfraFailure, stopProcessGroup } from "./harness";

const START_TIMEOUT_MS = 120_000;
const ACTION_TIMEOUT_MS = 60_000;
const POLL_MS = 50;
const INTERACTION_CONVERGENCE_TIMEOUT_MS = 4_000;
const INTERACTION_SETTLE_MS = 300;
const RESOLVE_READINESS_TIMEOUT_MS = 5_000;
const RESOLVE_READINESS_SETTLE_MS = 300;
const RESOLVE_PROBE_ACK_TIMEOUT_MS = 750;
const TYPE_ATTEMPTS = 10;
const RTT_MS = 150;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = resolve(REPO_ROOT, "scripts/out");
const CHROME_WRAPPER = resolve(REPO_ROOT, "scripts/mirror-diff/chrome-oopif.sh");

interface GatewayState {
  tabs: Array<{ tab: string; epoch: number; docId: number; seq: number; url: string }>;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  attached: boolean;
}

interface AssertionResult {
  id: string;
  label: string;
  buildStep: string;
  status: "PASS" | "FAIL";
  failureKind?: "transient-infra" | "fidelity";
  detail: string;
  durationMs: number;
}

interface SnapshotFrame {
  tab: string;
  epoch: number;
}

export type OopifRunResult = "pass" | "transient-infra" | "fidelity";

interface OopifReport {
  schemaVersion: 1;
  mode: "oopif-opt-in";
  envGate: "P2_DIFF_OOPIF=1";
  simulatedRttMs: number;
  fault: string | null;
  assertions: AssertionResult[];
  pass: boolean;
}

interface OopifIdentity {
  frame: Frame;
  targetId: string;
  frameId: string;
  isolateId: string;
  url: string;
}

function normalizedUrl(url: string): string {
  return new URL(url).href;
}

function freePort(): Promise<number> {
  const server = createNetServer();
  return new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      server.close((error) => (error === undefined ? resolvePort(address.port) : reject(error)));
    });
  });
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
  realChromePath: string,
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
      MIRROR_E2E_WS_RTT_MS: String(RTT_MS),
      P2_DIFF_CHROME_PATH: realChromePath,
      P2_DIFF_CDP_PORT: String(cdpPort),
      VIEWER_PORT: String(viewerPort),
      VITE_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk: Buffer): void => {
    const text = chunk.toString();
    output = (output + text).slice(-200_000);
    if (process.env.P2_DIFF_VERBOSE === "1") process.stderr.write(text);
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

async function remoteValue<T>(gatewayUrl: string, tab: string, expression: string): Promise<T> {
  return (await postJson<{ value: T }>(gatewayUrl, "/__e2e/evaluate", { tab, expression })).value;
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

async function requestFreshSnapshot(
  gatewayUrl: string,
  tab: string,
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
}

async function waitForInitialOopifMirror(
  page: Page,
  gatewayUrl: string,
  tab: string,
  snapshots: readonly SnapshotFrame[],
): Promise<void> {
  await requestFreshSnapshot(gatewayUrl, tab, snapshots);
  await mirrorTop(page).locator("#oopif-parent-marker").waitFor({
    state: "visible",
    timeout: START_TIMEOUT_MS,
  });

  // A cross-origin child recorder can finish just after the top snapshot. Poll the actual stitched
  // mirror and periodically request another known-fresh epoch until both documents materialize.
  let lastSnapshotAt = Date.now();
  await waitFor("initial b.test child materialized in the mirror", START_TIMEOUT_MS, async () => {
    const childVisible = await mirrorTop(page)
      .frameLocator("#oopif-frame")
      .locator("#oopif-child-marker[data-site='b.test']")
      .isVisible()
      .catch(() => false);
    if (childVisible) {
      return true;
    }
    if (Date.now() - lastSnapshotAt >= 10_000) {
      await requestFreshSnapshot(gatewayUrl, tab, snapshots);
      lastSnapshotAt = Date.now();
    }
    return undefined;
  });
}

function mirrorTop(page: Page): FrameLocator {
  return page.frameLocator("#mirror-host iframe");
}

function mirrorChild(page: Page): FrameLocator {
  const selector =
    process.env.P2_DIFF_FAULT === "drop-child-frame"
      ? "#__p2_diff_fault_dropped_child__"
      : "#oopif-frame";
  return mirrorTop(page).frameLocator(selector);
}

function childMaterializationTimeout(): number {
  // The synthetic drop-child-frame probe is guaranteed to address a nonexistent selector. Fail it
  // promptly; the real lane always receives the full generous action budget.
  return process.env.P2_DIFF_FAULT === "drop-child-frame" ? 1_000 : ACTION_TIMEOUT_MS;
}

async function sourceFrame(page: Page, hostname: "a.test" | "b.test" | "c.test"): Promise<Frame> {
  return waitFor(`${hostname} authoritative child frame`, ACTION_TIMEOUT_MS, () =>
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

async function targetInfos(root: CDPSession): Promise<TargetInfo[]> {
  return (
    (await root.send("Target.getTargets", {
      filter: [{ type: "page" }, { type: "iframe" }],
    })) as { targetInfos: TargetInfo[] }
  ).targetInfos;
}

async function describeIframeFrameId(context: BrowserContext, page: Page): Promise<string> {
  const session = await context.newCDPSession(page);
  try {
    const evaluated = (await session.send("Runtime.evaluate", {
      expression: 'document.querySelector("#oopif-frame")',
      returnByValue: false,
    })) as { result?: { objectId?: string; description?: string }; exceptionDetails?: unknown };
    const objectId = evaluated.result?.objectId;
    assert(
      evaluated.exceptionDetails === undefined && objectId !== undefined,
      `could not resolve source iframe: ${evaluated.result?.description ?? "no object"}`,
    );
    try {
      const described = (await session.send("DOM.describeNode", { objectId, depth: 0 })) as {
        node?: { frameId?: string };
      };
      assert(described.node?.frameId, "DOM.describeNode returned no iframe frameId");
      return described.node.frameId;
    } finally {
      await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function oopifIdentity(
  context: BrowserContext,
  page: Page,
  root: CDPSession,
  hostname: "b.test" | "c.test",
): Promise<OopifIdentity> {
  const frame = await sourceFrame(page, hostname);
  const target = await waitFor(`${hostname} iframe-type target`, ACTION_TIMEOUT_MS, async () =>
    (await targetInfos(root)).find((info) => {
      if (info.type !== "iframe") return false;
      try {
        return new URL(info.url).hostname === hostname;
      } catch {
        return false;
      }
    }),
  );
  assert.equal(target.type, "iframe", `${hostname} did not attach as an iframe target`);
  const frameId = await describeIframeFrameId(context, page);
  assert.equal(target.targetId, frameId, `${hostname} targetId did not equal its frameId`);
  const frameSession = await context.newCDPSession(frame);
  try {
    const isolate = (await frameSession.send("Runtime.getIsolateId")) as { id?: string };
    assert(isolate.id, `${hostname} Runtime.getIsolateId returned no id`);
    return { frame, targetId: target.targetId, frameId, isolateId: isolate.id, url: frame.url() };
  } finally {
    await frameSession.detach().catch(() => undefined);
  }
}

async function runAssertion(
  results: AssertionResult[],
  id: string,
  label: string,
  buildStep: string,
  assertion: () => void | string | Promise<void | string>,
): Promise<boolean> {
  const started = performance.now();
  try {
    const detail = (await assertion()) ?? "assertion satisfied";
    results.push({
      id,
      label,
      buildStep,
      status: "PASS",
      detail,
      durationMs: performance.now() - started,
    });
    console.error(`P2-DIFF OOPIF ${id}: PASS — ${detail}`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failureKind = isTransientInfraFailure(error) ? "transient-infra" : "fidelity";
    results.push({
      id,
      label,
      buildStep,
      status: "FAIL",
      failureKind,
      detail,
      durationMs: performance.now() - started,
    });
    console.error(`P2-DIFF OOPIF ${id}: FAIL — ${detail}`);
    return false;
  }
}

function requireReady(ready: boolean, dependency: string): void {
  assert(ready, `${dependency} prerequisite failed`);
}

async function waitExactValues(
  frame: Frame,
  mirror: FrameLocator,
  expected: string,
): Promise<void> {
  const result = await pollForStableConvergence({
    read: async () => {
      const [server, mirrorValue] = await Promise.all([
        frame.locator("#field-b").inputValue(),
        mirror.locator("#field-b").inputValue(),
      ]);
      return { server, mirror: mirrorValue };
    },
    matches: ({ server, mirror: mirrorValue }) => server === expected && mirrorValue === expected,
    sameState: (left, right) => left === right,
    timeoutMs: INTERACTION_CONVERGENCE_TIMEOUT_MS,
    settleMs: INTERACTION_SETTLE_MS,
    pollMs: POLL_MS,
  });
  assert.equal(result.sample.server, expected, "authoritative typed value did not converge");
  assert.equal(result.sample.mirror, expected, "mirror typed value did not converge");
}

async function rectFallbackCount(gatewayUrl: string, tab: string): Promise<number> {
  const response = await fetch(
    new URL(`/__e2e/input-stats?tab=${encodeURIComponent(tab)}`, gatewayUrl),
    { cache: "no-store" },
  );
  if (response.status === 404) {
    throw new Error(
      "gateway test-mode rect-fallback counter hook is missing (expected /__e2e/input-stats)",
    );
  }
  if (!response.ok) {
    throw new Error(`rect-fallback counter returned ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { rectFallbacks?: unknown };
  assert(
    typeof body.rectFallbacks === "number" && Number.isSafeInteger(body.rectFallbacks),
    "rect-fallback counter response did not contain an integer rectFallbacks",
  );
  return body.rectFallbacks;
}

interface ResolveReadiness {
  baselineFallbacks: number;
  elapsedMs: number;
  probes: number;
}

async function waitForOopifResolveReadiness(
  page: Page,
  authoritativeFrame: Frame,
  gatewayUrl: string,
  tab: string,
): Promise<ResolveReadiness> {
  const startedAt = Date.now();
  const deadline = startedAt + RESOLVE_READINESS_TIMEOUT_MS;
  let stableSince: number | undefined;
  let probes = 0;
  let lastFallbacks = await rectFallbackCount(gatewayUrl, tab);
  let lastIssue = "no acknowledged probe completed";
  const probeTimeout = (): number =>
    Math.max(1, Math.min(RESOLVE_PROBE_ACK_TIMEOUT_MS, deadline - Date.now()));

  while (Date.now() < deadline) {
    const beforeFallbacks = await rectFallbackCount(gatewayUrl, tab);
    probes += 1;
    try {
      // This pointer pair traverses the same viewer -> gateway resolveNode -> composed-rect path as
      // the fidelity interactions below. The focus transitions causally acknowledge gateway input
      // delivery, so the counter read cannot race ahead of the probe.
      await mirrorChild(page).locator("#field-a").click({ timeout: probeTimeout() });
      await waitFor("authoritative OOPIF readiness focus on field-a", probeTimeout(), async () =>
        (await authoritativeFrame.evaluate(() => document.activeElement?.id)) === "field-a"
          ? true
          : undefined,
      );
      await page.keyboard.press("Tab");
      await waitFor(
        "authoritative OOPIF readiness Tab focus on field-b",
        probeTimeout(),
        async () =>
          (await authoritativeFrame.evaluate(() => document.activeElement?.id)) === "field-b"
            ? true
            : undefined,
      );
    } catch (error) {
      stableSince = undefined;
      lastFallbacks = await rectFallbackCount(gatewayUrl, tab);
      const detail = error instanceof Error ? error.message : String(error);
      lastIssue =
        `probe ${probes} was not acknowledged (${detail}); ` +
        `counter ${beforeFallbacks} -> ${lastFallbacks}`;
      await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
      continue;
    }

    const afterFallbacks = await rectFallbackCount(gatewayUrl, tab);
    lastFallbacks = afterFallbacks;
    const sampledAt = Date.now();
    if (afterFallbacks === beforeFallbacks) {
      stableSince ??= sampledAt;
      lastIssue = `probe ${probes} resolved without fallback`;
      if (sampledAt - stableSince >= RESOLVE_READINESS_SETTLE_MS) {
        return {
          baselineFallbacks: afterFallbacks,
          elapsedMs: sampledAt - startedAt,
          probes,
        };
      }
    } else {
      stableSince = undefined;
      lastIssue = `probe ${probes} added ${afterFallbacks - beforeFallbacks} vx/vy fallback(s)`;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
  }

  lastFallbacks = await rectFallbackCount(gatewayUrl, tab).catch(() => lastFallbacks);
  throw new Error(
    `authoritative OOPIF resolveNode/rect readiness did not stabilize within ${RESOLVE_READINESS_TIMEOUT_MS}ms ` +
      `(probes=${probes}, rectFallbacks=${lastFallbacks}, last=${lastIssue})`,
  );
}

function reportMarkdown(report: OopifReport): string {
  const lines = [
    "# P2-DIFF cross-site OOPIF fidelity fixture",
    "",
    `Default CI lane selector: \`${report.envGate}\`. Simulated viewer RTT: ${report.simulatedRttMs}ms.`,
    "",
    "| Assertion | Product build step | Result | Detail |",
    "| --- | --- | :---: | --- |",
  ];
  for (const assertion of report.assertions) {
    lines.push(
      `| ${assertion.label} | ${assertion.buildStep} | **${assertion.status}** | ${assertion.detail.replaceAll("|", "\\|")} |`,
    );
  }
  lines.push("", `P2-DIFF OOPIF GATE: **${report.pass ? "PASS" : "FAIL"}**`, "");
  return lines.join("\n");
}

export async function runOopifDiff(realChromePath: string): Promise<OopifRunResult> {
  await Promise.all([access(realChromePath), access(CHROME_WRAPPER)]);
  const [gatewayPort, viewerPort, cdpPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  assert.equal(new Set([gatewayPort, viewerPort, cdpPort]).size, 3, "test ports collided");
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const viewerUrl = `http://127.0.0.1:${viewerPort}`;
  const site = await startFixtureSite();
  const fixtureUrl = `http://a.test:${site.port}/fixtures/oopif`;
  const dev = startDev(realChromePath, gatewayPort, viewerPort, cdpPort);
  const results: AssertionResult[] = [];
  const viewerLogs: string[] = [];
  const sourceLogs: string[] = [];
  let viewerBrowser: Browser | undefined;
  let authoritativeBrowser: Browser | undefined;
  let sourcePage: Page | undefined;
  let rootSession: CDPSession | undefined;

  try {
    await Promise.all([
      waitFor("gateway health", START_TIMEOUT_MS, async () => {
        const response = await fetch(`${gatewayUrl}/healthz`);
        return response.ok ? true : undefined;
      }),
      waitFor("Vite viewer", START_TIMEOUT_MS, async () => {
        const response = await fetch(viewerUrl);
        return response.ok ? true : undefined;
      }),
      waitFor("fixture Chromium DevTools endpoint", START_TIMEOUT_MS, async () => {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        return response.ok ? true : undefined;
      }),
    ]);
    if (dev.child.exitCode !== null) throw new Error(`pnpm dev exited early\n${dev.logs()}`);

    authoritativeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const sourceContext = authoritativeBrowser.contexts()[0];
    assert(sourceContext, "fixture Chromium exposed no browser context");
    sourcePage = sourceContext.pages()[0];
    assert(sourcePage, "fixture Chromium exposed no page target");
    sourcePage.on("console", (message) =>
      sourceLogs.push(`console.${message.type()}: ${message.text()}`),
    );
    sourcePage.on("pageerror", (error) => sourceLogs.push(`pageerror: ${error.message}`));
    rootSession = await authoritativeBrowser.newBrowserCDPSession();

    viewerBrowser = await chromium.launch({
      executablePath: realChromePath,
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

    const urlbar = page.locator('#urlbar input[aria-label="Address"]');
    await urlbar.fill(fixtureUrl);
    await urlbar.press("Enter");
    const tab = await waitFor("a.test authoritative navigation", ACTION_TIMEOUT_MS, async () => {
      const candidate = await currentTab(gatewayUrl);
      return normalizedUrl(candidate.url) === normalizedUrl(fixtureUrl) ? candidate : undefined;
    });
    // Do not begin the 11 assertions at transport readiness. Prove the injected recorder accepts
    // snapshots and that both the top document and stitched OOPIF exist in a delivered mirror.
    await waitForInitialOopifMirror(page, gatewayUrl, tab.tab, snapshots);

    let before: OopifIdentity | undefined;
    const oopifAttached = await runAssertion(
      results,
      "oopif-target",
      "Real iframe-type OOPIF target",
      "step 0 / target lifecycle",
      async () => {
        before = await oopifIdentity(sourceContext, sourcePage, rootSession!, "b.test");
        return `b.test targetId==frameId ${before.targetId}`;
      },
    );

    const stitched = await runAssertion(
      results,
      "stitched-child",
      "Cross-site child stitched into mirror",
      "resolveNode + rrweb child stitching",
      async () => {
        requireReady(oopifAttached, "real OOPIF target");
        await mirrorChild(page).locator("#oopif-child-marker[data-site='b.test']").waitFor({
          state: "visible",
          timeout: childMaterializationTimeout(),
        });
        await mirrorTop(page).locator("#oopif-parent-marker").waitFor({ state: "visible" });
        return "b.test child visible and a.test parent intact";
      },
    );

    await runAssertion(
      results,
      "closed-shadow",
      "Closed shadow serialized inside OOPIF",
      "child recorder stitching",
      async () => {
        requireReady(stitched, "stitched child");
        await mirrorChild(page).getByText("Closed shadow inside OOPIF").waitFor({
          state: "visible",
          timeout: ACTION_TIMEOUT_MS,
        });
      },
    );

    let interactionFallbackBaseline: number | undefined;
    const resolveReady = await runAssertion(
      results,
      "resolve-readiness",
      "Cross-site node rect resolution is ready",
      "resolveNode + composed rect readiness",
      async () => {
        requireReady(stitched && before !== undefined, "stitched b.test child");
        const readiness = await waitForOopifResolveReadiness(
          page,
          before.frame,
          gatewayUrl,
          tab.tab,
        );
        interactionFallbackBaseline = readiness.baselineFallbacks;
        return (
          `stable for ${RESOLVE_READINESS_SETTLE_MS}ms after ${readiness.probes} probes ` +
          `(${readiness.elapsedMs}ms elapsed; readiness baseline=${readiness.baselineFallbacks})`
        );
      },
    );

    const anchor = await runAssertion(
      results,
      "anchor-containment",
      "Anchor reaches server without local mirror navigation",
      "F1 containment + composed rect",
      async () => {
        requireReady(resolveReady && before !== undefined, "cross-site resolve readiness");
        const child = mirrorChild(page);
        const mirrorUrlBefore = await child
          .locator("body")
          .evaluate((body) => body.ownerDocument.defaultView?.location.href);
        await child.locator("#action-link").click();
        await waitFor("authoritative OOPIF anchor", ACTION_TIMEOUT_MS, async () =>
          (await before!.frame.locator("#action-output").textContent()) ===
          "Anchor activated on server"
            ? true
            : undefined,
        );
        const mirrorUrlAfter = await child
          .locator("body")
          .evaluate((body) => body.ownerDocument.defaultView?.location.href);
        assert.equal(
          mirrorUrlAfter,
          mirrorUrlBefore,
          "mirror child navigated locally on anchor click",
        );
        assert.equal(
          normalizedUrl(page.url()),
          normalizedUrl(viewerUrl),
          "viewer top page navigated during embedded anchor click",
        );
      },
    );

    const typed = await runAssertion(
      results,
      "type-cycle",
      "Tab + 10 exact multi-character type cycles",
      "recursive rect resolution + top-session input routing",
      async () => {
        requireReady(anchor && before !== undefined, "contained child interaction");
        const child = mirrorChild(page);
        for (let attempt = 1; attempt <= TYPE_ATTEMPTS; attempt += 1) {
          const expected = `oopif-cycle-${String(attempt).padStart(2, "0")}-exact`;
          await child.locator("#field-a").click();
          await page.keyboard.press("Tab");
          await waitFor("authoritative OOPIF Tab focus", ACTION_TIMEOUT_MS, async () =>
            (await before!.frame.evaluate(() => document.activeElement?.id)) === "field-b"
              ? true
              : undefined,
          );
          await page.keyboard.press("Control+A");
          await page.keyboard.type(expected);
          await waitExactValues(before.frame, child, expected);
          assert.equal(await before.frame.locator("#field-a").inputValue(), "alpha");
          assert.equal(await child.locator("#field-a").inputValue(), "alpha");
        }
        return `${TYPE_ATTEMPTS}/${TYPE_ATTEMPTS} server==mirror==typed cycles at ${RTT_MS}ms RTT`;
      },
    );

    await runAssertion(
      results,
      "select-value",
      "Keyboard select change follows value path",
      "resolveNode(value)",
      async () => {
        requireReady(typed && before !== undefined, "exact type cycles");
        await page.keyboard.press("Tab");
        await waitFor("authoritative OOPIF select focus", ACTION_TIMEOUT_MS, async () =>
          (await before!.frame.evaluate(() => document.activeElement?.id)) === "choice"
            ? true
            : undefined,
        );
        await page.keyboard.press("ArrowDown");
        const result = await pollForStableConvergence({
          read: async () => {
            const [server, mirrorValue] = await Promise.all([
              before!.frame.locator("#choice").inputValue(),
              mirrorChild(page).locator("#choice").inputValue(),
            ]);
            return { server, mirror: mirrorValue };
          },
          matches: ({ server, mirror: mirrorValue }) => server === "beta" && mirrorValue === "beta",
          sameState: (left, right) => left === right,
          timeoutMs: INTERACTION_CONVERGENCE_TIMEOUT_MS,
          settleMs: INTERACTION_SETTLE_MS,
          pollMs: POLL_MS,
        });
        assert.equal(result.sample.server, "beta", "authoritative select value did not converge");
        assert.equal(result.sample.mirror, "beta", "mirror select value did not converge");
      },
    );

    await runAssertion(
      results,
      "scroll-path",
      "Wheel scroll converges in authoritative child",
      "resolveNode(scroll)",
      async () => {
        requireReady(typed && before !== undefined, "exact type cycles");
        const scroller = mirrorChild(page).locator("#scroll-surface");
        await scroller.hover();
        await page.mouse.wheel(0, 280);
        const result = await pollForStableConvergence({
          read: async () => {
            const [server, mirrorValue] = await Promise.all([
              before!.frame.locator("#scroll-surface").evaluate((element) => element.scrollTop),
              scroller.evaluate((element) => element.scrollTop),
            ]);
            return { server, mirror: mirrorValue };
          },
          matches: ({ server, mirror: mirrorValue }) =>
            server > 0 && mirrorValue > 0 && Math.abs(server - mirrorValue) <= 5,
          sameState: (left, right) => Math.abs(left - right) <= 5,
          timeoutMs: INTERACTION_CONVERGENCE_TIMEOUT_MS,
          settleMs: INTERACTION_SETTLE_MS,
          pollMs: POLL_MS,
        });
        assert(
          result.sample.server > 0 &&
            result.sample.mirror > 0 &&
            Math.abs(result.sample.server - result.sample.mirror) <= 5,
          `OOPIF scroll did not converge: server=${result.sample.server} mirror=${result.sample.mirror}`,
        );
        return `server scrollTop=${result.sample.server}`;
      },
    );

    await runAssertion(
      results,
      "zero-fallback",
      "Zero vx/vy rect fallbacks",
      "gateway test instrumentation",
      async () => {
        requireReady(
          resolveReady && interactionFallbackBaseline !== undefined,
          "cross-site resolve readiness",
        );
        const count = await rectFallbackCount(gatewayUrl, tab.tab);
        const interactionFallbacks = count - interactionFallbackBaseline;
        assert.equal(
          interactionFallbacks,
          0,
          `observed ${interactionFallbacks} vx/vy rect fallbacks during interaction ` +
            `(counter ${interactionFallbackBaseline} -> ${count})`,
        );
        return `interaction rectFallbacks=0 (readiness baseline=${interactionFallbackBaseline})`;
      },
    );

    let after: OopifIdentity | undefined;
    const swapped = await runAssertion(
      results,
      "process-swap",
      "b.test → c.test process swap keeps parent and mirror live",
      "live target registry + resolve-at-dispatch",
      async () => {
        requireReady(oopifAttached && before !== undefined, "b.test OOPIF identity");
        const cUrl = `http://c.test:${site.port}/fixtures/oopif-child`;
        await remoteValue<string>(
          gatewayUrl,
          tab.tab,
          `(()=>{const frame=document.querySelector("#oopif-frame");frame.src=${JSON.stringify(cUrl)};return frame.src})()`,
        );
        after = await oopifIdentity(sourceContext, sourcePage, rootSession!, "c.test");
        assert.notEqual(after.isolateId, before.isolateId, "b.test → c.test kept the same isolate");
        await mirrorChild(page).locator("#oopif-child-marker[data-site='c.test']").waitFor({
          state: "visible",
          timeout: childMaterializationTimeout(),
        });
        await mirrorTop(page).locator("#oopif-parent-marker").waitFor({ state: "visible" });
        return `isolate changed; target ${before.targetId} → ${after.targetId}`;
      },
    );

    const postSwapInput = await runAssertion(
      results,
      "post-swap-input",
      "Input remains live after process swap",
      "child docId lifecycle + live resolution",
      async () => {
        requireReady(swapped && after !== undefined, "c.test process swap");
        const expected = "post-swap-exact";
        const child = mirrorChild(page);
        await child.locator("#field-a").click();
        await page.keyboard.press("Tab");
        await page.keyboard.type(expected);
        await waitExactValues(after.frame, child, expected);
      },
    );

    await runAssertion(
      results,
      "resync-survival",
      "Forced resync + viewport change preserves child",
      "top + child full-snapshot resync",
      async () => {
        requireReady(postSwapInput, "post-swap input");
        await requestFreshSnapshot(gatewayUrl, tab.tab, snapshots);
        await page.setViewportSize({ width: 1180, height: 720 });
        await mirrorChild(page).locator("#oopif-child-marker[data-site='c.test']").waitFor({
          state: "visible",
          timeout: ACTION_TIMEOUT_MS,
        });
        await mirrorTop(page).locator("#oopif-parent-marker").waitFor({ state: "visible" });
      },
    );

    await runAssertion(
      results,
      "fold-in-detach",
      "Cross-site child folds into same-origin parent",
      "iframe target detach + same-process fold-in",
      async () => {
        requireReady(swapped && after !== undefined, "c.test OOPIF identity");
        const aUrl = `http://a.test:${site.port}/fixtures/oopif-child`;
        await remoteValue<string>(
          gatewayUrl,
          tab.tab,
          `(()=>{const frame=document.querySelector("#oopif-frame");frame.src=${JSON.stringify(aUrl)};return frame.src})()`,
        );
        await sourceFrame(sourcePage, "a.test");
        await waitFor("OOPIF target detach on same-origin fold-in", ACTION_TIMEOUT_MS, async () =>
          (await targetInfos(rootSession!)).every(
            (info) => info.type !== "iframe" || info.targetId !== after!.targetId,
          )
            ? true
            : undefined,
        );
        await mirrorChild(page).locator("#oopif-child-marker[data-site='a.test']").waitFor({
          state: "visible",
          timeout: childMaterializationTimeout(),
        });
        await mirrorTop(page).locator("#oopif-parent-marker").waitFor({ state: "visible" });
      },
    );
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    await runAssertion(
      results,
      "harness-setup",
      "Harness setup and navigation",
      "fixture harness",
      () => {
        throw new Error(
          `${cause.message}; source=${sourceLogs.join(" | ") || "no source errors"}; ` +
            `viewer=${viewerLogs.join(" | ") || "no viewer errors"}; dev=${dev.logs().slice(-4000)}`,
        );
      },
    );
  } finally {
    await rootSession?.detach().catch(() => undefined);
    await authoritativeBrowser?.close().catch(() => undefined);
    await viewerBrowser?.close().catch(() => undefined);
    await stopDev(dev.child);
    await closeFixtureSite(site.server).catch(() => undefined);
  }

  const report: OopifReport = {
    schemaVersion: 1,
    mode: "oopif-opt-in",
    envGate: "P2_DIFF_OOPIF=1",
    simulatedRttMs: RTT_MS,
    fault: process.env.P2_DIFF_FAULT || null,
    assertions: results,
    pass: results.length > 0 && results.every((result) => result.status === "PASS"),
  };
  const [markdown, json] = await Promise.all([
    formatText(reportMarkdown(report), { parser: "markdown" }),
    formatText(JSON.stringify(report), { parser: "json" }),
  ]);
  await mkdir(OUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(resolve(OUT_DIR, "p2-diff-oopif.md"), markdown),
    writeFile(resolve(OUT_DIR, "p2-diff-oopif.json"), json),
  ]);
  process.stdout.write(`${markdown}\nP2-DIFF OOPIF GATE: ${report.pass ? "PASS" : "FAIL"}\n`);
  if (report.pass) return "pass";
  if (results.some((result) => result.failureKind === "fidelity")) return "fidelity";
  return "transient-infra";
}
