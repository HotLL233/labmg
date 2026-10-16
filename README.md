# LabOS 实验室综合管理系统

当前版本：**0.2.0-rc.1**（第一轮首个候选版）。使用 Node.js 内置 SQLite，覆盖档案、模板、财务、设备、物资、体系文件、人员和合同管理。稳定分支 `main` 仍保留 0.1.1。

## 快速启动

需要 Node.js 22.13+，建议使用 Node.js 24。

```powershell
npm run check
npm test
npm start
```

日常运行地址为 `http://127.0.0.1:3000`，数据保存在 `var/`。首次初始化默认账号为 `admin`，密码为 `admin123`，使用前请修改。

开发使用 `npm run dev`，默认地址为 `http://127.0.0.1:3001`，本版本的独立数据保存在 `var/development/0.2.0-rc.1/`。切换版本不会自动复制旧数据。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/` | 服务端和静态前端 |
| `scripts/` | 检查与打包脚本 |
| `tests/` | 隔离启动、权限/会话/冲突、前端状态与版本打包回归 |
| `config/` | 环境变量示例 |
| `deploy/` | PostgreSQL、MinIO 辅助服务配置 |
| `docs/` | 开发约定和变更记录 |
| `var/` | 本地数据库、附件和日志，不提交 |
| `artifacts/` | 按版本隔离的本地发布包、构建清单和缓存，不提交 |

应用当前仍使用 SQLite 与本地附件；Docker 配置中的数据服务尚未接入。`config/.env.example` 不会自动加载，配置通过进程环境变量传入。

## 版本与发布

`main` 保存发布基线，`develop` 用于后续开发，`feature/*` 承载具体功能；Git 标签保留版本快照。切换分支不会自动隔离或回退数据。

```powershell
npm run package:zip
```

生成 `artifacts/releases/0.2.0-rc.1/labos-0.2.0-rc.1.zip` 及 `manifest.json`；构建和验证缓存使用 `artifacts/cache/0.2.0-rc.1/`。旧版本产物保留，相同版本只复用内容和校验一致的包；输入变化或已有包损坏时应使用新版本号。

解压后运行 `npm start` 或 `start-labos.cmd`。部署包不包含本地运行数据；后续引用版本时同时核对清单中的版本、源码摘要和 ZIP 校验值。

具体操作见 [开发与版本管理](docs/DEVELOPMENT.md)。项目记录统一维护在 [项目记忆](docs/MEMORY.md)、[开发历程](docs/HISTORY.md) 和 [版本更新说明](docs/CHANGELOG.md) 中，后续版本说明在同一文件内新增。

当前仍为 MVP 候选版，权限、会话和编辑冲突改造的具体范围及验证结果见版本说明。尚未完成真实 30 人混合负载验收或完整灾备验收。
