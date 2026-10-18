/* Editing history regressions using only disposable, fictional project data. */
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN,browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext(),page=await context.newPage(),errors=[],projects=[];page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 async function api(url,method='GET',data){const response=await context.request.fetch(origin+url,{method,headers:{Origin:origin},data});assert.equal(response.ok(),true,await response.text());return response.json();}
 async function value(expected){assert.equal(await page.locator('#code').inputValue(),expected);}
 async function saved(){await page.waitForFunction(()=>document.querySelector('#saveStatus').textContent==='All changes saved');}
 async function caret(start,end=start){await page.locator('#code').evaluate((area,{start,end})=>{area.focus();area.setSelectionRange(start,end);},{start,end});}
 async function open(id){const name=(await api('/api/projects/'+id)).name;await page.goto(origin+'/#project='+id);await page.waitForFunction(name=>!document.querySelector('#workspace').hidden&&!document.querySelector('#workspace').inert&&document.querySelector('#projectTitle').textContent===name,name);}
 try{
  await page.goto(origin);if(await page.locator('#tokenLabel').isVisible()){await page.locator('#nameLabel input').fill('Browser Test Owner');await page.locator('input[name=token]').fill('local-browser-test-only');}await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});
  const initial='= Undo notebook\n\nFirst paragraph.\n\n#let value = 42\n',pid=(await api('/api/projects','POST',{name:'Undo notebook',format:'typst',template:false})).id;projects.push(pid);
  const base='/api/projects/'+pid;
  await api(base+'/file','PUT',{path:'main.typ',content:initial,revision:1});await api(base+'/file','PUT',{path:'other.typ',content:'Other file.\n',revision:0});
  await page.evaluate(id=>localStorage.setItem('labtex-auto:'+id,'false'),pid);await open(pid);const code=page.locator('#code');await caret(initial.length);
  await code.pressSequentially(' hello undo',{delay:15});const typed=initial+' hello undo';await value(typed);await saved();
  await code.press('Control+z');await value(initial);assert.equal(await code.evaluate(area=>area.selectionStart),initial.length);
  await code.press('Control+Shift+z');await value(typed);await code.press('Meta+z');await value(initial);await code.press('Meta+Shift+z');await value(typed);
  await code.press('Control+z');await code.pressSequentially(' new branch');await code.press('Control+y');await value(initial+' new branch');
  await code.press('Control+z');await value(initial);await saved();assert.equal((await api(base+'/file?path=main.typ')).content,initial);
  console.log('PASS Ctrl/Cmd undo and redo, grouped typing, cursor restoration, autosave and redo invalidation');

  const bold=initial;
  await caret(bold.length);await code.press('Tab');await value(bold+'  ');await code.press('Control+z');await value(bold);await code.press('Control+Shift+z');await value(bold+'  ');
  await page.locator('.tree-file[title="other.typ"]').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='other.typ');await caret(0);await code.pressSequentially('Second ');await code.press('Control+z');await value('Other file.\n');
  await page.locator('.tree-file[title="main.typ"]').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='main.typ');await code.press('Control+z');await value(bold);await code.press('Control+z');await value(initial);
  // Editing at another caret position starts another undo step, including deletion.
  await caret(initial.length);await code.pressSequentially(' end');await caret(0);await code.pressSequentially('begin ');await code.press('Control+z');await value(initial+' end');await code.press('Control+z');await value(initial);
  await caret(initial.length);await code.press('Backspace');await code.press('Backspace');await code.press('Control+z');await value(initial);
  console.log('PASS Tab edits, per-file history, cursor moves and grouped deletion');

  // Enter and block indentation use original source positions and one undo step.
  await code.fill('  previous line');await caret((await code.inputValue()).length);await code.press('Enter');await value('  previous line\n  ');await code.press('Control+z');await value('  previous line');
  await code.fill('#block[]');await caret(7);await code.press('Enter');await value('#block[\n  \n]');assert.equal(await code.evaluate(area=>area.selectionStart),10);await code.press('Control+z');await value('#block[]');
  await code.fill('#block[\n  text\n  ]');await caret((await code.inputValue()).length);await code.press('Enter');await value('#block[\n  text\n  ]\n');
  const selected='first\n  second\nlast\n';await code.fill(selected);await caret(0,selected.indexOf('last'));await code.press('Tab');await value('  first\n    second\nlast\n');await code.press('Shift+Tab');await value(selected);await code.press('Control+z');await value('  first\n    second\nlast\n');await code.press('Control+z');await value(selected);
  const hidden='= Hidden\nHidden body.\n= Visible\nVisible body.\n';await code.fill(hidden);await page.locator('.fold-toggle[data-line="1"]').click();await caret(0,(await code.inputValue()).length);await code.press('Tab');await saved();assert.equal((await api(base+'/file?path=main.typ')).content,hidden.split('\n').map((line,index,lines)=>index===lines.length-1?line:'  '+line).join('\n'));await code.press('Control+z');await value(hidden);
  const model=await page.evaluate(async()=>{
   const {indentedNewline,indentLines}=await import('/source-editing.js');const line=(text,language)=>indentedNewline(text,text.length,text.length,language).text;
   return {latexStart:line('  \\begin{itemize}','latex'),latexEnd:line('  \\begin{itemize}\n    \\item Text\n    \\end{itemize}','latex'),comment:line('  text % [','latex'),string:line('#let text = "["','typst'),raw:line('`[`','typst'),tab:line('\tline','typst'),outdent:indentLines('\n  body',0,0,true).text};
  });
  assert.deepEqual(model,{latexStart:'  \\begin{itemize}\n    ',latexEnd:'  \\begin{itemize}\n    \\item Text\n    \\end{itemize}\n  ',comment:'  text % [\n  ',string:'#let text = "["\n',raw:'`[`\n',tab:'\tline\n\t',outdent:'\n  body'});
  const latex=(await api('/api/projects','POST',{name:'Indentation article',template:false})).id;projects.push(latex);await open(latex);await code.fill('\\begin{itemize}');await caret(15);await code.press('Enter');await value('\\begin{itemize}\n  ');await code.press('Control+z');await value('\\begin{itemize}');
  await open(pid);await code.fill(initial);await saved();console.log('PASS smart Enter indentation for LaTeX/Typst blocks, matching closers and paired brackets, Tab/Shift+Tab on selected/folded lines, tabs, comments/raw text and single-step undo');

  for(const id of [pid,latex]){
   await open(id);
   for(const [left,right] of [['(',')'],['[',']'],['{','}'],['"','"'],["'","'"]]){
    await code.fill('');await code.pressSequentially(left);await value(left+right);assert.equal(await code.evaluate(area=>area.selectionStart),1);
    await code.press('Control+z');await value('');await code.press('Control+Shift+z');await value(left+right);
    await code.pressSequentially('example');await code.pressSequentially(right);await value(left+'example'+right);assert.equal(await code.evaluate(area=>area.selectionStart),9);
    // Skipping a closer adds no undo step and Backspace removes an empty pair.
    await code.press('Control+z');await value(left+right);await caret(1);await code.press('Backspace');await value('');await code.press('Control+z');await value(left+right);assert.equal(await code.evaluate(area=>area.selectionStart),1);
    await code.fill('some text');await caret(0,9);await code.pressSequentially(left);await value(left+'some text'+right);assert.deepEqual(await code.evaluate(area=>[area.selectionStart,area.selectionEnd]),[1,10]);await code.press('Control+z');await value('some text');
   }
   await code.fill('');await code.pressSequentially('([{');await value('([{}])');await code.pressSequentially('}])');await value('([{}])');assert.equal(await code.evaluate(area=>area.selectionStart),6);
   await code.fill('');await code.pressSequentially("'don't'");await value("'don't'");assert.equal(await code.evaluate(area=>area.selectionStart),7);
   await code.fill("x''");await caret(2);await code.press('Backspace');await value("x'");
   await code.fill('');await page.keyboard.insertText('[');await code.press('Enter');await value('[\n  \n]');await code.press('Control+z');await value('[]');
   await code.fill('');await code.pressSequentially("Don't change x'' or \\{ \\[ \\( \\\" \\");await value("Don't change x'' or \\{ \\[ \\( \\\" \\");
   await code.fill(id===pid?'// Comment':'% Comment');await caret((await code.inputValue()).length);await code.pressSequentially(' [ "');await value((id===pid?'// Comment':'% Comment')+' [ "');
  }
  await open(pid);await code.fill(hidden);await page.locator('.fold-toggle[data-line="1"]').click();await caret(0,(await code.inputValue()).length);await code.pressSequentially('[');await saved();assert.equal((await api(base+'/file?path=main.typ')).content,'['+hidden+']');await code.press('Control+z');await value(hidden);
  const pairing=await page.evaluate(async()=>{
   const {pairedInput}=await import('/source-editing.js');
   const type=(text,pos,data,language='typst')=>pairedInput(text,pos,pos,'insertText',data,language);
   return {word:type('existing',0,'['),escape:type('\\',1,'['),string:type('"text',5,'['),raw:type('`code',5,'['),blockComment:type('/* comment',10,'['),nestedComment:type('/* one /* two */ ',17,'['),verbatim:type('\\begin{verbatim}\nraw',20,'[','latex'),inlineRaw:type('\\verb|raw',9,'[','latex'),literalBackspace:pairedInput('\\{}',2,2,'deleteContentBackward',null,'latex'),ordinaryBackspace:pairedInput('a',1,1,'deleteContentBackward',null,'typst'),emptyBackspace:pairedInput('',0,0,'deleteContentBackward',null,'latex'),rawBackspace:pairedInput('`[]`',2,2,'deleteContentBackward',null,'typst'),afterRaw:type('`code` ',7,'['),afterComment:type('// comment\n',11,'['),escapedQuote:type('"escaped\\"',9,'"'),prime:type('x\'\'',1,"'",'latex')};
  });
  assert.deepEqual(pairing,{word:null,escape:null,string:null,raw:null,blockComment:null,nestedComment:null,verbatim:null,inlineRaw:null,literalBackspace:null,ordinaryBackspace:null,emptyBackspace:null,rawBackspace:null,afterRaw:{text:'`code` []',start:8,end:8},afterComment:{text:'// comment\n[]',start:12,end:12},escapedQuote:null,prime:null});
  for(const options of [{inputType:'insertFromPaste',data:'['},{inputType:'insertText',data:'[',isComposing:true},{inputType:'insertCompositionText',data:'['},{inputType:'insertText',data:'[',cancelable:false}]){
   await code.fill('');await caret(0);assert.equal(await code.evaluate((area,options)=>area.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,...options})),options),true,'Native paste/composition/non-cancelable input must not be intercepted');
  }
  await code.fill(initial);await saved();console.log('PASS LaTeX/Typst auto-pairs, nested and selected/folded wrapping, skip-over without an undo step, paired Backspace, smart Enter, escapes, prose/primes, comments/raw strings, paste/IME guards and autosave');

  await saved();const current=await api(base+'/file?path=main.typ'),external='= External update\n\nA coauthor changed this.\n';await api(base+'/file','PUT',{path:'main.typ',content:external,revision:current.revision});
  await page.waitForFunction(text=>document.querySelector('#code').value===text,external);await code.press('Control+z');await value(external);
  console.log('PASS coauthor updates reset stale local history');

  assert.equal(await page.locator('#visualTab,.format-toolbar').count(),0);
  assert.deepEqual(errors,[]);
 }finally{for(const id of projects)await api('/api/projects/'+id,'DELETE',{});await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
