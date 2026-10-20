/**
 * Resolve a viewer-visible rrweb node id to the live agent target that owns it.
 *
 * Resolution is deliberately performed for every dispatch. OOPIF target ids are stable frame
 * ids, but their flat CDP sessions can be replaced after a crash or process transition, so every
 * raw CDP operation consults the caller's live target registry.
 */
import { MIRROR_NODE_FN_NAME, type ResolveResult } from "@mirror/protocol";

import type { AgentLink, CdpSend } from "../types";

export interface ResolveNodeDeps {
  agentLink: AgentLink;
  send: CdpSend;
  /** Production's page-invisible RemoteObject bridge; omitted only by legacy/unit harnesses. */
  callBridge?: (sessionId: string, method: "node", args: readonly unknown[]) => Promise<unknown>;
  /** Live targetId -> flat CDP sessionId lookup. */
  sessionFor(targetId: string): string | undefined;
}

export interface FrameHop {
  /** Target containing the iframe element. */
  targetId: string;
  iframeNodeId: number;
  /** OOPIF frameId, which Chromium also uses as the child targetId. */
  childTargetId: string;
}

export interface ResolvedNode {
  targetId: string;
  localId: number;
  /** Outer-to-inner OOPIF boundaries, used only for rect composition. */
  frameHops: FrameHop[];
}

interface RuntimeEvaluateResult {
  result?: {
    objectId?: string;
    description?: string;
  };
  exceptionDetails?: unknown;
}

interface DescribeNodeResult {
  node?: { frameId?: string };
}

function mirrorNodeExpression(nodeId: number): string {
  return `(0,globalThis[${JSON.stringify(MIRROR_NODE_FN_NAME)}])(${JSON.stringify(nodeId)})`;
}

function asResolveResult(value: unknown): ResolveResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<ResolveResult> & {
    iframeNodeId?: unknown;
    remoteId?: unknown;
  };
  if (candidate.kind === "local") return { kind: "local" };
  if (
    candidate.kind === "remote" &&
    typeof candidate.iframeNodeId === "number" &&
    Number.isSafeInteger(candidate.iframeNodeId) &&
    typeof candidate.remoteId === "number" &&
    Number.isSafeInteger(candidate.remoteId)
  ) {
    return {
      kind: "remote",
      iframeNodeId: candidate.iframeNodeId,
      remoteId: candidate.remoteId,
    };
  }
  return undefined;
}

async function iframeTargetId(
  deps: ResolveNodeDeps,
  parentTargetId: string,
  iframeNodeId: number,
): Promise<string> {
  const sessionId = deps.sessionFor(parentTargetId);
  if (sessionId === undefined) {
    throw new Error(`OOPIF parent target ${parentTargetId} is detached`);
  }

  const evaluated = (await (deps.callBridge === undefined
    ? deps.send(sessionId, "Runtime.evaluate", {
        expression: mirrorNodeExpression(iframeNodeId),
        returnByValue: false,
      })
    : deps.callBridge(sessionId, "node", [iframeNodeId]))) as RuntimeEvaluateResult;
  const objectId = evaluated.result?.objectId;
  if (evaluated.exceptionDetails !== undefined || objectId === undefined) {
    throw new Error(`Could not obtain iframe node ${iframeNodeId} on target ${parentTargetId}`);
  }

  let frameId: string | undefined;
  try {
    const described = (await deps.send(sessionId, "DOM.describeNode", {
      objectId,
    })) as DescribeNodeResult;
    frameId = described.node?.frameId;
  } finally {
    await deps.send(sessionId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }

  if (frameId === undefined || frameId.length === 0) {
    throw new Error(`DOM.describeNode did not return a frameId for iframe node ${iframeNodeId}`);
  }

  // This lookup is intentionally live and its result is not retained. AgentLink and the next
  // raw CDP operation independently consult their current target/session state.
  if (deps.sessionFor(frameId) === undefined) {
    throw new Error(`OOPIF child target ${frameId} is not attached`);
  }
  return frameId;
}

/** Resolve a unified rrweb id through any number of attached OOPIF boundaries. */
export async function resolveNode(
  deps: ResolveNodeDeps,
  tabId: string,
  nodeId: number,
): Promise<ResolvedNode> {
  let targetId = tabId;
  let localId = nodeId;
  const frameHops: FrameHop[] = [];
  const visited = new Set<string>();

  while (true) {
    const visitKey = `${targetId}\0${localId}`;
    if (visited.has(visitKey)) throw new Error("OOPIF node resolution cycle detected");
    visited.add(visitKey);

    const response = await deps.agentLink.sendCmd(targetId, {
      cmd: "resolve",
      nodeId: localId,
    });
    if (!response.ok) {
      throw new Error(response.err ?? `Agent could not resolve node ${localId}`);
    }
    const resolution = asResolveResult(response.data);
    if (resolution === undefined) {
      throw new Error(`Agent returned an invalid resolve result for node ${localId}`);
    }
    if (resolution.kind === "local") return { targetId, localId, frameHops };

    const childTargetId = await iframeTargetId(deps, targetId, resolution.iframeNodeId);
    frameHops.push({
      targetId,
      iframeNodeId: resolution.iframeNodeId,
      childTargetId,
    });
    targetId = childTargetId;
    localId = resolution.remoteId;
  }
}
