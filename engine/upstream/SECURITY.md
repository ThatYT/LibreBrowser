# Security policy

## Supported versions

Until the project publishes stable releases, only the current `main` branch receives security
fixes.

## Reporting

Prefer the repository host's private security-advisory feature when available. If no private
channel is published, open a minimal issue asking maintainers for a private contact without
including exploit details.

Include affected commit/version, impact, reproduction conditions, and a minimal non-sensitive
proof. Do not send cookies, access passwords, signing keys, private browsing content, profiles,
downloads, or populated environment files.

Allow maintainers reasonable time to reproduce and prepare a fix before public disclosure. This
policy does not promise a bounty or a particular response time.

## Scope reminders

High-value reports include authentication or authorization bypass, CDP exposure, sandbox
weakening, private-network asset-fetch bypass, script execution in the replay viewer, token
forgery, and cross-viewer media or data leakage.

The documented trusted-viewer model, lack of DRM capture, lack of multi-tenant hardening, and
semantic DOM boundary are known limitations rather than vulnerabilities by themselves.
