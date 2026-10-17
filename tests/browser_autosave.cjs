/* Autosave/navigation checks on disposable fixtures; never use a real database. */
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN,browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext(),page=await context.newPage(),errors=[],ids=[],names=new Map();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 async function api(url,method='GET',data){const response=await context.request.fetch(origin+url,{method,headers:{Origin:origin},data});assert.equal(response.ok(),true,await response.text());return response.json();}
 const projectUrl=id=>origin+'/#project='+id;
 async function open(id){await page.goto(projectUrl(id));await page.waitForFunction(name=>document.querySelector('#projectTitle').textContent===name&&!document.querySelector('#workspace').hidden&&!document.querySelector('#workspace').inert,names.get(id));}
 async function content(id,path){return (await api('/api/projects/'+id+'/file?path='+encodeURIComponent(path))).content;}
 async function saved(){await page.waitForFunction(()=>document.querySelector('#saveStatus').textContent==='All changes saved');}
 async function eventually(fn){for(let i=0;i<100;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail('Expected saved content was not persisted');}
 async function fixture(format){const name='Autosave '+format,id=(await api('/api/projects','POST',{name,format,template:false})).id;ids.push(id);names.set(id,name);await page.evaluate(id=>localStorage.setItem('labtex-auto:'+id,'false'),id);return id;}
 try{
  await page.goto(origin);if(await page.locator('#tokenLabel').isVisible()){await page.locator('#nameLabel input').fill('Browser Test Owner');await page.locator('input[name=token]').fill('local-browser-test-only');}await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});
  const typst=await fixture('typst'),latex=await fixture('latex'),code=page.locator('#code');
  for(const [id,path] of [[typst,'main.typ'],[latex,'main.tex']]){
   await open(id);const text='Saved before leaving '+path;await code.fill(text);await page.locator('#projectsNavButton').click();await page.locator('#projectHome').waitFor({state:'visible'});assert.equal(await content(id,path),text);
   await open(id);await code.fill('Account autosave');await page.locator('#accountButton').click();await page.locator('#accountProjects').click();await page.locator('#projectHome').waitFor({state:'visible'});assert.equal(await content(id,path),'Account autosave');
  }
  console.log('PASS immediate project exit saves LaTeX/Typst source edits through navigation and account menu');

  await open(typst);const large='Large source '.repeat(6000);await code.fill(large);await page.locator('#projectsNavButton').click();await page.locator('#projectHome').waitFor({state:'visible'});assert.equal(await content(typst,'main.typ'),large);
  await open(typst);let temporaryFailure=true;const savePattern='**/api/projects/'+typst+'/file';await page.route(savePattern,async route=>{if(route.request().method()==='PUT'&&temporaryFailure){temporaryFailure=false;await route.fulfill({status:503,json:{error:'Temporary autosave outage'}});}else await route.continue();});await code.fill('Automatic retry draft');await page.locator('#saveStatus.error').waitFor();await saved();assert.equal(await content(typst,'main.typ'),'Automatic retry draft');await page.unroute(savePattern);
  console.log('PASS large document navigation saves and automatic retry after a temporary server error');

  // Continue typing faster than the pause debounce, to exercise the maximum wait.
  await open(typst);await code.fill('Continuous ');await saved();await code.evaluate(area=>{area.focus();area.setSelectionRange(area.value.length,area.value.length);});
  const writes=[];const listener=request=>{if(request.method()==='PUT'&&request.url().endsWith('/'+typst+'/file'))writes.push({time:Date.now(),text:request.postDataJSON().content});};page.on('request',listener);const start=Date.now();await code.pressSequentially('abcdefghijklmnopqrst',{delay:350});page.off('request',listener);
  assert.ok(writes.some(write=>write.time-start<6500&&write.text!=='Continuous abcdefghijklmnopqrst'),'Continuous typing must save before the final pause');await saved();assert.equal(await content(typst,'main.typ'),'Continuous abcdefghijklmnopqrst');
  await code.fill('Saved on blur');await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await eventually(async()=>await content(typst,'main.typ')==='Saved on blur');
  console.log('PASS autosave during continuous typing, after a pause, and when the editor loses focus');

  // A slow save must hold navigation, including edits made during an older save.
  let release,started;const gate=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>started=resolve);let held=false;
  await page.route(savePattern,async route=>{if(route.request().method()==='PUT'&&!held){held=true;started();await gate;}await route.continue();});
  await code.fill('First in-flight draft');await seen;await code.fill('Latest in-flight draft');await page.locator('#projectsNavButton').click();
  assert.equal(await page.locator('#workspace').evaluate(el=>el.inert),true);assert.equal(await page.locator('#projectHome').isHidden(),true);await page.keyboard.type('must not enter the departing file');release();await page.locator('#projectHome').waitFor({state:'visible'});await page.unroute(savePattern);assert.equal(await content(typst,'main.typ'),'Latest in-flight draft');
  console.log('PASS slow in-flight saves flush the latest draft before leaving and freeze the departing editor');

  // Browser Back must flush before rendering the explorer, and Forward reloads it.
  await page.locator('.project-entry[href="#project='+typst+'"]').click();await page.waitForFunction(()=>!document.querySelector('#workspace').hidden&&!document.querySelector('#workspace').inert);await code.fill('Saved by browser Back');await page.goBack();await page.locator('#projectHome').waitFor({state:'visible'});assert.equal(await content(typst,'main.typ'),'Saved by browser Back');await page.goForward();await page.locator('#workspace').waitFor({state:'visible'});assert.equal(await code.inputValue(),'Saved by browser Back');

  // Failed saves preserve text, restore the editor URL and keep navigation blocked.
  let failOnce=true;await page.route(savePattern,async route=>{if(route.request().method()==='PUT'&&failOnce){failOnce=false;await route.fulfill({status:503,json:{error:'Temporary test outage'}});}else await route.continue();});
  await code.fill('Retain this draft on error');await page.evaluate(()=>history.back());await page.locator('#saveStatus.error').waitFor();assert.equal(await page.locator('#projectHome').isHidden(),true);assert.equal(await code.inputValue(),'Retain this draft on error');assert.equal(new URL(page.url()).hash,'#project='+typst);await page.locator('#projectsNavButton').click();await page.locator('#projectHome').waitFor({state:'visible'});await page.unroute(savePattern);assert.equal(await content(typst,'main.typ'),'Retain this draft on error');
  console.log('PASS browser Back/Forward autosave and safe navigation recovery after save failure');

  await open(latex);await code.fill('Saved before sign-out');await page.locator('#accountButton').click();await page.locator('#signOut').click();await page.locator('#auth').waitFor({state:'visible'});await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});assert.equal(await content(latex,'main.tex'),'Saved before sign-out');console.log('PASS sign-out waits for the final editor save');

  // A real page unload starts a keepalive save before the browser leaves.
  await open(typst);await code.fill('Saved while unloading');await page.goto(origin+'/favicon.svg');await eventually(async()=>await content(typst,'main.typ')==='Saved while unloading');
  await open(typst);await api('/api/projects/'+typst+'/file','PUT',{path:'second.typ',content:'Second file',revision:0});await page.reload();await page.waitForFunction(()=>!document.querySelector('#workspace').hidden&&!document.querySelector('#workspace').inert);
  // Loading another file cannot allow fresh edits to land in the departing one.
  let loadRelease,loadStarted;const loadGate=new Promise(resolve=>loadRelease=resolve),loadSeen=new Promise(resolve=>loadStarted=resolve);const filePattern='**/api/projects/'+typst+'/file?path=second.typ';await page.route(filePattern,async route=>{loadStarted();await loadGate;await route.continue();});await code.fill('Saved before file switch');await page.locator('.tree-file[title="second.typ"]').click();await loadSeen;assert.equal(await page.locator('#workspace').evaluate(el=>el.inert),true);await page.keyboard.type('discarded typing');loadRelease();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='second.typ'&&!document.querySelector('#workspace').inert);await page.unroute(filePattern);assert.equal(await content(typst,'main.typ'),'Saved before file switch');assert.equal(await code.inputValue(),'Second file');
  console.log('PASS page-unload save and safe file switching during delayed loads');

  // Coauthor conflicts never get overwritten to make navigation succeed.
  const current=await api('/api/projects/'+typst+'/file?path=second.typ');await api('/api/projects/'+typst+'/file','PUT',{path:'second.typ',content:'Coauthor version',revision:current.revision});await code.fill('My conflicting draft');await page.locator('#projectsButton').click();await page.locator('#localConflict').waitFor();assert.equal(await page.locator('#localConflict').inputValue(),'My conflicting draft');assert.equal(await page.locator('#serverConflict').inputValue(),'Coauthor version');assert.equal(await page.locator('#projectHome').isHidden(),true);assert.equal(await content(typst,'second.typ'),'Coauthor version');
  console.log('PASS conflict protection keeps both drafts and prevents leaving with unsaved edits');assert.deepEqual(errors,[]);
 }finally{for(const id of ids)await api('/api/projects/'+id,'DELETE',{});await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
