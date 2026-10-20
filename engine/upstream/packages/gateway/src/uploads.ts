/**
 * Gateway side of the file-upload flow.
 * (Viewer half = viewer/src/uploads.ts, viewer domain.)
 *
 * Page.setInterceptFileChooserDialog runs on every attached page session. The resulting
 * backendNodeId is the only upload authority: a cookie-guarded, one-time 192-bit key streams
 * bounded file bodies beneath the session upload directory, then DOM.setFileInputFiles applies
 * those absolute paths on the frame session that owns the node. Client filenames are metadata,
 * never directories; every generated path component is validated or sanitized. Pending chooser
 * and partial-batch timers dispatch the same bubbling `cancel` event used by Puppeteer because
 * DOM.setFileInputFiles([]) is a Chromium no-op.
 */
import type { Down } from "@mirror/protocol";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { SessionGuard } from "./auth/middleware";
import type { BrowserHandle, FlatSessionEventMap } from "./browser/launch";
import type { TargetRef } from "./types";

const UPLOAD_CONTENT_TYPE = "application/octet-stream";
const MAX_ENCODED_NAME_LENGTH = 2_048;
const MAX_MIME_LENGTH = 256;
const MAX_FILE_COMPONENT_BYTES = 180;

export const DEFAULT_MAX_UPLOAD_FILES = 20;
export const DEFAULT_MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_UPLOAD_TOTAL_BYTES = 500 * 1024 * 1024;
export const DEFAULT_FILE_CHOOSER_TIMEOUT_MS = 2 * 60 * 1_000;

type FilePickMsg = Extract<Down, { t: "filepick" }>;

interface UploadMetadata {
  index: number;
  count: number;
  size: number;
  totalSize: number;
  name: string;
  mime: string;
}

interface PendingChooser {
  key: string;
  tabId: string;
  sourceTargetId: string;
  fileSessionId: string;
  backendNodeId: number;
  multiple: boolean;
  timer?: ReturnType<typeof setTimeout>;
  dead: boolean;
}

interface UploadBatch extends PendingChooser {
  count: number;
  totalSize: number;
  receivedSize: number;
  nextIndex: number;
  files: string[];
  batchDir: string;
  busy: boolean;
}

export interface UploadManagerOptions {
  sessionId: string;
  browser: BrowserHandle;
  /** Session-owned absolute directory removed after Chromium exits. */
  uploadDir: string;
  publish(message: FilePickMsg): void;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  chooserTimeoutMs?: number;
  /** Test seam; production keys are 192 random bits encoded for URLs. */
  createKey?: () => string;
  onError?: (error: unknown) => void;
}

export interface UploadManager {
  readonly sessionId: string;
  upload(key: string, metadata: UploadMetadata, body: Readable): Promise<void>;
  close(): void;
}

export interface UploadRouteOptions {
  /** SEC-2's exact session-cookie guard; intentionally required with no permissive fallback. */
  preHandler: SessionGuard["preHandler"];
  managerFor(sessionId: string): UploadManager | undefined;
}

interface UploadRouteParams {
  sid: string;
  key: string;
}

class UploadRequestError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

export async function createUploadManager(options: UploadManagerOptions): Promise<UploadManager> {
  const sessionId = nonEmpty(options.sessionId, "sessionId");
  const configuredUploadDir = nonEmpty(options.uploadDir, "uploadDir");
  const uploadDir = resolve(configuredUploadDir);
  if (!isAbsolute(uploadDir)) throw new TypeError("uploadDir must resolve to an absolute path");
  const maxFiles = positiveInteger(options.maxFiles ?? DEFAULT_MAX_UPLOAD_FILES, "maxFiles");
  const maxFileBytes = positiveInteger(
    options.maxFileBytes ?? DEFAULT_MAX_UPLOAD_FILE_BYTES,
    "maxFileBytes",
  );
  const maxTotalBytes = positiveInteger(
    options.maxTotalBytes ?? DEFAULT_MAX_UPLOAD_TOTAL_BYTES,
    "maxTotalBytes",
  );
  const chooserTimeoutMs = positiveInteger(
    options.chooserTimeoutMs ?? DEFAULT_FILE_CHOOSER_TIMEOUT_MS,
    "chooserTimeoutMs",
  );
  const createKey = options.createKey ?? (() => randomBytes(24).toString("base64url"));
  const report = options.onError ?? (() => undefined);
  const targetsById = new Map<string, TargetRef>();
  const targetsBySession = new Map<string, TargetRef>();
  const pending = new Map<string, PendingChooser>();
  const batches = new Map<string, UploadBatch>();
  const initialEnables: Promise<void>[] = [];
  let collectingInitialTargets = true;
  let chooserQueue = Promise.resolve();
  let closed = false;

  await mkdir(uploadDir, { recursive: true });

  const enableInterception = async (target: TargetRef): Promise<void> => {
    if (closed || target.type !== "page") return;
    await options.browser.send(target.sessionId, "Page.enable");
    if (closed || targetsBySession.get(target.sessionId) !== target) return;
    await options.browser.send(target.sessionId, "Page.setInterceptFileChooserDialog", {
      enabled: true,
    });
  };

  const runEnable = (target: TargetRef): void => {
    const enabled = enableInterception(target);
    if (collectingInitialTargets) initialEnables.push(enabled);
    else void enabled.catch((error: unknown) => !closed && report(error));
  };

  const clearRecordTimer = (record: PendingChooser): void => {
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.timer = undefined;
  };

  const cancelRemoteChooser = async (record: PendingChooser): Promise<void> => {
    const resolved = (await options.browser.send(record.fileSessionId, "DOM.resolveNode", {
      backendNodeId: record.backendNodeId,
    })) as { object?: { objectId?: unknown } } | undefined;
    const objectId = resolved?.object?.objectId;
    if (typeof objectId !== "string" || objectId === "") {
      throw new Error("DOM.resolveNode returned no file-input object");
    }
    try {
      await options.browser.send(record.fileSessionId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(){this.dispatchEvent(new Event('cancel',{bubbles:true}));}",
        returnByValue: true,
      });
    } finally {
      await options.browser
        .send(record.fileSessionId, "Runtime.releaseObject", { objectId })
        .catch(() => undefined);
    }
  };

  const abandon = (
    record: PendingChooser,
    optionsForAbandon: { cancel: boolean; removeFiles: boolean },
  ): void => {
    if (record.dead) return;
    record.dead = true;
    clearRecordTimer(record);
    pending.delete(record.key);
    batches.delete(record.key);
    if (optionsForAbandon.cancel) void cancelRemoteChooser(record).catch(report);
    const batchDir = (record as Partial<UploadBatch>).batchDir;
    if (optionsForAbandon.removeFiles && typeof batchDir === "string") {
      void rm(batchDir, { force: true, recursive: true }).catch(report);
    }
  };

  const armTimeout = (record: PendingChooser): void => {
    clearRecordTimer(record);
    record.timer = setTimeout(() => {
      abandon(record, { cancel: true, removeFiles: true });
    }, chooserTimeoutMs);
    record.timer.unref?.();
  };

  const openChooser = (
    sessionId: string,
    event: FlatSessionEventMap["Page.fileChooserOpened"],
  ): void => {
    if (closed) return;
    const source = targetsBySession.get(sessionId);
    // Interception is enabled only on top-level page sessions. Chromium reports an OOPIF's
    // frameId on that page event, which selects the child flat session for the DOM command.
    if (source?.type !== "page") {
      throw new Error(`file chooser opened on unknown CDP session ${sessionId}`);
    }
    if (!Number.isSafeInteger(event.backendNodeId) || (event.backendNodeId ?? 0) <= 0) {
      throw new Error("file chooser did not identify an input backendNodeId");
    }

    for (const record of [...pending.values(), ...batches.values()]) {
      abandon(record, { cancel: true, removeFiles: true });
    }

    const frameTarget = targetsById.get(event.frameId);
    const fileSessionId = frameTarget?.type === "iframe" ? frameTarget.sessionId : source.sessionId;
    const key = uniqueKey(createKey, pending, batches);
    const record: PendingChooser = {
      key,
      tabId: source.targetId,
      sourceTargetId: source.targetId,
      fileSessionId,
      backendNodeId: event.backendNodeId!,
      multiple: event.mode === "selectMultiple",
      dead: false,
    };
    pending.set(key, record);
    armTimeout(record);
    try {
      options.publish({
        t: "filepick",
        tab: record.tabId,
        key,
        multiple: record.multiple,
        maxFiles,
        maxFileBytes,
        maxTotalBytes,
      });
    } catch (error) {
      abandon(record, { cancel: true, removeFiles: false });
      throw error;
    }
  };

  const offChooser = options.browser.onSessionEvent(
    "Page.fileChooserOpened",
    (sessionId, event) => {
      chooserQueue = chooserQueue
        .then(() => openChooser(sessionId, event))
        .catch((error: unknown) => {
          if (!closed) report(error);
        });
    },
  );
  const offNavigation = options.browser.onSessionEvent(
    "Page.frameNavigated",
    (sessionId, event) => {
      if (closed || event.frame.parentId !== undefined) return;
      const target = targetsBySession.get(sessionId);
      if (target?.type !== "page") return;
      for (const record of [...pending.values(), ...batches.values()]) {
        if (record.tabId === target.targetId) {
          // The backend node no longer exists, so cancellation itself is no longer meaningful.
          abandon(record, { cancel: false, removeFiles: true });
        }
      }
      runEnable(target);
    },
  );

  options.browser.onDetached((target) => {
    if (targetsBySession.get(target.sessionId) !== target) return;
    targetsBySession.delete(target.sessionId);
    if (targetsById.get(target.targetId)?.sessionId === target.sessionId) {
      targetsById.delete(target.targetId);
    }
    for (const record of [...pending.values(), ...batches.values()]) {
      if (
        record.sourceTargetId === target.targetId ||
        record.fileSessionId === target.sessionId ||
        record.tabId === target.targetId
      ) {
        abandon(record, { cancel: false, removeFiles: true });
      }
    }
  });
  options.browser.onAttached((target) => {
    if (closed) return;
    const replaced = targetsById.get(target.targetId);
    if (replaced !== undefined && replaced.sessionId !== target.sessionId) {
      targetsBySession.delete(replaced.sessionId);
    }
    targetsById.set(target.targetId, target);
    targetsBySession.set(target.sessionId, target);
    if (target.type === "page") runEnable(target);
  });
  collectingInitialTargets = false;
  try {
    await Promise.all(initialEnables);
  } catch (error) {
    closed = true;
    offChooser();
    offNavigation();
    targetsById.clear();
    targetsBySession.clear();
    throw error;
  }

  const manager: UploadManager = {
    sessionId,
    async upload(key, metadata, body) {
      if (closed) throw new UploadRequestError(404, "Upload not found");
      assertUploadKey(key);
      validateMetadata(metadata, { maxFiles, maxFileBytes, maxTotalBytes });
      if (!(body instanceof Readable)) throw new UploadRequestError(400, "Upload body is required");

      let batch = batches.get(key);
      if (metadata.index === 0) {
        if (batch !== undefined) throw new UploadRequestError(409, "Upload file already received");
        const chooser = pending.get(key);
        if (chooser === undefined) throw new UploadRequestError(404, "Upload not found");
        if (!chooser.multiple && metadata.count !== 1) {
          throw new UploadRequestError(400, "File input accepts only one file");
        }
        // No await occurs between lookup and deletion, so concurrent first requests cannot win.
        pending.delete(key);
        clearRecordTimer(chooser);
        const batchDir = join(uploadDir, key);
        batch = {
          ...chooser,
          count: metadata.count,
          totalSize: metadata.totalSize,
          receivedSize: 0,
          nextIndex: 0,
          files: [],
          batchDir,
          busy: false,
        };
        batches.set(key, batch);
      }

      if (batch === undefined) throw new UploadRequestError(404, "Upload not found");
      if (batch.dead) throw new UploadRequestError(404, "Upload not found");
      if (batch.busy || metadata.index !== batch.nextIndex) {
        throw new UploadRequestError(409, "Upload files must be sent once and in order");
      }
      if (metadata.count !== batch.count || metadata.totalSize !== batch.totalSize) {
        throw new UploadRequestError(400, "Upload batch metadata changed");
      }
      if (batch.receivedSize + metadata.size > batch.totalSize) {
        throw new UploadRequestError(413, "Upload exceeds its declared total size");
      }

      batch.busy = true;
      clearRecordTimer(batch);
      batch.nextIndex += 1;
      const fileDir = join(batch.batchDir, String(metadata.index));
      const safeName = sanitizeUploadName(metadata.name);
      assertFileComponent(safeName, "upload filename");
      const filePath = join(fileDir, safeName);
      try {
        await mkdir(fileDir, { recursive: true });
        const limiter = byteLimiter(metadata.size);
        await pipeline(body, limiter.stream, createWriteStream(filePath, { flags: "wx" }));
        if (limiter.received() !== metadata.size) {
          throw new UploadRequestError(400, "Upload body size did not match its declaration");
        }
        if (batch.dead) throw new UploadRequestError(404, "Upload expired");
        batch.files.push(filePath);
        batch.receivedSize += metadata.size;
        batch.busy = false;

        if (batch.nextIndex < batch.count) {
          armTimeout(batch);
          return;
        }
        if (batch.receivedSize !== batch.totalSize) {
          throw new UploadRequestError(400, "Upload total size did not match its declaration");
        }
        await options.browser.send(batch.fileSessionId, "DOM.setFileInputFiles", {
          files: batch.files,
          backendNodeId: batch.backendNodeId,
        });
        batches.delete(key);
        clearRecordTimer(batch);
        batch.dead = true;
        // Chromium may read these paths lazily. The session owner removes uploadDir after exit.
      } catch (error) {
        abandon(batch, { cancel: true, removeFiles: true });
        if (!(error instanceof UploadRequestError)) report(error);
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      offChooser();
      offNavigation();
      for (const record of [...pending.values(), ...batches.values()]) {
        abandon(record, { cancel: true, removeFiles: true });
      }
      targetsById.clear();
      targetsBySession.clear();
    },
  };
  return manager;
}

export function registerUploadRoutes(app: FastifyInstance, options: UploadRouteOptions): void {
  if (typeof options.preHandler !== "function") {
    throw new TypeError("upload route requires the SEC-2 session preHandler");
  }
  if (!app.hasContentTypeParser(UPLOAD_CONTENT_TYPE)) {
    app.addContentTypeParser(UPLOAD_CONTENT_TYPE, (_request, payload, done) => {
      done(null, payload);
    });
  }

  app.post<{ Params: UploadRouteParams; Body: Readable }>(
    "/s/:sid/u/:key",
    { preHandler: options.preHandler },
    async (request, reply) => {
      const manager = options.managerFor(request.params.sid);
      if (manager === undefined) return reply.code(404).send({ error: "Upload not found" });
      let metadata: UploadMetadata;
      try {
        metadata = metadataFromHeaders(request.headers);
        await manager.upload(request.params.key, metadata, request.body);
      } catch (error) {
        if (error instanceof UploadRequestError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
      return reply.code(204).send();
    },
  );
}

function metadataFromHeaders(headers: Record<string, unknown>): UploadMetadata {
  const encodedName = singleHeader(headers["x-mirror-file-name"], "file name");
  if (encodedName.length === 0 || encodedName.length > MAX_ENCODED_NAME_LENGTH) {
    throw new UploadRequestError(400, "Invalid upload file name");
  }
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    throw new UploadRequestError(400, "Invalid upload file name encoding");
  }
  if (name === "" || name.includes("\0")) {
    throw new UploadRequestError(400, "Invalid upload file name");
  }
  const encodedMime = optionalSingleHeader(headers["x-mirror-file-type"]);
  if (encodedMime.length > MAX_MIME_LENGTH * 3) {
    throw new UploadRequestError(400, "Invalid upload MIME type");
  }
  let mime: string;
  try {
    mime = decodeURIComponent(encodedMime);
  } catch {
    throw new UploadRequestError(400, "Invalid upload MIME type encoding");
  }
  if (mime.length > MAX_MIME_LENGTH || /[^\x20-\x7e]/.test(mime)) {
    throw new UploadRequestError(400, "Invalid upload MIME type");
  }
  return {
    index: integerHeader(headers["x-mirror-file-index"], "file index"),
    count: integerHeader(headers["x-mirror-file-count"], "file count"),
    size: integerHeader(headers["x-mirror-file-size"], "file size"),
    totalSize: integerHeader(headers["x-mirror-total-size"], "total size"),
    name,
    mime,
  };
}

function validateMetadata(
  metadata: UploadMetadata,
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number },
): void {
  if (metadata.count < 1 || metadata.count > limits.maxFiles) {
    throw new UploadRequestError(413, "Too many upload files");
  }
  if (metadata.index < 0 || metadata.index >= metadata.count) {
    throw new UploadRequestError(400, "Invalid upload file index");
  }
  if (metadata.size < 0 || metadata.size > limits.maxFileBytes) {
    throw new UploadRequestError(413, "Upload file is too large");
  }
  if (metadata.totalSize < metadata.size || metadata.totalSize > limits.maxTotalBytes) {
    throw new UploadRequestError(413, "Upload batch is too large");
  }
}

function byteLimiter(maxBytes: number): { stream: Transform; received(): number } {
  let received = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(new UploadRequestError(413, "Upload body exceeds its declared size"));
        return;
      }
      callback(null, chunk);
    },
  });
  return { stream, received: () => received };
}

function sanitizeUploadName(name: string): string {
  const cleaned = name.replace(/[\0-\x1f\x7f/\\]/g, "_");
  let truncated = "";
  let bytes = 0;
  for (const char of cleaned) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > MAX_FILE_COMPONENT_BYTES) break;
    truncated += char;
    bytes += charBytes;
  }
  if (truncated === "" || truncated === "." || truncated === "..") return "upload";
  return truncated;
}

function uniqueKey(
  createKey: () => string,
  pending: Map<string, PendingChooser>,
  batches: Map<string, UploadBatch>,
): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const key = createKey();
    if (key !== "" && /^[A-Za-z0-9_-]+$/.test(key) && !pending.has(key) && !batches.has(key)) {
      return key;
    }
  }
  throw new Error("could not mint a unique upload key");
}

function assertUploadKey(key: string): void {
  try {
    assertFileComponent(key, "upload key");
  } catch {
    throw new UploadRequestError(404, "Upload not found");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new UploadRequestError(404, "Upload not found");
}

function assertFileComponent(value: string, name: string): void {
  if (
    value === "" ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`${name} must be one path component`);
  }
}

function singleHeader(value: unknown, name: string): string {
  if (typeof value !== "string") throw new UploadRequestError(400, `Missing upload ${name}`);
  return value;
}

function optionalSingleHeader(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerHeader(value: unknown, name: string): number {
  const raw = singleHeader(value, name);
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new UploadRequestError(400, `Invalid upload ${name}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new UploadRequestError(400, `Invalid upload ${name}`);
  return parsed;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim() === "") throw new TypeError(`${name} must not be empty`);
  return value;
}
