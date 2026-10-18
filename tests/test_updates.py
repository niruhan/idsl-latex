import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from contextlib import closing

import test_app
from deploy import updates as u
from scripts.build_release import build


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();(self.root/'VERSION').write_text('1.0.0\n');(self.root/'.local').mkdir()
        self.manager=u.Updates(self.root,self.root/'.local',enabled=True)
    def tearDown(self):self.manager.close();self.temp.cleanup()

    def package(self,version='1.1.0',extras=None):
        files={'VERSION':(version+'\n').encode(),'labtex':b'# fictional launcher','server.py':b'# source','deploy/local.py':b'# local','deploy/local-dependencies.json':b'{}',**(extras or {})}
        meta={'schema':1,'repository':u.REPOSITORY,'version':version,'commit':'a'*40,'files':{name:hashlib.sha256(value).hexdigest() for name,value in files.items()}}
        output=io.BytesIO()
        with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
            for name,value in {**files,u.MARKER:json.dumps(meta).encode()}.items():archive.writestr('idsl-latex/'+name,value)
        raw=output.getvalue();release={'tag':'v'+version,'version':version,'digest':'sha256:'+hashlib.sha256(raw).hexdigest(),'size':len(raw),'download':'https://github.com/'+u.REPOSITORY+'/releases/download/v'+version+'/idsl-latex-v'+version+'.zip','url':'https://github.com/'+u.REPOSITORY+'/releases/tag/v'+version,'notes':'Fictional release'}
        return raw,release,meta

    def old_install(self):
        raw,release,metadata=self.package('1.0.0',{'old.py':b'# obsolete'})
        archive=self.root/'.local/old.zip';archive.write_bytes(raw);u.unpack_release(archive,self.root,release)
        self.manager.current=u.installation(self.root)
        data=self.root/'data';data.mkdir();db=sqlite3.connect(data/'labtex.sqlite3');db.execute('CREATE TABLE example(value TEXT)');db.execute('INSERT INTO example VALUES(?)',('private fictional project',));db.commit();db.close()
        (self.root/'.local/local.json').write_text('{"port":8765}')
        (self.root/'.local/preference').write_text('retained')

    def approved_job(self,release):
        job={'id':'1'*32,'phase':'download','message':'','version':release['version'],'release':release,'root':str(self.root),'pid':12345,'previous':u.installation(self.root)}
        u.write_json(self.root/'.local/updates/job.json',job);return job

    def test_daily_cache_manual_throttle_preference_no_automatic_install(self):
        _,release,_=self.package()
        with patch.object(u,'latest',return_value=(release,'etag')) as latest,patch.object(u.subprocess,'Popen') as spawn:
            self.manager.check();self.manager.check();self.assertEqual(latest.call_count,1);self.assertTrue(self.manager.status(True)['available']);spawn.assert_not_called()
            self.manager.check(force=True);self.assertEqual(latest.call_count,1)
            self.manager.cache['attempted']=0;self.manager.check(force=True);self.assertEqual(latest.call_count,2)
            self.manager.preference(False);self.assertFalse(u.read_json(self.root/'.local/updates.json')['automatic'])
        self.assertGreater(u.version('1.1.0'),u.version('1.1.0-dev'));self.assertGreater(u.version('1.0.0'),u.version('0.99.99'))

    def test_explicit_matching_approval_and_unchanged_source_are_required(self):
        self.old_install();_,release,_=self.package();self.manager.cache['release']=release
        with patch.object(u.subprocess,'Popen') as spawn:
            for approval in ({},{'confirm':False},{'confirm':True,'version':'9.0.0','digest':release['digest']}):
                with self.assertRaises(ValueError):self.manager.install(approval)
            spawn.assert_not_called()
            (self.root/'server.py').write_text('# my changes')
            with self.assertRaises(ValueError):self.manager.install({'confirm':True,'version':release['version'],'digest':release['digest']})
            spawn.assert_not_called()
        self.assertIn('Local code changes',u.installation(self.root)['reason'])

    def test_package_checksums_private_paths_traversal_and_symlinks_rejected(self):
        for extras in ({'../escape.py':b'x'},{'data/private.tex':b'x'},{'.local/token':b'x'}):
            raw,release,_=self.package(extras=extras);path=self.root/'.local/release.zip';path.write_bytes(raw)
            with self.assertRaises(ValueError):u.unpack_release(path,self.root/'staging',release)
        raw,release,_=self.package();path=self.root/'.local/release.zip';path.write_bytes(raw)
        with self.assertWarns(UserWarning),zipfile.ZipFile(path,'a') as archive:archive.writestr('idsl-latex/server.py',b'changed after hashing')
        with self.assertRaises(ValueError):u.unpack_release(path,self.root/'staging2',release)
        raw,release,_=self.package();path.write_bytes(raw)
        with zipfile.ZipFile(path,'a') as archive:
            link=zipfile.ZipInfo('idsl-latex/link.py');link.external_attr=0o120777<<16;archive.writestr(link,b'outside')
        with self.assertRaises(ValueError):u.unpack_release(path,self.root/'staging3',release)
        with self.assertRaises(ValueError):u.ReleaseRedirect().redirect_request(None,None,302,'',{},'https://example.test/private')

    def run_update(self,fail=False):
        self.old_install();raw,release,_=self.package(extras={'new.py':b'# newly added source'});job=self.approved_job(release);started=[]
        def start(root,expected,**kwargs):
            started.append(expected)
            if fail and expected=='1.1.0':
                with closing(sqlite3.connect(root/'data/labtex.sqlite3')) as db,db:db.execute('UPDATE example SET value="broken trial migration"')
                raise RuntimeError('Fictional startup failure')
        with patch.object(u,'request',return_value=io.BytesIO(raw)),patch.object(u.os,'kill'),patch.object(u,'wait_stopped'),patch.object(u,'wait_idle'),patch.object(u,'start_app',side_effect=start),patch.object(u.time,'sleep'):
            u.apply(self.root,job['id'])
        state=u.read_json(self.root/'.local/updates/job.json');self.assertEqual(state['phase'],'rolled_back' if fail else 'complete')
        self.assertEqual((self.root/'VERSION').read_text().strip(),'1.0.0' if fail else '1.1.0')
        with closing(sqlite3.connect(self.root/'data/labtex.sqlite3')) as db,db:self.assertEqual(db.execute('SELECT value FROM example').fetchone()[0],'private fictional project')
        self.assertEqual((self.root/'.local/preference').read_text(),'retained');self.assertTrue((self.root/'.local/updates/rollback/database.sqlite3').exists())
        self.assertEqual((self.root/'old.py').exists(),fail)
        self.assertEqual((self.root/'new.py').exists(),not fail)
        return started

    def test_archive_install_preserves_data_and_settings(self):self.assertEqual(self.run_update(),['1.1.0'])
    def test_failed_start_rolls_back_source_and_database(self):self.assertEqual(self.run_update(True),['1.1.0','1.0.0'])

    def test_archive_update_does_not_overwrite_untracked_local_files(self):
        self.old_install();(self.root/'personal.py').write_text('local untracked code')
        raw,release,_=self.package(extras={'personal.py':b'new upstream code'});job=self.approved_job(release)
        with patch.object(u,'request',return_value=io.BytesIO(raw)),patch.object(u.os,'kill') as stop:
            u.apply(self.root,job['id']);stop.assert_not_called()
        self.assertEqual((self.root/'personal.py').read_text(),'local untracked code');self.assertEqual(u.read_json(self.root/'.local/updates/job.json')['phase'],'error')

    def test_download_checksum_failure_keeps_running_app_and_previous_backup(self):
        self.old_install();raw,release,_=self.package();job=self.approved_job(release)
        backup=self.root/'.local/updates/rollback';backup.mkdir();(backup/'retained').write_text('previous rollback snapshot')
        with patch.object(u,'request',return_value=io.BytesIO(raw+b'corrupt')),patch.object(u.os,'kill') as stop:
            u.apply(self.root,job['id']);stop.assert_not_called()
        self.assertEqual((self.root/'VERSION').read_text().strip(),'1.0.0');self.assertTrue((backup/'retained').is_file())
        self.assertEqual(u.read_json(self.root/'.local/updates/job.json')['phase'],'error')

    def test_interrupted_recovery_is_visible_without_leaking_private_job_details(self):
        self.old_install();_,release,_=self.package();self.manager.cache['release']=release
        job=self.approved_job(release);job.update(phase='error',recoveryRequired=True)
        u.write_json(self.root/'.local/updates/job.json',job);status=self.manager.status(True)
        self.assertFalse(status['canInstall']);self.assertIn('Recover',status['reason'])
        self.assertTrue(status['job']['recoveryRequired']);self.assertNotIn('root',status['job']);self.assertNotIn('pid',status['job']);self.assertNotIn('previous',status['job'])

    def test_git_build_is_immutable_source_only_and_detects_dirty_checkout(self):
        def git(*args):return subprocess.check_output(['git',*args],cwd=self.root,text=True).strip()
        git('init','-q');git('config','user.email','fixture@example.test');git('config','user.name','Example');git('remote','add','origin','https://github.com/'+u.REPOSITORY+'.git')
        for name,value in {'labtex':'# launcher','server.py':'# server','deploy/local.py':'# local','.gitignore':'.local/\ndata/\n'}.items():
            path=self.root/name;path.parent.mkdir(exist_ok=True,parents=True);path.write_text(value)
        git('add','.');git('commit','-qm','Fictional release');git('tag','v1.0.0');self.assertFalse(u.installation(self.root)['reason'])
        (self.root/'data').mkdir();(self.root/'data/private.tex').write_text('Never packaged');package=build(self.root,'v1.0.0',self.root/'.local/out')
        with zipfile.ZipFile(package) as archive:
            self.assertFalse(any('/data/' in name or '/.local/' in name for name in archive.namelist()));self.assertIn('idsl-latex/'+u.MARKER,archive.namelist())
        (self.root/'server.py').write_text('# local edits');self.assertIn('Local code changes',u.installation(self.root)['reason'])
        with self.assertRaises(ValueError):build(self.root,'HEAD',self.root/'.local/out')

    def test_git_fast_forward_and_rollback_preserve_private_runtime(self):
        def command(*args):return subprocess.check_output(['git',*args],cwd=self.root,text=True).strip()
        command('init','-q');command('config','user.email','fixture@example.test');command('config','user.name','Example');command('remote','add','origin','https://github.com/'+u.REPOSITORY+'.git')
        for name,value in {'labtex':'# launcher','server.py':'# old server','deploy/local.py':'# local','deploy/local-dependencies.json':'{}','.gitignore':'.local/\ndata/\n'}.items():
            path=self.root/name;path.parent.mkdir(exist_ok=True,parents=True);path.write_text(value)
        command('add','.');command('commit','-qm','Old fictional release');old=command('rev-parse','HEAD')
        (self.root/'VERSION').write_text('1.1.0\n');(self.root/'server.py').write_text('# new server');command('add','.');command('commit','-qm','New fictional release');command('tag','v1.1.0');target=command('rev-parse','HEAD')
        package=build(self.root,'v1.1.0',self.root/'.local/out');raw=package.read_bytes();release={'tag':'v1.1.0','version':'1.1.0','size':len(raw),'digest':'sha256:'+hashlib.sha256(raw).hexdigest(),'download':'https://github.com/'+u.REPOSITORY+'/releases/download/v1.1.0/'+package.name}
        command('checkout','--detach',old);(self.root/'data').mkdir();(self.root/'data/private.txt').write_text('private fictional asset')
        real_git=u.git
        def git(root,*args):
            if args[0]=='fetch':return real_git(root,'update-ref',args[-1].split(':')[1],target)
            return real_git(root,*args)
        for failure in (False,True):
            command('reset','--keep',old);job=self.approved_job(release)
            def start(root,expected,**kwargs):
                if failure and expected=='1.1.0':raise RuntimeError('Fictional failed startup')
            with patch.object(u,'git',side_effect=git),patch.object(u,'request',return_value=io.BytesIO(raw)),patch.object(u.os,'kill'),patch.object(u,'wait_stopped'),patch.object(u,'wait_idle'),patch.object(u,'start_app',side_effect=start),patch.object(u.time,'sleep'):
                u.apply(self.root,job['id'])
            self.assertEqual(command('rev-parse','HEAD'),old if failure else target);self.assertEqual((self.root/'data/private.txt').read_text(),'private fictional asset')
            self.assertFalse(command('status','--porcelain'));self.assertEqual(u.read_json(self.root/'.local/updates/job.json')['phase'],'rolled_back' if failure else 'complete')


class UpdateHTTPTests(unittest.TestCase):
    setUp=test_app.AppTests.setUp
    tearDown=test_app.AppTests.tearDown
    invite=test_app.AppTests.invite
    lab_signup=test_app.AppTests.lab_signup

    def test_trial_startup_blocks_edits_until_verification_finishes(self):
        base='/api/projects/'+self.pid
        original=self.owner.call(base)[1]['name']
        with patch.object(self.app.updates,'blocked',return_value=True):
            self.assertEqual(self.owner.call(base,'PUT',{'name':'Blocked trial edit'})[0],503)
            self.assertEqual(self.owner.call('/api/app-update/health')[0],200)
            self.assertEqual(self.owner.call(base)[1]['name'],original)
        self.assertEqual(self.owner.call(base,'PUT',{'name':'Verified edit'})[0],200)

    def test_owner_only_checks_preferences_install_and_no_install_on_reads(self):
        self.assertEqual(test_app.Client(self.port).call('/api/app-update')[0],401)
        with patch.object(self.app.updates,'check') as check,patch.object(self.app.updates,'install') as install:
            self.assertEqual(self.owner.call('/api/app-update')[0],200);check.assert_not_called();install.assert_not_called()
            self.assertEqual(self.owner.call('/api/app-update/check','POST',{})[0],200);check.assert_called_once()
            viewer,_=self.invite('viewer')
            for path,method in (('/check','POST'),('/preferences','PUT'),('/install','POST')):self.assertEqual(viewer.call('/api/app-update'+path,method,{})[0],403)
            install.assert_not_called()
        self.assertEqual(self.owner.call('/api/app-update/install','POST',{'confirm':True})[0],409)
        self.assertEqual(self.owner.call('/api/app-update/preferences','PUT',{'automatic':False})[0],200)
        self.assertFalse(self.owner.call('/api/app-update')[1]['automatic'])
