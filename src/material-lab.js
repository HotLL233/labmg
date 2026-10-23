'use strict';

function createMaterialLab({ db, fail, hasPermission, log, validTimestamp }) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const error = (status, message) => { throw fail(status, message); };
  const conflict = message => { const failure = fail(409, message); failure.code = 'VERSION_CONFLICT'; throw failure; };
  function text(value, label, maximum, optional = false) {
    if (typeof value !== 'string') error(400, `${label}必须是文本`);
    const result = value.trim();
    if ((!optional && !result) || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) error(400, `${label}${optional ? '' : '不能为空，且'}最多${maximum}字，不能含控制字符`);
    return result;
  }
  function integer(value, label = 'ID') {
    if ((typeof value !== 'number' && !/^\d+$/.test(String(value))) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) error(400, `${label}无效`);
    return Number(value);
  }
  function manager(user, permission) {
    if (!String(user?.role || '').split(',').some(role => ['ADMIN', 'MATERIAL'].includes(role)) || !hasPermission(user, permission)) error(403, '此操作须由具有维护权限的系统管理员或物资管理员办理');
  }
  function version(input, row) {
    if (!Number.isSafeInteger(input.version) || input.version < 1) error(400, '请提供读取时的整数版本');
    if (input.version !== row.version) conflict('记录已变化，请读取最新状态后重试');
  }
  const profile = value => {
    if (!['general', 'chemical'].includes(value)) error(400, '分类字段类型请选择通用或化学试剂');
    return value;
  };
  function fields(input, previous = {}) {
    const result = {};
    for (const [key, column, label, maximum] of [
      ['casNumber', 'cas_number', 'CAS号', 12], ['purity', 'purity', '纯度／浓度', 100],
      ['storageConditions', 'storage_conditions', '储存条件', 300], ['sdsUrl', 'sds_url', 'SDS链接', 1000]
    ]) result[column] = text(input[key] === undefined ? previous[column] ?? '' : input[key], label, maximum, true);
    if (result.cas_number) {
      if (!/^[1-9]\d{1,6}-\d{2}-\d$/.test(result.cas_number)) error(400, 'CAS号格式无效，例如64-17-5');
      const digits = result.cas_number.replaceAll('-', '');
      const checksum = [...digits.slice(0, -1)].reverse().reduce((sum, digit, index) => sum + Number(digit) * (index + 1), 0) % 10;
      if (checksum !== Number(digits.at(-1))) error(400, 'CAS号校验位不正确，请核对试剂标签');
    }
    if (result.sds_url) {
      let address;
      try { address = new URL(result.sds_url); } catch { error(400, 'SDS链接须为完整的HTTP或HTTPS地址'); }
      if (!['http:', 'https:'].includes(address.protocol) || !address.hostname || address.username || address.password) error(400, 'SDS链接仅支持不含账号密码的HTTP或HTTPS地址');
    }
    return result;
  }
  const view = row => ({ casNumber: row.cas_number ?? '', purity: row.purity ?? '', storageConditions: row.storage_conditions ?? '', sdsUrl: row.sds_url ?? '' });
  function places(rows) {
    if (rows.length > 1000) error(400, '库位最多1000项');
    const indexed = new Map(rows.map(row => [row.id, row]));
    const visited = new Map(), visiting = new Set();
    function visit(row) {
      if (visited.has(row.id)) return visited.get(row.id);
      if (visiting.has(row.id)) error(400, '库位层级不能形成循环');
      visiting.add(row.id);
      const parent = row.parent_id === null ? null : indexed.get(row.parent_id);
      if (row.parent_id !== null && !parent) error(400, '库位父级不存在');
      const ancestor = parent ? visit(parent) : null;
      const name = text(row.name, '库位名称', 60).normalize('NFKC');
      if (/[\\/]/.test(name)) error(400, '库位名称不能包含斜线，请使用父级表达层级');
      const path = ancestor ? `${ancestor.path} / ${name}` : name;
      const depth = ancestor ? ancestor.depth + 1 : 0;
      if (depth > 7 || path.length > 200) error(400, '库位最多8层，完整路径不能超过200字');
      const value = { id: row.id, name, parentId: row.parent_id, active: row.active === 1,
        effectiveActive: row.active === 1 && (!ancestor || ancestor.effectiveActive), version: row.version, path, depth };
      visiting.delete(row.id);
      visited.set(row.id, value);
      return value;
    }
    return rows.map(visit).sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
  }
  async function unusedPlace(row, rows) {
    if (rows.some(entry => entry.parent_id === row.id)) conflict('库位仍有子库位，请先处理子库位');
    const path = places(rows).find(entry => entry.id === row.id).path;
    if (await one('SELECT 1 FROM material_stock_locations WHERE location=? LIMIT 1', path)) conflict('库位已被库存位置引用，可停用，不能更名、移动或删除');
    if (await one('SELECT 1 FROM material_opening_items WHERE location=? LIMIT 1', path)) conflict('库位已被期初或补录明细引用，可停用，不能更名、移动或删除');
  }
  async function handle(route, method, input, user) {
    let match;
    if ((match = route.match(/^\/categories\/(\d+)\/profile$/)) && method === 'PATCH') {
      manager(user, 'materials.categories.write');
      const value = await db.transaction(async () => {
        const row = await one('SELECT * FROM material_categories WHERE id=?', integer(match[1]));
        if (!row) error(404, '物资分类不存在');
        version(input, row);
        const next = profile(input.profile), reason = text(input.reason, '修改原因', 1000);
        await run('UPDATE material_categories SET profile=?,version=version+1 WHERE id=?', next, row.id);
        await log(user, 'CATEGORY_PROFILE', 'material_categories', row.id, JSON.stringify({ before: row.profile, after: next, reason }));
        return one('SELECT * FROM material_categories WHERE id=?', row.id);
      });
      return { handled: true, value };
    }
    if (route === '/storage-places' && method === 'GET') {
      const items = places(await all('SELECT * FROM material_storage_places'));
      return { handled: true, value: { items, total: items.length } };
    }
    const create = route === '/storage-places' && method === 'POST';
    match = route.match(/^\/storage-places\/(\d+)$/);
    if (!create && !(match && ['PATCH', 'DELETE'].includes(method))) return { handled: false };
    manager(user, 'materials.stock.location');
    const value = await db.transaction(async () => {
      const rows = await all('SELECT * FROM material_storage_places');
      const row = create ? null : rows.find(entry => entry.id === integer(match[1]));
      if (!create && !row) error(404, '库位不存在');
      const reason = create ? '新建库位' : text(input.reason, '修改原因', 1000);
      if (row) version(input, row);
      if (method === 'DELETE') {
        await unusedPlace(row, rows);
        await run('DELETE FROM material_storage_places WHERE id=?', row.id);
        await log(user, 'DELETE_STORAGE_PLACE', 'material_storage_places', row.id, JSON.stringify({ path: places(rows).find(entry => entry.id === row.id).path, reason }));
        return { deleted: true, id: row.id };
      }
      if (create && rows.length >= 1000) error(400, '库位最多1000项');
      const name = text(input.name === undefined && row ? row.name : input.name, '库位名称', 60).normalize('NFKC');
      const parentId = input.parentId === undefined && row ? row.parent_id : input.parentId === null || input.parentId === '' || input.parentId === undefined ? null : integer(input.parentId, '父级库位');
      const parent = parentId === null ? null : rows.find(entry => entry.id === parentId);
      if (parentId !== null && !parent) error(400, '父级库位不存在');
      let active = row?.active ?? 1;
      if (input.active !== undefined) {
        if (![true, false, 0, 1].includes(input.active)) error(400, '库位启用状态无效');
        active = input.active === true || input.active === 1 ? 1 : 0;
      }
      if (parent && !places(rows).find(entry => entry.id === parent.id).effectiveActive && (create || parentId !== row.parent_id || active === 1)) error(400, '父级库位已停用，请选择启用的父级');
      if (row && (name !== row.name || parentId !== row.parent_id)) await unusedPlace(row, rows);
      if (rows.some(entry => entry.id !== row?.id && entry.parent_id === parentId && entry.name.normalize('NFKC').toLowerCase() === name.toLowerCase())) conflict('同一父级下库位名称已存在');
      const proposed = { id: row?.id ?? -1, name, parent_id: parentId, active, version: row ? row.version + 1 : 1 };
      places([...rows.filter(entry => entry.id !== row?.id), proposed]);
      const timestamp = new Date().toISOString();
      let id = row?.id;
      if (row) await run('UPDATE material_storage_places SET name=?,parent_id=?,active=?,version=version+1,updated_at=? WHERE id=?', name, parentId, active, timestamp, row.id);
      else id = (await run('INSERT INTO material_storage_places(name,parent_id,active,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)', name, parentId, active, user.id, timestamp, timestamp)).lastInsertRowid;
      const saved = places(await all('SELECT * FROM material_storage_places')).find(entry => entry.id === id);
      await log(user, row ? 'UPDATE_STORAGE_PLACE' : 'CREATE_STORAGE_PLACE', 'material_storage_places', id, JSON.stringify({ before: row ? places(rows).find(entry => entry.id === row.id) : null, after: saved, reason }));
      return saved;
    });
    return { handled: true, value, status: create ? 201 : 200 };
  }
  function validateBackup(tables) {
    for (const row of tables.material_categories) {
      profile(row.profile);
      integer(row.version, '分类版本');
    }
    for (const row of tables.material_catalog) {
      const checked = fields(view(row));
      for (const key of Object.keys(checked)) if (checked[key] !== row[key]) error(400, '备份实验室资料未规范化');
    }
    const siblings = new Set(), users = new Set(tables.users?.map(row => row.id));
    for (const row of tables.material_storage_places) {
      integer(row.id);
      if (row.parent_id !== null) integer(row.parent_id, '父级库位');
      integer(row.version, '库位版本');
      if (![0, 1].includes(row.active) || row.name !== text(row.name, '库位名称', 60).normalize('NFKC')) error(400, '备份库位资料无效');
      if (!validTimestamp(row.created_at) || !validTimestamp(row.updated_at) || Date.parse(row.updated_at) < Date.parse(row.created_at)) error(400, '备份库位时间无效');
      const key = JSON.stringify([row.parent_id, row.name.toLowerCase()]);
      if (siblings.has(key)) error(400, '备份库位同级名称重复');
      siblings.add(key);
      if (users.size && !users.has(row.created_by)) error(400, '备份库位引用人员不存在');
    }
    places(tables.material_storage_places);
  }
  return { handle, fields, view, profile, validateBackup };
}

module.exports = createMaterialLab;
