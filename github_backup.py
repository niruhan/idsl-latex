"""Source-only GitHub snapshots, using atomic non-forced branch updates."""
import base64
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from core import Problem, safe_path

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


class GitHub:
    def __init__(self, token):
        if not isinstance(token, str) or not 10 <= len(token) <= 512 or re.search(r'\s', token):
            raise Problem('Enter a GitHub access token with Contents read/write permission for the backup repository.')
        self.token = token

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
    prefix = 'projects/' + project['id'] + '/' if shared else ''
    # Manifest tracks exactly this project's files. It makes deletions bounded and
    # prevents one project from adopting another project's separate repository.
    if MANIFEST in files:
        raise Problem(MANIFEST + ' is reserved for backup metadata. Rename it before backing up.')
    metadata = json.dumps({'version': 1, 'project_id': project['id'], 'name': project['name'],
                           'main': project['main'], 'files': sorted(files)}, indent=2).encode() + b'\n'
    desired = {prefix + safe_path(p): data for p, data in files.items()}
    desired[prefix + MANIFEST] = metadata
    if info.get('size') == 0:
        # The Git database API cannot create refs in an empty repository. The
        # Contents API creates its initial commit; subsequent snapshots are atomic.
        refs = client.call(repo + '/branches?per_page=1')
        if not refs:
            client.call(repo + '/contents/' + prefix + MANIFEST, 'PUT', {
                'message': 'Initialize IDSL project backup', 'content': base64.b64encode(metadata).decode(), 'branch': branch})
    ref = client.call(ref_path)
    head = ref['object']['sha']
    commit = client.call(repo + '/git/commits/' + head)
    tree_sha = commit['tree']['sha']
    remote = client.call(repo + '/git/trees/' + tree_sha + '?recursive=1')
    if remote.get('truncated'):
        raise Problem('Repository is too large to inspect safely. Use a dedicated backup repository.', 413)
    entries = {entry['path']: entry for entry in remote['tree']}
    marker_path = prefix + MANIFEST
    previous = []
    if marker_path in entries:
        blob = client.call(repo + '/git/blobs/' + entries[marker_path]['sha'])
        try:
            manifest = json.loads(base64.b64decode(blob['content']))
            if manifest['project_id'] != project['id']:
                raise Problem('This destination already belongs to a different project. Choose another repository or use the shared layout.')
            previous = [prefix + safe_path(p) for p in manifest['files']]
        except (ValueError, KeyError, TypeError):
            raise Problem('Backup manifest is invalid. Choose a fresh backup destination.') from None
    # First backup must not replace pre-existing user files, even at the root of
    # a separate repository. README/LICENSE and unrelated files are preserved.
    elif any(path in entries or any(path.startswith(p + '/') and entry['type'] != 'tree' for p, entry in entries.items()) for path in desired):
        raise Problem('The destination contains files that overlap this project. Choose a fresh repository or shared layout.')
    changes = []
    for path, data in desired.items():
        if entries.get(path, {}).get('sha') == blob_sha(data):
            continue
        blob = client.call(repo + '/git/blobs', 'POST', {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
        changes.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    for path in previous:
        if path not in desired and path in entries:
            changes.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': None})
    if not changes:
        return {'changed': False, 'commit': head, 'url': f"https://github.com/{target['repository']}/commit/{head}", 'repository': target['repository'], 'branch': branch}
    tree = client.call(repo + '/git/trees', 'POST', {'base_tree': tree_sha, 'tree': changes})
    new = client.call(repo + '/git/commits', 'POST', {'message': 'Back up ' + project['name'], 'tree': tree['sha'], 'parents': [head]})
    client.call(repo + '/git/refs/heads/' + urllib.parse.quote(branch, safe=''), 'PATCH', {'sha': new['sha'], 'force': False})
    # Verify the branch accepted this exact snapshot; never report an unreferenced
    # Git object as a successful backup after a concurrent push.
    actual = client.call(ref_path)['object']['sha']
    if actual != new['sha']:
        raise Problem('The branch changed during verification. Retry the backup to confirm the latest snapshot.', 409)
    return {'changed': True, 'commit': actual, 'url': f"https://github.com/{target['repository']}/commit/{actual}", 'repository': target['repository'], 'branch': branch}
