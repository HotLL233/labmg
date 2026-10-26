# PostgreSQL 18 与附件完整备份、恢复

适用于本仓库四服务 Compose：`labos-init`、`postgres`、`labos`、`labos-https`，一个 `labos` 数据库。网页物资 JSON 有容量及模块范围限制，不能替代本流程；本流程也不是任意多库 PostgreSQL 集群备份。

在装有 Docker CLI 的电脑以 **PowerShell 7** 运行。Docker 当前 context 必须指向目标 Docker 主机；脚本不会自动连接群晖。使用项目的真实 YML 和项目名，备份期间停止该项目的应用与 HTTPS；不要同时执行升级、初始化、手工 SQL 或其他写入任务。PostgreSQL 保持运行，以原生 `pg_dump -Fc --no-owner --no-acl` 生成逻辑快照。应用附件与 HTTPS CA 在停写期间归档，运行中的 `runtime/postgres/` 不复制。

## 创建与校验

以下路径为示例，`labos` 必须替换成 Container Manager 中原项目的真实名称。备份目录必须全新，并位于 `runtime/`、`https/` 之外。

```powershell
$PSVersionTable.PSVersion
docker context show
pwsh -NoProfile -File .\scripts\backup-runtime.ps1 -Mode Backup `
  -ComposeFile C:\labmg-deploy\docker-compose.yml -ProjectName labos `
  -Destination D:\private-backups\labos-20261026-120000
pwsh -NoProfile -File .\scripts\backup-runtime.ps1 -Mode Verify `
  -Destination D:\private-backups\labos-20261026-120000
```

脚本先核对 Compose 标签、唯一容器、PG18、实际挂载与本地镜像 ID，再停服务；不会拉取镜像。文件通过 `docker cp` 原样复制，避免 PowerShell 文本管道破坏二进制。结束时只启动原本运行的应用／HTTPS。失败目录保留 `INCOMPLETE`；若服务恢复失败，命令报错，需要检查原项目状态。不要把非零退出码当作成功。

完整目录包含：

| 文件 | 内容 |
| --- | --- |
| `database.dump` | 完整应用库，包括账号、权限、单据、资料版本与审计 |
| `runtime.tar.gz` | 应用附件、秘密文件、HTTPS 配置等，排除 PostgreSQL 物理目录 |
| `https.tar.gz` | Caddy 状态及本实例 CA／证书私钥 |
| `compose.yml` | 使用的原 YML |
| `compose.env` | YML 旁存在 `.env` 时保存；进程环境变量／额外 env 文件须另行保存 |
| `manifest.json` | SHA256、大小、原项目／镜像／挂载／用户与端口身份 |

这些文件含业务资料、数据库口令和 CA 私钥，必须私密离线保管；不要提交 Git、上传公开 Release 或当作镜像附件发布。另保存对应版本源码与三镜像离线包。`Verify` 只核对清单、摘要、大小及原生 `pg_restore --list`，需要备份记录的 PG 镜像 ID 已在当前 Docker 主机；它不会暂停业务，也不证明恢复或真实附件下载已通过。

## 恢复到空隔离目标

只在**新的独立项目及空的运行目录**演练。原项目、原 `runtime/`／`https/` 和原库保持不动。以下步骤不包含覆盖现库的 `--clean`、删除目录或自动切换生产。若目标非空，停止操作并改用新的隔离目录。

1. 先运行 `Verify`。将 `compose.yml` 复制到新的部署目录；有 `compose.env` 时复制为同目录 `.env`。确认 `.env` 内的 `LABOS_DATA_DIR` 没有指向原项目，按新目录调整；保留原 UID/GID。使用备份对应版本的镜像，在群晖 File Station 创建新目录下**空的** `runtime/`、`https/` 父目录。演练使用另一组 HTTP／HTTPS 端口。
2. 在新部署目录用原版本本地 YML 创建容器，**只创建，不启动**。核对三镜像已导入、当前 Docker context 正确。

```powershell
$taskProject = 'labos-restore-rehearsal'
$taskCompose = (Resolve-Path .\docker-compose.local.yml).Path
$taskBackup = 'D:\private-backups\labos-20261026-120000'
docker compose --project-name $taskProject --file $taskCompose create --pull never
$taskApp = (docker compose --project-name $taskProject --file $taskCompose ps --all --quiet labos).Trim()
$taskPg = (docker compose --project-name $taskProject --file $taskCompose ps --all --quiet postgres).Trim()
$taskHttps = (docker compose --project-name $taskProject --file $taskCompose ps --all --quiet labos-https).Trim()
docker inspect --format '{{json .Mounts}}' $taskApp $taskPg $taskHttps
```

确认输出里的主机路径全部属于新隔离目标，并在 File Station 核对目录为空；与 `manifest.json` 核对原 UID/GID、镜像版本和本次端口覆盖。不要输出完整 `docker inspect` 的环境变量以免泄露秘密。若曾通过进程环境变量配置部署，用 manifest 中实际用户／端口／挂载补回对应配置，不能只依赖旧 YML 默认值。

3. 用应用镜像的 tar 恢复两份文件归档。下面两个临时容器仅挂载刚创建的新目标；逐条执行，每条命令退出码都应为 0，失败即停止。`docker rm` 仅删除这两个已命名的临时容器。

```powershell
$taskAppImage = (docker inspect --format '{{.Image}}' $taskApp).Trim()
docker create --pull never --name labos-restore-runtime --network none --user 0:0 --volumes-from $taskApp --entrypoint tar $taskAppImage -xzf /tmp/runtime.tar.gz -C /var/lib/labos
docker cp (Join-Path $taskBackup 'runtime.tar.gz') labos-restore-runtime:/tmp/runtime.tar.gz
docker start --attach labos-restore-runtime
docker rm labos-restore-runtime
docker create --pull never --name labos-restore-https --network none --user 0:0 --volumes-from $taskHttps --entrypoint tar $taskAppImage -xzf /tmp/https.tar.gz -C /var/lib/labos-https
docker cp (Join-Path $taskBackup 'https.tar.gz') labos-restore-https:/tmp/https.tar.gz
docker start --attach labos-restore-https
docker rm labos-restore-https
```

4. 原秘密文件与附件恢复后，单独执行初始化器，再仅启动 PostgreSQL。此时应用和 HTTPS 仍停止。检查 PG18 及目标 `labos` 库没有用户表；若不是空库，停止，不能继续灌入。

```powershell
docker compose --project-name $taskProject --file $taskCompose up --no-deps --pull never labos-init
docker compose --project-name $taskProject --file $taskCompose up --detach --no-deps --pull never postgres
docker exec $taskPg pg_isready -U labos -d labos
docker exec $taskPg psql -U labos -d labos -Atqc 'SHOW server_version_num'
docker exec $taskPg psql -U labos -d labos -Atqc "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'"
```

`pg_isready` 未就绪时等其就绪；版本须为 `18xxxx`，用户对象计数须为 `0`。随后恢复同一个数据库：

```powershell
docker cp (Join-Path $taskBackup 'database.dump') "${taskPg}:/tmp/labos-restore.dump"
docker exec $taskPg pg_restore --exit-on-error --single-transaction --no-owner --no-acl -U labos -d labos /tmp/labos-restore.dump
docker exec $taskPg rm -f /tmp/labos-restore.dump
docker compose --project-name $taskProject --file $taskCompose start labos
docker compose --project-name $taskProject --file $taskCompose start labos-https
```

5. 在隔离地址检查版本、原账号登录、权限、申报原单／到货轮次、历史记录、库存、附件下载及 HTTPS。抽查文件原字节或 SHA256。重建应用后复查仍存在，记录实际恢复时长与检查结果。未经这一轮实际恢复，不能称备份已经通过恢复验收；不要仅凭 `pg_restore --list` 或 mock 测试替代。

本脚本不导出集群其他数据库、角色全集、复制槽或外部服务；标准部署使用 `labos` 角色及恢复的密码文件重新初始化 PG18，再以 `--no-owner --no-acl` 恢复应用库。主版本升级、非标准挂载／多数据库及生产切换需独立制定流程。
