const {editorOption}=require('./editor_ui.cjs');
/* Native Tinymist end-to-end checks on run_browser.py --live-typst fixtures. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN,output=path.join(process.cwd(),'artifacts');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext({viewport:{width:1500,height:960}}),page=await context.newPage();page.setDefaultTimeout(20000);
 const errors=[],consoleErrors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
 async function api(url,method='GET',data){const response=await context.request.fetch(origin+url,{method,headers:{Origin:origin},data});assert.equal(response.ok(),true,await response.text());return response.json();}
 let pid;
 try{
  await page.goto(origin);await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});
  assert.equal((await api('/api/typst-capabilities')).available,true);
  pid=(await api('/api/projects','POST',{name:'Live research notebook',format:'typst',template:false})).id;
  const base='/api/projects/'+pid,source='= Live research notebook\n\n#let answer = 42\n\nThe answer is #answer.\n';
  await api(base+'/file','PUT',{path:'main.typ',content:source,revision:1});
  let pdfBuilds=0;const sessions=[];page.on('request',request=>{if(request.url().endsWith(base+'/compile'))pdfBuilds++;});page.on('response',async response=>{if(response.url().endsWith(base+'/typst')&&response.request().method()==='POST'&&response.ok())sessions.push((await response.json()).id);});
  await page.goto(origin+'/#project='+pid);await page.locator('#typstFrame').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Live ·'));
  const frame=page.frameLocator('#typstFrame');
  try{await frame.locator('#typst-app svg').first().waitFor({state:'visible'});}catch(error){console.error('Preview browser errors:',errors,consoleErrors);await page.screenshot({path:path.join(output,'tinymist-failure.png'),fullPage:true});throw error;}
  assert.equal(pdfBuilds,0,'Live preview must not launch repeated CLI PDF builds');assert.equal(sessions.length,1);
  await page.locator('#accountButton').click();await page.locator('#accountDropdown').waitFor({state:'visible'});
  await frame.locator('.typst-text').first().click({position:{x:3,y:3}});
  await page.locator('#accountDropdown').waitFor({state:'hidden'});assert.equal(await page.locator('#accountButton').getAttribute('aria-expanded'),'false');
  await page.waitForFunction(()=>document.activeElement.id==='code');
  const iframe=await page.locator('#typstFrame').elementHandle(),initialSrc=await page.locator('#typstFrame').getAttribute('src'),initialSvg=await frame.locator('#typst-app').innerHTML();
  await page.locator('#sidebarToggle').click();assert.equal(await page.locator('#projectFiles').isHidden(),true);await frame.locator('#typst-app svg').first().waitFor({state:'visible'});assert.equal(await iframe.evaluate(el=>el===document.getElementById('typstFrame')),true);assert.equal(await page.locator('#code').inputValue(),source);
  await page.locator('#code').press('Control+b');assert.equal(await page.locator('#projectFiles').isVisible(),true);assert.equal(await page.locator('#typstFrame').getAttribute('src'),initialSrc);assert.equal(sessions.length,1,'Toggling the file explorer must preserve the live compiler session');
  await page.locator('#code').fill(source.replace('42','84'));await page.locator('#code').evaluate(area=>{const index=area.value.lastIndexOf('answer')+2;area.setSelectionRange(index,index);});await page.locator('#code').press('Control+Shift+Space');
  await page.locator('#typstDocumentation').getByText(/84/).waitFor();
  await page.waitForFunction(previous=>document.querySelector('#typstFrame').contentDocument.querySelector('#typst-app').innerHTML!==previous,initialSvg);
  const editedSvg=await frame.locator('#typst-app').innerHTML();await page.locator('#code').press('Control+z');assert.equal(await page.locator('#code').inputValue(),source);
  await page.waitForFunction(previous=>document.querySelector('#typstFrame').contentDocument.querySelector('#typst-app').innerHTML!==previous,editedSvg);
  await page.locator('#code').press('Meta+Shift+z');assert.equal(await page.locator('#code').inputValue(),source.replace('42','84'));
  await page.locator('#code').evaluate(area=>{const index=area.value.lastIndexOf('answer')+2;area.setSelectionRange(index,index);});
  await page.locator('#code').press('F12');await page.waitForFunction(()=>document.querySelector('#code').selectionStart===document.querySelector('#code').value.indexOf('answer'));
  await page.locator('#code').fill('#let greeting = [Hello]\n#gree');await page.locator('#code').press('Control+Space');await page.locator('#typstCompletions [role=option]').filter({hasText:'greeting'}).first().dispatchEvent('pointerdown');assert.match(await page.locator('#code').inputValue(),/#greeting/);
  const completed=await page.locator('#code').inputValue();await page.locator('#code').press('Control+z');assert.equal(await page.locator('#code').inputValue(),'#let greeting = [Hello]\n#gree');await page.locator('#code').press('Control+y');assert.equal(await page.locator('#code').inputValue(),completed);
  await page.locator('#code').fill('#rec');await page.locator('#code').press('Control+Space');await page.locator('#typstCompletions [role=option]').filter({hasText:/^rect/}).first().dispatchEvent('pointerdown');assert.match(await page.locator('#code').inputValue(),/#rect/);assert.doesNotMatch(await page.locator('#code').inputValue(),/\$(?:\d|\{)/,'Completion snippets must insert usable Typst, without LSP placeholder markers');
  await page.locator('#code').fill('#not-a-real-function(');await page.locator('#typstProblems .typst-diagnostic').first().waitFor();
  assert.equal(await frame.locator('#typst-app svg').count()>0,true,'Syntax errors retain the previous rendered document');
  const unformatted='#let answer=84\n\nThe answer is #answer.\n';await page.locator('#code').fill(unformatted);await page.locator('#code').press('Alt+Shift+f');await page.waitForFunction(before=>document.querySelector('#code').value!==before,unformatted);
  const formatted=await page.locator('#code').inputValue();await page.locator('#code').press('Control+z');assert.equal(await page.locator('#code').inputValue(),unformatted);await page.locator('#code').press('Control+Shift+z');assert.equal(await page.locator('#code').inputValue(),formatted);
  await page.locator('#code').fill(source.replace('42','84'));await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Live ·'));
  assert.equal(await page.locator('#typstFrame').getAttribute('src'),initialSrc);assert.equal(await iframe.evaluate(element=>element===document.getElementById('typstFrame')),true);assert.equal(sessions.length,1);assert.equal(pdfBuilds,0);
  await page.locator('#code').press('Alt+Shift+f');await page.locator('#code').press('Alt+Enter');
  await page.locator('#code').evaluate(area=>area.setSelectionRange(area.value.length,area.value.length));await frame.locator('.typst-text').first().click({position:{x:3,y:3}});
  await page.waitForFunction(()=>document.querySelector('#code').selectionStart<=document.querySelector('#code').value.indexOf('\n'));
  await editorOption(page,'pdfThemeButton');assert.equal(await page.locator('#pdfPreview').evaluate(element=>element.classList.contains('pdf-dark')),true);await editorOption(page,'pdfThemeButton');
  await page.locator('#typstDocumentation .icon').click().catch(()=>{});await page.locator('#toast').waitFor({state:'hidden'});await frame.locator('.typst-debug-react-ripple').waitFor({state:'detached'});await page.screenshot({path:path.join(output,'tinymist-live.png'),fullPage:true});
  console.log('PASS real Tinymist incremental preview without iframe reload/PDF builds, LSP completion/hover/definition/formatting, undo/redo with live preview, diagnostics, recovery, source reveal and dark preview');

  const download=page.waitForEvent('download');await page.locator('#downloadButton').click();const pdf=await download;assert.equal(pdf.suggestedFilename(),'Live research notebook.pdf');const pdfPath=path.join(output,'tinymist-export.pdf');await pdf.saveAs(pdfPath);assert.equal(fs.readFileSync(pdfPath).subarray(0,4).toString(),'%PDF');assert.equal(pdfBuilds,1);
  const endpoint=base+'/typst/'+sessions[0];
  const afterDownload=await page.waitForResponse(response=>response.url().endsWith(endpoint)&&response.request().method()==='GET');
  assert.equal(afterDownload.status(),200,'Export PDF must keep the live compiler session running');
  assert.equal(await page.locator('#typstFrame').getAttribute('src'),initialSrc);await frame.locator('#typst-app svg').first().waitFor({state:'visible'});
  const exportedSvg=await frame.locator('#typst-app').innerHTML();await page.locator('#code').fill(source.replace('42','126'));await page.locator('#code').evaluate(area=>{const index=area.value.lastIndexOf('answer')+2;area.setSelectionRange(index,index);});await page.locator('#code').press('Control+Shift+Space');await page.locator('#typstDocumentation').getByText(/126/).waitFor();
  await page.waitForFunction(previous=>document.querySelector('#typstFrame').contentDocument.querySelector('#typst-app').innerHTML!==previous,exportedSvg);
  const zipDownload=page.waitForEvent('download');await editorOption(page,'exportSourceButton');const zip=await zipDownload;assert.equal(zip.suggestedFilename(),'Live research notebook.zip');
  const afterZip=await page.waitForResponse(response=>response.url().endsWith(endpoint)&&response.request().method()==='GET');assert.equal(afterZip.status(),200,'Source ZIP export must keep the live session running');assert.equal(sessions.length,1,'Exports must preserve the existing worker, not reconnect it');
  await frame.locator('#typst-app svg').first().waitFor({state:'visible'});console.log('PASS PDF/source downloads preserve the live session, visible preview, subsequent edits and LSP');
  // A leave warning that the user cancels must preserve the compiler as well.
  await page.locator('#code').fill(source.replace('42','168'));
  page.once('dialog',dialog=>{assert.equal(dialog.type(),'beforeunload');dialog.dismiss();});
  await assert.rejects(page.goto(origin+'/'),/ERR_ABORTED/);assert.equal(new URL(page.url()).hash,'#project='+pid);
  const afterCancelledLeave=await page.waitForResponse(response=>response.url().endsWith(endpoint)&&response.request().method()==='GET');assert.equal(afterCancelledLeave.status(),200);assert.equal(sessions.length,1);await frame.locator('#typst-app svg').first().waitFor({state:'visible'});
  console.log('PASS cancelled page navigation preserves the active preview session');
  assert.equal(await page.locator('#visualTab,.format-toolbar,#typstTools,#typstPreviewSwitch,#showPdfPreview').count(),0);assert.equal(await page.locator('#pdfFrame').isHidden(),true);assert.equal(await page.locator('#pdfFrame').getAttribute('src'),null);assert.equal(await page.locator('#openPdfButton').isHidden(),true);
  await page.locator('.tree-file[title="main.typ"]').click({button:'right'});await page.locator('#renameFile').click();await page.locator('#renameFilePath').fill('renamed.typ');await page.locator('#confirmRenameFile').click();
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='renamed.typ'&&document.querySelector('#buildStatus').textContent.startsWith('Live ·'));
  await frame.locator('#typst-app svg').first().waitFor({state:'visible'});assert.equal(sessions.length,2,'Renaming the main document must replace its session');
  assert.equal((await context.request.get(origin+base+'/typst/'+sessions[0])).status(),404);
  const sid=sessions[1];await page.locator('#projectsNavButton').click();await page.locator('#projectHome').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#typstFrame').getAttribute('src')==='about:blank');
  const ended=await context.request.get(origin+base+'/typst/'+sid);assert.equal(ended.status(),404,'Leaving a project releases its live session');
  await page.locator('.project-entry[href="#project='+pid+'"]').click();await page.locator('#typstFrame').waitFor({state:'visible'});await frame.locator('#typst-app svg').first().waitFor({state:'visible'});
  const pageExitSession=sessions.at(-1);await page.goto(origin+'/favicon.svg');let exitStatus;
  for(let attempt=0;attempt<50;attempt++){exitStatus=(await context.request.get(origin+base+'/typst/'+pageExitSession)).status();if(exitStatus===404)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(exitStatus,404,'Actual page exit releases its worker');
  await page.goBack();await page.locator('#typstFrame').waitFor({state:'visible'});await frame.locator('#typst-app svg').first().waitFor({state:'visible'});
  assert.notEqual(sessions.at(-1),pageExitSession);assert.equal((await context.request.get(origin+base+'/typst/'+sessions.at(-1))).status(),200,'Returning to the editor starts a working live session');
  await page.locator('#projectsNavButton').click();await page.locator('#projectHome').waitFor({state:'visible'});
  assert.deepEqual(errors,[]);console.log('PASS project-named real PDF export, live-only preview, main-document rename/reconnect, page-exit cleanup and browser Back recovery');
 }finally{if(pid)await api('/api/projects/'+pid,'DELETE',{});await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
