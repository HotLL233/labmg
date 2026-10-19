const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const available = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });

test('both complete Compose files configure HTTPS from one inline host without external files', {
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
    const proxy = configuration.services['labos-https'];
    assert.equal(proxy.image, 'caddy:2.11.7-alpine');
    assert.equal(proxy.environment.LABOS_HTTPS_HOST, host);
    assert.equal(proxy.environment.XDG_DATA_HOME, '/var/lib/labos-https/data');
    assert.equal(proxy.environment.XDG_CONFIG_HOME, '/var/lib/labos-https/config');
    assert.equal(proxy.ports[0].target, 443);
    assert.equal(String(proxy.ports[0].published), overrides.LABOS_HTTPS_PORT || '8443');
    assert.equal(String(configuration.services.labos.ports[0].published), overrides.LABOS_PORT || '3000');
    assert.equal(proxy.depends_on.labos.condition, 'service_started');
    for (const service of ['labos', 'labos-init']) {
      assert.equal(path.resolve(configuration.services[service].volumes[0].source), overrides.LABOS_DATA_DIR || path.join(fixture, 'runtime'));
    }
    assert.equal(proxy.volumes.length, 1, 'Caddy must create its subdirectories within a single adjacent root bind');
    assert.equal(proxy.volumes[0].type, 'bind');
    assert.equal(path.resolve(proxy.volumes[0].source), path.join(fixture, 'https'));
    assert.equal(proxy.volumes[0].target, '/var/lib/labos-https');
    assert.deepEqual(proxy.entrypoint, ['/bin/sh', '-ec']);
    assert.equal(proxy.command.length, 1, 'the shell must receive the entire inline script as one argument');
    const command = proxy.command[0];
    assert.match(command, /case "\$\$LABOS_HTTPS_HOST" in/);
    assert.match(command, /""\|CHANGE_ME\|/);
    assert.match(command, /mkdir -p \/var\/lib\/labos-https\/data \/var\/lib\/labos-https\/config/);
    const heredoc = command.match(/cat > (\/tmp\/[A-Za-z0-9.-]+) <<'([A-Z_]+)'\n([\s\S]*?)\n\2\n/);
    assert.ok(heredoc, 'a quoted heredoc must preserve Caddy placeholders through shell execution');
    assert.match(heredoc[3], /^\s+default_sni \{\$\$LABOS_HTTPS_HOST\}$/m);
    assert.match(heredoc[3], /^https:\/\/\{\$\$LABOS_HTTPS_HOST\}:443 \{$/m);
    assert.match(heredoc[3], /^\s+tls internal$/m);
    assert.match(heredoc[3], /^\s+reverse_proxy labos:3000$/m);
    assert.doesNotMatch(heredoc[3], /(?<!\$)\$(?!\$)/, 'Caddy dollar signs must remain escaped in normalized Compose output');
    assert.ok(command.endsWith(`exec caddy run --config ${heredoc[1]} --adapter caddyfile\n`), 'exec must hand signals to the real Caddy process');
  };
  for (const [kind, name] of [['online', 'docker-compose.yml'], ['local', 'docker-compose.local.yml']]) {
    const fixture = path.join(directory, kind);
    fs.mkdirSync(fixture);
    const composeFile = path.join(fixture, 'docker-compose.yml');
    const source = fs.readFileSync(path.join(root, 'deploy', name), 'utf8');
    assert.equal((source.match(/^\s+LABOS_HTTPS_HOST:\s*"\$\{LABOS_HTTPS_HOST:-CHANGE_ME\}"/gm) || []).length, 1, 'only one inline host field should need editing');
    assert.doesNotMatch(source, /^\s*(?:configs|include|extends|env_file):/m);
    assert.match(source, /^\s+- "\.\/https:\/var\/lib\/labos-https"$/m);
    fs.writeFileSync(composeFile, source);
    assert.deepEqual(fs.readdirSync(fixture), ['docker-compose.yml']);
    check(configure(fixture), fixture, 'CHANGE_ME');
    for (const [host, overrides] of [
      ['192.0.2.10', {}],
      ['nas.example.test', { LABOS_HTTPS_PORT: '9443', LABOS_PORT: '3456', LABOS_DATA_DIR: path.join(directory, 'original-data'), LABOS_UID: '12345', LABOS_GID: '23456' }]
    ]) {
      fs.writeFileSync(composeFile, source.replace(/(^\s+LABOS_HTTPS_HOST:\s*"\$\{LABOS_HTTPS_HOST:-)CHANGE_ME(\}")/m, (_, prefix, suffix) => prefix + host + suffix));
      check(configure(fixture, overrides), fixture, host, overrides);
    }
    check(configure(fixture, { LABOS_HTTPS_HOST: 'override.example.test' }), fixture, 'override.example.test');
    assert.deepEqual(fs.readdirSync(fixture), ['docker-compose.yml'], 'parsing must not create certificates, data, .env or a Caddyfile');
  }
  assert.equal(fs.existsSync(path.join(directory, 'original-data')), false);
});
