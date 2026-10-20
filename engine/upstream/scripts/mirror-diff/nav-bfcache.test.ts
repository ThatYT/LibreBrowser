import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Down } from "@mirror/protocol";

import { createAgentLink } from "../../packages/gateway/src/browser/agentlink";
import { launchBrowser } from "../../packages/gateway/src/browser/launch";
import { createTabLifecycle } from "../../packages/gateway/src/session/tabs";
import type { TargetRef } from "../../packages/gateway/src/types";

const TIMEOUT_MS = 20_000;

interface DocumentState {
  docId: number;
  epoch: number;
}

async function waitFor<T>(description: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function fixtureServer(): Server {
  return createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
    // Intentionally omit cache-prevention headers: both documents should be bfcache-eligible.
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
      <title>${requestUrl.hostname}${requestUrl.pathname}</title>
      <main data-origin="${requestUrl.hostname}" data-path="${requestUrl.pathname}">
        ${requestUrl.hostname}${requestUrl.pathname}
      </main>`);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
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

test(
  "history back/forward across origins publishes fresh document snapshots",
  { timeout: 30_000 },
  async () => {
    const chromePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
    await access(chromePath);
    const profile = await mkdtemp(join(tmpdir(), "mirror-nav-bfcache-"));
    const server = fixtureServer();
    const port = await listen(server);
    const browser = await launchBrowser({
      args: ["--disable-dev-shm-usage", "--no-proxy-server"],
      executablePath: chromePath,
      headful: false,
      userDataDir: profile,
    });
    const agentLink = createAgentLink(browser);
    const published: Down[] = [];
    const errors: unknown[] = [];
    const lifecycle = createTabLifecycle({
      browser,
      agentLink,
      sessionId: "nav-bfcache-test",
      assetTokenKey: randomBytes(32),
      debounceMs: 0,
      publish: (message) => published.push(message),
      onError: (error) => errors.push(error),
    });
    const targets = new Map<string, TargetRef>();
    browser.onAttached((target) => targets.set(target.targetId, target));

    try {
      const tabId = await waitFor("initial tab", () => lifecycle.activeTabId);
      const target = await waitFor("initial page target", () => targets.get(tabId));

      const currentState = async (after?: DocumentState): Promise<DocumentState> =>
        waitFor("fresh snapshot epoch", () => {
          const hub = lifecycle.hubFor(tabId);
          if (hub === undefined || hub.docId === 0 || hub.epoch === 0) return undefined;
          if (after !== undefined && (hub.docId === after.docId || hub.epoch <= after.epoch)) {
            return undefined;
          }
          const snapshotPublished = published.some(
            (message) =>
              message.t === "snapshot" && message.tab === tabId && message.epoch === hub.epoch,
          );
          return snapshotPublished ? { docId: hub.docId, epoch: hub.epoch } : undefined;
        });
      const documentUrl = async (): Promise<unknown> => {
        const evaluated = (await browser.send(target.sessionId, "Runtime.evaluate", {
          expression: "location.href",
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        return evaluated.result?.value;
      };

      let state = await currentState();
      // Distinct loopback hosts provide a deterministic, offline cross-origin boundary.
      const firstUrl = `http://127.0.0.1:${port}/first`;
      const secondUrl = `http://127.0.0.2:${port}/second`;

      await browser.send(target.sessionId, "Page.navigate", { url: firstUrl });
      state = await currentState(state);
      const firstState = state;
      assert.equal(await documentUrl(), firstUrl);

      await browser.send(target.sessionId, "Page.navigate", { url: secondUrl });
      state = await currentState(state);
      const secondState = state;
      assert.equal(await documentUrl(), secondUrl);

      const history = (await browser.send(target.sessionId, "Page.getNavigationHistory")) as {
        entries?: Array<{ id: number; url: string }>;
      };
      const firstEntry = history.entries?.find((entry) => entry.url === firstUrl);
      const secondEntry = history.entries?.find((entry) => entry.url === secondUrl);
      assert(firstEntry, `history omitted ${firstUrl}`);
      assert(secondEntry, `history omitted ${secondUrl}`);

      await browser.send(target.sessionId, "Page.navigateToHistoryEntry", {
        entryId: firstEntry.id,
      });
      state = await currentState(state);
      const backState = state;
      assert.equal(await documentUrl(), firstUrl);

      await browser.send(target.sessionId, "Page.navigateToHistoryEntry", {
        entryId: secondEntry.id,
      });
      const forwardState = await currentState(state);
      assert.equal(await documentUrl(), secondUrl);

      assert.equal(
        new Set([firstState.docId, secondState.docId, backState.docId, forwardState.docId]).size,
        4,
      );
      assert(backState.epoch > secondState.epoch, "back did not publish a bumped snapshot epoch");
      assert(
        forwardState.epoch > backState.epoch,
        "forward did not publish a bumped snapshot epoch",
      );
      assert.deepEqual(errors, []);
    } finally {
      lifecycle.dispose();
      await browser.close();
      await closeServer(server);
      await rm(profile, { force: true, recursive: true });
    }
  },
);
