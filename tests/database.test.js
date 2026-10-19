'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileSql, safeInteger, openDatabase } = require('../src/database');
const { createTestDatabase } = require('./helpers/postgres');

test('SQL compilation rewrites placeholders and ignore syntax only outside quotes/comments', () => {
  const sql = `INSERT OR IGNORE INTO users(username,password) VALUES(?, '? OR IGNORE') /* ? /* ? */ */ -- ?\n`;
  const compiled = compileSql(sql, { returningId: true });
  assert.equal(compiled.parameterCount, 1);
  assert.match(compiled.text, /VALUES\(\$1, '\? OR IGNORE'\)/);
  assert.match(compiled.text, /\nON CONFLICT DO NOTHING\nRETURNING id$/);
  assert.equal(compileSql(`SELECT "?", 'it''s ?', $$ ? $$, $body$ ? $body$, ? -- ?`).parameterCount, 1);
  assert.match(compileSql('INSERT INTO users(username) VALUES(?); -- trailing comment', { returningId: true }).text, /VALUES\(\$1\) -- trailing comment\nRETURNING id$/);
  assert.throws(() => compileSql('BEGIN IMMEDIATE'), /transaction/);
  assert.equal(safeInteger('9007199254740991'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => safeInteger('9007199254740992'), RangeError);
  assert.throws(() => safeInteger('1.5'), RangeError);
});

test('PostgreSQL adapter preserves types, nested atomic writes and database constraints', async t => {
  const target = await createTestDatabase(t), db = await target.open();
  const account = await db.prepare('INSERT INTO users(username,password,display_name,role) VALUES(?,?,?,?)').run('fixture', 'scrypt$fixture', 'Test', 'ADMIN');
  assert.equal(account.changes, 1);
  assert.equal(typeof account.lastInsertRowid, 'number');
  assert.equal((await db.prepare('INSERT OR IGNORE INTO users(username) VALUES(?)').run('fixture')).changes, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM users').get()).total, 1);
  assert.equal((await db.prepare('SHOW timezone').get()).TimeZone, 'UTC');
  assert.equal((await db.columns('users'))[0].pk, 1);
  assert.deepEqual((await db.columns('material_idempotency')).filter(column => column.pk).map(column => [column.name, column.pk]), [['actor_id', 1], ['key', 2]]);
  assert.equal((await db.columns('material_catalog')).find(column => column.name === 'version').type, 'INTEGER');
  assert.equal((await db.prepare("SELECT instr('abc','b') AS n,json_extract(?, '$.name') AS name,labos_date('') IS NULL AS empty").get('{"name":"sample"}')).name, 'sample');
  assert.equal((await db.prepare("SELECT labos_date('invalid') IS NULL AS empty").get()).empty, true);
  await assert.rejects(db.prepare('SELECT 9007199254740992::bigint AS unsafe').get(), RangeError);
  const outerPid = await db.transaction(async () => {
    const outer = await db.prepare('SELECT pg_backend_pid() AS pid').get();
    const nested = await db.transaction(() => db.prepare('SELECT pg_backend_pid() AS pid').get());
    assert.equal(outer.pid, nested.pid);
    return outer.pid;
  });
  assert.ok(outerPid > 0);
  await assert.rejects(db.transaction(async () => {
    await db.prepare("INSERT INTO material_state(key,value) VALUES('rolled-back','1')").run();
    await db.transaction(async () => { throw new Error('fixture rollback'); });
  }), /fixture rollback/);
  assert.equal(await db.prepare("SELECT * FROM material_state WHERE key='rolled-back'").get(), undefined);
  await db.prepare("INSERT INTO material_state(key,value) VALUES('counter','0')").run();
  await Promise.all(Array.from({ length: 12 }, () => db.transaction(async () => {
    const row = await db.prepare("SELECT value FROM material_state WHERE key='counter'").get();
    await db.prepare("UPDATE material_state SET value=? WHERE key='counter'").run(String(Number(row.value) + 1));
  })));
  assert.equal((await db.prepare("SELECT value FROM material_state WHERE key='counter'").get()).value, '12');
  const first = await db.prepare('INSERT INTO records(module,title,data) VALUES(?,?,?)').run('quality', 'Quality', '{"quality_section":"manual","is_current":"是","extra":1}');
  await db.prepare('INSERT INTO records(module,title,data) VALUES(?,?,?)').run('quality', 'Quality', '{"quality_section":"manual","is_current":"是"}');
  const old = await db.prepare('SELECT data,version FROM records WHERE id=?').get(first.lastInsertRowid);
  assert.equal(JSON.parse(old.data).is_current, '否');
  assert.equal(old.version, 2);
  assert.equal(JSON.parse(old.data).extra, 1);
  const deleted = await db.prepare('INSERT INTO users(username) VALUES(?)').run('deleted-fixture');
  await db.prepare('DELETE FROM users WHERE id=?').run(deleted.lastInsertRowid);
  await db.transaction(() => db.resetSequences());
  const next = await db.prepare('INSERT INTO users(username) VALUES(?)').run('after-reset');
  assert.ok(next.lastInsertRowid > deleted.lastInsertRowid, 'restoring material ids must not reuse deleted system ids');
  let cleaned = 0;
  await assert.rejects(db.transaction(async () => {
    db.afterRollback(() => { cleaned++; });
    await db.exec('CREATE TABLE commit_failure_fixture(value TEXT UNIQUE DEFERRABLE INITIALLY DEFERRED)');
    await db.prepare('INSERT INTO commit_failure_fixture(value) VALUES(?)').run('duplicate');
    await db.prepare('INSERT INTO commit_failure_fixture(value) VALUES(?)').run('duplicate');
  }), { code: '23505' });
  assert.equal(cleaned, 1, 'cleanup also runs when the business callback succeeds but COMMIT fails');
});

test('a missing PostgreSQL configuration fails without opening SQLite', async () => {
  const old = process.env.LABOS_DATABASE_PASSWORD_FILE;
  delete process.env.LABOS_DATABASE_PASSWORD_FILE;
  try { await assert.rejects(openDatabase({ connectionString: '' }), /不会回退到 SQLite/); }
  finally { if (old !== undefined) process.env.LABOS_DATABASE_PASSWORD_FILE = old; }
});

test('invalid connection URLs never echo credentials in their error', async () => {
  await assert.rejects(openDatabase({ connectionString: 'invalid-url-with-synthetic-secret' }), failure => failure.message === 'PostgreSQL DATABASE_URL 无效' && !JSON.stringify(failure).includes('synthetic-secret'));
});
