# 手机实时扫码与群晖 HTTPS

**0.6.2 及后续版本**的在线、本地两份完整 YML 都已内置 HTTPS，不再需要两个 YML 合并或额外 Caddyfile。当前 **0.7.0 已公开验证版**提供配套镜像及两架构三镜像 TAR，下载见 [0.7.0 Release](https://github.com/HotLL233/labmg/releases/tag/v0.7.0)。本版云端已通过无 SNI 且严格校验本实例 CA 的 HTTPS 生命周期，不能代替真手机证书信任和相机验收。数据库继续使用 PostgreSQL 18，同一 PG18 项目更新保留完整 runtime/ 和 https/；发布状态以[版本说明](CHANGELOG.md)为准。

## 为什么 HTTP 不能实时扫码

手机通过 http://群晖IP:3000 访问时，不满足浏览器摄像头 API 的安全上下文要求。实时扫码需要可信 HTTPS、网站和系统的相机授权以及可用摄像头；更新应用镜像不会自动让手机信任证书。普通 HTTP 仍保留拍照、选图和手工输入，图片在手机本地解析。

## 一个 YML 启用 HTTPS

1. 在线选择 [docker-compose.yml](../deploy/docker-compose.yml)，本地导入选择 [docker-compose.local.yml](../deploy/docker-compose.local.yml)，两者任选其一。部署及三镜像包导入见[群晖部署](SYNOLOGY.md)。
2. 在所选 YML 的 LABOS_HTTPS_HOST 行，将 CHANGE_ME 改为群晖实际 IPv4 或主机名，例如 192.168.1.10。只填写地址本身，不带协议、端口或路径；默认 HTTPS 端口是 8443。未修改时 HTTPS 代理会明确报错，HTTP 应用仍可启动。
3. 在 File Station 先创建 YML 旁的 `https/` 父目录，再启动项目。2026-10-19 的 DS918+ 实测缺少该父目录时拒绝 bind 挂载，不能依赖自动创建；已有目录保留。配置已内联生成，HTTPS 代理会创建内部 data/、config/，无需预建这两个子目录。保留整份 https/，其中包含当前实例的 CA 及私钥。PostgreSQL 与附件仍在单独的 runtime/。
4. 将下列公开根证书传到手机并安装、信任。只传 root.crt，不要导出 .key 或整份 https/data/。

~~~text
YML所在目录/https/data/caddy/pki/authorities/local/root.crt
~~~

可从自己的群晖 File Station 下载该文件并通过可信方式传到手机。部署完成后根证书才会生成；找不到时先查看 labos-https 日志和 IP 设置。

- iPhone / iPad：安装描述文件后，到“设置 → 通用 → 关于本机 → 证书信任设置”，对该根证书开启“完全信任”。仅安装描述文件仍不够。
- Android：在系统设置搜索“安装 CA 证书”，安装上述根证书；不要选择 Wi-Fi 或客户端证书。菜单随品牌和系统版本不同，设备管理策略可能需要管理员允许。

5. 用 Safari / Chrome 等完整浏览器直接打开 https://群晖实际IP:8443，确保没有证书警告，允许网站及系统相机权限，再点击“开启后置摄像头”。浏览器地址必须与 YML 中设置的 IP/主机名相同；仅在警告页面点击继续访问不能代替信任。HTTP 与 HTTPS 来源不同，可能需要重新登录。

准备父目录后，一份 YML 可以启动服务并生成证书；手机的根证书信任及首次相机授权需要在设备上操作。后续保留原 https/ 时沿用原 CA；更换 IP 或重新生成 CA 后需重新核对证书信任。不要在旧 HTTP 页面的内嵌框架里打开系统。

## 仍无法调用相机时

按顺序确认 HTTPS 地址及端口、证书无警告、当前根证书已完全信任，再检查浏览器和系统相机权限、其他应用占用。若提示扫码组件加载失败，检查本站 /vendor/zxing-wasm/3.1.5/index.js 和 WASM 的加载情况。群晖防火墙需允许局域网访问所选 HTTPS 端口。

源码、配置与自动化容器验证的结果见版本记录。2026-10-19 已在用户 DS918+ 及独立局域网客户端验证 HTTPS 接口返回 200，并严格校验本实例根证书；尚未在用户手机安装 CA 或完成实际扫码，不把服务端或桌面客户端通过写成物理相机验收。

## 历史：0.6.1 及更早的可选 HTTPS overlay

下文保留原先需要额外 Caddyfile 与叠加 YML 的操作记录。0.6.2 及后续版本直接使用上方完整 YML，不叠加旧 docker-compose.https.yml，也不需要按旧步骤预建 HTTPS 子目录。

当前 0.6.1使用 PostgreSQL，仍复用本页可选 HTTPS 入口；先按[群晖部署](SYNOLOGY.md)准备当前三服务新项目。0.5.1 的 SQLite 容器与 HTTPS 验证记录保留为历史，不能视为本版群晖或手机实机验收。

只部署主 `docker-compose.yml` 时，默认入口是 HTTP 3000 端口，尚未启用 HTTPS 代理。手机实时扫码需完成下文“增加局域网 HTTPS”和“将根证书安装到手机”两部分，再使用 `https://群晖实际IP:8443` 访问；只更新应用镜像不会自动完成这项配置。

手机用 `http://群晖IP:3000` 打开时，浏览器禁止网页实时读取相机。拍照、选图识别和手工输入仍可使用；照片、视频帧均在手机本地识别，不上传到服务器。浏览器的安全限制不能靠升级 JavaScript、安装打印机驱动或增加网页权限按钮解除。

启用实时扫码需要同时满足：**可信 HTTPS、浏览器和系统允许相机、设备有可用摄像头**。本版点击“开启后置摄像头”时先请求相机，再准备本地解码组件，避免组件下载耗时延后相机授权；优先请求后置镜头，停止、切页或隐藏页面会释放相机。HTTP 页面会说明缺少的条件，图片和手工入口继续保留。

已有群晖反向代理、域名和受信任证书时，直接将 HTTPS 反向代理指向原 LabOS 的 HTTP 端口即可。证书须匹配手机访问的域名或 IP，手机须真正信任证书；仅在证书警告页选择“继续访问”不能替代信任。代理需保留原请求 Host（包括外部端口），避免首次设置时同源检查失败。

## 可选：在原 Compose 项目增加局域网 HTTPS

没有域名时，可使用附带的 Caddy 配置为群晖局域网 IP 签发本地证书。此方式需要在每台扫码手机上安装并信任这套私有 CA。只在自己管理并信任的局域网设备使用；不建议将此管理系统直接暴露到公网。

保留原项目名、原 `docker-compose.yml`、原 `.env` 与数据挂载。先按[群晖部署说明](SYNOLOGY.md)备份，**不要为开启 HTTPS 新建空数据卷、重新初始化账号或删除旧项目数据**。将以下两个文件放到原 YML 旁边：

- `docker-compose.https.yml`
- `Caddyfile`

群晖部署时，先在 File Station 的原项目目录内准备 `https/data` 和 `https/config` 两个文件夹，并确认 `Caddyfile` 是上述配置文件。这样可避免厂商 Compose 对不存在的 bind 目录处理不同而阻止代理启动；已有目录继续使用，不删除证书文件。此步骤只准备 HTTPS 代理目录，不改动 `runtime/`。

在原 `.env` 追加 `LABOS_HTTPS_HOST`，值为手机实际访问的群晖局域网 IPv4 或主机名，**不带 `http://`、`https://`、路径和端口**；使用 IP 时建议在路由器为群晖保留固定地址。模板没有预填 IP，未配置时会拒绝解析。可选 `LABOS_HTTPS_PORT=8443`，默认 8443 避开 DSM 常用的 443；如端口被占用改为其他空闲端口。

例如，原项目名是 `labos` 时，在原 YML 目录执行以下命令（其他项目名须使用自己的原名称；群晖可在 SSH 中执行，不在 Windows 启动本地生产服务）：

```text
docker compose -p labos -f docker-compose.yml -f docker-compose.https.yml config --quiet
docker compose -p labos -f docker-compose.yml -f docker-compose.https.yml up -d
```

配置会额外拉取固定的官方 `caddy:2.11.7-alpine` 镜像，新增 `labos-https` 容器；应用继续使用原数据。它通过同一 Compose 网络代理到 `labos:3000`，保留原 Host，不改变账号、数据库、附件及 HTTP 端口。Compose 多文件的相对路径以第一份 YML 的目录为基准；`Caddyfile` 缺失会报错，不会错误创建成目录。

`Caddyfile` 使用 `default_sni {$LABOS_HTTPS_HOST}`，让不发送 TLS 服务器名称（SNI）的 IP 访问仍选中配置的证书。Docker 端口映射后的容器内地址与群晖 IP 不同，仅成功签发 IP 证书并不足以保证握手成功；此设置不跳过客户端的证书校验，手机仍须信任根证书，证书中的 IP 也须与访问地址一致。更换 IP 时同步修改 `.env` 并重建代理，保留原 `https/` 数据。

```text
原项目目录/
  docker-compose.yml
  docker-compose.https.yml
  Caddyfile
  .env
  runtime/              # 使用新模板时的业务数据；旧部署保留自己的原挂载
  https/
    data/               # Caddy 证书、私有 CA 和私钥，须保留且严禁公开
    config/             # Caddy 配置状态
```

`https/` 用于持久化代理运行文件；模板原本依赖 Docker 自动创建，群晖建议按上文先准备两个子目录。它和 `runtime/` 都是运行数据，不提交源码。旧项目仍使用命名卷时，增加此 overlay 不会改动旧卷。不要把包含私钥的 `https/data/` 发送给他人，也不要删除后重建 CA；CA 被替换后，手机原先的信任需要重新安装。没有配置 HTTP 跳转，保留原 HTTP 地址作为图片识别和手工操作入口。

## 将根证书安装到手机

首次运行后，根证书位于 YML 旁 `https/data/caddy/pki/authorities/local/root.crt`。**只导出公开的 `root.crt`，不要复制或导出任何 `.key` 文件。** 可从 NAS 管理界面取出，或沿用上面的项目名执行：

```text
docker compose -p labos -f docker-compose.yml -f docker-compose.https.yml cp labos-https:/data/caddy/pki/authorities/local/root.crt ./https/labos-root.crt
```

通过可信、已认证的 NAS 文件管理或 USB 将 `https/labos-root.crt` 交给自己的手机；不要从陌生来源安装 CA。CA 信任会扩大设备对该 CA 签发网站的信任，只安装自己维护的这一份；停用后可从手机移除。

- **iPhone / iPad**：打开根证书并按系统提示安装描述文件，然后到“设置 → 通用 → 关于本机 → 证书信任设置”，对这份根证书启用“完全信任”。只安装描述文件但未启用完全信任仍不够。不同 iOS 版本可能先在“VPN 与设备管理”中完成描述文件安装。
- **Android**：系统设置中搜索“安装证书”或“CA 证书”，在安全/加密与凭据中选择安装 **CA 证书**，选择上述文件并完成锁屏确认。菜单名称因品牌、版本而异；不是安装 Wi-Fi 证书或用户客户端证书。工作资料、企业管理策略及部分浏览器可能限制用户 CA，需由设备管理员允许，或改用受公共 CA 信任的域名证书。

关闭原 HTTP 页面，用 Safari / Chrome 等完整浏览器直接打开 `https://群晖实际IP:8443`（自定义端口则换成对应端口）。地址必须与 `LABOS_HTTPS_HOST` 相同，浏览器不应出现证书警告。不要把 LabOS 放在不安全 HTTP 页面的内嵌框架中访问。允许浏览器网站相机权限和系统相机权限后，打开物资扫码并点击“开启后置摄像头”。从 HTTP 换成 HTTPS 是不同网站来源，可能需要重新登录，但不是重设管理员或清空历史数据。

排查顺序：

1. 地址确实是 `https://`，IP/主机名和端口正确，NAS 防火墙允许该局域网访问端口。
2. 证书无警告，已信任的是当前 Caddy 实例的根证书；确认未删除过 `https/data/`。
3. 浏览器与系统都允许相机，用完整浏览器直接访问，关闭其他占用相机的应用。
4. 若提示组件加载失败，检查本站 `/vendor/zxing-wasm/3.1.5/index.js` 与 WASM 能否加载；不是更改相机权限可以解决的问题。

本地源码测试覆盖合成相机授权顺序、授权/解码晚返回释放、错误提示与 HTTP 回退，配置测试覆盖缺少主机时拒绝、Compose 合并及目录保持；这些不等于真实手机、群晖证书信任或打印机验收。实际设备仍需完成安装证书、首次允许相机和扫码校准。

## 官方依据

- [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)：`mediaDevices` / `getUserMedia` 的安全上下文和授权规则。
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https) 与 [Docker 使用说明](https://caddyserver.com/docs/running#docker-compose)：本地 CA 需客户端信任，Docker 数据路径及持久化。
- [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)：HTTP 上游默认保留 Host。
- [Caddy default_sni](https://caddyserver.com/docs/caddyfile/options#default-sni) 与 [Docker NAT 下 IP 证书选择说明](https://github.com/caddyserver/caddy/issues/7526)：未发送 SNI 时选择配置的证书，避免按容器内 IP 查找证书。
- [Docker 官方 Caddy 镜像清单](https://github.com/docker-library/official-images/blob/master/library/caddy)：本配置固定 2.11.7 Alpine，包含 amd64/arm64；未来维护升级须另行验证，不用浮动 latest。
- [Apple：信任手动安装的证书描述文件](https://support.apple.com/en-us/102390)：手动安装后须显式开启 SSL/TLS 完全信任。
- [Android 证书安装说明（Cloudflare）](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/user-side-certificates/manual-deployment/android/)：CA 安装路径及不同设备差异；不表示需要 Cloudflare 服务。
