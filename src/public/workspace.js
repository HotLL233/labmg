(function(){
  'use strict';
  const clean=new WeakMap(),tables=new WeakMap(),prepared=new WeakSet(),panels=[];
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
    state.rows.forEach((row,index)=>{row.hidden=index<state.page*state.size||index>=(state.page+1)*state.size;});
    state.status.textContent=`共 ${state.rows.length} 条 · 第 ${state.page+1} / ${pages} 页 · 每页 ${state.size} 条`;
    state.prev.disabled=state.page===0;state.next.disabled=state.page+1===pages;
    state.pager.hidden=pages<=1;
  }
  function fit(root=document){
    query(root,'.ws-records').forEach(container=>{
      const state=tables.get(container);if(!state||!container.getBoundingClientRect)return;
      state.rows.forEach(row=>{row.hidden=false;});
      const scroll=container.closest?.('.mw-dialog-body,.ws-dialog-scroll');
      const bottom=Math.min(window.innerHeight,scroll?.getBoundingClientRect().bottom||window.innerHeight);
      const available=Math.max(160,bottom-container.getBoundingClientRect().top-64);
      const height=Math.max(44,...state.rows.map(row=>row.getBoundingClientRect().height));
      const head=state.table.querySelector('thead')?.getBoundingClientRect().height||36;
      const cards=window.getComputedStyle?.(state.table)?.display==='block';
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
      let pager=container.nextElementSibling;
      if(!pager?.classList.contains('ws-pagination')){
        pager=document.createElement('div');pager.className='ws-pagination';
        pager.innerHTML='<span class="ws-page-status" role="status"></span><button type="button" class="ghost" data-ws-page="prev">上一页</button><button type="button" class="ghost" data-ws-page="next">下一页</button>';
        container.parentNode.insertBefore(pager,container.nextSibling);
      }
      const state={container,table,rows,pager,status:pager.querySelector('.ws-page-status'),prev:pager.querySelector('[data-ws-page="prev"]'),next:pager.querySelector('[data-ws-page="next"]'),page:Math.max(0,Number(container.dataset.wsPage)||0),size:10};
      tables.set(container,state);container.classList.add('ws-records');
      state.prev.onclick=()=>{state.page=Math.max(0,state.page-1);paint(state);container.scrollTop=0;};
      state.next.onclick=()=>{state.page++;paint(state);container.scrollTop=0;};
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
  window.Workspace={enhance,fit,guardLeave,show,close,markClean};
})();
