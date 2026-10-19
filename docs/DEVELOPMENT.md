# 开发与版本管理

本源码版本为 **0.6.0**，使用 Node.js、PostgreSQL 和静态前端，需要 Node.js 22.13+，建议使用 Node.js 24。本轮 PostgreSQL 验证使用 17；0.5.1及更早版本使用 SQLite，历史实现与发布记录保留。发布状态以[版本说明](CHANGELOG.md)及GitHub Release为准。

Windows 命令统一使用 PowerShell 7（`pwsh`）；本机当前验证为 7.6.7，通过 `Get-Command pwsh` 定位到 WindowsApps 提供的入口。此前记录的 `C:\Program Files\PowerShell\7\pwsh.exe` 当前不存在，不再硬编码该路径；工具显式指定 `pwsh`，用 `$PSVersionTable` 确认实际版本。npm 打包命令和打包回归均调用 `pwsh`。此路径更正发生在 rc.5 冻结后，不改写已生成的版本产物；后续源码再打包需使用新版本号。

## 目录约定

```text
src/
  server.js            服务端入口
  database.js          异步 PostgreSQL 查询与事务
  schema.js            PostgreSQL 表结构、约束与兼容函数
  public/              页面、样式和浏览器脚本
scripts/
  check.js             全部 JavaScript 的语法检查
  package.ps1          部署包生成脚本
  package-docker.ps1   Docker 镜像导出与版本化层缓存
config/
  .env.example         环境变量示例
deploy/
  Dockerfile           Node 24 非 root 应用镜像
  docker-compose.yml   应用、PostgreSQL 与一次性目录初始化
  .env.example         Compose 变量示例
  docker-compose.infrastructure.yml  旧 PostgreSQL、MinIO 示例
docs/                  开发说明与变更记录
tests/                 启动、权限、前端状态与版本打包回归
var/                   本地附件和日志，不提交；数据库由连接地址决定
runtime/               Compose YML 旁的 PostgreSQL、附件和秘密文件，不提交
artifacts/             唯一构建产物与缓存目录，不提交
  releases/<version>/  ZIP 和 manifest.json，保留历史版本
  cache/<version>/     构建、测试和解压验证缓存
  legacy/              目录整理前的产物和数据迁移备份
```

0.6.0 应用必须连接 PostgreSQL，连接未配置或失败时停止启动，不回退到 SQLite。正式 Compose 使用 `postgres:17-bookworm`，PostgreSQL 数据在 YML 旁 `runtime/postgres/`，自动生成的数据库连接口令在 `runtime/secrets/postgres-password`，附件在 `runtime/uploads/`；保留完整目录与秘密文件。旧 `deploy/docker-compose.infrastructure.yml` 是历史 PostgreSQL/MinIO 示例，不是当前部署入口。

用户已确认尚未正式使用，本轮按全新 PostgreSQL 库处理，不实施 SQLite 迁移，不读取或删除旧 SQLite 文件。历史文档中的“旧版仅换镜像升级”、SQLite 文件备份与卷迁移步骤只适用于当时版本，不适用于切换到 0.6.0。

## 记忆、历程与版本说明

| 文件 | 维护内容 |
| --- | --- |
| [项目记忆](MEMORY.md) | 历史需求、已确认决策、当前状态、已知问题、验证范围和新记忆 |
| [开发历程](HISTORY.md) | 按时间顺序追加工作事件、原因、结果、提交或版本及遗留事项 |
| [版本更新说明](CHANGELOG.md) | 统一记录已发布版本和未发布变更，后续版本在同一文件内新增 |

开始任务前读取项目记忆；完成有意义的工作后同步更新记忆、追加历程，并将对外变更加入版本说明的“未发布”。新决策替代旧结论时保留历史并注明原因，已知问题修复时补充提交与验证依据，不直接删除原始发现。

正式发布时新增版本及日期，保留旧条目并同步版本号、标签和相关文档。纯文档维护不自动提升业务版本。以上文件不记录真实密码、令牌或业务数据正文；根目录的 `AGENTS.md` 仅作为维护规则入口。

## 0.6.0：PostgreSQL 与物资信息库

开发分支为 `feature/v0.6.0-postgresql-material-catalog`，源码版本 0.6.0。开发与测试运行文件、校验脚本放 `artifacts/cache/0.6.0/`，发布产物目标目录为 `artifacts/releases/0.6.0/`；这些路径不代表已构建或发布。main、旧标签、旧产物与原运行目录保留。

数据库查询与调用链改为异步，同一事务使用同一 PostgreSQL client。写操作用事务级 advisory lock 串行检查与入账，读请求可以并发；保留版本、幂等、金额数量整数与角色检查。请求正文在写事务前完整解析，成功响应在提交后发送；事务失败清理新建附件，彻底删除附件在提交后执行。全局写锁是当前 10–30 人查询录入目标的实现选择，不代表已通过目标 NAS 容量测试。

“主档”在界面称为“物资信息库”，保存编码、名称、规格、单位、分类及管理方式，与库存余额分开。申报检索按所选区域／仓库的正库存、其他区域的正库存、零库存排序；零库存物资继续复用既有信息。服务端只按规范化后的唯一精确身份复用，不因名称相似或同名而合并不同规格／单位。未匹配新物资仍可先填报提交，有权限的管理员可在原单建档并关联；提交后的关联要求 MATERIAL、修订权限、原因与当前版本，保留原提交快照。

物资信息 XLSX 模板、导入和筛选导出只处理标准信息；导入本身不新增库存或逐件码。数量、金额、批次和存放位置继续从期初／存量补录单导入草稿，确认入库后才生成流水和逐件编码。物资信息导入全批校验、同事务写入，已编码同字段的记录跳过，冲突不部分导入；具体字段与限额见 [物资 API](MATERIAL_API.md)。

纯 PostgreSQL 新部署仍保留现有物资 JSON 备份 schema 1–5 的受控恢复能力；这与读取旧 SQLite 数据库不是同一功能。完整恢复仍仅允许空物资库，映射现有账号，并校验库存、单件与历史关联。0.6.0 正式镜像、离线包、群晖和实机验证结果须完成后再记录，本节不沿用 0.5.1 的交付结论。

## 0.4.0：整件条码与可配置编号

用户补充手机以群晖 IP 的 HTTP 地址访问，确认同种物资每瓶／每件独立编码、逐件跟踪，首版整瓶／整件领用；随后要求验收后根据合格数量自动生成条码，编号格式支持自定义配置加流水号。此前0.3.3批次QR只定位同批余额，不能区分每瓶；此结论由本轮新增单件台账补充。实时相机已有getUserMedia实现，HTTP安全限制不能由前端绕过，继续支持本地拍照／图片识别和手输，明确HTTPS、权限、设备及组件错误。

从develop的`c7f79548a904e85f06f7738e44eafdd1ae20a9a9`创建`feature/v0.4.0-unit-barcodes`，新版本0.4.0；缓存、合成测试运行目录及发布辅助脚本仅放`artifacts/cache/0.4.0/`，交付`artifacts/releases/0.4.0/`，不访问真实var，保留main、旧标签及产物。

实施约定：主档显式quantity／unit模式，旧主档保留quantity，页面新建默认unit；unit以瓶／件为基本单位，仅整数，旧存量不盲目拆瓶。无业务记录主档可带版本和原因切换，历史补码本版不做。合格验收、期初和盘盈在库存同事务按N件生成N码，单次最多1000；发放／盘亏必须指定同批在库具体单件，验收冲正检查原始那些单件。继续批次均价金额，不声称每瓶固定采购成本。申请仍不预占，发放确认才扣库；不实现开瓶余量、部分发放或退回。

全局规则默认`LAB-{YYYY}{MM}{DD}-{SEQ}`、补零6位，日期按UTC，全局流水递增且不按日期重置；更新规则须主档权限、原因及版本，旧码不变，包装码／单件码不可相互占用。标签复用现有ZXing生成Code128及QR，不加依赖。备份升schema4，包含单件、规则序号及关联，严格兼容schema1/2/3。后续交付继续包含源码、双架构镜像、两TAR、YML和GitHub Release；完成及验证证据按实际追加，不把计划写成已发布。

源码阶段22个JS语法通过；全量99项98通过、1个默认Docker条件跳过、0失败；最后后端修正后materials31/31再次通过。前端VM36/36、scanner12/12；真实Edge单件业务16/16、8张桌面/390px截图已目视，六张实际ZXing条形码/QR图片均解回对应单件码，扫码输入为排队文本替身，不冒充物理相机验收。已修复编号输入截断、标签晚生成窗口和冲正记录标签查询问题。Compose三场景配置解析通过，正式容器、升级与发布验证在冻结后执行；本机Docker不可用，实际容器使用GitHub runner，结果按实际追加。

[0.4.0 Release](https://github.com/HotLL233/labmg/releases/tag/v0.4.0) 已公开为验证版（prerelease，ID `415684237`），源码冻结 `9c71e78dd5719334e3fbed788af60f2d9e333d62` / `v0.4.0`；ZIP SHA-256 `b6a7c772518c595b505c8fb0c7a405b66d9ce13e9350b6bbdead811af68faa75`。Actions `39018534208` 的95项业务测试通过并构建双架构镜像 `ghcr.io/hotll233/labmg:0.4.0`，索引 `sha256:6bf41c3d391ea912b1c1085036780abb5250164d3daf3bf346289a36ba7de74f`，已从成功原始job日志独立核对。main、旧标签与旧产物保留，冻结后只补记录，不重打归档或移动标签。

GitHub Ubuntu runner `39018688259` / ops `7a3efd5865a1729e503e834dd480801aaa0189cf` 三gate通过：空凭据双架构匿名拉取与正式Compose专项、0.3.3原YML／项目／卷／UID-GID仅换镜像的amd64升级15/15、双TAR冻结容器专项（含新增单件验收、指定件发放及重建持久化，ARM64使用QEMU）。升级保留旧账、账号、权限、包装码、位置及历史发放，验证新单件、全局序号、源验收冲正、重启幂等、旧schema3用户名映射恢复且不补码；云端schema4为导出检查，完整schema4恢复由源码后端测试覆盖。隔离容器／卷清理为0、合成凭据删除。

附件与匿名公开核验均通过，详细摘要及边界见项目记忆与版本说明。

目标手机、物理群晖、ARM64升级及长期并发容量未实机验收；HTTP实时相机须改用可信HTTPS。本版不做旧存量补码、开瓶余量或同一领用申请的部分发放。旧物资保持数量模式，升级沿用原YML及数据源，仅更新镜像，先停服完整备份；回退恢复升级前完整数据副本。



## 0.3.3 手机扫码出入库

从 `400f19e` 创建 `feature/v0.3.3-material-scanning`。用户确认同时支持现有外包装条码及系统库存批次二维码。版本为 0.3.3，测试和构建缓存只放 `artifacts/cache/0.3.3/`，正式交付放 `artifacts/releases/0.3.3/`；开发运行数据使用 `var/development/0.3.3/`。保留旧标签、产物、main 和真实数据。

扫码复用原有流程：入库先解析物资，再分页选择剩余待验收明细，重新读取版本后填写数量、金额；领用选择完整库存批次后申请，仍由 MATERIAL 确认发放。相机、图片识别及 QR 生成共用固定版本 `zxing-wasm@3.1.5`，JS/WASM 由本站两个明确静态 URL 提供，图片不上传、无需 CDN。识别内容作为数据精确查找，不执行或打开其中 URL。包装码绑定/解绑复用 ADMIN/MATERIAL 加主档维护权限，必须原因并审计。

完整批次码包含主档 ID/编码、区域、仓库、批号与有效期；不含金额、数量、令牌。打印单独窗口标签，解析时重新读取当前位置及余额。包装码保留前导零和大小写，一个物资可绑定多个码，一码只能属于一个物资；EAN/UPC 等价码可能采用13位表示，首次以扫码结果绑定。新表 `material_barcodes` 纳入 schema 3 十四表备份，严格兼容 schema 1/2；不自动给用户增加业务权限。

手机实时相机通常要求受信任 HTTPS；不安全 HTTP 保留拍照/选图和手输。扫描成功、取消、切页、隐藏及离开页面会释放摄像头，授权晚返回也会停止视频轨道。实际手机、浏览器权限及 NAS HTTPS 配置仍须在目标设备验证。

从0.3.2升级时先停服完整备份，在隔离副本验证；继续使用原 YML、项目名、原卷/挂载及 UID/GID，仅更新 `LABOS_IMAGE=ghcr.io/hotll233/labmg:0.3.3` 后拉取重建。新 YML 默认新卷仅供首次安装；旧版不能恢复 schema 3，回退须恢复升级前完整数据副本。本轮继续交付公开双架构镜像、离线 TAR、YML、源码 ZIP 和 GitHub Release，发布与测试结果按实际追加，不移动旧标签或重打已冻结产物。

[0.3.3验证版](https://github.com/HotLL233/labmg/releases/tag/v0.3.3) 已公开（ID `415656980`），冻结提交 `fe4d6f4` / `v0.3.3`。Actions `39013421657` 的79项回归及双架构发布成功；正式索引为 `sha256:0ef478536f41367916e5966cf0f1381f8f561d3b2060c610656a591ec0be18c6`。本机Docker因内存不足不能启动，使用独立运维分支的GitHub Ubuntu运行器 `39015392030` 验证：空凭据双架构实际拉取和正式Compose专项通过，0.3.2原配置同卷升级15/15通过，双TAR冻结专项通过并由运行器直接上传，ARM64为QEMU模拟。十附件摘要/大小及八份非TAR匿名下载已核验，真实var未访问。

本机 `artifacts/releases/0.3.3/` 保留八份非TAR附件（含源码ZIP），两TAR在上述Release；大artifact两种本机下载方式均超时，部分文件仅作诊断，不计完整下载。原始云端报告、官方小artifact校验及来源、上传和公开验证记录在 `artifacts/cache/0.3.3/`。同一run/运维提交、冻结源码、镜像索引及十附件ID/摘要核对后才公开，不把云端结果记成本机Docker验收。物理手机、实际NAS、ARM64升级及长期容量仍须目标环境确认。

## 0.3.2 位置与领用

从 `8d214e2` 建立 `feature/v0.3.2-material-improvements`。用户先要求参考开源逻辑完善现有流程，随后要求增加存放位置和物资领用，并明确选择“人员申请，物资管理员发放”。源码版本为 0.3.2，运行/测试/构建缓存统一使用 `artifacts/cache/0.3.2/`，开发数据为 `var/development/0.3.2/`；已发布版本及稳定 main 保留。

本版范围是批次余额及精确流水、批次存放位置、单物资单批次领用申请、物资管理员发放/驳回及本人取消。申请不预占；发放在事务内重新核对余额，采用整数数量和金额，按当前批次金额比例四舍五入，领完精确扣完，保留来源流水。存放位置为每个“物资+仓库+区域+批号+有效期”独立的文字位置，不替代区域；本轮未实现同批次多货架拆分、部分发放或申请自动预占。

业务权限新增位置维护和领用发放；ADMIN/MATERIAL 加对应权限可维护位置，发放和驳回须 MATERIAL 角色及 `materials.issue.write` 权限，ADMIN 本身不能办理。普通人员仅看本人领用并可取消本人待发放申请。仅严格等于原默认集合的 MATERIAL 角色一次性补权限，自定义或已撤销的权限不自动扩大。数据库扩展保留旧业务数据；物资完整备份升级为 schema 2，并支持旧 schema 1 的空新表迁入。

0.3.1 升级到 0.3.2 前，先停服并完整备份原数据卷或运行目录及部署配置，在隔离副本验证；沿用原 YML、项目名、挂载源及 UID/GID，仅更新 `LABOS_IMAGE=ghcr.io/hotll233/labmg:0.3.2` 后拉取并重建。旧 YML 的 0.3.1 卷名保持不变，只有首次安装才使用新版 YML 默认的 0.3.2 新卷。升级会扩展物资表结构；旧版不支持 schema 2，回退必须恢复升级前完整数据副本，不能仅切回旧镜像或把新版业务备份交给旧服务。

本次发布交付源码 ZIP、`v0.3.2` 版本标签、GHCR 双架构镜像及按架构导出的离线 TAR、校验清单和配套部署文件，产物目录为 `artifacts/releases/0.3.2/`。源码冻结后从同一快照构建和验证，保留历史标签及产物。构建、发布、匿名拉取及容器验证结果以 [0.3.2 Release](https://github.com/HotLL233/labmg/releases/tag/v0.3.2)、对应 Actions 和版本说明的实际记录为准；部署配置本身不证明发布已成功。

已冻结 `d261a94` / `v0.3.2`，Actions `39009929050` 成功；正式镜像双架构匿名拉取、配套 Compose、两份离线 TAR 冻结容器专项及 amd64 同卷升级验证通过，ARM64 容器为模拟运行。[公开 Release](https://github.com/HotLL233/labmg/releases/tag/v0.3.2) 十件附件已核验大小和摘要，八份非 TAR 附件经官方 API 匿名完整下载通过；未额外重复下载大 TAR，未在目标 NAS 或长期负载验收。冻结后的发布记录另行提交，不重打 ZIP/TAR 或移动标签。

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

## 0.5.1：IP HTTPS 配置补丁（2026-10-19）

0.5.0 已冻结于 `372069ce0f1f334ab1041ba449e71c56d9232c7f` / `v0.5.0`。镜像构建及真实云端匿名拉取、原0.4.0挂载升级18项和双TAR容器检查通过，但最终HTTPS检查发现IP无SNI经Docker NAT后无法选中证书，Release保持未公开草稿。旧标签、ZIP、镜像与证据保留，不能修改旧标签来掩盖该结果。

新分支 `feature/v0.5.1-https-ip` 修复 Caddy `default_sni`，继承全部0.5物资功能、schema5、生产固定runtime及原挂载升级方式；只调整补丁版本、配套部署和文档。工作流明确使用已验证的Compose5.5.1，避免runner默认CLI省略字段造成配置测试误报。新版本缓存／合成运行目录使用 `artifacts/cache/0.5.1/`，交付使用 `artifacts/releases/0.5.1/`，旧数据与产物不搬迁。真实无SNI HTTPS和完整交付结果见下文，不以配置测试代替。

源码阶段27个JS语法、全量122通过／1个Docker条件跳过／0失败（共123项）；src业务未变，先前0.5.0的Edge和打印PDF记录保持原报告身份。后续发布必须实际重跑匿名拉取、原挂载升级、双TAR和无SNI可信HTTPS，不因补丁较小跳过交付。

实际交付已完成：[0.5.1验证版](https://github.com/HotLL233/labmg/releases/tag/v0.5.1) 公开，Release `416860635`，冻结提交 `60f96393e3307bab55da3250c11ab777a9e46f04` / `v0.5.1`。构建 Actions `39192642471` 的119项回归全通过；公开镜像 `ghcr.io/hotll233/labmg:0.5.1` 索引 `sha256:470fb6b01183a6adc1f3f8a080d6cb4195bc0cef0ce5df2a662f96f5c06fd537` 已与成功原始job日志核对。

验证 Actions `39193510875` / 运维提交 `c66e6603d08a897c2b39db28fbb85fa165480514` 四项门禁全通过：双架构匿名拉取及正式Compose生命周期；amd64原0.4.0 YML／项目／挂载／UID-GID仅换镜像升级18项（含补录、XLSX和schema4/5恢复）；双架构TAR容器专项，ARM64使用QEMU；真实Caddy无SNI且严格验证隔离CA的HTTPS首设、同源检查、同账号及重建保留CA。0.5.1首次云端helper误读未返回的username，改验实际返回的用户id后重跑通过，未改源码或冻结产物。

14份附件及13条SHA256SUMS一致，12个非TAR附件官方API匿名完整下载通过；两TAR由同run验证并上传，本机未全量下载。小证据包官方摘要核对及6项导入通过，原报告在 `artifacts/cache/0.5.1/`。目标NAS、手机、ARM64升级、USB打印和BarTender实际运行仍未验收；网页浏览器与常规下载链接未另验证。发布后仅补文档，附件文档保留冻结快照，不重打ZIP、不移动v0.5.1；0.5.0继续保留未公开草稿。已有部署保留原数据与YML，仅更新镜像，升级前先完整备份。

## 0.5.0：期初单据、位置与标签（冻结候选，未公开发布）

用户要求验收时填存放位置、库存页直接领用、恢复期初入口并支持 Excel 导入导出、入库生成逐件码、标签模板与打印。确认 USB 连接 DL-886A（NEW），标签尺寸未定，手机仍通过 HTTP 群晖 IP 访问。随后提供 BarTender 安装路径 C:/Program Files/Seagull/BarTender Suite；只读核实 bartend.exe 为 2016 R7（11.0.7.3146），未调用打印机或执行其他工具。复用已有驱动，提供网页标签与逐件 CSV 文本数据库，复杂模板在 BarTender 设计，不直接连接正在运行的业务 SQLite。

补录决策：用户明确允许物资管理员在期初关闭后补录原有库存，必须原因并保留流水。此决定替代旧版关闭后不再能补录的限制；保留全局期初关闭状态，新增补录单作为正向库存调整入账，不回开期初，也不自动将旧期初草稿转为补录。

已从维护提交 41242ed 创建 feature/v0.5.0-material-intake-printing，业务版本 0.5.0；缓存／合成运行目录集中 artifacts/cache/0.5.0，交付集中 artifacts/releases/0.5.0。main、旧标签、旧产物与真实 var 保留。实施期初草稿与原子入库、严格 XLSX 解析、schema5 备份兼容、位置版本检查、永久入口及打印导出。HTTP 摄像头限制需可信 HTTPS，新增可选本地 CA 代理与手机证书步骤；不能写成已在用户手机解决。源代码、容器与发布结果后续按实际追加。

源码阶段全量 123 项中 122 通过、1 个 Docker 条件跳过、0 失败；27 个 JS 语法通过。最终物资后端 37/37（全量内），补充异步解析后会话／权限重读回归，新增 ZIP 边界专项复过；前端 VM 40/40，scanner 14/14，labels 10/10，Compose 与 HTTPS 配置各 1 项通过。真实隔离 Edge 业务 18/18、标签 19/19，10 张桌面／390px 截图已目视；实际 ZXing 的 6 张标签图均解回对应编码，70×45mm 打印 PDF 为 3 件 3 页且页面尺寸一致。这些使用合成数据与桌面浏览器，不等于手机、NAS 或 USB 物理打印验收。 正式容器、升级与发布结果将在冻结后追加。

## 物资管理设计历史

2026-10-17 的[物资申报、验收与库存方案](MATERIAL_WORKFLOW.md)与[离线 HTML 原型](prototypes/material-workflow.html)位于 `docs/`，本轮在 `feature/material-workflow-design` 隔离制作，供业务与界面评审。原型使用内存模拟数据，刷新还原，未接入正式页面、API 或数据库；XLSX 按钮仅示意。

用户同日补充分类与归属区域选择，并将提交后全员不可编辑改为仅物资管理员可修订；后续在 `feature/material-classification-editing` 更新方案与原型，保留原提交版及修订原因/历史。分类与区域选项建议由 ADMIN 或 MATERIAL 维护；提交后编辑仍明确要求 MATERIAL，区域与仓库、创建者分别保存，建议库存按物资+仓库+区域合并。

设计阶段将独立单据/明细、分类/区域字典、原提交快照与受控修订、物资管理员角色约束、验收入库事务与幂等、库存流水、期初切换和备份恢复列为正式实施范围。上述要求已由本轮 0.3.0 正式业务实现补充；原型仍只作历史示例，不替代正式页面。设计阶段未改写的 `0.2.0-rc.5` 版本、镜像和标签继续保留。

## 运行与检查

先准备独立 PostgreSQL 开发数据库；应用账号需有目标库的建表权限。在项目根目录用 PowerShell 7 运行：

```powershell
npm ci --omit=dev --ignore-scripts
$env:DATABASE_URL = 'postgresql://labos@127.0.0.1:5432/labos_development'
npm run check
npm run dev
```

连接地址须替换为自己准备的开发数据库，认证凭据按该 PostgreSQL 实例配置；不要把真实口令提交到仓库。`npm run check` 检查全部 JavaScript 语法，不代替业务、权限或并发测试。

测试需要专用 PostgreSQL 实例，以及可以创建和删除临时数据库的测试账号：

```powershell
$env:LABOS_TEST_DATABASE_URL = 'postgresql://labos_test@127.0.0.1:5432/postgres'
npm test
```

`npm test` 运行真实 PostgreSQL 隔离 HTTP/数据库回归、按真实脚本顺序加载的前端 VM 检查和版本化打包测试；测试按用例创建随机库并清理，源码副本及缓存统一位于 `artifacts/cache/<version>/`。`LABOS_TEST_DATABASE_URL` 必须指向专用测试实例，不得指向日常业务库；缺少配置时数据库回归报错，不静默改用 SQLite。VM 检查不代替真实浏览器验收。

开发模式默认监听 3001 端口，附件和日志放在 `var/development/<package.version>/`，例如 `var/development/0.6.0/`。数据库完全由 `DATABASE_URL` 决定，运行目录和 Git 分支不会隔离 PostgreSQL，须为开发、测试和日常使用分别准备数据库；不会自动复制旧开发版本的数据。`npm start` 默认监听 3000 端口，附件和日志默认放在 `var/`。

`LABOS_RUNTIME_DIR` 决定附件、日志等运行文件的根目录，`PORT` 决定端口；它们不替代数据库连接。需要自定义时通过进程环境变量设置，建议给运行目录使用绝对路径。例如：

```powershell
$env:LABOS_RUNTIME_DIR = 'C:\labmg\var\scratch'
$env:DATABASE_URL = 'postgresql://labos@127.0.0.1:5432/labos_scratch'
$env:PORT = '3002'
npm start
```

`config/.env.example` 仅供参考，不会自动加载。空数据库默认首次打开网页设置管理员账号和密码（8–1024 字符、不能全为空白、需确认），没有默认密码。已有任意用户时初始化入口关闭；升级后继续使用原账号。首次设置完成前只允许可信人员访问服务。

如自动化部署确需预设，仍可把非空 `LABOS_ADMIN_PASSWORD` 与可选 `LABOS_ADMIN_USER` 传给启动进程，仅在零用户时创建管理员；默认 Docker Compose 不传密码。不要将真实口令写回示例或提交到 Git，初始化变量不等于修改已有账号的密码。

### 历史：0.2.0-rc.1 SQLite 兼容性

以下保留当时的升级行为，不适用于 0.6.0 新 PostgreSQL 部署。

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

部署包保留 `.github/`、`src/`、`scripts/`、`config/`、`deploy/`、`docs/`、`tests/` 及必要根文件；先准备 PostgreSQL、配置 `DATABASE_URL` 并安装依赖，再在解压后的根目录执行 `npm start`，或运行 `start-labos.cmd`。包中不应包含本地数据库、附件、日志、真实环境配置和构建缓存。

### GHCR 多架构发布

0.6.0 Compose 使用版本镜像 `ghcr.io/hotll233/labmg:0.6.0`，发布状态见GitHub Release。新部署使用配套的应用、PostgreSQL 与一次性初始化三个服务；数据、自动生成的连接口令与附件保存在固定 `runtime/`。具体部署、停服备份与恢复见 [群晖部署](SYNOLOGY.md)。后续 PostgreSQL 版本更新须保留原数据路径、秘密文件和数据库主版本；不能把“仅换应用镜像”当作数据库主版本升级流程。

GitHub Actions 在推送 `v*` 标签时构建并推送 `linux/amd64`、`linux/arm64` 多架构镜像。标签版本须与 `package.json` 相符；例如 `v0.2.0-rc.3` 对应 `ghcr.io/hotll233/labmg:0.2.0-rc.3`。镜像写入版本及源码提交 OCI 标签，发布凭据由工作流的 `GITHUB_TOKEN` 提供。失败运行可在 Actions 页面重新运行，不要求部署用户持有 GitHub 凭据。

rc.3 首次推送后未生成运行记录，具体触发原因未确定。后续独立 CI 提交增加手动入口，默认分支设为 `develop` 供 GitHub 发现工作流，稳定 `main` 内容保持 0.1.1。选择“Run workflow”的 `develop`，输入已存在的标签（如 `v0.2.0-rc.3`），流程固定检出该标签并验证提交，不把 CI 分支的新提交当作发布源码。已生成的 rc.3 ZIP/TAR 和标签不改写，该入口归入后续 CI 变更。

维护者发布后须确认 GHCR 包可公开访问，并在没有镜像仓库登录凭据的环境验证该版本的多架构清单和拉取。工作流文件、成功构建、包公开及匿名拉取是不同检查项，结果以实际运行和外部状态为准。

rc.3 已由运行 `38855576508` 构建发布，用户设置包 Public 后完成匿名双架构拉取及正式 YML 启动验证。Registry 检查使用完整的 OCI 索引媒体类型 `application/vnd.oci.image.index.v1+json`；缺失 `.v1` 时 GHCR 也返回 404，不能据此判断标签不存在。后续 CI 跟进修正该类型并保留已有版本校验。

#### 历史：0.4.0 至 0.5.1 的 SQLite 部署模板

以下保留 2026-10-19 的历史模板决策与升级规则，0.6.0 已改用 PostgreSQL，不能按本段从旧 SQLite 直接更换镜像。

2026-10-19 用户要求原地升级并让数据可在 YML 同目录找到。当时仓库后续 `deploy/docker-compose.yml` 改为固定的 `./runtime` bind，两个服务通过 `create_host_path: true` 自动创建并共用该目录；`runtime/data` 保存 SQLite，`runtime/uploads` 保存附件，`runtime/logs` 为预留目录。该次模板维护继续使用已发布的 `ghcr.io/hotll233/labmg:0.4.0`，仅修订部署模板，不重打镜像、不修改旧标签或 Release 附件；后续 0.5.1 沿用该目录方式。开发、测试及构建继续版本隔离，生产数据不随镜像版本更换目录。

历史 0.4.0 及更早 Release 附件的默认命名卷仍保留原样。已有部署优先沿用原 YML/项目/挂载和 UID/GID，仅更新镜像；若换用新模板，必须先按[群晖部署](SYNOLOGY.md)在停服后将原数据完整迁入项目的 `runtime/`，或将 `LABOS_DATA_DIR` 指向原宿主机目录。创建空目录不等于迁移，不能直接改用空目录初始化。相对路径跟随 YML 的项目目录，搬动 YML 时也要搬数据或改用原绝对路径。

`labos-init` 以 root 创建运行目录、设置属主及 owner 读写执行权限后退出；`labos` 等待其成功，再按 `LABOS_UID/GID` 非 root 运行。需要支持 bind 的 `create_host_path` 和 `depends_on.condition: service_completed_successfully` 的 Compose；不使用 Swarm `stack deploy`。

已有宿主机数据须在同目录 `.env` 保留原 `LABOS_DATA_DIR` 绝对路径及 UID/GID；拼错路径可能创建空目录，部署前核对实际内容。初始化只处理根、`data/`、`uploads/`、`logs/` 四个目录，不递归改已有数据库和附件。普通 `docker compose down` 保留数据；日常升级不要用 `down --volumes` / `down -v`，历史命名卷仍可能被该选项删除。详细备份和迁移见 [群晖部署](SYNOLOGY.md)。主配置保留 Compose 3.8 形式，不设置 `pull_policy`；旧 Compose 是否支持上述配置须以实际部署工具为准。

### Docker 离线镜像包

```powershell
npm run package:docker
```

该命令先生成并校验同版本源码 ZIP，再从这个快照构建 `linux/amd64` 和 `linux/arm64` 镜像，使用 `docker save` 导出 TAR。镜像标签为 `labos:<version>`，版本和源码提交写入 OCI 标签；每架构有独立 TAR 与 JSON 校验清单，部署时只导入适合目标架构的一份。YML、环境示例和群晖说明另放发布目录，便于直接取用。

导入并核对同版本 TAR 后，在部署 `.env` 中设置 `LABOS_IMAGE=labos:<实际版本>`（0.6.0 构建目标为 `labos:0.6.0`），使用本地标签。应用 TAR 不包含 PostgreSQL 镜像；完整离线部署还需提前导入匹配目标架构的 `postgres:17-bookworm`，启用 HTTPS 时另需配套 Caddy 镜像。全部所需镜像已导入时跳过 `docker compose pull`。默认 GHCR 名称与离线 TAR 名称不同，导入镜像不会自动修改 YML 的镜像选择。rc.2 / rc.3 历史 TAR 仍使用对应版本标签及原初始化配置，rc.4 仍使用该版本绑定目录及网页首设方式。

需要运行中的 Linux Docker 引擎、Buildx 与跨架构构建支持；仅打源码 ZIP 不需要 Docker。PowerShell 可用 `scripts/package-docker.ps1 -Architectures amd64` 只导出一种架构。构建阶段、镜像临时导出和每架构本地层缓存均放在 `artifacts/cache/<version>/`；Docker 内部存储仍由引擎管理。后续版本可复用最近版本的对应架构缓存，旧发布包不可覆盖。

应用镜像的运行目录固定为 `/var/lib/labos`，Compose 默认挂载 YML 同目录的 `runtime/`，也可显式设置独立的宿主机目录；通过 `LABOS_UID/GID` 指定应用运行用户，两者须为 1–2147483647 的整数。初始化拒绝符号链接及非目录，准备附件、日志及秘密目录、一次性生成数据库连接口令，不加载业务服务；PostgreSQL 容器自行初始化和管理 `postgres/` 目录。已有 PostgreSQL 数据却缺失秘密文件时拒绝启动，不重新生成不匹配的口令。构建上下文只允许源码和包信息，并排除其中意外存在的环境文件/数据库/附件等。镜像不会包含本机真实业务数据或管理员口令。直接 `docker run` 时须自行准备可写存储和 PostgreSQL 连接；自动初始化属于 Compose 项目启动流程。

`tests/docker.test.js` 只有设置 `LABOS_DOCKER_IMAGE` 时才运行真实容器检查；普通 `npm test` 会明确跳过该项。例如在镜像已构建后：

```powershell
$env:LABOS_DOCKER_IMAGE = 'labos:0.6.0'
node --test tests/docker.test.js
Remove-Item Env:LABOS_DOCKER_IMAGE
```

该检查在 `artifacts/cache/<version>/docker-test-*` 使用独立 Compose 项目、YML 副本及旁边的 `runtime/`，验证自动创建、数据库健康依赖、非 root、首次设置、登录和业务数据在容器重建后的持久化；不使用日常业务库或真实 `var/`。清理只针对有本次项目标记的临时目录。`tests/compose.test.js` 另用 Compose CLI 做不依赖 Docker 引擎的配置解析检查；配置解析不等于实际容器或 NAS 验收。NAS 的实际 DSM/内核/目录权限和容量还需在目标设备确认。具体部署步骤见 [群晖 Docker 部署](SYNOLOGY.md)。

切回历史标签或部署旧版本前，先停止服务，备份完整运行目录及当前部署配置。历史版本的数据目录和启动方式可能不同，应按该版本说明运行；新旧版本不要共用生产数据目录。恢复代码不代表恢复数据，数据库兼容性也需要单独验证。
