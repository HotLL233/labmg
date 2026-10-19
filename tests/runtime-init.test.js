const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
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

test('runtime initializer creates one persistent secret and refuses missing, invalid or symlink replacements', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/init-runtime.js'), 'utf8');
  const root = '/var/lib/labos', passwordFile = root + '/secrets/postgres-password';
  const constants = { O_RDONLY: 0, O_WRONLY: 1, O_CREAT: 64, O_EXCL: 128, O_DIRECTORY: 65536, O_NOFOLLOW: 131072 };
  const entries = new Map(), descriptors = new Map();
  let descriptor = 0;
  const failure = code => Object.assign(new Error(code), { code });
  const fakeFs = {
    constants,
    mkdirSync(name, options) {
      assert.ok(name === root || name.startsWith(root + '/'));
      if (entries.has(name)) throw failure('EEXIST');
      entries.set(name, { kind: 'directory', mode: options.mode, uid: 0, gid: 0 });
    },
    existsSync(name) { return entries.has(name); },
    openSync(name, flags, mode) {
      assert.ok(flags & constants.O_NOFOLLOW, 'all initializer opens must reject symlinks');
      let entry = entries.get(name);
      if (entry && flags & constants.O_EXCL) throw failure('EEXIST');
      if (entry?.kind === 'symlink') throw failure('ELOOP');
      if (!entry) {
        if (!(flags & constants.O_CREAT)) throw failure('ENOENT');
        entry = { kind: 'file', mode, uid: 0, gid: 0, content: '' };
        entries.set(name, entry);
      }
      if (flags & constants.O_DIRECTORY) assert.equal(entry.kind, 'directory');
      descriptors.set(++descriptor, entry);
      return descriptor;
    },
    fstatSync(fd) {
      const entry = descriptors.get(fd);
      assert.ok(entry);
      return { mode: entry.mode, size: Buffer.byteLength(entry.content || ''), isFile: () => entry.kind === 'file' };
    },
    fchownSync(fd, uid, gid) { Object.assign(descriptors.get(fd), { uid, gid }); },
    fchmodSync(fd, mode) { descriptors.get(fd).mode = mode; },
    writeFileSync(fd, content) { descriptors.get(fd).content = content; },
    readFileSync(fd) { return descriptors.get(fd).content; },
    fsyncSync(fd) { assert.ok(descriptors.has(fd)); },
    closeSync(fd) { assert.ok(descriptors.delete(fd)); }
  };
  const run = () => vm.runInNewContext(source, {
    require: name => name === 'node:fs' ? fakeFs : require(name),
    process: { env: { LABOS_UID: '12345', LABOS_GID: '23456' }, getuid: () => 0 },
    console: { log() {} }
  });
  run();
  const initial = { ...entries.get(passwordFile) };
  const postgresDirectory = root + '/postgres';
  assert.equal(entries.get(postgresDirectory)?.kind, 'directory', 'initializer must create the PostgreSQL bind source before the database starts');
  Object.assign(entries.get(postgresDirectory), { uid: 999, gid: 999, mode: 0o700 });
  const postgresBeforeRestart = { ...entries.get(postgresDirectory) };
  assert.match(initial.content, /^[a-f0-9]{64}\n$/);
  assert.deepEqual({ mode: initial.mode, uid: initial.uid, gid: initial.gid }, { mode: 0o600, uid: 12345, gid: 23456 });
  run();
  assert.deepEqual(entries.get(passwordFile), initial, 'restart must keep the same password');
  assert.deepEqual(entries.get(postgresDirectory), postgresBeforeRestart, 'initialization must preserve PostgreSQL ownership and permissions');
  entries.delete(passwordFile);
  entries.set(root + '/postgres/PG_VERSION', { kind: 'file', content: '17\n' });
  assert.throws(run, /password file is missing/);
  assert.equal(entries.has(passwordFile), false, 'an existing PostgreSQL database must never receive a generated replacement password');
  entries.set(passwordFile, { ...initial, content: 'corrupt-fixture' });
  assert.throws(run, /password file is invalid/);
  assert.equal(entries.get(passwordFile).content, 'corrupt-fixture', 'invalid secrets must not be silently replaced');
  entries.set(passwordFile, { kind: 'symlink', target: '/synthetic-guard' });
  assert.throws(run, /ELOOP/);
  assert.equal(entries.get(passwordFile).target, '/synthetic-guard');
  entries.set(passwordFile, initial);
  entries.set(postgresDirectory, { kind: 'symlink', target: '/synthetic-postgres-guard' });
  assert.throws(run, /ELOOP/, 'the PostgreSQL bind source must not be a symlink');
  assert.equal(entries.get(postgresDirectory).target, '/synthetic-postgres-guard');
  assert.equal(descriptors.size, 0, 'all opened descriptors must close on success and failure');
});
