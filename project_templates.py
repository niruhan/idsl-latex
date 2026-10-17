"""Public starter projects. Instantiation always creates a private, editable copy."""
from pathlib import Path

from core import Problem

ROOT = Path(__file__).resolve().parent / 'templates'
TEMPLATES = (
    {'id': 'western-presentation', 'name': 'Western presentation', 'format': 'typst',
     'description': 'Purple university slides with title, sections, equations, and discussion boxes.'},
    {'id': 'neurips-2026', 'name': 'NeurIPS 2026 paper', 'format': 'latex',
     'description': 'Official 2026 style and checklist, with an anonymous research paper starter.'},
)


def template_files(template_id):
    template = next((item for item in TEMPLATES if item['id'] == template_id), None)
    if template is None:
        raise Problem('Choose an available starter template.')
    folder = ROOT / template['id']
    files = {path.relative_to(folder).as_posix(): path.read_bytes()
             for path in sorted(folder.rglob('*')) if path.is_file()}
    return template, files
