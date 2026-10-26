const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('syntax checking visits every source directory without executing files and rejects malformed JavaScript', t => {
  const root = path.resolve(__dirname, '..');
  const version = require('../package.json').version;
  const cache = path.join(root, 'artifacts/cache', version);
  fs.mkdirSync(cache, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(cache, 'check-test-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const directory of ['src/nested', 'scripts', 'tests']) fs.mkdirSync(path.join(fixture, directory), { recursive: true });
  const script = path.join(fixture, 'scripts/check.js');
  fs.copyFileSync(path.join(root, 'scripts/check.js'), script);
  const files = ['src/canary.js', 'src/nested/module.js', 'tests/probe.js'];
  const sources = ['#!/usr/bin/env node\nthrow new Error("Syntax checks must not execute files");', 'export const value = 1;', 'const value = 1;'];
  files.forEach((file, index) => fs.writeFileSync(path.join(fixture, file), sources[index]));
  fs.writeFileSync(path.join(fixture, 'src/ignored.txt'), 'const invalid = ;');
  const run = () => {
    const result = spawnSync(process.execPath, [script], { cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.ifError(result.error);
    return result;
  };
  const valid = run();
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.match(valid.stdout, /Syntax checked 4 JavaScript files\./);
  for (const [index, file] of files.entries()) {
    fs.writeFileSync(path.join(fixture, file), 'const invalid = ;');
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /SyntaxError/);
    assert.ok(invalid.stderr.includes(path.basename(file)), invalid.stderr);
    assert.doesNotMatch(invalid.stdout, /Syntax checked/);
    fs.writeFileSync(path.join(fixture, file), sources[index]);
  }
});
