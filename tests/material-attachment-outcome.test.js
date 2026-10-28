'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const createMaterials = require('../src/materials');

function fixture(t, failure) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'labos-attachment-outcome-'));
  const uploads = path.join(directory, 'materials'), response = {}, rollback = [];
  let attachment;
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.match(path.basename(directory), /^labos-attachment-outcome-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const content = Buffer.from('synthetic attachment bytes');
  const db = {
    async transaction(callback) {
      const result = await callback();
      if (failure) throw failure;
      return result;
    },
    afterRollback(callback) { rollback.push(callback); },
    prepare(sql) {
      return {
        async get() {
          if (sql === 'SELECT * FROM material_receipts WHERE id=?') return { id: 1 };
          if (sql === 'SELECT * FROM material_attachments WHERE id=?') return attachment;
          throw Error('Unexpected get: ' + sql);
        },
        async run(requestId, receiptId, name, mimeType, storedName, size, actorId) {
          assert.match(sql, /^INSERT INTO material_attachments/);
          attachment = { id: 1, request_id: requestId, receipt_id: receiptId, name, mime_type: mimeType,
            stored_name: storedName, size, actor_id: actorId };
          return { lastInsertRowid: 1, changes: 1 };
        }
      };
    }
  };
  const materials = createMaterials({
    db, uploads: directory, body: async () => ({ name: 'synthetic.txt', mimeType: 'text/plain',
      content: content.toString('base64'), reason: 'synthetic receipt attachment' }),
    send: (_res, status, data) => Object.assign(response, { status, data }),
    fail: (status, message) => Object.assign(Error(message), { status }),
    log: async () => {}, hasPermission: () => true
  });
  return {
    upload: () => materials.handle({ method: 'POST' }, response, new URL('http://localhost/api/materials/receipts/1/attachments'),
      { id: 1, role: 'MATERIAL' }),
    file: () => path.join(uploads, attachment.stored_name), content, response, rollback
  };
}

test('a successful standalone receipt attachment retains its real file', async t => {
  const f = fixture(t);
  await f.upload();
  assert.equal(f.response.status, 201);
  assert.deepEqual(fs.readFileSync(f.file()), f.content);
  assert.equal(f.rollback.length, 1);
});

test('an unknown standalone attachment COMMIT keeps its file and original failure', async t => {
  const failure = Object.assign(Error('synthetic lost commit reply'), { code: '23505', transactionOutcomeUnknown: true });
  const f = fixture(t, failure);
  await assert.rejects(f.upload(), error => error === failure);
  assert.deepEqual(fs.readFileSync(f.file()), f.content);
  assert.equal(f.response.status, undefined);
});

test('a confirmed standalone attachment failure removes its file', async t => {
  const failure = Object.assign(Error('synthetic rollback'), { status: 409 }), f = fixture(t, failure);
  await assert.rejects(f.upload(), error => error === failure);
  assert.equal(fs.existsSync(f.file()), false);
});

test('attachment cleanup failures do not hide the original transaction error', async t => {
  const failure = Object.assign(Error('synthetic rollback'), { status: 409 }), f = fixture(t, failure);
  const remove = fs.rmSync;
  const cleanup = t.mock.method(fs, 'rmSync', (file, options) => {
    if (file === f.file()) throw Error('synthetic cleanup failure');
    return remove(file, options);
  });
  const report = t.mock.method(console, 'error', () => {});
  await assert.rejects(f.upload(), error => error === failure);
  assert.equal(report.mock.callCount(), 1);
  assert.deepEqual(fs.readFileSync(f.file()), f.content);
  cleanup.mock.restore();
});
