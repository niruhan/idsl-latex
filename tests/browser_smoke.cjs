// Run against an empty disposable server; never against a user's workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8876';
  const output = path.resolve('artifacts');
  fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_BIN});
  const context = await browser.newContext({viewport: {width: 1500, height: 960}, acceptDownloads: true});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  try {
    await page.goto(origin);
    await page.locator('#auth').waitFor({state: 'visible'});
    const setup = await page.locator('#tokenLabel').isVisible();
    if (setup) await page.locator('#nameLabel input').fill('Browser Test Owner');
    await page.locator('input[name=email]').fill('browser-owner@example.test');
    await page.locator('input[name=password]').fill('browser-test-password-only');
    if (setup) await page.locator('input[name=token]').fill(process.env.TEST_SETUP_TOKEN_FILE ? fs.readFileSync(process.env.TEST_SETUP_TOKEN_FILE, 'utf8').trim() : 'local-browser-test-only');
    await page.locator('#authSubmit').click();
    await page.locator('#projectHome').waitFor({state: 'visible'});
    await page.locator('.project-entry').filter({hasText:'A space for your next idea'}).click();
    await page.locator('#workspace').waitFor({state: 'visible'});
    await page.waitForFunction(() => document.querySelector('#code').value.includes('documentclass'));
    console.log('PASS account setup and project file tree');

    // Edit an included section visually, then check the generated source and autosave.
    await page.locator('button.tree-file[title="sections/introduction.tex"]').click();
    await page.waitForFunction(() => document.querySelector('#filePath').textContent === 'sections/introduction.tex');
    await page.locator('#visualTab').click();
    const paragraph = page.locator('[contenteditable=true][aria-label=Paragraph]').first();
    await paragraph.fill('Browser-tested visual paragraph with 50% progress & reproducible results.');
    await page.waitForFunction(() => document.querySelector('#saveStatus').textContent === 'All changes saved');
    await page.locator('#sourceTab').click();
    assert.match(await page.locator('#code').inputValue(), /50\\% progress \\& reproducible/);
    await page.reload();
    await page.locator('button.tree-file[title="sections/introduction.tex"]').click();
    await page.waitForFunction(() => document.querySelector('#filePath').textContent === 'sections/introduction.tex');
    assert.match(await page.locator('#code').inputValue(), /Browser-tested visual paragraph/);
    console.log('PASS visual edit, TeX escaping, autosave, and reload persistence');

    async function compile() {
      const response = page.waitForResponse(r => r.url().endsWith('/compile') && r.request().method() === 'POST', {timeout: 330000});
      await page.locator('#compileButton').click();
      const result = await (await response).json();
      assert.equal(result.success, true, result.log);
      await page.locator('#pdfFrame').waitFor({state: 'visible'});
      return result;
    }
    await compile();
    const pdfResponse = await context.request.get(origin + await page.locator('#pdfFrame').getAttribute('src'));
    assert.equal(pdfResponse.status(), 200);
    const pdf = await pdfResponse.body();
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    fs.writeFileSync(path.join(output, 'browser-compiled.pdf'), pdf);
    const pdfDownload = page.waitForEvent('download');
    await page.locator('#downloadButton').click();
    const exported=await pdfDownload;assert.equal(exported.suggestedFilename(),(await page.locator('#projectTitle').textContent())+'.pdf');
    await exported.saveAs(path.join(output, 'exported.pdf'));
    await page.screenshot({path: path.join(output, 'workspace.png'), fullPage: true});
    console.log('PASS browser-triggered compilation, PDF pane, and PDF export');

    // Single-use viewer invite opens in a separate browser profile.
    await page.locator('#shareButton').click();
    await page.locator('#inviteRole').selectOption('viewer');
    await page.locator('#createInvite').click();
    await page.locator('#inviteUrl').waitFor();
    const invite = await page.locator('#inviteUrl').inputValue();
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    const accountInvite=await (await context.request.post(origin+'/api/lab-invite',{headers:{Origin:origin},data:{count:1}})).json();
    await viewer.goto(accountInvite.links[0].url);
    await viewer.locator('#nameLabel input').fill('Browser Test Viewer');
    const viewerEmail = 'browser-viewer@example.test';
    const allowed = await (await context.request.get(origin+'/api/approved-emails')).json();
    const approval = await context.request.put(origin+'/api/approved-emails', {headers:{Origin:origin},data:{emails:[...allowed.emails,viewerEmail]}});
    assert.equal(approval.status(),200);
    await viewer.locator('input[name=email]').fill(viewerEmail);
    await viewer.locator('input[name=password]').fill('viewer-test-password-only');
    await viewer.locator('#authSubmit').click();
    await viewer.locator('#projectHome').waitFor({state:'visible'});
    await viewer.locator('.project-entry').filter({hasText:'My first paper'}).click();
    await viewer.locator('#workspace').waitFor({state:'visible'});
    await viewer.waitForFunction(()=>document.querySelector('#roleLabel').textContent==='owner');
    await viewer.goto(invite);
    await viewer.waitForFunction(() => document.querySelector('#roleLabel').textContent === 'viewer');
    await viewer.locator('#code[readonly]').waitFor({state:'attached'});
    assert.equal(await viewer.locator('#compileButton').isDisabled(), true);
    assert.equal(await viewer.locator('#code').getAttribute('readonly'), '');
    await viewerContext.close();
    await page.locator('#closeModal').click();
    console.log('PASS share invitation, account registration, and read-only viewer');

    // Three single-use links create separate private workspaces.
    await page.locator('#accountButton').click();
    await page.locator('#approvedEmailsButton').click();
    await page.locator('#approvedEmailsList').fill('browser-owner@example.test\nbrowser-viewer@example.test\nlab-one@example.test\nlab-two@example.test');
    await page.locator('#approvedEmailsForm button').click();
    await page.locator('#accountButton').click();
    await page.locator('#inviteLabMembers').click();
    await page.locator('#createLabInvites button').click();
    await page.waitForFunction(()=>document.querySelectorAll('.new-lab-invite').length===3);
    const inviteLinks=await page.locator('.new-lab-invite').evaluateAll(inputs=>inputs.map(input=>input.value));
    let inviteIndex=0;
    const ownerProject=(await (await context.request.get(origin+'/api/projects')).json()).projects[0].id;
    const privateProjects=[];
    for(const email of ['lab-one@example.test','lab-two@example.test']) {
      const memberContext=await browser.newContext();
      const memberPage=await memberContext.newPage();
      await memberPage.goto(inviteLinks[inviteIndex++]);
      await memberPage.locator('#nameLabel input').fill('Lab Member');
      await memberPage.locator('input[name=email]').fill(email);
      await memberPage.locator('input[name=password]').fill('member-test-password-only');
      await memberPage.locator('#authSubmit').click();
      await memberPage.locator('#projectHome').waitFor({state:'visible'});
      await memberPage.locator('.project-entry').filter({hasText:'My first paper'}).click();
      await memberPage.locator('#workspace').waitFor({state:'visible'});
      const projects=(await (await memberContext.request.get(origin+'/api/projects')).json()).projects;
      assert.equal(projects.length,1);assert.ok(projects.every(p=>p.role==='owner'));
      privateProjects.push(projects[0].id);
      assert.equal((await memberContext.request.get(origin+'/api/projects/'+ownerProject)).status(),404);
      assert.equal((await context.request.get(origin+'/api/projects/'+projects[0].id)).status(),404);
      await memberPage.locator('#projectsNavButton').click();
      await memberPage.locator('#projectHome').waitFor({state:'visible'});
      assert.equal(await memberPage.locator('#homeHeading').innerText(),'All projects');
      await memberContext.close();
    }
    assert.notEqual(privateProjects[0],privateProjects[1]);
    const outsiderContext=await browser.newContext({viewport:{width:390,height:844}});
    const outsider=await outsiderContext.newPage();await outsider.goto(inviteLinks[2]);
    await outsider.locator('input[name=email]').fill('outsider@example.test');
    await outsider.locator('#nameLabel input').fill('Outsider');
    await outsider.locator('input[name=password]').fill('outsider-test-password');
    await outsider.locator('#authSubmit').click();
    await outsider.locator('#authError').filter({hasText:'not approved'}).waitFor();
    await outsider.screenshot({path:path.join(output,'idsl-signup-mobile.png'),fullPage:true});
    await outsiderContext.close();await page.locator('#closeModal').click();
    console.log('PASS approved-list UI, single-use account invitations, independent private projects and outsider rejection');

    const zipDownload = page.waitForEvent('download');
    await page.locator('#exportSourceButton').click();
    const zipPath = path.join(output, 'roundtrip-source.zip');
    await (await zipDownload).saveAs(zipPath);
    await page.locator('#projectsButton').click();
    await page.locator('#projectHome').waitFor({state:'visible'});
    await page.locator('#importZip').setInputFiles(zipPath);
    await page.waitForFunction(() => document.querySelector('#projectTitle').textContent === 'roundtrip-source');
    await compile();
    console.log('PASS source ZIP export, reimport, and bibliography compilation');

    // A failed build must remove the PDF from the preview and export controls.
    await page.locator('button.tree-file[title="main.tex"]').click();
    await page.waitForFunction(() => document.querySelector('#filePath').textContent === 'main.tex' && !document.querySelector('#workspace').inert);
    const oldSource = await page.locator('#code').inputValue();
    await page.locator('#code').fill('\\documentclass{article}\\begin{document}\\invalidcommand\\end{document}');
    const failure = page.waitForResponse(r => r.url().endsWith('/compile') && r.request().method() === 'POST');
    await page.locator('#compileButton').click();
    assert.equal((await (await failure).json()).success, false);
    await page.waitForFunction(() => document.querySelector('#buildStatus').textContent === 'Build failed');
    assert.equal(await page.locator('#pdfFrame').isHidden(), true);
    assert.equal(await page.locator('#downloadButton').isDisabled(), true);
    await page.locator('#code').fill(oldSource);
    await compile();
    assert.deepEqual(errors, []);
    console.log('PASS failed-build handling, recovery, and no browser JavaScript errors');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exit(1);});
