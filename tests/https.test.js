const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const available = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });

test('both complete Compose files default to host-network discovery and a generated read-only HTTPS configuration', {
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
  function configure(fixture, overrides = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(LABOS_|COMPOSE_)/i.test(key)) delete env[key];
    Object.assign(env, overrides);
    const result = spawnSync('docker', ['compose', '--project-name', 'labos-https-config',
      '-f', path.join(fixture, 'docker-compose.yml'), 'config', '--format', 'json'],
    { cwd: fixture, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /variable is not set/i, 'Compose must preserve the Caddy variables for the container');
    return JSON.parse(result.stdout);
  }
  const check = (configuration, fixture, host, overrides = {}) => {
    const init = configuration.services['labos-init'];
    const proxy = configuration.services['labos-https'];
    assert.equal(init.network_mode, 'host');
    assert.equal(init.ports, undefined, 'the one-shot initializer must not expose a listener');
    assert.equal(init.environment.LABOS_HTTPS_HOST, host);
    assert.equal(proxy.image, 'caddy:2.11.7-alpine');
    assert.equal(proxy.environment.LABOS_HTTPS_HOST, undefined, 'only init resolves the host');
    assert.equal(proxy.environment.XDG_DATA_HOME, '/var/lib/labos-https/data');
    assert.equal(proxy.environment.XDG_CONFIG_HOME, '/var/lib/labos-https/config');
    assert.equal(proxy.ports[0].target, 443);
    assert.equal(String(proxy.ports[0].published), overrides.LABOS_HTTPS_PORT || '8443');
    assert.equal(String(configuration.services.labos.ports[0].published), overrides.LABOS_PORT || '3000');
    assert.equal(proxy.depends_on.labos.condition, 'service_started');
    assert.equal(proxy.depends_on['labos-init'].condition, 'service_completed_successfully');
    for (const service of ['labos', 'labos-init']) {
      assert.equal(path.resolve(configuration.services[service].volumes[0].source), overrides.LABOS_DATA_DIR || path.join(fixture, 'runtime'));
    }
    assert.equal(proxy.volumes.length, 2, 'Caddy preserves its CA and separately reads init output');
    const certificates = proxy.volumes.find(mount => mount.target === '/var/lib/labos-https');
    assert.equal(certificates.type, 'bind');
    assert.equal(path.resolve(certificates.source), path.join(fixture, 'https'));
    const generated = proxy.volumes.find(mount => mount.target === '/etc/labos-https');
    assert.equal(generated.type, 'bind');
    assert.equal(path.resolve(generated.source), path.join(overrides.LABOS_DATA_DIR || path.join(fixture, 'runtime'), 'https-config'));
    assert.equal(generated.read_only, true);
    assert.equal(proxy.entrypoint ?? undefined, undefined, 'use the official image without a shell wrapper');
    assert.deepEqual(proxy.command, ['caddy', 'run', '--config', '/etc/labos-https/Caddyfile', '--adapter', 'caddyfile']);
  };
  for (const [kind, name] of [['online', 'docker-compose.yml'], ['local', 'docker-compose.local.yml']]) {
    const fixture = path.join(directory, kind);
    fs.mkdirSync(fixture);
    const composeFile = path.join(fixture, 'docker-compose.yml');
    const source = fs.readFileSync(path.join(root, 'deploy', name), 'utf8');
    assert.equal((source.match(/^\s+LABOS_HTTPS_HOST:\s*"\$\{LABOS_HTTPS_HOST:-auto\}"/gm) || []).length, 1, 'automatic discovery must be the default in one place');
    assert.doesNotMatch(source, /^\s*(?:configs|include|extends|env_file):/m);
    assert.match(source, /^\s+- "\.\/https:\/var\/lib\/labos-https"$/m);
    fs.writeFileSync(composeFile, source);
    assert.deepEqual(fs.readdirSync(fixture), ['docker-compose.yml']);
    check(configure(fixture), fixture, 'auto');
    for (const [host, overrides] of [
      ['192.0.2.10', {}],
      ['nas.example.test', { LABOS_HTTPS_PORT: '9443', LABOS_PORT: '3456', LABOS_DATA_DIR: path.join(directory, 'original-data'), LABOS_UID: '12345', LABOS_GID: '23456' }]
    ]) {
      fs.writeFileSync(composeFile, source.replace(/(^\s+LABOS_HTTPS_HOST:\s*"\$\{LABOS_HTTPS_HOST:-)auto(\}")/m, (_, prefix, suffix) => prefix + host + suffix));
      check(configure(fixture, overrides), fixture, host, overrides);
    }
    check(configure(fixture, { LABOS_HTTPS_HOST: 'override.example.test' }), fixture, 'override.example.test');
    check(configure(fixture, { LABOS_HTTPS_HOST: '0.0.0.0' }), fixture, '0.0.0.0');
    assert.deepEqual(fs.readdirSync(fixture), ['docker-compose.yml'], 'parsing must not create certificates, data, .env or a Caddyfile');
  }
  assert.equal(fs.existsSync(path.join(directory, 'original-data')), false);
});
