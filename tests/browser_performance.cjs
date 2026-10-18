/* Repeatable large-project measurements on a disposable installation. */
const assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN,browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN}),context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 async function api(path,method='GET',data){const response=await context.request.fetch(origin+path,{method,headers:{Origin:origin},data});assert.ok(response.ok(),await response.text());return response.json();}
 try{
  await api('/api/setup','POST',{token:process.env.SETUP_TOKEN,name:'Performance example',email:'performance@example.test',password:'fictional-performance-password'});
  const pid=(await api('/api/projects','POST',{name:'Large fictional project',format:'typst',template:false})).id,base='/api/projects/'+pid;
  const source=Array.from({length:1400},(_,i)=>'= Section '+i+'\n#text[needle example '+i+']\nA paragraph for measurement.\n').join('\n');
  await api(base+'/file','PUT',{path:'main.typ',revision:1,content:source});
  for(let i=0;i<250;i+=4)await Promise.all(Array.from({length:Math.min(4,250-i)},(_,j)=>api(base+'/file','PUT',{path:'chapters/part-'+(i+j)+'.typ',content:'= Example\n',revision:0})));
  await page.goto(origin);await page.locator('#projectHome').waitFor({state:'visible'});await page.goto(origin+'/#project='+pid);await page.waitForFunction(()=>!document.querySelector('#workspace').hidden&&!document.querySelector('#workspace').inert);
  // Let the first metadata poll establish its authenticated conditional tag.
  await page.waitForResponse(response=>response.url()===origin+base);await page.evaluate(()=>{window.perfCounts={tree:0,tabs:0,paint:0};for(const [id,key] of [['projectRootContents','tree'],['fileTabs','tabs'],['highlight','paint']])new MutationObserver(records=>{perfCounts[key]+=records.filter(record=>record.type==='childList').length;}).observe(document.getElementById(id),{childList:true,subtree:true});});
  let transferred=0,polls=0;const count=response=>{if(response.url()===origin+base){polls++;transferred+=Number(response.headers()['content-length']||0);}};page.on('response',count);await page.waitForTimeout(8500);page.off('response',count);const idle=await page.evaluate(()=>({...perfCounts}));
  await page.locator('#code').focus();await page.keyboard.press('Control+f');await page.locator('#findQuery').fill('needle');await page.waitForFunction(()=>/of 1400/.test(document.querySelector('#findCount').textContent));
  await page.evaluate(()=>perfCounts.paint=0);const start=performance.now();for(let i=0;i<20;i++)await page.locator('#findQuery').press('Enter');const findNavigationMs=performance.now()-start,searchPaints=await page.evaluate(()=>perfCounts.paint);await page.keyboard.press('Escape');
  await page.locator('#code').press('Control+End');const timing=[];for(const ch of 'abcdefghijklmnopqrstuvwxyz'){const start=performance.now();await page.keyboard.insertText(ch);timing.push(performance.now()-start);}await page.waitForFunction(()=>document.querySelector('#saveStatus').textContent==='All changes saved');
  const cdp=await context.newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage');const heap=await page.evaluate(()=>performance.memory?.usedJSHeapSize||0);
  const result={sourceBytes:Buffer.byteLength(source),files:251,idleTreeMutations:idle.tree,idleTabMutations:idle.tabs,idleMetadataBytes:transferred,idlePolls:polls,searchNavigationPaints:searchPaints,findNavigationMs:Math.round(findNavigationMs),typingMedianMs:Math.round(timing.sort((a,b)=>a-b)[13]),heapBytes:heap};console.log(JSON.stringify(result));
  if(!process.env.PERF_BASELINE){assert.equal(idle.tree,0,'Idle polling must preserve the file tree');assert.equal(idle.tabs,0,'Idle polling must preserve tabs and focus');assert.equal(searchPaints,0,'Search navigation must reuse unchanged source DOM');assert.equal(transferred,0,'Unchanged metadata polls must have no body');}
  if(process.env.PERFORMANCE_REPORT)fs.writeFileSync(process.env.PERFORMANCE_REPORT,JSON.stringify(result,null,2)+'\n');assert.deepEqual(errors,[]);console.log('PASS large-project idle, navigation, editing and heap measurements');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
