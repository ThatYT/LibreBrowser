// @vitest-environment node
import type { ComponentChildren, VNode } from "preact";
import { describe, expect, it } from "vitest";
import { Hud, HudLayer, type HudProps } from "./hud";

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

const props: HudProps = {
  connection: "open",
  rttMs: 42.4,
  bufferMs: 93,
  activeTab: "tab-b",
  tabs: [
    { id: "tab-a", title: "First", url: "https://first.test/", active: false },
    { id: "tab-b", title: "Second", url: "https://second.test/", active: true },
  ],
  modeByTab: { "tab-a": "dom", "tab-b": "px" },
  resyncByTab: {
    "tab-a": {
      tab: "tab-a",
      totalResyncs: 2,
      recentResyncs: 1,
      pending: false,
      backoffMs: 0,
      storm: false,
    },
    "tab-b": {
      tab: "tab-b",
      totalResyncs: 4,
      recentResyncs: 3,
      pending: false,
      backoffMs: 0,
      storm: true,
    },
  },
  viewerId: "viewer-me",
  driverId: "viewer-me",
};

describe("P3-HUD", () => {
  it("renders RTT, adaptive buffer, driver, per-tab modes, resyncs, and the auto-px flag", () => {
    const tree = Hud(props);
    const nodes = descendants(tree);
    const allText = textContent(tree);

    expect(tree.type).toBe("details");
    expect(tree.props).toMatchObject({
      id: "resync-hud",
      "data-connection": "open",
      "data-rtt-ms": "42",
      "data-resync-total": "6",
      "data-resync-storm": "true",
      "data-resync-storm-tabs": "tab-b",
    });
    expect(allText).toContain("42 ms");
    expect(allText).toContain("93 ms");
    expect(allText).toContain("viewer-me (you)");
    expect(allText).toContain("Firstdom2 resync");
    expect(allText).toContain("Secondpx4 resync");
    expect(allText).toContain("This page could not be mirrored reliably. Reload or choose pixel fallback.: tab-b");
    expect(nodes.some((node) => node.type === "iframe")).toBe(false);
  });

  it("mounts in a dedicated toggleable layer outside the mirror document", () => {
    const layer = HudLayer(props);
    expect(layer.type).toBe("aside");
    expect(layer.props.id).toBe("viewer-hud-layer");
    expect(descendants(Hud(props)).some((node) => node.type === "iframe")).toBe(false);
    expect(Hud(props).type).toBe("details");
  });
});
