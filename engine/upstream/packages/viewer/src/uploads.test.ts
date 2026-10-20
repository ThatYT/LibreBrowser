// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileUploadRelay } from "./uploads";

afterEach(() => vi.useRealTimers());

function pick(overrides: Record<string, unknown> = {}) {
  return {
    t: "filepick" as const,
    tab: "tab-1",
    key: "upload-key",
    multiple: true,
    maxFiles: 5,
    maxFileBytes: 1_000,
    maxTotalBytes: 2_000,
    ...overrides,
  };
}

function input(files: File[]): HTMLInputElement {
  return { files, value: "C:\\fakepath\\selected.txt" } as unknown as HTMLInputElement;
}

describe("viewer file upload relay", () => {
  it("pairs a filepick received before local change and resets the cloned input", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    const relay = createFileUploadRelay({ fetch: request as typeof fetch });
    const selected = input([new File(["hello"], "résumé.txt", { type: "text/plain" })]);

    relay.handlePick(pick({ multiple: false }), "session-1");
    relay.select("tab-1", selected);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    expect(selected.value).toBe("");
    expect(request.mock.calls[0]?.[0]).toBe("/s/session-1/u/upload-key");
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/octet-stream",
        "x-mirror-file-index": "0",
        "x-mirror-file-count": "1",
        "x-mirror-file-size": "5",
        "x-mirror-total-size": "5",
        "x-mirror-file-name": "r%C3%A9sum%C3%A9.txt",
        "x-mirror-file-type": "text%2Fplain",
      },
    });
    relay.dispose();
  });

  it("holds a local selection until its authoritative key arrives and sends files in order", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    const relay = createFileUploadRelay({ fetch: request as typeof fetch });
    relay.select(
      "tab-1",
      input([
        new File(["one"], "a.txt", { type: "text/plain" }),
        new File(["two"], "b.txt", { type: "text/plain" }),
      ]),
    );
    expect(request).not.toHaveBeenCalled();

    relay.handlePick(pick(), "session-1");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(
      request.mock.calls.map(
        (call) => (call[1]?.headers as Record<string, string>)["x-mirror-file-index"],
      ),
    ).toEqual(["0", "1"]);
    relay.dispose();
  });

  it("enforces gateway-advertised count and byte caps before making a request", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    const errors: unknown[] = [];
    const relay = createFileUploadRelay({
      fetch: request as typeof fetch,
      onError: (error) => errors.push(error),
    });
    relay.handlePick(pick({ maxFileBytes: 2 }), "session-1");
    relay.select("tab-1", input([new File(["large"], "large.bin")]));

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(request).not.toHaveBeenCalled();
    expect(String(errors[0])).toContain("size limit");
    relay.dispose();
  });
});
