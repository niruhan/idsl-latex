const {editorOption}=require('./editor_ui.cjs');
/* Run against an isolated test instance, never a real user's workspace. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8878';
const output = process.env.TEST_OUTPUT || path.join(process.cwd(), 'artifacts');
(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext({viewport:{width:1440,height:960}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
 try{
  await page.goto(origin);
  await page.locator('input[name=email]').fill('browser-owner@example.test');
  await page.locator('input[name=password]').fill('browser-test-password-only');
  await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});
  await page.locator('#createProject').click();
  await page.locator('#newProjectForm input[name=name]').fill('Typst research notebook');
  await page.locator('#newProjectForm select[name=format]').selectOption('typst');
  await page.locator('#newProjectForm button').click();
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='main.typ');
  assert.equal(await page.locator('#fileType').textContent(),'Typst');assert.equal(await page.locator('#visualTab,.format-toolbar').count(),0);assert.equal(await page.locator('#autoCompile').isHidden(),true);
  const projectId=new URL(page.url()).hash.split('project=')[1],base='/api/projects/'+projectId,before=await page.locator('#code').inputValue();
  await page.locator('button.tree-file[title="sections/introduction.typ"]').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='sections/introduction.typ');
  const introduction=await page.locator('#code').inputValue();await page.locator('#code').fill(introduction+'\n// Source editing preserves citations.\n');await page.waitForFunction(()=>document.querySelector('#saveStatus').textContent==='All changes saved');assert.match(await page.locator('#code').inputValue(),/@ho2020denoising/);
  await page.locator('button.tree-file[title="references.bib"]').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='references.bib');assert.equal(await page.locator('#sourceEditor').isVisible(),true);
  await page.locator('button.tree-file[title="main.typ"]').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='main.typ');assert.equal(await page.locator('#code').inputValue(),before);
  const downloadEvent=page.waitForEvent('download');await page.locator('#downloadButton').click();const download=await downloadEvent;assert.equal(download.suggestedFilename(),'Typst research notebook.pdf');await download.saveAs(path.join(output,'typst-export.pdf'));assert.equal(fs.readFileSync(path.join(output,'typst-export.pdf')).subarray(0,4).toString(),'%PDF');
  assert.equal(await page.locator('#pdfFrame').isHidden(),true);assert.equal(await page.locator('#pdfFrame').getAttribute('src'),null);assert.equal(await page.locator('#openPdfButton').isHidden(),true);
  console.log('PASS source-only Typst editing, citations, bibliography, PDF export and no embedded PDF view');
  await page.locator('#code').fill('#unknown-function()');const failed=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');await page.locator('#compileButton').click();assert.equal((await(await failed).json()).success,false);
  await page.locator('#diagnostics button').first().click();await page.waitForFunction(()=>document.querySelector('#code').selectionStart<=2);assert.equal(await page.locator('#pdfFrame').isHidden(),true);
  await page.locator('#code').fill(before);const recovered=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');await page.locator('#compileButton').click();assert.equal((await(await recovered).json()).success,true);await page.locator('#closeLog').click();
  console.log('PASS Typst PDF export diagnostics, source navigation and recovery');

  // All backup mutations are intercepted in the browser. Settings still use the
  // real app/database; no credential or project leaves this test machine.
  let backups=0;
  await page.route('**/api/projects/*/backup',async route=>{
   assert.equal(route.request().postDataJSON().token,'test-token-in-memory');backups++;
   await route.fulfill({json:{changed:true,name:'Typst research notebook',repository:'example/all-documents',commit:'a'.repeat(40),url:'https://github.com/example/all-documents/commit/'+'a'.repeat(40)}});
  });
  await context.request.put(origin+'/api/backup-settings',{headers:{Origin:origin},data:{repository:'example/all-documents'}});
  await editorOption(page,'backupButton');
  assert.equal(await page.locator('#backupSharedRepo').count(),0);
  assert.match(await page.locator('#projectGlobalBackup').textContent(),/example\/all-documents/);
  await page.locator('#backupToken').fill('test-token-in-memory');await page.locator('#backupRemember').uncheck();
  await page.locator('#backupCurrent').click();
  await page.locator('#backupResult').getByText(/Snapshot saved/).waitFor();
  assert.equal(backups,1);
  let settings=await(await context.request.get(origin+'/api/backup-settings')).json();
  assert.equal(settings.repository,'example/all-documents');
  await page.locator('#backupMode').selectOption('separate');
  await page.locator('#backupProjectRepo').fill('example/one-paper');
  await page.locator('#backupForm button[type=submit]').click();
  await page.locator('#backupResult').getByText('Backup settings saved.',{exact:false}).waitFor();
  settings=await(await context.request.get(origin+base+'/backup-settings')).json();
  assert.equal(settings.mode,'separate');assert.equal(settings.repository,'example/one-paper');
  assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('test-token-in-memory')),false);
  await page.screenshot({path:path.join(output,'github-backups.png'),fullPage:true});
  await page.reload();await page.locator('#workspace').waitFor({state:'visible'});
  await editorOption(page,'backupButton');assert.equal(await page.locator('#backupToken').inputValue(),'');
  assert.equal(await page.locator('#backupMode').inputValue(),'separate');
  console.log('PASS shared/per-project backup UI, persisted destinations and memory-only token');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
