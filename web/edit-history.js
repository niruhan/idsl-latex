// In-memory, per-file history. Store changed spans rather than a full document
// for every keystroke; autosave does not create or discard editing steps.
export function createEditHistory(){
 const files=new Map();let active=null,key=null;
 const cost=entry=>entry.edits.reduce((sum,edit)=>sum+edit.removed.length+edit.inserted.length+64,0);
 function trim(){
  // Bound retained text and patches across files to roughly 32 MiB of UTF-16.
  const size=()=>[...files.values()].reduce((sum,file)=>sum+file.text.length+[...file.undo,...file.redo].reduce((n,entry)=>n+cost(entry),0),0);
  while(files.size>8||size()>16*1024*1024){
   if(files.size>1){files.delete(files.keys().next().value);continue;}
   if(active.undo.length>1)active.undo.shift();
   else if(active.redo.length>1)active.redo.shift();
   else break; // Retain at least the most recent operation on the current file.
  }
 }
 function select(next,text){
  key=next;active=files.get(key);
  if(!active||active.text!==text)active={text,undo:[],redo:[],time:0};
  active.time=0;files.delete(key);files.set(key,active);trim();
 }
 function record(before,text,selectionBefore,selectionAfter,kind=''){
  if(!active||active.text!==before)select(key,before);
  if(before===text)return;
  let start=0,end=before.length,nextEnd=text.length;
  while(start<end&&start<nextEnd&&before[start]===text[start])start++;
  while(end>start&&nextEnd>start&&before[end-1]===text[nextEnd-1]){end--;nextEnd--;}
  const edit={start,removed:before.slice(start,end),inserted:text.slice(start,nextEnd)},now=Date.now(),last=active.undo.at(-1);
  const typing=['insertText','deleteContentBackward','deleteContentForward'].includes(kind);
  const group=typing&&last?.kind===kind&&now-active.time<750&&last.edits.length<1000&&JSON.stringify(last.after)===JSON.stringify(selectionBefore);
  if(group){last.edits.push(edit);last.after=selectionAfter;}
  else active.undo.push({edits:[edit],before:selectionBefore,after:selectionAfter,kind});
  active.undo=active.undo.slice(-100);active.redo=[];active.text=text;active.time=now;trim();
 }
 function step(redo,text){
  if(!active||active.text!==text)return null;
  const from=redo?active.redo:active.undo,to=redo?active.undo:active.redo,entry=from.pop();if(!entry)return null;
  for(const edit of redo?entry.edits:[...entry.edits].reverse()){
   const remove=redo?edit.removed:edit.inserted,insert=redo?edit.inserted:edit.removed;
   text=text.slice(0,edit.start)+insert+text.slice(edit.start+remove.length);
  }
  to.push(entry);active.text=text;active.time=0;
  return {text,selection:redo?entry.after:entry.before,start:entry.edits[0].start};
 }
 return {select,record,step,breakGroup(){if(active)active.time=0;}};
}
