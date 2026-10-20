#!/bin/sh
# Optional Linux host policy for production. It blocks browser-network traffic to private,
# carrier-NAT, link-local, and metadata destinations while retaining same-network CDP traffic.
#
# This changes the host firewall. Review it, test with --check, and arrange persistence using
# the host's firewall manager. BROWSER_NETWORK is required; no bridge or subnet is hardcoded.
set -eu

: "${BROWSER_NETWORK:?Set BROWSER_NETWORK to the Compose browser network name}"

chain=${EGRESS_CHAIN:-REMOTE-BROWSER-EGRESS}
iptables_bin=${IPTABLES:-/usr/sbin/iptables}
restore_bin=${IPTABLES_RESTORE:-/usr/sbin/iptables-restore}
docker_bin=${DOCKER:-/usr/bin/docker}
dns_resolvers=${BROWSER_DNS_RESOLVERS:-127.0.0.11/32}
check_only=false

case ${1:-} in
  "") ;;
  --check) check_only=true ;;
  *)
    echo "usage: BROWSER_NETWORK=<name> $0 [--check]" >&2
    exit 2
    ;;
esac

[ -x "$iptables_bin" ] || {
  echo "iptables is not executable at $iptables_bin" >&2
  exit 1
}
[ -x "$restore_bin" ] || {
  echo "iptables-restore is not executable at $restore_bin" >&2
  exit 1
}
[ -x "$docker_bin" ] || {
  echo "docker is not executable at $docker_bin" >&2
  exit 1
}

network_driver=$("$docker_bin" network inspect --format '{{.Driver}}' "$BROWSER_NETWORK")
[ "$network_driver" = bridge ] || {
  echo "$BROWSER_NETWORK is not a bridge network" >&2
  exit 1
}

browser_subnet=$(
  "$docker_bin" network inspect \
    --format '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' "$BROWSER_NETWORK" |
    awk '!/:/ { if (found) exit 2; found=$0 } END { if (!found) exit 1; print found }'
) || {
  echo "$BROWSER_NETWORK must have exactly one IPv4 subnet" >&2
  exit 1
}

browser_bridge=$(
  "$docker_bin" network inspect \
    --format '{{with index .Options "com.docker.network.bridge.name"}}{{.}}{{end}}' \
    "$BROWSER_NETWORK"
)
if [ -z "$browser_bridge" ]; then
  network_id=$("$docker_bin" network inspect --format '{{.Id}}' "$BROWSER_NETWORK")
  browser_bridge=br-$(printf '%.12s' "$network_id")
fi

render_rules() {
  echo '*filter'
  printf ':%s - [0:0]\n' "$chain"
  printf -- '-F %s\n' "$chain"
  printf -- '-A %s -s %s -o %s -j RETURN\n' "$chain" "$browser_subnet" "$browser_bridge"
  printf -- '-A %s -s %s -d %s -j RETURN\n' "$chain" "$browser_subnet" "$browser_subnet"

  for resolver in $dns_resolvers; do
    printf -- '-A %s -s %s -d %s -p udp --dport 53 -j RETURN\n' \
      "$chain" "$browser_subnet" "$resolver"
    printf -- '-A %s -s %s -d %s -p tcp --dport 53 -j RETURN\n' \
      "$chain" "$browser_subnet" "$resolver"
  done

  for destination in \
    10.0.0.0/8 \
    172.16.0.0/12 \
    192.168.0.0/16 \
    100.64.0.0/10 \
    169.254.0.0/16
  do
    printf -- '-A %s -s %s -d %s -j DROP\n' "$chain" "$browser_subnet" "$destination"
  done
  echo 'COMMIT'
}

if [ "$check_only" = true ]; then
  render_rules | "$restore_bin" --test --noflush --wait 5
  exit 0
fi

render_rules | "$restore_bin" --noflush --wait 5
while "$iptables_bin" --wait 5 --check DOCKER-USER --jump "$chain" 2>/dev/null; do
  "$iptables_bin" --wait 5 --delete DOCKER-USER --jump "$chain"
done
"$iptables_bin" --wait 5 --insert DOCKER-USER 1 --jump "$chain"
