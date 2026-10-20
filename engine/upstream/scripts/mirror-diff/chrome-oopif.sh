#!/bin/sh
set -eu

: "${P2_DIFF_CHROME_PATH:?P2_DIFF_CHROME_PATH must name the real Chromium executable}"
: "${P2_DIFF_CDP_PORT:?P2_DIFF_CDP_PORT must name the test-only DevTools port}"

exec "$P2_DIFF_CHROME_PATH" \
  --site-per-process \
  --no-proxy-server \
  "--host-resolver-rules=MAP a.test 127.0.0.1, MAP b.test 127.0.0.1, MAP c.test 127.0.0.1" \
  --remote-debugging-address=127.0.0.1 \
  "--remote-debugging-port=$P2_DIFF_CDP_PORT" \
  "$@"
