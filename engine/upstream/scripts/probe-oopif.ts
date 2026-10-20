/**
 * Pre-OOPIF diagnostic: real cross-site target lifecycle, agent transport, and rrweb map access.
 *
 * This intentionally does not implement any OOPIF behavior. Run after building the worktree:
 *
 *   CHROME_PATH=/usr/bin/google-chrome pnpm exec tsx scripts/probe-oopif.ts
 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentLink } from "../packages/gateway/src/browser/agentlink";
import {
  launchBrowser,
  type BrowserHandle,
  type BrowserTargetInfo,
} from "../packages/gateway/src/browser/launch";
import type { AgentLink, TargetRef } from "../packages/gateway/src/types";

const START_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 20_000;
const POLL_MS = 25;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CdpLifecycleEvent {
  sequence: number;
  event: "Target.attachedToTarget" | "Target.detachedFromTarget" | "Target.targetInfoChanged";
  targetId: string;
  sessionId?: string;
  type?: string;
  url?: string;
}

interface AgentHello {
  targetId: string;
  sessionId: string;
  docId: number;
  url: string;
  isTop: boolean;
}

interface FrameIdentity {
  targetId: string;
  sessionId: string;
  frameId: string;
  isolateId: string;
  docId: number;
  url: string;
}

interface RrwebFinding {
  version: string;
  distFile: string;
  className: "CrossOriginIframeMirror";
  managerClass: "IframeManager";
  managerProperty: "crossOriginIframeMirror";
  mapProperties: ["iframeIdToRemoteIdMap", "iframeRemoteIdToIdMap"];
  methods: ["getId", "getIds", "getRemoteId", "getRemoteIds"];
  pluginAccessor: "plugins[].getMirror";
  viable: true;
}

function freePort(): Promise<number> {
  const server = createNetServer();
  return new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      const port = address.port;
      server.close((error) => (error === undefined ? resolvePort(port) : reject(error)));
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
}

async function inspectRrwebDist(): Promise<RrwebFinding> {
  const packageDir = await realpath(join(REPO_ROOT, "packages/agent/node_modules/@rrweb/record"));
  const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
    version?: unknown;
  };
  const distFile = join(packageDir, "dist/record.js");
  const dist = await readFile(distFile, "utf8");

  assert.equal(packageJson.version, "2.1.1", "probe requires the installed @rrweb/record 2.1.1");
  const requiredTokens = [
    "class CrossOriginIframeMirror",
    '"iframeIdToRemoteIdMap"',
    '"iframeRemoteIdToIdMap"',
    "getId(iframe, remoteId",
    "getIds(iframe, remoteId)",
    "getRemoteId(iframe, id",
    "getRemoteIds(iframe, ids)",
    "class IframeManager",
    '"crossOriginIframeMirror"',
    "if (plugin.getMirror)",
    "crossOriginIframeMirror: iframeManager.crossOriginIframeMirror",
  ];
  const missing = requiredTokens.filter((token) => !dist.includes(token));
  if (missing.length > 0) {
    console.error("\n=== OOPIF PROBE FINDINGS ===");
    console.error("B: DECISION-2 patched-accessor approach: NOT VIABLE");
    console.error(`Installed dist: ${distFile}`);
    console.error(`Missing required rrweb internals: ${missing.join(", ")}`);
    console.error("FORK IN THE ROAD: STOP. No OOPIF implementation should be attempted.");
    throw new Error("@rrweb/record 2.1.1 does not expose the required cross-origin maps");
  }

  return {
    version: "2.1.1",
    distFile,
    className: "CrossOriginIframeMirror",
    managerClass: "IframeManager",
    managerProperty: "crossOriginIframeMirror",
    mapProperties: ["iframeIdToRemoteIdMap", "iframeRemoteIdToIdMap"],
    methods: ["getId", "getIds", "getRemoteId", "getRemoteIds"],
    pluginAccessor: "plugins[].getMirror",
    viable: true,
  };
}

function startFixture(port: number): Promise<Server> {
  const server = createServer((request, response) => handleFixtureRequest(port, request, response));
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen(server));
  });
}

function handleFixtureRequest(
  port: number,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const host = (request.headers.host ?? "").split(":", 1)[0];
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "a.test"}`);
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "text/html; charset=utf-8");

  if (request.method === "GET" && host === "a.test" && requestUrl.pathname === "/") {
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>OOPIF host</title>
<style>body{font:20px system-ui;margin:32px}iframe{width:720px;height:320px;border:3px solid #345}</style>
</head><body><h1 id="a-marker">a.test host</h1>
<iframe id="oopif-probe-frame" name="oopif-probe-frame" src="about:blank"></iframe>
</body></html>`);
    return;
  }

  if (
    request.method === "GET" &&
    (host === "b.test" || host === "c.test") &&
    requestUrl.pathname === "/"
  ) {
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${host} child</title>
</head><body><h1 id="site-marker" data-site="${host}">${host} OOPIF child</h1>
<p id="child-location">${requestUrl.href}</p></body></html>`);
    return;
  }

  response.writeHead(404).end("not found");
}

function lifecycleLine(event: CdpLifecycleEvent): string {
  const fields = [
    `targetId=${event.targetId}`,
    ...(event.sessionId === undefined ? [] : [`sessionId=${event.sessionId}`]),
    ...(event.type === undefined ? [] : [`type=${event.type}`]),
    ...(event.url === undefined ? [] : [`url=${event.url || "<empty>"}`]),
  ];
  return `[CDP ${event.sequence}] ${event.event} ${fields.join(" ")}`;
}

function observeLifecycle(
  browser: BrowserHandle,
  agent: AgentLink,
  targets: Map<string, TargetRef>,
): { events: CdpLifecycleEvent[]; hellos: AgentHello[] } {
  const events: CdpLifecycleEvent[] = [];
  const hellos: AgentHello[] = [];
  let sequence = 0;

  const record = (event: Omit<CdpLifecycleEvent, "sequence">): void => {
    const item = { sequence: ++sequence, ...event };
    events.push(item);
    console.log(lifecycleLine(item));
  };

  browser.onAttached((target) => {
    record({
      event: "Target.attachedToTarget",
      targetId: target.targetId,
      sessionId: target.sessionId,
      type: target.type,
    });
    void (async () => {
      try {
        for await (const message of agent.msgs(target.targetId)) {
          if (message.kind !== "hello") continue;
          const hello = {
            targetId: target.targetId,
            sessionId: target.sessionId,
            docId: message.docId,
            url: message.url,
            isTop: message.isTop,
          };
          hellos.push(hello);
          console.log(
            `[GATEWAY] hello targetId=${hello.targetId} sessionId=${hello.sessionId} docId=${hello.docId} isTop=${hello.isTop} url=${hello.url}`,
          );
        }
      } catch (error) {
        // A process swap rejects the old target stream by design; the replacement attach creates
        // another stream and observer. Preserve the actual lifecycle instead of hiding it.
        console.log(
          `[GATEWAY] stream ended targetId=${target.targetId} sessionId=${target.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  });
  browser.onDetached((target) => {
    record({
      event: "Target.detachedFromTarget",
      targetId: target.targetId,
      sessionId: target.sessionId,
      type: target.type,
    });
  });
  browser.onTargetInfoChanged((info: BrowserTargetInfo) => {
    if (info.type !== "page" && info.type !== "iframe") return;
    record({
      event: "Target.targetInfoChanged",
      targetId: info.targetId,
      type: info.type,
      url: info.url,
    });
  });

  // Keep the target registry up to date even when Chromium reuses a targetId with a new session.
  browser.onAttached((target) => targets.set(target.targetId, target));
  browser.onDetached((target) => {
    if (targets.get(target.targetId)?.sessionId === target.sessionId) {
      targets.delete(target.targetId);
    }
  });

  return { events, hellos };
}

async function describeIframeFrameId(browser: BrowserHandle, page: TargetRef): Promise<string> {
  const evaluated = (await browser.send(page.sessionId, "Runtime.evaluate", {
    expression: 'document.querySelector("#oopif-probe-frame")',
    returnByValue: false,
  })) as { result?: { objectId?: string; description?: string }; exceptionDetails?: unknown };
  const objectId = evaluated.result?.objectId;
  if (evaluated.exceptionDetails !== undefined || objectId === undefined) {
    throw new Error(
      `could not resolve fixture iframe: ${evaluated.result?.description ?? "no object"}`,
    );
  }
  try {
    const described = (await browser.send(page.sessionId, "DOM.describeNode", {
      objectId,
      depth: 0,
    })) as { node?: { frameId?: string } };
    const frameId = described.node?.frameId;
    if (frameId === undefined) throw new Error("DOM.describeNode did not return iframe frameId");
    return frameId;
  } finally {
    await browser
      .send(page.sessionId, "Runtime.releaseObject", { objectId })
      .catch(() => undefined);
  }
}

async function navigatePage(browser: BrowserHandle, page: TargetRef, url: string): Promise<void> {
  await browser.send(page.sessionId, "Page.navigate", { url });
}

async function navigateIframe(browser: BrowserHandle, page: TargetRef, url: string): Promise<void> {
  const result = (await browser.send(page.sessionId, "Runtime.evaluate", {
    expression: `(() => { const frame = document.querySelector("#oopif-probe-frame"); if (!(frame instanceof HTMLIFrameElement)) throw new Error("fixture iframe missing"); frame.src = ${JSON.stringify(url)}; return frame.src; })()`,
    returnByValue: true,
  })) as { result?: { value?: unknown; description?: string }; exceptionDetails?: unknown };
  if (result.exceptionDetails !== undefined || result.result?.value !== url) {
    throw new Error(
      `iframe navigation failed: ${result.result?.description ?? "unexpected result"}`,
    );
  }
}

function helloForSite(hellos: AgentHello[], site: "b.test" | "c.test"): AgentHello | undefined {
  return hellos.find((hello) => !hello.isTop && new URL(hello.url).hostname === site);
}

function iframeTargetForHello(hello: AgentHello, targets: Map<string, TargetRef>): TargetRef {
  const target = targets.get(hello.targetId);
  assert(target, `target ${hello.targetId} detached before identity was sampled`);
  assert.equal(target.sessionId, hello.sessionId, "live target session differs from child hello");
  assert.equal(target.type, "iframe", "cross-site child did not attach as iframe target");
  return target;
}

async function readIsolateId(browser: BrowserHandle, target: TargetRef): Promise<string> {
  const result = (await browser.send(target.sessionId, "Runtime.getIsolateId")) as {
    id?: string;
  };
  if (result.id === undefined) throw new Error("Runtime.getIsolateId returned no isolate id");
  return result.id;
}

function frameIdentity(hello: AgentHello, frameId: string, isolateId: string): FrameIdentity {
  return {
    targetId: hello.targetId,
    sessionId: hello.sessionId,
    frameId,
    isolateId,
    docId: hello.docId,
    url: hello.url,
  };
}

async function main(): Promise<void> {
  const chromePath = process.env.CHROME_PATH;
  if (chromePath === undefined || chromePath.trim() === "") {
    throw new Error("CHROME_PATH must point to the system Chromium executable");
  }
  await access(chromePath);

  const rrweb = await inspectRrwebDist();
  const port = await freePort();
  const fixture = await startFixture(port);
  const profileDir = await mkdtemp(join(tmpdir(), "mirror-oopif-probe-"));
  const topUrl = `http://a.test:${port}/`;
  const bUrl = `http://b.test:${port}/`;
  const cUrl = `http://c.test:${port}/`;
  let browser: BrowserHandle | undefined;

  try {
    browser = await launchBrowser({
      executablePath: chromePath,
      headful: false,
      userDataDir: profileDir,
      args: [
        "--disable-dev-shm-usage",
        "--site-per-process",
        "--no-proxy-server",
        `--host-resolver-rules=MAP a.test 127.0.0.1, MAP b.test 127.0.0.1, MAP c.test 127.0.0.1`,
      ],
    });

    const targets = new Map<string, TargetRef>();
    browser.onAttached((target) => targets.set(target.targetId, target));
    browser.onDetached((target) => {
      if (targets.get(target.targetId)?.sessionId === target.sessionId) {
        targets.delete(target.targetId);
      }
    });
    const agent = createAgentLink(browser);
    const observed = observeLifecycle(browser, agent, targets);

    const page = await waitFor("initial page target", START_TIMEOUT_MS, () =>
      [...targets.values()].find((target) => target.type === "page"),
    );
    await waitFor("initial page agent hello", START_TIMEOUT_MS, () =>
      observed.hellos.find(
        (hello) => hello.targetId === page.targetId && hello.sessionId === page.sessionId,
      ),
    );
    await navigatePage(browser, page, topUrl);
    await waitFor("a.test page agent hello", ACTION_TIMEOUT_MS, () =>
      observed.hellos.find((hello) => hello.isTop && new URL(hello.url).hostname === "a.test"),
    );
    // Make the intended about:blank -> b.test -> c.test chain explicit. This prevents a
    // provisional about:blank binding from racing the b.test hello during initial page parsing.
    await navigateIframe(browser, page, bUrl);

    let bHello: AgentHello;
    try {
      bHello = await waitFor("b.test iframe target and child /docId", ACTION_TIMEOUT_MS, () =>
        helloForSite(observed.hellos, "b.test"),
      );
    } catch (error) {
      console.error("\n=== OOPIF PROBE FINDINGS ===");
      console.error("A1: NO iframe-type b.test target attached.");
      console.error(
        "SITE ISOLATION DID NOT ENGAGE in this environment; true OOPIF testing is unavailable here.",
      );
      console.error(`Chromium flags included --site-per-process and host resolver mappings.`);
      throw error;
    }
    const bTarget = iframeTargetForHello(bHello, targets);
    const bFrameId = await describeIframeFrameId(browser, page);
    const bIsolateId = await readIsolateId(browser, bTarget);
    const before = frameIdentity(bHello, bFrameId, bIsolateId);
    const pingStarted = performance.now();
    const pingOutcome = await agent.sendCmd(bTarget.targetId, { cmd: "ping" }).then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({
        result: null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    const pingRoundTripMs = performance.now() - pingStarted;
    const pingRoundTripped = pingOutcome.result?.ok === true && pingOutcome.result.data === "pong";
    const latestPreSwapHello = observed.hellos
      .filter((hello) => hello.targetId === bHello.targetId && hello.sessionId === bHello.sessionId)
      .at(-1);

    const swapStartSequence = observed.events.at(-1)?.sequence ?? 0;
    await navigateIframe(browser, page, cUrl);
    const cHello = await waitFor("c.test iframe process-swap /docId", ACTION_TIMEOUT_MS, () =>
      helloForSite(observed.hellos, "c.test"),
    );
    const cTarget = iframeTargetForHello(cHello, targets);
    const cFrameId = await waitFor("c.test iframe frameId", ACTION_TIMEOUT_MS, async () => {
      const candidate = await describeIframeFrameId(browser!, page);
      return candidate === cHello.targetId ? candidate : undefined;
    });
    const cIsolateId = await readIsolateId(browser, cTarget);
    const after = frameIdentity(cHello, cFrameId, cIsolateId);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    const swapEvents = observed.events.filter((event) => event.sequence > swapStartSequence);

    const targetStable = before.targetId === after.targetId;
    const frameStable = before.frameId === after.frameId;
    const sessionChanged = before.sessionId !== after.sessionId;
    const isolateChanged = before.isolateId !== after.isolateId;
    assert.equal(before.targetId, before.frameId, "b.test OOPIF targetId != frameId");
    assert.equal(after.targetId, after.frameId, "c.test OOPIF targetId != frameId");
    assert(isolateChanged, "b.test -> c.test did not produce a renderer-isolate/process swap");

    console.log("\n=== OOPIF PROBE FINDINGS ===");
    console.log(
      `A1: REAL OOPIF YES — iframe targetId=${before.targetId}; describeNode frameId=${before.frameId}; targetId==frameId=${before.targetId === before.frameId ? "YES" : "NO"}.`,
    );
    console.log(
      `A2 before: targetId=${before.targetId} frameId=${before.frameId} sessionId=${before.sessionId} isolateId=${before.isolateId} docId=${before.docId} url=${before.url}`,
    );
    console.log(
      `A2 after:  targetId=${after.targetId} frameId=${after.frameId} sessionId=${after.sessionId} isolateId=${after.isolateId} docId=${after.docId} url=${after.url}`,
    );
    console.log(
      `A2 result: renderer isolate/process changed=${isolateChanged ? "YES" : "NO"}; targetId stable=${targetStable ? "YES" : "NO"}; frameId stable=${frameStable ? "YES" : "NO"}; sessionId changed=${sessionChanged ? "YES" : "NO"}.`,
    );
    console.log("A2 exact b.test -> c.test lifecycle sequence:");
    for (const event of swapEvents) console.log(`  ${lifecycleLine(event)}`);
    console.log(
      `A3: child /docId received=YES (b.test docId=${bHello.docId}); sendCmd(${bTarget.targetId}, ping) round-trip=${pingRoundTripped ? "YES" : "NO"}; elapsed=${pingRoundTripMs.toFixed(2)}ms${pingOutcome.error === null ? `; result=${JSON.stringify(pingOutcome.result)}` : `; error=${pingOutcome.error}`}.`,
    );
    if (latestPreSwapHello !== undefined && latestPreSwapHello.docId !== bHello.docId) {
      console.log(
        `A3 transport detail: a later hello on the SAME target/session replaced the b.test docId before the ping completed: docId=${latestPreSwapHello.docId} url=${latestPreSwapHello.url}.`,
      );
    }
    console.log(
      `B: DECISION-2 patched-accessor approach=YES against @rrweb/record ${rrweb.version}.`,
    );
    console.log(
      `B names: ${rrweb.managerClass}.${rrweb.managerProperty} -> ${rrweb.className}; maps=${rrweb.mapProperties.join(",")}; methods=${rrweb.methods.join(",")}; access=${rrweb.pluginAccessor}.`,
    );
    console.log(
      "B direction: getId(iframe, remoteId) maps child-remote -> parent/unified; getRemoteId(iframe, parentId) maps parent/unified -> child-remote.",
    );
    console.log(
      `B dist: ${rrweb.distFile} (the plugin hook already exposes the mirror object; an additive record accessor is patchable but not required to reach it).`,
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await closeServer(fixture).catch(() => undefined);
    await rm(profileDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
