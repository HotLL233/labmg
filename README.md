# LabOS 实验室综合管理系统

当前版本：**0.2.0-rc.5**（自动创建部署数据卷候选版）。使用 Node.js 内置 SQLite，覆盖档案、模板、财务、设备、物资、体系文件、人员和合同管理。稳定分支 `main` 仍保留 0.1.1。

## 快速启动

需要 Node.js 22.13+，建议使用 Node.js 24。

```powershell
npm run check
npm test
npm start
```

日常运行地址为 `http://127.0.0.1:3000`，数据保存在 `var/`。空数据库首次打开网页时设置管理员账号和密码，密码至少 8 位并需确认；没有默认密码。设置成功后自动登录，之后使用该账号登录；已有账号保持原密码。

开发使用 `npm run dev`，默认地址为 `http://127.0.0.1:3001`，本版本的独立数据保存在 `var/development/0.2.0-rc.5/`。切换版本不会自动复制旧数据。

## Docker 与群晖

从 [rc.5 发布页](https://github.com/HotLL233/labmg/releases/tag/v0.2.0-rc.5) 下载 `docker-compose.yml`，在群晖 Container Manager 创建项目。默认由 Docker 自动创建按项目和版本隔离的数据卷，一次性初始化容器准备目录及权限，无需手工创建数据文件夹；应用继续以非 root 用户运行。YML 默认拉取 `ghcr.io/hotll233/labmg:0.2.0-rc.5`，支持 `linux/amd64` / `linux/arm64`；启动后访问网页设置管理员密码。发布状态以实际页面为准。

按需下载 `env.example` 并改名为同目录 `.env`。默认留空 `LABOS_DATA_DIR`；如复用已有宿主机数据，必须填原来实际存在的绝对路径并保留原 UID/GID，新版不会自动迁移数据。不带原数据配置启动会得到空的新版本数据卷。源码示例仍名为 `deploy/.env.example`。

保留按架构导入 TAR 的离线方式，导入后在 `.env` 设置 `LABOS_IMAGE=labos:0.2.0-rc.5`，跳过拉取直接启动项目。容器端口 `3000`，数据挂载到 `/var/lib/labos`；`labos-init` 成功退出是正常状态。完整步骤、备份与国内仓库同步方法见 [群晖部署](docs/SYNOLOGY.md)。

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

生成 `artifacts/releases/0.2.0-rc.5/labos-0.2.0-rc.5.zip` 及 `manifest.json`；构建和验证缓存使用 `artifacts/cache/0.2.0-rc.5/`。旧版本产物保留，相同版本只复用内容和校验一致的包；输入变化或已有包损坏时应使用新版本号。

`npm run package:docker` 另构建并导出两个架构的镜像 TAR、镜像校验清单及独立的 YML/环境示例/群晖说明，仍位于同一版本目录。此命令需要运行中的 Linux Docker 引擎及 Buildx；层缓存按架构导出到 `artifacts/cache/<version>/`，后续版本可引用。

GitHub Actions 在推送与 `package.json` 版本匹配的 `v*` 标签时构建并推送 GHCR 多架构镜像；镜像发布结果与匿名拉取验证以对应 Actions 运行和包状态为准，部署配置本身不代表发布已成功。`0.2.0-rc.2` 引入的本地 TAR 交付方式及历史版本继续保留。

解压后运行 `npm start` 或 `start-labos.cmd`。部署包不包含本地运行数据；后续引用版本时同时核对清单中的版本、源码摘要和 ZIP 校验值。

具体操作见 [开发与版本管理](docs/DEVELOPMENT.md)。项目记录统一维护在 [项目记忆](docs/MEMORY.md)、[开发历程](docs/HISTORY.md) 和 [版本更新说明](docs/CHANGELOG.md) 中，后续版本说明在同一文件内新增。

当前仍为 MVP 候选版，权限、会话和编辑冲突改造的具体范围及验证结果见版本说明。尚未完成真实 30 人混合负载验收或完整灾备验收。
