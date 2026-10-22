const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const available = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });

test('online and local Compose files independently preserve PostgreSQL 18 runtime paths and deployment overrides', {
  skip: available.error?.code === 'ENOENT' ? 'Docker CLI is not installed' : false
}, t => {
  assert.ifError(available.error);
  assert.equal(available.status, 0, available.stderr);
  const cache = path.join(root, 'artifacts/cache', require('../package.json').version);
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'compose-config-'));
  t.after(() => {
    assert.equal(path.dirname(directory), cache);
    assert.ok(path.basename(directory).startsWith('compose-config-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const fixtures = new Map();
  for (const [kind, name] of [['online', 'docker-compose.yml'], ['local', 'docker-compose.local.yml']]) {
    const fixture = path.join(directory, kind);
    fs.mkdirSync(fixture);
    const composeFile = path.join(fixture, 'docker-compose.yml');
    const source = fs.readFileSync(path.join(root, 'deploy', name), 'utf8');
    assert.doesNotMatch(source, /^\s*(?:configs|include|extends|env_file|create_host_path):/m);
    fs.writeFileSync(composeFile, source);
    fixtures.set(kind, { fixture, composeFile });
    assert.deepEqual(fs.readdirSync(fixture), ['docker-compose.yml'], 'each deployment must parse with its YML alone');
  }
  const config = (kind, project, overrides = {}) => {
    const { fixture, composeFile } = fixtures.get(kind);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(LABOS_|COMPOSE_)/i.test(key)) delete env[key];
    Object.assign(env, { LABOS_DATA_DIR: '', LABOS_IMAGE: '' }, overrides);
    const result = spawnSync('docker', [
      'compose', '--project-name', project, '--file', composeFile, 'config', '--format', 'json'
    ], { cwd: fixture, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const version = require('../package.json').version;
  const check = (configuration, kind, source, overrides = {}) => {
    assert.deepEqual(Object.keys(configuration.services).sort(), ['labos', 'labos-https', 'labos-init', 'postgres']);
    assert.equal(configuration.configs, undefined);
    for (const service of ['labos-init', 'labos']) {
      const mounts = configuration.services[service].volumes;
      assert.equal(mounts.length, 1);
      assert.equal(mounts[0].type, 'bind');
      assert.equal(path.resolve(mounts[0].source), source);
      assert.equal(mounts[0].target, '/var/lib/labos');
      // Compose 5 omits the true default from normalized config output.
      assert.notEqual(mounts[0].bind?.create_host_path, false);
      assert.equal(configuration.services[service].image, kind === 'local' ? `labos:${version}` : overrides.LABOS_IMAGE || `ghcr.io/hotll233/labmg:${version}`);
    }
    assert.deepEqual(Object.keys(configuration.volumes || {}), []);
    const postgres = configuration.services.postgres;
    assert.equal(postgres.image, 'postgres:18-bookworm');
    assert.equal(postgres.ports, undefined, 'Database must stay on the internal Compose network');
    assert.equal(postgres.environment.PGDATA, '/var/lib/postgresql/18/docker');
    assert.equal(postgres.environment.POSTGRES_PASSWORD_FILE, '/run/labos-secrets/postgres-password');
    const database = postgres.volumes.find(mount => mount.target === '/var/lib/postgresql');
    assert.equal(database.type, 'bind');
    assert.equal(path.resolve(database.source), path.join(source, 'postgres'));
    assert.equal(postgres.volumes.length, 2, 'the PG18 parent bind must cover the entire official data tree');
    const secret = postgres.volumes.find(mount => mount.target === '/run/labos-secrets');
    assert.equal(path.resolve(secret.source), path.join(source, 'secrets'));
    assert.equal(secret.read_only, true);
    assert.equal(configuration.services.labos.depends_on.postgres.condition, 'service_healthy');
    assert.equal(postgres.depends_on['labos-init'].condition, 'service_completed_successfully');
    assert.equal(configuration.services.labos.user, `${overrides.LABOS_UID || '1000'}:${overrides.LABOS_GID || '1000'}`);
    assert.equal(configuration.services['labos-init'].user, '0:0');
    assert.equal(configuration.services['labos-init'].network_mode, 'host');
    assert.equal(configuration.services['labos-init'].environment.LABOS_HTTPS_HOST, overrides.LABOS_HTTPS_HOST || 'auto');
    assert.equal(configuration.services['labos-init'].environment.LABOS_UID, overrides.LABOS_UID || '1000');
    assert.equal(configuration.services['labos-init'].environment.LABOS_GID, overrides.LABOS_GID || '1000');
    assert.equal(String(configuration.services.labos.ports[0].published), overrides.LABOS_PORT || '3000');
    for (const service of Object.values(configuration.services)) {
      if (kind === 'local') assert.equal(service.pull_policy, 'never', 'local deployment must never pull an image');
      else assert.notEqual(service.pull_policy, 'never', 'online deployment must allow pulling its images');
    }
  };
  const sharedServices = configuration => Object.fromEntries(['labos-init', 'postgres', 'labos'].map(name => {
    const { image, pull_policy, volumes, ...service } = configuration.services[name];
    return [name, { ...service, volumes: volumes.map(mount => ({ ...mount, source: path.relative(directory, mount.source).replace(/^(online|local)[\\/]/, '') })) }];
  }));
  const defaults = [];
  for (const kind of fixtures.keys()) {
    const first = config(kind, 'labos-config-first');
    const source = path.join(fixtures.get(kind).fixture, 'runtime');
    check(first, kind, source);
    check(config(kind, 'labos-config-renamed'), kind, source);
    defaults.push(sharedServices(first));
    const overrides = { LABOS_DATA_DIR: path.join(directory, 'existing-runtime'), LABOS_IMAGE: 'labos:upgrade-config-test', LABOS_UID: '12345', LABOS_GID: '23456', LABOS_PORT: '3456' };
    check(config(kind, 'labos-config-custom', overrides), kind, overrides.LABOS_DATA_DIR, overrides);
    assert.deepEqual(fs.readdirSync(fixtures.get(kind).fixture), ['docker-compose.yml'], 'configuration parsing must not create data or external files');
  }
  assert.deepEqual(defaults[0], defaults[1], 'online and local deployments must preserve the same application and database settings');
  assert.equal(fs.existsSync(path.join(directory, 'existing-runtime')), false);
});
