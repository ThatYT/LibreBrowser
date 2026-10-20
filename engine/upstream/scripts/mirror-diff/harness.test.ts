import assert from "node:assert/strict";
import test from "node:test";

import { isTransientInfraFailure } from "./harness";

test("classifies only known infrastructure failures as transient", () => {
  assert.equal(
    isTransientInfraFailure(new Error("locator.waitFor: Timeout 60000ms exceeded")),
    true,
  );
  assert.equal(isTransientInfraFailure(new Error("recorder not ready; retry snapshot")), true);
  assert.equal(
    isTransientInfraFailure(new Error("listen EADDRINUSE: address already in use")),
    true,
  );
  assert.equal(isTransientInfraFailure(new Error("static score 90.0% < 97.0%")), false);
  assert.equal(isTransientInfraFailure(new Error("observed 1 vx/vy rect fallbacks")), false);
  assert.equal(isTransientInfraFailure(new Error("server value did not match mirror")), false);
});

test("fault probes are never transient even when they fail through a timeout", () => {
  const previous = process.env.P2_DIFF_FAULT;
  process.env.P2_DIFF_FAULT = "drop-child-frame";
  try {
    assert.equal(
      isTransientInfraFailure(new Error("locator.waitFor: Timeout 60000ms exceeded")),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.P2_DIFF_FAULT;
    else process.env.P2_DIFF_FAULT = previous;
  }
});
