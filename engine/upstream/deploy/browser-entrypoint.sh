#!/bin/sh
set -eu

profile_dir=${BROWSER_PROFILE_DIR:-/tmp/browser-profile}
mkdir -p "$profile_dir"

# Current Chromium releases bind the DevTools listener to loopback even when given
# --remote-debugging-address. Forward a separate container-only port for the gateway; Compose
# still publishes no CDP port on the host.
/usr/bin/socat TCP-LISTEN:9222,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9223 &

exec /usr/bin/xvfb-run \
  --auto-servernum \
  --server-args="-screen 0 1920x1080x24 -nolisten tcp" \
  /usr/bin/chromium \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
  --user-data-dir="$profile_dir" \
  --no-first-run \
  --password-store=basic \
  --disable-features=BackForwardCache \
  --disable-blink-features=AutomationControlled \
  --enable-unsafe-swiftshader \
  "$@"
