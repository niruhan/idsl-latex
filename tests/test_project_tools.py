import base64
import io
import json
import unittest
import zipfile
from unittest.mock import patch

import test_app
from core import Problem
from doi_metadata import lookup_doi, normalize_doi
from github_backup import MANIFEST
from github_restore import inspect_backups, read_snapshot, source_diff
from test_github_backup import FakeGitHub


class ReadGitHub(FakeGitHub):
    def __init__(self, files):
        super().__init__(files)
        self.head='a'*40

    def call(self, path, method='GET', data=None):
        if '/git/commits/' in path:
            return {'tree':{'sha':'b'*40}}
        return super().call(path,method,data)


class ProjectToolsTests(unittest.TestCase):
    setUp=test_app.AppTests.setUp
    tearDown=test_app.AppTests.tearDown
    invite=test_app.AppTests.invite
    lab_signup=test_app.AppTests.lab_signup

    def project(self):
        return self.owner.call(self.base)[1]

    def test_atomic_batch_history_checkpoint_and_conflicts(self):
        before=self.project()
        changes=[{'path':'main.tex','content':'Updated source','revision':1},{'path':'sections/new.typ','content':'= A section','revision':0}]
        body={'revision':before['revision'],'files':changes}
        status,result=self.owner.call(self.base+'/edit-files','POST',body)
        self.assertEqual(status,200,result)
        self.assertEqual(self.owner.call(self.base+'/file?path=main.tex')[1]['content'],'Updated source')
        self.assertTrue(self.owner.call(self.base+'/history?path=main.tex')[1]['versions'])
        status,archive=self.owner.call(self.base+'/checkpoints/'+str(result['checkpoint'])+'.zip')
        self.assertEqual(status,200)
        with zipfile.ZipFile(io.BytesIO(archive)) as source:
            self.assertNotEqual(source.read('main.tex'),b'Updated source')
            self.assertNotIn('sections/new.typ',source.namelist())
        self.assertEqual(self.owner.call(self.base+'/edit-files','POST',body)[0],409)
        current=self.project()
        bad={'revision':current['revision'],'files':[{'path':'main.tex','content':'Must roll back','revision':2},{'path':'../outside','content':'Bad','revision':0}]}
        self.assertEqual(self.owner.call(self.base+'/edit-files','POST',bad)[0],400)
        self.assertEqual(self.owner.call(self.base+'/file?path=main.tex')[1]['content'],'Updated source')
        viewer,_=self.invite('viewer')
        self.assertEqual(viewer.call(self.base+'/sources')[0],200)
        self.assertEqual(viewer.call(self.base+'/edit-files','POST',body)[0],403)
        self.assertEqual(test_app.Client(self.port).call(self.base+'/sources')[0],401)

    def remote(self):
        metadata={'version':1,'project_id':self.pid,'name':'A fictional backup','main':'main.tex','files':['main.tex','figure.png']}
        return ReadGitHub({'projects/Paper/'+MANIFEST:json.dumps(metadata).encode(),'projects/Paper/main.tex':b'Remote source','projects/Paper/figure.png':b'\x89PNG\0example','projects/Paper/extra.typ':b'= Added remotely','projects/Other/secret.tex':b'Unrelated','README.md':b'Unrelated repository file'})

    def test_github_inspection_pin_diff_selective_pull_and_recovery(self):
        remote=self.remote();target={'repository':'example/papers','branch':''}
        listing=inspect_backups(remote,target)
        self.assertEqual(listing['projects'][0]['folder'],'projects/Paper')
        snapshot=read_snapshot(remote,target,'projects/Paper',listing['commit'])
        self.assertEqual(set(snapshot['files']),{'main.tex','figure.png','extra.typ'})
        self.assertTrue(all(method=='GET' for _,method,_ in remote.calls))
        self.app.tokens.set(self.project()['owner'],'fictional-token-for-tests')
        body={**target,'commit':listing['commit'],'folder':'projects/Paper','projectId':self.pid}
        before=self.owner.call(self.base+'/file?path=main.tex')[1]['content']
        with patch('server.GitHub',return_value=remote):
            status,plan=self.owner.call('/api/github-preview','POST',body)
        self.assertEqual(status,200,plan)
        self.assertEqual(self.owner.call(self.base+'/file?path=main.tex')[1]['content'],before)
        status,diff=self.owner.call('/api/github-diff','POST',{'planId':plan['planId'],'path':'main.tex'})
        self.assertEqual(status,200,diff);self.assertIn('+Remote source',diff['diff'])
        status,result=self.owner.call('/api/github-apply','POST',{'planId':plan['planId'],'paths':['main.tex','figure.png']})
        self.assertEqual(status,200,result)
        self.assertEqual(self.owner.call(self.base+'/file?path=main.tex')[1]['content'],'Remote source')
        self.assertEqual(self.owner.call(self.base+'/file?path=extra.typ')[0],404)
        self.assertIsNotNone(result['checkpoint'])
        self.assertEqual(self.owner.call('/api/github-apply','POST',{'planId':plan['planId'],'paths':['main.tex']})[0],404)

    def test_pull_stale_plan_and_restore_new_independent_project(self):
        remote=self.remote();self.app.tokens.set(self.project()['owner'],'fictional-token-for-tests')
        body={'repository':'example/papers','branch':'main','commit':'a'*40,'folder':'projects/Paper','projectId':self.pid}
        with patch('server.GitHub',return_value=remote):
            plan=self.owner.call('/api/github-preview','POST',body)[1]
        self.owner.call(self.base,'PUT',{'name':'Concurrent rename'})
        self.assertEqual(self.owner.call('/api/github-apply','POST',{'planId':plan['planId'],'paths':['main.tex']})[0],409)
        viewer,_=self.invite('viewer')
        self.assertEqual(viewer.call('/api/github-diff','POST',{'planId':plan['planId'],'path':'main.tex'})[0],404)
        with patch('server.GitHub',return_value=remote):
            plan=self.owner.call('/api/github-preview','POST',{**body,'projectId':None})[1]
        self.assertEqual(self.owner.call('/api/github-apply','POST',{'planId':plan['planId'],'paths':['extra.typ']})[0],400)
        status,result=self.owner.call('/api/github-apply','POST',{'planId':plan['planId'],'paths':['main.tex','extra.typ'],'name':'Restored copy'})
        self.assertEqual(status,200,result);self.assertNotEqual(result['id'],self.pid)
        restored='/api/projects/'+result['id']
        self.assertEqual(self.owner.call(restored)[1]['name'],'Restored copy')
        self.assertEqual(self.owner.call(restored+'/file?path=extra.typ')[1]['content'],'= Added remotely')
        self.assertEqual(viewer.call(restored)[0],404)

    def test_unsafe_remote_paths_links_truncation_and_binary_diff(self):
        remote=self.remote();remote.truncated=True
        with self.assertRaises(Problem):inspect_backups(remote,{'repository':'example/papers'})
        remote=self.remote();remote.entries['projects/Paper/main.tex']['mode']='120000'
        with self.assertRaises(Problem):read_snapshot(remote,{'repository':'example/papers'},'projects/Paper','a'*40)
        self.assertTrue(source_diff('image.png',b'\0old',b'\0new')['binary'])
        self.assertTrue(source_diff('large.typ',b'a'*400001,b'b')['truncated'])

    def test_root_backup_excludes_other_project_snapshots_and_checks_blob_bytes(self):
        metadata={'version':1,'project_id':self.pid,'name':'Root example','main':'main.tex','files':['main.tex']}
        remote=ReadGitHub({MANIFEST:json.dumps(metadata).encode(),'main.tex':b'Root source','projects/Other/'+MANIFEST:json.dumps({**metadata,'project_id':'f'*24}).encode(),'projects/Other/main.tex':b'Other private document','.github/workflows/test.yml':b'Not compiler source'})
        snapshot=read_snapshot(remote,{'repository':'example/papers'},'','a'*40)
        self.assertEqual(snapshot['files'],{'main.tex':b'Root source'})
        sha=remote.entries['main.tex']['sha'];remote.blobs[sha]=b'Mismatched content'
        with self.assertRaises(Problem):read_snapshot(remote,{'repository':'example/papers'},'','a'*40)


class DoiTests(unittest.TestCase):
    def test_registry_url_and_bibtex_preview(self):
        with patch('doi_metadata.fetch',return_value='@article{example2026, title={Example}}') as fetch:
            result=lookup_doi('https://doi.org/10.5555/example')
            self.assertEqual(result['provider'],'Crossref')
            self.assertEqual(fetch.call_args[0][0],'https://api.crossref.org/works/10.5555%2Fexample/transform/application/x-bibtex')
        for value in ('https://private.example.test/path','file:///etc/passwd','10.123/x\nheader',None):
            with self.assertRaises(Problem):normalize_doi(value)

    def test_datacite_fallback_missing_and_bad_records(self):
        metadata=json.dumps({'data':{'attributes':{'titles':[{'title':'Example dataset'}],'creators':[{'familyName':'Example','givenName':'Alex'}],'publicationYear':2026}}})
        with patch('doi_metadata.fetch',side_effect=[None,metadata]):
            result=lookup_doi('10.5555/example')
            self.assertEqual(result['provider'],'DataCite');self.assertIn('Example2026',result['bibtex'])
        with patch('doi_metadata.fetch',side_effect=[None,None]):
            with self.assertRaises(Problem):lookup_doi('10.5555/missing')
        with patch('doi_metadata.fetch',return_value='<html>Not metadata</html>'):
            with self.assertRaises(Problem):lookup_doi('10.5555/invalid')
