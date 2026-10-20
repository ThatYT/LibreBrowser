import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectGateway } from "../src/ws";

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(value: unknown) {
    this.onmessage?.({ data: value });
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("connectGateway", () => {
  beforeEach(() => vi.useFakeTimers());

  it("queues typed messages until open and decodes Down messages", () => {
    const sockets: FakeSocket[] = [];
    const received: unknown[] = [];
    const gateway = connectGateway("ws://example.test/ws", (message) => received.push(message), {
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    gateway.send({ t: "resync-req", tab: "T1", reason: "test" });
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.open();
    expect(sockets[0]!.sent.map(JSON.parse)).toEqual([
      { t: "resync-req", tab: "T1", reason: "test" },
    ]);

    sockets[0]!.receive(JSON.stringify({ t: "snapshot", tab: "T1", epoch: 1, seq: 1, data: [] }));
    expect(received).toEqual([{ t: "snapshot", tab: "T1", epoch: 1, seq: 1, data: [] }]);
    gateway.close();
  });

  it("reconnects without a resume cursor and reports a restored connection", () => {
    const sockets: FakeSocket[] = [];
    const states: Array<[string, boolean]> = [];
    const gateway = connectGateway("ws://example.test/ws", () => {}, {
      reconnectDelayMs: 25,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onStateChange: (state, reconnected) => states.push([state, reconnected]),
    });

    sockets[0]!.open();
    sockets[0]!.close();
    vi.advanceTimersByTime(25);
    sockets[1]!.open();

    expect(states).toEqual([
      ["connecting", false],
      ["open", false],
      ["closed", true],
      ["connecting", true],
      ["open", true],
    ]);
    gateway.close();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
  });

  it("lets reconnect send view before flushing input queued while disconnected", () => {
    const sockets: FakeSocket[] = [];
    let gateway: ReturnType<typeof connectGateway>;
    gateway = connectGateway("ws://example.test/ws", () => {}, {
      reconnectDelayMs: 25,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onStateChange(state, reconnected) {
        if (state === "open" && reconnected) {
          gateway.send({ t: "view", tab: "T1", w: 1280, h: 720, dpr: 1 });
          gateway.send({ t: "resync-req", tab: "T1", reason: "ws reconnect" });
        }
      },
    });
    sockets[0]!.open();
    sockets[0]!.close();
    gateway.send({
      t: "key",
      tab: "T1",
      kind: "down",
      key: "a",
      code: "KeyA",
      mods: 0,
    });
    vi.advanceTimersByTime(25);
    sockets[1]!.open();

    expect(sockets[1]!.sent.map(JSON.parse)).toEqual([
      { t: "view", tab: "T1", w: 1280, h: 720, dpr: 1 },
      { t: "resync-req", tab: "T1", reason: "ws reconnect" },
      { t: "key", tab: "T1", kind: "down", key: "a", code: "KeyA", mods: 0 },
    ]);
    gateway.close();
  });

  it("contains malformed wire data at the decode choke point", () => {
    const socket = new FakeSocket();
    const errors: string[] = [];
    const gateway = connectGateway("ws://example.test/ws", () => {}, {
      socketFactory: () => socket,
      onProtocolError: (error) => errors.push(error.message),
    });
    socket.open();
    socket.receive("not json");
    expect(errors).toEqual(["Down: not JSON"]);
    gateway.close();
  });
});
