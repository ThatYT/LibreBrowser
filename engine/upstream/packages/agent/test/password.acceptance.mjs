/** P3-PASSWORDS verification: the real agent wire stream never exposes a typed password. */
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
  throw new Error("Chrome not found; set CHROME_PATH to run P3-PASSWORDS verification");
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
  assert.equal(partials.size, 0, "password verification ended with incomplete chunks");
  return messages;
}

const plaintext = "P3-secret-CorrectHorse-7842";
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
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password">`)}`,
    { waitUntil: "load" },
  );
  await page.waitForFunction(() => window.__mirror_chunks.join("").includes('"kind":"rrweb"'));
  await page.evaluate(() => {
    window.__mirror_chunks = [];
  });

  await page.type("#password", plaintext);
  await page.waitForFunction(() => window.__mirror_chunks.join("").includes('"source":5'));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

  assert.equal(await page.$eval("#password", (input) => input.value), plaintext);
  const chunks = await page.evaluate(() => [...window.__mirror_chunks]);
  const wire = chunks.join("");
  assert(!wire.includes(plaintext), "agent wire stream contains the plaintext password");

  const passwordValues = decodeChunks(chunks)
    .filter((message) => message.kind === "rrweb")
    .map((message) => message.e)
    .filter((event) => event.type === 3 && event.data.source === 5)
    .map((event) => event.data.text)
    .filter((value) => typeof value === "string");
  assert(passwordValues.length > 0, "typing emitted no rrweb input events");
  assert(
    passwordValues.every((value) => value.length > 0 && /^[*\u2022\u25cf]+$/u.test(value)),
    `password input events were not fully masked: ${JSON.stringify(passwordValues)}`,
  );
  assert.equal(passwordValues.at(-1).length, plaintext.length);

  console.log(
    `P3-PASSWORDS verification: ${passwordValues.length} password input events contained only mask characters`,
  );
} finally {
  await browser.close();
}
