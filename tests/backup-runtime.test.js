const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('full runtime backups preserve binary files, verify identity, recover service states and refuse damaged inputs', { timeout: 90000 }, t => {
  const root = path.resolve(__dirname, '..');
  const cache = path.join(root, 'artifacts/cache', require('../package.json').version);
  fs.mkdirSync(cache, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(cache, 'runtime-backup-test-'));
  t.after(() => {
    assert.equal(path.dirname(fixture), cache);
    assert.ok(path.basename(fixture).startsWith('runtime-backup-test-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const compose = path.join(fixture, 'docker-compose.yml');
  fs.copyFileSync(path.join(root, 'deploy/docker-compose.yml'), compose);
  fs.writeFileSync(path.join(fixture, '.env'), 'PRIVATE_FIXTURE=must-not-appear-in-output\n');
  const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
  const ids = { labos: 'a'.repeat(64), postgres: 'b'.repeat(64), 'labos-https': 'c'.repeat(64) };
  const run = (name, { mode = 'Backup', expected = 0, pgVersion = '180004', mismatch = false, failDump = false, httpsStopped = false } = {}) => {
    const destination = path.join(fixture, name);
    const log = path.join(fixture, 'commands.json');
    const program = `
      $ErrorActionPreference='Stop'
      $global:Commands=[Collections.Generic.List[object]]::new()
      $global:Temporary=0
      function global:docker {
        $command=@($args);$global:Commands.Add($command);$global:LASTEXITCODE=0
        switch ($command[0]) {
          'compose' {
            Write-Error 'synthetic successful Compose warning' -ErrorAction Continue
            switch($command[-1]) {'labos' {'${ids.labos}'} 'postgres' {'${ids.postgres}'} 'labos-https' {'${ids['labos-https']}'}}
          }
          'inspect' {
            $service=switch($command[1]) {'${ids.labos}' {'labos'} '${ids.postgres}' {'postgres'} '${ids['labos-https']}' {'labos-https'} default {throw 'unknown mock container'}}
            $mounts=switch($service) {
              'labos' {@(@{Type='bind';Source='/volume1/labos/runtime';Destination='/var/lib/labos'})}
              'postgres' {@(@{Type='bind';Source='/volume1/labos/runtime/postgres';Destination='/var/lib/postgresql'},@{Type='bind';Source='/volume1/labos/runtime/secrets';Destination='/run/labos-secrets'})}
              'labos-https' {@(@{Type='bind';Source='/volume1/labos/https';Destination='/var/lib/labos-https'},@{Type='bind';Source='/volume1/labos/runtime/https-config';Destination='/etc/labos-https'})}
            }
            if(${mismatch ? '$true' : '$false'} -and $service -eq 'postgres'){$mounts[0].Source='/volume1/wrong/postgres'}
            $state=if(${httpsStopped ? '$true' : '$false'} -and $service -eq 'labos-https'){'exited'}else{'running'}
            $image=switch($service){'labos' {'d'} 'postgres' {'e'} 'labos-https' {'f'}}
            ConvertTo-Json -Depth 8 -Compress -InputObject @(@{Id=$command[1];Image=('sha256:'+($image*64));Config=@{User='1000:1000';Labels=@{'com.docker.compose.project'='labos-fixture';'com.docker.compose.service'=$service}};State=@{Status=$state};Mounts=@($mounts);HostConfig=@{PortBindings=@{}}})
          }
          'image' {'[{}]'}
          'exec' {
            if($command[2] -eq 'psql'){${quote(pgVersion)}}
            elseif($command[2] -eq 'pg_dump' -and ${failDump ? '$true' : '$false'}){$global:LASTEXITCODE=9}
            elseif($command[2] -notin @('pg_dump','rm')){throw 'unexpected mock exec'}
          }
          'create' {$global:Temporary++;$global:Temporary.ToString('x64')}
          'cp' {if($command[1] -match '^[a-f0-9]{64}:'){[IO.File]::WriteAllBytes($command[2],[byte[]]@(0,255,195,40,10,13,128,1))}elseif(!(Test-Path -LiteralPath $command[1])){throw 'mock upload source missing'}}
          'start' {if($command -contains '--attach'){'; synthetic PostgreSQL archive listing'}}
          'stop' {}
          'rm' {}
          default {throw 'unexpected mock Docker command'}
        }
      }
      try {& ${quote(path.join(root, 'scripts/backup-runtime.ps1'))} -Mode ${quote(mode)} -Destination ${quote(destination)} -ComposeFile ${quote(compose)} -ProjectName labos-fixture}
      finally {ConvertTo-Json -Depth 8 -InputObject $global:Commands.ToArray() | Set-Content -LiteralPath ${quote(log)}}
    `;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], { cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.equal(result.status === 0, expected === 0, output);
    assert.doesNotMatch(output, /must-not-appear-in-output/);
    return { destination, commands: JSON.parse(fs.readFileSync(log, 'utf8').replace(/^\uFEFF/, '')), output };
  };
  const backup = run('complete');
  const manifest = JSON.parse(fs.readFileSync(path.join(backup.destination, 'manifest.json')));
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.format, 'labos-runtime-backup-v1');
  assert.equal(manifest.database.major, 18);
  assert.deepEqual(manifest.runtime.excluded, ['postgres/']);
  assert.equal(manifest.files.length, 5);
  assert.equal(fs.existsSync(path.join(backup.destination, 'INCOMPLETE')), false);
  for (const name of ['database.dump', 'runtime.tar.gz', 'https.tar.gz']) assert.deepEqual(fs.readFileSync(path.join(backup.destination, name)), Buffer.from([0, 255, 195, 40, 10, 13, 128, 1]));
  const stopped = backup.commands.filter(c => c[0] === 'stop').map(c => c.at(-1));
  assert.deepEqual(stopped, [ids['labos-https'], ids.labos]);
  assert.deepEqual(backup.commands.filter(c => c[0] === 'start' && !c.includes('--attach')).map(c => c[1]), [ids.labos, ids['labos-https']]);
  assert.ok(backup.commands.find(c => c[0] === 'exec' && c[2] === 'pg_dump' && c.includes('--format=custom') && c.includes('--no-owner')));
  const archives = backup.commands.filter(c => c[0] === 'create' && c.includes('tar'));
  assert.equal(archives.length, 2);
  assert.ok(archives[0].includes('--exclude=./postgres'));
  for (const command of archives) {
    assert.ok(command.includes('--pull') && command.includes('never'));
    assert.ok(command.includes('--network') && command.includes('none'));
    assert.ok(command.includes('0:0'));
    assert.ok(command.some(v => v.endsWith(':ro')));
    assert.ok(command.includes(manifest.application.imageId));
  }
  assert.ok(backup.commands.every(c => !['pull', 'run', 'down'].includes(c[0])));
  assert.equal(run('complete', { expected: 1 }).commands.length, 0, 'existing destinations fail before Docker mutation');
  const verification = run('complete', { mode: 'Verify' });
  assert.ok(verification.commands.some(c => c[0] === 'create' && c.includes('pg_restore') && c.includes('--list')));
  assert.ok(verification.commands.every(c => !['stop', 'exec', 'compose'].includes(c[0])), 'verification never pauses the application');
  fs.appendFileSync(path.join(backup.destination, 'runtime.tar.gz'), 'tampered');
  assert.equal(run('complete', { mode: 'Verify', expected: 1 }).commands.length, 0, 'damaged archive fails before helper creation');
  for (const options of [{ pgVersion: '170011' }, { mismatch: true }]) {
    const rejected = run(options.mismatch ? 'wrong-mount' : 'wrong-pg', { ...options, expected: 1 });
    assert.ok(rejected.commands.every(c => c[0] !== 'stop'));
    assert.equal(fs.existsSync(rejected.destination), false);
  }
  const failed = run('failed-dump', { failDump: true, expected: 1 });
  assert.equal(fs.existsSync(path.join(failed.destination, 'INCOMPLETE')), true);
  assert.deepEqual(failed.commands.filter(c => c[0] === 'start').map(c => c[1]), [ids.labos, ids['labos-https']]);
  assert.ok(failed.commands.some(c => c[0] === 'exec' && c[2] === 'rm' && c.at(-1).startsWith('/tmp/labos-backup-')));
  const previouslyStopped = run('https-stopped', { httpsStopped: true });
  assert.deepEqual(previouslyStopped.commands.filter(c => c[0] === 'stop').map(c => c.at(-1)), [ids.labos]);
  assert.deepEqual(previouslyStopped.commands.filter(c => c[0] === 'start' && !c.includes('--attach')).map(c => c[1]), [ids.labos]);
});
