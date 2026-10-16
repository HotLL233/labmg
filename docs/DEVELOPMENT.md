# 开发与版本管理

项目继续使用 Node.js、内置 SQLite 和静态前端，需要 Node.js 22.13+，建议使用 Node.js 24。源码、部署配置与本地数据分别存放，便于维护和回退。

## 目录约定

```text
src/
  server.js            服务端入口
  public/              页面、样式和浏览器脚本
scripts/
  check.js             全部 JavaScript 的语法检查
  package.ps1          部署包生成脚本
config/
  .env.example         环境变量示例
deploy/
  docker-compose.yml   PostgreSQL、MinIO 配置
docs/                  开发说明与变更记录
tests/                 隔离环境中的启动与路径检查
var/                   本地数据库、附件和日志，不提交
artifacts/             本地版本化部署包，不提交
```

当前服务仍使用 SQLite 与本地附件；`deploy/docker-compose.yml` 中的服务不会自动接入应用。

## 记忆、历程与版本说明

| 文件 | 维护内容 |
| --- | --- |
| [项目记忆](MEMORY.md) | 历史需求、已确认决策、当前状态、已知问题、验证范围和新记忆 |
| [开发历程](HISTORY.md) | 按时间顺序追加工作事件、原因、结果、提交或版本及遗留事项 |
| [版本更新说明](CHANGELOG.md) | 统一记录已发布版本和未发布变更，后续版本在同一文件内新增 |

开始任务前读取项目记忆；完成有意义的工作后同步更新记忆、追加历程，并将对外变更加入版本说明的“未发布”。新决策替代旧结论时保留历史并注明原因，已知问题修复时补充提交与验证依据，不直接删除原始发现。

正式发布时新增版本及日期，保留旧条目并同步版本号、标签和相关文档。纯文档维护不自动提升业务版本。以上文件不记录真实密码、令牌或业务数据正文；根目录的 `AGENTS.md` 仅作为维护规则入口。

## 运行与检查

在项目根目录运行：

```powershell
npm run check
npm test
npm start
```

`npm run check` 检查全部 JavaScript 语法，不代替业务、权限或并发测试。`npm start` 默认监听 3000 端口，运行文件放在 `var/data`、`var/uploads`、`var/logs`。

日常开发使用：

```powershell
npm run dev
```

开发模式默认监听 3001 端口，并使用 `var/development` 下的独立数据库、附件和日志。它不会自动复制正式数据。

`LABOS_RUNTIME_DIR` 决定运行根目录，`PORT` 决定端口；需要自定义时通过进程环境变量设置，建议给运行目录使用绝对路径。例如在 PowerShell 中：

```powershell
$env:LABOS_RUNTIME_DIR = 'C:\labmg\var\scratch'
$env:PORT = '3002'
npm start
```

`config/.env.example` 仅供参考，不会自动加载。管理员初始化变量等配置也必须传给启动进程；不要将真实口令写回示例或提交到 Git。初始化管理员变量不等于修改已有账号的密码。

## 分支与版本

- `main`：经过验证的稳定版本。
- `develop`：后续开发的集成分支。
- `feature/*`：从 `develop` 创建的具体功能分支，完成检查后合回 `develop`。

开始新功能：

```powershell
git switch develop
git pull --ff-only
git switch -c feature/permission-rules
```

发布时先验证 `develop`，更新版本号及变更记录，再合入 `main` 并创建对应标签。发布后同步 `develop`，本地继续在 `develop` 开发。

`v0.1.0` 标记原始提交 `9fe5459`；目录整理版为 `v0.1.1`。Git 标签固定代码快照，切换分支或标签不会隔离、回退或恢复数据库和附件。

## 打包与回退

```powershell
npm run package:zip
```

0.1.1 的产物为 `artifacts/labos-0.1.1.zip`。部署包保留 `src/`、`scripts/`、`config/`、`deploy/`、`docs/`、`tests/` 结构，可在解压后的根目录执行 `npm start`，或运行 `start-labos.cmd`。包中不应包含本地数据库、附件、日志和真实环境配置。

切回历史标签或部署旧版本前，先停止服务，备份完整运行目录及当前部署配置。历史版本的数据目录和启动方式可能不同，应按该版本说明运行；新旧版本不要共用生产数据目录。恢复代码不代表恢复数据，数据库兼容性也需要单独验证。
