# 开发与版本管理

项目继续使用 Node.js、内置 SQLite 和静态前端，需要 Node.js 22.13+，建议使用 Node.js 24。源码、部署配置与本地数据分别存放，便于维护和回退。

Windows 命令统一使用 PowerShell 7（`pwsh`）；本机已验证版本为 7.6.7，路径为 `C:\Program Files\PowerShell\7\pwsh.exe`。当前开发分支的 npm 打包命令和打包回归均调用 `pwsh`。该工具调整发生在 rc.4 标签冻结后，不改写其原源码包、标签或镜像；后续打包需使用新版本号。

## 目录约定

```text
src/
  server.js            服务端入口
  public/              页面、样式和浏览器脚本
scripts/
  check.js             全部 JavaScript 的语法检查
  package.ps1          部署包生成脚本
  package-docker.ps1   Docker 镜像导出与版本化层缓存
config/
  .env.example         环境变量示例
deploy/
  Dockerfile           Node 24 非 root 应用镜像
  docker-compose.yml   应用单容器部署
  .env.example         Compose 变量示例
  docker-compose.infrastructure.yml  旧 PostgreSQL、MinIO 示例
docs/                  开发说明与变更记录
tests/                 启动、权限、前端状态与版本打包回归
var/                   本地数据库、附件和日志，不提交
artifacts/             唯一构建产物与缓存目录，不提交
  releases/<version>/  ZIP 和 manifest.json，保留历史版本
  cache/<version>/     构建、测试和解压验证缓存
  legacy/              目录整理前的产物和数据迁移备份
```

当前服务仍使用 SQLite 与本地附件；应用 Compose 只启动 LabOS。原来仅 PostgreSQL/MinIO 的 Compose 保留为 `deploy/docker-compose.infrastructure.yml`，不会自动接入应用。

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

`npm test` 运行隔离 HTTP/数据库回归、按真实脚本顺序加载的前端 VM 检查和版本化打包测试；源码副本及缓存统一位于 `artifacts/cache/<version>/`。测试不使用 `var/` 中的真实数据库；VM 检查不代替真实浏览器验收。

日常开发使用：

```powershell
npm run dev
```

开发模式默认监听 3001 端口，并使用 `var/development/<package.version>` 下的独立数据库、附件和日志，例如 `var/development/0.2.0-rc.4/`。它不会自动复制正式或旧开发版本的数据。

`LABOS_RUNTIME_DIR` 决定运行根目录，`PORT` 决定端口；需要自定义时通过进程环境变量设置，建议给运行目录使用绝对路径。例如在 PowerShell 中：

```powershell
$env:LABOS_RUNTIME_DIR = 'C:\labmg\var\scratch'
$env:PORT = '3002'
npm start
```

`config/.env.example` 仅供参考，不会自动加载。空数据库默认首次打开网页设置管理员账号和密码（8–1024 字符、不能全为空白、需确认），没有默认密码。已有任意用户时初始化入口关闭；升级后继续使用原账号。首次设置完成前只允许可信人员访问服务。

如自动化部署确需预设，仍可把非空 `LABOS_ADMIN_PASSWORD` 与可选 `LABOS_ADMIN_USER` 传给启动进程，仅在零用户时创建管理员；默认 Docker Compose 不传密码。不要将真实口令写回示例或提交到 Git，初始化变量不等于修改已有账号的密码。

### 0.2.0-rc.1 兼容性

- 启动会为旧 `records` 表补充整数 `version`，重建体系文件当前版本联动触发器；旧客户端更新记录前需先读取并回传 `version`。缺失或非整数返回 400，版本过期返回 409；页面保留输入并允许明确重载。
- 新建、重置和导入账号使用带盐 scrypt；旧明文账号成功登录后自动升级。已有旧账号并非在启动时全部迁移。备份会把旧明文转为哈希快照，历史备份不会自动改写。
- 记录操作同时要求模块、已配置分区及档案角色范围权限。某动作只配置部分分区权限时，仅允许该动作已授权的分区，缺失/未知分区拒绝；未单独限制分区或全部已知分区授权时保持全模块范围，便于默认经理维护未分类旧记录。写入和删除还要求能读取对应记录。非管理员新增档案需包含自身角色范围。
- 物资中文环节和财务收支方向映射到权限代码；没有对应权限分区的物资采购申请、到货验收及仓储环境记录，在已限制分区的角色下拒绝访问，后续再扩展权限目录。未分类旧记录也可能需要管理员整理分类。
- 页面入口和动作依据登录时的有效权限显示，权限调整后重新登录以刷新页面；服务端每次请求重新判定权限。
- 完整备份的账号/角色内容另需 `permissions.read`，恢复这些内容另需 `permissions.write`。备份仍是追加导入，不能作为完整灾备还原；密码哈希也应按敏感信息保管。
- 旧 `samples` 数据和索引保留在库中，入口隐藏；当前恢复接口仍跳过不受支持的旧模块，不等于提供旧样品业务或恢复能力。保留整个运行目录备份。

首次在旧数据上启用本版前，停服备份整个运行目录，在独立副本中验证。代码版本隔离不等于数据库可逆迁移。

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

第一轮首版为 `0.2.0-rc.1`，从 `develop` 的文档基线 `a728e28` 创建 `feature/v0.2.0-round1`。候选版经检查后可集成到 `develop` 并保留同名版本标签；本轮不把候选代码直接提升到稳定 `main`。

群晖 Docker 版为 `0.2.0-rc.2`，从 `develop` 的首版提交 `6c12017` 创建 `feature/docker-synology`；保留 rc.1 的代码、包和标签，候选版检查后集成 `develop`，稳定 `main` 仍为 `0.1.1`。

`0.2.0-rc.3` 在 rc.2 的镜像 TAR 部署基础上增加公开 GHCR 多架构镜像与标签发布流程，YML 默认使用线上镜像，保留 `LABOS_IMAGE` 覆盖以支持离线导入。rc.2 的标签、产物和历史记录继续保留；仓库公开、GHCR 包公开及匿名拉取的实际结果分别核验，不能用配置完成替代发布验证。

`0.2.0-rc.4` 从 `develop` 的 `46841f3` 创建 `feature/first-login-setup`，改为网页首次设置管理员密码，移除默认密码及 Compose 必填密码变量。保留 rc.3 标签、镜像和离线产物；新版使用自己的数据、构建和缓存目录。旧库不会重新开放初始化，代码升级不等于密码重置。

## 打包与回退

```powershell
npm run package:zip
```

产物统一为 `artifacts/releases/<version>/labos-<version>.zip` 和 `manifest.json`。清单用于记录版本、构建提交、输入源码摘要、ZIP 大小、SHA-256 和构建 UTC 时间，便于后续按版本引用与核验。

同版本、同输入且 ZIP 校验通过时复用已有产物；同版本输入改变、产物不完整或校验失败时拒绝覆盖，需排查后使用新版本号。不要把新内容写回旧版本目录。构建缓存、测试副本和解压验证统一放 `artifacts/cache/<version>/`，不散落在项目根目录；这些本地目录不提交 Git。

旧 0.1.1 ZIP 已归档到 `artifacts/releases/0.1.1/labos-0.1.1.zip`，原解压验证目录归入 `artifacts/cache/0.1.1/verification/`；更早产物及原数据迁移备份保留在 `artifacts/legacy/`。旧 ZIP 是历史保留件，不补写成新构建。

部署包保留 `.github/`、`src/`、`scripts/`、`config/`、`deploy/`、`docs/`、`tests/` 及必要根文件，可在解压后的根目录执行 `npm start`，或运行 `start-labos.cmd`。包中不应包含本地数据库、附件、日志、真实环境配置和构建缓存。

### GHCR 多架构发布

GitHub Actions 在推送 `v*` 标签时构建并推送 `linux/amd64`、`linux/arm64` 多架构镜像。标签版本须与 `package.json` 相符；例如 `v0.2.0-rc.3` 对应 `ghcr.io/hotll233/labmg:0.2.0-rc.3`。镜像写入版本及源码提交 OCI 标签，发布凭据由工作流的 `GITHUB_TOKEN` 提供。失败运行可在 Actions 页面重新运行，不要求部署用户持有 GitHub 凭据。

rc.3 首次推送后未生成运行记录，具体触发原因未确定。后续独立 CI 提交增加手动入口，默认分支设为 `develop` 供 GitHub 发现工作流，稳定 `main` 内容保持 0.1.1。选择“Run workflow”的 `develop`，输入已存在的标签（如 `v0.2.0-rc.3`），流程固定检出该标签并验证提交，不把 CI 分支的新提交当作发布源码。已生成的 rc.3 ZIP/TAR 和标签不改写，该入口归入后续 CI 变更。

维护者发布后须确认 GHCR 包可公开访问，并在没有镜像仓库登录凭据的环境验证该版本的多架构清单和拉取。工作流文件、成功构建、包公开及匿名拉取是不同检查项，结果以实际运行和外部状态为准。

rc.3 已由运行 `38855576508` 构建发布，用户设置包 Public 后完成匿名双架构拉取及正式 YML 启动验证。Registry 检查使用完整的 OCI 索引媒体类型 `application/vnd.oci.image.index.v1+json`；缺失 `.v1` 时 GHCR 也返回 404，不能据此判断标签不存在。后续 CI 跟进修正该类型并保留已有版本校验。

`deploy/docker-compose.yml` 默认使用 `ghcr.io/hotll233/labmg:0.2.0-rc.4`，已公开的版本可直接 `docker compose pull` / `up -d`，无需导入 TAR 或 `docker login`。按需将 `deploy/.env.example` 复制为同目录 `.env`，设置数据目录及 UID/GID，密码在首次网页访问时设置；相对数据路径基于 `deploy/`，默认 `../var/docker/0.2.0-rc.4`。群晖建议使用绝对 NAS 路径。主配置保留 Compose 3.8 兼容性，不设置 `pull_policy`。

### Docker 离线镜像包

```powershell
npm run package:docker
```

该命令先生成并校验同版本源码 ZIP，再从这个快照构建 `linux/amd64` 和 `linux/arm64` 镜像，使用 `docker save` 导出 TAR。镜像标签为 `labos:<version>`，版本和源码提交写入 OCI 标签；每架构有独立 TAR 与 JSON 校验清单，部署时只导入适合目标架构的一份。YML、环境示例和群晖说明另放发布目录，便于直接取用。

导入 TAR 后，在部署 `.env` 中设置 `LABOS_IMAGE=labos:0.2.0-rc.4`，使用本地标签并跳过 `docker compose pull`。默认 GHCR 名称与离线 TAR 名称不同，导入镜像不会自动修改 YML 的镜像选择。rc.2 / rc.3 历史 TAR 仍使用对应版本标签及原初始化配置。

需要运行中的 Linux Docker 引擎、Buildx 与跨架构构建支持；仅打源码 ZIP 不需要 Docker。PowerShell 可用 `scripts/package-docker.ps1 -Architectures amd64` 只导出一种架构。构建阶段、镜像临时导出和每架构本地层缓存均放在 `artifacts/cache/<version>/`；Docker 内部存储仍由引擎管理。后续版本可复用最近版本的对应架构缓存，旧发布包不可覆盖。

镜像的运行目录固定为 `/var/lib/labos`，由 Compose 绑定到宿主机本版数据目录；通过 `LABOS_UID/GID` 指定运行用户，目录须允许该用户读写。构建上下文只允许源码和包信息，并排除其中意外存在的环境文件/数据库/附件等。镜像不会包含本机真实业务数据或管理员口令。

`tests/docker.test.js` 只有设置 `LABOS_DOCKER_IMAGE` 时才运行真实容器检查；普通 `npm test` 会明确跳过该项。例如在镜像已构建后：

```powershell
$env:LABOS_DOCKER_IMAGE = 'labos:0.2.0-rc.4'
node --test tests/docker.test.js
Remove-Item Env:LABOS_DOCKER_IMAGE
```

该检查使用 `artifacts/cache/<version>/` 下的独立挂载目录，验证非 root、健康状态、登录和记录/附件在容器重建后的持久化，不使用 `var/` 真实数据库。NAS 的实际 DSM/内核/目录权限和容量还需在目标设备确认。具体部署步骤见 [群晖 Docker 部署](SYNOLOGY.md)。

切回历史标签或部署旧版本前，先停止服务，备份完整运行目录及当前部署配置。历史版本的数据目录和启动方式可能不同，应按该版本说明运行；新旧版本不要共用生产数据目录。恢复代码不代表恢复数据，数据库兼容性也需要单独验证。
