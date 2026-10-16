"""Validation, project archives, and bounded native LaTeX compilation."""
import base64, io, os, re, signal, subprocess, tempfile, threading, time, zipfile
from pathlib import Path, PurePosixPath

MAX_FILE = 8 * 1024 * 1024
MAX_PROJECT = 40 * 1024 * 1024
MAX_FILES = 1000
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

def unpack_zip(raw):
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            entries = [x for x in z.infolist() if not x.is_dir() and not x.filename.startswith('__MACOSX/') and not any(p.startswith('.') and p not in ('.','..') for p in x.filename.split('/'))]
            if not 1 <= len(entries) <= MAX_FILES or sum(x.file_size for x in entries) > MAX_PROJECT:
                raise Problem('ZIP must contain 1–1000 files and at most 40 MB uncompressed.')
            for x in entries:
                safe_path(x.filename)
                if x.file_size > MAX_FILE or (x.external_attr >> 16) & 0o170000 == 0o120000:
                    raise Problem('ZIP contains an oversized file or symbolic link.')
            prefix = entries[0].filename.split('/')[0] + '/'
            strip = all(x.filename.startswith(prefix) for x in entries)
            files = {}
            for x in entries:
                name = safe_path(x.filename[len(prefix):] if strip else x.filename)
                if name in files: raise Problem('ZIP contains duplicate paths.')
                files[name] = z.read(x)
            return files
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise Problem('Use a valid, unencrypted ZIP archive.')

def pack_zip(files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for path, data in files.items(): z.writestr(safe_path(path), data)
    return out.getvalue()

def decode_files(items):
    if not isinstance(items, dict) or not 1 <= len(items) <= MAX_FILES: raise Problem('Invalid file count.')
    files = {safe_path(p): base64.b64decode(v, validate=True) for p,v in items.items()}
    if any(len(v) > MAX_FILE for v in files.values()) or sum(map(len, files.values())) > MAX_PROJECT: raise Problem('Project exceeds size limits.')
    return files

def compile_project(files, main):
    safe_path(main)
    if main not in files or not main.endswith('.tex'): raise Problem('Choose an existing .tex file as the main document.')
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
            engine = os.getenv('LATEX_ENGINE', 'tectonic')
            if engine == 'tectonic':
                command = [os.getenv('TECTONIC_BIN','tectonic'), '--untrusted', '--keep-logs', '--synctex', '--outdir', str(out), main]
            elif engine == 'pdflatex':
                # -norc rejects project .latexmkrc, and no-shell-escape rejects external commands.
                command = ['latexmk', '-norc', '-pdf', '-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', '-outdir='+str(out), main]
            else: raise Problem('Unknown LATEX_ENGINE.', 503)
            env = {k:v for k,v in os.environ.items() if k in ('PATH','HOME','XDG_CACHE_HOME','LANG','SSL_CERT_FILE','SSL_CERT_DIR','FONTCONFIG_PATH','TEXFORMATS')}
            env.update(TECTONIC_UNTRUSTED_MODE='1', openin_any='p', openout_any='p', TEXMFOUTPUT=str(out))
            timeout = min(600,max(10,int(os.getenv('COMPILE_TIMEOUT','120'))))
            with tempfile.TemporaryFile() as log:
                try: proc = subprocess.Popen(command,cwd=root,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                except OSError: raise Problem('Compiler unavailable. Ask the server operator to run ./labtex doctor.',503)
                stopped = False
                while proc.poll() is None:
                    if time.monotonic()-start > timeout or log.tell() > 4*1024*1024:
                        os.killpg(proc.pid,signal.SIGKILL); proc.wait(); stopped=True; break
                    time.sleep(.1)
                log.seek(max(0,log.tell()-128000))
                output = log.read(128000).decode('utf-8',errors='replace')
            pdf = out / (PurePosixPath(main).stem+'.pdf')
            ok = not stopped and proc.returncode == 0 and pdf.is_file() and pdf.stat().st_size <= MAX_FILE
            return {'success':ok,'log':('Build stopped: time or output limit reached.\n' if stopped else '')+output,
                    'seconds':round(time.monotonic()-start,2),'pdf':base64.b64encode(pdf.read_bytes()).decode() if ok else None,'engine':engine}
    finally: BUILD_LOCK.release()

SAMPLE = {
'main.tex': r'''\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{xcolor}
\usepackage[colorlinks=true,linkcolor=teal,citecolor=teal]{hyperref}

\title{A space for your next idea}
\author{IDSL Lab}
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

Write, explore, and refine your ideas here. The IDSL Lab workspace keeps the files, equations, and references that make up your paper together in one project.

Switch to Visual mode to edit plain paragraphs and headings. Advanced LaTeX remains available in source cards, so your original commands stay intact.

Diffusion models provide a useful starting point for studying generative processes~\cite{ho2020denoising}.
'''.encode(),
'references.bib':b'''@inproceedings{ho2020denoising,
  title={Denoising Diffusion Probabilistic Models},
  author={Ho, Jonathan and Jain, Ajay and Abbeel, Pieter},
  booktitle={Advances in Neural Information Processing Systems},
  year={2020}
}
'''}
