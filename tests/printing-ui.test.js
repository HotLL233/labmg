const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { unitIds } = require('../src/public/material-printing');
const source = fs.readFileSync(path.join(__dirname, '../src/public/material-printing.js'), 'utf8');
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const ids = { template: 'a58ee937-f1ba-46e3-830b-1bdb08c443f5', station: 'f30befaf-1d17-44cd-9791-00210fbf86b7', job: '0166a0c6-2393-430a-bbcb-97604fb4b1c3' };
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp:'&', lt:'<', gt:'>', quot:'"', '#39':"'" })[key]);

// Only APIs used by the printer dialog are modeled. Layout and physical printing need separate checks.
class Element {
  constructor(tag, attrs = {}) { this.tagName=tag;this.attrs=attrs;this.children=[];this.dataset={};this.listeners={};this.disabled='disabled' in attrs;this.checked='checked' in attrs;this.open=false;for(const [key,value] of Object.entries(attrs))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value; }
  get id(){return this.attrs.id;} set id(value){this.attrs.id=value;}
  get name(){return this.attrs.name;}
  get value(){if(this._value!==undefined)return this._value;if(this.tagName==='select'){const row=this.children.find(node=>'selected' in node.attrs)||this.children[0];return row?.attrs.value||'';}if(this.tagName==='textarea')return this.textContent;return this.attrs.value||'';}
  set value(value){this._value=value;}
  get textContent(){return (this._text||'')+this.children.map(node=>node.textContent).join('');} set textContent(value){this._text=String(value);this.children=[];}
  get innerHTML(){return this._html||'';} set innerHTML(html){this._html=html;this._text='';this.children=[];parse(html,this);}
  get elements(){return Object.fromEntries(this.querySelectorAll('[name]').map(node=>[node.name,node]));}
  appendChild(node){node.parent=this;this.children.push(node);return node;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
  addEventListener(name,callback){this.listeners[name]=callback;}
  setAttribute(name,value){this.attrs[name]=value;}
  showModal(){this.open=true;} close(){this.open=false;this.listeners.close?.({});}
  focus(){this.focused=true;} select(){this.selected=true;} reportValidity(){return true;}
  closest(selector){for(let node=this;node;node=node.parent)if(matches(node,selector))return node;return null;}
  querySelectorAll(selector){if(selector.includes(','))return [...new Set(selector.split(',').flatMap(part=>this.querySelectorAll(part.trim())))];const parts=selector.split(/\s+/),result=[];const visit=node=>{for(const child of node.children){if(matches(child,parts.at(-1))){let ancestor=child.parent,ok=true;for(let i=parts.length-2;i>=0;i--){while(ancestor&&!matches(ancestor,parts[i]))ancestor=ancestor.parent;if(!ancestor){ok=false;break;}ancestor=ancestor.parent;}if(ok)result.push(child);}visit(child);}};visit(this);return result;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
function matches(node,selector){if(selector.endsWith(':checked'))return node.checked&&matches(node,selector.slice(0,-8));const tagAttr=selector.match(/^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/);if(tagAttr)return (!tagAttr[1]||node.tagName===tagAttr[1])&&(tagAttr[3]===undefined?tagAttr[2] in node.attrs:node.attrs[tagAttr[2]]===tagAttr[3]);if(selector.startsWith('#'))return node.id===selector.slice(1);return node.tagName===selector;}
function parse(html,parent){const stack=[parent],pattern=/<\/?([a-z][\w-]*)([^>]*?)>/gi;let match,last=0;while((match=pattern.exec(html))){stack.at(-1)._text=(stack.at(-1)._text||'')+decode(html.slice(last,match.index));last=pattern.lastIndex;const tag=match[1].toLowerCase();if(match[0].startsWith('</')){if(stack.at(-1).tagName===tag)stack.pop();continue;}const attrs={};for(const item of match[2].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attrs[item[1]]=decode(item[2]??item[3]??item[4]??'');const node=stack.at(-1).appendChild(new Element(tag,attrs));if(!['input','br','img','hr'].includes(tag))stack.push(node);}stack.at(-1)._text=(stack.at(-1)._text||'')+decode(html.slice(last));}
function fixture({ manage=false, empty=false, status='queued' }={}){
  const document=new Element('document');document.body=document.appendChild(new Element('body'));document.createElement=tag=>new Element(tag);
  const config={templates:empty?[]:[{id:ids.template,name:'单件母版',fileName:'unit.btw',sha256:'a'.repeat(64),active:true,fields:['Code','Name']}],stations:empty?[]:[{id:ids.station,name:'标签工作站',printerName:'Deli DL-886A(NEW)',enabled:true}],capabilities:{manageTemplates:manage,manageStations:manage,submit:true}};
  const job={id:ids.job,status,templateId:ids.template,templateName:'单件母版',stationId:ids.station,stationName:'标签工作站',printerName:'Deli DL-886A(NEW)',count:2,unitIds:[11,12],createdBy:1,rows:[{Code:'000011',Name:'乙醇',Specification:'500mL',Warehouse:'主仓库',Location:'A-01'},{Code:'000012',Name:'乙醇',Specification:'500mL',Warehouse:'主仓库',Location:'A-01'}]};
  const requests=[],intervals=new Set(),downloads=[],clipboard=[];let intercept;
  const response=(data,status=200)=>({ok:status<400,status,json:async()=>structuredClone(data),blob:async()=>new Blob(['script'])});
  const context={document,crypto:crypto.webcrypto,AbortController,Blob,Uint8Array,URLSearchParams,URL:{createObjectURL:()=> 'blob:download',revokeObjectURL(){}},btoa:text=>Buffer.from(text,'binary').toString('base64'),atob:text=>Buffer.from(text,'base64').toString('binary'),navigator:{clipboard:{writeText:async text=>clipboard.push(text)}},setTimeout:callback=>{callback();return 1;},setInterval:callback=>{intervals.add(callback);return callback;},clearInterval:callback=>intervals.delete(callback),fetch:async(url,options={})=>{const request={url,options,body:options.body?JSON.parse(options.body):null};requests.push(request);const override=await intercept?.(request);if(override)return response(override.body,override.status);if(url==='/api/printing/config')return response(config);if(url.startsWith('/api/printing/jobs?'))return response({items:[job],total:1,page:1,pageSize:20});if(url==='/api/printing/jobs'&&options.method==='POST')return response({...job,unitIds:request.body.unitIds,count:request.body.unitIds.length},201);if(url==='/api/printing/jobs/'+ids.job)return response(job);if(url==='/api/printing/stations'&&options.method==='POST')return response({station:config.stations[0],token:'secret-once'},201);if(url==='/api/printing/templates'&&options.method==='POST')return response(config.templates[0],201);return response({ok:true});}};
  const create=document.createElement;document.createElement=tag=>{const node=create(tag);node.click=()=>downloads.push({name:node.download,url:node.href});return node;};
  vm.createContext(context);vm.runInContext(source,context);
  const dialog=()=>document.querySelector('#material-printing');
  const click=async(action,value)=>{const node=dialog().querySelectorAll('[data-bp]').find(node=>node.dataset.bp===action&&(value===undefined||node.dataset.value===value));assert.ok(node,'missing action '+action);assert.equal(node.disabled,false,'disabled action '+action);dialog().listeners.click({target:node});await tick();};
  const submit=async action=>{const form=dialog().querySelector(`[data-bp-form="${action}"]`);assert.ok(form,'missing form '+action);dialog().listeners.submit({target:form,preventDefault(){}});await tick();};
  const choose=()=>{const form=dialog().querySelector('#bp-compose');form.elements.templateId.value=ids.template;form.elements.stationId.value=ids.station;return form;};
  const setRange=(from,to)=>{const form=dialog().querySelector('#bp-compose');form.elements.from.value=from;form.elements.to.value=to;dialog().listeners.input({target:form.elements.from});};
  return {api:context.MaterialPrinting,document,dialog,config,job,requests,downloads,clipboard,intervals,click,submit,choose,setRange,setIntercept:value=>{intercept=value;}};
}

test('BarTender unit IDs reject duplicate, missing and excessive rows without touching fixed codes',()=>{
  assert.deepEqual(unitIds([{id:1,code:'000001'},{id:'2',code:'000002'}]),[1,2]);
  for(const rows of [null,[],[{id:0}],[{id:1},{id:1}],Array.from({length:1001},(_,i)=>({id:i+1}))])assert.throws(()=>unitIds(rows));
});

test('BarTender sends only existing unit IDs with UUID config, prevents double submission and replays one failed request',async()=>{
  const app=fixture(),hold=deferred();let first=true;
  app.setIntercept(async request=>{if(request.url==='/api/printing/jobs'&&request.options.method==='POST'&&first){first=false;await hold.promise;return {body:{error:'响应丢失'},status:503};}});
  await app.api.send([{id:11,code:'000011'},{id:12,code:'000012'}]);app.choose();
  await app.submit('submit-job');await app.submit('submit-job');
  assert.equal(app.requests.filter(row=>row.options.method==='POST').length,1);
  hold.resolve();await tick();assert.match(app.dialog().textContent,/响应丢失/);
  await app.click('retry-job');const sent=app.requests.filter(row=>row.options.method==='POST');assert.equal(sent.length,2);assert.deepEqual(sent[0].body,sent[1].body);
  assert.equal(sent[0].body.stationId,ids.station);assert.equal(sent[0].body.templateId,ids.template);assert.deepEqual(sent[0].body.unitIds,[11,12]);assert.deepEqual(Object.keys(sent[0].body).sort(),['idempotencyKey','stationId','templateId','unitIds']);
  assert.match(app.dialog().textContent,/000011/);assert.ok(app.requests.some(row=>row.url==='/api/printing/jobs/'+ids.job));app.api.close();
});

test('first-label trial creates a real one-unit job with one fixed copy',async()=>{
  const app=fixture();await app.api.send([{id:11,code:'000011'},{id:12,code:'000012'}]);app.choose();await app.click('trial-job');
  const request=app.requests.find(row=>row.options.method==='POST');assert.deepEqual(request.body.unitIds,[11]);assert.equal(request.body.copies,undefined);assert.equal(request.body.Code,undefined);app.api.close();
});

test('print ranges default to the full group, preview selected codes and trial only the selected first unit',async()=>{
  for(const trial of [false,true]){const app=fixture();await app.api.send([11,12,13].map(id=>({id,code:'0000'+id})));const form=app.choose();assert.equal(form.elements.from.value,'1');assert.equal(form.elements.to.value,'3');app.setRange('2','3');assert.equal(app.dialog().querySelector('#bp-selection-count').textContent,'选定 2 件实物 · 每件 1 份');assert.equal(app.dialog().querySelector('#bp-selection-codes').textContent,'000012、000013');if(trial)await app.click('trial-job');else await app.submit('submit-job');assert.deepEqual(app.requests.find(row=>row.options.method==='POST').body.unitIds,trial?[12]:[12,13]);app.api.close();}
});

test('empty, zero, decimal, reversed and out-of-group ranges disable printing and never submit a task',async()=>{
  const app=fixture();await app.api.send([{id:11},{id:12},{id:13}]);app.choose();
  for(const [from,to] of [['0','2'],['','2'],['1.5','2'],['1','4'],['3','2'],['1e1','2']]){app.setRange(from,to);assert.equal(app.dialog().querySelector('#bp-submit').disabled,true);assert.equal(app.dialog().querySelector('[data-bp="trial-job"]').disabled,true);assert.match(app.dialog().querySelector('#bp-range-error').textContent,/1–3 内的整数/);await app.submit('submit-job');assert.equal(app.requests.filter(row=>row.options.method==='POST').length,0);}
  app.setRange('2','3');assert.equal(app.dialog().querySelector('#bp-submit').disabled,false);assert.equal(app.dialog().querySelector('#bp-range-error').textContent,'');app.api.close();
});

test('a failed ranged request locks its original range and retries the unchanged IDs and key',async()=>{
  const app=fixture();let first=true;app.setIntercept(request=>{if(request.url==='/api/printing/jobs'&&request.options.method==='POST'&&first){first=false;return {body:{error:'断线结果待确认'},status:503};}});
  await app.api.send([{id:11},{id:12},{id:13}]);app.choose();app.setRange('2','3');await app.submit('submit-job');const form=app.dialog().querySelector('#bp-compose');assert.equal(form.elements.from.value,'2');assert.equal(form.elements.to.value,'3');assert.equal(form.elements.from.disabled,true);assert.equal(form.elements.to.disabled,true);form.elements.from.value='1';await app.click('retry-job');const posts=app.requests.filter(row=>row.options.method==='POST');assert.deepEqual(posts[0].body,posts[1].body);assert.deepEqual(posts[1].body.unitIds,[12,13]);app.api.close();
});

test('closing or changing pages aborts dialog work and prevents a late selection from reopening',async()=>{
  for(const navigation of [false,true]){const app=fixture(),hold=deferred();let active=true;const pending=app.api.send(()=>hold.promise,{isActive:()=>active});await tick();if(navigation){active=false;for(const check of [...app.intervals])check();}else app.api.close();hold.resolve([{id:11,code:'late'}]);await pending;assert.equal(app.dialog().open,false);assert.equal(app.dialog().innerHTML,'');assert.equal(app.intervals.size,0);assert.equal(app.requests[0].options.signal.aborted,true);}
});

test('close remains usable during an in-flight create and late completion cannot restore the dialog',async()=>{
  const app=fixture(),hold=deferred();app.setIntercept(async request=>{if(request.url==='/api/printing/jobs'&&request.options.method==='POST'){await hold.promise;return {body:app.job,status:201};}});
  await app.api.send([{id:11}]);app.choose();await app.submit('submit-job');await app.click('close');assert.equal(app.dialog().open,false);assert.equal(app.dialog().innerHTML,'');const request=app.requests.find(row=>row.options.method==='POST');assert.equal(request.options.signal.aborted,true);hold.resolve();await tick();assert.equal(app.dialog().innerHTML,'');
});

test('ordinary users have no template or station management actions, and empty config gives setup guidance',async()=>{
  const app=fixture();await app.api.open();await app.click('templates');assert.equal(app.dialog().querySelector('[data-bp-form="upload-template"]'),null);assert.equal(app.dialog().querySelector('[data-bp="download-template"]'),null);await app.click('stations');assert.equal(app.dialog().querySelector('[data-bp-form="create-station"]'),null);assert.match(app.dialog().textContent,/联系.*管理权限/);app.api.close();
  const empty=fixture({empty:true});await empty.api.send([{id:11}]);assert.match(empty.dialog().textContent,/尚无可用模板或打印站/);assert.equal(empty.dialog().querySelector('[type="submit"]').disabled,true);empty.api.close();
});

test('uploaded native templates preserve bytes and selected data source names; non-.btw filenames and oversize files are rejected',async()=>{
  const app=fixture({manage:true});await app.api.open();await app.click('templates');let form=app.dialog().querySelector('[data-bp-form="upload-template"]');form.elements.name.value='校准模板';
  for(const file of [{name:'layout.json',size:1},{name:'large.btw',size:4194305}]){form.elements.file.files=[file];await app.submit('upload-template');assert.match(app.dialog().textContent,/不超过 4 MiB/);}
  form.elements.file.files=[{name:'unit.btw',size:3,arrayBuffer:async()=>new Uint8Array([0,128,255]).buffer}];await app.submit('upload-template');
  const sent=app.requests.find(row=>row.url==='/api/printing/templates'&&row.options.method==='POST');assert.equal(sent.body.contentBase64,'AID/');assert.ok(sent.body.fields.includes('Code'));assert.equal(sent.body.fileName,'unit.btw');app.api.close();
});

test('station token is one-time DOM content, copies explicitly and is cleared on close or navigation',async()=>{
  const app=fixture({manage:true});await app.api.open();await app.click('stations');const form=app.dialog().querySelector('[data-bp-form="create-station"]');form.elements.name.value='USB电脑';form.elements.printerName.value='Deli DL-886A(NEW)';await app.submit('create-station');
  assert.equal(app.dialog().querySelector('#bp-token').value,'secret-once');assert.doesNotMatch(app.dialog().innerHTML,/secret-once/);await app.click('copy-token');assert.deepEqual(app.clipboard,['secret-once']);await app.click('stations');assert.equal(app.dialog().querySelector('#bp-token'),null);app.api.close();assert.equal(app.dialog().innerHTML,'');
});

test('a refresh error after station creation leaves the one-time token available to copy',async()=>{
  const app=fixture({manage:true});await app.api.open();await app.click('stations');app.setIntercept(request=>request.url==='/api/printing/config'?{body:{error:'配置暂不可用'},status:503}:undefined);
  const form=app.dialog().querySelector('[data-bp-form="create-station"]');form.elements.name.value='USB电脑';form.elements.printerName.value='Deli DL-886A(NEW)';await app.submit('create-station');assert.equal(app.dialog().querySelector('#bp-token').value,'secret-once');assert.match(app.dialog().textContent,/配置暂不可用/);app.api.close();
});

test('unknown jobs require manual checking and separate full reprints with a reason and unchanged UUID config',async()=>{
  const app=fixture({manage:true,status:'unknown'});await app.api.open();await app.click('detail',ids.job);assert.match(app.dialog().textContent,/不得自动重试/);assert.equal(app.dialog().querySelector('[data-bp="retry-job"]'),null);assert.ok(app.dialog().querySelector('[data-bp="confirm-form"]'));
  await app.click('reprint');assert.equal(app.dialog().querySelector('[data-bp="trial-job"]'),null);const form=app.dialog().querySelector('#bp-compose');assert.equal(form.elements.from,undefined);assert.equal(form.elements.to,undefined);assert.equal(form.elements.templateId.disabled,true);assert.equal(form.elements.stationId.disabled,true);form.elements.reason.value='已核对原标签缺失';await app.submit('submit-job');
  const request=app.requests.find(row=>row.url==='/api/printing/jobs'&&row.options.method==='POST');assert.equal(request.body.reprintOf,ids.job);assert.deepEqual(request.body.unitIds,[11,12]);assert.equal(request.body.reason,'已核对原标签缺失');assert.equal(request.body.templateId,ids.template);app.api.close();
});

test('queued cancellation and manager confirmation use separate mutations and confirmation requires a reason',async()=>{
  const app=fixture({manage:true,status:'claimed'});await app.api.open();await app.click('detail',ids.job);await app.click('cancel-job',ids.job);assert.ok(app.requests.some(row=>row.url==='/api/printing/jobs/'+ids.job+'/cancel'&&row.options.method==='POST'));
  app.job.status='submitted';await app.click('detail',ids.job);await app.click('confirm-form',ids.job);await app.submit('confirm-job');assert.match(app.dialog().textContent,/填写实际核对结果/);assert.equal(app.requests.filter(row=>row.url.endsWith('/confirm')).length,0);
  app.dialog().querySelector('[data-bp-form="confirm-job"]').elements.reason.value='已逐张核对编码及数量';await app.submit('confirm-job');assert.equal(app.requests.find(row=>row.url.endsWith('/confirm')).body.reason,'已逐张核对编码及数量');app.api.close();
});

test('untrusted metadata and task snapshot cells remain text in every printing view',async()=>{
  const app=fixture({manage:true,status:'unknown'});const attack='<img src=x onerror=alert(1)>';app.config.templates[0].name=attack;app.config.stations[0].printerName=attack;app.job.message=attack;app.job.rows[0].Location=attack;
  await app.api.send([{id:11,code:attack}]);assert.equal(app.dialog().querySelector('img'),null);assert.match(app.dialog().innerHTML,/&lt;img/);await app.click('templates');assert.equal(app.dialog().querySelector('img'),null);await app.click('stations');assert.equal(app.dialog().querySelector('img'),null);await app.click('jobs');await app.click('detail',ids.job);assert.equal(app.dialog().querySelector('img'),null);assert.match(app.dialog().innerHTML,/&lt;img/);app.api.close();
});
