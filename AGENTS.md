# 项目维护约定

- **开工只读 `docs/CONTEXT.md`**（约 80 行速查卡：命令表、文件地图、CSS 覆盖链、压缩文件名单、绝对禁令）。`docs/MEMORY.md`（938 行）、`docs/HISTORY.md`（1041 行）、`docs/DEVELOPMENT.md`（650 行）合计约 28 万字符，**不要通读**：需要历史背景或发布信息时用 `rg 关键词 docs/MEMORY.md docs/HISTORY.md docs/CHANGELOG.md` 定位，只读命中段落。
- **涉及界面（`src/public/`）的任务，动手前必须读 `docs/UI_施工卡.md`**：它把 `docs/UI_DESIGN_SYSTEM.md` 的设计规范转成了文件级、选择器级的施工指令，照卡施工即可，不要自行按规范做设计判断。交付前运行 `node scripts/ui-audit.js` 自查。
- 记录与代码或 Git 状态冲突时先核实，并注明更正；不要将计划、静态分析或有限测试写成已实现、已修复或全面验证。
- 完成有意义的工作后，更新 `docs/MEMORY.md` 的当前状态与新记忆，在 `docs/HISTORY.md` 追加开发事件，并将对外变更记入 `docs/CHANGELOG.md` 的“未发布”部分。
- 保留历史需求、决策和验证记录；旧结论失效时标明被哪次决策或修复替代，不直接抹去历史。不记录密钥、真实密码、会话令牌或业务数据正文。
- 新版本说明始终新增到同一份 `docs/CHANGELOG.md`，按新版本在前排列。发布时将“未发布”内容归入真实版本号及日期，保留所有旧版本说明，并同步版本号、标签及相关文档。不要为文档变更虚构业务版本或移动已有标签。
- `main` 保留发布基线，后续开发在 `develop` 或 `feature/*`；Git 分支不隔离数据，开发使用 `npm run dev`，测试使用临时运行目录。
- 根目录只放必要入口和仓库配置；历史、记忆、版本说明放 `docs/`，运行数据放 `var/`，生成物放 `artifacts/`。后两者不得提交。
- Windows 命令统一使用 PowerShell 7（`pwsh`），不要调用旧版 `powershell.exe`。通过 `Get-Command pwsh` 定位并用 `$PSVersionTable` 确认版本；工具执行时显式指定 `pwsh`。不要硬编码旧安装路径，当前环境使用 WindowsApps 提供的 PowerShell 7。
