'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const createMaterials = require('../src/materials');

// Exercise the real deletion handler and real files, with a controlled outer
// transaction boundary. This is not a replacement for the PostgreSQL test.
function fixture(t, count = 2, commitHook = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'labos-draft-cleanup-'));
  const uploads = path.join(directory, 'materials');
  fs.mkdirSync(uploads);
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.match(path.basename(directory), /^labos-draft-cleanup-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const content = Buffer.from('synthetic attachment bytes');
  const attachments = Array.from({ length: count }, (_, i) => ({
    id: i + 1, stored_name: crypto.randomUUID() + '.bin', name: 'synthetic.txt', size: content.length, actor_id: 1
  }));
  attachments.forEach(row => fs.writeFileSync(path.join(uploads, row.stored_name), content));
  const rollback = [], commits = [], response = {};
  const db = {
    transaction: async callback => callback(), // Already inside the outer transaction.
    afterRollback: callback => rollback.push(callback),
    prepare(sql) {
      return {
        async get() {
          if (sql === 'SELECT * FROM material_requests WHERE id=?') return { id: 1, version: 1, status: 'draft', no: 'SYN-1', created_by: 1 };
          if (sql.startsWith('SELECT 1 FROM material_receipts') || sql.startsWith('SELECT 1 FROM material_request_revisions')) return undefined;
          throw Error('Unexpected get: ' + sql);
        },
        async all() {
          if (sql === 'SELECT * FROM material_attachments WHERE request_id=?') return attachments;
          if (sql === 'SELECT actor_id,key,response FROM material_idempotency') return [];
          throw Error('Unexpected all: ' + sql);
        },
        async run() {
          assert.match(sql, /^DELETE FROM material_(attachments|request_items|requests) WHERE/);
          return { changes: 1 };
        }
      };
    }
  };
  const materials = createMaterials({
    db, uploads: directory, body: async () => ({ requestVersion: 1, reason: 'synthetic deletion' }),
    send: (_res, status, data) => Object.assign(response, { status, data }),
    fail: (status, message) => Object.assign(Error(message), { status }), log: async () => {},
    hasPermission: () => true, afterCommit: commitHook ? (_res, callback) => commits.push(callback) : undefined
  });
  const remove = () => materials.handle({ method: 'DELETE' }, response, new URL('http://localhost/api/materials/requests/1'), { id: 1, role: 'MATERIAL' });
  return { directory: uploads, attachments, content, rollback, commits, response, remove };
}

test('draft attachment files remain recoverable until the outer transaction commits', async t => {
  const f = fixture(t);
  await f.remove();
  assert.equal(f.response.status, 200);
  assert.equal(f.commits.length, 1);
  assert.equal(f.rollback.length, 2);
  const staged = fs.readdirSync(f.directory);
  assert.equal(staged.length, 2);
  for (const row of f.attachments) {
    const name = staged.find(name => name.startsWith(row.stored_name + '.deleted-'));
    assert.ok(name, 'permanent cleanup must not run before outer COMMIT');
    assert.deepEqual(fs.readFileSync(path.join(f.directory, name)), f.content);
  }
  // Simulate outer COMMIT failure: discard commit tasks, run rollback callbacks.
  f.commits.length = 0;
  for (const callback of f.rollback.toReversed()) await callback();
  for (const row of f.attachments) assert.deepEqual(fs.readFileSync(path.join(f.directory, row.stored_name)), f.content);
  assert.equal(fs.readdirSync(f.directory).length, 2);
});

test('standalone callers without a commit hook retain recoverable quarantine without failing', async t => {
  const f = fixture(t, 1, false);
  await f.remove();
  assert.equal(f.response.status, 200);
  assert.equal(f.commits.length, 0);
  assert.equal(fs.readdirSync(f.directory).length, 1);
  for (const callback of f.rollback) await callback();
  assert.deepEqual(fs.readFileSync(path.join(f.directory, f.attachments[0].stored_name)), f.content);
});

test('draft attachment cleanup runs after successful outer commit and is idempotent', async t => {
  const f = fixture(t);
  await f.remove();
  assert.equal(fs.readdirSync(f.directory).length, 2);
  for (const callback of f.commits) callback();
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.doesNotThrow(() => f.commits.forEach(callback => callback()));
});
