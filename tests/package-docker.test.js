const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('offline packaging saves three matching images and rejects missing PostgreSQL or Caddy evidence', { timeout: 120000 }, t => {
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
  for (const name of ['scripts/package.ps1', 'scripts/package-docker.ps1', 'deploy/docker-compose.yml', 'deploy/docker-compose.local.yml', 'docs/SYNOLOGY.md', 'docs/SCANNING_HTTPS.md', 'docs/LABEL_PRINTING.md', 'config/.env.example', 'package.json', 'package-lock.json', 'README.md', 'AGENTS.md']) fs.copyFileSync(path.join(root, name), path.join(fixture, name));
  fs.cpSync(path.join(root, 'config/label-templates'), path.join(fixture, 'config/label-templates'), { recursive: true });
  const commandsFile = path.join(fixture, 'artifacts', 'mock-commands.json');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const run = ({ expected = 0, mismatch = '', badDigest = '', architectures = 'amd64,arm64' } = {}) => {
    const program = `
      $ErrorActionPreference='Stop'
      $global:Commands=[System.Collections.Generic.List[object]]::new()
      $global:Architecture=''
      function global:docker {
        $command=@($args);$global:Commands.Add($command);$global:LASTEXITCODE=0
        switch ($command[0]) {
          'buildx' { $global:Architecture=($command[[array]::IndexOf($command,'--platform')+1] -split '/')[1] }
          'pull' { 'Digest: sha256:' + $(if($command[-1] -eq 'postgres:18-bookworm'){'b'*64}else{'c'*64}) }
          'image' {
            $tag=$command[2]
            $repository=if($tag -eq 'postgres:18-bookworm'){'postgres'}elseif($tag -eq 'caddy:2.11.7-alpine'){'caddy'}else{'labos'}
            $architecture=if($tag -eq ${quote(mismatch)}){if($global:Architecture -eq 'amd64'){'arm64'}else{'amd64'}}else{$global:Architecture}
            $id=if($repository -eq 'postgres'){'d'}elseif($repository -eq 'caddy'){'e'}else{'a'}
            $digest=if($tag -eq ${quote(badDigest)}){'f'}elseif($repository -eq 'postgres'){'b'}else{'c'}
            $metadata=@{Os='linux';Architecture=$architecture;Id='sha256:'+($id*64);RepoDigests=@($repository+'@sha256:'+($digest*64));Config=@{Labels=@{'org.opencontainers.image.version'=${quote(version)};'org.opencontainers.image.revision'='unknown'}}}
            ConvertTo-Json -InputObject @($metadata) -Depth 5 -Compress
          }
          'save' { [System.IO.File]::WriteAllText($command[2],'synthetic '+$global:Architecture+' image archive: '+($command[3..($command.Length-1)] -join ',')) }
          default { throw 'unexpected Docker mock command' }
        }
      }
      try { & ${quote(path.join(fixture, 'scripts/package-docker.ps1'))} -Architectures ${quote(architectures)} }
      finally { ConvertTo-Json -InputObject $global:Commands.ToArray() -Depth 6 | Set-Content -LiteralPath ${quote(commandsFile)} }
    `;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], { cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 45000 });
    assert.ifError(result.error);
    if (expected === 0) assert.equal(result.status, 0, result.stdout + result.stderr);
    else assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(fs.readFileSync(commandsFile, 'utf8').replace(/^\uFEFF/, ''));
  };
  const commands = run(), imageTags = [`labos:${version}`, 'postgres:18-bookworm', 'caddy:2.11.7-alpine'];
  assert.equal(commands.filter(command => command[0] === 'save').length, 2);
  for (const saved of commands.filter(command => command[0] === 'save')) assert.deepEqual(saved.slice(3), imageTags);
  assert.deepEqual(commands.filter(command => command[0] === 'pull'), ['amd64', 'arm64'].flatMap(architecture => imageTags.slice(1).map(image => ['pull', '--platform', `linux/${architecture}`, image])));
  const release = path.join(fixture, 'artifacts/releases', version);
  const artifacts = ['amd64', 'arm64'].map(architecture => {
    const metadataPath = path.join(release, `labos-${version}-linux-${architecture}.json`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, ''));
    assert.deepEqual(metadata.images.map(image => image.role), ['application', 'database', 'https-proxy']);
    assert.deepEqual(metadata.images.map(image => image.imageTag), imageTags);
    assert.ok(metadata.images.every(image => image.os === 'linux' && image.architecture === architecture));
    assert.deepEqual(metadata.databaseImage, { role: 'database', imageTag: imageTags[1], imageId: 'sha256:' + 'd'.repeat(64), digest: 'sha256:' + 'b'.repeat(64), os: 'linux', architecture });
    assert.deepEqual(metadata.httpsImage, { role: 'https-proxy', imageTag: imageTags[2], imageId: 'sha256:' + 'e'.repeat(64), digest: 'sha256:' + 'c'.repeat(64), os: 'linux', architecture });
    const archive = path.join(release, metadata.archive), digest = () => crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    return { metadataPath, metadata, archive, digest, originalHash: digest() };
  });
  for (const file of ['docker-compose.yml', 'docker-compose.local.yml']) assert.deepEqual(fs.readFileSync(path.join(release, file)), fs.readFileSync(path.join(root, 'deploy', file)));
  assert.deepEqual(fs.readdirSync(release).filter(name => !name.endsWith('.tar') && !name.endsWith('.json') && !name.endsWith('.zip')).sort(), ['LABEL_PRINTING.md', 'SCANNING_HTTPS.md', 'SYNOLOGY.md', 'docker-compose.local.yml', 'docker-compose.yml'].sort());
  assert.deepEqual(fs.readFileSync(path.join(release, 'LABEL_PRINTING.md')), fs.readFileSync(path.join(root, 'docs/LABEL_PRINTING.md')), 'standalone label printing guide must match frozen source bytes');
  assert.deepEqual(run(), [], 'verified reuse must not rebuild or pull dependencies');
  const labelGuide = path.join(release, 'LABEL_PRINTING.md'), originalGuide = fs.readFileSync(labelGuide);
  fs.writeFileSync(labelGuide, 'different existing label printing guide');
  assert.deepEqual(run({ expected: 1 }), [], 'different existing deployment attachment must fail before Docker mutation');
  fs.writeFileSync(labelGuide, originalGuide);
  const first = artifacts[0];
  for (const missing of ['databaseImage', 'httpsImage', 'database', 'https-proxy']) {
    const invalid = structuredClone(first.metadata);
    if (missing.endsWith('Image')) delete invalid[missing];
    else invalid.images = invalid.images.filter(image => image.role !== missing);
    fs.writeFileSync(first.metadataPath, JSON.stringify(invalid));
    assert.deepEqual(run({ expected: 1 }), []);
    assert.equal(first.digest(), first.originalHash, 'missing dependency evidence must never overwrite an archive');
  }
  fs.writeFileSync(first.metadataPath, JSON.stringify(first.metadata));
  for (const artifact of artifacts) { fs.unlinkSync(artifact.archive); fs.unlinkSync(artifact.metadataPath); }
  for (const dependency of imageTags.slice(1)) {
    assert.equal(run({ expected: 1, mismatch: dependency, architectures: 'amd64' }).some(command => command[0] === 'save'), false, 'wrong-platform dependency must fail before saving');
    assert.equal(run({ expected: 1, badDigest: dependency, architectures: 'amd64' }).some(command => command[0] === 'save'), false, 'mismatched pulled dependency digest must fail before saving');
  }
});
