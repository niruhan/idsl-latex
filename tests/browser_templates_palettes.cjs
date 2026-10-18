/* Public starters and palette controls, using only the disposable test account. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8878';
 const output=process.env.TEST_OUTPUT||path.join(process.cwd(),'artifacts');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'light'});
 const page=await context.newPage();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const get=async route=>(await(await context.request.get(origin+route)).json());
 const waitPalette=async id=>page.waitForFunction(id=>document.documentElement.dataset.palette===id,id);
 const snapshot=async name=>{await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:path.join(output,name+'.png'),fullPage:true,animations:'disabled'});};
 async function contrast(selector){return page.locator(selector).first().evaluate(async el=>{
  // Theme selection starts 150 ms color transitions; assess their settled colors.
  await Promise.allSettled(el.getAnimations().map(animation=>animation.finished));
  const rgb=value=>(value.match(/[\d.]+/g)||[]).slice(0,3).map(Number).map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;});
  const luminance=value=>{const c=rgb(value);return .2126*c[0]+.7152*c[1]+.0722*c[2];};
  const style=getComputedStyle(el),a=luminance(style.color),b=luminance(style.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
 });}
 try{
  await page.goto(origin);assert.equal((await context.request.get(origin+'/palettes.css')).status(),200);await page.locator('#authPaletteButton').click();assert.equal(await page.locator('[data-palette-choice]').count(),5);
  assert.deepEqual(await page.locator('[data-palette-choice]').evaluateAll(buttons=>buttons.map(button=>button.dataset.paletteChoice)),['forest','western','nord','github','solarized']);
  await page.locator('[data-palette-choice=western]').click();await waitPalette('western');await page.locator('#closeAppearance').click();
  await page.reload();await waitPalette('western');
  for(const [oldPalette,replacement] of [['catppuccin','nord'],['dracula','github']]){
   await page.evaluate(value=>localStorage.setItem('labtex-palette',value),oldPalette);await page.reload();await waitPalette(replacement);
   assert.equal(await page.evaluate(()=>localStorage.getItem('labtex-palette')),replacement);
  }
  await page.locator('#authPaletteButton').click();await page.locator('[data-palette-choice=western]').click();await page.locator('#closeAppearance').click();
  await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('.project-entry').first().waitFor();
  assert.equal(await page.locator('[data-starter]').count(),2);
  const colors=new Set();
  for(const palette of ['forest','western','nord','github','solarized']){
   await page.locator('#homeAccountButton').click();await page.locator('#accountAppearance').click();await page.locator('[data-palette-choice='+palette+']').click();await waitPalette(palette);
   assert.equal(await page.locator('[data-palette-choice='+palette+']').getAttribute('aria-pressed'),'true');
   for(const mode of ['light','dark']){
    await page.locator('#themePreference').selectOption(mode);await page.waitForFunction(mode=>document.documentElement.dataset.theme===mode,mode);
    for(const selector of ['#closeAppearance','.project-entry'])assert.ok(await contrast(selector)>=4.5,`${palette} ${mode} ${selector} must have readable text`);
    if(palette==='western'&&mode==='light')assert.equal(await page.locator('#projectHome').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)','Western explorer must use a white background');
   }
   colors.add(await page.locator('.home-topbar').evaluate(el=>getComputedStyle(el).backgroundColor));await page.locator('#closeAppearance').click();
   if(['nord','github'].includes(palette))await snapshot('palette-'+palette);
  }
  assert.equal(colors.size,5,'Every palette has a distinct interface color');
  await page.locator('#homeAccountButton').click();await page.locator('#accountAppearance').click();await page.locator('[data-palette-choice=western]').click();await page.locator('#themePreference').selectOption('light');await page.locator('#closeAppearance').click();
  const other=await context.newPage();await other.goto(origin);await other.locator('.project-entry').first().waitFor();await other.waitForFunction(()=>document.documentElement.dataset.palette==='western');
  await page.locator('#homeAccountButton').click();await page.locator('#accountAppearance').click();await page.locator('[data-palette-choice=solarized]').click();await other.waitForFunction(()=>document.documentElement.dataset.palette==='solarized');await page.locator('[data-palette-choice=western]').click();await page.locator('#closeAppearance').click();await other.close();
  await page.reload();await page.locator('.project-entry').first().waitFor();await waitPalette('western');await snapshot('western-theme-projects');
  console.log('PASS five light/dark palettes, contrast, direct selection, reload persistence and cross-tab synchronization');

  await page.locator('#createProjectFolder').click();await page.locator('#projectFolderName').fill('Template examples');await page.locator('#projectFolderForm button.primary').click();await page.locator('#projectFolderForm').waitFor({state:'hidden'});
  const folder=new URLSearchParams(new URL(page.url()).hash.slice(1)).get('folder');assert.ok(folder);
  await page.locator('[data-starter=western-presentation]').click();await page.locator('#workspace').waitFor({state:'visible'});const westernBuild=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');await page.locator('#compileButton').click();assert.equal((await(await westernBuild).json()).success,true);
  const western=new URLSearchParams(new URL(page.url()).hash.slice(1)).get('project');assert.equal((await get('/api/projects')).projects.find(p=>p.id===western).folder,folder);
  const source=await page.locator('#code').inputValue(),pdf=await page.locator('#pdfFrame').getAttribute('src');assert.match(source,/Your name/);assert.doesNotMatch(source,/Niruhan/);
  assert.equal(await page.locator('#pdfFrame').isHidden(),true);await snapshot('western-presentation-starter');
  await page.locator('#accountButton').click();await page.locator('#accountAppearance').click();await page.locator('[data-palette-choice=nord]').click();await page.locator('#closeAppearance').click();await page.locator('#themeButton').click();
  assert.equal(await page.locator('#code').inputValue(),source);assert.equal(await page.locator('#pdfFrame').getAttribute('src'),pdf,'Palette changes must not reload or recolor document PDFs');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'The mobile editor fits with both appearance controls');
  await page.locator('#accountButton').click();await page.locator('#accountAppearance').click();assert.equal(await page.locator('[data-palette-choice=nord]').getAttribute('aria-pressed'),'true');await page.locator('#closeAppearance').click();
  await page.locator('#projectsNavButton').click();await page.locator('[data-starter=neurips-2026]').waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'The mobile gallery fits');await snapshot('template-gallery-mobile');
  await page.setViewportSize({width:1440,height:1000});await page.locator('[data-starter=neurips-2026]').click();await page.locator('#workspace').waitFor({state:'visible'});assert.equal(await page.locator('#filePath').textContent(),'main.tex');
  const compiled=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST',{timeout:330000});await page.locator('#compileButton').click();const result=await(await compiled).json();assert.equal(result.success,true,result.log);
  await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));await page.locator('#accountButton').click();await page.locator('#accountAppearance').click();await page.locator('[data-palette-choice=western]').click();await page.locator('#themePreference').selectOption('light');await page.locator('#closeAppearance').click();await snapshot('neurips-starter');
  console.log('PASS Western and official NeurIPS starter builds, current-folder copies, placeholder metadata, mobile controls and source/PDF preservation');

  await page.locator('#projectsNavButton').click();await page.locator('#createProject').click();await page.locator('#newProjectForm input[name=name]').fill('A new conference paper');await page.locator('#newProjectForm select[name=format]').selectOption('latex');await page.locator('#newProjectForm select[name=template]').selectOption('neurips-2026');await page.locator('#newProjectForm button').click();await page.locator('#workspace').waitFor({state:'visible'});assert.match(await page.locator('#code').inputValue(),/usepackage\{neurips_2026\}/);
  await page.locator('#projectsNavButton').click();await page.locator('#homeAccountButton').click();await page.locator('#accountAppearance').click();await page.locator('[data-palette-choice=forest]').click();await page.locator('#closeAppearance').click();
  assert.deepEqual(errors,[]);console.log('PASS starter selection in New project, restoration of the original palette and no browser errors');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
