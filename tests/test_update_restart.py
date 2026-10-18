"""Real Mac launcher restart/rollback against disposable, fictional installations."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import zipfile

from deploy.updates import MARKER,REPOSITORY,read_json,write_json
from test_app import Client

ROOT=Path(__file__).resolve().parents[1]
TOOLS=[Path(os.getenv(key,'')) for key in ('TYPST_BIN','TECTONIC_BIN','TINYMIST_BIN')]


@unittest.skipUnless(sys.platform=='darwin' and all(path.is_file() for path in TOOLS),'Real local Mac compiler installation is required')
class UpdateRestartTests(unittest.TestCase):
    def test_real_launcher_update_and_failed_start_recovery(self):
        removed=set(subprocess.check_output(['git','diff','--name-only','--diff-filter=D','-z'],cwd=ROOT).decode().split('\0'))
        names=[name for name in subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0') if name and name not in removed]
        public={name:(ROOT/name).read_bytes() for name in names}
        for failure in (False,True):
            with self.subTest(failure=failure),tempfile.TemporaryDirectory(prefix='idsl-updater-restart-') as directory:
                root=Path(directory).resolve();state=root/'.local';state.mkdir();(state/'bin').mkdir()
                for name,path in zip(('typst','tectonic','tinymist'),TOOLS):(state/'bin'/name).symlink_to(path)
                with __import__('socket').socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
                def package(files,version):
                    files={**files,'VERSION':(version+'\n').encode()};manifest={'schema':1,'repository':REPOSITORY,'version':version,'commit':('b' if version=='1.1.0' else 'a')*40,'files':{name:hashlib.sha256(raw).hexdigest() for name,raw in files.items()}}
                    buffer=io.BytesIO()
                    with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as archive:
                        for name,raw in {**files,MARKER:json.dumps(manifest).encode()}.items():archive.writestr('idsl-latex/'+name,raw)
                    return buffer.getvalue()
                new=dict(public)
                if failure:new['server.py']=b"import os,sqlite3\nwith sqlite3.connect(os.environ['DATA_DIR']+'/labtex.sqlite3') as db: db.execute(\"UPDATE projects SET name='Trial migration'\")\nraise RuntimeError('Fictional startup failure')\n"
                raw=package(new,'1.1.0');(state/'fixture-release.zip').write_bytes(raw)
                metadata={'tag_name':'v1.1.0','draft':False,'prerelease':False,'body':'Fictional release','assets':[{'name':'idsl-latex-v1.1.0.zip','state':'uploaded','size':len(raw),'digest':'sha256:'+hashlib.sha256(raw).hexdigest()}]};(state/'fixture-metadata.json').write_text(json.dumps(metadata))
                updater=public['deploy/updates.py'].decode();start=updater.index('def request(');end=updater.index('\n\ndef latest(',start)
                fixture='''def request(url,etag=None):
    import io
    class Response(io.BytesIO):headers={'ETag':'fixture'}
    state=Path(os.environ['LABTEX_LOCAL_MANAGED_ROOT'])/'.local'
    return Response((state/('fixture-metadata.json' if url==RELEASES else 'fixture-release.zip')).read_bytes())
'''
                old={**public,'deploy/updates.py':(updater[:start]+fixture+updater[end:]).encode()};archive=io.BytesIO(package(old,'1.0.0'))
                with zipfile.ZipFile(archive) as source:
                    for name in source.namelist():
                        target=root/name.removeprefix('idsl-latex/');target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(source.read(name))
                (root/'labtex').chmod(0o700);write_json(state/'updates.json',{'automatic':False})
                env={key:value for key,value in os.environ.items() if key in ('PATH','HOME','LANG','SSL_CERT_FILE','SSL_CERT_DIR')}
                env['PYTHONDONTWRITEBYTECODE']='1'
                def local(*args):return subprocess.run([sys.executable,str(root/'labtex'),'local',*args],cwd=root,env=env,capture_output=True,text=True,timeout=60)
                try:
                    self.assertEqual(local('start','--port',str(port)).returncode,0)
                    token=(state/'setup-token').read_text().strip();client=Client(port)
                    self.assertEqual(client.call('/api/setup','POST',{'token':token,'name':'Fictional owner','email':'restart@example.test','password':'fictional-restart-password'})[0],200)
                    pid=client.call('/api/projects')[1]['projects'][0]['id'];base='/api/projects/'+pid
                    self.assertEqual(client.call(base,'PUT',{'name':'Original fixture'})[0],200)
                    self.assertEqual(client.call(base+'/file','PUT',{'path':'note.typ','content':'= Private fictional source','revision':0})[0],200)
                    code,status=client.call('/api/app-update/check','POST',{});self.assertEqual(code,200,status);self.assertTrue(status['canInstall'],status)
                    code,result=client.call('/api/app-update/install','POST',{'confirm':True,'version':'1.1.0','digest':'sha256:'+hashlib.sha256(raw).hexdigest()});self.assertEqual(code,200,result)
                    deadline=time.monotonic()+90
                    while time.monotonic()<deadline:
                        job=read_json(state/'updates/job.json')
                        if job.get('phase') in ('complete','rolled_back','error'):break
                        time.sleep(.2)
                    self.assertEqual(job.get('phase'),'rolled_back' if failure else 'complete',job.get('message'))
                    deadline=time.monotonic()+30
                    while time.monotonic()<deadline:
                        try:
                            code,health=client.call('/api/app-update/health')
                            if code==200 and health['version']==('1.0.0' if failure else '1.1.0'):break
                        except (OSError,Exception):time.sleep(.1)
                    self.assertEqual(client.call(base)[1]['name'],'Original fixture');self.assertEqual(client.call(base+'/file?path=note.typ')[1]['content'],'= Private fictional source')
                    self.assertEqual((state/'setup-token').read_text().strip(),token);self.assertTrue((state/'updates/rollback/database.sqlite3').is_file())
                finally:local('stop')
