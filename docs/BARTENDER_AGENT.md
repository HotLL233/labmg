# BarTender Windows 打印助手

**历史文档：0.9.0起已按用户要求撤除本功能。** 当前标签改用[系统打印与二维码标签](LABEL_PRINTING.md)，不再下载、连接或处理BarTender打印队列。若原Windows电脑登记过登录后台，先用已保存的旧CMD菜单5正常停止，核对当前打印结果后用菜单6移除登记；旧运行目录与打印记录自行保留。本项目不会自动操作该电脑上的真实任务。以下保留0.8.2及更早的使用和验证历史，不能作为0.9.0操作入口。

当前使用说明面向0.8.2。0.8.0增加原生`.btw`模板、打印站和打印任务，0.8.1源码增加纸张覆盖、模板图预览与启动诊断，0.8.2沿用这些功能。手机或电脑在网页选实物并建立任务，连接USB打印机的Windows电脑领取任务，再调用本机BarTender。群晖容器负责保存模板、任务及结果；Windows助手在已登录的同一用户会话运行，可安装为登录后隐藏窗口的后台任务。功能实现与现场验收边界见文末。

0.8.2已公开为验证版（prerelease），双架构离线镜像包已完成本机下载与完整核验；交付入口见[版本说明](CHANGELOG.md)。

0.8.1冻结后的真实Docker生命周期门禁在打印站断言处失败：测试遗漏响应中的动态`busy:false`字段，候选Release未公开。其标签、镜像、源码ZIP及失败证据保留，不改写旧版本；0.8.2仅修正该测试断言并同步版本。已完成的冻结与验证见文末，最终交付状态见[版本说明](CHANGELOG.md)。

## 双击启动与后台方式（0.8.2）

在网页“BarTender 打印 → 打印站”同时下载`bartender-agent.ps1`和`bartender-agent.cmd`，保存到固定的同一文件夹。也可从源码ZIP取出`scripts/`中的这两个文件；Release独立脚本附件仍是PS1，CMD由网页或源码提供。双击**CMD**进入菜单，错误会保留窗口；不要直接双击PS1。菜单本身不会领取任务，选择0退出。已有配置沿用原Windows用户和运行目录。CMD通过PATH查找`pwsh.exe`，缺少PowerShell 7或同目录PS1时显示错误并暂停，不调用旧版`powershell.exe`。

| 菜单 | 操作与开始时间 |
| --- | --- |
| 1 本机检查 | 查看版本、配置及打印机；不启动BarTender，不向LabOS通信或领取任务 |
| 2 初始化打印站 | 首次填写HTTPS地址、站点名及隐藏令牌，仅保存本用户配置；不向LabOS验证令牌或领取任务 |
| 3 开始处理网页队列 | 立即持续领取打印／预览任务，保持窗口打开；Ctrl+C停止 |
| 4 安装／更新登录后台 | 初始化后登记本机任务，不向LabOS通信、不启动或领取；下次该用户登录后运行 |

首次先选1、2；现在处理队列选3。需要以后登录自动运行，可在选3之前先选4。单独完成1、2或4不会让网页打印站变为“在线”。

安装后台时，助手把当前脚本复制到稳定的`<运行目录>/agent/bin/bartender-agent.ps1`，任务始终显式引用原运行目录；以后更换下载脚本或应用版本不更换DPAPI配置、模板缓存及待回执。任务以当前用户的交互登录身份、普通权限运行，同一任务忽略重复启动，不保存Windows登录密码，下次该用户登录后隐藏窗口运行。

电脑需开机且该用户保持登录，退出账号会影响运行。这是LabOS调用本机BarTender的后台助手，不是把商业BarTender安装程序放进群晖Linux镜像，也不是Windows系统账号的Session0服务。官方Integration服务的授权和配置仍须单独核实。

选择5写入停止请求，后台在当前领取／执行／回报周期结束后退出；引擎还在处理时继续等待，未获确认的回执保留。选择5保留登录登记，下一次登录仍会运行；选择6请求同样的正常停止并移除本用户、本运行目录对应的登录任务。两者都保留配置、模板和待回执，不调用强制停止任务或关闭BarTender。受控诊断写入运行目录`agent.log`，达到约1MiB后轮转，保留当前及一份旧日志，不写令牌、标签正文或原始服务器响应。升级后台时先请求停止、等待当前周期退出并核对网页任务，再用新脚本选择4更新副本；安装更新本身仍不启动任务。不要删除运行目录或以结束进程代替正常停止。

如需显式指定稳定运行目录，可在PowerShell7执行：

```powershell
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -Console -RuntimeDirectory C:\LabOSPrint\runtime
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -InstallStartup -RuntimeDirectory C:\LabOSPrint\runtime
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -StopBackground -RuntimeDirectory C:\LabOSPrint\runtime
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -UninstallStartup -RuntimeDirectory C:\LabOSPrint\runtime
```

网页显示打印站从未连接／在线／离线、助手版本、最后通信时间及队列等待原因；“在线”仅表示最近60秒有通信，不保证打印机、许可或物理出纸正常。0.8.0助手可继续处理沿用母版的旧式任务，但不能领取带纸张覆盖或预览的新任务；这些新任务的最低助手协议仍为0.8.1，未随补丁提高。当前安装或升级请使用同版0.8.2应用与助手。

## 两种纸张、方向与原生模板图预览

已确认用户有60×40mm和38.5×30.5mm两种纸。先在Designer按纸张、方向和准确打印队列制作匹配母版，检查介质类型、实际间隙及驱动设置，再上传。网页原生任务默认沿用BTW，可选这两种规格或自定义5–300mm、最多3位小数，横纵由实际宽高确定；设置随任务保存，不覆盖已上传母版。

显式覆盖会按毫米设置PageSetup的纸张／标签宽高、方向和单行单列，将页边距和页内行列间距置零；实际介质送料设置仍由驱动和已校准母版负责。设置后读回方向、`Valid`及纸张／标签尺寸，超出0.05mm容差则打印前失败。它不会缩放或自动重排原生对象。对象的X／Y是可配置参考点，不能可靠推测所有旋转对象的边界，因此任一边比原母版标签小超过0.05mm便拒绝，提示`PAPER_REQUIRES_MATCHING_NATIVE_TEMPLATE`；容差只用于吸收数值误差。此时在Designer制作对应尺寸／方向母版并上传新版本，或选择沿用已校准母版；同一限制也适用于预览和母版派生。

选定实物后可请求范围内首件的“原生模板图预览”，Windows助手按该件快照覆盖命名数据源、应用本次纸张设置，再用2016的`Format.ExportToFile()`生成150dpi PNG回传网页。预览任务只包含一件，不调用Print，不出纸，也不能重印或人工确认为已出纸。图片上限2MiB、宽高各不超过4096像素，检查PNG签名、IHDR和结尾；预览回执失败时保留本地记录并复送图片，不重新调用引擎。

改变模板、实物或纸张设置后须重新请求，历史图片绑定生成时的快照。`ExportToFile`要求Automation或Enterprise Automation，生成的是模板图；完整的`ExportPrintPreviewToImage`要求Enterprise Automation，本版没有调用该方法。网页实时变化的是纸张轮廓示意，PNG内容仍依赖在线Windows助手，不能当作已验证的驱动预览、送料或出纸结果。许可、字体、驱动及实物送料须现场试打核对。

## 首次准备

1. Windows 安装 PowerShell 7、DL-886A（NEW）官方驱动和已获自动化授权的 BarTender。本次核对的安装为 BarTender 2016 R7；2016 的 `Format.Print()` 和 `SaveAs()` 要求 Automation 或 Enterprise Automation，实际授权仍需本机验证。
2. 先在 Designer 中选择实际打印机，设置真实标签纸的宽、高、间隙及方向，制作一份原生 `.btw`。两种已知纸张为60×40mm、38.5×30.5mm，不能把网页示例当作已校准母版。
3. 自动打印母版使用**命名数据源**。从下表选择实际使用的字段，并在网页上传时勾选相同字段；至少包括 `Code` 或 `QRPayload`。设计对象名称、CSV 列名和命名数据源是不同概念，仅更改对象名称不能代替数据源绑定。
4. 编码按原文输出，关闭母版的额外流水、序列化、脚本改码和重复份数。先人工预览、试打一张并回扫；每件固定一张，不能让 BarTender 生成新的物资编码。

| 命名数据源 | 内容 |
| --- | --- |
| `Code` / `QRPayload` | 已生成的单件编码／完整二维码内容 |
| `Name` / `Specification` / `Unit` | 名称／规格／单位 |
| `CatalogCode` | 物资信息库编码 |
| `Region` / `Warehouse` / `Location` | 区域／仓库／存放位置 |
| `Batch` / `ExpiryDate` / `Status` | 批号／有效期／单件状态 |

模板上传仅限具备物资信息库维护权限的系统／物资管理员，文件上限 4 MiB；每次上传生成独立版本及 SHA-256，原版本不覆盖。模板是可信管理员提供的 BarTender 文件，可能含脚本或外部连接，扩展名与摘要校验不是模板沙箱。使用受限 Windows 用户运行助手，并在 Designer 中核对母版内容。

## 网页配置

在“物资”页打开“BarTender 打印”，管理入口按权限显示：

1. “模板”上传校准后的 `.btw`，填写名称并勾选母版已有的命名数据源；只勾选实际存在的字段。可下载原文件或停用模板，停用后不能建立新任务；已建立任务继续使用自己的模板快照。
2. 具备权限管理写权限的管理员在“打印站”新建站点，填入 Windows 打印队列的**精确名称**。可先用下方 `-Check` 查看名称；不要只填驱动型号。注册／更换令牌后仅显示一次明文，关闭窗口后不再提供。
3. 下载同版PS1和CMD，保存到同一固定文件夹；同版Release提供独立PS1与本指南，CMD也包含在源码ZIP和应用的鉴权下载入口，完整交付状态以该版Release为准。

打印站令牌仅授权本打印站，不是网页用户密码。服务器只保存令牌摘要；丢失后在网页更换令牌，再更新 Windows 配置。停用站点或更换令牌时，已领取／执行中的任务标为结果不明，须核对实物标签；这不能撤回已经提交到 Windows 的打印数据。

## Windows 检查与初始化

将脚本保存在固定位置，例如 `C:\LabOSPrint\bartender-agent.ps1`。以下命令在 **PowerShell 7** 执行；路径和地址按实际环境替换：

```powershell
Get-Command pwsh
$PSVersionTable.PSVersion
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -Check -RuntimeDirectory C:\LabOSPrint\runtime
```

`-Check` 显示助手版本、实际运行目录、是否已初始化、是否有待回执、日志位置，以及BarTender注册版本和打印机清单，不启动COM、不领取任务或打印。首次使用会建立专用运行目录并限制访问权限；不要把已有项目根目录、盘根、链接目录或无关非空目录作为`RuntimeDirectory`。检查失败时CMD保留错误，菜单检查返回菜单；网络运行诊断区分HTTP 401／403／409、重定向及连接失败，不显示原始响应或令牌。

需要检查 COM 自动化能力时显式执行：

```powershell
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -CheckEngine -RuntimeDirectory C:\LabOSPrint\runtime
```

该命令请求COM实例，不领取任务或打印。助手读取2016接口的`ProcessId`，必要时用`Application.Window.Handle`映射进程ID；两者都有值时必须一致，再核对注册EXE路径、进程名称、当前Windows用户、会话和启动时刻。只有确认是本次新建的独占实例才使用并在结束后关闭；既有Designer进程始终拒绝接管。无法证明身份时返回受控错误，不隐藏或关闭该实例，因此可能留下需要人工核对的BarTender进程。能力查询不能代替实际纸张试打或授权验收。

初始化时交互粘贴一次性令牌，输入隐藏，不把令牌写入命令行：

```powershell
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -Initialize -ServerUrl https://192.168.1.10:8443 -Station 物资室打印站 -RuntimeDirectory C:\LabOSPrint\runtime
```

使用群晖当前实际HTTPS地址。Windows须信任该实例根证书，不能通过跳过证书检查运行；HTTP只允许localhost开发。令牌和待回报记录由当前Windows用户的DPAPI加密，换用户或电脑不能直接复用。保留同一用户和稳定运行目录；前台升级替换脚本，登录后台升级按前文更新受保护副本，不重新初始化或删除运行记录。

默认目录是脚本所在目录的上一级 `var/printing/`，不会随应用版本变化；下载到任意位置时建议像示例一样显式指定固定绝对路径。运行目录含配置、模板缓存和执行记录，应备份并限制访问，不提交到 Git 或公开分享。

## 建立和运行任务

通过“库存 → 批次余额 → 单件码／打印 → 发送到 BarTender”进入。网页最多加载当前筛选组1000件，选择模板、打印站及起始／结束张，先提交范围内的首件试打。每件固定1份。核对纸张、中文、位置和回扫后，再次从该入口打开，将范围改为尚未打印的部分；例如整组首件已试打且不需重打时，从第2张开始。重印历史任务保持完整原顺序，不提供改范围入口。

在 Windows 启动助手：

```powershell
# 持续领取任务，Ctrl+C 停止
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -RuntimeDirectory C:\LabOSPrint\runtime

# 只处理一次领取／恢复周期
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -Once -RuntimeDirectory C:\LabOSPrint\runtime
```

助手先验证模板摘要、字段、打印机和租约，保存本地记录，收到服务器启动确认后才调用引擎。每条记录覆盖全部选定数据源，包括空值，关闭数据库记录选择、打印提示和额外份数。同一站点串行领取；同一运行目录只允许一个助手进程。

| 网页状态 | 含义和操作 |
| --- | --- |
| 待处理／已领取 | 尚未确认开始打印，可取消；取消与启动由服务器串行判定 |
| 执行中 | 已确认启动，不能取消；不要直接创建重复任务 |
| 引擎已提交 | BarTender 对全部记录返回成功，仍须核对纸张和标签 |
| 失败 | 调用打印前的校验或引擎准备失败，修正配置后按原因建立重印任务 |
| 结果不明 | 断线、超时、进程中断或部分记录可能已提交，先检查打印队列及实际标签 |
| 人工确认 | 管理人员核对实物后填写说明，保留核对人员与时间 |

BarTender 返回成功不等于已出纸或贴标。执行最长 20 分钟；大批量或异常设备可能超时并产生部分标签。结果不明时系统不会自动重排或重印。网页重印建立独立任务，必须填写原因，保留原打印站、模板和原数据快照、单件顺序及固定码，不增库存或消耗新流水。

## 断网和执行记录恢复

启动后发现未完成的本地记录，助手只回报已有结果或“结果不明”，不会重新调用打印引擎。网络恢复后重启助手即可继续回报。任务租约已过期、令牌变更或服务器拒绝回执时，本地记录保留并暂停领取。

若回执已经无法提交，先在网页查看对应任务，并检查 Windows 队列、纸张和已贴标签；确认处理方式后才显式归档本地记录：

```powershell
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -ArchivePending -JobId '<网页任务UUID>' -Reason '已核对打印队列和实物标签，按任务记录完成处理' -AcknowledgeUnconfirmedOutput -RuntimeDirectory C:\LabOSPrint\runtime
```

归档只保存本地记录和原因，不修改服务器状态、不打印；不要用删除运行目录来绕过待核对任务。更换令牌需先按上述过程处理待回执，再有意识地移除 `station.dpapi` 并重新初始化，保留其他记录。

## 从母版派生原生 `.btw`

本版支持在 Windows 上修改母版中**已有设计对象**并由 BarTender `SaveAs()` 另存。不是把 HTML、CSV 或网页 JSON 改后缀，也不从零创建任意设计对象。

在 Designer 中给已有对象设置可查找的对象名，准备 UTF-8 `layout.json`：

```json
{
  "objects": [
    { "name": "物资名称文本", "X": 2, "Y": 3, "Width": 40, "Height": 6, "FontSize": 10 },
    { "name": "内部编码文本", "DoNotPrint": true }
  ]
}
```

`X`、`Y`、`Width`、`Height`为毫米，`FontSize`为pt；对象仅接受这些属性和`DoNotPrint`。自0.8.1起，可在同一JSON顶层另加`"paper":{"widthMm":60,"heightMm":40,"orientation":"landscape"}`，当前0.8.2继续支持，遵守前述尺寸、方向和不得缩小母版的限制；只调整纸张时仍提供`"objects":[]`。这不会自动缩放或移动其他对象。输出路径须为不存在的`.btw`文件，母版不保存修改：

```powershell
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -DeriveTemplate -MasterTemplate C:\LabOSPrint\master.btw -Layout C:\LabOSPrint\layout.json -OutputTemplate C:\LabOSPrint\derived.btw -RuntimeDirectory C:\LabOSPrint\runtime
```

派生后仍须在 Designer 核对对象类型、纸张、打印机、字段绑定、预览与首张输出，确认后再上传为新版本。没有提供已校准母版、确定纸张或真实授权时，不能宣称生成的业务模板可直接投入使用。

## 数据与验证边界

打印模板、站点及任务存在 PostgreSQL，更新同一 PG18 项目保留原 `runtime/`、`https/` 和配置。物资 Excel／JSON 导出不包含完整打印记录，应随全库、附件和证书备份。无需公开数据库端口给 Windows 打印助手。

0.8.2已冻结于`7298bd7d2ab5df2184c2f8eb518428adf0fef5ee`／`v0.8.2`。构建`39383264290`成功，真实PG18回归208/208、41份JavaScript语法检查通过；验证`39383653140`／运维提交`25240aa88739757b7d56153c01ef27c6f8f106c1`四门禁成功。Windows云端作业仅确认官方成功元数据，尚未取得原始日志，不能据此给出云端精确项数；下文3/3及87项属于本机验证。云端容器门禁也不代替BarTender许可、用户登录后台或USB打印验收。

0.8.1 Windows专项的PowerShell内部87项、Node 3/3及PowerShell语法检查通过；Node首项包含这87项，不应重复相加。使用合成模板字节、COM／打印机和任务计划替身，覆盖带单位的实际索引反射、纸张读回、缩小拒绝、预览不调用Print、图片边界、回执复送、进程身份拒绝和后台安装／卸载行为。实际复制到`runtime/agent/bin/`的脚本通过子进程`-Check`入口检查，未启动COM。本机证据为`artifacts/cache/0.8.1/windows-agent-mock-report.json`。

2026-10-20，0.8.2在本机Windows重新执行Node 3/3（0失败、0跳过）与PowerShell内部87项，另有两份PowerShell及一份Node测试文件语法检查通过；Node首项同样包含内部87项，不相加。HTTP传输检查发送当前脚本的实际版本，受保护副本的`-Check`精确核对0.8.2。报告为`artifacts/cache/0.8.2/windows-agent-node-output.txt`、`windows-agent-mock-report.json`、`windows-agent-syntax-report.json`和`windows-agent-verification.json`。这些仍使用相同模拟边界，没有启动真实COM、打印或登记真实登录任务；下段CMD实跑结果保留为0.8.1历史记录。

0.8.1的CMD也在含空格的目录实际执行：缺少PS1时显示错误并暂停、退出码1；PS1同目录时默认菜单选择0后暂停、退出码0。分别见`artifacts/cache/0.8.1/launcher-error-final-report.json`和`artifacts/cache/0.8.1/launcher-console-report.json`。首次测试的手写CMD包装引号有误，失败记录保留；改用正确的原生命令参数后通过。这些检查没有领取真实队列、登记真实登录任务、运行原生模板导出或打印，不能替代任务计划登录后的现场验收。

2026-10-20早先一次获准的只读COM诊断因`ProcessID`未取得可证明独占的ID而停止；检查后曾观察到新`bartend`进程PID 35992保留。没有打开模板或执行SaveAs／Export／Print，也没有Quit或强杀该进程。随后补了canonical `ProcessId`及窗口PID回退和身份核验，但补丁仅经替身验证，未再次启动真实COM；不能据此判定已解决本机许可或引擎兼容问题。实际授权、SaveAs／PNG原生输出、登录后台、USB出纸及热敏效果仍未验收。其他业务与发布验证见[版本说明](CHANGELOG.md)，原网页打印与CSV路线继续可用，见[标签打印](LABEL_PRINTING.md)及[官方接口分析](BARTENDER_INTEGRATION.md)。
