import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { mintInvite } from "../auth/invite";
import { createSessionGuard, SESSION_COOKIE } from "../auth/middleware";
import { createWsServer } from "./server";

describe("SEC-2 WebSocket upgrade auth", () => {
  it("rejects before upgrade without a valid session cookie and accepts one with it", async () => {
    const key = Buffer.from("sec-2-ws-upgrade-key");
    const now = 5_000;
    const guard = createSessionGuard({ key, now: () => now });
    const server = createServer();
    const wsServer = createWsServer({
      server,
      hubs: () => [],
      authorizeUpgrade: guard.authorizeUpgrade,
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });
    const port = (server.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${port}/ws`;
    let authorized: WebSocket | undefined;

    try {
      expect(await rejectionStatus(url)).toBe(401);

      const token = mintInvite({ sid: "s1", role: "viewer", exp: now + 60 }, key);
      authorized = new WebSocket(url, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
      await new Promise<void>((resolve, reject) => {
        authorized?.once("open", resolve);
        authorized?.once("error", reject);
      });
      expect(wsServer.webSocketServer.clients.size).toBe(1);
    } finally {
      if (authorized !== undefined) {
        const closed = new Promise<void>((resolve) => authorized?.once("close", () => resolve()));
        authorized.close();
        await closed;
      }
      await wsServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});

async function rejectionStatus(url: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    client.once("open", () => reject(new Error("unauthorized WebSocket opened")));
    client.once("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      client.on("error", () => undefined);
      response.destroy();
      resolve(status);
    });
    client.once("error", reject);
  });
}
