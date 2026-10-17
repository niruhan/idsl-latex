import base64
import io
import os
import unittest
import zipfile
from unittest.mock import patch

import test_app
from core import TYPST_SAMPLE, compile_project, main_document


class TypstTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    lab_signup = test_app.AppTests.lab_signup
    invite = test_app.AppTests.invite

    def create(self, **options):
        status, result = self.owner.call('/api/projects', 'POST', {'name': 'Typst paper', 'format': 'typst', **options})
        self.assertEqual(status, 200, result)
        return '/api/projects/' + result['id']

    def test_typst_creation_import_and_main_selection(self):
        base = self.create()
        project = self.owner.call(base)[1]
        self.assertEqual(project['main'], 'main.typ')
        self.assertEqual({f['path'] for f in project['files']}, set(TYPST_SAMPLE))
        self.assertEqual(self.owner.call(base, 'PUT', {'main': 'sections/introduction.typ'})[0], 200)
        self.assertEqual(self.owner.call(base, 'PUT', {'main': 'references.bib'})[0], 400)
        self.assertEqual(self.owner.call('/api/projects', 'POST', {'format': 'unknown'})[0], 400)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('paper/chapters/chapter.typ', '= Imported\n\nHello.')
        result = self.owner.call('/api/projects', 'POST', {'name': 'Imported', 'zip': base64.b64encode(archive.getvalue()).decode()})[1]
        self.assertEqual(self.owner.call('/api/projects/' + result['id'])[1]['main'], 'chapters/chapter.typ')
        self.assertEqual(main_document({'main.typ': b'', 'other.tex': b''}), 'main.typ')

    @unittest.skipUnless(os.getenv('TYPST_BIN'), 'Configure TYPST_BIN for real Typst compilation')
    def test_typst_pdf_includes_diagnostics_and_failed_build_clears_pdf(self):
        base = self.create()
        status, result = self.owner.call(base + '/compile', 'POST', {})
        self.assertEqual(status, 200)
        self.assertTrue(result['success'], result.get('log'))
        self.assertEqual(result['engine'], 'typst')
        self.assertTrue(self.owner.call(base + '/pdf')[1].startswith(b'%PDF'))
        self.owner.call(base + '/file', 'PUT', {'path': 'main.typ', 'revision': 1, 'content': '#unknown-function()'})
        result = self.owner.call(base + '/compile', 'POST', {})[1]
        self.assertFalse(result['success'])
        self.assertIn('main.typ:1:', result['log'])
        self.assertEqual(self.owner.call(base + '/pdf')[0], 404)
        self.owner.call(base + '/file', 'PUT', {'path': 'main.typ', 'revision': 2, 'content': '= Recovered\n\nHello.'})
        self.assertTrue(self.owner.call(base + '/compile', 'POST', {})[1]['success'])

    @unittest.skipUnless(os.getenv('TYPST_BIN'), 'Configure TYPST_BIN for real Typst compilation')
    def test_typst_root_blocks_host_file_reads_and_supports_nested_main(self):
        result = compile_project({'main.typ': b'#read("/etc/passwd")'}, 'main.typ')
        self.assertFalse(result['success'])
        result = compile_project({'chapters/main.typ': b'#include "../text.typ"', 'text.typ': b'= Nested project\n\nHello.'}, 'chapters/main.typ')
        self.assertTrue(result['success'], result['log'])

    def test_backup_settings_account_isolation_and_source_only_snapshot(self):
        self.assertEqual(self.owner.call('/api/backup-settings', 'PUT', {'repository': 'example/research'})[0], 200)
        self.assertEqual(self.owner.call(self.base + '/backup-settings', 'PUT', {'mode': 'separate', 'repository': 'example/paper'})[0], 200)
        with patch('server.backup_snapshot', return_value={'changed': True, 'commit': 'a'*40, 'url': 'https://github.com/example/paper/commit/'+'a'*40}) as snapshot:
            status, result = self.owner.call(self.base + '/backup', 'POST', {'token': 'test-token-in-memory'})
            self.assertEqual(status, 200, result)
            args = snapshot.call_args.args
            self.assertEqual(args[1]['repository'], 'example/paper')
            self.assertFalse(args[4])
            self.assertEqual(set(args[3]), set(test_app.SAMPLE))
            self.assertNotIn('password', args[2])
        settings = self.owner.call(self.base + '/backup-settings')[1]
        self.assertEqual(settings['last_commit'], 'a'*40)
        self.assertNotIn('test-token', str(settings))
        with self.app.db() as db:
            all_text = '\n'.join(db.iterdump())
            self.assertNotIn('test-token-in-memory', all_text)
        outsider = test_app.Client(self.port)
        self.assertEqual(outsider.call(self.base + '/backup', 'POST', {'token': 'test-token-in-memory'})[0], 401)
        self.assertEqual(outsider.call('/api/backup-settings')[0], 401)

    def test_backup_is_owner_only_and_defaults_are_per_account(self):
        editor, _ = self.invite('editor')
        self.owner.call('/api/backup-settings', 'PUT', {'repository': 'example/owners-documents'})
        self.assertEqual(editor.call('/api/backup-settings')[1]['repository'], '')
        self.assertEqual(editor.call(self.base + '/backup-settings')[0], 403)
        with patch('server.backup_snapshot') as snapshot:
            self.assertEqual(editor.call(self.base + '/backup', 'POST', {'token': 'test-token-in-memory'})[0], 403)
            snapshot.assert_not_called()

    def test_backup_batch_only_owns_projects_and_reports_failures(self):
        self.create()
        with patch.object(self.app, 'backup', side_effect=[{'commit': 'a'*40}, test_app.Problem('No destination')]) as backup:
            status, result = self.owner.call('/api/backups', 'POST', {'token': 'test-token-in-memory'})
            self.assertEqual(status, 200)
            self.assertEqual(backup.call_count, 2)
            self.assertEqual(len(result['results']), 2)
            self.assertIn('error', result['results'][1])

    def test_backup_all_to_one_repository_preserves_separate_settings_and_is_owner_only(self):
        self.create()
        self.invite('viewer')
        self.owner.call('/api/backup-settings','PUT',{'repository':'example/all-documents'})
        self.owner.call(self.base+'/backup-settings','PUT',{'mode':'separate','repository':'example/separate'})
        before=self.owner.call(self.base+'/backup-settings')[1]
        with patch('server.backup_snapshot',return_value={'changed':True,'commit':'a'*40,'url':'https://github.com/example/all-documents/commit/'+'a'*40}) as snapshot:
            status,result=self.owner.call('/api/backups','POST',{'token':'test-token-in-memory','sharedOnly':True})
        self.assertEqual(status,200,result)
        owned={p['id'] for p in self.owner.call('/api/projects')[1]['projects'] if p['role']=='owner'}
        self.assertEqual({item['id'] for item in result['results']},owned)
        self.assertEqual(snapshot.call_count,len(owned))
        for call in snapshot.call_args_list:
            self.assertEqual(call.args[1]['repository'],'example/all-documents')
            self.assertTrue(call.args[4])
        self.assertEqual(self.owner.call(self.base+'/backup-settings')[1],before)
        self.assertEqual(self.owner.call('/api/backups','POST',{'token':'test-token-in-memory','sharedOnly':'yes'})[0],400)
        with self.app.db() as db:self.assertNotIn('test-token-in-memory','\n'.join(db.iterdump()))

    def test_bulk_shared_repository_is_bound_before_network_requests(self):
        self.create()
        self.owner.call('/api/backup-settings','PUT',{'repository':'example/original'})
        calls=[]
        def snapshot(client,target,project,files,shared):
            calls.append(target['repository'])
            self.owner.call('/api/backup-settings','PUT',{'repository':'example/changed-during-backup'})
            return {'changed':True,'commit':'b'*40,'url':'https://github.com/example/original/commit/'+'b'*40}
        with patch('server.backup_snapshot',side_effect=snapshot):
            status,result=self.owner.call('/api/backups','POST',{'token':'test-token-in-memory','sharedOnly':True})
        self.assertEqual(status,200,result)
        self.assertEqual(calls,['example/original']*2)


if __name__ == '__main__': unittest.main()
