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
 async function open(id){await page.goto(origin+'/#project='+id);await page.locator('#workspace').waitFor({state:'visible'});}
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

  const start=initial.indexOf('First');await caret(start,start+5);await page.locator('[data-insert=bold]').click();const bold=initial.replace('First','*First*');await value(bold);
  await code.press('Control+z');await value(initial);assert.deepEqual(await code.evaluate(area=>[area.selectionStart,area.selectionEnd]),[start,start+5]);await code.press('Control+y');await value(bold);
  await caret(bold.length);await code.press('Tab');await value(bold+'  ');await code.press('Control+z');await value(bold);await code.press('Control+Shift+z');await value(bold+'  ');
  await page.locator('.tree-file[title="other.typ"]').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='other.typ');await caret(0);await code.pressSequentially('Second ');await code.press('Control+z');await value('Other file.\n');
  await page.locator('.tree-file[title="main.typ"]').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='main.typ');await code.press('Control+z');await value(bold);await code.press('Control+z');await value(initial);
  // Editing at another caret position starts another undo step, including deletion.
  await caret(initial.length);await code.pressSequentially(' end');await caret(0);await code.pressSequentially('begin ');await code.press('Control+z');await value(initial+' end');await code.press('Control+z');await value(initial);
  await caret(initial.length);await code.press('Backspace');await code.press('Backspace');await code.press('Control+z');await value(initial);
  console.log('PASS toolbar and Tab edits, selected text, per-file history, cursor moves and grouped deletion');

  await saved();const current=await api(base+'/file?path=main.typ'),external='= External update\n\nA coauthor changed this.\n';await api(base+'/file','PUT',{path:'main.typ',content:external,revision:current.revision});
  await page.waitForFunction(text=>document.querySelector('#code').value===text,external);await code.press('Control+z');await value(external);
  console.log('PASS coauthor updates reset stale local history');

  // Run the same visual editing checks for both document languages.
  for(const format of ['typst','latex']){
   const id=(await api('/api/projects','POST',{name:'Visual undo '+format,format,template:false})).id;projects.push(id);
   const path=format==='typst'?'main.typ':'main.tex',text=format==='typst'?'= Heading\n\nPlain paragraph\n\n#let value = 42':'\\documentclass{article}\n\\begin{document}\n\nPlain paragraph\n\n\\end{document}';
   await api('/api/projects/'+id+'/file','PUT',{path,content:text,revision:1});await page.evaluate(id=>localStorage.setItem('labtex-auto:'+id,'false'),id);await open(id);await page.locator('#visualTab').click();
   let paragraph=page.locator('#visualEditor [contenteditable=true][aria-label=Paragraph]').first();await paragraph.click();await page.keyboard.press('End');await paragraph.pressSequentially(' with history');
   assert.equal(await paragraph.textContent(),'Plain paragraph with history');await page.keyboard.press('Control+z');paragraph=page.locator('#visualEditor [contenteditable=true][aria-label=Paragraph]').first();assert.equal(await paragraph.textContent(),'Plain paragraph');assert.equal(await paragraph.evaluate(el=>el===document.activeElement),true);
   await page.keyboard.press('Control+y');assert.equal(await paragraph.textContent(),'Plain paragraph with history');
   await paragraph.evaluate(el=>{el.focus();const selection=getSelection(),range=document.createRange();range.selectNodeContents(el);selection.removeAllRanges();selection.addRange(range);});await page.locator('[data-insert=bold]').click();assert.equal(await paragraph.locator('b,strong').count(),1);
   await page.keyboard.press('Meta+z');assert.equal(await paragraph.locator('b,strong').count(),0);await page.keyboard.press('Meta+Shift+z');assert.equal(await paragraph.locator('b,strong').count(),1);
   await page.locator('#sourceTab').click();await code.press('Control+z');assert.match(await code.inputValue(),/Plain paragraph with history/);await code.press('Control+z');await value(text);
   await page.locator('#visualTab').click();let raw=page.locator('#visualEditor textarea').first();const rawBefore=await raw.inputValue();await raw.focus();await raw.evaluate(area=>area.setSelectionRange(area.value.length,area.value.length));await raw.pressSequentially(' ');await raw.press('Control+z');raw=page.locator('#visualEditor textarea').first();assert.equal(await raw.inputValue(),rawBefore);assert.deepEqual(await raw.evaluate(area=>[area===document.activeElement,area.selectionStart,area.selectionEnd]),[true,rawBefore.length,rawBefore.length]);await page.keyboard.press('Control+y');assert.equal(await raw.inputValue(),rawBefore+' ');
  }
  console.log('PASS LaTeX/Typst visual paragraphs, formatting, source blocks and history across editor modes');assert.deepEqual(errors,[]);
 }finally{for(const id of projects)await api('/api/projects/'+id,'DELETE',{});await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
