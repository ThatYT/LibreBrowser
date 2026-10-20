// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STITCH_READY_MESSAGE_TYPE,
  STITCH_SYNC_MESSAGE_TYPE,
  broadcastStitchSync,
  installStitchReadyListener,
  installStitchSyncListener,
  isCrossOriginChild,
} from "./stitch";
import { createRecordReadiness, type RecordReadiness } from "./commands";

afterEach(() => {
  vi.useRealTimers();
});

interface WindowHarness {
  window: Window;
  dispatch(data: unknown, source?: MessageEventSource | null): void;
}

function windowHarness(frames: Window[] = [], parent?: Window): WindowHarness {
  const listeners = new Set<(event: MessageEvent) => void>();
  const harness = {} as WindowHarness;
  harness.dispatch = (data, source = null) => {
    for (const listener of listeners) listener({ data, source } as MessageEvent);
  };
  harness.window = {
    frames,
    get parent() {
      return parent ?? harness.window;
    },
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MessageEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MessageEvent) => void);
    },
    postMessage: vi.fn((data: unknown) => harness.dispatch(data)),
  } as unknown as Window;
  return harness;
}

function stitchDependencies(
  readiness: RecordReadiness,
  takeFullSnapshot: () => void,
  now?: () => number,
) {
  return {
    isRecorderStarted: readiness.isStarted,
    onRecorderStarted: readiness.onStarted,
    takeFullSnapshot,
    now,
  };
}

describe("stitch-sync", () => {
  it("detects only children whose parent document access throws", () => {
    const top = {} as Window;
    Object.defineProperties(top, {
      parent: { value: top },
      document: { value: {} },
    });
    const sameOriginChild = { parent: top } as Window;
    const crossOriginParent = {} as Window;
    Object.defineProperty(crossOriginParent, "document", {
      get: () => {
        throw new DOMException("Blocked a frame with origin", "SecurityError");
      },
    });
    const crossOriginChild = { parent: crossOriginParent } as Window;

    expect(isCrossOriginChild(top)).toBe(false);
    expect(isCrossOriginChild(sameOriginChild)).toBe(false);
    expect(isCrossOriginChild(crossOriginChild)).toBe(true);
  });

  it("forwards stitch-sync through nested child frames", async () => {
    const deepest = windowHarness();
    const grandchild = windowHarness([deepest.window]);
    const child = windowHarness([grandchild.window]);
    const childSnapshot = vi.fn();
    const grandchildSnapshot = vi.fn();
    const childReadiness = createRecordReadiness();
    const grandchildReadiness = createRecordReadiness();
    childReadiness.markStarted();
    grandchildReadiness.markStarted();
    installStitchSyncListener(child.window, stitchDependencies(childReadiness, childSnapshot));
    installStitchSyncListener(
      grandchild.window,
      stitchDependencies(grandchildReadiness, grandchildSnapshot),
    );
    await Promise.resolve();

    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });

    expect(childSnapshot).toHaveBeenCalledOnce();
    expect(grandchildSnapshot).toHaveBeenCalledOnce();
    expect(deepest.window.postMessage).toHaveBeenCalledWith(
      { type: STITCH_SYNC_MESSAGE_TYPE },
      "*",
    );
  });

  it("honors child snapshot requests no more often than every 250ms", async () => {
    vi.useFakeTimers();
    const child = windowHarness();
    const takeFullSnapshot = vi.fn();
    const readiness = createRecordReadiness();
    readiness.markStarted();
    installStitchSyncListener(child.window, stitchDependencies(readiness, takeFullSnapshot));
    await Promise.resolve();

    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });
    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });
    await vi.advanceTimersByTimeAsync(249);

    expect(takeFullSnapshot).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);

    expect(takeFullSnapshot).toHaveBeenCalledTimes(2);
  });

  it("queues a snapshot received before readiness and still forwards it", async () => {
    const parent = windowHarness();
    const descendant = windowHarness();
    const child = windowHarness([descendant.window], parent.window);
    const takeFullSnapshot = vi.fn();
    const readiness = createRecordReadiness();
    installStitchSyncListener(child.window, stitchDependencies(readiness, takeFullSnapshot));

    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });

    expect(takeFullSnapshot).not.toHaveBeenCalled();
    expect(descendant.window.postMessage).toHaveBeenCalledWith(
      { type: STITCH_SYNC_MESSAGE_TYPE },
      "*",
    );

    readiness.markStarted();
    await Promise.resolve();

    expect(takeFullSnapshot).toHaveBeenCalledOnce();
    expect(parent.window.postMessage).toHaveBeenCalledWith(
      { type: STITCH_READY_MESSAGE_TYPE },
      "*",
    );
  });

  it("responds to child readiness with a targeted stitch-sync", () => {
    const child = windowHarness();
    const parent = windowHarness([child.window]);
    installStitchReadyListener(parent.window);

    parent.dispatch({ type: STITCH_READY_MESSAGE_TYPE }, child.window);

    expect(child.window.postMessage).toHaveBeenCalledWith({ type: STITCH_SYNC_MESSAGE_TYPE }, "*");
  });

  it("broadcasts only to immediate child browsing contexts", () => {
    const first = windowHarness();
    const second = windowHarness();
    const parent = windowHarness([first.window, second.window]);

    broadcastStitchSync(parent.window);

    expect(first.window.postMessage).toHaveBeenCalledOnce();
    expect(second.window.postMessage).toHaveBeenCalledOnce();
  });
});
