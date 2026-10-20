/**
 * Live acceptance for P1-INPUT-RELAY under real React mutation churn.
 *
 * Run from the repository root:
 *   pnpm -F @mirror/gateway exec tsx src/input/relay.accept.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventType, Mod, type AgentCmdInput, type AgentMsg } from "@mirror/protocol";

import { createAgentLink } from "../browser/agentlink";
import { launchBrowser } from "../browser/launch";
import type { AgentLink, CdpSend, TargetRef } from "../types";
import { createInputRelay } from "./relay";

const TIMEOUT_MS = 20_000;
const VIEWPORT = { w: 900, h: 700 };
const REQUIRED_IDS = [
  "churn-button",
  "form-input",
  "form-select",
  "controlled-checkbox",
  "next-focus",
  "hover-target",
  "wheel-target",
  "scroller",
];

interface PageState {
  clicks: number;
  decoyClicks: number;
  downs: number;
  hover: number;
  wheels: number;
  value: string;
  keys: string[];
  inputs: number;
  keypresses: number;
  choice: string;
  changes: number;
  checked: boolean;
  checkboxChanges: number;
  active: string;
  scrollTop: number;
}

async function fetchScript(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

function fixtureServer(react: string, reactDom: string): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    response.setHeader("Cache-Control", "no-store");
    if (path === "/react.js" || path === "/react-dom.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(path === "/react.js" ? react : reactDom);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <title>Input relay acceptance</title>
      <style>
        body { margin: 0; }
        #root { position: relative; width: 900px; height: 700px; }
        button, input, div { box-sizing: border-box; }
      </style>
      <div id="root"></div>
      <script src="/react.js"></script>
      <script src="/react-dom.js"></script>
      <script>
        window.__state = {
          clicks: 0, decoyClicks: 0, downs: 0, hover: 0, wheels: 0,
          value: '', keys: [], inputs: 0, keypresses: 0, choice: 'first', changes: 0,
          checked: false, checkboxChanges: 0,
        };
        const e = React.createElement;
        function App() {
          const [left, setLeft] = React.useState(40);
          const [value, setValue] = React.useState('');
          const [choice, setChoice] = React.useState('first');
          const [checked, setChecked] = React.useState(false);
          const [hovered, setHovered] = React.useState(false);
          return e(React.Fragment, null,
            e('button', {
              id: 'churn-button',
              style: { position: 'absolute', left, top: 40, width: 120, height: 40 },
              onMouseDown: () => { window.__state.downs++; setLeft(340); },
              onClick: () => { window.__state.clicks++; },
            }, 'React target'),
            e('button', {
              id: 'decoy',
              style: { position: 'absolute', left: 700, top: 40, width: 120, height: 40 },
              onClick: () => { window.__state.decoyClicks++; },
            }, 'Raw-coordinate decoy'),
            e('input', {
              id: 'form-input', value,
              style: { position: 'absolute', left: 40, top: 140, width: 240, height: 36 },
              onChange: event => { setValue(event.currentTarget.value); window.__state.value = event.currentTarget.value; },
              onInput: () => { window.__state.inputs++; },
              onKeyDown: event => { window.__state.keys.push('down:' + event.key); },
              onKeyUp: event => { window.__state.keys.push('up:' + event.key); },
              onKeyPress: event => { window.__state.keypresses++; window.__state.keys.push('press:' + event.key); },
            }),
            e('button', {
              id: 'next-focus',
              style: { position: 'absolute', left: 300, top: 140, width: 120, height: 36 },
            }, 'Tab target'),
            e('select', {
              id: 'form-select', value: choice,
              style: { position: 'absolute', left: 440, top: 140, width: 160, height: 36 },
              onChange: event => {
                setChoice(event.currentTarget.value);
                window.__state.choice = event.currentTarget.value;
                window.__state.changes++;
              },
            },
              e('option', { value: 'first' }, 'First'),
              e('option', { value: 'second' }, 'Second'),
            ),
            e('input', {
              id: 'controlled-checkbox', type: 'checkbox', checked,
              onChange: event => {
                setChecked(event.currentTarget.checked);
                window.__state.checked = event.currentTarget.checked;
                window.__state.checkboxChanges++;
              },
            }),
            e('div', {
              id: 'hover-target',
              style: { position: 'absolute', left: 40, top: 220, width: 160, height: 50, background: '#ddd' },
              onMouseEnter: () => { window.__state.hover++; setHovered(true); },
            }, hovered ? 'hover-open' : 'hover-closed'),
            e('div', {
              id: 'wheel-target',
              style: { position: 'absolute', left: 40, top: 290, width: 160, height: 50, background: '#ccc' },
              onWheel: event => { event.preventDefault(); window.__state.wheels++; },
            }, 'wheel island'),
            e('div', {
              id: 'scroller',
              style: { position: 'absolute', left: 240, top: 220, width: 180, height: 100, overflow: 'auto' },
            }, e('div', { style: { height: 500 } }, 'scroll content')),
          );
        }
        ReactDOM.createRoot(document.getElementById('root')).render(e(App));
        requestAnimationFrame(() => { document.body.dataset.ready = 'yes'; });
      </script>`);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function collectNodeIds(value: unknown, ids: Map<string, number>, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  const attributes = record.attributes;
  if (typeof record.id === "number" && typeof attributes === "object" && attributes !== null) {
    const domId = (attributes as Record<string, unknown>).id;
    if (typeof domId === "string" && REQUIRED_IDS.includes(domId)) ids.set(domId, record.id);
  }
  for (const child of Object.values(record)) collectNodeIds(child, ids, seen);
}

async function snapshotNodeIds(
  iterator: AsyncIterator<AgentMsg>,
  link: AgentLink,
  tabId: string,
): Promise<Map<string, number>> {
  const request = link.sendCmd(tabId, { cmd: "snapshot" });
  const ids = new Map<string, number>();
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline && ids.size < REQUIRED_IDS.length) {
    const remaining = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("snapshot event timeout")), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    assert(!result.done, "target detached during snapshot");
    if (result.value.kind !== "rrweb") continue;
    if (result.value.e.type === EventType.FullSnapshot) collectNodeIds(result.value.e, ids);
  }
  assert.equal((await request).ok, true, "agent snapshot command failed");
  assert.deepEqual([...ids.keys()].sort(), [...REQUIRED_IDS].sort());
  return ids;
}

async function waitForAgentHello(iterator: AsyncIterator<AgentMsg>): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("agent hello timeout")), deadline - Date.now());
      }),
    ]).finally(() => clearTimeout(timer));
    assert(!result.done, "target detached before agent hello");
    if (result.value.kind === "hello") return;
  }
  throw new Error("Timed out waiting for agent hello");
}

async function evaluate<T>(send: CdpSend, target: TargetRef, expression: string): Promise<T> {
  const response = (await send(target.sessionId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })) as { result?: { value?: T }; exceptionDetails?: unknown };
  assert.equal(response.exceptionDetails, undefined, `evaluation failed: ${expression}`);
  return response.result?.value as T;
}

async function main(): Promise<void> {
  const [react, reactDom] = await Promise.all([
    fetchScript("https://unpkg.com/react@18.3.1/umd/react.production.min.js"),
    fetchScript("https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"),
  ]);
  const profile = await mkdtemp(join(tmpdir(), "mirror-p1-input-"));
  const server = fixtureServer(react, reactDom);
  const port = await listen(server);
  const browser = await launchBrowser({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headful: false,
    userDataDir: profile,
  });
  const baseLink = createAgentLink(browser);
  const targets = new Map<string, TargetRef>();

  try {
    browser.onAttached((target) => targets.set(target.targetId, target));
    await waitFor("page target", () =>
      [...targets.values()].some((target) => target.type === "page"),
    );
    const page = [...targets.values()].find((target) => target.type === "page");
    assert(page);
    const iterator = baseLink.msgs(page.targetId)[Symbol.asyncIterator]();
    await browser.send(page.sessionId, "Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.w,
      height: VIEWPORT.h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.send(page.sessionId, "Page.navigate", { url: `http://127.0.0.1:${port}/` });
    await waitFor("React fixture", async () =>
      evaluate(browser.send, page, "document.body?.dataset.ready === 'yes'"),
    );
    await waitForAgentHello(iterator);
    const ids = await snapshotNodeIds(iterator, baseLink, page.targetId);

    const rectXs: number[] = [];
    const trackedLink: AgentLink = {
      msgs: (tabId) => baseLink.msgs(tabId),
      async sendCmd(tabId: string, command: AgentCmdInput) {
        const response = await baseLink.sendCmd(tabId, command);
        if (command.cmd === "rect" && response.ok) {
          const x = (response.data as { x?: unknown } | undefined)?.x;
          if (typeof x === "number") rectXs.push(x);
        }
        return response;
      },
    };
    let acceptedInputs = 0;
    const relay = createInputRelay({
      agentLink: trackedLink,
      send: browser.send,
      sessionFor: (tabId) => (tabId === page.targetId ? page.sessionId : undefined),
      isDriver: (viewerId) => viewerId === "driver",
      allowsInput: () => true,
      noteInput: () => acceptedInputs++,
      viewportFor: () => VIEWPORT,
    });
    const ptr = (id: string, kind: "move" | "down" | "up" | "wheel") => ({
      t: "ptr" as const,
      tab: page.targetId,
      kind,
      nodeId: ids.get(id)!,
      rx: 0.5,
      ry: 0.5,
      // These raw coordinates hit the decoy, proving semantic rect resolution did the work.
      vx: 760,
      vy: 60,
      button: 0 as const,
      buttons: kind === "down" ? 1 : 0,
      mods: 0,
      dx: 0,
      dy: 35,
    });
    const click = (viewerId: string, id: string) =>
      Promise.all([relay(viewerId, ptr(id, "down")), relay(viewerId, ptr(id, "up"))]);
    const key = async (keyValue: string, code: string, mods = 0) => {
      assert.equal(
        await relay("driver", {
          t: "key",
          tab: page.targetId,
          kind: "down",
          key: keyValue,
          code,
          mods,
        }),
        true,
      );
      assert.equal(
        await relay("driver", {
          t: "key",
          tab: page.targetId,
          kind: "up",
          key: keyValue,
          code,
          mods,
        }),
        true,
      );
    };

    assert.deepEqual(await click("driver", "churn-button"), [true, true]);
    const clickState = await evaluate<PageState>(browser.send, page, "window.__state");
    assert.equal(clickState.clicks, 1, "React onClick did not fire");
    assert.equal(clickState.decoyClicks, 0, "raw-coordinate decoy received the semantic click");
    assert.equal(clickState.downs, 1, "React onMouseDown did not mutate layout");
    assert(Math.abs(rectXs[0]! - 40) < 2, `down rect was ${rectXs[0]}`);
    assert(Math.abs(rectXs[1]! - 340) < 2, `up rect was not independently resolved: ${rectXs[1]}`);

    assert.deepEqual(await click("driver", "form-input"), [true, true]);
    await key("a", "KeyA");
    await key("A", "KeyA", Mod.Shift);
    await key("1", "Digit1");
    await key("!", "Digit1", Mod.Shift);
    assert.equal(await relay("driver", { t: "text", tab: page.targetId, insert: "PASTE" }), true);
    await key("ArrowLeft", "ArrowLeft");
    await key("Enter", "Enter");
    await key("Tab", "Tab");

    assert.equal(await relay("driver", ptr("hover-target", "move")), true);
    assert.equal(await relay("driver", ptr("wheel-target", "wheel")), true);
    assert.equal(
      await relay("driver", {
        t: "scroll",
        tab: page.targetId,
        nodeId: ids.get("scroller")!,
        x: 0,
        y: 120,
      }),
      true,
    );
    assert.equal(
      await relay("driver", {
        t: "value",
        tab: page.targetId,
        nodeId: ids.get("controlled-checkbox")!,
        value: "on",
        checked: true,
      }),
      true,
    );
    assert.equal(
      await relay("driver", {
        t: "value",
        tab: page.targetId,
        nodeId: ids.get("form-select")!,
        value: "second",
      }),
      true,
    );
    await waitFor("page-side input observations", async () => {
      const state = await evaluate<PageState>(
        browser.send,
        page,
        `({
        ...window.__state,
        active: document.activeElement && document.activeElement.id,
        scrollTop: document.getElementById('scroller').scrollTop,
      })`,
      );
      return (
        state.value === "aA1!PASTE" &&
        state.choice === "second" &&
        state.changes === 1 &&
        state.checked === true &&
        state.checkboxChanges === 1 &&
        state.hover === 1 &&
        state.wheels === 1 &&
        state.scrollTop === 120
      );
    });
    const state = await evaluate<PageState>(
      browser.send,
      page,
      `({
      ...window.__state,
      active: document.activeElement && document.activeElement.id,
      scrollTop: document.getElementById('scroller').scrollTop,
    })`,
    );
    assert(state.inputs >= 5, `page observed only ${state.inputs} input events`);
    assert(state.keypresses >= 5, `page observed only ${state.keypresses} keypress events`);
    for (const observed of ["down:ArrowLeft", "down:Enter", "down:Tab"]) {
      assert(state.keys.includes(observed), `page missed ${observed}`);
    }
    assert.equal(state.active, "next-focus", "Tab did not move authoritative focus");

    const rectCountBeforeFollower = rectXs.length;
    assert.deepEqual(await click("follower", "churn-button"), [false, false]);
    assert.equal(rectXs.length, rectCountBeforeFollower, "follower input reached rect resolution");
    assert.equal((await evaluate<PageState>(browser.send, page, "window.__state")).clicks, 1);

    console.log(
      `P1-INPUT-RELAY/F2 accept: React onClick under 40px->340px mutation, ${state.value.length} typed/pasted chars, select and controlled checkbox changes observed once, keydown/keypress/input observed, hover+wheel+scroll live, follower dropped; accepted=${acceptedInputs}`,
    );
  } finally {
    await browser.close();
    await closeServer(server);
    await rm(profile, { force: true, recursive: true });
  }
}

await main();
