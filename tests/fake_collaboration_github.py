"""Versioned GitHub Git objects for cross-installation tests; no network or tokens."""
import base64
import copy
import hashlib
import json
import urllib.parse
from core import Problem
from github_backup import blob_sha


class CollaborationGitHub:
    def __init__(self,files):
        self.calls=[];self.manifests={};self.blobs={};self.trees={};self.commits={};self.before_patch=None;self.after_patch=None
        entries={path:self.blob(path,value) for path,value in files.items()}
        tree=self.tree(entries);self.head=self.commit(tree,[],'Initial fictional backup')

    def blob(self,path,value):
        sha=blob_sha(value);self.blobs[sha]=value
        return {'path':path,'sha':sha,'mode':'100644','type':'blob','size':len(value)}

    def tree(self,entries):
        sha=hashlib.sha1(json.dumps(entries,sort_keys=True).encode()).hexdigest();self.trees[sha]=copy.deepcopy(entries);return sha

    def commit(self,tree,parents,message):
        value={'tree':{'sha':tree},'parents':parents,'message':message};sha=hashlib.sha1(json.dumps(value,sort_keys=True).encode()).hexdigest();self.commits[sha]=value;return sha

    def files(self):
        return {path:self.blobs[entry['sha']] for path,entry in self.trees[self.commits[self.head]['tree']['sha']].items() if entry['type']=='blob'}

    def edit(self,changes):
        entries=copy.deepcopy(self.trees[self.commits[self.head]['tree']['sha']])
        for path,value in changes.items():
            if value is None:entries.pop(path,None)
            else:entries[path]=self.blob(path,value)
        self.head=self.commit(self.tree(entries),[self.head],'Fictional external edit')

    def ancestor(self,old,new):
        return old==new or any(self.ancestor(old,parent) for parent in self.commits[new]['parents'])

    def call(self,path,method='GET',data=None):
        self.calls.append((path,method,copy.deepcopy(data)))
        if path=='/repos/example/papers':return {'default_branch':'main','size':1}
        if '/git/ref/heads/' in path:return {'object':{'sha':self.head}}
        if '/git/commits/' in path:return copy.deepcopy(self.commits[path.rsplit('/',1)[1]])
        if '/git/trees/' in path:
            entries=copy.deepcopy(self.trees[path.rsplit('/',1)[1].split('?')[0]])
            parents={name[:index]:{'path':name[:index],'mode':'040000','type':'tree','sha':'d'*40} for name in entries for index,char in enumerate(name) if char=='/'}
            return {'tree':list(parents.values())+list(entries.values()),'truncated':False}
        if '/git/blobs/' in path:return {'content':base64.b64encode(self.blobs[path.rsplit('/',1)[1]]).decode()}
        if path.endswith('/git/blobs') and method=='POST':
            value=base64.b64decode(data['content']);sha=blob_sha(value);self.blobs[sha]=value;return {'sha':sha}
        if path.endswith('/git/trees') and method=='POST':
            entries=copy.deepcopy(self.trees[data['base_tree']])
            for change in data['tree']:
                if change['sha'] is None:entries.pop(change['path'],None)
                else:entries[change['path']]=dict(change)
            return {'sha':self.tree(entries)}
        if path.endswith('/git/commits') and method=='POST':return {'sha':self.commit(data['tree'],data['parents'],data['message'])}
        if '/git/refs/heads/' in path and method=='PATCH':
            assert data['force'] is False
            if self.before_patch:
                action=self.before_patch;self.before_patch=None;action()
            if not self.ancestor(self.head,data['sha']):raise Problem('Another collaborator published first. Review & sync again.',409)
            self.head=data['sha']
            if self.after_patch:
                action=self.after_patch;self.after_patch=None;action()
            return {'object':{'sha':self.head}}
        raise AssertionError((path,method))
