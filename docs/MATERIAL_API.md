# 0.3.2 物资 API 合同（源码开发版，未发布镜像）

实现入口：`createMaterials({db, body, send, fail, log, hasPermission, tokenUser, uploads, writeXlsx})`，返回 `{handle, backup, restore}`。`handle(req,res,url,user)` 处理 `/api/materials` 并返回 `true`，其他路径返回 `false`。新业务只使用专表，不写旧 `records`。以下合同供前端与 HTTP 回归共同使用。

所有接口需要登录。错误为 `{error, code?}`；400 输入错误，403 无权，404 不存在，409 版本/状态/幂等冲突。`quantity`、`amount` 写入必须是非指数十进制**字符串**，最多三位/两位小数；读取为整数 `qtyM`、`amountCents`。金额无权限时所有响应、历史快照均省略金额字段。

列表统一 `{items,total,page,pageSize}`，查询 `page` 默认 1、`pageSize` 默认 50，最大 200，`q` 搜索。ID 为正整数。仓库代码由 meta 返回。区域、分类是管理员维护的稳定 ID；库存合并键为物资 ID + 仓库代码 + 区域 ID。

## 元数据与字典

- `GET /api/materials/meta` → `{capabilities,warehouses,openingClosed,quantityScale:1000,amountScale:100}`。
- capabilities：`manageCategories,manageRegions,manageCatalog,createRequest,submitRequest,editSubmitted,receive,closeReceipt,reverseReceipt,initialize,adjustStock,viewAmount,export,backup,restore,legacyRead,createIssue,manageLocation,issueStock,viewAllIssues`。
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
- `POST /requests/:id/submit`，`{requestVersion}` → 完整单据。仅 MATERIAL + submit 权限；至少一条有效明细，允许 catalogId 为空；无主档不阻断提交。
- `GET /requests/:id/revisions` → `{originalSnapshot,revisions:[{id,revision,reason,actorId,actorName,createdAt,before,after}]}`；提交版 revision=1，修订从 2 起。

单据含 `{id,no,title,description,status,createdBy,creatorName,createdAt,submittedBy,submittedAt,version,revision,canEditHeader,canAddItem,canSubmit,items}`。摘要保留表头与操作能力，另含 `itemCount,progress:{pendingItems}`，不附 `items` 或附件；完整内容通过详情接口读取。

明细含 `{id,requestId,catalogId,code,name,spec,unit,categoryId,categoryName,regionId,regionName,warehouse,qtyM,purpose,authorId,authorName,version,identityLocked,acceptedQtyM,closedQtyM,remainingQtyM,receiptStatus,canEdit,canDelete}`。`receiptStatus` 为 `pending|partial|done|closed`；identityLocked 表示存在任何历史验收/拒收/结案事件，冲正后也不解除身份保护。

未匹配主档的草稿行允许普通用户先填写名称/规格/单位，catalogId 可为空；0.3.1 起允许先提交；验收、拒收或结案前由 MATERIAL/ADMIN 维护主档，再由 MATERIAL 在原单受控修订中匹配 catalogId 并说明原因。0.3.0 的提交前匹配限制由此替代。有 catalogId 时名称/规格/单位由服务端主档确定。

草稿本人改本人行，MATERIAL 可改全部；仅创建者/MATERIAL 可改草稿表头。提交后仅 MATERIAL + `materials.request.edit_submitted` 可改表头/已有行，必须 reason；不能新增/删行。原提交快照不覆盖。已有任何验收/结案记录的行保护 catalogId/code/name/spec/unit/warehouse/regionId；qtyM 不得小于有效已验收+结案量。分类、用途、合法数量仍可修订。修改申报不改变库存。

`requestVersion` 为父单 `version`；行 `version` 为该行 token。所有内容或验收进度变化均递增对应 token；`revision` 仅在提交/提交后内容修订时变化。表单应保留打开时 token；409 后保留输入并要求重新读取，不能自动重试覆盖。唯一追加例外是草稿 POST items：要求有效 requestVersion，但不因其他人刚新增行导致版本陈旧而拒绝；事务内确认仍是草稿后追加，成功仍递增父版本，使旧提交预览失效。

## 验收、结案与冲正

- `GET /acceptance` → SQL 筛选与分页 `{...明细,requestNo,requestTitle,requestVersion,requestRevision,requestCreatedAt}`；仅已提交行；可用 `status=all|pending|partial|done|closed` 按 receiptStatus 筛选，`from,to` 按原申请创建日期筛选；`q` 覆盖名称/编码/规格、分类/区域及来源单号/标题。
- `GET /receipts?requestId=&itemId=` → 分页事件。事件含 `{id,type,requestId,itemId,requestRevision,snapshot,qtyM,rejectedQtyM,closedQtyM,amountCents?,reason,rejectedReason,zeroAmountReason,originalReceiptId,batch,expiryDate,date,actorId,actorName,createdAt,reversed}`。type 为 `acceptance|rejection|close|reversal`。
- `POST /receipts`，`{requestId,itemId,requestVersion,version,requestIdempotencyKey,quantity,amount,rejectedQuantity?,rejectedReason?,zeroAmountReason?,batch?,expiryDate?,date?}` → 201 `{receipt,request}`。实际仓库/区域取当前已确认申报行；不接受前端改归属。合格+拒收不超过当前剩余量；拒收不抵扣后续允许合格量。合格量大于零但金额为零须原因；纯拒收使用 quantity=`"0"`、amount=`"0"`、rejectedQuantity>0，不入库且不关闭期初。只要拒收数量大于零，rejectedReason 必填。
- `POST /requests/:id/items/:itemId/close`，`{requestVersion,version,requestIdempotencyKey,reason}` → 201 `{receipt,request}`，将当时剩余量结案，不产生库存。
- `POST /receipts/:id/reverse`，`{requestVersion,version,requestIdempotencyKey,reason}` → 201 `{receipt,request}`。仅整笔冲正原合格验收，最多一次，数量金额精确反向，库存不能负数。

验收、纯拒收及结案均须当前行已匹配主档，未匹配返回 409 且不产生事件、库存或身份锁定；页面提示从“原单 → 修订”完成匹配。原提交快照中的 null 主档保持原样。

以上动作需要 MATERIAL + `materials.acceptance.write`。记账 `requestIdempotencyKey` 为 8–128 字符；同用户同键同正文返回原结果（200），同键不同正文 409。客户端每次真实操作产生新键，网络重试复用原键及原正文；不要与申报单 requestId 混淆。

## 库存与期初

- `GET /stock` → 分页 `{id:复合稳定字符串,catalogId,code,name,spec,unit,regionId,regionName,warehouse,qtyM,amountCents?,lastMovementAt}`，可筛选 `regionId,warehouse,catalogId`。
- `GET /stock/batches` → 分页的批次余额，保留 `/stock` 身份、数量及金额字段，另含 `batch,expiryDate,categoryId,categoryName,location,locationVersion`。按主档+仓库+区域+批号+有效期汇总；支持 `q,catalogId,regionId,warehouse,batch,expiryDate` 筛选，耗尽批次仍保留，未设置位置为 `""`、版本为 `0`。
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

- `GET /export.xlsx?type=requests|stock|issues` → 真正 XLSX；需要 `materials.export`，金额列另看 amount 权限。`type` 省略时默认 `requests`。申报导出支持 `q,from,to,status=draft|submitted,requestId,version=current|original`，日期按申报创建日期筛选，筛选命中的单据包含全部明细；`version` 默认 current，original 先按当前单据筛选，再使用原提交快照，未提交草稿仍用当前内容。库存导出支持 `q,regionId,warehouse,catalogId`，含库存汇总及按相同条件筛选的批次库存、存放位置。领用导出支持 `q,status` 并遵守本人/管理员可见范围，含申请时位置和当前位置或发放时位置；未发放金额留空。导出全部筛选结果，不受列表页码限制；一次最多 1000 张申报单，明细、验收流水和修订记录各不超过 5000 条；库存、批次或领用各最多 5000 条，超限返回 413。
- 页面申报列表导出沿用已查询的 `q,status,from,to`，库存列表沿用 `q,regionId,warehouse`，领用列表沿用 `q,status`；单据详情按 `requestId,version` 导出，不携带列表筛选。验收列表不提供按验收进度导出，通过每行“原单”进入来源申报后导出；`pending|partial|done|closed` 不是申报导出的 status 值。
- 用户文本按文本单元格写，不识别公式。原版/当前申报明细完整导出；验收流水及修订记录仍保留所选单据的完整历史。修订记录的“修改前/后快照摘要”单元格最多32767字符，超长时明确加注“完整快照见修订历史/物资备份”，完整历史仍保留于系统及业务备份。
- `GET /backup` → 完整业务 JSON，需 backup.read + materials.amount.read。包含十三张物资业务及辅助表（含存放位置、领用）、附件内容、稳定用户映射与所有快照，不含用户密码。
- `POST /restore`，正文为上述完整备份对象 → `{restored:true,counts}`，需 backup.restore + materials.amount.read；只允许空的新业务库，验证格式、用户 username→当前ID 映射、外键、库存及来源唯一性，事务恢复；同份重放与追加恢复均拒绝。

物资备份严格限定顶层字段为 `type,schemaVersion,generatedAt,users,data,files`；`type=labos-materials-backup`、新导出 `schemaVersion=2`，生成时间为完整 ISO UTC 时间。支持恢复 schema 1 的原十一表备份，两个新表按空数据补齐；schema 1 不能夹带新增表，schema 2 不能遗漏新表。用户映射仅 `{id,username}`，附件内容仅 `{id,content,sha256}`。未知顶层字段（含其他 scope 或组合包字段）、未知表/字段、遗漏字段均拒绝，避免错误范围被静默忽略。领用处理人及快照同样按 username 映射现有用户。

schema 2 恢复还逐项核对领用状态/版本、申请与发放流水一一对应、历史批次成本分摊、取消/驳回无流水、位置有对应批次和非负库存。旧服务不能恢复 schema 2；升级会扩展库存流水 CHECK 并新增表，回退必须恢复升级前完整运行数据，不能只切旧镜像。

状态键只接受 `opening_closed` 与 `restored_once`，值只接受 `0|1`。存在任何合格验收历史（含已整笔冲正）时 `opening_closed` 必须为 `1`，恢复不能重开已关闭的期初。

`backup(user)` 返回与 GET 相同对象；`restore(payload,user)` 同步、独立事务恢复并返回结果，不能嵌入外层事务。根层通用台账/系统备份明确排除新版物资，物资须使用专用备份；组合包不会被旧恢复静默忽略。单个JSON最多25 MiB、附件原始总量最多20 MiB，超过时拒绝生成无法在线恢复的包，并提示停服备份完整运行目录。业务备份不是整个运行目录的灾备替代。
