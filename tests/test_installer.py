import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from deploy.launcher import convert_bundle, download, unit_text


class InstallerTests(unittest.TestCase):
    def test_verified_cached_download_does_not_use_network(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'asset'
            path.write_bytes(b'verified public asset')
            pin = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'url': 'https://example.test/asset'}
            with patch('deploy.launcher.urllib.request.urlopen') as network:
                download(pin, path)
                network.assert_not_called()

    def test_bad_download_is_not_installed(self):
        response = io.BytesIO(b'wrong content')
        response.url = 'https://example.test/asset'
        response.headers = {}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'asset'
            with patch('deploy.launcher.urllib.request.urlopen', return_value=response):
                with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                    download({'sha256': '0' * 64, 'url': response.url}, path)
            self.assertFalse(path.exists())
            self.assertFalse(path.with_suffix('.part').exists())

    def test_bundle_conversion_preserves_regular_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'bundle.tar', Path(directory) / 'bundle.zip'
            with tarfile.open(source, 'w') as archive:
                member = tarfile.TarInfo('tex/input.tex'); member.size = 5
                archive.addfile(member, io.BytesIO(b'hello'))
            convert_bundle(source, target)
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(archive.read('tex/input.tex'), b'hello')

    def test_bundle_paths_and_links_are_rejected(self):
        for name, link in [('../escape', False), ('/absolute', False), ('tex/link', True)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                source, target = Path(directory) / 'bundle.tar', Path(directory) / 'bundle.zip'
                with tarfile.open(source, 'w') as archive:
                    member = tarfile.TarInfo(name)
                    if link: member.type = tarfile.SYMTYPE; member.linkname = '/etc/passwd'
                    archive.addfile(member)
                with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
                    convert_bundle(source, target)
                self.assertFalse(target.exists())

    def test_unit_quotes_paths_and_never_contains_bootstrap_tokens(self):
        with patch('deploy.launcher.ROOT', Path('/srv/Lab Papers/100% ready')):
            text = unit_text()
        self.assertIn('WorkingDirectory=/srv/Lab Papers/100%% ready', text)
        self.assertIn('ExecStart=/usr/bin/python3 "/srv/Lab Papers/100%% ready/deploy/native_host.py"', text)
        self.assertNotIn('SETUP_TOKEN', text)


if __name__ == '__main__': unittest.main()
