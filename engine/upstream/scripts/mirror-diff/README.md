# P2-DIFF mirror fidelity instrument

This full-stack semantic fidelity harness includes trusted interaction checks. It launches the
real gateway, pipe-connected authoritative Chrome, injected agent, viewer, and a second viewer
Chrome. It never imports or substitutes package internals.

## Default regression lane

```sh
CHROME_PATH=/usr/bin/google-chrome pnpm run p2-diff
```

`CHROME_PATH` defaults to `/usr/bin/google-chrome`. The command builds first so the gateway never
uses a stale agent bundle. `pnpm run ci` runs the same deterministic subset after the package
build/typecheck/tests.

The self-hosted fixtures cover:

- content/article;
- muted autoplay media, including a forced mid-session full-snapshot resync;
- list/feed;
- forms and initial value state;
- a locally served, pinned React 18 controlled SPA;
- a real same-origin nested iframe/document set; and
- nested light DOM plus an open shadow root.

Every fixture contains the same stable interaction checkpoint. Through trusted Playwright input in
the replay frame, the harness clicks an anchor, Tabs between form controls and types, changes a
`<select>` with the keyboard, and wheel-scrolls an overflow region. The authoritative and mirrored
documents are sampled before and after that script.

Sampling waits for all of the following:

- the fixture HTTP server has no active requests and has been idle for 500 ms;
- browser resource entry counts are stable for 500 ms;
- authoritative and mirrored mutation rates are at most 2 records/second; and
- both DOMs sustain that quiet condition for 700 ms.

Immediately before the post-interaction sample, the harness also polls the exact scored control,
deep-focus, and scroll state until server and mirror remain matched and stable for 300 ms. This
poll is bounded at 4 seconds: convergence selects the settled pair, while timeout selects the final
pair and lets the ordinary fidelity gate fail. The wait never waives or retries a divergence.

Only `[data-diff-root]` regions are scored. A deliberately dynamic descendant can opt out with
`data-diff-ignore`. Collection recurses into same-origin frames and open shadow roots.

The report compares normalized innerText, total elements, per-tag counts, images, and
input/textarea/select values. The post-interaction score also gates deep activeElement, recursively
collected values, and window/marked-element scroll positions. Default minimums are 97% static, 95%
post-interaction, 95% text/structure, and 99% interaction state. Environment variables
`P2_DIFF_STATIC_MIN`, `P2_DIFF_POST_MIN`, `P2_DIFF_TEXT_MIN`, `P2_DIFF_STRUCTURE_MIN`, and
`P2_DIFF_INTERACTION_MIN` can tighten them.

The stable baseline is written to `scripts/out/p2-diff.md` and `scripts/out/p2-diff.json`, and the
score table is the final stdout block. Use `P2_DIFF_FIXTURE=<id>` for a local diagnostic subset.

To prove that the threshold mechanism rejects degradation:

```sh
P2_DIFF_FIXTURE=content P2_DIFF_FAULT=drop-text pnpm run p2-diff
```

Supported fault probes are `drop-text`, `drop-controls`, and `drop-images`; each mutates only the
harness's mirror sample and must make the command exit nonzero.

## Default cross-site OOPIF CI lane

The OOPIF fixture runs after the default seven-fixture lane in `pnpm run ci`. Run it standalone with:

```sh
CHROME_PATH=/usr/bin/google-chrome pnpm run p2-diff:oopif
```

CI invokes `p2-diff:ci` and `p2-diff:oopif:ci`, which make at most three clean attempts only when
the runner explicitly identifies a cold-start, Chromium/port, or bounded-wait infrastructure
failure. Score divergence, interaction mismatches, unknown failures, and all `P2_DIFF_FAULT`
probes exit immediately without retry. Direct `p2-diff:run` and `p2-diff:oopif` runs remain
single-attempt diagnostics.

This launches fixture Chromium with `--site-per-process` and host-resolver mappings for
`a.test`, `b.test`, and `c.test`. It requires a real iframe-type target, drives the embedded
anchor/Tab/10× exact typing/select/wheel script at 150ms simulated RTT, checks a `b.test` to
`c.test` renderer swap, forced resync plus viewport survival, and the same-origin fold-in detach.
Per-assertion output is written to `scripts/out/p2-diff-oopif.{md,json}`.

Before that interaction script, the harness sends acknowledged pointer probes through the embedded
field until cross-site `resolveNode` plus composed-rect lookup adds no vx/vy fallback for a stable
300ms window. Readiness is bounded at 5 seconds and fails explicitly if it never arrives. Because
the gateway counter is cumulative, the harness records its post-readiness baseline and still
requires the interaction script itself to add exactly zero fallbacks.

The zero-fallback check expects the gateway test hook
`GET /__e2e/input-stats?tab=…` to return `{ "rectFallbacks": 0 }`. Until that hook exists, the
lane reports a specific failing assertion instead of silently treating the metric as zero.

To prove the stitched-child checks have teeth, this command must exit nonzero:

```sh
CHROME_PATH=/usr/bin/google-chrome P2_DIFF_OOPIF=1 P2_DIFF_FAULT=drop-child-frame pnpm run p2-diff
```

## Opt-in real sites

```sh
CHROME_PATH=/usr/bin/google-chrome pnpm run p2-diff:real
```

This runs live Wikipedia and Hacker News through generic link/form/scroll scripts and writes
`scripts/out/p2-diff-real.{md,json}`. Those files are ignored, and this mode is intentionally absent
from CI because origin content and network access are unstable.

The fixture server also exposes advisory public-embed specimens at
`/fixtures/live-youtube-embed` and `/fixtures/live-consent-iframe`; these are reserved for the
real-sites lane and are never part of deterministic CI.
