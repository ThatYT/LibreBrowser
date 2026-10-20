/**
 * File-upload relay, viewer half. A local rrweb-clone input keeps the native mobile picker and
 * stages its File objects until the gateway's authoritative fileChooserOpened key arrives (or
 * vice versa). Each bounded file is streamed as one raw, same-origin request in selection order.
 */
import type { Down, TabId } from "@mirror/protocol";

const DEFAULT_STAGE_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_ENCODED_NAME_LENGTH = 2_048;
const MAX_MIME_LENGTH = 256;

type FilePick = Extract<Down, { t: "filepick" }>;

interface PendingPick {
  message: FilePick;
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
}

interface Selection {
  files: File[];
  timer: ReturnType<typeof setTimeout>;
}

export interface FileUploadRelayOptions {
  fetch?: typeof fetch;
  stageTimeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onError?: (error: unknown) => void;
}

export interface FileUploadRelay {
  handlePick(message: FilePick, sessionId: string): void;
  select(tab: TabId, input: HTMLInputElement): void;
  clear(): void;
  dispose(): void;
}

export function createFileUploadRelay(options: FileUploadRelayOptions = {}): FileUploadRelay {
  const request = options.fetch ?? fetch;
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  if (!Number.isSafeInteger(stageTimeoutMs) || stageTimeoutMs < 1) {
    throw new RangeError("stageTimeoutMs must be a positive safe integer");
  }
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const report = options.onError ?? (() => undefined);
  const picks = new Map<TabId, PendingPick>();
  const selections = new Map<TabId, Selection>();
  const active = new Set<AbortController>();
  let disposed = false;

  const clearPick = (tab: TabId): PendingPick | undefined => {
    const pick = picks.get(tab);
    if (pick !== undefined) cancel(pick.timer);
    picks.delete(tab);
    return pick;
  };

  const clearSelection = (tab: TabId): Selection | undefined => {
    const selection = selections.get(tab);
    if (selection !== undefined) cancel(selection.timer);
    selections.delete(tab);
    return selection;
  };

  const pair = (tab: TabId): void => {
    const pick = picks.get(tab);
    const selection = selections.get(tab);
    if (pick === undefined || selection === undefined) return;
    clearPick(tab);
    clearSelection(tab);
    const controller = new AbortController();
    active.add(controller);
    void uploadBatch(request, pick, selection.files, controller.signal)
      .catch(report)
      .finally(() => active.delete(controller));
  };

  return {
    handlePick(message, sessionId) {
      if (disposed) return;
      validatePick(message);
      if (sessionId.trim() === "") throw new TypeError("sessionId must not be empty");
      clearPick(message.tab);
      const timer = schedule(() => picks.delete(message.tab), stageTimeoutMs);
      picks.set(message.tab, { message, sessionId, timer });
      pair(message.tab);
    },
    select(tab, input) {
      if (disposed) return;
      const files = input.files === null ? [] : Array.from(input.files);
      // File objects remain readable after reset and resetting allows the same file to be picked.
      input.value = "";
      if (files.length === 0) return;
      clearSelection(tab);
      const timer = schedule(() => selections.delete(tab), stageTimeoutMs);
      selections.set(tab, { files, timer });
      pair(tab);
    },
    clear() {
      for (const tab of [...picks.keys()]) clearPick(tab);
      for (const tab of [...selections.keys()]) clearSelection(tab);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      this.clear();
      for (const controller of active) controller.abort();
      active.clear();
    },
  };
}

async function uploadBatch(
  request: typeof fetch,
  pick: PendingPick,
  files: readonly File[],
  signal: AbortSignal,
): Promise<void> {
  const { message } = pick;
  if (files.length > message.maxFiles) throw new Error("Too many files selected for upload");
  if (!message.multiple && files.length !== 1) {
    throw new Error("Remote file input accepts only one file");
  }
  let totalSize = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > message.maxFileBytes) {
      throw new Error(`${file.name || "File"} exceeds the upload size limit`);
    }
    totalSize += file.size;
    if (!Number.isSafeInteger(totalSize) || totalSize > message.maxTotalBytes) {
      throw new Error("Selected files exceed the total upload size limit");
    }
    if (encodeURIComponent(file.name).length > MAX_ENCODED_NAME_LENGTH) {
      throw new Error("Selected filename is too long");
    }
    if (file.type.length > MAX_MIME_LENGTH || /[^\x20-\x7e]/.test(file.type)) {
      throw new Error("Selected file has an invalid MIME type");
    }
  }

  const url = `/s/${encodeURIComponent(pick.sessionId)}/u/${encodeURIComponent(message.key)}`;
  for (const [index, file] of files.entries()) {
    const response = await request(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/octet-stream",
        "x-mirror-file-index": String(index),
        "x-mirror-file-count": String(files.length),
        "x-mirror-file-size": String(file.size),
        "x-mirror-total-size": String(totalSize),
        "x-mirror-file-name": encodeURIComponent(file.name),
        "x-mirror-file-type": encodeURIComponent(file.type),
      },
      body: file,
      signal,
    });
    if (!response.ok) throw new Error(`Upload failed with HTTP ${response.status}`);
  }
}

function validatePick(message: FilePick): void {
  if (message.key === "" || !/^[A-Za-z0-9_-]+$/.test(message.key)) {
    throw new TypeError("filepick key must be URL-safe");
  }
  for (const [name, value] of [
    ["maxFiles", message.maxFiles],
    ["maxFileBytes", message.maxFileBytes],
    ["maxTotalBytes", message.maxTotalBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}
