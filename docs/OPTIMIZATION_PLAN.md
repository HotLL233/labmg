# LabOS 优化方案（0.9.4 基线）

分析日期：2026-10-22。基线为已公开 `0.9.4`／`28ce719`，`package.json` 版本 0.9.4。
**范围声明**：本次只做源码静态分析与结构核对，未运行压测、未连接 NAS、未读写生产库、未执行任何改动。文中所有"当前"均指源码字面行为，不是运行期观测值；性能结论需要 P0 阶段实测后确认。

---

## 一、当前运行逻辑（事实）

### 1.1 一次请求的完整链路

| 步骤 | 代码位置 | 行为 |
| --- | --- | --- |
| 1 | `src/server.js:219` | 单入口 `http.createServer`；`/api/` 前缀进 API，其余当静态文件，`startsWith(PUBLIC)` 做目录穿越防护 |
| 2 | 同上 | 写请求（非 GET/HEAD，或 logout）先 `await body(req)` 读完 JSON，再开事务 |
| 3 | `src/server.js:219` | `pendingResponses`/`commitTasks` 两个 WeakMap 接管响应：处理器调用 `send()` 时不真正写 socket，只存 `{status,obj}` |
| 4 | `src/server.js:121` | 物资模块先交给 `materials.handle()`；返回 `true` 即终止，否则继续主路由 |
| 5 | `src/database.js:133-152` | `db.transaction()` 取连接 → `BEGIN` → **`pg_advisory_xact_lock(1280262703,600)` 全局写锁** → 执行 → `COMMIT` |
| 6 | `src/server.js:219` | 提交成功后才 `send()` 真正响应；失败则回滚 + 清 Cookie + 抛错；`afterCommit` 回调（删附件实体）在提交后跑 |
| 7 | `src/server.js:184,204` | 事务内写文件的场景登记 `db.afterRollback()`，回滚时删掉已落盘的文件 |

这套"先提交、后响应"的设计是对的：客户端拿到 200 时数据必定已落库，避免了"响应成功但事务回滚"的经典不一致。物资模块的 `material_idempotency` 表（`schema.js:178`）在此基础上再做请求级幂等，方向正确。

### 1.2 分层与体量

| 文件 | 行数 | 职责 | 形态 |
| --- | --- | --- | --- |
| `src/server.js` | 224 | 全部通用 API（认证、用户、记录、附件、导出备份、审计、UI 配置）+ 静态服务 | 36 处内联 `if (pathname===...)`，平均行长 239 字符，46 行超 400 字符，最长 1606 |
| `src/materials.js` | 2120 | 物资全流程（申报/验收/库存/领用/期初/条码/标签/备份恢复） | 94 个具名函数，`dispatch()` 单函数约 600 行 |
| `src/database.js` | 193 | SQLite 方言 → PostgreSQL 适配层 | `?`→`$n`、`INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`、INSERT 自动补 `RETURNING id` |
| `src/schema.js` | 254 | 27 张表 DDL + 兼容函数 `instr/json_extract/labos_date` + 1 个触发器 | `CREATE TABLE IF NOT EXISTS` 幂等建表 |
| `src/public/material.js` | 360 | 物资整个前端（IIFE） | 117 KB，平均行长 275，67 行超 400 字符，最长 3428 |
| `src/public/app.js` | 132 | 通用页面/工作台 | 全局 `let current, items, ...`，靠脚本顺序共享状态 |
| `tests/*.test.js` | 19 文件 | 215 个 `test()` | Node 内置 test runner，前端用 VM + 伪 DOM |

### 1.3 数据模型的两套并行结构

- **通用台账**：`records` 单表 + `data TEXT(JSON)`，模块、分区、档案角色范围都压在 JSON 和 `sectionOfRecord()` 映射里（`server.js:77-91`）。
- **物资专用**：20+ 张强类型表，数量走 `qty_m`（千分位整数）、金额走 `amount_cents`（分），`material_stock_movements` 已有不可变账本语义（`source_key` 唯一）。
- 结果：**同一个"物资"概念有两套金额表示**——`records.amount` 是 `DOUBLE PRECISION` 浮点（`schema.js:65`），物资表是整数分。旧台账已降级为只读（`materials.js:48` 的 legacy 分支），但浮点字段仍留在库里。

---

## 二、问题清单（按影响排序）

| 编号 | 问题 | 证据 | 影响 | 触发条件 |
| --- | --- | --- | --- | --- |
| **P1** | 热表零索引 | `schema.js` 中 14 条索引全在 `material_*`／`printing_*`；`records`／`audit_logs`／`files`／`sessions` 一条没有 | 记录列表、审计列表、附件列表、会话校验全部顺序扫描；数据一多就是全表扫 + 排序 | 立即，随记录数增长线性恶化 |
| **P2** | 日期条件被函数包裹，索引用不上 | `server.js:98,175,211` 用 `labos_date(created_at)>=labos_date(?)` | 即使补了索引也是函数索引或失效 | 立即 |
| **P3** | 传输不压缩、无缓存 | `src/https-config.js:68-72` 生成的 Caddyfile 只有 `reverse_proxy`，**没有 `encode`**；`server.js:219` 静态响应只有 `Content-Type`，无 ETag/Last-Modified/Cache-Control | 首屏要下 `material.js` 117KB + 各模块脚本约 250KB，未压缩、每次都全量重下 | 每次打开页面 |
| **P4** | 列表接口无上限 + 内存分页 | `server.js:98` `queryRecords` 无 LIMIT；`server.js:175` 记录列表无 LIMIT；`materials.js:361-368` `search()/paginate()` 先全量取出再 `slice`；`materials.js:1028` 期初列表对**每条**单据调 `openingView()` | 内存与响应体随数据量线性膨胀，超出"10–30 人"以外的任何增长都先撞这里 | 记录上千后 |
| **P5** | N+1 查询，且全部串行 | `materials.js:309` 逐条 `itemView()`；`itemView:299` 每条明细再查一次 `catalog()`；`materials.js:938,1028,1211,1458` 都是 `mapRows` 串行 `await`；全仓库 `Promise.all` 出现 **0 次** | 20 行明细的申报单 ≈ 25 次往返；期初列表 N 单 × 9 查询。单次不慢，但延迟随行数线性增长 | 明细多、单据多时 |
| **P6** | 每条 SQL 都重新编译 | `database.js:117-118` `prepare()` 里 `compileSql()` 被调用两次（`compiled` + `runSql`），而 `prepare()` 在**每个请求里**重新执行 | 每次查询跑一遍手写词法器（`sqlTokens`），纯 CPU 浪费；且 `prepare` 的语义名不副实 | 每个请求 |
| **P7** | 认证快路径偏重 | `server.js:63` 每请求 1 次 JOIN 查会话+用户；`server.js:69` 再按角色逐个查 `role_permissions` 并 `JSON.parse` | 10–30 人场景可接受，但每次轮询页面都多 2–3 次往返 | 每次登录态请求 |
| **P8** | 登录无任何限速 | `server.js:111-118` 只有密码校验；全仓无失败计数、无 IP/账号节流 | 局域网内暴力破解无成本；密码策略只要求 8 位 | 暴露到内网/端口映射后 |
| **P9** | 会话强度不足 | `server.js:64` Cookie 只有 `HttpOnly; SameSite=Lax`，**无 `Secure`**；24h 固定、登录不轮换 token；`sessions` 表只在退出/改密时删除，无过期清理；token 明文入库 | 库泄露=会话可劫持；无空闲超时 | 部署在 HTTPS 之后时 |
| **P10** | 无安全响应头 | `server.js:58,219` 只写 `Content-Type` | 全站 `innerHTML` 渲染配合缺失的 CSP，XSS 无第二道防线 | 任何注入点 |
| **P11** | schema 演进方式受限 | `schema.js` 全是 `CREATE TABLE IF NOT EXISTS`；改列只能靠 `schema_migrations` 手写补丁（现有 2 处，`server.js:37-42`） | 已有 NAS 库做列类型/约束变更时无脚本、无回滚、无版本序 | 下一次改表 |
| **P12** | 前端无模块化 | `index.html` 12 个 `<script>` 顺序加载；`app.js:3` 全局 `let current, items...`，`material.js` 靠 `typeof current!=='undefined'` 猜上下文；`material.js` 单行最长 3428 字符 | 改一处要跨文件搜全局；已知问题"大量长行、重复声明、全局覆盖"仍未解决（`docs/MEMORY.md:566`） | 每次改前端 |
| **P13** | 全局写锁 | `database.js:140` `pg_advisory_xact_lock` 让所有写事务串行 | 当前规模够用（注释也写明"测得争用后再收窄"），但写吞吐上限 = 1 | 批量导入/多人同时保存 |
| **P14** | 金额双表示 | `records.amount` 浮点 + 物资 `amount_cents` 整数 | 统计页与物资页口径可能对不上；浮点累加有误差 | 旧台账参与统计时 |

**没有发现的问题**（避免误判）：前端 `esc()/h()` 转义在各处都有用；`material.js` 的 `shell()` 包在 IIFE 内，与 `app.js` 的全局 `shell()` **不冲突**；`compileSql` 有完整的字符串/注释/美元引号处理，不是简单正则替换。这几处质量高于一般手写项目。

---

## 三、开源对照（借鉴什么、能借多少）

许可列只标已核实项；**任何新增依赖必须先走 `docs/THIRD_PARTY.md` 的许可核验流程**，AGPL/GPL 项目只能借鉴设计，不得复制代码。

| 领域 | 参考项目 | 可借鉴点 | 许可 | 是否引入 |
| --- | --- | --- | --- | --- |
| 库存/验收 | [InvenTree](https://github.com/inventree/InvenTree) | 批次+库位模型、收货→库存流水、条码/标签走独立于业务表的模板体系；与现 `material_stock_movements` 设计同源，可直接对照缺口 | MIT（见 `docs/research/MATERIAL_OPEN_SOURCE.md`） | 只对照，不引入 |
| 库存账本 | [ERPNext](https://github.com/frappe/erpnext) | 不可变库存账本 + 反向流水（reversal）语义，现 `material_receipts` 的 `CHECK(type='reversal' AND qty_m<0)` 已是同思路 | GPL-3.0 | 只对照 |
| 资产全生命周期 | Snipe-IT | `assets` 模块的"申购→验收→建档→校准→报废"状态机可对齐其审计字段设计 | AGPL-3.0 | 只对照 |
| LIMS 审计追踪 | SENAITE / OpenELIS | ALCOA+ 审计字段（谁/何时/为何/原值）、记录不可删只作废；现 `audit_logs` 缺"原值/新值"与"原因" | GPL 系 | 只对照 |
| 路由 | `find-my-way`（Fastify 内核） | 声明式路由表 + 参数正则 + 每路由钩子，替换 36 处内联 `if`；体积小、无传递依赖 | MIT（引入前核验） | **建议 P2 引入** |
| 迁移 | `node-pg-migrate` | 带版本序、可回滚的 SQL 迁移，替换手写 `schema_migrations` 补丁 | MIT（引入前核验） | **建议 P1 引入**（或自写 20 行 runner） |
| 批量取数 | `dataloader` | 请求级 batch+缓存模式，消灭 `itemView` 的逐条 `catalog()` | MIT | 只借模式，不必引入 |
| 校验 | `zod` / `ajv` | 现 `text()/integer()` 已集中且带中文报错，收益有限 | MIT | **不建议**（见第五节） |
| 安全头 | `helmet` | 只需 4 个头（CSP/nosniff/Referrer-Policy/Frame-Options），手写 6 行即可 | MIT | 不引入，手写 |
| 限速 | `rate-limiter-flexible` | 令牌桶；登录按 `账号+IP` 双键 | ISC（引入前核验） | 可选，也可手写 Map |
| 观测 | `pg_stat_statements` | PostgreSQL 官方扩展，直接给出慢查询与调用次数，零代码改动 | PostgreSQL License | **P0 立即启用** |
| 前端 | htmx / Preact+htm | 若将来要组件化 | BSD-2 / MIT | 不建议（见第五节） |

---

## 四、分阶段方案

### P0 先测，再改（无业务代码改动）

1. 数据库开 `pg_stat_statements`，拿 7 天真实分布：`records` 相关语句占比、`labos_date` 条件是否走全表。
2. 加一个 20 行的请求计时包装（`server.js` 顶部），把 `>100ms` 的路径、SQL 条数打到日志。
3. **验收证据**：`pg_stat_statements` 前 20 条 + 一份"请求→SQL 条数"基线表。没有这份数据，P13 的锁和 P5 的批量化都不该动。

### P1 低风险、收益确定（不新增运行时依赖）

| 项 | 改动点 | 风险 | 验收 |
| --- | --- | --- | --- |
| C1 索引 | `schema.js` 追加 `CREATE INDEX IF NOT EXISTS`：`records(module, COALESCE(deleted_at,''), created_at)`、`records(updated_at)`、`audit_logs(created_at)`、`files(record_id)`、`sessions(expires_at)` | 低（只增不删，启动幂等） | 万条 fixture 下 `EXPLAIN (ANALYZE, BUFFERS)` 前后对比，Seq Scan→Index Scan |
| C2 去函数包裹 | `server.js:98,175,211` 把 `labos_date(created_at)>=labos_date(?)` 换成参数先按 `YYYY-MM-DD` 校验后直接比较 `created_at>=?`（列本身是 `YYYY-MM-DD HH:MM:SS` 文本，字典序即时间序） | 中低（非法输入的容错要显式补 400） | 现有日期筛选测试 + 非法日期用例 |
| C3 压缩与缓存 | Caddyfile 模板加 `encode zstd gzip`；静态响应加 `ETag`（size+mtime 即可）与 `Cache-Control: no-cache`，命中返回 304；`/vendor/*` 用 `immutable` | 低 | 浏览器网络面板：首屏传输体积、二次访问 304 比例 |
| C4 SQL 编译缓存 | `database.js:117` 用 `Map` 缓存 `compileSql(sql)` 与 `returningId` 版本，键为原 SQL 串 | 低（纯函数，上限 500 条） | 回归 215 项不变；单请求 CPU 采样 |
| C5 认证快路径 | `server.js:69` 给 `role_permissions` 加进程内缓存（角色权限更新处失效），会话查询合并为一条带 `permissions` 的 JOIN | 中（单进程假设，多实例需发版号） | 权限变更后立即生效的回归用例 |
| C6 安全补丁 | 登录 Origin 校验（复用 `server.js:104` 的逻辑）；令牌哈希入库（`sha256`）；登录轮换会话；`Secure` cookie 按 `X-Forwarded-Proto` 或直连 TLS 自动加；启动时清理过期会话；加 CSP/nosniff/Referrer-Policy | 低 | 新增安全用例；现有登录/权限回归全绿 |
| C7 登录限速 | 按 `账号+IP` 令牌桶（进程内 Map，失败 5 次锁 5 分钟，成功清零），只挡 `/api/auth/login` | 低 | 连续失败用例 + 正常登录不受影响 |
| C8 迁移基建 | 引入 `node-pg-migrate` 或自写编号 SQL runner，把现有 2 处手写补丁迁进去 | 中（要兼容已上线的 NAS 库 schema_migrations 记录） | 空库建库 + 从 0.9.4 库原地升级两条路径都通过 |

**这一阶段约 80% 的收益来自 C1/C2/C3，且都不动业务逻辑。**

### P2 结构治理（每项独立分支、独立版本、独立回归）

| 项 | 内容 | 为什么现在做 |
| --- | --- | --- |
| S1 路由表化 | `server.js` 的 36 处 `if` 与 `materials.dispatch()` 的 600 行改成声明式表：`{method, path, permission, handler}`，配 `find-my-way` 或自写 40 行匹配器 | 现在想加"每路由计时/每路由权限"必须逐处改；表化后才能一次加钩子 |
| S2 批量取数 | 用 `IN (...)` 批量化 `itemView` 的 `catalog()`／`actorName()`；`mapRows` 在**只读**路径改并发（事务内仍串行，因为共用同一 client） | 直接消掉 P5 的线性延迟 |
| S3 列表服务端分页 | `queryRecords` 加 `limit/offset`，`/api/records` 与 `/openings` 改 SQL 分页；`search/paginate` 下沉到 WHERE | 消掉 P4，且是 P2 之后所有报表的前置 |
| S4 前端 ESM 化 | 12 个 `<script>` 改 `<script type="module">`，`material.js` 拆 `state/render/forms/scan`；顺手把超长行展开 | 见第五节：不引入框架，只做零依赖模块化 |
| S5 金额收敛 | 新增 `amount_cents` 列并回填，`records.amount` 标记 legacy 只读；统计口径统一到整数分 | 越晚做，历史数据越多 |

### P3 视 P0 数据决定（暂不排期）

- 全局写锁 → 按资源取锁（`pg_advisory_xact_lock(hashtextextended('catalog:'||id,0))`）或改条件更新 + 唯一约束兜底。
- 附件改流式 multipart（`busboy`），去掉 base64 的 1.33× 放大与整包驻留内存。
- 会话/审计表按时间分区。

---

## 五、明确不建议做的

| 想法 | 为什么不做 |
| --- | --- |
| 整体换 Fastify/Express + ORM（Prisma/Drizzle） | 会推翻"4 个直接依赖、无构建、可审计"这一交付特征；215 项测试几乎全要重写，发布门禁成本远大于收益。真正缺的只是路由表和批量取数，局部补即可 |
| 换 SQLite 或加 ORM 抽象层 | 现 `database.js` 适配层已经把方言差异集中在一个文件里，换掉不产生新能力 |
| 前端上 React/Vue + 构建链 | 页面是"表单+表格+打印"的强表单场景，构建链带来的复杂度大于组件化收益；ESM 拆分已能解决可维护性 |
| 引入 zod/ajv 全量替换手写校验 | 现 `text()/integer()` 已集中在 `materials.js:68-80`，中文报错规范；替换属纯风格迁移，风险大于收益。只在新增边界接口时按需用 |
| 在没有 `pg_stat_statements` 数据前动全局写锁 | 注释已写明"测得争用后再收窄"，现无争用证据；先删锁会引入难以复现的并发 bug |
| 直接把 AGPL/GPL 项目代码搬进来 | 违反 `docs/THIRD_PARTY.md` 的许可纪律 |

---

## 六、需要你定的三件事

1. **P1 是否单独发一个 `0.9.5`**（只含索引+压缩+缓存+安全补丁，业务零改动），还是攒到前端 ESM 化一起发？
2. **C8 迁移基建**用 `node-pg-migrate` 还是自写编号 SQL runner？前者多一个依赖但成熟，后者贴合现有零依赖风格。
3. **S5 金额收敛**是否纳入本版？会动 `records` 表结构和统计口径，属于"改数据表示"，需要单独评估旧台账历史值。

---

## 附：本次分析的边界

- 未执行任何测试，未启动服务，未连接数据库；上述"影响"均为源码推断，P0 完成后应据实测修订。
- 未做安全渗透，仅核对认证/会话/响应头的字面实现；不构成安全验收。
- 未核对 NAS 上 0.9.2 的实际运行状态。
