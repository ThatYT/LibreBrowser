/** P0-AGENT browser acceptance: run the built IIFE in a plain page with a stub binding. */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "../../..");
const gatewayRequire = createRequire(resolve(workspace, "packages/gateway/package.json"));
const { default: puppeteer } = gatewayRequire("puppeteer-core");
const { AGENT_BUNDLE } = await import(resolve(workspace, "packages/agent/dist/index.js"));

async function executablePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next well-known executable.
    }
  }
  throw new Error("Chrome not found; set CHROME_PATH to run P0-AGENT acceptance");
}

function decodeChunks(chunks) {
  const partials = new Map();
  const messages = [];
  for (const chunk of chunks) {
    const match = /^M2\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|/.exec(chunk);
    assert(match, `invalid binding frame: ${chunk.slice(0, 40)}`);
    const [, docId, msgId, idxText, totalText] = match;
    const idx = Number(idxText);
    const total = Number(totalText);
    const key = `${docId}:${msgId}`;
    const slices = partials.get(key) ?? new Array(total);
    assert.equal(slices.length, total, "chunk total changed within one message");
    slices[idx] = chunk.slice(match[0].length);
    partials.set(key, slices);
    if (slices.every((slice) => slice !== undefined)) {
      const message = JSON.parse(slices.join(""));
      if (message.docId !== undefined) {
        assert.equal(message.docId, Number(docId), "frame docId differs from message docId");
      }
      messages.push(message);
      partials.delete(key);
    }
  }
  assert.equal(partials.size, 0, "acceptance read ended with incomplete chunks");
  return messages;
}

function findSerializedId(node, elementId) {
  if (node?.attributes?.id === elementId) return node.id;
  for (const child of node?.childNodes ?? []) {
    const id = findSerializedId(child, elementId);
    if (id !== undefined) return id;
  }
}

const browser = await puppeteer.launch({
  executablePath: await executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__mirror_chunks = [];
    window.__mirror_emit = (payload) => window.__mirror_chunks.push(payload);
    window.__input_events = 0;
    window.__change_events = 0;
    window.__control_events = {};
  });
  await page.evaluateOnNewDocument(AGENT_BUNDLE);
  await page.setViewport({ width: 900, height: 700 });
  await page.goto(
    `data:text/html,${encodeURIComponent(`<!doctype html>
      <html><head><title>Semantic remoting fixture</title>
      <style>
        body { font-family: sans-serif; margin: 20px; }
        #known { position: absolute; left: 40px; top: 60px; width: 180px; height: 45px; }
        #scroller { position: absolute; left: 260px; top: 60px; width: 120px; height: 80px; overflow: scroll; }
        #scroll-content { width: 400px; height: 400px; }
      </style></head><body>
      <main><h1>Remote desktop software</h1><p>A semantic mirror keeps text selectable.</p></main>
      <button id="known">Known target</button>
      <div id="scroller"><div id="scroll-content">Scrollable fixture</div></div>
      <input id="value-control" value="before">
      <input id="checked-control" type="checkbox">
      <input id="radio-first" type="radio" name="choice" value="first" checked>
      <input id="radio-second" type="radio" name="choice" value="second">
      <select id="multiple-control" multiple>
        <option value="alpha" selected>Alpha</option>
        <option value="beta">Beta</option>
        <option value="gamma">Gamma</option>
      </select>
      <script>
        document.querySelector('#value-control').addEventListener('input', () => window.__input_events++);
        document.querySelector('#value-control').addEventListener('change', () => window.__change_events++);
        for (const id of ['checked-control', 'radio-second', 'multiple-control']) {
          window.__control_events[id] = { input: 0, change: 0 };
          document.querySelector('#' + id).addEventListener('input', () => window.__control_events[id].input++);
          document.querySelector('#' + id).addEventListener('change', () => window.__control_events[id].change++);
        }
      </script>
      </body></html>`)}`,
    { waitUntil: "load" },
  );

  await page.waitForFunction(() => {
    const chunks = window.__mirror_chunks;
    return chunks.some((chunk) => chunk.includes('"kind":"hello"')) && chunks.length >= 3;
  });
  await page.evaluate(() => {
    const mutation = document.createElement("p");
    mutation.id = "late-mutation";
    mutation.textContent = "Mutation captured after the full snapshot.";
    document.querySelector("main").append(mutation);
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

  let chunks = await page.evaluate(() => [...window.__mirror_chunks]);
  let messages = decodeChunks(chunks);
  const hello = messages.find((message) => message.kind === "hello");
  assert(hello, "hello did not arrive");
  assert.equal(hello.isTop, true);
  assert(Number.isInteger(hello.docId) && hello.docId >= 0, "docId is not a uint32");
  const rrweb = messages.filter((message) => message.kind === "rrweb");
  assert(
    rrweb.some((message) => message.e.type === 2),
    "FullSnapshot did not arrive",
  );
  assert(
    rrweb.some((message) => message.e.type === 3),
    "incremental mutation did not arrive",
  );
  assert(
    rrweb.every((message) => message.docId === hello.docId),
    "rrweb docId changed",
  );

  const fullSnapshot = rrweb.find((message) => message.e.type === 2);
  const knownId = findSerializedId(fullSnapshot.e.data.node, "known");
  const scrollerId = findSerializedId(fullSnapshot.e.data.node, "scroller");
  const valueId = findSerializedId(fullSnapshot.e.data.node, "value-control");
  const checkedId = findSerializedId(fullSnapshot.e.data.node, "checked-control");
  const radioId = findSerializedId(fullSnapshot.e.data.node, "radio-second");
  const multipleId = findSerializedId(fullSnapshot.e.data.node, "multiple-control");
  assert(Number.isInteger(knownId), "known node is absent from the recorder mirror");
  assert(Number.isInteger(scrollerId), "scroller is absent from the recorder mirror");
  assert(Number.isInteger(valueId), "input is absent from the recorder mirror");
  assert(Number.isInteger(checkedId), "checkbox is absent from the recorder mirror");
  assert(Number.isInteger(radioId), "radio is absent from the recorder mirror");
  assert(Number.isInteger(multipleId), "multiple select is absent from the recorder mirror");
  assert.equal(
    await page.evaluate(
      (id) => window.__mirror_node(id) === document.querySelector("#known"),
      knownId,
    ),
    true,
    "__mirror_node did not return the recorder's actual DOM node",
  );

  let reqId = 1;
  async function command(cmd) {
    const currentReqId = reqId++;
    await page.evaluate(
      ({ commandBody, id }) => window.__mirror_cmd({ ...commandBody, reqId: id }),
      { commandBody: cmd, id: currentReqId },
    );
    await page.waitForFunction(
      (id) => window.__mirror_chunks.some((chunk) => chunk.includes(`\"reqId\":${id}`)),
      {},
      currentReqId,
    );
    chunks = await page.evaluate(() => [...window.__mirror_chunks]);
    messages = decodeChunks(chunks);
    return messages.find((message) => message.kind === "cmdres" && message.reqId === currentReqId);
  }

  const rect = await command({ cmd: "rect", nodeId: knownId });
  assert.equal(rect.ok, true);
  assert(Math.abs(rect.data.x - 40) < 1 && Math.abs(rect.data.y - 60) < 1, "rect origin is wrong");
  assert(Math.abs(rect.data.w - 180) < 1 && Math.abs(rect.data.h - 45) < 1, "rect size is wrong");
  assert.equal(rect.data.visible, true);

  assert.deepEqual((await command({ cmd: "resolve", nodeId: knownId })).data, {
    kind: "local",
  });

  assert.equal((await command({ cmd: "ping" })).data, "pong");
  assert.equal((await command({ cmd: "scroll", nodeId: scrollerId, x: 35, y: 45 })).ok, true);
  assert.deepEqual(
    await page.evaluate(() => {
      const node = document.querySelector("#scroller");
      return [node.scrollLeft, node.scrollTop];
    }),
    [35, 45],
  );
  assert.equal((await command({ cmd: "value", nodeId: valueId, value: "after" })).ok, true);
  assert.deepEqual(
    await page.evaluate(() => [
      document.querySelector("#value-control").value,
      window.__input_events,
      window.__change_events,
    ]),
    ["after", 1, 1],
  );
  assert.equal(
    (await command({ cmd: "value", nodeId: checkedId, value: "on", checked: true })).ok,
    true,
  );
  assert.equal(
    (await command({ cmd: "value", nodeId: radioId, value: "second", checked: true })).ok,
    true,
  );
  assert.equal(
    (
      await command({
        cmd: "value",
        nodeId: multipleId,
        value: "beta",
        values: ["beta", "gamma"],
      })
    ).ok,
    true,
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      checked: document.querySelector("#checked-control").checked,
      radioFirst: document.querySelector("#radio-first").checked,
      radioSecond: document.querySelector("#radio-second").checked,
      selected: Array.from(
        document.querySelector("#multiple-control").selectedOptions,
        (option) => option.value,
      ),
      events: window.__control_events,
    })),
    {
      checked: true,
      radioFirst: false,
      radioSecond: true,
      selected: ["beta", "gamma"],
      events: {
        "checked-control": { input: 1, change: 1 },
        "radio-second": { input: 1, change: 1 },
        "multiple-control": { input: 1, change: 1 },
      },
    },
  );

  const snapshotCount = messages.filter(
    (message) => message.kind === "rrweb" && message.e.type === 2,
  ).length;
  assert.equal((await command({ cmd: "snapshot" })).ok, true);
  chunks = await page.evaluate(() => [...window.__mirror_chunks]);
  messages = decodeChunks(chunks);
  assert.equal(
    messages.filter((message) => message.kind === "rrweb" && message.e.type === 2).length,
    snapshotCount + 1,
    "snapshot command did not emit a FullSnapshot",
  );

  await page.evaluate(() => {
    window.__mirror_node_before_reinject = window.__mirror_node;
  });
  await page.evaluate((bundle) => globalThis.eval(bundle), AGENT_BUNDLE);
  assert.equal(
    await page.evaluate(() => window.__mirror_node === window.__mirror_node_before_reinject),
    true,
    "double injection replaced the guarded __mirror_node helper",
  );
  chunks = await page.evaluate(() => [...window.__mirror_chunks]);
  messages = decodeChunks(chunks);
  assert.equal(
    messages.filter((message) => message.kind === "hello").length,
    1,
    "double injection bypassed the idempotence guard",
  );

  const childHostPage = await browser.newPage();
  const encodedChildBundle = Buffer.from(AGENT_BUNDLE).toString("base64");
  const childUrl = `data:text/html,${encodeURIComponent(`<!doctype html>
    <p>child recorder</p>
    <script>window.__mirror_chunks = []; window.__mirror_emit = (payload) => window.__mirror_chunks.push(payload);</script>
    <script>globalThis.eval(atob("${encodedChildBundle}"));</script>`)}`;
  await childHostPage.setContent('<!doctype html><iframe name="agent-child"></iframe>');
  await childHostPage.evaluate((src) => {
    document.querySelector("iframe").src = src;
  }, childUrl);
  await childHostPage.waitForFunction(() => {
    const frame = document.querySelector("iframe");
    return frame?.contentWindow !== undefined;
  });
  const childFrame = await new Promise((resolveFrame, rejectFrame) => {
    const timeout = setTimeout(() => rejectFrame(new Error("child frame was not created")), 5_000);
    const poll = () => {
      const frame = childHostPage.frames().find((candidate) => candidate.name() === "agent-child");
      if (frame?.url().startsWith("data:text/html")) {
        clearTimeout(timeout);
        resolveFrame(frame);
      } else {
        setTimeout(poll, 20);
      }
    };
    poll();
  });
  await childFrame.waitForFunction(() => window.__mirror_chunks?.length > 0);
  const childChunks = await childFrame.evaluate(() => [...window.__mirror_chunks]);
  const childMessages = decodeChunks(childChunks);
  assert.equal(childMessages.filter((message) => message.kind === "hello").length, 1);
  assert.equal(childMessages.find((message) => message.kind === "hello").isTop, false);
  assert.equal(
    childMessages.filter((message) => message.kind === "rrweb").length,
    0,
    "child-frame agent leaked a second canonical rrweb stream",
  );
  await childHostPage.close();

  await page.evaluate(() => document.querySelector("#known").remove());
  assert.equal((await command({ cmd: "rect", nodeId: knownId })).ok, false);

  const lateBindingPage = await browser.newPage();
  await lateBindingPage.evaluateOnNewDocument(AGENT_BUNDLE);
  await lateBindingPage.goto("data:text/html,<h1>Late binding</h1>", { waitUntil: "load" });
  await lateBindingPage.evaluate(() => {
    window.__mirror_chunks = [];
    window.__mirror_emit = (payload) => window.__mirror_chunks.push(payload);
  });
  await lateBindingPage.waitForFunction(() => window.__mirror_chunks.length >= 3);
  const lateMessages = decodeChunks(
    await lateBindingPage.evaluate(() => [...window.__mirror_chunks]),
  );
  assert(lateMessages.some((message) => message.kind === "hello"));
  assert(lateMessages.some((message) => message.kind === "rrweb" && message.e.type === 2));
  await lateBindingPage.close();

  if (process.argv.includes("--write-fixture")) {
    const fixtureMessages = messages.filter(
      (message) => message.kind === "hello" || message.kind === "rrweb",
    );
    const fixturePath = resolve(workspace, "packages/viewer/fixtures/wikipedia.agentmsgs.json");
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, `${JSON.stringify(fixtureMessages, null, 2)}\n`);
    console.log(`P0-AGENT fixture: ${fixturePath} (${fixtureMessages.length} messages)`);
  }

  console.log(
    `P0-AGENT acceptance: ${messages.length} top messages; hello, snapshot, mutation, commands, guard, child suppression, and late binding all pass`,
  );
} finally {
  await browser.close();
}
