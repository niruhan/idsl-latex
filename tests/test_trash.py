import time
import unittest
from unittest.mock import patch

import test_app
from server import App, TRASH_RETENTION


class TrashTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    invite = test_app.AppTests.invite
    lab_signup = test_app.AppTests.lab_signup

    def test_owner_only_trash_restore_and_project_access(self):
        editor, _ = self.invite('editor')
        self.assertEqual(editor.call(self.base, 'DELETE', {})[0], 403)
        self.assertEqual(self.owner.call(self.base + '/file', 'PUT', {'path':'main.tex','revision':1,'content':'Saved before Trash'})[0], 200)
        original = self.owner.call(self.base + '/file?path=main.tex')[1]
        history = self.owner.call(self.base + '/history?path=main.tex')[1]
        self.assertTrue(history['versions'])
        self.assertEqual(self.owner.call(self.base, 'DELETE', {})[0], 200)
        self.assertEqual(self.owner.call('/api/projects')[1]['projects'], [])
        trashed = self.owner.call('/api/trash')[1]['projects'][0]
        self.assertEqual(trashed['id'], self.pid)
        self.assertAlmostEqual(trashed['expires'] - trashed['deleted'], TRASH_RETENTION)
        self.assertEqual(editor.call('/api/trash')[1]['projects'], [])
        for client in (self.owner, editor):
            for suffix in ('', '/file?path=main.tex', '/history?path=main.tex', '/source.zip', '/pdf'):
                self.assertEqual(client.call(self.base + suffix)[0], 404)
            for suffix in ('/compile', '/typst', '/backup'):
                self.assertEqual(client.call(self.base + suffix, 'POST', {})[0], 404)
        for method in ('POST', 'DELETE'):
            self.assertEqual(editor.call('/api/trash/' + self.pid, method, {})[0], 404)
        self.assertEqual(self.owner.call('/api/trash/' + self.pid, 'POST', {}, origin='https://example.test')[0], 403)
        self.assertEqual(test_app.Client(self.port).call('/api/trash')[0], 401)
        self.assertEqual(self.owner.call('/api/trash/' + self.pid, 'POST', {})[0], 200)
        self.assertEqual(self.owner.call(self.base + '/file?path=main.tex')[1], original)
        self.assertEqual(self.owner.call(self.base + '/history?path=main.tex')[1], history)
        self.assertEqual(editor.call(self.base)[1]['role'], 'editor')

    def test_permanent_delete_confirms_target_and_clears_related_state(self):
        project = self.owner.call(self.base)[1]
        self.assertEqual(self.owner.call(self.base + '/file', 'PUT', {'path':'main.tex', 'content':'Updated', 'revision':1})[0], 200)
        self.assertEqual(self.owner.call(self.base, 'DELETE', {})[0], 200)
        endpoint = '/api/trash/' + self.pid
        self.assertEqual(self.owner.call(endpoint, 'DELETE', {'name':'Wrong name'})[0], 409)
        self.assertEqual(len(self.owner.call('/api/trash')[1]['projects']), 1)
        self.assertEqual(self.owner.call(endpoint, 'DELETE', {'name':project['name']})[0], 200)
        self.assertEqual(self.owner.call(endpoint, 'POST', {})[0], 404)
        with self.app.db() as db:
            for table in ('files','history','members','invites','builds','project_backups','shared_project_backups','project_locations','project_trash'):
                self.assertEqual(db.execute('SELECT COUNT(*) FROM '+table+' WHERE project_id=?', (self.pid,)).fetchone()[0], 0)
            self.assertIsNone(db.execute('SELECT 1 FROM projects WHERE id=?', (self.pid,)).fetchone())

    def test_expiry_purge_is_persistent_and_never_restores_expired_projects(self):
        other = self.owner.call('/api/projects', 'POST', {'name':'Keep in Trash', 'template':False})[1]['id']
        self.owner.call(self.base, 'DELETE', {})
        self.owner.call('/api/projects/' + other, 'DELETE', {})
        with self.app.db() as db:
            db.execute('UPDATE project_trash SET deleted=? WHERE project_id=?', (time.time()-TRASH_RETENTION-1, self.pid))
        self.assertEqual(self.owner.call('/api/trash/' + self.pid, 'POST', {})[0], 404)
        self.assertEqual([row['id'] for row in self.owner.call('/api/trash')[1]['projects']], [other])
        upgraded = App(self.tmp.name, self.app.origin)
        upgraded.typst.close()
        with self.app.db() as db:
            self.assertIsNone(db.execute('SELECT 1 FROM projects WHERE id=?', (self.pid,)).fetchone())
        self.assertEqual(self.owner.call('/api/trash/' + other, 'POST', {})[0], 200)

    def test_folder_restore_fallback_quota_and_background_cleanup(self):
        folder = self.owner.call('/api/project-folders', 'POST', {'name':'Old folder'})[1]['id']
        self.owner.call(self.base + '/folder', 'PUT', {'folder':folder})
        name = self.owner.call(self.base)[1]['name']
        self.owner.call(self.base, 'DELETE', {})
        with patch('server.MAX_OWNED_PROJECTS', 1):
            self.assertEqual(self.owner.call('/api/projects', 'POST', {'name':'Over limit'})[0], 413)
        self.assertEqual(self.owner.call('/api/project-folders/' + folder, 'DELETE', {})[0], 200)
        self.owner.call('/api/trash/' + self.pid, 'POST', {})
        self.assertIsNone(self.owner.call('/api/projects')[1]['projects'][0]['folder'])
        self.owner.call(self.base, 'DELETE', {})
        with self.app.db() as db:
            db.execute('UPDATE project_trash SET deleted=0 WHERE project_id=?', (self.pid,))
        self.app.trash_checked=0
        self.server.service_actions()
        self.assertEqual(self.owner.call('/api/trash')[1]['projects'], [])
        self.assertEqual(self.owner.call('/api/trash/' + self.pid, 'DELETE', {'name':name})[0], 404)

    def test_trash_stops_live_workers_and_is_excluded_from_bulk_backups(self):
        with patch.object(self.app.typst, 'discard') as discard:
            self.owner.call(self.base, 'DELETE', {})
            discard.assert_called_once_with(pid=self.pid)
        with patch.object(self.app, 'backup_token', return_value='test-only'), patch('server.GitHub'), patch.object(self.app, 'backup') as backup:
            self.assertEqual(self.owner.call('/api/backups', 'POST', {})[1]['results'], [])
            backup.assert_not_called()


if __name__ == '__main__': unittest.main()
