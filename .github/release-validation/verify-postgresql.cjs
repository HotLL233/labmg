'use strict';
// Gate 2 binds the completed frozen Compose test to explicit fresh-PG evidence.
// It does not rerun the test or claim any SQLite migration/upgrade coverage.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { version, commit } = process.argv.includes('--self-check') ? { version: '0.10.1', commit: 'a'.repeat(40) } : require('./release-config.json');
const root = path.resolve(__dirname, '../../..'), cache = path.join(root, 'artifacts/cache', version);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = name => JSON.parse(fs.readFileSync(path.join(cache, name), 'utf8').replace(/^\uFEFF/, ''));
const names = ['postgresql18-and-no-sqlite-file', 'internal-database-port-and-readonly-secret-mount', 'secret-bytes-and-metadata-preserved', 'accounts-attachments-stock-and-unit-identities-persist-after-full-recreation', 'ordinary-issue-permissions-and-amount-redaction', 'marked-project-and-runtime-cleanup'];
function assertFreshGate(gate, anonymous) {
  assert.equal(gate.status, 'passed'); assert.equal(gate.version, version); assert.equal(gate.commit, commit);
  assert.equal(gate.runtimeInitializerPreflight, 'passed'); assert.equal(anonymous.composeEvidence?.runtimeInitializerPreflight, 'passed');
  assert.equal(gate.method, 'captured-frozen-compose-test'); assert.equal(gate.database, 'PostgreSQL 18');
  assert.equal(gate.sqliteMigrationAttempted, false); assert.equal(gate.syntheticOnly, true);
  assert.equal(gate.indexDigest, anonymous.expectedIndexDigest); assert.equal(gate.postgresIndexDigest, anonymous.postgres.indexDigest);
  assert.equal(gate.httpsProxyIndexDigest, anonymous.httpsProxy.indexDigest);
  assert.equal(gate.engineHost, anonymous.engineHost); assert.equal(gate.platform, 'linux/amd64');
  assert.equal(gate.cleanup.passed, true); assert.equal(gate.imagePullPolicy, 'never');
  assert.deepEqual(gate.checks.map(row => row.name).sort(), [...names].sort()); assert.ok(gate.checks.every(row => row.passed === true));
  assert.match(gate.frozenTest.sha256, /^[a-f0-9]{64}$/); assert.match(gate.testLog.sha256, /^[a-f0-9]{64}$/);
  for (const key of ['provider', 'os', 'architecture', 'runId', 'headSha', 'workflowSha']) assert.equal(gate.verificationEnvironment[key], anonymous.verificationEnvironment[key]);
}
function main() {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(path.resolve(__dirname), cache); assert.match(commit, /^[a-f0-9]{40}$/);
  const anonymous = read('ghcr-anonymous-verification.json');
  assert.equal(anonymous.status, 'passed'); assert.equal(anonymous.version, version); assert.equal(anonymous.commit, commit);
  assert.equal(anonymous.compose, 'passed'); assert.equal(anonymous.cleanup.status, 'passed'); assert.equal(anonymous.postgres.status, 'passed'); assert.equal(anonymous.httpsProxy.status, 'passed');
  const evidence = anonymous.composeEvidence;
  for (const flag of ['runtimeInitializerPreflight', 'lifecycle', 'firstRunSetup', 'login', 'postgresql18', 'noSqliteFile', 'databaseSecretMetadataPreserved', 'postgresRecreationPersistence', 'attachmentPersistence', 'unitIdentityPersistence', 'ordinaryIssueApplicationAndAmountRedaction']) assert.equal(evidence[flag], 'passed', flag);
  assert.equal(evidence.imagePullPolicy, 'never'); assert.equal(evidence.databaseHostPort, 'absent');
  const logName = evidence.testLog; assert.equal(path.basename(logName), logName); assert.match(logName, /^ghcr-anonymous-[a-f0-9]+-compose-test\.log$/);
  const logPath = path.join(cache, logName); assert.ok(fs.lstatSync(logPath).isFile() && !fs.lstatSync(logPath).isSymbolicLink());
  const log = fs.readFileSync(logPath); assert.ok(log.toString('utf8').includes('Runtime initializer preflight passed: PostgreSQL directory creation, ownership preservation and symlink rejection'), 'Captured frozen log must record the runtime initializer preflight'); for (const pattern of [/^# pass 1\r?$/m, /^# fail 0\r?$/m, /^# skipped 0\r?$/m]) assert.match(log.toString('utf8'), pattern);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/releases', version, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(manifest.commit, commit); const frozen = manifest.sources.find(row => row.path === 'tests/docker.test.js'); assert.ok(frozen);
  const frozenSource = anonymous.frozenSources.find(row => row.path.endsWith(':tests/docker.test.js'));
  assert.ok(frozenSource); assert.equal(frozenSource.sha256, frozen.sha256); assert.equal(frozenSource.size, frozen.size);
  const report = { status: 'passed', version, commit, database: 'PostgreSQL 18', method: 'captured-frozen-compose-test',
    runtimeInitializerPreflight: 'passed', syntheticOnly: true, sqliteMigrationAttempted: false, platform: 'linux/amd64', engineHost: anonymous.engineHost,
    indexDigest: anonymous.expectedIndexDigest, postgresIndexDigest: anonymous.postgres.indexDigest, httpsProxyIndexDigest: anonymous.httpsProxy.indexDigest,
    imagePullPolicy: 'never', checks: names.map(name => ({ name, passed: true })), cleanup: { passed: true, source: 'frozen Compose test and anonymous gate' },
    frozenTest: { path: frozen.path, size: frozen.size, sha256: frozen.sha256 }, testLog: { path: logName, size: log.length, sha256: sha(log) },
    verificationEnvironment: anonymous.verificationEnvironment, checkedAtUtc: new Date().toISOString(),
    boundaries: ['Evidence is derived from the same completed frozen Compose test in gate 1; this step does not execute a second test.', 'Fresh PostgreSQL installation and full container recreation only. No SQLite migration or existing business data is used.', 'Physical NAS, phone, printer and long-term concurrency are not covered.'] };
  assertFreshGate(report, anonymous); fs.writeFileSync(path.join(cache, 'postgresql-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, method: report.method, checks: names.length }));
}
if (require.main === module) {
  if (process.argv.includes('--self-check')) {
    const anonymous = { composeEvidence: { runtimeInitializerPreflight: 'passed' }, expectedIndexDigest: 'sha256:' + 'b'.repeat(64), postgres: { indexDigest: 'sha256:' + 'c'.repeat(64) }, httpsProxy: { indexDigest: 'sha256:' + 'f'.repeat(64) }, engineHost: 'unix:///var/run/docker.sock', verificationEnvironment: { provider: 'GitHub Actions' } };
    const report = { status: 'passed', version, commit, runtimeInitializerPreflight: 'passed', method: 'captured-frozen-compose-test', database: 'PostgreSQL 18', sqliteMigrationAttempted: false, syntheticOnly: true, indexDigest: anonymous.expectedIndexDigest, postgresIndexDigest: anonymous.postgres.indexDigest, httpsProxyIndexDigest: anonymous.httpsProxy.indexDigest, engineHost: anonymous.engineHost, platform: 'linux/amd64', cleanup: { passed: true }, imagePullPolicy: 'never', checks: names.map(name => ({ name, passed: true })), frozenTest: { sha256: 'd'.repeat(64) }, testLog: { sha256: 'e'.repeat(64) }, verificationEnvironment: anonymous.verificationEnvironment };
    assertFreshGate(report, anonymous); assert.throws(() => assertFreshGate({ ...report, runtimeInitializerPreflight: undefined }, anonymous)); assert.throws(() => assertFreshGate(report, { ...anonymous, composeEvidence: {} })); assert.throws(() => assertFreshGate({ ...report, sqliteMigrationAttempted: true }, anonymous)); assert.throws(() => assertFreshGate({ ...report, checks: report.checks.slice(1) }, anonymous));
    console.log('Fresh PostgreSQL evidence binding self-check passed; no Docker, network, credentials or runtime access.');
  } else if (process.argv.includes('--verify-captured-compose-evidence')) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
  else console.log('Prepared only. Use --verify-captured-compose-evidence after the frozen anonymous Compose lifecycle passes.');
}
module.exports = { assertFreshGate };
