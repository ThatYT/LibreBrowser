/**
 * Agent <-> gateway channel types.
 *
 * Page -> gateway: the agent calls a CDP binding with an `M2|` chunk (see chunk.ts). Production
 * embeds a randomized binding name; `BINDING_NAME` remains the standalone bundle/test default.
 *
 * Gateway -> page: bindings are one-way. Production captures an isolated-world relay as a CDP
 * RemoteObject and invokes it with `Runtime.callFunctionOn`; randomized private events reach the
 * MAIN-world handler without a page global. The standalone bundle retains the legacy
 * `window.__mirror_cmd` default. Responses return through the binding as `cmdres` messages.
 *
 * docId — the per-document epoch: a random uint32 generated at agent startup (i.e. once per
 * document). Every event carries it. The gateway keys ordering on `(targetId, docId)`. A `hello`
 * with a new docId on the same target means a navigation happened: close the old epoch and expect
 * a FullSnapshot to open the new one. Any `rrweb` msg with a stale docId arriving after a newer
 * `hello` MUST be dropped. This kills "events straddle a navigation" bugs by construction.
 *
 * Attach sequence (D1 — order matters): on `Target.attachedToTarget` ->
 *   `Page.enable` -> webdriver safeguard + isolated relay + MAIN agent new-document scripts ->
 *   `Runtime.runIfWaitingForDebugger` -> isolated world + context-scoped bindings.
 * Filter auto-attach to page/iframe target types; resume workers immediately without injecting.
 */
import type { eventWithTime } from "./rrweb";

/** Standalone/default CDP binding name; production embeds a randomized per-session name. */
export const BINDING_NAME = "__mirror_emit";
/** Standalone/default command helper; production uses a captured RemoteObject bridge. */
export const CMD_FN_NAME = "__mirror_cmd";
/** Standalone/default node helper; production uses a captured RemoteObject bridge. */
export const MIRROR_NODE_FN_NAME = "__mirror_node";

/** Page -> gateway messages (reassembled from M2 chunks, then JSON.parse). */
export type AgentMsg =
  | {
      kind: "hello";
      /** Per-document epoch: random uint32 minted at agent startup. */
      docId: number;
      url: string;
      /** True only for the top-level frame. OOPIF agents send hello for diagnostics, but their
       *  rrweb events are suppressed (D2) — rrweb stitches child frames into the top stream. */
      isTop: boolean;
      ts: number;
    }
  | { kind: "rrweb"; docId: number; e: eventWithTime }
  | { kind: "cmdres"; reqId: number; ok: boolean; data?: unknown; err?: string };

/**
 * Gateway -> page command set. This is the WHOLE v1 agent API surface — frozen (D1).
 * `rect`/`scroll` resolve nodeId via `record.mirror.getNode(id)` (the recorder's own mirror,
 * so ids are guaranteed consistent with what the viewer sees).
 */
export type AgentCmd =
  | { cmd: "snapshot"; reqId: number } // record.takeFullSnapshot(true)
  | { cmd: "resolve"; reqId: number; nodeId: number } // -> ResolveResult, one OOPIF level
  | { cmd: "rect"; reqId: number; nodeId: number } // -> RectResult, or ok:false if node gone
  | { cmd: "scroll"; reqId: number; nodeId: number; x: number; y: number } // nodeId 0 = window
  | {
      cmd: "value";
      reqId: number;
      nodeId: number;
      value: string;
      commit?: boolean;
      /** Checkbox/radio committed state; when present, `value` is not applied. */
      checked?: boolean;
      /** Multiple-select committed option values; when present, `value` is not applied. */
      values?: string[];
    } // native set + input/change
  | { cmd: "ping"; reqId: number }; // liveness

/** `rect` result: viewport CSS px. */
export interface RectResult {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

/** `resolve` result for this document or one of its direct cross-origin child frames. */
export type ResolveResult =
  { kind: "local" } | { kind: "remote"; iframeNodeId: number; remoteId: number };

/** Shape of the `cmdres` AgentMsg body, matched to the AgentCmd by reqId. */
export interface CmdRes {
  reqId: number;
  ok: boolean;
  data?: unknown;
  err?: string;
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
/** An AgentCmd before the sender assigns a reqId (used by AgentLink.sendCmd implementations). */
export type AgentCmdInput = DistributiveOmit<AgentCmd, "reqId">;
