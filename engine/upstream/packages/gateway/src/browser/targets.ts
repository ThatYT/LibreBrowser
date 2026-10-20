/**
 * Browser target attach/detach bookkeeping and OOPIF handling.
 *
 * Tracks attached targets, maps OOPIF targets to their owning tab, survives OOPIF process swaps
 * (detach+reattach with same frameId, different targetId — P2-OOPIF).
 */
import type { TargetRef } from "../types";

export class TargetRegistry {
  /** targetId -> ref for all currently attached targets. */
  readonly targets = new Map<string, TargetRef>();

  add(t: TargetRef): void {
    this.targets.set(t.targetId, t);
  }

  remove(targetId: string): void {
    this.targets.delete(targetId);
  }

  /** The top-level page targets = the session's tabs. */
  tabs(): TargetRef[] {
    return [...this.targets.values()].filter((target) => target.type === "page");
  }
}
