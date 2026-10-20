import assert from "node:assert/strict";
import test from "node:test";

import { innerTextSimilarity, scoreSnapshots } from "./score";
import type { DomSnapshot } from "./types";

const snapshot: DomSnapshot = {
  text: "A stable   content page\nwith controls",
  elementCount: 5,
  tagCounts: { main: 1, p: 2, input: 1, select: 1 },
  imageCount: 0,
  controls: {
    "top#field": { kind: "input:text", value: "alpha", checked: false },
  },
  activeElement: "top#field|input:text",
  scroll: { "top::window": { x: 0, y: 120 } },
};

test("normalizes whitespace before measuring innerText", () => {
  assert.equal(innerTextSimilarity("alpha\n beta", "alpha beta"), 1);
});

test("an exact static and interaction snapshot scores 100%", () => {
  assert.equal(scoreSnapshots(snapshot, structuredClone(snapshot), "static").score, 1);
  assert.equal(scoreSnapshots(snapshot, structuredClone(snapshot), "post-interaction").score, 1);
});

test("text loss and interaction divergence lower the gate score", () => {
  const broken = structuredClone(snapshot);
  broken.text = "";
  broken.controls["top#field"]!.value = "phantom";
  broken.activeElement = null;
  broken.scroll["top::window"]!.y = 0;
  const diff = scoreSnapshots(snapshot, broken, "post-interaction");
  assert(diff.score < 0.5);
  assert.deepEqual(diff.differences.controls, ["top#field"]);
  assert(diff.differences.activeElement);
  assert.deepEqual(diff.differences.scroll, ["top::window"]);
});
