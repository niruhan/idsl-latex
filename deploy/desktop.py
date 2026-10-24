"""Create a small personal macOS app; installation paths stay outside source."""
import json
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile

REGISTER='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
PYTHON_FALLBACKS=('/opt/homebrew/bin/python3','/usr/local/bin/python3',
                  '/Library/Frameworks/Python.framework/Versions/Current/bin/python3','/usr/bin/python3')

SCRIPT='''on run
    try
        set launcher to POSIX path of (path to resource "launch" in bundle (path to me))
        do shell script quoted form of launcher
    on error problem
        display alert "IDSL Editor could not start" message problem as critical
    end try
end run
'''


def python_path():
    # Finder has a minimal PATH. Prefer a stable symlink to this interpreter.
    candidate=shutil.which('python3')
    return candidate if candidate and Path(candidate).resolve()==Path(sys.executable).resolve() else sys.executable


def launcher_source(root,python):
    # Finder does not inherit the shell's PATH. Resolve a working interpreter
    # on each click so replacing Homebrew or Python.org Python needs no repair.
    candidates=' '.join(shlex.quote(str(path)) for path in dict.fromkeys((python,*PYTHON_FALLBACKS)))
    return '''#!/bin/sh
for interpreter in '''+candidates+''' "$(command -v python3)"; do
    if [ -x "$interpreter" ] && "$interpreter" -I -S -c 'import sys, sqlite3; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
        exec "$interpreter" '''+shlex.quote(str(Path(root)/'labtex'))+''' local open
    fi
done
printf '%s\\n' 'IDSL Editor needs Python 3.10 or newer with SQLite support. Reinstall Python and try again.' >&2
exit 1
'''


def install(root,applications=None,desktop=None,python=None):
    if sys.platform!='darwin':raise RuntimeError('The Desktop launcher supports macOS only.')
    root=Path(root).resolve();applications=Path(applications or Path.home()/'Applications');desktop=Path(desktop or Path.home()/'Desktop')
    target=applications/'IDSL Editor.app';shortcut=desktop/target.name;python=python or python_path()
    if not (root/'labtex').is_file():raise RuntimeError('The app folder is missing its labtex launcher.')
    if shortcut.exists() or shortcut.is_symlink():
        if not shortcut.is_symlink() or shortcut.resolve()!=target.resolve():raise RuntimeError('Another IDSL Editor item already exists on the Desktop. Move it before installing the launcher.')
    if target.exists() or target.is_symlink():
        try:metadata=json.loads((target/'Contents/Resources/idsl-launcher.json').read_text())
        except (OSError,ValueError):metadata={}
        if target.is_symlink() or not isinstance(metadata,dict) or metadata.get('root')!=str(root):raise RuntimeError('Another IDSL Editor app already exists in Applications. Move it before installing this launcher.')
    applications.mkdir(parents=True,exist_ok=True);desktop.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.idsl-launcher-',dir=applications) as folder:
        folder=Path(folder);script=folder/'launcher.applescript';script.write_text(SCRIPT);bundle=folder/target.name
        subprocess.run(['/usr/bin/osacompile','-o',str(bundle),str(script)],capture_output=True,check=True,timeout=30)
        resources=bundle/'Contents/Resources';resources.mkdir(parents=True,exist_ok=True)
        launch=resources/'launch';launch.write_text(launcher_source(root,python));launch.chmod(0o700)
        marker=resources/'idsl-launcher.json';marker.write_text(json.dumps({'root':str(root)})+'\n');marker.chmod(0o600)
        info=bundle/'Contents/Info.plist'
        with info.open('rb') as stream:properties=plistlib.load(stream)
        properties.update(CFBundleIdentifier='org.idsl.editor.desktop',CFBundleName='IDSL Editor',CFBundleDisplayName='IDSL Editor',LSMultipleInstancesProhibited=True)
        with info.open('wb') as stream:plistlib.dump(properties,stream)
        subprocess.run(['/usr/bin/codesign','--force','--sign','-','--timestamp=none',str(bundle)],capture_output=True,check=True,timeout=30)
        previous=folder/'previous.app';replaced=False
        try:
            if target.exists():target.rename(previous);replaced=True
            bundle.rename(target)
            # Register before exposing the shortcut so its first click works.
            subprocess.run([REGISTER,'-f',str(target)],capture_output=True,check=True,timeout=15)
            if not shortcut.is_symlink():shortcut.symlink_to(target,target_is_directory=True)
        except (OSError,subprocess.SubprocessError):
            if target.exists() and not bundle.exists():shutil.rmtree(target)
            if replaced:previous.rename(target)
            raise
    print('Desktop launcher installed: '+str(shortcut))
    print('Double-click IDSL Editor to start and open it. Drag it into the Dock for quick access.')
    return target
