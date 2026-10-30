# 项目速查卡

> **开工只读这一页（约 80 行）。** 历史、决策、变更日志**不要通读**，需要时用 grep 定位关键词。
> `docs/MEMORY.md`（938 行 / 10.4 万字符）、`docs/HISTORY.md`（1041 行 / 11.7 万字符）、`docs/DEVELOPMENT.md`（650 行 / 5.8 万字符）**都不是启动必读**。

## 1. 这是什么

LabOS —— 实验室样品与物资管理系统，本地部署。

- 后端：Node 原生 `http.createServer` + 自写路由，**无框架**。入口 `src/server.js`。
- 数据库：PostgreSQL。`src/database.js` 是把 SQL 方言翻译成 PG 的适配层。
- 前端：原生 JS，**无构建步骤**，`index.html` 里顺序加载 14 个 `<script>` 和 8 个 `<link>`。
- 版本号：看 `package.json`，不要猜。

## 2. 命令（只用这几条）

| 命令 | 用途 | 依赖 | 耗时 |
| --- | --- | --- | --- |
| `npm run check` | 全部 JS 语法检查 | 无 | 秒级 |
| `npm run verify` | check + UI 审计，**交付前必跑** | 无 | 秒级 |
| `npm run verify:strict` | 同上 + 严格模式（目标是否达成） | 无 | 秒级 |
| `npm run dev` | 本地开发（`--watch`） | 需 PG 在跑 | 常驻 |
| `npm test` | 全量测试 | **需 `LABOS_TEST_DATABASE_URL`** | 分钟级 |

**`npm test` 没有 `LABOS_TEST_DATABASE_URL` 会 78 项失败**，那是环境缺变量，不是代码坏。没有这个变量就别跑，也不要在报告里写"测试通过"。

## 3. 文件地图（找东西先看这张表，不要全目录搜）

| 想改什么 | 去哪个文件 |
| --- | --- |
| HTTP 路由、接口 | `src/server.js` |
| 建表、字段 | `src/schema.js`、`migrations/` |
| SQL 方言适配、事务、加锁 | `src/database.js` |
| 物资业务（主档/库存/领用/退库） | `src/materials.js`、`src/material-lab.js` |
| 物资 Excel 导入导出 | `src/material-xlsx.js` |
| 页面切换、工作台、全局状态 | `src/public/app.js` |
| 共享组件（抽屉、分页、记录表、空态） | `src/public/workspace.js` |
| 档案 | `src/public/archive.js` |
| 委托单位 / 合同 | `src/public/contract.js` |
| 物资申报 / 验收 / 扫码 / 打印标签 | `src/public/material*.js` |
| 设备与资产 | `src/public/asset.js` |
| 审计日志 | `src/public/audit.js` |
| 体系文件 / 质量 | `src/public/quality.js` |
| 权限、用户、角色 | `src/public/permission.js` |
| 日期筛选、数据面板 | `src/public/datahub.js` |

## 4. CSS 覆盖链（本项目最容易踩的坑）

加载顺序，**后面的覆盖前面的**：

```
styles.css → material.css → material-scan.css → tokens.css
→ responsive.css → workspace.css → module-workspace.css → material-original.css
```

- 改样式**一律往后面追加**（`tokens.css` / `responsive.css` / `workspace.css` / `module-workspace.css` / `material-original.css`），不要在早期文件里改。
- 改完看不到效果 → 大概率是被后面某个文件盖了，先查这条链，别急着改第二遍。

**压缩文件**（一行几千字符，edit 必然匹配失败并反复重试）：

| 文件 | 行数 | 最长行字符 | 能否改 |
| --- | --- | --- | --- |
| `src/public/styles.css` | 99 | **5,371** | 禁止（改覆盖层） |
| `src/public/asset.css` | 1 | 2,057 | 禁止（改覆盖层） |
| `src/public/material-scan.css` | 1 | 1,833 | 禁止（改覆盖层） |
| `src/public/material.css` | 274 | **4,999** | **仅 10 行以后**可改；1–9 行是整条规则压成一行，禁止编辑 |

可安全编辑（全分行，最长行 <300 字符）：`tokens.css`(72) / `responsive.css`(90) / `workspace.css`(81) / `module-workspace.css`(59) / `material-original.css`(39)。

## 5. 绝对禁令

1. **不要从仓库根目录做全量搜索或列目录。** 工作区有 **6 万个文件**（`artifacts/` 17G 历史构建产物、`node_modules/`、`var/`）。**只在 `src/ scripts/ tests/ docs/` 里搜。** 用 `rg` 不要用 `find .`。
2. **不要编辑第 4 节点名的压缩文件。** 改样式写覆盖层。
3. **不要通读 `MEMORY.md` / `HISTORY.md` / `CHANGELOG.md`。** 要查用 `rg "关键词" docs/MEMORY.md`，只取命中行附近内容。
4. **不要启动服务、不要开浏览器截图**，除非任务明确要求。验证用 `npm run verify`。
5. **一次只做一件事。** 一个任务 = 一处改动 = 一条可断言的验证结果。禁止"顺手把相关的也改了"。
6. **不要改版本号、不要改 `scripts/package*.ps1`、不要新增依赖。**
7. **不确定就停下来问**，不要用"我理解你的意思是…"替人做决定。

## 6. 交付格式

```
改了什么：文件:行 → 改成什么
验证：npm run verify 输出原文（逐字粘贴，不要概括）
未验证项：…（没有就写"无"）
待确认项：…（没有就写"无"）
IS_PASS: YES/NO
```
