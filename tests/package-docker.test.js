const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('offline packaging saves both matching images and refuses archives without PostgreSQL evidence', { timeout: 90000 }, t => {
  const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
  const cache = path.join(root, 'artifacts/cache', version);
  fs.mkdirSync(cache, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(cache, 'docker-package-test-'));
  t.after(() => {
    assert.equal(path.dirname(fixture), cache);
    assert.ok(path.basename(fixture).startsWith('docker-package-test-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  for (const name of ['.github', 'src', 'scripts', 'deploy', 'docs', 'tests', 'config']) fs.mkdirSync(path.join(fixture, name));
  for (const name of ['scripts/package.ps1', 'scripts/package-docker.ps1', 'deploy/docker-compose.yml', 'deploy/.env.example', 'docs/SYNOLOGY.md', 'deploy/docker-compose.https.yml', 'deploy/Caddyfile', 'docs/SCANNING_HTTPS.md', 'docs/LABEL_PRINTING.md', 'config/.env.example', 'package.json', 'package-lock.json', 'README.md', 'AGENTS.md']) fs.copyFileSync(path.join(root, name), path.join(fixture, name));
  const commandsFile = path.join(fixture, 'artifacts', 'mock-commands.json');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const run = (expected = 0, mismatch = false, badDigest = false) => {
    const program = `
      $ErrorActionPreference='Stop'
      $global:Commands=[System.Collections.Generic.List[object]]::new()
      $global:Architecture=''
      function global:docker {
        $command=@($args);$global:Commands.Add($command);$global:LASTEXITCODE=0
        switch ($command[0]) {
          'buildx' { $global:Architecture=($command[[array]::IndexOf($command,'--platform')+1] -split '/')[1] }
          'pull' { 'Digest: sha256:' + ('b'*64) }
          'image' {
            $isDatabase=$command[2] -eq 'postgres:17-bookworm'
            $architecture=if($isDatabase -and ${mismatch ? '$true' : '$false'}){'arm64'}else{$global:Architecture}
            $metadata=@{Os='linux';Architecture=$architecture;Id='sha256:'+('a'*64);RepoDigests=@('postgres@sha256:'+('${badDigest ? 'c' : 'b'}'*64));Config=@{Labels=@{'org.opencontainers.image.version'=${quote(version)};'org.opencontainers.image.revision'='unknown'}}}
            ConvertTo-Json -InputObject @($metadata) -Depth 5 -Compress
          }
          'save' { [System.IO.File]::WriteAllText($command[2],'synthetic image archive: '+($command[3..($command.Length-1)] -join ',')) }
          default { throw 'unexpected Docker mock command' }
        }
      }
      try { & ${quote(path.join(fixture, 'scripts/package-docker.ps1'))} -Architectures amd64 }
      finally { ConvertTo-Json -InputObject $global:Commands.ToArray() -Depth 6 | Set-Content -LiteralPath ${quote(commandsFile)} }
    `;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], { cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 45000 });
    assert.ifError(result.error);
    if (expected === 0) assert.equal(result.status, 0, result.stdout + result.stderr);
    else assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(fs.readFileSync(commandsFile, 'utf8').replace(/^\uFEFF/, ''));
  };
  const commands = run();
  const saved = commands.find(command => command[0] === 'save');
  assert.deepEqual(saved.slice(3), [`labos:${version}`, 'postgres:17-bookworm']);
  assert.deepEqual(commands.find(command => command[0] === 'pull'), ['pull', '--platform', 'linux/amd64', 'postgres:17-bookworm']);
  const release = path.join(fixture, 'artifacts/releases', version), metadataPath = path.join(release, `labos-${version}-linux-amd64.json`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.deepEqual(metadata.databaseImage, { imageTag: 'postgres:17-bookworm', imageId: 'sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'b'.repeat(64), os: 'linux', architecture: 'amd64' });
  const archive = path.join(release, metadata.archive), digest = () => crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const originalHash = digest();
  assert.deepEqual(run(), [], 'verified reuse must not rebuild or pull another database image');
  const invalid = { ...metadata };
  delete invalid.databaseImage;
  fs.writeFileSync(metadataPath, JSON.stringify(invalid));
  assert.deepEqual(run(1), []);
  assert.equal(digest(), originalHash, 'invalid evidence must never overwrite an existing archive');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  fs.unlinkSync(archive);
  fs.unlinkSync(metadataPath);
  assert.equal(run(1, true).some(command => command[0] === 'save'), false, 'wrong-platform PostgreSQL must fail before saving');
  assert.equal(run(1, false, true).some(command => command[0] === 'save'), false, 'a mismatched pulled digest must fail before saving');
});
