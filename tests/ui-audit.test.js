'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('UI audit accepts the micro badge token and rejects body or indirect small-font uses', t => {
  const root = path.resolve(__dirname, '..');
  const cache = path.join(root, 'artifacts/cache', require('../package.json').version);
  fs.mkdirSync(cache, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(cache, 'ui-audit-'));
  t.after(() => {
    assert.equal(path.dirname(fixture), cache);
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  fs.cpSync(path.join(root, 'src/public'), path.join(fixture, 'src/public'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/ui-audit.js'), path.join(fixture, 'scripts/ui-audit.js'));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
  const run = expected => {
    const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/ui-audit.js'), '--strict'], { encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    return result.stdout;
  };
  run(0);
  const extra = path.join(fixture, 'src/public/audit-case.css');
  fs.writeFileSync(extra, '.pill{font-size:var(--fs-micro)}');
  run(0);
  fs.writeFileSync(extra, '@media screen{.pill{font-size:var(--fs-micro)}}@supports (display:grid){@media screen{#app-version{font-size:var(--fs-micro)}}}');
  run(0);
  for (const css of ['p{font-size:var(--fs-micro)}', 'p{--body-size:var(--fs-micro)}', 'p{font-size:11px}',
    'p{font-size:var(--fs-micro,14px)}', 'p{--body-size:var(--fs-micro,14px);font-size:var(--body-size)}',
    'p{font-size:var(--missing,var(--fs-micro,14px))}', '@media screen{p{font-size:var(--fs-micro)}}']) {
    fs.writeFileSync(extra, css);
    assert.match(run(1), /FAIL.*(?:令牌字号|字号下限)/);
  }
});
