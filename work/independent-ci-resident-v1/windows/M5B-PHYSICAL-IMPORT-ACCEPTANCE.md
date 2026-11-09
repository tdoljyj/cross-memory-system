# TURING 一次性批处理账户实机验收（隔离链已通过）

此入口用于验证 M5-b 导入路径，默认只编译。它没有执行授权；Agent 须先核实当前 Owner 授权并完成独立审核，再拉起已批准的管理员进程。Owner 只处理 UAC，命令与结果由 Agent 运行和观察。

## 2026-11-09 22:04（Asia/Shanghai）实际结果

已审 `logging-blocked` 新阶段实际构建退出 0、主程序退出 0。原导入任务
与独立第二次批处理心跳任务均退出 0、运行实例数为 0。实际导入诊断的
version、status、import、probe 四项均退出 0；SID、用户档案、hive 和发行版
注册一致。第二次心跳实测登录类型 4、session 0、非管理员；其自身再次执行
Linux `/bin/true` 退出 0，执行前后同一 SID、BasePath 和 DefaultUid。

这证明本轮一次性账户的导入、探测与独立第二批处理测试心跳。前三次失败
仍然保留；这不是首次无失败的整套安装，也不是正式认证 supervisor、两台
节点、跨重启或 Owner 登出后的正式运行资格。测试对象尚未清理。

| 证据 | SHA-256 |
| --- | --- |
| `logging-blocked.snapshot.json` | `9634a8c056c802e85fe719007b53785fb176c7cf6fd4676a10f847c1076c4d39` |
| 实际 import 诊断 | `e500a1c79111e95bdca985f04505d11892fb573d916701a5a15534fcc39dfc22` |
| 独立第二批处理测试心跳 | `3216bf1ac1e646ecb9cdd2c066afaf14a17bdac00a4d6be85c574d9feae8b335` |
| 新阶段结果 | `6c022d796e228fa4b51aa0af6af4c4867f89d82ecdd9913cf30bc9764c871da8` |

公开快照位于 `C:\ProgramData\CluedM5bPhysicalReceipt1109\logging-blocked.snapshot.json`。
实际主程序 SHA 为 `4fc392a08477b1e95873a00bd2638432193af3f62a9d99a3483d5879eeaa35b1`，
输入 harness 源为 `766bae28b8539b4c10df30ec83b310fc49f42d313ffead35abb494b402c17f9d`；
生产 registrar 输入仍为 `11412cf33ae0b286087d57433fba273fef50be1ed582dad06ce9ea33334d877b`。
以下各阶段说明包含原失败和当时的候选前置，不能据此重新运行已消耗的入口。

固定对象：

| 对象 | 精确值 |
| --- | --- |
| 机器 | `TURING` |
| 新账户 | `clued-m5b-1109` |
| 独立根 | `C:\ProgramData\CluedM5bPhysical1109` |
| 单次受保护构建根 | `C:\ProgramData\CluedM5bPhysicalBuild1109` |
| 任务目录 | `\CluedM5bPhysical1109` |
| 测试发行版 | `CluedM5bPhysical1109` |
| 独立 Owner 种子发行版 | `CluedM5bSeed1109`，由 Agent 在本入口外准备 |
| 输入种子盘 | `C:\ProgramData\CluedM5bSeed1109\ext4.vhdx`，输入精确 SHA-256 |

不借用任何既有账户、任务目录、测试根、生产 companion、生产根或 CI 发行版。不执行整机 `wsl --shutdown`。种子由 Agent 从已核实的官方小型 Alpine rootfs 创建独立的 Owner 测试发行版，保存来源、校验值、原始输出和退出码。根、账户、任务目录或该账户的固定档案目录已存在即拒绝。本入口不生成或下载种子，不导出任何生产发行版。

本轮输入的实际来源：Owner 新建的 `CluedM5bSeed1109` 测试发行版 import、probe、精确 terminate 均退出 0；`--export --vhd` 返回 `ERROR_SHARING_VIOLATION`，并未成功导出。随后另经审核的 `complete-m5b-stopped-seed.ps1` 实际退出 0，从已停止的测试 VHD 作稳定只读复制，三次 SHA-256 一致。现输入为 `C:\ProgramData\CluedM5bSeed1109\ext4.vhdx`，长度 **79,691,776 字节**，SHA-256 **`86b75a42423b5af3499442ff08cbfe38a6cfc5bc85c72514e586163601e6ce71`**。这不是 export 成功的证明，也不代表生产备份资格。

## 可审入口

```powershell
# 默认只编译，输出构建位置、源与程序哈希；不创建账户、任务或 WSL 对象。
& .\test-m5b-physical-import.ps1

# 仅在审核与精确授权后，由 Agent 启动的管理员进程执行一次。
& .\test-m5b-physical-import.ps1 -Execute -SeedSha256 '<已验证的种子盘SHA256>' -ExpectedRegistrarSha256 '<已审registrar源码SHA256>' -ExpectedHarnessSha256 '<已审harness源码SHA256>'

# 可重复只读查看；不续跑、不重试任何实际操作。
& .\test-m5b-physical-import.ps1 -Inspect
```

特权调用者须先通过已知、已审的干净入口加载此脚本，清除当前子进程中的 CLR/运行时注入变量；本脚本拒绝发现此类变量的现有进程，且不修改 Host 全局环境。脚本本身也须通过受保护副本或已核对的编码脚本字节加载，不可从可写目录再次按路径读取；编码入口可通过 `-SourceDirectory` 指明原本的本地源码目录，后续读取仍使用锁定句柄与已审哈希。脚本用固定 `ProcessStartInfo` 环境白名单启动编译器与 harness，清空其余环境，包括 `COR_`、`CORECLR_`、`COMPlus_`、`DOTNET` 等注入入口。

源码只打开一次并在锁定句柄上读取快照，拒绝重解析点、目录、意外最终路径及超限内容；从快照字节核对两项已审 SHA-256。执行模式通过原子 `CreateDirectoryW` 在可信 ProgramData 父下创建 BA/SYSTEM-only 构建根，把已验证字节写入保护副本后编译并执行。构建根已存在就拒绝，不接收 Temp 构建产物。默认仅编译可留 Temp 产物，但没有执行该产物的代码路径；`-Inspect` 只读 PowerShell JSON，完全不执行程序。

`C:\` 与 `C:\ProgramData` 必须全部为普通目录、Owner 为 SYSTEM/Administrators/TrustedInstaller，且非受信主体不能删除/重命名既有子项或改变权限、Owner。Windows 默认 create-child/metadata 与 inherit-only 项不误拒；不修改系统父目录 ACL。种子目录也须满足可信 Owner、无非受信写入权限。独占只读打开种子并核对哈希，保持该句柄直到验收结束。只在新建的受保护根下复制测试盘，并校验复制结果。

账户通过生产 registrar 的原子 `NetUserAdd`、随机密码和加固 helper 创建：Users 组、允许批处理登录、拒绝网络/RDP/交互登录。所有既存同名档案项（包括文件和 dangling link）均拒绝；创建后档案必须恰为 `C:\Users\clued-m5b-1109` 且无链接，不接受后缀目录。全程不交互登录。密码始终停留在非托管内存及 BSTR 中。

导入任务的 XML、编码动作与脚本直接来自当前 `RegistrarCore.ImportTaskXml / ImportArguments / ImportScript`。注册直接调用生产 registrar 的私有 `RegisterWithPassword` COM-vtable 方法，位于独立任务目录，使用最低权限 Password 登录，无触发器。第二个固定测试心跳任务在同一份内存密码清零前注册；导入成功前不运行心跳。任务读回记录动作/任务哈希、SID、登录方式、权限级别及实际 SDDL，拒绝非受信主体的写入、执行、权限或 Owner 变更权限；任务目录必须仅含 SYSTEM 与 BA 各一项完整权限。每个任务只发起一次 Run，先写启动记录再提交实际动作，未知结果不重试。

## 成功证据与限制

成功必须同时具备：真实任务退出码为 0、新生成诊断的版本/status/import/probe 四条命令均为 0、诊断 SID 和档案 hive 符合新账户、发行版注册目标匹配，随后固定测试心跳实际成功。心跳程序通过当前 token 的认证会话调用 `LsaGetLogonSessionData` 读取实际登录类型，要求 Batch=4 和非管理员身份。

心跳第二个批处理 token 必须重新校验真实微软签名 WSL 客户端，并在环境白名单下实际执行固定 `--distribution CluedM5bPhysical1109 --exec /bin/true`（60 秒上限、输出保留上限与敏感信息过滤）。执行前后均从当前 HKCU/Users hive 读取 SID、精确档案、发行版 BasePath/DefaultUid；这些事实、客户端哈希/签名和实际探测退出码一起绑定到本轮心跳。客户端验证 30 秒上限，整个心跳任务 3 分钟上限。仅写 Windows JSON 不算成功。

完整阶段与事实保存在独立根的 `stages.jsonl`、`manifest.json`、`import-task.xml`、`batch\companion-wsl-import-result.json`、`results\test-heartbeat.json`、最终 `result.json`；构建目录保留编译与主程序原始输出/退出码。失败保留所有现场，不覆盖旧尝试。

测试心跳没有正式 token，**不等同于正式 supervisor、正式心跳资格、跨重启或跨登录验收**。本入口只证明所记录这一轮隔离导入、探测与测试心跳。后续真实部署仍按其原有范围与验收执行。

## 保留与清理

本候选刻意未实现删除功能。失败或成功都保留测试对象，禁止通过再次 `-Execute` 续跑。清理须另经审查，以本轮 manifest 的精确账户 SID、任务目录与测试盘标识核对现场；先证明测试任务与发行版均已结束，再按精确测试对象清理，保留日志与必要盘副本。不得注销生产发行版、递归删除推算路径或删除唯一测试盘。未有清理回执前不宣称已清理。

## 已注册但尚未运行的精确续做候选

12:23:58–59Z 这一轮已实际创建测试根、账户和档案，组与四项登录权利成功，导入和心跳任务注册 HRESULT 均为 0，密码已清零。随后在首次任务安全描述符核验处拒绝，原结果仍为 `TASK_OWNER_OR_DACL_REFUSED`。13:01:34Z 的受控管理员只读诊断确认：两个任务 Owner 均为 BA、ControlFlags 均为 32772、没有 protected 标志；各自恰含三项显式非 callback Allow ACE：SYSTEM 完整权限、BA 完整权限、固定批处理 SID `…-1016` 的 FR。私有任务目录 Owner 为 BA、具有 protected 标志，恰含 SYSTEM 与 BA 完整权限。故本次拒绝来自任务的 protected 标志缺失，并非 Owner 不符。实际诊断字节 SHA 为 `a1a696d323c5cee006f62499cfffd533728de342e9142b34f1124fcd994f410c`。

新代码保留原 protected 分支及危险权限检查。仅本轮固定 TURING／任务路径／SID／旧 manifest／动作／旧心跳程序全部匹配的 registered 续做，允许上述精确 ControlFlags 与三项 ACE 组合；每次 Run 紧邻之前重新核验私有父任务目录的路径、BA Owner、protected 和两项完整权限，再核该任务的 principal/action/no-trigger/ACL。不改变任务 ACL，不把本例的 protected 现象推广为其它任务的安全事实，也不接受批处理账户作为任务 Owner。

新增的 C# `resume-registered <exactOldManifestSHA>` 只承接这一个已知阶段，不是一般的重试或既有账户复用入口：

- 原 runId：`5653e46c-67e6-4557-9b87-50e10202c7fd`；原 SID：`S-1-5-21-1173730660-3877291096-655431861-1016`。
- 原 manifest 字节 SHA：`905477f26cecabdd51ce3fe3d1077881d06bf359dd2636c8a69a5284f7874ffb`；原 stages 字节锚 SHA：`b31aa29993c78fbf3177a1a215f52ce42065dcf0df6ddc403127b236e179f5fc`。原 Main 没有写 `failure.json`，故实际核验的是该 stages 原字节前缀及末尾的精确失败对象，允许其后仅追加 `resume-registered:` 诊断。
- 原受保护 harness 源码 SHA：`52ec0731a881a94805778789f9eee3f0c1be9ecaa943cebea536b98a187659de`；registrar 源码 SHA：`11412cf33ae0b286087d57433fba273fef50be1ed582dad06ce9ea33334d877b`；原 BuildRoot exe 与 Root/bin 心跳 exe 均须为 `7bc20b77f0e640309a1a6057eb159cb7894d04fd1c09b20797ab9120475ae403`。

续做须由 TURING 上固定 Operator `S-1-5-21-1173730660-3877291096-655431861-1001` 的已提权进程执行。重新验证根、bin、batch、results 的精确保护 ACL、账户 SID／档案／Users-only 加固／四项登录权利、原种子与未运行目标盘的长度和 SHA。任务目录只能含原两个任务且无子目录；两任务必须保留原 principal/action、无 trigger，`LastTaskResult=0x41303`、本次实际未运行时间 `1999-11-30T00:00:00`、`GetInstances(0).Count=0` 和 Ready 状态。运行第二个任务前仅要求该心跳任务仍未运行，不把已执行导入任务误作仍未运行。任何不明结果均拒绝；不会改密码、注册任务、修改动作或安全权限。

Root 的新受控编译入口须保留旧源和旧程序，以 CreateNew 写入同一 BA/SYSTEM-only BuildRoot 下的 `M5bPhysicalImportAcceptance.resume-registered.cs` 与 `M5bPhysicalImportAcceptance.resume-registered.exe`，使用旧 registrar 源和干净环境编译。另以 CreateNew 写入 `resume-registered.build.json`，字段必须恰为：

```json
{
  "contract": "clued.m5b.registered-resume-build/1",
  "originalManifestSha256": "905477f26cecabdd51ce3fe3d1077881d06bf359dd2636c8a69a5284f7874ffb",
  "originalRunId": "5653e46c-67e6-4557-9b87-50e10202c7fd",
  "registrarSha256": "11412cf33ae0b286087d57433fba273fef50be1ed582dad06ce9ea33334d877b",
  "harnessSourceSha256": "<本次已审新源码实际SHA256>",
  "executableSha256": "<本次新编译程序实际SHA256>",
  "executableName": "M5bPhysicalImportAcceptance.resume-registered.exe"
}
```

编译器 `/main:M5bPhysicalImportAcceptance` 不变；新入口不能再调用原 `-Execute` 或已消耗 once 的 preflight wrapper。全部只读核验通过后，先 CreateNew `resume-registered.intent`，再按原顺序运行导入任务一次、旧 Root/bin 心跳任务一次，保留原 RunTaskOnce／ValidateImport 和第二批处理 token 的 Linux 探测门。成功只写 `resume-registered.result.json`；失败写新 `resume-registered.failure.<resumeId>.json`。原 manifest、失败锚和首次 Main 失败状态不改写、不转报为第一次成功。intent 已存在或任何任务曾运行后，禁止再次使用此入口。

对应外层候选为 `resume-m5b-physical-registered-reviewed.ps1`，须由经独立审核的干净字节绑定 bootstrap 加载，不能从可写路径直接 `-File`。入口锁定现有保护目录、验证旧源码／程序／manifest／stages 和实际诊断，锁读已审新源码快照后编译新名称；编译器及新程序均使用环境白名单。外层回执只 CreateNew 到 ReceiptRoot 的 `registered-resume.*`，既有开始标记、新源码、新程序或新 build receipt 任一存在即拒绝。编译失败、超时或子程序失败均保留现场且不自动重试。外层成功也不改变“原 Main 已失败”这一事实。该候选已做 Windows PowerShell 5.1 AST 与 24 项只读／纯断言检查，未据此宣称任何实机任务已运行。

## 已知导入失败后的磁盘权限修复阶段（新候选）

13:23:33Z 实际已接受导入任务 Run，原观察器随后在 Refresh 上抛出 `0x8004130B`。后续独立管理员只读采样证明任务已结束，退出码 **3**；四个 WSL 命令为 **0 / 0 / -1 / -1**，导入报磁盘附加拒绝访问，注册为 null。心跳仍为 `0x41303 / 1999-11-30 / instances=0`。这不是导入成功，更不能直接执行心跳。采样回执 SHA 为 `7132c3eb019e0149dc43c484fabec0e2aba7224b6a395fb72e4dbff33fdac81c`；原导入诊断 SHA 为 `a3a92d4e231c6ff226228b8426139eb937e90e49c53985ea22724c11dea58aae`。

WSL 2.7.11 源码（tag commit `acbcb81fc61079b74835ea7dc2563046b2557033`）在可写 VHD 挂载前模拟调用用户执行 `HcsGrantVmAccess`，需要为 VM 增加文件 ACL。该版本明确说明管理员 Owner 会使普通用户缺少所需的 WRITE_DAC。本候选仍须先实查本轮盘的 Owner、精确 ACE、单链接、长度和 SHA，不能凭源码推断直接改盘。

新的 `disk-access-correction <exactOriginalManifestSHA>` 只适用于上述已知失败。它继续使用原账户及两个任务的已保存凭据，不重置密码、不重新注册任务；原 Main 与 registered continuation 两次失败一直保留。前置绑定包括原 run/resume、manifest、旧 source/PE/build receipt、旧 intent/failure、失败 stages 字节和实际管理员采样。原导入任务必须仍为退出码 3、精确本地 LastRunTime `2026-11-09T21:23:33`、Ready、无实例／trigger；心跳须仍未运行。

盘须为原 79,691,776 字节、SHA `86b75a42…` 的固定目标。原 Owner 只能为 BA 或固定 Operator；三项 Allow ACE 必须恰为 SYSTEM/BA 完整权限和固定批处理 SID 的 Modify，不能已经通过 Owner 或其它 ACE 获得 WRITE_DAC。核对成功后先将旧导入诊断原字节 CreateNew 到 ReceiptRoot 的 `disk-access-correction.attempt1.import.json`，该文件单独为 BA/SYSTEM-only 保护 ACL；再写新 `disk-access-correction.intent`。只有这一个 VHD 数据文件改为显式 protected 三项 ACE，批处理账户权限从 `0x1301bf` 变成 `0x1701bf`，权限增量仅 WRITE_DAC，原 Owner 不变。目录、程序、任务权限不变，不预授所有 VM 组。

本阶段经独立审核后，原导入任务最多再运行一次。这是新获准的已知失败修复尝试，不是未知结果自动重试。旧路径之后的诊断明确属于 attempt 2，旧失败字节已独立归档。修复后的观察器只对精确 `0x8004130B` 继续读取注册任务终态，仍要求 Ready、实例为 0、本次运行时间及真实终态结果；其它异常保持未知。只有新导入任务退出 0、四阶段退出 0、身份／hive／发行版注册全部核对成功才发起原心跳任务一次。

外层新入口为 `start-m5b-disk-access-correction-reviewed.ps1`，另用 CreateNew 的 source/PE/八字段 build receipt 和 `disk-access-correction.*` 回执。无论 child 成功、失败或未知，finally 都尝试导出带界限及敏感过滤的实际任务、导入诊断、阶段、intent/result/failure、心跳文件和 VHD 实际 ACL 快照到 Owner 可读回执；采集失败另写元数据，绝不因此重跑任务。新 intent 或外层开始标记存在即拒绝再次使用。当前只完成本地编译、纯 guard／fakeCOM 和只读入口检查；未据此宣称已修改磁盘或完成第二次实机导入。

## 诊断发布被目录持锁阻挡后的新阶段

磁盘权限修复阶段已实际完成单盘权限设置，随后导入任务退出 **7**，旧诊断字节仍为 `a3a92d4e…`。退出 7 是 `WSL_IMPORT_DIAGNOSTICS_UNWRITABLE`，不能据此声称 WSL 导入命令又执行并失败。实际 snapshot `ea6ea584…` 记录：原 Task LastRunTime `2026-11-09T21:49:09`、无运行实例，心跳仍未运行；盘 Owner 为 BA，保护 DACL 的固定账户权限为 `0x1701bf`。

普通用户 NTFS 对照从真实 `RegistrarCore.ImportArguments` 解码脚本并提取四个诊断函数，证实目录 `GENERIC_READ/shareRead` 锁会使 `File.Replace` 返回 `0x80070497`；释放锁后同一路径恢复成功。只把目录共享改为 Read|Write、仍不共享 Delete，诊断替换成功，目录重命名仍被拒。仅用 READ_CONTROL 持锁或共享 Delete 会允许重命名，未采用。文件读句柄继续仅共享 Read，写入和重命名仍被拒。

新 `logging-blocked <exactOriginalManifestSHA>` 阶段只承接固定 correctionId `797eaaa9-e19e-4d2f-8ddb-727348fea693` 的已知日志发布失败，绑定其 intent、failure、snapshot、stages，以及原 `cf04a44a…` 源和 `f3b44379…` 程序。预检仍须盘为 BA Owner、精确三项 `0x1701bf` DACL、单链接、原长度和 SHA；旧诊断的原字节及 SID Owner、既有 BA/SYSTEM-only 归档均只验证。它不再设置 ACL、不重归档、不改账户、密码或任务。

新 CreateNew `logging-blocked.intent` 之后，原导入任务最多运行一次；只有真实任务退出 0、新诊断四阶段退出 0、ValidateImport 身份／hive／注册全部通过才运行原心跳一次。外层 `start-m5b-logging-blocked-reviewed.ps1` 使用独立 source/PE、九字段 build receipt 和回执前缀，finally 自动导出新快照。前三次失败及其 intent、诊断归档均保留，不能转报为首次执行成功。

仓库回归为 `node --test test/m5b-diagnostic-ntfs.test.mjs`，内部包含原 12 项真实 NTFS 对照和 4 项真实新 entry helper 的目录／文件锁断言；仅改变新建临时目录，不运行任何任务、账户操作或 WSL。Windows PowerShell 5.1 下已通过，同时新阶段纯编译和 93 项 guard／fakeCOM 断言通过；随后 22:04 的实际通过回执列于本文开头。
