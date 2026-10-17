// Lossless block editing: untouched blocks and separators remain byte-for-byte identical.
// Complex macros/environments stay in explicit source blocks, never flattened to HTML.
export const escapeHTML = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function escapeTeX(value){return value.replace(/[\\{}$%&_#^~]/g,c=>({'\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','%':'\\%','&':'\\&','_':'\\_','#':'\\#','^':'\\textasciicircum{}','~':'\\textasciitilde{}'}[c]));}
export function splitBlocks(text){return text.split(/(\n[\t ]*\n+)/);}
function inlineHTML(text){return escapeHTML(text).replace(/\\textbf\{([^{}\\]*)\}/g,'<strong>$1</strong>').replace(/\\(?:emph|textit)\{([^{}\\]*)\}/g,'<em>$1</em>');}
function toTeX(node){
 if(node.nodeType===3)return escapeTeX(node.textContent);
 const text=Array.from(node.childNodes).map(toTeX).join('');
 if(['B','STRONG'].includes(node.nodeName))return '\\textbf{'+text+'}';
 if(['I','EM'].includes(node.nodeName))return '\\emph{'+text+'}';
 if(node.nodeName==='BR')return '\n';
 if(node.nodeName==='DIV'&&node.parentNode?.isContentEditable)return '\n'+text;
 return text;
}
export function renderVisual(container,text,editable,onChange){
 const parts=splitBlocks(text); container.replaceChildren();
 const note=document.createElement('div');note.className='visual-note';note.textContent='Edit paragraphs and headings directly. Equations, environments, and advanced commands remain in source blocks. The PDF shows the final typesetting.';container.append(note);
 let depth=0;
 parts.forEach((original,index)=>{
  if(index%2||!original)return;
  const trimmed=original.trim();
  const heading=/^\\(section|subsection|subsubsection)\*?\{([^{}\\$%&_#^~]*)\}$/.exec(trimmed);
  const plain=trimmed.replace(/\\(?:textbf|textit|emph)\{[^{}\\$%&_#^~]*\}/g,'x');
  const supported=depth===0&&!/[\\{}$%&_#^~]/.test(plain);
  const block=document.createElement('div');block.className='visual-block';
  if(depth===0&&heading){
   const el=document.createElement(heading[1]==='section'?'h2':'h3');el.contentEditable=String(editable);el.textContent=heading[2];el.setAttribute('aria-label',heading[1]+' heading');
   el.addEventListener('input',()=>{const start=original.indexOf(trimmed)+trimmed.indexOf('{')+1;const end=original.indexOf(trimmed)+trimmed.length-1;parts[index]=original.slice(0,start)+escapeTeX(el.textContent)+original.slice(end);onChange(parts.join(''));});
   el.addEventListener('paste',plainPaste);block.append(el);
  }else if(supported){
   const el=document.createElement('div');el.contentEditable=String(editable);el.setAttribute('aria-label','Paragraph');el.innerHTML=inlineHTML(original);
   el.addEventListener('input',()=>{parts[index]=toTeX(el);onChange(parts.join(''));});el.addEventListener('paste',plainPaste);block.append(el);
  }else{
   block.classList.add('raw-block');const label=document.createElement('label');label.textContent='LATEX SOURCE · PRESERVED';const area=document.createElement('textarea');area.value=original;area.readOnly=!editable;area.spellcheck=false;area.rows=Math.min(14,Math.max(2,original.split('\n').length));area.setAttribute('aria-label','LaTeX source block');area.addEventListener('input',()=>{parts[index]=area.value;onChange(parts.join(''));});block.append(label,area);
  }
  const begins=(original.match(/\\begin\{/g)||[]).length,ends=(original.match(/\\end\{/g)||[]).length;
  // Document itself is a container; its plain body remains editable.
  depth=Math.max(0,depth+begins-ends-(original.match(/\\begin\{document\}/g)||[]).length+(original.match(/\\end\{document\}/g)||[]).length);
  container.append(block);
 });
}
function plainPaste(event){event.preventDefault();const text=event.clipboardData.getData('text/plain');const selection=getSelection();if(!selection.rangeCount)return;const range=selection.getRangeAt(0);range.deleteContents();const node=document.createTextNode(text);range.insertNode(node);range.setStartAfter(node);range.collapse(true);selection.removeAllRanges();selection.addRange(range);event.currentTarget.dispatchEvent(new Event('input',{bubbles:true}));}

// Typst expressions stay as source cards. Only a deliberately small markup subset
// is editable, so opening Visual mode never rewrites a template or equation.
export function escapeTypst(value){return value.replace(/[\\#*$@<>[\]{}_`~+=/.-]/g,c=>'\\'+c);}
function typstInline(text){
 let html='',strong=false,emphasis=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='\\'&&i+1<text.length){html+=escapeHTML(text[++i]);continue;}
  if(c==='*'){html+=strong?'</strong>':'<strong>';strong=!strong;continue;}
  if(c==='_'){html+=emphasis?'</em>':'<em>';emphasis=!emphasis;continue;}
  html+=escapeHTML(c);
 }
 return html;
}
function toTypst(node){
 if(node.nodeType===3)return escapeTypst(node.textContent);
 const text=Array.from(node.childNodes).map(toTypst).join('');
 if(['B','STRONG'].includes(node.nodeName))return '*'+text+'*';
 if(['I','EM'].includes(node.nodeName))return '_'+text+'_';
 if(node.nodeName==='BR')return '\n';
 if(node.nodeName==='DIV'&&node.parentNode?.isContentEditable)return '\n'+text;
 return text;
}
export function renderTypstVisual(container,text,editable,onChange){
 const parts=splitBlocks(text);container.replaceChildren();
 const note=document.createElement('div');note.className='visual-note';note.textContent='Edit simple headings, paragraphs, and lists here. Equations, citations, templates, and code stay in source cards. Your compiled PDF shows the final layout.';container.append(note);
 let depth=0,commentDepth=0,rawTicks=0,inMath=false;
 // Track containers across blank lines, including strings and comments, so text
 // inside a function body/content block is never mistaken for top-level prose.
 function scan(source){
  let quoted=false;
  for(let i=0;i<source.length;i++){
   const c=source[i],next=source.slice(i,i+2);
   if(commentDepth){if(next==='/*'){commentDepth++;i++;}else if(next==='*/'){commentDepth--;i++;}continue;}
   if(c==='`'){let count=1;while(source[i+count]==='`')count++;if(!rawTicks)rawTicks=count;else if(count===rawTicks)rawTicks=0;i+=count-1;continue;}
   if(rawTicks)continue;
   if(c==='\\'){i++;continue;}
   if(c==='"'){quoted=!quoted;continue;}
   if(quoted)continue;
   if(next==='//'){const end=source.indexOf('\n',i);if(end<0)break;i=end;continue;}
   if(next==='/*'){commentDepth=1;i++;continue;}
   if(c==='$'){inMath=!inMath;continue;}
   if(inMath)continue;
   if('[{('.includes(c))depth++;
   if(']})'.includes(c))depth=Math.max(0,depth-1);
  }
 }
 function simple(value){
  const plain=value.replace(/\\[\\#*$@<>[\]{}_`~+=/.-]/g,'x').replace(/\*[^*\n]+\*/g,'x').replace(/_[^_\n]+_/g,'x');
  return !/[\\#*$@<>[\]{}_`~]/.test(plain)&&!/^\s*(?:=|[-+]|\/\/|\/\*|\d+[.)])/m.test(plain);
 }
 parts.forEach((original,index)=>{
  if(index%2||!original)return;
  const trimmed=original.trim(),heading=/^(={1,6}) +([^\n]+)$/.exec(trimmed);
  const list=trimmed.split('\n');
  const top=depth===0&&!commentDepth&&!rawTicks&&!inMath;
  const block=document.createElement('div');block.className='visual-block';
  if(top&&heading&&simple(heading[2])){
   const el=document.createElement('h'+Math.min(6,heading[1].length+1));el.contentEditable=String(editable);el.innerHTML=typstInline(heading[2]);el.setAttribute('aria-label','Typst heading');
   el.addEventListener('input',()=>{parts[index]=original.slice(0,original.indexOf(trimmed))+heading[1]+' '+toTypst(el)+original.slice(original.indexOf(trimmed)+trimmed.length);onChange(parts.join(''));});el.addEventListener('paste',plainPaste);block.append(el);
  }else if(top&&list.every(line=>line.startsWith('- ')&&simple(line.slice(2)))){
   const ul=document.createElement('ul');
   list.forEach((line,n)=>{const el=document.createElement('li');el.contentEditable=String(editable);el.innerHTML=typstInline(line.slice(2));el.setAttribute('aria-label','List item');el.addEventListener('input',()=>{list[n]='- '+toTypst(el);parts[index]=list.join('\n');onChange(parts.join(''));});el.addEventListener('paste',plainPaste);ul.append(el);});block.append(ul);
  }else if(top&&simple(trimmed)){
   const el=document.createElement('div');el.contentEditable=String(editable);el.setAttribute('aria-label','Paragraph');el.innerHTML=typstInline(original);el.addEventListener('input',()=>{parts[index]=toTypst(el);onChange(parts.join(''));});el.addEventListener('paste',plainPaste);block.append(el);
  }else{
   block.classList.add('raw-block');const label=document.createElement('label');label.textContent='TYPST SOURCE · PRESERVED';const area=document.createElement('textarea');area.value=original;area.readOnly=!editable;area.spellcheck=false;area.rows=Math.min(16,Math.max(2,original.split('\n').length));area.setAttribute('aria-label','Typst source block');area.addEventListener('input',()=>{parts[index]=area.value;onChange(parts.join(''));});block.append(label,area);
  }
  scan(original);container.append(block);
 });
}
