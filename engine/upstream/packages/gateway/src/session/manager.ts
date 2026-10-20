/**
 * Browser session manager.
 *
 * Owns session CRUD, TTL and dual-plane liveness, and bounded graceful shutdown followed by a
 * hard kill. Fastify wiring is exported as a factory; the integration composition root supplies
 * the admin authentication preHandler.
 */
import type { FastifyInstance, preHandlerAsyncHookHandler, preHandlerHookHandler } from "fastify";
import { randomUUID } from "node:crypto";

import { createAgentLink } from "../browser/agentlink";
import {
  createLocalBrowserHost,
  type BrowserHandle,
  type BrowserHost,
  type BrowserHostSession,
  type BrowserProfile,
} from "../browser/launch";
import type { AgentLink, TargetRef } from "../types";
import { createDockerHost } from "./dockerhost";

const DEFAULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_REAP_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
// One failed dual-plane check keeps worst-case detection below the 15-second target even
// when the agent command consumes its full 3-second timeout.
const DEFAULT_LIVENESS_FAILURES = 1;
const DEFAULT_ZOMBIE_GRACE_MS = 2_000;

export type SessionStatus = "active" | "destroying" | "dead";

export interface SessionSummary {
  id: string;
  profile: BrowserProfile["mode"];
  name?: string;
  host: BrowserHost["kind"];
  hostId: string;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
  lastLiveAt?: number;
  deadReason?: string;
}

export interface SessionRuntime {
  browser: BrowserHandle;
  agentLink: AgentLink;
}

export interface SessionCreateOptions {
  ttlMs?: number;
  /** Defaults to ephemeral. Persistent sessions require a stable, URL-safe name. */
  profile?: BrowserProfile["mode"];
  name?: string;
}

export interface SessionManagerOptions {
  /** Defaults to the local pipe host so dev and CI never require Docker. */
  host?: BrowserHost;
  defaultTtlMs?: number;
  reapIntervalMs?: number;
  heartbeatIntervalMs?: number;
  livenessFailures?: number;
  zombieGraceMs?: number;
  autoStart?: boolean;
  now?: () => number;
  createId?: () => string;
  createAgentLink?: (browser: BrowserHandle) => AgentLink;
  onError?: (error: unknown) => void;
}

export interface SessionManager {
  create(options?: SessionCreateOptions): Promise<SessionSummary>;
  list(): SessionSummary[];
  get(sessionId: string): SessionRuntime | undefined;
  destroy(sessionId: string): Promise<boolean>;
  reapExpired(): Promise<void>;
  checkLiveness(): Promise<void>;
  close(): Promise<void>;
}

interface SessionRecord {
  id: string;
  profile: BrowserProfile;
  hostKind: BrowserHost["kind"];
  hosted: BrowserHostSession;
  agentLink: AgentLink;
  pageTargets: Map<string, TargetRef>;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
  lastLiveAt?: number;
  deadReason?: string;
  consecutiveFailures: number;
  checking: boolean;
  cleanup?: Promise<void>;
}

export function createSessionManager(options: SessionManagerOptions = {}): SessionManager {
  const host = options.host ?? configuredHost();
  const defaultTtlMs = positiveInteger(options.defaultTtlMs ?? DEFAULT_TTL_MS, "defaultTtlMs");
  const reapIntervalMs = positiveInteger(
    options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS,
    "reapIntervalMs",
  );
  const heartbeatIntervalMs = positiveInteger(
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    "heartbeatIntervalMs",
  );
  const livenessFailures = positiveInteger(
    options.livenessFailures ?? DEFAULT_LIVENESS_FAILURES,
    "livenessFailures",
  );
  const zombieGraceMs = nonNegativeInteger(
    options.zombieGraceMs ?? DEFAULT_ZOMBIE_GRACE_MS,
    "zombieGraceMs",
  );
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const agentLinkFactory = options.createAgentLink ?? createAgentLink;
  const report = options.onError ?? (() => undefined);
  const records = new Map<string, SessionRecord>();
  let closed = false;
  let reaping = false;
  let checking = false;

  const reapTimer =
    options.autoStart === false
      ? undefined
      : setInterval(() => {
          if (reaping) return;
          reaping = true;
          void manager
            .reapExpired()
            .catch(report)
            .finally(() => {
              reaping = false;
            });
        }, reapIntervalMs);
  reapTimer?.unref?.();

  const heartbeatTimer =
    options.autoStart === false
      ? undefined
      : setInterval(() => {
          if (checking) return;
          checking = true;
          void manager
            .checkLiveness()
            .catch(report)
            .finally(() => {
              checking = false;
            });
        }, heartbeatIntervalMs);
  heartbeatTimer?.unref?.();

  const manager: SessionManager = {
    async create(createOptions = {}) {
      assertOpen(closed);
      const ttlMs = positiveInteger(createOptions.ttlMs ?? defaultTtlMs, "ttlMs");
      const profile = sessionProfile(createOptions);
      const id = profile.mode === "persistent" ? profile.name : createId();
      if (id.trim() === "" || records.has(id))
        throw new Error(`invalid or duplicate session id ${id}`);

      const hosted = await host.launch({ sessionId: id, profile });
      try {
        const pageTargets = new Map<string, TargetRef>();
        hosted.browser.onAttached((target) => {
          if (target.type === "page") pageTargets.set(target.targetId, target);
        });
        hosted.browser.onDetached((target) => {
          const current = pageTargets.get(target.targetId);
          if (current?.sessionId === target.sessionId) pageTargets.delete(target.targetId);
        });
        const agentLink = agentLinkFactory(hosted.browser);
        const createdAt = now();
        const record: SessionRecord = {
          id,
          profile,
          hostKind: host.kind,
          hosted,
          agentLink,
          pageTargets,
          status: "active",
          createdAt,
          expiresAt: createdAt + ttlMs,
          consecutiveFailures: 0,
          checking: false,
        };
        records.set(id, record);
        return summary(record);
      } catch (error) {
        await emergencyRemove(hosted);
        throw error;
      }
    },
    list() {
      return [...records.values()].map(summary).sort((a, b) => a.createdAt - b.createdAt);
    },
    get(sessionId) {
      const record = records.get(sessionId);
      if (record === undefined || record.status !== "active") return undefined;
      return { browser: record.hosted.browser, agentLink: record.agentLink };
    },
    async destroy(sessionId) {
      const record = records.get(sessionId);
      if (record === undefined) return false;
      if (record.status !== "dead") record.status = "destroying";
      await cleanup(record, zombieGraceMs);
      records.delete(sessionId);
      return true;
    },
    async reapExpired() {
      if (closed) return;
      const timestamp = now();
      const expired = [...records.values()].filter(
        (record) => record.status !== "destroying" && record.expiresAt <= timestamp,
      );
      const results = await Promise.allSettled(expired.map((record) => manager.destroy(record.id)));
      for (const result of results) if (result.status === "rejected") report(result.reason);
    },
    async checkLiveness() {
      if (closed) return;
      await Promise.all(
        [...records.values()].map(async (record) => {
          if (record.status !== "active" || record.checking) return;
          record.checking = true;
          try {
            await heartbeat(record);
            record.consecutiveFailures = 0;
            record.lastLiveAt = now();
          } catch (error) {
            record.consecutiveFailures += 1;
            if (record.consecutiveFailures < livenessFailures) return;
            record.status = "dead";
            record.deadReason = errorMessage(error);
            try {
              await cleanup(record, zombieGraceMs);
            } catch (cleanupError) {
              report(cleanupError);
            }
          } finally {
            record.checking = false;
          }
        }),
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      if (reapTimer !== undefined) clearInterval(reapTimer);
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      const current = [...records.values()];
      const results = await Promise.allSettled(
        current.map(async (record) => {
          await cleanup(record, zombieGraceMs);
          records.delete(record.id);
        }),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };

  return manager;
}

async function heartbeat(record: SessionRecord): Promise<void> {
  if (!(await record.hosted.isRunning())) throw new Error("browser host is not running");
  const sendBrowser = record.hosted.browser.sendBrowser;
  if (sendBrowser === undefined) throw new Error("browser/root CDP heartbeat is unavailable");
  const target = record.pageTargets.values().next().value as TargetRef | undefined;
  if (target === undefined) throw new Error("agent heartbeat has no attached page target");

  const [, pong] = await Promise.all([
    sendBrowser("Target.getTargets"),
    record.agentLink.sendCmd(target.targetId, { cmd: "ping" }),
  ]);
  if (!pong.ok || pong.data !== "pong") throw new Error(pong.err ?? "agent ping did not pong");
}

async function cleanup(record: SessionRecord, graceMs: number): Promise<void> {
  if (record.cleanup !== undefined) return record.cleanup;
  record.cleanup = (async () => {
    let graceful = false;
    const close = Promise.resolve()
      .then(() => record.hosted.close())
      .then(
        () => {
          graceful = true;
        },
        () => undefined,
      );
    await Promise.race([close, delay(graceMs)]);

    const running = await record.hosted.isRunning().catch(() => true);
    try {
      if (!graceful || running) await record.hosted.kill();
    } finally {
      await record.hosted.remove();
    }
  })();
  return record.cleanup;
}

async function emergencyRemove(hosted: BrowserHostSession): Promise<void> {
  await hosted.kill().catch(() => undefined);
  await hosted.remove().catch(() => undefined);
}

function summary(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    profile: record.profile.mode,
    ...(record.profile.mode === "persistent" ? { name: record.profile.name } : {}),
    host: record.hostKind,
    hostId: record.hosted.id,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.lastLiveAt === undefined ? {} : { lastLiveAt: record.lastLiveAt }),
    ...(record.deadReason === undefined ? {} : { deadReason: record.deadReason }),
  };
}

export type SessionAdminPreHandler = preHandlerHookHandler | preHandlerAsyncHookHandler;

export function registerSessionRoutes(
  app: FastifyInstance,
  manager: SessionManager,
  options: { adminPreHandler: SessionAdminPreHandler },
): void {
  if (typeof options.adminPreHandler !== "function") {
    throw new TypeError("session CRUD requires an admin preHandler");
  }

  app.get("/admin/sessions", { preHandler: options.adminPreHandler }, async () => manager.list());
  app.post<{ Body: { ttlMs?: unknown; profile?: unknown; name?: unknown } }>(
    "/admin/sessions",
    { preHandler: options.adminPreHandler },
    async (request, reply) => {
      const ttlMs = request.body?.ttlMs;
      const profile = request.body?.profile;
      const name = request.body?.name;
      if (
        ttlMs !== undefined &&
        (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      ) {
        return reply.code(400).send({ error: "ttlMs must be a positive integer" });
      }
      if (profile !== undefined && profile !== "ephemeral" && profile !== "persistent") {
        return reply.code(400).send({ error: "profile must be ephemeral or persistent" });
      }
      if (name !== undefined && typeof name !== "string") {
        return reply.code(400).send({ error: "name must be a string" });
      }
      if (profile === "persistent" && (typeof name !== "string" || !validProfileName(name))) {
        return reply
          .code(400)
          .send({ error: "persistent sessions require a 1-80 character URL-safe name" });
      }
      if (profile !== "persistent" && name !== undefined) {
        return reply.code(400).send({ error: "name is only valid for persistent sessions" });
      }
      const created = await manager.create({
        ...(ttlMs === undefined ? {} : { ttlMs: ttlMs as number }),
        ...(profile === undefined ? {} : { profile }),
        ...(name === undefined ? {} : { name }),
      });
      return reply.code(201).send(created);
    },
  );
  app.delete<{ Params: { sid: string } }>(
    "/admin/sessions/:sid",
    { preHandler: options.adminPreHandler },
    async (request, reply) => {
      if (!(await manager.destroy(request.params.sid))) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return reply.code(204).send();
    },
  );
}

function assertOpen(closed: boolean): void {
  if (closed) throw new Error("session manager is closed");
}

function sessionProfile(options: SessionCreateOptions): BrowserProfile {
  const mode = options.profile ?? "ephemeral";
  if (mode === "ephemeral") {
    if (options.name !== undefined) {
      throw new Error("name is only valid for persistent sessions");
    }
    return { mode };
  }
  if (mode !== "persistent") throw new Error(`unsupported session profile ${String(mode)}`);
  if (options.name === undefined || !validProfileName(options.name)) {
    throw new Error("persistent sessions require a 1-80 character URL-safe name");
  }
  return { mode, name: options.name };
}

function validProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name);
}

function configuredHost(): BrowserHost {
  const configured = process.env.BROWSER_HOST ?? "local";
  if (configured === "local") {
    return createLocalBrowserHost({
      ...(process.env.CHROME_PATH === undefined ? {} : { executablePath: process.env.CHROME_PATH }),
      headful: process.env.CHROME_HEADFUL === "1",
      args: ["--disable-dev-shm-usage"],
    });
  }
  if (configured === "docker") {
    const network = process.env.BROWSER_DOCKER_NETWORK;
    if (network === undefined || network.trim() === "") {
      throw new Error("BROWSER_DOCKER_NETWORK is required when BROWSER_HOST=docker");
    }
    return createDockerHost({
      ...(process.env.BROWSER_DOCKER_IMAGE === undefined
        ? {}
        : { image: process.env.BROWSER_DOCKER_IMAGE }),
      network,
    });
  }
  throw new Error(`unsupported BROWSER_HOST ${configured}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
