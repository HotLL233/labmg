const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { selectHttpsHost, caddyfileForHost } = require('../src/https-config');

const address = (ip, overrides = {}) => ({ address: ip, family: 'IPv4', internal: false, ...overrides });
const route = (name, metric = 0, flags = '0003') => `${name}\t00000000\t0100000A\t${flags}\t0\t0\t${metric}\t00000000\t0\t0\t0`;

test('automatic HTTPS selects the host default route LAN IP and ignores container, loopback, VPN and link-local interfaces', () => {
  const interfaces = {
    lo: [address('127.0.0.1', { internal: true })], docker0: [address('172.17.0.1')],
    'br-abcd': [address('172.18.0.1')], veth123: [address('172.19.0.1')],
    tun0: [address('10.8.0.2')], tailscale0: [address('100.64.1.1')],
    eth0: [address('169.254.1.2'), address('192.168.9.2'), address('fe80::1', { family: 'IPv6' })],
    ovs_eth1: [address('172.28.10.200')], bond0: [address('10.20.0.3')]
  };
  const routes = [route('tun0', 0), route('docker0', 0), route('eth0', 500), route('ovs_eth1', 10), route('bond0', 100)].join('\n');
  for (const value of [undefined, '', 'auto', ' AUTO ', 'CHANGE_ME', '0.0.0.0']) {
    assert.deepEqual(selectHttpsHost(value, interfaces, routes), { host: '172.28.10.200', automatic: true, interface: 'ovs_eth1' });
  }
  assert.deepEqual(selectHttpsHost('auto', { br0: [address('192.168.1.8')] }, route('br0')), { host: '192.168.1.8', automatic: true, interface: 'br0' }, 'a real host LAN bridge must remain eligible');
  assert.equal(selectHttpsHost('auto', interfaces, [route('eth0', 0, '0000'), route('bond0', 20)].join('\n')).host, '10.20.0.3', 'a down default route is not eligible');
});

test('automatic HTTPS refuses ambiguous or absent LAN IPs instead of publishing a guessed certificate', () => {
  const two = { eth0: [address('192.168.1.2')], eth1: [address('10.0.0.2')] };
  assert.throws(() => selectHttpsHost('auto', two), /Cannot determine one HTTPS host IPv4.*eth0=192\.168\.1\.2.*eth1=10\.0\.0\.2/);
  assert.throws(() => selectHttpsHost('auto', two, route('eth0') + '\n' + route('eth1')), /Cannot determine one HTTPS host IPv4/);
  assert.throws(() => selectHttpsHost('auto', { eth0: [address('10.0.0.2'), address('10.0.0.3')] }, route('eth0')), /Cannot determine one HTTPS host IPv4/);
  assert.throws(() => selectHttpsHost('auto', { lo: [address('127.0.0.1')], docker0: [address('172.17.0.1')] }), /\(none\)/);
  assert.equal(selectHttpsHost('auto', { eth0: [address('203.0.113.2')], eth1: [address('192.168.1.2')] }).host, '192.168.1.2', 'private LAN addresses are preferred when the route file is unavailable');
  assert.equal(selectHttpsHost('auto', { eth0: [address('192.168.1.2')], ovs_eth0: [address('192.168.1.2')] }, route('ovs_eth0')).interface, 'ovs_eth0', 'duplicate IP aliases must retain their default route interface');
});

test('explicit HTTPS host validation permits a test loopback override and refuses injected, wildcard or malformed names', () => {
  for (const host of ['172.28.10.200', '127.0.0.1', 'nas.example.test', 'nas-1', 'NAS.LOCAL']) {
    assert.deepEqual(selectHttpsHost(host), { host: host.toLowerCase(), automatic: false, interface: null });
  }
  for (const host of ['https://192.168.1.2', '192.168.1.2:8443', 'nas/path', '::1', '*', 'nas\n{tls internal}',
    '-nas.local', 'nas..local', 'nas_.local', '999.1.1.1', '2130706433', '255.255.255.255', '224.1.2.3', '169.254.1.1', '0.2.3.4']) {
    assert.throws(() => selectHttpsHost(host), /LABOS_HTTPS_HOST/);
  }
});

test('generated Caddy configuration uses the same resolved host for TLS default SNI and HTTP routing', () => {
  const text = caddyfileForHost('172.28.10.200');
  assert.match(text, /^    default_sni 172\.28\.10\.200$/m);
  assert.match(text, /^https:\/\/172\.28\.10\.200:443 \{$/m);
  assert.match(text, /^    tls internal$/m);
  assert.match(text, /^    reverse_proxy labos:3000$/m);
  assert.match(text, /^    admin off$/m);
  assert.doesNotMatch(text, /0\.0\.0\.0|on_demand|fallback_sni/);
  for (const host of ['auto', 'CHANGE_ME', '0.0.0.0']) assert.throws(() => caddyfileForHost(host), /resolved HTTPS host/);
});

function filesystemFixture() {
  const root = '/var/lib/labos', directory = root + '/https-config', destination = directory + '/Caddyfile';
  const entries = new Map(), descriptors = new Map(), events = [];
  const constants = { O_RDONLY: 0, O_WRONLY: 1, O_CREAT: 64, O_EXCL: 128, O_DIRECTORY: 65536, O_NOFOLLOW: 131072 };
  let fd = 10, failWrite = false, failRename = false;
  const failure = code => Object.assign(new Error(code), { code });
  const resolve = value => value.replace(/^\/proc\/self\/fd\/(\d+)(?=\/)/, (_, number) => {
    const entry = descriptors.get(Number(number));
    assert.equal(entry?.kind, 'directory');
    return entry.name;
  });
  const stat = entry => ({ uid: entry.uid, mode: entry.mode, isDirectory: () => entry.kind === 'directory', isFile: () => entry.kind === 'file' });
  const fakeFs = {
    constants,
    mkdirSync(name, options) {
      assert.equal(name, directory);
      if (entries.has(name)) throw failure('EEXIST');
      entries.set(name, { name, kind: 'directory', uid: 0, mode: options.mode & ~0o077 });
    },
    openSync(value, flags, mode) {
      assert.ok(flags & constants.O_NOFOLLOW);
      const name = resolve(value);
      let entry = entries.get(name);
      if (entry && (flags & constants.O_EXCL)) throw failure('EEXIST');
      if (entry?.kind === 'symlink') throw failure('ELOOP');
      if (!entry) {
        if (!(flags & constants.O_CREAT)) throw failure('ENOENT');
        entry = { name, kind: 'file', uid: 0, mode: mode & ~0o077, content: '' };
        entries.set(name, entry);
      }
      if (flags & constants.O_DIRECTORY) assert.equal(entry.kind, 'directory');
      descriptors.set(++fd, entry); events.push(['open', name]); return fd;
    },
    fstatSync(number) { return stat(descriptors.get(number)); },
    fchmodSync(number, mode) { descriptors.get(number).mode = mode; },
    lstatSync(value) { const entry = entries.get(resolve(value)); if (!entry) throw failure('ENOENT'); return stat(entry); },
    writeFileSync(number, content) {
      if (failWrite) throw failure('EIO');
      descriptors.get(number).content = content;
    },
    fsyncSync(number) { assert.ok(descriptors.has(number)); events.push(['fsync', descriptors.get(number).kind]); },
    closeSync(number) { assert.ok(descriptors.delete(number)); },
    renameSync(from, to) {
      if (failRename) throw failure('EIO');
      const source = resolve(from), target = resolve(to);
      const entry = entries.get(source); assert.ok(entry); events.push(['rename', source, target]);
      entries.delete(source); entry.name = target; entries.set(target, entry);
    },
    unlinkSync(value) { assert.ok(entries.delete(resolve(value))); },
    readFileSync(name) { assert.equal(name, '/proc/net/route'); events.push(['route']); return route('ovs_eth0'); }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/https-config.js'), 'utf8'), {
    require: name => name === 'node:fs' ? fakeFs : name === 'node:os' ? {
      networkInterfaces() { events.push(['interfaces']); return { ovs_eth0: [address('172.28.10.200')] }; }
    } : name === 'node:path' ? path.posix : name === 'node:crypto' ? { randomBytes: size => Buffer.alloc(size) } : require(name), module
  });
  return { ...module.exports, root, directory, destination, entries, descriptors, events,
    failWrites() { failWrite = true; }, failRenames() { failRename = true; } };
}

test('HTTPS config is root-owned, directory-anchored, atomic and readable with restrictive initialization umask', () => {
  const fixture = filesystemFixture();
  assert.equal(fixture.writeHttpsConfig(fixture.root, 'first'), fixture.destination);
  assert.equal(fixture.entries.get(fixture.directory).mode, 0o755);
  assert.equal(fixture.entries.get(fixture.destination).mode, 0o644);
  assert.equal(fixture.entries.get(fixture.destination).uid, 0);
  assert.equal(fixture.entries.get(fixture.destination).content, 'first');
  fixture.writeHttpsConfig(fixture.root, 'second');
  assert.equal(fixture.entries.get(fixture.destination).content, 'second');
  assert.deepEqual([...fixture.entries.keys()].sort(), [fixture.destination, fixture.directory].sort(), 'successful writes must not leave temporary files');
  assert.ok(fixture.events.filter(event => event[0] === 'fsync' && event[1] === 'file').length === 2);
  assert.ok(fixture.events.filter(event => event[0] === 'fsync' && event[1] === 'directory').length === 2);
  assert.equal(fixture.descriptors.size, 0);
});

test('HTTPS config rejects symlink or app-owned targets and leaves a previous config intact on a write failure', () => {
  for (const [kind, uid] of [['symlink', 0], ['directory', 1000]]) {
    const fixture = filesystemFixture();
    fixture.entries.set(fixture.directory, { name: fixture.directory, kind, uid, mode: 0o755 });
    assert.throws(() => fixture.writeHttpsConfig(fixture.root, 'replacement'), /ELOOP|owned by root/);
    assert.equal(fixture.entries.has(fixture.destination), false);
    assert.equal(fixture.descriptors.size, 0);
  }
  for (const [kind, uid] of [['symlink', 0], ['file', 1000], ['directory', 0]]) {
    const fixture = filesystemFixture(); fixture.writeHttpsConfig(fixture.root, 'original');
    Object.assign(fixture.entries.get(fixture.destination), { kind, uid });
    assert.throws(() => fixture.writeHttpsConfig(fixture.root, 'replacement'), /regular root-owned/);
    assert.equal(fixture.entries.get(fixture.destination).content, 'original');
    assert.equal(fixture.descriptors.size, 0);
  }
  const fixture = filesystemFixture(); fixture.writeHttpsConfig(fixture.root, 'original'); fixture.failWrites();
  assert.throws(() => fixture.writeHttpsConfig(fixture.root, 'replacement'), /EIO/);
  assert.equal(fixture.entries.get(fixture.destination).content, 'original');
  assert.equal(fixture.entries.size, 2, 'a failed temporary write must be removed');
  assert.equal(fixture.descriptors.size, 0);
  const renameFailure = filesystemFixture(); renameFailure.writeHttpsConfig(renameFailure.root, 'original'); renameFailure.failRenames();
  assert.throws(() => renameFailure.writeHttpsConfig(renameFailure.root, 'replacement'), /EIO/);
  assert.equal(renameFailure.entries.get(renameFailure.destination).content, 'original');
  assert.equal(renameFailure.entries.size, 2, 'a failed atomic rename must remove only its new temporary file');
  assert.equal(renameFailure.descriptors.size, 0);
  const collision = filesystemFixture(); collision.writeHttpsConfig(collision.root, 'original');
  const collisionPath = collision.directory + '/.Caddyfile-' + '0'.repeat(24);
  collision.entries.set(collisionPath, { name: collisionPath, kind: 'file', uid: 0, mode: 0o644, content: 'preexisting' });
  assert.throws(() => collision.writeHttpsConfig(collision.root, 'replacement'), /EEXIST/);
  assert.equal(collision.entries.get(collisionPath).content, 'preexisting', 'an exclusive-create collision must never unlink a preexisting file');
  assert.equal(collision.entries.get(collision.destination).content, 'original');
  assert.equal(collision.descriptors.size, 0);
});

test('HTTPS initialization reads host network data only in auto mode and validates before writing any configuration', () => {
  const automatic = filesystemFixture();
  const selected = automatic.prepareHttpsConfig({ host: '0.0.0.0' });
  assert.equal(selected.host, '172.28.10.200'); assert.equal(selected.automatic, true);
  assert.equal(selected.configPath, automatic.destination);
  assert.match(automatic.entries.get(automatic.destination).content, /https:\/\/172\.28\.10\.200:443/);
  assert.deepEqual(automatic.events.slice(0, 2), [['interfaces'], ['route']]);
  const explicit = filesystemFixture(); explicit.prepareHttpsConfig({ host: '127.0.0.1' });
  assert.ok(!explicit.events.some(event => ['interfaces', 'route'].includes(event[0])), 'explicit test overrides must not inspect a bridge or host namespace');
  const invalid = filesystemFixture();
  assert.throws(() => invalid.prepareHttpsConfig({ host: 'http://nas:3000' }), /LABOS_HTTPS_HOST/);
  assert.equal(invalid.entries.size, 0);
});
