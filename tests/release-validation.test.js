const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { settings, verifyBuildEvidence, verifyDraft } = require('../.github/release-validation/prepare-validation.cjs');
const { evidence: httpEvidence } = require('../.github/release-validation/capture-http-evidence.cjs');

const version = '9.8.7', commit = 'a'.repeat(40), digest = 'sha256:' + 'b'.repeat(64);
const env = { RELEASE_TAG: `v${version}`, FROZEN_COMMIT: commit, INDEX_DIGEST: digest, DRAFT_RELEASE_ID: '11', BUILD_RUN_ID: '22' };
const config = settings(env, version);

test('deployment inputs require an exact version, commit, digest and positive official IDs', () => {
  assert.equal(config.version, version);
  assert.equal(config.commit, commit);
  for (const change of [{ RELEASE_TAG: 'latest' }, { FROZEN_COMMIT: 'main' }, { INDEX_DIGEST: 'latest' }, { BUILD_RUN_ID: '0' }, { DRAFT_RELEASE_ID: '9007199254740992' }]) {
    assert.throws(() => settings({ ...env, ...change }, version));
  }
});

test('deployment evidence must come from the same successful official frozen build', () => {
  const run = { id: 22, repository: { full_name: 'HotLL233/labmg' }, head_sha: commit, status: 'completed', conclusion: 'success', html_url: 'https://github.com/HotLL233/labmg/actions/runs/22' };
  const job = { id: 33, run_id: 22, name: 'publish', status: 'completed', conclusion: 'success' };
  const log = `2026-10-30T00:00:00Z LABOS_PUBLISHED_INDEX version=${version} commit=${commit} digest=${digest}\n`;
  assert.equal(verifyBuildEvidence(run, job, log, config).indexDigest, digest);
  for (const change of [{ id: 23 }, { head_sha: 'c'.repeat(40) }, { conclusion: 'failure' }, { repository: { full_name: 'someone/else' } }]) {
    assert.throws(() => verifyBuildEvidence({ ...run, ...change }, job, log, config));
  }
  assert.throws(() => verifyBuildEvidence(run, { ...job, run_id: 23 }, log, config));
  assert.throws(() => verifyBuildEvidence(run, { ...job, conclusion: 'failure' }, log, config));
  assert.throws(() => verifyBuildEvidence(run, job, log.replace(digest, 'sha256:' + 'c'.repeat(64)), config));
});

test('only a matching private draft with all seven frozen inputs can enter validation', () => {
  const names = ['manifest.json', `labos-${version}.zip`, 'docker-compose.yml', 'docker-compose.local.yml', 'SYNOLOGY.md', 'SCANNING_HTTPS.md', 'LABEL_PRINTING.md'];
  const draft = { id: 11, draft: true, prerelease: true, tag_name: `v${version}`, target_commitish: commit, assets: names.map(name => ({ name })) };
  assert.deepEqual(verifyDraft(draft, config), names);
  assert.throws(() => verifyDraft({ ...draft, draft: false }, config));
  assert.throws(() => verifyDraft({ ...draft, target_commitish: 'main' }, config));
  assert.throws(() => verifyDraft({ ...draft, assets: draft.assets.slice(1) }, config));
  assert.throws(() => verifyDraft({ ...draft, assets: [...draft.assets, draft.assets[0]] }, config));
  assert.throws(() => verifyDraft({ ...draft, assets: [...draft.assets, { name: 'unexpected.txt' }] }, config));
});

test('anonymous HTTP evidence is explicitly bound to the same completed frozen Compose test', () => {
  const source = fs.readFileSync(path.join(__dirname, 'docker.test.js'));
  const frozen = { path: 'tests/docker.test.js', size: source.length, sha256: crypto.createHash('sha256').update(source).digest('hex') };
  const anonymous = { status: 'passed', compose: 'passed', version, commit, composeEvidence: { lifecycle: 'passed', loopbackOnly: true, testLog: 'fixture.log' }, dockerCredentialIsolation: { existingCredentialsUsed: false }, verificationEnvironment: { runId: '22' } };
  const log = Buffer.from('# pass 1\n# fail 0\n# skipped 0\n');
  const report = httpEvidence(anonymous, source, log, frozen);
  assert.equal(report.requestCookie, false);
  assert.equal(report.requestAuthorization, false);
  assert.equal(report.method, 'captured-frozen-compose-test-http-assertions');
  assert.equal(report.routes.length, 3);
  assert.throws(() => httpEvidence(anonymous, source, Buffer.from('# pass 1\n# fail 0\n# skipped 1\n'), frozen));
  assert.throws(() => httpEvidence({ ...anonymous, dockerCredentialIsolation: { existingCredentialsUsed: true } }, source, log, frozen));
  assert.throws(() => httpEvidence(anonymous, source, log, { ...frozen, sha256: 'c'.repeat(64) }));
});

test('restored deployment helpers remain syntax-valid and pass their offline evidence contracts', { timeout: 30000 }, () => {
  const directory = path.join(__dirname, '../.github/release-validation');
  const upstream = JSON.parse(fs.readFileSync(path.join(directory, 'upstream.json'), 'utf8'));
  assert.equal(upstream.commit, '7abc4f8569f1b5a7ebb66aa09d2007832364e16c');
  assert.equal(Object.keys(upstream.files).length, 7);
  for (const name of Object.keys(upstream.files)) {
    assert.match(upstream.files[name], /^[a-f0-9]{40}$/);
    new vm.Script(fs.readFileSync(path.join(directory, name), 'utf8'), { filename: name });
  }
  for (const name of ['postgres-image.cjs', 'verify-ghcr-anonymous.cjs', 'verify-https.cjs', 'verify-postgresql.cjs', 'verify-runtime-backup.cjs']) {
    const result = spawnSync(process.execPath, [path.join(directory, name), '--self-check'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, name + ': ' + result.stdout + result.stderr);
  }
  assert.match(fs.readFileSync(path.join(directory, 'verify-ghcr-anonymous.cjs'), 'utf8'), /\$manifest\.version \+ '\\npm'/);
  assert.match(fs.readFileSync(path.join(directory, 'verify-runtime-backup.cjs'), 'utf8'), /require\('\.\/release-config\.json'\)/);
});
