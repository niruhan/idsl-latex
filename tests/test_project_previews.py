import base64
import unittest
from unittest.mock import patch

import test_app
from server import App, delete_project_rows


class ProjectPreviewTests(unittest.TestCase):
    setUp=test_app.AppTests.setUp
    tearDown=test_app.AppTests.tearDown
    invite=test_app.AppTests.invite
    lab_signup=test_app.AppTests.lab_signup

    def compile(self, pdf):
        result={'success':bool(pdf),'log':'Fictional compiler result','seconds':0.1,'engine':'typst','pdf':base64.b64encode(pdf).decode() if pdf else None}
        with patch('server.compile_project',return_value=result):
            status,response=self.owner.call(self.base+'/compile','POST',{})
        self.assertEqual(status,200,response)
        return next(project for project in self.owner.call('/api/projects')[1]['projects'] if project['id']==self.pid)['preview']

    def test_last_successful_cover_retention_version_access_and_cleanup(self):
        self.assertIsNone(self.owner.call('/api/projects')[1]['projects'][0]['preview'])
        self.assertEqual(self.owner.call(self.base+'/preview.pdf?v=1')[0],404)
        first=self.compile(b'%PDF-fictional first page')
        self.assertIsInstance(first,float)
        url=self.base+'/preview.pdf?v='+str(first)
        self.assertEqual(self.owner.call(url),(200,b'%PDF-fictional first page'))
        self.assertEqual(self.compile(None),first,'A failed compile must preserve the last successful cover')
        self.assertEqual(self.owner.call(url)[0],200)
        viewer,_=self.invite('viewer')
        self.assertEqual(viewer.call(url)[0],200)
        self.assertEqual(test_app.Client(self.port).call(url)[0],401)
        outsider,status,_=self.lab_signup(self.owner.call('/api/lab-invite','POST',{'count':1})[1]['links'][0]['url'].split('#signup=')[1],'outsider@example.test')
        self.assertEqual(status,200)
        self.assertEqual(outsider.call(url)[0],404)
        self.assertNotIn(self.pid,[project['id'] for project in outsider.call('/api/projects')[1]['projects']])
        second=self.compile(b'%PDF-fictional newer first page')
        self.assertNotEqual(first,second)
        self.assertEqual(self.owner.call(url)[0],409)
        self.assertEqual(self.owner.call(self.base+'/preview.pdf?v='+str(second)),(200,b'%PDF-fictional newer first page'))
        self.assertEqual(self.owner.call(self.base,'DELETE',{})[0],200)
        self.assertEqual(viewer.call(self.base+'/preview.pdf?v='+str(second))[0],404)
        with self.app.db() as db:
            delete_project_rows(db,self.pid)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM project_previews WHERE project_id=?',(self.pid,)).fetchone()[0],0)

    def test_existing_successful_builds_migrate_without_compilation(self):
        with self.app.db() as db:
            db.execute('INSERT INTO builds VALUES(?,?,?,?,?,?,?,?)',(self.pid,1,1,'',b'%PDF-existing',0,123.5,'tectonic'))
            db.execute('DROP TABLE project_previews')
        migrated=App(self.tmp.name,self.app.origin)
        try:
            self.assertEqual(self.owner.call('/api/projects')[1]['projects'][0]['preview'],123.5)
            self.assertEqual(self.owner.call(self.base+'/preview.pdf?v=123.5'),(200,b'%PDF-existing'))
        finally:
            migrated.typst.close()


if __name__=='__main__':unittest.main()
