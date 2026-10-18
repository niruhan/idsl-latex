/* First-page covers stay in memory and use the same authenticated PDFs as export. */
let pdfLibrary;
const library=()=>pdfLibrary||(pdfLibrary=import('/vendor/pdfjs/build/pdf.mjs').then(module=>{
 module.GlobalWorkerOptions.workerSrc='/vendor/pdfjs/build/pdf.worker.mjs';return module;
}).catch(error=>{pdfLibrary=null;throw error;}));

export function createProjectCovers(root){
 const cache=new Map(),queue=new Set(),tasks=new Set();let observer,generation=0,active=0,hintLink,cacheBytes=0;
 const hint=document.createElement('div');hint.id='projectNameTooltip';hint.className='project-name-tooltip';hint.role='tooltip';hint.hidden=true;document.body.append(hint);
 function hideName(){hint.hidden=true;if(hintLink?.getAttribute('aria-describedby')===hint.id)hintLink.removeAttribute('aria-describedby');hintLink=null;}
 function showName(link){
  hideName();const heading=link?.querySelector('h2');if(!heading||heading.scrollWidth<=heading.clientWidth)return;
  hint.textContent=heading.textContent;hint.hidden=false;hint.style.left='0px';hint.style.top='0px';hintLink=link;link.setAttribute('aria-describedby',hint.id);
  const rect=heading.getBoundingClientRect(),box=hint.getBoundingClientRect();
  hint.style.left=Math.max(8,Math.min(rect.left,innerWidth-box.width-8))+'px';
  hint.style.top=Math.max(8,Math.min(rect.top-box.height-8>=8?rect.top-box.height-8:rect.bottom+8,innerHeight-box.height-8))+'px';
 }
 const tile=event=>event.target.closest('.project-entry,.project-directory');
 root.addEventListener('pointerover',event=>{const link=tile(event);if(link&&!link.contains(event.relatedTarget))showName(link);});
 root.addEventListener('pointerout',event=>{const link=tile(event);if(link&&!link.contains(event.relatedTarget))hideName();});
 root.addEventListener('focusin',event=>showName(tile(event)));
 root.addEventListener('focusout',event=>{if(!hintLink?.contains(event.relatedTarget))hideName();});
 root.addEventListener('pointerdown',hideName);root.addEventListener('dragstart',hideName);
 document.addEventListener('keydown',event=>{if(event.key==='Escape')hideName();});
 window.addEventListener('scroll',hideName,true);window.addEventListener('resize',hideName);
 function showCover(cover,url,version){
  if(!cover.isConnected)return;const image=new Image();image.className='project-thumbnail';image.alt='';image.draggable=false;image.src=url;
  cover.querySelector('.project-thumbnail')?.remove();cover.querySelector('.project-page').hidden=true;cover.append(image);cover.dataset.renderedPreview=version;
 }
 async function renderCover(cover,ticket){
  const version=cover.dataset.preview,key=cover.dataset.project+':'+version;
  if(cache.has(key)){showCover(cover,cache.get(key),version);return;}
  const task={cancelled:false,loading:null,render:null};tasks.add(task);let canvas;
  try{
   const {getDocument}=await library();if(task.cancelled||ticket!==generation)return;
   task.loading=getDocument({url:'/api/projects/'+cover.dataset.project+'/preview.pdf?v='+encodeURIComponent(version),isEvalSupported:false,enableXfa:false,useWasm:false,cMapUrl:'/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/standard_fonts/'});
   const pdf=await task.loading.promise,page=await pdf.getPage(1);if(task.cancelled||ticket!==generation)return;
   const original=page.getViewport({scale:1}),scale=Math.min(420/original.width,600/original.height),viewport=page.getViewport({scale});
   canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
   task.render=page.render({canvasContext:canvas.getContext('2d'),viewport,background:'white'});await task.render.promise;
   if(task.cancelled||ticket!==generation)return;const url=canvas.toDataURL('image/png');cacheBytes-=2*(cache.get(key)?.length||0);cache.set(key,url);cacheBytes+=2*url.length;while(cache.size>64||cacheBytes>12*1024*1024){const oldest=cache.keys().next().value;cacheBytes-=2*cache.get(oldest).length;cache.delete(oldest);}showCover(cover,url,version);
  }catch(error){if(!task.cancelled&&ticket===generation)cover.dataset.previewError='unavailable';}
  finally{tasks.delete(task);if(canvas)canvas.width=canvas.height=1;await task.loading?.destroy().catch(()=>{});}
 }
 function pump(){while(active<2&&queue.size){const cover=queue.values().next().value;queue.delete(cover);if(!cover.isConnected)continue;active++;renderCover(cover,generation).finally(()=>{active--;pump();});}}
 function reset(){generation++;observer?.disconnect();queue.clear();hideName();for(const task of tasks){task.cancelled=true;task.render?.cancel();task.loading?.destroy().catch(()=>{});}}
 function render(){
  reset();observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){observer.unobserve(entry.target);queue.add(entry.target);}}pump();},{rootMargin:'150px'});
  for(const cover of root.querySelectorAll('.project-cover[data-preview]')){const key=cover.dataset.project+':'+cover.dataset.preview;if(cache.has(key))showCover(cover,cache.get(key),cover.dataset.preview);else observer.observe(cover);}
 }
 return {render,reset};
}
