#!/usr/bin/python3
"""Supervise a trial HTTPS tunnel and the local, sandboxed LabTeX backend."""
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.local'
children = []


def stop(*_):
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
    for child in reversed(children):
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
    raise SystemExit(0)


def main():
    os.umask(0o077)
    STATE.mkdir(exist_ok=True, mode=0o700)
    config = json.loads((STATE / 'native.json').read_text())
    port = int(config.get('port', 8765))
    local_origin = 'http://127.0.0.1:' + str(port)
    token_file = STATE / 'setup-token'
    if not token_file.exists():
        token_file.write_text(secrets.token_urlsafe(32) + '\n')
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    origin = config.get('origin', local_origin)
    tunnel = None
    if config.get('public_tunnel', False):
        log_path = STATE / 'tunnel.log'
        with log_path.open('w') as log:
            tunnel = subprocess.Popen([
                str(STATE / 'bin/cloudflared'), 'tunnel', '--no-autoupdate',
                '--protocol', 'http2', '--url', local_origin,
            ], stdout=log, stderr=subprocess.STDOUT)
        children.append(tunnel)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and tunnel.poll() is None:
            match = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', log_path.read_text())
            if match:
                origin = match.group()
                break
            time.sleep(.25)
        else:
            print('Tunnel failed to start; inspect .local/tunnel.log', flush=True)
            return 1
    (STATE / 'url').write_text(origin + '\n')
    env = dict(os.environ, APP_ORIGIN=origin, HOST='127.0.0.1', PORT=str(port),
               DATA_DIR=str(ROOT / 'data'), LATEX_ENGINE='tectonic',
               TECTONIC_BIN=str(ROOT / 'deploy/sandbox.py'), TYPST_BIN=str(ROOT / 'deploy/sandbox.py'), COMPILE_TIMEOUT='300',
               SETUP_TOKEN=token_file.read_text().strip(), PYTHONDONTWRITEBYTECODE='1',
               PYTHONUNBUFFERED='1')
    env.pop('COMPILER_URL',None)
    env['TRUST_CLOUDFLARE']='1' if config.get('public_tunnel',False) else '0'
    env['LABTEX_TMPDIR']='/dev/shm'
    with (STATE / 'web.log').open('a') as log:
        web = subprocess.Popen(['/usr/bin/python3', str(ROOT / 'deploy/web_sandbox.py')],
                               cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    children.append(web)
    print('LabTeX URL: ' + origin, flush=True)
    print('First-account setup token: .local/setup-token', flush=True)
    while web.poll() is None and (tunnel is None or tunnel.poll() is None):
        time.sleep(1)
    return 1


if __name__ == '__main__':
    try:
        code = main()
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
    sys.exit(code)
