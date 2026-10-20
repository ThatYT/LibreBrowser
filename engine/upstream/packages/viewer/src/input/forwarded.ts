/** One per-mirror clock shared by native editing capture and committed change capture. */
export interface ForwardedInputClock {
  mark(nodeId: number, timestamp: number): void;
  get(nodeId: number): number | undefined;
  forget(nodeId: number): void;
  clear(): void;
}

export function createForwardedInputClock(): ForwardedInputClock {
  const timestamps = new Map<number, number>();
  return {
    mark(nodeId, timestamp) {
      if (nodeId >= 0) timestamps.set(nodeId, timestamp);
    },
    get(nodeId) {
      return timestamps.get(nodeId);
    },
    forget(nodeId) {
      timestamps.delete(nodeId);
    },
    clear() {
      timestamps.clear();
    },
  };
}
