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
    materialRequests: [{ id: 101, no: 'WZ-HTTP-101', title: '专用申报单', creatorName: 'tester', itemCount: 1, createdAt: '2026-10-17', status: 'draft', revision: 0 }] };
  const nav = ['dashboard', ...modules, 'management', 'audit', 'datahub', 'trash'].map(target => ({ key: target, target, label: target, icon: '', description: '', visible: 1, sort_order: 0 }));
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(value) });
  const fetch = async (input, options = {}) => {
    const url = new URL(input, 'http://localhost'), method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method, body });
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
    if (url.pathname === '/api/materials/meta') return response({ capabilities: { createRequest: true }, warehouses: [{ code: 'MAIN', name: '默认仓库' }], openingClosed: false });
    if (url.pathname === '/api/materials/requests') return response({ items: state.materialRequests, total: state.materialRequests.length, page: 1, pageSize: 50 });
    if (['/api/materials/categories', '/api/materials/regions', '/api/materials/catalog'].includes(url.pathname)) return response({ items: [], total: 0, page: 1, pageSize: 200 });
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
    confirm: () => true, prompt: () => null,
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
  assert.deepEqual(scripts, ['app.js', 'material.js', 'permission.js', 'archive.js', 'audit.js', 'datahub.js', 'asset.js', 'contract.js', 'quality.js']);
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
