#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Explicit operator invocation authorizes this project's host-loopback uplink
# and a brief browser interruption. Existing v2rayA/Caddy/FRP are not edited.
test -f .env
docker info >/dev/null
# Build before interrupting sessions. Explicit files avoid ambiguous overrides.
docker compose -f compose.yaml -f compose.v2raya.yaml config --quiet
docker compose -f compose.yaml -f compose.v2raya.yaml build app
python3 - <<'PY'
import os
from pathlib import Path
import re
import subprocess

compose = ['docker', 'compose', '-f', 'compose.yaml', '-f', 'compose.v2raya.yaml']
# Stop this project's app and broker. Broker flushes/stops owned browsers.
subprocess.run(compose + ['stop', 'app', 'broker'], check=True)
ids = subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'label=io.librebrowser.owner'], text=True).split()
if ids:
    import json
    containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], text=True))
    for c in containers:
        owner = c['Config']['Labels'].get('io.librebrowser.owner', '')
        if not re.fullmatch(r'[a-f0-9]{32}', owner):
            continue
        if c['Name'] not in ('/lb-egress-' + owner, '/lb-browser-' + owner):
            continue
        if c['State']['Running']:
            raise SystemExit('Owned browser/egress still running; refusing replacement. Retry after broker shutdown.')
        # Recreate both: the browser proxy IP may change when egress is replaced.
        # Persistent profile volumes and the account database are never removed.
        subprocess.run(['docker', 'rm', c['Id']], check=True)
path = Path('.env')
if not path.exists():
    raise SystemExit('Expected project .env; configure it before enabling v2rayA.')
info = path.stat()
text = path.read_text()
lines = [line for line in text.splitlines() if not re.match(r'^\s*(?:export\s+)?COMPOSE_FILE\s*=', line)]
lines.append('COMPOSE_FILE=compose.yaml:compose.v2raya.yaml')
temporary = path.with_name('.env.v2raya-tmp')
try:
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write('\n'.join(lines) + '\n')
        if os.geteuid() == 0:
            os.fchown(stream.fileno(), info.st_uid, info.st_gid)
    os.replace(temporary, path)
finally:
    temporary.unlink(missing_ok=True)
subprocess.run(compose + ['up', '-d'], check=True)
print('v2rayA uplink enabled. Reconnect your browser; its profile is retained.')
PY
