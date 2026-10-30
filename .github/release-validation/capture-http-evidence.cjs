'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function evidence(anonymous, source, log, frozen) {
  assert.equal(anonymous.status, 'passed');
  assert.equal(anonymous.compose, 'passed');
  assert.equal(anonymous.composeEvidence.lifecycle, 'passed');
  assert.equal(anonymous.composeEvidence.loopbackOnly, true);
  assert.equal(anonymous.dockerCredentialIsolation.existingCredentialsUsed, false);
  assert.equal(hash(source), frozen.sha256);
  assert.equal(source.length, frozen.size);
  const text = source.toString('utf8'), output = log.toString('utf8');
  assert.match(output, /^# pass 1\r?$/m);
  assert.match(output, /^# fail 0\r?$/m);
  assert.match(output, /^# skipped 0\r?$/m);
  assert.match(text, /const request = async \(base, route, options = \{\}, expected = 200\)/);
  assert.match(text, /fetch\(base \+ route, \{ \.\.\.options, signal:/);
  assert.match(text, /request\(first\.base, '\/api\/auth\/me'\)/);
  assert.match(text, /assert\.equal\(initial\.user, null\)/);
  assert.match(text, /assert\.equal\(initial\.setupRequired, true\)/);
  assert.match(text, /const asset = await request\(first\.base, route\)/);
  assert.ok(text.includes('/vendor/zxing-wasm/3.1.5/index.js') && text.includes('/vendor/zxing-wasm/3.1.5/zxing_full.wasm'));
  return {
    status: 'passed', version: anonymous.version, commit: anonymous.commit,
    method: 'captured-frozen-compose-test-http-assertions', protocol: 'HTTP', loopbackOnly: true,
    requestCookie: false, requestAuthorization: false, productionData: false,
    routes: ['/api/auth/me', '/vendor/zxing-wasm/3.1.5/index.js', '/vendor/zxing-wasm/3.1.5/zxing_full.wasm'],
    frozenTest: { path: frozen.path, size: frozen.size, sha256: frozen.sha256 },
    testLog: { path: anonymous.composeEvidence.testLog, sha256: hash(log), size: log.length },
    verificationEnvironment: anonymous.verificationEnvironment,
    boundaries: ['Derived from the same completed frozen Compose lifecycle, not another executed test.', 'Private GitHub draft assets are downloaded with authentication and are not anonymous HTTP-download evidence.', 'Strict trusted HTTPS is covered separately by gate 4.'],
  };
}

function main() {
  const root = process.cwd(), { version } = require(path.join(root, 'package.json'));
  const cache = path.join(root, 'artifacts/cache', version);
  const read = name => JSON.parse(fs.readFileSync(path.join(cache, name), 'utf8').replace(/^\uFEFF/, ''));
  const anonymous = read('ghcr-anonymous-verification.json');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/releases', version, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(anonymous.version, version);
  assert.equal(anonymous.commit, manifest.commit);
  const frozen = manifest.sources.find(row => row.path === 'tests/docker.test.js');
  assert.ok(frozen);
  const zipSource = anonymous.frozenSources.find(row => row.path.endsWith(':tests/docker.test.js'));
  assert.ok(zipSource);
  assert.equal(zipSource.sha256, frozen.sha256);
  assert.equal(zipSource.size, frozen.size);
  const logName = anonymous.composeEvidence.testLog;
  assert.equal(path.basename(logName), logName);
  const report = evidence(anonymous, fs.readFileSync(path.join(root, frozen.path)), fs.readFileSync(path.join(cache, logName)), frozen);
  fs.writeFileSync(path.join(cache, 'http-anonymous-verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('Recorded anonymous HTTP evidence from the same completed frozen Compose lifecycle; GitHub draft access remains separately authenticated.');
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { evidence };
