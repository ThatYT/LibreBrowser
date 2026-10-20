# Troubleshooting

Start with:

```bash
docker compose ps
docker compose logs --tail=200 browser gateway
curl --verbose http://localhost:8080/healthz
```

The healthy response includes `"ok":true`, `"browser":true`, and a non-negative page count.

## Compose rejects the configuration

Use the Docker Compose v2 plugin (`docker compose`), not an obsolete Python `docker-compose`
release. Run `pnpm check:host` for a read-only prerequisite check.

If Compose says `MIRROR_ACCESS_PASSWORD` is missing, copy `.env.example` to `.env` and set a
non-empty password.

## Chromium is unhealthy

Inspect browser logs. Common causes are:

- insufficient memory or `/dev/shm`;
- a host kernel or container runtime that prevents Chromium's sandbox namespaces;
- architecture/distribution repositories without a compatible `chromium` package;
- a persistent profile owned by a different uid.

The image intentionally does not add `--no-sandbox`. Fix the host/runtime or volume ownership
instead of weakening Chromium isolation. The supplied image uses uid/gid `10001` and Compose
grants `SYS_ADMIN` so Chromium can create its sandbox namespaces.

## Gateway is restarting

The gateway exits when it cannot discover CDP or when the browser connection dies. Confirm the
browser is healthy and that no custom Compose override published or moved port 9222. The default
`BROWSER_CDP_URL` is `http://browser:9222`.

If logs show an authentication-password error, ensure the variable is present inside the Compose
configuration:

```bash
docker compose config
```

Do not paste the rendered output into an issue because it contains secrets.

## Login redirects back to the gate

Authentication cookies are `Secure`. Use exactly `http://localhost:8080` for local evaluation, or
use HTTPS. Accessing the service by a LAN IP over plain HTTP will generally cause a login loop.
Production must use HTTPS.

After changing either signing secret, old cookies no longer validate. Clear cookies for the
Remote Browser origin and sign in again.

## Viewer says disconnected

Verify the reverse proxy forwards WebSocket upgrades on `/ws`, preserves the host, and does not
apply a short response timeout. Browser developer tools should show one open WebSocket on the same
origin.

## Page is blank or diverged

Try the viewer's resync action, then pixel mode. Site patterns that commonly stress semantic
replay include closed shadow trees, deeply nested cross-origin frames, canvas/WebGL-only
interfaces, unusual CSS, and rapid document replacement.

Record a minimal public URL or local fixture and the browser/gateway logs when filing a bug. Never
attach a profile, cookies, private page snapshots, downloads, or a populated `.env`.

## Text layout differs

The browser image includes common DejaVu, Liberation, Noto, CJK, and emoji fonts. Remote fonts are
proxied when captured, but font loading failures and platform-specific metrics can still differ.
Check asset requests under `/s/.../a/...` and use pixel mode for a blocking mismatch.

## Uploads or downloads fail

Both containers must mount the same `runtime-data` volume at `/runtime`. Check available disk
space and gateway logs. One-time download URLs require the same authenticated browser session and
cannot be reused after successful redemption.

## Media is unavailable

WebRTC media capture requires a capturable canvas/video surface and network reachability between
the authoritative page peer and viewer peer. No TURN server is bundled. DRM/EME media cannot be
captured. Switch the tab to pixel mode; if that also fails, the site may prohibit or obscure the
content at Chromium's compositor boundary.

## Reset disposable local state

For an ephemeral evaluation where no persistent data matters:

```bash
docker compose down --volumes
docker compose up -d --build
```

Do not run this with the persistent overlay unless deletion of the browser profile is intentional.
