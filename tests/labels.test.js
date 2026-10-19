const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { validate, defaults, csv, labelHtml, layoutCss, rowsFrom } = require('../src/public/material-labels');
const source = fs.readFileSync(path.join(__dirname, '../src/public/material-labels.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Only the popup/document APIs used by labels are modeled; real Edge and physical printers are separate checks.
function fixture({ template, createBarcode, createQr, imageFailure = false, onYield } = {}) {
  const urls = new Set(), revoked = [], generated = [], downloads = [], popups = [];
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
        write(html) {
          this.html = html;
          this.images = Array.from(html.matchAll(/<img /g), () => ({ complete: true, naturalWidth: imageFailure ? 0 : 64 }));
          this.labels = Array.from(html.matchAll(/<section class="label">/g), () => ({ hidden: false, classes: new Set(), classList: { toggle(name, show) { show ? this.owner.classes.add(name) : this.owner.classes.delete(name); } } }));
          for (const label of this.labels) label.classList.owner = label;
          for (const match of html.matchAll(/<(button|input) id="([^"]+)"([^>]*)>/g)) controls[match[2]] = { ...node(), disabled: /\bdisabled\b/.test(match[3]), value: match[3].match(/\bvalue="([^"]*)"/)?.[1] || '' };
          controls.status = status;
        },
        close() {}, querySelector() { return status; }, querySelectorAll() { return this.labels; }, getElementById(name) { return controls[name]; }
      }
    };
    popups.push(result); return result;
  }
  const context = {
    Blob, clearTimeout, setTimeout(callback, delay) { if (delay === 0) onYield?.(); return setTimeout(callback, delay); },
    localStorage: { getItem() { return template ? JSON.stringify(template) : null; } },
    URL: { createObjectURL() { const url = 'blob:label-' + (generated.length + 1); urls.add(url); generated.push(url); return url; }, revokeObjectURL(url) { urls.delete(url); revoked.push(url); } },
    document: { createElement: node, body: { appendChild() {} } }, window: { open: popup },
    MaterialScanner: {
      createBarcode: createBarcode || (async () => new Blob(['barcode'])),
      createQr: createQr || (async () => new Blob(['qr']))
    }
  };
  vm.createContext(context); vm.runInContext(source, context);
  return { api: context.MaterialLabels, urls, revoked, generated, downloads, popups, context };
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
