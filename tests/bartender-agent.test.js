'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

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
      } else if (req.url.match(/\/status\/(401|403|409|503)$/)) {
        res.writeHead(Number(req.url.match(/(401|403|409|503)$/)[1]), { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'MOCK-ONLY private response must not be displayed' }));
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
    `$response=Invoke-StationApi $configuration '/claim' @{agentVersion=$script:AgentVersion}`,
    `if($null -ne $response.job){throw 'unexpected response'}`,
    `$rejected=$false;try{Invoke-StationApi $configuration '/redirect' @{}|Out-Null}catch{$rejected=$true}`,
    `if(-not $rejected){throw 'redirect must be rejected'}`,
    `foreach($status in @(401,403,409,503)){$message='';try{Invoke-StationApi $configuration ('/status/'+$status) @{}|Out-Null}catch{$message=$_.Exception.Message};if(-not $message.StartsWith('STATION_HTTP_'+$status+';') -or $message.Contains('private response')){throw 'controlled HTTP diagnostic missing'}}`,
    `'transport checked without COM'`
  ].join(';');
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(status, 0, error || output);
  assert.match(output, /transport checked without COM/);
  assert.equal(received.length, 6);
  assert.deepEqual(received.map(item => item.path), ['/api/printing/agent/claim', '/api/printing/agent/redirect', '/api/printing/agent/status/401', '/api/printing/agent/status/403', '/api/printing/agent/status/409', '/api/printing/agent/status/503']);
  assert.equal(received[0].authorization, 'Bearer MOCK-ONLY-TRANSPORT-KEY');
  assert.equal(JSON.parse(received[0].body).agentVersion, '0.8.2');
});

test('double-click console retains initialization errors and never claims before configuration', { skip: process.platform !== 'win32' }, t => {
  const cache = path.join(__dirname, '../artifacts/cache/0.8.2');
  fs.mkdirSync(cache, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(cache, 'console-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const runtime = path.join(fixture, 'runtime');
  const script = path.join(__dirname, '../scripts/bartender-agent.ps1');
  const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Console', '-RuntimeDirectory', runtime], { input: '3\n0\n', encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /尚未初始化打印站/);
  assert.match(result.stdout, /此菜单不会自动领取任务/);
  assert.equal(fs.existsSync(path.join(runtime, 'station.dpapi')), false);
  assert.equal(fs.existsSync(path.join(runtime, 'journal.dpapi')), false);
  assert.equal(fs.existsSync(path.join(runtime, 'engine-request.dpapi')), false);
});
