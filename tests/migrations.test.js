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
const migrations = [migration, '0004-material-maintenance-numbering.sql', '0005-material-lab.sql', '0006-material-arrivals.sql'];

test('fresh databases apply additive migrations once, including concurrent startup and the migration CLI', async t => {
  const database = await createTestDatabase(t), [db, other] = await Promise.all([database.open(), database.open()]);
  assert.deepEqual(await db.prepare('SELECT name FROM schema_migrations ORDER BY name').all(), migrations.map(name => ({ name })));
  assert.deepEqual(await Promise.all([applyMigrations(db), applyMigrations(other)]), [[], []]);
  assert.ok((await db.columns('material_catalog')).some(column => column.name === 'merged_into' && column.notnull === 0));
  const cli = spawnSync(process.execPath, ['scripts/migrate.js'], { cwd: root, env: { ...process.env, DATABASE_URL: database.url }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(cli.error);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /数据库结构及迁移已就绪/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).n, migrations.length);
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
  });
  const users = await db.prepare('SELECT * FROM users').all();
  const upgraded = await database.open();
  await upgraded.transaction(() => upgraded.resetSequences());
  assert.deepEqual(await upgraded.prepare('SELECT * FROM users').all(), users);
  assert.equal((await upgraded.prepare('SELECT token FROM sessions').get()).token, 'synthetic-session');
  assert.equal((await upgraded.prepare('SELECT snapshot FROM material_stock_movements WHERE id=9').get()).snapshot, snapshot);
  assert.deepEqual(await upgraded.prepare('SELECT remark,origin,merged_into,spec FROM material_catalog WHERE id=8').get(), { remark: '', origin: 'manual', merged_into: null, spec: '旧  规格' });
  assert.deepEqual(await upgraded.prepare('SELECT manufacturer,note,qty_m,amount_cents FROM material_stock_movements WHERE id=9').get(), { manufacturer: '', note: '', qty_m: 1000, amount_cents: 1234 });
  assert.equal((await upgraded.prepare('SELECT manufacturer FROM material_request_items WHERE id=5').get()).manufacturer, '');
  assert.equal((await upgraded.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).n, migrations.length + 2);
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

test('the frozen 0.11.1 schema upgrades without renumbering masters, documents or historical stock snapshots', async t => {
  const database = await createTestDatabase(t), old = await database.open({ initialize: false });
  await old.transaction(() => old.exec(fs.readFileSync(path.join(__dirname, 'fixtures/schema-0.11.1.sql'), 'utf8')));
  const snapshot = '{ "catalogId": 8, "name": "合成旧物资", "spec": "旧规格", "unit": "瓶" }';
  await old.transaction(async () => {
    await old.exec(`INSERT INTO users(id,username,password,display_name,role) VALUES(7,'upgrade-0111','synthetic-hash','Upgrade','MATERIAL');
      INSERT INTO material_categories(id,name,created_by) VALUES(2,'合成分类',7);
      INSERT INTO material_regions(id,name,created_by) VALUES(3,'合成区域',7);
      INSERT INTO material_catalog(id,code,name,spec,unit,category_id,created_by,remark) VALUES(8,'MAT-OLD0111','合成旧物资','旧规格','瓶',2,7,'保留备注');
      INSERT INTO material_requests(id,no,title,created_by) VALUES(4,'WZ-OLD0111','旧申报',7);
      INSERT INTO material_openings(id,no,title,date,kind,created_by,created_at) VALUES(5,'QC-20261022-ABCDEF1234','旧期初','2026-10-22','opening',7,'2026-10-22T00:00:00.000Z');`);
    await old.prepare('INSERT INTO material_stock_movements(id,type,catalog_id,region_id,warehouse,qty_m,amount_cents,source_key,snapshot,date,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(9,'opening',8,3,'MAIN',2000,1234,'opening:legacy-0111',snapshot,'2026-10-22',7);
  });
  const upgraded = await database.open();
  assert.deepEqual(await upgraded.prepare('SELECT code,name,spec,unit,remark,active,cas_number FROM material_catalog WHERE id=8').get(), {
    code: 'MAT-OLD0111', name: '合成旧物资', spec: '旧规格', unit: '瓶', remark: '保留备注', active: 1, cas_number: ''
  });
  assert.equal((await upgraded.prepare('SELECT no FROM material_requests WHERE id=4').get()).no, 'WZ-OLD0111');
  assert.equal((await upgraded.prepare('SELECT no FROM material_openings WHERE id=5').get()).no, 'QC-20261022-ABCDEF1234');
  assert.equal((await upgraded.prepare('SELECT snapshot FROM material_stock_movements WHERE id=9').get()).snapshot, snapshot);
  assert.deepEqual(await upgraded.prepare('SELECT cancelled_by,cancelled_at,cancel_reason FROM material_requests WHERE id=4').get(), { cancelled_by: null, cancelled_at: null, cancel_reason: '' });
  assert.equal((await upgraded.prepare('SELECT COUNT(*) AS n FROM material_number_allocations').get()).n, 0);
  assert.equal((await upgraded.prepare("SELECT COUNT(*) AS n FROM material_state WHERE key LIKE 'number_%'").get()).n, 8);
  assert.deepEqual(await applyMigrations(upgraded), []);
});

test('arrival migration retains legacy receipt facts and attachment parents without inventing delivery rounds', async t => {
  const database = await createTestDatabase(t), old = await database.open({ initialize: false });
  await old.transaction(() => old.exec(fs.readFileSync(path.join(__dirname, 'fixtures/schema-0.11.1.sql'), 'utf8')));
  const snapshot = '{ "name": "历史合成物资", "manufacturer": "原历史厂家" }';
  await old.transaction(async () => {
    await old.exec(`INSERT INTO users(id,username,password,display_name,role) VALUES(7,'arrival-upgrade','synthetic-hash','Upgrade','MATERIAL');
      INSERT INTO material_categories(id,name,created_by) VALUES(2,'合成分类',7);
      INSERT INTO material_regions(id,name,created_by) VALUES(3,'合成区域',7);
      INSERT INTO material_catalog(id,code,name,spec,unit,category_id,created_by) VALUES(8,'MAT-HISTORICAL','历史合成物资','规格','瓶',2,7);
      INSERT INTO material_requests(id,no,title,status,revision,created_by) VALUES(4,'WZ-HISTORICAL','历史申报','submitted',1,7);
      INSERT INTO material_request_items(id,request_id,catalog_id,name,spec,unit,category_id,region_id,warehouse,qty_m,author_id) VALUES(5,4,8,'历史合成物资','规格','瓶',2,3,'MAIN',1000,7);`);
    await old.prepare('INSERT INTO material_receipts(id,type,request_id,item_id,request_revision,snapshot,rejected_qty_m,rejected_reason,date,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(6, 'rejection', 4, 5, 1, snapshot, 1000, '历史破损', '2026-10-22', 7);
    await old.prepare('INSERT INTO material_attachments(id,receipt_id,name,mime_type,stored_name,size,actor_id) VALUES(?,?,?,?,?,?,?)')
      .run(9, 6, '历史合成附件.txt', 'text/plain', '00000000-0000-4000-8000-000000000000.bin', 1, 7);
  });
  const upgraded = await database.open();
  assert.equal((await upgraded.prepare('SELECT COUNT(*) AS n FROM material_arrivals').get()).n, 0);
  assert.deepEqual(await upgraded.prepare('SELECT snapshot,arrival_id,manufacturer_status,expected_manufacturer FROM material_receipts WHERE id=6').get(),
    { snapshot, arrival_id: null, manufacturer_status: 'legacy', expected_manufacturer: '' });
  assert.deepEqual(await upgraded.prepare('SELECT receipt_id,request_id,document_version_id,sha256 FROM material_attachments WHERE id=9').get(),
    { receipt_id: 6, request_id: null, document_version_id: null, sha256: '' });
  await assert.rejects(upgraded.prepare('UPDATE material_attachments SET request_id=4 WHERE id=9').run(), error => error.code === '23514');
  assert.deepEqual(await applyMigrations(upgraded), []);
});
