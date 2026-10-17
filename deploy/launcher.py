"""Portable Linux installer. No sudo, shell evaluation, or inherited lab config."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request
from urllib.parse import urlsplit
import zipfile

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.local'
UNIT = 'idsl-latex-' + hashlib.sha256(str(ROOT).encode()).hexdigest()[:12] + '.service'
PINS = json.loads((ROOT / 'deploy/dependencies.json').read_text())


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def config():
    path = STATE / 'native.json'
    if not path.is_file():
        raise RuntimeError('Run ./labtex setup first.')
    return json.loads(path.read_text())


def save_config(value):
    path = STATE / 'native.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def download(pin, destination):
    destination = Path(destination)
    if destination.is_file() and sha256(destination) == pin['sha256']:
        print('Verified cached ' + destination.name, flush=True)
        return
    partial = destination.with_suffix(destination.suffix + '.part')
    request = urllib.request.Request(pin['url'], headers={'User-Agent': 'IDSL-LaTeX-installer'})
    print('Downloading ' + destination.name + ' (SHA-256 checked)', flush=True)
    try:
        with urllib.request.urlopen(request, timeout=120) as response, partial.open('wb') as out:
            if not response.url.startswith('https://'):
                raise RuntimeError('Refusing an insecure download redirect.')
            size = int(response.headers.get('Content-Length', 0))
            total = 0
            last_report = time.monotonic()
            while block := response.read(1024 * 1024):
                out.write(block)
                total += len(block)
                if time.monotonic() - last_report > 10:
                    print(f'  {total // 1024**2} MiB downloaded' + (f' / {size // 1024**2} MiB' if size else ''), flush=True)
                    last_report = time.monotonic()
        if sha256(partial) != pin['sha256']:
            raise RuntimeError('Download checksum mismatch; refusing to install ' + destination.name)
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


def convert_bundle(source, destination):
    """Stream regular tar entries into ZIP; never extract paths to the filesystem."""
    partial = destination.with_suffix('.part')
    try:
        seen = set()
        with tarfile.open(source) as archive, zipfile.ZipFile(partial, 'w', zipfile.ZIP_STORED, allowZip64=True) as out:
            for member in archive:
                if member.isdir():
                    continue
                path = PurePosixPath(member.name)
                if not member.isfile() or path.is_absolute() or '..' in path.parts or '\\' in member.name:
                    raise RuntimeError('Unsafe TeX bundle entry.')
                name = str(path)
                if name in seen:
                    raise RuntimeError('Duplicate TeX bundle entry.')
                seen.add(name)
                with archive.extractfile(member) as content, out.open(name, 'w', force_zip64=True) as entry:
                    shutil.copyfileobj(content, entry, 1024 * 1024)
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


def active():
    return subprocess.run(['systemctl', '--user', 'is-active', '--quiet', UNIT]).returncode == 0


def preflight():
    if sys.platform != 'linux' or platform.machine() != 'x86_64':
        raise RuntimeError('This release supports x86_64 Linux. See README requirements.')
    if os.geteuid() == 0:
        raise RuntimeError('Run as a regular user, not root or sudo.')
    if sys.version_info < (3, 10):
        raise RuntimeError('Python 3.10 or newer is required.')
    for binary in ('/usr/bin/bwrap', '/usr/bin/python3', '/usr/bin/systemctl'):
        if not Path(binary).is_file():
            raise RuntimeError('Missing ' + binary + '; install the README prerequisites.')
    for path in ('/etc/fonts', '/etc/ssl', '/dev/shm'):
        if not Path(path).is_dir():
            raise RuntimeError('Missing required directory: ' + path)
    if shutil.disk_usage('/dev/shm').total < 256 * 1024**2:
        raise RuntimeError('/dev/shm needs at least 256 MiB for isolated builds.')
    probe = subprocess.run(['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-net',
                            '--ro-bind', '/', '/', '--', '/usr/bin/true'], capture_output=True, text=True)
    if probe.returncode:
        raise RuntimeError('Unprivileged bubblewrap namespaces are unavailable. Use a compatible VM; do not disable the sandbox.\n' + probe.stderr.strip())
    run('systemctl', '--user', 'show-environment', stdout=subprocess.DEVNULL)
    if not Path('/sys/fs/cgroup/cgroup.controllers').is_file():
        raise RuntimeError('cgroup v2 is required for service resource limits.')


def setup(args):
    preflight()
    if active():
        raise RuntimeError('Stop this installation with ./labtex stop before setup.')
    STATE.mkdir(mode=0o700, exist_ok=True)
    STATE.chmod(0o700)
    (ROOT / 'deploy/sandbox.py').chmod(0o755)
    for folder in ('downloads', 'tex/bin', 'tex-bundle', 'bin'):
        (STATE / folder).mkdir(parents=True, exist_ok=True, mode=0o700)
    bundle = STATE / 'tex-bundle/bundle.zip'
    checksum = bundle.with_suffix('.sha256')
    source_checksum = bundle.with_suffix('.source.sha256')
    valid_bundle = (bundle.is_file() and checksum.is_file() and source_checksum.is_file()
                    and source_checksum.read_text().strip() == PINS['bundle']['sha256']
                    and sha256(bundle) == checksum.read_text().strip())
    if not valid_bundle and shutil.disk_usage(STATE).free < 7 * 1024**3:
        raise RuntimeError('At least 7 GiB free disk space is needed during setup.')
    archive = STATE / 'downloads/tectonic.tar.gz'
    download(PINS['tectonic'], archive)
    with tarfile.open(archive) as tar:
        members = [m for m in tar if m.isfile() and PurePosixPath(m.name).name == 'tectonic']
        if len(members) != 1:
            raise RuntimeError('Compiler archive did not contain exactly one executable.')
        with tar.extractfile(members[0]) as src, (STATE / 'tex/bin/tectonic').open('wb') as dst:
            shutil.copyfileobj(src, dst)
    (STATE / 'tex/bin/tectonic').chmod(0o700)
    typst_archive = STATE / 'downloads/typst.tar.xz'
    download(PINS['typst'], typst_archive)
    with tarfile.open(typst_archive) as tar:
        members = [m for m in tar if m.isfile() and PurePosixPath(m.name).name == 'typst']
        if len(members) != 1:
            raise RuntimeError('Typst archive did not contain exactly one executable.')
        with tar.extractfile(members[0]) as src, (STATE / 'tex/bin/typst').open('wb') as dst:
            shutil.copyfileobj(src, dst)
    (STATE / 'tex/bin/typst').chmod(0o700)

    if not valid_bundle:
        source = STATE / 'downloads/bundle.tar'
        download(PINS['bundle'], source)
        print('Preparing the offline TeX bundle (about 2.7 GiB)...', flush=True)
        convert_bundle(source, bundle)
        checksum.write_text(sha256(bundle) + '\n')
        source_checksum.write_text(PINS['bundle']['sha256'] + '\n')
        source.unlink()
    existing = config() if (STATE / 'native.json').exists() else {}
    existing.update(tex_environment=str(STATE / 'tex'), tex_bundle=str(bundle))
    existing.setdefault('port', 8765)
    existing.setdefault('public_tunnel', False)
    existing.setdefault('origin', 'http://127.0.0.1:8765')
    save_config(existing)
    doctor()
    print('Setup complete. Run ./labtex start, then ./labtex setup-token.')


def doctor():
    preflight()
    value = config()
    if not Path(value['tex_bundle']).is_file() or not all((Path(value['tex_environment']) / ('bin/' + name)).is_file() for name in ('tectonic','typst')):
        raise RuntimeError('Compiler or offline bundle missing. Run ./labtex setup.')
    environment = dict(os.environ, TEST_LATEX_ENGINE='tectonic', LATEX_ENGINE='tectonic',
                       TECTONIC_BIN=str(ROOT / 'deploy/sandbox.py'), TYPST_BIN=str(ROOT / 'deploy/sandbox.py'), LABTEX_TMPDIR='/dev/shm',
                       PYTHONDONTWRITEBYTECODE='1')
    environment.pop('COMPILER_URL', None)
    run('/usr/bin/python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*sandbox.py', cwd=ROOT, env=environment)
    run('/usr/bin/python3', '-c', "from core import TYPST_SAMPLE,compile_project; r=compile_project(TYPST_SAMPLE,'main.typ'); assert r['success'],r['log']; print('Offline sandboxed Typst compilation passed.')", cwd=ROOT, env=environment)
    run('/usr/bin/python3', '-c', "from core import SAMPLE,compile_project; r=compile_project(SAMPLE,'main.tex'); assert r['success'],r['log']; print('Offline sandboxed PDF compilation passed.')", cwd=ROOT, env=environment)


def unit_text():
    # systemd specifiers and quoting are not shell quoting; reject control chars.
    if any(ord(c) < 32 for c in str(ROOT)):
        raise RuntimeError('Installation path must not contain control characters.')
    root = str(ROOT).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
    working_directory = str(ROOT).replace('%', '%%')
    return f'''[Unit]
Description=IDSL Editor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={working_directory}
ExecStart=/usr/bin/python3 "{root}/deploy/native_host.py"
Restart=on-failure
RestartSec=10
KillMode=control-group
TimeoutStopSec=25
UMask=0077
MemoryMax=2G
MemorySwapMax=0
CPUQuota=100%
TasksMax=128
LimitCORE=0

[Install]
WantedBy=default.target
'''


def has_owner():
    path = ROOT / 'data/labtex.sqlite3'
    if not path.is_file():
        return False
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        return bool(db.execute("SELECT 1 FROM users WHERE id != 'demo' LIMIT 1").fetchone())


def start(args):
    preflight()
    value = config()
    if args.public:
        if not has_owner():
            raise RuntimeError('Create the first administrator locally before enabling public access. See README.')
        download(PINS['cloudflared'], STATE / 'bin/cloudflared')
        (STATE / 'bin/cloudflared').chmod(0o700)
        value['public_tunnel'] = True
    elif args.local:
        value['public_tunnel'] = False
        value['origin'] = ''
    elif args.origin:
        url = urlsplit(args.origin)
        if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
            raise RuntimeError('--origin must be an HTTPS origin such as https://latex.example.org')
        if not has_owner():
            raise RuntimeError('Create the administrator locally before configuring public HTTPS.')
        value['public_tunnel'] = False
        value['origin'] = args.origin.rstrip('/')
    port = args.port if args.port is not None else value['port']
    if not 1024 <= port <= 65535:
        raise RuntimeError('Use an unprivileged port between 1024 and 65535.')
    value['port'] = port
    if not value.get('origin') or value['origin'].startswith('http://127.0.0.1:'):
        value['origin'] = f'http://127.0.0.1:{port}'
    # Stop only this checkout's uniquely named service before changing its config.
    if active():
        run('systemctl', '--user', 'stop', UNIT)
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', port))
        except OSError:
            raise RuntimeError(f'Port {port} is in use; choose another with --port.')
    save_config(value)
    (STATE / 'url').unlink(missing_ok=True)
    directory = Path.home() / '.config/systemd/user'
    directory.mkdir(parents=True, exist_ok=True)
    (directory / UNIT).write_text(unit_text())
    run('systemctl', '--user', 'daemon-reload')
    run('systemctl', '--user', 'enable', '--now', UNIT)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if (STATE / 'url').is_file():
            origin = (STATE / 'url').read_text().strip()
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
            try:
                connection.request('GET', '/api/session', headers={'Host': urlsplit(origin).netloc})
                response = connection.getresponse()
                response.read()
                if response.status == 200:
                    print('IDSL Editor: ' + origin)
                    print('First account: ./labtex setup-token | Service details: ./labtex status')
                    print('For service after logout/reboot, see enable-linger in the README.')
                    return
            except OSError:
                pass
            finally:
                connection.close()
        time.sleep(.5)
    raise RuntimeError('Startup did not become healthy. Use ./labtex logs; ./labtex stop stops retries.')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='Install and host IDSL Editor safely on Linux.')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('setup', help='Download verified compiler and offline bundle; check isolation')
    commands.add_parser('doctor', help='Check prerequisites, isolation, and real PDF compilation')
    launch = commands.add_parser('start', help='Install/start this checkout\'s systemd user service')
    exposure = launch.add_mutually_exclusive_group()
    exposure.add_argument('--public', action='store_true', help='Temporary public HTTPS trial URL')
    exposure.add_argument('--local', action='store_true', help='Return to loopback-only HTTP')
    exposure.add_argument('--origin', help='HTTPS origin served by your own reverse proxy')
    launch.add_argument('--port', type=int, help='Loopback port, default 8765')
    for name in ('stop', 'status', 'url', 'setup-token', 'logs', 'uninstall-service', 'test'):
        commands.add_parser(name)
    args = parser.parse_args()
    try:
        if args.command == 'setup': setup(args)
        elif args.command == 'doctor': doctor()
        elif args.command == 'start': start(args)
        elif args.command == 'stop': run('systemctl', '--user', 'stop', UNIT)
        elif args.command == 'uninstall-service':
            run('systemctl', '--user', 'disable', '--now', UNIT)
            (Path.home() / '.config/systemd/user' / UNIT).unlink(missing_ok=True)
            run('systemctl', '--user', 'daemon-reload')
            print('Service removed. Your source, configuration, and data were retained.')
        elif args.command == 'status':
            print('Service: ' + UNIT, flush=True)
            result = subprocess.run(['systemctl', '--user', 'status', UNIT, '--no-pager'])
            sys.exit(result.returncode)
        elif args.command in ('url', 'setup-token'):
            path = STATE / args.command
            if not path.exists(): raise RuntimeError('Run ./labtex start first.')
            if args.command == 'setup-token' and has_owner():
                raise RuntimeError('Setup is already complete; the bootstrap token no longer grants access.')
            print(path.read_text().strip())
        elif args.command == 'logs':
            for name in ('web.log', 'tunnel.log'):
                path = STATE / name
                if path.exists():
                    print(name + ' (last 50 lines):')
                    print('\n'.join(path.read_text(errors='replace').splitlines()[-50:]))
        elif args.command == 'test':
            config()
            env = dict(os.environ, TEST_LATEX_ENGINE='tectonic', TECTONIC_BIN=str(ROOT / 'deploy/sandbox.py'),
                       TYPST_BIN=str(ROOT / 'deploy/sandbox.py'), LABTEX_TMPDIR='/dev/shm', PYTHONDONTWRITEBYTECODE='1')
            env.pop('COMPILER_URL', None)
            run('/usr/bin/python3', '-m', 'unittest', 'discover', '-s', 'tests', '-v', cwd=ROOT, env=env)
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, 'Error: ' + str(error) + '\n')
