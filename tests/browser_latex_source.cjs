const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN,browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
 const context=await browser.newContext({viewport:{width:1500,height:960}}),page=await context.newPage();page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 async function api(url,method='GET',data){const response=await context.request.fetch(origin+url,{method,headers:{Origin:origin},data});assert.equal(response.ok(),true,await response.text());return response.json();}
 let pid;
 try{
  await page.goto(origin);await page.locator('#auth').waitFor({state:'visible'});if(await page.locator('#tokenLabel').isVisible()){await page.locator('input[name=name]').fill('Browser Test Owner');await page.locator('input[name=token]').fill('local-browser-test-only');}await page.locator('input[name=email]').fill('browser-owner@example.test');await page.locator('input[name=password]').fill('browser-test-password-only');await page.locator('#authSubmit').click();await page.locator('#projectHome').waitFor({state:'visible'});
  pid=(await api('/api/projects','POST',{name:'LaTeX source navigation fixture',template:false})).id;
  const base='/api/projects/'+pid,sectionPath='sections/part.tex',main=String.raw`\documentclass[twocolumn]{article}
\usepackage{hyperref}
\begin{document}
Main source paragraph with a reference to the \hyperref[second]{second page}.
\par
\input{sections/part}
\clearpage
\section{Second page}\label{second}
Second page source paragraph for navigation.
\end{document}
`,section=Array.from({length:60},(_,index)=>'% Context '+index).join('\n')+'\nIncluded target paragraph from a separate file.\n\par\nAnother included paragraph with useful text.\n';
  await api(base+'/file','PUT',{path:'main.tex',revision:1,content:main});await api(base+'/file','PUT',{path:sectionPath,revision:0,content:section});
  await page.goto(origin+'/#project='+pid);await page.locator('#workspace').waitFor({state:'visible'});await page.evaluate(()=>window.addEventListener('message',event=>(window.pdfMessages??=[]).push(event.data)));
  const response=page.waitForResponse(response=>response.url().endsWith(base+'/compile'));await page.locator('#compileButton').click();const build=await (await response).json();assert.equal(build.success,true,build.log);assert.equal(build.sourceMap,true);
  const frame=page.frameLocator('#pdfFrame'),target=frame.locator('.textLayer span').filter({hasText:'Included target paragraph'}).first();await target.waitFor();
  await page.locator('.tree-folder[title="sections"]').click();assert.equal(await page.locator('.tree-file[title="'+sectionPath+'"]').isVisible(),false);
  // Hold the old file's final save while the preview requests another source.
  let releaseSave,saveStarted;const gate=new Promise(resolve=>releaseSave=resolve),started=new Promise(resolve=>saveStarted=resolve);
  await page.route('**'+base+'/file',async route=>{if(route.request().method()==='PUT'){saveStarted();await gate;}await route.continue();});
  await page.locator('#code').fill(main+'% unsaved main edit\n');await target.click({position:{x:8,y:5}});await started;
  assert.equal(await page.locator('#filePath').textContent(),'main.tex','Keep the old file until its save finishes');releaseSave();
  try{await page.waitForFunction(path=>document.querySelector('#filePath').textContent===path&&document.activeElement.id==='code',sectionPath);}
  catch(error){
   const click=await target.evaluate(element=>{const page=element.closest('.pdf-page'),a=element.getBoundingClientRect(),b=page.getBoundingClientRect(),scale=Number(page.style.getPropertyValue('--total-scale-factor'));return {x:(a.left-b.left+8)/scale,y:(a.top-b.top+5)/scale};});
   const v=new URL(await page.locator('#pdfFrame').getAttribute('src'),origin).searchParams.get('v'),map=await api(base+'/synctex?v='+v);
   const state=await page.evaluate(()=>({path:document.querySelector('#filePath').textContent,active:document.activeElement.id,messages:window.pdfMessages}));
   console.error('Source click state',JSON.stringify({state,click,files:map.files,points:map.pages['1'].map(point=>({point,dx:Math.abs(point[3]-click.x),dy:Math.abs(point[4]-click.y)})).sort((a,b)=>(a.dy*4+a.dx)-(b.dy*4+b.dx)).slice(0,10)}));throw error;
  }
  await page.unroute('**'+base+'/file');
  assert.equal((await api(base+'/file?path=main.tex')).content,main+'% unsaved main edit\n');assert.equal(await page.locator('#code').inputValue(),section);
  const position=await page.locator('#code').evaluate(area=>({line:area.value.slice(0,area.selectionStart).split('\n').length-1,top:area.scrollTop}));assert.ok(Math.abs(position.line-60)<=1,JSON.stringify(position));assert.ok(position.top>0);assert.equal(await page.locator('.tree-file[title="'+sectionPath+'"]').isVisible(),true);
  const src=await page.locator('#pdfFrame').getAttribute('src');await page.locator('#pdfThemeButton').click();await target.click({position:{x:8,y:5}});assert.equal(await page.locator('#pdfFrame').getAttribute('src'),src);assert.equal(await page.locator('#pdfThemeButton').getAttribute('aria-pressed'),'true');
  await frame.locator('#zoomIn').click();await target.waitFor();await target.click({position:{x:8,y:5}});await page.waitForFunction(()=>document.activeElement.id==='code');
  // PDF text stays selectable; dragging a selection must not navigate.
  const box=await target.boundingBox();await page.mouse.move(box.x+2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+Math.min(110,box.width-2),box.y+box.height/2,{steps:12});await page.mouse.up();
  assert.ok(await frame.locator('body').evaluate(()=>getSelection().toString().length>0));assert.equal(await page.locator('#filePath').textContent(),sectionPath);await frame.locator('body').evaluate(()=>getSelection().removeAllRanges());
  await page.locator('#code').fill(section+'% unsaved included edit\n');
  await frame.locator('.pdf-link').first().click();
  const second=frame.locator('.pdf-page[data-page="2"]');await second.scrollIntoViewIfNeeded();const secondText=second.locator('.textLayer span').filter({hasText:'Second page source paragraph'}).first();
  try{await secondText.waitFor();}catch(error){console.error('Second page state',JSON.stringify({rendered:await second.getAttribute('data-rendered'),text:await second.locator('.textLayer span').allTextContents(),message:await frame.locator('#message').textContent()}));throw error;}
  await secondText.click({position:{x:8,y:5}});
  await page.waitForFunction(()=>document.querySelector('#filePath').textContent==='main.tex'&&document.activeElement.id==='code');assert.equal((await api(base+'/file?path='+encodeURIComponent(sectionPath))).content,section+'% unsaved included edit\n');
  assert.ok(await page.locator('#code').evaluate(area=>Math.abs(area.value.slice(0,area.selectionStart).split('\n').length-1-8)<=1));
  await page.locator('button.fold-toggle[data-line="8"]').click();assert.equal((await page.locator('#code').inputValue()).includes('Second page source paragraph'),false);await secondText.click({position:{x:8,y:5}});await page.waitForFunction(()=>document.querySelector('#code').value.includes('Second page source paragraph')&&document.activeElement.id==='code');assert.equal(await page.locator('button.fold-toggle[data-line="8"]').getAttribute('aria-expanded'),'true','Preview navigation reveals folded LaTeX source');
  // Only the active preview, project and build may request navigation.
  const before=await page.locator('#code').evaluate(area=>area.selectionStart);
  await page.evaluate(({pid,path})=>window.postMessage({type:'pdf-source',project:pid,version:'0',path,range:{start:{line:0,character:0}}},location.origin),{pid,path:sectionPath});
  await frame.locator('body').evaluate(({pid,path})=>parent.postMessage({type:'pdf-source',project:pid,version:'0',path,range:{start:{line:0,character:0}}},location.origin),{pid,path:sectionPath});
  assert.equal(await page.locator('#filePath').textContent(),'main.tex');assert.equal(await page.locator('#code').evaluate(area=>area.selectionStart),before);
  const download=page.waitForEvent('download');await page.locator('#downloadButton').click();assert.equal((await download).suggestedFilename(),'LaTeX source navigation fixture.pdf');await secondText.click({position:{x:8,y:5}});await page.waitForFunction(()=>document.activeElement.id==='code');
  await frame.locator('#zoomFit').click();await page.setViewportSize({width:1200,height:800});await secondText.waitFor();assert.deepEqual(errors,[]);
  console.log('PASS real LaTeX PDF rendering, multi-file/page click-to-source, collapsed folder reveal, save-before-navigation, zoom, text selection, internal links, dark preview, message guards and PDF export');
 }finally{if(pid)await api('/api/projects/'+pid,'DELETE',{});await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
