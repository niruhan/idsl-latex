import base64
import unittest
import test_app


class FileMoveTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    invite = test_app.AppTests.invite
    lab_signup = test_app.AppTests.lab_signup

    def put(self,path,content=b'fixture',revision=0):
        result=self.owner.call(self.base+'/file','PUT',{'path':path,'base64':base64.b64encode(content).decode(),'revision':revision})
        self.assertEqual(result[0],200,result)

    def move(self,path,folder=None,directory=False,revision=None,client=None):
        if revision is None: revision=self.owner.call(self.base)[1]['revision']
        return (client or self.owner).call(self.base+'/move-files','POST',{'path':path,'folder':folder,'directory':directory,'revision':revision})

    def snapshot(self):
        with self.app.db() as db:
            return tuple(tuple(tuple(row) for row in db.execute('SELECT * FROM '+table+' WHERE project_id=? ORDER BY rowid',(self.pid,)).fetchall()) for table in ['files','history']),self.owner.call(self.base)[1]

    def test_file_and_recursive_folder_moves_preserve_bytes_history_and_main(self):
        main=self.owner.call(self.base+'/file?path=main.tex')[1]['content'].encode()
        self.put('main.tex',main+b'\n% saved version',1)
        self.put('sections/image.png',b'\x89PNG\x00original-image')
        self.put('assets/keep.txt')
        before=self.owner.call(self.base)[1]
        status,result=self.move('main.tex','sections');self.assertEqual(status,200,result)
        self.assertEqual(self.owner.call(self.base)[1]['main'],'sections/main.tex')
        status,result=self.move('sections','assets',True);self.assertEqual(status,200,result)
        project=self.owner.call(self.base)[1];self.assertEqual(project['main'],'assets/sections/main.tex')
        self.assertEqual(self.owner.call(self.base+'/file?path=assets/sections/main.tex')[1]['content'].encode(),main+b'\n% saved version')
        image=self.owner.call(self.base+'/file?path=assets/sections/image.png')[1]
        self.assertEqual(base64.b64decode(image['base64']),b'\x89PNG\x00original-image')
        versions=self.owner.call(self.base+'/history?path=assets/sections/main.tex')[1]['versions'];self.assertEqual(len(versions),1)
        previous=self.owner.call(self.base+'/history?path=assets/sections/main.tex&id='+str(versions[0]['id']))[1]['content']
        self.assertEqual(previous.encode(),main)
        self.assertEqual(len(project['files']),len(before['files']))
        self.assertFalse(any(file['path'].startswith('_move_') for file in project['files']))
        self.assertEqual(self.move('assets/sections',None,True)[0],200)
        self.assertEqual(self.owner.call(self.base)[1]['main'],'sections/main.tex')
        unchanged=self.snapshot();status,result=self.move('sections/main.tex','sections');self.assertEqual(status,200,result);self.assertFalse(result['changed']);self.assertEqual(self.snapshot(),unchanged)

    def test_invalid_moves_are_atomic_and_never_merge_or_overwrite(self):
        self.put('assets/keep.txt');self.put('assets/sections/collision.txt');self.put('sections/nested/item.txt')
        self.put('B'*200+'/k');self.put('A'*30+'.txt')
        for path,folder,directory,status in [
            ('sections','assets',True,409),('sections','sections',True,409),
            ('sections','sections/nested',True,409),('main.tex','missing',False,404),
            ('../escape',None,False,400),('main.tex','../escape',False,400),
            ('missing',None,False,404),('sections','main.tex',True,404),
            ('A'*30+'.txt','B'*200,False,400),('main.tex',None,'yes',400),
        ]:
            with self.subTest(path=path,folder=folder):
                before=self.snapshot();result=self.move(path,folder,directory);self.assertEqual(result[0],status,result);self.assertEqual(self.snapshot(),before)

    def test_stale_revisions_and_permissions(self):
        before=self.snapshot();self.assertEqual(self.move('main.tex','sections',revision=0)[0],409);self.assertEqual(self.snapshot(),before)
        viewer,_=self.invite('viewer');self.assertEqual(self.move('main.tex','sections',client=viewer)[0],403)
        outsider=test_app.Client(self.port);self.assertEqual(self.move('main.tex','sections',client=outsider)[0],401)
        editor,_=self.invite('editor','editor@example.test');self.assertEqual(self.move('main.tex','sections',client=editor)[0],200)
        self.assertEqual(viewer.call(self.base)[1]['main'],'sections/main.tex')


if __name__=='__main__':unittest.main()
