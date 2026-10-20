/* 标签仅复用已记账编码；布局保存在本浏览器，业务数据不随模板保存。 */
(()=>{
'use strict';
const key='labos.material-label.v1';
const fields=[['name','物资名称'],['spec','规格'],['unit','单位'],['code','单件编号'],['qr','二维码'],['catalogCode','物资编码'],['regionName','区域'],['warehouse','仓库'],['location','存放位置'],['batch','批号'],['expiryDate','有效期']];
const defaults={schema:1,width:60,height:40,rotation:0,offsetX:0,offsetY:0,elements:[
  {field:'name',x:2,y:1,w:37,h:5,font:11,show:true},
  {field:'spec',x:2,y:7,w:37,h:5,font:9,show:true},
  {field:'unit',x:2,y:13,w:37,h:4,font:8,show:true},
  {field:'code',x:2,y:20,w:56,h:4,font:8,show:true},
  {field:'qr',x:41,y:1,w:17,h:17,font:8,show:true},
  {field:'catalogCode',x:2,y:20,w:56,h:4,font:8,show:false},
  {field:'regionName',x:2,y:31,w:24,h:4,font:8,show:false},
  {field:'warehouse',x:27,y:31,w:29,h:4,font:8,show:false},
  {field:'location',x:2,y:26,w:56,h:5,font:9,show:true},
  {field:'batch',x:2,y:34,w:28,h:4,font:8,show:false},
  {field:'expiryDate',x:30,y:34,w:28,h:4,font:8,show:false}
]};
const papers=[['60x40','60 × 40 mm',60,40],['38.5x30.5','38.5 × 30.5 mm',38.5,30.5]];
let closeDesigner;
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy=v=>JSON.parse(JSON.stringify(v));
function validate(value,includeOffset=true){
  const number=(v,min,max,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error(label+'超出允许范围。');return v;};
  if(!value||value.schema!==1||!Array.isArray(value.elements))throw Error('不是有效的标签模板。');
  // Older schema 1 templates keep their layout; the removed one-dimensional code is never rendered.
  if(value.elements.filter(item=>item?.field==='barcode').length>1)throw Error('标签元素重复或未知。');
  const elements=value.elements.filter(item=>item?.field!=='barcode');
  if(!elements.some(item=>item?.field==='unit'))elements.push({...defaults.elements.find(item=>item.field==='unit'),show:false});
  if(elements.length!==fields.length)throw Error('不是有效的标签模板。');
  const rotation=value.rotation??0;if(rotation!==0&&rotation!==90)throw Error('内容方向只支持 0° 或 90°。');
  const result={schema:1,width:number(value.width,15,200,'纸宽'),height:number(value.height,15,200,'走纸长'),rotation,offsetX:number(value.offsetX,-10,10,'水平偏移'),offsetY:number(value.offsetY,-10,10,'垂直偏移')};
  const seen=new Set();result.elements=elements.map(item=>{
    if(!item||!fields.some(([f])=>f===item.field)||seen.has(item.field)||typeof item.show!=='boolean')throw Error('标签元素重复或未知。');
    seen.add(item.field);
    const e={field:item.field,show:item.show,x:number(item.x,0,200,'X'),y:number(item.y,0,200,'Y'),w:number(item.w,1,200,'元素宽'),h:number(item.h,1,200,'元素高'),font:number(item.font,5,48,'字号')};
    if(includeOffset&&e.show&&e.field==='qr'&&Math.min(e.w,e.h)<12)throw Error('二维码小于 12 mm，请在“标签模板”恢复新版默认或调整二维码宽高（至少 12 mm），再试打回扫。');
    const dx=includeOffset?result.offsetX:0,dy=includeOffset?result.offsetY:0;
    const [x,y,w,h]=rotation===90?[result.width-e.y-e.h+dx,e.x+dy,e.h,e.w]:[e.x+dx,e.y+dy,e.w,e.h];
    if(e.show&&(x<-.001||y<-.001||x+w>result.width+.001||y+h>result.height+.001))throw Error((fields.find(([f])=>f===e.field)[1])+'超出标签边界（含校准偏移），请调整位置、尺寸或偏移。');
    return e;
  });return result;
}
function resize(template,width,height,rotation=template.rotation??0){
  const [oldWidth,oldHeight]=template.rotation===90?[template.height,template.width]:[template.width,template.height];
  const [contentWidth,contentHeight]=rotation===90?[height,width]:[width,height];
  const sx=contentWidth/oldWidth,sy=contentHeight/oldHeight;
  const elements=template.elements.map(e=>({...e,x:e.x*sx,y:e.y*sy,w:e.w*sx,h:e.h*sy,font:Math.max(5,Math.min(48,e.font*Math.min(sx,sy)))}));
  const qr=elements.find(e=>e.field==='qr'),originalQr=template.elements.find(e=>e.field==='qr');
  if(qr.show){
    const below=elements.filter((e,index)=>e.show&&e.field!=='qr'&&template.elements[index].y>=originalQr.y+originalQr.h);
    const first=Math.min(...below.map(e=>e.y)),span=below.length?Math.max(...below.map(e=>e.y+e.h))-first:0;
    qr.w=qr.h=Math.min(originalQr.w,originalQr.h,contentWidth-2,contentHeight-qr.y-1-(below.length?span+1:0));
    if(qr.w<12)throw Error('纸张空间不足以容纳至少 12 mm 的二维码与基础信息，请增大纸张，或在“标签模板”恢复新版默认／调整二维码与文字布局。');
    qr.x=Math.min(qr.x,contentWidth-qr.w-1);
    if(below.length){const shift=Math.max(0,qr.y+qr.h+1-first);for(const e of below)e.y+=shift;}
    for(const e of elements)if(e.field!=='qr'&&e.show&&e.x<qr.x&&e.x+e.w>qr.x&&e.y<qr.y+qr.h&&e.y+e.h>qr.y)e.w=Math.max(1,qr.x-e.x-1);
  }
  return validate({...template,width,height,rotation,elements});
}
function paperName(width,height){return papers.find(([, ,w,h])=>Math.abs(width-w)<.001&&Math.abs(height-h)<.001)?.[0]||'custom';}
function paperControls(t){
  return `<label class="mw-field">纸张规格（纸宽 × 走纸长）<select name="paperPreset" id="paper-preset">${[...papers.map(([value,label])=>[value,label]),['custom','自定义尺寸']].map(([value,label])=>`<option value="${value}"${value===paperName(t.width,t.height)?' selected':''}>${label}</option>`).join('')}</select></label><label class="mw-field">内容方向<select name="rotation" id="paper-rotation"><option value="0"${t.rotation!==90?' selected':''}>不旋转（0°）</option><option value="90"${t.rotation===90?' selected':''}>旋转 90°</option></select></label>${[['width','纸宽（横跨纸卷，mm）',15,200,t.width],['height','纸长（走纸方向，mm）',15,200,t.height],['offsetX','水平校准偏移（mm）',-10,10,t.offsetX],['offsetY','垂直校准偏移（mm）',-10,10,t.offsetY]].map(([name,label,min,max,value])=>`<label class="mw-field">${label}<input id="paper-${name}" type="number" name="${name}" min="${min}" max="${max}" step="0.1" value="${value}" required></label>`).join('')}`;
}
function changedPaper(base,values,target){
  let width=Number(values.width.value),height=Number(values.height.value);
  if(target==='paperPreset'&&values.paperPreset.value!=='custom'){
    const preset=papers.find(([name])=>name===values.paperPreset.value);if(!preset)throw Error('请选择有效纸张规格。');
    [width,height]=[preset[2],preset[3]];
  }
  return validate({...resize({...base,offsetX:0,offsetY:0},width,height,Number(values.rotation.value)),offsetX:Number(values.offsetX.value),offsetY:Number(values.offsetY.value)});
}
function overflow(container){
  const clipped=[];
  for(const element of container.querySelectorAll('.element')){
    const cut=element.dataset.field!=='qr'&&(element.scrollWidth>element.clientWidth+1||element.scrollHeight>element.clientHeight+1);
    element.classList.toggle('label-overflow',cut);
    if(cut)clipped.push(fields.find(([field])=>field===element.dataset.field)?.[1]||element.dataset.field);
  }
  return [...new Set(clipped)];
}
function load(){try{const value=localStorage.getItem(key);return value?validate(JSON.parse(value),false):copy(defaults);}catch{return copy(defaults);}}
function download(content,type,name){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function rowsFrom(source,options){
  const rows=typeof source==='function'?await source():source;
  if(options.isActive&&!options.isActive())throw Error('页面已切换，请重新打开标签。');
  if(!Array.isArray(rows)||!rows.length||rows.length>1000)throw Error('请选择 1–1000 件实物。');
  const codes=new Set();for(const row of rows){if(!row||typeof row.code!=='string'||!row.code.trim()||codes.has(row.code))throw Error('单件编码缺失或重复，请刷新后重试。');codes.add(row.code);}
  return rows;
}
function labelHtml(row,template,images={}){
  return '<section class="label"><div class="label-content">'+template.elements.filter(e=>e.show).map(e=>{
    const style=`left:${e.x}mm;top:${e.y}mm;width:${e.w}mm;height:${e.h}mm;font-size:${e.font}pt;`;
    if(e.field==='qr')return `<div class="element image" data-field="qr" style="${style}">${images.qr?`<img alt="二维码" src="${h(images.qr)}">`:'二维码'}</div>`;
    const value=(e.field==='warehouse'?(row.warehouseName||row.warehouse):row[e.field])??'';
    const prefix={unit:'单位：',location:'位置：',batch:'批号：',expiryDate:'效期：'}[e.field]||'';
    return `<div class="element" data-field="${e.field}" style="${style}">${h(value?prefix+value:'')}</div>`;
  }).join('')+'</div></section>';
}
function layoutCss(t,preview=false){const scope=preview?'#material-label-designer [data-label="preview"] ':'';const rotated=t.rotation===90;return `${scope}.label{position:relative;box-sizing:border-box;width:${t.width}mm;height:${t.height}mm;overflow:hidden;background:white;break-after:page;page-break-after:always}${scope}.label:last-child{break-after:auto;page-break-after:auto}${scope}.label-content{position:absolute;left:0;top:0;width:${rotated?t.height:t.width}mm;height:${rotated?t.width:t.height}mm;transform-origin:0 0;transform:translate(${rotated?t.width+t.offsetX:t.offsetX}mm,${t.offsetY}mm)${rotated?' rotate(90deg)':''}}${scope}.element{position:absolute;box-sizing:border-box;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.15}${scope}.image{display:flex;align-items:center;justify-content:center}${scope}.image img{display:block;width:100%;height:100%;object-fit:contain}${preview?'':`@page{size:${t.width}mm ${t.height}mm;margin:0}`}`;}
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
    let t=load();const html=[],rowImages=[],base=copy(t);
    for(const row of rows){
      const images={};if(t.elements.find(e=>e.field==='qr').show){
        const blob=await wait(MaterialScanner.createQr(row.qrPayload||row.code));
        if(!live()){popup.close();return;}const url=URL.createObjectURL(blob);urls.push(url);images.qr=url;
      }
      rowImages.push(images);
      html.push(labelHtml(row,t,images));
      popup.document.querySelector('[role="status"]').textContent=`正在生成标签 ${html.length} / ${rows.length}…`;
      if(html.length%20===0){await wait(new Promise(resolve=>setTimeout(resolve,0)));if(!live()){popup.close();return;}}
    }
    if(!live()){popup.close();return;}
    const doc=popup.document;doc.open();doc.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(options.title||'物资标签')}</title><style id="label-layout">${layoutCss(t)}</style><style>
body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;color:#111;background:#eee}.tools{padding:14px;position:sticky;top:0;background:white;z-index:1;box-shadow:0 1px 5px #aaa}.tools h1{margin:0 0 10px;font-size:20px}.tools p{margin:8px 0;font-size:13px;line-height:1.5}.controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}button,input,select{box-sizing:border-box;min-height:44px;font:inherit}button{padding:8px 14px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}input{width:82px;padding:6px}.paper-controls{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0}.paper-controls label{display:grid;gap:5px;font-size:13px}.paper-controls input,.paper-controls select{width:100%;min-width:0;padding:6px}.preview-scroll{overflow:auto}.pages{display:grid;gap:12px;padding:15px;width:max-content}.label{box-shadow:0 1px 5px #aaa}.label[hidden],.pages[hidden]{display:none}.label-overflow{outline:2px solid #ba3228;outline-offset:-2px}
@media(max-width:600px){.tools{position:static}.paper-controls{grid-template-columns:repeat(2,minmax(0,1fr))}.controls button{flex:1 1 130px}input,select{font-size:16px}}@media print{body{background:white}.tools{display:none}.preview-scroll{overflow:visible}.pages{display:block;padding:0;width:auto}.label{box-shadow:none}.label.print-last{break-after:auto;page-break-after:auto}}
</style></head><body><div class="tools"><h1>二维码标签 · 系统打印</h1><div class="paper-controls">${paperControls(t)}</div><div class="controls"><label>起始张 <input id="from" type="number" min="1" max="${rows.length}" step="1" value="1"></label><label>结束张 <input id="to" type="number" min="1" max="${rows.length}" step="1" value="${rows.length}"></label><button id="test-print" disabled>试打所选首张</button><button id="print" disabled>打开系统打印窗口</button><button id="save-paper" disabled>记住纸张与布局</button></div><p id="paper-summary"></p><p>实体纸宽为横跨纸卷的宽，纸长为走纸方向的长度。切换 0°／90° 仅旋转内容，外纸框与打印页面尺寸保持不变；二维码保持正方形。校准偏移沿实体纸张水平／垂直方向，按毫米保留。文字红框或越界须先在“标签模板”调整，所有尺寸均须先试打并回扫。</p><p>在连接 USB 打印机的电脑操作，打印窗口选择已安装的 DL-886A（NEW）驱动、相同纸宽与走纸长、100% 缩放、每张 1 份，关闭页眉页脚，避免驱动再次旋转内容。手机可预览；USB 打印请用连接打印机的电脑。网页无法自动选定 USB 设备。</p><p id="status" role="status">正在检查二维码图片…</p></div><div class="preview-scroll"><main id="label-pages" class="pages">${html.join('')}</main></div></body></html>`);doc.close();
    // document.open() clears window listeners, so attach lifecycle cleanup to the final document too.
    popup.addEventListener('pagehide',cleanup,{once:true});
    await wait(Promise.all(Array.from(doc.images).map(img=>img.complete?(img.naturalWidth?Promise.resolve():Promise.reject(Error('标签图片加载失败。'))):new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('标签图片加载失败。'));}))));
    if(!live()){popup.close();return;}
    let labels=Array.from(doc.querySelectorAll('.pages .label')),paperReady=true;
    const from=doc.getElementById('from'),to=doc.getElementById('to'),status=doc.getElementById('status'),pages=doc.getElementById('label-pages');
    const values=Object.fromEntries(['paperPreset','rotation','width','height','offsetX','offsetY'].map(name=>[name,doc.getElementById('paper-'+({paperPreset:'preset'}[name]||name))]));
    const buttons=['print','test-print','save-paper'].map(name=>doc.getElementById(name));
    const select=(first,last)=>{labels.forEach((label,index)=>{label.hidden=index<first-1||index>last-1;label.classList.toggle('print-last',index===last-1);});};
    const range=()=>{const first=Number(from.value),last=Number(to.value);if(!Number.isInteger(first)||!Number.isInteger(last)||first<1||last>rows.length||first>last)throw Error(`请填写 1–${rows.length} 内的整数，起始张不能大于结束张。`);return [first,last];};
    const update=()=>{if(!paperReady)return null;try{validate(t);const [first,last]=range();select(first,last);const clipped=overflow(pages);if(clipped.length)throw Error('文字超出元素范围：'+clipped.join('、')+'。请在“标签模板”增大文本框、缩小字号或隐藏字段后再打印。');buttons.forEach(button=>button.disabled=false);status.textContent=`预览第 ${first}–${last} 张，共 ${last-first+1} 张。建议先试打所选首张并扫码核对；打开打印窗口不代表已打印。`;return [first,last];}catch(error){buttons.forEach(button=>button.disabled=true);status.textContent=error.message;return null;}};
    const summary=()=>{doc.getElementById('paper-summary').textContent=`每页一张 ${t.width} × ${t.height} mm 标签（纸宽 × 走纸长），内容 ${t.rotation}°，共 ${rows.length} 张；校准偏移按实体纸张：水平 ${t.offsetX} mm、垂直 ${t.offsetY} mm。`;};
    const updatePaper=name=>{if(!live()){popup.close();cleanup();return false;}try{const next=changedPaper(base,values,name),changed=JSON.stringify(next)!==JSON.stringify(t);t=next;for(const field of ['width','height'])values[field].value=t[field];values.paperPreset.value=paperName(t.width,t.height);values.rotation.value=String(t.rotation);doc.getElementById('label-layout').textContent=layoutCss(t);if(changed){pages.innerHTML=rows.map((row,index)=>labelHtml(row,t,rowImages[index])).join('');labels=Array.from(doc.querySelectorAll('.pages .label'));}pages.hidden=false;paperReady=true;summary();update();return true;}catch(error){paperReady=false;pages.hidden=true;buttons.forEach(button=>button.disabled=true);status.textContent='预览未更新：'+error.message;return false;}};
    for(const [name,input] of Object.entries(values))input.oninput=input.onchange=()=>updatePaper(name);
    from.oninput=to.oninput=update;
    const printRange=firstOnly=>{if(!live()){popup.close();cleanup();return;}if(!updatePaper(doc.activeElement?.name||'width'))return;const chosen=update();if(!chosen)return;const [first,last]=chosen;select(first,firstOnly?first:last);try{popup.print();}finally{select(first,last);}};
    doc.getElementById('print').onclick=()=>printRange(false);
    doc.getElementById('test-print').onclick=()=>printRange(true);
    doc.getElementById('save-paper').onclick=()=>{if(!live()){popup.close();cleanup();return;}if(!updatePaper(doc.activeElement?.name||'width')||!update())return;try{localStorage.setItem(key,JSON.stringify(validate(t)));status.textContent='纸张与布局已保存到本浏览器；打印机驱动仍须使用相同纸宽与走纸长，避免再次旋转内容。';}catch(error){status.textContent='未保存：'+error.message+' 可使用“标签模板”调整或导出JSON保留设置。';}};
    summary();update();
  }catch(error){if(!popup.closed){const p=popup.document.createElement('p');p.setAttribute('role','alert');p.textContent='标签未生成：'+error.message;popup.document.body.replaceChildren(p);}cleanup();throw error;}
  finally{if(popup.closed)cleanup();}
}
function printUnits(source,options={}){return print(source,options);}
function printBatch(batch,options={}){return print({...batch,code:batch.catalogCode||batch.code},options,true);}
function configure(){
  closeDesigner?.();
  const dialog=document.createElement('dialog');dialog.id='material-label-designer';dialog.className='mw-dialog mw-wide';dialog.setAttribute('aria-label','标签模板设计');
  dialog.innerHTML=`<form><div class="mw-dialog-head"><h2>标签模板设计</h2><button type="button" data-label="close" aria-label="关闭">×</button></div><div class="mw-dialog-body"><p>模板保存在本浏览器。纸宽为横跨纸卷的宽，纸长为走纸方向的长度，单位为毫米；字号为 pt。内容方向独立设为 0°／90°。标签仅包含二维码与基础信息，使用浏览器的系统打印窗口。</p><div class="mw-grid">${paperControls(load())}</div><p>选择规格或内容方向后，文字布局按可用空间适配，二维码保持正方形；内容旋转不会交换实体纸张尺寸。X / Y 从未旋转内容画布的左上角起算，90° 时画布宽高为走纸长 × 纸宽。校准偏移始终沿实体纸张水平／垂直方向，含偏移越界时不能保存或打印。</p><div class="ml-preview-pane"><p role="status" data-label="preview-status"></p><div class="ml-preview" data-label="preview"></div><p role="alert" class="mw-error" data-label="error"></p></div><p>预览使用示例数据与二维码。红框表示示例文字被裁切，可增大文本框或缩小字号；实际打印会检查所选实物的文字，溢出时拒绝打印。打印前仍须试打并回扫。</p><div class="mw-table"><table><thead><tr>${['显示','元素','X','Y','宽','高','字号'].map(v=>'<th>'+v+'</th>').join('')}</tr></thead><tbody>${fields.map(([field,label])=>`<tr data-field="${field}"><td><input aria-label="显示${label}" type="checkbox" name="${field}-show"></td><td>${label}</td>${['x','y','w','h','font'].map(n=>`<td><input aria-label="${label} ${n}" style="width:72px" type="number" name="${field}-${n}" min="${n==='font'?5:n==='w'||n==='h'?1:0}" max="${n==='font'?48:200}" step="any" required></td>`).join('')}</tr>`).join('')}</tbody></table></div><p>每瓶／每件的编码已固定，重印不会生成新流水。</p><label class="mw-field">导入模板 JSON<input data-label="import" type="file" accept=".json,application/json"></label></div><div class="mw-dialog-actions"><button type="button" data-label="reset">恢复 60 × 40 示例</button><button type="button" data-label="export">导出模板 JSON</button><button type="submit" class="primary">保存到本浏览器</button></div></form>`;
  const form=dialog.querySelector('form'),error=dialog.querySelector('[data-label="error"]'),preview=dialog.querySelector('[data-label="preview"]');let current=load();
  const previewStatus=dialog.querySelector('[data-label="preview-status"]'),values=Object.fromEntries(['paperPreset','rotation','width','height','offsetX','offsetY'].map(name=>[name,form.elements.namedItem(name)]));
  let base=copy(current),closed=false,previewReady=false;const images={},urls=[];
  const sample={name:'示例物资',spec:'500 mL',unit:'瓶',code:'LAB-20261019-000001',catalogCode:'MAT-001',regionName:'示例区域',warehouseName:'示例仓库',location:'A柜 / 2层',batch:'B001',expiryDate:'2027-10-19'};
  const read=()=>validate({schema:1,...Object.fromEntries(['width','height','rotation','offsetX','offsetY'].map(n=>[n,Number(form.elements.namedItem(n).value)])),elements:fields.map(([field])=>({field,show:form.elements.namedItem(field+'-show').checked,...Object.fromEntries(['x','y','w','h','font'].map(n=>[n,Number(form.elements.namedItem(field+'-'+n).value)]))}))});
  function invalid(message){preview.innerHTML='';previewStatus.textContent='预览未更新，请修正下方错误。';error.textContent=message;}
  function render(updateBase=false){if(closed)return;try{const value=read();preview.innerHTML=`<style>${layoutCss(value,true)}</style>${labelHtml(sample,value,images)}`;const clipped=overflow(preview);error.textContent=clipped.length?'示例文字超出范围：'+clipped.join('、')+'。请调整文本框或字号。':'';previewStatus.textContent=`纸宽 ${value.width} × 走纸长 ${value.height} mm · 内容 ${value.rotation}°${previewReady?' · 输入后立即预览':' · 正在生成二维码预览…'}`;current=value;if(updateBase)base=copy(value);}catch(e){invalid(e.message);}}
  function fillElements(value){for(const e of value.elements){form.elements.namedItem(e.field+'-show').checked=e.show;for(const n of ['x','y','w','h','font'])form.elements.namedItem(e.field+'-'+n).value=e[n];}}
  function fill(value){for(const name of ['width','height','rotation','offsetX','offsetY'])values[name].value=value[name]??0;values.paperPreset.value=paperName(value.width,value.height);fillElements(value);base=copy(value);render();}
  form.oninput=form.onchange=event=>{const name=event.target?.name;if(!Object.hasOwn(values,name)){render(true);return;}try{const value=changedPaper(base,values,name);values.width.value=value.width;values.height.value=value.height;values.paperPreset.value=paperName(value.width,value.height);values.rotation.value=String(value.rotation);fillElements(value);render();}catch(e){invalid(e.message);}};
  form.onsubmit=event=>{event.preventDefault();try{current=read();localStorage.setItem(key,JSON.stringify(current));dialog.close();}catch(e){error.textContent=e.message;}};
  const cleanup=()=>{if(closed)return;closed=true;urls.forEach(url=>URL.revokeObjectURL(url));dialog.remove();if(closeDesigner===close)closeDesigner=undefined;};
  const close=()=>{dialog.close();cleanup();};closeDesigner=close;
  dialog.querySelector('[data-label="close"]').onclick=close;
  dialog.querySelector('[data-label="reset"]').onclick=()=>fill(copy(defaults));
  dialog.querySelector('[data-label="export"]').onclick=()=>{try{download(JSON.stringify(read(),null,2),'application/json','labos-label-template.json');}catch(e){error.textContent=e.message;}};
  dialog.querySelector('[data-label="import"]').onchange=async event=>{const file=event.target.files[0];event.target.value='';if(!file)return;try{if(file.size>65536)throw Error('模板不能超过 64 KiB。');fill(validate(JSON.parse(await file.text())));}catch(e){error.textContent='导入失败：'+e.message;}};
  dialog.addEventListener('close',cleanup,{once:true});document.body.appendChild(dialog);fill(current);dialog.showModal();
  MaterialScanner.createQr(sample.code).then(blob=>{if(closed)return;const url=URL.createObjectURL(blob);urls.push(url);images.qr=url;previewReady=true;render();}).catch(()=>{if(!closed){previewStatus.textContent='二维码预览生成失败，请刷新页面后重试。';}});
}
globalThis.MaterialLabels=Object.freeze({configure,printUnits,printBatch});
if(typeof module!=='undefined'&&module.exports)module.exports={validate,defaults,labelHtml,layoutCss,rowsFrom,resize};
})();
