const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8878';
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext({viewport:{width:1440,height:960},colorScheme:'light'});
 const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function resolved(value){await page.waitForFunction(value=>document.documentElement.dataset.theme===value,value);}
 async function choose(button,value){await page.locator(button).click();await page.locator('#themePreference').selectOption(value);await page.locator('#closeAppearance').click();}
 try{
  await page.goto(origin);await page.locator('#auth').waitFor({state:'visible'});await resolved('light');
  await choose('#authThemeButton','dark');await resolved('dark');await page.reload();await page.locator('#auth').waitFor({state:'visible'});await resolved('dark');
  await choose('#authThemeButton','system');await page.emulateMedia({colorScheme:'dark'});await resolved('dark');await page.emulateMedia({colorScheme:'light'});await resolved('light');
  console.log('PASS theme works before sign-in, persists on reload, and follows system appearance');
  await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();
  await page.locator('#projectHome').waitFor({state:'visible'});await page.locator('.project-entry').first().waitFor();
  await choose('#homeThemeButton','dark');await resolved('dark');
  assert.notEqual(await page.locator('.project-entry').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
  const other=await context.newPage();await other.goto(origin);await other.locator('#projectHome').waitFor({state:'visible'});assert.equal(await other.evaluate(()=>document.documentElement.dataset.theme),'dark');
  await choose('#homeThemeButton','light');await other.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  await choose('#homeThemeButton','dark');await other.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await other.close();
  console.log('PASS home uses the dark palette and appearance updates synchronize between tabs');
  await page.locator('#openSampleProject').click();await page.locator('#workspace').waitFor({state:'visible'});const source=await page.locator('#code').inputValue();
  const pdf=await page.locator('#pdfFrame').getAttribute('src');
  await choose('#themeButton','light');await resolved('light');assert.equal(await page.locator('#code').inputValue(),source);assert.equal(await page.locator('#pdfFrame').getAttribute('src'),pdf);
  await choose('#themeButton','dark');await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile editor must fit the viewport with the theme control');
  await page.locator('#accountButton').click();await page.locator('#accountAppearance').click();assert.equal(await page.locator('#themePreference').inputValue(),'dark');await page.locator('#closeAppearance').click();
  await page.locator('#accountButton').click();await page.locator('#signOut').click();await page.locator('#auth').waitFor({state:'visible'});await resolved('dark');
  assert.deepEqual(errors,[]);console.log('PASS editor/account controls, mobile sizing, unchanged source/PDF and themed sign-out');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
