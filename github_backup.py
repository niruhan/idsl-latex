"""Source-only GitHub snapshots, using atomic non-forced branch updates."""
import base64
import hashlib
import json
import re
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from core import MAX_FILES, Problem, safe_path

MANIFEST = 'labtex-project.json'


def destination(value):
    if not isinstance(value, dict):
        raise Problem('Invalid backup settings.')
    repo = str(value.get('repository', '')).strip().removeprefix('https://github.com/').rstrip('/').removesuffix('.git')
    branch = str(value.get('branch', '')).strip()
    if repo and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}', repo):
        raise Problem('Use a GitHub repository in owner/repository format.')
    if repo and repo.split('/')[1] in ('.', '..'):
        raise Problem('Use a GitHub repository in owner/repository format.')
    if branch and (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]{0,199}', branch) or '..' in branch or branch.endswith(('/', '.', '.lock')) or '//' in branch):
        raise Problem('Use a valid Git branch name, or leave it blank for the default branch.')
    return {'repository': repo, 'branch': branch}


def blob_sha(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def project_folder(name):
    """Keep readable names while producing one portable directory component."""
    name = unicodedata.normalize('NFC', str(name))
    name = ''.join('-' if char in '<>:"/\\|?*' or unicodedata.category(char) in ('Cc', 'Cf') else char for char in name)
    name = re.sub(r'\s+', ' ', name).strip(' .')
    name = name.encode()[:160].decode('utf-8', errors='ignore').rstrip(' .') or 'Untitled project'
    if re.fullmatch(r'CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]', name.split('.')[0], re.I):
        name = '_' + name
    return name


def read_manifest(client, repo, entry):
    if entry.get('type') != 'blob' or entry.get('mode') not in ('100644', '100755'):
        return None
    cache = getattr(client, 'manifests', {})
    key = (repo, entry['sha'])
    if key in cache:
        return cache[key]
    blob = client.call(repo + '/git/blobs/' + entry['sha'])
    try:
        value = json.loads(base64.b64decode(blob['content']))
        value = value if isinstance(value, dict) else None
    except (ValueError, KeyError, TypeError):
        value = None
    if len(cache) < 128:
        cache[key] = value
    return value


def shared_folder(client, repo, entries, project):
    if 'projects' in entries and entries['projects']['type'] != 'tree':
        raise Problem('The destination has a file named projects. Use another backup repository.')
    previous = []
    for path, entry in entries.items():
        if re.fullmatch(r'projects/[^/]+/' + re.escape(MANIFEST), path):
            value = read_manifest(client, repo, entry)
            if value and value.get('project_id') == project['id']:
                previous.append((path.removesuffix(MANIFEST), value))
    if len(previous) > 1:
        raise Problem('This project has multiple backup folders. Keep one backup manifest or choose a fresh destination.')
    old_prefix, manifest = previous[0] if previous else ('', None)
    folders = {path.split('/')[1] for path in entries if path.startswith('projects/') and len(path.split('/')) > 1}
    base = project_folder(project['name'])
    # Keep an allocated duplicate-name suffix stable on subsequent backups.
    old_name = old_prefix.split('/')[1] if old_prefix else ''
    matches = re.fullmatch(re.escape(base) + r'(?: \(([2-9]|[1-9][0-9]+)\))?', old_name)
    if matches and sum(unicodedata.normalize('NFC', name).casefold() == old_name.casefold() for name in folders) == 1:
        return old_prefix, old_prefix, manifest
    occupied = {unicodedata.normalize('NFC', name).casefold() for name in folders if name != old_name}
    candidate, number = base, 1
    while candidate.casefold() in occupied:
        number += 1
        candidate = base + ' (' + str(number) + ')'
    return 'projects/' + candidate + '/', old_prefix, manifest


class GitHub:
    def __init__(self, token):
        if not isinstance(token, str) or not 10 <= len(token) <= 512 or re.search(r'\s', token):
            raise Problem('Enter a GitHub access token with Contents read/write permission for the backup repository.')
        self.token = token
        # Immutable metadata is reused only within this authenticated operation.
        self.manifests = {}

    def call(self, path, method='GET', data=None):
        request = urllib.request.Request('https://api.github.com' + path,
            data=json.dumps(data).encode() if data is not None else None, method=method,
            headers={'Authorization': 'Bearer ' + self.token, 'Accept': 'application/vnd.github+json',
                     'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28',
                     'User-Agent': 'IDSL-workspace-backup'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read(16 * 1024 * 1024))
        except urllib.error.HTTPError as error:
            messages = {401: 'GitHub rejected the token. Check its value and expiry.',
                        403: 'GitHub denied access. Check repository permissions, rate limits, and branch protection.',
                        404: 'Repository or branch not found. Create the repository first and grant the token access.',
                        409: 'The GitHub branch changed or is empty. Retry the backup.',
                        422: 'GitHub could not update the branch. Check branch protection or retry after other pushes.'}
            # Never return remote response bodies, credentials, or source in errors/logs.
            raise Problem(messages.get(error.code, 'GitHub could not complete the backup. Try again later.'), 502) from None
        except (OSError, ValueError):
            raise Problem('GitHub is unreachable. Your local project is saved; retry its backup later.', 502) from None


def backup_snapshot(client, target, project, files, shared=True):
    target = destination(target)
    if not target['repository']:
        raise Problem('Choose a GitHub backup repository first.')
    repo = '/repos/' + target['repository']
    info = client.call(repo)
    branch = target['branch'] or info['default_branch']
    ref_path = repo + '/git/ref/heads/' + urllib.parse.quote(branch, safe='')
    prefix = 'projects/' + project_folder(project['name']) + '/' if shared else ''
    # Manifest tracks exactly this project's files. It makes deletions bounded and
    # prevents one project from adopting another project's separate repository.
    if MANIFEST in files:
        raise Problem(MANIFEST + ' is reserved for backup metadata. Rename it before backing up.')
    metadata = json.dumps({'version': 1, 'project_id': project['id'], 'name': project['name'],
                           'main': project['main'], 'files': sorted(files)}, indent=2).encode() + b'\n'
    for path in files:
        safe_path(path)
    if info.get('size') == 0:
        # The Git database API cannot create refs in an empty repository. The
        # Contents API creates its initial commit; subsequent snapshots are atomic.
        refs = client.call(repo + '/branches?per_page=1')
        if not refs:
            client.call(repo + '/contents/' + urllib.parse.quote(prefix + MANIFEST, safe='/'), 'PUT', {
                'message': 'Initialize IDSL project backup', 'content': base64.b64encode(metadata).decode(), 'branch': branch})
    ref = client.call(ref_path)
    head = ref['object']['sha']
    commit = client.call(repo + '/git/commits/' + head)
    tree_sha = commit['tree']['sha']
    remote = client.call(repo + '/git/trees/' + tree_sha + '?recursive=1')
    if remote.get('truncated'):
        raise Problem('Repository is too large to inspect safely. Use a dedicated backup repository.', 413)
    entries = {entry['path']: entry for entry in remote['tree']}
    old_prefix, manifest = prefix, None
    if shared:
        prefix, old_prefix, manifest = shared_folder(client, repo, entries, project)
    marker_path = prefix + MANIFEST
    if not shared and marker_path in entries:
        manifest = read_manifest(client, repo, entries[marker_path])
        if manifest and manifest.get('project_id') != project['id']:
            raise Problem('This destination already belongs to a different project. Choose another repository or use the shared layout.')
        if not manifest:
            raise Problem('Backup manifest is invalid. Choose a fresh backup destination.')
    previous = set()
    if manifest:
        try:
            names = manifest['files']
            if manifest.get('version') != 1 or not isinstance(names, list) or len(names) > MAX_FILES or MANIFEST in names:
                raise ValueError()
            previous = {old_prefix + safe_path(p) for p in names}
            previous.add(old_prefix + MANIFEST)
        except (ValueError, KeyError, TypeError):
            raise Problem('Backup manifest is invalid. Choose a fresh backup destination.') from None
    desired = {prefix + path: data for path, data in files.items()}
    desired[marker_path] = metadata
    # Never replace untracked repository content, including files manually added
    # beside an existing snapshot. Only manifest-owned source can be removed.
    foreign = {path: entry for path, entry in entries.items() if path not in previous}
    ancestors = {path[:index] for path in foreign for index, char in enumerate(path) if char == '/'}
    def overlaps(path):
        return path in foreign or path in ancestors or any(foreign.get(path[:index], {}).get('type', 'tree') != 'tree' for index, char in enumerate(path) if char == '/')
    if any(overlaps(path) for path in desired):
        raise Problem('The destination contains files that overlap this project. Choose a fresh repository or shared layout.')
    if any(entries[path]['type'] != 'blob' for path in previous if path in entries):
        raise Problem('A managed backup file was replaced with a directory or submodule. Choose a fresh destination.')
    changes = []
    known_blobs = {entry['sha'] for entry in entries.values() if entry['type'] == 'blob'}
    for path, data in desired.items():
        sha = blob_sha(data)
        if entries.get(path, {}).get('sha') == sha and entries[path].get('mode') == '100644':
            continue
        if sha not in known_blobs:
            sha = client.call(repo + '/git/blobs', 'POST', {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})['sha']
            known_blobs.add(sha)
        changes.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': sha})
    old_tree = old_prefix.rstrip('/')
    descendants = {path: entry for path, entry in entries.items() if old_prefix and path.startswith(old_prefix)}
    removable = all(path in previous if entry['type'] != 'tree' else any(p.startswith(path + '/') for p in previous) for path, entry in descendants.items())
    if shared and old_prefix and old_prefix != prefix and entries.get(old_tree, {}).get('type') == 'tree' and removable:
        changes.append({'path': old_tree, 'mode': '040000', 'type': 'tree', 'sha': None})
        previous = set()
    for path in sorted(previous):
        if path not in desired and path in entries:
            changes.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': None})
    if not changes:
        return {'changed': False, 'commit': head, 'url': f"https://github.com/{target['repository']}/commit/{head}", 'repository': target['repository'], 'branch': branch, 'folder': prefix.rstrip('/')}
    tree = client.call(repo + '/git/trees', 'POST', {'base_tree': tree_sha, 'tree': changes})
    new = client.call(repo + '/git/commits', 'POST', {'message': 'Back up ' + project['name'], 'tree': tree['sha'], 'parents': [head]})
    client.call(repo + '/git/refs/heads/' + urllib.parse.quote(branch, safe=''), 'PATCH', {'sha': new['sha'], 'force': False})
    # Verify the branch accepted this exact snapshot; never report an unreferenced
    # Git object as a successful backup after a concurrent push.
    actual = client.call(ref_path)['object']['sha']
    if actual != new['sha']:
        raise Problem('The branch changed during verification. Retry the backup to confirm the latest snapshot.', 409)
    return {'changed': True, 'commit': actual, 'url': f"https://github.com/{target['repository']}/commit/{actual}", 'repository': target['repository'], 'branch': branch, 'folder': prefix.rstrip('/')}
