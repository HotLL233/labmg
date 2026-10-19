// PREPARATION DRAFT: syntax checked only; requires frozen 0.5.0 image and runner execution.
// GitHub-hosted linux/amd64 official-image upgrade on synthetic data only. Never mounts or reads the real var/.
// Copy this script into artifacts/cache/0.5.0/validation/ on the runner before execution.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../../../..');
const validation = path.join(root, 'artifacts/cache/0.5.0/validation');
assert.equal(path.resolve(__dirname), validation);
const [, , newRevision, newDigest] = process.argv;
assert.match(newRevision || '', /^[a-f0-9]{40}$/, 'Supply the frozen 0.5.0 commit as argument 1');
assert.match(newDigest || '', /^sha256:[a-f0-9]{64}$/, 'Supply the official 0.5.0 index digest as argument 2');
const oldRevision = '9c71e78dd5719334e3fbed788af60f2d9e333d62';
const oldImage = 'ghcr.io/hotll233/labmg:0.4.0@sha256:6bf41c3d391ea912b1c1085036780abb5250164d3daf3bf346289a36ba7de74f';
const newImage = `ghcr.io/hotll233/labmg:0.5.0@${newDigest}`;
const engineHost = process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
const runId = crypto.randomBytes(7).toString('hex');
const project = `labos-upgrade-040-050-${runId}`;
const restoreProject = `${project}-restore`;
const directory = path.join(validation, `upgrade-${runId}`);
assert.equal(path.dirname(directory), validation);
fs.mkdirSync(directory);
const marker = path.join(directory, '.synthetic-upgrade-test');
fs.writeFileSync(marker, project);
const composeFile = path.join(directory, 'docker-compose.yml');
const envFile = path.join(directory, '.env');
const credentialsFile = path.join(directory, 'synthetic-credentials.json');
const reportFile = path.join(directory, 'report.json');
const anonymous = path.join(directory, 'anonymous-docker');
fs.mkdirSync(anonymous);
fs.writeFileSync(path.join(anonymous, 'config.json'), JSON.stringify({ auths: {} }));
const credentials = Object.fromEntries(['admin', 'material', 'ordinary', 'restricted'].map(role => [role,
  { username: `upgrade-${role}-${runId}`, password: crypto.randomBytes(28).toString('base64url') }]));
fs.writeFileSync(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });
const report = { startedAt: new Date().toISOString(), project, directory, platform: 'linux/amd64', syntheticOnly: true,
  oldRevision, newRevision, images: { old: oldImage, new: newImage }, status: 'running', checks: [], dockerCommands: [],
  verificationEnvironment: { provider: 'GitHub Actions', os: process.platform, architecture: process.arch, runId: process.env.GITHUB_RUN_ID, headSha: process.env.GITHUB_SHA, workflowSha: process.env.GITHUB_WORKFLOW_SHA },
  scope: { runner: 'GitHub-hosted', platform: 'linux/amd64', officialImageUpgrade: '0.4.0-to-0.5.0', schema4Restore: true, schema5Restore: true, syntheticOnly: true },
  boundaries: { arm64UpgradeValidated: false, physicalSynologyNasValidated: false, realBusinessDataUsed: false, longRunningLoadValidated: false },
  limitations: ['GitHub-hosted linux/amd64 only; ARM64 upgrade and physical Synology NAS are not validated.', 'Synthetic isolated data only; this does not validate real business data or long-running load.'], cleanup: { attempted: false } };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function event(name, details = {}) {
  const entry = { at: new Date().toISOString(), name, ...details };
  fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify(entry) + '\n');
  console.log(JSON.stringify(entry));
}
function check(name, details = {}) { report.checks.push({ name, passed: true, ...details }); event(name, details); }
let environment, volumeName, volumeKey, started = false, restoreStarted = false;
const docker = async (args, timeout = 120000, binary = false) => {
  report.dockerCommands.push({ at: new Date().toISOString(), args });
  const result = await execute('docker', ['--config', anonymous, '--host', engineHost, ...args], { cwd: directory, env: environment,
    windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' });
  return binary ? result.stdout : result.stdout.trim();
};
const compose = (args, timeout) => docker(['compose', '--project-name', project, '--file', composeFile, '--env-file', envFile, ...args], timeout);
const restoreCompose = (args, timeout) => docker(['compose', '--project-name', restoreProject, '--file', composeFile, '--env-file', envFile, ...args], timeout);
const inspect = async id => JSON.parse(await docker(['inspect', id]))[0];
const containers = (name = project) => docker(['ps', '--all', '--filter', `label=com.docker.compose.project=${name}`, '--format', '{{.ID}}']);
const volumes = (name = project) => docker(['volume', 'ls', '--filter', `label=com.docker.compose.project=${name}`, '--format', '{{.Name}}']);
async function verifyProject(projectName = project) {
  const expectedVolume = projectName === project ? volumeName : `${restoreProject}_${volumeKey}`;
  assert.ok([project, restoreProject].includes(projectName));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(validation));
  assert.equal(fs.readFileSync(marker, 'utf8'), project);
  for (const id of (await containers(projectName)).split(/\s+/).filter(Boolean)) {
    const container = await inspect(id);
    assert.equal(container.Config.Labels['com.docker.compose.project'], projectName);
    assert.ok(['labos', 'labos-init'].includes(container.Config.Labels['com.docker.compose.service']));
    assert.equal(container.Mounts.find(mount => mount.Destination === '/var/lib/labos').Name, expectedVolume);
  }
  for (const name of (await volumes(projectName)).split(/\s+/).filter(Boolean)) {
    assert.equal(name, expectedVolume);
    const volume = JSON.parse(await docker(['volume', 'inspect', name]))[0];
    assert.equal(volume.Labels['com.docker.compose.project'], projectName);
    assert.equal(volume.Labels['com.docker.compose.volume'], volumeKey);
  }
}
const mounts = container => container.Mounts.map(({ Type, Name, Source, Destination, RW }) => ({ Type, Name, Source, Destination, RW }));
async function start(image) {
  started = true;
  await compose(['up', '--detach', '--pull', 'never', '--wait', '--wait-timeout', '120'], 180000);
  const name = await compose(['ps', '--quiet', 'labos']);
  const initName = await compose(['ps', '--all', '--quiet', 'labos-init']);
  const application = await inspect(name), initializer = await inspect(initName);
  assert.equal(application.Config.Image, image);
  assert.equal(application.State.Health.Status, 'healthy');
  assert.equal(initializer.State.Status, 'exited'); assert.equal(initializer.State.ExitCode, 0);
  assert.equal(application.Mounts.find(mount => mount.Destination === '/var/lib/labos').Name, volumeName);
  assert.equal(initializer.Mounts.find(mount => mount.Destination === '/var/lib/labos').Name, volumeName);
  assert.equal(application.Config.User, '12347:23458');
  assert.deepEqual(JSON.parse(await docker(['exec', name, 'node', '-p', 'JSON.stringify({uid:process.getuid(),gid:process.getgid()})'])), { uid: 12347, gid: 23458 });
  const binding = await docker(['port', name, '3000/tcp']);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  return { name, initName, application, base: `http://${binding}` };
}
async function request(base, method, route, actor, payload, expected = 200) {
  const headers = actor?.cookie ? { Cookie: actor.cookie } : {};
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + route, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const value = response.headers.get('content-type')?.includes('json') ? JSON.parse(bytes) : undefined;
  assert.ok([expected].flat().includes(response.status), `${method} ${route}: expected ${expected}, got ${response.status}: ${value?.error || ''}`);
  return { value, bytes, cookie: response.headers.get('set-cookie')?.split(';')[0], status: response.status };
}
async function login(base, kind) {
  const response = await request(base, 'POST', '/api/auth/login', null, credentials[kind]);
  return { ...response.value.user, cookie: response.cookie };
}
function noMoney(value) {
  if (Array.isArray(value)) return value.forEach(noMoney);
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    assert.ok(!['amountCents', 'amount_cents', 'amount', 'cents'].includes(key)); noMoney(entry);
  }
}
async function pullAndCheck(image, version, revision) {
  await docker(['pull', '--platform', 'linux/amd64', image], 300000);
  const metadata = JSON.parse(await docker(['image', 'inspect', image]))[0];
  assert.equal(metadata.Os, 'linux'); assert.equal(metadata.Architecture, 'amd64');
  assert.equal(metadata.Config.Labels['org.opencontainers.image.version'], version);
  assert.equal(metadata.Config.Labels['org.opencontainers.image.revision'], revision);
  check(`anonymous-official-${version}-pull`, { image, imageId: metadata.Id, revision, architecture: metadata.Architecture });
}


// Added response fields are allowed; every historical field and array element must remain identical.
function preserved(actual, expected) {
  if (Array.isArray(expected)) { assert.ok(Array.isArray(actual)); assert.equal(actual.length, expected.length); expected.forEach((entry, index) => preserved(actual[index], entry)); }
  else if (expected !== null && typeof expected === 'object') { for (const [key, value] of Object.entries(expected)) { assert.ok(Object.hasOwn(actual, key)); preserved(actual[key], value); } }
  else assert.deepEqual(actual, expected);
}
(async () => {
  try {
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.ok(process.env.DOCKER_HOST, 'CI must supply the selected Docker daemon socket');
    assert.ok(engineHost.startsWith('unix:///') && !/[\0?#]/.test(engineHost));
    assert.equal(path.posix.normalize(engineHost.slice(7)), engineHost.slice(7));
    const frozen = (await execute('git', ['show', 'v0.4.0:deploy/docker-compose.yml'], { cwd: root, windowsHide: true, encoding: 'buffer' })).stdout;
    const originalArtifact = fs.readFileSync(path.join(root, 'artifacts/releases/0.4.0/docker-compose.yml'));
    assert.equal(sha(originalArtifact), '9dfe0a2ff3b5631a9949244230f015bb82b9a590983edf5cbb941842e64b0730');
    assert.equal(frozen.toString().replace(/\r\n/g, '\n'), originalArtifact.toString().replace(/\r\n/g, '\n'));
    fs.writeFileSync(composeFile, originalArtifact);
    const baselineEnv = `LABOS_IMAGE=${oldImage}\nLABOS_PORT=127.0.0.1:0\nLABOS_ADMIN_USER=unused-upgrade-default\nLABOS_DATA_DIR=\nLABOS_UID=12347\nLABOS_GID=23458\n`;
    fs.writeFileSync(envFile, baselineEnv);
    report.scope.dockerEndpoint = engineHost;
    environment = { ...process.env };
    for (const key of Object.keys(environment)) if (/^(DOCKER_|LABOS_|COMPOSE_)/i.test(key)) delete environment[key];
    Object.assign(environment, { DOCKER_HOST: engineHost, DOCKER_DEFAULT_PLATFORM: 'linux/amd64', DOCKER_CONFIG: anonymous });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(anonymous, 'config.json'))), { auths: {} });
    check('original-040-yml-byte-exact-release-artifact', { sha256: sha(originalArtifact), revision: oldRevision });
    await pullAndCheck(oldImage, '0.4.0', oldRevision);
    const oldConfig = JSON.parse(await compose(['config', '--format', 'json']));
    const mount = oldConfig.services.labos.volumes.find(row => row.target === '/var/lib/labos');
    assert.equal(mount.type, 'volume'); volumeKey = mount.source; assert.equal(volumeKey, 'labos-runtime-0.4.0');
    volumeName = oldConfig.volumes[volumeKey].name; assert.equal(volumeName, `${project}_${volumeKey}`);
    assert.equal(await containers(), ''); assert.equal(await volumes(), '');
    const first = await start(oldImage), oldMounts = mounts(first.application);
    assert.equal((await request(first.base, 'GET', '/api/auth/me')).value.setupRequired, true);
    const setup = await request(first.base, 'POST', '/api/auth/setup', null, { ...credentials.admin, passwordConfirm: credentials.admin.password }, 201);
    const admin = await login(first.base, 'admin'); assert.equal(admin.id, setup.value.user.id);
    for (const [kind, roles] of [['material', ['MATERIAL']], ['ordinary', ['TESTER']], ['restricted', ['MATERIAL']]]) {
      await request(first.base, 'POST', '/api/users', admin, { ...credentials[kind], roles }, 201);
    }
    await request(first.base, 'POST', '/api/permissions/roles', admin, { role: 'UPGRADE_LIMITED' }, 201);
    await request(first.base, 'PUT', '/api/permissions/roles/UPGRADE_LIMITED', admin, { permissions: ['materials.read'] });
    const material = await login(first.base, 'material'), ordinary = await login(first.base, 'ordinary'), restricted = await login(first.base, 'restricted');
    await request(first.base, 'PUT', `/api/users/${restricted.id}`, admin, { roles: ['UPGRADE_LIMITED'] });
    const oldRoles = (await request(first.base, 'GET', '/api/permissions', admin)).value;
    const category = (await request(first.base, 'POST', '/api/materials/categories', admin, { name: '合成升级分类' }, 201)).value;
    const region = (await request(first.base, 'POST', '/api/materials/regions', admin, { name: '合成升级区域' }, 201)).value;
    const catalog = (await request(first.base, 'POST', '/api/materials/catalog', admin,
      { code: 'UPGRADE-040-050', name: '合成旧数量物资', spec: '250 mL', unit: '瓶', categoryId: category.id }, 201)).value;
    let order = (await request(first.base, 'POST', '/api/materials/requests', ordinary, { title: `合成历史入库 ${runId}` }, 201)).value;
    order = (await request(first.base, 'POST', `/api/materials/requests/${order.id}/items`, ordinary,
      { requestVersion: order.version, catalogId: catalog.id, categoryId: category.id, regionId: region.id, warehouse: 'MAIN', quantity: '3', purpose: '仅隔离升级检查' }, 201)).value;
    order = (await request(first.base, 'POST', `/api/materials/requests/${order.id}/submit`, material, { requestVersion: order.version })).value;
    const receiptBody = { requestId: order.id, itemId: order.items[0].id, requestVersion: order.version, version: order.items[0].version,
      requestIdempotencyKey: crypto.randomUUID(), quantity: '3', amount: '1.00', batch: 'UPGRADE-OLD', expiryDate: '2030-06-07' };
    const originalReceipt = (await request(first.base, 'POST', '/api/materials/receipts', material, receiptBody, 201)).value;
    order = originalReceipt.request;
    const identity = { catalogId: catalog.id, regionId: region.id, warehouse: 'MAIN', batch: receiptBody.batch, expiryDate: receiptBody.expiryDate };
    await request(first.base, 'PUT', '/api/materials/stock/location', admin, { ...identity, version: 0, location: '原版本柜 / 第1层', reason: '历史位置' });
    const barcode = (await request(first.base, 'POST', `/api/materials/catalog/${catalog.id}/barcodes`, admin,
      { code: '000040050', reason: '升级前包装码' }, 201)).value.barcode;
    const historicalIssue = (await request(first.base, 'POST', '/api/materials/issues', ordinary,
      { ...identity, quantity: '1', purpose: '原版本历史领用', requestIdempotencyKey: crypto.randomUUID() }, 201)).value.issue;
    const historicalIssueBody = { version: 1, requestIdempotencyKey: crypto.randomUUID() };
    const oldIssue = (await request(first.base, 'POST', `/api/materials/issues/${historicalIssue.id}/issue`, material, historicalIssueBody, 201)).value.issue;
    assert.equal(oldIssue.amountCents, 33);
    const baselineCatalog = (await request(first.base, 'POST', '/api/materials/catalog', admin,
      { code: 'OLD-UNIT-040', name: '合成旧单件物资', spec: '10 mL', unit: '瓶', categoryId: category.id, trackingMode: 'unit' }, 201)).value;
    let baselineOrder = (await request(first.base, 'POST', '/api/materials/requests', ordinary, { title: '原0.4单件来源' }, 201)).value;
    baselineOrder = (await request(first.base, 'POST', `/api/materials/requests/${baselineOrder.id}/items`, ordinary,
      { requestVersion: baselineOrder.version, catalogId: baselineCatalog.id, categoryId: category.id, regionId: region.id, warehouse: 'MAIN', quantity: '3' }, 201)).value;
    baselineOrder = (await request(first.base, 'POST', `/api/materials/requests/${baselineOrder.id}/submit`, material, { requestVersion: baselineOrder.version })).value;
    const baselineReceiptBody = { requestId: baselineOrder.id, itemId: baselineOrder.items[0].id, requestVersion: baselineOrder.version, version: baselineOrder.items[0].version,
      quantity: '3', amount: '3', batch: 'OLD-UNIT', requestIdempotencyKey: crypto.randomUUID() };
    const baselineReceipt = (await request(first.base, 'POST', '/api/materials/receipts', material, baselineReceiptBody, 201)).value;
    baselineOrder = baselineReceipt.request;
    const baselineIdentity = { catalogId: baselineCatalog.id, regionId: region.id, warehouse: 'MAIN', batch: 'OLD-UNIT', expiryDate: '' };
    await request(first.base, 'PUT', '/api/materials/stock/location', admin, { ...baselineIdentity, version: 0, location: '原单件柜', reason: '原单件位置' });
    const baselineUnits = (await request(first.base, 'GET', `/api/materials/stock/units?catalogId=${baselineCatalog.id}`, material)).value.items;
    const baselineIssue = (await request(first.base, 'POST', '/api/materials/issues', ordinary,
      { ...baselineIdentity, quantity: '1', purpose: '原单件已领用', requestIdempotencyKey: crypto.randomUUID() }, 201)).value.issue;
    const baselineIssueBody = { version: baselineIssue.version, unitIds: [baselineUnits[0].id], requestIdempotencyKey: crypto.randomUUID() };
    await request(first.base, 'POST', `/api/materials/issues/${baselineIssue.id}/issue`, material, baselineIssueBody, 201);
    const oldData = {};
    for (const route of ['/stock', '/stock/batches', '/receipts', '/stock/movements', '/stock/units', '/unit-label-rule', `/requests/${order.id}`, `/issues/${oldIssue.id}`, `/requests/${baselineOrder.id}`, `/issues/${baselineIssue.id}`]) {
      oldData[route] = (await request(first.base, 'GET', '/api/materials' + route, material)).value;
    }
    const oldBackup = (await request(first.base, 'GET', '/api/materials/backup', admin)).value;
    assert.equal(oldBackup.schemaVersion, 4); assert.equal(oldBackup.data.material_barcodes.length, 1);
    assert.equal(oldData['/stock'].items[0].qtyM, 2000); assert.equal(oldData['/stock'].items[0].amountCents, 67);
    assert.equal(oldBackup.data.material_stock_units.length, 3);
    assert.equal(oldData['/stock/units'].items[0].status, 'issued');
    check('040-historical-ledger-units-accounts-location-and-barcodes-created', { requestId: order.id, issueId: oldIssue.id, barcodeId: barcode.id, quantity: 2000, amount: 67, unitCount: 3 });
    await verifyProject(); await compose(['stop', '--timeout', '15'], 90000);
    const stopped = await docker(['run', '--rm', '--pull', 'never', '--platform', 'linux/amd64', '--user', '0:0', '--label', `labos.upgrade-test=${project}`,
      '--mount', `type=volume,source=${volumeName},target=/var/lib/labos,readonly`, '--entrypoint', 'tar', oldImage, '-czf', '-', '-C', '/var/lib/labos', '.'], 90000, true);
    fs.writeFileSync(path.join(directory, 'synthetic-stopped-runtime-backup.tar.gz'), stopped);
    check('stopped-original-volume-backed-up', { bytes: stopped.length, sha256: sha(stopped) });
    await pullAndCheck(newImage, '0.5.0', newRevision);
    fs.writeFileSync(envFile, baselineEnv.replace(`LABOS_IMAGE=${oldImage}`, `LABOS_IMAGE=${newImage}`));
    assert.equal(fs.readFileSync(envFile, 'utf8').replace(`LABOS_IMAGE=${newImage}`, `LABOS_IMAGE=${oldImage}`), baselineEnv);
    assert.equal(sha(fs.readFileSync(composeFile)), sha(originalArtifact));
    const expectedConfig = structuredClone(oldConfig); expectedConfig.services.labos.image = newImage; expectedConfig.services['labos-init'].image = newImage;
    assert.deepEqual(JSON.parse(await compose(['config', '--format', 'json'])), expectedConfig);
    const second = await start(newImage); assert.deepEqual(mounts(second.application), oldMounts);
    report.upgrade = { onlyEnvImageChanged: true, originalYmlUnchanged: true, projectUnchanged: true,
      volumeUnchanged: true, mountsUnchanged: true, uidGidUnchanged: true, volumeName, uid: 12347, gid: 23458 };
    check('upgrade-only-image-changed-original-yml-project-volume-user-preserved', { volumeName, ymlSha256: sha(originalArtifact) });
    assert.equal((await request(second.base, 'GET', '/api/auth/me')).value.setupRequired, false);
    await request(second.base, 'POST', '/api/auth/setup', null, { ...credentials.admin, passwordConfirm: credentials.admin.password }, 409);
    const newAdmin = await login(second.base, 'admin'), newMaterial = await login(second.base, 'material'), newOrdinary = await login(second.base, 'ordinary');
    assert.equal(newAdmin.id, admin.id); assert.equal(newMaterial.id, material.id); assert.equal(newOrdinary.id, ordinary.id);
    for (const [route, value] of Object.entries(oldData)) preserved((await request(second.base, 'GET', '/api/materials' + route, newMaterial)).value, value);
    const newRoles = (await request(second.base, 'GET', '/api/permissions', newAdmin)).value;
    const roleRows = value => Array.isArray(value) ? value : value.roles;
    assert.deepEqual(roleRows(newRoles).find(row => row.role === 'UPGRADE_LIMITED'), roleRows(oldRoles).find(row => row.role === 'UPGRADE_LIMITED'));
    assert.deepEqual(new Set(roleRows(newRoles).find(row => row.role === 'MATERIAL').permissions), new Set(roleRows(oldRoles).find(row => row.role === 'MATERIAL').permissions));
    const masters = (await request(second.base, 'GET', '/api/materials/catalog', newMaterial)).value.items;
    assert.equal(masters.find(row => row.id === catalog.id).trackingMode, 'quantity');
    await request(second.base, 'PUT', `/api/materials/catalog/${catalog.id}/tracking-mode`, newAdmin,
      { trackingMode: 'unit', version: catalog.version, reason: '禁止已有账物资改模式' }, 409);
    assert.equal((await request(second.base, 'GET', '/api/materials/stock/units', newMaterial)).value.total, 3);
    assert.equal((await request(second.base, 'GET', '/api/materials/openings', newMaterial)).value.total, 0);
    await request(second.base, 'POST', '/api/materials/receipts', newMaterial, baselineReceiptBody);
    await request(second.base, 'POST', `/api/materials/issues/${baselineIssue.id}/issue`, newMaterial, baselineIssueBody);
    const mapped = (await request(second.base, 'POST', '/api/materials/scan/resolve', newOrdinary, { code: barcode.code })).value;
    assert.equal(mapped.kind, 'catalog'); assert.equal(mapped.catalog.id, catalog.id);
    const oldQr = oldData['/stock/batches'].items[0].qrPayload;
    assert.equal((await request(second.base, 'POST', '/api/materials/scan/resolve', newMaterial, { code: oldQr })).value.batch.qtyM, 2000);
    check('historical-040-ledger-units-accounts-roles-and-barcodes-preserved', { defaultTracking: 'quantity', preservedUnitIdentities: 3, oldBarcodeId: barcode.id });

    const oldRule = (await request(second.base, 'GET', '/api/materials/unit-label-rule', newAdmin)).value;
    const ruleBody = { template: 'UP-{YYYY}{MM}{DD}-{SEQ}', padding: 6, version: oldRule.rule.version, reason: '合成升级规则' };
    await request(second.base, 'PUT', '/api/materials/unit-label-rule', newAdmin, ruleBody);
    const unitCatalog = (await request(second.base, 'POST', '/api/materials/catalog', newAdmin,
      { code: 'UPGRADE-UNIT-050', name: '合成单件物资', spec: '250 mL', unit: '瓶', categoryId: category.id, trackingMode: 'unit' }, 201)).value;
    assert.equal(unitCatalog.trackingMode, 'unit');
    let unitOrder = (await request(second.base, 'POST', '/api/materials/requests', newOrdinary, { title: '升级后单件申报' }, 201)).value;
    unitOrder = (await request(second.base, 'POST', `/api/materials/requests/${unitOrder.id}/items`, newOrdinary,
      { requestVersion: unitOrder.version, catalogId: unitCatalog.id, categoryId: category.id, regionId: region.id, warehouse: 'MAIN', quantity: '3' }, 201)).value;
    unitOrder = (await request(second.base, 'POST', `/api/materials/requests/${unitOrder.id}/submit`, newMaterial, { requestVersion: unitOrder.version })).value;
    const unitReceiptBody = { requestId: unitOrder.id, itemId: unitOrder.items[0].id, requestVersion: unitOrder.version, version: unitOrder.items[0].version,
      requestIdempotencyKey: crypto.randomUUID(), quantity: '3', amount: '1.00', batch: 'UPGRADE-UNIT', expiryDate: '2031-02-03', location: '验收新柜 / 02', locationVersion: 0 };
    const unitReceipt = (await request(second.base, 'POST', '/api/materials/receipts', newMaterial, unitReceiptBody, 201)).value;
    unitOrder = unitReceipt.request;
    const unitRows = (await request(second.base, 'GET', `/api/materials/stock/units?receiptId=${unitReceipt.receipt.id}`, newMaterial)).value.items;
    assert.equal(unitRows.length, 3); assert.equal(new Set(unitRows.map(row => row.id)).size, 3); assert.equal(new Set(unitRows.map(row => row.code)).size, 3);
    assert.ok(unitRows.every(row => row.status === 'in_stock' && row.sourceReceiptId === unitReceipt.receipt.id && /^UP-\d{8}-\d{6}$/.test(row.code)));
    const sequences = unitRows.map(row => row.sequence).sort((a, b) => a - b);
    assert.deepEqual(sequences, [sequences[0], sequences[0] + 1, sequences[0] + 2]);
    const replayReceipt = (await request(second.base, 'POST', '/api/materials/receipts', newMaterial, unitReceiptBody)).value;
    assert.equal(replayReceipt.receipt.id, unitReceipt.receipt.id);
    assert.equal((await request(second.base, 'GET', `/api/materials/stock/units?receiptId=${unitReceipt.receipt.id}`, newMaterial)).value.total, 3);
    const resolved = (await request(second.base, 'POST', '/api/materials/scan/resolve', newOrdinary, { code: unitRows[0].code })).value;
    assert.equal(resolved.kind, 'unit'); assert.equal(resolved.unit.id, unitRows[0].id); noMoney(resolved);
    assert.equal(unitReceipt.receipt.snapshot.location, '验收新柜 / 02');
    const receiptBatch = (await request(second.base, 'GET', `/api/materials/stock/batches?catalogId=${unitCatalog.id}`, newMaterial)).value.items[0];
    assert.equal(receiptBatch.locationVersion, 1); assert.equal(receiptBatch.location, '验收新柜 / 02');
    const secondReceiptOrder = (await request(second.base, 'POST', '/api/materials/requests', newOrdinary, { title: '位置竞争' }, 201)).value;
    let positionOrder = (await request(second.base, 'POST', `/api/materials/requests/${secondReceiptOrder.id}/items`, newOrdinary,
      { requestVersion: secondReceiptOrder.version, catalogId: unitCatalog.id, regionId: region.id, warehouse: 'MAIN', quantity: '1' }, 201)).value;
    positionOrder = (await request(second.base, 'POST', `/api/materials/requests/${positionOrder.id}/submit`, newMaterial, { requestVersion: positionOrder.version })).value;
    const stalePosition = { ...unitReceiptBody, requestId: positionOrder.id, itemId: positionOrder.items[0].id, requestVersion: positionOrder.version,
      version: positionOrder.items[0].version, quantity: '1', location: '不能覆盖的新柜', requestIdempotencyKey: crypto.randomUUID() };
    await request(second.base, 'POST', '/api/materials/receipts', newMaterial, stalePosition, 409);
    assert.equal((await request(second.base, 'GET', `/api/materials/requests/${positionOrder.id}`, newMaterial)).value.version, positionOrder.version);
    assert.equal((await request(second.base, 'GET', `/api/materials/stock/units?catalogId=${unitCatalog.id}`, newMaterial)).value.total, 3);
    check('receipt-location-and-version-conflict-atomic', { unitCount: 3, uniqueCodes: 3, firstSequence: sequences[0], lastSequence: sequences.at(-1), idempotentReceipt: true, location: receiptBatch.location });
    const unitIdentity = { catalogId: unitCatalog.id, regionId: region.id, warehouse: 'MAIN', batch: 'UPGRADE-UNIT', expiryDate: '2031-02-03' };
    const unitIssuePayload = { ...unitIdentity, quantity: '1', purpose: '升级单件领用', requestIdempotencyKey: crypto.randomUUID() };
    const unitIssue = (await request(second.base, 'POST', '/api/materials/issues', newOrdinary, unitIssuePayload, 201)).value.issue;
    const unitIssueBody = { version: unitIssue.version, unitIds: [unitRows[0].id], requestIdempotencyKey: crypto.randomUUID() };
    const issued = (await request(second.base, 'POST', `/api/materials/issues/${unitIssue.id}/issue`, newMaterial, unitIssueBody, 201)).value.issue;
    assert.equal(issued.status, 'issued'); assert.equal(issued.amountCents, 33);
    await request(second.base, 'POST', `/api/materials/issues/${unitIssue.id}/issue`, newMaterial, unitIssueBody);
    const duplicate = (await request(second.base, 'POST', '/api/materials/issues', newOrdinary,
      { ...unitIssuePayload, requestIdempotencyKey: crypto.randomUUID() }, 201)).value.issue;
    await request(second.base, 'POST', `/api/materials/issues/${duplicate.id}/issue`, newMaterial,
      { version: duplicate.version, unitIds: [unitRows[0].id], requestIdempotencyKey: crypto.randomUUID() }, 409);
    await request(second.base, 'POST', `/api/materials/receipts/${unitReceipt.receipt.id}/reverse`, newMaterial,
      { requestVersion: unitOrder.version, version: unitOrder.items[0].version, reason: '已发单件禁止原单冲正', requestIdempotencyKey: crypto.randomUUID() }, 409);
    const unitStock = (await request(second.base, 'GET', `/api/materials/stock/batches?catalogId=${unitCatalog.id}`, newMaterial)).value.items[0];
    assert.equal(unitStock.qtyM, 2000); assert.equal(unitStock.amountCents, 67);
    check('unit-issue-and-origin-reversal-guards', { issuedId: unitRows[0].id, issueAmount: 33, remainingQtyM: 2000, remainingAmount: 67 });
    const currentRule = (await request(second.base, 'GET', '/api/materials/unit-label-rule', newAdmin)).value;
    await request(second.base, 'PUT', '/api/materials/unit-label-rule', newAdmin,
      { template: 'NEXT-{YYYY}{MM}{DD}-{SEQ}', padding: 6, version: currentRule.rule.version, reason: '修改只影响后续新码' });
    const adjustment = (await request(second.base, 'POST', '/api/materials/stock/adjustments', newMaterial,
      { ...unitIdentity, quantity: '1', amount: '0', direction: 'increase', reason: '合成新增赠品', requestIdempotencyKey: crypto.randomUUID() }, 201)).value;
    const allUnits = (await request(second.base, 'GET', `/api/materials/stock/units?catalogId=${unitCatalog.id}`, newMaterial)).value.items;
    assert.equal(allUnits.length, 4);
    const newest = allUnits.find(row => !unitRows.some(old => old.id === row.id));
    assert.ok(newest.code.startsWith('NEXT-')); assert.ok(newest.sequence > sequences.at(-1));
    for (const row of unitRows) assert.equal(allUnits.find(current => current.id === row.id).code, row.code);
    check('rule-change-keeps-old-codes-and-global-sequence', { newSequence: newest.sequence, adjustmentId: adjustment.movement.id });
    const legacyIssue = (await request(second.base, 'POST', '/api/materials/issues', newOrdinary,
      { ...identity, quantity: '1', purpose: '升级后旧数量物资继续领用', requestIdempotencyKey: crypto.randomUUID() }, 201)).value.issue;
    const legacyIssued = (await request(second.base, 'POST', `/api/materials/issues/${legacyIssue.id}/issue`, newMaterial,
      { version: legacyIssue.version, requestIdempotencyKey: crypto.randomUUID() }, 201)).value.issue;
    assert.equal(legacyIssued.amountCents, 34);
    assert.equal((await request(second.base, 'GET', `/api/materials/stock/batches?catalogId=${catalog.id}`, newMaterial)).value.items[0].amountCents, 33);
    check('old-quantity-workflow-remains-operable', { amountCents: 34, oldCatalogId: catalog.id });
    assert.equal((await request(second.base, 'GET', '/api/materials/meta', newMaterial)).value.openingClosed, true);
    await request(second.base, 'POST', '/api/materials/openings', newOrdinary, { title: '越权补录', reason: '应拒绝' }, 403);
    await request(second.base, 'POST', '/api/materials/openings', newMaterial, { title: '无原因补录' }, 400);
    let supplement = (await request(second.base, 'POST', '/api/materials/openings', newMaterial,
      { title: '升级后有原因的单件补录', description: '仅合成数据', reason: '遗漏两瓶补齐', date: '2026-10-19' }, 201)).value;
    assert.equal(supplement.kind, 'supplement'); assert.equal(supplement.status, 'draft');
    const openingUnitsBefore = (await request(second.base, 'GET', '/api/materials/stock/units', newMaterial)).value.total;
    const openingLine = { catalogId: unitCatalog.id, regionId: region.id, warehouse: 'MAIN', batch: 'SUPPLEMENT-DOC',
      quantity: '2', amount: '2.50', location: '补录柜 / 03', locationVersion: 0 };
    supplement = (await request(second.base, 'POST', `/api/materials/openings/${supplement.id}/items`, newMaterial,
      { ...openingLine, version: supplement.version }, 201)).value;
    assert.equal((await request(second.base, 'GET', '/api/materials/stock/units', newMaterial)).value.total, openingUnitsBefore);
    const posting = { version: supplement.version, requestIdempotencyKey: crypto.randomUUID() };
    const posts = await Promise.all([1, 2].map(() => request(second.base, 'POST', `/api/materials/openings/${supplement.id}/post`, newMaterial, posting, [200, 201])));
    assert.deepEqual(posts.map(row => row.status).sort(), [200, 201]); supplement = posts[0].value.opening;
    assert.equal(supplement.status, 'posted'); assert.equal(supplement.unitCount, 2);
    await request(second.base, 'PATCH', `/api/materials/openings/${supplement.id}`, newMaterial,
      { title: '已入库不可改', version: supplement.version }, 409);
    const openingUnits = (await request(second.base, 'GET', `/api/materials/stock/units?openingId=${supplement.id}`, newMaterial)).value.items;
    assert.equal(openingUnits.length, 2); assert.ok(openingUnits.every(row => row.location === openingLine.location && row.status === 'in_stock'));
    assert.equal((await request(second.base, 'GET', '/api/materials/meta', newMaterial)).value.openingClosed, true);
    const source = (await request(second.base, 'GET', '/api/materials/stock/movements?type=adjustment', newMaterial)).value.items.find(row => row.id === supplement.items[0].movementId);
    assert.ok(source); assert.match(source.reason, /遗漏两瓶补齐/); assert.equal(source.qtyM, 2000);
    check('closed-opening-supplement-doc-generates-units-idempotently', { documentId: supplement.id, unitCount: 2, openingRemainsClosed: true, amountCents: 250 });
    const template = await request(second.base, 'GET', '/api/materials/openings/template.xlsx', newMaterial);
    assert.equal(template.bytes.readUInt32LE(0), 0x04034b50);
    let importedDoc = (await request(second.base, 'POST', '/api/materials/openings', newMaterial,
      { title: 'Excel补录', reason: '历史表迁入', date: '2026-10-19' }, 201)).value;
    const headings = ['物资编码', '区域', '仓库编码', '数量', '总金额（元）', '批号', '有效期', '存放位置', '零金额原因'];
    const excelRows = [headings, [catalog.code, region.name, 'MAIN', 1, 0.01, 'EXCEL-DOC', '2032-01-02', 'Excel柜', '']];
    const workbookScript = `(async()=>{const w=require('write-excel-file/node').default;const rows=${JSON.stringify(excelRows)};const buffer=await w([{sheet:'期初明细',data:rows.map(row=>row.map(value=>({type:typeof value==='number'?Number:String,value})))}]).toBuffer();process.stdout.write(buffer.toString('base64'));})().catch(error=>{console.error(error.message);process.exitCode=1;});`;
    const excelContent = await docker(['exec', second.name, 'node', '-e', workbookScript]);
    const importInput = { version: importedDoc.version, name: 'synthetic-opening.xlsx', content: excelContent };
    await request(second.base, 'POST', `/api/materials/openings/${importedDoc.id}/import`, newOrdinary, importInput, 403);
    await request(second.base, 'POST', `/api/materials/openings/${importedDoc.id}/import`, newMaterial, { ...importInput, name: 'old.xls' }, 400);
    importedDoc = (await request(second.base, 'POST', `/api/materials/openings/${importedDoc.id}/import`, newMaterial, importInput, 201)).value;
    assert.equal(importedDoc.items.length, 1); assert.equal(importedDoc.items[0].amountCents, 1); assert.equal(importedDoc.items[0].location, 'Excel柜');
    const exportedOpening = await request(second.base, 'GET', `/api/materials/openings/${importedDoc.id}/export.xlsx`, newMaterial);
    assert.equal(exportedOpening.bytes.readUInt32LE(0), 0x04034b50);
    noMoney((await request(second.base, 'GET', `/api/materials/openings/${importedDoc.id}`, newOrdinary)).value);
    importedDoc = (await request(second.base, 'POST', `/api/materials/openings/${importedDoc.id}/post`, newMaterial,
      { version: importedDoc.version, requestIdempotencyKey: crypto.randomUUID() }, 201)).value.opening;
    assert.equal(importedDoc.status, 'posted'); assert.equal(importedDoc.unitCount, 0);
    const importedStock = (await request(second.base, 'GET', '/api/materials/stock/batches?batch=EXCEL-DOC', newMaterial)).value.items;
    assert.equal(importedStock.length, 1); assert.equal(importedStock[0].qtyM, 1000); assert.equal(importedStock[0].amountCents, 1); assert.equal(importedStock[0].location, 'Excel柜');
    const draft = (await request(second.base, 'POST', '/api/materials/openings', newMaterial, { title: '保留草稿', reason: '尚待核对' }, 201)).value;
    check('opening-xlsx-template-import-export-and-permissions', { templateBytes: template.bytes.length, exportedBytes: exportedOpening.bytes.length, postedId: importedDoc.id, persistentDraftId: draft.id });
    const newBackup = (await request(second.base, 'GET', '/api/materials/backup', newAdmin)).value;
    assert.equal(newBackup.schemaVersion, 5); assert.equal(newBackup.data.material_stock_units.length, 9);
    assert.equal(newBackup.data.material_barcodes.length, 1);
    assert.equal(newBackup.data.material_openings.length, 3); assert.equal(newBackup.data.material_opening_items.length, 2);
    const unitXlsx = await request(second.base, 'GET', '/api/materials/export.xlsx?type=stock', newMaterial);
    assert.equal(unitXlsx.bytes.readUInt32LE(0), 0x05034b50);
    check('schema5-backup-includes-opening-documents-and-unit-identities', { units: 9, schemaVersion: 5, documents: 3, postedLines: 2 });
    const finalUnitRows = (await request(second.base, 'GET', `/api/materials/stock/units?catalogId=${unitCatalog.id}`, newMaterial)).value.items;
    await compose(['restart', 'labos'], 90000);
    const third = await start(newImage), thirdAdmin = await login(third.base, 'admin'), thirdMaterial = await login(third.base, 'material');
    assert.deepEqual(mounts(third.application), oldMounts);
    assert.deepEqual((await request(third.base, 'GET', `/api/materials/stock/units?catalogId=${unitCatalog.id}`, thirdMaterial)).value.items, finalUnitRows);
    assert.equal((await request(third.base, 'GET', '/api/materials/unit-label-rule', thirdAdmin)).value.rule.template, 'NEXT-{YYYY}{MM}{DD}-{SEQ}');
    await request(third.base, 'POST', `/api/materials/issues/${unitIssue.id}/issue`, thirdMaterial, unitIssueBody);
    await request(third.base, 'POST', '/api/materials/receipts', thirdMaterial, unitReceiptBody);
    assert.equal((await request(third.base, 'GET', `/api/materials/stock/units?catalogId=${unitCatalog.id}`, thirdMaterial)).value.total, 6);
    assert.deepEqual((await request(third.base, 'GET', `/api/materials/openings/${supplement.id}`, thirdMaterial)).value, supplement);
    assert.deepEqual((await request(third.base, 'GET', `/api/materials/openings/${draft.id}`, thirdMaterial)).value, draft);
    await request(third.base, 'POST', `/api/materials/openings/${supplement.id}/post`, thirdMaterial, posting);
    assert.equal((await request(third.base, 'GET', '/api/materials/stock/units', thirdMaterial)).value.total, 9);
    check('restart-preserves-opening-documents-units-and-idempotency', { volumeName, totalUnitIdentities: 9, documents: 3 });
    restoreStarted = true;
    await restoreCompose(['up', '--detach', '--pull', 'never', '--wait', '--wait-timeout', '120'], 180000);
    await verifyProject(restoreProject);
    const restoreContainer = await restoreCompose(['ps', '--quiet', 'labos']);
    const binding = await docker(['port', restoreContainer, '3000/tcp']); assert.match(binding, /^127\.0\.0\.1:\d+$/);
    const restoreBase = `http://${binding}`;
    await request(restoreBase, 'POST', '/api/auth/setup', null, { ...credentials.admin, passwordConfirm: credentials.admin.password }, 201);
    const restoreAdmin = await login(restoreBase, 'admin');
    await request(restoreBase, 'POST', '/api/permissions/roles', restoreAdmin, { role: 'UPGRADE_LIMITED' }, 201);
    await request(restoreBase, 'PUT', '/api/permissions/roles/UPGRADE_LIMITED', restoreAdmin, { permissions: ['materials.read'] });
    for (const [kind, roles] of [['ordinary', ['TESTER']], ['restricted', ['UPGRADE_LIMITED']], ['material', ['MATERIAL']]]) {
      await request(restoreBase, 'POST', '/api/users', restoreAdmin, { ...credentials[kind], roles }, 201);
    }
    await request(restoreBase, 'POST', '/api/materials/restore', restoreAdmin, oldBackup);
    const restoreMaterial = await login(restoreBase, 'material');
    assert.equal((await request(restoreBase, 'GET', '/api/materials/stock/units', restoreMaterial)).value.total, 3);
    const restored = (await request(restoreBase, 'GET', '/api/materials/backup', restoreAdmin)).value;
    assert.equal(restored.schemaVersion, 5);
    assert.deepEqual(restored.data.material_stock_units.map(row => ({ code: row.code, sequence: row.sequence, status: row.status })), oldBackup.data.material_stock_units.map(row => ({ code: row.code, sequence: row.sequence, status: row.status })));
    assert.deepEqual(restored.data.material_openings, []); assert.deepEqual(restored.data.material_opening_items, []);
    assert.equal(restored.data.material_barcodes.length, 1);
    assert.equal((await request(restoreBase, 'POST', '/api/materials/scan/resolve', restoreMaterial, { code: barcode.code })).value.catalog.id, catalog.id);
    assert.equal((await request(restoreBase, 'GET', `/api/materials/issues/${oldIssue.id}`, restoreMaterial)).value.issue.amountCents, 33);
    check('schema4-backup-imports-with-preserved-units-and-no-invented-documents', { schemaVersion: 5, legacyBarcodeCount: 1, preservedUnits: 3, inventedDocuments: 0 });
    await verifyProject(restoreProject);
    await restoreCompose(['down', '--volumes', '--timeout', '15'], 90000);
    assert.equal(await containers(restoreProject), ''); assert.equal(await volumes(restoreProject), '');
    await restoreCompose(['up', '--detach', '--pull', 'never', '--wait', '--wait-timeout', '120'], 180000);
    await verifyProject(restoreProject);
    const schema5Container = await restoreCompose(['ps', '--quiet', 'labos']);
    const schema5Binding = await docker(['port', schema5Container, '3000/tcp']); assert.match(schema5Binding, /^127\.0\.0\.1:\d+$/);
    const schema5Base = `http://${schema5Binding}`;
    await request(schema5Base, 'POST', '/api/auth/setup', null, { ...credentials.admin, passwordConfirm: credentials.admin.password }, 201);
    const schema5Admin = await login(schema5Base, 'admin');
    await request(schema5Base, 'POST', '/api/permissions/roles', schema5Admin, { role: 'UPGRADE_LIMITED' }, 201);
    await request(schema5Base, 'PUT', '/api/permissions/roles/UPGRADE_LIMITED', schema5Admin, { permissions: ['materials.read'] });
    for (const [kind, roles] of [['ordinary', ['TESTER']], ['restricted', ['UPGRADE_LIMITED']], ['material', ['MATERIAL']]]) {
      await request(schema5Base, 'POST', '/api/users', schema5Admin, { ...credentials[kind], roles }, 201);
    }
    await request(schema5Base, 'POST', '/api/materials/restore', schema5Admin, newBackup);
    const schema5Material = await login(schema5Base, 'material');
    assert.notEqual(schema5Material.id, newMaterial.id);
    const restoredOpening = (await request(schema5Base, 'GET', `/api/materials/openings/${supplement.id}`, schema5Material)).value;
    assert.equal(restoredOpening.status, 'posted'); assert.equal(restoredOpening.kind, 'supplement'); assert.equal(restoredOpening.unitCount, 2);
    assert.equal(restoredOpening.createdBy, schema5Material.id); assert.equal(restoredOpening.postedBy, schema5Material.id);
    assert.equal(restoredOpening.items[0].location, openingLine.location);
    assert.equal((await request(schema5Base, 'GET', `/api/materials/openings/${draft.id}`, schema5Material)).value.status, 'draft');
    const restoredUnits = (await request(schema5Base, 'GET', '/api/materials/stock/units', schema5Material)).value;
    assert.equal(restoredUnits.total, 9);
    assert.deepEqual(restoredUnits.items.map(row => ({ code: row.code, sequence: row.sequence, status: row.status })), newBackup.data.material_stock_units.map(row => ({ code: row.code, sequence: row.sequence, status: row.status })));
    const schema5Replay = (await request(schema5Base, 'POST', `/api/materials/openings/${supplement.id}/post`, schema5Material, posting)).value.opening;
    assert.equal(schema5Replay.postedBy, schema5Material.id); assert.equal(schema5Replay.unitCount, 2);
    assert.equal((await request(schema5Base, 'GET', '/api/materials/meta', schema5Material)).value.openingClosed, true);
    check('schema5-backup-restores-posted-documents-units-and-drafts', { units: 9, documents: 3, mappedPosterId: schema5Material.id, originalPosterId: newMaterial.id, idempotencyPreserved: true });
    await verifyProject(); report.unitNumberingValidated = true; report.materialIntakeValidated = true;
    report.schema4MigrationValidated = true; report.schema5RestoreValidated = true; report.status = 'passed';

  } catch (error) {
    report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack };
    event('validation-failed', { name: error.name, message: error.message }); process.exitCode = 1;
  } finally {
    report.cleanup.attempted = true;
    try {
      if (restoreStarted) {
        await verifyProject(restoreProject); await restoreCompose(['down', '--volumes', '--timeout', '15'], 90000);
        assert.equal(await containers(restoreProject), ''); assert.equal(await volumes(restoreProject), '');
      }
      if (started) {
        await verifyProject(); await compose(['down', '--volumes', '--timeout', '15'], 90000);
        assert.equal(await containers(), ''); assert.equal(await volumes(), '');
      }
      assert.equal(path.dirname(path.resolve(credentialsFile)), path.resolve(directory));
      assert.equal(fs.readFileSync(marker, 'utf8'), project); fs.unlinkSync(credentialsFile);
      report.cleanup = { attempted: true, passed: true, projectContainersRemaining: 0, projectVolumesRemaining: 0, credentialsRemoved: true };
      check('isolated-project-containers-volume-and-credentials-cleaned');
    } catch (error) { report.cleanup = { attempted: true, passed: false, error: error.message }; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(validation, 'upgrade-040-to-050-latest.json'), JSON.stringify({ report: reportFile, status: report.status, cleanup: report.cleanup }, null, 2) + '\n');
    if (report.status === 'passed' && report.cleanup.passed) fs.writeFileSync(path.join(root, 'artifacts/cache/0.5.0/upgrade-verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ report: reportFile, status: report.status, cleanup: report.cleanup }));
  }
})();
