'use strict';

// UI 设计合规审计：对照 docs/UI_施工卡.md 的量化条款检查前端源码。
//
// 用法：
//   node scripts/ui-audit.js            默认模式：只检查「存量不得倒退」，当前代码应当通过
//   node scripts/ui-audit.js --strict   严格模式：检查 T1/T2 目标已达成，施工完成后必须通过
//
// 设计原则：分「存量」与「新增」两类。存量是既有代码里的历史问题，记入基线，只减不增；
// 新增是本次施工引入的，出现即失败。这样不会因为历史问题让脚本一开始就红。

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'src/public');
const strict = process.argv.includes('--strict');

// 存量基线：现有代码里已知的历史问题。只允许变小，不允许变大。
// 数字变化时必须在提交说明里解释原因。
const BASELINE = {
  tableMinWidth: 1,   // table{min-width:760px}，手机端需靠 responsive.css 卡片化规避
};

const results = [];   // {level:'pass'|'fail'|'warn', item, detail}

function read(file) {
  const full = path.join(publicDir, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

function listCss() {
  if (!fs.existsSync(publicDir)) return [];
  return fs.readdirSync(publicDir).filter(f => f.endsWith('.css'));
}

function listJs() {
  if (!fs.existsSync(publicDir)) return [];
  return fs.readdirSync(publicDir).filter(f => f.endsWith('.js'));
}

function pass(item, detail) { results.push({ level: 'pass', item, detail }); }
function fail(item, detail) { results.push({ level: 'fail', item, detail }); }
function warn(item, detail) { results.push({ level: 'warn', item, detail }); }

// ---------- 规则 1：字号下限 13px ----------
// 判定方式：11px 及以下的声明必须「按选择器处置」——由 tokens.css 的覆盖层接管。
// 原文件里的旧声明保留（铁律：不改紧凑单行 CSS），只要覆盖层带上了同选择器即视为已处置。
// 未在已知清单里的新声明 = 新增违规，直接失败。

// 已核实的存量 11px 选择器（对应施工卡 5.1.1 的 7 处）
const KNOWN_SMALL = new Set([
  '.pill',
  '.mw-toolbar label',
  '.mw-badge',
  '.ms-files input',
  '.mw small',
  '.mw-dialog small',
  '.mw-field small',
  '.mw-version',
]);

// 取某位置所处的 CSS 选择器（向前找本规则的 { 与上一条规则的 }）
function selectorAt(text, index) {
  const open = text.lastIndexOf('{', index);
  if (open === -1) return '';
  const close = text.lastIndexOf('}', open);
  return text.slice(close + 1, open).trim();
}

(function checkFontSize() {
  const tokens = read('tokens.css') || '';
  const legacy = [];   // 存量，且已被覆盖层处置
  const stale = [];    // 存量，尚未处置
  const added = [];    // 新增违规

  for (const file of listCss()) {
    if (file === 'tokens.css') continue;
    const text = read(file) || '';
    const re = /font-size:\s*([\d.]+)px/g;
    let m;
    while ((m = re.exec(text))) {
      const size = Number(m[1]);
      if (size >= 12) continue;

      // 打印样式里的小字号不参与屏显判定
      const before = text.slice(Math.max(0, m.index - 400), m.index);
      if (/@media\s+print\s*\{[^}]*$/.test(before)) continue;

      const sel = selectorAt(text, m.index);
      const parts = sel.split(',').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
      const known = parts.length > 0 && parts.every(p => KNOWN_SMALL.has(p));
      const handled = known && parts.every(p => tokens.includes(p));

      if (!known) added.push(`${file} 的 ${sel || '(未知选择器)'} 声明了 ${size}px`);
      else if (handled) legacy.push(sel);
      else stale.push(`${file} ${sel}`);
    }
  }

  if (added.length) {
    fail('字号下限', `新增小于 12px 的字号声明：${added.join('；')}。正文与标签不得小于 13px，说明文字不得小于 12px。`);
  } else if (!stale.length) {
    pass('字号下限', legacy.length ? `存量 ${legacy.length} 处 11px 已由 tokens.css 接管` : '无小于 12px 的声明');
  } else {
    const msg = `${stale.length} 处 11px 尚未处置：${stale.join('、')}`;
    strict ? fail('字号下限', msg + '。T1 要求全部由 tokens.css 覆盖（见施工卡 5.1.1）')
           : warn('字号下限', msg + ' —— T1 待做');
  }
})();

// ---------- 规则 2：手机端不得整页横滚 ----------
(function checkTableOverflow() {
  const styles = read('styles.css') || '';
  const responsive = read('responsive.css');

  const minWidthHits = (styles.match(/min-width:\s*(7\d\d|8\d\d)px/g) || []).length;
  if (minWidthHits > BASELINE.tableMinWidth) {
    fail('表格宽度', `宽表格 min-width 声明 ${minWidthHits} 处，超过基线 ${BASELINE.tableMinWidth} 处。新增宽表格请改为列省略或卡片化。`);
  } else {
    pass('表格宽度', `宽表格 min-width 声明 ${minWidthHits} 处（基线 ${BASELINE.tableMinWidth}）`);
  }

  // 只要存在宽表格，就必须有 <=767px 的卡片化覆盖
  const covered = !!responsive
    && /max-width:\s*767px/.test(responsive)
    && /thead[^{]*\{[^}]*display:\s*none/.test(responsive);

  if (minWidthHits > 0 && !covered) {
    const msg = '存在 min-width 宽表格，但 responsive.css 没有 ≤767px 的卡片化覆盖（thead 需 display:none）';
    strict ? fail('表格转卡片', msg) : warn('表格转卡片', msg + ' —— T2 待做');
  } else if (covered) {
    pass('表格转卡片', '已存在 ≤767px 卡片化覆盖');
  } else {
    pass('表格转卡片', '当前无宽表格，无需覆盖');
  }
})();

// ---------- 规则 3：data-label 注入必须集中在一处 ----------
(function checkDataLabel() {
  const app = read('app.js');
  const hasHelper = app && /function\s+labelTable\s*\(/.test(app);

  // 白名单：material-labels.js 的职责是「打印标签模板」，其中的 data-label 是标签打印属性，
  // 与表格转卡片无关，不参与本规则判定。新增白名单必须在这里写明理由。
  const LABEL_PRINT_MODULES = ['material-labels.js'];

  const callSites = listJs().filter(f => {
    const t = read(f) || '';
    return /labelTable\s*\(/.test(t) && f !== 'app.js';
  });
  const handWritten = listJs().filter(f => {
    if (LABEL_PRINT_MODULES.includes(f)) return false;
    const t = read(f) || '';
    // 手写 data-label="..." 即违反单套模板约定
    return /data-label\s*=\s*['"]/.test(t);
  });

  if (handWritten.length) {
    fail('data-label', `${handWritten.join(', ')} 手写了 data-label，违反「单套 DOM + CSS 重排」约定，必须改用 labelTable() 统一注入`);
  } else if (hasHelper) {
    pass('data-label', `labelTable() 已存在，${callSites.length} 处调用（${callSites.join(', ') || '待接入'}）`);
  } else {
    strict ? fail('data-label', 'app.js 缺少 labelTable() 函数，手机端卡片将没有字段名')
           : warn('data-label', 'app.js 尚无 labelTable() —— T2 待做');
  }
})();

// ---------- 规则 4：令牌层（T1） ----------
(function checkTokens() {
  const tokens = read('tokens.css');
  if (!tokens) {
    strict ? fail('设计令牌', 'tokens.css 不存在') : warn('设计令牌', 'tokens.css 尚未建立 —— T1 待做');
    return;
  }

  const required = ['--fs-body', '--fs-label', '--fs-page', '--c-primary-500', '--c-text-2', '--h-row', '--ring'];
  const missing = required.filter(v => !new RegExp(v.replace(/-/g, '\\-') + '\\s*:').test(tokens));
  if (missing.length) {
    fail('设计令牌', `tokens.css 缺少必需令牌：${missing.join(', ')}`);
  } else {
    pass('设计令牌', '必需令牌齐全');
  }

  // 品牌色必须引用旧变量，不许重复硬编码（派生色除外）。
  // 例外：8 位 hex（如 #2c6df63d，品牌色 + alpha）允许——CSS 没有便捷的 alpha 语法。
  const brand = ['#14263d', '#2c6df6', '#f4f7fb', '#e3e8ef', '#192537', '#718096', '#13895e', '#c94646'];
  const hardcoded = brand.filter(hex => new RegExp(hex + '(?![0-9a-fA-F])', 'i').test(tokens));
  if (hardcoded.length) {
    fail('令牌引用', `tokens.css 重复硬编码了旧变量色值：${hardcoded.join(', ')}。品牌色必须写 var(--navy) 等，否则改一处不生效`);
  } else {
    pass('令牌引用', '品牌色全部引用旧变量');
  }

  // 字号档位不得出现 11px
  if (/font-size:\s*11px/.test(tokens)) {
    fail('令牌字号', 'tokens.css 内出现 11px');
  }
})();

// ---------- 规则 5：令牌加载顺序 ----------
(function checkLinkOrder() {
  const html = fs.existsSync(path.join(publicDir, 'index.html'))
    ? fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8') : '';
  if (!html) { warn('样式加载顺序', 'index.html 未找到'); return; }

  const pos = name => html.indexOf(`href="/${name}"`);
  const styles = pos('styles.css');
  const tokens = pos('tokens.css');
  const responsive = pos('responsive.css');

  if (tokens === -1 || responsive === -1) {
    strict ? fail('样式加载顺序', 'index.html 未引入 tokens.css 或 responsive.css')
           : warn('样式加载顺序', '尚未引入新样式文件 —— T1/T2 待做');
    return;
  }
  if (styles !== -1 && (tokens < styles || responsive < tokens)) {
    fail('样式加载顺序', '加载顺序必须是 styles.css → tokens.css → responsive.css，否则覆盖不生效');
  } else {
    pass('样式加载顺序', 'styles → tokens → responsive');
  }
})();

// ---------- 规则 6：禁止引入第二套卡片模板 ----------
(function checkDualTemplate() {
  const suspects = listJs().filter(f => {
    const t = read(f) || '';
    // 按屏宽分支输出不同模板的典型写法
    return /matchMedia\s*\(|innerWidth\s*[<>=]|clientWidth\s*[<>=]\s*\d{3}/.test(t);
  });
  if (suspects.length) {
    warn('双套模板', `${suspects.join(', ')} 里出现按屏宽分支的写法，确认不是用来切换列表模板（布局应由 CSS 断点负责）`);
  } else {
    pass('双套模板', '未发现按屏宽切换模板的代码');
  }
})();

// ---------- 输出 ----------
const icons = { pass: 'PASS', fail: 'FAIL', warn: 'WARN' };
console.log('');
console.log(`UI 设计合规审计  ${strict ? '(严格模式)' : '(默认模式)'}`);
console.log('对照文档：docs/UI_施工卡.md   基线：' + require('../package.json').version);
console.log('-'.repeat(72));
for (const r of results) {
  console.log(`${icons[r.level]}  ${r.item.padEnd(12, ' ')} ${r.detail}`);
}
console.log('-'.repeat(72));

const failures = results.filter(r => r.level === 'fail');
const warnings = results.filter(r => r.level === 'warn');
console.log(`通过 ${results.filter(r => r.level === 'pass').length} · 警告 ${warnings.length} · 失败 ${failures.length}`);
if (failures.length) {
  console.log('');
  console.log('存在失败项，按 docs/UI_施工卡.md 对应章节修正后重跑。');
  process.exit(1);
}
if (!strict && warnings.length) {
  console.log('警告项属于未开工的批次，不算失败。施工完成后请用 --strict 复核。');
}
console.log('');
