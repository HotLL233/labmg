'use strict';

const crypto = require('node:crypto');

const COLUMNS = Object.freeze([
  ['Code', 'code'], ['QRPayload', 'qrPayload'], ['Name', 'name'], ['CatalogCode', 'catalogCode'],
  ['Specification', 'spec'], ['Unit', 'unit'], ['Region', 'regionName'], ['Warehouse', 'warehouse'],
  ['Location', 'location'], ['Batch', 'batch'], ['ExpiryDate', 'expiryDate'], ['Status', 'status']
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const TEMPLATE_META = 'id,name,file_name,sha256,size,fields,active,created_at';
const STATION_META = 'id,name,printer_name,enabled,last_seen_at,agent_version';
const JOB_META = 'id,status,kind,paper,(preview_base64 IS NOT NULL) AS has_preview,station_id,station_name,printer_name,template_id,template_name,template_sha256,unit_ids,row_count,created_by,created_at,updated_at,message,reason,reprint_of,confirmed_by,confirmed_at,confirmation_reason';
const modernAgent = version => {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return [major, minor, patch].every(Number.isSafeInteger) && (major > 0 || minor > 8 || minor === 8 && patch >= 1);
};

function createPrinting({ db, body, send, fail, log, hasPermission, tokenUser, labelRows }) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const now = () => new Date().toISOString();
  const error = (status, message) => { throw fail(status, message); };
  const manager = user => ['ADMIN', 'MATERIAL'].some(role => String(user?.role || '').split(',').includes(role)) && hasPermission(user, 'materials.catalog.write');
  const stationManager = user => hasPermission(user, 'permissions.write');
  const jobManager = user => manager(user) || stationManager(user);
  const audit = (user, action, entity, id, detail = '') => log(user, action, entity, 0, JSON.stringify({ id, detail }));
  function text(value, label, maximum = 200, optional = false) {
    if (typeof value !== 'string') error(400, `${label}必须是文本`);
    const result = value.trim();
    if ((!optional && !result) || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) error(400, `${label}不能为空、含控制字符或超过${maximum}字符`);
    return result;
  }
  function identifier(value, label = 'ID') {
    if (typeof value !== 'string' || !UUID.test(value)) error(400, `${label}无效`);
    return value;
  }
  function keys(input, allowed) {
    if (Object.keys(input).some(key => !allowed.includes(key))) error(400, '包含不支持的字段，请勿提交打印路径、份数、XML或标签内容');
  }
  function paper(value) {
    if (value == null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) error(400, '纸张设置无效');
    keys(value, ['widthMm', 'heightMm', 'orientation']);
    const { widthMm, heightMm, orientation } = value;
    if (![widthMm, heightMm].every(number => typeof number === 'number' && Number.isFinite(number) && number >= 5 && number <= 300 && Math.abs(number * 1000 - Math.round(number * 1000)) < 0.000001)) error(400, '纸张宽高须为5至300毫米，最多3位小数');
    if (!['portrait', 'landscape'].includes(orientation) || orientation === 'portrait' && widthMm > heightMm || orientation === 'landscape' && widthMm < heightMm) error(400, '纸张方向须与宽高一致：纵向宽不大于高，横向宽不小于高');
    return { widthMm, heightMm, orientation };
  }
  function preview(value) {
    if (typeof value !== 'string' || value.length > 2796204 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) error(400, '原生预览须为不超过2MiB的规范PNG Base64');
    const image = Buffer.from(value, 'base64');
    if (image.length < 45 || image.length > 2097152 || image.toString('base64') !== value || !image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || image.readUInt32BE(8) !== 13 || image.toString('ascii',12,16) !== 'IHDR' || ![image.readUInt32BE(16), image.readUInt32BE(20)].every(number => number > 0 && number <= 4096) || image.toString('ascii',image.length - 8,image.length - 4) !== 'IEND' || image.readUInt32BE(image.length - 12) !== 0) error(400, '原生预览必须是尺寸不超过4096×4096的PNG，最大2MiB');
    return value;
  }
  const templateView = row => ({ id: row.id, name: row.name, fileName: row.file_name, sha256: row.sha256, size: row.size,
    fields: JSON.parse(row.fields), active: Boolean(row.active), createdAt: row.created_at });
  const stationView = row => {
    const lastSeen = Date.parse(row.last_seen_at), age = Date.now() - lastSeen;
    return { id: row.id, name: row.name, printerName: row.printer_name, enabled: Boolean(row.enabled), lastSeenAt: row.last_seen_at,
      agentVersion: row.agent_version, connectionStatus: !row.enabled ? 'disabled' : !row.last_seen_at ? 'never_connected' : Number.isFinite(lastSeen) && age >= -5000 && age <= 60000 ? 'online' : 'offline' };
  };
  const visibleMessage = (row, user) => {
    if (!row.message || jobManager(user)) return row.message;
    if (row.status === 'unknown') return row.kind === 'preview' ? '原生预览结果未确认，请联系管理员检查打印助手。此任务不会出纸。' : '打印结果未确认，请先核对实际出纸数量，再联系管理员处理。';
    if (row.status === 'failed') return row.message.startsWith('PREFLIGHT_REJECTED_CONFIGURED_PRINTER_NOT_FOUND') ? '打印站没有找到配置的打印机，请联系管理员核对打印机名称。' : 'Windows 打印端报告失败，请联系管理员检查模板、打印机和打印端配置。';
    if (row.status === 'submitted') return row.kind === 'preview' ? '原生模板图已生成，此任务不会出纸。' : '打印引擎已提交任务，仍需核对实际出纸。';
    return '';
  };
  const jobView = (row, user) => ({ id: row.id, status: row.status, kind: row.kind, paper: row.paper ? JSON.parse(row.paper) : null, hasPreview: Boolean(row.has_preview || row.preview_base64), stationId: row.station_id, stationName: row.station_name, printerName: row.printer_name,
    templateId: row.template_id, templateName: row.template_name, templateSha256: row.template_sha256, unitIds: JSON.parse(row.unit_ids),
    count: row.row_count, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, message: visibleMessage(row, user),
    reason: row.reason, reprintOf: row.reprint_of, confirmedBy: row.confirmed_by, confirmedAt: row.confirmed_at, confirmationReason: row.confirmation_reason });
  async function job(id, user) {
    const row = await one('SELECT * FROM printing_jobs WHERE id=?', identifier(id, '任务ID'));
    if (!row) error(404, '打印任务不存在');
    if (!jobManager(user) && row.created_by !== user.id) error(403, '只能查看和操作自己的打印任务');
    return row;
  }
  async function station(id) {
    const row = await one('SELECT * FROM printing_stations WHERE id=?', identifier(id, '打印站ID'));
    if (!row) error(404, '打印站不存在');
    return row;
  }
  async function expire(stationId) {
    await run(`UPDATE printing_jobs SET status='unknown',message=?,updated_at=?,lease_hash=NULL,lease_expires_at=NULL
      WHERE status IN ('claimed','printing') AND lease_expires_at<=?${stationId ? ' AND station_id=?' : ''}`,
    '打印端租约过期，需人工核对；系统不会自动重试', now(), Date.now(), ...(stationId ? [stationId] : []));
  }
  async function invalidateStation(id, message) {
    await run("UPDATE printing_jobs SET status='unknown',message=?,updated_at=?,lease_hash=NULL,lease_expires_at=NULL WHERE station_id=? AND status IN ('claimed','printing')", message, now(), id);
  }
  async function agentDispatch(req, res, route, input) {
    const reply = (value, status = 200) => send(res, status, value);
    if (req.method !== 'POST') error(405, '打印端接口只接受POST');
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) error(401, '打印站令牌无效');
    const current = await one('SELECT * FROM printing_stations WHERE token_hash=?', hash(header.slice(7)));
    if (!current || !current.enabled) error(401, '打印站令牌无效或打印站已停用');
    await run('UPDATE printing_stations SET last_seen_at=? WHERE id=?', now(), current.id);
    await expire(current.id);
    if (route === '/agent/claim') {
      keys(input, ['agentVersion']);
      const version = text(input.agentVersion ?? '', '打印端版本', 100, true);
      await run('UPDATE printing_stations SET agent_version=? WHERE id=?', version, current.id);
      if (await one("SELECT 1 FROM printing_jobs WHERE station_id=? AND status IN ('claimed','printing')", current.id)) return reply({ job: null });
      const next = await one("SELECT * FROM printing_jobs WHERE station_id=? AND status='queued' ORDER BY created_at,id LIMIT 1", current.id);
      if (!next) return reply({ job: null });
      if ((next.kind === 'preview' || next.paper) && !modernAgent(version)) return reply({ job: null, blockedReason: 'AGENT_UPGRADE_REQUIRED', minimumAgentVersion: '0.8.1' });
      const leaseToken = crypto.randomBytes(32).toString('base64url'), leaseExpiresAt = Date.now() + 120000;
      await run("UPDATE printing_jobs SET status='claimed',lease_hash=?,lease_expires_at=?,updated_at=? WHERE id=? AND status='queued'", hash(leaseToken), leaseExpiresAt, now(), next.id);
      return reply({ job: { id: next.id, kind: next.kind, paper: next.paper ? JSON.parse(next.paper) : null, template: { id: next.template_id, fileName: next.template_file_name, sha256: next.template_sha256,
        contentBase64: next.template_content_base64, fields: JSON.parse(next.template_fields) }, printerName: next.printer_name,
      rows: JSON.parse(next.rows_snapshot), leaseToken, leaseExpiresAt: new Date(leaseExpiresAt).toISOString() } });
    }
    const match = route.match(/^\/agent\/jobs\/([^/]+)\/(start|result)$/);
    if (!match) error(404, '打印端接口不存在');
    keys(input, match[2] === 'start' ? ['leaseToken'] : ['leaseToken', 'status', 'message', 'previewBase64']);
    const id = identifier(match[1], '任务ID');
    const currentJob = await one('SELECT * FROM printing_jobs WHERE id=? AND station_id=?', id, current.id);
    if (!currentJob) error(404, '打印任务不存在');
    if (typeof input.leaseToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.leaseToken) || currentJob.lease_hash !== hash(input.leaseToken)) {
      return reply({ error: '租约已过期、撤销或不属于当前任务，禁止再次打印' }, 409);
    }
    if (match[2] === 'start') {
      if (currentJob.status !== 'claimed') return reply({ error: '任务不在待启动状态，禁止再次调用打印引擎' }, 409);
      await run("UPDATE printing_jobs SET status='printing',lease_expires_at=?,updated_at=? WHERE id=?", Date.now() + 1800000, now(), id);
      return reply({ ok: true, status: 'printing' });
    }
    if (!['submitted', 'failed', 'unknown'].includes(input.status)) error(400, '引擎结果状态无效');
    const message = text(input.message ?? '', '打印结果', 2000, true);
    const image = currentJob.kind === 'preview' && input.status === 'submitted' ? preview(input.previewBase64) : null;
    if (image === null && input.previewBase64 !== undefined) error(400, '只有预览任务成功时可以提交PNG');
    if (currentJob.status === input.status && currentJob.result_status === input.status && currentJob.result_message === message && currentJob.preview_base64 === image) return reply({ ok: true, status: currentJob.status });
    if (currentJob.status !== 'printing' && !(currentJob.status === 'claimed' && ['failed', 'unknown'].includes(input.status))) return reply({ error: '任务未启动、已处理或租约已失效，不能覆盖结果' }, 409);
    await run('UPDATE printing_jobs SET status=?,message=?,result_status=?,result_message=?,preview_base64=?,lease_expires_at=NULL,updated_at=? WHERE id=?', input.status, message, input.status, message, image, now(), id);
    await audit(null, 'RESULT', 'printing_jobs', id, input.status);
    return reply({ ok: true, status: input.status });
  }
  async function dispatch(req, res, url) {
    const route = url.pathname.slice('/api/printing'.length), method = req.method;
    const input = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await body(req) : {};
    if (route === '/agent' || route.startsWith('/agent/')) return agentDispatch(req, res, route, input);
    const user = await tokenUser(req);
    if (!user) error(401, '请先登录');
    if (!hasPermission(user, 'materials.read')) error(403, '没有物资读取权限');
    const reply = (value, status = 200) => send(res, status, value);
    await expire();
    if (route === '/config' && method === 'GET') {
      const busy = new Set((await all("SELECT station_id FROM printing_jobs WHERE status IN ('claimed','printing')")).map(row => row.station_id));
      return reply({
        templates: (await all(`SELECT ${TEMPLATE_META} FROM printing_templates ORDER BY created_at,id`)).map(templateView),
        stations: (await all(`SELECT ${STATION_META} FROM printing_stations ORDER BY created_at,id`)).map(row => ({ ...stationView(row), busy: busy.has(row.id) })),
        stationContactTimeoutSeconds: 60, serverTime: now(), capabilities: { manageTemplates: manager(user), manageStations: stationManager(user), submit: true }
      });
    }
    if (route === '/templates' && method === 'POST') {
      if (!manager(user)) error(403, '需要物资模板管理权限');
      keys(input, ['name', 'fileName', 'contentBase64', 'fields']);
      const name = text(input.name, '模板名称'), fileName = text(input.fileName, '模板文件名', 120);
      if (!/^[^\\/:*?"<>|]+\.btw$/i.test(fileName) || fileName.startsWith('.')) error(400, '请上传文件名合法的.btw原生模板');
      const encoded = input.contentBase64;
      if (typeof encoded !== 'string' || !encoded.length || encoded.length > 5592408 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) error(400, '模板必须为规范Base64，且原文件不超过4MiB');
      const content = Buffer.from(encoded, 'base64');
      if (!content.length || content.length > 4194304 || content.toString('base64') !== encoded) error(400, '模板为空、超过4MiB或Base64无效');
      const fields = input.fields;
      if (!Array.isArray(fields) || !fields.length || fields.length > COLUMNS.length || fields.some(field => !COLUMNS.some(([column]) => column === field)) ||
        new Set(fields).size !== fields.length || !fields.some(field => ['Code', 'QRPayload'].includes(field))) error(400, '命名数据源须为12个允许字段的无重复子集，并包含Code或QRPayload');
      const id = crypto.randomUUID();
      await run('INSERT INTO printing_templates(id,name,file_name,sha256,size,content_base64,fields,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, name, fileName, hash(content), content.length, encoded, JSON.stringify(fields), user.id, now());
      await audit(user, 'CREATE', 'printing_templates', id, name);
      return reply(templateView(await one('SELECT * FROM printing_templates WHERE id=?', id)), 201);
    }
    let match = route.match(/^\/templates\/([^/]+)(\/disable)?$/);
    if (match) {
      if (!manager(user)) error(403, '需要物资模板管理权限');
      const row = await one('SELECT * FROM printing_templates WHERE id=?', identifier(match[1], '模板ID'));
      if (!row) error(404, '打印模板不存在');
      if (method === 'GET' && !match[2]) return reply({ ...templateView(row), contentBase64: row.content_base64 });
      if (method === 'POST' && match[2]) {
        keys(input, []);
        await run('UPDATE printing_templates SET active=0 WHERE id=?', row.id);
        await audit(user, 'DISABLE', 'printing_templates', row.id);
        return reply(templateView({ ...row, active: 0 }));
      }
    }
    if (route === '/stations' && method === 'POST') {
      if (!stationManager(user)) error(403, '需要打印站管理权限');
      keys(input, ['name', 'printerName']);
      const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
      const name = text(input.name, '打印站名称'), printerName = text(input.printerName, 'Windows打印机名称');
      await run('INSERT INTO printing_stations(id,name,printer_name,token_hash,created_by,created_at) VALUES(?,?,?,?,?,?)', id, name, printerName, hash(token), user.id, now());
      await audit(user, 'CREATE', 'printing_stations', id, name);
      return reply({ station: stationView(await station(id)), token }, 201);
    }
    match = route.match(/^\/stations\/([^/]+)(\/rotate-token)?$/);
    if (match && ['POST', 'PUT'].includes(method)) {
      if (!stationManager(user)) error(403, '需要打印站管理权限');
      const row = await station(match[1]);
      if (method === 'POST' && match[2]) {
        keys(input, []);
        const token = crypto.randomBytes(32).toString('base64url');
        await invalidateStation(row.id, '打印站令牌已更换，执行结果需人工核对');
        await run('UPDATE printing_stations SET token_hash=? WHERE id=?', hash(token), row.id);
        await audit(user, 'ROTATE_TOKEN', 'printing_stations', row.id);
        return reply({ station: stationView(await station(row.id)), token });
      }
      if (method === 'PUT' && !match[2]) {
        keys(input, ['name', 'printerName', 'enabled']);
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') error(400, '启用状态必须是布尔值');
        const name = input.name === undefined ? row.name : text(input.name, '打印站名称');
        const printerName = input.printerName === undefined ? row.printer_name : text(input.printerName, 'Windows打印机名称');
        const enabled = input.enabled === undefined ? row.enabled : Number(input.enabled);
        if (!enabled) await invalidateStation(row.id, '打印站已停用，执行结果需人工核对');
        await run('UPDATE printing_stations SET name=?,printer_name=?,enabled=? WHERE id=?', name, printerName, enabled, row.id);
        await audit(user, 'UPDATE', 'printing_stations', row.id);
        return reply(stationView(await station(row.id)));
      }
    }
    if (route === '/jobs' && method === 'POST') {
      keys(input, ['stationId', 'templateId', 'unitIds', 'idempotencyKey', 'reason', 'reprintOf', 'kind', 'paper']);
      const kind = input.kind === undefined ? 'print' : input.kind, sheet = paper(input.paper);
      if (!['print', 'preview'].includes(kind)) error(400, '任务类型须为print或preview');
      const stationId = identifier(input.stationId, '打印站ID'), templateId = identifier(input.templateId, '模板ID');
      const idempotencyKey = text(input.idempotencyKey, '请求号', 128), reason = text(input.reason ?? '', '打印原因', 1000, true);
      const unitIds = input.unitIds;
      if (!Array.isArray(unitIds) || !unitIds.length || unitIds.length > 1000 || unitIds.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(unitIds).size !== unitIds.length) error(400, '请选择1至1000个不重复的有效单件ID');
      const reprintOf = input.reprintOf == null ? null : identifier(input.reprintOf, '原任务ID');
      if (kind === 'preview' && (unitIds.length !== 1 || reprintOf)) error(400, '原生预览须选择1件，不能作为重印任务');
      if (reprintOf && !reason) error(400, '重印必须填写原因');
      const digest = hash(JSON.stringify({ stationId, templateId, unitIds, reason, reprintOf, ...(kind !== 'print' || sheet ? { kind, paper: sheet } : {}) }));
      const existing = await one(`SELECT ${JOB_META},payload_digest FROM printing_jobs WHERE created_by=? AND idempotency_key=?`, user.id, idempotencyKey);
      if (existing) {
        if (existing.payload_digest !== digest) error(409, '同一请求号不能用于不同打印内容');
        return reply(jobView(existing, user), 201);
      }
      const target = await station(stationId), template = await one('SELECT * FROM printing_templates WHERE id=?', templateId);
      if (!target.enabled) error(409, '打印站已停用');
      if (!template || !template.active) error(409, '打印模板不存在或已停用');
      let rows;
      if (reprintOf) {
        const previous = await job(reprintOf, user);
        if (previous.kind !== 'print') error(400, '原生预览任务不能重印');
        if (previous.paper !== (sheet ? JSON.stringify(sheet) : null)) error(400, '重印必须保持原任务纸张设置');
        if (previous.station_id !== stationId || previous.template_id !== templateId || previous.unit_ids !== JSON.stringify(unitIds)) error(400, '重印必须保持原任务的打印站、模板和单件顺序');
        if (['queued', 'claimed', 'printing'].includes(previous.status)) error(409, '原任务尚未结束，不能重印');
        rows = JSON.parse(previous.rows_snapshot);
      } else {
        const source = await labelRows(user, unitIds);
        if (source.length !== unitIds.length || source.some((row, index) => row.id !== unitIds[index] || !row.code || !row.qrPayload)) error(409, '单件标签数据不完整，请刷新重试');
        rows = source.map(row => Object.fromEntries(COLUMNS.map(([name, field]) => [name, String(field === 'warehouse' ? (row.warehouseName || row.warehouse) : row[field] ?? '')])));
      }
      const id = crypto.randomUUID(), createdAt = now();
      await run(`INSERT INTO printing_jobs(id,station_id,station_name,printer_name,template_id,template_name,template_file_name,template_sha256,
        template_content_base64,template_fields,unit_ids,rows_snapshot,row_count,status,created_by,created_at,updated_at,idempotency_key,payload_digest,reason,reprint_of,kind,paper)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?)`, id, target.id, target.name, target.printer_name, template.id, template.name, template.file_name,
      template.sha256, template.content_base64, template.fields, JSON.stringify(unitIds), JSON.stringify(rows), rows.length, user.id, createdAt, createdAt, idempotencyKey, digest, reason, reprintOf, kind, sheet ? JSON.stringify(sheet) : null);
      await audit(user, reprintOf ? 'REPRINT' : 'CREATE', 'printing_jobs', id, reason);
      return reply(jobView(await job(id, user), user), 201);
    }
    if (route === '/jobs' && method === 'GET') {
      const parameter = (name, fallback, maximum) => {
        const value = url.searchParams.get(name);
        if (value === null) return fallback;
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) error(400, `${name}无效`);
        return Number(value);
      };
      const page = parameter('page', 1, 1000000), pageSize = parameter('pageSize', 20, 100), where = jobManager(user) ? '' : ' WHERE created_by=?';
      const args = jobManager(user) ? [] : [user.id];
      const total = (await one('SELECT COUNT(*) AS total FROM printing_jobs' + where, ...args)).total;
      return reply({ items: (await all(`SELECT ${JOB_META} FROM printing_jobs` + where + ' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?', ...args, pageSize, (page - 1) * pageSize)).map(row => jobView(row, user)), total, page, pageSize });
    }
    match = route.match(/^\/jobs\/([^/]+)(\/(cancel|confirm))?$/);
    if (match) {
      const row = await job(match[1], user);
      if (method === 'GET' && !match[2]) return reply({ ...jobView(row, user), rows: JSON.parse(row.rows_snapshot), ...(row.preview_base64 ? { previewBase64: row.preview_base64 } : {}) });
      if (method === 'POST' && match[3] === 'cancel') {
        keys(input, []);
        if (!['queued', 'claimed'].includes(row.status)) return reply({ error: '任务已经启动或结束，不能取消；请人工核对打印状态' }, 409);
        await run("UPDATE printing_jobs SET status='cancelled',lease_hash=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?", now(), row.id);
        await audit(user, 'CANCEL', 'printing_jobs', row.id);
        return reply(jobView(await job(row.id, user), user));
      }
      if (method === 'POST' && match[3] === 'confirm') {
        keys(input, ['reason']);
        if (!jobManager(user)) error(403, '需要打印管理权限进行人工确认');
        if (row.kind === 'preview') error(400, '原生预览不出纸，不能人工确认出纸');
        const reason = text(input.reason, '人工核对说明', 1000);
        if (!['submitted', 'unknown'].includes(row.status)) return reply({ error: '只有引擎已提交或结果不明的任务可以人工确认' }, 409);
        const timestamp = now();
        await run("UPDATE printing_jobs SET status='confirmed',confirmed_by=?,confirmed_at=?,confirmation_reason=?,updated_at=?,lease_hash=NULL,lease_expires_at=NULL WHERE id=?", user.id, timestamp, reason, timestamp, row.id);
        await audit(user, 'CONFIRM', 'printing_jobs', row.id, reason);
        return reply(jobView(await job(row.id, user), user));
      }
    }
    error(404, '打印接口不存在');
  }
  async function handle(req, res, url) {
    if (url.pathname !== '/api/printing' && !url.pathname.startsWith('/api/printing/')) return false;
    try { await db.transaction(() => dispatch(req, res, url)); }
    catch (failure) {
      if (failure.status) throw failure;
      if (failure.code === '23505') error(409, '打印请求或状态冲突，请使用原请求号核对');
      if (['23503', '23514', '23502'].includes(failure.code)) error(400, '打印数据违反完整性约束，操作未保存');
      throw failure;
    }
    return true;
  }
  return { handle };
}

module.exports = { createPrinting, COLUMNS };
