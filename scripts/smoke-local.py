#!/usr/bin/env python3
"""Exercise terminal-only recovery and real loopback HTTP with disposable accounts."""
import http.cookiejar
import json
import os
from pathlib import Path
import pty
import secrets
import select
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
BINARY = str(ROOT / 'bin/librebrowser')


def terminal(env, operation, password):
    master, slave = pty.openpty()
    process = subprocess.Popen([BINARY, 'admin', operation, '--username', 'thatyt'],
                               stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    transcript = b''
    answered = 0
    deadline = time.monotonic() + 20
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try:
                    block = os.read(master, 4096)
                except OSError:
                    break
                if not block:
                    break
                transcript += block
                prompts = transcript.count(b'password: ')
                while answered < prompts and answered < 2:
                    os.write(master, password.encode() + b'\n')
                    answered += 1
            if process.poll() is not None:
                break
        return process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)


def run():
    with tempfile.TemporaryDirectory(prefix='librebrowser-smoke-') as directory:
        env = dict(os.environ, DATABASE_PATH=directory+'/accounts.db', LOCAL_DEV='true',
                   LISTEN_ADDR='127.0.0.1:8091', PUBLIC_ORIGIN='http://localhost:8091',
                   BROKER_SOCKET=directory+'/absent-broker.sock')
        password, replacement = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        assert terminal(env, 'init', password) == 0, 'terminal bootstrap'
        assert terminal(env, 'init', password) != 0, 'bootstrap must be one-time'
        log = open(directory+'/server.log', 'w')
        server = subprocess.Popen([BINARY, 'serve'], env=env, stdout=log, stderr=log)
        try:
            jar = http.cookiejar.CookieJar()
            client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
            csrf = ''

            def api(path, body=None):
                headers = {'Origin': env['PUBLIC_ORIGIN'], 'X-CSRF-Token': csrf}
                if body is not None:
                    headers['Content-Type'] = 'application/json'
                request = urllib.request.Request(env['PUBLIC_ORIGIN']+path,
                    data=None if body is None else json.dumps(body).encode(), headers=headers)
                try:
                    with client.open(request, timeout=10) as response:
                        return response.status, response.read()
                except urllib.error.HTTPError as error:
                    return error.code, error.read()

            for _ in range(100):
                try:
                    if api('/healthz')[0] == 200:
                        break
                except OSError:
                    pass
                time.sleep(.05)
            else:
                raise AssertionError('server did not start')
            assert api('/browser/')[0] == 401
            status, body = api('/api/login', {'username': 'thatyt', 'password': password})
            assert status == 200
            data = json.loads(body)
            csrf = data['csrf']
            admin_id = data['user']['id']
            status, body = api('/api/admin/users', {'username': 'reader', 'password': password})
            assert status == 201
            assert api('/api/admin/users/'+admin_id+'/role', {'value': 'USER'})[0] == 400
            assert terminal(env, 'reset-password', replacement) == 0
            assert api('/api/me')[0] == 401, 'CLI reset did not revoke live login'
            jar.clear()
            status, body = api('/api/login', {'username': 'reader', 'password': password})
            assert status == 200
            csrf = json.loads(body)['csrf']
            assert api('/api/admin/users')[0] == 403
            assert api('/api/browser/start', {})[0] == 503, 'missing broker must fail honestly'
            assert api('/api/logout', {})[0] == 204
            assert api('/api/me')[0] == 401
            print('PASS: interactive bootstrap/recovery, HTTP login, roles, last-admin guard, revocation and logout')
            print('Chromium deliberately unavailable in this disposable authentication smoke test.')
        finally:
            server.terminate()
            server.wait(timeout=15)
            log.close()


if __name__ == '__main__':
    run()
