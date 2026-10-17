// Only run through run_browser.py --screenshots: all accounts/data are disposable.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN;assert.ok(origin&&/^http:\/\/127\.0\.0\.1:\d+$/.test(origin),'Use the isolated screenshot runner');
 const output=path.join(process.cwd(),'docs','images');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext({viewport:{width:1500,height:960},colorScheme:'light'});
 const page=await context.newPage();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function api(url,method='GET',data){const response=await context.request.fetch(origin+url,{method,headers:{Origin:origin},data});assert.equal(response.ok(),true,await response.text());return response.json();}
 async function capture(name){if(await page.locator('#workspace').isVisible())await page.waitForTimeout(1000);await page.locator('#toast').waitFor({state:'hidden',timeout:10000});await page.screenshot({path:path.join(output,name),animations:'disabled',fullPage:true});console.log('Captured '+name);}
 try{
  const fresh=await api('/api/session');assert.equal(fresh.needsSetup,true,'Never capture a working user installation');
  await page.goto(origin);await page.locator('#auth').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');
  await page.locator('input[name=name]').fill('Demo Researcher');await page.locator('input[name=email]').fill('demo-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('input[name=token]').fill('local-browser-test-only');await page.locator('#authSubmit').click();
  await page.locator('#projectHome').waitFor({state:'visible'});await page.locator('.project-entry').first().waitFor();
  const initial=(await api('/api/projects')).projects;const latex=initial.find(p=>p.main.endsWith('.tex'));const sample=await api('/api/projects','POST',{templateId:'getting-started-typst'});assert.ok(latex&&sample.id);
  // Replace the initial article with the public classic LaTeX starter.
  const article=await api('/api/projects','POST',{templateId:'research-article',name:'A research paper'});
  await api('/api/projects/'+latex.id,'DELETE',{});latex.id=article.id;
  await api('/api/projects','POST',{name:'Research notes',format:'typst',template:false});
  const collection=await api('/api/project-folders','POST',{name:'Research collection'});
  await api('/api/projects','POST',{name:'Literature review',format:'latex',template:false,folder:collection.id});
  await page.locator('#refreshProjects').click();await page.waitForFunction(()=>document.querySelectorAll('.project-entry').length===3&&document.querySelectorAll('.project-directory').length===1);await capture('projects.png');
  await page.locator('#browseTemplates').click();await capture('template-library.png');await page.locator('#closeModal').click();
  await page.locator('#homeAccountButton').click();await capture('account-menu.png');await page.keyboard.press('Tab');assert.equal(await page.locator('#accountDropdown').isHidden(),true);assert.equal(await page.locator('#homeAccountButton').getAttribute('aria-expanded'),'false');
  await page.locator('[data-project-actions="'+latex.id+'"] summary').click();await capture('project-actions.png');await page.keyboard.press('Escape');
  await page.locator('#homeAccountButton').click();await page.locator('#accountAppearance').click();await page.locator('[data-palette-choice=western]').click();await capture('themes.png');await page.locator('[data-palette-choice=forest]').click();await page.locator('#closeAppearance').click();
  await page.locator('#projectListView').click();await capture('projects-list.png');await page.locator('#projectGridView').click();
  // A fresh, tall viewport avoids full-page stitching artifacts after resizing.
  const mobile=await context.newPage();mobile.on('pageerror',e=>errors.push(e.message));
  await mobile.setViewportSize({width:390,height:1400});await mobile.goto(origin);
  await mobile.locator('#projectHome').waitFor({state:'visible'});await mobile.waitForFunction(()=>document.querySelectorAll('.project-entry').length===3&&document.querySelectorAll('.project-directory').length===1);
  await mobile.locator('#toast').waitFor({state:'hidden'});await mobile.screenshot({path:path.join(output,'projects-mobile.png'),animations:'disabled'});console.log('Captured projects-mobile.png');await mobile.close();
  await page.locator('.project-entry[data-project="'+sample.id+'"]').click();await page.locator('#workspace').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));await capture('typst-workspace.png');
  await page.locator('button.tree-file[title="sections/introduction.typ"]').click();await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='sections/introduction.typ');await page.locator('#visualTab').click();await capture('visual-editor.png');
  await page.locator('#sourceTab').click();await page.locator('#themeButton').click();await page.locator('#pdfThemeButton').click();await capture('dark-theme.png');await page.locator('#pdfThemeButton').click();
  await page.locator('#themeButton').click();
  await page.locator('#projectsNavButton').click();await page.locator('#projectHome').waitFor({state:'visible'});await page.locator('.project-entry[data-project="'+latex.id+'"]').click();await page.locator('#workspace').waitFor({state:'visible'});
  const build=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');await page.locator('#compileButton').click();assert.equal((await(await build).json()).success,true);await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));await capture('workspace.png');
  // Give this sample a fictional coauthor without ever displaying a live link.
  await api('/api/approved-emails','PUT',{emails:['demo-owner@example.test','demo-editor@example.test']});
  const invite=await api('/api/lab-invite','POST',{count:1});const signup=invite.links[0].url.split('#signup=')[1];
  const member=await browser.newContext();
  const registered=await member.request.post(origin+'/api/register-lab',{headers:{Origin:origin},data:{name:'Demo Coauthor',email:'demo-editor@example.test',password:'browser-test-password-only',token:signup}});assert.equal(registered.ok(),true);
  const share=await api('/api/projects/'+latex.id+'/invite','POST',{role:'editor'});
  const joined=await member.request.post(origin+'/api/join',{headers:{Origin:origin},data:{token:share.url.split('#invite=')[1]}});assert.equal(joined.ok(),true);await member.close();
  await page.locator('#shareButton').click();await page.locator('.member-row').filter({hasText:'Demo Coauthor'}).waitFor();assert.equal(await page.locator('#inviteUrl').count(),0);await capture('sharing.png');await page.locator('#closeModal').click();
  await api('/api/backup-settings','PUT',{repository:'example/research-documents'});await page.locator('#backupButton').click();assert.equal(await page.locator('#backupToken').inputValue(),'');await capture('github-backups.png');
  await page.locator('#closeModal').click();await page.locator('#projectsNavButton').click();await page.locator('[data-starter=western-presentation]').waitFor();
  await page.locator('#homeAccountButton').click();await page.locator('#accountAppearance').click();await page.locator('[data-palette-choice=western]').click();await page.locator('#closeAppearance').click();
  await page.locator('[data-starter=western-presentation]').click();await page.locator('#workspace').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));await capture('western-presentation.png');await page.locator('button.tree-file[title="images/western-logo.png"]').click();await page.locator('#binaryPreview img').waitFor();await page.waitForFunction(()=>document.querySelector('#binaryPreview img').naturalWidth>0);await capture('image-preview.png');await page.locator('button.tree-file[title="images/western-logo.png"]').click({button:'right'});await capture('file-actions.png');await page.keyboard.press('Escape');
  await page.locator('#projectsNavButton').click();await page.locator('[data-starter=neurips-2026]').click();await page.locator('#workspace').waitFor({state:'visible'});
  const neurips=page.waitForResponse(r=>r.url().endsWith('/compile')&&r.request().method()==='POST');await page.locator('#compileButton').click();assert.equal((await(await neurips).json()).success,true);await page.waitForFunction(()=>document.querySelector('#buildStatus').textContent.startsWith('Compiled in'));await capture('neurips-paper.png');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
