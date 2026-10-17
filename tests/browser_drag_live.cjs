/* Isolated browser fixture; never run against a personal installation. */
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN;assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage();
 page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 async function api(path,method='GET',data){const response=await context.request.fetch(origin+path,{method,headers:{Origin:origin},data});assert.equal(response.ok(),true,await response.text());return response.json();}
 let pid;
 try{
  await page.goto(origin);await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});
  assert.equal(await page.locator('#homeUserName').count(),0);
  const positions=await page.evaluate(()=>['importProject','createProjectFolder','createProject','projectSort','projectGridView','refreshProjects'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.top+r.height/2;}));
  assert.ok(Math.max(...positions)-Math.min(...positions)<3,'Desktop actions and view controls share one row');
  const parent=await api('/api/project-folders','POST',{name:'Drag destination'}),folder=await api('/api/project-folders','POST',{name:'Drag source'}),child=await api('/api/project-folders','POST',{name:'Drag child',parent:folder.id});
  pid=(await api('/api/projects','POST',{name:'Live drag document',format:'typst',template:false})).id;
  const base='/api/projects/'+pid;
  for(const [path,content] of [['notes/nested.typ','= Nested'],['images/picture.svg','<svg xmlns="http://www.w3.org/2000/svg"/>']])await api(base+'/file','PUT',{path,content,revision:0});
  await page.locator('#refreshProjects').click();
  const directory=id=>page.locator('.project-directory[data-folder="'+id+'"]');
  await directory(folder.id).dragTo(directory(parent.id));await page.waitForFunction(id=>!document.querySelector('.project-directory[data-folder="'+id+'"]'),folder.id);
  let folders=(await api('/api/project-folders')).folders;assert.equal(folders.find(f=>f.id===folder.id).parent,parent.id);assert.equal(folders.find(f=>f.id===child.id).parent,folder.id);
  await directory(parent.id).click();await directory(folder.id).waitFor();await directory(folder.id).click();await directory(child.id).waitFor();
  assert.ok(await page.evaluate(()=>{const template=document.querySelector('.starter-projects').getBoundingClientRect(),nav=document.querySelector('#folderLocation').getBoundingClientRect(),search=document.querySelector('#projectSearch').getBoundingClientRect();return template.bottom<=nav.top&&nav.bottom<=search.top;}));
  await page.locator('#upProjectFolder').click();await directory(folder.id).waitFor();await directory(folder.id).dragTo(page.locator('#rootProjectFolder'));await page.waitForFunction(id=>!document.querySelector('.project-directory[data-folder="'+id+'"]'),folder.id);
  assert.equal((await api('/api/project-folders')).folders.find(f=>f.id===folder.id).parent,null);
  await page.locator('#rootProjectFolder').click();await directory(folder.id).waitFor();
  console.log('PASS single-row desktop controls, folder drag with descendants, Up/All projects and navigation placement');

  await page.evaluate(id=>localStorage.setItem('labtex-auto:'+id,'false'),pid);
  await page.locator('.project-entry[data-project="'+pid+'"]').click();await page.locator('#workspace').waitFor({state:'visible'});
  await page.locator('.tree-file[title="main.typ"]').dragTo(page.locator('.tree-folder[data-folder="notes"]'));
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='notes/main.typ');assert.equal((await api(base)).main,'notes/main.typ');
  await page.locator('.tree-folder[data-folder="notes"]').dragTo(page.locator('.tree-folder[data-folder="images"]'));
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='images/notes/main.typ');assert.equal((await api(base)).main,'images/notes/main.typ');
  await page.locator('.tree-folder[data-folder="images/notes"]').dragTo(page.locator('#fileRootDrop'));
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='notes/main.typ');
  const download=page.waitForEvent('download');await page.locator('#exportSourceButton').click();assert.equal((await download).suggestedFilename(),'Live drag document.zip');
  console.log('PASS editor file/folder/root drag, main-document tracking and project-named source ZIP');

  const content='= Live preview\n\nA small valid Typst document.\n';await page.locator('#code').fill(content);
  let response=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');await page.locator('#compileButton').click();assert.equal((await(await response).json()).success,true);await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));
  const enabling=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');await page.locator('#autoCompile').check();await enabling;await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));let release,started;const held=new Promise(resolve=>release=resolve),began=new Promise(resolve=>started=resolve);let calls=0,elapsed;const start=Date.now();
  await page.route('**/api/projects/'+pid+'/compile',async route=>{calls++;if(calls===1){elapsed=Date.now()-start;const result=await route.fetch();started();await held;await route.fulfill({response:result});}else await route.continue();});
  await page.locator('#code').fill(content+'\nFirst edit.');await Promise.race([began,new Promise((_,reject)=>setTimeout(()=>reject(Error('Typing did not start a build')),10000))]);assert.ok(elapsed<750,'Typing should start a build promptly, observed '+elapsed+'ms');
  const queued=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST'&&calls>=2);await page.locator('#code').fill(content+'\nLatest queued edit.');release();
  await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));
  await page.waitForFunction(()=>document.querySelector('#saveStatus').textContent==='All changes saved');
  assert.equal((await(await queued).json()).success,true);
  await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));
  assert.ok(calls>=2);assert.match((await api(base+'/file?path=notes/main.typ')).content,/Latest queued edit/);await page.unroute('**/api/projects/'+pid+'/compile');
  response=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');await page.locator('#code').fill('#unknown-function(');assert.equal((await(await response).json()).success,false);await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent==='Build failed');
  assert.equal(await page.locator('#pdfFrame').isVisible(),true);assert.equal(await page.locator('#logPanel').isHidden(),true);
  response=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');await page.locator('#code').fill(content);assert.equal((await(await response).json()).success,true);await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));await page.locator('#autoCompile').uncheck();
  console.log('PASS Typst typing debounce ('+elapsed+'ms), queued edits, retained PDF during syntax errors and recovery');

  await page.locator('#accountButton').click();await page.locator('#accountProjectBackup').click();await page.locator('#backupMode').selectOption('separate');await page.locator('#backupProjectRepo').fill('example/separate-document');await page.locator('#backupForm button[type=submit]').click();await page.locator('#backupResult').getByText('Backup settings saved.',{exact:false}).waitFor();await page.locator('#closeModal').click();
  await page.locator('#projectsNavButton').click();await page.locator('#homeAccountButton').click();await page.locator('#accountBackups').click();
  assert.equal(await page.locator('#allBackupsForm a').getAttribute('href'),'https://github.com/settings/personal-access-tokens/new');
  await page.locator('#allBackupRepo').fill('example/all-documents');await page.locator('#allBackupToken').fill('test-only-saved-browser-credential');await page.locator('#saveAllBackupSettings').click();await page.locator('#allBackupResult').getByText('Shared repository settings saved.').waitFor();
  assert.equal(await page.locator('#allBackupToken').inputValue(),'');assert.equal((await api('/api/github-token')).saved,true);
  await page.reload();await page.locator('#projectHome').waitFor({state:'visible'});await page.locator('#homeAccountButton').click();await page.locator('#accountBackups').click();assert.match(await page.locator('#allBackupTokenStatus').textContent(),/A token is saved/);
  assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('test-only-saved-browser-credential')),false);
  await page.route('**/api/backups',async route=>{assert.deepEqual(route.request().postDataJSON(),{token:'',sharedOnly:true});await route.fulfill({json:{results:[{name:'Live drag document',changed:true,repository:'example/all-documents',url:'https://github.com/example/all-documents/commit/'+'a'.repeat(40)}]}});});
  await page.locator('#runAllBackups').click();await page.locator('#allBackupResult').getByText(/Snapshot saved/).waitFor();assert.equal((await api(base+'/backup-settings')).mode,'separate');
  await page.locator('#allBackupForget').click();await page.locator('#allBackupTokenStatus').getByText(/Saved token removed/).waitFor();assert.equal((await api('/api/github-token')).saved,false);
  await page.locator('#closeModal').click();await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);console.log('PASS backup menus, token link, saved-token reuse/forget, browser-storage exclusion and mobile wrapping');
 }finally{if(pid)await api('/api/projects/'+pid,'DELETE',{});await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
