# DOM rendering implementation

Status (2026-10-19): the user chose LinuxServer Chromium streaming after testing the prototype. The private DOM service is stopped. Its accounts/profile data and source are retained; the prototype is not the active deployment.

LibreBrowser retains the Go account gateway, Argon2id/SQLite accounts, revocable sessions, administration UI and restricted Docker broker. An opt-in Node/TypeScript engine reconstructs webpages locally from server Chromium's DOM events. Production streaming remains the default until the DOM overlay is deliberately deployed.

## Rendering and ownership

Each active account owns one engine container containing Node and sandboxed headless Chromium, plus its existing filtered egress sidecar. Chromium is controlled over a pipe; no CDP listener or browser host port is published. DOM changes, browser controls, input, tabs, clipboard and transfers use an authenticated WebSocket/HTTP path.

The account shell and renderer use different origins. In production they must have different HTTPS hostnames on the same site, for example `browser.home.libremedicine.org` and `render.browser.home.libremedicine.org`. Both can use the existing FRP visitor: the Go gateway dispatches the renderer hostname before its account routes. No second public TCP service or CDP route is needed. The optional separate renderer listener is for localhost development.

A CSRF-protected account API issues a 60-second single-use ticket, delivered in a URL fragment. The renderer exchanges it for a host-only HttpOnly cookie. That grant remains bound to the original login session, user and browser run. Every resource checks ownership; connected sockets recheck revocation once per second. Renderer credentials grant no account/admin access. Stop, logout, reset, disable, deletion and session expiry invalidate the appropriate grants.

The trusted renderer controller runs locally; visited-site JavaScript stays in server Chromium. The nested replay frame remains scriptless. The controller itself is framed with a sandbox that allows scripts/forms/downloads but no top navigation. Asset responses reject executable HTML/JS types and isolate SVG content. Resource URLs, including stylesheet/icon links and CSS imports, are proxied. Chromium and Node's direct/range asset-fetch lane both use the filtered egress proxy and existing v2rayA uplink. Redirects reselect cookies for each destination and do not send the client to a visited resource origin.

DOM is the default. Repeated reconstruction failures produce an explicit compatibility warning. Pixel fallback is a deliberate user choice and is labelled; it is not counted as local DOM rendering. WebRTC media may need connectivity unavailable in the current isolated network. Google Docs, video, DRM, browser extensions and complex canvas editors require real compatibility testing.

## Resource lifecycle

- Login starts a user's engine on demand. Multiple devices share that account's engine; one controls it at a time, with an explicit takeover control.
- **Stop browser** closes Chromium, removes the engine and egress containers, and releases their networks. Only the persistent profile volume remains.
- The default disconnected idle timeout is **10 minutes**, configurable with `BROWSER_IDLE_MINUTES=1..1440`. Any connected authenticated viewer keeps the browser active.
- Broker recovery stops orphan engines; containers have restart policy `no`. Rebooting does not launch every user's Chromium.
- Limits cover the entire Node/Chromium engine: default 2 GiB RAM, two CPU cores, 512 PIDs and 512 MiB shared memory. The root filesystem is read-only. All capabilities are dropped. The vendored seccomp profile permits Chromium's user-namespace sandbox setup without granting `SYS_ADMIN` or disabling Chromium's sandbox.
- Browser singleton lock/socket symlinks are removed only when starting the exclusively owned profile in a new engine. Profile data survives graceful stop or forced container cleanup.

DOM resources are labelled separately from streaming resources and scoped to a broker instance. The localhost prototype cannot recover/stop production's streaming containers. See [engine provenance and changes](../engine/UPSTREAM.md).

## Build and automated verification

See [the verification results](DOM_VERIFICATION.md) for completed checks and remaining manual tests.

```sh
# On this homeserver Docker builds currently need the host's working build network.
BUILD_NETWORK=host scripts/build-dom.sh

go test -race ./internal/libre ./cmd/librebrowser
LIBREBROWSER_DOM_LIVE_TEST=1 go test -v ./internal/libre -run '^TestLiveDOM$' -count=1
```

The live test creates only disposable users/profiles and a separate broker. It launches a real client Chromium, types through the local mirror, checks server-confirmed text and Chinese composition, uploads/downloads known bytes, switches users, removes/recreates a container, checks profile persistence, and loads Google's public homepage through controlled egress. Test resources are removed afterward. It never logs into or inspects real Google accounts. Screenshots contain only the synthetic fixture or unauthenticated Google homepage.

The engine Docker build checks recorder/replayer versions, compiles and type-checks TypeScript. Gateway/viewer unit suites and the dependency audit can be run from its build stage:

```sh
docker build --network host --target build -f engine/Dockerfile -t librebrowser-dom-build:local engine
docker run --rm librebrowser-dom-build:local sh -c \
  'pnpm --filter @mirror/gateway test && pnpm --filter @mirror/viewer test'
docker run --rm --network host librebrowser-dom-build:local pnpm audit --prod
```

The original upstream lockfile had security advisories. The fork pins patched Fastify/Undici versions and patched affected transitive packages. Retain the lockfile and rerun audits after dependency changes. A clear dependency audit is not a complete application security assessment.

## Private Mac test instance

The operator-prepared instance uses a consistent, private **copy** of the existing LibreBrowser account database, without active login sessions, and fresh DOM profiles. Existing usernames/passwords work. Account changes here affect only the copy; production accounts and profiles are unchanged. The UI identifies it as a DOM test.

The private runtime directory defaults to `run/dom-prototype/` (mode 0700, database mode 0600), which is excluded from Git and Docker build contexts. The app runs as a transient systemd user service so it survives the operator terminal closing. It is not enabled to start at boot. Start/stop/status:

```sh
scripts/dom-prototype.sh export-binary
scripts/dom-prototype.sh start
scripts/dom-prototype.sh status
scripts/dom-prototype.sh stop
```

For a fresh test installation instead of an account copy, export the binary and run `DATABASE_PATH="$PWD/run/dom-prototype/librebrowser.db" run/dom-prototype/librebrowser admin init --username thatyt` interactively before starting. Do not put a password in command arguments or logs.

On your Mac, forward **both ports** using your normal SSH connection to the homeserver:

```sh
ssh -N -L 18090:127.0.0.1:18090 -L 18091:127.0.0.1:18091 thatyt@192.168.10.141
```

If you normally reach homeserver SSH through FRP, use that SSH target and port instead, keeping both `-L` options. Then open **http://localhost:18090** on the Mac. Keep both forwarded ports unchanged: the origin and cookie checks use those exact URLs. The renderer on localhost:18091 is not a separate login page. HTTP is allowed only for this loopback test; SSH encrypts transport between machines.

Use your existing LibreBrowser password, then log into Google separately in the fresh DOM profile. Verify Gmail, Docs, YouTube, scrolling, dragging, clipboard, Chinese IME and transfers on the Mac. Stop/reopen the browser and check Google login persistence. Only you can validate your actual accounts and preferred sites; automated fixtures do not establish those results.

## Public rollout and rollback

First complete the private Mac compatibility test. Add DNS for the separate renderer hostname pointing to the existing VPS, then validate the Caddy renderer block in `deploy/Caddyfile.dom-renderer.example`. It reuses the private visitor; preserve the current FRP transport and scoped bypass.

After the required production networking approval and a protected backup, set `RENDERER_ORIGIN`, retain the existing account volume, and deploy the combined `compose.yaml`, `compose.v2raya.yaml` and `compose.dom.yaml` configuration with `--no-build`. Stop the old broker gracefully first so it flushes/stops its owned streaming browsers. The DOM overlay uses the separately built control/engine image tags and disables the extra renderer TCP listener.

DOM profiles have separate broker-scoped volumes. **Streaming profiles are preserved, not silently converted.** A production DOM profile may require a new Google login. Never mount one profile into two running Chromiums or assume a profile downgrade is safe. Copy/migrate only after stopping its browser, taking a protected backup and checking Chromium version compatibility.

Rollback: stop the DOM app/broker gracefully, preserve their profiles, then redeploy the original streaming Compose configuration/images. Remove the renderer Caddy block only after reverting the application. The original accounts and streaming profiles remain available; DOM-only profile changes are not merged into them. Prototype shutdown never deletes account/profile data.
