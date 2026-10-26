# UI 整改施工方案（0.13.0 → 下一版）

编写日期：2026-10-23。基线：`v0.13.0`（源码冻结 `1a15ae0`）。
执行校正：2026-10-26，首轮限定 0.13.1／R0–R2。下列真实 DOM、调用链与审计冲突按本轮核对补充，不将后续 R3/R4 记为已完成。
本文是 `docs/UI_REVIEW_0.13.0.md`（问题清单）的**施工化版本**，是 `docs/UI_施工卡.md` 的续篇（R 系列）。问题清单负责"是什么"，本文负责"谁、改哪个文件、改成什么、怎么验收"。

---

## 0. 怎么用这份方案

- **按 R 编号领活。** 每项写明文件、选择器、现状、目标、验收断言。领到哪条做哪条，不跨条顺手改。
- **三条铁律继续有效**（见 `docs/UI_施工卡.md` 第 1 节）：不改压缩行、不写第二套模板、旧类名全部保留。
- **本文是施工指令，不是设计建议。** 写了 `--fs-body` 就用 `--fs-body`，不要判断"14 还是 15 好看"。
- **本文没写的不要改。** 觉得该改 → 记进提交说明的"待确认"，不要动手。
- 与 `UI_REVIEW_0.13.0.md`、`UI_WORKSPACE_OPTIMIZATION.md` 冲突时，以本文为准；本文未涉及的，仍按原文档。

### 0.1 改动权限表（只读这份表决定能不能动某个文件）

| 文件 | 权限 | 说明 |
| --- | --- | --- |
| `src/public/tokens.css` | **可改** | 全局令牌与排版覆盖层，R0/R1 主战场 |
| `src/public/responsive.css` | **可改** | 断点、卡片化，R2 主战场 |
| `src/public/workspace.css` | **可改** | 0.13.0 新增文件，全文分行，可直接改值 |
| `src/public/module-workspace.css` | **可改** | 同上 |
| `src/public/material.css` | **仅可改 25–95 行的分行区块** | 1–9 行是压缩行，**禁止触碰** |
| `src/public/styles.css` | **只读** | 整份压缩单行，任何改动走覆盖层 |
| `src/public/asset.css`、`material-scan.css` | **只读** | 压缩单行，走覆盖层 |
| `src/public/index.html` | 可改 | 仅在需要调整 `<link>` 顺序时（本方案**不需要**） |
| `src/public/*.js` | 按条目限定 | R2-2 含共享函数及明确点击调用者；后续 R3-2、R3-4、R3-5、R3-6、R4-1、R4-2、R4-3、R4-4 按各条所需限定，不据此扩大业务范围 |

加载顺序（决定覆盖是否生效，**本方案全部依赖此顺序，不要调整**）：
`styles → material → material-scan → tokens → responsive → workspace → module-workspace`

---

## 1. 判断

0.13.0 的骨架是对的，问题集中在两件相互独立的事：

1. **地基没有单一来源。** 字号 15 级（令牌 5 级）、行高 7 档、表格内边距 3 套、垂直节奏 4 组基准。谁后加载听谁的，改一个点会被另一套盖回去。
2. **三个断点失守。** 768 操作列出屏、手机页签被自己滚出视野、手机档案分类独占首屏。

所以顺序必须是**先地基（R0）→ 再表格（R1）→ 再断点（R2）→ 最后组件语义与编排（R3/R4）**。R0 不做就动 R1，等于在流沙上砌墙。

---

## 2. 问题 → 任务映射

| 来源编号 | 问题 | 落到 |
| --- | --- | --- |
| T2 | 字号 15 级、`--fs-page` 空转、h1 四处声明 | R0-1、R0-2 |
| T3 | 行高 7 档，中文正文 1.35 | R0-3 |
| T7 | 垂直节奏 21×22 / 14×22 / 13×21 / 28×32 | R0-4 |
| T1 | 物资与其余模块两套表格 | R1-1 |
| T4 | 无 `table-layout`，列宽被内容绑架 | R1-2 |
| T5 | 主字段 13px < 正文 14px，small 间距三套 | R1-3 |
| — | 数字列缺等宽对齐 | R1-4 |
| P0-1 | 768 操作列被裁 | R2-1 |
| P0-2 | 手机页签被 `revealTabs` 滚出视野 | R2-2 |
| P0-3 | 手机档案分类 8 行独占首屏 | R2-3 |
| P0-4 | `.ops button` 覆盖 `.primary` | R3-1 |
| P1-1 | 状态 pill 全绿 | R3-2 |
| P1-2 | 手机卡片 `td.num` 右对齐错位 | R3-3 |
| P1-3 | 弹窗内重复「退出登录」 | R3-4 |
| P1-4 | 单页也显示分页器 | R3-5 |
| P1-5 | 返回文案三套且重复 | R3-6 |
| P1-6 | 空态无出路 | R4-1 |
| P1-7 | 日期筛选无标签无「至」 | R4-2 |
| P1-8 | 标题三层同名 | R4-3 |
| P1-9 | 物资面板 4 按钮 + 双主按钮 | R4-4 |
| T6 | 字体栈缺兜底 | R4-5 |
| T8 | 手机卡片字段间距过小 | R4-6 |
| P2-* | 二级页签样式、空列、破坏性操作、长名截断、备份页 | R4-7（打包处理） |

---

## 3. R0 地基：令牌与节奏（先做，风险最低）

### R0-1 字号阶梯收敛为 7 级

- 文件：`tokens.css`（改 `:root`，第 14–18 行区域）
- 现状：项目实际出现 15 级裸值（11/12/13/14/16/17/18/19/20/21/22/23/24/25/27）；`--fs-page:22px` 定义了但全项目无引用；h1 有 4 处互相覆盖的声明。
- 目标：

```css
:root{
  --fs-micro:11px;   /* 仅角标、单位、pill、版本号 */
  --fs-note:12px;    /* 次要说明、编码、字段标签 */
  --fs-label:13px;   /* 表格表头、表单标签、按钮 */
  --fs-body:14px;    /* 正文、单元格主值 */
  --fs-panel:18px;   /* 面板标题、弹窗标题 */
  --fs-page:22px;    /* 页面主标题 */
  --fs-metric:24px;  /* 工作台指标大数字、设备统计数字 */
}
```

- 归并对照（覆盖层规则追加在 `tokens.css` 末尾，**不改 `styles.css`**）：

```css
/* heading 归一：浏览器默认 h2/h3 字号混进了视觉体系，必须显式指定 */
.page h2,.hero h2{font-size:var(--fs-panel)}
.page h3,.mw-panel-top h3{font-size:var(--fs-body);font-weight:600}
.module h3{font-size:var(--fs-panel)}
.card strong,.asset-cards strong{font-size:var(--fs-metric)}
.pill{font-size:var(--fs-micro)}
.mw-dialog-head h2{font-size:var(--fs-panel)}
.mw-head h2{font-size:var(--fs-page)}
```

- 不接受的做法：为了"看起来差不多"保留 17px／21px／23px／25px／27px 中的任意一个。
- 验收：`grep -oE "font-size:[0-9]+px" src/public/*.css | grep -vE "1[1234]px|18px|2[24]px"` 只在 `styles.css`／`material.css`／`asset.css` 的压缩行里命中（存量放行），四个覆盖层文件零命中。

### R0-2 主标题只留一处声明

- 文件：`workspace.css` 第 4 行、第 53 行
- 现状：`styles.css` 的 `header h1{23px}`、`styles.css:85` 的 `@≤600 .layout>main>header h1{21px}`、`workspace.css:4/:53` 的 `var(--fs-panel)`=18px 三处并存；后两者特异性更高，导致 21px 规则实际失效。
- 改：两处 `var(--fs-panel)` → `var(--fs-page)`。
- 说明：`styles.css:85` 的 21px 保留不动（它已被覆盖，删除属额外改动，本轮不做；记入"待确认"）。注意它在 `@media screen and (max-width:600px)` 内，且 `styles.css` 在本方案中列为**只读**。
- 验收：1440／768／390 三档截图主标题字号一致；600px 以下不再单独变小。

### R0-3 行高收敛为三档

- 文件：`tokens.css`（新增变量 + 覆盖），`workspace.css:18`、`tokens.css:30`
- 现状：1.35／1.4／1.5／1.6／1.7／1.8／1.9 并存在同一个页面里。
- 目标：

```css
:root{--lh-tight:1.3;--lh-body:1.5;--lh-prose:1.7}
```

| 用途 | 值 | 应用位置 |
| --- | --- | --- |
| 标题 | `--lh-tight` | `.header-heading h1`、`.mw-panel-top h3`、`.mw-dialog-head h2` |
| 表格正文、字段值 | `--lh-body` | `.page .table td`、`.ws-records td`、`.detail-item` |
| 说明、提示、段落 | `--lh-prose` | `.mw-hint`、`.mw-sub`、`.datahub-panel p`、`.mw-pagebar` |

- **警告**：表格行高从 1.35 提到 1.5，单行记录会高约 3–4px，双行记录约 6–8px，`Workspace.fit()` 按可用高度算出的每页条数会少 1 条。**这是预期行为，不是 bug**，不要在 JS 里改成固定条数。
- 验收：卡片内名称与编码两行之间有明确空隙；同屏说明段落行距不超过表格行距的 1.2 倍。

### R0-4 垂直节奏统一到 8 的倍数

- 文件：`module-workspace.css`、`material.css`（仅分行区块）
- 现状：面板内边距 21×22、14×22、13×21、28×32 四组；空态 `padding:55px` 是唯一非 4 的倍数。
- 目标：

| 位置 | 现在 | 改成 |
| --- | --- | --- |
| `.mw-panel-top` | 21px 22px | `var(--sp-3) var(--sp-4)` = 12×16 |
| `.mw-toolbar` | 14px 22px | `var(--sp-2) var(--sp-4)` = 8×16 |
| `.mw-pagebar` | 13px 21px | `var(--sp-2) var(--sp-4)` = 8×16 |
| `#page` 区块间距 | 12px | 保持 12px（已合规） |
| `.page` 内边距 | 28×32（已覆盖） | 保持 `workspace.css:12` 的 16×20 |
| `.empty` | 55px | 32px |

- 验收：设计走查时横向拉 8px 网格，主要分界线对齐；空态高度不超过 240px。

---

## 4. R1 表格统一（R0 完成后做）

### R1-1 一套表格密度取代两套

- 文件：`tokens.css` 第 28–29 行
- 现状：`material.js:42` 的物资外壳带 `mw-workspace`，走 `material.css:37-63` 的令牌版（表头 13px、8×12 内边距、每列 `border-right` 竖线）；档案／审计／合同／体系走 `tokens.css:28-29`（表头 13px、10-11×14 内边距、无竖线）。截图中 `1440-catalog.png` 有竖线、行紧，`1440-archives.png` 无竖线、行松。
- 改：

```css
.page .table th{
  font-size:var(--fs-label);padding:8px 12px;
  background:var(--c-subtle);border-right:1px solid var(--c-line);
}
.page .table td{
  font-size:var(--fs-body);padding:8px 12px;line-height:var(--lh-body);
  border-right:1px solid var(--c-line);
}
.page .table tr>:last-child{border-right:0}
```

- 注意：`.mw th,.mw td{padding:14px 18px}` 在 `material.css` 压缩行内，特异性 (0,0,1,1) 低于 `.page .table td` (0,1,1,1)，会被正确覆盖，**不需要动压缩行**。弹窗内的表格由 `material.css:52` 的 `.mw-dialog .mw-table td` 负责，本条不涉及。
- 验收：任取档案页与物资页截图叠合，表头字号、行高、内边距、竖线四项一致。

### R1-2 列宽受控

- 文件：`tokens.css`
- 现状：`table-layout` 全项目未声明，列宽由内容决定。`1440-archives.png` 中「可查看角色」占约 160px 只放一个 `ADMIN`，同屏「档案名称 / 编号」只有约 195px。
- 改：

```css
.page .table table{table-layout:fixed}
.page .table th:first-child{width:26%}
.page .table th:last-child{width:96px}
.page .table td.num,.page .table th.num{width:104px}
.page .table td,.page .table th{overflow-wrap:anywhere}
```

- 逐表核对（固定布局后列宽会变，必须一张张看截图）：档案、合同、体系、审计、物资、库存六张表。任一表出现内容挤压 → 该表单列指定宽度，**不要为了让某表好看而放宽全局值**。
- 实际 `.table` 是 div 容器，fixed 限屏幕且宽度 ≥768px；操作宽度只给既有 `cell-act` 标记对应的列。库存末列是备注，不按操作列处理。
- 2026-10-26 逐表测量例外：物资库操作列 **160px**（查看／编辑／更多同排），验收 **152px**（办理验收／记录／结案／原单至多两行），领用 **144px**（查看／发放／驳回／取消申请至多两行）；其他操作列继续 **96px**。仅以现有行按钮识别这三种表，不扩大到库存备注或验收事件表。
  - 原 1440px 真实物资库截图中，96px 操作列将三项操作排成三行，每页只有4行。随后按当前源 CSS 和相同按钮结构在 Edge 合成页面测量：物资库行高 107.5→57.2px；验收 169.5→88.5px；领用 139→76px。测量记录位于 `artifacts/cache/0.13.1/r1-ops-measure.json`，只证明这组 CSS／按钮的布局，不等同真实业务全档验收或实体设备验证；修改后仍须运行正式页面五档截图回归。
- 验收：把名称改成 30 个汉字后，其余列位置与宽度不变；操作列不被挤出容器。

### R1-3 名称与编码层级靠颜色，不靠缩字号

- 文件：`tokens.css`
- 现状：`material.css` 压缩行 `.mw td strong{font-size:13px}` 让主字段比正文 `td{14px}` 还小；small 间距有 3px／4px／0 三套。
- 改：

```css
.page .table td strong{font-size:var(--fs-body);font-weight:600;line-height:var(--lh-tight)}
.page .table td small{font-size:var(--fs-note);line-height:1.4;margin-top:4px;color:var(--c-text-2)}
```

- 验收：同一行内名称明显重于编码，且名称不小于正文；名称与编码间距在所有模块一致。

### R1-4 数值列等宽对齐

- 文件：`tokens.css` 第 35 行（已有规则上追加）
- 改：

```css
.page .table .num,.page .table td.num{
  text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;
}
```

- 验收：`3 瓶 / 12 瓶 / 1024 瓶` 三个值右端对齐、数字等宽。

---

## 5. R2 断点修复

### R2-1 768–1023 操作列不再出屏

- 文件：`responsive.css`（在 `@media screen and (min-width:768px) and (max-width:1279px)` 块内追加）
- 现状：该档侧栏 72px，主区内容宽 656px，而表格 `min-width` 为 760/800px，操作列被推到横向滚动区外。`768-archives.png` 右端只剩半个「操」字。
- 改：

```css
.page .table td.cell-act,.page .table table:has(tbody td.cell-act:last-child) th:last-child{
  position:sticky;right:0;z-index:2;
  background:var(--c-surface);
  box-shadow:-8px 0 8px -8px #14263d26;
}
.page .table table:has(tbody td.cell-act:last-child) th:last-child{background:var(--c-subtle)}
```

- 不采用「把 min-width 降到 0」：那会让长编码把列压成两字一行，比横向滚动更难读。
- 验收：768×1024 下首屏可见「查看/编辑」；横向滚到最左与最右时操作列位置不变；`document.scrollWidth === clientWidth`。

### R2-2 手机页签不再被自己滚出视野

- 文件：`material.js` 第 60 行 `revealTabs()`；`material.css` 分行区块（`.mw-nav`）
- 现状：为了让选中项可见主动改 `scrollLeft`，390 下把「物资申报」推到容器外（`390-catalog.png` 只剩「员」字）；容器无溢出提示。
- 改：
  1. `revealTabs()` 仅在**用户明确点击页签后**显露选中项；从点击调用者传递意图。实际渲染替换整段 DOM，不能依赖替换后的 `document.activeElement`。首次进入 `scrollLeft=0`，溢出属性仍计算；二次分页渲染保留本次用户滚动位置。
  2. 容器加两端渐隐，有溢出才生效：

```css
.mw-nav,.archive-menu{overflow-x:auto;overscroll-behavior-x:contain}
@supports (mask-image:linear-gradient(#000,#000)){
  .mw-nav[data-overflow="true"]{
    mask-image:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%);
  }
}
```

  3. `data-overflow` 在同一函数末尾设置（`nav.dataset.overflow = String(nav.scrollWidth > nav.clientWidth)`），`resize` 时重算。
- 不做：「更多 ▾」收纳（见待拍板第 5 条）。
- 验收：390 下首个页签完整可见、`scrollLeft === 0`；有溢出时两端各有一段渐隐。

### R2-3 手机档案分类改横向 chip

- 文件：`module-workspace.css` 第 9 行、`archive.js:1` 注入的样式块
- 现状：390 下 8 个分类各占一行（每项带「N 条可见记录」），占掉约 355px，首条记录被推到 y≈650。
- 改（≤767px）：

```css
@media screen and (max-width:767px){
  #page .archive-menu{flex-wrap:nowrap;overflow-x:auto;padding:4px}
  #page .archive-menu button{flex:0 0 auto;width:auto;padding:8px 10px}
  #page .archive-menu button small{display:none}
  #page .archive-menu button.active small{display:inline;margin-left:4px}
}
```

- 说明：`archive.js:1` 的 `.archive-menu button{width:100%}` 特异性 (0,1,1) 低于 `#page .archive-menu button` (1,1,1)，无需改 JS。
- 验收：390×844 首屏至少完整可见 1 条记录卡片；分类区高度 ≤56px；选中项仍显示计数。

---

## 6. R3 组件语义与缺陷修复

### R3-1 主按钮不再被 `.ops` 降级

- 文件：`tokens.css`（覆盖，不改 `styles.css`）
- 现状：`contract.js:2` 把按钮放进 `.ops`，被 `styles.css` 的 `.ops button{background:none;color:var(--blue)}`（0,0,1,1）压过 `.primary`（0,0,1,0），合同页「新建委托单位」渲染成蓝色文字。
- 改：

```css
.page .ops>button.primary{background:var(--c-primary-500);color:#fff;padding:10px 15px}
.page .ops>button.primary:hover{filter:brightness(.96)}
```

- 验收：合同页主按钮背景为 `--blue`，与档案／物资「新建」同款；`.ops` 内的行内「查看/编辑/删除」样式不变。

### R3-2 状态色按四档语义

- 文件：`tokens.css`（`.pill` 覆盖）+ 各模块 render 加 `data-status`
- 现状：`.pill{color:var(--green);background:#eaf8f1}` 无分支，「草稿」「拒收」「已驳回」全绿。
- 改：

```css
.pill[data-tone="neutral"]{color:#5b6b7f;background:#eef1f5}
.pill[data-tone="progress"]{color:#2c6df6;background:#eef4ff}
.pill[data-tone="done"]{color:var(--green);background:#eaf8f1}
.pill[data-tone="danger"]{color:var(--red);background:#fdeeee}
```

- 映射（在各模块 render 里按 status 值给 `data-tone`，**不新增业务状态**）：

| tone | 状态值 |
| --- | --- |
| neutral | 草稿、已停用、未验收（未开始）、已取消 |
| progress | 已提交、部分验收、待发放、进行中 |
| done | 已验收、已发放、启用中、已完成 |
| danger | 已驳回、拒收、作废、差缺结案 |

- 缺 `data-tone` 时回退为 neutral（用 `:not([data-tone])` 兜底），不出现无色 pill。
- 验收：档案页「草稿」为中性灰；四种语义在同屏可区分。

### R3-3 手机卡片数字列复位

- 文件：`responsive.css`（`@media screen and (max-width:767px)` 内）
- 现状：`td` 卡片化后 `text-align:right` 被 `::before` 继承，「流水位数 / 6」整体跑到卡片右半边（`390-settings-numbering.png`）。
- 改：

```css
.page .table td.num,.mw-dialog .table td.num{text-align:left}
```

- 验收：390 下所有卡片字段标签左对齐同一基线。

### R3-4 弹窗内移除「退出登录」

- 文件：`workspace.js` 第 26 行
- 现状：每个 dialog 都插入 context 条并带退出按钮，手机端为红色实心，位于详情页顶部。
- 改：`bar.innerHTML` 去掉 `<button … data-ws-logout>` 及其绑定；保留版本与账号。
- 注意：`index.html` 主 header 的 `#logout` 不动，退出逻辑不动。
- 验收：任意弹窗内不存在文案为「退出登录」的按钮；主 header 退出仍可用。

### R3-5 单页隐藏分页器

- 文件：`workspace.js` 第 56 行
- 现状：`state.pager.hidden = state.rows.length === 0`，1 页也显示「上一页/下一页」。
- 改：`state.pager.hidden = Math.max(1,Math.ceil(state.rows.length/state.size)) <= 1`
- 验收：`共 2 条`、`共 5 条` 的列表与详情内子表均不再出现分页按钮；0 条时仍隐藏。

### R3-6 返回文案统一

- 文件：`index.html`（两个 dialog 的 `.x` 与 footer）、`material.js` 弹窗头
- 现状：详情弹窗右上与 footer 都是「返回列表」；物资编辑弹窗写「← 返回」；其它写「关闭」。
- 改：
  - 抽屉式（`ws-dialog`）：右上「← 返回列表」，footer **只留**主操作（打印／保存），删除重复的返回按钮。
  - 表单式：右上「关闭」，footer 保留「取消 / 保存」。
- 验收：同一弹窗内返回动作只出现一次；全站文案不超过两种。

---

## 7. R4 编排与收尾

### R4-1 空态给出口

- 文件：`tokens.css` + 各模块空态字符串（`archive.js` / `contract.js` / `audit.js` / `quality.js`）
- 现状：`.empty{padding:55px}` 只有一行「暂无日志。」，下方整屏空白，无「新建 / 清除筛选」，与 `UI_WORKSPACE_OPTIMIZATION.md:67` 冲突。
- 改：

```css
.empty{padding:32px 16px;display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--c-text-2)}
.empty .empty-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
```

- 文案结构：原因一句 + 主操作（有权限才出现）+「清除筛选」。空数据与无匹配用不同主操作。
- 验收：空态总高 ≤240px，且首屏可见操作按钮。

### R4-2 日期筛选可读

- 文件：`datahub.js:3 setupDateFilters()`
- 现状：只设了 `title`，两个 `type=date` 并排，无「至」、无可见标签。
- 改：包一层 `<label class="date-range">`，顺序「起始 [date] 至 [date] 结束」，补 `aria-label`；`:placeholder-shown` 时用 `span` 显示占位说明。390 下保持单行（`flex-wrap:nowrap`）。
- 验收：截图无需悬停即可分辨起止；390 下单行呈现。

### R4-3 标题去重

- 文件：`module-workspace.css` / `material.css` 分行区块（样式层）+ 各模块 render（仅在有同名时隐藏 h3 文本）
- 现状：物资页 h1「物资管理」→ 页签「物资信息库」→ 面板 h3「物资信息库」；体系文件页 h1「体系文件」→ 页签「体系文件」→ h3「法定标准」+ 描述行。
- 改：h3 与当前页签同名时，用 `aria-label` 保留语义、视觉隐藏（`clip-path:inset(50%)` 方案，不用 `display:none`，避免读屏丢失）；不同名（如「法定标准」）保留但降为 `--fs-label` + 弱色。
- 验收：任一页面视觉上同名标题只出现一次。

### R4-4 物资面板按钮收敛

- 文件：`material.js:150`（按钮编排）
- 现状：「新建物资 / 导入 Excel / 导入模板 / 导出 Excel」四个平级，390 下换行成 3+1；同时筛选栏「查询」也是主按钮。
- 改：主按钮只留「＋ 新建物资」；导入导出收进 `<details class="mw-more"><summary>更多</summary>…`（复用已有的 `.mw-more`）；「查询」降为 `ghost`（搜索已是 250ms 输入即筛）。
- 验收：面板头部主按钮 ≤1 个；同屏蓝色主按钮 ≤1 个；390 下按钮区不出现单个孤立换行。

### R4-5 字体栈与编号等宽

- 文件：`tokens.css`
- 现状：唯一定义是 `"Segoe UI","Microsoft YaHei",sans-serif`，无 `system-ui` / `PingFang SC` / `Noto Sans SC`；编号在正文字体下逐字符不易比对。
- 改：

```css
body{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI","PingFang SC","Noto Sans SC",sans-serif}
td small,.mw-name small,.mw-text,.mw-number{
  font-variant-numeric:tabular-nums;
}
.mw-name small,.ws-context [data-ws-version]{
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;letter-spacing:.02em;
}
```

- 注意：`body` 的 `font-family` 在 `styles.css` 压缩行，`tokens.css` 里重写 `body{font-family:…}` 同特异性、后加载 → 生效。
- 验收：`MAT-20261023-000001`、`ARCHIVE-17` 在列表与详情中逐字符对齐。

### R4-6 手机卡片字段分隔

- 文件：`responsive.css`（`@media screen and (max-width:767px)` 内）
- 现状：卡片 `gap:6px 12px` + `::before{margin-bottom:2px}`，`390-archives.png` 里相邻字段几乎连成一段。
- 改：`row-gap:10px`，`::before{margin-bottom:4px}`；可选给除首字段外的 `td` 加 `border-top:1px solid var(--c-line)`。
- 验收：390 下每条记录 4–6 个字段能被一眼切成独立条目。

### R4-7 P2 打包处理（有余量再做）

| 项 | 改法 |
| --- | --- |
| 二级页签选中态用 primary 实心 | `#page :is(.archive-menu,…) button.active` 统一「白底 + 主色文字 + 细边框」，与一级页签同款 |
| 空列固定占宽 | 空值率 100% 的列在 render 时折叠（`archive.js` 负责人/有效期），或列宽收到 64px |
| 破坏性操作权重 | 「清空日志」统一 `mw-danger` 文字按钮 + 二次确认，与「导出」分开排布 |
| 长名称截断 | `.mw-workspace .mw-records td strong{ -webkit-line-clamp:2 }` 已有，扩展到 `.page .table td strong` |
| 备份页无入口 | 「恢复与升级」拆「能做什么 / 注意什么 / 怎么做」三段，恢复入口同页可见 |

---

## 8. 验收断言（建议直接写进测试）

按现有 `tests/workspace-layout.test.js` 的风格追加：

| 编号 | 断言 | 档位 |
| --- | --- | --- |
| A1 | 操作列 `getBoundingClientRect().right <= 容器 right` | 768×1024 |
| A2 | 页签容器 `scrollLeft === 0`，首个页签完整可见 | 390×844 |
| A3 | 分类区高度 ≤56px，且首条记录卡片进入视口 | 390×844 |
| A4 | `pages <= 1` 时分页器 `hidden === true` | 全部 |
| A5 | 弹窗内不存在 `textContent === '退出登录'` 的按钮 | 全部 |
| A6 | 表头字号 / 单元格内边距在两个模块间完全相等 | 1440×900 |
| A7 | `.ops` 内 `.primary` 的 `backgroundColor` 等于 `--blue` | 1440×900 |
| A8 | 390 下 `td.num` 的 `textAlign === 'left'` | 390×844 |
| A9 | 任意一档 `document.scrollWidth === clientWidth` | 全档 |

---

## 9. 回归门禁与环境前提

**必须执行并贴结果：**

```pwsh
node scripts/check.js
node scripts/ui-audit.js
node scripts/ui-audit.js --strict
```

**环境前提（2026-10-23 的历史检查快照；本轮重新核对，不能当作当前结果）：**

- 本机**没有可用的专用测试库密码**，`npm test` 会报 78 项 `PostgreSQL tests require LABOS_TEST_DATABASE_URL …` 失败 —— 是环境缺变量，不是代码问题。跑全绿需先起专用 PG 并设 `LABOS_TEST_DATABASE_URL`。
- 真实浏览器布局断言还需 `LABOS_TEST_BROWSER_MODULE` + `LABOS_TEST_BROWSER_PATH`，不设会静默 skip（**skip 不算通过**）。
- 运行全量测试前确认 `NODE_OPTIONS` 没有被注入 safe-delete shim，否则会拦截测试自身的清理动作导致大面积假失败。

**审计基线要同步：**

`scripts/ui-audit.js` 会核对「11px 存量 7 处已接管」「宽表格 min-width 声明 1 处」等计数。R0/R1 改动后这些计数可能变化：

- 若某条从 PASS 变 FAIL **且原因是本次整改造成**，同时更新 `scripts/ui-audit.js` 的基线常量与 `docs/UI_施工卡.md` 的对应描述。
- 不允许为了让审计变绿而放宽判定逻辑。先改代码，改不动才调基线，并在提交说明里写清理由。

---

## 10. 风险与回滚

| 风险 | 判断 | 应对 |
| --- | --- | --- |
| 行高 1.35→1.5 导致每页条数减少 | 预期，非缺陷 | 不在 JS 改固定条数；截图验收时按新条数核对 |
| `table-layout:fixed` 后个别表列宽失衡 | 中 | 六张表逐张截图核对；异常表单列指定宽度 |
| 字号统一后观感变化（主标题 18→22） | 高，用户可感知 | 单独一批提交，先给截图确认再合并 |
| sticky 操作列在打印时错位 | 低 | 在 `@media print` 内取消 sticky |
| `mask-image` 不支持 | 低 | 已加 `@supports` 包裹，降级为无渐隐 |
| 改动互相覆盖导致"改了没生效" | 高 | 严格按 R0→R1→R2 顺序；每条改完立即截图，不攒批 |

**回滚**：按批次提交，需同时回滚该批 CSS、页签 JS、审计和相应测试／文档。R2 涉及 `material.js`，不能仅回滚四份 CSS；不涉及数据库迁移。

---

## 11. 待拍板（均给默认值，不拍板就按默认执行）

| # | 事项 | 默认 |
| --- | --- | --- |
| 1 | 版本号 | `0.13.1`（只做 R0–R2）／`0.13.2`（含 R3–R4），不擅自合并 |
| 2 | 是否接受主标题 18→22px 的观感变化 | 接受 |
| 3 | 是否接受表格行高变大、每页少 1 条 | 接受 |
| 4 | 768 方案 | 操作列 sticky（不缩 `min-width`） |
| 5 | 手机页签是否上「更多 ▾」 | 本轮不做，先做 mask + 不自动滚 |
| 6 | `.ops` 是否改成新容器 | 不改结构，只在覆盖层修 `.primary` |
| 7 | R4-7（P2 五项）是否本轮做 | 不做，留到下一轮 |
| 8 | 是否需要 0.13.0 与整改后并排截图 | 需要，每档一张 |

---

## 12. 交付报告格式（施工方必须给）

```
批次：R0 / R1 / R2 / R3 / R4
完成条目：R0-1、R0-2、…
未完成条目及原因：…
审计：ui-audit 普通 N 通过 / N 警告 / N 失败；--strict 同上
回归：check.js 结果；npm test 结果（含跳过的说明条件）
截图：1440 / 1366 / 900 / 768 / 390 五档路径
未验证项：…
待确认项：…
IS_PASS: YES/NO
```
