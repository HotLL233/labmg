# 物资主档与申报解耦设计（已确认稿）

日期：2026-10-22。基线：`0.9.4`／`28ce719`。
来源：你指出「物资信息库很繁琐，申报时必须匹配这个库；首次申报（库里和库存都没有）也要匹配，流程很繁琐」，并给出库存明细应有字段：**入库时间、物资名称、数量、规格、单位、厂家、备注**。本节记录你随后对四个设计问题的答复，以及第二轮修正（D3 改为**申报模糊、验收完善**），作为实现依据。

---

## 0. 已确认的四项决策

| # | 问题 | 你的答复 | 落地含义 |
| --- | --- | --- | --- |
| D1 | 同名称+规格+单位、不同厂家算一种还是两种物资 | **算一种物资，但需区分厂家** | 查重键 = `名称+规格+单位`；厂家不进身份键，但主档、申报明细、验收批次、库存流水全链路记录，库存明细**按厂家拆行** |
| D2 | 库存明细的"备注"填在哪一步 | **两者都要** | ①批次备注：验收/调整时填，跟流水走；②物资档案备注：主档上固定一条 |
| D3 | 申报阶段是否按物资汇总 | **申报时物资信息可模糊，不用匹配物资库；验收时才完善信息，优先匹配物资库，库内没有的再新建** | **申报阶段不建档、不自动关联**（`catalog_id` 留空）；**验收环节**提供"检索匹配／就地新建"二选一，且先按名称+规格+单位自动复用已有档 |
| D4 | 自动建档产生的重复项要不要合并工具 | **本版就做** | 合并工具进本版范围，含库存流水/条码/申报明细的指向迁移 |

---

## 1. 现在为什么卡（机械原因，三条）

| # | 卡点 | 代码事实 |
| --- | --- | --- |
| 1 | 匹配体验本身没问题，已经"库存优先" | `/catalog?q=` 按库存量排序（`materials.js:165-177`），前端也提示"按所选范围库存优先显示"（`material.js:347`） |
| 2 | **申报时会被静默强制关联**，与"可模糊"冲突 | `lineInput()` 在未显式传 `catalogId` 时按编码或"名称+规格+单位"**自动匹配**（`materials.js:385-391`）；同名物资多于一条直接 `conflict('存在多个相同物资信息，请明确选择编码')`（`:389`） |
| 3 | **验收才是真正的硬关卡，而且卡在管理员手里** | 后端 `if (!line.catalog_id) conflict('验收、拒收或结案前请先匹配物资信息')`（`materials.js:803`）；前端同样抛错并把验收按钮禁用（`material.js:69`、`:256`）；而补挂入口 `POST /requests/:id/items/:itemId/catalog` 要求 `materials.catalog.write`（`materials.js:1360-1361`，MANAGER） |
| 4 | 没有主档就没有库存账 | `material_stock_movements.catalog_id BIGINT NOT NULL`（`schema.js:145`） |

所以你遇到的不是"必须匹配"，而是**该匹配的时机错了**：申报阶段被强行匹配，真正的验收入库阶段又必须由管理员先建档。你定的新流程（申报模糊、验收完善）正好把这两处掉个个儿。

**一个现成的好消息**：`createCatalog(data, user, reuse=true)` 已经实现了"优先复用、没有才建"——同名同规格同单位且唯一、分类与 `tracking_mode` 一致时直接返回已有档且 `created:false`（`materials.js:151-155`），编码也会自动生成 `MAT-<8字节hex>`（`:156`）。**D3 的"优先匹配再新建"不需要新写逻辑，只需要在验收事务里以 `reuse=true` 调它**；原方案里打算加的 `material_state.catalog_sequence` 与 `AUTO-YYYYMMDD-NNNN` 编码一并取消。

---

## 2. 目标流程（改后，两段式）

```
【申报】名称/规格/单位/数量 自由填写（可模糊，允许不标准）
        └─ catalog_id 恒为 NULL；不检索、不关联、不报"同名多条"冲突
        └─ 检索框保留为可选辅助：点了才关联，不点不拦

【验收】必须先完善物资信息，二选一，同一事务内完成
        ├─ 匹配：按名称关键字搜（库存优先排序）→ 选中已有档 → 写 catalog_id
        └─ 新建：填名称/规格/单位/分类 → createCatalog(reuse=true)
                 → 命中同名同规格同单位则复用，否则建新档（编码自动 MAT-xxx）
        → 写完 catalog_id 才允许入库，随后写 manufacturer + note

【入库】movement 记 catalog_id / manufacturer / note
【库存明细】按 catalog+仓库+区域+批次+效期+厂家 聚合，出 7 列
【主数据】确认验收时新建的档 / 疑似重复 / 合并
```

与现状的差异只有三处：**申报不再自动匹配、验收可就地建档（权限随验收权而非主档维护权）、厂家人工与两个备注字段**。

验收环节的判定顺序（必须在 `materials.js:803` 那道硬校验**之前**执行，否则旧提示会先拦住）：

| `input` 携带 | 处理 |
| --- | --- |
| `catalogId` | 校验档存在且 `merged_into IS NULL`，直接关联 |
| `newCatalog: {name,spec,unit,categoryId?}` | `category_id` 缺省继承申报行的 `line.category_id`（该字段申报时必填，见 `materials.js:393-396`）；调 `createCatalog(..., reuse=true)` |
| 都没有 | 仍 `conflict`，但文案改为"验收前请选择已有物资信息，或填写新物资信息" |

关联动作要落审计（复用现有 `LINK_CATALOG` 事件类型，`materials.js:1375`），并 `bump(order.id, line.id)`；**不要求填原因**——这是验收流程的必经步骤，与管理员事后改档的性质不同。

### 2.1 改动落点（六个文件位置，均为局部修改）

| # | 位置 | 改动 |
| --- | --- | --- |
| B1 | `materials.js:379-392` `lineInput` | 删掉"按编码/名称自动匹配"与两条 `conflict`；只接受显式 `input.catalogId`（传了就校验存在），否则 `catalog_id=NULL`，`name/spec/unit` 保留用户原文 |
| B2 | `materials.js:803` 之前 | 插入 `if (!line.catalog_id) line = await attachCatalogOnReceipt(line, input, user)`；新建路径调 `createCatalog({...,origin:'receipt'}, user, true)` |
| B3 | `materials.js:142` `createCatalog` | 增加 `origin` 形参（默认 `manual`），随 INSERT 写入；`reuse` 分支行为不动 |
| B4 | `materials.js:796` `receiptAction` | 权限不变（仍是 `materials.acceptance.write`），因此**建档不需要额外授权**；`POST /requests/:id/items/:itemId/catalog`（`:1360`）保留但不再是主路径 |
| F1 | `material.js:69` | 删掉"请进入原单，由物资管理员…"的抛错 |
| F2 | `material.js:256` | `receive`／`close` 的可用条件去掉 `&& item?.catalogId` |
| F3 | `material.js:76` receive 表单 | 插入"物资信息"区块：名称预填 `item.name` → 检索（`GET /catalog?q=`，库存优先）→ 命中即写 `catalogId`；未命中则展开规格/单位/分类（预填 `item.spec/unit/categoryId`）→ 提交时走 `newCatalog` |
| F4 | 申报表单 | 检索框改为可选辅助；未匹配不再红字警告，只在中性位置显示"验收时再完善物资信息" |


---

## 3. 数据模型改动（本项目第一次真迁移）

| 表 | 改动 | 说明与兼容 |
| --- | --- | --- |
| `material_catalog` | `+remark TEXT NOT NULL DEFAULT ''` | D2 的"物资档案备注" |
| | `+origin TEXT NOT NULL DEFAULT 'manual'` | `manual`（管理页建档）／`receipt`（验收时就地建档），主数据页的"待确认"队列靠它筛 |
| | `+merged_into BIGINT REFERENCES material_catalog(id)` | 合并后指向保留项，不物理删除 |
| `material_request_items` | `+manufacturer TEXT NOT NULL DEFAULT ''` | 申报时可填可不填；`catalog_id` **保持可空**（现在就是 `BIGINT` 无约束，无需迁移），名称/规格/单位继续用本表自由文本 |
| `material_receipts` | `+manufacturer TEXT NOT NULL DEFAULT ''` | 本批实际到货厂家 |
| | `+note TEXT NOT NULL DEFAULT ''` | D2 的"批次备注" |
| `material_stock_movements` | `+manufacturer TEXT NOT NULL DEFAULT ''` | 库存按厂家拆行的依据 |
| | `+note TEXT NOT NULL DEFAULT ''` | 从验收带下来，调整时也可写 |
| 索引 | `material_catalog(name,spec,unit)`；`material_stock_movements(catalog_id,warehouse,region_id,manufacturer)` | 查重与拆行都需要 |

**取消项**：原设计的 `material_state.catalog_sequence` 与 `AUTO-YYYYMMDD-NNNN` 编码不再需要——验收建档复用 `createCatalog` 已有的 `MAT-<hex>` 自动编码（`materials.js:156`），迁移少一列。

`createCatalog` 需增加一个 `origin` 入参（默认 `'manual'`，验收路径传 `'receipt'`），仅多一个 INSERT 字段，不改其它行为。

**注意：不改写历史 `snapshot` JSON。** 老流水没有 manufacturer，列表显示为空；不做回填猜测。

`material_stock_units`（单件码）不加厂家列——它通过 `source_movement_id` 能推导，避免再加一条迁移面。

---

## 4. 库存明细七列落地

聚合键：`catalog_id + warehouse + region_id + batch + expiry_date + manufacturer`（比现在多一个 manufacturer）。

| 列 | 来源 | 现状 | 改动 |
| --- | --- | --- | --- |
| 入库时间 | 该组 `MIN(created_at)` | 只返回 `last_movement_at`（`materials.js:754`） | 增加 `first_movement_at` |
| 物资名称 | 流水 `snapshot.name` | 已有 | 无 |
| 数量 | `SUM(qty_m)/1000` | 已有 | 无 |
| 规格 | `snapshot.spec` | 已有 | 无 |
| 单位 | `snapshot.unit` | 已有 | 无 |
| 厂家 | `movement.manufacturer` | **无** | 新增 |
| 备注 | 该组最后一条非空 `movement.note` | 现只有 `reason`（调整原因，语义不同） | 新增 |

物资档案备注（`catalog.remark`）不在明细行里显示，放在明细的展开/悬浮信息里，避免每行重复。

---

## 5. 主数据页（从"维护"变"审核"）

| 区块 | 内容 |
| --- | --- |
| 待确认 | `origin='receipt'` 且 `merged_into IS NULL` 的档，管理员核对后可转正式档或合并 |
| 疑似重复 | 同 `名称+规格+单位` 但多编码，或多厂家 |
| 合并 | 选 N 条 → 保留 1 条 → `material_stock_movements`／`material_barcodes`／`material_request_items`／`material_receipts` 的 `catalog_id` 批量改指向保留项；被合并项写 `merged_into`、`origin` 不变、不删除 |
| 编码 | 验收建档默认 `MAT-<hex>`；管理员可改成正式编码，但需唯一且留审计 |

合并必须在一个事务内完成，并校验合并前后库存总量不变（`SUM(qty_m)` 按 catalog 汇总相等），不相等就整体回滚。

**关于合并工具的排期（建议降级，由你定）**：原定"本版就做"的前提是申报阶段自动建档、重复必然高发。改成验收阶段建档后，建档频率降到"每次首次到货一次"，重复来源只剩"两人同时对同一新物资验收"。因此建议合并工具从本版移到下一版，本版只做**待确认队列 + 疑似重复提示**，先观察一个月的实际重复率再决定。若你坚持本版做，按上表实现，不改设计。

### 5.1 权限矩阵（本版调整）

| 动作 | 现在 | 改后 | 理由 |
| --- | --- | --- | --- |
| 申报明细关联主档 | 发生即自动 | 不自动；显式传 `catalogId` 才关联 | D3 |
| 验收时选择已有主档 | 不允许（前端禁用验收按钮） | `materials.acceptance.write` | 验收人的本职动作 |
| 验收时新建主档 | `materials.catalog.write`（MANAGER，且只能走原单"修订"） | `materials.acceptance.write` | 已在验收事务内，无需二次审批 |
| 主数据页维护（改编码/改分类/合并/导入） | `materials.catalog.write` | 不变 | 敏感操作仍需管理员 |
| 原单"修订"补挂主档 | `materials.catalog.write` | 保留 | 管理员纠错通道，不是主路径 |

---

## 6. 迁移与版本

- 这次是"加列 + 回填 + 加索引 + 加配置行"，`CREATE TABLE IF NOT EXISTS` 那套撑不住。**迁移基建（`docs/OPTIMIZATION_PLAN.md` 的 C8）从"建议"升级为"本版必须做"**。
- 回滚策略：迁移只做加法（加列/加索引/加配置），旧代码在新库上仍可运行；不删列、不改类型。
- 版本切分（D3 改后重新排）：

| 版本 | 范围 | 可独立回滚性 |
| --- | --- | --- |
| `0.10.0` | 迁移基建 + 加列 + 申报解耦（`lineInput` 去自动匹配）+ 验收就地匹配/建档 + 权限改 `acceptance.write` | 高：全是加列与放宽校验，前端旧版不受影响 |
| `0.10.1` | 库存明细 7 列 + 厂家/备注全链路写入（申报、验收、流水） | 中：依赖 `0.10.0` 的列 |
| `0.10.2` | 主数据页待确认队列 + 疑似重复（合并工具按第 5 节正文的建议再定） | 低依赖，可延后 |

`0.10.0` 不与前端信息架构重排混发，出问题好回滚。

---

## 7. 风险

| 风险 | 缓解 |
| --- | --- |
| **申报取消自动匹配后名称发散**（"无水乙醇"／"乙醇 无水"／"分析纯乙醇"），验收时匹配不上只能一路新建 | 这是本方案最大的代价，必须配三件事：① 申报表单名称做 NFKC+去空格规范化，并对同名近似给出"是否指 XXX"提示；② 验收建档时先跑 `createCatalog(reuse=true)`，同名同规格同单位自动复用；③ 主数据页"疑似重复"按名称相似度分组，管理员可合并 |
| 验收时就地建档产生同物多档 | `reuse=true` 优先复用；`origin='receipt'` 进待确认队列；合并工具兜底 |
| 申报时填的规格/单位与验收建档时填的不一致 | 验收表单预填申报行的名称/规格/单位，只允许在"确认"时改，改动落审计 |
| 验收人为了省事乱建档 | 待确认队列 + 主数据页可见建档人与建档时间；不改硬拦（会破坏易用性目标） |
| 厂家自由文本不统一（Sigma／sigma／西格玛） | 本版做输入规范化（去空格、NFKC）+ 历史厂家下拉建议；字典化留到后续 |
| 库存拆行后总数对不上 | 拆行只改展示维度，`SUM` 仍按 catalog 汇总；页头同时显示"该物资合计" |
| 历史数据无厂家 | 显示 `—`，不猜测回填 |

---

## 8. 需你拍板的三点

1. **申报界面的"检索物资信息"框保留还是删掉？** 我建议**保留但改为纯可选辅助**（点了才关联，不点不拦、不提示未匹配），这样老物资申报仍能一次带出编码和分类，新人不知道叫什么也能直接手填。如果你要"彻底不出现"，我删掉检索入口。
2. **申报明细的名称/规格/单位要不要做规范化（去空格、全半角统一、同义词提示）？** 不做的话，验收阶段匹配命中率会低，重复档会变多。做了会稍微改变现有数据的字面值（只在新建/编辑时规范化，不回改历史）。
3. **拒收与差缺结案是否也要求先完善物资信息？** 现状是验收/拒收/结案三者共用一道校验（`materials.js:803`）。纯拒收不产生库存、结案也不产生库存，技术上不需要主档。我默认**保持三者一致**（改动最小、不动现有测试），若你希望"只有合格入库才要求建档"，我按 `kind==='acceptance'` 放宽——一句"放宽"即可，不用额外解释。

---

## 9. 边界

未改代码、未改表、未跑测试、未连接数据库。本文档是设计确认稿，不是实现。上面所有行号基于 `0.9.4`（`28ce719`）。
