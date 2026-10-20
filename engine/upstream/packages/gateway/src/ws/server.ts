/**
 * WebSocket fan-out server.
 *
 * `ws` with perMessageDeflate; fastify handles the HTTP upgrade path; delta batching at 30ms
 * flush; viewer join wired to TabHub.joinPayload(). NEVER JSON.stringify per viewer — serialize
 * once per broadcast (encodeMsg) and fan out the string. Auth middleware slot: SEC-2's cookie
 * guard runs at upgrade time (see ../auth/middleware.ts), not on first message.
 */
import { decodeUp, encodeMsg, type Down, type Up } from "@mirror/protocol";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import type { TabHub } from "../hub/tabhub";
import { ViewerConn, type ViewerConnOpts, type ViewerSocket } from "./viewerconn";

export const DEFAULT_BATCH_MS = 30;

export interface DeltaChaosOptions {
  /** Probability per (delta message, viewer). Production never supplies this option. */
  dropRate: number;
  random?: () => number;
}

export interface DeltaChaosStats {
  deltaMessagesConsidered: number;
  deltaMessagesDropped: number;
  droppedByTab: Readonly<Record<string, number>>;
}

interface PendingDelta {
  msg: Extract<Down, { t: "delta" }>;
  timer: NodeJS.Timeout;
}

export class Fanout {
  private readonly viewers = new Set<ViewerConn>();
  private readonly pending = new Map<string, PendingDelta>();

  private readonly chaosRandom: () => number;
  private readonly chaosDropRate: number;
  private chaosConsidered = 0;
  private chaosDropped = 0;
  private readonly chaosDroppedByTab = new Map<string, number>();

  constructor(
    private readonly batchMs = DEFAULT_BATCH_MS,
    chaos?: DeltaChaosOptions,
  ) {
    if (!Number.isSafeInteger(batchMs) || batchMs < 1) {
      throw new RangeError("batchMs must be a positive safe integer");
    }
    this.chaosDropRate = chaos?.dropRate ?? 0;
    if (!Number.isFinite(this.chaosDropRate) || this.chaosDropRate < 0 || this.chaosDropRate > 1) {
      throw new RangeError("delta chaos dropRate must be between 0 and 1");
    }
    this.chaosRandom = chaos?.random ?? Math.random;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  get chaosStats(): DeltaChaosStats {
    return {
      deltaMessagesConsidered: this.chaosConsidered,
      deltaMessagesDropped: this.chaosDropped,
      droppedByTab: Object.fromEntries(this.chaosDroppedByTab),
    };
  }

  addViewer(viewer: ViewerConn): void {
    // A join payload already includes every event currently buffered by its hubs. Flushing first
    // prevents the new viewer from receiving those same events again when a pending batch fires.
    this.flushAll();
    viewer.setBeforeResync(() => this.flushAll());
    this.viewers.add(viewer);
    viewer.sendJoinPayload();
  }

  removeViewer(viewer: ViewerConn): void {
    if (this.viewers.delete(viewer)) {
      viewer.setBeforeResync(undefined);
      viewer.dispose();
    }
  }

  publish(msg: Down): void {
    if (msg.t !== "delta" || msg.data.length === 0) {
      if ("tab" in msg) this.flushTab(msg.tab);
      this.broadcastNow(msg);
      return;
    }

    const pending = this.pending.get(msg.tab);
    if (
      pending !== undefined &&
      pending.msg.epoch === msg.epoch &&
      msg.seq === pending.msg.seq + pending.msg.data.length
    ) {
      pending.msg.data.push(...msg.data);
      return;
    }

    this.flushTab(msg.tab);
    const batched: Extract<Down, { t: "delta" }> = { ...msg, data: [...msg.data] };
    const timer = setTimeout(() => this.flushTab(msg.tab), this.batchMs);
    timer.unref();
    this.pending.set(msg.tab, { msg: batched, timer });
  }

  flushAll(): void {
    for (const tabId of [...this.pending.keys()]) this.flushTab(tabId);
  }

  close(): void {
    this.flushAll();
    for (const viewer of this.viewers) {
      viewer.setBeforeResync(undefined);
      viewer.dispose();
    }
    this.viewers.clear();
  }

  private flushTab(tabId: string): void {
    const pending = this.pending.get(tabId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(tabId);
    this.broadcastNow(pending.msg);
  }

  private broadcastNow(msg: Down): void {
    const serialized = encodeMsg(msg);
    for (const viewer of this.viewers) {
      if (msg.t === "delta" && this.chaosDropRate > 0) {
        this.chaosConsidered += 1;
        if (this.chaosRandom() < this.chaosDropRate) {
          this.chaosDropped += 1;
          this.chaosDroppedByTab.set(msg.tab, (this.chaosDroppedByTab.get(msg.tab) ?? 0) + 1);
          continue;
        }
      }
      viewer.send(msg, serialized);
    }
  }
}

export type UpgradeGuard = (request: IncomingMessage) => boolean | Promise<boolean>;

export interface WsServerOpts {
  /** Pass Fastify's `fastify.server`; integration retains ownership of the composition root. */
  server: HttpServer;
  hubs(): Iterable<TabHub>;
  path?: string;
  batchMs?: number;
  viewerConn?: ViewerConnOpts;
  /** Test-only application-frame RTT shim; half is applied in each WS direction. */
  simulatedRttMs?: number;
  /** Test-only per-viewer delta loss. Omitted in every production composition. */
  deltaChaos?: DeltaChaosOptions;
  authorizeUpgrade?: UpgradeGuard;
  onUp?: (viewer: ViewerConn, msg: Up) => void | Promise<void>;
  onConnection?: (viewer: ViewerConn, request: IncomingMessage) => void;
  onDisconnection?: (viewer: ViewerConn) => void;
}

export interface WsServer {
  readonly fanout: Fanout;
  readonly webSocketServer: WebSocketServer;
  close(): Promise<void>;
}

export function createWsServer(opts: WsServerOpts): WsServer {
  const path = opts.path ?? "/ws";
  const simulatedRttMs = opts.simulatedRttMs ?? 0;
  if (!Number.isSafeInteger(simulatedRttMs) || simulatedRttMs < 0) {
    throw new RangeError("simulatedRttMs must be a non-negative safe integer");
  }
  const oneWayDelayMs = simulatedRttMs / 2;
  const fanout = new Fanout(opts.batchMs, opts.deltaChaos);
  const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: true });

  const joinPayload = (): Down[] => [...opts.hubs()].flatMap((hub) => hub.joinPayload());

  webSocketServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const viewerSocket: ViewerSocket =
      oneWayDelayMs === 0 ? socket : new DelayedViewerSocket(socket, oneWayDelayMs);
    const viewer = new ViewerConn(viewerSocket, joinPayload, opts.viewerConn);
    opts.onConnection?.(viewer, request);
    fanout.addViewer(viewer);

    socket.on("message", (data, isBinary) => {
      delay(oneWayDelayMs, () => {
        if (socket.readyState !== socket.OPEN) return;
        if (isBinary) {
          socket.close(1003, "text messages only");
          return;
        }
        let msg: Up;
        try {
          msg = decodeUp(data.toString());
        } catch {
          socket.close(1003, "invalid message");
          return;
        }
        if (msg.t === "ping") {
          const pong: Extract<Down, { t: "pong" }> = {
            t: "pong",
            id: msg.id,
            sentTs: msg.sentTs,
            serverTs: Date.now(),
          };
          viewer.send(pong, encodeMsg(pong));
          return;
        }
        Promise.resolve(opts.onUp?.(viewer, msg)).catch(() => socket.close(1011, "handler failed"));
      });
    });
    socket.once("close", () => {
      try {
        opts.onDisconnection?.(viewer);
      } finally {
        fanout.removeViewer(viewer);
      }
    });
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void handleUpgrade(request, socket, head);
  };

  const handleUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    const requestPath = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
    if (requestPath !== path) {
      rejectUpgrade(socket, "404 Not Found");
      return;
    }

    let authorized = true;
    try {
      authorized = (await opts.authorizeUpgrade?.(request)) ?? true;
    } catch {
      authorized = false;
    }
    if (!authorized) {
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      webSocketServer.emit("connection", ws, request);
    });
  };

  opts.server.on("upgrade", onUpgrade);

  return {
    fanout,
    webSocketServer,
    close: async () => {
      opts.server.off("upgrade", onUpgrade);
      fanout.close();
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

class DelayedViewerSocket implements ViewerSocket {
  constructor(
    private readonly socket: WebSocket,
    private readonly delayMs: number,
  ) {}

  get readyState(): number {
    return this.socket.readyState;
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  set bufferedAmount(_value: number) {
    // `ws` owns this counter; ViewerSocket keeps it writable only for the fan-out test double.
  }

  send(data: string): void {
    delay(this.delayMs, () => {
      if (this.socket.readyState === this.socket.OPEN) this.socket.send(data);
    });
  }
}

function delay(delayMs: number, callback: () => void): void {
  if (delayMs === 0) {
    callback();
    return;
  }
  const timer = setTimeout(callback, delayMs);
  timer.unref();
}

function rejectUpgrade(socket: Duplex, status: "401 Unauthorized" | "404 Not Found"): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
