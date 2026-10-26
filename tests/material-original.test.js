const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const {target,viewUrl,sheetHtml}=require('../src/public/material-original');
const source=fs.readFileSync(path.join(__dirname,'../src/public/material-original.js'),'utf8');
const original={id:31,no:'WZ-31',title:'合成原单',description:'合成备注',creatorName:'填报人',submittedAt:'2026-10-26T01:00:00Z',items:[
  {name:'原申报名称',spec:'原规格',unit:'瓶',qtyM:12500,manufacturer:'原厂家',regionName:'分析区',warehouse:'public',purpose:'合成用途'}
]};

test('original links accept only exact positive safe request and revision identifiers',()=>{
  assert.deepEqual(target('#material-original=31&revision=2'),{id:31,revision:2});
  for(const hash of ['', '#material-original=0&revision=1','#material-original=01&revision=1','#material-original=31&revision=0',
    '#material-original=31&revision=2&next=https://elsewhere.test','#material-original=31&revision=9007199254740992','#material-original=31&revision=2/'])assert.equal(target(hash),null);
  assert.equal(viewUrl(31,2,'https://172.28.10.200:8443'), 'https://172.28.10.200:8443/#material-original=31&revision=2');
  assert.equal(viewUrl(31,1,'https://nas.example.com/ignored'), 'https://nas.example.com/#material-original=31&revision=1');
  for(const origin of ['http://localhost','http://localhost.','http://foo.localhost','http://127.5.6.7','http://0.0.0.0','http://[::]','http://[::1]',
    'http://[::ffff:127.0.0.1]','http://labos:3000','http://a.internal','https://a.invalid','file:///foo','https://user:password@nas.example.com'])assert.throws(()=>viewUrl(31,1,origin));
  assert.throws(()=>viewUrl(31,0,'https://nas.example.com'));
});

test('one fixed projection renders a safe paper checklist with manufacturer and blank handwritten fields',()=>{
  const html=sheetHtml({...original,title:'<script>bad</script>',items:[{...original.items[0],name:'<img onerror=bad>'}]},2,{url:viewUrl(31,2,'https://nas.example.com'),qr:'blob:qr'});
  assert.match(html,/r2/);assert.match(html,/12\.5/);assert.match(html,/原厂家/);assert.match(html,/第______次到货/);
  assert.match(html,/核对√/);assert.match(html,/本次实到/);assert.match(html,/<td class="mo-check">□<\/td><td><\/td><td><\/td>/);
  assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<script>|<img onerror/);
  assert.match(html,/material-original=31&amp;revision=2/);assert.doesNotMatch(html,/acceptedQty|arrival|amount/);
});

function fixture({hold,origin='https://172.28.10.200:8443',badVersion=false}={}){
  const dialogs=[],calls=[],urls=[],revoked=[],downloads=[],events=new Map(),popups=[];
  const node=()=>({disabled:false,hidden:false,textContent:'',innerHTML:'',setAttribute(name,value){this[name]=value;}});
  const document={
    getElementById(id){return dialogs.find(dialog=>dialog.id===id&&!dialog.removed);},
    createElement(tag){
      if(tag==='a')return {...node(),click(){downloads.push(this);},remove(){}};
      const nodes=Object.fromEntries(['close','download','print','error','body'].map(key=>[key,node()])),listeners={};
      nodes.download.disabled=nodes.print.disabled=true;
      nodes.body.querySelector=()=>null;
      const dialog={...node(),nodes,open:false,querySelector(selector){return selector==='.mw-dialog-body'?nodes.body:nodes[selector.match(/data-mo="([^"]+)"/)?.[1]];},
        addEventListener(name,callback){listeners[name]=callback;},remove(){this.removed=true;},close(){this.open=false;listeners.close?.();}};
      dialogs.push(dialog);return dialog;
    },
    body:{appendChild(){},contains(dialog){return !dialog.removed;}}
  };
  class Url extends URL{static createObjectURL(){const value='blob:original-'+(urls.length+1);urls.push(value);return value;}static revokeObjectURL(value){revoked.push(value);}}
  const context={document,URL:Url,Blob,location:{origin,hash:'#material-original=31&revision=1'},currentUser:{id:1},
    labelTable(){},setTimeout(callback){callback();},toast(){},
    addEventListener(name,callback){events.set(name,callback);},
    Workspace:{show(dialog){dialog.open=true;},close(dialog){dialog.close();}},
    async call(url){calls.push(url);if(hold)await hold;return badVersion?{snapshot:original,revision:3,currentRevision:3}:{snapshot:original,revision:1,currentRevision:2};},
    async fetch(url){calls.push(url);return {ok:true,async blob(){return new Blob(['xlsx']);}};},
    MaterialScanner:{async createQr(text){calls.push(text);return new Blob(['qr']);}},
    async go(module){calls.push('go:'+module);return true;},
    window:{open(){
      const nodes={'mo-print':node(),'mo-status':node(),image:{naturalWidth:50,complete:true}},handlers={},links=[node(),node(),node()].map(link=>({...link,sheet:{}}));
      nodes['mo-print'].disabled=true;
      const popup={opener:{},closed:false,prints:0,addEventListener(name,callback){handlers[name]=callback;},print(){this.prints++;},
        document:{readyState:'complete',write(html){this.html=html;},close(){},getElementById(id){return nodes[id];},querySelector(){return nodes.image;},querySelectorAll(){return links;}},nodes,handlers,links};
      popups.push(popup);return popup;
    }}
  };
  vm.createContext(context);vm.runInContext(source,context);
  return {context,api:context.MaterialOriginal,dialogs,calls,urls,revoked,downloads,events,popups};
}

test('original shows the requested revision, downloads the same revision and prepares its QR print',async()=>{
  const app=fixture();await app.api.open(31,1);
  const dialog=app.dialogs[0];assert.match(dialog.nodes.body.innerHTML,/原申报名称/);assert.match(dialog.nodes.body.innerHTML,/当前已修订到 r2/);
  assert.equal(dialog.nodes.print.disabled,false);assert.equal(dialog.nodes.download.disabled,false);
  assert.ok(app.calls.includes('https://172.28.10.200:8443/#material-original=31&revision=1'));
  await dialog.nodes.download.onclick();
  assert.equal(app.downloads.length,1);assert.match(app.downloads[0].download,/-r1\.xlsx$/);
  assert.match(app.calls.find(url=>url.includes('export.xlsx')),/revision=1&viewUrl=https%3A/);
  dialog.nodes.print.onclick();const popup=app.popups[0];
  assert.equal(popup.opener,null);assert.match(popup.document.html,/原申报名称/);assert.match(popup.document.html,/revision=1/);
  popup.nodes['mo-print'].onclick();assert.equal(popup.prints,1);
  popup.handlers.pagehide();assert.ok(app.revoked.includes('blob:original-3'));
  dialog.nodes.close.onclick();assert.ok(app.revoked.includes('blob:original-1'));
});

test('invalid paper origins still allow fixed original reading and Excel, without misleading QR printing',async()=>{
  const app=fixture({origin:'http://localhost:3001'});await app.api.open(31,1);
  const dialog=app.dialogs[0];assert.equal(dialog.nodes.download.disabled,false);assert.equal(dialog.nodes.print.disabled,true);
  assert.match(dialog.nodes.error.textContent,/群晖 IP/);assert.equal(app.urls.length,0);
  await dialog.nodes.download.onclick();assert.doesNotMatch(app.calls.find(url=>url.includes('export.xlsx')),/viewUrl/);
});

test('original print settings are isolated and a failed stylesheet cannot be re-enabled by a later load event',async()=>{
  const css=fs.readFileSync(path.join(__dirname,'../src/public/material-original.css'),'utf8');
  assert.doesNotMatch(css,/@page\s*\{/);assert.match(css,/@page material-original\{/);assert.match(css,/\.mo-print \.mo-sheet\{page:material-original/);
  const app=fixture();await app.api.open(31,1);app.dialogs[0].nodes.print.onclick();const popup=app.popups[0];
  popup.links[0].onerror();popup.handlers.load();assert.equal(popup.nodes['mo-print'].disabled,true);
  assert.match(popup.nodes['mo-status'].textContent,/打印样式加载失败/);popup.nodes['mo-print'].onclick();assert.equal(popup.prints,0);
});

test('original print waits for pending QR and styles without treating the initial blank popup load as failure',async()=>{
  const app=fixture();await app.api.open(31,1);app.dialogs[0].nodes.print.onclick();const popup=app.popups[0];
  popup.nodes['mo-print'].disabled=true;popup.nodes.image.complete=false;popup.nodes.image.naturalWidth=0;popup.links[0].sheet=null;
  popup.handlers.load();assert.equal(popup.nodes['mo-print'].disabled,true);assert.doesNotMatch(popup.nodes['mo-status'].textContent,/加载失败/);
  popup.nodes.image.complete=true;popup.nodes.image.naturalWidth=205;popup.nodes.image.onload();assert.equal(popup.nodes['mo-print'].disabled,true);
  popup.links[0].sheet={};popup.links[0].onload();assert.equal(popup.nodes['mo-print'].disabled,false);
});

test('closing an in-flight original prevents late rendering, QR generation and download enablement',async()=>{
  let release;const hold=new Promise(resolve=>{release=resolve;}),app=fixture({hold});
  const opening=app.api.open(31,1);app.dialogs[0].nodes.close.onclick();release();await opening;
  assert.equal(app.urls.length,0);assert.equal(app.dialogs[0].nodes.print.disabled,true);
  assert.ok(!app.calls.some(url=>url.startsWith('https://')));
});

test('original rejects a mismatched snapshot response and resumes exact deep links only after login',async()=>{
  const bad=fixture({badVersion:true});await bad.api.open(31,1);assert.match(bad.dialogs[0].nodes.error.textContent,/响应不一致/);
  assert.equal(bad.dialogs[0].nodes.download.disabled,true);
  const app=fixture();app.context.currentUser=null;assert.equal(await app.api.resume(),false);assert.equal(app.calls.length,0);
  app.context.currentUser={id:2};assert.equal(await app.api.resume(),true);
  assert.equal(app.calls[0],'go:materials');assert.equal(app.calls[1],'/api/materials/requests/31/snapshot?revision=1');
});
