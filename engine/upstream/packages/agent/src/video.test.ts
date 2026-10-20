// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { captureMediaKeySystemAccess, installVideoDrmMonitor } from "./video";

function documentHarness() {
  let encrypted: ((event: Event) => void) | undefined;
  return {
    document: {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "encrypted") encrypted = listener as (event: Event) => void;
      },
    } as unknown as Document,
    encrypted: (target: EventTarget) => encrypted?.({ target } as Event),
  };
}

describe("agent video DRM monitor", () => {
  it("detects encrypted video events and reports the rrweb node id", () => {
    const h = documentHarness();
    const onBlocked = vi.fn();
    const video = { nodeType: 1, nodeName: "VIDEO" } as unknown as HTMLVideoElement;
    const monitor = installVideoDrmMonitor({
      document: h.document,
      navigator: {} as Navigator,
      onBlocked,
    });
    monitor.plugin.getMirror({ nodeMirror: { getId: (node) => (node === video ? 44 : -1) } });

    h.encrypted(video);

    expect(onBlocked).toHaveBeenCalledWith(44);
  });

  it("hooks EME with the function captured at initialization and preserves its result", async () => {
    const access = { keySystem: "org.example.keys" } as unknown as MediaKeySystemAccess;
    const original = vi.fn(async () => access);
    const clobbered = vi.fn();
    const navigator = {
      requestMediaKeySystemAccess: original,
    } as unknown as Navigator;
    const captured = captureMediaKeySystemAccess(navigator);
    navigator.requestMediaKeySystemAccess = clobbered;
    const onBlocked = vi.fn();

    installVideoDrmMonitor({
      document: documentHarness().document,
      navigator,
      requestMediaKeySystemAccess: captured,
      onBlocked,
    });

    await expect(navigator.requestMediaKeySystemAccess("org.example.keys", [])).resolves.toBe(
      access,
    );
    expect(onBlocked).toHaveBeenCalledWith();
    expect(original).toHaveBeenCalledWith("org.example.keys", []);
    expect(clobbered).not.toHaveBeenCalled();
  });
});
