import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeDown, encodeMsg } from "@mirror/protocol";
import WebSocket, { type RawData } from "ws";
import { describe, expect, it, vi } from "vitest";
import { createWsServer } from "./server";

describe("P3-HUD application RTT", () => {
  it("echoes ping identifiers and timestamps immediately with a gateway timestamp", async () => {
    const server = createServer();
    const onUp = vi.fn();
    const wsServer = createWsServer({ server, hubs: () => [], onUp });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });
    const port = (server.address() as AddressInfo).port;
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      const response = new Promise<RawData>((resolve) => client.once("message", resolve));
      const before = Date.now();
      client.send(encodeMsg({ t: "ping", id: 17, sentTs: 12_345 }));
      const pong = decodeDown((await response).toString());
      const after = Date.now();

      expect(pong).toMatchObject({ t: "pong", id: 17, sentTs: 12_345 });
      expect(pong.t === "pong" && pong.serverTs).toBeGreaterThanOrEqual(before);
      expect(pong.t === "pong" && pong.serverTs).toBeLessThanOrEqual(after);
      expect(onUp).not.toHaveBeenCalled();
    } finally {
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      client.close();
      await closed;
      await wsServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
