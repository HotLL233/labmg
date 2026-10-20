const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('versioned packages are isolated, verified, reusable and never overwritten', { timeout: 120000 }, t => {
  const root = path.resolve(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const cache = path.join(root, 'artifacts/cache', version);
  fs.mkdirSync(cache, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(cache, 'package-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(cache));
    assert.ok(path.basename(fixture).startsWith('package-test-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  for (const name of ['.github', 'src', 'scripts', 'deploy', 'docs', 'tests']) {
    fs.cpSync(path.join(root, name), path.join(fixture, name), { recursive: true });
  }
  fs.mkdirSync(path.join(fixture, 'config'));
  fs.copyFileSync(path.join(root, 'config/.env.example'), path.join(fixture, 'config/.env.example'));
  for (const name of ['package.json', 'package-lock.json', 'README.md', 'AGENTS.md']) fs.copyFileSync(path.join(root, name), path.join(fixture, name));
  for (const name of ['var/data/private.db', 'artifacts/private.zip', '.env', 'config/.env', 'deploy/.env', 'deploy/https/data/caddy/pki/authorities/local/root.key', 'deploy/https/config/private.json', 'deploy/runtime/private.json', 'deploy/runtime/uploads/private.txt', 'deploy/backups/private.tar.gz', 'src/runtime/private.txt', 'src/public/.env', 'src/data/private.db', 'src/private.log', 'scripts/test.db', 'scripts/test.db-wal', 'docs/test.db-shm']) {
    const file = path.join(fixture, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'must stay local');
  }
  const run = (program, args, expected = 0) => {
    const result = spawnSync(program, args, { cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.ifError(result.error);
    if (expected === 0) assert.equal(result.status, 0, result.stdout + result.stderr);
    else assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  };
  const powershell = code => run('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')]);
  const build = expected => run('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixture, 'scripts/package.ps1')], expected);
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  run('git', ['init', '--quiet']);
  run('git', ['-c', 'user.name=Package Test', '-c', 'user.email=package-test@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'fixture']);
  assert.match(build(), /Created/);

  const release = path.join(fixture, 'artifacts/releases', version);
  const archive = path.join(release, `labos-${version}.zip`);
  const manifestPath = path.join(release, 'manifest.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = readJson(manifestPath);
  assert.equal(manifest.version, version);
  assert.equal(manifest.archive, path.basename(archive));
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  assert.ok(Number.isFinite(Date.parse(manifest.builtAtUtc)));
  assert.equal(manifest.sha256, digest(archive));
  assert.equal(manifest.size, fs.statSync(archive).size);
  assert.equal(manifest.sourceSha256, crypto.createHash('sha256').update(JSON.stringify(manifest.sources)).digest('hex'));
  assert.ok(manifest.sources.some(source => source.path === 'config/.env.example'));
  assert.ok(manifest.sources.some(source => source.path === 'deploy/.env.example'));
  assert.ok(manifest.sources.some(source => source.path === 'package-lock.json'));
  const zipHash = digest(archive);
  const zipMtime = fs.statSync(archive).mtimeMs;
  run('git', ['-c', 'user.name=Package Test', '-c', 'user.email=package-test@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'same tree']);
  assert.match(build(), /Reused verified/);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestText);
  assert.equal(digest(archive), zipHash);
  assert.equal(fs.statSync(archive).mtimeMs, zipMtime);

  const extracted = path.join(fixture, 'artifacts/cache', version, 'verify');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)}, ${quote(extracted)})`);
  const files = fs.readdirSync(extracted, { recursive: true }).map(name => name.replaceAll('\\', '/'));
  for (const required of ['.github/workflows/publish-image.yml', 'src/server.js', 'scripts/check.js', 'scripts/package-docker.ps1', 'config/.env.example', 'deploy/.env.example', 'deploy/Dockerfile', 'deploy/Dockerfile.dockerignore', 'deploy/docker-compose.yml', 'deploy/docker-compose.infrastructure.yml', 'deploy/docker-compose.https.yml', 'deploy/Caddyfile', 'docs/SCANNING_HTTPS.md', 'docs/LABEL_PRINTING.md', 'docs/DEVELOPMENT.md', 'docs/SYNOLOGY.md', 'tests/package.test.js', 'package.json', 'package-lock.json', 'README.md', 'AGENTS.md', 'start-labos.cmd']) {
    assert.ok(files.includes(required), required);
  }
  assert.ok(files.every(file => !/(^|\/)(var|runtime|backups|https|data|uploads|logs|artifacts|\.git|node_modules)(\/|$)/.test(file)), files.join('\n'));
  assert.ok(files.every(file => !/\.(log|db(-wal|-shm)?)$/i.test(file)), files.join('\n'));
  assert.deepEqual(files.filter(file => path.basename(file).startsWith('.env')).sort(), ['config/.env.example', 'deploy/.env.example']);
  for (const source of manifest.sources) assert.equal(digest(path.join(extracted, source.path)), source.sha256, source.path);
  const launcher = fs.readFileSync(path.join(extracted, 'start-labos.cmd'), 'utf8');
  assert.match(launcher, /npm ci --omit=dev --ignore-scripts/);
  assert.ok(launcher.includes(`artifacts\\cache\\${version}\\npm`));
  assert.match(launcher, /if errorlevel 1 exit \/b 1/);
    assert.ok(launcher.includes('node_modules\\read-excel-file\\package.json'));
    assert.ok(launcher.includes('node_modules\\zxing-wasm\\dist\\full\\zxing_full.wasm'), 'launcher installs scanner dependency on older extracted installations');
  assert.match(fs.readFileSync(path.join(extracted, 'deploy/Dockerfile'), 'utf8'), /COPY[^\n]+package\.json package-lock\.json/);
  assert.match(fs.readFileSync(path.join(extracted, 'deploy/Dockerfile.dockerignore'), 'utf8'), /^!package-lock\.json$/m);
  const dockerfile = fs.readFileSync(path.join(extracted, 'deploy/Dockerfile'), 'utf8');
  const dockerAllowlist = fs.readFileSync(path.join(extracted, 'deploy/Dockerfile.dockerignore'), 'utf8').split(/\r?\n/);
  for (const agent of ['bartender-agent.ps1', 'bartender-agent.cmd']) {
    assert.ok(files.includes(`scripts/${agent}`), `printing download must be in ZIP: ${agent}`);
    assert.ok(dockerfile.split(/\r?\n/).some(line => line.startsWith('COPY ') && line.split(/\s+/).includes(`scripts/${agent}`)), `printing download must be in image: ${agent}`);
    assert.ok(dockerAllowlist.includes(`!scripts/${agent}`), `printing download must enter Docker context: ${agent}`);
  }
  run(process.execPath, [path.join(extracted, 'scripts/check.js')]);
  if (process.env.LABOS_PACKAGE_INSTALL_TEST === '1') {
    const npmCache = path.join(root, 'artifacts/cache', version, 'npm');
    powershell(`& npm ci --offline --omit=dev --ignore-scripts --no-audit --no-fund --prefix ${quote(extracted)} --cache ${quote(npmCache)}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
    const dependency = path.join(extracted, 'node_modules/write-excel-file/package.json');
    assert.ok(fs.existsSync(dependency), 'ZIP dependencies must install into the extracted package');
    const installed = readJson(dependency);
    const lock = readJson(path.join(extracted, 'package-lock.json'));
    assert.equal(installed.version, lock.packages['node_modules/write-excel-file'].version);
    assert.equal(readJson(path.join(extracted, 'node_modules/read-excel-file/package.json')).version, lock.packages['node_modules/read-excel-file'].version);
    run(process.execPath, ['-e', `const assert=require('node:assert/strict');const dependency=require.resolve('read-excel-file/universal',{paths:[${JSON.stringify(extracted)}]});assert.ok(dependency.startsWith(${JSON.stringify(path.join(extracted, 'node_modules') + path.sep)}));assert.equal(typeof require(dependency).readSheet,'function')`]);
      assert.equal(readJson(path.join(extracted, 'node_modules/zxing-wasm/package.json')).version, lock.packages['node_modules/zxing-wasm'].version);
      assert.ok(fs.existsSync(path.join(extracted, 'node_modules/zxing-wasm/dist/full/zxing_full.wasm')));
    run(process.execPath, ['-e', `const assert=require('node:assert/strict');const dependency=require.resolve('write-excel-file/node',{paths:[${JSON.stringify(extracted)}]});assert.ok(dependency.startsWith(${JSON.stringify(path.join(extracted, 'node_modules') + path.sep)}));require(dependency)`]);
  }

  const readme = path.join(fixture, 'README.md');
  const originalReadme = fs.readFileSync(readme);
  fs.appendFileSync(readme, '\nChanged source\n');
  assert.match(build(1), /use a new package version/);
  assert.equal(digest(archive), zipHash);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestText);
  fs.writeFileSync(readme, originalReadme);
  fs.appendFileSync(archive, 'damaged');
  const damagedHash = digest(archive);
  assert.match(build(1), /use a new package version/);
  assert.equal(digest(archive), damagedHash);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestText);
  assert.ok(fs.readdirSync(path.join(fixture, 'artifacts/cache', version)).every(name => !name.startsWith('build-')));

  const nextVersion = `${version}-next`;
  const packagePath = path.join(fixture, 'package.json');
  const nextPackage = readJson(packagePath);
  nextPackage.version = nextVersion;
  fs.writeFileSync(packagePath, JSON.stringify(nextPackage, null, 2));
  assert.match(build(), /Created/);
  const nextRelease = path.join(fixture, 'artifacts/releases', nextVersion);
  assert.equal(readJson(path.join(nextRelease, 'manifest.json')).version, nextVersion);
  assert.equal(digest(archive), damagedHash, 'a new version must preserve old releases');
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestText);
});
