"""Two real local app servers, one simulated GitHub repository, fictional data."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import App,Handler,BoundedHTTPServer
from credential_store import FileTokenStore
from github_backup import MANIFEST
from fake_collaboration_github import CollaborationGitHub
from test_app import Client


def main():
    os.environ['LABTEX_TYPST_LIVE']='0'
    instances=[]
    with tempfile.TemporaryDirectory(prefix='idsl-collaboration-browser-') as temporary:
        try:
            for index in range(2):
                server=BoundedHTTPServer(('127.0.0.1',0),Handler);origin='http://127.0.0.1:'+str(server.server_address[1]);app=App(Path(temporary)/str(index),origin);app.tokens=FileTokenStore(app.data/'.github-tokens');server.app=app
                thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();client=Client(server.server_address[1]);email='collaboration-'+('a' if index==0 else 'b')+'@example.test'
                status,_=client.call('/api/setup','POST',{'token':app.setup_token,'name':'Fictional collaborator '+str(index+1),'email':email,'password':'fictional-collaboration-password'})
                assert status==200
                app.tokens.set(client.call('/api/session')[1]['user']['id'],'fictional-collaboration-token-'+str(index))
                instances.append((server,thread,origin,client))
            owner=instances[0][3];pid=owner.call('/api/projects','POST',{'name':'Shared example','format':'typst','template':False})[1]['id'];source=b'= Shared example\nFirst paragraph.\nMiddle paragraph.\nLast paragraph.\n'
            assert owner.call('/api/projects/'+pid+'/file','PUT',{'path':'main.typ','content':source.decode(),'revision':1})[0]==200
            metadata={'version':1,'project_id':pid,'name':'Shared example','main':'main.typ','files':['main.typ']}
            remote=CollaborationGitHub({'projects/Shared example/'+MANIFEST:json.dumps(metadata).encode(),'projects/Shared example/main.typ':source,'README.md':b'Unrelated repository text'})
            env=dict(os.environ,TEST_ORIGIN=instances[0][2],TEST_OTHER_ORIGIN=instances[1][2],TEST_PROJECT_A=pid)
            with patch('server.GitHub',return_value=remote),patch('github_collaboration.GitHub',return_value=remote):
                subprocess.run([os.environ.get('NODE_BIN','node'),str(Path(__file__).with_name('browser_collaboration.cjs'))],env=env,cwd=Path(__file__).resolve().parents[1],check=True)
        finally:
            for server,thread,origin,client in instances:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':main()
