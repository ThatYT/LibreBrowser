#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Explicit invocation stops only this project's services. SQLite backup is consistent while stopped.
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups
chmod 700 backups
# Build first so a failed build does not interrupt sessions.
docker compose build app
docker compose stop app broker
# The stopped database is copied with its WAL; keep both together during restore.
docker compose run --rm --no-deps --entrypoint tar app -C /data -czf - . > "backups/accounts-$stamp.tar.gz"
chmod 600 "backups/accounts-$stamp.tar.gz"
docker compose up -d --force-recreate broker app
printf '%s\n' "Backup: backups/accounts-$stamp.tar.gz" 'Browser profiles are retained in lb-profile-* volumes. Back them up separately while stopped.'
