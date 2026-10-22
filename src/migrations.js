'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function applyMigrations(db, directory = path.join(__dirname, '..', 'migrations')) {
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.sql')).sort();
  if (!files.length) throw new Error('数据库迁移目录为空');
  const versions = new Set();
  for (const file of files) {
    const version = /^(\d{4})-[a-z0-9-]+\.sql$/.exec(file)?.[1];
    if (!version || versions.has(version)) throw new Error(`数据库迁移文件名或版本重复：${file}`);
    versions.add(version);
  }
  const applied = [];
  for (const file of files) {
    try {
      await db.transaction(async () => {
        if (await db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(file)) return;
        await db.exec(fs.readFileSync(path.join(directory, file), 'utf8'));
        await db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(file);
        applied.push(file);
      });
    } catch (error) {
      throw new Error(`数据库迁移失败：${file}（${error.code || error.name}）`, { cause: error });
    }
  }
  return applied;
}

module.exports = { applyMigrations };
