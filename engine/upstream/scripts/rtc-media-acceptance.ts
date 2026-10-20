/**
 * Headful end-to-end acceptance for the production canvas-WebRTC media lane.
 *
 * This starts the real gateway composition root (launchBrowser + AgentLink + TabLifecycle +
 * RtcSignalRelay), opens the built viewer App (Mirror + Replayer + CanvasRtc), and serves a
 * moving VP8 MSE fixture under require-trusted-types-for 'script'.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

const CHROME_PATH = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const START_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
const MEDIA_NOTICE = "Media unavailable in DOM view — use pixel view";

interface GatewayTab {
  tab: string;
  epoch: number;
  docId: number;
  seq: number;
  url: string;
}

interface GatewayState {
  tabs: GatewayTab[];
}

interface RtcFrame {
  direction: "up" | "down";
  message: Record<string, unknown>;
}

interface RtcDiag {
  created: number;
  closed: number;
  open: number;
  tracks: Array<{ kind: string; readyState: string }>;
}

interface FrameSample {
  currentTime: number;
  frames: number;
  hash: number;
  mean: number;
  variance: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function waitFor<T>(
  description: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = STEP_TIMEOUT_MS,
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
    await delay(POLL_MS);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError === undefined ? "" : `: ${errorText(lastError)}`}`,
  );
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

async function startXvfb(): Promise<ChildProcess | undefined> {
  if (process.env.DISPLAY) return undefined;
  const displayNumber = 900 + (process.pid % 90);
  const display = `:${displayNumber}`;
  const child = spawn("Xvfb", [display, "-screen", "0", "1440x1000x24", "-nolisten", "tcp"], {
    stdio: "ignore",
  });
  await waitFor(
    "Xvfb display",
    async () => {
      try {
        await access(`/tmp/.X11-unix/X${displayNumber}`);
        return true;
      } catch {
        return undefined;
      }
    },
    START_TIMEOUT_MS,
  );
  process.env.DISPLAY = display;
  return child;
}

async function run(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`${command} exited ${code}: ${output.slice(-4_000)}`);
}

async function makeVideo(path: string): Promise<void> {
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30",
    "-t",
    "60",
    "-an",
    "-c:v",
    "libvpx",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-b:v",
    "650k",
    "-f",
    "webm",
    "-y",
    path,
  ]);
}

const FIXTURE_JS = String.raw`
const video = document.querySelector('#media');
const ticks = document.querySelector('#ticks');
const events = document.querySelector('#events');
let tick = 0;
setInterval(() => { ticks.textContent = String(++tick); }, 100);
for (const name of ['mousedown', 'mouseup', 'click']) {
  video.addEventListener(name, () => {
    const key = name + 'Count';
    document.body.dataset[key] = String(Number(document.body.dataset[key] || 0) + 1);
  });
}
for (const name of ['play', 'pause', 'playing', 'ended']) {
  video.addEventListener(name, () => {
    document.body.dataset.mediaEvent = name;
    events.textContent = name + ':' + video.currentTime.toFixed(2);
  });
}
video.addEventListener('click', () => {
  if (video.paused) void video.play();
  else video.pause();
});
let workerUrl;
try {
  workerUrl = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);
  worker.terminate();
  document.body.dataset.workerProbe = 'unexpectedly-allowed';
} catch (error) {
  document.body.dataset.workerProbe = 'blocked';
} finally {
  if (workerUrl) URL.revokeObjectURL(workerUrl);
}
const mediaSource = new MediaSource();
video.src = URL.createObjectURL(mediaSource);
mediaSource.addEventListener('sourceopen', async () => {
  const mime = 'video/webm; codecs="vp8"';
  if (!MediaSource.isTypeSupported(mime)) throw new Error('VP8 MSE unavailable');
  const source = mediaSource.addSourceBuffer(mime);
  const bytes = await (await fetch('/clip.webm')).arrayBuffer();
  source.addEventListener('updateend', () => {
    if (mediaSource.readyState === 'open') mediaSource.endOfStream();
    video.loop = true;
    void video.play();
  }, { once: true });
  source.appendBuffer(bytes);
}, { once: true });
`;

function fixtureHtml(disableCapture: boolean): string {
  return `<!doctype html>
    <html><head><meta charset="utf-8"><title>${disableCapture ? "No capture" : "RTC MSE fixture"}</title>
    ${disableCapture ? '<script src="/disable-capture.js"></script>' : ""}</head>
    <body style="margin:0;background:#17202a;color:white;font:16px sans-serif">
      <video id="media" muted autoplay playsinline style="display:block;width:640px;height:360px;background:#000"></video>
      <p id="events">loading</p><p>tick:<span id="ticks">0</span></p>
      <script src="/fixture.js"></script>
    </body></html>`;
}

async function startFixture(videoPath: string): Promise<{ server: Server; baseUrl: string }> {
  const video = await readFile(videoPath);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src blob:; require-trusted-types-for 'script'",
    );
    if (url.pathname === "/clip.webm") {
      response.setHeader("Content-Type", "video/webm");
      response.end(video);
      return;
    }
    if (url.pathname === "/disable-capture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(
        "Object.defineProperty(HTMLMediaElement.prototype, 'captureStream', { configurable: true, value: undefined });",
      );
      return;
    }
    if (url.pathname === "/fixture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(FIXTURE_JS);
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixtureHtml(url.pathname === "/fallback"));
  });
  const port = await freePort();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function startGateway(port: number): { child: ChildProcess; logs: () => string } {
  const child = spawn("pnpm", ["-F", "@mirror/gateway", "dev"], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      CHROME_PATH,
      CHROME_HEADFUL: "1",
      GATEWAY_PORT: String(port),
      MIRROR_E2E: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-200_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return { child, logs: () => output };
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000).then(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }),
  ]);
}

async function getState(gatewayUrl: string): Promise<GatewayState> {
  const response = await fetch(`${gatewayUrl}/__e2e/state`, { cache: "no-store" });
  if (!response.ok) throw new Error(`state returned ${response.status}`);
  return (await response.json()) as GatewayState;
}

async function navigate(gatewayUrl: string, tab: string, url: string): Promise<void> {
  const response = await fetch(`${gatewayUrl}/__e2e/navigate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab, url }),
  });
  if (!response.ok)
    throw new Error(`navigate returned ${response.status}: ${await response.text()}`);
}

async function remoteValue<T>(gatewayUrl: string, tab: string, expression: string): Promise<T> {
  const response = await fetch(`${gatewayUrl}/__e2e/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab, expression }),
  });
  if (!response.ok)
    throw new Error(`evaluate returned ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { value: T }).value;
}

function observeRtc(page: Page): RtcFrame[] {
  const frames: RtcFrame[] = [];
  page.on("websocket", (socket) => {
    if (!new URL(socket.url()).pathname.endsWith("/ws")) return;
    const capture = (direction: RtcFrame["direction"], payload: string | Buffer) => {
      try {
        const message = JSON.parse(String(payload)) as Record<string, unknown>;
        if (message.t === "rtc-sig") frames.push({ direction, message });
      } catch {}
    };
    socket.on("framesent", ({ payload }) => capture("up", payload));
    socket.on("framereceived", ({ payload }) => capture("down", payload));
  });
  return frames;
}

function observeUp(page: Page): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  page.on("websocket", (socket) => {
    if (!new URL(socket.url()).pathname.endsWith("/ws")) return;
    socket.on("framesent", ({ payload }) => {
      try {
        messages.push({
          ...(JSON.parse(String(payload)) as Record<string, unknown>),
          __observedAt: Date.now(),
        });
      } catch {}
    });
  });
  return messages;
}

async function installViewerDiagnostics(context: BrowserContext): Promise<void> {
  await context.addInitScript({
    content: String.raw`(() => {
      try {
        const records = [];
        const NativePeer = globalThis.RTCPeerConnection;
        function TrackedPeer(...args) {
          const pc = new NativePeer(...args);
          const record = { pc, closed: false, tracks: [] };
          records.push(record);
          pc.addEventListener('track', (event) => record.tracks.push(event.track));
          const close = pc.close.bind(pc);
          pc.close = () => { record.closed = true; close(); };
          return pc;
        }
        TrackedPeer.prototype = NativePeer.prototype;
        Object.defineProperty(globalThis, 'RTCPeerConnection', {
          configurable: true, value: TrackedPeer, writable: true
        });
        globalThis.__mirrorRtcDiag = { records };

        const sockets = [];
        const NativeSocket = globalThis.WebSocket;
        function TrackedSocket(url, protocols) {
          const socket = protocols === undefined
            ? new NativeSocket(url)
            : new NativeSocket(url, protocols);
          sockets.push(socket);
          return socket;
        }
        TrackedSocket.prototype = NativeSocket.prototype;
        for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
          Object.defineProperty(TrackedSocket, key, { value: NativeSocket[key] });
        }
        Object.defineProperty(globalThis, 'WebSocket', {
          configurable: true, value: TrackedSocket, writable: true
        });
        globalThis.__mirrorSockets = sockets;
      } catch (error) {
        globalThis.__mirrorRtcDiagError = String(error && error.stack || error);
      }
    })();`,
  });
}

async function rtcDiag(page: Page): Promise<RtcDiag> {
  return page.evaluate(() => {
    const scope = window as unknown as {
      __mirrorRtcDiagError?: string;
      __mirrorRtcDiag?: {
        records: Array<{ pc: RTCPeerConnection; closed: boolean; tracks: MediaStreamTrack[] }>;
      };
    };
    if (scope.__mirrorRtcDiag === undefined) {
      throw new Error(
        `RTC diagnostics missing: ${scope.__mirrorRtcDiagError ?? "init script absent"}`,
      );
    }
    const records = scope.__mirrorRtcDiag.records;
    return {
      created: records.length,
      closed: records.filter((record) => record.closed).length,
      open: records.filter((record) => !record.closed).length,
      tracks: records.flatMap((record) =>
        record.tracks.map((track) => ({ kind: track.kind, readyState: track.readyState })),
      ),
    };
  });
}

async function sampleVideo(page: Page): Promise<FrameSample | undefined> {
  return page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>("#mirror-host iframe");
    const video = iframe?.contentDocument?.querySelector<HTMLVideoElement>("#media");
    if (video === null || video === undefined || video.readyState < 2 || video.videoWidth === 0) {
      return undefined;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) return undefined;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    let sumSquares = 0;
    let hash = 2_166_136_261;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 64) {
      const value = (pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0);
      sum += value;
      sumSquares += value * value;
      hash = Math.imul(hash ^ value, 16_777_619) >>> 0;
      count += 1;
    }
    const mean = sum / count / 3;
    const variance = sumSquares / count - (sum / count) ** 2;
    return {
      currentTime: video.currentTime,
      frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
      hash,
      mean,
      variance,
    };
  });
}

async function samplePixelView(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#mirror-host canvas.px-canvas");
    if (canvas === null || canvas.width < 2 || canvas.height < 2) return undefined;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) return undefined;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2_166_136_261;
    let nonBlack = 0;
    const stride = Math.max(4, Math.floor(data.length / 2_000 / 4) * 4);
    for (let index = 0; index < data.length; index += stride) {
      const value = (data[index] ?? 0) + (data[index + 1] ?? 0) + (data[index + 2] ?? 0);
      if (value > 20) nonBlack += 1;
      hash = Math.imul(hash ^ value, 16_777_619) >>> 0;
    }
    return nonBlack > 20 ? hash : undefined;
  });
}

function hasSignal(
  frames: readonly RtcFrame[],
  direction: RtcFrame["direction"],
  field: "sdp" | "candidate",
): boolean {
  return frames.some(({ direction: candidateDirection, message }) => {
    if (candidateDirection !== direction) return false;
    const payload = message.payload;
    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as { type?: unknown }).type !== "signal"
    ) {
      return false;
    }
    const signal = (payload as { signal?: unknown }).signal;
    return typeof signal === "object" && signal !== null && field in signal;
  });
}

function requestedLanes(frames: readonly RtcFrame[]): string[] {
  return frames.flatMap(({ direction, message }) => {
    const payload = message.payload as { type?: unknown } | undefined;
    return direction === "up" && payload?.type === "video" && typeof message.lane === "string"
      ? [message.lane]
      : [];
  });
}

async function waitForLiveTrack(page: Page, minimumCreated = 1): Promise<RtcDiag> {
  return waitFor("one live remote video track", async () => {
    const diag = await rtcDiag(page);
    return diag.created >= minimumCreated &&
      diag.open === 1 &&
      diag.tracks.some((track) => track.kind === "video" && track.readyState === "live")
      ? diag
      : undefined;
  });
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "mirror-rtc-media-"));
  const clip = join(temp, "moving.webm");
  const xvfb = await startXvfb();
  console.log("rtc-media: generating moving VP8 fixture");
  await makeVideo(clip);
  const fixture = await startFixture(clip);
  const gatewayPort = await freePort();
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const gateway = startGateway(gatewayPort);
  console.log(`rtc-media: starting production gateway on ${gatewayUrl}`);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let wireDebug: Record<string, unknown>[] = [];

  try {
    await waitFor(
      "gateway health",
      async () => {
        try {
          return (await fetch(`${gatewayUrl}/healthz`)).ok ? true : undefined;
        } catch {
          return undefined;
        }
      },
      START_TIMEOUT_MS,
    );
    browser = await chromium.launch({ executablePath: CHROME_PATH, headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installViewerDiagnostics(context);
    const driver = await context.newPage();
    const driverFrames = observeRtc(driver);
    wireDebug = observeUp(driver);
    await driver.goto(gatewayUrl, { waitUntil: "domcontentloaded" });
    const initial = await waitFor(
      "initial gateway tab",
      async () => (await getState(gatewayUrl)).tabs[0],
    );
    const firstUrl = `${fixture.baseUrl}/mse?document=1`;
    await navigate(gatewayUrl, initial.tab, firstUrl);
    console.log("rtc-media: Trusted Types MSE page loaded; waiting for WebRTC media");

    const source = await waitFor("Trusted Types MSE source playback", async () => {
      const value = await remoteValue<{
        time: number;
        ready: number;
        worker: string;
        fixedBinding: string;
      }>(
        gatewayUrl,
        initial.tab,
        `(() => { const v = document.querySelector('#media'); return v && v.currentTime > 0.2 ? {
          time: v.currentTime, ready: v.readyState, worker: document.body.dataset.workerProbe,
          fixedBinding: typeof globalThis.__mirror_rtc_emit
        } : null; })()`,
      );
      return value?.time > 0.2 ? value : undefined;
    });
    assert.equal(source.worker, "blocked", "Trusted Types Worker probe was not blocked");
    assert.equal(
      source.fixedBinding,
      "undefined",
      "fixed RTC binding leaked from the production inject path",
    );

    const driverTrack = await waitForLiveTrack(driver);
    await waitFor("bidirectional SDP and ICE", () =>
      hasSignal(driverFrames, "down", "sdp") &&
      hasSignal(driverFrames, "up", "sdp") &&
      hasSignal(driverFrames, "down", "candidate") &&
      hasSignal(driverFrames, "up", "candidate")
        ? true
        : undefined,
    );
    const firstSample = await waitFor("first non-black mirrored frame", async () => {
      const sample = await sampleVideo(driver);
      return sample !== undefined && sample.mean > 8 && sample.variance > 100 ? sample : undefined;
    });
    await delay(700);
    const secondSample = await waitFor("advancing mirrored frame", async () => {
      const sample = await sampleVideo(driver);
      return sample !== undefined &&
        sample.hash !== firstSample.hash &&
        sample.currentTime > firstSample.currentTime &&
        sample.frames > firstSample.frames
        ? sample
        : undefined;
    });
    console.log("rtc-media: SDP/ICE, remote track, and advancing frames verified");

    // A second read-only viewer must negotiate its own peer without perturbing the driver.
    const follower = await context.newPage();
    const followerFrames = observeRtc(follower);
    await follower.goto(gatewayUrl, { waitUntil: "domcontentloaded" });
    await waitForLiveTrack(follower);
    const followerSample = await waitFor("follower advancing frame", async () => {
      const sample = await sampleVideo(follower);
      return sample !== undefined && sample.mean > 8 ? sample : undefined;
    });
    const driverLanes = new Set(requestedLanes(driverFrames));
    const followerLanes = new Set(requestedLanes(followerFrames));
    assert(driverLanes.size > 0 && followerLanes.size > 0);
    assert(
      [...driverLanes].every((lane) => !followerLanes.has(lane)),
      "two viewers reused one Replayer-generation lane",
    );
    await follower.close();
    assert.equal((await rtcDiag(driver)).open, 1, "follower close tore down the driver's peer");
    console.log("rtc-media: independent read-only viewer peer verified");

    // DOM clicks still reach the source media and rrweb mutations keep flowing while paused.
    const mirrorVideo = driver.frameLocator("#mirror-host iframe").locator("#media");
    const waitForStableViewportAgreement = () =>
      waitFor("stable viewport agreement before input", () => {
        let lastView = -1;
        for (let index = 0; index < wireDebug.length; index += 1) {
          const message = wireDebug[index]!;
          if (message.t === "view" && message.tab === initial.tab) lastView = index;
        }
        if (lastView < 0) return undefined;
        const observedAt = wireDebug[lastView]!.__observedAt;
        const acknowledged = wireDebug
          .slice(lastView + 1)
          .some((message) => message.t === "view-ack" && message.tab === initial.tab);
        return acknowledged && typeof observedAt === "number" && Date.now() - observedAt >= 1_500
          ? true
          : undefined;
      });
    await waitForStableViewportAgreement();
    const tickBefore = Number(
      await driver.frameLocator("#mirror-host iframe").locator("#ticks").textContent(),
    );
    const pointersBefore = wireDebug.filter((message) => message.t === "ptr").length;
    await mirrorVideo.click({ position: { x: 100, y: 100 } });
    await waitFor("upstream video pointer pair", () =>
      wireDebug.filter((message) => message.t === "ptr").length >= pointersBefore + 2
        ? true
        : undefined,
    );
    console.log(
      `rtc-media: relayed pointer ${JSON.stringify(wireDebug.filter((message) => message.t === "ptr").slice(-2))}`,
    );
    await waitFor("authoritative video click event", async () => {
      const count = await remoteValue<number>(
        gatewayUrl,
        initial.tab,
        "Number(document.body.dataset.clickCount || 0)",
      );
      return count > 0 ? count : undefined;
    });
    await waitFor("authoritative media pause", async () =>
      (await remoteValue<boolean>(
        gatewayUrl,
        initial.tab,
        "document.querySelector('#media').paused",
      ))
        ? true
        : undefined,
    );
    await waitFor("paused media event mutation in mirror", async () =>
      (
        await driver.frameLocator("#mirror-host iframe").locator("#events").textContent()
      )?.startsWith("pause")
        ? true
        : undefined,
    );
    await waitFor("DOM mutations while media is paused", async () => {
      const tick = Number(
        await driver.frameLocator("#mirror-host iframe").locator("#ticks").textContent(),
      );
      return tick > tickBefore + 2 ? tick : undefined;
    });
    // The pause mutation can rebuild the mirrored media subtree and publish a new viewport epoch.
    // Respect the same real input gate for resume instead of racing that transition.
    await waitForStableViewportAgreement();
    const pointersBeforeResume = wireDebug.filter((message) => message.t === "ptr").length;
    const clicksBeforeResume = await remoteValue<number>(
      gatewayUrl,
      initial.tab,
      "Number(document.body.dataset.clickCount || 0)",
    );
    await mirrorVideo.click({ position: { x: 100, y: 100 } });
    await waitFor("upstream video resume pointer pair", () =>
      wireDebug.filter((message) => message.t === "ptr").length >= pointersBeforeResume + 2
        ? true
        : undefined,
    );
    await waitFor("authoritative video resume click event", async () => {
      const count = await remoteValue<number>(
        gatewayUrl,
        initial.tab,
        "Number(document.body.dataset.clickCount || 0)",
      );
      return count > clicksBeforeResume ? count : undefined;
    });
    await waitFor("authoritative media resume", async () =>
      (await remoteValue<boolean>(
        gatewayUrl,
        initial.tab,
        "document.querySelector('#media').paused",
      ))
        ? undefined
        : true,
    );
    console.log("rtc-media: click pause/resume and concurrent DOM mutations verified");

    // Viewer disconnect closes local tracks immediately; reconnect creates a fresh lane and peer.
    const beforeDisconnect = await rtcDiag(driver);
    await context.setOffline(true);
    await driver.evaluate(() => {
      const sockets = (window as unknown as { __mirrorSockets: WebSocket[] }).__mirrorSockets;
      for (const socket of sockets) socket.close();
    });
    await waitFor("viewer disconnect RTC teardown", async () => {
      const diag = await rtcDiag(driver);
      return diag.open === 0 &&
        diag.closed > beforeDisconnect.closed &&
        diag.tracks.every((track) => track.readyState === "ended")
        ? diag
        : undefined;
    });
    await context.setOffline(false);
    const afterReconnect = await waitForLiveTrack(driver, beforeDisconnect.created + 1);
    console.log("rtc-media: disconnect teardown and reconnect verified");

    // Hard navigation rebuilds the Replayer and uses a new lane.
    const beforeNavLanes = new Set(requestedLanes(driverFrames));
    const beforeNav = await rtcDiag(driver);
    await navigate(gatewayUrl, initial.tab, `${fixture.baseUrl}/mse?document=2`);
    const afterNav = await waitForLiveTrack(driver, beforeNav.created + 1);
    await waitFor("navigation lane replacement", () => {
      const lanes = requestedLanes(driverFrames);
      return lanes.some((lane) => !beforeNavLanes.has(lane)) ? true : undefined;
    });
    assert(afterNav.closed > beforeNav.closed, "navigation did not close the old peer");

    // New-tab activation, explicit switch, and tab close each dispose the old generation.
    await driver.locator("#new-tab").click();
    const secondTab = await waitFor("second active tab", async () => {
      const tabs = (await getState(gatewayUrl)).tabs;
      return tabs.length === 2 ? tabs.find((tab) => tab.tab !== initial.tab) : undefined;
    });
    await waitFor("tab switch teardown", async () =>
      (await rtcDiag(driver)).open === 0 ? true : undefined,
    );
    await navigate(gatewayUrl, secondTab.tab, `${fixture.baseUrl}/mse?tab=2`);
    const onSecondTab = await waitForLiveTrack(driver, afterNav.created + 1);

    await driver.locator(".tab-activate").evaluateAll((buttons, expectedUrl) => {
      const button = buttons.find((candidate) => candidate.getAttribute("title") === expectedUrl);
      if (!(button instanceof HTMLButtonElement)) throw new Error(`tab ${expectedUrl} not found`);
      button.click();
    }, `${fixture.baseUrl}/mse?document=2`);
    const switchedBack = await waitForLiveTrack(driver, onSecondTab.created + 1);
    assert(switchedBack.closed > onSecondTab.closed, "tab switch did not close its peer");

    await driver.locator(".browser-tab[data-active='true'] .tab-close").click();
    await waitFor("closed tab removed", async () =>
      (await getState(gatewayUrl)).tabs.length === 1 ? true : undefined,
    );
    const afterClose = await waitForLiveTrack(driver, switchedBack.created + 1);
    assert(afterClose.closed > switchedBack.closed, "tab close did not close its viewer peer");
    console.log("rtc-media: navigation, tab switch, and tab close teardown verified");

    // captureStream absence produces an explicit notice; Page.startScreencast still paints px.
    const remaining = (await getState(gatewayUrl)).tabs[0]!;
    await navigate(gatewayUrl, remaining.tab, `${fixture.baseUrl}/fallback`);
    await waitFor("media unavailable notice", async () => {
      const notice = await driver
        .locator("#viewer-hud-layer [data-mirror-video-notice]")
        .textContent();
      return notice === MEDIA_NOTICE ? true : undefined;
    });
    assert.equal(
      await driver.locator("#mirror-host").getAttribute("data-mirror-state"),
      "live",
      "captureStream failure crashed the DOM mirror",
    );
    await driver.getByRole("button", { name: "Use pixel view" }).click();
    const firstPx = await waitFor("non-black pixel fallback frame", () => samplePixelView(driver));
    await delay(500);
    const secondPx = await waitFor("advancing pixel fallback frame", async () => {
      const sample = await samplePixelView(driver);
      return sample !== undefined && sample !== firstPx ? sample : undefined;
    });
    console.log("rtc-media: capture failure notice and advancing pixel fallback verified");

    const finalDiag = await rtcDiag(driver);
    console.log(
      JSON.stringify(
        {
          result: "PASS",
          trustedTypes: source,
          signaling: {
            driverFrames: driverFrames.length,
            sdp: { agentToViewer: true, viewerToAgent: true },
            ice: { agentToViewer: true, viewerToAgent: true },
            driverLanes: [...driverLanes],
            followerLanes: [...followerLanes],
          },
          advancingFrames: { first: firstSample, second: secondSample, follower: followerSample },
          lifecycle: {
            driverTrack,
            afterReconnect,
            afterNav,
            onSecondTab,
            switchedBack,
            afterClose,
            finalDiag,
          },
          fallback: { notice: MEDIA_NOTICE, firstPx, secondPx },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    throw new Error(
      `${errorText(error)}\n--- recent viewer Up ---\n${JSON.stringify(wireDebug.slice(-20), null, 2)}\n--- gateway tail ---\n${gateway.logs().slice(-20_000)}`,
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await stopProcess(gateway.child);
    await closeServer(fixture.server);
    xvfb?.kill("SIGTERM");
    await rm(temp, { force: true, recursive: true });
  }
}

const mainKeepAlive = setInterval(() => undefined, 1_000);
void main().then(
  () => {
    clearInterval(mainKeepAlive);
  },
  (error) => {
    clearInterval(mainKeepAlive);
    console.error(error);
    process.exitCode = 1;
  },
);
