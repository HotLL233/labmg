const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('runtime initializer rejects invalid IDs before any filesystem operation', () => {
  const helper = path.resolve(__dirname, '../src/init-runtime.js');
  const guardedRun = `
    const fs = require('node:fs');
    const source = fs.readFileSync(process.argv[1], 'utf8');
    const guardedFs = new Proxy(fs, {
      get(target, name) {
        if (name === 'constants') return target.constants;
        if (name === 'promises') return guardedFs;
        console.error('Unexpected filesystem operation before ID validation');
        process.exit(97);
      }
    });
    new Function('require', source)(name =>
      ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].includes(name) ? guardedFs : require(name));
  `;
  for (const name of ['LABOS_UID', 'LABOS_GID']) {
    for (const value of ['', '0', '-1', '+1', '1.5', '1e3', 'NaN', 'Infinity', '2147483648', ' 1000', '1000 ', '01', 'user']) {
      const env = { ...process.env, LABOS_UID: '1000', LABOS_GID: '1000', [name]: value };
      delete env.NODE_OPTIONS;
      const result = spawnSync(process.execPath, ['-e', guardedRun, helper], {
        env, encoding: 'utf8', windowsHide: true, timeout: 5000
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, `${name}=${JSON.stringify(value)}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`${name} must be an integer between 1 and 2147483647`));
      assert.equal(result.stdout, '');
    }
  }
});
