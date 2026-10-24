"""Persistent, account-scoped Tinymist LSP and preview sessions for local macOS."""
import atexit
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import select
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

from core import MAX_FILE, MAX_PROJECT, TYPST_PACKAGES, Problem, safe_path


def source_range(params):
    """Normalize preview [line, column] pairs and LSP selection objects."""
    selection = params.get('selection') or params
    if not isinstance(selection, dict):
        return None

    def position(value):
        if isinstance(value, list) and len(value) == 2:
            value = dict(zip(('line', 'character'), value))
        if isinstance(value, dict) and all(type(value.get(key)) is int and
                0 <= value[key] <= MAX_FILE for key in ('line', 'character')):
            return {key: value[key] for key in ('line', 'character')}

    start = position(selection.get('start', {'line': 0, 'character': 0}))
    end = position(selection.get('end', start))
    return {'start': start, 'end': end} if start is not None and end is not None else None


class TypstSession:
    def __init__(self, manager, user_id, project, files):
        self.manager, self.user_id, self.pid = manager, user_id, project['id']
        self.id = secrets.token_hex(16)
        self.main = project['main']
        self.folder = tempfile.TemporaryDirectory(prefix='labtex-live-', dir=os.getenv('LABTEX_TMPDIR'))
        self.root = Path(self.folder.name).resolve()
        self.lock, self.write_lock, self.operation = threading.RLock(), threading.Lock(), threading.RLock()
        self.pending, self.counter = {}, 0
        self.files, self.opened, self.sequences, self.diagnostics = {}, {}, {}, {}
        self.revision = None
        self.closed, self.port, self.active_path = False, None, None
        self.status, self.pages, self.compilations = 'Compiling', 0, 0
        self.jump, self.event = None, 0
        self.last_used = time.monotonic()
        self.log = tempfile.TemporaryFile()
        self.config = {'rootPath': str(self.root), 'exportPdf': 'never', 'compileStatus': 'enable',
                       'outputPath': '$root/_labtex_output/$name', 'customizedShowDocument': True,
                       'preview': {'background': {'enabled': False}}}
        self.sync(project, files)
        env = {key: value for key, value in os.environ.items() if key in
               ('PATH', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'FONTCONFIG_PATH',
                'TYPST_PACKAGE_PATH', 'TYPST_PACKAGE_CACHE_PATH')}
        home = Path(os.getenv('LABTEX_COMPILER_HOME') or manager.app.data / '.typst-home')
        home.mkdir(mode=0o700, parents=True, exist_ok=True)
        env['HOME'] = str(home)
        env['XDG_CACHE_HOME'] = str(Path(env.get('HOME', self.root)) / '.cache')
        env['TINYMIST_LOG'] = 'error'
        env.setdefault('TYPST_PACKAGE_PATH', str(TYPST_PACKAGES))
        try:
            self.process = subprocess.Popen([manager.binary, 'lsp'], cwd=self.root, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, start_new_session=True)
            self.reader = threading.Thread(target=self._read, daemon=True)
            self.reader.start()
            self.request('initialize', {'processId': os.getpid(), 'rootUri': self.root.as_uri(),
                'workspaceFolders': [{'uri': self.root.as_uri(), 'name': 'Document'}],
                'capabilities': {'textDocument': {'completion': {'completionItem': {'snippetSupport': False}},
                    'hover': {'contentFormat': ['plaintext']}, 'publishDiagnostics': {'versionSupport': True}},
                    'window': {'showDocument': {'support': True}}}, 'initializationOptions': self.config})
            self.notify('initialized', {})
            self.request('workspace/executeCommand', {'command': 'tinymist.pinMain',
                         'arguments': [str(self.root / self.main)]})
            preview = self.request('workspace/executeCommand', {'command': 'tinymist.doStartPreview',
                'arguments': [['--task-id', self.id, '--data-plane-host', '127.0.0.1:0',
                    '--root', str(self.root), '--invert-colors=never', '--no-open', str(self.root / self.main)]]})
            self.port = preview.get('dataPlanePort')
            if type(self.port) is not int or not 1 <= self.port <= 65535:
                raise Problem('Tinymist could not start its preview.', 503)
        except Exception:
            self.close()
            raise

    def _send(self, message):
        raw = json.dumps(message, ensure_ascii=False).encode()
        with self.write_lock:
            if self.closed or self.process.poll() is not None:
                raise Problem('Tinymist stopped. Reconnect the live preview.', 503)
            try:
                self.process.stdin.write(b'Content-Length: ' + str(len(raw)).encode() + b'\r\n\r\n' + raw)
                self.process.stdin.flush()
            except (OSError, ValueError):
                raise Problem('Tinymist disconnected. Reconnect the live preview.', 503) from None

    def notify(self, method, params):
        self._send({'jsonrpc': '2.0', 'method': method, 'params': params})

    def request(self, method, params, timeout=30):
        with self.lock:
            self.counter += 1
            number = self.counter
            event, box = threading.Event(), {}
            self.pending[number] = (event, box)
        try:
            self._send({'jsonrpc': '2.0', 'id': number, 'method': method, 'params': params})
            if not event.wait(timeout):
                self.notify('$/cancelRequest', {'id': number})
                raise Problem('Tinymist took too long. Retry or reconnect the live preview.', 504)
            if 'error' in box:
                raise Problem('Tinymist could not complete this editor request.', 422)
            return box.get('result')
        finally:
            with self.lock:
                self.pending.pop(number, None)

    def relative(self, uri):
        if not isinstance(uri, str):
            return None
        try:
            parsed = urllib.parse.urlsplit(uri)
            if parsed.scheme != 'file' or parsed.netloc not in ('', 'localhost'):
                return None
            path = Path(urllib.parse.unquote(parsed.path)).resolve().relative_to(self.root).as_posix()
            return path if path in self.files else None
        except (ValueError, OSError):
            return None

    def _read(self):
        try:
            while not self.closed:
                headers = {}
                while True:
                    line = self.process.stdout.readline(8192)
                    if not line:
                        return
                    if line == b'\r\n':
                        break
                    if len(line) >= 8192 or len(headers) >= 10:
                        return
                    key, value = line.decode('ascii').split(':', 1)
                    headers[key.lower()] = value.strip()
                size = int(headers['content-length'])
                if not 0 < size <= 16 * 1024 * 1024:
                    return
                message = json.loads(self.process.stdout.read(size))
                if 'method' in message:
                    self._notification(message)
                else:
                    with self.lock:
                        pending = self.pending.get(message.get('id'))
                        if pending:
                            pending[1].update(message)
                            pending[0].set()
        except (OSError, ValueError, KeyError, TypeError):
            pass
        finally:
            with self.lock:
                for event, box in self.pending.values():
                    box['error'] = True
                    event.set()

    def _notification(self, message):
        method, params = message['method'], message.get('params') or {}
        result = None
        with self.lock:
            if method == 'textDocument/publishDiagnostics':
                path = self.relative(params.get('uri'))
                if path:
                    self.diagnostics[path] = [{'message': str(item.get('message', ''))[:3000],
                        'severity': item.get('severity', 1), 'range': item.get('range', {})}
                        for item in params.get('diagnostics', [])[:100]]
            elif method == 'tinymist/compileStatus':
                value = params.get('status', self.status)
                self.status = value[:1].upper() + value[1:]
                self.pages = params.get('pageCount', 0)
                if self.status == 'CompileSuccess':
                    self.compilations += 1
            elif method in ('tinymist/preview/scrollSource', 'window/showDocument'):
                path = self.relative(params.get('uri'))
                if not path and params.get('filepath'):
                    path = self.relative(Path(params['filepath']).as_uri())
                selection = source_range(params)
                if path and selection:
                    self.event += 1
                    self.jump = {'id': self.event, 'path': path,
                        'range': selection}
                    result = {'success': True}
            elif method == 'workspace/configuration':
                result = [self.config for _ in params.get('items', [])]
        if 'id' in message:
            self._send({'jsonrpc': '2.0', 'id': message['id'], 'result': result})

    def sync(self, project, files):
        if project['main'] != self.main:
            raise Problem('The main document changed. Reconnect the live preview.', 409)
        with self.operation:
            for path in set(self.files) - set(files):
                if path in self.opened:
                    self.notify('textDocument/didClose', {'textDocument': {'uri': (self.root / path).as_uri()}})
                    self.opened.pop(path)
                (self.root / path).unlink(missing_ok=True)
                parent = (self.root / path).parent
                while parent != self.root:
                    try:
                        parent.rmdir()
                    except OSError:
                        break
                    parent = parent.parent
                self.files.pop(path)
                self.diagnostics.pop(path, None)
            for path, content in files.items():
                safe_path(path)
                if self.files.get(path) == content:
                    continue
                target = self.root / path
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                temporary = target.with_name('.idsl-' + secrets.token_hex(8))
                temporary.write_bytes(content)
                temporary.replace(target)
                self.files[path] = content
            self.revision = project['revision']

    def change(self, path, content, sequence):
        path = safe_path(path)
        if path not in self.files or not isinstance(content, str):
            raise Problem('Choose an existing text file.', 404)
        size = len(content.encode())
        if size > MAX_FILE or sum(len(value.encode()) for key, value in self.opened.items() if key != path) + size > MAX_PROJECT:
            raise Problem('Live editor content exceeds project limits.', 413)
        if type(sequence) is not int or not 0 <= sequence <= 2**53:
            raise Problem('Invalid editor version.')
        with self.operation:
            if sequence <= self.sequences.get(path, -1):
                return
            version = self.sequences[path] = sequence
            uri = (self.root / path).as_uri()
            if path not in self.opened:
                self.notify('textDocument/didOpen', {'textDocument': {'uri': uri, 'languageId': 'typst' if path.endswith('.typ') else 'plaintext',
                            'version': version, 'text': content}})
            elif self.opened[path] != content:
                self.notify('textDocument/didChange', {'textDocument': {'uri': uri, 'version': version},
                            'contentChanges': [{'text': content}]})
            self.opened[path], self.active_path = content, path

    def query(self, method, path, position=None):
        path = safe_path(path)
        if path not in self.files or not path.endswith('.typ'):
            raise Problem('Choose an existing Typst source file.')
        allowed = {'completion', 'hover', 'definition', 'formatting', 'documentSymbol', 'signatureHelp'}
        if method not in allowed:
            raise Problem('Unsupported language-server request.')
        params = {'textDocument': {'uri': (self.root / path).as_uri()}}
        if method not in ('formatting', 'documentSymbol'):
            if not isinstance(position, dict) or any(type(position.get(key)) is not int or not 0 <= position[key] <= MAX_FILE for key in ('line', 'character')):
                raise Problem('Invalid editor position.')
            params['position'] = {key: position[key] for key in ('line', 'character')}
        if method == 'formatting':
            params['options'] = {'tabSize': 2, 'insertSpaces': True}
        result = self.request('textDocument/' + method, params)
        if method == 'completion':
            items = (result or {}).get('items', []) if isinstance(result, dict) else result or []
            # Client-side commands are never executed; only same-document text edits are applied.
            return [{key: item[key] for key in ('label', 'detail', 'insertText', 'insertTextFormat', 'textEdit', 'additionalTextEdits') if key in item} for item in items[:100]]
        if method == 'definition':
            items = result if isinstance(result, list) else [result] if result else []
            return [{'path': path, 'range': item.get('targetSelectionRange') or item.get('range')}
                    for item in items if (path := self.relative(item.get('uri') or item.get('targetUri')))]
        return result

    def state(self):
        self.last_used = time.monotonic()
        if self.closed or self.process.poll() is not None:
            raise Problem('Tinymist stopped. Reconnect the live preview.', 503)
        with self.lock:
            return {'id': self.id, 'status': self.status, 'pages': self.pages, 'compilations': self.compilations,
                    'diagnostics': dict(self.diagnostics), 'jump': self.jump}

    def preview_html(self, endpoint):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            connection.request('GET', '/')
            response = connection.getresponse()
            raw = response.read(12 * 1024 * 1024 + 1)
            if response.status != 200 or len(raw) > 12 * 1024 * 1024:
                raise Problem('Tinymist preview is unavailable.', 503)
        finally:
            connection.close()
        nonce = secrets.token_urlsafe(20)
        # Upstream frontend is bundled in the verified binary. All WebSocket traffic
        # goes through our authenticated project/session route, never a public port.
        bridge = '<script nonce="' + nonce + '">const W=window.WebSocket;window.WebSocket=class extends W{constructor(url,protocols){super(new URL(' + json.dumps(endpoint) + ',location.href).href.replace(/^http/,"ws"),protocols)}};</script>'
        html = re.sub(r'<script\b', '<script nonce="' + nonce + '"', raw.decode())
        html = html.replace('<head>', '<head>' + bridge, 1)
        websocket_origin = self.manager.app.origin.replace('http:', 'ws:').replace('https:', 'wss:')
        policy = "default-src 'none'; script-src 'nonce-" + nonce + "' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; worker-src blob:; connect-src 'self' " + websocket_origin + " data: blob:; frame-ancestors 'self'; base-uri 'none'"
        return html, policy

    def tunnel(self, handler, authorize):
        if handler.headers.get('Origin') != self.manager.app.origin:
            raise Problem('Origin does not match APP_ORIGIN.', 403)
        key = handler.headers.get('Sec-WebSocket-Key', '')
        try:
            if len(base64.b64decode(key, validate=True)) != 16 or handler.headers.get('Sec-WebSocket-Version') != '13':
                raise ValueError()
        except ValueError:
            raise Problem('Invalid preview connection.') from None
        try:
            upstream = socket.create_connection(('127.0.0.1', self.port), timeout=10)
        except OSError:
            raise Problem('Tinymist preview disconnected. Reconnect the live preview.', 503) from None
        try:
            request = ('GET / HTTP/1.1\r\nHost: 127.0.0.1:' + str(self.port) + '\r\nOrigin: http://127.0.0.1:' + str(self.port) + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + '\r\n\r\n')
            upstream.sendall(request.encode('ascii'))
            raw = b''
            while b'\r\n\r\n' not in raw and len(raw) < 16384:
                block = upstream.recv(4096)
                if not block:
                    break
                raw += block
            headers, separator, extra = raw.partition(b'\r\n\r\n')
            accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            if not separator or not headers.startswith(b'HTTP/1.1 101') or accept.encode() not in headers:
                raise Problem('Tinymist preview did not accept the connection.', 503)
            handler.send_response(101)
            for name, value in [('Upgrade', 'websocket'), ('Connection', 'Upgrade'), ('Sec-WebSocket-Accept', accept)]:
                handler.send_header(name, value)
            handler.end_headers()
            handler.wfile.flush()
            handler.close_connection = True
            client = handler.connection
            client.settimeout(5)
            if extra:
                client.sendall(extra)
            checked = time.monotonic()
            while not self.closed:
                if time.monotonic() - checked > 5:
                    if not authorize():
                        break
                    checked = time.monotonic()
                ready, _, _ = select.select([client, upstream], [], [], 1)
                for source in ready:
                    block = source.recv(65536)
                    if not block:
                        return
                    (upstream if source is client else client).sendall(block)
                    self.last_used = time.monotonic()
        except OSError:
            pass
        finally:
            upstream.close()

    def close(self):
        self.closed = True
        process = getattr(self, 'process', None)
        if process and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        if process:
            for stream in (process.stdin, process.stdout):
                if stream:
                    stream.close()
        self.log.close()
        self.folder.cleanup()


class TypstService:
    def __init__(self, app):
        self.app = app
        self.binary = os.getenv('TINYMIST_BIN', '')
        self.available = (sys.platform == 'darwin' and os.getenv('LABTEX_TYPST_LIVE') != '0'
                          and not app.compiler_url and bool(self.binary) and os.access(self.binary, os.X_OK))
        self.sessions, self.lock, self.reaper = {}, threading.RLock(), None
        self.stopped = threading.Event()
        atexit.register(self.close)

    def capabilities(self):
        return {'available': self.available, 'engine': 'Tinymist',
                'reason': '' if self.available else 'Live Typst requires the local Mac runner and ./labtex setup. PDF compilation remains available.'}

    def open(self, user_id, project, files):
        if not self.available:
            raise Problem(self.capabilities()['reason'], 503)
        if not project['main'].endswith('.typ'):
            raise Problem('Live preview requires a Typst project.')
        with self.lock:
            if self.stopped.is_set():
                raise Problem('The app is stopping. Reopen it before starting a live preview.', 503)
            if len(self.sessions) >= 3 or sum(session.user_id == user_id for session in self.sessions.values()) >= 2:
                raise Problem('Close another live Typst tab before starting this one.', 429)
            session = TypstSession(self, user_id, project, files)
            self.sessions[session.id] = session
            if self.reaper is None:
                self.reaper = threading.Thread(target=self._reap, daemon=True)
                self.reaper.start()
            return session

    def get(self, user_id, pid, session_id):
        with self.lock:
            session = self.sessions.get(session_id)
            if not session or (session.user_id, session.pid) != (user_id, pid):
                raise Problem('Live session not found. Reconnect the live preview.', 404)
            session.last_used = time.monotonic()
            return session

    def remove(self, session):
        with self.lock:
            if self.sessions.pop(session.id, None):
                session.close()

    def discard(self, pid=None, user_id=None):
        with self.lock:
            for session in list(self.sessions.values()):
                if (pid is None or session.pid == pid) and (user_id is None or session.user_id == user_id):
                    self.remove(session)

    def _reap(self):
        while not self.stopped.wait(15):
            with self.lock:
                for session in list(self.sessions.values()):
                    if session.closed or session.process.poll() is not None or time.monotonic() - session.last_used > 180 or session.log.tell() > 4 * 1024 * 1024:
                        self.remove(session)

    def close(self):
        self.stopped.set()
        atexit.unregister(self.close)
        self.discard()
