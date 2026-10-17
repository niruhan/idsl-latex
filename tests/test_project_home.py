import unittest

import test_app
from core import TYPST_SAMPLE


class ProjectHomeTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    lab_signup = test_app.AppTests.lab_signup
    invite = test_app.AppTests.invite

    def sample(self, client=None, **options):
        status, result = (client or self.owner).call('/api/sample-project', 'POST', options)
        self.assertEqual(status, 200, result)
        return result

    def test_sample_is_private_editable_and_created_only_once(self):
        before = self.owner.call('/api/projects')[1]['projects']
        sample = self.sample()
        self.assertTrue(sample['created'])
        base = '/api/projects/' + sample['id']
        project = self.owner.call(base)[1]
        self.assertEqual(project['name'], 'Getting started with Typst')
        self.assertEqual(project['main'], 'main.typ')
        self.assertEqual(project['role'], 'owner')
        self.assertEqual({f['path'] for f in project['files']}, set(TYPST_SAMPLE))
        self.owner.call(base + '/file', 'PUT', {'path': 'main.typ', 'revision': 1, 'content': '= My edited sample'})
        self.assertEqual(self.sample()['id'], sample['id'])
        self.assertEqual(self.owner.call(base + '/file?path=main.typ')[1]['content'], '= My edited sample')
        self.assertEqual(len(self.owner.call('/api/projects')[1]['projects']), len(before) + 1)
        self.assertEqual(self.owner.call(self.base + '/file?path=main.tex')[1]['content'].encode(), test_app.SAMPLE['main.tex'])
        member, _ = self.invite('editor')
        self.assertEqual(member.call(base)[0], 404)
        members_sample = self.sample(member)
        self.assertNotEqual(members_sample['id'], sample['id'])
        self.assertEqual(self.owner.call('/api/projects/' + members_sample['id'])[0], 404)

    def test_deleted_sample_is_only_recreated_on_request(self):
        sample = self.sample()
        self.assertEqual(self.owner.call('/api/projects/' + sample['id'], 'DELETE', {})[0], 200)
        self.assertIsNone(self.sample()['id'])
        replacement = self.sample(recreate=True)
        self.assertNotEqual(replacement['id'], sample['id'])
        self.assertEqual(self.sample()['id'], replacement['id'])

    def test_sample_respects_project_quota(self):
        owner_id=self.owner.call('/api/session')[1]['user']['id']
        with self.app.db() as db:
            for number in range(24):
                self.app.new_project(db, owner_id, 'Paper ' + str(number), {'main.typ': b'= A paper'})
        result = self.sample()
        self.assertIsNone(result['id'])
        self.assertTrue(result['limitReached'])
        self.assertEqual(len(self.owner.call('/api/projects')[1]['projects']), 25)

    def test_sample_requires_an_authenticated_same_origin_request(self):
        self.assertEqual(test_app.Client(self.port).call('/api/sample-project', 'POST', {})[0], 401)
        self.assertEqual(self.owner.call('/api/sample-project', 'POST', {}, origin='https://example.test')[0], 403)


if __name__ == '__main__': unittest.main()
