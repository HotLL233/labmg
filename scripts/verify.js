'use strict';

// 一条命令自证：JS 语法 + UI 合规审计，不需要数据库、不需要浏览器。
//
// 用法：
//   npm run verify          默认：check + ui-audit（存量不得倒退）
//   npm run verify:strict   追加 ui-audit --strict（目标是否达成）
//
// 设计原则：输出尽量短，让调用方可以整段贴回上下文；失败才展开细节。

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict');
const steps = [];
let failed = 0;

function run(label, args, { optional = false } = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const code = result.status === null ? 1 : result.status;
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();

  if (code !== 0) failed++;
  steps.push({ label, code, ms, output, optional });
  return code === 0;
}

// --- 0. 环境自检：只提示，不判失败 ---
const notes = [];
if (process.env.NODE_OPTIONS) {
  notes.push(`NODE_OPTIONS=${process.env.NODE_OPTIONS}（若含 safe-delete 之类的 shim，测试清理会被拦截，造成大面积假失败）`);
}
if (!process.env.LABOS_TEST_DATABASE_URL) {
  notes.push('未设 LABOS_TEST_DATABASE_URL → npm test 会 78 项失败，属环境缺失。本脚本不跑测试。');
}

// --- 1. JS 语法 ---
run('JS 语法 (node --check)', [path.join('scripts', 'check.js')]);

// --- 2. UI 审计：存量不得倒退 ---
run('UI 审计（存量不倒退）', [path.join('scripts', 'ui-audit.js')]);

// --- 3. 严格模式（可选） ---
if (strict) {
  run('UI 审计（目标达成 --strict）', [path.join('scripts', 'ui-audit.js'), '--strict']);
}

// --- 汇总 ---
const total = steps.reduce((sum, step) => sum + step.ms, 0);
const lines = [];
lines.push(`verify${strict ? ':strict' : ''} · ${failed === 0 ? 'PASS' : `FAIL (${failed} 项)`} · ${(total / 1000).toFixed(1)}s`);
for (const step of steps) {
  lines.push(`  ${step.code === 0 ? 'PASS' : 'FAIL'}  ${step.label}  ${(step.ms / 1000).toFixed(1)}s`);
}
if (notes.length) {
  lines.push('环境提示：');
  for (const note of notes) lines.push(`  - ${note}`);
}
const failures = steps.filter((step) => step.code !== 0);
if (failures.length) {
  lines.push('');
  lines.push('失败详情：');
  for (const step of failures) {
    const body = step.output.split('\n');
    const head = body.slice(0, 40);
    lines.push(`--- ${step.label} ---`);
    lines.push(head.join('\n'));
    if (body.length > head.length) lines.push(`… 省略 ${body.length - head.length} 行`);
  }
}

console.log(lines.join('\n'));
process.exitCode = failed === 0 ? 0 : 1;
