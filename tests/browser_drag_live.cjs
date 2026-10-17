const {editorOption}=require('./editor_ui.cjs');
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
  await page.locator('.project-entry[data-project="'+pid+'"]').click();await page.locator('#workspace').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#workspace').inert);
  await page.locator('.tree-file[title="main.typ"]').dragTo(page.locator('.tree-folder[data-folder="notes"]'));
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='notes/main.typ');assert.equal((await api(base)).main,'notes/main.typ');
  await page.locator('.tree-folder[data-folder="notes"]').dragTo(page.locator('.tree-folder[data-folder="images"]'));
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='images/notes/main.typ');assert.equal((await api(base)).main,'images/notes/main.typ');
  await page.locator('.tree-folder[data-folder="images/notes"]').dragTo(page.locator('#fileRootDrop'));
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='notes/main.typ');
  const download=page.waitForEvent('download');await editorOption(page,'exportSourceButton');assert.equal((await download).suggestedFilename(),'Live drag document.zip');
  console.log('PASS editor file/folder/root drag, main-document tracking and project-named source ZIP');

  await page.locator('#code').fill('= Export document\n\nA valid Typst document.\n');
  const pdfDownload=page.waitForEvent('download');await page.locator('#downloadButton').click();const pdf=await pdfDownload;assert.equal(pdf.suggestedFilename(),'Live drag document.pdf');assert.equal(await page.locator('#pdfFrame').isHidden(),true);assert.equal(await page.locator('#openPdfButton').isHidden(),true);assert.equal(await page.locator('#autoCompile').isHidden(),true);
  console.log('PASS Typst PDF export without an embedded PDF view or background PDF compilation');

  await api('/api/backup-settings','PUT',{repository:'example/research-documents'});await page.locator('#accountButton').click();assert.equal(await page.locator('#accountBackups').count(),0,'All-project backups belong only in the explorer');await page.locator('#accountProjectBackup').click();assert.equal(await page.locator('#backupAll').count(),0,'Editor backup dialog must only back up its current project');assert.match(await page.locator('#backupPath').textContent(),/project name/);assert.equal((await page.locator('#backupPath').textContent()).includes(pid),false);assert.equal(await page.locator('#backupSharedRepo').count(),0);assert.match(await page.locator('#projectGlobalBackup').textContent(),/example\/research-documents/);if(process.env.CAPTURE_BACKUP_DOC==='1'){await page.screenshot({path:'docs/images/github-backups.png',fullPage:true});}await page.locator('#backupMode').selectOption('separate');await page.locator('#backupProjectRepo').fill('example/separate-document');await page.locator('#backupForm button[type=submit]').click();await page.locator('#backupResult').getByText('Backup settings saved.',{exact:false}).waitFor();await page.locator('#closeModal').click();
  await page.locator('#projectsNavButton').click();await page.locator('#homeAccountButton').click();await page.locator('#accountBackups').click();
  assert.equal(await page.locator('#allBackupsForm a').getAttribute('href'),'https://github.com/settings/personal-access-tokens/new');
  await page.locator('#allBackupRepo').fill('example/all-documents');await page.locator('#allBackupToken').fill('test-only-saved-browser-credential');await page.locator('#saveAllBackupSettings').click();await page.locator('#allBackupResult').getByText('Shared repository settings saved.').waitFor();
  assert.equal(await page.locator('#allBackupToken').inputValue(),'');assert.equal((await api('/api/github-token')).saved,true);
  await page.reload();await page.locator('#projectHome').waitFor({state:'visible'});await page.locator('#homeAccountButton').click();await page.locator('#accountBackups').click();assert.match(await page.locator('#allBackupTokenStatus').textContent(),/A token is saved/);
  assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('test-only-saved-browser-credential')),false);
  await page.route('**/api/backups',async route=>{assert.deepEqual(route.request().postDataJSON(),{token:'',sharedOnly:true});await route.fulfill({json:{results:[{name:'Live drag document',changed:true,repository:'example/all-documents',folder:'projects/Live drag document',url:'https://github.com/example/all-documents/commit/'+'a'.repeat(40)}]}});});
  await page.locator('#runAllBackups').click();await page.locator('#allBackupResult').getByText(/Snapshot saved/).waitFor();assert.match(await page.locator('#allBackupResult').textContent(),/example\/all-documents\/projects\/Live drag document/);assert.equal((await api(base+'/backup-settings')).mode,'separate');
  await page.locator('#closeModal').click();
  const projectRevision=(await api(base)).revision;
  let sharedStatus={included:true,repository:'example/all-documents',branch:'',stale:true,snapshot:{folder:'projects/Live drag document',last_commit:'b'.repeat(40),last_url:'https://github.com/example/all-documents/commit/'+'b'.repeat(40),last_revision:projectRevision-1,updated:1}},projectUpdates=0,allUpdates=0,failShared=false;
  const countBulk=request=>{if(request.method()==='POST'&&request.url().endsWith('/api/backups'))allUpdates++;};page.on('request',countBulk);
  await page.route('**'+base+'/backup-settings',async route=>{assert.equal(route.request().method(),'GET','Updating the global snapshot must not rewrite separate-project settings');const response=await route.fetch();const value=await response.json();await route.fulfill({response,json:{...value,global_backup:sharedStatus}});});
  await page.route('**'+base+'/backup',async route=>{assert.deepEqual(route.request().postDataJSON(),{token:'',sharedOnly:true});projectUpdates++;if(failShared){await route.fulfill({status:502,json:{error:'Test shared backup failed'}});return;}sharedStatus={...sharedStatus,stale:false,snapshot:{...sharedStatus.snapshot,last_commit:'a'.repeat(40),last_url:'https://github.com/example/all-documents/commit/'+'a'.repeat(40),last_revision:projectRevision,updated:2}};await route.fulfill({json:{name:'Live drag document',changed:true,repository:'example/all-documents',folder:'projects/Live drag document',commit:'a'.repeat(40),url:sharedStatus.snapshot.last_url}});});
  await page.goto(origin+'/#project='+pid);await page.locator('#workspace').waitFor({state:'visible'});await editorOption(page,'backupButton');
  assert.equal(await page.getByRole('button',{name:/Back up all/i}).count(),0);assert.equal(await page.locator('#backupSharedRepo').count(),0);assert.equal(await page.locator('#backupMode').inputValue(),'separate');
  assert.match(await page.locator('#globalBackupRepository').textContent(),/example\/all-documents/);assert.match(await page.locator('#globalBackupStatus').textContent(),/Changes since/);await page.locator('#updateGlobalBackup').click();
  await page.locator('#globalBackupStatus').getByText(/saved changes are backed up/).waitFor();assert.equal(projectUpdates,1);assert.equal(allUpdates,0);assert.equal((await api(base+'/backup-settings')).repository,'example/separate-document');assert.equal(await page.locator('#backupMode').inputValue(),'separate');
  if(process.env.CAPTURE_BACKUP_DOC==='1'){await page.locator('#backupMode').selectOption('shared');await page.screenshot({path:'docs/images/github-backups.png',fullPage:true});}
  failShared=true;await page.locator('#updateGlobalBackup').click();await page.locator('#backupResult').getByText('Test shared backup failed').waitFor();assert.match(await page.locator('#projectGlobalBackup').textContent(),/Last snapshot aaaaaaaa/);assert.equal(allUpdates,0);
  await page.locator('#closeModal').click();await page.unroute('**'+base+'/backup-settings');await page.unroute('**'+base+'/backup');page.off('request',countBulk);
  await page.locator('#projectsNavButton').click();await page.locator('#homeAccountButton').click();await page.locator('#accountBackups').click();
  console.log('PASS editor backup scope, independent global snapshot status, one-project shared update, failure preservation and unchanged separate destination');
  await page.locator('#allBackupForget').click();await page.locator('#allBackupTokenStatus').getByText(/Saved token removed/).waitFor();assert.equal((await api('/api/github-token')).saved,false);
  await page.locator('#closeModal').click();await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);console.log('PASS backup menus, token link, saved-token reuse/forget, browser-storage exclusion and mobile wrapping');
 }finally{if(pid)await api('/api/projects/'+pid,'DELETE',{});await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
