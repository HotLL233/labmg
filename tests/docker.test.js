const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { test } = require('node:test');

const execute = promisify(execFile);
const image = process.env.LABOS_DOCKER_IMAGE;

test('Compose initializes a new volume for a non-root user and preserves setup, records, attachments and material issues', {
  skip: image ? false : 'set LABOS_DOCKER_IMAGE to test a locally built image', timeout: 420000
}, async () => {
  const root = path.resolve(__dirname, '..');
  const version = require('../package.json').version;
  const cache = path.join(root, 'artifacts/cache', version);
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'docker-test-'));
  const runId = crypto.randomBytes(8).toString('hex');
  const project = `labos-docker-test-${runId}`;
  const marker = path.join(directory, '.labos-compose-test');
  const envFile = path.join(directory, 'compose.env');
  fs.writeFileSync(marker, project);
  fs.writeFileSync(envFile, '');
  const uid = 12345, gid = 23456;
  const environment = {
    ...process.env, LABOS_IMAGE: image, LABOS_DATA_DIR: '', LABOS_PORT: '127.0.0.1:0',
    LABOS_UID: String(uid), LABOS_GID: String(gid), LABOS_ADMIN_USER: 'admin'
  };
  delete environment.LABOS_ADMIN_PASSWORD;
  const docker = async (args, timeout = 60000) => (await execute('docker', args, {
    cwd: root, env: environment, windowsHide: true, timeout, maxBuffer: 1024 * 1024
  })).stdout.trim();
  const compose = (args, timeout) => docker([
    'compose', '--project-name', project, '--file', path.join(root, 'deploy/docker-compose.yml'), '--env-file', envFile, ...args
  ], timeout);
  const inspect = async id => JSON.parse(await docker(['inspect', id]))[0];
  const projectContainers = () => docker(['ps', '--all', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
  const projectVolumes = () => docker(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']);
  let started = false, volumeName, volumeKey;
  const verifyProject = async () => {
    assert.equal(fs.readFileSync(marker, 'utf8'), project, 'refusing to clean an unmarked test project');
    for (const id of (await projectContainers()).split(/\s+/).filter(Boolean)) {
      const container = await inspect(id);
      assert.equal(container.Config.Labels['com.docker.compose.project'], project);
      assert.ok(['labos', 'labos-init'].includes(container.Config.Labels['com.docker.compose.service']), 'refusing to remove an unexpected service');
    }
    for (const name of (await projectVolumes()).split(/\s+/).filter(Boolean)) {
      assert.equal(name, volumeName, 'refusing to remove an unexpected volume');
      const volume = JSON.parse(await docker(['volume', 'inspect', name]))[0];
      assert.equal(volume.Labels['com.docker.compose.project'], project);
      assert.equal(volume.Labels['com.docker.compose.volume'], volumeKey);
    }
  };
  const credentials = { username: 'docker-test-admin', password: 'docker-test-password' };
  const setupOptions = {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...credentials, passwordConfirm: credentials.password })
  };
  const request = async (base, route, options = {}, expected = 200) => {
    const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, expected, `${route}: ${await response.clone().text()}`);
    return response;
  };
  const login = async (base, account = credentials) => {
    const response = await request(base, '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(account)
    });
    await response.json();
    return response.headers.get('set-cookie').split(';')[0];
  };
  try {
    const metadata = JSON.parse(await docker(['image', 'inspect', image]))[0];
    assert.ok(metadata.Config.User, 'image must declare its default user');
    assert.ok(!['root', '0'].includes(metadata.Config.User.split(':')[0]), 'image must not default to root');
    assert.ok(metadata.Config.Healthcheck?.Test, 'image must declare a health check');
    environment.DOCKER_DEFAULT_PLATFORM = `${metadata.Os}/${metadata.Architecture}`;
    const configuration = JSON.parse(await compose(['config', '--format', 'json']));
    const mount = configuration.services.labos.volumes.find(item => item.target === '/var/lib/labos');
    assert.equal(mount.type, 'volume');
    volumeKey = mount.source;
    assert.equal(volumeKey, `labos-runtime-${version}`);
    volumeName = configuration.volumes[volumeKey].name;
    assert.equal(volumeName, `${project}_${volumeKey}`, 'runtime volume must be isolated by project and version');
    assert.equal(await projectContainers(), '');
    assert.equal(await projectVolumes(), '');
    assert.ok(!(await docker(['volume', 'ls', '--filter', `name=${volumeName}`, '--format', '{{.Name}}'])).split(/\s+/).includes(volumeName), 'runtime volume must not exist before deployment');
    const start = async () => {
      started = true;
      await compose(['up', '--detach', '--pull', 'never', '--wait', '--wait-timeout', '120'], 180000);
      const name = await compose(['ps', '--quiet', 'labos']);
      const initName = await compose(['ps', '--all', '--quiet', 'labos-init']);
      assert.ok(name && initName, 'Compose must create both the application and initializer');
      const application = await inspect(name), initializer = await inspect(initName);
      assert.ok(['root', '0'].includes(initializer.Config.User.split(':')[0]), 'initializer must run as root');
      assert.equal(initializer.State.Status, 'exited');
      assert.equal(initializer.State.ExitCode, 0, 'initializer must finish successfully before the app starts');
      assert.equal(initializer.Config.Healthcheck.Test[0], 'NONE');
      assert.equal(application.State.Health?.Status, 'healthy');
      assert.equal(application.Mounts.find(item => item.Destination === '/var/lib/labos').Name, volumeName);
      assert.equal(initializer.Mounts.find(item => item.Destination === '/var/lib/labos').Name, volumeName);
      assert.deepEqual(JSON.parse(await docker(['exec', name, 'node', '-p', 'JSON.stringify({uid:process.getuid(),gid:process.getgid()})'])), { uid, gid });
      const directories = JSON.parse(await docker(['exec', name, 'node', '-e', "const fs=require('node:fs');console.log(JSON.stringify(['','data','uploads','logs'].map(part=>{const name='/var/lib/labos'+(part?'/'+part:''),stat=fs.statSync(name);return {name,uid:stat.uid,gid:stat.gid,mode:stat.mode&0o700,directory:stat.isDirectory()}})))"]));
      for (const entry of directories) {
        assert.equal(entry.uid, uid, `${entry.name} owner`);
        assert.equal(entry.gid, gid, `${entry.name} group`);
        assert.equal(entry.mode, 0o700, `${entry.name} owner must have read/write/search access`);
        assert.equal(entry.directory, true);
      }
      const volume = JSON.parse(await docker(['volume', 'inspect', volumeName]))[0];
      assert.equal(volume.Labels['com.docker.compose.project'], project, 'deployment must automatically create its own volume');
      const binding = await docker(['port', name, '3000/tcp']);
      assert.match(binding, /^127\.0\.0\.1:\d+$/);
      return { name, initName, base: `http://${binding}` };
    };
    const first = await start();
    await docker(['exec', first.name, 'node', '-e', "const fs=require('node:fs'),assert=require('node:assert/strict');assert.ok(fs.statSync('/app/docs/THIRD_PARTY.md').size>100);for(const name of ['MIT-zxing-wasm.txt','Apache-2.0-zxing-cpp.txt','Apache-2.0-wrapper.txt','BSD-3-Clause-zint.txt','LICENSE-stb.txt'])assert.ok(fs.statSync('/app/docs/licenses/zxing-wasm/'+name).size>100)"]);
    const initial = await (await request(first.base, '/api/auth/me')).json();
    assert.equal(initial.user, null);
    assert.equal(initial.setupRequired, true);
    const setup = await request(first.base, '/api/auth/setup', setupOptions, 201);
    const administrator = (await setup.json()).user;
    assert.equal(administrator.role, 'ADMIN');
    assert.ok(Number.isSafeInteger(administrator.id));
    assert.ok(setup.headers.get('set-cookie'), 'setup must create a session');
    const cookie = await login(first.base);
    for (const [route, mime] of [['/vendor/zxing-wasm/3.1.5/index.js', /javascript/], ['/vendor/zxing-wasm/3.1.5/zxing_full.wasm', /^application\/wasm$/]]) {
      const asset = await request(first.base, route);
      assert.match(asset.headers.get('content-type'), mime);
      assert.ok((await asset.arrayBuffer()).byteLength > 30000, 'scanner resources must be included in the image');
    }
    const post = async (route, payload, expected = 201) => (await request(first.base, route, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }, expected)).json();
    await request(first.base, `/api/users/${administrator.id}`, {
      method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ roles: ['ADMIN', 'MATERIAL'] })
    });
    const category = await post('/api/materials/categories', { name: '容器分类' });
    const region = await post('/api/materials/regions', { name: '容器区域' });
    let materialRequest = await post('/api/materials/requests', { title: '容器物资入库' });
    materialRequest = await post(`/api/materials/requests/${materialRequest.id}/items`, {
      requestVersion: materialRequest.version, name: '容器物资', spec: '1 L', unit: '瓶', categoryId: category.id, regionId: region.id, warehouse: 'MAIN', quantity: '2'
    });
    materialRequest = await post(`/api/materials/requests/${materialRequest.id}/submit`, { requestVersion: materialRequest.version }, 200);
    assert.equal(materialRequest.items[0].catalogId, null, 'new materials must submit before catalog creation');
    await post('/api/materials/receipts', {
      requestId: materialRequest.id, itemId: materialRequest.items[0].id, requestVersion: materialRequest.version, version: materialRequest.items[0].version,
      requestIdempotencyKey: crypto.randomUUID(), quantity: '1', amount: '12.34'
    }, 409);
    const catalog = await post('/api/materials/catalog', { code: 'DOCKER-MAT', name: '容器物资', spec: '1 L', unit: '瓶', categoryId: category.id });
    const packagingCode = '0012345678905';
    const barcode = (await post(`/api/materials/catalog/${catalog.id}/barcodes`, { code: packagingCode, reason: '容器包装码绑定验证' })).barcode;
    assert.equal(barcode.code, packagingCode);
    const catalogScan = await post('/api/materials/scan/resolve', { code: packagingCode }, 200);
    assert.equal(catalogScan.kind, 'catalog'); assert.equal(catalogScan.catalog.id, catalog.id);
    materialRequest = await (await request(first.base, `/api/materials/requests/${materialRequest.id}/items/${materialRequest.items[0].id}`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestVersion: materialRequest.version, version: materialRequest.items[0].version, catalogId: catalog.id, reason: '入库前规范匹配' })
    })).json();
    const history = await (await request(first.base, `/api/materials/requests/${materialRequest.id}/revisions`, { headers: { Cookie: cookie } })).json();
    assert.equal(history.originalSnapshot.items[0].catalogId, null);
    assert.equal(history.revisions[0].after.items[0].catalogId, catalog.id);
    const materialReceipt = await post('/api/materials/receipts', {
      requestId: materialRequest.id, itemId: materialRequest.items[0].id, requestVersion: materialRequest.version, version: materialRequest.items[0].version,
      requestIdempotencyKey: crypto.randomUUID(), quantity: '1', amount: '12.34', batch: 'DOCKER-ISSUE-BATCH', expiryDate: '2027-12-31'
    });
    assert.equal(materialReceipt.receipt.amountCents, 1234);
    const stockIdentity = { catalogId: catalog.id, regionId: region.id, warehouse: 'MAIN', batch: 'DOCKER-ISSUE-BATCH', expiryDate: '2027-12-31' };
    const location = '容器试剂柜 A-02';
    await request(first.base, '/api/materials/stock/location', {
      method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...stockIdentity, location, version: 0, reason: '容器存放位置核验' })
    });
    const requesterCredentials = { username: 'docker-requester', password: 'docker-requester-password' };
    await post('/api/users', { ...requesterCredentials, roles: ['TESTER'] });
    const requesterCookie = await login(first.base, requesterCredentials);
    const requesterBatches = (await (await request(first.base, '/api/materials/stock/batches', { headers: { Cookie: requesterCookie } })).json()).items;
    assert.equal(requesterBatches[0].location, location);
    assert.equal(requesterBatches[0].amountCents, undefined, 'ordinary batch lookup must not expose money');
    const scanPayload = { code: requesterBatches[0].qrPayload };
    assert.ok(scanPayload.code.startsWith('LABOS-STOCK:1:'));
    const scanned = await (await request(first.base, '/api/materials/scan/resolve', {
      method: 'POST', headers: { Cookie: requesterCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(scanPayload)
    })).json();
    assert.equal(scanned.kind, 'stock'); assert.equal(scanned.batch.location, location);
    assert.equal(scanned.batch.qtyM, 1000); assert.equal(scanned.batch.amountCents, undefined);
    const application = (await (await request(first.base, '/api/materials/issues', {
      method: 'POST', headers: { Cookie: requesterCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...stockIdentity, quantity: '0.25', purpose: '容器普通人员领用申请', requestIdempotencyKey: crypto.randomUUID() })
    }, 201)).json()).issue;
    assert.equal(application.status, 'pending');
    assert.equal(application.amountCents, undefined);
    const issuePayload = { version: application.version, requestIdempotencyKey: crypto.randomUUID() };
    await request(first.base, `/api/materials/issues/${application.id}/issue`, {
      method: 'POST', headers: { Cookie: requesterCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(issuePayload)
    }, 403);
    const issued = (await post(`/api/materials/issues/${application.id}/issue`, issuePayload)).issue;
    assert.equal(issued.status, 'issued'); assert.equal(issued.qtyM, 250);
    assert.equal(issued.amountCents, 309, 'a quarter of 12.34 must round half up to 3.09');
    assert.equal(issued.snapshot.location, location, 'issued stock must retain its location snapshot');
    assert.equal((await post(`/api/materials/issues/${application.id}/issue`, issuePayload, 200)).issue.id, application.id);
    const movementRoute = '/api/materials/stock/movements?' + new URLSearchParams(stockIdentity);
    const assertIssueMovements = async (base, actorCookie) => {
      const rows = (await (await request(base, movementRoute, { headers: { Cookie: actorCookie } })).json()).items;
      assert.equal(rows.length, 2, 'receipt and one issue must be the only batch movements');
      const outgoing = rows.filter(row => row.type === 'issue');
      assert.equal(outgoing.length, 1); assert.equal(outgoing[0].issueId, application.id);
      assert.equal(outgoing[0].qtyM, -250); assert.equal(outgoing[0].amountCents, -309);
      assert.equal(rows.reduce((sum, row) => sum + row.qtyM, 0), 750);
      assert.equal(rows.reduce((sum, row) => sum + row.amountCents, 0), 925);
    };
    await assertIssueMovements(first.base, cookie);
    const workbook = await request(first.base, `/api/materials/export.xlsx?type=requests&requestId=${materialRequest.id}`, { headers: { Cookie: cookie } });
    assert.match(workbook.headers.get('content-type'), /spreadsheetml/);
    assert.equal(Buffer.from(await workbook.arrayBuffer()).readUInt32LE(0), 0x04034b50, 'Linux dependencies must generate an actual XLSX ZIP');
    const title = `docker persistence ${runId}`;
    const record = await (await request(first.base, '/api/records', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ module: 'archives', title })
    }, 201)).json();
    const content = `attachment ${runId}`;
    const file = await (await request(first.base, '/api/files', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_id: record.id, name: 'docker-fixture.txt', type: 'text/plain', content: Buffer.from(content).toString('base64') })
    }, 201)).json();
    const sentinel = '/var/lib/labos/uploads/init-preservation.txt';
    await docker(['exec', first.name, 'node', '-e', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(sentinel)},${JSON.stringify(runId)});fs.chmodSync(${JSON.stringify(sentinel)},0o640)`]);
    const snapshot = name => docker(['exec', name, 'node', '-e', `const fs=require('node:fs'),file=${JSON.stringify(sentinel)},stat=fs.statSync(file);console.log(JSON.stringify({content:fs.readFileSync(file,'utf8'),mode:stat.mode&0o777,uid:stat.uid,gid:stat.gid,mtime:stat.mtimeMs}))`]);
    const preserved = JSON.parse(await snapshot(first.name));
    await verifyProject();
    await compose(['down', '--timeout', '15'], 90000);
    assert.equal(await projectContainers(), '');
    assert.equal(await projectVolumes(), volumeName, 'container recreation must retain the runtime volume');
    const second = await start();
    assert.notEqual(second.name, first.name);
    assert.notEqual(second.initName, first.initName, 'initializer must also run against the existing volume');
    assert.deepEqual(JSON.parse(await snapshot(second.name)), preserved, 'initialization must preserve existing file contents and metadata');
    assert.equal((await (await request(second.base, '/api/auth/me')).json()).setupRequired, false, 'container recreation must not reopen setup');
    await request(second.base, '/api/auth/setup', setupOptions, 409);
    const secondCookie = await login(second.base);
    const materialStock = await request(second.base, '/api/materials/stock', { headers: { Cookie: secondCookie } });
    const persistedMaterial = (await materialStock.json()).items.find(row => row.catalogId === catalog.id && row.regionId === region.id);
    assert.equal(persistedMaterial.qtyM, 750); assert.equal(persistedMaterial.amountCents, 925);
    const persistedBatches = (await (await request(second.base, '/api/materials/stock/batches', { headers: { Cookie: secondCookie } })).json()).items;
    assert.equal(persistedBatches[0].location, location); assert.equal(persistedBatches[0].locationVersion, 1);
    assert.equal(persistedBatches[0].qtyM, 750); assert.equal(persistedBatches[0].amountCents, 925);
    assert.equal((await postAfterRestart('/api/materials/scan/resolve', { code: packagingCode })).catalog.id, catalog.id);
    const rescanned = await postAfterRestart('/api/materials/scan/resolve', scanPayload);
    assert.equal(rescanned.batch.qtyM, 750); assert.equal(rescanned.batch.amountCents, 925);
    async function postAfterRestart(route, payload) {
      return (await request(second.base, route, { method: 'POST', headers: { Cookie: secondCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
    }
    const persistedIssue = (await (await request(second.base, `/api/materials/issues/${application.id}`, { headers: { Cookie: secondCookie } })).json()).issue;
    assert.equal(persistedIssue.status, 'issued'); assert.equal(persistedIssue.amountCents, 309); assert.equal(persistedIssue.snapshot.location, location);
    await assertIssueMovements(second.base, secondCookie);
    const secondRequesterCookie = await login(second.base, requesterCredentials);
    const ownIssues = (await (await request(second.base, '/api/materials/issues', { headers: { Cookie: secondRequesterCookie } })).json()).items;
    assert.equal(ownIssues.length, 1); assert.equal(ownIssues[0].id, application.id); assert.equal(ownIssues[0].status, 'issued');
    assert.equal(ownIssues[0].amountCents, undefined, 'ordinary issue history must remain amount-redacted after recreation');
    const records = await request(second.base, '/api/records?module=archives', { headers: { Cookie: secondCookie } });
    assert.ok((await records.json()).some(row => row.id === record.id && row.title === title));
    const files = await request(second.base, `/api/files?record_id=${record.id}`, { headers: { Cookie: secondCookie } });
    assert.ok((await files.json()).some(row => row.id === file.id && row.original_name === 'docker-fixture.txt'));
    const downloaded = await request(second.base, `/api/files/${file.id}/download`, { headers: { Cookie: secondCookie } });
    assert.equal(await downloaded.text(), content);
    await compose(['stop', '--timeout', '15', 'labos'], 90000);
    await verifyProject();
    await docker(['run', '--rm', '--pull', 'never', '--user', '0:0', '--platform', environment.DOCKER_DEFAULT_PLATFORM,
      '--label', `labos.test=${project}`, '--mount', `type=volume,source=${volumeName},target=/var/lib/labos`,
      '--env', `LABOS_UID=${uid}`, '--env', `LABOS_GID=${gid}`, image, 'node', '-e', `
        const fs=require('node:fs'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
        fs.renameSync('/var/lib/labos/data','/var/lib/labos/data-kept');
        const guarded='/tmp/guarded';fs.mkdirSync(guarded);fs.chownSync(guarded,34567,45678);fs.chmodSync(guarded,0o510);
        const snapshot=()=>{const stat=fs.statSync(guarded);return {uid:stat.uid,gid:stat.gid,mode:stat.mode&0o777}};
        const before=snapshot();fs.symlinkSync(guarded,'/var/lib/labos/data','dir');
        const result=spawnSync(process.execPath,['src/init-runtime.js'],{encoding:'utf8',timeout:10000});
        assert.equal(result.error,undefined,'initializer must exit without timing out');
        assert.ok(Number.isInteger(result.status)&&result.status!==0,'initializer must reject a symlink runtime directory');
        assert.deepEqual(snapshot(),before,'initializer must not change symlink target ownership or permissions');
      `], 90000);
  } finally {
    const cleanupErrors = [];
    if (started) {
      try {
        await verifyProject();
        await compose(['down', '--volumes', '--timeout', '15'], 90000);
        assert.equal(await projectContainers(), '');
        assert.equal(await projectVolumes(), '');
      } catch (error) { cleanupErrors.push(error); }
    }
    if (!cleanupErrors.length) {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(cache));
      assert.ok(path.basename(directory).startsWith('docker-test-'));
      assert.equal(fs.readFileSync(marker, 'utf8'), project);
      fs.rmSync(directory, { recursive: true, force: true });
    }
    assert.equal(cleanupErrors.length, 0, 'test project cleanup failed; fixture directory and remaining resources were retained');
  }
});
