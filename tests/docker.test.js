const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { test } = require('node:test');

const execute = promisify(execFile);
const image = process.env.LABOS_DOCKER_IMAGE;
const dockerMode = process.env.LABOS_DOCKER_MODE ?? 'online';
assert.ok(['online', 'local'].includes(dockerMode), 'LABOS_DOCKER_MODE must be online or local');

test('PostgreSQL Compose creates a runtime beside its YML and preserves accounts, secrets, attachments, stock and unit labels after recreation', {
  skip: image ? false : 'set LABOS_DOCKER_IMAGE and preload matching postgres:18-bookworm and caddy:2.11.7-alpine images', timeout: 600000
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
  const composeFile = path.join(directory, 'docker-compose.yml');
  const runtime = path.join(directory, 'runtime');
  fs.writeFileSync(marker, project);
  fs.writeFileSync(envFile, '');
  fs.copyFileSync(path.join(root, dockerMode === 'local' ? 'deploy/docker-compose.local.yml' : 'deploy/docker-compose.yml'), composeFile);
  const uid = 12345, gid = 23456;
  const environment = {
    ...process.env, LABOS_IMAGE: image, LABOS_DATA_DIR: '', LABOS_PORT: '127.0.0.1:0',
    LABOS_UID: String(uid), LABOS_GID: String(gid), LABOS_ADMIN_USER: 'admin',
    LABOS_HTTPS_HOST: '127.0.0.1', LABOS_HTTPS_PORT: '127.0.0.1:0'
  };
  delete environment.LABOS_ADMIN_PASSWORD;
  const docker = async (args, timeout = 60000) => (await execute('docker', args, {
    cwd: root, env: environment, windowsHide: true, timeout, maxBuffer: 1024 * 1024
  })).stdout.trim();
  const compose = (args, timeout) => docker([
    'compose', '--project-name', project, '--file', composeFile, '--env-file', envFile, ...args
  ], timeout);
  const inspect = async id => JSON.parse(await docker(['inspect', id]))[0];
  const projectContainers = () => docker(['ps', '--all', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
  const projectVolumes = () => docker(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']);
  let started = false;
  const verifyProject = async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(cache));
    assert.ok(path.basename(directory).startsWith('docker-test-'));
    assert.equal(fs.readFileSync(marker, 'utf8'), project, 'refusing to clean an unmarked test project');
    for (const id of (await projectContainers()).split(/\s+/).filter(Boolean)) {
      const container = await inspect(id);
      assert.equal(container.Config.Labels['com.docker.compose.project'], project);
      assert.ok(['labos', 'labos-init', 'postgres', 'labos-https'].includes(container.Config.Labels['com.docker.compose.service']), 'refusing to remove an unexpected service');
    }
    assert.equal(await projectVolumes(), '', 'bind deployment must not create a project volume');
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
    if (dockerMode === 'local') {
      assert.equal(image, `labos:${version}`, 'offline test image must match the fixed local Compose tag');
      assert.equal(configuration.services.labos.image, image);
      assert.equal(configuration.services['labos-init'].image, image);
      for (const service of ['labos-init', 'labos', 'postgres', 'labos-https']) {
        assert.equal(configuration.services[service].pull_policy, 'never', 'every local Compose service must forbid pulling');
      }
    }
    const mount = configuration.services.labos.volumes.find(item => item.target === '/var/lib/labos');
    assert.equal(mount.type, 'bind');
    assert.equal(path.resolve(mount.source), runtime, 'default runtime must be beside the test YML');
    const composeSource = fs.readFileSync(composeFile, 'utf8');
    const shortBindings = [...composeSource.matchAll(/^\s+-\s+"(\$\{LABOS_DATA_DIR:-\.\/runtime\}[^"]*)"\s*$/gm)].map(match => match[1]);
    assert.deepEqual(shortBindings, [
      '${LABOS_DATA_DIR:-./runtime}:/var/lib/labos',
      '${LABOS_DATA_DIR:-./runtime}/postgres:/var/lib/postgresql',
      '${LABOS_DATA_DIR:-./runtime}/secrets:/run/labos-secrets:ro',
      '${LABOS_DATA_DIR:-./runtime}:/var/lib/labos'
    ], 'runtime mounts must retain the legacy-compatible short bind syntax');
    assert.match(composeSource, /^\s+- "\.\/https:\/var\/lib\/labos-https"\s*$/m);
    assert.doesNotMatch(composeSource, /^\s+(?:create_host_path|type):/m);
    // Compose normalization may omit create_host_path: true because it is the default.
    assert.notEqual(mount.bind?.create_host_path, false);
    assert.deepEqual(configuration.services['labos-init'].volumes.find(item => item.target === '/var/lib/labos'), mount);
    const databaseConfiguration = configuration.services.postgres;
    assert.equal(databaseConfiguration.image, 'postgres:18-bookworm');
    assert.equal(databaseConfiguration.ports, undefined, 'PostgreSQL must stay on the internal network');
    assert.equal(databaseConfiguration.environment.POSTGRES_PASSWORD_FILE, '/run/labos-secrets/postgres-password');
    assert.equal(databaseConfiguration.environment.POSTGRES_PASSWORD, undefined);
    assert.equal(databaseConfiguration.environment.PGDATA, '/var/lib/postgresql/18/docker');
    assert.equal(path.resolve(databaseConfiguration.volumes.find(item => item.target === '/var/lib/postgresql').source), path.join(runtime, 'postgres'));
    assert.equal(databaseConfiguration.volumes.find(item => item.target === '/run/labos-secrets').read_only, true);
    assert.equal(configuration.services.labos.depends_on.postgres.condition, 'service_healthy');
    assert.equal(configuration.services.labos.environment.DATABASE_URL, undefined);
    assert.equal(configuration.services.labos.environment.PGHOST, 'postgres');
    const databaseImage = JSON.parse(await docker(['image', 'inspect', databaseConfiguration.image]))[0];
    assert.equal(databaseImage.Architecture, metadata.Architecture, 'preload the PostgreSQL image for the application architecture before an offline test');
    const httpsConfiguration = configuration.services['labos-https'];
    assert.equal(httpsConfiguration.image, 'caddy:2.11.7-alpine');
    assert.equal(path.resolve(httpsConfiguration.volumes.find(item => item.target === '/var/lib/labos-https').source), path.join(directory, 'https'));
    const httpsImage = JSON.parse(await docker(['image', 'inspect', httpsConfiguration.image]))[0];
    assert.equal(httpsImage.Architecture, metadata.Architecture, 'preload the Caddy image for the application architecture before an offline test');
    assert.equal(await projectContainers(), '');
    assert.equal(await projectVolumes(), '');
    assert.equal(fs.existsSync(runtime), false, 'Compose must create the default runtime directory');
    await docker(['run', '--rm', '--pull', 'never', '--user', '0:0', '--platform', environment.DOCKER_DEFAULT_PLATFORM,
      '--label', `labos.test=${project}`, '--env', `LABOS_UID=${uid}`, '--env', `LABOS_GID=${gid}`, image, 'node', '-e', `
        const fs=require('node:fs'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
        const postgres='/var/lib/labos/postgres',pgdata=postgres+'/18/docker',password='/var/lib/labos/secrets/postgres-password';
        const initialize=()=>{const result=spawnSync(process.execPath,['src/init-runtime.js'],{encoding:'utf8',timeout:10000});assert.ifError(result.error);return result};
        const metadata=directory=>{const stat=fs.lstatSync(directory);return {uid:stat.uid,gid:stat.gid,mode:stat.mode&0o777}};
        assert.equal(fs.existsSync(postgres),false,'preflight must start without a PostgreSQL directory or a host bind');
        const first=initialize();assert.equal(first.status,0,first.stderr);
        assert.ok(fs.lstatSync(postgres).isDirectory(),'initializer must create the PostgreSQL directory itself');
        assert.deepEqual(metadata(postgres),{uid:0,gid:0,mode:0o755},'the new PostgreSQL parent must allow the database user to traverse it');
        assert.equal(fs.existsSync(pgdata),false,'PostgreSQL must initialize its own versioned data directory');
        const secret=fs.readFileSync(password);
        fs.mkdirSync(pgdata,{recursive:true});fs.writeFileSync(pgdata+'/PG_VERSION','18');
        fs.chownSync(postgres,34567,45678);fs.chmodSync(postgres,0o700);
        fs.chownSync(pgdata,34567,45678);fs.chmodSync(pgdata,0o700);
        const marker=pgdata+'/init-preservation.txt';fs.writeFileSync(marker,'preserve PostgreSQL data');
        const before=metadata(postgres),dataBefore=metadata(pgdata),markerBytes=fs.readFileSync(marker);
        const second=initialize();assert.equal(second.status,0,second.stderr);
        assert.deepEqual(metadata(postgres),before,'reinitialization must preserve the PostgreSQL owner and permissions');
        assert.deepEqual(metadata(pgdata),dataBefore,'reinitialization must preserve the PostgreSQL 18 data directory');
        assert.deepEqual(fs.readFileSync(marker),markerBytes,'reinitialization must preserve PostgreSQL files');
        assert.deepEqual(fs.readFileSync(password),secret,'reinitialization must preserve database password bytes');
        fs.renameSync(password,password+'-kept');
        const missingSecret=initialize();assert.ok(Number.isInteger(missingSecret.status)&&missingSecret.status!==0,'existing PostgreSQL 18 data must reject a missing password');
        assert.equal(fs.existsSync(password),false,'initialization must not generate a replacement database password');
        assert.deepEqual(fs.readFileSync(marker),markerBytes,'a missing password must not change database files');
        fs.renameSync(password+'-kept',password);
        fs.renameSync(postgres,postgres+'-kept');
        const guarded='/tmp/postgres-init-guard';fs.mkdirSync(guarded);fs.writeFileSync(guarded+'/marker','guarded');
        fs.chownSync(guarded,45678,56789);fs.chmodSync(guarded,0o510);
        const guardedBefore=metadata(guarded),guardedBytes=fs.readFileSync(guarded+'/marker');
        fs.symlinkSync(guarded,postgres,'dir');
        const rejected=initialize();assert.ok(Number.isInteger(rejected.status)&&rejected.status!==0,'initializer must reject a PostgreSQL symlink');
        assert.ok(fs.lstatSync(postgres).isSymbolicLink(),'a rejected PostgreSQL symlink must not be replaced');
        assert.deepEqual(metadata(guarded),guardedBefore,'a rejected symlink target must retain ownership and permissions');
        assert.deepEqual(fs.readFileSync(guarded+'/marker'),guardedBytes,'a rejected symlink target must retain its files');
        assert.deepEqual(fs.readFileSync(password),secret,'a rejected PostgreSQL directory must not replace the database password');
      `], 90000);
    console.log('Runtime initializer preflight passed: PostgreSQL directory creation, ownership preservation and symlink rejection');
    const start = async () => {
      started = true;
      await compose(['up', '--detach', '--pull', 'never', '--wait', '--wait-timeout', '180'], 240000);
      const name = await compose(['ps', '--quiet', 'labos']);
      const initName = await compose(['ps', '--all', '--quiet', 'labos-init']);
      const databaseName = await compose(['ps', '--quiet', 'postgres']);
      assert.ok(name && initName && databaseName, 'Compose must create the application, initializer and PostgreSQL');
      const application = await inspect(name), initializer = await inspect(initName), database = await inspect(databaseName);
      assert.ok(['root', '0'].includes(initializer.Config.User.split(':')[0]), 'initializer must run as root');
      assert.equal(initializer.State.Status, 'exited');
      assert.equal(initializer.State.ExitCode, 0, 'initializer must finish successfully before the app starts');
      assert.equal(initializer.Config.Healthcheck.Test[0], 'NONE');
      assert.equal(application.State.Health?.Status, 'healthy');
      assert.equal(database.State.Health?.Status, 'healthy');
      assert.equal(Object.keys(database.NetworkSettings.Ports || {}).some(port => database.NetworkSettings.Ports[port]?.length), false, 'database ports must not be published');
      const applicationMount = application.Mounts.find(item => item.Destination === '/var/lib/labos');
      const initializerMount = initializer.Mounts.find(item => item.Destination === '/var/lib/labos');
      for (const binding of [applicationMount, initializerMount]) {
        assert.equal(binding.Type, 'bind');
        assert.equal(binding.RW, true);
        assert.ok(binding.Source);
      }
      assert.equal(initializerMount.Source, applicationMount.Source);
      // Docker Desktop can report a Linux VM path instead of the original Windows path.
      if (process.platform !== 'win32') assert.equal(path.resolve(applicationMount.Source), runtime);
      assert.deepEqual(JSON.parse(await docker(['exec', name, 'node', '-p', 'JSON.stringify({uid:process.getuid(),gid:process.getgid()})'])), { uid, gid });
      const directories = JSON.parse(await docker(['exec', name, 'node', '-e', "const fs=require('node:fs');console.log(JSON.stringify(['','data','uploads','logs','secrets'].map(part=>{const name='/var/lib/labos'+(part?'/'+part:''),stat=fs.statSync(name);return {name,uid:stat.uid,gid:stat.gid,mode:stat.mode&0o700,directory:stat.isDirectory()}})))"]));
      for (const entry of directories) {
        assert.equal(entry.uid, uid, `${entry.name} owner`);
        assert.equal(entry.gid, gid, `${entry.name} group`);
        assert.equal(entry.mode, 0o700, `${entry.name} owner must have read/write/search access`);
        assert.equal(entry.directory, true);
      }
      assert.ok(fs.statSync(runtime).isDirectory(), 'Compose must create the host runtime directory');
      const databaseMount = database.Mounts.find(item => item.Destination === '/var/lib/postgresql');
      assert.equal(databaseMount.Type, 'bind');
      if (process.platform !== 'win32') assert.equal(path.resolve(databaseMount.Source), path.join(runtime, 'postgres'));
      assert.equal(await docker(['exec', databaseName, 'cat', '/var/lib/postgresql/18/docker/PG_VERSION']), '18');
      assert.equal(await docker(['exec', name, 'node', '-p', "require('node:fs').existsSync('/var/lib/labos/data/labos.db')"]), 'false', 'the PostgreSQL runtime must not create a SQLite database');
      assert.equal(await projectVolumes(), '');
      const binding = await docker(['port', name, '3000/tcp']);
      assert.match(binding, /^127\.0\.0\.1:\d+$/);
      return { name, initName, databaseName, base: `http://${binding}` };
    };
    const secretFingerprint = name => docker(['exec', name, 'node', '-e', `const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');const file='/var/lib/labos/secrets/postgres-password',stat=fs.lstatSync(file),value=fs.readFileSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.match(value.toString('utf8'),/^[a-f0-9]{64}\\n$/);console.log(JSON.stringify({sha256:crypto.createHash('sha256').update(value).digest('hex'),mode:stat.mode&0o777,uid:stat.uid,gid:stat.gid,size:stat.size,mtime:stat.mtimeMs}))`]);
    const first = await start();
    const originalSecret = JSON.parse(await secretFingerprint(first.name));
    assert.deepEqual({ mode: originalSecret.mode, uid: originalSecret.uid, gid: originalSecret.gid, size: originalSecret.size }, { mode: 0o600, uid, gid, size: 65 });
    await docker(['exec', first.name, 'node', '-e', "(async()=>{const assert=require('node:assert/strict'),db=await require('./src/database').openDatabase();try{const row=await db.prepare('SELECT version() AS version').get();assert.match(row.version,/^PostgreSQL 18\\./)}finally{await db.close()}})().catch(()=>process.exitCode=1)"]);
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
    for (const route of ['/api/printing/config', '/api/printing/agent-script', '/api/printing/agent-launcher']) {
      await request(first.base, route, { headers: { Cookie: cookie } }, 404);
    }
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
    const unitCatalog = await post('/api/materials/catalog', {
      code: 'DOCKER-UNIT', name: '容器独立瓶', spec: '500 mL', unit: '瓶', categoryId: category.id, trackingMode: 'unit'
    });
    assert.equal(unitCatalog.trackingMode, 'unit');
    await request(first.base, '/api/materials/unit-label-rule', {
      method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'DOCKER-{YYYY}{MM}{DD}-{SEQ}', padding: 6, version: 1, reason: '容器独立瓶编号规则' })
    });
    let unitRequest = await post('/api/materials/requests', { title: '容器独立瓶验收' });
    unitRequest = await post(`/api/materials/requests/${unitRequest.id}/items`, {
      requestVersion: unitRequest.version, catalogId: unitCatalog.id, name: unitCatalog.name, spec: unitCatalog.spec,
      unit: unitCatalog.unit, categoryId: category.id, regionId: region.id, warehouse: 'MAIN', quantity: '3'
    });
    unitRequest = await post(`/api/materials/requests/${unitRequest.id}/submit`, { requestVersion: unitRequest.version }, 200);
    const unitIdentity = { catalogId: unitCatalog.id, regionId: region.id, warehouse: 'MAIN', batch: 'DOCKER-UNIT-BATCH', expiryDate: '2028-12-31' };
    const unitReceiptPayload = {
      requestId: unitRequest.id, itemId: unitRequest.items[0].id, requestVersion: unitRequest.version,
      version: unitRequest.items[0].version, requestIdempotencyKey: crypto.randomUUID(),
      quantity: '3', amount: '1', batch: unitIdentity.batch, expiryDate: unitIdentity.expiryDate
    };
    const unitReceipt = (await post('/api/materials/receipts', unitReceiptPayload)).receipt;
    assert.equal(unitReceipt.unitCount, 3); assert.equal(unitReceipt.units.length, 3);
    assert.deepEqual(unitReceipt.units.map(unit => unit.sequence), [1, 2, 3]);
    assert.equal(new Set(unitReceipt.units.map(unit => unit.code)).size, 3);
    for (const unit of unitReceipt.units) {
      assert.match(unit.code, /^DOCKER-\d{8}-\d{6}$/);
      assert.equal(unit.status, 'in_stock'); assert.equal(unit.sourceReceiptId, unitReceipt.id);
    }
    assert.deepEqual((await post('/api/materials/receipts', unitReceiptPayload, 200)).receipt.units, unitReceipt.units);
    const selectedUnit = unitReceipt.units[1];
    const unitScan = await (await request(first.base, '/api/materials/scan/resolve', {
      method: 'POST', headers: { Cookie: requesterCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: selectedUnit.code })
    })).json();
    assert.equal(unitScan.kind, 'unit'); assert.equal(unitScan.unit.id, selectedUnit.id);
    assert.equal(unitScan.batch.qtyM, 3000); assert.equal(unitScan.batch.amountCents, undefined);
    const unitApplication = (await (await request(first.base, '/api/materials/issues', {
      method: 'POST', headers: { Cookie: requesterCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...unitIdentity, quantity: '1', purpose: '指定独立瓶领用', requestIdempotencyKey: crypto.randomUUID() })
    }, 201)).json()).issue;
    const unitIssuePayload = { version: unitApplication.version, requestIdempotencyKey: crypto.randomUUID(), unitIds: [selectedUnit.id] };
    const unitIssued = (await post(`/api/materials/issues/${unitApplication.id}/issue`, unitIssuePayload)).issue;
    assert.equal(unitIssued.amountCents, 33); assert.equal(unitIssued.units.length, 1);
    assert.equal(unitIssued.units[0].id, selectedUnit.id); assert.equal(unitIssued.units[0].status, 'issued');
    assert.equal((await post(`/api/materials/issues/${unitApplication.id}/issue`, unitIssuePayload, 200)).issue.id, unitApplication.id);
    const unitRoute = `/api/materials/stock/units?catalogId=${unitCatalog.id}`;
    const expectedUnits = (await (await request(first.base, unitRoute, { headers: { Cookie: cookie } })).json()).items;
    assert.equal(expectedUnits.length, 3); assert.equal(expectedUnits.filter(unit => unit.status === 'in_stock').length, 2);
    const expectedRule = await (await request(first.base, '/api/materials/unit-label-rule', { headers: { Cookie: cookie } })).json();
    assert.equal(expectedRule.nextSequence, 4);
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
    assert.ok(fs.statSync(runtime).isDirectory(), 'container recreation must retain the runtime directory');
    assert.equal(await projectVolumes(), '');
    const second = await start();
    assert.notEqual(second.name, first.name);
    assert.notEqual(second.initName, first.initName, 'initializer must also run against the existing volume');
    assert.notEqual(second.databaseName, first.databaseName, 'PostgreSQL must be recreated against its existing bind directory');
    assert.deepEqual(JSON.parse(await secretFingerprint(second.name)), originalSecret, 'container recreation must preserve the database secret and its metadata');
    assert.deepEqual(JSON.parse(await snapshot(second.name)), preserved, 'initialization must preserve existing file contents and metadata');
    assert.equal((await (await request(second.base, '/api/auth/me')).json()).setupRequired, false, 'container recreation must not reopen setup');
    await request(second.base, '/api/auth/setup', setupOptions, 409);
    const secondCookie = await login(second.base);
    await request(second.base, '/api/printing/config', { headers: { Cookie: secondCookie } }, 404);
    const materialStock = await request(second.base, '/api/materials/stock', { headers: { Cookie: secondCookie } });
    const persistedMaterial = (await materialStock.json()).items.find(row => row.catalogId === catalog.id && row.regionId === region.id);
    assert.equal(persistedMaterial.qtyM, 750); assert.equal(persistedMaterial.amountCents, 925);
    const persistedBatches = (await (await request(second.base, '/api/materials/stock/batches', { headers: { Cookie: secondCookie } })).json()).items;
    const persistedBatch = persistedBatches.find(row => row.catalogId === catalog.id);
    assert.equal(persistedBatch.location, location); assert.equal(persistedBatch.locationVersion, 1);
    assert.equal(persistedBatch.qtyM, 750); assert.equal(persistedBatch.amountCents, 925);
    assert.equal((await postAfterRestart('/api/materials/scan/resolve', { code: packagingCode })).catalog.id, catalog.id);
    const rescanned = await postAfterRestart('/api/materials/scan/resolve', scanPayload);
    assert.equal(rescanned.batch.qtyM, 750); assert.equal(rescanned.batch.amountCents, 925);
    async function postAfterRestart(route, payload) {
      return (await request(second.base, route, { method: 'POST', headers: { Cookie: secondCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
    }
    const persistedIssue = (await (await request(second.base, `/api/materials/issues/${application.id}`, { headers: { Cookie: secondCookie } })).json()).issue;
    assert.equal(persistedIssue.status, 'issued'); assert.equal(persistedIssue.amountCents, 309); assert.equal(persistedIssue.snapshot.location, location);
    await assertIssueMovements(second.base, secondCookie);
    assert.deepEqual((await (await request(second.base, unitRoute, { headers: { Cookie: secondCookie } })).json()).items, expectedUnits);
    assert.deepEqual(await (await request(second.base, '/api/materials/unit-label-rule', { headers: { Cookie: secondCookie } })).json(), expectedRule);
    assert.equal((await postAfterRestart('/api/materials/receipts', unitReceiptPayload)).receipt.id, unitReceipt.id);
    assert.equal((await postAfterRestart(`/api/materials/issues/${unitApplication.id}/issue`, unitIssuePayload)).issue.units[0].id, selectedUnit.id);
    const persistedUnitStock = (await (await request(second.base, '/api/materials/stock', { headers: { Cookie: secondCookie } })).json()).items.find(row => row.catalogId === unitCatalog.id);
    assert.equal(persistedUnitStock.qtyM, 2000); assert.equal(persistedUnitStock.amountCents, 67);
    const persistedUnitScan = await postAfterRestart('/api/materials/scan/resolve', { code: selectedUnit.code });
    assert.equal(persistedUnitScan.unit.status, 'issued'); assert.equal(persistedUnitScan.unit.code, selectedUnit.code);
    const secondRequesterCookie = await login(second.base, requesterCredentials);
    const ownIssues = (await (await request(second.base, '/api/materials/issues', { headers: { Cookie: secondRequesterCookie } })).json()).items;
    assert.equal(ownIssues.length, 2);
    for (const issueId of [application.id, unitApplication.id]) {
      const ownIssue = ownIssues.find(row => row.id === issueId);
      assert.equal(ownIssue.status, 'issued');
      assert.equal(ownIssue.amountCents, undefined, 'ordinary issue history must remain amount-redacted after recreation');
    }
    const records = await request(second.base, '/api/records?module=archives', { headers: { Cookie: secondCookie } });
    assert.ok((await records.json()).some(row => row.id === record.id && row.title === title));
    const files = await request(second.base, `/api/files?record_id=${record.id}`, { headers: { Cookie: secondCookie } });
    assert.ok((await files.json()).some(row => row.id === file.id && row.original_name === 'docker-fixture.txt'));
    const downloaded = await request(second.base, `/api/files/${file.id}/download`, { headers: { Cookie: secondCookie } });
    assert.equal(await downloaded.text(), content);
    await compose(['stop', '--timeout', '15', 'labos'], 90000);
    await verifyProject();
    await docker(['run', '--rm', '--pull', 'never', '--user', '0:0', '--platform', environment.DOCKER_DEFAULT_PLATFORM,
      '--label', `labos.test=${project}`, '--mount', `type=bind,source=${runtime},target=/var/lib/labos`,
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
        await compose(['down', '--timeout', '15'], 90000);
        assert.equal(await projectContainers(), '');
        assert.equal(await projectVolumes(), '');
      } catch (error) { cleanupErrors.push(error); }
    }
    if (!cleanupErrors.length && (fs.existsSync(runtime) || fs.existsSync(path.join(directory, 'https')))) {
      try {
        await verifyProject();
        for (const target of [runtime, path.join(directory, 'https')]) {
          if (fs.existsSync(target)) assert.ok(!fs.lstatSync(target).isSymbolicLink(), 'refusing to clean a symlink runtime');
        }
        await docker(['run', '--rm', '--pull', 'never', '--user', '0:0', '--platform', environment.DOCKER_DEFAULT_PLATFORM,
          '--label', `labos.test=${project}`, '--mount', `type=bind,source=${directory},target=/test-fixture`, image, 'node', '-e', `
            const fs=require('node:fs'),assert=require('node:assert/strict');
            assert.equal(fs.readFileSync('/test-fixture/.labos-compose-test','utf8'),${JSON.stringify(project)});
            for(const name of ['runtime','https']) {
              const target='/test-fixture/'+name;
              if(!fs.existsSync(target))continue;
              const stat=fs.lstatSync(target);
              assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'refusing to clean a non-directory runtime');
              fs.rmSync(target,{recursive:true,force:true});
            }
          `], 90000);
        assert.equal(fs.existsSync(runtime), false);
        assert.equal(fs.existsSync(path.join(directory, 'https')), false);
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
