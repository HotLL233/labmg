'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const { Pool, types } = require('pg');
const { SCHEMA, TABLES, ID_TABLES } = require('./schema');

const context = new AsyncLocalStorage();
const identityTables = new Set(ID_TABLES);

function safeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('数据库整数超出 JavaScript 安全范围');
  return number;
}

// Only tokens outside strings, identifiers and comments may be rewritten.
function sqlTokens(sql) {
  const result = [];
  for (let index = 0; index < sql.length;) {
    const start = index, char = sql[index], next = sql[index + 1];
    if (char === "'" || char === '"') {
      index++;
      while (index < sql.length) {
        if (sql[index++] === char) {
          if (sql[index] === char) index++;
          else break;
        }
      }
      result.push({ kind: 'quoted', value: sql.slice(start, index) });
    } else if (char === '-' && next === '-') {
      index = sql.indexOf('\n', index + 2);
      if (index === -1) index = sql.length;
      result.push({ kind: 'comment', value: sql.slice(start, index) });
    } else if (char === '/' && next === '*') {
      index += 2;
      let depth = 1;
      while (index < sql.length && depth) {
        if (sql.slice(index, index + 2) === '/*') { depth++; index += 2; }
        else if (sql.slice(index, index + 2) === '*/') { depth--; index += 2; }
        else index++;
      }
      result.push({ kind: 'comment', value: sql.slice(start, index) });
    } else if (char === '$' && /^\$(?:[A-Za-z_][\w]*)?\$/.test(sql.slice(index))) {
      const delimiter = sql.slice(index).match(/^\$(?:[A-Za-z_][\w]*)?\$/)[0];
      const end = sql.indexOf(delimiter, index + delimiter.length);
      if (end === -1) throw new Error('SQL dollar quote 未闭合');
      index = end + delimiter.length;
      result.push({ kind: 'quoted', value: sql.slice(start, index) });
    } else if (/[A-Za-z_]/.test(char)) {
      index++;
      while (/[\w$]/.test(sql[index] || '') && index < sql.length) index++;
      result.push({ kind: 'word', value: sql.slice(start, index) });
    } else {
      index++;
      result.push({ kind: char === '?' ? 'parameter' : 'other', value: char });
    }
  }
  return result;
}

function compileSql(sql, { returningId = false } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL不能为空');
  const tokens = sqlTokens(sql);
  const significant = tokens.filter(token => token.kind !== 'comment' && token.value.trim());
  if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)$/i.test(significant[0]?.value || '')) {
    throw new Error('事务必须通过 db.transaction() 执行');
  }
  if (significant.at(-1)?.value === ';') tokens.splice(tokens.indexOf(significant.at(-1)), 1);
  const words = significant.filter(token => token.kind === 'word');
  let ignore = false;
  if (words[0]?.value.toUpperCase() === 'INSERT' && words[1]?.value.toUpperCase() === 'OR' && words[2]?.value.toUpperCase() === 'IGNORE') {
    tokens.splice(tokens.indexOf(words[2]), 1);
    tokens.splice(tokens.indexOf(words[1]), 1);
    ignore = true;
  }
  let parameter = 0;
  let text = tokens.map(token => token.kind === 'parameter' ? '$' + ++parameter : token.value).join('').trim();
  const hasReturning = words.some(token => token.value.toUpperCase() === 'RETURNING');
  if (ignore) {
    if (hasReturning) throw new Error('INSERT OR IGNORE不能同时指定RETURNING');
    text += '\nON CONFLICT DO NOTHING';
  }
  const into = words.findIndex(token => token.value.toUpperCase() === 'INTO');
  const table = into >= 0 ? words[into + 1]?.value : undefined;
  if (returningId && words[0]?.value.toUpperCase() === 'INSERT' && identityTables.has(table) && !hasReturning) text += '\nRETURNING id';
  return { text, parameterCount: parameter };
}

async function openDatabase({ connectionString = process.env.DATABASE_URL, initialize = true } = {}) {
  let connection;
  if (typeof connectionString === 'string' && connectionString.trim()) {
    let address;
    try { address = new URL(connectionString); } catch { throw new Error('PostgreSQL DATABASE_URL 无效'); }
    if (!['postgres:', 'postgresql:'].includes(address.protocol)) throw new Error('PostgreSQL DATABASE_URL 无效');
    connection = { connectionString };
  }
  else if (process.env.LABOS_DATABASE_PASSWORD_FILE && process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE) {
    const file = process.env.LABOS_DATABASE_PASSWORD_FILE;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024) throw new Error('PostgreSQL 密码文件无效');
    const password = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    if (!password || password.includes('\0')) throw new Error('PostgreSQL 密码文件无效');
    connection = { host: process.env.PGHOST, user: process.env.PGUSER, database: process.env.PGDATABASE, password };
  } else throw new Error('必须配置 PostgreSQL DATABASE_URL 或完整数据库密码文件设置；不会回退到 SQLite');
  const localTypes = { getTypeParser(oid, format) {
    if (oid === 20 || oid === 1700) return safeInteger;
    return types.getTypeParser(oid, format);
  } };
  const pool = new Pool({ ...connection, options: '-c timezone=UTC', max: 10, types: localTypes });
  pool.on('error', () => console.error('PostgreSQL 空闲连接断开'));
  const query = (text, values = []) => {
    const current = context.getStore();
    return (current?.db === db ? current.client : pool).query(text, values);
  };
  const db = {
    prepare(sql) {
      const compiled = compileSql(sql), runSql = compileSql(sql, { returningId: true });
      async function execute(compilation, values) {
        if (values.length !== compilation.parameterCount) throw new RangeError('SQL参数数量不匹配');
        return query(compilation.text, values);
      }
      return {
        async get(...values) { return (await execute(compiled, values)).rows[0]; },
        async all(...values) { return (await execute(compiled, values)).rows; },
        async run(...values) {
          const result = await execute(runSql, values);
          return { changes: result.rowCount || 0, lastInsertRowid: result.rows[0]?.id };
        }
      };
    },
    async exec(sql) { return query(compileSql(sql).text); },
    async transaction(callback) {
      if (context.getStore()?.db === db) return callback();
      const client = await pool.connect();
      const transaction = { db, client, rollback: [] };
      try {
        await client.query('BEGIN');
        // shortcut: one write lock serializes 10–30 operators; narrow locks after measured contention.
        await client.query('SELECT pg_advisory_xact_lock(1280262703,600)');
        const value = await context.run(transaction, callback);
        const committed = await client.query('COMMIT');
        if (committed.command !== 'COMMIT') throw new Error('数据库事务已回滚');
        return value;
      } catch (failure) {
        try { await client.query('ROLLBACK'); } catch { /* Keep the original failure. */ }
        for (const callback of transaction.rollback.reverse()) {
          try { await callback(); } catch { console.error('无法清理已回滚事务的附件'); }
        }
        throw failure;
      } finally { client.release(); }
    },
    afterRollback(callback) {
      const transaction = context.getStore();
      if (transaction?.db !== db || typeof callback !== 'function') throw new Error('回滚清理必须注册在 db.transaction() 内');
      transaction.rollback.push(callback);
    },
    async columns(table) {
      if (!TABLES.includes(table)) throw new Error('未知业务表');
      const result = await query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
        a.attnotnull AS notnull,pg_get_expr(d.adbin,d.adrelid) AS dflt_value,
        COALESCE((SELECT k.ordinality::integer FROM pg_index i,
          unnest(i.indkey) WITH ORDINALITY AS k(number,ordinality)
          WHERE i.indrelid=a.attrelid AND i.indisprimary AND k.number=a.attnum),0) AS pk
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE n.nspname=current_schema() AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [table]);
      return result.rows.map(row => ({ ...row, type: /^(?:bigint|integer|smallint)$/.test(row.type) ? 'INTEGER' : row.type === 'double precision' ? 'REAL' : 'TEXT', notnull: Number(row.notnull), pk: Number(row.pk) }));
    },
    async resetSequences(floors = {}) {
      for (const table of ID_TABLES) {
        const row = (await query(`SELECT COALESCE(MAX(id),0) AS maximum,
          pg_sequence_last_value(pg_get_serial_sequence('${table}','id')::regclass) AS sequence FROM "${table}"`)).rows[0];
        const next = Math.max(row.maximum, row.sequence || 0, floors[table] || 0) + 1;
        if (!Number.isSafeInteger(next) || next < 1) throw new RangeError('数据库序号超出安全范围');
        await query(`ALTER TABLE "${table}" ALTER COLUMN id RESTART WITH ${next}`);
      }
    },
    async close() { await pool.end(); }
  };
  try {
    await query('SELECT 1');
    if (initialize) await db.transaction(() => db.exec(SCHEMA));
    return db;
  } catch (failure) {
    await pool.end();
    throw failure;
  }
}

module.exports = { openDatabase, compileSql, safeInteger };
