'use strict';

const { inflateRawSync, crc32 } = require('node:zlib');
const { readSheet } = require('read-excel-file/universal');

const OPENING_HEADERS = ['物资编码', '区域', '仓库编码', '数量', '总金额（元）', '批号', '有效期', '存放位置', '零金额原因'];
const CATALOG_HEADERS = ['物资编码', '物资名称', '规格', '单位', '物资分类', '管理方式'];
const FILE_LIMIT = 5 * 1024 * 1024;

function invalid(message) {
  const failure = new Error(message);
  failure.status = 400;
  throw failure;
}

function validateArchive(bytes) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) invalid('只支持未加密的 .xlsx 文件');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) invalid('Excel 压缩结构不完整');
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count || !count || count > 128 || offset + size !== end) invalid('Excel 压缩结构或文件数量无效');
  let cursor = offset, total = 0, cellCount = 0;
  const names = new Set(), ranges = [];
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
      if (/<!DOCTYPE|<!ENTITY|<(?:[\w.-]+:)?f(?:\s|\/?>)|\bTargetMode\s*=|<\s*(?:[\w.-]+:)?externalReference\w*\b/i.test(xml)) invalid('Excel 不支持公式、外部链接或 XML 实体，请粘贴为值');
      if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
        let rowCount = 0;
        for (const match of xml.matchAll(/<(?:[\w.-]+:)?row\b[^>]*>/g)) {
          const coordinate = match[0].match(/\br\s*=\s*["']([^"']+)["']/);
          if (++rowCount > 5001 || (coordinate && (!/^[1-9]\d*$/.test(coordinate[1]) || Number(coordinate[1]) > 5001))) invalid('Excel 工作表行数过大');
        }
        for (const match of xml.matchAll(/<(?:[\w.-]+:)?(?:c|dimension)\b[^>]*\br(?:ef)?\s*=\s*["']([^"']+)["']/g)) {
          for (const cell of match[1].split(':')) {
            const coordinate = cell.match(/^([A-Z]{1,3})([1-9]\d*)$/);
            const column = coordinate && [...coordinate[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
            if (!coordinate || column > 100 || Number(coordinate[2]) > 5001) invalid('Excel 工作表范围过大');
          }
          if (++cellCount > 30000) invalid('Excel 单元格过多，请拆分文件');
        }
      }
    }
    cursor = next;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (cursor !== end || ranges.some((range, index) => index && range[0] < ranges[index - 1][1]) || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) invalid('Excel 文件结构无效');
}

async function readWorkbook(input, headers, label) {
  if (typeof input.name !== 'string' || !/^[^\\/]+\.xlsx$/i.test(input.name)) invalid('请选择 .xlsx 文件，旧版 .xls 请另存为 .xlsx');
  if (typeof input.content !== 'string' || input.content.length > Math.ceil(FILE_LIMIT / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) invalid('Excel 文件编码无效或超过5 MiB');
  const bytes = Buffer.from(input.content, 'base64');
  if (!bytes.length || bytes.length > FILE_LIMIT || bytes.toString('base64') !== input.content) invalid('Excel 文件为空、编码无效或超过5 MiB');
  try {
    validateArchive(bytes);
    const data = await readSheet(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), 1, { trim: true });
    if (!Array.isArray(data) || !data.length || data[0].length !== headers.length || headers.some((header, index) => data[0][index] !== header)) invalid(`Excel 表头不匹配，请下载${label}模板填写`);
    const rows = data.slice(1).filter(row => row.some(value => value !== null && value !== ''));
    if (!rows.length || rows.length > 200) invalid('每次导入须有1至200条明细');
    return rows.map((row, index) => {
      if (row.length > headers.length || row.some(value => value !== null && !['string', 'number'].includes(typeof value))) invalid(`Excel 第${index + 2}行包含不支持的值；日期请使用YYYY-MM-DD文本`);
      return Array.from({ length: headers.length }, (_, column) => row[column] ?? '');
    });
  } catch (failure) {
    if (failure.status) throw failure;
    invalid('无法读取 Excel 文件，请使用模板并另存为未加密的 .xlsx');
  }
}

const readOpeningWorkbook = input => readWorkbook(input, OPENING_HEADERS, '期初');
const readCatalogWorkbook = input => readWorkbook(input, CATALOG_HEADERS, '物资信息');

module.exports = { readOpeningWorkbook, OPENING_HEADERS, readCatalogWorkbook, CATALOG_HEADERS };
