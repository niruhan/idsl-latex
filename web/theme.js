// Apply the saved preference before the page paints. No account data is stored.
(() => {
 const key='labtex-theme',paletteKey='labtex-palette',media=matchMedia('(prefers-color-scheme: dark)');
 const palettes=[
  {id:'forest',name:'IDSL Forest',note:'The original green workspace',colors:['#183f36','#d9eddf','#fbfcfa']},
  {id:'western',name:'Western Purple',note:'Western purple and orchid',colors:['#4f2683','#8f55e0','#f3eef9']},
  {id:'catppuccin',name:'Catppuccin',note:'Latte by day, Mocha by night',colors:['#8839ef','#cba6f7','#1e1e2e']},
  {id:'dracula',name:'Dracula',note:'Violet, pink, and cool charcoal',colors:['#bd93f9','#ff79c6','#282a36']},
  {id:'solarized',name:'Solarized',note:'Warm paper and muted blue',colors:['#268bd2','#b58900','#fdf6e3']},
 ];
 const validPalette=value=>palettes.some(item=>item.id===value);
 let preference='system',palette='forest';
 try{const saved=localStorage.getItem(key);if(['light','dark','system'].includes(saved))preference=saved;}catch{}
 try{const saved=localStorage.getItem(paletteKey);if(validPalette(saved))palette=saved;}catch{}
 function apply(){
  const resolved=preference==='system'?(media.matches?'dark':'light'):preference;
  document.documentElement.dataset.theme=resolved;
  document.documentElement.dataset.palette=palette;
  window.dispatchEvent(new CustomEvent('labtex-themechange',{detail:{preference,resolved,palette}}));
 }
 window.labtexTheme={
  get preference(){return preference;},
  get resolved(){return document.documentElement.dataset.theme;},
  get palette(){return palette;},
  get palettes(){return palettes.map(item=>({...item,colors:[...item.colors]}));},
  set(value){if(!['light','dark','system'].includes(value))return;preference=value;try{localStorage.setItem(key,value);}catch{}apply();},
  setPalette(value){if(!validPalette(value))return;palette=value;try{localStorage.setItem(paletteKey,value);}catch{}apply();}
 };
 media.addEventListener('change',()=>{if(preference==='system')apply();});
 window.addEventListener('storage',event=>{
  if(event.key===null){preference='system';palette='forest';}
  else if(event.key===key)preference=['light','dark','system'].includes(event.newValue)?event.newValue:'system';
  else if(event.key===paletteKey)palette=validPalette(event.newValue)?event.newValue:'forest';
  else return;
  apply();
 });
 apply();
})();
