'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

test('Windows printing agent offline validation, COM mocks and crash journal', { skip: process.platform !== 'win32' }, () => {
  const script = path.join(__dirname, 'bartender-agent.tests.ps1');
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  const report = JSON.parse(result.stdout);
  assert.ok(report.passed >= 40);
  assert.equal(report.physicalPrint, false);
  assert.equal(report.realComStarted, false);
});

test('station HTTP transport sends bearer only to its origin and refuses redirects', { skip: process.platform !== 'win32' }, async t => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ path: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      if (req.url.endsWith('/redirect')) {
        res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/must-not-receive-token` });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ job: null }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const script = path.join(__dirname, '../scripts/bartender-agent.ps1').replace(/'/g, "''");
  const code = [
    `. '${script}' -Library`,
    `$configuration=@{serverUrl='http://127.0.0.1:${server.address().port}';token='MOCK-ONLY-TRANSPORT-KEY'}`,
    `$response=Invoke-StationApi $configuration '/claim' @{agentVersion='0.8.0'}`,
    `if($null -ne $response.job){throw 'unexpected response'}`,
    `$rejected=$false;try{Invoke-StationApi $configuration '/redirect' @{}|Out-Null}catch{$rejected=$true}`,
    `if(-not $rejected){throw 'redirect must be rejected'}`,
    `'transport checked without COM'`
  ].join(';');
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(status, 0, error || output);
  assert.match(output, /transport checked without COM/);
  assert.equal(received.length, 2);
  assert.deepEqual(received.map(item => item.path), ['/api/printing/agent/claim', '/api/printing/agent/redirect']);
  assert.equal(received[0].authorization, 'Bearer MOCK-ONLY-TRANSPORT-KEY');
  assert.equal(JSON.parse(received[0].body).agentVersion, '0.8.0');
});
