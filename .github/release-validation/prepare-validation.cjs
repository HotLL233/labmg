'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const repository = 'HotLL233/labmg';
const api = `https://api.github.com/repos/${repository}`;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function settings(env, version) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(env.RELEASE_TAG, `v${version}`);
  assert.match(env.FROZEN_COMMIT || '', /^[a-f0-9]{40}$/);
  assert.match(env.INDEX_DIGEST || '', /^sha256:[a-f0-9]{64}$/);
  for (const name of ['DRAFT_RELEASE_ID', 'BUILD_RUN_ID']) {
    assert.match(env[name] || '', /^[1-9]\d*$/);
    assert.ok(Number.isSafeInteger(Number(env[name])));
  }
  return { version, commit: env.FROZEN_COMMIT, indexDigest: env.INDEX_DIGEST, releaseId: Number(env.DRAFT_RELEASE_ID), buildRunId: Number(env.BUILD_RUN_ID) };
}

function verifyBuildEvidence(run, job, log, config) {
  assert.equal(run.id, config.buildRunId);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_sha, config.commit);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(job.run_id, config.buildRunId);
  assert.equal(job.name, 'publish');
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  const marker = `LABOS_PUBLISHED_INDEX version=${config.version} commit=${config.commit} digest=${config.indexDigest}`;
  assert.ok(log.split(/\r?\n/).some(line => line.endsWith(marker)), 'Official successful publish log must bind this version, commit and index digest');
  return { version: config.version, commit: config.commit, runId: run.id, runUrl: run.html_url, jobId: job.id, indexDigest: config.indexDigest, source: 'authenticated successful Actions publish job log', logSha256: hash(log), marker };
}

function verifyDraft(draft, config) {
  assert.equal(draft.id, config.releaseId);
  assert.equal(draft.draft, true, 'Deployment validation may only extend a private draft');
  assert.equal(draft.prerelease, true);
  assert.equal(draft.tag_name, `v${config.version}`);
  assert.equal(draft.target_commitish, config.commit);
  assert.equal(new Set(draft.assets.map(asset => asset.name)).size, draft.assets.length);
  const original = ['manifest.json', `labos-${config.version}.zip`, 'docker-compose.yml', 'docker-compose.local.yml', 'SYNOLOGY.md', 'SCANNING_HTTPS.md', 'LABEL_PRINTING.md'];
  const allowed = [...original, 'SHA256SUMS', ...['amd64', 'arm64'].flatMap(arch => [`labos-${config.version}-linux-${arch}.tar`, `labos-${config.version}-linux-${arch}.json`])];
  assert.ok(draft.assets.every(asset => allowed.includes(asset.name)), 'Draft contains an unexpected asset');
  for (const name of original) assert.equal(draft.assets.filter(asset => asset.name === name).length, 1, `Missing frozen draft input: ${name}`);
  return original;
}

async function main() {
  const root = process.cwd();
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const config = settings(process.env, version);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), config.commit);
  assert.equal(execFileSync('git', ['rev-parse', `${process.env.RELEASE_TAG}^{commit}`], { encoding: 'utf8' }).trim(), config.commit);
  const token = process.env.GITHUB_TOKEN;
  assert.ok(token, 'A repository-scoped GitHub token is required to read the private draft');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'labmg-release-validation' };
  const request = async route => {
    const response = await fetch(api + route, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok, `Official metadata lookup failed: ${response.status}`);
    return response.json();
  };
  const run = await request(`/actions/runs/${config.buildRunId}`);
  const jobs = await request(`/actions/runs/${config.buildRunId}/jobs?per_page=100`);
  const publishing = jobs.jobs.filter(job => job.name === 'publish');
  assert.equal(publishing.length, 1);
  const job = publishing[0];
  const logResponse = await fetch(api + `/actions/jobs/${job.id}/logs`, { headers, signal: AbortSignal.timeout(30000) });
  assert.ok(logResponse.ok, `Official publish log download failed: ${logResponse.status}`);
  const log = await logResponse.text();
  assert.ok(!log.includes(token), 'Refusing to retain evidence containing an unmasked token');
  const published = verifyBuildEvidence(run, job, log, config);
  const draft = await request(`/releases/${config.releaseId}`);
  verifyDraft(draft, config);
  const cache = path.join(root, 'artifacts/cache', version);
  const release = path.join(root, 'artifacts/releases', version);
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(release, { recursive: true });
  for (const name of ['export-ghcr-offline.cjs', 'postgres-image.cjs', 'verify-ghcr-anonymous.cjs', 'verify-https.cjs', 'verify-postgresql.cjs', 'verify-runtime-backup.cjs']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(cache, name), fs.constants.COPYFILE_EXCL);
  }
  fs.mkdirSync(path.join(cache, 'remote-validation'));
  fs.copyFileSync(path.join(__dirname, 'upload-draft-assets.cjs'), path.join(cache, 'remote-validation/upload-draft-assets.cjs'), fs.constants.COPYFILE_EXCL);
  const write = (name, value) => fs.writeFileSync(path.join(cache, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  write('release-config.json', { version, commit: config.commit, indexDigest: config.indexDigest, status: 'source-frozen', buildRunId: config.buildRunId });
  write('published-index.json', published);
  const inputs = [];
  for (const name of draft.assets.map(asset => asset.name)) {
    const asset = draft.assets.find(value => value.name === name);
    assert.equal(asset.state, 'uploaded');
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
    assert.match(asset.digest || '', /^sha256:[a-f0-9]{64}$/);
    let response = await fetch(api + `/releases/assets/${asset.id}`, { headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'manual', signal: AbortSignal.timeout(300000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = new URL(response.headers.get('location'));
      assert.ok(target.protocol === 'https:' && !target.username && !target.password && (target.hostname.endsWith('.githubusercontent.com') || target.hostname.endsWith('.blob.core.windows.net')), 'Unexpected official asset redirect');
      response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(300000) });
    }
    assert.ok(response.ok && response.body, `Frozen draft download failed: ${response.status}`);
    let size = 0;
    const digest = crypto.createHash('sha256');
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, done) { size += chunk.length; digest.update(chunk); done(null, chunk); } }), fs.createWriteStream(path.join(release, name), { flags: 'wx' }));
    const sha256 = digest.digest('hex');
    assert.equal(size, asset.size);
    assert.equal(`sha256:${sha256}`, asset.digest);
    inputs.push({ name, assetId: asset.id, size, sha256 });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(release, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(manifest.version, version);
  assert.equal(manifest.commit, config.commit);
  const archive = inputs.find(input => input.name === manifest.archive);
  assert.ok(archive);
  assert.equal(manifest.sha256, archive.sha256);
  assert.equal(manifest.size, archive.size);
  write('official-inputs.json', { repository, draftReleaseId: draft.id, commit: config.commit, assets: inputs, environment: 'GitHub Actions hosted Ubuntu', authenticatedGitHubApi: true, authenticatedDraftDownloads: true, anonymousDraftDownloads: false, publicRelease: false, existingAssetsDownloadedForExactReuse: inputs.length > 7 });
  write('validation-inputs.json', { status: 'passed', version, commit: config.commit, indexDigest: config.indexDigest, buildRunId: config.buildRunId, draftReleaseId: config.releaseId, helperSource: require('./upstream.json').commit, releaseRetainedDraft: true });
  console.log(`Prepared authenticated frozen inputs for ${version}; draft remains private, anonymous registry/HTTP gates have not run yet.`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { settings, verifyBuildEvidence, verifyDraft };
