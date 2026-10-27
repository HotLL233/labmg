# UI 施工卡（执行指令）

基线：`0.10.1`／`docs/UI_DESIGN_SYSTEM.md`。编写日期：2026-10-22。

2026-10-26 续篇：本轮 0.13.1 按 [R 系列整改方案](UI_整改方案.md)执行 R0–R2。本卡下文保留原 T 系列历史指令；冲突处由文末第 10 节限定替代。

## 0. 这张卡怎么用

**这张卡是施工指令，不是设计参考。** 每一条都写明了「改哪个文件、哪个选择器、现在是什么、改成什么」。

- **不要重新做设计判断。** 卡里写 `13px` 就写 `13px`，不要因为"看起来可以 14px"而改。所有数值已按中文可读性和 WCAG AA 验过。
- **卡里没写的，不要改。** 你觉得该改但卡里没有 → 停下来记进提交说明的"待确认"，不要顺手做。
- **设计意图与实现冲突时，以卡为准，并在提交说明里写明冲突点。**
- 设计规范原文（`docs/UI_DESIGN_SYSTEM.md`）只在卡里指向它时去查，不要通读后自行发挥。

---

## 1. 三条铁律（违反即返工）

1. **不改压缩行。** `src/public/styles.css` 第 1 行是整份压缩 CSS（约 3000 字符单行，含 `:root` 变量与全部基础样式）。**不要编辑它、不要格式化它、不要拆行。** 所有改动以新文件覆盖层的形式追加，靠加载顺序生效。
2. **不写第二套模板。** 手机端表格转卡片**只允许 CSS 重排**，禁止在 `material.js` 里按屏宽分支输出不同的 `innerHTML`。
3. **旧类名全部保留。** 新样式用新类名叠加。不重命名、不删除 `.side` / `.nav` / `.page` / `.table` / `.pill` / `.primary` 等现有类，否则会连带打断 11 个前端脚本和现有测试。

---

## 2. 文件归属

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `src/public/tokens.css` | **新建** | 设计令牌 + 全局排版覆盖层 |
| `src/public/responsive.css` | **新建** | 断点与表格转卡片（第 4 节） |
| `src/public/index.html` | 改 | 在两个 `<link>` 处按顺序插入新文件（见 2.1） |
| `src/public/styles.css` | **不动** | 见铁律 1 |
| `src/public/material.css` | 追加 | 只在文件末尾追加物资模块的新类名，不改已有规则 |
| `src/public/*.js` | 按卡改 | 仅限第 5、6 节点名的位置 |

### 2.1 加载顺序（决定覆盖是否生效）

`tokens.css` 必须在 `styles.css` **之后**；`responsive.css` 最后。

```html
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/material.css">
<link rel="stylesheet" href="/tokens.css">      <!-- 新增：令牌 + 排版覆盖 -->
<link rel="stylesheet" href="/responsive.css">  <!-- 新增：断点 + 表格转卡片 -->
```

> `index.html` 里现有的 `<link>` 若是别的顺序，**只插入这两行，不重排已有行**。

---

## 3. 令牌层（`tokens.css`）

### 3.1 变量必须映射旧变量

现有变量在 `styles.css` 第 1 行 `:root` 内，只有 8 个：`--navy --blue --bg --line --text --muted --green --red`。

**新令牌必须用 `var()` 引用旧变量，不许重新硬编码同一个色值。** 这样以后调整品牌色只需改一处。

```css
:root{
  /* 品牌（全部引用旧变量，禁止写死色值） */
  --c-navy:        var(--navy);
  --c-primary-500: var(--blue);
  --c-bg:          var(--bg);
  --c-line:        var(--line);
  --c-text:        var(--text);
  --c-text-2:      var(--muted);
  --c-success:     var(--green);
  --c-danger:      var(--red);

  /* 新增派生色（旧变量里没有的） */
  --c-primary-50:#eef4ff;
  --c-subtle:#fafbfd;
  --c-surface:#fff;
  --c-text-3:#8a98ab;

  /* 字号阶梯：6 级，无 11px */
  --fs-page:22px;   /* 页面标题 */
  --fs-panel:18px;  /* 面板标题 */
  --fs-body:14px;   /* 正文、表格主字段 */
  --fs-label:13px;  /* 表单标签、表头、次级信息 */
  --fs-note:12px;   /* 唯一的说明文字档 */

  /* 间距阶梯：8 的倍数 */
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px;
  --sp-7:32px;

  /* 控件 */
  --h-control:36px;
  --h-row:44px;
  --h-row-2:64px;
  --r-sm:8px; --r-md:12px; --r-lg:14px;
  --ring:0 0 0 3px #2c6df63d;   /* 品牌色 8 位透明变体：审计脚本允许此例外，纯色值仍必须写 var() */
}
```

### 3.2 排版覆盖（写完 3.1 立刻跟上，否则令牌没生效）

```css
/* 表格：主字段 14px，标签 13px，单元格 11/14，数字右对齐 */
.page .table th{font-size:var(--fs-label)}
.page .table td{font-size:var(--fs-body);padding:11px 14px}
.page .table th{padding:10px 14px}
.page .table td:has(> strong){line-height:1.35}

/* 状态徽章：11px → 13px（现有 .pill 是 11px） */
.pill{font-size:var(--fs-label);padding:3px 9px;border-radius:20px;font-weight:500}
.mw-badge,.mw-toolbar label,.mw-field label{font-size:var(--fs-label)}
.ms-files input{font-size:var(--fs-label)}

/* 说明文字：12px 是下限，不得再小 */
td small,.card small,.field small,.mw small,.mw-dialog small,.mw-field small,.mw-version{font-size:var(--fs-note)}

/* 数字列：右对齐 + 等宽数字（只作用于打了 .num 的列，见第 6 节） */
.page .table .num,.page .table td.num{text-align:right;font-variant-numeric:tabular-nums}

/* 焦点环：深色侧栏与浅色面板都要看得见 */
:is(button,input,select,textarea,a,[tabindex]):focus-visible{
  outline:2px solid var(--c-primary-500);outline-offset:2px;box-shadow:var(--ring)
}
.side :is(button,a):focus-visible{outline-color:#7fa9ff}
```

> `:has()` 在 2023 年后的所有主流浏览器可用；本项目无 IE 需求。若 `:has()` 因故不可用，删掉那条规则，不要用 JS 补。

---

## 4. 断点与表格转卡片（`responsive.css`）

### 4.1 断点定义（替换旧的 900/600）

| 名称 | 范围 | 行为 |
| --- | --- | --- |
| 桌面 | ≥ 1280px | 侧栏 245px（保持现值）、表格全列 |
| 窄桌面 | 1024–1279px | 侧栏 72px 图标条、表格全列 |
| 平板 | 768–1023px | 侧栏 72px、表格横向滚动留在自身容器内 |
| 手机 | ≤ 767px | 侧栏变抽屉、**表格必须转卡片** |
| 小屏 | ≤ 390px | 卡片单列、控件全宽 |

**旧的 `900px` / `600px` 规则不要删**（它们在 `styles.css` 压缩行内，删不得）。新断点写在 `responsive.css`，靠加载顺序覆盖；新旧重叠区段以新文件为准。

### 4.2 表格转卡片（最容易做错的一处，照抄）

**前提**：表格必须是现有结构 `<div class="table"><table><thead><tr><th>…`。不要改 HTML 结构。

```css
@media (max-width:767px){
  /* 容器不再横向滚动——这是手机端溢出的根源，
     现状是 table{min-width:760px} 把容器撑破 */
  .page .table{overflow:visible;border:0;background:transparent}
  .page .table table{min-width:0;display:block}
  .page .table thead{display:none}
  .page .table tbody{display:block}

  .page .table tr{
    display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;
    padding:12px 14px;margin-bottom:10px;
    background:var(--c-surface);border:1px solid var(--c-line);border-radius:var(--r-md);
  }
  .page .table td{
    display:block;padding:0;border:0;font-size:var(--fs-body);min-width:0;
    overflow-wrap:anywhere;
  }

  /* 字段名来自 data-label，见 4.3 */
  .page .table td[data-label]::before{
    content:attr(data-label);
    display:block;font-size:var(--fs-note);color:var(--c-text-2);
    margin-bottom:2px;
  }

  /* 首列（名称/勾选框）占满一行并加粗 */
  .page .table td:first-child{grid-column:1/-1;font-weight:600}

  /* 分组行：colspan 行会错位，单独压成组标题卡 */
  .page .table tr:has(td[colspan]){grid-template-columns:1fr;background:var(--c-subtle)}

  /* 操作列：按钮撑满并靠右 */
  .page .table td.cell-act{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
}
```

### 4.3 `data-label` 注入（唯一允许的一次性脚本改动）

手机端卡片的字段名靠 `td::before{content:attr(data-label)}`，`data-label` 必须来自 `thead`。**在表格渲染完成后统一注入，不要在每张表的 render 函数里手写。**

在 `src/public/app.js` 顶部工具区（与其它 `function` 同级）加：

```js
// 表格转卡片：从 thead 取字段名注入 data-label（手机端卡片用）
function labelTable(root){
  (root || document).querySelectorAll('table').forEach(table=>{
    const ths = [...table.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    if(!ths.length) return;
    table.querySelectorAll('tbody tr').forEach(tr=>{
      const tds = [...tr.children];
      // 分组行（colspan）跳过，否则标签整体错位
      if(tds.some(td=>td.hasAttribute('colspan')) || tds.length !== ths.length) return;
      // 首列是勾选框时 th 文本为空，字段名应取第 2 列，勾选框浮到卡片右上角
      tds.forEach((td,i)=>{
        const label = ths[i] || (i === 0 ? ths[1] : '') || '';
        if(i === 0 && /checkbox|radio/.test(td.querySelector('input')?.type || '')) return;
        if(label) td.setAttribute('data-label', label);
        else if(i === 0 && ths[1]) td.setAttribute('data-label', ths[1]);
      });
    });
  });
}
```

调用点：每个把 `innerHTML` 写进列表容器的函数**末尾**加一行 `labelTable(容器)`。物资模块在 `material.js` 的列表渲染函数中调用。

> 若某张表首列是勾选框，额外加 CSS：`.page .table tr{position:relative}` 且 `.page .table td:first-child input{position:absolute;top:12px;right:14px}`。

### 4.4 手机导航（三态同一份 DOM）

```css
@media (max-width:767px){
  .side{
    width:min(280px,82vw);transform:translateX(-100%);
    transition:transform .26s cubic-bezier(.32,.72,0,1);z-index:80;
  }
  body.drawer-open .side{transform:none}
  body.drawer-open .scrim{display:block}
  .scrim{display:none;position:fixed;inset:0;background:#0f172399;z-index:75}
  main{margin-left:0;width:100%}
  header{height:auto;position:sticky;top:0;z-index:40}
  .page{padding:14px}
  /* 触控下限 44px */
  .page button,.nav button{min-height:44px}
  /* 批量操作条贴底，避开底部导航 */
  .bulkbar{bottom:calc(68px + env(safe-area-inset-bottom))}
}
@media (max-width:390px){
  .page{padding:12px}
  .page .table tr{grid-template-columns:1fr}
  .grid{grid-template-columns:1fr}
}
```

底部导航（≤767px 固定 5 项：工作台 / 物资 / 验收 / 库存 / 更多）需要新增 DOM，归到批次 F，**不要在本批次顺手做**。

---

## 5. 逐项施工清单

按批次顺序，每项独立可交付、可回滚。

### 5.1 T1 令牌与排版（可独立于任何功能批次，风险最低）

| 位置 | 现在 | 改成 |
| --- | --- | --- |
| 新建 `tokens.css` | 无 | 第 3.1 + 3.2 节全文 |
| `index.html` `<link>` 区 | 只有 `styles.css` / `material.css` | 追加 `tokens.css` |
| `.pill` | `font-size:11px` | `13px`（3.2 已含） |
| `th` | `12px` | `13px` |
| `td` | `13px` / padding `13px 15px` | `14px` / padding `11px 14px` |

**验收**：桌面端表格一屏多显示 2–3 行；状态徽章明显变大；无任何 11px 正文。

#### 5.1.1 全部 7 处 11px 的处理（已逐个核实，不要自己再找）

全部靠 `tokens.css` 末尾的覆盖层解决，**不要编辑 `material.css` / `material-scan.css` 的原规则**（它们也是紧凑单行格式，与 `styles.css` 同理）。

| # | 选择器 | 文件 | 用途 | 目标 |
| --- | --- | --- | --- | --- |
| 1 | `.pill` | `styles.css` | 状态徽章 | **13px** |
| 2 | `.mw-toolbar label` | `material.css` | 表单标签 | **13px** |
| 3 | `.mw-badge` | `material.css` | 物资徽章 | **13px** |
| 4 | `.ms-files input` | `material-scan.css` | 文件输入 | **13px** |
| 5 | `.mw small` / `.mw-dialog small` | `material.css` | 说明文字 | **12px** |
| 6 | `.mw-field small` | `material.css` | 字段说明 | **12px** |
| 7 | `.mw-version` | `material.css` | 版本号 | **12px** |

前 4 处是正文级（必须 ≥13px），后 3 处是说明级（12px 为下限）。改完后 `node scripts/ui-audit.js` 的「字号下限」应报 0 处违规、「字号存量」警告消失。

### 5.2 T2 断点与表格转卡片

| 位置 | 动作 |
| --- | --- |
| 新建 `responsive.css` | 第 4 节全文 |
| `index.html` | 追加 `responsive.css`（最后一行） |
| `app.js` | 加 `labelTable()` 函数（4.3） |
| 各列表渲染函数 | 末尾加 `labelTable(容器)` 调用 |

**验收**：390px 宽度下，任一列表页**无横向滚动**，每行显示为带字段名的卡片。

### 5.3 T3 验收页就地匹配/新建（对应优化方案批次 B）

| 位置 | 现在 | 改成 |
| --- | --- | --- |
| 验收表单 | 物资信息为空时只能退出 | 表单内加"物资信息"区块：名称预填申报值、检索命中即关联、未命中展开「规格/单位/分类」并调建档接口 |

前端结构参考 `docs/prototypes/ui-redesign.html` 的 `data-page="acceptance"`，**只取结构与字段，不取配色**（配色以 `tokens.css` 为准）。

### 5.4 T4 库存台账七列（对应优化方案批次 C）

列顺序固定：**入库时间 · 名称 · 数量 · 规格 · 单位 · 厂家 · 备注**。

```css
/* material.css 末尾追加 */
.page .table td.num{text-align:right;font-variant-numeric:tabular-nums}
.stock-group-head{background:var(--c-subtle);font-weight:600}
.stock-expiry-soon{border-left:3px solid #d98324}   /* 临期：行首色条，不整行变色 */
```

规则：数量列加 `class="num"`；临期标记只加行首色条，**不得改整行背景色**（会破坏可读性与打印）。

---

## 6. 禁止事项（每条都有具体理由）

| 不要做 | 为什么 |
| --- | --- |
| 编辑 `styles.css` 的压缩行 | 单行 3000+ 字符，任何编辑都极易破坏相邻规则且 diff 不可读 |
| 为手机端另写卡片 `innerHTML` | `material.js` 会维护两份模板，后续每次改字段都要改两处，这是本项目最易出错的位置 |
| 重命名现有类名 | 11 个前端脚本 + 现有测试都依赖 `.page` / `.table` / `.pill` 等 |
| 引入 CSS 框架 / Web Font / 构建链 | `AGENTS.md`：不新增运行时依赖，交付特征是"4 个直接依赖 + 无构建" |
| 用 JS 按屏宽切换布局 | 断点应在 CSS；JS 判断屏宽会导致 resize 时不重算、打印时错乱 |
| 删掉旧 `@media(max-width:900px/600px)` | 它们在压缩行内，删改风险高于收益；新断点靠覆盖生效 |
| 把 `:has()` 换成 JS 补丁 | 不支持时删掉该规则即可，功能不受影响 |

---

## 7. 交付前自检（必须执行并贴结果）

```pwsh
node scripts/ui-audit.js      # 设计合规审计：存量 / 新增两类，新增违规会让退出码为 1
npm test                      # 现有基线不得变红
node scripts/check.js         # 语法
```

浏览器实测（项目已有真实浏览器断言基建，见 `tests/mobile-layout.test.js`）：

- 390px 宽度：列表页无横向滚动，卡片字段名齐全
- 768px 宽度：侧栏为图标条，表格留在自身容器内滚动
- 1440px 宽度：桌面双栏布局与此前一致
- 打印预览：单据列不缺、不截断

**提交说明里必须写清**：做了哪几项 T 编号、审计输出的新增违规数、实测了哪几个宽度、哪些没验证。

---

## 8. 与优化方案的关系

- 本文是 `docs/优化方案.md` 的**界面部分施工细则**，不改变其批次划分。
- T1 可与任意批次并行（纯样式）；T2 必须在 T3/T4 之前（否则新页面又要补一遍适配）。
- 冲突时以 `docs/优化方案.md` 的硬约束为准，本文只补充"怎么做"。

## 9. W1–W4：记录工作区（0.13.0，2026-10-23）

用户已批准[页面密度与记录工作区方案](UI_WORKSPACE_OPTIMIZATION.md)实施。本节补充原T1–T4未覆盖的页壳、导航和滚动边界，不把此前原型验证当成正式页面验收。

| 编号 | 文件与选择器 | 施工要求 |
| --- | --- | --- |
| W1 | `server.js` `/api/auth/me`；`app.js` `.header-identity`、`#logout` | 复用package版本返回`appVersion`，常驻账号、版本和“退出登录”；保留真实注销与未保存／提交保护。搜索和新建放业务工具栏，避免挤压账号区 |
| W1 | 新增`workspace.js`／`workspace.css`，在`responsive.css`后加载 | 复用原table／dialog与事件，统一表头、记录网格、完整工作区详情及分页；已有服务端分页不得再次切DOM，派生分页不能复制后失去处理器或上下文 |
| W2 | `material.js` 物资信息库／基础设置，`material.css`追加 | 物资库真实翻页、名称14px主显／编码12px次显；分类、区域、库位、编号分别查看，保留原能力，不增加区域改名等业务 |
| W3 | `material.js` 各记录表／详情 | 保留库存七列与全局合计，批次数量分别标注；验收进度与历史事件分区；三级返回保留查询、页码和原页签，历史流水不变成可编辑单元格 |
| W4 | `archive.js`／`asset.js`／`contract.js`／`quality.js`／`audit.js`／`datahub.js`，新增`module-workspace.css` | 去重复横幅，分类用紧凑页签；设备保留真实统计摘要，生命周期使用记录表；导出／备份按用途分区，已有权限与导出内容不变 |

桌面普通列表以1366×768和1440×900核对筛选、完整记录和分页同屏；900×650、768×1024与390×844验证必要滚动及同DOM卡片，1366×480验证末字段和保存仍可达。不能用硬裁切、缩小字号或隐藏错误来达成“一屏”。长文本、更多菜单、未保存离开、版本缺失、真实注销和打印必须单独检查。

本节继续遵守原三条铁律和字号／颜色令牌。交付运行普通及严格UI审计、语法、完整现有回归，并追加正式页面真实API与浏览器检查；仅新增共享JS/CSS时不引入构建链或运行依赖。

## 10. R0–R2 施工补充（0.13.1，2026-10-26）

- 本轮只执行 R0–R2；R3/R4 留在后续 0.13.2，不将其验收项写成本轮完成。
- 字号采用 micro 11／note 12／label 13／body 14／panel 18／page 22／metric 24 七档，行高采用 tight 1.3／body 1.5／prose 1.7。正文与表单标签下限仍为 13px，说明下限仍为 12px。
- 替代第 3、5.1.1 节的 pill 13px 要求：仅 `.pill`、`#app-version`、`.ws-context [data-ws-version]` 可用 `font-size:var(--fs-micro)`；禁止裸 11px、正文引用 micro、通过其他变量间接引用 micro。新的单位／角标选择器须明确补充用途与审计，不默认放行。
- 统一屏幕表格 8×12px 内边距、表头 13px、正文 14px 和竖线；fixed 仅作用于桌面／平板的真实 `<table>`。通过既有 `cell-act` 标记识别操作列，不能把库存末列备注当操作。
- R2 允许修改 `material.js` 的共享页签显示及其明确点击调用者；复用原 resize 监听更新溢出状态，首次进入从头显示，用户点击才显露选中项，不创建第二套 DOM。
- `styles.css` 与其他压缩前缀保持不动；屏幕排版不覆盖打印。按五档真实浏览器、必要的低高度与打印检查验收，审计通过只说明静态规则符合，不能代替视觉与业务回归。
- 回滚涉及本轮 CSS、页签 JS、审计与相应测试，不再使用“只回滚四份 CSS”的旧描述。

## 11. M1–M4 施工补充（0.14.0，2026-10-26）

用户已批准[按单验收简化方案](MATERIAL_WORKFLOW_SIMPLIFICATION.md)及其补充流程。本节限定本次新增范围，不以此标记旧 R3/R4 全部完成。

| 编号 | 文件、选择器 | 施工要求 |
| --- | --- | --- |
| M1 | `material.js` 主入口、物资设置 | 主页只保留申报／验收／库存；物资信息库及原设置移入设置区，保留普通人员查询及既有角色＋操作权限 |
| M2 | 新增 `material-acceptance.js`；`material.css` 追加 `.mw-order-*`／`.mw-arrival-*` | 按单分页、完整明细；剩余量预填，实付金额、申报／实到厂家、位置常驻，差异就地展开；办理验收与到货清单切签，资料不得挤压验收表。桌面扣除表头后至少可见一整行，本区操作列在768px以上固定右侧；低高度及手机允许必要滚动，手机可返回选单列表；错误、返回、提交和退出均可达 |
| M3 | 新增 `material-original.js`／`material-original.css`；`app.js` 登录恢复；`index.html` 引入 | 固定修订原单复用单套表格 DOM、集中 `labelTable()`；纸面单号／修订／QR 和勾选、实到、备注留白。二维码采用当前有效访问 origin，登录后回到同一修订。原单 A4 打印独立作用域，不改实物标签校准 |
| M4 | `material.js` `.mw-compact` 短操作 | 只精简申报明细、资料维护、领用及期初补录短表单；长记录、标签设计和复杂明细继续原工作区，不全站压缩 dialog |

继续遵守压缩前缀不动、同 DOM 响应式、原类名及令牌。五档宽度、低高度、长单据和真实 API 工作流需单独验证；普通及严格 UI 审计通过不能替代事务、权限、设备或视觉验收。

## 12. 0.14.2：物资表列宽与库存页内领用（2026-10-27）

本轮只调整明确物资表的列宽、库存短领用表单与重复账号栏，不据此标记旧 R3/R4 全部完成。以下规则替代第 10 节及此前覆盖层中“全部桌面表 fixed、首列统一 26%、按数字单元格或列号猜日期／数量宽度”的实现；表格字号、内边距、手机同 DOM 卡片与真实操作列 sticky 规则继续保留。

| 文件、选择器 | 施工要求 |
| --- | --- |
| `tokens.css` 桌面表格覆盖 | 删除通用 fixed／首列宽度、数字统一 104px 及根据内容猜日期／名称宽度；保留换行、数字对齐与真实 `cell-act` 操作列规则 |
| `material.js` 共享 `table()` | 通过可选表类参数把语义类放到实际 `<table>`，不得加第二套表格 DOM；仅四类主表 fixed，其余表保留原生 auto，按单验收已有 fixed 独立保留 |
| `material.css` 末尾 `screen and (min-width:768px)` | 库存 `.mw-stock-table` 依次为 116px／23%／96px／18%／68px／10%／余宽；末列是备注，不按操作列处理。申报 `.mw-request-table` 为余宽／88px／88px／116px／104px／176px；领用 `.mw-issue-table` 为 116px／22%／10%／96px／余宽／12%／144px；物资库 `.mw-catalog-table` 为余宽／18%／80px／80px／68px／104px／160px。六类表内的旧文本 min/max-width 不参与列分配，不新增宽表 min-width |
| `.mw-request-items-table`／`.mw-opening-items-table` | 保留 auto，明确申报数量 88px、进度 116px、操作 152px；期初数量金额 128px、批次有效期 132px、操作 96px。余列由浏览器按内容分配，避免现有最小表宽下用途或位置被固定列挤空 |
| `material.js`／`material.css` `.mw-issue-inline`、`.mw-issue-summary` | 复用原领用表单、校验、版本保护与请求流程，嵌入库存表上方 `#mw-inline-form-slot`，不打开模态遮罩。摘要按名称规格／批次位置分成两逻辑行，允许完整换行；数量与用途两列，用途初始两行且可扩展，手机单列。提交、取消、错误与长文本均可达，不靠裁切或隐藏错误压缩高度 |
| `workspace.js` | 页内短表单不重复插入账号／退出栏，完整工作区保持原账号上下文与真实退出流程 |

新增 CSS 只在分行区或文件末尾追加，不触碰压缩前缀；列宽只作用于 768px 以上屏幕，不覆盖手机或打印。先运行普通及严格审计，再以真实浏览器核对四主表长名稳定、库存名称与规格相对宽度、备注可读、768px 表内滚动与操作可达、390px 同 DOM 卡片，以及内联领用取消／错误／提交和打印七列。静态审计通过不代表浏览器、API 或设备验收完成。

## 13. 截图纠正：全局账号与下级工作区（2026-10-27）

用户在0.14.2截图中确认完整验收记录仍重复账号栏、申报及物资库首列占据过多空白、短表单贴到屏幕左侧。以下要求替代第12节“完整工作区保持原账号上下文”和相关列宽，不把旧版静态／浏览器通过作为本次问题已解决的证据。

- `workspace.js`：所有经Workspace打开的下级工作区只使用主框架现有账号、版本与退出，不再注入`.ws-context`。外置工作区用非模态`show()`，只禁用业务背景和非当前子层；主header及侧栏保留实际可点击能力，继续经过未保存、忙态和未知结果保护。保留原专门关闭事件、Escape、嵌套返回及焦点恢复；扫码／标签等独立模态不在本次替换范围。
- `workspace.css`末尾：外置子工作区位于全局header下方及侧栏右侧，背景业务内容隐藏且不可操作，只显示当前子层。短表单在该内容区域水平居中、最大760px，限制可用高度、表体必要滚动；手机单列、底部操作可达。手机以`.ws-dialog .mw-dialog-body>.mw-table table{min-width:0}`覆盖旧600px表格限制，内部卡片和操作按钮也不得横向被裁。页内领用表单保持原布局，屏幕规则不覆盖打印。
- `material.css`末尾，768px以上：申报表六列依次32%／9%／9%／18%／12%／20%；物资库七列30%／22%／11%／8%／8%／9%／12%。各列总和100%，不把全部余宽交给名称；删除`tokens.css`按按钮内容猜物资操作列宽的三条旧规则，通用96px规则排除已有六类语义表，由各语义表自行配置。库存七列及手机卡片规则保持，长内容可换行，不新增表格最小宽度。
- 验证必须包含完整验收记录、物资详情／批次／单件三级返回和新建／编辑表单：全局账号仅一份、header位置不动、真正点击退出触发原脏输入保护（不得以脚本直接调用onclick替代），背景不可编辑，Escape与保存状态正确；宽屏、125%缩放相当尺寸、五档宽度及低高度检查列宽、居中和操作可达。普通及严格审计仍须通过，未实际执行的设备／发布验证单独说明。
