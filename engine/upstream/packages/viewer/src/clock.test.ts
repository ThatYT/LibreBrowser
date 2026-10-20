import { describe, expect, it } from "vitest";
import { createServerClock } from "./clock";

describe("server clock live baseline", () => {
  it("uses a 50ms default for LibreBrowser interactive rendering", () => {
    expect(createServerClock().liveBufferMs()).toBe(50);
  });
  it.each([-5_000, 8_000])(
    "keeps effective delay at the buffer with a viewer clock offset of %dms",
    (viewerOffset) => {
      let serverNow = 100_000;
      const oneWayMs = 20;
      const localNow = () => serverNow + viewerOffset;
      const clock = createServerClock({
        now: localNow,
        bufferMs: 180,
        minBufferMs: 180,
      });

      clock.observeRtt(oneWayMs * 2);
      // The gateway stamped this before the simulated one-way network trip.
      clock.observeServerTime(serverNow - oneWayMs, localNow());

      expect(clock.estimatedServerNow()).toBe(serverNow);
      expect(clock.estimatedServerNow() - clock.liveBaseline()).toBe(180);
    },
  );

  it("lowers the old 300ms ceiling when measured RTT permits", () => {
    const clock = createServerClock({ now: () => 10_000, bufferMs: 300 });
    expect(clock.liveBufferMs()).toBe(300);

    clock.observeRtt(25);
    expect(clock.liveBufferMs()).toBe(75);

    clock.observeRtt(400);
    expect(clock.liveBufferMs()).toBe(75);
  });
});
