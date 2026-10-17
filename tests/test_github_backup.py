import base64
import copy
import json
import unittest

from core import Problem, pack_zip, unpack_zip
from github_backup import MANIFEST, backup_snapshot, blob_sha, destination


class FakeGitHub:
    """Model blobs, a branch and atomic ref updates without network/credentials."""
    def __init__(self, files=None, empty=False):
        self.blobs = {}
        self.entries = {}
        self.calls = []
        self.head = 'old-head'
        self.pending = None
        self.truncated = False
        self.race = False
        self.empty = empty
        for path, data in (files or {'README.md': b'Keep this unrelated file'}).items():
            sha = blob_sha(data)
            self.blobs[sha] = data
            self.entries[path] = {'path': path, 'mode': '100644', 'type': 'blob', 'sha': sha}

    def call(self, path, method='GET', data=None):
        self.calls.append((path, method, copy.deepcopy(data)))
        if path == '/repos/example/papers': return {'default_branch': 'main', 'size': 0 if self.empty else 1}
        if '/branches?per_page=1' in path: return [] if self.empty else [{'ref': 'refs/heads/main'}]
        if '/contents/' in path and method == 'PUT':
            name = path.split('/contents/', 1)[1]
            content = base64.b64decode(data['content'])
            sha = blob_sha(content)
            self.blobs[sha] = content
            self.entries[name] = {'path': name, 'mode': '100644', 'type': 'blob', 'sha': sha}
            self.empty = False
            return {}
        if '/git/ref/' in path: return {'object': {'sha': self.head}}
        if '/git/commits/' in path: return {'tree': {'sha': 'tree-sha'}}
        if '/git/trees/' in path: return {'tree': list(self.entries.values()), 'truncated': self.truncated}
        if '/git/blobs/' in path:
            sha = path.rsplit('/', 1)[1]
            return {'content': base64.b64encode(self.blobs[sha]).decode()}
        if path.endswith('/git/blobs'):
            content = base64.b64decode(data['content'])
            sha = blob_sha(content)
            self.blobs[sha] = content
            return {'sha': sha}
        if path.endswith('/git/trees'):
            self.pending = copy.deepcopy(self.entries)
            for change in data['tree']:
                if change['sha'] is None: self.pending.pop(change['path'])
                else: self.pending[change['path']] = change
            return {'sha': 'new-tree'}
        if path.endswith('/git/commits'): return {'sha': 'new-head'}
        if '/git/refs/' in path:
            assert data['force'] is False
            if self.race: raise Problem('Concurrent push', 502)
            self.entries = self.pending
            self.head = data['sha']
            return {}
        raise AssertionError((path, method))


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.project = {'id': 'a'*24, 'name': 'A paper', 'main': 'main.typ'}
        self.files = {'main.typ': b'= Hello', 'figure.png': b'\x89PNG\0binary'}
        self.target = {'repository': 'example/papers', 'branch': ''}

    def test_shared_and_separate_layout_binary_data_noop_and_preservation(self):
        for shared in (True, False):
            with self.subTest(shared=shared):
                client = FakeGitHub()
                result = backup_snapshot(client, self.target, self.project, self.files, shared)
                self.assertTrue(result['changed'])
                prefix = 'projects/' + self.project['id'] + '/' if shared else ''
                self.assertIn(prefix + 'main.typ', client.entries)
                self.assertEqual(client.blobs[client.entries[prefix + 'figure.png']['sha']], self.files['figure.png'])
                self.assertIn('README.md', client.entries)
                count = len([c for c in client.calls if c[1] == 'POST'])
                self.assertFalse(backup_snapshot(client, self.target, self.project, self.files, shared)['changed'])
                self.assertEqual(count, len([c for c in client.calls if c[1] == 'POST']))

    def test_renames_and_deletions_are_bounded_to_project(self):
        client = FakeGitHub()
        backup_snapshot(client, self.target, self.project, self.files)
        other = {**self.project, 'id': 'b'*24}
        backup_snapshot(client, self.target, other, {'main.typ': b'Other project'})
        backup_snapshot(client, self.target, self.project, {'renamed.typ': b'= Hello'})
        self.assertNotIn('projects/' + self.project['id'] + '/main.typ', client.entries)
        self.assertIn('projects/' + self.project['id'] + '/renamed.typ', client.entries)
        self.assertIn('projects/' + other['id'] + '/main.typ', client.entries)
        self.assertIn('README.md', client.entries)

    def test_existing_files_and_other_project_manifests_are_not_adopted(self):
        for files in ({'main.typ': b'Existing user file'}, {MANIFEST: json.dumps({'project_id': 'other', 'files': []}).encode()}):
            client = FakeGitHub(files)
            with self.assertRaises(Problem): backup_snapshot(client, self.target, self.project, self.files, False)
            self.assertFalse(any(c[1] in ('POST', 'PATCH') for c in client.calls))

    def test_empty_repository_is_initialized(self):
        client = FakeGitHub(empty=True)
        self.assertTrue(backup_snapshot(client, self.target, self.project, self.files)['changed'])
        self.assertTrue(any('/contents/' in c[0] for c in client.calls))

    def test_truncated_trees_and_concurrent_push_fail_without_force(self):
        client = FakeGitHub()
        client.truncated = True
        with self.assertRaises(Problem): backup_snapshot(client, self.target, self.project, self.files)
        self.assertFalse(any(c[1] != 'GET' for c in client.calls))
        client = FakeGitHub()
        client.race = True
        with self.assertRaises(Problem): backup_snapshot(client, self.target, self.project, self.files)
        self.assertEqual(client.head, 'old-head')
        self.assertNotIn('projects/' + self.project['id'] + '/main.typ', client.entries)

    def test_backup_archive_restores_without_adopting_old_metadata(self):
        marker = json.dumps({'version': 1, 'project_id': self.project['id'], 'files': sorted(self.files)}).encode()
        restored = unpack_zip(pack_zip({**self.files, MANIFEST: marker}))
        self.assertEqual(restored, self.files)
        self.assertIn(MANIFEST, unpack_zip(pack_zip({'main.typ': b'hello', MANIFEST: b'User JSON file'})))

    def test_destination_validation(self):
        self.assertEqual(destination({'repository': 'https://github.com/example/papers.git'})['repository'], 'example/papers')
        for repo in ('https://evil.test/x', '../other', 'owner/repo/extra', 'owner/repo?token=x'):
            with self.assertRaises(Problem): destination({'repository': repo})
        for branch in ('../main', 'foo//bar', 'main.lock', 'main?x'):
            with self.assertRaises(Problem): destination({'repository': 'example/papers', 'branch': branch})


if __name__ == '__main__': unittest.main()
