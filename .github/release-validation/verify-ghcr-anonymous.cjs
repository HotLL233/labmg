'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

const { version, commit: frozenCommit } = (process.argv.includes('--self-check') ? { version: '0.9.0', commit: 'a'.repeat(40) } : require('./release-config.json'));
const repository = 'hotll233/labmg';
const image = `ghcr.io/${repository}:${version}`;
const source = 'https://github.com/HotLL233/labmg';
const expectedIndexDigest = process.argv.find(argument => argument.startsWith('--index-digest='))?.slice('--index-digest='.length)
  || process.env.LABOS_EXPECTED_INDEX_DIGEST;
// Copy this runner-only helper into project/artifacts/cache/0.9.0 before executing it.
const engineHost = process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
const root = path.resolve(__dirname, '../../..');
const cache = path.join(root, 'artifacts', 'cache', version);
const releaseDirectory = path.join(root, 'artifacts', 'releases', version);
const releaseCompose = path.join(releaseDirectory, 'docker-compose.yml');
const reportPath = path.join(cache, 'ghcr-anonymous-verification.json');
const digest = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

function verifiedFixturePath(candidate) {
  const resolved = path.resolve(candidate);
  assert.equal(path.dirname(resolved), path.resolve(cache), 'fixture must be a direct child of version cache');
  assert.match(path.basename(resolved), /^ghcr-anon-[A-Za-z0-9]+$/, 'unexpected fixture name');
  assert.notEqual(resolved, path.resolve(cache));
  return resolved;
}

function platformDescriptor(index, architecture) {
  const entries = index.manifests.filter(entry => entry.platform?.os === 'linux' && entry.platform?.architecture === architecture);
  assert.equal(entries.length, 1, `expected one linux/${architecture} descriptor`);
  assert.match(entries[0].digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(entries[0].size) && entries[0].size > 0, 'platform descriptor must declare its byte size');
  return entries[0];
}

function checkLabels(config, commit) {
  const labels = config.Labels || {};
  assert.equal(labels['org.opencontainers.image.source'], source);
  assert.equal(labels['org.opencontainers.image.version'], version);
  assert.equal(labels['org.opencontainers.image.revision'], commit);
  const user = config.User?.split(':')[0];
  assert.ok(user && user !== 'root' && !/^0+$/.test(user), 'image must default to non-root');
  return { source: labels['org.opencontainers.image.source'], version, revision: commit, user: config.User };
}

function verifySourceBytes(sourceManifest, relativePath, bytes, label) {
  const entry = sourceManifest.sources.find(item => item.path === relativePath);
  assert.ok(entry, `frozen source manifest is missing ${relativePath}`);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.equal(bytes.length, entry.size, `frozen source size mismatch: ${label}`);
  assert.equal(digest(bytes), `sha256:${entry.sha256}`, `frozen source hash mismatch: ${label}`);
  return { path: label, size: bytes.length, sha256: entry.sha256 };
}

function verifyRuntimeMounts(configuration, composeBytes) {
  const runtimeDirectory = path.join(releaseDirectory, 'runtime');
  for (const name of ['labos', 'labos-init']) {
    const mount = configuration.services[name].volumes.find(volume => volume.target === '/var/lib/labos');
    assert.equal(mount.type, 'bind');
    assert.equal(path.resolve(mount.source), runtimeDirectory);
    // Compose may omit create_host_path: true in normalized output because it is the default.
    assert.notEqual(mount.bind?.create_host_path, false);
  }
  const postgres = configuration.services.postgres;
  assert.equal(postgres.image, 'postgres:18-bookworm');
  assert.equal(postgres.ports, undefined, 'PostgreSQL must not expose a host port');
  assert.equal(postgres.environment.POSTGRES_PASSWORD_FILE, '/run/labos-secrets/postgres-password');
  assert.equal(postgres.environment.POSTGRES_PASSWORD, undefined);
  assert.equal(postgres.environment.PGDATA, '/var/lib/postgresql/18/docker');
  for (const [target, directory, readOnly] of [['/var/lib/postgresql', 'postgres', false], ['/run/labos-secrets', 'secrets', true]]) {
    const mount = postgres.volumes.find(volume => volume.target === target);
    assert.equal(mount.type, 'bind'); assert.equal(path.resolve(mount.source), path.join(runtimeDirectory, directory));
    assert.notEqual(mount.bind?.create_host_path, false); assert.equal(Boolean(mount.read_only), readOnly);
  }
  assert.equal(postgres.depends_on['labos-init'].condition, 'service_completed_successfully');
  assert.equal(configuration.services.labos.depends_on.postgres.condition, 'service_healthy');
  assert.equal(configuration.services.labos.environment.PGHOST, 'postgres');
  assert.equal(configuration.services.labos.environment.DATABASE_URL, undefined);
  assert.deepEqual(Object.keys(configuration.services).sort(), ['labos', 'labos-https', 'labos-init', 'postgres']);
  const proxy = configuration.services['labos-https'];
  assert.equal(proxy.image, 'caddy:2.11.7-alpine');
  assert.equal(proxy.volumes.length, 1);
  assert.equal(proxy.volumes[0].type, 'bind');
  assert.equal(proxy.volumes[0].target, '/var/lib/labos-https');
  assert.equal(path.resolve(proxy.volumes[0].source), path.join(releaseDirectory, 'https'));
  assert.equal(proxy.environment.XDG_DATA_HOME, '/var/lib/labos-https/data');
  assert.equal(proxy.environment.XDG_CONFIG_HOME, '/var/lib/labos-https/config');
  assert.deepEqual(proxy.entrypoint, ['/bin/sh', '-ec']);
  assert.equal(proxy.command.length, 1);
  assert.match(proxy.command[0], /default_sni \{\$\$LABOS_HTTPS_HOST\}/);
  assert.equal(Object.keys(configuration.volumes || {}).length, 0);
  const text = composeBytes.toString('utf8');
  assert.ok(!/^\s+create_host_path:/m.test(text), 'Synology-compatible source must use short bind syntax');
  for (const [specification, count] of [
    ['"${LABOS_DATA_DIR:-./runtime}:/var/lib/labos"', 2],
    ['"${LABOS_DATA_DIR:-./runtime}/postgres:/var/lib/postgresql"', 1],
    ['"${LABOS_DATA_DIR:-./runtime}/secrets:/run/labos-secrets:ro"', 1],
    ['"./https:/var/lib/labos-https"', 1]
  ]) assert.equal(text.split('- ' + specification).length - 1, count, 'Frozen Compose short bind: ' + specification);
  return runtimeDirectory;
}

async function readVerifiedZip(sourceManifest) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 7) { throw 'PowerShell 7 is required' }
$launcherNewLine = [string][char]13 + [char]10
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifest = Get-Content -LiteralPath $env:LABOS_VERIFY_MANIFEST -Raw | ConvertFrom-Json
$expected = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::Ordinal)
foreach ($source in $manifest.sources) { $expected.Add($source.path, $source) }
$entries = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::Ordinal)
$archive = [System.IO.Compression.ZipFile]::OpenRead($env:LABOS_VERIFY_ARCHIVE)
function Read-Entry($entry) {
  $inputStream = $entry.Open()
  $memory = [System.IO.MemoryStream]::new()
  try { $inputStream.CopyTo($memory); return ,$memory.ToArray() }
  finally { $inputStream.Dispose(); $memory.Dispose() }
}
function Hash-Bytes([byte[]]$bytes) {
  return [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
try {
  $verified = 0
  $launcher = $null
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName.EndsWith('/')) {
      if ($entry.Length -ne 0) { throw 'ZIP directory entry contains data' }
      continue
    }
    $entries.Add($entry.FullName, $entry)
    $bytes = Read-Entry $entry
    $hash = Hash-Bytes $bytes
    if ($expected.ContainsKey($entry.FullName)) {
      $source = $expected[$entry.FullName]
      if ($entry.Length -ne $source.size -or $bytes.Length -ne $source.size -or $hash -cne $source.sha256) {
        throw ('Frozen ZIP source size/hash mismatch: ' + $entry.FullName)
      }
      $verified++
    } elseif ($entry.FullName -ceq 'start-labos.cmd') {
      $content = (@('@echo off', 'cd /d "%~dp0"',
        'if not exist "node_modules\write-excel-file\package.json" goto install',
        'if not exist "node_modules\read-excel-file\package.json" goto install',
        'if not exist "node_modules\pg\package.json" goto install',
        'if exist "node_modules\zxing-wasm\dist\full\zxing_full.wasm" goto start',
        ':install',
        '  call npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache artifacts\cache\0.9.0\npm',
        '  if errorlevel 1 exit /b 1', ':start', 'node src\server.js') -join $launcherNewLine) + $launcherNewLine
      $expectedBytes = [System.Text.Encoding]::ASCII.GetBytes($content)
      if ($bytes.Length -ne $expectedBytes.Length -or $hash -cne (Hash-Bytes $expectedBytes)) { throw 'Generated ZIP launcher differs from package.ps1 output' }
      $launcher = @{ path = $entry.FullName; size = $bytes.Length; sha256 = $hash }
    } else { throw ('Unexpected ZIP entry: ' + $entry.FullName) }
  }
  if ($verified -ne $expected.Count -or $entries.Count -ne ($expected.Count + 1) -or $null -eq $launcher) { throw 'ZIP source list is incomplete' }
  $selected = @()
  foreach ($name in @('tests/docker.test.js', 'package.json', 'deploy/docker-compose.yml', 'deploy/docker-compose.local.yml')) {
    $selected += @{ path = $name; base64 = [System.Convert]::ToBase64String((Read-Entry $entries[$name])) }
  }
  @{ verifiedSourceCount = $verified; verifiedEntryCount = $entries.Count; generatedLauncher = $launcher; selected = $selected } | ConvertTo-Json -Depth 5 -Compress
} finally { $archive.Dispose() }
`;
  const result = await execute('pwsh', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], {
    cwd: cache, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LABOS_VERIFY_MANIFEST: path.join(releaseDirectory, 'manifest.json'), LABOS_VERIFY_ARCHIVE: path.join(releaseDirectory, sourceManifest.archive) }
  });
  const verified = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  assert.equal(verified.verifiedSourceCount, sourceManifest.sources.length);
  assert.equal(verified.verifiedEntryCount, sourceManifest.sources.length + 1);
  assert.equal(verified.selected.length, 4);
  return verified;
}

async function main() {
  assert.equal(process.platform, 'linux', 'This helper is for the isolated Linux runner');
  assert.equal(process.arch, 'x64', 'The runner must be amd64; ARM64 container validation uses emulation');
  if (process.env.GITHUB_ACTIONS === 'true') assert.ok(process.env.DOCKER_HOST, 'CI must supply the selected Docker daemon socket');
  assert.ok(engineHost.startsWith('unix:///') && !/[\0?#]/.test(engineHost), 'Docker host must be an absolute local Unix socket without query or fragment');
  assert.equal(path.posix.normalize(engineHost.slice(7)), engineHost.slice(7));
  assert.equal(path.resolve(__dirname), path.resolve(cache));
  assert.match(expectedIndexDigest || '', /^sha256:[a-f0-9]{64}$/, 'Provide the independently verified published index digest using --index-digest=sha256:... or LABOS_EXPECTED_INDEX_DIGEST');
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(releaseDirectory, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(sourceManifest.version, version);
  const commit = sourceManifest.commit;
  assert.match(frozenCommit || '', /^[a-f0-9]{40}$/, 'Wait for root to supply the frozen commit');
  assert.equal(commit, frozenCommit);
  assert.match(commit || '', /^[a-f0-9]{40}$/, 'Release manifest must identify the frozen source commit');
  const peeledTag = (await execute('git', ['rev-parse', '--verify', `refs/tags/v${version}^{commit}`], {
    cwd: root, windowsHide: true, timeout: 15000
  })).stdout.trim();
  assert.equal(commit, peeledTag, 'release manifest commit must equal the peeled version tag');
  assert.equal(sourceManifest.archive, `labos-${version}.zip`);
  const sourceArchive = fs.readFileSync(path.join(releaseDirectory, sourceManifest.archive));
  assert.equal(sourceArchive.length, sourceManifest.size, 'frozen source ZIP size mismatch');
  assert.equal(digest(sourceArchive), `sha256:${sourceManifest.sha256}`, 'frozen source ZIP hash mismatch');
  const verifiedZip = await readVerifiedZip(sourceManifest);
  const frozenSources = [], frozenFiles = [];
  for (const relativePath of ['tests/docker.test.js', 'package.json', 'deploy/docker-compose.yml', 'deploy/docker-compose.local.yml']) {
    const zipEntry = verifiedZip.selected.find(entry => entry.path === relativePath);
    assert.ok(zipEntry, `verified ZIP is missing ${relativePath}`);
    const bytes = Buffer.from(zipEntry.base64, 'base64');
    frozenSources.push(verifySourceBytes(sourceManifest, relativePath, bytes, `zip:${sourceManifest.archive}:${relativePath}`));
    const gitBytes = (await execute('git', ['show', `${commit}:${relativePath}`], {
      cwd: root, windowsHide: true, timeout: 15000, encoding: 'buffer', maxBuffer: 1024 * 1024
    })).stdout;
    assert.equal(bytes.toString('utf8').replace(/\r\n/g, '\n'), gitBytes.toString('utf8').replace(/\r\n/g, '\n'), `ZIP text content differs from frozen Git tag: ${relativePath}`);
    frozenFiles.push({ relativePath, bytes });
  }
  frozenSources.push(verifySourceBytes(sourceManifest, 'deploy/docker-compose.yml', fs.readFileSync(releaseCompose), path.relative(root, releaseCompose)));
  frozenSources.push(verifySourceBytes(sourceManifest, 'deploy/docker-compose.local.yml', fs.readFileSync(path.join(releaseDirectory, 'docker-compose.local.yml')), path.relative(root, path.join(releaseDirectory, 'docker-compose.local.yml'))));
  assert.equal(JSON.parse(frozenFiles.find(file => file.relativePath === 'package.json').bytes.toString('utf8')).version, version);
  const runId = crypto.randomBytes(8).toString('hex');
  const logName = name => `ghcr-anonymous-${runId}-${name}.log`;
  const attemptReportPath = path.join(cache, `ghcr-anonymous-verification-${runId}.json`);
  const report = {
    status: 'running', version, commit, image, expectedIndexDigest,
    startedAtUtc: new Date().toISOString(), engineHost, peeledTag, frozenSources,
    sourceArchive: {
      archive: sourceManifest.archive, size: sourceManifest.size, sha256: sourceManifest.sha256,
      verifiedSourceCount: verifiedZip.verifiedSourceCount, verifiedEntryCount: verifiedZip.verifiedEntryCount,
      generatedLauncher: verifiedZip.generatedLauncher, tagTextComparison: 'passed; only CRLF/LF normalized, ZIP hashes remain byte-exact'
    },
    registry: { authentication: 'anonymous GHCR pull token; no account credentials supplied' },
    pulls: [], compose: 'not-started', postgres: null, httpsProxy: null,
    verificationEnvironment: { provider: 'GitHub Actions', os: process.platform, architecture: process.arch, runId: process.env.GITHUB_RUN_ID, headSha: process.env.GITHUB_SHA, workflowSha: process.env.GITHUB_WORKFLOW_SHA },
    boundaries: ['GitHub-hosted Linux amd64 runner; not actual Synology hardware.', 'No real var data or existing Docker credential configuration used.', 'Full released Compose lifecycle runs on amd64; both image architectures are independently pulled and inspected. ARM64 offline container lifecycle is validated separately using QEMU emulation.']
  };
  const save = () => {
    const contents = JSON.stringify(report, null, 2) + '\n';
    fs.writeFileSync(attemptReportPath, contents);
    fs.writeFileSync(reportPath, contents);
  };
  save();
  let fixture, fixtureMarker, dockerArgs, environment;
  let childStarted = false, childPassed = false;
  let failure;

  async function docker(args, log, timeout = 180000) {
    assert.ok(dockerArgs && environment, 'isolated Docker configuration not initialized');
    try {
      const result = await execute('docker', [...dockerArgs, ...args], {
        cwd: cache, env: environment, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024
      });
      if (log) fs.writeFileSync(path.join(cache, log), result.stdout + result.stderr);
      return result.stdout.trim();
    } catch (error) {
      if (log) fs.writeFileSync(path.join(cache, log), (error.stdout || '') + (error.stderr || '') + '\n' + error.message);
      throw error;
    }
  }

  try {
    const tokenResponse = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000)
    });
    report.registry.tokenHttpStatus = tokenResponse.status;
    assert.equal(tokenResponse.status, 200, 'anonymous registry token request failed');
    const tokenData = await tokenResponse.json();
    const token = tokenData.token || tokenData.access_token;
    assert.ok(typeof token === 'string' && token.length > 0, 'registry did not return an anonymous token');
    const accept = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

    async function registryJson(route, expectedDigest, expectedSize) {
      const response = await fetch(`https://ghcr.io/v2/${repository}/${route}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: accept }, signal: AbortSignal.timeout(45000)
      });
      assert.equal(response.status, 200, `anonymous registry GET ${route} failed`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actualDigest = digest(bytes);
      assert.equal(actualDigest, expectedDigest, `digest mismatch for ${route}`);
      if (expectedSize !== undefined) assert.equal(bytes.length, expectedSize, `size mismatch for ${route}`);
      const headerDigest = response.headers.get('docker-content-digest');
      if (headerDigest) assert.equal(headerDigest, actualDigest);
      return { value: JSON.parse(bytes.toString('utf8')), digest: actualDigest, size: bytes.length, httpStatus: response.status };
    }

    const index = await registryJson(`manifests/${version}`, expectedIndexDigest);
    assert.equal(index.value.schemaVersion, 2);
    assert.ok(Array.isArray(index.value.manifests));
    report.registry.index = { digest: index.digest, size: index.size, httpStatus: index.httpStatus, mediaType: index.value.mediaType };
    report.registry.architectures = [];
    for (const architecture of ['amd64', 'arm64']) {
      const descriptor = platformDescriptor(index.value, architecture);
      const manifest = await registryJson(`manifests/${descriptor.digest}`, descriptor.digest, descriptor.size);
      assert.equal(manifest.value.schemaVersion, 2);
      const configDescriptor = manifest.value.config;
      assert.match(configDescriptor.digest, /^sha256:[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(configDescriptor.size) && configDescriptor.size > 0);
      const config = await registryJson(`blobs/${configDescriptor.digest}`, configDescriptor.digest, configDescriptor.size);
      assert.equal(config.value.os, 'linux');
      assert.equal(config.value.architecture, architecture);
      report.registry.architectures.push({
        os: config.value.os, architecture, manifestDigest: manifest.digest, manifestSize: manifest.size,
        configDigest: config.digest, configSize: config.size,
        manifestHttpStatus: manifest.httpStatus, configHttpStatus: config.httpStatus,
        oci: checkLabels(config.value.config, commit)
      });
    }
    report.registry.status = 'passed';
    save();
    console.log('Anonymous index, both platform manifests/configs, hashes, sizes and OCI labels passed.');

    fixture = fs.mkdtempSync(path.join(cache, 'ghcr-anon-'));
    verifiedFixturePath(fixture);
    fixtureMarker = path.join(fixture, '.labos-anonymous-check');
    fs.writeFileSync(fixtureMarker, runId);
    const frozenRoot = path.join(fixture, 'frozen-source');
    for (const file of frozenFiles) {
      const destination = path.join(frozenRoot, file.relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.bytes);
      verifySourceBytes(sourceManifest, file.relativePath, fs.readFileSync(destination), path.relative(root, destination));
    }
    const configDirectory = path.join(fixture, 'docker-config');
    fs.mkdirSync(configDirectory);
    fs.writeFileSync(path.join(configDirectory, 'config.json'), '{}\n');
    const emptyEnv = path.join(fixture, 'empty.env');
    fs.writeFileSync(emptyEnv, '');
    environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (/^(?:DOCKER_|LABOS_|COMPOSE_)/i.test(key)) delete environment[key];
    }
    Object.assign(environment, { DOCKER_CONFIG: configDirectory, DOCKER_HOST: engineHost, LABOS_PORT: '127.0.0.1:0', LABOS_HTTPS_HOST: '127.0.0.1', LABOS_HTTPS_PORT: '127.0.0.1:0' });
    assert.equal(environment.LABOS_ADMIN_PASSWORD, undefined);
    assert.equal(environment.LABOS_IMAGE, undefined);
    assert.equal(environment.LABOS_DATA_DIR, undefined);
    dockerArgs = ['--config', configDirectory, '--host', engineHost];
    report.dockerCredentialIsolation = {
      freshConfigDirectory: path.relative(root, configDirectory), initialConfig: '{}',
      inheritedDockerVariablesCleared: true, explicitEngineHost: engineHost, existingCredentialsUsed: false
    };
    report.engine = await docker(['version', '--format', '{{.Server.Os}} {{.Server.Arch}} {{.Server.Version}}']);

    for (const architecture of ['amd64', 'arm64']) {
      const log = logName(`pull-${architecture}`);
      await docker(['pull', '--platform', `linux/${architecture}`, image], log, 240000);
      const actual = JSON.parse(await docker(['image', 'inspect', '--platform', `linux/${architecture}`, image]))[0];
      const verified = report.registry.architectures.find(item => item.architecture === architecture);
      assert.equal(actual.Os, 'linux');
      assert.equal(actual.Architecture, architecture);
      assert.ok([verified.configDigest, verified.manifestDigest].includes(actual.Id), 'Docker image ID must match the verified config or platform manifest');
      assert.ok(actual.RepoDigests.includes(`ghcr.io/${repository}@${expectedIndexDigest}`), 'pulled image must reference the verified version index');
      report.pulls.push({
        status: 'passed', os: actual.Os, architecture: actual.Architecture,
        imageId: actual.Id, repoDigests: actual.RepoDigests, oci: checkLabels(actual.Config, commit), log
      });
      save();
      console.log(`Anonymous Docker pull and inspection passed: linux/${architecture}.`);
    }

    // Record official PostgreSQL index/platform/config hashes before any mutable tag is pulled.
    report.postgres = await require('./postgres-image.cjs').verifyAndPull({ docker, logName });
    report.httpsProxy = await require('./postgres-image.cjs').verifyHttpsAndPull({ docker, logName });
    save();
    const configProject = `labos-ghcr-config-${runId}`;
    const effective = JSON.parse(await docker(['compose', '--project-name', configProject, '--env-file', emptyEnv, '--file', releaseCompose, 'config', '--format', 'json']));
    const service = effective.services.labos, initializer = effective.services['labos-init'];
    assert.equal(service.image, image);
    assert.equal(initializer.image, image);
    assert.equal(service.user, '1000:1000');
    assert.equal(initializer.user, '0:0');
    assert.equal(initializer.healthcheck.disable, true);
    assert.equal(service.depends_on['labos-init'].condition, 'service_completed_successfully');
    assert.ok(!service.environment?.LABOS_ADMIN_PASSWORD);
    const runtimeDirectory = verifyRuntimeMounts(effective, fs.readFileSync(releaseCompose));
    assert.equal(service.ports.length, 1);
    assert.equal(service.ports[0].host_ip, '127.0.0.1');
    assert.equal(String(service.ports[0].published), '0');
    report.composeEvidence = {
      releaseCompose: path.relative(root, releaseCompose), configuration: 'passed',
      standaloneComposeMatchesFrozenSource: true, frozenTestMatchesSource: true,
      defaultImage: service.image, defaultDataDirectory: path.relative(root, runtimeDirectory), dataDirectoryOverridden: false,
      initializerUser: initializer.user, applicationDefaultUser: service.user,
      adminPasswordEnvironment: 'absent', loopbackOnly: true, realVarUsed: false,
      testImageOverrideEqualsReleasedDefault: true,
      test: path.relative(root, path.join(frozenRoot, 'tests/docker.test.js')),
      frozenSnapshot: path.relative(root, frozenRoot), testLog: logName('compose-test'), resourceCleanup: 'not-confirmed'
    };
    report.compose = 'running';
    save();

    // This frozen test validates labels before deleting only its own random project and marked runtime fixture.
    // It also checks first setup/login, persistence on recreation, directory metadata and symlink rejection.
    const childEnvironment = { ...environment, LABOS_DOCKER_IMAGE: image, DOCKER_DEFAULT_PLATFORM: 'linux/amd64' };
    assert.equal(childEnvironment.DOCKER_CONFIG, configDirectory);
    assert.equal(childEnvironment.DOCKER_HOST, engineHost);
    let child;
    try {
      childStarted = true;
      child = await execute(process.execPath, ['--test', '--test-reporter=tap', path.join(frozenRoot, 'tests/docker.test.js')], {
        cwd: frozenRoot, env: childEnvironment, windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024
      });
      fs.writeFileSync(path.join(cache, report.composeEvidence.testLog), child.stdout + child.stderr);
    } catch (error) {
      fs.writeFileSync(path.join(cache, report.composeEvidence.testLog), (error.stdout || '') + (error.stderr || '') + '\n' + error.message);
      throw error;
    }
    assert.match(child.stdout, /^# pass 1\r?$/m, 'frozen Docker test did not report one pass');
    assert.match(child.stdout, /^# fail 0\r?$/m);
    assert.match(child.stdout, /^# skipped 0\r?$/m, 'Docker test must run rather than skip');
    assert.ok(child.stdout.includes('Runtime initializer preflight passed: PostgreSQL directory creation, ownership preservation and symlink rejection'), 'Frozen Docker test must complete the runtime initializer preflight');
    childPassed = true;
    Object.assign(report.composeEvidence, {
      lifecycle: 'passed', firstRunSetup: 'passed', login: 'passed', nonRootRuntimeIdentity: { uid: 12345, gid: 23456 },
      automaticRuntimeDirectoryCreation: 'passed', rootInitializer: 'passed', runtimeInitializerPreflight: 'passed', recreationPersistence: 'passed',
      existingFileMetadataPreserved: 'passed', symlinkTargetPreserved: 'passed',
      postgresql18: 'passed', noSqliteFile: 'passed', databaseSecretMetadataPreserved: 'passed',
      postgresRecreationPersistence: 'passed', attachmentPersistence: 'passed', unitIdentityPersistence: 'passed',
      imagePullPolicy: 'never', databaseHostPort: 'absent',
      materialBatchLocation: 'passed', ordinaryIssueApplicationAndAmountRedaction: 'passed',
      materialIssuePermissionCostAndIdempotency: 'passed', issueStockSourcesAndRecreationPersistence: 'passed',
      resourceCleanup: 'passed; frozen test verified ownership labels, no named volumes, and removal of its marked runtime fixture'
    });
    report.compose = 'passed';
    console.log('Frozen released Compose: adjacent runtime bind/init, non-root app, setup/login, persistence and marked cleanup passed.');
  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.error = { name: error.name, message: error.message };
    if (report.compose === 'running') report.compose = 'failed';
    console.error(error.message);
  } finally {
    const cleanup = { status: 'not-needed', composeResources: childPassed ? 'confirmed-clean-by-frozen-test' : 'not-confirmed-or-not-started' };
    try {
      if (fixture) {
        cleanup.fixtureAbsolutePathValidated = verifiedFixturePath(fixture);
        assert.equal(fs.lstatSync(fixture).isSymbolicLink(), false);
        assert.equal(fs.readFileSync(fixtureMarker, 'utf8'), runId, 'refusing to remove unmarked fixture');
        assert.ok(!childStarted || childPassed, 'Compose test did not complete successfully; retaining fixture and ownership marker for diagnosis and verified cleanup');
        fs.rmSync(cleanup.fixtureAbsolutePathValidated, { recursive: true, force: true });
        cleanup.fixtureRemoved = !fs.existsSync(fixture);
        cleanup.isolatedConfigRemoved = cleanup.fixtureRemoved;
        assert.equal(cleanup.fixtureRemoved, true);
      }
      cleanup.status = 'passed';
    } catch (error) {
      cleanup.status = 'failed';
      cleanup.error = error.message;
      failure ||= error;
      report.status = 'failed';
    }
    report.cleanup = cleanup;
    report.completedAtUtc = new Date().toISOString();
    if (!failure && report.compose === 'passed' && report.pulls.length === 2 && report.postgres?.status === 'passed' && report.httpsProxy?.status === 'passed' && cleanup.status === 'passed') report.status = 'passed';
    save();
    console.log(`Report: ${reportPath}; status=${report.status}; compose=${report.compose}; cleanup=${cleanup.status}`);
  }
  if (failure) process.exitCode = 1;
}

if (process.argv.includes('--self-check')) {
  assert.equal(digest(Buffer.from('abc')), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(verifiedFixturePath(path.join(cache, 'ghcr-anon-Ab123')), path.join(cache, 'ghcr-anon-Ab123'));
  assert.throws(() => verifiedFixturePath(path.join(root, 'var')));
  assert.throws(() => verifiedFixturePath(cache));
  assert.equal(platformDescriptor({ manifests: [{ digest: 'sha256:' + 'a'.repeat(64), size: 123, platform: { os: 'linux', architecture: 'amd64' } }] }, 'amd64').platform.architecture, 'amd64');
  assert.throws(() => platformDescriptor({ manifests: [] }, 'arm64'));
  assert.throws(() => checkLabels({ User: '0:0', Labels: {} }, 'a'.repeat(40)));
  const composeBytes = Buffer.from([
    '- "${LABOS_DATA_DIR:-./runtime}:/var/lib/labos"',
    '- "${LABOS_DATA_DIR:-./runtime}:/var/lib/labos"',
    '- "${LABOS_DATA_DIR:-./runtime}/postgres:/var/lib/postgresql"',
    '- "${LABOS_DATA_DIR:-./runtime}/secrets:/run/labos-secrets:ro"',
    '- "./https:/var/lib/labos-https"'
  ].join('\n'));
  const runtimeMount = { type: 'bind', source: path.join(releaseDirectory, 'runtime'), target: '/var/lib/labos' };
  const configuration = { services: {
    labos: { volumes: [runtimeMount], depends_on: { postgres: { condition: 'service_healthy' } }, environment: { PGHOST: 'postgres' } },
    'labos-init': { volumes: [{ ...runtimeMount, bind: { create_host_path: true } }] },
    postgres: { image: 'postgres:18-bookworm', depends_on: { 'labos-init': { condition: 'service_completed_successfully' } },
      environment: { POSTGRES_PASSWORD_FILE: '/run/labos-secrets/postgres-password', PGDATA: '/var/lib/postgresql/18/docker' }, volumes: [
        { type: 'bind', source: path.join(releaseDirectory, 'runtime/postgres'), target: '/var/lib/postgresql' },
        { type: 'bind', source: path.join(releaseDirectory, 'runtime/secrets'), target: '/run/labos-secrets', read_only: true }
      ] },
    'labos-https': { image: 'caddy:2.11.7-alpine', environment: { XDG_DATA_HOME: '/var/lib/labos-https/data', XDG_CONFIG_HOME: '/var/lib/labos-https/config' }, entrypoint: ['/bin/sh', '-ec'], command: ['default_sni {$$LABOS_HTTPS_HOST}'], volumes: [{ type: 'bind', source: path.join(releaseDirectory, 'https'), target: '/var/lib/labos-https' }] }
  } };
  assert.equal(verifyRuntimeMounts(configuration, composeBytes), path.join(releaseDirectory, 'runtime'));
  for (const mount of [{ ...runtimeMount, type: 'volume' }, { ...runtimeMount, source: path.join(root, 'var') }, { ...runtimeMount, bind: { create_host_path: false } }]) {
    assert.throws(() => verifyRuntimeMounts({ services: { ...configuration.services, labos: { volumes: [mount] } } }, composeBytes));
  }
  assert.throws(() => verifyRuntimeMounts({ ...configuration, volumes: { 'old-version-volume': {} } }, composeBytes));
  assert.throws(() => verifyRuntimeMounts(configuration, Buffer.from('')));
  assert.throws(() => verifyRuntimeMounts(configuration, Buffer.concat([composeBytes, Buffer.from('\n  create_host_path: true\n')])));
  console.log('Self-check passed. No network, Docker, credentials or runtime data accessed.');
} else if (process.argv.includes('--execute-after-public-confirmed')) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
  console.log('Prepared only. Run --self-check without network; run --execute-after-public-confirmed --index-digest=sha256:... after independently verifying the published index digest.');
}

