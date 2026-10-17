"""Run browser regressions with an ephemeral database and the local Mac compilers.

Set PLAYWRIGHT_MODULE and NODE_BIN to your external Playwright installation.
"""
import argparse
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deploy.local import environment, ROOT


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--screenshots',action='store_true',help='Capture documentation images using a fresh fictional demo account')
    parser.add_argument('--live-typst',action='store_true',help='Run native Tinymist integration checks on a fresh database')
    parser.add_argument('--backup-ui',action='store_true',help='Run project backup and shared-snapshot UI checks on a fresh database')
    parser.add_argument('--editor-undo',action='store_true',help='Run source undo and redo checks on a fresh database')
    parser.add_argument('--editor-save',action='store_true',help='Run autosave and navigation checks on a fresh database')
    args=parser.parse_args()
    scripts=('capture_docs.cjs',) if args.screenshots else ('browser_smoke.cjs', 'browser_editor_layout.cjs', 'browser_undo.cjs', 'browser_autosave.cjs', 'browser_typst.cjs', 'browser_home.cjs', 'browser_theme.cjs', 'browser_tree.cjs', 'browser_project_folders.cjs', 'browser_templates_palettes.cjs', 'browser_project_actions.cjs', 'browser_library_layout.cjs', 'browser_file_actions.cjs', 'browser_file_creation.cjs', 'browser_drag_live.cjs')
    if args.live_typst:scripts=('browser_smoke.cjs','browser_tinymist.cjs')
    if args.backup_ui:scripts=('browser_smoke.cjs','browser_typst.cjs','browser_drag_live.cjs')
    if args.editor_undo:scripts=('browser_undo.cjs',)
    if args.editor_save:scripts=('browser_autosave.cjs',)
    with tempfile.TemporaryDirectory(prefix='labtex-browser-') as folder:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        env = dict(environment(), DATA_DIR=folder, SETUP_TOKEN='local-browser-test-only',
                   APP_ORIGIN=origin, TEST_ORIGIN=origin, LABTEX_TYPST_LIVE='1' if args.live_typst or args.screenshots else '0')
        log_path = Path(folder) / 'server.log'
        with log_path.open('w') as log:
            server = subprocess.Popen([sys.executable, '-c', 'import server; from credential_store import FileTokenStore; server.token_store=lambda data: FileTokenStore(server.Path(data)/".github-tokens"); server.main()', '--port', str(port)], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(origin + '/api/session', timeout=1): break
                except OSError: time.sleep(.1)
            else: raise RuntimeError('Browser test server did not start: ' + log_path.read_text())
            for script in scripts:
                subprocess.run([os.getenv('NODE_BIN', 'node'), str(ROOT / 'tests' / script)], env=env, cwd=ROOT, check=True)
        finally:
            server.terminate()
            server.wait(timeout=10)


if __name__ == '__main__': main()
