const M={dashboard:['工作台','▦','实验室数据总览'],archives:['资料档案','▤','纸质资料数字化、分类检索与附件归档'],templates:['电子模板','▧','模板调用、在线填写、导出与打印'],finance:['收支管理','￥','实验室收入、支出与经费台账'],assets:['设备管理','◈','设备全生命周期、检定校准和设备档案'],materials:['物资管理','◇','多人申报、分批验收与区域库存'],quality:['体系文件','✓','质量手册、程序文件、作业指导书、表单和法定标准'],contracts:['委托单位与合同','⌘','委托单位档案、合同、项目与结算管理'],people:['人员管理','♙','人员档案、培训、证书与能力授权'],datahub:['导出与备份','⇩','按模块和日期导出、备份与恢复'],management:['管理','⚙','人员账号、角色权限、侧边栏和系统日志管理'],permissions:['管理','⚙','人员账号、角色权限、侧边栏和系统日志管理'],trash:['回收站','⌫','查看、恢复或彻底删除已移除的记录'],audit:['审计日志','◎','所有新增、修改、删除和上传操作']};
const C={archives:{cat:'资料类别',extra:[['version','版本号'],['keywords','关键词']]},templates:{cat:'模板类别',extra:[['section','模板分区','select',[['equipment_use','设备使用记录'],['sample_receipt','样品接收记录'],['reagent_inout','试剂出入库'],['calibration','检定校准'],['maintenance','维护保养']]],['fields','表单字段（逗号分隔）']]},finance:{cat:'费用科目',extra:[['direction','收支方向','select',['收入','支出','预算']],['account','经费账户']]},assets:{cat:'资产类别',extra:[['model','规格型号'],['location','存放地点']]},materials:{cat:'物资类别',extra:[['unit','计量单位'],['warning','预警库存','number'],['location','存放位置'],['batch','批号']]},quality:{cat:'文件类别',extra:[['quality_section','体系文件板块','select',['质量手册','程序文件','作业指导书','表单','法定标准']],['version','版本号'],['is_current','当前显示版本','select',['是','否']],['approver','批准人']]},contracts:{cat:'档案类别',extra:[['client_name','委托单位名称'],['contract_no','合同编号'],['contract_type','合同类型','select',['委托检测合同','技术服务合同','采购合同','框架合同','其他']],['project_name','关联项目'],['contract_amount','合同金额（元）','number'],['start_date','合同开始日期','date'],['end_date','合同结束日期','date'],['settlement_status','结算状态','select',['未结算','部分结算','已结算']]]},people:{cat:'岗位/人员类别',extra:[['section','人员分区','select',[['profile','人员档案'],['training','培训记录'],['authorization','能力授权'],['certificate','证书资质'],['evaluation','能力评价']]],['skills','授权能力'],['certificate','证书/资质'],['training','培训记录']]}};
let current='dashboard',items=[],editing=null,selected=null,navConfig=[],currentUser=null,loadSequence=0;
const $=s=>document.querySelector(s),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const call=async(u,o={})=>{const r=await fetch(u,{headers:{'Content-Type':'application/json'},...o});const d=await r.json();if(!r.ok)throw Object.assign(Error(d.error||'请求失败'),{status:r.status});return d};
const toast=x=>{const t=$('#toast');t.textContent=x;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800)};
const menuDef=m=>{const n=navConfig.find(x=>x.target===m&&x.visible!==0);return n?[n.label,n.icon,n.description]:M[m]||[m,'□','']};
const can=permission=>Boolean(currentUser?.permissions?.includes('*')||currentUser?.permissions?.includes(permission));
function canOpen(module){if(module==='materials')return Boolean(currentUser);if(module==='management'||module==='permissions')return can('permissions.read');if(module==='datahub')return ['export.read','backup.read','backup.restore'].some(can);return can(module+'.read')}
function applyPermissions(){document.querySelectorAll('[data-permission]').forEach(x=>x.hidden=!can(x.dataset.permission));$('#add').style.display=current!=='materials'&&C[current]&&can(current+'.write')?'':'none';for(const id of ['global-from','global-to']){const node=$('#'+id);if(node)node.style.display=current==='materials'?'none':''}}
function field(n,l,type='text',opts=[],v=''){
  if(type==='select')return `<div class="field"><label for="field_${esc(n)}">${esc(l)}</label><select id="field_${esc(n)}" name="${esc(n)}">${opts.map(x=>{const [value,label]=Array.isArray(x)?x:[x,x];return `<option value="${esc(value)}" ${value===v?'selected':''}>${esc(label)}</option>`}).join('')}</select></div>`;
  return `<div class="field"><label for="field_${esc(n)}">${esc(l)}</label><input id="field_${esc(n)}" name="${esc(n)}" type="${esc(type)}" value="${esc(v)}" ${n==='title'?'required':''}></div>`;
}
function shell(){document.body.insertAdjacentHTML('afterbegin',`<div class="layout"><aside class="side"><div class="brand"><i>L</i><div><strong>LabOS</strong><small>实验室综合管理系统</small></div></div><nav class="nav"></nav><div class="side-foot"><span class="online">●</span>本地服务运行中</div></aside><main><header><div><h1 id="title">工作台</h1><p id="subtitle">${esc(menuDef('dashboard')[2])}</p></div><div class="actions"><input id="search" placeholder="搜索名称、编号、负责人"><button id="add" class="primary">＋ 新建记录</button><button id="logout" class="ghost">退出</button></div></header><section id="page" class="page"></section></main></div>`);const entries=navConfig.filter(x=>x.visible!==0&&canOpen(x.target)).sort((a,b)=>a.sort_order-b.sort_order||a.key.localeCompare(b.key));$('.nav').innerHTML=(entries.length?entries:Object.entries(M).filter(([key])=>canOpen(key)).map(([key,v])=>({key,label:v[0],icon:v[1],description:v[2],target:key,visible:1,sort_order:0}))).map(n=>`<button data-nav="${esc(n.target)}" class="${n.target==='dashboard'?'active':''}" title="${esc(n.description||'')}"><span>${esc(n.icon)}</span><b>${esc(n.label)}</b></button>`).join('');$('.nav').onclick=e=>{const n=e.target.closest('[data-nav]');if(n)go(n.dataset.nav)};$('#add').onclick=()=>openEditor();$('#logout').onclick=async()=>{await call('/api/auth/logout');location.reload()};$('#search').oninput=()=>{clearTimeout(window.st);window.st=setTimeout(()=>load(),250)}}
async function go(module){
  if(!M[module]||!canOpen(module)){toast('没有权限查看该页面');return}
  clearTimeout(window.st);
  if(current!==module)$('#search').value='';
  current=module;
  items=[];
  document.querySelectorAll('[data-nav]').forEach(x=>x.classList.toggle('active',x.dataset.nav===module));
  const d=menuDef(module);$('#title').textContent=d[0];$('#subtitle').textContent=d[2];
  $('#search').style.display=module!=='materials'&&C[module]?'':'none';
  $('#add').onclick=()=>openEditor();
  $('#page').innerHTML='<div class="empty">正在加载…</div>';
  applyPermissions();
  await load();
}
async function load(){
  const module=current,request=++loadSequence;
  try{
    const rows=module!=='materials'&&C[module]?await call(`/api/records?module=${module}&q=${encodeURIComponent($('#search').value)}`):[];
    if(request!==loadSequence||current!==module)return;
    items=rows;
    const render={dashboard,archives:renderArchives,assets:renderAssets,materials:renderMaterials,quality:renderQuality,contracts:renderContracts,audit:renderAudit,management:renderManagement,permissions:renderManagement,trash:renderTrash,datahub:renderDataHub}[module]||renderRecords;
    await render();
    if(request===loadSequence&&current===module)applyPermissions();
  }catch(error){if(request===loadSequence&&current===module){$('#page').innerHTML=`<div class="empty">${esc(error.message)}</div>`;toast(error.message)}}
}
function renderRecords(){$('#page').innerHTML=`<div class="toolbar"><span>共 ${items.length} 条记录</span><button class="ghost" id="csv" data-permission="export.read">导出 CSV</button></div><div class="table"><table><thead><tr><th>名称 / 编号</th><th>类别</th><th>状态</th><th>负责人</th>${current==='finance'?'<th>金额</th>':''}${['assets','materials'].includes(current)?'<th>数量/原值</th>':''}<th>日期</th><th>操作</th></tr></thead><tbody>${items.map(r=>`<tr><td><strong>${esc(r.title)}</strong><small>${esc(r.code||'未设置编号')}</small></td><td>${esc(r.category||'-')}</td><td><span class="pill">${esc(r.status)}</span></td><td>${esc(r.owner||'-')}</td>${current==='finance'?`<td>¥${Number(r.amount).toLocaleString()}</td>`:''}${['assets','materials'].includes(current)?`<td>${current==='assets'?'¥'+Number(r.amount).toLocaleString():r.quantity}</td>`:''}<td>${esc(r.due_date||r.updated_at.slice(0,10))}</td><td class="ops"><button onclick="show(${r.id})">查看</button><button data-permission="${current}.write" onclick="openEditor(${r.id})">编辑</button><button class="danger" data-permission="${current}.delete" onclick="del(${r.id})">删除</button></td></tr>`).join('')}</tbody></table>${items.length?'':'<div class="empty">暂无数据，点击右上角新建记录。</div>'}</div>`;$('#csv').onclick=csv}
window.openEditor=id=>{
  if(current==='materials')return toast('旧物资台账仅供查询，请在物资申报中录入');
  if(!C[current]||!can(current+'.write'))return toast('没有新增或编辑权限');
  editing=id?items.find(x=>x.id===id):null;
  if(id&&!editing)return toast('记录已不在当前列表，请重新加载');
  const r=editing||{data:current==='archives'?{access_roles:currentUser.role}:{}};
  const c=C[current];
  $('#record-error').hidden=true;
  $('#reload-record').hidden=true;
  $('#edit-title').textContent=editing?'编辑记录':`新建${M[current][0]}`;
  $('#fields').innerHTML=field('title','名称 *','text',[],r.title)+field('code','编号','text',[],r.code)+field('category',c.cat,'text',[],r.category)+field('status','状态',current==='materials'?'select':'text',current==='materials'?[...new Set(['待验收','合格','正常','限制使用','隔离','不合格','过期','报废',r.status||'待验收'])]:[],r.status||(current==='materials'?'待验收':'草稿'))+field('owner','负责人','text',[],r.owner)+field('due_date','日期/有效期','date',[],r.due_date)+(current==='finance'?field('amount','金额（元）','number',[],r.amount):'')+(current==='assets'||current==='materials'?field('quantity',current==='assets'?'数量':'当前库存','number',[],r.quantity):'')+c.extra.map(([n,l,t='text',o=[]])=>field('data_'+n,l,t,o,Array.isArray(r.data[n])?r.data[n].join(','):r.data[n])).join('');
  editor.showModal();
};
$('#record-form').onsubmit=async e=>{
  e.preventDefault();
  const fd=new FormData(e.target),c=C[current],data={...editing?.data};
  for(const [n] of c.extra){const v=fd.get('data_'+n)||'';data[n]=n==='fields'?v.split(',').map(x=>x.trim()).filter(Boolean):v}
  const b={module:current,title:fd.get('title'),code:fd.get('code'),category:fd.get('category'),status:fd.get('status'),owner:fd.get('owner'),due_date:fd.get('due_date'),amount:fd.get('amount')??editing?.amount??0,quantity:fd.get('quantity')??editing?.quantity??0,data};
  if(editing)b.version=editing.version;
  const save=e.target.querySelector('[type=submit]');
  save.disabled=true;
  try{
    await call(editing?`/api/records/${editing.id}`:'/api/records',{method:editing?'PUT':'POST',body:JSON.stringify(b)});
    editor.close();toast('保存成功');await load();
  }catch(error){
    $('#record-error').textContent=error.status===409?'记录已被其他用户修改，当前输入已保留。请先复制需要保留的内容，再放弃输入并重新加载记录。':error.message;
    $('#record-error').hidden=false;
    $('#reload-record').hidden=error.status!==409;
    toast(error.message);
  }finally{save.disabled=false}
};
$('#reload-record').onclick=async()=>{
  const id=editing?.id;
  editor.close();await load();
  if(items.some(r=>r.id===id))openEditor(id);else toast('记录已不可见或已删除');
};
window.del=async id=>{if(!can(current+'.delete'))return toast('没有删除权限');if(!confirm('确定删除吗？'))return;try{await call('/api/records/'+id,{method:'DELETE'});toast('已删除');await load()}catch(error){toast(error.message)}};
window.show=async id=>{selected=items.find(x=>x.id===id);if(!selected)return toast('记录已不在当前列表，请重新加载');const r=selected,c=C[current];$('.upload').hidden=!can(current+'.write');$('#detail-title').textContent=r.title;$('#detail-code').textContent=r.code||'未设置编号';const a=[['模块',M[current][0]],['类别',r.category],['状态',r.status],['负责人',r.owner],['日期',r.due_date||'-']];if(current==='finance')a.push(['金额','¥'+Number(r.amount).toLocaleString()]);if(['assets','materials'].includes(current))a.push(['数量',r.quantity]);for(const [n,l] of c.extra)a.push([l,Array.isArray(r.data[n])?r.data[n].join('、'):r.data[n]]);$('#detail-body').innerHTML='<div class="detail-grid">'+a.map(x=>`<div class="detail-item"><small>${x[0]}</small>${esc(x[1]||'-')}</div>`).join('')+'</div>'+(current==='templates'&&r.data.fields?.length?'<h3>在线填写模板</h3><div class="grid">'+r.data.fields.map(x=>field('tpl_'+x,x)).join('')+'</div>':'');await files();detail.showModal()};async function files(){const a=await call('/api/files?record_id='+selected.id);$('#files').innerHTML=a.length?a.map(x=>`<div class="file-row"><span>${esc(x.original_name)} · ${(x.size/1024).toFixed(1)}KB</span><a href="/api/files/${x.id}/download">下载</a></div>`).join(''):'<p style="color:#718096;font-size:13px">暂无附件</p>'}$('#file').onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=async()=>{await call('/api/files',{method:'POST',body:JSON.stringify({record_id:selected.id,name:f.name,type:f.type,content:r.result})});toast('上传成功');files()};r.readAsDataURL(f)};function csv(){const rows=[['名称','编号','类别','状态','负责人','日期'],...items.map(x=>[x.title,x.code,x.category,x.status,x.owner,x.due_date])];const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+rows.map(x=>x.map(y=>'"'+String(y||'').replaceAll('"','""')+'"').join(',')).join('\n')],{type:'text/csv'}));a.download=M[current][0]+'.csv';a.click()}
async function dashboard(){const d=await call('/api/dashboard');let widgets=[];try{widgets=await call('/api/ui-config/dashboard')}catch{}if(current!=='dashboard')return;const total=Object.values(d.totals).reduce((a,b)=>a+b,0),metricValue={total,income:`¥${Number(d.finance.income).toLocaleString()}`,expense:`¥${Number(d.finance.expense).toLocaleString()}`,warnings:d.warnings};const visible=widgets.filter(x=>x.visible!==0).sort((a,b)=>a.sort_order-b.sort_order||a.key.localeCompare(b.key));const metrics=visible.filter(x=>x.kind==='metric'),modules=visible.filter(x=>x.kind==='module'&&canOpen(x.target));$('#page').innerHTML=`<div class="hero"><div><h2>实验室信息，一处管理</h2><p>资料、模板、经费、设备、物资、样品、体系与人员统一归档。</p></div><b>${new Date().toLocaleDateString('zh-CN')}</b></div><div class="cards">${metrics.map(x=>`<div class="card"><small>${esc(x.label)}</small><strong>${metricValue[x.target]??'-'}</strong><em>${esc(x.description)}</em></div>`).join('')}</div><div class="modules">${modules.map(x=>`<div class="module" data-go="${esc(x.target)}"><i>${esc(menuDef(x.target)[1])}</i><h3>${esc(x.label)}</h3><p>${esc(x.description)}</p><b>${d.totals[x.target]||0} 条记录 →</b></div>`).join('')}</div>`;document.querySelectorAll('[data-go]').forEach(x=>x.onclick=()=>go(x.dataset.go))}
async function enter(user){
  currentUser=user;
  try{navConfig=await call('/api/ui-config/nav')}catch{navConfig=[]}
  shell();
  const first=Object.keys(M).find(canOpen);
  if(first)await go(first);else{$('#page').innerHTML='<div class="empty">当前账号暂无可访问模块，请联系管理员。</div>';applyPermissions()}
}
let setupRequired=false,authPending=false;
function authError(message){$('#auth-error').textContent=message;$('#auth-error').hidden=false}
function showAuth(me={}){
  setupRequired=me.setupRequired===true;
  $('#auth-title').textContent=setupRequired?'首次设置管理员':'登录 LabOS';
  $('#auth-description').textContent=setupRequired?'创建首个管理员账号，设置完成后进入系统。':'实验室综合管理系统';
  $('#auth-username-label').textContent=setupRequired?'管理员账号':'用户名';
  $('#auth-password-label').textContent=setupRequired?'设置密码':'密码';
  if(setupRequired)$('#auth-username').value=me.setupUsername||'admin';
  $('#auth-password').autocomplete=setupRequired?'new-password':'current-password';
  $('#auth-password').minLength=setupRequired?8:0;
  $('#auth-confirm-field').hidden=!setupRequired;
  $('#auth-password-confirm').disabled=!setupRequired;
  $('#auth-password-confirm').required=setupRequired;
  $('#auth-submit').textContent=setupRequired?'创建管理员并进入系统':'登录系统';
  $('#auth-note').textContent=setupRequired?'密码为 8–1024 个字符，请妥善保存管理员账号和密码。':'请输入已有账号和密码。';
  $('#auth-error').hidden=true;
  if(!login.open)login.showModal();
}
login.oncancel=e=>e.preventDefault();
async function start(){
  try{const me=await call('/api/auth/me');if(me.setupRequired||!me.user){showAuth(me);return}await enter(me.user)}
  catch(error){showAuth();authError(error.message)}
}
$('#login-form').onsubmit=async e=>{
  e.preventDefault();
  if(authPending)return;
  const b=Object.fromEntries(new FormData(e.target)),initializing=setupRequired;
  if(!b.username.trim())return authError('请输入账号');
  if(initializing&&(b.password.length<8||b.password.length>1024))return authError('密码须为 8–1024 个字符');
  if(initializing&&b.password!==b.passwordConfirm)return authError('两次输入的密码不一致');
  authPending=true;$('#auth-submit').disabled=true;$('#auth-error').hidden=true;
  try{
    const result=await call(initializing?'/api/auth/setup':'/api/auth/login',{method:'POST',body:JSON.stringify(b)});
    if(!result.user)throw Error('未能确认登录状态，请重试');
    $('#auth-password').value='';$('#auth-password-confirm').value='';
    login.close();await enter(result.user);
  }catch(error){
    if(initializing&&error.status===409){
      try{showAuth(await call('/api/auth/me'))}catch{showAuth()}
      authError('管理员已在其他页面完成设置，请使用已有账号登录。');
    }else authError(error.message);
  }finally{authPending=false;$('#auth-submit').disabled=false}
};
