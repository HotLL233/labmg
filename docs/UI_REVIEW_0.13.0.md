# 0.13.0 页面 UI 复查与整改意见

复查日期：2026-10-23。复查对象：`v0.13.0`（源码冻结 `1a15ae0`）。
复查方式：以本版真实 API + Edge 产出的 27 张截图为主证据，逐条回到源码定位成因；`scripts/ui-audit.js` 普通/严格双模式 8 通过 / 0 警告 / 0 失败，说明现有审计只查存量不倒退，**不覆盖本文所列的布局与可用性问题**。

证据目录：`artifacts/cache/0.13.0/workspace-layout-uaCZep/`（`report.json` 同批，status=passed，截图含 1440/1366/900/768/390 与 1366×480）。
对照基准：`docs/UI_WORKSPACE_OPTIMIZATION.md`（0.13.0 的验收口径）、`docs/UI_施工卡.md`、`docs/UI_DESIGN_SYSTEM.md`。

## 0. 结论

0.13.0 把"信息结构优先、一屏优先、同 DOM 手机卡片化"的骨架落下来了，桌面 1366/1440 主路径可用。
但**三个关键断点失守**：768px 操作列不可见、手机横向页签被自己滚出视野、手机档案分类独占首屏；另有 4 处跨模块样式互相污染（主按钮被降级、状态色单一、数字列右对齐、弹窗内重复退出）。这些问题都不需要改框架，属于精准局部修改。

排版层面单列于第 7 节（T1–T8）：表格排版双套并行、字号 15 级 / 令牌 5 级、行高 7 档、列宽无 `table-layout` 约束。这几项是地基，不先收口，后面修任何单点样式都可能被另一套规则覆盖。

## 1. P0 阻断（不修即影响完成任务）

### P0-1 768px 下表格操作列被裁到视口外，用户看不到「查看／编辑」

- 现象：`768-archives.png` 表格右端只剩半个「操」字和半截蓝色链接，操作列整体在可视区外。
- 成因：`responsive.css:4-13` 在 768–1279 用 72px 图标侧栏，主区 696px、`.page` 左右各 20px 后内容宽 656px；而 `styles.css` 的 `table{min-width:760px}`、`material.css` 的 `.mw table{min-width:800px}` 没有跟着降。表格靠 `.table{overflow:auto}` 横向滚动兜底，但没有任何滚动提示。
- 影响：1280 以下只有这一档会把主操作挤出屏幕，恰好是 768×1024 竖屏平板的主力尺寸。
- 整改（任选其一，建议 B）：
  - A：在 `@media (min-width:768px) and (max-width:1023px)` 内把表格 `min-width` 降到 `0`，允许列内文字换行。
  - B：操作列吸附：`.page .table td:last-child,.page .table th:last-child{position:sticky;right:0;background:var(--c-surface);box-shadow:-8px 0 8px -8px #14263d26}`，配合 `min-width` 保留。
- 验收：768×1024 下首屏可见「查看/编辑」，且 `document.scrollWidth===clientWidth`；操作列在横向滚动到底前始终可见。

### P0-2 手机端横向页签被 `revealTabs()` 自己滚出视野，入口"消失"

- 现象：`390-catalog.png` 页签条第一个只剩「员」字（物资申报被裁掉大部分）；`390-settings-numbering.png` 从「库存」开始，「物资申报」「验收」完全不可见。
- 成因：`material.js:60 revealTabs()` 为了让选中项可见，主动改写 `nav.scrollLeft`，把左侧页签推出容器；容器只有 `overflow-x:auto`，没有两端渐隐或箭头提示。
- 影响：用户进入「物资信息库」后看不到「物资申报／验收」，会认为系统没有这些入口 —— 这是导航级误导，不是样式细节。
- 整改：
  1. `revealTabs()` 改为只在**用户点击页签之后**滚动；首次渲染保持 `scrollLeft=0`。
  2. 滚动容器加两端渐隐：`mask-image:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%)`，仅在有溢出时开启。
  3. ≤600px 更稳的方案：只平铺前 3 个高频页签，其余收进「更多 ▾」。
- 验收：390 下页签条左侧第一个页签完整可见；`scrollLeft` 首次进入为 0；有溢出时左右各有可感知提示。

### P0-3 手机端档案分类 8 个竖排，独占首屏，一条记录都看不到

- 现象：`390-archives.png` 分类区从 y≈235 排到 y≈590，共 8 行（每行「分类名 + N 条可见记录」），首条记录卡从 y≈650 才开始，844 视口内只能看到半张卡。
- 成因：`module-workspace.css:9` 把 `.archive-menu` 设为 `display:flex;flex-wrap:wrap`，但按钮保留了 `padding:8px 12px` 与 `small` 计数文本，390 下两个按钮就超宽 → 每行一个；`.side` 同性质的横向 chip 方案没有复用。
- 影响：档案页手机端首屏 60% 是筛选项，且 6 行显示「0 条可见记录」，是无价值信息。
- 整改：
  1. ≤767px 分类区改为横向滚动 chip（与物资页签一致）：`flex-wrap:nowrap;overflow-x:auto`，并复用 P0-2 的渐隐。
  2. 计数只在**选中项**显示，未选中项只留分类名 —— 390 下每项约 60–100px，一行可放 3–4 个。
  3. 分类为空（0 条）的项排在末尾或折叠进「更多」。
- 验收：390×844 首屏至少完整可见 1 条记录卡片；分类区高度 ≤ 56px。

### P0-4 `.ops button` 覆盖 `.primary`，合同页主按钮被降级成文字链

- 现象：`1440-contracts-sections.png`「新建委托单位」渲染为蓝色文字，与其它页面「新建 XX」的蓝色实心主按钮完全不同。
- 成因：`contract.js:2` 把按钮写进 `<div class="ops">`，而 `styles.css` 有 `.ops button{background:none;color:var(--blue);padding:4px 7px}`。特异性 `.ops button`(0,0,1,1) 高于 `.primary`(0,0,1,0)，背景被 `none` 覆盖。
- 影响：主操作降级为次级链接，用户在第一屏找不到「怎么新建」；同一系统内主操作样式出现两套。
- 整改：把 `styles.css` 的 `.ops button` 收窄为 `.ops>button:not(.primary):not(.ghost)`，或改为 `.page .ops button.primary{background:var(--blue);color:#fff;padding:10px 15px}`。前者更彻底。
- 验收：合同页主按钮背景为 `--blue`，与物资／档案页「新建」按钮同款；`.ops` 内的行内操作链接样式不变。

## 2. P1 明显劣化（影响扫读与操作准确性）

### P1-1 所有状态一律绿色 pill，语义色失效

- 证据：`styles.css` `.pill{color:var(--green);background:#eaf8f1}`，无状态分支。「草稿」「启用中」「已驳回」「拒收」全部绿色（`1440-archives.png`、`1440-catalog.png`）。
- 整改：给状态 span 输出 `data-status`，按四档配色：中性（草稿/停用，灰）、进行中（已提交/部分验收，蓝）、完成（已验收/已发放，绿）、异常（驳回/拒收/作废，红）。`material.js` 已有 `mw-badge.green/amber/red`，直接复用。
- 验收：档案页与物资页的「草稿」为中性灰；四种语义在截图中可区分。

### P1-2 手机卡片内数字列右对齐，标签跟着跑到右半边

- 证据：`390-settings-numbering.png`「流水位数 / 6」整体位于卡片右侧，与上方「编号对象 / 物资编码」的左基线错位；「操作 / 编辑规则」同样靠右。
- 成因：`tokens.css:35` `.page .table td.num{text-align:right}`，卡片化（`responsive.css:51-57`）后 `td` 变 `display:block`，`::before` 继承 `text-align:right`，标签一并右对齐。
- 整改：在 `@media (max-width:767px)` 内补 `.page .table td.num{text-align:left}`，数值本身保留 `font-variant-numeric:tabular-nums`。
- 验收：390 下所有卡片字段标签左对齐同一基线。

### P1-3 弹窗内重复出现「退出登录」，手机上是红色实心

- 证据：`390-asset-lifecycle.png` 弹窗顶部 context 条右侧是红色实心「退出登录」；`1440-asset-lifecycle.png` 同位置为红框按钮。`workspace.js:26` 给每个 dialog 插入该按钮。
- 影响：详情页顶部最显眼的位置放退出登录，手机端误触即丢上下文；且与主 header 重复。
- 整改：`workspace.js:26` 的 context 条只保留版本与当前账号，删掉退出按钮；退出登录仅在主 header 出现一次，样式由 danger 红降为 ghost 描边。
- 验收：弹窗内不存在「退出登录」；主 header 退出按钮为非红色危险色的次级样式。

### P1-4 只有一页也显示分页器

- 证据：`workspace.js:56` `state.pager.hidden=state.rows.length===0` —— 只在 0 条时隐藏。`1440-settings-numbering.png`「共 5 条 · 第 1/1 页 · 每页 11 条」+ 两个禁用按钮；`390-asset-lifecycle.png`「共 2 条 · 第 1/1 页 · 每页 10 条」。
- 整改：改为 `state.pager.hidden=pages<=1`，保留状态文字为可选的「共 N 条」。
- 验收：单页数据下不出现上一页/下一页按钮。

### P1-5 关闭/返回按钮文案三套、且在同一弹窗重复出现

- 证据：详情弹窗右上 `.x` 写「返回列表」，footer 又有一个「返回列表」（`1440-asset-lifecycle.png`、`390-asset-lifecycle.png`）；物资编辑弹窗写「← 返回」（`1366x480-edit.png`）；其它弹窗写「关闭」。
- 整改：统一为一个动词 —— 抽屉类弹窗右上用「← 返回列表」，footer 不再重复放返回；表单类弹窗右上用「关闭」，footer 只留「取消/保存」。
- 验收：同一弹窗内返回动作只出现一次，全站文案不超过两种。

### P1-6 空态只是空白面板，没有出路

- 证据：`1440-audit-sections.png`、`1440-contracts-sections.png`、`1440-quality-sections.png` 空态是 `padding:55px` 的一行「暂无日志。」，下方整屏留白，无「新建」「清除筛选」入口。这与 `UI_WORKSPACE_OPTIMIZATION.md:67` 自定的「空数据和无匹配分别给新建／导入和清除筛选入口」直接冲突。
- 整改：`.empty` 内加一行主操作（有写权限时「＋ 新建…」）+ 次级「清除筛选」，并把 `padding` 从 55px 收到 32px。
- 验收：空态在 200px 高度内呈现「原因 + 主操作 + 清除筛选」，不再是纯留白。

### P1-7 日期筛选无标签、无「至」、两个框长得一模一样

- 证据：`datahub.js:3 setupDateFilters()` 只设了 `title`（悬停才可见），插入两个 `type=date`。截图里 `1440-archives.png`、`390-archives.png` 是两个并排的 `yyyy-mm-dd`，桌面同一行、手机占两行，用户无法判断起止。
- 整改：包一层 `<label class="date-range"><span>起始</span><input…><span>至</span><input…><span>结束</span></label>`，窄屏保持单行可横滚；补 `aria-label`。
- 验收：截图中起止关系无需悬停即可识别；390 下单行呈现。

### P1-8 标题层级重复：h1、页签、面板标题三层同名

- 证据：物资页 h1「物资管理」→ 页签「物资信息库」→ 面板 h3「物资信息库」（`1440-catalog.png`）；体系文件页 h1「体系文件」→ 页签「体系文件」→ h3「法定标准」→ 描述行（`1440-quality-sections.png`）。与 `UI_WORKSPACE_OPTIMIZATION.md:26`「同一工作区只保留一个主要标题」冲突。
- 整改：面板 h3 与当前页签同名时隐藏（保留 `aria-label` 供读屏），或把 h3 换成右侧的记录数摘要。
- 验收：任一页面视觉上同名标题只出现一次。

### P1-9 物资信息库顶部 4 个平级按钮 + 同屏两个主按钮

- 证据：`1440-catalog.png`「新建物资 / 导入 Excel / 导入模板 / 导出 Excel」四连；390 下换行成 3+1，「导出 Excel」孤立一行（`390-catalog.png`）。同时筛选栏「查询」也是蓝色主按钮，与「新建物资」同屏对撞。
- 整改：
  1. 只保留「＋ 新建物资」为主按钮，「导入/导出」收进「更多 ▾」。
  2. 搜索走已有的 250ms 输入即筛（`app.js` 里 `#search` 已是该模式），「查询」降为 ghost 或移除，「重置」保留。
- 验收：面板头部主按钮 ≤1 个；同屏蓝色主按钮 ≤1 个。

## 3. P2 打磨

| 编号 | 问题 | 证据 | 整改 |
| --- | --- | --- | --- |
| P2-1 | 二级页签选中态用 primary 实心蓝，与主操作按钮同款 | `1440-settings-numbering.png`（物资分类/归属区域/存放库位/编号规则） | 选中态统一为「白底 + 主色文字 + 细边框」，与一级页签一致 |
| P2-2 | 数据不足以分页时仍显示「每页 11 条」 | `1440-settings-numbering.png` | 与 P1-4 合并处理 |
| P2-3 | 整列为空仍固定占宽（负责人、有效期全 `-`） | `1440-archives.png` | 空列率 100% 时折叠进详情，或列宽收窄到 64px |
| P2-4 | 破坏性操作「清空当前模块日志」与「导出日志」同权重，桌面蓝/手机红不一致 | `1440-audit-sections.png`、`390-audit-sections.png` | 统一为 danger 文字按钮 + 二次确认文案，与导出分开排布 |
| P2-5 | 长名称 `nowrap` 被截断成三行加省略号 | `390-catalog.png` 首行、`.mw table{white-space:nowrap}` | 卡片内 `td{white-space:normal}`，名称允许两行后省略 |
| P2-6 | 「恢复与升级」页是纯运维口吻段落，没有任何操作入口 | `1440-backup-recovery.png` | 拆成「能做什么 / 需要注意什么 / 怎么做」三段，并把恢复入口放进同页 |

## 4. 建议整改批次

| 批次 | 范围 | 涉及文件 | 说明 |
| --- | --- | --- | --- |
| U1 | P0-1 ~ P0-4 | `responsive.css`、`workspace.css`、`module-workspace.css`、`styles.css`、`material.js`、`contract.js` | 纯布局与样式收敛，不碰业务逻辑、接口、数据 |
| U2 | P1-1、P1-2、P1-4、P1-6、P1-7 | `tokens.css`、`workspace.js`、`datahub.js`、各模块 render | 状态色、断点复位、分页隐藏、空态、日期标签 |
| U3 | P1-3、P1-5、P1-8、P1-9 + P2 | `workspace.js`、`app.js`、`material.js`、`archive.js`、`quality.js`、`audit.js` | 涉及文案与按钮编排，改动面最大，单独一批方便回滚 |

硬约束（与前序施工卡一致）：
- 不新增依赖，不重写渲染函数，不做双套 DOM 模板。
- 手机端仍走「同一份表格 DOM + CSS 重排」，不新写卡片模板。
- 每批改完跑 `node scripts/check.js`、`node scripts/ui-audit.js` 与 `node scripts/ui-audit.js --strict`，并至少产出 390／768／1366／1440 四档截图。

## 5. 验收与回归要求

1. **断点**：390×844、768×1024、900×650、1366×768、1440×900 五档，`document.scrollWidth === clientWidth` 且无控件被裁。
2. **可操作性**：首屏必须能看到「主操作 + 至少一条记录（或明确空态出路）」；768 档操作列可见。
3. **一致性**：主按钮在全站同款；同屏蓝色主按钮 ≤1 个；返回文案 ≤2 种；状态色按四档语义区分。
4. **不得回退**：`ui-audit.js` 普通与 `--strict` 均需 8/0/0；`tests/workspace-layout.test.js`、`tests/mobile-layout.test.js` 现有断言全通过。
5. **新增断言**（建议）：
   - 768 档：操作列 `getBoundingClientRect().right <= container.right`。
   - 390 档：页签容器 `scrollLeft === 0`，且首个页签完整可见。
   - 任意档：`pages<=1` 时分页器 `hidden`。
   - 任意弹窗：不存在文案为「退出登录」的按钮。

## 6. 不做清单

- 不做主题切换、暗色模式。
- 不引入组件库或 CSS 框架。
- 不重排业务字段、不增删表格列（P2-3 的收窄除外）。
- 不改打印样式与标签模板布局（本版 `@media print` 规则保持不动）。
- 不把「一屏优先」扩大解释为禁止滚动。

## 7. 排版专项（补充复查）

前面 6 节偏结构与交互。单看排版，问题不是「某处不好看」，而是**没有单一来源**：同一类元素在不同文件里各有各的字号、行高、内边距，谁最后加载听谁的。以下 T1–T8 全部可在源码中直接验证。

### T1 两套表格排版并行：换一个模块，表头字号、行高、竖线全变

- 证据：`material.js:42` 的物资模块外壳是 `<div class="mw mw-workspace">`，`material.css:37-63` 用令牌重写了一整套表格规则（表头 `--fs-label`=13px、内边距 `--sp-2/--sp-3`=8×12px、每列 `border-right` 竖线）；而档案／审计／合同／体系走 `tokens.css:28-29` 的旧值（表头 13px、内边距 10-11×14px、无竖线）。
- 截图对照：`1440-catalog.png` 有列竖线、行更紧；`1440-archives.png` 无竖线、行更松。两者在一屏内切换即可感知跳跃。
- 整改：只保留一套。把 `material.css:37-63` 里与表格相关的规则去掉 `.mw-workspace` 前缀，上移到 `.page .table` 层；同时删除 `material.css:1` 那串裸 px（`padding:14px 18px`、`font-size:13px`、`line-height:1.7`），避免漏前缀就退回旧值。
- 验收：任取两模块截图叠合，表头字号、行高、单元格内边距、是否带竖线四项一致。

### T2 字号阶梯失控：实际 15 级，令牌只有 5 级

- 证据：项目中出现的裸 `font-size` 为 11 / 12 / 13 / 14 / 16 / 17 / 18 / 19 / 20 / 21 / 22 / 23 / 24 / 25 / 27，共 15 级；`tokens.css` 只定义 `--fs-page:22 / --fs-panel:18 / --fs-body:14 / --fs-label:13 / --fs-note:12`。其中 `--fs-page:22px` **定义了却从未被任何规则引用**（全项目仅出现在定义行）。
- 同一「页面主标题」有 4 处互相覆盖的声明：`styles.css` `header h1{23px}`、`styles.css:85` `@≤600 .layout>main>header h1{21px}`、`workspace.css:4` 与 `:53` `.header-heading h1{var(--fs-panel)}`。后两者特异性更高，导致 ≤600px 的 21px 规则实际失效。
- 整改：收敛为 6 级 —— 11（仅角标/单位）/ 12 / 13 / 14 / 18 / 22；把 `--fs-page` 真正用到 h1；删除 `styles.css` 的 27/23/21/20/19、`material.css` 的 24/17、`asset.css` 的 25，各归到最近一级。
- 验收：`grep -o "font-size:[0-9]*px" src/public/*.css | sort -u` 结果不超过 6 个值。

### T3 行高 7 档，中文正文用 1.35 偏紧

- 证据：1.35 / 1.4 / 1.5 / 1.6 / 1.7 / 1.8 / 1.9 并存。表格正文 `workspace.css:18`、`tokens.css:30` 用 1.35；说明文字 `material.css` `.mw-hint{line-height:1.9}`；旧套 `.mw small{line-height:1.7}`。
- 问题：12–14px 的中文在 1.35 下行距约 16–19px，字面几乎贴住；而同一页的说明文字用 1.9，节奏跳变。中文舒适区是 1.5–1.7。
- 整改：三档定死 —— 标题 1.3、正文与表格 1.45–1.5、说明 1.7。
- 验收：卡片内「名称 + 编码」上下两行之间有明显呼吸感，且说明段落行距不超过表格行距的 1.2 倍。

### T4 列宽不受控：`table-layout` 全项目未声明

- 证据：`grep table-layout src/public/*.css` 为空，列宽由内容自适应。
- 后果：`1440-archives.png` 中「可查看角色」列约占 160px 只放一个 `ADMIN`，同屏「档案名称 / 编号」只有约 195px，名称一长就顶到边界；`1440-catalog.png` 名称列约 288px 仍被压成三行加省略号。
- 整改：`.page .table{table-layout:fixed}`，每张表配 `<colgroup>` 百分比：名称列 ≥26%、状态/数量列 88–104px、操作列 96px、其余均分。长文本列允许 `overflow-wrap:anywhere`。
- 验收：把名称改成 30 个汉字后，其余列的宽度和位置不变。

### T5 名称与编码的层级靠字号硬拉，且间距三套

- 证据：`material.css:1` `.mw td strong{font-size:13px}`；`tokens.css:29` `.page .table td{font-size:14px}` —— 未套 `.mw-workspace` 的表格里，**主字段（名称）比正文还小 1px**。`material.css:53` 有 14px 的修正，但只认 `.mw-workspace` 前缀。行内间距同样三套：`.mw small{margin-top:3px}`、`.mw-workspace .mw-table td small{margin-top:var(--sp-1)=4px}`、`tokens.css` 的 `td small` 无 margin。
- 整改：`strong` 统一 14px/600、`small` 统一 12px/400 + `margin-top:4px`；层级靠颜色（`--c-text` vs `--c-text-2`）拉开，不靠缩字号。
- 验收：同一行内名称明显重于编码，且名称不小于正文。

### T6 字体栈缺现代兜底

- 证据：全项目唯一一处 `font-family:"Segoe UI","Microsoft YaHei",sans-serif`（`styles.css:1`），没有 `system-ui`、`-apple-system`、`PingFang SC`、`Noto Sans SC`。
- 后果：Windows 走雅黑、iPad 走苹方、英数在非 Windows 平台落到 Helvetica，同一界面跨设备字形与字宽都会漂；中文 12px 在雅黑下笔画偏虚。
- 整改：`font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI","PingFang SC","Noto Sans SC",sans-serif`；编号/编码类单独给 `font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-variant-numeric:tabular-nums;letter-spacing:.02em`。
- 验收：`MAT-20261023-000001`、`ARCHIVE-17` 这类编号在等宽字体下逐字符对齐。

### T7 垂直节奏没有基准值

- 证据：同属「面板内边距」就有 21×22、14×22、13×21、28×32 四组（`.mw-panel-top` / `.mw-toolbar` / `.mw-pagebar` / `.page`），而 `workspace.css:12` 又把 `.page` 覆盖成 16×20。空态 `.empty{padding:55px}` 是唯一一个非 4 的倍数。
- 整改：统一到 8 的倍数（8 / 12 / 16 / 24 / 32）；空态 `padding:32px`。
- 验收：设计走查时横向拉一条 8px 网格线，主要分界线都能对上。

### T8 手机卡片字段间距过小，字段边界糊在一起

- 证据：`responsive.css:47` 卡片 `gap:6px 12px`，`:56` 的 `td[data-label]::before{margin-bottom:2px}`。`390-archives.png` 里「档案分区 / 体系文件档案」与下一行「可查看角色」之间只有 6px，视觉上连成一段。
- 整改：`row-gap` 提到 10px，`::before` 下间距 4px；或给每个字段加 `border-top:1px solid var(--c-line)` 极淡分隔。
- 验收：390 下每条记录的 4–6 个字段能被一眼切成独立条目。

### 排版整改顺序

T2、T3、T7 是「先立规范」（改令牌与基准值，不改变观感上限），T1、T4、T5 是「按规范收口」（消除双套），T6、T8 是末端打磨。建议 T2→T3→T1→T4→T5→T7→T6→T8，前两步做完再动表格，否则改一处会被另一套覆盖，白改。
