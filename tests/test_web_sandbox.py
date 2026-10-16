import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from deploy.web_sandbox import ROOT, web_command, web_environment


@unittest.skipUnless(shutil.which('bwrap') and (ROOT/'.local/native.json').exists(),'Native deployment is not configured')
class WebSandboxTests(unittest.TestCase):
    def test_private_host_files_and_deployment_secrets_are_hidden(self):
        with tempfile.TemporaryDirectory() as private:
            sentinel=Path(private)/'private.txt';sentinel.write_text('private')
            command,work=web_command()
            script='''
import os, pathlib, sys
root=pathlib.Path(sys.argv[1])
assert (root/'server.py').is_file()
assert (root/'.local/native.json').is_file()
assert not (root/'.local/setup-token').exists()
assert not (root/'.local/web.log').exists()
assert not pathlib.Path(sys.argv[2]).exists()
assert not pathlib.Path(sys.argv[3]).exists()
assert 'LABTEX_TEST_PRIVATE_ENV' not in os.environ
try: (root/'server.py').open('a')
except OSError: pass
else: raise AssertionError('Application source is writable')
pathlib.Path('/dev/shm/probe').write_text('private tmpfs')
'''
            command=command[:command.index('--')+1]+['/usr/bin/python3','-c',script,str(ROOT),str(sentinel),str(Path.home()/'.ssh')]
            try:
                from unittest.mock import patch
                with patch.dict(os.environ,LABTEX_TEST_PRIVATE_ENV='secret'):
                    environment=web_environment()
                result=subprocess.run(command,env=environment,capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual((work/'probe').read_text(),'private tmpfs')
            finally:shutil.rmtree(work)
