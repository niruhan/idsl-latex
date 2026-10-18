/* Cached release status; only an explicit Install click may change the app. */
const $=id=>document.getElementById(id),running=job=>job?.phase&&!['complete','rolled_back','error'].includes(job.phase);
export function createAppUpdates(host){
 const {api,modal,toast}=host;let status=null,timer,lastRead=0,polling=false,installing=false;
 const channel=globalThis.BroadcastChannel?new BroadcastChannel('idsl-app-update'):null,answers=new Map();
 channel?.addEventListener('message',async event=>{const message=event.data;if(message?.type==='prepare'&&typeof message.id==='string'){try{channel.postMessage({type:'ready',id:message.id,ok:await host.save()});}catch{channel.postMessage({type:'ready',id:message.id,ok:false});}}else if(message?.type==='ready'&&answers.has(message.id))answers.get(message.id).push(message.ok);});
 function badge(){for(const id of ['accountButton','homeAccountButton']){const button=$(id);button.classList.toggle('update-available',Boolean(status?.available));button.title=status?.available?'Account · App update available':'Account';}const item=$('accountUpdates');if(item){item.textContent=status?.available?'App update available…':'App updates…';item.classList.toggle('update-menu-item',Boolean(status?.available));}}
 async function refresh(){if(!host.active()||polling)return;polling=true;try{status=await api('/api/app-update');lastRead=Date.now();badge();if($('appUpdatePanel'))render();}catch{ /* Offline checks stay quiet; the manual action reports errors. */ }finally{polling=false;}}
 async function readyTabs(){const id=crypto.randomUUID(),responses=[];answers.set(id,responses);channel?.postMessage({type:'prepare',id});await new Promise(resolve=>setTimeout(resolve,800));answers.delete(id);if(responses.some(ok=>!ok))throw Error('Another tab has an unsaved conflict. Resolve it before updating.');}
 function render(){
  if(!$('appUpdatePanel')||!status)return;const release=status.release,job=status.job,busy=installing||running(job);
  $('installedAppVersion').textContent=status.current.version+(status.current.commit?' · '+status.current.commit.slice(0,8):'');
  $('latestAppVersion').textContent=release?(status.available?'Available: ':'Latest release: ')+release.tag:'No release checked yet';
  $('appUpdateStatus').textContent=job?.message||(status.error||(!status.available&&status.checked?'No newer stable release.':''));
  $('appUpdateReason').textContent=status.available&&!status.canInstall?status.reason:'';
  $('checkAppUpdate').disabled=busy||status.checking||!status.admin;$('installAppUpdate').disabled=busy||!status.canInstall;$('installAppUpdate').hidden=!status.available;$('installAppUpdate').textContent=release?'Install '+release.tag+' and restart':'Install update';
  $('automaticAppUpdates').checked=status.automatic;$('automaticAppUpdates').disabled=busy||!status.admin||status.current.mode==='manual';$('appUpdateAutomaticLabel').hidden=status.current.mode==='manual';
  $('appReleaseNotes').textContent=release?.notes||'';$('appReleaseLink').hidden=!release;if(release)$('appReleaseLink').href=release.url;
  $('reloadUpdatedApp').hidden=!['complete','rolled_back'].includes(job?.phase);
 }
 function watchJob(){clearTimeout(timer);if(!installing&&!running(status?.job))return;timer=setTimeout(async()=>{await refresh();watchJob();},2000);}
 async function open(){
  await refresh();modal('App updates',`<section id="appUpdatePanel"><div class="tool-row"><strong id="installedAppVersion"></strong><span id="latestAppVersion"></span></div><p id="appUpdateStatus" role="status"></p><p id="appUpdateReason" class="hint"></p><div class="tool-row"><button id="checkAppUpdate" class="outline">Check for updates</button><button id="installAppUpdate" class="primary" hidden></button><button id="reloadUpdatedApp" class="outline" hidden>Reload updated app</button></div><label id="appUpdateAutomaticLabel" class="inline-check"><input id="automaticAppUpdates" type="checkbox">Check for releases daily</label><p class="hint">Installation and restart happen only when you choose Install. Projects and settings are retained; a private rollback backup is kept.</p><details><summary>Release notes</summary><pre id="appReleaseNotes" class="app-release-notes"></pre><a id="appReleaseLink" target="_blank" rel="noopener noreferrer" hidden>View release on GitHub</a></details></section>`);render();
  $('checkAppUpdate').addEventListener('click',async()=>{const button=$('checkAppUpdate');button.disabled=true;$('appUpdateStatus').textContent='Checking GitHub releases…';try{status=await api('/api/app-update/check','POST',{});badge();render();}catch(error){if($('appUpdateStatus'))$('appUpdateStatus').textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}});
  $('automaticAppUpdates').addEventListener('change',async event=>{try{status=await api('/api/app-update/preferences','PUT',{automatic:event.target.checked});render();}catch(error){toast(error.message);render();}});
  $('installAppUpdate').addEventListener('click',async()=>{if(installing||!status?.canInstall)return;installing=true;render();try{await host.exclusive(async()=>{await readyTabs();const approved=status.release;await api('/api/app-update/install','POST',{confirm:true,version:approved.version,digest:approved.digest});channel?.postMessage({type:'installing'});});await refresh();}catch(error){toast(error.message);}finally{installing=false;render();watchJob();}});
  $('reloadUpdatedApp').addEventListener('click',async()=>{if(await host.save())location.reload();else toast('Save or resolve your browser draft before reloading.');});watchJob();
 }
 function started(){clearTimeout(timer);refresh();timer=setTimeout(refresh,60000);}
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastRead>60000)refresh();});
 setInterval(()=>{if(!document.hidden)refresh();},3600000);
 window.addEventListener('pagehide',()=>{clearTimeout(timer);channel?.close();});
 return {started,open,badge};
}
