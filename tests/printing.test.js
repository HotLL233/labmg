'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createTestDatabase } = require('./helpers/postgres');
const { COLUMNS } = require('../src/printing');

async function fixture(t) {
  const target = await createTestDatabase(t), db = await target.open();
  const cache = path.resolve(__dirname, '../artifacts/cache', require('../package.json').version, 'printing-tests');
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'run-'));
  fs.cpSync(path.resolve(__dirname, '../src'), path.join(directory, 'src'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../package.json'), path.join(directory, 'package.json'));
  fs.mkdirSync(path.join(directory, 'scripts'));
  const agentBytes = fs.readFileSync(path.resolve(__dirname, '../scripts/bartender-agent.ps1'));
  fs.writeFileSync(path.join(directory, 'scripts/bartender-agent.ps1'), agentBytes);
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(directory, 'src/server.js')], { cwd: directory, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DATABASE_URL: target.url, PORT: String(port),
      LABOS_RUNTIME_DIR: path.join(directory, 'runtime'), LABOS_ADMIN_USER: 'printing-admin', LABOS_ADMIN_PASSWORD: 'printing-test-password' } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    assert.equal(path.dirname(directory), cache);
    assert.match(path.basename(directory), /^run-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(15000) });
  assert.match(String(output), /LabOS:/, stderr);
  async function request(method, route, actor, payload, expected = 200) {
    const headers = {};
    if (actor?.cookie) headers.Cookie = actor.cookie;
    if (actor?.token) headers.Authorization = 'Bearer ' + actor.token;
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers,
      body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${route}: ${response.status} ${JSON.stringify(data)}`);
    return { data, response };
  }
  const login = async username => {
    const { data, response } = await request('POST', '/api/auth/login', null, { username, password: 'printing-test-password' });
    return { ...data.user, cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const admin = await login('printing-admin');
  async function account(username, roles) {
    await request('POST', '/api/users', admin, { username, roles, password: 'printing-test-password' }, 201);
    return login(username);
  }
  const reader = await account('printing-reader', ['TESTER']), other = await account('printing-other', ['SAMPLE']), finance = await account('printing-finance', ['FINANCE']);
  const material = await account('printing-material', ['MATERIAL']);
  const actorId = admin.id;
  const category = await db.prepare('INSERT INTO material_categories(name,created_by) VALUES(?,?)').run('测试分类', actorId);
  const region = await db.prepare('INSERT INTO material_regions(name,created_by) VALUES(?,?)').run('测试区域', actorId);
  const catalog = await db.prepare("INSERT INTO material_catalog(code,name,spec,unit,category_id,tracking_mode,created_by) VALUES(?,?,?,?,?,'unit',?)")
    .run('MAT-PRINT', '测试试剂', '500 mL', '瓶', category.lastInsertRowid, actorId);
  const snapshot = JSON.stringify({ code: 'MAT-PRINT', name: '测试试剂', spec: '500 mL', unit: '瓶' });
  const movement = await db.prepare(`INSERT INTO material_stock_movements(type,catalog_id,region_id,warehouse,qty_m,amount_cents,source_key,snapshot,date,actor_id)
    VALUES('opening',?,?,'REAGENT',3000,300,'printing-test',?,'2026-10-20',?)`).run(catalog.lastInsertRowid, region.lastInsertRowid, snapshot, actorId);
  await db.prepare(`INSERT INTO material_stock_locations(catalog_id,region_id,warehouse,location,version,reason,actor_id,updated_at)
    VALUES(?,?,'REAGENT','A柜2层',1,'测试',?,?)`).run(catalog.lastInsertRowid, region.lastInsertRowid, actorId, new Date().toISOString());
  const unitIds = [];
  for (let i = 1; i <= 3; i++) {
    const result = await db.prepare(`INSERT INTO material_stock_units(code,sequence,catalog_id,region_id,warehouse,source_movement_id,created_by,created_at)
      VALUES(?,?,?,?,'REAGENT',?,?,?)`).run('00000' + i, i, catalog.lastInsertRowid, region.lastInsertRowid, movement.lastInsertRowid, actorId, new Date().toISOString());
    unitIds.push(result.lastInsertRowid);
  }
  const api = async (method, route, actor, payload, status) => (await request(method, '/api/printing' + route, actor, payload, status)).data;
  const templateInput = { name: '测试原生母版', fileName: 'unit-api.btw', contentBase64: Buffer.from('synthetic-test-only-not-a-real-template').toString('base64'), fields: ['Code', 'QRPayload', 'Name', 'Location'] };
  const template = await api('POST', '/templates', admin, templateInput, 201);
  const station = await api('POST', '/stations', admin, { name: '测试打印站', printerName: '测试打印机（不调用）' }, 201);
  const make = (actor = reader, extra = {}) => api('POST', '/jobs', actor, { stationId: station.station.id, templateId: template.id, unitIds, idempotencyKey: crypto.randomUUID(), ...extra }, 201);
  const claim = (source = station) => api('POST', '/agent/claim', { token: source.token }, { agentVersion: 'test-only' });
  const start = (claimed, source = station, status = 200) => api('POST', `/agent/jobs/${claimed.id}/start`, { token: source.token }, { leaseToken: claimed.leaseToken }, status);
  const result = (claimed, state = 'submitted', message = '合成引擎结果', source = station, expected = 200) => api('POST', `/agent/jobs/${claimed.id}/result`, { token: source.token }, { leaseToken: claimed.leaseToken, status: state, message }, expected);
  return { db, api, request, admin, reader, other, finance, material, unitIds, templateInput, template, station, make, claim, start, result,
    baseUrl: `http://127.0.0.1:${port}`, agentBytes, catalogId: catalog.lastInsertRowid, regionId: region.lastInsertRowid };
}

test('BarTender printing API uses immutable snapshots and authenticated, non-retrying station leases', async t => {
  const f = await fixture(t);
  const { db, api, admin, reader, other, finance, material, template, station, unitIds } = f;
  let firstJob;
  await t.test('cookie and bearer authentication, manager permissions and private task visibility', async () => {
    await api('GET', '/config', null, undefined, 401);
    await api('GET', '/config', finance, undefined, 403);
    const config = await api('GET', '/config', reader);
    assert.deepEqual(config.capabilities, { manageTemplates: false, manageStations: false, submit: true });
    assert.equal(JSON.stringify(config).includes('token_hash'), false);
    assert.equal(JSON.stringify(config).includes(station.token), false);
    assert.equal(config.templates[0].contentBase64, undefined);
    assert.equal((await api('GET', '/config', material)).capabilities.manageTemplates, true);
    await api('POST', '/templates', reader, f.templateInput, 403);
    await api('GET', '/templates/' + template.id, reader, undefined, 403);
    await api('POST', '/stations', material, { name: '拒绝', printerName: '拒绝' }, 403);
    await api('POST', '/agent/claim', admin, {}, 401);
    await api('POST', '/agent/claim', { token: 'x'.repeat(43) }, {}, 401);
    firstJob = await f.make();
    await api('GET', '/jobs/' + firstJob.id, other, undefined, 403);
    assert.equal((await api('GET', '/jobs', other)).total, 0);
    assert.equal((await api('GET', '/jobs', material)).total, 1);
    await api('POST', '/jobs/' + firstJob.id + '/cancel', other, {}, 403);
  });
  await t.test('Windows agent download is authenticated and preserves the exact script bytes', async () => {
    await f.request('GET', '/api/printing/agent-script', null, undefined, 401);
    await f.request('GET', '/api/printing/agent-script', finance, undefined, 403);
    const response = await fetch(f.baseUrl + '/api/printing/agent-script', { headers: { Cookie: reader.cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="bartender-agent.ps1"');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.agentBytes);
  });
  await t.test('template validates canonical base64, file name, field allowlist and exact 4MiB boundary', async () => {
    for (const extra of [{ contentBase64: '' }, { contentBase64: 'YQ' }, { contentBase64: 'YR==' }, { contentBase64: 'YQ==\n' },
      { fileName: '../unit.btw' }, { fileName: 'unit.xml' }, { fields: ['Name'] }, { fields: ['Code', 'Code'] }, { fields: ['Code', 'Path'] }, { fields: ['Code'], path: 'unsafe' }]) {
      await api('POST', '/templates', admin, { ...f.templateInput, ...extra }, 400);
    }
    const large = Buffer.alloc(4194304, 65);
    const saved = await api('POST', '/templates', admin, { ...f.templateInput, name: '边界模板', contentBase64: large.toString('base64'), fields: ['Code'] }, 201);
    assert.equal(saved.size, large.length);
    assert.equal(saved.sha256, crypto.createHash('sha256').update(large).digest('hex'));
    await api('POST', '/templates', admin, { ...f.templateInput, contentBase64: Buffer.alloc(4194305).toString('base64') }, 400);
    const detail = await api('GET', '/templates/' + template.id, admin);
    assert.equal(detail.contentBase64, f.templateInput.contentBase64);
    assert.deepEqual((await db.columns('printing_jobs')).find(c => c.name === 'id').type, 'TEXT');
  });
  await t.test('server-selected 12 fields preserve codes, order, snapshots and stock without accepting arbitrary payloads', async () => {
    const before = await db.prepare('SELECT * FROM material_stock_units ORDER BY id').all();
    const detail = await api('GET', '/jobs/' + firstJob.id, reader);
    assert.equal(detail.rows.length, 3);
    assert.deepEqual(Object.keys(detail.rows[0]), COLUMNS.map(([column]) => column));
    assert.equal(detail.rows[0].Code, '000001');
    assert.equal(detail.rows[0].QRPayload, '000001');
    assert.equal(detail.rows[0].Warehouse, '试剂库');
    assert.equal(detail.rows[0].Location, 'A柜2层');
    await db.prepare("UPDATE material_stock_locations SET location='B柜' WHERE catalog_id=?").run(f.catalogId);
    assert.equal((await api('GET', '/jobs/' + firstJob.id, reader)).rows[0].Location, 'A柜2层');
    for (const extra of [{ unitIds: [] }, { unitIds: [unitIds[0], unitIds[0]] }, { unitIds: [String(unitIds[0])] }, { unitIds: [Number.MAX_SAFE_INTEGER + 1] },
      { unitIds: Array.from({ length: 1001 }, (_, index) => index + 1) }, { copies: 2 }, { rows: [{ Code: 'hijack' }] }, { xml: '<XMLScript/>' }]) {
      await api('POST', '/jobs', reader, { stationId: station.station.id, templateId: template.id, unitIds, idempotencyKey: crypto.randomUUID(), ...extra }, 400);
    }
    await api('POST', '/jobs', reader, { stationId: station.station.id, templateId: template.id, unitIds: [999999], idempotencyKey: crypto.randomUUID() }, 404);
    assert.deepEqual(await db.prepare('SELECT * FROM material_stock_units ORDER BY id').all(), before);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM material_stock_movements').get()).n, 1);
    assert.equal((await db.prepare("SELECT value FROM material_state WHERE key='unit_sequence'").get()).value, '0');
    assert.equal((await db.prepare('SELECT SUM(qty_m) AS qty FROM material_stock_movements').get()).qty, 3000);
  });
  await t.test('idempotency is actor-scoped, payload-bound and concurrent-safe', async () => {
    const key = crypto.randomUUID(), input = { stationId: station.station.id, templateId: template.id, unitIds: [unitIds[2]], idempotencyKey: key };
    const pair = await Promise.all([api('POST', '/jobs', reader, input, 201), api('POST', '/jobs', reader, input, 201)]);
    assert.equal(pair[0].id, pair[1].id);
    await api('POST', '/jobs', reader, { ...input, unitIds: [unitIds[0]] }, 409);
    assert.notEqual((await api('POST', '/jobs', other, input, 201)).id, pair[0].id);
    await api('POST', '/jobs/' + pair[0].id + '/cancel', reader, {});
    await api('POST', '/jobs/' + (await api('GET', '/jobs', other)).items[0].id + '/cancel', other, {});
  });
  await t.test('claim atomically leases one job, requires start before engine, rejects cross-station and duplicate start', async () => {
    const responses = await Promise.all([f.claim(), f.claim(), f.claim()]);
    const claims = responses.filter(value => value.job);
    assert.equal(claims.length, 1);
    const claimed = claims[0].job;
    assert.equal(claimed.id, firstJob.id);
    assert.deepEqual(claimed.template.fields, f.templateInput.fields);
    assert.equal(claimed.template.contentBase64, f.templateInput.contentBase64);
    assert.equal((await api('GET', '/config', admin)).stations[0].lastSeenAt !== null, true);
    await f.result(claimed, 'submitted', '不能先报告', station, 409);
    const second = await api('POST', '/stations', admin, { name: '第二打印站', printerName: '第二打印机' }, 201);
    await f.start(claimed, second, 404);
    await api('POST', `/agent/jobs/${claimed.id}/start`, { token: station.token }, { leaseToken: 'x'.repeat(43) }, 409);
    assert.deepEqual(await f.start(claimed), { ok: true, status: 'printing' });
    await f.start(claimed, station, 409);
    await api('POST', '/jobs/' + claimed.id + '/cancel', reader, {}, 409);
    assert.equal((await f.claim()).job, null);
    assert.deepEqual(await f.result(claimed), { ok: true, status: 'submitted' });
    assert.deepEqual(await f.result(claimed), { ok: true, status: 'submitted' });
    await f.result(claimed, 'failed', '改结果', station, 409);
    assert.equal((await api('GET', '/jobs/' + claimed.id, reader)).status, 'submitted');
    await api('POST', '/jobs/' + claimed.id + '/confirm', reader, { reason: '普通人员不允许' }, 403);
    await api('POST', '/jobs/' + claimed.id + '/confirm', material, { reason: '' }, 400);
    const confirmed = await api('POST', '/jobs/' + claimed.id + '/confirm', material, { reason: '人工确认合成记录，未实际打印' });
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.confirmedBy, material.id);
    await f.result(claimed, 'submitted', '合成引擎结果', station, 409);
  });
  await t.test('explicit reprint is a distinct job using the original snapshot and unchanged identity', async () => {
    await api('POST', '/jobs', reader, { stationId: station.station.id, templateId: template.id, unitIds, idempotencyKey: crypto.randomUUID(), reprintOf: firstJob.id }, 400);
    const reprint = await f.make(reader, { reason: '标签破损，合成测试', reprintOf: firstJob.id });
    assert.notEqual(reprint.id, firstJob.id);
    assert.deepEqual((await api('GET', '/jobs/' + reprint.id, reader)).rows, (await api('GET', '/jobs/' + firstJob.id, reader)).rows);
    const claim = (await f.claim()).job;
    assert.equal(claim.id, reprint.id);
    await api('POST', '/jobs/' + reprint.id + '/cancel', reader, {});
    await f.start(claim, station, 409);
    await api('POST', '/jobs', reader, { stationId: station.station.id, templateId: template.id, unitIds: [...unitIds].reverse(), idempotencyKey: crypto.randomUUID(), reason: '顺序变化', reprintOf: firstJob.id }, 400);
  });
  await t.test('expired claims become unknown and never automatically requeue or accept stale workers', async () => {
    const queued = await f.make(), claimed = (await f.claim()).job;
    assert.equal(queued.id, claimed.id);
    await db.prepare('UPDATE printing_jobs SET lease_expires_at=? WHERE id=?').run(Date.now() - 1, claimed.id);
    await f.start(claimed, station, 409);
    assert.equal((await db.prepare('SELECT status FROM printing_jobs WHERE id=?').get(queued.id)).status, 'unknown');
    assert.equal((await f.claim()).job, null);
    await f.result(claimed, 'submitted', '过期', station, 409);
    assert.equal((await api('GET', '/jobs/' + queued.id, reader)).status, 'unknown');
    assert.equal((await api('POST', '/jobs/' + queued.id + '/confirm', admin, { reason: '人工核对无重复任务' })).status, 'confirmed');
  });
  await t.test('expired printing leases remain unknown instead of automatically repeating physical work', async () => {
    const queued = await f.make(), claimed = (await f.claim()).job;
    await f.start(claimed);
    const before = await db.prepare('SELECT lease_expires_at FROM printing_jobs WHERE id=?').get(queued.id);
    assert.ok(before.lease_expires_at > Date.now() + 1700000);
    await db.prepare('UPDATE printing_jobs SET lease_expires_at=? WHERE id=?').run(Date.now() - 1, queued.id);
    await f.result(claimed, 'submitted', '延迟成功', station, 409);
    assert.equal((await api('GET', '/jobs/' + queued.id, reader)).status, 'unknown');
    assert.equal((await f.claim()).job, null);
  });
  await t.test('preflight failures may finish a claim without printing but submitted requires start acknowledgement', async () => {
    const queued = await f.make(), claimed = (await f.claim()).job;
    assert.equal(queued.id, claimed.id);
    await f.result(claimed, 'submitted', '禁止未启动就报告提交', station, 409);
    await f.result(claimed, 'failed', '模板校验失败，未启动打印');
    await f.result(claimed, 'failed', '模板校验失败，未启动打印');
    assert.equal((await api('GET', '/jobs/' + queued.id, reader)).status, 'failed');
    await f.start(claimed, station, 409);
  });
  await t.test('cancel and start compete atomically, only one operation can take effect', async () => {
    const queued = await f.make(), claimed = (await f.claim()).job;
    const [cancel, start] = await Promise.all([
      f.request('POST', `/api/printing/jobs/${queued.id}/cancel`, reader, {}, [200, 409]),
      f.request('POST', `/api/printing/agent/jobs/${queued.id}/start`, { token: station.token }, { leaseToken: claimed.leaseToken }, [200, 409])
    ]);
    assert.equal([cancel.response.status, start.response.status].filter(status => status === 200).length, 1);
    const state = (await api('GET', '/jobs/' + queued.id, reader)).status;
    assert.equal(state, cancel.response.status === 200 ? 'cancelled' : 'printing');
    if (state === 'printing') await f.result(claimed, 'unknown', '并发场景无真实打印');
  });
  await t.test('rotation revokes old bearer and active lease; disabling invalidates active work and blocks claims', async () => {
    const queued = await f.make(), claimed = (await f.claim()).job;
    const rotated = await api('POST', '/stations/' + station.station.id + '/rotate-token', admin, {});
    assert.notEqual(rotated.token, station.token);
    await f.claim(station).then(() => assert.fail('old token accepted'), error => assert.match(error.message, /401/));
    assert.equal((await api('GET', '/jobs/' + queued.id, reader)).status, 'unknown');
    await f.start(claimed, rotated, 409);
    const next = await f.make(), active = (await f.claim(rotated)).job;
    assert.equal(active.id, next.id);
    await f.start(active, rotated);
    const disabled = await api('PUT', '/stations/' + station.station.id, admin, { enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal((await api('GET', '/jobs/' + next.id, reader)).status, 'unknown');
    await api('POST', '/agent/claim', { token: rotated.token }, {}, 401);
    await api('POST', '/jobs', reader, { stationId: station.station.id, templateId: template.id, unitIds, idempotencyKey: crypto.randomUUID() }, 409);
    await api('PUT', '/stations/' + station.station.id, admin, { enabled: true });
    await f.result(active, 'submitted', '旧任务迟到', rotated, 409);
    station.token = rotated.token;
  });
  await t.test('disabled templates block new tasks but retain queued immutable content; printer config updates affect future jobs only', async () => {
    const queued = await f.make();
    await api('POST', '/templates/' + template.id + '/disable', admin, {});
    await api('PUT', '/stations/' + station.station.id, admin, { printerName: '更新后的打印机' });
    await api('POST', '/jobs', reader, { stationId: station.station.id, templateId: template.id, unitIds, idempotencyKey: crypto.randomUUID() }, 409);
    const claimed = (await f.claim()).job;
    assert.equal(claimed.id, queued.id);
    assert.equal(claimed.printerName, '测试打印机（不调用）');
    assert.equal(claimed.template.contentBase64, f.templateInput.contentBase64);
    await f.start(claimed);
    await f.result(claimed, 'failed', '仅模拟失败，未启动BarTender');
    assert.equal((await api('GET', '/jobs/' + queued.id, reader)).status, 'failed');
    assert.equal((await f.claim()).job, null);
    const audits = await db.prepare("SELECT detail FROM audit_logs WHERE entity LIKE 'printing_%'").all();
    assert.ok(audits.length > 0);
    assert.equal(audits.some(row => row.detail.includes(station.token) || row.detail.includes(f.templateInput.contentBase64)), false);
  });
});
