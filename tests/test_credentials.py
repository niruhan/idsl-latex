from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from credential_store import FileTokenStore
from server import App
import test_app
from test_app import Client


class CredentialTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    invite = test_app.AppTests.invite
    lab_signup = test_app.AppTests.lab_signup

    def test_saved_token_survives_restart_and_is_account_scoped(self):
        endpoint = '/api/github-token'
        secret = 'test-only-credential-never-issued'
        self.assertEqual(Client(self.port).call(endpoint)[0], 401)
        self.assertFalse(self.owner.call(endpoint)[1]['saved'])
        code, metadata = self.owner.call(endpoint, 'PUT', {'token': secret})
        self.assertEqual(code, 200)
        self.assertTrue(metadata['saved'])
        self.assertNotIn(secret, str(metadata))
        with self.app.db() as db:
            user = dict(db.execute('SELECT * FROM users').fetchone())
            self.assertNotIn(secret, '\n'.join(db.iterdump()))
        path = self.app.tokens.path(user['id'])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        restarted = App(self.tmp.name, self.app.origin)
        restarted.tokens = FileTokenStore(path.parent)
        self.assertEqual(restarted.backup_token(user, None), secret)
        member, _ = self.invite('viewer')
        self.assertFalse(member.call(endpoint)[1]['saved'])
        self.assertEqual(member.call(endpoint, 'DELETE', {})[0], 200)
        self.assertTrue(self.owner.call(endpoint)[1]['saved'])
        self.assertEqual(self.owner.call(endpoint, 'PUT', {'token': secret}, origin='https://evil.test')[0], 403)
        with patch('server.backup_snapshot') as snapshot:
            snapshot.return_value = {'changed': True, 'repository': 'example/documents', 'commit': 'a'*40, 'url': 'https://github.com/example/documents/commit/'+'a'*40}
            self.owner.call('/api/backup-settings', 'PUT', {'repository': 'example/documents'})
            self.assertEqual(self.owner.call(self.base+'/backup', 'POST', {})[0], 200)
            self.assertEqual(snapshot.call_args.args[0].token, secret)
            self.assertEqual(self.owner.call('/api/backups', 'POST', {'sharedOnly': True})[0], 200)
            self.assertEqual(snapshot.call_args.args[0].token, secret)
            self.assertEqual(member.call(self.base+'/backup', 'POST', {})[0], 403)
        self.assertEqual(self.owner.call(endpoint, 'DELETE', {})[1]['saved'], False)
        self.assertFalse(path.exists())
        self.assertEqual(self.owner.call(self.base+'/backup', 'POST', {})[0], 400)

    def test_validation_rejects_invalid_credentials_without_changing_saved_token(self):
        for value in (None, '', 'short', 'test\nheader-value', 'x'*513, {}, 'test value with spaces'):
            self.assertEqual(self.owner.call('/api/github-token', 'PUT', {'token': value})[0], 400)
        self.assertFalse(self.owner.call('/api/github-token')[1]['saved'])
        with tempfile.TemporaryDirectory() as directory:
            store = FileTokenStore(Path(directory)/'credentials')
            for value in ('../account', 'demo', '', None):
                with self.assertRaises(Exception): store.get(value)
            self.assertFalse(store.directory.exists())
