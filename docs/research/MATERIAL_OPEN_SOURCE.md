# 物资管理开源项目对照

核查日期：2026-10-17。对照基线为 LabOS 0.3.1 的[物资 API](../MATERIAL_API.md)及已确认需求。依据官方仓库、文档、许可证和部分源码联网核验；未安装候选系统，未进行业务、群晖或并发验收。

## 结论

本轮核查 ERPNext、InvenTree、OpenBoxes、jshERP、Odoo Community + OCA、Dolibarr、Part-DB 七组候选。**有成熟的采购/库存基础，但没有确认任何一个能开箱原样覆盖目前全部规则。** “支持采购审批”“有变更日志”或“支持库存”不能直接证明支持本项目的共同填报、受控修订和验收记账协议。

如果要换成完整 ERP 再二次开发，优先评估 ERPNext；如果继续完善现有 LabOS，优先参考 InvenTree 的收货/库存、OpenBoxes 的分批验收、jshERP 的中文请购交互。整体替换仍需开发、迁移和业务验证，并不能直接消除现有流程的定制需求。

“已有”仅表示取得官方文档或源码证据；“配置”表示有相应配置机制；“需定制”按完整匹配 LabOS 规则判断；“未核实”不表示不存在第三方插件。

## 候选对照

| 项目与核查许可 | 已有且值得参考的能力 | 当前需求的主要差距 | 部署与定位 |
| --- | --- | --- | --- |
| [ERPNext](https://github.com/frappe/erpnext)，GPL-3.0；Frappe 框架为 MIT | 物资申请→采购单→多次收货，接受/拒收数量，分类、期初、库存凭证、基础 XLSX、可配置角色与工作流 | 标准申请必须已有 Item 主档；同单全员追加且只改本人行、提交后必填原因和完整原版快照需开发；区域数量维度可配置，区域独立估值不原生维护 | 有[官方 Docker](https://github.com/frappe/frappe_docker)，需数据库、Redis、队列等多个服务；适合完整 ERP 二开候选 |
| [InvenTree](https://github.com/inventree/InvenTree)，MIT | 分类、层级库存位置、采购订单、分批收货、批次、库存追踪/合并、XLSX、权限 | 正常采购行必须有 SupplierPart；收货价格继承采购行单价；没有证实本项目的协同申请、先报后匹配、原版修订、本批总金额协议 | 有[官方 Compose](https://docs.inventree.org/en/stable/start/docker/)；推荐作为现有项目的库存参考 |
| [OpenBoxes](https://github.com/openboxes/openboxes)，EPL-1.0 | 医疗物资采购、审批人下单、分批收货、剩余量/取消剩余、收货回滚、批次效期、库存调整 | 采购流程依赖产品主档；不能证明同单按作者协作、完整原版受控修订、验收总金额及区域金额汇总与本项目等价；导出模板有依据，真正 XLSX 格式未核实 | 有[官方 Docker/Compose](https://github.com/openboxes/openboxes/tree/develop/docker)，应用/数据库/代理；适合验收流程参考 |
| [jshERP](https://github.com/jishenghua/jshERP)，当前 master 为 Apache-2.0 | 中文请购单、审核/反审核、转采购订单、部分完成、强制结单、采购入库、分类/仓库/期初、Excel、角色权限 | 请购必须已有条码；后端普通编辑仅限未审核，整单保存会删明细重写；共同加行、本人行权限、新物资后匹配、带原因快照修订需开发 | 官方所查仓库树未见 Docker/Compose 交付入口；适合中文界面和请购模型参考 |
| [Odoo Community](https://github.com/odoo/odoo) + [OCA purchase_request](https://github.com/OCA/purchase-workflow/tree/19.0/purchase_request)，所查核心与该模块为 LGPL-3 | 核心采购/库存、分类/库位、库存调整、XLSX；OCA 增加内部采购申请及转询价单 | 标准采购单不等于多人申报；OCA 行的 product_id 字段可空，但未验证完整先申报后匹配流程；MATERIAL 修订、完整原版、区域金额及验收事件语义需定制 | 有[官方核心 Docker](https://github.com/odoo/docker)，需 PostgreSQL；扩展必须匹配 Odoo 主版本，不包含企业版全部能力 |
| [Dolibarr](https://github.com/Dolibarr/dolibarr)，GPL-3.0-or-later | 商品/仓库、供应商采购、部分收货、库存数量成本和流水、细权限、XLSX、中文语言文件 | 供应商订单不等于全员协作申请；自由描述行不证明具备主档受控匹配；原版修订、区域维度、拒收/结案/唯一整笔冲正需定制 | [官方 Docker](https://github.com/Dolibarr/dolibarr-docker)明确支持 amd64/arm64；可以评估，但对当前专用流程没有明显免开发优势 |
| [Part-DB](https://github.com/Part-DB/Part-DB-server)，AGPL-3.0-or-later | 零件主档、分类、多位置批次、细权限、事件日志/原因、XLSX | 已核实的订货信息属于已有零件，未核实完整采购申请和关联分批验收；数量金额账、申报协作和修订协议需开发 | 有[官方 Docker](https://docs.part-db.de/installation/installation_docker.html)，可用 SQLite；更适合电子零件库，当前不优先整体替换 |

## 要完整覆盖，必须单独解决的规则

1. **同单协作与行归属。** 全员可追加明细，普通用户只改自己的草稿行，并发追加不丢行；仅有整单读写权限和审批人字段不够。ERPNext 默认整单时间戳冲突检查不会自动合并同时追加，jshERP 的整单重写也不能直接替代现有追加接口。
2. **未建档新物资先提交。** ERPNext 的 Material Request Item 要求 `item_code`，InvenTree 正常采购行要求 `SupplierPart`，jshERP 要求已有条码。OCA 的申请行字段可空是一个可参考的模型，但完整提交/匹配/权限链尚未运行验证，不能写成已满足。
3. **原版与受控修订。** 当前要求原提交完整快照永久保留、MATERIAL 每次修订说明原因、已有验收后保护身份/仓库/区域。ERPNext Track changes 的字段差异、Odoo chatter、反审核再编辑、Part Revision 或普通操作日志均不自动等价。
4. **分批验收的数量和金额口径。** 本项目直接录入本批合格数量与含税总金额。ERPNext 收货金额由数量和单价计算，InvenTree 收货使用订单行单价；是否保持本批实际金额及整数记账，需单独适配。
5. **拒收、结案和冲正语义。** 拒收不进合格库存、差缺结案不冒充收货、整笔数量金额精确反向且最多一次；候选的退货、拒收仓、取消订单、库存调整或回滚不能不加区分地当作现成实现。
6. **期初与区域库存。** 库位表示物理位置，不天然等于独立的“归属区域”。需明确主档+仓库+区域的数量及金额汇总、批次保留、期初关闭规则。ERPNext 官方特别说明不维护维度独立估值，不能由“支持自定义库存维度”推断区域金额账已满足。
7. **历史 Excel 与保护。** 基础 XLSX 导出不等于同时包含原提交、当前明细、修订和验收历史的专用工作簿，也不证明金额裁剪、附件权限和完整恢复覆盖当前要求。

## 具体参考入口与依据

### ERPNext：采购凭证与库存流水

- [Material Request 官方流程](https://docs.frappe.io/erpnext/material-request)、[主档必填字段](https://github.com/frappe/erpnext/blob/v16.51.1/erpnext/stock/doctype/material_request_item/material_request_item.json#L75)。
- [Purchase Receipt](https://docs.frappe.io/erpnext/purchase-receipt)、[采购单](https://docs.frappe.io/erpnext/purchase-order)、[不可变库存账本](https://docs.frappe.io/erpnext/immutable-ledger-in-erpnext)。拒收仓、退货/取消及反向流水有原生基础，但与本项目事件语义不同。
- [Stock Reconciliation](https://docs.frappe.io/erpnext/stock-reconciliation)、[Inventory Dimension](https://docs.frappe.io/erpnext/inventory_dimension)。后者明确维度估值限制。
- [角色权限](https://docs.frappe.io/erpnext/role-based-permissions)、[文档版本](https://docs.frappe.io/erpnext/document-versioning)、[Version 差异源码](https://github.com/frappe/frappe/blob/v16.52.0/frappe/core/doctype/version/version.py)。

### InvenTree：收货与合并前校验

- [采购单与分次收货](https://docs.inventree.org/en/stable/purchasing/purchase_order/)、[固定版本收货序列化器](https://github.com/inventree/InvenTree/blob/1.5.7/src/backend/InvenTree/order/serializers.py#L782)。正常行拒绝空供应商物料；额外费用行不是可验收入库的新物资。
- [order/models.py](https://github.com/inventree/InvenTree/blob/1.5.7/src/backend/InvenTree/order/models.py)、[库存调整/合并](https://docs.inventree.org/en/stable/stock/adjust/)、[stock/models.py](https://github.com/inventree/InvenTree/blob/1.5.7/src/backend/InvenTree/stock/models.py#L2614)。重点看 `receive_line_items`、`can_merge`、`merge_stock_items`、事务/行锁/价格及追踪保留。
- [库存追踪](https://docs.inventree.org/en/stable/stock/tracking/)、[XLSX 导出](https://docs.inventree.org/en/stable/concepts/data_export/)。默认合并还考虑状态、供应商、序列化等条件，不宜直接替换 LabOS 的合并键。

### OpenBoxes：部分验收及剩余量交互

- [采购建单和审批人提交](https://help.openboxes.com/article/42-create-a-purchase-order)。商品、数量、单位和成本字段有官方说明。
- [Partial Receiving](https://help.openboxes.com/article/300-partial-receiving)：展示本次收货、剩余量、取消剩余、部分收货和完成状态，值得直接对照当前验收页面。
- [收货及 Rollback Partial Receipts API](https://docs.openboxes.com/en/develop/api-guide/inbound/receiving/)、[库存盘点/调整](https://help.openboxes.com/article/41-inventory-adjustments-and-stock-counts)。这些证据不构成本批含税总额和一次冲正语义的运行验证。

### jshERP：中文请购、部分完成与期初

- [PurchaseApplyList.vue](https://github.com/jishenghua/jshERP/blob/master/jshERP-web/src/views/bill/PurchaseApplyList.vue)、[PurchaseApplyModal.vue](https://github.com/jishenghua/jshERP/blob/master/jshERP-web/src/views/bill/modules/PurchaseApplyModal.vue)：确有请购、审核/反审核、部分采购、转采购订单、结单与导出；不能简单说它只有采购订单。
- [DepotItemService.java](https://github.com/jishenghua/jshERP/blob/master/jshERP-boot/src/main/java/com/jsh/erp/service/DepotItemService.java)：按条码查已有主档、整单明细保存及库存计算。
- [DepotHeadService.java](https://github.com/jishenghua/jshERP/blob/master/jshERP-boot/src/main/java/com/jsh/erp/service/DepotHeadService.java)、[MaterialService.java](https://github.com/jishenghua/jshERP/blob/master/jshERP-boot/src/main/java/com/jsh/erp/service/MaterialService.java)：审核状态限制、Excel 与期初基础。

### Odoo Community + OCA：申请与采购分层

- [OCA purchase_request 使用说明](https://github.com/OCA/purchase-workflow/blob/19.0/purchase_request/README.rst)、[申请行模型](https://github.com/OCA/purchase-workflow/blob/19.0/purchase_request/models/purchase_request_line.py)、[模块许可证与依赖](https://github.com/OCA/purchase-workflow/blob/19.0/purchase_request/__manifest__.py)。申请审批后转询价单，值得参考单据关联和需求合并。
- [核心采购锁单/审批源码](https://github.com/odoo/odoo/blob/20.0/addons/purchase/models/purchase_order.py)、[XLSX 导出说明](https://www.odoo.com/documentation/20.0/applications/essentials/export_import_data.html)、[Community/Enterprise 对照](https://www.odoo.com/page/editions)。官网统一文档包含企业版能力，不能全部算入社区版。
- 本次实际查到核心默认分支为 **20.0**，OCA 仓库默认 **19.0**，上述 `purchase_request` 核查为 19.0。它们不是一套已验证的混版本安装方案；应选同一主版本再验证。OCA 仓库总许可不能替代具体模块 manifest 的许可。

### 另外两项的参考边界

- Dolibarr：[收货模型](https://github.com/Dolibarr/dolibarr/blob/develop/htdocs/reception/class/reception.class.php)、[XLSX 驱动](https://github.com/Dolibarr/dolibarr/blob/develop/htdocs/core/modules/export/export_excel2007.modules.php)。普通库存反向操作不证明具备 LabOS 原事件保护；[BlockedLog](https://github.com/Dolibarr/dolibarr/blob/develop/htdocs/blockedlog/README.md) 明确聚焦发票/付款/打印，不能扩大为物资全流程不可变审计。
- Part-DB：[订货字段](https://github.com/Part-DB/Part-DB-server/blob/v2.20.1/src/Entity/Parts/PartTraits/OrderTrait.php)、[库存变更日志](https://github.com/Part-DB/Part-DB-server/blob/v2.20.1/src/Entity/LogSystem/PartStockChangedLogEntry.php)、[变更原因](https://github.com/Part-DB/Part-DB-server/blob/v2.20.1/src/Services/LogSystem/EventCommentNeededHelper.php)、[Excel 写出](https://github.com/Part-DB/Part-DB-server/blob/v2.20.1/src/Services/ImportExportSystem/EntityExporter.php#L144)。适合参考主档与日志，不作为完整采购验收替代品。

## 维护、许可与部署边界

- 核查时七组候选仓库均未归档。ERPNext 正式 Release 为 [v16.51.1](https://github.com/frappe/erpnext/releases/tag/v16.51.1)（2026-10-15），InvenTree [1.5.7](https://github.com/inventree/InvenTree/releases/tag/1.5.7)（2026-10-10），Part-DB [v2.20.1](https://github.com/Part-DB/Part-DB-server/releases/tag/v2.20.1)（2026-10-12），Dolibarr [24.0.1](https://github.com/Dolibarr/dolibarr/releases/tag/24.0.1)（2026-09-07）。这些是查询时的 API 结果，不保证未来仍为最新版。
- jshERP 当前源码为 3.6-SNAPSHOT，最近推送 2026-10-15，但 GitHub 最新正式 Release 仍为 [v3.5](https://github.com/jishenghua/jshERP/releases/tag/v3.5)（2024-11-11）。本文请购源码等证据取自 master，不能保证旧发行包逐项具备。OpenBoxes 的部分证据取自 develop，Dolibarr 部分源码也为 develop，同样不当作固定发行包验收。
- ERPNext 16.51.1 要求 Frappe `>=16.50,<17`；Frappe 同时维护多条版本线，不能只按两个仓库的 latest API 返回值配套。许可证以实际使用版本及模块为准；本轮没有复制任何候选业务源码进入 LabOS。
- 官方 Docker 文件说明存在容器交付方式，不证明群晖具体架构、DSM、目录权限或 10–30 人性能已满足。ERPNext 的演示 `pwd.yml` 也不能作为生产部署方案。未部署候选、未访问真实业务数据、未修改现有服务或运行库。

## 后续采用前的最小验证场景

选定一个候选后，用隔离环境验证：两名普通用户在同一申请加行和本人行权限 → 未建档物资先提交 → 提交后的原因修订/原版导出 → 分两次录入不同数量与本批金额 → 拒收、差缺结案、重复冲正拦截 → 不同区域库存及金额隔离 → 期初关闭 → 历史 Excel、备份恢复与容器重建。验证通过后再决定迁移或仅参考模块设计。

本次交付为选型记录，业务版本保持 0.3.1；没有新镜像、YML 变更、数据库迁移或系统替换。

## 后续采纳：0.3.2 位置与领用开发（2026-10-17）

以上是调研阶段的历史结论。用户随后要求参考这些项目的逻辑完善 LabOS，并新增存放位置和物资领用，确认采用“人员申请，物资管理员发放”。本轮保留现有 Node.js/SQLite 结构独立实现，未复制候选业务源码，也未引入上游服务或依赖。

| 参考依据 | 在 LabOS 的应用 | 保留本项目规则的区别 |
| --- | --- | --- |
| InvenTree 1.5.7 的 [`can_merge` / `merge_stock_items`](https://github.com/inventree/InvenTree/blob/1.5.7/src/backend/InvenTree/stock/models.py#L2614)、[`add_tracking_entry`](https://github.com/inventree/InvenTree/blob/1.5.7/src/backend/InvenTree/stock/models.py#L2338) | 库存详情增加批次余额，并能钻取该批号、有效期的来源流水；存放位置按实际批次维护 | 不物理删除被合并库存，不照搬供应商/状态合并规则；继续按物资+仓库+区域汇总，批号+有效期独立核对 |
| InvenTree 1.5.7 的 [`take_stock`](https://github.com/inventree/InvenTree/blob/1.5.7/src/backend/InvenTree/stock/models.py#L3380) | 发放时在事务内重新读取当前余额、扣减并记录操作者及来源 | 上游会将移除量限制到现存量；LabOS 对不足的领用整笔拒绝，不静默少发。申请不预占，发放全量处理；金额用整数比例分摊并在领完时清零 |
| OpenBoxes [Partial Receiving](https://help.openboxes.com/article/300-partial-receiving) 的本次/累计/剩余、批号与有效期展示 | 验收保留实际合格量与拒收量；库存和领用明确显示批次余量、位置、业务日期和原因 | 不把取消剩余当作合格收货，不扩大为新的采购模块；该来源是已核验文档，不冒称已验证固定版 Groovy 服务 |
| jshERP [请购界面](https://github.com/jishenghua/jshERP/blob/master/jshERP-web/src/views/bill/PurchaseApplyList.vue) 与审核后动作约束 | 领用状态与申请/发放/驳回/取消入口对应，服务端再次校验角色、状态和版本；申报补充提交资格提示 | 不采用反审核覆盖原单或整单删明细重写；原提交及原因修订继续保留 |
| ERPNext [不可变库存账本](https://docs.frappe.io/erpnext/immutable-ledger-in-erpnext) 与显式库存维度 | 领用产生独立负向来源流水，库存仍由完整流水汇总；备份及 Excel 包含新增业务 | 不接入 Frappe，不改变本批含税总金额和区域独立汇总，也不把版本差异日志当完整原版快照 |

首期为单物资、单批次申请，一个库存批次维护一个文字位置；部分发放、预占、多货架分摊及领用单冲正未纳入本轮。已发放记录不直接修改或删除，录错通过有原因的库存调整留痕纠正。实际实现合同见[物资 API](../MATERIAL_API.md)，验证结果见[版本说明](../CHANGELOG.md)“未发布”。本轮不创建镜像标签，现行 0.3.1 部署不会因此自动升级。

## 0.11.1 后续核查：资料编辑、删单和编码（2026-10-23）

用户反馈导入物资无法编辑、建立的表单无法删除、物资编码缺少统一或自定义规范，要求查询开源处理方式。本节基于本地 `b8d9214`（0.11.1 发布后文档补记）的静态代码和官方文档／固定版本源码；未部署候选系统或复现现场。本节补充前文的历史选型记录，**以下改法是建议，尚未实现**，不代表新版本或镜像已发布。

### 当前项目的实际缺口

| 反馈 | 当前代码事实 | 影响与依据 |
| --- | --- | --- |
| 导入资料不能编辑 | 普通物资库没有名称、规格、单位、分类、备注的通用编辑 API 或按钮；现有维护操作只有包装码与管理方式。不限于 Excel 来源 | [物资库路由](../../src/materials.js#L1443)、[页面入口](../../src/public/material.js#L98)。管理方式仍有独立权限、原因、版本及引用检查 |
| 修改 Excel 后回导不能覆盖 | 现有导入是新增／复用：同名、规格、单位匹配后，分类、管理方式或备注冲突会拒绝；改变身份字段可能成为另一条物资 | [导入校验](../../src/materials.js#L1401)。六列模板是新增／回导合同，不是批量更新接口，不能静默改成覆盖 |
| 表单无法删除 | 申报、期初／补录仅有草稿明细删除，没有整单删除；期初关闭还会阻止旧期初草稿的明细清理 | [申报行删除](../../src/materials.js#L1519)、[期初行删除](../../src/materials.js#L1249)、[期初写入条件](../../src/materials.js#L668) |
| 已处理单据难以撤回 | 已提交申报可修订、逐项结案，但没有整单作废；验收已有合格入库整笔冲正；领用待发放可由申请人取消或管理员驳回，已发放没有退库 | [验收冲正](../../src/materials.js#L933)、[领用状态处理](../../src/materials.js#L794)。不能笼统说所有单据都没有取消能力 |
| 物资编码不直观 | `createCatalog` 自动生成 `MAT-`＋16 位随机十六进制；手工、导入、验收建档共用此函数。单件码已有独立模板与流水，申报／期初／补录单号另用日期＋随机串 | [物资码](../../src/materials.js#L154)、[单件规则](../../src/materials.js#L215)、[单件生成](../../src/materials.js#L577)、[申报号](../../src/materials.js#L1458)、[期初号](../../src/materials.js#L1160)。目前没有统一配置入口 |

### 开源项目如何处理

以下固定分支／提交用于复查，不宣称它们是各项目当前最新正式版，也不把框架原生能力等同于 LabOS 已实现。

| 官方实现 | 已核实做法 | 适合本项目借鉴的部分 |
| --- | --- | --- |
| InvenTree，提交 `d11b74fd857a6ebf47658b707605a64a10be764f` | `PartDetail` 有正常更新入口；内部物资号 `IPN` 与库存件 `serial` 分离，支持 IPN 正则校验 | 导入后仍维护同一个物资实体；“一种物资的编号”与“每瓶编号”分开，规范在服务端校验。见[物资 API](https://github.com/inventree/InvenTree/blob/d11b74fd857a6ebf47658b707605a64a10be764f/src/backend/InvenTree/part/api.py)、[Part 模型](https://github.com/inventree/InvenTree/blob/d11b74fd857a6ebf47658b707605a64a10be764f/src/backend/InvenTree/part/models.py)、[StockItem 模型](https://github.com/inventree/InvenTree/blob/d11b74fd857a6ebf47658b707605a64a10be764f/src/backend/InvenTree/stock/models.py) |
| Snipe-IT，提交 `e6c9fee06eb6c46a58cbbefe6f1e275594a0d85a` | 导入按 ID／资产标签查找，开启更新模式才更新；有资产引用的型号会被后端拒绝删除。资产采用软删除，型号关系可解析软删记录 | 将“新增”和“更新”显式区分；删除前查引用，保留历史关系。见[导入器](https://github.com/grokability/snipe-it/blob/e6c9fee06eb6c46a58cbbefe6f1e275594a0d85a/app/Importer/AssetImporter.php)、[型号删除检查](https://github.com/grokability/snipe-it/blob/e6c9fee06eb6c46a58cbbefe6f1e275594a0d85a/app/Http/Controllers/Api/AssetModelsController.php)、[资产模型](https://github.com/grokability/snipe-it/blob/e6c9fee06eb6c46a58cbbefe6f1e275594a0d85a/app/Models/Asset.php) |
| ERPNext／Frappe，ERPNext `v16.51.1`、Frappe `v16.52.0` | 导入明确选择新增或更新，更新模板保留 ID；Item 在已有库存流水时限制改变库存单位。删除校验拒绝直接删除已提交或仍被引用的记录；取消库存凭证保留反向流水 | 普通资料维护与影响数量解释的变更分开；草稿删除与记账后纠错分开。见[Data Import](https://docs.frappe.io/erpnext/data-import)、[Item 源码](https://github.com/frappe/erpnext/blob/v16.51.1/erpnext/stock/doctype/item/item.py)、[删除校验](https://github.com/frappe/frappe/blob/v16.52.0/frappe/model/delete_doc.py)、[不可变库存账本](https://docs.frappe.io/erpnext/immutable-ledger-in-erpnext) |
| ERPNext 编号设置、Odoo `18.0` 的 `ir.sequence` | 支持编号系列；Odoo 模型提供前后缀、补零、日期区间及数据库序列等机制 | 统一规则入口、按对象保留独立序列，避免各创建入口各自拼随机串。见[Document Naming Settings](https://docs.frappe.io/erpnext/document-naming-settings)、[Odoo 序列模型](https://github.com/odoo/odoo/blob/18.0/odoo/addons/base/models/ir_sequence.py) |

不能照搬上游所有删除行为：InvenTree 的库存追踪关联中，删除库存件与删除 Part 的保留策略不同；Snipe-IT 的资产标签校验也不证明历史标签永不复用。此处借鉴生命周期和引用检查，不复制级联删除或未经核验的并发编号实现。未复制候选源码，未新增依赖。

### 建议的最小完整改动

1. **物资信息可维护。** 新增“编辑”和“停用”入口，沿用物资维护权限、版本冲突检查、原因与审计。未引用记录可更正名称、规格、单位等身份资料；已有业务时可维护描述，并允许受控的名称／规格纠错，但必须保留稳定 ID 和编码、检查重复身份、保留原单快照。会改变数量含义的单位换算或管理方式不能通过普通改字完成。停用后不供新申报选择，但既有库存仍能查询、领用和追溯；确无任何引用的误建物资才可删除。
2. **区分草稿删除和已记账纠错。** 申报、期初／补录增加整单草稿删除；建议普通创建者仅删除无他人协作的本人草稿，有他人明细的共享申报由物资管理员处理。服务端确认版本及无业务流水，处理行与附件关联，已关闭期初的未入库草稿也应能清理。已提交但无验收的申报可另设有原因的作废；已有入库／发放则使用冲正／退库，保留原单和关联流水，不做通用级联删除。取消／冲正不可用时明确指出关联单据、已领用件等阻止原因。
3. **统一编号设置，保留三类身份。** 物资档案码、每瓶／每件码、业务单号分别配置。例如物资 `MAT-000001`、单件 `LAB-20261023-000001`、申报 `SQ-20261023-0001`。先补物资的前缀＋补零＋流水，再按实际需要扩展日期／重置规则；配置预览示例，所有新建路径共用服务端分配及唯一校验。已生成编码和已打印标签保持，不自动批量重编；旧包装码仍只绑定物资。编号不依赖易变名称或区域。

编号并发使用 PostgreSQL 序列或事务保护的计数器，结合唯一约束和现有幂等协议，不能使用无锁 `MAX+1`。如果采用 PostgreSQL `nextval`，允许失败事务造成空号，不承诺连续无断号；依据 [PostgreSQL 18 序列文档](https://www.postgresql.org/docs/18/functions-sequence.html)。规则切换、已有显式编码、备份恢复和计数器重置仍须防止复用旧号，不能只依赖 `nextval` 本身。

页面编辑应优先完成。批量更新 Excel 如后续需要，另做明确的“按稳定编码更新”模式、差异预览与逐行冲突报告，导出携带只读识别列；不要要求人工填写内部编码，也不要改变现有六列新增模板的语义。库存回导仍是新增入库草稿，不得被当作修改库存余额。

### 实施必须覆盖的关联与验证

- **当前资料与历史快照。** [库存汇总](../../src/materials.js#L837)的名称／规格／单位／编码来自第一笔流水快照，[单件标签](../../src/materials.js#L591)取入库来源快照。新增主档编辑时应明确当前库存／搜索／新标签采用当前资料，历史单据及旧标签快照保留；否则编辑后页面会互相矛盾。[二维码解析](../../src/materials.js#L1385)还检查 ID 与编码，旧码必须继续有效。以上是实施要求，不是已经改好的显示策略。
- **数据库与恢复。** 外键未提供可直接使用的整单级联删除；草稿删除需处理附件和既有幂等结果，不删除被其他对象引用的档案。[完整备份恢复](../../src/materials.js#L2044)严格校验列、状态键和单号格式；增加停用字段、作废状态或新编号后必须同步迁移、备份版本、旧备份补默认值、恢复计数器及账本核对。
- **最小回归。** 导入后编辑且数量不变；两人同时修改冲突；修改后当前库存可检索且历史快照不变；旧二维码可识别；协作草稿权限及关闭期初清理；有入库／领用关联时拒绝物理删除；并发手工／导入／验收建档编号不重；切换规则、重启和备份恢复后不复用历史编号。涉及 UI 时继续按施工卡及 `ui-audit --strict` 验证。

本轮仅完成源码核对、官方资料研究与方案记录。未改业务代码、数据库、YML、版本、镜像或目标群晖；未运行上述业务回归。Windows 命令显式使用 `pwsh`，实查为 PowerShell 7.6.8。

## 实验室专项开源参考（2026-10-23，研究未实施）

用户随后要求专门搜索实验室物资管理。此次补充 eLabFTW、Chemotion ELN、Open Enventory 三个实验室项目，对照现有“物资信息／批次／单件、多人申报、验收、申请后管理员发放、Excel、二维码及系统打印”。本节不替代上一节资料编辑、草稿删单和编码的缺口结论；参考点不是已纳入开发的承诺。仅查官方文档、开发者说明及部分源码，没有安装候选系统，也未证明任何一个能直接覆盖 LabOS 全流程。

### 三个项目及可采用之处

| 项目与本次证据范围 | 已核实的实验室能力 | 适合 LabOS 参考的做法 | 不能直接推导的能力 |
| --- | --- | --- | --- |
| **eLabFTW**：官方库存文档；源码固定 `be074c5689ac2bb868e8c6fdbd82083007796cee`，不是正式最新版声明 | 资源定义与多个容器分开，容器保存位置、数量、单位；位置支持父子层级；数量变化记录前后值，位置删除检查子位置和容器引用；库存可导出 CSV | 保留一种物资对应多瓶／件；位置从自由文本逐步改为“房间→柜→层／格”的字典树；区分位置维护权限和物资操作权限 | 一个容器不一定是一瓶；已核二维码指向资源／实验条目，不足以证明每容器独立码、原生效期管理或申请→审批→发放自动扣库 |
| **Chemotion ELN**：官方 ELN v3.x 库存、扫码、历史文档及查询时 `main` 模型；未冻结完整安装版本 | 以物质与样品组织化学品；有供应商、采购状态、效期、开瓶日期、储存温度、质量／体积单位、原属及当前楼宇／房间／柜、借用者；XLS/XLSX 导入、XLSX 导出、SDS PDF、二维码标签和字段版本 | 化学品分类按需显示 CAS、浓度、储存条件、SDS 等字段；区分归属区域与实际位置；保持单位明确，扫码打开具体记录后再执行有权限的操作；编辑界面提供修改前后对照 | 源码 `Container` 是分析数据／附件树容器，不能当实体瓶照搬；样品 Target/Real Amount 不等于库存 Amount。采购字段不证明完整申报审批；标签示例只测试 Brother，不证明 DL-886A 或直接 USB 驱动适配 |
| **Open Enventory**：开发者官网、SourceForge 原项目及其链接的 KV 用户指南和分支变更记录；部分维护操作属于 KV 分支 | 面向化学品库存；支持扫码借出／归还、位置移动；容器资料有剩余量、开瓶日期、位置及自有编码，KV 分支支持导入并修改库存记录 | 借鉴手机“扫码→显示瓶件状态与位置→选择业务→确认”界面；借用、移动、用完分别建事件；中文位置选择与物资资料维护独立 | 借用后归还并不等于耗材领用出库；直接改余量不能替代库存流水；KV 导入编辑能力不能算到所有原版发行包。位置层级应参考 eLabFTW，不声称原版已有完整层级库位 |

### 官方入口与代码定位

- eLabFTW：[库存文档](https://doc.elabftw.net/docs/usage/inventory/)、[容器字段／数量变化](https://github.com/elabftw/elabftw/blob/be074c5689ac2bb868e8c6fdbd82083007796cee/src/Models/Links/AbstractContainersLinks.php)、[层级位置、权限及删除保护](https://github.com/elabftw/elabftw/blob/be074c5689ac2bb868e8c6fdbd82083007796cee/src/Models/StorageUnits.php)、[二维码内容](https://github.com/elabftw/elabftw/blob/be074c5689ac2bb868e8c6fdbd82083007796cee/src/Make/MakeQrSvg.php)。`composer.json` 许可为 [AGPL-3.0-or-later](https://github.com/elabftw/elabftw/blob/be074c5689ac2bb868e8c6fdbd82083007796cee/composer.json)。
- Chemotion：[库存与导入导出](https://chemotion.net/docs/eln/ui/inventory)、[二维码／PDF 标签](https://chemotion.net/docs/eln/ui/barcodes)、[字段历史与受限回退](https://chemotion.net/docs/eln/ui/history)、[物质／样品／数据容器模型](https://github.com/ComPlat/chemotion_ELN/tree/main/app/models)。库存文档明确化学性质自动抓取当前失效，不能把旧演示当可用功能；SDS 搜索和手工附件另有说明。许可见 [LICENSE](https://github.com/ComPlat/chemotion_ELN/blob/main/LICENSE)，含 AGPL 及附加归属条件；本轮没有复制其代码。
- Open Enventory：[开发者说明](https://sciformation.com/open_enventory.html?lang=en)、[原项目](https://sourceforge.net/projects/enventory/)、[KV 扫码／导入编辑变更记录](https://github.com/khoivan88/open_enventory-modified_for_US/blob/develop/VERSION.md)、[KV 导入字段指南](https://open-enventory.gitbook.io/user-guides/user-guides/chemical-inventory/chemicals/import-a-list-of-chemicals)、[物质及库存资料维护](https://open-enventory.gitbook.io/user-guides/user-guides/chemical-inventory/chemicals)。开发者声明原项目为 AGPL v3，并链接 KV 指南；指南中的分支差异保留，不将商业 Sciformation ELN 能力混入开源版。部分 GitBook 子页抓取不可用，保留可取得的指南和分支源码依据，不假定每个旧手册入口均可用；现有认证继续沿用本项目会话与服务端权限。

### 对当前项目的优先级建议

1. **先补当前维护缺口。** 物资编辑／停用、草稿整单删除、分类型编码仍按上一节推进；导入来源不限制日后维护，有历史引用时保留 ID、旧编码、旧标签和原单快照。这是本轮实验室研究的前提，不另起通用低代码或 ELN 平台。
2. **把单件与位置做清楚。** 沿用现有物资、批次和逐件记录，逐件页突出编号、物资、批次／效期、当前状态、位置和来源流水。库位树的“物理位置”与已确认的“归属区域”分开；可增加受控移动事件，记录从哪里移到哪里。不得用改位置或改余量操作绕开发放权限。
3. **让扫码成为业务入口。** 扫码先展示单件详情；按状态和权限显示申请领用、管理员确认发放、位置维护等已有／后续动作，再确认记账。保留当前整瓶／整件发放，不因候选支持余量就自动变成按 mL/g 部分领用。二维码采用稳定身份，旧标签继续识别。
4. **按分类补实验室字段，保持页面简洁。** 化学试剂可选 CAS、厂家货号、纯度／浓度、开瓶日期、储存条件、SDS；普通耗材仍用基础字段。必要字段的归属要分清：同种物资属性放物资库，批号／效期放入库批次，开瓶日期／当前位置放具体单件。新增字段同时考虑 Excel、权限、历史、备份恢复，不一次引入任意字段设计器。
5. **后续再评估提醒和借还。** 效期筛选、临期提醒、先到期先选建议、安全库存／补货清单值得列入候选；这些是本项目建议，不表示上述系统均已原生实现。仪器或可周转物资的借还与耗材领用分开设计，部分余量、预占、自动下单和完整实验记录暂不扩大到本轮研究实施范围。

标签只参考“稳定二维码＋基础信息＋PDF／系统打印”的分工，不恢复已删除的 BarTender 或一维条码。候选提供标签文件不能证明当前纸卷、DL-886A 驱动及 USB 出纸已适配，仍保留本项目校准配置。

维护及审计继续沿用本项目规则：所有页面、API、Excel 和记账路径均须校验权限、版本并留痕。Chemotion 当前历史页有版本差异和受限回退说明，但不足以证明全部导入/API路径覆盖；不将单个“History”标签等同完整账本审计。Open Enventory 的直接编辑和终端流程也不作为删除已记账历史的依据。

本轮只完成研究与维护记录。无新业务版本、SQL 迁移、YML、镜像、NAS 操作或候选系统运行验证；上一节未实现的维护功能仍未实现。原有分支、四份文档修改和外部草稿均保留，命令显式使用 PowerShell 7.6.8。

## 0.12.0 实施映射（2026-10-23，开发与验证中）

用户要求据此完善本项目。本轮以`feature/v0.12.0-lab-material-maintenance`实施下列有限范围，旧研究段落仍保留当时状态；完整验证和发布另见CHANGELOG，不将候选项目全部能力写成本项目完成项。

| 参考方向 | 本项目实际改动 | 保留的边界 |
| --- | --- | --- |
| InvenTree／Snipe-IT的资料维护与引用保护 | 导入和手建资料同样可编辑，原因＋版本＋审计；未引用删除，有引用停用；当前库存显示当前资料 | 旧ID／编码、历史原单和流水快照保持，单位／管理方式有引用后锁定 |
| ERPNext/Frappe／Odoo的状态与编号 | 草稿整单删除、尚无验收事件的申报有原因取消；四类模板＋事务流水，永久保留编号分配历史 | 不物理删除已记账单据，不用改余额替代冲正，旧单号不重新编号 |
| eLabFTW层级存放位置 | 中文房间／柜／层树，继承启停，最多8层；验收、期初／补录、位置维护及Excel提供完整路径候选 | 归属区域独立，旧自由文本不强迁；被引用或有子级的库位不能改名移动删除 |
| Chemotion按物资类型显示资料 | 通用／化学试剂分类，CAS、纯度／浓度、储存条件及SDS链接；编辑、同次建档、Excel和schema7备份同时覆盖 | 不引入完整ELN、自动化学性质抓取或SDS二进制上传，转通用分类不清空已存字段 |
| Open Enventory的扫码入口思路 | 单件扫码突出编号、状态、物资、批次及位置，按现有权限提供申请／发放入口，已发放／作废只读 | 整瓶／整件发放；不引入部分余量、借还、仪器流程，也不恢复BarTender或一维条码 |

全部复用现有会话、权限、数据库事务和二维码／系统打印路径，无新运行依赖，未直接复制这些项目代码。新增迁移0004／0005，备份schema7保留旧1–6恢复缺省；旧6／5列物资模板及编码格式继续读取，新增10列中有冲突则逐格指出且不覆盖。库存回导仍13列，确认会增加库存，不是库的原位恢复。
