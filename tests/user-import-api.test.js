'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { createTestDatabase } = require('./helpers/postgres');

const root = path.resolve(__dirname, '..');

async function fixture(t) {
  const cache = path.join(root, 'artifacts/cache', require('../package.json').version, 'user-import-tests');
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'run-'));
  fs.cpSync(path.join(root, 'src'), path.join(directory, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'migrations'), path.join(directory, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'));
  let child;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(cache));
    assert.ok(path.basename(directory).startsWith('run-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const database = await createTestDatabase(t), db = await database.open();
  const reservation = net.createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  child = spawn(process.execPath, [path.join(directory, 'src/server.js')], { cwd: directory, windowsHide: true,
    env: { ...process.env, PORT: String(port), DATABASE_URL: database.url, LABOS_RUNTIME_DIR: path.join(directory, 'runtime'),
      LABOS_ADMIN_USER: 'import-admin', LABOS_ADMIN_PASSWORD: 'synthetic-admin-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  await Promise.race([
    once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) }).then(([data]) => assert.match(String(data), /LabOS:/, stderr)),
    once(child, 'exit').then(() => { throw Error('Isolated API fixture exited: ' + stderr); })
  ]);
  const request = async (method, route, cookie, body, expected = 200) => {
    const response = await fetch(`http://127.0.0.1:${port}` + route, { method, signal: AbortSignal.timeout(15000),
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${route}: ${text}`);
    return { headers: response.headers, data: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text };
  };
  const login = async (username, password) => {
    const result = await request('POST', '/api/auth/login', null, { username, password });
    return { cookie: result.headers.get('set-cookie').split(';')[0], user: result.data.user };
  };
  const admin = await login('import-admin', 'synthetic-admin-password');
  const account = async (username, displayName = '合成人员', roles = ['TESTER']) => {
    await request('POST', '/api/users', admin.cookie, { username, display_name: displayName, roles, password: 'synthetic-user-password' }, 201);
    return login(username, 'synthetic-user-password');
  };
  const users = () => db.prepare('SELECT id,username,password,display_name,role FROM users ORDER BY username').all();
  const sessions = async id => (await db.prepare('SELECT COUNT(*) AS total FROM sessions WHERE user_id=?').get(id)).total;
  return { request, login, admin, account, users, sessions, db };
}

function exportedRows(csv, permissions) {
  const context = vm.createContext({ document: { createElement: () => ({}), head: { appendChild() {} } }, window: {}, setInterval() {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/public/permission.js'), 'utf8'), context);
  context.fixturePermissions = permissions;
  vm.runInContext('permissionData=fixturePermissions', context);
  const header = context.parseCsv(csv)[0].cells;
  assert.deepEqual(Array.from(header), ['登录账号', '人员姓名', '角色']);
  return JSON.parse(JSON.stringify(context.userImportRows(csv)));
}

test('account imports accept Chinese roles and legacy codes while keeping same-name people separate', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const result = await f.request('POST', '/api/users/import', f.admin.cookie, { rows: [
    { sourceRow: 2, username: 'chinese-role', display_name: '同名人员', role: '物资管理员、检测人员', password: 'synthetic-first-password' },
    { sourceRow: 3, username: 'legacy-role', display_name: '同名人员', role: 'TESTER', password: 'synthetic-second-password' }
  ] });
  assert.equal(result.data.created, 2);
  const rows = await f.users();
  assert.equal(rows.filter(row => row.display_name === '同名人员').length, 2);
  assert.equal(rows.find(row => row.username === 'chinese-role').role, 'MATERIAL,TESTER');
  assert.equal(rows.find(row => row.username === 'legacy-role').role, 'TESTER');
  assert.equal((await f.login('chinese-role', 'synthetic-first-password')).user.role, 'MATERIAL,TESTER');
});

test('missing and invalid new passwords reject every row with cell details and no credential disclosure', { timeout: 30000 }, async t => {
  const f = await fixture(t), person = await f.account('keep-existing');
  const before = await f.users(), count = await f.sessions(person.user.id);
  const changedPassword = 'synthetic-password-must-not-be-saved';
  const invalidPassword = 'synthetic-password-must-not-be-returned'.repeat(40);
  const result = await f.request('POST', '/api/users/import', f.admin.cookie, { rows: [
    { sourceRow: 2, username: 'must-not-create', role: 'TESTER', password: 'synthetic-valid-password' },
    { sourceRow: 4, username: 'keep-existing', display_name: '不应修改', role: 'MATERIAL', password: changedPassword },
    { sourceRow: 8, sourceColumns: { password: 'A', role: 'B', username: 'C' }, username: 'missing-password', role: 'TESTER' },
    { sourceRow: 12, sourceColumns: { password: '<invalid>' }, username: 'invalid-password', role: 'TESTER', password: invalidPassword }
  ] }, 400);
  assert.ok(Array.isArray(result.data.errors));
  assert.ok(result.data.errors.some(error => error.row === 8 && /密码|password/.test(error.field) && /密码/.test(error.message)));
  assert.ok(result.data.errors.some(error => error.row === 12 && /密码|password/.test(error.field)));
  assert.equal(result.data.errors.find(error => error.row === 8 && /密码|password/.test(error.field)).column, 'A');
  assert.equal(result.data.errors.find(error => error.row === 12 && /密码|password/.test(error.field)).column, 'D');
  assert.doesNotMatch(JSON.stringify(result.data), /synthetic-password-must-not-be-saved|synthetic-valid-password|synthetic-password-must-not-be-returned/);
  assert.deepEqual(await f.users(), before);
  assert.equal(await f.sessions(person.user.id), count);
  assert.equal((await f.request('GET', '/api/auth/me', person.cookie)).data.user.id, person.user.id);
});

test('exported Chinese CSV imports back through the real CSV parser without changing passwords or sessions', { timeout: 30000 }, async t => {
  const f = await fixture(t), person = await f.account('roundtrip', '合成, "人员"\n第二行', ['MATERIAL', 'TESTER']);
  const before = await f.users(), sessionCount = await f.sessions(person.user.id);
  const csv = (await f.request('GET', '/api/users/export', f.admin.cookie)).data;
  assert.match(csv, /物资管理员/);
  assert.match(csv, /系统管理员/);
  assert.doesNotMatch(csv, /synthetic-user-password|synthetic-admin-password|scrypt\$|密码/);
  const permissions = (await f.request('GET', '/api/permissions', f.admin.cookie)).data;
  const rows = exportedRows(csv, permissions);
  assert.ok(rows.every(row => row.password === undefined));
  await f.request('POST', '/api/users/import', f.admin.cookie, { rows });
  assert.deepEqual(await f.users(), before);
  assert.equal(await f.sessions(person.user.id), sessionCount);
  assert.equal((await f.request('GET', '/api/auth/me', person.cookie)).data.user.id, person.user.id);
});

test('an explicit imported password revokes existing sessions and preserves the exact new password', { timeout: 30000 }, async t => {
  const f = await fixture(t), person = await f.account('password-change');
  const password = '  synthetic changed password  ';
  await f.request('POST', '/api/users/import', f.admin.cookie, { rows: [{ username: 'password-change', role: 'TESTER', password }] });
  assert.equal(await f.sessions(person.user.id), 0);
  assert.equal((await f.request('GET', '/api/auth/me', person.cookie)).data.user, null);
  await f.request('POST', '/api/auth/login', null, { username: 'password-change', password: 'synthetic-user-password' }, 401);
  assert.equal((await f.login('password-change', password)).user.id, person.user.id);
});

test('duplicate usernames and partially unknown role lists reject the entire batch', { timeout: 30000 }, async t => {
  const f = await fixture(t), before = await f.users();
  for (const rows of [
    [{ sourceRow: 2, username: 'duplicate', role: 'TESTER', password: 'synthetic-user-password' },
      { sourceRow: 7, username: 'duplicate', role: 'MATERIAL', password: 'synthetic-user-password' }],
    [{ sourceRow: 2, username: 'would-create', role: 'TESTER', password: 'synthetic-user-password' },
      { sourceRow: 9, username: 'unknown-role', role: 'TESTER,DOES_NOT_EXIST', password: 'synthetic-user-password' }]
  ]) {
    const response = await f.request('POST', '/api/users/import', f.admin.cookie, { rows }, 400);
    assert.ok(response.data.errors.some(error => error.row === rows[1].sourceRow));
    assert.deepEqual(await f.users(), before);
  }
});

test('removing the final administrator rolls back earlier valid rows and retains administrator access', { timeout: 30000 }, async t => {
  const f = await fixture(t), before = await f.users();
  const result = await f.request('POST', '/api/users/import', f.admin.cookie, { rows: [
    { sourceRow: 2, username: 'would-create', role: 'TESTER', password: 'synthetic-user-password' },
    { sourceRow: 9, username: 'import-admin', role: 'TESTER' }
  ] }, 400);
  assert.match(result.data.error, /管理员|导入/);
  assert.deepEqual(await f.users(), before);
  assert.equal((await f.request('GET', '/api/auth/me', f.admin.cookie)).data.user.role, 'ADMIN');
});

test('account import and export retain authentication and permission checks', { timeout: 30000 }, async t => {
  const f = await fixture(t), ordinary = await f.account('ordinary-user'), before = await f.users();
  const body = { rows: [{ username: 'must-not-create', role: 'TESTER', password: 'synthetic-user-password' }] };
  await f.request('POST', '/api/users/import', ordinary.cookie, body, 403);
  await f.request('GET', '/api/users/export', ordinary.cookie, undefined, 403);
  await f.request('POST', '/api/users/import', null, body, 401);
  assert.deepEqual(await f.users(), before);
});
