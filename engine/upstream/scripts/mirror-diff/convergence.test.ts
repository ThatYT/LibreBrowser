import assert from "node:assert/strict";
import test from "node:test";

import { pollForStableConvergence } from "./convergence";

test("returns the sample only after matched state holds for the settle window", async () => {
  let now = 0;
  let reads = 0;
  const result = await pollForStableConvergence({
    read: async () => {
      reads += 1;
      return reads < 3 ? { server: 10, mirror: 0 } : { server: 10, mirror: 10 };
    },
    matches: ({ server, mirror }) => server === mirror,
    sameState: (left, right) => left === right,
    timeoutMs: 4_000,
    settleMs: 300,
    pollMs: 100,
    now: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
    },
  });

  assert.equal(result.converged, true);
  assert.deepEqual(result.sample, { server: 10, mirror: 10 });
  assert.equal(result.elapsedMs, 500);
});

test("returns the final mismatched sample when the bound expires", async () => {
  let now = 0;
  let reads = 0;
  const result = await pollForStableConvergence({
    read: async () => ({ server: ++reads, mirror: -reads }),
    matches: ({ server, mirror }) => server === mirror,
    sameState: (left, right) => left === right,
    timeoutMs: 400,
    settleMs: 300,
    pollMs: 100,
    now: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
    },
  });

  assert.equal(result.converged, false);
  assert.deepEqual(result.sample, { server: 5, mirror: -5 });
  assert.equal(result.elapsedMs, 400);
});
