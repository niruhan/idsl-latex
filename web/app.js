import {escapeHTML as esc} from './visual.js';
import {createTypstLive} from './typst-live.js';
import {createEditHistory} from './edit-history.js';
const $=id=>document.getElementById(id);
const S={user:null,project:null,file:null,text:'',saved:'',mode:'source',assetUrl:null,dirty:false,saving:null,conflict:false,building:false,authMode:'login',invite:new URLSearchParams(location.hash.slice(1)).get('invite'),signup:new URLSearchParams(location.hash.slice(1)).get('signup'),canInviteLab:false,demo:false,pdfKey:null,keepPreview:false,githubToken:'',githubSaved:false,backupAuto:false};
const Home={visible:false,projects:[],folders:[],templates:[],folder:null,filter:'all',view:localStorage.getItem('labtex-project-view')==='list'?'list':'grid',sort:'updated'};
const FileTree={projects:new Map(),searchKey:null,searchCollapsed:new Set()};
const EditHistory=createEditHistory();let pendingEdit=null;
let movingFiles=false,saveTimer,maxSaveTimer,autoTimer,toastTimer,pollBusy=false,compileAgain=false,startingBuild=false,navigationId=0;
let navigationQueue=Promise.resolve(),pendingNavigations=0;const backupTimers=new Map();
const Live=createTypstLive({api,state:()=>S,setText,navigate:navigateTypst,toast});
const isTypst=()=>S.file?.path.endsWith('.typ');
const isDocument=()=>/\.(tex|typ)$/.test(S.file?.path||'');
const typstProject=()=>Boolean(S.project?.main.endsWith('.typ'));
function scheduleCompile(){
 clearTimeout(autoTimer);if(typstProject()){if(Live.active)Live.changed();return;}if(!$('autoCompile').checked||!editable())return;
 if(S.building||startingBuild){if(S.dirty)compileAgain=true;return;}
 autoTimer=setTimeout(()=>compile({automatic:true}).catch(fail),typstProject()?150:900);
}
const apiPath=(action='')=>'/api/projects/'+S.project.id+(action?'/'+action:'');
async function api(path,method='GET',body){
 const payload=body?JSON.stringify(body):undefined;
 // Small document saves can finish even if the tab is being unloaded. Larger
 // documents use normal fetch and retain the unsaved-changes leave warning.
 const keepalive=method==='PUT'&&/\/file$/.test(path)&&new Blob([payload]).size<60000;
 const response=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:payload,keepalive});
 const value=await response.json();if(!response.ok){const e=new Error(value.error||'Request failed');e.status=response.status;throw e;}return value;
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
function fail(e){toast(e.message||String(e));}
function action(id,fn){$(id).addEventListener('click',()=>Promise.resolve().then(fn).catch(fail));}
function modal(title,html,wide=false){closeAccountMenu();closeFileContextMenu();closeEditorMenu();$('modal').classList.toggle('template-library-dialog',wide);$('modalTitle').textContent=title;$('modalBody').innerHTML=html;if(!$('modal').open)$('modal').showModal();}
function closeModal(){$('modal').close();}
function draftKey(){return `labtex-draft:${S.user?.id}:${S.project?.id}:${S.file?.path}`;}
function keepDraft(){if(S.file){try{if(S.dirty)sessionStorage.setItem(draftKey(),JSON.stringify({content:S.text,revision:S.file.revision}));else sessionStorage.removeItem(draftKey());}catch{if(S.dirty)toast('Browser draft storage is full. Save or download your draft.');}}}
function markSaved(label,kind=''){$('saveStatus').title=label;$('saveStatus').textContent=label;$('saveStatus').className='save-status '+kind;}
function cancelAutosave(){clearTimeout(saveTimer);clearTimeout(maxSaveTimer);saveTimer=maxSaveTimer=null;}
function scheduleAutosave(delay=500){
 clearTimeout(saveTimer);if(!S.dirty||S.conflict||!editable()){cancelAutosave();return;}
 const flush=()=>save().catch(()=>{}); // save() reports errors and schedules retries.
 saveTimer=setTimeout(flush,delay);if(!maxSaveTimer)maxSaveTimer=setTimeout(flush,5000);
}
function flushAutosave(){if(S.dirty||S.saving){keepDraft();save().catch(()=>{});}}
function restoreCurrentRoute(){setProjectRoute(S.project?'#project='+S.project.id:projectFolderRoute(Home.folder),'replace');}
function savedNavigation(task,{saveFirst=true}={}){
 // Serialize transitions and freeze the old editor until its final save and the
 // next file/project load finish. Typing into a departing document cannot race.
 pendingNavigations++;$('workspace').inert=true;
 const job=navigationQueue.then(async()=>{
  if(saveFirst&&S.project&&!await save()){restoreCurrentRoute();return false;}
  return task();
 }).catch(error=>{restoreCurrentRoute();throw error;}).finally(()=>{
  pendingNavigations--;if(!pendingNavigations)$('workspace').inert=movingFiles;
 });
 navigationQueue=job.catch(()=>{});return job;
}
function editKey(){return `${S.user?.id}:${S.project?.id}:${S.file?.path}`;}
function editSelection(){const area=$('code');return {mode:'source',start:area.selectionStart,end:area.selectionEnd,direction:area.selectionDirection};}
function restoreEditSelection(selection,fallback=0,focus=true){
 if(S.mode!=='source')return;const area=$('code'),saved=selection||{start:fallback,end:fallback};
 if(focus)area.focus();area.setSelectionRange(saved.start,saved.end,saved.direction||'none');
}
function captureEdit(kind=''){pendingEdit={key:editKey(),text:S.text,before:editSelection(),kind};}
function setText(text,fromVisual=false,options={}){
 const pending=pendingEdit?.key===editKey()&&pendingEdit.text===S.text?pendingEdit:null;pendingEdit=null;
 const before=options.before||pending?.before||editSelection();
 if(!fromVisual&&$('code').value!==text){$('code').value=text;if(S.mode==='source')restoreEditSelection(options.after||before,0,false);}
 if(options.history!==false)EditHistory.record(S.text,text,before,options.after||editSelection(),options.kind??pending?.kind??'');
 S.text=text;S.dirty=S.text!==S.saved;markSaved(S.dirty?'Unsaved changes':'All changes saved',S.dirty?'dirty':'');if(!fromVisual)highlight();keepDraft();scheduleAutosave();updateStats();updateBuild();if(typstProject())scheduleCompile();
}
function undoEdit(redo=false){
 if(!editable()||!S.file||S.file.content===null)return;
 const result=EditHistory.step(redo,S.text);pendingEdit=null;if(!result)return;
 setText(result.text,false,{history:false});if(S.mode==='preview')renderAssetPreview();restoreEditSelection(result.selection,result.start);updateStats();
}
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
const imageTypes={svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',bmp:'image/bmp',ico:'image/x-icon'};
const imageType=()=>imageTypes[S.file?.path.split('.').pop().toLowerCase()];
function clearAssetPreview(){if(S.assetUrl){URL.revokeObjectURL(S.assetUrl);S.assetUrl=null;}$('binaryPreview').replaceChildren();}
function renderAssetPreview(){
 clearAssetPreview();const type=imageType(),pdf=S.file.path.toLowerCase().endsWith('.pdf');
 if(!type&&!pdf){$('binaryPreview').textContent='Binary asset · Included when compiling and exporting the project.';return;}
 const content=S.file.content===null?Uint8Array.from(atob(S.file.base64),value=>value.charCodeAt(0)):S.text;
 S.assetUrl=URL.createObjectURL(new Blob([content],{type:type||'application/pdf'}));const assetUrl=S.assetUrl;
 // An SVG is loaded as an image resource, never inserted into the page DOM.
 const el=document.createElement(type?'img':'iframe');el.src=S.assetUrl;el.title=S.file.path;
 if(type){el.alt=S.file.path;el.addEventListener('error',()=>{if(S.assetUrl!==assetUrl)return;const note=document.createElement('p');note.textContent='This image could not be displayed. Check the file format or use Source for text-based images.';$('binaryPreview').replaceChildren(note);});}
 $('binaryPreview').append(el);
}
function editorMode(mode){
 const asset=Boolean(imageType())||S.file?.content===null,preview=asset&&mode==='preview';S.mode=preview?'preview':'source';
 $('sourceTab').classList.toggle('active',!preview);$('assetPreviewTab').classList.toggle('active',preview);$('sourceTab').setAttribute('aria-pressed',String(!preview));$('assetPreviewTab').setAttribute('aria-pressed',String(preview));$('assetViewOptions').hidden=!asset;
 $('sourceEditor').hidden=preview||S.file?.content===null;$('binaryPreview').hidden=!preview;
 EditHistory.breakGroup();pendingEdit=null;if($('code').value!==S.text)$('code').value=S.text;
 if(preview)renderAssetPreview();else highlight();Live.render();
}
async function save(){
 cancelAutosave();
 if(S.saving){await S.saving;if(S.dirty&&!S.conflict)return save();return !S.conflict;}
 if(!S.dirty)return true;if(S.conflict||!editable())return false;
 const file=S.file,content=S.text,path=file.path,pid=S.project.id,key=draftKey(),revision=file.revision;markSaved('Saving…');
 S.saving=(async()=>{try{const r=await api(`/api/projects/${pid}/file`,'PUT',{path,content,revision});
 if(S.project?.id!==pid||S.file!==file)return true;
 file.revision=r.revision;S.saved=content;S.dirty=S.text!==content;if(!S.dirty){sessionStorage.removeItem(key);markSaved('All changes saved');}else{keepDraft();markSaved('Unsaved changes','dirty');}
 const meta=S.project.files.find(f=>f.path===path);if(meta)meta.revision=r.revision;
 scheduleCompile();scheduleBackup(pid);return true;
 }catch(e){markSaved(e.status===409?'Save conflict':'Could not save','error');keepDraft();if(e.status===409){S.conflict=true;cancelAutosave();await showConflict();return false;}if(!e.status||e.status>=500||e.status===429)scheduleAutosave(3000);throw e;}finally{S.saving=null;}})();
 const ok=await S.saving;if(S.dirty&&ok&&!S.conflict)return save();return ok;
}
async function showConflict(){const latest=await api(apiPath('file')+'?path='+encodeURIComponent(S.file.path));modal('Two versions, both safe',`<p>A coauthor changed this file. Your draft has not overwritten their work. Download your draft, then load the latest version and merge your changes.</p><div class="conflict-grid"><label>Your draft<textarea id="localConflict" readonly></textarea></label><label>Server version<textarea id="serverConflict" readonly></textarea></label></div><div class="actions"><button id="downloadDraft" class="outline">Download my draft</button><button id="useServer" class="primary">Load server version</button></div>`);$('localConflict').value=S.text;$('serverConflict').value=latest.content??'[Binary file]';action('downloadDraft',()=>download(S.text,'my-draft.'+(isTypst()?'typ':'tex'),'text/plain'));action('useServer',()=>{download(S.text,'my-draft.'+(isTypst()?'typ':'tex'),'text/plain');sessionStorage.removeItem(draftKey());S.conflict=false;S.dirty=false;closeModal();loadFile(S.file.path,true);});}
function download(data,name,type){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function downloadUrl(url){const link=document.createElement('a');link.href=url;link.download='';document.body.append(link);link.click();link.remove();}
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
const fileDragType='application/x-labtex-file';
function dragProjectFile(element,path,directory=false){
 element.draggable=Boolean(editable());if(!editable())return;
 element.addEventListener('dragstart',event=>{event.stopPropagation();event.dataTransfer.setData(fileDragType,JSON.stringify({project:S.project.id,path,directory}));event.dataTransfer.effectAllowed='move';});
}
function bindFileDrop(element,folder){
 element.addEventListener('dragover',event=>{if(!editable()||!event.dataTransfer.types.includes(fileDragType))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';element.classList.add('folder-drop-target');});
 element.addEventListener('dragleave',event=>{if(!element.contains(event.relatedTarget))element.classList.remove('folder-drop-target');});
 element.addEventListener('drop',event=>{if(!event.dataTransfer.types.includes(fileDragType))return;event.preventDefault();event.stopPropagation();element.classList.remove('folder-drop-target');let dragged;try{dragged=JSON.parse(event.dataTransfer.getData(fileDragType));}catch{return;}moveProjectFiles(dragged,folder).catch(fail);});
}
async function moveProjectFiles(dragged,folder){
 if(movingFiles)return;
 if(!editable()||dragged.project!==S.project.id)throw Error('Move files within the same editable project.');
 movingFiles=true;$('workspace').inert=true;
 try{
  const pid=S.project.id;if(!await save()||S.project?.id!==pid)return;const selected=S.file?.path;
  const project=await api('/api/projects/'+pid);if(S.project?.id!==pid)return;
  const result=await api('/api/projects/'+pid+'/move-files','POST',{path:dragged.path,directory:dragged.directory,folder,revision:project.revision});
  if(S.project?.id!==pid)return;
  await refreshAfterFileChange(pid,result.moves[selected]||selected);toast(result.changed?'Moved. Update references to the old paths.':'Already in this folder.');
 }finally{movingFiles=false;$('workspace').inert=Boolean(pendingNavigations);}
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
   const b=document.createElement('button');b.className='tree-file'+(S.file?.path===file.path?' active':'');b.title=file.path;const ext=file.path.split('.').pop();b.innerHTML=`<span class="file-icon">${esc(ext==='tex'?'T':ext==='bib'?'B':ext.slice(0,3).toUpperCase())}</span><span class="filename">${esc(file.path.split('/').at(-1))}</span>${file.path===S.project.main?'<small>MAIN</small>':''}`;b.addEventListener('click',()=>{loadFile(file.path).then(()=>{if(matchMedia('(max-width:700px)').matches)setSidebarCollapsed(true);}).catch(fail);});b.setAttribute('aria-haspopup','menu');b.setAttribute('aria-controls','fileContextMenu');dragProjectFile(b,file.path);
   const contextMenu=event=>{event.preventDefault();event.stopPropagation();const rect=b.getBoundingClientRect();fileMenu({path:file.path,x:event.clientX||rect.left+20,y:event.clientY||rect.bottom,anchor:b}).catch(fail);};
   b.addEventListener('contextmenu',contextMenu);b.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')contextMenu(event);});parent.append(b);
  }
  for(const [name,folder] of node.folders){
   const row=document.createElement('button'),arrow=document.createElement('span'),label=document.createElement('span'),children=document.createElement('div');
   row.type='button';row.className='tree-folder';row.dataset.folder=folder.path;row.title=folder.path;dragProjectFile(row,folder.path,true);bindFileDrop(row,folder.path);arrow.setAttribute('aria-hidden','true');label.textContent=name;label.className='filename';row.append(arrow,label);
   children.className='tree-children';children.dataset.folder=folder.path;children.id='file-folder-'+folderId++;row.setAttribute('aria-controls',children.id);row.setAttribute('aria-haspopup','menu');
   row.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();event.stopPropagation();directoryMenu(folder.path,{anchor:row});}});
   function expanded(value){children.hidden=!value;row.setAttribute('aria-expanded',String(value));row.setAttribute('aria-label',(value?'Collapse ':'Expand ')+folder.path);arrow.textContent=value?'▾':'▸';}
   expanded(!collapsed.has(folder.path));row.addEventListener('click',()=>{const value=children.hidden;if(value)collapsed.delete(folder.path);else collapsed.add(folder.path);if(!term)rememberFolders(state);expanded(value);});
   parent.append(row,children);renderNode(folder,children);
  }
 }
 tree.replaceChildren();renderNode(root,tree);
 $('workspaceLanguage').textContent=S.project.main.endsWith('.typ')?'TYPST WORKSPACE':'LATEX WORKSPACE';$('mainFile').innerHTML=S.project.files.filter(f=>/\.(tex|typ)$/.test(f.path)).map(f=>`<option value="${esc(f.path)}">${esc(f.path)}</option>`).join('');$('mainFile').value=S.project.main;
}
function loadFile(path,force=false){return savedNavigation(()=>readFile(path),{saveFirst:!force});}
async function readFile(path){const pid=S.project.id;const f=await api(apiPath('file')+'?path='+encodeURIComponent(path));if(S.project?.id!==pid)return;S.file=f;S.text=f.content??'';S.saved=S.text;S.dirty=false;S.conflict=false;$('filePath').textContent=path;$('filePath').title=path;$('fileType').textContent=path.endsWith('.typ')?'Typst':path.endsWith('.tex')?'LaTeX':path.split('.').pop().toUpperCase();$('code').setAttribute('aria-label',isTypst()?'Typst source':isDocument()?'LaTeX source':'File source');
 const asset=Boolean(imageType())||f.content===null;S.mode=asset?'preview':'source';
 $('sourceTab').disabled=f.content===null;
 $('code').readOnly=!editable();markSaved('All changes saved');clearAssetPreview();
 if(f.content!==null){let draft;try{draft=JSON.parse(sessionStorage.getItem(draftKey()));}catch{}if(draft&&draft.content!==f.content){S.text=draft.content;S.dirty=true;markSaved('Recovered browser draft','dirty');if(draft.revision!==f.revision){S.conflict=true;await showConflict();}else{toast('Recovered your unsaved draft.');scheduleAutosave();}}}
 EditHistory.select(editKey(),S.text);pendingEdit=null;revealFile(path);editorMode(S.mode);renderFiles();updateStats();Live.changed();
}
async function navigateTypst(path,range){
 if(!S.project?.files.some(file=>file.path===path))return;
 if(S.file?.path!==path)await loadFile(path);if(S.file?.path!==path)return;editorMode('source');const lines=S.text.split('\n');
 const index=position=>lines.slice(0,position?.line||0).reduce((sum,line)=>sum+line.length+1,0)+(position?.character||0);
 $('code').focus();$('code').setSelectionRange(index(range?.start),index(range?.end||range?.start));$('code').scrollTop=Math.max(0,((range?.start?.line||0)-3)*23);updateStats();
}
function openProject(pid,{historyMode='push'}={}){return savedNavigation(async()=>{cancelProjectRename();closeFileContextMenu();closeEditorMenu();Live.stop();const navigation=++navigationId;clearTimeout(autoTimer);const project=await api('/api/projects/'+pid);if(navigation!==navigationId)return;S.project=project;S.file=null;S.dirty=false;S.pdfKey=null;S.keepPreview=false;$('projectTitle').textContent=S.project.name;document.title=S.project.name+' · IDSL Editor';$('roleLabel').textContent=S.project.role;$('editorDeleteProject').hidden=S.project.role!=='owner';for(const id of ['compileButton','firstCompileButton','newFileButton','uploadButton','mainFile'])$(id).disabled=!editable();$('autoCompile').disabled=!editable();$('shareButton').disabled=false;$('backupButton').disabled=S.project.role!=='owner';renderFiles();await readFile(S.project.files.some(f=>f.path===S.project.main)?S.project.main:S.project.files[0].path);if(S.project?.id!==pid||navigation!==navigationId)return;Home.visible=false;$('projectHome').hidden=true;$('workspace').hidden=false;$('auth').hidden=true;updateBuild(true);$('autoCompile').checked=localStorage.getItem('labtex-auto:'+pid)==='true'||false;$('workspaceLanguage').textContent=S.project.main.endsWith('.typ')?'TYPST WORKSPACE':'LATEX WORKSPACE';closeModal();Live.open().then(enabled=>{if(S.project?.id===pid&&!enabled&&!typstProject()&&$('autoCompile').checked&&!S.project.build)scheduleCompile();});if(!S.invite)setProjectRoute('#project='+pid,historyMode);});}
// A fresh browsing context keeps PDF loads out of page Back/Forward history.
// Unloading it on the home page also releases the native PDF viewer.
function replacePdfFrame(src=null){
 const previous=$('pdfFrame');
 if(src&&previous.getAttribute('src')===src)return;
 const frame=previous.cloneNode(false);frame.removeAttribute('src');frame.hidden=true;
 if(src)frame.src=src;
 previous.replaceWith(frame);
}
function updateBuild(force=false){if(!S.project)return;const b=S.project.build;const stale=S.dirty||b&&b.revision!==S.project.revision;$('downloadButton').disabled=S.building||!(b?.success||typstProject()&&editable());$('openPdfButton').disabled=!b?.success;updatePdfTheme();if(Live.render())return;if(S.building)return;
 $('buildStatus').textContent=b?(b.success?(stale?'Changes since last build':`Compiled in ${b.seconds}s`):'Build failed'):'Ready to compile';$('buildStatus').className='build-status '+(b&&!b.success?'failed':stale?'stale':'');$('logBadge').textContent=b&&!b.success?'●':'';
 if(b?.success){const key=S.project.id+':'+b.created;if(force||S.pdfKey!==key){S.pdfKey=key;replacePdfFrame(apiPath('pdf')+'?v='+b.created+'#toolbar=0&view=FitH');}$('pdfEmpty').hidden=true;$('pdfFrame').hidden=false;}else if(S.keepPreview&&S.pdfKey){$('pdfEmpty').hidden=true;$('pdfFrame').hidden=false;}else{$('pdfEmpty').hidden=false;$('pdfFrame').hidden=true;}
 Live.render();
}
async function compile({automatic=false}={}){
 if(!S.project||S.building||startingBuild||!editable())return;
 const buildPid=S.project.id,quiet=automatic&&typstProject();startingBuild=true;
 try{if(!await save()||S.project?.id!==buildPid)return;}finally{startingBuild=false;}
 clearTimeout(autoTimer);S.building=true;$('downloadButton').disabled=true;if(!quiet)S.keepPreview=false;
 $('compileButton').disabled=true;$('firstCompileButton').disabled=true;$('compileButton').querySelector('span').textContent='Compiling…';$('buildStatus').textContent='Building PDF…';$('buildStatus').className='build-status';
 try{
  const result=await api('/api/projects/'+buildPid+'/compile','POST',{});
  if(S.project?.id!==buildPid){if(!quiet)toast(result.success?'Previous project compiled successfully.':'Previous project build failed. Open its build log for details.');return;}
  $('buildLog').textContent=result.log;renderDiagnostics(result.log);
  const project=await api('/api/projects/'+buildPid);if(S.project?.id!==buildPid)return;
  S.project=project;S.keepPreview=quiet&&!result.success&&Boolean(S.pdfKey);
  if(!result.success&&!quiet){$('logPanel').hidden=false;toast('Compilation failed. The build log has the details.');}
  else if(result.success&&!quiet)toast(`PDF compiled in ${result.seconds}s.`);
  return Boolean(result.success&&!S.dirty&&!S.conflict&&project.build?.revision===project.revision);
 }catch(error){if(S.project?.id===buildPid){$('buildLog').textContent=error.message;if(!quiet)$('logPanel').hidden=false;}if(!quiet)throw error;}
 finally{
  S.building=false;$('compileButton').disabled=!editable();$('firstCompileButton').disabled=!editable();$('compileButton').querySelector('span').textContent='Compile';updateBuild();
  if(compileAgain){compileAgain=false;scheduleCompile();}
 }
}
function projects({historyMode='push',folder=Home.folder}={}){return savedNavigation(async()=>{
 cancelProjectRename();closeFileContextMenu();closeEditorMenu();Live.stop();++navigationId;clearTimeout(autoTimer);
 S.project=null;S.file=null;S.dirty=false;S.pdfKey=null;S.keepPreview=false;replacePdfFrame();clearAssetPreview();
 $('workspace').hidden=true;$('auth').hidden=true;$('projectHome').hidden=false;
 Home.visible=true;Home.folder=folder;Home.filter='all';$('projectSearch').value='';closeModal();document.title='Projects · IDSL Editor';
 setProjectRoute(projectFolderRoute(folder),historyMode);
 $('projectCount').textContent='Loading projects…';
 await refreshProjects();
});}
function setProjectRoute(hash,mode='push'){
 if(mode==='none'||location.hash===hash)return;
 history[mode==='replace'?'replaceState':'pushState'](null,'',hash);
}
async function refreshProjects(){
 const [response,folders,templates]=await Promise.all([api('/api/projects'),api('/api/project-folders'),api('/api/templates')]);Home.projects=response.projects;Home.folders=folders.folders;Home.templates=templates.templates;
 if(Home.folder&&!Home.folders.some(folder=>folder.id===Home.folder)){Home.folder=null;if(Home.visible)setProjectRoute('#projects','replace');}
 renderProjects();renderStarterProjects();
}
function templateCard(template){
 const card=document.createElement('article');card.className='starter-card '+template.id;
 card.innerHTML=`<span class="starter-icon" aria-hidden="true">${template.id==='western-presentation'?'W':template.id==='neurips-2026'?'N':template.format==='typst'?'Ty':'TᴇX'}</span><div><h3>${esc(template.name)}</h3><p>${esc(template.description)}</p><span class="starter-format">${template.format==='typst'?'Typst':'LaTeX'}</span></div><button class="outline" data-starter="${esc(template.id)}">Use template <span aria-hidden="true">→</span></button>`;
 card.querySelector('button').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{const result=await api('/api/projects','POST',{templateId:template.id,folder:Home.folder});await openProject(result.id);}catch(error){fail(error);}finally{button.disabled=false;}});
 return card;
}
function renderStarterProjects(){
 $('starterProjects').replaceChildren(...Home.templates.filter(template=>template.featured).map(templateCard));
}
function templateLibrary(){
 modal('Template library',`<p class="hint">Choose a starter to create your own editable copy${Home.folder?' in '+esc(projectFolderPath(Home.folder)):''}. Browsing creates nothing.</p><div class="template-library-tools"><label>Search templates<input id="templateSearch" type="search" placeholder="Article, thesis, CV…"></label><label>Format<select id="templateFormat"><option value="all">All formats</option><option value="typst">Typst</option><option value="latex">LaTeX</option></select></label></div><div id="templateLibrary" class="template-library-grid"></div><p id="templatesEmpty" class="hint" hidden>No matching templates.</p>`,true);
 function render(){const term=$('templateSearch').value.trim().toLowerCase(),format=$('templateFormat').value;const matches=Home.templates.filter(template=>!template.featured&&(format==='all'||template.format===format)&&`${template.name} ${template.description}`.toLowerCase().includes(term));$('templateLibrary').replaceChildren(...matches.map(templateCard));$('templatesEmpty').hidden=matches.length>0;}
 $('templateSearch').addEventListener('input',render);$('templateFormat').addEventListener('change',render);render();$('templateSearch').focus();
}
const projectFolderRoute=id=>'#projects'+(id?'&folder='+encodeURIComponent(id):'');
function projectFolderChain(id){const chain=[],seen=new Set();while(id&&!seen.has(id)){seen.add(id);const folder=Home.folders.find(folder=>folder.id===id);if(!folder)break;chain.unshift(folder);id=folder.parent;}return chain;}
const projectFolderPath=id=>projectFolderChain(id).map(folder=>folder.name).join(' / ');
const folderContains=(id,parent)=>parent===null||projectFolderChain(id).some(folder=>folder.id===parent);
function showProjectFolder(id,historyMode='push'){
 Home.folder=id;Home.filter='all';$('projectSearch').value='';setProjectRoute(projectFolderRoute(id),historyMode);renderProjects();
}
function bindProjectDrop(target,folder){
 const projectType='application/x-labtex-project',folderType='application/x-labtex-folder';
 const accepts=event=>[projectType,folderType].some(type=>event.dataTransfer.types.includes(type));
 target.addEventListener('dragover',event=>{if(!accepts(event))return;event.preventDefault();event.dataTransfer.dropEffect='move';target.classList.add('folder-drop-target');});
 target.addEventListener('dragleave',event=>{if(!target.contains(event.relatedTarget))target.classList.remove('folder-drop-target');});
 target.addEventListener('drop',event=>{
  if(!accepts(event))return;event.preventDefault();event.stopPropagation();target.classList.remove('folder-drop-target');
  const movingFolder=event.dataTransfer.getData(folderType);
  if(movingFolder){moveExplorerFolder(movingFolder,folder).catch(fail);return;}
  const project=Home.projects.find(project=>project.id===event.dataTransfer.getData(projectType));if(project)moveProjectToFolder(project,folder).catch(fail);
 });
}
function dragExplorerFolder(element,id){
 element.draggable=true;element.addEventListener('dragstart',event=>{event.stopPropagation();event.dataTransfer.setData('application/x-labtex-folder',id);event.dataTransfer.effectAllowed='move';});
}
async function moveExplorerFolder(id,parent){
 const folder=Home.folders.find(folder=>folder.id===id);if(!folder)return;
 if(id===parent||parent&&folderContains(parent,id))throw Error('A folder cannot be moved inside itself.');
 if(folder.parent===parent)return;
 await api('/api/project-folders/'+id,'PUT',{parent});await refreshProjects();toast('Folder moved.');
}
function projectFolderLink(link,id){
 link.href=projectFolderRoute(id);link.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();showProjectFolder(id);});bindProjectDrop(link,id);
}
function renderProjectFolders(){
 const nav=$('projectFolderNav');nav.replaceChildren();
 for(const folder of [...Home.folders].sort((a,b)=>projectFolderPath(a.id).localeCompare(projectFolderPath(b.id)))){
  const link=document.createElement('a');link.className='home-folder-link';link.dataset.folder=folder.id;link.title=projectFolderPath(folder.id);link.style.setProperty('--folder-depth',projectFolderChain(folder.id).length-1);
  const icon=document.createElement('span'),name=document.createElement('span');icon.textContent='▱';icon.setAttribute('aria-hidden','true');name.textContent=folder.name;link.append(icon,name);
  if(Home.folder===folder.id){link.classList.add('active');link.setAttribute('aria-current','page');}projectFolderLink(link,folder.id);dragExplorerFolder(link,folder.id);nav.append(link);
 }
 $('noProjectFolders').hidden=Home.folders.length>0;$('folderLocation').hidden=!Home.folder;
 $('projectSearch').placeholder=Home.folder?'Search this folder…':'Search projects…';
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
function closeProjectMenus(except=null){document.querySelectorAll('.project-actions[open]').forEach(menu=>{if(menu!==except)menu.open=false;});}
function renameExplorerProject(project){
 modal('Rename project','<form id="renameProjectForm"><label>Project name<input id="renameProjectName" required maxlength="120" autofocus></label><div class="actions"><button type="button" id="cancelRenameProject" class="outline">Cancel</button><button id="saveProjectName" class="primary">Save name</button></div></form>');
 const input=$('renameProjectName'),button=$('saveProjectName');let busy=false;
 input.value=project.name;input.focus();input.select();
 const update=()=>{button.disabled=busy||!input.value.trim()||input.value.trim()===project.name;};input.addEventListener('input',update);update();
 action('cancelRenameProject',closeModal);
 $('renameProjectForm').addEventListener('submit',async event=>{
  event.preventDefault();if(button.disabled)return;busy=true;update();
  try{await api('/api/projects/'+project.id,'PUT',{name:input.value.trim()});await refreshProjects();closeModal();toast('Project renamed.');}catch(error){fail(error);}finally{busy=false;update();}
 });
}
function deleteExplorerProject(project){
 modal('Move to Trash?',`<p><strong>${esc(project.name)}</strong> can be restored for 30 days.</p><form id="deleteExplorerProjectForm"><div class="actions"><button type="button" id="cancelDeleteProject" class="outline">Cancel</button><button id="confirmDeleteProject" class="primary">Move to Trash</button></div></form>`);
 const button=$('confirmDeleteProject');let busy=false;
 action('cancelDeleteProject',closeModal);
 $('deleteExplorerProjectForm').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;busy=true;button.disabled=true;
  try{
   if(S.project?.id===project.id&&!await save())return;
   await api('/api/projects/'+project.id,'DELETE',{});
   if(S.project?.id===project.id)await projects();else await refreshProjects();closeModal();toast('Moved to Trash.');
  }catch(error){fail(error);}finally{busy=false;button.disabled=false;}
 });
}
async function trashDialog(){
 const result=await api('/api/trash');
 modal('Trash',`<p class="hint">Projects are permanently deleted after 30 days.</p><div id="trashProjects">${result.projects.map(project=>`<div class="trash-project"><div><strong>${esc(project.name)}</strong><small>Deletes ${esc(new Date(project.expires*1000).toLocaleDateString())}</small></div><div class="actions"><button class="outline" data-restore-project="${esc(project.id)}">Restore</button><button class="outline danger" data-purge-project="${esc(project.id)}">Delete forever…</button></div></div>`).join('')||'<p>Trash is empty.</p>'}</div>`);
 for(const project of result.projects){
  document.querySelector(`[data-restore-project="${project.id}"]`).addEventListener('click',async event=>{
   const button=event.currentTarget;button.disabled=true;
   try{await api('/api/trash/'+project.id,'POST',{});await refreshProjects();await trashDialog();toast('Project restored.');}catch(error){button.disabled=false;fail(error);}
  });
  document.querySelector(`[data-purge-project="${project.id}"]`).addEventListener('click',()=>{
   modal('Delete forever?',`<p>Permanently delete <strong>${esc(project.name)}</strong> and its files and history?</p><div class="actions"><button id="cancelPurgeProject" class="outline">Cancel</button><button id="purgeProject" class="primary">Delete forever</button></div>`);
   action('cancelPurgeProject',trashDialog);action('purgeProject',async()=>{
    const button=$('purgeProject');button.disabled=true;
    try{await api('/api/trash/'+project.id,'DELETE',{name:project.name});await trashDialog();toast('Project permanently deleted.');}catch(error){button.disabled=false;fail(error);}
   });
  });
 }
}
function explorerProjectActions(project){
 const menu=document.createElement('details');menu.className='project-actions';menu.dataset.projectActions=project.id;
 menu.innerHTML=`<summary class="project-menu-button" title="Project actions" aria-label="Actions for ${esc(project.name)}">⋯</summary><div class="project-action-list">${project.role!=='viewer'?`<button data-rename-project="${project.id}">Rename</button>`:''}<button data-move-project="${project.id}">Move to folder</button><button data-download-project="${project.id}">Download source ZIP</button>${project.role==='owner'?`<button class="danger" data-delete-project="${project.id}">Delete</button>`:''}</div>`;
 menu.addEventListener('toggle',()=>{if(menu.open)closeProjectMenus(menu);});
 for(const [selector,callback] of [['[data-rename-project]',renameExplorerProject],['[data-move-project]',moveProjectDialog],['[data-download-project]',project=>downloadUrl('/api/projects/'+project.id+'/source.zip')],['[data-delete-project]',deleteExplorerProject]]){
  menu.querySelector(selector)?.addEventListener('click',()=>{menu.open=false;callback(project);});
 }
 return menu;
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
  link.innerHTML=`<div class="directory-cover" aria-hidden="true"><svg viewBox="0 0 64 52" fill="none"><path d="M5 12V7a3 3 0 0 1 3-3h17l7 8h24a3 3 0 0 1 3 3v29a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V12Z" fill="currentColor" opacity=".18"/><path d="M5 18v-11a3 3 0 0 1 3-3h17l7 8h24a3 3 0 0 1 3 3v29a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V18h54" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg></div><div class="directory-details"><h2>${esc(folder.name)}</h2><p>${count} project${count===1?'':'s'} <span aria-hidden="true">→</span></p></div>`;link.title=projectFolderPath(folder.id);projectFolderLink(link,folder.id);dragExplorerFolder(link,folder.id);list.append(link);
 }
 for(const project of matches){
  const typst=project.main.endsWith('.typ');
  const link=document.createElement('a');link.className='project-entry';link.href='#project='+project.id;link.dataset.project=project.id;
  const date=new Date(project.updated*1000);
  const updated=date.toLocaleDateString(undefined,{month:'short',day:'numeric',...(date.getFullYear()!==new Date().getFullYear()?{year:'numeric'}:{})});
  const role=project.role==='owner'?'Owned by you':project.role==='editor'?'Shared · Can edit':'Shared · View only';
  link.innerHTML=`<div class="project-cover ${typst?'typst':'latex'}" aria-hidden="true"><span class="project-format">${typst?'Typst':'LaTeX'}</span><div class="project-page"><span class="project-page-title">${typst?'Aa':'TᴇX'}</span><span class="project-page-line"></span><span class="project-page-line short"></span><span class="project-page-equation">x = √α · x₀</span><span class="project-page-line"></span><span class="project-page-line short"></span></div></div><div class="project-details"><h2 title="${esc(project.name)}">${esc(project.name)}</h2><div class="project-meta"><span>${esc(project.main)}</span><time datetime="${date.toISOString()}" title="${esc(date.toLocaleString())}">${esc(updated)}</time></div><div class="project-owner"><span><span class="owner-dot" aria-hidden="true">${project.role==='owner'?'Y':'S'}</span>${role}</span><span class="project-open" aria-hidden="true">↗</span></div></div>`;
  if(project.folder&&(term||Home.filter!=='all')){const location=document.createElement('p');location.className='project-location';location.textContent=projectFolderPath(project.folder);link.querySelector('.project-details').append(location);}
  link.draggable=true;link.addEventListener('dragstart',event=>{event.dataTransfer.setData('application/x-labtex-project',project.id);event.dataTransfer.effectAllowed='move';});
  link.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();openProject(project.id).catch(fail);});
  const item=document.createElement('div');item.className='project-item';item.append(link,explorerProjectActions(project));list.append(item);
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
async function historyDialog(target){
 if(!target||target.content===null||S.project?.id!==target.pid)return;
 const base='/api/projects/'+target.pid,query='?path='+encodeURIComponent(target.path),r=await api(base+'/history'+query);if(S.project?.id!==target.pid)return;
 modal('File history',`<p>${esc(target.path)} · Up to 30 previous saved revisions. Restoring creates a new saved revision.</p><div>${r.versions.map(v=>`<div class="history-row"><div>Revision ${v.revision}<small>${new Date(v.created*1000).toLocaleString()} · saved over by ${esc(v.author)}</small></div><button class="outline" data-version="${v.id}">Inspect</button></div>`).join('')||'<p class="empty-state">Earlier versions appear here after you save changes.</p>'}</div>`);
 document.querySelectorAll('[data-version]').forEach(button=>button.addEventListener('click',async()=>{
  try{
   const version=await api(base+'/history'+query+'&id='+button.dataset.version);if(S.project?.id!==target.pid)return;
   modal('Revision '+version.revision,`<textarea id="oldVersion" class="version-preview" readonly></textarea><div class="actions"><button id="backHistory" class="outline">Back</button>${editable()?'<button id="restoreVersion" class="primary">Restore this version</button>':''}</div>`);
   $('oldVersion').value=version.content;action('backHistory',()=>historyDialog(target));
   if(editable())action('restoreVersion',async()=>{
    if(S.project?.id!==target.pid||!await save()||S.project?.id!==target.pid)return;
    if(S.file?.path===target.path){
     if(S.file.revision!==target.revision)throw Error('File changed on the server. Reopen its history before restoring.');
     setText(version.content);editorMode(S.mode);if(!await save())return;
    }else{
     await api(base+'/file','PUT',{path:target.path,content:version.content,revision:target.revision});await refreshAfterFileChange(target.pid);
    }
    if(S.project?.id===target.pid){closeModal();toast('Version restored.');}
   });
  }catch(error){fail(error);}
 }));
}

function insideFolder(folder,name){
 if(!name||name.startsWith('/')||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Choose a relative filename inside this folder.');
 return folder?folder+'/'+name:name;
}
async function addFile(folder='',pid=S.project?.id){
 if(!editable()||S.project.id!==pid||!await save()||S.project?.id!==pid)return;
 const base='/api/projects/'+pid;
 modal('Add a project file',`<form id="addFileForm"><p class="hint">Create in <strong>${esc(folder||'Project root')}</strong></p><label>Filename<input id="newFileName" placeholder="${typstProject()?'notes.typ':'notes.tex'}" maxlength="220" required></label><p>Use slashes to create subfolders inside this folder.</p><div class="actions"><button id="createProjectFile" class="primary">Create file</button></div></form>`);
 $('newFileName').focus();
 $('addFileForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('createProjectFile');if(button.disabled)return;button.disabled=true;
  try{
   if(S.project?.id!==pid)throw Error('Reopen this project to create a file.');
   const path=insideFolder(folder,$('newFileName').value.trim());await api(base+'/file','PUT',{path,content:'',revision:0});
   if(S.project?.id!==pid)return;const project=await api(base);if(S.project?.id!==pid)return;S.project=project;closeModal();await loadFile(path);
  }catch(error){fail(error);}finally{button.disabled=false;}
 });
}
let uploadTarget=null;
function chooseUpload(folder='',pid=S.project?.id){
 if(!editable()||S.project.id!==pid)return;uploadTarget={folder,pid};$('uploadFiles').value='';$('uploadFiles').click();
}
let fileMenuTicket=0,fileMenuAnchor=null;
function closeFileContextMenu(restoreFocus=false){
 fileMenuTicket++;const menu=$('fileContextMenu');if(!menu)return;menu.hidden=true;if(fileMenuAnchor?.matches('.tree-file'))fileMenuAnchor.setAttribute('aria-expanded','false');
 if(restoreFocus){const path=fileMenuAnchor?.title;(fileMenuAnchor?.isConnected?fileMenuAnchor:[...document.querySelectorAll('.tree-file,.tree-folder')].find(button=>button.title===path))?.focus();}
}
function positionFileMenu(options={}){
 const menu=$('fileContextMenu');menu.hidden=false;const anchor=fileMenuAnchor?.getBoundingClientRect();
 menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,options.x??anchor?.left??8))+'px';menu.style.top=Math.max(8,Math.min(innerHeight-menu.offsetHeight-8,options.y??(anchor?.bottom||3)+5))+'px';
 (menu.querySelector('[role=menuitem]:not(:disabled)')||menu).focus();
}
function directoryMenu(folder='',options={}){
 if(!S.project)return;closeFileContextMenu();closeAccountMenu();closeEditorMenu();const pid=S.project.id,menu=$('fileContextMenu'),disabled=editable()?'':'disabled';
 fileMenuAnchor=options.anchor||$('fileTree');
 // Folder rows use aria-expanded for their children; do not overwrite it for the menu.
 menu.setAttribute('aria-label','Folder actions');menu.innerHTML=`<div class="file-menu-heading">${esc(folder||'Project root')}</div><button id="directoryNewFile" role="menuitem" ${disabled}>New file…</button><button id="directoryUpload" role="menuitem" ${disabled}>Upload files…</button>`;
 action('directoryNewFile',()=>{closeFileContextMenu();return addFile(folder,pid);});action('directoryUpload',()=>{closeFileContextMenu();chooseUpload(folder,pid);});positionFileMenu(options);
}
$('fileTree').tabIndex=0;$('fileContextMenu').tabIndex=-1;
$('projectFiles').addEventListener('contextmenu',event=>{
 if(event.target.closest('input,textarea'))return;event.preventDefault();event.stopPropagation();
 const container=event.target.closest('.tree-folder,.tree-children'),folder=container?.dataset.folder||'';
 directoryMenu(folder,{anchor:container?.classList.contains('tree-folder')?container:$('fileTree'),x:event.clientX,y:event.clientY});
});
$('fileTree').addEventListener('keydown',event=>{if(event.target===$('fileTree')&&(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')){event.preventDefault();directoryMenu();}});
async function refreshAfterFileChange(pid,path,{reload=false}={}){
 if(S.project?.id!==pid)return;const project=await api('/api/projects/'+pid);if(S.project?.id!==pid)return;
 S.project=project;const selected=path||S.file?.path,next=project.files.some(file=>file.path===selected)?selected:project.main;
 if(reload||S.file?.path!==next){S.dirty=false;await loadFile(next,true);}else renderFiles();scheduleCompile();
}
function renameProjectFile(target){
 modal('Rename file',`<form id="renameFileForm"><label>New path<input id="renameFilePath" required maxlength="220" autofocus></label><p class="hint">Use slashes to move the file into a folder. Update document references to the old path yourself.</p><div class="actions"><button type="button" id="cancelFileAction" class="outline">Cancel</button><button id="confirmRenameFile" class="primary">Rename file</button></div></form>`);
 const input=$('renameFilePath'),button=$('confirmRenameFile');input.value=target.path;input.focus();input.select();let busy=false;
 const update=()=>button.disabled=busy||!input.value.trim()||input.value.trim()===target.path;input.addEventListener('input',update);update();action('cancelFileAction',closeModal);
 $('renameFileForm').addEventListener('submit',async event=>{event.preventDefault();if(button.disabled)return;busy=true;update();try{await api('/api/projects/'+target.pid+'/rename','POST',{path:target.path,newPath:input.value.trim(),revision:target.revision});await refreshAfterFileChange(target.pid,S.file?.path===target.path?input.value.trim():undefined);closeModal();toast('File renamed. Update references to its old path.');}catch(error){fail(error);}finally{busy=false;update();}});
}
function deleteProjectFile(target){
 modal('Delete file?',`<p>Delete <strong>${esc(target.path)}</strong> and its saved history? Document references to it will need updating.</p><form id="deleteFileForm"><div class="actions"><button type="button" id="cancelFileAction" class="outline">Cancel</button><button id="confirmDeleteFile" class="primary">Delete file</button></div></form>`);action('cancelFileAction',closeModal);
 $('deleteFileForm').addEventListener('submit',async event=>{event.preventDefault();const button=$('confirmDeleteFile');if(button.disabled)return;button.disabled=true;try{await api('/api/projects/'+target.pid+'/file','DELETE',{path:target.path,revision:target.revision});await refreshAfterFileChange(target.pid);closeModal();toast('File deleted.');}catch(error){fail(error);}finally{button.disabled=false;}});
}
function replaceProjectFile(target){
 modal('Replace file',`<form id="replaceFileForm"><p>Replace <strong>${esc(target.path)}</strong>. Its project path stays the same; the previous version is kept in file history.</p><label>Replacement file<input id="replacementFile" type="file" required></label><p class="hint">Choose the same file format. Maximum size: 8 MB.</p><div class="actions"><button type="button" id="cancelFileAction" class="outline">Cancel</button><button id="confirmReplaceFile" class="primary">Replace file</button></div></form>`);action('cancelFileAction',closeModal);
 $('replaceFileForm').addEventListener('submit',async event=>{event.preventDefault();const file=$('replacementFile').files[0],button=$('confirmReplaceFile');if(!file||button.disabled)return;button.disabled=true;try{if(file.size>8*1024*1024)throw Error('Replacement exceeds 8 MB.');await api('/api/projects/'+target.pid+'/file','PUT',{path:target.path,base64:await base64File(file),revision:target.revision});await refreshAfterFileChange(target.pid,undefined,{reload:S.file?.path===target.path});closeModal();toast('File replaced.');}catch(error){fail(error);}finally{button.disabled=false;}});
}
async function fileMenu(options={}){
 if(!S.project)return;closeFileContextMenu();closeAccountMenu();closeEditorMenu();const ticket=fileMenuTicket,pid=S.project.id,path=options.path||S.file?.path;if(!path||!await save()||S.project?.id!==pid)return;
 // Read the menu's target without navigating away from the open editor.
 const file=S.file?.path===path?{...S.file,content:S.file.content===null?null:S.text}:await api('/api/projects/'+pid+'/file?path='+encodeURIComponent(path));
 if(ticket!==fileMenuTicket||S.project?.id!==pid)return;
 const target={...file,pid},menu=$('fileContextMenu');menu.setAttribute('aria-label','File actions');fileMenuAnchor=options.anchor||document.querySelector('.tree-file.active');fileMenuAnchor?.setAttribute('aria-expanded','true');
 menu.innerHTML=`<div class="file-menu-heading">${esc(path)}</div><button id="downloadFile" role="menuitem">Download</button><button id="historyButton" role="menuitem" ${target.content===null?'disabled title="History is available for text files."':''}>File history</button>${editable()?'<button id="renameFile" role="menuitem">Rename…</button><button id="replaceFile" role="menuitem">Replace…</button><hr><button id="deleteFile" class="danger" role="menuitem" '+(path===S.project.main?'disabled title="Choose another main document before deleting this file."':'')+'>Delete…</button>':''}`;
 const item=(id,fn)=>action(id,()=>{closeFileContextMenu();return fn(target);});
 item('downloadFile',()=>download(target.content===null?Uint8Array.from(atob(target.base64),value=>value.charCodeAt(0)):target.content,path.split('/').pop(),'application/octet-stream'));
 item('historyButton',historyDialog);
 if(editable()){item('renameFile',renameProjectFile);item('replaceFile',replaceProjectFile);item('deleteFile',deleteProjectFile);}
 positionFileMenu(options);
}
document.addEventListener('click',event=>{if(!event.target.closest('#fileContextMenu'))closeFileContextMenu();});
document.addEventListener('keydown',event=>{const menu=$('fileContextMenu');if(menu.hidden)return;if(event.key==='Escape'||event.key==='Tab'){closeFileContextMenu(true);if(event.key==='Escape')event.preventDefault();return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const items=[...menu.querySelectorAll('[role=menuitem]:not(:disabled)')],index=items.indexOf(document.activeElement);if(items.length)items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();});
window.addEventListener('resize',()=>closeFileContextMenu());window.addEventListener('scroll',()=>closeFileContextMenu(),{passive:true});

async function approvedEmailsDialog(){
 const settings=await api('/api/approved-emails');
 modal('Approved IDSL Editor emails',`<p>Only these exact email addresses can register and sign in. Invitations authorize account creation; mailbox ownership is not checked.</p><form id="approvedEmailsForm"><label>One email address per line<textarea id="approvedEmailsList" class="version-preview" spellcheck="false"></textarea></label><p class="hint">Removing an address signs that member out and disables their access. Your administrator email stays approved.</p><div class="actions"><button class="primary">Save approved emails</button></div></form>`);
 $('approvedEmailsList').value=settings.emails.join('\n');
 $('approvedEmailsForm').addEventListener('submit',async event=>{event.preventDefault();try{await api('/api/approved-emails','PUT',{emails:$('approvedEmailsList').value.split(/[\s,;]+/).filter(Boolean)});closeModal();toast('Approved emails updated.');}catch(e){fail(e);}});
}
async function labSignupDialog(links=[]){
 const result=await api('/api/lab-invite');
 modal('Invite IDSL Editor members',`<p>Each link creates one account with its own private projects. Share links only inside the lab. Links expire in seven days and work once.</p><form id="createLabInvites"><label>Number of invitation links<input id="labInviteCount" type="number" min="1" max="20" value="3" required></label><button class="primary">Generate invitation links</button></form>${links.length?'<hr><p>Copy these links now. They are shown only once.</p>'+links.map((link,i)=>`<label>Invitation ${i+1}<input class="new-lab-invite" readonly value="${esc(link.url)}"></label>`).join('')+'<button id="copyLabInvites" class="outline full">Copy all new links</button>':''}<hr><p>Recent invitations</p>${result.invitations.map(invite=>`<div class="member-row"><div><strong>${invite.used_by?'Used':invite.expires*1000<Date.now()?'Expired':'Available'}</strong><small>Created ${new Date(invite.created*1000).toLocaleString()} · expires ${new Date(invite.expires*1000).toLocaleDateString()}</small></div>${!invite.used_by?`<button class="outline danger" data-revoke-invite="${invite.id}">Revoke</button>`:''}</div>`).join('')||'<p>No invitations yet.</p>'}<p class="hint">New users must enter an address on the approved list. An invitation is a secret: anyone holding an unused link can attempt signup. Revoking a link does not disable an existing account.</p>`);
 $('createLabInvites').addEventListener('submit',async event=>{event.preventDefault();try{const created=await api('/api/lab-invite','POST',{count:Number($('labInviteCount').value)});await labSignupDialog(created.links);}catch(e){fail(e);}});
 if(links.length)action('copyLabInvites',async()=>{try{await navigator.clipboard.writeText(links.map((link,i)=>`Invitation ${i+1}: ${link.url}`).join('\n'));toast('Invitation links copied.');}catch{toast('Select and copy each invitation link.');}});
 document.querySelectorAll('[data-revoke-invite]').forEach(button=>button.addEventListener('click',async()=>{try{await api('/api/lab-invite','DELETE',{id:button.dataset.revokeInvite});await labSignupDialog(links.filter(link=>link.id!==button.dataset.revokeInvite));}catch(e){fail(e);}}));
}
async function authenticate(){
 const session=await api('/api/session');S.user=session.user;S.demo=session.demo;S.canInviteLab=session.canInviteLab;
 if(!S.user){$('auth').hidden=false;$('workspace').hidden=true;$('projectHome').hidden=true;Home.visible=false;S.authMode=session.needsSetup?'setup':S.signup?'register':'login';renderAuth();return;}
 $('auth').hidden=true;
 $('accountButton').textContent=S.user.name.split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase();$('homeAccountButton').textContent=$('accountButton').textContent;

 let pid=new URLSearchParams(location.hash.slice(1)).get('project');
 if(S.invite&&!S.demo){const joined=await api('/api/join','POST',{token:S.invite});pid=joined.id;S.invite=null;history.replaceState(null,'','#project='+pid);toast('You joined the project.');}
 if(S.signup){S.signup=null;history.replaceState(null,'',location.pathname);}
 if(pid){const r=await api('/api/projects');if(r.projects.some(p=>p.id===pid)){await openProject(pid,{historyMode:'replace'});return;}}await projects({historyMode:'replace',folder:new URLSearchParams(location.hash.slice(1)).get('folder')});
}
function renderAuth(){
 const mode=S.authMode;
 $('authTitle').textContent=mode==='setup'?'Set up IDSL Editor':mode==='register'?(S.signup?'Create your IDSL Editor account':'Join your coauthors'):'Sign in to IDSL Editor';
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
  if(params.has('invite')||params.has('signup')){if(!await save()){restoreCurrentRoute();return;}S.invite=params.get('invite');S.signup=params.get('signup');await authenticate();}
  else if(S.user&&params.has('project')&&params.get('project')!==S.project?.id)await openProject(params.get('project'),{historyMode:'none'});
  else if(S.user&&!params.has('project'))await projects({historyMode:'none',folder:params.get('folder')});
 }catch(e){fail(e);}
});
bindFileDrop($('fileRootDrop'),null);
let sidebarCollapsed=localStorage.getItem('labtex-sidebar-collapsed');
sidebarCollapsed=sidebarCollapsed===null?matchMedia('(max-width:700px)').matches:sidebarCollapsed==='true';
function applySidebarVisibility(){
 $('filesPanel').classList.toggle('collapsed',sidebarCollapsed);$('projectFiles').hidden=sidebarCollapsed;$('sidebarBackdrop').hidden=sidebarCollapsed||!matchMedia('(max-width:700px)').matches;
 const button=$('sidebarToggle'),label=(sidebarCollapsed?'Show':'Hide')+' project files';button.setAttribute('aria-expanded',String(!sidebarCollapsed));button.setAttribute('aria-label',label);button.title=label+' (Ctrl/Cmd+B)';
}
function setSidebarCollapsed(collapsed){sidebarCollapsed=collapsed;localStorage.setItem('labtex-sidebar-collapsed',String(collapsed));closeFileContextMenu();applySidebarVisibility();}
action('sidebarToggle',()=>setSidebarCollapsed(!sidebarCollapsed));action('sidebarBackdrop',()=>setSidebarCollapsed(true));applySidebarVisibility();
function closeEditorMenu(restoreFocus=false){
 $('editorMenu').hidden=true;$('editorMenuButton').setAttribute('aria-expanded','false');if(restoreFocus)$('editorMenuButton').focus();
}
function positionEditorMenu(){
 const menu=$('editorMenu');if(menu.hidden)return;const rect=$('editorMenuButton').getBoundingClientRect();
 menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,rect.right-menu.offsetWidth))+'px';menu.style.top=rect.bottom+8+'px';menu.style.maxHeight=Math.max(100,innerHeight-rect.bottom-16)+'px';
}
action('editorMenuButton',()=>{
 const open=$('editorMenu').hidden;closeEditorMenu();closeAccountMenu();closeFileContextMenu();if(!open)return;
 updateStats();$('editorMenu').hidden=false;$('editorMenuButton').setAttribute('aria-expanded','true');positionEditorMenu();$('editorMenu').querySelector('button:not(:disabled)').focus();
});
function dismissEditorMenuOutside(event){if(!event.composedPath().some(element=>element===$('editorMenu')||element===$('editorMenuButton')))closeEditorMenu();}
document.addEventListener('pointerdown',dismissEditorMenuOutside,true);document.addEventListener('click',dismissEditorMenuOutside,true);
$('editorMenu').addEventListener('click',event=>{if(event.target.closest('button'))closeEditorMenu(true);});
$('editorMenu').addEventListener('focusout',event=>{if(event.relatedTarget&&event.relatedTarget!==$('editorMenuButton')&&!$('editorMenu').contains(event.relatedTarget))closeEditorMenu();});
window.addEventListener('blur',()=>closeEditorMenu());
window.addEventListener('resize',()=>{applySidebarVisibility();positionEditorMenu();});
document.addEventListener('keydown',event=>{
 if($('workspace').hidden||$('modal').open||event.isComposing)return;
 if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='b'){event.preventDefault();if(!sidebarCollapsed&&$('projectFiles').contains(document.activeElement))$('sidebarToggle').focus();setSidebarCollapsed(!sidebarCollapsed);}
 if(event.key==='Escape'&&!event.defaultPrevented){if(!$('editorMenu').hidden){event.preventDefault();closeEditorMenu(true);}else if(!sidebarCollapsed&&matchMedia('(max-width:700px)').matches){event.preventDefault();setSidebarCollapsed(true);$('sidebarToggle').focus();}}
});
action('closeModal',closeModal);action('projectsButton',projects);action('projectsNavButton',projects);action('sourceTab',()=>{editorMode('source');$('code').focus();});action('assetPreviewTab',()=>editorMode('preview'));action('compileButton',compile);action('firstCompileButton',compile);action('shareButton',share);action('backupButton',backupDialog);action('newFileButton',addFile);action('uploadButton',chooseUpload);
action('downloadButton',async()=>{const pid=S.project?.id;if(typstProject()&&editable()&&!await compile())return;if(S.project?.id===pid&&S.project?.build?.success)downloadUrl(apiPath('pdf')+'?download=1');});action('openPdfButton',()=>{if(S.project?.build?.success)window.open(apiPath('pdf'),'_blank','noopener');});action('exportSourceButton',async()=>{const pid=S.project?.id;if(await save()&&S.project?.id===pid)downloadUrl(apiPath('source.zip'));});action('logButton',async()=>{$('logPanel').hidden=!$('logPanel').hidden;if(!$('logPanel').hidden&&S.project?.build){const log=await api(apiPath('log'));$('buildLog').textContent=log.log;renderDiagnostics(log.log);}});action('closeLog',()=>$('logPanel').hidden=true);
let projectRename=null;
function cancelProjectRename(focus=false){projectRename=null;$('projectTitleInput').hidden=true;$('projectTitleInput').disabled=false;$('projectTitle').hidden=false;if(focus)$('projectTitle').focus();}
function beginProjectRename(){
 if(!editable()||projectRename)return;closeAccountMenu();closeEditorMenu();closeFileContextMenu();projectRename={pid:S.project.id,name:S.project.name,saving:false};
 const input=$('projectTitleInput');input.value=S.project.name;input.setCustomValidity('');input.hidden=false;$('projectTitle').hidden=true;input.focus();input.select();
}
async function finishProjectRename(){
 const edit=projectRename,input=$('projectTitleInput');if(!edit||edit.saving)return;const name=input.value.trim();
 if(!name){input.setCustomValidity('Enter a project name.');input.reportValidity();input.focus();return;}
 if(name===edit.name){cancelProjectRename();return;}edit.saving=true;input.disabled=true;
 try{
  await api('/api/projects/'+edit.pid,'PUT',{name});
  if(S.project?.id===edit.pid){S.project.name=name;$('projectTitle').textContent=name;document.title=name+' · IDSL Editor';}
  if(projectRename===edit)cancelProjectRename();
 }catch(error){if(projectRename===edit){edit.saving=false;input.disabled=false;input.focus();}fail(error);}
}
action('projectTitle',beginProjectRename);
action('editorDeleteProject',()=>{if(S.project?.role==='owner')deleteExplorerProject({...S.project});});
action('openTrash',trashDialog);
$('projectTitleInput').addEventListener('input',event=>event.target.setCustomValidity(''));
$('projectTitleInput').addEventListener('blur',finishProjectRename);
$('projectTitleInput').addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancelProjectRename(true);}else if(event.key==='Enter'){event.preventDefault();finishProjectRename();}});
let accountAnchor=null;
function closeAccountMenu(restoreFocus=false){
 const menu=$('accountDropdown');if(!menu)return;menu.hidden=true;
 for(const id of ['accountButton','homeAccountButton'])$(id).setAttribute('aria-expanded','false');
 if(restoreFocus)accountAnchor?.focus();
}
function positionAccountMenu(){
 const menu=$('accountDropdown');if(menu.hidden||!accountAnchor)return;
 const rect=accountAnchor.getBoundingClientRect();
 menu.style.left=Math.max(12,Math.min(innerWidth-menu.offsetWidth-12,rect.right-menu.offsetWidth))+'px';
 menu.style.top=Math.min(rect.bottom+8,Math.max(12,innerHeight-menu.offsetHeight-12))+'px';
}
function accountMenu(anchor){
 const menu=$('accountDropdown'),wasOpen=!menu.hidden&&accountAnchor===anchor;closeAccountMenu();closeEditorMenu();closeFileContextMenu();if(wasOpen)return;accountAnchor=anchor;
 menu.innerHTML=`<div class="account-menu-heading"><strong>${esc(S.user.name)}</strong><small>${esc(S.user.email)}</small></div><button id="accountProjects" role="menuitem">My projects</button><button id="accountAppearance" role="menuitem">Themes &amp; appearance</button>${!S.project?'<button id="accountBackups" role="menuitem">GitHub backups</button>':''}${S.project?.role==='owner'?'<button id="accountProjectBackup" role="menuitem">Back up this project</button>':''}${S.canInviteLab?'<hr><button id="inviteLabMembers" role="menuitem">Invite lab members</button><button id="approvedEmailsButton" role="menuitem">Approved emails</button>':''}${S.demo?'<p class="hint">Local preview account</p>':'<hr><button id="signOut" role="menuitem">Sign out</button>'}${S.project?.role==='owner'?'<hr><button id="deleteProject" class="danger" role="menuitem">Delete project</button>':''}`;
 function item(id,fn){action(id,()=>{closeAccountMenu();return fn();});}
 item('accountProjects',projects);item('accountAppearance',appearanceDialog);if(!S.project)item('accountBackups',allBackupsDialog);if(S.project?.role==='owner')item('accountProjectBackup',backupDialog);
 if(S.canInviteLab){item('inviteLabMembers',labSignupDialog);item('approvedEmailsButton',approvedEmailsDialog);}
 if(!S.demo)item('signOut',()=>savedNavigation(async()=>{await api('/api/logout','POST',{});for(const key of Object.keys(sessionStorage))if(key.startsWith('labtex-draft:'+S.user.id+':'))sessionStorage.removeItem(key);location.href='/';}));
 if(S.project?.role==='owner')item('deleteProject',()=>deleteExplorerProject({...S.project}));
 menu.hidden=false;anchor.setAttribute('aria-expanded','true');positionAccountMenu();menu.querySelector('[role=menuitem]').focus();
}
for(const id of ['accountButton','homeAccountButton']){const button=$(id);button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','accountDropdown');action(id,()=>accountMenu(button));button.addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();accountMenu(button);if(event.key==='ArrowUp')$('accountDropdown').querySelector('[role=menuitem]:last-child')?.focus();}});}
function dismissAccountMenuOutside(event){
 const path=event.composedPath();
 if(!['accountDropdown','accountButton','homeAccountButton'].some(id=>path.includes($(id))))closeAccountMenu();
}
document.addEventListener('pointerdown',dismissAccountMenuOutside,true);
document.addEventListener('click',dismissAccountMenuOutside,true);
// Pointer events inside preview frames stay in their document; focus leaves ours.
window.addEventListener('blur',()=>closeAccountMenu());
document.addEventListener('keydown',event=>{const menu=$('accountDropdown');if(menu.hidden)return;if(event.key==='Escape'){event.preventDefault();closeAccountMenu(true);return;}if(event.key==='Tab'){closeAccountMenu(true);return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const items=[...menu.querySelectorAll('[role=menuitem]')],index=items.indexOf(document.activeElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();});
window.addEventListener('resize',positionAccountMenu);window.addEventListener('scroll',()=>closeAccountMenu(),{passive:true});
action('helpButton',()=>modal('A workspace that stays out of the way',`<p><strong>Ctrl / Cmd + Z</strong> undoes. <strong>Ctrl / Cmd + Shift + Z</strong> or <strong>Ctrl + Y</strong> redoes. <strong>Ctrl / Cmd + S</strong> saves. <strong>Ctrl / Cmd + Enter</strong> compiles. Tab inserts two spaces in source mode.</p><p>Download your Overleaf project as a ZIP and import it from the project picker. Choose its main .tex or .typ document in the project ⋯ menu. Upload figures, bibliography files, classes, and styles with the upload button.</p><p><strong>Ctrl / Cmd + B</strong> toggles Project files. Right-click a file for its history. Preview colors and GitHub backup are beside the theme toggle. Use the project <strong>⋯</strong> menu for sharing, source ZIP, the main document, build logs, and document details.</p><p>Edit LaTeX and Typst directly in source. Typst uses live preview; Export PDF creates a downloadable PDF without switching the preview. Ctrl/Cmd+Space opens completions, Ctrl/Cmd+Shift+Space shows documentation, F12 opens a definition, Shift+Alt/Option+F formats, and Alt/Option+Enter reveals the cursor in the live preview. Editing is shared through autosave and periodic refresh, with conflict detection; this version does not merge simultaneous keystrokes.</p><p>Up to 30 saved versions per file are available, within a 40 MB history limit per project. Deleting a file removes its history. Browser drafts survive a refresh in the same tab.</p><p>This server allows 300 seconds per build, 8 MB per file, 40 MB of current files per project, and 25 owned projects per account. Shell escape is disabled.</p>`));
// Keep editing shortcuts scoped to the document, so search and dialog fields
// retain their normal browser undo. Keep history local to source editing.
const editorPane=document.querySelector('.editor-pane');
editorPane.addEventListener('beforeinput',event=>{
 if(['historyUndo','historyRedo'].includes(event.inputType)){event.preventDefault();undoEdit(event.inputType==='historyRedo');return;}
 captureEdit(event.inputType);
},true);
editorPane.addEventListener('paste',()=>captureEdit('insertFromPaste'),true);
editorPane.addEventListener('pointerdown',()=>EditHistory.breakGroup(),true);
editorPane.addEventListener('keydown',event=>{
 if(event.isComposing)return;
 const key=event.key.toLowerCase(),modifier=event.ctrlKey||event.metaKey;
 if(modifier&&!event.altKey&&(key==='z'||key==='y'&&event.ctrlKey)){
  event.preventDefault();event.stopPropagation();undoEdit(key==='y'||event.shiftKey);return;
 }
 if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))EditHistory.breakGroup();
},true);
$('fileFilter').addEventListener('input',renderFiles);$('code').addEventListener('input',()=>setText($('code').value));$('code').addEventListener('scroll',syncScroll);$('code').addEventListener('click',updateStats);$('code').addEventListener('keyup',updateStats);$('code').addEventListener('keydown',e=>{if(e.key==='Tab'&&editable()){e.preventDefault();const area=e.target,before=editSelection();area.setRangeText('  ',area.selectionStart,area.selectionEnd,'end');setText(area.value,false,{before,kind:'tab'});}});$('mainFile').addEventListener('change',async()=>{try{if(!await save())return;await api(apiPath(),'PUT',{main:$('mainFile').value});S.project=await api(apiPath());renderFiles();updateBuild();Live.open().then(enabled=>{if(!enabled&&$('autoCompile').checked)scheduleCompile();});}catch(e){fail(e);}});
$('autoCompile').addEventListener('change',()=>{localStorage.setItem('labtex-auto:'+S.project.id,String($('autoCompile').checked));clearTimeout(autoTimer);if($('autoCompile').checked)compile().catch(fail);});
$('uploadFiles').addEventListener('cancel',()=>{uploadTarget=null;});
$('uploadFiles').addEventListener('change',async event=>{
 const target=uploadTarget||{pid:S.project?.id,folder:''},files=[...event.target.files];uploadTarget=null;
 try{
  if(!files.length||S.project?.id!==target.pid||!editable()||!await save()||S.project?.id!==target.pid)return;
  const base='/api/projects/'+target.pid;let project=await api(base),last;
  for(const file of files){
   if(S.project?.id!==target.pid)return;if(file.size>8*1024*1024)throw Error(file.name+' exceeds 8 MB.');
   const path=insideFolder(target.folder,file.name),exists=project.files.find(item=>item.path===path);if(exists&&!confirm('Replace '+path+'?'))continue;
   await api(base+'/file','PUT',{path,base64:await base64File(file),revision:exists?.revision||0});last=path;project=await api(base);
  }
  if(S.project?.id!==target.pid)return;S.project=project;renderFiles();if(last)await loadFile(last);toast('Files uploaded.');
 }catch(error){fail(error);}finally{event.target.value='';}
});
$('importZip').addEventListener('change',async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>40*1024*1024)throw Error('ZIP exceeds 40 MB.');toast('Importing project…');const r=await api('/api/projects','POST',{name:file.name.replace(/\.zip$/i,''),zip:await base64File(file),folder:Home.folder});await openProject(r.id);toast('Project imported. Check the main document, then compile.');}catch(e){fail(e);}finally{e.target.value='';}});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save().catch(fail);}if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();compile().catch(fail);}});
window.addEventListener('blur',flushAutosave);
document.addEventListener('visibilitychange',()=>{if(document.hidden)flushAutosave();});
window.addEventListener('pagehide',flushAutosave);
window.addEventListener('beforeunload',e=>{flushAutosave();if(S.dirty||S.saving){keepDraft();e.preventDefault();e.returnValue='';}});
const handle=$('splitHandle');handle.addEventListener('pointerdown',e=>{handle.setPointerCapture(e.pointerId);handle.dataset.drag='1';});handle.addEventListener('pointermove',e=>{if(!handle.dataset.drag)return;const r=$('workbench').getBoundingClientRect();const percent=Math.max(25,Math.min(75,(e.clientX-r.left)/r.width*100));$('workbench').style.gridTemplateColumns=`minmax(200px,${percent}fr) 6px minmax(200px,${100-percent}fr)`;});handle.addEventListener('pointerup',()=>delete handle.dataset.drag);handle.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const p=Math.max(25,Math.min(75,Number(handle.dataset.percent||50)+(e.key==='ArrowRight'?5:-5)));handle.dataset.percent=p;$('workbench').style.gridTemplateColumns=`minmax(200px,${p}fr) 6px minmax(200px,${100-p}fr)`;}});
setInterval(async()=>{if(!S.project||!S.user||pollBusy||movingFiles||pendingNavigations||S.building||document.hidden)return;pollBusy=true;try{const pid=S.project.id;const p=await api('/api/projects/'+pid);if(S.project?.id!==pid||movingFiles||pendingNavigations)return;$('connectionStatus').textContent='Connected';if(!S.dirty&&!S.saving&&!S.conflict){const f=p.files.find(f=>f.path===S.file?.path);if(!f){S.project=p;await loadFile(p.main);}else if(f.revision!==S.file.revision){S.project=p;await loadFile(f.path);toast('File updated by a coauthor.');}}if(S.project?.id!==pid)return;S.project=p;$('projectTitle').textContent=p.name;renderFiles();updateBuild();}catch(e){$('connectionStatus').textContent=e.status===401?'Session expired':'Connection interrupted';if(e.status===401)markSaved('Sign in again to save','error');}finally{pollBusy=false;}},4000);
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
 if(!S.backupAuto||!(S.githubToken||S.githubSaved)||S.project?.role!=='owner')return;
 backupTimers.set(pid,setTimeout(async()=>{backupTimers.delete(pid);if(!S.backupAuto||!(S.githubToken||S.githubSaved))return;try{await api('/api/projects/'+pid+'/backup','POST',{token:S.githubToken});toast('GitHub backup is up to date.');}catch(e){S.backupAuto=false;for(const timer of backupTimers.values())clearTimeout(timer);backupTimers.clear();toast('Automatic backup paused: '+e.message);}},30000));
}
function tokenControls(prefix,credential){
 return `<p class="hint">Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub access token</a> with <strong>Contents: Read and write</strong> for your backup repositories.</p><label class="backup-check"><input id="${prefix}Remember" type="checkbox" checked> Remember token for future sessions</label><p id="${prefix}TokenStatus" class="hint">${credential.saved?'A token is saved in '+esc(credential.storage)+'. Leave the field blank to reuse it.':'Remembered tokens are kept in '+esc(credential.storage)+', never in browser storage.'}</p><button id="${prefix}Forget" type="button" class="text-button" ${credential.saved?'':'hidden'}>Forget saved token</button>`;
}
function bindTokenControls(prefix,credential){
 S.githubSaved=credential.saved;$(prefix+'Token').value=S.githubToken;
 if(credential.saved)$(prefix+'Token').placeholder='Saved token · leave blank to reuse';
 action(prefix+'Forget',async()=>{const result=await api('/api/github-token','DELETE',{});S.githubSaved=result.saved;S.githubToken='';$(prefix+'Token').value='';$(prefix+'Token').placeholder='Fine-grained token with Contents read/write';$(prefix+'Forget').hidden=true;$(prefix+'TokenStatus').textContent='Saved token removed from this app. This does not revoke it on GitHub.';});
}
async function saveGitHubToken(prefix){
 const token=$(prefix+'Token').value.trim();
 if(token){
  if($(prefix+'Remember').checked){
   const result=await api('/api/github-token','PUT',{token});S.githubSaved=result.saved;S.githubToken='';$(prefix+'Token').value='';$(prefix+'Token').placeholder='Saved token · leave blank to reuse';$(prefix+'Forget').hidden=false;$(prefix+'TokenStatus').textContent='Token saved in '+result.storage+'. It will be reused after signing in again.';
  }else S.githubToken=token;
 }
}
let allBackupFlight=null;
function pushAllBackups(){
 if(allBackupFlight)return allBackupFlight;
 const button=$('homeBackupButton');button.disabled=true;button.setAttribute('aria-busy','true');
 allBackupFlight=api('/api/backups','POST',{token:S.githubToken,sharedOnly:true}).finally(()=>{allBackupFlight=null;button.disabled=false;button.removeAttribute('aria-busy');});
 return allBackupFlight;
}
function renderAllBackupResults(result,response){
 result.replaceChildren();result.classList.remove('error');
 if(!response.results.length)result.textContent='You do not own any projects to back up.';
 for(const item of response.results){const line=document.createElement('div');if(item.error){line.textContent=item.name+': '+item.error;result.classList.add('error');}else{const link=document.createElement('a');link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=item.name+': '+(item.changed?'Snapshot saved':'Already up to date')+' → '+item.repository+(item.folder?'/'+item.folder:'');line.append(link);}result.append(line);}
}
async function quickGlobalBackup(){
 const button=$('homeBackupButton'),uid=S.user?.id;if(S.project||!Home.visible||button.disabled)return;
 closeAccountMenu();button.disabled=true;button.setAttribute('aria-busy','true');
 try{
  const [defaults,credential]=await Promise.all([api('/api/backup-settings'),api('/api/github-token')]);
  if(S.user?.id!==uid||S.project||!Home.visible)return;S.githubSaved=credential.saved;
  if(!defaults.repository||!(S.githubToken||credential.saved)){await allBackupsDialog();return;}
  toast('Backing up all projects…');const response=await pushAllBackups();if(S.user?.id!==uid)return;
  const failed=response.results.filter(item=>item.error).length;
  if(failed){if(!S.project&&Home.visible)await allBackupsDialog({response});else toast('GitHub backup: '+failed+' project(s) failed. Open GitHub backups for details.');}
  else toast(!response.results.length?'You do not own any projects to back up.':response.results.some(item=>item.changed)?'Global GitHub backup updated.':'Global GitHub backup is up to date.');
 }catch(error){if(S.user?.id===uid){if(!S.project&&Home.visible)await allBackupsDialog({error:error.message});else fail(error);}}
 finally{button.disabled=Boolean(allBackupFlight);if(!allBackupFlight)button.removeAttribute('aria-busy');}
}
action('homeBackupButton',quickGlobalBackup);
async function allBackupsDialog(initial={}){
 const uid=S.user?.id;if(S.project||!await save())return;const [defaults,credential]=await Promise.all([api('/api/backup-settings'),api('/api/github-token')]);
 if(S.user?.id!==uid||S.project||!Home.visible)return;
 modal('Back up all projects',`<p>Back up every project you own into one GitHub repository. Each project gets its own folder under projects/, named after the project. Duplicate names receive a numbered suffix. Shared projects owned by someone else are excluded. Use a private repository for private documents.</p><form id="allBackupsForm"><label>Shared GitHub repository<input id="allBackupRepo" placeholder="your-name/research-documents" value="${esc(defaults.repository)}" required></label><label>Branch<input id="allBackupBranch" placeholder="Default branch" value="${esc(defaults.branch)}"></label><label>GitHub access token<input id="allBackupToken" type="password" autocomplete="off" placeholder="Fine-grained token with Contents read/write"></label>${tokenControls('allBackup',credential)}<p class="hint">Create the repository on GitHub first. Project-specific repository settings are preserved.</p><div class="actions"><button id="saveAllBackupSettings" type="button" class="outline">Save settings</button><button id="runAllBackups" class="primary">Back up all to this repository</button></div></form><div id="allBackupResult" class="backup-result" role="status">Ready to back up your owned projects.</div>`);
 bindTokenControls('allBackup',credential);
 if(initial.response)renderAllBackupResults($('allBackupResult'),initial.response);
 if(initial.error){$('allBackupResult').textContent=initial.error;$('allBackupResult').classList.add('error');}
 async function settings(){await api('/api/backup-settings','PUT',{repository:$('allBackupRepo').value,branch:$('allBackupBranch').value});await saveGitHubToken('allBackup');}
 action('saveAllBackupSettings',async()=>{await settings();$('allBackupResult').textContent='Shared repository settings saved.';});
 $('allBackupsForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('runAllBackups'),saveButton=$('saveAllBackupSettings'),result=$('allBackupResult');if(button.disabled)return;if(allBackupFlight){toast('A global GitHub backup is already running.');return;}button.disabled=true;saveButton.disabled=true;result.classList.remove('error');
  try{
   await settings();if(!(S.githubToken||S.githubSaved))throw Error('Enter your GitHub token first.');result.textContent='Backing up your owned projects…';
   const response=await pushAllBackups();renderAllBackupResults(result,response);
  }catch(error){result.textContent=error.message;result.classList.add('error');}finally{button.disabled=false;saveButton.disabled=false;}
 });
}
async function backupDialog(){
 if(!S.project||S.project.role!=='owner')return;
 if(!await save())return;
 const pid=S.project.id,projectName=S.project.name,path='/api/projects/'+pid;
 const [project,credential]=await Promise.all([api(path+'/backup-settings'),api('/api/github-token')]);
 let busy=false;
 modal('Back up this project',`<p>Back up <strong>${esc(projectName)}</strong> to GitHub. These actions update only this project.</p>
 <form id="backupForm"><div class="backup-options">
 <section id="projectGlobalBackup" class="project-global-backup" aria-label="Global backup status"></section>
 <label>This project's backup destination<select id="backupMode"><option value="shared">Shared repository · this project's folder only</option><option value="separate">Separate repository for this project</option></select></label>
 <div id="separateBackup"><label>Project repository<input id="backupProjectRepo" placeholder="your-name/this-paper" value="${esc(project.repository)}"></label><label>Project branch<input id="backupProjectBranch" placeholder="Default branch" value="${esc(project.branch)}"></label></div>
 <p id="backupPath" class="hint backup-destination"></p>
 <label>GitHub access token<input id="backupToken" type="password" autocomplete="off" placeholder="Fine-grained token with Contents read/write"></label>
 ${tokenControls('backup',credential)}
 <label class="backup-check"><input id="backupAuto" type="checkbox"> Back up this project 30 seconds after saving while this tab is open</label>
 </div><div class="row"><button type="submit" class="outline">Save settings</button><button type="button" id="backupCurrent" class="primary">Back up this project</button></div></form>
 <div id="backupResult" class="backup-result" role="status">${project.last_url?`Last snapshot: <a href="${esc(project.last_url)}" target="_blank" rel="noopener noreferrer">${esc(project.last_commit.slice(0,8))}</a> · revision ${project.last_revision}`:'No GitHub snapshot recorded for this project yet.'}</div>`);
 function renderGlobal(status){
  const panel=$('projectGlobalBackup');if(!panel)return;
  if(!status?.included){panel.innerHTML='<strong>Global backup</strong><p>No shared repository configured. Set it from the project explorer’s account menu. You can use a separate repository here.</p>';return;}
  const snapshot=status.snapshot;
  let message=!snapshot?'Included in all-project backups; no verified snapshot has been recorded yet.':!snapshot.updated?'An earlier snapshot exists in this repository. Update it to verify the current branch.':status.stale||S.dirty?'Changes since this project’s last global backup.':'This project’s saved changes are backed up.';
  panel.innerHTML=`<strong>Included in global backup</strong><p id="globalBackupRepository">${esc(status.repository)} · ${esc(status.branch||'default branch')}</p><p id="globalBackupStatus">${esc(message)}</p>${snapshot?`<p class="hint">${snapshot.folder?esc(snapshot.folder)+' · ':''}<a href="${esc(snapshot.last_url)}" target="_blank" rel="noopener noreferrer">Last snapshot ${esc(snapshot.last_commit.slice(0,8))}</a> · revision ${snapshot.last_revision}</p>`:''}<button id="updateGlobalBackup" type="button" class="outline">Update this project in global backup</button><p class="hint">Updates only this project’s folder. Manage all-project backups in the project explorer.</p>`;
  $('updateGlobalBackup').disabled=busy;action('updateGlobalBackup',()=>run(true));
 }
 renderGlobal(project.global_backup);
 $('backupMode').value=project.mode;bindTokenControls('backup',credential);$('backupAuto').checked=S.backupAuto;
 function layout(){const shared=$('backupMode').value==='shared';$('separateBackup').hidden=shared;$('backupPath').textContent=shared?'Sources go in projects/ under the project name. Duplicate names receive a number.':'Sources go at the repository root. Existing unrelated files are preserved.';}
 layout();$('backupMode').addEventListener('change',layout);
 async function saveSettings(){
  if(S.project?.id!==pid)throw Error('Open this project again before backing it up.');
  await api(path+'/backup-settings','PUT',{mode:$('backupMode').value,repository:$('backupProjectRepo').value,branch:$('backupProjectBranch').value});
  await saveGitHubToken('backup');S.backupAuto=$('backupAuto').checked;
  if(S.backupAuto&&!(S.githubToken||S.githubSaved)){S.backupAuto=false;throw Error('Enter a token or reuse a saved token to enable automatic backups for this tab.');}
  if(!S.backupAuto){for(const timer of backupTimers.values())clearTimeout(timer);backupTimers.clear();}
 }
 $('backupForm').addEventListener('submit',async event=>{event.preventDefault();try{await saveSettings();$('backupResult').textContent='Backup settings saved. Back up now to create a snapshot.';}catch(e){$('backupResult').textContent=e.message;}});
 async function run(global=false){
  if(busy||S.project?.id!==pid)return;busy=true;
  $('backupCurrent').disabled=true;if($('updateGlobalBackup'))$('updateGlobalBackup').disabled=true;$('backupResult').classList.remove('error');
  try{
   if(!await save())return;
   if(global)await saveGitHubToken('backup');else await saveSettings();
   if(!(S.githubToken||S.githubSaved))throw Error('Enter your GitHub token first.');
   $('backupResult').textContent=global?'Updating this project in the global backup…':'Creating this project’s GitHub snapshot…';
   const body={token:S.githubToken};if(global)body.sharedOnly=true;
   const result=await api(path+'/backup','POST',body);
   if(S.project?.id!==pid||!$('backupResult'))return;
   const link=document.createElement('a');link.href=result.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=(result.name||projectName)+': '+(result.changed?'Snapshot saved':'Already up to date')+' → '+result.repository+(result.folder?'/'+result.folder:'')+' ('+result.commit.slice(0,8)+')';$('backupResult').replaceChildren(link);
   const latest=await api(path+'/backup-settings');if(S.project?.id===pid)renderGlobal(latest.global_backup);
  }catch(e){if($('backupResult')){$('backupResult').classList.add('error');$('backupResult').textContent=e.message;}}finally{busy=false;if($('backupCurrent'))$('backupCurrent').disabled=false;if($('updateGlobalBackup'))$('updateGlobalBackup').disabled=false;}
 }
 action('backupCurrent',()=>run());
}

// The project explorer is a page, with browser-history navigation to editors.
action('createProject',newProject);action('emptyNewProject',newProject);action('importProject',()=>$('importZip').click());action('refreshProjects',refreshProjects);
action('upProjectFolder',()=>showProjectFolder(Home.folders.find(folder=>folder.id===Home.folder)?.parent||null));action('rootProjectFolder',()=>showProjectFolder(null));
action('createProjectFolder',()=>projectFolderDialog());action('sidebarNewFolder',()=>projectFolderDialog());action('manageProjectFolder',()=>projectFolderDialog(Home.folders.find(folder=>folder.id===Home.folder)));
bindProjectDrop(document.querySelector('[data-project-filter="all"]'),null);bindProjectDrop($('rootProjectFolder'),null);
$('upProjectFolder').addEventListener('dragover',event=>{if(!Array.from(event.dataTransfer.types).some(type=>['application/x-labtex-project','application/x-labtex-folder'].includes(type)))return;event.preventDefault();event.dataTransfer.dropEffect='move';$('upProjectFolder').classList.add('folder-drop-target');});
$('upProjectFolder').addEventListener('dragleave',()=>$('upProjectFolder').classList.remove('folder-drop-target'));
$('upProjectFolder').addEventListener('drop',event=>{event.preventDefault();$('upProjectFolder').classList.remove('folder-drop-target');const parent=Home.folders.find(folder=>folder.id===Home.folder)?.parent||null,id=event.dataTransfer.getData('application/x-labtex-folder');if(id)moveExplorerFolder(id,parent).catch(fail);else{const project=Home.projects.find(project=>project.id===event.dataTransfer.getData('application/x-labtex-project'));if(project)moveProjectToFolder(project,parent).catch(fail);}});
action('browseTemplates',templateLibrary);
$('projectSearch').addEventListener('input',renderProjects);
$('projectSort').addEventListener('change',()=>{Home.sort=$('projectSort').value;renderProjects();});
for(const [id,view] of [['projectGridView','grid'],['projectListView','list']])action(id,()=>{Home.view=view;localStorage.setItem('labtex-project-view',view);renderProjects();});
document.querySelectorAll('[data-project-filter]').forEach(button=>button.addEventListener('click',()=>{Home.filter=button.dataset.projectFilter;Home.folder=null;setProjectRoute('#projects');renderProjects();}));
document.addEventListener('keydown',event=>{if(Home.visible&&!$('modal').open&&event.key==='/'&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)){event.preventDefault();$('projectSearch').focus();}});
document.addEventListener('click',event=>{const menu=event.target.closest('.project-actions');closeProjectMenus(menu);});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('modal').open){const menu=document.querySelector('.project-actions[open]');if(menu){closeProjectMenus();menu.querySelector('summary').focus();event.preventDefault();}}});

function updateThemeControls(){
 const theme=window.labtexTheme;
 for(const id of ['themeButton','homeThemeButton','authThemeButton']){
  const next=theme.resolved==='dark'?'light':'dark';
  $(id).title='Switch to '+next+' theme';
  $(id).setAttribute('aria-label',$(id).title);
  $(id).setAttribute('aria-pressed',String(theme.resolved==='dark'));
  $(id).textContent=next==='dark'?'☾':'☼';
 }
 if($('themeResolved'))$('themeResolved').textContent='Currently using the '+theme.resolved+' theme. PDF downloads keep their document colors.';
 document.querySelectorAll('[data-palette-choice]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.paletteChoice===theme.palette)));
 if($('themePreference'))$('themePreference').value=theme.preference;
}
function updatePdfTheme(){
 const dark=localStorage.getItem('labtex-pdf-dark')==='true';
 $('pdfPreview').classList.toggle('pdf-dark',dark);
 $('pdfThemeButton').setAttribute('aria-pressed',String(dark));
 const label=typstProject()?'preview':'PDF';$('pdfThemeButton').setAttribute('aria-label',(dark?'Use original':'Use dark')+' '+label+' colors');$('pdfThemeButton').querySelector('span').textContent='Dark '+label;$('pdfThemeButton').title=(dark?'Use original':'Use dark')+' '+label+' colors. Downloads keep their original colors.';
}
action('pdfThemeButton',()=>{localStorage.setItem('labtex-pdf-dark',String(localStorage.getItem('labtex-pdf-dark')!=='true'));updatePdfTheme();});
window.addEventListener('storage',event=>{if(event.key==='labtex-pdf-dark'||event.key===null)updatePdfTheme();});
updatePdfTheme();
function appearanceDialog(){
 modal('Appearance',`<p class="hint">Choose your workspace colors. The sun/moon button still switches light and dark with one click.</p><div class="palette-choices" role="group" aria-label="Color theme">${window.labtexTheme.palettes.map(palette=>`<button type="button" class="palette-choice" data-palette-choice="${palette.id}" aria-pressed="false"><span class="palette-swatches" aria-hidden="true">${palette.colors.map(color=>`<i style="background:${color}"></i>`).join('')}</span><strong>${esc(palette.name)}</strong><small>${esc(palette.note)}</small></button>`).join('')}</div><label>Light / dark mode<select id="themePreference" aria-label="Light / dark mode"><option value="system">System · follow your device</option><option value="light">Light</option><option value="dark">Dark</option></select></label><p id="themeResolved" class="theme-note"></p><p>The preference is remembered in this browser and applies to your project home, editor, and sign-in screen.</p><div class="actions"><button id="closeAppearance" class="primary">Done</button></div>`);
 $('themePreference').value=window.labtexTheme.preference;
 $('themePreference').addEventListener('change',()=>window.labtexTheme.set($('themePreference').value));
 document.querySelectorAll('[data-palette-choice]').forEach(button=>button.addEventListener('click',()=>window.labtexTheme.setPalette(button.dataset.paletteChoice)));
 action('closeAppearance',closeModal);updateThemeControls();
}
for(const id of ['themeButton','homeThemeButton','authThemeButton'])action(id,()=>window.labtexTheme.set(window.labtexTheme.resolved==='dark'?'light':'dark'));
for(const id of ['authPaletteButton'])action(id,appearanceDialog);
window.addEventListener('labtex-themechange',updateThemeControls);updateThemeControls();
