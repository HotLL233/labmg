const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { createTestDatabase } = require('./helpers/postgres');

test('moved entry serves assets and isolates normal, development and custom data', { timeout: 30000 }, async t => {
  const root = path.resolve(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const cache = path.join(root, 'artifacts/cache', version);
  fs.mkdirSync(cache, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(cache, 'smoke-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(cache));
    assert.ok(path.basename(fixture).startsWith('smoke-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  fs.cpSync(path.join(root, 'src'), path.join(fixture, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));

  for (const mode of [
    { name: 'normal', args: [], runtime: 'var' },
    { name: 'development', args: ['--dev'], runtime: `var/development/${version}` },
    { name: 'custom', args: ['--dev'], runtime: 'custom-runtime', override: true }
  ]) {
    const database = await createTestDatabase(t);
    const reservation = net.createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const env = { ...process.env, PORT: String(port), LABOS_ADMIN_USER: 'smoke-admin', LABOS_ADMIN_PASSWORD: 'smoke-password', DATABASE_URL: database.url };
    delete env.LABOS_RUNTIME_DIR;
    if (mode.override) env.LABOS_RUNTIME_DIR = mode.runtime;
    const child = spawn(process.execPath, [path.join(fixture, 'src/server.js'), ...mode.args], {
      cwd: cache, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    try {
      const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
      assert.match(String(output), /LabOS: http:\/\/127\.0\.0\.1:/, stderr);
      const base = `http://127.0.0.1:${port}`;
      for (const file of fs.readdirSync(path.join(fixture, 'src/public'))) {
        const response = await fetch(`${base}/${file}`);
        assert.equal(response.status, 200, file);
        await response.arrayBuffer();
      }
      const home = await fetch(base);
      assert.equal(home.status, 200);
      assert.match(await home.text(), /LabOS/);
      for (const [url, file, mime] of [
        ['/vendor/zxing-wasm/3.1.5/index.js', path.resolve(path.dirname(require.resolve('zxing-wasm/full/zxing_full.wasm')), '../iife/full/index.js'), 'text/javascript; charset=utf-8'],
        ['/vendor/zxing-wasm/3.1.5/zxing_full.wasm', require.resolve('zxing-wasm/full/zxing_full.wasm'), 'application/wasm']
      ]) {
        const resource = await fetch(base + url);
        assert.equal(resource.status, 200);
        assert.equal(resource.headers.get('content-type'), mime);
        const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
        assert.equal(hash(Buffer.from(await resource.arrayBuffer())), hash(fs.readFileSync(file)));
      }
      for (const url of ['/node_modules/zxing-wasm/package.json', '/vendor/zxing-wasm/3.1.5/package.json', '/vendor/zxing-wasm/3.1.5/%2e%2e%2fpackage.json']) {
        const response = await fetch(base + url);
        assert.equal(response.status, 404, url);
        await response.arrayBuffer();
      }
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: env.LABOS_ADMIN_USER, password: env.LABOS_ADMIN_PASSWORD })
      });
      assert.equal(login.status, 200, stderr);
      await login.json();
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const records = await fetch(`${base}/api/records?module=archives`, { headers: { Cookie: cookie } });
      assert.equal(records.status, 200);
      assert.ok((await records.json()).every(record => !record.title.startsWith('smoke-')), 'data leaked between modes');
      const created = await fetch(`${base}/api/records`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: 'archives', title: `smoke-${mode.name}` })
      });
      assert.equal(created.status, 201);
      await created.json();
      for (const directory of ['data', 'uploads', 'logs']) {
        assert.ok(fs.statSync(path.join(fixture, mode.runtime, directory)).isDirectory());
      }
      assert.equal(fs.existsSync(path.join(fixture, mode.runtime, 'data/labos.db')), false, 'PostgreSQL mode must not create a SQLite database');
      assert.equal(fs.existsSync(path.join(fixture, 'src/data')), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
    }
  }
});
