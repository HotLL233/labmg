'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

async function createTestDatabase(t) {
  const address = process.env.LABOS_TEST_DATABASE_URL;
  assert.ok(address, 'PostgreSQL tests require LABOS_TEST_DATABASE_URL pointing to a dedicated test server');
  const name = 'labos_test_' + crypto.randomBytes(12).toString('hex');
  const administrator = new Client({ connectionString: address });
  await administrator.connect();
  await administrator.query(`CREATE DATABASE "${name}"`);
  const url = new URL(address);
  url.pathname = '/' + name;
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    try { await administrator.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await administrator.end(); }
  });
  return {
    url: url.href,
    async open(options = {}) {
      const db = await require('../../src/database').openDatabase({ ...options, connectionString: url.href });
      clients.push(db);
      return db;
    }
  };
}

module.exports = { createTestDatabase };
