// @vitest-environment node
import type { ComponentChildren, VNode } from "preact";
import { describe, expect, it, vi } from "vitest";
import { ClipboardPrompt } from "./clipboard";

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

describe("P3-CLIP-V", () => {
  it("writes a clip Down payload to the local clipboard only when its button is clicked", async () => {
    const writeText = vi.fn(async () => undefined);
    const onCopied = vi.fn();
    const tree = ClipboardPrompt({ text: "copied remotely", writeText, onCopied });
    const nodes = descendants(tree);
    const button = nodes.find((node) => node.type === "button");

    expect(tree.type).toBe("aside");
    expect(tree.props.id).toBe("clipboard-prompt-layer");
    expect(writeText).not.toHaveBeenCalled();

    await (button?.props.onClick as () => Promise<void>)();

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("copied remotely");
    expect(onCopied).toHaveBeenCalledOnce();
    expect(nodes.some((node) => node.type === "iframe")).toBe(false);
  });
});
