import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServerClock } from "./clock";
import { connectGateway, RTT_INTERVAL_MS } from "./ws";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("computes recurring pong RTT and feeds the live server clock", () => {
  let now = 1_000;
  const samples: number[] = [];
  const received: unknown[] = [];
  const sent: string[] = [];
  const clock = createServerClock({ now: () => now, bufferMs: 300 });
  const socket = {
    readyState: 1,
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    send: (data: string) => sent.push(data),
    close: () => {},
  };
  const gateway = connectGateway(
    "ws://example.test/ws",
    (message) => {
      received.push(message);
      if (message.t === "pong") clock.observeServerTime(message.serverTs, now);
    },
    {
      now: () => now,
      onRttSample: (rttMs) => {
        samples.push(rttMs);
        clock.observeRtt(rttMs);
      },
      socketFactory: () => socket,
    },
  );

  socket.onopen?.();
  vi.advanceTimersByTime(RTT_INTERVAL_MS - 1);
  expect(sent).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(sent.map((raw) => JSON.parse(raw))).toEqual([{ t: "ping", id: 1, sentTs: 1_000 }]);

  now = 1_042;
  socket.onmessage?.({
    data: JSON.stringify({ t: "pong", id: 1, sentTs: 1_000, serverTs: 1_021 }),
  });

  expect(samples).toEqual([42]);
  expect(received).toEqual([{ t: "pong", id: 1, sentTs: 1_000, serverTs: 1_021 }]);
  expect(clock.liveBufferMs()).toBe(92);
  expect(clock.estimatedServerNow()).toBe(1_042);

  vi.advanceTimersByTime(RTT_INTERVAL_MS);
  expect(sent.map((raw) => JSON.parse(raw)).at(-1)).toEqual({
    t: "ping",
    id: 2,
    sentTs: 1_042,
  });
  gateway.close();
});

it("ignores pong samples that do not match the outstanding probe", () => {
  const samples: number[] = [];
  const socket = {
    readyState: 1,
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    send: (_data: string) => {},
    close: () => {},
  };
  const gateway = connectGateway("ws://example.test/ws", () => {}, {
    onRttSample: (rttMs) => samples.push(rttMs),
    socketFactory: () => socket,
  });
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({ t: "pong", id: 99, sentTs: 0, serverTs: 1 }),
  });
  expect(samples).toEqual([]);
  gateway.close();
});
