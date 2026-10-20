# FRP transport optimization

Implemented 2026-10-18 with explicit user approval for all homeserver FRP services, temporary guarded UDP tests, and conditional HTTPS rollout after successful repeated benchmarks.

## Active configuration

The original VPS frps still listens on port 7000, retains its original authentication and loopback dashboard, and now has `transport.tcpMux = false`. The setting is also false in both home clients and the VPS visitor. The homeserver clients use authenticated WSS on the existing browser domain's port 443, with system CA verification and three pre-established work connections per proxy. Service domains and proxy ports are unchanged.

Caddy's exact `/~!frp` handler forwards WebSocket transport to `127.0.0.1:7000`; other paths retain the application route. FRP 0.71.1 uses that WebSocket path and supports TLS before the WebSocket handshake for WSS ([implementation](https://github.com/fatedier/frp/blob/v0.71.1/pkg/util/net/websocket.go), [client connector](https://github.com/fatedier/frp/blob/v0.71.1/client/connector.go)). TCP multiplexing and connection pooling follow the [FRP networking documentation](https://gofrp.org/en/docs/features/common/network/network/).

Separate underlying TCP connections prevent a bulk transfer from sharing one FRP TCP queue with unrelated connections. A single long-lived screen WebSocket still carries its own video/input traffic; this change does not eliminate every source of remote-desktop latency.

The root-only client configurations are `/etc/frp/frpc-https.json` and `/etc/frp/librebrowser-home-https.json`. Existing TOML originals remain unchanged for rollback. VPS `/etc/frp/librebrowser-visitor-https.json` retains the STCP secret and loopback listener. The general client, dedicated client and visitor each use a `20-https.conf` systemd drop-in; examples are in `deploy/`.

Home `/usr/local/libexec/frp-https-route` applies only service-cgroup TCP sockets destined for `38.55.193.253:443`. The pre/post helper recreates/removes separate nftables tables and checks v2rayA's bypass-mark semantics. The cgroup is resolved at service startup, so stale cgroup IDs are not reused across restarts. The main dedicated client remains unprivileged. Browser egress remains through v2rayA.

## Measurements

Tests ran from the VPS through the private visitor to the homeserver, using persistent HTTP health requests and a separate controlled 2 MiB payload server. Loaded tests made 25 health requests during three consecutive payload downloads. No private browser content was inspected.

| Transport | Idle median | Loaded median | Loaded p95 | Download Mbps |
| --- | ---: | ---: | ---: | --- |
| Existing live multiplexed TCP | 176–182 ms | — | — | — |
| Fresh multiplexed TCP | 40.9 ms initially; 180.8 ms after bulk | 182.0 ms | 556.6 ms | 16.9–22.4 |
| Multiplexed WebSocket | 34.3 ms initially | 181.1 ms | 550.1 ms | 20.1–23.0 |
| Socket-marked multiplexed TCP | 39.2 ms initially; 178 ms afterward | 189.3 ms | 383.1 ms | 21.4–29.8 |
| Multiplexed HTTPS WebSocket | 39.5 ms initially; 186.4 ms afterward | 187.2 ms | 775.0 ms | 7.3–12.8 |
| HTTPS without TCP multiplexing, run 1 | 36.0 ms | 39.1 ms | 50.4 ms | 17.1–22.9 |
| HTTPS without TCP multiplexing, run 2 | 37.6 ms | 39.8 ms | 43.5 ms | 18.1–21.9 |
| HTTPS without TCP multiplexing, run 3 | 35.9 ms | 42.3 ms | 116.8 ms | 23.9–30.4 |

One later idle no-mux run had a 272 ms p95 spike. These samples show improved request latency and isolation under the tested load, not a guaranteed latency ceiling or broadband speed test. The early fast TCP results alone were not treated as proof of improvement; repeated loaded/post-load checks determined the rollout.

QUIC/KCP on temporary UDP ports 7001/7002 timed out, and a VPS packet-header capture observed no test datagrams arriving. The exact blocking hop remains unconfirmed. Those protocols were not deployed. Native WSS directly to the existing frps port also failed; the tested WSS configuration uses Caddy as its TLS entry point.

Final live steady medians after restoring the original server/dashboard: LibreBrowser health 37.2 ms; v2rayA panel 43.0 ms; desktop root 78.2 ms; Nextcloud status 76.4 ms; OnlyOffice health 41.4 ms. SSH banner arrival was 49.9 ms. All HTTP service probes returned 200. Service processing and local proxy behavior contribute to these endpoint-specific results. Mac input-to-display latency still needs user testing.

## Verification and cleanup

- FRP server/client configs and Caddy candidates passed their native validators; the root helper passed syntax and nft check-mode validation, then actual service startup.
- Both clients restarted with cgroup-scoped routing and verified WSS configuration. The original frps PID owns all five existing raw proxy listeners. Its configuration matches the backup except for `transport.tcpMux = false`.
- The original dashboard/auth and IPv4/IPv6 raw-service firewall guards are retained. No application/account/profile change was needed. The original frps service and all relevant clients remain enabled for startup.
- All temporary benchmark servers, payload/connector services, test credentials, UDP rules and listeners on 7001/7002/60831 are removed. A temporary parallel FRP instance used for the canary/cutover is removed; production again uses the original frps service.
- Temporary Docker socket access is removed after final checks. No global TCP congestion algorithm, forwarding sysctl, v2rayA settings, DNS or unrelated firewall rules were changed.

## Coordinated rollback

Do not independently toggle `tcpMux` on one participant. Carry out rollback with access to both machines; home shell access should be independent of its FRP SSH proxy during the reconnect.

1. On home, stop `frpc` and `librebrowser-frpc`. Their stop hooks remove the HTTPS routing tables. Keep all browser/account/profile volumes.
2. Remove only the new client `20-https.conf` files from their service drop-in directories. Restore the dedicated client's `10-direct-route.conf` from private `backups/frp-https-*`. Original TOML configs and base units were retained. Run `systemctl daemon-reload`.
3. On the VPS, stop `librebrowser-frp-visitor`. Restore `/etc/frp/frps.toml` from `/root/frp-https-deployment/frps.toml`, preserving root ownership/mode. Remove only the visitor's new `20-https.conf` drop-in, then daemon-reload and restart frps. The original visitor unit/config use its legacy TCP settings.
4. Start both original home clients and the original VPS visitor. Verify all proxy ports, SSH and public browser health.
5. Remove the Caddy `/~!frp` handler, or restore `/root/frp-https-deployment/Caddyfile.before` only after confirming it will not overwrite unrelated later edits. Validate before reloading Caddy. All clients must already be back on legacy TCP before removing the HTTPS endpoint.

Protect backups: home `backups/frp-https-*` contains the preceding units and credential-bearing configs; VPS `/root/frp-https-deployment` contains the original server/visitor configs and Caddy backup. Never print or commit their contents.
