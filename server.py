#!/usr/bin/env python3
"""LabTeX application server. Python 3.9+, no runtime Python packages."""
import argparse, base64, hashlib, hmac, ipaddress, json, mimetypes, os, re, secrets, socket, sqlite3, threading, time
import urllib.error, urllib.parse, urllib.request
from contextlib import contextmanager
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from core import Problem, MAX_FILE, MAX_PROJECT, MAX_FILES, SAMPLE, safe_path, pack_zip, unpack_zip, compile_project
ROOT=Path(__file__).resolve().parent
MAX_OWNED_PROJECTS=25
MAX_HISTORY=40*1024*1024
PUBLIC_POSTS={'/api/setup','/api/login','/api/register-lab'}
JSON_STRUCTURE=re.compile(r'[",\[\]{}]')

class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads=True
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

class App:
    def __init__(self,data,origin,compiler_url=None,demo=False):
        self.data=Path(data).resolve(); self.data.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path=self.data/'labtex.sqlite3'; self.origin=origin.rstrip('/'); self.compiler_url=compiler_url; self.demo=demo
        self.setup_token=os.getenv('SETUP_TOKEN') or secrets.token_urlsafe(24)
        self.lock=threading.Lock(); self.jobs=set(); self.attempts={}
        with self.db() as db:
            db.executescript('''PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT,password TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT,expires REAL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,owner TEXT,main TEXT,revision INTEGER,updated REAL);
CREATE TABLE IF NOT EXISTS members(project_id TEXT,user_id TEXT,role TEXT,PRIMARY KEY(project_id,user_id));
CREATE TABLE IF NOT EXISTS files(project_id TEXT,path TEXT,content BLOB,revision INTEGER,PRIMARY KEY(project_id,path));
CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,project_id TEXT,path TEXT,content BLOB,revision INTEGER,author TEXT,created REAL);
CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,project_id TEXT,role TEXT,expires REAL);
CREATE TABLE IF NOT EXISTS builds(project_id TEXT PRIMARY KEY,revision INTEGER,success INTEGER,log TEXT,pdf BLOB,seconds REAL,created REAL,engine TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lab_invites(id TEXT PRIMARY KEY,token TEXT UNIQUE,created REAL,expires REAL,used_by TEXT);
CREATE TABLE IF NOT EXISTS approved_emails(email TEXT PRIMARY KEY);
''')
            # Upgrade existing installations: the original account manages lab signup.
            db.execute("INSERT OR IGNORE INTO settings SELECT 'lab_admin_id',id FROM users WHERE id!='demo' ORDER BY rowid LIMIT 1")
            if not db.execute("SELECT 1 FROM settings WHERE key='email_policy_initialized'").fetchone():
                db.execute("INSERT OR IGNORE INTO approved_emails SELECT email FROM users WHERE id!='demo'")
                db.execute("INSERT INTO settings VALUES('email_policy_initialized','1')")
            os.chmod(self.path,0o600)
            if demo:
                db.execute('INSERT OR IGNORE INTO users VALUES(?,?,?,?)',('demo','preview@example.test','Local preview','!'))
                if not db.execute("SELECT 1 FROM projects WHERE owner='demo'").fetchone(): self.new_project(db,'demo','A space for your next idea',SAMPLE)
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
    def new_project(self,db,owner,name,files):
        if db.execute('SELECT COUNT(*) FROM projects WHERE owner=?',(owner,)).fetchone()[0]>=MAX_OWNED_PROJECTS:
            raise Problem('You can own up to 25 projects. Export and delete an unused project first.',413)
        pid=secrets.token_hex(12)
        main='main.tex' if 'main.tex' in files else next((p for p in files if p.endswith('.tex') and b'\\documentclass' in files[p]),next((p for p in files if p.endswith('.tex')),'main.tex'))
        db.execute('INSERT INTO projects VALUES(?,?,?,?,1,?)',(pid,title(name),owner,main,time.time()))
        db.execute('INSERT INTO members VALUES(?,?,?)',(pid,owner,'owner'))
        db.executemany('INSERT INTO files VALUES(?,?,?,1)',[(pid,p,c) for p,c in files.items()]); return pid
    def access(self,db,pid,user,write=False,owner=False):
        row=db.execute('SELECT p.*,m.role FROM projects p JOIN members m ON p.id=m.project_id WHERE p.id=? AND m.user_id=?',(pid,user['id'])).fetchone()
        if not row: raise Problem('Project not found.',404)
        if (write and row['role']=='viewer') or (owner and row['role']!='owner'): raise Problem('You do not have permission for this action.',403)
        return dict(row)
    def touch(self,db,pid): db.execute('UPDATE projects SET revision=revision+1,updated=? WHERE id=?',(time.time(),pid))
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
            raise Problem('This email is not approved for IDSL Lab. Ask the lab administrator to add your address.',403)
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
            with self.db() as db:
                # Permission might have been revoked while the compiler ran.
                self.access(db,pid,user,write=True)
                db.execute('INSERT OR REPLACE INTO builds VALUES(?,?,?,?,?,?,?,?)',(pid,project['revision'],int(result['success']),result['log'],pdf,result['seconds'],time.time(),result['engine']))
            return {**result,'pdf':bool(pdf),'revision':project['revision']}
        finally:
            with self.lock: self.jobs.discard(pid)

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
                public=method=='POST' and path in PUBLIC_POSTS
                if not public:
                    with self.app.db() as db: self.user(db)
                large=(path=='/api/projects' and method=='POST') or (method=='PUT' and re.fullmatch(r'/api/projects/[a-f0-9]{24}/file',path))
                data=self.body(58*1024*1024 if large else (16384 if public else 65536))
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
        if method=='GET' and not path.startswith('/api/'):
            allowed={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/visual.js':'visual.js','/style.css':'style.css','/favicon.svg':'favicon.svg'}
            if path not in allowed: raise Problem('Not found.',404)
            f=ROOT/'web'/allowed[path]; self.send(f.read_bytes(),kind=mimetypes.guess_type(f)[0] or 'text/plain'); return
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
                cookie=SimpleCookie(self.headers.get('Cookie',''))
                if 'labtex_session' in cookie: db.execute('DELETE FROM sessions WHERE token=?',(digest(cookie['labtex_session'].value),))
                self.send({'ok':True},headers={'Set-Cookie':self.cookie('',0)}); return
            if path=='/api/join' and method=='POST':
                db.execute('BEGIN IMMEDIATE'); invite=db.execute('SELECT * FROM invites WHERE token=? AND expires>?',(digest(str(data.get('token',''))),time.time())).fetchone()
                if not invite: raise Problem('Invitation has expired or was used.',403)
                db.execute('INSERT OR IGNORE INTO members VALUES(?,?,?)',(invite['project_id'],user['id'],invite['role'])); db.execute('DELETE FROM invites WHERE token=?',(invite['token'],)); return {'id':invite['project_id']}
            if path=='/api/projects':
                if method=='GET': return {'projects':[dict(x) for x in db.execute('SELECT p.id,p.name,p.main,p.updated,m.role FROM projects p JOIN members m ON p.id=m.project_id WHERE m.user_id=? ORDER BY p.updated DESC',(user['id'],))]}
                if method=='POST':
                    db.execute('BEGIN IMMEDIATE')
                    files=unpack_zip(base64.b64decode(data['zip'],validate=True)) if data.get('zip') else (SAMPLE.copy() if data.get('template',True) else {'main.tex':b'\\documentclass{article}\n\\begin{document}\nYour next idea starts here.\n\\end{document}\n'})
                    return {'id':app.new_project(db,user['id'],data.get('name','Untitled paper'),files)}
            match=re.fullmatch(r'/api/projects/([a-f0-9]{24})(?:/(.*))?',path)
            if not match: raise Problem('Not found.',404)
            pid,action=match.groups()
            if method!='GET' and action!='compile': db.execute('BEGIN IMMEDIATE')
            p=app.access(db,pid,user,write=method!='GET')
            if action is None:
                if method=='GET':
                    p['files']=[dict(x) for x in db.execute('SELECT path,length(content) AS size,revision FROM files WHERE project_id=? ORDER BY path',(pid,))]
                    b=db.execute('SELECT revision,success,seconds,created,engine FROM builds WHERE project_id=?',(pid,)).fetchone(); p['build']=dict(b) if b else None; return p
                if method=='PUT':
                    if 'main' in data:
                        main=safe_path(data['main'])
                        if not main.endswith('.tex') or not db.execute('SELECT 1 FROM files WHERE project_id=? AND path=?',(pid,main)).fetchone(): raise Problem('Choose an existing .tex file.')
                        db.execute('UPDATE projects SET main=? WHERE id=?',(main,pid))
                    if 'name' in data: db.execute('UPDATE projects SET name=? WHERE id=?',(title(data['name']),pid))
                    app.touch(db,pid); return {'ok':True}
                if method=='DELETE':
                    app.access(db,pid,user,owner=True)
                    for table in ('members','files','history','invites','builds'): db.execute('DELETE FROM '+table+' WHERE project_id=?',(pid,))
                    db.execute('DELETE FROM projects WHERE id=?',(pid,)); return {'ok':True}
            if action=='file':
                name=safe_path(query.get('path',[data.get('path','')])[0]); row=db.execute('SELECT * FROM files WHERE project_id=? AND path=?',(pid,name)).fetchone()
                if method=='GET':
                    if not row: raise Problem('File not found.',404)
                    try: content=row['content'].decode('utf-8'); binary='\x00' in content
                    except UnicodeDecodeError: binary,content=True,None
                    return {'path':name,'revision':row['revision'],'content':None if binary else content,'base64':base64.b64encode(row['content']).decode() if binary else None}
                if method=='PUT':
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
                self.send(pack_zip(files),kind='application/zip',headers={'Content-Disposition':'attachment; filename="project-source.zip"'}); return
            if action in ('pdf','log') and method=='GET':
                row=db.execute('SELECT * FROM builds WHERE project_id=?',(pid,)).fetchone()
                if not row or (action=='pdf' and not row['pdf']): raise Problem('Compile successfully to generate a PDF.',404)
                if action=='log': return {'log':row['log'],'success':bool(row['success']),'revision':row['revision']}
                self.send(row['pdf'],kind='application/pdf',headers={'Content-Disposition':('attachment' if 'download' in query else 'inline')+'; filename="paper.pdf"'}); return
            if action=='members':
                if method=='GET': return {'members':[dict(x) for x in db.execute('SELECT u.id,u.email,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id=?',(pid,))]}
                app.access(db,pid,user,owner=True)
                if method=='DELETE':
                    if data.get('userId')==p['owner']: raise Problem('The owner cannot be removed.')
                    db.execute('DELETE FROM members WHERE project_id=? AND user_id=?',(pid,data.get('userId'))); return {'ok':True}
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
