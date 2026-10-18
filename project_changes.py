"""Atomic, revision-checked source edits and bounded recovery checkpoints."""
import base64
import time
from core import MAX_FILE, MAX_FILES, MAX_PROJECT, Problem, directory_paths, pack_zip, safe_path


def source_files(db, pid):
    result = []
    for row in db.execute('SELECT path,content,revision FROM files WHERE project_id=? ORDER BY path', (pid,)):
        try:
            content = row['content'].decode('utf-8')
            if '\0' not in content:
                result.append({'path': row['path'], 'content': content, 'revision': row['revision']})
        except UnicodeDecodeError:
            pass
    return result


def apply_changes(app, db, project, user, edits, revision, main=None, checkpoint=False):
    if type(revision) is not int or revision != project['revision']:
        raise Problem('Project changed. Refresh and review the changes again.', 409)
    if not isinstance(edits, list) or not 1 <= len(edits) <= MAX_FILES * 2:
        raise Problem('Choose 1–2000 file changes.')
    pid = project['id']
    current = {r['path']: dict(r) for r in db.execute('SELECT path,content,revision FROM files WHERE project_id=?', (pid,))}
    final = {path: row['content'] for path, row in current.items()}
    changed = {}
    for edit in edits:
        if not isinstance(edit, dict):
            raise Problem('Invalid file change.')
        path = safe_path(edit.get('path'))
        if path in changed:
            raise Problem('A file can only be changed once per operation.')
        old = current.get(path)
        if type(edit.get('revision')) is not int or edit['revision'] != (old['revision'] if old else 0):
            raise Problem('A file changed. Refresh and review the changes again.', 409)
        if edit.get('delete') is True:
            if not old:
                raise Problem('File not found.', 404)
            value = None
            final.pop(path)
        else:
            if 'base64' in edit:
                value = base64.b64decode(edit['base64'], validate=True)
            elif isinstance(edit.get('content'), str):
                value = edit['content'].encode('utf-8')
            else:
                raise Problem('Provide file content.')
            if len(value) > MAX_FILE:
                raise Problem('A file exceeds the 8 MB limit.', 413)
            final[path] = value
        changed[path] = value
    if not 1 <= len(final) <= MAX_FILES or sum(map(len, final.values())) > MAX_PROJECT:
        raise Problem('Project exceeds the file count or 40 MB size limit.', 413)
    main = safe_path(main if main is not None else project['main'])
    if main not in final or not main.endswith(('.typ', '.tex')):
        raise Problem('The main document must remain an existing .typ or .tex file.')
    if set(final) & directory_paths(final):
        raise Problem('A path cannot be both a file and a directory.', 409)
    explicit = {r['path'] for r in db.execute('SELECT path FROM directories WHERE project_id=?', (pid,))}
    if any(path == folder or folder.startswith(path + '/') for path in final for folder in explicit):
        raise Problem('A file change overlaps an existing empty directory. Rename or remove that directory first.', 409)
    changed = {path: value for path, value in changed.items() if value != (current[path]['content'] if path in current else None)}
    if not changed and main == project['main']:
        return {'changed': [], 'revision': revision, 'checkpoint': None}
    checkpoint_id = None
    if checkpoint:
        archive = pack_zip({path: row['content'] for path, row in current.items()}, explicit)
        checkpoint_id = db.execute('INSERT INTO project_checkpoints(project_id,created,source) VALUES(?,?,?)', (pid, time.time(), archive)).lastrowid
        used = 0
        for index, row in enumerate(db.execute('SELECT id,length(source) AS size FROM project_checkpoints WHERE project_id=? ORDER BY id DESC', (pid,)).fetchall()):
            used += row['size']
            if row['id'] != checkpoint_id and (used > MAX_PROJECT or index >= 5):
                db.execute('DELETE FROM project_checkpoints WHERE id=?', (row['id'],))
    for path, value in changed.items():
        old = current.get(path)
        if old:
            db.execute('INSERT INTO history(project_id,path,content,revision,author,created) VALUES(?,?,?,?,?,?)',
                       (pid, path, old['content'], old['revision'], user['name'], time.time()))
            db.execute('DELETE FROM history WHERE project_id=? AND path=? AND id NOT IN (SELECT id FROM history WHERE project_id=? AND path=? ORDER BY id DESC LIMIT 30)', (pid, path, pid, path))
        if value is None:
            db.execute('DELETE FROM files WHERE project_id=? AND path=?', (pid, path))
        else:
            db.execute('INSERT OR REPLACE INTO files VALUES(?,?,?,?)', (pid, path, value, (old['revision'] if old else 0) + 1))
    used = 0
    for row in db.execute('SELECT id,length(content) AS size FROM history WHERE project_id=? ORDER BY id DESC', (pid,)).fetchall():
        used += row['size']
        if used > MAX_PROJECT:
            db.execute('DELETE FROM history WHERE id=?', (row['id'],))
    db.execute('UPDATE projects SET main=? WHERE id=?', (main, pid))
    app.touch(db, pid)
    return {'changed': sorted(changed), 'revision': revision + 1, 'checkpoint': checkpoint_id}
