// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EventType, type eventWithTime } from "@mirror/protocol";
import { extractSnapshotViewport, fitViewportScale } from "./mirror";

describe("P1 viewer viewport helpers", () => {
  it("fits the driver viewport inside a follower without changing its aspect ratio", () => {
    expect(fitViewportScale(1_600, 900, 800, 700)).toBe(0.5);
    expect(fitViewportScale(800, 600, 1_600, 1_200)).toBe(2);
  });

  it("reads authoritative CSS dimensions from the rrweb Meta event", () => {
    const meta = {
      type: EventType.Meta,
      timestamp: 1,
      data: { href: "https://example.test", width: 1_280, height: 720 },
    } as eventWithTime;
    expect(extractSnapshotViewport({ data: [meta] })).toEqual({ w: 1_280, h: 720 });
  });
});
