import unittest
from unittest.mock import patch

import test_app
from core import Problem
from server import App


class ProjectBackupStatusTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    invite = test_app.AppTests.invite
    lab_signup = test_app.AppTests.lab_signup

    def configure(self):
        self.owner.call('/api/backup-settings', 'PUT', {'repository': 'example/all-documents', 'branch': 'archive'})
        self.owner.call(self.base+'/backup-settings', 'PUT', {'mode': 'separate', 'repository': 'example/one-paper'})
        self.owner.call('/api/github-token', 'PUT', {'token': 'test-only-backup-status-credential'})

    def snapshot(self, client, target, project, files, shared):
        return {'changed': True, 'commit': 'a'*40, 'url': 'https://github.com/'+target['repository']+'/commit/'+'a'*40,
                'repository': target['repository'], 'branch': target['branch'], 'folder': 'projects/A paper' if shared else ''}

    def status(self):
        code, value = self.owner.call(self.base+'/backup-settings')
        self.assertEqual(code, 200)
        return value

    def test_editor_updates_only_open_project_in_shared_repo_preserving_separate_destination(self):
        self.configure()
        self.owner.call('/api/projects', 'POST', {'name': 'Unrelated paper', 'template': False})
        self.assertTrue(self.status()['global_backup']['included'])
        self.assertIsNone(self.status()['global_backup']['snapshot'])
        with patch('server.backup_snapshot', side_effect=self.snapshot) as snapshot:
            code, result = self.owner.call(self.base+'/backup', 'POST', {'sharedOnly': True})
            self.assertEqual(code, 200, result)
            self.assertEqual(snapshot.call_count, 1)
            args = snapshot.call_args.args
            self.assertEqual(args[1]['repository'], 'example/all-documents')
            self.assertEqual(args[2]['id'], self.pid)
            self.assertTrue(args[4])
            status = self.status()
            self.assertEqual((status['mode'], status['repository'], status['last_commit']), ('separate', 'example/one-paper', None))
            self.assertFalse(status['global_backup']['stale'])
            self.assertEqual(status['global_backup']['snapshot']['folder'], 'projects/A paper')
            self.assertEqual(status['global_backup']['snapshot']['last_revision'], args[2]['revision'])
            self.assertEqual(self.owner.call(self.base+'/backup', 'POST', {})[0], 200)
            self.assertEqual(snapshot.call_args.args[1]['repository'], 'example/one-paper')
            self.assertFalse(snapshot.call_args.args[4])
        with self.app.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM shared_project_backups').fetchone()[0], 1)
        current = self.owner.call(self.base+'/file?path=main.tex')[1]
        self.owner.call(self.base+'/file', 'PUT', {'path': 'main.tex', 'content': current['content']+'\n% New saved change', 'revision': current['revision']})
        self.assertTrue(self.status()['global_backup']['stale'])
        restarted = App(self.tmp.name, self.app.origin)
        with restarted.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM shared_project_backups').fetchone()[0], 1)

    def test_bulk_shared_backups_record_membership_for_separate_projects_and_cleanup(self):
        self.configure()
        self.owner.call('/api/projects', 'POST', {'name': 'Another paper', 'template': False})
        with patch('server.backup_snapshot', side_effect=self.snapshot) as snapshot:
            code, result = self.owner.call('/api/backups', 'POST', {'sharedOnly': True})
            self.assertEqual(code, 200, result)
            self.assertEqual(snapshot.call_count, 2)
        self.assertFalse(self.status()['global_backup']['stale'])
        self.assertEqual(self.status()['repository'], 'example/one-paper')
        self.assertEqual(self.owner.call(self.base, 'DELETE', {})[0], 200)
        with self.app.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM shared_project_backups WHERE project_id=?', (self.pid,)).fetchone()[0], 0)

    def test_failure_and_changed_destination_do_not_report_a_current_global_backup(self):
        self.configure()
        with patch('server.backup_snapshot', side_effect=Problem('Test backup failure', 502)):
            self.assertEqual(self.owner.call(self.base+'/backup', 'POST', {'sharedOnly': True})[0], 502)
        self.assertIsNone(self.status()['global_backup']['snapshot'])
        with patch('server.backup_snapshot', side_effect=self.snapshot):
            self.assertEqual(self.owner.call(self.base+'/backup', 'POST', {'sharedOnly': True})[0], 200)
        self.owner.call('/api/backup-settings', 'PUT', {'repository': 'example/new-documents'})
        self.assertTrue(self.status()['global_backup']['stale'])
        self.assertIsNone(self.status()['global_backup']['snapshot'])
        self.owner.call('/api/backup-settings', 'PUT', {'repository': 'example/all-documents', 'branch': 'other-branch'})
        self.assertIsNone(self.status()['global_backup']['snapshot'])
        self.owner.call('/api/backup-settings', 'PUT', {'repository': 'example/all-documents', 'branch': 'archive'})
        self.assertFalse(self.status()['global_backup']['stale'])

    def test_permissions_validation_and_legacy_snapshot_migration(self):
        self.assertFalse(self.status()['global_backup']['included'])
        with patch('server.backup_snapshot') as snapshot:
            self.assertEqual(self.owner.call(self.base+'/backup', 'POST', {'sharedOnly': True})[0], 400)
            self.assertEqual(self.owner.call(self.base+'/backup', 'POST', {'sharedOnly': 'all'})[0], 400)
            snapshot.assert_not_called()
        self.configure()
        viewer, _ = self.invite('viewer')
        self.assertEqual(viewer.call(self.base+'/backup-settings')[0], 403)
        self.assertEqual(viewer.call(self.base+'/backup', 'POST', {'sharedOnly': True})[0], 403)
        with self.app.db() as db:
            db.execute("UPDATE project_backups SET mode='shared',last_commit=?,last_url=?,last_revision=1 WHERE project_id=?", ('b'*40, 'https://github.com/example/all-documents/commit/'+'b'*40, self.pid))
        upgraded = App(self.tmp.name, self.app.origin)
        status = self.status()['global_backup']
        self.assertEqual(status['snapshot']['last_commit'], 'b'*40)
        self.assertTrue(status['stale'], 'Legacy snapshots do not establish current branch verification')
        self.assertEqual(status['snapshot']['updated'], 0)
        upgraded.typst.close()
