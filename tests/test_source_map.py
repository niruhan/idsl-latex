import gzip
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import test_app
from core import compile_project
from source_map import parse_source_map, read_source_map


class SourceMapTests(unittest.TestCase):
    def test_sync_records_units_compression_and_project_file_filter(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            text = f'''SyncTeX Version:1
Input:1:{root}/main.tex
Input:2:{root}/sections/part.tex
Input:3:/private/outside.tex
Input:4:{root}/not-in-project.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{{1
(1,99:0,0:100,100,0
g1,3:6578176,13156352
x2,65,8:9867264,=
k3,1:6578176,13156352:0
g4,1:6578176,13156352
<1
g1,9:0,0
>
}}1
{{2
$2,66:6578176,13156352
}}2
Postamble:
Count:10
'''
            files = {'main.tex': b'', 'sections/part.tex': b''}
            result = parse_source_map(text, root, files)
            self.assertEqual(result['files'], ['main.tex', 'sections/part.tex'])
            self.assertEqual(result['pages']['1'], [[0, 2, 0, 100.0, 200.0], [1, 64, 7, 150.0, 200.0]])
            self.assertEqual(result['pages']['2'], [[1, 65, 0, 100.0, 200.0]])
            self.assertNotIn(str(root), json.dumps(result))
            self.assertNotIn('outside', json.dumps(result))
            path = root / 'main.synctex.gz';path.write_bytes(gzip.compress(text.encode()))
            self.assertEqual(read_source_map(path, root, files), result)
            path.write_bytes(b'not gzip');self.assertIsNone(read_source_map(path, root, files))
            self.assertIsNone(parse_source_map(text.replace('Unit:1', 'Unit:0'), root, files))
            self.assertIsNone(parse_source_map(text.replace('Version:1', 'Version:10'), root, files))

    def test_real_compiler_maps_nested_main_and_included_file(self):
        engine = os.getenv('TEST_LATEX_ENGINE', 'tectonic')
        # Tectonic resolves includes beside its main document; latexmk uses cwd.
        include = 'part' if engine == 'tectonic' else 'chapters/part'
        source = ('\\documentclass{article}\n\\begin{document}\nMain paragraph with several words.\\par\n\\input{'+include+'}\n\\end{document}\n').encode()
        files = {'chapters/main.tex': source, 'chapters/part.tex': b'% Included file\n\nIncluded paragraph with several words.\n'}
        with patch.dict(os.environ, {'LATEX_ENGINE': engine}):
            result = compile_project(files, 'chapters/main.tex')
        self.assertTrue(result['success'], result['log'])
        mapping = result['sourceMap'];self.assertIsNotNone(mapping)
        index = mapping['files'].index('chapters/part.tex')
        self.assertTrue(any(point[0] == index and point[1] == 2 for point in mapping['pages']['1']))


class SourceMapAccessTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    invite = test_app.AppTests.invite
    lab_signup = test_app.AppTests.lab_signup

    def test_mapping_version_access_retention_purge_and_old_builds(self):
        mapping = {'files': ['main.tex'], 'pages': {'1': [[0, 4, 0, 100, 150]]}}
        compiled = {'success': True, 'log': '', 'pdf': 'JVBERg==', 'seconds': 1, 'engine': 'tectonic', 'sourceMap': mapping}
        with patch('server.compile_project', return_value=compiled.copy()):
            code, build = self.owner.call(self.base+'/compile', 'POST', {})
        self.assertEqual(code, 200);self.assertIs(build['sourceMap'], True)
        created = self.owner.call(self.base)[1]['build']['created']
        endpoint = self.base+'/synctex?v='+str(created)
        self.assertEqual(self.owner.call(endpoint)[1], {**mapping, 'revision': build['revision']})
        self.assertEqual(self.owner.call(self.base+'/synctex?v=0')[0], 409)
        self.assertEqual(self.owner.call(self.base+'/pdf?v=0')[0], 409)
        self.assertEqual(test_app.Client(self.port).call(endpoint)[0], 401)
        viewer, _ = self.invite('viewer');self.assertEqual(viewer.call(endpoint)[0], 200)
        viewer_id = viewer.call('/api/session')[1]['user']['id']
        self.assertEqual(self.owner.call(self.base+'/members', 'DELETE', {'userId': viewer_id})[0], 200)
        self.assertEqual(viewer.call(endpoint)[0], 404)
        self.assertEqual(self.owner.call(self.base, 'DELETE', {})[0], 200)
        self.assertEqual(self.owner.call(endpoint)[0], 404)
        with self.app.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM build_sources').fetchone()[0], 1)
            from server import delete_project_rows
            delete_project_rows(db, self.pid)
            self.assertEqual(db.execute('SELECT count(*) FROM build_sources').fetchone()[0], 0)
        # Older compilers/builds continue to display/export PDFs without a map.
        pid = self.owner.call('/api/projects', 'POST', {'name': 'Old compiler fixture', 'template': False})[1]['id']
        old = '/api/projects/'+pid
        compiled.pop('sourceMap')
        with patch('server.compile_project', return_value=compiled):
            self.assertFalse(self.owner.call(old+'/compile', 'POST', {})[1]['sourceMap'])
        self.assertEqual(self.owner.call(old+'/synctex')[1], {'files': [], 'pages': {}})
        self.assertTrue(self.owner.call(old+'/pdf')[1].startswith(b'%PDF'))
