'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const createMaterials = require('../src/materials');

function fixture({ amount = true } = {}) {
  const identity = { catalog_id: 1, region_id: 1, warehouse: 'MAIN', batch: 'SYN-1', expiry_date: '' };
  const initial = { ...identity, id: 1, qty_m: 1000, amount_cents: 500, manufacturer: 'Synthetic manufacturer',
    note: '', snapshot: '{}', created_at: '2026-10-28T00:00:00.000Z' };
  const movements = [initial], reads = [], pending = [], response = {};
  let depth = 0, transactions = 0, locationReads = 0, scheduled = false, applied = 0, sheets;
  const quantity = () => movements.reduce((sum, row) => sum + row.qty_m, 0);
  const db = {
    async transaction(callback) {
      if (depth) return callback();
      transactions++;
      depth++;
      try { return await callback(); }
      finally {
        depth--;
        pending.splice(0).forEach(callback => callback());
      }
    },
    prepare(sql) {
      const query = sql.replace(/\s+/g, ' ').trim();
      const record = () => reads.push({ query, depth });
      return {
        async get() {
          record();
          if (query === 'SELECT * FROM material_catalog WHERE id=?') return { id: 1, category_id: 1, code: 'SYN-1',
            name: 'Synthetic stock', spec: '', unit: 'piece', active: 1, tracking_mode: 'quantity', remark: '' };
          if (query === 'SELECT * FROM material_categories WHERE id=?') return { id: 1, name: 'Synthetic category' };
          if (query.startsWith('SELECT * FROM material_stock_locations WHERE')) {
            locationReads++;
            return { location: 'Shelf-' + locationReads, version: locationReads };
          }
          if (query.startsWith('SELECT COUNT(*) AS total')) return { total: 1 };
          throw Error('Unexpected get: ' + query);
        },
        async all() {
          record();
          if (query.startsWith('WITH balances AS')) {
            const rows = [{ ...identity, qty_m: quantity(), amount_cents: quantity() / 2, first_id: 1,
              first_movement_at: initial.created_at, last_movement_at: initial.created_at, region_name: 'Synthetic region' }];
            if (!scheduled) {
              scheduled = true;
              const writer = () => { movements.push({ ...initial, id: 2 }); applied++; };
              if (depth) pending.push(writer); else writer();
            }
            return rows;
          }
          if (query.startsWith('SELECT catalog_id,SUM(qty_m) AS qty')) return [{ catalog_id: 1, qty: quantity() }];
          if (query.startsWith('SELECT * FROM material_stock_movements WHERE')) return movements.map(row => ({ ...row }));
          if (query === 'SELECT * FROM material_storage_places' || query.startsWith('SELECT location FROM material_stock_locations')) return [];
          throw Error('Unexpected all: ' + query);
        }
      };
    }
  };
  const materials = createMaterials({
    db, body: async () => ({}), uploads: '', log: async () => {},
    fail: (status, message) => Object.assign(Error(message), { status }),
    send: (_res, status, data) => Object.assign(response, { status, data }),
    hasPermission: (_user, permission) => amount || permission !== 'materials.amount.read',
    writeXlsx: value => {
      sheets = value;
      return { toBuffer: async () => Buffer.from('synthetic workbook') };
    }
  });
  response.writeHead = status => { response.status = status; };
  response.end = value => { response.buffer = value; };
  return {
    read: route => materials.handle({ method: 'GET' }, response, new URL('http://localhost/api/materials' + route),
      { id: 1, role: 'MATERIAL' }),
    response, reads, quantity,
    state: () => ({ transactions, locationReads, applied, sheets })
  };
}

test('stock detail reads keep batch, catalog total and manufacturer balance in one transaction', async () => {
  const f = fixture();
  await f.read('/stock/batches?detail=1');
  assert.equal(f.response.status, 200);
  assert.equal(f.response.data.items.length, 1);
  assert.equal(f.response.data.items[0].qtyM, 1000);
  assert.equal(f.response.data.items[0].totalQtyM, 1000);
  assert.equal(f.response.data.items[0].amountCents, 500);
  assert.equal(f.response.data.items[0].location, 'Shelf-1');
  assert.equal(f.response.data.items[0].locationVersion, 1);
  assert.ok(f.reads.every(row => row.depth === 1), 'all detail reads must hold the existing write lock');
  assert.equal(f.state().transactions, 1);
  assert.equal(f.state().locationReads, 1);
  assert.equal(f.state().applied, 1, 'the competing write must run after the detail transaction');
  assert.equal(f.quantity(), 2000);
  await f.read('/stock/batches?detail=1');
  assert.equal(f.response.data.items[0].qtyM, 2000);
  assert.equal(f.response.data.items[0].totalQtyM, 2000);
});

test('batch stock pairs the displayed location with the version from that same read', async () => {
  const f = fixture();
  await f.read('/stock/batches');
  assert.equal(f.response.data.items[0].location, 'Shelf-1');
  assert.equal(f.response.data.items[0].locationVersion, 1);
  assert.equal(f.state().locationReads, 1);
});

test('stock workbook summary and manufacturer detail use the same transaction', async () => {
  const f = fixture({ amount: false });
  await f.read('/export.xlsx?type=stock');
  assert.equal(f.response.status, 200);
  const [summary, batches] = f.state().sheets;
  assert.equal(summary.data[1][6].value, 1);
  assert.equal(batches.data[1][2].value, 1);
  assert.equal(f.state().transactions, 1, 'nested stockDetails must reuse the export transaction');
  assert.equal(f.quantity(), 2000);
  assert.ok(f.reads.filter(row => row.query.startsWith('WITH balances AS')).every(row => row.depth === 1));
});
