# 项目维护约定

- 开始任务前读取 `docs/MEMORY.md` 和 `docs/DEVELOPMENT.md`；需要历史背景时查看 `docs/HISTORY.md`，发布信息查看 `docs/CHANGELOG.md`。
- 记录与代码或 Git 状态冲突时先核实，并注明更正；不要将计划、静态分析或有限测试写成已实现、已修复或全面验证。
- 完成有意义的工作后，更新 `docs/MEMORY.md` 的当前状态与新记忆，在 `docs/HISTORY.md` 追加开发事件，并将对外变更记入 `docs/CHANGELOG.md` 的“未发布”部分。
- 保留历史需求、决策和验证记录；旧结论失效时标明被哪次决策或修复替代，不直接抹去历史。不记录密钥、真实密码、会话令牌或业务数据正文。
- 新版本说明始终新增到同一份 `docs/CHANGELOG.md`，按新版本在前排列。发布时将“未发布”内容归入真实版本号及日期，保留所有旧版本说明，并同步版本号、标签及相关文档。不要为文档变更虚构业务版本或移动已有标签。
- `main` 保留发布基线，后续开发在 `develop` 或 `feature/*`；Git 分支不隔离数据，开发使用 `npm run dev`，测试使用临时运行目录。
- 根目录只放必要入口和仓库配置；历史、记忆、版本说明放 `docs/`，运行数据放 `var/`，生成物放 `artifacts/`。后两者不得提交。
- Windows 命令统一使用 PowerShell 7（`pwsh`），不要调用旧版 `powershell.exe`。当前环境路径为 `C:\Program Files\PowerShell\7\pwsh.exe`；工具执行时显式指定该 shell。
