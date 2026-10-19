const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const available = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });

test('Compose keeps runtime beside the YML across image and project changes and supports an existing data directory', {
  skip: available.error?.code === 'ENOENT' ? 'Docker CLI is not installed' : false
}, t => {
  assert.ifError(available.error);
  assert.equal(available.status, 0, available.stderr);
  const cache = path.join(root, 'artifacts/cache', require('../package.json').version);
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'compose-config-'));
  const composeFile = path.join(directory, 'docker-compose.yml');
  const envFile = path.join(directory, 'compose.env');
  fs.copyFileSync(path.join(root, 'deploy/docker-compose.yml'), composeFile);
  assert.equal((fs.readFileSync(composeFile, 'utf8').match(/create_host_path: true/g) || []).length, 4);
  fs.writeFileSync(envFile, '');
  t.after(() => {
    assert.equal(path.dirname(directory), cache);
    assert.ok(path.basename(directory).startsWith('compose-config-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = (project, overrides = {}) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(LABOS_|COMPOSE_)/i.test(key)) delete env[key];
    Object.assign(env, { LABOS_DATA_DIR: '', LABOS_IMAGE: '' }, overrides);
    const result = spawnSync('docker', [
      'compose', '--project-name', project, '--file', composeFile, '--env-file', envFile, 'config', '--format', 'json'
    ], { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const check = (configuration, source) => {
    for (const service of ['labos-init', 'labos']) {
      const mounts = configuration.services[service].volumes;
      assert.equal(mounts.length, 1);
      assert.equal(mounts[0].type, 'bind');
      assert.equal(path.resolve(mounts[0].source), source);
      assert.equal(mounts[0].target, '/var/lib/labos');
      // Compose 5 omits the true default from normalized config output.
      assert.notEqual(mounts[0].bind?.create_host_path, false);
    }
    assert.deepEqual(Object.keys(configuration.volumes || {}), []);
    const postgres = configuration.services.postgres;
    assert.equal(postgres.image, 'postgres:17-bookworm');
    assert.equal(postgres.ports, undefined, 'Database must stay on the internal Compose network');
    assert.equal(postgres.environment.POSTGRES_PASSWORD_FILE, '/run/labos-secrets/postgres-password');
    assert.equal(path.resolve(postgres.volumes[0].source), path.join(source, 'postgres'));
    assert.equal(path.resolve(postgres.volumes[1].source), path.join(source, 'secrets'));
    assert.equal(postgres.volumes[1].read_only, true);
    assert.equal(configuration.services.labos.depends_on.postgres.condition, 'service_healthy');
  };
  const first = config('labos-config-first');
  check(first, path.join(directory, 'runtime'));
  const upgraded = config('labos-config-first', { LABOS_IMAGE: 'labos:upgrade-config-test' });
  check(upgraded, path.join(directory, 'runtime'));
  assert.equal(upgraded.services.labos.image, 'labos:upgrade-config-test');
  assert.equal(upgraded.services['labos-init'].image, 'labos:upgrade-config-test');
  check(config('labos-config-renamed'), path.join(directory, 'runtime'));
  check(config('labos-config-custom', { LABOS_DATA_DIR: path.join(directory, 'existing-runtime') }), path.join(directory, 'existing-runtime'));
  assert.equal(fs.existsSync(path.join(directory, 'runtime')), false, 'config validation must not create runtime data');
});
