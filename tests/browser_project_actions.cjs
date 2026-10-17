/* Explorer actions use disposable fixtures from run_browser.py, never personal projects. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8878';
 const output=process.env.TEST_OUTPUT||path.join(process.cwd(),'artifacts');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const owner=await browser.newContext({viewport:{width:1440,height:960},colorScheme:'light'});
 const page=await owner.newPage();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function api(context,route,method='GET',data){const response=await context.request.fetch(origin+route,{method,headers:{Origin:origin},data});assert.equal(response.status(),200,await response.text());return response.json();}
 const item=(target,id)=>target.locator('.project-entry[data-project="'+id+'"]');
 const menu=(target,id)=>target.locator('[data-project-actions="'+id+'"]');
 async function choose(target,id,action){await menu(target,id).locator('summary').click();await target.locator('[data-'+action+'-project="'+id+'"]').click();}
 async function rename(target,id,name){await choose(target,id,'rename');await target.locator('#renameProjectName').fill(name);await target.locator('#saveProjectName').click();await target.locator('#renameProjectForm').waitFor({state:'hidden'});}
 async function member(role){
  const email='explorer-'+role+'@example.test';const invitation=await api(owner,'/api/lab-invite','POST',{count:1});
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  await api(context,'/api/register-lab','POST',{name:'Explorer '+role,email,password:'browser-test-password-only',token:invitation.links[0].url.split('#signup=')[1]});
  const share=await api(owner,base+'/invite','POST',{role});await api(context,'/api/join','POST',{token:share.url.split('#invite=')[1]});
  const target=await context.newPage();target.setDefaultTimeout(20000);target.on('pageerror',e=>errors.push(e.message));await target.goto(origin);await item(target,id).waitFor();return {context,page:target};
 }
 let id,base;
 try{
  await page.goto(origin);await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('.project-entry').first().waitFor();
  id=(await api(owner,'/api/projects','POST',{name:'Explorer draft',format:'typst',template:false})).id;base='/api/projects/'+id;
  const keep=(await api(owner,'/api/projects','POST',{name:'Keep this paper',format:'latex',template:false})).id;
  const before=await api(owner,base+'/file?path=main.typ');await page.locator('#refreshProjects').click();await item(page,id).waitFor();
  await menu(page,id).locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await menu(page,id).getAttribute('open'),'');await page.keyboard.press('Escape');assert.equal(await menu(page,id).getAttribute('open'),null);
  await menu(page,id).locator('summary').click();await menu(page,keep).locator('summary').click();assert.equal(await page.locator('.project-actions[open]').count(),1);await page.locator('#projectSearch').click();assert.equal(await page.locator('.project-actions[open]').count(),0);
  await choose(page,id,'rename');assert.equal(await page.locator('#renameProjectName').inputValue(),'Explorer draft');await page.locator('#renameProjectName').fill('   ');assert.equal(await page.locator('#saveProjectName').isDisabled(),true);await page.locator('#cancelRenameProject').click();assert.equal((await api(owner,base)).name,'Explorer draft');
  await rename(page,id,'Notes <draft> & review');assert.equal(await item(page,id).locator('h2').textContent(),'Notes <draft> & review');assert.equal(await page.locator('#workspace').isHidden(),true);
  await page.reload();await item(page,id).waitFor();assert.equal(await item(page,id).locator('h2').textContent(),'Notes <draft> & review');assert.deepEqual(await api(owner,base+'/file?path=main.typ'),before);
  const folder=(await api(owner,'/api/project-folders','POST',{name:'Action examples'})).id;await page.locator('#refreshProjects').click();await choose(page,id,'move');await page.locator('#projectFolderTarget').selectOption(folder);await page.locator('#moveProjectForm button').click();await page.locator('#moveProjectForm').waitFor({state:'hidden'});
  await page.locator('.home-folder-link[data-folder="'+folder+'"]').click();await item(page,id).waitFor();await page.locator('#projectListView').click();await rename(page,id,'Shared explorer notes');
  assert.equal((await api(owner,'/api/projects')).projects.find(p=>p.id===id).folder,folder);
  console.log('PASS accessible menus, outside/Escape dismissal, cancel/empty-name handling, escaped names, grid/list rename persistence and unchanged source/folder placement');

  const approved=await api(owner,'/api/approved-emails');await api(owner,'/api/approved-emails','PUT',{emails:[...approved.emails,'explorer-editor@example.test','explorer-viewer@example.test']});
  const editor=await member('editor'),viewer=await member('viewer');
  await menu(editor.page,id).locator('summary').click();assert.equal(await editor.page.locator('[data-rename-project="'+id+'"]').isVisible(),true);assert.equal(await editor.page.locator('[data-delete-project="'+id+'"]').count(),0);await editor.page.keyboard.press('Escape');
  await menu(viewer.page,id).locator('summary').click();assert.equal(await viewer.page.locator('[data-rename-project="'+id+'"]').count(),0);assert.equal(await viewer.page.locator('[data-delete-project="'+id+'"]').count(),0);assert.equal(await viewer.page.locator('[data-move-project="'+id+'"]').isVisible(),true);
  assert.equal((await viewer.context.request.put(origin+base,{headers:{Origin:origin},data:{name:'Forbidden rename'}})).status(),403);
  for(const context of [editor.context,viewer.context])assert.equal((await context.request.delete(origin+base,{headers:{Origin:origin},data:{}})).status(),403);
  await rename(editor.page,id,'Reviewed explorer notes');await page.locator('#refreshProjects').click();await item(page,id).locator('h2').filter({hasText:'Reviewed explorer notes'}).waitFor();
  await choose(page,id,'rename');await page.locator('#renameProjectName').fill('Ready to archive');
  await page.route(origin+base,route=>route.request().method()==='PUT'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Rename test error'})}):route.continue());
  await page.locator('#saveProjectName').click();await page.locator('#toast').filter({hasText:'Rename test error'}).waitFor();assert.equal(await page.locator('#renameProjectForm').isVisible(),true);assert.equal((await api(owner,base)).name,'Reviewed explorer notes');
  await page.unroute(origin+base);await page.locator('#saveProjectName').click();await page.locator('#renameProjectForm').waitFor({state:'hidden'});assert.deepEqual(await api(owner,base+'/file?path=main.typ'),before);
  console.log('PASS owner/editor/viewer permissions, shared rename visibility and failed-request recovery');

  await page.evaluate(()=>{window.labtexTheme.setPalette('western');window.labtexTheme.set('dark');});await page.setViewportSize({width:390,height:844});await page.locator('#projectGridView').click();await menu(page,id).locator('summary').click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile action menu must fit the viewport');await page.screenshot({path:path.join(output,'project-actions-mobile.png'),fullPage:true,animations:'disabled'});
  await page.locator('[data-delete-project="'+id+'"]').click();assert.equal(await page.locator('#confirmDeleteProject').isDisabled(),true);await page.locator('#deleteProjectName').fill('Wrong name');assert.equal(await page.locator('#confirmDeleteProject').isDisabled(),true);await page.locator('#cancelDeleteProject').click();assert.equal((await api(owner,base)).name,'Ready to archive');
  await choose(page,id,'delete');await page.locator('#deleteProjectName').fill('Ready to archive');assert.equal(await page.locator('#confirmDeleteProject').isDisabled(),false);await page.screenshot({path:path.join(output,'delete-project-confirmation.png'),fullPage:true,animations:'disabled'});await page.locator('#confirmDeleteProject').click();await page.locator('#deleteExplorerProjectForm').waitFor({state:'hidden'});
  assert.equal(await item(page,id).count(),0);assert.ok(page.url().endsWith('&folder='+folder));await page.locator('#projectsEmpty').waitFor({state:'visible'});
  for(const context of [owner,editor.context,viewer.context])assert.equal((await context.request.get(origin+base)).status(),404);
  assert.equal((await owner.request.get(origin+base+'/file?path=main.typ')).status(),404);assert.equal((await api(owner,'/api/projects/'+keep)).name,'Keep this paper');
  await page.reload();await page.locator('#projectsEmpty').waitFor({state:'visible'});assert.equal(await item(page,id).count(),0);assert.deepEqual(errors,[]);
  console.log('PASS dark/mobile actions, typed confirmation, cancel, deletion for all collaborators, empty-folder state and preservation of other projects');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
