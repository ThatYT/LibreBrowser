/**
 * Live acceptance for P1-NAV-G.
 *
 * Run from the repository root:
 *   pnpm -F @mirror/gateway exec tsx src/browser/nav.accept.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TargetRef } from "../types";
import { createAgentLink } from "./agentlink";
import { launchBrowser } from "./launch";
import { createNavigationController, type ChromeMsg } from "./nav";

const TIMEOUT_MS = 20_000;

async function waitFor<T>(description: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function startXvfb(): Promise<ChildProcess | undefined> {
  if (process.env.DISPLAY) return undefined;
  const displayNumber = 900 + (process.pid % 90);
  const display = `:${displayNumber}`;
  const child = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
    stdio: "ignore",
  });
  const socket = `/tmp/.X11-unix/X${displayNumber}`;
  await waitFor("Xvfb display", () =>
    access(socket).then(
      () => true,
      () => undefined,
    ),
  );
  process.env.DISPLAY = display;
  return child;
}

function fixtureServer(): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    response.setHeader("Cache-Control", "no-store");
    if (path === "/redirect") {
      response.writeHead(302, { Location: "/landing" });
      response.end();
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html>
      <title>Navigation fixture</title>
      <main data-path="${path}">${path}</main>
      <script>window.__documentToken = crypto.randomUUID()</script>`);
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

async function evaluate(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  target: TargetRef,
  expression: string,
) {
  const result = (await browser.send(target.sessionId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  return result.result?.value;
}

function nextChrome(
  messages: ChromeMsg[],
  after: number,
  predicate: (message: ChromeMsg) => boolean,
): ChromeMsg | undefined {
  return messages.slice(after).find(predicate);
}

async function main(): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "mirror-p1-nav-"));
  const xvfb = await startXvfb();
  const server = fixtureServer();
  const port = await listen(server);
  const browser = await launchBrowser({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headful: true,
    userDataDir: profile,
  });
  const messages: ChromeMsg[] = [];
  const navigation = createNavigationController(browser, (message) => messages.push(message));
  // Exercise the real attach sequence and resume the initially paused page target.
  createAgentLink(browser);
  const targets = new Map<string, TargetRef>();

  try {
    browser.onAttached((target) => targets.set(target.targetId, target));
    const page = await waitFor("initial page", () =>
      [...targets.values()].find((target) => target.type === "page"),
    );
    const landingUrl = `http://127.0.0.1:${port}/landing`;
    const spaUrl = `http://127.0.0.1:${port}/spa`;
    const initial = await waitFor("initial chrome state", () =>
      messages.find((message) => message.tab === page.targetId && !message.loading),
    );

    let cursor = messages.length;
    await navigation.handle({
      t: "nav",
      tab: page.targetId,
      action: "go",
      url: `http://127.0.0.1:${port}/redirect`,
    });
    const redirected = await waitFor("redirected URL and completed load", () =>
      nextChrome(
        messages,
        cursor,
        (message) => message.url === landingUrl && !message.loading && !message.canFwd,
      ),
    );
    assert.equal(redirected.canBack, true);

    const documentToken = await evaluate(browser, page, "window.__documentToken");
    cursor = messages.length;
    await evaluate(browser, page, "history.pushState({}, '', '/spa')");
    const pushed = await waitFor("SPA pushState chrome update", () =>
      nextChrome(
        messages,
        cursor,
        (message) => message.url === spaUrl && message.canBack && !message.canFwd,
      ),
    );
    assert.equal(pushed.loading, false, "pushState incorrectly started a document load");
    assert.equal(
      await evaluate(browser, page, "window.__documentToken"),
      documentToken,
      "pushState replaced the document",
    );

    cursor = messages.length;
    await navigation.handle({ t: "nav", tab: page.targetId, action: "back" });
    const backed = await waitFor("back navigation history state", () =>
      nextChrome(
        messages,
        cursor,
        (message) => message.url === landingUrl && message.canBack && message.canFwd,
      ),
    );
    assert.equal(backed.loading, false);

    cursor = messages.length;
    await navigation.handle({ t: "nav", tab: page.targetId, action: "back" });
    await waitFor("disabled back boundary", () =>
      nextChrome(
        messages,
        cursor,
        (message) => message.url === initial.url && !message.canBack && message.canFwd,
      ),
    );

    cursor = messages.length;
    await navigation.handle({ t: "nav", tab: page.targetId, action: "fwd" });
    await waitFor("middle forward history state", () =>
      nextChrome(
        messages,
        cursor,
        (message) => message.url === landingUrl && message.canBack && message.canFwd,
      ),
    );

    cursor = messages.length;
    await navigation.handle({ t: "nav", tab: page.targetId, action: "fwd" });
    await waitFor("forward navigation history state", () =>
      nextChrome(
        messages,
        cursor,
        (message) => message.url === spaUrl && message.canBack && !message.canFwd,
      ),
    );

    const previousTimeOrigin = await evaluate(browser, page, "performance.timeOrigin");
    cursor = messages.length;
    await navigation.handle({ t: "nav", tab: page.targetId, action: "reload" });
    await waitFor("reload completion", () =>
      nextChrome(messages, cursor, (message) => message.url === spaUrl && !message.loading),
    );
    assert.notEqual(
      await evaluate(browser, page, "performance.timeOrigin"),
      previousTimeOrigin,
      "Page.reload did not replace the document",
    );

    console.log(
      "P1-NAV-G accept: redirect + SPA URL chrome green; back/fwd boundaries green; reload green",
    );
  } finally {
    navigation.dispose();
    await browser.close();
    await closeServer(server);
    xvfb?.kill("SIGTERM");
    await rm(profile, { force: true, recursive: true });
  }
}

await main();
