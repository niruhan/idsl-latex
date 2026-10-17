"""Personal macOS runner. Compilers and caches stay inside this checkout."""
import argparse
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import platform
import secrets
import signal
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request

from deploy.launcher import ROOT, STATE, download

PINS = json.loads((ROOT / 'deploy/local-dependencies.json').read_text())


def prepare():
    if sys.version_info < (3, 10):
        raise RuntimeError('Python 3.10 or newer is required.')
    STATE.mkdir(mode=0o700, exist_ok=True)
    for name in ('bin', 'downloads', 'compiler-home', 'builds'):
        (STATE / name).mkdir(mode=0o700, exist_ok=True)


def environment():
    prepare()
    env = dict(os.environ)
    for key in ('COMPILER_URL', 'SETUP_TOKEN', 'TRUST_CLOUDFLARE', 'LATEX_ENGINE', 'HOST', 'PORT',
                'APP_ORIGIN', 'DATA_DIR', 'TECTONIC_BIN', 'TYPST_BIN', 'LABTEX_TMPDIR',
                'TYPST_PACKAGE_PATH', 'TYPST_PACKAGE_CACHE_PATH'):
        env.pop(key, None)
    env.update(LATEX_ENGINE='tectonic', TECTONIC_BIN=str(STATE / 'bin/tectonic'),
               TYPST_BIN=str(STATE / 'bin/typst'), LABTEX_COMPILER_HOME=str(STATE / 'compiler-home'),
               LABTEX_TMPDIR=str(STATE / 'builds'), COMPILE_TIMEOUT='300',
               PYTHONDONTWRITEBYTECODE='1', PYTHONUNBUFFERED='1')
    return env


def setup():
    prepare()
    if sys.platform != 'darwin':
        raise RuntimeError('Local setup supports macOS. Use ./labtex setup for Linux hosting.')
    machine = {'arm64': 'aarch64', 'x86_64': 'x86_64'}.get(platform.machine())
    if not machine:
        raise RuntimeError('Unsupported Mac architecture: ' + platform.machine())
    for name in ('typst', 'tectonic'):
        pin = PINS[machine][name]
        archive = STATE / 'downloads' / pin['url'].rsplit('/', 1)[-1]
        download(pin, archive)
        # Extract only the expected regular executable, never archive paths or links.
        with tarfile.open(archive) as source:
            members = [m for m in source if m.isfile() and PurePosixPath(m.name).name == name]
            if len(members) != 1:
                raise RuntimeError('Invalid compiler archive: ' + name)
            target = STATE / 'bin' / name
            temp = target.with_suffix('.tmp')
            with source.extractfile(members[0]) as src, temp.open('wb') as dst:
                import shutil
                shutil.copyfileobj(src, dst)
            temp.chmod(0o700)
            temp.replace(target)
    doctor()
    print('Setup complete. Run ./labtex start.')


def doctor():
    env = environment()
    for name in ('typst', 'tectonic'):
        path = STATE / 'bin' / name
        if not path.is_file():
            raise RuntimeError('Missing ' + name + '. Run ./labtex setup.')
        subprocess.run([str(path), '--version'], check=True)
    subprocess.run([sys.executable, '-c', '''
from core import SAMPLE, TYPST_SAMPLE, compile_project
for files, main in ((TYPST_SAMPLE, 'main.typ'), (SAMPLE, 'main.tex')):
    result = compile_project(files, main)
    assert result['success'], result['log']
    print(main + ': real PDF compilation passed (' + str(result['seconds']) + 's)')
'''], cwd=ROOT, env=env, check=True)


def settings():
    path = STATE / 'local.json'
    return json.loads(path.read_text()) if path.exists() else {'port': 8765}


def running():
    prepare()
    with (STATE / 'local.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
    return False


def serve(port):
    env = environment()
    lock = (STATE / 'local.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('This checkout is already running.')
    token_path = STATE / 'setup-token'
    if not token_path.exists():
        token_path.write_text(secrets.token_urlsafe(32) + '\n')
        token_path.chmod(0o600)
    env.update(SETUP_TOKEN=token_path.read_text().strip(), DATA_DIR=str(ROOT / 'data'),
               APP_ORIGIN=f'http://127.0.0.1:{port}')
    os.environ.clear()
    os.environ.update(env)
    (STATE / 'local.pid').write_text(str(os.getpid()))
    from server import App, Handler, BoundedHTTPServer
    server = BoundedHTTPServer(('127.0.0.1', port), Handler)
    server.app = App(env['DATA_DIR'], env['APP_ORIGIN'])
    # Raising exits serve_forever on the main thread without a shutdown deadlock.
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print('IDSL Editor: ' + env['APP_ORIGIN'], flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        (STATE / 'local.pid').unlink(missing_ok=True)
        lock.close()


def start(port=None):
    prepare()
    if running():
        print(f"Already running: http://127.0.0.1:{settings()['port']}")
        return
    for name in ('typst', 'tectonic'):
        if not (STATE / 'bin' / name).is_file():
            raise RuntimeError('Run ./labtex setup first.')
    port = port or settings()['port']
    if not 1024 <= port <= 65535:
        raise RuntimeError('Choose a port between 1024 and 65535.')
    with socket.socket() as probe:
        # Match HTTPServer's reuse behaviour so a stop/start works while old
        # browser connections are still in TCP TIME_WAIT.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', port))
        except OSError:
            raise RuntimeError(f'Port {port} is occupied. Use ./labtex start --port 8877.')
    (STATE / 'local.json').write_text(json.dumps({'port': port}) + '\n')
    with (STATE / 'local.log').open('ab') as log:
        child = subprocess.Popen([sys.executable, str(ROOT / 'labtex'), 'local', '_serve', '--port', str(port)],
                                 cwd=ROOT, env=environment(), stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=log, start_new_session=True)
    for _ in range(60):
        if child.poll() is not None:
            raise RuntimeError('Startup failed. Run ./labtex logs.')
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/session', timeout=1) as response:
                if response.status == 200:
                    print(f'IDSL Editor is running at http://127.0.0.1:{port}')
                    print('First account: ./labtex setup-token | Stop: ./labtex stop')
                    return
        except OSError:
            pass
        time.sleep(.1)
    raise RuntimeError('Startup timed out. Run ./labtex logs.')


def main(arguments=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='Run the LaTeX + Typst workspace locally on your Mac.')
    parser.add_argument('command', choices=('setup', 'start', 'stop', 'status', 'url', 'doctor', 'logs', 'setup-token', 'test', '_serve'), nargs='?', default='start')
    parser.add_argument('--port', type=int)
    args = parser.parse_args(arguments)
    try:
        if args.command == 'setup': setup()
        elif args.command == 'doctor': doctor()
        elif args.command == 'start': start(args.port)
        elif args.command == '_serve': serve(args.port or 8765)
        elif args.command == 'stop':
            if running():
                os.kill(int((STATE / 'local.pid').read_text()), signal.SIGTERM)
                for _ in range(50):
                    if not running(): break
                    time.sleep(.1)
                if running(): raise RuntimeError('Server is still stopping. Check ./labtex status.')
            print('Stopped. Your projects are retained.')
        elif args.command in ('status', 'url'):
            print(('Running: ' if running() else 'Stopped: ') + f"http://127.0.0.1:{settings()['port']}")
        elif args.command == 'setup-token':
            from deploy.launcher import has_owner
            if has_owner(): raise RuntimeError('First-account setup is already complete.')
            path = STATE / 'setup-token'
            if not path.exists(): raise RuntimeError('Run ./labtex start first.')
            print(path.read_text().strip())
        elif args.command == 'logs':
            path = STATE / 'local.log'
            print('\n'.join(path.read_text(errors='replace').splitlines()[-60:]) if path.exists() else 'No log yet.')
        elif args.command == 'test':
            subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-v'], cwd=ROOT,
                           env=dict(environment(), TEST_LATEX_ENGINE='tectonic'), check=True)
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, 'Error: ' + str(error) + '\n')
