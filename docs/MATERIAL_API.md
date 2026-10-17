# 0.3.0 物资 API 合同

实现入口：`createMaterials({db, body, send, fail, log, hasPermission, tokenUser, uploads, writeXlsx})`，返回 `{handle, backup, restore}`。`handle(req,res,url,user)` 处理 `/api/materials` 并返回 `true`，其他路径返回 `false`。新业务只使用专表，不写旧 `records`。以下合同供前端与 HTTP 回归共同使用。

所有接口需要登录。错误为 `{error, code?}`；400 输入错误，403 无权，404 不存在，409 版本/状态/幂等冲突。`quantity`、`amount` 写入必须是非指数十进制**字符串**，最多三位/两位小数；读取为整数 `qtyM`、`amountCents`。金额无权限时所有响应、历史快照均省略金额字段。

列表统一 `{items,total,page,pageSize}`，查询 `page` 默认 1、`pageSize` 默认 50，最大 200，`q` 搜索。ID 为正整数。仓库代码由 meta 返回。区域、分类是管理员维护的稳定 ID；库存合并键为物资 ID + 仓库代码 + 区域 ID。

## 元数据与字典

- `GET /api/materials/meta` → `{capabilities,warehouses,openingClosed,quantityScale:1000,amountScale:100}`。
- capabilities：`manageCategories,manageRegions,manageCatalog,createRequest,submitRequest,editSubmitted,receive,closeReceipt,reverseReceipt,initialize,adjustStock,viewAmount,export,backup,restore,legacyRead`。
- warehouses 固定为 `{code,name}`：`MAIN` 默认仓库、`REAGENT` 试剂库、`CONSUMABLE` 耗材库、`SPARE` 备用库。
- `GET /categories`、`GET /regions` → 分页；行 `{id,name,createdBy,createdAt}`。
- `POST /categories`、`POST /regions`，正文 `{name}` → 201 创建行。ADMIN 或 MATERIAL + 对应动作权限；首期只新增，不删历史选项。
- `GET /catalog` → 分页；支持 `categoryId`。行 `{id,code,name,spec,unit,categoryId,categoryName,version}`。
- `POST /catalog`，正文 `{code,name,spec,unit,categoryId}` → 201 主档；ADMIN/MATERIAL + `materials.catalog.write`。编码唯一，已有编码不能改规格/单位。

下文省略共同前缀 `/api/materials`。

## 申报与修订

- `GET /requests`，可选 `status=draft|submitted`、`from,to` → SQL 筛选与分页摘要；`q` 覆盖单号、标题、创建人、明细名称/编码/规格、分类与区域。
- `POST /requests`，`{title,description?}` → 201 完整单据。所有登录用户可建单。
- `GET /requests/:id` → 完整单据。
- `PATCH /requests/:id`，`{requestVersion,title?,description?,reason?}` → 完整单据。
- `POST /requests/:id/items`，`{requestVersion,catalogId?,code?,name?,spec?,unit?,categoryId,regionId,warehouse,quantity,purpose?}` → 201 完整单据。
- `PATCH /requests/:id/items/:itemId`，`{requestVersion,version,...待改行字段,reason?}` → 完整单据。
- `DELETE /requests/:id/items/:itemId`，`{requestVersion,version}` → 完整单据，仅草稿。
- `POST /requests/:id/submit`，`{requestVersion}` → 完整单据。仅 MATERIAL + submit 权限；非空、所有行主档已匹配才能提交。
- `GET /requests/:id/revisions` → `{originalSnapshot,revisions:[{id,revision,reason,actorId,actorName,createdAt,before,after}]}`；提交版 revision=1，修订从 2 起。

单据含 `{id,no,title,description,status,createdBy,creatorName,createdAt,submittedBy,submittedAt,version,revision,canEditHeader,canAddItem,canSubmit,items}`。摘要保留表头与操作能力，另含 `itemCount,progress:{pendingItems}`，不附 `items` 或附件；完整内容通过详情接口读取。

明细含 `{id,requestId,catalogId,code,name,spec,unit,categoryId,categoryName,regionId,regionName,warehouse,qtyM,purpose,authorId,authorName,version,identityLocked,acceptedQtyM,closedQtyM,remainingQtyM,receiptStatus,canEdit,canDelete}`。`receiptStatus` 为 `pending|partial|done|closed`；identityLocked 表示存在任何历史验收/拒收/结案事件，冲正后也不解除身份保护。

未匹配主档的草稿行允许普通用户先填写名称/规格/单位，catalogId 可为空；提交前 MATERIAL/ADMIN 建主档，MATERIAL 将 catalogId 匹配到草稿行。有 catalogId 时名称/规格/单位由服务端主档确定。

草稿本人改本人行，MATERIAL 可改全部；仅创建者/MATERIAL 可改草稿表头。提交后仅 MATERIAL + `materials.request.edit_submitted` 可改表头/已有行，必须 reason；不能新增/删行。原提交快照不覆盖。已有任何验收/结案记录的行保护 catalogId/code/name/spec/unit/warehouse/regionId；qtyM 不得小于有效已验收+结案量。分类、用途、合法数量仍可修订。修改申报不改变库存。

`requestVersion` 为父单 `version`；行 `version` 为该行 token。所有内容或验收进度变化均递增对应 token；`revision` 仅在提交/提交后内容修订时变化。表单应保留打开时 token；409 后保留输入并要求重新读取，不能自动重试覆盖。唯一追加例外是草稿 POST items：要求有效 requestVersion，但不因其他人刚新增行导致版本陈旧而拒绝；事务内确认仍是草稿后追加，成功仍递增父版本，使旧提交预览失效。

## 验收、结案与冲正

- `GET /acceptance` → SQL 筛选与分页 `{...明细,requestNo,requestTitle,requestVersion,requestRevision,requestCreatedAt}`；仅已提交行；可用 `status=all|pending|partial|done|closed` 按 receiptStatus 筛选，`from,to` 按原申请创建日期筛选；`q` 覆盖名称/编码/规格、分类/区域及来源单号/标题。
- `GET /receipts?requestId=&itemId=` → 分页事件。事件含 `{id,type,requestId,itemId,requestRevision,snapshot,qtyM,rejectedQtyM,closedQtyM,amountCents?,reason,rejectedReason,originalReceiptId,batch,expiryDate,date,actorId,actorName,createdAt,reversed}`。type 为 `acceptance|rejection|close|reversal`。
- `POST /receipts`，`{requestId,itemId,requestVersion,version,requestIdempotencyKey,quantity,amount,rejectedQuantity?,rejectedReason?,zeroAmountReason?,batch?,expiryDate?,date?}` → 201 `{receipt,request}`。实际仓库/区域取当前已确认申报行；不接受前端改归属。合格+拒收不超过当前剩余量；拒收不抵扣后续允许合格量。合格量大于零但金额为零须原因；纯拒收使用 quantity=`"0"`、amount=`"0"`、rejectedQuantity>0，不入库且不关闭期初。只要拒收数量大于零，rejectedReason 必填。
- `POST /requests/:id/items/:itemId/close`，`{requestVersion,version,requestIdempotencyKey,reason}` → 201 `{receipt,request}`，将当时剩余量结案，不产生库存。
- `POST /receipts/:id/reverse`，`{requestVersion,version,requestIdempotencyKey,reason}` → 201 `{receipt,request}`。仅整笔冲正原合格验收，最多一次，数量金额精确反向，库存不能负数。

以上动作需要 MATERIAL + `materials.acceptance.write`。记账 `requestIdempotencyKey` 为 8–128 字符；同用户同键同正文返回原结果（200），同键不同正文 409。客户端每次真实操作产生新键，网络重试复用原键及原正文；不要与申报单 requestId 混淆。

## 库存与期初

- `GET /stock` → 分页 `{id:复合稳定字符串,catalogId,code,name,spec,unit,regionId,regionName,warehouse,qtyM,amountCents?,lastMovementAt}`，可筛选 `regionId,warehouse,catalogId`。
- `GET /stock/movements` → 分页 `{id,type,catalogId,regionId,warehouse,qtyM,amountCents?,sourceId,snapshot,batch,expiryDate,actorId,actorName,createdAt}`，支持上述筛选。type 为 `opening|receipt|reversal|adjustment`。
- `POST /stock/opening`，`{catalogId,categoryId?,regionId,warehouse,quantity,amount,zeroAmountReason?,batch?,expiryDate?,date?,requestIdempotencyKey}` → 201 `{movement,openingClosed}`，需要 MATERIAL + initialize 权限。
- `POST /stock/opening/close`，`{reason}` → `{openingClosed:true}`；MATERIAL + initialize，永久关闭期初。首次合格验收入库也原子关闭期初。
- `POST /stock/adjustments`，`{catalogId,regionId,warehouse,quantity,amount,direction:'increase'|'decrease',reason,requestIdempotencyKey,batch?,expiryDate?}` → 201 `{movement}`；MATERIAL + adjust，数量金额为正数，direction 决定符号；批次余额与总余额均不能负数。

## 附件

- `GET /requests/:id/attachments` → `{items:[{id,name,mimeType,size,parentType,parentId,createdAt}]}`。
- `POST /requests/:id/attachments`，`{requestVersion,name,mimeType,content:base64,reason?}` → 201 `{attachment,request}`。草稿创建者或 MATERIAL；提交后 MATERIAL + editSubmitted + 原因，纳入修订快照。
- `POST /receipts/:id/attachments`，`{name,mimeType,content,reason}` → 201 `{attachment}`；MATERIAL + acceptance.write。验收附件追加，不能覆写已记账事实。
- `GET /receipts/:id/attachments` → `{items:[附件元数据]}`，另需金额读取权限。
- `GET /attachments/:id/download` → 原附件；验收附件另需金额读取权限，避免通过单据扫描件泄漏金额。
- `DELETE /attachments/:id`，`{requestVersion,reason?}` → `{request}`，仅申报附件可受控移除；旧文件为历史保留，不物理删。

单个文件最大 5 MiB；只接收合法 base64、文件名和 MIME，实际存储使用随机名，禁止路径穿越；新附件与旧 files 完全分开。

## Excel 与业务备份

- `GET /export.xlsx?type=requests|stock&requestId=&from=&to=&status=&version=current|original` → 真正 XLSX；需要 `materials.export`，金额列另看 amount 权限。用户文本按文本单元格写，不识别公式。原版/当前明细完整导出；修订记录的“修改前/后快照摘要”单元格最多32767字符，超长时明确加注“完整快照见修订历史/物资备份”，完整历史仍保留于系统及业务备份。
- `GET /backup` → 完整业务 JSON，需 backup.read + materials.amount.read。包含八表、附件/状态/幂等、稳定用户映射与所有快照，不含用户密码。
- `POST /restore`，正文为上述完整备份对象 → `{restored:true,counts}`，需 backup.restore + materials.amount.read；只允许空的新业务库，验证格式、用户 username→当前ID 映射、外键、库存及来源唯一性，事务恢复；同份重放与追加恢复均拒绝。

物资备份严格限定顶层字段为 `type,schemaVersion,generatedAt,users,data,files`；`type=labos-materials-backup`、`schemaVersion=1`，生成时间为完整 ISO UTC 时间。用户映射仅 `{id,username}`，附件内容仅 `{id,content,sha256}`。未知顶层字段（含其他 scope 或组合包字段）、未知表/字段、遗漏字段均拒绝，避免错误范围被静默忽略。

状态键只接受 `opening_closed` 与 `restored_once`，值只接受 `0|1`。存在任何合格验收历史（含已整笔冲正）时 `opening_closed` 必须为 `1`，恢复不能重开已关闭的期初。

`backup(user)` 返回与 GET 相同对象；`restore(payload,user)` 同步、独立事务恢复并返回结果，不能嵌入外层事务。根层通用台账/系统备份明确排除新版物资，物资须使用专用备份；组合包不会被旧恢复静默忽略。单个JSON最多25 MiB、附件原始总量最多20 MiB，超过时拒绝生成无法在线恢复的包，并提示停服备份完整运行目录。业务备份不是整个运行目录的灾备替代。
