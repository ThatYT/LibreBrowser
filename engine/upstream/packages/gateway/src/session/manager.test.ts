import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { AgentCmdInput, CmdRes } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";

import type {
  BrowserHandle,
  BrowserHost,
  BrowserHostLaunchOptions,
  BrowserHostSession,
  FlatSessionEventMap,
} from "../browser/launch";
import type { AgentLink, TargetRef } from "../types";
import { createSessionManager, registerSessionRoutes } from "./manager";

const PAGE: TargetRef = {
  targetId: "page-1",
  sessionId: "cdp-session-1",
  type: "page",
};

class FakeBrowser implements BrowserHandle {
  readonly send = vi.fn(async () => ({}));
  readonly sendBrowser = vi.fn(async () => ({ targetInfos: [] }));

  onSessionEvent<K extends keyof FlatSessionEventMap>(
    _method: K,
    _callback: (sessionId: string, event: FlatSessionEventMap[K]) => void,
  ): () => void {
    return () => undefined;
  }

  onAttached(callback: (target: TargetRef) => void): void {
    callback(PAGE);
  }

  onDetached(_callback: (target: TargetRef) => void): void {}

  onTargetInfoChanged(_callback: Parameters<BrowserHandle["onTargetInfoChanged"]>[0]): void {}

  async close(): Promise<void> {}
}

class FakeHostedBrowser implements BrowserHostSession {
  readonly browser = new FakeBrowser();
  running = true;
  closeMode: "stop" | "hang" = "stop";
  closeCount = 0;
  killCount = 0;
  removeCount = 0;

  constructor(readonly id: string) {}

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeMode === "hang") return new Promise(() => undefined);
    this.running = false;
    return Promise.resolve();
  }

  async kill(): Promise<void> {
    this.killCount += 1;
    this.running = false;
  }

  async remove(): Promise<void> {
    this.removeCount += 1;
  }
}

function fakeHost(): BrowserHost & {
  launches: BrowserHostLaunchOptions[];
  sessions: FakeHostedBrowser[];
} {
  const launches: BrowserHostLaunchOptions[] = [];
  const sessions: FakeHostedBrowser[] = [];
  return {
    kind: "local",
    launches,
    sessions,
    async launch(options) {
      launches.push(options);
      const { sessionId } = options;
      const session = new FakeHostedBrowser(sessionId);
      sessions.push(session);
      return session;
    },
  };
}

function agentLink(ping: () => Promise<CmdRes>): AgentLink {
  return {
    msgs() {
      return {
        async *[Symbol.asyncIterator]() {
          return;
        },
      };
    },
    sendCmd(_targetId: string, input: AgentCmdInput) {
      expect(input).toEqual({ cmd: "ping" });
      return ping();
    },
  };
}

describe("SessionManager", () => {
  it("selects throwaway profiles by default and named persistent profiles only when opted in", async () => {
    const host = fakeHost();
    const manager = createSessionManager({
      host,
      autoStart: false,
      createId: () => "ephemeral-id",
      createAgentLink: () => agentLink(async () => ({ reqId: 1, ok: true, data: "pong" })),
    });

    const ephemeral = await manager.create();
    const persistent = await manager.create({ profile: "persistent", name: "work-profile" });

    expect(ephemeral).toEqual(
      expect.objectContaining({ id: "ephemeral-id", profile: "ephemeral" }),
    );
    expect(ephemeral).not.toHaveProperty("name");
    expect(persistent).toEqual({
      id: "work-profile",
      profile: "persistent",
      name: "work-profile",
      host: "local",
      hostId: "work-profile",
      status: "active",
      createdAt: expect.any(Number),
      expiresAt: expect.any(Number),
    });
    expect(host.launches).toEqual([
      { sessionId: "ephemeral-id", profile: { mode: "ephemeral" } },
      {
        sessionId: "work-profile",
        profile: { mode: "persistent", name: "work-profile" },
      },
    ]);
    await expect(manager.create({ profile: "persistent" })).rejects.toThrow(
      "persistent sessions require",
    );
    await manager.close();
  });

  it("reaps expired sessions and removes their host resources", async () => {
    let timestamp = 1_000;
    const host = fakeHost();
    const manager = createSessionManager({
      host,
      autoStart: false,
      now: () => timestamp,
      defaultTtlMs: 50,
      createId: () => "ttl-session",
      createAgentLink: () => agentLink(async () => ({ reqId: 1, ok: true, data: "pong" })),
    });

    await manager.create();
    timestamp = 1_050;
    await manager.reapExpired();

    expect(manager.list()).toEqual([]);
    expect(host.sessions[0]?.closeCount).toBe(1);
    expect(host.sessions[0]?.killCount).toBe(0);
    expect(host.sessions[0]?.removeCount).toBe(1);
    await manager.close();
  });

  it("requires both the CDP and agent heartbeat and marks a failed session dead", async () => {
    const host = fakeHost();
    const manager = createSessionManager({
      host,
      autoStart: false,
      livenessFailures: 1,
      createId: () => "dead-session",
      createAgentLink: () => agentLink(async () => Promise.reject(new Error("agent unavailable"))),
    });
    await manager.create();

    await manager.checkLiveness();

    expect(host.sessions[0]?.browser.sendBrowser).toHaveBeenCalledWith("Target.getTargets");
    expect(manager.list()).toEqual([
      expect.objectContaining({
        id: "dead-session",
        status: "dead",
        deadReason: "agent unavailable",
      }),
    ]);
    expect(host.sessions[0]?.removeCount).toBe(1);
    expect(manager.get("dead-session")).toBeUndefined();
    await manager.close();
  });

  it("SIGKILLs a zombie after the graceful-close deadline, then removes it", async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost();
      const manager = createSessionManager({
        host,
        autoStart: false,
        zombieGraceMs: 25,
        createId: () => "zombie-session",
        createAgentLink: () => agentLink(async () => ({ reqId: 1, ok: true, data: "pong" })),
      });
      await manager.create();
      host.sessions[0]!.closeMode = "hang";

      const destroyed = manager.destroy("zombie-session");
      await vi.advanceTimersByTimeAsync(24);
      expect(host.sessions[0]?.killCount).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await destroyed;

      expect(host.sessions[0]?.killCount).toBe(1);
      expect(host.sessions[0]?.removeCount).toBe(1);
      expect(manager.list()).toEqual([]);
      await manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers create/list/destroy routes behind the required admin preHandler", async () => {
    const host = fakeHost();
    const manager = createSessionManager({
      host,
      autoStart: false,
      createId: () => "route-session",
      createAgentLink: () => agentLink(async () => ({ reqId: 1, ok: true, data: "pong" })),
    });
    const app = Fastify();
    registerSessionRoutes(app, manager, {
      adminPreHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.headers["x-admin"] !== "yes") {
          return reply.code(403).send({ error: "Forbidden" });
        }
      },
    });

    expect((await app.inject({ method: "POST", url: "/admin/sessions" })).statusCode).toBe(403);
    const created = await app.inject({
      method: "POST",
      url: "/admin/sessions",
      headers: { "x-admin": "yes" },
      payload: { ttlMs: 100 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(expect.objectContaining({ id: "route-session" }));
    expect(created.json()).toEqual(expect.objectContaining({ profile: "ephemeral" }));
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/admin/sessions",
          headers: { "x-admin": "yes" },
          payload: { profile: "persistent" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/admin/sessions",
          headers: { "x-admin": "yes" },
        })
      ).json(),
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/admin/sessions/route-session",
          headers: { "x-admin": "yes" },
        })
      ).statusCode,
    ).toBe(204);

    await app.close();
    await manager.close();
  });
});
