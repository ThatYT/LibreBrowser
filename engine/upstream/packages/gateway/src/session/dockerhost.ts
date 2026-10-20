/**
 * Docker-backed browser host.
 *
 * One unprivileged Chromium container is created per session. CDP is reached at the container's
 * private-network address; Docker port bindings are intentionally absent. Host egress filtering
 * is deliberately outside this lifecycle component.
 */
import Docker from "dockerode";

import {
  connectBrowser,
  type BrowserHandle,
  type BrowserHost,
  type BrowserProfile,
  type BrowserHostSession,
} from "../browser/launch";

const DEFAULT_IMAGE = "remote-browser-chromium:local";
const DEFAULT_CDP_PORT = 9222;
const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const EPHEMERAL_PROFILE_TMPFS = "rw,nosuid,nodev,size=1g,uid=10001,gid=10001,mode=0700";

export interface DockerContainer {
  readonly id: string;
  start(): Promise<unknown>;
  inspect(): Promise<Docker.ContainerInspectInfo>;
  kill(options?: { signal?: string }): Promise<unknown>;
  remove(options?: Docker.ContainerRemoveOptions): Promise<unknown>;
}

export interface DockerClient {
  createContainer(options: Docker.ContainerCreateOptions): Promise<DockerContainer>;
}

export interface DockerHostOptions {
  docker?: DockerClient;
  image?: string;
  /** Existing private Docker network; required because Compose chooses project-scoped names. */
  network: string;
  cdpPort?: number;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Test seam for `/json/version`; production uses the global fetch implementation. */
  requestJson?: (url: string) => Promise<unknown>;
  /** Test seam for Puppeteer's websocket connection. */
  connect?: (browserWSEndpoint: string) => Promise<BrowserHandle>;
}

interface CdpVersion {
  webSocketDebuggerUrl: string;
}

export function createDockerHost(options: DockerHostOptions): BrowserHost {
  const docker = options.docker ?? new Docker();
  const image = nonEmpty(options.image ?? DEFAULT_IMAGE, "image");
  const network = nonEmpty(options.network, "network");
  const cdpPort = positiveInteger(options.cdpPort ?? DEFAULT_CDP_PORT, "cdpPort");
  const startTimeoutMs = positiveInteger(
    options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    "startTimeoutMs",
  );
  const pollIntervalMs = nonNegativeInteger(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  const requestJson = options.requestJson ?? fetchJson;
  const connect = options.connect ?? connectBrowser;

  return {
    kind: "docker",
    async launch({ sessionId, profile = { mode: "ephemeral" } }) {
      const safeSessionId = containerSafeSessionId(sessionId);
      const profileHostConfig = dockerProfileHostConfig(profile);
      const container = await docker.createContainer({
        name: `mirror-browser-${safeSessionId}`,
        Image: image,
        Env: ["TZ=Etc/UTC"],
        Labels: {
          "com.remote-browser.managed": "true",
          "com.remote-browser.session": sessionId,
          "com.remote-browser.profile": profile.mode,
          ...(profile.mode === "persistent"
            ? { "com.remote-browser.profile-name": profile.name }
            : {}),
        },
        // Downloads remain container-scoped. Profiles are either throwaway tmpfs mounts or a
        // deterministic named volume selected by the explicit persistent-session name.
        Volumes: { "/downloads": {} },
        ExposedPorts: { [`${cdpPort}/tcp`]: {} },
        HostConfig: {
          AutoRemove: false,
          Init: true,
          NetworkMode: network,
          PublishAllPorts: false,
          ...profileHostConfig,
          // Deliberately no PortBindings: CDP must never be published on the Docker host.
        },
        NetworkingConfig: { EndpointsConfig: { [network]: {} } },
      });

      let browser: BrowserHandle | undefined;
      try {
        await container.start();
        const address = await privateAddress(container, network);
        const versionUrl = `http://${urlHost(address)}:${cdpPort}/json/version`;
        const version = await waitForCdp(versionUrl, requestJson, startTimeoutMs, pollIntervalMs);
        const browserWSEndpoint = endpointAt(version.webSocketDebuggerUrl, address, cdpPort);
        browser = await connect(browserWSEndpoint);
        return dockerSession(container, browser);
      } catch (error) {
        await forceRemove(container);
        throw new Error(`Docker browser session ${sessionId} failed to start`, { cause: error });
      }
    },
  };
}

function dockerProfileHostConfig(profile: BrowserProfile): Docker.HostConfig {
  if (profile.mode === "ephemeral") {
    return { Tmpfs: { "/profile": EPHEMERAL_PROFILE_TMPFS } };
  }
  const name = persistentProfileName(profile.name);
  return {
    Mounts: [
      {
        Type: "volume",
        Source: `mirror-browser-profile-${name}`,
        Target: "/profile",
      },
    ],
  };
}

function dockerSession(container: DockerContainer, browser: BrowserHandle): BrowserHostSession {
  let removed = false;
  return {
    id: container.id,
    browser,
    async isRunning() {
      if (removed) return false;
      try {
        return (await container.inspect()).State.Running;
      } catch {
        return false;
      }
    },
    close: () => browser.close(),
    async kill() {
      try {
        await container.kill({ signal: "SIGKILL" });
      } catch {
        // A container that exited between inspect and kill is already hard-stopped.
      }
    },
    async remove() {
      if (removed) return;
      await browser.kill?.().catch(() => undefined);
      await container.remove({ force: true, v: true });
      removed = true;
    },
  };
}

async function privateAddress(container: DockerContainer, network: string): Promise<string> {
  const inspected = await container.inspect();
  const address = inspected.NetworkSettings.Networks[network]?.IPAddress;
  if (typeof address !== "string" || address.trim() === "") {
    throw new Error(`container has no address on private network ${network}`);
  }
  const published = Object.values(inspected.NetworkSettings.Ports).some(
    (bindings) => Array.isArray(bindings) && bindings.length > 0,
  );
  if (published) throw new Error("browser container unexpectedly has a published port");
  return address;
}

async function waitForCdp(
  url: string,
  requestJson: (url: string) => Promise<unknown>,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<CdpVersion> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      const payload = await requestJson(url);
      if (isCdpVersion(payload)) return payload;
      lastError = new Error("CDP version response omitted webSocketDebuggerUrl");
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`CDP did not become ready within ${timeoutMs}ms`, { cause: lastError });
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  if (!response.ok) throw new Error(`CDP readiness returned HTTP ${response.status}`);
  return response.json();
}

function isCdpVersion(value: unknown): value is CdpVersion {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).webSocketDebuggerUrl === "string"
  );
}

function endpointAt(endpoint: string, address: string, port: number): string {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("CDP websocket endpoint has an invalid protocol");
  }
  parsed.host = `${urlHost(address)}:${port}`;
  return parsed.href;
}

function urlHost(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

async function forceRemove(container: DockerContainer): Promise<void> {
  try {
    await container.kill({ signal: "SIGKILL" });
  } catch {
    // It may not have started, or it may already have exited.
  }
  await container.remove({ force: true, v: true }).catch(() => undefined);
}

function containerSafeSessionId(sessionId: string): string {
  const safe = nonEmpty(sessionId, "sessionId").replace(/[^A-Za-z0-9_.-]/g, "-");
  return safe.slice(0, 80);
}

function persistentProfileName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name)) {
    throw new Error("persistent profile name must be 1-80 URL-safe characters");
  }
  return name;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim() === "") throw new Error(`${name} must not be empty`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
