import { spawn } from "node:child_process";

const TRANSIENT_INFRA_EXIT_CODE = 75;
const MAX_ATTEMPTS = 3;
const lane = process.argv[2];

if (lane !== "default" && lane !== "oopif") {
  throw new Error("usage: node scripts/p2-diff-ci.mjs <default|oopif>");
}

function runAttempt(attempt) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["run", "p2-diff:run"], {
      cwd: process.cwd(),
      env: { ...process.env, ...(lane === "oopif" ? { P2_DIFF_OOPIF: "1" } : {}) },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, attempt }));
  });
}

// Fault probes are deliberate fidelity failures. They must never be retried or accidentally pass
// because a later clean attempt replaced their report. Ordinary assertion failures likewise exit
// 1 and fail immediately; only the runner's explicit transient-infra code reaches the retry path.
const attempts = process.env.P2_DIFF_FAULT ? 1 : MAX_ATTEMPTS;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  console.error(`P2-DIFF CI ${lane}: attempt ${attempt}/${attempts}`);
  const result = await runAttempt(attempt);
  if (result.code === 0) process.exit(0);
  if (result.code !== TRANSIENT_INFRA_EXIT_CODE) {
    if (result.signal) console.error(`P2-DIFF CI ${lane}: terminated by ${result.signal}`);
    console.error(`P2-DIFF CI ${lane}: non-retryable fidelity/harness failure`);
    process.exit(result.code ?? 1);
  }
  if (attempt === attempts) {
    console.error(`P2-DIFF CI ${lane}: transient infrastructure failure exhausted retries`);
    process.exit(TRANSIENT_INFRA_EXIT_CODE);
  }
  console.error(`P2-DIFF CI ${lane}: transient infrastructure failure; retrying cleanly`);
}
