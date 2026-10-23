'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const { readCatalogWorkbook, CATALOG_HEADERS, PREVIOUS_CATALOG_HEADERS, LEGACY_CATALOG_HEADERS, readOpeningWorkbook, OPENING_HEADERS, PREVIOUS_OPENING_HEADERS, LEGACY_OPENING_HEADERS, excelColumn, importFailure, referenceFeature, workbookSheet } = require('../src/material-xlsx');

const cell = value => value && typeof value === 'object' ? value : { type: typeof value === 'number' ? Number : String, value };
const sheet = (name, headers, rows, options = {}) => ({ sheet: name, data: [headers.map(cell), ...rows.map(row => row.map(cell))], ...options });
const write = (sheets, options) => require('write-excel-file/node').default(sheets, options).toBuffer();
const workbook = (headers, rows) => write([sheet('导入明细', headers, rows)]);
const upload = bytes => ({ name: '物资信息.xlsx', content: bytes.toString('base64') });
const values = (headers, row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']));
const mutate = (bytes, change) => { const files = unzipSync(bytes); change(files); return Buffer.from(zipSync(files)); };

test('new Chinese-name and legacy column contracts both parse with explicit sheet, headers and cell values', async () => {
  for (const [reader, headers, row] of [
    [readCatalogWorkbook, CATALOG_HEADERS, ['=文字名称', '500 mL', '瓶', '试剂', '逐件']],
    [readCatalogWorkbook, LEGACY_CATALOG_HEADERS, ['0000123', '试剂', '500 mL', '瓶', '试剂', '逐件']],
    [readCatalogWorkbook, PREVIOUS_CATALOG_HEADERS, ['试剂', '500 mL', '瓶', '试剂', '逐件']],
    [readOpeningWorkbook, OPENING_HEADERS, ['试剂', '500 mL', '瓶', '区域 A', '中心仓库', 2, 12.5, '', '', '柜 A', '']],
    [readOpeningWorkbook, LEGACY_OPENING_HEADERS, ['0000123', '区域 A', 'MAIN', 2, 12.5, '', '', '柜 A', '']],
    [readOpeningWorkbook, PREVIOUS_OPENING_HEADERS, ['试剂', '500 mL', '瓶', '区域 A', '中心仓库', 2, 12.5, '', '', '柜 A', '']]
  ]) assert.deepEqual(await reader(upload(await workbook(headers, [row]))), { sheet: '导入明细', headers, rows: [{ row: 2, values: values(headers, row) }] });
  await assert.rejects(readOpeningWorkbook(upload(await workbook(CATALOG_HEADERS, [['试剂', '', '瓶', '试剂', '逐件']]))), /表头不匹配.*期初模板/);
});

test('reader selects matching worksheet after reference sheets and keeps physical row numbers across empty rows', async () => {
  const headers = CATALOG_HEADERS, first = ['试剂甲', '500 mL', '瓶', '试剂', '逐件'], last = ['试剂乙', '', '袋', '耗材', '数量'];
  const bytes = await write([sheet('分类参考', ['分类名称'], [['试剂']]), sheet('物资明细', headers, [first, [], last])]);
  assert.deepEqual(await readCatalogWorkbook(upload(bytes)), { sheet: '物资明细', headers, rows: [{ row: 2, values: values(headers, first) }, { row: 4, values: values(headers, last) }] });
});

test('manufacturer, batch notes and catalog remarks are literal optional columns in current templates', async () => {
  const catalogRow = ['试剂', '500 mL', '瓶', '试剂', '数量', '=物资备注'];
  const openingRow = ['试剂', '500 mL', '瓶', '区域 A', '默认仓库', '1', '2.34', '批次', '', '柜 A', '', '厂家 A', '=批次备注'];
  assert.deepEqual((await readCatalogWorkbook(upload(await workbook(CATALOG_HEADERS, [catalogRow])))).rows[0].values, values(CATALOG_HEADERS, catalogRow));
  assert.deepEqual((await readOpeningWorkbook(upload(await workbook(OPENING_HEADERS, [openingRow])))).rows[0].values, values(OPENING_HEADERS, openingRow));
});

test('shared workbook layout keeps Chinese headers readable and formula-like text round-trippable', async () => {
  const row = ['=文字名称', '500 mL', '瓶', '区域甲', '默认仓库', '1.125', '12.34', '0000123', '', '柜一', '', '厂家甲', '=备注'.repeat(80)];
  const bytes = await write([workbookSheet('期初明细', OPENING_HEADERS, [row])]);
  const files = unzipSync(bytes), xml = strFromU8(files['xl/worksheets/sheet1.xml']), styles = strFromU8(files['xl/styles.xml']);
  assert.match(xml, /<cols>/); assert.match(xml, /<pane[^>]*ySplit="1"[^>]*state="frozen"/);
  assert.equal([...xml.matchAll(/<col\b[^>]*width="([\d.]+)"/g)].length, OPENING_HEADERS.length);
  assert.match(styles, /Microsoft YaHei/); assert.match(styles, /wrapText="1"/); assert.match(styles, /24476b/i);
  assert.doesNotMatch(xml, /<f(?:\s|>)/);
  assert.deepEqual((await readOpeningWorkbook(upload(bytes))).rows[0].values, values(OPENING_HEADERS, row));
});

test('header mismatches and unsupported values report sheet, physical row, column, field and original value', async () => {
  const headers = [...CATALOG_HEADERS]; headers[1] = '错误规格'; headers[3] = '错分类';
  await assert.rejects(readCatalogWorkbook(upload(await workbook(headers, [['物资', '500mL', '瓶', '试剂', '数量']]))), failure => {
    assert.equal(failure.status, 400); assert.equal(failure.code, 'IMPORT_VALIDATION'); assert.equal(failure.totalErrors, 2);
    assert.deepEqual(failure.errors.map(item => [item.sheet, item.row, item.column, item.field, item.value]), [['导入明细', 1, 'B', '规格', '错误规格'], ['导入明细', 1, 'D', '物资分类', '错分类']]);
    return true;
  });
  const invalid = ['物资', { type: Boolean, value: true }, '瓶', '试剂', '数量', '物资备注', '多余值'];
  await assert.rejects(readCatalogWorkbook(upload(await workbook(CATALOG_HEADERS, [['正常', '', '瓶', '试剂', '数量'], [], invalid]))), failure => {
    assert.equal(failure.totalErrors, 2);
    assert.deepEqual(failure.errors.map(item => [item.sheet, item.row, item.column, item.field, item.value]), [['导入明细', 4, 'B', '规格', true], ['导入明细', 4, 'G', '多余列', '多余值']]);
    return true;
  });
});

test('reader accepts 5000 data rows and rejects empty, overlong and oversized sheet ranges', async () => {
  const row = ['试剂', '500 mL', '瓶', '试剂', '逐件'];
  const bytes = await workbook(CATALOG_HEADERS, Array.from({ length: 5000 }, () => row));
  const result = await readCatalogWorkbook(upload(bytes)); assert.equal(result.rows.length, 5000); assert.equal(result.rows.at(-1).row, 5001);
  const openingRow = ['试剂', '500 mL', '瓶', '区域 A', '中心仓库', 1, 10, '', '', '柜 A', ''];
  const opening = await readOpeningWorkbook(upload(await workbook(OPENING_HEADERS, Array.from({ length: 5000 }, () => openingRow))));
  assert.equal(opening.rows.length, 5000); assert.equal(opening.rows.at(-1).row, 5001);
  await assert.rejects(readCatalogWorkbook(upload(await workbook(CATALOG_HEADERS, []))), /1至5000/);
  await assert.rejects(readCatalogWorkbook(upload(await workbook(CATALOG_HEADERS, Array.from({ length: 5001 }, () => row)))), /工作表行数过大|范围过大/);
  const sparse = mutate(await workbook(CATALOG_HEADERS, [row]), files => { files['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(files['xl/worksheets/sheet1.xml']).replace('r="A2"', 'r="CV5002"')); });
  await assert.rejects(readCatalogWorkbook(upload(sparse)), /工作表范围过大/);
});

test('formula rejection reports the real worksheet and cell without accepting a cached result', async () => {
  const bytes = await write([sheet('说明', ['说明'], [['这里不是导入页']]), sheet('物资明细', CATALOG_HEADERS, [['试剂', '', '瓶', '试剂', '逐件'], [], [{ type: 'Formula', value: '1+1' }, '', '瓶', '试剂', '数量']])]);
  await assert.rejects(readCatalogWorkbook(upload(bytes)), failure => {
    assert.equal(failure.code, 'IMPORT_VALIDATION');
    assert.equal(failure.errors[0].sheet, '物资明细'); assert.equal(failure.errors[0].row, 4); assert.equal(failure.errors[0].column, 'A');
    assert.equal(failure.errors[0].value, '=1+1'); assert.match(failure.message, /公式/); return true;
  });
});

test('malformed cells with a formula are rejected promptly without quadratic closing-tag searches', async () => {
  const bytes = await workbook(CATALOG_HEADERS, [['试剂', '', '瓶', '试剂', '逐件']]);
  const malformed = mutate(bytes, files => { files['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(files['xl/worksheets/sheet1.xml']).replace('</sheetData>', '<row r="3">' + '<c r="A3">'.repeat(100000) + '<f/></row></sheetData>')); });
  const readerPath = JSON.stringify(require.resolve('../src/material-xlsx'));
  const source = `const {readCatalogWorkbook}=require(${readerPath});let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',async()=>{try{await readCatalogWorkbook(JSON.parse(input));process.exitCode=1;}catch(failure){if(failure.code!=='IMPORT_VALIDATION'||!failure.message.includes('公式')){console.error(failure);process.exitCode=1;}}});`;
  const result = spawnSync(process.execPath, ['-e', source], { input: JSON.stringify(upload(malformed)), encoding: 'utf8', timeout: 3000, windowsHide: true });
  assert.equal(result.error, undefined, 'malformed XML must not exhaust the time limit');
  assert.equal(result.status, 0, result.stderr);
});

test('file envelopes, archives, macros, links, entities, CRC and decompression limits remain rejected', async () => {
  const bytes = await workbook(CATALOG_HEADERS, [['试剂', '', '瓶', '试剂', '逐件']]);
  await assert.rejects(readCatalogWorkbook({ ...upload(bytes), name: 'legacy.xls' }), /只.*xlsx|请选择.*xlsx/);
  await assert.rejects(readCatalogWorkbook({ ...upload(bytes), content: 'invalid!' }), /编码无效/);
  await assert.rejects(readCatalogWorkbook(null), /请选择/);
  const huge = Buffer.from(bytes), directory = huge.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  huge.writeUInt32LE(20 * 1024 * 1024, directory + 24);
  await assert.rejects(readCatalogWorkbook(upload(huge)), /解压后过大/);
  const checksum = Buffer.from(bytes); checksum.writeUInt32LE(0, directory + 16);
  await assert.rejects(readCatalogWorkbook(upload(checksum)), /校验/);
  for (const forbidden of ['xl/vbaProject.bin', 'xl/externalLinks/externalLink1.xml', 'xl/embeddings/object.bin']) await assert.rejects(readCatalogWorkbook(upload(mutate(bytes, files => { files[forbidden] = strToU8('<unsafe/>'); }))), /宏|外部数据|嵌入对象/);
  for (const unsafe of ['<!DOCTYPE worksheet [<!ENTITY a "unsafe">]>', '<Relationship TargetMode="External"/>']) await assert.rejects(readCatalogWorkbook(upload(mutate(bytes, files => { files['xl/worksheets/sheet1.xml'] = strToU8(unsafe + strFromU8(files['xl/worksheets/sheet1.xml'])); }))), /外部链接|XML 实体/);
});

test('reference feature produces escaped named ranges, strict and permissive dropdowns using the installed multi-sheet API', async () => {
  const row = ['试剂', '500 mL', '瓶', '试剂', '逐件'], referenceName = "分类'与&参考";
  const sheets = [sheet('物资信息', CATALOG_HEADERS, [row], { stickyRowsCount: 1, referenceLists: { A: { sheet: referenceName, column: 'A', count: 2, strict: false }, D: { sheet: referenceName, column: 'B', count: 1, strict: true }, E: { sheet: referenceName, column: 'C', count: 0, strict: true } } }), sheet(referenceName, ['物资名称', '分类'], [['试剂', '试剂'], ['新物资', '耗材']])];
  const bytes = await write(sheets, { features: [referenceFeature()] }), files = unzipSync(bytes);
  const book = strFromU8(files['xl/workbook.xml']), data = strFromU8(files['xl/worksheets/sheet1.xml']);
  assert.match(book, /<definedName name="LABOS_S1_A">'分类''与&amp;参考'!\$A\$2:\$A\$3<\/definedName>/);
  assert.match(book, /<definedName name="LABOS_S1_D">'分类''与&amp;参考'!\$B\$2:\$B\$2<\/definedName>/);
  assert.ok(book.indexOf('<sheets>') < book.indexOf('<definedNames>')); assert.ok(book.indexOf('<definedNames>') < book.indexOf('<calcPr'));
  assert.match(data, /<dataValidations count="2">/);
  assert.match(data, /showErrorMessage="0"[^>]*sqref="A2:A5001"><formula1>LABOS_S1_A/);
  assert.match(data, /showErrorMessage="1" errorStyle="stop"[^>]*sqref="D2:D5001"><formula1>LABOS_S1_D/);
  assert.doesNotMatch(data, /<f[ >]|LABOS_S1_E/); assert.match(data, /state="frozen"/);
  assert.deepEqual((await readCatalogWorkbook(upload(bytes))).rows, [{ row: 2, values: values(CATALOG_HEADERS, row) }]);
  await assert.rejects(async () => write([sheet('物资信息', CATALOG_HEADERS, [row], { referenceLists: { A: { sheet: '不存在', column: 'A', count: 1, strict: true } } })], { features: [referenceFeature()] }), /引用工作表不存在/);
});

test('structured error helper caps details while retaining total count and column letters cross Z', () => {
  assert.deepEqual([0, 25, 26, 99].map(excelColumn), ['A', 'Z', 'AA', 'CV']);
  const errors = Array.from({ length: 205 }, (_, index) => ({ sheet: '期初明细', row: index + 2, column: 'D', field: '区域', value: '未知区域', message: '找不到区域名称' }));
  assert.throws(() => importFailure(errors, 409), failure => {
    assert.equal(failure.status, 409); assert.equal(failure.totalErrors, 205); assert.equal(failure.errors.length, 200);
    assert.match(failure.message, /期初明细.*第2行D列.*区域.*找不到区域名称/); return true;
  });
});
