/**
 * Driver/viewer roles, single-driver enforcement, driver transfer, and presence broadcasts.
 *
 * Roles are deliberately limited to driver and viewer. A viewer-role connection's
 * input msgs are dropped server-side; `driver-transfer` moves input rights and re-runs viewport
 * negotiation (D7).
 */
import { encodeMsg, type Down, type Up } from "@mirror/protocol";
import { randomUUID } from "node:crypto";
import type { SessionRole } from "../auth/invite";

type ViewMsg = Extract<Up, { t: "view" }>;

export type RoleSender = (msg: Down, serialized: string) => void;

export interface RoleConnectionOptions {
  sessionId: string;
  inviteRole: SessionRole;
  send: RoleSender;
  viewerId?: string;
  name?: string;
}

export interface DriverChange {
  sessionId: string;
  from: string;
  to: string;
  viewport: ViewMsg | undefined;
  reason: "transfer" | "disconnect";
}

export interface RoleManagerOptions {
  createViewerId?: () => string;
  now?: () => number;
  /** Integration feeds the saved `view` back into ViewportAgreement to lock and rerun D7. */
  onDriverChange?: (change: DriverChange) => void;
}

export type UpDisposition = "forwarded" | "handled" | "dropped";

export interface RoleManager {
  connect(options: RoleConnectionOptions): string;
  disconnect(viewerId: string): void;
  isDriver(viewerId: string): boolean;
  role(viewerId: string): SessionRole | undefined;
  /**
   * The sole upstream entry point. Driver-only messages are rejected before `forward` runs;
   * transfer messages are consumed here and never leak into another handler.
   */
  routeUp(
    viewerId: string,
    msg: Up,
    forward: (msg: Up) => void | Promise<void>,
  ): Promise<UpDisposition>;
}

interface Peer {
  viewerId: string;
  sessionId: string;
  inviteRole: SessionRole;
  name: string;
  send: RoleSender;
  latestViewport?: ViewMsg;
}

interface RoleSession {
  peers: Map<string, Peer>;
  driverId?: string;
}

const DRIVER_ONLY_TAGS: ReadonlySet<Up["t"]> = new Set([
  "view",
  "view-ack",
  "ptr",
  "key",
  "text",
  "value",
  "ime",
  "scroll",
  "nav",
  "mode",
  "clip",
]);

export function createRoleManager(options: RoleManagerOptions = {}): RoleManager {
  const createViewerId = options.createViewerId ?? randomUUID;
  const now = options.now ?? Date.now;
  const peers = new Map<string, Peer>();
  const sessions = new Map<string, RoleSession>();

  return {
    connect(connection) {
      if (connection.sessionId.length === 0) throw new TypeError("sessionId must not be empty");
      if (connection.inviteRole !== "driver" && connection.inviteRole !== "viewer") {
        throw new TypeError("inviteRole must be driver or viewer");
      }
      const viewerId = connection.viewerId ?? createViewerId();
      if (viewerId.length === 0 || peers.has(viewerId)) {
        throw new Error("viewerId must be non-empty and unique");
      }
      const peer: Peer = {
        viewerId,
        sessionId: connection.sessionId,
        inviteRole: connection.inviteRole,
        name: connection.name?.trim() || viewerId,
        send: connection.send,
      };
      const session = sessions.get(peer.sessionId) ?? { peers: new Map<string, Peer>() };
      session.peers.set(viewerId, peer);
      sessions.set(peer.sessionId, session);
      peers.set(viewerId, peer);
      if (session.driverId === undefined && peer.inviteRole === "driver") {
        session.driverId = viewerId;
      }

      send(peer, {
        t: "hello",
        viewerId,
        role: session.driverId === viewerId ? "driver" : "viewer",
        sessionId: peer.sessionId,
        serverTs: now(),
      });
      broadcastState(session);
      return viewerId;
    },
    disconnect(viewerId) {
      const peer = peers.get(viewerId);
      if (peer === undefined) return;
      const session = sessions.get(peer.sessionId);
      peers.delete(viewerId);
      if (session === undefined) return;
      session.peers.delete(viewerId);

      if (session.driverId === viewerId) {
        const replacement = [...session.peers.values()].find(
          (candidate) => candidate.inviteRole === "driver",
        );
        session.driverId = replacement?.viewerId;
        if (replacement !== undefined) {
          options.onDriverChange?.({
            sessionId: peer.sessionId,
            from: viewerId,
            to: replacement.viewerId,
            viewport: replacement.latestViewport,
            reason: "disconnect",
          });
        }
      }

      if (session.peers.size === 0) {
        sessions.delete(peer.sessionId);
      } else {
        broadcastState(session);
      }
    },
    isDriver(viewerId) {
      const peer = peers.get(viewerId);
      return peer !== undefined && sessions.get(peer.sessionId)?.driverId === viewerId;
    },
    role(viewerId) {
      const peer = peers.get(viewerId);
      if (peer === undefined) return undefined;
      return sessions.get(peer.sessionId)?.driverId === viewerId ? "driver" : "viewer";
    },
    async routeUp(viewerId, msg, forward) {
      const peer = peers.get(viewerId);
      if (peer === undefined) return "dropped";
      const session = sessions.get(peer.sessionId);
      if (session === undefined) return "dropped";

      if (msg.t === "view") peer.latestViewport = { ...msg };
      if (msg.t === "driver-transfer") {
        // LibreBrowser's per-account engine permits another authenticated device of that
        // account to take control. Read-only upstream invite roles still cannot do so.
        if (session.driverId !== viewerId && !(peer.inviteRole === "driver" && msg.to === viewerId)) return "dropped";
        const target = session.peers.get(msg.to);
        if (target === undefined || target.viewerId === session.driverId) return "dropped";

        session.driverId = target.viewerId;
        options.onDriverChange?.({
          sessionId: peer.sessionId,
          from: viewerId,
          to: target.viewerId,
          viewport: target.latestViewport,
          reason: "transfer",
        });
        broadcastDriver(session);
        return "handled";
      }

      if (DRIVER_ONLY_TAGS.has(msg.t) && session.driverId !== viewerId) return "dropped";
      await forward(msg);
      return "forwarded";
    },
  };

  function broadcastState(session: RoleSession): void {
    const presence: Down = {
      t: "presence",
      viewers: [...session.peers.values()].map((peer) => ({ id: peer.viewerId, name: peer.name })),
    };
    broadcast(session, presence);
    broadcastDriver(session);
  }

  function broadcastDriver(session: RoleSession): void {
    if (session.driverId !== undefined) {
      broadcast(session, { t: "driver", viewerId: session.driverId });
    }
  }

  function broadcast(session: RoleSession, msg: Down): void {
    const serialized = encodeMsg(msg);
    for (const peer of session.peers.values()) peer.send(msg, serialized);
  }

  function send(peer: Peer, msg: Down): void {
    peer.send(msg, encodeMsg(msg));
  }
}
