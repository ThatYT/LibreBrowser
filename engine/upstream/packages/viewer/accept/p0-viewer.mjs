import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";

const viewerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(viewerRoot, "dist");
const fixturePath = join(viewerRoot, "fixtures", "wikipedia.agentmsgs.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const events = fixture.filter((message) => message.kind === "rrweb").map((message) => message.e);
const snapshotEnd = events.findIndex((event) => event.type === 2);
if (snapshotEnd < 0) throw new Error("acceptance fixture has no FullSnapshot");

const snapshotEvents = events.slice(0, snapshotEnd + 1);
const deltaEvents = events.slice(snapshotEnd + 1);
let connectionCount = 0;
let activeViewerSocket = null;

function websocketFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error("acceptance WS payload unexpectedly exceeds 64KiB");
}

function streamFixture(socket, epoch = connectionCount) {
  socket.write(websocketFrame({ t: "resync", tab: "fixture-tab" }));
  socket.write(
    websocketFrame({
      t: "snapshot",
      tab: "fixture-tab",
      epoch,
      seq: snapshotEnd + 1,
      data: snapshotEvents,
    }),
  );
  if (deltaEvents.length > 0) {
    socket.write(
      websocketFrame({
        t: "delta",
        tab: "fixture-tab",
        epoch,
        seq: snapshotEnd + 2,
        data: deltaEvents,
      }),
    );
  }
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://accept.local").pathname;
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const path = join(distRoot, relative);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
    });
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end("not found");
  }
});

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  connectionCount += 1;
  activeViewerSocket = socket;
  setTimeout(() => streamFixture(socket), 25);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("acceptance server failed");
const viewerUrl = `http://127.0.0.1:${address.port}/`;
const chromeProfile = await mkdtemp(join(tmpdir(), "p0-viewer-chrome-"));
const chrome = spawn(
  "/usr/bin/google-chrome",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${chromeProfile}`,
    viewerUrl,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const chromeExited = new Promise((resolve) => chrome.once("exit", resolve));

function chromeEndpoint() {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`Chrome DevTools timeout\n${stderr}`)),
      10_000,
    );
    chrome.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    chrome.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools was ready (${code})\n${stderr}`));
    });
  });
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const callback = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) callback?.reject(new Error(message.error.message));
      else callback?.resolve(message.result);
    };
  }

  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("CDP WebSocket failed"));
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    this.ws.close();
  }
}

async function waitFor(read, accept, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${description}; last value: ${JSON.stringify(last)}`);
}

let cdp;
try {
  const browserEndpoint = await chromeEndpoint();
  const debugPort = new URL(browserEndpoint).port;
  const pageTarget = await waitFor(
    async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return targets.find((target) => target.type === "page" && target.url === viewerUrl);
    },
    Boolean,
    "viewer target did not open",
  );
  cdp = new Cdp(pageTarget.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send("Runtime.enable");

  const inspect = async () => {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const host = document.querySelector("#mirror-host");
        const frame = host?.querySelector("iframe");
        return {
          state: host?.dataset.mirrorState ?? null,
          sandbox: frame?.getAttribute("sandbox") ?? null,
          text: frame?.contentDocument?.body?.innerText ?? "",
          oldDisconnected: window.__p0OldFrame ? !window.__p0OldFrame.isConnected : null,
        };
      })()`,
      returnByValue: true,
    });
    return result.result.value;
  };

  const first = await waitFor(
    inspect,
    (value) =>
      value.state === "live" &&
      value.sandbox === "allow-same-origin" &&
      value.text.includes("Remote desktop software") &&
      value.text.includes("A semantic mirror keeps text selectable."),
    "fixture did not render readably in the sandbox",
  );

  const addedText = deltaEvents
    .flatMap((event) => event.data?.adds ?? [])
    .find((addition) => addition.node?.type === 3)?.node;
  if (addedText?.id === undefined) throw new Error("acceptance fixture has no mutable text node");
  const liveMutation = {
    type: 3,
    timestamp: Date.now(),
    data: {
      source: 0,
      texts: [{ id: addedText.id, value: "Live delta applied through the viewer pipeline." }],
      attributes: [],
      removes: [],
      adds: [],
    },
  };
  activeViewerSocket?.write(
    websocketFrame({
      t: "delta",
      tab: "fixture-tab",
      epoch: connectionCount,
      seq: snapshotEnd + 2 + deltaEvents.length,
      data: [liveMutation],
    }),
  );
  await waitFor(
    inspect,
    (value) => value.text.includes("Live delta applied through the viewer pipeline."),
    "live delta did not pass through the pipeline",
  );

  await cdp.send("Runtime.evaluate", {
    expression: `window.__p0OldFrame = document.querySelector("#mirror-host iframe")`,
  });
  activeViewerSocket?.write(
    websocketFrame({
      t: "delta",
      tab: "fixture-tab",
      epoch: connectionCount,
      seq: 999,
      data: [liveMutation],
    }),
  );
  await waitFor(inspect, (value) => value.state === "waiting", "seq gap did not tear down mirror");
  streamFixture(activeViewerSocket, 100 + connectionCount);
  await waitFor(
    inspect,
    (value) =>
      value.state === "live" &&
      value.oldDisconnected === true &&
      value.text.includes("Remote desktop software"),
    "seq-gap resync did not rebuild the mirror",
  );
  await cdp.send("Runtime.evaluate", {
    expression: `window.__p0OldFrame = document.querySelector("#mirror-host iframe")`,
  });

  activeViewerSocket?.destroy();
  await waitFor(
    inspect,
    (value) => value.state === "waiting",
    "disconnect did not tear down mirror",
  );
  const recovered = await waitFor(
    inspect,
    (value) =>
      connectionCount >= 2 &&
      value.state === "live" &&
      value.oldDisconnected === true &&
      value.sandbox === "allow-same-origin" &&
      value.text.includes("Remote desktop software"),
    "reconnect did not rebuild a readable mirror",
  );

  process.stdout.write(
    `P0-VIEWER acceptance passed: initial=${first.state}, reconnects=${connectionCount}, rebuilt=${recovered.oldDisconnected}\n`,
  );
} finally {
  cdp?.close();
  activeViewerSocket?.destroy();
  chrome.kill("SIGTERM");
  await Promise.race([
    chromeExited,
    new Promise((resolve) =>
      setTimeout(() => {
        chrome.kill("SIGKILL");
        resolve();
      }, 2_000),
    ),
  ]);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(chromeProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
