'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { cell } = require('../src/public/csv');

function fixture() {
  const status = { hidden: true, textContent: '', setAttribute() {}, focus() {}, scrollIntoView() {} };
  const state = { requests: [], messages: [], renders: [], response: { ok: true, created: 0, updated: 1 } };
  const context = vm.createContext({
    document: { createElement: () => ({}), head: { appendChild() {} } }, window: {}, setInterval() {},
    $: selector => selector === '#users-import-status' ? status : null,
    toast: message => state.messages.push(message),
    fetch: async (url, options) => {
      state.requests.push({ url, body: JSON.parse(options.body) });
      return { ok: state.response.ok, json: async () => state.response };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/permission.js'), 'utf8'), context);
  vm.runInContext(`permissionData={roles:[{role:'ADMIN'},{role:'MATERIAL'},{role:'CUSTOM'}],roleNames:{ADMIN:'系统管理员',MATERIAL:'物资管理员'}}`, context);
  context.renderAccounts = message => state.renders.push(message);
  return { context, state, status, rows: text => JSON.parse(JSON.stringify(context.userImportRows(text))),
    parse: text => JSON.parse(JSON.stringify(context.parseCsv(text))),
    import: (text, size = Buffer.byteLength(text)) => context.importUsers({ size, text: async () => text }) };
}

test('account CSV parses quoted multiline cells and retains physical source lines', () => {
  const app = fixture();
  const csv = '\uFEFF登录账号,人员姓名,角色,密码\r\n' +
    'old,"合成,人员\r\n第二行",系统管理员,\r\n\r\n' +
    'new,"双""引号",物资管理员,"  keep spaces  "\r\n';
  assert.deepEqual(app.rows(csv), [
    { sourceRow: 2, sourceColumns: { username: 'A', display_name: 'B', role: 'C', password: 'D' }, username: 'old', display_name: '合成,人员\n第二行', role: 'ADMIN', password: '' },
    { sourceRow: 5, sourceColumns: { username: 'A', display_name: 'B', role: 'C', password: 'D' }, username: 'new', display_name: '双"引号', role: 'MATERIAL', password: '  keep spaces  ' }
  ]);
  assert.equal(app.parse('登录账号,角色\n\nexisting,ADMIN')[1].row, 3);
});

test('Chinese role names and legacy codes share the same import contract without requiring passwords for exported accounts', () => {
  const app = fixture();
  assert.deepEqual(app.rows('登录账号,人员姓名,角色\nexisting,同名人员,系统管理员、物资管理员\nother,同名人员,"material,CUSTOM"'), [
    { sourceRow: 2, sourceColumns: { username: 'A', display_name: 'B', role: 'C' }, username: 'existing', display_name: '同名人员', role: 'ADMIN,MATERIAL' },
    { sourceRow: 3, sourceColumns: { username: 'A', display_name: 'B', role: 'C' }, username: 'other', display_name: '同名人员', role: 'MATERIAL,CUSTOM' }
  ]);
  assert.deepEqual(app.rows('登录账号,角色代码\nlegacy,ADMIN'), [{ sourceRow: 2, sourceColumns: { username: 'A', role: 'B' }, username: 'legacy', role: 'ADMIN' }]);
});

test('invalid CSV quoting, duplicate headers and wrong column counts identify exact lines and columns', () => {
  const app = fixture();
  assert.throws(() => app.rows('登录账号,角色\nnew,"系统管理员'), error => error.errors[0].row === 2 && error.errors[0].column === 'B' && /引号未闭合/.test(error.errors[0].message));
  assert.throws(() => app.rows('登录账号,角色\nnew,"系统管理员"oops'), error => error.errors[0].row === 2 && error.errors[0].column === 'B' && /结束引号/.test(error.errors[0].message));
  assert.throws(() => app.rows('登录账号,账号,角色\na,b,ADMIN'), error => error.errors.some(row => row.row === 1 && row.column === 'B' && /重复/.test(row.message)));
  assert.throws(() => app.rows('登录账号,角色,未知列\na,ADMIN,x'), error => error.errors.some(row => row.row === 1 && row.column === 'C' && /无法识别/.test(row.message)));
  for (const name of ['constructor', 'toString', '__proto__']) assert.throws(() => app.rows(`登录账号,角色,${name}\na,ADMIN,x`), error => error.errors.some(row => row.row === 1 && row.column === 'C' && /无法识别/.test(row.message)));
  assert.throws(() => app.rows('登录账号,角色\na,ADMIN,extra'), error => error.errors.some(row => row.row === 2 && row.field === '列数'));
  assert.throws(() => app.rows('人员姓名\n同名人员'), error => error.errors.some(row => row.field === '登录账号') && error.errors.some(row => row.field === '角色'));
});

test('invalid roles and duplicate usernames reject the whole file before any network request', async () => {
  const app = fixture();
  await app.import('登录账号,角色\nvalid,系统管理员\n\nvalid,物资管理员\nbad,不存在的角色');
  assert.equal(app.state.requests.length, 0);
  assert.match(app.status.textContent, /第 4 行 A 列.*重复/);
  assert.match(app.status.textContent, /第 5 行 B 列.*不存在/);
  assert.match(app.status.textContent, /未保存任何数据/);
  assert.equal(app.status.hidden, false);
});

test('server errors remain visible with physical cell details and never echo password values', async () => {
  const app = fixture();
  app.state.response = { ok: false, error: '人员账号导入失败，未保存任何数据', totalErrors: 1,
    errors: [{ row: 4, column: 'D', field: '密码', message: '新账号必须填写密码。', value: 'must-not-echo' }] };
  await app.import('登录账号,角色,密码\n\n\nnew,物资管理员,');
  assert.equal(app.state.requests.length, 1);
  assert.equal(app.state.requests[0].body.rows[0].sourceRow, 4);
  assert.equal(app.state.requests[0].body.rows[0].password, '');
  assert.match(app.status.textContent, /第 4 行 D 列.*新账号必须填写密码/);
  assert.doesNotMatch(app.status.textContent, /must-not-echo/);
  assert.equal(app.state.renders.length, 0);
});

test('successful account imports preserve the password-free roundtrip payload and show persistent results', async () => {
  const app = fixture();
  await app.import('登录账号,人员姓名,角色\nexisting,合成人员,系统管理员');
  assert.deepEqual(app.state.requests[0], { url: '/api/users/import', body: { rows: [
    { sourceRow: 2, sourceColumns: { username: 'A', display_name: 'B', role: 'C' }, username: 'existing', display_name: '合成人员', role: 'ADMIN' }
  ] } });
  assert.match(app.state.renders[0], /更新 1 个账号.*保留原密码/);
  assert.equal(app.state.messages.length, 1);
});

test('reordered optional columns retain their actual Excel-style coordinates for server validation', () => {
  const app = fixture();
  assert.deepEqual(app.rows('密码,角色,登录账号,人员姓名\n,物资管理员,new,合成人员'), [{ sourceRow: 2,
    sourceColumns: { password: 'A', role: 'B', username: 'C', display_name: 'D' }, password: '', role: 'MATERIAL', username: 'new', display_name: '合成人员' }]);
});

test('account CSV limits reject oversized or excessive data without making a request', async () => {
  const app = fixture();
  await app.import('登录账号,角色\na,ADMIN', 5 * 1024 * 1024 + 1);
  assert.match(app.status.textContent, /5 MiB/);
  await app.import('登录账号,角色\n' + Array.from({ length: 201 }, (_, index) => `u${index},ADMIN`).join('\n'));
  assert.match(app.status.textContent, /200 条/);
  assert.equal(app.state.requests.length, 0);
});

test('protected account CSV exports roundtrip formula-like names and literal apostrophes', () => {
  const app = fixture();
  const accounts = [
    ['=account', '+Name'],
    ['+account', '-Name'],
    ['-account', '@Name'],
    ['@account', '=Name'],
    ['\uFF1Daccount', '\uFF0BName'],
    ["'=literal", "'=Literal name"],
    ['comma,"quoted"', 'Name, "quoted"\nsecond line']
  ];
  const csv = '\uFEFF' + [['登录账号', '人员姓名', '角色'], ...accounts.map(row => [...row, '系统管理员'])]
    .map(row => row.map(cell).join(',')).join('\r\n');
  assert.deepEqual(app.rows(csv).map(({ username, display_name, role }) => [username, display_name, role]),
    accounts.map(row => [...row, 'ADMIN']));
  assert.ok(csv.includes('"\t=account"'));
  assert.ok(csv.includes('"\'=literal"'));
  assert.ok(app.rows(csv).every(row => !Object.hasOwn(row, 'password')));
});

test('account import trims protective whitespace but leaves formula-like password bytes untouched', () => {
  const app = fixture();
  const password = '  \t=secret,"literal"  ';
  const csv = ['登录账号,人员姓名,角色,密码',
    [cell('=account'), cell(' \t+Name'), cell('系统管理员'), `"${password.replaceAll('"', '""')}"`].join(',')].join('\r\n');
  const [row] = app.rows(csv);
  assert.equal(row.username, '=account');
  assert.equal(row.display_name, '+Name');
  assert.equal(row.password, password);
});
