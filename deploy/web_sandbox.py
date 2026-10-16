#!/usr/bin/python3
"""Restrict the web process to app source, its data and isolated build storage."""
import json
import hashlib
import os
from pathlib import Path
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
WORK_PREFIX='labtex-web-'+hashlib.sha256(str(ROOT).encode()).hexdigest()[:12]+'-'


def web_command():
    config_path=ROOT/'.local/native.json'
    config=json.loads(config_path.read_text())
    tex=Path(config['tex_environment']).resolve()
    bundle=Path(config['tex_bundle']).resolve()
    data=ROOT/'data';data.mkdir(mode=0o700,exist_ok=True)
    # A private host tmpfs directory is the only persistent writable build mount.
    work=Path(tempfile.mkdtemp(prefix=WORK_PREFIX,dir='/dev/shm'))
    command=['/usr/bin/bwrap','--unshare-user','--unshare-pid','--unshare-ipc',
             '--unshare-uts','--die-with-parent','--new-session','--cap-drop','ALL',
             '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin',
             '--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
             '--ro-bind','/etc/fonts','/etc/fonts','--ro-bind','/etc/ssl','/etc/ssl',
             '--proc','/proc','--dev','/dev','--tmpfs','/tmp',
             '--bind',str(work),'/dev/shm',
             '--ro-bind',str(ROOT),str(ROOT),
             '--tmpfs',str(ROOT/'.local'),
             '--ro-bind',str(config_path),str(config_path),
             '--ro-bind',str(bundle),str(bundle),
             '--ro-bind',str(tex),str(tex),
             '--bind',str(data),str(data),'--chdir',str(ROOT)]
    for key in ('APP_ORIGIN','HOST','PORT','LATEX_ENGINE','TECTONIC_BIN','COMPILE_TIMEOUT',
                'TRUST_CLOUDFLARE','LABTEX_TMPDIR'):
        if key in os.environ:command+=['--setenv',key,os.environ[key]]
    command+=['--setenv','DATA_DIR',str(data),'--setenv','PATH','/usr/bin:/bin',
              '--setenv','HOME','/nonexistent','--setenv','LANG','C.UTF-8',
              '--setenv','PYTHONUNBUFFERED','1','--setenv','PYTHONDONTWRITEBYTECODE','1',
              '--','/usr/bin/python3',str(ROOT/'server.py')]
    return command,work


def web_environment():
    # Keep the bootstrap capability out of process command lines and diagnostics.
    return {key:os.environ[key] for key in ('SETUP_TOKEN',) if key in os.environ}


if __name__=='__main__':
    import fcntl
    import shutil
    import signal
    import subprocess
    lock=(ROOT/'.local/web-runtime.lock').open('a')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    for orphan in Path('/dev/shm').glob(WORK_PREFIX+'*'):
        if orphan.is_dir() and not orphan.is_symlink() and orphan.stat().st_uid==os.getuid():
            shutil.rmtree(orphan)
    command,work=web_command()
    child=subprocess.Popen(command,env=web_environment())
    def stop(*_):
        child.terminate()
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    try:code=child.wait()
    finally:
        if child.poll() is None:child.kill();child.wait()
        shutil.rmtree(work,ignore_errors=True)
    sys.exit(code)
