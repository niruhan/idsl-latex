import base64, http.client, io, json, os, sys, tempfile, threading, unittest, zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import App,Handler,BoundedHTTPServer
from core import SAMPLE,Problem,unpack_zip,safe_path,compile_project

class Client:
    def __init__(self,port): self.port=port; self.cookie=''; self.origin=f'http://127.0.0.1:{port}'
    def call(self,path,method='GET',body=None,origin=None,extra_headers=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=150)
        headers={'Cookie':self.cookie,'Origin':self.origin if origin is None else origin}
        if body is not None: headers['Content-Type']='application/json'
        headers.update(extra_headers or {})
        conn.request(method,path,json.dumps(body) if body is not None else None,headers)
        r=conn.getresponse();raw=r.read();status=r.status
        if r.getheader('Set-Cookie'): self.cookie=r.getheader('Set-Cookie').split(';')[0]
        value=json.loads(raw) if r.getheader('Content-Type')=='application/json' else raw
        conn.close(); return status,value
class AppTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.server=BoundedHTTPServer(('127.0.0.1',0),Handler);self.port=self.server.server_address[1]
        self.app=App(self.tmp.name,f'http://127.0.0.1:{self.port}');self.server.app=self.app
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.owner=Client(self.port)
        status,_=self.owner.call('/api/setup','POST',{'token':self.app.setup_token,'name':'Test Owner','email':'owner@example.test','password':'long-test-password'})
        self.assertEqual(status,200);self.pid=self.owner.call('/api/projects')[1]['projects'][0]['id'];self.base='/api/projects/'+self.pid
    def tearDown(self): self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def invite(self,role,email='member@example.test'):
        code,result=self.owner.call(self.base+'/invite','POST',{'role':role});self.assertEqual(code,200)
        token=result['url'].split('#invite=')[1]
        account=self.owner.call('/api/lab-invite','POST',{'count':1})[1]['links'][0]['url'].split('#signup=')[1]
        member,status,_=self.lab_signup(account,email);self.assertEqual(status,200)
        self.assertEqual(member.call('/api/join','POST',{'token':token})[0],200)
        return member,token
    def test_auth_and_origin(self):
        self.assertEqual(Client(self.port).call(self.base)[0],401)
        self.assertEqual(self.owner.call(self.base,'PUT',{'name':'Bad'},origin='https://evil.test')[0],403)
        self.assertEqual(self.owner.call('/api/setup','POST',{'token':self.app.setup_token,'name':'New','email':'new@example.test','password':'long-test-password'})[0],403)
        self.assertEqual(self.owner.call('/api/logout','POST',{})[0],200)
        self.assertEqual(self.owner.call(self.base)[0],401)
    def lab_signup(self,token,email):
        with self.app.db() as db:db.execute('INSERT OR IGNORE INTO approved_emails VALUES(?)',(email,))
        member=Client(self.port)
        status,result=member.call('/api/register-lab','POST',{'token':token,'name':'Lab Member','email':email,'password':'private-lab-password'})
        return member,status,result
    def test_single_use_lab_invites_create_independent_projects(self):
        self.assertTrue(self.owner.call('/api/session')[1]['canInviteLab'])
        status,result=self.owner.call('/api/lab-invite','POST',{'count':3});self.assertEqual(status,200)
        self.assertEqual(len(result['links']),3);ids=[]
        for i,link in enumerate(result['links'][:2]):
            token=link['url'].split('#signup=')[1]
            member,status,_=self.lab_signup(token,f'member{i}@example.test');self.assertEqual(status,200)
            self.assertEqual(self.lab_signup(token,f'reuse{i}@example.test')[1],403)
            self.assertFalse(member.call('/api/session')[1]['canInviteLab'])
            projects=member.call('/api/projects')[1]['projects'];self.assertEqual(len(projects),1)
            self.assertEqual(projects[0]['role'],'owner');ids.append(projects[0]['id'])
            self.assertEqual(member.call(self.base)[0],404)
            self.assertEqual(self.owner.call('/api/projects/'+ids[-1])[0],404)
            if i:self.assertEqual(member.call('/api/projects/'+ids[0])[0],404)
            for method in ('GET','POST','DELETE'):
                self.assertEqual(member.call('/api/lab-invite',method,{} if method!='GET' else None)[0],403)
            status,created=member.call('/api/projects','POST',{'name':'My independent paper','template':False});self.assertEqual(status,200)
            own='/api/projects/'+created['id']
            self.assertEqual(member.call(own+'/file','PUT',{'path':'main.tex','revision':1,'content':'My independent edits'})[0],200)
        self.assertNotEqual(ids[0],ids[1])
        self.assertEqual(len(self.owner.call('/api/projects')[1]['projects']),1)
        meta=self.owner.call('/api/lab-invite')[1]['invitations']
        self.assertEqual(sum(bool(x['used_by']) for x in meta),2)
        self.assertTrue(all('token' not in x for x in meta))
    def test_lab_invitation_expiry_revocation_and_invalid_tokens(self):
        self.assertEqual(Client(self.port).call('/api/lab-invite')[0],401)
        links=self.owner.call('/api/lab-invite','POST',{'count':3})[1]['links']
        self.assertEqual(self.lab_signup('made-up','invalid@example.test')[1],403)
        with self.app.db() as db:db.execute('UPDATE lab_invites SET expires=0 WHERE id=?',(links[0]['id'],))
        self.assertEqual(self.lab_signup(links[0]['url'].split('#signup=')[1],'expired@example.test')[1],403)
        self.assertEqual(self.owner.call('/api/lab-invite','DELETE',{'id':links[1]['id']})[0],200)
        self.assertEqual(self.lab_signup(links[1]['url'].split('#signup=')[1],'revoked@example.test')[1],403)
        self.assertEqual(self.lab_signup(links[2]['url'].split('#signup=')[1],'valid@example.test')[1],200)
        with self.app.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM users').fetchone()[0],2)
    def test_existing_installation_migration_preserves_accounts_and_projects(self):
        with self.app.db() as db:
            before=[tuple(row) for row in db.execute('SELECT * FROM files ORDER BY project_id,path')]
            db.execute('DROP TABLE settings');db.execute('DROP TABLE lab_invites')
        other=App(self.tmp.name,f'http://127.0.0.1:{self.port}')
        with other.db() as db:
            owner=dict(db.execute('SELECT id FROM users ORDER BY rowid LIMIT 1').fetchone())
            self.assertTrue(other.is_lab_admin(db,owner))
            self.assertEqual(before,[tuple(row) for row in db.execute('SELECT * FROM files ORDER BY project_id,path')])
        self.assertEqual(self.owner.call(self.base)[0],200)
    def test_shared_roles_invite_reuse_and_revocation(self):
        viewer,token=self.invite('viewer')
        self.assertEqual(viewer.call(self.base)[0],200)
        self.assertEqual(viewer.call(self.base+'/file','PUT',{'path':'main.tex','content':'BAD','revision':1})[0],403)
        self.assertEqual(viewer.call(self.base+'/compile','POST',{})[0],403)
        self.assertEqual(viewer.call(self.base+'/invite','POST',{'role':'editor'})[0],403)
        newcomer=Client(self.port)
        self.assertEqual(newcomer.call('/api/register-lab','POST',{'token':token,'name':'Reuse','email':'reuse@example.test','password':'long-test-password'})[0],403)
        uid=viewer.call('/api/session')[1]['user']['id']
        self.assertEqual(self.owner.call(self.base+'/members','DELETE',{'userId':uid})[0],200)
        self.assertEqual(viewer.call(self.base)[0],404)
    def test_save_conflict_and_history(self):
        editor,_=self.invite('editor')
        payload={'path':'main.tex','revision':1,'content':'First edit'}
        self.assertEqual(self.owner.call(self.base+'/file','PUT',payload)[0],200)
        payload['content']='Stale edit'
        self.assertEqual(editor.call(self.base+'/file','PUT',payload)[0],409)
        self.assertEqual(self.owner.call(self.base+'/file?path=main.tex')[1]['content'],'First edit')
        versions=self.owner.call(self.base+'/history?path=main.tex')[1]['versions']
        self.assertEqual(len(versions),1)
        previous=self.owner.call(self.base+'/history?path=main.tex&id='+str(versions[0]['id']))[1]['content']
        self.assertIn('documentclass',previous)
    def test_file_operations_binary_and_source_zip(self):
        blob=b'\x89PNG\x00image'
        self.assertEqual(self.owner.call(self.base+'/file','PUT',{'path':'figures/test.png','base64':base64.b64encode(blob).decode(),'revision':0})[0],200)
        got=self.owner.call(self.base+'/file?path=figures/test.png')[1];self.assertIsNone(got['content']);self.assertEqual(base64.b64decode(got['base64']),blob)
        self.assertEqual(self.owner.call(self.base+'/rename','POST',{'path':'figures/test.png','newPath':'figures/renamed.png','revision':1})[0],200)
        raw=self.owner.call(self.base+'/source.zip')[1]
        with zipfile.ZipFile(io.BytesIO(raw)) as z:self.assertEqual(z.read('figures/renamed.png'),blob)
        self.assertEqual(self.owner.call(self.base+'/file','DELETE',{'path':'main.tex','revision':1})[0],400)
        self.assertEqual(self.owner.call(self.base+'/file','PUT',{'path':'../escape.tex','content':'no','revision':0})[0],400)
    def test_zip_import_and_project_isolation(self):
        output=io.BytesIO()
        with zipfile.ZipFile(output,'w') as z:
            z.writestr('paper/main.tex',SAMPLE['main.tex']);z.writestr('paper/references.bib',SAMPLE['references.bib'])
        status,result=self.owner.call('/api/projects','POST',{'name':'Imported','zip':base64.b64encode(output.getvalue()).decode()})
        self.assertEqual(status,200);p=self.owner.call('/api/projects/'+result['id'])[1];self.assertEqual(p['main'],'main.tex');self.assertEqual(len(p['files']),2)
        member,_=self.invite('editor');self.assertEqual(member.call('/api/projects/'+result['id'])[0],404)
    def test_compile_pdf_and_failed_build_does_not_return_stale_pdf(self):
        os.environ['LATEX_ENGINE']=os.getenv('TEST_LATEX_ENGINE','pdflatex')
        status,result=self.owner.call(self.base+'/compile','POST',{})
        self.assertEqual(status,200);self.assertTrue(result['success'],result['log'][-4000:])
        status,pdf=self.owner.call(self.base+'/pdf');self.assertEqual(status,200);self.assertTrue(pdf.startswith(b'%PDF'))
        self.owner.call(self.base+'/file','PUT',{'path':'main.tex','revision':1,'content':r'\documentclass{article}\begin{document}\nonexistentmacro\end{document}'})
        status,result=self.owner.call(self.base+'/compile','POST',{});self.assertEqual(status,200);self.assertFalse(result['success'])
        self.assertEqual(self.owner.call(self.base+'/pdf')[0],404)
    def test_durable_data_after_reopen(self):
        self.owner.call(self.base+'/file','PUT',{'path':'main.tex','revision':1,'content':'Persist me'})
        other=App(self.tmp.name,f'http://127.0.0.1:{self.port}')
        with other.db() as db:self.assertEqual(db.execute('SELECT content FROM files WHERE project_id=? AND path=?',(self.pid,'main.tex')).fetchone()[0],b'Persist me')
class ValidationTests(unittest.TestCase):
    def test_paths(self):
        for p in ('../x','/tmp/x','a/../../x','a//b','.env','-flag.tex','a\\b.tex','_labtex_output/a.tex'):
            with self.subTest(p=p),self.assertRaises(Problem):safe_path(p)
        self.assertEqual(safe_path('sections/my paper.tex'),'sections/my paper.tex')
    def test_zip_traversal_and_symlinks(self):
        for path,symlink in [('../escape.tex',False),('link.tex',True)]:
            raw=io.BytesIO()
            with zipfile.ZipFile(raw,'w') as z:
                entry=zipfile.ZipInfo(path)
                if symlink:entry.external_attr=0o120777<<16
                z.writestr(entry,'payload')
            with self.assertRaises(Problem):unpack_zip(raw.getvalue())
    def test_shell_escape_disabled(self):
        os.environ['LATEX_ENGINE']=os.getenv('TEST_LATEX_ENGINE','pdflatex')
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory)/'escaped'
            tex=('\\documentclass{article}\\begin{document}\\immediate\\write18{touch '+str(marker)+'}Safe\\end{document}').encode()
            r=compile_project({'main.tex':tex},'main.tex');self.assertTrue(r['success']);self.assertFalse(marker.exists())
    def test_read_outside_project_blocked(self):
        os.environ['LATEX_ENGINE']=os.getenv('TEST_LATEX_ENGINE','pdflatex')
        r=compile_project({'main.tex':b'\\documentclass{article}\\begin{document}\\input{/etc/hostname}\\end{document}'},'main.tex')
        self.assertFalse(r['success'])
if __name__=='__main__':unittest.main()
