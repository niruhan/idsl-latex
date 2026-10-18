import base64
import io
import zipfile
from unittest.mock import patch
import unittest

import test_app
from core import Problem, pack_zip, unpack_zip


class FileDirectoryTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    invite = test_app.AppTests.invite
    lab_signup = test_app.AppTests.lab_signup

    def create(self, path, client=None):
        return (client or self.owner).call(self.base+'/directories', 'POST', {'path':path})

    def directories(self, base=None):
        return self.owner.call(base or self.base)[1]['directories']

    def test_empty_nested_folders_persist_without_placeholder_files(self):
        before=self.owner.call(self.base)[1]
        self.assertEqual(self.create('assets/figures')[0],200)
        self.assertTrue({'assets','assets/figures'}<=set(self.directories()))
        after=self.owner.call(self.base)[1]
        self.assertEqual(after['files'],before['files'])
        self.assertEqual(after['revision'],before['revision']+1)
        with self.app.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM directories WHERE project_id=?',(self.pid,)).fetchone()[0],2)
        reopened=test_app.App(self.tmp.name,self.owner.origin)
        with reopened.db() as db:
            self.assertIn('assets/figures',reopened.file_tree(db,self.pid)[1])

    def test_paths_collisions_permissions_and_quota(self):
        for path in ('',None,'../escape','/absolute','a//b','a/./b','a/../b','a\\b','.hidden','_labtex_output/a','x'*221):
            self.assertEqual(self.create(path)[0],400,path)
        self.assertEqual(self.create('main.tex/nested')[0],409)
        self.assertEqual(self.create('main.tex')[0],409)
        self.assertEqual(self.create('assets')[0],200)
        self.assertEqual(self.create('assets')[0],409)
        for path in ('assets','assets/child/../escape'):
            status,_=self.owner.call(self.base+'/file','PUT',{'path':path,'content':'bad','revision':0})
            self.assertIn(status,(400,409))
        self.assertEqual(self.owner.call(self.base+'/rename','POST',{'path':'main.tex','newPath':'assets','revision':1})[0],409)
        viewer,_=self.invite('viewer')
        self.assertEqual(self.create('forbidden',viewer)[0],403)
        self.assertEqual(self.create('anonymous',test_app.Client(self.port))[0],401)
        editor,_=self.invite('editor','editor@example.test')
        self.assertEqual(self.create('shared',editor)[0],200)
        before=self.directories()
        with patch('server.MAX_FILES',3):self.assertEqual(self.create('too/many/levels')[0],413)
        self.assertEqual(self.directories(),before)

    def test_empty_directory_move_copy_zip_and_delete(self):
        self.assertEqual(self.create('empty/nested')[0],200)
        self.assertEqual(self.create('destination')[0],200)
        project=self.owner.call(self.base)[1]
        status,moved=self.owner.call(self.base+'/move-files','POST',{'path':'empty','directory':True,'folder':'destination','revision':project['revision']})
        self.assertEqual(status,200,moved)
        self.assertEqual(moved['moves'],{})
        self.assertIn('destination/empty/nested',self.directories())
        self.assertNotIn('empty',self.directories())
        copy=self.owner.call(self.base+'/duplicate','POST',{})[1]['id']
        self.assertEqual(self.directories('/api/projects/'+copy),self.directories())
        status,raw=self.owner.call(self.base+'/source.zip');self.assertEqual(status,200)
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:self.assertIn('destination/empty/nested/',archive.namelist())
        status,result=self.owner.call('/api/projects','POST',{'zip':base64.b64encode(raw).decode(),'name':'Imported folders'})
        self.assertEqual(status,200,result)
        self.assertEqual(self.directories('/api/projects/'+result['id']),self.directories())
        revision=self.owner.call(self.base)[1]['revision']
        body={'paths':[],'directories':['destination/empty'],'revision':revision}
        self.assertEqual(self.owner.call(self.base+'/delete-files','POST',{**body,'revision':revision-1})[0],409)
        self.assertEqual(self.owner.call(self.base+'/delete-files','POST',body)[0],200)
        self.assertNotIn('destination/empty/nested',self.directories())
        self.assertIn('destination',self.directories())
        with self.app.db() as db:
            from server import delete_project_rows
            delete_project_rows(db,self.pid)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM directories WHERE project_id=?',(self.pid,)).fetchone()[0],0)

    def test_file_moves_into_empty_folders_and_folder_conflicts(self):
        self.create('assets')
        self.owner.call(self.base+'/file','PUT',{'path':'notes.typ','content':'= Notes','revision':0})
        revision=self.owner.call(self.base)[1]['revision']
        body={'path':'notes.typ','directory':False,'folder':'assets','revision':revision}
        status,result=self.owner.call(self.base+'/move-files','POST',body)
        self.assertEqual(status,200,result)
        self.assertEqual(self.owner.call(self.base+'/file?path=assets/notes.typ')[0],200)
        self.create('target/assets')
        revision=self.owner.call(self.base)[1]['revision']
        self.assertEqual(self.owner.call(self.base+'/move-files','POST',{'path':'assets','directory':True,'folder':'target','revision':revision})[0],409)

    def test_zip_directory_validation_and_wrapper_stripping(self):
        raw=pack_zip({'bundle/main.typ':b'= Example'},['bundle/empty/nested'])
        files,folders=unpack_zip(raw,include_directories=True)
        self.assertEqual(files,{'main.typ':b'= Example'})
        self.assertEqual(folders,{'empty/nested'})
        for directory in ('../escape/','main.typ/','_labtex_output/'):
            out=io.BytesIO()
            with zipfile.ZipFile(out,'w') as archive:
                archive.writestr('main.typ','= Example');archive.writestr(directory,b'')
            with self.assertRaises(Problem):unpack_zip(out.getvalue(),include_directories=True)
