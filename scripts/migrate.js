'use strict';

const { openDatabase } = require('../src/database');

(async () => {
  const db = await openDatabase();
  try { console.log('数据库结构及迁移已就绪'); }
  finally { await db.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
