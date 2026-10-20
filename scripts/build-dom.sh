#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Explicit source allowlist avoids private account/profile backups in the build context.
tar -cf - Dockerfile go.mod go.sum cmd internal |
  docker build --network "${BUILD_NETWORK:-default}" -t librebrowser-dom-control:local -
docker build --network "${BUILD_NETWORK:-default}" -f engine/Dockerfile -t librebrowser-dom-engine:local engine
