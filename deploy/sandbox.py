#!/usr/bin/python3
"""Run each Tectonic build in a fresh, minimal bubblewrap filesystem."""
import json
import os
from pathlib import Path
import resource
import sys

ROOT = Path(__file__).resolve().parents[1]


def sandbox_command(arguments, work):
    config = json.loads((ROOT / '.local/native.json').read_text())
    tex = Path(config['tex_environment']).resolve()
    bundle = Path(config['tex_bundle']).resolve()
    if not bundle.is_file(): raise RuntimeError('Offline TeX bundle is missing.')
    work = Path(work).resolve()
    # The app creates this temporary directory, never a user-supplied host path.
    if work.parent != Path('/dev/shm') or not work.name.startswith('labtex-'):
        raise RuntimeError('Compiler must run in a LabTeX temporary project directory.')
    command = [
        '/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-ipc',
        '--unshare-uts', '--unshare-net', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
        '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
        '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
        '--ro-bind', '/etc/ssl', '/etc/ssl',
        '--ro-bind', '/etc/fonts', '/etc/fonts',
        '--ro-bind', str(tex), '/opt/tex',
        '--ro-bind', str(bundle), '/opt/texbundle/bundle.zip',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
        '--dir', '/home/compiler', '--tmpfs', '/home/compiler/.cache',
        '--bind', str(work), str(work), '--chdir', str(work),
        '--clearenv', '--setenv', 'PATH', '/opt/tex/bin:/usr/bin',
        '--setenv', 'HOME', '/home/compiler',
        '--setenv', 'XDG_CACHE_HOME', '/home/compiler/.cache',
        '--setenv', 'LANG', 'C.UTF-8',
        '--setenv', 'TECTONIC_UNTRUSTED_MODE', '1',
    ]
    return command + ['--', '/opt/tex/bin/tectonic', '--bundle', '/opt/texbundle/bundle.zip', *arguments]


if __name__ == '__main__':
    command = sandbox_command(sys.argv[1:], Path.cwd())
    resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024**2, 1536 * 1024**2))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024**2, 64 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.execv(command[0], command)
