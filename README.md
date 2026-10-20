# LabOS 实验室综合管理系统

本源码版本：**0.8.1（打印修复开发中）**，针对纸张、横纵方向、预览和Windows助手启动修复，增加可选的登录后台方式。当前尚未冻结发布；0.8.0已公开为验证版，历史镜像、部署文件与记录保留。实际验证与边界见[版本说明](docs/CHANGELOG.md)。

本轮交付目标继续包含两份完整YML、amd64／arm64三镜像TAR、Windows打印脚本、指南和摘要，使用独立`artifacts/releases/0.8.1/`。构建与硬件状态按真实结果补记；不以替身COM或网页预览代替BarTender许可、纸张送料与USB验收。打印设置见[操作指南](docs/BARTENDER_AGENT.md)。

系统使用 Node.js、PostgreSQL 和静态前端，覆盖档案、模板、财务、设备、物资、体系文件、人员和合同管理。用户明确本轮不用考虑旧库，按全新 PostgreSQL 18 部署处理，不提供旧版数据库迁移，也不读取或删除旧数据库文件。稳定分支 `main` 仍保留 0.1.1。

## 本机运行与开发

需要 Node.js 22.13+（建议 24）及单独准备的 PostgreSQL 18 数据库。应用账号需有目标数据库的建表权限。Windows 命令统一用 PowerShell 7。

```powershell
npm ci --omit=dev --ignore-scripts
$env:DATABASE_URL = 'postgresql://labos@127.0.0.1:5432/labos_development'
npm run check
npm run dev
```

连接地址须替换为自己创建的开发数据库，并按该 PostgreSQL 实例的认证配置提供凭据。不要把真实连接口令提交到 Git。`config/.env.example` 只供参考，普通 Node 启动不会自动加载它。连接未配置或不可用时应用报错，不回退为新的 SQLite 空库。

开发默认地址为 `http://127.0.0.1:3001`，附件和日志放在 `var/development/0.8.1/`；数据库位置由 `DATABASE_URL` 决定。Git 分支或运行目录不会自动隔离 PostgreSQL，开发、测试和日常使用必须连接不同数据库。`npm start` 默认端口 3000，附件和日志默认放在 `var/`。

空数据库首次打开网页时设置管理员账号和密码，密码至少 8 位且需确认；没有默认密码。已有用户时不会开放首次设置。

测试另需专用 PostgreSQL 实例及可创建临时数据库的测试账号：

```powershell
$env:LABOS_TEST_DATABASE_URL = 'postgresql://labos_test@127.0.0.1:5432/postgres'
npm test
```

测试按用例创建和清理隔离数据库，缓存放在 `artifacts/cache/0.8.1/`。该变量必须指向专用测试实例；不得填日常业务数据库。测试与容器、真实浏览器及群晖验收的边界见[开发说明](docs/DEVELOPMENT.md)和[版本说明](docs/CHANGELOG.md)。

## 物资信息与库存

“物资主档”就是同种物资的标准信息，在页面中称为**物资信息库**，保存编码、名称、规格、单位、分类和管理方式。它不代表已经有库存；库存数量由期初、验收、调整和领用流水累计。相同名称但规格或单位不同的物资分别保留。

申报时先选择区域和仓库，按中文名称或规格检索，所选范围有库存的物资优先显示；已有物资用完后仍复用原信息，不因零库存重复建档。确认没有匹配项时可以填写新物资并提交，验收前由具有维护权限的管理员确认建档或关联已有信息。0.7.0 页面将程序编码显示为只读，后端自动分配；中文名称、规格和单位共同确定身份，同名不同规格不混合。已提交单的关联仍由物资管理员填写原因修订，保留原提交与修改历史。

物资信息库支持下载 XLSX 模板、导入和导出。**导入物资信息只建立标准信息，不增加库存、不生成实物条码。** 带数量、金额和存放位置的旧有实物，从“期初库存”或期初关闭后的“存量补录”导入草稿，核对并确认入库后才记库存；补录必须原因并保留流水。逐件管理物资按实际入库整数数量生成一瓶／一件一个固定码。

0.7.0 模板使用物资、分类、区域、仓库和管理方式的中文引用列表；导入错误返回工作表、实际行列、字段、输入值与原因，并在原表单中逐条显示。每类参考列表最多带 5000 条，本次导出涉及的数据优先；超过列表容量时允许手填已有中文名称，导入仍由服务端核对身份与权限，不限制整个信息库只能有 5000 条。物资名称、规格、单位须组合匹配同一物资。

仅库存与物资信息库要求导出回导：信息库原样回导复用已有信息，库存按批次复制到草稿，核对后才确认入库；再次导入库存并非自动去重或恢复历史账。申报、验收和领用 Excel 保持历史报表，不回放业务动作。导入先完整校验，错误整批不写；工作簿解析后再次验证登录与操作权限。

物资页保留“申报 / 验收 / 库存 / 期初库存 / 领用”五个入口。全员可建申报单、添加本人草稿明细；提交、验收、已提交单修订及领用发放需要 **MATERIAL（物资管理员）** 角色及对应动作权限，只有 ADMIN 角色不能代办。分类、归属区域和物资信息由有对应维护权限的 ADMIN/MATERIAL 管理。

库存按物资、仓库和区域合并，保留批次、有效期、存放位置和来源；领用由人员申请，物资管理员确认发放才扣库存。逐件管理发放时选择具体在库实物；申请不预占库存，不支持开瓶余量或同一申请部分发放。接口与 Excel 规则见[物资 API](docs/MATERIAL_API.md)。

## Docker 与群晖

两份 YML **任选一份**，都包含初始化、PostgreSQL 18、应用和 HTTPS 代理四个服务，无需另外准备 `.env` 或 `Caddyfile`：

| 部署方式 | 文件 | 镜像来源 |
| --- | --- | --- |
| 在线拉取 | [docker-compose.yml](deploy/docker-compose.yml) | 应用从 GHCR 拉取，PostgreSQL 和 Caddy 使用官方镜像 |
| 本地导入 | [docker-compose.local.yml](deploy/docker-compose.local.yml) | 先导入本架构 TAR 内的三个镜像，所有服务禁止拉取 |

发布后从同版本 Release 下载配套文件，在所选 YML 中把 `CHANGE_ME` 改成群晖实际 IPv4 或主机名，例如 `192.168.1.10`，不带协议、端口或路径。首次安装用独立目录，不指向 PG17／SQLite 旧库；已部署 PG18 的同项目更新保留原数据与证书目录，不重新初始化。本次不提供 PostgreSQL 主版本迁移。

数据自动保存在 **YML 同目录的 `runtime/`**：`postgres/18/docker/` 是 PG18 数据，`uploads/` 是附件，`secrets/postgres-password` 是自动生成的数据库口令。HTTPS 证书保存在旁边的 `https/data/`，代理自动创建内部目录。后续同一 PG18 项目更新时保留完整 `runtime/`、`https/`、项目和 UID/GID。备份及操作步骤见[群晖部署](docs/SYNOLOGY.md)。

每架构离线 TAR 包含应用、PostgreSQL 18 和 Caddy 三个镜像；导入一份后使用本地 YML，服务无需联网拉取镜像。发布状态与实际验证以 Release 为准。

## 打印与手机扫码

网页标签支持毫米尺寸、字段布局、偏移与模板 JSON 导入导出；内置 DL-886A（NEW）面板可选起止张、试打首张并打开系统打印窗口。0.8.0 另增“BarTender 打印”：手机或电脑选择实物与母版，由 USB 所在 Windows 的助手领取任务，调用已授权的本机引擎。重印沿用固定码并记录原因，断线结果不明时不会自动重印。安装与母版派生见[打印助手指南](docs/BARTENDER_AGENT.md)，原网页与 CSV 见[标签打印](docs/LABEL_PRINTING.md)。真实授权、纸张校准与 USB 出纸尚未验收。

手机实时相机需要受信任的 HTTPS、系统与浏览器相机授权；普通群晖 IP 的 HTTP 地址保留拍照／选图和手输。可按[扫码 HTTPS 配置](docs/SCANNING_HTTPS.md)启用 Caddy 并在手机信任证书。实际 NAS、手机及 USB 标签打印仍需现场确认。

## 目录与版本管理

| 路径 | 内容 |
| --- | --- |
| `src/` | PostgreSQL 数据库模块、服务端和静态前端 |
| `scripts/` | 检查和打包脚本 |
| `tests/` | 真实 PostgreSQL 隔离回归、前端与打包检查 |
| `config/`、`deploy/` | 本地环境示例、Dockerfile 与正式 Compose |
| `docs/` | 记忆、开发记录、版本说明与操作文档 |
| `var/` | 本地附件与日志，不提交 |
| `runtime/` | Compose 项目旁的数据库、附件和秘密文件，不提交 |
| `artifacts/releases/<version>/` | 冻结交付产物，不提交 |
| `artifacts/cache/<version>/` | 按版本隔离的构建与测试缓存，不提交 |

`main` 保存发布基线，`develop` 与 `feature/*` 用于开发；标签与旧产物保留。`npm run package:zip` 和 `npm run package:docker` 使用实际包版本生成产物；源码冻结后补文档不重打归档或移动旧标签。Docker 打包需要运行中的 Linux Docker 引擎与 Buildx。

开发约定见 [DEVELOPMENT](docs/DEVELOPMENT.md)，长期记录集中在 [MEMORY](docs/MEMORY.md)、[HISTORY](docs/HISTORY.md) 和同一份 [CHANGELOG](docs/CHANGELOG.md)。

## 已发布历史

[0.5.1](https://github.com/HotLL233/labmg/releases/tag/v0.5.1) 于 2026-10-19 公开为验证版，冻结提交 `60f9639` / `v0.5.1`。[镜像构建](https://github.com/HotLL233/labmg/actions/runs/39192642471)及[最终验证](https://github.com/HotLL233/labmg/actions/runs/39193510875)成功，涵盖双架构匿名拉取与正式 Compose、0.4.0 原配置同挂载 amd64 升级 18/18、双 TAR 检查和严格验证证书的无 SNI HTTPS 生命周期；ARM64 使用 QEMU。14 件附件摘要一致，12 个非 TAR 附件经官方 API 匿名完整下载；TAR 在云端验证上传，本机未全量下载。这些是 0.5.1 的 SQLite 交付结果，不作为当前 PostgreSQL 版本的验收结果。

0.5.0 因真实 IP 无 SNI 的 HTTPS 握手问题保留为未公开冻结候选，由 0.5.1 补丁替代，其标签、ZIP 与草稿 Release 不改。已公开的 0.4.0 及更早版本、原部署说明与验证边界继续保留在版本记录和[群晖文档的历史部分](docs/SYNOLOGY.md)。
