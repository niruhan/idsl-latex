import fcntl
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from deploy import local
from deploy.sandbox import sandbox_command


class LocalTests(unittest.TestCase):
    def test_local_environment_drops_deployment_secrets_and_uses_private_compilers(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(local, 'STATE', Path(directory)), patch.dict(os.environ, {'COMPILER_URL': 'https://example.test/compiler', 'SETUP_TOKEN': 'private-bootstrap', 'TRUST_CLOUDFLARE': '1', 'TECTONIC_BIN': '/wrong/compiler', 'TINYMIST_BIN': '/wrong/language-server'}):
            env = local.environment()
            self.assertNotIn('COMPILER_URL', env)
            self.assertNotIn('SETUP_TOKEN', env)
            self.assertNotIn('TRUST_CLOUDFLARE', env)
            self.assertEqual(env['TECTONIC_BIN'], str(Path(directory) / 'bin/tectonic'))
            self.assertEqual(env['TYPST_BIN'], str(Path(directory) / 'bin/typst'))
            self.assertEqual(env['TINYMIST_BIN'], str(Path(directory) / 'bin/tinymist'))
            self.assertEqual(env['LABTEX_COMPILER_HOME'], str(Path(directory) / 'compiler-home'))

    def test_running_uses_live_lock_instead_of_stale_pid(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(local, 'STATE', Path(directory)):
            (Path(directory) / 'local.pid').write_text('1234567')
            self.assertFalse(local.running())
            with (Path(directory) / 'local.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertTrue(local.running())
            self.assertFalse(local.running())

    def test_linux_typst_dispatch_stays_inside_the_sandbox(self):
        # Build the command on Mac without executing Linux-specific isolation.
        with patch('deploy.sandbox.Path.read_text', return_value='{"tex_environment":"/opt/tex","tex_bundle":"/opt/bundle.zip"}'), patch('deploy.sandbox.Path.is_file', return_value=True):
            command = sandbox_command(['compile', '--root', '/dev/shm/labtex-test', 'main.typ', 'out.pdf'], '/dev/shm/labtex-test')
        self.assertIn('--unshare-net', command)
        payload = command[command.index('--') + 1:]
        self.assertEqual(payload[:2], ['/opt/tex/bin/typst', 'compile'])
        self.assertNotIn('--bundle', payload)


if __name__ == '__main__': unittest.main()
