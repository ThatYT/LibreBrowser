# Active public route

URL: **https://browser.home.libremedicine.org**. DNS points to VPS `38.55.193.253`. LibreBrowser, Chromium, profiles and browser egress run on the **homeserver**.

```text
Mac → HTTPS :443 on VPS Caddy → VPS loopback STCP visitor :60830
    → existing VPS frps :7000
    → homeserver frpc over WSS through VPS Caddy :443 /~!frp
    → homeserver loopback :8090 (LibreBrowser)
```

The HTTPS transport also carries the existing homeserver SSH, desktop, v2rayA panel, Nextcloud and OnlyOffice proxies. Their public domains, local ports, remote ports and authentication are preserved. The Mac needs neither an SSH tunnel nor a local frpc client.

## Installed services

| Machine | Component | Active configuration |
| --- | --- | --- |
| Home | Existing `frpc.service` | Original unit + `frpc.service.d/20-https.conf`; `/etc/frp/frpc-https.json` |
| Home | `librebrowser-frpc.service` | Original unit + `20-https.conf`; `/etc/frp/librebrowser-home-https.json` |
| Home | LibreBrowser app/broker/uplink | `compose.yaml` + `compose.v2raya.yaml` |
| VPS | Existing `frps.service` | `/etc/frp/frps.toml`; `transport.tcpMux = false` added |
| VPS | `librebrowser-frp-visitor.service` | Original unit + `20-https.conf`; `/etc/frp/librebrowser-visitor-https.json` |
| VPS | Existing Caddy | `/etc/caddy/Caddyfile`; exact `/~!frp` transport handler added to the browser domain |

All FRP binaries remain version 0.71.1. The original server, dashboard, token and service remain in use. No additional FRP server or UDP listener remains. The visitor still binds only to `127.0.0.1:60830`; application port 8090 remains home-loopback-only. Existing IPv4/IPv6 raw-service firewall guards remain in place.

Both homeserver clients use `serverAddr = 38.55.193.253`, port 443, protocol `wss`, `tcpMux = false` and a connection pool of three. TLS verifies the browser hostname against the host's system CA bundle. Caddy routes only `/~!frp` to loopback frps port 7000; FRP authentication still applies. The local visitor and frps also disable TCP multiplexing. This must match across participants. Original TOML client files remain protected for rollback; active JSON configs contain the same protected authentication material and proxy definitions.

The dedicated client and visitor retain DynamicUser and their original sandboxing. The original general-purpose homeserver frpc retains its existing service identity. Only root-owned pre/post routing helpers need network administration privileges; the dedicated main frpc process has no capabilities. See `FRP_PERFORMANCE.md` for measurements, startup behavior and coordinated rollback.

## Host routing exceptions

The user explicitly approved the transport tests and conditional rollout to all homeserver FRP services after repeated idle and loaded tests showed improvement. `/usr/local/libexec/frp-https-route` is a root-owned copy of `scripts/frp-https-route.py`. Each home client drop-in applies/removes its own table at service start/stop:

- `frp_home_https` matches `system.slice/frpc.service`.
- `librebrowser_frp_direct` matches `system.slice/librebrowser-frpc.service`.

Both rules match only the service socket cgroup, destination `38.55.193.253`, TCP port 443, and set the existing v2rayA bypass bit `0x80`. The helper checks that mark's observed meaning. It refreshes the cgroup ID on each start because the kernel ID changes when a service is recreated. The former DynamicUser/port-7000 drop-in was backed up and replaced.

No global destination whitelist, forwarding sysctl, v2rayA setting or unrelated host route was changed. A v2rayA reload of its own tables leaves these tables intact; after a full firewall flush, restart both FRP clients to restore them.

## App origin, streaming and browser egress

The private `.env` retains:

```dotenv
PUBLIC_ORIGIN=https://browser.home.libremedicine.org
TRUSTED_PROXY_CIDRS=172.18.0.1/32
COMPOSE_FILE=compose.yaml:compose.v2raya.yaml
```

The Docker gateway is the app's immediate trusted peer after home frpc connects to loopback port 8090. Reconfirm this gateway if the Compose network is recreated. Use the public hostname even from home; the former localhost origin does not pass the Host/Origin check.

Chromium web traffic remains separate: Chromium → per-user Go egress sidecar → private Unix-socket uplink → v2rayA HTTP proxy `127.0.0.1:20171`. The FRP bypass does not match those sockets. Keep the VPS public IP in the browser egress deny list. Google worked through the active browser's proxy after the transport change.

Streaming remains fixed at **1920×1080 / 30 FPS**, with server-enforced manual resolution and dynamic resizing disabled. H.264 CBR remains up to 6 Mbps. No browser containers, profiles, application image or account data were replaced during the FRP optimization.

## Verification and backups

The final VPS-to-home LibreBrowser health median was approximately **37 ms**, versus **182 ms** before this change. The isolated no-mux HTTPS benchmark held approximately **36–42 ms median during concurrent bulk transfers** across three runs, with observed download throughput of 17–30 Mbps. Live SSH, desktop, v2rayA, Nextcloud and OnlyOffice probes passed. These are tunnel/application request measurements, not Mac input-to-display latency; occasional spikes remain possible.

CA-verified public HTTPS health returns 200 and unauthenticated streaming returns 401. The original dashboard remains protected on VPS loopback port 7500. Temporary benchmark services, listeners, credentials and firewall tables were removed, and temporary Docker access is revoked after verification.

Transport rollback material is in private home `backups/frp-https-*` and VPS `/root/frp-https-deployment`. Earlier account/profile deployment archives under `backups/public-*` and the prior app image remain available. They contain private browsing/account data; retain their permissions. No private key or live FRP credential is committed.

**Before reverting the public Caddy site or stopping its HTTPS endpoint, first perform the coordinated transport rollback in `FRP_PERFORMANCE.md`.** Both home FRP clients now depend on that endpoint; removing it first would disconnect all homeserver proxies.
