// @vitest-environment node
import { BINDING_NAME, ChunkReassembler } from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureClipboardWrite, installClipboardHooks } from "./clipboard";
import { createEmitter } from "./emit";

afterEach(() => vi.unstubAllGlobals());

class FakeWindow {
  private readonly copyListeners = new Set<(event: CopyEventLike) => void>();
  selection = "";

  addEventListener(_type: "copy", listener: (event: CopyEventLike) => void): void {
    this.copyListeners.add(listener);
  }

  removeEventListener(_type: "copy", listener: (event: CopyEventLike) => void): void {
    this.copyListeners.delete(listener);
  }

  getSelection(): { toString(): string } {
    return { toString: () => this.selection };
  }

  copy(event: CopyEventLike = {}): void {
    for (const listener of this.copyListeners) listener(event);
  }
}

interface CopyEventLike {
  clipboardData?: { getData(format: string): string } | null;
  target?: EventTarget | null;
}

describe("clipboard hooks", () => {
  it("uses the writeText reference captured at init and emits a clip AgentMsg", async () => {
    const nativeWrite = vi.fn(async (_text: string) => undefined);
    const pageReplacement = vi.fn(async (_text: string) => undefined);
    const clipboard = { writeText: nativeWrite };
    const capturedWrite = captureClipboardWrite({ clipboard });

    // A page can replace the live method after the agent's first synchronous capture.
    clipboard.writeText = pageReplacement;
    const chunks: string[] = [];
    vi.stubGlobal("window", { [BINDING_NAME]: (payload: string) => chunks.push(payload) });
    const cleanup = installClipboardHooks({
      capturedWrite,
      emitter: createEmitter(77),
      window: new FakeWindow(),
    });

    await clipboard.writeText("copied by the server page");
    await Promise.resolve();

    expect(nativeWrite).toHaveBeenCalledWith("copied by the server page");
    expect(pageReplacement).not.toHaveBeenCalled();
    const reassembler = new ChunkReassembler();
    expect(chunks.map((chunk) => reassembler.add(chunk)).filter(Boolean)).toEqual([
      { kind: "clip", docId: 77, text: "copied by the server page" },
    ]);
    cleanup();
  });

  it("observes native copy text without canceling or changing the event", () => {
    const view = new FakeWindow();
    view.selection = "native selection";
    const clips: string[] = [];
    const event = {
      clipboardData: { getData: vi.fn(() => "") },
    };
    const cleanup = installClipboardHooks({
      capturedWrite: null,
      emitter: { emitClipboard: (text) => clips.push(text) },
      window: view,
    });

    view.copy(event);

    expect(clips).toEqual(["native selection"]);
    expect(event).toEqual({ clipboardData: { getData: expect.any(Function) } });
    cleanup();
  });
});
