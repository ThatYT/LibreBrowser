// @vitest-environment node
import type { ComponentChildren, VNode } from "preact";
import type { Down } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import { dismissDownload, DownloadTray, updateDownloads } from "./downloads";

type Download = Extract<Down, { t: "download" }>;
type TestVNode = VNode<Record<string, unknown>>;

function descendants(root: VNode): TestVNode[] {
  const result: TestVNode[] = [];
  const visit = (value: ComponentChildren): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (value !== null && typeof value === "object" && "props" in value) {
      const node = value as TestVNode;
      if (typeof node.type === "function") {
        visit((node.type as (props: Record<string, unknown>) => ComponentChildren)(node.props));
        return;
      }
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
    const node = value as TestVNode;
    if (typeof node.type === "function") {
      return textContent(
        (node.type as (props: Record<string, unknown>) => ComponentChildren)(node.props),
      );
    }
    return textContent(node.props.children as ComponentChildren);
  }
  return String(value);
}

const active: Download = {
  t: "download",
  id: "download-a",
  name: "archive.zip",
  recv: 25,
  total: 100,
  state: "active",
};

describe("P3-DOWNLOADS-V", () => {
  it("renders live filename and progress from download messages outside the mirror iframe", () => {
    const downloads = updateDownloads([], active);
    const tree = DownloadTray({ downloads, onDismiss: vi.fn() });
    const nodes = descendants(tree);
    const progress = nodes.find((node) => node.type === "progress");

    expect(tree.type).toBe("aside");
    expect(tree.props.id).toBe("download-tray-layer");
    expect(textContent(tree)).toContain("archive.zip");
    expect(textContent(tree)).toContain("25% · 25 B of 100 B");
    expect(progress?.props).toMatchObject({ max: 100, value: 25 });
    expect(nodes.some((node) => node.type === "iframe")).toBe(false);
  });

  it("replaces progress in place and exposes the one-time link only on completion", () => {
    const done: Download = {
      ...active,
      recv: 100,
      state: "done",
      href: "/s/session-a/d/one-time-key",
    };
    const downloads = updateDownloads(updateDownloads([], active), done);
    const tree = DownloadTray({ downloads, onDismiss: vi.fn() });
    const nodes = descendants(tree);
    const save = nodes.find((node) => node.type === "a");

    expect(downloads).toHaveLength(1);
    expect(textContent(tree)).toContain("Complete");
    expect(textContent(save as TestVNode)).toBe("Save");
    expect(save?.props).toMatchObject({
      href: "/s/session-a/d/one-time-key",
      download: "archive.zip",
    });
    expect(nodes.some((node) => node.type === "progress")).toBe(false);
  });

  it("dismisses entries through the tray action", () => {
    let downloads = updateDownloads([], active);
    const onDismiss = vi.fn((id: string) => {
      downloads = dismissDownload(downloads, id);
    });
    const tree = DownloadTray({ downloads, onDismiss });
    const dismiss = descendants(tree).find(
      (node) => node.type === "button" && node.props.class === "download-dismiss",
    );

    (dismiss?.props.onClick as () => void)();

    expect(onDismiss).toHaveBeenCalledWith("download-a");
    expect(downloads).toEqual([]);
  });
});
