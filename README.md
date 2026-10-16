# LabOS 实验室综合管理系统 MVP

本版本覆盖前面方案中的基础闭环：电子档案、电子模板、在线填写与打印、收支台账、资产台账、物资库存、体系文件、人员能力、统一登录、附件、导出、到期提醒、审计日志、Docker 数据服务配置。

## 当前运行方式

当前版本使用 Node.js 22.5+ 内置 SQLite 运行，便于在 Java/Docker PATH尚未恢复时立即测试。正式部署配置已经提供 PostgreSQL 和 MinIO 的 `docker-compose.yml`，后续将文件存储和数据库切换到正式服务。

```powershell
npm run check
npm start
```

浏览器打开 `http://127.0.0.1:3000`，默认账号：admin，密码：admin123。

局域网测试时，其他电脑访问运行电脑的内网IP，例如 `http://192.168.1.100:3000`，并在 Windows 防火墙放行 TCP 3000。

## 生成部署包

```powershell
npm run package:zip
```

会生成 `labos-mvp.zip`，内含启动脚本、服务端、前端和 Docker 配置。当前终端无法识别 Java/Docker，因此本次先验证网页服务和业务接口；恢复 PATH 后再生成 EXE 安装器。

## 正式上线前

需要把默认密码改掉，启用 PostgreSQL/MinIO，增加角色权限细分、审批节点配置、OCR、NAS或对象存储备份，以及数据库和附件的 3-2-1 备份策略。
