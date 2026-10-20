// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG, readAgentConfig } from "./config";

describe("agent session config", () => {
  it("defaults canvas snapshots to 8fps at WebP quality 0.7", () => {
    expect(readAgentConfig(undefined)).toEqual(DEFAULT_AGENT_CONFIG);
  });

  it("accepts per-session fps and quality and bounds the CPU-sensitive range", () => {
    expect(readAgentConfig({ canvas: { fps: 12, quality: 0.55 } })).toEqual({
      canvas: { fps: 12, quality: 0.55 },
      bridge: DEFAULT_AGENT_CONFIG.bridge,
    });
    expect(readAgentConfig({ canvas: { fps: 1, quality: -1 } })).toEqual({
      canvas: { fps: 4, quality: 0.1 },
      bridge: DEFAULT_AGENT_CONFIG.bridge,
    });
    expect(readAgentConfig({ canvas: { fps: 60, quality: 2 } })).toEqual({
      canvas: { fps: 15, quality: 1 },
      bridge: DEFAULT_AGENT_CONFIG.bridge,
    });
  });

  it("accepts private per-session bridge names and rejects unusable values", () => {
    expect(
      readAgentConfig({
        bridge: { bindingName: "emit-a", rtcBindingName: "rtc-a", bridgeKey: "bridge-a" },
      }).bridge,
    ).toEqual({
      ...DEFAULT_AGENT_CONFIG.bridge,
      bindingName: "emit-a",
      rtcBindingName: "rtc-a",
      bridgeKey: "bridge-a",
    });
    expect(
      readAgentConfig({ bridge: { bindingName: "", rtcBindingName: 42, bridgeKey: "" } }).bridge,
    ).toEqual(DEFAULT_AGENT_CONFIG.bridge);
  });
});
