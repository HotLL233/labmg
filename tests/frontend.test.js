const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { test } = require('node:test');

const publicDir = path.join(__dirname, '../src/public');
const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const scripts = [...index.matchAll(/<script src="\/([^"]+)"/g)].map(match => match[1]);
const decode = value => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[key]);

// The fixture models only DOM APIs used by these scripts; it does not replace browser layout or interaction QA.
class Element {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag; this.attrs = attrs; this.children = []; this.style = {}; this.dataset = {};
    this._html = ''; this._text = ''; this.open = false; this.disabled = 'disabled' in attrs;
    this.hidden = 'hidden' in attrs; this.checked = 'checked' in attrs;
    this.classes = new Set((attrs.class || '').split(/\s+/));
    this.classList = {
      add: key => this.classes.add(key), remove: key => this.classes.delete(key),
      toggle: (key, enabled) => enabled ? this.classes.add(key) : this.classes.delete(key)
    };
    for (const [name, value] of Object.entries(attrs)) {
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }
  }
  get id() { return this.attrs.id; }
  set id(value) { this.attrs.id = value; }
  get name() { return this.attrs.name; }
  set name(value) { this.attrs.name = value; }
  get elements() { return Object.fromEntries(this.querySelectorAll('[name]').map(node => [node.name, node])); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'select') {
      const option = this.children.find(node => 'selected' in node.attrs) || this.children[0];
      return option?.attrs.value ?? option?.textContent ?? '';
    }
    return this.attrs.value || '';
  }
  set value(value) { this._value = value; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = value; this.children = []; this._text = ''; parse(value, this); }
  set outerHTML(value) {
    const fragment = new Element(); parse(value, fragment);
    const position = this.parent.children.indexOf(this);
    this.parent.children.splice(position, 1, ...fragment.children);
    fragment.children.forEach(child => { child.parent = this.parent; });
  }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  append(child) { return this.appendChild(child); }
  remove() { if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1); }
  contains(node) { return node===this||this.children.some(child=>child.contains(node)); }
  addEventListener(type, handler) { (this.listeners ||= {})[type] = handler; }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; }
  insertBefore(child, before) {
    child.parent = this;
    const position = this.children.indexOf(before);
    this.children.splice(position < 0 ? this.children.length : position, 0, child);
  }
  insertAdjacentHTML(position, value) {
    const fragment = new Element(); parse(value, fragment);
    fragment.children.forEach(child => { child.parent = this; });
    if (position === 'afterbegin') this.children.unshift(...fragment.children);
    else this.children.push(...fragment.children);
    this._html += value;
  }
  querySelectorAll(selector) {
    if (selector.includes(',')) return [...new Set(selector.split(',').flatMap(part => this.querySelectorAll(part.trim())))];
    const matches = (node, simple) => {
      if (simple.endsWith(':checked')) return node.checked && matches(node, simple.slice(0, -8));
      const attr = simple.match(/^\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\]$/);
      if (attr) return attr[2] === undefined ? attr[1] in node.attrs : node.attrs[attr[1]] === attr[2];
      if (simple.startsWith('#')) return node.id === simple.slice(1);
      if (simple.startsWith('.')) return node.classes.has(simple.slice(1));
      const tagAttr = simple.match(/^(\w+)(\[.*\])$/);
      if (tagAttr) return node.tagName === tagAttr[1] && matches(node, tagAttr[2]);
      return node.tagName === simple;
    };
    const all = [];
    const visit = parent => parent.children.forEach(child => { all.push(child); visit(child); });
    visit(this);
    const parts = selector.split(/\s+/);
    return all.filter(node => {
      if (!matches(node, parts.at(-1))) return false;
      let parent = node.parent;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (parent && !matches(parent, parts[i])) parent = parent.parent;
        if (!parent) return false;
        parent = parent.parent;
      }
      return true;
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { return this.onclick?.(); }
}

function parse(html, parent) {
  const stack = [parent], token = /<\/?([a-z][\w-]*)([^>]*?)>/gi;
  let match, previous = 0;
  while ((match = token.exec(html))) {
    stack.at(-1)._text += decode(html.slice(previous, match.index));
    previous = token.lastIndex;
    const tag = match[1].toLowerCase();
    if (match[0].startsWith('</')) {
      if (stack.length > 1 && stack.at(-1).tagName === tag) stack.pop();
      continue;
    }
    const attrs = {};
    for (const item of match[2].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[item[1]] = decode(item[2] ?? item[3] ?? item[4] ?? '');
    }
    const node = stack.at(-1).appendChild(new Element(tag, attrs));
    if (!['input', 'link', 'meta', 'br', 'img', 'hr'].includes(tag)) stack.push(node);
  }
  stack.at(-1)._text += decode(html.slice(previous));
}

async function browser(user = { role: 'ADMIN', permissions: ['*'] }, auth = {}) {
  const document = new Element('document'); parse(index, document);
  document.head = document.querySelector('head'); document.body = document.querySelector('body');
  document.createElement = tag => new Element(tag);
  document.getElementById = id => document.querySelector('#' + id);
  const modules = ['archives', 'assets', 'quality', 'contracts', 'materials', 'finance', 'templates', 'people'];
  const records = modules.map((module, i) => ({
    id: i + 1, module, version: 4, title: `${module}-record`, code: module, category: '', status: '合格',
    owner: 'tester', amount: 123, quantity: 2, due_date: '', created_at: '2026-10-16', updated_at: '2026-10-16',
    data: { asset_stage: '检定/校准', quality_section: '质量手册', is_current: '是', material_type: '试剂', flow: '库存台账', access_roles: user?.role || 'ADMIN', retained: 'keep' }
  }));
  records.push({ ...structuredClone(records[1]), id: 20, title: 'active-device', data: { asset_stage: '投入使用' } });
  const requests = [], timers = new Map();
  const state = { conflict: false, hold: null, auth: { user, setupRequired: false, setupUsername: 'admin', ...auth }, authError: null, authHold: null, permissionData: null,
    materialOpeningClosed: false, materialCapabilities: { createRequest: true }, materialDetails: {}, materialAcceptance: [], materialLists: {}, materialResponse: null,
    materialRequests: [{ id: 101, no: 'WZ-HTTP-101', title: '专用申报单', creatorName: 'tester', itemCount: 1, createdAt: '2026-10-17', status: 'draft', revision: 0 }] };
  const nav = ['dashboard', ...modules, 'management', 'audit', 'datahub', 'trash'].map(target => ({ key: target, target, label: target, icon: '', description: '', visible: 1, sort_order: 0 }));
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(value), blob: async () => new Blob([JSON.stringify(value)]) });
  const fetch = async (input, options = {}) => {
    const url = new URL(input, 'http://localhost'), method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method, body });
    if (url.pathname.startsWith('/api/materials/') && state.materialResponse) {
      const result = await state.materialResponse({ url, method, body });
      if (result !== undefined) return response(result.body, result.status || 200);
    }
    if (url.pathname === '/api/auth/me') return response(state.auth);
    if (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/setup') {
      if (state.authHold) {
        const hold = state.authHold; state.authHold = null;
        await new Promise(resolve => { hold.release = resolve; });
      }
      if (state.authError) {
        const error = state.authError; state.authError = null;
        if (error.status === 409) state.auth.setupRequired = false;
        return response({ error: error.message }, error.status);
      }
      state.auth.user ||= { role: 'ADMIN', permissions: ['*'] };
      state.auth.setupRequired = false;
      return response({ user: state.auth.user }, url.pathname === '/api/auth/setup' ? 201 : 200);
    }
    if (url.pathname === '/api/ui-config/nav') return response(nav);
    if (url.pathname === '/api/ui-config/dashboard') return response(modules.map(target => ({ key: target, kind: 'module', target, label: target, visible: 1, sort_order: 0 })));
    if (url.pathname === '/api/dashboard') return response({ totals: {}, finance: { income: 0, expense: 0 }, warnings: 0 });
    if (url.pathname === '/api/permissions') return response(state.permissionData || { catalog: [], roles: [{ role: state.auth.user.role, permissions: state.auth.user.permissions }], roleNames: {}, sections: {} });
    if (url.pathname === '/api/users') return response([{ id: 1, display_name: "O'Brien <img src=x onerror=alert(1)>", username: 'fixture', role: state.auth.user.role }]);
    if (url.pathname === '/api/materials/meta') return response({ capabilities: state.materialCapabilities, warehouses: [{ code: 'MAIN', name: '默认仓库' }], openingClosed: state.materialOpeningClosed });
    if (url.pathname === '/api/materials/requests') return response({ items: state.materialRequests, total: state.materialRequests.length, page: 1, pageSize: 50 });
    if (/^\/api\/materials\/requests\/\d+$/.test(url.pathname)) return response(state.materialDetails[Number(url.pathname.split('/').at(-1))]);
    if (url.pathname === '/api/materials/acceptance') return response({ items: state.materialAcceptance, total: state.materialAcceptance.length, page: 1, pageSize: 50 });
    if (['/api/materials/categories', '/api/materials/regions', '/api/materials/catalog', '/api/materials/stock', '/api/materials/stock/batches', '/api/materials/stock/units', '/api/materials/stock/movements', '/api/materials/receipts', '/api/materials/issues', '/api/materials/openings'].includes(url.pathname)) {
      const entries = state.materialLists[url.pathname.slice('/api/materials'.length)] || [];
      return response({ items: entries, total: entries.length, page: 1, pageSize: Number(url.searchParams.get('pageSize')) || 50 });
    }
    if (url.pathname === '/api/records' && method === 'GET') {
      const module = url.searchParams.get('module'), q = url.searchParams.get('q') || '';
      const result = response(records.filter(row => row.module === module && row.title.includes(q)));
      if (state.hold?.module === module) {
        const hold = state.hold; state.hold = null;
        await new Promise(resolve => { hold.release = resolve; });
      }
      return result;
    }
    if (url.pathname === '/api/records' && method === 'POST') {
      const row = { ...body, id: records.length + 30, version: 1, created_at: '2026-10-16', updated_at: '2026-10-16' };
      records.push(row); return response(row, 201);
    }
    const id = Number(url.pathname.match(/^\/api\/records\/(\d+)$/)?.[1]);
    if (id) {
      const position = records.findIndex(row => row.id === id), row = records[position];
      if (method === 'DELETE') { records.splice(position, 1); return response({ ok: true }); }
      if (state.conflict) { state.conflict = false; row.version++; row.title = 'other-user-change'; return response({ error: '记录已被其他用户修改，请重新加载' }, 409); }
      assert.equal(body.version, row.version, 'PUT must carry the version from the loaded record');
      Object.assign(row, body, { version: row.version + 1 }); return response(row);
    }
    return response([]);
  };
  class FormData {
    constructor(form) { this.entries = form.querySelectorAll('[name]').filter(node => !node.disabled).map(node => [node.name, node.value]); }
    get(name) { return this.entries.find(entry => entry[0] === name)?.[1] ?? null; }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  }
  const context = {
    document, fetch, FormData, URL, URLSearchParams, Blob, Date, console, crypto, location: { origin: 'http://localhost', reload() {} },
    confirm: () => true, prompt: () => null, addEventListener() {}, removeEventListener() {},
    setTimeout(callback, delay) { const id = Symbol(); timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval() {},
    editor: document.querySelector('#editor'), detail: document.querySelector('#detail'), login: document.querySelector('#login')
  };
  context.window = context; vm.createContext(context);
  const run = code => vm.runInContext(code, context);
  scripts.forEach(file => vm.runInContext(fs.readFileSync(path.join(publicDir, file), 'utf8'), context, { filename: file }));
  await run('start()');
  return {
    run, document, requests, records, state, context,
    $: selector => document.querySelector(selector),
    async timers(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); await timer.callback(); } },
    async submit(title) {
      document.querySelector('[name=title]').value = title;
      await document.querySelector('#record-form').onsubmit({ preventDefault() {}, target: document.querySelector('#record-form') });
    },
    async authenticate(values) {
      for (const [name, value] of Object.entries(values)) document.querySelector(`#login-form [name=${name}]`).value = value;
      await document.querySelector('#login-form').onsubmit({ preventDefault() {}, target: document.querySelector('#login-form') });
    }
  };
}

test('first launch creates an administrator once and clears passwords before entering', async () => {
  const app = await browser(null, { setupRequired: true, setupUsername: 'lab-admin' });
  assert.equal(app.context.login.open, true);
  assert.equal(app.$('#auth-title').textContent, '首次设置管理员');
  assert.equal(app.$('#auth-username').value, 'lab-admin');
  assert.equal(app.$('#auth-password').value, '');
  assert.equal(app.$('#auth-password').autocomplete, 'new-password');
  assert.equal(app.$('#auth-password').minLength, 8);
  assert.equal(app.$('#auth-confirm-field').hidden, false);
  assert.equal(app.$('#auth-password-confirm').disabled, false);
  assert.equal(app.$('.layout'), null);
  let cancelled = false;
  app.context.login.oncancel({ preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true);
  assert.equal(app.context.login.open, true);

  const hold = {}; app.state.authHold = hold;
  const values = { username: 'lab-admin', password: 'MyFirstPassword!9', passwordConfirm: 'MyFirstPassword!9' };
  const pending = app.authenticate(values);
  assert.equal(app.$('#auth-submit').disabled, true);
  await app.authenticate(values);
  assert.equal(app.requests.filter(request => request.url.pathname === '/api/auth/setup').length, 1);
  hold.release(); await pending;
  const setup = app.requests.find(request => request.url.pathname === '/api/auth/setup');
  assert.deepEqual(setup.body, values);
  assert.equal(setup.method, 'POST');
  assert.equal(app.context.login.open, false);
  assert.equal(app.$('#auth-password').value, '');
  assert.equal(app.$('#auth-password-confirm').value, '');
  assert.equal(app.$('#auth-submit').disabled, false);
  assert.equal(app.run('currentUser.role'), 'ADMIN');
  assert.ok(app.$('.layout'));
});

test('setup validates password length and confirmation and preserves rejected inputs', async () => {
  const app = await browser(null, { setupRequired: true });
  for (const [values, message] of [
    [{ username: '   ', password: 'ValidPass!9', passwordConfirm: 'ValidPass!9' }, /请输入账号/],
    [{ username: 'admin', password: 'short', passwordConfirm: 'short' }, /8–1024/],
    [{ username: 'admin', password: 'x'.repeat(1025), passwordConfirm: 'x'.repeat(1025) }, /8–1024/],
    [{ username: 'admin', password: 'ValidPass!9', passwordConfirm: 'different' }, /不一致/]
  ]) {
    await app.authenticate(values);
    assert.match(app.$('#auth-error').textContent, message);
    assert.equal(app.$('#auth-error').hidden, false);
    assert.equal(app.$('#auth-password').value, values.password);
  }
  assert.equal(app.requests.filter(request => request.method === 'POST').length, 0);
  app.state.authError = { status: 400, message: '账号格式无效' };
  await app.authenticate({ username: 'admin', password: 'ValidPass!9', passwordConfirm: 'ValidPass!9' });
  assert.equal(app.$('#auth-error').textContent, '账号格式无效');
  assert.equal(app.$('#auth-password').value, 'ValidPass!9');
  assert.equal(app.$('#auth-password-confirm').value, 'ValidPass!9');
  assert.equal(app.context.login.open, true);
  assert.equal(app.$('#auth-submit').disabled, false);
  assert.equal(app.$('.layout'), null);
});

test('existing users keep normal login with short legacy passwords and no default password', async () => {
  const app = await browser(null);
  assert.doesNotMatch(index, /admin123/);
  assert.equal(app.$('#auth-title').textContent, '登录 LabOS');
  assert.equal(app.$('#auth-password').value, '');
  assert.equal(app.$('#auth-password').autocomplete, 'current-password');
  assert.equal(app.$('#auth-password').minLength, 0);
  assert.equal(app.$('#auth-confirm-field').hidden, true);
  assert.equal(app.$('#auth-password-confirm').disabled, true);
  app.state.authError = { status: 401, message: '用户名或密码错误' };
  await app.authenticate({ username: 'legacy', password: 'old' });
  assert.equal(app.context.login.open, true);
  assert.equal(app.$('#auth-password').value, 'old');
  assert.equal(app.$('#auth-error').textContent, '用户名或密码错误');
  await app.authenticate({ username: 'legacy', password: 'old' });
  const login = app.requests.findLast(request => request.url.pathname === '/api/auth/login');
  assert.deepEqual(login.body, { username: 'legacy', password: 'old' });
  assert.equal(app.requests.some(request => request.url.pathname === '/api/auth/setup'), false);
  assert.equal(app.context.login.open, false);
  assert.equal(app.$('#auth-password').value, '');
});

test('setup contention refreshes state into normal login without authenticating the losing page', async () => {
  const app = await browser(null, { setupRequired: true });
  app.state.auth.user = { role: 'ADMIN', permissions: ['*'] };
  app.state.authError = { status: 409, message: '管理员已设置' };
  await app.authenticate({ username: 'admin', password: 'Uncommitted!9', passwordConfirm: 'Uncommitted!9' });
  assert.equal(app.requests.filter(request => request.url.pathname === '/api/auth/me').length, 2);
  assert.equal(app.$('#auth-title').textContent, '登录 LabOS');
  assert.equal(app.$('#auth-confirm-field').hidden, true);
  assert.equal(app.$('#auth-password-confirm').disabled, true);
  assert.equal(app.$('#auth-password').minLength, 0);
  assert.equal(app.$('#auth-password').value, 'Uncommitted!9');
  assert.match(app.$('#auth-error').textContent, /其他页面完成设置/);
  assert.equal(app.context.login.open, true);
  assert.equal(app.$('#auth-submit').disabled, false);
  assert.equal(app.run('currentUser'), null);
  assert.equal(app.$('.layout'), null);
  assert.equal(app.requests.some(request => request.url.pathname === '/api/ui-config/nav'), false);
});

test('actual script order keeps shared state and correct CRUD payloads across business modules', async () => {
  const app = await browser();
  assert.deepEqual(scripts, ['app.js', 'material-scan.js', 'material-labels.js', 'material.js', 'permission.js', 'archive.js', 'audit.js', 'datahub.js', 'asset.js', 'contract.js', 'quality.js']);
  for (const module of ['archives', 'assets', 'quality', 'contracts', 'finance', 'templates', 'people']) {
    await app.run(`go('${module}')`);
    const id = app.records.find(row => row.module === module).id;
    assert.equal(app.run('current'), module);
    assert.ok(app.run('items.every(row=>row.module===current)'));
    await app.run(`show(${id})`);
    assert.equal(app.$('#detail-title').textContent, `${module}-record`);
    app.context.detail.close();
    app.run(`openEditor(${id})`);
    assert.equal(app.$('[name=title]').value, `${module}-record`);
    await app.submit(`${module}-edited`);
    const update = app.requests.findLast(request => request.method === 'PUT');
    assert.equal(update.body.module, module);
    assert.equal(update.body.version, 4);
    assert.equal(update.body.data.retained, 'keep');
    assert.equal(update.body.amount, module === 'finance' ? '123' : 123);
    assert.equal(app.run('current'), module);
    assert.equal(app.context.editor.open, false);
    app.run('openEditor()');
    assert.match(app.$('#edit-title').textContent, /^新建/);
    await app.submit(`${module}-created`);
    const create = app.requests.findLast(request => request.method === 'POST');
    assert.equal(create.body.module, module);
    assert.equal('version' in create.body, false);
    assert.equal(app.run('current'), module);
    await app.run(`del(${id})`);
    assert.equal(app.run('current'), module);
    assert.equal(app.run(`items.some(row=>row.id===${id})`), false);
  }
});

test('materials uses its authenticated workflow API and blocks the generic record editor for every logged-in role', async () => {
  const app = await browser({ role: 'FINANCE', permissions: ['dashboard.read', 'finance.read'] });
  assert.ok(app.$('[data-nav=materials]'), 'all authenticated users need the declaration entry');
  await app.run("go('materials')");
  assert.equal(app.run('current'), 'materials');
  assert.equal(app.run('items.length'), 0);
  assert.match(app.$('#page').innerHTML, /专用申报单/);
  assert.ok(app.requests.some(request => request.url.pathname === '/api/materials/meta'));
  assert.ok(app.requests.some(request => request.url.pathname === '/api/materials/requests'));
  assert.equal(app.requests.some(request => request.url.pathname === '/api/records' && request.url.searchParams.get('module') === 'materials'), false);
  assert.equal(app.$('#add').style.display, 'none');
  app.run('openEditor()');
  assert.equal(app.context.editor.open, false);
  assert.match(app.$('#toast').textContent, /物资申报/);
});

test('search, date filters, equipment stages and return navigation use the same loader', async () => {
  const app = await browser();
  await app.run("go('assets')");
  assert.equal(app.run("assetRows('calibration').length"), 1);
  assert.equal(app.run("assetRows('active').length"), 1);
  assert.match(app.$('#page').innerHTML, /data-astage="calibration"><b>检定\/校准<\/b><small>1<\/small>/);
  app.$('#search').value = 'active'; app.$('#search').oninput(); await app.timers(250);
  assert.equal(app.run('items.length'), 1);
  assert.equal(app.run('items[0].title'), 'active-device');
  app.run("assetStage='active'"); await app.run('load()');
  assert.equal(app.run("assetRows('active').length"), 1);
  app.run('openEditor(20)'); await app.submit('active-device-edited');
  assert.equal(app.$('#search').value, 'active');
  assert.equal(app.run('assetStage'), 'active');
  assert.equal(app.run('items.length'), 1);
  await app.run("go('quality')");
  assert.equal(app.$('#search').value, '');
  assert.equal(app.run('items[0].module'), 'quality');
  await app.run("go('assets')");
  assert.equal(app.run('items.length'), 2);
  app.run('setupDateFilters()');
  app.$('#global-from').value = '2026-10-01'; await app.$('#global-from').onchange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.requests.findLast(request => request.url.pathname === '/api/records').url.searchParams.get('from'), '2026-10-01');
  await app.run("go('management')");
  await app.run("openManagementSection('datahub')");
  assert.equal(app.run('current'), 'datahub');
  await app.$('#management-back').onclick();
  assert.equal(app.run('current'), 'management');
});

test('late list responses cannot replace a newer module or search', async () => {
  const app = await browser();
  const held = { module: 'archives' }; app.state.hold = held;
  const pending = app.run("go('archives')");
  await app.run("go('contracts')");
  held.release(); await pending;
  assert.equal(app.run('current'), 'contracts');
  assert.equal(app.run('items[0].module'), 'contracts');
  assert.ok(app.$('#add-contract'));
  await app.run("go('assets')");
  const oldSearch = { module: 'assets' }; app.state.hold = oldSearch;
  app.$('#search').value = 'assets'; const oldResult = app.run('load()');
  app.$('#search').value = 'active'; await app.run('load()');
  oldSearch.release(); await oldResult;
  assert.equal(app.run('items.length'), 1);
  assert.equal(app.run('items[0].title'), 'active-device');
});

test('409 retains inputs and original version until the user explicitly reloads', async () => {
  const app = await browser();
  await app.run("go('quality')"); app.run('openEditor(3)');
  app.state.conflict = true; await app.submit('my-unsaved-quality');
  assert.equal(app.context.editor.open, true);
  assert.equal(app.$('[name=title]').value, 'my-unsaved-quality');
  assert.equal(app.run('editing.version'), 4);
  assert.equal(app.$('#record-error').hidden, false);
  assert.match(app.$('#record-error').textContent, /当前输入已保留/);
  assert.equal(app.$('#reload-record').hidden, false);
  await app.$('#reload-record').onclick();
  assert.equal(app.$('[name=title]').value, 'other-user-change');
  assert.equal(app.run('editing.version'), 5);
  await app.submit('merged-quality');
  assert.equal(app.requests.findLast(request => request.method === 'PUT').body.version, 5);
});

test('server-provided permissions hide inaccessible modules and record mutations', async () => {
  const app = await browser({ role: 'TESTER', permissions: ['dashboard.read', 'archives.read'] });
  assert.equal(app.$('[data-nav=assets]'), null);
  assert.equal(app.$('[data-nav=management]'), null);
  assert.doesNotMatch(app.$('#page').innerHTML, /data-go="assets"/);
  await app.run("go('archives')");
  assert.equal(app.$('#add').style.display, 'none');
  assert.ok(app.$('[data-permission="archives.write"]').hidden);
  app.run('openEditor(1)'); assert.equal(app.context.editor.open, false);
  await app.run("go('assets')"); assert.equal(app.run('current'), 'archives');
  const writer = await browser({ role: 'TESTER,QUALITY', permissions: ['archives.read', 'archives.write'] });
  writer.run('openEditor()');
  assert.equal(writer.$('[name=data_access_roles]').value, 'TESTER,QUALITY');
  await writer.submit('my-archive');
  assert.equal(writer.requests.findLast(request => request.method === 'POST').body.data.access_roles, 'TESTER,QUALITY');
});

test('business section choices submit the matching scope for a limited writer', async () => {
  for (const [module, section, fieldName, value, label] of [
    ['templates', 'maintenance', 'section', 'maintenance', '维护保养'],
    ['people', 'certificate', 'section', 'certificate', '证书资质'],
    ['finance', 'budget', 'direction', '预算', '预算']
  ]) {
    const app = await browser({ role: 'SCOPED', permissions: [`${module}.read`, `${module}.write`, `${module}.${section}.read`, `${module}.${section}.write`] });
    await app.run(`go('${module}')`);
    app.run('openEditor()');
    const choice = app.$(`[name=data_${fieldName}]`);
    assert.ok(choice.children.some(option => option.value === value && option.textContent === label));
    choice.value = value;
    await app.submit(`${module}-scoped`);
    const create = app.requests.findLast(request => request.method === 'POST');
    assert.equal(create.body.data[fieldName], value);
    const created = app.records.find(row => row.title === `${module}-scoped`);
    app.run(`openEditor(${created.id})`);
    assert.equal(app.$(`[name=data_${fieldName}]`).value, value);
    await app.submit(`${module}-scoped-edited`);
    assert.equal(app.requests.findLast(request => request.method === 'PUT').body.data[fieldName], value);
  }
});

test('read-only management keeps role, account, navigation and dashboard write controls hidden', async () => {
  const app = await browser({ role: 'AUDITOR', permissions: ['permissions.read'] });
  await app.run("go('management')");
  app.run('renderRoles()');
  assert.equal(app.$('#create-role').hidden, true);
  assert.equal(app.$('#save-permissions').hidden, true);
  app.run('renderNavSettings()');
  assert.equal(app.$('#save-nav-order').hidden, true);
  assert.equal(app.$('#nav-form').hidden, true);
  assert.ok(app.document.querySelectorAll('[data-permission="permissions.write"]').every(node => node.hidden));
  await app.run('renderDashboardSettings()');
  assert.equal(app.$('#save-dashboard-order').hidden, true);
  app.run('renderAccounts()');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.$('#user-form').hidden, true);
  assert.equal(app.$('[data-edit-user=1]').hidden, true);
});

test('permission saves filter wildcard controls through the catalog and preserve selected material permissions', async () => {
  const app = await browser();
  const materialPermissions = Array.from(app.run('Object.keys(MATERIAL_PERMISSION_LABELS)'));
  const catalog = ['dashboard.read', 'permissions.read', 'permissions.write', 'materials.read', 'backup.read', ...materialPermissions];
  const selected = ['materials.read', 'materials.amount.read', 'materials.export', 'materials.request.edit_submitted'];
  app.state.permissionData = { catalog, roles: [{ role: 'ADMIN', permissions: ['*'] }, { role: 'MATERIAL_REVIEWER', permissions: selected }], roleNames: {}, sections: {} };
  await app.run("go('management')");
  app.run('renderRoles()');
  assert.equal(app.$('[data-perm="dashboard.write"]').checked, true, 'wildcard fixture must include an invalid checked control');
  await app.$('#save-permissions').click();
  const adminSave = app.requests.findLast(request => request.method === 'PUT');
  assert.equal(adminSave.url.pathname, '/api/permissions/roles/ADMIN');
  assert.deepEqual(adminSave.body.permissions.slice().sort(), catalog.slice().sort());
  assert.ok(adminSave.body.permissions.every(permission => catalog.includes(permission)));
  app.run("showRolePermission('MATERIAL_REVIEWER')");
  await app.$('#save-permissions').click();
  const customSave = app.requests.findLast(request => request.method === 'PUT');
  assert.equal(customSave.url.pathname, '/api/permissions/roles/MATERIAL_REVIEWER');
  assert.deepEqual(customSave.body.permissions.slice().sort(), selected.slice().sort());
});

test('user-controlled fields and account names stay out of executable markup', async () => {
  const app = await browser();
  const html = app.run(`field('x" autofocus onfocus="alert(1)', '<img src=x onerror=alert(1)>', 'text" onfocus="alert(1)', ['<img>'])`);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&quot;/);
  const option = app.run(`field('choice', 'label', 'select', ['<img src=x>'])`);
  assert.doesNotMatch(option, /<img/);
  const namedOption = app.run(`field('choice', 'label', 'select', [['x" onfocus="alert(1)', '<img src=x>']])`);
  assert.doesNotMatch(namedOption, /<img|value="x" onfocus=/);
  assert.match(namedOption, /&quot;/);
  app.state.materialRequests[0].title = '<img src=x onerror=alert(1)><svg onload=alert(1)>';
  await app.run("go('materials')");
  assert.doesNotMatch(app.$('#page').innerHTML, /<img|<svg/);
  assert.match(app.$('#page').innerHTML, /&lt;img/);
  await app.run("go('management')"); app.run('renderAccounts()');
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(app.$('#page').innerHTML, /onclick="editUser|<img/);
  assert.ok(app.$('[data-edit-user=1]'));
  let edited;
  app.context.editUser = (...args) => { edited = args; };
  app.$('[data-edit-user=1]').onclick();
  assert.equal(edited[1], "O'Brien <img src=x onerror=alert(1)>");
});

test('unlinked request items remain neutral and authorized users complete their identity during receipt or closure', async () => {
  const app = await browser({ role: 'MATERIAL', permissions: ['materials.read', 'materials.request.submit', 'materials.acceptance.write'] });
  const free = { id: 11, requestId: 101, catalogId: null, name: '新物资', spec: '新规格', unit: '件', qtyM: 1000, remainingQtyM: 1000, acceptedQtyM: 0, closedQtyM: 0, receiptStatus: 'pending', canEdit: true };
  const bound = { ...free, id: 12, catalogId: 5, name: '已有物资' };
  const request = { ...app.state.materialRequests[0], version: 1, canSubmit: true, canAddItem: true, items: [free, bound] };
  app.state.materialDetails[101] = request;
  app.state.materialCapabilities = { createRequest: true, receive: true, closeReceipt: true };
  const click = node => app.document.listeners.click({ target: { closest: () => node } });
  await app.run("go('materials')"); await click(app.$('[data-mw=request]'));
  assert.match(app.$('#page').textContent, /共 1 项验收时再完善物资信息/);
  assert.doesNotMatch(app.$('#page').innerHTML, /mw-badge amber">待匹配/); assert.ok(app.$('[data-mw=submit]'));
  await click(app.$('[data-mw=add-item]'));
  assert.equal('required' in app.$('#mw-fields [name=catalogId]').attrs, false);
  for (const name of ['spec', 'unit']) assert.equal('required' in app.$('#mw-fields [name='+name+']').attrs, true);
  assert.match(app.$('#mw-fields').textContent, /检索已有物资（选填）/);
  await click(app.$('[data-mw=cancel]')); await click(app.$('[data-mw=submit]'));
  assert.match(app.$('#mw-intro').textContent, /2 项，其中 1 项验收时再完善物资信息/);
  assert.doesNotMatch(app.$('#mw-intro').textContent, /原单修订匹配/);
  await click(app.$('[data-mw=cancel]'));
  Object.assign(request, { status: 'submitted', revision: 1, canSubmit: false, canAddItem: false }); app.state.materialAcceptance = [free, bound];
  await click({ dataset: { mw: 'page', page: 'acceptance' } });
  for (const action of ['receive', 'close-item']) {
    const buttons = app.document.querySelectorAll('[data-mw='+action+']'); assert.equal(buttons.length, 2); assert.equal(buttons[0].disabled, false); assert.equal(buttons[1].disabled, false);
    await click(buttons[0]); assert.equal(app.$('#mw-dialog').open, true); assert.ok(app.$('#mw-fields [name=catalogId]'));
    assert.equal(app.$('#mw-receipt-catalog').hidden, true); await click(app.$('[data-mw=cancel]'));
  }
  assert.equal(app.requests.some(entry => entry.method === 'POST' || entry.method === 'PATCH'), false);
});

async function materialApp(manager = true) {
  const app = await browser({ id: 1, role: manager ? 'MATERIAL' : 'USER', permissions: [] });
  app.state.materialCapabilities = { createRequest: true, createIssue: true, viewAmount: manager, manageCatalog: manager, receive: manager, manageLocation: manager, issueStock: manager, adjustStock: manager, submitRequest: manager, initialize: manager, export: manager };
  const row = { catalogId: 5, code: 'MAT-5', name: '合成物资', spec: '测试规格', unit: '件', categoryId: 1, categoryName: '合成分类', regionId: 2, regionName: '合成区域', warehouse: 'MAIN', batch: '', expiryDate: '', location: '', locationVersion: 1, qtyM: 10000, amountCents: 1000, lastMovementAt: '2026-10-17T01:02:03Z' };
  Object.assign(app.state.materialLists, { '/categories': [{ id: 1, name: row.categoryName }], '/regions': [{ id: 2, name: row.regionName }], '/catalog': [{ ...row, id: row.catalogId }], '/stock': [row], '/stock/batches': [row] });
  const item = { ...row, id: 11, requestId: 101, qtyM: 10000, acceptedQtyM: 0, closedQtyM: 0, remainingQtyM: 10000, receiptStatus: 'pending', version: 1, canEdit: true };
  const request = { ...app.state.materialRequests[0], status: 'draft', version: 1, canEditHeader: true, canAddItem: true, canSubmit: manager, items: [item] };
  app.state.materialDetails[101] = request;
  const click = node => app.document.listeners.click({ target: { closest: () => typeof node === 'string' ? app.$(node) : node } });
  const fill = values => { for (const [name, value] of Object.entries(values)) app.$(`#mw-fields [name=${name}]`).value = value; };
  const submit = () => app.$('#mw-form').listeners.submit({ preventDefault() {}, target: app.$('#mw-form') });
  await app.run("go('materials')");
  return { app, row, item, request, click, fill, submit };
}

test('batch balances preserve exact empty or quoted batch filters through movement pagination and reject stale row actions', async () => {
  const { app, row, click } = await materialApp();
  const quoted = { ...row, batch: 'LOT"<&', location: '<img src=x onerror=alert(1)>', expiryDate: '2027-01-01' };
  app.state.materialResponse = ({ url, method }) => method === 'GET' && ['/api/materials/stock/batches', '/api/materials/stock/movements'].includes(url.pathname)
    ? { body: { items: url.pathname.endsWith('/batches') ? [row, quoted] : [], total: 101, page: Number(url.searchParams.get('page')), pageSize: 50 } } : undefined;
  await click({ dataset: { mw: 'page', page: 'inventory' } });
  await click('[data-mw=batches]');
  assert.equal(app.$('#mw-view img'), null);
  assert.match(app.$('#mw-view-body').textContent, /存放位置/);
  const stale = app.$('[data-mw=location]');
  await click(app.document.querySelectorAll('[data-mw=batches]').find(node => node.dataset.historyPage === '2'));
  assert.equal(app.requests.at(-1).url.searchParams.get('page'), '2');
  await click(stale);
  assert.match(app.$('#mw-status').textContent, /批次列表已变化/);
  await click(app.document.querySelectorAll('[data-mw=batch-movements]')[0]);
  let query = app.requests.at(-1).url.searchParams;
  assert.equal(query.has('batch'), true); assert.equal(query.get('batch'), '');
  assert.equal(query.has('expiryDate'), true); assert.equal(query.get('expiryDate'), '');
  await click(app.document.querySelectorAll('[data-mw=movements]').find(node => node.dataset.historyPage === '2'));
  query = app.requests.at(-1).url.searchParams;
  assert.equal(query.get('page'), '2'); assert.equal(query.get('batch'), ''); assert.equal(query.get('expiryDate'), '');
  await click('[data-mw=batches]');
  await click(app.document.querySelectorAll('[data-mw=batch-movements]')[1]);
  assert.equal(app.requests.at(-1).url.searchParams.get('batch'), quoted.batch);
  assert.equal(app.requests.at(-1).url.searchParams.get('expiryDate'), quoted.expiryDate);
});

test('ordinary users request stock once, retry a lost response with the same body and key, then cancel their pending request', async () => {
  const { app, row, click, fill, submit } = await materialApp(false);
  const issue = { ...row, id: 21, version: 1, qtyM: 2000, amountCents: 0, snapshot: row, purpose: '合成领用用途', status: 'pending', creatorName: '申请人', canCancel: true, canIssue: false, canReject: false };
  const sends = []; let release;
  app.state.materialResponse = async ({ url, method, body }) => {
    if (url.pathname === '/api/materials/issues' && method === 'POST') {
      sends.push(body);
      if (sends.length === 1) { await new Promise(resolve => { release = resolve; }); throw Error('synthetic lost response'); }
      app.state.materialLists['/issues'] = [issue]; return { body: { issue }, status: 200 };
    }
    if (url.pathname === '/api/materials/issues/21' && method === 'GET') return { body: { issue } };
    if (url.pathname === '/api/materials/issues/21/cancel') { assert.equal(body.version, 1); assert.equal(body.reason, '不再需要'); assert.ok(body.requestIdempotencyKey); issue.status = 'cancelled'; issue.canCancel = false; return { body: { issue } }; }
  };
  await click({ dataset: { mw: 'page', page: 'inventory' } }); await click('[data-mw=batches]');
  assert.equal(app.$('[data-mw=location]'), null);
  await click('[data-mw=issue-create]'); fill({ quantity: '2', purpose: issue.purpose });
  assert.equal(app.$('#mw-fields [name=amount]'), null);
  assert.match(app.$('#mw-intro').textContent, /申请不预占库存/);
  const first = submit(); await new Promise(setImmediate); await submit(); assert.equal(sends.length, 1);
  release(); await first;
  assert.equal(app.$('#mw-fields [name=quantity]').disabled, true);
  assert.equal(app.$('#mw-save').textContent, '按原内容重试');
  await click('[data-mw=cancel]'); assert.equal(app.$('#mw-dialog').open, true);
  await submit(); assert.equal(sends.length, 2); assert.deepEqual(sends[1], sends[0]);
  assert.equal('amount' in sends[0], false); assert.ok(sends[0].requestIdempotencyKey.length >= 8);
  assert.equal(app.$('[data-mw=issue-stock]'), null); assert.equal(app.$('[data-mw=issue-reject]'), null);
  assert.match(app.$('#page').textContent, /未记账/);
  await click('[data-mw=issue-cancel]'); fill({ reason: '不再需要' }); await submit();
  assert.match(app.$('#page').textContent, /已取消/); assert.equal(app.$('[data-mw=issue-cancel]'), null);
});

test('location conflicts retain typed values, reload the exact batch version and permit clearing the location', async () => {
  const { app, row, click, fill, submit } = await materialApp();
  const writes = [];
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname !== '/api/materials/stock/location' || method !== 'PUT') return;
    writes.push(body);
    if (writes.length === 1) { row.location = '另一人设置的位置'; row.locationVersion = 2; return { body: { error: '位置已变化' }, status: 409 }; }
    assert.equal(body.version, row.locationVersion); row.location = body.location; row.locationVersion++;
    return { body: { location: { ...row, version: row.locationVersion } } };
  };
  await click({ dataset: { mw: 'page', page: 'inventory' } }); await click('[data-mw=batches]'); await click('[data-mw=location]');
  fill({ location: '二楼柜 A', reason: '合成位置修改原因' }); await submit();
  assert.equal(app.$('[data-mw=reload-form]').hidden, false); await click('[data-mw=reload-form]');
  assert.equal(app.$('#mw-fields [name=location]').value, '二楼柜 A'); assert.equal(app.$('#mw-fields [name=reason]').value, '合成位置修改原因');
  assert.match(app.$('#mw-version').textContent, /位置版本 2.*另一人设置的位置/);
  const reload = app.requests.filter(entry => entry.url.pathname === '/api/materials/stock/batches').at(-1);
  assert.equal(reload.url.searchParams.has('batch'), true); assert.equal(reload.url.searchParams.get('batch'), '');
  await submit(); assert.equal(writes[1].version, 2); assert.match(app.$('#mw-view-body').textContent, /二楼柜 A/);
  await click('[data-mw=location]'); fill({ location: '', reason: '清除旧位置' }); await submit();
  assert.equal(writes[2].location, ''); assert.equal(writes[2].reason, '清除旧位置');
});

test('material issuers confirm stock without entering money and cannot process a stale issue after reloading', async () => {
  const { app, row, click, fill, submit } = await materialApp();
  const issue = { ...row, id: 31, version: 1, qtyM: 1000, snapshot: { ...row, location: '旧位置' }, location: '发放时当前位置', purpose: '合成用途', status: 'pending', amountCents: 0, canIssue: true, canReject: true, canCancel: false };
  app.state.materialLists['/issues'] = [issue]; const writes = [];
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/issues/31' && method === 'GET') return { body: { issue } };
    if (url.pathname === '/api/materials/issues/31/issue') {
      writes.push(body); issue.version = 2; issue.status = 'issued'; issue.amountCents = 123; issue.location = '冲突后的最新位置'; issue.canIssue = issue.canReject = false;
      return { body: { error: '另一人已发放' }, status: 409 };
    }
  };
  await click({ dataset: { mw: 'page', page: 'issues' } }); assert.match(app.$('#page').textContent, /未记账/);
  await click('[data-mw=issue-stock]'); assert.match(app.$('#mw-intro').textContent, /发放时当前位置/);
  assert.equal(app.$('#mw-fields [name=amount]'), null); assert.equal(app.$('#mw-fields [name=reason]'), null); await submit();
  assert.equal(writes.length, 1); assert.equal(writes[0].version, 1); assert.ok(writes[0].requestIdempotencyKey); assert.equal(Object.hasOwn(writes[0], 'reason'), false);
  await click('[data-mw=reload-form]'); assert.equal(app.$('#mw-save').disabled, true);
  assert.match(app.$('#mw-version').textContent, /领用单版本 2.*冲突后的最新位置/);
  await submit(); assert.equal(writes.length, 1);
  await click('[data-mw=cancel]'); await click({ dataset: { mw: 'refresh' } });
  assert.match(app.$('#page').textContent, /¥1\.23/); assert.equal(app.$('[data-mw=issue-stock]'), null);
});

test('request conflict reload adds a submitted revision reason, retains inputs and enforces new identity locks and permissions', async () => {
  const { app, request, item, click, fill, submit } = await materialApp(); let writes = 0;
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname !== '/api/materials/requests/101/items/11' || method !== 'PATCH') return;
    writes++;
    if (writes === 1) { request.status = 'submitted'; request.version = 2; request.revision = 1; item.version = 2; item.identityLocked = true; return { body: { error: '已提交并验收' }, status: 409 }; }
    assert.equal(body.reason, '保留输入后修订'); assert.equal(body.purpose, '保留的用途'); assert.equal(body.catalogId, 5); assert.equal(body.regionId, 2); assert.equal(body.requestVersion, 2);
    return { body: { request } };
  };
  await click('[data-mw=request]'); await click('[data-mw=edit-item]'); fill({ purpose: '保留的用途' }); await submit();
  await click('[data-mw=reload-form]'); assert.ok(app.$('#mw-fields [name=reason]'));
  assert.equal(app.$('#mw-fields [name=purpose]').value, '保留的用途'); assert.equal(app.$('#mw-fields [name=catalogId]').disabled, true);
  assert.equal(app.$('#mw-fields [name=name]').readOnly, true); fill({ reason: '保留输入后修订' }); await submit(); assert.equal(writes, 2);
  await click('[data-mw=edit-item]'); fill({ purpose: '失权时保留的用途', reason: '权限变化时的修订原因' });
  app.state.materialResponse = ({ url, method }) => {
    if (url.pathname === '/api/materials/requests/101/items/11' && method === 'PATCH') { writes++; item.canEdit = false; request.version++; return { body: { error: '权限已变化' }, status: 409 }; }
  };
  await submit(); await click('[data-mw=reload-form]'); assert.equal(app.$('#mw-save').disabled, true);
  assert.equal(app.$('#mw-fields [name=purpose]').value, '失权时保留的用途'); await submit(); assert.equal(writes, 3);
});

test('zero-value stock adjustments require a reason and receipt history shows business dates and all reasons', async () => {
  const { app, row, request, click, fill, submit } = await materialApp(); let adjustment;
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/stock/adjustments' && method === 'POST') { adjustment = body; return { body: { movement: { id: 1 } } }; }
  };
  await click({ dataset: { mw: 'page', page: 'inventory' } }); await click('[data-mw=adjustment]');
  fill({ catalogId: '5', code: row.code, name: row.name, spec: row.spec, unit: row.unit, categoryId: '1', regionId: '2', warehouse: 'MAIN', quantity: '2', amount: '0' });
  await submit(); assert.equal(adjustment, undefined); assert.match(app.$('#mw-error').textContent, /调整原因不能为空/);
  fill({ reason: '零值赠品入账' }); await submit(); assert.equal(adjustment.amount, '0'); assert.equal(adjustment.reason, '零值赠品入账');
  app.state.materialLists['/receipts'] = [{ id: 51, type: 'acceptance', requestRevision: 1, snapshot: row, qtyM: 1000, rejectedQtyM: 1000, closedQtyM: 0, amountCents: 0, zeroAmountReason: '免费样品原因', rejectedReason: '破损拒收原因', date: '2026-09-01', createdAt: '2026-10-17T01:02:03Z' }];
  request.status = 'submitted';
  await click({ dataset: { mw: 'events', request: '101', item: '11' } });
  const history = app.$('#mw-view-body').textContent;
  assert.match(history, /业务日期 2026-09-01/); assert.match(history, /录入 2026-10-17 01:02:03/);
  assert.match(history, /零金额原因：免费样品原因/); assert.match(history, /拒收原因：破损拒收原因/);
  const ordinary = await materialApp(false); await ordinary.click('[data-mw=request]');
  assert.match(ordinary.app.$('#page').textContent, /MATERIAL.*提交申报.*ADMIN/);
});

function materialScanner(app, scan, createQr = async () => new Blob(['synthetic QR'], { type: 'image/png' })) {
  const calls = { scans: 0, closes: 0, qr: [] };
  app.context.MaterialScanner = {
    scan: async () => { calls.scans++; return scan(); }, close: () => { calls.closes++; },
    createQr: async text => { calls.qr.push(text); return createQr(text); }
  };
  return calls;
}

const stockQr = row => 'LABOS-STOCK:1:' + JSON.stringify({ catalogId: row.catalogId, catalogCode: row.code, regionId: row.regionId, warehouse: row.warehouse, batch: row.batch, expiryDate: row.expiryDate });

test('scanned packaging codes retain leading zeros and require selecting a current submitted acceptance row before accounting', async () => {
  const { app, row, item, request, click, fill, submit } = await materialApp();
  request.status = 'submitted'; request.version = 3; item.version = 4;
  const candidate = { ...item, requestNo: request.no };
  const scanner = materialScanner(app, async () => '001AbC'); let receipt;
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/scan/resolve') { assert.deepEqual(body, { code: '001AbC' }); return { body: { kind: 'catalog', catalog: { ...row, id: row.catalogId }, barcode: { code: '001AbC' } } }; }
    if (url.pathname === '/api/materials/acceptance') {
      assert.equal(url.searchParams.get('catalogId'), '5'); assert.equal(url.searchParams.get('status'), 'open');
      assert.equal(url.searchParams.has('warehouse'), false);
      return { body: { items: [candidate], total: 51, page: Number(url.searchParams.get('page')), pageSize: 50 } };
    }
    if (url.pathname === '/api/materials/receipts' && method === 'POST') { receipt = body; return { body: { request } }; }
  };
  await click('[data-mw=scan-receive]'); assert.equal(scanner.scans, 1);
  assert.match(app.$('#mw-view-body').textContent, /外包装条码只能定位物资/);
  assert.equal(app.$('#mw-dialog').open, false); assert.equal(receipt, undefined);
  const stale = app.$('[data-mw=scan-receive-item]');
  await click(app.document.querySelectorAll('[data-mw=scan-receive-page]').find(button => button.dataset.historyPage === '2'));
  assert.equal(app.requests.at(-1).url.searchParams.get('page'), '2');
  await click(stale); assert.match(app.$('#mw-status').textContent, /扫码候选已变化/);
  await click('[data-mw=scan-receive-item]');
  assert.equal(app.$('#mw-fields [name=quantity]').value, ''); assert.equal(app.$('#mw-fields [name=amount]').value, '');
  fill({ quantity: '1', amount: '2.50' }); await submit();
  assert.equal(receipt.requestVersion, 3); assert.equal(receipt.version, 4); assert.equal(receipt.itemId, 11);
  assert.equal(receipt.quantity, '1'); assert.equal(receipt.amount, '2.50'); assert.ok(receipt.requestIdempotencyKey);
});

test('internal batch scans narrow acceptance by warehouse and region and only prefill editable batch identity', async () => {
  const { app, row, item, request, click, fill, submit } = await materialApp(); request.status = 'submitted';
  const batch = { ...row, batch: 'LOT"<&', expiryDate: '2028-05-06' }; batch.qrPayload = stockQr(batch);
  materialScanner(app, async () => batch.qrPayload); let receipt;
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname.endsWith('/scan/resolve')) return { body: { kind: 'stock', catalog: { ...row, id: row.catalogId }, batch } };
    if (url.pathname === '/api/materials/acceptance') {
      assert.equal(url.searchParams.get('regionId'), '2'); assert.equal(url.searchParams.get('warehouse'), 'MAIN');
      assert.equal(url.searchParams.has('batch'), false);
      return { body: { items: [{ ...item, requestNo: request.no }], total: 1, page: 1, pageSize: 50 } };
    }
    if (url.pathname === '/api/materials/receipts' && method === 'POST') { receipt = body; return { body: { request } }; }
  };
  await click('[data-mw=scan-receive]'); await click('[data-mw=scan-receive-item]');
  assert.equal(app.$('#mw-fields [name=batch]').value, 'LOT"<&'); assert.equal(app.$('#mw-fields [name=expiryDate]').value, '2028-05-06');
  assert.match(app.$('#mw-intro').textContent, /以本次实际到货为准/);
  fill({ batch: '核对后的到货批次', expiryDate: '2028-06-01', quantity: '1', amount: '1' }); await click('[data-mw=position-read]'); await submit();
  assert.equal(receipt.batch, '核对后的到货批次'); assert.equal(receipt.expiryDate, '2028-06-01');
  await click('[data-mw=scan-receive]'); item.remainingQtyM = 0; await click('[data-mw=scan-receive-item]');
  assert.equal(app.$('#mw-dialog').open, false); assert.match(app.$('#mw-status').textContent, /已无待验数量/);
});

test('ordinary packaging scans choose a full stock batch and still submit an application without money or direct issuance', async () => {
  const { app, row, click, fill, submit } = await materialApp(false);
  const other = { ...row, regionId: 9, regionName: '另一区域', warehouse: 'SPARE', batch: 'L-2', expiryDate: '2029-01-01' };
  app.state.materialLists['/stock/batches'] = [row, other]; materialScanner(app, async () => '0000123'); let applied;
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname.endsWith('/scan/resolve')) return { body: { kind: 'catalog', catalog: { ...row, id: row.catalogId }, barcode: { code: '0000123' } } };
    if (url.pathname === '/api/materials/issues' && method === 'POST') { applied = body; return { body: { issue: { id: 41 } } }; }
  };
  assert.equal(app.$('[data-mw=scan-receive]'), null); assert.equal(app.$('[data-mw=dictionaries]'), null);
  await click('[data-mw=scan-issue]');
  const lookup = app.requests.find(entry => entry.url.pathname === '/api/materials/stock/batches');
  assert.equal(lookup.url.searchParams.get('catalogId'), '5'); assert.equal(lookup.url.searchParams.has('regionId'), false);
  assert.match(app.$('#mw-view-body').textContent, /外包装条码只能定位物资.*选择实际仓库/);
  assert.match(app.$('#mw-view-body').textContent, /另一区域/);
  assert.equal(app.$('[data-mw=location]'), null); assert.equal(app.$('[data-mw=barcodes]'), null);
  await click(app.document.querySelectorAll('[data-mw=issue-create]')[1]); fill({ quantity: '1', purpose: '扫描后申请' }); await submit();
  assert.equal(applied.regionId, 9); assert.equal(applied.warehouse, 'SPARE'); assert.equal(applied.batch, 'L-2');
  assert.equal(Object.hasOwn(applied, 'amount'), false); assert.ok(applied.requestIdempotencyKey);
  assert.equal(app.requests.some(entry => /\/issues\/\d+\/issue$/.test(entry.url.pathname)), false);
});

test('stock QR lookup preserves empty batch filters and no-candidate or unknown codes give a recoverable result', async () => {
  const { app, row, click } = await materialApp(false); row.qrPayload = stockQr(row);
  materialScanner(app, async () => row.qrPayload);
  app.state.materialResponse = ({ url }) => url.pathname.endsWith('/scan/resolve') ? { body: { kind: 'stock', catalog: { ...row, id: row.catalogId }, batch: row } } : undefined;
  await click('[data-mw=scan-issue]');
  const lookup = app.requests.filter(entry => entry.url.pathname === '/api/materials/stock/batches').at(-1).url;
  assert.equal(lookup.searchParams.get('warehouse'), 'MAIN'); assert.equal(lookup.searchParams.has('batch'), true); assert.equal(lookup.searchParams.get('batch'), '');
  assert.equal(lookup.searchParams.has('expiryDate'), true); assert.equal(lookup.searchParams.get('expiryDate'), '');
  await click('[data-mw=close-view]');
  app.state.materialResponse = ({ url }) => url.pathname.endsWith('/scan/resolve') ? { body: { error: '条码尚未绑定物资信息' }, status: 404 } : undefined;
  await click('[data-mw=scan-issue]'); assert.match(app.$('#mw-status').textContent, /尚未绑定/); assert.equal(app.$('#mw-view').open, false);
  const manager = await materialApp(); materialScanner(manager.app, async () => 'empty');
  manager.app.state.materialResponse = ({ url }) => url.pathname.endsWith('/scan/resolve') ? { body: { kind: 'catalog', catalog: { ...row, id: row.catalogId }, barcode: {} } } : undefined;
  await manager.click('[data-mw=scan-receive]'); assert.match(manager.app.$('#mw-view-body').textContent, /暂无可验收申报行.*原单已提交/);
});

test('scanner cancellation, duplicate clicks and late scan or resolver responses cannot replace a newer page or form', async () => {
  const { app, row, click } = await materialApp(); let release;
  const calls = materialScanner(app, () => new Promise(resolve => { release = resolve; }));
  const pending = click('[data-mw=scan-issue]'); await new Promise(setImmediate); await click('[data-mw=scan-issue]'); assert.equal(calls.scans, 1);
  await click({ dataset: { mw: 'page', page: 'inventory' } }); release('001'); await pending;
  assert.ok(calls.closes > 0); assert.equal(app.requests.some(entry => entry.url.pathname.endsWith('/scan/resolve')), false);
  app.context.MaterialScanner.scan = async () => null; await click('[data-mw=scan-issue]');
  assert.equal(app.requests.some(entry => entry.url.pathname.endsWith('/scan/resolve')), false);
  app.context.MaterialScanner.scan = async () => '002';
  app.state.materialResponse = async ({ url }) => {
    if (url.pathname.endsWith('/scan/resolve')) { await new Promise(resolve => { release = resolve; }); return { body: { kind: 'catalog', catalog: { ...row, id: row.catalogId }, barcode: {} } }; }
  };
  const resolving = click('[data-mw=scan-issue]'); await new Promise(setImmediate); await app.run("currentUser.permissions.push('assets.read'); go('assets')"); release(); await resolving;
  assert.equal(app.run('current'), 'assets'); assert.equal(app.$('#mw-view').open, false); assert.doesNotMatch(app.$('#page').textContent, /扫码领用/);
});

test('closing scan details by button or Escape invalidates pending batch pages and acceptance selection', async () => {
  for (const escape of [false, true]) {
    const { app, row, item, request, click } = await materialApp(); request.status = 'submitted';
    materialScanner(app, async () => '001'); let release, holdBatch = false, holdRequest = false;
    app.state.materialResponse = async ({ url }) => {
      if (url.pathname.endsWith('/scan/resolve')) return { body: { kind: 'catalog', catalog: { ...row, id: row.catalogId }, barcode: {} } };
      if (url.pathname === '/api/materials/stock/batches') {
        if (holdBatch) await new Promise(resolve => { release = resolve; });
        return { body: { items: [row], total: 51, page: Number(url.searchParams.get('page')), pageSize: 50 } };
      }
      if (url.pathname === '/api/materials/acceptance') return { body: { items: [item], total: 1, page: 1, pageSize: 50 } };
      if (url.pathname === '/api/materials/requests/101' && holdRequest) {
        await new Promise(resolve => { release = resolve; }); return { body: request };
      }
    };
    const dismiss = async () => {
      if (escape) { let prevented = false; app.$('#mw-view').listeners.cancel({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); }
      else await click('[data-mw=close-view]');
    };
    await click('[data-mw=scan-issue]'); holdBatch = true;
    const paging = click(app.document.querySelectorAll('[data-mw=batches]').find(button => button.dataset.historyPage === '2'));
    await new Promise(setImmediate); await dismiss(); release(); await paging;
    assert.equal(app.$('#mw-view').open, false, 'late batch page must stay closed');
    await click('[data-mw=scan-receive]'); holdRequest = true;
    const selecting = click('[data-mw=scan-receive-item]'); await new Promise(setImmediate);
    await dismiss(); release(); await selecting;
    assert.equal(app.$('#mw-view').open, false); assert.equal(app.$('#mw-dialog').open, false, 'late original request must not open receipt form');
  }
});

test('packaging acceptance selection rechecks the scanned catalog after the original row changes', async () => {
  const { app, row, item, request, click } = await materialApp(); request.status = 'submitted';
  materialScanner(app, async () => '001');
  app.state.materialResponse = ({ url }) => {
    if (url.pathname.endsWith('/scan/resolve')) return { body: { kind: 'catalog', catalog: { ...row, id: row.catalogId }, barcode: {} } };
    if (url.pathname === '/api/materials/acceptance') return { body: { items: [{ ...item }], total: 1, page: 1, pageSize: 50 } };
  };
  await click('[data-mw=scan-receive]'); item.catalogId = 999; item.name = '另一物资';
  await click('[data-mw=scan-receive-item]');
  assert.equal(app.$('#mw-dialog').open, false); assert.match(app.$('#mw-status').textContent, /原单物资已变化.*重新扫码/);
  assert.equal(app.requests.some(entry => entry.url.pathname === '/api/materials/receipts'), false);
});

test('catalog barcode binding preserves scanned strings and rejected input, replays an uncertain binding, and requires unbinding reasons', async () => {
  const { app, row, click, fill, submit } = await materialApp(); const writes = [], bindings = [];
  materialScanner(app, async () => '001AbC');
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/catalog/5/barcodes') {
      if (method === 'GET') return { body: { items: bindings, total: bindings.length, page: 1, pageSize: 50 } };
      writes.push(body);
      if (writes.length === 1) return { body: { error: '条码被另一物资信息占用，请核对' }, status: 409 };
      if (writes.length === 2) throw Error('synthetic lost binding response');
      bindings.push({ id: 51, code: body.code, catalogId: 5, creatorName: '<img src=x>', createdAt: '2026-10-17' }); return { body: { barcode: bindings[0] } };
    }
    if (url.pathname === '/api/materials/barcodes/51' && method === 'DELETE') { assert.deepEqual(body, { reason: '包装变更，解除旧码' }); bindings.length = 0; return { body: { deleted: true } }; }
  };
  await click('[data-mw=dictionaries]'); await click('[data-mw=barcodes]'); await click('[data-mw=barcode-add]');
  await click('[data-mw=barcode-scan]'); assert.equal(app.$('#mw-fields [name=code]').value, '001AbC');
  await submit(); assert.equal(writes.length, 0); assert.match(app.$('#mw-error').textContent, /绑定原因不能为空/);
  fill({ reason: '核对包装与物资信息后绑定' }); await submit();
  assert.equal(app.$('#mw-fields [name=code]').value, '001AbC'); assert.match(app.$('#mw-error').textContent, /被另一物资信息占用/);
  await submit(); assert.equal(app.$('#mw-fields [name=code]').disabled, true); assert.match(app.$('#mw-error').textContent, /不会重复绑定/);
  await submit(); assert.deepEqual(writes[2], writes[1]); assert.equal(Object.hasOwn(writes[2], 'requestIdempotencyKey'), false);
  assert.equal(app.$('#mw-view img'), null); assert.match(app.$('#mw-view-body').textContent, /001AbC/);
  await click('[data-mw=barcode-delete]'); await submit(); assert.match(app.$('#mw-error').textContent, /解绑原因不能为空/);
  fill({ reason: '包装变更，解除旧码' }); await submit(); assert.match(app.$('#mw-view-body').textContent, /尚未绑定外包装条码/);
  const ordinary = await materialApp(false); await ordinary.click({ dataset: { mw: 'barcodes', catalog: String(row.catalogId) } });
  assert.equal(ordinary.app.requests.some(entry => entry.url.pathname.endsWith('/barcodes')), false);
});

test('batch labels delegate exact identity to the shared template module and keep a page validity guard', async () => {
  const { app, row, click } = await materialApp();row.qrPayload=stockQr(row);const calls=[];
  app.context.MaterialLabels={configure(){calls.push('configure');},printBatch(batch,options){calls.push({batch,options});}};
  await click('[data-mw=label-template]');assert.equal(calls[0],'configure');
  await click({dataset:{mw:'page',page:'inventory'}});await click('[data-mw=batches]');await click('[data-mw=print-label]');
  assert.equal(calls[1].batch.qrPayload,row.qrPayload);assert.equal(calls[1].batch.warehouse,'MAIN');assert.equal(calls[1].options.isActive(),true);
  await click({dataset:{mw:'page',page:'requests'}});assert.equal(calls[1].options.isActive(),false);
});

const singleUnit = (row, values = {}) => ({ ...row, id: 71, code: 'UNIT-000071', catalogCode: row.code, qrPayload: 'UNIT-000071', status: 'in_stock', ...values });

test('new catalogs default to individual tracking and numbering-rule edits require a reason and a current version', async () => {
  const { app, click, fill, submit } = await materialApp();
  let created; const writes = [], rule = { template: 'LAB-{SEQ}', padding: 6, version: 3 };
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/catalog' && method === 'POST') { created = body; return { body: { catalog: { id: 6, ...body } } }; }
    if (url.pathname === '/api/materials/unit-label-rule') {
      if (method === 'GET') return { body: { rule, nextSequence: 72, dateBasis: 'UTC' } };
      writes.push(body);
      if (writes.length === 1) { rule.version = 4; return { body: { error: '编号规则已被其他人修改' }, status: 409 }; }
      return { body: { rule: { ...body, version: 5 }, nextSequence: 72, dateBasis: 'UTC' } };
    }
  };
  await click('[data-mw=dictionaries]'); await click('[data-mw=new-catalog]');
  assert.equal(app.$('#mw-fields [name=trackingMode]').value, 'unit');
  assert.equal(app.$('#mw-fields [name=code]').attrs.readonly, '');
  assert.equal(app.$('#mw-fields [name=code]').attrs.required, undefined);
  fill({ name: '逐瓶试剂', spec: '100 mL', unit: '瓶', categoryId: '1' }); await submit();
  assert.equal(created.code, '');
  assert.equal(created.trackingMode, 'unit'); assert.equal(created.unit, '瓶');
  await click('[data-mw=unit-rule]');
  assert.match(app.$('#mw-intro').textContent, /UTC.*全局递增.*不按日期重置/);
  fill({ template: 'SJ-{YYYY}{MM}{DD}-{SEQ}', padding: '8' }); await submit();
  assert.equal(writes.length, 0); assert.match(app.$('#mw-error').textContent, /修改原因不能为空/);
  fill({ reason: '统一新实物编号格式' }); await submit();
  assert.equal(writes[0].version, 3); assert.equal(writes[0].padding, 8);
  assert.equal(app.$('[data-mw=reload-form]').hidden, false); await click('[data-mw=reload-form]');
  assert.equal(app.$('#mw-fields [name=template]').value, 'SJ-{YYYY}{MM}{DD}-{SEQ}');
  assert.equal(app.$('#mw-fields [name=reason]').value, '统一新实物编号格式');
  assert.match(app.$('#mw-version').textContent, /最新版本 4/); await submit();
  assert.deepEqual(writes[1], { ...writes[0], version: 4 });
});

test('acceptance history opens its generated units and unit pagination retains the exact receipt or empty-batch scope', async () => {
  const { app, row, item, request, click } = await materialApp(); row.trackingMode = item.trackingMode = 'unit'; request.status = 'submitted';
  app.state.materialLists['/receipts'] = [{ id: 51, type: 'acceptance', unitCount: 2, snapshot: row, qtyM: 2000, requestRevision: 1 }];
  const lookups = [];
  app.state.materialResponse = ({ url }) => {
    if (url.pathname === '/api/materials/stock/units') {
      lookups.push(url); return { body: { items: [singleUnit(row)], total: 51, page: Number(url.searchParams.get('page')), pageSize: 50 } };
    }
  };
  const nextUnits = () => app.document.querySelectorAll('[data-mw=unit-page]').find(node => node.dataset.historyPage === '2');
  await click({ dataset: { mw: 'events', request: '101', item: '11' } });
  assert.match(app.$('[data-mw=receipt-units]').textContent, /2/); await click('[data-mw=receipt-units]'); await click(nextUnits());
  assert.equal(lookups.length, 2);
  for (const url of lookups) { assert.equal(url.searchParams.get('receiptId'), '51'); assert.equal(url.searchParams.has('batch'), false); }
  assert.equal(lookups[1].searchParams.get('page'), '2');
  await click('[data-mw=close-view]'); await click({ dataset: { mw: 'page', page: 'inventory' } });
  await click('[data-mw=batches]'); await click('[data-mw=batch-units]'); await click(nextUnits());
  for (const url of lookups.slice(2)) {
    assert.equal(url.searchParams.get('catalogId'), '5'); assert.equal(url.searchParams.get('regionId'), '2'); assert.equal(url.searchParams.get('warehouse'), 'MAIN');
    assert.equal(url.searchParams.has('receiptId'), false); assert.equal(url.searchParams.has('batch'), true); assert.equal(url.searchParams.get('batch'), '');
    assert.equal(url.searchParams.has('expiryDate'), true); assert.equal(url.searchParams.get('expiryDate'), '');
  }
  assert.equal(lookups[3].searchParams.get('page'), '2');
});

test('unit scans reject issued or void items, prevent duplicate receipt and only prefill an unreserved application for an in-stock unit', async () => {
  const { app, row, click, fill, submit } = await materialApp(); row.trackingMode = 'unit';
  let unit = singleUnit(row), applied;
  materialScanner(app, async () => unit.code);
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname.endsWith('/scan/resolve')) return { body: { kind: 'unit', catalog: { ...row, id: 5 }, unit, batch: row } };
    if (url.pathname === '/api/materials/issues' && method === 'POST') { applied = body; return { body: { issue: { id: 41 } } }; }
  };
  for (const status of ['issued', 'void']) {
    unit.status = status; const before = app.requests.filter(entry => entry.url.pathname === '/api/materials/stock/batches').length;
    await click('[data-mw=scan-issue]');
    assert.match(app.$('#mw-status').textContent, /已领用或作废/); assert.equal(app.$('#mw-view').open, false);
    assert.equal(app.requests.filter(entry => entry.url.pathname === '/api/materials/stock/batches').length, before);
  }
  unit.status = 'in_stock'; await click('[data-mw=scan-receive]');
  assert.match(app.$('#mw-status').textContent, /已入库单件.*不能再次验收入库/); assert.equal(app.$('#mw-dialog').open, false);
  await click('[data-mw=scan-issue]');
  const lookup = app.requests.filter(entry => entry.url.pathname === '/api/materials/stock/batches').at(-1).url;
  assert.equal(lookup.searchParams.get('catalogId'), '5'); assert.equal(lookup.searchParams.get('regionId'), '2'); assert.equal(lookup.searchParams.get('warehouse'), 'MAIN');
  assert.equal(lookup.searchParams.has('batch'), true); assert.equal(lookup.searchParams.get('batch'), ''); assert.equal(lookup.searchParams.get('expiryDate'), '');
  assert.match(app.$('#mw-view-body').textContent, /UNIT-000071.*申请不锁定此码/);
  await click('[data-mw=issue-create]'); assert.equal(app.$('#mw-fields [name=quantity]').value, '1');
  fill({ purpose: '单瓶扫码申请' }); await submit();
  assert.equal(applied.quantity, '1'); assert.equal(Object.hasOwn(applied, 'unitIds'), false); assert.equal(Object.hasOwn(applied, 'unitCodes'), false);
  assert.equal(app.requests.some(entry => /\/issues\/\d+\/issue$/.test(entry.url.pathname)), false);
});

test('unit issuance checks unique counts and every scanned batch dimension, then replays the unchanged codes after an uncertain response', async () => {
  const { app, row, click, fill, submit } = await materialApp();
  const issue = { ...row, id: 31, version: 2, qtyM: 2000, trackingMode: 'unit', status: 'pending', snapshot: row, canIssue: true };
  app.state.materialLists['/issues'] = [issue]; const writes = []; let resolved = { kind: 'unit', unit: singleUnit(row) };
  materialScanner(app, async () => resolved.unit?.code || 'PACKAGING');
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/issues/31' && method === 'GET') return { body: { issue } };
    if (url.pathname.endsWith('/scan/resolve')) return { body: resolved };
    if (url.pathname === '/api/materials/issues/31/issue') {
      writes.push(body); if (writes.length === 1) throw Error('synthetic response lost after issuance');
      return { body: { issue: { ...issue, status: 'issued', version: 3, canIssue: false } } };
    }
  };
  await click({ dataset: { mw: 'page', page: 'issues' } }); await click('[data-mw=issue-stock]');
  assert.ok(Number(app.$('#mw-fields [name=unitCodes]').attrs.maxlength) >= 128999, 'the field must hold 1000 full-length codes and line breaks');
  await submit(); assert.match(app.$('#mw-error').textContent, /请扫描或填写/);
  fill({ unitCodes: 'UNIT-000071\nUNIT-000071' }); await submit(); assert.match(app.$('#mw-error').textContent, /不能重复/);
  fill({ unitCodes: 'UNIT-000071' }); await submit(); assert.match(app.$('#mw-error').textContent, /件数必须等于申请数量/); assert.equal(writes.length, 0);
  fill({ unitCodes: '' });
  for (const changed of [{ catalogId: 99 }, { regionId: 9 }, { warehouse: 'OTHER' }, { batch: 'OTHER' }, { expiryDate: '2030-01-01' }]) {
    resolved = { kind: 'unit', unit: singleUnit(row, changed) }; await click('[data-mw=unit-code-scan]');
    assert.match(app.$('#mw-status').textContent, /物资、仓库、区域或批次.*不一致/); assert.equal(app.$('#mw-fields [name=unitCodes]').value, '');
  }
  resolved = { kind: 'unit', unit: singleUnit(row, { status: 'issued' }) }; await click('[data-mw=unit-code-scan]'); assert.match(app.$('#mw-status').textContent, /在库的独立单件码/);
  resolved = { kind: 'catalog', unit: singleUnit(row) }; await click('[data-mw=unit-code-scan]'); assert.equal(app.$('#mw-fields [name=unitCodes]').value, '');
  resolved = { kind: 'unit', unit: singleUnit(row) }; await click('[data-mw=unit-code-scan]'); await click('[data-mw=unit-code-scan]');
  assert.match(app.$('#mw-status').textContent, /已经添加/); assert.equal(app.$('#mw-fields [name=unitCodes]').value, 'UNIT-000071');
  resolved.unit = singleUnit(row, { id: 72, code: 'UNIT-000072' }); await click('[data-mw=unit-code-scan]'); await submit();
  assert.deepEqual(writes[0].unitCodes, ['UNIT-000071', 'UNIT-000072']); assert.equal(writes[0].version, 2); assert.ok(writes[0].requestIdempotencyKey);
  assert.equal(app.$('#mw-fields [name=unitCodes]').disabled, true); assert.equal(app.$('#mw-save').textContent, '按原内容重试');
  app.$('#mw-fields [name=unitCodes]').value = 'PROGRAMMATIC-CHANGE'; await submit(); assert.deepEqual(writes[1], writes[0]);
});

test('negative individual-stock adjustments require exactly the chosen distinct unit codes', async () => {
  const { app, row, click, fill, submit } = await materialApp(); app.state.materialLists['/catalog'][0].trackingMode = 'unit'; await click({ dataset: { mw: 'refresh' } });
  let adjustment;
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/stock/adjustments' && method === 'POST') { adjustment = body; return { body: { movement: { id: 81 } } }; }
  };
  await click({ dataset: { mw: 'page', page: 'inventory' } }); await click('[data-mw=adjustment]');
  assert.ok(Number(app.$('#mw-fields [name=unitCodes]').attrs.maxlength) >= 128999);
  fill({ catalogId: '5', code: row.code, name: row.name, spec: row.spec, unit: row.unit, categoryId: '1', regionId: '2', warehouse: 'MAIN', quantity: '2', amount: '0', direction: 'decrease', reason: '清点破损两瓶', unitCodes: '' });
  await submit(); assert.match(app.$('#mw-error').textContent, /请扫描或填写/); assert.equal(adjustment, undefined);
  fill({ unitCodes: 'UNIT-000071\nUNIT-000071' }); await submit(); assert.match(app.$('#mw-error').textContent, /不能重复/);
  fill({ unitCodes: 'UNIT-000071' }); await submit(); assert.match(app.$('#mw-error').textContent, /数量必须等于调整数量/); assert.equal(adjustment, undefined);
  fill({ unitCodes: 'UNIT-000071\nUNIT-000072' }); await submit();
  assert.deepEqual(adjustment.unitCodes, ['UNIT-000071', 'UNIT-000072']); assert.equal(adjustment.direction, 'decrease'); assert.equal(adjustment.quantity, '2'); assert.ok(adjustment.requestIdempotencyKey);
});

test('system QR labels reuse scoped rows and cancel after navigation without BarTender controls',async()=>{
  const {app,row,click}=await materialApp();row.trackingMode='unit';const unit=singleUnit(row);app.state.materialLists['/stock/units']=[unit];const calls=[];
  app.context.MaterialLabels={printUnits(rows,options){calls.push({rows,options});},configure(){}};
  assert.equal(app.$('[data-mw=bartender]'),null);
  await click({dataset:{mw:'page',page:'inventory'}});await click('[data-mw=batches]');await click('[data-mw=batch-units]');
  assert.equal(app.$('[data-mw=unit-bartender]'),null);assert.equal(app.$('[data-mw=unit-export]'),null);
  await click('[data-mw=unit-print]');assert.equal(calls[0].rows[0].code,unit.code);assert.equal(calls[0].options.isActive(),true);
  const query=app.requests.filter(r=>r.url.pathname==='/api/materials/stock/units').at(-1).url.searchParams;assert.equal(query.get('batch'),'');assert.equal(query.get('expiryDate'),'');assert.equal(query.get('catalogId'),'5');
  await click({dataset:{mw:'page',page:'requests'}});assert.equal(calls[0].options.isActive(),false);
  assert.equal(app.requests.some(r=>r.url.pathname.startsWith('/api/printing')),false);
});

test('acceptance exposes storage location, guards the selected batch version and preserves input after a conflict',async()=>{
  const {app,row,item,request,click,fill,submit}=await materialApp();request.status='submitted';row.location='试剂柜 A';row.locationVersion=3;let receipt,writes=0;
  app.state.materialResponse=({url,method,body})=>{if(url.pathname==='/api/materials/receipts'&&method==='POST'){writes++;if(writes===1)return {body:{error:'位置版本已变化'},status:409};receipt=body;return {body:{request}};}};
  await click({dataset:{mw:'page',page:'acceptance'}});app.state.materialAcceptance=[item];await click({dataset:{mw:'refresh'}});await click('[data-mw=receive]');
  assert.equal(app.$('#mw-fields [name=location]').value,'试剂柜 A');fill({quantity:'1',amount:'2.50',location:'试剂柜 B'});await submit();
  assert.equal(app.$('#mw-fields [name=location]').value,'试剂柜 B');assert.equal(app.$('#mw-dialog [data-mw=reload-form]').hidden,false);
  row.location='他人更新的柜';row.locationVersion=4;await click('[data-mw=reload-form]');await submit();
  assert.equal(receipt.location,'试剂柜 B');assert.equal(receipt.locationVersion,4);assert.equal(receipt.batch,'');assert.equal(receipt.expiryDate,'');
  await click('[data-mw=receive]');fill({quantity:'1',amount:'2',batch:'新到货批次',location:'柜 C'});await submit();assert.match(app.$('#mw-error').textContent,/读取本批当前位置/);assert.equal(writes,2);
  await click('[data-mw=position-read]');await submit();assert.equal(receipt.batch,'新到货批次');assert.equal(receipt.locationVersion,0);
});

test('stock row application selects a precise real batch before creating a request',async()=>{
  const {app,row,click}=await materialApp(false);app.state.materialLists['/stock/batches']=[{...row,batch:'批次甲',location:'柜 A'},{...row,batch:'批次乙',location:'柜 B'}];
  await click({dataset:{mw:'page',page:'inventory'}});assert.ok(app.$('[data-mw=stock-issue]'));await click('[data-mw=stock-issue]');assert.equal(app.$('#mw-dialog').open,false);assert.equal(app.$('#mw-view-body').querySelectorAll('[data-mw=issue-create]').length,2);
  const actions=app.$('#mw-view-body').querySelectorAll('[data-mw=issue-create]');await click(actions[1]);assert.match(app.$('#mw-intro').textContent,/批次乙/);assert.match(app.$('#mw-intro').textContent,/柜 B/);
});

test('opening documents save multiple lines, import and export Excel, confirm posting once and retain generated labels',async()=>{
  const {app,row,click,fill,submit}=await materialApp();const doc={id:81,no:'QC-81',kind:'opening',title:'期初草稿',date:'2026-10-19',description:'',version:1,status:'draft',creatorName:'tester',items:[],itemCount:0,unitCount:0};const posts=[];let created,imported;
  app.context.FileReader=class{readAsDataURL(){this.result='data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,c3ludGhldGlj';this.onload();}};
  app.state.materialResponse=({url,method,body})=>{
    if(url.pathname==='/api/materials/openings'&&method==='POST'){created=body;Object.assign(doc,body);return {body:doc,status:201};}
    if(url.pathname==='/api/materials/openings'&&method==='GET')return {body:{items:[doc],total:1,page:1,pageSize:50}};
    if(url.pathname==='/api/materials/openings/81'&&method==='GET')return {body:doc};
    if(url.pathname==='/api/materials/openings/81/items'&&method==='POST'){assert.equal(body.version,doc.version);assert.equal(body.locationVersion,1);doc.items.push({...row,...body,id:91+doc.items.length,version:1,qtyM:Number(body.quantity)*1000,amountCents:Number(body.amount)*100,trackingMode:'unit'});doc.itemCount=doc.items.length;doc.version++;return {body:doc,status:201};}
    if(url.pathname==='/api/materials/openings/81/import'){imported=body;assert.equal(body.version,doc.version);doc.items.push({...doc.items[0],id:93});doc.itemCount=doc.items.length;doc.version++;return {body:doc,status:201};}
    if(url.pathname==='/api/materials/openings/81/post'){posts.push(body);if(posts.length===1)throw Error('simulated response loss');doc.status='posted';doc.unitCount=doc.items.length;doc.version++;return {body:{opening:doc,openingClosed:false},status:201};}
  };
  await click({dataset:{mw:'page',page:'openings'}});assert.ok(app.$('[data-mw=new-opening]'));await click('[data-mw=new-opening]');fill({title:'合成期初单',date:'2026-10-19'});await submit();assert.equal(created.title,'合成期初单');
  for(let i=0;i<2;i++){await click('[data-mw=opening-add-item]');fill({catalogId:'5',code:row.code,name:row.name,spec:row.spec,unit:row.unit,categoryId:'1',regionId:'2',warehouse:'MAIN',quantity:'1',amount:'2.50',location:'柜 A'});await click('[data-mw=position-read]');await submit();}
  assert.equal(doc.items.length,2);await click('[data-mw=opening-template]');await click('[data-mw=opening-export]');assert.ok(app.requests.some(r=>r.url.pathname.endsWith('/openings/template.xlsx')));assert.ok(app.requests.some(r=>r.url.pathname.endsWith('/openings/81/export.xlsx')));
  await click('[data-mw=opening-import]');assert.equal(app.$('#mw-fields [name=file]').attrs.accept,'.xlsx');fill({file:{name:'synthetic.xlsx',size:9,type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}});await submit();assert.equal(imported.content,'c3ludGhldGlj');assert.equal(doc.items.length,3);
  await click('[data-mw=opening-post]');assert.match(app.$('#mw-intro').textContent,/生成 3 个/);await submit();assert.match(app.$('#mw-error').textContent,/按原内容重试/);await submit();assert.deepEqual(posts[0],posts[1]);assert.ok(posts[0].requestIdempotencyKey);
  assert.equal(app.$('[data-mw=opening-post]'),null);assert.ok(app.$('[data-mw=opening-units]'));await click('[data-mw=opening-units]');const lookup=app.requests.filter(r=>r.url.pathname==='/api/materials/stock/units').at(-1);assert.equal(lookup.url.searchParams.get('openingId'),'81');
});

test('closed openings stay visible and read-only while stock supplements require a reason and adjustment permission',async()=>{
  const {app,click,fill,submit}=await materialApp();app.state.materialOpeningClosed=true;const doc={id:82,no:'QC-82',kind:'opening',title:'闭账前草稿',date:'2026-10-19',version:1,status:'draft',items:[]};let created;
  app.state.materialResponse=({url,method,body})=>{if(url.pathname==='/api/materials/openings/82')return {body:doc};if(url.pathname==='/api/materials/openings'&&method==='POST'){created=body;return {body:{...doc,...body,id:83,no:'BL-83',kind:'supplement'}};}if(url.pathname==='/api/materials/openings/83')return {body:{...doc,...created,id:83,no:'BL-83',kind:'supplement'}};};
  await click({dataset:{mw:'refresh'}});assert.ok(app.document.querySelectorAll('[data-mw=page]').find(node=>node.dataset.page==='openings'));await click({dataset:{mw:'page',page:'openings'}});assert.match(app.$('[data-mw=new-opening]').textContent,/存量补录/);assert.ok(app.$('[data-mw=opening-legacy]'));
  await click({dataset:{mw:'opening-detail',id:'82'}});assert.equal(app.$('[data-mw=opening-add-item]'),null);assert.ok(app.$('[data-mw=opening-export]'));assert.match(app.$('#page').textContent,/原期初单据保持只读/);
  await click('[data-mw=opening-back]');await click('[data-mw=new-opening]');fill({title:'已有账本补录',date:'2026-10-19'});await submit();assert.equal(created,undefined);assert.match(app.$('#mw-error').textContent,/补录原因/);fill({reason:'盘点发现遗漏登记的存量'});await submit();assert.equal(created.reason,'盘点发现遗漏登记的存量');assert.match(app.$('#page').textContent,/补录原因/);
  const ordinary=await materialApp(false);ordinary.app.state.materialOpeningClosed=true;await ordinary.click({dataset:{mw:'refresh'}});await ordinary.click({dataset:{mw:'page',page:'openings'}});assert.ok(ordinary.app.document.querySelectorAll('[data-mw=page]').find(node=>node.dataset.page==='openings'));assert.equal(ordinary.app.$('[data-mw=new-opening]'),null);
});

test('declaration lookup keeps server stock priority, passes the selected scope and reuses a zero-stock identity', async () => {
  const { app, row, click, fill, submit } = await materialApp(false);
  const matches = [{ ...row, id: 7, code: 'LOCAL', name: '本区域物资', localQtyM: 2000, stockQtyM: 3000 },
    { ...row, id: 8, code: 'OTHER', name: '其他区域物资', localQtyM: 0, stockQtyM: 9000 },
    { ...row, id: 9, code: 'ZERO', name: '零库存物资', localQtyM: 0, stockQtyM: 0 }];
  let declaration;
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/catalog' && url.searchParams.has('q')) {
      assert.equal(url.searchParams.get('regionId'), '2'); assert.equal(url.searchParams.get('warehouse'), 'MAIN');
      return { body: { items: matches, total: matches.length, page: 1, pageSize: 200 } };
    }
    if (url.pathname === '/api/materials/requests/101/items' && method === 'POST') { declaration = body; return { body: app.state.materialDetails[101], status: 201 }; }
  };
  await click('[data-mw=request]'); await click('[data-mw=add-item]');
  fill({ catalogQuery: '合成', regionId: '2', warehouse: 'MAIN' }); await click('[data-mw=catalog-search]');
  const options = app.$('#mw-fields [name=catalogId]').textContent;
  assert.ok(options.indexOf('本区域物资') < options.indexOf('其他区域物资')); assert.ok(options.indexOf('其他区域物资') < options.indexOf('零库存物资'));
  assert.doesNotMatch(options, /LOCAL|OTHER|ZERO/);
  assert.match(options, /所选范围 2 \/ 全部库存 3 件/); assert.match(options, /全部库存 0 件/);
  fill({ catalogId: '9', quantity: '1' });
  app.document.listeners.change({ target: app.$('#mw-fields [name=catalogId]') });
  assert.equal(app.$('#mw-fields [name=code]').value, 'ZERO'); assert.equal(app.$('#mw-fields [name=name]').readOnly, true);
  fill({ catalogId: '' }); app.document.listeners.change({ target: app.$('#mw-fields [name=catalogId]') });
  assert.equal(app.$('#mw-fields [name=code]').value, ''); assert.equal(app.$('#mw-fields [name=code]').readOnly, true);
  assert.equal(app.$('#mw-fields [name=name]').readOnly, false);
  fill({ catalogId: '9' }); app.document.listeners.change({ target: app.$('#mw-fields [name=catalogId]') });
  await submit(); assert.equal(declaration.catalogId, 9); assert.equal(declaration.code, 'ZERO');
  assert.equal(app.requests.some(entry => entry.method === 'POST' && entry.url.pathname === '/api/materials/catalog'), false);
});

test('catalog Excel controls use a strict template and preserve the current export filter without altering stock', async () => {
  const { app, click, fill, submit } = await materialApp(); let imported;
  app.context.FileReader = class { readAsDataURL() { this.result = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,c3ludGhldGlj'; this.onload(); } };
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/catalog/import' && method === 'POST') { imported = body; return { body: { created: 1, skipped: 2 }, status: 201 }; }
  };
  await click('[data-mw=dictionaries]'); assert.match(app.$('#mw-view-body').textContent, /物资信息库.*库存数量由出入库流水累计/);
  await click('[data-mw=catalog-template]'); assert.ok(app.requests.some(entry => entry.url.pathname === '/api/materials/catalog/template'));
  app.$('#mw-catalog-management-query').value = '试剂 A'; await click('[data-mw=catalog-export]');
  assert.equal(app.requests.find(entry => entry.url.pathname === '/api/materials/catalog/export.xlsx').url.searchParams.get('q'), '试剂 A');
  await click('[data-mw=catalog-import]'); assert.equal(app.$('#mw-fields [name=file]').attrs.accept, '.xlsx');
  fill({ file: { name: 'old.xls', size: 9 } }); await submit(); assert.equal(imported, undefined); assert.match(app.$('#mw-error').textContent, /xlsx/);
  fill({ file: { name: '物资.xlsx', size: 9 } }); await submit(); assert.deepEqual(imported, { name: '物资.xlsx', content: 'c3ludGhldGlj' });
  assert.match(app.$('#mw-status').textContent, /新增 1 项，复用 2 项.*库存数量未改变/);
  assert.equal(app.requests.some(entry => entry.method === 'POST' && entry.url.pathname.includes('/stock')), false);
  const ordinary = await materialApp(false); await ordinary.click({ dataset: { mw: 'catalog-import' } });
  assert.equal(ordinary.app.$('#mw-dialog').open, false); assert.match(ordinary.app.$('#mw-status').textContent, /没有物资信息维护权限/);
});

test('Excel validation displays every cell error as text and retains the selected file and opening version for retry', async () => {
  for (const kind of ['catalog', 'opening']) {
    const { app, click, fill, submit } = await materialApp();
    const opening = { id: 81, no: 'QC-81', kind: 'opening', title: '导入核对', date: '2026-10-19', version: 3, status: 'draft', items: [] };
    const selected = { name: '中文库存.xlsx', size: 9 }, sent = [];
    let invalid = true;
    app.context.FileReader = class { readAsDataURL() { this.result = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,c3ludGhldGlj'; this.onload(); } };
    app.state.materialResponse = ({ url, method, body }) => {
      if (url.pathname === '/api/materials/openings/81' && method === 'GET') return { body: opening };
      if (url.pathname === (kind === 'catalog' ? '/api/materials/catalog/import' : '/api/materials/openings/81/import')) {
        sent.push(body);
        if (invalid) return { status: 400, body: { error: 'Excel 校验失败，未导入任何数据', code: 'IMPORT_VALIDATION', totalErrors: 3, errors: [
          { sheet: '库存明细', row: 2, column: 'C', field: '仓库', value: '<img src=x onerror=alert(1)>', message: '仓库不存在，请从下拉列表选择' },
          { sheet: '库存明细', row: 8, column: 'G', field: '数量', value: '-2', message: '数量必须大于零' },
          { sheet: '物资信息', row: 11, column: 'A', field: '物资名称', value: '', message: '物资名称不能为空' }
        ] } };
        return { status: 201, body: kind === 'catalog' ? { created: 0, skipped: 2 } : opening };
      }
    };
    if (kind === 'catalog') { await click('[data-mw=dictionaries]'); await click('[data-mw=catalog-import]'); }
    else { await click({ dataset: { mw: 'page', page: 'openings' } }); await click({ dataset: { mw: 'opening-detail', id: '81' } }); await click('[data-mw=opening-import]'); }
    fill({ file: selected }); await submit();
    const error = app.$('#mw-error');
    assert.match(error.textContent, /工作表「库存明细」 第 2 行 C 列 （仓库）.*仓库不存在/);
    assert.match(error.textContent, /第 8 行 G 列 （数量）.*数量必须大于零/);
    assert.match(error.textContent, /工作表「物资信息」 第 11 行 A 列 （物资名称）.*不能为空/);
    assert.match(error.textContent, /<img src=x onerror=alert\(1\)>/); assert.equal(error.querySelector('img'), null);
    assert.equal(error.attrs.tabindex, '0'); assert.equal(error.attrs.role, 'alert');
    assert.equal(app.$('#mw-dialog').open, true); assert.equal(app.$('#mw-save').disabled, false);
    assert.equal(app.$('#mw-fields [name=file]').value, selected); assert.doesNotMatch(app.$('#mw-status').textContent, /导入完成|操作已保存/);
    invalid = false; await submit(); assert.deepEqual(sent[1], sent[0]);
    if (kind === 'opening') assert.equal(sent[1].version, 3);
    assert.equal(app.$('#mw-dialog').open, false);
  }
});

test('late stock matching results cannot replace a newer query or a changed warehouse scope', async () => {
  const { app, row, click, fill } = await materialApp(false); let release;
  app.state.materialResponse = async ({ url }) => {
    if (url.pathname !== '/api/materials/catalog' || !url.searchParams.has('q')) return;
    const query = url.searchParams.get('q');
    if (query === 'old' || query === 'scope') await new Promise(resolve => { release = resolve; });
    return { body: { items: [{ ...row, id: 9, name: query, code: query, stockQtyM: 1000, localQtyM: 1000 }], total: 1, page: 1, pageSize: 200 } };
  };
  await click('[data-mw=request]'); await click('[data-mw=add-item]'); fill({ catalogQuery: 'old' });
  const first = click('[data-mw=catalog-search]'); fill({ catalogQuery: 'new' }); await click('[data-mw=catalog-search]'); release(); await first;
  assert.match(app.$('#mw-fields [name=catalogId]').textContent, /new/); assert.doesNotMatch(app.$('#mw-fields [name=catalogId]').textContent, /old/);
  fill({ catalogQuery: 'scope', warehouse: '' }); const scoped = click('[data-mw=catalog-search]'); fill({ warehouse: 'MAIN' }); release(); await scoped;
  assert.doesNotMatch(app.$('#mw-fields [name=catalogId]').textContent, /scope/); assert.match(app.$('#mw-status').textContent, /检索条件.*变化/);
});

test('managers create and link new materials with version conflict reloads, reasons and unchanged retry content', async () => {
  const { app, item, request, click, fill, submit } = await materialApp();
  Object.assign(item, { catalogId: null, code: '', name: '新耗材', spec: '1包', unit: '包' });
  Object.assign(request, { status: 'submitted', canSubmit: false, canAddItem: false, revision: 1 });
  const writes = [];
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/requests/101/items/11/catalog' && method === 'POST') {
      writes.push(body);
      if (writes.length === 1) { request.version++; item.version++; return { body: { error: '申报明细已变化，请重新读取' }, status: 409 }; }
      if (writes.length === 2) throw Error('synthetic response loss');
      Object.assign(item, { catalogId: 6, code: body.code || 'MAT-AUTO-6' }); request.version++; request.revision++;
      return { body: { request }, status: 201 };
    }
  };
  await click('[data-mw=request]'); assert.ok(app.$('[data-mw=request-catalog]')); await click('[data-mw=request-catalog]');
  assert.equal(app.$('#mw-fields [name=name]').value, '新耗材'); assert.equal(app.$('#mw-fields [name=trackingMode]').value, 'unit');
  assert.equal(app.$('#mw-fields [name=code]').attrs.readonly, '');
  await submit(); assert.equal(writes.length, 0); assert.match(app.$('#mw-error').textContent, /建档原因不能为空/);
  fill({ reason: '确认无同规格库存或已建档信息' }); await submit();
  assert.equal(writes[0].itemVersion, 1); assert.equal(writes[0].requestVersion, 1); assert.equal(writes[0].trackingMode, 'unit'); assert.equal(writes[0].code, ''); assert.ok(writes[0].requestIdempotencyKey);
  assert.equal(app.$('[data-mw=reload-form]').hidden, false); await click('[data-mw=reload-form]');
  assert.equal(app.$('#mw-fields [name=code]').value, ''); await submit(); assert.equal(writes[1].requestVersion, 2); assert.equal(writes[1].itemVersion, 2);
  assert.equal(app.$('#mw-save').textContent, '按原内容重试'); assert.equal(app.$('#mw-fields [name=code]').disabled, true);
  app.$('#mw-fields [name=code]').value = 'CHANGED-AFTER-SEND'; await submit(); assert.deepEqual(writes[2], writes[1]);
  assert.equal(app.$('[data-mw=request-catalog]'), null); assert.equal(app.$('#mw-dialog').open, false);
  const ordinary = await materialApp(false); Object.assign(ordinary.item, { catalogId: null });
  await ordinary.click('[data-mw=request]'); assert.equal(ordinary.app.$('[data-mw=request-catalog]'), null);
  await ordinary.click({ dataset: { mw: 'request-catalog', item: '11' } }); assert.equal(ordinary.app.$('#mw-dialog').open, false);
});


test('raw declarations stay unlinked until an existing catalog option is explicitly selected', async () => {
  const { app, click, fill, submit } = await materialApp(false); let sent;
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/requests/101/items' && method === 'POST') { sent = body; return { body: app.state.materialDetails[101], status: 201 }; }
  };
  await click('[data-mw=request]'); await click('[data-mw=add-item]');
  fill({ catalogQuery: '合成物资', name: '原始填写名称', spec: '原始填写规格', unit: '瓶', categoryId: '1', regionId: '2', warehouse: 'MAIN', quantity: '2' });
  await submit(); assert.equal(sent.catalogId, null); assert.equal(sent.name, '原始填写名称'); assert.equal(sent.spec, '原始填写规格'); assert.equal(sent.unit, '瓶');
  assert.equal(app.requests.some(entry => entry.method === 'POST' && entry.url.pathname === '/api/materials/catalog'), false);
});

test('receipt permissions allow atomic new identities without catalog maintenance and preserve retry bodies', async () => {
  const { app, item, request, click, fill, submit } = await materialApp();
  Object.assign(item, { catalogId: null, code: '', name: '待确认物资', spec: '', unit: '' }); request.status = 'submitted';
  app.state.materialCapabilities.manageCatalog = false; await app.run("go('materials')");
  const writes = [];
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/receipts' && method === 'POST') { writes.push(body); if (writes.length === 1) throw Error('synthetic response loss'); return { body: { request }, status: 201 }; }
  };
  await click({ dataset: { mw: 'receive', request: '101', item: '11' } });
  assert.equal(app.$('#mw-fields [name=catalogQuery]').value, item.name);
  assert.equal(app.$('#mw-receipt-catalog').hidden, true); assert.equal(app.$('#mw-fields [name=name]').disabled, true);
  fill({ quantity: '2', amount: '4' }); await submit(); assert.equal(writes.length, 0); assert.match(app.$('#mw-error').textContent, /请选择已有物资信息，或填写新物资信息/);
  fill({ catalogId: 'new' }); app.document.listeners.change({ target: app.$('#mw-fields [name=catalogId]') });
  assert.equal(app.$('#mw-receipt-catalog').hidden, false); assert.equal(app.$('#mw-fields [name=name]').value, item.name); assert.equal(app.$('#mw-fields [name=categoryId]').value, '1');
  await submit(); assert.match(app.$('#mw-error').textContent, /规格不能为空/); assert.equal(writes.length, 0);
  fill({ name: '确认后的物资', spec: '500 ml', unit: '瓶', location: 'A 柜第 2 层' }); await submit();
  assert.deepEqual(writes[0].newCatalog, { name: '确认后的物资', spec: '500 ml', unit: '瓶', categoryId: 1, trackingMode: 'unit' });
  assert.equal(writes[0].catalogId, undefined); assert.equal(writes[0].locationVersion, 0); assert.equal(writes[0].location, 'A 柜第 2 层');
  assert.equal(writes[0].requestVersion, 1); assert.equal(writes[0].version, 1); assert.ok(writes[0].requestIdempotencyKey);
  assert.equal(app.$('#mw-fields [name=name]').disabled, true); fill({ name: '不可替换重试原文' }); await submit(); assert.deepEqual(writes[1], writes[0]);
  assert.equal(app.requests.some(entry => entry.method === 'POST' && (entry.url.pathname === '/api/materials/catalog' || entry.url.pathname.endsWith('/catalog'))), false);
  assert.equal(app.$('#mw-dialog').open, false);
});

test('receipt lookup selects stock-first existing identities and discards stale selections when searching again', async () => {
  const { app, row, item, request, click, fill, submit } = await materialApp(); Object.assign(item, { catalogId: null }); request.status = 'submitted'; let sent;
  app.state.materialResponse = ({ url, method, body }) => {
    if (url.pathname === '/api/materials/catalog' && url.searchParams.has('q')) {
      assert.equal(url.searchParams.get('regionId'), '2'); assert.equal(url.searchParams.get('warehouse'), 'MAIN');
      return { body: { items: [{ ...row, id: 6, name: '优先物资', stockQtyM: 2000 }, { ...row, id: 5, stockQtyM: 0 }], total: 2 } };
    }
    if (url.pathname === '/api/materials/receipts' && method === 'POST') { sent = body; return { body: { request } }; }
  };
  await click({ dataset: { mw: 'receive', request: '101', item: '11' } }); await click('[data-mw=catalog-search]');
  const options = app.$('#mw-fields [name=catalogId]').textContent; assert.ok(options.indexOf('优先物资') < options.indexOf('合成物资'));
  fill({ catalogId: '5', quantity: '1', amount: '2', location: '柜 B' }); app.document.listeners.change({ target: app.$('#mw-fields [name=catalogId]') });
  assert.equal(app.$('#mw-fields [name=name]').disabled, true); await submit(); assert.equal(sent, undefined); assert.match(app.$('#mw-error').textContent, /读取本批当前位置/);
  await click('[data-mw=position-read]'); fill({ catalogQuery: '另一种名称' }); app.document.listeners.input({ target: app.$('#mw-fields [name=catalogQuery]') });
  assert.equal(app.$('#mw-fields [name=catalogId]').value, ''); await submit(); assert.equal(sent, undefined); assert.match(app.$('#mw-error').textContent, /请选择已有物资信息/);
  fill({ catalogId: '5' }); app.document.listeners.change({ target: app.$('#mw-fields [name=catalogId]') }); await click('[data-mw=position-read]'); await submit();
  assert.equal(sent.catalogId, 5); assert.equal(sent.newCatalog, undefined); assert.equal(sent.locationVersion, 1); assert.equal(sent.location, '柜 B');
});

test('rejection and closure resolve unlinked identities in the same write and unauthorized users cannot open either form', async () => {
  for (const kind of ['rejection', 'close']) {
    const { app, item, request, click, fill, submit } = await materialApp(); item.catalogId = null; request.status = 'submitted';
    app.state.materialCapabilities.closeReceipt = true; app.state.materialCapabilities.manageCatalog = false; await app.run("go('materials')"); let sent;
    app.state.materialResponse = ({ url, method, body }) => {
      if (method === 'POST' && (url.pathname === '/api/materials/receipts' || url.pathname.endsWith('/close'))) { sent = body; return { body: { request } }; }
    };
    await click({ dataset: { mw: kind === 'close' ? 'close-item' : 'receive', request: '101', item: '11' } });
    fill(kind === 'close' ? { reason: '不再采购' } : { quantity: '0', amount: '0', rejectedQuantity: '1', rejectedReason: '包装破损' });
    await submit(); assert.equal(sent, undefined); assert.match(app.$('#mw-error').textContent, /请选择已有物资信息/);
    fill({ catalogId: '5' }); app.document.listeners.change({ target: app.$('#mw-fields [name=catalogId]') }); await submit(); assert.equal(sent.catalogId, 5);
    assert.equal(sent.locationVersion, undefined); assert.equal(sent.location, undefined);
    assert.equal(app.requests.filter(entry => entry.method === 'POST').length, 1);
  }
  const ordinary = await materialApp(false); ordinary.item.catalogId = null; ordinary.request.status = 'submitted';
  for (const action of ['receive', 'close-item']) { await ordinary.click({ dataset: { mw: action, request: '101', item: '11' } }); assert.equal(ordinary.app.$('#mw-dialog').open, false); assert.match(ordinary.app.$('#mw-status').textContent, /没有.*权限/); }
});

test('changing declaration identity clears its association and receipt reload blocks a concurrently changed identity', async () => {
  const draft = await materialApp(false); await draft.click('[data-mw=request]'); await draft.click('[data-mw=add-item]');
  draft.fill({ catalogId: '5' }); draft.app.document.listeners.change({ target: draft.app.$('#mw-fields [name=catalogId]') });
  draft.fill({ name: '另一个物资' }); draft.app.document.listeners.input({ target: draft.app.$('#mw-fields [name=name]') });
  assert.equal(draft.app.$('#mw-fields [name=catalogId]').value, ''); assert.equal(draft.app.$('#mw-fields [name=code]').value, ''); assert.equal(draft.app.$('#mw-fields [name=name]').readOnly, false);
  const { app, item, request, click, fill, submit } = await materialApp(); item.catalogId = null; request.status = 'submitted'; let writes = 0;
  app.state.materialResponse = ({ url, method }) => { if (url.pathname === '/api/materials/receipts' && method === 'POST') { writes++; return { body: { error: '申报已变化' }, status: 409 }; } };
  await click({ dataset: { mw: 'receive', request: '101', item: '11' } }); fill({ catalogId: 'new' }); app.document.listeners.change({ target: app.$('#mw-fields [name=catalogId]') });
  fill({ quantity: '1', amount: '2' }); await submit(); assert.equal(writes, 1);
  Object.assign(item, { catalogId: 5, version: 2 }); request.version++; await click('[data-mw=reload-form]');
  assert.equal(app.$('#mw-save').disabled, true); await submit(); assert.equal(writes, 1); assert.equal(app.$('#mw-fields [name=catalogId]').value, 'new');
});
