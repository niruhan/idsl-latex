const assert=require('node:assert/strict'),fs=require('node:fs');
const {Worker}=require('node:worker_threads');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {editorOption}=require('./editor_ui.cjs');
(async()=>{
 // Bound the actual parser in a worker so a performance regression fails the
 // test without freezing the browser or the test runner.
 const largeIndentation=await new Promise((resolve,reject)=>{
  const worker=new Worker(`(async()=>{const {parentPort,workerData}=require('node:worker_threads');const {sourceFoldRanges}=await import('data:text/javascript;base64,'+Buffer.from(workerData).toString('base64'));const start=performance.now();const results=[' '.repeat(1024*1024)+'\\n= Heading\\nBody\\n','\\t'.repeat(1024*1024)+'== Indented\\nBody\\n','\\u00a0'.repeat(1024*1024)+'= Unicode indent\\nBody\\n'].map(text=>sourceFoldRanges(text,'typst').map(range=>[range.start+1,range.end+1,range.kind]));parentPort.postMessage({results,elapsedMs:performance.now()-start});})().catch(error=>{throw error});`,{eval:true,workerData:fs.readFileSync(require.resolve('../web/source-folding.js'),'utf8')});
  const timer=setTimeout(()=>{worker.terminate();reject(new Error('Folding three 1MiB indented lines exceeded five seconds'));},5000);
  worker.once('message',result=>{clearTimeout(timer);resolve(result);});worker.once('error',error=>{clearTimeout(timer);reject(error);});
 });
 assert.deepEqual(largeIndentation.results,[[[2,3,'heading']],[[1,2,'heading']],[[1,2,'heading']]]);console.log('PASS bounded large-indentation folding ('+Math.round(largeIndentation.elapsedMs)+'ms)');
 const origin=process.env.TEST_ORIGIN,browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN}),context=await browser.newContext({viewport:{width:1500,height:960}}),page=await context.newPage();page.setDefaultTimeout(20000);
 const errors=[],projects=[];page.on('pageerror',error=>errors.push(error.message));
 async function api(url,method='GET',data){const response=await context.request.fetch(origin+url,{method,headers:{Origin:origin},data});assert.equal(response.ok(),true,await response.text());return response.json();}
 const code=page.locator('#code'),fold=line=>page.locator('button.fold-toggle[data-line="'+line+'"]');
 async function caret(pos,end=pos){await code.evaluate((area,{pos,end})=>{area.focus();area.setSelectionRange(pos,end);},{pos,end});}
 async function saved(){await page.waitForFunction(()=>document.querySelector('#saveStatus').textContent==='All changes saved');}
 async function open(pid){await page.goto(origin+'/#project='+pid);await page.locator('#workspace').waitFor({state:'visible'});}
 try{
  await page.goto(origin);if(await page.locator('#tokenLabel').isVisible()){await page.locator('input[name=name]').fill('Browser Test Owner');await page.locator('input[name=token]').fill('local-browser-test-only');}await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});
  // Lexer/model checks run against the actual browser module, independently of UI.
  const parsed=await page.evaluate(async()=>{
   const {sourceFoldRanges,createFoldDocument}=await import('/source-folding.js');
   const typst='= Section\nIntro\n== Slide\n#slide(\n title: "[ignore]",\n)[\n Body\n #block[\n  nested\n ]\n]\n== Next slide\nEnd\n= Next section\nLast\n',latex='\\begin{document}\n\\section{First}\nText\n\\subsection{Part}\nMore\n\\begin{frame}{Title}\n\\begin{itemize}\n\\item Body\n\\end{itemize}\n\\end{frame}\n\\section{Next}\nLast\n\\end{document}\n';
   const raw='```typ\n= fake heading\n#slide[\n]\n```\n/* outer\n/* nested */\n= fake comment\n*/\n= Real\nBody\n',verbatim='\\begin{verbatim}\n\\section{Fake}\n\\begin{frame}\n\\end{verbatim}\n% \\section{Comment}\n\\section{Real}\nBody\n';
   const summarize=(text,lang)=>sourceFoldRanges(text,lang).map(item=>[item.start+1,item.end+1,item.kind]);
   const doc=createFoldDocument(typst,'typst');doc.toggle(2);const folded=doc.view.text,mapping=doc.toSource(folded.indexOf('== Next slide'));doc.update('// prefix\n'+typst);const rebased=doc.view.text;doc.reveal(doc.text.indexOf('nested'));const revealed=doc.view.text;doc.all(true);doc.all(false);
   const strings='#let words = "first line\n= fake heading\nlast line"\nAn unmatched natural " quote.\n= Real heading\nBody\n';
   return {typst:summarize(typst,'typst'),latex:summarize(latex,'latex'),raw:summarize(raw,'typst'),verbatim:summarize(verbatim,'latex'),strings:summarize(strings,'typst'),emptyHeading:summarize('= \n\n= Real\nBody\n','typst'),splitEnv:summarize('\\begin\n{frame}\nText\n\\end\n{frame}\n','latex'),folded,mapping,expected:typst.indexOf('== Next slide'),rebased,revealed,roundtrip:doc.view.text==='// prefix\n'+typst};
  });
  assert.deepEqual(parsed.typst,[[1,13,'heading'],[3,11,'heading'],[4,11,'slide'],[8,10,'content block'],[12,13,'heading'],[14,15,'heading']]);assert.deepEqual(parsed.latex,[[1,13,'document'],[2,10,'section'],[4,10,'subsection'],[6,10,'slide'],[7,9,'itemize'],[11,12,'section']]);assert.deepEqual(parsed.raw,[[1,5,'raw text'],[6,9,'comment'],[10,11,'heading']]);assert.deepEqual(parsed.verbatim,[[1,4,'verbatim'],[6,7,'section']]);assert.deepEqual(parsed.strings,[[1,3,'string'],[5,6,'heading']]);assert.deepEqual(parsed.emptyHeading,[[3,4,'heading']]);assert.deepEqual(parsed.splitEnv,[[1,5,'slide']]);assert.equal(parsed.mapping,parsed.expected);assert.equal(parsed.folded.includes('nested'),false);assert.equal(parsed.rebased.includes('nested'),false);assert.equal(parsed.revealed.includes('nested'),true);assert.equal(parsed.roundtrip,true);
  const initial='#let slide(body) = block(body)\n= Chapter\nIntroduction.\n== First slide\n#slide[\nHidden Alpha.\n#block[\nNested text.\n]\n]\n== Second slide\nVisible Beta.\n= Next chapter\nTail Gamma.\n',pid=(await api('/api/projects','POST',{name:'Source folding notebook',format:'typst',template:false})).id;projects.push(pid);const base='/api/projects/'+pid;
  await api(base+'/file','PUT',{path:'main.typ',content:initial,revision:1});await api(base+'/file','PUT',{path:'other.typ',content:'= Other file\nIndependent body.\n',revision:0});await open(pid);
  let writes=0;page.on('request',request=>{if(request.url().endsWith(base+'/file')&&request.method()==='PUT')writes++;});
  await fold(4).click();assert.equal(await fold(4).getAttribute('aria-expanded'),'false');assert.equal((await code.inputValue()).includes('Hidden Alpha'),false);assert.ok((await code.inputValue()).includes('Visible Beta'));assert.equal((await api(base+'/file?path=main.typ')).content,initial);assert.equal(writes,0);assert.equal((await page.locator('#lineNumbers').allTextContents()).join('').includes('11'),true);
  await fold(2).click();assert.equal((await code.inputValue()).includes('== First slide'),false);await fold(2).click();assert.equal(await fold(4).getAttribute('aria-expanded'),'false','Nested folding survives expanding its parent');
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/source-folding.png'});
  const projected=await code.inputValue();await caret(projected.indexOf('Tail Gamma'));await code.pressSequentially('Edited ');await saved();const edited=initial.replace('Tail Gamma','Edited Tail Gamma');assert.equal((await api(base+'/file?path=main.typ')).content,edited);assert.equal(await fold(4).getAttribute('aria-expanded'),'false');await code.press('Control+z');await saved();assert.equal((await api(base+'/file?path=main.typ')).content,initial);await code.press('Control+Shift+z');await saved();assert.equal((await api(base+'/file?path=main.typ')).content,edited);await code.press('Control+z');
  // Copy/cut across a folded selection use the full source, and undo restores it.
  await caret(0,(await code.inputValue()).length);const copied=await code.evaluate(area=>{const clipboard=new DataTransfer();area.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:clipboard}));return clipboard.getData('text/plain');});assert.equal(copied,initial);
  await code.evaluate(area=>area.dispatchEvent(new ClipboardEvent('cut',{bubbles:true,cancelable:true,clipboardData:new DataTransfer()})));assert.equal(await code.inputValue(),'');await code.press('Control+z');assert.equal(await code.inputValue(),initial);await saved();
  // Backspace/Delete at a folded boundary reveal the hidden lines before editing.
  await fold(4).click();await caret((await code.inputValue()).indexOf('\n', (await code.inputValue()).indexOf('== First slide')));await code.press('Delete');assert.equal(await code.inputValue(),initial.replace('== First slide\n','== First slide'));await code.press('Control+z');assert.equal(await code.inputValue(),initial);
  await fold(4).click();await caret((await code.inputValue()).indexOf('== Second slide'));await code.press('Backspace');const boundary=initial.indexOf('== Second slide');assert.equal(await code.inputValue(),initial.slice(0,boundary-1)+initial.slice(boundary));await code.press('Control+z');assert.equal(await code.inputValue(),initial);
  // Edits before a folded block move its anchor; changing files remembers the view.
  await fold(4).click();await caret(0);await code.press('Enter');assert.equal(await fold(5).getAttribute('aria-expanded'),'false');assert.equal((await code.inputValue()).includes('Hidden Alpha'),false);await code.press('Control+z');
  await page.locator('.tree-file[title="other.typ"]').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='other.typ');await page.locator('.tree-file[title="main.typ"]').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='main.typ');assert.equal(await fold(4).getAttribute('aria-expanded'),'false');assert.equal((await code.inputValue()).includes('Hidden Alpha'),false);
  await editorOption(page,'unfoldAllSource');assert.equal(await code.inputValue(),initial);await caret(initial.indexOf('Visible Beta'));await code.press('Control+Shift+[');assert.equal((await code.inputValue()).includes('Visible Beta'),false);await code.press('Control+Shift+]');assert.equal(await code.inputValue(),initial);
  await editorOption(page,'foldAllSource');assert.equal((await code.inputValue()).includes('Hidden Alpha'),false);await editorOption(page,'unfoldAllSource');assert.equal(await code.inputValue(),initial);
  console.log('PASS Typst section/slide/content folding, nested state, original line numbers, full-source save/copy/cut, boundary edits, undo/redo, rebased anchors, per-file views and fold shortcuts');
  const latex=String.raw`\documentclass{beamer}
\begin{document}
\section{Overview}
\begin{frame}{First slide}
\begin{itemize}
\item Hidden item.
\end{itemize}
\end{frame}
\subsection{Details}
\begin{frame}{Second slide}
Visible item.
\end{frame}
\section{Conclusion}
\begin{frame}{Last slide}
Final text.
\end{frame}
\end{document}
`,latexId=(await api('/api/projects','POST',{name:'LaTeX folding presentation',template:false})).id;projects.push(latexId);const latexBase='/api/projects/'+latexId;await api(latexBase+'/file','PUT',{path:'main.tex',content:latex,revision:1});await open(latexId);
  await fold(4).click();assert.equal((await code.inputValue()).includes('Hidden item'),false);assert.equal((await code.inputValue()).includes('Visible item'),true);await caret((await code.inputValue()).indexOf('Final text'));await code.press('Tab');await saved();assert.equal((await api(latexBase+'/file?path=main.tex')).content,latex.replace('Final text','  Final text'));await code.press('Control+z');await saved();
  // A coauthor update inside a folded body stays hidden and is retained on expand.
  const current=await api(latexBase+'/file?path=main.tex'),coauthor=latex.replace('Hidden item.','Updated hidden item.');const refreshed=page.waitForResponse(response=>response.url().includes(latexBase+'/file?')&&response.request().method()==='GET');await api(latexBase+'/file','PUT',{path:'main.tex',content:coauthor,revision:current.revision});await refreshed;await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('coauthor'));assert.equal((await code.inputValue()).includes('Updated hidden item'),false);await fold(4).click();assert.equal(await code.inputValue(),coauthor);await code.press('Control+z');assert.equal(await code.inputValue(),coauthor);
  await page.setViewportSize({width:390,height:844});if(await page.locator('#projectFiles').isVisible())await page.locator('#sidebarToggle').click();await fold(4).click();const bounds=await fold(4).boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390);await fold(4).click();assert.equal(await code.inputValue(),coauthor);
  assert.deepEqual(errors,[]);console.log('PASS LaTeX section/subsection, Beamer frames and nested environments, unchanged hidden source during edits/Tab/undo, coauthor updates, lexical exclusions and mobile gutter controls');
 }finally{for(const id of projects)await api('/api/projects/'+id,'DELETE',{}).catch(()=>{});await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
