#!/usr/bin/env bash
set -euo pipefail

if ! docker compose version >/dev/null 2>&1; then
  printf 'Docker Compose v2 is required. See docs/deployment.md.\n' >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  printf 'OpenSSL is required to generate the local credentials.\n' >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required for the startup health check.\n' >&2
  exit 1
fi

created_env=0
if [[ ! -e .env ]]; then
  umask 077
  password=${MIRROR_ACCESS_PASSWORD:-$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')}
  access_secret=${MIRROR_ACCESS_SECRET:-$(openssl rand -hex 32)}
  auth_secret=${MIRROR_AUTH_SECRET:-$(openssl rand -hex 32)}
  bind=${REMOTE_BROWSER_BIND:-127.0.0.1}
  port=${REMOTE_BROWSER_PORT:-8080}
  public_origin=${MIRROR_PUBLIC_ORIGIN:-http://localhost:${port}}
  temp_env=".env.tmp.$$"
  trap 'rm -f "$temp_env"' EXIT
  {
    printf 'MIRROR_ACCESS_PASSWORD=%s\n' "$password"
    printf 'MIRROR_ACCESS_SECRET=%s\n' "$access_secret"
    printf 'MIRROR_AUTH_SECRET=%s\n' "$auth_secret"
    printf 'REMOTE_BROWSER_BIND=%s\n' "$bind"
    printf 'REMOTE_BROWSER_PORT=%s\n' "$port"
    printf 'MIRROR_PUBLIC_ORIGIN=%s\n' "$public_origin"
  } >"$temp_env"
  mv "$temp_env" .env
  trap - EXIT
  created_env=1
fi

docker compose up --detach --build

published=$(docker compose port gateway 3000 | tail -n 1)
published_port=${published##*:}
local_origin="http://127.0.0.1:${published_port}"
deadline=$((SECONDS + 180))
until health=$(curl --fail --silent "${local_origin}/healthz" 2>/dev/null) &&
  [[ $health == *'"ok":true'* && $health == *'"browser":true'* ]]; do
  if ((SECONDS >= deadline)); then
    printf 'Remote Browser did not become healthy in time.\n' >&2
    docker compose ps >&2
    exit 1
  fi
  sleep 2
done

printf '\nRemote Browser is ready at %s\n' "$local_origin"
if [[ $created_env -eq 1 ]]; then
  printf 'Password: %s\n' "$password"
  printf 'Credentials were saved to .env with owner-only permissions.\n'
else
  printf 'Using the existing .env file (left unchanged).\n'
fi
printf 'Health: %s\n' "$health"
