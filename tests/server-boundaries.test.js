'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { test } = require('node:test');

// Execute the real HTTP callback without a listener, database, or runtime files.
async function fixture() {
  const files = new Map(), rollback = [], logs = [];
  const state = { failure: null, failureDepth: 1, depth: 0, users: [] };
  let handler;
  const db = {
    async transaction(callback) {
      state.depth++;
      try {
        const result = await callback();
        if (state.failure && state.depth === state.failureDepth) throw state.failure;
        return result;
      } finally { state.depth--; }
    },
    afterRollback(callback) { rollback.push(callback); },
    prepare(sql) {
      return {
        async get() {
          if (sql.includes('JOIN users u')) return { id: 1, username: 'synthetic', role: 'ADMIN' };
          if (sql.startsWith('SELECT * FROM records WHERE id=')) return { id: 1, module: 'assets', title: 'synthetic', data: '{}' };
          if (/^SELECT 1 FROM (users|schema_migrations|records)/.test(sql)) return { id: 1 };
          throw Error('Unexpected get: ' + sql);
        },
        async all() {
          if (sql === 'SELECT role FROM role_permissions ORDER BY role') return [{ role: 'ADMIN' }];
          if (sql === 'SELECT username,display_name,role FROM users ORDER BY id') return state.users;
          throw Error('Unexpected all: ' + sql);
        },
        async run() { return { changes: 1, lastInsertRowid: 1 }; }
      };
    },
    async exec() {},
    async close() {}
  };
  const filename = path.resolve(__dirname, '../src/server.js'), originalRequire = createRequire(filename);
  const load = name => {
    if (name === './database') return { openDatabase: async () => db };
    if (name === './materials') return { createMaterials: () => ({ handle: async () => false }) };
    if (name === 'node:http') return { createServer(callback) {
      handler = callback;
      return { listen() {} };
    } };
    if (name === 'node:fs') return {
      mkdirSync() {},
      writeFileSync(file, content) { files.set(file, content); },
      rmSync(file) { files.delete(file); },
      unlinkSync(file) { files.delete(file); }
    };
    return originalRequire(name);
  };
  load.resolve = originalRequire.resolve;
  await vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: load, __dirname: path.dirname(filename), URL, Buffer,
    process: { argv: [], env: {} }, console: { log() {}, error: error => logs.push(error) }
  }, { filename });
  assert.equal(typeof handler, 'function');
  async function request(url, payload, method = 'POST') {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
    Object.assign(req, { url, method, headers: { host: 'localhost', cookie: 'labos_session=synthetic' } });
    const res = {
      headers: {}, status: null, body: '', headersSent: false, destroyed: false,
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      removeHeader(name) { delete this.headers[name.toLowerCase()]; },
      writeHead(status, headers) {
        this.status = status;
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
        this.headersSent = true;
      },
      end(body) { this.body = body; },
      destroy() { this.destroyed = true; }
    };
    await handler(req, res);
    return { ...res, data: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(res.body) : null };
  }
  return { state, files, rollback, logs, request };
}

function backup(content) {
  return { type: 'backup', records: [{ id: 1, module: 'assets', title: 'synthetic' }],
    files: [{ record_id: 1, original_name: 'synthetic.bin', content }] };
}

test('generic upload and restore accept valid 4 MiB attachments without recursive regex overflow', async () => {
  const content = Buffer.alloc(4 * 1024 * 1024, 65).toString('base64'), f = await fixture();
  const upload = await f.request('/api/files', { record_id: 1, name: 'synthetic.bin', content });
  assert.equal(upload.status, 201, upload.body);
  assert.equal(upload.data.size, 4 * 1024 * 1024);
  const restore = await f.request('/api/restore', backup(content));
  assert.equal(restore.status, 200, restore.body);
  assert.equal(restore.data.files, 1);
  assert.equal(f.files.size, 2);
});

test('generic attachment validation rejects malformed padding and trailing line terminators', async () => {
  const f = await fixture();
  for (const content of ['A', 'AAA', '====', 'A===', 'AA=A', 'AAAA=', 'A=AA', 'AAA\n', 'AA\r\n', 'AAA\u2028', 'AAA\u2029', 'AA-_']) {
    assert.equal((await f.request('/api/files', { record_id: 1, content })).status, 400, JSON.stringify(content));
    assert.equal((await f.request('/api/restore', backup(content))).status, 400, JSON.stringify(content));
  }
  assert.equal(f.files.size, 0);
  for (const content of ['AA==', 'AAA=', 'AAAA', 'AB==']) {
    assert.equal((await f.request('/api/files', { record_id: 1, content })).status, 201, content);
    assert.equal((await f.request('/api/restore', backup(content))).status, 200, content);
  }
  assert.equal((await f.request('/api/files', { record_id: 1, content: 'data:application/octet-stream;base64,AA==' })).status, 201);
  assert.equal((await f.request('/api/files', { record_id: 1, content: '' })).status, 400);
  assert.equal((await f.request('/api/restore', backup(''))).data.files, 0);
});

test('unknown outer COMMIT returns a structured 503 and does not publish success or session cookies', async () => {
  const f = await fixture();
  f.state.failure = Object.assign(Error('synthetic internal connection details'), {
    code: 'ECONNRESET', transactionOutcomeUnknown: true, status: 400
  });
  const response = await f.request('/api/auth/logout', {});
  assert.equal(response.status, 503);
  assert.equal(response.data.code, 'TRANSACTION_OUTCOME_UNKNOWN');
  assert.equal(response.data.uncertain, true);
  assert.match(response.data.error, /核实|查询/);
  assert.doesNotMatch(response.body, /synthetic internal|ECONNRESET|"ok":true/);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.destroyed, false);
});

test('restore retains attachments on an unknown transaction outcome but cleans a definite failure', async () => {
  for (const uncertain of [true, false]) {
    const f = await fixture();
    f.state.failure = Object.assign(Error('synthetic restore failure'), { status: 400, transactionOutcomeUnknown: uncertain });
    f.state.failureDepth = 2;
    const response = await f.request('/api/restore', backup('AA=='));
    assert.equal(response.status, uncertain ? 503 : 400, response.body);
    assert.equal(f.files.size, uncertain ? 1 : 0);
    if (uncertain) assert.equal(response.data.uncertain, true);
    else assert.match(response.data.error, /恢复失败/);
  }
});

test('upload and restore retain written attachments when the outer COMMIT result is unknown', async () => {
  for (const url of ['/api/files', '/api/restore']) {
    const f = await fixture();
    f.state.failure = Object.assign(Error('synthetic lost commit reply'), { transactionOutcomeUnknown: true });
    const payload = url === '/api/files' ? { record_id: 1, content: 'AA==' } : backup('AA==');
    const response = await f.request(url, payload);
    assert.equal(response.status, 503, response.body);
    assert.equal(response.data.uncertain, true);
    assert.equal(f.files.size, 1);
    assert.equal(f.rollback.length, 1);
    assert.doesNotMatch(response.body, /"ok":true/);
  }
});

test('account HTTP CSV export protects formulas and roundtrips without changing literal apostrophes', async () => {
  const f = await fixture();
  f.state.users = [
    { username: '=1+1', display_name: '@synthetic', role: 'ADMIN' },
    { username: "'=literal", display_name: 'synthetic,"quoted"', role: 'ADMIN' }
  ];
  const response = await f.request('/api/users/export', {}, 'GET');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/csv/);
  assert.ok(response.body.includes('"\t=1+1","\t@synthetic"'));
  assert.ok(response.body.includes(`"'=literal","synthetic,""quoted"""`));
  const context = vm.createContext({
    document: { createElement: () => ({}), head: { appendChild() {} } }, window: {}, setInterval() {}
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/public/permission.js'), 'utf8'), context);
  vm.runInContext(`permissionData={roles:[{role:'ADMIN'}],roleNames:{ADMIN:'系统管理员'}}`, context);
  const rows = JSON.parse(JSON.stringify(context.userImportRows(response.body)));
  assert.deepEqual(rows.map(({ username, display_name, role }) => ({ username, display_name, role })), f.state.users);
  assert.ok(rows.every(row => !Object.hasOwn(row, 'password')));
});
