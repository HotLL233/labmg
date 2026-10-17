const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const createMaterials = require('../src/materials');

const root = path.resolve(__dirname, '..');
const key = () => crypto.randomUUID();

async function fixture(t) {
  const cache = path.join(root, 'artifacts/cache', require('../package.json').version, 'materials-tests');
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'run-'));
  fs.cpSync(path.join(root, 'src'), path.join(directory, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'));
  const runtime = path.join(directory, 'runtime');
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(directory, 'src/server.js')], {
    cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), LABOS_RUNTIME_DIR: runtime, LABOS_ADMIN_USER: 'materials-admin', LABOS_ADMIN_PASSWORD: 'materials-test-password' }
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(cache));
    assert.match(path.basename(directory), /^run-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(15000) });
  assert.match(String(output), /LabOS:/, stderr);
  const request = async (method, route, actor, payload, expected = 200) => {
    const headers = actor?.cookie ? { Cookie: actor.cookie } : {};
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${port}` + route, {
      method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15000)
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const isJson = response.headers.get('content-type')?.startsWith('application/json');
    const data = isJson ? JSON.parse(bytes.toString('utf8')) : undefined;
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${route}: ${response.status} ${isJson ? JSON.stringify(data) : response.headers.get('content-type')}`);
    return { status: response.status, data, bytes, headers: response.headers };
  };
  const login = async (username, password) => {
    const response = await request('POST', '/api/auth/login', null, { username, password });
    return { ...response.data.user, cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const admin = await login('materials-admin', 'materials-test-password');
  const actors = new Map([['ADMIN', admin]]);
  const account = async role => {
    if (!actors.has(role)) {
      const username = role.toLowerCase() + '-account';
      await request('POST', '/api/users', admin, { username, roles: [role], password: 'fixture-user-password' }, 201);
      actors.set(role, await login(username, 'fixture-user-password'));
    }
    return actors.get(role);
  };
  const customAccount = async (name, permissions) => {
    await request('POST', '/api/permissions/roles', admin, { role: name }, 201);
    await request('PUT', '/api/permissions/roles/' + name, admin, { permissions });
    return account(name);
  };
  const get = async (id, actor) => (await request('GET', '/api/materials/requests/' + id, actor || await account('MATERIAL'))).data;
  const dictionary = async (kind, name, actor = admin) => (await request('POST', '/api/materials/' + kind, actor, { name }, 201)).data;
  const catalog = async (categoryId, extra = {}) => (await request('POST', '/api/materials/catalog', admin, { code: 'MAT-HTTP-A', name: 'HTTP reagent', spec: '500 mL', unit: '瓶', categoryId, ...extra }, 201)).data;
  const seed = async () => {
    const material = await account('MATERIAL');
    const category = await dictionary('categories', 'HTTP分类');
    const otherCategory = await dictionary('categories', '另一分类', material);
    const region = await dictionary('regions', 'HTTP区域');
    const otherRegion = await dictionary('regions', '另一区域', material);
    const item = await catalog(category.id);
    return { material, category, otherCategory, region, otherRegion, catalog: item };
  };
  const add = async (order, actor, item) => (await request('POST', `/api/materials/requests/${order.id}/items`, actor, { requestVersion: order.version, ...item }, 201)).data;
  const order = async (actor, item, title = 'HTTP request') => {
    let value = (await request('POST', '/api/materials/requests', actor, { title }, 201)).data;
    if (item) value = await add(value, actor, item);
    return value;
  };
  const submit = async (order, actor) => (await request('POST', `/api/materials/requests/${order.id}/submit`, actor || await account('MATERIAL'), { requestVersion: order.version })).data;
  const receiptBody = (order, extra = {}, index = 0) => ({
    requestId: order.id, itemId: order.items[index].id, requestVersion: order.version, version: order.items[index].version,
    requestIdempotencyKey: key(), quantity: '1', amount: '12.34', ...extra
  });
  const item = (seed, extra = {}) => ({ catalogId: seed.catalog.id, categoryId: seed.category.id, regionId: seed.region.id, warehouse: 'REAGENT', quantity: '10', purpose: 'HTTP fixture', ...extra });
  return { directory, runtime, request, account, customAccount, admin, get, dictionary, catalog, seed, add, order, submit, receiptBody, item };
}

function assertNoMoney(value) {
  if (Array.isArray(value)) { for (const entry of value) assertNoMoney(entry); return; }
  if (!value || typeof value !== 'object') return;
  for (const [name, entry] of Object.entries(value)) {
    assert.ok(!/(?:amountCents|cents|amount|totalAmount|unitPrice|unitCost)$/i.test(name), 'amount leaked at ' + name);
    assertNoMoney(entry);
  }
}

function workbookXml(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'XLSX must be an actual ZIP');
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'ZIP directory must exist');
  const count = bytes.readUInt16LE(end + 10), entries = new Map();
  let cursor = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    assert.ok(method === 0 || method === 8, 'unexpected ZIP compression');
    entries.set(name, (method === 8 ? inflateRawSync(compressed) : compressed).toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.ok(entries.has('[Content_Types].xml'));
  assert.ok(entries.has('xl/workbook.xml'));
  assert.ok([...entries.keys()].some(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)));
  return entries;
}

test('materials dictionaries require administrator roles while all authenticated roles can declare and own their draft rows', { timeout: 45000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  await f.request('GET', '/api/materials/meta', null, undefined, 401);
  await f.request('POST', '/api/materials/categories', ordinary, { name: 'forged' }, 403);
  await f.request('POST', '/api/materials/regions', ordinary, { name: 'forged' }, 403);
  await f.request('POST', '/api/materials/categories', f.admin, { name: ' HTTP分类 ' }, [400, 409]);
  await f.request('POST', '/api/materials/catalog', ordinary, { ...s.catalog }, 403);
  let order = await f.order(ordinary, f.item(s));
  assert.equal(order.items[0].authorId, ordinary.id);
  for (const role of ['ADMIN', 'LAB_MANAGER', 'QUALITY', 'TECHNICAL', 'TESTER', 'SAMPLE', 'FINANCE', 'EQUIPMENT', 'MATERIAL']) {
    const actor = await f.account(role);
    const own = await f.order(actor, f.item(s), 'role ' + role);
    assert.equal(own.createdBy, actor.id); assert.equal(own.items[0].authorId, actor.id);
  }
  const finance = await f.account('FINANCE');
  await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, finance, { requestVersion: order.version, version: order.items[0].version, purpose: 'forged' }, 403);
  await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, ordinary, { requestVersion: order.version, version: order.items[0].version, purpose: 'forged owner edit', authorId: finance.id }, 400);
  assert.equal((await f.get(order.id, ordinary)).items[0].purpose, 'HTTP fixture');
  await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, ordinary, { requestVersion: order.version, version: order.items[0].version, purpose: 'own edit' });
  order = await f.get(order.id, ordinary);
  assert.equal(order.items[0].purpose, 'own edit'); assert.equal(order.items[0].authorId, ordinary.id);
  await f.request('POST', `/api/materials/requests/${order.id}/items`, ordinary, { requestVersion: order.version, ...f.item(s), regionId: 999999 }, 400);
  await f.request('POST', `/api/materials/requests/${order.id}/items`, ordinary, { requestVersion: order.version, ...f.item(s), categoryId: 999999 }, 400);
  const unmatched = await f.order(finance, { code: 'NEW-ITEM', name: '未建档耗材', spec: 'test', unit: '盒', categoryId: s.category.id, regionId: s.region.id, warehouse: 'MAIN', quantity: '1' });
  assert.equal(unmatched.items[0].catalogId, null);
  const submitted = await f.submit(unmatched, s.material);
  assert.equal(submitted.status, 'submitted'); assert.equal(submitted.items[0].catalogId, null);
});

test('new free-text materials submit without a catalog but require explicit controlled matching before receipt events', { timeout: 45000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  let order = await f.order(ordinary, null, '新物资申报');
  await f.request('POST', `/api/materials/requests/${order.id}/submit`, s.material, { requestVersion: order.version }, 400);
  const free = { name: '全新耗材原填报', spec: '自由规格', unit: '盒', categoryId: s.category.id, regionId: s.region.id,
    warehouse: 'MAIN', quantity: '3.5', purpose: '尚未建立规范主档' };
  for (const field of ['name', 'spec', 'unit']) {
    await f.request('POST', `/api/materials/requests/${order.id}/items`, ordinary,
      { requestVersion: order.version, ...free, [field]: '' }, 400);
  }
  const staleVersion = order.version;
  order = await f.add(order, ordinary, free);
  for (const actor of [ordinary, f.admin]) {
    await f.request('POST', `/api/materials/requests/${order.id}/submit`, actor, { requestVersion: order.version }, 403);
  }
  await f.request('POST', `/api/materials/requests/${order.id}/submit`, s.material, { requestVersion: staleVersion }, 409);
  order = await f.submit(order, s.material);
  assert.equal(order.status, 'submitted'); assert.equal(order.revision, 1);
  assert.equal(order.items[0].catalogId, null); assert.equal(order.items[0].identityLocked, false);
  const original = (await f.request('GET', `/api/materials/requests/${order.id}/revisions`, s.material)).data.originalSnapshot;
  assert.equal(original.items[0].catalogId, null); assert.equal(original.items[0].name, free.name);
  assert.equal((await f.request('GET', '/api/materials/catalog', s.material)).data.total, 1, 'submission must not create or guess a catalog match');
  const receipt = f.receiptBody(order, { quantity: '1.25', amount: '25' });
  const reject = f.receiptBody(order, { quantity: '0', amount: '0', rejectedQuantity: '1', rejectedReason: '包装破损' });
  const close = { requestVersion: order.version, version: order.items[0].version, requestIdempotencyKey: key(), reason: '取消采购' };
  for (const payload of [receipt, reject]) {
    const response = await f.request('POST', '/api/materials/receipts', s.material, payload, 409);
    assert.match(response.data.error, /先匹配物资主档/);
  }
  await f.request('POST', `/api/materials/requests/${order.id}/items/${order.items[0].id}/close`, s.material, close, 409);
  assert.deepEqual(await f.get(order.id), order, 'failed events must not change versions, identity locks or progress');
  for (const route of ['stock', 'stock/movements', 'receipts']) assert.equal((await f.request('GET', '/api/materials/' + route, s.material)).data.total, 0);
  assert.equal((await f.request('GET', '/api/materials/meta', s.material)).data.openingClosed, false);
  const master = await f.catalog(s.category.id, { code: 'NEW-CONFIRMED', name: '规范新耗材', spec: '25 mL', unit: '盒' });
  const bind = { requestVersion: order.version, version: order.items[0].version, catalogId: master.id, reason: '明确建立主档后受控匹配' };
  for (const actor of [ordinary, f.admin]) await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, actor, bind, 403);
  await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, s.material, { ...bind, reason: '' }, 400);
  await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, s.material, { ...bind, requestVersion: staleVersion }, 409);
  order = (await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, s.material, bind)).data;
  assert.equal(order.revision, 2); assert.equal(order.items[0].catalogId, master.id);
  assert.equal(order.items[0].name, master.name); assert.equal(order.items[0].spec, master.spec);
  assert.equal(order.submittedAt, original.submittedAt); assert.equal(order.submittedBy, original.submittedBy);
  const history = (await f.request('GET', `/api/materials/requests/${order.id}/revisions`, s.material)).data;
  assert.deepEqual(history.originalSnapshot, original);
  assert.equal(history.revisions.length, 1);
  assert.equal(history.revisions[0].before.items[0].catalogId, null);
  assert.equal(history.revisions[0].after.items[0].catalogId, master.id);
  assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.total, 0, 'matching must not create inventory');
  const accepted = (await f.request('POST', '/api/materials/receipts', s.material,
    f.receiptBody(order, { quantity: '1.25', amount: '25' }), 201)).data;
  order = accepted.request;
  assert.equal(accepted.receipt.snapshot.catalogId, master.id); assert.equal(accepted.receipt.requestRevision, 2);
  assert.equal(order.items[0].identityLocked, true);
  for (const fields of [{ catalogId: null }, { catalogId: s.catalog.id }, { spec: '改动受保护规格' }]) {
    await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, s.material,
      { requestVersion: order.version, version: order.items[0].version, reason: '不能改已验收身份', ...fields }, 409);
  }
  const stock = (await f.request('GET', '/api/materials/stock', s.material)).data.items;
  assert.equal(stock.length, 1); assert.equal(stock[0].catalogId, master.id);
  assert.equal(stock[0].qtyM, 1250); assert.equal(stock[0].amountCents, 2500);
  const backup = (await f.request('GET', '/api/materials/backup', f.admin)).data;
  const target = await fixture(t);
  await target.account('MATERIAL'); await target.account('TESTER');
  await target.request('POST', '/api/materials/restore', target.admin, backup);
  assert.equal((await target.get(order.id)).items[0].catalogId, master.id);
  const restoredHistory = (await target.request('GET', `/api/materials/requests/${order.id}/revisions`, target.admin)).data;
  assert.deepEqual(restoredHistory.originalSnapshot, original);
  assert.equal(restoredHistory.revisions[0].before.items[0].catalogId, null);
  assert.equal(restoredHistory.revisions[0].after.items[0].catalogId, master.id);
  assert.equal((await target.request('GET', '/api/materials/stock', target.admin)).data.items[0].qtyM, 1250);
});

test('submitted unmatched lines restore before matching and retain rejection and closure identity protection afterward', { timeout: 45000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  const free = { name: '待建档物资', spec: '500 mL', unit: '瓶', categoryId: s.category.id, regionId: s.region.id, warehouse: 'MAIN', quantity: '2' };
  let order = await f.submit(await f.order(s.material, free));
  const backup = (await f.request('GET', '/api/materials/backup', f.admin)).data;
  const target = await fixture(t), material = await target.account('MATERIAL');
  await target.request('POST', '/api/materials/restore', target.admin, backup);
  order = await target.get(order.id, material);
  assert.equal(order.status, 'submitted'); assert.equal(order.items[0].catalogId, null);
  const original = (await target.request('GET', `/api/materials/requests/${order.id}/revisions`, material)).data.originalSnapshot;
  assert.equal(original.items[0].catalogId, null);
  await target.request('POST', '/api/materials/receipts', material,
    target.receiptBody(order, { quantity: '0', amount: '0', rejectedQuantity: '1', rejectedReason: '先匹配再拒收' }), 409);
  const master = await target.catalog(s.category.id, { code: 'EXPLICIT-RESTORED', name: free.name });
  order = (await target.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, material,
    { requestVersion: order.version, version: order.items[0].version, catalogId: master.id, reason: '恢复后规范匹配' })).data;
  order = (await target.request('POST', '/api/materials/receipts', material,
    target.receiptBody(order, { quantity: '0', amount: '0', rejectedQuantity: '1', rejectedReason: '外包装破损' }), 201)).data.request;
  assert.equal(order.items[0].identityLocked, true); assert.equal(order.items[0].remainingQtyM, 2000);
  await target.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, material,
    { requestVersion: order.version, version: order.items[0].version, catalogId: null, reason: '拒收后不能解除匹配' }, 409);
  order = (await target.request('POST', `/api/materials/requests/${order.id}/items/${order.items[0].id}/close`, material,
    { requestVersion: order.version, version: order.items[0].version, requestIdempotencyKey: key(), reason: '差缺不再采购' }, 201)).data.request;
  assert.equal(order.items[0].closedQtyM, 2000); assert.equal(order.items[0].remainingQtyM, 0);
  await target.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, material,
    { requestVersion: order.version, version: order.items[0].version, regionId: s.otherRegion.id, reason: '结案后不能改区域' }, 409);
  assert.equal((await target.request('GET', '/api/materials/stock/movements', material)).data.total, 0);
  assert.equal((await target.request('GET', '/api/materials/meta', material)).data.openingClosed, false);
  const historicalBackup = (await target.request('GET', '/api/materials/backup', target.admin)).data;
  const restored = await fixture(t);
  await restored.account('MATERIAL');
  await restored.request('POST', '/api/materials/restore', restored.admin, historicalBackup);
  const history = (await restored.request('GET', `/api/materials/requests/${order.id}/revisions`, restored.admin)).data;
  assert.deepEqual(history.originalSnapshot, original);
  assert.equal((await restored.get(order.id)).items[0].closedQtyM, 2000);
  assert.equal((await restored.request('GET', '/api/materials/receipts', restored.admin)).data.total, 2);
});

test('request submission serializes against draft writes and only MATERIAL can submit or revise submitted content', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('FINANCE');
  let order = await f.order(ordinary, f.item(s));
  const originalVersion = order.version;
  const additions = await Promise.all([0, 1].map(() => f.request('POST', `/api/materials/requests/${order.id}/items`, ordinary, { requestVersion: originalVersion, ...f.item(s) }, 201)));
  assert.equal(additions.length, 2);
  order = await f.get(order.id);
  assert.equal(order.items.length, 3); assert.equal(order.version, originalVersion + 2);
  const initialCount = order.items.length;
  await f.request('POST', `/api/materials/requests/${order.id}/submit`, f.admin, { requestVersion: order.version }, 403);
  const race = await Promise.all([
    f.request('POST', `/api/materials/requests/${order.id}/items`, ordinary, { requestVersion: order.version, ...f.item(s) }, [201, 409]),
    f.request('POST', `/api/materials/requests/${order.id}/submit`, s.material, { requestVersion: order.version }, [200, 409])
  ]);
  assert.equal(race.filter(result => result.status === 409).length, 1);
  order = await f.get(order.id);
  assert.equal(order.items.length, initialCount + (race[0].status === 201 ? 1 : 0));
  if (order.status === 'draft') order = await f.submit(order);
  assert.equal(order.status, 'submitted'); assert.equal(order.revision, 1);
  const line = order.items[0], original = (await f.request('GET', `/api/materials/requests/${order.id}/revisions`, ordinary)).data.originalSnapshot;
  for (const actor of [ordinary, f.admin]) await f.request('PATCH', `/api/materials/requests/${order.id}/items/${line.id}`, actor, { requestVersion: order.version, version: line.version, quantity: '11', reason: 'forged' }, 403);
  await f.request('POST', `/api/materials/requests/${order.id}/items`, s.material, { requestVersion: order.version, ...f.item(s) }, 409);
  await f.request('DELETE', `/api/materials/requests/${order.id}/items/${line.id}`, s.material, { requestVersion: order.version, version: line.version }, 409);
  await f.request('PATCH', `/api/materials/requests/${order.id}/items/${line.id}`, s.material, { requestVersion: order.version, version: line.version, quantity: '11' }, 400);
  order = (await f.request('PATCH', `/api/materials/requests/${order.id}/items/${line.id}`, s.material, { requestVersion: order.version, version: line.version, quantity: '11', reason: '追加一瓶' })).data;
  assert.equal(order.revision, 2); assert.equal(order.items[0].qtyM, 11000);
  const history = (await f.request('GET', `/api/materials/requests/${order.id}/revisions`, ordinary)).data;
  assert.deepEqual(history.originalSnapshot, original); assert.equal(history.revisions.length, 1);
  assert.equal(history.revisions[0].reason, '追加一瓶'); assert.ok(history.revisions[0].before); assert.ok(history.revisions[0].after);
  assert.equal(history.revisions[0].actorId, s.material.id);
  await f.request('PATCH', `/api/materials/requests/${order.id}`, s.material, { requestVersion: order.version, title: '新主题' }, 400);
  order = (await f.request('PATCH', `/api/materials/requests/${order.id}`, s.material, { requestVersion: order.version, title: '新主题', reason: '表头更正' })).data;
  assert.equal(order.revision, 3);
});

test('material lists preserve totals and pagination when filtering by category, region, date, receipt status and stock identity', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  const draft = await f.order(s.material, f.item(s), '分页草稿');
  let partial = await f.submit(await f.order(s.material, f.item(s), '分页部分验收'));
  let complete = await f.submit(await f.order(s.material, f.item(s, { regionId: s.otherRegion.id, quantity: '1' }), '分页已验收'));
  let closed = await f.submit(await f.order(s.material, f.item(s, { regionId: s.otherRegion.id, quantity: '1' }), '分页结案'));
  const pending = await f.submit(await f.order(s.material, f.item(s), '分页待验收'));
  partial = (await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(partial, { quantity: '2', amount: '20' }), 201)).data.request;
  complete = (await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(complete), 201)).data.request;
  closed = (await f.request('POST', `/api/materials/requests/${closed.id}/items/${closed.items[0].id}/close`, s.material, { requestVersion: closed.version, version: closed.items[0].version, requestIdempotencyKey: key(), reason: '取消采购余量' }, 201)).data.request;
  const list = async (route, query = '') => (await f.request('GET', '/api/materials/' + route + query, s.material)).data;
  const secondPage = await list('requests', '?page=2&pageSize=2');
  assert.equal(secondPage.total, 5); assert.equal(secondPage.page, 2); assert.equal(secondPage.pageSize, 2);
  assert.deepEqual(secondPage.items.map(order => order.id), [complete.id, partial.id]);
  assert.ok(secondPage.items.every(order => order.itemCount === 1 && order.items === undefined && order.attachments === undefined));
  assert.equal((await list('requests', '?status=draft')).items[0].id, draft.id);
  assert.equal((await list('requests', '?status=submitted')).total, 4);
  assert.equal((await list('requests', '?q=' + encodeURIComponent(' HTTP分类 '))).total, 5);
  assert.equal((await list('requests', '?q=' + encodeURIComponent(s.region.name))).total, 3);
  assert.equal((await list('requests', '?from=2099-01-01')).total, 0);
  assert.equal((await list('requests', '?to=2000-01-01')).total, 0);
  assert.equal((await list('requests', '?pageSize=201')).pageSize, 200);
  const receiptPage = await list('acceptance', '?page=2&pageSize=1');
  assert.equal(receiptPage.total, 4); assert.equal(receiptPage.items[0].requestId, closed.id);
  assert.ok(receiptPage.items[0].requestCreatedAt);
  for (const [status, order] of [['pending', pending], ['partial', partial], ['done', complete], ['closed', closed]]) {
    const result = await list('acceptance', '?status=' + status);
    assert.equal(result.total, 1); assert.equal(result.items[0].requestId, order.id);
  }
  assert.equal((await list('acceptance', '?q=' + encodeURIComponent(s.otherRegion.name))).total, 2);
  assert.equal((await list('acceptance', '?q=' + encodeURIComponent(s.category.name))).total, 4);
  assert.equal((await list('acceptance', '?from=2099-01-01')).total, 0);
  assert.equal((await list('acceptance', '?to=2000-01-01')).total, 0);
  const stockPage = await list('stock', '?q=MAT-HTTP-A&page=2&pageSize=1');
  assert.equal(stockPage.total, 2); assert.equal(stockPage.items.length, 1); assert.equal(stockPage.items[0].regionId, s.otherRegion.id);
  assert.equal((await list('stock', '?q=' + encodeURIComponent(s.region.name))).total, 1);
  assert.equal((await list('stock', '?q=missing-stock')).total, 0);
  assert.equal((await list('stock', '?warehouse=SPARE')).total, 0);
  const receiptHistory = await list('receipts', '?page=2&pageSize=1');
  assert.equal(receiptHistory.total, 3); assert.equal(receiptHistory.items[0].requestId, complete.id);
  assert.equal(receiptHistory.items[0].actorName, s.material.display_name); assert.equal(receiptHistory.items[0].reversed, false);
  assert.equal((await list('receipts', '?requestId=' + partial.id)).total, 1);
  assert.equal((await list('receipts', '?itemId=' + closed.items[0].id)).total, 1);
  const movementHistory = await list('stock/movements', '?page=2&pageSize=1');
  assert.equal(movementHistory.total, 2); assert.equal(movementHistory.items[0].regionId, s.region.id);
  assert.equal(movementHistory.items[0].actorName, s.material.display_name);
  assert.equal((await list('stock/movements', '?regionId=' + s.otherRegion.id)).total, 1);
  assert.equal((await list('stock/movements', '?warehouse=SPARE')).total, 0);
  for (const route of ['requests?page=0', 'requests?from=2026-02-30', 'acceptance?status=invalid', 'stock?regionId=invalid']) await f.request('GET', '/api/materials/' + route, s.material, undefined, 400);
});

test('receipt confirmation is idempotent, concurrent receipt tokens cannot overspend, and reversal cannot be repeated with another key', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  let order = await f.submit(await f.order(s.material, f.item(s)));
  const body = f.receiptBody(order, { quantity: '6', amount: '60' });
  const first = (await f.request('POST', '/api/materials/receipts', s.material, body, 201)).data;
  assert.equal(first.receipt.qtyM, 6000); assert.equal(first.receipt.amountCents, 6000);
  const replay = (await f.request('POST', '/api/materials/receipts', s.material, body)).data;
  assert.equal(replay.receipt.id, first.receipt.id);
  await f.request('POST', '/api/materials/receipts', s.material, { ...body, amount: '61' }, 409);
  order = await f.get(order.id);
  const race = await Promise.all([0, 1].map(() => f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { quantity: '3', amount: '30' }), [201, 409])));
  assert.deepEqual(race.map(result => result.status).sort(), [201, 409]);
  order = await f.get(order.id); assert.equal(order.items[0].acceptedQtyM, 9000);
  await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { quantity: '2' }), [400, 409]);
  const reverse = { requestVersion: order.version, version: order.items[0].version, requestIdempotencyKey: key(), reason: '整批验收录错' };
  const reversed = (await f.request('POST', `/api/materials/receipts/${first.receipt.id}/reverse`, s.material, reverse, 201)).data;
  assert.equal(reversed.receipt.qtyM, -6000); assert.equal(reversed.receipt.amountCents, -6000);
  const replayReverse = (await f.request('POST', `/api/materials/receipts/${first.receipt.id}/reverse`, s.material, reverse)).data;
  assert.equal(replayReverse.receipt.id, reversed.receipt.id);
  order = await f.get(order.id); assert.equal(order.items[0].acceptedQtyM, 3000);
  await f.request('POST', `/api/materials/receipts/${first.receipt.id}/reverse`, s.material, { ...reverse, requestVersion: order.version, version: order.items[0].version, requestIdempotencyKey: key() }, 409);
  const stock = (await f.request('GET', '/api/materials/stock', s.material)).data.items;
  assert.equal(stock.length, 1); assert.equal(stock[0].qtyM, 3000); assert.equal(stock[0].amountCents, 3000);
});

test('received identity and accepted-plus-closed quantity are protected while revisions leave receipt and stock history unchanged', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), alternate = await f.catalog(s.category.id, { code: 'OTHER', name: 'Other', spec: '1 L', unit: '盒' });
  let order = await f.submit(await f.order(s.material, f.item(s)));
  order = (await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { quantity: '3', amount: '30' }), 201)).data.request;
  const receiptHistory = (await f.request('GET', '/api/materials/receipts', s.material)).data;
  const stockHistory = (await f.request('GET', '/api/materials/stock/movements', s.material)).data;
  const original = (await f.request('GET', `/api/materials/requests/${order.id}/revisions`, s.material)).data.originalSnapshot;
  for (const fields of [{ catalogId: alternate.id }, { code: 'FORGED' }, { name: 'FORGED' }, { spec: 'FORGED' }, { unit: 'FORGED' }, { warehouse: 'SPARE' }, { regionId: s.otherRegion.id }]) {
    await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, s.material, { requestVersion: order.version, version: order.items[0].version, reason: '不允许改身份', ...fields }, 409);
  }
  await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, s.material, { requestVersion: order.version, version: order.items[0].version, quantity: '2.999', reason: '低于已验收' }, [400, 409]);
  order = (await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, s.material, { requestVersion: order.version, version: order.items[0].version, quantity: '12', categoryId: s.otherCategory.id, purpose: '受控修订', reason: '新增需求与分类调整' })).data;
  assert.equal(order.revision, 2); assert.equal(order.items[0].qtyM, 12000);
  assert.deepEqual((await f.request('GET', '/api/materials/receipts', s.material)).data, receiptHistory);
  assert.deepEqual((await f.request('GET', '/api/materials/stock/movements', s.material)).data, stockHistory);
  assert.deepEqual((await f.request('GET', `/api/materials/requests/${order.id}/revisions`, s.material)).data.originalSnapshot, original);
  const closedBody = { requestVersion: order.version, version: order.items[0].version, requestIdempotencyKey: key(), reason: '余量不再采购' };
  const closed = (await f.request('POST', `/api/materials/requests/${order.id}/items/${order.items[0].id}/close`, s.material, closedBody, 201)).data;
  assert.equal(closed.request.items[0].closedQtyM, 9000); assert.equal(closed.request.items[0].receiptStatus, 'closed');
  await f.request('POST', `/api/materials/requests/${order.id}/items/${order.items[0].id}/close`, s.material, closedBody);
  order = await f.get(order.id);
  await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, s.material, { requestVersion: order.version, version: order.items[0].version, quantity: '11.999', reason: '低于已验加结案' }, [400, 409]);
  assert.deepEqual((await f.request('GET', '/api/materials/stock/movements', s.material)).data, stockHistory);
});

test('opening inventory merges only within a region, retains source amounts, rejects duplicate payload changes and closes permanently', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const body = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'REAGENT', quantity: '2', amount: '20', batch: 'OPEN-A', requestIdempotencyKey: key() };
  for (const actor of [ordinary, f.admin]) await f.request('POST', '/api/materials/stock/opening', actor, body, 403);
  const first = (await f.request('POST', '/api/materials/stock/opening', s.material, body, 201)).data;
  assert.equal((await f.request('POST', '/api/materials/stock/opening', s.material, body)).data.movement.id, first.movement.id);
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...body, amount: '21' }, 409);
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...body, regionId: s.otherRegion.id, quantity: '3', amount: '30', requestIdempotencyKey: key() }, 201);
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...body, quantity: '1', amount: '50', batch: 'OPEN-C', requestIdempotencyKey: key() }, 201);
  const stock = (await f.request('GET', '/api/materials/stock', s.material)).data.items;
  assert.equal(stock.length, 2);
  const own = stock.find(row => row.regionId === s.region.id); assert.equal(own.qtyM, 3000); assert.equal(own.amountCents, 7000);
  const other = stock.find(row => row.regionId === s.otherRegion.id); assert.equal(other.qtyM, 3000); assert.equal(other.amountCents, 3000);
  assert.equal((await f.request('GET', `/api/materials/stock?regionId=${s.region.id}`, s.material)).data.items.length, 1);
  assert.equal((await f.request('GET', '/api/materials/stock/movements', s.material)).data.items.length, 3);
  await f.request('POST', '/api/materials/stock/opening/close', s.material, { reason: '期初核对完成' });
  assert.equal((await f.request('GET', '/api/materials/meta', s.material)).data.openingClosed, true);
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...body, requestIdempotencyKey: key() }, 409);
  await f.request('POST', '/api/materials/stock/opening', s.material, body);
});

test('pure rejection does not close opening inventory or fulfill demand; positive receipts close opening and zero amounts require a reason', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  let order = await f.submit(await f.order(s.material, f.item(s)));
  await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { quantity: '0', amount: '0', rejectedQuantity: '2' }), 400);
  order = (await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { quantity: '0', amount: '0', rejectedQuantity: '2', rejectedReason: '包装破损' }), 201)).data.request;
  assert.equal(order.items[0].acceptedQtyM, 0); assert.equal(order.items[0].remainingQtyM, 10000);
  assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.items.length, 0);
  assert.equal((await f.request('GET', '/api/materials/meta', s.material)).data.openingClosed, false);
  await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { amount: '0' }), 400);
  for (const quantity of ['1e0', '0.0001', '-1', 'NaN', 1]) await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { quantity }), 400);
  const result = (await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { amount: '0', zeroAmountReason: '赠品' }), 201)).data;
  assert.equal(result.receipt.amountCents, 0);
  assert.equal((await f.request('GET', '/api/materials/meta', s.material)).data.openingClosed, true);
});

test('stock adjustments require MATERIAL permission and a reason, preserve batch balances and cannot make quantity or amount negative', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const body = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'MAIN', batch: 'ADJUST-A', quantity: '2', amount: '20', requestIdempotencyKey: key() };
  await f.request('POST', '/api/materials/stock/opening', s.material, body, 201);
  const adjustment = { ...body, requestIdempotencyKey: key(), direction: 'decrease', quantity: '1', amount: '10', reason: '盘点差异' };
  for (const actor of [ordinary, f.admin]) await f.request('POST', '/api/materials/stock/adjustments', actor, adjustment, 403);
  await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...adjustment, reason: '' }, 400);
  for (const change of [{ quantity: '2.001' }, { amount: '20.01' }, { batch: 'OTHER-BATCH' }]) {
    await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...adjustment, ...change }, 409);
  }
  assert.equal((await f.request('GET', '/api/materials/stock/movements', s.material)).data.items.length, 1);
  const adjusted = (await f.request('POST', '/api/materials/stock/adjustments', s.material, adjustment, 201)).data;
  assert.equal(adjusted.movement.qtyM, -1000); assert.equal(adjusted.movement.amountCents, -1000);
  assert.equal((await f.request('POST', '/api/materials/stock/adjustments', s.material, adjustment)).data.movement.id, adjusted.movement.id);
  assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.items[0].qtyM, 1000);
  assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.items[0].amountCents, 1000);
  await f.request('PUT', '/api/permissions/roles/MATERIAL', f.admin, { permissions: ['materials.read'] });
  assert.equal((await f.request('GET', '/api/materials/meta', s.material)).data.capabilities.adjustStock, false);
  await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...adjustment, requestIdempotencyKey: key() }, 403);
});

test('material attachments validate content, retain submitted revision history and protect receipt documents containing amounts', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER'), other = await f.account('FINANCE');
  let order = await f.order(ordinary, f.item(s));
  const attachment = { name: 'safe.txt', mimeType: 'text/plain', content: Buffer.from('safe fixture attachment').toString('base64') };
  const upload = (actor, fields = {}, expected = 400) => f.request('POST', `/api/materials/requests/${order.id}/attachments`, actor, { requestVersion: order.version, ...attachment, ...fields }, expected);
  for (const fields of [{ name: '../bad.txt' }, { name: '..\\bad.txt' }, { content: 'not-base64' }, { content: 'YQ=' }, { mimeType: 'text/html\r\nX-Injected: true' }]) await upload(ordinary, fields);
  await upload(other, {}, 403);
  assert.equal((await f.request('GET', `/api/materials/requests/${order.id}/attachments`, ordinary)).data.items.length, 0);
  const uploaded = (await upload(ordinary, {}, 201)).data;
  order = await f.submit(uploaded.request);
  await upload(ordinary, { reason: '无权修订' }, 403);
  await upload(s.material, {}, 400);
  const original = (await f.request('GET', `/api/materials/requests/${order.id}/revisions`, ordinary)).data.originalSnapshot;
  const revised = (await upload(s.material, { reason: '补充提交后资料' }, 201)).data;
  order = revised.request; assert.equal(order.revision, 2);
  await f.request('DELETE', `/api/materials/attachments/${uploaded.attachment.id}`, ordinary, { requestVersion: order.version }, 403);
  order = (await f.request('DELETE', `/api/materials/attachments/${uploaded.attachment.id}`, s.material, { requestVersion: order.version, reason: '资料被新版替代' })).data.request;
  assert.equal(order.revision, 3);
  assert.deepEqual((await f.request('GET', `/api/materials/requests/${order.id}/revisions`, ordinary)).data.originalSnapshot, original);
  assert.equal((await f.request('GET', `/api/materials/requests/${order.id}/attachments`, ordinary)).data.items.length, 1);
  assert.equal((await f.request('GET', `/api/materials/attachments/${uploaded.attachment.id}/download`, ordinary)).bytes.toString('utf8'), 'safe fixture attachment');
  const receipt = (await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order), 201)).data.receipt;
  await f.request('POST', `/api/materials/receipts/${receipt.id}/attachments`, ordinary, { ...attachment, reason: '无权追加' }, 403);
  const document = (await f.request('POST', `/api/materials/receipts/${receipt.id}/attachments`, s.material, { ...attachment, reason: '验收凭证' }, 201)).data.attachment;
  await f.request('GET', `/api/materials/receipts/${receipt.id}/attachments`, ordinary, undefined, 403);
  await f.request('GET', `/api/materials/attachments/${document.id}/download`, ordinary, undefined, 403);
  assert.equal((await f.request('GET', `/api/materials/attachments/${document.id}/download`, s.material)).bytes.toString('utf8'), 'safe fixture attachment');
  await f.request('DELETE', `/api/materials/attachments/${document.id}`, s.material, { reason: '不能删除已记账附件' }, 403);
});

test('server removes monetary fields recursively and generates genuine XLSX with text-safe formula-like user input', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('FINANCE');
  const exporter = await f.customAccount('EXPORT_ONLY', ['materials.export', 'backup.read']);
  const formula = '=HYPERLINK("https://example.invalid","safe-text")';
  const catalog = await f.catalog(s.category.id, { code: 'MAT-FORMULA', name: formula });
  let order = await f.submit(await f.order(ordinary, f.item({ ...s, catalog }, { purpose: '+SUM(1,2)' }), formula));
  order = (await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { quantity: '2', amount: '123.45' }), 201)).data.request;
  order = (await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, s.material, { requestVersion: order.version, version: order.items[0].version, quantity: '11', reason: '数量修订' })).data;
  for (const route of ['/api/materials/stock', '/api/materials/stock/movements', '/api/materials/receipts', `/api/materials/requests/${order.id}`, `/api/materials/requests/${order.id}/revisions`, '/api/materials/acceptance']) assertNoMoney((await f.request('GET', route, ordinary)).data);
  await f.request('GET', '/api/materials/backup', exporter, undefined, 403);
  const legacyBackup = (await f.request('GET', '/api/backup', exporter)).data;
  assert.ok(legacyBackup.excludedModules.some(name => name.includes('materials')));
  assert.equal(legacyBackup.materials, undefined, 'generic backup must not leak the new business tables');
  await f.request('GET', '/api/materials/export.xlsx?type=stock', ordinary, undefined, 403);
  for (const actor of [s.material, exporter]) {
    for (const route of [`/api/materials/export.xlsx?type=requests&requestId=${order.id}`, `/api/materials/export.xlsx?type=requests&requestId=${order.id}&version=original`, '/api/materials/export.xlsx?type=stock']) {
      const response = await f.request('GET', route, actor);
      assert.match(response.headers.get('content-type'), /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
      const entries = workbookXml(response.bytes), xml = [...entries].filter(([name]) => name.startsWith('xl/')).map(([, value]) => value).join('\n');
      assert.match(xml, /HYPERLINK/); assert.match(xml, /safe-text/);
      for (const [name, value] of entries) if (name.startsWith('xl/worksheets/')) assert.doesNotMatch(value, /<f(?:\s|>)/, 'user input became an Excel formula');
      if (actor === exporter) assert.doesNotMatch(xml, /金额|amountCents|含税总额/);
    }
  }
});

test('XLSX keeps all material detail rows while limiting large revision snapshot cells to the Excel text limit', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  let order = await f.order(s.material, null, '大量明细导出');
  const purpose = '🔬'.repeat(500);
  for (let index = 0; index < 30; index++) order = await f.add(order, s.material, f.item(s, { purpose }));
  order = await f.submit(order);
  order = (await f.request('PATCH', `/api/materials/requests/${order.id}`, s.material, { requestVersion: order.version, title: '大量明细导出修订', reason: '验证大快照导出' })).data;
  const history = (await f.request('GET', `/api/materials/requests/${order.id}/revisions`, s.material)).data;
  assert.ok(JSON.stringify(history.revisions[0].before).length > 32767);
  assert.equal(history.revisions[0].before.items.length, 30); assert.equal(history.revisions[0].after.items.length, 30);
  for (const version of ['current', 'original']) {
    const response = await f.request('GET', `/api/materials/export.xlsx?type=requests&requestId=${order.id}&version=${version}`, s.material);
    const entries = workbookXml(response.bytes);
    const detail = entries.get('xl/worksheets/sheet2.xml');
    assert.equal([...detail.matchAll(/<row(?:\s|>)/g)].length, 31, 'all thirty detail lines plus the heading must be exported');
    const xml = [...entries].filter(([name]) => name.startsWith('xl/')).map(([, value]) => value).join('\n');
    const decodeXml = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
    const texts = [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1]));
    assert.ok(texts.every(text => text.length <= 32767), 'Excel cell text cannot exceed 32767 UTF-16 code units');
    const snapshots = texts.filter(text => text.includes('完整快照见修订历史/物资备份'));
    assert.ok(snapshots.length >= 2, 'both large before/after snapshots must state where the full history is kept');
    for (const snapshot of snapshots) assert.doesNotMatch(snapshot.slice(0, snapshot.indexOf('…（完整快照')), /[\uD800-\uDBFF]$/, 'truncation must preserve surrogate pairs');
  }
});

test('complete materials backup restores relationships, snapshots, attachments, actor mapping and balances into an empty business database only', { timeout: 45000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  await f.request('POST', '/api/materials/stock/opening', s.material, { catalogId: s.catalog.id, regionId: s.otherRegion.id, warehouse: 'REAGENT', quantity: '2', amount: '22.22', batch: 'OPEN-RESTORE', requestIdempotencyKey: key() }, 201);
  let order = await f.order(ordinary, f.item(s));
  const attachmentText = 'HTTP attachment fixture';
  const uploaded = (await f.request('POST', `/api/materials/requests/${order.id}/attachments`, ordinary, { requestVersion: order.version, name: 'fixture.txt', mimeType: 'text/plain', content: Buffer.from(attachmentText).toString('base64') }, 201)).data;
  order = await f.submit(uploaded.request);
  const acceptedBody = f.receiptBody(order, { quantity: '3', amount: '33.33', batch: 'RECEIPT-RESTORE' });
  order = (await f.request('POST', '/api/materials/receipts', s.material, acceptedBody, 201)).data.request;
  order = (await f.request('PATCH', `/api/materials/requests/${order.id}/items/${order.items[0].id}`, s.material, { requestVersion: order.version, version: order.items[0].version, quantity: '11', purpose: '修订说明', reason: '备份历史修订' })).data;
  const backup = (await f.request('GET', '/api/materials/backup', f.admin)).data;
  assert.doesNotMatch(JSON.stringify(backup), /materials-test-password|fixture-user-password|scrypt\$/);
  const beforeStock = (await f.request('GET', '/api/materials/stock', s.material)).data.items;
  const beforeReceipts = (await f.request('GET', '/api/materials/receipts', s.material)).data.items;
  const beforeRevisions = (await f.request('GET', `/api/materials/requests/${order.id}/revisions`, s.material)).data;
  const target = await fixture(t);
  await target.account('TESTER'); await target.account('MATERIAL');
  const targetMaterial = await target.account('MATERIAL'), targetOrdinary = await target.account('TESTER');
  assert.notEqual(targetMaterial.id, s.material.id, 'fixture must exercise username-to-current-ID mapping');
  const unknownScope = structuredClone(backup); unknownScope.scope = 'filtered';
  await target.request('POST', '/api/materials/restore', target.admin, unknownScope, 400);
  const unknownUserField = structuredClone(backup); unknownUserField.users[0].password = 'synthetic-extra-field';
  await target.request('POST', '/api/materials/restore', target.admin, unknownUserField, 400);
  const reopenedOpening = structuredClone(backup);
  reopenedOpening.data.material_state.find(row => row.key === 'opening_closed').value = '0';
  await target.request('POST', '/api/materials/restore', target.admin, reopenedOpening, 400);
  const missingUser = structuredClone(backup);
  missingUser.users.find(user => user.id === ordinary.id).username = 'missing-restore-account';
  await target.request('POST', '/api/materials/restore', target.admin, missingUser, 400);
  const damagedLedger = structuredClone(backup);
  damagedLedger.data.material_stock_movements.find(row => row.receipt_id).amount_cents += 1;
  await target.request('POST', '/api/materials/restore', target.admin, damagedLedger, 400);
  for (const name of ['requests', 'categories', 'stock', 'receipts']) assert.equal((await target.request('GET', '/api/materials/' + name, targetMaterial)).data.items.length, 0, 'failed restore must roll back ' + name);
  const restoredFiles = path.join(target.runtime, 'uploads/materials');
  assert.equal(fs.existsSync(restoredFiles) ? fs.readdirSync(restoredFiles).length : 0, 0, 'failed restore must remove newly written attachments');
  assert.equal((await target.request('GET', '/api/materials/meta', targetMaterial)).data.openingClosed, false);
  await target.request('POST', '/api/materials/restore', target.admin, backup);
  const restored = await target.get(order.id, targetMaterial);
  assert.equal(restored.createdBy, targetOrdinary.id); assert.equal(restored.items[0].authorId, targetOrdinary.id);
  assert.equal(restored.revision, order.revision); assert.equal(restored.items[0].acceptedQtyM, 3000); assert.equal(restored.items[0].qtyM, 11000);
  const afterStock = (await target.request('GET', '/api/materials/stock', targetMaterial)).data.items;
  assert.deepEqual(afterStock.map(({ catalogId, regionId, warehouse, qtyM, amountCents }) => ({ catalogId, regionId, warehouse, qtyM, amountCents })), beforeStock.map(({ catalogId, regionId, warehouse, qtyM, amountCents }) => ({ catalogId, regionId, warehouse, qtyM, amountCents })));
  const afterReceipts = (await target.request('GET', '/api/materials/receipts', targetMaterial)).data.items;
  assert.equal(afterReceipts.length, beforeReceipts.length); assert.equal(afterReceipts[0].actorId, targetMaterial.id);
  const users = new Map([[f.admin.id, target.admin.id], [s.material.id, targetMaterial.id], [ordinary.id, targetOrdinary.id]]);
  const remapUsers = value => {
    if (Array.isArray(value)) return value.map(remapUsers);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([name, entry]) =>
      [name, ['createdBy', 'submittedBy', 'authorId', 'actorId', 'userId'].includes(name) && entry !== null ? users.get(entry) : remapUsers(entry)]));
  };
  assert.deepEqual(afterReceipts[0].snapshot, remapUsers(beforeReceipts[0].snapshot));
  const revisions = (await target.request('GET', `/api/materials/requests/${order.id}/revisions`, targetMaterial)).data;
  assert.deepEqual(revisions.originalSnapshot, remapUsers(beforeRevisions.originalSnapshot));
  assert.deepEqual(revisions.revisions[0].before, remapUsers(beforeRevisions.revisions[0].before));
  assert.deepEqual(revisions.revisions[0].after, remapUsers(beforeRevisions.revisions[0].after));
  assert.equal(revisions.revisions[0].reason, beforeRevisions.revisions[0].reason);
  assert.equal(revisions.revisions[0].actorId, targetMaterial.id);
  const attachments = (await target.request('GET', `/api/materials/requests/${order.id}/attachments`, targetOrdinary)).data.items;
  assert.equal(attachments.length, 1);
  assert.equal((await target.request('GET', `/api/materials/attachments/${attachments[0].id}/download`, targetOrdinary)).bytes.toString('utf8'), attachmentText);
  assert.equal((await target.request('GET', '/api/materials/meta', targetMaterial)).data.openingClosed, true);
  const replay = (await target.request('POST', '/api/materials/receipts', targetMaterial, acceptedBody)).data;
  assert.equal(replay.receipt.id, beforeReceipts[0].id);
  assert.equal((await target.request('GET', '/api/materials/receipts', targetMaterial)).data.items.length, beforeReceipts.length);
  await target.request('POST', '/api/materials/restore', target.admin, backup, 409);
  assert.deepEqual((await target.request('GET', '/api/materials/stock', targetMaterial)).data.items, afterStock);
  await f.request('POST', '/api/materials/restore', f.admin, backup, 409);
});

test('stock locations are exact-batch metadata with role permissions, optimistic versions and no balance changes', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const identity = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'MAIN', batch: '', expiryDate: '' };
  for (const batch of ['', 'OTHER']) await f.request('POST', '/api/materials/stock/opening', s.material,
    { ...identity, batch, quantity: '3', amount: '1.00', requestIdempotencyKey: key() }, 201);
  const query = '/api/materials/stock/batches?' + new URLSearchParams(identity);
  const initial = (await f.request('GET', query, ordinary)).data;
  assert.equal(initial.total, 1); assert.equal(initial.items[0].location, ''); assert.equal(initial.items[0].locationVersion, 0);
  const update = { ...identity, location: '=Shelf-A/01', version: 0, reason: '建立库存位置' };
  await f.request('PUT', '/api/materials/stock/location', ordinary, update, 403);
  await f.request('PUT', '/api/materials/stock/location', s.material, { ...update, batch: 'UNKNOWN' }, 400);
  await f.request('PUT', '/api/materials/stock/location', s.material, { ...update, location: 'x'.repeat(201) }, 400);
  await f.request('PUT', '/api/materials/stock/location', s.material, { ...update, reason: '' }, 400);
  const first = (await f.request('PUT', '/api/materials/stock/location', f.admin, update)).data.location;
  assert.equal(first.version, 1); assert.equal(first.actorId, f.admin.id);
  await f.request('PUT', '/api/materials/stock/location', s.material, update, 409);
  const raced = await Promise.all(['Shelf-B/02', 'Shelf-C/03'].map(location => f.request('PUT', '/api/materials/stock/location', s.material,
    { ...update, location, version: 1 }, [200, 409])));
  assert.deepEqual(raced.map(result => result.status).sort(), [200, 409]);
  const current = (await f.request('GET', query, s.material)).data.items[0];
  assert.equal(current.locationVersion, 2); assert.equal(current.qtyM, 3000); assert.equal(current.amountCents, 100);
  assert.equal((await f.request('GET', '/api/materials/stock/movements', s.material)).data.total, 2);
  const other = (await f.request('GET', '/api/materials/stock/batches?batch=OTHER&expiryDate=', s.material)).data.items[0];
  assert.equal(other.location, ''); assert.equal(other.locationVersion, 0);
  const xml = [...workbookXml((await f.request('GET', '/api/materials/export.xlsx?type=stock', s.material)).bytes).values()].join('\n');
  assert.match(xml, /批次库存/); assert.match(xml, new RegExp(current.location));
  await f.request('PUT', '/api/permissions/roles/MATERIAL', f.admin, { permissions: ['materials.read'] });
  assert.equal((await f.request('GET', '/api/materials/meta', s.material)).data.capabilities.manageLocation, false);
  await f.request('PUT', '/api/materials/stock/location', s.material, { ...update, version: 2 }, 403);
});

test('material issues retain application snapshots, enforce own-only visibility and authorized state transitions, and export safely', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER'), other = await f.account('FINANCE');
  const exporter = await f.customAccount('ISSUE_EXPORT', ['materials.export']);
  const identity = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'MAIN', batch: 'ISSUE-A', expiryDate: '2030-01-02' };
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...identity, quantity: '4', amount: '10', requestIdempotencyKey: key() }, 201);
  await f.request('PUT', '/api/materials/stock/location', f.admin, { ...identity, location: '=Shelf-before', version: 0, reason: '放置' });
  const payload = { ...identity, quantity: '1', purpose: '=HYPERLINK("https://example.invalid","own-issue")', requestIdempotencyKey: key() };
  const issue = (await f.request('POST', '/api/materials/issues', ordinary, payload, 201)).data.issue;
  assert.equal(issue.canCancel, true); assert.equal(issue.canIssue, false); assert.equal(issue.snapshot.location, '=Shelf-before');
  assertNoMoney(issue);
  assert.equal((await f.request('POST', '/api/materials/issues', ordinary, payload)).data.issue.id, issue.id);
  await f.request('POST', '/api/materials/issues', ordinary, { ...payload, quantity: '2' }, 409);
  assert.equal((await f.request('GET', '/api/materials/issues', other)).data.total, 0);
  for (const actor of [s.material, f.admin]) assert.equal((await f.request('GET', '/api/materials/issues', actor)).data.total, 1);
  await f.request('GET', `/api/materials/issues/${issue.id}`, other, undefined, 403);
  for (const actor of [ordinary, other, f.admin]) await f.request('POST', `/api/materials/issues/${issue.id}/issue`, actor, { version: 1, requestIdempotencyKey: key() }, 403);
  await f.request('POST', `/api/materials/issues/${issue.id}/cancel`, s.material, { version: 1, reason: '管理员不能代取消', requestIdempotencyKey: key() }, 403);
  await f.request('PUT', '/api/materials/stock/location', s.material, { ...identity, location: 'Shelf-now', version: 1, reason: '移动' });
  const pending = (await f.request('GET', `/api/materials/issues/${issue.id}`, s.material)).data.issue;
  assert.equal(pending.snapshot.location, '=Shelf-before'); assert.equal(pending.location, 'Shelf-now'); assert.equal(pending.canIssue, true);
  const action = { version: 1, requestIdempotencyKey: key() };
  await f.request('POST', `/api/materials/issues/${issue.id}/issue`, s.material, { ...action, version: 2 }, 409);
  const issued = (await f.request('POST', `/api/materials/issues/${issue.id}/issue`, s.material, action, 201)).data.issue;
  assert.equal(issued.status, 'issued'); assert.equal(issued.version, 2); assert.equal(issued.amountCents, 250); assert.equal(issued.location, 'Shelf-now');
  assert.equal((await f.request('POST', `/api/materials/issues/${issue.id}/issue`, s.material, action)).data.issue.id, issue.id);
  await f.request('POST', `/api/materials/issues/${issue.id}/cancel`, ordinary, { version: 2, reason: '已发放', requestIdempotencyKey: key() }, 409);
  await f.request('POST', `/api/materials/issues/${issue.id}/reject`, s.material, { version: 2, reason: '已发放', requestIdempotencyKey: key() }, 409);
  await f.request('PUT', '/api/materials/stock/location', f.admin, { ...identity, location: 'Shelf-later', version: 2, reason: '再次移动' });
  assert.equal((await f.request('GET', `/api/materials/issues/${issue.id}`, s.material)).data.issue.location, 'Shelf-now');
  const movement = (await f.request('GET', '/api/materials/stock/movements', s.material)).data.items.find(row => row.type === 'issue');
  assert.equal(movement.issueId, issue.id); assert.equal(movement.qtyM, -1000); assert.equal(movement.amountCents, -250); assert.equal(movement.snapshot.location, 'Shelf-now');
  for (const [actor, transition, status] of [[ordinary, 'cancel', 'cancelled'], [s.material, 'reject', 'rejected']]) {
    const next = (await f.request('POST', '/api/materials/issues', ordinary, { ...payload, requestIdempotencyKey: key() }, 201)).data.issue;
    const body = { version: 1, reason: '申请取消或驳回', requestIdempotencyKey: key() };
    const result = (await f.request('POST', `/api/materials/issues/${next.id}/${transition}`, actor, body, 201)).data.issue;
    assert.equal(result.status, status); assert.equal(result.processedBy, actor.id);
    await f.request('POST', `/api/materials/issues/${next.id}/issue`, s.material, { version: 2, requestIdempotencyKey: key() }, 409);
  }
  await f.request('POST', '/api/materials/issues', other, { ...payload, purpose: 'other-private-issue', requestIdempotencyKey: key() }, 201);
  const own = (await f.request('GET', '/api/materials/issues?q=own-issue&status=issued&pageSize=1', ordinary)).data;
  assert.equal(own.total, 1); assert.equal(own.items[0].id, issue.id); assertNoMoney(own);
  await f.request('POST', '/api/materials/issues', exporter, { ...payload, purpose: '+SUM(own-export)', requestIdempotencyKey: key() }, 201);
  const ownExport = workbookXml((await f.request('GET', '/api/materials/export.xlsx?type=issues', exporter)).bytes);
  const xml = [...ownExport.values()].join('\n');
  assert.match(xml, /own-export/); assert.doesNotMatch(xml, /other-private-issue|own-issue|金额|amountCents/);
  for (const [name, text] of ownExport) if (name.startsWith('xl/worksheets/')) assert.doesNotMatch(text, /<f(?:\s|>)/);
  const adminXml = [...workbookXml((await f.request('GET', '/api/materials/export.xlsx?type=issues&status=issued', s.material)).bytes).values()].join('\n');
  assert.match(adminXml, /HYPERLINK/); assert.match(adminXml, /Shelf-now/); assert.doesNotMatch(adminXml, /other-private-issue/);
  await f.request('PUT', '/api/permissions/roles/MATERIAL', f.admin, { permissions: ['materials.read'] });
  assert.equal((await f.request('GET', '/api/materials/meta', s.material)).data.capabilities.issueStock, false);
  await f.request('POST', `/api/materials/issues/${issue.id}/issue`, s.material, action, 403);
});

test('issue processing serializes concurrent unreserved applications, allocates current batch cost and depletes all remaining cents', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const identity = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'MAIN', batch: 'COST', expiryDate: '' };
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...identity, quantity: '3', amount: '1.00', requestIdempotencyKey: key() }, 201);
  const apply = async quantity => (await f.request('POST', '/api/materials/issues', ordinary, { ...identity, quantity, purpose: '成本分摊', requestIdempotencyKey: key() }, 201)).data.issue;
  const first = await apply('1'), full = await apply('3');
  assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.items[0].qtyM, 3000, 'applications do not reserve stock');
  const firstBody = { version: 1, requestIdempotencyKey: key() };
  const same = await Promise.all([0, 1].map(() => f.request('POST', `/api/materials/issues/${first.id}/issue`, s.material, firstBody, [200, 201])));
  assert.deepEqual(same.map(result => result.status).sort(), [200, 201]);
  assert.ok(same.every(result => result.data.issue.amountCents === 33));
  await f.request('POST', `/api/materials/issues/${full.id}/issue`, s.material, { version: 1, requestIdempotencyKey: key() }, 409);
  const a = await apply('2'), b = await apply('2');
  const competed = await Promise.all([a, b].map(issue => f.request('POST', `/api/materials/issues/${issue.id}/issue`, s.material,
    { version: 1, requestIdempotencyKey: key() }, [201, 409])));
  assert.deepEqual(competed.map(result => result.status).sort(), [201, 409]);
  assert.equal(competed.find(result => result.status === 201).data.issue.amountCents, 67);
  const zero = (await f.request('GET', '/api/materials/stock/batches?batch=COST&expiryDate=', s.material)).data.items[0];
  assert.equal(zero.qtyM, 0); assert.equal(zero.amountCents, 0);
  assert.equal((await f.request('GET', '/api/materials/stock/movements', s.material)).data.items.filter(row => row.type === 'issue').length, 2);
  const gift = { ...identity, batch: 'GIFT' };
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...gift, quantity: '2', amount: '0', zeroAmountReason: '赠品', requestIdempotencyKey: key() }, 201);
  const free = (await f.request('POST', '/api/materials/issues', ordinary, { ...gift, quantity: '1', purpose: '赠品领用', requestIdempotencyKey: key() }, 201)).data.issue;
  assert.equal((await f.request('POST', `/api/materials/issues/${free.id}/issue`, s.material, { version: 1, requestIdempotencyKey: key() }, 201)).data.issue.amountCents, 0);
  const changed = { ...identity, batch: 'CURRENT' };
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...changed, quantity: '2', amount: '2.00', requestIdempotencyKey: key() }, 201);
  const pending = (await f.request('POST', '/api/materials/issues', ordinary, { ...changed, quantity: '1', purpose: '按发放时成本', requestIdempotencyKey: key() }, 201)).data.issue;
  await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...changed, direction: 'increase', quantity: '1', amount: '4.00', reason: '追加成本', requestIdempotencyKey: key() }, 201);
  assert.equal((await f.request('POST', `/api/materials/issues/${pending.id}/issue`, s.material, { version: 1, requestIdempotencyKey: key() }, 201)).data.issue.amountCents, 200);
});

test('issue cost calculation preserves safe integers when multiplication exceeds Number precision and rounds half up', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  const identity = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'MAIN', batch: 'BIGINT', expiryDate: '' };
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...identity, quantity: '9007199254740.991', amount: '90071992547409.90', requestIdempotencyKey: key() }, 201);
  const q = 3002399751580331n, amount = 9007199254740990n, total = 9007199254740991n;
  const issue = (await f.request('POST', '/api/materials/issues', s.material, { ...identity, quantity: '3002399751580.331', purpose: '安全整数成本', requestIdempotencyKey: key() }, 201)).data.issue;
  const issued = (await f.request('POST', `/api/materials/issues/${issue.id}/issue`, s.material, { version: 1, requestIdempotencyKey: key() }, 201)).data.issue;
  assert.equal(issued.amountCents, Number((amount * q + total / 2n) / total));
  const half = { ...identity, regionId: s.otherRegion.id, batch: 'HALF' };
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...half, quantity: '2', amount: '0.01', requestIdempotencyKey: key() }, 201);
  const halfIssue = (await f.request('POST', '/api/materials/issues', s.material, { ...half, quantity: '1', purpose: '半入', requestIdempotencyKey: key() }, 201)).data.issue;
  assert.equal((await f.request('POST', `/api/materials/issues/${halfIssue.id}/issue`, s.material, { version: 1, requestIdempotencyKey: key() }, 201)).data.issue.amountCents, 1);
});

test('materials upgrade expands the stock CHECK atomically while retaining rows, foreign keys, indices, triggers and sequence high water', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT); INSERT INTO users VALUES(1,\'upgrade-user\',\'Upgrade user\')');
    const options = { db, body: async () => ({}), send() {}, fail: (status, message) => Object.assign(new Error(message), { status }),
      log() {}, hasPermission: () => true, tokenUser: () => null, uploads: root };
    createMaterials(options);
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='material_stock_movements'").get().sql;
    db.exec('DROP TABLE material_stock_movements');
    db.exec(schema.replace(",'issue'", ''));
    db.exec(`INSERT INTO material_categories(id,name,created_by) VALUES(1,'Category',1);
      INSERT INTO material_regions(id,name,created_by) VALUES(1,'Region',1);
      INSERT INTO material_catalog(id,code,name,spec,unit,category_id,created_by) VALUES(1,'UP','Upgrade','1','piece',1,1);
      CREATE INDEX material_upgrade_extra ON material_stock_movements(batch,expiry_date);
      CREATE TRIGGER material_upgrade_trigger AFTER INSERT ON material_stock_movements BEGIN SELECT 1; END;`);
    const snapshot = JSON.stringify({ catalogId: 1, regionId: 1, warehouse: 'MAIN', code: 'UP', name: 'Upgrade', spec: '1', unit: 'piece' });
    const insert = db.prepare(`INSERT INTO material_stock_movements(id,type,catalog_id,region_id,warehouse,qty_m,amount_cents,source_key,snapshot,date,actor_id)
      VALUES(?,'opening',1,1,'MAIN',1000,100,?,?,'2026-10-17',1)`);
    insert.run(1, 'opening:kept', snapshot); insert.run(100, 'opening:deleted', snapshot);
    db.exec('DELETE FROM material_stock_movements WHERE id=100');
    const before = db.prepare('SELECT * FROM material_stock_movements').all();
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    createMaterials(options);
    assert.deepEqual(db.prepare('SELECT * FROM material_stock_movements').all(), before);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='material_stock_movements'").get().sql, /'issue'/);
    for (const name of ['material_stock_key', 'material_upgrade_extra', 'material_upgrade_trigger']) assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
    assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='material_stock_movements'").get().seq, 100);
    const added = db.prepare(`INSERT INTO material_stock_movements(type,catalog_id,region_id,warehouse,qty_m,amount_cents,source_key,snapshot,date,actor_id)
      VALUES('issue',1,1,'MAIN',-1000,-100,'issue:1',?,'2026-10-17',1)`).run(snapshot);
    assert.equal(added.lastInsertRowid, 101);
    createMaterials(options);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM material_stock_movements').get().n, 2);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});

test('schema 2 backups restore issue sources, locations and user mapping; damaged ledger states fail atomically and strict schema 1 remains compatible', { timeout: 45000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER'), other = await f.account('FINANCE');
  const identity = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'MAIN', batch: 'BACKUP-ISSUE', expiryDate: '2030-05-06' };
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...identity, quantity: '4', amount: '1.01', requestIdempotencyKey: key() }, 201);
  const legacy = structuredClone((await f.request('GET', '/api/materials/backup', f.admin)).data);
  legacy.schemaVersion = 1; delete legacy.data.material_stock_locations; delete legacy.data.material_issues;
  await f.request('PUT', '/api/materials/stock/location', s.material, { ...identity, location: 'Backup A', version: 0, reason: '备份位置' });
  const applyBody = { ...identity, quantity: '1', purpose: '备份发放', requestIdempotencyKey: key() };
  const issue = (await f.request('POST', '/api/materials/issues', ordinary, applyBody, 201)).data.issue;
  await f.request('PUT', '/api/materials/stock/location', f.admin, { ...identity, location: 'Backup B', version: 1, reason: '发放前移动' });
  const issueBody = { version: 1, requestIdempotencyKey: key() };
  await f.request('POST', `/api/materials/issues/${issue.id}/issue`, s.material, issueBody, 201);
  const pending = (await f.request('POST', '/api/materials/issues', ordinary, { ...applyBody, quantity: '2', requestIdempotencyKey: key() }, 201)).data.issue;
  const rejected = (await f.request('POST', '/api/materials/issues', other, { ...applyBody, requestIdempotencyKey: key() }, 201)).data.issue;
  await f.request('POST', `/api/materials/issues/${rejected.id}/reject`, s.material, { version: 1, reason: '备份驳回', requestIdempotencyKey: key() }, 201);
  const cancelled = (await f.request('POST', '/api/materials/issues', ordinary, { ...applyBody, requestIdempotencyKey: key() }, 201)).data.issue;
  await f.request('POST', `/api/materials/issues/${cancelled.id}/cancel`, ordinary, { version: 1, reason: '备份取消', requestIdempotencyKey: key() }, 201);
  const backup = (await f.request('GET', '/api/materials/backup', f.admin)).data;
  assert.equal(backup.schemaVersion, 2); assert.equal(backup.data.material_issues.length, 4); assert.equal(backup.data.material_stock_locations.length, 1);
  const target = await fixture(t);
  await target.account('FINANCE'); const targetOrdinary = await target.account('TESTER'), targetMaterial = await target.account('MATERIAL');
  assert.notEqual(targetMaterial.id, s.material.id);
  const changes = [
    payload => { payload.data.material_stock_movements = payload.data.material_stock_movements.filter(row => row.type !== 'issue'); },
    payload => { payload.data.material_stock_movements.find(row => row.type === 'issue').amount_cents -= 1; },
    payload => { payload.data.material_stock_movements.find(row => row.type === 'issue').qty_m -= 1; },
    payload => { payload.data.material_stock_movements.find(row => row.type === 'issue').source_key = 'issue:999'; },
    payload => { payload.data.material_issues.find(row => row.id === pending.id).status = 'issued'; },
    payload => { payload.data.material_issues.find(row => row.id === issue.id).version = 1; },
    payload => { payload.data.material_issues.find(row => row.id === issue.id).processed_by = ordinary.id; },
    payload => { payload.data.material_issues.find(row => row.id === cancelled.id).processed_by = s.material.id; },
    payload => { const row = payload.data.material_issues[0]; row.snapshot = JSON.stringify({ ...JSON.parse(row.snapshot), batch: 'OTHER' }); },
    payload => { payload.data.material_stock_locations[0].batch = 'MISSING'; },
    payload => { payload.data.material_stock_locations[0].location = 'x'.repeat(201); },
    payload => { payload.data.material_issues[0].snapshot = 'null'; },
    payload => { payload.data.material_stock_movements[0].qty_m = 1; },
    payload => { const row = payload.data.material_issues.find(row => row.id === issue.id); row.amount_cents += 1; payload.data.material_stock_movements.find(row => row.type === 'issue').amount_cents -= 1; }
  ];
  for (const change of changes) {
    const damaged = structuredClone(backup); change(damaged);
    await target.request('POST', '/api/materials/restore', target.admin, damaged, 400);
    assert.equal((await target.request('GET', '/api/materials/issues', targetMaterial)).data.total, 0);
    assert.equal((await target.request('GET', '/api/materials/stock', targetMaterial)).data.total, 0);
  }
  await target.request('POST', '/api/materials/restore', target.admin, backup);
  const restored = (await target.request('GET', `/api/materials/issues/${issue.id}`, targetMaterial)).data.issue;
  assert.equal(restored.createdBy, targetOrdinary.id); assert.equal(restored.snapshot.createdBy, targetOrdinary.id); assert.equal(restored.processedBy, targetMaterial.id);
  assert.equal(restored.snapshot.location, 'Backup A'); assert.equal(restored.location, 'Backup B'); assert.equal(restored.amountCents, 25);
  const location = (await target.request('GET', '/api/materials/stock/batches', targetMaterial)).data.items[0];
  assert.equal(location.location, 'Backup B'); assert.equal(location.locationVersion, 2); assert.equal(location.qtyM, 3000); assert.equal(location.amountCents, 76);
  const replay = (await target.request('POST', `/api/materials/issues/${issue.id}/issue`, targetMaterial, issueBody)).data.issue;
  assert.equal(replay.id, issue.id); assert.equal(replay.createdBy, targetOrdinary.id); assert.equal(replay.processedBy, targetMaterial.id);
  await target.request('POST', '/api/materials/issues', targetOrdinary, applyBody);
  assert.equal((await target.request('GET', '/api/materials/issues', targetMaterial)).data.total, 4);
  const oldTarget = await fixture(t); await oldTarget.account('TESTER'); await oldTarget.account('FINANCE'); const oldMaterial = await oldTarget.account('MATERIAL');
  const mixedSchema = structuredClone(legacy); mixedSchema.data.material_issues = [];
  await oldTarget.request('POST', '/api/materials/restore', oldTarget.admin, mixedSchema, 400);
  const missingColumn = structuredClone(legacy); delete missingColumn.data.material_stock_movements[0].batch;
  await oldTarget.request('POST', '/api/materials/restore', oldTarget.admin, missingColumn, 400);
  const extraColumn = structuredClone(legacy); extraColumn.data.material_stock_movements[0].issue_id = null;
  await oldTarget.request('POST', '/api/materials/restore', oldTarget.admin, extraColumn, 400);
  await oldTarget.request('POST', '/api/materials/restore', oldTarget.admin, legacy);
  assert.equal((await oldTarget.request('GET', '/api/materials/issues', oldMaterial)).data.total, 0);
  const oldStock = (await oldTarget.request('GET', '/api/materials/stock/batches', oldMaterial)).data.items[0];
  assert.equal(oldStock.qtyM, 4000); assert.equal(oldStock.amountCents, 101); assert.equal(oldStock.location, ''); assert.equal(oldStock.locationVersion, 0);
});
