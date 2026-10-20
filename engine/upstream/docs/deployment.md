# Deployment

## Supported path

The primary path is Docker Engine plus Docker Compose v2 on a modern Linux distribution. The host
needs enough memory for headful Chromium; 2 GiB free memory is a practical minimum for one light
session, and complex sites may require substantially more.

Install Docker from your distribution or Docker's official packages, add the intended operator to
the Docker group only if host-root-equivalent access is acceptable, then run:

```bash
./scripts/bootstrap.sh
```

The bootstrap requires OpenSSL and curl, creates `.env` only when it is absent, generates three
independent credentials, starts the stack, and waits for browser-aware health. For a manual start,
copy `.env.example`, set the password and signing secrets, then run
`docker compose up --detach --build`.

Node and pnpm are needed for development helpers, not for either normal Compose path.

## What Compose creates

- `browser`: non-root Chromium under Xvfb, CDP exposed only to the project network;
- `gateway`: Node gateway plus the production viewer build;
- one project bridge network;
- `runtime-data`: shared asset cache and transient upload/download workspace;
- browser `/tmp`: tmpfs, including the default ephemeral profile.

The gateway waits for Chromium's CDP health check. Its own health check verifies both HTTP and the
live browser connection. Both services use an init process, bounded shutdown grace, and
`restart: unless-stopped`. The gateway filesystem is read-only, `/tmp` and `/runtime` are the only
writable locations, all Linux capabilities are dropped, and privilege escalation is disabled.

The browser service drops the default capability set, then adds `SYS_ADMIN` and `SYS_CHROOT`
because standard Docker seccomp otherwise blocks Chromium from creating and entering the nested
namespaces used by its sandbox. Chromium remains non-root and the browser sandbox stays enabled.
`SYS_ADMIN` is a broad capability, so use a dedicated host/VM for hostile browsing and consider a
reviewed custom seccomp profile as a future hardening step. Do not trade it for Chromium's
`--no-sandbox` flag.

## Local evaluation

The default gateway mapping is `127.0.0.1:8080`. Modern browsers treat localhost as a potentially
trustworthy origin and accept the Secure authentication cookies used by the application. If a
browser loops back to the login page, use local HTTPS or test through the production proxy.

Do not change `REMOTE_BROWSER_BIND` to `0.0.0.0` merely for convenience. Plain HTTP on a network
interface exposes page content, credentials, and input.

## Production TLS

Keep `REMOTE_BROWSER_BIND=127.0.0.1`, set `MIRROR_PUBLIC_ORIGIN` to the public HTTPS origin, and
terminate TLS on the same host.

Minimal Caddy example:

```caddyfile
browser.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Minimal Nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Use a real certificate, restrict the upstream port with the host firewall, and verify `/ws`,
uploads, and larger downloads through the proxy. If the reverse proxy runs in another container,
attach it to a narrowly scoped network instead of publishing CDP.

## Stable secrets

Set independent stable values for `MIRROR_ACCESS_SECRET` and `MIRROR_AUTH_SECRET`. Rotation logs
out remembered devices and invalidates outstanding invites. Keep `.env` out of backups unless the
backup is encrypted and access-controlled.

The access password is a shared front door, not a full identity provider. Use a private network,
VPN, or upstream access proxy when the service is exposed to more than a small trusted group.

## Browser egress

Compose does not silently modify the host firewall. Without an operator-installed policy,
authoritative Chromium can reach addresses routable from the Docker host. This matters because
visited sites execute untrusted JavaScript.

For a production Linux/iptables host, inspect `deploy/egress-policy.sh`, identify the Compose
network, validate, then install:

```bash
browser_container=$(docker compose ps -q browser)
browser_network=$(
  docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' \
    "$browser_container"
)
sudo BROWSER_NETWORK="$browser_network" deploy/egress-policy.sh --check
sudo BROWSER_NETWORK="$browser_network" deploy/egress-policy.sh
```

The script installs an idempotent jump in `DOCKER-USER`. It is optional and host-mutating, so the
project never runs it automatically. Arrange persistence using the host firewall manager and
re-test after Docker upgrades. Environments using nftables, firewalld, cloud firewalls, or an
egress proxy should implement equivalent denial of private, carrier-NAT, link-local, and metadata
ranges while preserving gateway-to-browser CDP.

## Persistence and backups

Enable a persistent Chromium profile only when needed:

```bash
docker compose -f compose.yml -f compose.persistent.yml up -d --build
```

The profile is credential material. A normal `docker compose down` keeps named volumes. The
following removes volumes and is irreversible:

```bash
docker compose -f compose.yml -f compose.persistent.yml down --volumes
```

Do not back up an ephemeral deployment by accident just because `runtime-data` exists. That
volume contains cache and transfer state, not the default browser profile.

## Updates and rollback

Before an update, note the current commit and back up only explicitly persistent data. Then:

```bash
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail https://browser.example.com/healthz
```

Compose retains the previous local images until pruned, which permits an operator-directed image
tag rollback. Database migration is not part of this MVP.

## Isolated smoke test

Contributors can build and exercise both services without colliding with an existing project:

```bash
pnpm smoke:compose
```

The script chooses a unique Compose project and loopback port, verifies Chromium health, gateway
health, and the built viewer, then removes only its own containers, network, and volumes.
