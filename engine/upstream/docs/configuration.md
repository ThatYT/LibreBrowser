# Configuration

Copy `.env.example` to `.env`. Compose reads that file automatically and `.gitignore` excludes it.
Do not commit a populated `.env`.

## Compose-facing settings

| Variable | Required | Default | Notes |
| --- | :---: | --- | --- |
| `MIRROR_ACCESS_PASSWORD` | yes | none | No built-in fallback; choose a long unique value |
| `REMOTE_BROWSER_BIND` | no | `127.0.0.1` | Keep loopback for a host reverse proxy |
| `REMOTE_BROWSER_PORT` | no | `8080` | Public gateway port on the host |
| `MIRROR_ACCESS_SECRET` | production | random per process | Signs remembered-device cookies |
| `MIRROR_AUTH_SECRET` | production | random per process | Signs driver/viewer session tokens |
| `MIRROR_PUBLIC_ORIGIN` | invite helper | `http://localhost:8080` | Absolute origin printed by `pnpm invite` |
| `TZ` | no | `Etc/UTC` | Browser and gateway timezone |

Empty signing secrets are convenient for disposable localhost evaluation. Every gateway restart
then invalidates remembered devices and invites. Production operators should generate two
independent random values and keep them stable in a secret store or root-readable environment
file.

Compose interpolation passes the password and signing keys as container environment variables.
Anyone who can inspect the container or control the Docker daemon can read them; Docker daemon
access is already host-root-equivalent. Use an external secret injection mechanism if that
boundary is insufficient.

## Gateway runtime settings

These are set by `compose.yml` and usually do not need editing:

| Variable | Compose value | Purpose |
| --- | --- | --- |
| `GATEWAY_HOST` | `0.0.0.0` | Listen inside the gateway container |
| `GATEWAY_PORT` | `3000` | Internal HTTP port |
| `BROWSER_CDP_URL` | `http://browser:9222` | Private Chromium discovery endpoint |
| `BROWSER_CDP_TIMEOUT_MS` | `30000` | Startup discovery timeout |
| `CHROME_USER_DATA_DIR` | `/runtime/gateway` | Shared asset/download/upload workspace |
| `VIEWER_DIST_ROOT` | `/app/viewer` | Compiled viewer files in the gateway image |

`BROWSER_CDP_URL` is HTTP discovery only; Chromium's advertised WebSocket authority is rewritten
to this private host. Do not point it at an endpoint exposed to untrusted networks.

For local development outside Docker, omit `BROWSER_CDP_URL` and set:

| Variable | Meaning |
| --- | --- |
| `CHROME_PATH` | Absolute path to Chromium or Google Chrome |
| `CHROME_HEADFUL=1` | Run the authoritative local browser headfully |
| `VIEWER_PORT` | Vite port, default `5173` |
| `VITE_GATEWAY_URL` | Vite proxy target, default `http://127.0.0.1:3000` |

`MIRROR_E2E=1` enables test-only unauthenticated driver routes. Never use it in a deployment.

## Persistent profile

The default profile path is `/tmp/browser-profile` on a container tmpfs. Enable persistence only
with both Compose files:

```bash
docker compose -f compose.yml -f compose.persistent.yml up -d --build
```

This mounts `browser-profile` at `/profile`. It can contain cookies, browsing history, saved
passwords, tokens, and site storage. Restrict Docker access, decide whether backups are
appropriate, and document retention.

Return to ephemeral mode by bringing the overlay deployment down and starting only `compose.yml`.
The named volume is intentionally retained until explicitly removed.

## Invites

The password login grants the first viewer the driver session. With a stable
`MIRROR_AUTH_SECRET`, generate a narrower invite for the current single session (`dev`):

```bash
set -a
. ./.env
set +a
pnpm invite dev viewer 3600
```

The tool prints a `/join#...` URL. The token stays in the fragment so it is not sent in the HTTP
request line. Send invite URLs only through an appropriate private channel. Use `driver` instead
of `viewer` only when remote control is intended.
