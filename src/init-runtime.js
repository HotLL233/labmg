const fs = require('node:fs');

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

for (const name of ['', '/data', '/uploads', '/logs']) {
  const directory = `/var/lib/labos${name}`;
  try {
    fs.mkdirSync(directory, { mode: 0o750 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    fs.fchownSync(fd, uid, gid);
    fs.fchmodSync(fd, (stat.mode & 0o7777) | 0o700);
  } finally {
    fs.closeSync(fd);
  }
}
console.log('Runtime directories are ready');
