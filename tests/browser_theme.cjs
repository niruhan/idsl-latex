const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8878';
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext({viewport:{width:1440,height:960},colorScheme:'light'});
 const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function resolved(value){await page.waitForFunction(value=>document.documentElement.dataset.theme===value,value);}
 async function choose(button,value){assert.equal(await page.locator(button).getAttribute('aria-label'),'Switch to '+value+' theme');await page.locator(button).click();await resolved(value);assert.equal(await page.locator('#modal').evaluate(el=>el.open),false,'Theme switching must not open a dialog');}
 try{
  await page.goto(origin);await page.locator('#auth').waitFor({state:'visible'});await resolved('light');
  await page.emulateMedia({colorScheme:'dark'});await resolved('dark');await page.emulateMedia({colorScheme:'light'});await resolved('light');
  await choose('#authThemeButton','dark');await resolved('dark');await page.reload();await page.locator('#auth').waitFor({state:'visible'});await resolved('dark');
  await page.emulateMedia({colorScheme:'light'});await resolved('dark');await choose('#authThemeButton','light');
  console.log('PASS default system theme, one-click switching before sign-in, reload persistence and explicit preference');
  await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();
  await page.locator('#projectHome').waitFor({state:'visible'});await page.locator('.project-entry').first().waitFor();
  await choose('#homeThemeButton','dark');await resolved('dark');
  assert.notEqual(await page.locator('.project-entry').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
  const other=await context.newPage();await other.goto(origin);await other.locator('#projectHome').waitFor({state:'visible'});assert.equal(await other.evaluate(()=>document.documentElement.dataset.theme),'dark');
  await choose('#homeThemeButton','light');await other.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  await choose('#homeThemeButton','dark');await other.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await other.close();
  console.log('PASS home uses the dark palette and appearance updates synchronize between tabs');
  await page.locator('.project-entry').filter({hasText:'Getting started with Typst'}).click();await page.locator('#workspace').waitFor({state:'visible'});const source=await page.locator('#code').inputValue();
  const pdf=await page.locator('#pdfFrame').getAttribute('src');assert.ok(pdf);
  const pdfUrl=origin+pdf.split('#')[0],digest=async()=>crypto.createHash('sha256').update(await(await context.request.get(pdfUrl)).body()).digest('hex'),originalDigest=await digest();
  assert.equal(await page.locator('#pdfThemeButton').getAttribute('aria-pressed'),'false');
  await page.locator('#pdfThemeButton').click();assert.equal(await page.locator('#pdfThemeButton').getAttribute('aria-pressed'),'true');await resolved('dark');
  assert.notEqual(await page.locator('#pdfFrame').evaluate(el=>getComputedStyle(el).filter),'none');
  const output=process.env.TEST_OUTPUT||path.join(process.cwd(),'artifacts');fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'pdf-preview-dark.png'),animations:'disabled'});
  await choose('#themeButton','light');await resolved('light');assert.equal(await page.locator('#code').inputValue(),source);assert.equal(await page.locator('#pdfFrame').getAttribute('src'),pdf);
  assert.equal(await page.locator('#pdfThemeButton').getAttribute('aria-pressed'),'true','PDF colors are independent of interface colors');
  await page.reload();await page.locator('#workspace').waitFor({state:'visible'});await resolved('light');assert.equal(await page.locator('#pdfThemeButton').getAttribute('aria-pressed'),'true');
  const pdfTab=await context.newPage();await pdfTab.goto(origin+'/#project='+new URLSearchParams(new URL(page.url()).hash.slice(1)).get('project'));await pdfTab.locator('#workspace').waitFor({state:'visible'});assert.equal(await pdfTab.locator('#pdfThemeButton').getAttribute('aria-pressed'),'true');
  await page.locator('#pdfThemeButton').click();await pdfTab.waitForFunction(()=>document.querySelector('#pdfThemeButton').getAttribute('aria-pressed')==='false');await pdfTab.close();
  assert.equal(await page.locator('#pdfFrame').evaluate(el=>getComputedStyle(el).filter),'none');assert.equal(await digest(),originalDigest);assert.equal(await page.locator('#code').inputValue(),source);
  await page.screenshot({path:path.join(output,'pdf-preview-original.png'),animations:'disabled'});
  console.log('PASS independent PDF dark colors, reload/tab persistence, and identical original PDF bytes and source');
  await choose('#themeButton','dark');await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile editor must fit the viewport with the theme control');
  await page.locator('#accountButton').click();await page.locator('#accountAppearance').click();assert.equal(await page.locator('#themePreference').inputValue(),'dark');await page.locator('#themePreference').selectOption('system');await page.locator('#closeAppearance').click();await resolved('light');await page.emulateMedia({colorScheme:'dark'});await resolved('dark');
  await page.locator('#accountButton').click();await page.locator('#signOut').click();await page.locator('#auth').waitFor({state:'visible'});await resolved('dark');
  assert.deepEqual(errors,[]);console.log('PASS one-click editor controls, System in account settings, mobile sizing, unchanged source/PDF and themed sign-out');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
