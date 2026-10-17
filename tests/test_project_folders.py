import unittest

import test_app
from server import App


class ProjectFolderTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    lab_signup = test_app.AppTests.lab_signup
    invite = test_app.AppTests.invite

    def create(self, name, parent=None, client=None):
        status, result = (client or self.owner).call('/api/project-folders', 'POST', {'name': name, 'parent': parent})
        self.assertEqual(status, 200, result)
        return result['id']

    def folders(self, client=None):
        return (client or self.owner).call('/api/project-folders')[1]['folders']

    def location(self, pid, client=None):
        return next(project['folder'] for project in (client or self.owner).call('/api/projects')[1]['projects'] if project['id'] == pid)

    def test_nested_folders_rename_and_empty_only_deletion_preserve_source(self):
        before = self.owner.call(self.base)[1]
        parent = self.create('Research')
        child = self.create('Papers', parent)
        self.assertEqual(self.owner.call('/api/project-folders/' + child, 'PUT', {'name': 'Reports'})[0], 200)
        self.assertEqual(self.owner.call(self.base + '/folder', 'PUT', {'folder': child})[0], 200)
        self.assertEqual(self.location(self.pid), child)
        self.assertEqual(self.owner.call('/api/project-folders/' + parent, 'DELETE', {})[0], 409)
        self.assertEqual(self.owner.call('/api/project-folders/' + child, 'DELETE', {})[0], 409)
        self.assertEqual(self.owner.call(self.base + '/folder', 'PUT', {'folder': None})[0], 200)
        self.assertEqual(self.owner.call('/api/project-folders/' + child, 'PUT', {'parent': None})[0], 200)
        self.assertEqual(self.owner.call('/api/project-folders/' + parent, 'DELETE', {})[0], 200)
        self.assertEqual(self.owner.call('/api/project-folders/' + child, 'DELETE', {})[0], 200)
        self.assertEqual(self.owner.call(self.base)[1], before)
        self.assertEqual(self.folders(), [])

    def test_folder_names_are_validated_and_unique_within_each_parent(self):
        parent = self.create('Research')
        first = self.create(' Café ')
        self.assertEqual(self.owner.call('/api/project-folders', 'POST', {'name': 'CAFÉ'})[0], 409)
        self.create('Café', parent)
        self.assertEqual(self.owner.call('/api/project-folders/' + first, 'PUT', {'parent': parent})[0], 409)
        for name in ('', ' ', '.', '..', 'a/b', 'a\\b', 'x' * 81, None, ['Research']):
            self.assertEqual(self.owner.call('/api/project-folders', 'POST', {'name': name})[0], 400)
        self.assertIsNone(next(folder['parent'] for folder in self.folders() if folder['id'] == first))

    def test_folders_are_private_and_viewers_can_organize_without_changing_access(self):
        owner_folder = self.create('Owner research')
        viewer, _ = self.invite('viewer')
        viewer_folder = self.create('My reading', client=viewer)
        self.assertEqual({folder['id'] for folder in self.folders()}, {owner_folder})
        self.assertEqual({folder['id'] for folder in self.folders(viewer)}, {viewer_folder})
        self.assertEqual(viewer.call('/api/project-folders/' + owner_folder, 'PUT', {'name': 'Changed'})[0], 404)
        self.assertEqual(viewer.call('/api/project-folders', 'POST', {'name': 'Private child', 'parent': owner_folder})[0], 404)
        self.assertEqual(viewer.call(self.base + '/folder', 'PUT', {'folder': owner_folder})[0], 404)
        self.assertEqual(viewer.call(self.base + '/folder', 'PUT', {'folder': viewer_folder})[0], 200)
        self.assertEqual(self.location(self.pid, viewer), viewer_folder)
        self.assertIsNone(self.location(self.pid))
        self.assertEqual(viewer.call(self.base)[1]['role'], 'viewer')
        self.assertEqual(viewer.call(self.base, 'PUT', {'name': 'Changed'})[0], 403)
        self.assertEqual(self.owner.call(self.base + '/folder', 'PUT', {'folder': owner_folder})[0], 200)
        self.assertEqual(self.location(self.pid, viewer), viewer_folder)

    def test_create_in_folder_is_atomic_and_persists_across_restart(self):
        folder = self.create('Imported work')
        status, result = self.owner.call('/api/projects', 'POST', {'name': 'A paper', 'format': 'typst', 'folder': folder})
        self.assertEqual(status, 200)
        self.assertEqual(self.location(result['id']), folder)
        count = len(self.owner.call('/api/projects')[1]['projects'])
        self.assertEqual(self.owner.call('/api/projects', 'POST', {'name': 'Invalid destination', 'folder': 'a' * 24})[0], 404)
        self.assertEqual(len(self.owner.call('/api/projects')[1]['projects']), count)
        reopened = App(self.tmp.name, f'http://127.0.0.1:{self.port}')
        with reopened.db() as db:
            self.assertEqual(db.execute('SELECT folder_id FROM project_locations WHERE project_id=?', (result['id'],)).fetchone()[0], folder)
            self.assertEqual(db.execute('SELECT content FROM files WHERE project_id=? AND path=?', (self.pid, 'main.tex')).fetchone()[0], test_app.SAMPLE['main.tex'])

    def test_cycles_depth_and_quota_are_rejected(self):
        chain = []
        for index in range(10): chain.append(self.create('Level ' + str(index), chain[-1] if chain else None))
        self.assertEqual(self.owner.call('/api/project-folders/' + chain[0], 'PUT', {'parent': chain[1]})[0], 409)
        self.assertEqual(self.owner.call('/api/project-folders/' + chain[0], 'PUT', {'parent': chain[0]})[0], 409)
        self.assertEqual(self.owner.call('/api/project-folders', 'POST', {'name': 'Too deep', 'parent': chain[-1]})[0], 400)
        other = self.create('Other')
        self.assertEqual(self.owner.call('/api/project-folders/' + chain[0], 'PUT', {'parent': other})[0], 400)
        owner = self.owner.call('/api/session')[1]['user']['id']
        with self.app.db() as db:
            for index in range(89): db.execute('INSERT INTO project_folders VALUES(?,?,?,?,?)', (f'{index + 1:024x}', owner, 'Folder ' + str(index), None, 0))
        self.assertEqual(self.owner.call('/api/project-folders', 'POST', {'name': 'Over quota'})[0], 413)

    def test_project_and_membership_deletion_clean_up_locations(self):
        viewer, _ = self.invite('viewer')
        folder = self.create('Reading', client=viewer)
        viewer.call(self.base + '/folder', 'PUT', {'folder': folder})
        viewer_id = viewer.call('/api/session')[1]['user']['id']
        self.assertEqual(self.owner.call(self.base + '/members', 'DELETE', {'userId': viewer_id})[0], 200)
        with self.app.db() as db: self.assertIsNone(db.execute('SELECT 1 FROM project_locations WHERE project_id=?', (self.pid,)).fetchone())
        owner_folder = self.create('Owned')
        self.owner.call(self.base + '/folder', 'PUT', {'folder': owner_folder})
        self.assertEqual(self.owner.call(self.base, 'DELETE', {})[0], 200)
        self.assertEqual(self.owner.call('/api/project-folders/' + owner_folder, 'DELETE', {})[0], 200)

    def test_folder_routes_require_authentication_and_same_origin(self):
        self.assertEqual(test_app.Client(self.port).call('/api/project-folders')[0], 401)
        self.assertEqual(self.owner.call('/api/project-folders', 'POST', {'name': 'Blocked'}, origin='https://example.test')[0], 403)
        self.assertEqual(self.owner.call(self.base + '/folder', 'PUT', {})[0], 400)
        self.assertEqual(self.folders(), [])


if __name__ == '__main__': unittest.main()
