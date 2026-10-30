'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const publicDir = path.join(__dirname, '../src/public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
function section(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'Test must execute the actual production section');
  return source.slice(start, end);
}
function workspace(dialogs = []) {
  const handlers = {}, messages = [];
  const window = { addEventListener: (name, handler) => { handlers[name] = handler; } };
  const document = { querySelectorAll: selector => selector === 'dialog' ? dialogs : [], querySelector: () => null };
  vm.runInNewContext(fs.readFileSync(path.join(publicDir, 'workspace.js'), 'utf8'), {
    window, document, toast: message => messages.push(message),
  });
  return { api: window.Workspace, handlers, messages };
}

test('shared status enhancement uses finite tones and leaves free text unchanged', () => {
  const values = ['草稿', '已提交', '已完成', '结果待确认', '不合格', '<img src=x>', '__proto__', '未识别业务状态'];
  const pills = values.map(textContent => ({ textContent, dataset: {} }));
  const root = { querySelectorAll: selector => selector === '.pill' ? pills : [] };
  workspace().api.enhance(root);
  assert.deepEqual(pills.map(node => node.dataset.tone), ['neutral', 'progress', 'done', 'warn', 'danger', 'neutral', 'neutral', 'neutral']);
  assert.deepEqual(pills.map(node => node.textContent), values);
});

test('generic uncertain workspaces block close, navigation and unload even when inputs are clean', () => {
  let closed = false;
  const dialog = { open: true, dataset: { wsUncertain: 'true' },
    classList: { contains: () => true }, querySelectorAll: () => [],
    close: () => { closed = true; } };
  const state = workspace([dialog]);
  assert.equal(state.api.close(dialog), false);
  assert.equal(state.api.guardLeave(), false);
  assert.equal(closed, false);
  assert.match(state.messages[0], /结果待确认/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  state.handlers.beforeunload(event);
  assert.equal(event.prevented, true);
});

function callWith(fetch) {
  const context = { fetch };
  vm.runInNewContext(section(app, 'const call=', 'const toast=') + '\nglobalThis.invoke=call;', context);
  return context.invoke;
}
test('HTTP helper preserves server unknown metadata without converting conflicts to unknown', async () => {
  const unknown = callWith(async () => ({ ok: false, status: 503, json: async () => ({
    error: '提交结果待确认', code: 'TRANSACTION_OUTCOME_UNKNOWN', uncertain: true,
  }) }));
  await assert.rejects(unknown('/api/records', { method: 'POST' }), error =>
    error.status === 503 && error.code === 'TRANSACTION_OUTCOME_UNKNOWN' && error.uncertain === true);
  const conflict = callWith(async () => ({ ok: false, status: 409, json: async () => ({ error: '版本冲突' }) }));
  await assert.rejects(conflict('/api/records/1', { method: 'PUT' }), error => error.status === 409 && error.uncertain === false);
});

test('lost or unreadable write responses are unknown while read failures remain ordinary', async () => {
  const write = callWith(async () => { throw new TypeError('connection lost'); });
  await assert.rejects(write('/api/records', { method: 'POST' }), error => error.uncertain === true);
  const read = callWith(async () => { throw new TypeError('connection lost'); });
  await assert.rejects(read('/api/records'), error => error.uncertain === undefined);
  const invalid = callWith(async () => ({ ok: true, json: async () => { throw new SyntaxError('incomplete body'); } }));
  await assert.rejects(invalid('/api/records', { method: 'POST' }), error => error.uncertain === true);
});

function recordForm(error) {
  let calls = 0, closed = 0;
  const save = { disabled: false }, editor = { dataset: {} };
  const nodes = { '#record-form': {}, '#record-error': {}, '#reload-record': {} };
  const input = { value: 'synthetic title', disabled: false };
  const target = { querySelector: () => save, querySelectorAll: () => [input] };
  const context = {
    $: selector => nodes[selector], C: { archives: { extra: [] } }, current: 'archives',
    editing: null, editor, FormData: class { get(name) { return name === 'title' ? 'synthetic title' : ''; } },
    window: { Workspace: { close() { closed++; } } }, toast() {}, async load() {},
    async call() { calls++; throw error; },
  };
  vm.runInNewContext(section(app, "$('#record-form').onsubmit=", "$('#reload-record').onclick="), context);
  return { nodes, save, input, editor, submit: () => nodes['#record-form'].onsubmit({ target, preventDefault() {} }),
    count: () => ({ calls, closed }) };
}
test('uncertain non-idempotent record saves keep inputs and cannot submit a second POST', async () => {
  const form = recordForm(Object.assign(new Error('response lost'), { uncertain: true }));
  await form.submit();
  assert.equal(form.editor.dataset.wsUncertain, 'true');
  assert.equal(form.editor.dataset.wsBusy, undefined);
  assert.equal(form.save.disabled, true);
  assert.equal(form.input.disabled, true);
  assert.equal(form.input.value, 'synthetic title');
  assert.equal(form.nodes['#reload-record'].hidden, true);
  assert.match(form.nodes['#record-error'].textContent, /可能已保存/);
  await form.submit();
  assert.deepEqual(form.count(), { calls: 1, closed: 0 });
});
test('definite version conflicts keep the existing explicit reload path available', async () => {
  const form = recordForm(Object.assign(new Error('version conflict'), { status: 409 }));
  await form.submit();
  assert.equal(form.editor.dataset.wsUncertain, undefined);
  assert.equal(form.save.disabled, false);
  assert.equal(form.nodes['#reload-record'].hidden, false);
  assert.match(form.nodes['#record-error'].textContent, /当前输入已保留/);
});

test('uncertain attachment upload preserves the selected file and blocks another upload', async () => {
  const file = { name: 'synthetic.pdf', type: 'application/pdf' };
  const input = { files: [file], value: 'synthetic-file', disabled: false };
  const detail = { dataset: {} }, readers = [];
  const nodes = { '#file': input, '#file-error': { focus() {} } };
  let calls = 0;
  const context = {
    $: selector => nodes[selector], selected: { id: 1 }, current: 'archives', detailSequence: 1, detail,
    FileReader: class {
      constructor() { readers.push(this); }
      readAsDataURL() { this.result = 'data:application/pdf;base64,c3ludGhldGlj'; this.pending = this.onload(); }
    },
    toast() {}, detailMatches: () => false, files: async () => {},
    async call() { calls++; throw Object.assign(new Error('response lost'), { uncertain: true }); },
  };
  vm.runInNewContext(section(app, "$('#file').onchange=", ';function csv()') + ';', context);
  input.onchange({ target: input });
  await readers[0].pending;
  assert.equal(detail.dataset.wsUncertain, 'true');
  assert.equal(detail.dataset.wsBusy, undefined);
  assert.equal(input.disabled, true);
  assert.equal(input.value, 'synthetic-file');
  assert.equal(input.files[0], file);
  assert.match(nodes['#file-error'].textContent, /文件可能已保存/);
  input.onchange({ target: input });
  assert.equal(calls, 1);
});

test('a failed attachment-list refresh does not turn a committed upload into a retry prompt', async () => {
  const file = { name: 'synthetic.pdf', type: 'application/pdf' }, readers = [];
  const input = { files: [file], value: 'synthetic-file', disabled: false }, detail = { dataset: {} };
  const nodes = { '#file': input, '#file-error': { focus() {} } };
  const context = {
    $: selector => nodes[selector], selected: { id: 1 }, current: 'archives', detailSequence: 1, detail,
    FileReader: class {
      constructor() { readers.push(this); }
      readAsDataURL() { this.result = 'data:application/pdf;base64,eA=='; this.pending = this.onload(); }
    },
    toast() {}, detailMatches: () => true, call: async () => ({}),
    files: async () => { throw new Error('refresh failed'); },
  };
  vm.runInNewContext(section(app, "$('#file').onchange=", ';function csv()') + ';', context);
  input.onchange({ target: input });
  await readers[0].pending;
  assert.equal(input.value, '');
  assert.equal(input.disabled, false);
  assert.equal(detail.dataset.wsUncertain, undefined);
  assert.match(nodes['#file-error'].textContent, /已上传成功.*勿重复上传/);
  assert.doesNotMatch(nodes['#file-error'].textContent, /^上传失败/);
});

test('global date filters have visible labels and preserve fetch query behavior', async () => {
  const source = fs.readFileSync(path.join(publicDir, 'datahub.js'), 'utf8');
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.value = ''; }
    appendChild(child) { this.children.push(child); return child; }
    insertBefore(child) { this.children.unshift(child); }
    setAttribute(key, value) { this[key] = value; }
  }
  const actions = new Node('div');
  const find = (node, id) => node.id === id ? node : node.children.map(child => find(child, id)).find(Boolean);
  const requests = [];
  let loads = 0;
  const context = {
    document: { createElement: tag => new Node(tag), querySelector: selector =>
      selector === '.header-tools' ? actions : selector.startsWith('#') ? find(actions, selector.slice(1)) : null },
    window: { fetch: async target => { requests.push(target); }, load: () => { loads++; } },
    C: { archives: {} }, current: 'archives', URL, location: { origin: 'http://127.0.0.1' },
  };
  vm.runInNewContext(section(source, 'function setupDateFilters()', 'setInterval(setupDateFilters,500)'), context);
  context.setupDateFilters();
  context.setupDateFilters();
  assert.equal(actions.children.length, 1);
  const range = actions.children[0];
  assert.equal(range.hidden, false);
  assert.equal(range.children[0].textContent, '开始日期');
  assert.equal(range.children[0].htmlFor, 'global-from');
  assert.equal(range.children[1].textContent, '至');
  assert.equal(range.children[2].textContent, '结束日期');
  const from = find(actions, 'global-from'), to = find(actions, 'global-to');
  from.value = '2026-10-01'; to.value = '2026-10-30';
  from.onchange();
  await context.window.fetch('/api/records?module=archives');
  assert.equal(loads, 1);
  assert.match(requests[0], /from=2026-10-01&to=2026-10-30/);
  await context.window.fetch('/api/materials/stock');
  assert.equal(requests[1], '/api/materials/stock');
});

test('generic empty states distinguish filtered results and never offer unauthorized creation', async () => {
  const nodes = { '#search': { value: '' }, '#global-from': { value: '' }, '#global-to': { value: '' } };
  let writes = true, loads = 0, opened = 0;
  const context = {
    $: selector => nodes[selector], current: 'templates', can: () => writes, window: {},
    clearTimeout() {}, load: async () => { loads++; }, openEditor: () => { opened++; },
  };
  vm.runInNewContext(section(app, 'function recordEmptyState()', 'function renderRecords()'), context);
  assert.match(context.recordEmptyState(), /record-empty-add/);
  writes = false;
  assert.doesNotMatch(context.recordEmptyState(), /record-empty-add|点击右上/);
  nodes['#global-from'].value = '2026-10-01';
  assert.match(context.recordEmptyState(), /没有符合条件.*record-empty-clear/);
  nodes['#search'].value = 'synthetic no match'; nodes['#global-to'].value = '2026-10-30';
  nodes['#record-empty-clear'] = {};
  context.bindRecordEmpty();
  await nodes['#record-empty-clear'].onclick();
  assert.equal(loads, 1);
  for (const selector of ['#search', '#global-from', '#global-to']) assert.equal(nodes[selector].value, '');
  delete nodes['#record-empty-clear'];
  writes = true;
  nodes['#record-empty-add'] = {};
  context.bindRecordEmpty();
  nodes['#record-empty-add'].onclick();
  assert.equal(opened, 1);
});
