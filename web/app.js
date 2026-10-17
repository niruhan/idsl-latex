import {escapeHTML as esc,renderVisual,renderTypstVisual} from './visual.js';
const $=id=>document.getElementById(id);
const S={user:null,project:null,file:null,text:'',saved:'',mode:'source',dirty:false,saving:null,conflict:false,building:false,authMode:'login',invite:new URLSearchParams(location.hash.slice(1)).get('invite'),signup:new URLSearchParams(location.hash.slice(1)).get('signup'),canInviteLab:false,demo:false,pdfKey:null,githubToken:'',backupAuto:false};
const Home={visible:false,projects:[],folders:[],templates:[],folder:null,sampleId:null,filter:'all',view:localStorage.getItem('labtex-project-view')==='list'?'list':'grid',sort:'updated'};
const FileTree={projects:new Map(),searchKey:null,searchCollapsed:new Set()};
let saveTimer,autoTimer,toastTimer,pollBusy=false,compileAgain=false,navigationId=0;const backupTimers=new Map();
const isTypst=()=>S.file?.path.endsWith('.typ');
const isDocument=()=>/\.(tex|typ)$/.test(S.file?.path||'');
function scheduleCompile(){clearTimeout(autoTimer);if(!$('autoCompile').checked||!editable())return;if(S.building){compileAgain=true;return;}autoTimer=setTimeout(()=>compile().catch(fail),900);}
const apiPath=(action='')=>'/api/projects/'+S.project.id+(action?'/'+action:'');
async function api(path,method='GET',body){
 const response=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 const value=await response.json();if(!response.ok){const e=new Error(value.error||'Request failed');e.status=response.status;throw e;}return value;
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
function fail(e){toast(e.message||String(e));}
function action(id,fn){$(id).addEventListener('click',()=>Promise.resolve().then(fn).catch(fail));}
function modal(title,html){$('modalTitle').textContent=title;$('modalBody').innerHTML=html;if(!$('modal').open)$('modal').showModal();}
function closeModal(){$('modal').close();}
function draftKey(){return `labtex-draft:${S.user?.id}:${S.project?.id}:${S.file?.path}`;}
function keepDraft(){if(S.file&&S.dirty){try{sessionStorage.setItem(draftKey(),JSON.stringify({content:S.text,revision:S.file.revision}));}catch{toast('Browser draft storage is full. Save or download your draft.');}}}
function markSaved(label,kind=''){$('saveStatus').textContent=label;$('saveStatus').className='save-status '+kind;}
function setText(text,fromVisual=false){S.text=text;S.dirty=S.text!==S.saved;markSaved(S.dirty?'Unsaved changes':'All changes saved',S.dirty?'dirty':'');if(!fromVisual){$('code').value=text;highlight();}keepDraft();clearTimeout(saveTimer);if(S.dirty&&!S.conflict)saveTimer=setTimeout(()=>save().catch(fail),800);updateStats();updateBuild();}
function highlight(){
 const value=$('code').value;
 $('lineNumbers').textContent=Array.from({length:value.split('\n').length},(_,i)=>i+1).join('\n');
 $('code').classList.toggle('plain',value.length>400000);
 const pattern=isTypst()?/(\/\/[^\n]*|#[A-Za-z_][\w.-]*|^={1,6}(?= )|[{}[\]]|\$[^$\n]*\$)/gm:/(%[^\n]*|\\[A-Za-z@]+|\\.|[{}]|\$[^$\n]*\$)/g;
 $('highlight').innerHTML=value.length>400000?'':value.split(pattern).map((part,i)=>i%2?`<span class="${part.startsWith('%')||part.startsWith('//')?'comment':/^[\\#=]/.test(part)?'command':part.startsWith('$')?'math':'brace'}">${esc(part)}</span>`:esc(part)).join('')+'\n';syncScroll();
}
function syncScroll(){$('highlight').scrollTop=$('code').scrollTop;$('highlight').scrollLeft=$('code').scrollLeft;$('lineNumbers').scrollTop=$('code').scrollTop;}
function updateStats(){const pos=$('code').selectionStart;const before=$('code').value.slice(0,pos);$('cursorPosition').textContent=`Ln ${before.split('\n').length}, Col ${before.length-before.lastIndexOf('\n')}`;$('wordCount').textContent=(S.text.trim().match(/\S+/g)||[]).length+' words';}
function editable(){return S.project&&S.project.role!=='viewer';}
function editorMode(mode){S.mode=mode;$('sourceTab').classList.toggle('active',mode==='source');$('visualTab').classList.toggle('active',mode==='visual');$('sourceTab').setAttribute('aria-selected',String(mode==='source'));$('visualTab').setAttribute('aria-selected',String(mode==='visual'));$('sourceEditor').hidden=mode!=='source'||S.file?.content===null;$('visualEditor').hidden=mode!=='visual'||S.file?.content===null;
 if(mode==='visual'&&S.file?.content!==null)(isTypst()?renderTypstVisual:renderVisual)($('visualEditor'),S.text,editable(),text=>setText(text,true));else{$('code').value=S.text;highlight();}
}
async function save(){
 clearTimeout(saveTimer);
 if(S.saving){await S.saving;if(S.dirty&&!S.conflict)return save();return !S.conflict;}
 if(!S.dirty)return true;if(S.conflict||!editable())return false;
 const content=S.text,path=S.file.path,pid=S.project.id,key=draftKey(),revision=S.file.revision;markSaved('Saving…');
 S.saving=(async()=>{try{const r=await api(`/api/projects/${pid}/file`,'PUT',{path,content,revision});S.file.revision=r.revision;S.saved=content;S.dirty=S.text!==content;if(!S.dirty){sessionStorage.removeItem(key);markSaved('All changes saved');}else{keepDraft();markSaved('Unsaved changes','dirty');}
 const meta=S.project.files.find(f=>f.path===path);if(meta)meta.revision=r.revision;
 scheduleCompile();scheduleBackup(pid);return true;
 }catch(e){markSaved(e.status===409?'Save conflict':'Could not save','error');keepDraft();if(e.status===409){S.conflict=true;await showConflict();return false;}throw e;}finally{S.saving=null;}})();
 const ok=await S.saving;if(S.dirty&&ok&&!S.conflict)return save();return ok;
}
async function showConflict(){const latest=await api(apiPath('file')+'?path='+encodeURIComponent(S.file.path));modal('Two versions, both safe',`<p>A coauthor changed this file. Your draft has not overwritten their work. Download your draft, then load the latest version and merge your changes.</p><div class="conflict-grid"><label>Your draft<textarea id="localConflict" readonly></textarea></label><label>Server version<textarea id="serverConflict" readonly></textarea></label></div><div class="actions"><button id="downloadDraft" class="outline">Download my draft</button><button id="useServer" class="primary">Load server version</button></div>`);$('localConflict').value=S.text;$('serverConflict').value=latest.content??'[Binary file]';action('downloadDraft',()=>download(S.text,'my-draft.'+(isTypst()?'typ':'tex'),'text/plain'));action('useServer',()=>{download(S.text,'my-draft.'+(isTypst()?'typ':'tex'),'text/plain');sessionStorage.removeItem(draftKey());S.conflict=false;S.dirty=false;closeModal();loadFile(S.file.path,true);});}
function download(data,name,type){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function base64File(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});}
function folderState(){
 const key=`labtex-folders:${S.user.id}:${S.project.id}`;
 if(!FileTree.projects.has(key)){
  let paths=[];try{const saved=JSON.parse(localStorage.getItem(key));if(Array.isArray(saved))paths=saved.filter(path=>typeof path==='string');}catch{}
  FileTree.projects.set(key,new Set(paths));
 }
 return {key,collapsed:FileTree.projects.get(key)};
}
function rememberFolders({key,collapsed}){try{localStorage.setItem(key,JSON.stringify([...collapsed]));}catch{}}
function revealFile(path){
 const state=folderState(),parts=path.split('/');let changed=false;
 for(let depth=1;depth<parts.length;depth++)changed=state.collapsed.delete(parts.slice(0,depth).join('/'))||changed;
 if(changed)rememberFolders(state);
}
function renderFiles(){if(!S.project)return;const term=$('fileFilter').value.toLowerCase();const tree=$('fileTree'),state=folderState();const root={folders:new Map(),files:[]};
 const searchKey=state.key+':'+term;if(FileTree.searchKey!==searchKey){FileTree.searchKey=searchKey;FileTree.searchCollapsed.clear();}
 const collapsed=term?FileTree.searchCollapsed:state.collapsed;
 for(const file of S.project.files.filter(file=>file.path.toLowerCase().includes(term))){
  const parts=file.path.split('/');let node=root;
  for(let depth=0;depth<parts.length-1;depth++){
   const name=parts[depth];if(!node.folders.has(name))node.folders.set(name,{path:parts.slice(0,depth+1).join('/'),folders:new Map(),files:[]});node=node.folders.get(name);
  }
  node.files.push(file);
 }
 let folderId=0;
 function renderNode(node,parent){
  for(const file of node.files){
   const b=document.createElement('button');b.className='tree-file'+(S.file?.path===file.path?' active':'');b.title=file.path;const ext=file.path.split('.').pop();b.innerHTML=`<span class="file-icon">${esc(ext==='tex'?'T':ext==='bib'?'B':ext.slice(0,3).toUpperCase())}</span><span class="filename">${esc(file.path.split('/').at(-1))}</span>${file.path===S.project.main?'<small>MAIN</small>':''}`;b.addEventListener('click',()=>loadFile(file.path).catch(fail));parent.append(b);
  }
  for(const [name,folder] of node.folders){
   const row=document.createElement('button'),arrow=document.createElement('span'),label=document.createElement('span'),children=document.createElement('div');
   row.type='button';row.className='tree-folder';row.dataset.folder=folder.path;row.title=folder.path;arrow.setAttribute('aria-hidden','true');label.textContent=name;label.className='filename';row.append(arrow,label);
   children.className='tree-children';children.id='file-folder-'+folderId++;row.setAttribute('aria-controls',children.id);
   function expanded(value){children.hidden=!value;row.setAttribute('aria-expanded',String(value));row.setAttribute('aria-label',(value?'Collapse ':'Expand ')+folder.path);arrow.textContent=value?'▾':'▸';}
   expanded(!collapsed.has(folder.path));row.addEventListener('click',()=>{const value=children.hidden;if(value)collapsed.delete(folder.path);else collapsed.add(folder.path);if(!term)rememberFolders(state);expanded(value);});
   parent.append(row,children);renderNode(folder,children);
  }
 }
 tree.replaceChildren();renderNode(root,tree);
 $('workspaceLanguage').textContent=S.project.main.endsWith('.typ')?'TYPST WORKSPACE':'LATEX WORKSPACE';$('mainFile').innerHTML=S.project.files.filter(f=>/\.(tex|typ)$/.test(f.path)).map(f=>`<option value="${esc(f.path)}">${esc(f.path)}</option>`).join('');$('mainFile').value=S.project.main;
}
async function loadFile(path,force=false){if(!force&&(!await save()))return;const pid=S.project.id;const f=await api(apiPath('file')+'?path='+encodeURIComponent(path));if(S.project?.id!==pid)return;S.file=f;S.text=f.content??'';S.saved=S.text;S.dirty=false;S.conflict=false;$('filePath').textContent=path;$('fileType').textContent=path.endsWith('.typ')?'Typst':path.endsWith('.tex')?'LaTeX':path.split('.').pop().toUpperCase();$('code').setAttribute('aria-label',isTypst()?'Typst source':'LaTeX source');$('visualTab').disabled=!isDocument();if(!isDocument())S.mode='source';document.querySelectorAll('[data-insert]').forEach(b=>b.disabled=!editable()||!isDocument());$('binaryPreview').hidden=f.content!==null;$('code').readOnly=!editable();markSaved('All changes saved');
 if(f.content===null){const ext=path.split('.').pop().toLowerCase();const mimes={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',pdf:'application/pdf'};$('binaryPreview').replaceChildren();if(mimes[ext]){const el=document.createElement(ext==='pdf'?'iframe':'img');el.src='data:'+mimes[ext]+';base64,'+f.base64;el.alt=path;el.title=path;$('binaryPreview').append(el);}else $('binaryPreview').textContent='Binary asset · Included when compiling and exporting the project.';
 }else{let draft;try{draft=JSON.parse(sessionStorage.getItem(draftKey()));}catch{}if(draft&&draft.content!==f.content){S.text=draft.content;S.dirty=true;markSaved('Recovered browser draft','dirty');if(draft.revision!==f.revision){S.conflict=true;await showConflict();}else{toast('Recovered your unsaved draft.');saveTimer=setTimeout(()=>save().catch(fail),1000);}}}
 revealFile(path);editorMode(S.mode);renderFiles();updateStats();
}
async function openProject(pid,{historyMode='push'}={}){if(S.project&&!await save())return;const navigation=++navigationId;clearTimeout(autoTimer);const project=await api('/api/projects/'+pid);if(navigation!==navigationId)return;S.project=project;S.file=null;S.dirty=false;S.pdfKey=null;$('projectTitle').textContent=S.project.name;document.title=S.project.name+' · IDSL Lab';$('roleLabel').textContent=S.project.role;for(const id of ['compileButton','firstCompileButton','newFileButton','uploadButton','mainFile','saveButton'])$(id).disabled=!editable();document.querySelectorAll('[data-insert]').forEach(b=>b.disabled=!editable());$('autoCompile').disabled=!editable();$('shareButton').disabled=false;$('backupButton').disabled=S.project.role!=='owner';renderFiles();await loadFile(S.project.files.some(f=>f.path===S.project.main)?S.project.main:S.project.files[0].path,true);if(S.project?.id!==pid||navigation!==navigationId)return;Home.visible=false;$('projectHome').hidden=true;$('workspace').hidden=false;$('auth').hidden=true;updateBuild(true);$('autoCompile').checked=localStorage.getItem('labtex-auto:'+pid)==='true'||(localStorage.getItem('labtex-auto:'+pid)===null&&S.project.main.endsWith('.typ'));$('workspaceLanguage').textContent=S.project.main.endsWith('.typ')?'TYPST WORKSPACE':'LATEX WORKSPACE';closeModal();if($('autoCompile').checked&&!S.project.build)scheduleCompile();if(!S.invite)setProjectRoute('#project='+pid,historyMode);}
// A fresh browsing context keeps PDF loads out of page Back/Forward history.
// Unloading it on the home page also releases the native PDF viewer.
function replacePdfFrame(src=null){
 const previous=$('pdfFrame');
 if(src&&previous.getAttribute('src')===src)return;
 const frame=previous.cloneNode(false);frame.removeAttribute('src');frame.hidden=true;
 if(src)frame.src=src;
 previous.replaceWith(frame);
}
function updateBuild(force=false){if(!S.project)return;const b=S.project.build;const stale=S.dirty||b&&b.revision!==S.project.revision;$('downloadButton').disabled=!b?.success;$('openPdfButton').disabled=!b?.success;if(S.building)return;
 $('buildStatus').textContent=b?(b.success?(stale?'Changes since last build':`Compiled in ${b.seconds}s`):'Build failed'):'Ready to compile';$('buildStatus').className='build-status '+(b&&!b.success?'failed':stale?'stale':'');$('logBadge').textContent=b&&!b.success?'●':'';
 if(b?.success){const key=S.project.id+':'+b.created;if(force||S.pdfKey!==key){S.pdfKey=key;replacePdfFrame(apiPath('pdf')+'?v='+b.created+'#toolbar=0&view=FitH');}$('pdfEmpty').hidden=true;$('pdfFrame').hidden=false;}else{$('pdfEmpty').hidden=false;$('pdfFrame').hidden=true;}
}
async function compile(){if(!S.project||S.building||!editable())return;const buildPid=S.project.id;if(!await save()||S.project?.id!==buildPid)return;clearTimeout(autoTimer);S.building=true;$('compileButton').disabled=true;$('firstCompileButton').disabled=true;$('compileButton').querySelector('span').textContent='Compiling…';$('buildStatus').textContent='Building PDF…';$('buildStatus').className='build-status';
 try{const result=await api('/api/projects/'+buildPid+'/compile','POST',{});if(S.project?.id!==buildPid){toast(result.success?'Previous project compiled successfully.':'Previous project build failed. Open its build log for details.');return;}$('buildLog').textContent=result.log;renderDiagnostics(result.log);const project=await api('/api/projects/'+buildPid);if(S.project?.id!==buildPid)return;S.project=project;updateBuild(true);if(!result.success){$('logPanel').hidden=false;toast('Compilation failed. The build log has the details.');}else toast(`PDF compiled in ${result.seconds}s.`);}catch(e){$('buildLog').textContent=e.message;$('logPanel').hidden=false;throw e;}finally{S.building=false;$('compileButton').disabled=!editable();$('firstCompileButton').disabled=!editable();$('compileButton').querySelector('span').textContent='Compile';updateBuild();if(compileAgain){compileAgain=false;scheduleCompile();}}}
async function projects({historyMode='push',folder=Home.folder}={}){
 if(S.project&&!await save())return;
 ++navigationId;clearTimeout(autoTimer);
 S.project=null;S.file=null;S.dirty=false;S.pdfKey=null;replacePdfFrame();
 $('workspace').hidden=true;$('auth').hidden=true;$('projectHome').hidden=false;
 Home.visible=true;Home.folder=folder;Home.filter='all';$('projectSearch').value='';closeModal();document.title='Projects · IDSL Lab';
 setProjectRoute(projectFolderRoute(folder),historyMode);
 $('projectCount').textContent='Loading projects…';
 const sample=await api('/api/sample-project','POST',{});Home.sampleId=sample.id;
 await refreshProjects();
}
function setProjectRoute(hash,mode='push'){
 if(mode==='none'||location.hash===hash)return;
 history[mode==='replace'?'replaceState':'pushState'](null,'',hash);
}
async function refreshProjects(){
 const [response,folders,templates]=await Promise.all([api('/api/projects'),api('/api/project-folders'),api('/api/templates')]);Home.projects=response.projects;Home.folders=folders.folders;Home.templates=templates.templates;
 if(Home.folder&&!Home.folders.some(folder=>folder.id===Home.folder)){Home.folder=null;if(Home.visible)setProjectRoute('#projects','replace');}
 renderProjects();renderStarterProjects();
}
function renderStarterProjects(){
 const list=$('starterProjects');list.replaceChildren();
 for(const template of Home.templates){
  const card=document.createElement('article');card.className='starter-card '+template.id;
  card.innerHTML=`<span class="starter-icon" aria-hidden="true">${template.format==='typst'?'W':'N'}</span><div><h3>${esc(template.name)}</h3><p>${esc(template.description)}</p><span class="starter-format">${template.format==='typst'?'Typst · Presentation':'LaTeX · Paper'}</span></div><button class="outline" data-starter="${esc(template.id)}">Use template <span aria-hidden="true">→</span></button>`;
  card.querySelector('button').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{const result=await api('/api/projects','POST',{templateId:template.id,folder:Home.folder});await openProject(result.id);}catch(error){fail(error);}finally{button.disabled=false;}});list.append(card);
 }
}
const projectFolderRoute=id=>'#projects'+(id?'&folder='+encodeURIComponent(id):'');
function projectFolderChain(id){const chain=[],seen=new Set();while(id&&!seen.has(id)){seen.add(id);const folder=Home.folders.find(folder=>folder.id===id);if(!folder)break;chain.unshift(folder);id=folder.parent;}return chain;}
const projectFolderPath=id=>projectFolderChain(id).map(folder=>folder.name).join(' / ');
const folderContains=(id,parent)=>parent===null||projectFolderChain(id).some(folder=>folder.id===parent);
function showProjectFolder(id,historyMode='push'){
 Home.folder=id;Home.filter='all';$('projectSearch').value='';setProjectRoute(projectFolderRoute(id),historyMode);renderProjects();
}
function bindProjectDrop(target,folder){
 const type='application/x-labtex-project';
 target.addEventListener('dragover',event=>{if(!event.dataTransfer.types.includes(type))return;event.preventDefault();event.dataTransfer.dropEffect='move';target.classList.add('folder-drop-target');});
 target.addEventListener('dragleave',event=>{if(!target.contains(event.relatedTarget))target.classList.remove('folder-drop-target');});
 target.addEventListener('drop',event=>{if(!event.dataTransfer.types.includes(type))return;event.preventDefault();event.stopPropagation();target.classList.remove('folder-drop-target');const project=Home.projects.find(project=>project.id===event.dataTransfer.getData(type));if(project)moveProjectToFolder(project,folder).catch(fail);});
}
function projectFolderLink(link,id){
 link.href=projectFolderRoute(id);link.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();showProjectFolder(id);});bindProjectDrop(link,id);
}
function renderProjectFolders(){
 const nav=$('projectFolderNav');nav.replaceChildren();
 for(const folder of [...Home.folders].sort((a,b)=>projectFolderPath(a.id).localeCompare(projectFolderPath(b.id)))){
  const link=document.createElement('a');link.className='home-folder-link';link.dataset.folder=folder.id;link.title=projectFolderPath(folder.id);link.style.setProperty('--folder-depth',projectFolderChain(folder.id).length-1);
  const icon=document.createElement('span'),name=document.createElement('span');icon.textContent='▱';icon.setAttribute('aria-hidden','true');name.textContent=folder.name;link.append(icon,name);
  if(Home.folder===folder.id){link.classList.add('active');link.setAttribute('aria-current','page');}projectFolderLink(link,folder.id);nav.append(link);
 }
 $('noProjectFolders').hidden=Home.folders.length>0;$('folderLocation').hidden=!Home.folder;
 const breadcrumbs=$('folderBreadcrumbs');breadcrumbs.replaceChildren();
 for(const folder of [{id:null,name:'All projects'},...projectFolderChain(Home.folder)]){
  if(breadcrumbs.childNodes.length){const separator=document.createElement('span');separator.textContent='›';separator.setAttribute('aria-hidden','true');breadcrumbs.append(separator);}
  const link=document.createElement('a');link.textContent=folder.name;if(folder.id===Home.folder)link.setAttribute('aria-current','page');projectFolderLink(link,folder.id);breadcrumbs.append(link);
 }
}
function projectFolderOptions(exclude=null){
 return '<option value="">All projects (root)</option>'+[...Home.folders].filter(folder=>!exclude||!folderContains(folder.id,exclude)).sort((a,b)=>projectFolderPath(a.id).localeCompare(projectFolderPath(b.id))).map(folder=>`<option value="${esc(folder.id)}">${esc(projectFolderPath(folder.id))}</option>`).join('');
}
async function moveProjectToFolder(project,folder){
 if((project.folder||null)===folder){closeModal();return;}
 await api('/api/projects/'+project.id+'/folder','PUT',{folder});await refreshProjects();closeModal();toast('Project moved to '+(projectFolderPath(folder)||'All projects')+'.');
}
function moveProjectDialog(project){
 modal('Move project',`<p>${esc(project.name)}</p><form id="moveProjectForm"><label>Destination folder<select id="projectFolderTarget">${projectFolderOptions()}</select></label><p class="hint">This changes only your project list. Sharing permissions stay the same.</p><div class="actions"><button class="primary">Move project</button></div></form>`);
 $('projectFolderTarget').value=project.folder||'';$('moveProjectForm').addEventListener('submit',event=>{event.preventDefault();moveProjectToFolder(project,$('projectFolderTarget').value||null).catch(fail);});
}
function projectFolderDialog(folder=null){
 const hasContents=folder&&(Home.projects.some(project=>project.folder===folder.id)||Home.folders.some(child=>child.parent===folder.id));
 modal(folder?'Folder settings':'New project folder',`<form id="projectFolderForm"><label>Folder name<input id="projectFolderName" required maxlength="80" autofocus></label><label>Parent folder<select id="projectFolderParent">${projectFolderOptions(folder?.id)}</select></label><div class="actions">${folder?`<button id="deleteProjectFolder" type="button" class="outline danger" ${hasContents?'disabled title="Move the contents out before deleting this folder"':''}>Delete empty folder</button>`:''}<button class="primary">${folder?'Save folder':'Create folder'}</button></div></form>`);
 $('projectFolderName').value=folder?.name||'';$('projectFolderParent').value=(folder?folder.parent:Home.folder)||'';
 $('projectFolderForm').addEventListener('submit',async event=>{event.preventDefault();try{const data={name:$('projectFolderName').value,parent:$('projectFolderParent').value||null};const result=await api('/api/project-folders'+(folder?'/'+folder.id:''),folder?'PUT':'POST',data);await refreshProjects();closeModal();showProjectFolder(folder?.id||result.id);toast(folder?'Folder updated.':'Folder created.');}catch(error){fail(error);}});
 if(folder)action('deleteProjectFolder',async()=>{await api('/api/project-folders/'+folder.id,'DELETE',{});Home.folder=folder.parent;await refreshProjects();closeModal();showProjectFolder(Home.folder,'replace');toast('Empty folder deleted.');});
}
function renderProjects(){
 const term=$('projectSearch').value.trim().toLocaleLowerCase();
 const names={all:'All projects',owned:'My projects',shared:'Shared with me',typst:'Typst projects',latex:'LaTeX projects'};
 const matches=Home.projects.filter(p=>{
  const typst=p.main.endsWith('.typ');
  const filter=Home.filter==='all'||Home.filter==='owned'&&p.role==='owner'||Home.filter==='shared'&&p.role!=='owner'||Home.filter==='typst'&&typst||Home.filter==='latex'&&!typst;
  const scope=Home.filter!=='all'||term?folderContains(p.folder||null,Home.folder):(p.folder||null)===Home.folder;
  return filter&&scope&&[p.name,p.main,typst?'typst':'latex',projectFolderPath(p.folder)].join(' ').toLocaleLowerCase().includes(term);
 }).sort((a,b)=>Home.sort==='name'?a.name.localeCompare(b.name):b.updated-a.updated||a.name.localeCompare(b.name));
 const folders=Home.filter==='all'?Home.folders.filter(folder=>term?folder.id!==Home.folder&&folderContains(folder.id,Home.folder)&&projectFolderPath(folder.id).toLocaleLowerCase().includes(term):folder.parent===Home.folder).sort((a,b)=>a.name.localeCompare(b.name)):[];
 $('homeHeading').textContent=Home.folder?Home.folders.find(folder=>folder.id===Home.folder)?.name:names[Home.filter];$('allProjectsCount').textContent=Home.projects.length;
 $('projectCount').textContent=(folders.length?`${folders.length} folder${folders.length===1?'':'s'} · `:'')+`${matches.length} project${matches.length===1?'':'s'}`+(term?' matching your search':'');
 $('projectSearch').placeholder=Home.folder?'Search this folder…':'Search projects…';renderProjectFolders();
 $('projectList').className='project-browser '+(Home.view==='list'?'list-view':'grid-view');
 $('projectGridView').classList.toggle('active',Home.view!=='list');$('projectGridView').setAttribute('aria-pressed',String(Home.view!=='list'));
 $('projectListView').classList.toggle('active',Home.view==='list');$('projectListView').setAttribute('aria-pressed',String(Home.view==='list'));
 document.querySelectorAll('[data-project-filter]').forEach(button=>{const active=!Home.folder&&button.dataset.projectFilter===Home.filter;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
 const list=$('projectList');list.replaceChildren();
 for(const folder of folders){
  const link=document.createElement('a');link.className='project-directory';link.dataset.folder=folder.id;const count=Home.projects.filter(project=>folderContains(project.folder,folder.id)).length;
  link.innerHTML=`<div class="directory-cover" aria-hidden="true"><svg viewBox="0 0 64 52" fill="none"><path d="M5 12V7a3 3 0 0 1 3-3h17l7 8h24a3 3 0 0 1 3 3v29a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V12Z" fill="currentColor" opacity=".18"/><path d="M5 18v-11a3 3 0 0 1 3-3h17l7 8h24a3 3 0 0 1 3 3v29a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V18h54" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg></div><div class="directory-details"><h2>${esc(folder.name)}</h2><p>${count} project${count===1?'':'s'} <span aria-hidden="true">→</span></p></div>`;link.title=projectFolderPath(folder.id);projectFolderLink(link,folder.id);list.append(link);
 }
 for(const project of matches){
  const typst=project.main.endsWith('.typ'),sample=project.id===Home.sampleId;
  const link=document.createElement('a');link.className='project-entry';link.href='#project='+project.id;link.dataset.project=project.id;
  const date=new Date(project.updated*1000);
  const updated=date.toLocaleDateString(undefined,{month:'short',day:'numeric',...(date.getFullYear()!==new Date().getFullYear()?{year:'numeric'}:{})});
  const role=project.role==='owner'?'Owned by you':project.role==='editor'?'Shared · Can edit':'Shared · View only';
  link.innerHTML=`<div class="project-cover ${typst?'typst':'latex'}" aria-hidden="true"><span class="project-format">${typst?'Typst':'LaTeX'}</span>${sample?'<span class="project-sample-badge">SAMPLE</span>':''}<div class="project-page"><span class="project-page-title">${typst?'Aa':'TᴇX'}</span><span class="project-page-line"></span><span class="project-page-line short"></span><span class="project-page-equation">x = √α · x₀</span><span class="project-page-line"></span><span class="project-page-line short"></span></div></div><div class="project-details"><h2 title="${esc(project.name)}">${esc(project.name)}</h2><div class="project-meta"><span>${esc(project.main)}</span><time datetime="${date.toISOString()}" title="${esc(date.toLocaleString())}">${esc(updated)}</time></div><div class="project-owner"><span><span class="owner-dot" aria-hidden="true">${project.role==='owner'?'Y':'S'}</span>${role}</span><span class="project-open" aria-hidden="true">↗</span></div></div>`;
  if(project.folder&&(term||Home.filter!=='all')){const location=document.createElement('p');location.className='project-location';location.textContent=projectFolderPath(project.folder);link.querySelector('.project-details').append(location);}
  link.draggable=true;link.addEventListener('dragstart',event=>{event.dataTransfer.setData('application/x-labtex-project',project.id);event.dataTransfer.effectAllowed='move';});
  link.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();openProject(project.id).catch(fail);});
  const item=document.createElement('div');item.className='project-item';item.append(link);const move=document.createElement('button');move.className='project-move';move.textContent='↪';move.title='Move to folder';move.setAttribute('aria-label','Move '+project.name+' to folder');move.dataset.moveProject=project.id;move.addEventListener('click',()=>moveProjectDialog(project));item.append(move);list.append(item);
 }
 $('projectsEmpty').hidden=matches.length+folders.length>0;
 $('projectsEmpty').querySelector('h2').textContent=term?'No matching projects.':Home.filter==='shared'?'Nothing shared with you yet.':Home.folder?'This folder is empty.':'No projects here yet.';
 $('projectsEmptyText').textContent=term?'Try another name, or choose a different filter.':Home.filter==='shared'?'Projects your coauthors share with you will appear here.':Home.folder?'Create a project here, or move one into this folder from All projects.':'Create a project or import an existing ZIP to get started.';
}
function newProject(){
 modal('A new beginning',`<form id="newProjectForm"><label>Project name<input name="name" placeholder="My research paper" required maxlength="120" autofocus></label><label>Document format<select name="format"><option value="typst">Typst · fast preview & readable markup</option><option value="latex">LaTeX · Overleaf compatible</option></select></label><label>Start with<select name="template"></select></label><div class="actions"><button class="primary">Create project</button></div></form>`);
 const form=$('newProjectForm'),select=form.elements.template;
 function options(){select.innerHTML='<option value="true">Research starter · equations & bibliography</option><option value="false">Blank article</option>'+Home.templates.filter(template=>template.format===form.elements.format.value).map(template=>`<option value="${esc(template.id)}">${esc(template.name)}</option>`).join('');}
 options();form.elements.format.addEventListener('change',options);
 form.addEventListener('submit',async event=>{event.preventDefault();const data=new FormData(form),template=data.get('template');try{const r=await api('/api/projects','POST',{name:data.get('name'),format:data.get('format'),...(template==='true'||template==='false'?{template:template==='true'}:{templateId:template}),folder:Home.folder});await openProject(r.id);}catch(error){fail(error);}});
}
async function share(){const r=await api(apiPath('members'));const owner=S.project.role==='owner';modal('A paper is better together',`<p>Everyone invited can access this project on your lab server. Editor invitations allow changes; viewer invitations are read-only.</p><div>${r.members.map(m=>`<div class="member-row"><div><strong>${esc(m.name)}</strong><small>${esc(m.email)}</small></div><span class="badge">${esc(m.role)}</span>${owner&&m.role!=='owner'?`<button class="icon danger" data-remove="${m.id}" title="Remove member">×</button>`:''}</div>`).join('')}</div>${owner?'<label style="margin-top:22px">Invite a coauthor<select id="inviteRole"><option value="editor">Can edit and compile</option><option value="viewer">Can view and download</option></select></label><button id="createInvite" class="primary full">Create invitation link</button><div id="inviteResult"></div><p class="hint">Each link is single-use and expires after 7 days. Share it directly with the intended person.</p>':'<p>Only the project owner can invite or remove members.</p>'}`);
 if(owner){action('createInvite',async()=>{const invite=await api(apiPath('invite'),'POST',{role:$('inviteRole').value});$('inviteResult').innerHTML='<label style="margin-top:18px">Invitation link<input id="inviteUrl" readonly></label><button id="copyInvite" class="outline full">Copy link</button>';$('inviteUrl').value=invite.url;action('copyInvite',async()=>{try{await navigator.clipboard.writeText(invite.url);toast('Invitation link copied.');}catch{$('inviteUrl').select();toast('Select and copy the invitation link.');}});});document.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('Remove this member from the project?'))return;try{await api(apiPath('members'),'DELETE',{userId:b.dataset.remove});await share();}catch(e){fail(e);}}));}}
async function historyDialog(){if(!S.file||S.file.content===null)return;const r=await api(apiPath('history')+'?path='+encodeURIComponent(S.file.path));modal('File history',`<p>${esc(S.file.path)} · Up to 30 previous saved revisions. Restoring creates a new saved revision.</p><div>${r.versions.map(v=>`<div class="history-row"><div>Revision ${v.revision}<small>${new Date(v.created*1000).toLocaleString()} · saved over by ${esc(v.author)}</small></div><button class="outline" data-version="${v.id}">Inspect</button></div>`).join('')||'<p class="empty-state">Earlier versions appear here after you save changes.</p>'}</div>`);document.querySelectorAll('[data-version]').forEach(b=>b.addEventListener('click',async()=>{try{const v=await api(apiPath('history')+'?path='+encodeURIComponent(S.file.path)+'&id='+b.dataset.version);modal('Revision '+v.revision,`<textarea id="oldVersion" class="version-preview" readonly></textarea><div class="actions"><button id="backHistory" class="outline">Back</button>${editable()?'<button id="restoreVersion" class="primary">Restore this version</button>':''}</div>`);$('oldVersion').value=v.content;action('backHistory',historyDialog);if(editable())action('restoreVersion',async()=>{if(!await save())return;setText(v.content);editorMode(S.mode);await save();closeModal();toast('Version restored.');});}catch(e){fail(e);}}));}
async function addFile(){if(!await save())return;modal('Add a project file','<form id="addFileForm"><label>Filename<input id="newFileName" placeholder="sections/method.tex" required></label><p>Use slashes to create folders. For example: sections/method.tex</p><div class="actions"><button class="primary">Create file</button></div></form>');$('addFileForm').addEventListener('submit',async e=>{e.preventDefault();try{const path=$('newFileName').value.trim();await api(apiPath('file'),'PUT',{path,content:'',revision:0});S.project=await api(apiPath());closeModal();await loadFile(path);}catch(e){fail(e);}});}
async function fileMenu(){if(!S.file)return;modal('File actions',`<p>${esc(S.file.path)}</p><div class="row"><button id="downloadFile" class="outline">Download file</button>${editable()?'<button id="renameFile" class="outline">Rename</button><button id="deleteFile" class="outline danger">Delete</button>':''}</div><p>Renaming a file does not rewrite document references. Update any input or image commands that use its old path.</p>`);action('downloadFile',()=>{const bytes=S.file.content===null?Uint8Array.from(atob(S.file.base64),c=>c.charCodeAt(0)):S.text;download(bytes,S.file.path.split('/').pop(),'application/octet-stream');});if(editable()){action('renameFile',async()=>{if(!await save())return;const name=prompt('New path',S.file.path);if(!name||name===S.file.path)return;await api(apiPath('rename'),'POST',{path:S.file.path,newPath:name,revision:S.file.revision});S.project=await api(apiPath());closeModal();await loadFile(name,true);});action('deleteFile',async()=>{if(!await save())return;if(!confirm('Delete '+S.file.path+'? Export your source first if you need a backup.'))return;await api(apiPath('file'),'DELETE',{path:S.file.path,revision:S.file.revision});S.project=await api(apiPath());S.dirty=false;closeModal();await loadFile(S.project.main,true);});}}
function insert(kind){if(!editable()||!isDocument()||S.file?.content===null)return;if(S.mode==='visual'&&['bold','italic'].includes(kind)){const selection=getSelection(),node=selection?.anchorNode;const element=node?.nodeType===3?node.parentElement:node;const block=element?.closest?.('[contenteditable=true]');if(block&&$('visualEditor').contains(block)){document.execCommand(kind);block.dispatchEvent(new Event('input',{bubbles:true}));return;}}const area=$('code'),start=S.mode==='source'?area.selectionStart:S.text.length,end=S.mode==='source'?area.selectionEnd:S.text.length;editorMode('source');const selected=area.value.slice(start,end);const snippets={bold:'\\textbf{'+(selected||'bold text')+'}',italic:'\\emph{'+(selected||'italic text')+'}',heading:'\n\\section{'+(selected||'New section')+'}\n',equation:'\n\\begin{equation}\n  '+(selected||'E = mc^2')+'\n\\end{equation}\n',list:'\n\\begin{itemize}\n  \\item '+(selected||'First point')+'\n\\end{itemize}\n',citation:'\\cite{'+(selected||'citation-key')+'}',figure:'\n\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{figures/example.png}\n  \\caption{'+(selected||'Your caption')+'}\n  \\label{fig:example}\n\\end{figure}\n'};const typst={bold:'*'+(selected||'bold text')+'*',italic:'_'+(selected||'italic text')+'_',heading:'\n= '+(selected||'New section')+'\n',equation:'\n$ '+(selected||'E = m c^2')+' $\n',list:'\n- '+(selected||'First point')+'\n',citation:'@'+(selected||'citation-key'),figure:'\n#figure(\n  image("figures/example.png", width: 80%),\n  caption: ['+(selected||'Your caption')+'],\n) <fig-example>\n'};area.setRangeText((isTypst()?typst:snippets)[kind],start,end,'end');setText(area.value);area.focus();}
async function approvedEmailsDialog(){
 const settings=await api('/api/approved-emails');
 modal('Approved IDSL Lab emails',`<p>Only these exact email addresses can register and sign in. Invitations authorize account creation; mailbox ownership is not checked.</p><form id="approvedEmailsForm"><label>One email address per line<textarea id="approvedEmailsList" class="version-preview" spellcheck="false"></textarea></label><p class="hint">Removing an address signs that member out and disables their access. Your administrator email stays approved.</p><div class="actions"><button class="primary">Save approved emails</button></div></form>`);
 $('approvedEmailsList').value=settings.emails.join('\n');
 $('approvedEmailsForm').addEventListener('submit',async event=>{event.preventDefault();try{await api('/api/approved-emails','PUT',{emails:$('approvedEmailsList').value.split(/[\s,;]+/).filter(Boolean)});closeModal();toast('Approved emails updated.');}catch(e){fail(e);}});
}
async function labSignupDialog(links=[]){
 const result=await api('/api/lab-invite');
 modal('Invite IDSL Lab members',`<p>Each link creates one account with its own private projects. Share links only inside the lab. Links expire in seven days and work once.</p><form id="createLabInvites"><label>Number of invitation links<input id="labInviteCount" type="number" min="1" max="20" value="3" required></label><button class="primary">Generate invitation links</button></form>${links.length?'<hr><p>Copy these links now. They are shown only once.</p>'+links.map((link,i)=>`<label>Invitation ${i+1}<input class="new-lab-invite" readonly value="${esc(link.url)}"></label>`).join('')+'<button id="copyLabInvites" class="outline full">Copy all new links</button>':''}<hr><p>Recent invitations</p>${result.invitations.map(invite=>`<div class="member-row"><div><strong>${invite.used_by?'Used':invite.expires*1000<Date.now()?'Expired':'Available'}</strong><small>Created ${new Date(invite.created*1000).toLocaleString()} · expires ${new Date(invite.expires*1000).toLocaleDateString()}</small></div>${!invite.used_by?`<button class="outline danger" data-revoke-invite="${invite.id}">Revoke</button>`:''}</div>`).join('')||'<p>No invitations yet.</p>'}<p class="hint">New users must enter an address on the approved list. An invitation is a secret: anyone holding an unused link can attempt signup. Revoking a link does not disable an existing account.</p>`);
 $('createLabInvites').addEventListener('submit',async event=>{event.preventDefault();try{const created=await api('/api/lab-invite','POST',{count:Number($('labInviteCount').value)});await labSignupDialog(created.links);}catch(e){fail(e);}});
 if(links.length)action('copyLabInvites',async()=>{try{await navigator.clipboard.writeText(links.map((link,i)=>`Invitation ${i+1}: ${link.url}`).join('\n'));toast('Invitation links copied.');}catch{toast('Select and copy each invitation link.');}});
 document.querySelectorAll('[data-revoke-invite]').forEach(button=>button.addEventListener('click',async()=>{try{await api('/api/lab-invite','DELETE',{id:button.dataset.revokeInvite});await labSignupDialog(links.filter(link=>link.id!==button.dataset.revokeInvite));}catch(e){fail(e);}}));
}
async function authenticate(){
 const session=await api('/api/session');S.user=session.user;S.demo=session.demo;S.canInviteLab=session.canInviteLab;
 if(!S.user){$('auth').hidden=false;$('workspace').hidden=true;$('projectHome').hidden=true;Home.visible=false;S.authMode=session.needsSetup?'setup':S.signup?'register':'login';renderAuth();return;}
 $('auth').hidden=true;
 $('accountButton').textContent=S.user.name.split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase();$('homeAccountButton').textContent=$('accountButton').textContent;$('homeUserName').textContent=S.user.name;
 $('previewLabel').textContent=S.demo?'LOCAL PREVIEW · Use normal mode for lab accounts':'IDSL Lab · LaTeX + Typst';
 let pid=new URLSearchParams(location.hash.slice(1)).get('project');
 if(S.invite&&!S.demo){const joined=await api('/api/join','POST',{token:S.invite});pid=joined.id;S.invite=null;history.replaceState(null,'','#project='+pid);toast('You joined the project.');}
 if(S.signup){S.signup=null;history.replaceState(null,'',location.pathname);}
 if(pid){const r=await api('/api/projects');if(r.projects.some(p=>p.id===pid)){await openProject(pid,{historyMode:'replace'});return;}}await projects({historyMode:'replace',folder:new URLSearchParams(location.hash.slice(1)).get('folder')});
}
function renderAuth(){
 const mode=S.authMode;
 $('authTitle').textContent=mode==='setup'?'Set up IDSL Lab':mode==='register'?(S.signup?'Create your IDSL Lab account':'Join your coauthors'):'Sign in to IDSL Lab';
 $('authNote').textContent=mode==='setup'?'Create the first account using the token from your server console.':mode==='register'?(S.signup?'Use your approved lab address and choose a password. This invitation creates your own private writing workspace.':'Create an account to accept your project invitation. You can also create your own private projects.'):S.invite?'Sign in to accept this project invitation. New members need an account invitation from the lab administrator.':'Your papers and coauthors are waiting.';
 $('nameLabel').hidden=mode==='login';$('tokenLabel').hidden=mode!=='setup';document.querySelector('input[name=password]').autocomplete=mode==='login'?'current-password':'new-password';
 $('nameLabel').querySelector('input').required=mode!=='login';$('tokenLabel').querySelector('input').required=mode==='setup';
 $('authSubmit').textContent=mode==='login'?'Sign in':mode==='setup'?'Create workspace':S.signup?'Create my account':'Create account & join';
 $('authToggle').hidden=!S.signup;$('authToggle').textContent=mode==='login'?'Need an account? Sign up':'Already have an account? Sign in';$('authError').textContent='';
}
$('authForm').addEventListener('submit',async e=>{
 e.preventDefault();$('authSubmit').disabled=true;
 try{
  const body=Object.fromEntries(new FormData(e.target));
  if(S.authMode==='register'){body.token=S.signup;}
  const endpoint=S.authMode==='register'&&S.signup?'register-lab':S.authMode;
  await api('/api/'+endpoint,'POST',body);
  if(S.authMode==='register'){S.invite=null;S.signup=null;history.replaceState(null,'',location.pathname);}
  await authenticate();
 }catch(e){$('authError').textContent=e.message;}finally{$('authSubmit').disabled=false;}
});
action('authToggle',()=>{S.authMode=S.authMode==='login'?'register':'login';renderAuth();});
window.addEventListener('hashchange',async()=>{
 const params=new URLSearchParams(location.hash.slice(1));
 try{
  if(S.dirty&&!await save()){if(S.project)setProjectRoute('#project='+S.project.id,'replace');return;}
  if(params.has('invite')||params.has('signup')){S.invite=params.get('invite');S.signup=params.get('signup');await authenticate();}
  else if(S.user&&params.has('project')&&params.get('project')!==S.project?.id)await openProject(params.get('project'),{historyMode:'none'});
  else if(S.user&&!params.has('project'))await projects({historyMode:'none',folder:params.get('folder')});
 }catch(e){fail(e);}
});
action('closeModal',closeModal);action('projectsButton',projects);action('projectsNavButton',projects);action('sourceTab',()=>editorMode('source'));action('visualTab',()=>editorMode('visual'));action('saveButton',save);action('compileButton',compile);action('firstCompileButton',compile);action('shareButton',share);action('backupButton',backupDialog);action('historyButton',historyDialog);action('newFileButton',addFile);action('fileMenuButton',fileMenu);action('uploadButton',()=>$('uploadFiles').click());
action('downloadButton',()=>{if(S.project?.build?.success)location.href=apiPath('pdf')+'?download=1';});action('openPdfButton',()=>{if(S.project?.build?.success)window.open(apiPath('pdf'),'_blank','noopener');});action('exportSourceButton',async()=>{if(await save())location.href=apiPath('source.zip');});action('logButton',async()=>{$('logPanel').hidden=!$('logPanel').hidden;if(!$('logPanel').hidden&&S.project?.build){const log=await api(apiPath('log'));$('buildLog').textContent=log.log;renderDiagnostics(log.log);}});action('closeLog',()=>$('logPanel').hidden=true);
action('projectTitle',async()=>{if(!editable())return;const name=prompt('Project name',S.project.name);if(!name||name===S.project.name)return;await api(apiPath(),'PUT',{name});S.project=await api(apiPath());$('projectTitle').textContent=S.project.name;document.title=S.project.name+' · IDSL Lab';});
function accountDialog(){
 modal('Your IDSL Lab account',`<p><strong>${esc(S.user.name)}</strong><br>${esc(S.user.email)}</p><button id="accountProjects" class="outline">My projects</button> <button id="accountAppearance" class="outline">Appearance</button>${S.canInviteLab?'<hr><button id="inviteLabMembers" class="primary">Invite lab members</button><button id="approvedEmailsButton" class="outline">Approved emails</button>':''}${S.demo?'<p>This is a local preview account. Start without --demo to create accounts and invite lab members.</p>':'<hr><button id="signOut" class="outline">Sign out</button>'}${S.project?.role==='owner'?'<hr><p class="hint">Delete this entire project and its saved history.</p><button id="deleteProject" class="outline danger">Delete project</button>':''}`);
 action('accountProjects',projects);action('accountAppearance',appearanceDialog);
 if(S.canInviteLab){action('inviteLabMembers',()=>labSignupDialog());action('approvedEmailsButton',approvedEmailsDialog);}
 if(!S.demo)action('signOut',async()=>{if(!await save())return;await api('/api/logout','POST',{});for(const key of Object.keys(sessionStorage))if(key.startsWith('labtex-draft:'+S.user.id+':'))sessionStorage.removeItem(key);location.href='/';});
 if(S.project?.role==='owner')action('deleteProject',async()=>{if(prompt('Type the project name to permanently delete it:')!==S.project.name)return;await api(apiPath(),'DELETE',{});S.project=null;S.file=null;S.dirty=false;history.replaceState(null,'','/');location.reload();});
}
action('accountButton',accountDialog);action('homeAccountButton',accountDialog);
action('helpButton',()=>modal('A workspace that stays out of the way',`<p><strong>Ctrl / Cmd + S</strong> saves. <strong>Ctrl / Cmd + Enter</strong> compiles. Tab inserts two spaces in source mode.</p><p>Download your Overleaf project as a ZIP and import it from the project picker. Choose its main .tex or .typ document in the sidebar. Upload figures, bibliography files, classes, and styles with the upload button.</p><p>Visual mode supports plain paragraphs, simple bold/italic text, and headings. Equations, code, and advanced formatting stay in source blocks for both LaTeX and Typst. Editing is shared through autosave and periodic refresh, with conflict detection; this version does not merge simultaneous keystrokes.</p><p>Up to 30 saved versions per file are available, within a 40 MB history limit per project. Deleting a file removes its history. Browser drafts survive a refresh in the same tab.</p><p>This server allows 300 seconds per build, 8 MB per file, 40 MB of current files per project, and 25 owned projects per account. Shell escape is disabled.</p>`));
$('fileFilter').addEventListener('input',renderFiles);$('code').addEventListener('input',()=>setText($('code').value));$('code').addEventListener('scroll',syncScroll);$('code').addEventListener('click',updateStats);$('code').addEventListener('keyup',updateStats);$('code').addEventListener('keydown',e=>{if(e.key==='Tab'&&editable()){e.preventDefault();const area=e.target;area.setRangeText('  ',area.selectionStart,area.selectionEnd,'end');setText(area.value);}});document.querySelectorAll('[data-insert]').forEach(b=>{b.addEventListener('pointerdown',event=>{if(S.mode==='visual')event.preventDefault();});b.addEventListener('click',()=>insert(b.dataset.insert));});
$('mainFile').addEventListener('change',async()=>{try{if(!await save())return;await api(apiPath(),'PUT',{main:$('mainFile').value});S.project=await api(apiPath());renderFiles();updateBuild();}catch(e){fail(e);}});
$('autoCompile').addEventListener('change',()=>{localStorage.setItem('labtex-auto:'+S.project.id,String($('autoCompile').checked));clearTimeout(autoTimer);if($('autoCompile').checked)compile().catch(fail);});
$('uploadFiles').addEventListener('change',async e=>{try{if(!await save())return;let last;for(const file of e.target.files){if(file.size>8*1024*1024)throw Error(file.name+' exceeds 8 MB.');const exists=S.project.files.find(x=>x.path===file.name);if(exists&&!confirm('Replace '+file.name+'?'))continue;await api(apiPath('file'),'PUT',{path:file.name,base64:await base64File(file),revision:exists?.revision||0});last=file.name;}S.project=await api(apiPath());renderFiles();if(last)await loadFile(last,true);toast('Files uploaded.');}catch(e){fail(e);}finally{e.target.value='';}});
$('importZip').addEventListener('change',async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>40*1024*1024)throw Error('ZIP exceeds 40 MB.');toast('Importing project…');const r=await api('/api/projects','POST',{name:file.name.replace(/\.zip$/i,''),zip:await base64File(file),folder:Home.folder});await openProject(r.id);toast('Project imported. Check the main document, then compile.');}catch(e){fail(e);}finally{e.target.value='';}});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save().catch(fail);}if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();compile().catch(fail);}});
window.addEventListener('beforeunload',e=>{if(S.dirty||S.saving){keepDraft();e.preventDefault();e.returnValue='';}});
const handle=$('splitHandle');handle.addEventListener('pointerdown',e=>{handle.setPointerCapture(e.pointerId);handle.dataset.drag='1';});handle.addEventListener('pointermove',e=>{if(!handle.dataset.drag)return;const r=$('workbench').getBoundingClientRect();const percent=Math.max(25,Math.min(75,(e.clientX-r.left)/r.width*100));$('workbench').style.gridTemplateColumns=`minmax(200px,${percent}fr) 6px minmax(200px,${100-percent}fr)`;});handle.addEventListener('pointerup',()=>delete handle.dataset.drag);handle.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const p=Math.max(25,Math.min(75,Number(handle.dataset.percent||50)+(e.key==='ArrowRight'?5:-5)));handle.dataset.percent=p;$('workbench').style.gridTemplateColumns=`minmax(200px,${p}fr) 6px minmax(200px,${100-p}fr)`;}});
setInterval(async()=>{if(!S.project||!S.user||pollBusy||S.building||document.hidden)return;pollBusy=true;try{const pid=S.project.id;const p=await api('/api/projects/'+pid);if(S.project?.id!==pid)return;$('connectionStatus').textContent='Connected';if(!S.dirty&&!S.saving&&!S.conflict){const f=p.files.find(f=>f.path===S.file?.path);if(!f){S.project=p;await loadFile(p.main,true);}else if(f.revision!==S.file.revision){S.project=p;await loadFile(f.path,true);toast('File updated by a coauthor.');}}if(S.project?.id!==pid)return;S.project=p;$('projectTitle').textContent=p.name;renderFiles();updateBuild();}catch(e){$('connectionStatus').textContent=e.status===401?'Session expired':'Connection interrupted';if(e.status===401)markSaved('Sign in again to save','error');}finally{pollBusy=false;}},4000);
authenticate().catch(fail);

function renderDiagnostics(log){
 const list=$('diagnostics');list.replaceChildren();
 const seen=new Set();
 for(const match of log.matchAll(/^(.+?\.(?:typ|tex)):(\d+):(\d+):\s*(.*)$/gm)){
  const [,path,line,col,message]=match;if(seen.has(match[0])||!S.project.files.some(f=>f.path===path))continue;seen.add(match[0]);
  const button=document.createElement('button');button.className='diagnostic';button.textContent=`${path}:${line}:${col} — ${message}`;
  button.addEventListener('click',async()=>{try{await loadFile(path);editorMode('source');const rows=S.text.split('\n');const pos=rows.slice(0,Number(line)-1).reduce((sum,row)=>sum+row.length+1,0)+Number(col)-1;$('code').focus();$('code').setSelectionRange(pos,pos);$('code').scrollTop=Math.max(0,(Number(line)-4)*23);updateStats();}catch(e){fail(e);}});list.append(button);
 }
}

function scheduleBackup(pid){
 clearTimeout(backupTimers.get(pid));
 if(!S.backupAuto||!S.githubToken||S.project?.role!=='owner')return;
 backupTimers.set(pid,setTimeout(async()=>{backupTimers.delete(pid);if(!S.backupAuto||!S.githubToken)return;try{await api('/api/projects/'+pid+'/backup','POST',{token:S.githubToken});toast('GitHub backup is up to date.');}catch(e){S.backupAuto=false;for(const timer of backupTimers.values())clearTimeout(timer);backupTimers.clear();toast('Automatic backup paused: '+e.message);}},30000));
}
async function backupDialog(){
 if(!S.project||S.project.role!=='owner')return;
 if(!await save())return;
 const [defaults,project]=await Promise.all([api('/api/backup-settings'),api(apiPath('backup-settings'))]);
 modal('GitHub backups',`<p>Keep your project source and assets in GitHub, with commit history. Local accounts, passwords, and build files stay on this computer. Use a private repository for private documents.</p>
 <form id="backupForm"><div class="backup-options">
 <label>My shared repository<input id="backupSharedRepo" placeholder="your-name/research-documents" value="${esc(defaults.repository)}"></label>
 <label>Shared repository branch<input id="backupSharedBranch" placeholder="Default branch" value="${esc(defaults.branch)}"></label>
 <label>This project's layout<select id="backupMode"><option value="shared">Use my shared repository · one folder per project</option><option value="separate">Use a separate repository for this project</option></select></label>
 <div id="separateBackup"><label>Project repository<input id="backupProjectRepo" placeholder="your-name/this-paper" value="${esc(project.repository)}"></label><label>Project branch<input id="backupProjectBranch" placeholder="Default branch" value="${esc(project.branch)}"></label></div>
 <p id="backupPath" class="hint backup-destination"></p>
 <label>GitHub access token<input id="backupToken" type="password" autocomplete="off" placeholder="Fine-grained token with Contents read/write"></label>
 <p class="hint">Create the repository on GitHub first. Grant your <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">fine-grained token</a> Contents read/write access to it. The token stays in memory until this tab reloads; it is never saved to the database or browser storage.</p>
 <label class="backup-check"><input id="backupAuto" type="checkbox"> Back up 30 seconds after saving while this tab is open</label>
 </div><div class="row"><button type="submit" class="outline">Save settings</button><button type="button" id="backupCurrent" class="primary">Back up this project</button><button type="button" id="backupAll" class="outline">Back up all my projects</button></div></form>
 <div id="backupResult" class="backup-result" role="status">${project.last_url?`Last snapshot: <a href="${esc(project.last_url)}" target="_blank" rel="noopener noreferrer">${esc(project.last_commit.slice(0,8))}</a> · revision ${project.last_revision}`:'No GitHub snapshot recorded for this project yet.'}</div>`);
 $('backupMode').value=project.mode;$('backupToken').value=S.githubToken;$('backupAuto').checked=S.backupAuto;
 function layout(){const shared=$('backupMode').value==='shared';$('separateBackup').hidden=shared;$('backupPath').textContent=shared?'Sources go in projects/'+S.project.id+'/; other projects keep their own folders.':'Sources go at the repository root. Existing unrelated files are preserved.';}
 layout();$('backupMode').addEventListener('change',layout);
 async function saveSettings(){
  await api('/api/backup-settings','PUT',{repository:$('backupSharedRepo').value,branch:$('backupSharedBranch').value});
  await api(apiPath('backup-settings'),'PUT',{mode:$('backupMode').value,repository:$('backupProjectRepo').value,branch:$('backupProjectBranch').value});
  S.githubToken=$('backupToken').value.trim();S.backupAuto=$('backupAuto').checked;
  if(S.backupAuto&&!S.githubToken){S.backupAuto=false;throw Error('Enter a token to enable automatic backups for this tab.');}
  if(!S.backupAuto){for(const timer of backupTimers.values())clearTimeout(timer);backupTimers.clear();}
 }
 $('backupForm').addEventListener('submit',async event=>{event.preventDefault();try{await saveSettings();$('backupResult').textContent='Backup settings saved. Back up now to create a snapshot.';}catch(e){$('backupResult').textContent=e.message;}});
 async function run(all){
  $('backupCurrent').disabled=true;$('backupAll').disabled=true;$('backupResult').classList.remove('error');
  try{
   await saveSettings();if(!S.githubToken)throw Error('Enter your GitHub token first.');
   $('backupResult').textContent=all?'Backing up your owned projects…':'Creating GitHub snapshot…';
   const result=await api(all?'/api/backups':apiPath('backup'),'POST',{token:S.githubToken});
   const results=all?result.results:[result];$('backupResult').replaceChildren();
   for(const item of results){const line=document.createElement('div');if(item.error){line.textContent=(item.name||item.id)+': '+item.error;$('backupResult').classList.add('error');}else{const link=document.createElement('a');link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=(item.name||S.project.name)+': '+(item.changed?'Snapshot saved':'Already up to date')+' → '+item.repository+' ('+item.commit.slice(0,8)+')';line.append(link);}$('backupResult').append(line);}
  }catch(e){$('backupResult').classList.add('error');$('backupResult').textContent=e.message;}finally{$('backupCurrent').disabled=false;$('backupAll').disabled=false;}
 }
 action('backupCurrent',()=>run(false));action('backupAll',()=>run(true));
}

// The project explorer is a page, with browser-history navigation to editors.
action('createProject',newProject);action('emptyNewProject',newProject);action('importProject',()=>$('importZip').click());action('refreshProjects',refreshProjects);
action('createProjectFolder',()=>projectFolderDialog());action('sidebarNewFolder',()=>projectFolderDialog());action('manageProjectFolder',()=>projectFolderDialog(Home.folders.find(folder=>folder.id===Home.folder)));
bindProjectDrop(document.querySelector('[data-project-filter="all"]'),null);
action('openSampleProject',async()=>{const sample=await api('/api/sample-project','POST',{recreate:true});if(!sample.id)throw Error('Your project limit is reached. Export and delete an unused project before adding the sample.');Home.sampleId=sample.id;await openProject(sample.id);});
$('projectSearch').addEventListener('input',renderProjects);
$('projectSort').addEventListener('change',()=>{Home.sort=$('projectSort').value;renderProjects();});
for(const [id,view] of [['projectGridView','grid'],['projectListView','list']])action(id,()=>{Home.view=view;localStorage.setItem('labtex-project-view',view);renderProjects();});
document.querySelectorAll('[data-project-filter]').forEach(button=>button.addEventListener('click',()=>{Home.filter=button.dataset.projectFilter;Home.folder=null;setProjectRoute('#projects');renderProjects();}));
document.addEventListener('keydown',event=>{if(Home.visible&&!$('modal').open&&event.key==='/'&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)){event.preventDefault();$('projectSearch').focus();}});

function updateThemeControls(){
 const theme=window.labtexTheme;
 for(const id of ['themeButton','homeThemeButton','authThemeButton']){
  const next=theme.resolved==='dark'?'light':'dark';
  $(id).title='Switch to '+next+' theme';
  $(id).setAttribute('aria-label',$(id).title);
  $(id).setAttribute('aria-pressed',String(theme.resolved==='dark'));
  $(id).textContent=next==='dark'?'☾':'☼';
 }
 if($('themeResolved'))$('themeResolved').textContent='Currently using the '+theme.resolved+' theme. Your PDF keeps its document colors.';
 document.querySelectorAll('[data-palette-choice]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.paletteChoice===theme.palette)));
 if($('themePreference'))$('themePreference').value=theme.preference;
}
function appearanceDialog(){
 modal('Appearance',`<p class="hint">Choose your workspace colors. The sun/moon button still switches light and dark with one click.</p><div class="palette-choices" role="group" aria-label="Color theme">${window.labtexTheme.palettes.map(palette=>`<button type="button" class="palette-choice" data-palette-choice="${palette.id}" aria-pressed="false"><span class="palette-swatches" aria-hidden="true">${palette.colors.map(color=>`<i style="background:${color}"></i>`).join('')}</span><strong>${esc(palette.name)}</strong><small>${esc(palette.note)}</small></button>`).join('')}</div><label>Light / dark mode<select id="themePreference" aria-label="Light / dark mode"><option value="system">System · follow your device</option><option value="light">Light</option><option value="dark">Dark</option></select></label><p id="themeResolved" class="theme-note"></p><p>The preference is remembered in this browser and applies to your project home, editor, and sign-in screen.</p><div class="actions"><button id="closeAppearance" class="primary">Done</button></div>`);
 $('themePreference').value=window.labtexTheme.preference;
 $('themePreference').addEventListener('change',()=>window.labtexTheme.set($('themePreference').value));
 document.querySelectorAll('[data-palette-choice]').forEach(button=>button.addEventListener('click',()=>window.labtexTheme.setPalette(button.dataset.paletteChoice)));
 action('closeAppearance',closeModal);updateThemeControls();
}
for(const id of ['themeButton','homeThemeButton','authThemeButton'])action(id,()=>window.labtexTheme.set(window.labtexTheme.resolved==='dark'?'light':'dark'));
for(const id of ['paletteButton','homePaletteButton','authPaletteButton'])action(id,appearanceDialog);
window.addEventListener('labtex-themechange',updateThemeControls);updateThemeControls();
