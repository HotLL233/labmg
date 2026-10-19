# 群晖 Docker 部署

本文应用镜像对应 `0.4.0`（独立单件条码）。镜像、源码 ZIP、两架构离线 TAR 及历史配套文件的发布和验证结果，以 [0.4.0 发布页](https://github.com/HotLL233/labmg/releases/tag/v0.4.0)、对应 Actions 和[版本说明](CHANGELOG.md)为准。应用使用 SQLite 和本地附件，无需 PostgreSQL 或 MinIO。

**仓库后续部署模板已改为将数据默认放在 YML 同目录的 `runtime/`，不再按镜像版本另建卷。** 历史 Release 附件不覆盖，0.4.0 冻结 YML 仍采用版本命名卷；不要将本文的同目录默认值误认为旧附件已经修改。这是部署模板调整，不需要重新下载业务镜像。已有部署可以继续使用原 YML 原地升级。

YML 有两个服务：`labos-init` 以 root 一次性准备目录，成功后退出；`labos` 以非 root 用户运行应用。默认自动建立 `runtime/data/`、`runtime/uploads/`、`runtime/logs/`，无需先手工建立数据文件夹。空数据库首次打开网页设置管理员密码，没有默认密码；数据库已有用户时，初始化入口关闭，更新不会重置账号。

推荐使用 64 位群晖的 Container Manager 和支持 `depends_on.condition: service_completed_successfully`、`bind.create_host_path` 的 Compose。先运行 `docker compose config --quiet`，若提示不支持这些字段，需升级 Compose/套件或继续使用原兼容 YML。实际 DSM、内核和目录权限仍须在目标 NAS 验证。

## 原地升级与数据位置

日常升级保留原 YML、项目、数据挂载和 UID/GID，只更新应用镜像。账号、角色、系统配置、历史记录保存在运行目录的数据库中，附件也在同一运行挂载下；容器可以重建，存储必须继续指向原位置。

1. 在原项目停止应用写入，完整备份运行数据及 YML、`.env`，并在独立副本核对。
2. 在原 `.env` 只修改 `LABOS_IMAGE=ghcr.io/hotll233/labmg:0.4.0`，保留其他原值。若旧 YML 写死镜像名，只修改 `labos-init`、`labos` 两个服务的 `image`。
3. 在 **NAS SSH 原 YML 所在目录**逐条执行，每条成功后再继续：

   ```sh
   docker compose config --quiet
   docker compose pull
   docker compose up -d
   docker compose ps -a
   docker compose logs --tail=100 labos-init labos
   ```

4. 用原账号登录，核对历史记录和附件。离线导入镜像时保留本地 `LABOS_IMAGE=labos:0.4.0`，跳过 `pull`。

无需先执行 `down`。普通 `docker compose down` 不删除命名卷；`down -v` / `down --volumes` 会删除该项目管理的命名卷，不能用于日常升级。绑定目录不随容器删除，但手工删除目录仍会丢数据。换 YML、项目目录或数据源前先核对实际挂载，不能只凭“没删容器”判断数据会自动跟随。

使用仓库新模板时，默认 `./runtime` 相对于 YML 所在目录解析。项目目录搬家必须一并带上完整 `runtime/`，或让 `LABOS_DATA_DIR` 继续指向旧绝对路径。历史版本命名卷通常为 `<项目名>_labos-runtime-<版本>`；改项目名或换默认版本卷会连到另一份存储。需要隔离测试时使用完整数据副本，不让两个应用同时写生产目录。

## 更新后又出现首次设置管理员

**先停止写入，不要重新初始化或继续录入。** 首次设置说明当前连接的数据库没有用户，常见原因是新 YML、不同项目名或变更挂载接到了新空卷／空目录，不能据此认定旧数据被删除。

在 NAS 的原项目目录停止当前应用并查看容器、卷信息；这些排查命令不会删除或移动数据：

```sh
docker compose stop labos
docker compose ps -a
docker ps -a --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}'
docker volume ls
```

找出此前正常使用的**旧应用容器**，把下面变量替换为它的真实名称或 ID，再读取 `/var/lib/labos` 的挂载。若旧容器已被删除，当前新容器的挂载只能说明新数据位置，不能用来推断旧卷；保留所有候选卷，根据旧 YML、项目名、备份和卷元数据核实，不猜名称后直接写入。

```sh
old_container='替换为已确认的旧应用容器名或ID'
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/labos"}}type={{.Type}} name={{.Name}} source={{.Source}} destination={{.Destination}}{{end}}{{end}}' "$old_container"
```

- `type=volume`：`name` 是真实卷名。用 `docker volume inspect '真实卷名'` 只读核对；`Mountpoint` 用于识别，不直接修改 Docker 内部目录。最小恢复方式是重新使用原 YML、项目及原卷配置；需要转到同目录存储时按下一节迁移。
- `type=bind`：`source` 是实际宿主机目录。保留该目录，在新模板 `.env` 设置 `LABOS_DATA_DIR=这里填原source绝对路径`，同时保留原 UID/GID；不要把示例路径当成自己 NAS 的真实位置。

接回已核实的原存储前先完整备份，之后启动并用原账号核对。若已经在新空库设置账号或录入数据，保留新旧两份数据及备份，先确定保留范围；本项目不自动合并两个数据库，不用旧数据直接覆盖新录入内容。

## 将旧命名卷迁移到 YML 同目录

只有想把 Docker 管理的旧卷改成 File Station 中可见的项目 `runtime/` 时才需要迁移。**原地升级本身不要求迁移。** 下面在 NAS SSH 执行，使用当前已存在的应用镜像，把已核实旧卷只读导出，再恢复到新的空目录；旧卷不删除。先停止所有访问该卷的应用，保留原部署配置，并按上节确认真实卷名及 UID/GID。

先进入你准备保存新 YML 的项目目录。示例中的 `YOUR_CONFIRMED_VOLUME` 必须替换为真实卷名；`labos_image` 必须是 NAS 已存在的当前镜像，离线安装可用 `labos:0.4.0`，不要为了备份先更换运行版本。整个代码块在子 shell 中执行，任何检查失败立即停止：

```sh
(
  set -eu
  old_volume='YOUR_CONFIRMED_VOLUME'
  labos_image='ghcr.io/hotll233/labmg:0.4.0'
  project_dir="$(pwd -P)"
  backup_file="labos-before-runtime-migration-$(date +%Y%m%d-%H%M%S).tar.gz"
  [ "$old_volume" != 'YOUR_CONFIRMED_VOLUME' ]
  docker volume inspect "$old_volume" >/dev/null
  docker image inspect "$labos_image" >/dev/null
  docker run --rm --pull=never --user 0:0 --entrypoint sh \
    --mount "type=volume,source=$old_volume,target=/backup-source,readonly" \
    "$labos_image" -c 'test -f /backup-source/data/labos.db && test ! -L /backup-source/data/labos.db && test -s /backup-source/data/labos.db'
  [ ! -L "$project_dir/runtime" ]
  [ ! -e "$project_dir/runtime" ] || [ -d "$project_dir/runtime" ]
  mkdir -p "$project_dir/runtime" "$project_dir/backups"
  docker run --rm --pull=never --user 0:0 --entrypoint node \
    --mount "type=bind,source=$project_dir/runtime,target=/restore-target,readonly" \
    "$labos_image" -e 'if (require("node:fs").readdirSync("/restore-target").length) process.exit(1)'
  [ ! -e "$project_dir/backups/$backup_file" ]
  docker run --rm --pull=never --user 0:0 --entrypoint sh \
    --mount "type=volume,source=$old_volume,target=/backup-source,readonly" \
    --mount "type=bind,source=$project_dir/backups,target=/backup-output" \
    "$labos_image" -c 'set -Ce; umask 077; tar --numeric-owner -czf - -C /backup-source . > "/backup-output/$1"' sh "$backup_file"
  docker run --rm --pull=never --user 0:0 --entrypoint tar \
    --mount "type=bind,source=$project_dir/backups,target=/backup-input,readonly" \
    "$labos_image" -tzf "/backup-input/$backup_file"
  docker run --rm --pull=never --user 0:0 --entrypoint sh \
    --mount "type=bind,source=$project_dir/backups,target=/backup-input,readonly" \
    --mount "type=bind,source=$project_dir/runtime,target=/restore-target" \
    "$labos_image" -c 'set -eu; node -e "if (require(\"node:fs\").readdirSync(\"/restore-target\").length) process.exit(1)"; exec tar --numeric-owner --same-owner --preserve-permissions --keep-old-files -xzf "/backup-input/$1" -C /restore-target' sh "$backup_file"
  docker run --rm --pull=never --user 0:0 --entrypoint sh \
    --mount "type=bind,source=$project_dir/runtime,target=/restore-target,readonly" \
    "$labos_image" -c 'test -f /restore-target/data/labos.db && test ! -L /restore-target/data/labos.db && test -s /restore-target/data/labos.db'
)
```

归档应包含 `data/`、`uploads/`、`logs/` 及已有数据库和附件。源卷只读，恢复保留原文件属主及权限，不覆盖非空 `runtime/`；若中途失败，保留归档、旧卷和不完整目标，不在非空目录盲目重跑。备份另存到可靠位置后，在新模板 `.env` 保留原 `LABOS_UID/GID`，让 `LABOS_DATA_DIR` 未设置或写 `./runtime`，再校验配置、启动并核对原账号、历史记录和附件。核对成功前不要启动旧应用，也不要删除原卷。新旧应用不能同时写同一份数据。

## 0.3.3 升级到 0.4.0

停止应用写入并完整备份原数据卷和部署配置，先在隔离副本验证。按上文“原地升级”沿用原 YML、Compose 项目名、数据挂载和 UID/GID，仅更新原项目的 `LABOS_IMAGE=ghcr.io/hotll233/labmg:0.4.0` 后拉取重建；不要用新版默认空目录或空卷替代已有数据，也不要删卷。image 写死时只修改两个服务的镜像名。

旧主档继续按数量管理，不自动把旧数量拆成瓶数。新建主档可选择“逐件管理”，以瓶／件作为基本单位，合格验收 N 件自动生成 N 个不同码；规则入口为“物资管理 → 分类、区域与主档 → 条码编号规则”。验收记录及库存批次中可查看、重打印独立标签；物资管理员发放时扫描每件编号，系统检查仍在库和批次一致。没有业务记录的主档可带原因切换管理方式，已有记录不允许直接切换；本版不做历史补码或开瓶余量。

编号默认 `LAB-{YYYY}{MM}{DD}-{SEQ}`，支持固定前缀、UTC日期和补零全局流水号，修改格式保留旧码且序号不重置。单次生成／出库最多1000件。新增单件表及主档管理方式字段，物资完整备份升schema4，兼容旧schema1/2/3；旧服务不能恢复schema4。回退须恢复升级前完整数据副本，不只切旧镜像。

## 历史：0.3.2 升级到 0.3.3

停止应用写入并完整备份原运行数据卷（数据库及 WAL/SHM、附件、目录结构）和部署配置，先在隔离副本验证。沿用原 YML、Compose 项目名、数据挂载及 UID/GID，仅在原项目 `.env` 更新 `LABOS_IMAGE=ghcr.io/hotll233/labmg:0.3.3` 后拉取重建。若写死了 image，则修改两个服务的 image。保留原 `labos-runtime-0.3.2` 卷或原 bind 源；不要用新 YML 的默认空卷替代旧数据，不要删卷。

本版新增包装条码绑定表，物资完整备份导出为 schema 3，仍支持将 schema 1/2 恢复到空的新业务库。旧版不能恢复 schema 3，回退必须恢复升级前完整数据副本，再启动原镜像；新旧应用不能同时写同一份数据。扫码不新增业务角色权限：主档条码维护需 ADMIN/MATERIAL 加主档权限，验收和发放仍须 MATERIAL 加对应权限。

## 历史：0.3.1 升级到 0.3.2

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

以上步骤对应 0.3.1 历史版本；升级到 0.4.0 以本页“原地升级”和相应版本说明为准。旧版完整数据迁移与回退仍按本文步骤执行。历史 YML 的版本卷规则保留，仓库新模板默认同目录 `runtime/`。

## 首次使用物资模块

先停服备份原数据卷或整个运行目录，在独立副本验证升级。保留旧业务须继续挂载原数据源并保留 UID/GID，不能删除原 `LABOS_DATA_DIR` 后以为已迁移。历史物资版本的默认卷按版本隔离，仓库新模板已改为同目录 `runtime/`；替换模板不等于搬运数据。新业务表首次为空，旧物资只读，不自动累加库存，由物资管理员盘点后登记期初。

由系统管理员维护分类、区域和主档，在账号编辑中给业务负责人增加 MATERIAL（物资管理员）角色及对应动作权限。ADMIN 本身没有提交、已提交单修订、入库或领用发放资格。全部人员均可填报和申请领用，提交后的修订须原因并保留历史；首次合格入库后期初永久关闭。

“导出与备份”中通用台账与新版物资分别备份；物资完整恢复仅允许空的新业务库，先保证同名用户存在。完整停服数据卷备份仍是升级和回退的主要保障。镜像已安装 Excel 依赖，TAR 导入后无需在 NAS 安装 Node 或 npm。

## 手机扫码与 HTTPS

手机在可信 HTTPS 地址访问时，点击“扫码入库 / 扫码领用 → 开启后置摄像头”，授权摄像头后实时识别。直接访问 `http://群晖IP:3000` 通常不满足浏览器安全上下文，实时相机按钮会提示限制；仍可“拍照识别”、选择图片或手动输入。浏览器文件选择是否直接调用相机由手机系统决定。图像仅在当前设备解析，扫码组件及 WASM 随镜像提供，不调用第三方识别服务。

群晖可在“控制面板 → 登录门户 → 高级 → 反向代理”（不同 DSM 名称可能不同）新增规则：来源为 HTTPS、你的域名及443端口；目标为 HTTP、NAS本机地址及应用映射端口（默认3000）。在“安全性 → 证书”给该域名配置浏览器信任的有效证书并关联规则；手机应能解析域名并访问该端口。只有内网使用时也可使用可信本地证书，但需在手机安装并信任签发机构。忽略自签证书警告不等于得到安全上下文。本文不假设已有域名、证书或外网端口映射。

反向代理应保留浏览器访问的 Host（使用非默认端口时包括端口）；首次设置若提示“不允许跨站初始化请求”，核对代理的 Host 转发设置与访问域名是否一致。应用不依据任意 `X-Forwarded-Host` 放宽首次设置的同源检查。

首次识别现有包装码前，在物资主档的“条码”中扫码绑定（ADMIN/MATERIAL 且有主档维护权限，需原因）；一码只属于一个物资。包装码匹配后，入库选择尚有剩余量的来源明细，领用选择仓库/区域/批次。EAN/UPC 等价码可能采用13位表示，请以扫码结果绑定，手输按完整文本精确匹配，前导0不能省略。

在库存批次点击“打印二维码”，独立标签窗口包含物资、批次和位置。系统 QR 精确定位完整批次，并读取实时余额及位置；标签上的文字位置是打印时信息，移动物资后应重打。二维码不含数量、金额或登录凭据。无论哪种码，扫码只帮助选择：验收入库仍须确认数量金额，领用仍是人员申请、物资管理员发放；扫码不会直接扣库，也不自动打开扫码内容中的网址。

## 首次在线部署

1. 核对 [0.4.0 Release](https://github.com/HotLL233/labmg/releases/tag/v0.4.0) 的镜像和附件记录。同目录数据方案使用仓库当前 [docker-compose.yml](../deploy/docker-compose.yml) 和[环境示例](../deploy/.env.example)。Release 内冻结的同名附件仍按历史命名卷规则工作，不能混淆两者；GitHub 附件环境示例名可能为 `env.example`，源码中为 `.env.example`。
2. 在“Container Manager → 项目 → 新增”中选择保存 YML 的项目目录。仓库新模板自动在这个目录下创建 `runtime/`，不需另建版本数据目录。能否在 File Station 中浏览取决于 NAS 账号权限与 ACL；应按需授予访问权限，不用开放 `777` 或盲目递归改属主来解决。
3. `.env` 可选。需要自定义端口或用户时，将仓库环境示例复制为项目同目录的 `.env`；首次部署保留 `LABOS_DATA_DIR` 为未设置状态，默认等同 `./runtime`。例如：

   ```dotenv
   LABOS_IMAGE=ghcr.io/hotll233/labmg:0.4.0
   LABOS_PORT=3000
   LABOS_ADMIN_USER=admin
   LABOS_UID=1000
   LABOS_GID=1000
   ```

   新建运行目录适用上述 UID/GID，无需改成 NAS 登录用户。`labos-init` 只创建并设置 `/var/lib/labos`、`data/`、`uploads/`、`logs/` 四个目录的属主及目录访问权限，不递归更改已有文件。应用继续使用 `LABOS_UID/LABOS_GID` 指定的非 root 用户；`PUID/PGID` 不控制本镜像的运行用户。
4. 使用该 YML 创建并启动项目。默认使用 `ghcr.io/hotll233/labmg:0.4.0`，镜像发布后按设备自动选择 amd64/arm64。`labos-init` 显示退出码 0 是正常完成；它失败时先查看日志并排错，应用不会启动。
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

仓库新模板的默认挂载为 `./runtime:/var/lib/labos`，例如 YML 放在 `/volume1/docker/labos/`，运行数据就在 `/volume1/docker/labos/runtime/`；这是示例，实际路径以你的项目目录为准。目录与镜像版本无关，重建时保留该目录即可继续读原数据。初始化服务只准备目录，不清空数据库；运行数据不在镜像里。

历史 rc.5 至 0.4.0 Release YML 的默认卷逻辑名仍带版本，例如 `labos-runtime-0.4.0`，真实名称通常为 `<项目名>_labos-runtime-0.4.0`。Docker 命名卷不是 File Station 中约定的普通业务目录；这些历史附件保持原样，已有部署沿用原配置即可保留原卷，迁移时按本页步骤。

`x86_64` 设备选 amd64，`aarch64` 设备选 arm64，可在 NAS 执行 `uname -m` 核对。32 位 ARM 不在本版支持范围，ARM64 设备还须支持 Docker。

## 已有目录与旧版升级

已有数据时先保留原 YML、`.env`、数据路径和 UID/GID，再做停服完整备份。0.4.0 镜像与仓库新模板都兼容显式指定的宿主机绑定目录；日常升级保留原 YML，在原 `.env` 中仅更新镜像版本，原来的真实路径保持不变，例如：

```dotenv
LABOS_IMAGE=ghcr.io/hotll233/labmg:0.4.0
LABOS_DATA_DIR=/volume1/docker/labos/runtime/0.2.0-rc.4
# LABOS_UID 和 LABOS_GID 保留旧部署的真实值
```

该路径须已存在，旧文件须允许原 UID/GID 读写。初始化服务不递归修复旧文件权限，也不自动复制、移动旧数据。原来使用相对路径时，换项目目录会改变解析位置，应核对后写成对应的绝对路径。

**不能用新版空环境模板覆盖已有部署配置。** 删除 `LABOS_DATA_DIR` 会切换到所用 YML 的默认存储：仓库新模板为 `./runtime`，历史附件可能为版本命名卷；旧数据不会自动出现在新位置。若升级后意外出现“首次设置管理员”，按本文排查章节停止写入并检查原挂载，不要把新空库当作旧库继续录入。

rc.2 / rc.3 旧 YML 要求 `LABOS_ADMIN_PASSWORD`，缺失时会报 `error while interpolating`；rc.4 改为网页首次设置。从 rc.4 及更早版本改用初始化服务方案时，需配套更新 YML 和 0.4.0 镜像并明确保留旧数据源：rc.4 镜像没有本版目录初始化入口。rc.5 及后续版本的已有部署可保留原兼容 YML，仅更新镜像，并遵守停服备份、表结构升级和回退要求。已有账号不因升级重新开放初始化或重置密码。

`.env` 应与 YML 位于同一项目目录，真实文件名不能仍为 `env.example` 或 `.env.txt`。排错可用 `docker compose config --quiet`，只分享错误文字，不分享包含敏感信息的完整配置。

### 提示绑定路径不存在

截图中的 `Bind mount failed: '/volume1/docker/var/docker/0.2.0-rc.4' does not exist` 表示容器尚未启动，宿主机没有该挂载源。这通常来自 rc.4 相对路径 `../var/docker/0.2.0-rc.4`；实际解析位置取决于项目目录，不一定是预期的 `/volume1/docker/labos/runtime/`。

- rc.4 临时处理：在 NAS 创建报错所指的准确目录，并使实际应用 UID/GID 可写，或将 `LABOS_DATA_DIR` 改为已准备好的绝对目录。对首次部署的空目录，可由 NAS 管理员执行 `sudo mkdir -p /volume1/docker/var/docker/0.2.0-rc.4`，再对这个目录设置正确属主；不要对已有业务目录盲目递归改属主或开放 777。
- 历史 rc.5 至 0.4.0 Release 默认处理：首次部署使用历史配套 YML，不设置 `LABOS_DATA_DIR`，由 Docker 创建本版命名卷，初始化服务设置目录权限。
- 仓库后续模板默认处理：不设置 `LABOS_DATA_DIR`，自动创建 YML 同目录的 `runtime/` 及运行子目录；需要支持 `bind.create_host_path` 的 Compose。首次安装无需手工准备上述旧路径；已有数据必须保留原路径或先迁移完整副本。
- 已有数据继续使用 bind 时：保留真实目录，先确认目录存在、旧数据及权限正确；切换默认空卷不是迁移方案。

若本版仍显示相同旧路径，检查是否还使用旧 YML，或 `.env` 中仍保留该 `LABOS_DATA_DIR`。

## 离线导入与慢拉取

若 NAS 拉取 `ghcr.io` 慢，可使用构建电脑上已经生成的同版本 TAR，经局域网传到 NAS，避免再次公网下载。产物位于构建电脑的 `artifacts/releases/<version>/`，不随 Git 克隆提供；0.4.0 文件须以实际完成的构建及 Release 为准。

| 文件 | 用途 |
| --- | --- |
| `labos-0.4.0-linux-amd64.tar` | Intel / AMD 64 位设备 |
| `labos-0.4.0-linux-arm64.tar` | 支持 Docker 的 ARM64 设备 |
| 同名 `.json`、`SHA256SUMS` | 架构、提交、归档大小与 SHA-256 核对 |
| `docker-compose.yml`、环境示例、`SYNOLOGY.md` | 配套部署文件 |
| `labos-0.4.0.zip`、`manifest.json` | 源码及构建清单 |

只导入与 NAS 架构匹配的一份 TAR。使用“映像 → 新增 → 从文件添加”，或在 NAS 执行：

```sh
docker load -i labos-0.4.0-linux-amd64.tar
```

这是 `docker save` 镜像归档，不是容器根文件系统。两种架构的本地标签都为 `labos:0.4.0`。在项目 `.env` 中设置：

```dotenv
LABOS_IMAGE=labos:0.4.0
```

确认本地存在该标签后，跳过 `docker compose pull`，直接 `docker compose up -d`；两个服务都会使用这份本地镜像，数据卷仍按前述规则自动准备。固定版本标签在本地存在时，常规启动默认复用本地镜像；若仍指向缺失的 GHCR 标签，Compose 会尝试拉取该名称。

历史版本继续使用各自镜像和配套说明：rc.2 首先提供离线 TAR，rc.3 增加公开 GHCR，rc.4 增加网页首次设置，均不因本说明更新而改变原产物。已存在的 rc.4 TAR 每份约 81 MB；其他版本大小以各自清单为准。Docker Hub 的 `registry-mirrors` 不代理 GHCR；本说明不假定已测得 NAS 的具体网络瓶颈。

## 同步到国内镜像仓库

需要用户自己的 ACR/TCR 等目标仓库，先准备域名、命名空间及仓库推送权限。当前没有配置目标地址或凭据，下面是操作方法，不表示已完成同步。目标仓库须支持多架构索引；拟使用的 `0.4.0-amd64`、`0.4.0-arm64`、`0.4.0` 三个标签均须未占用，已有标签先核对，不覆盖。

在持有两份已核验 0.4.0 TAR 的开发电脑上使用 **PowerShell 7**。替换占位值，在仓库控制台确认三个标签未使用，再执行；每个 Docker 命令失败都会停止后续步骤。`docker login` 交互输入凭据，不把密码写进命令、文档或 Git：

```powershell
$registryHost = '<国内仓库域名>'
$namespace = '<命名空间>'
$targetRepository = "${registryHost}/${namespace}/labmg"
$releaseVersion = '0.4.0'
$releaseDirectory = 'C:\labmg\artifacts\releases\0.4.0'
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

### 同目录或其他 bind 目录备份

在原项目执行 `docker compose stop labos`，并确认没有其他应用写同一数据目录。使用 NAS 备份工具或管理员权限完整备份实际 `runtime/`（包括 `data/` 中数据库及 WAL/SHM、`uploads/`、`logs/` 和目录结构），保留原 UID/GID、权限与文件属主；同时保存 YML 和 `.env`。`LABOS_DATA_DIR` 指向其他目录时，备份该真实路径。备份另存到可靠位置，恢复前停止应用并使用独立空目录验证，不能只复制运行中的 `labos.db`。

### 历史命名卷备份

先停止应用写入：在 NAS 项目目录执行 `docker compose stop labos`。从 Container Manager 应用容器的挂载信息，或 `docker compose ps -a -q labos` 配合 `docker inspect`，确认 `/var/lib/labos` 对应的真实卷名。可用 `docker volume inspect 卷名` 核对；其中 `Mountpoint` 仅用于识别位置，不要手工编辑 Docker 内部目录或复制正在运行的数据库。

以下示例在 **NAS SSH 会话**执行，适用于历史命名卷部署。先把卷名替换为刚确认的真实值，将备份目录替换为 NAS 上已准备好的目录。镜像名应与当前应用实际已存在的镜像一致，离线安装时可用 `labos:0.4.0`；升级前备份旧版仍使用原镜像和原真实卷名，不先换成下面的新版本。检查失败即停止，避免拼错卷名后误建空卷。

```sh
(
  set -eu
  labos_volume='YOUR_CONFIRMED_VOLUME'
  backup_directory='/volume1/docker/labos/backups'
  backup_file="labos-before-upgrade-$(date +%Y%m%d-%H%M%S).tar.gz"
  labos_image='ghcr.io/hotll233/labmg:0.4.0'
  [ "$labos_volume" != 'YOUR_CONFIRMED_VOLUME' ]
  docker volume inspect "$labos_volume" >/dev/null
  docker image inspect "$labos_image" >/dev/null
  [ -d "$backup_directory" ]
  [ ! -e "$backup_directory/$backup_file" ]
  docker run --rm --pull=never --user 0:0 --entrypoint sh \
    --mount "type=volume,source=$labos_volume,target=/backup-source,readonly" \
    --mount "type=bind,source=$backup_directory,target=/backup-output" \
    "$labos_image" -c 'set -Ce; umask 077; tar --numeric-owner -czf - -C /backup-source . > "/backup-output/$1"' sh "$backup_file"
)
```

源卷只读挂载，备份只写指定宿主机目录。确认命令退出码为 0、归档存在且能列出 `data/`、`uploads/` 等内容，再启动应用。备份应另存到可靠位置。管理器仅导出镜像或容器配置，不等于导出数据卷；网页 JSON 备份也不是整套灾备。

### 升级与恢复

升级前停止旧应用并完成整套备份。**生产数据位置保持稳定，业务代码、开发数据、测试及发布产物另行隔离。** 仓库新模板默认继续使用 YML 同目录 `runtime/`；历史 YML 的版本命名卷仍须保留原名称，不随镜像版本变化。需要验证副本时，在独立目录或卷恢复完整备份，避免两个应用写同一份存储。命名卷通过受控容器挂载导入，不直接修改其 `Mountpoint`；不要将运行中的 SQLite 单文件复制当作一致备份。

已有 rc.5 及后续部署优先保留原兼容 YML，仅改镜像。若采用同目录新模板，旧命名卷数据必须先按本文步骤迁移到空 `runtime/` 并核对；模板不会自动定位或搬迁旧卷。0.4.0 已升级的表结构和 schema 4 业务备份不能交给旧版；回退必须恢复升级前完整数据副本，切回旧镜像不会回退数据库。

旧 bind 部署仍按原方式停服备份整个目录，包含数据库/WAL/SHM、附件和目录结构；需要搬到同目录时复制到已准备好的空 `runtime/`，保留 UID/GID、属主和权限，核对后再切换 `LABOS_DATA_DIR`。已有 Windows 数据迁移也先停服备份整个运行根目录，再迁移 `data/`、`uploads/`、`logs/`；镜像不会携带本机真实数据。

## 发布、自己构建与单独建容器

GitHub Actions 按版本标签发布 amd64/arm64，最终可用性以实际 Release、Actions 和匿名拉取结果为准。仓库维护者使用 PowerShell 7 执行 `npm run package:docker`，生成源码 ZIP、两架构 TAR/清单及独立部署文件；缓存统一在 `artifacts/cache/<version>/`，不覆盖旧版本。

自行构建可在源码根目录使用 PowerShell 7 执行，标签与构建版本读取该份源码的实际版本（当前为 0.4.0；需要 0.3.2 时使用其发布源码）：

```powershell
$labosVersion = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
docker build --platform linux/amd64 --build-arg "VERSION=$labosVersion" -f deploy/Dockerfile -t "labos:$labosVersion" .
if ($LASTEXITCODE -ne 0) { throw '构建失败' }
```

ARM64 改为 `linux/arm64`，跨架构构建须有相应 Buildx/模拟支持。基础镜像为 `node:24-bookworm-slim`，自行构建需要下载基础镜像；导入现成 TAR 无需下载它。构建后在 `.env` 设置 `LABOS_IMAGE=labos:<实际版本>`。

推荐用配套项目 YML；单独从 GUI 创建一个应用容器不会执行 `labos-init`，不能自动获得同样的目录准备流程。自行管理容器时须另行准备存储及 UID/GID，内部端口保持 3000、运行目录保持 `/var/lib/labos`。应用镜像默认用户为非 root `node`，初始化服务的 root 权限仅用于准备挂载目录，不开放 Web 服务。

0.4.0 的实际发布及验证范围见 [Release](https://github.com/HotLL233/labmg/releases/tag/v0.4.0) 和[版本说明](CHANGELOG.md)；本机验证结果不代表目标 NAS 的性能或完整灾备已经验收。
