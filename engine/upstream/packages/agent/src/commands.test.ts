// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIRROR_NODE_FN_NAME, type AgentMsg } from "@mirror/protocol";
import {
  createCommandHandler,
  createRecordReadiness,
  installMirrorNodeHelper,
  type CrossOriginIframeMirror,
  type NodeMirror,
  type RecordReadiness,
} from "./commands";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function iframeNode(): HTMLIFrameElement {
  return {
    nodeType: 1,
    nodeName: "IFRAME",
    isConnected: true,
  } as unknown as HTMLIFrameElement;
}

function harness(
  nodes: Map<number, Node>,
  crossOriginIframeMirror: CrossOriginIframeMirror | null,
) {
  const messages: AgentMsg[] = [];
  const nodeMirror: NodeMirror = {
    getIds: () => [...nodes.keys()],
    getNode: (nodeId) => nodes.get(nodeId) ?? null,
  };
  const handler = createCommandHandler(
    { emit: (message) => messages.push(message) },
    { getNodeMirror: () => nodeMirror, getCrossOriginIframeMirror: () => crossOriginIframeMirror },
  );
  return { handler, messages };
}

describe("resolve command", () => {
  it("returns local when the node is in this recorder mirror", () => {
    const local = { isConnected: true } as Node;
    const { handler, messages } = harness(new Map([[21, local]]), null);

    handler({ cmd: "resolve", reqId: 1, nodeId: 21 });

    expect(messages).toEqual([{ kind: "cmdres", reqId: 1, ok: true, data: { kind: "local" } }]);
  });

  it("returns the hosting iframe id and child-local remote id", () => {
    const iframe = iframeNode();
    const remoteMaps = new WeakMap<HTMLIFrameElement, Map<number, number>>([
      [iframe, new Map([[901, 37]])],
    ]);
    const crossOriginIframeMirror: CrossOriginIframeMirror = {
      iframeRemoteIdToIdMap: remoteMaps,
      getRemoteId: (candidate, nodeId) => remoteMaps.get(candidate)?.get(nodeId) ?? -1,
    };
    const { handler, messages } = harness(new Map([[44, iframe]]), crossOriginIframeMirror);

    handler({ cmd: "resolve", reqId: 2, nodeId: 901 });

    expect(messages).toEqual([
      {
        kind: "cmdres",
        reqId: 2,
        ok: true,
        data: { kind: "remote", iframeNodeId: 44, remoteId: 37 },
      },
    ]);
  });

  it("returns ok:false when no local or child mapping exists", () => {
    const iframe = iframeNode();
    const crossOriginIframeMirror: CrossOriginIframeMirror = {
      iframeRemoteIdToIdMap: new WeakMap([[iframe, new Map()]]),
      getRemoteId: () => -1,
    };
    const { handler, messages } = harness(new Map([[44, iframe]]), crossOriginIframeMirror);

    expect(() => handler({ cmd: "resolve", reqId: 3, nodeId: 999 })).not.toThrow();
    expect(messages).toEqual([{ kind: "cmdres", reqId: 3, ok: false, err: "node not found" }]);
  });
});

describe("snapshot command readiness", () => {
  it("waits for recording to start and then takes the snapshot", async () => {
    const messages: AgentMsg[] = [];
    const readiness = createRecordReadiness();
    const takeFullSnapshot = vi.fn();
    const handler = createCommandHandler(
      { emit: (message) => messages.push(message) },
      {
        getNodeMirror: () => ({ getIds: () => [], getNode: () => null }),
        recordReadiness: readiness,
        takeFullSnapshot,
      },
    );

    handler({ cmd: "snapshot", reqId: 10 });
    expect(takeFullSnapshot).not.toHaveBeenCalled();
    expect(messages).toEqual([]);

    readiness.markStarted();
    await Promise.resolve();

    expect(takeFullSnapshot).toHaveBeenCalledOnce();
    expect(messages).toEqual([{ kind: "cmdres", reqId: 10, ok: true }]);
  });

  it("returns a clean retryable failure when recording never starts", async () => {
    vi.useFakeTimers();
    const messages: AgentMsg[] = [];
    const readiness = createRecordReadiness();
    const takeFullSnapshot = vi.fn();
    const handler = createCommandHandler(
      { emit: (message) => messages.push(message) },
      {
        getNodeMirror: () => ({ getIds: () => [], getNode: () => null }),
        recordReadiness: readiness,
        snapshotReadyTimeoutMs: 2_000,
        takeFullSnapshot,
      },
    );

    handler({ cmd: "snapshot", reqId: 11 });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(takeFullSnapshot).not.toHaveBeenCalled();
    expect(messages).toEqual([
      { kind: "cmdres", reqId: 11, ok: false, err: "recorder not ready; retry snapshot" },
    ]);
  });

  it("takes the snapshot synchronously once recording has started", () => {
    const messages: AgentMsg[] = [];
    const waitUntilStarted = vi.fn<RecordReadiness["waitUntilStarted"]>();
    const takeFullSnapshot = vi.fn();
    const handler = createCommandHandler(
      { emit: (message) => messages.push(message) },
      {
        getNodeMirror: () => ({ getIds: () => [], getNode: () => null }),
        recordReadiness: {
          isStarted: () => true,
          onStarted: () => () => undefined,
          waitUntilStarted,
        },
        takeFullSnapshot,
      },
    );

    handler({ cmd: "snapshot", reqId: 12 });

    expect(waitUntilStarted).not.toHaveBeenCalled();
    expect(takeFullSnapshot).toHaveBeenCalledOnce();
    expect(messages).toEqual([{ kind: "cmdres", reqId: 12, ok: true }]);
  });

  it("does not expose rrweb's raw startup exception", () => {
    const messages: AgentMsg[] = [];
    const handler = createCommandHandler(
      { emit: (message) => messages.push(message) },
      {
        getNodeMirror: () => ({ getIds: () => [], getNode: () => null }),
        recordReadiness: {
          isStarted: () => true,
          onStarted: () => () => undefined,
          waitUntilStarted: () => Promise.resolve(true),
        },
        takeFullSnapshot: () => {
          throw new Error("please take full snapshot after start recording");
        },
      },
    );

    handler({ cmd: "snapshot", reqId: 13 });

    expect(messages).toEqual([
      { kind: "cmdres", reqId: 13, ok: false, err: "recorder not ready; retry snapshot" },
    ]);
  });
});

describe("mirror node helper", () => {
  it("exposes the actual recorder-mirror node on the main-world global", () => {
    const node = { isConnected: true } as Node;
    const fakeWindow: Record<string, unknown> = {};
    vi.stubGlobal("window", fakeWindow);
    const nodeMirror: NodeMirror = {
      getIds: () => [71],
      getNode: (nodeId) => (nodeId === 71 ? node : null),
    };

    installMirrorNodeHelper(() => nodeMirror);

    const helper = fakeWindow[MIRROR_NODE_FN_NAME] as (nodeId: number) => Node | null;
    expect(helper(71)).toBe(node);
    expect(helper(999)).toBeNull();
  });
});
