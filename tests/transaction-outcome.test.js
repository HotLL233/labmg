'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');

async function fixture({ commitError, rollbackError, command = 'COMMIT' } = {}) {
  const queries = [], releases = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === 'COMMIT' && commitError) throw commitError;
      if (sql === 'ROLLBACK' && rollbackError) throw rollbackError;
      return { command: sql === 'COMMIT' ? command : sql.split(' ')[0], rows: [] };
    },
    release(error) { releases.push(error); }
  };
  class Pool {
    on() {}
    async connect() { return client; }
    async query() { return { rows: [] }; }
    async end() {}
  }
  const filename = path.resolve(__dirname, '../src/database.js'), originalRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, URL, console, __dirname: path.dirname(filename),
    require: name => name === 'pg' ? { Pool, types: { getTypeParser: () => value => value } } : originalRequire(name)
  }, { filename });
  const db = await module.exports.openDatabase({ connectionString: 'postgresql://synthetic@localhost/synthetic', initialize: false });
  return { db, queries, releases };
}

test('committed and nested transactions leave rollback work untouched', async () => {
  const f = await fixture(), cleaned = [];
  assert.equal(await f.db.transaction(async () => {
    f.db.afterRollback(() => cleaned.push('outer'));
    return f.db.transaction(() => 42);
  }), 42);
  assert.deepEqual(cleaned, []);
  assert.equal(f.queries.filter(sql => sql === 'BEGIN').length, 1);
  assert.deepEqual(f.releases, [undefined]);
});

test('confirmed callback rollbacks run cleanup in reverse order and retain the original error', async () => {
  const f = await fixture(), failure = Error('synthetic callback failure'), cleaned = [];
  await assert.rejects(f.db.transaction(async () => {
    f.db.afterRollback(() => cleaned.push('first'));
    f.db.afterRollback(() => cleaned.push('second'));
    throw failure;
  }), error => error === failure && !error.transactionOutcomeUnknown);
  assert.deepEqual(cleaned, ['second', 'first']);
  assert.deepEqual(f.releases, [undefined]);
});

test('an explicit PostgreSQL COMMIT rejection still cleans files even when later rollback fails', async () => {
  for (const rollbackError of [undefined, Error('synthetic disconnected client')]) {
    const failure = Object.assign(Error('synthetic deferred constraint'), { code: '23505', severity: 'ERROR' });
    const f = await fixture({ commitError: failure, rollbackError });
    let cleaned = false;
    await assert.rejects(f.db.transaction(async () => f.db.afterRollback(() => { cleaned = true; })),
      error => error === failure && !error.transactionOutcomeUnknown);
    assert.equal(cleaned, true);
    assert.equal(f.releases[0], rollbackError);
  }
});

test('a server ROLLBACK result from COMMIT proves files can be cleaned', async () => {
  const f = await fixture({ command: 'ROLLBACK' });
  let cleaned = false;
  await assert.rejects(f.db.transaction(async () => f.db.afterRollback(() => { cleaned = true; })),
    error => !error.transactionOutcomeUnknown);
  assert.equal(cleaned, true);
  assert.deepEqual(f.releases, [undefined]);
});

test('unknown COMMIT outcomes preserve files even if a subsequent empty ROLLBACK succeeds', async () => {
  for (const properties of [
    { code: 'ECONNRESET' }, { code: 'EPIPE' }, { code: '08007', severity: 'ERROR' },
    { code: '40003', severity: 'ERROR' }, { code: '57P01', severity: 'FATAL' }
  ]) {
    for (const rollbackError of [undefined, Error('synthetic closed connection')]) {
      const failure = Object.assign(Error('synthetic lost commit reply'), properties);
      const f = await fixture({ commitError: failure, rollbackError });
      let cleaned = false;
      await assert.rejects(f.db.transaction(async () => f.db.afterRollback(() => { cleaned = true; })),
        error => error === failure && error.transactionOutcomeUnknown === true);
      assert.equal(cleaned, false, JSON.stringify(properties));
      assert.equal(f.releases[0], rollbackError || failure, 'uncertain connections must not return to the pool');
    }
  }
});

test('an unconfirmed rollback preserves files and discards the connection without masking the callback error', async () => {
  const rollbackError = Error('synthetic rollback failure'), f = await fixture({ rollbackError });
  const failure = Error('synthetic callback failure');
  let cleaned = false;
  await assert.rejects(f.db.transaction(async () => {
    f.db.afterRollback(() => { cleaned = true; });
    throw failure;
  }), error => error === failure && error.transactionOutcomeUnknown === true);
  assert.equal(cleaned, false);
  assert.equal(f.releases[0], rollbackError);
});
