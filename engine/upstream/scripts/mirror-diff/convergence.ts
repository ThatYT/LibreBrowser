export interface ConvergenceSample<T> {
  server: T;
  mirror: T;
}

export interface ConvergenceResult<T> {
  converged: boolean;
  sample: ConvergenceSample<T>;
  elapsedMs: number;
}

interface ConvergenceOptions<T> {
  read: () => Promise<ConvergenceSample<T>>;
  matches: (sample: ConvergenceSample<T>) => boolean;
  sameState: (left: T, right: T) => boolean;
  timeoutMs: number;
  settleMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

/**
 * Converge-then-sample contract: return after a matching pair remains stable for `settleMs`.
 * If the bounded deadline wins, return the final observed pair without claiming convergence so the
 * caller can score/assert that real divergence normally; a timeout is never a fidelity waiver.
 */
export async function pollForStableConvergence<T>(
  options: ConvergenceOptions<T>,
): Promise<ConvergenceResult<T>> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const startedAt = now();
  let stableSince: number | undefined;
  let previousMatch: ConvergenceSample<T> | undefined;

  while (true) {
    const sample = await options.read();
    const sampledAt = now();
    if (options.matches(sample)) {
      const unchanged =
        previousMatch !== undefined &&
        options.sameState(previousMatch.server, sample.server) &&
        options.sameState(previousMatch.mirror, sample.mirror);
      if (!unchanged) stableSince = sampledAt;
      previousMatch = sample;
      if (sampledAt - stableSince! >= options.settleMs) {
        return { converged: true, sample, elapsedMs: sampledAt - startedAt };
      }
    } else {
      stableSince = undefined;
      previousMatch = undefined;
    }

    const elapsedMs = sampledAt - startedAt;
    if (elapsedMs >= options.timeoutMs) {
      return { converged: false, sample, elapsedMs };
    }
    await sleep(Math.min(options.pollMs, options.timeoutMs - elapsedMs));
  }
}
