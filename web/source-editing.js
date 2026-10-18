const unitFor=indent=>indent.includes('\t')?'\t':'  ';
const indentOf=line=>line.match(/^[ \t]*/)[0];
const startOfLine=(text,pos)=>pos?text.lastIndexOf('\n',pos-1)+1:0;

export function indentLines(text,start,end,outdent=false){
 if(start===end&&!outdent){const unit=unitFor(indentOf(text.slice(startOfLine(text,start))));return {text:text.slice(0,start)+unit+text.slice(end),start:start+unit.length,end:start+unit.length};}
 const first=startOfLine(text,start),last=end>start&&text[end-1]==='\n'?end-1:end,changes=[],unit=unitFor(indentOf(text.slice(first)));
 for(let pos=first;pos<=last;){
  const remove=outdent?(text.slice(pos).match(/^(?:\t| {1,2})/)?.[0].length||0):0;
  if(!outdent||remove)changes.push({pos,remove,insert:outdent?'':unit});
  const next=text.indexOf('\n',pos);if(next<0)break;pos=next+1;
 }
 const map=offset=>{let delta=0;for(const change of changes){if(offset<change.pos)break;if(offset<change.pos+change.remove)return change.pos+delta+change.insert.length;delta+=change.insert.length-change.remove;}return offset+delta;};
 const parts=[];let cursor=0;for(const change of changes){parts.push(text.slice(cursor,change.pos),change.insert);cursor=change.pos+change.remove;}parts.push(text.slice(cursor));const value=parts.join('');
 return {text:value,start:map(start),end:map(end)};
}

// Scan only complete source before the caret, keeping delimiters in comments,
// escaped LaTeX text, strings and raw Typst text out of the block stack.
function blocksBefore(text,language){
 const lines=text.split('\n'),indents=lines.map(indentOf),stack=[];let line=0,comment=0,raw=0,quote=false,lastClose=null,verbatim=null;
 const open=(name,close)=>{stack.push({name,close,indent:indents[line],line});lastClose=null;};
 const close=(name,end)=>{const item=stack.at(-1)?.name===name?stack.pop():null;lastClose={indent:item?.indent??indents[line].replace(/(?:\t| {1,2})$/,''),line,end};};
 for(let i=0;i<text.length;){
  const ch=text[i],pair=text.slice(i,i+2);
  if(ch==='\n'){line++;i++;continue;}
  if(language==='latex'){
   if(verbatim){const token='\\end{'+verbatim+'}';if(text.startsWith(token,i)){close('env:'+verbatim,i+token.length);verbatim=null;i+=token.length;}else i++;continue;}
   if(ch==='%'){const end=text.indexOf('\n',i);if(end<0)break;i=end;continue;}
   if(ch==='\\'){
    const verb=text.slice(i).match(/^\\verb\*?([^A-Za-z\s])/);if(verb){const end=text.indexOf(verb[1],i+verb[0].length),newline=text.indexOf('\n',i);i=end<0||newline>=0&&end>newline?i+verb[0].length:end+1;continue;}
    const env=text.slice(i).match(/^\\(begin|end)\s*\{([^{}\n]{1,80})\}/);
    if(env){if(env[1]==='begin'){open('env:'+env[2],'\\end{'+env[2]+'}');if(/^(?:verbatim\*?|Verbatim|lstlisting|minted|comment)$/.test(env[2]))verbatim=env[2];}else close('env:'+env[2],i+env[0].length);line+=(env[0].match(/\n/g)||[]).length;i+=env[0].length;continue;}
    if(pair==='\\['){open('display','\\]');i+=2;continue;}
    if(pair==='\\]'){close('display',i+2);i+=2;continue;}
    if(text[i+1]==='\n')line++;i+=Math.min(2,text.length-i);continue;
   }
  }else{
   if(comment){if(pair==='/*'){comment++;i+=2;}else if(pair==='*/'){comment--;i+=2;}else i++;continue;}
   if(raw){if(ch==='`'){const count=text.slice(i).match(/^`+/)[0].length;if(count===raw)raw=0;i+=count;}else i++;continue;}
   if(quote){if(ch==='\\'){if(text[i+1]==='\n')line++;i+=2;}else{if(ch==='"')quote=false;i++;}continue;}
   if(pair==='/*'){comment=1;i+=2;continue;}
   if(pair==='//'&&text[i-1]!==':'){const end=text.indexOf('\n',i);if(end<0)break;i=end;continue;}
   if(ch==='`'){raw=text.slice(i).match(/^`+/)[0].length;i+=raw;continue;}
   if(ch==='"'){quote=true;i++;continue;}
   if(ch==='\\'){if(text[i+1]==='\n')line++;i+=Math.min(2,text.length-i);continue;}
  }
  if('([{'.includes(ch))open(ch,')]}'.charAt('([{'.indexOf(ch)));
  else if(')]}'.includes(ch))close('([{'.charAt(')]}'.indexOf(ch)),i+1);
  else if(!/\s/.test(ch))lastClose=null;
  i++;
 }
 return {open:stack.at(-1),closed:lastClose?.line===line?lastClose:null,line};
}

export function indentedNewline(text,start,end,language){
 const prefix=text.slice(0,start),lineStart=prefix.lastIndexOf('\n')+1,base=indentOf(prefix.slice(lineStart)),unit=unitFor(base),context=blocksBefore(prefix,language);
 let indent=base;if(context.open?.line===context.line)indent=context.open.indent+unit;else if(context.closed)indent=context.closed.indent;
 const right=text.slice(end),trimmed=right.replace(/^[ \t]*/,''),paired=context.open&&trimmed.startsWith(context.open.close);
 const inserted='\n'+indent+(paired?'\n'+context.open.indent:'');
 return {text:prefix+inserted+(paired?trimmed:right),start:start+1+indent.length,end:start+1+indent.length};
}
