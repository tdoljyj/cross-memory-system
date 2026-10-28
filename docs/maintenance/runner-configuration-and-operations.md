# Runner 配置与运维规范

版本：v1.4；适用仓库：`tdoljyj/cross-memory-system`。费用原则按 Owner 2026-10-18 的明确要求修订；部署核对仍为 2026-10-10，包含控制入口 PR #700 和质量分类 PR #701；全仓临时目录补齐与本规范同 PR 审核，以该 PR 的实际合入提交为实现边界。旧 v1.1 无窗口安装器候选在 PR #615，尚未合入，不能当作当前主线实现。

本文件是工程 Runbook，规定配置、上线验收、日常维护、增减与回退的操作要求。它不声明某台机器此刻在线，也不代替操作授权、KooYomi 当前任务或 GitHub 准入。下文的“必须”是执行本规范的要求；“现状”只说明编写时已核对的实现。未实现的要求见第 12 节，不得据此宣称已达标。

## 1. 来源、职责与变更边界

| 内容 | 查阅入口 |
| --- | --- |
| 期望身份、路径、能力、生命周期、容量与安装包散列 | [node-profiles.json](../../scripts/ci/self-hosted/node-profiles.json) |
| 静态校验、基础安装与看门狗生成 | [self-hosted 目录](../../scripts/ci/self-hosted/)；[validator](../../scripts/ci/self-hosted/validate_node_profiles.py)；[renderer](../../scripts/ci/self-hosted/render-host-watchdog.ps1) |
| 作业启动钩子、安装与安全边界 | [runner README](../../scripts/runner/README.md)及同目录包装器 |
| 在线、标签、忙闲、实际执行结果 | GitHub Settings → Actions → Runners，以及 workflow/job 日志 |
| 机器实际账号、服务、PATH、ACL、看门狗 | 目标电脑上的只读检查 |
| 决定、授权、执行认领、验收与回执 | 认证的 KooYomi 服务；仓库 `memory/` 只是只读历史快照 |

配置冲突时先停止受影响操作并登记差异，不能任选一份旧说明继续。配置清单描述期望值；运行证据描述实际值；两者不能互相冒充。旧 README 的数量和历史资格不作为当前运行依据。

Owner 决定容量、受保护变更及停机范围；执行者只在授权机器和范围内操作；管理员完成需要提升权限的安装与加固；独立审核者只读核对精确版本。文档审核通过不自动授予账号、凭据、重启、删除或生产权限。

每次实施使用现有对应 KooYomi Task；没有任务时按明确授权登记一个。修改仓库、安装、测试、CI 或派发审核前取得认领。脚本/配置变更走正常分支与 PR，按当前门禁取得受保护路径的精确提交批准。合并前取合并位，失败或等 Owner 时交还。不得 force push、reset、rebase、直接推 main、删必需检查或改钩子绕过拒绝。具体门禁以当时服务契约与主线实现为准；一次性例外不得推广。

## 2. 当前清单与配置底线

本次主线清单有两台主机、七个 runner 条目：六个 active，家里 `home-linux-01` 已于 2026-10-21 退役（`state: retired`）。2026-10-10 GitHub 注册 API 核对到同一七个名称及能力标签（当时七个均为 active）。表格是配置身份快照，未来数量从清单重新读取，不能把它当动态在线监控。

| 主机 / HostId | 容量配置 | runner | 独立根目录 |
| --- | --- | --- | --- |
| DESK-W-591 / company-primary | workstation-v1 | company-win-01 | `C:\clued-ci\runner-company-win-01` |
| 同上 | 同上 | company-linux-01 | `/home/runner/actions-runner` |
| 同上 | 同上 | company-linux-02 | `/home/runner/actions-runner-02` |
| 同上 | 同上 | company-linux-03 | `/home/runner/actions-runner-03` |
| 同上 | 同上 | company-linux-04 | `/home/runner/actions-runner-04` |
| Turing / home-primary | compact-v1 | home-win-01 | `C:\clued-ci\runner-home-win-01` |
| 同上 | 同上 | home-linux-01（已退役，保持离线） | `/opt/actions-runner` |

表内名称均加前缀 `clued-ci-`。公司 WSL 为 `CluedCI-Linux`，家里为 `Ubuntu-24.04`；Linux 服务用户为 `runner`。完整服务名、路由标签和看门狗路径从清单取，不能按机器名猜测。

`home-linux-01` 随 2026-10-21 家里独立 CI 切到 Source v2 退役：家里的必需检查改由常驻独立 CI 执行器给出，它不是 GitHub runner，不在本清单内。清单保留该条目并标 `retired`；健康监控不再期望它，路由心跳不再探测它，注册保留但离线不算异常。不要重新启用它；按 Owner 的切换决定，恢复旧 runner 前必须先撤销独立 CI 正式资格并清除其签名能力。

本次证据边界：公司四个 Linux unit 为 `User=runner`、`KillMode=control-group`、各自独立工作目录且 active；公司 `.wslconfig` 实际为 28 GB / 16 CPU / 8 GB swap。家里 `Ubuntu-24.04` 的 Linux 服务本轮只读复核为 active、`User=runner`、`KillMode=control-group`、根目录 `/opt/actions-runner`（该 runner 已于 2026-10-21 退役，此条只作历史证据）。两台原生 Windows 服务本轮经管理员只读复核均为 Running/Auto、`StartName=.\clued-runner`。这些定点读取不替代启动链、冷启动或登出无人值守验收；相应资格仍按历史精确证据及变更失效规则使用。

### 2.1 身份、目录与路由

- 名称唯一，遵循 `clued-ci-<site>-<win|linux>-NN`；服务名、根目录、工作区和诊断目录不可复用。旧编号已退役时，复用必须是明确的恢复操作，不能覆盖历史身份。
- 每个 runner 只使用自己的 `_work`、`_diag`；同机新增槽位不得共享 checkout 根目录。
- Windows 作业由专用标准账号 `clued-runner` 的自动启动服务运行；不得以日常登录账号、管理员或 SYSTEM 接活。看门狗只报告 Windows 服务状态，不拉起登录模式 runner。
- Linux 作业由无 sudo 权限的 `runner` 服务账号运行；安装管理员与作业账号分离。服务必须使用 GitHub 的 `runsvc.sh` 入口和 `KillMode=control-group`。
- 通用 workflow 按能力路由；诊断、心跳和定点验收按唯一节点路由。默认 `self-hosted/Windows或Linux/X64` 标签与自定义 `clued,pool-general,trust-internal,site-*` 分开核对。
- Windows 必须验证 Python 3.12；仅验证过 Node 24 才声明 `cap-node24`。Linux 必须验证原生 Linux Docker、systemd、`cap-docker-linux,runtime-wsl2`，不能用 Windows Docker Desktop 的 npipe 替代。
- 公司 Linux 槽位使用各自 `runner-company-linux-NN` 路由；新增 home Linux 后也须使用各自唯一标签并改心跳，不能继续用 `site-home` 证明某一个节点。
- v1 清单只有一个 `windows_runner` 和一个 primary `linux_runner`，额外槽位只支持 `additional_linux_runners`。同机第二个 Windows runner、额外 Linux 独立 distro/user、或不同主机模型必须先增加并审核 schema/renderer/监控支持，不能发明未支持的字段。

### 2.2 资源与并发

| 设置 | 家里 compact-v1 | 公司 workstation-v1 |
| --- | ---: | ---: |
| WSL 内存 / CPU / swap | 6 GB / 3 / 2 GB | 28 GB / 16 / 8 GB |
| 暂停条件 | 空闲内存 < 1.5 GiB **或** C盘空闲 < 40 GiB | < 6 GiB **或** < 50 GiB |
| 恢复条件 | 空闲内存 ≥ 2.5 GiB **且** C盘空闲 ≥ 55 GiB | ≥ 10 GiB **且** ≥ 80 GiB |
| 看门狗采样 | 30 秒 | 60 秒 |

WSL 预算属于该 Windows 用户的 WSL2 虚拟机，不是每个 runner 独占的额度；加四个槽位不代表四份内存预算。代码由 Windows 空闲物理内存/磁盘字节换算 GiB；不能拿标称容量百分比替代实际门槛。

规范目标是容量停止服务前先阻断新派单并排空共享负载。**当前 renderer 只有尽力检测，未达到完整排空或不误伤忙作业的保证**：它两次查 `Runner.Worker`，仅 Worker 查询异常时延期；listener 日志缺失/不可读或 journalctl 失败不会阻止暂停。检查结束后 listener 仍能接单，检查与停止之间的竞态可能让刚开始的作业被 control-group 停止。未闭合经审的调度隔离/安全停机实现前，新部署或新增槽位不得启用、扩大这种自动停服务模式；先保持路由隔离，并取得可实施的安全方案。现有部署的风险处置另需明确授权，本次文档不自动改变其模式。共享 Docker 停止还会影响该 distro 的所有容器，不能据这些查询证明其他业务负载已排空。[路由依据](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#routing-precedence-for-self-hosted-runners)

同一 WSL 下的多个 runner 共享 OS、用户及 Docker；独立目录不等于安全隔离。当前 protocol 与 behavior 各自分配动态 loopback MCP 端口，不能再假定所有作业固定使用 8787。behavior 的自托管流程仍因共享本地 Supabase 固定端口使用 [host-port-lock.sh](../../scripts/ci/self-hosted/host-port-lock.sh) 的 `public-mcp-ports` 锁，并在 `if: always()` 中释放；protocol 没有该锁，使用其独立动态端口。其他固定端口消费者须加入准确锁域；动态 MCP 端口不能消除共享数据库/Docker负载争用。进程退出必须按本作业记录的进程身份和归属清理，不能按端口占用或进程名称全机杀进程。

### 2.3 加固、更新与秘密

上线前必须按 [钩子加固要求](../../scripts/runner/README.md)逐项验收：钩子与包装器位于作业账号不可写的目录；Linux 环境来自 root-owned systemd drop-in，Windows 来自服务的管理员受控 Environment；runner 配置、凭据文件、bin/externals 不得由作业修改，`_work/_diag` 保持所需的可写权限。不得为解决 EACCES 对整棵 runner 目录授予 Everyone/Users 完全控制或 chmod 777。

受保护持久 runner 使用 `--disableupdate` 并由管理员排空后升级。清单中的历史 `auto_update_after_registration=true` 与基础脚本默认自更新不能覆盖这一加固要求；该差异见第 12 节。GitHub 要求关闭自动更新的 runner 在新版本发布后 30 天内更新，关键安全更新可立即阻止派单，应关注官方发布通知并安排维护。[官方更新要求](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#runner-software-updates-on-self-hosted-runners)

钩子只读 token 限本仓库 Actions/Contents 读取；注册/移除 token 临时使用。由授权操作者在目标终端隐藏输入，不写入聊天、文档、日志、截图、命令历史或 Git。安装包与脚本备份不包含可传播的凭据。不得让 job 使用 Owner 的 gh、.ssh、.codex 登录。

持久 Windows runner、Docker 组成员及共享 WSL 仍有进程残留/跨作业访问或 root 等效风险；钩子不是完整沙箱。`trust-internal` 标签不是身份认证。不得把不可信 fork 的代码直接路由到此池；更高隔离需求应使用独立、单作业后重置的环境，需另行设计和授权。

### 2.4 现有与未来任务的费用原则、迁移与防回流

依据 Owner 决定 `9eb313f8-9dd0-41dd-9e61-60d869e87f83`：能不花钱就不花钱；本仓库研发、CI、检查、合并、发布及运维链路适用同一长期原则，覆盖现有任务及未来新增、修改和扩容。选择顺序为已合格自有资源、自建替代、经核实不会新增官方费用的免费服务。不得为省实现工作默认购买官方能力。

- **执行机器**：新增作业必须使用已合格自托管资源；构建、测试、发布、准入和合并控制、巡检等不能因任务轻量而自动例外。排队、故障、超时或容量不足时，应排队、明确失败或修复自有环境，不得静默回退 GitHub 托管机或其他官方付费执行。未知动态路由须拒绝。
- **收费能力**：计算、Artifact/Release 产物、缓存、Packages/镜像、LFS、存储、流量与超额等凡可能新增官方费用的依赖，必须先评估自有资源或不增费替代；新引入或扩大使用前，在 PR 列出承接方式、费用依据和验收方法。不能只把算力自托管，却默认继续增加官方存储或其他收费。
- **免费边界**：不增费的仓库、PR、API、Actions 调度等协作能力可以保留。依赖免费额度时必须核对额度、保留期和超额处理，防止自动转收费；只开预算告警不能当作费用上限。固定订阅与按量产品分项核对，不能由 Actions 部分迁移推断整个账号账单已为零。
- **旧路径退出**：现存官方收费路径是必须逐项退出的迁移债务，不是永久豁免。`scripts/ci/validate_runner_budget_policy.py` 按 job 冻结现存托管作业及触发、权限、并发控制；迁出或删除时同步撤掉对应债务条目，防止同名回流。旧 hosted-only allowlist 和历史方案中的托管部署建议不能作为新增、扩费或回退授权；不得靠整体重生成基线掩盖费用增长。确有必要的冻结条目修复须在受保护审查中说明准确变化及理由。配置数量不等于实际运行或账单用量。
- **开发连续性**：先建立可靠替代并验证检查、合并、发布、重跑、撤销和故障恢复，再停用旧路径或考虑零预算。保留准入、精确 Source/Role、秘密隔离、证据与保留期；不可信候选使用自有一次性隔离环境，生产/准入秘密不得进入普通持久测试池。精确源码绑定的消费者须先登记可信来源再切换，不能用候选证明自身已被主线接受。不得通过停任务、删门禁或删证据省钱。
- **确实无法替代的付费项**：先说明无法免费或自建替代的具体理由、预计及上限费用、对开发/发布的影响和退出方案，取得 Owner 对该项的明确事前授权后才使用；授权不得扩张为其他任务或后续版本的默认付费许可。

本节取代旧方案关于必须或优先使用官方收费资源的选型建议；[WorkClaimAdmission](../../development/contracts/execution-admission/WorkClaimAdmission.v0.1.md) 和 [MergeAdmission](../../development/contracts/execution-admission/MergeAdmission.v0.1.md) 中的历史部署描述及精确接受证据保留。要求运行于 Actions 不等于要求运行于 GitHub 的机器；安全、准入及资格边界仍须通过各自的受审后继履行。

实现与规则分开验收：当前自动检查覆盖执行路由和合并检查，其他收费服务仍须逐项核查并补齐约束；它不是所有收费产品的运行前硬开关。规范合入、局部测试或首批迁移均不能代替完整运行验收，也不自动授权关预算、套餐或现有生产服务。

## 3. 操作开始前的记录

每次增加、减少、升级、迁移、阈值变更或故障处理至少记录：

| 项目 | 要求 |
| --- | --- |
| 范围 | Task、操作者、主机、distro、runner 名称/服务/根目录 |
| 版本 | 当前 main、配置 PR、脚本提交及 SHA-256；不复制秘密 |
| 影响 | 目标节点、共享 Docker/WSL/磁盘、其他正在运行的任务 |
| 排空 | 阻止新派单的方法、API labels/busy 与本地 Worker 两次采样 |
| 回退 | 原标签、配置、服务属性、ACL；可恢复的包与非秘密备份 |
| 完成 | 实际 run/job ID、运行节点、正/负钩子结果、验收回执 |

未知机器归属、审批不足、服务账号不符、路径重用、散列不符、排空无法确认或出现 STOP HERE 时停止受影响步骤，保留原输出。不得把失败写为成功。

## 4. 增加 runner

### 4.1 设计并登记

1. 说明增加的能力/排队瓶颈，并确认宿主资源有余量；优先评估同机争用与固定端口锁，不能只看“还能注册几个”。
2. 在配置 PR 中加入 planned/enrolling 条目；为额外 Linux 分配独立 name/root/service/route_label，与 primary 保持同一 distro/user，只有 primary 管理 Docker。
3. 规划心跳的精确路由覆盖；新增节点未在 matrix 出现时，静态清单通过不能证明心跳覆盖完整。
4. 运行 `python scripts/ci/self-hosted/validate_node_profiles.py`；检查 diff 和现有 workflow 标签。validator 的数量是清单条目数，不是实时 online 数量。
5. 取得实际受保护变更批准和实施范围。配置 PR 中标记 planned/enrolling 不会让 GitHub 自动阻止派单。

### 4.2 基础安装与隔离

只能在目标机器、明确的独立根目录和排空/隔离条件下操作。[Windows bootstrap](../../scripts/ci/self-hosted/bootstrap-windows-runner.ps1)与 [Linux bootstrap](../../scripts/ci/self-hosted/bootstrap-linux-runner.sh)是基础安装器，不能直接作为“专用账号 + 加固 + 可上线”的完整自动入口：

- Linux bootstrap 要求调用用户有 sudo，并以该用户安装服务，且不添加 `--disableupdate`。最终作业账号必须无 sudo，不能为了运行 bootstrap 给现有 runner 永久 sudo。
- Windows bootstrap 的 `-RunAsService` 不固定专用标准账号，也不添加 `--disableupdate`；不带该选项会生成登录账号 launcher。当前标准禁止将这个登录模式节点激活。
- 它们会启动监听器。在受控新安装窗口可用于获取校验过的包；尚未加固时不得让节点拥有可匹配生产作业的标签。若无法保证隔离，停止并准备经审核的人工安装方案。

管理员方案必须包含：从当前清单取安装包版本与 OS 散列、下载核验再解包；以最终服务身份完成注册；明确禁用自动更新；安装服务；设置受控钩子、ACL、原生运行时与唯一根目录；最后才恢复调度标签。不得使用 `--replace` 意外覆盖同名活节点。人工步骤以 [GitHub 服务配置](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application)及已审核脚本为准，凭据在交互终端输入。

Linux 服务的必要设置由管理员写入受控 drop-in 并验收，包括 `User=runner`、`KillMode=control-group`、原生 Linux PATH 与五项钩子环境。安装 `svc.sh` 时明确指定账号；不得只凭安装命令成功推定已用 runner 身份。用服务身份验证 `command -v node npm npx python3`、`node --version`、`docker info`，不能让 npm/npx 落到 `/mnt/c/` 或 CMD/UNC 路径。

Windows 用 `Win32_Service.StartName` 核对账号，再验证其实际 PATH。Python 3.12 必须可由服务访问；只有清单声明 `cap-node24` 时，才必须以服务身份验证 Node 24。日常账号的 WindowsApps 别名或私有工具路径不算服务能力。

### 4.3 验收后激活

1. 保持生产路由隔离，先验本地服务、账号、权限、PATH、Docker、`--disableupdate` 和钩子 enforce=true。
2. 使用授权的隔离验收 workflow/标签，记录实际分配节点。已有健康节点的成功不能代替新增节点验收。
3. 真实跑通 checkout、依赖安装、能力负载和 cleanup；Linux Docker 节点还要验证临时资源创建/清理。钩子必须有实际 ALLOW 和拒绝用例，不能仅看到文件存在。
4. 对同机并发，验证目录不交叉、固定端口不冲突、负载下宿主可用及既有节点未被重启。
5. 将条目推进到 validated/active；Linux 条目的有效状态为 active 后再渲染看门狗。每个 primary 或 additional Linux 条目显式声明的 `state` 优先，仅字段缺省时才继承 `host.state`；没有有效 active 条目时 renderer 拒绝渲染。核对 active units 已纳入，最后恢复生产标签并核对路由/心跳。激活是配置、主机部署和调度状态三处一致，不能只改 JSON。
6. 完成配置 PR、机器验收与 KooYomi 回执。不写 online/busy 进清单。

若验收 workflow 涉及新 workflow、手动 dispatch 或重任务，按当时准入合同执行；不临时移除门禁。作业此前 skipped 时要让适用作业实际执行。本基线常规 PR/分支工作流禁止直接重跑；需要重试时用实际修复提交，或按精确范围的 Owner 例外与实际钩子能力处理。

## 5. 看门狗标准与部署

看门狗由清单和 renderer 生成；不直接编辑生成文件来制造另一个配置来源。用最新受审配置在日常 WSL 所属 Windows 账号下生成到临时输出，解析并核对阈值、units、Windows report-only，然后在批准的主机部署窗口安装到 `watchdog_path`。

renderer 按每个 Linux 条目的有效 `state` 选择 unit：显式 `linux_runner.state` 或额外槽位的 `state` 优先，仅未声明该字段时才取 `host.state`。例如主机为 `validated`、primary Linux 条目显式为 `active` 时，该条目可纳入预览；继承 `validated` 的条目仍不纳入。是否拒绝渲染取决于有效 active Linux 条目是否为空，这一选择规则不代替前述资格、激活或部署授权。

```powershell
# 从仓库根目录执行；只生成预览，不安装启动项、不启动进程
$HostId = 'company-primary' # 目标电脑实际 HostId
$preview = Join-Path $env:TEMP "watchdog-$HostId.preview.ps1"
powershell.exe -NoProfile -File .\scripts\ci\self-hosted\render-host-watchdog.ps1 -HostId $HostId -OutputPath $preview
$tokens = $null; $parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($preview, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
```

现有 renderer 的 `-InstallStartup` 只写 Startup 和 HKCU Run，不能保证退出后自动恢复；`-StartNow` 只请求一次启动。新部署必须单独安装受审的调度定义，并验证退出恢复。不得在带现有 runner 的机器上直接执行文档中的安装操作。

调度定义最低要求：WSL 所属日常账号，Interactive/Limited；登录触发 + 每分钟无限重复；IgnoreNew；ExecutionTimeLimit=0；失败后间隔一分钟重启三次；电池供电不停。沿用脚本的 mutex；不能让不同启动入口竞争管理同一主机。不得改成 SYSTEM 来“保证开机”，SYSTEM 看不到同一用户的 WSL 发行版。

已核对部署与主线分开记录：家里 `Clued-CI-Watchdog-home-primary` 的计划任务与 53 秒恢复为既有验收，仍需按后续变更判断适用性。home-linux-01 退役后家里没有 active Linux runner，renderer 拒绝渲染 home-primary，家里看门狗须保持停用。2026-10-21 复读：计划任务为 Disabled，无看门狗进程，Startup 启动文件已改名为 `.task-backup`（HKCU Run 项仍在，所指文件不存在）。公司于 2026-10-08 已部署 `Clued-CI-Watchdog-company-primary`；2026-10-10 现场复读为 Enabled/Running、每日触发带重复恢复、日常 Windows 账号 Interactive/Limited、`pythonw.exe -I -S` 无控制台启动器承载 PowerShell 看门狗、标准输出/错误写日志。此前公司受控退出恢复实测为 36.08 秒；本轮未重跑退出测试、冷启动或登出无人值守测试。主线 renderer 仍只提供旧 Startup/HKCU Run 安装路径；PR #615 的无窗口计划任务安装器尚未合入，不能用“已部署”证明“已进入主线”。

无窗口要求不能只靠 `/min` 或 `PowerShell -WindowStyle Hidden`。监督应使用不分配控制台的启动器，关闭标准输入并落盘 stdout/stderr、启动/退出结果。停维护前核对整条启动器→PowerShell→WSL keepalive 链；计划任务结束或启动器退出不证明所有后代已退出。只按已复读 PID、创建时间、完整启动命令和目标主机确认对应进程，不全机结束 PowerShell、pythonw 或 WSL 进程。

安装/替换时：保存已有任务定义和启动项；核对已有路径与当前账号；启动新任务、确认唯一进程和新日志；再可逆停用重复 Startup/Run 入口。renderer 实际注册的 HKCU 属性名是 `CluedCIWatchdog-<HostId>`，与计划任务 `Clued-CI-Watchdog-<HostId>` 不同，必须按真实值核对，不能仅删除一个看起来相似的名称。

部署验收必须包含：Task=Running、准确进程命令与单实例、日志新增 started、阈值/单位列表正确、Windows 服务账号未变，以及受控结束**看门狗自身**后在 90 秒内自动恢复。应先确认资源稳定且停止看门狗不会影响正在依赖其保护的任务；不杀 runner/Docker/WSL。失败立即恢复原受审入口并排查，不能留下看门狗停止。

维护停机时先暂停计划任务和所有旧入口并结束看门狗，确认无监督进程；仅 Disable-ScheduledTask 不会停止已运行实例。否则手动 stop Linux 服务后，看门狗会立即拉回。

## 6. 日常巡检与故障排查

运行状态不进 Git。值班人员在开工、任何变更后及告警时按顺序检查；每周人工整理未解决问题与 Runner 官方升级通知，不周期性重验 KooYomi 版本或快照来制造新基线。

### 6.1 最小只读检查

```powershell
# gh 权限不足时用 Settings → Actions → Runners；不可借用别人的 token
gh api repos/tdoljyj/cross-memory-system/actions/runners --paginate --jq '.runners[] | {name,status,busy,labels:[.labels[].name]}'
# Windows 服务身份；Linux unit / distro 从清单读取
Get-CimInstance Win32_Service -Filter "Name='actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-01'" |
  Select-Object Name,State,StartMode,StartName
Get-ScheduledTask -TaskName 'Clued-CI-Watchdog-home-primary' -ErrorAction SilentlyContinue
Get-ScheduledTaskInfo -TaskName 'Clued-CI-Watchdog-home-primary' -ErrorAction SilentlyContinue
Get-Content -LiteralPath 'C:\clued-ci\logs\watchdog-home-primary.log' -Tail 20
# 家里 home-linux-01 已退役，不再核对其 unit；下面的 Linux unit 示例针对公司，在 DESK-W-591 上执行
wsl.exe -d CluedCI-Linux -u runner -e systemctl show actions.runner.tdoljyj-cross-memory-system.clued-ci-company-linux-01.service -p ActiveState -p SubState -p User -p MainPID -p KillMode
```

上例除最后一行外针对家里，最后一行针对公司；两台主机的服务名、计划任务、日志路径和 distro 不能互换。不输出凭据文件、服务完整 Environment、私有 SSH 或个人配置。Task=Running 只能证明调度进程存活，还要核对实际看门狗进程、采样/命令是否卡住。watchdog 日志只在事件变化时写，不是连续心跳；旧日志末行不能证明当前运行。

### 6.2 按原因处理

| 现象 | 先查 | 允许的下一步 |
| --- | --- | --- |
| Linux Offline | 看门狗进程/任务、WSL、systemd、Capacity suspend/resume | 容量暂停时等资源达到恢复条件；不要强启 runner 抵消保护 |
| Windows Offline | 服务身份与状态、listener 日志、网络 | 在排空与授权后处理服务；不要用日常账号 run.cmd 顶替 |
| 在线但长时间排队 | runs-on、实际 labels、busy、端口锁、前序作业 | 区分容量占用与未解释等待；没有观测到作业不能推定空闲 |
| UNC/CMD/npipe/npm 异常 | 服务身份的 Node/npm/npx PATH | 修原生 Linux PATH；不能仅在交互终端通过就结案 |
| checkout/cleanup EACCES | 根目录身份、父目录 traverse、工作区 owner/默认 ACL | 精确修复所需权限；不放宽钩子、凭据或 bin 权限 |
| hook 拒绝 | 事件、attempt、head、该事件的准入 run、授权 | 记录拒绝原因并修正流程；不关闭 enforce 或改写重跑次数 |
| watch 无进程 | 调度、重复入口、账号、执行结果 | 核对脚本/账号后恢复监督，再实测退出恢复 |
| Docker 冲突/孤儿进程 | 同机锁、cgroup、容器归属 | 排空后处理目标资源，不能全机 prune/杀所有进程 |

[健康监控](../../scripts/ci/self-hosted/ci_health.py)每小时分析；[路由心跳](../../.github/workflows/clued-ci-runner-heartbeat.yml)每 15 分钟探测。基线 matrix 只有公司 Linux01/02 与两 Windows（company-win-01、home-win-01）四个目标，**不包含公司 Linux03/04**；已退役的家里 Linux01 既不探测，也不在健康监控的期望集内。不得把它称为六个 active 节点的完整覆盖；03/04 先用直接 API 与指定实际 job 证据核对，监控覆盖补齐另走受审变更。

告警运输 PR 是 do-not-merge 的事件载体，不合入 main。恢复后以机器与实际作业证据结案，再登记 KooYomi；不把 API 状态延迟、采样缺口或旧资格说明当结论。

### 6.3 CI 临时文件与缓存

本节公共入口与八流程覆盖实现在 [PR #693](https://github.com/tdoljyj/cross-memory-system/pull/693)，源提交 `48205446348a65e578094aef999e59cf853eeac0`。全部适用正式 CI、精确受保护准入和合并位通过后，于 2026-10-10 11:06:57 UTC 合入 `cf5be21bbb93db534a383410e9b4e9c7617c0f91`。它与先前已合入的 PR #691 共同构成下述应用临时目录实现；这不代替每个后续版本的实际 job 验收。

本规范的临时目录治理范围为全仓工作流、控制入口、发布/资格验证及本地 composite；本轮核对基数为 43 个工作流、86 个静态 job，数量不作为未来白名单。全仓 [覆盖清单](../../.github/actions/ci-temporary-storage/coverage.json) 和 [检查器](../../.github/actions/ci-temporary-storage/check-workflows.mjs) 自动发现新文件、job 和 action；未知、过期分类、晚配置、失配条件、共享临时根、步骤覆盖和未复核的产物/缓存路径一律报错。原八应用覆盖保留为回归子集。只比较 runner 名称的无写入心跳有精确源码指纹，代码变化使这项只读分类失效。

检出仓库的 job 在首个运行命令前使用 `ci-temporary-storage` 公共入口，把 `TMPDIR/TMP/TEMP` 指向该 runner 的 `RUNNER_TEMP`，并将 Python 字节码与 Wrangler 调试日志分别放到作业内 `clued-pycache`、`clued-wrangler-logs`。Node 不在 PATH 时使用标准库 Python 启动器；Windows 使用既有 PowerShell，无需为简单 Python 校验增装 Node 或 PowerShell 7。公共入口验证绝对单行路径、专用目录、符号链接/Windows junction、POSIX 账号归属和可写性，失败不回退共享 `/tmp`。仅依赖 Node 的可信控制 job 在现有 Node 准备后调用；官方 checkout/runtime/cache/artifact 动作按平台工作区、工具缓存及 job 临时传输生命周期管理，不当成无归属解压数据。

原本不检出仓库的生产开关和权限观察保持该边界：每个运行步骤使用精确 `${{ runner.temp }}` 环境绑定，不为临时治理引入候选仓库代码、缓存或生产凭据。可信多目录检出必须从原可信 checkout 加载公共入口，不能改为候选目录。发布标签的检出前凭据检查采用步骤绑定，检出后才加载入口。可重用工作流、job container 或未知第三方动作需要明确源和生命周期复核，不能默认计为已覆盖。生产流程源码检查不代替生产模式的实际资格，也不授予 dispatch/deploy/migrate 权限。

固定内容的 `admission-gate` 要先按现行准入规则把精确新模板散列登记到可信主线，再更新各工作流；不得同时推两阶段或移除散列检查。候选清单绑定了工作流字节时，临时入口变更也必须准确刷新该源码项的散列与字节数，并运行原完整性检查；这不继承历史资格或产生模型、发布等业务接受权限。

当前已合入的 PR #691：应用 package 的 Node 测试命令与内容选择器通过 `scripts/run-tests.mjs` 运行，每次 suite 拥有独立 `clued-test-run-*` 子目录，测试和原生依赖子进程继承它；成功、失败、正常强制退出、启动失败和可处理的取消均在外层回收。取消只作用于该调用创建的进程组。quality job 的依赖安装前已经配置 runner 临时目录。其它 CI 直接测试、安装入口应以工作流覆盖检查及实际 job 的入口日志为验收证据，不能由某一套 unit tests 通过推定全入口覆盖。

Runner 的 job 临时目录在 job 开始/结束时清理；这为安装中断、进程硬杀和机器故障留下的文件提供下一次作业的回收边界。硬杀本身不能执行 JavaScript `finally`，不能承诺取消瞬间零残留。作业账号无法删除的文件不保证由 runner 回收；出现清理失败必须留诊断并处理准确归属/权限，不能扩大 runner 权限或换成共享 `/tmp`。该目录不是安全沙箱，同机 runner 仍共享 WSL/用户/Docker。

缓存与临时文件分别管理：npm/pip、Node/Python 工具缓存、Trivy 缓存、Docker 镜像/卷、数据库及已资格化构建/发布产物保留原位置和生命周期，不进入临时扫删。promptfoo 配置属于 job；Wrangler 临时调试日志放入 job 目录，保留默认敏感信息清理，不自动上传原始日志；已有受审、经脱敏的日志/证据路径与上传保持。临时报告先按原流程上传/归档，再由 job 生命周期回收。临时根不是证据唯一存放位置。[Wrangler 日志设置](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)

退出官方收费产物存储或缓存时，先建立自建或经核实不增费的持久替代，验证上传、下载、内容散列、权限、可用性、保留期及恢复；必要的 Source/证据引用随后准确切换。替代验收前不能删除原证据、缩短保留期，或把唯一副本留在临时目录以换取账单下降。

固定 ICU 下载包与命名盘点源/输出只在该 job 根内暂存，安装退出删除自己的包、命名证据按原字段和保留期上传。生产备份的明文 dump/校验副本位于私有 job 子目录：成功、失败和可处理取消都清掉明文，只有加密备份与清单沿原路径保留；硬杀仍依赖 runner/平台回收，不能承诺物理安全擦除。稳定的 `/tmp/clued-ci-NAME.lock` 是现有跨 runner `flock` 的小型协调 inode，必须保留，不能移动到各 job 根或在释放时删除，否则破坏互斥；holder/PID 记录仍属于各 job。

不得新增 `/tmp/*`、全部 ONNX/构建目录或全机 Docker prune 的定时清扫来代替归属治理。历史残留删除是独立操作：列明准确前缀/目录、保留条件和截止时间，确认没有在运行或已分配的作业使用目标，核对真实路径、目录身份、最新子项时间及文件系统边界；只删除明确批准的清单。不要根据目录名、字节相同或“看起来旧”推定删除授权。

### 6.4 C 盘与 WSL 虚拟磁盘空间恢复

C 盘可用空间、VHDX 在宿主的占用和 Linux `df`/`du` 的使用量是三个观测量。删除 Linux 文件通常不会立即把同等空间归还 C 盘；记录删除、trim、离线压缩及恢复的实际结果，不以 VHDX 文件长度减 Linux 使用量许诺可回收字节。

2026-10-10 公司容量暂停的精确诊断与恢复见 Clued Task `f7d19375-98f5-46c5-aa94-99a4eb5c3388`：C 盘约 49.3 GiB 触发既有 50 GiB 门槛；`/tmp` 约 104 GiB。Owner 批准后按身份/年龄/无作业的清单清理 19,115 个旧测试目录约 85.79 GiB，Linux 使用量约 148→63 GiB；对准确 CI 磁盘完成 trim、离线压缩，VHDX 197.13→79.39 GiB、C 盘达到 170.14 GiB，四个公司 Linux runner 恢复并执行实际作业。这是一次有范围的历史事件，不是当前容量表或其它主机维护授权。

后续离线回收须先取得准确 distro/VHDX、停机与数据保留范围的授权，并按第 7 节排空受影响作业。暂停监督的调度入口且结束经身份复读的监督链，保存恢复所需的原任务状态；共享 WSL/Docker 的所有负载都在范围内，不能只看一个 runner 的 busy=false。先处理经批准的废弃文件，按需 `sync`/`fstrim`；trim 返回的是全部可丢弃区域，不等于本次新增释放量。

只停止指定发行版，等待宿主确认目标磁盘未挂载。若需要关闭 WSL 虚拟机，必须先复读同一用户全部发行版和其它负载，证明没有未授权受影响的运行项；不得直接全机 `wsl --shutdown`。管理员只对经复读的准确独立动态磁盘操作，拒绝未知差分父盘、挂载状态不明或磁盘身份变化。使用系统支持的只读挂载/压缩/卸载入口；不对仍挂载的盘强制压缩、不用填满 C 盘的零文件方案，不自动启用带额外风险的稀疏磁盘选项。

维护始终有 `finally` 恢复：释放自己的只读挂载、恢复原监督入口及其原配置。失败不能留下监督被禁用或磁盘仍只读占用。完成后验证磁盘身份/大小、C 盘可用量、Linux 文件系统/必要数据、原服务账号/units、监督单实例以及实际 job；容量不足时按既有门槛保持暂停，不能强启或降低 50/80 GiB 规则。权限不足应区分 Windows 管理员权限与网络/WSL故障，不借他人凭据。

## 7. 排空、维护与减少 runner

### 7.1 排空不是修改 JSON 状态

`draining/maintenance/retired` 是清单状态，不是 GitHub 的暂停按钮。当前 renderer 不执行这些状态对应的停止操作；primary 与 extra 都只在自身 state（未写时取主机 state）为 active 时纳入，没有 active Linux runner 的主机拒绝渲染。已部署的看门狗不会因改清单而停止监督，须按下列步骤停监督。也不能一停止服务就保证正在运行的 job 安全退出，KillMode=control-group 会终止后代。

1. 在授权变更中登记 draining，保存原标签与服务/监督状态。
2. 用 GitHub 标签/路由变更阻断新的可匹配派单，并确认标签已生效。移除唯一 route_label 不会阻止通用能力作业；必须撤除本仓库每种可匹配 runs-on 至少一个必要自定义标签。心跳暂停/覆盖变化一并登记。
3. 若有仅凭默认 self-hosted/OS/X64 或 runner group 就能派单的 workflow，撤自定义标签不足。必须采用受审的调度隔离/工作流维护方案；否则不具备安全排空条件，不能继续停止或移除。
4. 暂停目标主机的全部看门狗入口并停止监督实例；共享主机其余节点会暂时失去容量保护，须有人工监护与确定的短维护窗口。
5. 标签/调度隔离确认生效后，至少等满 GitHub 当前规定的领取窗口（编写基线为 60 秒），处理隔离前已分配但尚未开始的作业；这个保守等待不是原子排空的证明。[官方领取窗口](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#routing-precedence-for-self-hosted-runners) 等所有已分配/进行中的 job 结束后，核对 API busy=false、本地目标 Runner.Worker 不存在、listener 最后事件 completed/listening；间隔至少 5 秒再完整采样一次，并在停服务前最后复读。出现新分配、新 Worker、日志缺失或无法核对即不继续停止/移除；不能只看一个 busy=false。
6. 只有阻断新派单与本地空闲同时成立才停止目标服务，复查没有目标 Worker/cgroup 残留。采样到新任务、日志不明或 API 无法核对时停止实施并排查。

### 7.2 暂时维护

排空后停目标服务，暂时保留 GitHub 注册、原标签和根目录。持久 runner 超过 14 天未连接时 GitHub 会自动移除注册，长期维护不能保证原注册仍存在；恢复前先查注册，已移除则按新有效凭据重新注册、隔离验收。[长期离线规则](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/remove-runners) 资源恢复或修复结束后，先在隔离验收路由完成账号、钩子、能力检查；再恢复生产标签、监督入口与 active 状态。每一步记录实际结果。

### 7.3 永久减少 / 退役

1. 完成 7.1，核对准确 runner/根目录，不影响共享 distro 的其他槽位。
2. 对 Linux runner（额外槽位或 primary），将配置推进到 retired，重新生成并部署不含该 unit 的看门狗；主机已没有 active Linux runner 时 renderer 拒绝渲染，改为停用该主机的看门狗及其全部启动入口。核对 actual units，避免删除后被自动恢复。
3. 删除 primary 前必须先设计同机另一个活节点升为 primary 的配置迁移，保持其原 name/root/service，不为“成为01”改身份；旧节点保留为 retired 记录。没有替代节点时，现有 renderer 的 Windows+Linux 配对模型不支持继续照旧监督，应明确退役整机/停用监督或先实现新的受审模型。不能删除 primary 字段后假定 renderer 仍可运行。
4. 停止并卸载目标服务，再按 GitHub Settings → Actions → Runners → 精确节点 → Remove 给出的当前 OS 指令和临时 removal token 取消注册；不存在机器时，Force remove 仅在确认目标离线且有明确授权时使用。[官方移除说明](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/remove-runners)
5. 验证 GitHub 注册消失、服务消失、没有目标进程、监督不会拉回，剩余节点真实作业正常；移除或更新退役节点的心跳条目，保存历史证据。
6. 注册移除和磁盘数据删除分开。首先保留受限的诊断/非秘密恢复材料；备份中的旧凭据不得传播或重新启用。任何工作区/根目录清理要有明确范围和保留要求，解析绝对路径并确认没有指向其他节点；不把重复字节视为删除授权，不用全机递归清理。
7. 完成 PR 与 KooYomi 退役/验收登记。退役后清单 validator 可能仍计入保留的历史条目；不得拿静态数量证明剩余在线节点数。

不能只删 GitHub 注册留下本地监听器，也不能只删目录留下活注册。恢复退役节点应以原身份、当前批准包及新有效凭据重新验收，不从旧 .credentials 克隆注册。

## 8. 升级、账号迁移与阈值调整

- **升级**：排空并暂停监督 → 保存非秘密配置与可回退包 → 核验当前受审包及散列 → 管理员更换 → 恢复同等 ACL/immutable 标志、drop-in/服务 Environment、PATH 和 enforce → 隔离路由真实作业与 cleanup 验收 → 恢复生产调度。禁用自动更新后升级由人负责，不能无限冻结旧版本。更改共享 runner_package.version 时，清单与 Windows/Linux 两套 bootstrap 的版本 pin 都必须同步受审；只改某个 OS 的散列时更新清单该散列及对应 bootstrap 散列。
- **账号迁移**：账号、服务身份、工作区读写、Docker 权限、Windows 全机运行时与钩子只读访问一并验证；只改变 StartName 不是完整迁移。维护后不得恢复个人账号 launcher。
- **资源调整**：先说明范围与容量依据，经批准改 capacity_profile。用 [apply-wsl-capacity-profile.ps1](../../scripts/ci/self-hosted/apply-wsl-capacity-profile.ps1)保留无关设置并备份 .wslconfig；默认不带 -RestartWsl。等同一用户的所有受影响 WSL 作业/其他负载排空、监督停止后，才在授权窗口应用重启并恢复监督。[WSL 配置说明](https://learn.microsoft.com/windows/wsl/wsl-config)
- **同机增减**：数量变化通常不自动扩大 WSL 预算；修改并行度、端口锁或 workflow timeout 也属于受审变更，不能用“加一个槽位”绕过。
- **安全事故**：先隔离调度并保存证据，检查撤销/轮换所需范围；不要因怀疑泄露先传播凭据或抹掉工作区。确认失陷时不把原机器原地恢复等同干净资格。

冷启动、跨主机故障切换及“新增节点与旧节点一起运行”的验收各自独立。基线没有公司冷启动通过证据；历史 home 资格不自动覆盖后续账号/钩子/容量/节点变更。

## 9. 回退与完成标准

回退必须在同一隔离/排空边界内进行。恢复经核对的旧配置、标签、服务与非秘密包；再次验权限、钩子、PATH 和实际作业。已撤销 token 或终止授权不随配置回退复活。新版本不满足当前 GitHub 安全要求时不得作为可用回退，应继续隔离并升级修复。

任一操作完成必须同时满足：

- 配置、实际机器和 GitHub 注册/路由一致；差异明确记录。
- 服务身份、权限、钩子与能力验收通过；真实 job 的 run/job/runner 名称可追溯。
- 监督单实例、目标阈值/units 正确；维护遗留入口不会重新拉起已停用节点。
- 旧节点未被越权重启或破坏；新增/减少后的共享资源与路由覆盖有证据。
- PR、实际授权、Task、Event/Receipt 与必要回退材料已固化到可持续读取的位置；临时文件和旧电脑不作为后续唯一证据。
- 未完成项写为未完成，保留责任范围与停止条件；不凭局部检查关闭整个部署任务。

## 10. 独立审核与后续维护

规范初版和实质流程变更至少两名独立审核者并行只读检查同一精确内容散列：一名查技术/命令/清单一致性，一名查排空/权限/恢复/退役风险；存放位置可由第三名独立检查。作者集中修订，审核者对最终散列复核；任何未闭合的阻塞或高风险操作问题不得标“审核通过”。

审核结论、最终提交和摘要登记到 KooYomi/PR。历史长审核报告遵守资料存放规则，不混入工程正文。审核通过仅适用于被审核文本；之后变更相关文字必须重新检查影响，不能沿用旧 PASS。

每次 runner/schema/bootstrap/watchdog/心跳或安全策略实质变化，由该变更执行者同步本 Runbook及文档入口；规定与代码偏离时登记差异并限制对应操作。版本变更通过普通 PR，不另设平行配置清单。

## 11. 存放决定

正文放本仓库 `docs/maintenance/runner-configuration-and-operations.md`，入口为 [维护文档索引](README.md)。原因：它直接绑定配置、安装器、准入钩子与可复现的工程操作，属于 AGENTS 明确允许入 Git 的 Runbook。

资料中心可以保存工程资料索引或指向**已合并具体提交**的引用、历史验收/审核长报告，但不维护第二份可编辑的当前操作正文。此次仅落仓库，不写资料中心副本。若后续专门建立索引，应通过合格存储入口、按 Owner 授权登记引用，不把拷贝文件名或目录位置当 Authority。

## 12. 基线实现差异与实施限制

这些是编写时核对到的实现差异，不是本次已修复或已关闭的代码问题：

| 差异 | 实施时的限制 |
| --- | --- |
| 主线清单七个条目（六个 active，home-linux-01 已退役）；历史 P7/P8/P14 资格只覆盖当时受查对象 | 当前数量由清单/API读取；旧四节点资格不能推广为六个 active 节点或本轮主机重验 |
| 清单 auto_update_after_registration=true；bootstrap 没有 --disableupdate/完整标准账号加固入口 | 不以基础安装成功直接上线；使用受审管理员安装/加固方案并验收，代码统一另走 PR |
| 心跳 matrix 仅覆盖四节点，未列公司 Linux03/04（已退役的 home-linux-01 已移出） | 保留 API/实际定点 job 核对；新增/退役流程必须安排 matrix 对应变更，不能称完整覆盖 |
| 主线 renderer 仍只安装 Startup/HKCU Run；无窗口计划任务安装器在未合入 PR #615 | 公司现场已安装无窗口 Limited 计划任务，家里有既有计划任务验收；部署事实不冒充主线工具能力，安装器更新另按原 Task/PR 受审 |
| 公司已部署任务为每日触发并带重复恢复；规范目标是登录触发 | 既有受控退出恢复通过不等于已符合全部调度定义；公司登录/冷启动/登出无人值守仍未实测，不据此新增或变更任务 |
| 清单 draining/maintenance/retired 不自动阻断 GitHub 或停止 primary 服务 | 必须按第 7 节隔离派单、停监督并排空，不能只改状态 |
| 自动容量检查缺少阻断派单/停止的原子边界，listener 日志异常也不阻止暂停 | 仅是尽力检测；未闭合安全停机实现前限制新启用/扩大自动停服务模式，不能作排空或不误伤保证 |
| capacitySuspended 只存在进程内，重启看门狗不保留此前暂停阶段 | 恢复测试在资源稳定窗口进行；若需跨进程恢复状态保证，先独立修复并验收，不宣称已有该能力 |
| 同机仅支持一个 Windows 与同 distro/user 的额外 Linux；公司冷启动缺实证 | 超出模型需先实现受审支持；资格不得由旧历史说明自动继承 |

以上差异需要后续工程整改时，应关联现有对应 Task 或另行登记明确的新执行范围；本文件不授权变更运行机器或扩大原任务。
