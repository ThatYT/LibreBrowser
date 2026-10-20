/** A Trusted-Types script-URL policy must not prevent the DOM recorder from starting. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
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
  throw new Error("Chrome not found; set CHROME_PATH to run the Trusted Types acceptance test");
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

const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Security-Policy", "require-trusted-types-for 'script'");
  response.end(`<!doctype html>
    <title>Trusted Types recorder fixture</title>
    <main><h1>Trusted Types DOM remains mirrorable</h1><canvas width="32" height="32"></canvas></main>`);
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert(address && typeof address !== "string");

const browser = await puppeteer.launch({
  executablePath: await executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.evaluateOnNewDocument(() => {
    window.__mirror_chunks = [];
    window.__mirror_emit = (payload) => window.__mirror_chunks.push(payload);
  });
  await page.evaluateOnNewDocument(AGENT_BUNDLE);
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
  await page.waitForFunction(
    () =>
      window.__mirror_chunks.some(
        (chunk) => chunk.includes('"kind":"rrweb"') && chunk.includes('"type":2'),
      ),
    { timeout: 5_000 },
  );

  const messages = decodeChunks(await page.evaluate(() => [...window.__mirror_chunks]));
  assert(
    messages.some((message) => message.kind === "hello"),
    "agent hello did not arrive",
  );
  assert(
    messages.some((message) => message.kind === "rrweb" && message.e.type === 2),
    "Trusted Types document did not emit a FullSnapshot",
  );
  assert.deepEqual(pageErrors, [], "recorder startup raised an uncaught page error");
  console.log("P0-AGENT Trusted Types acceptance: DOM FullSnapshot emitted without a Worker error");
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
}
