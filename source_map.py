"""Bounded SyncTeX line anchors, retaining only files from the compiled project.

Coordinates are PDF points measured from the page's top-left. This uses the
version-1 records documented in synctex(5); inverse search is approximate at
line granularity, since TeX does not normally emit source columns.
"""
import gzip
import json
from pathlib import Path
import re

MAX_MAP_BYTES = 2 * 1024 * 1024
RECORD = re.compile(r'^[\[(vhxgk$](-?\d+),(\d+)(?:,(-?\d+))?:(-?\d+),(-?\d+|=)(?::|$)')


def read_source_map(path, root, files):
    try:
        opener = gzip.open if path.suffix == '.gz' else open
        with opener(path, 'rb') as stream:
            raw = stream.read(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024:
            return None
        return parse_source_map(raw.decode('utf-8', errors='replace'), root, files)
    except (OSError, EOFError, ValueError, OverflowError):
        return None  # Missing/malformed mapping must not prevent PDF export.


def parse_source_map(text, root, files):
    if text.partition('\n')[0].rstrip('\r') != 'SyncTeX Version:1':
        return None
    root = Path(root).resolve()
    tags, names, pages, seen = {}, [], {}, set()
    unit, magnification, x_offset, y_offset = 1, 1000, 0, 0
    page, previous_y, form_depth, count = None, 0, 0, 0
    for record in text.splitlines():
        if record.startswith('Input:'):
            _, tag, name = record.split(':', 2)
            try:
                path = (root / name).resolve().relative_to(root).as_posix()
            except (ValueError, OSError):
                continue
            if path not in files or not path.endswith(('.tex', '.ltx', '.sty', '.cls')):
                continue
            if path not in names:
                names.append(path)
            tags[int(tag)] = names.index(path)
        elif record.startswith(('Unit:', 'Magnification:', 'X Offset:', 'Y Offset:')):
            key, value = record.split(':', 1)
            value = int(value)
            if key in ('Unit', 'Magnification') and value <= 0:
                return None
            if key == 'Unit': unit = value
            elif key == 'Magnification': magnification = value
            elif key == 'X Offset': x_offset = value
            else: y_offset = value
        elif record.startswith('{'):
            page = str(int(record[1:])); previous_y = 0
        elif record.startswith('}'):
            page = None
        elif record.startswith('<'):
            form_depth += 1
        elif record.startswith('>'):
            form_depth = max(0, form_depth - 1)
        elif page and not form_depth:
            match = RECORD.match(record)
            if not match:
                continue
            tag, line, column, x, y = match.groups()
            previous_y = previous_y if y == '=' else int(y)
            # Glue, kern, current and math records sit beside rendered text.
            # Container boxes often point at the end of an include/document.
            if record[0] not in 'xgk$' or int(tag) not in tags:
                continue
            factor = unit * magnification / 1000 / 65536 * 72 / 72.27
            point = [tags[int(tag)], max(0, int(line) - 1), max(0, int(column or 0) - 1),
                     round((int(x) * unit + x_offset) * factor / unit, 3),
                     round((previous_y * unit + y_offset) * factor / unit, 3)]
            key = (page, *point)
            if key not in seen:
                seen.add(key); pages.setdefault(page, []).append(point); count += 1
            if count > 50000:
                return None
    result = {'files': names, 'pages': pages}
    if not pages or len(json.dumps(result).encode()) > MAX_MAP_BYTES:
        return None
    return result
