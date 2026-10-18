"""Opt-in installation of public releases; no telemetry or runtime dependencies."""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from contextlib import closing

REPOSITORY='niruhan/idsl-latex'
RELEASES='https://api.github.com/repos/'+REPOSITORY+'/releases/latest'
INTERVAL=24*60*60
MAX_ARCHIVE=128*1024*1024
MAX_SOURCE=256*1024*1024
PRIVATE={'.git','.local','data','backups','artifacts','node_modules','__pycache__','.venv'}
MARKER='idsl-release.json'
TERMINAL={'complete','rolled_back','error'}


def read_json(path,default=None):
    try:return json.loads(path.read_text())
    except (OSError,ValueError):return {} if default is None else default


def write_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=path.with_name(path.name+'.tmp');temporary.write_text(json.dumps(value)+'\n');temporary.chmod(0o600);temporary.replace(path)


def version(value):
    match=re.fullmatch(r'v?(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:-([A-Za-z0-9.-]+))?',str(value))
    if not match:raise ValueError('Use a release version such as v1.2.3.')
    return tuple(map(int,match.group(1,2,3)))+(not bool(match[4]),)


def git(root,*args):
    env={key:value for key,value in os.environ.items() if key in ('PATH','HOME','LANG','SSL_CERT_FILE','SSL_CERT_DIR')}
    env.update(GIT_TERMINAL_PROMPT='0',GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull)
    result=subprocess.run(['git','-c','core.hooksPath='+os.devnull,'-c','credential.helper=',*args],cwd=root,env=env,capture_output=True,timeout=120)
    if result.returncode:raise RuntimeError('Git could not complete the update. Resolve local branch changes or update manually.')
    return result.stdout.decode().strip()


def fingerprint(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def source_path(root,name):
    if not isinstance(name,str):raise ValueError('Release contains an unsafe path.')
    parts=PurePosixPath(name).parts
    if (not parts or name.startswith('/') or '\\' in name or len(name)>300
        or any(part in ('','..','.') or part in PRIVATE for part in parts) or any(part.startswith('.env') for part in parts)):
        raise ValueError('Release contains an unsafe path.')
    target=root.joinpath(*parts)
    if any(parent.is_symlink() for parent in [target,*target.parents] if parent==root or root in parent.parents):raise ValueError('Release paths cannot contain symbolic links.')
    return target


def installation(root):
    result={'version':(root/'VERSION').read_text().strip() if (root/'VERSION').exists() else '0.0.0','commit':'','mode':'archive','reason':''}
    try:version(result['version'])
    except ValueError:result['version']='0.0.0'
    if (root/'.git').exists():
        result['mode']='git'
        try:
            result['commit']=git(root,'rev-parse','HEAD')
            origin=git(root,'remote','get-url','origin').removesuffix('.git').rstrip('/')
            if origin not in ('https://github.com/'+REPOSITORY,'git'+'@github.com:'+REPOSITORY):result['reason']='This checkout uses a different repository. Update it manually.'
            elif git(root,'status','--porcelain','--untracked-files=normal'):result['reason']='Local code changes are present. Commit or move them before installing an update.'
        except (OSError,subprocess.SubprocessError,RuntimeError):result['reason']='Git is unavailable or this checkout needs manual attention.'
    else:
        manifest=read_json(root/MARKER);result['commit']=manifest.get('commit','')
        if manifest.get('schema')!=1 or manifest.get('repository')!=REPOSITORY or not manifest.get('files'):result['reason']='Use an official release ZIP with an update manifest, or a Git clone, to enable installation here.'
        else:
            try:
                for name,sha in manifest['files'].items():
                    path=source_path(root,name)
                    if not path.is_file() or fingerprint(path)!=sha:raise ValueError()
            except (ValueError,OSError):result['reason']='Local code changes are present. Keep them before replacing this release.'
    return result


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        host=urllib.parse.urlsplit(newurl)
        if host.scheme!='https' or host.hostname not in ('github.com','api.github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'):
            raise ValueError('Unexpected release download redirect.')
        return super().redirect_request(req,fp,code,msg,headers,newurl)


def request(url,etag=None):
    headers={'User-Agent':'IDSL-Editor-Updates','Accept':'application/vnd.github+json'}
    if etag:headers['If-None-Match']=etag
    return urllib.request.build_opener(ReleaseRedirect()).open(urllib.request.Request(url,headers=headers),timeout=15)


def latest(previous):
    try:
        with request(RELEASES,previous.get('etag')) as response:
            raw=response.read(512*1024+1)
            if len(raw)>512*1024:raise ValueError('Release metadata is too large.')
            data=json.loads(raw);etag=response.headers.get('ETag')
    except urllib.error.HTTPError as error:
        if error.code==304:return previous.get('release'),previous.get('etag')
        if error.code==404:return None,None
        raise RuntimeError('GitHub is unavailable or rate-limited. Try again later.') from None
    if not isinstance(data,dict):raise ValueError('GitHub returned invalid release metadata.')
    if data.get('draft') or data.get('prerelease'):return None,etag
    tag=data.get('tag_name');version(tag)
    name='idsl-latex-'+tag+'.zip'
    assets=data.get('assets',[])
    if not isinstance(assets,list):raise ValueError('GitHub returned invalid release assets.')
    asset=next((asset for asset in assets if isinstance(asset,dict) and asset.get('name')==name and asset.get('state')=='uploaded'),{})
    digest=asset.get('digest','')
    downloadable=bool(re.fullmatch(r'sha256:[a-f0-9]{64}',digest) and type(asset.get('size')) is int and 0<asset['size']<=MAX_ARCHIVE)
    release={'tag':tag,'version':tag.removeprefix('v'),'notes':str(data.get('body') or '')[:16000],
             'url':'https://github.com/'+REPOSITORY+'/releases/tag/'+urllib.parse.quote(tag,safe=''),
             'asset':name,'digest':digest if downloadable else '', 'size':asset.get('size',0) if downloadable else 0,
             'download':'https://github.com/'+REPOSITORY+'/releases/download/'+urllib.parse.quote(tag,safe='')+'/'+name if downloadable else ''}
    return release,etag


def unpack_release(archive,destination,release):
    with zipfile.ZipFile(archive) as source:
        entries=[entry for entry in source.infolist() if not entry.is_dir()]
        markers=[entry for entry in entries if entry.filename==MARKER or entry.filename.endswith('/'+MARKER)]
        if len(markers)!=1 or len(entries)>6000 or sum(entry.file_size for entry in entries)>MAX_SOURCE:raise ValueError('Invalid or oversized release package.')
        prefix=markers[0].filename[:-len(MARKER)]
        if markers[0].file_size>1024*1024:raise ValueError('Release manifest is too large.')
        manifest=json.loads(source.read(markers[0]));files=manifest.get('files',{})
        if (manifest.get('schema')!=1 or manifest.get('repository')!=REPOSITORY or manifest.get('version')!=release['version']
            or not re.fullmatch(r'[a-f0-9]{40}',manifest.get('commit','')) or not isinstance(files,dict) or not files):raise ValueError('Invalid release manifest.')
        seen=set()
        for entry in entries:
            if not entry.filename.startswith(prefix):raise ValueError('Invalid package layout.')
            name=entry.filename[len(prefix):];target=source_path(destination,name)
            if name in seen or entry.file_size>32*1024*1024 or (entry.external_attr>>16)&0o170000==0o120000:raise ValueError('Invalid release file.')
            seen.add(name);content=source.read(entry)
            if name!=MARKER and hashlib.sha256(content).hexdigest()!=files.get(name):raise ValueError('Release file checksum did not match.')
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
        if seen!=set(files)|{MARKER} or not {'VERSION','labtex','server.py','deploy/local.py'}<=set(files):raise ValueError('Release package is incomplete.')
        if (destination/'VERSION').read_text().strip()!=release['version']:raise ValueError('Release version did not match.')
        (destination/'labtex').chmod(0o700)
        return manifest


class Updates:
    def __init__(self,root,state,enabled=False):
        self.root=Path(root).resolve();self.state=Path(state);self.enabled=enabled;self.lock=threading.Lock();self.checking=False
        self.cache=read_json(self.state/'updates.json');self.stopped=threading.Event();self.thread=None
        self.current=installation(self.root) if enabled else {'version':(self.root/'VERSION').read_text().strip() if (self.root/'VERSION').exists() else '0.0.0','commit':'','mode':'manual','reason':'Install and restart updates are available through the local Mac launcher. Update shared Linux deployments through their administrator.'}
        self.updating=enabled and bool(self.job()) and (self.job().get('phase') not in TERMINAL or self.job().get('recoveryRequired',False))
        if enabled:
            self.thread=threading.Thread(target=self._watch,daemon=True,name='release-check');self.thread.start()

    def job(self):return read_json(self.state/'updates'/'job.json') if self.enabled else {}

    def blocked(self):
        if not self.updating:return False
        job=self.job();self.updating=bool(job) and (job.get('phase') not in TERMINAL or job.get('recoveryRequired',False))
        return self.updating and (job.get('phase')!='download' or job.get('recoveryRequired',False))

    def status(self,admin=False):
        with self.lock:cache=dict(self.cache)
        release=cache.get('release');job=self.job();available=bool(release and version(release['version'])>version(self.current['version']))
        reason=('Recover the interrupted update before installing another release.' if job.get('recoveryRequired') else self.current['reason']) or ('' if release and release.get('digest') else 'This release does not include a verified update package.')
        return {'current':{key:self.current[key] for key in ('version','commit','mode')},'release':release,'available':available,
                'checked':cache.get('checked'),'error':cache.get('error',''),'automatic':cache.get('automatic',True),'checking':self.checking,
                'canInstall':self.enabled and admin and available and not reason,'reason':reason if admin else 'Only the installation administrator can install updates.',
                'job':{key:value for key,value in job.items() if key in ('id','phase','message','version','recoveryRequired')},'admin':admin}

    def check(self,force=False):
        if self.enabled and force:self.current=installation(self.root)
        with self.lock:
            now=time.time()
            if self.checking or now-self.cache.get('attempted',0)<(60 if force else INTERVAL):return None
            self.checking=True;previous=dict(self.cache);self.cache['attempted']=now
        try:
            release,etag=latest(previous)
            with self.lock:self.cache.update(release=release,etag=etag,checked=time.time(),error='')
        except (OSError,ValueError,TypeError,KeyError,RuntimeError) as error:
            with self.lock:self.cache['error']=str(error) if isinstance(error,(ValueError,RuntimeError)) else 'Release check failed. Check your connection and try again.'
        finally:
            with self.lock:self.checking=False;write_json(self.state/'updates.json',self.cache)
        return None

    def preference(self,automatic):
        if type(automatic) is not bool:raise ValueError('Choose automatic release checks on or off.')
        with self.lock:self.cache['automatic']=automatic;write_json(self.state/'updates.json',self.cache)

    def _watch(self):
        if self.stopped.wait(30):return
        while not self.stopped.is_set():
            if self.cache.get('automatic',True):self.check()
            if self.stopped.wait(3600):return

    def install(self,approved):
        if not self.enabled:raise ValueError('Use the local Mac launcher to install updates.')
        with self.lock:
            if self.job() and (self.job().get('phase') not in TERMINAL or self.job().get('recoveryRequired')):raise ValueError('An update is running or needs recovery before another can start.')
            current=installation(self.root);release=self.cache.get('release')
            if current['reason']:raise ValueError(current['reason'])
            if not release or not release['digest'] or version(release['version'])<=version(current['version']):raise ValueError('Check for a newer verified release first.')
            if type(approved.get('confirm')) is not bool or approved!={'confirm':True,'version':release['version'],'digest':release['digest']}:raise ValueError('Approve the specific version shown before installing.')
            folder=self.state/'updates';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
            job={'id':secrets.token_hex(16),'phase':'download','message':'Downloading and verifying the approved release…','version':release['version'],'release':release,'root':str(self.root),'pid':os.getpid(),'previous':current}
            write_json(folder/'job.json',job);self.updating=True
            worker=folder/'worker.py';shutil.copyfile(Path(__file__),worker);worker.chmod(0o600)
            with (folder/'worker.log').open('wb') as log:
                try:subprocess.Popen([sys.executable,str(worker),'--apply',str(self.root),job['id']],cwd=self.root,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,close_fds=True)
                except OSError:job.update(phase='error',message='Could not start the updater. Your app is unchanged.');write_json(folder/'job.json',job);raise
        return {'job':job['id']}

    def close(self):self.stopped.set()


def update_job(folder,job,phase,message):
    job.update(phase=phase,message=message);
    if phase in ('complete','rolled_back'):job.pop('recoveryRequired',None)
    write_json(folder/'job.json',job)


def wait_stopped(root,timeout=30):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        with (root/'.local/local.lock').open('a') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);return
            except BlockingIOError:pass
        time.sleep(.1)
    raise RuntimeError('The app did not stop. No source files were replaced.')


def start_app(root,expected,timeout=45):
    subprocess.run([sys.executable,str(root/'labtex'),'local','start'],cwd=root,check=True,timeout=timeout)
    port=read_json(root/'.local/local.json').get('port',8765);deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/app-update/health',timeout=2) as response:health=json.load(response)
            if health.get('version')==expected:return
        except (OSError,ValueError):pass
        time.sleep(.5)
    raise RuntimeError('The updated app did not pass its startup check.')


def wait_idle(root,timeout=600):
    port=read_json(root/'.local/local.json').get('port',8765);deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/app-update/health',timeout=3) as response:health=json.load(response)
        if not health.get('busy'):return
        time.sleep(1)
    raise RuntimeError('Current compiles or GitHub operations did not finish. The update was cancelled.')


def archive_targets(root,manifest,old):
    for name in manifest['files']:
        target=source_path(root,name)
        if name not in old['files'] and target.exists():raise ValueError('A release path would replace an untracked local file or directory. Move that file before updating.')
        if any(parent.is_file() for parent in target.parents if root in parent.parents):raise ValueError('A local file blocks a new release directory. Update this layout manually.')


def replace_archive(root,source,manifest,old,created=None):
    names=set(manifest['files'])|{MARKER}
    for name in sorted(names-{MARKER})+[MARKER]:
        target=source_path(root,name);target.parent.mkdir(parents=True,exist_ok=True)
        temporary=target.with_name('.idsl-update-'+secrets.token_hex(8))
        try:
            shutil.copyfile(source/name,temporary);temporary.chmod(0o700 if name=='labtex' else 0o600)
            if created is not None and name not in old['files'] and name!=MARKER:
                os.link(temporary,target);created(name)
            else:temporary.replace(target)
        finally:temporary.unlink(missing_ok=True)
    for name in set(old.get('files',{}))-names:source_path(root,name).unlink(missing_ok=True)


def backup_database(root,folder):
    path=root/'data/labtex.sqlite3'
    if path.exists():
        with closing(sqlite3.connect(path)) as source,closing(sqlite3.connect(folder/'database.sqlite3')) as target:
            with target:source.backup(target)
        (folder/'database.sqlite3').chmod(0o600)


def restore_database(root,folder):
    if (folder/'database.sqlite3').exists():
        target=root/'data/labtex.sqlite3'
        for suffix in ('-wal','-shm'):Path(str(target)+suffix).unlink(missing_ok=True)
        shutil.copyfile(folder/'database.sqlite3',target);target.chmod(0o600)


def recover(root,folder,job):
    # The trial server cannot save source while its startup is being verified.
    pid_path=root/'.local/local.pid'
    if pid_path.exists():
        try:os.kill(int(pid_path.read_text()),signal.SIGTERM);wait_stopped(root)
        except ProcessLookupError:pass
    if job['previous']['mode']=='git':git(root,'reset','--keep',job['previous']['commit'])
    else:
        old=read_json(folder/'source'/MARKER)
        for name in set(old['files'])|set(job.get('createdFiles',[])):
            path=source_path(root,name)
            if path.exists() and fingerprint(path) not in (old['files'].get(name),job.get('nextFiles',{}).get(name)):
                raise RuntimeError('Local code changed during installation; preserve it before recovery.')
        replace_archive(root,folder/'source',old,{'files':{name:None for name in job.get('createdFiles',[])}})
    restore_database(root,folder)
    for name in ('typst','tectonic','tinymist'):
        saved=folder/'bin'/name
        if saved.exists():
            temporary=root/'.local/bin'/(name+'.rollback');shutil.copyfile(saved,temporary);temporary.chmod(0o700);temporary.replace(root/'.local/bin'/name)
    update_job(folder.parent,job,'rolled_back','The update failed. The previous app and database were restored; a private rollback backup is retained.')
    start_app(root,job['previous']['version'])


def apply(root,job_id):
    root=Path(root).resolve();updates=root/'.local/updates';job=read_json(updates/'job.json')
    if job.get('id')!=job_id or job.get('root')!=str(root) or job.get('phase')!='download':raise ValueError('No matching approved update.')
    release=job['release'];folder=updates/'rollback';stopped=False;changed=False
    try:
        # Download and verify before disturbing the running app.
        archive=updates/'release.zip';digest=hashlib.sha256();size=0
        with request(release['download']) as response,archive.open('wb') as target:
            while block:=response.read(1024*1024):
                size+=len(block)
                if size>MAX_ARCHIVE:raise ValueError('Release download is too large.')
                digest.update(block);target.write(block)
        if size!=release['size'] or 'sha256:'+digest.hexdigest()!=release['digest']:raise ValueError('Release checksum did not match. The app is unchanged.')
        with tempfile.TemporaryDirectory(prefix='release-',dir=updates) as staging:
            source=Path(staging);manifest=unpack_release(archive,source,release);current=installation(root)
            if current!=job['previous'] or current['reason']:raise RuntimeError('Local code changed after approval. No update was applied.')
            if current['mode']=='git':
                ref='refs/idsl-update/'+job_id
                git(root,'fetch','--no-tags','https://github.com/'+REPOSITORY+'.git','refs/tags/'+release['tag']+':'+ref)
                target=git(root,'rev-parse',ref+'^{commit}')
                if target!=manifest['commit']:raise ValueError('The release package and Git tag do not match.')
                git(root,'merge-base','--is-ancestor',current['commit'],target)
            pins_changed=fingerprint(root/'deploy/local-dependencies.json')!=fingerprint(source/'deploy/local-dependencies.json')
            if current['mode']=='archive':archive_targets(root,manifest,read_json(root/MARKER))
            update_job(updates,job,'stopping','Saving a private rollback backup and restarting for the approved update…')
            time.sleep(2);wait_idle(root);os.kill(job['pid'],signal.SIGTERM);wait_stopped(root);stopped=True
            if installation(root)!=current:raise RuntimeError('Local code changed while stopping. The update was cancelled.')
            if folder.exists():shutil.rmtree(folder)
            folder.mkdir(mode=0o700);backup_database(root,folder)
            if current['mode']=='archive':
                old=read_json(root/MARKER)
                archive_targets(root,manifest,old)
                for name in set(old['files'])|{MARKER}:
                    destination=folder/'source'/name;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source_path(root,name),destination)
            if pins_changed:
                (folder/'bin').mkdir()
                for name in ('typst','tectonic','tinymist'):
                    path=root/'.local/bin'/name
                    if path.exists():os.link(path,folder/'bin'/name)
            job['nextFiles']=manifest['files'];job['createdFiles']=[];write_json(updates/'job.json',job);changed=True
            if current['mode']=='git':git(root,'merge','--ff-only',target)
            else:
                def created(name):job['createdFiles'].append(name);write_json(updates/'job.json',job)
                replace_archive(root,source,manifest,old,created)
            if pins_changed:
                update_job(updates,job,'compilers','Updating and checking pinned compiler tools…')
                subprocess.run([sys.executable,str(root/'labtex'),'local','setup'],cwd=root,check=True,timeout=1200)
            update_job(updates,job,'starting','Starting the updated app and checking it before enabling edits…')
            start_app(root,release['version'])
            update_job(updates,job,'complete','Update installed. You can reload the app when your browser drafts are saved.')
    except Exception as error:
        if stopped and changed:
            try:recover(root,folder,job)
            except Exception:
                job['recoveryRequired']=True;update_job(updates,job,'error','Automatic recovery needs manual attention. Your private rollback backup is in .local/updates/rollback. Run the saved updater with --recover; no backup was deleted.')
        else:
            update_job(updates,job,'error',str(error) if isinstance(error,(RuntimeError,ValueError)) else 'Update failed before replacing source. Your installation is unchanged.')
            if stopped:
                try:start_app(root,job['previous']['version'])
                except Exception:pass
    finally:
        (updates/'release.zip').unlink(missing_ok=True)
        if job['previous']['mode']=='git':
            try:git(root,'update-ref','-d','refs/idsl-update/'+job_id)
            except (OSError,RuntimeError,subprocess.SubprocessError):pass


if __name__=='__main__':
    os.umask(0o077)
    # These fixed worker actions are invoked by the local launcher, not a URL.
    action=sys.argv[1] if len(sys.argv)>1 else '';arguments=sys.argv[2:]
    if action not in ('--apply','--recover') or len(arguments)!=2:raise SystemExit('Use --apply ROOT JOB or --recover ROOT JOB.')
    root=Path(arguments[0]);job=read_json(root/'.local/updates/job.json')
    if job.get('id')!=arguments[1] or job.get('root')!=str(root.resolve()):raise SystemExit('Update job does not match this installation.')
    if action=='--apply':apply(root,arguments[1])
    else:recover(root,root/'.local/updates/rollback',job)
