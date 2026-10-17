# 群晖 Docker 部署

本文部署步骤对应 `0.3.2`（批次位置与领用）。镜像、源码 ZIP、两架构离线 TAR 和配套文件是否可用，以及构建、匿名拉取和验证结果，以 [0.3.2 发布页](https://github.com/HotLL233/labmg/releases/tag/v0.3.2)、对应 Actions 和[版本说明](CHANGELOG.md)的实际记录为准；确认所需产物可用后再部署。仓库 `deploy/` 与本版配置一致。应用使用 SQLite 和本地附件，无需 PostgreSQL 或 MinIO。

本版沿用 rc.5 的 Docker 管理的数据卷，自动准备运行目录，无需先在 NAS 手工创建数据文件夹。YML 有两个服务：`labos-init` 以 root 一次性准备目录，成功后退出；`labos` 以非 root 用户运行应用。空数据库首次打开网页时设置管理员密码，没有默认密码。

推荐使用 64 位群晖的 Container Manager 和支持 `depends_on.condition: service_completed_successfully` 的 Compose。仅声明兼容 Compose 3.8，不能保证旧套件支持本配置；先运行 `docker compose config --quiet`，若提示不支持该条件，需升级 Compose/套件。实际 DSM、内核和权限仍须在目标 NAS 验证。

## 0.3.1 升级到 0.3.2

先停止应用写入，完整备份原数据卷或运行目录（数据库及 WAL/SHM、全部附件和目录结构）以及原 YML、`.env` 等部署配置，并在隔离副本验证。确认 0.3.2 镜像可用后，继续使用原 YML、原项目名、原数据挂载及 UID/GID，只在原项目同目录 `.env` 更新：

```dotenv
LABOS_IMAGE=ghcr.io/hotll233/labmg:0.3.2
```

随后按下文命令拉取并重建。原 YML 的 `labos-runtime-0.3.1` 卷名保持不变；不要换成默认新卷、删除卷或用空环境示例覆盖原配置。若 YML 写死了镜像名，仅修改两个服务的 image，保留其他配置。**只有首次安装使用 0.3.2 新 YML 时，才默认创建 `labos-runtime-0.3.2` 新卷。**

0.3.2 自动扩展物资表结构，新增位置与领用，物资完整备份为 schema 2，并支持 schema 1 恢复到空的新业务库。0.3.1 不能读取 schema 2 备份；需要回退时必须停止新版并恢复升级前完整数据副本，再用原镜像及配置运行。只切回旧镜像不能回退数据结构，新旧应用也不能同时写同一份数据。

位置维护要求 ADMIN/MATERIAL 及对应权限；发放和驳回仍须 MATERIAL（物资管理员）角色与 `materials.issue.write` 权限，ADMIN 本身不能办理。普通人员只看本人领用、可申请及取消本人待发放申请。仅原默认 MATERIAL 权限集合会一次性补入新动作，自定义或已撤销权限不自动扩大，升级后应核对业务负责人的实际权限。

## 历史：0.3.0 升级到 0.3.1

本版修复“新物资未匹配主档不能提交”：填报完整后可提交，验收、拒收和结案前再由物资管理员在“原单 → 修订”选择已维护的主档并填写原因。保留原提交及修订历史，无新增数据库结构。

已有 0.3.0 部署先停服备份，继续使用原 YML、原项目名及全部挂载配置，只在项目同目录 `.env` 设置 `LABOS_IMAGE=ghcr.io/hotll233/labmg:0.3.1`，然后重新拉取并重建项目。0.3.0 YML 的命名卷仍保留为原来的 `labos-runtime-0.3.0`，这是原有数据位置，不能随镜像版本一起改名。若镜像被写死在 YML，则仅修改两个服务的 image，保留 volumes。不要使用 `down -v`。

以上步骤对应 0.3.1 历史版本；升级到 0.3.2 以本页上一节为准。旧版完整数据迁移与回退仍按文末步骤执行。

## 首次使用物资模块

先停服备份原数据卷或整个运行目录，在独立副本验证升级。默认卷名改为本版隔离卷；保留旧业务须继续挂载原数据源并保留 UID/GID，不能删除原 LABOS_DATA_DIR 后以为已迁移。新业务表首次为空，旧物资只读，不自动累加库存，由物资管理员盘点后登记期初。

由系统管理员维护分类、区域和主档，在账号编辑中给业务负责人增加 MATERIAL（物资管理员）角色及对应动作权限。ADMIN 本身没有提交、已提交单修订、入库或领用发放资格。全部人员均可填报和申请领用，提交后的修订须原因并保留历史；首次合格入库后期初永久关闭。

“导出与备份”中通用台账与新版物资分别备份；物资完整恢复仅允许空的新业务库，先保证同名用户存在。完整停服数据卷备份仍是升级和回退的主要保障。镜像已安装 Excel 依赖，TAR 导入后无需在 NAS 安装 Node 或 npm。

## 首次在线部署

1. 核对 [0.3.2 Release](https://github.com/HotLL233/labmg/releases/tag/v0.3.2) 的镜像和附件记录，取得同版本 `docker-compose.yml` 和环境示例；源码对应文件在 [deploy/](../deploy/)。GitHub 附件示例名可能为 `env.example`，源码中为 `.env.example`。
2. 在“Container Manager → 项目 → 新增”中选择保存 YML 的项目目录。配置文件需要一个项目目录，应用数据目录由 Docker 自动创建，不需另外准备 `/volume1/.../runtime/`。
3. `.env` 可选。需要自定义端口或用户时，将环境示例复制为项目同目录的 `.env`；首次部署保留 `LABOS_DATA_DIR` 为未设置状态。例如：

   ```dotenv
   LABOS_IMAGE=ghcr.io/hotll233/labmg:0.3.2
   LABOS_PORT=3000
   LABOS_ADMIN_USER=admin
   LABOS_UID=1000
   LABOS_GID=1000
   ```

   默认数据卷适用上述 UID/GID，无需改成 NAS 登录用户。`labos-init` 只创建并设置 `/var/lib/labos`、`data/`、`uploads/`、`logs/` 四个目录的属主及目录访问权限，不递归更改已有文件。应用继续使用 `LABOS_UID/LABOS_GID` 指定的非 root 用户；`PUID/PGID` 不控制本镜像的运行用户。
4. 使用该 YML 创建并启动项目。默认使用 `ghcr.io/hotll233/labmg:0.3.2`，镜像发布后按设备自动选择 amd64/arm64。`labos-init` 显示退出码 0 是正常完成；它失败时先查看日志并排错，应用不会启动。
5. 访问 `http://群晖IP:3000`，设置管理员账号和新密码（8–1024 字符、不能全为空白、需确认）。完成后自动登录；已有数据库使用原账号。修改端口后使用对应地址，首次设置完成前仅允许可信人员访问。

在 NAS SSH 会话进入放置 YML 的项目目录后，可逐条执行，每条成功后再继续：

```sh
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps -a
docker compose logs --tail=100 labos-init labos
```

以上是 NAS 上的 Linux 命令；Windows 侧的构建、同步命令使用 PowerShell 7。不要在开发电脑的 Docker 引擎上执行 NAS 数据维护命令。旧套件命令可能为 `docker-compose`，但仍需核对完成条件支持。Compose 的 `version is obsolete` 提示本身不影响运行。

首次安装本版 YML 的默认卷逻辑名为 `labos-runtime-0.3.2`，实际名称通常为 `<项目名>_labos-runtime-0.3.2`，隔离项目和版本。保持同一项目名及配置目录，重建容器继续使用该卷；换项目名或改用新版默认卷配置会得到另一份存储。已有部署沿用原 YML 时卷名保持原值。Docker 卷不是 File Station 中约定的普通 NAS 业务目录。

`x86_64` 设备选 amd64，`aarch64` 设备选 arm64，可在 NAS 执行 `uname -m` 核对。32 位 ARM 不在本版支持范围，ARM64 设备还须支持 Docker。

## 已有目录与旧版升级

已有数据时先保留原 YML、`.env`、数据路径和 UID/GID，再做停服完整备份。0.3.2 继续兼容显式指定的宿主机绑定目录；0.3.1 升级保留原 YML，在原 `.env` 中仅更新镜像版本，原来的真实路径保持不变，例如：

```dotenv
LABOS_IMAGE=ghcr.io/hotll233/labmg:0.3.2
LABOS_DATA_DIR=/volume1/docker/labos/runtime/0.2.0-rc.4
# LABOS_UID 和 LABOS_GID 保留旧部署的真实值
```

该路径须已存在，旧文件须允许原 UID/GID 读写。初始化服务不递归修复旧文件权限，也不自动复制、移动旧数据。原来使用相对路径时，换项目目录会改变解析位置，应核对后写成对应的绝对路径。

**不能用新版空环境模板覆盖已有部署配置。** 删除 `LABOS_DATA_DIR` 会切换到默认新卷，旧数据不会自动出现在里面。若升级后意外出现“首次设置管理员”，先停止应用并检查挂载源，不要把新空库当作旧库继续录入。

rc.2 / rc.3 旧 YML 要求 `LABOS_ADMIN_PASSWORD`，缺失时会报 `error while interpolating`；rc.4 改为网页首次设置。从 rc.4 及更早版本升级时，需配套更新 YML 和 0.3.2 镜像并明确保留旧数据源：rc.4 镜像没有本版目录初始化入口。0.3.0/0.3.1 升级可保留原 YML，仅更新镜像，并遵守本页停服备份、表结构升级和回退要求。已有账号不因升级重新开放初始化或重置密码。

`.env` 应与 YML 位于同一项目目录，真实文件名不能仍为 `env.example` 或 `.env.txt`。排错可用 `docker compose config --quiet`，只分享错误文字，不分享包含敏感信息的完整配置。

### 提示绑定路径不存在

截图中的 `Bind mount failed: '/volume1/docker/var/docker/0.2.0-rc.4' does not exist` 表示容器尚未启动，宿主机没有该挂载源。这通常来自 rc.4 相对路径 `../var/docker/0.2.0-rc.4`；实际解析位置取决于项目目录，不一定是预期的 `/volume1/docker/labos/runtime/`。

- rc.4 临时处理：在 NAS 创建报错所指的准确目录，并使实际应用 UID/GID 可写，或将 `LABOS_DATA_DIR` 改为已准备好的绝对目录。对首次部署的空目录，可由 NAS 管理员执行 `sudo mkdir -p /volume1/docker/var/docker/0.2.0-rc.4`，再对这个目录设置正确属主；不要对已有业务目录盲目递归改属主或开放 777。
- rc.5 及后续版本默认处理：首次部署使用配套新 YML，不设置 `LABOS_DATA_DIR`，由 Docker 创建本版命名卷，初始化服务设置目录权限。它不依赖上述宿主机路径，不需要手工创建数据目录。
- 已有数据继续使用 bind 时：保留真实目录，先确认目录存在、旧数据及权限正确；切换默认空卷不是迁移方案。

若本版仍显示相同旧路径，检查是否还使用旧 YML，或 `.env` 中仍保留该 `LABOS_DATA_DIR`。

## 离线导入与慢拉取

若 NAS 拉取 `ghcr.io` 慢，可使用构建电脑上已经生成的同版本 TAR，经局域网传到 NAS，避免再次公网下载。产物位于构建电脑的 `artifacts/releases/<version>/`，不随 Git 克隆提供；0.3.2 文件须以实际完成的构建及 Release 为准。

| 文件 | 用途 |
| --- | --- |
| `labos-0.3.2-linux-amd64.tar` | Intel / AMD 64 位设备 |
| `labos-0.3.2-linux-arm64.tar` | 支持 Docker 的 ARM64 设备 |
| 同名 `.json`、`SHA256SUMS` | 架构、提交、归档大小与 SHA-256 核对 |
| `docker-compose.yml`、环境示例、`SYNOLOGY.md` | 配套部署文件 |
| `labos-0.3.2.zip`、`manifest.json` | 源码及构建清单 |

只导入与 NAS 架构匹配的一份 TAR。使用“映像 → 新增 → 从文件添加”，或在 NAS 执行：

```sh
docker load -i labos-0.3.2-linux-amd64.tar
```

这是 `docker save` 镜像归档，不是容器根文件系统。两种架构的本地标签都为 `labos:0.3.2`。在项目 `.env` 中设置：

```dotenv
LABOS_IMAGE=labos:0.3.2
```

确认本地存在该标签后，跳过 `docker compose pull`，直接 `docker compose up -d`；两个服务都会使用这份本地镜像，数据卷仍按前述规则自动准备。固定版本标签在本地存在时，常规启动默认复用本地镜像；若仍指向缺失的 GHCR 标签，Compose 会尝试拉取该名称。

历史版本继续使用各自镜像和配套说明：rc.2 首先提供离线 TAR，rc.3 增加公开 GHCR，rc.4 增加网页首次设置，均不因本说明更新而改变原产物。已存在的 rc.4 TAR 每份约 81 MB；其他版本大小以各自清单为准。Docker Hub 的 `registry-mirrors` 不代理 GHCR；本说明不假定已测得 NAS 的具体网络瓶颈。

## 同步到国内镜像仓库

需要用户自己的 ACR/TCR 等目标仓库，先准备域名、命名空间及仓库推送权限。当前没有配置目标地址或凭据，下面是操作方法，不表示已完成同步。目标仓库须支持多架构索引；拟使用的 `0.3.2-amd64`、`0.3.2-arm64`、`0.3.2` 三个标签均须未占用，已有标签先核对，不覆盖。

在持有两份已核验 0.3.2 TAR 的开发电脑上使用 **PowerShell 7**。替换占位值，在仓库控制台确认三个标签未使用，再执行；每个 Docker 命令失败都会停止后续步骤。`docker login` 交互输入凭据，不把密码写进命令、文档或 Git：

```powershell
$registryHost = '<国内仓库域名>'
$namespace = '<命名空间>'
$targetRepository = "${registryHost}/${namespace}/labmg"
$releaseVersion = '0.3.2'
$releaseDirectory = 'C:\labmg\artifacts\releases\0.3.2'
if ($registryHost.Contains('<') -or $namespace.Contains('<')) { throw '先填写真实目标仓库信息' }

docker login $registryHost
if ($LASTEXITCODE -ne 0) { throw '目标仓库登录失败' }

foreach ($architecture in @('amd64', 'arm64')) {
    $archive = Join-Path $releaseDirectory "labos-${releaseVersion}-linux-${architecture}.tar"
    docker load --input $archive
    if ($LASTEXITCODE -ne 0) { throw "导入 ${architecture} 失败" }
    $inspection = docker image inspect "labos:${releaseVersion}"
    if ($LASTEXITCODE -ne 0) { throw '读取本地镜像失败' }
    $loadedImage = @($inspection | ConvertFrom-Json)[0]
    if ($loadedImage.Os -ne 'linux' -or $loadedImage.Architecture -ne $architecture -or $loadedImage.Config.Labels.'org.opencontainers.image.version' -ne $releaseVersion) { throw '镜像版本或架构不符，停止推送' }
    $architectureTag = "${targetRepository}:${releaseVersion}-${architecture}"
    docker tag "labos:${releaseVersion}" $architectureTag
    if ($LASTEXITCODE -ne 0) { throw '设置目标标签失败' }
    docker push $architectureTag
    if ($LASTEXITCODE -ne 0) { throw "推送 ${architecture} 失败" }
}

docker buildx imagetools create --tag "${targetRepository}:${releaseVersion}" "${targetRepository}:${releaseVersion}-amd64" "${targetRepository}:${releaseVersion}-arm64"
if ($LASTEXITCODE -ne 0) { throw '合并多架构索引失败' }
docker buildx imagetools inspect "${targetRepository}:${releaseVersion}"
if ($LASTEXITCODE -ne 0) { throw '读取目标索引失败' }
```

最终输出必须同时包含 `linux/amd64` 和 `linux/arm64`。逐次 `load` 会切换本地 `labos` 标签，前一次创建的目标架构标签仍保留；这里先把两种架构实际推到目标同一仓库，再合并索引，无需从 GHCR 重新下载，也无需运行 ARM 模拟器。普通的一次 `pull/tag/push` 不能保证保留另一架构；不把直接跨仓库 `imagetools create` 当作完整镜像复制。

同步并验证后，将 NAS `.env` 中 `LABOS_IMAGE` 改为真实目标仓库的完整版本标签，其他数据及 UID/GID 配置保持原值。公开仓库须确认支持匿名拉取；私有仓库还需在 NAS 使用拉取凭据登录目标仓库。不要在群晖使用仍含占位符的地址。

## 数据、备份与升级

运行存储包含 `data/`（SQLite 及 WAL/SHM）、`uploads/`（附件）、`logs/`（预留目录）。应用日志主要在容器标准输出，YML 配置日志轮转。数据位于镜像外；容器重建不删除正确挂载的数据卷或 bind 目录。**不要把 `docker compose down --volumes` 作为日常升级命令**，也不要在管理器中勾选删除数据卷。

### 命名卷备份

先停止应用写入：在 NAS 项目目录执行 `docker compose stop labos`。从 Container Manager 应用容器的挂载信息，或 `docker compose ps -a -q labos` 配合 `docker inspect`，确认 `/var/lib/labos` 对应的真实卷名。可用 `docker volume inspect 卷名` 核对；其中 `Mountpoint` 仅用于识别位置，不要手工编辑 Docker 内部目录或复制正在运行的数据库。

以下示例在 **NAS SSH 会话**执行，以首次安装的 0.3.2 环境为例。先把卷名替换为刚确认的真实值，准备独立备份目录 `/volume1/docker/labos/backups`，并使用尚未存在的备份文件名。先执行 `docker volume inspect 真实卷名`，成功后再运行备份；写错卷名可能创建空卷，不能盲目继续。镜像名应与当前应用实际已存在的镜像一致，离线安装时替换为 `labos:0.3.2`；在升级前备份 0.3.1 时仍使用原 0.3.1 镜像和原真实卷名，不先换成下面的新版本。

```sh
docker run --rm --pull=never --user 0:0 --entrypoint tar --mount type=volume,source=YOUR_PROJECT_labos-runtime-0.3.2,target=/backup-source,readonly --mount type=bind,source=/volume1/docker/labos/backups,target=/backup-output ghcr.io/hotll233/labmg:0.3.2 -czf /backup-output/labos-0.3.2-YYYYMMDD-HHMMSS.tar.gz -C /backup-source .
```

源卷只读挂载，备份只写指定宿主机目录；占位卷名和时间戳须先替换。确认命令退出码为 0、归档存在且能列出 `data/`、`uploads/` 等内容，再启动应用。备份应另存到可靠位置。管理器仅导出镜像或容器配置，不等于导出数据卷；网页 JSON 备份也不是整套灾备。

### 升级与恢复

升级前停止旧应用并完成整套备份。默认卷名包含版本，新版本不会自动读取旧卷；更换项目名也会改变默认卷名。需要版本隔离时，应先在独立新卷或已准备好的新 bind 目录中还原完整副本，使用新配置挂载该副本，再验证原账号、记录和附件。命名卷副本须通过受控容器挂载导入，不直接修改其 `Mountpoint`；不要将运行中的 SQLite 单文件复制当作一致备份。

0.3.1 升级优先保留原 YML，仅改镜像；只有需要更换 YML 并直接引用已存在旧卷时，才在新 YML 顶层以 `external: true` 声明它，并让两个服务挂载同一卷；先核对真实卷名及备份。原、新应用不能同时写同一份存储。0.3.2 已升级的表结构和 schema 2 业务备份不能交给 0.3.1；回退必须恢复升级前完整数据副本，切回旧镜像不会回退数据库。

旧 bind 部署仍按原方式停服备份整个目录，包含数据库/WAL/SHM、附件和目录结构；迁移时复制到已准备好的新版本目录，保留或核对 UID/GID，再设置 `LABOS_DATA_DIR`。已有 Windows 数据迁移也先停服备份整个运行根目录，再迁移 `data/`、`uploads/`、`logs/`；镜像不会携带本机真实数据。

## 发布、自己构建与单独建容器

GitHub Actions 按版本标签发布 amd64/arm64，最终可用性以实际 Release、Actions 和匿名拉取结果为准。仓库维护者使用 PowerShell 7 执行 `npm run package:docker`，生成源码 ZIP、两架构 TAR/清单及独立部署文件；缓存统一在 `artifacts/cache/<version>/`，不覆盖旧版本。

自行构建可在源码根目录使用 PowerShell 7 执行，标签与构建版本读取该份源码的实际版本（当前为 0.3.2；需要 0.3.1 时使用其发布源码）：

```powershell
$labosVersion = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
docker build --platform linux/amd64 --build-arg "VERSION=$labosVersion" -f deploy/Dockerfile -t "labos:$labosVersion" .
if ($LASTEXITCODE -ne 0) { throw '构建失败' }
```

ARM64 改为 `linux/arm64`，跨架构构建须有相应 Buildx/模拟支持。基础镜像为 `node:24-bookworm-slim`，自行构建需要下载基础镜像；导入现成 TAR 无需下载它。构建后在 `.env` 设置 `LABOS_IMAGE=labos:<实际版本>`。

推荐用配套项目 YML；单独从 GUI 创建一个应用容器不会执行 `labos-init`，不能自动获得同样的目录准备流程。自行管理容器时须另行准备存储及 UID/GID，内部端口保持 3000、运行目录保持 `/var/lib/labos`。应用镜像默认用户为非 root `node`，初始化服务的 root 权限仅用于准备挂载目录，不开放 Web 服务。

0.3.2 的实际发布及验证范围见 [Release](https://github.com/HotLL233/labmg/releases/tag/v0.3.2) 和[版本说明](CHANGELOG.md)；本机验证结果不代表目标 NAS 的性能或完整灾备已经验收。
