import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import type { BrowserHandle, FlatSessionEventMap } from "../browser/launch";
import type { TargetRef } from "../types";
import { createDockerHost, type DockerClient, type DockerContainer } from "./dockerhost";

class FakeBrowser implements BrowserHandle {
  readonly send = vi.fn(async () => ({}));
  readonly sendBrowser = vi.fn(async () => ({}));
  readonly close = vi.fn(async () => undefined);
  readonly kill = vi.fn(async () => undefined);

  onSessionEvent<K extends keyof FlatSessionEventMap>(
    _method: K,
    _callback: (sessionId: string, event: FlatSessionEventMap[K]) => void,
  ): () => void {
    return () => undefined;
  }

  onAttached(_callback: (target: TargetRef) => void): void {}

  onDetached(_callback: (target: TargetRef) => void): void {}

  onTargetInfoChanged(_callback: Parameters<BrowserHandle["onTargetInfoChanged"]>[0]): void {}
}

class FakeContainer implements DockerContainer {
  running = false;
  published = false;
  readonly start = vi.fn(async () => {
    this.running = true;
  });
  readonly kill = vi.fn(async (_options?: { signal?: string }) => {
    this.running = false;
  });
  readonly remove = vi.fn(async (_options?: Docker.ContainerRemoveOptions) => undefined);

  constructor(
    readonly id: string,
    readonly network: string,
    readonly address: string,
  ) {}

  async inspect(): Promise<Docker.ContainerInspectInfo> {
    return {
      State: { Running: this.running },
      NetworkSettings: {
        Networks: { [this.network]: { IPAddress: this.address } },
        Ports: this.published ? { "9222/tcp": [{ HostIp: "0.0.0.0", HostPort: "49152" }] } : {},
      },
    } as Docker.ContainerInspectInfo;
  }
}

function mockDocker(network: string): DockerClient & {
  creates: Docker.ContainerCreateOptions[];
  containers: FakeContainer[];
} {
  const creates: Docker.ContainerCreateOptions[] = [];
  const containers: FakeContainer[] = [];
  return {
    creates,
    containers,
    async createContainer(options) {
      creates.push(options);
      const number = creates.length;
      const container = new FakeContainer(`container-${number}`, network, `172.30.0.${number + 1}`);
      containers.push(container);
      return container;
    },
  };
}

describe("DockerBrowserHost", () => {
  it("creates one isolated, unpublished container per session and connects over private IP", async () => {
    const network = "test-browsers";
    const docker = mockDocker(network);
    const endpoints: string[] = [];
    const browsers: FakeBrowser[] = [];
    const host = createDockerHost({
      docker,
      network,
      image: "browser:test",
      requestJson: async () => ({
        webSocketDebuggerUrl: "ws://0.0.0.0:9222/devtools/browser/test",
      }),
      connect: async (endpoint) => {
        endpoints.push(endpoint);
        const browser = new FakeBrowser();
        browsers.push(browser);
        return browser;
      },
    });

    const sessions = await Promise.all(
      ["one", "two", "three"].map((sessionId) => host.launch({ sessionId })),
    );

    expect(docker.creates).toHaveLength(3);
    for (const [index, create] of docker.creates.entries()) {
      expect(create.name).toBe(`mirror-browser-${["one", "two", "three"][index]}`);
      expect(create.Image).toBe("browser:test");
      expect(create.Volumes).toEqual({ "/downloads": {} });
      expect(create.HostConfig).toEqual(
        expect.objectContaining({
          NetworkMode: network,
          PublishAllPorts: false,
          AutoRemove: false,
          Tmpfs: { "/profile": expect.stringContaining("size=1g") },
        }),
      );
      expect(create.HostConfig?.Mounts).toBeUndefined();
      expect(create.HostConfig?.PortBindings).toBeUndefined();
      expect(create.NetworkingConfig?.EndpointsConfig).toHaveProperty(network);
    }
    expect(endpoints).toEqual([
      "ws://172.30.0.2:9222/devtools/browser/test",
      "ws://172.30.0.3:9222/devtools/browser/test",
      "ws://172.30.0.4:9222/devtools/browser/test",
    ]);

    await sessions[0]!.kill();
    await sessions[0]!.remove();
    expect(docker.containers[0]?.kill).toHaveBeenCalledWith({ signal: "SIGKILL" });
    expect(docker.containers[0]?.remove).toHaveBeenCalledWith({ force: true, v: true });
    expect(browsers[0]?.kill).toHaveBeenCalledOnce();
  });

  it("reuses a named profile volume when a persistent session is recreated", async () => {
    const network = "test-browsers";
    const docker = mockDocker(network);
    const host = createDockerHost({
      docker,
      network,
      requestJson: async () => ({
        webSocketDebuggerUrl: "ws://0.0.0.0:9222/devtools/browser/test",
      }),
      connect: async () => new FakeBrowser(),
    });
    const profile = { mode: "persistent", name: "daily-work" } as const;

    const first = await host.launch({ sessionId: "daily-work", profile });
    await first.remove();
    const second = await host.launch({ sessionId: "daily-work", profile });

    const expectedMount = [
      {
        Type: "volume",
        Source: "mirror-browser-profile-daily-work",
        Target: "/profile",
      },
    ];
    expect(docker.creates[0]?.HostConfig?.Mounts).toEqual(expectedMount);
    expect(docker.creates[1]?.HostConfig?.Mounts).toEqual(expectedMount);
    expect(docker.creates[0]?.HostConfig?.Tmpfs).toBeUndefined();
    expect(docker.containers[0]?.remove).toHaveBeenCalledWith({ force: true, v: true });
    await second.remove();
  });

  it("rejects any accidentally published CDP port and force-removes the container", async () => {
    const network = "test-browsers";
    const docker = mockDocker(network);
    const originalCreate = docker.createContainer;
    docker.createContainer = async (options) => {
      const container = (await originalCreate(options)) as FakeContainer;
      container.published = true;
      return container;
    };
    const requestJson = vi.fn(async () => ({
      webSocketDebuggerUrl: "ws://0.0.0.0:9222/devtools/browser/test",
    }));
    const host = createDockerHost({ docker, network, requestJson });

    await expect(host.launch({ sessionId: "published" })).rejects.toThrow("failed to start");
    expect(requestJson).not.toHaveBeenCalled();
    expect(docker.containers[0]?.kill).toHaveBeenCalledWith({ signal: "SIGKILL" });
    expect(docker.containers[0]?.remove).toHaveBeenCalledWith({ force: true, v: true });
  });
});
