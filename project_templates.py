"""Public starter projects. Instantiation always creates a private, editable copy."""
from pathlib import Path

from core import Problem, TYPST_SAMPLE

ROOT = Path(__file__).resolve().parent / 'templates'
TEMPLATES = (
    {'id': 'western-presentation', 'name': 'Western presentation', 'format': 'typst', 'featured': True,
     'description': 'Purple university slides with title, sections, equations, and discussion boxes.'},
    {'id': 'neurips-2026', 'name': 'NeurIPS 2026 paper', 'format': 'latex', 'featured': True,
     'description': 'Official 2026 style and checklist, with an anonymous research paper starter.'},
    {'id': 'getting-started-typst', 'name': 'Getting started with Typst', 'format': 'typst',
     'description': 'A short introduction with equations, an included section, and references.'},
    {'id': 'research-article', 'name': 'Classic research article', 'format': 'latex',
     'description': 'A traditional LaTeX paper with an abstract, equations, results, and bibliography.'},
    {'id': 'western-thesis', 'name': 'Western thesis scaffold', 'format': 'typst',
     'description': 'A modular thesis with preliminary pages, chapters, references, and an appendix.'},
    {'id': 'coursework-assignment', 'name': 'Coursework assignment', 'format': 'typst',
     'description': 'Numbered questions, worked solutions, equations, and a proof.'},
    {'id': 'beamer-presentation', 'name': 'Beamer presentation', 'format': 'latex',
     'description': 'Classic academic slides with an outline, equations, and a two-column slide.'},
    {'id': 'academic-cv', 'name': 'Academic CV', 'format': 'typst',
     'description': 'A clean academic résumé with education, research, publications, and skills.'},
)


def template_files(template_id):
    template = next((item for item in TEMPLATES if item['id'] == template_id), None)
    if template is None:
        raise Problem('Choose an available starter template.')
    if template_id == 'getting-started-typst':
        return template, dict(TYPST_SAMPLE)
    folder = ROOT / template['id']
    files = {path.relative_to(folder).as_posix(): path.read_bytes()
             for path in sorted(folder.rglob('*')) if path.is_file()}
    return template, files
