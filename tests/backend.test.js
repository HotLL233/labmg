const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

async function fixture(t, legacy = false) {
  const cache = path.join(root, 'artifacts/cache', require('../package.json').version, 'backend-tests');
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'run-'));
  fs.cpSync(path.join(root, 'src'), path.join(directory, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'));
  const runtime = path.join(directory, 'runtime');
  const database = path.join(runtime, 'data/labos.db');
  const sql = action => {
    const db = new DatabaseSync(database);
    try { return action(db); } finally { db.close(); }
  };
  if (legacy) {
    fs.mkdirSync(path.dirname(database), { recursive: true });
    fs.mkdirSync(path.join(runtime, 'uploads'), { recursive: true });
    sql(db => {
      db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE,password TEXT,display_name TEXT,role TEXT);
        CREATE TABLE records(id INTEGER PRIMARY KEY AUTOINCREMENT,module TEXT,title TEXT NOT NULL,code TEXT,status TEXT,category TEXT,owner TEXT,due_date TEXT,amount REAL DEFAULT 0,quantity REAL DEFAULT 0,data TEXT DEFAULT '{}',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE files(id INTEGER PRIMARY KEY AUTOINCREMENT,record_id INTEGER,original_name TEXT,stored_name TEXT,mime_type TEXT,size INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE role_permissions(role TEXT PRIMARY KEY,permissions TEXT NOT NULL);`);
      db.prepare('INSERT INTO users(username,password,display_name,role) VALUES(?,?,?,?)').run('legacy-admin', 'legacy-password', 'Legacy', 'ADMIN');
      db.prepare('INSERT INTO users(username,password,display_name,role) VALUES(?,?,?,?)').run('idle-user', 'idle-password', 'Idle', 'TESTER');
      db.prepare('INSERT INTO records(module,title,data) VALUES(?,?,?)').run('samples', 'legacy sample fixture', '{}');
      db.prepare('INSERT INTO files(record_id,original_name,stored_name,mime_type,size) VALUES(?,?,?,?,?)').run(1, 'sample.txt', 'sample.txt', 'text/plain', 6);
      db.prepare('INSERT INTO role_permissions(role,permissions) VALUES(?,?)').run('LEGACY', '["samples.read"]');
    });
    fs.writeFileSync(path.join(runtime, 'uploads/sample.txt'), 'sample');
  }
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(directory, 'src/server.js')], {
    cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), LABOS_RUNTIME_DIR: runtime, LABOS_ADMIN_USER: 'test-admin', LABOS_ADMIN_PASSWORD: 'test-password' }
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(cache));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
  assert.match(String(output), /LabOS:/, stderr);
  const request = async (method, route, cookie, body, expected = 200) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    if (Array.isArray(expected)) assert.ok(expected.includes(response.status), `${method} ${route}: ${response.status} ${text}`);
    else assert.equal(response.status, expected, `${method} ${route}: ${text}`);
    return { status: response.status, headers: response.headers, data: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text };
  };
  const login = async (username = 'test-admin', password = 'test-password') => {
    const response = await request('POST', '/api/auth/login', null, { username, password });
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: response.data.user };
  };
  const admin = await login(legacy ? 'legacy-admin' : 'test-admin', legacy ? 'legacy-password' : 'test-password');
  const role = async (name, permissions) => {
    await request('POST', '/api/permissions/roles', admin.cookie, { role: name }, 201);
    await request('PUT', `/api/permissions/roles/${name}`, admin.cookie, { permissions });
  };
  const user = async (username, roles) => {
    const response = await request('POST', '/api/users', admin.cookie, { username, roles, password: 'user-password' }, 201);
    return { ...await login(username, 'user-password'), id: response.data.id };
  };
  const create = async record => (await request('POST', '/api/records', admin.cookie, record, 201)).data;
  const upload = async record => (await request('POST', '/api/files', admin.cookie, { record_id: record.id, name: 'fixture.txt', type: 'text/plain', content: Buffer.from('fixture attachment').toString('base64') }, 201)).data;
  return { directory, runtime, sql, request, login, admin, role, user, create, upload };
}

test('legacy passwords upgrade, backups hash idle passwords, startup preserves old samples', { timeout: 30000 }, async t => {
  const f = await fixture(t, true);
  assert.match(f.sql(db => db.prepare('SELECT password FROM users WHERE username=?').get('legacy-admin').password), /^scrypt\$/);
  assert.equal(f.sql(db => db.prepare('SELECT password FROM users WHERE username=?').get('idle-user').password), 'idle-password');
  assert.equal(f.sql(db => db.prepare('SELECT version FROM records WHERE module=?').get('samples').version), 1);
  assert.equal(f.sql(db => db.prepare('SELECT COUNT(*) n FROM files WHERE record_id=1').get().n), 1);
  assert.equal(f.sql(db => db.prepare('SELECT permissions FROM role_permissions WHERE role=?').get('LEGACY').permissions), '["samples.read"]');
  assert.equal(fs.readFileSync(path.join(f.runtime, 'uploads/sample.txt'), 'utf8'), 'sample');
  const backup = (await f.request('GET', '/api/backup', f.admin.cookie)).data;
  assert.ok(backup.users.every(user => /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(user.password)));
  assert.ok(!JSON.stringify(backup).includes('idle-password'));
  await f.request('POST', '/api/auth/login', null, { username: 'idle-user', password: 'wrong' }, 401);
  await f.login('idle-user', 'idle-password');
  assert.match(f.sql(db => db.prepare('SELECT password FROM users WHERE username=?').get('idle-user').password), /^scrypt\$/);
  await f.request('POST', '/api/restore', f.admin.cookie, { type: 'backup', records: [], users: [{ username: 'restored', password: 'old-backup-password', display_name: 'Restored', role: 'TESTER' }] });
  assert.match(f.sql(db => db.prepare('SELECT password FROM users WHERE username=?').get('restored').password), /^scrypt\$/);
  await f.login('restored', 'old-backup-password');
});

test('logout and password resets revoke sessions, imports preserve omitted passwords, last admin survives', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(f.admin.user.permissions, ['*']);
  const person = await f.user('person', ['TESTER']);
  const loggedOut = await f.request('POST', '/api/auth/logout', person.cookie);
  assert.match(loggedOut.headers.get('set-cookie'), /Path=\//);
  assert.equal((await f.request('GET', '/api/auth/me', person.cookie)).data.user, null);
  await f.request('GET', '/api/records', person.cookie, undefined, 401);
  const again = await f.login('person', 'user-password');
  await f.request('PUT', `/api/users/${person.id}`, f.admin.cookie, { password: 'reset-password' });
  await f.request('GET', '/api/records', again.cookie, undefined, 401);
  await f.request('POST', '/api/auth/login', null, { username: 'person', password: 'user-password' }, 401);
  const reset = await f.login('person', 'reset-password');
  await f.request('POST', '/api/users/import', f.admin.cookie, { rows: [{ username: 'person', role: 'TESTER', display_name: 'Updated' }] });
  await f.login('person', 'reset-password');
  await f.request('POST', '/api/users/import', f.admin.cookie, { rows: [{ username: 'person', role: 'TESTER', password: 'import-password' }] });
  await f.request('GET', '/api/records', reset.cookie, undefined, 401);
  await f.login('person', 'import-password');
  await f.request('PUT', `/api/users/${f.admin.user.id}`, f.admin.cookie, { role: 'TESTER' }, 400);
  await f.request('POST', '/api/users/import', f.admin.cookie, { rows: [{ username: 'test-admin', role: 'TESTER' }] }, 400);
  assert.equal((await f.request('GET', '/api/auth/me', f.admin.cookie)).data.user.role, 'ADMIN');
});

test('module, section and archive scopes guard mutations, files, exports, backups and statistics', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.role('LIMITED', ['dashboard.read', 'archives.read', 'archives.write', 'archives.delete', 'archives.method.read', 'archives.method.write', 'archives.method.delete', 'export.read', 'backup.read', 'backup.restore', 'trash.read', 'trash.write', 'trash.delete']);
  const limited = await f.user('limited', ['LIMITED']);
  assert.ok(limited.user.permissions.includes('archives.method.write'));
  const visible = await f.create({ module: 'archives', title: 'visible', data: { archive_type: '检测方法档案', access_roles: 'LIMITED' } });
  const hidden = await f.create({ module: 'archives', title: 'hidden section', data: { archive_type: '检测记录档案', access_roles: 'LIMITED' } });
  const secret = await f.create({ module: 'archives', title: 'hidden role', data: { archive_type: '检测方法档案', access_roles: 'ADMIN' } });
  const unknown = await f.create({ module: 'archives', title: 'unknown section', data: { section: 'unknown', access_roles: 'LIMITED' } });
  const missing = await f.create({ module: 'archives', title: 'missing section', data: { access_roles: 'LIMITED' } });
  const finance = await f.create({ module: 'finance', title: 'private finance', amount: 9999, data: { direction: '收入' } });
  const forbidden = [hidden, secret, unknown, missing, finance];
  const visibleFile = await f.upload(visible);
  const forbiddenFiles = [];
  for (const record of forbidden) forbiddenFiles.push(await f.upload(record));
  assert.deepEqual((await f.request('GET', '/api/records?module=archives', limited.cookie)).data.map(record => record.id), [visible.id]);
  for (const record of forbidden) {
    await f.request('PUT', `/api/records/${record.id}`, limited.cookie, { title: 'blocked', version: record.version }, 403);
    await f.request('DELETE', `/api/records/${record.id}`, limited.cookie, undefined, 403);
    await f.request('GET', `/api/files?record_id=${record.id}`, limited.cookie, undefined, 403);
    await f.request('POST', '/api/files', limited.cookie, { record_id: record.id, content: 'YQ==' }, 403);
  }
  for (const file of forbiddenFiles) await f.request('GET', `/api/files/${file.id}/download`, limited.cookie, undefined, 403);
  await f.request('GET', `/api/files/${visibleFile.id}/download`, limited.cookie);
  await f.request('POST', '/api/files', limited.cookie, { record_id: 999999, content: 'YQ==' }, 404);
  await f.request('POST', '/api/records', limited.cookie, { module: 'archives', title: 'bypass', data: { archive_type: '检测记录档案', access_roles: 'LIMITED' } }, 403);
  for (const section of [undefined, 'unknown']) await f.request('POST', '/api/records', limited.cookie, { module: 'archives', title: 'unclassified bypass', data: { section, access_roles: 'LIMITED' } }, 403);
  await f.request('PUT', `/api/records/${visible.id}`, limited.cookie, { version: visible.version, data: { archive_type: '检测方法档案', access_roles: 'ADMIN' } }, 403);
  await f.request('PUT', `/api/records/${visible.id}`, limited.cookie, { version: visible.version, data: { archive_type: '检测记录档案', access_roles: 'LIMITED' } }, 403);
  await f.request('POST', '/api/records', limited.cookie, { module: 'archives', title: 'bad numeric value', amount: 'invalid', data: {} }, 400);
  const exported = (await f.request('GET', '/api/export', limited.cookie)).data;
  assert.deepEqual(exported.records.map(record => record.id), [visible.id]);
  await f.request('GET', '/api/export?module=finance', limited.cookie, undefined, 403);
  const backup = (await f.request('GET', '/api/backup', limited.cookie)).data;
  assert.deepEqual(backup.records.map(record => record.id), [visible.id]);
  assert.deepEqual(backup.files.map(file => file.id), [visibleFile.id]);
  for (const key of ['users', 'role_permissions', 'audit_logs']) assert.deepEqual(backup[key], []);
  const dashboard = (await f.request('GET', '/api/dashboard', limited.cookie)).data;
  assert.equal(dashboard.totals.archives, 1);
  assert.equal(dashboard.totals.finance, 0);
  assert.deepEqual(dashboard.finance, { income: 0, expense: 0 });
  await f.request('POST', '/api/restore', limited.cookie, { type: 'backup', records: [], users: [{ username: 'escalate', role: 'ADMIN', password: 'test' }] }, 403);
  await f.request('POST', '/api/restore', limited.cookie, { type: 'backup', records: [], role_permissions: [{ role: 'LIMITED', permissions: '["*"]' }] }, 403);
  await f.request('POST', '/api/restore', limited.cookie, { type: 'backup', records: [finance] }, 403);
  for (const record of [hidden, secret, finance]) await f.request('DELETE', `/api/records/${record.id}`, f.admin.cookie);
  assert.deepEqual((await f.request('GET', '/api/trash', limited.cookie)).data, []);
  for (const record of [hidden, secret, finance]) {
    await f.request('POST', `/api/trash/${record.id}/restore`, limited.cookie, {}, 403);
    await f.request('DELETE', `/api/trash/${record.id}`, limited.cookie, undefined, 403);
  }
  await f.request('DELETE', `/api/records/${visible.id}`, limited.cookie);
  await f.request('GET', `/api/files/${visibleFile.id}/download`, limited.cookie, undefined, 404);
  const restored = (await f.request('POST', `/api/trash/${visible.id}/restore`, limited.cookie, {})).data;
  assert.equal(restored.version, visible.version + 2);
  await f.request('PUT', `/api/records/${visible.id}`, limited.cookie, { version: visible.version, title: 'stale after restore' }, 409);
});

test('multi-role union keeps base permissions and explicit section limits; template import checks both ends', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.role('METHOD', ['archives.read', 'archives.write', 'archives.method.read', 'archives.method.write', 'templates.read', 'templates.write', 'templates.equipment_use.read', 'templates.equipment_use.write', 'people.read', 'people.write', 'people.profile.read', 'people.profile.write', 'assets.read', 'assets.write', 'assets.filing.read', 'assets.filing.write']);
  await f.role('DETECTION', ['archives.read', 'archives.detection_records.read']);
  await f.role('SECTION_ONLY', ['archives.method.read']);
  const actor = await f.user('multi', ['METHOD', 'DETECTION']);
  const noBase = await f.user('section-only', ['SECTION_ONLY']);
  const method = await f.create({ module: 'archives', title: 'method', data: { archive_type: '检测方法档案', access_roles: 'ALL' } });
  const detection = await f.create({ module: 'archives', title: 'detection', data: { archive_type: '检测记录档案', access_roles: 'ALL' } });
  const project = await f.create({ module: 'archives', title: 'project', data: { archive_type: '项目资料档案', access_roles: 'ALL' } });
  assert.deepEqual((await f.request('GET', '/api/records?module=archives', actor.cookie)).data.map(record => record.id).sort((a, b) => a - b), [method.id, detection.id]);
  await f.request('GET', '/api/records?module=archives', noBase.cookie, undefined, 403);
  await f.request('PUT', `/api/records/${detection.id}`, actor.cookie, { version: detection.version, title: 'no write grant' }, 403);
  await f.request('PUT', `/api/records/${project.id}`, actor.cookie, { version: project.version, title: 'no scope' }, 403);
  for (const [module, section] of [['templates', 'equipment_use'], ['people', 'profile']]) {
    await f.request('POST', '/api/records', actor.cookie, { module, title: `scoped ${module}`, data: { section } }, 201);
    for (const missing of [undefined, 'unknown']) await f.request('POST', '/api/records', actor.cookie, { module, title: `unclassified ${module}`, data: { section: missing } }, 403);
  }
  const allowed = await f.create({ module: 'templates', title: 'equipment template', data: { section: 'equipment_use' } });
  const blocked = await f.create({ module: 'templates', title: 'maintenance template', data: { section: 'maintenance' } });
  await f.request('POST', `/api/templates/${allowed.id}/import-asset`, actor.cookie, {}, 201);
  await f.request('POST', `/api/templates/${blocked.id}/import-asset`, actor.cookie, {}, 403);
  await f.request('PUT', '/api/permissions/roles/METHOD', f.admin.cookie, { permissions: ['templates.read', 'templates.equipment_use.read', 'assets.read', 'assets.write', 'assets.maintenance.read', 'assets.maintenance.write'] });
  await f.request('POST', `/api/templates/${allowed.id}/import-asset`, actor.cookie, {}, 403);
  await f.request('DELETE', `/api/records/${allowed.id}`, f.admin.cookie);
  await f.request('POST', `/api/templates/${allowed.id}/import-asset`, actor.cookie, {}, 404);
});

test('all sections grant full module scope so default managers can maintain unclassified legacy records', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = await f.user('manager', ['LAB_MANAGER']);
  for (const module of ['templates', 'people', 'assets']) {
    const rows = (await f.request('GET', `/api/records?module=${module}`, manager.cookie)).data;
    assert.ok(rows.some(record => !record.data.section), `manager cannot read legacy ${module}`);
  }
  for (const module of ['templates', 'people']) {
    const record = (await f.request('POST', '/api/records', manager.cookie, { module, title: `unclassified ${module}`, data: {} }, 201)).data;
    await f.request('PUT', `/api/records/${record.id}`, manager.cookie, { version: record.version, title: `updated ${module}` });
    await f.request('DELETE', `/api/records/${record.id}`, manager.cookie, undefined, 403);
  }
  assert.deepEqual((await f.request('GET', '/api/records?module=archives', manager.cookie)).data, [], 'full sections must not bypass archive role scopes');
});

test('record versions reject missing/stale saves and track quality trigger changes', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const first = await f.user('writer-one', ['ADMIN']);
  const second = await f.user('writer-two', ['ADMIN']);
  const record = await f.create({ module: 'materials', title: 'concurrent fixture', quantity: 10, data: {} });
  assert.equal(record.version, 1);
  await f.request('PUT', `/api/records/${record.id}`, first.cookie, { title: 'missing version' }, 400);
  const results = await Promise.all([first, second].map((actor, index) => f.request('PUT', `/api/records/${record.id}`, actor.cookie, { version: record.version, quantity: 9 - index }, [200, 409])));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const changed = results.find(result => result.status === 200).data;
  assert.equal(changed.version, 2);
  await f.request('PUT', `/api/records/${record.id}`, second.cookie, { version: record.version, quantity: 8 }, 409);
  assert.equal(f.sql(db => db.prepare('SELECT quantity FROM records WHERE id=?').get(record.id).quantity), changed.quantity);
  const oldQuality = await f.create({ module: 'quality', title: 'controlled fixture', data: { quality_section: '质量手册', is_current: '是' } });
  await f.create({ module: 'quality', title: oldQuality.title, data: { quality_section: '质量手册', is_current: '是' } });
  const demoted = f.sql(db => db.prepare('SELECT data,version FROM records WHERE id=?').get(oldQuality.id));
  assert.equal(JSON.parse(demoted.data).is_current, '否');
  assert.equal(demoted.version, oldQuality.version + 1);
  await f.request('PUT', `/api/records/${oldQuality.id}`, first.cookie, { version: oldQuality.version, title: 'stale trigger save' }, 409);
});

test('Chinese material flows and finance directions resolve to configured section permissions', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.role('STOCK', ['materials.read', 'materials.write', 'materials.inbound.read', 'materials.inbound.write', 'materials.reagent.read', 'finance.read', 'finance.income.read']);
  const actor = await f.user('stock', ['STOCK']);
  const inbound = await f.create({ module: 'materials', title: 'inbound fixture', data: { flow: '入库管理', material_type: '试剂' } });
  const reagent = await f.create({ module: 'materials', title: 'ledger fixture', category: '试剂', data: { flow: '库存台账' } });
  const outbound = await f.create({ module: 'materials', title: 'outbound fixture', data: { flow: '出库管理', material_type: '试剂' } });
  await f.create({ module: 'materials', title: 'uncatalogued fixture', data: { flow: '采购申请', section: 'inbound', material_type: '试剂' } });
  const income = await f.create({ module: 'finance', title: 'income fixture', data: { direction: '收入' } });
  await f.create({ module: 'finance', title: 'expense fixture', data: { direction: '支出' } });
  assert.deepEqual((await f.request('GET', '/api/records?module=materials', actor.cookie)).data.filter(record => record.title.endsWith('fixture')).map(record => record.id).sort((a, b) => a - b), [inbound.id, reagent.id]);
  assert.deepEqual((await f.request('GET', '/api/records?module=finance', actor.cookie)).data.map(record => record.id), [income.id]);
  await f.request('PUT', `/api/records/${inbound.id}`, actor.cookie, { version: inbound.version, quantity: 4 });
  await f.request('PUT', `/api/records/${outbound.id}`, actor.cookie, { version: outbound.version, quantity: 4 }, 403);
  await f.request('POST', '/api/records', actor.cookie, { module: 'materials', title: 'valid inbound', data: { flow: '入库管理', material_type: '试剂' } }, 201);
  await f.request('POST', '/api/records', actor.cookie, { module: 'materials', title: 'forged section', data: { flow: '采购申请', section: 'inbound' } }, 403);
});

test('restore validates system identities and rolls back record/file changes together', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.request('POST', '/api/restore', f.admin.cookie, { type: 'backup', records: [], role_permissions: [{ role: 'BAD', permissions: '["invented.permission"]' }] }, 400);
  await f.request('POST', '/api/restore', f.admin.cookie, { type: 'backup', records: [], users: [{ username: 'bad', role: 'UNKNOWN', password: 'fixture' }] }, 400);
  assert.equal(f.sql(db => db.prepare('SELECT COUNT(*) n FROM users WHERE username=?').get('bad').n), 0);
  const count = f.sql(db => db.prepare('SELECT COUNT(*) n FROM records').get().n);
  const files = fs.readdirSync(path.join(f.runtime, 'uploads'));
  f.sql(db => db.exec("CREATE TRIGGER fail_fixture_file BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT,'fixture failure'); END"));
  await f.request('POST', '/api/restore', f.admin.cookie, { type: 'backup', records: [{ id: 888, module: 'assets', title: 'rollback fixture', data: {} }], files: [{ record_id: 888, original_name: 'restored.txt', mime_type: 'text/plain', content: 'YQ==' }] }, 400);
  assert.equal(f.sql(db => db.prepare('SELECT COUNT(*) n FROM records').get().n), count);
  assert.deepEqual(fs.readdirSync(path.join(f.runtime, 'uploads')), files);
});
