/**
 * Live acceptance for P1-VIEWPORT-G with Chromium, the real agent, TabHub, and InputRelay.
 *
 * Run from the repository root:
 *   pnpm -F @mirror/gateway exec tsx src/hub/viewport.accept.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Down } from "@mirror/protocol";

import { createAgentLink } from "../browser/agentlink";
import { launchBrowser } from "../browser/launch";
import { createInputRelay } from "../input/relay";
import type { CdpSend, TargetRef } from "../types";
import { TabHub } from "./tabhub";
import { createViewportAgreement } from "./viewport";

const TIMEOUT_MS = 20_000;

function fixtureServer(): Server {
  return createServer((_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <title>Viewport acceptance</title>
      <button id="target" style="position:absolute;left:80px;top:70px;width:140px;height:50px">
        trusted target
      </button>
      <script>
        window.__clicks = 0;
        document.getElementById('target').addEventListener('click', () => window.__clicks++);
        document.body.dataset.ready = 'yes';
      </script>`);
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

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function evaluate<T>(send: CdpSend, target: TargetRef, expression: string): Promise<T> {
  const response = (await send(target.sessionId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })) as { result?: { value?: T }; exceptionDetails?: unknown };
  assert.equal(response.exceptionDetails, undefined, `evaluation failed: ${expression}`);
  return response.result?.value as T;
}

function nodeId(snapshot: Extract<Down, { t: "snapshot" }>, domId: string): number {
  let found: number | undefined;
  const visit = (value: unknown, seen = new Set<object>()): void => {
    if (found !== undefined || typeof value !== "object" || value === null || seen.has(value))
      return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (
      typeof record.id === "number" &&
      typeof record.attributes === "object" &&
      record.attributes !== null &&
      (record.attributes as Record<string, unknown>).id === domId
    ) {
      found = record.id;
      return;
    }
    for (const child of Object.values(record)) visit(child, seen);
  };
  visit(snapshot.data);
  if (found === undefined) throw new Error(`${domId} missing from viewport snapshot`);
  return found;
}

async function main(): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "mirror-p1-viewport-"));
  const server = fixtureServer();
  const port = await listen(server);
  const browser = await launchBrowser({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headful: false,
    userDataDir: profile,
  });
  const link = createAgentLink(browser);
  const targets = new Map<string, TargetRef>();
  let stopping = false;

  try {
    browser.onAttached((target) => targets.set(target.targetId, target));
    await waitFor("page target", () =>
      [...targets.values()].some((target) => target.type === "page"),
    );
    const page = [...targets.values()].find((target) => target.type === "page");
    assert(page);
    const hub = new TabHub({ sessionId: "accept", tabId: page.targetId });
    const agreement = createViewportAgreement({
      send: browser.send,
      sessionFor: (tabId) => (tabId === page.targetId ? page.sessionId : undefined),
      hubFor: (tabId) => (tabId === page.targetId ? hub : undefined),
      isDriver: (viewerId) => viewerId === "driver",
      debounceMs: 30,
    });
    const snapshots: Extract<Down, { t: "snapshot" }>[] = [];
    hub.onNeedSnapshot(() => link.sendCmd(page.targetId, { cmd: "snapshot" }));
    void (async () => {
      try {
        for await (const msg of link.msgs(page.targetId)) {
          for (const down of hub.ingest(msg)) {
            if (down.t !== "snapshot") continue;
            agreement.noteSnapshot(down);
            snapshots.push(down);
          }
        }
      } catch (error) {
        if (!stopping) throw error;
      }
    })();

    await browser.send(page.sessionId, "Page.navigate", { url: `http://127.0.0.1:${port}/` });
    await waitFor("fixture and navigation snapshot", async () => {
      const ready = await evaluate<boolean>(
        browser.send,
        page,
        "document.body?.dataset.ready === 'yes'",
      );
      return ready && snapshots.some((snapshot) => snapshot.reason === "nav");
    });
    let currentNodeId = nodeId(snapshots.at(-1)!, "target");
    const relay = createInputRelay({
      agentLink: link,
      send: browser.send,
      sessionFor: (tabId) => (tabId === page.targetId ? page.sessionId : undefined),
      isDriver: (viewerId) => viewerId === "driver",
      allowsInput: (viewerId, tabId) => agreement.gate.allowsInput(viewerId, tabId),
      noteInput: () => hub.noteInput(),
      viewportFor: (tabId) => agreement.viewportFor(tabId),
    });
    const pointer = (kind: "down" | "up") => ({
      t: "ptr" as const,
      tab: page.targetId,
      kind,
      nodeId: currentNodeId,
      rx: 0.5,
      ry: 0.5,
      vx: 1,
      vy: 1,
      button: 0 as const,
      buttons: kind === "down" ? 1 : 0,
      mods: 0,
    });
    const click = () =>
      Promise.all([relay("driver", pointer("down")), relay("driver", pointer("up"))]);

    const firstEpoch = hub.epoch;
    assert.equal(
      agreement.handle("driver", { t: "view", tab: page.targetId, w: 640, h: 480, dpr: 1 }),
      true,
    );
    assert.deepEqual(await click(), [false, false], "input was not dropped during resize debounce");
    await waitFor("640x480 viewport snapshot", () =>
      snapshots.some(
        (snapshot) =>
          snapshot.reason === "viewport" && snapshot.epoch > firstEpoch && hub.viewport?.w === 640,
      ),
    );
    let viewportSnapshot = snapshots.filter((snapshot) => snapshot.reason === "viewport").at(-1)!;
    currentNodeId = nodeId(viewportSnapshot, "target");
    assert.equal(agreement.gate.allowsInput("driver", page.targetId), false);
    assert.equal(
      agreement.handle("driver", {
        t: "view-ack",
        tab: page.targetId,
        epoch: viewportSnapshot.epoch,
      }),
      true,
    );
    assert.deepEqual(await click(), [true, true]);
    assert.equal(await evaluate<number>(browser.send, page, "window.__clicks"), 1);

    const secondEpoch = hub.epoch;
    agreement.handle("driver", { t: "view", tab: page.targetId, w: 800, h: 600, dpr: 1.5 });
    assert.deepEqual(await click(), [false, false], "input was not dropped during second resize");
    await waitFor("800x600 viewport snapshot", () =>
      snapshots.some(
        (snapshot) =>
          snapshot.reason === "viewport" && snapshot.epoch > secondEpoch && hub.viewport?.w === 800,
      ),
    );
    viewportSnapshot = snapshots.filter((snapshot) => snapshot.reason === "viewport").at(-1)!;
    currentNodeId = nodeId(viewportSnapshot, "target");
    assert.deepEqual(
      await evaluate(
        browser.send,
        page,
        "({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})",
      ),
      { w: 800, h: 600, dpr: 1.5 },
    );
    agreement.handle("driver", {
      t: "view-ack",
      tab: page.targetId,
      epoch: viewportSnapshot.epoch,
    });
    assert.deepEqual(await click(), [true, true]);
    assert.equal(await evaluate<number>(browser.send, page, "window.__clicks"), 2);

    const epochBeforeFollower = hub.epoch;
    assert.equal(
      agreement.handle("follower", { t: "view", tab: page.targetId, w: 300, h: 200, dpr: 1 }),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(hub.epoch, epochBeforeFollower);
    assert.deepEqual(hub.viewport, { w: 800, h: 600, dpr: 1.5 });
    agreement.dispose();

    console.log(
      `P1-VIEWPORT-G accept: 640x480 -> 800x600@1.5, viewport epochs ${firstEpoch}->${hub.epoch}, transition clicks dropped, post-ack clicks=2, follower view ignored`,
    );
  } finally {
    stopping = true;
    await browser.close();
    await closeServer(server);
    await rm(profile, { force: true, recursive: true });
  }
}

await main();
