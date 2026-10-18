/* Project organization checks on the disposable database in run_browser.py. */
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
 const read=async route=>{const response=await context.request.get(origin+route);assert.equal(response.status(),200);return response.json();};
 const post=async(route,data)=>{const response=await context.request.post(origin+route,{headers:{Origin:origin},data});assert.equal(response.status(),200,await response.text());return response.json();};
 const entry=id=>page.locator('.project-entry[data-project="'+id+'"]');
 const directory=id=>page.locator('.project-directory[data-folder="'+id+'"]');
 const root=async()=>{await page.locator('[data-project-filter=all]').click();await page.locator('#homeHeading').filter({hasText:'All projects'}).waitFor();};
 const enter=async id=>{await page.locator('.home-folder-link[data-folder="'+id+'"]').click();await page.waitForURL('**/#projects&folder='+id);};
 async function createFolder(name){
  await page.locator('#createProjectFolder').click();await page.locator('#projectFolderName').fill(name);
  await page.locator('#projectFolderForm button.primary').click();await page.locator('#projectFolderForm').waitFor({state:'hidden'});
  const folders=(await read('/api/project-folders')).folders;const folder=folders.find(folder=>folder.name===name);assert.ok(folder);
  await page.waitForURL('**/#projects&folder='+folder.id);return folder.id;
 }
 async function move(id,folder){
  await page.locator('[data-project-actions="'+id+'"] summary').click();await page.locator('[data-move-project="'+id+'"]').click();await page.locator('#projectFolderTarget').selectOption(folder||'');
  await page.locator('#moveProjectForm button').click();await page.locator('#moveProjectForm').waitFor({state:'hidden'});
  assert.equal((await read('/api/projects')).projects.find(project=>project.id===id).folder,folder);
 }
 try{
  await page.goto(origin);await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();
  await page.locator('.project-entry').first().waitFor();
  const alpha=(await post('/api/projects',{name:'Analysis notebook',format:'typst',template:false})).id;
  const beta=(await post('/api/projects',{name:'Reading notes',format:'typst',template:false})).id;
  const before=await read('/api/projects/'+alpha);await page.locator('#refreshProjects').click();await entry(alpha).waitFor();
  const course=await createFolder('Course notes');const week=await createFolder('Week 1');
  assert.deepEqual(await page.locator('#folderBreadcrumbs a').allTextContents(),['All projects','Course notes','Week 1']);
  await root();await move(alpha,week);assert.equal(await entry(alpha).count(),0);
  await entry(beta).dragTo(directory(course));await page.waitForFunction(id=>!document.querySelector('.project-entry[data-project="'+id+'"]'),beta);
  assert.equal((await read('/api/projects')).projects.find(project=>project.id===beta).folder,course);
  await enter(week);await entry(alpha).waitFor();await page.reload();await entry(alpha).waitFor();
  assert.deepEqual(await read('/api/projects/'+alpha),{...before,folder:week},'Only the per-account folder changes; source, revision, permissions and build metadata stay unchanged');
  console.log('PASS nested folders, breadcrumbs, move dialog, drag/drop, reload persistence and unchanged project content');

  await root();await page.locator('#projectSearch').fill('Analysis notebook');await entry(alpha).waitFor();
  assert.equal(await entry(alpha).locator('.project-location').textContent(),'Course notes / Week 1');
  await page.locator('#projectSearch').fill('');await page.locator('[data-project-filter=typst]').click();await entry(alpha).waitFor();
  await enter(week);await page.goBack();await page.locator('#homeHeading').filter({hasText:'All projects'}).waitFor();
  await page.goForward();await page.locator('#homeHeading').filter({hasText:'Week 1'}).waitFor();await entry(alpha).waitFor();
  await page.locator('#createProject').click();await page.locator('#newProjectForm input[name=name]').fill('Weekly questions');await page.locator('#newProjectForm select[name=template]').selectOption('false');
  await page.locator('#newProjectForm button').click();await page.locator('#workspace').waitFor({state:'visible'});
  const created=new URL(page.url()).hash.split('project=')[1];assert.equal((await read('/api/projects')).projects.find(project=>project.id===created).folder,week);
  await page.locator('#projectsNavButton').click();await page.waitForURL('**/#projects');await page.locator('#folderLocation').waitFor({state:'hidden'});await enter(week);await entry(created).waitFor();
  const zip=await context.request.get(origin+'/api/projects/'+alpha+'/source.zip');assert.equal(zip.status(),200);
  await page.locator('#importZip').setInputFiles({name:'Imported course notes.zip',mimeType:'application/zip',buffer:await zip.body()});await page.locator('#workspace').waitFor({state:'visible'});
  const imported=new URL(page.url()).hash.split('project=')[1];assert.equal((await read('/api/projects')).projects.find(project=>project.id===imported).folder,week);
  await page.locator('#projectsNavButton').click();await page.waitForURL('**/#projects');await page.locator('#folderLocation').waitFor({state:'hidden'});await enter(week);await entry(imported).waitFor();
  console.log('PASS search across folders, global format filter, Back/Forward and create/import into the current folder');

  await page.locator('#manageProjectFolder').click();assert.equal(await page.locator('#deleteProjectFolder').isDisabled(),true);
  assert.equal(await page.locator('#projectFolderParent option[value="'+week+'"]').count(),0);
  await page.locator('#projectFolderName').fill('Seminar');await page.locator('#projectFolderParent').selectOption('');await page.locator('#projectFolderForm button.primary').click();
  await page.locator('#projectFolderForm').waitFor({state:'hidden'});assert.deepEqual(await page.locator('#folderBreadcrumbs a').allTextContents(),['All projects','Seminar']);
  await page.locator('#homeThemeButton').click();await page.screenshot({animations:'disabled',path:path.join(output,'project-folders-dark.png'),fullPage:true});
  const empty=await createFolder('Empty folder');await page.locator('#manageProjectFolder').click();await page.locator('#deleteProjectFolder').click();await page.locator('#projectFolderForm').waitFor({state:'hidden'});
  assert.ok(!(await read('/api/project-folders')).folders.some(folder=>folder.id===empty));assert.ok(page.url().endsWith('&folder='+week));
  await root();await directory(course).waitFor();await directory(week).waitFor();await page.screenshot({animations:'disabled',path:path.join(output,'project-folders.png'),fullPage:true});
  await page.locator('#projectListView').click();await directory(week).click();await move(alpha,null);assert.equal(await entry(alpha).count(),0);
  await page.setViewportSize({width:390,height:844});await page.locator('#projectGridView').click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile folder view must fit the viewport');
  await page.screenshot({animations:'disabled',path:path.join(output,'project-folders-mobile.png'),fullPage:true});
  await page.locator('#folderBreadcrumbs a').first().click();await entry(alpha).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS rename/reparent, empty-only deletion, root move, grid/list and dark/mobile folder views with no browser errors');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
