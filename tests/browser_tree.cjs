/* File-tree checks; run only against run_browser.py's disposable database. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN;assert.ok(origin,'Use tests/run_browser.py');
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext({viewport:{width:1440,height:960}});
 const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const fixtureNames=new Map();
 async function api(path,method='GET',data){const response=await context.request.fetch(origin+path,{method,headers:{Origin:origin},data});assert.equal(response.ok(),true,await response.text());return response.json();}
 const folder=path=>page.locator('.tree-folder[data-folder="'+path+'"]');
 const file=path=>page.locator('button.tree-file[title="'+path+'"]');
 async function open(id){await page.goto(origin+'/#project='+id);await page.waitForFunction(name=>document.querySelector('#projectTitle').textContent===name,fixtureNames.get(id));await page.locator('#workspace').waitFor({state:'visible'});await folder('images').waitFor();}
 async function fixture(name){
  const {id}=await api('/api/projects','POST',{name,format:'typst',template:false});
  for(const [path,content] of Object.entries({
   ...Object.fromEntries(Array.from({length:24},(_,i)=>['images/figure-'+i+'.svg','<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>'])),
   'images/nested/deep/notes.typ':'= A nested note',
   'sections/chapter.typ':'= A chapter'
  }))await api('/api/projects/'+id+'/file','PUT',{path,content,revision:0});
  fixtureNames.set(id,name);return id;
 }
 try{
  await page.goto(origin);await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});
  const first=await fixture('Folder navigation fixture'),second=await fixture('Independent folder preferences');
  const before=await api('/api/projects/'+first);
  await open(first);
  assert.equal(await page.locator('#fileTree > button.tree-file').first().getAttribute('title'),'main.typ');
  await folder('images').click();assert.equal(await folder('images').getAttribute('aria-expanded'),'false');assert.equal(await file('images/figure-0.svg').isVisible(),false);
  await file('sections/chapter.typ').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='sections/chapter.typ');assert.equal(await folder('images').getAttribute('aria-expanded'),'false');
  await page.waitForResponse(response=>response.url()===origin+'/api/projects/'+first&&response.request().method()==='GET');
  assert.equal(await folder('images').getAttribute('aria-expanded'),'false');
  await page.reload();await page.locator('#workspace').waitFor({state:'visible'});await folder('images').waitFor();assert.equal(await folder('images').getAttribute('aria-expanded'),'false');
  console.log('PASS root files remain accessible and collapsed folders persist through file changes, polling and reload');

  await folder('images').click();await folder('images/nested').press('Enter');assert.equal(await folder('images/nested').getAttribute('aria-expanded'),'false');
  await folder('images').click();await folder('images').press('Space');assert.equal(await folder('images/nested').getAttribute('aria-expanded'),'false');
  await folder('images').click();await page.locator('#fileFilter').fill('notes.typ');await file('images/nested/deep/notes.typ').waitFor({state:'visible'});
  assert.equal(await folder('images').getAttribute('aria-expanded'),'true');assert.equal(await folder('images/nested').getAttribute('aria-expanded'),'true');
  await page.locator('#fileFilter').fill('');assert.equal(await folder('images').getAttribute('aria-expanded'),'false');
  await page.locator('#fileFilter').fill('notes.typ');await file('images/nested/deep/notes.typ').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='images/nested/deep/notes.typ');
  await page.locator('#fileFilter').fill('');assert.equal(await folder('images').getAttribute('aria-expanded'),'true');assert.equal(await folder('images/nested').getAttribute('aria-expanded'),'true');
  await folder('images').click();
  console.log('PASS nested folders, Enter/Space controls, search inside collapsed folders and revealing opened files');

  await open(second);assert.equal(await folder('images').getAttribute('aria-expanded'),'true');
  await open(first);assert.equal(await folder('images').getAttribute('aria-expanded'),'false');
  const after=await api('/api/projects/'+first);assert.equal(after.revision,before.revision);assert.deepEqual(after.files,before.files);
  const output=process.env.TEST_OUTPUT||path.join(process.cwd(),'artifacts');fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'collapsed-folders.png')});
  assert.deepEqual(errors,[]);console.log('PASS independent project preferences, unchanged source revisions and no browser errors');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
