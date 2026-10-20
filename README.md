# LibreBrowser

A small Go service providing authenticated, per-user LinuxServer Chromium sessions. English / [简体中文](README.zh-CN.md).

LinuxServer Chromium streaming is the active deployment. Its desktop follows the browser viewport to avoid letterboxing, with capture limited to 30 FPS and CSS scaling enabled to avoid Retina-resolution capture. The experimental [DOM rendering implementation](docs/DOM_IMPLEMENTATION.md) is retained separately; its private prototype is stopped after the user chose to return to streaming.

**Deployed at [browser.home.libremedicine.org](https://browser.home.libremedicine.org).** LibreBrowser and Chromium run on the homeserver; the VPS terminates HTTPS and forwards through a private FRP tunnel. Existing accounts and profiles were retained. Real two-user Chromium streaming, profile isolation, public-only egress checks, revocation and the five-minute idle shutdown were exercised during localhost acceptance. See the [verification report](docs/VERIFICATION.md) for exact results and remaining deployment gates.

The interface opens a bilingual, black-and-white login form and then a Selkies browser with a compact Account / Log out bar. There is no public registration. Administrators have a Users page for account management. Log out is always visible above the stream, including during startup and reconnects. Password change and logout are also at `/account`; administrators can open Users from the browser bar.

## Local development

Requires Go 1.26+ (tested with 1.27.2). No Node, Redis or external database.

```sh
go mod download
go test ./...
go vet ./...
go build -o bin/librebrowser ./cmd/librebrowser
./bin/librebrowser admin init --username thatyt
LOCAL_DEV=true PUBLIC_ORIGIN=http://localhost:8090 ./bin/librebrowser serve
```

Visit `http://localhost:8090`. This starts the real authentication service on loopback. Chromium requires the separate Docker broker; without it, successful login presents a reconnect screen. This is not a simulated browser. Local development allows a non-Secure cookie only on an explicitly configured loopback HTTP listener. Normal operation requires HTTPS and Secure cookies.

## Docker setup

Requires Docker Engine 28+, Compose v2 and permission to use the Docker daemon. Review [deployment instructions](docs/DEPLOYMENT.md) first.

```sh
./scripts/install.sh
# Interactive password prompt; never supplied in argv, environment or a committed file:
docker compose run --rm --no-deps app admin init --username thatyt
# Configure .env, including the exact trusted proxy source CIDR, before startup.
docker compose up -d
```

The only published port is `127.0.0.1:8090`. For an isolated TLS test use the local Caddy example and `PUBLIC_ORIGIN=https://localhost:9443`. Do not change the existing Caddy/FRP services. The setup script only builds and pulls images; it does not start services or alter system configuration.

To route browsing through an existing host v2rayA instance, see the [v2rayA uplink instructions](docs/DEPLOYMENT.md#existing-host-v2raya). Containers do not inherit the host's system proxy. This opt-in integration keeps v2rayA on loopback and preserves destination restrictions.

Emergency recovery, from a trusted local terminal:

```sh
docker compose exec app librebrowser admin reset-password --username thatyt
```

LibreBrowser accounts are independent of Linux accounts. Neither command reads or changes a Linux password. Access to the database volume or Docker is privileged recovery access. The bootstrap command refuses to run after the first account exists. The last enabled administrator cannot be deleted, disabled or demoted. Password changes and resets revoke all affected logins, including active streams within about one second.

## Administration

Open **Users** in the browser bar or visit `/admin/users` while signed in as an administrator to add accounts, set initial passwords, reset other users' passwords and remove accounts. Resetting a password revokes that user's logins; removal asks for confirmation and preserves the saved browser profile. Your own password change stays under Account and requires your current password. The Users link is hidden for ordinary users, and the server enforces admin permissions on every account-management API.

See [API reference](docs/API.md) for additional controls: disable, promote, demote, inspect application session state and stop browsers. Their own browser remains separate from every other user's. Knowing another user ID never grants access to their stream.

```sh
./scripts/update.sh
```

Updates stop only this Compose project and save a private, consistent database/WAL backup. Browser profile volumes persist. Review and pull a tested Chromium digest separately; changing the image setting alone does not replace existing browser containers. See the deployment guide for replacement and rollback.

## Architecture and limitations

- SQLite WAL stores accounts and random-token session hashes. Passwords use Argon2id (64 MiB, three iterations, two lanes).
- The unprivileged web server has no Docker socket. It calls a Unix-socket broker exposing fixed start/stop/status/proxy operations. The broker has Docker's host-level authority; protect its image and socket like root access.
- Each user gets a private `internal` Docker network with `isolated` gateway mode, an unmodified `lscr.io/linuxserver/chromium` container, a persistent named profile volume, and a small Go egress sidecar. The sidecar resolves and pins public IPs and permits only HTTP/HTTPS ports 80/443. Private, loopback, metadata, multicast and special ranges are rejected. Browser traffic has no direct internet route. Egress forwarding is disabled.
- The broker joins each private network for streaming and exposes no TCP listener. No browser streaming ports are published. Chromium containers have no host mounts, devices or Docker socket.
- Native authenticated WebSocket connections count as activity. The browser stops after the configured disconnected timeout (default ten minutes) following the last stream disconnect, with a short sweep interval. Failed starts without streams also expire. Devices reconnect to the same user browser; the tested upstream client hands off its primary connection. The streaming engine disables simultaneous same-user sharing/control; the opt-in DOM engine supports device control takeover. A login lasts 24 hours, without silent renewal.
- Broker startup stops owned orphan containers. Web-server startup also requests recovery; a broker lease watchdog stops browsers if the web server disappears for five minutes. Profile volumes survive.
- The tested upstream Chromium may show a restore prompt after signal-based shutdown; profiles/history were retained. The broker requests a profile flush before stopping the container.
- User deletion revokes access and stops the browser but retains the profile volume for deliberate operator disposal. Resource names use non-reused random IDs. Network and profile deletion is an explicit offline operation.
- Only ordinary proxied public web browsing is intended. Direct UDP, WebRTC transport, arbitrary ports, uploads/downloads and remote terminal/command features are disabled or unavailable. This can affect some websites.
- Upstream currently launches Chromium with `--no-sandbox`; the container is the primary isolation boundary. Containers share the host kernel; this is not a VM sandbox for hostile tenants. Public host/VPS management addresses must be explicitly denied in `EGRESS_DENY_CIDRS`. Docker embedded DNS metadata and a compromised egress sidecar are additional boundaries to audit.
- Login throttling is process-local, shared across users behind the same reverse proxy; restarting resets it. The deliberate global cap is 60 attempts/minute and peer cap is 10/15 minutes. Forwarded client IPs are not used.

Upstream references: [Chromium](https://docs.linuxserver.io/images/docker-chromium/), [Selkies reverse proxy](https://docs.linuxserver.io/selkies/user-guide/reverse-proxy/), [hardening settings](https://docs.linuxserver.io/selkies/user-guide/configuration/), [Docker isolated gateway mode](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).
