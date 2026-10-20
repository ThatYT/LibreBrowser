// @vitest-environment node
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import { createCanvasCompositor } from "./canvas";

function snapshotEvent(id: number, base64 = "AQIDBA=="): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1_000,
    data: {
      source: IncrementalSource.CanvasMutation,
      id,
      type: 0,
      commands: [
        { property: "clearRect", args: [0, 0, 320, 180] },
        {
          property: "drawImage",
          args: [
            {
              rr_type: "ImageBitmap",
              args: [
                {
                  rr_type: "Blob",
                  data: [{ rr_type: "ArrayBuffer", base64 }],
                  type: "image/webp",
                },
              ],
            },
            0,
            0,
          ],
        },
      ],
    },
  } as eventWithTime;
}

describe("canvas snapshot compositor", () => {
  it("decodes a sampled bitmap and paints the current mirror canvas", async () => {
    const bitmap = { close: vi.fn() } as unknown as CanvasImageSource & { close(): void };
    const context = { clearRect: vi.fn(), drawImage: vi.fn() };
    const canvas = {
      nodeType: 1,
      nodeName: "CANVAS",
      getContext: vi.fn(() => context),
    };
    const getNode = vi.fn((id: number) => (id === 17 ? canvas : null));
    const mirror = {
      getReplayer: () => ({ getMirror: () => ({ getNode }) }),
    } as never;
    const decodeBitmap = vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe("image/webp");
      expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
      return bitmap;
    });
    const compositor = createCanvasCompositor(mirror, { decodeBitmap });

    await expect(compositor.apply(snapshotEvent(17))).resolves.toBe(true);

    expect(getNode).toHaveBeenCalledWith(17);
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 320, 180);
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("ignores arbitrary canvas commands while unsafe replay remains disabled", async () => {
    const compositor = createCanvasCompositor({ getReplayer: () => null });
    const event = snapshotEvent(17) as unknown as {
      data: { commands: { property: string; args: unknown[] }[] };
    };
    event.data.commands = [{ property: "fillText", args: ["not replayed", 0, 0] }];

    await expect(compositor.apply(event as unknown as eventWithTime)).resolves.toBe(false);
  });

  it("coalesces stale pending frames when bitmap decoding falls behind", async () => {
    const resolvers: ((bitmap: CanvasImageSource) => void)[] = [];
    const decodeBitmap = vi.fn(
      () => new Promise<CanvasImageSource>((resolve) => resolvers.push(resolve)),
    );
    const context = { clearRect: vi.fn(), drawImage: vi.fn() };
    const canvas = { nodeType: 1, nodeName: "CANVAS", getContext: () => context };
    const mirror = {
      getReplayer: () => ({ getMirror: () => ({ getNode: () => canvas }) }),
    } as never;
    const compositor = createCanvasCompositor(mirror, { decodeBitmap });

    const first = compositor.apply(snapshotEvent(17, "AQ=="));
    const stale = compositor.apply(snapshotEvent(17, "Ag=="));
    const latest = compositor.apply(snapshotEvent(17, "Aw=="));
    await expect(stale).resolves.toBe(false);
    expect(decodeBitmap).toHaveBeenCalledOnce();

    resolvers.shift()!({} as CanvasImageSource);
    await expect(first).resolves.toBe(true);
    await vi.waitFor(() => expect(decodeBitmap).toHaveBeenCalledTimes(2));
    resolvers.shift()!({} as CanvasImageSource);
    await expect(latest).resolves.toBe(true);
    expect(context.drawImage).toHaveBeenCalledTimes(2);
  });
});
