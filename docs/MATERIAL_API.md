# 物资 API 合同（0.10.1）

实现入口：`createMaterials({db, body, send, fail, log, hasPermission, tokenUser, uploads, writeXlsx})`，同步返回 `{handle, backup, restore}`，方法均异步、调用方必须等待。`handle(req,res,url,user)` 处理 `/api/materials` 并返回 `true`，其他路径返回 `false`；错误向 HTTP 层抛出，不能吞掉后提交事务。新业务只使用 PostgreSQL 专表，不写旧 `records`。数据库继续为 PostgreSQL 18，不读取 SQLite；物资 JSON 备份兼容合同继续保留。0.7.0 中文 Excel、自动编码、整批校验与回导已经发布，其后实际 PG18 CI159/159及容器证据见[版本说明](CHANGELOG.md)，替代本页此前“CI尚待执行、镜像未发布”的过期状态。0.8.0 新增打印 API，验证结果单独记录，不复用旧版结论。

0.10.1 采用“申报可不关联信息库，验收时完善”的合同：申报只按显式 `catalogId` 关联；未关联行可在验收、纯拒收或结案的同次请求中选择已有物资或创建／复用物资信息。此规则替代 0.6.0／0.7.0 的申报精确自动匹配及必须先在原单修订建档的旧流程；下文保留旧版 Excel 与接口来源说明，不将旧语义作为现行行为。

0.9.0按用户决定删除全部BarTender活动接口、助手下载和打印站／队列模块，普通鉴权仍先执行，已登录用户访问旧路径返回404。旧表惰性保留，不再处理过期任务，也不加入物资JSON恢复。以下两段打印合同仅为历史，不是当前API。

## 历史：0.8.0打印任务（0.9.0已撤除）

打印入口为独立 `createPrinting(...)`，共同前缀 `/api/printing`；下列模板、站点、任务ID均为UUID字符串，物资单件ID仍为正整数。网页接口需登录及 `materials.read`；模板维护另需 ADMIN/MATERIAL 和 `materials.catalog.write`，打印站维护需 `permissions.write`。普通人员仅能查看和操作本人任务，任一上述管理权限可管理任务及填写人工确认。

| 接口 | 输入／输出 |
| --- | --- |
| `GET /config` | `{templates,stations,capabilities:{manageTemplates,manageStations,submit}}`，不返回令牌或模板正文 |
| `POST /templates` | `{name,fileName,contentBase64,fields}`；规范Base64、原文件1–4MiB、`.btw`；每上传生成新版本，字段为12列的子集且含Code或QRPayload |
| `GET /templates/:id` | 管理人员下载原内容与元数据；`POST /templates/:id/disable {}` 停用新任务入口 |
| `POST /stations` | `{name,printerName}` → `{station,token}`，令牌仅本次返回；`PUT /stations/:id` 更新名称、精确打印机名或enabled |
| `POST /stations/:id/rotate-token` | `{}` → `{station,token}`；旧令牌撤销，已领取／执行任务转为unknown，队列保留 |
| `POST /jobs` | `{stationId,templateId,unitIds,idempotencyKey,reason?,reprintOf?}`；1–1000个不重复单件，服务器按ID取12列快照，每件一张；同用户同请求号同内容复用，不同内容409 |
| `GET /jobs?page=&pageSize=` | `{items,total,page,pageSize}`，默认20最大100；`GET /jobs/:id` 另含rows快照 |
| `POST /jobs/:id/cancel` | `{}`，仅queued或claimed；已启动或结束409 |
| `POST /jobs/:id/confirm` | `{reason}`，管理人员仅对submitted或unknown人工核对；不会触发打印 |
| `GET /agent-script` | 登录及物资读取权限，下载同版 `bartender-agent.ps1` 精确字节 |

重印是新任务，必须原因，同原站、原模板及原单件顺序，保留原快照；原任务须已结束，模板／打印站仍需可用。打印不改库存、单件身份或编码流水。领取120秒、启动后30分钟租约；超时变unknown，不自动重新排队。模板停用只阻止新建，不撤回已有任务快照。

Windows使用站点Bearer令牌，仅可处理本站：`POST /agent/claim {agentVersion?}` 返回 `{job:null}` 或任务、模板字节及leaseToken；`POST /agent/jobs/:id/start {leaseToken}` 提交成功后才允许调用引擎；`POST /agent/jobs/:id/result {leaseToken,status,message}` 接收submitted/failed/unknown，同结果重复回报幂等。claimed仅可回failed/unknown，不能跳过启动。站点令牌服务端只存摘要，不作为网页会话；无权、过期或状态冲突按401／409拒绝。

打印表不加入物资JSON备份，应随完整PostgreSQL备份。具体字段与Windows操作见[打印助手指南](BARTENDER_AGENT.md)。以下继续是物资API，前缀与ID类型仍按各节约定。

所有接口需要登录。普通错误为 `{error, code?}`；401 登录失效，400 输入错误，403 无权，404 不存在，409 版本/状态/幂等冲突。Excel 校验错误另含 `{code:'IMPORT_VALIDATION',errors:[{sheet,row,column,field,value,message}],totalErrors}`：`row` 是 Excel 实际行号、`column` 为 A/B/…列字母、`field` 是中文表头；一次最多返回前 200 个明细并给出错误总数，文件级错误可能没有工作表和坐标。页面以纯文本逐条显示，保留选中文件及表单。解析工作簿后重新验证会话和权限；401／403 直接返回，不伪装成单元格错误。`quantity`、`amount` 写入必须是非指数十进制**字符串**，最多三位/两位小数；读取为整数 `qtyM`、`amountCents`。金额无权限时所有响应、历史快照均省略金额字段。

列表统一 `{items,total,page,pageSize}`，查询 `page` 默认 1、`pageSize` 默认 50，最大 200，`q` 搜索。ID 为正整数。API 仓库代码由 meta 返回，网页和新 Excel 使用中文仓库名称；区域、分类是管理员维护的稳定 ID，输入界面显示中文名。库存合并键为物资 ID + 仓库代码 + 区域 ID。

## 元数据与字典

- `GET /api/materials/meta` → `{capabilities,warehouses,openingClosed,quantityScale:1000,amountScale:100}`。
- capabilities：`manageCategories,manageRegions,manageCatalog,createRequest,submitRequest,editSubmitted,receive,closeReceipt,reverseReceipt,initialize,adjustStock,viewAmount,export,backup,restore,legacyRead,createIssue,manageLocation,issueStock,viewAllIssues`。
- warehouses 固定为 `{code,name}`：`MAIN` 默认仓库、`REAGENT` 试剂库、`CONSUMABLE` 耗材库、`SPARE` 备用库。
- `GET /categories`、`GET /regions` → 分页；行 `{id,name,createdBy,createdAt}`。
- `POST /categories`、`POST /regions`，正文 `{name}` → 201 创建行。ADMIN 或 MATERIAL + 对应动作权限；首期只新增，不删历史选项。
- `GET /catalog` → 分页；支持 `q,categoryId,trackingMode,regionId,warehouse`。行 `{id,code,name,spec,unit,remark,origin,trackingMode,categoryId,categoryName,version,stockQtyM,localQtyM?}`；排除已合并信息，`origin` 为 `manual|receipt`。
- `POST /catalog`，正文 `{code?,name,spec,unit,categoryId,trackingMode?,remark?}` → 201 物资信息；ADMIN/MATERIAL + `materials.catalog.write`。0.7.0 约定省略或空 `code` 时系统分配内部编码，网页不要求手填；显式传入编码仍须唯一且与身份一致。规范化后重复身份不另建；请求建档关联与导入的复用语义见下文。新建来源为 `manual`，验收中新建来源为 `receipt`；复用已有信息不覆盖其备注或来源。

下文省略共同前缀 `/api/materials`。

## 物资信息库与库存匹配（0.10.1 现行规则）

“主档”在页面称为“物资信息库”，保存标准身份信息，不代表库存。`stockQtyM` 为该物资所有区域／仓库的库存毫单位总量；传 `regionId` 或 `warehouse` 时另含筛选范围的 `localQtyM`。检索先按所选范围正库存、其他范围正库存、零库存排序；不传范围时全局正库存优先。`q` 对编码、名称、规格进行规范化包含搜索，只帮助选项查找，不能据此自动合并物资。

新增申报行仅在显式提供 `catalogId` 时关联已有物资，其名称／规格／单位及编码取服务器现有信息；没有 `catalogId` 时保留未建档行，不按编码或名称＋规格＋单位自动复用。PATCH 省略 `catalogId` 保留原关联，显式 `null` 解除关联时仍受已有业务身份锁保护。新输入的名称／规格／单位进行 NFKC、首尾去空白及连续空白合并，仍须填写完整；修改其他字段不重写历史身份文本或快照。验收时的建档复用按规范化后的名称＋规格＋单位精确识别，并核对分类及管理方式；有歧义或冲突返回 409，不按模糊检索合并。

| 接口 | 合同 |
| --- | --- |
| `GET /catalog/template` | 下载中文 XLSX 空模板及引用参考页，需 `materials.export`；路径没有 `.xlsx` 后缀 |
| `GET /catalog/export.xlsx` | 导出全部符合 catalog 检索条件的标准信息，需 `materials.export`；最多 5000 条，超限 413 |
| `POST /catalog/import` | `{name,content}`，`content` 是 XLSX canonical base64；ADMIN/MATERIAL + `materials.catalog.write`；201 `{created,skipped}` |
| `POST /requests/:requestId/items/:itemId/catalog` | `{requestVersion,itemVersion,requestIdempotencyKey,code?,name,spec,unit,categoryId,trackingMode?,remark?,reason}`；保留的原单修正接口，复用或创建物资信息并原子关联；首次 201 `{request}`，幂等重试 200；0.7.0 空编码时自动分配 |

0.7.0 信息库模板和导出列为：**物资名称、规格、单位、物资分类、管理方式**。名称／规格／单位可从引用下拉参考已有物资，也可填写新值；分类须为已有中文名称，管理方式为“逐件”或“数量”。参考列表基于导出时的数据，不能代替导入时的服务端校验。旧版含“物资编码”的六列表头仍可识别，旧编码须文本以保留前导零；新模板不要求人工编码。

物资、分类及区域参考列表各最多 5000 条，优先带入本次导出涉及的数据；工作簿明细及每次导出仍最多 5000 条，但不限制信息库或字典的总记录数。某参考库超过 5000 条时，截断列表的相应列允许手填已有中文名称，不强迫只能选到前 5000 条；仓库和管理方式的固定小列表保持严格选项。服务端按完整当前数据验证，列表内外都不能绕过身份、权限或字段规则。名称／规格／单位各自下拉是独立选择，组合仍须匹配同一物资；目录导入则允许确实不存在的新组合。

每次导入 1–5000 行、文件不超过 5 MiB，受下文 XLSX 压缩与公式等限制。按规范化的**名称＋规格＋单位**精确匹配；唯一已有身份且分类／管理方式一致则跳过复用，不重复建档，有歧义或字段冲突返回具体位置，整批不写。分类或管理方式冲突定位到实际对应列，新五列表分别为 D／E，不笼统归到物资名称。导出的信息库可原样导回，不增加库存或实物码；不能用信息库导入修改已经引用的物资身份。解析后重新验证会话与权限，在同一事务校验并写入；数量金额与位置继续从期初／补录草稿导入并确认入库。

原单建档关联需要 ADMIN/MATERIAL + `materials.catalog.write` 以及该行 `mayEdit` 资格；只有未关联、没有历史验收／拒收／结案事件的行可用。已提交单另须 MATERIAL + `materials.request.edit_submitted`，原因、父单及行版本必填。创建信息、关联、版本递增、审计及修订快照处于同一事务，保留原提交版，不直接增加库存；同幂等键异文或版本过期返回 409。已有信息可在普通修订中直接选择关联。

上述原单接口用于受控修正，不是未关联行办理首次验收的前置步骤；首次验收关联使用下文 `POST /receipts` 或结案接口及其验收权限。

## 独立单件与条码规则（0.4.0）

主档增加 `trackingMode:'quantity'|'unit'`。旧主档和 API 创建时省略该字段均为 `quantity`，新建页面默认选择 `unit`。按数量管理保留三位小数；逐件管理要求以瓶／件等整件为基本单位，所有业务数量均为整数，不进行瓶内余量或单位换算。只整瓶／整件发放。

- `POST /catalog` 可传 `trackingMode`。
- `PUT /catalog/:id/tracking-mode`，`{trackingMode,version,reason}` → `{catalog}`。ADMIN/MATERIAL 加 `materials.catalog.write`；仅无相关业务记录的主档允许切换。已有存量不自动补码或虚构来源。
- `GET /unit-label-rule` → `{rule:{template,padding,version,updatedAt,actorId},nextSequence,dateBasis:'UTC'}`，所有登录用户可读。
- `PUT /unit-label-rule`，`{template,padding,version,reason}` → 相同结构；ADMIN/MATERIAL 加主档维护权限，原因必填、版本校验、审计。

默认模板 `LAB-{YYYY}{MM}{DD}-{SEQ}`，流水号最少六位。模板支持固定 ASCII 文本及 `{YYYY}`、`{MM}`、`{DD}`、`{SEQ}`，必须包含流水号；`padding` 为 1–12。日期使用 UTC；流水号全局递增，不按日期或规则重置，修改模板不改变已生成的码。生成与库存、审计、幂等记录处于同一事务；单件码唯一，不能与包装码冲突。

逐件主档的合格验收、期初与正调整按实际数量自动生成 N 个不同码，每次最多 1000 件；拒收、结案不生成。单件不单独估值，金额继续使用原批次均价核算。冲正只允许原验收生成的全部具体单件仍在库时整笔办理，不能用后来同批入库的其他瓶替代。

- `GET /stock/units` → 统一分页。支持 `receiptId,issueId,catalogId,regionId,warehouse,batch,expiryDate,status,q`，空批号／效期存在时精确匹配。`status` 为 `in_stock|issued|void`，默认包括全部状态。
- 单件行：`{id,code,sequence,qrPayload,catalogId,catalogCode,name,spec,unit,regionId,regionName,warehouse,warehouseName,batch,expiryDate,location,status,sourceMovementId,exitMovementId,sourceReceiptId,createdAt}`；`qrPayload` 为单件码本身，`warehouseName` 为中文仓库名，`warehouse` 继续用于程序识别。
- 验收行增加 `unitCount`，验收／冲正写入回包另含 `units`；主档、库存及领用增加 `trackingMode`。领用列表返回单件数，详情／处理回包的 `units` 为实发单件，避免历史列表展开过大；完整单件从分页接口读取。
- `POST /scan/resolve` 命中单件 → `{kind:'unit',catalog,unit,batch}`；已领用／作废仍可追溯，但不可重复出库。单件码指向既有入库实物，不能拿它再验收入库。
- 逐件 `POST /issues/:id/issue` 及减少库存的 `POST /stock/adjustments` 必须传 `unitIds:number[]` 或 `unitCodes:string[]`，两者只选一个。编号不得重复，必须同一精确批次且仍在库，个数须等于申请／调整数量；检查、状态更改与扣库同事务。按数量主档拒绝这两个字段。

申请仍只记录批次和数量，不预占单件；扫码单件可定位批次并预填申请一件，发放时扫描实际取出的每件。0.9.0标签仅输出二维码与基础信息，二维码仍表示原永久单件编号，重打印不重新发号；原Code128生成已撤除，包装码读取继续保留。

## 包装条码与库存二维码

- `GET /catalog/:id/barcodes` → 统一分页，按绑定 ID 升序；所有登录用户可读。行 `{id,code,catalogId,createdBy,creatorName,createdAt}`。
- `POST /catalog/:id/barcodes`，`{code,reason}` → 201 `{barcode}`；需要 ADMIN 或 MATERIAL + `materials.catalog.write`，复用 `manageCatalog` 能力。绑定原因必填并审计；同码已绑定同主档返回 200 原绑定，已绑定其他主档返回 409。
- `DELETE /barcodes/:id`，`{reason}` → `{deleted:true}`；权限相同，解除原因必填并审计。绑定不直接修改；纠错先解除，再创建新绑定，新 ID 在当前数据库中不复用。旧表单删除已解除的 ID 返回 404，不会删除后来建立的绑定。

一个主档可绑定多个外包装条码/二维码，同一个码只能绑定一个主档。`code` 为 1–512 字符字符串，去除首尾空白，保留前导零、大小写和内容；拒绝内部控制字符及无效 Unicode。`LABOS-STOCK:` 为系统库存二维码保留前缀，不能绑定为包装码。这里只按完整码查主档，不自动从 GS1 等包装内容提取数量、批号或有效期。

`POST /scan/resolve`，正文 `{code}`，所有登录用户可用，只读解析且金额继续按权限省略：

- 已绑定包装码 → `{kind:'catalog',catalog,barcode}`，`catalog` 使用主档列表行结构；包装码本身不决定仓库、区域或批次。
- 系统库存二维码 → `{kind:'stock',catalog,batch}`，`batch` 为当前 `/stock/batches` 行，含最新数量、位置、位置版本及 `qrPayload`；耗尽但有历史流水的批次仍可定位。
- 未绑定包装码、找不到对应主档或精确库存批次 → 404。保留前缀但版本、JSON 或字段无效 → 400。外部 URL 也只作为码字符串查找，不会请求其中地址。

每条批次余额的 `qrPayload` 格式为 `LABOS-STOCK:1:` 加以下对象的 JSON 文本，字段全部必填且不接受额外字段：

```json
{"catalogId":1,"catalogCode":"MAT-001","regionId":1,"warehouse":"MAIN","batch":"","expiryDate":""}
```

主档/区域 ID 必须是正安全整数，主档编码必须与当前主档一致；仓库、批号、有效期按现有规则校验。空批号和空有效期必须保留为 `""`，用于精确定位，不能省略后扩大查询范围。二维码只含定位信息，不含数量金额、会话或记账授权。

扫码入库先按主档及可用的区域/仓库筛选 `/acceptance?status=open`，由操作人选择已有申报行，再调用现有验收表单及 `POST /receipts`，仍检查 MATERIAL 权限、版本和幂等键。扫码领用先选择精确批次，再沿用普通人员申请、MATERIAL 发放；扫码解析不创建申报、不自由入库，也不直接扣库。

## 申报与修订

- `GET /requests`，可选 `status=draft|submitted`、`from,to` → SQL 筛选与分页摘要；`q` 覆盖单号、标题、创建人、明细名称/编码/规格、分类与区域。
- `POST /requests`，`{title,description?}` → 201 完整单据。所有登录用户可建单。
- `GET /requests/:id` → 完整单据。
- `PATCH /requests/:id`，`{requestVersion,title?,description?,reason?}` → 完整单据。
- `POST /requests/:id/items`，`{requestVersion,catalogId?,code?,name?,spec?,unit?,categoryId,regionId,warehouse,quantity,purpose?}` → 201 完整单据。
- `PATCH /requests/:id/items/:itemId`，`{requestVersion,version,...待改行字段,reason?}` → 完整单据。
- `DELETE /requests/:id/items/:itemId`，`{requestVersion,version}` → 完整单据，仅草稿。
- `POST /requests/:id/submit`，`{requestVersion}` → 完整单据。仅 MATERIAL + submit 权限；至少一条有效明细，允许 catalogId 为空；无主档不阻断提交。
- `GET /requests/:id/revisions` → `{originalSnapshot,revisions:[{id,revision,reason,actorId,actorName,createdAt,before,after}]}`；提交版 revision=1，修订从 2 起。

单据含 `{id,no,title,description,status,createdBy,creatorName,createdAt,submittedBy,submittedAt,version,revision,canEditHeader,canAddItem,canSubmit,items}`。摘要保留表头与操作能力，另含 `itemCount,progress:{pendingItems}`，不附 `items` 或附件；完整内容通过详情接口读取。

明细含 `{id,requestId,catalogId,code,name,spec,unit,categoryId,categoryName,regionId,regionName,warehouse,qtyM,purpose,authorId,authorName,version,identityLocked,acceptedQtyM,closedQtyM,remainingQtyM,receiptStatus,canEdit,canDelete}`。`receiptStatus` 为 `pending|partial|done|closed`；identityLocked 表示存在任何历史验收/拒收/结案事件，冲正后也不解除身份保护。

未匹配的草稿行允许普通用户先填写名称／规格／单位，`catalogId` 可为空；0.3.1 起允许先提交，0.10.1 继续保留此行为，并替代 0.6.0／0.7.0 的精确自动复用规则。验收、拒收或结案可在同次请求中完成首次关联；原单修订仍按受控修正规则办理。有 `catalogId` 时名称／规格／单位由服务端物资信息确定。规格、单位、分类、区域、仓库及数量的必填校验保持不变。

草稿本人改本人行，MATERIAL 可改全部；仅创建者/MATERIAL 可改草稿表头。提交后仅 MATERIAL + `materials.request.edit_submitted` 可改表头/已有行，必须 reason；不能新增/删行。原提交快照不覆盖。已有任何验收/结案记录的行保护 catalogId/code/name/spec/unit/warehouse/regionId；qtyM 不得小于有效已验收+结案量。分类、用途、合法数量仍可修订。修改申报不改变库存。

`requestVersion` 为父单 `version`；行 `version` 为该行 token。所有内容或验收进度变化均递增对应 token；`revision` 仅在提交/提交后内容修订时变化。表单应保留打开时 token；409 后保留输入并要求重新读取，不能自动重试覆盖。唯一追加例外是草稿 POST items：要求有效 requestVersion，但不因其他人刚新增行导致版本陈旧而拒绝；事务内确认仍是草稿后追加，成功仍递增父版本，使旧提交预览失效。

## 验收、结案与冲正

- `GET /acceptance` → SQL 筛选与分页 `{...明细,requestNo,requestTitle,requestVersion,requestRevision,requestCreatedAt}`；仅已提交行；可用 `status=all|pending|partial|done|closed` 按 receiptStatus 筛选，新增 `status=open` 按剩余数量大于零同时包含未验收及部分验收，SQL 总数和分页均只计算命中行。默认仍包含完成历史。可用 `catalogId,regionId,warehouse` 精确筛选，`from,to` 按原申请创建日期筛选；`q` 覆盖名称/编码/规格、分类/区域及来源单号/标题。
- `GET /receipts?requestId=&itemId=` → 分页事件。事件含 `{id,type,requestId,itemId,requestRevision,snapshot,qtyM,rejectedQtyM,closedQtyM,amountCents?,reason,rejectedReason,zeroAmountReason,originalReceiptId,batch,expiryDate,date,actorId,actorName,createdAt,reversed}`。type 为 `acceptance|rejection|close|reversal`。
- `POST /receipts`，`{requestId,itemId,requestVersion,version,requestIdempotencyKey,quantity,amount,rejectedQuantity?,rejectedReason?,zeroAmountReason?,batch?,expiryDate?,date?,location?,locationVersion?,catalogId?,newCatalog?}` → 201 `{receipt,request}`。实际仓库/区域取当前已确认申报行；不接受前端改归属。合格+拒收不超过当前剩余量；拒收不抵扣后续允许合格量。合格量大于零但金额为零须原因；纯拒收使用 quantity=`"0"`、amount=`"0"`、rejectedQuantity>0，不入库且不关闭期初。只要拒收数量大于零，rejectedReason 必填。合格入库可同时设置位置：省略 location 时保留现位置；显式提供时需当前 locationVersion，实际变更另需 ADMIN/MATERIAL 加 materials.stock.location。位置与验收同事务，历史 snapshot.location 保留入库时位置。
- `POST /requests/:id/items/:itemId/close`，`{requestVersion,version,requestIdempotencyKey,reason,catalogId?,newCatalog?}` → 201 `{receipt,request}`，将当时剩余量结案，不产生库存。
- `POST /receipts/:id/reverse`，`{requestVersion,version,requestIdempotencyKey,reason}` → 201 `{receipt,request}`。仅整笔冲正原合格验收，最多一次，数量金额精确反向，库存不能负数。

验收、纯拒收及结案支持两种互斥的可选入参：`catalogId` 选择有效已有信息，或 `newCatalog:{name,spec,unit,categoryId?,trackingMode?,remark?,code?}` 创建／复用信息。只对未关联行办理首次关联，分类省略时使用申报行分类；省略管理方式的 API 默认值仍为 `quantity`，页面明确默认 `unit` 并可改为数量管理。已关联行不传新字段即可沿用旧请求，不能通过此动作更换关联。未关联且未提供有效选择时返回 409：`验收前请选择已有物资信息，或填写新物资信息`。

首次关联仅需本动作的 MATERIAL + `materials.acceptance.write`，不另需 `materials.catalog.write`、提交后修订权限或独立建档原因；拒收、零金额及结案等原有原因仍必填。建档／复用、写入标准身份、`LINK_CATALOG` 审计、父单及行版本递增、验收事件、库存及幂等结果在同一事务提交，失败全部回滚；纯拒收和结案不增加库存。原提交快照中的 null 主档保持原样，不重写历史快照。

以上动作需要 MATERIAL + `materials.acceptance.write`。记账 `requestIdempotencyKey` 为 8–128 字符；同用户同键同正文返回原结果（200），同键不同正文 409。客户端每次真实操作产生新键，网络重试复用原键及原正文；不要与申报单 requestId 混淆。

## 库存与期初

### 期初／存量补录单据（0.5.0）

以下路径均在 `/api/materials` 下。草稿不记库存，已入库单不能编辑。普通读取需 `materials.read`，或 MATERIAL 加期初／调整权限；金额继续按 `materials.amount.read` 裁剪。写入期初需要 MATERIAL + `materials.stock.initialize`，补录需要 MATERIAL + `materials.stock.adjust`，ADMIN 单独不能办理业务。

| 接口 | 内容 |
| --- | --- |
| `GET /openings` | 分页，支持 `q,status,kind`；summary 不含 items |
| `POST /openings` | `{title,date?,description?,reason?}`，201 返回单据；闭账后自动为 supplement 且原因必填 |
| `GET /openings/:id` | 单据及全部明细 |
| `PATCH /openings/:id` | `{version,title,date?,description?,reason?}`，更新草稿表头 |
| `POST /openings/:id/items` | `{version,catalogId,regionId,warehouse,quantity,amount,batch?,expiryDate?,location?,locationVersion?,zeroAmountReason?}`，201 返回单据 |
| `PUT /openings/:id/items/:itemId` | 同上，另需 `itemVersion`；更新草稿行 |
| `DELETE /openings/:id/items/:itemId` | `{version,itemVersion}`，删除草稿行 |
| `POST /openings/:id/import` | `{version,name,content}`；XLSX canonical base64，201 全部追加草稿 |
| `GET /openings/template.xlsx` | 带物资、区域、中文仓库引用下拉的空模板，需 `materials.export` |
| `GET /openings/:id/export.xlsx` | 导出当前单据，需 `materials.export`，金额按权限裁剪 |
| `POST /openings/:id/post` | `{version,requestIdempotencyKey}`；201 首次成功／200 同正文重试，返回 `{opening,openingClosed}` |

单据含 `id,no,title,date,description,kind(opening|supplement),reason,status(draft|posted),version,createdBy,creatorName,createdAt,postedBy,posterName,postedAt,itemCount,unitCount,items`。明细包含主档／分类／区域名称与 ID、仓库、`qtyM,amountCents,batch,expiryDate,location,locationVersion,zeroAmountReason,movementId,unitCount,version`。其他详情／写操作直接返回单据。

0.7.0 每单最多 5000 行，一次入库最多生成 1000 个新单件码，超过实物数量限制须拆单。入库将全部行、位置、库存流水、固定码及幂等记录置于一个事务；任何行失败全部回滚。`GET /stock/units?openingId=:id` 查询此单生成的实物，重印沿用原码；旧无单据期初通过 `GET /stock/movements?type=opening` 查历史，不虚构单据。

首次验收或手动关闭后，原 opening 草稿只读，需另建有原因的 supplement。补录写正向 adjustment，来源为 `opening-doc:<docId>:<lineId>`，流水带单号和原因，不重开全局期初。

导入额外要求 `materials.amount.read`；限 5 MiB、128 个 ZIP 条目，单条解压 6 MiB、总解压 12 MiB。0.7.0 在工作簿中识别完整匹配的明细表头：**物资名称、规格、单位、区域、仓库、数量、总金额（元）、批号、有效期、存放位置、零金额原因**。前五列引用现有中文选项，物资名称＋规格＋单位须对应同一条已有信息，区域及仓库按中文名识别；各列分别下拉仍可能选出不匹配组合，服务端继续核对。旧版“物资编码、区域、仓库编码、数量、总金额（元）、批号、有效期、存放位置、零金额原因”九列表头作为兼容入口保留。

日期用 YYYY-MM-DD 文本，拒绝单元格计算公式、宏、外链、嵌入对象、XML 实体及异常范围；模板内用于验证列表的引用定义不作为可执行单元格公式。错误尽量返回工作表与实际坐标，一批错误先显示前 200 条及总数。先完整验证再追加草稿，不覆盖已有行、不直接入库、不部分导入。已入库单导出只复制明细到新草稿，不恢复原流水、单件码或入库状态；重复导入不会自动消除重复库存。

### 原有库存接口

- `GET /stock` → 分页 `{id:复合稳定字符串,catalogId,code,name,spec,unit,regionId,regionName,warehouse,qtyM,amountCents?,lastMovementAt}`，可筛选 `regionId,warehouse,catalogId`。
- `GET /stock/batches` → 分页的批次余额，保留 `/stock` 身份、数量及金额字段，另含 `batch,expiryDate,categoryId,categoryName,location,locationVersion,qrPayload`。按主档+仓库+区域+批号+有效期汇总；支持 `q,catalogId,regionId,warehouse,batch,expiryDate` 筛选，耗尽批次仍保留，未设置位置为 `""`、版本为 `0`。
- `GET /stock/movements` → 分页 `{id,type,catalogId,regionId,warehouse,qtyM,amountCents?,sourceId,issueId,snapshot,batch,expiryDate,date,reason,actorId,actorName,createdAt}`，支持上述身份及 `batch,expiryDate` 筛选。后两项存在时精确匹配，空字符串仅匹配未填批次/有效期，省略则不限。type 为 `opening|receipt|reversal|adjustment|issue`；`sourceId` 是验收来源，领用来源使用 `issueId`。
- `POST /stock/opening`，`{catalogId,categoryId?,regionId,warehouse,quantity,amount,zeroAmountReason?,batch?,expiryDate?,date?,requestIdempotencyKey}` → 201 `{movement,openingClosed}`，需要 MATERIAL + initialize 权限。
- `POST /stock/opening/close`，`{reason}` → `{openingClosed:true}`；MATERIAL + initialize，永久关闭期初。首次合格验收入库也原子关闭期初。
- `POST /stock/adjustments`，`{catalogId,regionId,warehouse,quantity,amount,direction:'increase'|'decrease',reason,requestIdempotencyKey,batch?,expiryDate?}` → 201 `{movement}`；MATERIAL + adjust，数量为正数、金额允许零，direction 决定符号，原因必填；批次余额与总余额均不能负数。零金额允许处理赠品等已入库物资。

### 存放位置

- `PUT /stock/location`，`{catalogId,regionId,warehouse,batch?,expiryDate?,location,version,reason}` → `{location:{id,catalogId,regionId,warehouse,batch,expiryDate,location,version,reason,actorId,actorName,updatedAt}}`。ADMIN/MATERIAL + `materials.stock.location`；必须已有该批次流水。位置最多 200 字，允许空字符串清除，修改原因必填。
- `version` 为打开批次详情时的 `locationVersion`，初次设置为 `0`；陈旧版本返回 409，不覆盖其他人更新。此操作只更新位置和审计，不改变库存数量金额。

位置是“2号柜／第3层”这类文字，与仓库和归属区域分开。首期一个完整库存批次对应一个位置，不拆分多货架余额；位置变化后的待发放申请显示当前位置，发放流水保留当时位置。

## 领用申请与发放

- `GET /issues` → 统一分页；支持 `q,status=pending|issued|rejected|cancelled`。普通用户仅本人，ADMIN/MATERIAL 查看全部；是否能发放另检查 MATERIAL 及动作权限。
- `GET /issues/:id` → `{issue}`，遵守同一可见范围。
- `POST /issues`，`{catalogId,regionId,warehouse,batch?,expiryDate?,quantity,purpose,requestIdempotencyKey}` → 201 `{issue}`。所有登录用户可为自己申请单物资、单批次，数量为正十进制字符串、用途必填；申请时检查当前余量，但不预占库存，申请人从会话确定。
- `POST /issues/:id/issue`，`{version,requestIdempotencyKey}` → 201 `{issue}`。仅 MATERIAL + `materials.issue.write`；只处理待发放且版本相符的申请，在同一事务内重新核对实时批次余额，整笔发放并记录独立负向 `issue` 流水。余量不足返回 409，不少发、不透支、不改变申请状态。
- `POST /issues/:id/reject`，`{version,reason,requestIdempotencyKey}` → 201 `{issue}`。同一 MATERIAL 权限，须说明原因驳回待发放申请，不扣库存。
- `POST /issues/:id/cancel`，正文同上，只有申请人可取消自己的待发放申请，不扣库存。

领用行含 `{id,status,version,catalogId,regionId,warehouse,batch,expiryDate,qtyM,amountCents?,snapshot,location,purpose,reason,createdBy,creatorName,processedBy,processorName,createdAt,processedAt,movementId,canIssue,canReject,canCancel}`。初始 `pending`，处理后进入 `issued|rejected|cancelled` 并递增版本，不能再编辑或删除。录错的已发放库存通过有原因的调整留痕纠正；本轮不支持部分发放、预占或领用单冲正。

金额由系统按发放时批次“账面总金额×本次数量÷现存数量”用 BigInt 四舍五入到分，领完时精确扣除全部余款，支持零金额赠品。申请人不指定金额；非已发放状态的零金额表示未记账。申请快照保留当时信息，待发放的 `location` 读取当前位置，已发放的 `location` 取发放流水快照。数量及金额同事务防负；同用户同幂等键同正文重试返回 200 原结果，不重复创建或扣库，同键异文返回 409。

## 附件

- `GET /requests/:id/attachments` → `{items:[{id,name,mimeType,size,parentType,parentId,createdAt}]}`。
- `POST /requests/:id/attachments`，`{requestVersion,name,mimeType,content:base64,reason?}` → 201 `{attachment,request}`。草稿创建者或 MATERIAL；提交后 MATERIAL + editSubmitted + 原因，纳入修订快照。
- `POST /receipts/:id/attachments`，`{name,mimeType,content,reason}` → 201 `{attachment}`；MATERIAL + acceptance.write。验收附件追加，不能覆写已记账事实。
- `GET /receipts/:id/attachments` → `{items:[附件元数据]}`，另需金额读取权限。
- `GET /attachments/:id/download` → 原附件；验收附件另需金额读取权限，避免通过单据扫描件泄漏金额。
- `DELETE /attachments/:id`，`{requestVersion,reason?}` → `{request}`，仅申报附件可受控移除；旧文件为历史保留，不物理删。

单个文件最大 5 MiB；只接收合法 base64、文件名和 MIME，实际存储使用随机名，禁止路径穿越；新附件与旧 files 完全分开。

## Excel 与业务备份

- 0.7.0 回导范围仅限**物资信息库与库存**，包括期初／补录明细；申报、验收和领用导出保持历史报表，不提供回放导入。Excel 回导与完整 JSON 恢复不同，不携带历史办理人、状态、流水或原单件码。
- 物资相关 Excel 导出的仓库列统一输出中文仓库名称；内部 `warehouse` 代码继续用于 API 身份及精确批次定位，不要求新模板填写机器码。
- 有金额读取权限的库存导出增加 `库存导入明细` 页，按当前正库存批次输出上述十一列，并带中文引用下拉；可直接交给 `POST /openings/:id/import` 追加新草稿，核对确认后才入库。保留物资＋区域＋仓库＋批号＋有效期＋位置，不把库存汇总当作批次明细。无金额权限的脱敏导出不包含完整回导页，文件明确标记仅供查看，服务端不会用缺失金额补零入库。
- `GET /export.xlsx?type=requests|stock|issues` → 真正 XLSX；需要 `materials.export`，金额列另看 amount 权限。`type` 省略时默认 `requests`。申报导出支持 `q,from,to,status=draft|submitted,requestId,version=current|original`，日期按申报创建日期筛选，筛选命中的单据包含全部明细；`version` 默认 current，original 先按当前单据筛选，再使用原提交快照，未提交草稿仍用当前内容。库存导出支持 `q,regionId,warehouse,catalogId`，含库存汇总及按相同条件筛选的批次库存、存放位置。领用导出支持 `q,status` 并遵守本人/管理员可见范围，含申请时位置和当前位置或发放时位置；未发放金额留空。导出全部筛选结果，不受列表页码限制；一次最多 1000 张申报单，明细、验收流水和修订记录各不超过 5000 条；库存、批次或领用各最多 5000 条，超限返回 413。
- 页面申报列表导出沿用已查询的 `q,status,from,to`，库存列表沿用 `q,regionId,warehouse`，领用列表沿用 `q,status`；单据详情按 `requestId,version` 导出，不携带列表筛选。验收列表不提供按验收进度导出，通过每行“原单”进入来源申报后导出；`pending|partial|done|closed` 不是申报导出的 status 值。
- 用户文本按文本单元格写，不识别公式。原版/当前申报明细完整导出；验收流水及修订记录仍保留所选单据的完整历史。修订记录的“修改前/后快照摘要”单元格最多32767字符，超长时明确加注“完整快照见修订历史/物资备份”，完整历史仍保留于系统及业务备份。
- `GET /backup` → 完整业务 JSON，需 backup.read + materials.amount.read。包含十七张物资业务及辅助表（含期初单及明细、单件、包装码映射、存放位置、领用）、编号规则与序号、附件内容、稳定用户映射与所有快照，不含用户密码。既有 Excel 导出保持原有数量金额及筛选口径。
- `POST /restore`，正文为上述完整备份对象 → `{restored:true,counts}`，需 backup.restore + materials.amount.read；只允许空的新业务库，验证格式、用户 username→当前ID 映射、外键、库存及来源唯一性，事务恢复；同份重放与追加恢复均拒绝。

物资备份严格限定顶层字段为 `type,schemaVersion,generatedAt,users,data,files`；`type=labos-materials-backup`、新导出 `schemaVersion=6`，生成时间为完整 ISO UTC 时间。严格兼容 schema 1 原十一表、schema 2 原十三表、schema 3 原十四表、schema 4 原十五表及 schema 5 原十七表：按旧版定义补空后续新增表，旧主档补 `quantity`，补初始编号规则及序号。每个版本必须包含当时全部表及字段，不能夹带未来版本的表/字段。用户映射仅 `{id,username}`，附件内容仅 `{id,content,sha256}`。未知顶层字段、未知表/字段、遗漏字段均拒绝。领用处理人、条码创建人、规则修改人及快照同样按 username 映射现有用户。

恢复继续核对领用状态/版本、申请与发放流水、历史批次成本分摊、取消/驳回无流水、位置、包装码及非负库存。schema 4 另核对单件码／序号唯一、来源与退出流水、状态及数量守恒、编号规则和序号进度；失败整次回滚。旧服务不能恢复 schema 4，回退必须恢复升级前完整运行数据，不能只切旧镜像。旧版表结构升级要求仍保留。

schema 5 新增 material_openings 与 material_opening_items，严格检查草稿无流水、已入库明细唯一对应正向来源流水、单件数量及补录闭账不变量；posted_by / postedBy 同样映射现有账号。旧格式恢复时补空两表，不虚构期初单据。旧服务无法恢复 schema 5，回退须恢复升级前完整运行目录。

schema 6 增加物资信息的 `remark,origin,merged_into` 及申报／验收／流水的厂家、备注准备列。读取严格 schema 1–5 时仅补新列默认值（`remark`／`manufacturer`／`note` 为空，`origin=manual`、`merged_into=null`），不回填或改写历史快照；这些准备列本轮不代表已提供厂家／批次备注的前端或 Excel 录入。0.9.4 不能恢复 schema 6；旧程序在已升级库导出的带新列 schema 5 混合格式也不属于严格旧格式兼容范围。需回退时恢复升级前的数据库及配套完整运行数据，不能只切旧镜像。

状态键只接受 `opening_closed` 与 `restored_once`，值只接受 `0|1`。存在任何合格验收历史（含已整笔冲正）时 `opening_closed` 必须为 `1`，恢复不能重开已关闭的期初。

`backup(user)`、`restore(payload,user)` 均返回 Promise；备份在事务锁内一致读取，恢复完整校验并事务写入，调用方必须等待提交成功后再响应。根层通用台账/系统备份明确排除新版物资，物资须使用专用备份；组合包不会被旧恢复静默忽略。单个 JSON 最多25 MiB、附件原始总量最多20 MiB，超过时拒绝生成无法在线恢复的包。业务备份不是 PostgreSQL、附件及部署秘密文件的灾备替代，部署级备份按 [群晖说明](SYNOLOGY.md)停服完整保存，不在线复制正在写入的 PostgreSQL 目录。

## 历史：BarTender打印与预览（0.9.0已撤除）

网页接口要求登录及`materials.read`；模板维护另需ADMIN/MATERIAL及信息库维护权限，打印站维护需`permissions.write`。普通人员仅能读写自己的任务，管理人员按打印权限查看全部。模板／任务／打印站随完整PostgreSQL备份，不加入上述物资JSON恢复。

- `GET /config`返回模板元数据、打印站、管理能力，以及站点助手版本、最后通信与`connectionStatus`；60秒内联系显示online，仅代表通信。
- `GET /agent-script`、`GET /agent-launcher`分别鉴权下载同版PS1和CMD，两个文件保存在同一固定目录；安装与后台使用见[助手指南](BARTENDER_AGENT.md)。
- `POST /jobs`接受`{stationId,templateId,unitIds,idempotencyKey,reason?,reprintOf?,kind?,paper?}`。默认kind为print、paper为null沿用BTW；preview仅1件且不可重印或人工确认出纸。paper为`{widthMm,heightMm,orientation}`，数值5–300mm且最多3位小数，portrait要求宽≤高、landscape要求宽≥高。旧请求默认摘要保持不变；显式纸张、类型纳入幂等摘要及快照，重印保持原纸张与原完整数据。
- `GET /jobs`分页列表含kind/paper/hasPreview，不返回图片；`GET /jobs/:id`另返回首件数据及仅授权可见的`previewBase64`。PNG绑定生成时快照，不表示物理出纸或驱动预览。
- Windows站点Bearer接口仍以`POST /agent/claim {agentVersion}`领取；队头为preview或有paper覆盖时，低于0.8.1或不合法版本不能领取，也不能越过它领取后续任务。启动、租约、回执恢复和不自动重印规则沿用0.8.0。
- `POST /agent/jobs/:id/result`在preview且submitted时必填`previewBase64`，仅接受规范PNG、最大2MiB、IHDR边长最多4096；其他任务或失败状态不接受图片。回执幂等比较包含图片，不允许同一结果被换图；请求不接受任意打印内容、份数、路径或XML。

原生模板图由Windows的ExportToFile生成，预览不调用Print；原生对象重排和打印介质校准仍在Designer进行。网页标签JSON模板与BTW为两条独立路径，纸张设置不互相覆盖。
