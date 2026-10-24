import os
from pathlib import Path
import plistlib
import shlex
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from unittest.mock import patch

from deploy import desktop,local


class DesktopTests(unittest.TestCase):
    def test_launcher_recovers_when_the_original_python_is_removed(self):
        with tempfile.TemporaryDirectory(prefix='idsl-python-') as directory:
            root=Path(directory)/"Project's folder";root.mkdir()
            (root/'labtex').write_text('import sys; print("|".join(sys.argv[1:]))')
            launch=root/'launch'
            with patch.object(desktop,'PYTHON_FALLBACKS',(sys.executable,)):
                launch.write_text(desktop.launcher_source(root,root/'removed-python3'))
            result=subprocess.run(['/bin/sh',str(launch)],env={'PATH':'/usr/bin:/bin'},capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.strip(),'local|open')

    def test_launcher_rejects_an_unusable_python_and_reports_missing_runtime(self):
        with tempfile.TemporaryDirectory(prefix='idsl-python-') as directory:
            root=Path(directory);unusable=root/'python3'
            unusable.write_text('#!/bin/sh\nexit 1\n');unusable.chmod(0o700)
            (root/'labtex').write_text('import sys; print("|".join(sys.argv[1:]))')
            launch=root/'launch'
            with patch.object(desktop,'PYTHON_FALLBACKS',(sys.executable,)):
                launch.write_text(desktop.launcher_source(root,unusable))
            result=subprocess.run(['/bin/sh',str(launch)],env={'PATH':''},capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.strip(),'local|open')
            with patch.object(desktop,'PYTHON_FALLBACKS',()):
                launch.write_text(desktop.launcher_source(root,unusable))
            result=subprocess.run(['/bin/sh',str(launch)],env={'PATH':''},capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,1)
            self.assertIn('Python 3.10 or newer',result.stderr)

    def test_failed_start_never_opens_browser_and_saved_port_is_used(self):
        with patch.object(local,'start') as start,patch.object(local,'settings',return_value={'port':8877}),patch.object(local.subprocess,'run') as browser:
            local.open_browser();start.assert_called_once_with(None)
            browser.assert_called_once_with(['/usr/bin/open','http://127.0.0.1:8877'],check=True,timeout=15)
            browser.reset_mock();start.side_effect=RuntimeError('Port is occupied')
            with self.assertRaises(RuntimeError):local.open_browser()
            browser.assert_not_called()

    def test_install_refuses_unrelated_apps_and_desktop_items(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(desktop.sys,'platform','darwin'):
            root=Path(directory);(root/'labtex').write_text('# fixture');apps=root/'Applications';apps.mkdir();desk=root/'Desktop';desk.mkdir()
            shortcut=desk/'IDSL Editor.app';shortcut.write_text('Unrelated file')
            with self.assertRaises(RuntimeError):desktop.install(root,apps,desk)
            self.assertEqual(shortcut.read_text(),'Unrelated file');shortcut.unlink()
            app=apps/'IDSL Editor.app';app.mkdir();(app/'retained').write_text('Unrelated application')
            with self.assertRaises(RuntimeError):desktop.install(root,apps,desk)
            self.assertEqual((app/'retained').read_text(),'Unrelated application')

    @unittest.skipUnless(sys.platform=='darwin' and os.getenv('LABTEX_TEST_GUI')=='1','Explicit local Mac GUI test only')
    def test_real_native_app_shortcut_quoting_repeated_clicks_and_reinstall(self):
        with tempfile.TemporaryDirectory(prefix='idsl-desktop-') as directory:
            base=Path(directory).resolve();root=base/'Writing "notes" and apostrophe\'s';root.mkdir();(root/'labtex').write_text('# fixture')
            executable=base/"Python's folder"/'python3';executable.parent.mkdir();record=base/'arguments'
            executable.write_text('#!/bin/sh\nif [ "$1" = "-I" ]; then exit 0; fi\nprintf "%s\\n" "$@" >> '+shlex.quote(str(record))+'\n');executable.chmod(0o700)
            apps=base/'Applications';desk=base/'Desktop'
            target=desktop.install(root,apps,desk,str(executable));shortcut=desk/target.name
            self.assertTrue(shortcut.is_symlink());self.assertEqual(shortcut.resolve(),target)
            with (target/'Contents/Info.plist').open('rb') as stream:info=plistlib.load(stream)
            self.assertTrue(info['LSMultipleInstancesProhibited'])
            subprocess.run(['/usr/bin/codesign','--verify','--strict',str(target)],check=True,capture_output=True,timeout=15)
            for _ in range(2):subprocess.run(['/usr/bin/open','-W',str(shortcut)],check=True,capture_output=True,timeout=30)
            self.assertEqual(record.read_text().splitlines(),[str(root/'labtex'),'local','open']*2)
            self.assertEqual(desktop.install(root,apps,desk,str(executable)),target)
            self.assertTrue(shortcut.is_symlink());self.assertFalse(list(apps.glob('.idsl-launcher-*')))

    @unittest.skipUnless(sys.platform=='darwin' and os.getenv('LABTEX_TEST_GUI')=='1','Explicit local Mac GUI test only')
    def test_native_app_cold_start_and_reuse_with_disposable_data(self):
        import json,socket
        repo=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='idsl-desktop-start-') as directory:
            root=Path(directory).resolve();state=root/'.local';(state/'bin').mkdir(parents=True)
            for name in ('typst','tectonic','tinymist'):(state/'bin'/name).symlink_to(repo/'.local/bin'/name)
            with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
            (state/'local.json').write_text(json.dumps({'port':port}));record=root/'browser.json'
            # The real launcher starts a real HTTP server. Intercept only the
            # browser-opening call so the fixture never opens a throwaway tab.
            (root/'labtex').write_text('import sys,json\nfrom pathlib import Path\nsys.path.insert(0,'+repr(str(repo))+')\nfrom deploy import local\nlocal.ROOT=Path('+repr(str(root))+')\nlocal.STATE=local.ROOT/".local"\noriginal=local.subprocess.run\ndef run(command,**kwargs):\n if command[0]=="/usr/bin/open":\n  path=local.ROOT/"browser.json"\n  values=json.loads(path.read_text()) if path.exists() else []\n  path.write_text(json.dumps(values+[command[1]]))\n else:return original(command,**kwargs)\nlocal.subprocess.run=run\nlocal.main(sys.argv[2:])\n')
            with patch.object(desktop,'PYTHON_FALLBACKS',(sys.executable,*desktop.PYTHON_FALLBACKS)):
                target=desktop.install(root,root/'Applications',root/'Desktop',str(root/'removed-python3'))
            try:
                subprocess.run(['/usr/bin/open','-W',str(target)],check=True,capture_output=True,timeout=30)
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/app-update/health',timeout=3) as response:self.assertEqual(response.status,200)
                pid=(state/'local.pid').read_text()
                subprocess.run(['/usr/bin/open','-W',str(target)],check=True,capture_output=True,timeout=30)
                self.assertEqual((state/'local.pid').read_text(),pid)
                self.assertEqual(json.loads(record.read_text()),[f'http://127.0.0.1:{port}']*2)
                self.assertTrue((root/'data/labtex.sqlite3').is_file())
            finally:subprocess.run([sys.executable,str(root/'labtex'),'local','stop'],capture_output=True,timeout=20)
