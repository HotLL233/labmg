# LabOS 实验室综合管理系统

当前版本：**0.2.0-rc.2**（群晖 Docker 部署候选版，业务基于第一轮首版）。使用 Node.js 内置 SQLite，覆盖档案、模板、财务、设备、物资、体系文件、人员和合同管理。稳定分支 `main` 仍保留 0.1.1。

## 快速启动

需要 Node.js 22.13+，建议使用 Node.js 24。

```powershell
npm run check
npm test
npm start
```

日常运行地址为 `http://127.0.0.1:3000`，数据保存在 `var/`。首次初始化默认账号为 `admin`，密码为 `admin123`，使用前请修改。

开发使用 `npm run dev`，默认地址为 `http://127.0.0.1:3001`，本版本的独立数据保存在 `var/development/0.2.0-rc.2/`。切换版本不会自动复制旧数据。

## Docker 与群晖

提供可直接导入的 `amd64` / `arm64` Docker 镜像 TAR，以及 `docker-compose.yml` 和 `.env.example`。导入与设备架构匹配的镜像后，在群晖 Container Manager 中创建 YML 项目，设置管理员初始化密码、端口和持久化目录即可使用。

镜像名为 `labos:0.2.0-rc.2`，容器端口 `3000`，数据挂载到 `/var/lib/labos`。镜像默认非 root 运行，宿主数据目录须给实际 UID/GID 读写权限。完整步骤见 [群晖部署](docs/SYNOLOGY.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/` | 服务端和静态前端 |
| `scripts/` | 检查与打包脚本 |
| `tests/` | 隔离启动、权限/会话/冲突、前端状态与版本打包回归 |
| `config/` | 环境变量示例 |
| `deploy/` | Dockerfile、应用 Compose/环境示例，以及独立的旧基础服务配置 |
| `docs/` | 开发约定和变更记录 |
| `var/` | 本地数据库、附件和日志，不提交 |
| `artifacts/` | 按版本隔离的本地发布包、构建清单和缓存，不提交 |

应用当前仍使用 SQLite 与本地附件；旧 PostgreSQL/MinIO 示例保留为 `deploy/docker-compose.infrastructure.yml`，应用无需这些服务。普通 Node 启动不自动加载 `config/.env.example`；Docker Compose 则读取项目目录的 `.env` 并向容器传入变量。

## 版本与发布

`main` 保存发布基线，`develop` 用于后续开发，`feature/*` 承载具体功能；Git 标签保留版本快照。切换分支不会自动隔离或回退数据。

```powershell
npm run package:zip
```

生成 `artifacts/releases/0.2.0-rc.2/labos-0.2.0-rc.2.zip` 及 `manifest.json`；构建和验证缓存使用 `artifacts/cache/0.2.0-rc.2/`。旧版本产物保留，相同版本只复用内容和校验一致的包；输入变化或已有包损坏时应使用新版本号。

`npm run package:docker` 另构建并导出两个架构的镜像 TAR、镜像校验清单及独立的 YML/环境示例/群晖说明，仍位于同一版本目录。此命令需要运行中的 Linux Docker 引擎及 Buildx；层缓存按架构导出到 `artifacts/cache/<version>/`，后续版本可引用。

解压后运行 `npm start` 或 `start-labos.cmd`。部署包不包含本地运行数据；后续引用版本时同时核对清单中的版本、源码摘要和 ZIP 校验值。

具体操作见 [开发与版本管理](docs/DEVELOPMENT.md)。项目记录统一维护在 [项目记忆](docs/MEMORY.md)、[开发历程](docs/HISTORY.md) 和 [版本更新说明](docs/CHANGELOG.md) 中，后续版本说明在同一文件内新增。

当前仍为 MVP 候选版，权限、会话和编辑冲突改造的具体范围及验证结果见版本说明。尚未完成真实 30 人混合负载验收或完整灾备验收。
