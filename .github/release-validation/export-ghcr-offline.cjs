'use strict';

// Release-only helper. Never builds an image, reads var, or rewrites an existing release artifact.
// Copy this runner-only helper into project/artifacts/cache/0.9.4 before executing it.
// Prepare deployment files: node artifacts/cache/0.9.4/export-ghcr-offline.cjs --prepare-deployment-only
// After root confirms CI and anonymous verification passed: node .../export-ghcr-offline.cjs --validate
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { version, commit } = require('./release-config.json');
const postgresHelpers = require('./postgres-image.cjs');
const repository = 'ghcr.io/hotll233/labmg';
const source = 'https://github.com/HotLL233/labmg';
const imageTag = `labos:${version}`;
const root = path.resolve(__dirname, '../../..');
const cache = path.join(root, 'artifacts/cache', version);
const release = path.join(root, 'artifacts/releases', version);
const prepareOnly = process.argv.includes('--prepare-deployment-only');
const validate = process.argv.includes('--validate');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hashBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = async file => {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
};
const report = { status: 'running', version, commit, startedAtUtc: new Date().toISOString(),
  mode: prepareOnly ? 'deployment-only' : 'verified-registry-export', architectures: [],
  verificationEnvironment: { provider: process.env.GITHUB_ACTIONS === 'true' ? 'GitHub Actions' : 'local deployment-byte preparation', os: process.platform, architecture: process.arch, runId: process.env.GITHUB_RUN_ID, headSha: process.env.GITHUB_SHA, workflowSha: process.env.GITHUB_WORKFLOW_SHA },
  boundaries: ['No Docker Hub build or image rebuild; export only from the anonymously verified official GHCR index.', 'No real var data.', 'GitHub-hosted Linux amd64 runner; ARM64 lifecycle uses QEMU emulation, not physical ARM64 or Synology hardware.', 'Existing release artifacts are verified and reused, never overwritten. Each TAR includes matching-architecture application, PostgreSQL 18 and Caddy images. The local Compose file forbids pulling all four services.'] };
let stage, dockerArgs, environment, manifest, attemptReport;
function saveReport() { if (attemptReport) fs.writeFileSync(attemptReport, JSON.stringify(report, null, 2) + '\n'); }
async function run(program, args, log, timeout = 60000, env = process.env) {
  try {
    const result = await execute(program, args, { cwd: root, env, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
    if (log) fs.writeFileSync(path.join(cache, log), result.stdout + result.stderr);
    return result.stdout.trim();
  } catch (error) {
    if (log) fs.writeFileSync(path.join(cache, log), (error.stdout || '') + (error.stderr || '') + '\n' + error.message);
    throw error;
  }
}
const docker = (args, log, timeout) => run('docker', [...dockerArgs, ...args], log, timeout, environment);
function publishBytes(file, bytes) {
  assert.equal(path.dirname(path.resolve(file)), release);
  if (fs.existsSync(file)) assert.deepEqual(fs.readFileSync(file), bytes, `Preserve differing existing artifact: ${file}`);
  else fs.writeFileSync(file, bytes, { flag: 'wx' });
}
function checkImage(actual, architecture, remote) {
  assert.equal(actual.Os, 'linux'); assert.equal(actual.Architecture, architecture);
  assert.ok([remote.manifestDigest, remote.configDigest].includes(actual.Id), 'Local image must equal an anonymously verified platform manifest/config');
  assert.equal(actual.Config.Labels['org.opencontainers.image.source'], source);
  assert.equal(actual.Config.Labels['org.opencontainers.image.version'], version);
  assert.equal(actual.Config.Labels['org.opencontainers.image.revision'], commit);
  const user = actual.Config.User?.split(':')[0];
  assert.ok(user && user !== 'root' && !/^0+$/.test(user), 'Release image must default to non-root');
}
async function extractFrozenSelected() {
  const script = String.raw`
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 7) { throw 'PowerShell 7 is required' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[System.IO.Compression.ZipFile]::OpenRead($env:LABOS_EXPORT_ARCHIVE)
try {
  $selected=@()
  foreach($name in @('deploy/docker-compose.yml','deploy/docker-compose.local.yml','docs/SCANNING_HTTPS.md','docs/LABEL_PRINTING.md','docs/SYNOLOGY.md','tests/docker.test.js','package.json')) {
    $entries=@($archive.Entries | Where-Object FullName -CEQ $name)
    if($entries.Count -ne 1) { throw ('Frozen ZIP entry is missing/duplicated: '+$name) }
    $inputStream=$entries[0].Open(); $memory=[System.IO.MemoryStream]::new()
    try { $inputStream.CopyTo($memory); $selected+=@{path=$name;base64=[Convert]::ToBase64String($memory.ToArray())} }
    finally { $inputStream.Dispose(); $memory.Dispose() }
  }
  ConvertTo-Json -InputObject $selected -Depth 3 -Compress
} finally { $archive.Dispose() }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const selected = JSON.parse(await run('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], null, 30000,
    { ...process.env, LABOS_EXPORT_ARCHIVE: path.join(release, manifest.archive) }));
  const result = new Map();
  for (const entry of selected) {
    const expected = manifest.sources.find(row => row.path === entry.path), bytes = Buffer.from(entry.base64, 'base64');
    assert.ok(expected); assert.equal(bytes.length, expected.size); assert.equal(hashBytes(bytes), expected.sha256);
    result.set(entry.path, bytes);
  }
  return result;
}
async function verifyArchivePair(architecture, remote) {
  const base = `labos-${version}-linux-${architecture}`;
  const archive = path.join(release, base + '.tar'), metadata = path.join(release, base + '.json');
  if (!fs.existsSync(archive) && !fs.existsSync(metadata)) return null;
  assert.ok(fs.existsSync(archive) && fs.existsSync(metadata), 'Incomplete release pair must be preserved and investigated');
  const entry = readJson(metadata);
  for (const [key, value] of Object.entries({ version, commit, sourceSha256: manifest.sourceSha256, imageTag, os: 'linux', architecture, archive: base + '.tar' })) assert.equal(entry[key], value);
  assert.ok([remote.manifestDigest, remote.configDigest].includes(entry.imageId));
  postgresHelpers.verifyBundleMetadata(entry, report.postgres, architecture, remote, imageTag, report.httpsProxy);
  assert.equal(fs.statSync(archive).size, entry.size); assert.equal(await hashFile(archive), entry.sha256);
  return entry;
}
async function main() {
  if (!prepareOnly) {
    assert.equal(process.platform, 'linux', 'Container export is for the isolated Linux runner');
    assert.equal(process.arch, 'x64', 'The runner must be amd64; ARM64 validation uses emulation');
  }
  const host = process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
  if (!prepareOnly) {
    if (process.env.GITHUB_ACTIONS === 'true') assert.ok(process.env.DOCKER_HOST, 'CI must supply the selected Docker daemon socket');
    assert.ok(host.startsWith('unix:///') && !/[\0?#]/.test(host), 'Docker host must be an absolute local Unix socket without query or fragment');
    assert.equal(path.posix.normalize(host.slice(7)), host.slice(7));
  }
  assert.equal(path.resolve(__dirname), cache);
  assert.match(commit || '', /^[a-f0-9]{40}$/, 'Wait for root to supply the frozen commit');
  manifest = readJson(path.join(release, 'manifest.json'));
  assert.equal(manifest.version, version); assert.equal(manifest.commit, commit);
  assert.equal(await run('git', ['rev-parse', `refs/tags/v${version}^{commit}`]), commit);
  assert.equal(manifest.archive, `labos-${version}.zip`);
  const sourceArchive = path.join(release, manifest.archive);
  assert.equal(fs.statSync(sourceArchive).size, manifest.size); assert.equal(await hashFile(sourceArchive), manifest.sha256);
  report.sourceSha256 = manifest.sourceSha256;
  stage = fs.mkdtempSync(path.join(cache, 'ghcr-export-'));
  const marker = crypto.randomUUID(); fs.writeFileSync(path.join(stage, '.export-marker'), marker);
  report.marker = marker;
  attemptReport = path.join(cache, `ghcr-offline-export-${path.basename(stage)}.json`);
  saveReport();
  const selected = await extractFrozenSelected();
  for (const [entry, name] of [['deploy/docker-compose.yml', 'docker-compose.yml'], ['deploy/docker-compose.local.yml', 'docker-compose.local.yml'], ['docs/SYNOLOGY.md', 'SYNOLOGY.md'], ['docs/SCANNING_HTTPS.md', 'SCANNING_HTTPS.md'], ['docs/LABEL_PRINTING.md', 'LABEL_PRINTING.md']]) publishBytes(path.join(release, name), selected.get(entry));
  report.deployment = 'copied byte-exactly from verified frozen ZIP'; saveReport();
  if (prepareOnly) { report.status = 'passed'; return; }

  const verified = readJson(path.join(cache, 'ghcr-anonymous-verification.json'));
  assert.equal(verified.status, 'passed', 'Wait for root to complete anonymous registry verification before exporting');
  assert.equal(verified.version, version); assert.equal(verified.commit, commit);
  assert.equal(verified.engineHost, host, 'Offline export must use the same verified Docker daemon');
  report.engineHost = host;
  assert.equal(verified.postgres?.status, 'passed'); report.postgres = verified.postgres;
  assert.equal(verified.httpsProxy?.status, 'passed'); report.httpsProxy = verified.httpsProxy;
  assert.equal(verified.image, `${repository}:${version}`);
  const indexDigest = verified.expectedIndexDigest;
  assert.match(indexDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(verified.registry.index.digest, indexDigest);
  const published = readJson(path.join(cache, 'published-index.json'));
  assert.equal(published.commit, commit); assert.equal(published.indexDigest, indexDigest, 'Registry index must match the digest independently read from successful Actions logs');
  assert.equal(verified.dockerCredentialIsolation.existingCredentialsUsed, false);
  const immutable = `${repository}@${indexDigest}`;
  report.indexDigest = indexDigest; report.registryVerification = 'ghcr-anonymous-verification.json';
  const config = path.join(stage, 'docker-config'); fs.mkdirSync(config); fs.writeFileSync(path.join(config, 'config.json'), '{}\n');
  environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(DOCKER_|LABOS_|COMPOSE_)/i.test(key)) delete environment[key];
  Object.assign(environment, { DOCKER_CONFIG: config, DOCKER_HOST: host });
  dockerArgs = ['--config', config, '--host', host];
  report.engine = await docker(['version', '--format', '{{.Server.Os}} {{.Server.Arch}} {{.Server.Version}}']);
  for (const architecture of ['amd64', 'arm64']) {
    const remote = verified.registry.architectures.find(row => row.architecture === architecture);
    assert.ok(remote); assert.equal(remote.oci.version, version); assert.equal(remote.oci.revision, commit);
    const pull = verified.pulls.find(row => row.architecture === architecture && row.status === 'passed');
    assert.ok(pull, 'Both architectures must already have passed anonymous pulls');
    const actual = JSON.parse(await docker(['image', 'inspect', '--platform', `linux/${architecture}`, immutable]))[0];
    checkImage(actual, architecture, remote);
    assert.ok(actual.RepoDigests.includes(immutable));
  }
  let existingTag;
  try { existingTag = JSON.parse(await docker(['image', 'inspect', imageTag]))[0]; }
  catch (error) { if (!/No such image/.test((error.stderr || '') + error.message)) throw error; }
  if (existingTag) {
    assert.ok(existingTag.RepoDigests.some(value => value.endsWith('@' + indexDigest)), 'Never replace a differing local release tag');
  } else await docker(['image', 'tag', immutable, imageTag]);

  for (const architecture of ['amd64', 'arm64']) {
    const remote = verified.registry.architectures.find(row => row.architecture === architecture);
    const actual = JSON.parse(await docker(['image', 'inspect', '--platform', `linux/${architecture}`, imageTag]))[0];
    checkImage(actual, architecture, remote);
    const pgRemote = report.postgres.architectures.find(row => row.architecture === architecture);
    const pgActual = JSON.parse(await docker(['image', 'inspect', '--platform', `linux/${architecture}`, 'postgres:18-bookworm']))[0];
    postgresHelpers.checkPostgresImage(pgActual, pgRemote, report.postgres.indexDigest);
    const httpsRemote = report.httpsProxy.architectures.find(row => row.architecture === architecture);
    const httpsActual = JSON.parse(await docker(['image', 'inspect', '--platform', `linux/${architecture}`, 'caddy:2.11.7-alpine']))[0];
    postgresHelpers.checkHttpsImage(httpsActual, httpsRemote, report.httpsProxy.indexDigest);
    const bundleImages = postgresHelpers.bundleImages(actual, remote, pgActual, pgRemote, report.postgres.indexDigest, imageTag, report.indexDigest, httpsActual, httpsRemote, report.httpsProxy.indexDigest);
    let metadata = await verifyArchivePair(architecture, remote);
    const reused = Boolean(metadata);
    if (!metadata) {
      const name = `labos-${version}-linux-${architecture}.tar`, stagedArchive = path.join(stage, name);
      await docker(['image', 'save', '--platform', `linux/${architecture}`, '--output', stagedArchive, imageTag, 'postgres:18-bookworm', 'caddy:2.11.7-alpine'], `ghcr-export-save-${architecture}.log`, 240000);
      metadata = { version, commit, sourceSha256: manifest.sourceSha256, imageTag, imageId: actual.Id, os: 'linux', architecture,
        images: bundleImages, databaseImage: bundleImages.find(row => row.role === 'database'), httpsImage: bundleImages.find(row => row.role === 'https-proxy'), deployment: 'application, PostgreSQL 18 and Caddy; complete local Compose deployment without registry pulls',
        archive: name, size: fs.statSync(stagedArchive).size, sha256: await hashFile(stagedArchive), builtAtUtc: actual.Created };
      assert.ok(Number.isFinite(Date.parse(metadata.builtAtUtc)));
      fs.copyFileSync(stagedArchive, path.join(release, name), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(release, name.replace(/\.tar$/, '.json')), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
      await verifyArchivePair(architecture, remote);
    }
    await postgresHelpers.verifySavedBundle({ archive: path.join(release, metadata.archive), metadata, docker, run, architecture, imageTag, pgRemote, appRemote: remote, httpsRemote });
    report.architectures.push({ architecture, status: 'passed', reused, ...metadata, archiveContainsApplicationAndPostgres: true, archiveContainsApplicationPostgresAndCaddy: true }); saveReport();
    console.log(`Verified ${architecture} TAR: ${metadata.archive}; sha256=${metadata.sha256}`);
  }
  const names = ['SCANNING_HTTPS.md', 'LABEL_PRINTING.md', 'SYNOLOGY.md', 'docker-compose.yml', 'docker-compose.local.yml', manifest.archive, 'manifest.json',
    ...['amd64', 'arm64'].flatMap(architecture => [`labos-${version}-linux-${architecture}.json`, `labos-${version}-linux-${architecture}.tar`])].sort();
  const checksums = [];
  for (const name of names) checksums.push(`${await hashFile(path.join(release, name))}  ${name}`);
  publishBytes(path.join(release, 'SHA256SUMS'), Buffer.from(checksums.join('\n') + '\n'));
  report.checksums = { file: 'SHA256SUMS', entries: names.length };

  if (validate) {
    const frozen = path.join(stage, 'frozen');
    for (const name of ['tests/docker.test.js', 'package.json', 'deploy/docker-compose.yml', 'deploy/docker-compose.local.yml']) {
      const file = path.join(frozen, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, selected.get(name));
    }
    for (const architecture of ['amd64', 'arm64']) {
      const entry = report.architectures.find(row => row.architecture === architecture);
      await docker(['image', 'load', '--platform', `linux/${architecture}`, '--input', path.join(release, entry.archive)], `ghcr-offline-load-${architecture}.log`, 180000);
      const remote = verified.registry.architectures.find(row => row.architecture === architecture);
      const actual = JSON.parse(await docker(['image', 'inspect', '--platform', `linux/${architecture}`, imageTag]))[0];
      checkImage(actual, architecture, remote);
      const pgRemote = report.postgres.architectures.find(row => row.architecture === architecture);
      const loadedPostgres = JSON.parse(await docker(['image', 'inspect', '--platform', `linux/${architecture}`, 'postgres:18-bookworm']))[0];
      postgresHelpers.checkPostgresImage(loadedPostgres, pgRemote, report.postgres.indexDigest, false);
      const httpsRemote = report.httpsProxy.architectures.find(row => row.architecture === architecture);
      const loadedHttps = JSON.parse(await docker(['image', 'inspect', '--platform', `linux/${architecture}`, 'caddy:2.11.7-alpine']))[0];
      postgresHelpers.checkHttpsImage(loadedHttps, httpsRemote, report.httpsProxy.indexDigest, false);
      entry.postgresReloadedFromBundle = 'passed'; entry.httpsReloadedFromBundle = 'passed'; entry.imagePullPolicy = 'never';
      entry.validationImage = imageTag; entry.composeMode = 'local'; entry.composeFile = 'docker-compose.local.yml'; entry.emulated = architecture === 'arm64'; entry.containerTest = 'running'; saveReport();
      const testOutput = await run(process.execPath, ['--test', '--test-reporter=tap', path.join(frozen, 'tests/docker.test.js')], `ghcr-offline-test-${architecture}.log`, 720000,
        { ...environment, LABOS_DOCKER_IMAGE: imageTag, LABOS_DOCKER_MODE: 'local', DOCKER_DEFAULT_PLATFORM: `linux/${architecture}` });
      assert.match(testOutput, /^# pass 1\r?$/m, 'frozen offline Docker test did not report one pass');
      assert.match(testOutput, /^# fail 0\r?$/m);
      assert.match(testOutput, /^# skipped 0\r?$/m, 'offline Docker test must run rather than skip');
      assert.ok(testOutput.includes('Runtime initializer preflight passed: PostgreSQL directory creation, ownership preservation and symlink rejection'), 'Frozen offline Docker test must complete the runtime initializer preflight');
      entry.runtimeInitializerPreflight = 'passed'; entry.containerTest = 'passed'; entry.frozenTest = 'byte-exact ZIP snapshot'; entry.cleanup = 'frozen Docker test checked its random project, volume and fixture cleanup'; saveReport();
      console.log(`Official offline TAR ${architecture} Compose lifecycle passed${entry.emulated ? ' using emulation' : ''}.`);
    }
  }
  report.status = 'passed';
}
main().catch(error => { report.status = 'failed'; report.error = error.message; console.error(error.message); process.exitCode = 1; })
  .finally(() => {
    report.completedAtUtc = new Date().toISOString(); saveReport();
    if (stage && report.status === 'passed') {
      assert.equal(path.dirname(path.resolve(stage)), cache); assert.match(path.basename(stage), /^ghcr-export-/);
      assert.equal(fs.readFileSync(path.join(stage, '.export-marker'), 'utf8'), report.marker);
      fs.rmSync(stage, { recursive: true, force: true });
    }
    if (report.status === 'passed' && validate && !prepareOnly) fs.writeFileSync(path.join(cache, 'ghcr-offline-export.json'), JSON.stringify(report, null, 2) + '\n');
    if (attemptReport) console.log(`Report: ${attemptReport}; status=${report.status}`);
  });

