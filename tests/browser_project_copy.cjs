// Project copies and root navigation on disposable fixtures.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN;assert.ok(origin);
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN}),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
 page.setDefaultTimeout(15000);const errors=[],owned=[];page.on('pageerror',error=>errors.push(error.message));
 async function api(route,method='GET',data){const response=await context.request.fetch(origin+route,{method,headers:{Origin:origin},data});assert.ok(response.ok(),await response.text());return response.json();}
 const entry=id=>page.locator('.project-entry[data-project="'+id+'"]');
 async function ready(){await page.waitForFunction(()=>!document.querySelector('#workspace').hidden&&!document.querySelector('#workspace').inert);}
 async function inFolder(id){await page.waitForURL('**/#projects&folder='+id);await page.locator('#folderLocation').waitFor({state:'visible'});assert.equal(await page.locator('#folderLocation').getByRole('link',{name:'All projects',exact:true}).count(),1);assert.equal(await page.locator('#folderLocation').getByRole('button',{name:'All projects',exact:true}).count(),0);}
 async function atRoot(){await page.waitForURL('**/#projects');await page.locator('#projectHome').waitFor({state:'visible'});await page.locator('#folderLocation').waitFor({state:'hidden'});assert.equal(await page.locator('#homeHeading').textContent(),'All projects');}
 async function openFolder(id){await page.locator('.home-folder-link[data-folder="'+id+'"]').click();await inFolder(id);}
 async function duplicate(id,name){await page.locator('[data-project-actions="'+id+'"] summary').click();await page.locator('[data-duplicate-project="'+id+'"]').click();await page.locator('.project-entry h2').getByText(name,{exact:true}).waitFor();const copy=(await api('/api/projects')).projects.find(project=>project.name===name);assert.ok(copy);owned.push(copy.id);return copy;}
 try{
  await page.goto(origin);await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});
  const parent=(await api('/api/project-folders','POST',{name:'Copy navigation fixtures'})).id,folder=(await api('/api/project-folders','POST',{name:'Nested copies',parent})).id;
  const source=(await api('/api/projects','POST',{name:'Nested source fixture',format:'typst',template:false,folder})).id;owned.push(source);
  const latex=(await api('/api/projects','POST',{name:'Root source fixture',format:'latex',template:false})).id;owned.push(latex);
  const base='/api/projects/'+source;await api(base+'/file','PUT',{path:'sections/slides.typ',content:'= Selected main source',revision:0});await api(base+'/file','PUT',{path:'images/figure.svg',content:'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',revision:0});await api(base,'PUT',{main:'sections/slides.typ'});const original=await api(base);
  await page.goto(origin+'/#projects&folder='+folder);await inFolder(folder);await entry(source).waitFor();
  const first=await duplicate(source,'Nested source fixture (copy)');assert.equal(first.folder,folder);assert.equal(first.role,'owner');assert.equal(first.main,'sections/slides.typ');assert.deepEqual(await api(base),original);assert.equal(await page.locator('#workspace').isHidden(),true);
  assert.equal((await api('/api/projects/'+first.id+'/file?path=images/figure.svg')).content,(await api(base+'/file?path=images/figure.svg')).content);
  await page.locator('#projectListView').click();const second=await duplicate(source,'Nested source fixture (copy 2)');assert.equal(second.folder,folder);
  await api('/api/projects/'+first.id+'/file','PUT',{path:'sections/slides.typ',content:'= Independent copy edit',revision:1});assert.equal((await api(base+'/file?path=sections/slides.typ')).content,'= Selected main source');
  await entry(source).click();await ready();await page.locator('#projectsNavButton').click();await atRoot();assert.equal(await entry(source).count(),0);
  await openFolder(folder);await entry(source).click();await ready();await page.reload();await ready();const edited='= Saved before returning to the root';await page.locator('#code').fill(edited);await page.locator('#projectsNavButton').click();await atRoot();assert.equal((await api(base+'/file?path=sections/slides.typ')).content,edited);
  // A global search/filter can open a nested project without prior folder state.
  await page.locator('[data-project-filter=typst]').click();await entry(source).click();await ready();await page.locator('#projectsNavButton').click();await atRoot();
  // Direct editor links and both account menus consistently open the root.
  await page.goto(origin+'/#project='+source);await ready();await page.locator('#accountButton').click();await page.locator('#accountProjects').click();await atRoot();
  await openFolder(folder);await page.locator('#homeAccountButton').click();await page.locator('#accountProjects').click();await atRoot();
  await openFolder(folder);await entry(source).click();await ready();await page.locator('#projectsButton').click();await atRoot();await entry(latex).click();await ready();await page.reload();await ready();await page.locator('#projectsNavButton').click();await atRoot();
  const rootCopy=await duplicate(latex,'Root source fixture (copy)');assert.equal(rootCopy.folder,null);
  await page.setViewportSize({width:390,height:844});await page.goto(origin+'/#projects&folder='+folder);await inFolder(folder);await entry(source).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await entry(source).click();await ready();await page.locator('#projectsNavButton').click();await atRoot();
  assert.deepEqual(errors,[]);console.log('PASS independent Typst/LaTeX copies in the same root/nested folder, unique names, selected main/assets, grid/list menus, autosave and root navigation after reload/direct links/global filters/account menus, one root breadcrumb and mobile layout');
 }finally{for(const id of owned)await api('/api/projects/'+id,'DELETE',{}).catch(()=>{});await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
