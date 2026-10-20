/**
 * Re-requests cross-origin child snapshots after rrweb has registered their host iframe.
 *
 * rrweb 2.1.1 does not buffer child FullSnapshots that arrive before registration and does not
 * request another child snapshot after a top-level checkout. This private agent-to-agent message
 * closes both holes while keeping rrweb's parent-side iframe ID transform canonical.
 */

export const STITCH_SYNC_MESSAGE_TYPE = "@mirror/stitch-sync";
export const STITCH_READY_MESSAGE_TYPE = "@mirror/stitch-ready";
export const STITCH_SYNC_MIN_INTERVAL_MS = 250;

export interface StitchSyncDependencies {
  isRecorderStarted(): boolean;
  onRecorderStarted(listener: () => void): () => void;
  takeFullSnapshot(): void;
  now?: () => number;
}

export function isCrossOriginChild(target: Window = window): boolean {
  if (target.parent === target) return false;

  try {
    // Keep this probe aligned with rrweb 2.1.1's passEmitsToParent detection.
    void target.parent.document;
    return false;
  } catch {
    return true;
  }
}

export function broadcastStitchSync(target: Window = window): void {
  for (const frame of Array.from(target.frames)) {
    frame.postMessage({ type: STITCH_SYNC_MESSAGE_TYPE }, "*");
  }
}

export function installStitchReadyListener(target: Window = window): () => void {
  const onMessage = (event: MessageEvent): void => {
    if (
      typeof event.data !== "object" ||
      event.data === null ||
      (event.data as { type?: unknown }).type !== STITCH_READY_MESSAGE_TYPE ||
      event.source === null
    ) {
      return;
    }

    // Reply directly to the ready child. A nested child forwards the resulting sync to its own
    // descendants, preserving the depth>=2 path without waking unrelated sibling recorders.
    (event.source as Window).postMessage({ type: STITCH_SYNC_MESSAGE_TYPE }, "*");
  };

  target.addEventListener("message", onMessage);
  return () => target.removeEventListener("message", onMessage);
}

export function installStitchSyncListener(
  target: Window,
  dependencies: StitchSyncDependencies,
): () => void {
  const now = dependencies.now ?? Date.now;
  let lastSnapshotAt = Number.NEGATIVE_INFINITY;
  let pendingSnapshot = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const honorPendingSnapshot = (): void => {
    if (!pendingSnapshot || !dependencies.isRecorderStarted()) return;

    const snapshotAt = now();
    const elapsed = snapshotAt - lastSnapshotAt;
    if (elapsed < STITCH_SYNC_MIN_INTERVAL_MS) {
      if (pendingTimer === null) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          honorPendingSnapshot();
        }, STITCH_SYNC_MIN_INTERVAL_MS - elapsed);
      }
      return;
    }

    try {
      dependencies.takeFullSnapshot();
      pendingSnapshot = false;
      lastSnapshotAt = snapshotAt;
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      pendingTimer = null;
    } catch {
      // Keep the request queued if rrweb's recording flag trails our FullSnapshot readiness
      // signal. The stitch-ready response provides another attempt from a later task.
    }
  };

  const removeRecorderStartedListener = dependencies.onRecorderStarted(() => {
    target.parent.postMessage({ type: STITCH_READY_MESSAGE_TYPE }, "*");
    honorPendingSnapshot();
  });

  const onMessage = (event: MessageEvent): void => {
    if (
      typeof event.data !== "object" ||
      event.data === null ||
      (event.data as { type?: unknown }).type !== STITCH_SYNC_MESSAGE_TYPE
    ) {
      return;
    }

    // Forward even while this recorder is starting so an intermediate frame cannot prevent a
    // ready descendant from honoring the request.
    broadcastStitchSync(target);

    pendingSnapshot = true;
    honorPendingSnapshot();
  };

  target.addEventListener("message", onMessage);
  return () => {
    removeRecorderStartedListener();
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    target.removeEventListener("message", onMessage);
  };
}
