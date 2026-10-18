// Tinymist language features and persistent preview, using authenticated app routes.
import {completionContext,localCompletions} from './completions.js';
export function createTypstLive({api,state,setText,navigate,toast,sourceSelection,selectSource,visibleLine}){
 const $=id=>document.getElementById(id);
 let session=null,project=null,mainDocument=null,starting=false,generation=0,timer,pollTimer,completionTimer,flight=null,dirty=false,sequence=0,lastJump=0,lastState=null,capabilities=null,closing=Promise.resolve(),lastError='',unavailable='';
 let choices=[],choice=0,completionSource=null,completionRequest=0;const sourceCache=new Map();
 const problems=document.createElement('div');problems.id='typstProblems';problems.className='typst-problems';problems.hidden=true;document.querySelector('.editor-pane').prepend(problems);
 const hover=document.createElement('div');hover.id='typstDocumentation';hover.className='typst-documentation';hover.hidden=true;problems.after(hover);
 const completions=document.createElement('div');completions.id='typstCompletions';completions.className='typst-completions';completions.setAttribute('role','listbox');completions.setAttribute('aria-label','Code suggestions');completions.hidden=true;document.querySelector('.code-area').append(completions);$('code').setAttribute('aria-autocomplete','list');
 const frame=document.createElement('iframe');frame.id='typstFrame';frame.title='Live Typst preview';frame.hidden=true;frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.referrerPolicy='no-referrer';$('pdfPreview').append(frame);
 const empty=document.createElement('div');empty.id='typstEmpty';empty.className='pdf-empty';empty.hidden=true;
 const message=document.createElement('p');message.id='typstPreviewMessage';const reconnect=document.createElement('button');reconnect.id='typstReconnect';reconnect.className='outline';reconnect.textContent='Reconnect live preview';empty.append(message,reconnect);$('pdfPreview').append(empty);
 const active=()=>Boolean(session&&state().project?.id===project);
 const isTypstProject=()=>Boolean(state().project?.main.endsWith('.typ'));
 const endpoint=()=>'/api/projects/'+project+'/typst/'+session;
 const position=()=>{const text=state().text.slice(0,sourceSelection().start),lines=text.split('\n');return {line:lines.length-1,character:lines.at(-1).length};};
 const offset=(text,pos)=>{const lines=text.split('\n'),line=Math.min(Math.max(0,pos?.line||0),lines.length-1);return lines.slice(0,line).reduce((sum,value)=>sum+value.length+1,0)+Math.min(lines[line].length,Math.max(0,pos?.character||0));};
 function languageFile(){return active()&&state().file?.path.endsWith('.typ')&&state().mode==='source';}
 function completionFile(){const current=state();return current.project&&current.project.role!=='viewer'&&/\.(tex|sty|cls|typ)$/.test(current.file?.path||'')&&current.file.content!==null&&current.mode==='source'&&!$('code').readOnly;}
 function controls(){
  const typst=isTypstProject();$('autoCompile').closest('label').hidden=typst;$('openPdfButton').hidden=typst;
  document.querySelector('.preview-title').textContent=typst?'Live preview':'PDF preview';
 }
 function render(){
  controls();if(!isTypstProject()){empty.hidden=true;frame.hidden=true;return false;}
  const running=active()&&!lastError;frame.hidden=!running;empty.hidden=running;$('pdfFrame').hidden=true;$('pdfEmpty').hidden=true;
  // Typst PDF output is never loaded into the preview pane.
  if($('pdfFrame').hasAttribute('src'))$('pdfFrame').removeAttribute('src');
  message.textContent=lastError||unavailable||'Starting live preview…';reconnect.hidden=!lastError;
  const status=lastState?.status;$('buildStatus').textContent=lastError?'Live preview disconnected':unavailable?'Live preview unavailable':status==='CompileError'?'Live preview · source errors':status==='CompileSuccess'?'Live · '+lastState.pages+' '+(lastState.pages===1?'page':'pages'):'Updating live preview…';
  $('buildStatus').className='build-status '+(lastError||status==='CompileError'?'failed':'');
  if(!active()&&state().project.build){const build=state().project.build;$('buildStatus').textContent=build.success?'Compiled in '+build.seconds+'s':'Build failed';$('buildStatus').className='build-status '+(build.success?'':'failed');}
  return true;
 }
 function closeCompletion(){completionRequest++;completions.hidden=true;choices=[];$('code').removeAttribute('aria-activedescendant');$('code').setAttribute('aria-expanded','false');}
 function stop(){
  ++generation;clearTimeout(timer);clearTimeout(pollTimer);clearTimeout(completionTimer);const old=session,oldProject=project;
  session=null;project=null;starting=false;flight=null;dirty=false;lastState=null;lastJump=0;lastError='';unavailable='';sequence=0;sourceCache.clear();
  frame.src='about:blank';frame.hidden=true;hover.hidden=true;problems.hidden=true;closeCompletion();render();
  if(old)closing=fetch('/api/projects/'+oldProject+'/typst/'+old,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}',keepalive:true}).catch(()=>{});
  return closing;
 }
 async function open(){
  const released=stop(),current=state();if(!current.project?.main.endsWith('.typ'))return false;if(current.project.role==='viewer'){unavailable='Live preview requires editor access. You can export an existing PDF from this project.';render();return false;}
  const ticket=generation,pid=current.project.id;starting=true;render();
  try{
   await released;if(ticket!==generation||state().project?.id!==pid)return false;
   capabilities??=api('/api/typst-capabilities');if(!(await capabilities).available){unavailable='Live preview is unavailable in this workspace. Use Export PDF to compile a copy.';render();return false;}
   const result=await api('/api/projects/'+pid+'/typst','POST',{});
   if(ticket!==generation||state().project?.id!==pid){api('/api/projects/'+pid+'/typst/'+result.id,'DELETE',{}).catch(()=>{});return false;}
   project=pid;mainDocument=state().project.main;session=result.id;lastState=result;frame.src=result.preview;frame.hidden=false;starting=false;lastError='';unavailable='';
   render();changed();pollTimer=setTimeout(poll,300);return true;
  }catch(error){if(ticket===generation){lastError=error.message;render();}return false;}
  finally{if(ticket===generation)starting=false;}
 }
 function accept(result){
  lastState=result;const current=state(),items=[];
  for(const [path,diagnostics] of Object.entries(result.diagnostics||{}))for(const diagnostic of diagnostics)items.push({path,...diagnostic});
  problems.replaceChildren();problems.hidden=!items.length;
  for(const item of items.slice(0,5)){const button=document.createElement('button');button.className='typst-diagnostic';button.textContent=item.path+':'+((item.range?.start?.line||0)+1)+' · '+item.message;button.addEventListener('click',()=>navigate(item.path,item.range).catch(error=>toast(error.message)));problems.append(button);}
  if(result.jump&&result.jump.id>lastJump){lastJump=result.jump.id;navigate(result.jump.path,result.jump.range).catch(error=>toast(error.message));}
  if(current.project?.id===project)render();
 }
 async function poll(){
  if(!active())return;const ticket=generation;
  try{const result=await api(endpoint());if(ticket===generation)accept(result);}
  catch(error){if(ticket===generation){if([401,403,404,409,503].includes(error.status)){lastError=error.message;frame.src='about:blank';render();return;}$('buildStatus').textContent=error.message;}}
  if(ticket===generation)pollTimer=setTimeout(poll,600);
 }
 function changed(){
  if(active()&&state().project.main!==mainDocument){open().catch(report);return;}
  controls();closeCompletion();clearTimeout(completionTimer);
  if(completionFile()&&document.activeElement===$('code')&&sourceSelection().start===sourceSelection().end&&completionContext(state().file.path,state().text,sourceSelection().start))completionTimer=setTimeout(()=>complete(false).catch(()=>{}),220);
  if(!active()||state().file?.content===null)return;
  dirty=true;clearTimeout(timer);timer=setTimeout(()=>flush().catch(error=>report(error)),45);
 }
 function report(error){toast(error.message);}
 async function flush(){
  if(flight){await flight;if(dirty)return flush();return;}
  if(!active()||!dirty)return;
  const ticket=generation,pid=project,sid=session;
  flight=(async()=>{
   while(dirty&&ticket===generation){
    dirty=false;const current=state(),path=current.file?.path,text=current.text;if(current.project?.id!==pid||current.file?.content===null||!path)return;
    const result=await api('/api/projects/'+pid+'/typst/'+sid,'POST',{operation:'change',path,content:text,sequence:++sequence});
    if(ticket===generation)accept(result);
   }
  })();
  try{await flight;}finally{if(ticket===generation)flight=null;}
 }
 async function query(method){
  if(!languageFile())return null;const ticket=generation;await flush();if(ticket!==generation||!languageFile())return null;const current=state();
  const path=current.file.path,text=current.text,result=(await api(endpoint(),'POST',{operation:'query',method,path,position:position()})).result;
  return ticket===generation&&state().file?.path===path&&state().text===text?result:null;
 }
 function selectedChoice(){[...completions.children].forEach((button,index)=>{button.setAttribute('aria-selected',String(index===choice));if(index===choice){$('code').setAttribute('aria-activedescendant',button.id);button.scrollIntoView({block:'nearest'});}});}
 async function localSources(context){
  if(!['citation','label','tex','typst'].includes(context?.kind))return [];
  const current=state(),pid=current.project.id,files=current.project.files.filter(file=>file.path!==current.file.path&&/\.(bib|tex|sty|cls|typ)$/.test(file.path)&&file.size<=256000).slice(0,24),result=[];let bytes=0;
  for(let index=0;index<files.length;index+=3){
   if(state().project?.id!==pid)return [];
   const values=await Promise.all(files.slice(index,index+3).map(async file=>{
    const key=pid+':'+file.path+':'+file.revision;
    if(!sourceCache.has(key))sourceCache.set(key,api('/api/projects/'+pid+'/file?path='+encodeURIComponent(file.path)).then(value=>value.content||'').catch(()=>''));
    return sourceCache.get(key);
   }));
   for(const value of values){bytes+=value.length;if(bytes<=1000000)result.push(value);}
   if(bytes>1000000)break;
  }
  while(sourceCache.size>40)sourceCache.delete(sourceCache.keys().next().value);return result;
 }
 async function complete(manual=true){
  if(!completionFile()||sourceSelection().start!==sourceSelection().end)return;const source=state().text,path=state().file.path,caret=sourceSelection().start,pid=state().project.id,ticket=++completionRequest;
  const context=completionContext(path,source,caret,manual);let result=null;
  if(languageFile())try{result=await query('completion');}catch{ /* Local suggestions remain available while reconnecting. */ }
  if(result?.length&&context?.prefix){const prefix=context.prefix.toLowerCase();result=result.filter(item=>item.label.toLowerCase().startsWith(prefix));}
  if(!result?.length)result=localCompletions({path,text:source,caret,files:state().project?.files||[],sources:await localSources(context),manual});
  if(ticket!==completionRequest||state().project?.id!==pid||state().text!==source||state().file?.path!==path||sourceSelection().start!==caret||document.activeElement!==$('code')||!completionFile())return;
  choices=result;choice=0;completionSource={text:source,path,caret};completions.replaceChildren();
  if(!choices.length){if(manual)toast('No completions at this cursor position.');return;}
  for(const [index,item] of choices.entries()){
   const button=document.createElement('button');button.id='typst-completion-'+index;button.setAttribute('role','option');button.textContent=item.label;button.title=item.detail||item.label;
   button.addEventListener('pointerdown',event=>{event.preventDefault();choice=index;applyCompletion();});completions.append(button);
  }
  const area=$('code'),style=getComputedStyle(area),lineHeight=parseFloat(style.lineHeight)||23,caretTop=visibleLine()*lineHeight-area.scrollTop+(parseFloat(style.paddingTop)||15);
  completions.hidden=false;const height=completions.offsetHeight,below=caretTop+lineHeight;
  completions.style.top=Math.max(4,Math.min(area.clientHeight-height-4,below+height<=area.clientHeight?below:caretTop-height))+'px';
  completions.style.left=Math.max(4,Math.min(area.clientWidth-completions.offsetWidth-4,area.offsetLeft+(parseFloat(style.paddingLeft)||20)))+'px';
  $('code').setAttribute('aria-controls',completions.id);$('code').setAttribute('aria-expanded','true');selectedChoice();
 }
 function applyEdits(text,edits){
  const ranges=edits.map(edit=>({start:offset(text,edit.range?.start),end:offset(text,edit.range?.end),text:edit.newText||''})).sort((a,b)=>b.start-a.start);
  for(const edit of ranges)text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);
  return text;
 }
 function expandSnippet(value){
  let text='',stops=[];
  for(let index=0;index<value.length;){
   if(value[index]==='\\'&&/[\\$}]/.test(value[index+1]||'')){text+=value[index+1];index+=2;continue;}
   const simple=value.slice(index).match(/^\$(\d+)/);
   if(simple){stops.push({number:Number(simple[1]),start:text.length,end:text.length});index+=simple[0].length;continue;}
   if(value.slice(index,index+2)==='${'){
    let end=index+2,depth=1;
    for(;end<value.length;end++){if(value[end]==='\\'){end++;continue;}if(value[end]==='{')depth++;if(value[end]==='}'&&!--depth)break;}
    const body=value.slice(index+2,end),match=body.match(/^(\d+)(?::([\s\S]*)|\|([\s\S]*)\|)?$/);
    if(depth===0&&match){const start=text.length,content=match[2]??match[3]?.split(/(?<!\\),/)[0]??'';text+=expandSnippet(content).text;stops.push({number:Number(match[1]),start,end:text.length});index=end+1;continue;}
   }
   text+=value[index++];
  }
  stops.sort((a,b)=>(a.number||Infinity)-(b.number||Infinity));return {text,selection:stops[0]||{start:text.length,end:text.length}};
 }
 function applyCompletion(){
  const item=choices[choice],current=state();if(!item||!completionSource||current.text!==completionSource.text||current.file?.path!==completionSource.path||sourceSelection().start!==completionSource.caret||sourceSelection().end!==completionSource.caret){closeCompletion();return;}
  const original=current.text,edit=item.textEdit,insert=edit?.newText??item.insertText??item.label;
  const expanded=item.insertTextFormat===2?expandSnippet(insert):{text:insert,selection:{start:insert.length,end:insert.length}};
  const before=original.slice(0,completionSource.caret),prefix=before.match(/[\w-]*$/)?.[0]||'';
  const range=edit&&(edit.range||edit.replace||edit.insert),start=range?offset(original,range.start):completionSource.caret-prefix.length,end=range?offset(original,range.end):completionSource.caret;
  const additional=item.additionalTextEdits||[],shift=additional.reduce((sum,change)=>offset(original,change.range.end)<=start?sum+change.newText.length-(offset(original,change.range.end)-offset(original,change.range.start)):sum,0);
  const edits=additional.map(change=>({start:offset(original,change.range.start),end:offset(original,change.range.end),text:change.newText}));
  edits.push({start,end,text:expanded.text});edits.sort((a,b)=>b.start-a.start);let text=original;
  for(const change of edits)text=text.slice(0,change.start)+change.text+text.slice(change.end);
  const after={mode:'source',start:start+shift+expanded.selection.start,end:start+shift+expanded.selection.end};closeCompletion();setText(text,false,{kind:'completion',after});selectSource(after);
 }
 async function documentation(){
  const result=await query('hover'),content=result?.contents;
  const text=typeof content==='string'?content:Array.isArray(content)?content.map(item=>typeof item==='string'?item:item.value||'').join('\n'):content?.value||'';
  hover.replaceChildren();hover.hidden=!text;
  if(text){const close=document.createElement('button');close.className='icon';close.textContent='×';close.setAttribute('aria-label','Close documentation');close.addEventListener('click',()=>hover.hidden=true);const pre=document.createElement('pre');pre.textContent=text.replace(/```[^\n]*\n/g,'').replace(/```/g,'');hover.append(close,pre);}
 }
 async function definition(){const result=await query('definition');if(result?.length)await navigate(result[0].path,result[0].range);else toast('No project definition found at this position.');}
 async function format(){const text=state().text,result=await query('formatting');if(state().text===text&&result?.length)setText(applyEdits(text,result));}
 async function reveal(){if(!languageFile())return;await flush();await api(endpoint(),'POST',{operation:'reveal',path:state().file.path,position:position()});render();}
 reconnect.addEventListener('click',()=>open().catch(report));
 $('code').addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if(completionFile()&&(event.ctrlKey||event.metaKey)&&!event.shiftKey&&event.code==='Space'){event.preventDefault();event.stopImmediatePropagation();complete().catch(report);return;}
  if(completionFile()&&!completions.hidden&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)){
   event.preventDefault();event.stopImmediatePropagation();
   if(event.key==='Escape')closeCompletion();else if(['Enter','Tab'].includes(event.key))applyCompletion();else{choice=(choice+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;selectedChoice();}return;
  }
  if(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Escape'].includes(event.key))closeCompletion();
  if(!languageFile())return;
  if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.code==='Space'){event.preventDefault();event.stopImmediatePropagation();documentation().catch(report);return;}
  if(event.altKey&&event.key==='Enter'){event.preventDefault();reveal().catch(report);return;}
  if(event.key==='F12'){event.preventDefault();definition().catch(report);return;}
  if(event.shiftKey&&event.altKey&&event.key.toLowerCase()==='f'){event.preventDefault();format().catch(report);return;}
 },true);
 $('code').addEventListener('click',()=>{closeCompletion();});
 $('code').addEventListener('scroll',closeCompletion);
 $('code').addEventListener('compositionstart',()=>{clearTimeout(completionTimer);closeCompletion();});
 document.addEventListener('pointerdown',event=>{if(!event.target.closest('#typstCompletions,#typstComplete'))closeCompletion();});
 // Downloads and cancelled navigation can fire beforeunload while this editor
 // stays open. Release the worker only once the page actually leaves.
 window.addEventListener('pagehide',()=>{if(session)navigator.sendBeacon(endpoint(),new Blob([JSON.stringify({operation:'close'})],{type:'application/json'}));});
 window.addEventListener('pageshow',event=>{if(event.persisted&&state().project)open().catch(report);});
 return {open,stop,changed,flush,render,dismissCompletion:closeCompletion,get active(){return active();},get starting(){return starting;}};
}
