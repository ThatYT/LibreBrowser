#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null
docker info >/dev/null
docker compose version >/dev/null
if [[ ! -f .env ]]; then (umask 077; cp .env.example .env); fi
# Build and pull only. No service startup, firewall changes or production proxy edits.
docker compose build app
docker compose --env-file .env config --format json | python3 -c 'import json,sys,subprocess; c=json.load(sys.stdin); subprocess.run(["docker","pull",c["services"]["broker"]["environment"]["CHROMIUM_IMAGE"]],check=True)'
printf '%s\n' 'Built. Initialize with: docker compose run --rm --no-deps app admin init --username thatyt' 'Then: docker compose up -d' 'Review docs/DEPLOYMENT.md for local TLS and trusted proxy setup.'
