# DOM handoff review

Reviewed 2026-10-18 against upstream commit
[`2c9fb2a8ba89def4f655bccc7739bb598e95a740`](https://github.com/mystxcal/remote-browser/tree/2c9fb2a8ba89def4f655bccc7739bb598e95a740).

## Recommendation

The proposed DOM-first architecture is a credible way to improve perceived typing and scrolling latency. It changes the rendering model, rather than further tuning FRP. Evaluate it in a separate localhost prototype before choosing a replacement for the working deployment.

Upstream already implements local editing and scrolling, incremental reconstruction, reconnect recovery, and pixel fallback. It is not a ready-made multi-user LibreBrowser replacement. Its default runtime shares one session, its viewer introduces a new untrusted-content boundary, and its headful/media requirements conflict with parts of the handoff.

This is a static source review. No upstream dependencies, application, tests, or containers were executed. No dependency vulnerability scan or performance benchmark was performed. Production, accounts, profiles, DNS, v2rayA, and FRP were not changed by this review.

## What could improve

The current client displays a Selkies screen stream at 1920×1080 and 30 FPS. A visual response involves remote processing, capture, encoding, delivery, decoding, and painting. Reducing resolution or frame rate changes that pipeline; it cannot make editing local.

The proposed viewer reconstructs page content and can paint some interactions immediately. Upstream's [`echo.ts`](https://github.com/mystxcal/remote-browser/blob/2c9fb2a8ba89def4f655bccc7739bb598e95a740/packages/viewer/src/pipeline/echo.ts) supports native local editing with later remote reconciliation. Its [`scroll.ts`](https://github.com/mystxcal/remote-browser/blob/2c9fb2a8ba89def4f655bccc7739bb598e95a740/packages/viewer/src/pipeline/scroll.ts) scrolls locally while forwarding changes to Chromium. Text, selection, and already-loaded document scrolling are promising cases. DOM deltas could also reduce traffic on mostly static pages; this is not measured yet.

Local echo is optimistic. Server results, new content, website-script effects, and many drag operations still depend on remote execution. Echo reconciliation, layout differences, canvas content, and complex editors can reduce the advantage or cause visible corrections. A locally painted character is not proof the remote editor accepted it.

The previous FRP health-request median of approximately 37 ms is a tunnel/application probe, not Mac input-to-display latency. See [FRP performance](FRP_PERFORMANCE.md). It cannot be used as a DOM-rendering benchmark.

## Upstream audit

| Area | Finding at the reviewed commit | Required adaptation |
| --- | --- | --- |
| License | Apache-2.0 source, LICENSE/NOTICE and third-party notices present. | Retain required notices and change attribution; check resolved package and image licenses before distributing a fork. |
| Dependencies | Node 22 range, pnpm 9.15.9, TypeScript, Fastify, Preact, Puppeteer/CDP, ws, Undici, rrweb. Lockfile and a recorder/replayer version check exist. | Pin the evaluated revision and matching rrweb packages; run dependency/image audits and upstream checks in the prototype environment. CI definitions are not evidence of passing results. |
| Session composition | `main.ts` uses `SESSION_ID = "dev"` and one browser. Shared-password/invite driver/viewer roles are not individual LibreBrowser accounts. | Route each authenticated account to its own isolated engine and Chromium, or implement and test an equivalent tenant-aware composition. |
| Lifecycle | Session-manager modules exist but are not wired into the default entrypoint. Compose starts Chromium with `restart: unless-stopped`. | Add broker-controlled on-demand startup, ownership checks, reconnect, persistent profiles and configurable idle cleanup. |
| Headless | Supported entrypoint runs Chromium under Xvfb; architecture documentation says capture/compositor behavior motivated headful mode. | Test true headless operation and target-site compatibility. Removing Xvfb is an acceptance gate, not an assumed one-line fix. |
| Sandbox | Chromium sandbox remains enabled and runs as a non-root user, but Compose grants `SYS_ADMIN` and `SYS_CHROOT`. | Validate a narrower runtime/seccomp/user-namespace arrangement, or stronger isolation. Do not disable Chromium's sandbox or weaken global host protections to make the prototype work. |
| DOM containment | Replay iframe omits scripts, but remains same-origin for parent DOM access. Upstream explicitly describes markup as inert rather than sanitized. | Separate untrusted rendering from the account/admin origin and review the full content/asset boundary. |
| Network policy | Default browser bridge has no automatic private-network egress denial. Asset hostname checks and subsequent connections are separate operations. | Enforce policy at the actual connection boundary, including DNS changes, redirects, IPv6 and every asset-fetch path. |
| Media | Canvas/video can use WebRTC. Pixel fallback uses CDP JPEG screencast, quality 60. | Establish a media delivery strategy and benchmark fallback; do not assume parity with the existing H.264 stream. |
| Compatibility | Source includes IME handling and tests, fixtures, and media checks. | Perform the requested real-site and Mac input tests; source coverage does not establish Gmail/Docs/Google-account compatibility. |

Key upstream references: [architecture](https://github.com/mystxcal/remote-browser/blob/2c9fb2a8ba89def4f655bccc7739bb598e95a740/docs/architecture.md), [security model](https://github.com/mystxcal/remote-browser/blob/2c9fb2a8ba89def4f655bccc7739bb598e95a740/docs/security.md), [Compose](https://github.com/mystxcal/remote-browser/blob/2c9fb2a8ba89def4f655bccc7739bb598e95a740/compose.yml), [license](https://github.com/mystxcal/remote-browser/blob/2c9fb2a8ba89def4f655bccc7739bb598e95a740/LICENSE).

## Security and routing details to add to the handoff

### Keep the account origin separate

Removing visited-page JavaScript does not make arbitrary markup, styles, SVG, fonts, and proxied response bodies equivalent to pixels. The upstream security document explicitly disclaims hardened multi-tenant isolation.

Use a dedicated untrusted renderer origin, distinct from login/admin and their cookies. Put the DOM controller on that renderer origin and communicate with the trusted shell through a narrow, validated message protocol. Keep replay frames scriptless; audit resource rewriting, navigations, response types, CSP and asset authorization. Origin separation requires architectural work because the existing parent directly accesses replay DOM. It is not solved just by adding a sanitizer or moving a URL.

### Enforce v2rayA and destination policy for all fetching

The asset route checks resolved addresses, then hands the original URL to a separate fetcher. This leaves a DNS check/connection race to address; it is a source-level risk finding, not a demonstrated exploit in this review. The fetcher can load through CDP or perform a direct Undici request, including requests that copy browser cookies.

Consequently, setting a Chromium proxy alone is insufficient. Both Chromium and Node asset fetching must use the controlled egress path through v2rayA, with private/metadata/special-address policy enforced at actual destination selection and connection. Keep CDP private, isolate users' networks and asset caches, scope tokens to the authenticated owner, and deny public access to the launcher/Docker socket. Add adversarial tests before using real accounts.

Source: [asset route](https://github.com/mystxcal/remote-browser/blob/2c9fb2a8ba89def4f655bccc7739bb598e95a740/packages/gateway/src/assets/route.ts), [fetch lanes](https://github.com/mystxcal/remote-browser/blob/2c9fb2a8ba89def4f655bccc7739bb598e95a740/packages/gateway/src/assets/fetch.ts).

### Decide how media crosses the network

WebRTC signaling over the app WebSocket does not automatically send media through FRP. Test Mac-to-home ICE connectivity separately; the earlier failed VPS UDP transport tests do not settle every possible WebRTC path. If direct connectivity fails, choose either an authenticated relay with explicitly approved networking or HTTPS pixel fallback. A relay adds deployment scope and may conflict with the requirement for only one public HTTPS entrypoint.

Upstream JPEG fallback may behave worse than the current H.264 path for high-motion content. DRM/EME content is another compatibility limit identified upstream. Test target sites and record which interactions use DOM, WebRTC or pixels.

## Revised implementation sequence

1. Preserve the working deployment as the baseline. Pin the upstream revision, inspect resolved dependencies, and build in an isolated environment. Keep a patch log for the fork.
2. Establish sandbox, controlled egress, and renderer/account-origin boundaries for a disposable single-user localhost prototype. Basic hardening belongs before real Google credentials, rather than late in the implementation sequence.
3. Compare the current viewer and DOM prototype on the same Mac, network, viewport and workloads. Use disposable fixtures first, then explicit manual tests for Google login, Gmail, Docs, YouTube, clipboard, uploads/downloads and Chinese IME. Inspect synthetic data rather than existing browsing content.
4. Select the engine only if the measured experience improves on the workloads the user actually needs. A fast plain textarea is insufficient if the important editor needs slow pixel fallback.
5. Prefer retaining the existing Go authentication, SQLite accounts, admin UI and restricted broker. Add a private Node/TypeScript rendering engine per active user. This reduces account migration risk while still reusing upstream. A full Node rewrite is a separate choice, not necessary for DOM mirroring.
6. Add per-user engine lifecycle, cache/media/transfer isolation, owner checks on every operation and socket, reconnect and idle shutdown. Test two concurrent accounts and malicious cross-account requests, not only separate profile directories.
7. Implement any remaining UI and setup requirements. Explicitly approve behavior changes from the old specification: five-minute idle becomes configurable with ten-minute default; CLI initialization becomes single-use web setup for fresh installs. Existing admins should keep their accounts and passwords.
8. Integrate Caddy/FRP only after localhost isolation, compatibility and performance gates pass. Use a reversible canary route, then a controlled migration. Leave the existing FRP optimization and browser v2rayA routing intact.

Use fresh disposable Chromium profiles for the prototype. Never open the same profile from two Chromium processes. Before production migration, stop its browser, back up its profile, verify Chromium-version compatibility and rollback behavior, and account for possible Google reauthentication. Do not assume profiles can be downgraded safely.

## Measurements and acceptance evidence

Record versions, hardware, capture/rendering mode, viewport, network RTT/load and test procedure. Compare repeated runs and report median and p95, not only a best run.

| Workload or property | Evidence required |
| --- | --- |
| Typing | Input-to-local-paint and input-to-authoritative-confirmed-paint separately; corrections, dropped/duplicated text and caret jumps. |
| Chinese IME | Mac composition candidates, marked text, selection, commit, cancellation and rapid switching in plain and rich editors. |
| Scroll and drag | Local frame timing, remote convergence, document/inner scrollers, drag correctness and any pixel fallback. |
| Real sites | Login persistence, Gmail compose, Docs editing/selection, YouTube playback/audio, transfers and reconnect; failures documented plainly. |
| Efficiency | Cold/warm startup, idle/active CPU, memory, network bytes, and percentage of time in DOM versus pixel mode. |
| Isolation | Two users with distinct test accounts; attempts to reuse another user's session/tab/asset/upload/download/media identifiers denied. |
| Lifecycle | Reconnect before/after timeout, profile resume, logout/session revocation, disabled users, and reboot with no automatic browser launch. |
| Network containment | Private/metadata IPv4 and IPv6, DNS rebinding, redirects, direct asset fallback and cross-user service access tested. |

Agree on pass thresholds from the measured baseline before rollout. No speedup, lower resource use, universal site compatibility, or production readiness is established by this static review.
