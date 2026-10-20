# Architecture

Remote Browser separates the authoritative browser from an inert semantic viewer. Chromium is the
only place where visited-site scripts execute, cookies live, network requests originate, and
trusted input is applied.

## Runtime components

### Chromium

The supported Compose path runs Debian Chromium as uid/gid `10001` under Xvfb. Its CDP endpoint is
reachable only on the Compose network and has no host port mapping. The default profile directory
is on tmpfs; `compose.persistent.yml` replaces it with a named volume.

Chromium binds DevTools to container loopback. A container-local TCP forwarder exposes that
listener to the gateway on the private Compose network; neither endpoint is published on the host.

Chromium runs headfully because canvas/video capture and compositor behavior differ in headless
mode. Back/forward cache is disabled so history traversal produces a new injectible document.
The browser sandbox remains enabled; the container never uses `--no-sandbox`.

### In-page agent

The bundled agent is installed into every attached page and iframe target. rrweb records a full
snapshot and ordered mutations. A randomized isolated-world bridge and CDP `Runtime.addBinding`
move chunked messages out of the renderer without opening a page WebSocket or depending on page
CSP.

The recorder runs where it can observe DOM, shadow DOM, canvas, CSS, and input changes. Password
inputs remain masked. Recorder and replay packages are pinned to the same exact rrweb version;
`scripts/check-rrweb-versions.mjs` enforces that invariant.

### Gateway

The Fastify gateway is the composition root:

- CDP target lifecycle and agent injection;
- a canonical full snapshot plus ordered delta tail per tab;
- WebSocket fan-out with slow-viewer drop-and-resync behavior;
- node-aware input resolution and trusted CDP dispatch;
- URL navigation, tab lifecycle, viewport agreement, uploads, and downloads;
- access password, signed session invites, roles, and driver transfer;
- sealed asset URLs, private-address rejection, credential-aware fetch, and caching;
- WebRTC signaling and CDP screencast fallback.

The built viewer is served from the same origin. This simplifies cookies, WebSocket routing, asset
URLs, and production reverse proxies.

### Viewer

The Preact viewer reconstructs rrweb events into a sandboxed iframe. Its sandbox contains exactly
`allow-same-origin`; scripts, forms, popups, top navigation, and direct downloads are not enabled.
The parent can therefore attach input handlers and address mirror nodes while visited-site scripts
and inline handlers do not run.

The viewer cancels navigation-bearing local defaults. Links and form actions are forwarded as
input to remote Chromium, while local selection, find, hover, scroll, and optimistic editable
state stay responsive.

## Data flows

### Page to viewer

1. Site JavaScript changes the authoritative page.
2. rrweb observes the change and emits an event.
3. The agent chunks the event through a CDP binding with document and message identity.
4. The gateway reassembles it, validates ordering, and updates the tab hub.
5. WebSocket fan-out sends one serialized event to every healthy viewer.
6. Each viewer applies it to the scriptless replay tree.

A new viewer receives the latest snapshot plus the ordered tail. Sequence gaps, replay errors,
viewport changes, and bounded-buffer trimming can request a fresh epoch.

### Viewer to page

1. A viewer interacts directly with a mirrored node.
2. The viewer sends its rrweb node id, relative coordinates, and input details.
3. The gateway asks the current agent realm to resolve the authoritative node and rectangle.
4. The gateway dispatches `Input.*` through CDP.
5. Resulting authoritative mutations return through the normal capture path.

Local echo makes typing and scrolling responsive, but remote Chromium remains authoritative and
eventually reconciles viewer state.

### Assets

Resource-bearing rrweb values are rewritten to sealed gateway URLs. The gateway verifies the
session and token, resolves the destination, rejects private/link-local targets, and loads bytes
through Chromium where possible so site credentials are preserved. The direct range/fallback lane
copies the browser cookie and user agent. Viewers should not contact visited origins for mirrored
assets.

### Media and pixel fallback

Ordinary DOM remains semantic. Canvas and capturable video can negotiate viewer-scoped WebRTC
tracks, with signaling carried over the authenticated WebSocket. If capture is unavailable or the
mirror diverges, a tab can switch to `Page.startScreencast` pixels. Pixel input uses the same
authorized control path.

## State and recovery

Each tab has document identity, epoch, sequence, snapshot, and delta-tail state. The system favors
bounded state and cheap recovery:

- stale document messages are dropped;
- missing sequence numbers trigger resync;
- slow viewers stop receiving deltas instead of growing an unbounded queue;
- a fresh snapshot resets a diverged replay;
- pixel mode provides a user-visible fallback.

## Current deployment boundary

The portable Compose runtime deliberately supports one browsing session. A tested session manager
and Docker browser host remain in `packages/gateway/src/session`, including TTL cleanup and named
profile support, but they are not wired to the default composition root. The public MVP uses
Compose itself for browser lifecycle and an explicit persistent-profile overlay.
