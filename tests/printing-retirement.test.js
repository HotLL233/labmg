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

async function fixture(t) {
  const target = await createTestDatabase(t), db = await target.open();
  const cache = path.resolve(__dirname, '../artifacts/cache', require('../package.json').version, 'printing-retirement-tests');
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'run-'));
  fs.cpSync(path.resolve(__dirname, '../src'), path.join(directory, 'src'), { recursive: true });
  fs.cpSync(path.resolve(__dirname, '../migrations'), path.join(directory, 'migrations'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../package.json'), path.join(directory, 'package.json'));
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let child;
  async function start() {
    child = spawn(process.execPath, [path.join(directory, 'src/server.js')], { cwd: directory, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DATABASE_URL: target.url, PORT: String(port),
        LABOS_RUNTIME_DIR: path.join(directory, 'runtime'), LABOS_ADMIN_USER: 'retirement-admin', LABOS_ADMIN_PASSWORD: 'synthetic-retirement-password' } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(15000) });
    assert.match(String(output), /LabOS:/, stderr);
  }
  async function stop() {
    if (child?.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
  }
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(directory), cache); assert.match(path.basename(directory), /^run-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await start();
  async function request(method, route, actor, payload, expected = 200) {
    const headers = {};
    if (actor?.cookie) headers.Cookie = actor.cookie;
    if (actor?.token) headers.Authorization = 'Bearer ' + actor.token;
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers,
      body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${response.status} ${JSON.stringify(data)}`);
    return { data, response };
  }
  async function login() {
    const { data, response } = await request('POST', '/api/auth/login', null,
      { username: 'retirement-admin', password: 'synthetic-retirement-password' });
    return { ...data.user, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  return { db, request, login, start, stop };
}

test('retired native printing has no API or assistant downloads and preserves historical and material data', async t => {
  const f = await fixture(t), { db, request } = f;
  let admin = await f.login();
  const category = (await db.prepare('INSERT INTO material_categories(name,created_by) VALUES(?,?)').run('退役回归分类', admin.id)).lastInsertRowid;
  const region = (await db.prepare('INSERT INTO material_regions(name,created_by) VALUES(?,?)').run('退役回归区域', admin.id)).lastInsertRowid;
  const catalog = (await db.prepare("INSERT INTO material_catalog(code,name,spec,unit,category_id,tracking_mode,created_by) VALUES(?,?,?,?,?,'unit',?)")
    .run('MAT-RETIRED', '固定编码测试物资', '500 mL', '瓶', category, admin.id)).lastInsertRowid;
  const snapshot = JSON.stringify({ code: 'MAT-RETIRED', name: '固定编码测试物资', spec: '500 mL', unit: '瓶' });
  const movement = (await db.prepare(`INSERT INTO material_stock_movements(type,catalog_id,region_id,warehouse,qty_m,amount_cents,source_key,snapshot,date,actor_id)
    VALUES('opening',?,?,'REAGENT',1000,100,'retirement-test',?,'2026-10-20',?)`).run(catalog, region, snapshot, admin.id)).lastInsertRowid;
  const unit = (await db.prepare(`INSERT INTO material_stock_units(code,sequence,catalog_id,region_id,warehouse,source_movement_id,created_by,created_at)
    VALUES('000001',1,?,?,'REAGENT',?,?,?)`).run(catalog, region, movement, admin.id, '2026-10-20T00:00:00Z')).lastInsertRowid;
  await db.prepare("UPDATE material_state SET value='1' WHERE key='unit_sequence'").run();
  const templateId = crypto.randomUUID(), stationId = crypto.randomUUID(), jobId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex'), content = Buffer.from('synthetic legacy template; never executed');
  await db.prepare(`INSERT INTO printing_templates(id,name,file_name,sha256,size,content_base64,fields,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(templateId, '历史母版', 'history.btw', hash(content), content.length, content.toString('base64'), '["Code"]', admin.id, '2026-10-20T00:00:00Z');
  await db.prepare(`INSERT INTO printing_stations(id,name,printer_name,token_hash,created_by,created_at)
    VALUES(?,?,?,?,?,?)`).run(stationId, '历史打印站', 'synthetic-no-output', hash(token), admin.id, '2026-10-20T00:00:00Z');
  await db.prepare(`INSERT INTO printing_jobs(id,station_id,station_name,printer_name,template_id,template_name,template_file_name,template_sha256,
    template_content_base64,template_fields,unit_ids,rows_snapshot,row_count,status,created_by,created_at,updated_at,idempotency_key,payload_digest,lease_hash,lease_expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'claimed',?,?,?,?,?,?,?)`).run(jobId, stationId, '历史打印站', 'synthetic-no-output', templateId, '历史母版', 'history.btw', hash(content),
      content.toString('base64'), '["Code"]', JSON.stringify([unit]), '[{"Code":"000001"}]', 1, admin.id, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', 'legacy-key', hash('legacy'), hash('legacy-lease'), 1);
  const historical = async () => ({ templates: await db.prepare('SELECT * FROM printing_templates ORDER BY id').all(),
    stations: await db.prepare('SELECT * FROM printing_stations ORDER BY id').all(), jobs: await db.prepare('SELECT * FROM printing_jobs ORDER BY id').all() });
  const historyBefore = await historical();
  const unitRoute = `/api/materials/stock/units?catalogId=${catalog}`;
  const unitsBefore = (await request('GET', unitRoute, admin)).data.items;
  assert.equal(unitsBefore[0].code, '000001'); assert.equal(unitsBefore[0].qrPayload, '000001');

  await t.test('all former management, queue and download routes are absent even for administrators', async () => {
    const routes = [
      ['GET', ''], ['GET', '/config'], ['GET', '/agent-script'], ['GET', '/agent-launcher'],
      ['GET', '/templates'], ['GET', '/templates/' + templateId], ['POST', '/templates'], ['POST', '/templates/' + templateId + '/disable'],
      ['GET', '/stations'], ['POST', '/stations'], ['PUT', '/stations/' + stationId], ['POST', '/stations/' + stationId + '/rotate-token'],
      ['GET', '/jobs'], ['POST', '/jobs'], ['GET', '/jobs/' + jobId], ['POST', '/jobs/' + jobId + '/cancel'], ['POST', '/jobs/' + jobId + '/confirm'],
      ['POST', '/agent/claim'], ['POST', '/agent/jobs/' + jobId + '/start'], ['POST', '/agent/jobs/' + jobId + '/result']
    ];
    for (const [method, route] of routes) await request(method, '/api/printing' + route, { ...admin, token }, method === 'GET' ? undefined : {}, 404);
    await request('POST', '/api/printing/agent/claim', { token }, { agentVersion: '0.8.2' }, 401);
    assert.deepEqual(await historical(), historyBefore, 'old leases must not expire or be claimed through retired endpoints');
  });

  await t.test('fixed unit codes, QR lookup, stock and materials backup remain available', async () => {
    const scan = (await request('POST', '/api/materials/scan/resolve', admin, { code: '000001' })).data;
    assert.equal(scan.kind, 'unit'); assert.equal(scan.unit.id, unit); assert.equal(scan.unit.qrPayload, '000001'); assert.equal(scan.batch.qtyM, 1000);
    assert.deepEqual((await request('GET', unitRoute, admin)).data.items, unitsBefore);
    const backup = (await request('GET', '/api/materials/backup', admin)).data;
    assert.equal(backup.type, 'labos-materials-backup');
    assert.equal(backup.data.material_stock_units[0].code, '000001');
  });

  await t.test('schema initialization and restart retain old rows without resuming native work', async () => {
    await f.stop(); await f.start(); admin = await f.login();
    assert.deepEqual(await historical(), historyBefore);
    assert.deepEqual((await request('GET', unitRoute, admin)).data.items, unitsBefore);
    await request('GET', '/api/printing/config', admin, undefined, 404);
    assert.equal((await request('POST', '/api/materials/scan/resolve', admin, { code: '000001' })).data.unit.id, unit);
  });
});
