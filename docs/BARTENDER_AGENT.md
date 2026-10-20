# BarTender Windows 打印助手

0.8.0 增加原生 `.btw` 模板、打印站和打印任务。手机或电脑在网页选实物并建立任务，连接 USB 打印机的 Windows 电脑领取任务，再调用本机 BarTender。群晖容器负责保存模板、任务及结果；Windows 助手须在已登录的用户会话中运行。

## 首次准备

1. Windows 安装 PowerShell 7、DL-886A（NEW）官方驱动和已获自动化授权的 BarTender。本次核对的安装为 BarTender 2016 R7；2016 的 `Format.Print()` 和 `SaveAs()` 要求 Automation 或 Enterprise Automation，实际授权仍需本机验证。
2. 先在 Designer 中选择实际打印机，设置真实标签纸的宽、高、间隙及方向，制作一份原生 `.btw`。当前未确定纸张尺寸，不能直接把网页示例尺寸当作已校准母版。
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
3. 下载 `bartender-agent.ps1`，或使用同版源码的 `scripts/bartender-agent.ps1`。同版 Release 已提供独立脚本和本指南附件，附件字节与冻结源码ZIP一致。

打印站令牌仅授权本打印站，不是网页用户密码。服务器只保存令牌摘要；丢失后在网页更换令牌，再更新 Windows 配置。停用站点或更换令牌时，已领取／执行中的任务标为结果不明，须核对实物标签；这不能撤回已经提交到 Windows 的打印数据。

## Windows 检查与初始化

将脚本保存在固定位置，例如 `C:\LabOSPrint\bartender-agent.ps1`。以下命令在 **PowerShell 7** 执行；路径和地址按实际环境替换：

```powershell
Get-Command pwsh
$PSVersionTable.PSVersion
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -Check -RuntimeDirectory C:\LabOSPrint\runtime
```

`-Check` 只读 BarTender 注册版本和打印机清单，不启动 COM 或打印。首次使用会建立专用运行目录并限制访问权限；不要把已有项目根目录、盘根、链接目录或无关非空目录作为 `RuntimeDirectory`。

需要检查 COM 自动化能力时显式执行：

```powershell
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -CheckEngine -RuntimeDirectory C:\LabOSPrint\runtime
```

该命令会启动专属 COM 实例、查询能力后关闭，不打印。如果 BarTender 把调用复用到已打开的 Designer 实例，助手拒绝使用或关闭该用户实例；保存工作并自行关闭 Designer 后再试。能力查询不能代替实际纸张试打或授权验收。

初始化时交互粘贴一次性令牌，输入隐藏，不把令牌写入命令行：

```powershell
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -Initialize -ServerUrl https://192.168.1.10:8443 -Station 物资室打印站 -RuntimeDirectory C:\LabOSPrint\runtime
```

使用群晖当前实际 HTTPS 地址。Windows 须信任该实例根证书，不能通过跳过证书检查运行；HTTP 只允许 localhost 开发。令牌和待回报记录由当前 Windows 用户的 DPAPI 加密，换用户或电脑不能直接复用。保持同一用户、脚本路径和稳定运行目录，升级只替换脚本，不重新初始化或删除运行记录。

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

`X`、`Y`、`Width`、`Height` 为毫米，`FontSize` 为 pt；仅接受这些属性和 `DoNotPrint`。输出路径须为不存在的 `.btw` 文件，母版不保存修改：

```powershell
pwsh -NoProfile -File C:\LabOSPrint\bartender-agent.ps1 -DeriveTemplate -MasterTemplate C:\LabOSPrint\master.btw -Layout C:\LabOSPrint\layout.json -OutputTemplate C:\LabOSPrint\derived.btw -RuntimeDirectory C:\LabOSPrint\runtime
```

派生后仍须在 Designer 核对对象类型、纸张、打印机、字段绑定、预览与首张输出，确认后再上传为新版本。没有提供已校准母版、确定纸张或真实授权时，不能宣称生成的业务模板可直接投入使用。

## 数据与验证边界

打印模板、站点及任务存在 PostgreSQL，更新同一 PG18 项目保留原 `runtime/`、`https/` 和配置。物资 Excel／JSON 导出不包含完整打印记录，应随全库、附件和证书备份。无需公开数据库端口给 Windows 打印助手。

自动测试使用合成模板字节、COM／打印机替身和隔离数据库，实际结果见[版本说明](CHANGELOG.md)。本轮没有启动真实 BarTender 引擎、执行 `SaveAs()`、访问 USB 或验收出纸。原网页打印与 CSV 路线继续可用，见[标签打印](LABEL_PRINTING.md)及[官方接口分析](BARTENDER_INTEGRATION.md)。
