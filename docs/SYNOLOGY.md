# 群晖 Docker 部署

本版为 `0.2.0-rc.2`，使用 SQLite 和本地附件，只需一个应用容器。无需启动 PostgreSQL 或 MinIO。推荐使用 64 位群晖的 Container Manager；旧版 Docker 套件可通过兼容 Compose 3.8 的工具部署。

## 选择镜像包

发布文件集中在 `artifacts/releases/0.2.0-rc.2/`：

| 文件 | 用途 |
| --- | --- |
| `labos-0.2.0-rc.2-linux-amd64.tar` | Intel / AMD 64 位群晖镜像包 |
| `labos-0.2.0-rc.2-linux-arm64.tar` | 支持 Docker 的 ARM64 设备镜像包 |
| 同名 `.json` | 镜像架构、版本、构建提交、镜像 ID 和 TAR 的 SHA-256 |
| `docker-compose.yml` | 可直接创建群晖项目的 YML |
| `.env.example` | 端口、管理员初始化及数据目录配置示例 |
| `SYNOLOGY.md` | 本说明 |
| `labos-0.2.0-rc.2.zip` / `manifest.json` | 完整源码部署包及源码摘要，自己构建时使用 |

只导入与设备架构匹配的一份 TAR。`amd64` 也适用于 Intel 处理器；两种架构的本地镜像名都为 `labos:0.2.0-rc.2`。32 位 ARM 不在本版镜像支持范围，ARM64 设备也须本身支持 Docker。架构不清楚时在 NAS 上执行 `uname -m`：`x86_64` 选 amd64，`aarch64` 选 arm64。

这些是 `docker save` 镜像归档，可由 Container Manager 的“映像 → 新增 → 从文件添加”导入，或执行 `docker load -i <镜像包.tar>`。无需访问镜像仓库。不要把 TAR 当作容器根文件系统导入。

## 用 YML 创建项目

1. 在 NAS 上准备项目目录，例如 `/volume1/docker/labos/project/`，放入 `docker-compose.yml`，将 `.env.example` 复制为同目录的 `.env`。
2. 准备本版数据目录，例如 `/volume1/docker/labos/runtime/0.2.0-rc.2/`，并使容器实际使用的 UID/GID 有读写权限。
3. 导入对应架构的 TAR，确认映像列表中存在 `labos:0.2.0-rc.2`。
4. 编辑 `.env`，至少填写初始化密码、绝对数据路径和实际 UID/GID。示意如下，密码占位文字必须替换：

   ```dotenv
   LABOS_PORT=3000
   LABOS_ADMIN_USER=admin
   LABOS_ADMIN_PASSWORD='在这里填写自己的强密码'
   LABOS_DATA_DIR=/volume1/docker/labos/runtime/0.2.0-rc.2
   LABOS_UID=1026
   LABOS_GID=100
   ```

   `1026:100` 只是示例，不能直接假定与你的群晖相同。可在 NAS 上执行 `id 你的群晖用户名` 查询，让数据目录所有者及权限与该 UID/GID 对应。默认值为 `1000:1000`；无需使用 root 或开放整个目录的 777 权限。`PUID/PGID` 环境变量不会改变本镜像的运行用户，应使用这里的 `LABOS_UID/GID`。

5. 打开“Container Manager → 项目 → 新增”，选择上述项目目录，使用已有 `docker-compose.yml`，构建并启动项目。这里的“构建”使用已导入的本地镜像，YML 本身不包含源码构建步骤。
6. 访问 `http://群晖IP:3000`，用配置的管理员账号登录。若修改 `LABOS_PORT`，使用对应端口。

如使用 SSH，可在放置 YML 和 `.env` 的目录执行：

```sh
docker compose config --quiet
docker compose up -d
docker compose ps
docker compose logs --tail=100 labos
```

旧版命令可能是 `docker-compose`。主配置采用 Compose 3.8，Compose v2 的 `version is obsolete` 提示不影响运行。空的初始化密码会让配置检查直接失败；YML 中没有内置默认密码。不要把包含真实密码的 `.env` 放进源码仓库或分享出去。特殊字符可用单引号包住，尤其是 `$`，避免 Compose 变量替换。

若使用完整源码 ZIP，将项目目录选为解压后的 `deploy/`，并将 `deploy/.env.example` 复制为 `deploy/.env`；其他步骤相同。所有相对挂载路径均以 YML 所在的项目目录为基准，建议在群晖上填绝对路径。

## 单独创建容器

不使用项目时，导入 TAR 后也可按下表创建容器；YML 已统一设置这些选项，推荐优先使用项目部署。

| 项目 | 值 |
| --- | --- |
| 镜像 | `labos:0.2.0-rc.2` |
| 容器端口 | `3000/tcp`，映射到 NAS 的空闲端口 |
| 目录挂载 | NAS 数据目录 → `/var/lib/labos`，读写 |
| 环境变量 | `LABOS_ADMIN_USER`、`LABOS_ADMIN_PASSWORD` |
| 运行用户 | 镜像默认 `node`（UID/GID 1000:1000）；修改用户需通过 Docker 的 user 设置或 YML |
| 重启 | `unless-stopped` |

不要改容器内部的 `PORT=3000` 或 `LABOS_RUNTIME_DIR=/var/lib/labos`；只改宿主机映射端口和挂载源目录。启动命令已包含在镜像中，无需另填。

## 数据、备份与升级

挂载目录包含 `data/`、`uploads/`、`logs/`，分别保存 SQLite、附件与预留日志目录。运行日志主要在容器标准输出，YML 配置 Docker 日志轮转。数据库与附件始终放在镜像之外，删除并重建容器不会删除正确挂载的宿主机目录。

初始化管理员变量只在数据库没有用户时生效，修改 `.env` 不会重置已有账号密码。容器显示健康只表示 HTTP 服务能响应，不代表业务、权限或容量验收。

升级前停止旧容器，备份完整数据目录（包括数据库及 WAL/SHM 和附件），将副本复制到新版本目录，再修改镜像版本与挂载路径并启动。不要让两个版本或两个实例同时写同一目录。切回旧镜像不等于回退数据；保留独立副本再验证数据库兼容性。网页内的 JSON 备份仍不是完整灾备，不能代替整目录备份。

已有 Windows 数据迁移时，也应先停服备份整个 `var/`，仅将需要的 `data/`、`uploads/`、`logs/` 复制到 NAS 的新运行目录并设置权限；不自动携带本机真实数据到镜像。

## 自己构建

在源码根目录执行，按 NAS 架构选择 `linux/amd64` 或 `linux/arm64`：

```sh
docker build --platform linux/amd64 -f deploy/Dockerfile -t labos:0.2.0-rc.2 .
```

跨架构构建需要 Buildx 与相应模拟支持；也可以直接在目标 NAS 上本机构建。基础镜像为 `node:24-bookworm-slim`，构建时需要能下载基础镜像，导入现成 TAR 部署时无需下载它。

仓库维护者在 Windows 上执行 `npm run package:docker`，生成版本化源码 ZIP、两种架构的 TAR/镜像清单及独立 YML 配置。构建缓存和验证副本集中在 `artifacts/cache/<version>/`，Buildx 导出的层缓存也按架构保留；Docker 引擎自身的内部存储仍由 Docker 管理。同版本相同输入只复用校验一致的产物，不覆盖历史版本。不要提前构建后再修改同版本源码。

镜像默认以非 root 用户运行，只复制 `package.json` 和 `src/`；不包含运行数据库、附件、真实环境文件和 Git。项目当前仍是候选版，实际 NAS 的内核、Docker/DSM 版本、文件权限、浏览器和 30 人混合负载需要在目标设备验证。
