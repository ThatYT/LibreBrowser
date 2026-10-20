/**
 * rrweb 2.1.1's numeric canvas sampler creates a Worker from a string blob URL during record().
 * Documents that enforce Trusted Types for script URLs reject that constructor synchronously,
 * aborting the entire recorder before its first FullSnapshot. Probe the same capability before
 * enabling that optional sampler; the separate canvas WebRTC plugin does not depend on it.
 */
export function canStartCanvasSnapshotWorker(scope: typeof globalThis = globalThis): boolean {
  if (
    typeof scope.Worker !== "function" ||
    typeof scope.Blob !== "function" ||
    typeof scope.URL?.createObjectURL !== "function"
  ) {
    return false;
  }

  const url = scope.URL.createObjectURL(
    new scope.Blob([""], { type: "text/javascript;charset=utf-8" }),
  );
  try {
    const worker = new scope.Worker(url);
    worker.terminate();
    return true;
  } catch {
    return false;
  } finally {
    scope.URL.revokeObjectURL(url);
  }
}
