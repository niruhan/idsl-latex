#!/usr/bin/env python3
"""Fail closed on common private files/identifiers in Git's tracked release tree."""
import ipaddress
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_PARTS = {'.local', 'data', 'backups', 'artifacts', 'node_modules', '__pycache__', '.venv', '.ssh'}
SECRET = re.compile(r'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|#(?:signup|invite)=[A-Za-z0-9_-]{20,}')
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})')
HOME = re.compile(r'/home/([A-Za-z0-9_-]+)')
TUNNEL = re.compile(r'https://[a-z0-9-]+\.trycloudflare\.com')
IP = re.compile(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])')
# Public upstream author attribution, retained verbatim in these bundled files.
UPSTREAM_CONTACTS = {
    'templates/neurips-2026/neurips_2026.sty': {'garnett' + '@' + 'wustl.edu'},
    'typst-packages/preview/touying/0.5.3/LICENSE': {'orangex4' + '@' + 'qq.com'},
}


def main():
    vendor_root = ROOT / 'web/vendor/pdfjs'
    vendor = json.loads((vendor_root / 'UPSTREAM.json').read_text())
    if vendor['version'] != '6.4.299' or vendor['sha256'] != 'f2245eb7ef3f674c872fe568a177bfec15874f5c034613e55d8e307f93ebd86d':
        raise SystemExit('Review the pinned PDF.js release before changing its vendor manifest.')
    raw = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT)
    names = [name for name in raw.decode().split('\0') if name]
    if not names:
        raise SystemExit('No tracked files. Stage the intended release before checking.')
    failures = []
    for name in names:
        path = ROOT / name
        if PRIVATE_PARTS.intersection(path.relative_to(ROOT).parts) or path.name.startswith('.env') or re.search(r'\.(sqlite\w*|db|log|pem|key|pyc)$', name):
            failures.append((name, 'private/runtime filename'))
            continue
        if path.is_symlink() or not path.is_file():
            failures.append((name, 'symlink or missing file'))
            continue
        if name.startswith('web/vendor/pdfjs/') and name!='web/vendor/pdfjs/UPSTREAM.json':
            relative = name.removeprefix('web/vendor/pdfjs/')
            if hashlib.sha256(path.read_bytes()).hexdigest()!=vendor['files'].get(relative):
                failures.append((name, 'upstream PDF.js checksum mismatch'))
            continue
        if path.stat().st_size > 1024 * 1024:
            failures.append((name, 'unexpected large release file'))
        data = path.read_bytes()
        if (name.startswith('docs/images/') or name == 'templates/western-presentation/images/western-logo.png') and path.suffix == '.png':
            if not data.startswith(b'\x89PNG\r\n\x1a\n'):
                failures.append((name, 'invalid screenshot format'))
            continue
        try:
            content = data.decode('utf-8')
        except UnicodeDecodeError:
            failures.append((name, 'unexpected binary file'))
            continue
        if SECRET.search(content): failures.append((name, 'credential-like value'))
        if TUNNEL.search(content): failures.append((name, 'live trial hostname'))
        if any(match.group(1) != 'compiler' for match in HOME.finditer(content)):
            failures.append((name, 'host-specific home directory'))
        for match in EMAIL.finditer(content):
            domain = match.group(1).lower()
            if domain not in {'example.test', 'example.org', 'example.com', 'users.noreply.github.com'} and match.group() not in UPSTREAM_CONTACTS.get(name, set()):
                failures.append((name, 'non-example email address'))
        for match in IP.finditer(content):
            value = match.group()
            try: address = ipaddress.ip_address(value)
            except ValueError: continue  # version strings
            if value == '1.1.1.1' or address.is_loopback or address in ipaddress.ip_network('192.0.2.0/24'):
                continue
            failures.append((name, 'non-example IP address'))
    if failures:
        # Do not echo matching values: a failed check could otherwise leak them in CI.
        for name, reason in sorted(set(failures)):
            print(name + ': ' + reason, file=sys.stderr)
        raise SystemExit(1)
    print(f'Public release hygiene passed for {len(names)} tracked files. Manual review and history scanning are still required.')


if __name__ == '__main__': main()
