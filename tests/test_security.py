import http.client
import os
import socket
import time
import unittest
from unittest.mock import patch
import test_app
from test_app import Client


class SecurityTests(unittest.TestCase):
    setUp = test_app.AppTests.setUp
    tearDown = test_app.AppTests.tearDown
    lab_signup = test_app.AppTests.lab_signup

    def token(self):
        return self.owner.call('/api/lab-invite','POST',{})[1]['links'][0]['url'].split('#signup=')[1]

    def payload(self,email,token,verification):
        return dict(email=email,token=token,name='Lab member',password='test-password-long',**verification)

    def test_only_admin_account_invites_can_register(self):
        token=self.token();outsider=Client(self.port)
        self.assertEqual(outsider.call('/api/register-lab','POST',self.payload('outsider@example.test',token,{}))[0],403)
        project=self.owner.call(self.base+'/invite','POST',{'role':'editor'})[1]['url'].split('#invite=')[1]
        with self.app.db() as db:db.execute('INSERT INTO approved_emails VALUES(?)',('approved@example.test',))
        self.assertEqual(outsider.call('/api/register-lab','POST',self.payload('approved@example.test',project,{}))[0],403)
        self.assertEqual(outsider.call('/api/register','POST',self.payload('approved@example.test',project,{}))[0],401)
        self.assertEqual(self.owner.call('/api/send-verification','POST',{})[0],404)
        with self.app.db() as db:
            self.assertNotEqual(db.execute('SELECT token FROM lab_invites').fetchone()[0],token)
    def test_invitation_has_one_winner_when_redeemed_concurrently(self):
        from concurrent.futures import ThreadPoolExecutor
        token=self.token()
        with self.app.db() as db:
            db.executemany('INSERT INTO approved_emails VALUES(?)',[(f'racer{i}@example.test',) for i in range(2)])
        def register(i):return Client(self.port).call('/api/register-lab','POST',self.payload(f'racer{i}@example.test',token,{}))[0]
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(register,range(2)))
        self.assertEqual(sorted(results),[200,403])
        with self.app.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM users').fetchone()[0],2)
            self.assertEqual(db.execute('SELECT count(*) FROM projects').fetchone()[0],2)

    def test_removing_email_revokes_sessions_and_login(self):
        member,status,_=self.lab_signup(self.token(),'removed@example.test');self.assertEqual(status,200)
        self.assertEqual(member.call('/api/approved-emails')[0],403)
        self.assertEqual(self.owner.call('/api/approved-emails','PUT',{'emails':[]})[0],200)
        self.assertEqual(member.call('/api/projects')[0],401)
        self.assertEqual(member.call('/api/login','POST',{'email':'removed@example.test','password':'private-lab-password'})[0],403)
        self.assertEqual(self.owner.call('/api/projects')[0],200)
        from server import App
        App(self.tmp.name,self.owner.origin)
        with self.app.db() as db: self.assertFalse(db.execute('SELECT 1 FROM approved_emails WHERE email=?',('removed@example.test',)).fetchone())

    def test_request_limits_apply_before_reading_body(self):
        for path,cookie,expected in [('/api/projects','',401),('/api/login','',413)]:
            conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=2)
            conn.putrequest('POST',path)
            for k,v in {'Origin':self.owner.origin,'Cookie':cookie,'Content-Type':'application/json','Content-Length':str(50*1024*1024)}.items():conn.putheader(k,v)
            conn.endheaders()  # Deliberately send no body: rejection must not wait for it.
            self.assertEqual(conn.getresponse().status,expected);conn.close()
        self.assertEqual(self.owner.call('/api/projects','POST',{'zip':[[]]*3000})[0],413)

    def test_trusted_proxy_rates_clients_independently(self):
        with patch.dict(os.environ,{'TRUST_CLOUDFLARE':'1'}):
            for _ in range(30):Client(self.port).call('/api/login','POST',{},extra_headers={'CF-Connecting-IP':'192.0.2.1'})
            self.assertEqual(Client(self.port).call('/api/login','POST',{},extra_headers={'CF-Connecting-IP':'192.0.2.1'})[0],429)
            self.assertEqual(Client(self.port).call('/api/login','POST',{},extra_headers={'CF-Connecting-IP':'192.0.2.2'})[0],400)
        self.app.attempts.clear()
        with patch.dict(os.environ,{'TRUST_CLOUDFLARE':'0'}):
            Client(self.port).call('/api/login','POST',{},extra_headers={'CF-Connecting-IP':'192.0.2.99'})
            self.assertEqual(set(self.app.attempts),{'127.0.0.1'})

    def test_history_deletion_and_project_limits(self):
        with patch('server.MAX_HISTORY',10):
            for revision in range(1,5):
                self.assertEqual(self.owner.call(self.base+'/file','PUT',{'path':'sections/introduction.tex','revision':revision,'content':'12345678'})[0],200)
            with self.app.db() as db:
                self.assertLessEqual(db.execute('SELECT COALESCE(SUM(length(content)),0) FROM history WHERE project_id=?',(self.pid,)).fetchone()[0],10)
            self.assertEqual(self.owner.call(self.base+'/file','DELETE',{'path':'sections/introduction.tex','revision':5})[0],200)
            with self.app.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM history WHERE project_id=?',(self.pid,)).fetchone()[0],0)
        with patch('server.MAX_OWNED_PROJECTS',1):self.assertEqual(self.owner.call('/api/projects','POST',{'name':'Over limit'})[0],413)

    def test_bounded_handlers_release_slots(self):
        sockets=[]
        try:
            for _ in range(8):
                sock=socket.create_connection(('127.0.0.1',self.port));sock.settimeout(2)
                sock.sendall(b'GET /api/session HTTP/1.1\r\n');sockets.append(sock)
            deadline=time.monotonic()+2
            while self.server.slots._value and time.monotonic()<deadline:time.sleep(.01)
            self.assertEqual(Client(self.port).call('/api/session')[0],503)
        finally:
            for sock in sockets:sock.close()
        deadline=time.monotonic()+2
        while self.server.slots._value!=8 and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(self.server.slots._value,8)


if __name__=='__main__':unittest.main()
