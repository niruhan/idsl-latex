import unittest
import test_app


class FileDeleteTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    invite = test_app.AppTests.invite
    lab_signup = test_app.AppTests.lab_signup

    def put(self, path, content='Fixture', revision=0):
        status, result = self.owner.call(self.base+'/file', 'PUT', {'path':path,'content':content,'revision':revision})
        self.assertEqual(status, 200, result)

    def delete(self, paths=None, directories=None, revision=None, client=None):
        if revision is None: revision = self.owner.call(self.base)[1]['revision']
        return (client or self.owner).call(self.base+'/delete-files', 'POST', {'paths':paths or [],'directories':directories or [],'revision':revision})

    def snapshot(self):
        with self.app.db() as db:
            return tuple(tuple(tuple(row) for row in db.execute('SELECT * FROM '+table+' WHERE '+('id' if table=='projects' else 'project_id')+'=? ORDER BY rowid',(self.pid,))) for table in ('projects','files','history'))

    def test_recursive_folder_and_file_delete_is_atomic_and_keeps_siblings(self):
        for path in ('assets/one.svg','assets/nested/two.svg','assets-old/keep.typ','note.tex'):
            self.put(path);self.put(path,'Updated fixture',1)
        before = self.owner.call(self.base)[1]
        status, result = self.delete(['note.tex','assets/one.svg'],['assets','assets/nested'])
        self.assertEqual(status, 200, result)
        self.assertEqual(result['deleted'], ['assets/nested/two.svg','assets/one.svg','note.tex'])
        self.assertEqual(result['revision'], before['revision']+1)
        project = self.owner.call(self.base)[1]
        self.assertEqual(project['main'], before['main'])
        self.assertIn('assets-old/keep.typ', [file['path'] for file in project['files']])
        self.assertEqual(self.owner.call(self.base+'/file?path=assets-old/keep.typ')[1]['content'],'Updated fixture')
        for path in result['deleted']:
            self.assertEqual(self.owner.call(self.base+'/file?path='+path)[0],404)
            self.assertEqual(self.owner.call(self.base+'/history?path='+path)[1]['versions'],[])
        self.assertEqual(len(self.owner.call(self.base+'/history?path=assets-old/keep.typ')[1]['versions']),1)

    def test_invalid_selections_main_document_and_conflicts_delete_nothing(self):
        self.put('images/item.svg');self.put('images/item.svg','Newer fixture',1)
        revision = self.owner.call(self.base)[1]['revision']
        for data, expected in [
            ({'paths':[]},400),({'paths':None},400),({'paths':'images/item.svg'},400),
            ({'paths':['../escape']},400),({'directories':['']},400),({'directories':['images/']},400),
            ({'paths':['images/item.svg','missing.tex']},404),
            ({'paths':['images/item.svg'],'directories':['missing']},404),
            ({'paths':['images/item.svg','main.tex']},400),
            ({'paths':['images/item.svg'],'revision':revision-1},409),
            ({'paths':['images/item.svg'],'revision':True},400),
            ({'paths':['images/item.svg']*1001},400),
        ]:
            with self.subTest(data=data):
                before = self.snapshot()
                response = self.owner.call(self.base+'/delete-files','POST',{'revision':revision,**data})
                self.assertEqual(response[0],expected,response)
                self.assertEqual(self.snapshot(),before)
        self.put('images/main.tex','Nested main document')
        self.assertEqual(self.owner.call(self.base,'PUT',{'main':'images/main.tex'})[0],200)
        before = self.snapshot();self.assertEqual(self.delete(directories=['images'])[0],400);self.assertEqual(self.snapshot(),before)
        stale = self.owner.call(self.base)[1]['revision'];self.put('images/coauthor.tex','Added after confirmation')
        before = self.snapshot();self.assertEqual(self.delete(directories=['images'],revision=stale)[0],409);self.assertEqual(self.snapshot(),before)

    def test_permissions_and_large_valid_requests(self):
        name='a'*210+'.tex';self.put(name)
        viewer, _ = self.invite('viewer')
        before = self.snapshot();self.assertEqual(self.delete([name],client=viewer)[0],403);self.assertEqual(self.snapshot(),before)
        self.assertEqual(self.delete([name],client=test_app.Client(self.port))[0],401)
        editor, _ = self.invite('editor','editor@example.test')
        # A full-length 1000-item selection exceeds the usual small API body cap.
        status, result = self.delete([name]*1000,client=editor)
        self.assertEqual(status,200,result);self.assertEqual(result['deleted'],[name])
        self.put('keep.tex');self.assertEqual(self.owner.call(self.base,'DELETE',{})[0],200)
        before = self.snapshot();self.assertEqual(self.delete(['keep.tex'],revision=1)[0],404);self.assertEqual(self.snapshot(),before)
