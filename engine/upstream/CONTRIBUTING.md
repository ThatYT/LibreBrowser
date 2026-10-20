# Contributing

Thanks for helping improve Remote Browser. Small, testable changes with a clear compatibility or
operator benefit are easiest to review.

## Setup

Use Node 22.23.1 and pnpm 9.15.9:

```bash
corepack enable
pnpm install --frozen-lockfile
CHROME_PATH=/path/to/chromium pnpm run ci
```

For normal development:

```bash
MIRROR_ACCESS_PASSWORD=dev-only CHROME_PATH=/path/to/chromium pnpm dev
```

The gateway listens on port 3000 and Vite on 5173 unless overridden.

## Change guidelines

- Preserve the semantic DOM path; do not replace it with a pure pixel desktop.
- Keep CDP private and Chromium sandboxing enabled.
- Keep all `@rrweb/*` packages on one exact version.
- Add deterministic unit or fixture coverage for behavior changes.
- Prefer a fresh snapshot and bounded recovery over unbounded queues or fragile repair logic.
- Do not add real credentials, private page captures, browser profiles, or downloaded artifacts.
- Document user-visible configuration and threat-boundary changes.

Run `pnpm format` only on files you intend to change, then run `pnpm run ci`. Container changes should
also pass `pnpm smoke:compose`.

## Pull requests

Explain the problem, the chosen boundary, verification commands, and any security or compatibility
tradeoff. Keep unrelated refactors separate. By submitting a contribution, you agree that it is
licensed under Apache License 2.0.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a detailed public issue.
