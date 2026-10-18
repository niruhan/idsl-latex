// Folding is a view of the complete source. Only full source offsets leave this
// module; hiding lines never changes saved source or compiler input.
const startsOf=text=>{const starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);return starts;};
function lineAt(starts,pos){let low=0,high=starts.length;while(low+1<high){const mid=(low+high)>>1;if(starts[mid]<=pos)low=mid;else high=mid;}return low;}
const rangeKey=range=>range.from+':'+range.kind;

export function sourceFoldRanges(text,language){
 const starts=startsOf(text),lines=text.split('\n'),ranges=[],headings=[],stack=[];let line=0;
 const add=(start,end,kind,priority=0)=>{if(end>start)ranges.push({start,end,from:starts[start],kind,priority});};
 const heading=(level,kind)=>headings.push({start:line,level,kind,owner:stack.at(-1)});
 const sectionLevels={part:0,chapter:1,section:2,subsection:3,subsubsection:4,paragraph:5,subparagraph:6};
 if(language==='latex'){
  let verbatim=null;
  for(let i=0;i<text.length;){
   const ch=text[i];if(ch==='\n'){line++;i++;continue;}
   if(verbatim){const end='\\end{'+verbatim.name+'}';if(text.startsWith(end,i)){verbatim.end=line;add(verbatim.start,line,verbatim.name,3);stack.pop();verbatim=null;i+=end.length;}else i++;continue;}
   if(ch==='%'){i=text.indexOf('\n',i);if(i<0)break;continue;}
   if(ch==='\\'){
    const verb=text.slice(i).match(/^\\verb\*?([^A-Za-z\s])/);if(verb){const end=text.indexOf(verb[1],i+verb[0].length),newline=text.indexOf('\n',i);i=end<0||newline>=0&&end>newline?i+verb[0].length:end+1;continue;}
    const env=text.slice(i).match(/^\\(begin|end)\s*\{([^}\n]+)\}/);
    if(env){
     const [,operation,name]=env,endLine=line+(env[0].match(/\n/g)||[]).length;
     if(operation==='begin'){const item={name,start:line};stack.push(item);if(/^(?:verbatim\*?|Verbatim|lstlisting|minted|comment)$/.test(name))verbatim=item;}
     else if(stack.at(-1)?.name===name){const item=stack.pop();item.end=endLine;add(item.start,endLine,name==='frame'?'slide':name,3);}
     line=endLine;i+=env[0].length;continue;
    }
    const section=text.slice(i).match(/^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?=\s*[{[])/);
    if(section){heading(sectionLevels[section[1]],section[1]);i+=section[0].length;continue;}
    if(text.startsWith('\\[',i)){stack.push({name:'display math',start:line});i+=2;continue;}
    if(text.startsWith('\\]',i)&&stack.at(-1)?.name==='display math'){const item=stack.pop();item.end=line;add(item.start,line,item.name,1);i+=2;continue;}
    if(text[i+1]==='\n')line++;i+=Math.min(2,text.length-i);continue; // Escaped braces and percent signs.
   }
   if(ch==='{')stack.push({name:'group',start:line});
   else if(ch==='}'&&stack.at(-1)?.name==='group'){const item=stack.pop();item.end=line;add(item.start,line,'group');}
   i++;
  }
 }else if(language==='typst'){
  // Find indentation once per line; rescanning its prefix at each character
  // makes opening a long indented source line quadratic.
  const headingColumns=lines.map(value=>value.search(/\S/));
  let comment=0,commentStart=0,raw=0,rawStart=0,quote=false,quoteStart=0,math=null,lastCall=null,code=false,statement=false;
  for(let i=0;i<text.length;){
   const ch=text[i],pair=text.slice(i,i+2);
   if(ch==='\n'){line++;if(!quote){code=Boolean(stack.at(-1)?.code);statement=false;}i++;continue;}
   if(comment){if(pair==='/*'){comment++;i+=2;}else if(pair==='*/'){if(!--comment)add(commentStart,line,'comment',2);i+=2;}else i++;continue;}
   if(raw){if(ch==='`'){const size=text.slice(i).match(/^`+/)[0].length;if(size===raw){add(rawStart,line,'raw text',3);raw=0;}i+=size;}else i++;continue;}
   if(quote){if(ch==='\\'){if(text[i+1]==='\n')line++;i+=2;}else{if(ch==='"'){quote=false;add(quoteStart,line,'string',2);}i++;}continue;}
   if(pair==='/*'){comment=1;commentStart=line;i+=2;continue;}
   if(pair==='//'&&text[i-1]!==':'){const end=text.indexOf('\n',i);if(end<0)break;i=end;continue;}
   if(ch==='\\'){if(text[i+1]==='\n')line++;i+=Math.min(2,text.length-i);continue;}
   if(ch==='`'){raw=text.slice(i).match(/^`+/)[0].length;rawStart=line;i+=raw;continue;}
   if(ch==='"'&&(code||math!==null)){quote=true;quoteStart=line;i++;continue;}
   if(ch==='$'){if(math!==null){add(math,line,'equation',2);math=null;}else math=line;i++;continue;}
   if(math!==null){i++;continue;}
   if(ch==='#'){code=true;statement=/^#(?:let|set|show|import|include|context|if|for|while|return)\b/.test(text.slice(i));i++;continue;}
   if(i===starts[line]+headingColumns[line]){const match=text.slice(i).match(/^(=+)[ \t]+(?=\S)/);if(match){heading(match[1].length,'heading');i+=match[0].length;continue;}}
   if('([{'.includes(ch)){
    const prefix=lines[line].trim(),call=ch==='['&&lastCall&&/^\s*$/.test(text.slice(lastCall.close,i))?lastCall:null;
    stack.push({name:ch,start:call?.start??line,kind:call?.kind||(/(?:^|[#.\s])[\w-]*slide\s*[(\[]/.test(prefix)?'slide':ch==='['?'content block':ch==='{'?'code block':'function'),close:0,priorCode:code,code:ch==='['?false:code});code=stack.at(-1).code;lastCall=null;
   }else if(')]}'.includes(ch)&&stack.at(-1)?.name==='([{'.charAt(')]}'.indexOf(ch))){
    const item=stack.pop();item.end=line;item.close=i+1;add(item.start,line,item.kind,item.kind==='slide'?3:0);lastCall=ch===')'?item:null;code=item.priorCode;if(!stack.at(-1)?.code&&!statement)code=false;
   }
   i++;
  }
 }
 // A section ends before the next peer/ancestor heading or its containing block.
 const pending=[];
 const finish=(item,end)=>{end=Math.min(end,(item.owner?.end??lines.length)-1);while(end>item.start&&!lines[end].trim())end--;add(item.start,end,item.kind,5);};
 for(const item of headings){while(pending.length&&pending.at(-1).level>=item.level)finish(pending.pop(),item.start-1);pending.push(item);}
 for(const item of pending)finish(item,lines.length-1);
 // A gutter line has one control: choose the widest meaningful range on it.
 const byLine=new Map();for(const range of ranges){const prior=byLine.get(range.start);if(!prior||range.end>prior.end||range.end===prior.end&&range.priority>prior.priority)byLine.set(range.start,range);}
 return [...byLine.values()].sort((a,b)=>a.start-b.start).map(range=>({...range,hideStart:starts[range.start+1],hideEnd:starts[range.end+1]??text.length}));
}

export function createFoldDocument(text='',language=''){
 let source='',ranges=[],closed=new Set(),starts=[],view={text:'',lines:[],gaps:[]};
 function project(){
  const gaps=[];for(const range of ranges)if(closed.has(rangeKey(range))&&(!gaps.length||range.hideStart>=gaps.at(-1).hideEnd))gaps.push({...range});
  let cursor=0,value='';for(const gap of gaps){value+=source.slice(cursor,gap.hideStart);gap.visible=value.length;cursor=gap.hideEnd;}value+=source.slice(cursor);
  const visibleStarts=startsOf(value),sourceLines=[];let hidden=0,gapIndex=0;
  for(const pos of visibleStarts){while(gapIndex<gaps.length&&gaps[gapIndex].visible<=pos){hidden+=gaps[gapIndex].hideEnd-gaps[gapIndex].hideStart;gapIndex++;}sourceLines.push(lineAt(starts,Math.min(source.length,pos+hidden)));}
  view={text:value,lines:sourceLines,gaps};
 }
 function update(next,lang=language){
  if(next===source&&lang===language&&starts.length)return;
  let from=0,end=source.length,nextEnd=next.length;while(from<end&&from<nextEnd&&source[from]===next[from])from++;while(end>from&&nextEnd>from&&source[end-1]===next[nextEnd-1]){end--;nextEnd--;}
  const delta=nextEnd-end,kept=new Set();
  if(lang===language)for(const range of ranges)if(closed.has(rangeKey(range))){const pos=range.from>=end?range.from+delta:range.from<from?range.from:null;if(pos!==null)kept.add(pos+':'+range.kind);}
  source=next;language=lang;starts=startsOf(source);ranges=sourceFoldRanges(source,language);closed=new Set(ranges.map(rangeKey).filter(key=>kept.has(key)));project();
 }
 function toSource(pos){let full=Math.max(0,Math.min(view.text.length,pos));for(const gap of view.gaps)if(gap.visible<=pos)full+=gap.hideEnd-gap.hideStart;return Math.min(source.length,full);}
 function toVisible(pos){let visible=Math.max(0,Math.min(source.length,pos));for(const gap of view.gaps){if(pos>=gap.hideEnd)visible-=gap.hideEnd-gap.hideStart;else if(pos>=gap.hideStart){visible=gap.visible;break;}}return visible;}
 function reveal(start,end=start,boundary=false){let changed=false;for(const range of ranges)if(closed.has(rangeKey(range))&&((start<range.hideEnd&&end>=range.hideStart)||(boundary&&start===range.hideEnd))){closed.delete(rangeKey(range));changed=true;}if(changed)project();return changed;}
 function toggle(line){const range=ranges.find(item=>item.start===line);if(!range)return null;const key=rangeKey(range);if(closed.has(key))closed.delete(key);else closed.add(key);project();return range;}
 function all(collapse){closed=collapse?new Set(ranges.map(rangeKey)):new Set();project();}
 update(text,language);
 return {update,toSource,toVisible,reveal,toggle,all,isClosed:range=>closed.has(rangeKey(range)),get text(){return source;},get ranges(){return ranges;},get view(){return view;}};
}

export function createSourceFolding({area,gutter,paint,onToggle=()=>{}}){
 const documents=new Map();let current=null,key=null,byLine=new Map(),gutterKey='',prepared=null,paintedView=null;
 const selection=()=>({mode:'source',start:current?.toSource(area.selectionStart)??area.selectionStart,end:current?.toSource(area.selectionEnd)??area.selectionEnd,direction:area.selectionDirection});
 function render(saved=selection()){
  if(!current)return;const top=area.scrollTop,left=area.scrollLeft,value=current.view.text;
  if(area.value!==value)area.value=value;
  const start=current.toVisible(saved.start),end=current.toVisible(saved.end);
  if(area.selectionStart!==start||area.selectionEnd!==end||area.selectionDirection!==saved.direction)area.setSelectionRange(start,end,saved.direction||'none');
  if(paintedView!==current.view){paintedView=current.view;paint(value);byLine=new Map(current.ranges.map(range=>[range.start,range]));gutter.style.width=Math.max(62,30+String((current.view.lines.at(-1)||0)+1).length*7)+'px';gutterKey='';}area.scrollTop=top;area.scrollLeft=left;syncGutter();
 }
 function syncGutter(){
  if(!current)return;const first=Math.max(0,Math.floor(area.scrollTop/23)-8),last=Math.min(current.view.lines.length,first+Math.ceil(area.clientHeight/23)+17),nextKey=first+':'+last;
  if(gutterKey===nextKey){gutter.scrollTop=area.scrollTop;return;}gutterKey=nextKey;
  const content=document.createElement('div');content.className='source-gutter-content';content.style.height=current.view.lines.length*23+'px';
  for(let index=first;index<last;index++){
   const line=current.view.lines[index],row=document.createElement('div');row.className='source-line';row.dataset.line=line+1;row.style.top=index*23+'px';
   const range=byLine.get(line),slot=document.createElement(range?'button':'span');slot.className='fold-toggle';
   if(range){const closed=current.isClosed(range);slot.type='button';slot.textContent=closed?'▸':'▾';slot.dataset.line=line+1;slot.setAttribute('aria-expanded',String(!closed));slot.setAttribute('aria-label',(closed?'Expand ':'Collapse ')+range.kind+' at line '+(line+1));slot.title=(closed?'Expand ':'Collapse ')+range.kind+' · '+(range.end-range.start)+' lines';slot.addEventListener('click',()=>toggle(line));}
   const number=document.createElement('span');number.className='source-line-number';number.textContent=line+1;number.setAttribute('aria-hidden','true');row.append(slot,number);content.append(row);
  }
  gutter.replaceChildren(content);gutter.scrollTop=area.scrollTop;
 }
 function update(nextKey,text,language,saved){
  const same=key===nextKey,prior=saved||(same?selection():{start:0,end:0,direction:'none'});key=nextKey;
  current=documents.get(key);if(!current){current=createFoldDocument(text,language);documents.set(key,current);}else current.update(text,language);
  documents.delete(key);documents.set(key,current);let retained=[...documents.values()].reduce((sum,document)=>sum+document.text.length,0);while(documents.size>1&&(documents.size>8||retained>8*1024*1024)){const oldest=documents.keys().next().value;retained-=documents.get(oldest).text.length;documents.delete(oldest);}
  render(prior);
 }
 function select(saved,{focus=false,reveal=true}={}){if(!current)return;if(reveal)current.reveal(saved.start,saved.end);render(saved);if(focus)area.focus();}
 function toggle(line){const saved=selection(),range=current.toggle(line);if(!range)return;const hidden=position=>position>=range.hideStart&&position<range.hideEnd;if(current.isClosed(range)&&(hidden(saved.start)||hidden(saved.end)))saved.start=saved.end=range.hideStart-1;render(saved);area.focus({preventScroll:true});onToggle();}
 function all(collapse){if(!current)return;const saved=selection();current.all(collapse);if(collapse){saved.start=current.toSource(current.toVisible(saved.start));saved.end=saved.start;}render(saved);area.focus({preventScroll:true});onToggle();}
 function prepareEdit(type){
  if(!current)return;const saved=selection();let start=saved.start,end=saved.end;
  if(type==='deleteContentBackward'&&start===end)start=Math.max(0,start-1);
  if(type==='deleteContentForward'&&start===end)end=Math.min(current.text.length,end+1);
  // Reveal ranges intersected by an edit before the browser changes the text.
  // This prevents Backspace/Delete or replacing a selection from swallowing
  // invisible source at a projection boundary.
  if(current.reveal(start,end,/^delete/.test(type)))render(saved);
  prepared={value:current.view.text,start:area.selectionStart,end:area.selectionEnd};
 }
 function input(){
  if(!current)return {text:area.value,after:selection()};const before=current.view.text,next=area.value,edit=prepared?.value===before?prepared:null;prepared=null;
  // Bound the diff to the actual browser selection. Identical text on either
  // side of a folded range must not move an edit across that hidden range.
  const prefix=edit?Math.min(edit.start,area.selectionStart):Infinity,oldSuffix=edit?edit.end:0,newSuffix=edit?area.selectionEnd:0;
  let start=0,end=before.length,nextEnd=next.length;while(start<end&&start<nextEnd&&start<prefix&&before[start]===next[start])start++;while(end>Math.max(start,oldSuffix)&&nextEnd>Math.max(start,newSuffix)&&before[end-1]===next[nextEnd-1]){end--;nextEnd--;}
  const from=current.toSource(start),to=current.toSource(end),delta=nextEnd-end,fullDelta=(nextEnd-start)-(to-from);
  const position=pos=>pos<=start?current.toSource(pos):pos<=nextEnd?from+pos-start:current.toSource(pos-delta)+fullDelta;
  return {text:current.text.slice(0,from)+next.slice(start,nextEnd)+current.text.slice(to),after:{mode:'source',start:position(area.selectionStart),end:position(area.selectionEnd),direction:area.selectionDirection}};
 }
 function scrollTo(pos){if(!current)return;const visible=current.toVisible(pos),line=area.value.slice(0,visible).split('\n').length-1;area.scrollTop=Math.max(0,(line-3)*23);area.scrollLeft=0;gutter.scrollTop=area.scrollTop;}
 function atCursor(collapse){if(!current)return;const pos=selection().start,candidates=current.ranges.filter(range=>range.from<=pos&&range.hideEnd>=pos&&current.isClosed(range)!==collapse);const range=candidates.at(-1);if(range)toggle(range.start);}
 return {update,selection,select,input,prepareEdit,scrollTo,all,atCursor,syncGutter,visibleRange(start,end){if(!current||current.view.gaps.some(gap=>start<gap.hideEnd&&end>gap.hideStart))return null;return {start:current.toVisible(start),end:current.toVisible(end)};},forget(removed){documents.delete(removed);},get folded(){return Boolean(current?.view.gaps.length);},get visibleLine(){return area.value.slice(0,area.selectionStart).split('\n').length-1;}};
}
