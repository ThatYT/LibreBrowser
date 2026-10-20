/**
 * Viewer event pipeline shared by typing echo and scroll suppression.
 * Domain: viewer.
 *
 *     WS -> decode -> [EchoFilter] -> [ScrollFilter] -> replayer.addEvent
 *
 * All echo logic lives in stages that filter/transform events BEFORE replayer.addEvent — do NOT
 * patch or fork the Replayer. Stages keep per-node state; register a reset hook so resync
 * (which rebuilds the Replayer and invalidates node ids) clears it.
 */
import type { eventWithTime, TabId } from "@mirror/protocol";

export interface PipelineCtx {
  tab: TabId;
  nowMs: number;
}

/** Return the (possibly transformed) event, or null to drop it. */
export type Stage = (e: eventWithTime, ctx: PipelineCtx) => eventWithTime | null;

export class EventPipeline {
  private stages: Stage[] = [];
  private resetHooks: Array<() => void> = [];

  use(stage: Stage): this {
    this.stages.push(stage);
    return this;
  }

  /** Register cleanup for per-node state; invoked by reset() on every resync (D10). */
  onReset(hook: () => void): this {
    this.resetHooks.push(hook);
    return this;
  }

  run(e: eventWithTime, ctx: PipelineCtx): eventWithTime | null {
    let cur: eventWithTime | null = e;
    for (const stage of this.stages) {
      if (cur === null) return null;
      cur = stage(cur, ctx);
    }
    return cur;
  }

  reset(): void {
    for (const hook of this.resetHooks) hook();
  }
}
