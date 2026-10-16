const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
let checked = 0;
for (const directory of ['src', 'scripts', 'tests']) {
  for (const file of fs.readdirSync(path.join(root, directory), { recursive: true })) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, file)], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
    checked++;
  }
}
console.log(`Syntax checked ${checked} JavaScript files.`);
