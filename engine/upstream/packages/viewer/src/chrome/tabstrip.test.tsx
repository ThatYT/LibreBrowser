// @vitest-environment node
import type { ComponentChildren, VNode } from "preact";
import type { Down, Up } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import { TabStrip } from "./tabstrip";

type TestVNode = VNode<Record<string, unknown>>;

function children(node: VNode): TestVNode[] {
  const result: TestVNode[] = [];
  const visit = (value: ComponentChildren): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (value !== null && typeof value === "object" && "props" in value) {
      const vnode = value as TestVNode;
      result.push(vnode);
      visit(vnode.props.children as ComponentChildren);
    }
  };
  visit(node.props.children as ComponentChildren);
  return result;
}

describe("P2 viewer tab strip", () => {
  it("renders tabs, proxied favicons, active/loading state, and emits lifecycle actions", () => {
    const tabs: Extract<Down, { t: "tabs" }>["tabs"] = [
      {
        id: "tab-a",
        title: "First",
        url: "https://first.example/old",
        favicon: "/s/session/a/proxied-a",
        active: false,
      },
      {
        id: "tab-b",
        title: "Second",
        url: "https://second.example/old",
        favicon: "/s/session/a/proxied-b",
        active: true,
      },
    ];
    const sent: Up[] = [];
    const activated = vi.fn();
    const tree = TabStrip({
      tabs,
      chromeByTab: {
        "tab-b": {
          t: "chrome",
          tab: "tab-b",
          url: "https://second.example/current",
          loading: true,
          canBack: true,
          canFwd: false,
        },
      },
      send: (message) => sent.push(message),
      onActivate: activated,
    });
    const descendants = children(tree);
    const renderedTabs = descendants.filter((node) => node.props.role === "tab");
    const images = descendants.filter((node) => node.type === "img");
    const tabContainers = descendants.filter((node) => node.props.className === "browser-tab");

    expect(renderedTabs).toHaveLength(2);
    expect(images.map((node) => node.props.src)).toEqual([
      "/s/session/a/proxied-a",
      "/s/session/a/proxied-b",
    ]);
    const failedImage = { hidden: false };
    (images[0]?.props.onError as (event: { currentTarget: { hidden: boolean } }) => void)({
      currentTarget: failedImage,
    });
    expect(failedImage.hidden).toBe(true);
    (images[0]?.props.onLoad as (event: { currentTarget: { hidden: boolean } }) => void)({
      currentTarget: failedImage,
    });
    expect(failedImage.hidden).toBe(false);
    expect(renderedTabs.map((node) => node.props["aria-selected"])).toEqual([false, true]);
    expect(renderedTabs[1]?.props.title).toBe("https://second.example/current");
    expect(tabContainers[1]?.props["data-loading"]).toBe(true);

    (renderedTabs[0]?.props.onClick as () => void)();
    const close = descendants.find(
      (node) => node.props.className === "tab-close" && node.props["aria-label"] === "Close First",
    );
    (close?.props.onClick as () => void)();
    const newTab = descendants.find((node) => node.props.id === "new-tab");
    (newTab?.props.onClick as () => void)();

    expect(activated).toHaveBeenCalledWith("tab-a");
    expect(sent).toEqual([
      { t: "nav", tab: "tab-a", action: "activate" },
      { t: "nav", tab: "tab-a", action: "close" },
      { t: "nav", tab: "tab-b", action: "newtab" },
    ]);
  });

  it("keeps New tab enabled and sends newtab when there are no tabs", () => {
    const sent: Up[] = [];
    const tree = TabStrip({ tabs: [], send: (message) => sent.push(message) });
    const newTab = children(tree).find((node) => node.props.id === "new-tab");

    expect(newTab?.props.disabled).toBeUndefined();
    (newTab?.props.onClick as () => void)();

    expect(sent).toEqual([{ t: "nav", tab: "", action: "newtab" }]);
  });
});
