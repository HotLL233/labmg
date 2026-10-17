// GitHub-hosted linux/amd64 official-image upgrade on synthetic data only. Never mounts or reads the real var/.
// Copy this script into artifacts/cache/0.3.3/validation/ on the runner before execution.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../../../..');
const validation = path.join(root, 'artifacts/cache/0.3.3/validation');
assert.equal(path.resolve(__dirname), validation);
const [, , newRevision, newDigest] = process.argv;
assert.match(newRevision || '', /^[a-f0-9]{40}$/, 'Supply the frozen 0.3.3 commit as argument 1');
assert.match(newDigest || '', /^sha256:[a-f0-9]{64}$/, 'Supply the official 0.3.3 index digest as argument 2');
const oldRevision = 'd261a94b6b54ef1c461517e7b8793d15a928cbb1';
const oldImage = 'ghcr.io/hotll233/labmg:0.3.2@sha256:d0849a6c1657042c123ffe9074eb47f3ce43b6d689fd043820c9ee73131b1e4b';
const newImage = `ghcr.io/hotll233/labmg:0.3.3@${newDigest}`;
const engineHost = process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
const runId = crypto.randomBytes(7).toString('hex');
const project = `labos-upgrade-032-033-${runId}`;
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
  scope: { runner: 'GitHub-hosted', platform: 'linux/amd64', officialImageUpgrade: '0.3.2-to-0.3.3', schema2Restore: true, syntheticOnly: true },
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

(async () => {
  try {
    assert.equal(process.platform, 'linux', 'This helper is for the isolated Linux runner');
    assert.equal(process.arch, 'x64', 'The upgrade runner must be amd64');
    if (process.env.GITHUB_ACTIONS === 'true') assert.ok(process.env.DOCKER_HOST, 'CI must supply the selected Docker daemon socket');
    assert.ok(engineHost.startsWith('unix:///') && !/[\0?#]/.test(engineHost), 'Docker host must be an absolute local Unix socket without query or fragment');
    assert.equal(path.posix.normalize(engineHost.slice(7)), engineHost.slice(7));
    const frozen = (await execute('git', ['show', 'v0.3.2:deploy/docker-compose.yml'], { cwd: root, windowsHide: true, encoding: 'buffer' })).stdout;
    const originalArtifact = fs.readFileSync(path.join(root, 'artifacts/releases/0.3.2/docker-compose.yml'));
    assert.equal(sha(originalArtifact), 'c3818f7f8e858890f6673e73d8befe433df768bd19a1a91118931df410c1f5d6');
    assert.equal(frozen.toString().replace(/\r\n/g, '\n'), originalArtifact.toString().replace(/\r\n/g, '\n'));
    fs.writeFileSync(composeFile, originalArtifact);
    const baselineEnv = `LABOS_IMAGE=${oldImage}\nLABOS_PORT=127.0.0.1:0\nLABOS_ADMIN_USER=unused-upgrade-default\nLABOS_DATA_DIR=\nLABOS_UID=12347\nLABOS_GID=23458\n`;
    fs.writeFileSync(envFile, baselineEnv);
    report.scope.dockerEndpoint = engineHost;
    environment = { ...process.env };
    for (const key of Object.keys(environment)) if (/^(DOCKER_|LABOS_|COMPOSE_)/i.test(key)) delete environment[key];
    Object.assign(environment, { DOCKER_HOST: engineHost, DOCKER_DEFAULT_PLATFORM: 'linux/amd64', DOCKER_CONFIG: anonymous });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(anonymous, 'config.json'))), { auths: {} });
    check('original-032-yml-byte-exact-release-artifact', { sha256: sha(originalArtifact), revision: oldRevision });
    await pullAndCheck(oldImage, '0.3.2', oldRevision);
    const oldConfig = JSON.parse(await compose(['config', '--format', 'json']));
    const mount = oldConfig.services.labos.volumes.find(mount => mount.target === '/var/lib/labos');
    assert.equal(mount.type, 'volume'); volumeKey = mount.source; assert.equal(volumeKey, 'labos-runtime-0.3.2');
    volumeName = oldConfig.volumes[volumeKey].name; assert.equal(volumeName, `${project}_${volumeKey}`);
    assert.equal(await containers(), ''); assert.equal(await volumes(), '');
    assert.ok(!(await docker(['volume', 'ls', '--filter', `name=${volumeName}`, '--format', '{{.Name}}'])).split(/\s+/).includes(volumeName));
    const first = await start(oldImage), oldMounts = mounts(first.application);
    check('old-compose-healthy-isolated-project-volume-uid', { volumeName, user: first.application.Config.User });
    assert.equal((await request(first.base, 'GET', '/api/auth/me')).value.setupRequired, true);
    const setup = await request(first.base, 'POST', '/api/auth/setup', null, { ...credentials.admin, passwordConfirm: credentials.admin.password }, 201);
    const admin = await login(first.base, 'admin'); assert.equal(admin.id, setup.value.user.id);
    for (const [kind, roles] of [['material', ['MATERIAL']], ['ordinary', ['TESTER']], ['restricted', ['MATERIAL']]]) {
      await request(first.base, 'POST', '/api/users', admin, { ...credentials[kind], roles }, 201);
    }
    const material = await login(first.base, 'material'), ordinary = await login(first.base, 'ordinary'), restricted = await login(first.base, 'restricted');
    // Preserve a deliberately customized role; the default role separately exercises the additive permission migration.
    await request(first.base, 'POST', '/api/permissions/roles', admin, { role: 'UPGRADE_LIMITED' }, 201);
    await request(first.base, 'PUT', '/api/permissions/roles/UPGRADE_LIMITED', admin, { permissions: ['materials.read'] });
    await request(first.base, 'PUT', `/api/users/${restricted.id}`, admin, { roles: ['UPGRADE_LIMITED'] });
    const oldRoles = (await request(first.base, 'GET', '/api/permissions', admin)).value;
    const category = (await request(first.base, 'POST', '/api/materials/categories', admin, { name: '合成升级分类' }, 201)).value;
    const region = (await request(first.base, 'POST', '/api/materials/regions', admin, { name: '合成升级区域' }, 201)).value;
    const catalog = (await request(first.base, 'POST', '/api/materials/catalog', admin, { code: 'UPGRADE-032-033', name: '合成升级物资', spec: '250 mL', unit: '瓶', categoryId: category.id }, 201)).value;
    let order = (await request(first.base, 'POST', '/api/materials/requests', ordinary, { title: `合成历史入库 ${runId}` }, 201)).value;
    order = (await request(first.base, 'POST', `/api/materials/requests/${order.id}/items`, ordinary, { requestVersion: order.version, catalogId: catalog.id,
      categoryId: category.id, regionId: region.id, warehouse: 'MAIN', quantity: '3', purpose: '仅隔离升级检查' }, 201)).value;
    order = (await request(first.base, 'POST', `/api/materials/requests/${order.id}/submit`, material, { requestVersion: order.version })).value;
    const receiptBody = { requestId: order.id, itemId: order.items[0].id, requestVersion: order.version, version: order.items[0].version,
      requestIdempotencyKey: crypto.randomUUID(), quantity: '3', amount: '1.00', batch: 'UPGRADE-LOT', expiryDate: '2030-06-07' };
    order = (await request(first.base, 'POST', '/api/materials/receipts', material, receiptBody, 201)).value.request;
    const identity = { catalogId: catalog.id, regionId: region.id, warehouse: 'MAIN', batch: receiptBody.batch, expiryDate: receiptBody.expiryDate };
    await request(first.base, 'PUT', '/api/materials/stock/location', admin, { ...identity, version: 0, location: '原版本柜 / 第1层', reason: '历史位置' });
    const historicalIssue = (await request(first.base, 'POST', '/api/materials/issues', ordinary,
      { ...identity, quantity: '1', purpose: '原版本历史领用', requestIdempotencyKey: crypto.randomUUID() }, 201)).value.issue;
    const historicalIssueBody = { version: 1, requestIdempotencyKey: crypto.randomUUID() };
    const oldIssue = (await request(first.base, 'POST', `/api/materials/issues/${historicalIssue.id}/issue`, material, historicalIssueBody, 201)).value.issue;
    assert.equal(oldIssue.amountCents, 33);
    const oldOrder = structuredClone(order), oldStock = (await request(first.base, 'GET', '/api/materials/stock', material)).value;
    const oldBatches = (await request(first.base, 'GET', '/api/materials/stock/batches', material)).value;
    const oldReceipts = (await request(first.base, 'GET', '/api/materials/receipts', material)).value;
    const oldMovements = (await request(first.base, 'GET', '/api/materials/stock/movements', material)).value;
    const oldBackup = (await request(first.base, 'GET', '/api/materials/backup', admin)).value;
    assert.equal(oldBackup.schemaVersion, 2); assert.equal(oldStock.items[0].qtyM, 2000); assert.equal(oldStock.items[0].amountCents, 67);
    check('032-historical-users-request-receipt-stock-created', { userIds: [admin.id, material.id, ordinary.id, restricted.id], requestId: order.id,
      receiptId: oldReceipts.items[0].id, qtyM: 2000, amountCents: 67, schemaVersion: oldBackup.schemaVersion });
    check('032-historical-location-and-issued-record-created', { issueId: oldIssue.id, issuedAmountCents: 33, locationVersion: 1 });
    await verifyProject(); await compose(['stop', '--timeout', '15'], 90000);
    const backup = await docker(['run', '--rm', '--pull', 'never', '--platform', 'linux/amd64', '--user', '0:0', '--label', `labos.upgrade-test=${project}`,
      '--mount', `type=volume,source=${volumeName},target=/var/lib/labos,readonly`, '--entrypoint', 'tar', oldImage, '-czf', '-', '-C', '/var/lib/labos', '.'], 90000, true);
    fs.writeFileSync(path.join(directory, 'synthetic-stopped-runtime-backup.tar.gz'), backup);
    check('stopped-original-volume-backed-up', { bytes: backup.length, sha256: sha(backup) });
    await pullAndCheck(newImage, '0.3.3', newRevision);
    fs.writeFileSync(envFile, baselineEnv.replace(`LABOS_IMAGE=${oldImage}`, `LABOS_IMAGE=${newImage}`));
    assert.equal(fs.readFileSync(envFile, 'utf8').replace(`LABOS_IMAGE=${newImage}`, `LABOS_IMAGE=${oldImage}`), baselineEnv);
    assert.equal(sha(fs.readFileSync(composeFile)), sha(originalArtifact));
    const expectedConfig = structuredClone(oldConfig); expectedConfig.services.labos.image = newImage; expectedConfig.services['labos-init'].image = newImage;
    assert.deepEqual(JSON.parse(await compose(['config', '--format', 'json'])), expectedConfig);
    const second = await start(newImage); assert.deepEqual(mounts(second.application), oldMounts);
    report.upgrade = { onlyEnvImageChanged: true, originalYmlUnchanged: true, projectUnchanged: true,
      volumeUnchanged: true, mountsUnchanged: true, uidGidUnchanged: true, volumeName, uid: 12347, gid: 23458 };
    check('upgrade-only-image-changed-original-yml-project-volume-user-preserved', { volumeName, ymlSha256: sha(originalArtifact), uid: 12347, gid: 23458 });
    assert.equal((await request(second.base, 'GET', '/api/auth/me')).value.setupRequired, false);
    await request(second.base, 'POST', '/api/auth/setup', null, { ...credentials.admin, passwordConfirm: credentials.admin.password }, 409);
    const newAdmin = await login(second.base, 'admin'), newMaterial = await login(second.base, 'material'), newOrdinary = await login(second.base, 'ordinary');
    assert.equal(newAdmin.id, admin.id); assert.equal(newMaterial.id, material.id); assert.equal(newOrdinary.id, ordinary.id);
    assert.deepEqual((await request(second.base, 'GET', `/api/materials/requests/${order.id}`, newMaterial)).value, oldOrder);
    assert.deepEqual((await request(second.base, 'GET', '/api/materials/stock', newMaterial)).value, oldStock);
    assert.deepEqual((await request(second.base, 'GET', '/api/materials/receipts', newMaterial)).value, oldReceipts);
    assert.deepEqual((await request(second.base, 'GET', '/api/materials/stock/movements', newMaterial)).value, oldMovements);
    assert.deepEqual((await request(second.base, 'GET', '/api/materials/stock/batches', newMaterial)).value.items.map(({ qrPayload, ...row }) => row), oldBatches.items);
    assert.deepEqual((await request(second.base, 'GET', `/api/materials/issues/${oldIssue.id}`, newMaterial)).value.issue, oldIssue);
    check('historical-location-issue-and-ledger-preserved', { issueId: oldIssue.id, oldMovementCount: oldMovements.total });
    const newRoles = (await request(second.base, 'GET', '/api/permissions', newAdmin)).value;
    const roleRows = value => Array.isArray(value) ? value : value.roles;
    const oldRole = roleRows(oldRoles).find(row => row.role === 'MATERIAL'), newRole = roleRows(newRoles).find(row => row.role === 'MATERIAL');
    assert.deepEqual(new Set(newRole.permissions), new Set(oldRole.permissions));
    assert.deepEqual(roleRows(newRoles).find(row => row.role === 'UPGRADE_LIMITED'), roleRows(oldRoles).find(row => row.role === 'UPGRADE_LIMITED'));
    const newRestricted = await login(second.base, 'restricted');
    assert.equal(newRestricted.role, 'UPGRADE_LIMITED');
    const restrictedCaps = (await request(second.base, 'GET', '/api/materials/meta', newRestricted)).value.capabilities;
    assert.equal(restrictedCaps.manageLocation, false); assert.equal(restrictedCaps.issueStock, false);
    assert.equal((await request(second.base, 'GET', '/api/materials/meta', newAdmin)).value.capabilities.issueStock, false);
    const caps = (await request(second.base, 'GET', '/api/materials/meta', newMaterial)).value.capabilities;
    assert.equal(caps.manageLocation, true); assert.equal(caps.issueStock, true);
    check('historical-ledger-accounts-roles-and-closed-setup-preserved', { customizedRolePreserved: true });
    await request(second.base, 'PUT', '/api/materials/stock/location', newAdmin, { ...identity, version: 1, location: '升级柜 / 第2层', reason: '合成升级位置' });
    const barcode = (await request(second.base, 'POST', `/api/materials/catalog/${catalog.id}/barcodes`, newAdmin,
      { code: '000032033', reason: '升级后包装码绑定' }, 201)).value.barcode;
    const mapped = (await request(second.base, 'POST', '/api/materials/scan/resolve', newOrdinary, { code: barcode.code })).value;
    assert.equal(mapped.kind, 'catalog'); assert.equal(mapped.catalog.id, catalog.id);
    const batchBefore = (await request(second.base, 'GET', '/api/materials/stock/batches', newMaterial)).value.items[0];
    const located = (await request(second.base, 'POST', '/api/materials/scan/resolve', newOrdinary, { code: batchBefore.qrPayload })).value;
    assert.equal(located.kind, 'stock'); assert.equal(located.batch.qtyM, 2000); assert.equal(located.batch.locationVersion, 2); noMoney(located);
    check('new-barcode-binding-and-exact-qr-resolution', { barcodeId: barcode.id, catalogId: catalog.id, locationVersion: 2 });
    const issuePayload = { ...identity, quantity: '1', purpose: '升级后普通人员申请', requestIdempotencyKey: crypto.randomUUID() };
    const issue = (await request(second.base, 'POST', '/api/materials/issues', newOrdinary, issuePayload, 201)).value.issue;
    assert.equal(issue.createdBy, ordinary.id); assert.equal(issue.snapshot.location, '升级柜 / 第2层'); noMoney(issue);
    await request(second.base, 'POST', `/api/materials/issues/${issue.id}/issue`, newAdmin, { version: 1, requestIdempotencyKey: crypto.randomUUID() }, 403);
    const issueBody = { version: 1, requestIdempotencyKey: crypto.randomUUID() };
    const issued = (await request(second.base, 'POST', `/api/materials/issues/${issue.id}/issue`, newMaterial, issueBody, 201)).value.issue;
    assert.equal(issued.status, 'issued'); assert.equal(issued.amountCents, 34); assert.equal(issued.processedBy, material.id);
    assert.equal((await request(second.base, 'POST', `/api/materials/issues/${issue.id}/issue`, newMaterial, issueBody)).value.issue.id, issue.id);
    const stock = (await request(second.base, 'GET', '/api/materials/stock/batches', newMaterial)).value.items[0];
    assert.equal(stock.qtyM, 1000); assert.equal(stock.amountCents, 33); assert.equal(stock.location, '升级柜 / 第2层'); assert.equal(stock.locationVersion, 2);
    const movements = (await request(second.base, 'GET', '/api/materials/stock/movements', newMaterial)).value;
    assert.equal(movements.total, 3); assert.equal(movements.items[0].issueId, issue.id); assert.equal(movements.items[0].amountCents, -34);
    const xlsx = await request(second.base, 'GET', '/api/materials/export.xlsx?type=issues', newMaterial);
    assert.equal(xlsx.bytes.readUInt32LE(0), 0x04034b50);
    const backup2 = (await request(second.base, 'GET', '/api/materials/backup', newAdmin)).value;
    assert.equal(backup2.schemaVersion, 3); assert.equal(backup2.data.material_issues.length, 2); assert.equal(backup2.data.material_stock_locations.length, 1);
    assert.equal(backup2.data.material_barcodes.length, 1);
    check('upgraded-location-ordinary-application-material-issue-cost-and-xlsx', { issueId: issue.id, issuedAmountCents: 34, remainingQtyM: 1000, remainingAmountCents: 33, movementCount: 3 });
    await compose(['restart', 'labos'], 90000);
    const third = await start(newImage), thirdAdmin = await login(third.base, 'admin'), thirdMaterial = await login(third.base, 'material'), thirdOrdinary = await login(third.base, 'ordinary');
    assert.deepEqual(mounts(third.application), oldMounts);
    assert.equal((await request(third.base, 'GET', '/api/auth/me')).value.setupRequired, false);
    assert.deepEqual((await request(third.base, 'GET', '/api/materials/stock/batches', thirdMaterial)).value.items[0], stock);
    assert.deepEqual((await request(third.base, 'GET', `/api/materials/issues/${issue.id}`, thirdMaterial)).value.issue, issued);
    noMoney((await request(third.base, 'GET', `/api/materials/issues/${issue.id}`, thirdOrdinary)).value);
    assert.equal((await request(third.base, 'GET', '/api/materials/backup', thirdAdmin)).value.data.material_stock_movements.length, 3);
    assert.equal((await request(third.base, 'POST', '/api/materials/scan/resolve', thirdOrdinary, { code: barcode.code })).value.barcode.id, barcode.id);
    assert.equal((await request(third.base, 'POST', '/api/materials/scan/resolve', thirdMaterial, { code: stock.qrPayload })).value.batch.amountCents, 33);
    assert.deepEqual((await request(third.base, 'GET', `/api/materials/issues/${oldIssue.id}`, thirdMaterial)).value.issue, oldIssue);
    await request(third.base, 'POST', `/api/materials/issues/${oldIssue.id}/issue`, thirdMaterial, historicalIssueBody);
    await request(third.base, 'POST', '/api/materials/receipts', thirdMaterial, receiptBody);
    assert.equal((await request(third.base, 'GET', '/api/materials/stock/movements', thirdMaterial)).value.total, 3);
    check('restart-persists-old-ledger-location-issues-new-barcode-qr-and-idempotency', { volumeName });
    assert.equal(await containers(restoreProject), ''); assert.equal(await volumes(restoreProject), '');
    restoreStarted = true;
    await restoreCompose(['up', '--detach', '--pull', 'never', '--wait', '--wait-timeout', '120'], 180000);
    await verifyProject(restoreProject);
    const restoreContainer = await restoreCompose(['ps', '--quiet', 'labos']);
    const restoreBinding = await docker(['port', restoreContainer, '3000/tcp']); assert.match(restoreBinding, /^127\.0\.0\.1:\d+$/);
    const restoreBase = `http://${restoreBinding}`;
    await request(restoreBase, 'POST', '/api/auth/setup', null, { ...credentials.admin, passwordConfirm: credentials.admin.password }, 201);
    const restoreAdmin = await login(restoreBase, 'admin');
    await request(restoreBase, 'POST', '/api/permissions/roles', restoreAdmin, { role: 'UPGRADE_LIMITED' }, 201);
    await request(restoreBase, 'PUT', '/api/permissions/roles/UPGRADE_LIMITED', restoreAdmin, { permissions: ['materials.read'] });
    for (const [kind, roles] of [['ordinary', ['TESTER']], ['restricted', ['UPGRADE_LIMITED']], ['material', ['MATERIAL']]]) {
      await request(restoreBase, 'POST', '/api/users', restoreAdmin, { ...credentials[kind], roles }, 201);
    }
    await request(restoreBase, 'POST', '/api/materials/restore', restoreAdmin, oldBackup);
    const restoreMaterial = await login(restoreBase, 'material'), restoredIssue = (await request(restoreBase, 'GET', `/api/materials/issues/${oldIssue.id}`, restoreMaterial)).value.issue;
    assert.equal(restoredIssue.status, 'issued'); assert.equal(restoredIssue.processedBy, restoreMaterial.id); assert.equal(restoredIssue.amountCents, 33);
    const restoredBatch = (await request(restoreBase, 'POST', '/api/materials/scan/resolve', restoreMaterial, { code: stock.qrPayload })).value.batch;
    assert.equal(restoredBatch.qtyM, 2000); assert.equal(restoredBatch.amountCents, 67); assert.equal(restoredBatch.location, '原版本柜 / 第1层');
    assert.equal((await request(restoreBase, 'GET', `/api/materials/catalog/${catalog.id}/barcodes`, restoreMaterial)).value.total, 0);
    const normalizedBackup = (await request(restoreBase, 'GET', '/api/materials/backup', restoreAdmin)).value;
    assert.equal(normalizedBackup.schemaVersion, 3); assert.deepEqual(normalizedBackup.data.material_barcodes, []);
    check('schema2-backup-imports-on-033-with-mapped-history-and-empty-barcodes', { restoreProject, schemaVersion: 3, restoredQtyM: 2000, restoredAmountCents: 67 });
    await verifyProject(); report.status = 'passed';
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
    fs.writeFileSync(path.join(validation, 'upgrade-032-to-033-latest.json'), JSON.stringify({ report: reportFile, status: report.status, cleanup: report.cleanup }, null, 2) + '\n');
    if (report.status === 'passed' && report.cleanup.passed) fs.writeFileSync(path.join(root, 'artifacts/cache/0.3.3/upgrade-verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ report: reportFile, status: report.status, cleanup: report.cleanup }));
  }
})();
