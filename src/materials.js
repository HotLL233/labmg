'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const createMaterialLab = require('./material-lab');
const { readOpeningWorkbook, OPENING_HEADERS, readCatalogWorkbook, CATALOG_HEADERS, excelColumn, importFailure, referenceFeature, workbookSheet: sheet } = require('./material-xlsx');
const TEMPLATE_VERSION = require('../package.json').version;

const WAREHOUSES = [
  { code: 'MAIN', name: '默认仓库' },
  { code: 'REAGENT', name: '试剂库' },
  { code: 'CONSUMABLE', name: '耗材库' },
  { code: 'SPARE', name: '备用库' }
];
const FILE_LIMIT = 5 * 1024 * 1024;
const BACKUP_LIMIT = 20 * 1024 * 1024;
const STOCK_QR_PREFIX = 'LABOS-STOCK:1:';
const TABLES = [
  'material_categories', 'material_regions', 'material_storage_places', 'material_catalog', 'material_barcodes', 'material_requests',
  'material_request_items', 'material_request_revisions', 'material_arrivals', 'material_arrival_document_versions', 'material_receipts',
  'material_stock_locations', 'material_issues', 'material_openings', 'material_stock_movements',
  'material_opening_items', 'material_stock_units',
  'material_attachments', 'material_state', 'material_idempotency', 'material_number_allocations'
];
const V7_TABLES = TABLES.filter(table => !['material_arrivals', 'material_arrival_document_versions'].includes(table));
const V6_TABLES = V7_TABLES.filter(table => !['material_number_allocations', 'material_storage_places'].includes(table));
const V4_TABLES = V6_TABLES.filter(table => !['material_openings', 'material_opening_items'].includes(table));
const V3_TABLES = V4_TABLES.filter(table => table !== 'material_stock_units');
const V2_TABLES = V3_TABLES.filter(table => table !== 'material_barcodes');
const V1_TABLES = V2_TABLES.filter(table => !['material_stock_locations', 'material_issues'].includes(table));

function createMaterials({ db, body, send, fail, log, hasPermission, tokenUser, uploads, writeXlsx }) {
  const lab = createMaterialLab({ db, fail, hasPermission, log, validTimestamp });
  const defaultUnitRule = { template: 'LAB-{YYYY}{MM}{DD}-{SEQ}', padding: 6, version: 1, actorId: null, updatedAt: '', reason: '' };
  const numberKinds = { catalog: { label: '物资编码', prefix: 'MAT' }, request: { label: '申报单号', prefix: 'WZ' },
    opening: { label: '期初单号', prefix: 'QC' }, supplement: { label: '补录单号', prefix: 'BL' } };
  const defaultNumberRule = kind => ({ ...defaultUnitRule, template: `${numberKinds[kind].prefix}-{YYYY}{MM}{DD}-{SEQ}` });
  async function mapRows(rows, callback) {
    const result = [];
    for (let index = 0; index < rows.length; index++) result.push(await callback(rows[index], index));
    return result;
  }
  const one = async (sql, ...args) => (await db.prepare(sql).get(...args));
  const all = async (sql, ...args) => (await db.prepare(sql).all(...args));
  const run = async (sql, ...args) => (await db.prepare(sql).run(...args));
  const ITEM_SELECT = `SELECT i.*, c.name AS category_name, r.name AS region_name, u.display_name AS author_name,
    (SELECT COUNT(*) FROM material_receipts e WHERE e.item_id=i.id) AS receipt_count,
    (SELECT COALESCE(SUM(qty_m),0) FROM material_receipts e WHERE e.item_id=i.id) AS accepted_qty_m,
    (SELECT COALESCE(SUM(closed_qty_m),0) FROM material_receipts e WHERE e.item_id=i.id) AS closed_qty_m
    FROM material_request_items i JOIN material_categories c ON c.id=i.category_id
    JOIN material_regions r ON r.id=i.region_id JOIN users u ON u.id=i.author_id`;
  const actorName = async id => (await one('SELECT display_name FROM users WHERE id=?', id))?.display_name || '';
  const now = () => new Date().toISOString();
  const today = () => now().slice(0, 10);
  const role = (user, name) => String(user?.role || '').split(',').includes(name);
  const permit = (user, permission) => Boolean(user && hasPermission(user, permission));
  const material = (user, permission) => role(user, 'MATERIAL') && permit(user, permission);
  const manager = (user, permission) => (role(user, 'ADMIN') || role(user, 'MATERIAL')) && permit(user, permission);
  const openingClosed = async () => (await one("SELECT value FROM material_state WHERE key='opening_closed'"))?.value === '1';
  const closeOpening = async () => (await run("UPDATE material_state SET value='1' WHERE key='opening_closed'"));

  function error(status, message, code) {
    const result = fail(status, message);
    if (code) result.code = code;
    throw result;
  }
  const conflict = message => error(409, message, 'VERSION_CONFLICT');
  function requireMaterial(user, permission) {
    if (!material(user, permission)) error(403, '此操作须由具有对应权限的物资管理员办理');
  }
  function requireManager(user, permission) {
    if (!manager(user, permission)) error(403, '此操作须由具有维护权限的系统管理员或物资管理员办理');
  }
  const transaction = async callback => (await db.transaction(callback));
  function integer(value, label = 'ID') {
    const number = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
    if (!Number.isSafeInteger(number) || number <= 0) error(400, `${label}无效`);
    return number;
  }
  function text(value, label, maximum = 200, allowEmpty = false) {
    if (typeof value !== 'string') error(400, `${label}必须是文本`);
    const result = value.trim();
    if ((!allowEmpty && !result) || result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) {
      error(400, `${label}不能为空或超过${maximum}个字符`);
    }
    return result;
  }
  function decimal(value, digits, label, allowZero = false) {
    if (typeof value !== 'string' || !new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`).test(value)) {
      error(400, `${label}须为十进制字符串，最多${digits}位小数`);
    }
    const [whole, fraction = ''] = value.split('.');
    const result = Number(whole + fraction.padEnd(digits, '0'));
    if (!Number.isSafeInteger(result) || result < 0 || (!allowZero && result === 0)) error(400, `${label}超出范围或必须大于零`);
    return result;
  }
  function safeSum(values, label = '累计数值') {
    return values.reduce((sum, value) => {
      const result = sum + value;
      if (!Number.isSafeInteger(result)) error(400, `${label}超出安全整数范围`);
      return result;
    }, 0);
  }
  function date(value, label = '日期', optional = false) {
    if (optional && (value === undefined || value === '')) return '';
    const result = value === undefined ? today() : text(value, label, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) {
      error(400, `${label}无效`);
    }
    return result;
  }
  function warehouse(value) {
    if (!WAREHOUSES.some(entry => entry.code === value)) error(400, '请从有效仓库中选择');
    return value;
  }
  async function dictionary(table, id, label) {
    const result = (await one(`SELECT * FROM ${table} WHERE id=?`, integer(id, label)));
    if (!result) error(400, `${label}不存在`);
    return result;
  }
  async function catalog(id) {
    const result = (await one('SELECT * FROM material_catalog WHERE id=?', integer(id, '物资信息')));
    if (!result) error(400, '物资信息不存在');
    return result;
  }
  async function activeCatalog(id) {
    const row = await catalog(id);
    if (row.merged_into !== null) conflict('该物资信息已合并，请选择有效物资信息');
    if (!row.active) conflict('该物资信息已停用，不能用于新申报或新入库；已有库存仍可查询和处置');
    return row;
  }
  function references(value, kind, id) {
    if (Array.isArray(value)) return value.some(entry => references(entry, kind, id));
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, entry]) =>
      ((key === kind + 'Id' || key === kind + '_id') && entry === id) ||
      (key === kind && entry && typeof entry === 'object' && entry.id === id) || references(entry, kind, id));
  }
  async function catalogReferenceIds() {
    const ids = new Set();
    for (const table of ['material_request_items', 'material_barcodes', 'material_stock_locations', 'material_issues', 'material_stock_movements', 'material_opening_items', 'material_stock_units']) {
      for (const row of await all(`SELECT DISTINCT catalog_id FROM ${table} WHERE catalog_id IS NOT NULL`)) ids.add(row.catalog_id);
    }
    for (const row of await all('SELECT DISTINCT merged_into FROM material_catalog WHERE merged_into IS NOT NULL')) ids.add(row.merged_into);
    function collect(value) {
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if ((key === 'catalogId' || key === 'catalog_id') && Number.isSafeInteger(entry)) ids.add(entry);
        if (key === 'catalog' && entry && Number.isSafeInteger(entry.id)) ids.add(entry.id);
        collect(entry);
      }
    }
    for (const [table, fields] of [['material_requests', ['original_snapshot']], ['material_request_revisions', ['before_snapshot', 'after_snapshot']], ['material_receipts', ['snapshot']], ['material_idempotency', ['response']]]) {
      for (const row of await all(`SELECT ${fields.join(',')} FROM ${table}`)) {
        for (const field of fields) if (row[field]) collect(JSON.parse(row[field]));
      }
    }
    return ids;
  }
  const catalogReferences = async id => (await catalogReferenceIds()).has(id);
  async function catalogView(row, referenced = undefined) {
    referenced ??= await catalogReferences(row.id);
    return { id: row.id, code: row.code, name: row.name, spec: row.spec, unit: row.unit,
      remark: row.remark, origin: row.origin, active: Boolean(row.active), referenced, canDelete: !referenced, ...lab.view(row),
      trackingMode: row.tracking_mode, categoryId: row.category_id, categoryName: row.category_name ?? (await dictionary('material_categories', row.category_id, '分类')).name, version: row.version };
  }
  const normalized = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
  const identityNormalized = value => normalized(value).replace(/\s+/g, ' ');
  const identityText = (value, label, maximum = 200) => text(text(value, label, maximum).normalize('NFKC').replace(/\s+/g, ' '), label, maximum);
  const manufacturerText = value => text(text(value, '厂家', 200, true).normalize('NFKC').replace(/\s+/g, ' '), '厂家', 200, true);
  const sameMaterial = (left, right) => ['name', 'spec', 'unit'].every(field => identityNormalized(left[field]) === identityNormalized(right[field]));
  const materialKey = row => JSON.stringify([row.name, row.spec, row.unit].map(identityNormalized));
  function indexRows(rows, key) {
    const result = new Map();
    for (const row of rows) { const value = key(row); if (!result.has(value)) result.set(value, []); result.get(value).push(row); }
    return result;
  }
  function catalogIndex(rows) {
    const active = rows.filter(row => row.merged_into === null);
    return { codes: indexRows(rows, row => normalized(row.code)), identities: indexRows(active, materialKey),
      names: new Set(active.map(row => identityNormalized(row.name))), specs: new Set(active.map(row => JSON.stringify([row.name, row.spec].map(identityNormalized)))) };
  }
  async function catalogInput(input) {
    const code = text(input.code ?? '', '物资编码', 64, true).normalize('NFKC').toUpperCase();
    if (code.length > 64 || (code && !/^[A-Z0-9][A-Z0-9._/-]*$/.test(code))) error(400, '编码最多64位，须由英文字母、数字及 . _ / - 组成');
    return { code, name: identityText(input.name, '物资名称'), spec: identityText(input.spec, '规格'), unit: identityText(input.unit, '单位', 30),
      remark: text(input.remark ?? '', '物资备注', 2000, true),
      ...lab.fields(input),
      category_id: (await dictionary('material_categories', input.categoryId, '分类')).id,
      tracking_mode: trackingMode(input.trackingMode ?? 'quantity') };
  }
  async function createCatalog(data, user, reuse = false, index = null, origin = 'manual') {
    function checkLaboratoryReuse(existing) {
      for (const [field, label] of [['cas_number', 'CAS号'], ['purity', '纯度／浓度'], ['storage_conditions', '储存条件'], ['sds_url', 'SDS链接']]) {
        if (data[field] && data[field] !== existing[field]) conflict(`已有相同物资的${label}不同，请先选择已有物资，或在规格中区分；资料纠错请在物资信息页说明原因后编辑`);
      }
    }
    index ??= catalogIndex(await all('SELECT * FROM material_catalog ORDER BY id'));
    const coded = data.code ? index.codes.get(normalized(data.code)) || [] : [];
    if (coded.length > 1) conflict('物资编码规范化后有歧义，请联系管理员核对');
    const existing = coded[0];
    if (existing) {
      if (existing.merged_into !== null) conflict('该编码已用于已合并物资，请选择有效物资信息');
      if (!existing.active) conflict('该编码对应的物资信息已停用，请先启用，不能重复新建');
      if (reuse && sameMaterial(existing, data) && existing.category_id === data.category_id && existing.tracking_mode === data.tracking_mode) {
        checkLaboratoryReuse(existing);
        return { row: existing, created: false };
      }
      conflict('物资编码已存在或信息冲突，请选择已有物资信息');
    }
    if (data.code && await one("SELECT 1 FROM material_number_allocations WHERE kind='catalog' AND lower(code)=lower(?) LIMIT 1", data.code)) conflict('该物资编码已被历史记录使用，不能分配给新物资，请使用新编码');
    const matches = index.identities.get(materialKey(data)) || [];
    if (matches.length) {
      if (matches.some(row => !row.active)) conflict('相同物资信息已停用，请先启用，不能重复新建');
      if (!data.code && matches.length === 1 && matches[0].category_id === data.category_id && matches[0].tracking_mode === data.tracking_mode) {
        checkLaboratoryReuse(matches[0]);
        return { row: matches[0], created: false };
      }
      conflict('相同名称、规格和单位的物资信息已存在，分类或管理方式冲突，请选择已有记录');
    }
    data = { ...data, code: data.code || await allocateNumber('catalog') };
    const inserted = await run('INSERT INTO material_catalog(code,name,spec,unit,category_id,created_by,tracking_mode,remark,origin,cas_number,purity,storage_conditions,sds_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      data.code, data.name, data.spec, data.unit, data.category_id, user.id, data.tracking_mode, data.remark, origin, data.cas_number, data.purity, data.storage_conditions, data.sds_url);
    await log(user, 'CREATE', 'material_catalog', inserted.lastInsertRowid, data.code);
    const row = await catalog(inserted.lastInsertRowid);
    index.codes.set(normalized(row.code), [row]);
    index.identities.set(materialKey(row), [row]);
    return { row, created: true };
  }
  async function catalogRows(url) {
    const active = url.searchParams.get('active') ?? 'true';
    if (!['true', 'false', 'all'].includes(active)) error(400, '物资启用状态须为true、false或all');
    const region = url.searchParams.has('regionId') ? (await dictionary('material_regions', url.searchParams.get('regionId'), '区域')).id : null;
    const store = url.searchParams.has('warehouse') ? warehouse(url.searchParams.get('warehouse')) : null;
    const totals = new Map((await all(`SELECT catalog_id,COALESCE(SUM(qty_m),0) AS quantity FROM material_stock_movements GROUP BY catalog_id`))
      .map(row => [row.catalog_id, row.quantity]));
    const scoped = region !== null || store !== null;
    const conditions = [], args = [];
    if (region !== null) { conditions.push('region_id=?'); args.push(region); }
    if (store !== null) { conditions.push('warehouse=?'); args.push(store); }
    const local = scoped ? new Map((await all(`SELECT catalog_id,COALESCE(SUM(qty_m),0) AS quantity FROM material_stock_movements
      WHERE ${conditions.join(' AND ')} GROUP BY catalog_id`, ...args)).map(row => [row.catalog_id, row.quantity])) : totals;
    const referenceIds = await catalogReferenceIds();
    let rows = await mapRows(await all(`SELECT c.*,d.name AS category_name FROM material_catalog c JOIN material_categories d ON d.id=c.category_id WHERE c.merged_into IS NULL`), async row => ({
      ...await catalogView(row, referenceIds.has(row.id)), stockQtyM: totals.get(row.id) || 0, ...(scoped ? { localQtyM: local.get(row.id) || 0 } : {})
    }));
    if (active !== 'all') rows = rows.filter(row => row.active === (active === 'true'));
    if (url.searchParams.has('categoryId')) {
      const category = integer(url.searchParams.get('categoryId'), '分类');
      rows = rows.filter(row => row.categoryId === category);
    }
    if (url.searchParams.has('trackingMode')) {
      const mode = trackingMode(url.searchParams.get('trackingMode'));
      rows = rows.filter(row => row.trackingMode === mode);
    }
    const query = normalized(url.searchParams.get('q'));
    if (query) rows = rows.filter(row => ['code', 'name', 'spec', 'categoryName'].some(field => normalized(row[field]).includes(query)));
    const priority = row => local.get(row.id) > 0 ? 0 : row.stockQtyM > 0 ? 1 : 2;
    return rows.sort((left, right) => priority(left) - priority(right) || left.name.localeCompare(right.name, 'zh-CN') || left.code.localeCompare(right.code) || left.id - right.id);
  }
  function trackingMode(value) {
    if (!['quantity', 'unit'].includes(value)) error(400, '库存管理方式须为quantity或unit');
    return value;
  }
  function unitQuantity(master, quantity, label, maximum) {
    if (master.tracking_mode === 'unit' && (quantity % 1000 || (maximum && quantity > maximum * 1000))) {
      error(400, `${label}须为整瓶/整件${maximum ? `，每次最多${maximum}件` : ''}`);
    }
    return quantity;
  }
  function validateUnitRule(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || typeof rule.template !== 'string' ||
        rule.template.length < 1 || rule.template.length > 100 || !Number.isInteger(rule.padding) || rule.padding < 1 || rule.padding > 12 ||
        (rule.template.match(/\{SEQ\}/g) || []).length !== 1 ||
        !/^[A-Za-z0-9._/-]*$/.test(rule.template.replace(/\{(?:YYYY|MM|DD|SEQ)\}/g, ''))) {
      error(400, '编号模板须含一个{SEQ}，可用{YYYY}{MM}{DD}及ASCII字母数字._/-，长度最多100，补零位数1至12');
    }
    return rule;
  }
  async function unitRuleView() {
    const rule = JSON.parse((await one("SELECT value FROM material_state WHERE key='unit_label_rule'")).value);
    const { reason, ...view } = rule;
    return { rule: view, nextSequence: Number((await one("SELECT value FROM material_state WHERE key='unit_sequence'")).value) + 1, dateBasis: 'UTC' };
  }
  function numberKind(kind) {
    if (!Object.hasOwn(numberKinds, kind)) error(400, '编号类型无效');
    return kind;
  }
  function validateNumberRule(rule) {
    validateUnitRule(rule);
    if (rule.template.length > 40 || !/^[A-Za-z0-9]/.test(rule.template.replace(/\{(?:YYYY|MM|DD|SEQ)\}/g, '1'))) error(400, '编号模板须以字母或数字开头，最多40字符，生成编号最多64字符');
    return rule;
  }
  async function numberRuleView(kind) {
    numberKind(kind);
    const { reason, ...rule } = JSON.parse((await one('SELECT value FROM material_state WHERE key=?', 'number_rule_' + kind)).value);
    return { kind, label: numberKinds[kind].label, rule, nextSequence: Number((await one('SELECT value FROM material_state WHERE key=?', 'number_sequence_' + kind)).value) + 1, dateBasis: 'UTC' };
  }
  async function allocateNumber(kind) {
    const rule = validateNumberRule(JSON.parse((await one('SELECT value FROM material_state WHERE key=?', 'number_rule_' + kind)).value));
    let sequence = Number((await one('SELECT value FROM material_state WHERE key=?', 'number_sequence_' + kind)).value);
    const day = today(), tokens = { YYYY: day.slice(0, 4), MM: day.slice(5, 7), DD: day.slice(8, 10) };
    const table = kind === 'catalog' ? 'material_catalog' : kind === 'request' ? 'material_requests' : 'material_openings';
    const column = kind === 'catalog' ? 'code' : 'no';
    const kinds = ['opening', 'supplement'].includes(kind) ? ['opening', 'supplement'] : [kind];
    let code;
    do {
      sequence++;
      if (!Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER) error(400, '编号流水超出安全范围');
      code = rule.template.replace(/\{(YYYY|MM|DD|SEQ)\}/g, (_, token) => token === 'SEQ' ? String(sequence).padStart(rule.padding, '0') : tokens[token]);
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(code)) error(400, '生成编号无效或超过64字符');
    } while (await one(`SELECT 1 FROM ${table} WHERE lower(${column})=lower(?)`, code) || await one(`SELECT 1 FROM material_number_allocations WHERE kind IN(${kinds.map(() => '?').join(',')}) AND lower(code)=lower(?)`, ...kinds, code));
    await run('INSERT INTO material_number_allocations(kind,sequence,code,created_at) VALUES(?,?,?,?)', kind, sequence, code, now());
    await run('UPDATE material_state SET value=? WHERE key=?', String(sequence), 'number_sequence_' + kind);
    return code;
  }
  function barcodeCode(value) {
    const code = text(value, '条码内容', 512);
    if (/[\u0000-\u001f\u007f-\u009f]/.test(code) || !code.isWellFormed()) error(400, '条码内容不能包含控制字符或无效文字');
    return code;
  }
  function packageBarcode(value) {
    const code = barcodeCode(value);
    if (code.startsWith('LABOS-STOCK:')) error(400, '系统库存二维码前缀不能绑定为外包装条码');
    return code;
  }
  async function barcodeView(row) {
    return { id: row.id, code: row.code, catalogId: row.catalog_id, createdBy: row.created_by,
      creatorName: (await actorName(row.created_by)), createdAt: row.created_at };
  }
  async function request(id) {
    const result = (await one('SELECT * FROM material_requests WHERE id=?', integer(id)));
    if (!result) error(404, '申报单不存在');
    return result;
  }
  async function item(requestId, id) {
    const result = (await one('SELECT * FROM material_request_items WHERE request_id=? AND id=?', requestId, integer(id)));
    if (!result) error(404, '申报明细不存在');
    return result;
  }
  function versions(order, line, input) {
    if (!Number.isSafeInteger(input.requestVersion) || (line && !Number.isSafeInteger(input.version))) error(400, '请提供读取时的整数版本');
    if (input.requestVersion !== order.version || (line && input.version !== line.version)) conflict('单据、明细或验收进度已变化，请重新读取后确认');
  }
  async function activity(lineId) {
    const events = (await all('SELECT type,qty_m,closed_qty_m FROM material_receipts WHERE item_id=?', lineId));
    return {
      exists: events.length > 0,
      accepted: safeSum(events.map(entry => entry.qty_m)),
      closed: safeSum(events.map(entry => entry.closed_qty_m))
    };
  }
  async function bump(orderId, lineId) {
    (await run('UPDATE material_requests SET version=version+1 WHERE id=?', orderId));
    if (lineId) (await run('UPDATE material_request_items SET version=version+1 WHERE id=?', lineId));
  }
  function capability(user) {
    return {
      manageCategories: manager(user, 'materials.categories.write'),
      manageRegions: manager(user, 'materials.regions.write'),
      manageCatalog: manager(user, 'materials.catalog.write'), createRequest: Boolean(user),
      submitRequest: material(user, 'materials.request.submit'),
      editSubmitted: material(user, 'materials.request.edit_submitted'),
      receive: material(user, 'materials.acceptance.write'),
      closeReceipt: material(user, 'materials.acceptance.write'),
      reverseReceipt: material(user, 'materials.acceptance.write'),
      initialize: material(user, 'materials.stock.initialize'),
      adjustStock: material(user, 'materials.stock.adjust'), viewAmount: permit(user, 'materials.amount.read'),
      createIssue: Boolean(user), manageLocation: manager(user, 'materials.stock.location'),
      issueStock: material(user, 'materials.issue.write'), viewAllIssues: role(user, 'ADMIN') || role(user, 'MATERIAL'),
      export: permit(user, 'materials.export'), backup: permit(user, 'backup.read') && permit(user, 'materials.amount.read'),
      restore: permit(user, 'backup.restore') && permit(user, 'materials.amount.read'), legacyRead: permit(user, 'materials.read')
    };
  }
  function mayEdit(order, line, user) {
    if (order.status === 'cancelled') return false;
    if (order.status === 'submitted') return material(user, 'materials.request.edit_submitted');
    return role(user, 'MATERIAL') || line.author_id === user.id;
  }
  function mayHeader(order, user) {
    if (order.status === 'cancelled') return false;
    return order.status === 'submitted' ? material(user, 'materials.request.edit_submitted') : role(user, 'MATERIAL') || order.created_by === user.id;
  }
  async function mayDeleteRequest(order, user) {
    if (order.status !== 'draft') return false;
    if (material(user, 'materials.request.edit_submitted')) return true;
    return order.created_by === user.id && !(await one('SELECT 1 FROM material_request_items WHERE request_id=? AND author_id<>? LIMIT 1', order.id, user.id)) &&
      !(await one('SELECT 1 FROM material_attachments WHERE request_id=? AND actor_id<>? LIMIT 1', order.id, user.id));
  }
  function attachmentView(row) {
    return {
      id: row.id, name: row.name, mimeType: row.mime_type, size: row.size,
      parentType: row.request_id ? 'request' : row.receipt_id ? 'receipt' : 'arrivalDocument', parentId: row.request_id || row.receipt_id || row.document_version_id,
      ...(row.sha256 ? { sha256: row.sha256 } : {}),
      createdAt: row.created_at, actorId: row.actor_id
    };
  }
  async function itemView(row, order, user, snapshot = false) {
    const counts = row.receipt_count === undefined ? (await activity(row.id)) : {
      exists: row.receipt_count > 0, accepted: row.accepted_qty_m, closed: row.closed_qty_m
    };
    const remaining = safeSum([row.qty_m, -counts.accepted, -counts.closed]);
    return {
      id: row.id, requestId: row.request_id, catalogId: row.catalog_id,
      code: row.code, name: row.name, spec: row.spec, unit: row.unit,
      categoryId: row.category_id, categoryName: row.category_name ?? (await one('SELECT name FROM material_categories WHERE id=?', row.category_id))?.name ?? '',
      regionId: row.region_id, regionName: row.region_name ?? (await one('SELECT name FROM material_regions WHERE id=?', row.region_id))?.name ?? '',
      warehouse: row.warehouse, qtyM: row.qty_m, purpose: row.purpose, manufacturer: row.manufacturer,
      trackingMode: row.catalog_id ? (await catalog(row.catalog_id)).tracking_mode : 'quantity',
      authorId: row.author_id, authorName: row.author_name ?? (await actorName(row.author_id)), version: row.version,
      identityLocked: counts.exists,
      acceptedQtyM: counts.accepted, closedQtyM: counts.closed, remainingQtyM: remaining,
      receiptStatus: remaining === 0 ? counts.closed > 0 ? 'closed' : 'done' : counts.accepted > 0 ? 'partial' : 'pending',
      ...(snapshot ? {} : { canEdit: mayEdit(order, row, user), canDelete: order.status === 'draft' && mayEdit(order, row, user) })
    };
  }
  async function requestView(id, user, snapshot = false) {
    const order = (await request(id));
    const items = (await mapRows(await all(`${ITEM_SELECT} WHERE i.request_id=? ORDER BY i.id`, order.id),async row => (await itemView(row, order, user, snapshot))));
    return {
      id: order.id, no: order.no, title: order.title, description: order.description, status: order.status,
      createdBy: order.created_by, creatorName: (await actorName(order.created_by)), createdAt: order.created_at,
      submittedBy: order.submitted_by, submittedAt: order.submitted_at, version: order.version, revision: order.revision,
      cancelledBy: order.cancelled_by, cancelledAt: order.cancelled_at, cancelReason: order.cancel_reason,
      itemCount: items.length, progress: requestProgress(items),
      items, attachments: (await all('SELECT * FROM material_attachments WHERE request_id=? AND active=1 ORDER BY id', order.id)).map(attachmentView),
      ...(snapshot ? {} : {
        canEditHeader: mayHeader(order, user), canAddItem: order.status === 'draft',
        canDelete: await mayDeleteRequest(order, user), canCancel: order.status === 'submitted' && material(user, 'materials.request.edit_submitted') &&
          !(await one('SELECT 1 FROM material_receipts WHERE request_id=? LIMIT 1', order.id)),
        canSubmit: order.status === 'draft' && items.length > 0 && material(user, 'materials.request.submit')
      })
    };
  }
  function requestProgress(items) {
    const pendingItems = items.filter(row => row.remainingQtyM > 0).length;
    const acceptedQtyM = safeSum(items.map(row => row.acceptedQtyM)), closedQtyM = safeSum(items.map(row => row.closedQtyM));
    return { pendingItems, acceptedItems: items.filter(row => row.acceptedQtyM > 0).length,
      doneItems: items.filter(row => row.remainingQtyM === 0 && row.closedQtyM === 0).length,
      closedItems: items.filter(row => row.closedQtyM > 0).length,
      remainingQtyM: safeSum(items.map(row => row.remainingQtyM)), acceptedQtyM, closedQtyM,
      status: pendingItems ? acceptedQtyM || closedQtyM ? 'partial' : 'pending' : closedQtyM ? 'closed' : 'done' };
  }
  async function requestSnapshot(id, revisionValue) {
    const order = await request(id);
    if (!order.original_snapshot || order.revision < 1) conflict('草稿没有固定提交版本，请提交申报单后打印原单');
    const revision = revisionValue === null || revisionValue === undefined ? order.revision : integer(revisionValue, '申报修订版');
    if (revision > order.revision) error(404, '该申报修订版不存在');
    const source = revision === 1 ? order.original_snapshot : (await one('SELECT after_snapshot FROM material_request_revisions WHERE request_id=? AND revision=?', order.id, revision))?.after_snapshot;
    if (!source) error(409, '申报固定快照缺失，请检查修订历史');
    const saved = JSON.parse(source), pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
    const snapshot = pick(saved, ['id', 'no', 'title', 'description', 'status', 'createdBy', 'creatorName', 'createdAt', 'submittedBy', 'submittedAt', 'revision']);
    snapshot.items = saved.items.map(line => pick(line, ['id', 'requestId', 'catalogId', 'code', 'name', 'spec', 'unit', 'categoryId', 'categoryName', 'regionId', 'regionName', 'warehouse', 'qtyM', 'purpose', 'manufacturer', 'trackingMode', 'authorId', 'authorName']));
    for (const line of snapshot.items) line.warehouseName = warehouseName(line.warehouse);
    snapshot.itemCount = snapshot.items.length;
    return { snapshot, revision, currentRevision: order.revision };
  }
  async function exportRequestSnapshot(res, id, url, user) {
    if (!permit(user, 'materials.export')) error(403, '没有物资导出权限');
    const { snapshot, revision } = await requestSnapshot(id, url.searchParams.get('revision'));
    const value = url.searchParams.get('viewUrl') || '';
    let viewUrl = '';
    if (value) {
      let address; try { address = new URL(value); } catch { error(400, '原单查看链接无效'); }
      const host = address.hostname.toLowerCase();
      if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.pathname !== '/' || address.search ||
          host.endsWith('.') || !host.includes('.') || /^(?:localhost|0\.0\.0\.0|127(?:\.\d+){3}|\[.*\])$/i.test(host)) error(400, '请使用实际可访问的系统地址生成原单链接');
      const target = new URLSearchParams(address.hash.slice(1));
      if ([...target].length !== 2 || target.get('material-original') !== String(snapshot.id) || target.get('revision') !== String(revision)) error(400, '原单查看链接须对应本单的确切修订版');
      viewUrl = address.href;
    }
    const sheets = [sheet('申报单信息', ['单号', '主题', '说明', '修订版', '创建人', '提交时间', '原单查看链接'],
      [[snapshot.no, snapshot.title, snapshot.description, revision, snapshot.creatorName, snapshot.submittedAt, viewUrl]]),
      sheet('申报明细', ['核对√', '本次实到', '备注', '物资名称', '规格', '单位', '申报数量', '厂家', '分类', '归属区域', '仓库', '用途', '填报人', '物资编码'],
        snapshot.items.map(line => ['', '', '', line.name, line.spec, line.unit, line.qtyM / 1000, line.manufacturer || '', line.categoryName, line.regionName, line.warehouseName, line.purpose, line.authorName, line.code])),
      instructions(['此文件为固定申报版本，不含当前验收进度或验收金额；二维码核对单请使用系统的原单打印入口。', '纸上勾选和填写实到数量不会自动入库，须在系统核对后办理验收。'])];
    const buffer = await (writeXlsx || require('write-excel-file/node').default)(sheets).toBuffer();
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="labos-request-${snapshot.id}-r${revision}.xlsx"`, 'Content-Length': buffer.length });
    res.end(buffer);
  }
  async function receiptView(row, includeUnits = false) {
    const sourceId = row.type === 'reversal' ? row.original_receipt_id : row.id;
    const unitCount = (await one(`SELECT COUNT(*) AS total FROM material_stock_units u JOIN material_stock_movements m ON m.id=u.source_movement_id WHERE m.receipt_id=?`, sourceId)).total;
    return {
      id: row.id, type: row.type, requestId: row.request_id, itemId: row.item_id,
      requestRevision: row.request_revision, arrivalId: row.arrival_id, snapshot: JSON.parse(row.snapshot),
      qtyM: row.qty_m, rejectedQtyM: row.rejected_qty_m, closedQtyM: row.closed_qty_m, amountCents: row.amount_cents,
      reason: row.reason, rejectedReason: row.rejected_reason, zeroAmountReason: row.zero_amount_reason, manufacturer: row.manufacturer, note: row.note,
      expectedManufacturer: row.expected_manufacturer, manufacturerStatus: row.manufacturer_status,
      manufacturerReason: row.manufacturer_reason, differenceReason: row.difference_reason,
      originalReceiptId: row.original_receipt_id, batch: row.batch, expiryDate: row.expiry_date,
      unitCount, ...(includeUnits ? { units: (await mapRows(await all(`SELECT u.* FROM material_stock_units u JOIN material_stock_movements m ON m.id=u.source_movement_id WHERE m.receipt_id=? ORDER BY u.id`, sourceId),unitView)) } : {}),
      date: row.date, actorId: row.actor_id, actorName: row.actor_name ?? (await actorName(row.actor_id)), createdAt: row.created_at,
      reversed: row.is_reversed === undefined ? Boolean((await one("SELECT 1 FROM material_receipts WHERE type='reversal' AND original_receipt_id=?", row.id))) : Boolean(row.is_reversed)
    };
  }
  async function movementView(row, includeUnits = false) {
    return {
      id: row.id, type: row.type, catalogId: row.catalog_id, regionId: row.region_id, warehouse: row.warehouse,
      qtyM: row.qty_m, amountCents: row.amount_cents, sourceId: row.receipt_id,
      issueId: row.type === 'issue' ? Number(row.source_key.slice(6)) : null,
      snapshot: JSON.parse(row.snapshot), batch: row.batch, expiryDate: row.expiry_date, date: row.date,
      ...(includeUnits ? { units: (await mapRows(await all('SELECT * FROM material_stock_units WHERE source_movement_id=? OR exit_movement_id=? ORDER BY id', row.id, row.id),unitView)) } : {}),
      reason: row.reason, manufacturer: row.manufacturer, note: row.note, actorId: row.actor_id, actorName: row.actor_name ?? (await actorName(row.actor_id)), createdAt: row.created_at
    };
  }
  function scrub(value, user) {
    if (permit(user, 'materials.amount.read')) return value;
    if (Array.isArray(value)) return value.map(entry => scrub(entry, user));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['amountCents', 'amount_cents', 'cents', 'amount'].includes(key))
      .map(([key, entry]) => [key, scrub(entry, user)]));
  }
  function pageInput(url) {
    const page = url.searchParams.has('page') ? integer(url.searchParams.get('page'), '页码') : 1;
    const pageSize = Math.min(url.searchParams.has('pageSize') ? integer(url.searchParams.get('pageSize'), '每页数量') : 50, 200);
    const offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset)) error(400, '页码超出范围');
    return { page, pageSize, offset };
  }
  function paginate(items, url) {
    const { page, pageSize, offset } = pageInput(url);
    return { items: items.slice(offset, offset + pageSize), total: items.length, page, pageSize };
  }
  function search(items, url, keys) {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    return q ? items.filter(entry => keys.some(key => String(entry[key] || '').toLowerCase().includes(q))) : items;
  }
  async function recordRevision(order, user, reason, before) {
    if (order.status !== 'submitted') return;
    (await run('UPDATE material_requests SET revision=revision+1 WHERE id=?', order.id));
    const after = (await requestView(order.id, user, true));
    (await run(`INSERT INTO material_request_revisions(request_id,revision,before_snapshot,after_snapshot,reason,actor_id)
      VALUES(?,?,?,?,?,?)`, order.id, after.revision, JSON.stringify(before), JSON.stringify(after), reason, user.id));
  }
  function editReason(order, input) {
    if (order.status === 'cancelled') conflict('申报单已取消，不能修改');
    return order.status === 'submitted' ? text(input.reason, '修订原因', 1000) : '';
  }
  async function lineInput(input, old = {}) {
    const catalogId = input.catalogId === undefined ? old.catalog_id : input.catalogId === null ? null : integer(input.catalogId, '物资信息');
    const master = catalogId ? await (input.catalogId === undefined ? catalog(catalogId) : activeCatalog(catalogId)) : null;
    const categoryId = input.categoryId === undefined ? old.category_id ?? master?.category_id : integer(input.categoryId, '分类');
    const regionId = input.regionId === undefined ? old.region_id : integer(input.regionId, '区域');
    (await dictionary('material_categories', categoryId, '分类'));
    (await dictionary('material_regions', regionId, '区域'));
    return {
      catalog_id: catalogId || null,
      code: master?.code ?? (input.code === undefined ? old.code || '' : text(input.code, '编码', 64, true).normalize('NFKC').toUpperCase()),
      name: master && old.catalog_id === master.id ? old.name : master?.name ?? (input.name === undefined && old.name !== undefined ? old.name : identityText(input.name, '物资名称')),
      spec: master && old.catalog_id === master.id ? old.spec : master?.spec ?? (input.spec === undefined && old.spec !== undefined ? old.spec : identityText(input.spec, '规格')),
      unit: master && old.catalog_id === master.id ? old.unit : master?.unit ?? (input.unit === undefined && old.unit !== undefined ? old.unit : identityText(input.unit, '单位', 30)),
      category_id: categoryId, region_id: regionId,
      warehouse: warehouse(input.warehouse ?? old.warehouse),
      manufacturer: input.manufacturer === undefined ? old.manufacturer || '' : manufacturerText(input.manufacturer),
      qty_m: unitQuantity(master || { tracking_mode: 'quantity' }, input.quantity === undefined && old.qty_m !== undefined ? old.qty_m : decimal(input.quantity, 3, '申报数量'), '申报数量'),
      purpose: text(input.purpose ?? old.purpose ?? '', '用途', 1000, true)
    };
  }
  function protectedLine(old, next, input, counts) {
    if (next.qty_m < safeSum([counts.accepted, counts.closed])) conflict('申报数量不能小于有效已验收量与结案量之和');
    if (!counts.exists) return;
    const fields = { catalogId: 'catalog_id', code: 'code', name: 'name', spec: 'spec', unit: 'unit', warehouse: 'warehouse', regionId: 'region_id' };
    for (const [external, internal] of Object.entries(fields)) {
      if (next[internal] !== old[internal] || (input[external] !== undefined && input[external] !== old[internal])) {
        conflict('已有验收或结案记录，不能直接修改物资身份、规格单位、仓库或区域');
      }
    }
  }
  function stableJson(value) {
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function idempotent(user, route, input, callback) {
    const key = text(input.requestIdempotencyKey, '幂等请求号', 128);
    if (key.length < 8) error(400, '幂等请求号至少8个字符');
    const digest = crypto.createHash('sha256').update(route + '\n' + stableJson(input)).digest('hex');
    return (await transaction(async () => {
      const previous = (await one('SELECT * FROM material_idempotency WHERE actor_id=? AND key=?', user.id, key));
      if (previous) {
        if (previous.digest !== digest) error(409, '同一幂等请求号不能用于不同内容', 'IDEMPOTENCY_CONFLICT');
        return { status: 200, value: JSON.parse(previous.response) };
      }
      const value = await callback(key);
      (await run('INSERT INTO material_idempotency(actor_id,key,digest,response) VALUES(?,?,?,?)', user.id, key, digest, JSON.stringify(value)));
      return { status: 201, value };
    }));
  }
  async function ensureBalance(row) {
    const previous = (await all(`SELECT qty_m,amount_cents FROM material_stock_movements
      WHERE catalog_id=? AND region_id=? AND warehouse=? AND batch=? AND expiry_date=?`,
    row.catalog_id, row.region_id, row.warehouse, row.batch, row.expiry_date));
    const quantity = safeSum([...previous.map(entry => entry.qty_m), row.qty_m]);
    const amount = safeSum([...previous.map(entry => entry.amount_cents), row.amount_cents]);
    if (quantity < 0 || amount < 0) conflict('该区域、仓库和批次的可用库存数量或金额不足，不能冲减');
    const group = (await all('SELECT qty_m,amount_cents FROM material_stock_movements WHERE catalog_id=? AND region_id=? AND warehouse=?', row.catalog_id, row.region_id, row.warehouse));
    safeSum([...group.map(entry => entry.qty_m), row.qty_m]);
    safeSum([...group.map(entry => entry.amount_cents), row.amount_cents]);
  }
  async function addMovement(data, user, unitInput = {}) {
    const master = (await catalog(data.catalog_id)), single = master.tracking_mode === 'unit';
    unitQuantity(master, Math.abs(data.qty_m), '库存数量', 1000);
    const selected = single && data.qty_m < 0 ? (await selectUnits(data, -data.qty_m, unitInput)) : [];
    if ((!single || data.qty_m > 0) && (Object.hasOwn(unitInput, 'unitIds') || Object.hasOwn(unitInput, 'unitCodes'))) error(400, '此操作不接受单件选择');
    (await ensureBalance(data));
    const manufacturer = data.manufacturer ?? '', note = data.note ?? '';
    let snapshot = data.snapshot;
    if (!single && data.qty_m < 0) {
      const groups = await manufacturerBalances(data);
      snapshot = { ...snapshot, manufacturerAllocations: manufacturerAllocation(groups, -data.qty_m, manufacturer) };
    }
    const result = (await run(`INSERT INTO material_stock_movements(type,catalog_id,region_id,warehouse,qty_m,amount_cents,receipt_id,
      source_key,snapshot,batch,expiry_date,date,reason,actor_id,manufacturer,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    data.type, data.catalog_id, data.region_id, data.warehouse, data.qty_m, data.amount_cents, data.receipt_id || null,
    data.source_key, JSON.stringify(snapshot), data.batch || '', data.expiry_date || '', data.date || today(), data.reason || '', user.id, manufacturer, note));
    const movement = (await one('SELECT * FROM material_stock_movements WHERE id=?', result.lastInsertRowid));
    if (single && data.qty_m > 0) (await generateUnits(movement, user));
    for (const unit of selected) {
      const changed = (await run("UPDATE material_stock_units SET status=?,exit_movement_id=? WHERE id=? AND status='in_stock' AND exit_movement_id IS NULL",
        data.type === 'issue' ? 'issued' : 'void', movement.id, unit.id));
      if (changed.changes !== 1) conflict('单件状态已变化，请重新读取后处理');
    }
    return (await movementView(movement, true));
  }
  async function stockIdentity(input, requireActive = true) {
    return { catalog_id: (await (requireActive ? activeCatalog(input.catalogId) : catalog(input.catalogId))).id, region_id: (await dictionary('material_regions', input.regionId, '区域')).id,
      warehouse: warehouse(input.warehouse), batch: text(input.batch ?? '', '批号', 100, true),
      expiry_date: date(input.expiryDate, '有效期', true) };
  }
  const identityArgs = row => [row.catalog_id, row.region_id, row.warehouse, row.batch, row.expiry_date];
  async function batchBalance(row) {
    const movements = (await all(`SELECT * FROM material_stock_movements
      WHERE catalog_id=? AND region_id=? AND warehouse=? AND batch=? AND expiry_date=? ORDER BY id`, ...identityArgs(row)));
    return { movements, qty: safeSum(movements.map(entry => entry.qty_m)), amount: safeSum(movements.map(entry => entry.amount_cents)) };
  }
  function manufacturerAllocation(groups, quantity, preferred) {
    const lots = [...groups.values()].flatMap(group => group.lots.map(lot => ({ ...lot, manufacturer: group.manufacturer })))
      .sort((a, b) => Number(Boolean(preferred) && b.manufacturer === preferred) - Number(Boolean(preferred) && a.manufacturer === preferred) || a.id - b.id);
    const allocated = new Map();
    for (const lot of lots) {
      const qtyM = Math.min(lot.qtyM, quantity);
      if (qtyM > 0) allocated.set(lot.manufacturer, safeSum([allocated.get(lot.manufacturer) || 0, qtyM]));
      quantity -= qtyM;
      if (!quantity) break;
    }
    if (quantity) error(400, '厂家展示数量与批次库存不一致');
    return [...allocated].map(([manufacturer, qtyM]) => ({ manufacturer, qtyM }));
  }
  async function manufacturerBalances(identity) {
    const { movements } = await batchBalance(identity), groups = new Map();
    const single = (await catalog(identity.catalog_id)).tracking_mode === 'unit';
    const exits = single ? indexRows(await all(`SELECT u.exit_movement_id,s.manufacturer FROM material_stock_units u
      JOIN material_stock_movements s ON s.id=u.source_movement_id WHERE u.exit_movement_id IS NOT NULL
      AND u.catalog_id=? AND u.region_id=? AND u.warehouse=? AND u.batch=? AND u.expiry_date=?`, ...identityArgs(identity)), row => row.exit_movement_id) : new Map();
    for (const row of movements) {
      const snapshot = JSON.parse(row.snapshot), saved = snapshot.manufacturerAllocations;
      if (Object.hasOwn(snapshot, 'manufacturerAllocations')) {
        if (single || row.qty_m >= 0 || !Array.isArray(saved) || !saved.length || saved.length > movements.length) error(400, '厂家出库分配格式无效');
        const seen = new Set();
        for (const part of saved) {
          if (!part || typeof part !== 'object' || Array.isArray(part) || Object.keys(part).length !== 2 ||
              typeof part.manufacturer !== 'string' || text(part.manufacturer, '厂家分配', 200, true) !== part.manufacturer ||
              !Number.isSafeInteger(part.qtyM) || part.qtyM <= 0 || seen.has(part.manufacturer)) error(400, '厂家出库分配明细无效');
          seen.add(part.manufacturer);
        }
        if (safeSum(saved.map(part => part.qtyM)) !== -row.qty_m) error(400, '厂家出库分配数量与流水不一致');
      }
      if (row.qty_m > 0) {
        const group = groups.get(row.manufacturer) || { manufacturer: row.manufacturer, qtyM: 0, lots: [],
          firstMovementAt: row.created_at, lastMovementAt: row.created_at, note: '' };
        group.lots.push({ id: row.id, qtyM: row.qty_m });
        group.qtyM = safeSum([group.qtyM, row.qty_m]);
        group.firstMovementAt = group.firstMovementAt < row.created_at ? group.firstMovementAt : row.created_at;
        group.lastMovementAt = group.lastMovementAt > row.created_at ? group.lastMovementAt : row.created_at;
        if (row.note.trim()) group.note = row.note;
        groups.set(row.manufacturer, group);
        continue;
      }
      let allocations = saved;
      if (single) {
        const quantities = new Map();
        for (const unit of exits.get(row.id) || []) quantities.set(unit.manufacturer, safeSum([quantities.get(unit.manufacturer) || 0, 1000]));
        allocations = [...quantities].map(([manufacturer, qtyM]) => ({ manufacturer, qtyM }));
        if (safeSum(allocations.map(part => part.qtyM)) !== -row.qty_m) error(400, '单件厂家来源与出库数量不一致');
      } else if (!allocations) {
        // Legacy movements lack allocations; FIFO here is a display policy, never a historical rewrite.
        allocations = manufacturerAllocation(groups, -row.qty_m, row.manufacturer);
      }
      for (const part of allocations) {
        const group = groups.get(part.manufacturer);
        if (!group || group.qtyM < part.qtyM) error(400, '厂家出库分配超过对应在库数量');
        group.qtyM -= part.qtyM;
        let remaining = part.qtyM;
        for (const lot of group.lots) {
          const quantity = Math.min(lot.qtyM, remaining);
          lot.qtyM -= quantity; remaining -= quantity;
          if (!remaining) break;
        }
        group.firstMovementAt = group.firstMovementAt < row.created_at ? group.firstMovementAt : row.created_at;
        group.lastMovementAt = group.lastMovementAt > row.created_at ? group.lastMovementAt : row.created_at;
        if (row.note.trim()) group.note = row.note;
      }
    }
    return groups;
  }
  async function selectUnits(identity, quantity, input) {
    const hasIds = Object.hasOwn(input, 'unitIds'), hasCodes = Object.hasOwn(input, 'unitCodes');
    if (hasIds === hasCodes) error(400, '请提供unitIds或unitCodes，且只能选择一种');
    const values = hasIds ? input.unitIds : input.unitCodes;
    if (!Array.isArray(values) || values.length !== quantity / 1000 || values.length < 1 || values.length > 1000) error(400, '单件列表须与整数数量完全一致，每次最多1000件');
    const normalized = values.map(value => {
      if (hasIds) return integer(value, '单件ID');
      if (typeof value !== 'string' || !/^[A-Za-z0-9._/-]{1,128}$/.test(value)) error(400, '单件编号格式无效');
      return value;
    });
    if (new Set(normalized).size !== normalized.length) error(400, '同一单件不能重复选择');
    return (await mapRows(normalized,async value => {
      const row = (await one(`SELECT * FROM material_stock_units WHERE ${hasIds ? 'id' : 'code'}=?`, value));
      if (!row || row.status !== 'in_stock' || identityArgs(row).some((part, index) => part !== identityArgs(identity)[index])) conflict('单件不存在、已出库或不属于当前批次');
      return row;
    }));
  }
  async function generateUnits(movement, user) {
    const rule = validateUnitRule(JSON.parse((await one("SELECT value FROM material_state WHERE key='unit_label_rule'")).value));
    let sequence = Number((await one("SELECT value FROM material_state WHERE key='unit_sequence'")).value);
    const day = today(), tokens = { YYYY: day.slice(0, 4), MM: day.slice(5, 7), DD: day.slice(8, 10) };
    for (let index = 0; index < movement.qty_m / 1000; index++) {
      sequence++;
      if (!Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER) error(400, '单件全局序号已超出范围');
      const code = rule.template.replace(/\{(YYYY|MM|DD|SEQ)\}/g, (_, token) => token === 'SEQ' ? String(sequence).padStart(rule.padding, '0') : tokens[token]);
      if (code.length > 128) error(400, '生成的单件编号超过128字符');
      if ((await one('SELECT 1 FROM material_barcodes WHERE code=?', code)) || (await one('SELECT 1 FROM material_stock_units WHERE code=?', code))) conflict('生成的单件编号与现有码重复，请调整编号规则');
      (await run(`INSERT INTO material_stock_units(code,sequence,catalog_id,region_id,warehouse,batch,expiry_date,source_movement_id,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, code, sequence, ...identityArgs(movement), movement.id, user.id, now()));
    }
    (await run("UPDATE material_state SET value=? WHERE key='unit_sequence'", String(sequence)));
  }
  async function unitView(row) {
    const source = (await one('SELECT * FROM material_stock_movements WHERE id=?', row.source_movement_id)), snapshot = JSON.parse(source.snapshot);
    const master = await catalog(row.catalog_id);
    const exit = row.exit_movement_id ? (await one('SELECT * FROM material_stock_movements WHERE id=?', row.exit_movement_id)) : null;
    return { id: row.id, code: row.code, sequence: row.sequence, qrPayload: row.code, catalogId: row.catalog_id,
      catalogCode: master.code, name: master.name, spec: master.spec, unit: master.unit,
      regionId: row.region_id, regionName: (await dictionary('material_regions', row.region_id, '区域')).name,
      warehouse: row.warehouse, warehouseName: WAREHOUSES.find(entry => entry.code === row.warehouse)?.name || row.warehouse, batch: row.batch, expiryDate: row.expiry_date,
      location: row.status === 'in_stock' ? (await stockLocation(row))?.location || '' : exit ? JSON.parse(exit.snapshot).location || '' : '',
      manufacturer: source.manufacturer, note: source.note,
      status: row.status, sourceMovementId: row.source_movement_id, exitMovementId: row.exit_movement_id,
      sourceReceiptId: source.receipt_id, createdAt: row.created_at };
  }
  async function listUnits(url, user) {
    const filters = [], args = [];
    for (const [parameter, column] of [['catalogId', 'catalog_id'], ['regionId', 'region_id'], ['warehouse', 'warehouse'], ['batch', 'batch'], ['expiryDate', 'expiry_date']]) {
      if (!url.searchParams.has(parameter)) continue;
      filters.push(`u.${column}=?`);
      const value = url.searchParams.get(parameter);
      args.push(parameter.endsWith('Id') ? integer(value, parameter) : parameter === 'warehouse' ? warehouse(value) : parameter === 'expiryDate' ? date(value, '有效期', true) : text(value, '批号', 100, true));
    }
    if (url.searchParams.has('receiptId')) {
      const receipt = (await checkedReceipt(url.searchParams.get('receiptId')));
      filters.push('s.receipt_id=?'); args.push(receipt.type === 'reversal' ? receipt.original_receipt_id : receipt.id);
    }
    if (url.searchParams.has('openingId')) {
      const document = (await opening(url.searchParams.get('openingId')));
      filters.push('EXISTS(SELECT 1 FROM material_opening_items oi WHERE oi.opening_id=? AND oi.movement_id=s.id)');
      args.push(document.id);
    }
    if (url.searchParams.has('issueId')) {
      const issue = (await checkedIssue(url.searchParams.get('issueId'), user)); filters.push('e.source_key=?'); args.push(`issue:${issue.id}`);
    }
    if (url.searchParams.has('status')) {
      const status = url.searchParams.get('status'); if (!['in_stock', 'issued', 'void'].includes(status)) error(400, '单件状态无效');
      filters.push('u.status=?'); args.push(status);
    }
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (q) { filters.push("instr(lower(u.code || ' ' || c.name || ' ' || c.code || ' ' || c.spec || ' ' || cat.name),?)>0"); args.push(q); }
    const from = `FROM material_stock_units u JOIN material_catalog c ON c.id=u.catalog_id JOIN material_categories cat ON cat.id=c.category_id JOIN material_stock_movements s ON s.id=u.source_movement_id
      LEFT JOIN material_stock_movements e ON e.id=u.exit_movement_id${filters.length ? ' WHERE ' + filters.join(' AND ') : ''}`;
    const page = pageInput(url), total = (await one(`SELECT COUNT(*) AS total ${from}`, ...args)).total;
    return { items: (await mapRows(await all(`SELECT u.* ${from} ORDER BY u.id LIMIT ? OFFSET ?`, ...args, page.pageSize, page.offset),unitView)), total, page: page.page, pageSize: page.pageSize };
  }
  async function stockLocation(row) {
    return (await one(`SELECT * FROM material_stock_locations
      WHERE catalog_id=? AND region_id=? AND warehouse=? AND batch=? AND expiry_date=?`, ...identityArgs(row)));
  }
  async function locationView(row) {
    return { id: row.id, catalogId: row.catalog_id, regionId: row.region_id, warehouse: row.warehouse,
      batch: row.batch, expiryDate: row.expiry_date, location: row.location, version: row.version,
      reason: row.reason, actorId: row.actor_id, actorName: (await actorName(row.actor_id)), updatedAt: row.updated_at };
  }
  async function intakeLocation(identity, input, user, reason, save = true) {
    const current = (await stockLocation(identity));
    if (!Object.hasOwn(input, 'location')) return current?.location || '';
    const value = text(input.location, '存放位置', 200, true);
    if (!Number.isSafeInteger(input.locationVersion) || input.locationVersion < 0) error(400, '请提供读取时的位置整数版本');
    if (input.locationVersion !== (current?.version || 0)) conflict('库存位置已变化，请重新读取批次位置后保存');
    if (value === (current?.location || '')) return value;
    requireManager(user, 'materials.stock.location');
    if (save) {
      (await run(`INSERT INTO material_stock_locations(catalog_id,region_id,warehouse,batch,expiry_date,location,version,reason,actor_id,updated_at)
        VALUES(?,?,?,?,?,?,1,?,?,?) ON CONFLICT(catalog_id,warehouse,region_id,batch,expiry_date)
        DO UPDATE SET location=excluded.location,version=material_stock_locations.version+1,reason=excluded.reason,actor_id=excluded.actor_id,updated_at=excluded.updated_at`,
      ...identityArgs(identity), value, reason, user.id, now()));
      (await log(user, 'LOCATION', 'material_stock_locations', (await stockLocation(identity)).id, reason));
    }
    return value;
  }
  async function opening(id) {
    const row = (await one('SELECT * FROM material_openings WHERE id=?', integer(id)));
    if (!row) error(404, '期初或补录单不存在');
    return row;
  }
  function requireOpeningRead(user) {
    if (!permit(user, 'materials.read') && !material(user, 'materials.stock.initialize') && !material(user, 'materials.stock.adjust')) error(403, '没有期初或补录单读取权限');
  }
  async function openingWritable(document, input, user) {
    requireMaterial(user, document.kind === 'supplement' ? 'materials.stock.adjust' : 'materials.stock.initialize');
    if (document.status !== 'draft') conflict('已入库单据不能修改');
    if (document.kind === 'opening' && (await openingClosed())) conflict('期初登记已经关闭，请新建有原因的库存补录单');
    if (input.version !== document.version) conflict('单据已变化，请重新读取后保存');
  }
  async function openingItemInput(input, user, old = {}) {
    const identity = (await stockIdentity({ catalogId: input.catalogId ?? old.catalog_id, regionId: input.regionId ?? old.region_id,
      warehouse: input.warehouse ?? old.warehouse, batch: input.batch ?? old.batch ?? '', expiryDate: input.expiryDate ?? old.expiry_date ?? '' }));
    const master = (await catalog(identity.catalog_id)), region = (await dictionary('material_regions', identity.region_id, '区域'));
    const category = (await dictionary('material_categories', master.category_id, '分类'));
    const quantity = input.quantity === undefined && old.qty_m !== undefined ? old.qty_m : decimal(input.quantity, 3, '期初数量');
    const amount = input.amount === undefined && old.amount_cents !== undefined ? old.amount_cents : decimal(input.amount, 2, '总金额', true);
    unitQuantity(master, quantity, '期初数量', 1000);
    const zeroReason = text(input.zeroAmountReason ?? old.zero_amount_reason ?? '', '零金额原因', 1000, amount > 0);
    const sameBatch = old.catalog_id && identityArgs(identity).every((part, index) => part === identityArgs(old)[index]);
    const current = (await stockLocation(identity));
    const position = { location: input.location ?? (sameBatch ? old.location : current?.location || ''),
      locationVersion: input.locationVersion ?? (sameBatch ? old.location_version : current?.version || 0) };
    position.location = (await intakeLocation(identity, position, user, '期初或补录草稿位置', false));
    const oldSnapshot = old.snapshot ? JSON.parse(old.snapshot) : {};
    const manufacturer = input.manufacturer === undefined ? oldSnapshot.manufacturer || '' : manufacturerText(input.manufacturer);
    const note = text(input.note ?? oldSnapshot.note ?? '', '批次备注', 2000, true);
    return { ...identity, qty_m: quantity, amount_cents: amount, location: position.location, location_version: position.locationVersion,
      zero_amount_reason: zeroReason, snapshot: { catalogId: master.id, code: master.code, name: master.name, spec: master.spec,
        unit: master.unit, trackingMode: master.tracking_mode, categoryId: category.id, categoryName: category.name,
        regionId: region.id, regionName: region.name, warehouse: identity.warehouse, location: position.location, manufacturer, note } };
  }
  async function openingView(id, details = true, user = null) {
    const document = (await opening(id));
    const lines = (await all('SELECT * FROM material_opening_items WHERE opening_id=? ORDER BY id', document.id));
    const items = (await mapRows(lines,async row => ({ ...JSON.parse(row.snapshot), id: row.id, version: row.version,
      qtyM: row.qty_m, amountCents: row.amount_cents, batch: row.batch, expiryDate: row.expiry_date,
      location: row.location, locationVersion: row.location_version, zeroAmountReason: row.zero_amount_reason,
      movementId: row.movement_id, unitCount: row.movement_id ? (await one('SELECT COUNT(*) AS total FROM material_stock_units WHERE source_movement_id=?', row.movement_id)).total : 0 })));
    return { id: document.id, no: document.no, title: document.title, date: document.date, description: document.description,
      kind: document.kind, reason: document.reason, status: document.status, version: document.version,
      canDelete: document.status === 'draft' && material(user, document.kind === 'supplement' ? 'materials.stock.adjust' : 'materials.stock.initialize'),
      createdBy: document.created_by, creatorName: (await actorName(document.created_by)), createdAt: document.created_at,
      postedBy: document.posted_by, posterName: (await actorName(document.posted_by)), postedAt: document.posted_at,
      itemCount: items.length, unitCount: items.reduce((sum, row) => sum + row.unitCount, 0), ...(details ? { items } : {}) };
  }
  async function saveOpeningItem(documentId, data, itemId) {
    const fields = ['catalog_id', 'region_id', 'warehouse', 'qty_m', 'amount_cents', 'batch', 'expiry_date', 'location', 'location_version', 'zero_amount_reason', 'snapshot'];
    const values = fields.map(field => field === 'snapshot' ? JSON.stringify(data.snapshot) : data[field]);
    if (itemId) (await run(`UPDATE material_opening_items SET ${fields.map(field => `${field}=?`).join(',')},version=version+1 WHERE id=?`, ...values, itemId));
    else (await run(`INSERT INTO material_opening_items(opening_id,${fields.join(',')}) VALUES(?,${fields.map(() => '?').join(',')})`, documentId, ...values));
  }
  function openingHeader(input) {
    return { title: text(input.title, '单据主题', 200), date: date(input.date), description: text(input.description ?? '', '单据说明', 2000, true) };
  }
  async function postOpening(document, user) {
    const lines = (await all('SELECT * FROM material_opening_items WHERE opening_id=? ORDER BY id', document.id));
    if (!lines.length || lines.length > 5000) error(400, '单据须包含1至5000条明细');
    const unitCount = safeSum(await mapRows(lines,async row => (await catalog(row.catalog_id)).tracking_mode === 'unit' ? row.qty_m / 1000 : 0));
    if (unitCount > 1000) error(400, '每张单据一次最多生成1000个单件码，请拆分单据');
    const locations = new Map();
    for (const row of lines) {
      const key = JSON.stringify(identityArgs(row));
      const previous = locations.get(key);
      if (previous && (previous.location !== row.location || previous.location_version !== row.location_version)) conflict('同一批次的存放位置或位置版本不一致，请统一后入库');
      (await intakeLocation(row, { location: row.location, locationVersion: row.location_version }, user, '期初或补录入库位置', false));
      locations.set(key, row);
    }
    for (const row of locations.values()) (await intakeLocation(row, { location: row.location, locationVersion: row.location_version }, user, `${document.no} 入库位置`));
    for (const row of lines) {
      const snapshot = JSON.parse(row.snapshot), master = (await activeCatalog(row.catalog_id));
      if (snapshot.trackingMode !== master.tracking_mode) conflict('物资管理方式已变化，请重新编辑该明细');
      const reason = document.kind === 'supplement' ? `${document.no} 补录：${document.reason}` : `${document.no} 期初登记${row.zero_amount_reason ? `：${row.zero_amount_reason}` : ''}`;
      const movement = (await addMovement({ ...row, type: document.kind === 'supplement' ? 'adjustment' : 'opening',
        source_key: `opening-doc:${document.id}:${row.id}`, snapshot, manufacturer: snapshot.manufacturer || '', note: snapshot.note || '', date: document.date, reason }, user));
      (await run('UPDATE material_opening_items SET movement_id=? WHERE id=?', movement.id, row.id));
    }
    (await run("UPDATE material_openings SET status='posted',version=version+1,posted_by=?,posted_at=? WHERE id=?", user.id, now(), document.id));
    (await log(user, document.kind === 'supplement' ? 'SUPPLEMENT' : 'OPENING', 'material_openings', document.id, document.no));
    return { opening: (await openingView(document.id, true, user)), openingClosed: (await openingClosed()) };
  }
  async function checkedIssue(id, user) {
    const row = (await one('SELECT * FROM material_issues WHERE id=?', integer(id)));
    if (!row) error(404, '领用申请不存在');
    if (row.created_by !== user.id && !role(user, 'ADMIN') && !role(user, 'MATERIAL')) error(403, '只能查看本人的领用申请');
    return row;
  }
  async function issueView(row, user, includeUnits = true) {
    const snapshot = JSON.parse(row.snapshot);
    const movement = row.status === 'issued' ? (await one("SELECT * FROM material_stock_movements WHERE source_key=? AND type='issue'", `issue:${row.id}`)) : null;
    const location = row.status === 'pending' ? (await stockLocation(row))?.location || '' :
      movement ? JSON.parse(movement.snapshot).location || '' : snapshot.location || '';
    return { id: row.id, status: row.status, version: row.version, catalogId: row.catalog_id, regionId: row.region_id,
      warehouse: row.warehouse, batch: row.batch, expiryDate: row.expiry_date, qtyM: row.qty_m, amountCents: row.amount_cents,
      trackingMode: (await catalog(row.catalog_id)).tracking_mode,
      unitCount: movement ? (await one('SELECT COUNT(*) AS total FROM material_stock_units WHERE exit_movement_id=?', movement.id)).total : 0,
      ...(includeUnits ? { units: movement ? (await mapRows(await all('SELECT * FROM material_stock_units WHERE exit_movement_id=? ORDER BY id', movement.id),unitView)) : [] } : {}),
      snapshot, location, purpose: row.purpose, reason: row.reason, createdBy: row.created_by, creatorName: (await actorName(row.created_by)),
      processedBy: row.processed_by, processorName: row.processed_by ? (await actorName(row.processed_by)) : '',
      createdAt: row.created_at, processedAt: row.processed_at, movementId: movement?.id || null,
      canIssue: row.status === 'pending' && material(user, 'materials.issue.write'),
      canReject: row.status === 'pending' && material(user, 'materials.issue.write'),
      canCancel: row.status === 'pending' && row.created_by === user.id };
  }
  async function listIssues(url, user, unpaged = false) {
    const filters = [], args = [];
    if (!role(user, 'ADMIN') && !role(user, 'MATERIAL')) { filters.push('i.created_by=?'); args.push(user.id); }
    const status = url.searchParams.get('status');
    if (status) {
      if (!['pending', 'issued', 'rejected', 'cancelled'].includes(status)) error(400, '领用状态无效');
      filters.push('i.status=?'); args.push(status);
    }
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (q) {
      filters.push(`instr(lower(COALESCE(json_extract(i.snapshot,'$.code'),'') || ' ' ||
        COALESCE(json_extract(i.snapshot,'$.name'),'') || ' ' || COALESCE(json_extract(i.snapshot,'$.spec'),'') || ' ' ||
        COALESCE(json_extract(i.snapshot,'$.regionName'),'') || ' ' || i.purpose || ' ' || i.batch || ' ' || u.display_name),?)>0`);
      args.push(q);
    }
    const query = `FROM material_issues i JOIN users u ON u.id=i.created_by${filters.length ? ' WHERE ' + filters.join(' AND ') : ''}`;
    const page = unpaged ? null : pageInput(url);
    const total = page ? (await one(`SELECT COUNT(*) AS total ${query}`, ...args)).total : 0;
    const rows = (await mapRows(await all(`SELECT i.* ${query} ORDER BY i.id DESC${page ? ' LIMIT ? OFFSET ?' : ''}`,
      ...args, ...(page ? [page.pageSize, page.offset] : [])),async row => (await issueView(row, user, false))));
    return page ? { items: rows, total, page: page.page, pageSize: page.pageSize } : rows;
  }
  function issueAmount(quantity, balance) {
    if (quantity > balance.qty || balance.qty <= 0) conflict('该批次可用库存不足，请重新读取库存后处理');
    return quantity === balance.qty ? balance.amount :
      Number((BigInt(balance.amount) * BigInt(quantity) + BigInt(balance.qty) / 2n) / BigInt(balance.qty));
  }
  async function issueAction(user, id, input, route, action) {
    const visible = (await checkedIssue(id, user));
    if (action === 'cancel') {
      if (visible.created_by !== user.id) error(403, '只有申请人可以取消自己的领用申请');
    } else requireMaterial(user, 'materials.issue.write');
    return (await idempotent(user, route, input, async () => {
      const row = (await checkedIssue(id, user));
      if (!Number.isSafeInteger(input.version) || input.version <= 0) error(400, '请提供读取时的整数版本');
      if (row.status !== 'pending' || row.version !== input.version) conflict('领用申请状态或版本已变化，请重新读取');
      const reason = action === 'issue' ? '' : text(input.reason, '处理原因', 1000);
      const processedAt = now();
      let amount = 0;
      if (action === 'issue') {
        const balance = (await batchBalance(row));
        amount = issueAmount(row.qty_m, balance);
        (await addMovement({ ...row, type: 'issue', qty_m: -row.qty_m, amount_cents: -amount, receipt_id: null,
          source_key: `issue:${row.id}`, snapshot: { ...JSON.parse(row.snapshot), location: (await stockLocation(row))?.location || '' },
          date: processedAt.slice(0, 10), reason: row.purpose }, user, input));
      }
      const status = { issue: 'issued', reject: 'rejected', cancel: 'cancelled' }[action];
      (await run(`UPDATE material_issues SET status=?,version=version+1,amount_cents=?,reason=?,processed_by=?,processed_at=? WHERE id=?`,
        status, amount, reason, user.id, processedAt, row.id));
      (await log(user, action === 'issue' ? 'ISSUE' : action === 'reject' ? 'REJECT_ISSUE' : 'CANCEL_ISSUE', 'material_issues', row.id, reason || row.purpose));
      return { issue: (await issueView((await checkedIssue(row.id, user)), user)) };
    }));
  }
  async function stockRows(url, paged = false, byBatch = false) {
    const filters = [], args = [];
    for (const [parameter, column] of [['catalogId', 'catalog_id'], ['regionId', 'region_id'], ['warehouse', 'warehouse']]) {
      if (!url?.searchParams.has(parameter)) continue;
      filters.push(`${column}=?`);
      args.push(parameter === 'warehouse' ? warehouse(url.searchParams.get(parameter)) : integer(url.searchParams.get(parameter), parameter));
    }
    if (byBatch) for (const [parameter, column] of [['batch', 'batch'], ['expiryDate', 'expiry_date']]) {
      if (!url?.searchParams.has(parameter)) continue;
      filters.push(`${column}=?`);
      args.push(parameter === 'batch' ? text(url.searchParams.get(parameter), '批号', 100, true) : date(url.searchParams.get(parameter), '有效期', true));
    }
    const batchColumns = byBatch ? ', batch, expiry_date' : '';
    const query = `WITH balances AS (
      SELECT catalog_id, warehouse, region_id${batchColumns}, SUM(qty_m) AS qty_m, SUM(amount_cents) AS amount_cents,
        MIN(id) AS first_id, MAX(id) AS last_id FROM material_stock_movements
      ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} GROUP BY catalog_id, warehouse, region_id${batchColumns}
    ) SELECT b.*, first.snapshot, r.name AS region_name, first.created_at AS first_movement_at, last.created_at AS last_movement_at
      FROM balances b JOIN material_stock_movements first ON first.id=b.first_id
      JOIN material_stock_movements last ON last.id=b.last_id JOIN material_regions r ON r.id=b.region_id JOIN material_catalog c ON c.id=b.catalog_id JOIN material_categories cat ON cat.id=c.category_id`;
    const q = (url?.searchParams.get('q') || '').trim().toLowerCase();
    const searchSql = q ? ` WHERE instr(lower(c.code || ' ' || c.name || ' ' || c.spec || ' ' || cat.name || ' ' || r.name),?)>0` : '';
    if (q) args.push(q);
    const page = paged ? pageInput(url) : null;
    const total = page ? (await one(`SELECT COUNT(*) AS total FROM (${query + searchSql})`, ...args)).total : 0;
    const rows = (await mapRows(await all(query + searchSql + ' ORDER BY b.first_id' + (page ? ' LIMIT ? OFFSET ?' : ''),
      ...args, ...(page ? [page.pageSize, page.offset] : [])),async row => {
      const master = await catalog(row.catalog_id), category = await dictionary('material_categories', master.category_id, '分类');
      if (!Number.isSafeInteger(row.qty_m) || !Number.isSafeInteger(row.amount_cents)) error(400, '库存累计数值超出安全整数范围');
      return { id: byBatch ? JSON.stringify([row.catalog_id, row.warehouse, row.region_id, row.batch, row.expiry_date]) : `${row.catalog_id}:${row.warehouse}:${row.region_id}`, catalogId: row.catalog_id,
        code: master.code, name: master.name, spec: master.spec, unit: master.unit, active: Boolean(master.active), categoryId: master.category_id, categoryName: category.name,
        trackingMode: (await catalog(row.catalog_id)).tracking_mode, catalogRemark: (await catalog(row.catalog_id)).remark,
        regionId: row.region_id, regionName: row.region_name, warehouse: row.warehouse,
        ...(byBatch ? { batch: row.batch, expiryDate: row.expiry_date,
          location: (await stockLocation(row))?.location || '', locationVersion: (await stockLocation(row))?.version || 0,
          qrPayload: STOCK_QR_PREFIX + JSON.stringify({ catalogId: row.catalog_id, catalogCode: master.code, regionId: row.region_id,
            warehouse: row.warehouse, batch: row.batch, expiryDate: row.expiry_date }) } : {}),
        qtyM: row.qty_m, amountCents: row.amount_cents, firstMovementAt: row.first_movement_at, lastMovementAt: row.last_movement_at };
    }));
    return page ? { items: rows, total, page: page.page, pageSize: page.pageSize } : rows;
  }
  async function stockDetails(url, paged = false) {
    const batches = await stockRows(url, false, true), rows = [];
    const totals = new Map((await all('SELECT catalog_id,SUM(qty_m) AS qty FROM material_stock_movements GROUP BY catalog_id')).map(row => [row.catalog_id, row.qty]));
    for (const batch of batches) {
      const identity = { catalog_id: batch.catalogId, region_id: batch.regionId, warehouse: batch.warehouse, batch: batch.batch, expiry_date: batch.expiryDate };
      const groups = [...(await manufacturerBalances(identity)).values()];
      if (safeSum(groups.map(group => group.qtyM)) !== batch.qtyM) error(400, '厂家明细与批次余额不一致');
      const positive = groups.filter(group => group.qtyM > 0), visible = positive.length ? positive : groups;
      let allocated = 0;
      for (const [index, group] of visible.entries()) {
        const { lots, ...view } = group;
        const amount = index === visible.length - 1 ? batch.amountCents - allocated : batch.qtyM > 0 ?
          Number(BigInt(batch.amountCents) * BigInt(group.qtyM) / BigInt(batch.qtyM)) : 0;
        allocated = safeSum([allocated, amount]);
        rows.push({ ...batch, ...view, id: JSON.stringify([...JSON.parse(batch.id), group.manufacturer]),
          totalQtyM: safeSum([totals.get(batch.catalogId) || 0]), amountCents: amount, amountBasis: 'batch-average' });
      }
    }
    return paged ? paginate(rows, url) : rows;
  }

  async function insertReceipt(data, user) {
    const result = (await run(`INSERT INTO material_receipts(type,request_id,item_id,request_revision,snapshot,qty_m,
      rejected_qty_m,closed_qty_m,amount_cents,reason,rejected_reason,zero_amount_reason,original_receipt_id,
      batch,expiry_date,date,actor_id,manufacturer,note,arrival_id,expected_manufacturer,manufacturer_status,manufacturer_reason,difference_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    data.type, data.request_id, data.item_id, data.request_revision, JSON.stringify(data.snapshot), data.qty_m || 0,
    data.rejected_qty_m || 0, data.closed_qty_m || 0, data.amount_cents || 0, data.reason || '',
    data.rejected_reason || '', data.zero_amount_reason || '', data.original_receipt_id || null,
    data.batch || '', data.expiry_date || '', data.date || today(), user.id, data.manufacturer || '', data.note || '',
    data.arrival_id || null, data.expected_manufacturer || '', data.manufacturer_status || 'legacy', data.manufacturer_reason || '', data.difference_reason || ''));
    return (await one('SELECT * FROM material_receipts WHERE id=?', result.lastInsertRowid));
  }
  async function checkedReceipt(id) {
    const result = (await one('SELECT * FROM material_receipts WHERE id=?', integer(id)));
    if (!result) error(404, '验收事件不存在');
    return result;
  }
  async function receiptAction(user, input, route, kind, orderId, itemId, originalId) {
    requireMaterial(user, 'materials.acceptance.write');
    return idempotent(user, route, input, () => receiptInTransaction(user, input, kind, orderId, itemId, originalId));
  }
  async function linkReceiptCatalog(order, line, input, user, kind) {
      const hasCatalog = input.catalogId !== undefined && input.catalogId !== null;
      const hasNew = Object.hasOwn(input, 'newCatalog');
      if (hasCatalog && hasNew) error(400, '已有物资与新物资信息只能选择一种');
      if (line.catalog_id) {
        if (hasNew || (hasCatalog && integer(input.catalogId, '物资信息') !== line.catalog_id)) conflict('该明细已关联物资信息，不能在验收时更换');
      } else if (kind !== 'reverse' && (hasCatalog || hasNew)) {
        if (hasNew && (!input.newCatalog || typeof input.newCatalog !== 'object' || Array.isArray(input.newCatalog))) error(400, '新物资信息必须是对象');
        const master = hasCatalog ? await activeCatalog(input.catalogId) :
          (await createCatalog(await catalogInput({ ...input.newCatalog, categoryId: input.newCatalog.categoryId ?? line.category_id }), user, true, null, 'receipt')).row;
        unitQuantity(master, line.qty_m, '申报数量');
        await run('UPDATE material_request_items SET catalog_id=?,code=?,name=?,spec=?,unit=?,category_id=? WHERE id=?',
          master.id, master.code, master.name, master.spec, master.unit, master.category_id, line.id);
        await bump(order.id, line.id);
        await log(user, 'LINK_CATALOG', 'material_request_items', line.id, JSON.stringify({ catalogId: master.id, source: 'receipt' }));
        line = await item(order.id, line.id);
      }
      if (!line.catalog_id) conflict('验收前请选择已有物资信息，或填写新物资信息');
      return line;
  }
  async function createArrival(order, user) {
    const result = await run('INSERT INTO material_arrivals(request_id,request_revision,actor_id,created_at) VALUES(?,?,?,?)', order.id, order.revision, user.id, now());
    return result.lastInsertRowid;
  }
  function manufacturerCheck(line, input, quantity) {
    const expected = line.manufacturer || '';
    const manufacturer = manufacturerText(input.manufacturer === undefined ? expected : input.manufacturer);
    const status = input.manufacturerStatus ?? 'known';
    if (!['known', 'unknown'].includes(status)) error(400, '厂家核对状态无效');
    const manufacturerReason = text(input.manufacturerReason ?? '', '厂家未标明原因', 1000, true);
    const differenceReason = text(input.differenceReason ?? '', '厂家差异原因', 1000, true);
    if (quantity > 0) {
      if (status === 'unknown') {
        if (!manufacturerReason) error(400, '厂家未标明时须填写原因');
        if (manufacturer) error(400, '厂家未标明时实际厂家须留空');
      } else {
        if (!manufacturer || ['未指定', '厂家未标明'].includes(manufacturer)) error(400, '请填写实到厂家，确实未标明时选择厂家未标明并填写原因');
        if (expected && identityNormalized(manufacturer) !== identityNormalized(expected) && !differenceReason) error(400, '实到厂家与申报厂家不同，请填写厂家差异原因');
      }
    }
    return { manufacturer, expected_manufacturer: expected, manufacturer_status: status,
      manufacturer_reason: manufacturerReason, difference_reason: differenceReason };
  }
  async function receiptInTransaction(user, input, kind, orderId, itemId, originalId, context = {}) {
      const original = originalId ? (await checkedReceipt(originalId)) : null;
      let order = (await request(original?.request_id || orderId || input.requestId));
      let line = (await item(order.id, original?.item_id || itemId || input.itemId));
      if (!context.prevalidated) versions(order, line, input);
      if (order.status !== 'submitted') conflict('只有已提交申报可办理验收或结案');
      if (!context.prevalidated) line = await linkReceiptCatalog(order, line, input, user, kind);
      const counts = (await activity(line.id));
      const remaining = safeSum([line.qty_m, -counts.accepted, -counts.closed]);
      const snapshot = (await itemView(line, order, user, true));
      let event;
      if (kind === 'close') {
        if (remaining <= 0) conflict('该明细已无剩余可结案数量');
        event = (await insertReceipt({ type: 'close', request_id: order.id, item_id: line.id,
          request_revision: order.revision, snapshot, closed_qty_m: remaining,
          reason: text(input.reason, '结案原因', 1000) }, user));
      } else if (kind === 'reverse') {
        if (original.type !== 'acceptance') error(400, '仅合格验收支持整笔冲正');
        if ((await one("SELECT 1 FROM material_receipts WHERE type='reversal' AND original_receipt_id=?", original.id))) conflict('原验收已经冲正，不能再次冲正');
        const movement = (await one('SELECT * FROM material_stock_movements WHERE receipt_id=?', original.id));
        if (!movement) error(409, '原验收缺少来源流水，不能冲正');
        const units = (await catalog(movement.catalog_id)).tracking_mode === 'unit' ?
          (await all('SELECT * FROM material_stock_units WHERE source_movement_id=? ORDER BY id', movement.id)) : null;
        if (units && (units.length !== original.qty_m / 1000 || units.some(unit => unit.status !== 'in_stock'))) conflict('原验收单件已出库或调整，不能整笔冲正');
        event = (await insertReceipt({ type: 'reversal', request_id: order.id, item_id: line.id,
          request_revision: order.revision, snapshot: JSON.parse(original.snapshot),
          qty_m: -original.qty_m, amount_cents: -original.amount_cents,
          original_receipt_id: original.id, reason: text(input.reason, '冲正原因', 1000),
          batch: original.batch, expiry_date: original.expiry_date, manufacturer: original.manufacturer, note: original.note,
          expected_manufacturer: original.expected_manufacturer, manufacturer_status: original.manufacturer_status,
          manufacturer_reason: original.manufacturer_reason, difference_reason: original.difference_reason }, user));
        (await addMovement({ ...movement, type: 'reversal', qty_m: -movement.qty_m,
          amount_cents: -movement.amount_cents, receipt_id: event.id, source_key: `receipt:${event.id}`,
          snapshot: JSON.parse(movement.snapshot), reason: event.reason, date: today() }, user, units ? { unitIds: units.map(unit => unit.id) } : {}));
      } else {
        const quantity = decimal(input.quantity, 3, '合格数量', true);
        const rejected = decimal(input.rejectedQuantity ?? '0', 3, '拒收数量', true);
        const master = (await catalog(line.catalog_id));
        if (quantity > 0) await activeCatalog(master.id);
        unitQuantity(master, quantity, '合格数量', 1000); unitQuantity(master, rejected, '拒收数量');
        const amount = decimal(input.amount, 2, '本批总金额', true);
        if (quantity === 0 && rejected === 0) error(400, '合格数量与拒收数量不能同时为零');
        if (safeSum([quantity, rejected]) > remaining) conflict('本次合格与拒收数量超过当前剩余待处理量');
        const rejectedReason = rejected > 0 ? text(input.rejectedReason, '拒收原因', 1000) : '';
        const zeroReason = quantity > 0 && amount === 0 ? text(input.zeroAmountReason, '零金额原因', 1000) : '';
        if (quantity === 0 && amount !== 0) error(400, '纯拒收不能计入合格库存金额');
        const identity = { catalog_id: line.catalog_id, region_id: line.region_id, warehouse: line.warehouse,
          batch: text(input.batch ?? '', '批号', 100, true), expiry_date: date(input.expiryDate, '有效期', true) };
        const checkedManufacturer = manufacturerCheck(line, input, quantity);
        const manufacturer = checkedManufacturer.manufacturer;
        Object.assign(snapshot, { expectedManufacturer: checkedManufacturer.expected_manufacturer, actualManufacturer: manufacturer,
          manufacturerStatus: checkedManufacturer.manufacturer_status, manufacturerReason: checkedManufacturer.manufacturer_reason,
          differenceReason: checkedManufacturer.difference_reason });
        const note = text(input.note ?? '', '批次备注', 2000, true);
        if (quantity > 0) snapshot.location = (await intakeLocation(identity, input, user, `${order.no} 验收入库位置`));
        event = (await insertReceipt({ type: quantity > 0 ? 'acceptance' : 'rejection', request_id: order.id,
          item_id: line.id, request_revision: order.revision, snapshot,
          qty_m: quantity, rejected_qty_m: rejected, amount_cents: amount,
          rejected_reason: rejectedReason, zero_amount_reason: zeroReason,
          batch: identity.batch, expiry_date: identity.expiry_date, date: date(input.date), ...checkedManufacturer, note,
          arrival_id: context.arrivalId || await createArrival(order, user) }, user));
        if (quantity > 0) {
          (await addMovement({ type: 'receipt', catalog_id: line.catalog_id, region_id: line.region_id,
            warehouse: line.warehouse, qty_m: quantity, amount_cents: amount, receipt_id: event.id,
            source_key: `receipt:${event.id}`, snapshot, batch: event.batch,
            expiry_date: event.expiry_date, date: event.date, manufacturer, note }, user));
          (await closeOpening());
        }
      }
      (await bump(order.id, line.id));
      (await log(user, event.type.toUpperCase(), 'material_receipts', event.id, order.no));
      return { arrivalId: event.arrival_id, receipt: (await receiptView(event, true)), ...(!context.prevalidated ? { request: await requestView(order.id, user) } : {}) };
  }
  function rowFailure(failure, itemId) {
    if (!failure.status && ['23505', '23503', '23514', '23502'].includes(failure.code)) {
      const source = failure;
      failure = fail(source.code === '23505' ? 409 : 400, source.code === '23505' ? '本行唯一编号或来源重复，整批操作未保存' : '本行业务数据违反完整性约束，整批操作未保存');
    }
    if (failure.status && failure.status < 500) {
      const labels = [['零金额原因', 'zeroAmountReason'], ['拒收原因', 'rejectedReason'], ['拒收数量', 'rejectedQuantity'],
        ['厂家差异原因', 'differenceReason'], ['厂家未标明', 'manufacturerReason'], ['位置整数版本', 'locationVersion'],
        ['金额', 'amount'], ['厂家', 'manufacturer'], ['位置', 'location'], ['数量', 'quantity'], ['版本', 'itemVersion'], ['物资', 'catalogId']];
      failure.errors = [{ itemId, field: labels.find(([label]) => failure.message.includes(label))?.[1] || 'item', message: failure.message }];
    }
    throw failure;
  }
  async function receiveBatch(user, orderId, input, route) {
    requireMaterial(user, 'materials.acceptance.write');
    return idempotent(user, route, input, async () => {
      const order = await request(orderId);
      versions(order, null, { requestVersion: input.version });
      if (order.status !== 'submitted') conflict('只有已提交申报可办理验收');
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 5000) error(400, '每次请选择1至5000条申报明细');
      const seen = new Set(), prepared = [], locations = new Map();
      let unitCount = 0;
      for (const entry of input.items) {
        try {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) error(400, '验收明细须为对象');
          const id = integer(entry.itemId, '申报明细');
          if (seen.has(id)) error(400, '同一申报明细不能重复选择');
          seen.add(id);
          const original = await item(order.id, id);
          versions(order, original, { requestVersion: input.version, version: entry.itemVersion });
          prepared.push({ input: { ...entry }, original });
        } catch (failure) { rowFailure(failure, entry?.itemId); }
      }
      for (const entry of prepared) {
        try {
          const line = await linkReceiptCatalog(order, entry.original, entry.input, user, 'receive');
          delete entry.input.catalogId; delete entry.input.newCatalog;
          const quantity = decimal(entry.input.quantity, 3, '合格数量', true);
          const master = await catalog(line.catalog_id);
          unitQuantity(master, quantity, '合格数量', 1000);
          if (master.tracking_mode === 'unit') unitCount = safeSum([unitCount, quantity / 1000]);
          if (unitCount > 1000) error(400, '本次合计最多生成1000个单件编码，请分次验收');
          if (quantity > 0 && Object.hasOwn(entry.input, 'location')) {
            const identity = { catalog_id: line.catalog_id, region_id: line.region_id, warehouse: line.warehouse,
              batch: text(entry.input.batch ?? '', '批号', 100, true), expiry_date: date(entry.input.expiryDate, '有效期', true) };
            const location = await intakeLocation(identity, entry.input, user, `${order.no} 批量验收入库位置`, false);
            const key = JSON.stringify(identityArgs(identity)), existing = locations.get(key);
            if (existing && existing.location !== location) conflict('本次同一库存批次填写了不同存放位置，请统一后再验收');
            locations.set(key, { identity, input: entry.input, location });
          }
        } catch (failure) { rowFailure(failure, entry.input.itemId); }
      }
      for (const value of locations.values()) await intakeLocation(value.identity, value.input, user, `${order.no} 批量验收入库位置`);
      const arrivalId = await createArrival(order, user), receipts = [];
      for (const entry of prepared) {
        try {
          const data = { ...entry.input }; delete data.location; delete data.locationVersion;
          const result = await receiptInTransaction(user, data, 'receive', order.id, data.itemId, null, { prevalidated: true, arrivalId });
          receipts.push(result.receipt);
        } catch (failure) { rowFailure(failure, entry.input.itemId); }
      }
      return { arrivalId, receipts, request: await requestView(order.id, user) };
    });
  }
  function attachmentInput(input) {
    const name = text(input.name, '文件名', 200);
    if (name === '.' || name === '..' || /[\\/]/.test(name)) error(400, '文件名不能包含路径');
    const mimeType = text(input.mimeType || 'application/octet-stream', '文件类型', 120);
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) error(400, '文件类型无效');
    if (typeof input.content !== 'string' || !input.content || input.content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(input.content)) error(400, `文件“${name}”须为有效base64`);
    if (input.content.length > Math.ceil(FILE_LIMIT / 3) * 4) error(400, `文件“${name}”解码约${Buffer.byteLength(input.content, 'base64')}字节，超过单份5 MiB（${FILE_LIMIT}字节）上限`);
    const content = Buffer.from(input.content, 'base64');
    if (!content.length || content.toString('base64') !== input.content) error(400, `文件“${name}”附件内容无效`);
    if (content.length > FILE_LIMIT) error(400, `文件“${name}”为${content.length}字节，超过单份5 MiB（${FILE_LIMIT}字节）上限`);
    return { name, mimeType, content };
  }
  function attachmentPath(storedName) {
    if (!/^[a-f0-9-]{36}\.bin$/.test(storedName)) error(400, '附件存储标识无效');
    return path.join(uploads, 'materials', storedName);
  }
  function deliveryFile(input) {
    const file = attachmentInput({ ...input, mimeType: input.mimeType ?? input.mime });
    const data = file.content, extension = path.extname(file.name).toLowerCase();
    let png = false;
    if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.readUInt32BE(8) === 13 &&
        data.toString('ascii', 12, 16) === 'IHDR' && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0) {
      let imageData = false;
      for (let offset = 8; offset + 12 <= data.length;) {
        const length = data.readUInt32BE(offset), kind = data.toString('ascii', offset + 4, offset + 8);
        offset += 12 + length;
        if (offset > data.length) break;
        if (kind === 'IDAT') imageData = true;
        if (kind === 'IEND') { png = length === 0 && offset === data.length && imageData; break; }
      }
    }
    let jpeg = false, dimensions = false;
    if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9) {
      for (let offset = 2; offset < data.length - 2;) {
        if (data[offset++] !== 0xff) break;
        while (data[offset] === 0xff) offset++;
        const marker = data[offset++];
        if (offset + 2 > data.length) break;
        const length = data.readUInt16BE(offset);
        if (length < 2 || offset + length > data.length) break;
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 8) dimensions = data.readUInt16BE(offset + 3) > 0 && data.readUInt16BE(offset + 5) > 0;
        if (marker === 0xda) { jpeg = dimensions; break; }
        offset += length;
      }
    }
    const pdf = /^%PDF-(?:1\.[0-9]|2\.0)/.test(data.toString('ascii', 0, 8)) && /%%EOF\s*$/.test(data.subarray(Math.max(0, data.length - 1024)).toString('ascii'));
    const detected = png ? 'image/png' : jpeg ? 'image/jpeg' : pdf ? 'application/pdf' : '';
    if (!detected || file.mimeType !== detected || !(detected === 'image/png' ? ['.png'] : detected === 'image/jpeg' ? ['.jpg', '.jpeg'] : ['.pdf']).includes(extension)) {
      error(400, `文件“${file.name}”的实际内容、扩展名和类型不一致；仅支持JPEG、PNG、PDF，HEIC请先转换`);
    }
    return { ...file, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  }
  function requireArrivalRead(user) {
    if (!permit(user, 'materials.amount.read')) error(403, '到货清单及历史资料需要金额读取权限');
  }
  async function arrival(id) {
    const row = await one('SELECT * FROM material_arrivals WHERE id=?', integer(id, '到货登记'));
    if (!row) error(404, '到货登记不存在');
    return row;
  }
  async function arrivalView(row, user, includeReceipts = false) {
    const receipts = await all('SELECT * FROM material_receipts WHERE arrival_id=? ORDER BY id', row.id);
    return { id: row.id, requestId: row.request_id, requestRevision: row.request_revision,
      actorId: row.actor_id, actorName: await actorName(row.actor_id), createdAt: row.created_at,
      documentVersion: row.document_version, receiptIds: receipts.map(receipt => receipt.id),
      ...(includeReceipts ? { receipts: await mapRows(receipts, event => receiptView(event)) } : {}) };
  }
  async function arrivalDocuments(row, user) {
    requireArrivalRead(user);
    const versions = await all('SELECT * FROM material_arrival_document_versions WHERE arrival_id=? ORDER BY version DESC', row.id);
    return { arrival: await arrivalView(row, user), version: row.document_version,
      versions: await mapRows(versions, async version => ({ id: version.id, version: version.version, reason: version.reason,
        createdAt: version.created_at, actorId: version.actor_id, actorName: await actorName(version.actor_id),
        files: (await all('SELECT * FROM material_attachments WHERE document_version_id=? ORDER BY id', version.id)).map(attachmentView) })) };
  }
  async function saveArrivalDocuments(user, id, input, route) {
    requireMaterial(user, 'materials.acceptance.write');
    requireArrivalRead(user);
    return idempotent(user, route, input, async () => {
      const row = await arrival(id);
      if (!Number.isSafeInteger(input.version) || input.version < 0) error(400, '请提供读取时的资料整数版本');
      if (row.document_version !== input.version) conflict('本次到货资料已有新版本，请重新读取后确认');
      const reason = text(input.reason ?? '', '替换本次清单原因', 1000, row.document_version === 0);
      if (!Array.isArray(input.files) || !input.files.length || input.files.length > 10) error(400, '每版清单请选择1至10份文件，每份不超过5 MiB，整组合计不超过15 MiB');
      const files = input.files.map((value, index) => {
        try { return deliveryFile(value); }
        catch (failure) { if (failure.status) failure.message = `第${index + 1}份清单：${failure.message}`; throw failure; }
      });
      const total = safeSum(files.map(file => file.content.length));
      if (total > 15 * 1024 * 1024) error(400, `本组清单共${total}字节，超过15 MiB；请压缩图片或PDF后重试`);
      const version = row.document_version + 1;
      const inserted = await run('INSERT INTO material_arrival_document_versions(arrival_id,version,reason,actor_id,created_at) VALUES(?,?,?,?,?)', row.id, version, reason, user.id, now());
      for (const file of files) {
        const storedName = crypto.randomUUID() + '.bin', destination = attachmentPath(storedName);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, file.content, { flag: 'wx', mode: 0o600 });
        db.afterRollback(() => fs.rmSync(destination, { force: true }));
        await run('INSERT INTO material_attachments(document_version_id,name,mime_type,stored_name,size,sha256,actor_id) VALUES(?,?,?,?,?,?,?)',
          inserted.lastInsertRowid, file.name, file.mimeType, storedName, file.content.length, file.sha256, user.id);
      }
      await run('UPDATE material_arrivals SET document_version=? WHERE id=?', version, row.id);
      await log(user, 'UPLOAD_DELIVERY_DOCUMENTS', 'material_arrivals', row.id, JSON.stringify({ version, reason, fileCount: files.length, totalBytes: total }));
      return arrivalDocuments(await arrival(row.id), user);
    });
  }
  async function saveAttachment(user, input, requestId, receiptId) {
    const parsed = attachmentInput(input);
    const storedName = crypto.randomUUID() + '.bin';
    const destination = attachmentPath(storedName);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, parsed.content, { flag: 'wx', mode: 0o600 });
    try {
      const result = (await transaction(async () => {
        db.afterRollback(() => fs.rmSync(destination, { force: true }));
        let order, reason, before;
        if (requestId) {
          order = (await request(requestId));
          versions(order, null, input);
          if (!mayHeader(order, user)) error(403, '没有该申报单附件的修改权限');
          reason = editReason(order, input);
          before = order.status === 'submitted' ? (await requestView(order.id, user, true)) : null;
        } else {
          (await checkedReceipt(receiptId));
          requireMaterial(user, 'materials.acceptance.write');
          text(input.reason, '附件追加原因', 1000);
        }
        const inserted = (await run(`INSERT INTO material_attachments(request_id,receipt_id,name,mime_type,stored_name,size,actor_id)
          VALUES(?,?,?,?,?,?,?)`, requestId || null, receiptId || null, parsed.name, parsed.mimeType, storedName, parsed.content.length, user.id));
        const attachment = attachmentView((await one('SELECT * FROM material_attachments WHERE id=?', inserted.lastInsertRowid)));
        if (order) {
          (await bump(order.id));
          (await recordRevision(order, user, reason, before));
        }
        (await log(user, 'UPLOAD', 'material_attachments', attachment.id, parsed.name));
        return { attachment, ...(order ? { request: (await requestView(order.id, user)) } : {}) };
      }));
      return result;
    } catch (failure) {
      fs.rmSync(destination, { force: true });
      throw failure;
    }
  }
  async function listRequests(url, user, exportAll = false) {
    const status = url.searchParams.get('status');
    if (status && !['draft', 'submitted', 'cancelled'].includes(status)) error(400, '申报状态无效');
    const from = date(url.searchParams.get('from') || undefined, '开始日期', true);
    const to = date(url.searchParams.get('to') || undefined, '结束日期', true);
    const filters = [], args = [];
    const acceptanceStatus = url.searchParams.get('acceptanceStatus');
    if (acceptanceStatus && acceptanceStatus !== 'all') {
      if (!['open', 'pending', 'partial', 'done', 'closed'].includes(acceptanceStatus)) error(400, '验收状态无效');
      filters.push("r.status='submitted'");
      const pending = `EXISTS(SELECT 1 FROM material_request_items p WHERE p.request_id=r.id AND p.qty_m>COALESCE((SELECT SUM(e.qty_m+e.closed_qty_m) FROM material_receipts e WHERE e.item_id=p.id),0))`;
      const progressed = `COALESCE((SELECT SUM(e.qty_m+e.closed_qty_m) FROM material_receipts e WHERE e.request_id=r.id),0)>0`;
      const closed = `EXISTS(SELECT 1 FROM material_receipts e WHERE e.request_id=r.id AND e.closed_qty_m>0)`;
      filters.push(acceptanceStatus === 'open' ? pending : acceptanceStatus === 'pending' ? `${pending} AND NOT ${progressed}` :
        acceptanceStatus === 'partial' ? `${pending} AND ${progressed}` : acceptanceStatus === 'closed' ? `NOT ${pending} AND ${closed}` : `NOT ${pending} AND NOT ${closed}`);
    }
    if (status) { filters.push('r.status=?'); args.push(status); }
    if (from) { filters.push('substr(r.created_at,1,10)>=?'); args.push(from); }
    if (to) { filters.push('substr(r.created_at,1,10)<=?'); args.push(to); }
    if (url.searchParams.has('requestId')) { filters.push('r.id=?'); args.push(integer(url.searchParams.get('requestId'))); }
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (q) {
      filters.push(`(instr(lower(r.no || ' ' || r.title || ' ' || u.display_name),?)>0 OR EXISTS(
        SELECT 1 FROM material_request_items i JOIN material_categories c ON c.id=i.category_id
        JOIN material_regions d ON d.id=i.region_id WHERE i.request_id=r.id
        AND instr(lower(i.name || ' ' || i.code || ' ' || i.spec || ' ' || c.name || ' ' || d.name),?)>0))`);
      args.push(q, q);
    }
    const source = `FROM material_requests r JOIN users u ON u.id=r.created_by${filters.length ? ' WHERE ' + filters.join(' AND ') : ''}`;
    const total = (await one(`SELECT COUNT(*) AS total ${source}`, ...args)).total;
    if (exportAll) {
      if (total > 1000) error(413, '一次最多导出1000张申报单，请缩小筛选范围');
      if ((await one(`SELECT COUNT(*) AS total FROM material_request_items WHERE request_id IN(SELECT r.id ${source})`, ...args)).total > 5000) {
        error(413, '一次最多导出5000条申报明细，请缩小筛选范围');
      }
      return (await mapRows(await all(`SELECT r.id ${source} ORDER BY r.id DESC`, ...args),async row => (await requestView(row.id, user))));
    }
    const { page, pageSize, offset } = pageInput(url);
    const rows = (await all(`SELECT r.id,r.no,r.title,r.description,r.status,r.created_by,r.created_at,
      r.submitted_by,r.submitted_at,r.version,r.revision,u.display_name AS creator_name,
      (SELECT COUNT(*) FROM material_request_items i WHERE i.request_id=r.id) AS item_count,
      (SELECT COUNT(*) FROM material_request_items i WHERE i.request_id=r.id AND i.qty_m>
        COALESCE((SELECT SUM(e.qty_m+e.closed_qty_m) FROM material_receipts e WHERE e.item_id=i.id),0)) AS pending_items
      ${source} ORDER BY r.id DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset));
    const progress = new Map(rows.map(row => [row.id, []]));
    if (rows.length) for (const line of await all(`${ITEM_SELECT} WHERE i.request_id IN(${rows.map(() => '?').join(',')})`, ...rows.map(row => row.id))) {
      progress.get(line.request_id).push({ acceptedQtyM: line.accepted_qty_m, closedQtyM: line.closed_qty_m,
        remainingQtyM: safeSum([line.qty_m, -line.accepted_qty_m, -line.closed_qty_m]) });
    }
    return { items: await mapRows(rows, async row => ({ id: row.id, no: row.no, title: row.title, description: row.description,
      status: row.status, createdBy: row.created_by, creatorName: row.creator_name, createdAt: row.created_at,
      submittedBy: row.submitted_by, submittedAt: row.submitted_at, version: row.version, revision: row.revision,
      itemCount: row.item_count, progress: requestProgress(progress.get(row.id)), canEditHeader: mayHeader(row, user),
      canDelete: await mayDeleteRequest(row, user), canCancel: row.status === 'submitted' && material(user, 'materials.request.edit_submitted') &&
        !(await one('SELECT 1 FROM material_receipts WHERE request_id=? LIMIT 1', row.id)),
      canAddItem: row.status === 'draft', canSubmit: row.status === 'draft' && row.item_count > 0 && material(user, 'materials.request.submit')
    })), total, page, pageSize };
  }
  async function listAcceptance(url, user) {
    const filters = [], args = [];
    for (const [parameter, column] of [['catalogId', 'catalog_id'], ['regionId', 'region_id'], ['warehouse', 'warehouse']]) {
      if (!url.searchParams.has(parameter)) continue;
      filters.push(`a.${column}=?`);
      args.push(parameter === 'warehouse' ? warehouse(url.searchParams.get(parameter)) : integer(url.searchParams.get(parameter), parameter));
    }
    const status = url.searchParams.get('status');
    if (status === 'open') filters.push('a.qty_m-a.accepted_qty_m-a.closed_qty_m>0');
    else if (status && status !== 'all') {
      if (!['pending', 'partial', 'done', 'closed'].includes(status)) error(400, '验收状态无效');
      filters.push('a.receipt_status=?'); args.push(status);
    }
    const from = date(url.searchParams.get('from') || undefined, '开始日期', true);
    const to = date(url.searchParams.get('to') || undefined, '结束日期', true);
    if (from) { filters.push('substr(a.request_created_at,1,10)>=?'); args.push(from); }
    if (to) { filters.push('substr(a.request_created_at,1,10)<=?'); args.push(to); }
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (q) {
      filters.push(`instr(lower(a.name || ' ' || a.code || ' ' || a.spec || ' ' || a.category_name || ' ' ||
        a.region_name || ' ' || a.request_no || ' ' || a.request_title),?)>0`);
      args.push(q);
    }
    const source = `WITH lines AS (${ITEM_SELECT}), accepted AS (
      SELECT i.*,r.no AS request_no,r.title AS request_title,r.version AS request_version,
        r.revision AS request_revision,r.created_at AS request_created_at,
        CASE WHEN i.qty_m-i.accepted_qty_m-i.closed_qty_m=0
          THEN CASE WHEN i.closed_qty_m>0 THEN 'closed' ELSE 'done' END
          WHEN i.accepted_qty_m>0 THEN 'partial' ELSE 'pending' END AS receipt_status
      FROM lines i JOIN material_requests r ON r.id=i.request_id WHERE r.status='submitted'
    )`;
    const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
    const total = (await one(`${source} SELECT COUNT(*) AS total FROM accepted a${where}`, ...args)).total;
    const { page, pageSize, offset } = pageInput(url);
    const rows = (await all(`${source} SELECT * FROM accepted a${where} ORDER BY a.request_id DESC,a.id LIMIT ? OFFSET ?`, ...args, pageSize, offset));
    return { items: (await mapRows(rows,async row => ({ ...(await itemView(row, { status: 'submitted' }, user)), requestNo: row.request_no,
      requestTitle: row.request_title, requestVersion: row.request_version, requestRevision: row.request_revision,
      requestCreatedAt: row.request_created_at }))), total, page, pageSize };
  }
  function importRow(sheet, record, errors) {
    const add = (field, message, status = 400) => {
      errors.push({ sheet: sheet.sheet, row: record.row, column: excelColumn(Math.max(0, sheet.headers.indexOf(field))),
        field, value: String(record.values[field] ?? '').slice(0, 200), message });
      if (status === 409) errors.status = 409;
    };
    const check = async (field, callback) => {
      try { return await callback(record.values[field]); }
      catch (failure) { if (!failure.status || failure.status >= 500 || [401, 403].includes(failure.status)) throw failure; add(field, failure.message, failure.status); }
    };
    return { add, check };
  }
  function namedOption(options, value, label) {
    const matches = options.get(normalized(value)) || [];
    if (matches.length !== 1) error(400, `${label}${matches.length ? '名称有歧义，请联系管理员' : '不存在，请从参考表下拉选择或先在系统创建'}`);
    return matches[0];
  }
  async function forgetIdempotency(kind, id) {
    let count = 0;
    for (const row of await all('SELECT actor_id,key,response FROM material_idempotency')) {
      if (references(JSON.parse(row.response), kind, id)) {
        await run('DELETE FROM material_idempotency WHERE actor_id=? AND key=?', row.actor_id, row.key);
        count++;
      }
    }
    return count;
  }
  async function deleteDraftRequest(order, input, user) {
    versions(order, null, input);
    if (order.status !== 'draft') conflict('只能删除未提交草稿；已提交且未验收的单据请办理取消');
    if (!(await mayDeleteRequest(order, user))) error(403, '物资管理员须有申报维护权限；普通人员只能删除本人创建且没有他人明细或附件的草稿');
    const reason = text(input.reason, '删除原因', 1000);
    if (await one('SELECT 1 FROM material_receipts WHERE request_id=? LIMIT 1', order.id) || await one('SELECT 1 FROM material_request_revisions WHERE request_id=? LIMIT 1', order.id)) conflict('单据已有验收或修订历史，不能删除');
    const attachments = await all('SELECT * FROM material_attachments WHERE request_id=?', order.id), staged = [];
    for (const attachment of attachments) {
      const source = attachmentPath(attachment.stored_name);
      if (!fs.existsSync(source)) conflict(`附件 ${attachment.id} 文件缺失，请先核查存储再删除草稿`);
      const destination = source + '.deleted-' + crypto.randomUUID();
      fs.renameSync(source, destination);
      db.afterRollback(() => fs.renameSync(destination, source));
      staged.push(destination);
    }
    await run('DELETE FROM material_attachments WHERE request_id=?', order.id);
    await run('DELETE FROM material_request_items WHERE request_id=?', order.id);
    const clearedReplies = await forgetIdempotency('request', order.id);
    await run('DELETE FROM material_requests WHERE id=?', order.id);
    await log(user, 'DELETE_DRAFT', 'material_requests', order.id, JSON.stringify({ no: order.no, reason,
      attachments: attachments.map(row => ({ id: row.id, name: row.name, size: row.size, actorId: row.actor_id })), clearedReplies }));
    return staged;
  }
  async function dispatch(req, res, url, initialUser) {
    const route = url.pathname.slice('/api/materials'.length) || '/';
    const method = req.method;
    const input = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(method) ? await body(req) : {};
    let user = tokenUser ? (await tokenUser(req)) : initialUser;
    if (!user) error(401, '请先登录');
    const reply = (value, status = 200) => send(res, status, scrub(value, user));
    const labResult = await lab.handle(route, method, input, user);
    if (labResult?.handled) return reply(labResult.value, labResult.status ?? 200);
    let match;
    if (route === '/meta' && method === 'GET') return reply({ capabilities: capability(user), warehouses: WAREHOUSES,
      openingClosed: (await openingClosed()), quantityScale: 1000, amountScale: 100 });

    if (route === '/openings/template.xlsx' && method === 'GET') return (await openingWorkbook(res, user));
    if (route === '/openings') {
      if (method === 'GET') {
        requireOpeningRead(user);
        const status = url.searchParams.get('status'), kind = url.searchParams.get('kind');
        if (status && !['draft', 'posted'].includes(status)) error(400, '单据状态无效');
        if (kind && !['opening', 'supplement'].includes(kind)) error(400, '单据类型无效');
        let rows = (await mapRows(await all('SELECT id FROM material_openings ORDER BY id DESC'),async row => (await openingView(row.id, false, user))));
        if (status) rows = rows.filter(row => row.status === status);
        if (kind) rows = rows.filter(row => row.kind === kind);
        return reply(paginate(search(rows, url, ['no', 'title', 'description']), url));
      }
      if (method === 'POST') {
        const result = (await transaction(async () => {
          const kind = (await openingClosed()) ? 'supplement' : 'opening';
          requireMaterial(user, kind === 'supplement' ? 'materials.stock.adjust' : 'materials.stock.initialize');
          const data = openingHeader(input), reason = text(input.reason ?? '', '补录原因', 1000, kind === 'opening');
          const no = await allocateNumber(kind);
          const inserted = (await run(`INSERT INTO material_openings(no,title,date,description,kind,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)`,
            no, data.title, data.date, data.description, kind, reason, user.id, now()));
          (await log(user, 'CREATE', 'material_openings', Number(inserted.lastInsertRowid), no));
          return (await openingView(inserted.lastInsertRowid, true, user));
        }));
        return reply(result, 201);
      }
    }
    if ((match = route.match(/^\/openings\/(\d+)\/export\.xlsx$/)) && method === 'GET') {
      requireOpeningRead(user);
      return (await openingWorkbook(res, user, (await openingView(match[1]))));
    }
    if ((match = route.match(/^\/openings\/(\d+)\/post$/)) && method === 'POST') {
      requireMaterial(user, (await opening(match[1])).kind === 'supplement' ? 'materials.stock.adjust' : 'materials.stock.initialize');
      const result = (await idempotent(user, route, input, async () => {
        const document = (await opening(match[1]));
        (await openingWritable(document, input, user));
        return (await postOpening(document, user));
      }));
      return reply(result.value, result.status);
    }
    if ((match = route.match(/^\/openings\/(\d+)\/import$/)) && method === 'POST') {
      (await openingWritable((await opening(match[1])), input, user));
      if (!permit(user, 'materials.amount.read')) error(403, '导入含金额的期初或补录明细需要金额读取权限');
      const sheet = await readOpeningWorkbook(input);
      user = tokenUser ? (await tokenUser(req)) : user;
      if (!user) error(401, '请先登录');
      if (!permit(user, 'materials.amount.read')) error(403, '导入含金额的期初或补录明细需要金额读取权限');
      const result = (await transaction(async () => {
        const document = (await opening(match[1])); (await openingWritable(document, input, user));
        if ((await one('SELECT COUNT(*) AS total FROM material_opening_items WHERE opening_id=?', document.id)).total + sheet.rows.length > 5000) error(400, '每张单据最多5000条明细');
        const masters = catalogIndex(await all('SELECT * FROM material_catalog')), regions = indexRows(await all('SELECT * FROM material_regions'), row => normalized(row.name)), errors = [], prepared = [];
        const legacy = sheet.headers.includes('物资编码'), storeField = legacy ? '仓库编码' : '仓库';
        for (const record of sheet.rows) {
          const { check, add } = importRow(sheet, record, errors), before = errors.length, cells = record.values;
          let master;
          if (legacy) master = await check('物资编码', value => {
            const code = text(value, '物资编码', 64);
            const found = masters.codes.get(normalized(code)) || [];
            if (found.length !== 1) error(400, found.length ? '物资编码规范化后有歧义，请联系管理员核对' : '物资编码尚未建立；新版模板请使用中文名称、规格和单位');
            if (found[0].merged_into !== null) error(400, '该物资信息已合并，请选择有效物资信息');
            return found[0];
          });
          else {
            const name = await check('物资名称', value => text(value, '物资名称'));
            const spec = await check('规格', value => text(value, '规格'));
            const unit = await check('单位', value => text(value, '单位', 30));
            if (name !== undefined && spec !== undefined && unit !== undefined) {
              const matches = masters.identities.get(materialKey({ name, spec, unit })) || [];
              if (matches.length > 1) add('物资名称', '名称、规格和单位对应多条物资，请联系管理员核对');
              else if (!matches.length) {
                const hasName = masters.names.has(identityNormalized(name)), hasSpec = masters.specs.has(JSON.stringify([name, spec].map(identityNormalized)));
                add(!hasName ? '物资名称' : !hasSpec ? '规格' : '单位', !hasName ? '物资名称尚未建立，请先在物资信息库建立或导入' : '名称、规格和单位未对应同一条物资信息，请从参考表核对组合');
              }
              else master = matches[0];
            }
          }
          if (master && !master.active) add(legacy ? '物资编码' : '物资名称', '该物资信息已停用，请先启用后再入库', 409);
          const region = await check('区域', value => namedOption(regions, value, '区域'));
          const store = await check(storeField, value => {
            const found = WAREHOUSES.find(row => normalized(row.name) === normalized(value) || (legacy && row.code === value));
            if (!found) error(400, '仓库不存在，请选择：' + WAREHOUSES.map(row => row.name).join('、'));
            return found.code;
          });
          const quantity = await check('数量', value => decimal(String(value), 3, '数量'));
          const amount = await check('总金额（元）', value => decimal(String(value), 2, '总金额', true));
          const batch = await check('批号', value => text(String(value), '批号', 100, true));
          const expiryDate = await check('有效期', value => date(String(value), '有效期', true));
          const location = await check('存放位置', value => text(String(value), '存放位置', 200, true));
          const zeroAmountReason = await check('零金额原因', value => text(String(value), '零金额原因', 1000, amount !== 0));
          const manufacturer = sheet.headers.includes('厂家') ? await check('厂家', value => manufacturerText(String(value))) : '';
          const note = sheet.headers.includes('备注') ? await check('备注', value => text(String(value), '批次备注', 2000, true)) : '';
          if (master && quantity !== undefined) await check('数量', () => unitQuantity(master, quantity, '数量', 1000));
          if (errors.length !== before) continue;
          const identity = await stockIdentity({ catalogId: master.id, regionId: region.id, warehouse: store, batch, expiryDate });
          const current = await stockLocation(identity);
          const data = await check('存放位置', () => openingItemInput({ catalogId: master.id, regionId: region.id, warehouse: store,
            quantity: String(cells['数量']), amount: String(cells['总金额（元）']), batch, expiryDate,
            location: location || current?.location || '', locationVersion: current?.version || 0, zeroAmountReason, manufacturer, note }, user));
          if (data) prepared.push(data);
        }
        if (errors.length) importFailure(errors, errors.status || 400);
        for (const data of prepared) await saveOpeningItem(document.id, data);
        (await run('UPDATE material_openings SET version=version+1 WHERE id=?', document.id));
        (await log(user, 'IMPORT', 'material_openings', document.id, `新增${sheet.rows.length}条草稿明细`));
        return (await openingView(document.id, true, user));
      }));
      return reply(result, 201);
    }
    if ((match = route.match(/^\/openings\/(\d+)\/items(?:\/(\d+))?$/))) {
      if (['POST', 'PUT', 'DELETE'].includes(method)) {
        const result = (await transaction(async () => {
          const document = (await opening(match[1])); (await openingWritable(document, input, user));
          const old = match[2] ? (await one('SELECT * FROM material_opening_items WHERE opening_id=? AND id=?', document.id, integer(match[2]))) : null;
          if (match[2] && !old) error(404, '单据明细不存在');
          if ((method === 'POST') === Boolean(old)) error(400, '单据明细操作路径无效');
          if (old && input.itemVersion !== old.version) conflict('明细已变化，请重新读取后保存');
          if (method === 'DELETE') (await run('DELETE FROM material_opening_items WHERE id=?', old.id));
          else {
            if (!old && (await one('SELECT COUNT(*) AS total FROM material_opening_items WHERE opening_id=?', document.id)).total >= 5000) error(400, '每张单据最多5000条明细');
            (await saveOpeningItem(document.id, (await openingItemInput(input, user, old || {})), old?.id));
          }
          (await run('UPDATE material_openings SET version=version+1 WHERE id=?', document.id));
          (await log(user, method === 'DELETE' ? 'DELETE_ITEM' : 'SAVE_ITEM', 'material_openings', document.id, document.no));
          return (await openingView(document.id, true, user));
        }));
        return reply(result, method === 'POST' ? 201 : 200);
      }
    }
    if ((match = route.match(/^\/openings\/(\d+)$/))) {
      if (method === 'GET') { requireOpeningRead(user); return reply((await openingView(match[1], true, user))); }
      if (method === 'DELETE') {
        await transaction(async () => {
          const document = await opening(match[1]);
          requireMaterial(user, document.kind === 'supplement' ? 'materials.stock.adjust' : 'materials.stock.initialize');
          if (!Number.isSafeInteger(input.version)) error(400, '请提供读取时的整数版本');
          if (input.version !== document.version) conflict('单据已变化，请重新读取');
          if (document.status !== 'draft') conflict('已入库单据不能删除，请使用库存调整保留流水');
          const reason = text(input.reason, '删除原因', 1000);
          if (await one('SELECT 1 FROM material_opening_items WHERE opening_id=? AND movement_id IS NOT NULL LIMIT 1', document.id)) conflict('单据已有入库流水，不能删除');
          await run('DELETE FROM material_opening_items WHERE opening_id=?', document.id);
          const clearedReplies = await forgetIdempotency('opening', document.id);
          await run('DELETE FROM material_openings WHERE id=?', document.id);
          await log(user, 'DELETE_DRAFT', 'material_openings', document.id, JSON.stringify({ no: document.no, reason, clearedReplies }));
        });
        return reply({ deleted: true });
      }
      if (method === 'PATCH') {
        return reply((await transaction(async () => {
          const document = (await opening(match[1])); (await openingWritable(document, input, user));
          const data = openingHeader(input), reason = text(input.reason ?? document.reason, '补录原因', 1000, document.kind === 'opening');
          (await run('UPDATE material_openings SET title=?,date=?,description=?,reason=?,version=version+1 WHERE id=?', data.title, data.date, data.description, reason, document.id));
          (await log(user, 'UPDATE', 'material_openings', document.id, document.no));
          return (await openingView(document.id, true, user));
        })));
      }
    }

    if (route === '/numbering-rules' && method === 'GET') return reply({ items: await mapRows(Object.keys(numberKinds), numberRuleView) });
    if ((match = route.match(/^\/numbering-rules\/([a-z]+)$/)) && method === 'PUT') {
      requireManager(user, 'materials.catalog.write');
      const kind = numberKind(match[1]);
      return reply(await transaction(async () => {
        const current = (await numberRuleView(kind)).rule;
        if (!Number.isSafeInteger(input.version)) error(400, '请提供读取时的整数版本');
        if (input.version !== current.version) conflict('编号规则已变化，请重新读取');
        const rule = validateNumberRule({ template: input.template, padding: input.padding, version: current.version + 1, actorId: user.id, updatedAt: now(), reason: text(input.reason, '编号规则修改原因', 1000) });
        if (!Number.isSafeInteger(rule.version)) error(400, '编号规则版本超出范围');
        await run('UPDATE material_state SET value=? WHERE key=?', JSON.stringify(rule), 'number_rule_' + kind);
        await log(user, 'NUMBER_RULE', 'material_state', 0, JSON.stringify({ kind, ...rule }));
        return numberRuleView(kind);
      }));
    }

    if (route === '/unit-label-rule') {
      if (method === 'GET') return reply((await unitRuleView()));
      if (method === 'PUT') {
        requireManager(user, 'materials.catalog.write');
        const saved = (await transaction(async () => {
          const current = (await unitRuleView()).rule;
          if (!Number.isSafeInteger(input.version) || input.version !== current.version) conflict('编号规则已变化，请重新读取');
          const reason = text(input.reason, '编号规则修改原因', 1000);
          const rule = validateUnitRule({ template: input.template, padding: input.padding, version: current.version + 1, actorId: user.id, updatedAt: now(), reason });
          if (!Number.isSafeInteger(rule.version)) error(400, '编号规则版本超出范围');
          (await run("UPDATE material_state SET value=? WHERE key='unit_label_rule'", JSON.stringify(rule)));
          (await log(user, 'UNIT_LABEL_RULE', 'material_state', 0, JSON.stringify(rule)));
          return (await unitRuleView());
        }));
        return reply(saved);
      }
    }

    if ((match = route.match(/^\/(categories|regions)$/))) {
      const table = match[1] === 'categories' ? 'material_categories' : 'material_regions';
      if (method === 'GET') {
        const rows = (await all(`SELECT * FROM ${table} ORDER BY id`)).map(row => ({ id: row.id, name: row.name, createdBy: row.created_by, createdAt: row.created_at,
          ...(table === 'material_categories' ? { profile: row.profile, version: row.version } : {}) }));
        return reply(paginate(search(rows, url, ['name']), url));
      }
      if (method === 'POST') {
        requireManager(user, `materials.${match[1]}.write`);
        const name = text(input.name, '名称', 80);
        const profile = input.profile ?? 'general';
        if (table === 'material_categories' && !['general', 'chemical'].includes(profile)) error(400, '分类资料类型无效');
        if ((await one(`SELECT 1 FROM ${table} WHERE name=?`, name))) error(409, '同名选项已存在');
        const inserted = (await transaction(async () => {
          const result = table === 'material_categories' ? await run(`INSERT INTO ${table}(name,created_by,profile) VALUES(?,?,?)`, name, user.id, profile) : await run(`INSERT INTO ${table}(name,created_by) VALUES(?,?)`, name, user.id);
          (await log(user, 'CREATE', table, result.lastInsertRowid, name));
          return (await one(`SELECT * FROM ${table} WHERE id=?`, result.lastInsertRowid));
        }));
        return reply({ id: inserted.id, name: inserted.name, createdBy: inserted.created_by, createdAt: inserted.created_at,
          ...(table === 'material_categories' ? { profile: inserted.profile, version: inserted.version } : {}) }, 201);
      }
    }
    if ((match = route.match(/^\/catalog\/(\d+)\/tracking-mode$/)) && method === 'PUT') {
      requireManager(user, 'materials.catalog.write');
      const saved = (await transaction(async () => {
        const master = (await activeCatalog(match[1])), mode = trackingMode(input.trackingMode), reason = text(input.reason, '管理方式修改原因', 1000);
        if (!Number.isSafeInteger(input.version) || input.version !== master.version) conflict('物资信息版本已变化，请重新读取');
        if (mode === master.tracking_mode) return (await catalogView(master));
        if (await catalogReferences(master.id)) conflict('已有申报、库存或历史引用，不能直接切换管理方式');
        if (mode === 'unit' && (await one('SELECT 1 FROM material_request_items WHERE catalog_id=? AND qty_m%1000<>0 LIMIT 1', master.id))) conflict('已有非整数申报数量，不能切换为单件管理');
        (await run('UPDATE material_catalog SET tracking_mode=?,version=version+1 WHERE id=?', mode, master.id));
        (await log(user, 'TRACKING_MODE', 'material_catalog', master.id, JSON.stringify({ before: master.tracking_mode, after: mode, reason })));
        return (await catalogView((await catalog(master.id))));
      }));
      return reply({ catalog: saved });
    }
    if ((match = route.match(/^\/catalog\/(\d+)$/)) && ['GET', 'PATCH', 'DELETE'].includes(method)) {
      if (method === 'GET') return reply({ catalog: await catalogView(await catalog(match[1])) });
      requireManager(user, 'materials.catalog.write');
      const saved = await transaction(async () => {
        const master = await catalog(match[1]);
        if (!Number.isSafeInteger(input.version)) error(400, '请提供读取时的整数版本');
        if (input.version !== master.version) conflict('物资信息版本已变化，请重新读取');
        const reason = text(input.reason, method === 'DELETE' ? '删除原因' : '修改原因', 1000);
        const referenced = await catalogReferences(master.id);
        if (method === 'DELETE') {
          if (referenced || master.merged_into !== null) conflict('该物资已有申报、库存、包装码或历史引用，不能删除，请停用');
          await run('DELETE FROM material_catalog WHERE id=?', master.id);
          await log(user, 'DELETE', 'material_catalog', master.id, JSON.stringify({ code: master.code, reason }));
          return { deleted: true };
        }
        if (input.code !== undefined && input.code !== master.code) error(400, '物资编码为稳定身份，不能修改');
        if (master.merged_into !== null) conflict('已合并物资不能直接编辑');
        const data = await catalogInput({ code: master.code, name: input.name ?? master.name, spec: input.spec ?? master.spec,
          unit: input.unit ?? master.unit, categoryId: input.categoryId ?? master.category_id, remark: input.remark ?? master.remark,
          trackingMode: input.trackingMode ?? master.tracking_mode, ...lab.view(master), ...input });
        if (referenced && (data.unit !== master.unit || data.tracking_mode !== master.tracking_mode)) conflict('该物资已有业务或历史引用，不能直接更改单位或管理方式');
        if (input.active !== undefined && typeof input.active !== 'boolean') error(400, '启用状态须为布尔值');
        const active = input.active === undefined ? master.active : Number(input.active);
        const duplicates = await all('SELECT * FROM material_catalog WHERE id<>? AND merged_into IS NULL', master.id);
        if (duplicates.some(row => sameMaterial(row, data))) conflict('修改后的名称、规格和单位与其他物资重复，请核对');
        await run('UPDATE material_catalog SET name=?,spec=?,unit=?,category_id=?,remark=?,tracking_mode=?,active=?,cas_number=?,purity=?,storage_conditions=?,sds_url=?,version=version+1 WHERE id=?',
          data.name, data.spec, data.unit, data.category_id, data.remark, data.tracking_mode, active, data.cas_number, data.purity, data.storage_conditions, data.sds_url, master.id);
        await log(user, 'UPDATE', 'material_catalog', master.id, JSON.stringify({ reason,
          before: { name: master.name, spec: master.spec, unit: master.unit, categoryId: master.category_id, remark: master.remark, trackingMode: master.tracking_mode, active: Boolean(master.active), ...lab.view(master) },
          after: { name: data.name, spec: data.spec, unit: data.unit, categoryId: data.category_id, remark: data.remark, trackingMode: data.tracking_mode, active: Boolean(active), ...lab.view(data) } }));
        return { catalog: await catalogView(await catalog(master.id)) };
      });
      return reply(saved);
    }
    if ((match = route.match(/^\/catalog\/(\d+)\/barcodes$/))) {
      const master = (await catalog(match[1]));
      if (method === 'GET') return reply(paginate((await mapRows(await all('SELECT * FROM material_barcodes WHERE catalog_id=? ORDER BY id', master.id),barcodeView)), url));
      if (method === 'POST') {
        requireManager(user, 'materials.catalog.write');
        await activeCatalog(master.id);
        const code = packageBarcode(input.code), reason = text(input.reason, '条码绑定原因', 1000);
        const result = (await transaction(async () => {
          if ((await one('SELECT 1 FROM material_stock_units WHERE code=?', code))) conflict('该编号已用于独立单件，不能绑定为包装码');
          const existing = (await one('SELECT * FROM material_barcodes WHERE code=?', code));
          if (existing) {
            if (existing.catalog_id !== master.id) conflict('该条码已绑定其他物资，请核对后先解除原绑定');
            return { barcode: (await barcodeView(existing)), created: false };
          }
          const saved = (await run('INSERT INTO material_barcodes(code,catalog_id,created_by) VALUES(?,?,?)', code, master.id, user.id));
          (await log(user, 'BIND_BARCODE', 'material_barcodes', saved.lastInsertRowid, JSON.stringify({ catalogId: master.id, code, reason })));
          return { barcode: (await barcodeView((await one('SELECT * FROM material_barcodes WHERE id=?', saved.lastInsertRowid)))), created: true };
        }));
        return reply({ barcode: result.barcode }, result.created ? 201 : 200);
      }
    }
    if ((match = route.match(/^\/barcodes\/(\d+)$/)) && method === 'DELETE') {
      requireManager(user, 'materials.catalog.write');
      const reason = text(input.reason, '解除条码绑定原因', 1000);
      (await transaction(async () => {
        const row = (await one('SELECT * FROM material_barcodes WHERE id=?', integer(match[1])));
        if (!row) error(404, '条码绑定不存在，请重新读取');
        (await run('DELETE FROM material_barcodes WHERE id=?', row.id));
        (await log(user, 'UNBIND_BARCODE', 'material_barcodes', row.id, JSON.stringify({ catalogId: row.catalog_id, code: row.code, reason })));
      }));
      return reply({ deleted: true });
    }
    if (route === '/scan/resolve' && method === 'POST') {
      const code = barcodeCode(input.code);
      const unit = (await one('SELECT * FROM material_stock_units WHERE code=?', code));
      if (unit) {
        const query = new URL('http://materials.local/stock/batches');
        for (const [key, value] of Object.entries({ catalogId: unit.catalog_id, regionId: unit.region_id, warehouse: unit.warehouse, batch: unit.batch, expiryDate: unit.expiry_date })) query.searchParams.set(key, value);
        return reply({ kind: 'unit', catalog: (await catalogView((await catalog(unit.catalog_id)))), unit: (await unitView(unit)), batch: (await stockRows(query, false, true))[0] });
      }
      if (code.startsWith('LABOS-STOCK:')) {
        if (!code.startsWith(STOCK_QR_PREFIX)) error(400, '系统库存二维码版本不支持');
        let saved;
        try { saved = JSON.parse(code.slice(STOCK_QR_PREFIX.length)); } catch { error(400, '系统库存二维码格式无效'); }
        const keys = ['catalogId', 'catalogCode', 'regionId', 'warehouse', 'batch', 'expiryDate'];
        if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).length !== keys.length ||
            keys.some(key => !Object.hasOwn(saved, key)) || !Number.isSafeInteger(saved.catalogId) || saved.catalogId <= 0 ||
            !Number.isSafeInteger(saved.regionId) || saved.regionId <= 0 || typeof saved.catalogCode !== 'string' ||
            typeof saved.batch !== 'string' || text(saved.batch, '二维码批号', 100, true) !== saved.batch ||
            typeof saved.expiryDate !== 'string' || date(saved.expiryDate, '二维码有效期', true) !== saved.expiryDate) error(400, '系统库存二维码身份字段无效');
        warehouse(saved.warehouse);
        const master = (await one('SELECT * FROM material_catalog WHERE id=? AND code=?', saved.catalogId, saved.catalogCode));
        if (!master) error(404, '系统二维码对应的物资不存在，请核对当前系统');
        const query = new URL('http://materials.local/stock/batches');
        for (const key of ['catalogId', 'regionId', 'warehouse', 'batch', 'expiryDate']) query.searchParams.set(key, saved[key]);
        const batch = (await stockRows(query, false, true))[0];
        if (!batch) error(404, '系统二维码对应的库存批次不存在');
        return reply({ kind: 'stock', catalog: (await catalogView(master)), batch });
      }
      const barcode = (await one('SELECT * FROM material_barcodes WHERE code=?', code));
      if (!barcode) error(404, '该条码尚未绑定物资信息');
      return reply({ kind: 'catalog', catalog: (await catalogView((await catalog(barcode.catalog_id)))), barcode: (await barcodeView(barcode)) });
    }
    if (['/catalog/template', '/catalog/export.xlsx'].includes(route) && method === 'GET') {
      return await catalogWorkbook(res, url, user, route.endsWith('/template'));
    }
    if (route === '/catalog/import' && method === 'POST') {
      requireManager(user, 'materials.catalog.write');
      const sheet = await readCatalogWorkbook(input);
      user = tokenUser ? await tokenUser(req) : user;
      if (!user) error(401, '请先登录');
      requireManager(user, 'materials.catalog.write');
      const result = await transaction(async () => {
        let created = 0, skipped = 0;
        const categories = indexRows(await all('SELECT * FROM material_categories'), row => normalized(row.name)), masters = catalogIndex(await all('SELECT * FROM material_catalog')), errors = [];
        for (const record of sheet.rows) {
          const { check, add } = importRow(sheet, record, errors), before = errors.length;
          const code = sheet.headers.includes('物资编码') ? await check('物资编码', value => text(value, '物资编码', 64)) : '';
          const name = await check('物资名称', value => text(value, '物资名称'));
          const spec = await check('规格', value => text(value, '规格'));
          const unit = await check('单位', value => text(value, '单位', 30));
          const category = await check('物资分类', value => namedOption(categories, value, '物资分类'));
          const mode = await check('管理方式', value => {
            const result = { '逐件': 'unit', '数量': 'quantity' }[String(value).trim()];
            if (!result) error(400, '管理方式请从下拉列表选择逐件或数量');
            return result;
          });
          const remark = sheet.headers.includes('物资备注') ? await check('物资备注', value => text(String(value), '物资备注', 2000, true)) : undefined;
          const laboratory = {};
          for (const [field, key, column] of [['CAS号', 'casNumber', 'cas_number'], ['纯度／浓度', 'purity', 'purity'], ['储存条件', 'storageConditions', 'storage_conditions'], ['SDS链接', 'sdsUrl', 'sds_url']]) {
            if (sheet.headers.includes(field)) laboratory[key] = await check(field, value => lab.fields({ [key]: String(value) })[column]);
          }
          if (errors.length !== before) continue;
          const candidates = code ? masters.codes.get(normalized(code)) || [] : masters.identities.get(materialKey({ name, spec, unit })) || [];
          if (candidates.length === 1) {
            const existing = candidates[0];
            for (const [field, next, previous] of [['物资名称', name, existing.name], ['规格', spec, existing.spec], ['单位', unit, existing.unit]]) {
              if (identityNormalized(next) !== identityNormalized(previous)) add(field, '此编码对应的物资信息不同，请核对已有记录', 409);
            }
            if (category.id !== existing.category_id) add('物资分类', '已有相同物资的分类不同，请核对已有记录，导入不会覆盖分类', 409);
            if (mode !== existing.tracking_mode) add('管理方式', '已有相同物资的管理方式不同，请核对；更改管理方式须使用专用维护入口', 409);
            if (remark !== undefined && remark !== existing.remark) add('物资备注', '已有相同物资的备注不同，导入不会覆盖已有备注，请先核对', 409);
            for (const [field, key, column] of [['CAS号', 'casNumber', 'cas_number'], ['纯度／浓度', 'purity', 'purity'], ['储存条件', 'storageConditions', 'storage_conditions'], ['SDS链接', 'sdsUrl', 'sds_url']]) {
              if (Object.hasOwn(laboratory, key) && laboratory[key] !== existing[column]) add(field, '与已有物资资料不同，导入不覆盖已有信息，请在物资信息页说明原因后编辑', 409);
            }
          }
          if (errors.length !== before) continue;
          if (candidates.length === 1 && !candidates[0].active && candidates[0].merged_into === null) { skipped++; continue; }
          const saved = await check(sheet.headers.includes('物资编码') ? '物资编码' : '物资名称', async () =>
            createCatalog(await catalogInput({ code, name, spec, unit, categoryId: category.id, trackingMode: mode, remark, ...laboratory }), user, true, masters));
          if (saved?.created) created++; else if (saved) skipped++;
        }
        if (errors.length) importFailure(errors, errors.status || 400);
        return { created, skipped };
      });
      return reply(result, 201);
    }
    if (route === '/catalog') {
      if (method === 'GET') {
        return reply(paginate(await catalogRows(url), url));
      }
      if (method === 'POST') {
        requireManager(user, 'materials.catalog.write');
        const result = await transaction(async () => createCatalog(await catalogInput(input), user));
        return reply(await catalogView(result.row), 201);
      }
    }
    if (route === '/requests') {
      if (method === 'GET') return reply((await listRequests(url, user)));
      if (method === 'POST') {
        const title = text(input.title, '申报标题'), description = text(input.description ?? '', '说明', 5000, true);
        const id = (await transaction(async () => {
          const no = await allocateNumber('request');
          const result = (await run('INSERT INTO material_requests(no,title,description,created_by) VALUES(?,?,?,?)', no, title, description, user.id));
          (await log(user, 'CREATE', 'material_requests', result.lastInsertRowid, no));
          return Number(result.lastInsertRowid);
        }));
        return reply((await requestView(id, user)), 201);
      }
    }
    if ((match = route.match(/^\/requests\/(\d+)$/))) {
      const orderId = integer(match[1]);
      if (method === 'GET') return reply((await requestView(orderId, user)));
      if (method === 'DELETE') {
        const staged = await transaction(async () => deleteDraftRequest(await request(orderId), input, user));
        for (const file of staged) {
          try { fs.unlinkSync(file); } catch { console.error('Deleted material draft attachment remains quarantined for cleanup'); }
        }
        return reply({ deleted: true });
      }
      if (method === 'PATCH') {
        const result = (await transaction(async () => {
          const order = (await request(orderId));
          versions(order, null, input);
          if (!mayHeader(order, user)) error(403, '没有该申报单表头的修改权限');
          const reason = editReason(order, input);
          const title = input.title === undefined ? order.title : text(input.title, '标题');
          const description = input.description === undefined ? order.description : text(input.description, '说明', 5000, true);
          if (title === order.title && description === order.description) return (await requestView(order.id, user));
          const before = order.status === 'submitted' ? (await requestView(order.id, user, true)) : null;
          (await run('UPDATE material_requests SET title=?,description=? WHERE id=?', title, description, order.id));
          (await bump(order.id));
          (await recordRevision(order, user, reason, before));
          (await log(user, 'UPDATE', 'material_requests', order.id, reason));
          return (await requestView(order.id, user));
        }));
        return reply(result);
      }
    }
    if ((match = route.match(/^\/requests\/(\d+)\/cancel$/)) && method === 'POST') {
      requireMaterial(user, 'materials.request.edit_submitted');
      return reply(await transaction(async () => {
        const order = await request(match[1]); versions(order, null, input);
        if (order.status !== 'submitted') conflict('只能取消已提交且没有验收事件的申报单');
        const reason = text(input.reason, '取消原因', 1000);
        const event = await one('SELECT id,type FROM material_receipts WHERE request_id=? ORDER BY id LIMIT 1', order.id);
        if (event) conflict(`该申报已有验收事件 #${event.id}（${event.type}），不能取消；合格验收请沿用验收冲正`);
        await run("UPDATE material_requests SET status='cancelled',cancelled_by=?,cancelled_at=?,cancel_reason=?,version=version+1 WHERE id=?", user.id, now(), reason, order.id);
        await log(user, 'CANCEL', 'material_requests', order.id, JSON.stringify({ no: order.no, reason }));
        return requestView(order.id, user);
      }));
    }
    if ((match = route.match(/^\/requests\/(\d+)\/items\/(\d+)\/catalog$/)) && method === 'POST') {
      requireManager(user, 'materials.catalog.write');
      const result = await idempotent(user, route, input, async () => {
        const order = await request(match[1]), line = await item(order.id, match[2]);
        versions(order, line, { ...input, version: input.itemVersion });
        if (!mayEdit(order, line, user)) error(403, '没有该申报明细的修改权限');
        if (line.catalog_id || (await activity(line.id)).exists) conflict('该明细已关联物资或发生验收/结案，请重新核对');
        const reason = text(input.reason, '建档原因', 1000);
        const before = order.status === 'submitted' ? await requestView(order.id, user, true) : null;
        const saved = await createCatalog(await catalogInput(input), user, true), master = saved.row;
        unitQuantity(master, line.qty_m, '申报数量');
        await run(`UPDATE material_request_items SET catalog_id=?,code=?,name=?,spec=?,unit=?,category_id=? WHERE id=?`,
          master.id, master.code, master.name, master.spec, master.unit, master.category_id, line.id);
        await bump(order.id, line.id);
        await recordRevision(order, user, reason, before);
        await log(user, 'LINK_CATALOG', 'material_request_items', line.id, JSON.stringify({ catalogId: master.id, reason }));
        return { request: await requestView(order.id, user) };
      });
      return reply(result.value, result.status);
    }
    if ((match = route.match(/^\/requests\/(\d+)\/items(?:\/(\d+))?$/))) {
      const orderId = integer(match[1]), itemId = match[2] ? integer(match[2]) : null;
      if ((method === 'POST' && !itemId) || (['PATCH', 'DELETE'].includes(method) && itemId)) {
        const result = (await transaction(async () => {
          const order = (await request(orderId)), old = itemId ? (await item(order.id, itemId)) : null;
          if (method === 'POST') {
            integer(input.requestVersion, '读取时的单据版本');
          } else versions(order, old, input);
          if (input.authorId !== undefined || input.author_id !== undefined) error(400, '填报人由会话确定，不能指定他人');
          if (method === 'POST' && order.status !== 'draft') conflict('已提交单不能新增明细');
          if (old && !mayEdit(order, old, user)) error(403, '没有该申报明细的修改权限');
          if (method === 'DELETE') {
            if (order.status !== 'draft') conflict('已提交单不能删除明细');
            (await run('DELETE FROM material_request_items WHERE id=?', old.id));
            (await bump(order.id));
            (await log(user, 'DELETE', 'material_request_items', old.id, order.no));
            return (await requestView(order.id, user));
          }
          const reason = editReason(order, input);
          const next = (await lineInput(input, old || {}));
          if (old) protectedLine(old, next, input, (await activity(old.id)));
          if (old && Object.keys(next).every(key => next[key] === old[key])) return (await requestView(order.id, user));
          const before = order.status === 'submitted' ? (await requestView(order.id, user, true)) : null;
          if (old) {
            (await run(`UPDATE material_request_items SET catalog_id=?,code=?,name=?,spec=?,unit=?,category_id=?,region_id=?,warehouse=?,qty_m=?,purpose=?,manufacturer=? WHERE id=?`,
              next.catalog_id, next.code, next.name, next.spec, next.unit, next.category_id, next.region_id, next.warehouse, next.qty_m, next.purpose, next.manufacturer, old.id));
            (await bump(order.id, old.id));
          } else {
            (await run(`INSERT INTO material_request_items(request_id,catalog_id,code,name,spec,unit,category_id,region_id,warehouse,qty_m,purpose,author_id,manufacturer)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, order.id, next.catalog_id, next.code, next.name, next.spec, next.unit,
            next.category_id, next.region_id, next.warehouse, next.qty_m, next.purpose, user.id, next.manufacturer));
            (await bump(order.id));
          }
          (await recordRevision(order, user, reason, before));
          (await log(user, old ? 'UPDATE' : 'CREATE', 'material_requests', order.id, reason));
          return (await requestView(order.id, user));
        }));
        return reply(result, method === 'POST' ? 201 : 200);
      }
    }
    if ((match = route.match(/^\/requests\/(\d+)\/submit$/)) && method === 'POST') {
      requireMaterial(user, 'materials.request.submit');
      const result = (await transaction(async () => {
        const order = (await request(match[1]));
        versions(order, null, input);
        if (order.status !== 'draft') conflict('申报单已提交');
        const items = (await all('SELECT * FROM material_request_items WHERE request_id=?', order.id));
        if (!items.length) error(400, '提交前须至少有一条有效物资明细');
        for (const line of items) if (line.catalog_id) await activeCatalog(line.catalog_id);
        (await run("UPDATE material_requests SET status='submitted',submitted_by=?,submitted_at=?,revision=1,version=version+1 WHERE id=?", user.id, now(), order.id));
        (await run('UPDATE material_requests SET original_snapshot=? WHERE id=?', JSON.stringify((await requestView(order.id, user, true))), order.id));
        (await log(user, 'SUBMIT', 'material_requests', order.id, order.no));
        return (await requestView(order.id, user));
      }));
      return reply(result);
    }
    if ((match = route.match(/^\/requests\/(\d+)\/snapshot(\/export\.xlsx)?$/)) && method === 'GET') {
      if (match[2]) return exportRequestSnapshot(res, match[1], url, user);
      return reply(await requestSnapshot(match[1], url.searchParams.get('revision')));
    }
    if ((match = route.match(/^\/requests\/(\d+)\/receipts\/batch$/)) && method === 'POST') {
      const result = await receiveBatch(user, match[1], input, route);
      return reply(result.value, result.status);
    }
    if ((match = route.match(/^\/requests\/(\d+)\/arrivals$/)) && method === 'GET') {
      requireArrivalRead(user);
      const order = await request(match[1]), { page, pageSize, offset } = pageInput(url);
      const total = (await one('SELECT COUNT(*) AS total FROM material_arrivals WHERE request_id=?', order.id)).total;
      const rows = await all('SELECT * FROM material_arrivals WHERE request_id=? ORDER BY id DESC LIMIT ? OFFSET ?', order.id, pageSize, offset);
      return reply({ items: await mapRows(rows, row => arrivalView(row, user, true)), total, page, pageSize });
    }
    if ((match = route.match(/^\/arrivals\/(\d+)\/documents$/))) {
      if (method === 'GET') return reply(await arrivalDocuments(await arrival(match[1]), user));
      if (method === 'POST') {
        const result = await saveArrivalDocuments(user, match[1], input, route);
        return reply(result.value, result.status);
      }
    }
    if ((match = route.match(/^\/requests\/(\d+)\/revisions$/)) && method === 'GET') {
      const order = (await request(match[1]));
      const revisions = (await mapRows(await all('SELECT * FROM material_request_revisions WHERE request_id=? ORDER BY revision', order.id),async row => ({
        id: row.id, revision: row.revision, reason: row.reason, actorId: row.actor_id, actorName: (await actorName(row.actor_id)),
        createdAt: row.created_at, before: JSON.parse(row.before_snapshot), after: JSON.parse(row.after_snapshot)
      })));
      return reply({ originalSnapshot: order.original_snapshot ? JSON.parse(order.original_snapshot) : null, revisions });
    }
    if (route === '/acceptance' && method === 'GET') {
      return reply((await listAcceptance(url, user)));
    }
    if (route === '/receipts') {
      if (method === 'GET') {
        const filters = [], args = [];
        for (const [parameter, column] of [['requestId', 'request_id'], ['itemId', 'item_id']]) {
          if (url.searchParams.has(parameter)) { filters.push(`e.${column}=?`); args.push(integer(url.searchParams.get(parameter))); }
        }
        const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
        const total = (await one(`SELECT COUNT(*) AS total FROM material_receipts e${where}`, ...args)).total;
        const { page, pageSize, offset } = pageInput(url);
        const rows = (await all(`SELECT e.*,u.display_name AS actor_name,
          EXISTS(SELECT 1 FROM material_receipts x WHERE x.type='reversal' AND x.original_receipt_id=e.id) AS is_reversed
          FROM material_receipts e JOIN users u ON u.id=e.actor_id${where} ORDER BY e.id DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset));
        return reply({ items: (await mapRows(rows,async row => (await receiptView(row)))), total, page, pageSize });
      }
      if (method === 'POST') {
        const result = (await receiptAction(user, input, route, 'receive'));
        return reply(result.value, result.status);
      }
    }
    if ((match = route.match(/^\/requests\/(\d+)\/items\/(\d+)\/close$/)) && method === 'POST') {
      const result = (await receiptAction(user, input, route, 'close', match[1], match[2]));
      return reply(result.value, result.status);
    }
    if ((match = route.match(/^\/receipts\/(\d+)\/reverse$/)) && method === 'POST') {
      const result = (await receiptAction(user, input, route, 'reverse', null, null, match[1]));
      return reply(result.value, result.status);
    }
    if (route === '/issues' && method === 'GET') return reply((await listIssues(url, user)));
    if ((match = route.match(/^\/issues\/(\d+)$/)) && method === 'GET') return reply({ issue: (await issueView((await checkedIssue(match[1], user)), user)) });
    if (route === '/issues' && method === 'POST') {
      const result = (await idempotent(user, route, input, async () => {
        const identity = (await stockIdentity(input, false)), balance = (await batchBalance(identity));
        const quantity = decimal(input.quantity, 3, '领用数量');
        unitQuantity((await catalog(identity.catalog_id)), quantity, '领用数量', 1000);
        if (Object.hasOwn(input, 'unitIds') || Object.hasOwn(input, 'unitCodes')) error(400, '申请不预占具体单件，请在发放时选择');
        if (balance.qty < quantity) conflict('该批次可用库存不足，不能提交领用申请');
        const purpose = text(input.purpose, '领用用途', 1000), master = await catalog(identity.catalog_id);
        const category = await dictionary('material_categories', master.category_id, '分类');
        const snapshot = { ...JSON.parse(balance.movements[0].snapshot), code: master.code, name: master.name, spec: master.spec, unit: master.unit,
          categoryId: master.category_id, categoryName: category.name, batch: identity.batch, expiryDate: identity.expiry_date,
          location: (await stockLocation(identity))?.location || '', createdBy: user.id };
        const result = (await run(`INSERT INTO material_issues(catalog_id,region_id,warehouse,batch,expiry_date,qty_m,snapshot,purpose,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, ...identityArgs(identity), quantity, JSON.stringify(snapshot), purpose, user.id, now()));
        const issue = (await issueView((await checkedIssue(result.lastInsertRowid, user)), user));
        (await log(user, 'CREATE_ISSUE', 'material_issues', issue.id, purpose));
        return { issue };
      }));
      return reply(result.value, result.status);
    }
    if ((match = route.match(/^\/issues\/(\d+)\/(issue|reject|cancel)$/)) && method === 'POST') {
      const result = (await issueAction(user, match[1], input, route, match[2]));
      return reply(result.value, result.status);
    }
    if (route === '/stock/location' && method === 'PUT') {
      requireManager(user, 'materials.stock.location');
      const location = (await transaction(async () => {
        const identity = (await stockIdentity(input, false)), current = (await stockLocation(identity));
        if (!Number.isSafeInteger(input.version) || input.version < 0) error(400, '请提供读取时的位置整数版本');
        if (input.version !== (current?.version || 0)) conflict('库存位置已变化，请重新读取后修改');
        if (!(await batchBalance(identity)).movements.length) error(400, '只能维护已有库存流水批次的位置');
        const value = text(input.location, '库存位置', 200, true), reason = text(input.reason, '位置修改原因', 1000);
        (await run(`INSERT INTO material_stock_locations(catalog_id,region_id,warehouse,batch,expiry_date,location,version,reason,actor_id,updated_at)
          VALUES(?,?,?,?,?,?,1,?,?,?) ON CONFLICT(catalog_id,warehouse,region_id,batch,expiry_date)
          DO UPDATE SET location=excluded.location,version=material_stock_locations.version+1,reason=excluded.reason,actor_id=excluded.actor_id,updated_at=excluded.updated_at`,
        ...identityArgs(identity), value, reason, user.id, now()));
        const saved = (await stockLocation(identity));
        (await log(user, 'LOCATION', 'material_stock_locations', saved.id, reason));
        return (await locationView(saved));
      }));
      return reply({ location });
    }
    if (route === '/stock' && method === 'GET') return reply((await stockRows(url, true)));
    if (route === '/stock/batches' && method === 'GET') return reply(url.searchParams.get('detail') === '1' ? await stockDetails(url, true) : await stockRows(url, true, true));
    if (route === '/stock/manufacturers' && method === 'GET') return reply({ items: (await all("SELECT DISTINCT manufacturer FROM material_stock_movements WHERE manufacturer<>'' ORDER BY manufacturer")).map(row => row.manufacturer) });
    if (route === '/stock/units' && method === 'GET') return reply((await listUnits(url, user)));
    if (route === '/stock/movements' && method === 'GET') {
      const filters = [], args = [];
      if (url.searchParams.has('type')) {
        const type = url.searchParams.get('type');
        if (!['opening', 'receipt', 'reversal', 'adjustment', 'issue'].includes(type)) error(400, '库存流水类型无效');
        filters.push('m.type=?'); args.push(type);
      }
      for (const [parameter, column] of [['catalogId', 'catalog_id'], ['regionId', 'region_id'], ['warehouse', 'warehouse'], ['batch', 'batch'], ['expiryDate', 'expiry_date']]) {
        if (url.searchParams.has(parameter)) {
          filters.push(`m.${column}=?`);
          const value = url.searchParams.get(parameter);
          args.push(parameter === 'warehouse' ? warehouse(value) : parameter === 'batch' ? text(value, '批号', 100, true) :
            parameter === 'expiryDate' ? date(value, '有效期', true) : integer(value));
        }
      }
      const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
      const total = (await one(`SELECT COUNT(*) AS total FROM material_stock_movements m${where}`, ...args)).total;
      const { page, pageSize, offset } = pageInput(url);
      const rows = (await all(`SELECT m.*,u.display_name AS actor_name FROM material_stock_movements m JOIN users u ON u.id=m.actor_id
        ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset));
      return reply({ items: (await mapRows(rows,async row => (await movementView(row)))), total, page, pageSize });
    }
    if (route === '/stock/opening/close' && method === 'POST') {
      requireMaterial(user, 'materials.stock.initialize');
      const reason = text(input.reason, '关闭原因', 1000);
      (await transaction(async () => { (await closeOpening()); (await log(user, 'CLOSE_OPENING', 'material_state', 0, reason)); }));
      return reply({ openingClosed: true });
    }
    if (['/stock/opening', '/stock/adjustments'].includes(route) && method === 'POST') {
      const isOpening = route === '/stock/opening';
      requireMaterial(user, isOpening ? 'materials.stock.initialize' : 'materials.stock.adjust');
      const result = (await idempotent(user, route, input, async key => {
        if (isOpening && (await openingClosed())) conflict('期初登记已经关闭，请使用有原因的库存调整');
        const master = (await (!isOpening && input.direction === 'decrease' ? catalog(input.catalogId) : activeCatalog(input.catalogId))), region = (await dictionary('material_regions', input.regionId, '区域'));
        const category = (await dictionary('material_categories', input.categoryId ?? master.category_id, '分类'));
        const target = warehouse(input.warehouse);
        const quantity = decimal(input.quantity, 3, '数量'), amount = decimal(input.amount, 2, '总金额', true);
        if (amount === 0 && isOpening) text(input.zeroAmountReason, '零金额原因', 1000);
        const reason = isOpening ? text(input.zeroAmountReason || '期初登记', '登记原因', 1000) : text(input.reason, '调整原因', 1000);
        const direction = isOpening || input.direction === 'increase' ? 1 : input.direction === 'decrease' ? -1 : 0;
        if (!direction) error(400, '调整方向须为increase或decrease');
        const snapshot = { catalogId: master.id, code: master.code, name: master.name, spec: master.spec, unit: master.unit,
          trackingMode: master.tracking_mode,
          categoryId: category.id, categoryName: category.name, regionId: region.id, regionName: region.name, warehouse: target };
        const movement = (await addMovement({ type: isOpening ? 'opening' : 'adjustment', catalog_id: master.id,
          region_id: region.id, warehouse: target, qty_m: direction * quantity, amount_cents: direction * amount,
          source_key: `${isOpening ? 'opening' : 'adjustment'}:${user.id}:${key}`, snapshot,
          batch: text(input.batch ?? '', '批号', 100, true), expiry_date: date(input.expiryDate, '有效期', true),
          date: date(input.date), reason, manufacturer: manufacturerText(input.manufacturer ?? ''), note: text(input.note ?? '', '批次备注', 2000, true) }, user, input));
        (await log(user, isOpening ? 'OPENING' : 'ADJUST', 'material_stock_movements', movement.id, reason));
        return { movement, openingClosed: (await openingClosed()) };
      }));
      return reply(result.value, result.status);
    }
    if ((match = route.match(/^\/(requests|receipts)\/(\d+)\/attachments$/))) {
      const isRequest = match[1] === 'requests', id = integer(match[2]);
      if (isRequest) (await request(id)); else (await checkedReceipt(id));
      if (method === 'GET') {
        if (!isRequest && !permit(user, 'materials.amount.read')) error(403, '验收附件需要金额读取权限');
        const column = isRequest ? 'request_id' : 'receipt_id';
        return reply({ items: (await all(`SELECT * FROM material_attachments WHERE ${column}=? AND active=1 ORDER BY id`, id)).map(attachmentView) });
      }
      if (method === 'POST') return reply((await saveAttachment(user, input, isRequest ? id : null, isRequest ? null : id)), 201);
    }
    if ((match = route.match(/^\/attachments\/(\d+)(\/download)?$/))) {
      const attachment = (await one('SELECT * FROM material_attachments WHERE id=?', integer(match[1])));
      if (!attachment) error(404, '附件不存在');
      if (method === 'GET' && match[2]) {
        if ((attachment.receipt_id || attachment.document_version_id) && !permit(user, 'materials.amount.read')) error(403, '验收附件需要金额读取权限');
        const file = attachmentPath(attachment.stored_name);
        if (!fs.existsSync(file)) error(404, '附件文件缺失');
        res.writeHead(200, { 'Content-Type': attachment.mime_type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
          'Content-Length': attachment.size, 'X-Content-Type-Options': 'nosniff' });
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
        return;
      }
      if (method === 'DELETE' && !match[2]) {
        if (!attachment.request_id) error(403, '已记账验收附件不能移除');
        const result = (await transaction(async () => {
          const order = (await request(attachment.request_id));
          versions(order, null, input);
          if (!mayHeader(order, user)) error(403, '无权修改申报附件');
          const reason = editReason(order, input), before = order.status === 'submitted' ? (await requestView(order.id, user, true)) : null;
          if (attachment.active) {
            (await run('UPDATE material_attachments SET active=0 WHERE id=?', attachment.id));
            (await bump(order.id));
            (await recordRevision(order, user, reason, before));
            (await log(user, 'REMOVE', 'material_attachments', attachment.id, reason));
          }
          return { request: (await requestView(order.id, user)) };
        }));
        return reply(result);
      }
    }
    if (route === '/backup' && method === 'GET') {
      const value = (await backup(user));
      res.setHeader('Content-Disposition', `attachment; filename="labos-materials-${today()}.json"`);
      return reply(value);
    }
    if (route === '/restore' && method === 'POST') return reply((await restore(input, user)));
    if (route === '/export.xlsx' && method === 'GET') return (await exportWorkbook(res, url, user));
    error(404, '物资接口不存在');
  }
  async function handle(req, res, url, user) {
    if (url.pathname !== '/api/materials' && !url.pathname.startsWith('/api/materials/')) return false;
    try {
      await dispatch(req, res, url, user);
    } catch (failure) {
      if (failure.status) throw failure;
      if (failure.code === '23505') error(409, '唯一编号或来源重复，操作未保存');
      if (['23503', '23514', '23502'].includes(failure.code)) error(400, '业务数据违反完整性约束，操作未保存');
      if (['40001', '40P01', '55P03'].includes(failure.code)) error(503, '数据库正在处理其他写入，请稍后重试原操作');
      console.error('Materials request failed', failure);
      error(500, '物资操作失败，未确认的写入请使用原请求号重试');
    }
    return true;
  }

  async function backup(user) {
    if (!permit(user, 'backup.read') || !permit(user, 'materials.amount.read')) error(403, '完整物资备份需要备份及金额读取权限');
    return transaction(async () => {
    const data = Object.fromEntries((await mapRows(TABLES,async table => [table, (await all(`SELECT * FROM ${table}${['material_state', 'material_idempotency', 'material_number_allocations'].includes(table) ? '' : ' ORDER BY id'}`))])));
    let totalBytes = 0;
    const files = data.material_attachments.map(row => {
      const file = attachmentPath(row.stored_name);
      if (!fs.existsSync(file)) error(409, `附件 ${row.id} 缺失，不能生成声称完整的物资备份`);
      const contents = fs.readFileSync(file);
      if (contents.length !== row.size) error(409, `附件 ${row.id} 大小不符，请先检查存储`);
      const digest = crypto.createHash('sha256').update(contents).digest('hex');
      if (row.sha256 && row.sha256 !== digest) error(409, `附件 ${row.id} 摘要不符，请先检查存储`);
      totalBytes = safeSum([totalBytes, contents.length]);
      if (totalBytes > BACKUP_LIMIT) error(413, '附件总量超过在线业务备份上限，请使用 scripts/backup-runtime.ps1 的 PostgreSQL＋附件一致性备份');
      return { id: row.id, content: contents.toString('base64'), sha256: digest };
    });
    const result = { type: 'labos-materials-backup', schemaVersion: 8, generatedAt: now(),
      users: (await all('SELECT id,username FROM users ORDER BY id')), data, files };
    if (Buffer.byteLength(JSON.stringify(result)) > 25 * 1024 * 1024) error(413, '业务JSON备份超过在线恢复上限，请使用 scripts/backup-runtime.ps1 的 PostgreSQL＋附件一致性备份');
    return result;
    });
  }
  function remapSnapshot(value, mapping) {
    const userKeys = new Set(['createdBy', 'submittedBy', 'authorId', 'actorId', 'userId', 'processedBy', 'postedBy', 'cancelledBy']);
    if (Array.isArray(value)) return value.map(entry => remapSnapshot(entry, mapping));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (userKeys.has(key) && entry !== null && entry !== undefined) {
        if (!mapping.has(entry)) error(400, '历史快照引用了未映射的用户');
        return [key, mapping.get(entry)];
      }
      return [key, remapSnapshot(entry, mapping)];
    }));
  }
  async function validateRestoredLedger() {
    for (const entry of await all('SELECT * FROM material_arrivals')) {
      const order = await request(entry.request_id);
      if (entry.request_revision < 1 || entry.request_revision > order.revision || !validTimestamp(entry.created_at)) error(400, '到货登记申报版本或时间无效');
      const receipts = await all('SELECT * FROM material_receipts WHERE arrival_id=?', entry.id);
      if (!receipts.length || receipts.some(row => !['acceptance', 'rejection'].includes(row.type) || row.request_id !== entry.request_id || row.request_revision !== entry.request_revision || row.actor_id !== entry.actor_id)) error(400, '到货登记与验收事件归属、版本或办理人不一致');
      const versions = await all('SELECT * FROM material_arrival_document_versions WHERE arrival_id=? ORDER BY version', entry.id);
      if (versions.length !== entry.document_version || versions.some((version, index) => version.version !== index + 1)) error(400, '到货清单当前指针或历史版本不连续');
      for (const version of versions) {
        if (!validTimestamp(version.created_at) || text(version.reason, '清单替换原因', 1000, version.version === 1) !== version.reason) error(400, '到货清单历史时间或原因无效');
        const files = await all('SELECT * FROM material_attachments WHERE document_version_id=?', version.id);
        if (!files.length || files.length > 10 || safeSum(files.map(file => file.size)) > 15 * 1024 * 1024 || files.some(file => file.active !== 1 || file.actor_id !== version.actor_id || !/^[a-f0-9]{64}$/.test(file.sha256))) error(400, '到货清单文件数量、总量、操作人或摘要无效');
      }
    }
    for (const event of await all('SELECT * FROM material_receipts')) {
      if (event.arrival_id && event.manufacturer_status === 'legacy') error(400, '新版到货验收不能缺少厂家核对依据');
      if (event.manufacturer_status !== 'legacy' && ['acceptance', 'reversal', 'rejection'].includes(event.type)) {
        const snapshot = JSON.parse(event.snapshot);
        if ((snapshot.manufacturer || '') !== event.expected_manufacturer) error(400, '验收预期厂家与原申报快照不一致');
        const checked = manufacturerCheck({ manufacturer: event.expected_manufacturer }, { manufacturer: event.manufacturer,
          manufacturerStatus: event.manufacturer_status, manufacturerReason: event.manufacturer_reason, differenceReason: event.difference_reason }, Math.abs(event.qty_m));
        if (checked.manufacturer !== event.manufacturer) error(400, '验收厂家未规范化');
      }
    }
    for (const row of (await all('SELECT * FROM material_catalog'))) {
      trackingMode(row.tracking_mode);
      if (![0, 1].includes(row.active) || !['manual', 'receipt'].includes(row.origin) || text(row.remark, '物资备注', 2000, true) !== row.remark || row.merged_into === row.id) error(400, '物资信息状态、来源、备注或合并归属无效');
    }
    for (const row of (await all('SELECT * FROM material_request_items'))) {
      if (text(row.manufacturer, '厂家', 200, true) !== row.manufacturer) error(400, '申报厂家字段无效');
      if (row.catalog_id !== null) unitQuantity((await catalog(row.catalog_id)), row.qty_m, '申报数量');
    }
    for (const row of (await all('SELECT * FROM material_barcodes'))) {
      if (packageBarcode(row.code) !== row.code) error(400, '条码内容未规范化');
      (await catalog(row.catalog_id));
    }
    if (!(await openingClosed()) && (await one("SELECT 1 FROM material_receipts WHERE type='acceptance' LIMIT 1"))) {
      error(400, '存在合格验收历史时不能恢复为开放期初');
    }
    const openingMovements = new Set();
    for (const document of (await all('SELECT * FROM material_openings'))) {
      if (text(document.title, '单据主题', 200) !== document.title || date(document.date) !== document.date ||
          text(document.description, '单据说明', 2000, true) !== document.description ||
          !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(document.no) || !validTimestamp(document.created_at)) error(400, '期初或补录单信息无效');
      text(document.reason, '补录原因', 1000, document.kind === 'opening');
      if (document.kind === 'supplement' && !(await openingClosed())) error(400, '存在补录单时期初必须已关闭');
      if (document.status === 'posted' && (!validTimestamp(document.posted_at) || document.posted_at < document.created_at || document.version < 2)) error(400, '已入库单据处理信息无效');
      const lines = (await all('SELECT * FROM material_opening_items WHERE opening_id=?', document.id));
      if (lines.length > 5000 || (document.status === 'posted' && !lines.length)) error(400, '期初或补录单明细数量无效');
      const count = safeSum(await mapRows(lines,async row => (await catalog(row.catalog_id)).tracking_mode === 'unit' ? row.qty_m / 1000 : 0));
      if (document.status === 'posted' && count > 1000) error(400, '已入库单据的单件数量超限');
      for (const row of lines) {
        const master = (await catalog(row.catalog_id)), snapshot = JSON.parse(row.snapshot);
        if ((Object.hasOwn(snapshot, 'manufacturer') && text(snapshot.manufacturer, '厂家', 200, true) !== snapshot.manufacturer) ||
            (Object.hasOwn(snapshot, 'note') && text(snapshot.note, '批次备注', 2000, true) !== snapshot.note)) error(400, '期初或补录厂家、备注无效');
        unitQuantity(master, row.qty_m, '期初数量', 1000); warehouse(row.warehouse);
        if (text(row.batch, '批号', 100, true) !== row.batch || date(row.expiry_date, '有效期', true) !== row.expiry_date ||
            text(row.location, '存放位置', 200, true) !== row.location || row.location_version < 0 ||
            snapshot.catalogId !== row.catalog_id || snapshot.regionId !== row.region_id || snapshot.warehouse !== row.warehouse ||
            snapshot.location !== row.location || !['unit', 'quantity'].includes(snapshot.trackingMode)) error(400, '期初或补录明细身份或位置无效');
        text(row.zero_amount_reason, '零金额原因', 1000, row.amount_cents > 0);
        if (document.status === 'draft') {
          if (row.movement_id !== null) error(400, '草稿不能包含库存流水');
        } else {
          const movement = (await one('SELECT * FROM material_stock_movements WHERE id=?', row.movement_id));
          const reason = document.kind === 'supplement' ? `${document.no} 补录：${document.reason}` : `${document.no} 期初登记${row.zero_amount_reason ? `：${row.zero_amount_reason}` : ''}`;
          if (!movement || openingMovements.has(movement.id) || movement.type !== (document.kind === 'supplement' ? 'adjustment' : 'opening') ||
              identityArgs(movement).some((value, index) => value !== identityArgs(row)[index]) || movement.qty_m !== row.qty_m ||
              movement.amount_cents !== row.amount_cents || movement.source_key !== `opening-doc:${document.id}:${row.id}` ||
              movement.manufacturer !== (snapshot.manufacturer || '') || movement.note !== (snapshot.note || '') ||
              movement.reason !== reason || movement.date !== document.date || movement.actor_id !== document.posted_by ||
              stableJson(JSON.parse(movement.snapshot)) !== stableJson(snapshot)) error(400, '期初或补录单与库存来源流水无法对账');
          openingMovements.add(movement.id);
        }
      }
    }
    for (const order of (await all('SELECT * FROM material_requests'))) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(order.no)) error(400, '申报单号无效');
      if (['submitted', 'cancelled'].includes(order.status)) {
        if (!order.original_snapshot || !order.submitted_by || !validTimestamp(order.submitted_at) || order.revision < 1) error(400, '已提交单缺少原始提交信息');
        const original = JSON.parse(order.original_snapshot);
        if (original.id !== order.id || original.revision !== 1 || original.status !== 'submitted') error(400, '原提交快照无效');
        const revisions = (await all('SELECT revision FROM material_request_revisions WHERE request_id=? ORDER BY revision', order.id));
        if (revisions.length !== order.revision - 1 || revisions.some((entry, index) => entry.revision !== index + 2)) error(400, '申报修订历史不连续');
      } else if (order.revision !== 0 || order.original_snapshot) error(400, '草稿不能包含已提交快照');
      if (order.status === 'cancelled') {
        if (!order.cancelled_by || !validTimestamp(order.cancelled_at) || order.cancelled_at < order.submitted_at ||
            order.version < 3 || text(order.cancel_reason, '取消原因', 1000) !== order.cancel_reason) error(400, '申报取消信息无效');
      } else if (order.cancelled_by !== null || order.cancelled_at !== null || order.cancel_reason !== '') error(400, '未取消申报不能包含取消信息');
      for (const line of (await all('SELECT * FROM material_request_items WHERE request_id=?', order.id))) {
        const counts = (await activity(line.id));
        if (counts.accepted < 0 || counts.closed < 0 || safeSum([counts.accepted, counts.closed]) > line.qty_m) error(400, '验收、结案数量与申报数量不一致');
        if (counts.exists && order.status !== 'submitted') error(400, '草稿或已取消申报不能有验收事件');
      }
    }
    for (const event of (await all('SELECT * FROM material_receipts'))) {
      if (text(event.manufacturer, '厂家', 200, true) !== event.manufacturer || text(event.note, '批次备注', 2000, true) !== event.note) error(400, '验收厂家、备注无效');
      const order = (await request(event.request_id)), line = (await item(order.id, event.item_id)), snapshot = JSON.parse(event.snapshot);
      const master = (await catalog(line.catalog_id));
      for (const quantity of [event.qty_m, event.rejected_qty_m, event.closed_qty_m]) unitQuantity(master, Math.abs(quantity), '验收数量');
      if (event.request_revision < 1 || event.request_revision > order.revision || !Number.isSafeInteger(event.request_revision)) error(400, '验收引用的申报修订号无效');
      if (snapshot.catalogId !== line.catalog_id || snapshot.regionId !== line.region_id || snapshot.warehouse !== line.warehouse || snapshot.unit !== line.unit) error(400, '历史验收物资身份与受保护申报行不一致');
      if (event.type === 'acceptance' || event.type === 'reversal') {
        const rows = (await all('SELECT * FROM material_stock_movements WHERE receipt_id=?', event.id));
        if (rows.length !== 1 || rows[0].qty_m !== event.qty_m || rows[0].amount_cents !== event.amount_cents) error(400, '验收与库存来源流水无法对账');
        const movement = rows[0];
        if (movement.catalog_id !== snapshot.catalogId || movement.region_id !== snapshot.regionId || movement.warehouse !== snapshot.warehouse ||
          movement.batch !== event.batch || movement.expiry_date !== event.expiry_date ||
          movement.manufacturer !== event.manufacturer || movement.note !== event.note ||
          movement.type !== (event.type === 'acceptance' ? 'receipt' : 'reversal')) error(400, '验收流水归属或批次不一致');
      } else if ((await one('SELECT 1 FROM material_stock_movements WHERE receipt_id=?', event.id))) error(400, '拒收或结案不能产生入库流水');
      if (event.type === 'reversal') {
        const original = (await checkedReceipt(event.original_receipt_id));
        if (original.type !== 'acceptance' || original.item_id !== event.item_id || original.request_id !== event.request_id ||
          original.qty_m !== -event.qty_m || original.amount_cents !== -event.amount_cents ||
          original.manufacturer !== event.manufacturer || original.note !== event.note) error(400, '冲正没有精确对应原验收');
      }
    }
    for (const row of (await all('SELECT * FROM material_stock_locations'))) {
      warehouse(row.warehouse);
      if (text(row.batch, '批号', 100, true) !== row.batch || date(row.expiry_date, '有效期', true) !== row.expiry_date ||
          text(row.location, '库存位置', 200, true) !== row.location || row.version < 1) error(400, '库存位置数据无效');
      text(row.reason, '位置修改原因', 1000);
      if (!(await batchBalance(row)).movements.length) error(400, '库存位置没有对应的批次流水');
      if (!validTimestamp(row.updated_at)) error(400, '库存位置时间无效');
    }
    for (const row of (await all('SELECT * FROM material_issues'))) {
      unitQuantity((await catalog(row.catalog_id)), row.qty_m, '领用数量', 1000);
      warehouse(row.warehouse);
      if (text(row.batch, '批号', 100, true) !== row.batch || date(row.expiry_date, '有效期', true) !== row.expiry_date ||
          row.qty_m <= 0 || row.amount_cents < 0 || !validTimestamp(row.created_at)) error(400, '领用数量、批次或时间无效');
      text(row.purpose, '领用用途', 1000);
      const snapshot = JSON.parse(row.snapshot);
      if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object' || snapshot.catalogId !== row.catalog_id ||
          snapshot.regionId !== row.region_id || snapshot.warehouse !== row.warehouse || snapshot.batch !== row.batch ||
          snapshot.expiryDate !== row.expiry_date || snapshot.createdBy !== row.created_by) error(400, '领用申请快照身份无效');
      for (const key of ['code', 'name', 'spec', 'unit', 'categoryName', 'regionName']) text(snapshot[key], '领用快照物资信息', 200);
      (await dictionary('material_categories', snapshot.categoryId, '快照分类'));
      text(snapshot.location, '申请时位置', 200, true);
      const movements = (await all("SELECT * FROM material_stock_movements WHERE source_key=?", `issue:${row.id}`));
      if (row.status === 'pending') {
        if (row.version !== 1 || row.processed_by !== null || row.processed_at !== null || row.reason !== '' || row.amount_cents !== 0 || movements.length) error(400, '待发放申请不能包含处理或库存记录');
      } else {
        if (row.version !== 2 || row.processed_by === null || !validTimestamp(row.processed_at) || row.processed_at < row.created_at) error(400, '领用处理信息无效');
        if (row.status === 'issued') {
          if (row.reason !== '' || movements.length !== 1) error(400, '发放申请缺少唯一来源流水');
          const movement = movements[0], saved = JSON.parse(movement.snapshot), { manufacturerAllocations: ignored, ...identitySnapshot } = saved;
          if (movement.type !== 'issue' || movement.qty_m !== -row.qty_m || movement.amount_cents !== -row.amount_cents ||
              movement.catalog_id !== row.catalog_id || movement.region_id !== row.region_id || movement.warehouse !== row.warehouse ||
              movement.batch !== row.batch || movement.expiry_date !== row.expiry_date || movement.actor_id !== row.processed_by ||
              movement.date !== row.processed_at.slice(0, 10) || stableJson({ ...identitySnapshot, location: snapshot.location }) !== stableJson(snapshot)) error(400, '领用申请与发放流水无法对账');
          text(saved.location, '发放时位置', 200, true);
        } else {
          if (!['rejected', 'cancelled'].includes(row.status) || movements.length || row.amount_cents !== 0 ||
              (row.status === 'cancelled' && row.processed_by !== row.created_by)) error(400, '取消或驳回申请不能产生库存流水');
          text(row.reason, '处理原因', 1000);
        }
      }
    }
    const batches = new Map();
    for (const row of (await all('SELECT * FROM material_stock_movements ORDER BY id'))) {
      const master = (await catalog(row.catalog_id));
      unitQuantity(master, Math.abs(row.qty_m), '库存数量', 1000);
      warehouse(row.warehouse);
      if (text(row.manufacturer, '厂家', 200, true) !== row.manufacturer || text(row.note, '批次备注', 2000, true) !== row.note) error(400, '库存厂家、备注无效');
      const snapshot = JSON.parse(row.snapshot);
      if (!snapshot || snapshot.catalogId !== row.catalog_id || snapshot.regionId !== row.region_id || snapshot.warehouse !== row.warehouse) error(400, '库存快照与流水归属不一致');
      if ((snapshot.trackingMode ?? 'quantity') !== master.tracking_mode) error(400, '库存快照与单件管理方式不一致');
      if (['receipt', 'reversal'].includes(row.type) !== Boolean(row.receipt_id)) error(400, '库存来源引用无效');
      if (row.receipt_id && row.source_key !== `receipt:${row.receipt_id}`) error(400, '验收库存来源键无效');
      if (row.source_key.startsWith('opening-doc:') && !openingMovements.has(row.id)) error(400, '期初或补录来源缺少已入库单据');
      const key = JSON.stringify([row.catalog_id, row.region_id, row.warehouse, row.batch, row.expiry_date]);
      const previous = batches.get(key) || { qty: 0, amount: 0 };
      if (row.type === 'issue') {
        const match = row.source_key.match(/^issue:([1-9]\d*)$/), issue = match && (await one('SELECT * FROM material_issues WHERE id=?', Number(match[1])));
        if (!issue || issue.status !== 'issued' || row.qty_m >= 0 || -row.qty_m > previous.qty || previous.qty <= 0 ||
            row.amount_cents !== -issueAmount(-row.qty_m, previous)) error(400, '领用流水缺少申请或成本分摊不一致');
      } else if (row.source_key.startsWith('issue:')) error(400, '非领用流水不能占用领用来源');
      const qty = safeSum([previous.qty, row.qty_m]), amount = safeSum([previous.amount, row.amount_cents]);
      if (qty < 0 || amount < 0) error(400, '备份存在负库存或无来源冲减');
      batches.set(key, { qty, amount });
    }
    const unitRows = (await all('SELECT * FROM material_stock_units ORDER BY sequence')), unitCounts = new Map();
    for (const [index, row] of unitRows.entries()) {
      if (!/^[A-Za-z0-9._/-]{1,128}$/.test(row.code) || row.sequence !== index + 1 || !validTimestamp(row.created_at) ||
          (await catalog(row.catalog_id)).tracking_mode !== 'unit' || (await one('SELECT 1 FROM material_barcodes WHERE code=?', row.code))) error(400, '单件编号、全局序号、时间或管理方式无效');
      const source = (await one('SELECT * FROM material_stock_movements WHERE id=?', row.source_movement_id));
      if (!source || source.qty_m <= 0 || !['opening', 'receipt', 'adjustment'].includes(source.type) || source.actor_id !== row.created_by ||
          identityArgs(row).some((value, part) => value !== identityArgs(source)[part])) error(400, '单件缺少一致的正向入库来源');
      unitCounts.set(source.id, (unitCounts.get(source.id) || 0) + 1);
      if (row.status !== 'in_stock') {
        const exit = (await one('SELECT * FROM material_stock_movements WHERE id=?', row.exit_movement_id));
        if (!exit || exit.id <= source.id || exit.qty_m >= 0 || !['issue', 'adjustment', 'reversal'].includes(exit.type) ||
            identityArgs(row).some((value, part) => value !== identityArgs(exit)[part]) ||
            row.status !== (exit.type === 'issue' ? 'issued' : 'void')) error(400, '单件退出状态与负向流水不一致');
        if (exit.type === 'reversal') {
          const reversal = (await checkedReceipt(exit.receipt_id));
          if (source.type !== 'receipt' || reversal.original_receipt_id !== source.receipt_id) error(400, '冲正单件不是原验收来源');
        }
        unitCounts.set(exit.id, (unitCounts.get(exit.id) || 0) + 1);
      } else if (row.exit_movement_id !== null) error(400, '在库单件不能有退出流水');
    }
    for (const row of (await all('SELECT * FROM material_stock_movements'))) {
      if ((await catalog(row.catalog_id)).tracking_mode === 'unit' && (unitCounts.get(row.id) || 0) !== Math.abs(row.qty_m) / 1000) error(400, '单件数量与库存来源流水不一致');
    }
    for (const row of (await all(`SELECT catalog_id,region_id,warehouse,batch,expiry_date,COUNT(*) AS total FROM material_stock_units
      WHERE status='in_stock' GROUP BY catalog_id,region_id,warehouse,batch,expiry_date`))) {
      if (row.total * 1000 !== (await batchBalance(row)).qty) error(400, '在库单件与批次余额不一致');
    }
    const sequence = (await one("SELECT value FROM material_state WHERE key='unit_sequence'"))?.value;
    if (!/^(?:0|[1-9]\d*)$/.test(sequence || '') || !Number.isSafeInteger(Number(sequence)) || Number(sequence) >= Number.MAX_SAFE_INTEGER || Number(sequence) !== unitRows.length) error(400, '单件全局序号与历史编号不一致');
    let rule;
    try { rule = JSON.parse((await one("SELECT value FROM material_state WHERE key='unit_label_rule'"))?.value); } catch { error(400, '单件编号规则无效'); }
    validateUnitRule(rule);
    if (Object.keys(rule).length !== 6 || !['template', 'padding', 'version', 'actorId', 'updatedAt', 'reason'].every(key => Object.hasOwn(rule, key)) ||
        !Number.isSafeInteger(rule.version) || rule.version < 1) error(400, '单件编号规则字段或版本无效');
    if (rule.version === 1) {
      if (stableJson(rule) !== stableJson(defaultUnitRule)) error(400, '初始单件编号规则无效');
    } else {
      integer(rule.actorId, '规则操作人'); if (!(await one('SELECT 1 FROM users WHERE id=?', rule.actorId)) || !validTimestamp(rule.updatedAt)) error(400, '单件编号规则操作人或时间无效');
      text(rule.reason, '规则修改原因', 1000);
    }
    const historicalNumberCodes = new Set();
    for (const kind of Object.keys(numberKinds)) {
      const saved = await one('SELECT value FROM material_state WHERE key=?', 'number_rule_' + kind);
      const current = saved && JSON.parse(saved.value);
      validateNumberRule(current);
      if (Object.keys(current).length !== 6 || !['template', 'padding', 'version', 'actorId', 'updatedAt', 'reason'].every(key => Object.hasOwn(current, key)) ||
          !Number.isSafeInteger(current.version) || current.version < 1) error(400, '编号规则字段或版本无效');
      if (current.version === 1) {
        if (stableJson(current) !== stableJson(defaultNumberRule(kind))) error(400, '初始编号规则无效');
      } else {
        if (!(await one('SELECT 1 FROM users WHERE id=?', integer(current.actorId, '规则操作人'))) || !validTimestamp(current.updatedAt)) error(400, '编号规则操作人或时间无效');
        text(current.reason, '编号规则修改原因', 1000);
      }
      const value = (await one('SELECT value FROM material_state WHERE key=?', 'number_sequence_' + kind))?.value;
      if (!/^(?:0|[1-9]\d*)$/.test(value || '') || !Number.isSafeInteger(Number(value)) || Number(value) >= Number.MAX_SAFE_INTEGER) error(400, '编号流水状态无效');
      const allocations = await all('SELECT * FROM material_number_allocations WHERE kind=?', kind);
      if (Number(value) !== allocations.reduce((maximum, row) => Math.max(maximum, row.sequence), 0)) error(400, '编号流水与最后一笔分配历史不一致');
      for (const allocated of allocations) {
        if (allocated.sequence > Number(value) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(allocated.code) || !validTimestamp(allocated.created_at)) error(400, '编号分配历史与流水状态不一致');
        const key = `${['opening', 'supplement'].includes(kind) ? 'opening' : kind}:${allocated.code.toUpperCase()}`;
        if (historicalNumberCodes.has(key)) error(400, '编号分配历史在同一编号域内重复');
        historicalNumberCodes.add(key);
      }
    }
    await lab.validateBackup(Object.fromEntries(await mapRows(['material_categories', 'material_catalog', 'material_storage_places'], async table => [table, await all(`SELECT * FROM ${table}`)])));
    (await stockRows());
    (await stockDetails());
    // PostgreSQL checks all business foreign keys during insertion.
  }
  function validTimestamp(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }
  async function restore(payload, user) {
    if (!permit(user, 'backup.restore') || !permit(user, 'materials.amount.read')) error(403, '完整物资恢复需要恢复及金额读取权限');
    const topKeys = ['type', 'schemaVersion', 'generatedAt', 'users', 'data', 'files'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some(key => !topKeys.includes(key)) || topKeys.some(key => !Object.hasOwn(payload, key)) ||
        payload.type !== 'labos-materials-backup' || ![1, 2, 3, 4, 5, 6, 7, 8].includes(payload.schemaVersion) || !payload.data ||
        typeof payload.data !== 'object' || Array.isArray(payload.data) ||
        !Array.isArray(payload.users) || !Array.isArray(payload.files)) error(400, '无效的完整物资备份格式');
    const sourceTables = payload.schemaVersion === 1 ? V1_TABLES : payload.schemaVersion === 2 ? V2_TABLES : payload.schemaVersion === 3 ? V3_TABLES : payload.schemaVersion === 4 ? V4_TABLES : payload.schemaVersion < 7 ? V6_TABLES : payload.schemaVersion === 7 ? V7_TABLES : TABLES;
    if (sourceTables.some(table => !Array.isArray(payload.data[table])) ||
        Object.keys(payload.data).some(key => !sourceTables.includes(key))) error(400, '备份业务表无效');
    if (typeof payload.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.generatedAt) ||
        !Number.isFinite(Date.parse(payload.generatedAt)) || new Date(payload.generatedAt).toISOString() !== payload.generatedAt) error(400, '备份生成时间无效');
    if (Buffer.byteLength(JSON.stringify(payload)) > 25 * 1024 * 1024) error(413, '在线恢复上限为25 MiB，请使用完整运行目录恢复');
    const mapping = new Map(), usernames = new Set();
    for (const source of payload.users) {
      if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length !== 2 ||
          !Object.hasOwn(source, 'id') || !Object.hasOwn(source, 'username') || !Number.isSafeInteger(source.id)) error(400, '备份用户映射字段无效');
      const id = integer(source?.id, '备份用户ID'), username = text(source?.username, '备份用户账号', 200);
      if (mapping.has(id) || usernames.has(username)) error(400, '备份用户映射重复');
      const current = (await one('SELECT id FROM users WHERE username=?', username));
      if (!current) error(400, `请先创建备份中的账号：${username}`);
      mapping.set(id, current.id);
      usernames.add(username);
    }
    const userColumns = new Set(['created_by', 'submitted_by', 'author_id', 'actor_id', 'processed_by', 'posted_by', 'cancelled_by']);
    const jsonColumns = new Set(['original_snapshot', 'before_snapshot', 'after_snapshot', 'snapshot', 'response']);
    const normalized = {};
    for (const table of TABLES) {
      const columns = await db.columns(table);
      const allowed = new Map(columns.map(column => [column.name, column]));
      normalized[table] = (payload.data[table] || []).map(source => {
        if (payload.schemaVersion < 8 && source && typeof source === 'object') {
          const added = { material_receipts: { arrival_id: null, expected_manufacturer: '', manufacturer_status: 'legacy', manufacturer_reason: '', difference_reason: '' },
            material_attachments: { document_version_id: null, sha256: '' } }[table];
          if (added) {
            if (Object.keys(added).some(key => Object.hasOwn(source, key))) error(400, '旧版备份不能包含新版到货字段');
            source = { ...source, ...added };
          }
        }
        if (payload.schemaVersion < 7 && source && typeof source === 'object') {
          const added = { material_categories: { profile: 'general', version: 1 },
            material_catalog: { active: 1, cas_number: '', purity: '', storage_conditions: '', sds_url: '' },
            material_requests: { cancelled_by: null, cancelled_at: null, cancel_reason: '' } }[table];
          if (added) {
            if (Object.keys(added).some(key => Object.hasOwn(source, key))) error(400, '旧版备份不能包含新版维护字段');
            source = { ...source, ...added };
          }
        }
        if (payload.schemaVersion < 6 && source && typeof source === 'object') {
          const added = { material_catalog: { remark: '', origin: 'manual', merged_into: null }, material_request_items: { manufacturer: '' },
            material_receipts: { manufacturer: '', note: '' }, material_stock_movements: { manufacturer: '', note: '' } }[table];
          if (added) {
            if (Object.keys(added).some(key => Object.hasOwn(source, key))) error(400, '旧版备份不能包含新版物资字段');
            source = { ...source, ...added };
          }
        }
        if (payload.schemaVersion < 4 && table === 'material_catalog' && source && typeof source === 'object') {
          if (Object.hasOwn(source, 'tracking_mode')) error(400, '旧版备份不能包含新版管理方式字段');
          source = { ...source, tracking_mode: 'quantity' };
        }
        if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !allowed.has(key)) || columns.some(column => !Object.hasOwn(source, column.name))) error(400, `备份表 ${table} 字段无效`);
        if (table === 'material_state' && typeof source.key !== 'string') error(400, '备份物资状态键必须为文本');
        const row = {};
        for (const [key, value] of Object.entries(source)) {
          const type = allowed.get(key).type;
          if (value !== null && (type === 'INTEGER' ? !Number.isSafeInteger(value) : typeof value !== 'string')) error(400, `备份表 ${table} 字段类型无效`);
          if (value !== null && (key === 'id' || key.endsWith('_id')) && value <= 0) error(400, '备份业务ID必须为正整数');
          if (userColumns.has(key) && value !== null) {
            if (!mapping.has(value)) error(400, '备份业务数据引用了未映射用户');
            row[key] = mapping.get(value);
          } else if ((jsonColumns.has(key) || (table === 'material_state' && (source.key === 'unit_label_rule' || source.key.startsWith('number_rule_')) && key === 'value')) && value !== null) {
            let parsed;
            try { parsed = JSON.parse(value); } catch { error(400, '备份快照JSON无效'); }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) error(400, '备份快照必须是对象');
            row[key] = JSON.stringify(remapSnapshot(parsed, mapping));
          } else row[key] = value;
        }
        return row;
      });
    }
    if (payload.schemaVersion < 4) {
      if (normalized.material_state.some(row => !['opening_closed', 'restored_once'].includes(row.key))) error(400, '旧版备份包含新版状态');
      normalized.material_state.push({ key: 'unit_label_rule', value: JSON.stringify(defaultUnitRule) }, { key: 'unit_sequence', value: '0' });
    }
    const numberKeys = Object.keys(numberKinds).flatMap(kind => ['number_rule_' + kind, 'number_sequence_' + kind]);
    if (payload.schemaVersion < 7) {
      if (normalized.material_state.some(row => numberKeys.includes(row.key))) error(400, '旧版备份不能包含新版编号状态');
      for (const kind of Object.keys(numberKinds)) normalized.material_state.push({ key: 'number_rule_' + kind, value: JSON.stringify(defaultNumberRule(kind)) }, { key: 'number_sequence_' + kind, value: '0' });
    }
    if (normalized.material_state.some(row => !['opening_closed', 'restored_once', 'unit_label_rule', 'unit_sequence', ...numberKeys].includes(row.key) ||
        (['opening_closed', 'restored_once'].includes(row.key) && !['0', '1'].includes(row.value))) ||
        numberKeys.some(key => normalized.material_state.filter(row => row.key === key).length !== 1) ||
        normalized.material_state.filter(row => row.key === 'unit_label_rule').length !== 1 || normalized.material_state.filter(row => row.key === 'unit_sequence').length !== 1 ||
        normalized.material_state.filter(row => row.key === 'opening_closed').length !== 1) error(400, '备份期初状态无效');
    await lab.validateBackup(normalized);
    const barcodeCodes = new Set();
    for (const row of normalized.material_barcodes) {
      if (packageBarcode(row.code) !== row.code || barcodeCodes.has(row.code)) error(400, '备份条码未规范化或存在重复绑定');
      barcodeCodes.add(row.code);
    }
    const unitCodes = new Set(), unitSequences = new Set(), unitIds = new Set();
    for (const row of normalized.material_stock_units) {
      if (!/^[A-Za-z0-9._/-]{1,128}$/.test(row.code) || unitCodes.has(row.code) || barcodeCodes.has(row.code) ||
          unitSequences.has(row.sequence) || unitIds.has(row.id)) error(400, '备份单件编号、序号或身份重复或无效');
      unitCodes.add(row.code); unitSequences.add(row.sequence); unitIds.add(row.id);
    }
    const contents = new Map();
    let byteCount = 0;
    for (const file of payload.files) {
      if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).length !== 3 ||
          !['id', 'content', 'sha256'].every(key => Object.hasOwn(file, key)) || !Number.isSafeInteger(file.id) || file.id <= 0 ||
          typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) error(400, '备份附件字段无效');
      if (contents.has(file.id)) error(400, '备份附件内容重复');
      const attachment = normalized.material_attachments.find(row => row.id === file.id);
      if (!attachment) error(400, '备份附件缺少元数据');
      const parsed = attachmentInput({ name: attachment.name, mimeType: attachment.mime_type, content: file.content });
      if (parsed.content.length !== attachment.size || crypto.createHash('sha256').update(parsed.content).digest('hex') !== file.sha256) error(400, '备份附件摘要或大小不符');
      if (attachment.sha256 && attachment.sha256 !== file.sha256) error(400, '备份附件元数据摘要不符');
      if (attachment.document_version_id) deliveryFile({ name: attachment.name, mimeType: attachment.mime_type, content: file.content });
      byteCount = safeSum([byteCount, parsed.content.length]);
      if (byteCount > BACKUP_LIMIT) error(413, '附件内容超过在线恢复上限');
      contents.set(file.id, parsed.content);
    }
    if (contents.size !== normalized.material_attachments.length) error(400, '完整备份缺少附件内容');
    const written = [];
    normalized.material_receipts.sort((left, right) => Number(left.type === 'reversal') - Number(right.type === 'reversal') || left.id - right.id);
    try {
      return (await transaction(async () => {
        const existing = await mapRows(TABLES.filter(table => table !== 'material_state'),table => one(`SELECT 1 FROM ${table} LIMIT 1`));
        if (existing.some(Boolean) ||
            (await openingClosed()) || (await one("SELECT 1 FROM material_state WHERE key='restored_once'"))) conflict('只能恢复到空的新物资业务库，禁止追加或重复恢复');
        (await run('DELETE FROM material_state'));
        for (const table of TABLES) {
          for (const originalRow of normalized[table]) {
            const row = { ...originalRow };
            if (table === 'material_attachments') {
              row.stored_name = crypto.randomUUID() + '.bin';
              const destination = attachmentPath(row.stored_name);
              fs.mkdirSync(path.dirname(destination), { recursive: true });
              fs.writeFileSync(destination, contents.get(row.id), { flag: 'wx', mode: 0o600 });
              db.afterRollback(() => fs.rmSync(destination, { force: true }));
              written.push(destination);
            }
            const keys = Object.keys(row);
            (await run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(key => row[key])));
          }
        }
        await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
        (await db.resetSequences());
        (await validateRestoredLedger());
        (await run("INSERT INTO material_state(key,value) VALUES('restored_once','1') ON CONFLICT(key) DO UPDATE SET value='1'"));
        (await log(user, 'RESTORE', 'material_backup', 0, '恢复完整物资业务备份'));
        return { restored: true, counts: Object.fromEntries(TABLES.map(table => [table, normalized[table].length])) };
      }));
    } catch (failure) {
      for (const file of written) {
        try { fs.unlinkSync(file); } catch (cleanupFailure) { if (cleanupFailure.code !== 'ENOENT') console.error('Cannot remove failed materials restore file'); }
      }
      throw failure;
    }
  }
  const decimalText = (value, digits) => `${Math.floor(value / (10 ** digits))}.${String(value % (10 ** digits)).padStart(digits, '0')}`;
  const warehouseName = code => WAREHOUSES.find(row => row.code === code)?.name || code;
  const statusName = value => ({ draft: '草稿', submitted: '已提交', posted: '已入库', pending: '待发放', issued: '已发放', rejected: '已驳回', cancelled: '已取消' })[value] || value || '';
  const receiptTypeName = value => ({ acceptance: '合格验收', rejection: '拒收', close: '差缺结案', reversal: '验收冲正' })[value] || value || '';
  const instructions = rows => sheet('填写说明', ['说明'], [[`模板版本 ${TEMPLATE_VERSION}`], ...rows.map(value => [value])]);
  async function workbookReferences(sheets, openingSheet, selected = []) {
    const options = (preferred, rows, key) => {
      const unique = [...new Map([...preferred, ...rows].map(row => [key(row), row])).values()];
      return { rows: unique.slice(0, 5000), complete: rows.length <= 5000 && unique.length <= 5000 };
    };
    const masters = options(selected, await all('SELECT name,spec,unit FROM material_catalog WHERE merged_into IS NULL AND active=1 ORDER BY name,spec,unit LIMIT 5001'), materialKey);
    const categories = !openingSheet ? options(selected.filter(row => row.categoryName).map(row => ({ name: row.categoryName })), await all('SELECT name FROM material_categories ORDER BY name LIMIT 5001'), row => normalized(row.name)) : null;
    const regions = openingSheet ? options(selected.filter(row => row.regionName).map(row => ({ name: row.regionName })), await all('SELECT name FROM material_regions ORDER BY name LIMIT 5001'), row => normalized(row.name)) : null;
    sheets.push(sheet('物资参考', ['物资名称', '规格', '单位'], masters.rows.map(row => [row.name, row.spec, row.unit])));
    sheets[0].referenceLists = Object.fromEntries(['A', 'B', 'C'].map(column => [column, { sheet: '物资参考', column, count: masters.rows.length, strict: openingSheet && masters.complete }]));
    if (openingSheet) {
      sheets.push(sheet('区域参考', ['区域'], regions.rows.map(row => [row.name])), sheet('仓库参考', ['仓库'], WAREHOUSES.map(row => [row.name])));
      Object.assign(sheets[0].referenceLists, { D: { sheet: '区域参考', column: 'A', count: regions.rows.length, strict: regions.complete }, E: { sheet: '仓库参考', column: 'A', count: WAREHOUSES.length, strict: true } });
      const manufacturers = options(selected.filter(row => row.manufacturer), await all("SELECT DISTINCT manufacturer FROM material_stock_movements WHERE manufacturer<>'' ORDER BY manufacturer LIMIT 5001"), row => row.manufacturer);
      sheets.push(sheet('厂家参考', ['厂家'], manufacturers.rows.map(row => [row.manufacturer])));
      const manufacturerColumn = sheets[0].data[0].findIndex(cell => cell.value === '厂家');
      if (manufacturerColumn >= 0) sheets[0].referenceLists[excelColumn(manufacturerColumn)] = { sheet: '厂家参考', column: 'A', count: manufacturers.rows.length, strict: false };
    } else {
      sheets.push(sheet('分类参考', ['物资分类'], categories.rows.map(row => [row.name])), sheet('管理方式参考', ['管理方式'], [['逐件'], ['数量']]));
      Object.assign(sheets[0].referenceLists, { D: { sheet: '分类参考', column: 'A', count: categories.rows.length, strict: categories.complete }, E: { sheet: '管理方式参考', column: 'A', count: 2, strict: true } });
    }
    sheets.push(sheet('引用说明', ['说明'], [['引用下拉最多列出5000个选项，并优先包含本次导出数据。选项较多时可手填已存在的中文名称、规格或单位，导入仍须通过服务端精确校验。']]));
  }
  async function catalogWorkbook(res, url, user, template) {
    if (!permit(user, 'materials.export')) error(403, '没有物资Excel导出权限');
    const rows = template ? [] : await catalogRows(url);
    if (rows.length > 5000) error(413, '一次最多导出5000条物资信息，请缩小筛选范围');
    const sheets = [sheet('物资信息', CATALOG_HEADERS, rows.map(row => [row.name, row.spec, row.unit, row.categoryName, row.trackingMode === 'unit' ? '逐件' : '数量', row.remark, row.casNumber, row.purity, row.storageConditions, row.sdsUrl]))];
    await workbookReferences(sheets, false, rows);
    sheets.push(instructions([
      '用途：物资信息页用于导入物资信息库，不改变库存；导出文件可原样回导。数据从第2行开始，保留第1行中文表头及列顺序，勿增加合计行。内部编码由系统生成，无需填写。',
      '物资名称、规格、单位（必填）：分别最多200、200、30字；可参考下拉或填写新物资，名称＋规格＋单位共同识别一条物资信息，请核对三列组合。',
      '物资分类（必填）：选择已创建分类的中文名称；管理方式（必填）：从下拉选择“逐件”或“数量”。逐件为每瓶／每件独立编码，数量支持小数。',
      '物资备注（选填，最多2000字）：描述物资本身，如保存条件或使用注意事项；与入库批次的“备注”分别保存。',
      '当前模板共10列；CAS号、纯度／浓度、储存条件、SDS链接均选填。CAS须通过校验位验证，SDS须为不含账号密码的HTTP或HTTPS完整链接。旧6列和旧5列模板仍可读取，缺少的列不会清空已有资料。',
      '原样回导复用已有物资信息，不覆盖原记录；完全一致的停用资料只跳过，保持停用。分类、管理方式、备注或实验室资料与已有记录不同会指出工作表、行、列并整批拒绝，变更请在物资信息页说明原因后编辑。',
      '每次1至5000条，文件不超过5 MiB；不接受公式、宏、外部链接或旧版.xls。以“=”开头的文字按文本保存；不要改成Excel公式。',
      '参考工作表和下拉用于减少输错；不要将参考页当成导入明细。带数量或金额的库存文件请从“期初库存／存量补录”导入草稿，再核对入库。'
    ]));
    const exporter = writeXlsx || require('write-excel-file/node').default;
    const buffer = await exporter(sheets, { features: [referenceFeature()] }).toBuffer();
    if (rows.length) await readCatalogWorkbook({ name: 'export.xlsx', content: buffer.toString('base64') });
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="labos-catalog-${template ? 'template' : today()}.xlsx"`, 'Content-Length': buffer.length });
    res.end(buffer);
  }
  async function locationWorkbookReferences(sheets) {
    const targets = sheets.filter(entry => entry.data?.[0]?.some(cell => cell.value === '存放位置'));
    if (!targets.length) return;
    const tree = (await lab.handle('/storage-places', 'GET', {}, null)).value.items;
    const stored = await all("SELECT location FROM material_stock_locations WHERE location<>'' UNION SELECT location FROM material_opening_items WHERE location<>''");
    const locations = [...new Set([...tree.filter(row => row.effectiveActive).map(row => row.path), ...stored.map(row => row.location)])].slice(0, 5000);
    sheets.push(sheet('库位参考', ['存放位置'], locations.map(value => [value])));
    for (const target of targets) {
      const column = excelColumn(target.data[0].findIndex(cell => cell.value === '存放位置'));
      target.referenceLists = { ...target.referenceLists, [column]: { sheet: '库位参考', column: 'A', count: locations.length, strict: false } };
    }
  }
  async function openingWorkbook(res, user, document = null) {
    requireOpeningRead(user);
    if (!permit(user, 'materials.export')) error(403, '没有物资Excel导出权限');
    const amount = permit(user, 'materials.amount.read');
    const headings = !document || amount ? OPENING_HEADERS : OPENING_HEADERS.filter(header => header !== '总金额（元）');
    const rows = document ? document.items.map(row => {
      const values = [row.name, row.spec, row.unit, row.regionName, warehouseName(row.warehouse), decimalText(row.qtyM, 3), amount ? decimalText(row.amountCents, 2) : '', row.batch, row.expiryDate, row.location, row.zeroAmountReason, row.manufacturer || '', row.note || ''];
      return amount ? values : values.filter((_, index) => index !== 6);
    }) : [];
    const sheets = [sheet('期初明细', headings, rows)];
    if (document) sheets.push(sheet('单据信息', ['单号', '主题', '日期', '类型', '状态', '说明', '补录原因', '入库人', '入库时间'],
      [[document.no, document.title, document.date, document.kind === 'supplement' ? '存量补录' : '期初库存', statusName(document.status), document.description, document.reason, document.posterName, document.postedAt]]));
    await workbookReferences(sheets, true, document?.items || []);
    sheets.push(instructions([
      ...(!amount && document ? ['用途：当前账号无金额读取权限，此脱敏文件只读，不能直接回导。'] : ['用途：期初明细可导入新的期初／存量补录草稿，核对后整单入库才改变库存；导入会追加草稿明细，勿将现有库存重复入库。']),
      '数据从第2行开始，保留第1行中文表头及列顺序；不要增加合计行，参考工作表和单据信息不参与明细导入。',
      '物资名称、规格、单位（必填）：分别最多200、200、30字，三列须对应同一条已建立的物资信息；区域、仓库（必填）：使用已有中文名称及参考下拉，不填写内部编码。',
      '数量（必填）：大于零，最多3位小数；逐件物资必须为整数。每张单据最多5000行，整单入库最多生成1000个单件码。',
      ...(amount || !document ? ['总金额（元）（必填）：非负数，最多2位小数，填写本行总金额而非单价；零金额原因（条件必填）：总金额为0时须说明原因，最多1000字。'] : []),
      '批号（选填，最多100字）；有效期（选填）：YYYY-MM-DD文本，例如2027-03-01；存放位置（选填，最多200字）：同批次须一致，空值沿用当前批次位置。',
      '厂家（选填，最多200字）：可参考历史厂家下拉，也可填写新厂家；新输入统一全半角和连续空格，不改变物资身份或单件编码。',
      '备注（选填，最多2000字）：记录本次入库批次信息；物资本身的说明请在物资信息库的“物资备注”填写，两者分别保存。',
      '文件不超过5 MiB；不接受公式、宏、外部链接或旧版.xls。文本和编码请保留原值；导入失败会指出工作表、行、列，整份通过才保存。'
    ]));
    await locationWorkbookReferences(sheets);
    const exporter = writeXlsx || require('write-excel-file/node').default;
    const buffer = await exporter(sheets, { features: [referenceFeature()] }).toBuffer();
    if (document?.items.length && amount) await readOpeningWorkbook({ name: 'export.xlsx', content: buffer.toString('base64') });
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="labos-opening-${document ? document.no : 'template'}.xlsx"`, 'Content-Length': buffer.length });
    res.end(buffer);
  }
  async function exportWorkbook(res, url, user) {
    if (!permit(user, 'materials.export')) error(403, '没有物资Excel导出权限');
    const amount = permit(user, 'materials.amount.read');
    const original = url.searchParams.get('version') === 'original';
    const snapshotSummary = value => {
      const serialized = JSON.stringify(scrub(JSON.parse(value), user));
      if (serialized.length <= 32767) return serialized;
      const note = '…（完整快照见修订历史/物资备份）';
      const prefix = serialized.slice(0, 32767 - note.length).replace(/[\uD800-\uDBFF]$/, '');
      return prefix + note;
    };
    let sheets;
    if (url.searchParams.get('type') === 'issues') {
      const rows = (await listIssues(url, user, true));
      if (rows.length > 5000) error(413, '一次最多导出5000条领用申请，请缩小筛选范围');
      sheets = [sheet('领用申请', ['申请ID', '状态', '物资编码', '名称', '规格', '单位', '分类', '仓库', '区域', '批号', '有效期',
        '申请时位置', '当前位置或发放时位置', '领用数量', ...(amount ? ['发放金额（元）'] : []), '用途', '申请人', '申请时间', '处理人', '处理时间', '处理原因'],
      rows.map(row => [row.id, statusName(row.status), row.snapshot.code, row.snapshot.name, row.snapshot.spec, row.snapshot.unit,
        row.snapshot.categoryName, warehouseName(row.warehouse), row.snapshot.regionName, row.batch, row.expiryDate, row.snapshot.location, row.location,
        row.qtyM / 1000, ...(amount ? [row.status === 'issued' ? row.amountCents / 100 : null] : []), row.purpose, row.creatorName, row.createdAt, row.processorName, row.processedAt, row.reason]))];
    } else if (url.searchParams.get('type') === 'stock') {
      const rows = (await stockRows(url));
      const batches = (await stockDetails(url));
      if (rows.length > 5000 || batches.length > 5000) error(413, '一次最多导出5000条库存或批次，请缩小筛选范围');
      sheets = [
        sheet('库存', ['物资编码', '名称', '规格', '单位', '仓库', '归属区域', '数量', ...(amount ? ['库存总金额（元）'] : [])],
          rows.map(row => [row.code, row.name, row.spec, row.unit, warehouseName(row.warehouse), row.regionName, row.qtyM / 1000, ...(amount ? [row.amountCents / 100] : [])]))
      ];
      if (amount) {
        sheets.unshift(sheet('库存导入明细', OPENING_HEADERS, batches.filter(row => row.qtyM > 0).map(row => [row.name, row.spec, row.unit, row.regionName,
          warehouseName(row.warehouse), decimalText(row.qtyM, 3), decimalText(row.amountCents, 2), row.batch, row.expiryDate, row.location,
          row.amountCents === 0 ? '导出时库存金额为零，请核对' : '', row.manufacturer, row.note])));
        await workbookReferences(sheets, true, batches.filter(row => row.qtyM > 0));
      }
      sheets.push(sheet('批次库存', ['入库时间', '物资名称', '数量', '规格', '单位', '厂家', '备注', '仓库', '区域', '批号', '有效期', '存放位置', '物资备注', ...(amount ? ['批次分摊金额（元）'] : [])],
        batches.map(row => [row.firstMovementAt, row.name, row.qtyM / 1000, row.spec, row.unit, row.manufacturer, row.note, warehouseName(row.warehouse), row.regionName, row.batch, row.expiryDate, row.location, row.catalogRemark, ...(amount ? [row.amountCents / 100] : [])])));
      sheets.push(instructions([
        amount ? '用途：“库存导入明细”为可回导的13列明细，可导入新的期初／存量补录草稿；“库存”汇总和“批次库存”七列视图用于查阅，不能直接回导。' : '用途：当前账号无金额读取权限，“库存”和“批次库存”均为脱敏只读报表，不能直接回导。',
        '批次库存前七列与库存页面一致：入库时间、物资名称、数量、规格、单位、厂家、备注；后附仓库、区域、批号、有效期、存放位置和物资备注。入库时间为该厂家组首次流水时间，不代表剩余单件各自的入库时间。',
        '厂家区分展示明细；备注来自对应厂家组最后一条非空批次备注，物资备注来自物资信息库，两者不互相覆盖。',
        ...(amount ? ['回导填写规则：物资名称、规格、单位须对应已有物资；区域和仓库填写中文名称。数量大于0、最多3位小数，逐件须整数；总金额非负、最多2位小数，为0时须填零金额原因。', '批号、有效期、存放位置、厂家、备注可空；有效期使用YYYY-MM-DD文本。厂家最多200字，备注最多2000字；下拉参考与新增厂家均可，物资信息库备注不在库存回导时修改。', '导入只追加草稿，不会自动入库；核对后才整单确认，勿将同一批现有库存重复登记。零库存保留在只读报表，回导明细仅含正库存。', '金额按整批次统一计价，厂家明细金额按当前数量分摊并补齐尾差，不是厂家独立成本。'] : []),
        '每次最多5000条草稿、5 MiB；逐件库存每次入库最多1000件。保留中文表头与列顺序，不要增加合计行；不接受公式、宏、外部链接或旧版.xls。'
      ]));
    } else {
      let orders = (await listRequests(url, user, true));
      if (original) orders = (await mapRows(orders,async order => {
        const saved = (await request(order.id)).original_snapshot;
        return saved ? JSON.parse(saved) : order;
      }));
      const ids = new Set(orders.map(order => order.id));
      const items = orders.flatMap(order => order.items.map(line => ({ order, line })));
      const receipts = (await mapRows((await all('SELECT * FROM material_receipts ORDER BY id')).filter(row => ids.has(row.request_id)),async row => (await receiptView(row))));
      const revisions = (await all('SELECT * FROM material_request_revisions ORDER BY request_id,revision')).filter(row => ids.has(row.request_id));
      if (orders.length > 1000 || items.length > 5000 || receipts.length > 5000 || revisions.length > 5000) error(413, '导出记录过多，请按日期或单据缩小范围');
      sheets = [
        sheet('申报单信息', ['单号', '主题', '说明', '状态', '修订版', '创建人', '提交时间'], orders.map(order => [order.no, order.title, order.description, statusName(order.status), order.revision, order.creatorName, order.submittedAt])),
        sheet('申报明细', ['单号', '物资编码', '名称', '分类', '规格', '单位', '归属区域', '仓库', '申报数量', '用途', '填报人', '厂家', '物资信息状态'],
          items.map(({ order, line }) => [order.no, line.code, line.name, line.categoryName, line.spec, line.unit, line.regionName, warehouseName(line.warehouse), line.qtyM / 1000, line.purpose, line.authorName, line.manufacturer || '', line.catalogId ? '已关联物资信息' : '验收时完善物资信息'])),
        sheet('验收流水', ['事件ID', '类型', '申报修订版', '物资编码', '名称', '分类', '区域', '仓库', '合格数量', '拒收数量', '结案数量', ...(amount ? ['合格总金额（元）'] : []), '原因', '拒收原因', '日期', '规格', '单位', '厂家', '备注', '批号', '有效期', '存放位置', '零金额原因', '验收人', '验收时间', '到货登记ID', '申报厂家', '厂家核对状态', '厂家未标明原因', '厂家差异原因'],
          receipts.map(event => [event.id, receiptTypeName(event.type), event.requestRevision, event.snapshot.code, event.snapshot.name, event.snapshot.categoryName, event.snapshot.regionName, warehouseName(event.snapshot.warehouse),
            event.qtyM / 1000, event.rejectedQtyM / 1000, event.closedQtyM / 1000, ...(amount ? [event.amountCents / 100] : []), event.reason, event.rejectedReason, event.date,
            event.snapshot.spec, event.snapshot.unit, event.manufacturer, event.note, event.batch, event.expiryDate, event.snapshot.location || '', event.zeroAmountReason, event.actorName, event.createdAt,
            event.arrivalId, event.expectedManufacturer, ({ legacy: '历史未记录', known: '已核对实到厂家', unknown: '厂家未标明' })[event.manufacturerStatus], event.manufacturerReason, event.differenceReason])),
        sheet('修订记录', ['申报单ID', '修订版', '修改原因', '操作人', '时间', '修改前快照摘要', '修改后快照摘要'],
          (await mapRows(revisions,async row => [row.request_id, row.revision, row.reason, (await actorName(row.actor_id)), row.created_at,
            snapshotSummary(row.before_snapshot), snapshotSummary(row.after_snapshot)])))
      ];
    }
    if (url.searchParams.get('type') !== 'stock') sheets.push(instructions([
      `用途：${url.searchParams.get('type') === 'issues' ? '领用申请报表' : '申报、验收及修订历史报表'}仅供查询、归档，不能作为库存或物资信息库的导入模板。`,
      ...(url.searchParams.get('type') === 'issues' ? ['领用状态和仓库使用中文名称；申请时位置与发放时位置分别保存，报表保留申请、处理时间与处理原因。'] : [
        '申报物资可在验收时完善信息；厂家取对应申报版本，验收厂家、备注及存放位置取验收记录当时保存的值，历史未记录字段保持空白，不用当前数据补写历史。',
        '厂家和批次备注分别描述厂家与该次批次记录，物资本身的备注由物资信息库管理；单号、事件ID和物资编码用于查询关联，无需按这些报表手填导入编码。'
      ]),
      ...(original ? ['申报单信息与申报明细取首次提交快照；验收流水和修订记录仍列出该单当前完整历史。'] : []),
      amount ? '当前文件包含权限允许的金额，请妥善保存。' : '当前账号无金额读取权限，金额和历史快照中的金额已隐藏。'
    ]));
    await locationWorkbookReferences(sheets);
    const exporter = writeXlsx || require('write-excel-file/node').default;
    const buffer = await exporter(sheets, { features: [referenceFeature()] }).toBuffer();
    if (url.searchParams.get('type') === 'stock' && amount && sheets[0].data.length > 1) await readOpeningWorkbook({ name: 'export.xlsx', content: buffer.toString('base64') });
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="labos-materials-${today()}.xlsx"`, 'Content-Length': buffer.length });
    res.end(buffer);
  }

  return { handle, backup, restore };
}

module.exports = createMaterials;
module.exports.createMaterials = createMaterials;
