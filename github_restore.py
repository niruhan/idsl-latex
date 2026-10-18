"""Read immutable GitHub backup snapshots and prepare bounded source diffs."""
import base64
import difflib
import re
import urllib.parse
from core import MAX_FILE, MAX_FILES, MAX_PROJECT, Problem, safe_path
from github_backup import MANIFEST, blob_sha, destination, read_manifest


def oid(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{40}', value):
        raise Problem('GitHub returned an invalid Git object.', 502)
    return value


def tree_at(client, target, commit=None):
    target = destination(target)
    if not target['repository']:
        raise Problem('Choose a GitHub repository.')
    repo = '/repos/' + target['repository']
    info = client.call(repo)
    branch = target['branch'] or info['default_branch']
    head = oid(commit) if commit else oid(client.call(repo + '/git/ref/heads/' + urllib.parse.quote(branch, safe=''))['object']['sha'])
    tree = client.call(repo + '/git/commits/' + head)
    remote = client.call(repo + '/git/trees/' + oid(tree['tree']['sha']) + '?recursive=1')
    if remote.get('truncated') or len(remote.get('tree', [])) > 100000:
        raise Problem('Repository is too large to inspect safely. Use a dedicated backup repository.', 413)
    return {**target, 'branch': branch, 'commit': head, 'repo': repo, 'entries': {e['path']: e for e in remote['tree']}}


def manifest_at(client, tree, folder):
    if not isinstance(folder, str) or folder and not re.fullmatch(r'projects/[^/]+', folder):
        raise Problem('Choose a project backup folder.')
    prefix = folder + '/' if folder else ''
    entry = tree['entries'].get(prefix + MANIFEST)
    value = read_manifest(client, tree['repo'], entry) if entry else None
    try:
        if not value or value.get('version') != 1 or not re.fullmatch(r'[a-f0-9]{24}', value['project_id']):
            raise ValueError()
        names = value['files']
        if not isinstance(names, list) or not 1 <= len(names) <= MAX_FILES or len(set(names)) != len(names) or MANIFEST in names:
            raise ValueError()
        for path in names:
            safe_path(path)
        main = safe_path(value['main'])
        if not main.endswith(('.tex', '.typ')):
            raise ValueError()
        name = str(value['name']).strip()
        if not 1 <= len(name) <= 120:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise Problem('This backup has an invalid project manifest.') from None
    return value


def inspect_backups(client, target):
    tree = tree_at(client, target, target.get('commit') or None)
    paths = [path for path in tree['entries'] if path == MANIFEST or re.fullmatch(r'projects/[^/]+/' + re.escape(MANIFEST), path)]
    if len(paths) > 100:
        raise Problem('This repository contains too many project backups to inspect at once.', 413)
    projects = []
    for path in sorted(paths):
        folder = path[:-len(MANIFEST)].rstrip('/')
        try:
            metadata = manifest_at(client, tree, folder)
            projects.append({'folder': folder, 'name': metadata['name'], 'main': metadata['main'], 'projectId': metadata['project_id'], 'files': len(metadata['files']), 'collaboration': metadata.get('collaboration') == 1})
        except Problem:
            continue
    if not projects:
        raise Problem('No IDSL project backups found in this repository.', 404)
    return {key: tree[key] for key in ('repository', 'branch', 'commit')} | {'projects': projects}


def read_snapshot(client, target, folder, commit, managed_only=False):
    tree = tree_at(client, target, commit)
    metadata = manifest_at(client, tree, folder)
    prefix = folder + '/' if folder else ''
    files, ignored, total = {}, [], 0
    other_backups = [path[:-len(MANIFEST)] for path in tree['entries'] if not folder and re.fullmatch(r'projects/[^/]+/' + re.escape(MANIFEST), path)]
    for path, entry in sorted(tree['entries'].items()):
        if not path.startswith(prefix) or entry.get('type') == 'tree' or path == prefix + MANIFEST:
            continue
        name = path[len(prefix):]
        if managed_only and name not in metadata['files']:
            ignored.append(name)
            continue
        if any(path.startswith(other) for other in other_backups):
            continue
        # Root backups may coexist with repository administration files. They
        # are not compiler input; manifest-owned unsafe paths are rejected above.
        try:
            safe_path(name)
        except Problem:
            ignored.append(name)
            continue
        if entry.get('type') != 'blob' or entry.get('mode') not in ('100644', '100755'):
            raise Problem('The selected backup contains a symbolic link or submodule.')
        if len(files) >= MAX_FILES or entry.get('size', 0) > MAX_FILE:
            raise Problem('The selected backup exceeds project limits.', 413)
        blob = client.call(tree['repo'] + '/git/blobs/' + oid(entry['sha']))
        try:
            content = base64.b64decode(blob['content'].replace('\n', ''), validate=True)
        except (KeyError, TypeError, ValueError):
            raise Problem('GitHub returned invalid file content.', 502) from None
        total += len(content)
        if len(content) > MAX_FILE or total > MAX_PROJECT:
            raise Problem('The selected backup exceeds the 8 MB file or 40 MB project limit.', 413)
        if blob_sha(content) != entry['sha']:
            raise Problem('GitHub file verification failed. Retry the preview.', 502)
        files[name] = content
    if metadata['main'] not in files:
        raise Problem('The backup is missing its main document.')
    return {'repository': tree['repository'], 'branch': tree['branch'], 'commit': tree['commit'], 'folder': folder, 'name': metadata['name'], 'main': metadata['main'], 'files': files, 'ignored': ignored[:100], 'metadata': metadata}


def source_diff(path, before, after, budget=120000):
    try:
        old = (before or b'').decode('utf-8')
        new = (after or b'').decode('utf-8')
        if '\0' in old or '\0' in new:
            raise UnicodeError()
    except UnicodeError:
        return {'binary': True, 'diff': '', 'truncated': False}
    # A bounded excerpt avoids quadratic diffs on very large/repetitive files.
    if len(old) + len(new) > 400000 or old.count('\n') + new.count('\n') > 4000:
        return {'binary': False, 'diff': '--- Local (excerpt)\n' + old[:budget // 2] + '\n+++ GitHub (excerpt)\n' + new[:budget // 2], 'truncated': True}
    output, size = [], 0
    for line in difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True), fromfile='Local/' + path, tofile='GitHub/' + path, n=3):
        if size + len(line) > budget:
            return {'binary': False, 'diff': ''.join(output), 'truncated': True}
        output.append(line if line.endswith('\n') else line + '\n')
        size += len(line)
    return {'binary': False, 'diff': ''.join(output), 'truncated': False}


def changes_between(local, remote):
    return [{'path': path, 'status': 'added' if path not in local else 'deleted' if path not in remote else 'modified', 'oldBytes': len(local.get(path, b'')), 'newBytes': len(remote.get(path, b''))}
            for path in sorted(set(local) | set(remote)) if local.get(path) != remote.get(path)]
