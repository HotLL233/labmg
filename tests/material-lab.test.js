'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const createMaterialLab = require('../src/material-lab');
const createMaterials = require('../src/materials');
const { createTestDatabase } = require('./helpers/postgres');
const { CATALOG_HEADERS, BASIC_CATALOG_HEADERS, readCatalogWorkbook, workbookSheet } = require('../src/material-xlsx');
const write = require('write-excel-file/node').default;

const fail = (status, message) => Object.assign(new Error(message), { status });
const permitted = user => Boolean(user && String(user.role).includes('ADMIN'));
const upload = bytes => ({ name: '试剂信息.xlsx', content: bytes.toString('base64') });
const workbook = (headers, rows) => write([workbookSheet('物资信息', headers, rows)]).toBuffer();

async function fixture(t) {
  const server = await createTestDatabase(t), db = await server.open();
  await db.prepare('INSERT INTO users(username,password,display_name,role) VALUES(?,?,?,?)').run('lab-admin', 'synthetic', 'Lab administrator', 'ADMIN,MATERIAL');
  await db.prepare('INSERT INTO users(username,password,display_name,role) VALUES(?,?,?,?)').run('lab-user', 'synthetic', 'Lab user', 'USER');
  const user = await db.prepare('SELECT * FROM users WHERE username=?').get('lab-admin');
  const reader = await db.prepare('SELECT * FROM users WHERE username=?').get('lab-user');
  const cache = path.resolve(__dirname, '../artifacts/cache', require('../package.json').version, 'lab-tests');
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'run-'));
  t.after(() => { assert.equal(path.dirname(directory), cache); assert.match(path.basename(directory), /^run-/); fs.rmSync(directory, { recursive: true, force: true }); });
  const log = async (actor, action, entity, id, detail) => db.prepare('INSERT INTO audit_logs(user_id,action,entity,entity_id,detail) VALUES(?,?,?,?,?)').run(actor.id, action, entity, id, detail);
  const lab = createMaterialLab({ db, fail, hasPermission: permitted, log });
  const materials = createMaterials({ db, body: async req => req.payload ?? {}, send: (res, status, value) => { res.status = status; res.data = value; }, fail, log, hasPermission: permitted, uploads: directory });
  async function call(method, route, payload, actor = user) {
    const response = { headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers; }, setHeader(name, value) { this.headers[name] = value; }, end(bytes) { this.bytes = bytes; } };
    await materials.handle({ method, payload }, response, new URL('/api/materials' + route, 'http://127.0.0.1'), actor);
    return response;
  }
  return { db, user, reader, lab, materials, call };
}

test('laboratory fields validate CAS checksum and SDS schemes while omitted values remain intact', () => {
  const lab = createMaterialLab({ fail });
  const fields = lab.fields({ casNumber: '64-17-5', purity: '分析纯', storageConditions: '避光', sdsUrl: 'https://example.invalid/ethanol.pdf' });
  assert.deepEqual(lab.view(fields), { casNumber: '64-17-5', purity: '分析纯', storageConditions: '避光', sdsUrl: 'https://example.invalid/ethanol.pdf' });
  assert.deepEqual(lab.fields({}, fields), fields);
  assert.equal(lab.fields({ purity: '' }, fields).purity, '');
  for (const casNumber of ['64-17-0', 'x64-17-5', '064-17-5', '64-17-5\nother']) assert.throws(() => lab.fields({ casNumber }), { status: 400 });
  for (const sdsUrl of ['javascript:alert(1)', 'file:///C:/sds.pdf', '//example.invalid/sds', 'https://user:password@example.invalid/sds']) assert.throws(() => lab.fields({ sdsUrl }), { status: 400 });
  assert.throws(() => lab.fields({ purity: 99 }), { status: 400 });
});

test('storage tree enforces permissions, optimistic versions, inherited state, cycles and path references', async t => {
  const f = await fixture(t);
  const create = async input => (await f.call('POST', '/storage-places', input)).data;
  const parent = await create({ name: '一号实验室' });
  const child = await create({ name: '试剂柜', parentId: parent.id });
  const leaf = await create({ name: '第二层', parentId: child.id });
  assert.equal(leaf.path, '一号实验室 / 试剂柜 / 第二层');
  assert.equal(leaf.depth, 2);
  const read = (await f.call('GET', '/storage-places', undefined, f.reader)).data;
  assert.equal(read.total, 3);
  await assert.rejects(f.call('POST', '/storage-places', { name: '无权新增' }, f.reader), { status: 403 });
  await assert.rejects(create({ name: '试剂柜', parentId: parent.id }), { status: 409 });
  await assert.rejects(create({ name: '错误/名称' }), { status: 400 });
  await assert.rejects(f.call('PATCH', `/storage-places/${leaf.id}`, { version: 99, reason: '冲突', name: '新名' }), { status: 409 });
  await assert.rejects(f.call('PATCH', `/storage-places/${leaf.id}`, { version: leaf.version, reason: '循环', parentId: leaf.id }), { status: 400 });
  await assert.rejects(f.call('DELETE', `/storage-places/${parent.id}`, { version: parent.version, reason: '有子级' }), { status: 409 });
  await f.call('PATCH', `/storage-places/${parent.id}`, { version: parent.version, reason: '暂不使用', active: false });
  assert.equal((await f.call('GET', '/storage-places')).data.items.find(row => row.id === leaf.id).effectiveActive, false);
  await f.call('PATCH', `/storage-places/${leaf.id}`, { version: leaf.version, reason: '子级停用', active: false });
  await assert.rejects(create({ name: '新层', parentId: child.id }), { status: 400 });
  await f.call('PATCH', `/storage-places/${parent.id}`, { version: parent.version + 1, reason: '恢复', active: true });

  const category = (await f.call('POST', '/categories', { name: '试剂', profile: 'chemical' })).data;
  const region = (await f.call('POST', '/regions', { name: '区域' })).data;
  const catalog = (await f.call('POST', '/catalog', { name: '乙醇', spec: '500mL', unit: '瓶', categoryId: category.id })).data;
  await f.db.prepare('INSERT INTO material_stock_locations(catalog_id,region_id,warehouse,location,version,reason,actor_id,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(catalog.id, region.id, 'MAIN', leaf.path, 1, '合成位置', f.user.id, new Date().toISOString());
  await assert.rejects(f.call('DELETE', `/storage-places/${leaf.id}`, { version: leaf.version + 1, reason: '有库存引用' }), failure => failure.status === 409 && /库存/.test(failure.message));
  await assert.rejects(f.call('PATCH', `/storage-places/${leaf.id}`, { version: leaf.version + 1, reason: '有引用更名', name: '第三层' }), { status: 409 });
  const unused = await create({ name: '误建库位' });
  assert.equal((await f.call('DELETE', `/storage-places/${unused.id}`, { version: unused.version, reason: '误建' })).data.deleted, true);
  assert.ok((await f.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entity='material_storage_places'").get()).n >= 7);
});

test('classification and laboratory information share versioned catalog maintenance and round-trip Excel', async t => {
  const f = await fixture(t);
  let category = (await f.call('POST', '/categories', { name: '化学试剂', profile: 'chemical' })).data;
  assert.equal(category.profile, 'chemical');
  await assert.rejects(f.call('PATCH', `/categories/${category.id}/profile`, { profile: 'general', version: category.version, reason: '无权' }, f.reader), { status: 403 });
  category = (await f.call('PATCH', `/categories/${category.id}/profile`, { profile: 'general', version: category.version, reason: '类型维护' })).data;
  await assert.rejects(f.call('PATCH', `/categories/${category.id}/profile`, { profile: 'chemical', version: category.version - 1, reason: '过期' }), { status: 409 });
  const data = { name: '乙醇', spec: '500mL', unit: '瓶', categoryId: category.id, trackingMode: 'unit', casNumber: '64-17-5', purity: '分析纯', storageConditions: '阴凉避光', sdsUrl: 'https://example.invalid/ethanol.pdf' };
  let catalog = (await f.call('POST', '/catalog', data)).data;
  assert.equal(catalog.casNumber, data.casNumber);
  const code = catalog.code;
  catalog = (await f.call('PATCH', `/catalog/${catalog.id}`, { version: catalog.version, reason: '补说明', remark: '合成备注' })).data.catalog;
  assert.equal(catalog.casNumber, data.casNumber);
  assert.equal(catalog.storageConditions, data.storageConditions);
  assert.equal(catalog.code, code);
  await assert.rejects(f.call('PATCH', `/catalog/${catalog.id}`, { version: catalog.version, reason: '校验错误', casNumber: '64-17-0' }), { status: 400 });

  const exported = await f.call('GET', '/catalog/export.xlsx');
  const parsed = await readCatalogWorkbook(upload(exported.bytes));
  assert.deepEqual(parsed.headers, CATALOG_HEADERS);
  assert.equal(parsed.rows[0].values['CAS号'], data.casNumber);
  assert.equal(parsed.rows[0].values['SDS链接'], data.sdsUrl);
  const imported = (await f.call('POST', '/catalog/import', upload(exported.bytes))).data;
  assert.equal(imported.skipped, 1);
  const old = await workbook(BASIC_CATALOG_HEADERS, [['乙醇', '500mL', '瓶', category.name, '逐件', '合成备注']]);
  assert.equal((await f.call('POST', '/catalog/import', upload(old))).data.skipped, 1);
  assert.equal((await f.db.prepare('SELECT cas_number FROM material_catalog WHERE id=?').get(catalog.id)).cas_number, data.casNumber);

  const bad = await workbook(CATALOG_HEADERS, [
    ['新试剂', '100mL', '瓶', category.name, '逐件', '', '7732-18-5', '', '', ''],
    ['错误试剂', '100mL', '瓶', category.name, '逐件', '', '64-17-0', '', '', '']
  ]);
  await assert.rejects(f.call('POST', '/catalog/import', upload(bad)), failure => {
    assert.equal(failure.code, 'IMPORT_VALIDATION');
    assert.ok(failure.errors.some(entry => entry.row === 3 && entry.column === 'G' && entry.field === 'CAS号'));
    return true;
  });
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM material_catalog').get()).n, 1);
  const changed = await workbook(CATALOG_HEADERS, [['乙醇', '500mL', '瓶', category.name, '逐件', '合成备注', '64-17-5', '95%', '阴凉避光', data.sdsUrl]]);
  await assert.rejects(f.call('POST', '/catalog/import', upload(changed)), failure => failure.status === 409 && failure.errors.some(entry => entry.column === 'H' && entry.field === '纯度／浓度'));
});

test('full backup preserves laboratory fields and storage paths, rejects cycles and unsafe SDS links', async t => {
  const f = await fixture(t), target = await fixture(t);
  const category = (await f.call('POST', '/categories', { name: '试剂', profile: 'chemical' })).data;
  await f.call('POST', '/catalog', { name: '水', spec: '500mL', unit: '瓶', categoryId: category.id, casNumber: '7732-18-5', sdsUrl: 'https://example.invalid/water.pdf' });
  const parent = (await f.call('POST', '/storage-places', { name: '实验室' })).data;
  const child = (await f.call('POST', '/storage-places', { name: '柜一', parentId: parent.id })).data;
  const backup = await f.materials.backup(f.user);
  assert.equal(backup.schemaVersion, 8);
  const corruptTree = structuredClone(backup);
  corruptTree.data.material_storage_places[0].parent_id = child.id;
  await assert.rejects(target.materials.restore(corruptTree, target.user), { status: 400 });
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM material_storage_places').get()).n, 0);
  const corruptUrl = structuredClone(backup);
  corruptUrl.data.material_catalog[0].sds_url = 'javascript:alert(1)';
  await assert.rejects(target.materials.restore(corruptUrl, target.user), { status: 400 });
  for (const timestamps of [
    { created_at: '2026-02-30T00:00:00.000Z' },
    { updated_at: 'Wed, 01 Jan 2020 00:00:00 GMT' },
    { created_at: '2026-10-23T01:00:00.000Z', updated_at: '2026-10-23T00:00:00.000Z' }
  ]) {
    const corruptTime = structuredClone(backup);
    Object.assign(corruptTime.data.material_storage_places[0], timestamps);
    await assert.rejects(target.materials.restore(corruptTime, target.user), failure => failure.status === 400 && /库位时间/.test(failure.message));
    assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM material_storage_places').get()).n, 0);
  }
  const restored = await target.materials.restore(backup, target.user);
  assert.equal(restored.restored, true);
  assert.equal((await target.db.prepare('SELECT cas_number FROM material_catalog').get()).cas_number, '7732-18-5');
  assert.equal((await target.call('GET', '/storage-places')).data.items.find(row => row.id === child.id).path, child.path);
  assert.equal((await target.db.prepare('SELECT profile FROM material_categories').get()).profile, 'chemical');
  assert.ok((await target.call('POST', '/storage-places', { name: '恢复后新增' })).data.id > child.id);
});
