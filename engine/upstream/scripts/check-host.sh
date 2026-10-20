#!/usr/bin/env bash
set -euo pipefail

failures=0

check() {
  local label=$1
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'fail %s\n' "$label"
    failures=$((failures + 1))
  fi
}

check "Docker CLI" docker --version
check "Docker daemon" docker info

if docker compose version >/dev/null 2>&1; then
  printf 'ok   Docker Compose plugin\n'
elif docker-compose version >/dev/null 2>&1; then
  printf 'fail only legacy docker-compose found; Compose v2 is required\n'
  failures=$((failures + 1))
else
  printf 'fail Docker Compose v2\n'
  failures=$((failures + 1))
fi

if [[ $failures -ne 0 ]]; then
  printf '\nHost check failed. See docs/deployment.md for supported prerequisites.\n' >&2
  exit 1
fi
