// @vitest-environment node
import type { ComponentChildren, VNode } from "preact";
import type { Up } from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import { Presence } from "./presence";

type TestVNode = VNode<Record<string, unknown>>;

function descendants(root: VNode): TestVNode[] {
  const result: TestVNode[] = [];
  const visit = (value: ComponentChildren): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (value !== null && typeof value === "object" && "props" in value) {
      const node = value as TestVNode;
      result.push(node);
      visit(node.props.children as ComponentChildren);
    }
  };
  visit(root.props.children as ComponentChildren);
  return result;
}

function textContent(value: ComponentChildren): string {
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "object" && "props" in value) {
    return textContent((value as TestVNode).props.children as ComponentChildren);
  }
  return String(value);
}

describe("P3-VIEWERS-V", () => {
  it("renders presence and driver state and lets a follower request control", () => {
    const sent: Up[] = [];
    const tree = Presence({
      viewers: [
        { id: "viewer-driver", name: "Avery" },
        { id: "viewer-me", name: "Morgan" },
      ],
      viewerId: "viewer-me",
      driverId: "viewer-driver",
      send: (message) => sent.push(message),
    });
    const nodes = descendants(tree);
    const request = nodes.find(
      (node) => node.type === "button" && node.props.class === "request-driver",
    );

    expect(tree.type).toBe("section");
    expect(tree.props).toMatchObject({
      id: "presence-chrome",
      "data-viewer-role": "follower",
    });
    expect(textContent(tree)).toContain("AveryDriver");
    expect(textContent(tree)).toContain("Morgan (you)");
    expect(
      nodes.find((node) => node.props["data-viewer-id"] === "viewer-driver")?.props,
    ).toMatchObject({ "data-driver": "true" });

    (request?.props.onClick as () => void)();
    expect(sent).toEqual([{ t: "driver-transfer", to: "viewer-me" }]);
    expect(nodes.some((node) => node.type === "iframe")).toBe(false);
  });
});
