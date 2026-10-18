"""Run browser regressions with an ephemeral database and the local Mac compilers.

Set PLAYWRIGHT_MODULE and NODE_BIN to your external Playwright installation.
"""
import argparse
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deploy.local import environment, ROOT
from server import delete_project_rows


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--screenshots',action='store_true',help='Capture documentation images using a fresh fictional demo account')
    parser.add_argument('--live-typst',action='store_true',help='Run native Tinymist integration checks on a fresh database')
    parser.add_argument('--latex-source',action='store_true',help='Run real LaTeX PDF click-to-source checks on a fresh database')
    parser.add_argument('--backup-ui',action='store_true',help='Run project backup and shared-snapshot UI checks on a fresh database')
    parser.add_argument('--editor-undo',action='store_true',help='Run source undo and redo checks on a fresh database')
    parser.add_argument('--editor-save',action='store_true',help='Run autosave and navigation checks on a fresh database')
    parser.add_argument('--file-actions',action='store_true',help='Run file selection, deletion, context menus, moves and editing regressions on a fresh database')
    parser.add_argument('--source-folding',action='store_true',help='Run LaTeX/Typst source folding and edit-preservation checks on a fresh database')
    parser.add_argument('--autocomplete',action='store_true',help='Run LaTeX/Typst automatic and manual code-completion checks on a fresh database')
    parser.add_argument('--workspace-tools',action='store_true',help='Run project search, outline, tabs/split, bibliography and GitHub review checks on a fresh database')
    parser.add_argument('--explorer-previews',action='store_true',help='Run first-page project covers and full-title hover/focus checks on a fresh database')
    parser.add_argument('--source-search',action='store_true',help='Run in-file find/replace and integrated global file/content search checks on a fresh database')
    parser.add_argument('--file-explorer',action='store_true',help='Run root-tree, thumbnail and file-column resize checks on disposable data')
    parser.add_argument('--updates',action='store_true',help='Run consent-only app update controls with mocked public metadata')
    parser.add_argument('--performance',action='store_true',help='Measure a large fictional project and assert idle/rendering efficiency')
    parser.add_argument('--collaboration',action='store_true',help='Run two independent app installations sharing a simulated GitHub repository')
    args=parser.parse_args()
    if args.collaboration:
        subprocess.run([sys.executable,str(ROOT/'tests/run_collaboration_browser.py')],cwd=ROOT,check=True)
        return
    scripts=('capture_docs.cjs',) if args.screenshots else ('browser_smoke.cjs', 'browser_editor_layout.cjs', 'browser_latex_source.cjs', 'browser_source_folding.cjs', 'browser_completions.cjs', 'browser_undo.cjs', 'browser_autosave.cjs', 'browser_typst.cjs', 'browser_home.cjs', 'browser_theme.cjs', 'browser_tree.cjs', 'browser_project_folders.cjs', 'browser_project_copy.cjs', 'browser_templates_palettes.cjs', 'browser_project_actions.cjs', 'browser_library_layout.cjs', 'browser_file_selection.cjs', 'browser_file_actions.cjs', 'browser_file_creation.cjs', 'browser_trash.cjs', 'browser_drag_live.cjs')
    if args.live_typst:scripts=('browser_smoke.cjs','browser_tinymist.cjs','browser_completions.cjs')
    if args.latex_source:scripts=('browser_latex_source.cjs',)
    if args.backup_ui:scripts=('browser_smoke.cjs','browser_typst.cjs','browser_drag_live.cjs')
    if args.editor_undo:scripts=('browser_undo.cjs',)
    if args.editor_save:scripts=('browser_autosave.cjs',)
    if args.file_actions:scripts=('browser_smoke.cjs','browser_file_selection.cjs','browser_file_actions.cjs','browser_file_creation.cjs','browser_tree.cjs','browser_drag_live.cjs','browser_undo.cjs','browser_autosave.cjs')
    if args.source_folding:scripts=('browser_source_folding.cjs',)
    if args.autocomplete:scripts=('browser_smoke.cjs','browser_completions.cjs')
    if args.workspace_tools:scripts=('browser_workspace_tools.cjs',)
    if args.explorer_previews:scripts=('browser_explorer_previews.cjs',)
    if args.updates:scripts=('browser_smoke.cjs','browser_updates.cjs')
    if args.performance:scripts=('browser_performance.cjs',)
    if args.file_explorer:scripts=('browser_smoke.cjs','browser_editor_layout.cjs','browser_file_explorer.cjs','browser_tree.cjs','browser_file_creation.cjs','browser_drag_live.cjs')
    if args.source_search:scripts=('browser_source_search.cjs',)
    # The full run keeps completion fixtures in their own disposable server so
    # repeated demo sign-ins do not exhaust the production login rate limiter.
    full_run=not any(vars(args).values())
    if full_run:scripts=tuple(script for script in scripts if script!='browser_completions.cjs')
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
                # Retained trash counts toward project limits. Purge only deleted
                # fixtures in this runner's disposable database between suites.
                with sqlite3.connect(Path(folder) / 'labtex.sqlite3') as db:
                    for (pid,) in db.execute('SELECT project_id FROM project_trash').fetchall():
                        delete_project_rows(db,pid)
        finally:
            server.terminate()
            server.wait(timeout=10)
    if full_run:
        for suite in ('--autocomplete','--workspace-tools','--explorer-previews','--source-search','--collaboration','--file-explorer','--performance','--updates'):subprocess.run([sys.executable,str(Path(__file__).resolve()),suite],cwd=ROOT,check=True)


if __name__ == '__main__': main()
