const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const zxing = require('zxing-wasm');

const source = fs.readFileSync(path.join(__dirname, '../src/public/material-scan.js'), 'utf8');
const wasm = fs.readFileSync(require.resolve('zxing-wasm/full/zxing_full.wasm'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Only scanner DOM/media APIs are modeled here. These checks do not emulate a physical camera or browser layout.
function fixture({ secure = true, protocol = secure ? 'https:' : 'http:', mediaDevices = true, getUserMedia, readBarcodes = async () => [], library = true } = {}) {
  const windowEvents = {}, documentEvents = {}, timers = new Map(), urls = new Set(), revoked = [], draws = [];
  const nodes = [];
  class Element {
    constructor(tag) { this.tag = tag; this.listeners = {}; this.hidden = false; this.disabled = false; this.value = ''; this.isConnected = false; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    appendChild(node) { node.isConnected = true; nodes.push(node); return node; }
    remove() { this.isConnected = false; }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    pause() { this.paused = true; }
    async play() { this.paused = false; }
  }
  class Dialog extends Element {
    constructor() {
      super('dialog');
      this.parts = Object.fromEntries(['video', '.ms-status', '[data-ms="camera"]', '[data-ms="stop"]', '[data-ms="close"]', '.ms-manual', 'photo', 'file'].map(key => [key, new Element(key)]));
      this.parts.video.readyState = 2; this.parts.video.videoWidth = 640; this.parts.video.videoHeight = 480;
      this.parts['.ms-manual'].elements = { code: new Element('input') };
    }
    querySelector(key) { return this.parts[key]; }
    querySelectorAll() { return [this.parts.photo, this.parts.file]; }
  }
  const imageData = { data: new Uint8ClampedArray(16), width: 2, height: 2 };
  const document = {
    head: new Element('head'), body: new Element('body'), hidden: false,
    activeElement: new Element('button'),
    createElement(tag) {
      if (tag === 'dialog') return new Dialog();
      const node = new Element(tag);
      if (tag === 'canvas') node.getContext = () => ({ drawImage(...args) { draws.push(args); }, getImageData: () => imageData });
      return node;
    },
    addEventListener(name, handler) { documentEvents[name] = handler; }
  };
  const tracks = [], requests = [], prepares = [], writes = [];
  function stream() { const track = { stopped: 0, stop() { this.stopped++; } }; tracks.push(track); return { getTracks: () => [track] }; }
  const context = {
    document, navigator: { mediaDevices: mediaDevices ? { async getUserMedia(options) { requests.push(options); return getUserMedia ? getUserMedia() : stream(); } } : undefined },
    isSecureContext: secure, location: { protocol }, WebAssembly, Blob,
    URL: { createObjectURL() { const url = 'blob:' + urls.size; urls.add(url); return url; }, revokeObjectURL(url) { revoked.push(url); urls.delete(url); } },
    Image: class { constructor() { this.naturalWidth = 800; this.naturalHeight = 600; } set src(value) { this.url = value; queueMicrotask(() => this.onload?.()); } },
    setTimeout(callback) { const id = Symbol(); timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(name, handler) { windowEvents[name] = handler; }
  };
  if (library) context.ZXingWASM = {
    async prepareZXingModule(options) { prepares.push(options); },
    readBarcodes, async writeBarcode(text, options) { writes.push({ text, options }); return { image: new Blob(['png'], { type: 'image/png' }), error: '' }; }
  };
  context.globalThis = context;
  vm.createContext(context); vm.runInContext(source, context, { filename: 'material-scan.js' });
  const dialog = () => nodes.filter(node => node.tag === 'dialog').at(-1);
  const manual = value => { dialog().parts['.ms-manual'].elements.code.value = value; dialog().parts['.ms-manual'].onsubmit({ preventDefault() {} }); };
  return { context, document, dialog, manual, tracks, stream, requests, prepares, writes, timers, windowEvents, documentEvents, nodes, urls, revoked, draws, imageData, api: context.MaterialScanner };
}

test('locked local decoder reads real generated QR, Code128, EAN13 and UPC images without a network service', async () => {
  await zxing.prepareZXingModule({ overrides: { wasmBinary: wasm }, fireImmediately: true });
  for (const [format, text] of [['QRCode', 'LabOS:试剂柜 A-02'], ['Code128', 'LOT-0000123'], ['EAN13', '5901234123457'], ['UPCA', '012345678905']]) {
    const written = await zxing.writeBarcode(text, { format, scale: 4, addQuietZones: true });
    assert.equal(written.error, ''); assert.ok(written.image instanceof Blob);
    const results = await zxing.readBarcodes(new Uint8Array(await written.image.arrayBuffer()), { formats: [format], maxNumberOfSymbols: 2 });
    assert.equal(results.length, 1, format);
    assert.equal(results[0].text, format === 'UPCA' ? '0' + text : text, format);
    assert.equal(results[0].format, format); assert.equal(results[0].isValid, true);
  }
});

test('HTTP scan has photo/file/manual fallbacks and never requests a live camera', async () => {
  const app = fixture({ secure: false });
  assert.equal(app.nodes.length, 0, 'module must be lazy');
  const result = app.api.scan();
  assert.match(app.dialog().innerHTML, /capture="environment"/);
  assert.match(app.dialog().innerHTML, /data-ms="file"/);
  assert.match(app.dialog().parts['.ms-status'].textContent, /HTTP.*禁止实时相机.*信任的 HTTPS/);
  await app.dialog().parts['[data-ms="camera"]'].onclick();
  assert.equal(app.requests.length, 0);
  assert.match(app.dialog().parts['.ms-status'].textContent, /HTTP.*禁止实时相机.*拍照、选图或手动输入/);
  app.manual('  000123  '); app.manual('second'); app.api.close();
  assert.equal(await result, '000123'); assert.equal(app.dialog().isConnected, false);
});

test('an unsafe HTTPS context and a browser without camera APIs have distinct explanations and keep manual input', async () => {
  for (const [settings, expected] of [
    [{ secure: false, protocol: 'https:' }, /连接不满足.*安全要求.*信任的 HTTPS/],
    [{ mediaDevices: false }, /浏览器不支持实时相机.*直接打开/]
  ]) {
    const app = fixture(settings), result = app.api.scan();
    assert.match(app.dialog().parts['.ms-status'].textContent, expected);
    await app.dialog().parts['[data-ms="camera"]'].onclick();
    assert.match(app.dialog().parts['.ms-status'].textContent, expected);
    assert.equal(app.requests.length, 0);
    app.manual('NO-CAMERA'); assert.equal(await result, 'NO-CAMERA');
  }
});

test('synthetic video pixels use the real QR decoder, resolve once and release all camera tracks', async () => {
  const written = await zxing.writeBarcode('LABOS-SYNTHETIC-FRAME', { format: 'QRCode', scale: 4, addQuietZones: true });
  const symbol = written.symbol;
  const rgba = new Uint8ClampedArray(symbol.width * symbol.height * 4);
  for (let i = 0; i < symbol.data.length; i++) rgba.set([symbol.data[i], symbol.data[i], symbol.data[i], 255], i * 4);
  let reads = 0;
  const app = fixture({ readBarcodes: async (pixels, options) => { reads++; return zxing.readBarcodes(pixels, options); } });
  Object.assign(app.imageData, { data: rgba, width: symbol.width, height: symbol.height });
  const result = app.api.scan(); await app.dialog().parts['[data-ms="camera"]'].onclick();
  assert.equal(await result, 'LABOS-SYNTHETIC-FRAME'); assert.equal(reads, 1);
  assert.equal(app.tracks[0].stopped, 1); assert.equal(app.timers.size, 0);
  assert.equal(app.dialog().parts.video.srcObject, null); assert.equal(app.requests[0].audio, false);
  assert.equal(app.requests[0].video.facingMode.ideal, 'environment');
  assert.equal(app.prepares[0].overrides.locateFile('zxing_full.wasm'), '/vendor/zxing-wasm/3.1.5/zxing_full.wasm');
});

test('mixed format UPC-A frames preserve the decoder EAN13 representation and manual entry keeps every leading zero', async () => {
  const written = await zxing.writeBarcode('012345678905', { format: 'UPCA', scale: 4, addQuietZones: true });
  const symbol = written.symbol, rgba = new Uint8ClampedArray(symbol.width * symbol.height * 4);
  for (let i = 0; i < symbol.data.length; i++) rgba.set([symbol.data[i], symbol.data[i], symbol.data[i], 255], i * 4);
  const app = fixture({ readBarcodes: (pixels, options) => zxing.readBarcodes(pixels, options) });
  Object.assign(app.imageData, { data: rgba, width: symbol.width, height: symbol.height });
  const result = app.api.scan(); await app.dialog().parts['[data-ms="camera"]'].onclick();
  assert.equal(await result, '0012345678905');
  const manual = app.api.scan(); app.manual('000012345678905');
  assert.equal(await manual, '000012345678905');
});

test('closing while camera permission is pending stops a late granted stream and cannot affect a new scan', async () => {
  const permission = deferred();
  const app = fixture({ getUserMedia: () => permission.promise });
  const first = app.api.scan(); const starting = app.dialog().parts['[data-ms="camera"]'].onclick();
  await tick(); assert.equal(app.requests.length, 1);
  app.api.close(); assert.equal(await first, null);
  const second = app.api.scan(); permission.resolve(app.stream()); await starting;
  assert.equal(app.tracks[0].stopped, 1); assert.equal(app.dialog().parts.video.srcObject, undefined);
  app.manual('new-session'); assert.equal(await second, 'new-session');
});

test('late decoder results are discarded after stopping, hiding, navigating or cancelling', async () => {
  const decoding = deferred(); const app = fixture({ readBarcodes: () => decoding.promise });
  const first = app.api.scan(); const starting = app.dialog().parts['[data-ms="camera"]'].onclick();
  await tick(); app.document.hidden = true; app.documentEvents.visibilitychange();
  assert.equal(app.tracks[0].stopped, 1);
  decoding.resolve([{ text: 'late', isValid: true }]); await starting;
  assert.equal(app.dialog().isConnected, true); assert.equal(app.timers.size, 0);
  app.documentEvents.click({ target: { closest: () => ({}) } }); assert.equal(await first, null);
  const second = app.api.scan(); app.windowEvents.pagehide(); assert.equal(await second, null);
  const third = app.api.scan(); app.dialog().listeners.cancel({ preventDefault() {} }); assert.equal(await third, null);
});

test('permission denial retains photo decoding and manual entry; selected images and QR creation stay local', async () => {
  let reads = 0;
  const app = fixture({ getUserMedia: async () => { throw Object.assign(Error('denied'), { name: 'NotAllowedError' }); }, readBarcodes: async () => { reads++; return [{ text: 'PHOTO-0007', isValid: true }]; } });
  const result = app.api.scan(); await app.dialog().parts['[data-ms="camera"]'].onclick();
  assert.match(app.dialog().parts['.ms-status'].textContent, /权限/);
  const input = app.dialog().parts.photo; input.files = [{ size: 1024 }];
  await input.onchange(); assert.equal(await result, 'PHOTO-0007'); assert.equal(reads, 1);
  assert.equal(app.urls.size, 0); assert.ok(app.revoked.length);
  const image = await app.api.createQr('label-text'); assert.equal(image.type, 'image/png');
  assert.equal(app.writes[0].options.addQuietZones, true);
  await assert.rejects(app.api.createQr(''), /二维码内容/);
  await assert.rejects(app.api.createQr('x'.repeat(4097)), /二维码内容/);
});

test('camera device, occupancy, policy and interrupted startup failures explain the cause without reporting a decoder failure', async () => {
  for (const [name, expected] of [
    ['NotFoundError', /未找到可用摄像头/],
    ['NotReadableError', /其他应用占用/],
    ['SecurityError', /安全策略.*相机权限/],
    ['OverconstrainedError', /不支持当前拍摄设置/],
    ['AbortError', /启动已中断/]
  ]) {
    const app = fixture({ getUserMedia: async () => { throw Object.assign(Error('device failure'), { name }); } });
    const result = app.api.scan(); await app.dialog().parts['[data-ms="camera"]'].onclick();
    const message = app.dialog().parts['.ms-status'].textContent;
    assert.equal(app.requests.length, 1); assert.match(message, expected); assert.doesNotMatch(message, /组件加载失败/);
    assert.equal(app.dialog().parts['[data-ms="camera"]'].disabled, false);
    app.manual('FALLBACK'); assert.equal(await result, 'FALLBACK');
  }
});

test('single-item Code128 labels produce a real decodable image and reject unsupported or oversized contents', async () => {
  const app = fixture(), text = 'LAB-20261017-000001';
  app.context.ZXingWASM.writeBarcode = (value, options) => {
    app.writes.push({ text: value, options }); return zxing.writeBarcode(value, options);
  };
  const image = await app.api.createBarcode(text);
  assert.ok(image instanceof Blob);
  const results = await zxing.readBarcodes(new Uint8Array(await image.arrayBuffer()), { formats: ['Code128'], maxNumberOfSymbols: 2 });
  assert.equal(results.length, 1); assert.equal(results[0].text, text); assert.equal(results[0].format, 'Code128');
  assert.equal(app.writes[0].options.addQuietZones, true); assert.equal(app.writes[0].options.addHRT, true);
  for (const value of ['', ' ', '瓶-0001', 'LAB\n0001', 'x'.repeat(129), null]) await assert.rejects(app.api.createBarcode(value), /1–128.*ASCII/);
  app.context.ZXingWASM.writeBarcode = async () => ({ image: new Blob(['boundary']), error: '' });
  assert.ok(await app.api.createBarcode('x'.repeat(128)) instanceof Blob);
  app.context.ZXingWASM.writeBarcode = async () => ({ error: 'encoding failed' });
  await assert.rejects(app.api.createBarcode(text), /条码生成失败/);
});

test('multiple visible codes do not select an arbitrary target and missing WASM keeps manual fallback', async () => {
  const app = fixture({ readBarcodes: async () => [{ text: 'A', isValid: true }, { text: 'B', isValid: true }] });
  const result = app.api.scan(); await app.dialog().parts['[data-ms="camera"]'].onclick();
  assert.match(app.dialog().parts['.ms-status'].textContent, /多个条码/);
  app.manual('chosen'); assert.equal(await result, 'chosen'); assert.equal(app.tracks[0].stopped, 1);
  const unavailable = fixture(); unavailable.context.WebAssembly = undefined;
  const fallback = unavailable.api.scan(); await unavailable.dialog().parts['[data-ms="camera"]'].onclick();
  assert.equal(unavailable.requests.length, 0); unavailable.manual('manual'); assert.equal(await fallback, 'manual');
});

test('the decoder script loads on demand from the pinned local URL and a load failure leaves manual entry usable', async () => {
  const app = fixture({ library: false });
  const result = app.api.scan(); const starting = app.dialog().parts['[data-ms="camera"]'].onclick();
  const script = app.nodes.find(node => node.tag === 'script');
  assert.equal(script.src, '/vendor/zxing-wasm/3.1.5/index.js');
  script.onerror(); await starting;
  assert.equal(app.requests.length, 0); assert.equal(app.timers.size, 0); assert.equal(script.isConnected, false);
  assert.match(app.dialog().parts['.ms-status'].textContent, /扫码组件加载失败/);
  assert.doesNotMatch(app.dialog().parts['.ms-status'].textContent, /相机权限未获允许|无法开启摄像头/);
  app.manual('offline-manual'); assert.equal(await result, 'offline-manual');
});
