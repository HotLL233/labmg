'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {once}=require('node:events');
const {spawn}=require('node:child_process');
const {test}=require('node:test');
const {createTestDatabase}=require('./helpers/postgres');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1kAAAAASUVORK5CYII=','base64');

test('material workflow uses actual batch transactions, per-arrival files and fixed revision QR with real PostgreSQL and Edge',{
  skip:(!process.env.LABOS_TEST_BROWSER_MODULE||!process.env.LABOS_TEST_DATABASE_URL)&&'Set dedicated PostgreSQL and browser environment for the actual material workflow',timeout:240000
},async t=>{
  const database=await createTestDatabase(t),cache=path.join(root,'artifacts/cache',version);
  fs.mkdirSync(cache,{recursive:true});const directory=fs.mkdtempSync(path.join(cache,'material-workflow-')),runtime=path.join(directory,'runtime');
  const reservation=net.createServer().listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,[path.join(root,'src/server.js')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DATABASE_URL:database.url,PORT:String(port),LABOS_RUNTIME_DIR:runtime,LABOS_ADMIN_USER:'workflow-admin',LABOS_ADMIN_PASSWORD:'synthetic-workflow-password'}});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}assert.equal(path.dirname(path.resolve(runtime)),path.resolve(directory));fs.rmSync(runtime,{recursive:true,force:true});});
  const [output]=await once(child.stdout,'data',{signal:AbortSignal.timeout(20000)});assert.match(String(output),/LabOS:/,stderr);
  const base=`http://127.0.0.1:${port}`,browserBase=`http://labmg.example:${port}`;
  let cookie='';
  async function api(method,endpoint,body,expected=200){const response=await fetch(base+endpoint,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const data=await response.json();assert.equal(response.status,expected,`${method} ${endpoint}: ${JSON.stringify(data)}`);return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  cookie=(await api('POST','/api/auth/login',{username:'workflow-admin',password:'synthetic-workflow-password'})).cookie;
  await api('POST','/api/users',{username:'workflow-material',display_name:'合成验收员',roles:['ADMIN','MATERIAL'],password:'synthetic-material-password'},201);
  cookie=(await api('POST','/api/auth/login',{username:'workflow-material',password:'synthetic-material-password'})).cookie;
  const category=(await api('POST','/api/materials/categories',{name:'合成类别'},201)).data,region=(await api('POST','/api/materials/regions',{name:'合成区域'},201)).data;
  const masters=[];for(let i=0;i<2;i++)masters.push((await api('POST','/api/materials/catalog',{name:'核对物资'+(i+1),spec:'500 mL',unit:'瓶',categoryId:category.id,trackingMode:'unit'},201)).data);
  let order=(await api('POST','/api/materials/requests',{title:'分批到货合成申报单',description:'本测试仅使用隔离合成数据'},201)).data;
  for(let i=0;i<2;i++)order=(await api('POST',`/api/materials/requests/${order.id}/items`,{requestVersion:order.version,catalogId:masters[i].id,categoryId:category.id,regionId:region.id,warehouse:'MAIN',quantity:'3',manufacturer:'合成厂家'+(i+1),purpose:'合成验收核对'},201)).data;
  order=(await api('POST',`/api/materials/requests/${order.id}/submit`,{requestVersion:order.version})).data;
  const ids=order.items.map(row=>row.id),initialSnapshot=(await api('GET',`/api/materials/requests/${order.id}/snapshot?revision=1`)).data.snapshot;
  const {chromium}=require(process.env.LABOS_TEST_BROWSER_MODULE);
  const browser=await chromium.launch({headless:true,...(process.env.LABOS_TEST_BROWSER_PATH?{executablePath:process.env.LABOS_TEST_BROWSER_PATH}:{}),args:['--host-resolver-rules=MAP labmg.example 127.0.0.1','--no-proxy-server']});t.after(()=>browser.close());
  const context=await browser.newContext(),split=cookie.indexOf('=');await context.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:browserBase}]);
  const page=await context.newPage();page.setDefaultTimeout(12000);const errors=[],checks=[],payloads=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/receipts/batch'))payloads.push(JSON.parse(request.postData()));});
  const check=(condition,label,evidence)=>{checks.push({label,passed:Boolean(condition),...(evidence===undefined?{}:{evidence})});assert.ok(condition,label+(evidence===undefined?'':': '+JSON.stringify(evidence)));};
  const capture=name=>page.screenshot({path:path.join(directory,name+'.png')});
  const button=action=>page.locator(`[data-mw="${action}"]`).first();
  const input=(id,field)=>page.locator(`[data-wf-item="${id}"][data-wf-field="${field}"]`);
  const receiveMode=()=>page.locator('[data-mw="wf-mode"][data-mode="receive"]');
  const docsMode=()=>page.locator('[data-mw="wf-mode"][data-mode="documents"]');
  const isVisibleInViewport=locator=>locator.evaluate(node=>{const b=node.getBoundingClientRect();return b.width>0&&b.height>0&&b.left>=-1&&b.top>=-1&&b.right<=innerWidth+1&&b.bottom<=innerHeight+1;});
  async function geometry(label,completeRow=false){
    const result=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,table:(()=>{const table=document.querySelector('#mw-order-workspace .mw-order-panel>.mw-table'),head=table?.querySelector('thead'),row=table?.querySelector('tbody tr:not([hidden])');if(!table||!row)return null;const b=table.getBoundingClientRect(),h=head?.getBoundingClientRect(),r=row.getBoundingClientRect();return {top:b.top,bottom:b.bottom,head:h?.height||0,row:r.height,available:Math.min(b.bottom,innerHeight)-(h?.bottom||b.top)};})()}));
    check(result.scroll<=result.width+1,label+': no whole-page horizontal overflow',result);
    check(await isVisibleInViewport(page.locator('#logout')),label+': logout remains in view');
    if(result.width>=768&&label.indexOf('documents')<0)check(await isVisibleInViewport(button('wf-adjust')),label+': row action remains visible while its table scrolls');
    if(completeRow&&result.width>=1024){check(Boolean(result.table)&&result.table.available>=result.table.row-1,label+': a complete row fits below the table header',result.table);check(await isVisibleInViewport(button('wf-receive-all')),label+': batch action remains in view');}
  }
  let status='failed';
  try{
    await page.setViewportSize({width:1366,height:768});await page.goto(browserBase);await page.locator('.nav [data-nav="materials"]').click();await page.locator('.mw-nav [data-page="acceptance"]').click();await input(ids[0],'amount').waitFor();
    check(await page.locator('.mw-nav [data-page]').count()===3,'materials primary navigation has exactly declaration, acceptance and inventory');
    check((await input(ids[0],'quantity').inputValue())==='3.000','remaining demand is the default acceptance quantity');
    check((await input(ids[0],'manufacturer').inputValue())==='合成厂家1','actual manufacturer starts from declaration for explicit verification');
    await input(ids[0],'quantity').fill('2');await input(ids[1],'quantity').fill('1');await input(ids[0],'amount').fill('20');await button('wf-receive-selected').click();
    await page.locator('#mw-order-errors').waitFor();check((await page.locator('#mw-order-errors').textContent()).includes('核对物资2'),'missing amount identifies the exact material row');
    check((await api('GET','/api/materials/receipts')).data.total===0,'validation failure does not create any receipt');
    check((await input(ids[0],'amount').inputValue())==='20','failed validation retains other row input');
    await input(ids[1],'amount').fill('10');
    let lose=true;await page.route('**/receipts/batch',async route=>{if(lose){lose=false;await route.fetch({url:base+new URL(route.request().url()).pathname,headers:{...route.request().headers(),host:new URL(browserBase).host}});await route.abort('failed');}else await route.continue();});
    await button('wf-receive-selected').click();await button('wf-retry').waitFor();
    check((await api('GET','/api/materials/receipts')).data.total===2,'lost HTTP response may already have committed the complete batch');
    check(await input(ids[0],'amount').isDisabled(),'uncertain result freezes original inputs');
    await button('wf-retry').click();await button('wf-retry').waitFor({state:'detached'});await page.unroute('**/receipts/batch');
    check(payloads.length===2&&JSON.stringify(payloads[0])===JSON.stringify(payloads[1]),'retry reuses the exact batch body and idempotency key');
    check((await api('GET','/api/materials/receipts')).data.total===2,'retry does not duplicate stock or receipt records');
    let arrivals=(await api('GET',`/api/materials/requests/${order.id}/arrivals`)).data.items;check(arrivals.length===1,'one selected/all operation creates exactly one arrival');const firstArrival=arrivals[0].id;
    check((await input(ids[0],'quantity').inputValue())==='1.000','partial receipt leaves one remaining in the first row');
    await capture('desktop-first-arrival');
    await button('wf-doc-current').click();await page.locator('#mw-arrival-files').waitFor({state:'attached'});
    check(await page.locator('#mw-arrival-camera').getAttribute('capture')==='environment','photo input requests the system rear-camera picker');
    await page.locator('#mw-arrival-files').setInputFiles({name:'第一次到货.png',mimeType:'image/png',buffer:png});await button('wf-doc-save').click();await page.waitForFunction(()=>document.querySelector('.mw-arrival-editor')?.textContent.includes('本次最新版 v1'));
    const firstV1=(await api('GET',`/api/materials/arrivals/${firstArrival}/documents`)).data;
    await page.locator('#mw-arrival-files').setInputFiles({name:'补拍扫描.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\n合成扫描件\n%%EOF')});await button('wf-doc-save').click();
    check((await page.locator('#mw-arrival-error').textContent()).includes('原因'),'replacement requires an explicit reason');
    await page.locator('#mw-arrival-reason').fill('合成补拍更清晰');await button('wf-doc-save').click();await page.waitForFunction(()=>document.querySelector('.mw-arrival-editor')?.textContent.includes('本次最新版 v2'));
    const firstV2=(await api('GET',`/api/materials/arrivals/${firstArrival}/documents`)).data;
    check(firstV2.version===2&&firstV2.versions.length===2,'same-arrival replacement keeps the original and current versions');
    check(firstV2.versions.some(row=>row.files.some(file=>file.id===firstV1.versions[0].files[0].id)),'old document metadata remains associated with its arrival');
    check((await api('GET','/api/materials/receipts')).data.total===2,'document replacement does not post stock again');
    await page.locator('#mw-arrival-files').setInputFiles({name:'未提交补拍.png',mimeType:'image/png',buffer:png});await receiveMode().click();await button('wf-leave-keep').click();
    check(await page.locator('.mw-arrival-editor').count()===0,'returning to acceptance removes the document editor from the table workspace');
    await docsMode().click();if(await button('wf-leave-keep').count())await button('wf-leave-keep').click();
    await button('wf-doc-open').first().click();check((await page.locator('#mw-arrival-pending').textContent()).includes('未提交补拍.png'),'pending photo stays under the originally selected arrival');
    await button('wf-doc-cancel').click();await receiveMode().click();check(await page.locator('.mw-order-leave').count()===0,'cancelled document draft does not leave a stale navigation callback');
    await input(ids[0],'amount').fill('10');await input(ids[1],'amount').fill('20');
    const completed=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/receipts/batch')&&response.status()===201);
    await button('wf-receive-all').click();const committed=await (await completed).json();
    await page.waitForFunction(arrivalId=>document.querySelector('.mw-order-result')?.textContent.includes('到货 #'+arrivalId+' ')&&[...document.querySelectorAll('[data-wf-field="quantity"]')].every(node=>node.disabled),committed.arrivalId);
    arrivals=(await api('GET',`/api/materials/requests/${order.id}/arrivals`)).data.items;check(arrivals.length===2,'second partial delivery creates its own arrival');const secondArrival=arrivals.find(row=>row.id!==firstArrival).id;
    await button('wf-doc-current').click();await page.locator('#mw-arrival-files').setInputFiles({name:'第二次到货.png',mimeType:'image/png',buffer:png});await button('wf-doc-save').click();await page.waitForFunction(()=>document.querySelector('.mw-arrival-editor')?.textContent.includes('本次最新版 v1'));
    check((await api('GET',`/api/materials/arrivals/${firstArrival}/documents`)).data.version===2,'second-arrival upload does not replace first-arrival files');
    check((await api('GET',`/api/materials/arrivals/${secondArrival}/documents`)).data.version===1,'second arrival starts its own document version sequence');
    await capture('desktop-arrival-documents');
    await receiveMode().click();
    for(const size of [{width:1366,height:768},{width:1440,height:900},{width:900,height:650},{width:768,height:1024},{width:390,height:844},{width:1366,height:480}]){
      await page.setViewportSize(size);await geometry(`${size.width}x${size.height}`,size.height>=768);
      if(size.width<768){await button('wf-receive-all').scrollIntoViewIfNeeded();check(await button('wf-receive-all').isVisible(),'mobile batch action is reachable through necessary vertical scrolling');}
      await capture(`${size.width}x${size.height}-acceptance`);await docsMode().click();await button('wf-doc-open').first().click();await geometry(`${size.width}x${size.height} documents`);await capture(`${size.width}x${size.height}-documents`);await receiveMode().click();
    }
    order=(await api('GET',`/api/materials/requests/${order.id}`)).data;await api('PATCH',`/api/materials/requests/${order.id}`,{requestVersion:order.version,title:'修订后的合成主题',reason:'合成标题受控修订'});
    check(JSON.stringify((await api('GET',`/api/materials/requests/${order.id}/snapshot?revision=1`)).data.snapshot)===JSON.stringify(initialSnapshot),'acceptance and later revisions leave the printed original projection unchanged');
    await page.setViewportSize({width:1366,height:768});await page.evaluate(({id})=>MaterialOriginal.open(id,1),{id:order.id});await page.locator('#material-original [data-mo="print"]:not([disabled])').waitFor();
    check((await page.locator('#material-original').textContent()).includes('当前已修订到 r2'),'old paper version clearly discloses a newer revision without replacing its content');
    for(const size of [{width:1366,height:768},{width:1440,height:900},{width:900,height:650},{width:768,height:1024},{width:390,height:844}]){
      await page.setViewportSize(size);check(await isVisibleInViewport(page.locator('#material-original')),`${size.width} original: dialog stays inside the viewport`);
      check(await isVisibleInViewport(page.locator('#material-original [data-mo="close"]')),`${size.width} original: return stays reachable`);
      check(await isVisibleInViewport(page.locator('#material-original [data-mo="print"]')),`${size.width} original: print stays reachable`);
      await capture(`${size.width}x${size.height}-original`);
    }
    await page.setViewportSize({width:1366,height:768});
    const downloadPromise=page.waitForEvent('download');await page.locator('#material-original [data-mo="download"]').click();const download=await downloadPromise;await download.saveAs(path.join(directory,'original-r1.xlsx'));check(download.suggestedFilename().endsWith('-r1.xlsx'),'browser downloads the exact fixed revision workbook');
    const popupPromise=page.waitForEvent('popup');await page.locator('#material-original [data-mo="print"]').click();const popup=await popupPromise;
    try{await popup.locator('#mo-print:not([disabled])').waitFor();}catch(error){fs.writeFileSync(path.join(directory,'popup-failure.json'),JSON.stringify(await popup.evaluate(()=>({state:document.readyState,status:document.querySelector('#mo-status')?.textContent,image:(()=>{const image=document.querySelector('.mo-qr');return {src:image?.src,complete:image?.complete,width:image?.naturalWidth};})(),styles:[...document.styleSheets].map(sheet=>sheet.href)})),null,2));await popup.screenshot({path:path.join(directory,'popup-failure.png')});throw error;}
    check((await popup.locator('.mo-sheet').textContent()).includes('分批到货合成申报单'),'print sheet uses the original title');check(!(await popup.locator('.mo-sheet').textContent()).includes('修订后的合成主题'),'print sheet does not quietly switch to current title');
    const qrImage=await popup.locator('.mo-qr').screenshot();const zxing=require('zxing-wasm');await zxing.prepareZXingModule({overrides:{wasmBinary:fs.readFileSync(require.resolve('zxing-wasm/full/zxing_full.wasm'))}});const decoded=await zxing.readBarcodesFromImageFile(new Blob([qrImage],{type:'image/png'}));
    const target=`${browserBase}/#material-original=${order.id}&revision=1`;check(decoded.some(row=>row.text===target),'actual generated paper QR decodes to the same order and immutable revision');
    await popup.pdf({path:path.join(directory,'original-r1.pdf'),preferCSSPageSize:true,printBackground:true});const pdf=fs.readFileSync(path.join(directory,'original-r1.pdf'));check(pdf.length>1000,'browser can generate the A4 original PDF');
    check(/\/MediaBox\s*\[0 0 841\.\d+ 594\.\d+\]/.test(pdf.toString('latin1')),'named print page has actual A4 landscape dimensions');await popup.close();
    const loggedOut=await browser.newContext();const loginPage=await loggedOut.newPage();loginPage.on('pageerror',error=>errors.push(error.message));await loginPage.goto(target);await loginPage.locator('#login').waitFor({state:'visible'});
    await loginPage.locator('#auth-username').fill('workflow-material');await loginPage.locator('#auth-password').fill('synthetic-material-password');await loginPage.locator('#auth-submit').click();await loginPage.locator('#material-original .mo-sheet').waitFor();
    check((await loginPage.locator('#material-original .mo-sheet').textContent()).includes('分批到货合成申报单'),'login returns the scanned fixed original rather than default dashboard or newer revision');await loginPage.screenshot({path:path.join(directory,'login-return-original.png')});await loggedOut.close();
    check(errors.length===0,'production scripts have no browser exceptions',errors);status='passed';
  }finally{
    if(status!=='passed')await capture('failure').catch(()=>{});
    fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify({status,applicationVersion:version,actualApi:true,actualSource:true,syntheticOriginAlias:browserBase,checks,errors,payloadCount:payloads.length},null,2));t.diagnostic(`Material workflow report and screenshots: ${directory}`);
  }
});
