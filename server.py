#!/usr/bin/env python3
"""LabTeX application server. Python 3.9+, no runtime Python packages."""
import argparse, base64, hashlib, hmac, ipaddress, json, mimetypes, os, re, secrets, socket, sqlite3, threading, time
import urllib.error, urllib.parse, urllib.request
import sys
from contextlib import contextmanager
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from core import Problem, MAX_FILE, MAX_PROJECT, MAX_FILES, SAMPLE, TYPST_SAMPLE, safe_path, directory_paths, pack_zip, unpack_zip, compile_project, starter_files, main_document
from github_backup import destination, GitHub, backup_snapshot
from project_templates import TEMPLATES, template_files
from credential_store import token_store, valid_token
from typst_service import TypstService
from project_changes import source_files, apply_changes
from doi_metadata import lookup_doi
from github_restore import inspect_backups, read_snapshot, changes_between, source_diff
from github_collaboration import Collaboration
from deploy.updates import Updates
ROOT=Path(__file__).resolve().parent
PDF_ASSETS={'/vendor/pdfjs/'+name:'vendor/pdfjs/'+name for name in json.loads((ROOT/'web/vendor/pdfjs/UPSTREAM.json').read_text())['files']}
IMAGE_TYPES={'svg':'image/svg+xml','png':'image/png','apng':'image/apng','jpg':'image/jpeg','jpeg':'image/jpeg','jpe':'image/jpeg','jfif':'image/jpeg','gif':'image/gif','webp':'image/webp','avif':'image/avif','bmp':'image/bmp','ico':'image/x-icon','tif':'image/tiff','tiff':'image/tiff','heic':'image/heic','heif':'image/heif'}
MAX_OWNED_PROJECTS=25
MAX_PROJECT_FOLDERS=100
MAX_FOLDER_DEPTH=10
MAX_HISTORY=40*1024*1024
TRASH_RETENTION=30*24*60*60
PUBLIC_POSTS={'/api/setup','/api/login','/api/register-lab'}
JSON_STRUCTURE=re.compile(r'[",\[\]{}]')

def export_disposition(project_name, extension, attachment=True):
    name=re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', '-', project_name).strip(' .') or 'document'
    filename=name if name.lower().endswith(extension) else name+extension
    fallback=filename.encode('ascii','replace').decode().replace('?', '_')
    return ('attachment' if attachment else 'inline')+'; filename="'+fallback+'"; filename*=UTF-8\'\''+urllib.parse.quote(filename,safe='')

class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads=True
    def service_actions(self):
        try: self.app.cleanup_trash(); self.app.cleanup_reviews()
        except sqlite3.OperationalError: pass  # Retry cleanup after a temporary database lock.
    def __init__(self,*args,**kwargs):
        self.slots=threading.BoundedSemaphore(8)
        self.uploads=threading.BoundedSemaphore(2)
        super().__init__(*args,**kwargs)
    def process_request(self,request,address):
        if not self.slots.acquire(False):
            try:
                request.settimeout(1)
                request.sendall(b'HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            finally: self.shutdown_request(request)
            return
        try: super().process_request(request,address)
        except Exception:
            self.slots.release();raise
    def process_request_thread(self,request,address):
        try: super().process_request_thread(request,address)
        finally: self.slots.release()
    def server_close(self):
        if getattr(self,'app',None): self.app.typst.close();self.app.updates.close()
        super().server_close()

def digest(s): return hashlib.sha256(s.encode()).hexdigest()
def password_hash(p,salt=None):
    if not isinstance(p,str) or not 12<=len(p)<=256: raise Problem('Use a password of 12–256 characters.')
    salt=salt or secrets.token_hex(16)
    return salt+':'+hashlib.pbkdf2_hmac('sha256',p.encode(),salt.encode(),600000).hex()
def title(s):
    s=str(s).strip()
    if not 1<=len(s)<=120: raise Problem('Use a name of 1–120 characters.')
    return s
def email_address(s):
    s=str(s).strip().lower()
    if len(s)>200 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',s): raise Problem('Enter a valid email address.')
    return s

def delete_project_rows(db,pid):
    for table in ('members','files','directories','history','invites','builds','build_sources','project_previews','project_backups','shared_project_backups','project_locations','project_trash','project_checkpoints','project_collaboration'):
        db.execute('DELETE FROM '+table+' WHERE project_id=?',(pid,))
    db.execute('DELETE FROM projects WHERE id=?',(pid,))

class App:
    def __init__(self,data,origin,compiler_url=None,demo=False):
        self.data=Path(data).resolve(); self.data.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path=self.data/'labtex.sqlite3'; self.origin=origin.rstrip('/'); self.compiler_url=compiler_url; self.demo=demo
        self.tokens=token_store(self.data)
        self.typst=TypstService(self)
        self.setup_token=os.getenv('SETUP_TOKEN') or secrets.token_urlsafe(24)
        self.lock=threading.Lock(); self.jobs=set(); self.attempts={}; self.review_plans={}
        self.collab=Collaboration(self)
        managed=sys.platform=='darwin' and os.getenv('LABTEX_LOCAL_MANAGED_ROOT')==str(ROOT) and self.data==ROOT/'data' and not compiler_url and not demo
        self.updates=Updates(ROOT,ROOT/'.local' if managed else self.data/'.updates',enabled=managed)
        self.trash_lock=threading.Lock(); self.trash_checked=0
        self.reviews_checked=0
        with self.db() as db:
            db.executescript('''PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT,password TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT,expires REAL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,owner TEXT,main TEXT,revision INTEGER,updated REAL);
CREATE TABLE IF NOT EXISTS project_trash(project_id TEXT PRIMARY KEY,deleted REAL NOT NULL);
CREATE TABLE IF NOT EXISTS members(project_id TEXT,user_id TEXT,role TEXT,PRIMARY KEY(project_id,user_id));
CREATE TABLE IF NOT EXISTS files(project_id TEXT,path TEXT,content BLOB,revision INTEGER,PRIMARY KEY(project_id,path));
CREATE TABLE IF NOT EXISTS directories(project_id TEXT,path TEXT,PRIMARY KEY(project_id,path));
CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,project_id TEXT,path TEXT,content BLOB,revision INTEGER,author TEXT,created REAL);
CREATE TABLE IF NOT EXISTS project_checkpoints(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,created REAL NOT NULL,source BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS project_collaboration(project_id TEXT PRIMARY KEY,repository TEXT NOT NULL,branch TEXT NOT NULL,folder TEXT NOT NULL,remote_id TEXT NOT NULL,base_commit TEXT NOT NULL,base_main TEXT NOT NULL,baseline BLOB NOT NULL,updated REAL NOT NULL,local_revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,project_id TEXT,role TEXT,expires REAL);
CREATE TABLE IF NOT EXISTS builds(project_id TEXT PRIMARY KEY,revision INTEGER,success INTEGER,log TEXT,pdf BLOB,seconds REAL,created REAL,engine TEXT);
CREATE TABLE IF NOT EXISTS build_sources(project_id TEXT PRIMARY KEY,created REAL NOT NULL,source_map TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_previews(project_id TEXT PRIMARY KEY,created REAL NOT NULL,pdf BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lab_invites(id TEXT PRIMARY KEY,token TEXT UNIQUE,created REAL,expires REAL,used_by TEXT);
CREATE TABLE IF NOT EXISTS approved_emails(email TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS backup_settings(user_id TEXT PRIMARY KEY,repository TEXT,branch TEXT);
CREATE TABLE IF NOT EXISTS project_backups(project_id TEXT PRIMARY KEY,mode TEXT,repository TEXT,branch TEXT,last_commit TEXT,last_url TEXT,last_revision INTEGER);
CREATE TABLE IF NOT EXISTS shared_project_backups(project_id TEXT,repository TEXT,branch TEXT,folder TEXT,last_commit TEXT,last_url TEXT,last_revision INTEGER,updated REAL NOT NULL DEFAULT 0,PRIMARY KEY(project_id,repository,branch));
CREATE TABLE IF NOT EXISTS project_folders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,parent_id TEXT,updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS project_locations(user_id TEXT,project_id TEXT,folder_id TEXT,PRIMARY KEY(user_id,project_id));
CREATE INDEX IF NOT EXISTS project_folders_parent ON project_folders(user_id,parent_id);
CREATE INDEX IF NOT EXISTS project_locations_folder ON project_locations(user_id,folder_id);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id,project_id);
CREATE INDEX IF NOT EXISTS history_project ON history(project_id,id DESC);
CREATE INDEX IF NOT EXISTS history_file ON history(project_id,path,id DESC);
CREATE INDEX IF NOT EXISTS checkpoints_project ON project_checkpoints(project_id,id DESC);
''')
            # Preserve the last successful PDF for explorer covers after failed builds.
            db.execute('''INSERT OR IGNORE INTO project_previews SELECT project_id,created,pdf
FROM builds WHERE success=1 AND pdf IS NOT NULL''')
            # Older shared snapshots did not track their destination separately.
            # Retain matching repository history without claiming branch verification.
            db.execute('''INSERT OR IGNORE INTO shared_project_backups
SELECT b.project_id,s.repository,s.branch,'',b.last_commit,b.last_url,b.last_revision,0
FROM project_backups b JOIN projects p ON p.id=b.project_id JOIN backup_settings s ON s.user_id=p.owner
WHERE b.mode='shared' AND b.last_commit IS NOT NULL AND s.repository!=''
AND b.last_url='https://github.com/'||s.repository||'/commit/'||b.last_commit''')
            # Upgrade existing installations: the original account manages lab signup.
            db.execute("INSERT OR IGNORE INTO settings SELECT 'lab_admin_id',id FROM users WHERE id!='demo' ORDER BY rowid LIMIT 1")
            if not db.execute("SELECT 1 FROM settings WHERE key='email_policy_initialized'").fetchone():
                db.execute("INSERT OR IGNORE INTO approved_emails SELECT email FROM users WHERE id!='demo'")
                db.execute("INSERT INTO settings VALUES('email_policy_initialized','1')")
            os.chmod(self.path,0o600)
            if demo:
                db.execute('INSERT OR IGNORE INTO users VALUES(?,?,?,?)',('demo','preview@example.test','Local preview','!'))
                if not db.execute("SELECT 1 FROM projects WHERE owner='demo'").fetchone(): self.new_project(db,'demo','A space for your next idea',SAMPLE)
        self.cleanup_trash(force=True)
    @contextmanager
    def db(self):
        db=sqlite3.connect(self.path,timeout=20); db.row_factory=sqlite3.Row
        try:
            with db: yield db
        finally: db.close()
    def rate(self,ip):
        now=time.time()
        with self.lock:
            self.attempts={k:[t for t in v if t>now-600] for k,v in self.attempts.items() if v and v[-1]>now-600}
            if ip not in self.attempts and len(self.attempts)>=5000: self.attempts.pop(next(iter(self.attempts)))
            a=self.attempts.setdefault(ip,[])
            if len(a)>=30: raise Problem('Too many attempts. Wait ten minutes.',429)
            a.append(now)
    def folder(self,db,user_id,folder_id):
        if not isinstance(folder_id,str) or not re.fullmatch(r'[a-f0-9]{24}',folder_id): raise Problem('Choose an existing folder.',400)
        row=db.execute('SELECT * FROM project_folders WHERE id=? AND user_id=?',(folder_id,user_id)).fetchone()
        if not row: raise Problem('Folder not found.',404)
        return dict(row)
    def folder_destination(self,db,user_id,parent,moving=None):
        rows={row['id']:dict(row) for row in db.execute('SELECT * FROM project_folders WHERE user_id=?',(user_id,))}
        depth=1;current=parent;seen=set()
        while current is not None:
            self.folder(db,user_id,current)
            if current==moving or current in seen: raise Problem('A folder cannot be moved inside itself.',409)
            seen.add(current);depth+=1;current=rows[current]['parent_id']
        if moving:
            for row in rows.values():
                current=row['id'];distance=0;seen=set()
                while current is not None and current!=moving:
                    if current in seen: raise Problem('Invalid folder hierarchy.',409)
                    seen.add(current);distance+=1;current=rows[current]['parent_id']
                if current==moving and depth+distance>MAX_FOLDER_DEPTH: raise Problem('Folders can be nested up to 10 levels.',400)
        if depth>MAX_FOLDER_DEPTH: raise Problem('Folders can be nested up to 10 levels.',400)
    def folder_name(self,db,user_id,name,parent,excluding=None):
        if not isinstance(name,str): raise Problem('Use a folder name of 1–80 characters.')
        name=name.strip()
        if not 1<=len(name)<=80 or name in ('.','..') or any(char in name for char in ('/','\\','\x00')): raise Problem('Use a folder name of 1–80 characters without slashes.')
        siblings=db.execute('SELECT id,name FROM project_folders WHERE user_id=? AND parent_id IS ?',(user_id,parent))
        if any(row['id']!=excluding and row['name'].casefold()==name.casefold() for row in siblings): raise Problem('A folder with this name already exists here.',409)
        return name
    def locate_project(self,db,user_id,pid,folder_id):
        if folder_id is None: db.execute('DELETE FROM project_locations WHERE user_id=? AND project_id=?',(user_id,pid))
        else:
            self.folder(db,user_id,folder_id)
            db.execute('INSERT OR REPLACE INTO project_locations VALUES(?,?,?)',(user_id,pid,folder_id))
    def new_project(self,db,owner,name,files,folder=None,directories=()):
        directories={safe_path(path) for path in directories}
        if len(directories)>MAX_FILES: raise Problem('A project can contain up to 1000 folders.',413)
        if set(files)&directory_paths(files,directories): raise Problem('A path cannot be both a file and a folder.',409)
        if db.execute('SELECT COUNT(*) FROM projects WHERE owner=?',(owner,)).fetchone()[0]>=MAX_OWNED_PROJECTS:
            raise Problem('You can own up to 25 projects, including Trash. Permanently delete an unused project from Trash first.',413)
        if folder is not None: self.folder(db,owner,folder)
        pid=secrets.token_hex(12)
        main=main_document(files)
        db.execute('INSERT INTO projects VALUES(?,?,?,?,1,?)',(pid,title(name),owner,main,time.time()))
        db.execute('INSERT INTO members VALUES(?,?,?)',(pid,owner,'owner'))
        db.executemany('INSERT INTO files VALUES(?,?,?,1)',[(pid,p,c) for p,c in files.items()])
        db.executemany('INSERT INTO directories VALUES(?,?)',[(pid,path) for path in directories])
        self.locate_project(db,owner,pid,folder); return pid
    def project_location(self,db,user_id,pid):
        row=db.execute('SELECT folder_id FROM project_locations WHERE user_id=? AND project_id=?',(user_id,pid)).fetchone()
        return row['folder_id'] if row else None
    def duplicate_project(self,db,project,user):
        folder=self.project_location(db,user['id'],project['id'])
        names={row['name'].casefold() for row in db.execute('''SELECT p.name FROM projects p JOIN members m ON p.id=m.project_id
LEFT JOIN project_locations l ON l.project_id=p.id AND l.user_id=m.user_id
WHERE m.user_id=? AND l.folder_id IS ? AND NOT EXISTS(SELECT 1 FROM project_trash t WHERE t.project_id=p.id)''',(user['id'],folder))}
        number=1
        while True:
            suffix=' (copy)' if number==1 else ' (copy '+str(number)+')'
            name=(project['name'][:120-len(suffix)].rstrip()+suffix).strip()
            if name.casefold() not in names: break
            number+=1
        files={row['path']:row['content'] for row in db.execute('SELECT path,content FROM files WHERE project_id=?',(project['id'],))}
        directories=[row['path'] for row in db.execute('SELECT path FROM directories WHERE project_id=?',(project['id'],))]
        pid=self.new_project(db,user['id'],name,files,folder,directories)
        db.execute('UPDATE projects SET main=? WHERE id=?',(project['main'],pid))
        return {'id':pid,'name':name,'folder':folder}
    def access(self,db,pid,user,write=False,owner=False):
        row=db.execute('SELECT p.*,m.role FROM projects p JOIN members m ON p.id=m.project_id WHERE p.id=? AND m.user_id=? AND NOT EXISTS(SELECT 1 FROM project_trash t WHERE t.project_id=p.id)',(pid,user['id'])).fetchone()
        if not row: raise Problem('Project not found.',404)
        if (write and row['role']=='viewer') or (owner and row['role']!='owner'): raise Problem('You do not have permission for this action.',403)
        return dict(row)
    def cleanup_trash(self,force=False):
        if not force and time.time()-self.trash_checked<60: return
        if not self.trash_lock.acquire(False): return
        try:
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                expired=[row['project_id'] for row in db.execute('SELECT project_id FROM project_trash WHERE deleted<=?',(time.time()-TRASH_RETENTION,))]
                for pid in expired:
                    delete_project_rows(db,pid);self.typst.discard(pid=pid)
            self.trash_checked=time.time()
        finally: self.trash_lock.release()
    def cleanup_reviews(self,force=False):
        now=time.time()
        with self.lock:
            if not force and now-self.reviews_checked<60:return
            for plans in (self.review_plans,self.collab.plans):
                for key,plan in list(plans.items()):
                    if not plan['busy'] and plan['expires']<=now:del plans[key]
            self.reviews_checked=now

    def touch(self,db,pid): db.execute('UPDATE projects SET revision=revision+1,updated=? WHERE id=?',(time.time(),pid))
    def file_tree(self,db,pid):
        files={row['path'] for row in db.execute('SELECT path FROM files WHERE project_id=?',(pid,))}
        explicit={row['path'] for row in db.execute('SELECT path FROM directories WHERE project_id=?',(pid,))}
        return files,directory_paths(files,explicit),explicit
    def file_destination(self,db,pid,path):
        files,folders,_=self.file_tree(db,pid)
        if path in folders or any(path.startswith(file+'/') for file in files):
            raise Problem('A file or folder already exists at that path.',409)
    def create_directory(self,db,project,data):
        path=safe_path(data.get('path'));pid=project['id']
        files,folders,explicit=self.file_tree(db,pid)
        if path in folders or any(path==file or path.startswith(file+'/') for file in files):
            raise Problem('A file or folder already exists at that path.',409)
        additions=directory_paths([], [path])|{path}
        if len(explicit|additions)>MAX_FILES: raise Problem('A project can contain up to 1000 folders.',413)
        db.executemany('INSERT OR IGNORE INTO directories VALUES(?,?)',[(pid,folder) for folder in sorted(additions)])
        self.touch(db,pid);return {'path':path}
    def delete_files(self,db,project,data):
        paths,directories=data.get('paths',[]),data.get('directories',[])
        if not isinstance(paths,list) or not isinstance(directories,list) or not 1<=len(paths)+len(directories)<=MAX_FILES:
            raise Problem('Choose 1–1000 files or folders to delete.')
        paths={safe_path(path) for path in paths};directories={safe_path(path) for path in directories}
        if type(data.get('revision')) is not int: raise Problem('Provide the current project revision.')
        if data['revision']!=project['revision']: raise Problem('Project changed. Reopen the delete menu to review the current files.',409)
        pid=project['id'];files,folders,explicit=self.file_tree(db,pid)
        if paths-files: raise Problem('A selected file no longer exists.',404)
        selected=set(paths)
        for directory in directories:
            children={path for path in files if path.startswith(directory+'/')}
            if directory not in folders: raise Problem('A selected folder no longer exists.',404)
            selected.update(children)
        if project['main'] in selected: raise Problem('Choose another main document before deleting this file or folder.')
        # Validate the complete selection before changing either source or history.
        rows=[(pid,path) for path in sorted(selected)]
        db.executemany('DELETE FROM history WHERE project_id=? AND path=?',rows)
        db.executemany('DELETE FROM files WHERE project_id=? AND path=?',rows)
        removed={path for path in explicit if any(path==folder or path.startswith(folder+'/') for folder in directories)}
        db.executemany('DELETE FROM directories WHERE project_id=? AND path=?',[(pid,path) for path in removed])
        self.touch(db,pid)
        return {'deleted':sorted(selected),'revision':project['revision']+1}
    def move_files(self,db,project,data):
        """Move a file or virtual directory atomically, including history and main."""
        pid=project['id'];source=safe_path(data.get('path'))
        if type(data.get('directory')) is not bool: raise Problem('Choose a file or folder to move.')
        destination=data.get('folder')
        if destination not in (None,''): destination=safe_path(destination)
        else: destination=''
        if data.get('revision')!=project['revision']: raise Problem('Project changed. Refresh and try moving again.',409)
        files,folders,explicit=self.file_tree(db,pid)
        directory=data['directory']
        selected=sorted(path for path in files if path.startswith(source+'/')) if directory else [source] if source in files else []
        if (directory and source not in folders) or (not directory and not selected): raise Problem('File or folder not found.',404)
        if destination and destination not in folders: raise Problem('Destination folder not found.',404)
        if directory and (destination==source or destination.startswith(source+'/')): raise Problem('A folder cannot be moved inside itself.',409)
        target=(destination+'/' if destination else '')+source.rsplit('/',1)[-1]
        moves={path:safe_path(target+path[len(source):]) for path in selected}
        if target==source: return {'moves':moves,'changed':False}
        # Reject merging directories as well as overwriting individual files.
        if target in files or target in folders or any(path.startswith(target+'/') for path in files-set(selected)):
            raise Problem('A file or folder already exists at the destination.',409)
        remaining=files-set(selected)
        for new in moves.values():
            if new in remaining or new in folders or any(new.startswith(path+'/') or path.startswith(new+'/') for path in remaining):
                raise Problem('A file or folder already exists at the destination.',409)
        directory_moves={path:safe_path(target+path[len(source):]) for path in explicit if directory and (path==source or path.startswith(source+'/'))}
        temporary='_move_'+secrets.token_hex(16)+'/'
        for old in selected:
            db.execute('UPDATE files SET path=? WHERE project_id=? AND path=?',(temporary+old,pid,old))
            db.execute('UPDATE history SET path=? WHERE project_id=? AND path=?',(temporary+old,pid,old))
        for old,new in moves.items():
            db.execute('UPDATE files SET path=?,revision=revision+1 WHERE project_id=? AND path=?',(new,pid,temporary+old))
            db.execute('UPDATE history SET path=? WHERE project_id=? AND path=?',(new,pid,temporary+old))
        for old,new in directory_moves.items():
            db.execute('DELETE FROM directories WHERE project_id=? AND path=?',(pid,old))
            db.execute('INSERT INTO directories VALUES(?,?)',(pid,new))
        if project['main'] in moves: db.execute('UPDATE projects SET main=? WHERE id=?',(moves[project['main']],pid))
        self.touch(db,pid)
        return {'moves':moves,'changed':True}
    def is_lab_admin(self,db,user):
        row=db.execute("SELECT value FROM settings WHERE key='lab_admin_id'").fetchone()
        return bool(user and not self.demo and row and row['value']==user['id'])
    def lab_invitations(self,db):
        return {'invitations':[dict(row) for row in db.execute('SELECT id,created,expires,used_by FROM lab_invites ORDER BY created DESC')]}
    def create_lab_invitations(self,db,count):
        if type(count) is not int or not 1<=count<=20: raise Problem('Create 1–20 invitation links at a time.')
        now=time.time()
        db.execute('DELETE FROM lab_invites WHERE expires<?',(now,))
        active=db.execute('SELECT COUNT(*) FROM lab_invites WHERE used_by IS NULL').fetchone()[0]
        if active+count>50: raise Problem('You can have at most 50 unused invitations. Revoke unused links first.',413)
        links=[]
        for _ in range(count):
            token=secrets.token_urlsafe(32);iid=secrets.token_hex(12)
            db.execute('INSERT INTO lab_invites VALUES(?,?,?,?,NULL)',(iid,digest(token),now,now+604800))
            links.append({'id':iid,'url':self.origin+'/#signup='+token,'expires':now+604800})
        return {'links':links}
    def registration_invite(self,db,token):
        row=db.execute('SELECT * FROM lab_invites WHERE token=? AND expires>? AND used_by IS NULL',(digest(str(token)),time.time())).fetchone()
        if not row: raise Problem('This invitation has expired, was used, or was revoked. Ask your lab administrator for a new link.',403)
        return row
    def require_approved_email(self,db,email):
        if not db.execute('SELECT 1 FROM approved_emails WHERE email=?',(email,)).fetchone():
            raise Problem('This email is not approved for IDSL Editor. Ask the lab administrator to add your address.',403)
    def compile(self,pid,user):
        with self.lock:
            if pid in self.jobs or len(self.jobs)>=2: raise Problem('A build is running. Try again shortly.',429)
            self.jobs.add(pid)
        try:
            with self.db() as db:
                db.execute('BEGIN'); project=self.access(db,pid,user,write=True)
                files={r['path']:r['content'] for r in db.execute('SELECT path,content FROM files WHERE project_id=?',(pid,))}
            if self.compiler_url:
                payload=json.dumps({'main':project['main'],'files':{p:base64.b64encode(c).decode() for p,c in files.items()}}).encode()
                req=urllib.request.Request(self.compiler_url.rstrip('/')+'/compile',payload,{'Content-Type':'application/json'})
                try:
                    with urllib.request.urlopen(req,timeout=630) as response: result=json.loads(response.read(16*1024*1024))
                except urllib.error.HTTPError as e: raise Problem(json.loads(e.read()).get('error','Compiler error.'),e.code)
                except (OSError,ValueError): raise Problem('Compiler service is unavailable.',503)
            else: result=compile_project(files,project['main'])
            pdf=base64.b64decode(result['pdf']) if result.get('pdf') else None
            mapping=result.pop('sourceMap',None) if pdf else None
            created=time.time()
            with self.db() as db:
                # Permission might have been revoked while the compiler ran.
                self.access(db,pid,user,write=True)
                db.execute('INSERT OR REPLACE INTO builds VALUES(?,?,?,?,?,?,?,?)',(pid,project['revision'],int(result['success']),result['log'],pdf,result['seconds'],created,result['engine']))
                if result['success'] and pdf:
                    db.execute('INSERT OR REPLACE INTO project_previews VALUES(?,?,?)',(pid,created,pdf))
                db.execute('DELETE FROM build_sources WHERE project_id=?',(pid,))
                if mapping:
                    db.execute('INSERT INTO build_sources VALUES(?,?,?)',(pid,created,json.dumps(mapping)))
            return {**result,'pdf':bool(pdf),'sourceMap':bool(mapping),'revision':project['revision']}
        finally:
            with self.lock: self.jobs.discard(pid)

    def shared_backup_status(self,db,project,user):
        target=db.execute('SELECT repository,branch FROM backup_settings WHERE user_id=?',(user['id'],)).fetchone()
        if not target or not target['repository']:
            return {'included':False,'repository':'','branch':'','snapshot':None,'stale':False}
        row=db.execute('SELECT folder,last_commit,last_url,last_revision,updated FROM shared_project_backups WHERE project_id=? AND repository=? AND branch=?',
                       (project['id'],target['repository'],target['branch'])).fetchone()
        snapshot=dict(row) if row else None
        return {'included':True,**dict(target),'snapshot':snapshot,
                'stale':not snapshot or not snapshot['updated'] or snapshot['last_revision']!=project['revision']}

    def backup(self,pid,user,token,shared_target=None,client=None):
        key='backup:'+pid
        with self.lock:
            if key in self.jobs: raise Problem('This project is already being backed up.',429)
            self.jobs.add(key)
        try:
            with self.db() as db:
                db.execute('BEGIN')
                project=self.access(db,pid,user,owner=True)
                if db.execute('SELECT 1 FROM project_collaboration WHERE project_id=?',(pid,)).fetchone():
                    raise Problem('This project uses GitHub collaboration. Use Review & sync instead of snapshot backup.',409)
                settings=db.execute('SELECT * FROM project_backups WHERE project_id=?',(pid,)).fetchone()
                shared=shared_target is not None or not settings or settings['mode']=='shared'
                target=shared_target if shared_target is not None else db.execute('SELECT * FROM backup_settings WHERE user_id=?',(user['id'],)).fetchone() if shared else settings
                if not target: raise Problem('Set your GitHub backup destination first.')
                target=dict(target)
                files={r['path']:r['content'] for r in db.execute('SELECT path,content FROM files WHERE project_id=?',(pid,))}
            result=backup_snapshot(client or GitHub(token),target,project,files,shared)
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                self.access(db,pid,user,owner=True)
                if shared:
                    db.execute('INSERT OR REPLACE INTO shared_project_backups VALUES(?,?,?,?,?,?,?,?)',
                               (pid,target['repository'],target['branch'],result.get('folder',''),result['commit'],result['url'],project['revision'],time.time()))
                current=db.execute('SELECT * FROM project_backups WHERE project_id=?',(pid,)).fetchone()
                current_shared=not current or current['mode']=='shared'
                current_target=db.execute('SELECT * FROM backup_settings WHERE user_id=?',(user['id'],)).fetchone() if current_shared else current
                # Record the result only against the destination it actually used.
                if current_shared==shared and current_target and all(current_target[key]==target[key] for key in ('repository','branch')):
                    db.execute('INSERT INTO project_backups VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET last_commit=excluded.last_commit,last_url=excluded.last_url,last_revision=excluded.last_revision',
                               (pid,'shared' if shared else 'separate','' if shared else target['repository'],'' if shared else target['branch'],result['commit'],result['url'],project['revision']))
            return {**result,'revision':project['revision'],'name':project['name']}
        finally:
            with self.lock: self.jobs.discard(key)

    def backup_token(self,user,value):
        token=value or self.tokens.get(user['id'])
        if not token: raise Problem('Enter and save your GitHub token first.')
        return valid_token(token)

    def github_preview(self,user,data):
        pid=data.get('projectId')
        with self.db() as db:
            project=self.access(db,pid,user,owner=True) if pid else None
            if pid and db.execute('SELECT 1 FROM project_collaboration WHERE project_id=?',(pid,)).fetchone():
                raise Problem('This project is connected for collaboration. Use Review & sync to preserve local edits.',409)
            local={r['path']:r['content'] for r in db.execute('SELECT path,content FROM files WHERE project_id=?',(pid,))} if pid else {}
        join=data.get('collaborate',False)
        if type(join) is not bool or join and pid: raise Problem('Join collaboration as a new local project.')
        snapshot=read_snapshot(GitHub(self.backup_token(user,data.get('token'))),data,data.get('folder',''),data.get('commit'),managed_only=join)
        if join and snapshot['metadata'].get('collaboration')!=1: raise Problem('Ask the project owner to enable GitHub collaboration in their editor first.',409)
        changes=changes_between(local,snapshot['files'])
        plan={'id':secrets.token_hex(16),'user':user['id'],'project':project,'local':local,'snapshot':snapshot,'changes':changes,'expires':time.time()+900,'busy':False,'collaborate':join}
        cost=lambda value:sum(map(len,value['local'].values()))+sum(map(len,value['snapshot']['files'].values()))
        with self.lock:
            self.review_plans={key:value for key,value in self.review_plans.items() if value['expires']>time.time() or value['busy']}
            while self.review_plans and (len(self.review_plans)>=8 or sum(map(cost,self.review_plans.values()))+cost(plan)>128*1024*1024):
                key=next((key for key,value in self.review_plans.items() if not value['busy']),None)
                if key is None: raise Problem('Other restores are running. Retry shortly.',429)
                del self.review_plans[key]
            self.review_plans[plan['id']]=plan
        return {key:snapshot[key] for key in ('repository','branch','commit','folder','name','main','ignored')} | {'planId':plan['id'],'changes':changes,'projectId':pid,'revision':project['revision'] if project else None}

    def github_plan(self,user,plan_id):
        with self.lock:
            plan=self.review_plans.get(plan_id) if isinstance(plan_id,str) else None
            if not plan or plan['user']!=user['id'] or plan['expires']<=time.time():
                raise Problem('This review expired. Inspect the backup again.',404)
            return plan

    def apply_github_plan(self,user,data):
        plan=self.github_plan(user,data.get('planId'));snapshot=plan['snapshot'];project=plan['project']
        paths=data.get('paths')
        if not isinstance(paths,list) or not paths or len(paths)>MAX_FILES or any(not isinstance(path,str) for path in paths): raise Problem('Select at least one file change.')
        selected=set(paths);allowed={item['path'] for item in plan['changes']}
        if len(selected)!=len(paths) or not selected<=allowed: raise Problem('Select only changes from this review.')
        join=data.get('collaborate',False)
        if type(join) is not bool or join and (not plan.get('collaborate') or project or selected!=set(snapshot['files'])):
            raise Problem('Include all shared project files when joining collaboration.')
        with self.lock:
            if plan['busy']: raise Problem('This restore is already running.',429)
            plan['busy']=True
        try:
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                if project:
                    current=self.access(db,project['id'],user,owner=True)
                    if db.execute('SELECT 1 FROM project_collaboration WHERE project_id=?',(project['id'],)).fetchone():
                        raise Problem('This project now uses collaboration. Use Review & sync.',409)
                    rows={row['path']:row for row in db.execute('SELECT path,revision FROM files WHERE project_id=?',(project['id'],))}
                    edits=[{'path':path,'revision':rows[path]['revision'] if path in rows else 0,**({'base64':base64.b64encode(snapshot['files'][path]).decode()} if path in snapshot['files'] else {'delete':True})} for path in sorted(selected)]
                    final_paths=(set(plan['local'])-selected)|(selected&set(snapshot['files']))
                    main=snapshot['main'] if snapshot['main'] in final_paths else current['main']
                    result=apply_changes(self,db,current,user,edits,project['revision'],main=main,checkpoint=True)
                    result['id']=project['id']
                else:
                    files={path:snapshot['files'][path] for path in selected}
                    if snapshot['main'] not in files: raise Problem('Include the main document in the restore.')
                    pid=self.new_project(db,user['id'],data.get('name') or snapshot['name'],files,data.get('folder'))
                    db.execute('UPDATE projects SET main=? WHERE id=?',(snapshot['main'],pid))
                    if join:self.collab.attach(db,pid,snapshot,1)
                    result={'id':pid,'changed':sorted(files),'checkpoint':None}
            with self.lock: self.review_plans.pop(plan['id'],None)
            return {**result,'commit':snapshot['commit']}
        finally:
            with self.lock: plan['busy']=False

class Handler(BaseHTTPRequestHandler):
    server_version='LabTeX'
    @property
    def app(self): return self.server.app
    def setup(self):
        super().setup(); self.connection.settimeout(20)
        self.body_deadline=threading.Timer(20,self.expire_request);self.body_deadline.daemon=True;self.body_deadline.start()
        self.upload_slot=False
    def expire_request(self):
        try: self.connection.shutdown(socket.SHUT_RDWR)
        except OSError: pass
    def finish(self):
        self.body_deadline.cancel()
        if self.upload_slot: self.server.uploads.release()
        super().finish()
    def client_ip(self):
        peer=ipaddress.ip_address(self.client_address[0])
        if os.getenv('TRUST_CLOUDFLARE')=='1' and peer.is_loopback:
            try: return str(ipaddress.ip_address(self.headers.get('CF-Connecting-IP','')))
            except ValueError: pass
        return str(peer)
    def send(self,body,status=200,kind='application/json',headers=None):
        if kind=='application/json': body=json.dumps(body).encode()
        elif isinstance(body,str): body=body.encode()
        self.send_response(status)
        for k,v in {'Content-Type':kind,'Content-Length':str(len(body)),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; frame-src 'self' blob:; object-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",**(headers or {})}.items(): self.send_header(k,v)
        self.end_headers(); self.wfile.write(body)
    def body(self,limit):
        if self.headers.get('Content-Type','').split(';')[0]!='application/json': raise Problem('Send application/json.',415)
        n=int(self.headers.get('Content-Length','0'))
        if self.headers.get('Transfer-Encoding') or not 0<n<=limit: raise Problem('Request too large or empty.',413)
        if n>65536:
            if not self.server.uploads.acquire(False): raise Problem('Uploads are busy. Try again shortly.',429)
            self.upload_slot=True
        raw=self.rfile.read(n).decode('utf-8')
        # Bound structural expansion before json.loads allocates lists/dictionaries.
        pos=0;structures=0
        while True:
            match=JSON_STRUCTURE.search(raw,pos)
            if not match: break
            index=match.start()
            if raw[index]=='"': _,pos=json.decoder.scanstring(raw,index+1)
            else:
                structures+=1;pos=index+1
                if structures>2048: raise Problem('JSON structure is too complex.',413)
        data=json.loads(raw)
        if not isinstance(data,dict): raise Problem('Expected a JSON object.')
        return data
    def user(self,db):
        if self.app.demo: return dict(db.execute("SELECT id,email,name FROM users WHERE id='demo'").fetchone())
        cookie=SimpleCookie()
        try: cookie.load(self.headers.get('Cookie','')); token=cookie['labtex_session'].value
        except (KeyError,ValueError): raise Problem('Please sign in.',401)
        row=db.execute('SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id JOIN approved_emails a ON a.email=u.email WHERE s.token=? AND s.expires>?',(digest(token),time.time())).fetchone()
        if not row: raise Problem('Please sign in.',401)
        return dict(row)
    def cookie(self,token,age=604800): return 'labtex_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+str(age)+('; Secure' if self.app.origin.startswith('https://') else '')
    def login(self,db,user):
        token=secrets.token_urlsafe(32)
        db.execute('DELETE FROM sessions WHERE expires<?',(time.time(),)); db.execute('INSERT INTO sessions VALUES(?,?,?)',(digest(token),user['id'],time.time()+604800))
        return {'user':{k:user[k] for k in ('id','email','name')}},{'Set-Cookie':self.cookie(token)}
    def do_GET(self): self.handle_request('GET')
    def do_POST(self): self.handle_request('POST')
    def do_PUT(self): self.handle_request('PUT')
    def do_DELETE(self): self.handle_request('DELETE')
    def handle_request(self,method):
        try:
            if self.headers.get('Host')!=urllib.parse.urlsplit(self.app.origin).netloc and not (self.app.demo and self.headers.get('Host') in ('127.0.0.1:4173','localhost:4173')): raise Problem('Host does not match APP_ORIGIN.',403)
            if method!='GET' and self.headers.get('Origin')!=self.app.origin: raise Problem('Origin does not match APP_ORIGIN.',403)
            url=urllib.parse.urlsplit(self.path)
            path=urllib.parse.unquote(url.path);data={}
            if method!='GET':
                if self.app.updates.blocked():raise Problem('An approved app update is restarting. Your browser draft is kept; retry after it finishes.',503)
                public=method=='POST' and path in PUBLIC_POSTS
                if not public:
                    with self.app.db() as db: self.user(db)
                large=(path=='/api/projects' and method=='POST') or (method=='PUT' and re.fullmatch(r'/api/projects/[a-f0-9]{24}/file',path)) or (method=='POST' and re.fullmatch(r'/api/projects/[a-f0-9]{24}/(?:typst/[a-f0-9]{32}|edit-files|collaboration/sync)',path))
                bulk_delete=method=='POST' and (re.fullmatch(r'/api/projects/[a-f0-9]{24}/delete-files',path) or path=='/api/github-apply')
                data=self.body(256*1024 if bulk_delete else 58*1024*1024 if large else (16384 if public else 65536))
            self.body_deadline.cancel()
            result=self.route(method,path,urllib.parse.parse_qs(url.query),data)
            if result is not None: self.send(result)
        except Problem as e: self.send({'error':str(e)},e.status)
        except (ValueError,TypeError,KeyError,sqlite3.IntegrityError): self.send({'error':'Invalid request or duplicate record.'},400)
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception:
            import traceback; traceback.print_exc(); self.send({'error':'The server could not complete this request.'},500)
    def route(self,method,path,query,data):
        app=self.app
        if path=='/api/app-update/health' and method=='GET':
            return {'version':app.updates.current['version'],'busy':bool(app.jobs)}
        if path.startswith('/api/app-update'):
            with app.db() as db:
                user=self.user(db);admin=app.is_lab_admin(db,user) and not app.demo
            if path=='/api/app-update' and method=='GET':return app.updates.status(admin)
            if not admin:raise Problem('Only the installation administrator can manage app updates.',403)
            if path=='/api/app-update/check' and method=='POST':app.updates.check(force=True);return app.updates.status(admin)
            if path=='/api/app-update/preferences' and method=='PUT':app.updates.preference(data.get('automatic'));return app.updates.status(admin)
            if path=='/api/app-update/install' and method=='POST':
                with app.lock:
                    if app.jobs:raise Problem('Wait for the current compile or GitHub operation before updating.',409)
                    try:return app.updates.install(data)
                    except ValueError as error:raise Problem(str(error),409) from None
            raise Problem('Not found.',404)
        collaboration=re.fullmatch(r'/api/projects/([a-f0-9]{24})/collaboration(?:/(connect|review|file|sync|check))?',path)
        if collaboration:
            pid,operation=collaboration.groups()
            with app.db() as db:user=self.user(db);app.access(db,pid,user,owner=True)
            if operation is None:
                if method=='GET':return app.collab.describe(user,pid)
                if method=='DELETE':return app.collab.disconnect(user,pid)
            if operation=='file' and method=='GET':
                plan=app.collab.plan(user,pid,query.get('planId',[''])[0]);name=safe_path(query.get('path',[''])[0]);side=query.get('version',[''])[0]
                if side not in ('local','remote','base'):raise Problem('Choose a reviewed source version.')
                files=plan['snapshot']['files'] if side=='remote' else plan[side]
                if name not in files:raise Problem('File not found.',404)
                self.send(files[name],kind='application/octet-stream',headers={'Content-Disposition':export_disposition(name.rsplit('/',1)[-1],'',True)});return
            if method=='POST' and operation in ('connect','review','file','sync','check'):
                return getattr(app.collab,operation)(user,pid,data)
            raise Problem('Not found.',404)
        live=re.fullmatch(r'/api/projects/([a-f0-9]{24})/typst(?:/([a-f0-9]{32})(/preview/)?)?',path)
        if live:
            pid,sid,preview=live.groups()
            with app.db() as db:
                user=self.user(db);project=app.access(db,pid,user,write=True)
                if sid: session=app.typst.get(user['id'],pid,sid)
                changed=not sid or session.revision!=project['revision']
                files={row['path']:row['content'] for row in db.execute('SELECT path,content FROM files WHERE project_id=?',(pid,))} if changed else None
            if not sid:
                if method!='POST': raise Problem('Not found.',404)
                session=app.typst.open(user['id'],project,files)
                return {**session.state(),'preview':f'/api/projects/{pid}/typst/{session.id}/preview/'}
            if changed:
                if session.main!=project['main']:
                    app.typst.remove(session);raise Problem('Main document changed. Reconnect the live preview.',409)
                session.sync(project,files)
            if preview:
                if method!='GET': raise Problem('Not found.',404)
                if self.headers.get('Upgrade','').lower()=='websocket':
                    def authorized():
                        try:
                            with app.db() as db:
                                current=self.user(db);app.access(db,pid,current,write=True)
                                return current['id']==session.user_id
                        except Problem: return False
                    session.tunnel(self,authorized)
                else:
                    html,policy=session.preview_html(path)
                    self.send(html,kind='text/html; charset=utf-8',headers={'Content-Security-Policy':policy})
                return
            if method=='DELETE':
                app.typst.remove(session);return {'ok':True}
            if method=='GET': return session.state()
            if method!='POST': raise Problem('Not found.',404)
            operation=data.get('operation')
            if operation=='close':
                app.typst.remove(session);return {'ok':True}
            if operation=='change':
                session.change(data.get('path'),data.get('content'),data.get('sequence'))
                return session.state()
            if operation=='query':
                return {'result':session.query(data.get('method'),data.get('path'),data.get('position'))}
            if operation=='reveal':
                source=safe_path(data.get('path'))
                if source not in session.files: raise Problem('File not found.',404)
                position=data.get('position',{})
                if any(type(position.get(key)) is not int or not 0<=position[key]<=MAX_FILE for key in ('line','character')): raise Problem('Invalid editor position.')
                session.request('workspace/executeCommand',{'command':'tinymist.scrollPreview','arguments':[session.id,{'event':'panelScrollTo','filepath':str(session.root/source),**position}]})
                return {'ok':True}
            raise Problem('Unsupported live editor operation.')
        if path=='/api/github-token':
            with app.db() as db: user=self.user(db)
            if app.demo: raise Problem('Saving GitHub tokens is disabled in local preview.',403)
            if method=='PUT': app.tokens.set(user['id'],valid_token(data.get('token')))
            elif method=='DELETE': app.tokens.delete(user['id'])
            elif method!='GET': raise Problem('Not found.',404)
            return {'saved':app.tokens.has(user['id']),'storage':app.tokens.label}
        if path=='/api/doi' and method=='POST':
            with app.db() as db: self.user(db)
            return lookup_doi(data.get('doi'))
        if path in ('/api/github-backups','/api/github-preview','/api/github-diff','/api/github-apply') and method=='POST':
            with app.db() as db: user=self.user(db)
            if path=='/api/github-backups': return inspect_backups(GitHub(app.backup_token(user,data.get('token'))),data)
            if path=='/api/github-preview': return app.github_preview(user,data)
            if path=='/api/github-apply': return app.apply_github_plan(user,data)
            plan=app.github_plan(user,data.get('planId'));name=safe_path(data.get('path'))
            if name not in {item['path'] for item in plan['changes']}: raise Problem('Change not found.',404)
            if plan['project']:
                with app.db() as db: app.access(db,plan['project']['id'],user,owner=True)
            return source_diff(name,plan['local'].get(name),plan['snapshot']['files'].get(name))
        if path=='/api/backups' and method=='POST':
            shared_only=data.get('sharedOnly',False)
            if type(shared_only) is not bool: raise Problem('Choose a valid backup layout.')
            with app.db() as db:
                user=self.user(db)
                projects=[dict(r) for r in db.execute('SELECT id,name FROM projects p WHERE owner=? AND NOT EXISTS(SELECT 1 FROM project_trash t WHERE t.project_id=p.id) ORDER BY id',(user['id'],))]
                shared_target=None
                if shared_only:
                    target=db.execute('SELECT * FROM backup_settings WHERE user_id=?',(user['id'],)).fetchone()
                    if not target or not target['repository']: raise Problem('Set your shared GitHub repository first.')
                    shared_target=dict(target)
            token=app.backup_token(user,data.get('token'))
            client=GitHub(token)
            results=[]
            for project in projects:
                pid=project['id']
                with app.db() as db:
                    linked=db.execute('SELECT 1 FROM project_collaboration WHERE project_id=?',(pid,)).fetchone()
                if linked:
                    results.append({'id':pid,'name':project['name'],'skipped':True,'reason':'Collaborative project: use Review & sync.'});continue
                try: results.append({'id':pid,**app.backup(pid,user,token,shared_target,client=client)})
                except Problem as error: results.append({'id':pid,'name':project['name'],'error':str(error)})
            return {'results':results}
        backup_match=re.fullmatch(r'/api/projects/([a-f0-9]{24})/backup',path)
        if backup_match and method=='POST':
            shared_only=data.get('sharedOnly',False)
            if type(shared_only) is not bool: raise Problem('Choose a valid backup layout.')
            with app.db() as db:
                user=self.user(db);app.access(db,backup_match[1],user,owner=True)
                target=None
                if shared_only:
                    row=db.execute('SELECT * FROM backup_settings WHERE user_id=?',(user['id'],)).fetchone()
                    if not row or not row['repository']: raise Problem('Set your shared GitHub repository from the project explorer first.')
                    target=dict(row)
            return app.backup(backup_match[1],user,app.backup_token(user,data.get('token')),shared_target=target)
        if method=='GET' and not path.startswith('/api/'):
            allowed={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/html.js':'html.js','/edit-history.js':'edit-history.js','/source-folding.js':'source-folding.js','/source-editing.js':'source-editing.js','/completions.js':'completions.js','/typst-live.js':'typst-live.js','/style.css':'style.css','/theme.css':'theme.css','/palettes.css':'palettes.css','/theme.js':'theme.js','/favicon.svg':'favicon.svg'}
            allowed.update(PDF_ASSETS)
            allowed.update({name:name[1:] for name in ('/workspace-tabs.js','/workspace-tools.js','/workspace-tools.css','/project-analysis.js','/project-worker.js','/project-covers.js','/source-search.js','/collaboration.js','/app-updates.js')})
            allowed.update({name:name[1:] for name in ('/pdf-viewer.html','/pdf-viewer.js','/pdf-viewer.css')})
            if path not in allowed: raise Problem('Not found.',404)
            f=ROOT/'web'/allowed[path]
            stamp=f.stat();tag='"'+str(stamp.st_mtime_ns)+'-'+str(stamp.st_size)+'"'
            headers={'Cache-Control':'private, no-cache','ETag':tag}
            kind=mimetypes.guess_type(f)[0] or 'application/octet-stream'
            if path=='/pdf-viewer.html':headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' blob: data:; img-src 'self' blob: data:; worker-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'"
            if self.headers.get('If-None-Match')==tag:
                self.send(b'',304,kind=kind,headers=headers);return
            self.send(f.read_bytes(),kind=kind,headers=headers); return
        with app.db() as db:
            if path=='/api/session' and method=='GET':
                try: user=self.user(db)
                except Problem: user=None
                return {'user':user,'needsSetup':not bool(db.execute('SELECT 1 FROM users').fetchone()),'demo':app.demo,'canInviteLab':app.is_lab_admin(db,user)}
            if path in ('/api/setup','/api/login','/api/register-lab') and method=='POST':
                if app.demo: raise Problem('Account creation is disabled in local preview.',403)
                app.rate(self.client_ip()); db.execute('BEGIN IMMEDIATE'); email=email_address(data.get('email',''))
                if path=='/api/login':
                    user=db.execute('SELECT * FROM users WHERE email=?',(email,)).fetchone()
                    reference=user['password'] if user else '0'*32+':'+'0'*64
                    candidate=password_hash(data.get('password',''),reference.split(':')[0])
                    if not user or not hmac.compare_digest(reference,candidate): raise Problem('Email or password is incorrect.',401)
                    app.require_approved_email(db,email)
                else:
                    invite=None
                    if path=='/api/setup':
                        if db.execute('SELECT 1 FROM users').fetchone() or not hmac.compare_digest(str(data.get('token','')),app.setup_token): raise Problem('Setup token is invalid or setup is complete.',403)
                    else:
                        invite=app.registration_invite(db,data.get('token',''));app.require_approved_email(db,email)
                    user={'id':secrets.token_hex(12),'email':email,'name':title(data.get('name','')),'password':password_hash(data.get('password',''))}
                    db.execute('INSERT INTO users VALUES(:id,:email,:name,:password)',user)
                    if path=='/api/setup':
                        db.execute("INSERT OR IGNORE INTO settings VALUES('lab_admin_id',?)",(user['id'],))
                        db.execute('INSERT OR IGNORE INTO approved_emails VALUES(?)',(email,))
                    if invite:
                        db.execute('UPDATE lab_invites SET used_by=? WHERE id=?',(user['id'],invite['id']))
                    app.new_project(db,user['id'],'My first paper' if path=='/api/register-lab' else 'A space for your next idea',SAMPLE)
                result,headers=self.login(db,user); db.commit(); self.send(result,headers=headers); return
            user=self.user(db)
            if path=='/api/trash' and method=='GET':
                return {'projects':[dict(row) for row in db.execute('SELECT p.id,p.name,p.main,t.deleted,t.deleted+? AS expires FROM projects p JOIN project_trash t ON t.project_id=p.id WHERE p.owner=? AND t.deleted>? ORDER BY t.deleted DESC',(TRASH_RETENTION,user['id'],time.time()-TRASH_RETENTION))]}
            trashed=re.fullmatch(r'/api/trash/([a-f0-9]{24})',path)
            if trashed:
                if method not in ('POST','DELETE'): raise Problem('Not found.',404)
                db.execute('BEGIN IMMEDIATE');pid=trashed[1]
                row=db.execute('SELECT p.name FROM projects p JOIN project_trash t ON t.project_id=p.id WHERE p.id=? AND p.owner=? AND t.deleted>?',(pid,user['id'],time.time()-TRASH_RETENTION)).fetchone()
                if not row: raise Problem('Project not found in Trash.',404)
                if method=='POST': db.execute('DELETE FROM project_trash WHERE project_id=?',(pid,))
                else:
                    if data.get('name')!=row['name']: raise Problem('Confirm the project name before permanently deleting it.',409)
                    delete_project_rows(db,pid);app.typst.discard(pid=pid)
                return {'ok':True}
            if path=='/api/typst-capabilities' and method=='GET': return app.typst.capabilities()
            if path=='/api/templates' and method=='GET': return {'templates':list(TEMPLATES)}
            if path=='/api/project-folders':
                if method=='GET': return {'folders':[dict(row) for row in db.execute('SELECT id,name,parent_id AS parent,updated FROM project_folders WHERE user_id=? ORDER BY name,id',(user['id'],))]}
                if method=='POST':
                    db.execute('BEGIN IMMEDIATE')
                    if db.execute('SELECT COUNT(*) FROM project_folders WHERE user_id=?',(user['id'],)).fetchone()[0]>=MAX_PROJECT_FOLDERS: raise Problem('You can create up to 100 project folders.',413)
                    parent=data.get('parent');app.folder_destination(db,user['id'],parent)
                    name=app.folder_name(db,user['id'],data.get('name'),parent);fid=secrets.token_hex(12)
                    db.execute('INSERT INTO project_folders VALUES(?,?,?,?,?)',(fid,user['id'],name,parent,time.time()));return {'id':fid}
                raise Problem('Not found.',404)
            folder_match=re.fullmatch(r'/api/project-folders/([a-f0-9]{24})',path)
            if folder_match:
                if method not in ('PUT','DELETE'): raise Problem('Not found.',404)
                db.execute('BEGIN IMMEDIATE');fid=folder_match[1];folder=app.folder(db,user['id'],fid)
                if method=='PUT':
                    parent=data.get('parent',folder['parent_id']);app.folder_destination(db,user['id'],parent,moving=fid)
                    name=app.folder_name(db,user['id'],data.get('name',folder['name']),parent,excluding=fid)
                    db.execute('UPDATE project_folders SET name=?,parent_id=?,updated=? WHERE id=?',(name,parent,time.time(),fid))
                else:
                    children=db.execute('SELECT 1 FROM project_folders WHERE user_id=? AND parent_id=?',(user['id'],fid)).fetchone()
                    projects=db.execute('SELECT 1 FROM project_locations l JOIN members m ON m.user_id=l.user_id AND m.project_id=l.project_id WHERE l.user_id=? AND l.folder_id=? AND NOT EXISTS(SELECT 1 FROM project_trash t WHERE t.project_id=l.project_id)',(user['id'],fid)).fetchone()
                    if children or projects: raise Problem('Move this folder’s projects and subfolders before deleting it.',409)
                    db.execute('DELETE FROM project_locations WHERE user_id=? AND folder_id=?',(user['id'],fid))
                    db.execute('DELETE FROM project_folders WHERE id=? AND user_id=?',(fid,user['id']))
                return {'ok':True}
            if path=='/api/sample-project' and method=='POST':
                db.execute('BEGIN IMMEDIATE')
                key='typst_sample:'+user['id']
                previous=db.execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone()
                if previous:
                    existing=db.execute('SELECT id FROM projects p WHERE id=? AND owner=? AND NOT EXISTS(SELECT 1 FROM project_trash t WHERE t.project_id=p.id)',(previous['value'],user['id'])).fetchone()
                    if existing: return {'id':existing['id']}
                    if data.get('recreate') is not True: return {'id':None}
                count=db.execute('SELECT COUNT(*) FROM projects WHERE owner=?',(user['id'],)).fetchone()[0]
                if count>=MAX_OWNED_PROJECTS: return {'id':None,'limitReached':True}
                pid=app.new_project(db,user['id'],'Getting started with Typst',TYPST_SAMPLE)
                db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)',(key,pid))
                return {'id':pid,'created':True}
            if path=='/api/backup-settings':
                if method=='PUT':
                    value=destination(data)
                    db.execute('INSERT OR REPLACE INTO backup_settings VALUES(?,?,?)',(user['id'],value['repository'],value['branch']))
                elif method!='GET': raise Problem('Not found.',404)
                row=db.execute('SELECT repository,branch FROM backup_settings WHERE user_id=?',(user['id'],)).fetchone()
                return dict(row) if row else {'repository':'','branch':''}
            if path=='/api/approved-emails':
                if not app.is_lab_admin(db,user): raise Problem('Only the lab administrator can manage approved emails.',403)
                if method=='PUT':
                    emails=data.get('emails')
                    if not isinstance(emails,list) or len(emails)>500: raise Problem('Provide up to 500 individual email addresses.')
                    emails={email_address(email) for email in emails}|{user['email']}
                    db.execute('BEGIN IMMEDIATE');db.execute('DELETE FROM approved_emails')
                    db.executemany('INSERT INTO approved_emails VALUES(?)',[(email,) for email in sorted(emails)])
                    db.execute('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email NOT IN (SELECT email FROM approved_emails))')
                elif method!='GET': raise Problem('Not found.',404)
                return {'emails':[row['email'] for row in db.execute('SELECT email FROM approved_emails ORDER BY email')]}
            if path=='/api/lab-invite':
                if not app.is_lab_admin(db,user): raise Problem('Only the lab administrator can create account invitations.',403)
                if method=='GET': return app.lab_invitations(db)
                if method=='POST':
                    db.execute('BEGIN IMMEDIATE');return app.create_lab_invitations(db,data.get('count',1))
                if method=='DELETE':
                    db.execute('DELETE FROM lab_invites WHERE id=?',(str(data.get('id','')),));return {'ok':True}
                raise Problem('Not found.',404)
            if path=='/api/logout' and method=='POST':
                app.typst.discard(user_id=user['id'])
                cookie=SimpleCookie(self.headers.get('Cookie',''))
                if 'labtex_session' in cookie: db.execute('DELETE FROM sessions WHERE token=?',(digest(cookie['labtex_session'].value),))
                self.send({'ok':True},headers={'Set-Cookie':self.cookie('',0)}); return
            if path=='/api/join' and method=='POST':
                db.execute('BEGIN IMMEDIATE'); invite=db.execute('SELECT * FROM invites i WHERE token=? AND expires>? AND NOT EXISTS(SELECT 1 FROM project_trash t WHERE t.project_id=i.project_id)',(digest(str(data.get('token',''))),time.time())).fetchone()
                if not invite: raise Problem('Invitation has expired or was used.',403)
                db.execute('INSERT OR IGNORE INTO members VALUES(?,?,?)',(invite['project_id'],user['id'],invite['role'])); db.execute('DELETE FROM invites WHERE token=?',(invite['token'],)); return {'id':invite['project_id']}
            if path=='/api/projects':
                if method=='GET': return {'projects':[dict(x) for x in db.execute('SELECT p.id,p.name,p.main,p.updated,m.role,l.folder_id AS folder,v.created AS preview FROM projects p JOIN members m ON p.id=m.project_id LEFT JOIN project_locations l ON l.project_id=p.id AND l.user_id=m.user_id LEFT JOIN project_previews v ON v.project_id=p.id WHERE m.user_id=? AND NOT EXISTS(SELECT 1 FROM project_trash t WHERE t.project_id=p.id) ORDER BY p.updated DESC',(user['id'],))]}
                if method=='POST':
                    db.execute('BEGIN IMMEDIATE')
                    directories=()
                    if 'templateId' in data:
                        if data.get('zip'): raise Problem('Choose a ZIP import or a starter template.')
                        template,files=template_files(data['templateId']);name=data.get('name',template['name'])
                    else:
                        if data.get('zip'): files,directories=unpack_zip(base64.b64decode(data['zip'],validate=True),include_directories=True)
                        else: files=starter_files(data.get('format','latex'),data.get('template',True))
                        name=data.get('name','Untitled paper')
                    return {'id':app.new_project(db,user['id'],name,files,data.get('folder'),directories)}
            match=re.fullmatch(r'/api/projects/([a-f0-9]{24})(?:/(.*))?',path)
            if not match: raise Problem('Not found.',404)
            pid,action=match.groups()
            if method!='GET' and action!='compile': db.execute('BEGIN IMMEDIATE')
            # Duplicating needs read access, like downloading and reimporting source.
            p=app.access(db,pid,user,write=method!='GET' and action not in ('folder','duplicate'))
            if action=='duplicate' and method=='POST': return app.duplicate_project(db,p,user)
            if action=='sources' and method=='GET': return {'files':source_files(db,pid),'revision':p['revision'],'main':p['main']}
            if action=='edit-files' and method=='POST': return apply_changes(app,db,p,user,data.get('files'),data.get('revision'),checkpoint=True)
            if action=='checkpoints' and method=='GET':
                return {'checkpoints':[dict(r) for r in db.execute('SELECT id,created FROM project_checkpoints WHERE project_id=? ORDER BY id DESC',(pid,))]}
            checkpoint=re.fullmatch(r'checkpoints/(\d+)\.zip',action or '')
            if checkpoint and method=='GET':
                row=db.execute('SELECT source FROM project_checkpoints WHERE id=? AND project_id=?',(checkpoint[1],pid)).fetchone()
                if not row: raise Problem('Checkpoint not found.',404)
                self.send(row['source'],kind='application/zip',headers={'Content-Disposition':export_disposition(p['name']+' - before changes','.zip')});return
            if action=='delete-files' and method=='POST': return app.delete_files(db,p,data)
            if action=='directories' and method=='POST': return app.create_directory(db,p,data)
            if action=='folder' and method=='PUT':
                if 'folder' not in data: raise Problem('Choose a destination folder.')
                app.locate_project(db,user['id'],pid,data['folder']);return {'ok':True}
            if action=='move-files' and method=='POST':
                return app.move_files(db,p,data)
            if action=='backup-settings':
                app.access(db,pid,user,owner=True)
                if method=='PUT':
                    value=destination(data)
                    mode=data.get('mode','shared')
                    if mode not in ('shared','separate'): raise Problem('Choose shared or separate repository mode.')
                    repository=value['repository'] if mode=='separate' else ''
                    branch=value['branch'] if mode=='separate' else ''
                    previous=db.execute('SELECT * FROM project_backups WHERE project_id=?',(pid,)).fetchone()
                    keep=previous and (previous['mode'],previous['repository'],previous['branch'])==(mode,repository,branch)
                    db.execute('INSERT OR REPLACE INTO project_backups VALUES(?,?,?,?,?,?,?)',
                               (pid,mode,repository,branch,previous['last_commit'] if keep else None,previous['last_url'] if keep else None,previous['last_revision'] if keep else None))
                elif method!='GET': raise Problem('Not found.',404)
                row=db.execute('SELECT * FROM project_backups WHERE project_id=?',(pid,)).fetchone()
                settings=dict(row) if row else {'mode':'shared','repository':'','branch':'','last_commit':None,'last_url':None,'last_revision':None}
                return {**settings,'global_backup':app.shared_backup_status(db,p,user)}
            if action is None:
                if method=='GET':
                    p['folder']=app.project_location(db,user['id'],pid)
                    p['collaboration']=bool(db.execute('SELECT 1 FROM project_collaboration WHERE project_id=?',(pid,)).fetchone())
                    b=db.execute('SELECT revision,success,seconds,created,engine FROM builds WHERE project_id=?',(pid,)).fetchone();p['build']=dict(b) if b else None
                    # Access is checked on every request, including unchanged
                    # responses. No file-tree or BLOB work is needed when idle.
                    tag='"'+hashlib.sha256(json.dumps(p,sort_keys=True).encode()).hexdigest()[:32]+'"'
                    if self.headers.get('If-None-Match')==tag:
                        self.send(b'',304,kind='application/json; charset=utf-8',headers={'ETag':tag});return
                    p['files']=[dict(x) for x in db.execute('SELECT path,length(content) AS size,revision FROM files WHERE project_id=? ORDER BY path',(pid,))]
                    explicit=[row['path'] for row in db.execute('SELECT path FROM directories WHERE project_id=?',(pid,))]
                    p['directories']=sorted(directory_paths([file['path'] for file in p['files']],explicit))
                    self.send(p,headers={'ETag':tag});return
                if method=='PUT':
                    if 'main' in data:
                        main=safe_path(data['main'])
                        if not main.endswith(('.tex','.typ')) or not db.execute('SELECT 1 FROM files WHERE project_id=? AND path=?',(pid,main)).fetchone(): raise Problem('Choose an existing .tex or .typ file.')
                        db.execute('UPDATE projects SET main=? WHERE id=?',(main,pid))
                    if 'name' in data: db.execute('UPDATE projects SET name=? WHERE id=?',(title(data['name']),pid))
                    app.touch(db,pid); return {'ok':True}
                if method=='DELETE':
                    app.access(db,pid,user,owner=True)
                    db.execute('INSERT INTO project_trash VALUES(?,?)',(pid,time.time()))
                    db.execute('DELETE FROM invites WHERE project_id=?',(pid,));app.typst.discard(pid=pid);return {'ok':True}
            if action=='image' and method=='GET':
                name=safe_path(query.get('path',[''])[0]);kind=IMAGE_TYPES.get(name.rsplit('.',1)[-1].lower())
                if not kind: raise Problem('Choose an image file.',415)
                row=db.execute('SELECT content,revision FROM files WHERE project_id=? AND path=?',(pid,name)).fetchone()
                if not row: raise Problem('Image not found.',404)
                if query.get('v',[str(row['revision'])])[0]!=str(row['revision']): raise Problem('Image changed. Refresh the file tree.',409)
                # SVG is an image resource, never executable page markup. The
                # restrictive response policy also applies to direct navigation.
                self.send(row['content'],kind=kind,headers={'Content-Security-Policy':"default-src 'none'; sandbox; frame-ancestors 'none'"});return
            if action=='file':
                name=safe_path(query.get('path',[data.get('path','')])[0]); row=db.execute('SELECT * FROM files WHERE project_id=? AND path=?',(pid,name)).fetchone()
                if method=='GET':
                    if not row: raise Problem('File not found.',404)
                    try: content=row['content'].decode('utf-8'); binary='\x00' in content
                    except UnicodeDecodeError: binary,content=True,None
                    return {'path':name,'revision':row['revision'],'content':None if binary else content,'base64':base64.b64encode(row['content']).decode() if binary else None}
                if method=='PUT':
                    app.file_destination(db,pid,name)
                    if (row and data.get('revision',0)!=row['revision']) or (not row and data.get('revision',0)!=0): raise Problem('This file changed on the server. Compare your draft with the latest version.',409)
                    content=base64.b64decode(data['base64'],validate=True) if 'base64' in data else str(data.get('content','')).encode()
                    total,count=db.execute('SELECT COALESCE(SUM(length(content)),0),COUNT(*) FROM files WHERE project_id=?',(pid,)).fetchone()
                    if len(content)>MAX_FILE or total-(len(row['content']) if row else 0)+len(content)>MAX_PROJECT or (not row and count>=MAX_FILES): raise Problem('File or project size limit exceeded.',413)
                    if row:
                        db.execute('INSERT INTO history(project_id,path,content,revision,author,created) VALUES(?,?,?,?,?,?)',(pid,name,row['content'],row['revision'],user['name'],time.time()))
                        db.execute('DELETE FROM history WHERE project_id=? AND path=? AND id NOT IN (SELECT id FROM history WHERE project_id=? AND path=? ORDER BY id DESC LIMIT 30)',(pid,name,pid,name))
                        # Retain newest history within a project-wide byte budget.
                        used=0
                        for old in db.execute('SELECT id,length(content) AS size FROM history WHERE project_id=? ORDER BY id DESC',(pid,)).fetchall():
                            used+=old['size']
                            if used>MAX_HISTORY: db.execute('DELETE FROM history WHERE id=?',(old['id'],))
                    rev=(row['revision'] if row else 0)+1
                    db.execute('INSERT OR REPLACE INTO files VALUES(?,?,?,?)',(pid,name,content,rev)); app.touch(db,pid); return {'revision':rev}
                if method=='DELETE':
                    if not row: raise Problem('File not found.',404)
                    if name==p['main']: raise Problem('Choose another main document before deleting this file.')
                    if data.get('revision')!=row['revision']: raise Problem('File changed; refresh before deleting.',409)
                    db.execute('DELETE FROM files WHERE project_id=? AND path=?',(pid,name))
                    db.execute('DELETE FROM history WHERE project_id=? AND path=?',(pid,name)); app.touch(db,pid); return {'ok':True}
            if action=='rename' and method=='POST':
                old,new=safe_path(data['path']),safe_path(data['newPath'])
                row=db.execute('SELECT revision FROM files WHERE project_id=? AND path=?',(pid,old)).fetchone()
                if not row or row['revision']!=data.get('revision'): raise Problem('File changed; refresh before renaming.',409)
                if db.execute('SELECT 1 FROM files WHERE project_id=? AND path=?',(pid,new)).fetchone():
                    raise Problem('A file already exists at that path. Choose a different name.',409)
                app.file_destination(db,pid,new)
                db.execute('UPDATE files SET path=?,revision=revision+1 WHERE project_id=? AND path=?',(new,pid,old)); db.execute('UPDATE history SET path=? WHERE project_id=? AND path=?',(new,pid,old))
                if p['main']==old: db.execute('UPDATE projects SET main=? WHERE id=?',(new,pid))
                app.touch(db,pid); return {'ok':True}
            if action=='history' and method=='GET':
                name=safe_path(query.get('path',[''])[0])
                if 'id' in query:
                    row=db.execute('SELECT content,revision FROM history WHERE id=? AND project_id=? AND path=?',(query['id'][0],pid,name)).fetchone()
                    if not row: raise Problem('Version not found.',404)
                    return {'content':row['content'].decode('utf-8',errors='replace'),'revision':row['revision']}
                return {'versions':[dict(x) for x in db.execute('SELECT id,revision,author,created FROM history WHERE project_id=? AND path=? ORDER BY id DESC',(pid,name))]}
            if action=='source.zip' and method=='GET':
                files={x['path']:x['content'] for x in db.execute('SELECT path,content FROM files WHERE project_id=?',(pid,))}
                self.send(pack_zip(files,app.file_tree(db,pid)[2]),kind='application/zip',headers={'Content-Disposition':export_disposition(p['name'],'.zip')}); return
            if action=='synctex' and method=='GET':
                row=db.execute('SELECT b.created,b.revision,s.source_map FROM builds b LEFT JOIN build_sources s ON s.project_id=b.project_id AND s.created=b.created WHERE b.project_id=?',(pid,)).fetchone()
                if not row or not row['source_map']: return {'files':[],'pages':{}}
                if query.get('v',[None])[0]!=str(row['created']): raise Problem('The preview changed. Wait for the latest PDF.',409)
                return {**json.loads(row['source_map']),'revision':row['revision']}
            if action=='preview.pdf' and method=='GET':
                row=db.execute('SELECT created,pdf FROM project_previews WHERE project_id=?',(pid,)).fetchone()
                if not row: raise Problem('Compile successfully to generate a project preview.',404)
                if query.get('v',[None])[0]!=str(row['created']): raise Problem('The project preview changed. Refresh projects.',409)
                self.send(row['pdf'],kind='application/pdf');return
            if action in ('pdf','log') and method=='GET':
                row=db.execute('SELECT * FROM builds WHERE project_id=?',(pid,)).fetchone()
                if not row or (action=='pdf' and not row['pdf']): raise Problem('Compile successfully to generate a PDF.',404)
                if action=='log': return {'log':row['log'],'success':bool(row['success']),'revision':row['revision']}
                if 'v' in query and query['v'][0]!=str(row['created']): raise Problem('The preview changed. Wait for the latest PDF.',409)
                self.send(row['pdf'],kind='application/pdf',headers={'Content-Disposition':export_disposition(p['name'],'.pdf','download' in query)}); return
            if action=='members':
                if method=='GET': return {'members':[dict(x) for x in db.execute('SELECT u.id,u.email,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id=?',(pid,))]}
                app.access(db,pid,user,owner=True)
                if method=='DELETE':
                    if data.get('userId')==p['owner']: raise Problem('The owner cannot be removed.')
                    db.execute('DELETE FROM members WHERE project_id=? AND user_id=?',(pid,data.get('userId')))
                    app.typst.discard(pid=pid,user_id=data.get('userId'))
                    db.execute('DELETE FROM project_locations WHERE project_id=? AND user_id=?',(pid,data.get('userId'))); return {'ok':True}
            if action=='invite' and method=='POST':
                app.access(db,pid,user,owner=True); role=data.get('role','editor')
                if role not in ('editor','viewer'): raise Problem('Choose editor or viewer.')
                token=secrets.token_urlsafe(32)
                db.execute('DELETE FROM invites WHERE expires<?',(time.time(),)); db.execute('INSERT INTO invites VALUES(?,?,?,?)',(digest(token),pid,role,time.time()+604800))
                return {'url':app.origin+'/#invite='+token,'expiresInDays':7}
            if action!='compile' or method!='POST': raise Problem('Not found.',404)
        return app.compile(pid,user)
    def log_message(self,fmt,*args): print(time.strftime('%H:%M:%S'),fmt%args,flush=True)

def main():
    parser=argparse.ArgumentParser(description='LabTeX self-hosted LaTeX workspace')
    parser.add_argument('--host',default=os.getenv('HOST','127.0.0.1')); parser.add_argument('--port',type=int,default=int(os.getenv('PORT','8765'))); parser.add_argument('--demo',action='store_true',help='Local-only preview account. Never use for shared hosting.')
    args=parser.parse_args()
    if args.demo and args.host!='127.0.0.1': parser.error('--demo requires loopback binding')
    if args.host!='127.0.0.1' and not os.getenv('COMPILER_URL'): parser.error('Use ./labtex start for sandboxed hosting; direct serving must stay on loopback.')
    app=App(os.getenv('DATA_DIR',str(ROOT/'data')),os.getenv('APP_ORIGIN','http://127.0.0.1:'+str(args.port)),os.getenv('COMPILER_URL'),args.demo)
    server=BoundedHTTPServer((args.host,args.port),Handler); server.app=app
    print('LabTeX is running at '+app.origin,flush=True)
    with app.db() as db:
        if not db.execute('SELECT 1 FROM users').fetchone(): print('First account: retrieve the private token with ./labtex setup-token',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: server.server_close()
if __name__=='__main__': main()
