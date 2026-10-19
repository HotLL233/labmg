const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const createMaterials = require('../src/materials');
const { createTestDatabase } = require('./helpers/postgres');

const root = path.resolve(__dirname, '..');
const key = () => crypto.randomUUID();

async function fixture(t) {
  const postgres = await createTestDatabase(t);
  const db = await postgres.open();
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
    env: { ...process.env, DATABASE_URL: postgres.url, PORT: String(port), LABOS_RUNTIME_DIR: runtime, LABOS_ADMIN_USER: 'materials-admin', LABOS_ADMIN_PASSWORD: 'materials-test-password' }
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
  const catalog = async (categoryId, extra = {}) => (await request('POST', '/api/materials/catalog', admin, { code: 'MAT-HTTP-A', name: extra.code ? 'HTTP reagent ' + extra.code : 'HTTP reagent', spec: '500 mL', unit: '瓶', categoryId, ...extra }, 201)).data;
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
  return { directory, runtime, db, request, account, customAccount, admin, get, dictionary, catalog, seed, add, order, submit, receiptBody, item };
}

function assertNoMoney(value) {
  if (Array.isArray(value)) { for (const entry of value) assertNoMoney(entry); return; }
  if (!value || typeof value !== 'object') return;
  for (const [name, entry] of Object.entries(value)) {
    assert.ok(!/(?:amountCents|cents|amount|totalAmount|unitPrice|unitCost)$/i.test(name), 'amount leaked at ' + name);
    assertNoMoney(entry);
  }
}

function legacyBackup(value, schemaVersion) {
  const result = structuredClone(value);
  result.schemaVersion = schemaVersion;
  delete result.data.material_openings;
  delete result.data.material_opening_items;
  delete result.data.material_stock_units;
  for (const row of result.data.material_catalog) delete row.tracking_mode;
  result.data.material_state = result.data.material_state.filter(row => ['opening_closed', 'restored_once'].includes(row.key));
  if (schemaVersion < 3) delete result.data.material_barcodes;
  if (schemaVersion < 2) { delete result.data.material_stock_locations; delete result.data.material_issues; }
  return result;
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

async function openingExcel(rows) {
  const { LEGACY_OPENING_HEADERS: OPENING_HEADERS } = require('../src/material-xlsx');
  const cell = value => value && typeof value === 'object' ? value : typeof value === 'number' ? { type: Number, value } : { type: String, value: String(value ?? '') };
  return require('write-excel-file/node').default([{ sheet: '期初明细', data: [OPENING_HEADERS.map(cell), ...rows.map(row => row.map(cell))] }]).toBuffer();
}

async function catalogExcel(rows) {
  const { LEGACY_CATALOG_HEADERS: CATALOG_HEADERS } = require('../src/material-xlsx');
  const cell = value => value && typeof value === 'object' ? value : ({ type: String, value: String(value ?? '') });
  return require('write-excel-file/node').default([{ sheet: '物资信息', data: [CATALOG_HEADERS.map(cell), ...rows.map(row => row.map(cell))] }]).toBuffer();
}

async function namedExcel(headers, rows) {
  const cell = value => ({ type: typeof value === 'number' ? Number : String, value });
  return require('write-excel-file/node').default([{ sheet: '中文明细', data: [headers.map(cell), ...rows.map(row => row.map(cell))] }]).toBuffer();
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

test('catalog candidates prioritize selected stock and reuse exact material identity even at zero stock without merging different specifications', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const stocked = await f.catalog(s.category.id, { code: 'STOCKED', name: 'AAA elsewhere' });
  const zero = await f.catalog(s.category.id, { code: 'ZERO', name: 'AAA zero' });
  await f.request('POST', '/api/materials/stock/opening', s.material, { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'MAIN', quantity: '2', amount: '3', requestIdempotencyKey: key() }, 201);
  await f.request('POST', '/api/materials/stock/opening', s.material, { catalogId: stocked.id, regionId: s.otherRegion.id, warehouse: 'MAIN', quantity: '9', amount: '10', requestIdempotencyKey: key() }, 201);
  const query = `/api/materials/catalog?regionId=${s.region.id}&warehouse=MAIN`;
  const candidates = (await f.request('GET', query, ordinary)).data;
  assert.deepEqual(candidates.items.map(row => row.id), [s.catalog.id, stocked.id, zero.id]);
  assert.deepEqual(candidates.items.map(row => [row.stockQtyM, row.localQtyM]), [[2000, 2000], [9000, 0], [0, 0]]);
  assertNoMoney(candidates);
  const second = (await f.request('GET', query + '&pageSize=1&page=2', ordinary)).data;
  assert.equal(second.total, 3); assert.equal(second.items[0].id, stocked.id);
  assert.equal((await f.request('GET', '/api/materials/catalog?trackingMode=unit', ordinary)).data.total, 0);
  let order = await f.order(ordinary, { ...f.item(s), catalogId: null, name: '  ＨＴＴＰ reagent ', spec: '500 mL', unit: '瓶', code: '' });
  assert.equal(order.items[0].catalogId, s.catalog.id);
  order = await f.order(ordinary, { ...f.item(s), catalogId: null, name: zero.name.toUpperCase(), spec: zero.spec, unit: zero.unit, code: '' });
  assert.equal(order.items[0].catalogId, zero.id, 'zero balance must still reuse material information');
  order = await f.order(ordinary, { ...f.item(s), catalogId: null, name: s.catalog.name, spec: '1 L', unit: '瓶', code: '' });
  assert.equal(order.items[0].catalogId, null, 'same name with a different specification is new');
  await f.request('POST', `/api/materials/requests/${order.id}/items`, ordinary, { requestVersion: order.version, ...f.item(s), catalogId: null, code: s.catalog.code, name: 'another material', spec: s.catalog.spec, unit: s.catalog.unit }, 409);
  await f.request('POST', '/api/materials/catalog', f.admin, { ...s.catalog, code: 'DUPLICATE-IDENTITY', name: 'ＨＴＴＰ reagent', trackingMode: 'quantity' }, 409);
  const unit = await f.catalog(s.category.id, { code: 'AUTO-UNIT', name: 'Integer-only unit', trackingMode: 'unit' });
  const before = await f.get(order.id, ordinary);
  await f.request('POST', `/api/materials/requests/${order.id}/items`, ordinary, { requestVersion: before.version, ...f.item(s), catalogId: null, code: '', name: unit.name, spec: unit.spec, unit: unit.unit, quantity: '1.5' }, 400);
  assert.deepEqual(await f.get(order.id, ordinary), before, 'invalid automatically matched unit quantity must leave the request unchanged');
  await f.db.prepare('INSERT INTO material_catalog(code,name,spec,unit,category_id,created_by) VALUES(?,?,?,?,?,?)').run('SYNTHETIC-AMBIGUITY', s.catalog.name, s.catalog.spec, s.catalog.unit, s.category.id, f.admin.id);
  await f.request('POST', `/api/materials/requests/${order.id}/items`, ordinary, { requestVersion: order.version, ...f.item(s), catalogId: null, code: '', name: s.catalog.name, spec: s.catalog.spec, unit: s.catalog.unit }, 409);
});

test('creating and linking new material information is atomic, controlled, versioned and idempotent while preserving the submitted original', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const free = { ...f.item(s), catalogId: null, name: 'new unit material', code: '', spec: '250 mL', unit: '瓶', quantity: '2' };
  let order = await f.submit(await f.order(ordinary, free), s.material);
  const route = `/api/materials/requests/${order.id}/items/${order.items[0].id}/catalog`;
  const original = (await f.request('GET', `/api/materials/requests/${order.id}/revisions`, s.material)).data.originalSnapshot;
  const payload = { code: 'NEW-LINKED', name: free.name, spec: free.spec, unit: free.unit, categoryId: s.category.id, trackingMode: 'unit',
    requestVersion: order.version, itemVersion: order.items[0].version, reason: '核对规格后建立信息', requestIdempotencyKey: key() };
  for (const actor of [ordinary, f.admin]) await f.request('POST', route, actor, payload, 403);
  await f.request('POST', route, s.material, { ...payload, reason: '' }, 400);
  await f.request('POST', route, s.material, { ...payload, requestVersion: 1 }, 409);
  const responses = await Promise.all([f.request('POST', route, s.material, payload, [200, 201]), f.request('POST', route, s.material, payload, [200, 201])]);
  assert.deepEqual(responses.map(row => row.status).sort(), [200, 201]);
  assert.deepEqual(responses[0].data, responses[1].data);
  order = responses[0].data.request;
  assert.equal(order.revision, 2); assert.ok(order.items[0].catalogId); assert.equal(order.items[0].version, payload.itemVersion + 1);
  const revisions = (await f.request('GET', `/api/materials/requests/${order.id}/revisions`, s.material)).data;
  assert.deepEqual(revisions.originalSnapshot, original); assert.equal(revisions.revisions.length, 1);
  assert.equal(revisions.revisions[0].reason, payload.reason);
  assert.equal(revisions.revisions[0].before.items[0].catalogId, null);
  assert.equal(revisions.revisions[0].after.items[0].catalogId, order.items[0].catalogId);
  await f.request('POST', route, s.material, { ...payload, reason: 'changed' }, 409);
  assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.total, 0);
  const fractional = await f.submit(await f.order(ordinary, { ...free, name: 'fractional new', quantity: '1.5' }), s.material);
  await f.request('POST', `/api/materials/requests/${fractional.id}/items/${fractional.items[0].id}/catalog`, s.material,
    { ...payload, code: 'FRACTION-ROLLBACK', name: 'fractional new', requestVersion: fractional.version, itemVersion: fractional.items[0].version, requestIdempotencyKey: key() }, 400);
  assert.equal((await f.request('GET', '/api/materials/catalog?q=FRACTION-ROLLBACK', s.material)).data.total, 0, 'failed unit validation must roll back newly created information');
  assert.equal((await f.get(fractional.id)).items[0].catalogId, null);
});

test('catalog XLSX template import and export round-trip literal codes, skip identical rows and roll back the entire conflicting batch', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const noExport = await f.customAccount('CATALOG_READER', ['materials.read']);
  await f.request('GET', '/api/materials/catalog/template', noExport, undefined, 403);
  const template = await f.request('GET', '/api/materials/catalog/template', f.admin);
  assert.match([...workbookXml(template.bytes).values()].join(''), /物资信息/);
  const bytes = await catalogExcel([['00000123', '=literal name', '250 mL', '瓶', s.category.name, '逐件'], ['BULK-XLSX', 'bulk new', '1 kg', '袋', s.category.name, '数量']]);
  const payload = { name: 'materials.xlsx', content: bytes.toString('base64') };
  await f.request('POST', '/api/materials/catalog/import', ordinary, payload, 403);
  const numericCode = await catalogExcel([[{ type: Number, value: 123, format: '00000000' }, 'numeric code', '1', '瓶', s.category.name, '逐件']]);
  const numericFailure = await f.request('POST', '/api/materials/catalog/import', f.admin, { name: 'numeric.xlsx', content: numericCode.toString('base64') }, 400);
  assert.match(numericFailure.data.error, /物资编码.*文本/);
  assert.deepEqual((await f.request('POST', '/api/materials/catalog/import', f.admin, payload, 201)).data, { created: 2, skipped: 0 });
  assert.deepEqual((await f.request('POST', '/api/materials/catalog/import', f.admin, payload, 201)).data, { created: 0, skipped: 2 });
  const exported = await f.request('GET', '/api/materials/catalog/export.xlsx?q=00000123', f.admin);
  const roundTrip = await require('../src/material-xlsx').readCatalogWorkbook({ name: 'round-trip.xlsx', content: exported.bytes.toString('base64') });
  assert.deepEqual(roundTrip.headers, require('../src/material-xlsx').CATALOG_HEADERS);
  assert.deepEqual(roundTrip.rows, [{ row: 2, values: { '物资名称': '=literal name', '规格': '250 mL', '单位': '瓶', '物资分类': s.category.name, '管理方式': '逐件' } }]);
  const conflictBytes = await catalogExcel([['ROLLBACK-XLSX', 'must disappear', 'x', '盒', s.category.name, '数量'], ['00000123', 'different identity', '250 mL', '瓶', s.category.name, '逐件']]);
  const failure = await f.request('POST', '/api/materials/catalog/import', f.admin, { name: 'bad.xlsx', content: conflictBytes.toString('base64') }, 409);
  assert.match(failure.data.error, /第3行B列/);
  assert.equal(failure.data.code, 'IMPORT_VALIDATION'); assert.equal(failure.data.errors[0].row, 3);
  assert.equal((await f.request('GET', '/api/materials/catalog?q=ROLLBACK-XLSX', ordinary)).data.total, 0);
  const alias = await catalogExcel([['ALIAS', '＝literal name', '250 mL', '瓶', s.category.name, '逐件']]);
  await f.request('POST', '/api/materials/catalog/import', f.admin, { name: 'alias.xlsx', content: alias.toString('base64') }, 409);
  assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.total, 0);
  assert.equal((await f.request('GET', '/api/materials/stock/units', s.material)).data.total, 0);
  assertNoMoney((await f.request('GET', '/api/materials/catalog', ordinary)).data);
});

test('catalog import rechecks session and maintenance grants after parsing before opening its write transaction', async t => {
  const postgres = await createTestDatabase(t), db = await postgres.open();
  await db.exec("INSERT INTO users(id,username,display_name) VALUES(1,'catalog-import','Synthetic'); INSERT INTO material_categories(id,name,created_by) VALUES(1,'分类',1)");
  const authorized = { id: 1, role: 'MATERIAL', permissions: ['materials.read', 'materials.catalog.write'] };
  const bytes = await catalogExcel([['SESSION-IMPORT', '物资', '规格', '瓶', '分类', '逐件']]);
  let reads = 0, fresh = authorized, response;
  const materials = createMaterials({ db, body: async () => ({ name: 'race.xlsx', content: bytes.toString('base64') }), send: (_res, status, data) => { response = { status, data }; },
    fail: (status, message) => Object.assign(new Error(message), { status }), log() {}, hasPermission: (user, permission) => user.permissions.includes(permission),
    tokenUser: () => ++reads === 1 ? authorized : fresh, uploads: path.join(root, 'artifacts/cache', require('../package.json').version, 'unused-catalog-import-test') });
  for (const [current, status] of [[null, 401], [{ ...authorized, permissions: ['materials.read'] }, 403], [{ ...authorized, role: 'TESTER' }, 403]]) {
    reads = 0; fresh = current;
    await assert.rejects(materials.handle({ method: 'POST' }, {}, new URL('http://localhost/api/materials/catalog/import')), { status });
    assert.equal(reads, 2); assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM material_catalog').get()).total, 0);
  }
  reads = 0; fresh = authorized;
  await materials.handle({ method: 'POST' }, {}, new URL('http://localhost/api/materials/catalog/import'));
  assert.deepEqual(response, { status: 201, data: { created: 1, skipped: 0 } });
});

test('Chinese catalog templates reference names, generate internal codes and round-trip without exposing code columns', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), { CATALOG_HEADERS } = require('../src/material-xlsx');
  const template = workbookXml((await f.request('GET', '/api/materials/catalog/template', f.admin)).bytes);
  assert.match(template.get('xl/workbook.xml'), /LABOS_S1_D/);
  assert.match(template.get('xl/worksheets/sheet1.xml'), /sqref="D2:D5001"/);
  assert.match(template.get('xl/worksheets/sheet1.xml'), /showErrorMessage="0"[^>]*sqref="A2:A5001"/);
  assert.doesNotMatch([...template.values()].join('\n'), /物资编码|仓库编码/);
  const automatic = (await f.request('POST', '/api/materials/catalog', f.admin, { name: '中文自动物资', spec: '100 mL', unit: '瓶', categoryId: s.category.id }, 201)).data;
  assert.match(automatic.code, /^MAT-[A-F0-9]{16}$/);
  const same = (await f.request('POST', '/api/materials/catalog', f.admin, { name: ' 中文自动物资 ', spec: '100 mL', unit: '瓶', categoryId: s.category.id }, 201)).data;
  assert.equal(same.id, automatic.id);
  const bytes = await namedExcel(CATALOG_HEADERS, [
    ['　中文自动物资　', '１００ ｍＬ', ' 瓶 ', ' ｈｔｔｐ分类 ', '数量'],
    ['中文导入耗材', '10个/包', '包', s.otherCategory.name, '数量'],
    [' 中文导入耗材 ', '１０个／包', ' 包 ', ' 另一分类 ', '数量']
  ]);
  assert.deepEqual((await f.request('POST', '/api/materials/catalog/import', f.admin, { name: '中文.xlsx', content: bytes.toString('base64') }, 201)).data, { created: 1, skipped: 2 });
  assert.equal((await f.request('GET', '/api/materials/catalog?q=中文自动物资', s.material)).data.items[0].id, automatic.id);
  assert.equal((await f.request('GET', '/api/materials/catalog?q=中文导入耗材', s.material)).data.total, 1);
  const imported = (await f.request('GET', '/api/materials/catalog?q=中文导入耗材', s.material)).data.items[0];
  assert.match(imported.code, /^MAT-[A-F0-9]{16}$/);
  const exported = await f.request('GET', '/api/materials/catalog/export.xlsx?q=中文导入耗材', f.admin);
  const parsed = await require('../src/material-xlsx').readCatalogWorkbook({ name: '导出.xlsx', content: exported.bytes.toString('base64') });
  assert.deepEqual(parsed.headers, CATALOG_HEADERS); assert.equal(parsed.rows[0].values['物资名称'], imported.name);
  assert.deepEqual((await f.request('POST', '/api/materials/catalog/import', f.admin, { name: '导出.xlsx', content: exported.bytes.toString('base64') }, 201)).data, { created: 0, skipped: 1 });
  const conflicting = await namedExcel(CATALOG_HEADERS, [['不应保留的临时物资', 'x', '盒', s.category.name, '数量'], ['中文自动物资', '100 mL', '瓶', s.otherCategory.name, '逐件']]);
  const conflict = (await f.request('POST', '/api/materials/catalog/import', f.admin, { name: '分类管理冲突.xlsx', content: conflicting.toString('base64') }, 409)).data;
  assert.equal(conflict.code, 'IMPORT_VALIDATION'); assert.equal(conflict.totalErrors, 2);
  assert.deepEqual(conflict.errors.map(error => [error.row, error.column, error.field]), [[3, 'D', '物资分类'], [3, 'E', '管理方式']]);
  assert.equal((await f.request('GET', '/api/materials/catalog?q=不应保留的临时物资', s.material)).data.total, 0);
  await f.db.prepare('INSERT INTO material_categories(name,created_by) VALUES(?,?)').run('ＨＴＴＰ分类', f.admin.id);
  const ambiguous = await namedExcel(CATALOG_HEADERS, [['不应建立', '1 kg', '袋', s.category.name, '数量']]);
  const failure = (await f.request('POST', '/api/materials/catalog/import', f.admin, { name: '歧义.xlsx', content: ambiguous.toString('base64') }, 400)).data;
  assert.equal(failure.errors[0].column, 'D'); assert.match(failure.errors[0].message, /歧义/);
  assert.equal((await f.request('GET', '/api/materials/catalog?q=不应建立', s.material)).data.total, 0);
});

test('templates and filtered round-trip exports remain available above 5000 catalog records and prioritize selected references', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  await f.db.prepare(`INSERT INTO material_catalog(code,name,spec,unit,category_id,created_by)
    SELECT 'REF-'||n::text,'参考物资'||lpad(n::text,5,'0'),'1 mL','瓶',?,? FROM generate_series(1,5000) AS n`).run(s.category.id, f.admin.id);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS total FROM material_catalog').get()).total, 5001);
  const last = await f.db.prepare('SELECT * FROM material_catalog ORDER BY name,spec,unit OFFSET 5000 LIMIT 1').get();
  const worksheets = bytes => require('read-excel-file/universal').default(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  const materialReferences = sheets => sheets.find(sheet => sheet.sheet === '物资参考').data;
  const template = await f.request('GET', '/api/materials/catalog/template', f.admin);
  const templateSheets = await worksheets(template.bytes);
  assert.equal(materialReferences(templateSheets).length, 5001);
  assert.equal(materialReferences(templateSheets).some(row => row[0] === last.name), false);
  const exported = await f.request('GET', '/api/materials/catalog/export.xlsx?q=' + encodeURIComponent(last.name), f.admin);
  const parsed = await require('../src/material-xlsx').readCatalogWorkbook({ name: '小范围.xlsx', content: exported.bytes.toString('base64') });
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0].values['物资名称'], last.name);
  assert.deepEqual(materialReferences(await worksheets(exported.bytes))[1], [last.name, last.spec, last.unit]);
  assert.deepEqual((await f.request('POST', '/api/materials/catalog/import', f.admin, { name: '小范围.xlsx', content: exported.bytes.toString('base64') }, 201)).data, { created: 0, skipped: 1 });
  const openingTemplate = await f.request('GET', '/api/materials/openings/template.xlsx', s.material);
  const openingXml = workbookXml(openingTemplate.bytes).get('xl/worksheets/sheet1.xml');
  for (const column of ['A', 'B', 'C']) assert.match(openingXml, new RegExp(`showErrorMessage="0"[^>]*sqref="${column}2:${column}5001"`));
  assert.match(openingXml, /showErrorMessage="1"[^>]*sqref="E2:E5001"/);
  await f.request('POST', '/api/materials/stock/opening', s.material, { catalogId: last.id, regionId: s.region.id, warehouse: 'MAIN', quantity: '1', amount: '2.34', requestIdempotencyKey: key() }, 201);
  const stock = await f.request('GET', '/api/materials/export.xlsx?type=stock&q=' + encodeURIComponent(last.name), s.material);
  const opening = await require('../src/material-xlsx').readOpeningWorkbook({ name: '筛选库存.xlsx', content: stock.bytes.toString('base64') });
  assert.equal(opening.rows.length, 1); assert.equal(opening.rows[0].values['物资名称'], last.name);
  assert.deepEqual(materialReferences(await worksheets(stock.bytes))[1], [last.name, last.spec, last.unit]);
});

test('Chinese opening import collects exact physical cell errors atomically and rejects material or region ambiguity', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), { OPENING_HEADERS } = require('../src/material-xlsx');
  const document = (await f.request('POST', '/api/materials/openings', s.material, { title: '中文导入核对' }, 201)).data;
  const template = workbookXml((await f.request('GET', '/api/materials/openings/template.xlsx', s.material)).bytes);
  for (const column of ['A', 'B', 'C', 'D', 'E']) assert.match(template.get('xl/worksheets/sheet1.xml'), new RegExp(`sqref="${column}2:${column}5001"`));
  assert.doesNotMatch([...template.values()].join('\n'), /物资编码|仓库编码/);
  const valid = [s.catalog.name, s.catalog.spec, s.catalog.unit, s.region.name, '默认仓库', 2, 10.25, '', '', '中文位置', ''];
  const wrongSpec = [s.catalog.name, '不同规格', '瓶', '不存在区域', 'MAIN', 0, -1, '', '2026-02-30', '', ''];
  const wrongUnit = [s.catalog.name, s.catalog.spec, '袋', s.region.name, '默认仓库', 1, 0, '', '', '', ''];
  const invalid = await namedExcel(OPENING_HEADERS, [valid, [], wrongSpec, wrongUnit]);
  const failure = (await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, { version: document.version, name: '中文.xlsx', content: invalid.toString('base64') }, 400)).data;
  assert.equal(failure.code, 'IMPORT_VALIDATION'); assert.equal(failure.totalErrors, 8);
  assert.deepEqual(failure.errors.map(error => [error.row, error.column]), [[4, 'B'], [4, 'D'], [4, 'E'], [4, 'F'], [4, 'G'], [4, 'I'], [5, 'C'], [5, 'K']]);
  assert.ok(failure.errors.every(error => error.sheet === '中文明细' && error.field && error.message));
  assert.deepEqual((await f.request('GET', `/api/materials/openings/${document.id}`, s.material)).data, document);
  assert.equal((await f.request('GET', '/api/materials/stock/movements', s.material)).data.total, 0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE action='IMPORT'").get()).total, 0);
  await f.db.prepare('INSERT INTO material_regions(name,created_by) VALUES(?,?)').run('ＨＴＴＰ区域', f.admin.id);
  const ambiguous = await namedExcel(OPENING_HEADERS, [valid]);
  const regionFailure = (await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, { version: document.version, name: '歧义.xlsx', content: ambiguous.toString('base64') }, 400)).data;
  assert.equal(regionFailure.errors[0].column, 'D'); assert.match(regionFailure.errors[0].message, /歧义/);
  await f.db.prepare('DELETE FROM material_regions WHERE name=?').run('ＨＴＴＰ区域');
  await f.db.prepare('INSERT INTO material_catalog(code,name,spec,unit,category_id,created_by) VALUES(?,?,?,?,?,?)').run('AMBIGUOUS-IMPORT', s.catalog.name, s.catalog.spec, s.catalog.unit, s.category.id, f.admin.id);
  const materialFailure = (await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, { version: document.version, name: '歧义.xlsx', content: ambiguous.toString('base64') }, 400)).data;
  assert.equal(materialFailure.errors[0].column, 'A'); assert.match(materialFailure.errors[0].message, /多条物资/);
  assert.deepEqual((await f.request('GET', `/api/materials/openings/${document.id}`, s.material)).data, document);
  await f.db.prepare('DELETE FROM material_catalog WHERE code=?').run('AMBIGUOUS-IMPORT');
  const normalized = await namedExcel(OPENING_HEADERS, [[' ｈｔｔｐ ｒｅａｇｅｎｔ ', '５００ ｍｌ', ' 瓶 ', ' ｈｔｔｐ区域 ', '　默认仓库　', 2, 10.25, '', '', '中文位置', '']]);
  const imported = (await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, { version: document.version, name: '名称规范化.xlsx', content: normalized.toString('base64') }, 201)).data;
  assert.equal(imported.items.length, 1); assert.equal(imported.items[0].catalogId, s.catalog.id); assert.equal(imported.items[0].regionId, s.region.id);
  assert.equal(imported.items[0].warehouse, 'MAIN'); assert.equal(imported.items[0].qtyM, 2000);
});

test('stock exports re-import exact batch balances and positions into a draft without issuing stock or exposing redacted amounts', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  const base = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'MAIN' };
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...base, quantity: '1.125', amount: '12.34', batch: '批次甲', expiryDate: '2028-01-01', location: '甲柜 / 1层', requestIdempotencyKey: key() }, 201);
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...base, quantity: '2', amount: '0', zeroAmountReason: '赠品', batch: '批次乙', expiryDate: '2029-02-01', location: '乙柜 / 2层', requestIdempotencyKey: key() }, 201);
  await f.request('PUT', '/api/materials/stock/location', s.material, { ...base, batch: '批次甲', expiryDate: '2028-01-01', location: '甲柜 / 1层', version: 0, reason: '批次摆放' });
  await f.request('PUT', '/api/materials/stock/location', s.material, { ...base, batch: '批次乙', expiryDate: '2029-02-01', location: '乙柜 / 2层', version: 0, reason: '批次摆放' });
  const stock = (await f.request('GET', '/api/materials/stock', s.material)).data;
  const movements = (await f.request('GET', '/api/materials/stock/movements', s.material)).data;
  const exported = await f.request('GET', '/api/materials/export.xlsx?type=stock', s.material);
  const parsed = await require('../src/material-xlsx').readOpeningWorkbook({ name: '库存.xlsx', content: exported.bytes.toString('base64') });
  assert.equal(parsed.sheet, '库存导入明细'); assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows.map(record => record.values['仓库']), ['默认仓库', '默认仓库']);
  const target = (await f.request('POST', '/api/materials/openings', s.material, { title: '库存快照重新清点' }, 201)).data;
  const copied = (await f.request('POST', `/api/materials/openings/${target.id}/import`, s.material, { version: target.version, name: '库存.xlsx', content: exported.bytes.toString('base64') }, 201)).data;
  assert.equal(copied.status, 'draft');
  assert.deepEqual(copied.items.map(row => [row.batch, row.expiryDate, row.location, row.qtyM, row.amountCents]).sort(), [['批次乙', '2029-02-01', '乙柜 / 2层', 2000, 0], ['批次甲', '2028-01-01', '甲柜 / 1层', 1125, 1234]].sort());
  assert.deepEqual((await f.request('GET', '/api/materials/stock', s.material)).data, stock);
  assert.deepEqual((await f.request('GET', '/api/materials/stock/movements', s.material)).data, movements);
  assert.equal((await f.request('GET', '/api/materials/stock/units', s.material)).data.total, 0);
  const limited = await f.customAccount('STOCK_EXPORT_READER', ['materials.read', 'materials.export']);
  const redacted = await f.request('GET', '/api/materials/export.xlsx?type=stock', limited);
  assert.doesNotMatch([...workbookXml(redacted.bytes).values()].join('\n'), /总金额（元）|库存总金额|12\.34|amountCents/);
  await assert.rejects(require('../src/material-xlsx').readOpeningWorkbook({ name: '脱敏.xlsx', content: redacted.bytes.toString('base64') }), /表头不匹配/);
  const before = (await f.request('GET', `/api/materials/openings/${target.id}`, s.material)).data;
  await f.request('POST', `/api/materials/openings/${target.id}/import`, s.material, { version: before.version, name: '脱敏.xlsx', content: redacted.bytes.toString('base64') }, 400);
  await f.request('POST', `/api/materials/openings/${target.id}/import`, limited, { version: before.version, name: '库存.xlsx', content: exported.bytes.toString('base64') }, 403);
  assert.deepEqual((await f.request('GET', `/api/materials/openings/${target.id}`, s.material)).data, before);
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
    assert.match(response.data.error, /先匹配物资信息/);
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
      if (actor === exporter) assert.doesNotMatch(xml, /库存总金额|总金额（元）|发放金额|amountCents|123\.45|含税总额/);
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
  assert.match(xml, /库存导入明细/); assert.match(xml, new RegExp(current.location));
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



test('schema 5 backups restore issue sources, locations and user mapping; damaged ledger states fail atomically and strict schema 1 remains compatible', { timeout: 45000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER'), other = await f.account('FINANCE');
  const identity = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'MAIN', batch: 'BACKUP-ISSUE', expiryDate: '2030-05-06' };
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...identity, quantity: '4', amount: '1.01', requestIdempotencyKey: key() }, 201);
  const legacy = legacyBackup((await f.request('GET', '/api/materials/backup', f.admin)).data, 1);
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
  assert.equal(backup.schemaVersion, 5); assert.equal(backup.data.material_issues.length, 4); assert.equal(backup.data.material_stock_locations.length, 1);
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

test('packaging barcodes preserve literal identity, require catalog managers and reasons, and cannot be rebound or deleted by stale IDs', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const other = await f.catalog(s.category.id, { code: 'BARCODE-OTHER', name: '另一个主档' });
  const writeOnly = await f.customAccount('BARCODE_WRITE_ONLY', ['materials.catalog.write']);
  const route = `/api/materials/catalog/${s.catalog.id}/barcodes`, payload = { code: '  0000123aA  ', reason: '外包装绑定' };
  for (const actor of [ordinary, writeOnly]) await f.request('POST', route, actor, payload, 403);
  for (const change of [{ code: 123 }, { code: '' }, { code: 'x'.repeat(513) }, { code: 'A\u001dB' }, { code: 'A\u007fB' },
    { code: '\ud800' }, { code: 'LABOS-STOCK:1:{}' }, { reason: '' }]) await f.request('POST', route, s.material, { ...payload, ...change }, 400);
  const saved = (await f.request('POST', route, s.material, payload, 201)).data.barcode;
  assert.equal(saved.code, '0000123aA'); assert.equal(saved.catalogId, s.catalog.id); assert.equal(saved.createdBy, s.material.id);
  assert.equal((await f.request('POST', route, f.admin, payload)).data.barcode.id, saved.id);
  const conflict = await Promise.all([other, s.catalog].map(catalog => f.request('POST', `/api/materials/catalog/${catalog.id}/barcodes`, f.admin,
    { code: 'CONCURRENT-CODE', reason: '并发唯一绑定' }, [201, 409])));
  assert.deepEqual(conflict.map(result => result.status).sort(), [201, 409]);
  await f.request('POST', `/api/materials/catalog/${other.id}/barcodes`, f.admin, payload, 409);
  const distinct = (await f.request('POST', route, f.admin, { code: '0000123Aa', reason: '大小写不同的码' }, 201)).data.barcode;
  assert.notEqual(distinct.id, saved.id);
  const list = (await f.request('GET', route + '?pageSize=1&page=1', ordinary)).data;
  assert.equal(list.pageSize, 1); assert.equal(list.items.length, 1); assert.ok(list.total >= 2);
  const resolved = (await f.request('POST', '/api/materials/scan/resolve', ordinary, { code: payload.code })).data;
  assert.equal(resolved.kind, 'catalog'); assert.equal(resolved.catalog.id, s.catalog.id); assert.equal(resolved.barcode.id, saved.id);
  await f.request('DELETE', `/api/materials/barcodes/${saved.id}`, ordinary, { reason: '无权' }, 403);
  await f.request('DELETE', `/api/materials/barcodes/${saved.id}`, f.admin, { reason: '' }, 400);
  await f.request('DELETE', `/api/materials/barcodes/${saved.id}`, f.admin, { reason: '纠正原绑定' });
  await f.request('POST', '/api/materials/scan/resolve', ordinary, { code: saved.code }, 404);
  const replacement = (await f.request('POST', `/api/materials/catalog/${other.id}/barcodes`, s.material, { code: saved.code, reason: '核对后重新绑定' }, 201)).data.barcode;
  assert.ok(replacement.id > saved.id);
  await f.request('DELETE', `/api/materials/barcodes/${saved.id}`, f.admin, { reason: '陈旧表单' }, 404);
  assert.equal((await f.request('POST', '/api/materials/scan/resolve', ordinary, { code: saved.code })).data.catalog.id, other.id);
  assert.equal((await f.request('GET', '/api/materials/stock/movements', s.material)).data.total, 0);
  assert.equal((await f.request('GET', '/api/materials/requests', ordinary)).data.total, 0);
  await f.request('PUT', '/api/permissions/roles/MATERIAL', f.admin, { permissions: ['materials.read'] });
  await f.request('POST', route, s.material, { code: 'REVOKED', reason: '无权限' }, 403);
  await f.request('DELETE', `/api/materials/barcodes/${replacement.id}`, s.material, { reason: '无权限' }, 403);
});

test('system stock QR resolves a fresh exact batch without side effects and rejects malformed, foreign and nonmatching locators', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const identity = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'MAIN', batch: '', expiryDate: '' };
  for (const extra of [{}, { batch: 'LOT-A', expiryDate: '2030-01-01' }, { batch: 'LOT-A', expiryDate: '2031-01-01' },
    { regionId: s.otherRegion.id }, { warehouse: 'REAGENT' }]) await f.request('POST', '/api/materials/stock/opening', s.material,
    { ...identity, ...extra, quantity: '2', amount: '3.00', requestIdempotencyKey: key() }, 201);
  const batches = (await f.request('GET', '/api/materials/stock/batches', s.material)).data.items;
  assert.equal(new Set(batches.map(row => row.qrPayload)).size, 5);
  for (const batch of batches) {
    assert.ok(batch.qrPayload.startsWith('LABOS-STOCK:1:'));
    const resolved = (await f.request('POST', '/api/materials/scan/resolve', s.material, { code: batch.qrPayload })).data;
    assert.equal(resolved.kind, 'stock'); assert.deepEqual(resolved.batch, batch); assert.equal(resolved.catalog.code, s.catalog.code);
  }
  const first = batches.find(row => row.warehouse === 'MAIN' && row.regionId === s.region.id && row.batch === '');
  await f.request('PUT', '/api/materials/stock/location', f.admin, { ...identity, version: 0, location: '扫码柜', reason: '定位更新' });
  await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...identity, direction: 'decrease', quantity: '2', amount: '3.00', reason: '耗尽后仍可定位', requestIdempotencyKey: key() }, 201);
  const empty = (await f.request('POST', '/api/materials/scan/resolve', ordinary, { code: first.qrPayload })).data;
  assert.equal(empty.batch.qtyM, 0); assert.equal(empty.batch.location, '扫码柜'); assert.equal(empty.batch.locationVersion, 1); assertNoMoney(empty);
  const before = (await f.request('GET', '/api/materials/stock/movements', s.material)).data.total;
  const saved = JSON.parse(first.qrPayload.slice('LABOS-STOCK:1:'.length)), encode = value => 'LABOS-STOCK:1:' + JSON.stringify(value);
  for (const value of ['LABOS-STOCK:2:{}', 'LABOS-STOCK:1:broken', encode(null), encode([]), encode({ ...saved, quantity: '1' }),
    encode({ ...saved, catalogId: String(saved.catalogId) }), encode({ ...saved, batch: null }), encode({ ...saved, expiryDate: '2030-02-30' }),
    encode(Object.fromEntries(Object.entries(saved).filter(([name]) => name !== 'batch')))]) await f.request('POST', '/api/materials/scan/resolve', ordinary, { code: value }, 400);
  for (const change of [{ catalogCode: 'FOREIGN-SYSTEM' }, { regionId: 99999 }, { batch: 'NONEXISTENT' }, { expiryDate: '2040-01-01' }]) {
    await f.request('POST', '/api/materials/scan/resolve', ordinary, { code: encode({ ...saved, ...change }) }, 404);
  }
  const external = 'https://example.invalid/package?code=0000123', sqlLike = "' OR 1=1 --";
  for (const code of [external, sqlLike]) {
    await f.request('POST', `/api/materials/catalog/${s.catalog.id}/barcodes`, f.admin, { code, reason: '按原码精确绑定' }, 201);
    assert.equal((await f.request('POST', '/api/materials/scan/resolve', ordinary, { code })).data.catalog.id, s.catalog.id);
  }
  await f.request('POST', '/api/materials/scan/resolve', ordinary, { code: 'https://127.0.0.1/not-a-fetch' }, 404);
  await f.request('POST', '/api/materials/scan/resolve', null, { code: first.qrPayload }, 401);
  assert.equal((await f.request('GET', '/api/materials/stock/movements', s.material)).data.total, before);
  assert.equal((await f.request('GET', '/api/materials/issues', s.material)).data.total, 0);
});

test('scanned material acceptance lookup filters exact catalog, region and warehouse while keeping real receipt permissions and line versions', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const other = await f.catalog(s.category.id, { code: 'SCAN-OTHER', name: '其他扫码物资' });
  let order = await f.order(ordinary, null, '扫码验收候选');
  for (const extra of [{}, { regionId: s.otherRegion.id }, { warehouse: 'MAIN' }, { catalogId: other.id }, { catalogId: null, code: '', name: '尚未匹配', spec: '1', unit: '件' }]) {
    order = await f.add(order, ordinary, f.item(s, { quantity: '2', ...extra }));
  }
  order = await f.submit(order);
  const query = '/api/materials/acceptance?' + new URLSearchParams({ catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'REAGENT' });
  const exact = (await f.request('GET', query, ordinary)).data;
  assert.equal(exact.total, 1); assert.equal(exact.items[0].id, order.items[0].id);
  assert.equal((await f.request('GET', '/api/materials/acceptance?catalogId=' + s.catalog.id, ordinary)).data.total, 3);
  for (const suffix of ['catalogId=bad', 'regionId=0', 'warehouse=UNKNOWN']) await f.request('GET', '/api/materials/acceptance?' + suffix, ordinary, undefined, 400);
  const receipt = f.receiptBody(order, { quantity: '1', amount: '1.00' });
  await f.request('POST', '/api/materials/receipts', ordinary, receipt, 403);
  await f.request('POST', '/api/materials/receipts', f.admin, receipt, 403);
  await f.request('POST', '/api/materials/receipts', s.material, receipt, 201);
  const partial = (await f.request('GET', query + '&status=partial', ordinary)).data;
  assert.equal(partial.total, 1); assert.equal(partial.items[0].remainingQtyM, 1000);
  await f.request('POST', '/api/materials/receipts', s.material, { ...receipt, requestIdempotencyKey: key() }, 409);
  const pendingOrder = await f.submit(await f.order(ordinary, f.item(s, { quantity: '2' }), '仍待验收'));
  const doneOrder = await f.submit(await f.order(ordinary, f.item(s, { quantity: '2' }), '最新已验收'));
  await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(doneOrder, { quantity: '2', amount: '2.00' }), 201);
  const open = (await f.request('GET', query + '&status=open&pageSize=1', ordinary)).data;
  assert.equal(open.total, 2); assert.equal(open.items.length, 1); assert.equal(open.items[0].requestId, pendingOrder.id);
  const next = (await f.request('GET', query + '&status=open&pageSize=1&page=2', ordinary)).data;
  assert.equal(next.total, 2); assert.equal(next.items[0].requestId, order.id); assert.equal(next.items[0].receiptStatus, 'partial');
  assert.equal((await f.request('GET', query, ordinary)).data.total, 3, 'default lookup still includes completed history');
});

test('schema 5 barcode backup maps creators and rejects damaged mappings while strict schema 2 imports normalize only the new tables', { timeout: 45000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  const previous = legacyBackup((await f.request('GET', '/api/materials/backup', f.admin)).data, 2);
  const saved = (await f.request('POST', `/api/materials/catalog/${s.catalog.id}/barcodes`, s.material, { code: '0000Backup', reason: '备份映射' }, 201)).data.barcode;
  const backup = (await f.request('GET', '/api/materials/backup', f.admin)).data;
  assert.equal(backup.schemaVersion, 5); assert.equal(backup.data.material_barcodes.length, 1);
  const target = await fixture(t); await target.account('TESTER'); const targetMaterial = await target.account('MATERIAL');
  assert.notEqual(targetMaterial.id, s.material.id);
  for (const change of [
    payload => { payload.data.material_barcodes.push({ ...payload.data.material_barcodes[0], id: saved.id + 1 }); },
    payload => { payload.data.material_barcodes[0].code = ' padded '; },
    payload => { payload.data.material_barcodes[0].code = 'A\u001dB'; },
    payload => { payload.data.material_barcodes[0].code = 'LABOS-STOCK:1:{}'; },
    payload => { payload.data.material_barcodes[0].catalog_id = 99999; },
    payload => { payload.data.material_barcodes[0].created_by = 99999; },
    payload => { delete payload.data.material_barcodes[0].code; },
    payload => { delete payload.data.material_barcodes; }
  ]) {
    const damaged = structuredClone(backup); change(damaged);
    await target.request('POST', '/api/materials/restore', target.admin, damaged, 400);
    assert.equal((await target.request('GET', '/api/materials/catalog', targetMaterial)).data.total, 0);
  }
  await target.request('POST', '/api/materials/restore', target.admin, backup);
  const restored = (await target.request('POST', '/api/materials/scan/resolve', targetMaterial, { code: saved.code })).data;
  assert.equal(restored.catalog.id, s.catalog.id); assert.equal(restored.barcode.id, saved.id); assert.equal(restored.barcode.createdBy, targetMaterial.id);
  const oldTarget = await fixture(t); const oldMaterial = await oldTarget.account('MATERIAL');
  const mixed = structuredClone(previous); mixed.data.material_barcodes = [];
  await oldTarget.request('POST', '/api/materials/restore', oldTarget.admin, mixed, 400);
  const missing = structuredClone(previous); delete missing.data.material_issues;
  await oldTarget.request('POST', '/api/materials/restore', oldTarget.admin, missing, 400);
  await oldTarget.request('POST', '/api/materials/restore', oldTarget.admin, previous);
  assert.equal((await oldTarget.request('GET', `/api/materials/catalog/${s.catalog.id}/barcodes`, oldMaterial)).data.total, 0);
  await oldTarget.request('POST', '/api/materials/scan/resolve', oldMaterial, { code: saved.code }, 404);
});

test('unit catalog modes and label rules enforce permissions, versions, integer units and permanent history boundaries', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  assert.equal(s.catalog.trackingMode, 'quantity');
  const rule = (await f.request('GET', '/api/materials/unit-label-rule', ordinary)).data;
  assert.equal(rule.nextSequence, 1); assert.equal(rule.dateBasis, 'UTC');
  const update = { template: 'BOTTLE-{YYYY}{MM}{DD}-{SEQ}', padding: 8, version: rule.rule.version, reason: '独立瓶标签' };
  await f.request('PUT', '/api/materials/unit-label-rule', ordinary, update, 403);
  for (const change of [{ template: 'NO-SEQUENCE' }, { template: 'A{SEQ}{SEQ}' }, { template: 'A{UNKNOWN}{SEQ}' }, { template: '瓶{SEQ}' }, { template: 'A {SEQ}' }, { padding: 0 }, { padding: 13 }, { reason: '' }]) {
    await f.request('PUT', '/api/materials/unit-label-rule', f.admin, { ...update, ...change }, 400);
  }
  const saved = (await f.request('PUT', '/api/materials/unit-label-rule', s.material, update)).data;
  assert.equal(saved.rule.version, 2); assert.equal(saved.rule.actorId, s.material.id); assert.equal(saved.nextSequence, 1);
  await f.request('PUT', '/api/materials/unit-label-rule', f.admin, update, 409);
  const route = `/api/materials/catalog/${s.catalog.id}/tracking-mode`;
  const mode = { trackingMode: 'unit', version: s.catalog.version, reason: '整瓶管理' };
  await f.request('PUT', route, ordinary, mode, 403);
  await f.request('PUT', route, f.admin, { ...mode, trackingMode: 'serial' }, 400);
  const master = (await f.request('PUT', route, f.admin, mode)).data.catalog;
  assert.equal(master.trackingMode, 'unit'); assert.equal(master.version, 2);
  await f.request('PUT', route, f.admin, mode, 409);
  s.catalog = master;
  let order = await f.order(ordinary);
  await f.request('POST', `/api/materials/requests/${order.id}/items`, ordinary, { requestVersion: order.version, ...f.item(s, { quantity: '1.5' }) }, 400);
  order = await f.add(order, ordinary, f.item(s, { quantity: '2' }));
  order = await f.submit(order, s.material);
  await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { quantity: '0.001' }), 400);
  await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { quantity: '0', amount: '0', rejectedQuantity: '0.5', rejectedReason: '非整件' }), 400);
  await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { quantity: '0', amount: '0', rejectedQuantity: '1', rejectedReason: '包装破损' }), 201);
  assert.equal((await f.request('GET', '/api/materials/unit-label-rule', f.admin)).data.nextSequence, 1);
  await f.request('PUT', route, f.admin, { trackingMode: 'quantity', version: 2, reason: '已有拒收不允许切换' }, 409);
  const fractional = await f.catalog(s.category.id, { code: 'BULK-FRACTION', trackingMode: 'quantity' });
  await f.order(ordinary, f.item({ ...s, catalog: fractional }, { quantity: '0.5' }));
  await f.request('PUT', `/api/materials/catalog/${fractional.id}/tracking-mode`, f.admin, { trackingMode: 'unit', version: 1, reason: '不能猜测半瓶' }, 409);
});

test('acceptance automatically generates immutable independent labels and retries never consume sequences or duplicate inventory', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  s.catalog = await f.catalog(s.category.id, { code: 'UNIT-RECEIVE', trackingMode: 'unit' });
  let order = await f.order(s.material, f.item(s, { quantity: '5' })); order = await f.submit(order, s.material);
  const body = f.receiptBody(order, { quantity: '3', amount: '1', rejectedQuantity: '1', rejectedReason: '破瓶', batch: 'UNITS', expiryDate: '2031-05-06' });
  const received = (await f.request('POST', '/api/materials/receipts', s.material, body, 201)).data;
  assert.equal(received.receipt.unitCount, 3); assert.equal(received.receipt.units.length, 3);
  const units = received.receipt.units;
  assert.equal(new Set(units.map(unit => unit.code)).size, 3);
  assert.deepEqual(units.map(unit => unit.sequence), [1, 2, 3]);
  for (const unit of units) { assert.match(unit.code, /^LAB-\d{8}-\d{6}$/); assert.equal(unit.qrPayload, unit.code); assert.equal(unit.status, 'in_stock'); assert.equal(unit.sourceReceiptId, received.receipt.id); assert.equal(unit.catalogCode, s.catalog.code); }
  const replay = (await f.request('POST', '/api/materials/receipts', s.material, body)).data;
  assert.deepEqual(replay.receipt.units, units);
  const listed = (await f.request('GET', `/api/materials/stock/units?receiptId=${received.receipt.id}&pageSize=2&page=2`, s.material)).data;
  assert.equal(listed.total, 3); assert.equal(listed.items.length, 1); assert.equal(listed.items[0].id, units[2].id);
  const receiptList = (await f.request('GET', '/api/materials/receipts', s.material)).data.items[0];
  assert.equal(receiptList.unitCount, 3); assert.equal(receiptList.units, undefined);
  const before = (await f.request('GET', '/api/materials/stock', s.material)).data.items[0];
  const scanned = (await f.request('POST', '/api/materials/scan/resolve', s.material, { code: units[0].code })).data;
  assert.equal(scanned.kind, 'unit'); assert.equal(scanned.unit.id, units[0].id); assert.equal(scanned.batch.qtyM, 3000); assert.equal(scanned.catalog.trackingMode, 'unit');
  assert.deepEqual((await f.request('GET', '/api/materials/stock', s.material)).data.items[0], before);
  const identity = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'REAGENT', batch: 'UNITS', expiryDate: '2031-05-06' };
  const rule = (await f.request('GET', '/api/materials/unit-label-rule', f.admin)).data;
  await f.request('PUT', '/api/materials/unit-label-rule', f.admin, { template: 'ITEM/{SEQ}', padding: 2, version: rule.rule.version, reason: '改格式不重置序号' });
  const addedBody = { ...identity, quantity: '1', amount: '0', direction: 'increase', reason: '新增赠品', requestIdempotencyKey: key() };
  const added = (await f.request('POST', '/api/materials/stock/adjustments', s.material, addedBody, 201)).data.movement;
  assert.equal(added.units[0].code, 'ITEM/04'); assert.equal(added.units[0].sequence, 4);
  assert.equal((await f.request('POST', '/api/materials/stock/adjustments', s.material, addedBody)).data.movement.units[0].id, added.units[0].id);
  assert.equal((await f.request('GET', '/api/materials/unit-label-rule', f.admin)).data.nextSequence, 5);
  await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...addedBody, quantity: '1001', requestIdempotencyKey: key() }, 400);
  await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...addedBody, quantity: '0.5', requestIdempotencyKey: key() }, 400);
  await f.request('POST', `/api/materials/catalog/${s.catalog.id}/barcodes`, f.admin, { code: units[0].code, reason: '不能占用单件码' }, 409);
  assert.equal((await f.request('POST', '/api/materials/scan/resolve', s.material, { code: units[0].code })).data.unit.code, units[0].code);
});

test('single-unit issuing rechecks exact identities atomically, accepts codes, and retains batch-average cents', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const other = await f.account('FINANCE');
  s.catalog = await f.catalog(s.category.id, { code: 'UNIT-ISSUE', trackingMode: 'unit' });
  const identity = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'MAIN', batch: 'ONE', expiryDate: '' };
  const opening = (await f.request('POST', '/api/materials/stock/opening', s.material, { ...identity, quantity: '3', amount: '1', requestIdempotencyKey: key() }, 201)).data.movement;
  await f.request('POST', '/api/materials/stock/opening', s.material, { ...identity, batch: 'OTHER', quantity: '1', amount: '0', zeroAmountReason: '赠品', requestIdempotencyKey: key() }, 201);
  const foreign = (await f.request('GET', `/api/materials/stock/units?catalogId=${s.catalog.id}&batch=OTHER`, s.material)).data.items[0];
  const apply = extra => f.request('POST', '/api/materials/issues', ordinary, { ...identity, quantity: '1', purpose: '整瓶领取', requestIdempotencyKey: key(), ...extra }, 201);
  await f.request('POST', '/api/materials/issues', ordinary, { ...identity, quantity: '0.5', purpose: '不能半瓶', requestIdempotencyKey: key() }, 400);
  const first = (await apply()).data.issue, second = (await apply()).data.issue;
  assert.equal(first.trackingMode, 'unit'); assert.equal(first.units.length, 0);
  const route = `/api/materials/issues/${first.id}/issue`, action = { version: 1, requestIdempotencyKey: key() };
  await f.request('POST', route, ordinary, { ...action, unitIds: [opening.units[0].id] }, 403);
  await f.request('POST', route, s.material, action, 400);
  await f.request('POST', route, s.material, { ...action, unitIds: [opening.units[0].id], unitCodes: [opening.units[0].code] }, 400);
  await f.request('POST', route, s.material, { ...action, unitIds: [foreign.id] }, 409);
  await f.request('POST', route, s.material, { ...action, unitCodes: ['NOT-FOUND'] }, 409);
  const results = await Promise.all([first, second].map(issue => f.request('POST', `/api/materials/issues/${issue.id}/issue`, s.material,
    { version: 1, requestIdempotencyKey: key(), unitIds: [opening.units[0].id] }, [201, 409])));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const issued = results.find(result => result.status === 201).data.issue;
  assert.equal(issued.amountCents, 33); assert.equal(issued.units[0].status, 'issued'); assert.equal(issued.units[0].id, opening.units[0].id);
  const remaining = [first, second].find(issue => issue.id !== issued.id);
  const codeAction = { version: 1, requestIdempotencyKey: key(), unitCodes: [opening.units[1].code] };
  const next = (await f.request('POST', `/api/materials/issues/${remaining.id}/issue`, s.material, codeAction, 201)).data.issue;
  assert.equal(next.amountCents, 34); assert.equal(next.units[0].id, opening.units[1].id);
  assert.equal((await f.request('POST', `/api/materials/issues/${remaining.id}/issue`, s.material, codeAction)).data.issue.units[0].id, opening.units[1].id);
  const third = (await apply()).data.issue;
  const final = (await f.request('POST', `/api/materials/issues/${third.id}/issue`, s.material, { version: 1, requestIdempotencyKey: key(), unitIds: [opening.units[2].id] }, 201)).data.issue;
  assert.equal(final.amountCents, 33);
  assert.equal((await f.request('GET', `/api/materials/stock/units?issueId=${issued.id}`, ordinary)).data.items[0].id, opening.units[0].id);
  await f.request('GET', `/api/materials/stock/units?issueId=${issued.id}`, other, undefined, 403);
  const scanned = (await f.request('POST', '/api/materials/scan/resolve', ordinary, { code: opening.units[0].code })).data;
  assert.equal(scanned.unit.status, 'issued'); assert.equal(scanned.batch.qtyM, 0);
  assertNoMoney(scanned);
});

test('unit adjustments and receipt reversals preserve physical source identity and never recycle void labels', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  s.catalog = await f.catalog(s.category.id, { code: 'UNIT-REVERSE', trackingMode: 'unit' });
  const identity = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'REAGENT', batch: 'SAME', expiryDate: '' };
  let order = await f.order(s.material, f.item(s, { quantity: '4' })); order = await f.submit(order, s.material);
  const first = (await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order, { quantity: '2', amount: '2', batch: 'SAME' }), 201)).data;
  const second = (await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(first.request, { quantity: '2', amount: '2', batch: 'SAME' }), 201)).data;
  const adjustment = { ...identity, quantity: '1', amount: '1', direction: 'decrease', reason: '破损出库', requestIdempotencyKey: key() };
  await f.request('POST', '/api/materials/stock/adjustments', s.material, adjustment, 400);
  await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...adjustment, quantity: '2', unitIds: [first.receipt.units[0].id, first.receipt.units[0].id] }, 400);
  const removed = (await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...adjustment, unitCodes: [first.receipt.units[0].code] }, 201)).data.movement;
  assert.equal(removed.units[0].status, 'void');
  await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...adjustment, requestIdempotencyKey: key(), unitIds: [first.receipt.units[0].id] }, 409);
  const reversalBody = { requestVersion: second.request.version, version: second.request.items[0].version, requestIdempotencyKey: key(), reason: '原验收整笔冲正' };
  await f.request('POST', `/api/materials/receipts/${first.receipt.id}/reverse`, s.material, reversalBody, 409);
  const reversed = (await f.request('POST', `/api/materials/receipts/${second.receipt.id}/reverse`, s.material, reversalBody, 201)).data;
  assert.equal(reversed.receipt.units.length, 2); assert.ok(reversed.receipt.units.every(unit => unit.status === 'void'));
  const reverseLabels = (await f.request('GET', `/api/materials/stock/units?receiptId=${reversed.receipt.id}`, s.material)).data;
  assert.equal(reverseLabels.total, 2); assert.deepEqual(reverseLabels.items.map(unit => unit.id), second.receipt.units.map(unit => unit.id));
  const replenished = (await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...adjustment, direction: 'increase', requestIdempotencyKey: key() }, 201)).data.movement;
  assert.equal(replenished.units[0].sequence, 5); assert.ok(![...first.receipt.units, ...second.receipt.units].some(unit => unit.code === replenished.units[0].code));
  await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...adjustment, direction: 'increase', requestIdempotencyKey: key(), unitIds: [first.receipt.units[0].id] }, 400);
  assert.equal((await f.request('GET', `/api/materials/stock/units?catalogId=${s.catalog.id}&status=void`, s.material)).data.total, 3);
  assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.items[0].qtyM, 2000);
  const backup = (await f.request('GET', '/api/materials/backup', f.admin)).data, target = await fixture(t), targetMaterial = await target.account('MATERIAL');
  const wrongOrigin = structuredClone(backup), originalUnit = wrongOrigin.data.material_stock_units.find(unit => unit.id === first.receipt.units[1].id), reversedUnit = wrongOrigin.data.material_stock_units.find(unit => unit.id === second.receipt.units[0].id);
  [originalUnit.source_movement_id, reversedUnit.source_movement_id] = [reversedUnit.source_movement_id, originalUnit.source_movement_id];
  await target.request('POST', '/api/materials/restore', target.admin, wrongOrigin, 400);
  await target.request('POST', '/api/materials/restore', target.admin, backup);
  assert.equal((await target.request('GET', `/api/materials/stock/units?receiptId=${reversed.receipt.id}`, targetMaterial)).data.total, 2);
});

test('unit label collisions roll back sequence, stock and idempotency together', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  const unitCatalog = await f.catalog(s.category.id, { code: 'UNIT-COLLISION', trackingMode: 'unit' });
  await f.request('POST', `/api/materials/catalog/${s.catalog.id}/barcodes`, f.admin, { code: 'TAKEN-1', reason: '已有包装码' }, 201);
  await f.request('PUT', '/api/materials/unit-label-rule', f.admin, { template: 'TAKEN-{SEQ}', padding: 1, version: 1, reason: '故意测试冲突' });
  const opening = { catalogId: unitCatalog.id, regionId: s.region.id, warehouse: 'MAIN', quantity: '1', amount: '1', requestIdempotencyKey: key() };
  await f.request('POST', '/api/materials/stock/opening', s.material, opening, 409);
  assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.total, 0);
  assert.equal((await f.request('GET', '/api/materials/stock/units', s.material)).data.total, 0);
  assert.equal((await f.request('GET', '/api/materials/unit-label-rule', s.material)).data.nextSequence, 1);
  await f.request('PUT', '/api/materials/unit-label-rule', f.admin, { template: 'SAFE-{SEQ}', padding: 1, version: 2, reason: '避开已有包装码' });
  const saved = (await f.request('POST', '/api/materials/stock/opening', s.material, opening, 201)).data.movement;
  assert.equal(saved.units[0].code, 'SAFE-1');
  const maximum = (await f.request('POST', '/api/materials/stock/opening', s.material, { ...opening, quantity: '1000', amount: '0', zeroAmountReason: '上限整件赠品', requestIdempotencyKey: key() }, 201)).data.movement;
  assert.equal(maximum.units.length, 1000); assert.equal(maximum.units[999].sequence, 1001);
});

test('schema 5 restores exact unit codes, lifecycle, rule and user mappings, rejects damaged unit ledgers atomically, and accepts strict schema 3', { timeout: 45000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  await f.request('POST', `/api/materials/catalog/${s.catalog.id}/barcodes`, f.admin, { code: 'SKU-ONLY', reason: '包装码与单件分开' }, 201);
  const previous = legacyBackup((await f.request('GET', '/api/materials/backup', f.admin)).data, 3);
  s.catalog = await f.catalog(s.category.id, { code: 'UNIT-BACKUP', trackingMode: 'unit' });
  const identity = { catalogId: s.catalog.id, regionId: s.region.id, warehouse: 'REAGENT', batch: 'BACKUP', expiryDate: '' };
  await f.request('PUT', '/api/materials/unit-label-rule', s.material, { template: 'RESTORE-{SEQ}', padding: 4, version: 1, reason: '保留规则用户映射' });
  const opening = (await f.request('POST', '/api/materials/stock/opening', s.material, { ...identity, quantity: '3', amount: '1', requestIdempotencyKey: key() }, 201)).data.movement;
  const issue = (await f.request('POST', '/api/materials/issues', ordinary, { ...identity, quantity: '1', purpose: '备份领用', requestIdempotencyKey: key() }, 201)).data.issue;
  const action = { version: 1, requestIdempotencyKey: key(), unitIds: [opening.units[0].id] };
  await f.request('POST', `/api/materials/issues/${issue.id}/issue`, s.material, action, 201);
  await f.request('POST', '/api/materials/stock/adjustments', s.material, { ...identity, quantity: '1', amount: '0.34', direction: 'decrease', reason: '盘亏', requestIdempotencyKey: key(), unitIds: [opening.units[1].id] }, 201);
  const backup = (await f.request('GET', '/api/materials/backup', f.admin)).data;
  assert.equal(backup.schemaVersion, 5); assert.equal(backup.data.material_stock_units.length, 3);
  const target = await fixture(t); await target.account('FINANCE'); const targetOrdinary = await target.account('TESTER'), targetMaterial = await target.account('MATERIAL');
  assert.notEqual(targetMaterial.id, s.material.id);
  for (const change of [
    payload => payload.data.material_stock_units.pop(),
    payload => { payload.data.material_stock_units[1].code = payload.data.material_stock_units[0].code; },
    payload => { payload.data.material_stock_units[0].code = 'SKU-ONLY'; },
    payload => { payload.data.material_stock_units[0].sequence = 10; },
    payload => { payload.data.material_stock_units[0].status = 'void'; },
    payload => { payload.data.material_stock_units[0].created_by = ordinary.id; },
    payload => { payload.data.material_stock_units[0].region_id = s.otherRegion.id; },
    payload => { payload.data.material_stock_units[0].exit_movement_id = payload.data.material_stock_units[1].exit_movement_id; },
    payload => { payload.data.material_stock_units[2].created_at = 'yesterday'; },
    payload => { payload.data.material_catalog.find(row => row.id === s.catalog.id).tracking_mode = 'quantity'; },
    payload => { payload.data.material_state.find(row => row.key === 'unit_sequence').value = '0'; },
    payload => { const row = payload.data.material_state.find(row => row.key === 'unit_label_rule'); row.value = JSON.stringify({ ...JSON.parse(row.value), template: 'NO-SEQ' }); },
    payload => { const row = payload.data.material_state.find(row => row.key === 'unit_label_rule'); row.value = JSON.stringify({ ...JSON.parse(row.value), actorId: 99999 }); },
    payload => { delete payload.data.material_stock_units; }
  ]) {
    const damaged = structuredClone(backup); change(damaged);
    await target.request('POST', '/api/materials/restore', target.admin, damaged, 400);
    assert.equal((await target.request('GET', '/api/materials/catalog', targetMaterial)).data.total, 0);
    assert.equal((await target.request('GET', '/api/materials/unit-label-rule', targetMaterial)).data.nextSequence, 1);
  }
  await target.request('POST', '/api/materials/restore', target.admin, backup);
  const restored = (await target.request('GET', `/api/materials/stock/units?catalogId=${s.catalog.id}`, targetMaterial)).data;
  assert.deepEqual(restored.items.map(unit => unit.code), opening.units.map(unit => unit.code));
  assert.deepEqual(restored.items.map(unit => unit.status), ['issued', 'void', 'in_stock']);
  const rule = (await target.request('GET', '/api/materials/unit-label-rule', targetMaterial)).data;
  assert.equal(rule.nextSequence, 4); assert.equal(rule.rule.actorId, targetMaterial.id); assert.equal(rule.rule.template, 'RESTORE-{SEQ}');
  const replay = (await target.request('POST', `/api/materials/issues/${issue.id}/issue`, targetMaterial, action)).data.issue;
  assert.equal(replay.createdBy, targetOrdinary.id); assert.equal(replay.units[0].code, opening.units[0].code);
  const oldTarget = await fixture(t); await oldTarget.account('TESTER'); const oldMaterial = await oldTarget.account('MATERIAL');
  const mixed = structuredClone(previous); mixed.data.material_catalog[0].tracking_mode = 'quantity';
  await oldTarget.request('POST', '/api/materials/restore', oldTarget.admin, mixed, 400);
  await oldTarget.request('POST', '/api/materials/restore', oldTarget.admin, previous);
  assert.equal((await oldTarget.request('GET', '/api/materials/catalog', oldMaterial)).data.items[0].trackingMode, 'quantity');
  assert.equal((await oldTarget.request('GET', '/api/materials/stock/units', oldMaterial)).data.total, 0);
  assert.equal((await oldTarget.request('GET', '/api/materials/unit-label-rule', oldMaterial)).data.nextSequence, 1);
});

test('receipt location is saved atomically with stock and versions and cannot bypass the location grant', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  let order = await f.submit(await f.order(s.material, f.item(s, { quantity: '4' })));
  const firstBody = f.receiptBody(order, { quantity: '1', amount: '5', location: '试剂柜 A / 01', locationVersion: 0 });
  const first = (await f.request('POST', '/api/materials/receipts', s.material, firstBody, 201)).data;
  order = first.request;
  assert.equal(first.receipt.snapshot.location, '试剂柜 A / 01');
  let batch = (await f.request('GET', '/api/materials/stock/batches', s.material)).data.items[0];
  assert.equal(batch.location, '试剂柜 A / 01'); assert.equal(batch.locationVersion, 1); assert.equal(batch.qtyM, 1000);
  assert.equal((await f.request('POST', '/api/materials/receipts', s.material, firstBody)).data.receipt.id, first.receipt.id);
  const stale = f.receiptBody(order, { location: '柜 B', locationVersion: 0 });
  await f.request('POST', '/api/materials/receipts', s.material, stale, 409);
  assert.deepEqual(await f.get(order.id), order);
  await f.request('PUT', '/api/permissions/roles/MATERIAL', f.admin, { permissions: ['materials.read', 'materials.acceptance.write', 'materials.amount.read'] });
  await f.request('POST', '/api/materials/receipts', s.material, { ...stale, locationVersion: 1 }, 403);
  const afterPermissionChange = await f.get(order.id);
  assert.equal(afterPermissionChange.version, order.version); assert.equal(afterPermissionChange.items[0].acceptedQtyM, order.items[0].acceptedQtyM);
  const unchanged = (await f.request('POST', '/api/materials/receipts', s.material,
    f.receiptBody(order, { location: batch.location, locationVersion: 1 }), 201)).data;
  assert.equal(unchanged.receipt.snapshot.location, batch.location);
  order = unchanged.request;
  const omitted = (await f.request('POST', '/api/materials/receipts', s.material, f.receiptBody(order), 201)).data;
  assert.equal(omitted.receipt.snapshot.location, batch.location);
  batch = (await f.request('GET', '/api/materials/stock/batches', s.material)).data.items[0];
  assert.equal(batch.qtyM, 3000); assert.equal(batch.locationVersion, 1);
});

test('opening documents keep drafts separate, post once, generate whole-item labels and supplement a closed ledger without reopening it', { timeout: 45000 }, async t => {
  const f = await fixture(t), s = await f.seed(), ordinary = await f.account('TESTER');
  const master = await f.catalog(s.category.id, { code: 'UNIT-OPENING', trackingMode: 'unit' });
  const header = { title: '期初清点', date: '2026-10-19', description: '合成库存' };
  for (const actor of [f.admin, ordinary]) await f.request('POST', '/api/materials/openings', actor, header, 403);
  let document = (await f.request('POST', '/api/materials/openings', s.material, header, 201)).data;
  assert.equal(document.kind, 'opening'); assert.equal(document.status, 'draft');
  const row = { catalogId: master.id, regionId: s.region.id, warehouse: 'MAIN', quantity: '2', amount: '10', location: '期初柜', locationVersion: 0 };
  await f.request('POST', `/api/materials/openings/${document.id}/items`, ordinary, { version: document.version, ...row }, 403);
  document = (await f.request('POST', `/api/materials/openings/${document.id}/items`, s.material, { version: document.version, ...row }, 201)).data;
  assert.equal(document.items[0].qtyM, 2000); assert.equal(document.items[0].location, '期初柜');
  assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.total, 0);
  assert.equal((await f.request('GET', '/api/materials/stock/units', s.material)).data.total, 0);
  await f.request('POST', `/api/materials/openings/${document.id}/items`, s.material, { version: 1, ...row }, 409);
  const action = { version: document.version, requestIdempotencyKey: key() };
  const posted = await Promise.all([1, 2].map(() => f.request('POST', `/api/materials/openings/${document.id}/post`, s.material, action, [200, 201])));
  assert.deepEqual(posted.map(result => result.status).sort(), [200, 201]);
  document = posted[0].data.opening;
  assert.equal(document.status, 'posted'); assert.equal(document.unitCount, 2); assert.equal(document.items[0].unitCount, 2);
  const units = (await f.request('GET', `/api/materials/stock/units?openingId=${document.id}`, ordinary)).data;
  assert.equal(units.total, 2); assert.equal(units.items[0].location, '期初柜');
  assert.equal(units.items[0].warehouseName, '默认仓库');
  await f.request('PATCH', `/api/materials/openings/${document.id}`, s.material, { ...header, version: document.version }, 409);
  await f.request('POST', `/api/materials/openings/${document.id}/post`, s.material, { ...action, requestIdempotencyKey: key() }, 409);
  const oldDraft = (await f.request('POST', '/api/materials/openings', s.material, header, 201)).data;
  await f.request('POST', '/api/materials/stock/opening/close', s.material, { reason: '关闭期初' });
  await f.request('PATCH', `/api/materials/openings/${oldDraft.id}`, s.material, { ...header, version: oldDraft.version }, 409);
  await f.request('POST', '/api/materials/openings', s.material, header, 400);
  const rolePermissions = ['materials.read', 'materials.stock.initialize', 'materials.stock.adjust', 'materials.stock.location', 'materials.amount.read', 'materials.export'];
  await f.request('PUT', '/api/permissions/roles/MATERIAL', f.admin, { permissions: rolePermissions.filter(permission => permission !== 'materials.stock.adjust') });
  await f.request('POST', '/api/materials/openings', s.material, { ...header, reason: '遗漏一瓶' }, 403);
  await f.request('PUT', '/api/permissions/roles/MATERIAL', f.admin, { permissions: rolePermissions });
  let supplement = (await f.request('POST', '/api/materials/openings', s.material, { ...header, reason: '遗漏一瓶' }, 201)).data;
  assert.equal(supplement.kind, 'supplement');
  supplement = (await f.request('POST', `/api/materials/openings/${supplement.id}/items`, s.material,
    { version: supplement.version, ...row, quantity: '1', locationVersion: 1 }, 201)).data;
  supplement = (await f.request('POST', `/api/materials/openings/${supplement.id}/post`, s.material,
    { version: supplement.version, requestIdempotencyKey: key() }, 201)).data.opening;
  assert.equal(supplement.unitCount, 1); assert.equal((await f.request('GET', '/api/materials/meta', s.material)).data.openingClosed, true);
  const movements = (await f.request('GET', '/api/materials/stock/movements', s.material)).data.items;
  assert.equal(movements.length, 2); assert.equal(movements[0].type, 'adjustment'); assert.match(movements[0].reason, /遗漏一瓶/);
  assert.equal((await f.request('GET', '/api/materials/stock/movements?type=opening', ordinary)).data.total, 1);
  assert.equal((await f.request('GET', '/api/materials/openings', ordinary)).data.total, 3);
  const stock = (await f.request('GET', '/api/materials/stock', s.material)).data.items[0];
  assert.equal(stock.qtyM, 3000); assert.equal(stock.amountCents, 2000);
});

test('opening XLSX import validates every row before adding a draft, rejects unsafe workbooks and round-trips the exported data', { timeout: 45000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  const master = await f.catalog(s.category.id, { code: '0000123', name: '=Literal name', trackingMode: 'unit' });
  const header = { title: 'Excel 清点', date: '2026-10-19' };
  let document = (await f.request('POST', '/api/materials/openings', s.material, header, 201)).data;
  const template = await f.request('GET', '/api/materials/openings/template.xlsx', s.material);
  assert.match([...workbookXml(template.bytes).values()].join('\n'), /物资名称/);
  const rows = [[master.code, s.region.name, 'MAIN', 2, 10.25, 'B1', '2028-01-01', '=柜 A', ''],
    [s.catalog.code, s.otherRegion.name, 'REAGENT', '1.5', '0', '', '', '', '历史赠品']];
  const importBody = bytes => ({ version: document.version, name: '盘点.xlsx', content: bytes.toString('base64') });
  const invalidRows = await openingExcel([rows[0], ['UNKNOWN', ...rows[1].slice(1)]]);
  await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, importBody(invalidRows), 400);
  assert.deepEqual((await f.request('GET', `/api/materials/openings/${document.id}`, s.material)).data, document);
  const bytes = await openingExcel(rows);
  await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, { ...importBody(bytes), name: 'legacy.xls' }, 400);
  await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, { ...importBody(bytes), content: 'invalid-base64' }, 400);
  const formula = await openingExcel([[master.code, s.region.name, 'MAIN', { type: 'Formula', value: '1+1' }, 10, '', '', '', '']]);
  await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, importBody(formula), 400);
  const { zipSync, unzipSync, strToU8 } = require('fflate');
  const malicious = unzipSync(bytes);
  malicious['xl/worksheets/sheet1.xml'] = strToU8(new TextDecoder().decode(malicious['xl/worksheets/sheet1.xml']).replace(/<worksheet\b/, '<!DOCTYPE x [<!ENTITY y "bad">]><worksheet'));
  await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, importBody(Buffer.from(zipSync(malicious))), 400);
  const external = unzipSync(bytes); external['xl/externalLinks/externalLink1.xml'] = strToU8('<externalLink/>');
  await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, importBody(Buffer.from(zipSync(external))), 400);
  const sparse = unzipSync(bytes);
  sparse['xl/worksheets/sheet1.xml'] = strToU8(new TextDecoder().decode(sparse['xl/worksheets/sheet1.xml']).replace('<row r="2"', '<row r="1048576"'));
  await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, importBody(Buffer.from(zipSync(sparse))), 400);
  const huge = Buffer.from(bytes); let central = huge.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  huge.writeUInt32LE(20 * 1024 * 1024, central + 24);
  await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, importBody(huge), 400);
  document = (await f.request('POST', `/api/materials/openings/${document.id}/import`, s.material, importBody(bytes), 201)).data;
  assert.equal(document.items.length, 2); assert.equal(document.items[0].code, '0000123'); assert.equal(document.items[0].location, '=柜 A');
  assert.equal(document.items[0].amountCents, 1025); assert.equal(document.items[1].qtyM, 1500);
  assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.total, 0);
  const exported = await f.request('GET', `/api/materials/openings/${document.id}/export.xlsx`, s.material);
  const target = (await f.request('POST', '/api/materials/openings', s.material, { ...header, title: '重新导入' }, 201)).data;
  const copied = (await f.request('POST', `/api/materials/openings/${target.id}/import`, s.material,
    { version: target.version, name: 'export.xlsx', content: exported.bytes.toString('base64') }, 201)).data;
  assert.deepEqual(copied.items.map(({ id, ...row }) => row), document.items.map(({ id, ...row }) => row));
  const limited = await f.customAccount('OPENING_READER', ['materials.read', 'materials.export']);
  assertNoMoney((await f.request('GET', `/api/materials/openings/${document.id}`, limited)).data);
  const redacted = await f.request('GET', `/api/materials/openings/${document.id}/export.xlsx`, limited);
  assert.doesNotMatch([...workbookXml(redacted.bytes).values()].join('\n'), /总金额|10\.25/);
  const posted = (await f.request('POST', `/api/materials/openings/${document.id}/post`, s.material,
    { version: document.version, requestIdempotencyKey: key() }, 201)).data.opening;
  assert.equal(posted.unitCount, 2); assert.equal((await f.request('GET', '/api/materials/stock', s.material)).data.total, 2);
});

test('opening posting rolls back locations, stock, generated codes and retry tokens when a later line fails, and guards position races', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  const master = await f.catalog(s.category.id, { code: 'ATOMIC-UNIT', trackingMode: 'unit' });
  const rule = (await f.request('GET', '/api/materials/unit-label-rule', s.material)).data;
  await f.request('PUT', '/api/materials/unit-label-rule', s.material, { version: rule.rule.version, template: 'ROLL-{SEQ}', padding: 2, reason: '合成测试' });
  await f.request('POST', `/api/materials/catalog/${s.catalog.id}/barcodes`, s.material, { code: 'ROLL-02', reason: '制造后续单件冲突' }, 201);
  let document = (await f.request('POST', '/api/materials/openings', s.material, { title: '全单事务' }, 201)).data;
  const row = { catalogId: master.id, regionId: s.region.id, warehouse: 'MAIN', quantity: '1', amount: '1', location: '回滚位置', locationVersion: 0 };
  document = (await f.request('POST', `/api/materials/openings/${document.id}/items`, s.material, { version: document.version, ...row }, 201)).data;
  document = (await f.request('POST', `/api/materials/openings/${document.id}/items`, s.material, { version: document.version, ...row, batch: 'SECOND' }, 201)).data;
  const action = { version: document.version, requestIdempotencyKey: key() };
  await f.request('POST', `/api/materials/openings/${document.id}/post`, s.material, action, 409);
  assert.deepEqual((await f.request('GET', `/api/materials/openings/${document.id}`, s.material)).data, document);
  const backup = (await f.request('GET', '/api/materials/backup', f.admin)).data;
  for (const table of ['material_stock_locations', 'material_stock_movements', 'material_stock_units', 'material_idempotency']) assert.equal(backup.data[table].length, 0, table);
  assert.equal((await f.request('GET', '/api/materials/unit-label-rule', s.material)).data.nextSequence, 1);
  await f.request('PUT', '/api/materials/unit-label-rule', s.material, { version: 2, template: 'SUCCESS-{SEQ}', padding: 2, reason: '消除冲突' });
  const posted = (await f.request('POST', `/api/materials/openings/${document.id}/post`, s.material, action, 201)).data.opening;
  assert.equal(posted.unitCount, 2);
  let stale = (await f.request('POST', '/api/materials/openings', s.material, { title: '位置版本冲突' }, 201)).data;
  stale = (await f.request('POST', `/api/materials/openings/${stale.id}/items`, s.material, { version: stale.version, ...row, locationVersion: 1 }, 201)).data;
  await f.request('PUT', '/api/materials/stock/location', s.material, { ...row, batch: '', expiryDate: '', version: 1, location: '移动后的柜', reason: '位置竞争' });
  await f.request('POST', `/api/materials/openings/${stale.id}/post`, s.material, { version: stale.version, requestIdempotencyKey: key() }, 409);
  assert.equal((await f.request('GET', '/api/materials/stock/units', s.material)).data.total, 2);
  const max = (await f.request('POST', '/api/materials/openings', s.material, { title: '生成上限' }, 201)).data;
  let large = (await f.request('POST', `/api/materials/openings/${max.id}/items`, s.material, { version: max.version, ...row, batch: 'MAX-A', quantity: '600' }, 201)).data;
  large = (await f.request('POST', `/api/materials/openings/${max.id}/items`, s.material, { version: large.version, ...row, batch: 'MAX-B', quantity: '600' }, 201)).data;
  await f.request('POST', `/api/materials/openings/${large.id}/post`, s.material, { version: large.version, requestIdempotencyKey: key() }, 400);
});

test('opening import rechecks login and current grants after asynchronous parsing before writing or returning amounts', async t => {
  const postgres = await createTestDatabase(t), db = await postgres.open();
  await db.exec("INSERT INTO users(id,username,display_name) VALUES(1,'synthetic','Synthetic');");
  const authorized = { id: 1, role: 'MATERIAL', permissions: ['materials.read', 'materials.stock.initialize', 'materials.amount.read', 'materials.stock.location'] };
  let reads = 0, fresh = authorized, payload, response;
  const materials = createMaterials({ db, body: async () => payload, send: (_res, status, data) => { response = { status, data }; },
    fail: (status, message) => Object.assign(new Error(message), { status }), log() {}, hasPermission: (user, permission) => user.permissions.includes(permission),
    tokenUser: () => ++reads === 1 ? authorized : fresh, uploads: path.join(root, 'artifacts/cache', require('../package.json').version, 'unused-import-test') });
  (await db.exec(`INSERT INTO material_categories(id,name,created_by) VALUES(1,'分类',1);
    INSERT INTO material_regions(id,name,created_by) VALUES(1,'区域',1);
    INSERT INTO material_catalog(id,code,name,spec,unit,category_id,created_by) VALUES(1,'RACE-IMPORT','物资','规格','瓶',1,1);
    INSERT INTO material_openings(id,no,title,date,kind,created_by,created_at) VALUES(1,'QC-20261019-1234567890','草稿','2026-10-19','opening',1,'2026-10-19T00:00:00.000Z');`));
  const bytes = await openingExcel([['RACE-IMPORT', '区域', 'MAIN', 1, 3.25, '', '', '异步柜', '']]);
  payload = { version: 1, name: 'race.xlsx', content: bytes.toString('base64') };
  for (const [current, expected] of [
    [null, 401],
    [{ ...authorized, permissions: authorized.permissions.filter(permission => permission !== 'materials.stock.initialize') }, 403],
    [{ ...authorized, permissions: authorized.permissions.filter(permission => permission !== 'materials.amount.read') }, 403],
    [{ ...authorized, permissions: authorized.permissions.filter(permission => permission !== 'materials.stock.location') }, 403]
  ]) {
    reads = 0; fresh = current;
    await assert.rejects(materials.handle({ method: 'POST' }, {}, new URL('http://localhost/api/materials/openings/1/import')), { status: expected });
    assert.equal(reads, 2);
    assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM material_opening_items').get()).total, 0);
    assert.equal((await db.prepare('SELECT version FROM material_openings WHERE id=1').get()).version, 1);
  }
  reads = 0; fresh = authorized;
  await materials.handle({ method: 'POST' }, {}, new URL('http://localhost/api/materials/openings/1/import'));
  assert.equal(response.status, 201); assert.equal(response.data.items[0].amountCents, 325);
});

test('schema 5 restores opening and supplement documents, exact labels and drafts while strictly accepting schema 4 without invented documents', { timeout: 45000 }, async t => {
  const f = await fixture(t), s = await f.seed();
  await f.catalog(s.category.id, { code: 'RESTORE-UNIT', trackingMode: 'unit' });
  const master = (await f.request('GET', '/api/materials/catalog?trackingMode=unit', s.material)).data.items.find(row => row.code === 'RESTORE-UNIT');
  let document = (await f.request('POST', '/api/materials/openings', s.material, { title: '恢复期初' }, 201)).data;
  document = (await f.request('POST', `/api/materials/openings/${document.id}/items`, s.material,
    { version: document.version, catalogId: master.id, regionId: s.region.id, warehouse: 'MAIN', quantity: '2', amount: '3', location: '保留柜', locationVersion: 0 }, 201)).data;
  document = (await f.request('POST', `/api/materials/openings/${document.id}/post`, s.material, { version: document.version, requestIdempotencyKey: key() }, 201)).data.opening;
  await f.request('POST', '/api/materials/stock/opening/close', s.material, { reason: '结束期初' });
  const draft = (await f.request('POST', '/api/materials/openings', s.material, { title: '补录草稿', reason: '等待核对' }, 201)).data;
  let supplement = (await f.request('POST', '/api/materials/openings', s.material, { title: '已补录', reason: '补齐漏登' }, 201)).data;
  supplement = (await f.request('POST', `/api/materials/openings/${supplement.id}/items`, s.material,
    { version: supplement.version, catalogId: master.id, regionId: s.region.id, warehouse: 'MAIN', quantity: '1', amount: '1', location: '保留柜', locationVersion: 1 }, 201)).data;
  supplement = (await f.request('POST', `/api/materials/openings/${supplement.id}/post`, s.material,
    { version: supplement.version, requestIdempotencyKey: key() }, 201)).data.opening;
  const backup = (await f.request('GET', '/api/materials/backup', f.admin)).data;
  assert.equal(backup.schemaVersion, 5); assert.equal(backup.data.material_openings.length, 3);
  const target = await fixture(t); await target.account('TESTER'); const material = await target.account('MATERIAL');
  for (const change of [
    data => { data.material_opening_items[0].qty_m += 1000; },
    data => { data.material_openings[0].status = 'draft'; data.material_openings[0].posted_by = null; data.material_openings[0].posted_at = null; },
    data => { data.material_opening_items[0].movement_id = null; },
    data => { data.material_opening_items[0].location = '损坏位置'; },
    data => { data.material_openings[1].reason = ''; },
    data => { data.material_stock_movements[0].source_key = 'opening-doc:9999:9999'; }
  ]) {
    const damaged = structuredClone(backup); change(damaged.data);
    await target.request('POST', '/api/materials/restore', target.admin, damaged, 400);
    assert.equal((await target.request('GET', '/api/materials/openings', material)).data.total, 0);
  }
  await target.request('POST', '/api/materials/restore', target.admin, backup);
  const restored = (await target.request('GET', `/api/materials/openings/${document.id}`, material)).data;
  assert.equal(restored.createdBy, material.id); assert.equal(restored.postedBy, material.id); assert.equal(restored.unitCount, 2);
  assert.equal(restored.items[0].location, '保留柜'); assert.equal(restored.items[0].movementId, document.items[0].movementId);
  assert.equal((await target.request('GET', `/api/materials/openings/${draft.id}`, material)).data.status, 'draft');
  const restoredSupplement = (await target.request('GET', `/api/materials/openings/${supplement.id}`, material)).data;
  assert.equal(restoredSupplement.kind, 'supplement'); assert.equal(restoredSupplement.status, 'posted'); assert.equal(restoredSupplement.postedBy, material.id);
  assert.equal((await target.request('GET', `/api/materials/stock/units?openingId=${supplement.id}`, material)).data.total, 1);
  const legacy = await fixture(t), legacySeed = await legacy.seed();
  await legacy.request('POST', '/api/materials/stock/opening', legacySeed.material,
    { catalogId: legacySeed.catalog.id, regionId: legacySeed.region.id, warehouse: 'MAIN', quantity: '3', amount: '3', requestIdempotencyKey: key() }, 201);
  const old = (await legacy.request('GET', '/api/materials/backup', legacy.admin)).data;
  old.schemaVersion = 4; delete old.data.material_openings; delete old.data.material_opening_items;
  const oldTarget = await fixture(t), oldMaterial = await oldTarget.account('MATERIAL');
  const mixed = structuredClone(old); mixed.data.material_openings = [];
  await oldTarget.request('POST', '/api/materials/restore', oldTarget.admin, mixed, 400);
  await oldTarget.request('POST', '/api/materials/restore', oldTarget.admin, old);
  assert.equal((await oldTarget.request('GET', '/api/materials/openings', oldMaterial)).data.total, 0);
  assert.equal((await oldTarget.request('GET', '/api/materials/stock/movements?type=opening', oldMaterial)).data.total, 1);
});
