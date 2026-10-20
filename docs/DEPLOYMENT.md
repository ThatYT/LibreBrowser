# Isolated deployment and acceptance

## Environment inspected

The Ubuntu host has Docker 29.1.3, active Caddy and FRP, and existing HomeCloud app/office/database/Redis containers. Existing Caddy serves internal TLS at `192.168.10.141:8443`, forwarding to `127.0.0.1:6080`. Existing service listeners include 8080, 8082, 6080, 6900 and 6901. LibreBrowser uses dedicated loopback ports 8090 and 9443.

After the user granted temporary Docker-socket access, selected non-secret FRP fields were inspected through a read-only mount. Credentials were not returned. The existing routes are:

| Service | Local endpoint | VPS TCP port |
| --- | --- | --- |
| SSH | `127.0.0.1:22` | 6022 |
| Existing V2rayA panel | `127.0.0.1:2017` | 62017 |
| Existing desktop | `127.0.0.1:6080` | 60800 |
| Nextcloud | `127.0.0.1:8080` | 60810 |
| OnlyOffice | `127.0.0.1:8082` | 60820 |

The original proxy ports above remain unchanged. LibreBrowser uses separate `librebrowser-frpc` (home) and `librebrowser-frp-visitor` (VPS) services, with the VPS visitor bound only to `127.0.0.1:60830`. After separate approval and benchmarks, both homeserver FRP clients now use verified WSS on port 443 and all participants disable TCP multiplexing. VPS Caddy serves `browser.home.libremedicine.org` and its exact FRP transport path. The inspected VPS address is denied in the browser egress policy. See [PUBLIC_ROUTE.md](PUBLIC_ROUTE.md) and [FRP_PERFORMANCE.md](FRP_PERFORMANCE.md) for the active topology, measurements and coordinated rollback.

Further changes to existing FRP, Caddy, SSH, firewall rules, daemon settings or unrelated services need authorization. Docker will create only dedicated `lb-*` container resources and Compose project resources when explicitly run with daemon access. The application and base setup scripts do not edit the host firewall. The separately approved FRP transport optimization installs root-owned helpers managing only their service-cgroup routing marks, as recorded in `FRP_PERFORMANCE.md`.

## Local authentication only

Build with Go, initialize an administrator interactively and start the loopback server as in README. A Go toolchain was temporarily downloaded and checksum verified under `/tmp/librebrowser-toolchain`; it is not a permanent system installation. The prebuilt development executable is ignored by Git at `bin/librebrowser`.

`LOCAL_DEV=true` rejects non-loopback listeners or non-loopback HTTP origins. It exists solely for localhost authentication testing. It must not be used behind FRP or a public proxy.

## Full isolated Docker test

1. Use an operator terminal with Docker access. Do not grant Docker privileges to the web process or publish Docker over TCP.
2. Run `scripts/install.sh`; examine the expanded `docker compose config`. Pin a tested Chromium image digest in `.env` before any public deployment.
3. Set `PUBLIC_ORIGIN=https://localhost:9443`. Set `TRUSTED_PROXY_CIDRS` to the actual immediate Caddy source as seen in the app container, normally the dedicated Compose bridge gateway `/32`. Find it using `docker network inspect librebrowser_default`; do not use `0.0.0.0/0`. Trusting loopback alone will not work when Caddy reaches a Docker-published port through the bridge.
4. Initialize `thatyt` using `docker compose run --rm --no-deps app admin init --username thatyt`. Choose your own password locally. No password was preconfigured in source.
5. Start only this project with `docker compose up -d`. Run a separate Caddy process with `caddy run --config deploy/Caddyfile.local`. Its admin API is disabled and it binds only `127.0.0.1:9443`; it does not load or reload `/etc/caddy/Caddyfile`. Use a private writable Caddy data directory if the existing service owns the default path.
6. Visit `https://localhost:9443` and explicitly trust the isolated development certificate in your test browser. Do not disable TLS verification in production or install a development root globally through these scripts.
7. Run the opt-in real-container tests: `docker compose -f compose.yaml -f deploy/compose.test.yaml run --build --rm acceptance`. This creates two random test users' Docker resources without database accounts, probes real Selkies pages, tests concurrent starts and container reuse, then removes only its own test resources. Allow several minutes and sufficient RAM. Do this with the web app idle; these broker-direct test containers are otherwise unknown to application activity tracking.

## Required interactive acceptance before public deployment

Record image digest, Docker version, browser versions, results and any failures. Passing the unit/API suite alone is insufficient.

- Initialize `thatyt`; switch login languages. Confirm cookies are Secure/HttpOnly/SameSite=Strict over TLS. Create two ordinary users using the admin API.
- Log in as both users simultaneously from separate browser profiles. Confirm video, audio, input, clipboard, resize and mobile touch work. Confirm the actual Selkies streaming upgrades return 101 through both proxy layers.
- Set distinct cookies/history/bookmarks in each Chromium. Verify no cross-user state. Stop/restart each container and confirm its actual browsing state survives. The automated live test checks container reuse; it does not prove browser history durability.
- Connect one user from two devices. Disconnect one: the browser must stay running. Disconnect both: it must stop after the configured disconnected timeout (default 10 minutes) plus at most a sweep interval. Reconnect during the grace period. Temporarily interrupt WebSocket connectivity and confirm login persists.
- Revoke a login, change/reset password, disable/delete an account and demote an administrator. Confirm new requests fail and existing streams close. Confirm the last enabled administrator is protected.
- Request HTML/assets/WebSocket endpoints with no cookie, an expired cookie, another user's path, wrong Origin, forged forwarded headers, and a non-admin cookie for every admin route.
- Inspect `docker inspect lb-browser-<id>`: no published ports, only own profile volume, no devices/socket, bounded memory/CPU/PIDs, no restart policy, expected hardening settings. Verify terminals, sudo, sharing, file/command endpoints and alternative Selkies transports are actually disabled, not merely hidden.
- From Chromium try private IPv4/IPv6, loopback, host gateway, metadata `169.254.169.254`, other users' private addresses and host management services. Test IP literals, redirects, DNS answers changing from public to private, and IPv4-mapped IPv6. Private targets must fail while ordinary public HTTPS works.
- From a test process inside a browser container attempt direct TCP/UDP to host/private/public IPs, Docker embedded DNS names and sibling containers. Confirm the internal `isolated` gateway and egress forwarding settings prevent bypassing the HTTP proxy. Test DNS behavior explicitly; a standard internal bridge alone is insufficient.
- Add the actual host/VPS public IPs, public management services and any sensitive publicly addressed infrastructure to `EGRESS_DENY_CIDRS`. They are not automatically discoverable from a private-only server inspection. Recreate egress containers after changing this setting.
- Kill/restart app and broker independently. Confirm idle/recovered containers stop, profiles survive, and browser containers stay stopped after host reboot until login. Verify graceful termination on the pinned image.
- Scan from another machine: neither 8090 nor any streaming/management port should be reachable. Run a vulnerability scan of both application and upstream image. Review Docker's daemon trust boundary and host kernel isolation.

## Next deployment stage

Only after the above checks and explicit user approval: review the recorded FRP inventory and the VPS-side Caddy/FRPS configuration, decide where TLS terminates, prepare an exact FRP/Caddy change and review it before applying. The confirmed hostname is `browser.home.libremedicine.org`. The activated route through the existing VPS/FRP server is recorded in [PUBLIC_ROUTE.md](PUBLIC_ROUTE.md). Keep the Go service's Origin exact and trust only the actual immediate reverse proxy. In a multi-hop FRP topology, document each trust boundary; do not blindly accept forwarded headers from arbitrary peers.

Back up the accounts volume with the app stopped (include WAL files) and each user's `lb-profile-*` volume with Chromium stopped. Backups contain private browsing data. Test restores with matching ownership (app UID/GID 10001; Chromium profile UID/GID 1000), and never restore a live SQLite file alone without its WAL.

Updating the app does not replace the unmodified upstream Chromium containers. After a tested image change, stop affected browsers, remove only their stopped `lb-browser-*` containers, and keep profile volumes. Recreate matching egress containers when the service image or egress deny list changes. The next authenticated start reuses the named profile. For a permanently deleted account, dispose of its stopped browser/egress containers, disconnect the broker from its private network, delete its two networks, and remove its `lb-profile-*` volume only after confirming backup/retention requirements. Do not use broad `docker system prune` or `compose down -v` as an update step.

## Host forwarding observed during acceptance

The host initially had `net.ipv4.ip_forward=0`. Creating the dedicated Compose bridge caused Docker to enable it; it later returned to zero while the V2rayA core had restarted. The component resetting it was not identified. With the user’s explicit approval, runtime forwarding was set to `1`; no persistent sysctl configuration was edited. Docker bridge egress requires it. Check this value if DNS resolves but browser proxy tunnels time out. Coordinate a persistent solution with the existing network/proxy owner before public deployment; do not blindly overwrite V2rayA or firewall configuration.

Before bridge egress became available, the images were successfully built using `docker build --network=host -t librebrowser:local .` and the analogous acceptance Dockerfile command. `BUILD_NETWORK=host docker compose build app` is an optional build-only workaround; runtime containers retain their isolated networking.


## Existing host v2rayA

The default egress sidecar opens public TCP connections itself; it does not inherit the host's desktop proxy. On the inspected homeserver, v2rayA's HTTP ports 20171/20172 listen on loopback only. Docker containers cannot reach that listener through their own `127.0.0.1`. Do not give Chromium host networking or enable broad LAN proxy sharing to work around this.

The opt-in `compose.v2raya.yaml` adds a small unprivileged `v2raya-uplink` service using the host network solely to reach `127.0.0.1:20171`. It listens only on a Unix socket in a dedicated private named volume; it publishes no TCP ports and mounts no Docker socket. Only egress sidecars mount that volume, read-only. Browsers retain their isolated networks and original profile volumes. The flow is Chromium → per-user egress → Unix socket → host v2rayA HTTP proxy. Both egress stages reject non-public addresses and allow only ports 80/443; the HTTP CONNECT target is the already-validated numeric IP, preserving DNS pinning. HTTP Host and TLS SNI remain intact. A failed upstream never falls back to a direct connection.

The [v2rayA quick-start documentation](https://v2raya.org/en/docs/prologue/quick-start/) describes 20171 as the HTTP proxy and 20172 as the HTTP proxy with routing rules. The default here uses 20171. If you want v2rayA's rule-based routing, set `V2RAYA_HTTP_PROXY=http://127.0.0.1:20172` in the private `.env` before enabling. Rules may intentionally choose direct access for some destinations. Other upstream URL schemes, credentials and paths are rejected. Domain-based routing behavior depends on the existing core's sniffing configuration because validated numeric IPs are tunneled.

On a host where production networking changes require approval, obtain approval for this exact additional host-network service and the brief LibreBrowser restart before running:

```sh
cd /home/thatyt/Projects/VirtualBrowser
sudo ./scripts/enable-v2raya.sh
```

The script builds first, stops only LibreBrowser's app/broker (which stops active browser sessions), verifies ownership and removes only stopped `lb-egress-<user-id>` and `lb-browser-<user-id>` containers so the socket mounts and Chromium proxy address take effect. Recreating the browser is necessary because a replaced egress container may receive a different IP. Accounts and profile volumes are preserved. It records `COMPOSE_FILE=compose.yaml:compose.v2raya.yaml` in `.env` so subsequent ordinary `docker compose` commands and updates keep the integration enabled, then starts the project. Changing a broker environment variable alone would leave old egress containers using their old configuration. No v2rayA, firewall, sysctl, Caddy or FRP configuration is changed. Operator Docker permission is required; no sudo password belongs in chat.

After activation, reconnect in the Mac browser and compare the browsing exit address against the selected v2rayA node. Also test a previously blocked public website and confirm that private/metadata destinations remain inaccessible. The code and real host-loopback/Unix tunnel were tested before activation; full deployed Chromium routing must still be checked after the override is enabled. To roll back, remove `COMPOSE_FILE` from `.env`, stop this project's app/broker, remove only their stopped owned browser/egress containers, remove the dedicated uplink service with the explicit override, and start the base Compose project. Retain account/profile volumes.
