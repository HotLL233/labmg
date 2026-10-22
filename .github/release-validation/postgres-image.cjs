'use strict';
// Official Docker Hub dependency verification, shared by runner-only gates.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const tag = 'postgres:18-bookworm', httpsTag = 'caddy:2.11.7-alpine';
const sha = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^sha256:[a-f0-9]{64}$/;
function descriptor(index, architecture) {
  const matching = index.manifests.filter(row => row.platform?.os === 'linux' && row.platform?.architecture === architecture);
  assert.equal(matching.length, 1); const value = matching[0];
  assert.match(value.digest, digestPattern); assert.ok(Number.isSafeInteger(value.size) && value.size > 0); return value;
}
function checkPostgresImage(actual, remote, indexDigest, requireRepositoryDigest = true) {
  return checkOfficialImage('postgres', actual, remote, indexDigest, requireRepositoryDigest);
}
function checkHttpsImage(actual, remote, indexDigest, requireRepositoryDigest = true) {
  return checkOfficialImage('caddy', actual, remote, indexDigest, requireRepositoryDigest);
}
function checkOfficialImage(repository, actual, remote, indexDigest, requireRepositoryDigest) {
  assert.ok(remote); assert.equal(actual.Os, 'linux'); assert.equal(actual.Architecture, remote.architecture);
  assert.ok([remote.configDigest, remote.manifestDigest].includes(actual.Id), repository + ' image ID must match its verified platform/config digest');
  assert.match(indexDigest, digestPattern);
  if (requireRepositoryDigest) assert.ok(actual.RepoDigests.some(value => new RegExp('^(?:docker\\.io/library/)?' + repository + '@').test(value) && value.endsWith('@' + indexDigest)), repository + ' image must retain the verified official index digest');
}
async function verifyAndPull({ docker, logName }) {
  return verifyOfficialAndPull({ docker, logName, imageTag: tag, repository: 'postgres' });
}
async function verifyHttpsAndPull({ docker, logName }) {
  return verifyOfficialAndPull({ docker, logName, imageTag: httpsTag, repository: 'caddy' });
}
async function verifyOfficialAndPull({ docker, logName, imageTag, repository }) {
  const auth = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/${repository}:pull`, { signal: AbortSignal.timeout(30000) });
  assert.equal(auth.status, 200); const { token, access_token: accessToken } = await auth.json();
  const bearer = token || accessToken; assert.ok(typeof bearer === 'string' && bearer.length > 0);
  const accept = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
  async function get(route, expectedDigest, expectedSize) {
    const response = await fetch(`https://registry-1.docker.io/v2/library/${repository}/${route}`, { headers: { Accept: accept, Authorization: 'Bearer ' + bearer }, signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer());
    const digest = sha(bytes), header = response.headers.get('docker-content-digest');
    if (expectedDigest) assert.equal(digest, expectedDigest);
    if (expectedSize !== undefined) assert.equal(bytes.length, expectedSize);
    if (header) assert.equal(header, digest);
    return { value: JSON.parse(bytes.toString('utf8')), digest, size: bytes.length };
  }
  const index = await get('manifests/' + imageTag.split(':')[1]);
  assert.equal(index.value.schemaVersion, 2); assert.ok(Array.isArray(index.value.manifests));
  const report = { status: 'running', imageTag, registry: 'registry-1.docker.io/library/' + repository, authentication: 'anonymous pull token', indexDigest: index.digest, indexSize: index.size, architectures: [] };
  for (const architecture of ['amd64', 'arm64']) {
    const platform = descriptor(index.value, architecture), manifest = await get('manifests/' + platform.digest, platform.digest, platform.size);
    assert.equal(manifest.value.schemaVersion, 2); const configDescriptor = manifest.value.config;
    assert.match(configDescriptor.digest, digestPattern); assert.ok(Number.isSafeInteger(configDescriptor.size) && configDescriptor.size > 0);
    const config = await get('blobs/' + configDescriptor.digest, configDescriptor.digest, configDescriptor.size);
    assert.equal(config.value.os, 'linux'); assert.equal(config.value.architecture, architecture);
    const remote = { os: 'linux', architecture, manifestDigest: manifest.digest, manifestSize: manifest.size, configDigest: config.digest, configSize: config.size };
    const log = logName(repository + '-pull-' + architecture);
    await docker(['pull', '--platform', `linux/${architecture}`, `${imageTag}@${index.digest}`], log, 300000);
    const actual = JSON.parse(await docker(['image', 'inspect', '--platform', `linux/${architecture}`, `${imageTag}@${index.digest}`]))[0];
    checkOfficialImage(repository, actual, remote, index.digest, true);
    report.architectures.push({ ...remote, imageId: actual.Id, repoDigests: actual.RepoDigests, status: 'passed', log });
  }
  let prior;
  try { prior = JSON.parse(await docker(['image', 'inspect', imageTag]))[0]; }
  catch (error) { if (!/No such image/.test((error.stderr || '') + error.message)) throw error; }
  if (prior) assert.ok(prior.RepoDigests.some(value => value.endsWith('@' + index.digest)), 'Refuse to replace a differing local ' + repository + ' tag');
  else await docker(['image', 'tag', `${imageTag}@${index.digest}`, imageTag]);
  for (const remote of report.architectures) checkOfficialImage(repository, JSON.parse(await docker(['image', 'inspect', '--platform', `linux/${remote.architecture}`, imageTag]))[0], remote, index.digest, true);
  report.status = 'passed'; return report;
}
function bundleImages(appActual, appRemote, pgActual, pgRemote, pgIndexDigest, imageTag, appIndexDigest, httpsActual, httpsRemote, httpsIndexDigest) {
  return [
    { role: 'application', imageTag, imageId: appActual.Id, digest: appIndexDigest, manifestDigest: appRemote.manifestDigest, configDigest: appRemote.configDigest, os: appActual.Os, architecture: appActual.Architecture },
    { role: 'database', imageTag: tag, imageId: pgActual.Id, digest: pgIndexDigest, manifestDigest: pgRemote.manifestDigest, configDigest: pgRemote.configDigest, os: pgActual.Os, architecture: pgActual.Architecture },
    { role: 'https-proxy', imageTag: httpsTag, imageId: httpsActual.Id, digest: httpsIndexDigest, manifestDigest: httpsRemote.manifestDigest, configDigest: httpsRemote.configDigest, os: httpsActual.Os, architecture: httpsActual.Architecture }
  ];
}
function verifyBundleMetadata(metadata, postgres, architecture, appRemote, imageTag, httpsProxy) {
  assert.equal(postgres.status, 'passed'); assert.equal(httpsProxy.status, 'passed'); assert.equal(metadata.images.length, 3);
  const pgRemote = postgres.architectures.find(row => row.architecture === architecture);
  const httpsRemote = httpsProxy.architectures.find(row => row.architecture === architecture);
  for (const [role, expectedTag, remote, index] of [['application', imageTag, appRemote, metadata.images.find(row => row.role === 'application')?.digest], ['database', tag, pgRemote, postgres.indexDigest], ['https-proxy', httpsTag, httpsRemote, httpsProxy.indexDigest]]) {
    assert.ok(remote, role + ' platform must be verified');
    const entries = metadata.images.filter(row => row.role === role); assert.equal(entries.length, 1); const actual = entries[0];
    assert.equal(actual.imageTag, expectedTag); assert.equal(actual.os, 'linux'); assert.equal(actual.architecture, architecture);
    assert.ok([remote.configDigest, remote.manifestDigest].includes(actual.imageId));
    assert.equal(actual.configDigest, remote.configDigest); assert.equal(actual.manifestDigest, remote.manifestDigest);
    assert.match(actual.digest, digestPattern); assert.equal(actual.digest, index);
  }
  assert.equal(metadata.images.find(row => row.role === 'application').imageId, metadata.imageId);
  const database = metadata.images.find(row => row.role === 'database');
  for (const field of ['imageTag', 'imageId', 'digest', 'os', 'architecture']) assert.equal(metadata.databaseImage[field], database[field]);
  const https = metadata.images.find(row => row.role === 'https-proxy');
  for (const field of ['imageTag', 'imageId', 'digest', 'os', 'architecture']) assert.equal(metadata.httpsImage[field], https[field]);
}
async function verifySavedBundle({ archive, metadata, run, architecture, imageTag, pgRemote, appRemote, httpsRemote }) {
  const manifest = JSON.parse(await run('tar', ['-xOf', archive, 'manifest.json'], null, 30000));
  assert.ok(Array.isArray(manifest)); assert.equal(manifest.length, 3, 'Offline TAR must contain exactly the application, PostgreSQL and Caddy images');
  const expected = [[imageTag, appRemote], [tag, pgRemote], [httpsTag, httpsRemote]];
  assert.deepEqual(manifest.flatMap(row => row.RepoTags || []).sort(), expected.map(([name]) => name).sort());
  for (const [name, remote] of expected) {
    const rows = manifest.filter(row => row.RepoTags?.includes(name)); assert.equal(rows.length, 1);
    const configPath = rows[0].Config;
    assert.ok(typeof configPath === 'string' && /^[A-Za-z0-9_./-]+$/.test(configPath) && !configPath.startsWith('/') && configPath.split('/').every(part => part && part !== '.' && part !== '..'));
    // JSON config blobs are UTF-8 without surrounding whitespace in Docker's export.
    // readFile through tar must preserve raw bytes: request a Buffer rather than run()'s trim().
    const { execFile } = require('node:child_process'), { promisify } = require('node:util');
    const raw = (await promisify(execFile)('tar', ['-xOf', archive, configPath], { encoding: 'buffer', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout;
    assert.equal(sha(raw), remote.configDigest); const config = JSON.parse(raw.toString('utf8'));
    assert.equal(config.os, 'linux'); assert.equal(config.architecture, architecture);
  }
  assert.equal(metadata.images.length, 3);
}
if (require.main === module && process.argv.includes('--self-check')) {
  const pgRemote = { architecture: 'amd64', configDigest: 'sha256:' + 'a'.repeat(64), manifestDigest: 'sha256:' + 'b'.repeat(64) };
  const index = 'sha256:' + 'c'.repeat(64), appIndex = 'sha256:' + 'd'.repeat(64);
  const actual = { Os: 'linux', Architecture: 'amd64', Id: pgRemote.configDigest, RepoDigests: ['postgres@' + index] };
  checkPostgresImage(actual, pgRemote, index);
  assert.throws(() => checkPostgresImage({ ...actual, Architecture: 'arm64' }, pgRemote, index));
  assert.throws(() => checkPostgresImage({ ...actual, RepoDigests: ['untrusted@' + index] }, pgRemote, index));
  const httpsActual = { ...actual, RepoDigests: ['caddy@' + index] };
  checkHttpsImage(httpsActual, pgRemote, index);
  assert.throws(() => checkHttpsImage(actual, pgRemote, index));
  const images = bundleImages(actual, pgRemote, actual, pgRemote, index, 'labos:0.11.0', appIndex, httpsActual, pgRemote, index);
  const metadata = { images, imageId: actual.Id, databaseImage: images[1], httpsImage: images[2] }, postgres = { status: 'passed', indexDigest: index, architectures: [pgRemote] }, httpsProxy = { status: 'passed', indexDigest: index, architectures: [pgRemote] };
  verifyBundleMetadata(metadata, postgres, 'amd64', pgRemote, 'labos:0.11.0', httpsProxy);
  assert.throws(() => verifyBundleMetadata({ ...metadata, images: [images[0], images[1]] }, postgres, 'amd64', pgRemote, 'labos:0.11.0', httpsProxy));
  assert.throws(() => verifyBundleMetadata({ ...metadata, httpsImage: { ...metadata.httpsImage, digest: appIndex } }, postgres, 'amd64', pgRemote, 'labos:0.11.0', httpsProxy));
  console.log('PostgreSQL/Caddy identity and three-image bundle checks passed; no registry, Docker, credentials or runtime access.');
}
module.exports = { verifyAndPull, verifyHttpsAndPull, checkPostgresImage, checkHttpsImage, bundleImages, verifyBundleMetadata, verifySavedBundle };
