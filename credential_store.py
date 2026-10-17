"""Account-scoped backup credentials, outside SQLite and browser storage."""
import ctypes
import hashlib
import os
from pathlib import Path
import re
import sys
import tempfile

from core import Problem


def valid_token(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{10,512}', value):
        raise Problem('Enter a valid GitHub access token.')
    return value


def account(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{24}', value):
        raise Problem('A signed-in account is required to save a token.', 403)
    return value


class FileTokenStore:
    """Linux: private server files, accessible to the service's OS account."""
    label = 'private server credential file'

    def __init__(self, directory):
        self.directory = Path(directory)

    def path(self, user_id):
        return self.directory / account(user_id)

    def has(self, user_id):
        return self.path(user_id).is_file()

    def get(self, user_id):
        try:
            return valid_token(self.path(user_id).read_text())
        except FileNotFoundError:
            return None
        except (OSError, UnicodeError):
            raise Problem('Could not read the saved GitHub token. Save it again.', 503) from None

    def set(self, user_id, token):
        path = self.path(user_id)
        token = valid_token(token)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.directory, 0o700)
        fd, name = tempfile.mkstemp(prefix='.token-', dir=self.directory)
        try:
            with os.fdopen(fd, 'w') as stream:
                stream.write(token)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, path)  # mkstemp creates a 0600 file.
        finally:
            Path(name).unlink(missing_ok=True)

    def delete(self, user_id):
        self.path(user_id).unlink(missing_ok=True)


class KeychainTokenStore:
    """Use Security.framework directly: credentials never enter process arguments."""
    label = 'macOS Keychain'

    def __init__(self, installation):
        self.service = 'org.idsl-editor.github.' + hashlib.sha256(str(Path(installation).resolve()).encode()).hexdigest()[:24]
        self.cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        self.sec = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
        pointer = ctypes.c_void_p
        self.cf.CFStringCreateWithCString.argtypes = [pointer, ctypes.c_char_p, ctypes.c_uint32]
        self.cf.CFStringCreateWithCString.restype = pointer
        self.cf.CFDataCreate.argtypes = [pointer, pointer, ctypes.c_long]
        self.cf.CFDataCreate.restype = pointer
        self.cf.CFDictionaryCreate.argtypes = [pointer, pointer, pointer, ctypes.c_long, pointer, pointer]
        self.cf.CFDictionaryCreate.restype = pointer
        self.cf.CFDataGetLength.argtypes = [pointer]
        self.cf.CFDataGetLength.restype = ctypes.c_long
        self.cf.CFDataGetBytePtr.argtypes = [pointer]
        self.cf.CFDataGetBytePtr.restype = pointer
        self.cf.CFRelease.argtypes = [pointer]
        for name, args in [('SecItemAdd', [pointer, pointer]), ('SecItemCopyMatching', [pointer, pointer]),
                           ('SecItemUpdate', [pointer, pointer]), ('SecItemDelete', [pointer])]:
            function = getattr(self.sec, name)
            function.argtypes = args
            function.restype = ctypes.c_int32

    def constant(self, name):
        library = self.cf if name.startswith('kCF') else self.sec
        return ctypes.c_void_p.in_dll(library, name).value

    def dictionary(self, extra, user_id=None):
        values = {'kSecClass': ('constant', 'kSecClassGenericPassword')}
        if user_id is not None:
            values.update({'kSecAttrService': self.service, 'kSecAttrAccount': account(user_id)})
        else:
            values = {}
        values.update(extra)
        owned, keys, items = [], [], []
        for key, value in values.items():
            keys.append(self.constant(key))
            if isinstance(value, tuple):
                item = self.constant(value[1])
            elif isinstance(value, bytes):
                item = self.cf.CFDataCreate(None, value, len(value))
                owned.append(item)
            else:
                item = self.cf.CFStringCreateWithCString(None, value.encode(), 0x08000100)
                owned.append(item)
            items.append(item)
        array = ctypes.c_void_p * len(keys)
        result = self.cf.CFDictionaryCreate(None, array(*keys), array(*items), len(keys), None, None)
        return result, owned

    def call(self, name, extra, user_id, update=None):
        query, owned = self.dictionary(extra, user_id)
        changes = None
        result = ctypes.c_void_p()
        try:
            if update is not None:
                changes, more = self.dictionary({'kSecValueData': update.encode()})
                owned.extend(more)
                status = self.sec.SecItemUpdate(query, changes)
            elif name == 'SecItemDelete':
                status = self.sec.SecItemDelete(query)
            else:
                status = getattr(self.sec, name)(query, ctypes.byref(result))
            if status not in (0, -25300, -25299):
                raise Problem('macOS Keychain is unavailable or locked. Unlock it and try again.', 503)
            value = None
            if status == 0 and result.value and 'kSecReturnData' in extra:
                value = ctypes.string_at(self.cf.CFDataGetBytePtr(result), self.cf.CFDataGetLength(result)).decode('ascii')
            return status, value
        finally:
            for item in [result.value, query, changes, *owned]:
                if item:
                    self.cf.CFRelease(item)

    def has(self, user_id):
        return self.call('SecItemCopyMatching', {}, user_id)[0] == 0

    def get(self, user_id):
        return self.call('SecItemCopyMatching', {'kSecReturnData': ('constant', 'kCFBooleanTrue')}, user_id)[1]

    def set(self, user_id, token):
        token = valid_token(token)
        if self.call('SecItemAdd', {'kSecValueData': token.encode()}, user_id)[0] == -25299:
            self.call('SecItemUpdate', {}, user_id, update=token)

    def delete(self, user_id):
        self.call('SecItemDelete', {}, user_id)


def token_store(data):
    return KeychainTokenStore(data) if sys.platform == 'darwin' else FileTokenStore(Path(data) / '.github-tokens')
