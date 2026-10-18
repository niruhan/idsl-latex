"""Reviewed, three-way project synchronization between independent installations."""
import base64
import difflib
import json
import secrets
import time
import urllib.parse
from contextlib import contextmanager

from core import MAX_FILE, MAX_FILES, MAX_PROJECT, Problem, directory_paths, pack_zip, safe_path, unpack_zip
from github_backup import GitHub, MANIFEST, blob_sha
from github_restore import oid, read_snapshot, tree_at, manifest_at, source_diff
from project_changes import apply_changes


def text(value):
    if value is None:
        return ''
    try:
        result=value.decode('utf-8')
        return None if '\0' in result else result
    except UnicodeDecodeError:
        return None


def merge_value(base, local, remote):
    if local==remote or remote==base:
        return local,False
    if local==base:
        return remote,False
    return None,True


def merge_file(base, local, remote):
    result,conflict=merge_value(base,local,remote)
    if not conflict:
        return result,False
    if any(value is None or text(value) is None for value in (base,local,remote)):
        return None,True
    old,left,right=map(text,(base,local,remote))
    if sum(map(len,(old,left,right)))>400000 or sum(value.count('\n') for value in (old,left,right))>4000:
        return None,True
    old,left,right=(value.splitlines(keepends=True) for value in (old,left,right))
    def edits(next):
        return [(start,end,next[a:b]) for tag,start,end,a,b in difflib.SequenceMatcher(None,old,next).get_opcodes() if tag!='equal']
    a,b=edits(left),edits(right)
    for start,end,value in a:
        for other,stop,change in b:
            if (start,end,value)==(other,stop,change):
                continue
            if max(start,other)<min(end,stop) or start==end and other<=start<=stop or other==stop and start<=other<=end:
                return None,True
    combined=a+[edit for edit in b if edit not in a]
    result=[];position=0
    for start,end,value in sorted(combined,key=lambda edit:(edit[0],edit[1])):
        result.extend(old[position:start]);result.extend(value);position=end
    result.extend(old[position:])
    return ''.join(result).encode(),False


def merge_project(base, local, remote, base_main, local_main, remote_main):
    files={};conflicts=[];changes=[]
    for path in sorted(set(base)|set(local)|set(remote)):
        before,mine,theirs=base.get(path),local.get(path),remote.get(path)
        value,conflict=merge_file(before,mine,theirs)
        if conflict:
            conflicts.append(path)
        elif value is not None:
            files[path]=value
        if mine!=theirs or mine!=before:
            changes.append({'path':path,'status':'conflict' if conflict else 'merged' if mine!=before and theirs!=before and mine!=theirs else 'local' if theirs==before and mine!=theirs else 'incoming' if mine!=theirs else 'same',
                            'localBytes':len(mine or b''),'remoteBytes':len(theirs or b''),'binary':text(mine) is None or text(theirs) is None})
    main,conflict=merge_value(base_main,local_main,remote_main)
    if conflict or local_main!=remote_main:
        changes.append({'path':'@main','status':'conflict' if conflict else 'local' if remote_main==base_main else 'incoming','localBytes':0,'remoteBytes':0,'binary':False})
    if conflict:
        conflicts.append('@main')
    return {'files':files,'main':main,'conflicts':conflicts,'changes':changes}


def validate_snapshot(files, main):
    if not 1<=len(files)<=MAX_FILES or sum(map(len,files.values()))>MAX_PROJECT or any(len(value)>MAX_FILE for value in files.values()):
        raise Problem('Merged source exceeds the project file/size limits.',413)
    for path in files:
        safe_path(path)
    if MANIFEST in files or set(files)&directory_paths(files):
        raise Problem('Merged files overlap a directory or the reserved backup manifest. Resolve or rename these paths first.',409)
    if main not in files or not main.endswith(('.typ','.tex')):
        raise Problem('Choose an existing .tex or .typ main document. Resolve its deletion before syncing.',409)


def publish_snapshot(client, snapshot, files, main):
    """Replace only manifest-owned files, preserving every other project/path."""
    validate_snapshot(files,main)
    tree=tree_at(client,snapshot)
    if tree['commit']!=snapshot['commit']:
        raise Problem('GitHub changed since review. Review & sync again.',409)
    metadata=manifest_at(client,tree,snapshot['folder'])
    if metadata['project_id']!=snapshot['metadata']['project_id']:
        raise Problem('The selected backup now belongs to another project. Reconnect after reviewing its destination.',409)
    prefix=snapshot['folder']+'/' if snapshot['folder'] else ''
    owned={prefix+name for name in metadata['files']}|{prefix+MANIFEST}
    foreign={path:entry for path,entry in tree['entries'].items() if path not in owned}
    desired={prefix+name:value for name,value in files.items()}
    metadata={**metadata,'files':sorted(files),'main':main,'collaboration':1}
    desired[prefix+MANIFEST]=json.dumps(metadata,indent=2).encode()+b'\n'
    for path in desired:
        if path in foreign or any(other.startswith(path+'/') for other in foreign) or any(foreign.get(path[:index],{}).get('type','tree')!='tree' for index,char in enumerate(path) if char=='/'):
            raise Problem('A merged path overlaps unrelated repository content. Rename it locally before syncing.',409)
    changes=[];known={entry['sha'] for entry in tree['entries'].values() if entry.get('type')=='blob'}
    for path,value in desired.items():
        sha=blob_sha(value);entry=tree['entries'].get(path)
        if entry and entry.get('sha')==sha and entry.get('mode')=='100644':
            continue
        if entry and entry.get('type')!='blob':
            raise Problem('A managed file became a directory or submodule. Review its paths first.',409)
        if sha not in known:
            created=client.call(tree['repo']+'/git/blobs','POST',{'content':base64.b64encode(value).decode(),'encoding':'base64'})
            if oid(created['sha'])!=sha:
                raise Problem('GitHub could not verify an uploaded file.',502)
            known.add(sha)
        changes.append({'path':path,'mode':'100644','type':'blob','sha':sha})
    for path in sorted(owned-set(desired)):
        if path in tree['entries']:
            entry=tree['entries'][path]
            if entry.get('type')!='blob' or entry.get('mode') not in ('100644','100755'):
                raise Problem('A managed file became a link, directory or submodule.',409)
            changes.append({'path':path,'mode':'100644','type':'blob','sha':None})
    if not changes:
        return {**snapshot,'metadata':metadata,'files':files,'main':main,'published':False}
    ref=tree['repo']+'/git/ref/heads/'+urllib.parse.quote(tree['branch'],safe='')
    if oid(client.call(ref)['object']['sha'])!=snapshot['commit']:
        raise Problem('Another collaborator published changes. Review & sync again.',409)
    parent=client.call(tree['repo']+'/git/commits/'+snapshot['commit'])
    new_tree=client.call(tree['repo']+'/git/trees','POST',{'base_tree':oid(parent['tree']['sha']),'tree':changes})
    commit=client.call(tree['repo']+'/git/commits','POST',{'message':'Sync '+snapshot['name'],'tree':oid(new_tree['sha']),'parents':[snapshot['commit']]})
    sha=oid(commit['sha'])
    client.call(tree['repo']+'/git/refs/heads/'+urllib.parse.quote(tree['branch'],safe=''),'PATCH',{'sha':sha,'force':False})
    if oid(client.call(ref)['object']['sha'])!=sha:
        raise Problem('GitHub advanced while verifying the sync. Your local files are unchanged; review again.',409)
    return {**snapshot,'commit':sha,'metadata':metadata,'files':files,'main':main,'published':True}


class Collaboration:
    def __init__(self,app):
        self.app=app;self.plans={}

    @contextmanager
    def job(self,pid):
        key='backup:'+pid
        with self.app.lock:
            if key in self.app.jobs:
                raise Problem('A GitHub operation is running for this project. Retry shortly.',429)
            self.app.jobs.add(key)
        try:
            yield
        finally:
            with self.app.lock:self.app.jobs.discard(key)

    def local(self,user,pid):
        with self.app.db() as db:
            project=self.app.access(db,pid,user,owner=True)
            files={row['path']:row['content'] for row in db.execute('SELECT path,content FROM files WHERE project_id=?',(pid,))}
            link=db.execute('SELECT * FROM project_collaboration WHERE project_id=?',(pid,)).fetchone()
            return project,files,dict(link) if link else None

    def describe(self,user,pid):
        with self.app.db() as db:
            project=self.app.access(db,pid,user,owner=True)
            row=db.execute('SELECT repository,branch,folder,remote_id,base_commit,updated,local_revision FROM project_collaboration WHERE project_id=?',(pid,)).fetchone()
        if not row:return {'linked':False}
        return {'linked':True,'repository':row['repository'],'branch':row['branch'],'folder':row['folder'],'remoteId':row['remote_id'],'commit':row['base_commit'],'updated':row['updated'],'localChanges':project['revision']!=row['local_revision']}

    def attach(self,db,pid,snapshot,revision):
        db.execute('INSERT OR REPLACE INTO project_collaboration VALUES(?,?,?,?,?,?,?,?,?,?)',
                   (pid,snapshot['repository'],snapshot['branch'],snapshot['folder'],snapshot['metadata']['project_id'],snapshot['commit'],snapshot['main'],pack_zip(snapshot['files']),time.time(),revision))

    def connect(self,user,pid,data):
        with self.job(pid):
            project,files,link=self.local(user,pid)
            if link:raise Problem('This project is already connected. Use Review & sync.',409)
            client=GitHub(self.app.backup_token(user,data.get('token')))
            target=tree_at(client,data)
            snapshot=read_snapshot(client,target,data.get('folder',''),target['commit'],managed_only=True)
            if files!=snapshot['files'] or project['main']!=snapshot['main']:
                raise Problem('Local source differs from this backup. Back up your latest source or review a pull before connecting.',409)
            published=publish_snapshot(client,snapshot,files,project['main'])
            with self.app.db() as db:
                db.execute('BEGIN IMMEDIATE');current=self.app.access(db,pid,user,owner=True)
                if current['revision']!=project['revision'] or db.execute('SELECT 1 FROM project_collaboration WHERE project_id=?',(pid,)).fetchone():
                    raise Problem('GitHub is ready, but your local project changed while connecting. Save and connect again.',409)
                self.attach(db,pid,published,current['revision'])
        return self.describe(user,pid)

    def disconnect(self,user,pid):
        with self.job(pid),self.app.db() as db:
            db.execute('BEGIN IMMEDIATE');self.app.access(db,pid,user,owner=True)
            db.execute('DELETE FROM project_collaboration WHERE project_id=?',(pid,))
        return {'linked':False}

    def check(self,user,pid,data):
        status=self.describe(user,pid)
        if not status['linked']:return status
        client=GitHub(self.app.backup_token(user,data.get('token')))
        current=oid(client.call('/repos/'+status['repository']+'/git/ref/heads/'+urllib.parse.quote(status['branch'],safe=''))['object']['sha'])
        return {**status,'remoteChanged':current!=status['commit'],'head':current}

    def review(self,user,pid,data):
        project,local,link=self.local(user,pid)
        if not link:raise Problem('Connect this project to a shared backup first.',409)
        client=GitHub(self.app.backup_token(user,data.get('token')))
        head=tree_at(client,link)['commit']
        remote=read_snapshot(client,link,link['folder'],head,managed_only=True)
        if remote['metadata']['project_id']!=link['remote_id'] or remote['metadata'].get('collaboration')!=1:
            raise Problem('The shared project identity or collaboration marker changed. Reconnect after reviewing its destination.',409)
        base=unpack_zip(link['baseline']);merged=merge_project(base,local,remote['files'],link['base_main'],project['main'],remote['main'])
        plan={'id':secrets.token_hex(16),'user':user['id'],'project':project,'link':link,'local':local,'base':base,'snapshot':remote,'merged':merged,'expires':time.time()+900,'busy':False}
        cost=lambda item:sum(len(content) for key in ('local','base') for content in item[key].values())+sum(map(len,item['snapshot']['files'].values()))+sum(map(len,item['merged']['files'].values()))
        if cost(plan)>192*1024*1024:raise Problem('This review is too large. Reduce its project assets first.',413)
        with self.app.lock:
            self.plans={key:value for key,value in self.plans.items() if value['expires']>time.time() or value['busy']}
            while self.plans and (len(self.plans)>=4 or sum(map(cost,self.plans.values()))+cost(plan)>192*1024*1024):
                key=next((key for key,value in self.plans.items() if not value['busy']),None)
                if key is None:raise Problem('Other synchronization reviews are running. Retry shortly.',429)
                del self.plans[key]
            self.plans[plan['id']]=plan
        return {'planId':plan['id'],'repository':link['repository'],'branch':link['branch'],'folder':link['folder'],'commit':head,'changes':merged['changes'],'conflicts':merged['conflicts']}

    def plan(self,user,pid,plan_id):
        self.describe(user,pid)
        with self.app.lock:
            plan=self.plans.get(plan_id) if isinstance(plan_id,str) else None
            if not plan or plan['user']!=user['id'] or plan['project']['id']!=pid or plan['expires']<=time.time():raise Problem('This sync review expired. Review & sync again.',404)
            return plan

    def file(self,user,pid,data):
        plan=self.plan(user,pid,data.get('planId'));path=data.get('path')
        if path not in {item['path'] for item in plan['merged']['changes']}:raise Problem('Change not found.',404)
        if path=='@main':
            return {'main':True,'base':plan['link']['base_main'],'local':plan['project']['main'],'remote':plan['snapshot']['main'],'merged':plan['merged']['main']}
        values={key:files.get(path) for key,files in [('base',plan['base']),('local',plan['local']),('remote',plan['snapshot']['files']),('merged',plan['merged']['files'])]}
        decoded={key:text(value) for key,value in values.items()};large=sum(len(value or b'') for value in values.values())>400000;binary=decoded['local'] is None or decoded['remote'] is None
        return {'main':False,'binary':binary,'large':large,'editable':not binary and not large,**{key:(value if not large and not binary else None) for key,value in decoded.items()},'localExists':values['local'] is not None,'remoteExists':values['remote'] is not None,**source_diff(path,values['local'],values['merged'] if path not in plan['merged']['conflicts'] else values['remote'])}

    def resolve(self,plan,resolutions):
        if not isinstance(resolutions,dict) or not set(resolutions)<={item['path'] for item in plan['merged']['changes']}:raise Problem('Choose resolutions only for reviewed changes.')
        files=dict(plan['merged']['files']);main=plan['merged']['main']
        for path in set(resolutions)|set(plan['merged']['conflicts']):
            choice=resolutions.get(path)
            if not isinstance(choice,dict) or choice.get('choice') not in ('local','remote','manual'):raise Problem('Resolve every conflicting file before syncing.')
            side=choice['choice']
            if path=='@main':
                if side=='manual':raise Problem('Choose one reviewed main document.')
                main=plan['project']['main'] if side=='local' else plan['snapshot']['main'];continue
            if side=='manual':
                if text(plan['local'].get(path)) is None or text(plan['snapshot']['files'].get(path)) is None:raise Problem('Choose one reviewed version for binary files.')
                value=choice.get('content')
                if not isinstance(value,str) or '\0' in value or len(value.encode())>MAX_FILE:raise Problem('Enter valid merged text within the file limit.')
                value=value.encode()
            else:value=(plan['local'] if side=='local' else plan['snapshot']['files']).get(path)
            if value is None:files.pop(path,None)
            else:files[path]=value
        validate_snapshot(files,main)
        return files,main

    def edit_local(self,db,user,plan,files,main,checkpoint):
        project=self.app.access(db,plan['project']['id'],user,owner=True)
        link=db.execute('SELECT * FROM project_collaboration WHERE project_id=?',(project['id'],)).fetchone()
        if project['revision']!=plan['project']['revision'] or not link or any(link[key]!=plan['link'][key] for key in ('repository','branch','folder','remote_id','base_commit','updated')):
            raise Problem('Local source or connection changed. Your drafts are kept; review & sync again.',409)
        rows={row['path']:row for row in db.execute('SELECT path,revision,content FROM files WHERE project_id=?',(project['id'],))}
        changes=[{'path':path,'revision':rows[path]['revision'] if path in rows else 0,**({'base64':base64.b64encode(files[path]).decode()} if path in files else {'delete':True})} for path in sorted(set(rows)|set(files)) if (rows[path]['content'] if path in rows else None)!=files.get(path)]
        if not changes:
            if main==project['main']:return {'changed':[],'checkpoint':None,'revision':project['revision']}
            path=project['main'];changes=[{'path':path,'revision':rows[path]['revision'],'base64':base64.b64encode(files[path]).decode()}]
        return apply_changes(self.app,db,project,user,changes,project['revision'],main=main,checkpoint=checkpoint)

    def sync(self,user,pid,data):
        plan=self.plan(user,pid,data.get('planId'))
        with self.job(pid):
            with self.app.lock:
                if plan['busy']:raise Problem('This sync is already running.',429)
                plan['busy']=True
            try:
                files,main=self.resolve(plan,data.get('resolutions',{}))
                # Validate the complete local transaction before publishing, then
                # release the database while GitHub uploads are in flight.
                with self.app.db() as db:
                    db.execute('BEGIN IMMEDIATE');db.execute('SAVEPOINT validate_sync')
                    self.edit_local(db,user,plan,files,main,False)
                    db.execute('ROLLBACK TO validate_sync');db.execute('RELEASE validate_sync')
                client=GitHub(self.app.backup_token(user,data.get('token')))
                published=publish_snapshot(client,plan['snapshot'],files,main)
                try:
                    with self.app.db() as db:
                        db.execute('BEGIN IMMEDIATE')
                        result=self.edit_local(db,user,plan,files,main,True)
                        self.attach(db,pid,published,result['revision'])
                except Problem as error:
                    if published['published'] and error.status==409:
                        raise Problem('GitHub accepted the reviewed changes, but this local project changed during upload. Local drafts are kept; review & sync again.',409) from None
                    raise
                with self.app.lock:self.plans.pop(plan['id'],None)
                return {**result,'commit':published['commit'],'published':published['published'],'id':pid}
            finally:
                with self.app.lock:plan['busy']=False
