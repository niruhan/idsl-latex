/* In-file find works on the active draft, without fetching other project files. */
const $=id=>document.getElementById(id);
export function createSourceSearch(host){
 let split=false,timer,worker,cancel,generation=0,matches=[],total=0,index=-1,captured=null,signature=null,rangesCache=null,navigating=Promise.resolve(),editing=Promise.resolve(),painting=false;
 const footer=$('searchView'),query=$('findQuery'),replacement=$('findReplacement');
 const source=()=>host.source(split)||host.source(false);
 const options=()=>({query:query.value,regex:$('findRegex').checked,caseSensitive:$('findCase').checked,wholeWord:$('findWord').checked,filter:'*',replacement:replacement.value,collectChanges:false});
 const stamp=ctx=>ctx?[ctx.key,ctx.text,query.value,$('findRegex').checked,$('findCase').checked,$('findWord').checked]:null;
 const sameStamp=ctx=>{const next=stamp(ctx);return signature&&next&&next.every((value,index)=>value===signature[index]);};
 function clearHighlights(){rangesCache=null;if(globalThis.CSS?.highlights){CSS.highlights.delete('idsl-find');CSS.highlights.delete('idsl-find-current');}}
 function paint(){
  if(footer.hidden||!captured||!globalThis.CSS?.highlights||!globalThis.Highlight){clearHighlights();return;}
  const ctx=source();if(!ctx||ctx.key!==captured.key||ctx.text!==captured.text){clearHighlights();return;}
  if(!rangesCache||rangesCache.host!==ctx.highlight||rangesCache.first!==ctx.highlight.firstChild||rangesCache.matches!==matches){
   const nodes=[],walker=document.createTreeWalker(ctx.highlight,NodeFilter.SHOW_TEXT);let node,offset=0;while((node=walker.nextNode())){nodes.push({node,start:offset,end:offset+node.length});offset+=node.length;}
   const at=(position,inclusive)=>{let lo=0,hi=nodes.length;while(lo<hi){const mid=(lo+hi)>>1;if(inclusive?nodes[mid].end<position:nodes[mid].end<=position)lo=mid+1;else hi=mid;}return nodes[lo];};
   const ranges=matches.map(match=>{const visible=ctx.visibleRange(match.index,match.index+match.length);if(!visible||visible.start===visible.end)return null;const from=at(visible.start,false),to=at(visible.end,true);if(!from||!to)return null;const range=new Range();range.setStart(from.node,visible.start-from.start);range.setEnd(to.node,visible.end-to.start);return range;});
   rangesCache={host:ctx.highlight,first:ctx.highlight.firstChild,matches,ranges};CSS.highlights.set('idsl-find',new Highlight(...ranges.filter(Boolean)));
  }
  CSS.highlights.delete('idsl-find-current');const range=rangesCache.ranges[index];if(range)CSS.highlights.set('idsl-find-current',new Highlight(range));
 }
 function status(message){$('findCount').textContent=message??(total?(index>=0?index+1+' of ':'')+total:'No results');$('findCount').title=(captured?.path||'Current file')+(total>matches.length?' · first 3,000 results available for navigation':'');$('findNext').disabled=$('findPrevious').disabled=!matches.length;const editable=Boolean(source()?.editable);$('replaceOne').disabled=$('replaceFileAll').disabled=!editable||!matches.length;replacement.readOnly=!editable;}
 function invalidate(){generation++;cancel?.();cancel=null;clearTimeout(timer);matches=[];total=0;index=-1;captured=null;signature=null;clearHighlights();}
 async function scan(extra={}){
  const ctx=source(),settings={...options(),...extra};if(!ctx||!settings.query){invalidate();status(ctx?'':'Open a source file');return null;}
  const ticket=++generation;cancel?.();status('Searching…');
  try{
   const result=await new Promise((resolve,reject)=>{const active=new Worker('/project-worker.js',{type:'module'});worker=active;const finish=(error,result)=>{clearTimeout(deadline);active.terminate();if(worker===active){worker=null;cancel=null;}error?reject(error):resolve(result);},deadline=setTimeout(()=>finish(Error('Search timed out. Simplify the regex.')),4000);cancel=()=>{const error=Error('Superseded');error.name='AbortError';finish(error);};active.onmessage=event=>finish(event.data.error?Error(event.data.error):null,event.data.result);active.onerror=()=>finish(Error('Search failed.'));active.postMessage({operation:'search',files:[{path:ctx.path,content:ctx.text}],options:settings});});
   if(ticket!==generation||footer.hidden||source()?.key!==ctx.key||source()?.text!==ctx.text)return null;
   captured=ctx;signature=stamp(ctx);matches=result.matches;total=result.total;index=matches.findIndex(match=>match.index>=ctx.selection.start);if(index<0&&matches.length)index=0;status();paint();return {ctx,result};
  }catch(error){if(ticket===generation&&error.name!=='AbortError'){matches=[];total=0;index=-1;status(error.message);clearHighlights();}return null;}
 }
 function select(){const match=matches[index],ctx=source();if(!match||!ctx||ctx.key!==captured?.key||ctx.text!==captured.text)return;ctx.select({start:match.index,end:match.index+match.length,direction:'forward'});status();paint();}
 function schedule(){invalidate();if(footer.hidden)return;if(!query.value){status('');return;}timer=setTimeout(async()=>{if(await scan())select();},120);}
 function changed(){if(footer.hidden)return;const ctx=source();if(!sameStamp(ctx))schedule();else if(!painting){painting=true;requestAnimationFrame(()=>{painting=false;paint();});}}
 function close(focus=true){footer.hidden=true;invalidate();if(focus)source()?.area.focus({preventScroll:true});}
 function open(replace=false){
  const active=document.activeElement;if(active?.matches('#code,#splitCode'))split=active.id==='splitCode';const ctx=source(),selected=ctx?.text.slice(ctx.selection.start,ctx.selection.end)||'';
  footer.hidden=false;if(selected&&!selected.includes('\n')&&selected.length<=2048)query.value=selected;(replace?replacement:query).focus();(replace?replacement:query).select();schedule();
 }
 function next(direction=1){navigating=navigating.then(async()=>{clearTimeout(timer);const fresh=!sameStamp(source());if(fresh&&!await scan())return;if(!matches.length)return;if(!fresh)index=(index+direction+matches.length)%matches.length;else if(direction<0)index=matches.length-1;select();}).catch(host.fail);return navigating;}
 async function replace(all=false){
  if(footer.hidden)return;
  clearTimeout(timer);if(!sameStamp(source())&&!await scan())return;if(!source()?.editable||!matches.length)return;
  const position=source().selection,match=matches[index<0?0:index],found=await scan(all?{collectChanges:true}:{replaceIndex:match.index,collectChanges:true});if(!found)return;
  const ctx=source(),change=found.result.changes[0];if(!change){await next();return;}if(ctx?.key!==found.ctx.key||ctx.text!==found.ctx.text)return;
  const inserted=change.content.length-ctx.text.length+(all?0:match.length),start=all?Math.min(position.start,change.content.length):match.index+inserted;ctx.apply(change.content,{start,end:start,direction:'none'});invalidate();if(await scan())select();
 }
 function replaceQueued(all=false){editing=editing.then(()=>replace(all)).catch(host.fail);return editing;}
 $('closeSourceSearch').addEventListener('click',()=>close());$('projectSearchButton').addEventListener('click',()=>open());
 $('fileSearchForm').addEventListener('submit',event=>{event.preventDefault();next();});
 for(const id of ['findQuery','findCase','findWord','findRegex'])$(id).addEventListener('input',schedule);
 $('findPrevious').addEventListener('click',()=>next(-1));$('findNext').addEventListener('click',()=>next());$('replaceOne').addEventListener('click',()=>replaceQueued());$('replaceFileAll').addEventListener('click',()=>replaceQueued(true));
 footer.addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
  if(event.key==='Tab'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&(event.target===query&&!event.shiftKey||event.target===replacement&&event.shiftKey)){event.preventDefault();(event.target===query?replacement:query).focus();return;}
  if(event.altKey&&!event.ctrlKey&&!event.metaKey&&['c','w','r'].includes(event.key.toLowerCase())){event.preventDefault();const control=$({c:'findCase',w:'findWord',r:'findRegex'}[event.key.toLowerCase()]);control.checked=!control.checked;schedule();return;}
  if(event.key==='Enter'){event.preventDefault();event.stopPropagation();if((event.ctrlKey||event.metaKey)&&event.altKey)replaceQueued(true);else if(event.target===replacement)replaceQueued();else next(event.shiftKey?-1:1);}
 });
 document.addEventListener('keydown',event=>{
  if(!host.active()||$('modal').open||event.isComposing||event.defaultPrevented)return;const modifier=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
  if(modifier&&!event.shiftKey&&!event.altKey&&key==='f'){event.preventDefault();open();}
  else if(event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&key==='h'||modifier&&event.altKey&&!event.shiftKey&&key==='f'){event.preventDefault();open(true);}
  else if(event.key==='F3'||modifier&&!event.altKey&&key==='g'){event.preventDefault();if(footer.hidden)open();next(event.shiftKey?-1:1);}
  else if(event.key==='Escape'&&!footer.hidden){event.preventDefault();close();}
 });
 document.querySelector('.editor-pane').addEventListener('focusin',event=>{if(event.target.matches('#code,#splitCode')){split=event.target.id==='splitCode';changed();}});
 const observer=new MutationObserver(changed);for(const id of ['highlight','splitHighlight','filePath'])observer.observe($(id),{subtree:true,childList:true,characterData:true});
 return {open,close,changed};
}
