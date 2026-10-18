import http.client
import json
import time
import unittest

import test_app


class PerformanceTests(unittest.TestCase):
    setUp=test_app.AppTests.setUp
    tearDown=test_app.AppTests.tearDown
    invite=test_app.AppTests.invite
    lab_signup=test_app.AppTests.lab_signup

    def metadata(self,tag=None,client=None):
        client=client or self.owner;conn=http.client.HTTPConnection('127.0.0.1',self.port)
        conn.request('GET',self.base,headers={'Cookie':client.cookie,**({'If-None-Match':tag} if tag else {})})
        response=conn.getresponse();raw=response.read();result=response.status,response.getheader('ETag'),raw;conn.close();return result

    def test_idle_metadata_skips_file_queries_without_bypassing_access_or_changes(self):
        status,tag,raw=self.metadata();self.assertEqual(status,200);self.assertTrue(tag)
        self.assertIn('files',json.loads(raw));self.assertEqual(self.metadata(tag),(304,tag,b''))
        self.owner.call(self.base+'/file','PUT',{'path':'new.typ','revision':0,'content':'= New'})
        status,new,raw=self.metadata(tag);self.assertEqual(status,200);self.assertNotEqual(new,tag);self.assertIn('new.typ',[file['path'] for file in json.loads(raw)['files']])
        # Build results can change even when project source revision does not.
        with self.app.db() as db:db.execute('INSERT OR REPLACE INTO builds VALUES(?,?,?,?,?,?,?,?)',(self.pid,1,1,'',b'%PDF-fixture',.1,time.time(),'typst'))
        self.assertEqual(self.metadata(new)[0],200)
        viewer,_=self.invite('viewer');status,view_tag,_=self.metadata(client=viewer);self.assertEqual(status,200);self.assertNotEqual(view_tag,new)
        uid=viewer.call('/api/session')[1]['user']['id'];self.owner.call(self.base+'/members','DELETE',{'userId':uid});self.assertEqual(self.metadata(view_tag,viewer)[0],404)
        self.owner.call(self.base,'DELETE',{});self.assertEqual(self.metadata(new)[0],404)

    def test_expired_review_sources_are_released_without_new_reviews(self):
        past=time.time()-1;future=time.time()+60
        for plans in (self.app.review_plans,self.app.collab.plans):
            plans.update(expired={'expires':past,'busy':False,'files':b'fictional source'},running={'expires':past,'busy':True},live={'expires':future,'busy':False})
        self.app.cleanup_reviews(force=True)
        for plans in (self.app.review_plans,self.app.collab.plans):self.assertEqual(set(plans),{'running','live'})

    def test_only_public_static_assets_use_revalidated_browser_cache(self):
        conn=http.client.HTTPConnection('127.0.0.1',self.port)
        conn.request('GET','/project-analysis.js');response=conn.getresponse();content=response.read();tag=response.getheader('ETag');kind=response.getheader('Content-Type')
        self.assertEqual(response.status,200);self.assertTrue(content);self.assertIn('no-cache',response.getheader('Cache-Control'));self.assertTrue(tag);conn.close()
        conn=http.client.HTTPConnection('127.0.0.1',self.port);conn.request('GET','/project-analysis.js',headers={'If-None-Match':tag});response=conn.getresponse();self.assertEqual(response.status,304);self.assertEqual(response.getheader('Content-Type'),kind);self.assertEqual(response.read(),b'');conn.close()
        for conditional in (False,True):
            conn=http.client.HTTPConnection('127.0.0.1',self.port);conn.request('GET','/pdf-viewer.html',headers={'If-None-Match':pdf_tag} if conditional else {});response=conn.getresponse();response.read();pdf_tag=response.getheader('ETag');self.assertIn("font-src 'self' blob: data:",response.getheader('Content-Security-Policy'));conn.close()
        conn=http.client.HTTPConnection('127.0.0.1',self.port);conn.request('GET',self.base+'/file?path=main.tex',headers={'Cookie':self.owner.cookie});response=conn.getresponse();response.read();self.assertEqual(response.getheader('Cache-Control'),'no-store');conn.close()

    def test_hot_queries_have_project_scoped_indexes(self):
        with self.app.db() as db:
            for query,params,index in [
                ('SELECT id FROM history WHERE project_id=? ORDER BY id DESC',(self.pid,),'history_project'),
                ('SELECT id FROM history WHERE project_id=? AND path=? ORDER BY id DESC',(self.pid,'main.tex'),'history_file'),
                ('SELECT id FROM project_checkpoints WHERE project_id=? ORDER BY id DESC',(self.pid,),'checkpoints_project'),
            ]:
                plan=' '.join(row[3] for row in db.execute('EXPLAIN QUERY PLAN '+query,params));self.assertIn(index,plan);self.assertNotIn('TEMP B-TREE',plan)


if __name__=='__main__':unittest.main()
