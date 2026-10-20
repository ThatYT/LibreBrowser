#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
project_root=$PWD
prototype_dir=${DOM_PROTOTYPE_DIR:-"$project_root/run/dom-prototype"}
export DOM_PROTOTYPE_DIR="$prototype_dir"
export PROTOTYPE_GID="$(id -g)"
umask 077
mkdir -p "$prototype_dir/run"
chmod 700 "$prototype_dir"
compose=(docker compose --project-name librebrowser-dom-prototype -f deploy/compose.dom-prototype.yaml)
if [[ -f "$prototype_dir/broker.env" ]]; then compose+=(--env-file "$prototype_dir/broker.env"); fi
prototype_unit=librebrowser-dom-prototype-app
running=false
if systemctl --user is-active --quiet "$prototype_unit"; then running=true; fi
if [[ -f "$prototype_dir/app.pid" ]]; then
  prototype_pid=$(cat "$prototype_dir/app.pid")
  if [[ "$prototype_pid" =~ ^[0-9]+$ ]] && [[ -r "/proc/$prototype_pid/cmdline" ]] &&
     tr '\0' '\n' < "/proc/$prototype_pid/cmdline" | rg -Fxq "$prototype_dir/librebrowser"; then running=true; fi
fi
case "${1:-status}" in
  export-binary)
    export_id=$(docker create librebrowser-dom-control:local)
    trap 'docker rm "$export_id" >/dev/null' EXIT
    docker cp "$export_id:/usr/local/bin/librebrowser" "$prototype_dir/librebrowser"
    chmod 700 "$prototype_dir/librebrowser"
    ;;
  start)
    if $running; then printf '%s\n' 'DOM prototype is already running.'; exit 0; fi
    if [[ ! -f "$prototype_dir/librebrowser.db" || ! -x "$prototype_dir/librebrowser" ]]; then
      printf '%s\n' 'Export the binary and initialize a private database first; see docs/DOM_IMPLEMENTATION.md.' >&2; exit 1
    fi
    "${compose[@]}" up -d
    systemd-run --user --unit="$prototype_unit" --collect \
      --property="StandardOutput=append:$prototype_dir/app.log" \
      --property="StandardError=append:$prototype_dir/app.log" \
      --property=TimeoutStopSec=120 env LOCAL_DEV=true LISTEN_ADDR=127.0.0.1:18090 PUBLIC_ORIGIN=http://localhost:18090 \
      RENDERER_LISTEN_ADDR=127.0.0.1:18091 RENDERER_ORIGIN=http://localhost:18091 \
      BROWSER_ENGINE=dom DOM_PROTOTYPE=true BROWSER_IDLE_MINUTES="${BROWSER_IDLE_MINUTES:-10}" \
      DATABASE_PATH="$prototype_dir/librebrowser.db" BROKER_SOCKET="$prototype_dir/run/broker.sock" \
      "$prototype_dir/librebrowser" serve
    printf '%s\n' 'DOM prototype: http://localhost:18090 (renderer: localhost:18091).' 'Use SSH forwarding for BOTH ports when testing from your Mac.'
    ;;
  stop)
    if systemctl --user is-active --quiet "$prototype_unit"; then
      systemctl --user stop "$prototype_unit"
    elif $running; then kill -TERM "$prototype_pid"; fi
    "${compose[@]}" down
    rm -f "$prototype_dir/app.pid"
    printf '%s\n' 'Prototype stopped. Accounts and profile volumes are preserved.'
    ;;
  status)
    if $running; then printf '%s\n' 'DOM prototype app is running.'; else printf '%s\n' 'DOM prototype app is stopped.'; fi
    ;;
  *) printf '%s\n' 'Usage: scripts/dom-prototype.sh {export-binary|start|stop|status}' >&2;exit 1;;
esac
