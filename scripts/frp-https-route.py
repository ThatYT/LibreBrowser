#!/usr/bin/env python3
"""Root-only v2rayA bypass for the two FRP clients' HTTPS transport sockets.

Resolve the service cgroup at every start: its kernel ID changes on restart.
Only that cgroup's TCP traffic to the fixed VPS on 443 is marked. Browser web
traffic, SSH sessions and other host connections retain their existing route.
"""
import json
import os
import subprocess
import sys

SERVICES = {
    'frpc': 'frp_home_https',
    'librebrowser-frpc': 'librebrowser_frp_direct',
}


def run(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, **kwargs)


def verify_proxy_mark():
    result = run(['nft', '-j', 'list', 'table', 'inet', 'v2raya'])
    if result.returncode:
        return
    for entry in json.loads(result.stdout).get('nftables', []):
        rule = entry.get('rule', {})
        if rule.get('chain') != 'tp_out':
            continue
        expressions = rule.get('expr', [])
        expected = {'&': [{'meta': {'key': 'mark'}}, 128]}
        if any(expr.get('match', {}).get('left') == expected
               and expr['match'].get('right') == 128
               and expr['match'].get('op') == '==' for expr in expressions
               ) and any('return' in expr for expr in expressions):
            return
    raise RuntimeError('v2rayA bypass-mark semantics differ; refusing routing change')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Root is required')
    if len(sys.argv) != 3 or sys.argv[1] not in ('apply', 'check', 'remove', 'status') or sys.argv[2] not in SERVICES:
        raise RuntimeError('Usage: frp-https-route.py apply|check|remove|status frpc|librebrowser-frpc')
    action, service = sys.argv[1:]
    table = SERVICES[service]
    exists = run(['nft', 'list', 'table', 'inet', table]).returncode == 0
    if action == 'status':
        print('installed' if exists else 'absent')
        return
    if action == 'remove':
        if exists:
            result = run(['nft', 'delete', 'table', 'inet', table])
            if result.returncode:
                raise RuntimeError('Could not remove the service routing table')
        return
    verify_proxy_mark()
    previous = f'delete table inet {table}\n' if exists else ''
    rules = previous + f'''table inet {table} {{
 chain output {{
  type route hook output priority -160; policy accept;
  socket cgroupv2 level 2 "system.slice/{service}.service" ip daddr 38.55.193.253 tcp dport 443 meta mark set meta mark | 128 counter comment "{service} HTTPS transport only"
 }}
}}
'''
    result = run(['nft'] + (['--check'] if action == 'check' else []) + ['--file', '-'], input=rules)
    if result.returncode:
        raise RuntimeError('FRP HTTPS routing validation/application failed: ' + result.stderr.strip())
    print('FRP HTTPS routing ' + ('validated' if action == 'check' else 'installed') + ': ' + service)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
