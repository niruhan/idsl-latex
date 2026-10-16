"""Checks for the optional Linux native deployment; no Docker dependency."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from deploy.sandbox import sandbox_command


@unittest.skipUnless(shutil.which('bwrap') and (ROOT / '.local/native.json').exists(),
                     'Native deployment is not configured')
class SandboxTests(unittest.TestCase):
    def test_only_project_and_cache_are_exposed(self):
        with tempfile.TemporaryDirectory(prefix='labtex-',dir='/dev/shm') as project, tempfile.TemporaryDirectory() as private:
            sentinel = Path(private) / 'private.txt'
            sentinel.write_text('must not be readable by the compiler')
            (Path(project) / 'main.tex').write_text('project input')
            command = sandbox_command([], project)
            command = command[:command.index('--') + 1] + ['/usr/bin/python3', '-c', '''
import os, pathlib, sys, socket
assert os.readlink("/proc/self/ns/net") != sys.argv[3]
try:
    socket.create_connection(("1.1.1.1",443),timeout=1)
except OSError: pass
else: raise AssertionError("Compiler network is reachable")
assert pathlib.Path('main.tex').read_text() == 'project input'
assert not pathlib.Path(sys.argv[1]).exists()
assert not pathlib.Path(sys.argv[2]).exists()
assert not pathlib.Path('/etc/passwd').exists()
assert 'LABTEX_TEST_PRIVATE_ENV' not in os.environ
pathlib.Path('build-output').write_text('allowed')
try:
    pathlib.Path('/usr/labtex-write-probe').write_text('must fail')
except OSError:
    pass
else:
    raise AssertionError('System tree is writable')
''', str(sentinel), str(ROOT), os.readlink('/proc/self/ns/net')]
            result = subprocess.run(command, env=dict(os.environ, LABTEX_TEST_PRIVATE_ENV='hidden'),
                                    capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((Path(project) / 'build-output').read_text(), 'allowed')

    def test_rejects_host_directories(self):
        for directory in (ROOT, Path.home(), Path('/tmp')):
            with self.subTest(directory=directory), self.assertRaises(RuntimeError):
                sandbox_command([], directory)


if __name__ == '__main__':
    unittest.main()
