'use strict';
// Runner-only fallback. Copy to project/artifacts/cache/0.5.0/remote-validation/.
// node artifacts/cache/0.5.0/remote-validation/upload-draft-assets.cjs --execute-after-gates
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const root = path.resolve(__dirname, '../../../..');
const { version, commit } = require('../release-config.json');
const repository = 'HotLL233/labmg', releaseId = Number(process.env.DRAFT_RELEASE_ID);
const cache = path.join(root, 'artifacts/cache', version), directory = path.join(root, 'artifacts/releases', version);
const originalNames = ['.env.example', 'docker-compose.yml', 'docker-compose.https.yml', 'Caddyfile', 'SCANNING_HTTPS.md', 'LABEL_PRINTING.md', 'SYNOLOGY.md', 'manifest.json', `labos-${version}.zip`];
const addedNames = ['SHA256SUMS', ...['amd64', 'arm64'].flatMap(arch => [`labos-${version}-linux-${arch}.tar`, `labos-${version}-linux-${arch}.json`])];
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha256 = async file => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
function verifyAsset(remote, local) {
  assert.equal(remote.name, local.remoteName);
  assert.equal(remote.state, 'uploaded');
  assert.ok(Number.isSafeInteger(remote.id) && remote.id > 0);
  assert.equal(remote.size, local.size, `Existing asset size differs: ${local.remoteName}`);
  assert.equal(remote.digest, `sha256:${local.sha256}`, `Existing asset digest differs: ${local.remoteName}`);
}
async function main() {
  const report = { status: 'running', version, commit, stage: 'preflight', assets: [],
    verificationEnvironment: { provider: 'GitHub Actions', os: process.platform, architecture: process.arch, runId: process.env.GITHUB_RUN_ID, headSha: process.env.GITHUB_SHA, workflowSha: process.env.GITHUB_WORKFLOW_SHA } };
  const reportFile = path.join(cache, 'draft-upload-report.json');
  let token = '';
  try {
    assert.equal(path.resolve(__dirname), path.join(cache, 'remote-validation'));
    assert.match(commit || '', /^[a-f0-9]{40}$/); assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0);
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
    assert.match(process.env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
    assert.equal(process.env.GITHUB_WORKFLOW_SHA, process.env.GITHUB_SHA);
    for (const name of ['ghcr-anonymous-verification.json', 'ghcr-offline-export.json', 'upgrade-verification.json', 'https-verification.json']) {
      const gate = readJson(path.join(cache, name)), environment = gate.verificationEnvironment;
      assert.equal(gate.status, 'passed'); assert.equal(gate.commit ?? gate.newRevision, commit);
      assert.equal(environment.provider, 'GitHub Actions');
      assert.equal(environment.os, 'linux'); assert.equal(environment.architecture, 'x64');
      assert.equal(String(environment.runId), process.env.GITHUB_RUN_ID);
      assert.equal(environment.headSha, process.env.GITHUB_SHA);
      assert.equal(environment.workflowSha, process.env.GITHUB_WORKFLOW_SHA);
    }
    const upgrade = readJson(path.join(cache, 'upgrade-verification.json'));
    assert.equal(upgrade.cleanup.passed, true); assert.ok(upgrade.checks.length >= 15); assert.equal(upgrade.unitNumberingValidated, true);
    for (const flag of ['materialIntakeValidated', 'schema4MigrationValidated', 'schema5RestoreValidated']) assert.equal(upgrade[flag], true, flag);
    assert.ok(upgrade.checks.every(check => check.passed === true));
    for (const name of ['historical-040-ledger-units-accounts-roles-and-barcodes-preserved', 'receipt-location-and-version-conflict-atomic', 'closed-opening-supplement-doc-generates-units-idempotently', 'opening-xlsx-template-import-export-and-permissions', 'schema4-backup-imports-with-preserved-units-and-no-invented-documents', 'schema5-backup-restores-posted-documents-units-and-drafts']) assert.ok(upgrade.checks.some(check => check.name === name), name);
    const offline = readJson(path.join(cache, 'ghcr-offline-export.json'));
    assert.deepEqual(offline.architectures.map(entry => entry.architecture).sort(), ['amd64', 'arm64']);
    assert.ok(offline.architectures.every(entry => entry.status === 'passed' && entry.containerTest === 'passed'));
    const published = readJson(path.join(cache, 'published-index.json'));
    assert.equal(published.commit, commit); assert.match(published.indexDigest, /^sha256:[a-f0-9]{64}$/);
    const anonymous = readJson(path.join(cache, 'ghcr-anonymous-verification.json'));
    assert.equal(anonymous.compose, 'passed'); assert.equal(anonymous.cleanup.status, 'passed');
    assert.equal(anonymous.expectedIndexDigest, published.indexDigest);
    assert.equal(anonymous.registry.index.digest, published.indexDigest);
    assert.deepEqual(anonymous.pulls.filter(pull => pull.status === 'passed').map(pull => pull.architecture).sort(), ['amd64', 'arm64']);
    assert.equal(offline.indexDigest, published.indexDigest); assert.equal(offline.checksums.entries, 13);
    assert.equal(upgrade.images.new, `ghcr.io/hotll233/labmg:${version}@${published.indexDigest}`);
    assert.ok(process.env.DOCKER_HOST); assert.equal(anonymous.engineHost, process.env.DOCKER_HOST);
    assert.equal(offline.engineHost, anonymous.engineHost); assert.equal(upgrade.scope.dockerEndpoint, anonymous.engineHost);
    const https = readJson(path.join(cache, 'https-verification.json'));
    assert.equal(https.indexDigest, published.indexDigest); assert.equal(https.engineHost, anonymous.engineHost);
    assert.equal(https.cleanup.passed, true); assert.equal(https.syntheticOnly, true);
    for (const name of ['caddy-adapter-accepts-frozen-configuration', 'trusted-https-origin-and-first-setup', 'http-and-https-use-same-accounts', 'recreation-preserves-ca-and-accounts']) assert.ok(https.checks.some(check => check.name === name && check.passed), name);
    report.indexDigest = published.indexDigest;
    const manifest = readJson(path.join(directory, 'manifest.json'));
    assert.equal(manifest.version, version); assert.equal(manifest.commit, commit);
    const assets = [];
    for (const name of [...originalNames, ...addedNames]) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assets.push({ name, remoteName: name === '.env.example' ? 'env.example' : name, file, size: stat.size, sha256: await sha256(file) });
    }
    const archive = assets.find(asset => asset.name === manifest.archive);
    assert.equal(archive.name, `labos-${version}.zip`);
    assert.equal(archive.size, manifest.size); assert.equal(archive.sha256, manifest.sha256);
    for (const [name, sourcePath] of [['.env.example', 'deploy/.env.example'], ['docker-compose.yml', 'deploy/docker-compose.yml'], ['SYNOLOGY.md', 'docs/SYNOLOGY.md'], ['docker-compose.https.yml', 'deploy/docker-compose.https.yml'], ['Caddyfile', 'deploy/Caddyfile'], ['SCANNING_HTTPS.md', 'docs/SCANNING_HTTPS.md'], ['LABEL_PRINTING.md', 'docs/LABEL_PRINTING.md']]) {
      const expected = manifest.sources.find(entry => entry.path === sourcePath), actual = assets.find(asset => asset.name === name);
      assert.ok(expected); assert.equal(actual.size, expected.size); assert.equal(actual.sha256, expected.sha256);
    }
    for (const architecture of ['amd64', 'arm64']) {
      const info = readJson(path.join(directory, `labos-${version}-linux-${architecture}.json`));
      const tar = assets.find(asset => asset.name === `labos-${version}-linux-${architecture}.tar`);
      assert.equal(info.version, version); assert.equal(info.commit, commit); assert.equal(info.sourceSha256, manifest.sourceSha256);
      assert.equal(info.os, 'linux'); assert.equal(info.architecture, architecture); assert.equal(info.imageTag, `labos:${version}`);
      assert.equal(info.archive, tar.name); assert.equal(info.size, tar.size); assert.equal(info.sha256, tar.sha256);
      const verified = offline.architectures.find(entry => entry.architecture === architecture);
      assert.equal(info.imageId, verified.imageId); assert.equal(tar.size, verified.size); assert.equal(tar.sha256, verified.sha256);
    }
    const sumNames = new Set(), sums = fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/);
    assert.equal(sums.length, 13);
    for (const line of sums) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      assert.ok(match && match[2] !== 'SHA256SUMS' && !sumNames.has(match[2])); sumNames.add(match[2]);
      assert.equal(assets.find(asset => asset.name === match[2])?.sha256, match[1]);
    }
    assert.deepEqual([...sumNames].sort(), assets.filter(asset => asset.name !== 'SHA256SUMS').map(asset => asset.name).sort());
    token = process.env.GITHUB_TOKEN || ''; assert.ok(token);
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'labmg-draft-asset-fallback' };
    const api = async route => {
      const response = await fetch(`https://api.github.com/repos/${repository}${route}`, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Object.assign(Error('Official metadata request failed'), { safeCode: `HTTP_${response.status}` });
      return response.json();
    };
    const verifyDraft = release => {
      assert.equal(release.id, releaseId); assert.equal(release.draft, true);
      assert.equal(release.tag_name, `v${version}`); assert.equal(release.target_commitish, commit);
      const names = release.assets.map(asset => asset.name);
      assert.equal(new Set(names).size, names.length);
      assert.ok(names.every(name => assets.some(asset => asset.remoteName === name)));
    };
    report.stage = 'existing-draft-assets';
    let release = await api(`/releases/${releaseId}`); verifyDraft(release);
    for (const name of originalNames) {
      const local = assets.find(asset => asset.name === name), remote = release.assets.find(asset => asset.name === local.remoteName);
      assert.ok(remote, `Missing original draft asset: ${local.remoteName}`); verifyAsset(remote, local);
    }
    for (const remote of release.assets) verifyAsset(remote, assets.find(asset => asset.remoteName === remote.name));
    const upload = new URL(release.upload_url.replace(/\{.*$/, ''));
    assert.equal(upload.protocol, 'https:'); assert.equal(upload.hostname, 'uploads.github.com');
    assert.equal(upload.username, ''); assert.equal(upload.password, '');
    assert.equal(upload.pathname, `/repos/${repository}/releases/${releaseId}/assets`);
    for (const local of assets) {
      let remote = release.assets.find(asset => asset.name === local.remoteName);
      if (!remote) {
        assert.ok(addedNames.includes(local.name), 'Original draft assets must never be uploaded or replaced');
        report.stage = `upload-${local.remoteName}`;
        const destination = new URL(upload); destination.searchParams.set('name', local.remoteName);
        const response = await fetch(destination, { method: 'POST', duplex: 'half', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(local.size) }, body: Readable.toWeb(fs.createReadStream(local.file)), signal: AbortSignal.timeout(300000) });
        if (!response.ok) throw Object.assign(Error('Draft asset upload failed'), { safeCode: `HTTP_${response.status}` });
        remote = await response.json(); verifyAsset(remote, local);
        release = await api(`/releases/${releaseId}`); verifyDraft(release);
        const stored = release.assets.find(asset => asset.name === local.remoteName); verifyAsset(stored, local);
        assert.equal(stored.id, remote.id); remote = stored;
      }
      verifyAsset(remote, local);
      report.assets.push({ name: remote.name, id: remote.id, digest: remote.digest, size: remote.size });
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    }
    release = await api(`/releases/${releaseId}`); verifyDraft(release);
    assert.deepEqual(release.assets.map(asset => asset.name).sort(), assets.map(asset => asset.remoteName).sort());
    for (const local of assets) verifyAsset(release.assets.find(asset => asset.name === local.remoteName), local);
    report.stage = 'draft-retained-and-all-fourteen-assets-verified'; report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.errorCode = error.safeCode || (error.code === 'ERR_ASSERTION' ? 'VERIFICATION_FAILED' : 'OPERATION_FAILED'); process.exitCode = 1;
  } finally {
    token = ''; fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, stage: report.stage, assets: report.assets.length, errorCode: report.errorCode }));
  }
}
if (require.main === module) {
  if (process.argv.includes('--execute-after-gates')) main();
  else console.log('Prepared only. Run --execute-after-gates on the GitHub runner after all four gates pass; the release remains draft.');
}
module.exports = { verifyAsset };
