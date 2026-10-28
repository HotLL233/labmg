'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const publicDir = path.join(__dirname, '../src/public');

function exporterFixture(script) {
  const nodes = new Map(), downloads = [];
  const node = () => ({ style: {}, querySelectorAll: () => [], click() {} });
  const document = {
    head: { appendChild() {}, insertAdjacentHTML() {} },
    createElement: node,
    querySelector: selector => {
      if (!nodes.has(selector)) nodes.set(selector, node());
      return nodes.get(selector);
    },
    querySelectorAll: () => []
  };
  const context = vm.createContext({
    document, window: {}, login: {}, Blob,
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:csv-test'; } }
  });
  for (const filename of ['csv.js', 'app.js', ...(script ? [script] : [])]) {
    const filenamePath = path.join(publicDir, filename);
    if (filename === 'csv.js' && !fs.existsSync(filenamePath)) continue;
    vm.runInContext(fs.readFileSync(filenamePath, 'utf8'), context, { filename });
  }
  return { context, nodes, downloads };
}

const exporters = [
  { name: 'generic records', run: 'csv()' },
  { name: 'archives', script: 'archive.js', run: 'renderArchives(); document.querySelector("#archive-export").onclick()' },
  { name: 'assets', script: 'asset.js', run: 'exportAssets(items)' },
  { name: 'contracts', script: 'contract.js', run: 'exportContracts(items)' },
  { name: 'quality', script: 'quality.js', run: 'exportQuality(items)' }
];

for (const exporter of exporters) {
  test(`${exporter.name} CSV export protects formula text and retains zero and false`, async () => {
    const app = exporterFixture(exporter.script);
    app.context.rows = [
      { title: '=1+1', code: 'comma,"quoted"', data: {} },
      { title: 0, code: false, status: false, owner: 0, due_date: false, data: {} }
    ];
    vm.runInContext(`items=rows; current='archives'; ${exporter.run}`, app.context);
    assert.equal(app.downloads.length, 1);
    const text = Buffer.from(await app.downloads[0].arrayBuffer()).toString('utf8');
    assert.ok(text.startsWith('\uFEFF'));
    assert.ok(text.includes('\n"\t=1+1","comma,""quoted"""'), text);
    assert.ok(text.includes('\n"0","false",'), text);
  });
}

test('audit CSV export protects async audit data and retains numeric identifiers', async () => {
  const app = exporterFixture('audit.js'), requests = [];
  const rows = [
    { id: 1, created_at: '2026-10-28', display_name: '=1+1', action: 'read', entity: 'records', entity_id: 0, detail: ' @SUM(A1)' },
    { id: 2, created_at: '2026-10-28', display_name: "'=literal", action: 'read', entity: 'records', entity_id: -2, detail: false }
  ];
  app.context.fetch = async url => {
    requests.push(url);
    return { ok: true, json: async () => rows };
  };
  vm.runInContext("current='audit'", app.context);
  await vm.runInContext('renderAudit()', app.context);
  assert.deepEqual(requests, ['/api/audit']);
  app.nodes.get('#audit-export').onclick();
  assert.equal(app.downloads.length, 1);
  const text = Buffer.from(await app.downloads[0].arrayBuffer()).toString('utf8');
  assert.ok(text.includes('\n"2026-10-28","\t=1+1","read","records","0","\t @SUM(A1)"'), text);
  assert.ok(text.includes('\n"2026-10-28","\'=literal","read","records","-2","false"'), text);
});

test('CSV cell quoting preserves scalar values and literal apostrophes', () => {
  const { cell } = require('../src/public/csv');
  for (const [value, expected] of [
    [null, '""'], [undefined, '""'], ['', '""'], [0, '"0"'], [false, '"false"'],
    [-12.5, '"-12.5"'], [true, '"true"'], ["'=1+1", '"\'=1+1"'],
    ['a,"b"\nc', '"a,""b""\nc"']
  ]) assert.equal(cell(value), expected);
});

test('CSV cell guards dangerous strings after whitespace and control prefixes', () => {
  const { cell } = require('../src/public/csv');
  for (const value of [
    '=1+1', '+SUM(A1)', '-12.5', '@SUM(A1)', ' =1+1', '\u00A0+1',
    '\ttext', '\rtext', '\ntext', '\0text', ' \t=1+1', '\0 \r-1', '\u0001=1',
    '\uFF1D1+1', '\uFF0B1', '\uFF0D1', '\uFF20SUM(A1)'
  ]) assert.equal(cell(value), `"\t${value}"`, JSON.stringify(value));
  for (const value of ['ordinary', 'a=1', 'comma,=1', 'safe\n=1', " '=1", '  ordinary']) {
    assert.equal(cell(value), `"${value}"`, JSON.stringify(value));
  }
  assert.equal(cell(['=1+1']), '"\t=1+1"');
  assert.equal(cell({ toString: () => '@formula' }), '"\t@formula"');
});

test('browser CSV helper loads before every caller without reordering existing scripts', () => {
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const scripts = [...index.matchAll(/<script src="\/([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, [
    'workspace.js', 'csv.js', 'app.js', 'material-scan.js', 'material-labels.js', 'material-original.js',
    'material-acceptance.js', 'material.js', 'permission.js', 'archive.js', 'audit.js', 'datahub.js',
    'asset.js', 'contract.js', 'quality.js'
  ]);
});
