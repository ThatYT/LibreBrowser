# DOM prototype verification — 2026-10-18

The opt-in DOM implementation is ready for private Mac compatibility testing. The public streaming deployment, FRP routing and production accounts/profiles were not switched.

## Results

- Built `librebrowser-dom-control:local` and `librebrowser-dom-engine:local`; engine build passed recorder/replayer version validation, compilation and TypeScript checks.
- Go account, renderer, lifecycle, ownership and egress tests passed with the race detector; `go vet` passed for `internal/libre` and `cmd/librebrowser`.
- Gateway: 160 tests / 35 files passed. Viewer: 129 tests / 25 files passed.
- Production dependency audit: no known vulnerabilities found at verification time.
- Real Chromium integration passed twice after the graceful shutdown correction, including a repeat against the final image. Two disposable users each received isolated engines/profiles; visited JavaScript ran on the server, while the client reconstructed the DOM. Native input and Chinese composition were confirmed in server DOM. Known upload/download bytes passed.
- Stopping the first user preserved the second user's running browser. Removing/recreating the first engine preserved its localStorage marker. Both engine and egress containers were absent after Stop; profile volumes remained. Temporary test resources were cleaned up.
- Google's unauthenticated homepage loaded through the filtered v2rayA egress path. Screenshots were visually inspected. This does not establish Google sign-in, Gmail, Docs or YouTube compatibility.
- Private prototype shell and health endpoint returned 200; renderer without a grant returned 401. Both listeners bind only 127.0.0.1, ports 18090/18091. It uses a private account database copy with login sessions removed, and fresh browser profiles.

The full upstream recursive test command includes agent acceptance scripts that require Chrome in its build-stage image; it stopped at that missing prerequisite. The supported gateway/viewer suites were then run explicitly and passed. Real browser acceptance uses the separate runtime image with sandboxed Chromium. A broad Go `./...` command encounters the existing protected backups directory; explicit application packages passed instead.

## User validation still required

Follow [the Mac SSH-forwarding instructions](DOM_IMPLEMENTATION.md#private-mac-test-instance). Test actual Google sign-in, login persistence after Stop/reopen, Gmail, Docs, YouTube, Mac IME, scrolling, dragging and clipboard. Pixel fallback is explicitly selected and labelled; it does not meet the local DOM goal for a page that requires it. No Mac latency or frame-rate claim is made from the server-side automated tests.

Public rollout remains gated on this compatibility check, a separate renderer DNS hostname and the documented production networking approval. Existing streaming profiles are preserved and are not silently migrated into DOM profiles.
