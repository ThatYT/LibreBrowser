#!/bin/sh
set -eu

: "${P2_DIFF_CHROME_REAL:?P2_DIFF_CHROME_REAL must name the real Chromium executable}"
: "${P2_DIFF_CDP_PORT:?P2_DIFF_CDP_PORT must name the loopback diagnostic CDP port}"

# Keep this list in lockstep with scripts/probe-oopif.ts. The loopback CDP endpoint is test-only:
# the OOPIF lane uses it to prove that Chromium attached an iframe target instead of silently
# degrading the fixture to an in-process frame.
exec "$P2_DIFF_CHROME_REAL" \
  --site-per-process \
  --no-proxy-server \
  "--host-resolver-rules=MAP a.test 127.0.0.1, MAP b.test 127.0.0.1, MAP c.test 127.0.0.1" \
  "--remote-debugging-address=127.0.0.1" \
  "--remote-debugging-port=$P2_DIFF_CDP_PORT" \
  "$@"
