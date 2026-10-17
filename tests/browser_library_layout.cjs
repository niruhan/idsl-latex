/* Library, account dropdown, and explorer layout on disposable fixtures only. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8878';
 const output=process.env.TEST_OUTPUT||path.join(process.cwd(),'artifacts');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'light'});
 const page=await context.newPage();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function api(route,method='GET',data){const response=await context.request.fetch(origin+route,{method,headers:{Origin:origin},data});assert.ok(response.ok(),await response.text());return response.json();}
 const openLibrary=async()=>{await page.locator('#browseTemplates').click();await page.locator('#templateLibrary').waitFor();};
 try{
  await page.goto(origin);await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('.project-entry').first().waitFor();
  const before=(await api('/api/projects')).projects.length;
  assert.equal(await page.locator('#starterProjects [data-starter]').count(),2);assert.equal(await page.locator('.home-sample').count(),0);
  await openLibrary();assert.equal(await page.locator('#templateLibrary [data-starter]').count(),6);
  await page.locator('#templateFormat').selectOption('latex');assert.equal(await page.locator('#templateLibrary [data-starter]').count(),2);
  await page.locator('#templateSearch').fill('article');assert.equal(await page.locator('#templateLibrary [data-starter]').count(),1);
  await page.locator('#templateSearch').fill('no such template');await page.locator('#templatesEmpty').waitFor({state:'visible'});
  await page.keyboard.press('Escape');assert.equal((await api('/api/projects')).projects.length,before);
  await page.reload();await page.locator('.project-entry').first().waitFor();assert.equal((await api('/api/projects')).projects.length,before);
  const folder=await api('/api/project-folders','POST',{name:'Library layout fixtures'});
  await page.goto(origin+'/#projects&folder='+folder.id);await page.locator('#folderLocation').waitFor({state:'visible'});await openLibrary();
  await page.locator('[data-starter=academic-cv]').click();await page.locator('#workspace').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));
  const created=new URLSearchParams(new URL(page.url()).hash.slice(1)).get('project');assert.equal((await api('/api/projects')).projects.find(p=>p.id===created).folder,folder.id);
  const source=await page.locator('#code').inputValue();assert.match(source,/Alex Researcher/);assert.doesNotMatch(source,/Niruhan/);
  await page.locator('#accountButton').click();await page.locator('#accountDropdown').waitFor({state:'visible'});assert.equal(await page.locator('#modal').evaluate(el=>el.open),false);
  await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.id),'deleteProject');
  await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement.id),'accountProjects');
  await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.id),'accountAppearance');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#accountDropdown').isHidden(),true);assert.equal(await page.evaluate(()=>document.activeElement.id),'accountButton');
  await page.locator('#accountButton').click();await page.locator('.account-menu-heading').click();assert.equal(await page.locator('#accountDropdown').isVisible(),true);
  await page.locator('#code').evaluate(area=>{for(const name of ['pointerdown','click'])area.addEventListener(name,event=>event.stopPropagation(),{once:true});});
  const codeBox=await page.locator('#code').boundingBox();await page.mouse.move(codeBox.x+20,codeBox.y+20);await page.mouse.down();
  assert.equal(await page.locator('#accountDropdown').isHidden(),true,'Outside pointer presses close the menu even when the source editor stops bubbling');await page.mouse.up();
  await page.locator('#accountButton').click();await page.locator('#pdfFrame').click();await page.locator('#accountDropdown').waitFor({state:'hidden'});
  await page.locator('#accountButton').click();await page.locator('#accountButton').click();assert.equal(await page.locator('#accountDropdown').isHidden(),true,'The avatar still toggles its own menu');
  await page.locator('#accountButton').click();await page.locator('#accountProjects').click();await page.locator('#projectHome').waitFor({state:'visible'});
  await page.locator('#homeAccountButton').click();await page.locator('#homeHeading').click();assert.equal(await page.locator('#accountDropdown').isHidden(),true);
  await page.goto(origin+'/#projects');await page.locator('.project-directory[data-folder="'+folder.id+'"]').waitFor();
  for(const viewport of [{width:1920,height:1080},{width:1440,height:900},{width:1280,height:720},{width:390,height:844}]){
   await page.setViewportSize(viewport);await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
   const layout=await page.evaluate(()=>{const footer=document.querySelector('.home-footer').getBoundingClientRect(),sidebar=document.querySelector('.home-sidebar-foot'),tiles=[...document.querySelectorAll('#projectList>.project-item,#projectList>.project-directory')].map(el=>el.getBoundingClientRect());return {gap:innerHeight-footer.bottom,footTop:footer.top,sidebarGap:getComputedStyle(sidebar).display==='none'?null:innerHeight-sidebar.getBoundingClientRect().bottom,heights:tiles.map(r=>Math.round(r.height)),widths:tiles.map(r=>Math.round(r.width)),overflow:document.documentElement.scrollWidth>innerWidth};});
   assert.ok(layout.gap>=28,JSON.stringify({viewport,layout}));assert.ok(layout.footTop>=0);if(layout.sidebarGap!==null)assert.ok(layout.sidebarGap>=28,JSON.stringify({viewport,layout}));
   assert.equal(layout.overflow,false);assert.equal(new Set(layout.heights).size,1,'Folder/project tiles must have equal heights');assert.ok(Math.max(...layout.widths)-Math.min(...layout.widths)<=1);
   await page.evaluate(()=>scrollTo(0,0));await page.locator('#homeAccountButton').click();
   const menu=await page.locator('#accountDropdown').boundingBox();assert.ok(menu.x>=0&&menu.x+menu.width<=viewport.width&&menu.y+menu.height<=viewport.height);
   await page.keyboard.press('Escape');
  }
  await openLibrary();assert.ok(await page.evaluate(()=>document.querySelector('#modalBody').scrollWidth<=document.querySelector('#modalBody').clientWidth),'Mobile template cards must fit');await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.screenshot({path:path.join(output,'explorer-footer-tiles.png'),animations:'disabled'});
  await api('/api/projects/'+created,'DELETE',{});await api('/api/project-folders/'+folder.id,'DELETE',{});
  assert.deepEqual(errors,[]);console.log('PASS searchable template library, explicit private copies, account dropdown keyboard/outside dismissal, equal tile sizes and unclipped footers at four viewport sizes');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
