"""Validation, project archives, and bounded LaTeX/Typst compilation."""
import base64, io, json, os, re, signal, subprocess, tempfile, threading, time, zipfile
from pathlib import Path, PurePosixPath
from source_map import read_source_map

MAX_FILE = 8 * 1024 * 1024
MAX_PROJECT = 40 * 1024 * 1024
MAX_FILES = 1000
TYPST_PACKAGES = Path(__file__).resolve().parent / 'typst-packages'
BUILD_LOCK = threading.Lock()
class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status

def safe_path(path):
    if not isinstance(path, str) or not 1 <= len(path) <= 220:
        raise Problem('Use a filename of 1–220 characters.')
    if any(p in ('', '.', '..') or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_. ()@+\-]*', p) for p in path.split('/')):
        raise Problem('Use a relative filename; no hidden files, special characters, or parent directories.')
    if path.split('/')[0] == '_labtex_output':
        raise Problem('This folder name is reserved for compilation.')
    return path

def directory_paths(files, directories=()):
    folders=set(directories)
    for path in list(files)+list(folders):
        parts=path.split('/')
        folders.update('/'.join(parts[:index]) for index in range(1,len(parts)))
    return folders

def unpack_zip(raw, include_directories=False):
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            entries = [x for x in z.infolist() if not x.is_dir() and not x.filename.startswith('__MACOSX/') and not any(p.startswith('.') and p not in ('.','..') for p in x.filename.split('/'))]
            if not 1 <= len(entries) <= MAX_FILES or sum(x.file_size for x in entries) > MAX_PROJECT:
                raise Problem('ZIP must contain 1–1000 files and at most 40 MB uncompressed.')
            for x in entries:
                safe_path(x.filename)
                if x.file_size > MAX_FILE or (x.external_attr >> 16) & 0o170000 == 0o120000:
                    raise Problem('ZIP contains an oversized file or symbolic link.')
            folder_entries=[x for x in z.infolist() if x.is_dir() and not x.filename.startswith('__MACOSX/') and not any(p.startswith('.') and p not in ('.','..') for p in x.filename[:-1].split('/'))]
            if len(folder_entries)>MAX_FILES: raise Problem('ZIP contains too many folders.')
            prefix = entries[0].filename.split('/')[0] + '/'
            strip = all(x.filename.startswith(prefix) for x in entries) and all(x.filename==prefix or x.filename.startswith(prefix) for x in folder_entries)
            files = {}
            for x in entries:
                name = safe_path(x.filename[len(prefix):] if strip else x.filename)
                if name in files: raise Problem('ZIP contains duplicate paths.')
                files[name] = z.read(x)
            # A downloaded GitHub snapshot can be imported as a fresh project.
            # Recognize only our complete root manifest; retain other JSON files.
            marker = files.get('labtex-project.json')
            if marker:
                try:
                    metadata = json.loads(marker)
                    if (metadata.get('version') == 1 and re.fullmatch(r'[a-f0-9]{24}', metadata.get('project_id', ''))
                            and set(metadata['files']) == set(files) - {'labtex-project.json'}):
                        del files['labtex-project.json']
                except (ValueError, TypeError, KeyError, AttributeError):
                    pass
            directories=set()
            for entry in folder_entries:
                if strip and entry.filename==prefix: continue
                name=safe_path(entry.filename[len(prefix):-1] if strip else entry.filename[:-1])
                if (entry.external_attr>>16)&0o170000==0o120000: raise Problem('ZIP contains a symbolic link.')
                directories.add(name)
            if set(files)&directory_paths(files,directories): raise Problem('A ZIP path cannot be both a file and a folder.')
            return (files,directories) if include_directories else files
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise Problem('Use a valid, unencrypted ZIP archive.')

def pack_zip(files, directories=()):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        compressed={'.png','.apng','.jpg','.jpeg','.gif','.webp','.avif','.ico','.zip','.gz','.woff2'}
        for path, data in files.items():
            # Recompressing already-compressed assets wastes CPU in exports,
            # checkpoints and collaboration baselines without shrinking them.
            kind=zipfile.ZIP_STORED if len(data)>1024 and PurePosixPath(path).suffix.lower() in compressed else zipfile.ZIP_DEFLATED
            z.writestr(safe_path(path),data,compress_type=kind)
        for path in sorted(directories): z.writestr(safe_path(path)+'/', b'')
    return out.getvalue()

def decode_files(items):
    if not isinstance(items, dict) or not 1 <= len(items) <= MAX_FILES: raise Problem('Invalid file count.')
    files = {safe_path(p): base64.b64decode(v, validate=True) for p,v in items.items()}
    if any(len(v) > MAX_FILE for v in files.values()) or sum(map(len, files.values())) > MAX_PROJECT: raise Problem('Project exceeds size limits.')
    return files

def compile_project(files, main):
    safe_path(main)
    if main not in files or not main.endswith(('.tex', '.typ')): raise Problem('Choose an existing .tex or .typ file as the main document.')
    if not BUILD_LOCK.acquire(False): raise Problem('Compiler is busy. Try again shortly.', 429)
    start = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix='labtex-',dir=os.getenv('LABTEX_TMPDIR')) as folder:
            root = Path(folder)
            for path, data in files.items():
                dest = root / safe_path(path)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
            out = root / '_labtex_output'
            out.mkdir()
            engine = 'typst' if main.endswith('.typ') else os.getenv('LATEX_ENGINE', 'tectonic')
            if engine == 'typst':
                command = [os.getenv('TYPST_BIN', 'typst'), 'compile', '--root', str(root),
                           '--diagnostic-format', 'short', main, str(out / (PurePosixPath(main).stem+'.pdf'))]
            elif engine == 'tectonic':
                command = [os.getenv('TECTONIC_BIN','tectonic'), '--untrusted', '--keep-logs', '--synctex', '--outdir', str(out), main]
            elif engine == 'pdflatex':
                # -norc rejects project .latexmkrc, and no-shell-escape rejects external commands.
                command = ['latexmk', '-norc', '-pdf', '-synctex=1', '-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', '-outdir='+str(out), main]
            else: raise Problem('Unknown LATEX_ENGINE.', 503)
            env = {k:v for k,v in os.environ.items() if k in ('PATH','HOME','XDG_CACHE_HOME','LANG','SSL_CERT_FILE','SSL_CERT_DIR','FONTCONFIG_PATH','TEXFORMATS','TYPST_PACKAGE_PATH','TYPST_PACKAGE_CACHE_PATH')}
            if engine == 'typst':
                env.setdefault('TYPST_PACKAGE_PATH', str(TYPST_PACKAGES))
            # Local builds use a dedicated compiler home, never the account's configuration.
            if os.getenv('LABTEX_COMPILER_HOME'):
                env['HOME'] = os.environ['LABTEX_COMPILER_HOME']
                env['XDG_CACHE_HOME'] = str(Path(env['HOME']) / '.cache')
            env.update(TECTONIC_UNTRUSTED_MODE='1', openin_any='p', openout_any='p', TEXMFOUTPUT=str(out))
            timeout = min(600,max(10,int(os.getenv('COMPILE_TIMEOUT','120'))))
            with tempfile.TemporaryFile() as log:
                try: proc = subprocess.Popen(command,cwd=root,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                except OSError: raise Problem(f'{engine} compiler unavailable. Run ./labtex local setup on macOS, or ask the server operator to configure this compiler.',503)
                stopped = False
                while proc.poll() is None:
                    if time.monotonic()-start > timeout or log.tell() > 4*1024*1024:
                        os.killpg(proc.pid,signal.SIGKILL); proc.wait(); stopped=True; break
                    time.sleep(.1)
                log.seek(max(0,log.tell()-128000))
                output = log.read(128000).decode('utf-8',errors='replace')
            pdf = out / (PurePosixPath(main).stem+'.pdf')
            ok = not stopped and proc.returncode == 0 and pdf.is_file() and pdf.stat().st_size <= MAX_FILE
            mapping = None
            if ok and engine != 'typst':
                stem = PurePosixPath(main).stem
                mapping = read_source_map(out / (stem + '.synctex.gz'), root, files)
                if mapping is None:
                    mapping = read_source_map(out / (stem + '.synctex'), root, files)
            return {'success':ok,'log':('Build stopped: time or output limit reached.\n' if stopped else '')+output,
                    'seconds':round(time.monotonic()-start,2),'pdf':base64.b64encode(pdf.read_bytes()).decode() if ok else None,'engine':engine,'sourceMap':mapping}
    finally: BUILD_LOCK.release()

SAMPLE = {
'main.tex': r'''\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{xcolor}
\usepackage[colorlinks=true,linkcolor=teal,citecolor=teal]{hyperref}

\title{A space for your next idea}
\author{IDSL Editor}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Great research starts with a question. This shared workspace brings your ideas, equations, and coauthors together, with your source and compiled document side by side.
\end{abstract}

\input{sections/introduction}

\section{A mathematical starting point}

The forward process gradually adds noise to an observation:

\begin{equation}
  x_t = \sqrt{\bar{\alpha}_t}\,x_0
      + \sqrt{1-\bar{\alpha}_t}\,\epsilon,
  \qquad \epsilon \sim \mathcal{N}(0,I).
\end{equation}

The challenge is to learn a reverse process that recovers the structure of the data.

\section{Next steps}

\begin{itemize}
  \item Import your existing project from Overleaf.
  \item Choose the main document and compile it.
  \item Invite a coauthor to edit or review your work.
\end{itemize}

\bibliographystyle{plain}
\bibliography{references}
\end{document}
'''.encode(),
'sections/introduction.tex':r'''\section{Introduction}

Write, explore, and refine your ideas here. The IDSL Editor workspace keeps the files, equations, and references that make up your paper together in one project.

Edit LaTeX directly in the source pane and compile to preview your paper. Fold sections and environments to focus on one part at a time.

Diffusion models provide a useful starting point for studying generative processes~\cite{ho2020denoising}.
'''.encode(),
'references.bib':b'''@inproceedings{ho2020denoising,
  title={Denoising Diffusion Probabilistic Models},
  author={Ho, Jonathan and Jain, Ajay and Abbeel, Pieter},
  booktitle={Advances in Neural Information Processing Systems},
  year={2020}
}
'''}

TYPST_SAMPLE = {
    'main.typ': b'''#set page(paper: "a4", margin: 2.5cm)
#set text(font: "Libertinus Serif", size: 11pt)
#set heading(numbering: "1.")

#align(center)[
  #text(size: 24pt, weight: "bold")[A space for your next idea]

  IDSL Editor
]

#include "sections/introduction.typ"

= A mathematical starting point

The forward process gradually adds noise to an observation:

$ x_t = sqrt(bar(alpha)_t) x_0 + sqrt(1 - bar(alpha)_t) epsilon,
  quad epsilon ~ cal(N)(0, I). $

= Next steps

- Edit headings and paragraphs in the source pane.
- Watch the live preview update as you type.
- Add figures, references, and your own chapters.

#bibliography("references.bib")
''',
    'sections/introduction.typ': b'''= Introduction

Write, explore, and refine your ideas here. Your source and compiled document stay side by side.

Typst combines readable markup with precise typesetting. Use *bold text*, _emphasis_, and equations in the source pane, with live updates beside your text.

Diffusion models provide a useful starting point for studying generative processes @ho2020denoising.
''',
    'references.bib': SAMPLE['references.bib'],
}


def starter_files(format='latex', template=True):
    if format not in ('latex', 'typst'):
        raise Problem('Choose LaTeX or Typst.')
    if template:
        return (TYPST_SAMPLE if format == 'typst' else SAMPLE).copy()
    if format == 'typst':
        return {'main.typ': b'= Your next idea\n\nStart writing here.\n'}
    return {'main.tex': b'\\documentclass{article}\n\\begin{document}\nYour next idea starts here.\n\\end{document}\n'}


def main_document(files):
    for name in ('main.tex', 'main.typ'):
        if name in files:
            return name
    return next((p for p in files if p.endswith('.tex') and b'\\documentclass' in files[p]),
                next((p for p in files if p.endswith(('.tex', '.typ'))), next(iter(files))))
