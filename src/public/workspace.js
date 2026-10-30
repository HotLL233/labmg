(function(){
  'use strict';
  const clean=new WeakMap(),tables=new WeakMap(),prepared=new WeakSet(),panels=[];
  // Static Lucide geometry; upstream notices are retained in docs/THIRD_PARTY.md.
  const iconPaths=Object.freeze({
    Eye:'<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle>',
    SquarePen:'<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"></path>',
    Ellipsis:'<circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle>',
    Download:'<path d="M12 15V3"></path><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m7 10 5 5 5-5"></path>',
    Search:'<path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle>',
    ListFilter:'<path d="M2 5h20"></path><path d="M6 12h12"></path><path d="M9 19h6"></path>',
    SlidersHorizontal:'<path d="M10 5H3"></path><path d="M12 19H3"></path><path d="M14 3v4"></path><path d="M16 17v4"></path><path d="M21 12h-9"></path><path d="M21 19h-5"></path><path d="M21 5h-7"></path><path d="M8 10v4"></path><path d="M8 12H3"></path>',
    ClipboardCheck:'<rect width="8" height="4" x="8" y="2" rx="1" ry="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><path d="m9 14 2 2 4-4"></path>',
    Printer:'<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"></path><rect x="6" y="14" width="12" height="8" rx="1"></rect>'
  });
  function icon(name){
    if(typeof name!=='string'||!Object.hasOwn(iconPaths,name))return '';
    return '<svg class="ws-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+iconPaths[name]+'</svg>';
  }
  let frame,blockedPage;
  const query=(root,selector)=>Array.from((root||document).querySelectorAll(selector));
  const fields=dialog=>query(dialog,'input,select,textarea').filter(node=>node.name||node.id);
  const snapshot=dialog=>JSON.stringify(fields(dialog).map(node=>[node.name||node.id,node.type==='checkbox'||node.type==='radio'?node.checked:node.value]));
  const dirty=dialog=>clean.has(dialog)&&clean.get(dialog)!==snapshot(dialog);
  const markClean=dialog=>clean.set(dialog,snapshot(dialog));
  function allowed(dialog){
    if(dialog.dataset.wsBusy==='true'){if(typeof toast==='function')toast('正在保存，请等待本次操作完成。');return false;}
    return !dirty(dialog)||window.confirm('当前输入尚未保存，确定放弃并返回吗？');
  }
  function guardLeave(){
    if(window.MaterialWorkflow?.canLeave&&!window.MaterialWorkflow.canLeave())return false;
    return query(document,'dialog').filter(dialog=>dialog.open&&dialog.classList.contains('ws-dialog')).every(allowed);
  }
  function syncPanels(){
    const top=panels.at(-1),page=document.querySelector('.page');
    if(top&&page&&!blockedPage){blockedPage={node:page,inert:Boolean(page.inert)};page.inert=true;}
    if(!top&&blockedPage){blockedPage.node.inert=blockedPage.inert;blockedPage=null;}
    panels.forEach(entry=>{entry.dialog.inert=entry!==top;entry.dialog.dataset.wsActive=String(entry===top);});
    document.body.classList.toggle('ws-panel-open',Boolean(top));
    const bottom=document.querySelector('.layout header')?.getBoundingClientRect?.().bottom;
    document.body.style.setProperty?.('--ws-header-bottom',Math.max(0,Number(bottom)||64)+'px');
  }
  function release(dialog){
    const index=panels.findIndex(entry=>entry.dialog===dialog);if(index<0)return;
    const wasTop=index===panels.length-1,[entry]=panels.splice(index,1);
    dialog.inert=entry.inert;delete dialog.dataset.wsActive;syncPanels();
    if(wasTop){const top=panels.at(-1)?.dialog,target=top?(top.contains(entry.focus)?entry.focus:top):entry.focus;if(document.body.contains(target))target.focus?.();}
  }
  function close(dialog,{force=false}={}){
    if(!force&&!allowed(dialog))return false;
    markClean(dialog);dialog.close();release(dialog);return true;
  }
  function show(dialog){
    dialog.classList.add('ws-dialog');query(dialog,'.ws-context').forEach(node=>node.remove());
    dialog.dataset.wsModule=typeof current==='string'?current:'';
    if(!prepared.has(dialog)){
      prepared.add(dialog);
      dialog.addEventListener('cancel',event=>{if(!event.defaultPrevented){event.preventDefault();close(dialog);}});
      dialog.addEventListener('close',()=>{if(!dialog.open)release(dialog);});
      const form=Array.from(dialog.children).find(node=>node.tagName.toLowerCase()==='form');
      const host=form||dialog;
      if(!host.querySelector('.mw-dialog-body,.ws-dialog-scroll')){
        const body=document.createElement('div');body.className='ws-dialog-scroll';
        const children=Array.from(host.children).filter(node=>!node.classList.contains('ws-context')&&!node.classList.contains('modal-head')&&!node.classList.contains('mw-dialog-head')&&!node.classList.contains('mw-dialog-actions')&&node.tagName.toLowerCase()!=='footer');
        if(children.length){host.insertBefore(body,children[0]);children.forEach(node=>body.appendChild(node));}
      }
    }
    if(!dialog.classList.contains('mw-inline-form')){
      if(document.querySelector('.page')?.contains(dialog))document.body.append(dialog);
      let entry=panels.find(item=>item.dialog===dialog);
      if(entry)panels.splice(panels.indexOf(entry),1);else entry={dialog,focus:document.activeElement,inert:Boolean(dialog.inert)};
      panels.push(entry);syncPanels();
    }
    if(!dialog.open){markClean(dialog);dialog.show();}
    enhance(dialog);fit(dialog);
  }
  function paint(state){
    const pages=Math.max(1,Math.ceil(state.rows.length/state.size));
    state.page=Math.min(state.page,pages-1);
    state.container.dataset.wsPage=String(state.page);
    if(state.fixed)state.container.dataset.wsSize=String(state.size);
    state.rows.forEach((row,index)=>{row.hidden=index<state.page*state.size||index>=(state.page+1)*state.size;});
    state.status.textContent=`共 ${state.rows.length} 条 · 第 ${state.page+1} / ${pages} 页 · 每页 ${state.size} 条`;
    state.prev.disabled=state.page===0;state.next.disabled=state.page+1===pages;
    state.pager.hidden=state.fixed?state.rows.length<=10:pages<=1;
  }
  function fit(root=document){
    query(root,'.ws-records').forEach(container=>{
      const state=tables.get(container);if(!state||!container.getBoundingClientRect)return;
      state.rows.forEach(row=>{row.hidden=false;});
      const scroll=container.closest?.('.mw-dialog-body,.ws-dialog-scroll');
      const bottom=Math.min(window.innerHeight,scroll?.getBoundingClientRect().bottom||window.innerHeight);
      const available=Math.max(160,bottom-container.getBoundingClientRect().top-64);
      const cards=window.getComputedStyle?.(state.table)?.display==='block';
      if(state.fixed){container.style.maxHeight=cards?'none':available+'px';paint(state);return;}
      const height=Math.max(44,...state.rows.map(row=>row.getBoundingClientRect().height));
      const head=state.table.querySelector('thead')?.getBoundingClientRect().height||36;
      state.size=cards?10:Math.max(1,Math.floor((available-head)/height));
      container.style.maxHeight=cards?'none':available+'px';
      paint(state);
    });
  }
  function enhance(root=document){
    query(root,'.table').forEach(container=>{
      if(container.dataset.wsSkip==='true'||container.nextElementSibling?.classList.contains('mw-pagebar')||tables.has(container)||!container.getBoundingClientRect)return;
      const table=container.querySelector('table'),body=table?.querySelector('tbody');
      if(!body)return;
      const rows=Array.from(body.children);if(!rows.length)return;
      const fixed=container.dataset.wsFixed==='true';
      let pager=container.nextElementSibling;
      if(!pager?.classList.contains('ws-pagination')){
        pager=document.createElement('div');pager.className='ws-pagination';
        pager.innerHTML='<span class="ws-page-status" role="status"></span>'+(fixed?'<label class="ws-page-size">每页条数<select data-ws-size aria-label="每页条数"><option value="10">10</option><option value="20">20</option><option value="50">50</option></select></label>':'')+'<button type="button" class="ghost" data-ws-page="prev">上一页</button><button type="button" class="ghost" data-ws-page="next">下一页</button>';
        container.parentNode.insertBefore(pager,container.nextSibling);
      }
      const requestedSize=Number(container.dataset.wsSize);
      const state={container,table,rows,pager,fixed,status:pager.querySelector('.ws-page-status'),prev:pager.querySelector('[data-ws-page="prev"]'),next:pager.querySelector('[data-ws-page="next"]'),page:Math.max(0,Number(container.dataset.wsPage)||0),size:fixed&&[10,20,50].includes(requestedSize)?requestedSize:10};
      tables.set(container,state);container.classList.add('ws-records');
      state.prev.onclick=()=>{state.page=Math.max(0,state.page-1);paint(state);container.scrollTop=0;};
      state.next.onclick=()=>{state.page++;paint(state);container.scrollTop=0;};
      const sizeSelect=pager.querySelector('[data-ws-size]');
      if(sizeSelect){sizeSelect.value=String(state.size);sizeSelect.onchange=()=>{const size=Number(sizeSelect.value);if(![10,20,50].includes(size))return;state.size=size;state.page=0;paint(state);container.scrollTop=0;};}
    });
    fit(root);
  }
  window.addEventListener('resize',()=>{if(frame)cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{syncPanels();fit();});});
  window.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||event.defaultPrevented||query(document,'dialog').some(dialog=>dialog.open&&dialog.matches?.(':modal')))return;
    const top=panels.at(-1)?.dialog;if(!top)return;
    event.preventDefault();top.dispatchEvent(new Event('cancel',{cancelable:true}));
  });
  window.addEventListener('beforeunload',event=>{
    if(window.MaterialWorkflow?.hasPending?.()||query(document,'dialog').some(dialog=>dialog.open&&dialog.classList.contains('ws-dialog')&&(dirty(dialog)||dialog.dataset.wsBusy==='true'))){event.preventDefault();event.returnValue='';}
  });
  window.Workspace={enhance,fit,guardLeave,show,close,markClean,icon};
})();
