#!/usr/bin/env bash
set -euo pipefail

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif docker-compose version >/dev/null 2>&1; then
  compose=(docker-compose)
else
  echo "Docker Compose is required" >&2
  exit 1
fi
compose+=(--file compose.yml)

project=${REMOTE_BROWSER_SMOKE_PROJECT:-remote-browser-smoke-$$}
smoke_port=${REMOTE_BROWSER_SMOKE_PORT:-}
if [[ -z $smoke_port ]]; then
  smoke_port=$(
    node -e "const n=require('node:net').createServer();n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()})"
  )
fi

export REMOTE_BROWSER_BIND=127.0.0.1
export REMOTE_BROWSER_PORT=$smoke_port
export MIRROR_ACCESS_PASSWORD=compose-smoke-password
export MIRROR_ACCESS_SECRET=compose-smoke-access-key
export MIRROR_AUTH_SECRET=compose-smoke-auth-key

cleanup() {
  "${compose[@]}" --project-name "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

diagnose() {
  local status=$?
  set +e
  "${compose[@]}" --project-name "$project" ps >&2
  "${compose[@]}" --project-name "$project" logs --no-color --tail=100 >&2
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap diagnose ERR

"${compose[@]}" --project-name "$project" up --detach --build

deadline=$((SECONDS + 180))
health=
while ((SECONDS < deadline)); do
  health=$(curl --fail --silent "http://127.0.0.1:${smoke_port}/healthz" 2>/dev/null || true)
  if [[ -n $health ]] && HEALTH_JSON=$health node -e "
    const value = JSON.parse(process.env.HEALTH_JSON);
    process.exit(value.ok === true && value.browser === true ? 0 : 1);
  "; then
    break
  fi
  sleep 2
done

if [[ -z $health ]] || ! HEALTH_JSON=$health node -e "
  const value = JSON.parse(process.env.HEALTH_JSON);
  process.exit(value.ok === true && value.browser === true ? 0 : 1);
"; then
  "${compose[@]}" --project-name "$project" ps >&2
  "${compose[@]}" --project-name "$project" logs --no-color --tail=100 >&2
  echo "Compose smoke timed out" >&2
  exit 1
fi

curl --fail --silent "http://127.0.0.1:${smoke_port}/gate" |
  grep --quiet '<form method="post" action="/gate">'
"${compose[@]}" --project-name "$project" exec -T gateway \
  test -s /app/viewer/index.html

browser_id=$("${compose[@]}" --project-name "$project" ps -q browser)
gateway_id=$("${compose[@]}" --project-name "$project" ps -q gateway)
[[ -n $browser_id && -n $gateway_id ]]

deadline=$((SECONDS + 60))
while ((SECONDS < deadline)); do
  browser_health=$(docker inspect --format '{{.State.Health.Status}}' "$browser_id")
  gateway_health=$(docker inspect --format '{{.State.Health.Status}}' "$gateway_id")
  if [[ $browser_health == healthy && $gateway_health == healthy ]]; then
    break
  fi
  sleep 2
done
[[ ${browser_health:-} == healthy ]]
[[ ${gateway_health:-} == healthy ]]

printf 'Compose smoke passed on loopback port %s (project %s).\n' "$smoke_port" "$project"
