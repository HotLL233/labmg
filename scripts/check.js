const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const files = [];
for (const directory of ['src', 'scripts', 'tests']) {
  for (const file of fs.readdirSync(path.join(root, directory), { recursive: true })) {
    if (file.endsWith('.js')) files.push(path.join(root, directory, file));
  }
}

let next = 0, checked = 0, failed = 0;
Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
  while (!failed && next < files.length) {
    try {
      const [code] = await once(spawn(process.execPath, ['--check', files[next++]], { stdio: 'inherit', windowsHide: true }), 'close');
      if (code !== 0) failed ||= code || 1;
      else checked++;
    } catch (error) {
      console.error(error);
      failed ||= 1;
    }
  }
})).then(() => {
  if (failed) process.exitCode = failed;
  else console.log(`Syntax checked ${checked} JavaScript files.`);
});
