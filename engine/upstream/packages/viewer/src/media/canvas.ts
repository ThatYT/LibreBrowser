/**
 * Trusted-parent canvas snapshot compositing.
 *
 * This intentionally accepts only rrweb's sampled bitmap command shape. Arbitrary recorded
 * canvas commands remain disabled with Replayer UNSAFE_replayCanvas=false.
 */
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import type { Mirror } from "../mirror";

interface SerializedArrayBuffer {
  rr_type: "ArrayBuffer";
  base64: string;
}

interface SerializedBlob {
  rr_type: "Blob";
  data: [SerializedArrayBuffer];
  type: string;
}

interface SerializedImageBitmap {
  rr_type: "ImageBitmap";
  args: [SerializedBlob];
}

interface CanvasSnapshot {
  id: number;
  clear: [number, number, number, number];
  image: SerializedImageBitmap;
  x: number;
  y: number;
}

type DecodedBitmap = CanvasImageSource & { close?: () => void };

interface PendingSnapshot {
  snapshot: CanvasSnapshot;
  resolve: (painted: boolean) => void;
}

interface CanvasLane {
  pending: PendingSnapshot | null;
}

export interface CanvasCompositorOptions {
  decodeBitmap?: (blob: Blob) => Promise<DecodedBitmap>;
  /** RTC owns the canvas while its live track is healthy; snapshots remain the warm fallback. */
  isLive?: (id: number) => boolean;
  onError?: (error: unknown) => void;
}

export interface CanvasCompositor {
  /** Apply one rrweb canvas snapshot. Resolves false for unrelated or no-longer-live canvases. */
  apply(event: eventWithTime): Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numericTuple(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  return value.every((part) => typeof part === "number" && Number.isFinite(part))
    ? (value as number[])
    : null;
}

function parseImageBitmap(value: unknown): SerializedImageBitmap | null {
  if (!isRecord(value) || value.rr_type !== "ImageBitmap") return null;
  if (!Array.isArray(value.args) || value.args.length !== 1) return null;
  const blob = value.args[0];
  if (
    !isRecord(blob) ||
    blob.rr_type !== "Blob" ||
    typeof blob.type !== "string" ||
    !blob.type.startsWith("image/")
  ) {
    return null;
  }
  if (!Array.isArray(blob.data) || blob.data.length !== 1) return null;
  const buffer = blob.data[0];
  if (
    !isRecord(buffer) ||
    buffer.rr_type !== "ArrayBuffer" ||
    typeof buffer.base64 !== "string" ||
    buffer.base64.length === 0
  ) {
    return null;
  }
  return value as unknown as SerializedImageBitmap;
}

function parseSnapshot(event: eventWithTime): CanvasSnapshot | null {
  if (event.type !== EventType.IncrementalSnapshot) return null;
  if (event.data.source !== IncrementalSource.CanvasMutation) return null;
  if (event.data.type !== 0 || !("commands" in event.data)) return null;

  const clearCommand = event.data.commands.find((command) => command.property === "clearRect");
  const drawCommand = event.data.commands.find((command) => command.property === "drawImage");
  if (clearCommand === undefined || drawCommand === undefined) return null;
  const clear = numericTuple(clearCommand.args, 4);
  if (clear === null || drawCommand.args.length !== 3) return null;
  const image = parseImageBitmap(drawCommand.args[0]);
  const position = numericTuple(drawCommand.args.slice(1), 2);
  if (image === null || position === null) return null;

  return {
    id: event.data.id,
    clear: clear as CanvasSnapshot["clear"],
    image,
    x: position[0]!,
    y: position[1]!,
  };
}

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

async function defaultDecodeBitmap(blob: Blob): Promise<DecodedBitmap> {
  return createImageBitmap(blob);
}

function lookupCanvas(mirror: Pick<Mirror, "getReplayer">, id: number): HTMLCanvasElement | null {
  const node = mirror.getReplayer()?.getMirror().getNode(id);
  // Realm-safe: mirror nodes belong to the replay iframe, not the trusted parent Window.
  if (node?.nodeType !== 1 || node.nodeName.toLowerCase() !== "canvas") return null;
  return node as HTMLCanvasElement;
}

export function createCanvasCompositor(
  mirror: Pick<Mirror, "getReplayer">,
  options: CanvasCompositorOptions = {},
): CanvasCompositor {
  const decodeBitmap = options.decodeBitmap ?? defaultDecodeBitmap;
  const lanes = new Map<number, CanvasLane>();

  const paint = async (snapshot: CanvasSnapshot): Promise<boolean> => {
    try {
      if (options.isLive?.(snapshot.id) === true) return false;
      const payload = snapshot.image.args[0];
      const bytes = decodeBase64(payload.data[0].base64);
      const bitmap = await decodeBitmap(new Blob([bytes], { type: payload.type }));
      try {
        // The track can arrive while bitmap decoding is in flight. Never let that older sampled
        // frame overwrite the live lane after the upgrade.
        if (options.isLive?.(snapshot.id) === true) return false;
        const canvas = lookupCanvas(mirror, snapshot.id);
        const context = canvas?.getContext("2d");
        if (context === null || context === undefined) return false;
        context.clearRect(...snapshot.clear);
        context.drawImage(bitmap, snapshot.x, snapshot.y);
        return true;
      } finally {
        bitmap.close?.();
      }
    } catch (error) {
      options.onError?.(error);
      return false;
    }
  };

  const drain = async (id: number, lane: CanvasLane, first: PendingSnapshot): Promise<void> => {
    let current: PendingSnapshot | null = first;
    while (current !== null) {
      current.resolve(await paint(current.snapshot));
      current = lane.pending;
      lane.pending = null;
    }
    if (lanes.get(id) === lane) lanes.delete(id);
  };

  return {
    apply(event) {
      const snapshot = parseSnapshot(event);
      if (snapshot === null) return Promise.resolve(false);

      return new Promise<boolean>((resolve) => {
        const next = { snapshot, resolve };
        const lane = lanes.get(snapshot.id);
        if (lane === undefined) {
          const newLane: CanvasLane = { pending: null };
          lanes.set(snapshot.id, newLane);
          void drain(snapshot.id, newLane, next);
          return;
        }
        // Decoding must stay ordered, but stale not-yet-started frames are pure wasted CPU.
        lane.pending?.resolve(false);
        lane.pending = next;
      });
    },
  };
}
