'use strict';

const { inflateRawSync, crc32 } = require('node:zlib');
const { posix } = require('node:path');
const readExcelFile = require('read-excel-file/universal').default;
const { findElement, appendMarkupInsideElement, insertElementMarkupAccordingToOrderOfSiblings, getOrderOfSiblings, sanitizeTextContent, sanitizeAttributeValue } = require('write-excel-file/utility');

const LEGACY_OPENING_HEADERS = ['物资编码', '区域', '仓库编码', '数量', '总金额（元）', '批号', '有效期', '存放位置', '零金额原因'];
const LEGACY_CATALOG_HEADERS = ['物资编码', '物资名称', '规格', '单位', '物资分类', '管理方式'];
const OPENING_HEADERS = ['物资名称', '规格', '单位', '区域', '仓库', '数量', '总金额（元）', '批号', '有效期', '存放位置', '零金额原因'];
const CATALOG_HEADERS = ['物资名称', '规格', '单位', '物资分类', '管理方式'];
const FILE_LIMIT = 5 * 1024 * 1024;

function excelColumn(index) {
  let result = '';
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) result = String.fromCharCode(65 + (number - 1) % 26) + result;
  return result;
}

function importFailure(errors, status = 400) {
  const first = errors[0], location = [first.sheet && `工作表“${first.sheet}”`, first.row && `第${first.row}行`, first.column && `${first.column}列`, first.field && `（${first.field}）`].filter(Boolean).join('');
  const failure = new Error(`Excel 导入发现${errors.length}处错误：${location}${location ? '：' : ''}${first.message}`);
  Object.assign(failure, { status, code: 'IMPORT_VALIDATION', errors: errors.slice(0, 200), totalErrors: errors.length });
  throw failure;
}

const invalid = message => importFailure([{ sheet: '', row: null, column: '', field: '文件', value: '', message }]);
const decodeXml = text => text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (match, entity) => {
  if (entity[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
  const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
});
const xmlAttributes = tag => Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1], decodeXml(match[2] ?? match[3])]));

function validateArchive(bytes) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) invalid('只支持未加密的 .xlsx 文件');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) invalid('Excel 压缩结构不完整');
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count || !count || count > 128 || offset + size !== end) invalid('Excel 压缩结构或文件数量无效');
  let cursor = offset, total = 0, cellCount = 0;
  const names = new Set(), ranges = [], xmlParts = new Map(), formulas = [];
  for (let entry = 0; entry < count; entry++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid('Excel 文件目录损坏');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || local + 30 > offset || flags & 1 || ![0, 8].includes(method)) invalid('Excel 包含加密或不支持的压缩数据');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!/^[A-Za-z0-9_.\[\]/-]+$/.test(name) || name.split('/').includes('..') || name.startsWith('/') || names.has(name)) invalid('Excel 文件路径或重复条目无效');
    if (/externalLinks|vbaProject|embeddings|activeX|connections\.xml|queryTables|customXml/i.test(name)) invalid('Excel 不得包含宏、外部数据或嵌入对象');
    names.add(name);
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) invalid('Excel 压缩条目不一致');
    const localNameLength = bytes.readUInt16LE(local + 26), start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (start + compressed > offset || bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name) invalid('Excel 压缩条目越界');
    ranges.push([local, start + compressed]);
    total += expanded;
    if (expanded > 6 * 1024 * 1024 || total > 12 * 1024 * 1024) invalid('Excel 解压后过大，请拆分文件');
    const content = method === 0 ? bytes.subarray(start, start + compressed) : inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: Math.max(1, expanded) });
    if (content.length !== expanded || crc32(content) !== bytes.readUInt32LE(cursor + 16)) invalid('Excel 解压大小或校验与目录不一致');
    if (/\.(xml|rels)$/i.test(name)) {
      const xml = content.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY|\bTargetMode\s*=|<\s*(?:[\w.-]+:)?externalReference\w*\b/i.test(xml)) invalid('Excel 不支持公式、外部链接或 XML 实体，请粘贴为值');
      if (name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels') xmlParts.set(name, xml);
      if (/<(?:[\w.-]+:)?f(?:\s|\/?>)/i.test(xml)) {
        const before = formulas.length; let address = null;
        // Track tags without searching for closing cells, so malformed XML cannot trigger repeated full-file scans.
        for (const tag of xml.matchAll(/<(\/?)(?:[\w.-]+:)?(c|f)\b([^<>]*)>/gi)) {
          if (tag[2].toLowerCase() === 'c') { address = tag[1] || /\/\s*$/.test(tag[3]) ? null : xmlAttributes(tag[3]).r?.match(/^([A-Z]+)(\d+)$/); continue; }
          if (tag[1]) continue;
          const start = tag.index + tag[0].length, end = xml.indexOf('<', start), value = /\/\s*$/.test(tag[3]) ? '' : decodeXml(xml.slice(start, end < 0 ? xml.length : end));
          formulas.push({ sheet: name, row: address ? Number(address[2]) : null, column: address?.[1] || '', field: '公式', value: value ? '=' + value : '[公式]', message: '不支持公式，请粘贴为值后导入。' });
        }
        if (formulas.length === before) formulas.push({ sheet: name, row: null, column: '', field: '公式', value: '[公式]', message: '不支持公式，请粘贴为值后导入。' });
      }
      if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
        let rowCount = 0;
        for (const match of xml.matchAll(/<(?:[\w.-]+:)?row\b[^<>]*>/g)) {
          const coordinate = match[0].match(/\br\s*=\s*["']([^"']+)["']/);
          if (++rowCount > 5001 || (coordinate && (!/^[1-9]\d*$/.test(coordinate[1]) || Number(coordinate[1]) > 5001))) invalid('Excel 工作表行数过大');
        }
        for (const match of xml.matchAll(/<(?:[\w.-]+:)?(?:c|dimension)\b[^<>]*\br(?:ef)?\s*=\s*["']([^"']+)["']/g)) {
          for (const cell of match[1].split(':')) {
            const coordinate = cell.match(/^([A-Z]{1,3})([1-9]\d*)$/);
            const column = coordinate && [...coordinate[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
            if (!coordinate || column > 100 || Number(coordinate[2]) > 5001) invalid('Excel 工作表范围过大');
          }
          if (++cellCount > 150000) invalid('Excel 单元格过多，请拆分文件');
        }
      }
    }
    cursor = next;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (cursor !== end || ranges.some((range, index) => index && range[0] < ranges[index - 1][1]) || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) invalid('Excel 文件结构无效');
  if (formulas.length) {
    const relationships = new Map([...((xmlParts.get('xl/_rels/workbook.xml.rels') || '').matchAll(/<(?:[\w.-]+:)?Relationship\b[^<>]*>/g))].map(match => { const attributes = xmlAttributes(match[0]); return [attributes.Id, attributes.Target]; }));
    const sheetNames = new Map([...xmlParts.get('xl/workbook.xml').matchAll(/<(?:[\w.-]+:)?sheet\b[^<>]*>/g)].map(match => { const attributes = xmlAttributes(match[0]), target = relationships.get(attributes['r:id']); return [target && posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target)), attributes.name]; }));
    importFailure(formulas.map(failure => ({ ...failure, sheet: sheetNames.get(failure.sheet) || failure.sheet })));
  }
}

async function readWorkbook(input, headerVersions, label) {
  if (!input || typeof input.name !== 'string' || !/^[^\\/]+\.xlsx$/i.test(input.name)) invalid('请选择 .xlsx 文件，旧版 .xls 请另存为 .xlsx');
  if (typeof input.content !== 'string' || input.content.length > Math.ceil(FILE_LIMIT / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) invalid('Excel 文件编码无效或超过5 MiB');
  const bytes = Buffer.from(input.content, 'base64');
  if (!bytes.length || bytes.length > FILE_LIMIT || bytes.toString('base64') !== input.content) invalid('Excel 文件为空、编码无效或超过5 MiB');
  try {
    validateArchive(bytes);
    const sheets = await readExcelFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), { trim: true });
    let chosen, best;
    for (const sheet of sheets) for (const headers of headerVersions) {
      const actual = [...(sheet.data[0] || [])]; while (actual.length && (actual.at(-1) === null || actual.at(-1) === '')) actual.pop();
      const score = headers.reduce((count, header, index) => count + (actual[index] === header ? 1 : 0), 0);
      const candidate = { sheet, headers, actual, score };
      if (!best || score > best.score) best = candidate;
      if (actual.length === headers.length && score === headers.length && !chosen) chosen = candidate;
    }
    if (!chosen) {
      if (!best) invalid(`Excel 表头不匹配，请下载${label}模板填写`);
      const errors = [];
      for (let column = 0; column < Math.max(best.headers.length, best.actual.length); column++) if (best.headers[column] !== best.actual[column]) errors.push({ sheet: best.sheet.sheet, row: 1, column: excelColumn(column), field: best.headers[column] || '多余表头', value: best.actual[column] ?? '', message: `表头不匹配，${best.headers[column] ? `此列应为“${best.headers[column]}”` : '请删除此列'}；请下载${label}模板填写。` });
      importFailure(errors);
    }
    const { sheet, headers } = chosen, rows = [], errors = [];
    for (let index = 1; index < sheet.data.length; index++) {
      const cells = sheet.data[index];
      if (!cells.some(value => value !== null && value !== '')) continue;
      cells.forEach((value, column) => {
        if (value === null || value === '') return;
        if (column >= headers.length || !['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) errors.push({ sheet: sheet.sheet, row: index + 1, column: excelColumn(column), field: headers[column] || '多余列', value: value instanceof Date ? value.toISOString() : value, message: column >= headers.length ? '此列不在模板中，请删除多余内容。' : '包含不支持的值；日期请使用YYYY-MM-DD文本。' });
      });
      rows.push({ row: index + 1, values: Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? ''])) });
    }
    if (errors.length) importFailure(errors);
    if (!rows.length || rows.length > 5000) importFailure([{ sheet: sheet.sheet, row: 2, column: 'A', field: headers[0], value: '', message: '每次导入须有1至5000条明细。' }]);
    return { sheet: sheet.sheet, headers: [...headers], rows };
  } catch (failure) {
    if (failure.status) throw failure;
    const address = failure.message?.match(/(?:at )?row (\d+),? col (\d+)/);
    if (address) importFailure([{ sheet: '', row: Number(address[1]), column: excelColumn(Number(address[2]) - 1), field: '单元格', value: '', message: '单元格格式无效，请使用模板并粘贴为值后重试。' }]);
    invalid('无法读取 Excel 文件，请使用模板并另存为未加密的 .xlsx');
  }
}

const readOpeningWorkbook = input => readWorkbook(input, [OPENING_HEADERS, LEGACY_OPENING_HEADERS], '期初');
const readCatalogWorkbook = input => readWorkbook(input, [CATALOG_HEADERS, LEGACY_CATALOG_HEADERS], '物资信息');

function referenceFeature() {
  const references = sheet => Object.entries(sheet.referenceLists || {}).filter(([, reference]) => reference.count !== 0).map(([column, reference]) => {
    if (!/^[A-Z]{1,3}$/.test(column) || !/^[A-Z]{1,3}$/.test(reference.column) || typeof reference.sheet !== 'string' || !reference.sheet || !Number.isInteger(reference.count) || reference.count < 1 || reference.count > 5000 || typeof reference.strict !== 'boolean') throw new Error('Excel 引用列表配置无效');
    return { targetColumn: column, ...reference };
  });
  return { files: { transform: {
    'xl/workbook.xml': { transform(xml, sheets) {
      const names = sheets.flatMap((sheet, index) => references(sheet).map(reference => {
        if (!sheets.some(candidate => candidate.sheet === reference.sheet)) throw new Error('Excel 引用工作表不存在');
        const formula = `'${reference.sheet.replaceAll("'", "''")}'!$${reference.column}$2:$${reference.column}$${reference.count + 1}`;
        return `<definedName name="LABOS_S${index + 1}_${reference.targetColumn}">${sanitizeTextContent(formula)}</definedName>`;
      })).join('');
      if (!names) return xml;
      const existing = findElement(xml, 'definedNames');
      return existing ? appendMarkupInsideElement(xml, existing, names) : insertElementMarkupAccordingToOrderOfSiblings(xml, `<definedNames>${names}</definedNames>`, getOrderOfSiblings('xl/workbook.xml', 'workbook'), 'workbook');
    } },
    'xl/worksheets/sheet{id}.xml': { transform(xml, sheet, { sheetIndex }) {
      const entries = references(sheet);
      if (!entries.length) return xml;
      const markup = entries.map(reference => `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="${reference.strict ? 1 : 0}" errorStyle="stop" errorTitle="请选择已有名称" error="${sanitizeAttributeValue('请从下拉列表选择有效名称。')}" sqref="${reference.targetColumn}2:${reference.targetColumn}5001"><formula1>LABOS_S${sheetIndex + 1}_${reference.targetColumn}</formula1></dataValidation>`).join('');
      if (findElement(xml, 'dataValidations')) throw new Error('Excel 数据验证配置重复');
      return insertElementMarkupAccordingToOrderOfSiblings(xml, `<dataValidations count="${entries.length}">${markup}</dataValidations>`, getOrderOfSiblings('xl/worksheets/sheet{id}.xml', 'worksheet'), 'worksheet');
    } }
  } } };
}

module.exports = { readOpeningWorkbook, OPENING_HEADERS, LEGACY_OPENING_HEADERS, readCatalogWorkbook, CATALOG_HEADERS, LEGACY_CATALOG_HEADERS, excelColumn, importFailure, referenceFeature };
