'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { applyMigrations } = require('../src/migrations');
const { createTestDatabase } = require('./helpers/postgres');

const root = path.resolve(__dirname, '..');
const migration = '0003-material-catalog-decouple.sql';

test('fresh databases apply additive migrations once, including concurrent startup and the migration CLI', async t => {
  const database = await createTestDatabase(t), [db, other] = await Promise.all([database.open(), database.open()]);
  assert.deepEqual(await db.prepare('SELECT name FROM schema_migrations ORDER BY name').all(), [{ name: migration }]);
  assert.deepEqual(await Promise.all([applyMigrations(db), applyMigrations(other)]), [[], []]);
  assert.ok((await db.columns('material_catalog')).some(column => column.name === 'merged_into' && column.notnull === 0));
  const cli = spawnSync(process.execPath, ['scripts/migrate.js'], { cwd: root, env: { ...process.env, DATABASE_URL: database.url }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(cli.error);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /数据库结构及迁移已就绪/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).n, 1);
});

test('the frozen 0.9.4 schema upgrades with data, legacy markers, snapshots, identities and old inserts preserved', async t => {
  const database = await createTestDatabase(t), db = await database.open({ initialize: false });
  await db.transaction(() => db.exec(fs.readFileSync(path.join(__dirname, 'fixtures/schema-0.9.4.sql'), 'utf8')));
  const snapshot = '{ "name": "历史物资", "spec": "旧  规格", "unit": "瓶" }';
  await db.transaction(async () => {
    await db.exec(`INSERT INTO users(id,username,password,display_name,role) VALUES(7,'migration-fixture','synthetic-password-hash','Migration','MATERIAL');
      INSERT INTO sessions(token,user_id,expires_at) VALUES('synthetic-session',7,9999999999999);
      INSERT INTO material_categories(id,name,created_by) VALUES(2,'试剂',7);
      INSERT INTO material_regions(id,name,created_by) VALUES(3,'实验室',7);
      INSERT INTO material_catalog(id,code,name,spec,unit,category_id,created_by) VALUES(8,'OLD-8','历史物资','旧  规格','瓶',2,7);
      INSERT INTO material_requests(id,no,title,created_by) VALUES(4,'OLD-4','历史申报',7);
      INSERT INTO material_request_items(id,request_id,catalog_id,name,spec,unit,category_id,region_id,warehouse,qty_m,author_id) VALUES(5,4,8,'历史物资','旧  规格','瓶',2,3,'MAIN',1000,7);
      INSERT INTO schema_migrations(name) VALUES('0.3.0-material-permissions'),('0.3.2-material-permissions');`);
    await db.prepare('INSERT INTO material_stock_movements(id,type,catalog_id,region_id,warehouse,qty_m,amount_cents,source_key,snapshot,date,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(9,'opening',8,3,'MAIN',1000,1234,'opening:legacy',snapshot,'2026-10-22',7);
    await db.resetSequences();
  });
  const users = await db.prepare('SELECT * FROM users').all();
  const upgraded = await database.open();
  assert.deepEqual(await upgraded.prepare('SELECT * FROM users').all(), users);
  assert.equal((await upgraded.prepare('SELECT token FROM sessions').get()).token, 'synthetic-session');
  assert.equal((await upgraded.prepare('SELECT snapshot FROM material_stock_movements WHERE id=9').get()).snapshot, snapshot);
  assert.deepEqual(await upgraded.prepare('SELECT remark,origin,merged_into,spec FROM material_catalog WHERE id=8').get(), { remark: '', origin: 'manual', merged_into: null, spec: '旧  规格' });
  assert.deepEqual(await upgraded.prepare('SELECT manufacturer,note,qty_m,amount_cents FROM material_stock_movements WHERE id=9').get(), { manufacturer: '', note: '', qty_m: 1000, amount_cents: 1234 });
  assert.equal((await upgraded.prepare('SELECT manufacturer FROM material_request_items WHERE id=5').get()).manufacturer, '');
  assert.equal((await upgraded.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).n, 3);
  const oldInsert = await upgraded.prepare('INSERT INTO material_catalog(code,name,spec,unit,category_id,created_by) VALUES(?,?,?,?,?,?)').run('OLD-INSERT','旧版继续写入','1','瓶',2,7);
  assert.ok(oldInsert.lastInsertRowid > 8);
  assert.equal((await upgraded.prepare('SELECT origin FROM material_catalog WHERE id=?').get(oldInsert.lastInsertRowid)).origin, 'manual');
  assert.deepEqual(await applyMigrations(upgraded), []);
});

test('a failed migration rolls back its SQL and marker, stops subsequent files, then retries only unapplied files', async t => {
  const database = await createTestDatabase(t), db = await database.open();
  const cache = path.join(root, 'artifacts/cache', require('../package.json').version);
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'migration-test-'));
  t.after(() => { assert.equal(path.dirname(directory), cache); fs.rmSync(directory, { recursive: true }); });
  fs.writeFileSync(path.join(directory, '0100-first.sql'), "INSERT INTO material_state(key,value) VALUES('migration-first','1');");
  const failing = path.join(directory, '0101-failure.sql');
  fs.writeFileSync(failing, "INSERT INTO material_state(key,value) VALUES('migration-failure','1'); SELECT * FROM missing_migration_fixture;");
  fs.writeFileSync(path.join(directory, '0102-later.sql'), "INSERT INTO material_state(key,value) VALUES('migration-later','1');");
  await assert.rejects(applyMigrations(db, directory), error => /0101-failure.sql.*42P01/.test(error.message));
  assert.deepEqual(await db.prepare("SELECT key FROM material_state WHERE key LIKE 'migration-%' ORDER BY key").all(), [{ key: 'migration-first' }]);
  assert.equal(await db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('0101-failure.sql'), undefined);
  fs.writeFileSync(failing, "INSERT INTO material_state(key,value) VALUES('migration-failure','1');");
  assert.deepEqual(await applyMigrations(db, directory), ['0101-failure.sql', '0102-later.sql']);
  fs.writeFileSync(path.join(directory, '0102-duplicate.sql'), 'SELECT 1;');
  await assert.rejects(applyMigrations(db, directory), /迁移文件名或版本重复/);
});
