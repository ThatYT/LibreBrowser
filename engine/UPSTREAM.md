# Vendored rendering engine

Source: https://github.com/mystxcal/remote-browser
Revision: 2c9fb2a8ba89def4f655bccc7739bb598e95a740 (2026-09-05).
License: Apache-2.0. Original LICENSE, NOTICE, THIRD_PARTY_NOTICES.md and source are retained in upstream/.

LibreBrowser modifications:
- Private per-account composition using the broker's header credential; upstream shared-password/invite authentication and debug CDP API disabled.
- Chromium and Undici asset fetching use the mandatory filtered egress proxy.
- Non-root, sandboxed headless Chromium launched over a pipe in the engine container. Root launches fail closed.
- Per-account session IDs and persistent profile storage; process/container lifetime controlled by Go broker.
- Separate renderer origin handled by Go; renderer credentials never grant account/admin access.
- Explicit pixel fallback only, visible rendering-mode label, smaller live-event buffer.

The upstream Compose files, Xvfb launch scripts and Docker launcher are retained for attribution/reference; LibreBrowser does not deploy those paths. Build using engine/Dockerfile and compose.dom.yaml at the repository root.

Chromium seccomp profile: https://github.com/microsoft/playwright/blob/v1.56.1/utils/docker/seccomp_profile.json (Apache-2.0, Microsoft Corporation). Stored in internal/libre/chromium-seccomp.json; adds `chroot` to the unconditional namespace-setup allow rule so it can run inside Chromium’s user namespace without granting host capabilities; otherwise retains the upstream syscall filtering and drops all capabilities. No host-wide seccomp/AppArmor settings are changed.
