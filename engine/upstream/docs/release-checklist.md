# Release checklist

## Scope and provenance

- [ ] Diff is intentional and the working tree is clean.
- [ ] No internal logs, research captures, profiles, downloads, credentials, or private paths.
- [ ] `LICENSE`, `NOTICE`, dependency license fields, and third-party notices are current.
- [ ] `CHANGELOG.md` and the release version/date are current.
- [ ] New dependencies have an identified license and are represented in the lockfile.

## Quality

- [ ] Node and pnpm versions match `package.json`, `.nvmrc`, and CI.
- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm audit:prod`
- [ ] `CHROME_PATH=/path/to/chrome pnpm run ci`
- [ ] `docker compose config`
- [ ] `pnpm smoke:compose`
- [ ] Development mode and production container build both start.
- [ ] Gateway health reports a live browser.
- [ ] Ephemeral and persistent-profile Compose modes were checked.

## Security and privacy

- [ ] Secret scan covers the working tree and every commit in the release history.
- [ ] Examples contain placeholders only.
- [ ] CDP is not published and Chromium still runs non-root with its sandbox.
- [ ] HTTPS, egress filtering, persistence risk, and semantic-viewer boundary remain documented.
- [ ] Test artifacts contain no private page data.

## Documentation

- [ ] Quick start works on a clean Linux Docker host.
- [ ] Feature status and limitations match the shipped composition.
- [ ] Configuration table matches Compose and code.
- [ ] Links resolve and commands use current filenames.
- [ ] Upgrade, shutdown, volume deletion, and rollback behavior are clear.

## Tag preparation

- [ ] Version and changelog/release notes are prepared.
- [ ] CI is green on the release commit.
- [ ] Container image metadata and source commit are recorded.
- [ ] Known limitations and upgrade notes are included in the release notes.
