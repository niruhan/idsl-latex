// Pure project analysis. Expensive regex work runs in a disposable Worker.
export const pointAt=(text,pos)=>{const prefix=text.slice(0,pos),line=prefix.split('\n');return {line:line.length-1,character:line.at(-1).length};};
const readable=text=>text.replace(/\\[A-Za-z]+\*?/g,'').replace(/[#{}\[\]]/g,'').replace(/\s+/g,' ').trim().slice(0,120);
const sourceFile=path=>/\.(?:typ|tex|ltx|sty|cls|bib|bst|bbl|yaml|yml|txt|md|csv|json)$/i.test(path);

// Keep offsets stable while excluding comments, raw code and string literals.
export function maskSource(text,latex=false){
 const output=text.split('');let comment=0,raw=0,string=false,verbatim=null;
 const erase=(start,end)=>{for(let n=start;n<end;n++)if(output[n]!=='\n')output[n]=' ';};
 for(let i=0;i<text.length;){
  const ch=text[i],pair=text.slice(i,i+2);
  if(verbatim){const token='\\end{'+verbatim+'}';if(text.startsWith(token,i)){erase(i,i+token.length);i+=token.length;verbatim=null;}else{erase(i,i+1);i++;}continue;}
  if(latex){
   if(ch==='%'){const end=text.indexOf('\n',i),to=end<0?text.length:end;erase(i,to);i=to;continue;}
   if(ch==='\\'){
    const verb=text.slice(i).match(/^\\verb\*?([^A-Za-z\s])/);if(verb){const end=text.indexOf(verb[1],i+verb[0].length),line=text.indexOf('\n',i),to=end<0||line>=0&&end>line?(line<0?text.length:line):end+1;erase(i,to);i=to;continue;}
    const env=text.slice(i).match(/^\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}/);if(env){verbatim=env[1];erase(i,i+env[0].length);i+=env[0].length;continue;}
    if(!/[A-Za-z]/.test(text[i+1]||'')){erase(i,Math.min(text.length,i+2));i+=2;continue;}
   }
  }else{
   if(comment){if(pair==='/*'){erase(i,i+2);comment++;i+=2;}else if(pair==='*/'){erase(i,i+2);comment--;i+=2;}else{erase(i,i+1);i++;}continue;}
   if(raw){if(ch==='`'){const count=text.slice(i).match(/^`+/)[0].length;erase(i,i+count);if(count===raw)raw=0;i+=count;}else{erase(i,i+1);i++;}continue;}
   if(string){if(ch==='\\'){erase(i,i+2);i+=2;}else{erase(i,i+1);if(ch==='"')string=false;i++;}continue;}
   if(pair==='/*'){comment=1;erase(i,i+2);i+=2;continue;}
   if(pair==='//'&&text[i-1]!==':'){const end=text.indexOf('\n',i),to=end<0?text.length:end;erase(i,to);i=to;continue;}
   if(ch==='`'){raw=text.slice(i).match(/^`+/)[0].length;erase(i,i+raw);i+=raw;continue;}
   if(ch==='"'){string=true;erase(i,i+1);i++;continue;}
   if(ch==='\\'){erase(i,i+2);i+=2;continue;}
  }
  i++;
 }
 return output.join('');
}

function argument(text,pos,open='{',close='}'){
 if(text[pos]!==open)return null;let depth=1;
 for(let i=pos+1;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]===open)depth++;else if(text[i]===close&&!--depth)return {value:text.slice(pos+1,i),end:i+1};}
 return null;
}

export function outlineProject(files){
 const result=[];
 for(const file of files){
  const latex=/\.(?:tex|ltx|sty|cls)$/.test(file.path);if(!latex&&!file.path.endsWith('.typ'))continue;
  const mask=maskSource(file.content,latex),add=(pos,title,level,kind)=>result.push({path:file.path,position:pointAt(file.content,pos),title:readable(title)||kind,level,kind});
  if(latex){
   const levels={part:0,chapter:1,section:2,subsection:3,subsubsection:4,paragraph:5,subparagraph:6};
   for(const match of mask.matchAll(/\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]\n]*\]\s*)?\{/g)){
    const value=argument(file.content,match.index+match[0].length-1);add(match.index,value?.value||match[1],levels[match[1]],match[1]);
   }
   let slide=0;for(const match of mask.matchAll(/\\begin\s*\{frame\}(?:\s*\[[^\]\n]*\])?/g)){
    const following=file.content.slice(match.index+match[0].length),title=following.match(/^\s*\{/),frameEnd=mask.indexOf('\\end{frame}',match.index),inside=file.content.slice(match.index,frameEnd<0?match.index+1000:frameEnd),heading=inside.match(/\\frametitle\s*\{/);
    const label=title?argument(following,title[0].length-1)?.value:heading?argument(inside,heading.index+heading[0].length-1)?.value:'';add(match.index,label||'Slide '+(++slide),3,'slide');
   }
  }else{
   for(const match of mask.matchAll(/^[ \t]*(={1,6})[ \t]+[^\n]+/gm)){const original=file.content.slice(match.index,match.index+match[0].length).replace(/^[ \t]*=+[ \t]+/,'');add(match.index,original,match[1].length-1,'heading');}
   let slide=0;for(const match of mask.matchAll(/#(?:[A-Za-z_][\w-]*\.)?[\w-]*slide\s*[(\[]/g)){
    const following=file.content.slice(match.index,match.index+600),title=following.match(/title\s*:\s*\[([^\]\n]+)\]|^#[\w.-]+\(\s*"([^"\n]+)"|\n\s*=+\s+([^\n]+)/);add(match.index,title?.[1]||title?.[2]||title?.[3]||'Slide '+(++slide),1,'slide');
   }
  }
 }
 return result.sort((a,b)=>a.path.localeCompare(b.path)||a.position.line-b.position.line||a.position.character-b.position.character);
}

function included(path,filter){
 if(!filter?.trim())return sourceFile(path);
 return filter.split(',').some(glob=>{glob=glob.trim();if(!glob)return false;const pattern=glob.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');return new RegExp('^(?:'+pattern+')$','i').test(path)||!glob.includes('/')&&new RegExp('^(?:'+pattern+')$','i').test(path.split('/').at(-1));});
}

export function searchProject(files,options){
 const {query,regex=false,caseSensitive=false,wholeWord=false,filter='',replacement=''}=options;
 if(typeof query!=='string'||!query.length||query.length>2048)throw Error('Enter a search of 1–2048 characters.');
 let pattern=regex?query:query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');if(wholeWord)pattern='\\b(?:'+pattern+')\\b';
 let expression;try{expression=new RegExp(pattern,'gm'+(caseSensitive?'':'i')+'u');}catch{throw Error('Invalid regular expression.');}
 const matches=[],changes=[];let total=0;
 for(const file of files){
  if(!included(file.path,filter))continue;let count=0;
  const lines=file.content.split('\n'),starts=[0];for(let index=0;index<file.content.length;index++)if(file.content[index]==='\n')starts.push(index+1);
  const position=offset=>{let low=0,high=starts.length;while(low+1<high){const mid=(low+high)>>1;if(starts[mid]<=offset)low=mid;else high=mid;}return {line:low,character:offset-starts[low]};};
  for(const match of file.content.matchAll(expression)){
   count++;total++;if(total>100000)throw Error('Too many matches. Narrow the search.');
   if(matches.length<3000){const start=position(match.index),end=position(match.index+match[0].length),line=lines[start.line];matches.push({path:file.path,start,end,excerpt:line.slice(Math.max(0,start.character-45),start.character+130),index:match.index,length:match[0].length});}
  }
  if(count&&options.collectChanges!==false){let replacing=expression;if(Number.isInteger(options.replaceIndex)){replacing=new RegExp(expression.source,expression.flags.replace('g','y'));replacing.lastIndex=options.replaceIndex;}const content=file.content.replace(replacing,regex?replacement:()=>replacement);if(content!==file.content)changes.push({path:file.path,revision:file.revision,content,count});}
 }
 return {matches,total,changes,truncated:total>matches.length};
}

function field(body,name){
 const match=new RegExp('(?:^|,)\\s*'+name+'\\s*=\\s*','i').exec(body);if(!match)return '';
 const start=match.index+match[0].length;
 if(body[start]==='{')return argument(body,start)?.value||'';
 if(body[start]==='"'){let end=start+1;while(end<body.length){if(body[end]==='\\'){end+=2;continue;}if(body[end]==='"')break;end++;}return body.slice(start+1,end);}
 return body.slice(start).split(/[\n,]/)[0].trim();
}

export function bibEntries(file){
 const entries=[];if(!file.path.endsWith('.bib'))return entries;
 const pattern=/@([A-Za-z]+)\s*([{(])/g;let match;
 while((match=pattern.exec(file.content))){
  const begin=match.index+match[0].indexOf(match[2]);let braces=match[2]==='{'?1:0,parens=match[2]==='('?1:0,quote=false,end=begin+1;
  for(;end<file.content.length;end++){const ch=file.content[end];if(ch==='\\'){end++;continue;}if(ch==='"'&&braces===(match[2]==='{'?1:0)){quote=!quote;continue;}if(quote)continue;if(ch==='{')braces++;else if(ch==='}')braces--;else if(!braces&&ch==='(')parens++;else if(!braces&&ch===')')parens--;if(!braces&&!parens){end++;break;}}
  if(braces||parens)continue;pattern.lastIndex=end;
  const lineStart=file.content.lastIndexOf('\n',match.index-1)+1,prefix=file.content.slice(lineStart,match.index);
  if(/^(?:comment|string|preamble)$/i.test(match[1])||/(^|[^\\])(?:\\\\)*%/.test(prefix))continue;
  const value=file.content.slice(begin+1,end-1),comma=value.indexOf(','),key=value.slice(0,comma).trim();if(comma<0||!/^[^\s,{}()]+$/.test(key))continue;
  const body=value.slice(comma+1);
  entries.push({path:file.path,key,type:match[1],title:readable(field(body,'title')),author:readable(field(body,'author')),year:field(body,'year'),doi:field(body,'doi'),start:match.index,end,raw:file.content.slice(match.index,end),position:pointAt(file.content,match.index)});
 }
 return entries;
}

export function bibliographyProject(files){
 const entries=files.flatMap(bibEntries),keys=new Set(entries.map(entry=>entry.key)),labels=new Set(),references=[];
 for(const file of files){
  if(/\.ya?ml$/.test(file.path))for(const match of file.content.matchAll(/^([A-Za-z0-9_][^:\n]*):[ \t]*(?:#.*)?$/gm))keys.add(match[1].trim());
  if(!/\.(?:tex|typ|ltx)$/.test(file.path))continue;const latex=!file.path.endsWith('.typ'),mask=maskSource(file.content,latex);
  for(const match of mask.matchAll(latex?/\\label\s*\{([^}\n]+)\}/g:/<([A-Za-z0-9_][\w:.-]*)>/g))labels.add(match[1]);
  if(latex){for(const match of mask.matchAll(/\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?(?:\s*\[[^\]\n]*\])*\s*\{([^}\n]*)\}/g))for(const key of match[1].split(',').map(key=>key.trim()).filter(key=>key&&key!=='*'))references.push({path:file.path,key,position:pointAt(file.content,match.index),kind:'citation'});}
  else{
   for(const match of mask.matchAll(/(?<![\w@])@([A-Za-z0-9_][\w:.-]*)/g))references.push({path:file.path,key:match[1],position:pointAt(file.content,match.index),kind:'reference or citation'});
   for(const match of mask.matchAll(/#cite\s*\(/g)){const source=file.content.slice(match.index),key=source.match(/^#cite\s*\(\s*(?:<([^>\n]+)>|"([^"\n]+)")/);if(key)references.push({path:file.path,key:key[1]||key[2],position:pointAt(file.content,match.index),kind:'citation'});}
  }
 }
 const missing=references.filter(reference=>!keys.has(reference.key)&&!(reference.kind!=='citation'&&labels.has(reference.key))),counts=new Map();for(const entry of entries)counts.set(entry.key,(counts.get(entry.key)||0)+1);
 return {entries,missing,duplicates:[...counts].filter(([,count])=>count>1).map(([key])=>key)};
}
