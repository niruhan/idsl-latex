import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

import test_app
from typst_service import TypstSession


class SourceMappingTests(unittest.TestCase):
    def test_preview_pairs_and_lsp_ranges_keep_the_source_position(self):
        with tempfile.TemporaryDirectory() as folder:
            session = TypstSession.__new__(TypstSession)
            session.root = Path(folder).resolve()
            path = 'sections/field notes.typ'
            session.files = {path: b'Example'}
            session.lock, session.event, session.jump = threading.RLock(), 0, None
            replies = []
            session._send = replies.append
            for method, location in [
                ('tinymist/preview/scrollSource', {'filepath': str(session.root / path), 'start': [65, 7], 'end': [65, 12]}),
                ('window/showDocument', {'uri': (session.root / path).as_uri(), 'selection': {'start': {'line': 65, 'character': 7}, 'end': {'line': 65, 'character': 12}}}),
            ]:
                with self.subTest(method=method):
                    session._notification({'id': 1, 'method': method, 'params': location})
                    self.assertEqual(session.jump['path'], path)
                    self.assertEqual(session.jump['range'], {'start': {'line': 65, 'character': 7}, 'end': {'line': 65, 'character': 12}})
                    self.assertEqual(replies[-1]['result'], {'success': True})
            session._notification({'method': 'tinymist/preview/scrollSource', 'params': {'filepath': str(session.root / path), 'start': [65, 7]}})
            self.assertEqual(session.jump['range'], {'start': {'line': 65, 'character': 7}, 'end': {'line': 65, 'character': 7}})
            event = session.event
            for target in (session.root / '../outside.typ', session.root / 'missing.typ'):
                session._notification({'method': 'tinymist/preview/scrollSource', 'params': {'filepath': str(target), 'start': [65, 7]}})
                self.assertEqual(session.event, event, 'Only existing files in this project can be opened')
            for start in ([65], [-1, 7], [True, 7], '65:7'):
                session._notification({'method': 'tinymist/preview/scrollSource', 'params': {'filepath': str(session.root / path), 'start': start}})
                self.assertEqual(session.event, event, 'Malformed positions must not jump to the wrong source')


@unittest.skipUnless(sys.platform == 'darwin' and os.access(os.getenv('TINYMIST_BIN', ''), os.X_OK), 'Native Tinymist is not installed')
class TinymistTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    invite = test_app.AppTests.invite
    lab_signup = test_app.AppTests.lab_signup

    def live_project(self):
        self.pid = self.owner.call('/api/projects', 'POST', {'name': 'Live Typst fixture', 'format': 'typst', 'template': False})[1]['id']
        self.base = '/api/projects/' + self.pid
        self.source = '= Live fixture\n#let answer = 42\nThe answer is #answer.\n'
        self.assertEqual(self.owner.call(self.base+'/file', 'PUT', {'path': 'main.typ', 'content': self.source, 'revision': 1})[0], 200)
        code, result = self.owner.call(self.base+'/typst', 'POST', {})
        self.assertEqual(code, 200, result)
        self.endpoint = self.base+'/typst/'+result['id']
        self.session = self.app.typst.sessions[result['id']]
        return result

    def wait_status(self, expected):
        end = time.monotonic()+20
        while time.monotonic() < end:
            code, result = self.owner.call(self.endpoint)
            self.assertEqual(code, 200, result)
            if result['status'] == expected:
                return result
            time.sleep(.1)
        self.fail('Tinymist did not reach '+expected+': '+str(result))

    def change(self, text, sequence):
        code, result = self.owner.call(self.endpoint, 'POST', {'operation': 'change', 'path': 'main.typ', 'content': text, 'sequence': sequence})
        self.assertEqual(code, 200, result)
        return result

    def query(self, method, line=2, character=17):
        code, result = self.owner.call(self.endpoint, 'POST', {'operation': 'query', 'method': method, 'path': 'main.typ', 'position': {'line': line, 'character': character}})
        self.assertEqual(code, 200, result)
        return result['result']

    def test_real_persistent_lsp_diagnostics_recovery_watcher_pdf_and_cleanup(self):
        result = self.live_project()
        process = self.session.process.pid
        root = self.session.root
        self.wait_status('CompileSuccess')
        self.assertIn('42', str(self.query('hover')))
        definition = self.query('definition')
        self.assertEqual(definition[0]['path'], 'main.typ')
        self.assertEqual(definition[0]['range']['start']['line'], 1)
        self.change(self.source.replace('42', '84'), 1)
        self.assertIn('84', str(self.query('hover')))
        self.assertEqual(self.session.process.pid, process)
        self.assertEqual(self.owner.call(self.base+'/file?path=main.typ')[1]['content'], self.source, 'Unsaved LSP overlays must not overwrite canonical source')
        self.change('#let greeting = [Hello]\n#greet', 2)
        completion = self.query('completion', 1, 6)
        self.assertTrue(any('greeting' in item['label'] for item in completion), completion)
        self.change('#not-a-real-function(', 3)
        failure = self.wait_status('CompileError')
        self.assertTrue(failure['diagnostics'])
        self.change(self.source, 4)
        self.wait_status('CompileSuccess')
        self.change('#old-stale-edit(', 3)
        self.assertEqual(self.session.opened['main.typ'], self.source)
        self.assertEqual(self.session.process.pid, process)
        self.assertTrue(self.query('formatting') is not None)
        self.assertEqual(self.owner.call(self.base+'/file', 'PUT', {'path': 'section.typ', 'content': '#let watched = 21', 'revision': 0})[0], 200)
        self.owner.call(self.endpoint)  # Synchronize the saved dependency into the watched directory.
        self.change('#import "section.typ": watched\n#let answer = watched\nThe answer is #answer.', 5)
        deadline = time.monotonic()+15
        while time.monotonic() < deadline and '21' not in str(self.query('hover')):
            time.sleep(.1)
        self.assertIn('21', str(self.query('hover')))
        self.assertEqual(self.owner.call(self.base+'/file', 'PUT', {'path': 'section.typ', 'content': '#let watched = 22', 'revision': 1})[0], 200)
        self.owner.call(self.endpoint)
        deadline = time.monotonic()+15
        while time.monotonic() < deadline and '22' not in str(self.query('hover')):
            time.sleep(.1)
        self.assertIn('22', str(self.query('hover')), 'A saved imported file must invalidate the persistent compiler cache')
        self.assertEqual(self.session.process.pid, process)
        # Bulk deletion closes overlays and removes dependencies from the mirror.
        self.session.change('section.typ','#let watched = 22',1)
        revision = self.owner.call(self.base)[1]['revision']
        self.assertEqual(self.owner.call(self.base+'/delete-files','POST',{'paths':['section.typ'],'revision':revision})[0],200)
        self.owner.call(self.endpoint)
        self.assertNotIn('section.typ',self.session.files)
        self.assertNotIn('section.typ',self.session.opened)
        self.assertFalse((root/'section.typ').exists())
        self.change(self.source,6);self.wait_status('CompileSuccess')
        self.assertEqual(self.session.process.pid,process)
        html = self.owner.call(result['preview'])
        self.assertEqual(html[0], 200)
        self.assertIn('window.WebSocket=class', html[1].decode())
        self.assertIn(self.endpoint, html[1].decode())
        self.assertEqual(self.owner.call(self.base+'/compile', 'POST', {})[1]['success'], True)
        self.assertTrue(self.owner.call(self.base+'/pdf')[1].startswith(b'%PDF'))
        self.assertEqual(self.owner.call(self.endpoint, 'DELETE', {})[0], 200)
        self.assertFalse(root.exists())
        self.assertIsNotNone(self.session.process.poll())
        self.assertEqual(self.owner.call(self.endpoint)[0], 404)

    def test_live_session_authorization_method_paths_and_crash_recovery(self):
        self.live_project()
        self.assertEqual(test_app.Client(self.port).call(self.endpoint)[0], 401)
        viewer, _ = self.invite('viewer')
        self.assertEqual(viewer.call(self.base+'/typst', 'POST', {})[0], 403)
        self.assertEqual(viewer.call(self.endpoint)[0], 403)
        editor, _ = self.invite('editor', 'editor@example.test')
        self.assertEqual(editor.call(self.endpoint)[0], 404)
        upgrade = {'Upgrade': 'websocket', 'Connection': 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='}
        self.assertEqual(self.owner.call(self.endpoint+'/preview/', origin='https://evil.test', extra_headers=upgrade)[0], 403)
        self.assertEqual(self.owner.call(self.endpoint, 'POST', {'operation': 'change'}, origin='https://evil.test')[0], 403)
        self.assertEqual(self.owner.call(self.endpoint, 'POST', {'operation': 'change', 'path': '../escape.typ', 'content': 'x', 'sequence': 1})[0], 400)
        self.assertEqual(self.owner.call(self.endpoint, 'POST', {'operation': 'query', 'method': 'workspace/executeCommand', 'path': 'main.typ'})[0], 400)
        self.assertEqual(self.owner.call(self.endpoint, 'POST', {'operation': 'query', 'method': 'hover', 'path': 'main.typ', 'position': {'line': -1, 'character': 0}})[0], 400)
        self.assertEqual(self.owner.call(self.endpoint, 'POST', {'operation': 'change', 'path': 'main.typ', 'content': 'x'*(8*1024*1024+1), 'sequence': 1})[0], 413)
        second = self.owner.call(self.base+'/typst', 'POST', {})
        self.assertEqual(second[0], 200, second)
        self.assertEqual(self.owner.call(self.base+'/typst', 'POST', {})[0], 429)
        self.assertEqual(self.owner.call(self.base+'/typst/'+second[1]['id'], 'DELETE', {})[0], 200)
        self.session.process.terminate()
        self.session.process.wait(timeout=5)
        self.assertEqual(self.owner.call(self.endpoint)[0], 503)
        self.assertEqual(self.owner.call(self.endpoint, 'DELETE', {})[0], 200)
        new = self.owner.call(self.base+'/typst', 'POST', {})
        self.assertEqual(new[0], 200, new)
        self.assertNotEqual(new[1]['id'], self.session.id)
        self.app.typst.close()
        self.assertEqual(self.owner.call(self.base+'/typst', 'POST', {})[0], 503, 'Shutdown must not admit a replacement worker')
