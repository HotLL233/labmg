'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
  'material_categories', 'material_regions', 'material_catalog', 'material_barcodes', 'material_requests',
  'material_request_items', 'material_request_revisions', 'material_receipts',
  'material_stock_locations', 'material_issues', 'material_stock_movements',
  'material_attachments', 'material_state', 'material_idempotency'
];
const V2_TABLES = TABLES.filter(table => table !== 'material_barcodes');
const V1_TABLES = V2_TABLES.filter(table => !['material_stock_locations', 'material_issues'].includes(table));

function createMaterials({ db, body, send, fail, log, hasPermission, tokenUser, uploads, writeXlsx }) {
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS material_categories(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS material_regions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS material_catalog(
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      spec TEXT NOT NULL, unit TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES material_categories(id),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS material_barcodes(
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE COLLATE BINARY CHECK(length(code)>0 AND length(code)<=512),
      catalog_id INTEGER NOT NULL REFERENCES material_catalog(id), created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS material_requests(
      id INTEGER PRIMARY KEY AUTOINCREMENT, no TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted')),
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_by INTEGER REFERENCES users(id), submitted_at TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
      original_snapshot TEXT
    );
    CREATE TABLE IF NOT EXISTS material_request_items(
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES material_requests(id),
      catalog_id INTEGER REFERENCES material_catalog(id), code TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
      spec TEXT NOT NULL, unit TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES material_categories(id),
      region_id INTEGER NOT NULL REFERENCES material_regions(id), warehouse TEXT NOT NULL,
      qty_m INTEGER NOT NULL CHECK(qty_m>0), purpose TEXT NOT NULL DEFAULT '',
      author_id INTEGER NOT NULL REFERENCES users(id), version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS material_request_revisions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES material_requests(id),
      revision INTEGER NOT NULL CHECK(revision>=2), before_snapshot TEXT NOT NULL, after_snapshot TEXT NOT NULL,
      reason TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(request_id,revision)
    );
    CREATE TABLE IF NOT EXISTS material_receipts(
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK(type IN ('acceptance','rejection','close','reversal')),
      request_id INTEGER NOT NULL REFERENCES material_requests(id), item_id INTEGER NOT NULL REFERENCES material_request_items(id),
      request_revision INTEGER NOT NULL, snapshot TEXT NOT NULL,
      qty_m INTEGER NOT NULL DEFAULT 0, rejected_qty_m INTEGER NOT NULL DEFAULT 0 CHECK(rejected_qty_m>=0),
      closed_qty_m INTEGER NOT NULL DEFAULT 0 CHECK(closed_qty_m>=0), amount_cents INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '', rejected_reason TEXT NOT NULL DEFAULT '', zero_amount_reason TEXT NOT NULL DEFAULT '',
      original_receipt_id INTEGER REFERENCES material_receipts(id), batch TEXT NOT NULL DEFAULT '', expiry_date TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK((type='acceptance' AND qty_m>0 AND amount_cents>=0) OR
        (type='rejection' AND qty_m=0 AND amount_cents=0 AND rejected_qty_m>0) OR
        (type='close' AND qty_m=0 AND amount_cents=0 AND closed_qty_m>0) OR
        (type='reversal' AND qty_m<0 AND amount_cents<=0 AND original_receipt_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS material_one_reversal ON material_receipts(original_receipt_id) WHERE type='reversal';
    CREATE TABLE IF NOT EXISTS material_stock_locations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_id INTEGER NOT NULL REFERENCES material_catalog(id), region_id INTEGER NOT NULL REFERENCES material_regions(id),
      warehouse TEXT NOT NULL, batch TEXT NOT NULL DEFAULT '', expiry_date TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL CHECK(length(location)<=200), version INTEGER NOT NULL CHECK(version>0),
      reason TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
      UNIQUE(catalog_id,warehouse,region_id,batch,expiry_date)
    );
    CREATE TABLE IF NOT EXISTS material_issues(
      id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','issued','rejected','cancelled')),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
      catalog_id INTEGER NOT NULL REFERENCES material_catalog(id), region_id INTEGER NOT NULL REFERENCES material_regions(id),
      warehouse TEXT NOT NULL, batch TEXT NOT NULL DEFAULT '', expiry_date TEXT NOT NULL DEFAULT '',
      qty_m INTEGER NOT NULL CHECK(qty_m>0), amount_cents INTEGER NOT NULL DEFAULT 0 CHECK(amount_cents>=0),
      snapshot TEXT NOT NULL, purpose TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id), processed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL, processed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS material_stock_movements(
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK(type IN ('opening','receipt','reversal','adjustment','issue')),
      catalog_id INTEGER NOT NULL REFERENCES material_catalog(id), region_id INTEGER NOT NULL REFERENCES material_regions(id),
      warehouse TEXT NOT NULL, qty_m INTEGER NOT NULL CHECK(qty_m<>0), amount_cents INTEGER NOT NULL,
      receipt_id INTEGER REFERENCES material_receipts(id), source_key TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL,
      batch TEXT NOT NULL DEFAULT '', expiry_date TEXT NOT NULL DEFAULT '', date TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS material_attachments(
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER REFERENCES material_requests(id),
      receipt_id INTEGER REFERENCES material_receipts(id), name TEXT NOT NULL, mime_type TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE, size INTEGER NOT NULL CHECK(size>0 AND size<=5242880),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK((request_id IS NOT NULL AND receipt_id IS NULL) OR (request_id IS NULL AND receipt_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS material_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO material_state(key,value) VALUES('opening_closed','0');
    CREATE TABLE IF NOT EXISTS material_idempotency(
      actor_id INTEGER NOT NULL REFERENCES users(id), key TEXT NOT NULL, digest TEXT NOT NULL,
      response TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(actor_id,key)
    );
    CREATE INDEX IF NOT EXISTS material_request_status ON material_requests(status,created_at);
    CREATE INDEX IF NOT EXISTS material_items_request ON material_request_items(request_id);
    CREATE INDEX IF NOT EXISTS material_receipt_item ON material_receipts(item_id,id);
    CREATE INDEX IF NOT EXISTS material_stock_key ON material_stock_movements(catalog_id,warehouse,region_id);
    CREATE INDEX IF NOT EXISTS material_attachment_request ON material_attachments(request_id,receipt_id);
    CREATE INDEX IF NOT EXISTS material_issue_owner ON material_issues(created_by,status,id);
  `);

  // SQLite cannot alter a CHECK constraint. No table points to movements, so foreign keys stay enabled.
  if (!db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='material_stock_movements'").get().sql.includes("'issue'")) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='material_stock_movements'").get()?.seq || 0;
      const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='material_stock_movements' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
      const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='material_stock_movements'").get().sql;
      db.exec(definition.replace(/\bmaterial_stock_movements\b/, 'material_stock_movements_upgrade')
        .replace("'adjustment'", "'adjustment','issue'"));
      db.exec(`INSERT INTO material_stock_movements_upgrade SELECT * FROM material_stock_movements;
        DROP TABLE material_stock_movements;
        ALTER TABLE material_stock_movements_upgrade RENAME TO material_stock_movements;`);
      for (const object of objects) db.exec(object.sql);
      const currentSequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='material_stock_movements'").get();
      if (currentSequence) db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='material_stock_movements'").run(Math.max(sequence, currentSequence.seq));
      else db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('material_stock_movements',?)").run(sequence);
      db.exec('COMMIT');
    } catch (failure) {
      db.exec('ROLLBACK');
      throw failure;
    }
  }

  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const ITEM_SELECT = `SELECT i.*, c.name AS category_name, r.name AS region_name, u.display_name AS author_name,
    (SELECT COUNT(*) FROM material_receipts e WHERE e.item_id=i.id) AS receipt_count,
    (SELECT COALESCE(SUM(qty_m),0) FROM material_receipts e WHERE e.item_id=i.id) AS accepted_qty_m,
    (SELECT COALESCE(SUM(closed_qty_m),0) FROM material_receipts e WHERE e.item_id=i.id) AS closed_qty_m
    FROM material_request_items i JOIN material_categories c ON c.id=i.category_id
    JOIN material_regions r ON r.id=i.region_id JOIN users u ON u.id=i.author_id`;
  const actorName = id => one('SELECT display_name FROM users WHERE id=?', id)?.display_name || '';
  const now = () => new Date().toISOString();
  const today = () => now().slice(0, 10);
  const role = (user, name) => String(user?.role || '').split(',').includes(name);
  const permit = (user, permission) => Boolean(user && hasPermission(user, permission));
  const material = (user, permission) => role(user, 'MATERIAL') && permit(user, permission);
  const manager = (user, permission) => (role(user, 'ADMIN') || role(user, 'MATERIAL')) && permit(user, permission);
  const openingClosed = () => one("SELECT value FROM material_state WHERE key='opening_closed'")?.value === '1';
  const closeOpening = () => run("UPDATE material_state SET value='1' WHERE key='opening_closed'");

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
  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      db.exec('COMMIT');
      return result;
    } catch (failure) {
      db.exec('ROLLBACK');
      throw failure;
    }
  }
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
  function dictionary(table, id, label) {
    const result = one(`SELECT * FROM ${table} WHERE id=?`, integer(id, label));
    if (!result) error(400, `${label}不存在`);
    return result;
  }
  function catalog(id) {
    const result = one('SELECT * FROM material_catalog WHERE id=?', integer(id, '物资主档'));
    if (!result) error(400, '物资主档不存在');
    return result;
  }
  function catalogView(row) {
    return { id: row.id, code: row.code, name: row.name, spec: row.spec, unit: row.unit,
      categoryId: row.category_id, categoryName: dictionary('material_categories', row.category_id, '分类').name, version: row.version };
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
  function barcodeView(row) {
    return { id: row.id, code: row.code, catalogId: row.catalog_id, createdBy: row.created_by,
      creatorName: actorName(row.created_by), createdAt: row.created_at };
  }
  function request(id) {
    const result = one('SELECT * FROM material_requests WHERE id=?', integer(id));
    if (!result) error(404, '申报单不存在');
    return result;
  }
  function item(requestId, id) {
    const result = one('SELECT * FROM material_request_items WHERE request_id=? AND id=?', requestId, integer(id));
    if (!result) error(404, '申报明细不存在');
    return result;
  }
  function versions(order, line, input) {
    if (!Number.isSafeInteger(input.requestVersion) || (line && !Number.isSafeInteger(input.version))) error(400, '请提供读取时的整数版本');
    if (input.requestVersion !== order.version || (line && input.version !== line.version)) conflict('单据、明细或验收进度已变化，请重新读取后确认');
  }
  function activity(lineId) {
    const events = all('SELECT type,qty_m,closed_qty_m FROM material_receipts WHERE item_id=?', lineId);
    return {
      exists: events.length > 0,
      accepted: safeSum(events.map(entry => entry.qty_m)),
      closed: safeSum(events.map(entry => entry.closed_qty_m))
    };
  }
  function bump(orderId, lineId) {
    run('UPDATE material_requests SET version=version+1 WHERE id=?', orderId);
    if (lineId) run('UPDATE material_request_items SET version=version+1 WHERE id=?', lineId);
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
    if (order.status === 'submitted') return material(user, 'materials.request.edit_submitted');
    return role(user, 'MATERIAL') || line.author_id === user.id;
  }
  function mayHeader(order, user) {
    return order.status === 'submitted' ? material(user, 'materials.request.edit_submitted') : role(user, 'MATERIAL') || order.created_by === user.id;
  }
  function attachmentView(row) {
    return {
      id: row.id, name: row.name, mimeType: row.mime_type, size: row.size,
      parentType: row.request_id ? 'request' : 'receipt', parentId: row.request_id || row.receipt_id,
      createdAt: row.created_at, actorId: row.actor_id
    };
  }
  function itemView(row, order, user, snapshot = false) {
    const counts = row.receipt_count === undefined ? activity(row.id) : {
      exists: row.receipt_count > 0, accepted: row.accepted_qty_m, closed: row.closed_qty_m
    };
    const remaining = safeSum([row.qty_m, -counts.accepted, -counts.closed]);
    return {
      id: row.id, requestId: row.request_id, catalogId: row.catalog_id,
      code: row.code, name: row.name, spec: row.spec, unit: row.unit,
      categoryId: row.category_id, categoryName: row.category_name ?? one('SELECT name FROM material_categories WHERE id=?', row.category_id)?.name ?? '',
      regionId: row.region_id, regionName: row.region_name ?? one('SELECT name FROM material_regions WHERE id=?', row.region_id)?.name ?? '',
      warehouse: row.warehouse, qtyM: row.qty_m, purpose: row.purpose,
      authorId: row.author_id, authorName: row.author_name ?? actorName(row.author_id), version: row.version,
      identityLocked: counts.exists,
      acceptedQtyM: counts.accepted, closedQtyM: counts.closed, remainingQtyM: remaining,
      receiptStatus: remaining === 0 ? counts.closed > 0 ? 'closed' : 'done' : counts.accepted > 0 ? 'partial' : 'pending',
      ...(snapshot ? {} : { canEdit: mayEdit(order, row, user), canDelete: order.status === 'draft' && mayEdit(order, row, user) })
    };
  }
  function requestView(id, user, snapshot = false) {
    const order = request(id);
    const items = all(`${ITEM_SELECT} WHERE i.request_id=? ORDER BY i.id`, order.id).map(row => itemView(row, order, user, snapshot));
    return {
      id: order.id, no: order.no, title: order.title, description: order.description, status: order.status,
      createdBy: order.created_by, creatorName: actorName(order.created_by), createdAt: order.created_at,
      submittedBy: order.submitted_by, submittedAt: order.submitted_at, version: order.version, revision: order.revision,
      itemCount: items.length, progress: { pendingItems: items.filter(row => row.remainingQtyM > 0).length },
      items, attachments: all('SELECT * FROM material_attachments WHERE request_id=? AND active=1 ORDER BY id', order.id).map(attachmentView),
      ...(snapshot ? {} : {
        canEditHeader: mayHeader(order, user), canAddItem: order.status === 'draft',
        canSubmit: order.status === 'draft' && items.length > 0 && material(user, 'materials.request.submit')
      })
    };
  }
  function receiptView(row) {
    return {
      id: row.id, type: row.type, requestId: row.request_id, itemId: row.item_id,
      requestRevision: row.request_revision, snapshot: JSON.parse(row.snapshot),
      qtyM: row.qty_m, rejectedQtyM: row.rejected_qty_m, closedQtyM: row.closed_qty_m, amountCents: row.amount_cents,
      reason: row.reason, rejectedReason: row.rejected_reason, zeroAmountReason: row.zero_amount_reason,
      originalReceiptId: row.original_receipt_id, batch: row.batch, expiryDate: row.expiry_date,
      date: row.date, actorId: row.actor_id, actorName: row.actor_name ?? actorName(row.actor_id), createdAt: row.created_at,
      reversed: row.is_reversed === undefined ? Boolean(one("SELECT 1 FROM material_receipts WHERE type='reversal' AND original_receipt_id=?", row.id)) : Boolean(row.is_reversed)
    };
  }
  function movementView(row) {
    return {
      id: row.id, type: row.type, catalogId: row.catalog_id, regionId: row.region_id, warehouse: row.warehouse,
      qtyM: row.qty_m, amountCents: row.amount_cents, sourceId: row.receipt_id,
      issueId: row.type === 'issue' ? Number(row.source_key.slice(6)) : null,
      snapshot: JSON.parse(row.snapshot), batch: row.batch, expiryDate: row.expiry_date, date: row.date,
      reason: row.reason, actorId: row.actor_id, actorName: row.actor_name ?? actorName(row.actor_id), createdAt: row.created_at
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
  function recordRevision(order, user, reason, before) {
    if (order.status !== 'submitted') return;
    run('UPDATE material_requests SET revision=revision+1 WHERE id=?', order.id);
    const after = requestView(order.id, user, true);
    run(`INSERT INTO material_request_revisions(request_id,revision,before_snapshot,after_snapshot,reason,actor_id)
      VALUES(?,?,?,?,?,?)`, order.id, after.revision, JSON.stringify(before), JSON.stringify(after), reason, user.id);
  }
  function editReason(order, input) {
    return order.status === 'submitted' ? text(input.reason, '修订原因', 1000) : '';
  }
  function lineInput(input, old = {}) {
    const catalogId = input.catalogId === undefined ? old.catalog_id : input.catalogId === null ? null : integer(input.catalogId, '物资主档');
    const master = catalogId ? catalog(catalogId) : null;
    const categoryId = input.categoryId === undefined ? old.category_id ?? master?.category_id : integer(input.categoryId, '分类');
    const regionId = input.regionId === undefined ? old.region_id : integer(input.regionId, '区域');
    dictionary('material_categories', categoryId, '分类');
    dictionary('material_regions', regionId, '区域');
    return {
      catalog_id: catalogId || null,
      code: master?.code ?? (input.code === undefined ? old.code || '' : text(input.code, '编码', 64, true).toUpperCase()),
      name: master?.name ?? text(input.name ?? old.name, '物资名称'),
      spec: master?.spec ?? text(input.spec ?? old.spec, '规格'),
      unit: master?.unit ?? text(input.unit ?? old.unit, '单位', 30),
      category_id: categoryId, region_id: regionId,
      warehouse: warehouse(input.warehouse ?? old.warehouse),
      qty_m: input.quantity === undefined && old.qty_m !== undefined ? old.qty_m : decimal(input.quantity, 3, '申报数量'),
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
  function idempotent(user, route, input, callback) {
    const key = text(input.requestIdempotencyKey, '幂等请求号', 128);
    if (key.length < 8) error(400, '幂等请求号至少8个字符');
    const digest = crypto.createHash('sha256').update(route + '\n' + stableJson(input)).digest('hex');
    return transaction(() => {
      const previous = one('SELECT * FROM material_idempotency WHERE actor_id=? AND key=?', user.id, key);
      if (previous) {
        if (previous.digest !== digest) error(409, '同一幂等请求号不能用于不同内容', 'IDEMPOTENCY_CONFLICT');
        return { status: 200, value: JSON.parse(previous.response) };
      }
      const value = callback(key);
      run('INSERT INTO material_idempotency(actor_id,key,digest,response) VALUES(?,?,?,?)', user.id, key, digest, JSON.stringify(value));
      return { status: 201, value };
    });
  }
  function ensureBalance(row) {
    const previous = all(`SELECT qty_m,amount_cents FROM material_stock_movements
      WHERE catalog_id=? AND region_id=? AND warehouse=? AND batch=? AND expiry_date=?`,
    row.catalog_id, row.region_id, row.warehouse, row.batch, row.expiry_date);
    const quantity = safeSum([...previous.map(entry => entry.qty_m), row.qty_m]);
    const amount = safeSum([...previous.map(entry => entry.amount_cents), row.amount_cents]);
    if (quantity < 0 || amount < 0) conflict('该区域、仓库和批次的可用库存数量或金额不足，不能冲减');
    const group = all('SELECT qty_m,amount_cents FROM material_stock_movements WHERE catalog_id=? AND region_id=? AND warehouse=?', row.catalog_id, row.region_id, row.warehouse);
    safeSum([...group.map(entry => entry.qty_m), row.qty_m]);
    safeSum([...group.map(entry => entry.amount_cents), row.amount_cents]);
  }
  function addMovement(data, user) {
    ensureBalance(data);
    const result = run(`INSERT INTO material_stock_movements(type,catalog_id,region_id,warehouse,qty_m,amount_cents,receipt_id,
      source_key,snapshot,batch,expiry_date,date,reason,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    data.type, data.catalog_id, data.region_id, data.warehouse, data.qty_m, data.amount_cents, data.receipt_id || null,
    data.source_key, JSON.stringify(data.snapshot), data.batch || '', data.expiry_date || '', data.date || today(), data.reason || '', user.id);
    return movementView(one('SELECT * FROM material_stock_movements WHERE id=?', result.lastInsertRowid));
  }
  function stockIdentity(input) {
    return { catalog_id: catalog(input.catalogId).id, region_id: dictionary('material_regions', input.regionId, '区域').id,
      warehouse: warehouse(input.warehouse), batch: text(input.batch ?? '', '批号', 100, true),
      expiry_date: date(input.expiryDate, '有效期', true) };
  }
  const identityArgs = row => [row.catalog_id, row.region_id, row.warehouse, row.batch, row.expiry_date];
  function batchBalance(row) {
    const movements = all(`SELECT * FROM material_stock_movements
      WHERE catalog_id=? AND region_id=? AND warehouse=? AND batch=? AND expiry_date=? ORDER BY id`, ...identityArgs(row));
    return { movements, qty: safeSum(movements.map(entry => entry.qty_m)), amount: safeSum(movements.map(entry => entry.amount_cents)) };
  }
  function stockLocation(row) {
    return one(`SELECT * FROM material_stock_locations
      WHERE catalog_id=? AND region_id=? AND warehouse=? AND batch=? AND expiry_date=?`, ...identityArgs(row));
  }
  function locationView(row) {
    return { id: row.id, catalogId: row.catalog_id, regionId: row.region_id, warehouse: row.warehouse,
      batch: row.batch, expiryDate: row.expiry_date, location: row.location, version: row.version,
      reason: row.reason, actorId: row.actor_id, actorName: actorName(row.actor_id), updatedAt: row.updated_at };
  }
  function checkedIssue(id, user) {
    const row = one('SELECT * FROM material_issues WHERE id=?', integer(id));
    if (!row) error(404, '领用申请不存在');
    if (row.created_by !== user.id && !role(user, 'ADMIN') && !role(user, 'MATERIAL')) error(403, '只能查看本人的领用申请');
    return row;
  }
  function issueView(row, user) {
    const snapshot = JSON.parse(row.snapshot);
    const movement = row.status === 'issued' ? one("SELECT * FROM material_stock_movements WHERE source_key=? AND type='issue'", `issue:${row.id}`) : null;
    const location = row.status === 'pending' ? stockLocation(row)?.location || '' :
      movement ? JSON.parse(movement.snapshot).location || '' : snapshot.location || '';
    return { id: row.id, status: row.status, version: row.version, catalogId: row.catalog_id, regionId: row.region_id,
      warehouse: row.warehouse, batch: row.batch, expiryDate: row.expiry_date, qtyM: row.qty_m, amountCents: row.amount_cents,
      snapshot, location, purpose: row.purpose, reason: row.reason, createdBy: row.created_by, creatorName: actorName(row.created_by),
      processedBy: row.processed_by, processorName: row.processed_by ? actorName(row.processed_by) : '',
      createdAt: row.created_at, processedAt: row.processed_at, movementId: movement?.id || null,
      canIssue: row.status === 'pending' && material(user, 'materials.issue.write'),
      canReject: row.status === 'pending' && material(user, 'materials.issue.write'),
      canCancel: row.status === 'pending' && row.created_by === user.id };
  }
  function listIssues(url, user, unpaged = false) {
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
    const total = page ? one(`SELECT COUNT(*) AS total ${query}`, ...args).total : 0;
    const rows = all(`SELECT i.* ${query} ORDER BY i.id DESC${page ? ' LIMIT ? OFFSET ?' : ''}`,
      ...args, ...(page ? [page.pageSize, page.offset] : [])).map(row => issueView(row, user));
    return page ? { items: rows, total, page: page.page, pageSize: page.pageSize } : rows;
  }
  function issueAmount(quantity, balance) {
    if (quantity > balance.qty || balance.qty <= 0) conflict('该批次可用库存不足，请重新读取库存后处理');
    return quantity === balance.qty ? balance.amount :
      Number((BigInt(balance.amount) * BigInt(quantity) + BigInt(balance.qty) / 2n) / BigInt(balance.qty));
  }
  function issueAction(user, id, input, route, action) {
    const visible = checkedIssue(id, user);
    if (action === 'cancel') {
      if (visible.created_by !== user.id) error(403, '只有申请人可以取消自己的领用申请');
    } else requireMaterial(user, 'materials.issue.write');
    return idempotent(user, route, input, () => {
      const row = checkedIssue(id, user);
      if (!Number.isSafeInteger(input.version) || input.version <= 0) error(400, '请提供读取时的整数版本');
      if (row.status !== 'pending' || row.version !== input.version) conflict('领用申请状态或版本已变化，请重新读取');
      const reason = action === 'issue' ? '' : text(input.reason, '处理原因', 1000);
      const processedAt = now();
      let amount = 0;
      if (action === 'issue') {
        const balance = batchBalance(row);
        amount = issueAmount(row.qty_m, balance);
        addMovement({ ...row, type: 'issue', qty_m: -row.qty_m, amount_cents: -amount, receipt_id: null,
          source_key: `issue:${row.id}`, snapshot: { ...JSON.parse(row.snapshot), location: stockLocation(row)?.location || '' },
          date: processedAt.slice(0, 10), reason: row.purpose }, user);
      }
      const status = { issue: 'issued', reject: 'rejected', cancel: 'cancelled' }[action];
      run(`UPDATE material_issues SET status=?,version=version+1,amount_cents=?,reason=?,processed_by=?,processed_at=? WHERE id=?`,
        status, amount, reason, user.id, processedAt, row.id);
      log(user, action === 'issue' ? 'ISSUE' : action === 'reject' ? 'REJECT_ISSUE' : 'CANCEL_ISSUE', 'material_issues', row.id, reason || row.purpose);
      return { issue: issueView(checkedIssue(row.id, user), user) };
    });
  }
  function stockRows(url, paged = false, byBatch = false) {
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
    ) SELECT b.*, first.snapshot, r.name AS region_name, last.created_at AS last_movement_at
      FROM balances b JOIN material_stock_movements first ON first.id=b.first_id
      JOIN material_stock_movements last ON last.id=b.last_id JOIN material_regions r ON r.id=b.region_id`;
    const q = (url?.searchParams.get('q') || '').trim().toLowerCase();
    const searchSql = q ? ` WHERE instr(lower(COALESCE(json_extract(first.snapshot,'$.code'),'') || ' ' ||
      COALESCE(json_extract(first.snapshot,'$.name'),'') || ' ' || COALESCE(json_extract(first.snapshot,'$.spec'),'') || ' ' || r.name),?)>0` : '';
    if (q) args.push(q);
    const page = paged ? pageInput(url) : null;
    const total = page ? one(`SELECT COUNT(*) AS total FROM (${query + searchSql})`, ...args).total : 0;
    const rows = all(query + searchSql + ' ORDER BY b.first_id' + (page ? ' LIMIT ? OFFSET ?' : ''),
      ...args, ...(page ? [page.pageSize, page.offset] : [])).map(row => {
      const snapshot = JSON.parse(row.snapshot);
      if (!Number.isSafeInteger(row.qty_m) || !Number.isSafeInteger(row.amount_cents)) error(400, '库存累计数值超出安全整数范围');
      return { id: byBatch ? JSON.stringify([row.catalog_id, row.warehouse, row.region_id, row.batch, row.expiry_date]) : `${row.catalog_id}:${row.warehouse}:${row.region_id}`, catalogId: row.catalog_id,
        code: snapshot.code, name: snapshot.name, spec: snapshot.spec, unit: snapshot.unit,
        regionId: row.region_id, regionName: row.region_name, warehouse: row.warehouse,
        ...(byBatch ? { batch: row.batch, expiryDate: row.expiry_date, categoryId: snapshot.categoryId, categoryName: snapshot.categoryName,
          location: stockLocation(row)?.location || '', locationVersion: stockLocation(row)?.version || 0,
          qrPayload: STOCK_QR_PREFIX + JSON.stringify({ catalogId: row.catalog_id, catalogCode: snapshot.code, regionId: row.region_id,
            warehouse: row.warehouse, batch: row.batch, expiryDate: row.expiry_date }) } : {}),
        qtyM: row.qty_m, amountCents: row.amount_cents, lastMovementAt: row.last_movement_at };
    });
    return page ? { items: rows, total, page: page.page, pageSize: page.pageSize } : rows;
  }

  function insertReceipt(data, user) {
    const result = run(`INSERT INTO material_receipts(type,request_id,item_id,request_revision,snapshot,qty_m,
      rejected_qty_m,closed_qty_m,amount_cents,reason,rejected_reason,zero_amount_reason,original_receipt_id,
      batch,expiry_date,date,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    data.type, data.request_id, data.item_id, data.request_revision, JSON.stringify(data.snapshot), data.qty_m || 0,
    data.rejected_qty_m || 0, data.closed_qty_m || 0, data.amount_cents || 0, data.reason || '',
    data.rejected_reason || '', data.zero_amount_reason || '', data.original_receipt_id || null,
    data.batch || '', data.expiry_date || '', data.date || today(), user.id);
    return one('SELECT * FROM material_receipts WHERE id=?', result.lastInsertRowid);
  }
  function checkedReceipt(id) {
    const result = one('SELECT * FROM material_receipts WHERE id=?', integer(id));
    if (!result) error(404, '验收事件不存在');
    return result;
  }
  function receiptAction(user, input, route, kind, orderId, itemId, originalId) {
    requireMaterial(user, 'materials.acceptance.write');
    return idempotent(user, route, input, () => {
      const original = originalId ? checkedReceipt(originalId) : null;
      const order = request(original?.request_id || orderId || input.requestId);
      const line = item(order.id, original?.item_id || itemId || input.itemId);
      versions(order, line, input);
      if (order.status !== 'submitted') conflict('只有已提交申报可办理验收或结案');
      if (!line.catalog_id) conflict('验收、拒收或结案前请先匹配物资主档');
      const counts = activity(line.id);
      const remaining = safeSum([line.qty_m, -counts.accepted, -counts.closed]);
      const snapshot = itemView(line, order, user, true);
      let event;
      if (kind === 'close') {
        if (remaining <= 0) conflict('该明细已无剩余可结案数量');
        event = insertReceipt({ type: 'close', request_id: order.id, item_id: line.id,
          request_revision: order.revision, snapshot, closed_qty_m: remaining,
          reason: text(input.reason, '结案原因', 1000) }, user);
      } else if (kind === 'reverse') {
        if (original.type !== 'acceptance') error(400, '仅合格验收支持整笔冲正');
        if (one("SELECT 1 FROM material_receipts WHERE type='reversal' AND original_receipt_id=?", original.id)) conflict('原验收已经冲正，不能再次冲正');
        const movement = one('SELECT * FROM material_stock_movements WHERE receipt_id=?', original.id);
        if (!movement) error(409, '原验收缺少来源流水，不能冲正');
        event = insertReceipt({ type: 'reversal', request_id: order.id, item_id: line.id,
          request_revision: order.revision, snapshot: JSON.parse(original.snapshot),
          qty_m: -original.qty_m, amount_cents: -original.amount_cents,
          original_receipt_id: original.id, reason: text(input.reason, '冲正原因', 1000),
          batch: original.batch, expiry_date: original.expiry_date }, user);
        addMovement({ ...movement, type: 'reversal', qty_m: -movement.qty_m,
          amount_cents: -movement.amount_cents, receipt_id: event.id, source_key: `receipt:${event.id}`,
          snapshot: JSON.parse(movement.snapshot), reason: event.reason, date: today() }, user);
      } else {
        const quantity = decimal(input.quantity, 3, '合格数量', true);
        const rejected = decimal(input.rejectedQuantity ?? '0', 3, '拒收数量', true);
        const amount = decimal(input.amount, 2, '本批总金额', true);
        if (quantity === 0 && rejected === 0) error(400, '合格数量与拒收数量不能同时为零');
        if (safeSum([quantity, rejected]) > remaining) conflict('本次合格与拒收数量超过当前剩余待处理量');
        const rejectedReason = rejected > 0 ? text(input.rejectedReason, '拒收原因', 1000) : '';
        const zeroReason = quantity > 0 && amount === 0 ? text(input.zeroAmountReason, '零金额原因', 1000) : '';
        if (quantity === 0 && amount !== 0) error(400, '纯拒收不能计入合格库存金额');
        event = insertReceipt({ type: quantity > 0 ? 'acceptance' : 'rejection', request_id: order.id,
          item_id: line.id, request_revision: order.revision, snapshot,
          qty_m: quantity, rejected_qty_m: rejected, amount_cents: amount,
          rejected_reason: rejectedReason, zero_amount_reason: zeroReason,
          batch: text(input.batch ?? '', '批号', 100, true),
          expiry_date: date(input.expiryDate, '有效期', true), date: date(input.date) }, user);
        if (quantity > 0) {
          addMovement({ type: 'receipt', catalog_id: line.catalog_id, region_id: line.region_id,
            warehouse: line.warehouse, qty_m: quantity, amount_cents: amount, receipt_id: event.id,
            source_key: `receipt:${event.id}`, snapshot, batch: event.batch,
            expiry_date: event.expiry_date, date: event.date }, user);
          closeOpening();
        }
      }
      bump(order.id, line.id);
      log(user, event.type.toUpperCase(), 'material_receipts', event.id, order.no);
      return { receipt: receiptView(event), request: requestView(order.id, user) };
    });
  }
  function attachmentInput(input) {
    const name = text(input.name, '文件名', 200);
    if (name === '.' || name === '..' || /[\\/]/.test(name)) error(400, '文件名不能包含路径');
    const mimeType = text(input.mimeType || 'application/octet-stream', '文件类型', 120);
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) error(400, '文件类型无效');
    if (typeof input.content !== 'string' || !input.content || input.content.length > Math.ceil(FILE_LIMIT / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) error(400, '附件须为不超过5 MiB的有效base64');
    const content = Buffer.from(input.content, 'base64');
    if (!content.length || content.length > FILE_LIMIT || content.toString('base64') !== input.content) error(400, '附件内容无效或超过5 MiB');
    return { name, mimeType, content };
  }
  function attachmentPath(storedName) {
    if (!/^[a-f0-9-]{36}\.bin$/.test(storedName)) error(400, '附件存储标识无效');
    return path.join(uploads, 'materials', storedName);
  }
  function saveAttachment(user, input, requestId, receiptId) {
    const parsed = attachmentInput(input);
    const storedName = crypto.randomUUID() + '.bin';
    const destination = attachmentPath(storedName);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, parsed.content, { flag: 'wx', mode: 0o600 });
    try {
      const result = transaction(() => {
        let order, reason, before;
        if (requestId) {
          order = request(requestId);
          versions(order, null, input);
          if (!mayHeader(order, user)) error(403, '没有该申报单附件的修改权限');
          reason = editReason(order, input);
          before = order.status === 'submitted' ? requestView(order.id, user, true) : null;
        } else {
          checkedReceipt(receiptId);
          requireMaterial(user, 'materials.acceptance.write');
          text(input.reason, '附件追加原因', 1000);
        }
        const inserted = run(`INSERT INTO material_attachments(request_id,receipt_id,name,mime_type,stored_name,size,actor_id)
          VALUES(?,?,?,?,?,?,?)`, requestId || null, receiptId || null, parsed.name, parsed.mimeType, storedName, parsed.content.length, user.id);
        const attachment = attachmentView(one('SELECT * FROM material_attachments WHERE id=?', inserted.lastInsertRowid));
        if (order) {
          bump(order.id);
          recordRevision(order, user, reason, before);
        }
        log(user, 'UPLOAD', 'material_attachments', attachment.id, parsed.name);
        return { attachment, ...(order ? { request: requestView(order.id, user) } : {}) };
      });
      return result;
    } catch (failure) {
      fs.unlinkSync(destination);
      throw failure;
    }
  }
  function listRequests(url, user, exportAll = false) {
    const status = url.searchParams.get('status');
    if (status && !['draft', 'submitted'].includes(status)) error(400, '申报状态无效');
    const from = date(url.searchParams.get('from') || undefined, '开始日期', true);
    const to = date(url.searchParams.get('to') || undefined, '结束日期', true);
    const filters = [], args = [];
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
    const total = one(`SELECT COUNT(*) AS total ${source}`, ...args).total;
    if (exportAll) {
      if (total > 1000) error(413, '一次最多导出1000张申报单，请缩小筛选范围');
      if (one(`SELECT COUNT(*) AS total FROM material_request_items WHERE request_id IN(SELECT r.id ${source})`, ...args).total > 5000) {
        error(413, '一次最多导出5000条申报明细，请缩小筛选范围');
      }
      return all(`SELECT r.id ${source} ORDER BY r.id DESC`, ...args).map(row => requestView(row.id, user));
    }
    const { page, pageSize, offset } = pageInput(url);
    const rows = all(`SELECT r.id,r.no,r.title,r.description,r.status,r.created_by,r.created_at,
      r.submitted_by,r.submitted_at,r.version,r.revision,u.display_name AS creator_name,
      (SELECT COUNT(*) FROM material_request_items i WHERE i.request_id=r.id) AS item_count,
      (SELECT COUNT(*) FROM material_request_items i WHERE i.request_id=r.id AND i.qty_m>
        COALESCE((SELECT SUM(e.qty_m+e.closed_qty_m) FROM material_receipts e WHERE e.item_id=i.id),0)) AS pending_items
      ${source} ORDER BY r.id DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset);
    return { items: rows.map(row => ({ id: row.id, no: row.no, title: row.title, description: row.description,
      status: row.status, createdBy: row.created_by, creatorName: row.creator_name, createdAt: row.created_at,
      submittedBy: row.submitted_by, submittedAt: row.submitted_at, version: row.version, revision: row.revision,
      itemCount: row.item_count, progress: { pendingItems: row.pending_items }, canEditHeader: mayHeader(row, user),
      canAddItem: row.status === 'draft', canSubmit: row.status === 'draft' && row.item_count > 0 && material(user, 'materials.request.submit')
    })), total, page, pageSize };
  }
  function listAcceptance(url, user) {
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
    const total = one(`${source} SELECT COUNT(*) AS total FROM accepted a${where}`, ...args).total;
    const { page, pageSize, offset } = pageInput(url);
    const rows = all(`${source} SELECT * FROM accepted a${where} ORDER BY a.request_id DESC,a.id LIMIT ? OFFSET ?`, ...args, pageSize, offset);
    return { items: rows.map(row => ({ ...itemView(row, { status: 'submitted' }, user), requestNo: row.request_no,
      requestTitle: row.request_title, requestVersion: row.request_version, requestRevision: row.request_revision,
      requestCreatedAt: row.request_created_at })), total, page, pageSize };
  }
  async function dispatch(req, res, url, initialUser) {
    const route = url.pathname.slice('/api/materials'.length) || '/';
    const method = req.method;
    const input = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(method) ? await body(req) : {};
    const user = tokenUser ? tokenUser(req) : initialUser;
    if (!user) error(401, '请先登录');
    const reply = (value, status = 200) => send(res, status, scrub(value, user));
    let match;
    if (route === '/meta' && method === 'GET') return reply({ capabilities: capability(user), warehouses: WAREHOUSES,
      openingClosed: openingClosed(), quantityScale: 1000, amountScale: 100 });

    if ((match = route.match(/^\/(categories|regions)$/))) {
      const table = match[1] === 'categories' ? 'material_categories' : 'material_regions';
      if (method === 'GET') {
        const rows = all(`SELECT * FROM ${table} ORDER BY id`).map(row => ({ id: row.id, name: row.name, createdBy: row.created_by, createdAt: row.created_at }));
        return reply(paginate(search(rows, url, ['name']), url));
      }
      if (method === 'POST') {
        requireManager(user, `materials.${match[1]}.write`);
        const name = text(input.name, '名称', 80);
        if (one(`SELECT 1 FROM ${table} WHERE name=?`, name)) error(409, '同名选项已存在');
        const inserted = transaction(() => {
          const result = run(`INSERT INTO ${table}(name,created_by) VALUES(?,?)`, name, user.id);
          log(user, 'CREATE', table, result.lastInsertRowid, name);
          return one(`SELECT * FROM ${table} WHERE id=?`, result.lastInsertRowid);
        });
        return reply({ id: inserted.id, name: inserted.name, createdBy: inserted.created_by, createdAt: inserted.created_at }, 201);
      }
    }
    if ((match = route.match(/^\/catalog\/(\d+)\/barcodes$/))) {
      const master = catalog(match[1]);
      if (method === 'GET') return reply(paginate(all('SELECT * FROM material_barcodes WHERE catalog_id=? ORDER BY id', master.id).map(barcodeView), url));
      if (method === 'POST') {
        requireManager(user, 'materials.catalog.write');
        const code = packageBarcode(input.code), reason = text(input.reason, '条码绑定原因', 1000);
        const result = transaction(() => {
          const existing = one('SELECT * FROM material_barcodes WHERE code=?', code);
          if (existing) {
            if (existing.catalog_id !== master.id) conflict('该条码已绑定其他物资，请核对后先解除原绑定');
            return { barcode: barcodeView(existing), created: false };
          }
          const saved = run('INSERT INTO material_barcodes(code,catalog_id,created_by) VALUES(?,?,?)', code, master.id, user.id);
          log(user, 'BIND_BARCODE', 'material_barcodes', saved.lastInsertRowid, JSON.stringify({ catalogId: master.id, code, reason }));
          return { barcode: barcodeView(one('SELECT * FROM material_barcodes WHERE id=?', saved.lastInsertRowid)), created: true };
        });
        return reply({ barcode: result.barcode }, result.created ? 201 : 200);
      }
    }
    if ((match = route.match(/^\/barcodes\/(\d+)$/)) && method === 'DELETE') {
      requireManager(user, 'materials.catalog.write');
      const reason = text(input.reason, '解除条码绑定原因', 1000);
      transaction(() => {
        const row = one('SELECT * FROM material_barcodes WHERE id=?', integer(match[1]));
        if (!row) error(404, '条码绑定不存在，请重新读取');
        run('DELETE FROM material_barcodes WHERE id=?', row.id);
        log(user, 'UNBIND_BARCODE', 'material_barcodes', row.id, JSON.stringify({ catalogId: row.catalog_id, code: row.code, reason }));
      });
      return reply({ deleted: true });
    }
    if (route === '/scan/resolve' && method === 'POST') {
      const code = barcodeCode(input.code);
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
        const master = one('SELECT * FROM material_catalog WHERE id=? AND code=?', saved.catalogId, saved.catalogCode);
        if (!master) error(404, '系统二维码对应的物资不存在，请核对当前系统');
        const query = new URL('http://materials.local/stock/batches');
        for (const key of ['catalogId', 'regionId', 'warehouse', 'batch', 'expiryDate']) query.searchParams.set(key, saved[key]);
        const batch = stockRows(query, false, true)[0];
        if (!batch) error(404, '系统二维码对应的库存批次不存在');
        return reply({ kind: 'stock', catalog: catalogView(master), batch });
      }
      const barcode = one('SELECT * FROM material_barcodes WHERE code=?', code);
      if (!barcode) error(404, '该条码尚未绑定物资主档');
      return reply({ kind: 'catalog', catalog: catalogView(catalog(barcode.catalog_id)), barcode: barcodeView(barcode) });
    }
    if (route === '/catalog') {
      if (method === 'GET') {
        let rows = all(`SELECT c.*,d.name AS category_name FROM material_catalog c JOIN material_categories d ON d.id=c.category_id ORDER BY c.id`)
          .map(row => ({ id: row.id, code: row.code, name: row.name, spec: row.spec, unit: row.unit,
            categoryId: row.category_id, categoryName: row.category_name, version: row.version }));
        if (url.searchParams.has('categoryId')) rows = rows.filter(row => String(row.categoryId) === url.searchParams.get('categoryId'));
        return reply(paginate(search(rows, url, ['code', 'name', 'spec']), url));
      }
      if (method === 'POST') {
        requireManager(user, 'materials.catalog.write');
        const code = text(input.code, '物资编码', 64).toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(code)) error(400, '编码须由英文字母、数字及 . _ / - 组成');
        const name = text(input.name, '物资名称'), spec = text(input.spec, '规格'), unit = text(input.unit, '单位', 30);
        const category = dictionary('material_categories', input.categoryId, '分类');
        if (one('SELECT 1 FROM material_catalog WHERE code=?', code)) error(409, '物资编码已存在，不能重新定义');
        const result = transaction(() => {
          const inserted = run('INSERT INTO material_catalog(code,name,spec,unit,category_id,created_by) VALUES(?,?,?,?,?,?)', code, name, spec, unit, category.id, user.id);
          log(user, 'CREATE', 'material_catalog', inserted.lastInsertRowid, code);
          return Number(inserted.lastInsertRowid);
        });
        return reply({ id: result, code, name, spec, unit, categoryId: category.id, categoryName: category.name, version: 1 }, 201);
      }
    }
    if (route === '/requests') {
      if (method === 'GET') return reply(listRequests(url, user));
      if (method === 'POST') {
        const title = text(input.title, '申报标题'), description = text(input.description ?? '', '说明', 5000, true);
        const id = transaction(() => {
          const no = 'WZ-' + today().replaceAll('-', '') + '-' + crypto.randomBytes(6).toString('hex').toUpperCase();
          const result = run('INSERT INTO material_requests(no,title,description,created_by) VALUES(?,?,?,?)', no, title, description, user.id);
          log(user, 'CREATE', 'material_requests', result.lastInsertRowid, no);
          return Number(result.lastInsertRowid);
        });
        return reply(requestView(id, user), 201);
      }
    }
    if ((match = route.match(/^\/requests\/(\d+)$/))) {
      const orderId = integer(match[1]);
      if (method === 'GET') return reply(requestView(orderId, user));
      if (method === 'PATCH') {
        const result = transaction(() => {
          const order = request(orderId);
          versions(order, null, input);
          if (!mayHeader(order, user)) error(403, '没有该申报单表头的修改权限');
          const reason = editReason(order, input);
          const title = input.title === undefined ? order.title : text(input.title, '标题');
          const description = input.description === undefined ? order.description : text(input.description, '说明', 5000, true);
          if (title === order.title && description === order.description) return requestView(order.id, user);
          const before = order.status === 'submitted' ? requestView(order.id, user, true) : null;
          run('UPDATE material_requests SET title=?,description=? WHERE id=?', title, description, order.id);
          bump(order.id);
          recordRevision(order, user, reason, before);
          log(user, 'UPDATE', 'material_requests', order.id, reason);
          return requestView(order.id, user);
        });
        return reply(result);
      }
    }
    if ((match = route.match(/^\/requests\/(\d+)\/items(?:\/(\d+))?$/))) {
      const orderId = integer(match[1]), itemId = match[2] ? integer(match[2]) : null;
      if ((method === 'POST' && !itemId) || (['PATCH', 'DELETE'].includes(method) && itemId)) {
        const result = transaction(() => {
          const order = request(orderId), old = itemId ? item(order.id, itemId) : null;
          if (method === 'POST') {
            integer(input.requestVersion, '读取时的单据版本');
          } else versions(order, old, input);
          if (input.authorId !== undefined || input.author_id !== undefined) error(400, '填报人由会话确定，不能指定他人');
          if (method === 'POST' && order.status !== 'draft') conflict('已提交单不能新增明细');
          if (old && !mayEdit(order, old, user)) error(403, '没有该申报明细的修改权限');
          if (method === 'DELETE') {
            if (order.status !== 'draft') conflict('已提交单不能删除明细');
            run('DELETE FROM material_request_items WHERE id=?', old.id);
            bump(order.id);
            log(user, 'DELETE', 'material_request_items', old.id, order.no);
            return requestView(order.id, user);
          }
          const reason = editReason(order, input);
          const next = lineInput(input, old || {});
          if (old) protectedLine(old, next, input, activity(old.id));
          if (old && Object.keys(next).every(key => next[key] === old[key])) return requestView(order.id, user);
          const before = order.status === 'submitted' ? requestView(order.id, user, true) : null;
          if (old) {
            run(`UPDATE material_request_items SET catalog_id=?,code=?,name=?,spec=?,unit=?,category_id=?,region_id=?,warehouse=?,qty_m=?,purpose=? WHERE id=?`,
              next.catalog_id, next.code, next.name, next.spec, next.unit, next.category_id, next.region_id, next.warehouse, next.qty_m, next.purpose, old.id);
            bump(order.id, old.id);
          } else {
            run(`INSERT INTO material_request_items(request_id,catalog_id,code,name,spec,unit,category_id,region_id,warehouse,qty_m,purpose,author_id)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, order.id, next.catalog_id, next.code, next.name, next.spec, next.unit,
            next.category_id, next.region_id, next.warehouse, next.qty_m, next.purpose, user.id);
            bump(order.id);
          }
          recordRevision(order, user, reason, before);
          log(user, old ? 'UPDATE' : 'CREATE', 'material_requests', order.id, reason);
          return requestView(order.id, user);
        });
        return reply(result, method === 'POST' ? 201 : 200);
      }
    }
    if ((match = route.match(/^\/requests\/(\d+)\/submit$/)) && method === 'POST') {
      requireMaterial(user, 'materials.request.submit');
      const result = transaction(() => {
        const order = request(match[1]);
        versions(order, null, input);
        if (order.status !== 'draft') conflict('申报单已提交');
        const items = all('SELECT * FROM material_request_items WHERE request_id=?', order.id);
        if (!items.length) error(400, '提交前须至少有一条有效物资明细');
        run("UPDATE material_requests SET status='submitted',submitted_by=?,submitted_at=?,revision=1,version=version+1 WHERE id=?", user.id, now(), order.id);
        run('UPDATE material_requests SET original_snapshot=? WHERE id=?', JSON.stringify(requestView(order.id, user, true)), order.id);
        log(user, 'SUBMIT', 'material_requests', order.id, order.no);
        return requestView(order.id, user);
      });
      return reply(result);
    }
    if ((match = route.match(/^\/requests\/(\d+)\/revisions$/)) && method === 'GET') {
      const order = request(match[1]);
      const revisions = all('SELECT * FROM material_request_revisions WHERE request_id=? ORDER BY revision', order.id).map(row => ({
        id: row.id, revision: row.revision, reason: row.reason, actorId: row.actor_id, actorName: actorName(row.actor_id),
        createdAt: row.created_at, before: JSON.parse(row.before_snapshot), after: JSON.parse(row.after_snapshot)
      }));
      return reply({ originalSnapshot: order.original_snapshot ? JSON.parse(order.original_snapshot) : null, revisions });
    }
    if (route === '/acceptance' && method === 'GET') {
      return reply(listAcceptance(url, user));
    }
    if (route === '/receipts') {
      if (method === 'GET') {
        const filters = [], args = [];
        for (const [parameter, column] of [['requestId', 'request_id'], ['itemId', 'item_id']]) {
          if (url.searchParams.has(parameter)) { filters.push(`e.${column}=?`); args.push(integer(url.searchParams.get(parameter))); }
        }
        const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
        const total = one(`SELECT COUNT(*) AS total FROM material_receipts e${where}`, ...args).total;
        const { page, pageSize, offset } = pageInput(url);
        const rows = all(`SELECT e.*,u.display_name AS actor_name,
          EXISTS(SELECT 1 FROM material_receipts x WHERE x.type='reversal' AND x.original_receipt_id=e.id) AS is_reversed
          FROM material_receipts e JOIN users u ON u.id=e.actor_id${where} ORDER BY e.id DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset);
        return reply({ items: rows.map(receiptView), total, page, pageSize });
      }
      if (method === 'POST') {
        const result = receiptAction(user, input, route, 'receive');
        return reply(result.value, result.status);
      }
    }
    if ((match = route.match(/^\/requests\/(\d+)\/items\/(\d+)\/close$/)) && method === 'POST') {
      const result = receiptAction(user, input, route, 'close', match[1], match[2]);
      return reply(result.value, result.status);
    }
    if ((match = route.match(/^\/receipts\/(\d+)\/reverse$/)) && method === 'POST') {
      const result = receiptAction(user, input, route, 'reverse', null, null, match[1]);
      return reply(result.value, result.status);
    }
    if (route === '/issues' && method === 'GET') return reply(listIssues(url, user));
    if ((match = route.match(/^\/issues\/(\d+)$/)) && method === 'GET') return reply({ issue: issueView(checkedIssue(match[1], user), user) });
    if (route === '/issues' && method === 'POST') {
      const result = idempotent(user, route, input, () => {
        const identity = stockIdentity(input), balance = batchBalance(identity);
        const quantity = decimal(input.quantity, 3, '领用数量');
        if (balance.qty < quantity) conflict('该批次可用库存不足，不能提交领用申请');
        const purpose = text(input.purpose, '领用用途', 1000);
        const snapshot = { ...JSON.parse(balance.movements[0].snapshot), batch: identity.batch, expiryDate: identity.expiry_date,
          location: stockLocation(identity)?.location || '', createdBy: user.id };
        const result = run(`INSERT INTO material_issues(catalog_id,region_id,warehouse,batch,expiry_date,qty_m,snapshot,purpose,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, ...identityArgs(identity), quantity, JSON.stringify(snapshot), purpose, user.id, now());
        const issue = issueView(checkedIssue(result.lastInsertRowid, user), user);
        log(user, 'CREATE_ISSUE', 'material_issues', issue.id, purpose);
        return { issue };
      });
      return reply(result.value, result.status);
    }
    if ((match = route.match(/^\/issues\/(\d+)\/(issue|reject|cancel)$/)) && method === 'POST') {
      const result = issueAction(user, match[1], input, route, match[2]);
      return reply(result.value, result.status);
    }
    if (route === '/stock/location' && method === 'PUT') {
      requireManager(user, 'materials.stock.location');
      const location = transaction(() => {
        const identity = stockIdentity(input), current = stockLocation(identity);
        if (!Number.isSafeInteger(input.version) || input.version < 0) error(400, '请提供读取时的位置整数版本');
        if (input.version !== (current?.version || 0)) conflict('库存位置已变化，请重新读取后修改');
        if (!batchBalance(identity).movements.length) error(400, '只能维护已有库存流水批次的位置');
        const value = text(input.location, '库存位置', 200, true), reason = text(input.reason, '位置修改原因', 1000);
        run(`INSERT INTO material_stock_locations(catalog_id,region_id,warehouse,batch,expiry_date,location,version,reason,actor_id,updated_at)
          VALUES(?,?,?,?,?,?,1,?,?,?) ON CONFLICT(catalog_id,warehouse,region_id,batch,expiry_date)
          DO UPDATE SET location=excluded.location,version=material_stock_locations.version+1,reason=excluded.reason,actor_id=excluded.actor_id,updated_at=excluded.updated_at`,
        ...identityArgs(identity), value, reason, user.id, now());
        const saved = stockLocation(identity);
        log(user, 'LOCATION', 'material_stock_locations', saved.id, reason);
        return locationView(saved);
      });
      return reply({ location });
    }
    if (route === '/stock' && method === 'GET') return reply(stockRows(url, true));
    if (route === '/stock/batches' && method === 'GET') return reply(stockRows(url, true, true));
    if (route === '/stock/movements' && method === 'GET') {
      const filters = [], args = [];
      for (const [parameter, column] of [['catalogId', 'catalog_id'], ['regionId', 'region_id'], ['warehouse', 'warehouse'], ['batch', 'batch'], ['expiryDate', 'expiry_date']]) {
        if (url.searchParams.has(parameter)) {
          filters.push(`m.${column}=?`);
          const value = url.searchParams.get(parameter);
          args.push(parameter === 'warehouse' ? warehouse(value) : parameter === 'batch' ? text(value, '批号', 100, true) :
            parameter === 'expiryDate' ? date(value, '有效期', true) : integer(value));
        }
      }
      const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
      const total = one(`SELECT COUNT(*) AS total FROM material_stock_movements m${where}`, ...args).total;
      const { page, pageSize, offset } = pageInput(url);
      const rows = all(`SELECT m.*,u.display_name AS actor_name FROM material_stock_movements m JOIN users u ON u.id=m.actor_id
        ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset);
      return reply({ items: rows.map(movementView), total, page, pageSize });
    }
    if (route === '/stock/opening/close' && method === 'POST') {
      requireMaterial(user, 'materials.stock.initialize');
      const reason = text(input.reason, '关闭原因', 1000);
      transaction(() => { closeOpening(); log(user, 'CLOSE_OPENING', 'material_state', 0, reason); });
      return reply({ openingClosed: true });
    }
    if (['/stock/opening', '/stock/adjustments'].includes(route) && method === 'POST') {
      const isOpening = route === '/stock/opening';
      requireMaterial(user, isOpening ? 'materials.stock.initialize' : 'materials.stock.adjust');
      const result = idempotent(user, route, input, key => {
        if (isOpening && openingClosed()) conflict('期初登记已经关闭，请使用有原因的库存调整');
        const master = catalog(input.catalogId), region = dictionary('material_regions', input.regionId, '区域');
        const category = dictionary('material_categories', input.categoryId ?? master.category_id, '分类');
        const target = warehouse(input.warehouse);
        const quantity = decimal(input.quantity, 3, '数量'), amount = decimal(input.amount, 2, '总金额', true);
        if (amount === 0 && isOpening) text(input.zeroAmountReason, '零金额原因', 1000);
        const reason = isOpening ? text(input.zeroAmountReason || '期初登记', '登记原因', 1000) : text(input.reason, '调整原因', 1000);
        const direction = isOpening || input.direction === 'increase' ? 1 : input.direction === 'decrease' ? -1 : 0;
        if (!direction) error(400, '调整方向须为increase或decrease');
        const snapshot = { catalogId: master.id, code: master.code, name: master.name, spec: master.spec, unit: master.unit,
          categoryId: category.id, categoryName: category.name, regionId: region.id, regionName: region.name, warehouse: target };
        const movement = addMovement({ type: isOpening ? 'opening' : 'adjustment', catalog_id: master.id,
          region_id: region.id, warehouse: target, qty_m: direction * quantity, amount_cents: direction * amount,
          source_key: `${isOpening ? 'opening' : 'adjustment'}:${user.id}:${key}`, snapshot,
          batch: text(input.batch ?? '', '批号', 100, true), expiry_date: date(input.expiryDate, '有效期', true),
          date: date(input.date), reason }, user);
        log(user, isOpening ? 'OPENING' : 'ADJUST', 'material_stock_movements', movement.id, reason);
        return { movement, openingClosed: openingClosed() };
      });
      return reply(result.value, result.status);
    }
    if ((match = route.match(/^\/(requests|receipts)\/(\d+)\/attachments$/))) {
      const isRequest = match[1] === 'requests', id = integer(match[2]);
      if (isRequest) request(id); else checkedReceipt(id);
      if (method === 'GET') {
        if (!isRequest && !permit(user, 'materials.amount.read')) error(403, '验收附件需要金额读取权限');
        const column = isRequest ? 'request_id' : 'receipt_id';
        return reply({ items: all(`SELECT * FROM material_attachments WHERE ${column}=? AND active=1 ORDER BY id`, id).map(attachmentView) });
      }
      if (method === 'POST') return reply(saveAttachment(user, input, isRequest ? id : null, isRequest ? null : id), 201);
    }
    if ((match = route.match(/^\/attachments\/(\d+)(\/download)?$/))) {
      const attachment = one('SELECT * FROM material_attachments WHERE id=?', integer(match[1]));
      if (!attachment) error(404, '附件不存在');
      if (method === 'GET' && match[2]) {
        if (attachment.receipt_id && !permit(user, 'materials.amount.read')) error(403, '验收附件需要金额读取权限');
        const file = attachmentPath(attachment.stored_name);
        if (!fs.existsSync(file)) error(404, '附件文件缺失');
        res.writeHead(200, { 'Content-Type': attachment.mime_type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
          'Content-Length': attachment.size, 'X-Content-Type-Options': 'nosniff' });
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
        return;
      }
      if (method === 'DELETE' && !match[2]) {
        if (!attachment.request_id) error(403, '已记账验收附件不能移除');
        const result = transaction(() => {
          const order = request(attachment.request_id);
          versions(order, null, input);
          if (!mayHeader(order, user)) error(403, '无权修改申报附件');
          const reason = editReason(order, input), before = order.status === 'submitted' ? requestView(order.id, user, true) : null;
          if (attachment.active) {
            run('UPDATE material_attachments SET active=0 WHERE id=?', attachment.id);
            bump(order.id);
            recordRevision(order, user, reason, before);
            log(user, 'REMOVE', 'material_attachments', attachment.id, reason);
          }
          return { request: requestView(order.id, user) };
        });
        return reply(result);
      }
    }
    if (route === '/backup' && method === 'GET') {
      const value = backup(user);
      res.setHeader('Content-Disposition', `attachment; filename="labos-materials-${today()}.json"`);
      return reply(value);
    }
    if (route === '/restore' && method === 'POST') return reply(restore(input, user));
    if (route === '/export.xlsx' && method === 'GET') return exportWorkbook(res, url, user);
    error(404, '物资接口不存在');
  }
  async function handle(req, res, url, user) {
    if (url.pathname !== '/api/materials' && !url.pathname.startsWith('/api/materials/')) return false;
    try {
      await dispatch(req, res, url, user);
    } catch (failure) {
      if (res.headersSent) res.destroy();
      else if (failure.status) send(res, failure.status, { error: failure.message, ...(failure.code ? { code: failure.code } : {}) });
      else if (/UNIQUE constraint/.test(failure.message)) send(res, 409, { error: '唯一编号或来源重复，操作未保存' });
      else if (/constraint failed|FOREIGN KEY/.test(failure.message)) send(res, 400, { error: '业务数据违反完整性约束，操作未保存' });
      else if (/locked|busy/i.test(failure.message)) send(res, 503, { error: '数据库正在处理其他写入，请稍后重试原操作' });
      else {
        console.error('Materials request failed', failure);
        send(res, 500, { error: '物资操作失败，未确认的写入请使用原请求号重试' });
      }
    }
    return true;
  }

  function backup(user) {
    if (!permit(user, 'backup.read') || !permit(user, 'materials.amount.read')) error(403, '完整物资备份需要备份及金额读取权限');
    const data = Object.fromEntries(TABLES.map(table => [table, all(`SELECT * FROM ${table}`)]));
    let totalBytes = 0;
    const files = data.material_attachments.map(row => {
      const file = attachmentPath(row.stored_name);
      if (!fs.existsSync(file)) error(409, `附件 ${row.id} 缺失，不能生成声称完整的物资备份`);
      const contents = fs.readFileSync(file);
      if (contents.length !== row.size) error(409, `附件 ${row.id} 大小不符，请先检查存储`);
      totalBytes = safeSum([totalBytes, contents.length]);
      if (totalBytes > BACKUP_LIMIT) error(413, '附件总量超过在线业务备份上限，请停服备份完整运行目录');
      return { id: row.id, content: contents.toString('base64'), sha256: crypto.createHash('sha256').update(contents).digest('hex') };
    });
    const result = { type: 'labos-materials-backup', schemaVersion: 3, generatedAt: now(),
      users: all('SELECT id,username FROM users ORDER BY id'), data, files };
    if (Buffer.byteLength(JSON.stringify(result)) > 25 * 1024 * 1024) error(413, '业务JSON备份超过在线恢复上限，请停服备份完整运行目录');
    return result;
  }
  function remapSnapshot(value, mapping) {
    const userKeys = new Set(['createdBy', 'submittedBy', 'authorId', 'actorId', 'userId', 'processedBy']);
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
  function validateRestoredLedger() {
    for (const row of all('SELECT * FROM material_barcodes')) {
      if (packageBarcode(row.code) !== row.code) error(400, '条码内容未规范化');
      catalog(row.catalog_id);
    }
    if (!openingClosed() && one("SELECT 1 FROM material_receipts WHERE type='acceptance' LIMIT 1")) {
      error(400, '存在合格验收历史时不能恢复为开放期初');
    }
    for (const order of all('SELECT * FROM material_requests')) {
      if (order.status === 'submitted') {
        if (!order.original_snapshot || !order.submitted_by || order.revision < 1) error(400, '已提交单缺少原始提交信息');
        const original = JSON.parse(order.original_snapshot);
        if (original.id !== order.id || original.revision !== 1 || original.status !== 'submitted') error(400, '原提交快照无效');
        const revisions = all('SELECT revision FROM material_request_revisions WHERE request_id=? ORDER BY revision', order.id);
        if (revisions.length !== order.revision - 1 || revisions.some((entry, index) => entry.revision !== index + 2)) error(400, '申报修订历史不连续');
      } else if (order.revision !== 0 || order.original_snapshot) error(400, '草稿不能包含已提交快照');
      for (const line of all('SELECT * FROM material_request_items WHERE request_id=?', order.id)) {
        const counts = activity(line.id);
        if (counts.accepted < 0 || counts.closed < 0 || safeSum([counts.accepted, counts.closed]) > line.qty_m) error(400, '验收、结案数量与申报数量不一致');
        if (counts.exists && order.status !== 'submitted') error(400, '草稿不能有验收事件');
      }
    }
    for (const event of all('SELECT * FROM material_receipts')) {
      const order = request(event.request_id), line = item(order.id, event.item_id), snapshot = JSON.parse(event.snapshot);
      if (event.request_revision < 1 || event.request_revision > order.revision || !Number.isSafeInteger(event.request_revision)) error(400, '验收引用的申报修订号无效');
      if (snapshot.catalogId !== line.catalog_id || snapshot.regionId !== line.region_id || snapshot.warehouse !== line.warehouse || snapshot.unit !== line.unit) error(400, '历史验收物资身份与受保护申报行不一致');
      if (event.type === 'acceptance' || event.type === 'reversal') {
        const rows = all('SELECT * FROM material_stock_movements WHERE receipt_id=?', event.id);
        if (rows.length !== 1 || rows[0].qty_m !== event.qty_m || rows[0].amount_cents !== event.amount_cents) error(400, '验收与库存来源流水无法对账');
        const movement = rows[0];
        if (movement.catalog_id !== snapshot.catalogId || movement.region_id !== snapshot.regionId || movement.warehouse !== snapshot.warehouse ||
          movement.batch !== event.batch || movement.expiry_date !== event.expiry_date ||
          movement.type !== (event.type === 'acceptance' ? 'receipt' : 'reversal')) error(400, '验收流水归属或批次不一致');
      } else if (one('SELECT 1 FROM material_stock_movements WHERE receipt_id=?', event.id)) error(400, '拒收或结案不能产生入库流水');
      if (event.type === 'reversal') {
        const original = checkedReceipt(event.original_receipt_id);
        if (original.type !== 'acceptance' || original.item_id !== event.item_id || original.request_id !== event.request_id ||
          original.qty_m !== -event.qty_m || original.amount_cents !== -event.amount_cents) error(400, '冲正没有精确对应原验收');
      }
    }
    for (const row of all('SELECT * FROM material_stock_locations')) {
      warehouse(row.warehouse);
      if (text(row.batch, '批号', 100, true) !== row.batch || date(row.expiry_date, '有效期', true) !== row.expiry_date ||
          text(row.location, '库存位置', 200, true) !== row.location || row.version < 1) error(400, '库存位置数据无效');
      text(row.reason, '位置修改原因', 1000);
      if (!batchBalance(row).movements.length) error(400, '库存位置没有对应的批次流水');
      if (!validTimestamp(row.updated_at)) error(400, '库存位置时间无效');
    }
    for (const row of all('SELECT * FROM material_issues')) {
      warehouse(row.warehouse);
      if (text(row.batch, '批号', 100, true) !== row.batch || date(row.expiry_date, '有效期', true) !== row.expiry_date ||
          row.qty_m <= 0 || row.amount_cents < 0 || !validTimestamp(row.created_at)) error(400, '领用数量、批次或时间无效');
      text(row.purpose, '领用用途', 1000);
      const snapshot = JSON.parse(row.snapshot);
      if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object' || snapshot.catalogId !== row.catalog_id ||
          snapshot.regionId !== row.region_id || snapshot.warehouse !== row.warehouse || snapshot.batch !== row.batch ||
          snapshot.expiryDate !== row.expiry_date || snapshot.createdBy !== row.created_by) error(400, '领用申请快照身份无效');
      for (const key of ['code', 'name', 'spec', 'unit', 'categoryName', 'regionName']) text(snapshot[key], '领用快照物资信息', 200);
      dictionary('material_categories', snapshot.categoryId, '快照分类');
      text(snapshot.location, '申请时位置', 200, true);
      const movements = all("SELECT * FROM material_stock_movements WHERE source_key=?", `issue:${row.id}`);
      if (row.status === 'pending') {
        if (row.version !== 1 || row.processed_by !== null || row.processed_at !== null || row.reason !== '' || row.amount_cents !== 0 || movements.length) error(400, '待发放申请不能包含处理或库存记录');
      } else {
        if (row.version !== 2 || row.processed_by === null || !validTimestamp(row.processed_at) || row.processed_at < row.created_at) error(400, '领用处理信息无效');
        if (row.status === 'issued') {
          if (row.reason !== '' || movements.length !== 1) error(400, '发放申请缺少唯一来源流水');
          const movement = movements[0], saved = JSON.parse(movement.snapshot);
          if (movement.type !== 'issue' || movement.qty_m !== -row.qty_m || movement.amount_cents !== -row.amount_cents ||
              movement.catalog_id !== row.catalog_id || movement.region_id !== row.region_id || movement.warehouse !== row.warehouse ||
              movement.batch !== row.batch || movement.expiry_date !== row.expiry_date || movement.actor_id !== row.processed_by ||
              movement.date !== row.processed_at.slice(0, 10) || stableJson({ ...saved, location: snapshot.location }) !== stableJson(snapshot)) error(400, '领用申请与发放流水无法对账');
          text(saved.location, '发放时位置', 200, true);
        } else {
          if (!['rejected', 'cancelled'].includes(row.status) || movements.length || row.amount_cents !== 0 ||
              (row.status === 'cancelled' && row.processed_by !== row.created_by)) error(400, '取消或驳回申请不能产生库存流水');
          text(row.reason, '处理原因', 1000);
        }
      }
    }
    const batches = new Map();
    for (const row of all('SELECT * FROM material_stock_movements ORDER BY id')) {
      warehouse(row.warehouse);
      const snapshot = JSON.parse(row.snapshot);
      if (!snapshot || snapshot.catalogId !== row.catalog_id || snapshot.regionId !== row.region_id || snapshot.warehouse !== row.warehouse) error(400, '库存快照与流水归属不一致');
      if (['receipt', 'reversal'].includes(row.type) !== Boolean(row.receipt_id)) error(400, '库存来源引用无效');
      if (row.receipt_id && row.source_key !== `receipt:${row.receipt_id}`) error(400, '验收库存来源键无效');
      const key = JSON.stringify([row.catalog_id, row.region_id, row.warehouse, row.batch, row.expiry_date]);
      const previous = batches.get(key) || { qty: 0, amount: 0 };
      if (row.type === 'issue') {
        const match = row.source_key.match(/^issue:([1-9]\d*)$/), issue = match && one('SELECT * FROM material_issues WHERE id=?', Number(match[1]));
        if (!issue || issue.status !== 'issued' || row.qty_m >= 0 || -row.qty_m > previous.qty || previous.qty <= 0 ||
            row.amount_cents !== -issueAmount(-row.qty_m, previous)) error(400, '领用流水缺少申请或成本分摊不一致');
      } else if (row.source_key.startsWith('issue:')) error(400, '非领用流水不能占用领用来源');
      const qty = safeSum([previous.qty, row.qty_m]), amount = safeSum([previous.amount, row.amount_cents]);
      if (qty < 0 || amount < 0) error(400, '备份存在负库存或无来源冲减');
      batches.set(key, { qty, amount });
    }
    stockRows();
    const badForeignKeys = all('PRAGMA foreign_key_check').filter(row => row.table.startsWith('material_'));
    if (badForeignKeys.length) error(400, '备份业务关联不完整');
  }
  function validTimestamp(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }
  function restore(payload, user) {
    if (!permit(user, 'backup.restore') || !permit(user, 'materials.amount.read')) error(403, '完整物资恢复需要恢复及金额读取权限');
    const topKeys = ['type', 'schemaVersion', 'generatedAt', 'users', 'data', 'files'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some(key => !topKeys.includes(key)) || topKeys.some(key => !Object.hasOwn(payload, key)) ||
        payload.type !== 'labos-materials-backup' || ![1, 2, 3].includes(payload.schemaVersion) || !payload.data ||
        typeof payload.data !== 'object' || Array.isArray(payload.data) ||
        !Array.isArray(payload.users) || !Array.isArray(payload.files)) error(400, '无效的完整物资备份格式');
    const sourceTables = payload.schemaVersion === 1 ? V1_TABLES : payload.schemaVersion === 2 ? V2_TABLES : TABLES;
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
      const current = one('SELECT id FROM users WHERE username=?', username);
      if (!current) error(400, `请先创建备份中的账号：${username}`);
      mapping.set(id, current.id);
      usernames.add(username);
    }
    const userColumns = new Set(['created_by', 'submitted_by', 'author_id', 'actor_id', 'processed_by']);
    const jsonColumns = new Set(['original_snapshot', 'before_snapshot', 'after_snapshot', 'snapshot', 'response']);
    const normalized = {};
    for (const table of TABLES) {
      const columns = all(`PRAGMA table_info(${table})`);
      const allowed = new Map(columns.map(column => [column.name, column]));
      normalized[table] = (payload.data[table] || []).map(source => {
        if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !allowed.has(key)) || columns.some(column => !Object.hasOwn(source, column.name))) error(400, `备份表 ${table} 字段无效`);
        const row = {};
        for (const [key, value] of Object.entries(source)) {
          const type = allowed.get(key).type;
          if (value !== null && (type === 'INTEGER' ? !Number.isSafeInteger(value) : typeof value !== 'string')) error(400, `备份表 ${table} 字段类型无效`);
          if (value !== null && (key === 'id' || key.endsWith('_id')) && value <= 0) error(400, '备份业务ID必须为正整数');
          if (userColumns.has(key) && value !== null) {
            if (!mapping.has(value)) error(400, '备份业务数据引用了未映射用户');
            row[key] = mapping.get(value);
          } else if (jsonColumns.has(key) && value !== null) {
            let parsed;
            try { parsed = JSON.parse(value); } catch { error(400, '备份快照JSON无效'); }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) error(400, '备份快照必须是对象');
            row[key] = JSON.stringify(remapSnapshot(parsed, mapping));
          } else row[key] = value;
        }
        return row;
      });
    }
    if (normalized.material_state.some(row => !['opening_closed', 'restored_once'].includes(row.key) || !['0', '1'].includes(row.value)) ||
        normalized.material_state.filter(row => row.key === 'opening_closed').length !== 1) error(400, '备份期初状态无效');
    const barcodeCodes = new Set();
    for (const row of normalized.material_barcodes) {
      if (packageBarcode(row.code) !== row.code || barcodeCodes.has(row.code)) error(400, '备份条码未规范化或存在重复绑定');
      barcodeCodes.add(row.code);
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
      byteCount = safeSum([byteCount, parsed.content.length]);
      if (byteCount > BACKUP_LIMIT) error(413, '附件内容超过在线恢复上限');
      contents.set(file.id, parsed.content);
    }
    if (contents.size !== normalized.material_attachments.length) error(400, '完整备份缺少附件内容');
    const written = [];
    try {
      return transaction(() => {
        if (TABLES.some(table => table !== 'material_state' && one(`SELECT 1 FROM ${table} LIMIT 1`)) ||
            openingClosed() || one("SELECT 1 FROM material_state WHERE key='restored_once'")) conflict('只能恢复到空的新物资业务库，禁止追加或重复恢复');
        run('DELETE FROM material_state');
        for (const table of TABLES) {
          for (const originalRow of normalized[table]) {
            const row = { ...originalRow };
            if (table === 'material_attachments') {
              row.stored_name = crypto.randomUUID() + '.bin';
              const destination = attachmentPath(row.stored_name);
              fs.mkdirSync(path.dirname(destination), { recursive: true });
              fs.writeFileSync(destination, contents.get(row.id), { flag: 'wx', mode: 0o600 });
              written.push(destination);
            }
            const keys = Object.keys(row);
            run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(key => row[key]));
          }
        }
        validateRestoredLedger();
        run("INSERT INTO material_state(key,value) VALUES('restored_once','1') ON CONFLICT(key) DO UPDATE SET value='1'");
        log(user, 'RESTORE', 'material_backup', 0, '恢复完整物资业务备份');
        return { restored: true, counts: Object.fromEntries(TABLES.map(table => [table, normalized[table].length])) };
      });
    } catch (failure) {
      for (const file of written) {
        try { fs.unlinkSync(file); } catch (cleanupFailure) { if (cleanupFailure.code !== 'ENOENT') console.error('Cannot remove failed materials restore file'); }
      }
      throw failure;
    }
  }
  async function exportWorkbook(res, url, user) {
    if (!permit(user, 'materials.export')) error(403, '没有物资Excel导出权限');
    const amount = permit(user, 'materials.amount.read');
    const cell = value => typeof value === 'number' ? { type: Number, value } : { type: String, value: String(value ?? '') };
    const sheet = (name, headings, rows) => ({ sheet: name, data: [headings.map(value => ({ ...cell(value), fontWeight: 'bold' })), ...rows.map(row => row.map(cell))] });
    const snapshotSummary = value => {
      const serialized = JSON.stringify(scrub(JSON.parse(value), user));
      if (serialized.length <= 32767) return serialized;
      const note = '…（完整快照见修订历史/物资备份）';
      const prefix = serialized.slice(0, 32767 - note.length).replace(/[\uD800-\uDBFF]$/, '');
      return prefix + note;
    };
    let sheets;
    if (url.searchParams.get('type') === 'issues') {
      const rows = listIssues(url, user, true);
      if (rows.length > 5000) error(413, '一次最多导出5000条领用申请，请缩小筛选范围');
      sheets = [sheet('领用申请', ['申请ID', '状态', '物资编码', '名称', '规格', '单位', '分类', '仓库', '区域', '批号', '有效期',
        '申请时位置', '当前位置或发放时位置', '领用数量', ...(amount ? ['发放金额（元）'] : []), '用途', '申请人', '申请时间', '处理人', '处理时间', '处理原因'],
      rows.map(row => [row.id, row.status, row.snapshot.code, row.snapshot.name, row.snapshot.spec, row.snapshot.unit,
        row.snapshot.categoryName, row.warehouse, row.snapshot.regionName, row.batch, row.expiryDate, row.snapshot.location, row.location,
        row.qtyM / 1000, ...(amount ? [row.status === 'issued' ? row.amountCents / 100 : null] : []), row.purpose, row.creatorName, row.createdAt, row.processorName, row.processedAt, row.reason]))];
    } else if (url.searchParams.get('type') === 'stock') {
      const rows = stockRows(url);
      const batches = stockRows(url, false, true);
      if (rows.length > 5000 || batches.length > 5000) error(413, '一次最多导出5000条库存或批次，请缩小筛选范围');
      sheets = [
        sheet('库存', ['物资编码', '名称', '规格', '单位', '仓库', '归属区域', '数量', ...(amount ? ['库存总金额（元）'] : [])],
          rows.map(row => [row.code, row.name, row.spec, row.unit, row.warehouse, row.regionName, row.qtyM / 1000, ...(amount ? [row.amountCents / 100] : [])])),
        sheet('批次库存', ['物资编码', '名称', '规格', '单位', '仓库', '归属区域', '批号', '有效期', '库存位置', '数量', ...(amount ? ['库存总金额（元）'] : [])],
          batches.map(row => [row.code, row.name, row.spec, row.unit, row.warehouse, row.regionName, row.batch, row.expiryDate, row.location, row.qtyM / 1000, ...(amount ? [row.amountCents / 100] : [])]))
      ];
    } else {
      let orders = listRequests(url, user, true);
      const original = url.searchParams.get('version') === 'original';
      if (original) orders = orders.map(order => {
        const saved = request(order.id).original_snapshot;
        return saved ? JSON.parse(saved) : order;
      });
      const ids = new Set(orders.map(order => order.id));
      const items = orders.flatMap(order => order.items.map(line => ({ order, line })));
      const receipts = all('SELECT * FROM material_receipts ORDER BY id').filter(row => ids.has(row.request_id)).map(receiptView);
      const revisions = all('SELECT * FROM material_request_revisions ORDER BY request_id,revision').filter(row => ids.has(row.request_id));
      if (orders.length > 1000 || items.length > 5000 || receipts.length > 5000 || revisions.length > 5000) error(413, '导出记录过多，请按日期或单据缩小范围');
      sheets = [
        sheet('申报单信息', ['单号', '主题', '说明', '状态', '修订版', '创建人', '提交时间'], orders.map(order => [order.no, order.title, order.description, order.status, order.revision, order.creatorName, order.submittedAt])),
        sheet('申报明细', ['单号', '物资编码', '名称', '分类', '规格', '单位', '归属区域', '仓库', '申报数量', '用途', '填报人'],
          items.map(({ order, line }) => [order.no, line.code, line.name, line.categoryName, line.spec, line.unit, line.regionName, line.warehouse, line.qtyM / 1000, line.purpose, line.authorName])),
        sheet('验收流水', ['事件ID', '类型', '申报修订版', '物资编码', '名称', '分类', '区域', '仓库', '合格数量', '拒收数量', '结案数量', ...(amount ? ['合格总金额（元）'] : []), '原因', '拒收原因', '日期'],
          receipts.map(event => [event.id, event.type, event.requestRevision, event.snapshot.code, event.snapshot.name, event.snapshot.categoryName, event.snapshot.regionName, event.snapshot.warehouse,
            event.qtyM / 1000, event.rejectedQtyM / 1000, event.closedQtyM / 1000, ...(amount ? [event.amountCents / 100] : []), event.reason, event.rejectedReason, event.date])),
        sheet('修订记录', ['申报单ID', '修订版', '修改原因', '操作人', '时间', '修改前快照摘要', '修改后快照摘要'],
          revisions.map(row => [row.request_id, row.revision, row.reason, actorName(row.actor_id), row.created_at,
            snapshotSummary(row.before_snapshot), snapshotSummary(row.after_snapshot)]))
      ];
    }
    const exporter = writeXlsx || require('write-excel-file/node').default;
    const buffer = await exporter(sheets).toBuffer();
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="labos-materials-${today()}.xlsx"`, 'Content-Length': buffer.length });
    res.end(buffer);
  }

  return { handle, backup, restore };
}

module.exports = createMaterials;
module.exports.createMaterials = createMaterials;
