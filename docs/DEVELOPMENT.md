# 开发与版本管理

项目继续使用 Node.js、内置 SQLite 和静态前端，需要 Node.js 22.13+，建议使用 Node.js 24。源码、部署配置与本地数据分别存放，便于维护和回退。

Windows 命令统一使用 PowerShell 7（`pwsh`）；本机当前验证为 7.6.7，通过 `Get-Command pwsh` 定位到 WindowsApps 提供的入口。此前记录的 `C:\Program Files\PowerShell\7\pwsh.exe` 当前不存在，不再硬编码该路径；工具显式指定 `pwsh`，用 `$PSVersionTable` 确认实际版本。npm 打包命令和打包回归均调用 `pwsh`。此路径更正发生在 rc.5 冻结后，不改写已生成的版本产物；后续源码再打包需使用新版本号。

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

## 0.3.2 位置与领用

从 `8d214e2` 建立 `feature/v0.3.2-material-improvements`。用户先要求参考开源逻辑完善现有流程，随后要求增加存放位置和物资领用，并明确选择“人员申请，物资管理员发放”。源码版本为 0.3.2，运行/测试/构建缓存统一使用 `artifacts/cache/0.3.2/`，开发数据为 `var/development/0.3.2/`；已发布版本及稳定 main 保留。

本版范围是批次余额及精确流水、批次存放位置、单物资单批次领用申请、物资管理员发放/驳回及本人取消。申请不预占；发放在事务内重新核对余额，采用整数数量和金额，按当前批次金额比例四舍五入，领完精确扣完，保留来源流水。存放位置为每个“物资+仓库+区域+批号+有效期”独立的文字位置，不替代区域；本轮未实现同批次多货架拆分、部分发放或申请自动预占。

业务权限新增位置维护和领用发放；ADMIN/MATERIAL 加对应权限可维护位置，发放和驳回须 MATERIAL 角色及 `materials.issue.write` 权限，ADMIN 本身不能办理。普通人员仅看本人领用并可取消本人待发放申请。仅严格等于原默认集合的 MATERIAL 角色一次性补权限，自定义或已撤销的权限不自动扩大。数据库扩展保留旧业务数据；物资完整备份升级为 schema 2，并支持旧 schema 1 的空新表迁入。

0.3.1 升级到 0.3.2 前，先停服并完整备份原数据卷或运行目录及部署配置，在隔离副本验证；沿用原 YML、项目名、挂载源及 UID/GID，仅更新 `LABOS_IMAGE=ghcr.io/hotll233/labmg:0.3.2` 后拉取并重建。旧 YML 的 0.3.1 卷名保持不变，只有首次安装才使用新版 YML 默认的 0.3.2 新卷。升级会扩展物资表结构；旧版不支持 schema 2，回退必须恢复升级前完整数据副本，不能仅切回旧镜像或把新版业务备份交给旧服务。

本次发布交付源码 ZIP、`v0.3.2` 版本标签、GHCR 双架构镜像及按架构导出的离线 TAR、校验清单和配套部署文件，产物目录为 `artifacts/releases/0.3.2/`。源码冻结后从同一快照构建和验证，保留历史标签及产物。构建、发布、匿名拉取及容器验证结果以 [0.3.2 Release](https://github.com/HotLL233/labmg/releases/tag/v0.3.2)、对应 Actions 和版本说明的实际记录为准；部署配置本身不证明发布已成功。

参考入口及采用边界见[开源对照报告](research/MATERIAL_OPEN_SOURCE.md)。保留本项目协同申报、完整原版修订、独立区域与本批金额规则，不搬入上游服务或业务源码。实际实现、检查结果及验证边界统一记入[版本说明](CHANGELOG.md)的 0.3.2 条目。

## 0.3.1 新物资提交修复

从 `f345be7` 创建 `fix/v0.3.1-new-material-submission`，修复 0.3.0 自由填报却要求提交前匹配主档的流程阻断。完整非空申报允许未匹配主档提交，不自动建主档或合并；验收、拒收及结案入口统一要求匹配。MATERIAL 在首次业务事件前通过已有受控修订绑定主档，必须原因并保留原版 `catalogId:null`；已有事件仍保护身份、区域和仓库。权限与表结构不变。

本版运行/测试/构建缓存使用 `artifacts/cache/0.3.1/`，正式产物使用 `artifacts/releases/0.3.1/`。首次安装默认新卷按 0.3.1 隔离；已有 0.3.0 部署保留原 YML/项目/卷或 bind，仅更新 `LABOS_IMAGE`，停服备份后拉取重建，避免误接空卷。main 及历史标签/产物保持不变；实际验证与发布结果见统一版本说明。

## 0.3.0 物资正式实现

从 `develop` 的 `341d56a` 创建 `feature/v0.3.0-materials`，业务版本提升到 0.3.0。旧标签、产物、数据与稳定 main 保留。接口见 [MATERIAL_API.md](MATERIAL_API.md)，历史方案和 HTML 继续保留。

- 新增八张业务表及附件、状态、幂等三张辅助表；SQLite WAL 单实例，开启外键，库存由流水汇总。旧 records 物资写入口关闭，历史数据不自动结转。
- 全员可建单/加行、草稿本人行编辑；同一草稿并发加行是追加操作。表头/已有行/提交/验收核对读取版本；提交预览过期返回 409，页面保留输入，显式重读后核对。
- ADMIN 或 MATERIAL 加对应权限维护分类/区域/主档；提交、受控修订、验收、结案、冲正及期初/调整同时要求 MATERIAL 角色与动作权限。管理员需要办理业务时，在账号编辑中增加 MATERIAL 角色。
- 旧默认 MATERIAL 角色只升级一次并补新动作；已自定义 MATERIAL 权限不自动扩大，迁移后撤销的动作不会在重启时恢复。自定义角色仅获动作权限也不能越过明确的 MATERIAL 角色限制。
- 金额最多两位、数量最多三位小数，API 接收十进制字符串，库内整数记账。金额为本批合格物资含税总额，零金额须原因；拒收不入正常库存，差缺结案不冒充全部合格。
- 原提交及完整修订正文保留，提交后仅修订现有内容且须原因。已有验收/结案的行保护物资身份、仓库与区域，数量不得低于有效已验收+结案量。修订不改历史库存；整笔冲正精确反向且最多一次，同号同正文可重试记账。
- 分类、区域只新增，历史引用不可删除。主档编码唯一、身份不可随意改，不同规格、单位或等级使用不同编码。
- Excel 使用锁定的 write-excel-file 4.1.1（依赖 fflate）生成多表文件，文本不作为公式，金额列按权限裁剪。一次最多 1000 单/5000 行或 5000 库存，超限需缩小范围。
- 申报与验收附件独立关联，每个最大 5 MiB，保留原提交附件版本与历史文件。验收扫描件与旧物资附件需要金额读取权限。

备份中心分两类：通用台账/系统备份不含新版物资，旧物资只恢复为只读历史；物资完整备份含十一表、快照、幂等和附件，不含密码。物资备份/恢复需要 backup.read 或 backup.restore 并同时有 materials.amount.read。专用恢复仅允许空的新业务库，按 username 映射现有用户，先创建或恢复同名账号。附件总量上限 20 MiB，JSON 上限 25 MiB，超出请停服备份整个运行目录。业务 JSON 不能替代完整灾备。

首次升级前，停服备份数据库与所有附件，在隔离副本验证。保留旧挂载源与 UID/GID；默认 0.3.0 新卷为空，切换镜像或分支不会自动迁移/回滚数据，回退需恢复原数据副本。

源码先运行 `npm ci --omit=dev --ignore-scripts`；ZIP 包含 package-lock，不含跨平台 node_modules。Docker 构建安装锁定依赖，TAR 可离线使用。测试/构建缓存继续在 `artifacts/cache/0.3.0/`，正式产物在 `artifacts/releases/0.3.0/`。

本版源码冻结在 `5012a2c` / `v0.3.0`。Actions `38999734421` 构建正式双架构镜像；本机 Docker Hub 超时后，离线 TAR 改从已核验的正式公开 GHCR 镜像按架构导出，保留 `package-docker.ps1` 的清单字段，未用临时检查镜像发布。匿名双架构拉取、配套冻结 Compose、两份 TAR 的完整容器专项均通过，ARM64 为模拟。冻结后的发布记录和部署文档更正另作提交，不移动版本标签或重打 ZIP；附件中的文档保留冻结快照，当前步骤以本分支文档为准。

## 物资管理设计历史

2026-10-17 的[物资申报、验收与库存方案](MATERIAL_WORKFLOW.md)与[离线 HTML 原型](prototypes/material-workflow.html)位于 `docs/`，本轮在 `feature/material-workflow-design` 隔离制作，供业务与界面评审。原型使用内存模拟数据，刷新还原，未接入正式页面、API 或数据库；XLSX 按钮仅示意。

用户同日补充分类与归属区域选择，并将提交后全员不可编辑改为仅物资管理员可修订；后续在 `feature/material-classification-editing` 更新方案与原型，保留原提交版及修订原因/历史。分类与区域选项建议由 ADMIN 或 MATERIAL 维护；提交后编辑仍明确要求 MATERIAL，区域与仓库、创建者分别保存，建议库存按物资+仓库+区域合并。

设计阶段将独立单据/明细、分类/区域字典、原提交快照与受控修订、物资管理员角色约束、验收入库事务与幂等、库存流水、期初切换和备份恢复列为正式实施范围。上述要求已由本轮 0.3.0 正式业务实现补充；原型仍只作历史示例，不替代正式页面。设计阶段未改写的 `0.2.0-rc.5` 版本、镜像和标签继续保留。

## 运行与检查

在项目根目录运行：

```powershell
npm ci --omit=dev --ignore-scripts
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

开发模式默认监听 3001 端口，并使用 `var/development/<package.version>` 下的独立数据库、附件和日志，例如 `var/development/0.3.0/`。它不会自动复制正式或旧开发版本的数据。

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

`0.2.0-rc.5` 从 `develop` 的 `9713851` 创建 `feature/auto-create-runtime`，默认改为 Docker 自动创建的命名数据卷，并用一次性初始化服务准备目录及权限。每个项目、每个版本有独立卷；保留旧 `LABOS_DATA_DIR` 指定宿主机目录的能力，不自动复制旧数据。rc.4 标签、镜像、离线产物及原有数据继续保留。

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

`deploy/docker-compose.yml` 和 0.3.2 Release 配套 YML 默认使用 `ghcr.io/hotll233/labmg:0.3.2`；部署前先核对实际发布状态。首次安装默认不设置 `LABOS_DATA_DIR`，Docker 自动创建 `<项目名>_labos-runtime-0.3.2` 命名卷，应用和初始化服务共用该卷。已有 0.3.1 部署沿用原 YML/项目/挂载和 UID/GID，仅更新镜像，原卷名不变。`labos-init` 以 root 创建运行目录、设置属主及 owner 读写执行权限后退出；`labos` 等待其成功，再按 `LABOS_UID/GID` 非 root 运行。需要支持 `depends_on.condition: service_completed_successfully` 的 Compose；不使用 Swarm `stack deploy`。

已有宿主机数据须在同目录 `.env` 保留原 `LABOS_DATA_DIR` 绝对路径及 UID/GID，目录须已存在；默认新卷不含旧数据。初始化只处理根、`data/`、`uploads/`、`logs/` 四个目录，不递归改已有数据库和附件。普通 `docker compose down` 保留卷，日常升级不要用 `down --volumes` / `down -v`。详细备份和迁移见 [群晖部署](SYNOLOGY.md)。主配置保留 Compose 3.8 形式，不设置 `pull_policy`；旧 Compose 是否支持完成依赖条件须以实际部署工具为准。

### Docker 离线镜像包

```powershell
npm run package:docker
```

该命令先生成并校验同版本源码 ZIP，再从这个快照构建 `linux/amd64` 和 `linux/arm64` 镜像，使用 `docker save` 导出 TAR。镜像标签为 `labos:<version>`，版本和源码提交写入 OCI 标签；每架构有独立 TAR 与 JSON 校验清单，部署时只导入适合目标架构的一份。YML、环境示例和群晖说明另放发布目录，便于直接取用。

导入并核对同版本 TAR 后，在部署 `.env` 中设置 `LABOS_IMAGE=labos:<实际版本>`（0.3.2 TAR 对应 `labos:0.3.2`），使用本地标签并跳过 `docker compose pull`。默认 GHCR 名称与离线 TAR 名称不同，导入镜像不会自动修改 YML 的镜像选择。rc.2 / rc.3 历史 TAR 仍使用对应版本标签及原初始化配置，rc.4 仍使用该版本绑定目录及网页首设方式。

需要运行中的 Linux Docker 引擎、Buildx 与跨架构构建支持；仅打源码 ZIP 不需要 Docker。PowerShell 可用 `scripts/package-docker.ps1 -Architectures amd64` 只导出一种架构。构建阶段、镜像临时导出和每架构本地层缓存均放在 `artifacts/cache/<version>/`；Docker 内部存储仍由引擎管理。后续版本可复用最近版本的对应架构缓存，旧发布包不可覆盖。

镜像的运行目录固定为 `/var/lib/labos`，由 Compose 默认挂载本版命名卷，也可指定已有宿主机目录；通过 `LABOS_UID/GID` 指定运行用户，两者须为 1–2147483647 的整数。初始化拒绝符号链接及非目录，不加载业务服务或创建数据库。构建上下文只允许源码和包信息，并排除其中意外存在的环境文件/数据库/附件等。镜像不会包含本机真实业务数据或管理员口令。直接 `docker run` 使用自定义 UID 时仍须自行准备可写卷；自动初始化属于 Compose 项目启动流程。

`tests/docker.test.js` 只有设置 `LABOS_DOCKER_IMAGE` 时才运行真实容器检查；普通 `npm test` 会明确跳过该项。例如在镜像已构建后：

```powershell
$env:LABOS_DOCKER_IMAGE = 'labos:0.3.2'
node --test tests/docker.test.js
Remove-Item Env:LABOS_DOCKER_IMAGE
```

该检查使用独立 Compose 项目及命名卷，验证自动创建、初始化属主、非 root、首次设置、登录和记录/附件在容器重建后的持久化；验证产物集中在 `artifacts/cache/<version>/`，不使用 `var/` 真实数据库。NAS 的实际 DSM/内核/目录权限和容量还需在目标设备确认。具体部署步骤见 [群晖 Docker 部署](SYNOLOGY.md)。

切回历史标签或部署旧版本前，先停止服务，备份完整运行目录及当前部署配置。历史版本的数据目录和启动方式可能不同，应按该版本说明运行；新旧版本不要共用生产数据目录。恢复代码不代表恢复数据，数据库兼容性也需要单独验证。
