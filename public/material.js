/* CNAS导向的物资管理工作台：业务记录统一落入records，关键字段进入data以保留变更审计。 */
const MATERIAL_SUB={
  reagentLedger:['试剂台账','试剂主档、批号、有效期和储存条件',r=>typeOf(r)==='试剂'&&flowOf(r)==='库存台账'],
  consumableLedger:['耗材台账','耗材主档、规格和最低库存',r=>typeOf(r)==='耗材'&&flowOf(r)==='库存台账'],
  standardLedger:['标准品台账','标准值、证书、溯源和开封后有效期',r=>typeOf(r)==='标准品'&&flowOf(r)==='库存台账'],
  reagentStock:['试剂库存','试剂库库存余额和批次明细',r=>typeOf(r)==='试剂'],
  consumableStock:['耗材库存','耗材库库存余额和库位明细',r=>typeOf(r)==='耗材'],
  standardStock:['标准品库存','标准品库库存余额和批次明细',r=>typeOf(r)==='标准品'],
  suppliers:['合格供应商','供应商评价、复评和供货记录',r=>flowOf(r)==='供应商管理'],
  purchase:['采购申请','采购规格、预算和申请审批',r=>flowOf(r)==='采购申请'],
  acceptance:['到货验收','数量、包装、证书和验收结论',r=>flowOf(r)==='到货验收'],
  inbound:['入库管理','合格物资批次入库和状态确认',r=>flowOf(r)==='入库管理'],
  outbound:['出库领用','领用人、项目/样品和使用去向',r=>flowOf(r)==='出库管理'],
  transactions:['库存流水','入库、出库、退库和盘点调整明细',r=>['入库管理','出库管理','退库','库存盘点'].includes(flowOf(r))],
  stocktake:['库存盘点','账实核对、差异说明和审批',r=>flowOf(r)==='库存盘点'],
  alerts:['库存预警','低库存、临期和过期物资',r=>Number(r.quantity||0)<=Number(r.data?.warning||0)||isNearExpiry(r)],
  abnormal:['不合格/异常物资','隔离、评估、退货、报废和放行',r=>['隔离','不合格','过期','报废'].includes(r.status)],
  environment:['仓储环境记录','试剂库、标准品库温湿度与异常处置',r=>flowOf(r)==='仓储环境']
};
let materialSub='reagentLedger';
const typeOf=r=>r.data?.material_type||(['标准品'].some(x=>String(r.category||'').includes(x))?'标准品':String(r.category||'').includes('耗材')?'耗材':'试剂');
const flowOf=r=>r.data?.flow||'库存台账';
const isNearExpiry=r=>Boolean(r.due_date&&r.due_date<=new Date(Date.now()+30*86400000).toISOString().slice(0,10));
if(C.materials&&!C.materials.extra.some(x=>x[0]==='material_type'))C.materials.extra.push(
  ['material_type','物资类型','select',['试剂','耗材','标准品']],
  ['flow','业务环节','select',['库存台账','采购申请','到货验收','入库管理','出库管理','退库','库存盘点','供应商管理','仓储环境']],
  ['batch','批号'],['unit','计量单位'],['warning','最低库存','number'],['location','库位'],['storage_condition','储存条件'],
  ['supplier','供应商'],['acceptance','验收结论','select',['待验收','合格','限制使用','隔离','不合格']],
  ['certificate_no','证书编号'],['standard_value','标准值/浓度'],['uncertainty','不确定度'],['traceability','溯源信息'],['opened_date','开封日期'],['opened_expiry','开封后有效期'],
  ['sample_project','关联项目/样品'],['purpose','使用用途'],['operator','领用/操作人'],['reviewer','复核/审核人'],['adjust_reason','差异/调整原因'],['environment','温湿度记录']
);
const originalGo=window.go;window.go=async function(module){await originalGo(module);if(module==='materials')await renderMaterials()};
function materialRows(sub){const all=window.__materialRows||[];const rule=MATERIAL_SUB[sub]?.[2];return rule?all.filter(rule):all}
function summary(rows){return rows.reduce((a,r)=>{a.qty+=Number(r.quantity||0);if(Number(r.quantity||0)<=Number(r.data?.warning||0))a.low++;if(isNearExpiry(r))a.expire++;if(['隔离','不合格','过期','报废'].includes(r.status))a.abnormal++;return a},{qty:0,low:0,expire:0,abnormal:0})}
async function renderMaterials(){window.__materialRows=await call('/api/records?module=materials');const all=window.__materialRows,rows=materialRows(materialSub),s=summary(all),count=t=>all.filter(r=>typeOf(r)===t).length;$('#page').innerHTML=`<div class="material-head"><div><h2>物资管理中心</h2><p>按 CNAS 思路管理物资状态、批次、证书、验收、领用和全流程追溯。</p></div><button class="primary" id="material-add">＋ 新建物资记录</button></div><div class="material-cards"><div><small>试剂品种</small><strong>${count('试剂')}</strong><span>试剂库</span></div><div><small>耗材品种</small><strong>${count('耗材')}</strong><span>耗材库</span></div><div><small>标准品品种</small><strong>${count('标准品')}</strong><span>标准品库</span></div><div><small>风险事项</small><strong class="warn">${s.low+s.expire+s.abnormal}</strong><span>预警/异常/到期</span></div></div><div class="cnas-notice"><b>受控记录提示</b><span>入库前请先完成验收；隔离、不合格、过期物资不得直接出库；库存调整必须填写原因并保留审计记录。</span></div><div class="material-layout"><aside class="material-menu">${Object.entries(MATERIAL_SUB).map(([k,v])=>`<button class="${k===materialSub?'active':''}" data-msub="${k}"><b>${v[0]}</b><small>${v[1]}</small></button>`).join('')}</aside><section class="material-content"><div class="material-toolbar"><div><h3>${MATERIAL_SUB[materialSub][0]}</h3><p>${MATERIAL_SUB[materialSub][1]} · 共 ${rows.length} 条</p></div><button class="ghost" id="material-export">导出当前清单</button></div><div class="table"><table><thead><tr><th>名称 / 编号</th><th>类型</th><th>业务环节</th><th>批号/证书</th><th>数量</th><th>状态</th><th>负责人</th><th>日期</th><th>操作</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.title)}</strong><small>${esc(r.code||'未设置编号')}</small></td><td>${typeOf(r)}</td><td>${flowOf(r)}</td><td>${esc(r.data?.batch||r.data?.certificate_no||'-')}</td><td><strong class="${Number(r.quantity)<=Number(r.data?.warning||0)?'text-warn':''}">${r.quantity} ${esc(r.data?.unit||'')}</strong></td><td><span class="pill ${['隔离','不合格','过期','报废'].includes(r.status)?'pill-danger':''}">${esc(r.status)}</span></td><td>${esc(r.owner||r.data?.operator||'-')}</td><td>${esc(r.due_date||r.updated_at.slice(0,10))}</td><td class="ops"><button onclick="show(${r.id})">查看</button><button onclick="openEditor(${r.id})">编辑</button></td></tr>`).join('')}</tbody></table>${rows.length?'':'<div class="empty">该子目录暂无记录。</div>'}</div></section></div>`;document.querySelectorAll('[data-msub]').forEach(x=>x.onclick=()=>{materialSub=x.dataset.msub;renderMaterials()});$('#material-add').onclick=()=>openEditor();$('#material-export').onclick=()=>exportMaterials(rows)}
function exportMaterials(rows){const lines=[['名称','编号','物资类型','业务环节','类别','批号','证书编号','数量','单位','库位','状态','负责人','日期'],...rows.map(r=>[r.title,r.code,typeOf(r),flowOf(r),r.category,r.data?.batch,r.data?.certificate_no,r.quantity,r.data?.unit,r.data?.location,r.status,r.owner,r.due_date])];const csv='\ufeff'+lines.map(a=>a.map(v=>'"'+String(v||'').replaceAll('"','""')+'"').join(',')).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='物资-'+MATERIAL_SUB[materialSub][0]+'.csv';a.click()}
const originalOpenEditor=window.openEditor;window.openEditor=function(id){originalOpenEditor(id);setTimeout(function(){const title=document.querySelector('#edit-title');if(title&&title.textContent.includes('物资')){const status=document.querySelector('[name=status]');if(status){const value=status.value;status.outerHTML='<select name="status"><option>待验收</option><option>合格</option><option>正常</option><option>限制使用</option><option>隔离</option><option>不合格</option><option>过期</option><option>报废</option></select>';document.querySelector('[name=status]').value=value||'待验收'}const type=document.querySelector('[name=data_material_type]');if(type&&!type.value)type.value='试剂'}},0)};const permissionScript=document.createElement('script');permissionScript.src='/permission.js';permissionScript.onload=function(){const archiveScript=document.createElement('script');archiveScript.src='/archive.js';document.head.appendChild(archiveScript)};document.head.appendChild(permissionScript);
