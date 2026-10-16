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
