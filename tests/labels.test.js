const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { validate, defaults, csv, labelHtml, layoutCss, rowsFrom, resize, wideBarcode } = require('../src/public/material-labels');
const source = fs.readFileSync(path.join(__dirname, '../src/public/material-labels.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Only the popup/document APIs used by labels are modeled; real Edge and physical printers are separate checks.
function fixture({ template, createBarcode, createQr, imageFailure = false, textOverflow, onYield } = {}) {
  const urls = new Set(), revoked = [], generated = [], downloads = [], popups = [], saved=[];
  const node = () => ({ disabled: false, textContent: '', setAttribute() {}, remove() {}, click() { downloads.push(this); } });
  function popup() {
    const events = {}, controls = {}, status = node();
    const result = {
      closed: false, opener: {}, printCount: 0, printed: [],
      addEventListener(name, callback) { (events[name] ||= []).push(callback); },
      close() { if (this.closed) return; this.closed = true; for (const callback of events.pagehide || []) callback(); },
      print() { this.printCount++; this.printed.push(this.document.labels.flatMap((label,index) => label.hidden ? [] : [index + 1])); },
      document: {
        images: [], labels: [], body: { replaceChildren(value) { this.error = value.textContent; } },
        createElement: node,
        open() { for (const name of Object.keys(events)) delete events[name]; },
        render(html) {
          this.images = Array.from(html.matchAll(/<img /g), () => ({ complete: true, naturalWidth: imageFailure ? 0 : 64 }));
          this.labels = Array.from(html.matchAll(/<section class="label">([\s\S]*?)<\/section>/g), match => ({ hidden: false, classes: new Set(),
            elements: Array.from(match[1].matchAll(/data-field="([^"]+)"/g), entry => ({ dataset:{field:entry[1]},clientWidth:10,scrollWidth:entry[1]===textOverflow?30:10,clientHeight:10,scrollHeight:10,classList:{toggle(){}} })),
            classList: { toggle(name, show) { show ? this.owner.classes.add(name) : this.owner.classes.delete(name); } } }));
          for (const label of this.labels) label.classList.owner = label;
        },
        write(html) {
          this.html = html;this.render(html);
          for (const match of html.matchAll(/<(button|input|style|main|p)\b[^>]*?\bid="([^"]+)"([^>]*)>/g)) controls[match[2]] = { ...node(), disabled: /\bdisabled\b/.test(match[3]), value: match[3].match(/\bvalue="([^"]*)"/)?.[1] || '' };
          for (const match of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) controls[match[1]]={...node(),value:match[2].match(/<option value="([^"]+)" selected/)?.[1]||''};
          if(controls['label-pages']){
            const doc=this;controls['label-pages'].querySelectorAll=()=>doc.labels.flatMap(label=>label.elements);
            Object.defineProperty(controls['label-pages'],'innerHTML',{set(value){doc.render(value);}});
          }
          controls.status = status;
        },
        close() {}, querySelector() { return status; }, querySelectorAll(selector) { return selector==='.element'?this.labels.flatMap(label=>label.elements):this.labels; }, getElementById(name) { return controls[name]; }
      }
    };
    popups.push(result); return result;
  }
  const context = {
    Blob, clearTimeout, setTimeout(callback, delay) { if (delay === 0) onYield?.(); return setTimeout(callback, delay); },
    localStorage: { getItem() { return template ? JSON.stringify(template) : null; },setItem(key,value){saved.push({key,value:JSON.parse(value)});} },
    URL: { createObjectURL() { const url = 'blob:label-' + (generated.length + 1); urls.add(url); generated.push(url); return url; }, revokeObjectURL(url) { urls.delete(url); revoked.push(url); } },
    document: { createElement: node, body: { appendChild() {} } }, window: { open: popup },
    MaterialScanner: {
      createBarcode: createBarcode || (async () => new Blob(['barcode'])),
      createQr: createQr || (async () => new Blob(['qr']))
    }
  };
  vm.createContext(context); vm.runInContext(source, context);
  return { api: context.MaterialLabels, urls, revoked, generated, downloads, popups, context, saved };
}

test('label templates validate dimensions, numeric types, known unique fields and visible element bounds', () => {
  assert.deepEqual(validate(clone(defaults)), defaults);
  for (const mutate of [
    value => { value.width = 0; }, value => { value.height = Infinity; }, value => { value.offsetX = '0'; },
    value => { value.elements[0].field = 'html'; }, value => { value.elements[0].field = value.elements[1].field; },
    value => { value.elements[0].show = 'true'; }, value => { value.elements[0].x = 59; },
    value => { value.elements[0].font = 100; }, value => { value.elements.pop(); }
  ]) { const value = clone(defaults); mutate(value); assert.throws(() => validate(value)); }
  const hidden = clone(defaults); hidden.elements[0].show = false; hidden.elements[0].x = 100;
  assert.equal(validate(hidden).elements[0].x, 100);
});

test('CSV is UTF-8 BOM text with exact codes, twelve headers, escaped quotes, commas and multiline values', () => {
  const text = csv([{ code: '000001', name: '乙醇,"分析纯"\n第二行', qrPayload: 'LAB-000001' }]);
  assert.ok(text.startsWith('\uFEFF"Code","QRPayload","Name","CatalogCode","Specification","Unit","Region","Warehouse","Location","Batch","ExpiryDate","Status"\r\n'));
  assert.ok(text.endsWith('"000001","LAB-000001","乙醇,""分析纯""\n第二行","","","","","","","","",""\r\n'));
  assert.equal(csv([{ code: '01' }, { code: '02' }]).split('\r\n').length, 4);
  assert.match(csv([{ code: 'A', warehouse: 'MAIN', warehouseName: '中心仓库' }]), /"中心仓库"/);
});

test('both paper sizes and portrait dimensions fit schema 1 layouts, while calibration outside the page is rejected',()=>{
  for(const [width,height] of [[60,40],[38.5,30.5],[40,60],[30.5,38.5]]){
    const template=resize(clone(defaults),width,height);
    assert.equal(template.schema,1);assert.equal(template.width,width);assert.equal(template.height,height);
    assert.match(layoutCss(template),new RegExp(`@page\\{size:${width}mm ${height}mm;margin:0\\}`));
    for(const element of template.elements.filter(element=>element.show)){
      assert.ok(element.x+element.w<=width+.001);assert.ok(element.y+element.h<=height+.001);
    }
  }
  const calibrated=clone(defaults);calibrated.offsetX=1;calibrated.offsetY=-1;assert.equal(validate(calibrated).offsetX,1);
  calibrated.offsetX=2;assert.throws(()=>validate(calibrated),/含校准偏移/);
  calibrated.offsetX=0;calibrated.offsetY=-2;assert.throws(()=>validate(calibrated),/含校准偏移/);
});

test('label content is escaped and preview CSS cannot change other elements or the main print page size', () => {
  const html = labelHtml({ code: '<img src=x onerror=alert(1)>', name: '<script>bad()</script>' }, defaults);
  assert.doesNotMatch(html, /<script>|onerror=alert\(1\)>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  const warehouseTemplate = clone(defaults); warehouseTemplate.elements.find(item => item.field === 'warehouse').show = true;
  const warehouse = labelHtml({ warehouse: 'MAIN', warehouseName: '<中心仓库>' }, warehouseTemplate);
  assert.match(warehouse, /&lt;中心仓库&gt;/); assert.doesNotMatch(warehouse, />MAIN</);
  assert.match(layoutCss(defaults), /@page\{size:60mm 40mm;margin:0\}/);
  const preview = layoutCss(defaults, true);
  assert.doesNotMatch(preview, /@page/);
  assert.ok(preview.split('}').filter(Boolean).every(rule => rule.startsWith('#material-label-designer [data-label="preview"] ')));
});

test('wide barcodes keep fixed contents, vertical placement and calibration while using available paper width',()=>{
  for(const [width,height] of [[38.5,30.5],[30.5,38.5]]){
    const template=resize(clone(defaults),width,height),original=clone(template),value=wideBarcode(template);
    const barcode=value.elements.find(element=>element.field==='barcode');
    assert.equal(barcode.x,1);assert.equal(barcode.w,width-2);
    assert.equal(barcode.y,template.elements.find(element=>element.field==='barcode').y);
    assert.equal(barcode.h,template.elements.find(element=>element.field==='barcode').h);
    assert.deepEqual(template,original);
    assert.deepEqual(value.elements.filter(element=>element.field!=='barcode'),template.elements.filter(element=>element.field!=='barcode'));
    assert.match(labelHtml({code:'LAB-20261020-000001'},value),/>LAB-20261020-000001</);
  }
  const template=clone(defaults);template.offsetX=1;
  const result=wideBarcode(template),barcode=result.elements.find(element=>element.field==='barcode');
  assert.equal(barcode.x,0);assert.equal(barcode.w,58);assert.equal(result.offsetX,1);
});

test('label row loading rejects duplicates, empty and excessive sets and stale async sources', async () => {
  for (const rows of [[], null, [{ code: '' }], [{ code: 'A' }, { code: 'A' }], Array.from({ length: 1001 }, (_, i) => ({ code: String(i) }))]) await assert.rejects(rowsFrom(rows, {}));
  assert.equal((await rowsFrom(Array.from({ length: 1000 }, (_, i) => ({ code: String(i) })), {})).length, 1000);
  await assert.rejects(rowsFrom(async () => [{ code: 'A' }], { isActive: () => false }), /页面已切换/);
});

test('ready label popups print at the configured size and release every blob after document replacement and close', async () => {
  const app = fixture(); await app.api.printUnits([{ code: 'A001' }, { code: 'A002' }], { title: '<script>unsafe</script>' });
  const popup = app.popups[0];
  assert.equal(popup.opener, null); assert.equal(popup.document.getElementById('print').disabled, false);
  assert.match(popup.document.html, /DL-886A（NEW）标签打印/);
  assert.match(popup.document.html, /name="viewport"/);
  assert.match(popup.document.html, /min-height:44px/);
  assert.match(popup.document.html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(popup.document.html, /@page\{size:60mm 40mm;margin:0\}/);
  assert.equal(app.urls.size, 4);
  popup.document.getElementById('print').onclick(); assert.equal(popup.printCount, 1);
  popup.close(); assert.equal(app.urls.size, 0); assert.equal(app.revoked.length, 4);
});

test('DL-886A print range validates input, previews selected labels and restores selection after a one-label trial', async () => {
  const app = fixture(); await app.api.printUnits([{ code: 'A001' }, { code: 'A002' }, { code: 'A003' }]);
  const popup = app.popups[0], doc = popup.document, from = doc.getElementById('from'), to = doc.getElementById('to');
  from.value = '2'; to.value = '3'; from.oninput();
  assert.deepEqual(doc.labels.map(label => label.hidden), [true, false, false]);
  assert.equal(doc.labels[2].classes.has('print-last'), true);
  doc.getElementById('test-print').onclick();
  assert.deepEqual(popup.printed, [[2]]);
  assert.deepEqual(doc.labels.map(label => label.hidden), [true, false, false]);
  doc.getElementById('print').onclick(); assert.deepEqual(popup.printed, [[2], [2, 3]]);
  for (const [first,last] of [['0','3'],['2.5','3'],['3','2'],['1','4'],['','3']]) {
    from.value = first; to.value = last; doc.getElementById('print').onclick();
    assert.match(doc.getElementById('status').textContent, /1–3 内的整数/);
  }
  assert.equal(popup.printCount, 2);
  assert.match(doc.html, /每张 1 份/);
  assert.match(doc.html, /网页无法自动选定 USB 设备/);
  popup.close(); assert.equal(app.urls.size, 0);
});

test('print paper presets, orientation and custom input immediately update page and label sizes without changing codes',async()=>{
  const app=fixture();await app.api.printUnits([{code:'A001'},{code:'A002'},{code:'A003'}]);
  const popup=app.popups[0],doc=popup.document;
  doc.getElementById('from').value='2';doc.getElementById('to').value='3';doc.getElementById('from').oninput();
  const preset=doc.getElementById('paper-preset'),orientation=doc.getElementById('paper-orientation');
  preset.value='38.5x30.5';preset.oninput();
  assert.match(doc.getElementById('label-layout').textContent,/@page\{size:38\.5mm 30\.5mm;margin:0\}/);
  assert.match(doc.getElementById('paper-summary').textContent,/38.5 × 30.5 mm/);
  assert.deepEqual(doc.labels.map(label=>label.hidden),[true,false,false]);
  orientation.value='portrait';orientation.oninput();
  assert.match(doc.getElementById('label-layout').textContent,/width:30\.5mm;height:38\.5mm/);
  assert.match(doc.getElementById('label-layout').textContent,/@page\{size:30\.5mm 38\.5mm;margin:0\}/);
  doc.getElementById('test-print').onclick();assert.deepEqual(popup.printed,[[2]]);
  doc.getElementById('paper-width').value='42';doc.getElementById('paper-width').oninput();
  doc.getElementById('paper-height').value='25';doc.getElementById('paper-height').oninput();
  assert.equal(preset.value,'custom');assert.equal(orientation.value,'landscape');
  assert.match(doc.getElementById('label-layout').textContent,/@page\{size:42mm 25mm;margin:0\}/);
  doc.getElementById('save-paper').onclick();assert.equal(app.saved[0].value.width,42);assert.equal(app.saved[0].value.height,25);
  assert.equal(app.generated.length,6);assert.equal(doc.images.length,6);
  doc.getElementById('print').onclick();assert.deepEqual(popup.printed,[[2],[2,3]]);
  popup.close();assert.equal(app.urls.size,0);
});

test('invalid paper or calibration clears the active preview and blocks printing until corrected',async()=>{
  const app=fixture();await app.api.printUnits([{code:'A001'}]);const popup=app.popups[0],doc=popup.document;
  for(const [id,value] of [['paper-width','0'],['paper-width',''],['paper-width','201'],['paper-offsetX','10']]){
    doc.getElementById('paper-width').value='60';doc.getElementById('paper-offsetX').value='0';
    const input=doc.getElementById(id);input.value=value;input.oninput();
    assert.equal(doc.getElementById('label-pages').hidden,true);assert.equal(doc.getElementById('print').disabled,true);
    doc.getElementById('print').onclick();assert.equal(popup.printCount,0);assert.match(doc.getElementById('status').textContent,/预览未更新/);
  }
  doc.getElementById('paper-offsetX').value='0';doc.getElementById('paper-offsetX').oninput();
  assert.equal(doc.getElementById('label-pages').hidden,false);assert.equal(doc.getElementById('print').disabled,false);
  popup.close();
});

test('print full-width control preserves chosen rows and generated barcode images without issuing new codes',async()=>{
  const app=fixture();await app.api.printUnits([{code:'A001'},{code:'A002'}]);
  const popup=app.popups[0],doc=popup.document,preset=doc.getElementById('paper-preset');
  preset.value='38.5x30.5';preset.oninput();doc.getElementById('from').value='2';doc.getElementById('to').value='2';doc.getElementById('from').oninput();
  doc.getElementById('wide-barcode').onclick();doc.getElementById('save-paper').onclick();
  const barcode=app.saved[0].value.elements.find(element=>element.field==='barcode');
  assert.equal(barcode.x,1);assert.equal(barcode.w,36.5);assert.equal(app.generated.length,4);
  doc.getElementById('test-print').onclick();assert.deepEqual(popup.printed,[[2]]);
  popup.close();assert.equal(app.urls.size,0);
});

test('actual text overflow names the clipped field and blocks silent print output',async()=>{
  const app=fixture({textOverflow:'name'});await app.api.printUnits([{code:'A001',name:'较长名称'}]);
  const popup=app.popups[0],doc=popup.document;
  assert.match(doc.getElementById('status').textContent,/文字超出元素范围：物资名称/);
  assert.equal(doc.getElementById('print').disabled,true);doc.getElementById('print').onclick();assert.equal(popup.printCount,0);
  popup.close();
});

test('legacy calibration is retained for correction rather than silently discarded, and batch saving preserves unit barcodes',async()=>{
  const legacy=clone(defaults);legacy.offsetX=3;
  const app=fixture({template:legacy});await app.api.printUnits([{code:'A001'}]);
  const popup=app.popups[0],doc=popup.document;
  assert.equal(doc.getElementById('paper-offsetX').value,'3');assert.equal(doc.getElementById('print').disabled,true);
  assert.match(doc.getElementById('status').textContent,/含校准偏移/);doc.getElementById('print').onclick();assert.equal(popup.printCount,0);
  doc.getElementById('paper-offsetX').value='0';doc.getElementById('paper-offsetX').oninput();assert.equal(doc.getElementById('print').disabled,false);popup.close();
  const batch=fixture();await batch.api.printBatch({catalogCode:'MAT-001',qrPayload:'labos:batch:actual'});
  batch.popups[0].document.getElementById('save-paper').onclick();
  assert.equal(batch.saved[0].value.elements.find(element=>element.field==='barcode').show,true);
  batch.popups[0].close();
});

test('closing during pending source or barcode generation settles promptly without creating a late label', async () => {
  for (const phase of ['source', 'barcode']) {
    const pending = deferred(), app = fixture(phase === 'barcode' ? { createBarcode: () => pending.promise } : {});
    const printing = app.api.printUnits(phase === 'source' ? () => pending.promise : [{ code: 'A001' }]);
    await tick(); app.popups[0].close();
    assert.equal(await Promise.race([printing.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('pending'), 100))]), 'closed');
    pending.resolve(phase === 'source' ? [{ code: 'A001' }] : new Blob(['late'])); await tick();
    assert.equal(app.generated.length, 0); assert.equal(app.urls.size, 0);
  }
});

test('barcode generation and image load failures release images, show an alert and keep print disabled', async () => {
  for (const settings of [
    { createQr: async () => { throw Error('编码失败'); } }, { imageFailure: true }
  ]) {
    const app = fixture(settings);
    await assert.rejects(app.api.printUnits([{ code: 'A001' }]), /编码失败|图片加载失败/);
    assert.equal(app.urls.size, 0); assert.match(app.popups[0].document.body.error, /标签未生成/);
    assert.notEqual(app.popups[0].document.getElementById('print')?.disabled, false);
  }
});

test('batch labels contain their real QR and no unavailable Code128 placeholder', async () => {
  let barcodes = 0, payload;
  const app = fixture({ createBarcode: async () => { barcodes++; }, createQr: async value => { payload = value; return new Blob(['qr']); } });
  await app.api.printBatch({ catalogCode: 'MAT-001', qrPayload: 'labos:batch:actual' });
  assert.equal(barcodes, 0); assert.equal(payload, 'labos:batch:actual');
  assert.equal(app.popups[0].document.images.length, 1);
  assert.doesNotMatch(app.popups[0].document.html, />Code128<|id="csv"/);
  app.popups[0].close(); assert.equal(app.urls.size, 0);
});

test('changing pages after label generation closes a stale popup instead of issuing a print or download', async () => {
  for (const action of ['print', 'test-print', 'csv']) {
    let active = true;
    const app = fixture(); await app.api.printUnits([{ code: 'A001' }], { isActive: () => active });
    active = false; app.popups[0].document.getElementById(action).onclick();
    assert.equal(app.popups[0].closed, true); assert.equal(app.popups[0].printCount, 0);
    assert.equal(app.downloads.length, 0); assert.equal(app.urls.size, 0);
  }
});

test('large batches yield after twenty rows so closing stops work before all one thousand items are rendered', async () => {
  const app = fixture({ onYield: () => app.popups[0].close() });
  await app.api.printUnits(Array.from({ length: 1000 }, (_, i) => ({ code: 'LAB-' + i })));
  assert.equal(app.generated.length, 40);
  assert.equal(app.urls.size, 0);
  assert.equal(app.popups[0].closed, true);
});
