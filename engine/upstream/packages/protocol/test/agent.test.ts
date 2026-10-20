import { describe, expect, it } from "vitest";
import type { AgentCmd, CmdRes, ResolveResult } from "../src/index";

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("agent command contract", () => {
  it("round-trips resolve commands", () => {
    const command: AgentCmd = { cmd: "resolve", reqId: 17, nodeId: 912 };
    expect(roundTrip(command)).toEqual(command);
  });

  it("round-trips scalar, checked, and multiple-select value commands", () => {
    const commands: AgentCmd[] = [
      { cmd: "value", reqId: 18, nodeId: 41, value: "second" },
      { cmd: "value", reqId: 19, nodeId: 42, value: "on", checked: true },
      { cmd: "value", reqId: 20, nodeId: 43, value: "beta", values: ["beta", "gamma"] },
    ];
    for (const command of commands) expect(roundTrip(command)).toEqual(command);
  });

  it("round-trips local and remote resolve responses", () => {
    const results: ResolveResult[] = [
      { kind: "local" },
      { kind: "remote", iframeNodeId: 44, remoteId: 7 },
    ];
    const responses: CmdRes[] = results.map((data, index) => ({
      reqId: index + 1,
      ok: true,
      data,
    }));

    for (const response of responses) expect(roundTrip(response)).toEqual(response);
  });
});
