import base64
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from core import Problem
from credential_store import FileTokenStore
from github_backup import MANIFEST,backup_snapshot
from github_collaboration import merge_file,merge_project
from server import App,Handler,BoundedHTTPServer,delete_project_rows
from test_app import Client
from fake_collaboration_github import CollaborationGitHub


class MergeTests(unittest.TestCase):
    def test_disjoint_identical_overlap_delete_add_and_binary(self):
        base=b'One\nTwo\nThree\nFour\n'
        merged,conflict=merge_file(base,b'ONE\nTwo\nThree\nFour\n',b'One\nTwo\nThree\nFOUR\n')
        self.assertFalse(conflict);self.assertEqual(merged,b'ONE\nTwo\nThree\nFOUR\n')
        self.assertEqual(merge_file(base,b'One\nTWO\nThree\nFour\n',b'One\nOther\nThree\nFour\n'),(None,True))
        for old,left,right,expected in [(base,base,None,(None,False)),(base,b'Changed',None,(None,True)),(None,b'Added',b'Added',(b'Added',False)),(None,b'A',b'B',(None,True)),(b'\0old',b'\0new',b'\0old',(b'\0new',False)),(b'\0old',b'\0left',b'\0right',(None,True))]:
            self.assertEqual(merge_file(old,left,right),expected)


class CollaborationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.instances=[];self.patches=[]
        for index in range(2):
            server=BoundedHTTPServer(('127.0.0.1',0),Handler);port=server.server_address[1];app=App(Path(self.temp.name)/str(index),f'http://127.0.0.1:{port}');app.tokens=FileTokenStore(app.data/'.github-tokens');server.app=app
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();client=Client(port)
            self.assertEqual(client.call('/api/setup','POST',{'token':app.setup_token,'name':'Researcher '+str(index),'email':'researcher'+str(index)+'@example.test','password':'fictional-password-only'})[0],200)
            app.tokens.set(client.call('/api/session')[1]['user']['id'],'fictional-token-for-machine-'+str(index))
            self.instances.append((server,thread,app,client))
        self.a=self.instances[0][3];self.b=self.instances[1][3];self.app=self.instances[0][2]
        self.pid=self.a.call('/api/projects','POST',{'name':'Shared paper','format':'typst','template':False})[1]['id'];self.base='/api/projects/'+self.pid
        self.original=b'= Shared paper\nOne\nTwo\nThree\nFour\n'
        self.write(self.a,self.base,'main.typ',self.original.decode())
        self.asset=b'\x89PNG\0fictional image'
        self.a.call(self.base+'/file','PUT',{'path':'images/figure.png','base64':base64.b64encode(self.asset).decode(),'revision':0})
        self.folder='projects/Shared paper';prefix=self.folder+'/'
        metadata={'version':1,'project_id':self.pid,'name':'Shared paper','main':'main.typ','files':['main.typ','images/figure.png']}
        self.remote=CollaborationGitHub({prefix+MANIFEST:json.dumps(metadata).encode(),prefix+'main.typ':self.original,prefix+'images/figure.png':self.asset,'README.md':b'Unrelated repository text','projects/Other/main.typ':b'Other document'})
        for target in ('server.GitHub','github_collaboration.GitHub'):
            item=patch(target,return_value=self.remote);item.start();self.patches.append(item)
        self.target={'repository':'example/papers','branch':'main','folder':self.folder}

    def tearDown(self):
        for item in self.patches:item.stop()
        for server,thread,app,client in self.instances:server.shutdown();server.server_close();thread.join()
        self.temp.cleanup()

    def write(self,client,base,path,content):
        status,file=client.call(base+'/file?path='+path)
        response=client.call(base+'/file','PUT',{'path':path,'content':content,'revision':file['revision'] if status==200 else 0})
        self.assertEqual(response[0],200,response)

    def connect_join(self):
        status,value=self.a.call(self.base+'/collaboration/connect','POST',self.target);self.assertEqual(status,200,value)
        self.assertTrue(value['linked'])
        status,plan=self.b.call('/api/github-preview','POST',{**self.target,'commit':self.remote.head,'collaborate':True});self.assertEqual(status,200,plan)
        status,created=self.b.call('/api/github-apply','POST',{'planId':plan['planId'],'paths':[item['path'] for item in plan['changes']],'collaborate':True,'name':'My local shared paper'})
        self.assertEqual(status,200,created);self.other='/api/projects/'+created['id'];self.assertNotEqual(created['id'],self.pid)

    def review(self,client,base):
        status,plan=client.call(base+'/collaboration/review','POST',{});self.assertEqual(status,200,plan);return plan

    def sync(self,client,base,plan,resolutions=None):
        return client.call(base+'/collaboration/sync','POST',{'planId':plan['planId'],'resolutions':resolutions or {}})

    def test_two_independent_installations_merge_and_converge(self):
        self.connect_join();self.write(self.a,self.base,'main.typ',self.original.decode().replace('One','ONE'))
        self.write(self.b,self.other,'main.typ',self.original.decode().replace('Four','FOUR'))
        first=self.review(self.a,self.base);self.assertEqual(self.sync(self.a,self.base,first)[0],200)
        second=self.review(self.b,self.other);self.assertEqual(second['conflicts'],[])
        status,file=self.b.call(self.other+'/collaboration/file','POST',{'planId':second['planId'],'path':'main.typ'});self.assertEqual(status,200,file);self.assertIn('ONE',file['merged']);self.assertIn('FOUR',file['merged'])
        status,result=self.sync(self.b,self.other,second);self.assertEqual(status,200,result)
        third=self.review(self.a,self.base);status,result=self.sync(self.a,self.base,third);self.assertEqual(status,200,result);self.assertFalse(result['published'])
        expected=self.original.decode().replace('One','ONE').replace('Four','FOUR')
        self.assertEqual(self.a.call(self.base+'/file?path=main.typ')[1]['content'],expected)
        self.assertEqual(self.b.call(self.other+'/file?path=main.typ')[1]['content'],expected)
        self.assertEqual(self.remote.files()[self.folder+'/main.typ'],expected.encode());self.assertEqual(self.remote.files()['README.md'],b'Unrelated repository text')
        self.assertEqual(self.remote.files()[self.folder+'/images/figure.png'],self.asset)
        self.assertTrue(self.a.call(self.base+'/checkpoints')[1]['checkpoints'])
        status,state=self.a.call(self.base+'/collaboration');self.assertEqual(status,200);self.assertFalse(state['localChanges'])
        self.assertEqual(json.loads(self.remote.files()[self.folder+'/'+MANIFEST])['project_id'],self.pid)

    def test_conflicts_require_explicit_resolution_and_preserve_both_versions(self):
        self.connect_join();self.write(self.a,self.base,'main.typ','A different local sentence.\n');self.write(self.b,self.other,'main.typ','B different local sentence.\n')
        self.assertEqual(self.sync(self.a,self.base,self.review(self.a,self.base))[0],200)
        review=self.review(self.b,self.other);self.assertIn('main.typ',review['conflicts']);head=self.remote.head
        self.assertEqual(self.sync(self.b,self.other,review)[0],400);self.assertEqual(self.remote.head,head)
        detail=self.b.call(self.other+'/collaboration/file','POST',{'planId':review['planId'],'path':'main.typ'})[1]
        self.assertEqual(detail['local'],'B different local sentence.\n');self.assertEqual(detail['remote'],'A different local sentence.\n');self.assertTrue(detail['editable'])
        status,result=self.sync(self.b,self.other,review,{'main.typ':{'choice':'manual','content':'A and B reviewed together.\n'}});self.assertEqual(status,200,result)
        self.assertEqual(self.remote.files()[self.folder+'/main.typ'],b'A and B reviewed together.\n')
        self.assertTrue(self.b.call(self.other+'/history?path=main.typ')[1]['versions'])

    def test_stale_remote_local_and_inflight_races_never_overwrite_drafts(self):
        self.connect_join();plan=self.review(self.a,self.base);self.remote.edit({'README.md':b'New unrelated commit'})
        self.assertEqual(self.sync(self.a,self.base,plan)[0],409)
        plan=self.review(self.a,self.base);self.write(self.a,self.base,'main.typ','Unreviewed local draft.\n');head=self.remote.head
        self.assertEqual(self.sync(self.a,self.base,plan)[0],409);self.assertEqual(self.remote.head,head)
        plan=self.review(self.a,self.base);self.remote.before_patch=lambda:self.remote.edit({self.folder+'/main.typ':b'Another machine won.\n'})
        self.assertEqual(self.sync(self.a,self.base,plan)[0],409);self.assertEqual(self.remote.files()[self.folder+'/main.typ'],b'Another machine won.\n');self.assertEqual(self.a.call(self.base+'/file?path=main.typ')[1]['content'],'Unreviewed local draft.\n')
        plan=self.review(self.a,self.base)
        self.remote.after_patch=lambda:self.write(self.a,self.base,'main.typ','Draft edited during upload.\n')
        status,result=self.sync(self.a,self.base,plan,{'main.typ':{'choice':'manual','content':'Reviewed merge.\n'}})
        self.assertEqual(status,409,result);self.assertEqual(self.a.call(self.base+'/file?path=main.typ')[1]['content'],'Draft edited during upload.\n');self.assertEqual(self.remote.files()[self.folder+'/main.typ'],b'Reviewed merge.\n')
        # A new review remains possible after the remote publish/local-apply gap.
        followup=self.review(self.a,self.base);self.assertIn('main.typ',followup['conflicts'])

    def test_permissions_backup_guards_persistence_disconnect_and_cleanup(self):
        self.connect_join();self.assertEqual(Client(self.a.port).call(self.base+'/collaboration')[0],401)
        self.assertEqual(self.b.call(self.base+'/collaboration')[0],404)
        self.assertEqual(self.a.call(self.base+'/backup','POST',{})[0],409)
        status,result=self.a.call('/api/backups','POST',{});self.assertEqual(status,200,result);self.assertTrue(next(item for item in result['results'] if item['id']==self.pid)['skipped'])
        self.assertEqual(self.a.call('/api/github-preview','POST',{**self.target,'projectId':self.pid,'commit':self.remote.head})[0],409)
        self.assertTrue(self.a.call(self.base)[1]['collaboration'])
        with self.app.db() as db:
            row=db.execute('SELECT * FROM project_collaboration WHERE project_id=?',(self.pid,)).fetchone();self.assertNotIn('token',row.keys())
        restarted=App(self.app.data,self.app.origin);restarted.tokens=self.app.tokens
        try:self.assertTrue(restarted.collab.describe(self.a.call('/api/session')[1]['user'],self.pid)['linked'])
        finally:restarted.typst.close()
        self.assertEqual(self.a.call(self.base+'/collaboration','DELETE',{})[0],200)
        project=self.a.call(self.base)[1];files={'main.typ':self.original,'images/figure.png':self.asset}
        with self.assertRaises(Problem):backup_snapshot(self.remote,self.target,project,files,True)
        self.assertTrue(self.b.call(self.other+'/collaboration')[1]['linked'],'Disconnecting one installation must keep the other connected')
        with self.app.db() as db:
            delete_project_rows(db,self.pid);self.assertEqual(db.execute('SELECT COUNT(*) FROM project_collaboration WHERE project_id=?',(self.pid,)).fetchone()[0],0)

    def test_root_repository_excludes_unmanaged_content_and_refuses_collision(self):
        metadata={'version':1,'project_id':self.pid,'name':'Shared paper','main':'main.typ','files':['main.typ','images/figure.png']}
        self.folder='';self.target['folder']=''
        self.remote.__init__({MANIFEST:json.dumps(metadata).encode(),'main.typ':self.original,'images/figure.png':self.asset,'README.md':b'Unmanaged repository guide','admin/config.txt':b'Unmanaged configuration'})
        self.connect_join()
        self.assertEqual({item['path'] for item in self.b.call(self.other)[1]['files']},{'main.typ','images/figure.png'})
        self.write(self.a,self.base,'main.typ','Reviewed root edit.\n');self.assertEqual(self.sync(self.a,self.base,self.review(self.a,self.base))[0],200)
        self.assertEqual(self.remote.files()['README.md'],b'Unmanaged repository guide');self.assertEqual(self.remote.files()['admin/config.txt'],b'Unmanaged configuration')
        self.write(self.a,self.base,'README.md','A colliding document.');head=self.remote.head
        status,result=self.sync(self.a,self.base,self.review(self.a,self.base));self.assertEqual(status,409,result);self.assertEqual(self.remote.head,head)

    def test_added_deleted_renamed_sources_main_and_binary_conflicts(self):
        self.connect_join();revision=self.a.call(self.base+'/file?path=main.typ')[1]['revision']
        status,result=self.a.call(self.base+'/rename','POST',{'path':'main.typ','newPath':'chapters/paper.typ','revision':revision});self.assertEqual(status,200,result)
        self.write(self.a,self.base,'notes.typ','New shared notes.\n')
        asset=self.a.call(self.base+'/file?path=images/figure.png')[1]
        self.a.call(self.base+'/file','DELETE',{'path':'images/figure.png','revision':asset['revision']})
        status,result=self.sync(self.a,self.base,self.review(self.a,self.base));self.assertEqual(status,200,result)
        plan=self.review(self.b,self.other);self.assertIn('@main',[item['path'] for item in plan['changes']]);self.assertEqual(self.sync(self.b,self.other,plan)[0],200)
        self.assertEqual(self.b.call(self.other)[1]['main'],'chapters/paper.typ');self.assertEqual(self.b.call(self.other+'/file?path=main.typ')[0],404);self.assertEqual(self.b.call(self.other+'/file?path=images/figure.png')[0],404)
        for client,base,content in [(self.a,self.base,b'\0local image'),(self.b,self.other,b'\0other image')]:
            self.assertEqual(client.call(base+'/file','PUT',{'path':'new.png','base64':base64.b64encode(content).decode(),'revision':0})[0],200)
        self.assertEqual(self.sync(self.a,self.base,self.review(self.a,self.base))[0],200)
        plan=self.review(self.b,self.other);self.assertIn('new.png',plan['conflicts'])
        detail=self.b.call(self.other+'/collaboration/file','POST',{'planId':plan['planId'],'path':'new.png'})[1];self.assertTrue(detail['binary']);self.assertFalse(detail['editable'])
        url=self.other+'/collaboration/file?planId='+plan['planId']+'&path=new.png&version=remote'
        self.assertEqual(self.b.call(url),(200,b'\0local image'))
        self.assertEqual(self.sync(self.b,self.other,plan,{'new.png':{'choice':'manual','content':'Invalid binary resolution'}})[0],400)
        self.assertEqual(self.sync(self.b,self.other,plan,{'new.png':{'choice':'remote'}})[0],200);self.assertEqual(self.remote.files()[self.folder+'/new.png'],b'\0local image')

    def test_expiry_member_permissions_and_local_directory_collision(self):
        self.connect_join();plan=self.review(self.a,self.base)
        with self.app.db() as db:
            other_user='0'*24
            db.execute('INSERT INTO users(id,email,name,password) VALUES(?,?,?,?)',(other_user,'readonly@example.test','Read only','unused'))
            db.execute('INSERT INTO members VALUES(?,?,?)',(self.pid,other_user,'editor'))
        with self.assertRaises(Problem) as denied:self.app.collab.plan({'id':other_user},self.pid,plan['planId'])
        self.assertEqual(denied.exception.status,403)
        self.app.collab.plans[plan['planId']]['expires']=0;self.assertEqual(self.sync(self.a,self.base,plan)[0],404)
        # Incoming files cannot replace an explicit local directory, and the
        # complete local validation happens before any GitHub upload.
        self.assertEqual(self.b.call(self.other+'/directories','POST',{'path':'reserved'})[0],200)
        self.write(self.a,self.base,'reserved','New text file');self.assertEqual(self.sync(self.a,self.base,self.review(self.a,self.base))[0],200)
        head=self.remote.head;plan=self.review(self.b,self.other);status,result=self.sync(self.b,self.other,plan);self.assertEqual(status,409,result);self.assertEqual(self.remote.head,head)


if __name__=='__main__':unittest.main()
