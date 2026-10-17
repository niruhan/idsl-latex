import hashlib
import json
import shutil
import unittest

import test_app
from core import compile_project, main_document
from project_templates import ROOT, TEMPLATES, template_files


class TemplateTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    lab_signup = test_app.AppTests.lab_signup
    invite = test_app.AppTests.invite

    def test_catalog_is_available_without_creating_projects(self):
        before = self.owner.call('/api/projects')[1]
        self.assertEqual(self.owner.call('/api/templates')[1]['templates'], list(TEMPLATES))
        self.assertEqual(self.owner.call('/api/projects')[1], before)
        self.assertEqual(test_app.Client(self.port).call('/api/templates')[0], 401)

    def test_templates_create_independent_private_copies_in_the_selected_folder(self):
        folder = self.owner.call('/api/project-folders', 'POST', {'name': 'Starters'})[1]['id']
        viewer, _ = self.invite('viewer')
        for template in TEMPLATES:
            status, result = self.owner.call('/api/projects', 'POST', {'templateId': template['id'], 'folder': folder})
            self.assertEqual(status, 200, result)
            base = '/api/projects/' + result['id']
            project = self.owner.call(base)[1]
            _, files = template_files(template['id'])
            self.assertEqual(project['name'], template['name'])
            self.assertEqual(project['main'], main_document(files))
            self.assertEqual({file['path'] for file in project['files']}, set(files))
            self.assertEqual(viewer.call(base)[0], 404)
            self.assertEqual(next(p['folder'] for p in self.owner.call('/api/projects')[1]['projects'] if p['id'] == result['id']), folder)
            self.owner.call(base + '/file', 'PUT', {'path': project['main'], 'revision': 1, 'content': 'My own draft'})
            fresh = self.owner.call('/api/projects', 'POST', {'templateId': template['id']})[1]
            content = self.owner.call('/api/projects/' + fresh['id'] + '/file?path=' + project['main'])[1]['content']
            self.assertEqual(content.encode(), files[project['main']])
            self.assertNotEqual(fresh['id'], result['id'])

    def test_template_creation_rejects_invalid_sources_and_respects_permissions_and_quota(self):
        before = self.owner.call('/api/projects')[1]
        for value in ('../data', '/etc/passwd', 'missing', None, ['western-presentation']):
            self.assertEqual(self.owner.call('/api/projects', 'POST', {'templateId': value})[0], 400)
        self.assertEqual(self.owner.call('/api/projects', 'POST', {'templateId': 'neurips-2026', 'zip': 'AAAA'})[0], 400)
        self.assertEqual(self.owner.call('/api/projects', 'POST', {'templateId': 'neurips-2026', 'folder': 'a' * 24})[0], 404)
        self.assertEqual(self.owner.call('/api/projects', 'POST', {'templateId': 'neurips-2026'}, origin='https://example.test')[0], 403)
        self.assertEqual(self.owner.call('/api/projects')[1], before)
        owner_id = self.owner.call('/api/session')[1]['user']['id']
        with self.app.db() as db:
            for index in range(24): self.app.new_project(db, owner_id, 'Paper ' + str(index), {'main.tex': b'Paper'})
        self.assertEqual(self.owner.call('/api/projects', 'POST', {'templateId': 'neurips-2026'})[0], 413)

    def test_bundled_upstream_files_match_recorded_hashes(self):
        manifest = json.loads((ROOT / 'upstream.json').read_text())
        for component, directory in [('neurips', 'neurips-2026'), ('touying', 'western-presentation/vendor/touying')]:
            for name, digest in manifest[component]['files'].items():
                self.assertEqual(hashlib.sha256((ROOT / directory / name).read_bytes()).hexdigest(), digest, name)

    def test_neurips_starter_compiles_with_bibliography_and_checklist(self):
        _, files = template_files('neurips-2026')
        result = compile_project(files, main_document(files))
        self.assertTrue(result['success'], result['log'])
        self.assertNotIn('undefined citations', result['log'].lower())

    def test_western_starter_compiles_without_external_packages(self):
        import os
        if not shutil.which(os.getenv('TYPST_BIN', 'typst')): self.skipTest('Typst compiler is not configured')
        _, files = template_files('western-presentation')
        # Use an empty package directory: every needed module is in the project.
        import tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'TYPST_PACKAGE_PATH': folder, 'TYPST_PACKAGE_CACHE_PATH': folder}):
            result = compile_project(files, main_document(files))
        self.assertTrue(result['success'], result['log'])


if __name__ == '__main__': unittest.main()
