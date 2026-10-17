// Trash operations use fictional fixtures on the disposable test server.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN;assert.ok(origin);
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN}),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
 page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 async function api(route,method='GET',data){const response=await context.request.fetch(origin+route,{method,headers:{Origin:origin},data});assert.ok(response.ok(),await response.text());return response.json();}
 try{
  await page.goto(origin);await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});
  assert.equal(await page.locator('.home-footer,.home-sidebar-foot,.home-topbar-caption').count(),0);
  const {id}=await api('/api/projects','POST',{name:'Trash browser fixture',format:'typst',template:false}),base='/api/projects/'+id;
  await page.goto(origin+'/#project='+id);await page.locator('#workspace').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#workspace').inert);
  const original=await page.locator('#code').inputValue(),edited=original+'\n// Last edit before deletion.\n';await page.locator('#code').fill(edited);
  await page.locator('#editorMenuButton').click();await page.locator('#editorDeleteProject').click();await page.locator('#cancelDeleteProject').click();assert.equal((await api(base)).name,'Trash browser fixture');
  await page.locator('#editorMenuButton').click();await page.locator('#editorDeleteProject').click();await page.locator('#confirmDeleteProject').click();await page.locator('#projectHome').waitFor({state:'visible'});assert.equal(await page.locator('.project-entry[data-project="'+id+'"]').count(),0);assert.equal((await context.request.get(origin+base)).status(),404);
  await page.locator('#openTrash').click();await page.locator('[data-restore-project="'+id+'"]').waitFor();assert.match(await page.locator('#modalBody').textContent(),/30 days/);
  await page.reload();await page.locator('#projectHome').waitFor({state:'visible'});await page.locator('#openTrash').click();await page.locator('[data-restore-project="'+id+'"]').click();await page.locator('[data-restore-project="'+id+'"]').waitFor({state:'detached'});assert.equal((await api(base+'/file?path=main.typ')).content,edited);await page.locator('#closeModal').click();await page.locator('.project-entry[data-project="'+id+'"]').waitFor();
  await page.locator('.project-entry[data-project="'+id+'"]').click();await page.locator('#workspace').waitFor({state:'visible'});assert.equal(await page.locator('#code').inputValue(),edited);
  await page.locator('#editorMenuButton').click();await page.locator('#editorDeleteProject').click();await page.locator('#confirmDeleteProject').click();await page.locator('#projectHome').waitFor({state:'visible'});await page.locator('#openTrash').click();await page.locator('[data-purge-project="'+id+'"]').click();await page.locator('#cancelPurgeProject').click();await page.locator('[data-restore-project="'+id+'"]').waitFor();
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.querySelector('#modalBody').scrollWidth<=document.querySelector('#modalBody').clientWidth));
  await page.locator('[data-purge-project="'+id+'"]').click();await page.locator('#purgeProject').click();await page.locator('[data-restore-project="'+id+'"]').waitFor({state:'detached'});assert.equal((await context.request.post(origin+'/api/trash/'+id,{headers:{Origin:origin},data:{}})).status(),404);
  assert.deepEqual(errors,[]);console.log('PASS minimal explorer, editor Trash action, final autosave, persisted Trash, restore with unchanged source, permanent-delete cancellation/confirmation and mobile dialog');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
