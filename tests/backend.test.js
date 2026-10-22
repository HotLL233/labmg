const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { createTestDatabase } = require('./helpers/postgres');

const root = path.resolve(__dirname, '..');

async function fixture(t, legacy = false, options = {}) {
  const cache = path.join(root, 'artifacts/cache', require('../package.json').version, 'backend-tests');
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'run-'));
  fs.cpSync(path.join(root, 'src'), path.join(directory, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'migrations'), path.join(directory, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'));
  const runtime = path.join(directory, 'runtime');
  let child;
  const stop = async () => {
    if (child?.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
  };
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(cache));
    assert.ok(path.basename(directory).startsWith('run-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const database = await createTestDatabase(t), db = await database.open();
  const sql = action => action(db);
  if (legacy) {
    fs.mkdirSync(path.join(runtime, 'uploads'), { recursive: true });
    await db.transaction(async () => {
      await db.prepare('INSERT INTO users(username,password,display_name,role) VALUES(?,?,?,?)').run('legacy-admin', 'legacy-password', 'Legacy', 'ADMIN');
      await db.prepare('INSERT INTO users(username,password,display_name,role) VALUES(?,?,?,?)').run('idle-user', 'idle-password', 'Idle', 'TESTER');
      const record = await db.prepare('INSERT INTO records(module,title,data) VALUES(?,?,?)').run('samples', 'legacy sample fixture', '{}');
      await db.prepare('INSERT INTO files(record_id,original_name,stored_name,mime_type,size) VALUES(?,?,?,?,?)').run(record.lastInsertRowid, 'sample.txt', 'sample.txt', 'text/plain', 6);
      await db.prepare('INSERT INTO role_permissions(role,permissions) VALUES(?,?)').run('LEGACY', '["samples.read"]');
      await db.prepare('INSERT INTO role_permissions(role,permissions) VALUES(?,?)').run('MATERIAL', JSON.stringify(options.materialPermissions || ['materials.read', 'materials.reagent.read']));
      if (options.materialMigrations) {
        for (const name of options.materialMigrations) await db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(name);
      }
    });
    fs.writeFileSync(path.join(runtime, 'uploads/sample.txt'), 'sample');
  }
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const environment = { ...process.env, PORT: String(port), LABOS_RUNTIME_DIR: runtime, LABOS_ADMIN_USER: 'test-admin', LABOS_ADMIN_PASSWORD: 'test-password', ...options.environment, DATABASE_URL: database.url };
  const start = async () => {
    child = spawn(process.execPath, [path.join(directory, 'src/server.js')], {
      cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    assert.match(String(output), /LabOS:/, stderr);
  };
  await start();
  const restart = async (overrides = {}) => { await stop(); Object.assign(environment, overrides); await start(); };
  const base = `http://127.0.0.1:${port}`;
  const request = async (method, route, cookie, body, expected = 200, extraHeaders = {}) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    Object.assign(headers, extraHeaders);
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    if (Array.isArray(expected)) assert.ok(expected.includes(response.status), `${method} ${route}: ${response.status} ${text}`);
    else assert.equal(response.status, expected, `${method} ${route}: ${text}`);
    return { status: response.status, headers: response.headers, data: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text };
  };
  const login = async (username = 'test-admin', password = 'test-password') => {
    const response = await request('POST', '/api/auth/login', null, { username, password });
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: response.data.user };
  };
  const admin = options.setup ? null : await login(legacy ? 'legacy-admin' : 'test-admin', legacy ? 'legacy-password' : 'test-password');
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
  return { directory, runtime, sql, request, login, admin, role, user, create, upload, restart, base };
}

test('empty databases require validated same-origin administrator setup without a default password', { timeout: 30000 }, async t => {
  const f = await fixture(t, false, { setup: true, environment: { LABOS_ADMIN_USER: undefined, LABOS_ADMIN_PASSWORD: undefined } });
  assert.deepEqual((await f.request('GET', '/api/auth/me')).data, { user: null, setupRequired: true, setupUsername: 'admin' });
  await f.request('POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' }, 401);
  const valid = { username: 'first-admin', password: 'setup123', passwordConfirm: 'setup123' };
  for (const input of [null, [], {}, { ...valid, username: 12 }, { ...valid, username: '' }, { ...valid, username: '  ' }, { ...valid, username: 'u'.repeat(65) }, { ...valid, password: 12345678 }, { ...valid, password: 'short12', passwordConfirm: 'short12' }, { ...valid, password: ' '.repeat(8), passwordConfirm: ' '.repeat(8) }, { ...valid, password: 'p'.repeat(1025), passwordConfirm: 'p'.repeat(1025) }, { ...valid, passwordConfirm: 'different' }, { username: valid.username, password: valid.password }]) {
    await f.request('POST', '/api/auth/setup', null, input, 400);
  }
  await f.request('POST', '/api/auth/setup', null, valid, 415, { 'Content-Type': 'text/plain' });
  for (const origin of ['https://other.example', 'null', '', 'not-an-origin', 'http://127.0.0.1:1']) {
    await f.request('POST', '/api/auth/setup', null, valid, 403, { Origin: origin });
  }
  assert.equal(await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM users').get()).n), 0);
  const username = 'u'.repeat(64), password = 'p'.repeat(1024);
  const result = await f.request('POST', '/api/auth/setup', null, { username: ` ${username} `, password, passwordConfirm: password }, 201, { Origin: f.base, 'Content-Type': 'application/json; charset=utf-8' });
  assert.equal(await f.sql(async db => (await db.prepare('SELECT username FROM users').get()).username), username);
  assert.equal(result.data.user.role, 'ADMIN');
  assert.deepEqual(result.data.user.permissions, ['*']);
  assert.equal(result.data.user.password, undefined);
  assert.match(result.headers.get('set-cookie'), /Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400/);
  const cookie = result.headers.get('set-cookie').split(';')[0];
  const me = (await f.request('GET', '/api/auth/me', cookie)).data;
  assert.equal(me.setupRequired, false);
  assert.equal(me.setupUsername, undefined);
  assert.equal(me.user.id, result.data.user.id);
  assert.match(await f.sql(async db => (await db.prepare('SELECT password FROM users').get()).password), /^scrypt\$/);
  const logs = await f.sql(async db => (await db.prepare('SELECT * FROM audit_logs').all()));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'SETUP');
  assert.ok(!JSON.stringify(logs).includes(password));
  await f.request('POST', '/api/auth/setup', null, valid, 409);
  await f.login(username, password);
});

test('concurrent first setup creates one administrator and remains closed after restart', { timeout: 30000 }, async t => {
  const f = await fixture(t, false, { setup: true, environment: { LABOS_ADMIN_USER: 'suggested-admin', LABOS_ADMIN_PASSWORD: '' } });
  assert.deepEqual((await f.request('GET', '/api/auth/me')).data, { user: null, setupRequired: true, setupUsername: 'suggested-admin' });
  const attempts = ['setup-one', 'setup-two'].map(username => ({ username, password: 'setup123', passwordConfirm: 'setup123' }));
  const results = await Promise.all(attempts.map(input => f.request('POST', '/api/auth/setup', null, input, [201, 409])));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const winner = results.find(result => result.status === 201);
  const original = await f.sql(async db => (await db.prepare('SELECT * FROM users').get()));
  assert.equal(await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM users').get()).n), 1);
  assert.equal(await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM sessions').get()).n), 1);
  assert.equal(await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM audit_logs WHERE action=?').get('SETUP')).n), 1);
  await f.restart({ LABOS_ADMIN_USER: 'replacement-admin', LABOS_ADMIN_PASSWORD: 'replacement-password' });
  const cookie = winner.headers.get('set-cookie').split(';')[0];
  const me = (await f.request('GET', '/api/auth/me', cookie)).data;
  assert.equal(me.setupRequired, false);
  assert.equal(me.user.id, original.id);
  assert.deepEqual(await f.sql(async db => (await db.prepare('SELECT * FROM users').all())), [original]);
  await f.request('POST', '/api/auth/setup', null, attempts[0], 409);
  await f.request('POST', '/api/auth/login', null, { username: 'replacement-admin', password: 'replacement-password' }, 401);
  await f.login(original.username, 'setup123');
});

test('any existing user disables setup and explicit initialization never overwrites an existing database', { timeout: 30000 }, async t => {
  const f = await fixture(t, true, { setup: true, environment: { LABOS_ADMIN_PASSWORD: '' } });
  await f.sql(async db => await db.prepare('DELETE FROM users WHERE username=?').run('legacy-admin'));
  const original = await f.sql(async db => (await db.prepare('SELECT * FROM users').get()));
  await f.restart({ LABOS_ADMIN_USER: 'new-admin', LABOS_ADMIN_PASSWORD: 'new-password' });
  assert.deepEqual((await f.request('GET', '/api/auth/me')).data, { user: null, setupRequired: false });
  await f.request('POST', '/api/auth/setup', null, { username: 'new-admin', password: 'setup123', passwordConfirm: 'setup123' }, 409);
  assert.deepEqual(await f.sql(async db => (await db.prepare('SELECT * FROM users').all())), [original]);
});

test('legacy passwords upgrade, backups hash idle passwords, startup preserves old samples', { timeout: 30000 }, async t => {
  const f = await fixture(t, true);
  assert.match(await f.sql(async db => (await db.prepare('SELECT password FROM users WHERE username=?').get('legacy-admin')).password), /^scrypt\$/);
  assert.equal(await f.sql(async db => (await db.prepare('SELECT password FROM users WHERE username=?').get('idle-user')).password), 'idle-password');
  assert.equal(await f.sql(async db => (await db.prepare('SELECT version FROM records WHERE module=?').get('samples')).version), 1);
  assert.equal(await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM files WHERE record_id=1').get()).n), 1);
  assert.equal(await f.sql(async db => (await db.prepare('SELECT permissions FROM role_permissions WHERE role=?').get('LEGACY')).permissions), '["samples.read"]');
  assert.equal(await f.sql(async db => (await db.prepare('SELECT permissions FROM role_permissions WHERE role=?').get('MATERIAL')).permissions), '["materials.read","materials.reagent.read"]', 'custom existing MATERIAL permissions must not be silently expanded');
  assert.equal(fs.readFileSync(path.join(f.runtime, 'uploads/sample.txt'), 'utf8'), 'sample');
  const backup = (await f.request('GET', '/api/backup', f.admin.cookie)).data;
  assert.ok(backup.users.every(user => /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(user.password)));
  assert.ok(!JSON.stringify(backup).includes('idle-password'));
  await f.request('POST', '/api/auth/login', null, { username: 'idle-user', password: 'wrong' }, 401);
  await f.login('idle-user', 'idle-password');
  assert.match(await f.sql(async db => (await db.prepare('SELECT password FROM users WHERE username=?').get('idle-user')).password), /^scrypt\$/);
  await f.request('POST', '/api/restore', f.admin.cookie, { type: 'backup', records: [], users: [{ username: 'restored', password: 'old-backup-password', display_name: 'Restored', role: 'TESTER' }] });
  assert.match(await f.sql(async db => (await db.prepare('SELECT password FROM users WHERE username=?').get('restored')).password), /^scrypt\$/);
  await f.login('restored', 'old-backup-password');
});

test('unchanged legacy MATERIAL defaults gain workflow permissions once and explicit revocations survive restart', { timeout: 30000 }, async t => {
  const previous = ['dashboard.read', 'materials.read', 'materials.write'];
  const f = await fixture(t, true, { materialPermissions: previous });
  const material = await f.user('upgraded-material', ['MATERIAL']);
  const permissions = (await f.request('GET', '/api/auth/me', material.cookie)).data.user.permissions;
  for (const permission of ['materials.request.submit', 'materials.request.edit_submitted', 'materials.acceptance.write', 'materials.amount.read', 'materials.export', 'materials.stock.location', 'materials.issue.write']) assert.ok(permissions.includes(permission));
  assert.equal((await f.request('GET', '/api/materials/meta', material.cookie)).data.capabilities.submitRequest, true);
  await f.request('PUT', '/api/permissions/roles/MATERIAL', f.admin.cookie, { permissions: previous });
  await f.restart();
  assert.deepEqual((await f.request('GET', '/api/auth/me', material.cookie)).data.user.permissions, previous);
  assert.equal((await f.request('GET', '/api/materials/meta', material.cookie)).data.capabilities.submitRequest, false);
  assert.equal(await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name=?').get('0.3.0-material-permissions')).n), 1);
  assert.equal(await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name=?').get('0.3.2-material-permissions')).n), 1);
});

const materialDefaults031 = ['dashboard.read', 'materials.read', 'materials.write',
  'materials.categories.write', 'materials.regions.write', 'materials.catalog.write', 'materials.request.submit',
  'materials.request.edit_submitted', 'materials.acceptance.write', 'materials.stock.initialize', 'materials.stock.adjust',
  'materials.amount.read', 'materials.export'];

test('unchanged 0.3.1 MATERIAL defaults gain issue and location permissions once, including reordered grants', { timeout: 30000 }, async t => {
  const previous = [...materialDefaults031].reverse();
  const f = await fixture(t, true, { materialPermissions: previous, materialMigrations: ['0.3.0-material-permissions'] });
  const material = await f.user('issue-material', ['MATERIAL']);
  const expected = [...previous, 'materials.stock.location', 'materials.issue.write'];
  assert.deepEqual((await f.request('GET', '/api/auth/me', material.cookie)).data.user.permissions, expected);
  const catalog = (await f.request('GET', '/api/permissions', f.admin.cookie)).data.catalog;
  assert.ok(catalog.includes('materials.stock.location'));
  assert.ok(catalog.includes('materials.issue.write'));
  await f.request('PUT', '/api/permissions/roles/MATERIAL', f.admin.cookie, { permissions: previous });
  await f.restart();
  assert.deepEqual((await f.request('GET', '/api/auth/me', material.cookie)).data.user.permissions, previous, 'revoked 0.3.2 permissions must stay revoked');
  assert.equal(await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name=?').get('0.3.2-material-permissions')).n), 1);
});

test('0.3.2 leaves customized or previously revoked MATERIAL grants unchanged and new databases use new defaults', { timeout: 30000 }, async t => {
  for (const previous of [materialDefaults031.filter(permission => permission !== 'materials.stock.adjust'),
    [...materialDefaults031, 'audit.read'], ['dashboard.read', 'materials.read', 'materials.write']]) {
    const f = await fixture(t, true, { materialPermissions: previous, materialMigrations: ['0.3.0-material-permissions'] });
    const permissions = async () => await f.sql(async db => JSON.parse((await db.prepare('SELECT permissions FROM role_permissions WHERE role=?').get('MATERIAL')).permissions));
    assert.deepEqual(await permissions(), previous);
    await f.restart();
    assert.deepEqual(await permissions(), previous);
    assert.equal(await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name=?').get('0.3.2-material-permissions')).n), 1);
  }
  const f = await fixture(t);
  const material = await f.user('new-issue-material', ['MATERIAL']);
  assert.deepEqual((await f.request('GET', '/api/auth/me', material.cookie)).data.user.permissions,
    [...materialDefaults031, 'materials.stock.location', 'materials.issue.write']);
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
  const record = await f.create({ module: 'assets', title: 'concurrent fixture', quantity: 10, data: {} });
  assert.equal(record.version, 1);
  await f.request('PUT', `/api/records/${record.id}`, first.cookie, { title: 'missing version' }, 400);
  const results = await Promise.all([first, second].map((actor, index) => f.request('PUT', `/api/records/${record.id}`, actor.cookie, { version: record.version, quantity: 9 - index }, [200, 409])));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const changed = results.find(result => result.status === 200).data;
  assert.equal(changed.version, 2);
  await f.request('PUT', `/api/records/${record.id}`, second.cookie, { version: record.version, quantity: 8 }, 409);
  assert.equal(await f.sql(async db => (await db.prepare('SELECT quantity FROM records WHERE id=?').get(record.id)).quantity), changed.quantity);
  const oldQuality = await f.create({ module: 'quality', title: 'controlled fixture', data: { quality_section: '质量手册', is_current: '是' } });
  await f.create({ module: 'quality', title: oldQuality.title, data: { quality_section: '质量手册', is_current: '是' } });
  const demoted = await f.sql(async db => (await db.prepare('SELECT data,version FROM records WHERE id=?').get(oldQuality.id)));
  assert.equal(JSON.parse(demoted.data).is_current, '否');
  assert.equal(demoted.version, oldQuality.version + 1);
  await f.request('PUT', `/api/records/${oldQuality.id}`, first.cookie, { version: oldQuality.version, title: 'stale trigger save' }, 409);
});

test('legacy material flows retain section-filtered read access and reject writes while finance directions remain scoped', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.role('STOCK', ['materials.read', 'materials.write', 'materials.inbound.read', 'materials.inbound.write', 'materials.reagent.read', 'finance.read', 'finance.income.read']);
  const actor = await f.user('stock', ['STOCK']);
  const legacyMaterial = async (title, data, category = '') => await f.sql(async db => {
    const added = await db.prepare('INSERT INTO records(module,title,category,data) VALUES(?,?,?,?)').run('materials', title, category, JSON.stringify(data));
    return { id: Number(added.lastInsertRowid), version: 1 };
  });
  const inbound = await legacyMaterial('inbound fixture', { flow: '入库管理', material_type: '试剂' });
  const reagent = await legacyMaterial('ledger fixture', { flow: '库存台账' }, '试剂');
  const outbound = await legacyMaterial('outbound fixture', { flow: '出库管理', material_type: '试剂' });
  await legacyMaterial('uncatalogued fixture', { flow: '采购申请', section: 'inbound', material_type: '试剂' });
  const income = await f.create({ module: 'finance', title: 'income fixture', data: { direction: '收入' } });
  await f.create({ module: 'finance', title: 'expense fixture', data: { direction: '支出' } });
  assert.deepEqual((await f.request('GET', '/api/records?module=materials', actor.cookie)).data.filter(record => record.title.endsWith('fixture')).map(record => record.id).sort((a, b) => a - b), [inbound.id, reagent.id]);
  assert.deepEqual((await f.request('GET', '/api/records?module=finance', actor.cookie)).data.map(record => record.id), [income.id]);
  await f.request('PUT', `/api/records/${inbound.id}`, actor.cookie, { version: inbound.version, quantity: 4 }, 403);
  await f.request('PUT', `/api/records/${outbound.id}`, actor.cookie, { version: outbound.version, quantity: 4 }, 403);
  await f.request('POST', '/api/records', actor.cookie, { module: 'materials', title: 'valid inbound', data: { flow: '入库管理', material_type: '试剂' } }, 403);
  await f.request('POST', '/api/records', actor.cookie, { module: 'materials', title: 'forged section', data: { flow: '采购申请', section: 'inbound' } }, 403);
});

test('legacy materials stay read-only through generic files and trash, and generic restore cannot populate the new business tables', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const legacy = (await f.request('GET', '/api/records?module=materials', f.admin.cookie)).data[0];
  assert.ok(legacy);
  await f.request('POST', '/api/records', f.admin.cookie, { module: 'materials', title: 'blocked' }, 403);
  await f.request('PUT', `/api/records/${legacy.id}`, f.admin.cookie, { version: legacy.version, quantity: 100 }, 403);
  await f.request('DELETE', `/api/records/${legacy.id}`, f.admin.cookie, undefined, 403);
  await f.request('POST', '/api/files', f.admin.cookie, { record_id: legacy.id, name: 'blocked.txt', type: 'text/plain', content: 'YQ==' }, 403);
  const stockBefore = (await f.request('GET', '/api/materials/stock', f.admin.cookie)).data;
  await f.request('POST', '/api/restore', f.admin.cookie, { type: 'backup', records: [{ id: 9999, module: 'materials', title: 'restored legacy', quantity: 8, data: { flow: '库存台账', material_type: '试剂' } }] });
  const restored = (await f.request('GET', '/api/records?module=materials', f.admin.cookie)).data.find(row => row.title === 'restored legacy');
  assert.ok(restored);
  await f.request('PUT', `/api/records/${restored.id}`, f.admin.cookie, { version: restored.version, quantity: 99 }, 403);
  assert.deepEqual((await f.request('GET', '/api/materials/stock', f.admin.cookie)).data, stockBefore);
  const businessBackup = (await f.request('GET', '/api/materials/backup', f.admin.cookie)).data;
  await f.request('POST', '/api/restore', f.admin.cookie, businessBackup, 400);
  await f.sql(async db => await db.prepare('UPDATE records SET deleted_at=CURRENT_TIMESTAMP::text WHERE id=?').run(restored.id));
  await f.request('POST', `/api/trash/${restored.id}/restore`, f.admin.cookie, {}, 403);
  await f.request('DELETE', `/api/trash/${restored.id}`, f.admin.cookie, undefined, 403);
});

test('legacy material money and unstructured data are hidden in records, exports and trash, while backups and attachments require amount permission', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.role('OLD_READER', ['materials.read', 'export.read', 'backup.read', 'backup.restore', 'trash.read']);
  const reader = await f.user('old-material-reader', ['OLD_READER']);
  const legacy = (await f.request('GET', '/api/records?module=materials', f.admin.cookie)).data[0];
  const data = { unit: '瓶', material_type: '试剂', nested: { customMonetaryLabel: 987.65 } };
  const fileId = await f.sql(async db => {
    await db.prepare('UPDATE records SET amount=?,data=? WHERE id=?').run(123.45, JSON.stringify(data), legacy.id);
    return Number((await db.prepare('INSERT INTO files(record_id,original_name,stored_name,mime_type,size) VALUES(?,?,?,?,?)').run(legacy.id, 'receipt.txt', 'legacy-receipt.txt', 'text/plain', 7)).lastInsertRowid);
  });
  fs.writeFileSync(path.join(f.runtime, 'uploads/legacy-receipt.txt'), '123.45!');
  const assertRedacted = record => { assert.ok(record); assert.equal(record.amount, undefined); assert.deepEqual(record.data, {}); };
  for (const route of ['/api/records?module=materials', '/api/records']) assertRedacted((await f.request('GET', route, reader.cookie)).data.find(row => row.id === legacy.id));
  assertRedacted((await f.request('GET', '/api/export?module=materials', reader.cookie)).data.records.find(row => row.id === legacy.id));
  for (const route of ['/api/backup', '/api/backup?module=materials', `/api/files?record_id=${legacy.id}`, `/api/files/${fileId}/download`]) await f.request('GET', route, reader.cookie, undefined, 403);
  await f.request('POST', '/api/restore', reader.cookie, { type: 'backup', records: [legacy] }, 403);
  const full = (await f.request('GET', '/api/backup?module=materials', f.admin.cookie)).data;
  assert.equal(full.scope, 'legacy-records-and-system'); assert.ok(full.excludedModules.includes('materials-workflow'));
  assert.equal(full.records.find(row => row.id === legacy.id).amount, 123.45);
  assert.deepEqual(full.records.find(row => row.id === legacy.id).data, data);
  assert.equal((await f.request('GET', `/api/files/${fileId}/download`, f.admin.cookie)).data, '123.45!');
  await f.sql(async db => await db.prepare('UPDATE records SET deleted_at=CURRENT_TIMESTAMP::text WHERE id=?').run(legacy.id));
  assertRedacted((await f.request('GET', '/api/trash', reader.cookie)).data.find(row => row.id === legacy.id));
});

test('restore validates system identities and rolls back record/file changes together', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.request('POST', '/api/restore', f.admin.cookie, { type: 'backup', records: [], role_permissions: [{ role: 'BAD', permissions: '["invented.permission"]' }] }, 400);
  await f.request('POST', '/api/restore', f.admin.cookie, { type: 'backup', records: [], users: [{ username: 'bad', role: 'UNKNOWN', password: 'fixture' }] }, 400);
  assert.equal(await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM users WHERE username=?').get('bad')).n), 0);
  const count = await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM records').get()).n);
  const files = fs.readdirSync(path.join(f.runtime, 'uploads'));
  await f.sql(async db => await db.exec(`CREATE FUNCTION fail_fixture_file() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
    CREATE TRIGGER fail_fixture_file BEFORE INSERT ON files FOR EACH ROW EXECUTE FUNCTION fail_fixture_file();`));
  await f.request('POST', '/api/restore', f.admin.cookie, { type: 'backup', records: [{ id: 888, module: 'assets', title: 'rollback fixture', data: {} }], files: [{ record_id: 888, original_name: 'restored.txt', mime_type: 'text/plain', content: 'YQ==' }] }, 400);
  assert.equal(await f.sql(async db => (await db.prepare('SELECT COUNT(*) n FROM records').get()).n), count);
  assert.deepEqual(fs.readdirSync(path.join(f.runtime, 'uploads')), files);
});
