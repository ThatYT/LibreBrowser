# Administrative and account APIs

Administrators can use the browser bar’s **Users** link or `/admin/users` to add users, reset other users’ passwords and remove accounts. The bilingual UI calls the authenticated APIs below; it adds no public registration. Your own password change remains under `/account` and requires the current password. Removing an account requires confirmation and retains its profile volume.

All endpoints use the same configured origin and HttpOnly session cookie. HTTPS uses a host-only `__Host-librebrowser_session` cookie; loopback development uses `librebrowser_session`. No API bypasses the user/role checks. There is no public registration. Use your terminal or an API client that keeps its cookie jar private; passwords must not be committed to scripts or shell history.

1. `POST /api/login` with `Origin: <PUBLIC_ORIGIN>`, `Content-Type: application/json`, body `{"username":"thatyt","password":"..."}`. Store the returned cookie privately; save the returned `csrf` value. The browser UI immediately calls the start endpoint after this response.
2. Every subsequent modifying API request requires the cookie, identical `Origin`, and `X-CSRF-Token: <csrf>` header. Send JSON bodies as files or stdin, not passwords in command arguments. GET requests never mutate containers.
3. `GET /api/me` returns the current user, CSRF token, selected engine and prototype marker. `POST /api/logout` with `{}` revokes this login.

| Method | Path | JSON body / response |
| --- | --- | --- |
| POST | `/api/browser/start` | `{}`; starts or reuses your own browser; 204 on success |
| POST | `/api/browser/stop` | `{}`; stops your browser and preserves the profile |
| POST | `/api/browser/viewer` | DOM mode only: `{}`; returns a single-use renderer join URL when ready |
| GET | `/browser/…` | Streaming mode only: authenticated Selkies proxy; WebSocket upgrades require matching Origin |
| POST | `/api/account/password` | `{"current_password":"…","password":"…"}`; revokes all your logins |
| GET | `/api/admin/users` | ADMIN only; returns user IDs, usernames, roles and disabled state |
| POST | `/api/admin/users` | ADMIN only; `{"username":"alice","password":"…","role":"USER"}` |
| POST | `/api/admin/users/{id}/disabled` | ADMIN only; `{"value":"true"}` or `{"value":"false"}` |
| POST | `/api/admin/users/{id}/role` | ADMIN only; `{"value":"ADMIN"}` or `{"value":"USER"}` |
| POST | `/api/admin/users/{id}/password` | ADMIN only; `{"value":"new password…"}`; revokes all target logins |
| POST | `/api/admin/users/{id}/delete` | ADMIN only; `{}`; stops browser, deletes account and sessions; retains profile |
| POST | `/api/admin/users/{id}/stop` | ADMIN only; `{}`; gracefully stops target containers |
| GET | `/api/admin/status` | ADMIN only; Docker running state, tracked connection counts and idle times |

Usernames: lowercase ASCII letter, then lowercase letters, digits, `_` or `-`, maximum 32 characters. Passwords: 12–1024 bytes. Roles are exactly `USER` or `ADMIN`. The current API returns English errors; the login UI presents localized messages.

Role and disabled-state changes also revoke affected sessions. Admin status reads Docker running state through the broker; `available: false` means the query failed. Connection counts and idle times describe application tracking. Administrators have no API for selecting another user's browser. `/browser/<guessed-id>/…` remains a path inside the requesting user's own container.

Streams are checked at entry and rechecked every second until their fixed 24-hour login expiry. Upstream cookies cannot overwrite the LibreBrowser authentication cookie. Browser proxy methods are limited to GET/HEAD and WebSocket GET; disabled upload/command features are not exposed as alternate authenticated APIs.

CSRF-protected modifying calls require exact Origin even for non-browser clients. Proxy headers never select a user or bypass role checks. The direct peer, not `X-Forwarded-For`, controls the login rate limit.

In DOM mode, the separate renderer origin exposes only ticket exchange, the scoped viewer and its socket/assets/transfers. Upload POSTs require the renderer cookie and exact renderer Origin; all paths must belong to that grant's user. The trusted account origin does not serve reconstructed website content. See [DOM implementation](DOM_IMPLEMENTATION.md).
