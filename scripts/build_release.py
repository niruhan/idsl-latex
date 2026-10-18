#!/usr/bin/env python3
"""Build a source-only, checksummed updater package from an immutable Git tag."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from deploy.updates import MARKER,REPOSITORY,source_path,version


def build(root,tag,output):
    root=Path(root)
    if not version(tag)[-1]:raise ValueError('Update packages require a stable release tag.')
    commit=subprocess.check_output(['git','rev-parse','refs/tags/'+tag+'^{commit}'],cwd=root,text=True).strip()
    raw=subprocess.check_output(['git','archive','--format=tar',commit],cwd=root)
    files={}
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for item in archive:
            if item.isdir():continue
            if not item.isfile():raise ValueError('Release source cannot contain links.')
            source_path(root,item.name)
            if item.name==MARKER:raise ValueError('The generated release manifest must not be tracked.')
            files[item.name]=archive.extractfile(item).read()
    expected=tag.removeprefix('v')
    if files.get('VERSION',b'').decode().strip()!=expected:raise ValueError('Set VERSION to the release version before tagging.')
    if not {'labtex','server.py','deploy/local.py'}<=files.keys():raise ValueError('This is not an IDSL Editor source release.')
    metadata={'schema':1,'repository':REPOSITORY,'version':expected,'commit':commit,'files':{name:hashlib.sha256(content).hexdigest() for name,content in sorted(files.items())}}
    files[MARKER]=(json.dumps(metadata,indent=2)+'\n').encode();output=Path(output);output.mkdir(parents=True,exist_ok=True)
    target=output/('idsl-latex-'+tag+'.zip')
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,content in sorted(files.items()):
            info=zipfile.ZipInfo('idsl-latex/'+name);info.external_attr=(0o100755 if name=='labtex' else 0o100644)<<16;info.compress_type=zipfile.ZIP_STORED if name.endswith(('.png','.jpg','.webp','.woff2')) else zipfile.ZIP_DEFLATED;archive.writestr(info,content)
    digest=hashlib.sha256(target.read_bytes()).hexdigest();(output/('idsl-latex-'+tag+'-SHA256SUMS.txt')).write_text(digest+'  '+target.name+'\n')
    return target


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('tag');parser.add_argument('--output',default='dist');args=parser.parse_args()
    try:print(build(Path(__file__).resolve().parents[1],args.tag,args.output))
    except (OSError,ValueError,subprocess.CalledProcessError) as error:parser.exit(1,str(error)+'\n')
