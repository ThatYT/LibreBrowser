/**
 * Hand-written public surface of @mirror/agent (checked in so dependents typecheck without a
 * prior build; `pnpm -F @mirror/agent build` generates dist/index.js to match).
 */

export interface CanvasSnapshotConfig {
  /** Snapshot sampling rate. Values are bounded to the supported 4–15 FPS range in-page. */
  fps?: number;
  /** WebP encoding quality from 0.1 through 1. Values outside that range are bounded in-page. */
  quality?: number;
}

/** Session-facing controls for the injected recorder. */
export interface AgentConfig {
  canvas?: CanvasSnapshotConfig;
  /** Private gateway transport names. Production generates fresh names for each target session. */
  bridge?: {
    bindingName?: string;
    rtcBindingName?: string;
    bridgeKey?: string;
    outboundEventName?: string;
    inboundEventName?: string;
    nodeResponseEventName?: string;
    readyEventName?: string;
  };
}

export declare const DEFAULT_AGENT_CONFIG: Readonly<{
  canvas: Readonly<{ fps: 8; quality: 0.7 }>;
  bridge: Readonly<{
    bindingName: "__mirror_emit";
    rtcBindingName: "__mirror_rtc_emit";
    bridgeKey: "__mirror_bridge";
    outboundEventName: "__mirror_outbound";
    inboundEventName: "__mirror_inbound";
    nodeResponseEventName: "__mirror_node_response";
    readyEventName: "__mirror_ready";
  }>;
}>;

/** Build an injectable agent string with configuration embedded for one browser session. */
export declare function createAgentBundle(config?: AgentConfig): string;

/** The complete in-page agent with default config, ready for Page.addScriptToEvaluateOnNewDocument. */
export declare const AGENT_BUNDLE: string;
