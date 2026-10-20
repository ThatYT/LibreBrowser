# Security model

Remote Browser is intended for a small set of trusted viewers. It is not a hardened multi-tenant
RBI service and does not claim that DOM reconstruction provides the same viewer isolation as a
pixel-only stream.

## Trust boundaries

### Visited sites are untrusted

Site JavaScript executes in authoritative Chromium. Chromium's sandbox and the container boundary
reduce risk but do not make renderer compromise impossible. A browser exploit could attempt to
reach host or network resources.

Production deployments should:

- keep Chromium non-root with its sandbox enabled;
- keep CDP private and unexposed;
- block browser egress to private, carrier-NAT, link-local, and cloud metadata destinations;
- isolate the Docker host from unrelated sensitive services;
- patch host, Docker, Chromium base image, and Node dependencies regularly.

The portable Compose file does not make host firewall changes. See
[Deployment](deployment.md#browser-egress).

### Viewers are trusted with page content

Authenticated viewers receive reconstructed markup, CSS, text, proxied assets, presence
information, and media. Drivers can navigate, type, upload, download, and transfer control.
Read-only roles reduce input authority but still expose page contents. Do not invite someone who
must not see the browsing session.

### The reconstructed DOM is inert, not sanitized

The replay iframe omits `allow-scripts`, forms, popups, top navigation, and direct downloads.
Local defaults that would navigate or fetch are cancelled. Visited-site JavaScript is not replayed.

However, markup, SVG, CSS, fonts, and browser parsing behavior still cross into the viewer origin.
They are not passed through a general sanitizer or transcoder. This is a different boundary from
pixel-only RBI, where the viewer receives pixels and input coordinates. A browser vulnerability in
markup/style/font processing, a containment bug, or an application bug could affect the viewer.
Use pixel-only technology when adversarial content-to-viewer isolation is the primary goal.

### Docker control is host control

Anyone who can control the Docker daemon can inspect environment secrets, profile volumes,
downloads, and process state. The gateway does not mount the Docker socket in the supported
Compose deployment.

## Implemented controls

- no built-in access password;
- constant-time password comparison and bounded per-IP backoff;
- signed remembered-device and session cookies;
- short-lived signed driver/viewer invite tokens carried in URL fragments;
- authorization on WebSocket upgrade and asset/upload/download routes;
- one active driver with server-side role enforcement;
- rrweb masking of password values;
- sealed asset tokens and resolution-time private-address rejection;
- one-time download redemption;
- viewer-scoped WebRTC signaling with size/type checks;
- unprivileged Chromium container and private, unpublished CDP;
- Chromium sandbox retained with the Docker capability needed to create nested namespaces;
- scriptless replay iframe and local navigation-default containment;
- browser-facing CSP, anti-framing, MIME-sniffing, referrer, and permissions headers;
- bounded viewer backpressure and snapshot-based resync.

## Important limitations

- The shared password is not individual identity, MFA, SSO, or a durable audit trail.
- The default portable deployment is one browsing session.
- Browser-network egress denial is operator-installed, not automatic.
- Signing secrets supplied as Compose environment variables are visible to Docker administrators.
- The Chromium container receives the broad `SYS_ADMIN` capability for namespace sandboxing.
- Downloads are not malware-scanned.
- Persistent profiles store high-value cookies and credentials.
- There is no claim of resistance to malicious authenticated viewers.
- Availability controls, quotas, and distributed rate limiting are out of scope.

## Deployment checklist

- Use HTTPS and keep the upstream gateway on loopback or a private proxy network.
- Set a unique access password and two independent stable signing secrets.
- Confirm port 9222 has no host mapping.
- Install and test a browser egress policy.
- Keep the profile ephemeral unless persistence is necessary.
- Restrict and encrypt any persistent-profile backups.
- Place the host on a dedicated VM or machine when browsing hostile sites.
- Review logs and resource usage; update dependencies and images.
- Never enable `MIRROR_E2E` outside a test process.

## Reporting vulnerabilities

Follow [SECURITY.md](../SECURITY.md). Do not include cookies, tokens, private URLs, captured page
content, or browser profiles in a report.
