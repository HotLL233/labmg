const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { test } = require('node:test');

const execute = promisify(execFile);
const image = process.env.LABOS_DOCKER_IMAGE;

test('Docker image runs without root and persists records and attachments across container recreation', {
  skip: image ? false : 'set LABOS_DOCKER_IMAGE to test a locally built image', timeout: 120000
}, async () => {
  const root = path.resolve(__dirname, '..');
  const version = require('../package.json').version;
  const cache = path.join(root, 'artifacts/cache', version);
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'docker-test-'));
  const runtime = path.join(directory, 'runtime');
  fs.mkdirSync(runtime);
  fs.chmodSync(runtime, 0o777);
  const runId = crypto.randomBytes(8).toString('hex');
  const names = [];
  const docker = async args => (await execute('docker', args, { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const inspect = async name => JSON.parse(await docker(['inspect', name]))[0];
  const pause = () => new Promise(resolve => setTimeout(resolve, 500));
  const request = async (base, route, options = {}, expected = 200) => {
    const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, expected, `${route}: ${await response.clone().text()}`);
    return response;
  };
  const login = async base => {
    const response = await request(base, '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'docker-test-admin', password: 'docker-test-password' })
    });
    await response.json();
    return response.headers.get('set-cookie').split(';')[0];
  };
  try {
    const metadata = JSON.parse(await docker(['image', 'inspect', image]))[0];
    assert.ok(metadata.Config.User, 'image must declare its default user');
    assert.ok(!['root', '0'].includes(metadata.Config.User.split(':')[0]), 'image must not default to root');
    assert.ok(metadata.Config.Healthcheck?.Test, 'image must declare a health check');
    const start = async suffix => {
      const name = `labos-docker-test-${runId}-${suffix}`;
      names.push(name);
      await docker(['run', '--detach', '--pull=never', '--name', name, '--label', `labos.test=${runId}`,
        '--platform', `${metadata.Os}/${metadata.Architecture}`, '--publish', '127.0.0.1::3000',
        '--health-interval', '1s', '--health-start-period', '0s',
        '--mount', `type=bind,source=${runtime},target=/var/lib/labos`,
        '--env', 'LABOS_ADMIN_USER=docker-test-admin', '--env', 'LABOS_ADMIN_PASSWORD=docker-test-password', image]);
      const until = Date.now() + 30000;
      let state;
      do {
        state = (await inspect(name)).State;
        if (state.Health?.Status === 'healthy') break;
        if (!state.Running) assert.fail(`container exited: ${await docker(['logs', name])}`);
        await pause();
      } while (Date.now() < until);
      assert.equal(state.Health?.Status, 'healthy', 'container never became healthy');
      assert.notEqual(await docker(['exec', name, 'node', '-p', 'process.getuid()']), '0');
      const binding = await docker(['port', name, '3000/tcp']);
      assert.match(binding, /^127\.0\.0\.1:\d+$/);
      return { name, base: `http://${binding}` };
    };
    const first = await start('first');
    const health = await request(first.base, '/api/auth/me');
    assert.deepEqual(await health.json(), { user: null });
    const cookie = await login(first.base);
    const title = `docker persistence ${runId}`;
    const created = await request(first.base, '/api/records', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ module: 'archives', title })
    }, 201);
    const record = await created.json();
    const content = `attachment ${runId}`;
    const uploaded = await request(first.base, '/api/files', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_id: record.id, name: 'docker-fixture.txt', type: 'text/plain', content: Buffer.from(content).toString('base64') })
    }, 201);
    const file = await uploaded.json();
    await docker(['stop', '--time', '10', first.name]);
    await docker(['rm', first.name]);
    names.splice(names.indexOf(first.name), 1);
    const second = await start('second');
    const secondCookie = await login(second.base);
    const records = await request(second.base, '/api/records?module=archives', { headers: { Cookie: secondCookie } });
    assert.ok((await records.json()).some(row => row.id === record.id && row.title === title));
    const files = await request(second.base, `/api/files?record_id=${record.id}`, { headers: { Cookie: secondCookie } });
    assert.ok((await files.json()).some(row => row.id === file.id && row.original_name === 'docker-fixture.txt'));
    const downloaded = await request(second.base, `/api/files/${file.id}/download`, { headers: { Cookie: secondCookie } });
    assert.equal(await downloaded.text(), content);
    assert.ok(fs.existsSync(path.join(runtime, 'data/labos.db')));
  } finally {
    const cleanupErrors = [];
    for (const name of names) {
      try {
        const found = await docker(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
        if (!found) continue;
        assert.equal(found, name);
        const container = await inspect(name);
        assert.equal(container.Config.Labels['labos.test'], runId, 'refusing to remove an unrelated container');
        await docker(['rm', '--force', name]);
      } catch (error) { cleanupErrors.push(error); }
    }
    if (!cleanupErrors.length) {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(cache));
      assert.ok(path.basename(directory).startsWith('docker-test-'));
      fs.rmSync(directory, { recursive: true, force: true });
    }
    assert.equal(cleanupErrors.length, 0, 'test container cleanup failed; fixture directory was retained');
  }
});
