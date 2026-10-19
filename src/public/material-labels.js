/* 标签仅复用已记账编码；布局保存在本浏览器，业务数据不随模板保存。 */
(()=>{
'use strict';
const key='labos.material-label.v1';
const fields=[['name','物资名称'],['spec','规格'],['code','单件编码'],['barcode','Code128'],['qr','二维码'],['catalogCode','物资编码'],['regionName','区域'],['warehouse','仓库'],['location','存放位置'],['batch','批号'],['expiryDate','有效期']];
const defaults={schema:1,width:60,height:40,offsetX:0,offsetY:0,elements:[
  {field:'name',x:2,y:1,w:44,h:5,font:11,show:true},
  {field:'spec',x:2,y:6,w:44,h:4,font:8,show:true},
  {field:'code',x:2,y:10,w:44,h:4,font:8,show:true},
  {field:'barcode',x:2,y:15,w:44,h:12,font:8,show:true},
  {field:'qr',x:47,y:1,w:12,h:12,font:8,show:true},
  {field:'catalogCode',x:2,y:27,w:44,h:4,font:8,show:false},
  {field:'regionName',x:2,y:31,w:24,h:4,font:8,show:false},
  {field:'warehouse',x:27,y:31,w:29,h:4,font:8,show:false},
  {field:'location',x:2,y:28,w:54,h:5,font:9,show:true},
  {field:'batch',x:2,y:34,w:28,h:4,font:8,show:true},
  {field:'expiryDate',x:30,y:34,w:28,h:4,font:8,show:true}
]};
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy=v=>JSON.parse(JSON.stringify(v));
function validate(value){
  const number=(v,min,max,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error(label+'超出允许范围。');return v;};
  if(!value||value.schema!==1||!Array.isArray(value.elements)||value.elements.length!==fields.length)throw Error('不是有效的标签模板。');
  const result={schema:1,width:number(value.width,20,200,'宽度'),height:number(value.height,15,200,'高度'),offsetX:number(value.offsetX,-10,10,'水平偏移'),offsetY:number(value.offsetY,-10,10,'垂直偏移')};
  const seen=new Set();result.elements=value.elements.map(item=>{
    if(!item||!fields.some(([f])=>f===item.field)||seen.has(item.field)||typeof item.show!=='boolean')throw Error('标签元素重复或未知。');
    seen.add(item.field);
    const e={field:item.field,show:item.show,x:number(item.x,0,200,'X'),y:number(item.y,0,200,'Y'),w:number(item.w,1,200,'元素宽'),h:number(item.h,1,200,'元素高'),font:number(item.font,5,48,'字号')};
    if(e.show&&(e.x+e.w>result.width+.001||e.y+e.h>result.height+.001))throw Error((fields.find(([f])=>f===e.field)[1])+'超出标签边界，请调整位置或尺寸。');
    return e;
  });return result;
}
function load(){try{const value=localStorage.getItem(key);return value?validate(JSON.parse(value)):copy(defaults);}catch{return copy(defaults);}}
function csv(rows){
  const columns=[['Code','code'],['QRPayload','qrPayload'],['Name','name'],['CatalogCode','catalogCode'],['Specification','spec'],['Unit','unit'],['Region','regionName'],['Warehouse','warehouse'],['Location','location'],['Batch','batch'],['ExpiryDate','expiryDate'],['Status','status']];
  const cell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
  return '\uFEFF'+[columns.map(([name])=>cell(name)).join(','),...rows.map(row=>columns.map(([,field])=>cell(row[field])).join(','))].join('\r\n')+'\r\n';
}
function download(content,type,name){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function rowsFrom(source,options){
  const rows=typeof source==='function'?await source():source;
  if(options.isActive&&!options.isActive())throw Error('页面已切换，请重新打开标签。');
  if(!Array.isArray(rows)||!rows.length||rows.length>1000)throw Error('请选择 1–1000 件实物。');
  const codes=new Set();for(const row of rows){if(!row||typeof row.code!=='string'||!row.code.trim()||codes.has(row.code))throw Error('单件编码缺失或重复，请刷新后重试。');codes.add(row.code);}
  return rows;
}
async function exportData(source,options={}){const rows=await rowsFrom(source,options);download(csv(rows),'text/csv;charset=utf-8','labos-bartender.csv');}
function labelHtml(row,template,images={}){
  return '<section class="label">'+template.elements.filter(e=>e.show).map(e=>{
    const style=`left:${e.x}mm;top:${e.y}mm;width:${e.w}mm;height:${e.h}mm;font-size:${e.font}pt;`;
    if(e.field==='qr'||e.field==='barcode')return `<div class="element image" style="${style}">${images[e.field]?`<img alt="${e.field}" src="${h(images[e.field])}">`:h(e.field==='qr'?'二维码':'Code128')}</div>`;
    const value=row[e.field]??'';
    const prefix={location:'位置：',batch:'批号：',expiryDate:'效期：'}[e.field]||'';
    return `<div class="element" style="${style}">${h(value?prefix+value:'')}</div>`;
  }).join('')+'</section>';
}
function layoutCss(t,preview=false){const scope=preview?'#material-label-designer [data-label="preview"] ':'';return `${scope}.label{position:relative;box-sizing:border-box;width:${t.width}mm;height:${t.height}mm;overflow:hidden;background:white;break-after:page;page-break-after:always}${scope}.label:last-child{break-after:auto;page-break-after:auto}${scope}.element{position:absolute;box-sizing:border-box;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.15;transform:translate(${t.offsetX}mm,${t.offsetY}mm)}${scope}.image{display:flex;align-items:center;justify-content:center}${scope}.image img{display:block;width:100%;height:100%;object-fit:contain}${preview?'':`@page{size:${t.width}mm ${t.height}mm;margin:0}`}`;}
async function print(source,options,batch=false){
  const popup=window.open('','_blank','width=950,height=760');if(!popup)throw Error('请允许此站点打开标签弹窗后重试。');popup.opener=null;
  const urls=[];let cancelled=false,closed;
  const closedPromise=new Promise(resolve=>{closed=resolve;});
  const live=()=>!cancelled&&!popup.closed&&(!options.isActive||options.isActive());
  const cleanup=()=>{if(cancelled)return;cancelled=true;for(const url of urls)URL.revokeObjectURL(url);closed();};
  const wait=promise=>Promise.race([promise,closedPromise]);
  popup.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>准备标签</title><body><p role="status">正在读取编码并生成标签，请稍候…</p></body></html>');popup.document.close();
  popup.addEventListener('pagehide',cleanup,{once:true});
  try{
    const rows=batch?[source]:await wait(rowsFrom(source,options));if(!live()){popup.close();return;}
    const t=load(),html=[];
    if(batch)t.elements.find(e=>e.field==='barcode').show=false;
    for(const row of rows){
      const images={};for(const e of t.elements.filter(e=>e.show&&(e.field==='qr'||e.field==='barcode'))){
        if(batch&&e.field==='barcode')continue;
        const text=e.field==='qr'?(row.qrPayload||row.code):row.code;
        const blob=await wait(e.field==='qr'?MaterialScanner.createQr(text):MaterialScanner.createBarcode(text));
        if(!live()){popup.close();return;}const url=URL.createObjectURL(blob);urls.push(url);images[e.field]=url;
      }
      html.push(labelHtml(row,t,images));
      popup.document.querySelector('[role="status"]').textContent=`正在生成标签 ${html.length} / ${rows.length}…`;
      if(html.length%20===0){await wait(new Promise(resolve=>setTimeout(resolve,0)));if(!live()){popup.close();return;}}
    }
    if(!live()){popup.close();return;}
    const doc=popup.document;doc.open();doc.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${h(options.title||'物资标签')}</title><style>body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;color:#111;background:#eee}.tools{padding:14px;position:sticky;top:0;background:white;z-index:1;box-shadow:0 1px 5px #aaa}.tools p{margin:6px 0;font-size:13px}button{padding:8px 14px;cursor:pointer}.pages{display:grid;gap:12px;padding:15px;width:max-content}.label{box-shadow:0 1px 5px #aaa}${layoutCss(t)}@media print{body{background:white}.tools{display:none}.pages{display:block;padding:0}.label{box-shadow:none}}</style></head><body><div class="tools"><button id="print" disabled>打印标签</button> ${batch?'':'<button id="csv">导出 BarTender 数据</button>'}<p>每页一张 ${t.width} × ${t.height} mm 标签，共 ${rows.length} 张。请选择 DL-886A（NEW）的已安装驱动、相同纸张尺寸、100% 缩放，关闭页眉页脚。</p><p>CSV 为逐件打印数据：BarTender 每记录 1 份，关闭额外序列化；按 UTF-8 文本数据库连接，勿用 Excel 自动转换编码。</p><p id="status" role="status">正在检查条码图片…</p></div><main class="pages">${html.join('')}</main></body></html>`);doc.close();
    // document.open() clears window listeners, so attach lifecycle cleanup to the final document too.
    popup.addEventListener('pagehide',cleanup,{once:true});
    await wait(Promise.all(Array.from(doc.images).map(img=>img.complete?(img.naturalWidth?Promise.resolve():Promise.reject(Error('标签图片加载失败。'))):new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('标签图片加载失败。'));}))));
    if(!live()){popup.close();return;}
    doc.getElementById('print').disabled=false;doc.getElementById('print').onclick=()=>{if(!live()){popup.close();cleanup();return;}popup.print();};
    if(!batch)doc.getElementById('csv').onclick=()=>{if(!live()){popup.close();cleanup();return;}download(csv(rows),'text/csv;charset=utf-8','labos-bartender.csv');};
    doc.getElementById('status').textContent='标签已准备好。请先试打一张，校准纸张与偏移。';
  }catch(error){if(!popup.closed){const p=popup.document.createElement('p');p.setAttribute('role','alert');p.textContent='标签未生成：'+error.message;popup.document.body.replaceChildren(p);}cleanup();throw error;}
  finally{if(popup.closed)cleanup();}
}
function printUnits(source,options={}){return print(source,options);}
function printBatch(batch,options={}){return print({...batch,code:batch.catalogCode||batch.code},options,true);}
function configure(){
  document.getElementById('material-label-designer')?.remove();
  const dialog=document.createElement('dialog');dialog.id='material-label-designer';dialog.className='mw-dialog mw-wide';dialog.setAttribute('aria-label','标签模板设计');
  dialog.innerHTML=`<form><div class="mw-dialog-head"><h2>标签模板设计</h2><button type="button" data-label="close" aria-label="关闭">×</button></div><div class="mw-dialog-body"><p>模板保存在本浏览器。单位为毫米，字号为 pt；复杂版式可导出逐件数据到 BarTender 设计。当前尺寸是示例，需按实际标签纸调整。</p><div class="mw-grid">${[['width','标签宽',20,200],['height','标签高',15,200],['offsetX','水平校准偏移',-10,10],['offsetY','垂直校准偏移',-10,10]].map(([name,label,min,max])=>`<label>${label}<input type="number" name="${name}" min="${min}" max="${max}" step="0.1" required></label>`).join('')}</div><p>位置 X / Y 从标签左上角起算；偏移只用于打印校准，可能裁切边缘，请先试打。</p><div class="mw-table"><table><thead><tr>${['显示','元素','X','Y','宽','高','字号'].map(v=>'<th>'+v+'</th>').join('')}</tr></thead><tbody>${fields.map(([field,label])=>`<tr data-field="${field}"><td><input aria-label="显示${label}" type="checkbox" name="${field}-show"></td><td>${label}</td>${['x','y','w','h','font'].map(n=>`<td><input aria-label="${label} ${n}" style="width:72px" type="number" name="${field}-${n}" min="${n==='font'?5:n==='w'||n==='h'?1:0}" max="${n==='font'?48:200}" step="0.1" required></td>`).join('')}</tr>`).join('')}</tbody></table></div><p role="alert" class="mw-error" data-label="error"></p><div style="overflow:auto;background:#eee;padding:15px" data-label="preview"></div><p>预览使用示例数据；每瓶／每件的编码已固定，重印不会生成新流水。</p><label>导入模板 JSON<input data-label="import" type="file" accept=".json,application/json"></label></div><div class="mw-dialog-actions"><button type="button" data-label="reset">恢复示例</button><button type="button" data-label="export">导出模板 JSON</button><button type="submit" class="primary">保存到本浏览器</button></div></form>`;
  const form=dialog.querySelector('form'),error=dialog.querySelector('[data-label="error"]'),preview=dialog.querySelector('[data-label="preview"]');let current=load();
  const sample={name:'示例物资（非业务数据）',spec:'500 mL',code:'LAB-20261019-000001',catalogCode:'MAT-001',regionName:'示例区域',warehouse:'MAIN',location:'A柜 / 2层',batch:'B001',expiryDate:'2027-10-19'};
  const read=()=>validate({schema:1,...Object.fromEntries(['width','height','offsetX','offsetY'].map(n=>[n,Number(form.elements.namedItem(n).value)])),elements:fields.map(([field])=>({field,show:form.elements.namedItem(field+'-show').checked,...Object.fromEntries(['x','y','w','h','font'].map(n=>[n,Number(form.elements.namedItem(field+'-'+n).value)]))}))});
  function render(){try{const value=read();preview.innerHTML=`<style>${layoutCss(value,true)}</style>${labelHtml(sample,value)}`;error.textContent='';current=value;}catch(e){error.textContent=e.message;}}
  function fill(value){for(const name of ['width','height','offsetX','offsetY'])form.elements.namedItem(name).value=value[name];for(const e of value.elements){form.elements.namedItem(e.field+'-show').checked=e.show;for(const n of ['x','y','w','h','font'])form.elements.namedItem(e.field+'-'+n).value=e[n];}render();}
  form.oninput=render;form.onsubmit=event=>{event.preventDefault();try{current=read();localStorage.setItem(key,JSON.stringify(current));dialog.close();}catch(e){error.textContent=e.message;}};
  dialog.querySelector('[data-label="close"]').onclick=()=>dialog.close();
  dialog.querySelector('[data-label="reset"]').onclick=()=>fill(copy(defaults));
  dialog.querySelector('[data-label="export"]').onclick=()=>{try{download(JSON.stringify(read(),null,2),'application/json','labos-label-template.json');}catch(e){error.textContent=e.message;}};
  dialog.querySelector('[data-label="import"]').onchange=async event=>{const file=event.target.files[0];event.target.value='';if(!file)return;try{if(file.size>65536)throw Error('模板不能超过 64 KiB。');fill(validate(JSON.parse(await file.text())));}catch(e){error.textContent='导入失败：'+e.message;}};
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.appendChild(dialog);fill(current);dialog.showModal();
}
globalThis.MaterialLabels=Object.freeze({configure,printUnits,printBatch,exportData});
if(typeof module!=='undefined'&&module.exports)module.exports={validate,defaults,csv,labelHtml,layoutCss,rowsFrom};
})();
