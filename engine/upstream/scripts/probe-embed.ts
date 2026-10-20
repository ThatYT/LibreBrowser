/**
 * Regression probe for same-origin iframe interaction and default-action containment.
 *
 * It cycles focus and replaces a multi-character embedded value ten times, asserting exact
 * authoritative/mirror equality and that the preceding field never receives stray local edits.
 * Run with:
 *
 *   CHROME_PATH=/usr/bin/google-chrome pnpm exec tsx scripts/probe-embed.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type CDPSession, type Page } from "playwright";

const START_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 20_000;
const SETTLE_MS = 1_500;
const POLL_MS = 25;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EMBED_FRAME_NAME = "embed-probe-frame";
const TYPE_VALUE = "typed-through-viewer-embed-probe";
const TYPE_ATTEMPTS = 10;

interface GatewayState {
  tabs: Array<{ tab: string; epoch: number; docId: number; seq: number; url: string }>;
}

interface ListenerAudit {
  top: Record<string, number>;
  child: Record<string, number>;
}

interface HitTestAudit {
  iframePointerEvents: string;
  documentPointerEvents: string;
  bodyPointerEvents: string;
  topHitTag: string | null;
  childHitId: string | null;
}

interface ProbeEvents {
  keydown: number;
  keyup: number;
  mousedown: number;
  mouseup: number;
  clicks: Array<{ id: string; isTrusted: boolean; defaultPrevented: boolean }>;
}

interface WireObservation {
  sent: unknown[];
}

interface HttpObservation {
  url: string;
  referer: string;
  secFetchDest: string;
  userAgent: string;
}

type InputFinding = "DEAD" | "WORKS" | "INCONCLUSIVE";
type LeakFinding = "LEAK-LIVE" | "CONTAINED" | "INCONCLUSIVE";

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
    if (process.env.PROBE_EMBED_VERBOSE === "1") process.stderr.write(text);
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
  const observation: WireObservation = { sent: [] };
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        observation.sent.push(JSON.parse(String(payload)) as unknown);
      } catch {
        // Only JSON application frames are relevant to this diagnostic.
      }
    });
  });
  return observation;
}

function messageTag(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tag = (value as { t?: unknown }).t;
  return typeof tag === "string" ? tag : undefined;
}

async function auditListeners(session: CDPSession): Promise<ListenerAudit> {
  const tracked = [
    "mousedown",
    "mouseup",
    "mousemove",
    "click",
    "auxclick",
    "keydown",
    "keyup",
    "paste",
    "input",
    "change",
    "wheel",
    "scroll",
    "submit",
    "drop",
  ];
  const contexts = new Map<string, number>();
  const onContext = (event: {
    context: { id: number; auxData?: { frameId?: string; isDefault?: boolean } };
  }) => {
    const { frameId, isDefault } = event.context.auxData ?? {};
    if (frameId !== undefined && isDefault === true) contexts.set(frameId, event.context.id);
  };
  session.on("Runtime.executionContextCreated", onContext);
  await session.send("Runtime.enable");
  const { frameTree } = await session.send("Page.getFrameTree");
  type FrameTree = typeof frameTree;
  const findNamedFrame = (tree: FrameTree): FrameTree | undefined => {
    if (tree.frame.name === EMBED_FRAME_NAME) return tree;
    for (const child of tree.childFrames ?? []) {
      const found = findNamedFrame(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const findParent = (tree: FrameTree, childId: string): FrameTree | undefined => {
    if (tree.childFrames?.some((child) => child.frame.id === childId)) return tree;
    for (const child of tree.childFrames ?? []) {
      const found = findParent(child, childId);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const childTree = findNamedFrame(frameTree);
  const topTree = childTree === undefined ? undefined : findParent(frameTree, childTree.frame.id);
  if (childTree === undefined || topTree === undefined) {
    throw new Error("CDP listener audit could not identify the nested mirror frame tree");
  }

  const readDocument = async (frameId: string): Promise<Record<string, number>> => {
    const contextId = await waitFor("CDP default execution context", 2_000, () =>
      contexts.get(frameId),
    );
    const evaluated = await session.send("Runtime.evaluate", {
      expression: "document",
      contextId,
      returnByValue: false,
    });
    const objectId = evaluated.result.objectId;
    if (evaluated.exceptionDetails !== undefined || objectId === undefined) {
      throw new Error(
        `CDP listener audit could not resolve a document: ${evaluated.exceptionDetails?.text ?? "no object id"}`,
      );
    }
    const result = await session.send("DOMDebugger.getEventListeners", { objectId });
    return Object.fromEntries(
      tracked.map((type) => [
        type,
        result.listeners.filter((listener) => listener.type === type).length,
      ]),
    );
  };
  const result = {
    top: await readDocument(topTree.frame.id),
    child: await readDocument(childTree.frame.id),
  };
  session.off("Runtime.executionContextCreated", onContext);
  return result;
}

function currentMirrorChildFrame(page: Page) {
  return page
    .frames()
    .filter((frame) => !frame.isDetached() && frame.name() === EMBED_FRAME_NAME)
    .at(-1);
}

async function auditHitTesting(page: Page): Promise<HitTestAudit> {
  return page.evaluate(() => {
    const replay = document.querySelector<HTMLIFrameElement>("#mirror-host iframe");
    const topDoc = replay?.contentDocument;
    const child = topDoc?.querySelector<HTMLIFrameElement>("#source-frame");
    const childDoc = child?.contentDocument;
    const input = childDoc?.querySelector<HTMLElement>("#embedded");
    if (
      child === null ||
      child === undefined ||
      childDoc === null ||
      childDoc === undefined ||
      !input
    ) {
      throw new Error("embedded mirror DOM is unavailable");
    }
    const childRect = child.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    return {
      iframePointerEvents: getComputedStyle(child).pointerEvents,
      documentPointerEvents: getComputedStyle(childDoc.documentElement).pointerEvents,
      bodyPointerEvents: getComputedStyle(childDoc.body).pointerEvents,
      topHitTag:
        topDoc
          ?.elementFromPoint(
            childRect.left + childRect.width / 2,
            childRect.top + childRect.height / 2,
          )
          ?.tagName.toLowerCase() ?? null,
      childHitId:
        childDoc.elementFromPoint(
          inputRect.left + inputRect.width / 2,
          inputRect.top + inputRect.height / 2,
        )?.id ?? null,
    };
  });
}

async function installTrustedEventProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const replay = document.querySelector<HTMLIFrameElement>("#mirror-host iframe");
    const childDoc =
      replay?.contentDocument?.querySelector<HTMLIFrameElement>("#source-frame")?.contentDocument;
    if (childDoc === null || childDoc === undefined)
      throw new Error("child mirror document missing");
    const outer = window as typeof window & { __embedProbeEvents?: ProbeEvents };
    outer.__embedProbeEvents = { keydown: 0, keyup: 0, mousedown: 0, mouseup: 0, clicks: [] };
    childDoc.addEventListener("keydown", () => (outer.__embedProbeEvents!.keydown += 1), true);
    childDoc.addEventListener("keyup", () => (outer.__embedProbeEvents!.keyup += 1), true);
    childDoc.addEventListener("mousedown", () => (outer.__embedProbeEvents!.mousedown += 1), true);
    childDoc.addEventListener("mouseup", () => (outer.__embedProbeEvents!.mouseup += 1), true);
    childDoc.addEventListener("click", (event) => {
      outer.__embedProbeEvents!.clicks.push({
        id: (event.target as Element | null)?.id ?? "",
        isTrusted: event.isTrusted,
        defaultPrevented: event.defaultPrevented,
      });
    });
  });
}

async function readProbeEvents(page: Page): Promise<ProbeEvents> {
  return page.evaluate(() => {
    const events = (window as typeof window & { __embedProbeEvents?: ProbeEvents })
      .__embedProbeEvents;
    if (events === undefined) throw new Error("trusted event probe was not installed");
    return events;
  });
}

function startTestSite(token: string): Promise<{
  server: Server;
  url: string;
  distinctivePath: string;
  requests: HttpObservation[];
}> {
  const distinctivePath = `/distinctive-viewer-fetch/${token}`;
  const requests: HttpObservation[] = [];
  const server = createServer((request, response) => {
    handleTestSiteRequest(request, response, distinctivePath, requests);
  });
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      resolveListen({
        server,
        url: `http://127.0.0.1:${address.port}`,
        distinctivePath,
        requests,
      });
    });
  });
}

function handleTestSiteRequest(
  request: IncomingMessage,
  response: ServerResponse,
  distinctivePath: string,
  requests: HttpObservation[],
): void {
  const origin = `http://${request.headers.host ?? "embed.test"}`;
  const requestUrl = new URL(request.url ?? "/", origin);
  response.setHeader("cache-control", "no-store");

  if (request.method === "GET" && requestUrl.pathname === "/top") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Embed probe</title>
<style>body{font:20px system-ui;margin:32px}iframe{width:720px;height:320px;border:3px solid #345}</style>
</head><body><main><h1 id="top-marker">Same-origin embed probe</h1>
<iframe id="source-frame" name="${EMBED_FRAME_NAME}" src="/embedded"></iframe>
</main></body></html>`);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/embedded") {
    const distinctiveUrl = `${origin}${distinctivePath}`;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Embedded probe</title>
<style>body{font:20px system-ui;padding:24px}label,input,a{display:block}input{font:inherit;width:520px;padding:10px;margin:8px 0 28px}a{padding:12px;background:#def}</style>
</head><body><main id="embedded-marker"><label for="embedded-primer">Focus primer</label>
<input id="embedded-primer" value="alpha" autocomplete="off">
<label for="embedded">Embedded input</label>
<input id="embedded" autocomplete="off">
<a id="embedlink" href=${JSON.stringify(distinctiveUrl)}>Navigate this child frame locally</a>
</main></body></html>`);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === distinctivePath) {
    requests.push({
      url: requestUrl.href,
      referer: request.headers.referer ?? "",
      secFetchDest: String(request.headers["sec-fetch-dest"] ?? ""),
      userAgent: request.headers["user-agent"] ?? "",
    });
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><html><body><h1 id="distinctive-marker">DISTINCTIVE VIEWER FETCH ${tokenFromPath(distinctivePath)}</h1></body></html>`,
    );
    return;
  }

  response.writeHead(404).end("not found");
}

function tokenFromPath(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
}

async function main(): Promise<void> {
  const chromePath = process.env.CHROME_PATH;
  if (chromePath === undefined || chromePath.trim() === "") {
    throw new Error("CHROME_PATH must point to the system Chromium executable");
  }
  await access(chromePath);

  const token = `${Date.now()}-${process.pid}`;
  const [gatewayPort, viewerPort] = await Promise.all([freePort(), freePort()]);
  assert.notEqual(gatewayPort, viewerPort);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const viewerUrl = `http://127.0.0.1:${viewerPort}`;
  const site = await startTestSite(token);
  const distinctiveUrl = `${site.url}${site.distinctivePath}`;
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
    const viewerRequests: HttpObservation[] = [];
    page.on("request", (request) => {
      if (request.url() !== distinctiveUrl) return;
      const headers = request.headers();
      viewerRequests.push({
        url: request.url(),
        referer: headers.referer ?? "",
        secFetchDest: headers["sec-fetch-dest"] ?? "",
        userAgent: headers["user-agent"] ?? "",
      });
    });

    await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: START_TIMEOUT_MS });
    await page.waitForSelector('#connection-state[data-state="open"]', {
      timeout: START_TIMEOUT_MS,
    });
    await currentTab(gatewayUrl);

    const topUrl = `${site.url}/top`;
    const urlbar = page.locator('#urlbar input[aria-label="Address"]');
    await urlbar.fill(topUrl);
    await urlbar.press("Enter");
    const tab = await waitFor("authoritative top-page navigation", ACTION_TIMEOUT_MS, async () => {
      const candidate = await currentTab(gatewayUrl);
      return candidate.url === topUrl ? candidate : undefined;
    });
    await waitFor("authoritative same-origin child document", ACTION_TIMEOUT_MS, async () => {
      const ready = await remoteValue<boolean>(
        gatewayUrl,
        tab.tab,
        `Boolean(document.querySelector("#source-frame")?.contentDocument?.querySelector("#embedded"))`,
      );
      return ready ? true : undefined;
    });
    await page.waitForFunction(
      () => {
        const replay = document.querySelector<HTMLIFrameElement>("#mirror-host iframe");
        const child = replay?.contentDocument?.querySelector<HTMLIFrameElement>("#source-frame");
        return (
          document.querySelector<HTMLElement>("#mirror-host")?.dataset.mirrorState === "live" &&
          child?.contentDocument?.querySelector("#embedded") !== null &&
          child?.contentDocument?.querySelector("#embedlink") !== null
        );
      },
      undefined,
      { timeout: ACTION_TIMEOUT_MS },
    );
    // The iframe element can become queryable before rrweb applies its recorded child document.
    // Let that one-time document swap settle, then resolve all actions through FrameLocator.
    await new Promise((resolveWait) => setTimeout(resolveWait, SETTLE_MS));

    const childFrame = currentMirrorChildFrame(page);
    assert(childFrame, "rrweb child mirror iframe was present in the DOM but not as a real frame");
    const initialChildLocation = childFrame.url();
    const nestedMirror = page.frameLocator("#mirror-host iframe").frameLocator("#source-frame");
    const cdp = await page.context().newCDPSession(page);
    const listenerAudit = await auditListeners(cdp);
    const hitTesting = await auditHitTesting(page);
    await installTrustedEventProbe(page);

    const input = nestedMirror.locator("#embedded");
    const primer = nestedMirror.locator("#embedded-primer");
    const wireBeforeType = wire.sent.length;
    let typingError: string | null = null;
    try {
      for (let attempt = 1; attempt <= TYPE_ATTEMPTS; attempt += 1) {
        if (attempt === 1) {
          await primer.click({ timeout: 5_000 });
        } else {
          await page.keyboard.press("Shift+Tab");
          await waitFor(
            `authoritative primer focus attempt ${attempt}`,
            ACTION_TIMEOUT_MS,
            async () =>
              (await remoteValue<string>(
                gatewayUrl,
                tab.tab,
                `document.querySelector("#source-frame")?.contentDocument?.activeElement?.id ?? ""`,
              )) === "embedded-primer"
                ? true
                : undefined,
          );
        }
        await page.keyboard.press("Tab");
        await waitFor(
          `authoritative embedded focus attempt ${attempt}`,
          ACTION_TIMEOUT_MS,
          async () =>
            (await remoteValue<string>(
              gatewayUrl,
              tab.tab,
              `document.querySelector("#source-frame")?.contentDocument?.activeElement?.id ?? ""`,
            )) === "embedded"
              ? true
              : undefined,
        );
        await page.keyboard.press("Control+A");
        await page.keyboard.type(TYPE_VALUE);
        await waitFor(`lossless embedded value attempt ${attempt}`, ACTION_TIMEOUT_MS, async () => {
          const [serverValue, mirrorValue, serverPrimer, mirrorPrimer] = await Promise.all([
            remoteValue<string>(
              gatewayUrl,
              tab.tab,
              `document.querySelector("#source-frame")?.contentDocument?.querySelector("#embedded")?.value ?? "<missing>"`,
            ),
            input.inputValue(),
            remoteValue<string>(
              gatewayUrl,
              tab.tab,
              `document.querySelector("#source-frame")?.contentDocument?.querySelector("#embedded-primer")?.value ?? "<missing>"`,
            ),
            primer.inputValue(),
          ]);
          return serverValue === TYPE_VALUE &&
            mirrorValue === TYPE_VALUE &&
            serverPrimer === "alpha" &&
            mirrorPrimer === "alpha"
            ? true
            : undefined;
        });
      }
    } catch (error) {
      typingError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, SETTLE_MS));

    const eventsAfterType = await readProbeEvents(page);
    const localInputValue = await input.inputValue().catch(() => "<unavailable>");
    const serverInputValue = await remoteValue<string>(
      gatewayUrl,
      tab.tab,
      `document.querySelector("#source-frame")?.contentDocument?.querySelector("#embedded")?.value ?? "<missing>"`,
    );
    const typeWireTags = wire.sent.slice(wireBeforeType).map(messageTag).filter(Boolean);
    const typeKeyFrames = typeWireTags.filter((tag) => tag === "key").length;
    const inputFinding: InputFinding =
      typingError === null && serverInputValue === TYPE_VALUE && localInputValue === TYPE_VALUE
        ? "WORKS"
        : eventsAfterType.keydown > 0 && serverInputValue !== TYPE_VALUE
          ? "DEAD"
          : "INCONCLUSIVE";

    await page.evaluate(() => {
      const events = (window as typeof window & { __embedProbeEvents?: ProbeEvents })
        .__embedProbeEvents;
      if (events !== undefined) events.clicks = [];
    });
    const wireBeforeClick = wire.sent.length;
    let clickError: string | null = null;
    try {
      await nestedMirror.locator("#embedlink").click({ timeout: 5_000 });
    } catch (error) {
      clickError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, SETTLE_MS));

    const eventsAfterClick = await readProbeEvents(page);
    const linkClick = eventsAfterClick.clicks.find((event) => event.id === "embedlink");
    const childLocation = currentMirrorChildFrame(page)?.url() ?? "<detached>";
    const serverChildLocation = await remoteValue<string>(
      gatewayUrl,
      tab.tab,
      `document.querySelector("#source-frame")?.contentWindow?.location.href ?? "<missing>"`,
    );
    const clickWireTags = wire.sent.slice(wireBeforeClick).map(messageTag).filter(Boolean);
    const clickPointerFrames = clickWireTags.filter((tag) => tag === "ptr").length;
    const localNavigation = childLocation === distinctiveUrl;
    const viewerFetchObserved = viewerRequests.length > 0;
    const leakFinding: LeakFinding =
      linkClick?.isTrusted === true && localNavigation && viewerFetchObserved
        ? "LEAK-LIVE"
        : linkClick?.isTrusted === true &&
            linkClick.defaultPrevented &&
            !localNavigation &&
            !viewerFetchObserved
          ? "CONTAINED"
          : "INCONCLUSIVE";
    const pointerEventsMasking =
      hitTesting.iframePointerEvents === "none" ||
      (typingError !== null && eventsAfterType.mousedown === 0) ||
      (clickError !== null && linkClick === undefined);

    const report = {
      childMirror: {
        present: true,
        initialUrl: initialChildLocation,
        hitTesting,
        listenerAudit,
      },
      input: {
        finding: inputFinding,
        typingError,
        trustedKeydownEvents: eventsAfterType.keydown,
        trustedKeyupEvents: eventsAfterType.keyup,
        viewerLocalValue: localInputValue,
        authoritativeServerValue: serverInputValue,
        exactTypingAttempts: TYPE_ATTEMPTS,
        websocketKeyFrames: typeKeyFrames,
        websocketTags: [...new Set(typeWireTags)],
      },
      anchor: {
        finding: leakFinding,
        clickError,
        trustedClick: linkClick ?? null,
        childMirrorLocation: childLocation,
        authoritativeChildLocation: serverChildLocation,
        viewerFetches: viewerRequests,
        allDistinctiveServerRequests: site.requests,
        websocketPointerFrames: clickPointerFrames,
        websocketTags: clickWireTags,
      },
      pointerEventsMasking,
    };

    console.log(JSON.stringify(report, null, 2));
    console.log(
      `PROBE RESULT: (A) ${inputFinding}; (B) ${leakFinding}; pointer-events masking=${pointerEventsMasking ? "YES" : "NO"}`,
    );
    assert.equal(inputFinding, "WORKS", "embedded input did not remain exact and lossless");
    assert.equal(leakFinding, "CONTAINED", "embedded anchor default action escaped containment");
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
