/** P2-SHADOW acceptance: closed roots and constructed styles flow through the built IIFE. */
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
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
  throw new Error("Chrome not found; set CHROME_PATH to run P2-SHADOW acceptance");
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
      messages.push(JSON.parse(slices.join("")));
      partials.delete(key);
    }
  }
  assert.equal(partials.size, 0, "acceptance read ended with incomplete chunks");
  return messages;
}

function findSerializedNode(node, elementId) {
  if (node?.attributes?.id === elementId) return node;
  for (const child of node?.childNodes ?? []) {
    const match = findSerializedNode(child, elementId);
    if (match !== undefined) return match;
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
  });
  await page.evaluateOnNewDocument(AGENT_BUNDLE);
  await page.goto(
    `data:text/html,${encodeURIComponent(`<!doctype html>
      <html><body>
      <div id="closed-host"></div>
      <div id="open-host"></div>
      <script>
        const closedHost = document.querySelector('#closed-host');
        const closedRoot = closedHost.attachShadow({ mode: 'closed' });
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('#closed-content { color: rgb(12, 34, 56); --p2-shadow-proof: constructed; }');
        closedRoot.adoptedStyleSheets = [sheet];
        const content = document.createElement('span');
        content.id = 'closed-content';
        content.textContent = 'closed-shadow-content-proof';
        closedRoot.append(content);
        if (closedHost.shadowRoot !== null || closedRoot.mode !== 'closed') {
          throw new Error('closed shadow-root behavior changed');
        }

        const openHost = document.querySelector('#open-host');
        const openRoot = openHost.attachShadow({ mode: 'open' });
        if (openHost.shadowRoot !== openRoot) throw new Error('open shadow-root behavior changed');
      </script>
      </body></html>`)}`,
    { waitUntil: "load" },
  );

  await page.waitForFunction(() => {
    const wire = window.__mirror_chunks.join("");
    return wire.includes('"source":15') && wire.includes("--p2-shadow-proof");
  });

  const messages = decodeChunks(await page.evaluate(() => [...window.__mirror_chunks]));
  const rrwebEvents = messages
    .filter((message) => message.kind === "rrweb")
    .map((message) => message.e);
  const fullSnapshot = rrwebEvents.find((event) => event.type === 2);
  assert(fullSnapshot, "FullSnapshot did not arrive");

  const host = findSerializedNode(fullSnapshot.data.node, "closed-host");
  const content = findSerializedNode(fullSnapshot.data.node, "closed-content");
  assert(host, "closed shadow host is absent from the FullSnapshot");
  assert.equal(host.isShadowHost, true, "closed host was not marked as a shadow host");
  assert(content, "closed shadow content is absent from the FullSnapshot");
  assert.equal(content.isShadow, true, "closed shadow content was not marked as shadow content");
  assert(
    content.childNodes?.some((node) => node.textContent === "closed-shadow-content-proof"),
    "closed shadow text is absent from the FullSnapshot",
  );

  // rrweb represents initial adoptedStyleSheets immediately after FullSnapshot as source 15,
  // keyed to the serialized host id. Together these events are the replayable initial snapshot.
  const adoptedStyleEvent = rrwebEvents.find(
    (event) => event.type === 3 && event.data.source === 15 && event.data.id === host.id,
  );
  assert(adoptedStyleEvent, "closed root adoptedStyleSheets event did not arrive");
  assert(
    adoptedStyleEvent.data.styles?.some((style) =>
      style.rules?.some((rule) => rule.rule.includes("--p2-shadow-proof: constructed")),
    ),
    "constructable stylesheet rules were not serialized",
  );

  console.log(
    "P2-SHADOW acceptance: FullSnapshot contains closed content and its adopted constructable stylesheet was serialized",
  );
} finally {
  await browser.close();
}
