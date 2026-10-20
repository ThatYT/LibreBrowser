#!/usr/bin/env python3
"""Root-only routing helper for the dedicated LibreBrowser FRP systemd unit.

The table belongs to this helper. Only that DynamicUser's TCP connections to
one FRP server/port receive v2rayA's observed bypass mark. No browser traffic,
other FRP clients, proxy settings or existing firewall tables are changed.
"""
import json
import os
import pwd
import subprocess
import sys

TABLE = 'librebrowser_frp_direct'
FRP_ADDRESS = '38.55.193.253'
FRP_PORT = 7000
BYPASS_MARK = 0x80


def run(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, **kwargs)


def table_exists():
    return run(['nft', 'list', 'table', 'inet', TABLE]).returncode == 0


def verify_proxy_mark():
    result = run(['nft', '-j', 'list', 'table', 'inet', 'v2raya'])
    if result.returncode:
        # No transparent proxy yet: the mark has no effect. Its own table
        # survives a later v2rayA table creation/reload.
        return
    rules = json.loads(result.stdout).get('nftables', [])
    for item in rules:
        rule = item.get('rule', {})
        if rule.get('chain') != 'tp_out':
            continue
        expressions = rule.get('expr', [])
        matches = [expr.get('match', {}) for expr in expressions]
        expected = {'&': [{'meta': {'key': 'mark'}}, BYPASS_MARK]}
        if any(match.get('left') == expected and match.get('right') == BYPASS_MARK and match.get('op') == '==' for match in matches) and any('return' in expr for expr in expressions):
            return
    raise RuntimeError('v2rayA bypass-mark semantics differ; refusing to install the rule')


def rules(uid):
    if not 61184 <= uid <= 65519:
        raise RuntimeError('Expected the dedicated systemd DynamicUser UID')
    previous = f'delete table inet {TABLE}\n' if table_exists() else ''
    return previous + f'''table inet {TABLE} {{
 chain output {{
  type route hook output priority -160; policy accept;
  meta skuid {uid} ip daddr {FRP_ADDRESS} tcp dport {FRP_PORT} meta mark set meta mark | {BYPASS_MARK} counter comment "LibreBrowser FRP service only"
 }}
}}
'''


def main():
    if os.geteuid() != 0:
        raise RuntimeError('This helper requires root')
    if len(sys.argv) != 2 or sys.argv[1] not in ('apply', 'check', 'remove', 'status'):
        raise RuntimeError('Usage: frp-route-bypass.py apply|check|remove|status')
    action = sys.argv[1]
    if action == 'remove':
        if table_exists():
            result = run(['nft', 'delete', 'table', 'inet', TABLE])
            if result.returncode:
                raise RuntimeError('Could not remove the dedicated FRP table')
        print('LibreBrowser FRP routing exception removed')
        return
    if action == 'status':
        print('installed' if table_exists() else 'absent')
        return
    verify_proxy_mark()
    uid = pwd.getpwnam('librebrowser-frpc').pw_uid
    args = ['nft'] + (['--check'] if action == 'check' else []) + ['--file', '-']
    result = run(args, input=rules(uid))
    if result.returncode:
        raise RuntimeError('Dedicated FRP rule validation/application failed: ' + result.stderr.strip())
    print('LibreBrowser FRP routing exception ' + ('validated (not applied)' if action == 'check' else 'installed'))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, KeyError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
