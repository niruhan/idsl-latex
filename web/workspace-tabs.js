import {createSourceFolding} from './source-folding.js';
import {createEditHistory} from './edit-history.js';
import {indentLines,indentedNewline,pairedInput} from './source-editing.js';
import {completionContext,localCompletions,expandSnippet} from './completions.js';
const $=id=>document.getElementById(id),textPath=path=>/\.(typ|tex|ltx|sty|cls|bib|txt|md|yaml|yml|json|csv)$/.test(path);

export function createWorkspaceTabs(host){
 const {state,api,save,loadFile,selectSource,sourceSelection,setText,undoEdit,toast,escapeHTML:esc}=host;
 const area=$('splitCode'),gutter=$('splitLineNumbers'),highlight=$('splitHighlight'),pane=$('splitSourcePane'),history=createEditHistory(),positions=new Map();
 let renderedTabs='',splitOptions='',pid=null,tabs=[],buffer=null,timer,maxTimer,flight=null,loading=0,refreshing=false,completionTimer,completionRequest=0,choices=[],choice=0,completion=null;
 const linked=()=>buffer&&buffer.pid===state().project?.id&&buffer.path===state().file?.path;
 const currentText=()=>linked()?state().text:buffer?.text||'';
 const key=()=>`labtex-tabs:${state().user?.id}:${state().project?.id}`;
 const draftKey=()=>`labtex-draft:${state().user?.id}:${buffer?.pid}:${buffer?.path}`;
 const canEdit=()=>state().project?.role!=='viewer';
 const language=()=>buffer?.path.endsWith('.typ')?'typst':'latex';
 const folding=createSourceFolding({area,gutter,paint:text=>{highlight.textContent=text+'\n';syncScroll();},onToggle:()=>{history.breakGroup();closeSuggestions();}});
 function syncScroll(){highlight.scrollTop=area.scrollTop;highlight.scrollLeft=area.scrollLeft;folding.syncGutter();}
 function remember(){try{localStorage.setItem(key(),JSON.stringify({tabs,active:state().file?.path}));}catch{}}
 function beforeRead(){const s=state();if(s.file){const key=s.project.id+':'+s.file.path;positions.delete(key);positions.set(key,{...sourceSelection(),top:$('code').scrollTop,left:$('code').scrollLeft});while(positions.size>80)positions.delete(positions.keys().next().value);if(linked()){buffer={...buffer,text:s.text,saved:s.saved,revision:s.file.revision,dirty:s.dirty};}}}
 function initialPath(project){try{const saved=JSON.parse(localStorage.getItem(`labtex-tabs:${state().user?.id}:${project.id}`));if(project.files.some(file=>file.path===saved?.active))return saved.active;}catch{}return project.main;}
 function opened(){
  const s=state();if(!s.project||!s.file)return;
  if(pid!==s.project.id){pid=s.project.id;buffer=null;pane.hidden=true;$('sourcePanes').classList.remove('has-split');try{tabs=JSON.parse(localStorage.getItem(key()))?.tabs||[];}catch{tabs=[];}if(!Array.isArray(tabs))tabs=[];tabs=tabs.filter(path=>s.project.files.some(file=>file.path===path));}
  if(!tabs.includes(s.file.path))tabs.push(s.file.path);tabs=tabs.slice(-40);
  renderTabs();const prior=positions.get(pid+':'+s.file.path);if(prior&&s.mode==='source'){selectSource(prior,false);$('code').scrollTop=prior.top;$('code').scrollLeft=prior.left;}
  syncProject();changed();remember();
 }
 function renderTabs(){
  const signature=JSON.stringify([pid,tabs,state().file?.path]);if(signature===renderedTabs)return;renderedTabs=signature;const list=$('fileTabs');list.replaceChildren();for(const path of tabs){
   const item=document.createElement('div');item.className='file-tab';item.classList.toggle('active',state().file?.path===path);
   const button=document.createElement('button');button.role='tab';button.title=path;button.setAttribute('aria-selected',String(state().file?.path===path));button.textContent=path.split('/').at(-1);button.addEventListener('click',()=>loadFile(path).catch(host.fail));
   button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const next=tabs[(tabs.indexOf(path)+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];loadFile(next).catch(host.fail);});
   const close=document.createElement('button');close.className='close-file-tab';close.textContent='×';close.setAttribute('aria-label','Close '+path);close.addEventListener('click',()=>closeTab(path).catch(host.fail));item.append(button,close);list.append(item);
  }
  list.querySelector('.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
 }
 async function closeTab(path){
  if(!await save())return;if(buffer?.path===path)await closeSplit();
  if(state().file?.path===path){const next=tabs.find(candidate=>candidate!==path)||state().project.main;if(next===path)return;await loadFile(next);}
  tabs=tabs.filter(candidate=>candidate!==path);renderTabs();remember();
 }
 function changed(){
  if(!buffer||buffer.pid!==state().project?.id)return;
  if(linked()){buffer.text=state().text;buffer.saved=state().saved;buffer.revision=state().file.revision;buffer.dirty=state().dirty;folding.update(pid+':'+buffer.path,buffer.text,language());}
  renderStatus();
 }
 function renderStatus(){const text=linked()?(state().conflict?'Conflict':state().dirty?'Unsaved':'Saved'):buffer?.conflict?'Conflict':buffer?.dirty?'Unsaved':'Saved';$('splitSaveStatus').textContent=text;$('splitSaveStatus').classList.toggle('error',text==='Conflict');}
 function keepDraft(){if(!buffer||linked())return;try{if(buffer.dirty)sessionStorage.setItem(draftKey(),JSON.stringify({content:buffer.text,revision:buffer.revision}));else sessionStorage.removeItem(draftKey());}catch{toast('Browser draft storage is full. Save the split file.');}}
 function scheduleSave(delay=500){clearTimeout(timer);if(!buffer||linked()||!buffer.dirty||buffer.conflict)return;timer=setTimeout(()=>saveSplit().catch(host.fail),delay);if(!maxTimer)maxTimer=setTimeout(()=>saveSplit().catch(host.fail),5000);}
 async function saveSplit(){
  clearTimeout(timer);clearTimeout(maxTimer);timer=maxTimer=null;
  if(flight){await flight;if(buffer?.dirty&&!buffer.conflict&&!linked())return saveSplit();return !buffer?.conflict;}
  if(!buffer||linked()||!buffer.dirty)return true;
  if(buffer.conflict){await resolveConflict();return false;}if(!canEdit())return false;
  const active=buffer,content=active.text;
  flight=(async()=>{try{
   const result=await api('/api/projects/'+active.pid+'/file','PUT',{path:active.path,content,revision:active.revision});
   if(buffer!==active)return true;active.revision=result.revision;active.saved=content;active.dirty=active.text!==content;keepDraft();renderStatus();const file=state().project?.files.find(file=>file.path===active.path);if(file)file.revision=result.revision;host.saved(active.pid);return true;
  }catch(error){keepDraft();if(error.status===409){active.conflict=true;renderStatus();toast('Split file changed on the server. Reopen it to compare and recover your draft.');return false;}scheduleSave(3000);throw error;}finally{flight=null;}})();
  const ok=await flight;if(ok&&buffer===active&&active.dirty)return saveSplit();return ok;
 }
 async function resolveConflict(){
  if(!buffer||!buffer.conflict)return;const active=buffer;let latest;try{latest=await api('/api/projects/'+active.pid+'/file?path='+encodeURIComponent(active.path));}catch(error){if(error.status!==404)throw error;latest={missing:true,content:'[File removed on the server]'};}
  host.modal('Split file conflict',`<p>${esc(active.path)} changed on the server. Your draft is preserved.</p><div class="conflict-grid"><label>Your draft<textarea id="splitLocalConflict" readonly></textarea></label><label>Server version<textarea id="splitServerConflict" readonly></textarea></label></div><div class="actions"><button id="downloadSplitDraft" class="outline">Download draft</button><button id="loadSplitServer" class="primary">Load server version</button></div>`);
  $('splitLocalConflict').value=active.text;$('splitServerConflict').value=latest.content??'[Binary file]';if(latest.missing)$('loadSplitServer').textContent='Download draft and close split';
  $('downloadSplitDraft').addEventListener('click',()=>host.download(active.text,active.path.split('/').at(-1),'text/plain'));
  $('loadSplitServer').addEventListener('click',()=>{if(buffer!==active)return;host.download(active.text,active.path.split('/').at(-1),'text/plain');sessionStorage.removeItem(draftKey());if(latest.missing){buffer=null;pane.hidden=true;$('sourcePanes').classList.remove('has-split');}else{buffer={...active,text:latest.content??'',saved:latest.content??'',revision:latest.revision,dirty:false,conflict:false};history.select(pid+':'+buffer.path,buffer.text);folding.update(pid+':'+buffer.path,buffer.text,language());renderStatus();host.changedFile(buffer.path,buffer.text);}host.closeModal();});
 }
 async function split(path=state().file?.path){
  if(!state().project||!textPath(path||''))throw Error('Choose a text source file for the split editor.');
  if(!await save()){if(buffer)$('splitFileSelect').value=buffer.path;return;}const project=state().project.id,ticket=++loading;
  const file=path===state().file?.path?{...state().file,content:state().text}:await api('/api/projects/'+project+'/file?path='+encodeURIComponent(path));
  if(state().project?.id!==project||ticket!==loading)return;if(file.content===null)throw Error('Choose a text source file.');
  buffer={pid:project,path,text:file.content,saved:file.content,revision:file.revision,dirty:false,conflict:false};
  if(!linked()){let draft;try{draft=JSON.parse(sessionStorage.getItem(draftKey()));}catch{}if(draft&&draft.content!==file.content){buffer.text=draft.content;buffer.dirty=true;buffer.conflict=draft.revision!==file.revision;toast(buffer.conflict?'Recovered a split draft with a server conflict. Use Download draft before loading the server version.':'Recovered the split editor draft.');}}
  history.select(project+':'+path,buffer.text);pane.hidden=false;$('sourcePanes').classList.add('has-split');area.readOnly=!canEdit();folding.update(project+':'+path,buffer.text,language());
  if(!tabs.includes(path))tabs.push(path);syncProject();renderTabs();renderStatus();remember();area.focus();scheduleSave();
 }
 async function closeSplit(){if(!await saveSplit())return false;buffer=null;loading++;pane.hidden=true;$('sourcePanes').classList.remove('has-split');closeSuggestions();return true;}
 async function syncProject(){
  const s=state();if(!s.project||pid!==s.project.id)return;
  tabs=tabs.filter(path=>s.project.files.some(file=>file.path===path));if(s.file&&!tabs.includes(s.file.path))tabs.push(s.file.path);renderTabs();
  const select=$('splitFileSelect'),selected=buffer?.path,files=s.project.files.filter(file=>textPath(file.path)),options=JSON.stringify([pid,files.map(file=>file.path)]);if(options!==splitOptions){splitOptions=options;select.replaceChildren();for(const file of files){const option=document.createElement('option');option.value=file.path;option.textContent=file.path;select.append(option);}}if(selected)select.value=selected;
  if(!buffer)return;if(!s.project.files.some(file=>file.path===buffer.path)){if(buffer.dirty){buffer.conflict=true;renderStatus();toast('The split file was removed. Your browser draft is retained.');}else await closeSplit();return;}
  if(!linked()&&!buffer.dirty&&!flight&&!refreshing&&s.project.files.find(file=>file.path===buffer.path)?.revision!==buffer.revision){
   const active=buffer;refreshing=true;try{const latest=await api('/api/projects/'+active.pid+'/file?path='+encodeURIComponent(active.path));if(buffer===active&&!active.dirty){Object.assign(active,{text:latest.content??'',saved:latest.content??'',revision:latest.revision});history.select(pid+':'+buffer.path,buffer.text);folding.update(pid+':'+buffer.path,buffer.text,language());}}catch(error){host.fail(error);}finally{refreshing=false;}
  }
 }
 function edit(text,before,after,kind='insertText'){
  if(!buffer||!canEdit())return;closeSuggestions();
  if(linked()){const primary=sourceSelection();setText(text,false,{before,after,kind});selectSource(primary,false);folding.update(pid+':'+buffer.path,text,language(),after);}
  else{history.record(buffer.text,text,before,after,kind);buffer.text=text;buffer.dirty=text!==buffer.saved;folding.update(pid+':'+buffer.path,text,language(),after);keepDraft();scheduleSave();renderStatus();host.changedFile(buffer.path,text);}
  clearTimeout(completionTimer);if(after.start===after.end&&completionContext(buffer.path,text,after.start))completionTimer=setTimeout(()=>suggest(),220);
 }
 let pending=null;
 area.addEventListener('beforeinput',event=>{
  if(!canEdit())return;
  if(['historyUndo','historyRedo'].includes(event.inputType)){event.preventDefault();undo(event.inputType==='historyRedo');return;}
  folding.prepareEdit(event.inputType);const before=folding.selection();pending={before,text:currentText(),kind:event.inputType};
  if(!event.isComposing&&event.cancelable){const change=pairedInput(currentText(),before.start,before.end,event.inputType,event.data,language());if(change){event.preventDefault();pending=null;const after={...before,start:change.start,end:change.end};if(change.text===currentText()){folding.select(after);closeSuggestions();history.breakGroup();}else edit(change.text,before,after,'pair');}}
 });
 area.addEventListener('input',()=>{const change=folding.input();edit(change.text,pending?.before||folding.selection(),change.after,pending?.kind||'');pending=null;});
 function undo(redo){if(linked()){const primary=sourceSelection();undoEdit(redo);const restored=sourceSelection();changed();selectSource(primary,false);folding.select(restored,{focus:true});return;}const change=history.step(redo,currentText());if(change){const before=folding.selection();buffer.text=change.text;buffer.dirty=buffer.text!==buffer.saved;folding.update(pid+':'+buffer.path,change.text,language(),change.selection||before);keepDraft();scheduleSave();renderStatus();closeSuggestions();host.changedFile(buffer.path,change.text);}}
 area.addEventListener('keydown',event=>{
  if(event.isComposing)return;const modifier=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
  if(modifier&&event.shiftKey&&['BracketLeft','BracketRight'].includes(event.code)){event.preventDefault();folding.atCursor(event.code==='BracketLeft');return;}
  if(modifier&&!event.altKey&&(key==='z'||event.ctrlKey&&key==='y')){event.preventDefault();undo(key==='y'||event.shiftKey);return;}
  if(modifier&&event.code==='Space'){event.preventDefault();suggest(true);return;}
  if(!$('splitCompletions').hidden&&['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)){event.preventDefault();if(event.key==='Escape')closeSuggestions();else if(['Enter','Tab'].includes(event.key))acceptSuggestion();else{choice=(choice+(event.key==='ArrowDown'?1:choices.length-1))%choices.length;paintSuggestions();}return;}
  if(!modifier&&!event.altKey&&canEdit()&&['Enter','Tab'].includes(event.key)){event.preventDefault();folding.prepareEdit(event.key==='Enter'?'insertLineBreak':'insertText');const before=folding.selection(),change=event.key==='Tab'?indentLines(currentText(),before.start,before.end,event.shiftKey):indentedNewline(currentText(),before.start,before.end,language());edit(change.text,before,{...before,start:change.start,end:change.end},event.key==='Enter'?'newline':'tab');}
  if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)){history.breakGroup();closeSuggestions();}
 });
 for(const type of ['copy','cut'])area.addEventListener(type,event=>{const before=folding.selection();if(!event.clipboardData||before.start===before.end||!folding.folded)return;event.preventDefault();event.clipboardData.setData('text/plain',currentText().slice(before.start,before.end));if(type==='cut'&&canEdit())edit(currentText().slice(0,before.start)+currentText().slice(before.end),before,{...before,end:before.start},'deleteByCut');});
 function closeSuggestions(){completionRequest++;$('splitCompletions').hidden=true;choices=[];completion=null;clearTimeout(completionTimer);}
 async function suggest(manual=false){
  if(!buffer||!canEdit())return;const selection=folding.selection();if(selection.start!==selection.end)return;const ticket=++completionRequest,active=buffer,text=currentText(),caret=selection.start,lines=text.slice(0,caret).split('\n'),context=completionContext(active.path,text,caret,manual);let result;
  try{result=await host.queryFile(active.path,text,{line:lines.length-1,character:lines.at(-1).length});}catch{ /* Keep local completion available during reconnects. */ }
  if(result?.length&&context?.prefix)result=result.filter(item=>item.label.toLowerCase().startsWith(context.prefix.toLowerCase()));
  if(!result?.length){let sources=[];try{sources=await host.sources();}catch{}if(buffer!==active||ticket!==completionRequest||!state().project)return;result=localCompletions({path:active.path,text,caret,files:state().project.files,sources,manual});}
  if(buffer!==active||ticket!==completionRequest||currentText()!==text||folding.selection().start!==caret||document.activeElement!==area)return;choices=result;choice=0;completion={text,caret};paintSuggestions();
 }
 function paintSuggestions(){const popup=$('splitCompletions');popup.hidden=!choices.length;popup.replaceChildren();choices.forEach((item,index)=>{const button=document.createElement('button');button.role='option';button.setAttribute('aria-selected',String(index===choice));button.textContent=item.label;button.addEventListener('pointerdown',event=>{event.preventDefault();choice=index;acceptSuggestion();});popup.append(button);});const line=area.value.slice(0,area.selectionStart).split('\n').length;popup.style.top=Math.max(0,Math.min(area.clientHeight-100,line*23-area.scrollTop+18))+'px';}
 function acceptSuggestion(){
  const item=choices[choice],captured=completion,before=folding.selection();if(!item||!captured||captured.text!==currentText()||before.start!==captured.caret)return;
  const text=currentText(),offset=point=>{const lines=text.split('\n');return lines.slice(0,point?.line||0).reduce((n,line)=>n+line.length+1,0)+(point?.character||0);},range=item.textEdit?.range||item.textEdit?.replace||item.textEdit?.insert,start=range?offset(range.start):captured.caret-(text.slice(0,captured.caret).match(/[\w-]*$/)?.[0].length||0),end=range?offset(range.end):captured.caret,insert=item.textEdit?.newText??item.insertText??item.label,snippet=item.insertTextFormat===2?expandSnippet(insert):{text:insert,selection:{start:insert.length,end:insert.length}},additional=item.additionalTextEdits||[],shift=additional.reduce((sum,change)=>offset(change.range.end)<=start?sum+change.newText.length-(offset(change.range.end)-offset(change.range.start)):sum,0),edits=additional.map(change=>({start:offset(change.range.start),end:offset(change.range.end),text:change.newText}));
  edits.push({start,end,text:snippet.text});edits.sort((a,b)=>b.start-a.start);let value=text;for(const change of edits)value=value.slice(0,change.start)+change.text+value.slice(change.end);
  edit(value,before,{...before,start:start+shift+snippet.selection.start,end:start+shift+snippet.selection.end},'completion');
 }
 area.addEventListener('scroll',()=>{syncScroll();if(!$('splitCompletions').hidden)closeSuggestions();});area.addEventListener('pointerdown',()=>{history.breakGroup();closeSuggestions();});area.addEventListener('compositionstart',closeSuggestions);
 $('splitSourceButton').addEventListener('click',()=>split().catch(host.fail));$('closeSplitSource').addEventListener('click',()=>closeSplit().catch(host.fail));$('splitFileSelect').addEventListener('change',()=>split($('splitFileSelect').value).catch(host.fail));$('splitLayoutButton').addEventListener('click',()=>$('sourcePanes').classList.toggle('split-columns'));
 return {opened,beforeRead,initialPath,changed,split,saveSplit,syncProject,closeSplit,searchState:()=>buffer&&!pane.hidden?{key:buffer.pid+':'+buffer.path+':split',path:buffer.path,text:currentText(),selection:folding.selection(),area,highlight,editable:canEdit(),visibleRange:folding.visibleRange,select:selection=>{folding.select(selection);folding.scrollTo(selection.start);syncScroll();},apply:(text,after)=>edit(text,folding.selection(),after,'replace')}:null,overlays:()=>buffer?[{path:buffer.path,content:currentText()}]:[],reset(){pid=null;buffer=null;renderedTabs=splitOptions='';tabs=[];loading++;clearTimeout(timer);clearTimeout(maxTimer);pane.hidden=true;$('sourcePanes').classList.remove('has-split');closeSuggestions();},get dirty(){return Boolean(buffer?.dirty||flight);}};
}
