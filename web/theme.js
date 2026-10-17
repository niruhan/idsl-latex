// Apply the saved preference before the page paints. No account data is stored.
(() => {
 const key='labtex-theme',media=matchMedia('(prefers-color-scheme: dark)');
 let preference='system';
 try{const saved=localStorage.getItem(key);if(['light','dark','system'].includes(saved))preference=saved;}catch{}
 function apply(){
  const resolved=preference==='system'?(media.matches?'dark':'light'):preference;
  document.documentElement.dataset.theme=resolved;
  window.dispatchEvent(new CustomEvent('labtex-themechange',{detail:{preference,resolved}}));
 }
 window.labtexTheme={
  get preference(){return preference;},
  get resolved(){return document.documentElement.dataset.theme;},
  set(value){if(!['light','dark','system'].includes(value))return;preference=value;try{localStorage.setItem(key,value);}catch{}apply();}
 };
 media.addEventListener('change',()=>{if(preference==='system')apply();});
 window.addEventListener('storage',event=>{if(event.key!==key)return;preference=['light','dark','system'].includes(event.newValue)?event.newValue:'system';apply();});
 apply();
})();
