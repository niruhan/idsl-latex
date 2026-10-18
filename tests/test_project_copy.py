import base64
import unittest
from unittest.mock import patch

import test_app


class ProjectCopyTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    invite = test_app.AppTests.invite
    lab_signup = test_app.AppTests.lab_signup

    def test_copy_preserves_files_main_and_folder_without_mutating_source(self):
        folder=self.owner.call('/api/project-folders','POST',{'name':'Copy fixtures'})[1]['id']
        self.owner.call(self.base+'/folder','PUT',{'folder':folder})
        self.owner.call(self.base+'/file','PUT',{'path':'nested/presentation.typ','content':'= Custom main','revision':0})
        self.owner.call(self.base+'/file','PUT',{'path':'images/asset.bin','base64':base64.b64encode(b'\x00\xff\x01').decode(),'revision':0})
        self.owner.call(self.base+'/file','PUT',{'path':'main.tex','content':'Latest saved source','revision':1})
        self.owner.call(self.base,'PUT',{'main':'nested/presentation.typ'})
        self.owner.call(self.base+'/backup-settings','PUT',{'mode':'separate','repository':'example/original'})
        before=self.owner.call(self.base)[1]
        with self.app.db() as db:
            db.execute('INSERT INTO builds VALUES(?,?,?,?,?,?,?,?)',(self.pid,before['revision'],1,'Test build',b'%PDF-fixture',1,1,'typst'))
        before=self.owner.call(self.base)[1]
        status,copy=self.owner.call(self.base+'/duplicate','POST',{})
        self.assertEqual(status,200,copy)
        self.assertNotEqual(copy['id'],self.pid)
        self.assertEqual(copy['folder'],folder)
        result=self.owner.call('/api/projects/'+copy['id'])[1]
        self.assertEqual(result['folder'],folder)
        self.assertEqual(result['main'],'nested/presentation.typ')
        self.assertEqual(result['role'],'owner')
        self.assertEqual(result['revision'],1)
        self.assertIsNone(result['build'])
        self.assertEqual(self.owner.call(self.base)[1],before)
        with self.app.db() as db:
            original={row['path']:row['content'] for row in db.execute('SELECT path,content FROM files WHERE project_id=?',(self.pid,))}
            copied={row['path']:row['content'] for row in db.execute('SELECT path,content FROM files WHERE project_id=?',(copy['id'],))}
            self.assertEqual(original,copied)
            for table in ('history','invites','project_backups','shared_project_backups','builds','project_trash'):
                self.assertEqual(db.execute('SELECT COUNT(*) FROM '+table+' WHERE project_id=?',(copy['id'],)).fetchone()[0],0)
            self.assertTrue(db.execute('SELECT 1 FROM history WHERE project_id=?',(self.pid,)).fetchone())
            self.assertEqual(db.execute('SELECT COUNT(*) FROM members WHERE project_id=?',(copy['id'],)).fetchone()[0],1)

    def test_copy_names_are_unique_and_bounded_and_root_stays_root(self):
        self.owner.call(self.base,'PUT',{'name':'X'*120})
        first=self.owner.call(self.base+'/duplicate','POST',{})[1]
        second=self.owner.call(self.base+'/duplicate','POST',{})[1]
        self.assertTrue(first['name'].endswith(' (copy)'))
        self.assertTrue(second['name'].endswith(' (copy 2)'))
        self.assertNotEqual(first['name'],second['name'])
        for copy in (first,second):
            self.assertLessEqual(len(copy['name']),120)
            self.assertIsNone(copy['folder'])
            self.assertIsNone(self.owner.call('/api/projects/'+copy['id'])[1]['folder'])

    def test_viewers_copy_to_their_own_folder_and_get_a_private_owned_project(self):
        viewer,_=self.invite('viewer')
        owner_folder=self.owner.call('/api/project-folders','POST',{'name':'Owner folder'})[1]['id']
        viewer_folder=viewer.call('/api/project-folders','POST',{'name':'Viewer folder'})[1]['id']
        self.owner.call(self.base+'/folder','PUT',{'folder':owner_folder})
        viewer.call(self.base+'/folder','PUT',{'folder':viewer_folder})
        self.assertEqual(self.owner.call(self.base)[1]['folder'],owner_folder)
        self.assertEqual(viewer.call(self.base)[1]['folder'],viewer_folder)
        status,copy=viewer.call(self.base+'/duplicate','POST',{})
        self.assertEqual(status,200,copy)
        self.assertEqual(copy['folder'],viewer_folder)
        self.assertEqual(viewer.call('/api/projects/'+copy['id'])[1]['role'],'owner')
        self.assertEqual(self.owner.call('/api/projects/'+copy['id'])[0],404)
        self.assertEqual(viewer.call(self.base)[1]['role'],'viewer')

    def test_copy_enforces_authentication_origin_quota_and_trash_access(self):
        endpoint=self.base+'/duplicate'
        self.assertEqual(test_app.Client(self.port).call(endpoint,'POST',{})[0],401)
        self.assertEqual(self.owner.call(endpoint,'POST',{},origin='https://example.test')[0],403)
        self.assertEqual(self.owner.call(endpoint)[0],404)
        before=self.owner.call('/api/projects')[1]
        with patch('server.MAX_OWNED_PROJECTS',1): self.assertEqual(self.owner.call(endpoint,'POST',{})[0],413)
        self.assertEqual(self.owner.call('/api/projects')[1],before)
        self.owner.call(self.base,'DELETE',{})
        self.assertEqual(self.owner.call(endpoint,'POST',{})[0],404)


if __name__=='__main__': unittest.main()
