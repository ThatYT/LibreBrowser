import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";

const HARNESS_LOCK_DIR = "/tmp/remote-browser-p2-diff.lock";
const LOCK_WAIT_MS = 5 * 60_000;
const LOCK_POLL_MS = 250;
const PROCESS_STOP_TIMEOUT_MS = 15_000;

/**
 * Exit code consumed by scripts/p2-diff-ci.mjs. Fidelity failures deliberately use the ordinary
 * exit code 1; only a narrowly classified harness/timeout failure may request a fresh full-stack
 * attempt.
 */
export const TRANSIENT_INFRA_EXIT_CODE = 75;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeStaleLock(): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(`${HARNESS_LOCK_DIR}/owner.json`, "utf8")) as {
      pid?: unknown;
    };
    if (typeof owner.pid === "number" && processExists(owner.pid)) return;
  } catch {
    // Do not steal a directory during the tiny mkdir -> owner.json creation window.
    try {
      const lockStat = await stat(HARNESS_LOCK_DIR);
      if (Date.now() - lockStat.mtimeMs < 5_000) return;
    } catch {
      return;
    }
  }
  await rm(HARNESS_LOCK_DIR, { force: true, recursive: true });
}

/**
 * The full-stack lanes are intentionally serialized across worktrees. Each lane launches two
 * Chromiums plus the recursive dev stack; concurrent cold starts caused both resource starvation
 * and free-port TOCTOU races. Holding this lock for the whole lane removes that shared-test-infra
 * contention without changing any product assertion.
 */
export async function acquireHarnessLock(): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(HARNESS_LOCK_DIR);
      await writeFile(
        `${HARNESS_LOCK_DIR}/owner.json`,
        JSON.stringify({
          pid: process.pid,
          cwd: process.cwd(),
          startedAt: new Date().toISOString(),
        }),
        { flag: "wx" },
      );
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(HARNESS_LOCK_DIR, { force: true, recursive: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleLock();
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
    }
  }
  throw new Error(`Timed out waiting for the full-stack harness lock ${HARNESS_LOCK_DIR}`);
}

function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pgid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !processGroupExists(pgid);
}

/** Kill the complete detached pnpm/dev/Chromium group even if its pnpm leader exited early. */
export async function stopProcessGroup(child: ChildProcess): Promise<void> {
  const pgid = child.pid;
  if (pgid === undefined) return;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  if (await waitForProcessGroupExit(pgid, PROCESS_STOP_TIMEOUT_MS)) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await waitForProcessGroupExit(pgid, PROCESS_STOP_TIMEOUT_MS);
}

function errorText(error: unknown): string {
  const values: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    values.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  if (values.length === 0) values.push(String(error));
  return values.join("\n");
}

/**
 * Keep this allow-list narrow. An unknown assertion or a score/interaction mismatch is fidelity
 * and must fail immediately; only known cold-start, process, port, and bounded-wait errors retry.
 */
export function isTransientInfraFailure(error: unknown): boolean {
  if (process.env.P2_DIFF_FAULT) return false;
  const detail = errorText(error);
  return [
    /timed out/i,
    /timeout \d+ms exceeded/i,
    /prerequisite failed/i,
    /recorder not ready; retry snapshot/i,
    /please take full snapshot after start recording/i,
    /mirror document disappeared/i,
    /target page, context or browser has been closed/i,
    /browser.*(?:closed|disconnected)/i,
    /chrom(?:e|ium).*(?:launch|exited|endpoint)/i,
    /pnpm dev exited early/i,
    /EADDRINUSE|EADDRNOTAVAIL|ECONNREFUSED|ECONNRESET|EPIPE/i,
  ].some((pattern) => pattern.test(detail));
}
