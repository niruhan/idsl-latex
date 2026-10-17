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
  await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));
  assert.equal(await page.locator('#fileType').textContent(),'Typst');
  assert.equal(await page.locator('#autoCompile').isChecked(),true);
  const projectId=new URL(page.url()).hash.split('project=')[1];
  const base='/api/projects/'+projectId;
  const before=await page.locator('#code').inputValue();
  await page.locator('#visualTab').click();await page.locator('#sourceTab').click();
  assert.equal(await page.locator('#code').inputValue(),before,'Untouched Visual mode must preserve every byte');
  await page.locator('button.tree-file[title="sections/introduction.typ"]').click();
  await page.locator('#visualTab').click();
  await page.locator('[contenteditable=true][aria-label="Paragraph"]').first().fill('Visual editing in Typst works beautifully.');
  await page.waitForFunction(()=>document.querySelector('#saveStatus').textContent==='All changes saved');
  await page.locator('#sourceTab').click();
  assert.match(await page.locator('#code').inputValue(),/Visual editing in Typst works beautifully/);
  assert.match(await page.locator('#code').inputValue(),/@ho2020denoising/,'Citations must remain untouched');
  await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));
  await page.locator('#visualTab').click();
  const visualParagraph=page.locator('[contenteditable=true][aria-label="Paragraph"]').first();
  await visualParagraph.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
  await page.locator('[data-insert=italic]').click();
  assert.equal(await page.locator('#visualEditor').isVisible(),true);
  await page.waitForFunction(()=>document.querySelector('#saveStatus').textContent==='All changes saved');
  await page.locator('#sourceTab').click();
  assert.ok((await page.locator('#code').inputValue()).includes('_Visual editing in Typst works beautifully\\._'));
  console.log('PASS Typst creation, real auto-preview, lossless source round-trip, visual edit and citation preservation');

  // Verify selected source text is wrapped with Typst syntax, and binary/non-document files disable Visual.
  await page.locator('#code').evaluate(area=>{area.focus();area.setSelectionRange(area.value.indexOf('beautifully'),area.value.indexOf('beautifully')+11);});
  await page.locator('[data-insert=bold]').click();
  assert.match(await page.locator('#code').inputValue(),/\*beautifully\*/);
  await page.waitForFunction(()=>document.querySelector('#saveStatus').textContent==='All changes saved');
  await page.locator('button.tree-file[title="references.bib"]').click();
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='references.bib');
  assert.equal(await page.locator('#visualTab').isDisabled(),true);
  await page.locator('button.tree-file[title="main.typ"]').click();
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='main.typ');
  console.log('PASS language-aware formatting and non-document mode');

  await page.locator('#autoCompile').uncheck();
  await page.waitForFunction(()=>!document.querySelector('#compileButton').disabled);
  await page.locator('#code').fill('#unknown-function()');
  const failed=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');
  await page.locator('#compileButton').click();assert.equal((await(await failed).json()).success,false);
  await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent==='Build failed');
  assert.equal(await page.locator('#pdfFrame').isHidden(),true);
  await page.locator('#diagnostics button').first().click();
  await page.waitForFunction(()=>document.querySelector('#code').selectionStart<=2);
  await page.locator('#code').fill(before);
  const recovered=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');
  await page.locator('#compileButton').click();assert.equal((await(await recovered).json()).success,true);
  await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));
  await page.locator('#closeLog').click();
  await page.locator('#visualTab').click();
  await page.screenshot({path:path.join(output,'typst-visual.png'),fullPage:true});
  console.log('PASS real Typst diagnostics, source navigation, failed PDF clearing and recovery');

  // All backup mutations are intercepted in the browser. Settings still use the
  // real app/database; no credential or project leaves this test machine.
  let backups=0;
  await page.route('**/api/projects/*/backup',async route=>{
   assert.equal(route.request().postDataJSON().token,'test-token-in-memory');backups++;
   await route.fulfill({json:{changed:true,name:'Typst research notebook',repository:'example/all-documents',commit:'a'.repeat(40),url:'https://github.com/example/all-documents/commit/'+'a'.repeat(40)}});
  });
  await page.locator('#backupButton').click();
  await page.locator('#backupSharedRepo').fill('example/all-documents');
  await page.locator('#backupToken').fill('test-token-in-memory');
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
  await page.locator('#backupButton').click();assert.equal(await page.locator('#backupToken').inputValue(),'');
  assert.equal(await page.locator('#backupMode').inputValue(),'separate');
  console.log('PASS shared/per-project backup UI, persisted destinations and memory-only token');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
