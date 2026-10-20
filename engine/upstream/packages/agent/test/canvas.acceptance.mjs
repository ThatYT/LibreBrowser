/** P2-CANVAS acceptance: the configured agent emits sampled bitmap events for animated canvas. */
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
const { createAgentBundle } = await import(resolve(workspace, "packages/agent/dist/index.js"));

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
  throw new Error("Chrome not found; set CHROME_PATH to run P2-CANVAS acceptance");
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
  await page.evaluateOnNewDocument(createAgentBundle({ canvas: { fps: 6, quality: 0.42 } }));
  await page.goto(
    `data:text/html,${encodeURIComponent(`<!doctype html>
      <canvas id="chart" width="320" height="180"></canvas>
      <script>
        const canvas = document.querySelector('#chart');
        const context = canvas.getContext('2d');
        let frame = 0;
        const draw = () => {
          frame += 1;
          context.fillStyle = 'hsl(' + (frame % 360) + ' 80% 50%)';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = 'white';
          context.fillRect(frame % canvas.width, 20, 24, 140);
          requestAnimationFrame(draw);
        };
        requestAnimationFrame(draw);
      </script>`)}`,
    { waitUntil: "load" },
  );

  await page.waitForFunction(
    () => {
      const wire = window.__mirror_chunks.join("");
      return (wire.match(/\"source\":9/g) ?? []).length >= 4;
    },
    { timeout: 5_000 },
  );
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));

  const messages = decodeChunks(await page.evaluate(() => [...window.__mirror_chunks]));
  const canvasEvents = messages
    .filter((message) => message.kind === "rrweb")
    .map((message) => message.e)
    .filter((event) => event.type === 3 && event.data.source === 9);

  assert(canvasEvents.length >= 4, "animated canvas emitted too few snapshots");
  const commands = canvasEvents.flatMap((event) => event.data.commands ?? []);
  assert(commands.some((command) => command.property === "clearRect"));
  const draw = commands.find((command) => command.property === "drawImage");
  assert(draw, "snapshot bitmap draw command did not arrive");
  assert.equal(draw.args[0].rr_type, "ImageBitmap");
  assert.equal(draw.args[0].args[0].rr_type, "Blob");
  assert.equal(draw.args[0].args[0].type, "image/webp");
  assert(draw.args[0].args[0].data[0].base64.length > 0, "snapshot bitmap payload is empty");

  const durationSeconds = (canvasEvents.at(-1).timestamp - canvasEvents[0].timestamp) / 1_000;
  const observedFps = (canvasEvents.length - 1) / durationSeconds;
  assert(
    observedFps >= 3.5 && observedFps <= 8,
    `configured 6fps sampler emitted at ${observedFps.toFixed(1)}fps`,
  );

  console.log(
    `P2-CANVAS acceptance: animated 2D canvas emitted ${canvasEvents.length} WebP bitmap snapshots at ${observedFps.toFixed(1)}fps`,
  );
} finally {
  await browser.close();
}
