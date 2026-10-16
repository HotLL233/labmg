# 群晖 Docker 部署

本版为 `0.2.0-rc.4`，使用 SQLite 和本地附件，只需一个应用容器。YML 默认使用 `ghcr.io/hotll233/labmg:0.2.0-rc.4`，面向 `linux/amd64` 和 `linux/arm64`。无需启动 PostgreSQL 或 MinIO。推荐使用 64 位群晖的 Container Manager；旧版 Docker 套件可通过兼容 Compose 3.8 的工具部署。

本版在空数据库首次打开网页时设置管理员密码，YML 不再要求密码环境变量。可从 [rc.4 发布页](https://github.com/HotLL233/labmg/releases/tag/v0.2.0-rc.4) 下载 `docker-compose.yml` 和 `env.example`，按需将示例复制为 `.env`；源码中的示例名仍为 `.env.example`。镜像、附件和验证结果以实际发布记录为准。NAS 须能访问 `ghcr.io`，公开镜像无需 GitHub 账号登录。

## 在线用 YML 创建项目

1. 从仓库 [deploy/](../deploy/) 下载 `docker-compose.yml` 和 `.env.example`。在 NAS 上准备项目目录，例如 `/volume1/docker/labos/project/`，放入 YML，将示例复制为同目录的 `.env`。
2. 准备本版数据目录，例如 `/volume1/docker/labos/runtime/0.2.0-rc.4/`，并使容器实际使用的 UID/GID 有读写权限。
3. 编辑 `.env`，设置绝对数据路径和实际 UID/GID，无需填写管理员密码：

   ```dotenv
   LABOS_IMAGE=ghcr.io/hotll233/labmg:0.2.0-rc.4
   LABOS_PORT=3000
   LABOS_ADMIN_USER=admin
   LABOS_DATA_DIR=/volume1/docker/labos/runtime/0.2.0-rc.4
   LABOS_UID=1026
   LABOS_GID=100
   ```

   `1026:100` 只是示例，不能直接假定与你的群晖相同。可在 NAS 上执行 `id 你的群晖用户名` 查询，让数据目录所有者及权限与该 UID/GID 对应。默认值为 `1000:1000`；无需使用 root 或开放整个目录的 777 权限。`PUID/PGID` 环境变量不会改变本镜像的运行用户，应使用这里的 `LABOS_UID/GID`。

4. 打开“Container Manager → 项目 → 新增”，选择上述项目目录，使用已有 `docker-compose.yml`，创建并启动项目。Docker 会拉取公开 GHCR 镜像并自动选择设备架构，YML 不包含源码构建步骤，无需导入 TAR 或执行 `docker login`。
5. 访问 `http://群晖IP:3000`，空数据库会显示“首次设置管理员”，填写账号、至少 8 位的新密码并确认，成功后自动登录；已有数据库直接使用原账号登录。若修改 `LABOS_PORT`，使用对应端口。首次设置完成前仅允许可信人员访问该地址，先完成初始化再开放访问。

如使用 SSH，可在放置 YML 和 `.env` 的目录执行：

```sh
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 labos
```

旧版命令可能是 `docker-compose`。主配置采用 Compose 3.8，Compose v2 的 `version is obsolete` 提示不影响运行。没有 `.env` 或没有密码变量也能解析本版 YML；NAS 数据路径及 UID/GID 仍需与实际目录权限相符。密码在网页设置，不需要写入部署文件。

若使用完整源码 ZIP，将项目目录选为解压后的 `deploy/`，并将 `deploy/.env.example` 复制为 `deploy/.env`；其他步骤相同。所有相对挂载路径均以 YML 所在的项目目录为基准，建议在群晖上填绝对路径。NAS 须能访问 `ghcr.io`；公开镜像的匿名拉取不需要仓库账号。

`x86_64` 设备使用 amd64，`aarch64` 设备使用 arm64，Docker 会根据多架构清单自动选择。32 位 ARM 不在本版镜像支持范围，ARM64 设备也须本身支持 Docker。可执行 `uname -m` 核对架构。

### 从旧版密码必填 YML 切换

rc.2 / rc.3 的 YML 要求 `LABOS_ADMIN_PASSWORD`，缺失或留空会在启动前报 `error while interpolating`。本版已改为网页首次设置，应替换为 rc.4 的 YML，并核对镜像标签也是 `0.2.0-rc.4`；仅把旧 YML 的镜像标签改掉仍会保留原来的必填插值。保留实际数据路径、端口和 UID/GID，先备份数据再按下方升级步骤处理。

`.env` 仅用于自定义路径等部署参数，使用时须与 YML 位于同一项目目录，真实文件名为 `.env`，不能仍叫 `env.example` 或 `.env.txt`。可运行 `docker compose config --quiet` 检查配置；排错时只提供错误文字，不分享包含敏感信息的配置。

## 离线导入镜像包

`0.2.0-rc.2` 首先提供按架构导入 TAR 的交付方式；`0.2.0-rc.3` 增加公开镜像在线部署，rc.4 沿用这两种方式。已完成打包的文件位于对应版本的 `artifacts/releases/<version>/`，对外下载以 GitHub 对应 Release 的实际附件为准。

| 文件 | 用途 |
| --- | --- |
| `labos-0.2.0-rc.4-linux-amd64.tar` | Intel / AMD 64 位群晖镜像包 |
| `labos-0.2.0-rc.4-linux-arm64.tar` | 支持 Docker 的 ARM64 设备镜像包 |
| 同名 `.json` | 镜像架构、版本、构建提交、镜像 ID 和 TAR 的 SHA-256 |
| `docker-compose.yml` / `.env.example` | 项目配置及环境示例 |
| `SYNOLOGY.md` | 本说明 |
| `labos-0.2.0-rc.4.zip` / `manifest.json` | 完整源码部署包及源码摘要，自己构建时使用 |

只导入与设备架构匹配的一份 TAR。两种架构的离线镜像名都为 `labos:0.2.0-rc.4`，与默认 GHCR 镜像名不同。这些是 `docker save` 镜像归档，可由“映像 → 新增 → 从文件添加”导入，或执行：

```sh
docker load -i labos-0.2.0-rc.4-linux-amd64.tar
```

导入后在项目的 `.env` 中设置：

```dotenv
LABOS_IMAGE=labos:0.2.0-rc.4
```

确认本地映像列表存在该标签，再按前述步骤准备数据目录及 UID/GID，启动项目后在网页设置密码。离线部署跳过 `docker compose pull`，直接执行 `docker compose up -d`；不要把 TAR 当作容器根文件系统导入。使用 rc.2 历史 TAR 时镜像名仍为 `labos:0.2.0-rc.2`，需明确覆盖 `LABOS_IMAGE`，并使用独立的 rc.2 数据目录及其密码初始化配置。

## 单独创建容器

不使用项目时，也可在 Container Manager 中下载公开 GHCR 镜像，或导入离线 TAR 后按下表创建容器；YML 已统一设置这些选项，推荐优先使用项目部署。

| 项目 | 值 |
| --- | --- |
| 镜像 | 在线 `ghcr.io/hotll233/labmg:0.2.0-rc.4`；离线 `labos:0.2.0-rc.4` |
| 容器端口 | `3000/tcp`，映射到 NAS 的空闲端口 |
| 目录挂载 | NAS 数据目录 → `/var/lib/labos`，读写 |
| 管理员初始化 | 无需密码环境变量；启动后首次在网页设置 |
| 运行用户 | 镜像默认 `node`（UID/GID 1000:1000）；修改用户需通过 Docker 的 user 设置或 YML |
| 重启 | `unless-stopped` |

不要改容器内部的 `PORT=3000` 或 `LABOS_RUNTIME_DIR=/var/lib/labos`；只改宿主机映射端口和挂载源目录。启动命令已包含在镜像中，无需另填。

## 数据、备份与升级

挂载目录包含 `data/`、`uploads/`、`logs/`，分别保存 SQLite、附件与预留日志目录。运行日志主要在容器标准输出，YML 配置 Docker 日志轮转。数据库与附件始终放在镜像之外，删除并重建容器不会删除正确挂载的宿主机目录。

已有任意用户时初始化入口关闭，升级不会重置原账号密码。普通 Node 或 `docker run` 自动化部署仍可显式传入非空 `LABOS_ADMIN_PASSWORD`，只在零用户时预设管理员；默认 YML 不传此变量。容器显示健康只表示 HTTP 服务能响应，不代表管理员已完成初始化或业务、权限、容量已验收。

升级前停止旧容器，备份完整数据目录（包括数据库及 WAL/SHM 和附件），将副本复制到新版本目录，再修改 `LABOS_IMAGE` 和 `LABOS_DATA_DIR` 并启动。在线方式先拉取新版本镜像，离线方式先导入对应版本 TAR。不要让两个版本或两个实例同时写同一目录。切回旧镜像不等于回退数据；保留独立副本再验证数据库兼容性。网页内的 JSON 备份仍不是完整灾备，不能代替整目录备份。

已有 Windows 数据迁移时，也应先停服备份整个 `var/`，仅将需要的 `data/`、`uploads/`、`logs/` 复制到 NAS 的新运行目录并设置权限；不自动携带本机真实数据到镜像。

## 发布与自己构建

GitHub Actions 在推送 `v*` 标签时构建并发布 `linux/amd64` 和 `linux/arm64` 镜像，版本必须与 `package.json` 相符，镜像版本去掉标签开头的 `v`。发布使用工作流的 `GITHUB_TOKEN`，不要求部署用户配置 GitHub 令牌。新 GHCR 包还需设置为公开，并验证匿名拉取。失败的 Actions 运行可在对应运行页面重新运行；最终发布结果以实际运行和拉取验证为准。

在源码根目录自行构建，按 NAS 架构选择 `linux/amd64` 或 `linux/arm64`：

```sh
docker build --platform linux/amd64 --build-arg VERSION=0.2.0-rc.4 -f deploy/Dockerfile -t labos:0.2.0-rc.4 .
```

构建后在 `.env` 中将 `LABOS_IMAGE` 设为 `labos:0.2.0-rc.4`。跨架构构建需要 Buildx 与相应模拟支持；也可以直接在目标 NAS 上本机构建。基础镜像为 `node:24-bookworm-slim`，构建时需要能下载基础镜像，导入现成 TAR 部署时无需下载它。

仓库维护者在 Windows 上执行 `npm run package:docker`，生成版本化源码 ZIP、两种架构的 TAR/镜像清单及独立 YML 配置。构建缓存和验证副本集中在 `artifacts/cache/<version>/`，Buildx 导出的层缓存也按架构保留；Docker 引擎自身的内部存储仍由 Docker 管理。同版本相同输入只复用校验一致的产物，不覆盖历史版本。不要提前构建后再修改同版本源码。

镜像默认以非 root 用户运行，只复制 `package.json` 和 `src/`；不包含运行数据库、附件、真实环境文件和 Git。项目当前仍是候选版，实际 NAS 的内核、Docker/DSM 版本、文件权限、浏览器和 30 人混合负载需要在目标设备验证。
