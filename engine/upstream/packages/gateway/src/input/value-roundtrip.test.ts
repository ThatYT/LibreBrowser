/// <reference lib="dom" />
import type { AgentCmdInput, AgentMsg } from "@mirror/protocol";
import { decodeUp, encodeMsg } from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import { attachChangeCapture } from "../../../viewer/src/input/change";
import type { AgentLink } from "../types";
import { createInputRelay, type InputMsg } from "./relay";

type Listener = (event: never) => void;

class FakeDocument {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string, event: object) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

class FakeSelect {
  readonly nodeType = 1;
  readonly tagName = "SELECT";
  readonly parentElement = null;

  constructor(
    readonly nodeId: number,
    readonly multiple: boolean,
    public value: string,
    readonly options: { selected: boolean; value: string }[] = [],
  ) {}

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 30 };
  }
}

class FakeInput {
  readonly nodeType = 1;
  readonly tagName = "INPUT";
  readonly parentElement = null;
  readonly value = "on";

  constructor(
    readonly nodeId: number,
    readonly type: "checkbox" | "radio",
    readonly checked: boolean,
  ) {}

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 20, height: 20 };
  }
}

describe("F2 select change round trip", () => {
  it("routes a mirror select commit through the wire to the agent value command", async () => {
    const commands: AgentCmdInput[] = [];
    const agentLink: AgentLink = {
      async *msgs(): AsyncIterable<AgentMsg> {},
      async sendCmd(_tabId, command) {
        commands.push(command);
        return command.cmd === "resolve"
          ? { reqId: commands.length, ok: true, data: { kind: "local" } }
          : { reqId: commands.length, ok: true };
      },
    };
    const relay = createInputRelay({
      agentLink,
      send: async () => ({}),
      sessionFor: () => "session-1",
      isDriver: () => true,
      allowsInput: () => true,
      noteInput: () => {},
      viewportFor: () => ({ w: 800, h: 600 }),
    });
    const pending: Promise<boolean>[] = [];
    const doc = new FakeDocument();
    attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "tab-1",
      getNodeId: (node) => (node as unknown as { nodeId: number }).nodeId,
      send(message) {
        const decoded = decodeUp(encodeMsg(message));
        pending.push(relay("driver", decoded as InputMsg));
      },
    });

    doc.fire("change", { target: new FakeSelect(23, false, "second"), isTrusted: true });

    await expect(Promise.all(pending)).resolves.toEqual([true]);
    expect(commands).toEqual([
      { cmd: "resolve", nodeId: 23 },
      { cmd: "value", nodeId: 23, value: "second" },
    ]);
  });

  it("routes checkbox, radio, and multiple-select state through the wire", async () => {
    const commands: AgentCmdInput[] = [];
    const agentLink: AgentLink = {
      async *msgs(): AsyncIterable<AgentMsg> {},
      async sendCmd(_tabId, command) {
        commands.push(command);
        return command.cmd === "resolve"
          ? { reqId: commands.length, ok: true, data: { kind: "local" } }
          : { reqId: commands.length, ok: true };
      },
    };
    const relay = createInputRelay({
      agentLink,
      send: async () => ({}),
      sessionFor: () => "session-1",
      isDriver: () => true,
      allowsInput: () => true,
      noteInput: () => {},
      viewportFor: () => ({ w: 800, h: 600 }),
    });
    const pending: Promise<boolean>[] = [];
    const doc = new FakeDocument();
    attachChangeCapture({
      doc: doc as unknown as Document,
      tab: "tab-1",
      getNodeId: (node) => (node as unknown as { nodeId: number }).nodeId,
      send(message) {
        pending.push(relay("driver", decodeUp(encodeMsg(message)) as InputMsg));
      },
    });

    doc.fire("change", { target: new FakeInput(31, "checkbox", true), isTrusted: true });
    doc.fire("change", { target: new FakeInput(32, "radio", true), isTrusted: true });
    doc.fire("change", {
      target: new FakeSelect(33, true, "beta", [
        { value: "alpha", selected: false },
        { value: "beta", selected: true },
        { value: "gamma", selected: true },
      ]),
      isTrusted: true,
    });

    await expect(Promise.all(pending)).resolves.toEqual([true, true, true]);
    expect(commands).toEqual([
      { cmd: "resolve", nodeId: 31 },
      { cmd: "value", nodeId: 31, value: "on", checked: true },
      { cmd: "resolve", nodeId: 32 },
      { cmd: "value", nodeId: 32, value: "on", checked: true },
      { cmd: "resolve", nodeId: 33 },
      { cmd: "value", nodeId: 33, value: "beta", values: ["beta", "gamma"] },
    ]);
  });
});
