import { describe, expect, it } from "vitest";

import type { TargetRef } from "../types";
import { TargetRegistry } from "./targets";

function target(
  targetId: string,
  type: TargetRef["type"],
  sessionId = `session-${targetId}`,
): TargetRef {
  return { targetId, sessionId, type };
}

describe("TargetRegistry", () => {
  it("tracks attached targets and returns only top-level pages as tabs", () => {
    const registry = new TargetRegistry();
    const page = target("page-1", "page");
    const iframe = target("frame-1", "iframe");

    registry.add(page);
    registry.add(iframe);

    expect([...registry.targets.values()]).toEqual([page, iframe]);
    expect(registry.tabs()).toEqual([page]);
  });

  it("replaces a target's flat session after a process swap", () => {
    const registry = new TargetRegistry();
    registry.add(target("frame-1", "iframe", "old-session"));
    registry.add(target("frame-1", "iframe", "new-session"));

    expect(registry.targets.get("frame-1")?.sessionId).toBe("new-session");
    expect(registry.targets).toHaveLength(1);
  });

  it("removes detached targets", () => {
    const registry = new TargetRegistry();
    registry.add(target("page-1", "page"));

    registry.remove("page-1");

    expect(registry.targets.size).toBe(0);
    expect(registry.tabs()).toEqual([]);
  });
});
