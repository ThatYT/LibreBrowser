/**
 * Stable boundary contracts between gateway components (browser / core / assets).
 *
 * Changing a signature here requires a coordinated protocol change, exactly like
 * packages/protocol. Private component helpers belong alongside their implementation; this file
 * is only for contracts that cross a boundary.
 */
import type { AgentCmdInput, AgentMsg, CmdRes } from "@mirror/protocol";

/** One attached CDP target (page or OOPIF). Produced by the browser domain (P0-LAUNCH). */
export interface TargetRef {
  targetId: string;
  /** CDP flat-session id — all commands for this target go through it. */
  sessionId: string;
  type: "page" | "iframe";
  /** targetId of the opener tab, when Chromium reports one (popups). */
  openerTabId?: string;
}

/** Raw CDP command sender, bound to a browser connection. Owner: browser domain. */
export type CdpSend = (
  sessionId: string,
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * The browser-owned agent stream and command channel.
 * Consumers: gateway-core (hub ingests msgs; input relay sends cmds).
 */
export interface AgentLink {
  /**
   * Per-target ordered stream of reassembled AgentMsgs. Stale-docId rrweb events (arriving
   * after a newer `hello` on the same target) are already dropped (D1). The iterable ends on
   * target detach.
   */
  msgs(targetId: string): AsyncIterable<AgentMsg>;
  /**
   * Send an AgentCmd (reqId assigned internally). Resolves with the matching cmdres; rejects
   * after a 3s timeout or when the document navigates away (docId change) — never hangs.
   */
  sendCmd(targetId: string, cmd: AgentCmdInput): Promise<CmdRes>;
}

/** Target lifecycle notifications. Owner: browser domain; consumer: gateway-core (tab hubs). */
export interface TargetEvents {
  onAttached(cb: (t: TargetRef) => void): void;
  onDetached(cb: (t: TargetRef) => void): void;
}
