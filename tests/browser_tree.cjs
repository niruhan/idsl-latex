const {editorOption}=require('./editor_ui.cjs');
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
   'images/safe-image.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" onload="window.svgPreviewExecuted=true"><rect width="160" height="100" fill="#edf2e8"/><circle cx="80" cy="50" r="30" fill="#27654e"/><script>window.svgPreviewExecuted=true;</script><image href="https://example.test/preview-probe.png"/></svg>',
   'images/nested/deep/notes.typ':'= A nested note',
   'sections/chapter.typ':'= A chapter'
  }))await api('/api/projects/'+id+'/file','PUT',{path,content,revision:0});
  await api('/api/projects/'+id+'/file','PUT',{path:'images/pixel.png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=',revision:0});
  fixtureNames.set(id,name);return id;
 }
 try{
  await page.goto(origin);await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});
  const first=await fixture('Folder navigation fixture'),second=await fixture('Independent folder preferences');
  const before=await api('/api/projects/'+first);
  await open(first);
  assert.equal(await page.locator('#fileTree > button.tree-file').first().getAttribute('title'),'main.typ');
  const svgBefore=await api('/api/projects/'+first+'/file?path=images/safe-image.svg'),external=[];page.on('request',request=>{if(request.url().includes('example.test/preview-probe'))external.push(request.url());});
  await file('images/safe-image.svg').click();await page.locator('#binaryPreview img').waitFor();await page.waitForFunction(()=>{const image=document.querySelector('#binaryPreview img');return image.complete&&image.naturalWidth===160;});
  assert.equal(await page.locator('#sourceEditor').isHidden(),true);assert.equal(await page.locator('#assetPreviewTab').textContent(),'Preview');assert.equal(await page.evaluate(()=>Boolean(window.svgPreviewExecuted)),false);assert.equal(await page.locator('#binaryPreview svg,#binaryPreview script,#binaryPreview iframe').count(),0);assert.deepEqual(external,[]);
  const imageOutput=process.env.TEST_OUTPUT||path.join(process.cwd(),'artifacts');fs.mkdirSync(imageOutput,{recursive:true});await page.screenshot({path:path.join(imageOutput,'svg-image-preview.png'),animations:'disabled'});
  await editorOption(page,'sourceTab');assert.equal(await page.locator('#code').inputValue(),svgBefore.content);assert.equal(await page.locator('#binaryPreview').isHidden(),true);
  await editorOption(page,'assetPreviewTab');await page.locator('#binaryPreview img').waitFor();
  await file('images/pixel.png').click();await page.waitForFunction(()=>{const image=document.querySelector('#binaryPreview img');return image?.complete&&image.naturalWidth===1;});assert.equal(await page.locator('#sourceTab').isDisabled(),true);
  await file('main.typ').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='main.typ');assert.equal(await page.locator('#sourceTab').getAttribute('aria-pressed'),'true');await file('images/safe-image.svg').click();await page.locator('#binaryPreview img').waitFor();await file('main.typ').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='main.typ');assert.equal(await page.locator('#sourceEditor').isVisible(),true);assert.equal(await page.locator('#assetPreviewTab').isHidden(),true);
  assert.deepEqual(await api('/api/projects/'+first+'/file?path=images/safe-image.svg'),svgBefore);
  console.log('PASS SVG/raster image previews, optional SVG source, inert SVG scripts/external resources, restored document mode and unchanged asset bytes');
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
