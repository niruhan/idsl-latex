/* End-to-end project home checks; use the disposable server in run_browser.py. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8878';
 const output=process.env.TEST_OUTPUT||path.join(process.cwd(),'artifacts');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext({viewport:{width:1440,height:960}});
 const page=await context.newPage();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(origin);
  await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();
  await page.locator('#projectHome').waitFor({state:'visible'});await page.locator('.project-entry').first().waitFor();
  assert.equal(await page.locator('#workspace').isHidden(),true);
  let projects=(await(await context.request.get(origin+'/api/projects')).json()).projects;
  assert.equal(await page.locator('.project-entry').count(),projects.length);
  await page.reload();await page.locator('.project-entry').first().waitFor();
  assert.equal((await(await context.request.get(origin+'/api/projects')).json()).projects.length,projects.length);
  assert.equal(await page.locator('.home-sample').count(),0);
  await page.locator('#browseTemplates').click();await page.locator('[data-starter=getting-started-typst]').click();await page.locator('#workspace').waitFor({state:'visible'});
  const sample={id:new URLSearchParams(new URL(page.url()).hash.slice(1)).get('project')};
  await page.locator('#projectsNavButton').click();await page.locator('.project-entry[data-project="'+sample.id+'"]').waitFor();
  projects=(await(await context.request.get(origin+'/api/projects')).json()).projects;
  console.log('PASS sign-in and repeated home visits create nothing; the Typst sample is a regular template');

  await page.locator('[data-project-filter=typst]').click();
  assert.equal(await page.locator('.project-entry').count(),projects.filter(p=>p.main.endsWith('.typ')).length);
  await page.locator('[data-project-filter=latex]').click();
  assert.equal(await page.locator('.project-entry').count(),projects.filter(p=>p.main.endsWith('.tex')).length);
  await page.locator('[data-project-filter=shared]').click();await page.locator('#projectsEmpty').waitFor({state:'visible'});
  await page.locator('[data-project-filter=all]').click();
  await page.locator('#projectSearch').fill('Getting started');assert.equal(await page.locator('.project-entry').count(),1);
  await page.locator('#projectSearch').fill('no-project-with-this-name');await page.locator('#projectsEmpty').waitFor({state:'visible'});
  await page.locator('#projectSearch').fill('');
  await page.locator('#projectSort').selectOption('name');
  const titles=await page.locator('.project-details h2').allTextContents();assert.deepEqual(titles,[...titles].sort((a,b)=>a.localeCompare(b)));
  await page.locator('#projectListView').click();assert.ok((await page.locator('#projectList').getAttribute('class')).includes('list-view'));
  await page.reload();await page.locator('.project-entry').first().waitFor();assert.equal(await page.locator('#projectListView').getAttribute('aria-pressed'),'true');
  await page.screenshot({animations:'disabled',path:path.join(output,'project-home-list.png'),fullPage:true});
  await page.locator('#projectGridView').click();await page.waitForFunction(()=>document.querySelector('#projectGridView').getAttribute('aria-pressed')==='true');await page.screenshot({animations:'disabled',path:path.join(output,'project-home.png'),fullPage:true});
  console.log('PASS search, format/shared filters, sorting, grid/list layouts and saved view preference');

  await page.locator('.project-entry[data-project="'+sample.id+'"]').click();await page.locator('#workspace').waitFor({state:'visible'});
  assert.equal(await page.locator('#projectHome').isHidden(),true);assert.equal(await page.locator('#filePath').textContent(),'main.typ');
  const compiled=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');await page.locator('#compileButton').click();assert.equal((await(await compiled).json()).success,true);assert.equal(await page.locator('#pdfFrame').isHidden(),true);
  const source=await page.locator('#code').inputValue();
  await page.locator('#code').fill(source+'\n// Save before returning to the project explorer.\n');
  await page.locator('#projectsNavButton').click();await page.locator('#projectHome').waitFor({state:'visible'});
  const saved=await(await context.request.get(origin+'/api/projects/'+sample.id+'/file?path=main.typ')).json();assert.match(saved.content,/Save before returning/);
  await page.goBack();await page.waitForURL('**/#project='+sample.id);await page.locator('#workspace').waitFor({state:'visible'});assert.match(await page.locator('#code').inputValue(),/Save before returning/);
  await page.goForward();await page.waitForURL('**/#projects');await page.locator('#projectHome').waitFor({state:'visible'});
  const direct=await context.newPage();await direct.goto(origin+'/#project='+sample.id);await direct.locator('#workspace').waitFor({state:'visible'});assert.equal(await direct.locator('#filePath').textContent(),'main.typ');await direct.close();
  console.log('PASS sample opens and compiles, pending edits save on exit, browser Back/Forward and editor deep links');

  await page.locator('.project-entry[data-project="'+sample.id+'"]').click();await page.locator('#workspace').waitFor({state:'visible'});
  // Hold a real compile response until after leaving the editor.
  let releaseResponse;const responseHeld=new Promise(resolve=>{releaseResponse=resolve;});let notifyStarted;const started=new Promise(resolve=>{notifyStarted=resolve;});
  await page.route('**/api/projects/*/compile',async route=>{const result=await route.fetch();notifyStarted();await responseHeld;await route.fulfill({response:result});});
  await page.locator('#compileButton').click();await started;
  await page.locator('#projectsNavButton').click();await page.locator('#projectHome').waitFor({state:'visible'});releaseResponse();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Previous project compiled'));
  await page.unroute('**/api/projects/*/compile');
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{scrollTo(0,0);return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  assert.equal(await page.locator('#projectHome').count(),1);assert.equal(await page.locator('#workspace').isHidden(),true);
  fs.writeFileSync(path.join(output,'project-home-mobile-layout.json'),JSON.stringify(await page.evaluate(()=>({viewport:innerHeight,height:document.documentElement.scrollHeight,homes:document.querySelectorAll('#projectHome').length,header:document.querySelector('.home-topbar').getBoundingClientRect().toJSON()})),null,2));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile explorer must fit the viewport');
  await page.screenshot({animations:'disabled',path:path.join(output,'project-home-mobile.png'),fullPage:true});
  await page.locator('.project-entry[data-project="'+sample.id+'"]').click();await page.locator('#workspace').waitFor({state:'visible'});
  assert.deepEqual(errors,[]);
  console.log('PASS leaving during compilation, mobile layout, project navigation and no browser errors');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
