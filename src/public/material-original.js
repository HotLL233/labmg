/* 纸面核对单只读取固定修订；到货进度与附件不混入原单。 */
(()=>{
'use strict';
const h=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let ticket=0;
function identity(id,revision){
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(revision)||revision<1)throw Error('原单编号或修订版本无效。');
  return {id,revision};
}
function target(hash){
  const match=/^#material-original=([1-9]\d*)&revision=([1-9]\d*)$/.exec(hash||'');
  if(!match)return null;
  try{return identity(Number(match[1]),Number(match[2]));}catch{return null;}
}
function viewUrl(id,revision,origin=location.origin){
  identity(id,revision);
  const url=new URL(origin),host=url.hostname.toLowerCase().replace(/\.$/,'');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||
    host==='0.0.0.0'||host==='[::]'||host==='[::1]'||/^127\./.test(host)||/^\[::ffff:(?:7f[0-9a-f]{2}:|0:0\])/.test(host)||
    /(^|\.)(localhost|internal|invalid)$/.test(host)||(!host.includes('.')&&!host.startsWith('[')))
    throw Error('请通过手机可访问的群晖 IP 或域名打开系统，再生成原单二维码；不能使用本机或容器内部地址。');
  return url.origin+'/#material-original='+id+'&revision='+revision;
}
function sheetHtml(snapshot,revision,{url='',qr=''}={}){
  const rows=snapshot.items.map((row,index)=>`<tr><td>${index+1}</td><td><strong>${h(row.name)}</strong><small>${h(row.spec||'—')}</small></td><td>${h(row.unit)}</td><td class="num">${h(Number((row.qtyM/1000).toFixed(3)))}</td><td>${h(row.manufacturer||'未指定')}</td><td>${h(row.regionName)}<small>${h(row.warehouseName||row.warehouse)}</small></td><td>${h(row.purpose||'—')}</td><td class="mo-check">□</td><td></td><td></td></tr>`).join('');
  return `<article class="mo-sheet"><div class="mo-heading"><div><h2>物资申报核对单</h2><p><strong>${h(snapshot.no)} · r${revision}</strong>　${h(snapshot.title)}</p><p>申报人：${h(snapshot.creatorName||'—')}　提交日期：${h(snapshot.submittedAt?.slice(0,10)||'—')}</p></div>${qr?`<figure><img class="mo-qr" src="${h(qr)}" alt="查看${h(snapshot.no)}修订${revision}原单二维码"><figcaption>扫码查看本版原单</figcaption></figure>`:''}</div>${snapshot.description?`<p class="mo-description">${h(snapshot.description)}</p>`:''}<p class="mo-handwrite">第______次到货　到货日期：____________　验收人：____________</p><div class="table mo-records" data-ws-skip="true"><table><colgroup>${[4,20,5,7,12,12,12,5,8,15].map(width=>`<col style="width:${width}%">`).join('')}</colgroup><thead><tr>${['序号','物资名称／规格','单位','申报量','申报厂家','区域／仓库','用途','核对√','本次实到','备注'].map(label=>'<th>'+label+'</th>').join('')}</tr></thead><tbody>${rows}</tbody></table></div><p class="mo-note">固定申报修订 r${revision} · 共 ${snapshot.items.length} 项。纸面勾选及填写不会自动入库，请在系统按本次实际到货办理验收。</p>${url?`<p class="mo-link">原单地址：${h(url)}</p>`:''}</article>`;
}
async function fixed(id,revision){
  identity(id,revision===undefined?1:revision);
  if(revision===undefined)revision=(await call('/api/materials/requests/'+id)).revision;
  identity(id,revision);
  const result=await call(`/api/materials/requests/${id}/snapshot?revision=${revision}`);
  if(result.revision!==revision||result.snapshot?.id!==id||!Array.isArray(result.snapshot.items))throw Error('原单版本响应不一致，请重新打开。');
  return result;
}
async function download(id,revision){
  const result=await fixed(id,revision);revision=result.revision;
  let url='';try{url=viewUrl(id,revision);}catch{}
  const response=await fetch(`/api/materials/requests/${id}/snapshot/export.xlsx?revision=${revision}${url?'&viewUrl='+encodeURIComponent(url):''}`);
  if(!response.ok){const error=await response.json();throw Error(error.error||'原单下载失败。');}
  const href=URL.createObjectURL(await response.blob()),link=document.createElement('a');
  link.href=href;link.download=`申报原单-${id}-r${revision}.xlsx`;document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(href),1000);
}
function print(snapshot,revision,url,blob){
  const popup=window.open('','_blank','width=1100,height=760');
  if(!popup)throw Error('请允许本站打开打印窗口后重试。');
  popup.opener=null;
  const qr=URL.createObjectURL(blob),doc=popup.document;let preparationFailed=false;
  const cleanup=()=>URL.revokeObjectURL(qr);
  doc.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(snapshot.no)} · r${revision}</title><link rel="stylesheet" href="${h(location.origin)}/styles.css"><link rel="stylesheet" href="${h(location.origin)}/tokens.css"><link rel="stylesheet" href="${h(location.origin)}/material-original.css"></head><body class="mo-print"><div class="mo-tools"><button id="mo-print" disabled>系统打印／保存 PDF</button><p id="mo-status" role="status">正在准备原单二维码…</p></div>${sheetHtml(snapshot,revision,{url,qr})}</body></html>`);doc.close();
  popup.addEventListener('pagehide',cleanup,{once:true});
  const button=doc.getElementById('mo-print'),status=doc.getElementById('mo-status');
  const ready=()=>{if(popup.closed||preparationFailed)return;const image=doc.querySelector('.mo-qr');if(!image.complete||[...doc.querySelectorAll('link[rel="stylesheet"]')].some(link=>!link.sheet))return;if(!image.naturalWidth){failed();return;}button.disabled=false;status.textContent='A4 横向核对单。请在打印窗口选择纸张和缩放；保存 PDF 需手动选择对应目标。';};
  const failed=()=>{preparationFailed=true;if(!popup.closed){button.disabled=true;status.setAttribute('role','alert');status.textContent='二维码图片加载失败，请关闭本窗口后重新生成。';}};
  const image=doc.querySelector('.mo-qr');image.onerror=failed;image.onload=ready;
  popup.addEventListener('load',ready,{once:true});
  for(const link of doc.querySelectorAll('link[rel="stylesheet"]')){link.onload=ready;link.onerror=()=>{failed();status.textContent='打印样式加载失败，请关闭本窗口后重试。';};}
  if(doc.readyState==='complete')ready();
  button.onclick=()=>{if(!popup.closed&&!button.disabled)popup.print();};
}
async function open(id,revision){
  const own=++ticket;
  const previous=document.getElementById('material-original');if(previous)Workspace.close(previous,{force:true});
  const dialog=document.createElement('dialog');dialog.id='material-original';dialog.className='mw-dialog';dialog.setAttribute('aria-label','固定修订申报原单');
  dialog.innerHTML='<div class="mw-dialog-head"><h2>申报原单</h2><button type="button" data-mo="close">返回</button></div><div class="mw-dialog-body"><p role="status">正在读取固定修订…</p></div><div class="mw-dialog-actions"><p class="mo-status" role="alert" data-mo="error" hidden></p><button type="button" data-mo="download" disabled>下载 Excel</button><button type="button" data-mo="print" class="primary" disabled>打印核对单／PDF</button></div>';
  document.body.appendChild(dialog);
  const close=()=>Workspace.close(dialog,{force:true});
  dialog.querySelector('[data-mo="close"]').onclick=close;
  let qr='';const live=()=>own===ticket&&dialog.open&&document.body.contains(dialog);
  dialog.addEventListener('close',()=>{if(qr)URL.revokeObjectURL(qr);dialog.remove();},{once:true});
  Workspace.show(dialog);
  const report=message=>{const error=dialog.querySelector('[data-mo="error"]');error.hidden=false;error.textContent=message;};
  try{
    const result=await fixed(id,revision);if(!live())return;
    revision=result.revision;
    const body=dialog.querySelector('.mw-dialog-body');
    const paint=(url='',image='')=>{body.innerHTML=(result.currentRevision>revision?`<p class="mo-version-notice">正在查看 r${revision} 固定原单。当前已修订到 r${result.currentRevision}。<button type="button" data-mo="latest">查看当前修订</button></p>`:'')+sheetHtml(result.snapshot,revision,{url,qr:image});labelTable(body);const latest=body.querySelector('[data-mo="latest"]');if(latest)latest.onclick=()=>open(id,result.currentRevision);};
    paint();
    const downloadButton=dialog.querySelector('[data-mo="download"]');downloadButton.disabled=false;
    downloadButton.onclick=async()=>{if(downloadButton.disabled)return;downloadButton.disabled=true;try{await download(id,revision);}catch(error){if(live())report(error.message);}finally{if(live())downloadButton.disabled=false;}};
    const url=viewUrl(id,revision),blob=await MaterialScanner.createQr(url);if(!live())return;
    qr=URL.createObjectURL(blob);paint(url,qr);
    const printButton=dialog.querySelector('[data-mo="print"]');printButton.disabled=false;
    printButton.onclick=()=>{try{print(result.snapshot,revision,url,blob);}catch(error){report(error.message);}};
  }catch(error){if(live())report(error.message);}
}
async function resume(){
  const selected=target(location.hash);if(!selected)return false;
  if(typeof currentUser==='undefined'||!currentUser)return false;
  if(await go('materials')===false)return true;
  await open(selected.id,selected.revision);return true;
}
globalThis.MaterialOriginal=Object.freeze({open,download,resume});
if(typeof addEventListener==='function')addEventListener('hashchange',()=>{if(typeof currentUser!=='undefined'&&currentUser)resume().catch(error=>toast(error.message));});
if(typeof module!=='undefined')module.exports={target,viewUrl,sheetHtml};
})();
