import {getDocument,GlobalWorkerOptions,TextLayer,AnnotationType} from '/vendor/pdfjs/build/pdf.mjs';

GlobalWorkerOptions.workerSrc='/vendor/pdfjs/build/pdf.worker.mjs';
const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),pid=params.get('project'),version=params.get('v');
let documentPdf,loadingTask,mapping={files:[],pages:{}},zoom=1,epoch=0,active=0,resizeTimer,down=null;
const states=[],queue=new Set();
const send=data=>parent.postMessage({...data,project:pid,version},location.origin);
function report(error){$('message').textContent=error.message||'The PDF could not be displayed. Recompile or open the PDF in a new tab.';$('message').hidden=false;}
function width(){return Math.max(200,document.documentElement.clientWidth-24)*zoom;}
function size(state){const scale=width()/state.base.width;state.element.style.width=state.base.width*scale+'px';state.element.style.height=state.base.height*scale+'px';return scale;}
function enqueue(state){queue.add(state);pump();}
function pump(){while(active<2&&queue.size){const state=queue.values().next().value;queue.delete(state);if(!state.visible||state.running||state.rendered===epoch)continue;active++;render(state).catch(report).finally(()=>{active--;pump();});}}
async function render(state){
 const ticket=epoch,generation=state.generation,valid=()=>ticket===epoch&&generation===state.generation&&state.visible;state.running=true;
 try{
  const page=await documentPdf.getPage(state.number);if(!valid())return;
  state.base=page.getViewport({scale:1});const viewport=page.getViewport({scale:size(state)}),ratio=Math.min(devicePixelRatio||1,2,Math.sqrt(5000000/(viewport.width*viewport.height)));
  const canvas=document.createElement('canvas'),text=document.createElement('div');text.className='textLayer';
  state.element.style.setProperty('--total-scale-factor',viewport.scale);state.element.replaceChildren(canvas,text);
  canvas.width=Math.max(1,Math.floor(viewport.width*ratio));canvas.height=Math.max(1,Math.floor(viewport.height*ratio));
  state.viewport=viewport;state.pdfPage=page;
  state.task=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]});await state.task.promise;
  if(!valid())return;
  const content=await page.getTextContent(),items=content.items.filter(item=>typeof item.str==='string');
  if(!valid())return;
  const layer=state.layer=new TextLayer({textContentSource:content,container:text,viewport});await layer.render();
  state.baselines=new WeakMap(layer.textDivs.map((span,index)=>[span,page.view[3]-items[index].transform[5]]));
  if(!valid())return;
  const annotations=await page.getAnnotations({intent:'display'});if(!valid())return;
  for(const annotation of annotations){
   if(annotation.annotationType!==AnnotationType.LINK||!annotation.rect)continue;
   const link=document.createElement('a'),rect=[...viewport.convertToViewportPoint(annotation.rect[0],annotation.rect[1]),...viewport.convertToViewportPoint(annotation.rect[2],annotation.rect[3])];
   link.className='pdf-link';link.style.left=Math.min(rect[0],rect[2])+'px';link.style.top=Math.min(rect[1],rect[3])+'px';link.style.width=Math.abs(rect[2]-rect[0])+'px';link.style.height=Math.abs(rect[3]-rect[1])+'px';
   if(annotation.url&&/^(https?:|mailto:)/i.test(annotation.url)){link.href=annotation.url;link.target='_blank';link.rel='noopener noreferrer';link.title=annotation.url;}
   else if(annotation.dest){link.href='#';link.title='Go to reference';link.addEventListener('click',event=>{event.preventDefault();follow(annotation.dest).catch(report);});}
   else continue;
   state.element.append(link);
  }
  state.rendered=ticket;state.element.dataset.rendered='true';
 }catch(error){if(valid()&&error.name!=='RenderingCancelledException'&&error.name!=='AbortException'){state.rendered=ticket;throw error;}}
 finally{state.running=false;state.task=null;if(state.visible&&state.rendered!==epoch)enqueue(state);}
}
async function follow(destination){
 const dest=typeof destination==='string'?await documentPdf.getDestination(destination):destination;if(!Array.isArray(dest))return;
 const page=typeof dest[0]==='number'?dest[0]:await documentPdf.getPageIndex(dest[0]);states[page]?.element.scrollIntoView({block:'start'});
}
function release(state){state.generation++;state.task?.cancel();state.layer?.cancel();state.element.querySelectorAll('canvas').forEach(canvas=>{canvas.width=canvas.height=1;});state.element.replaceChildren();state.element.removeAttribute('data-rendered');state.rendered=-1;}
function rescale(){epoch++;for(const state of states){release(state);size(state);if(state.visible)enqueue(state);}}
function adjust(value){zoom=Math.max(.5,Math.min(3,value));rescale();}
$('zoomIn').addEventListener('click',()=>adjust(zoom*1.2));$('zoomOut').addEventListener('click',()=>adjust(zoom/1.2));$('zoomFit').addEventListener('click',()=>adjust(1));
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(rescale,150);});
window.addEventListener('wheel',event=>{if(event.ctrlKey||event.metaKey){event.preventDefault();adjust(zoom*(event.deltaY<0?1.1:1/1.1));}},{passive:false});
document.addEventListener('pointerdown',event=>{down={x:event.clientX,y:event.clientY};});
document.addEventListener('click',event=>{
 const element=event.target.closest('.pdf-page');if(!element||event.target.closest('a')||!down||Math.hypot(event.clientX-down.x,event.clientY-down.y)>5||!getSelection().isCollapsed)return;
 const state=states[Number(element.dataset.page)-1];if(!state?.viewport)return;
 if(!mapping.files.length){send({type:'pdf-source-unavailable'});return;}
 const rect=element.getBoundingClientRect(),[pdfX,pdfY]=state.viewport.convertToPdfPoint(event.clientX-rect.left,event.clientY-rect.top),x=pdfX,y=state.baselines?.get(event.target.closest('.textLayer span'))??state.pdfPage.view[3]-pdfY;
 let best=null,distance=Infinity;
 for(const point of mapping.pages[state.number]||[]){const dx=Math.abs(point[3]-x),dy=Math.abs(point[4]-y),score=dy*100+dx;if(dx<=100&&dy<=20&&score<distance){best=point;distance=score;}}
 if(best)send({type:'pdf-source',path:mapping.files[best[0]],range:{start:{line:best[1],character:best[2]}}});
});
window.addEventListener('pagehide',()=>{loadingTask?.destroy();});
async function open(){
 if(!/^[a-f0-9]{24}$/.test(pid||'')||!/^\d+(?:\.\d+)?$/.test(version||''))throw Error('Choose a compiled project PDF.');
 const base='/api/projects/'+pid,query='?v='+encodeURIComponent(version);
 const sourceResponse=await fetch(base+'/synctex'+query);if(!sourceResponse.ok)throw Error((await sourceResponse.json()).error);mapping=await sourceResponse.json();
 loadingTask=getDocument({url:base+'/pdf'+query,isEvalSupported:false,enableXfa:false,useWasm:false,cMapUrl:'/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/standard_fonts/'});documentPdf=await loadingTask.promise;
 const first=await documentPdf.getPage(1),baseViewport=first.getViewport({scale:1});
 const observer=new IntersectionObserver(entries=>{for(const entry of entries){const state=states[Number(entry.target.dataset.page)-1];state.visible=entry.isIntersecting;if(state.visible)enqueue(state);else{queue.delete(state);release(state);}}},{rootMargin:'600px'});
 for(let number=1;number<=documentPdf.numPages;number++){
  const element=document.createElement('article');element.className='pdf-page';element.dataset.page=number;element.setAttribute('aria-label','Page '+number);const state={element,number,base:baseViewport,visible:false,rendered:-1,running:false,generation:0};states.push(state);size(state);$('pages').append(element);observer.observe(element);
 }
 $('message').hidden=true;$('zoom').hidden=false;
}
open().catch(report);
