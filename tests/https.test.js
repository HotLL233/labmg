const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const available = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });

test('optional HTTPS Compose requires an explicit host and preserves the original app storage and HTTP port', {
  skip: available.error?.code === 'ENOENT' ? 'Docker CLI is not installed' : false
}, t => {
  assert.ifError(available.error);
  assert.equal(available.status, 0, available.stderr);
  const cache = path.join(root, 'artifacts/cache', require('../package.json').version);
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'https-config-'));
  t.after(() => {
    assert.equal(path.dirname(directory), cache);
    assert.ok(path.basename(directory).startsWith('https-config-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const file of ['docker-compose.yml', 'docker-compose.https.yml', 'Caddyfile']) fs.copyFileSync(path.join(root, 'deploy', file), path.join(directory, file));
  const envFile = path.join(directory, 'compose.env');
  fs.writeFileSync(envFile, '');
  function configure(overrides = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(LABOS_|COMPOSE_)/i.test(key)) delete env[key];
    Object.assign(env, { LABOS_IMAGE: 'labos:https-config-test' }, overrides);
    return spawnSync('docker', ['compose', '--project-name', 'labos-https-config', '--env-file', envFile,
      '-f', path.join(directory, 'docker-compose.yml'), '-f', path.join(directory, 'docker-compose.https.yml'),
      'config', '--format', 'json'], { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  }
  const missing = configure();
  assert.ifError(missing.error); assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /LABOS_HTTPS_HOST/);
  for (const overrides of [
    { LABOS_HTTPS_HOST: '192.0.2.10' },
    { LABOS_HTTPS_HOST: 'nas.example.test', LABOS_HTTPS_PORT: '9443', LABOS_PORT: '3456', LABOS_DATA_DIR: path.join(directory, 'original-data'), LABOS_IMAGE: 'labos:upgrade-config-test' }
  ]) {
    const result = configure(overrides);
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout), proxy = config.services['labos-https'];
    assert.equal(proxy.image, 'caddy:2.11.7-alpine');
    assert.equal(proxy.environment.LABOS_HTTPS_HOST, overrides.LABOS_HTTPS_HOST);
    assert.equal(proxy.ports[0].target, 443);
    assert.equal(String(proxy.ports[0].published), overrides.LABOS_HTTPS_PORT || '8443');
    assert.equal(String(config.services.labos.ports[0].published), overrides.LABOS_PORT || '3000');
    assert.equal(config.services.labos.image, overrides.LABOS_IMAGE || 'labos:https-config-test');
    for (const service of ['labos', 'labos-init']) {
      assert.equal(path.resolve(config.services[service].volumes[0].source), overrides.LABOS_DATA_DIR || path.join(directory, 'runtime'));
    }
    const configuration = proxy.volumes.find(volume => volume.target === '/etc/caddy/Caddyfile');
    assert.equal(path.resolve(configuration.source), path.join(directory, 'Caddyfile'));
    assert.equal(configuration.read_only, true);
    assert.equal(configuration.bind.create_host_path, false);
    for (const name of ['data', 'config']) assert.equal(path.resolve(proxy.volumes.find(volume => volume.target === '/' + name).source), path.join(directory, 'https', name));
  }
  for (const name of ['runtime', 'https', 'original-data']) assert.equal(fs.existsSync(path.join(directory, name)), false, 'config parsing must not create data or certificates');
});
