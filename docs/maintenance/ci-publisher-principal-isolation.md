# 普通 CI 与发布控制器的 Windows 主体隔离

本 Runbook 绑定 Task `d745ea6e`。适用公司主机 DESK-W-591；源码入口为 [qualify-publisher-host-principal.ps1](../../scripts/ci/self-hosted/qualify-publisher-host-principal.ps1)。本文件不声明生产隔离已经达成，也不替代实际 Claim、Source 准入、独立审核、发布 Grant 或迁移授权。

## 现场边界与阻断条件

公司 Windows runner 的服务配置为 `.\clued-runner`，预期 Windows SID 为 `S-1-5-21-858977881-4031698862-3006450925-1005`。服务 StartName 和直接组清单不是实际作业 token 的证明，须由真实已准入作业读取自己的 token。

公司原 CluedCI-Linux 发行版属于个人 Windows SID 尾号 1000。其四个 Linux listener 虽以 Linux `runner` 用户运行，WSL interop 仍以个人 Windows 主体启动程序；该主体可管理 Hyper-V，并拥有发布私有目录。因此新 VM、Linux 用户、标签和目录 ACL 本身尚不能隔离发布控制器。[Microsoft WSL 文件互通](https://learn.microsoft.com/en-us/windows/wsl/filesystems)

现有个人 `Clued-CI-Watchdog-company-primary` 会恢复四个 Linux unit、Docker 与 keepalive。只停一个 unit、改一个 route 或关闭 interop/automount，均不等于迁移 Windows 主体。

## 第一阶段：固定公司 Windows CI 的有限探针

Task `d745ea6e` 的第一阶段只核实际主体、WSL 可见能力和自己的 S4U canary。源码不包含 WSL import、修改账号/ACL、runner 注册、旧服务停启、旧计划任务变更、生产秘密或发布动作。导入、迁移、网络/启动链和最终隔离资格仍由后续真实证据判定。

公开参数：

| 参数 | 约束 |
| --- | --- |
| `-Mode` | `Inventory`（默认）或 `S4UCanary` |
| `-QualificationId` | 必须为非空 Guid；S4U 每次使用新 Guid，不覆盖旧结果 |
| `-IsolationCanaryId` | 可选 Guid；仅对应固定公开 canary 路径 |
| `-ExpectedQualificationVm` | 可选 Guid；只读查询准确 VM，不枚举、不启动、不修改 |
| 内部阶段 | 仅供脚本自身的固定子进程协议；不是任意命令、路径或执行入口 |

入口要求新的 64 位系统 Windows PowerShell Desktop 5.1 进程，显式导入系统 Utility，避免继承 Node/PowerShell 7 的模块搜索歧义。运行任何 WSL、计划任务或目录变更前，必须实读：

- 机器为 DESK-W-591，SID 精确匹配 1005；
- token 中不存在 Administrators 或 Hyper-V Administrators 成员关系；
- 进程实际处于 Session 0；
- 固定公司 runner 名称、Windows/X64、仓库、main、workflow_dispatch 和严格格式的 GitHub run/attempt/job key/Source/workflow_ref。

GitHub 字段来自受审工作流的真实上下文并与 runtime 环境绑定。这些字段只是观测，不能自行证明 GitHub 准入、Source 接受或签发生产资格。provider job ID 仍需由正式执行记录补齐；不能将 job key 冒充数字 job ID。

当前预期直接 WSL 入口为 `C:/Program Files/WSL/wsl.exe`，版本 2.7.13.0。版本变化返回 UNKNOWN，须重新核定受查对象，不自动安装、升级或改用其他入口。

### Inventory：不写文件

默认模式仅输出 JSON，读取自己 HKCU 的 WSL 注册以及固定 `--version`、`--status`、`--list --verbose`。它不启动发行版，不写报告目录，不注册任务。没有发行版可见、跨 SID 元数据拒绝或未知错误，不可被解释为 import/启动成功。注册读取只针对当前用户，不回退其他人的 hive 或凭据。

可选公开文件路径固定为：

`D:/CluedProductionPublisher/isolation-canaries/<Guid>/public-canary.json`

Root 须先独立确认它真实存在且没有秘密；规定 schema 为 `clued.publisher-isolation.public-canary/1`，包含同一 canary_id 和公开 value。探针只尝试以 Read 打开，不读取正文：

- 成功打开即 FAIL；
- 明确 UnauthorizedAccess 才是该读访问的 PASS；
- 不存在、路径不可确认或其他失败一律 UNKNOWN。

可选 VM 探针由一个最长 6 秒的固定系统子进程导入系统 Hyper-V 模块，执行准确 `Get-VM -Id <Guid>`。模块/命名空间不可用、找不到 VM、查询超时或其他错误均不是 PASS；只有该查询的明确访问拒绝可记读拒绝。此证据不证明 VM 管理修改也被拒绝，不能自动完成生产隔离验收。

子进程的 PASS 必须绑定原准确 vm_id、固定访问拒绝原因、布尔 `production_qualified=false` 和 `management_mutation_denial=NOT_TESTED`；缺字段、错 Guid 或只有一个 PASS 字样一律转为 UNKNOWN。

串口/named pipe 和其他 IPC 暂不连接：Root 必须先登记准确无秘密 canary 端点和访问规则，再做后置否定检查，仍归 Task `d745ea6e`。

### S4UCanary：一次性自己的任务

同一入口支持自己的 Limited/S4U 一次性 demand-run 任务。Microsoft 允许标准用户为自己用 S4U 注册任务而不提供密码，但运行仍要求 Log on as batch job；S4U 也没有 Windows 网络凭据或 EFS 访问。源码不分配该权利，不从个人主体替另一个用户注册，不借密码/RunAs。[任务安全上下文](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)、[S4U 语义](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-principaltype-element)

全部新文件只在：

`C:/Users/clued-runner/AppData/Local/CluedPublisherQualification/<QualificationId>`

保留的源码副本、request、注册 intent、callback、scheduler、cleanup 与 result 均无秘密。没有任意 OutputPath；拒绝旧 Guid 目录、重解析路径和覆盖写入，不修改 ACL。callback 只核自己的身份和 WSL version，写一个固定 callback JSON 后退出。

任务名称为 `Clued-Publisher-Principal-Canary-<GuidN>`，无触发器，不安装开机监督；参数固定到本次源码副本及 callback 阶段。注册用 TASK_CREATE，不更新或替换同名任务。PT45S 只是请求设置和 ownership 核对项：Microsoft 明确 demand-start 的任务绕过 ExecutionTimeLimit，不能称为该任务的 45 秒硬上限。[官方 API 语义](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-itasksettings-put_executiontimelimit)

正常控制依靠 callback 的固定 WSL 子进程 8,000 毫秒超时、父进程对新调度 helper 最多 35,000 毫秒等待及后置精确 Stop/Delete（cleanup helper 最多 8,000 毫秒）；可选 VM 读取最多 6,000 毫秒。结果记录这些预算、实际总耗时和 `execution_time_limit_enforced_for_demand_start=false`，目标在 60 秒内返回。父进程意外终止时不保证这些后置动作执行，也不保证 Task Scheduler 在 45 秒自动杀任务；须复核本次准确任务，保留 UNKNOWN，不能把仍留存的任务报作已清理。

cleanup 必须同时验证本次“准确任务原先不存在”的注册 intent、名称、主体/owner、Limited/S4U、Source hash、描述、唯一固定 action、工作目录、无触发器及执行时限，才停止/删除这一个新任务并复查消失。缺失或失配不触碰任务，报告 UNKNOWN；helper 超时也不能被包装成任务已清理。后续恢复只核本次精确任务，不扫描删除其他 Clued 任务。

返回 `S4U_AND_WSL_VERSION_OBSERVED` 只表示实际 callback、WSL version 与新任务清理已观测；所有报告都固定 `production_qualified=false`。失败报告保留原 Guid/错误类别，不能换 key 抹去实际失败或成本。源码无法访问自身结果目录时以 stdout 返回明确失败，由工作流按原证据保留机制保存。

三个阶段报告须匹配原 Guid、Source hash、同一 run/attempt/job/workflow 及当前实际 Windows 身份。callback 只有同时含准确 WSL 入口/版本、OBSERVED 子调用、整数零退出码和对应版本输出才可汇总为已观测；嵌套 WSL UNKNOWN 不得被顶层 OBSERVED 掩盖。scheduler 还必须证实先前不存在、实际注册、ownership 校验、run、实例 Guid 和零任务结果；cleanup 须证实本次 intent、实际任务存在、ownership、准确删除和随后不存在，缺任何事实都不能汇总成功。

## 后续迁移与完整验收顺序

以下工作归 Task `d745ea6e`，按实际证据推进，不以本 Runbook 的存在视为已做：

1. **WSL 实际能力。** 经上述有限 probe 后，以 SID 1005 用已验证无凭据 rootfs 在自己准确受控路径验证 import/启动/退出、空间和网络，再做自己的合法监督。WSL 是分 Windows 用户注册，`--import-in-place` 仅注册给定 ext4 VHDX，不是改旧注册的所属用户；不得双用户指向同一 live 磁盘。[WSL 命令](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)
2. **新启动链。** 新发行版的 runner units 初始禁止接活，核原生 runtime、systemd、Docker、工作区、端口锁和 job-start hook。systemd 服务本身不会维持 WSL 存活；须实测合法 keepalive/监督在 job 结束后仍工作，不能通过逃逸 runner tracking 留后台。[WSL systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd/)
3. **四 listener 一起安全排空。** 沿用 [运维规范第 7 节](runner-configuration-and-operations.md#7-排空维护与减少-runner)，记录全部四个注册、标签、routes、unit 和监督状态；阻断所有通用能力与特定 route/group 的新派单。等待至少当前 60 秒领取窗口，两轮间隔至少 5 秒核已分配/运行 job、busy、各 Worker 与最后 listener 事件，停前再读。缺证据不停止 KillMode=control-group 服务。[GitHub 领取窗口](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
4. **停个人主体恢复链。** 精确暂停旧计划任务、Startup/HKCU 重复入口及 keepalive；排空后只停目标四 units。旧发行版再次启动也不得恢复个人主体接活，不全机 shutdown，不动 docker-desktop 或其他负载。
5. **配置切换和私有材料。** profile/watchdog/validator/容量脚本须绑定新实际 Windows 主体，保留既有阈值和门禁。优先清洁 rootfs；整盘 export 带有注册和 hook key，是秘密快照，不能作为公共工件或放普通 work。保留材料与旧磁盘删除分别治理，不克隆旧凭据接活。
6. **真实否定证据。** 实际 Windows CI token 与新 Linux runner（包括 Docker root 等效威胁）对发布私有 canary 读/写、控制器/运行时、底盘/子盘、凭据、准确非生产 VM 管理和串口/IPC 的权限均须验证。只读拒绝、无直接组成员或标签不能替代这些证据。
7. **恢复调度与资格。** 先一新 slot 隔离真实 job，核 run/attempt/job/head/runner、钩子、能力和清理，再其余三 slot。确认旧 SID 1000 的 Linux Listener/Worker 没有继续接活；按适用范围完成故障、登出、冷启动及恢复验收。主机重启不是跳过运行负载排空的理由。

新增/修改的 Source、资格 workflow、部署资源和实际 CI 都按现行精确 Claim/受保护准入/非 PR Source 接合流程办理。新入口不关闭门禁，不隐式切换付费托管机；也不修改别的会话持有的 profile/workflow。

## 回退与收口

新主体链不合格时保持新 cohort 隔离，保存准确失败和受限恢复材料，在现 Task 内修正复验。已撤销注册不因配置回退而复活。

如必须暂时恢复个人主体旧 Linux 池，发布边界必须回到“未资格”，不得给生产秘密或继续发布；不能恢复旧池同时宣称隔离仍成立。是否可只维护公司四 Linux、暂由现有公司 Windows 与 Turing Linux 承接，须先实核必要 route/门禁与容量已由可靠替代覆盖，不以维护造成的假绿或无限排队代替验收。

当前源码只提供第一阶段 probe。import、完整主体迁移、四节点排空、发布 IPC/管理拒绝、持续启动链和生产发布资格仍是 Task `d745ea6e` 的待验证交付，不由一次 Inventory/S4U 返回值继承。
