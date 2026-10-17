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
