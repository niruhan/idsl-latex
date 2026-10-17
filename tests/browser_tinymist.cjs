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
  await page.locator('#code').fill(source.replace('42','84'));await page.locator('#code').evaluate(area=>{const index=area.value.lastIndexOf('answer')+2;area.setSelectionRange(index,index);});await page.locator('#typstHover').click();
  await page.locator('#typstDocumentation').getByText(/84/).waitFor();
  await page.waitForFunction(previous=>document.querySelector('#typstFrame').contentDocument.querySelector('#typst-app').innerHTML!==previous,initialSvg);
  const editedSvg=await frame.locator('#typst-app').innerHTML();await page.locator('#code').press('Control+z');assert.equal(await page.locator('#code').inputValue(),source);
  await page.waitForFunction(previous=>document.querySelector('#typstFrame').contentDocument.querySelector('#typst-app').innerHTML!==previous,editedSvg);
  await page.locator('#code').press('Meta+Shift+z');assert.equal(await page.locator('#code').inputValue(),source.replace('42','84'));
  await page.locator('#code').evaluate(area=>{const index=area.value.lastIndexOf('answer')+2;area.setSelectionRange(index,index);});
  await page.locator('#typstDefinition').click();await page.waitForFunction(()=>document.querySelector('#code').selectionStart===document.querySelector('#code').value.indexOf('answer'));
  await page.locator('#code').fill('#let greeting = [Hello]\n#gree');await page.locator('#code').press('Control+Space');await page.locator('#typstCompletions [role=option]').filter({hasText:'greeting'}).first().dispatchEvent('pointerdown');assert.match(await page.locator('#code').inputValue(),/#greeting/);
  const completed=await page.locator('#code').inputValue();await page.locator('#code').press('Control+z');assert.equal(await page.locator('#code').inputValue(),'#let greeting = [Hello]\n#gree');await page.locator('#code').press('Control+y');assert.equal(await page.locator('#code').inputValue(),completed);
  await page.locator('#code').fill('#rec');await page.locator('#code').press('Control+Space');await page.locator('#typstCompletions [role=option]').filter({hasText:/^rect/}).first().dispatchEvent('pointerdown');assert.match(await page.locator('#code').inputValue(),/#rect/);assert.doesNotMatch(await page.locator('#code').inputValue(),/\$(?:\d|\{)/,'Completion snippets must insert usable Typst, without LSP placeholder markers');
  await page.locator('#code').fill('#not-a-real-function(');await page.locator('#typstProblems .typst-diagnostic').first().waitFor();
  assert.equal(await frame.locator('#typst-app svg').count()>0,true,'Syntax errors retain the previous rendered document');
  const unformatted='#let answer=84\n\nThe answer is #answer.\n';await page.locator('#code').fill(unformatted);await page.locator('#typstFormat').click();await page.waitForFunction(before=>document.querySelector('#code').value!==before,unformatted);
  const formatted=await page.locator('#code').inputValue();await page.locator('#code').press('Control+z');assert.equal(await page.locator('#code').inputValue(),unformatted);await page.locator('#code').press('Control+Shift+z');assert.equal(await page.locator('#code').inputValue(),formatted);
  await page.locator('#code').fill(source.replace('42','84'));await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Live ·'));
  assert.equal(await page.locator('#typstFrame').getAttribute('src'),initialSrc);assert.equal(await iframe.evaluate(element=>element===document.getElementById('typstFrame')),true);assert.equal(sessions.length,1);assert.equal(pdfBuilds,0);
  await page.locator('#typstFormat').click();await page.locator('#typstReveal').click();
  await page.locator('#code').evaluate(area=>area.setSelectionRange(area.value.length,area.value.length));await frame.locator('.typst-text').first().click({position:{x:3,y:3}});
  await page.waitForFunction(()=>document.querySelector('#code').selectionStart<=document.querySelector('#code').value.indexOf('\n'));
  await page.locator('#pdfThemeButton').click();assert.equal(await page.locator('#pdfPreview').evaluate(element=>element.classList.contains('pdf-dark')),true);await page.locator('#pdfThemeButton').click();
  await page.locator('#typstDocumentation .icon').click().catch(()=>{});await page.locator('#toast').waitFor({state:'hidden'});await frame.locator('.typst-debug-react-ripple').waitFor({state:'detached'});await page.screenshot({path:path.join(output,'tinymist-live.png'),fullPage:true});
  console.log('PASS real Tinymist incremental preview without iframe reload/PDF builds, LSP completion/hover/definition/formatting, undo/redo with live preview, diagnostics, recovery, source reveal and dark preview');

  const download=page.waitForEvent('download');await page.locator('#downloadButton').click();const pdf=await download;assert.equal(pdf.suggestedFilename(),'Live research notebook.pdf');const pdfPath=path.join(output,'tinymist-export.pdf');await pdf.saveAs(pdfPath);assert.equal(fs.readFileSync(pdfPath).subarray(0,4).toString(),'%PDF');assert.equal(pdfBuilds,1);
  await page.locator('#showPdfPreview').click();await page.locator('#pdfFrame').waitFor({state:'visible'});assert.equal(await page.locator('#typstFrame').isHidden(),true);await page.locator('#showLivePreview').click();await page.locator('#typstFrame').waitFor({state:'visible'});
  await page.locator('.tree-file[title="main.typ"]').click({button:'right'});await page.locator('#renameFile').click();await page.locator('#renameFilePath').fill('renamed.typ');await page.locator('#confirmRenameFile').click();
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='renamed.typ'&&document.querySelector('#buildStatus').textContent.startsWith('Live ·'));
  await frame.locator('#typst-app svg').first().waitFor({state:'visible'});assert.equal(sessions.length,2,'Renaming the main document must replace its session');
  assert.equal((await context.request.get(origin+base+'/typst/'+sessions[0])).status(),404);
  const sid=sessions[1];await page.locator('#projectsNavButton').click();await page.locator('#projectHome').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#typstFrame').getAttribute('src')==='about:blank');
  const ended=await context.request.get(origin+base+'/typst/'+sid);assert.equal(ended.status(),404,'Leaving a project releases its live session');
  assert.deepEqual(errors,[]);console.log('PASS project-named real PDF export, Live/PDF switching, main-document rename/reconnect and session cleanup on explorer navigation');
 }finally{if(pid)await api('/api/projects/'+pid,'DELETE',{});await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
