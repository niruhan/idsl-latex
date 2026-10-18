// Local suggestions also work without a language-server connection. Completion
// ranges always refer to the full source, including folded lines.
const texCommands={
 section:'\\section{${1:Title}}',subsection:'\\subsection{${1:Title}}',subsubsection:'\\subsubsection{${1:Title}}',chapter:'\\chapter{${1:Title}}',paragraph:'\\paragraph{${1:Title}}',
 textbf:'\\textbf{${1:text}}',textit:'\\textit{${1:text}}',emph:'\\emph{${1:text}}',texttt:'\\texttt{${1:text}}',underline:'\\underline{${1:text}}',
 frac:'\\frac{${1:numerator}}{${2:denominator}}',sqrt:'\\sqrt{${1:expression}}',sum:'\\sum_{${1:i=1}}^{${2:n}} ${0}',int:'\\int_{${1:a}}^{${2:b}} ${0}',
 label:'\\label{${1:key}}',ref:'\\ref{${1:key}}',eqref:'\\eqref{${1:key}}',cite:'\\cite{${1:key}}',citep:'\\citep{${1:key}}',citet:'\\citet{${1:key}}',
 includegraphics:'\\includegraphics[width=\\linewidth]{${1:image}}',input:'\\input{${1:file}}',include:'\\include{${1:file}}',bibliography:'\\bibliography{${1:references}}',
 usepackage:'\\usepackage{${1:package}}',documentclass:'\\documentclass{${1:article}}',title:'\\title{${1:Title}}',author:'\\author{${1:Author}}',date:'\\date{${1:}}',
 item:'\\item ${0}',begin:'\\begin{${1:environment}}\n  ${0}\n\\end{environment}',end:'\\end{${1:environment}}',href:'\\href{${1:url}}{${2:text}}',url:'\\url{${1:url}}',
 caption:'\\caption{${1:Caption}}',footnote:'\\footnote{${1:text}}',newcommand:'\\newcommand{\\${1:command}}{${2:definition}}',
};
for(const command of ['alpha','beta','gamma','delta','epsilon','varepsilon','theta','lambda','mu','sigma','phi','omega','Gamma','Delta','Theta','Lambda','Sigma','Omega','mathbb','mathcal','mathrm','mathbf','left','right','cdot','times','leq','geq','neq','infty','partial','nabla','quad','qquad','centering','maketitle','tableofcontents','clearpage','newpage','hline','toprule','midrule','bottomrule','linewidth','textwidth'])texCommands[command]='\\'+command;
const environments=['abstract','align','align*','aligned','array','bmatrix','cases','center','description','document','enumerate','equation','equation*','figure','figure*','frame','gather','gather*','itemize','matrix','minipage','pmatrix','proof','table','table*','tabular','theorem','verbatim'];
const typstCommands={let:'let ${1:name} = ${2:value}',set:'set ${1:text}(size: ${2:11pt})',show:'show ${1:heading}: ${2:it => it}',import:'import "${1:file.typ}": ${0}',include:'include "${1:file.typ}"',
 text:'text(${1:body})',align:'align(${1:center})[${2:content}]',block:'block[${1:content}]',grid:'grid(columns: (${1:1fr, 1fr}), [${2:left}], [${3:right}])',
 image:'image("${1:image.png}", width: ${2:100%})',table:'table(columns: ${1:2}, [${2:A}], [${3:B}])',figure:'figure(${1:content}, caption: [${2:Caption}])',
 heading:'heading[${1:Title}]',link:'link("${1:https://example.org}")[${2:text}]',cite:'cite(<${1:key}>)',bibliography:'bibliography("${1:references.bib}")',
 rect:'rect(width: ${1:2cm}, height: ${2:1cm})',circle:'circle(radius: ${1:1cm})',pagebreak:'pagebreak()',linebreak:'linebreak()',strong:'strong[${1:text}]',emph:'emph[${1:text}]'};
const point=(text,pos)=>{const lines=text.slice(0,pos).split('\n');return {line:lines.length-1,character:lines.at(-1).length};};

export function completionContext(path,text,caret,manual=false){
 const before=text.slice(Math.max(0,caret-2048),caret),line=before.slice(before.lastIndexOf('\n')+1);
 if(/\.(tex|sty|cls)$/.test(path)){
  if(/(^|[^\\])(?:\\\\)*%/.test(line))return null;
  let match=before.match(/\\(begin|end)\{([\w*]*)$/);
  if(match)return {kind:'environment',prefix:match[2],start:caret-match[0].length,operation:match[1]};
  match=before.match(/\\(?:cite\w*|(?:eq|auto|page|name|C|c)?ref)\*?(?:\[[^\]\n]*\])*\{([^}\n]*)$/);
  if(match){const prefix=match[1].split(',').at(-1).trimStart();return {kind:/\\cite/.test(match[0])?'citation':'label',prefix,start:caret-prefix.length,closing:'}'};}
  match=before.match(/\\(input|include|includegraphics|bibliography)(?:\[[^\]\n]*\])?\{([^}\n]*)$/);
  if(match)return {kind:'file',prefix:match[2],start:caret-match[2].length,command:match[1],closing:'}'};
  match=before.match(/\\([A-Za-z]*)$/);
  if(match)return {kind:'tex',prefix:match[1],start:caret-match[0].length};
  return manual?{kind:'tex',prefix:'',start:caret}:null;
 }
 if(path.endsWith('.typ')){
  if(line.includes('//')&&!line.includes('://'))return null;
  let match=before.match(/#(?:include|import)\s+"([^"\n]*)$/);
  if(match)return {kind:'file',prefix:match[1],start:caret-match[1].length,command:'typst',closing:'"'};
  match=before.match(/@([\w:.-]*)$/);if(match)return {kind:'citation',prefix:match[1],start:caret-match[1].length};
  match=before.match(/#([\w-]*)$/);if(match)return {kind:'typst',prefix:match[1],start:caret-match[0].length,marker:true};
  match=before.match(/\.([\w-]*)$/);if(match)return {kind:'member',prefix:match[1],start:caret-match[1].length};
  match=before.match(/<([\w-]*)$/);if(match)return {kind:'typst-label',prefix:match[1],start:caret-match[1].length};
  match=before.match(/[\w-]+$/);if(match&&(manual||match[0].length>=2&&/(?:#(?:set|show|let)|[({,])[^\n]*$/.test(line)))return {kind:'typst',prefix:match[0],start:caret-match[0].length};
  return manual?{kind:'typst',prefix:'',start:caret,marker:true}:null;
 }
 return null;
}

export function localCompletions({path,text,caret,files=[],sources=[],manual=false}){
 const context=completionContext(path,text,caret,manual);if(!context)return [];
 let end=caret;
 if(['tex','typst','member','typst-label','environment'].includes(context.kind)&&(context.kind!=='tex'||text[context.start]==='\\'))end+=(text.slice(caret).match(/^[\w*-]*/)?.[0].length||0);
 if(['citation','label'].includes(context.kind))end+=(text.slice(caret).match(/^[^\s,}\n]*/)?.[0].length||0);
 if(context.kind==='file')end+=(text.slice(caret).match(/^[A-Za-z0-9_. ()@+\-/]*/)?.[0].length||0);
 const existingArguments=['{','[','('].includes(text[end]),existingEnvironmentEnd=context.kind==='environment'&&text[end]==='}',closeSuffix=context.closing&&![context.closing,','].includes(text[end])?context.closing:'';
 const candidates=[],add=(label,value=label,snippet=false)=>candidates.push({label,value,snippet}),content=[text.slice(-500000),...sources];
 if(context.kind==='tex'){
  for(const [name,value] of Object.entries(texCommands))add(name,value,true);
  for(const source of content)for(const match of source.matchAll(/\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z]+)/g))add(match[1],'\\'+match[1]);
 }else if(context.kind==='environment'){
  for(const name of environments)add(name,context.operation==='end'?'\\end{'+name+'}':existingEnvironmentEnd?'\\begin{'+name+'}':'\\begin{'+name+'}\n  ${0}\n\\end{'+name+'}',context.operation==='begin'&&!existingEnvironmentEnd);
 }else if(context.kind==='citation'){
  for(const source of content)for(const match of source.matchAll(/@\w+\s*\{\s*([^\s,{}]+)/g))add(match[1],match[1]+closeSuffix);
 }else if(context.kind==='label'){
  for(const source of content)for(const match of source.matchAll(/\\label\s*\{([^}\n]+)\}/g))add(match[1],match[1]+closeSuffix);
 }else if(context.kind==='file'){
  for(const file of files){if(file.path===path)continue;let name=file.path;
   if(context.command==='bibliography'){if(!name.endsWith('.bib'))continue;name=name.slice(0,-4);}
   if(['input','include'].includes(context.command)&&!name.endsWith('.tex'))continue;
   if(context.command==='includegraphics'&&!/\.(pdf|png|jpe?g|svg|eps)$/i.test(name))continue;
   if(context.command==='typst'){
    if(!name.endsWith('.typ'))continue;
    const folder=path.split('/').slice(0,-1),parts=name.split('/');let shared=0;while(shared<folder.length&&folder[shared]===parts[shared])shared++;
    name='../'.repeat(folder.length-shared)+parts.slice(shared).join('/');
   }
   add(name,name+closeSuffix);
  }
 }else if(context.kind==='typst'){
  for(const [name,value] of Object.entries(typstCommands))add(name,(context.marker?'#':'')+value,true);
  for(const source of content)for(const match of source.matchAll(/#let\s+([A-Za-z_][\w-]*)/g))add(match[1],(context.marker?'#':'')+match[1]);
 }
 if(existingEnvironmentEnd)end++;
 const seen=new Set(),prefix=context.prefix.toLowerCase(),range={start:point(text,context.start),end:point(text,end)};
 return candidates.filter(item=>item.label.toLowerCase().startsWith(prefix)&&!seen.has(item.label)&&seen.add(item.label)).slice(0,60).map(item=>{
  const preserveArguments=existingArguments&&['tex','typst'].includes(context.kind),value=preserveArguments?(context.kind==='tex'?'\\':context.marker?'#':'')+item.label+(context.kind==='tex'&&text[end-1]==='*'?'*':''):item.value;
  return {label:item.label,insertTextFormat:item.snippet&&!preserveArguments?2:1,textEdit:{range,newText:value}};
 });
}

export function expandSnippet(value){
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
