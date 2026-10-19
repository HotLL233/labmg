'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readCatalogWorkbook, CATALOG_HEADERS, readOpeningWorkbook, OPENING_HEADERS } = require('../src/material-xlsx');

async function workbook(headers, rows) {
  const cell = value => value && typeof value === 'object' ? value : { type: typeof value === 'number' ? Number : String, value };
  return require('write-excel-file/node').default([{ sheet: '导入明细', data: [headers.map(cell), ...rows.map(row => row.map(cell))] }]).toBuffer();
}
const upload = bytes => ({ name: '物资信息.xlsx', content: bytes.toString('base64') });

test('catalog and opening workbooks share strict parsing while retaining their own column contracts', async () => {
  const rows = [['0000123', '=文字名称', '500 mL', '瓶', '试剂', '逐件'], ['MAT-2', '耗材', '10个/包', '包', '耗材', '数量']];
  const bytes = await workbook(CATALOG_HEADERS, rows);
  assert.deepEqual(await readCatalogWorkbook(upload(bytes)), rows);
  await assert.rejects(readOpeningWorkbook(upload(bytes)), /表头不匹配.*期初模板/);
  const opening = [['0000123', '区域 A', 'MAIN', 2, 12.5, '', '', '柜 A', '']];
  assert.deepEqual(await readOpeningWorkbook(upload(await workbook(OPENING_HEADERS, opening))), opening);
  await assert.rejects(readCatalogWorkbook(upload(await workbook(OPENING_HEADERS, opening))), /表头不匹配.*物资信息模板/);
});

test('catalog workbook rejects unsafe content, excess rows and invalid file envelopes', async () => {
  const row = ['MAT-1', '试剂', '500 mL', '瓶', '试剂', '逐件'];
  const bytes = await workbook(CATALOG_HEADERS, [row]);
  await assert.rejects(readCatalogWorkbook({ ...upload(bytes), name: 'legacy.xls' }), /只.*xlsx|请选择.*xlsx/);
  await assert.rejects(readCatalogWorkbook({ ...upload(bytes), content: 'invalid!' }), /编码无效/);
  await assert.rejects(readCatalogWorkbook(upload(await workbook(CATALOG_HEADERS, []))), /1至200/);
  await assert.rejects(readCatalogWorkbook(upload(await workbook(CATALOG_HEADERS, Array.from({ length: 201 }, () => row)))), /1至200/);
  await assert.rejects(readCatalogWorkbook(upload(await workbook(CATALOG_HEADERS, [[...row, '多余列']]))), /表头不匹配|不支持的值/);
  await assert.rejects(readCatalogWorkbook(upload(await workbook(CATALOG_HEADERS, [[{ type: 'Formula', value: '1+1' }, ...row.slice(1)]]))), /公式/);
  const huge = Buffer.from(bytes), directory = huge.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  huge.writeUInt32LE(20 * 1024 * 1024, directory + 24);
  await assert.rejects(readCatalogWorkbook(upload(huge)), /解压后过大/);
});
