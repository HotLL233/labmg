const fs = require('node:fs');
const crypto = require('node:crypto');

function readId(name) {
  const value = process.env[name] ?? '1000';
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) {
    throw new Error(`${name} must be an integer between 1 and 2147483647`);
  }
  return Number(value);
}

const uid = readId('LABOS_UID');
const gid = readId('LABOS_GID');
if (process.getuid?.() !== 0) throw new Error('Runtime initialization must run as root in the init container');

for (const name of ['', '/data', '/uploads', '/logs', '/secrets', '/postgres']) {
  const directory = `/var/lib/labos${name}`;
  let created = false;
  try {
    fs.mkdirSync(directory, { mode: 0o750 });
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    // PG18 owns its nested PGDATA; only a new parent needs traversal permissions.
    if (name === '/postgres' && created) fs.fchmodSync(fd, 0o755);
    if (name !== '/postgres') {
      fs.fchownSync(fd, uid, gid);
      fs.fchmodSync(fd, (stat.mode & 0o7777) | 0o700);
    }
  } finally {
    fs.closeSync(fd);
  }
}
const passwordFile = '/var/lib/labos/secrets/postgres-password';
if (!fs.existsSync(passwordFile) && fs.existsSync('/var/lib/labos/postgres/18/docker/PG_VERSION')) {
  throw new Error('PostgreSQL password file is missing; restore runtime/secrets from the deployment backup');
}
let secret;
try {
  secret = fs.openSync(passwordFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  fs.writeFileSync(secret, crypto.randomBytes(32).toString('hex') + '\n');
  fs.fsyncSync(secret);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  secret = fs.openSync(passwordFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(secret);
  if (!stat.isFile() || stat.size > 1024 || !/^[a-f0-9]{64}\n?$/.test(fs.readFileSync(secret, 'utf8'))) {
    throw new Error('PostgreSQL password file is invalid; restore the deployment backup');
  }
} finally {
  if (secret !== undefined) {
    fs.fchownSync(secret, uid, gid);
    fs.fchmodSync(secret, 0o600);
    fs.closeSync(secret);
  }
}
console.log('Runtime directories are ready');
