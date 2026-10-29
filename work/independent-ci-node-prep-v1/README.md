# 新节点准备工具（node-prep v1）

Task `25ac6c5f`；Decision `76c5ac24`（开发授权）；设计《常驻执行器主备部署·设计说明 v0.4》§10 P2；常驻 DESIGN.md §30.8。

让一台全新的 Windows + WSL 机器满足常驻安装（`work/independent-ci-resident-v1/windows/install-resident.ps1`、`linux/install-resident-linux.sh`）和 Source v2 `migrate-acl.ps1` 的前提。首个目标是 DESK-W-591。

**合入本目录不会改动任何机器。** 在某台机器上执行 `-Apply`、Owner 输入 runner 注册令牌、选定 WSL 发行版，都需要 Owner 在现场另行决定（Decision `76c5ac24`、`3efb35c7`）。

## 文件

| 文件 | 作用 |
|---|---|
| `windows/prepare-node.ps1` | Windows 侧：clued-control 账户、`C:\ProgramData\CluedControl`（controller 安装 + 独立的 controller runner）、`C:\ProgramData\CluedIndependentCI` 基础 |
| `linux/prepare-node-linux.sh` | Linux 侧：`/var/lib/clued-independent-ci` 等基础目录（root 0700） |
| `config/node-prep.desk-w-591.json` | DESK-W-591 的节点准备档案 |
| `config/node-prep.turing.json` | TURING 的节点准备档案（与 `independent-ci-resident-v1/config/node-profile.turing.json` 同值，作夹具与对照） |
| `test/fixtures/facts.*.json` | 两台机器的主机事实夹具（TURING 为 2026-10-29 只读实测；DESK-W-591 取自 b7d84de2 v3 现场回传） |
| `windows/test-prepare-node.ps1` | Windows 离线测试 |
| `linux/test-prepare-node-linux.sh` | Linux 离线测试（普通用户、`/tmp` 夹具根） |
| `DESK-W-591_节点准备_前置操作说明.md` | 给现场的操作说明（主备安装操作说明第 1 步之前的前置步骤） |

## 节点准备档案 `clued.independent-ci.node-prep-profile/1`

所有主机参数都从这里读，脚本里没有任何机器的值。字段：`nodeName`、`hostname`、`ownerSid`、`ownerProfileDirectory`、`controllerSid`、`runnerService`、`wslDistribution`（以上与常驻的 `node-profile/1` 同名同规则），加 `runnerPackage`（`version`、`fileName`、`sha256`：官方 `actions-runner-win-x64-<version>.zip` 的钉值）。

- `controllerSid` 可以为 `null`：账户还不存在时（新节点）由 `-Apply` 创建，SID 在创建后绑定进每条 ACL；回执给出 SID。
- `wslDistribution` 可以为 `null`：Windows 侧不依赖它；Linux 侧要等 Owner 选定发行版。
- 两者都有值时，计划和回执给出常驻用的 `node-profile/1`（`derivedNodeProfile`）及其摘要（与 `src/node-profile.mjs#nodeProfileSha256` 相同；测试对拍）。`mutationMutex` 由主机名和 controller RID 推出。
- runner 名取自 `runnerService` 的后缀；DESK-W-591 用 `clued-ci-company-win-02`（与 TURING 的 home-win-01 通用 / home-win-02 controller 同一编号习惯；现有 `company-win-01` 是通用 runner）。

## Windows 侧做什么（`prepare-node.ps1`）

默认只读干跑：读主机、打印完整计划和计划的 sha256，不写任何东西。`-Apply -ExpectedPlanSha256 <hash>` 只执行那份计划；风格同 `install-resident.ps1`。

计划绑定：脚本自身字节的 sha256、档案字节的 sha256、runner 包的 sha256 与条目数、每个目标的现状、现有每个 runner 服务的名字/二进制/账户/启动方式。其中任何一项在干跑和执行之间变了，执行以 `PLAN_CHANGED_SINCE_REVIEW` 拒绝。

运行位置（独立审核 r1 MAJOR-1）：计划哈希是脚本自己算的，证明不了脚本是哪一份，所以凡是**提权**运行（`-Apply`，或提权干跑），脚本先检查自己所在的位置：脚本文件以及往上每一级目录，属主都必须是管理方，且没有非管理方的写、追加、删除、替换或改权限的权利；脚本所在目录之上只看替换类权利，因为 `C:\` 和 `C:\ProgramData` 本来允许用户新建同级目录。不满足就拒绝（`TOOL_LOCATION_NOT_ADMIN_ONLY:<原因>`）。现场说明 0.7 先用一段不从文件读取的提权命令建 `C:\ProgramData\CluedNodePrep\run-<时间>`（只有 SYSTEM、Administrators），把文件写进去（属主 Administrators），对照 KooYomi 记录的 sha256 核对后，再从那里运行。脚本开头把 `PSModulePath` 固定为 Windows 目录（同 `install-resident.ps1`），运行时不编译任何代码（不用 `Add-Type -TypeDefinition`），runner 包和档案只读一次进内存。

步骤（按顺序；已存在且完全一致的跳过）：

1. `account`：建本地账户 `clued-control`。描述 `Dedicated trusted-main CI control`，不进任何组（连 Users 也不进），密码永不过期、用户不可改密码；密码在内存里随机生成，只交给建账户和建服务两处，不显示、不保存。（与 TURING 实测一致。）
2. 目录（Owner = Administrators，受保护 DACL；取值见下表，照 TURING 实测）：`CluedControl`、`trusted`、`temp`、`runner`、`runner\_diag`、`runner\_work`。
3. `runner-extract`：把钉住的官方 runner 包解到 `CluedControl\runner`（逐个 CreateNew，逐个核哈希；文件继承 runner 目录：controller 只读）。
4. `runner-package-copy`：同一批字节另存 `CluedControl\runner-package.zip`（与 TURING 相同）。
5. `runner-register`：Owner 在提权窗口里输入 GitHub 注册令牌（`Read-Host -AsSecureString`，所有检查通过之后、第一次写入之前才问；只在计划含此步时问）。以 `Runner.Listener.exe configure --unattended --url https://github.com/tdoljyj/cross-memory-system --name <runner 名> --labels clued-controller-windows-v1 --work _work --disableupdate` 注册；**不带 `--runasservice`**，所以 runner 不会被启动、不会接活。标签 = 默认的 self-hosted、Windows、X64 加 `clued-controller-windows-v1`，即 `scripts/ci/clued-control-workflow-source.mjs` 的 `MAIN_SECRET_CONTROLLER_ROUTE`（测试逐字核对）。**令牌不上命令行**（审核 r1 MAJOR-3）：只放进 configure 子进程的环境变量 `ACTIONS_RUNNER_INPUT_TOKEN`（runner 的 CommandSettings 读这个前缀；钉住的 2.337.0 `Runner.Listener.dll` 里有这串字）。若某个版本不读它，unattended 配置会因缺令牌干净失败。注册后检查 `runner\_diag` 的日志里没有令牌（否则 `RUNNER_LOG_CONTAINS_TOKEN`）；屏幕输出里令牌被替换成 `<token>`。
6. `runner-service-file`：`runner\.service`，内容就是服务名（TURING 的 63 字节文件即此）。
7. `service`：用 `New-Service -Credential` 建 `<runnerService>`：`"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"`、`.\clued-control`、手动启动、显示名 `Clued dedicated trusted-main controller`、不启动。密码经 API 交给 SCM，不上命令行。（TURING 的服务也是手工建的：无失败动作、无描述。）令牌和密码在进程结束前一直是内存里的托管字符串，脚本不声称清除了它们。
8. 目录：`CluedIndependentCI`、`formal-spool`、`formal-spool\outgoing`、`formal-spool\incoming`、`state`、`state\temp`。

| 目录 | DACL（都另有 SYSTEM、Administrators 完全控制） |
|---|---|
| `CluedControl`、`trusted`、`runner` | controller 读+执行（OICI） |
| `CluedControl\temp`、`runner\_diag`、`runner\_work`、`state\temp` | controller 修改（OICI） |
| `CluedIndependentCI`、`formal-spool` | Owner `0x120080` 仅本目录；controller 读+执行（OICI） |
| `formal-spool\outgoing` | Owner 读（OICI）；controller 修改（OICI） |
| `formal-spool\incoming` | Owner 修改（OICI）；controller 读（OICI） |
| `state` | controller 本目录读、子项修改（OICIIO） |

不建的：`state\v2*`、`state\relay*`（`migrate-acl.ps1` 建）、`CluedIndependentCI\secrets` 和两个秘密文件、`resident\`（`install-resident.ps1` 建）；常驻服务 SID 的 ACE（`install-resident.ps1` 的 parent-acl 步和 `migrate-acl.ps1` 追加）。v1 遗留的 `inbox`、`source`、`verify-spool` 新节点不需要。TURING `trusted\` 里还有 v1 一次性安装放的 controller 运行文件（`controller-job-started.{ps1,mjs}`、`controller-policy.json`、`upstream\clued-runner-job-started.mjs`、`controller-readonly-app.pem`、两个 probe exe）。常驻 v2（resident-v1、`src/resident-v2`、`protected-job-bridge-v4`、`runtime`）不引用它们，所以不属于 v2 的前提，这里不建。原 v1 安装器（`stagec\first-free-install\controller\install-controller.ps1`、`bundle-v1`）在 TURING 的 C:、D:、Drive（G:）和仓库全历史里都已找不到，`host-baseline.ps1` 只核对 TURING 已装状态，本身不安装。若 P3 发现某个 v2 组件需要它们，由协调方在 C8 运维手册里另定。

已存在的目录：只有授予的权限与计划完全相同才接受（继承来的与显式的视为相同；只额外接受上面那两个工具给常驻服务 SID 追加的那几条），属主必须是管理方；`CluedIndependentCI`、`formal-spool`、`outgoing`、`incoming` 还必须是受保护 DACL（`migrate-acl.ps1` 和 parent-acl 步的要求）。其他一律拒绝，不改。所以一台已装好的节点（TURING 的实测 ACL）干跑得到 `NOTHING_TO_DO`。新建的目录读回时，要求 ACE 完全一致、受保护、属主是 Administrators；普通用户抢先在 `C:\ProgramData` 下建的同名目录因此不会被接受。runner 目录里每一项也必须属主是管理方，否则 `RUNNER_ROOT_UNEXPECTED:owner:<名>`。

只新建、不覆盖、不删除：文件一律 `CreateNew`；目录创建前再查一次不存在。唯一改动已有对象的情况：`clued-control` 已存在、从未登录过、而它的 runner 服务还没建（上一次执行在建账户之后中断，比如令牌输错），计划会写明 `account-password-reset`，因为建服务需要密码而密码从不保存。账户登录过就拒绝（`CONTROLLER_ACCOUNT_IN_USE_WITHOUT_SERVICE`）。

不碰现有 runner：计划列出所有现有 `actions.runner.*` 服务（名字、二进制、账户、启动方式），执行后逐一核对没变（`otherServicesUnchanged`）；任何其他 runner 的二进制在 `CluedControl` 下就拒绝。脚本里没有删除、改 ACL、启动服务、改组成员的调用（测试做静态检查）。

WSL：干跑（非提权）用 `wsl --list --quiet` 和 `wsl --list --running --quiet` 列出发行版。这两条只输出名字，不受界面语言影响。对**正在运行**的发行版，读它是否装有 GitHub runner：已加载或只安装的 `actions.runner.*` 单元、`/home /opt /srv /root /usr/local /var/lib` 下 4 层内的 `.runner` 文件、Runner.Listener 进程；同时读 docker socket、`/run/WSL`、`[interop]` 设置。**不启动**已停止的发行版。这些观察不进计划哈希，而且是发行版自己报的（`selfReported`），可能被里面的代码伪造，所以现场说明 0.4 还要和 GitHub 的 runner 列表交叉核对，并由 Owner 确认。提权运行从不进入任何发行版：跑 PR 代码的发行版若开着 interop，能借提权令牌起 Windows 进程。

### 执行后

回执（`node-prep-receipt/1`）给出每步结果、controller SID、（档案有发行版时）常驻用的 node profile 及摘要，以及后置核对：

- 账户；
- 六个路径，即现场第 1 步检查的 `CluedControl`、`trusted`、`runner\bin\RunnerService.exe`、`CluedIndependentCI`、`formal-spool`、`state`；
- 我们的服务：Stopped、Manual、原二进制、clued-control、PID 0；
- 其他 runner 服务未变；
- `replanNothingToDo`：按执行后的主机重新算一遍计划，结果必须是 `NOTHING_TO_DO`。这一项复核每个目录的属主与 DACL、账户的组与标志、runner 目录与包是否一致（含属主）、包副本、`.service` 和服务配置。

任何一项不满足，状态是 `NODE_PREP_POSTCONDITION_FAILED`。

执行到一半停下（审核 r1 MAJOR-4）：状态 `APPLY_PARTIAL`，回执给出 `completedSteps`、`failedStep` 和已建账户的 `controllerSid`。这时主机上已有只有管理员能读的目录，重算计划要用**提权干跑**（现场说明 0.7）。在任何写入之前的拒绝（令牌格式、计划变了、位置不对等）状态是 `REFUSED`，什么都没写。

## Linux 侧做什么（`prepare-node-linux.sh`）

在 Owner 选定的发行版里以 root 运行（`wsl -d <发行版> -u root -- bash /root/clued-nodeprep/prepare-node-linux.sh ...`）。`--plan` 只读；`--apply <hash>` 只执行那份计划。

- 以 root 运行时只认只有 root 能改的副本（审核 r1 MAJOR-2）：脚本的真实路径不在 `/mnt` 下，脚本文件和往上每一级都属 root、组和其他人不可写、不是链接；否则 `SCRIPT_LOCATION_REFUSED`。现场说明 0.8 先 `install -D -o root -g root -m 0700` 复制到 `/root/clued-nodeprep/`，对照 KooYomi 核对 sha256，再运行。
- `/var/lib`、`/opt`、`/etc` 本身必须是属 root 的真实目录，不是链接（`PARENT_DIRECTORY_REFUSED`）。

- 只建 `/var/lib/clued-independent-ci`、其下 `formal-spool`、`runs`、`workspaces`，`/var/lib/clued-independent-ci-trivy-cache`，`/opt/clued-independent-ci`，`/etc/clued-independent-ci`，全部 root:root 0700（TURING 实测相同）。已存在的必须正好是这样，否则拒绝；`mkdir` 不带 `-p`（父目录必须已在）。
- 计划绑定脚本字节、发行版名、每个目录的现状。`WSL_DISTRO_NAME` 必须等于 `--distribution`。
- **装有 GitHub runner 的发行版一律拒绝**（`DISTRIBUTION_HOSTS_GITHUB_RUNNERS`）：有 `actions.runner.*` 单元（已加载或只安装）、`/home /opt /srv /root /usr/local /var/lib` 下 4 层内有 `.runner` 文件、或有 Runner.Listener 进程。这比 TURING 现状严：TURING 的 Ubuntu-24.04 里还留着已退役 home-linux-01 的 `/opt/actions-runner/.runner`（单元已 disabled、未运行），本脚本在那里会拒绝。新节点按隔离要求（4fedfc84）不与 PR 代码共用发行版。
- 只报告、不安装：PID 1、cgroup v2、`wsl.conf` 的 systemd 与 interop、`/run/WSL`、docker.service、python3.12、git、钉住的 toolchain node、trusted-source。它们是 `install-resident-linux.sh` 和 `clued-ci-install-source-v2` 的其余前提，另有步骤。

## 拒绝码（节选）

| 码 | 含义 |
|---|---|
| `NODE_HOST_REQUIRED`、`OWNER_ACCOUNT_REQUIRED`、`OWNER_PROFILE_DIRECTORY_MISMATCH` | 不是档案里的那台机器 / 不是 Owner 本人 / Owner 主目录不符 |
| `ELEVATED_DRY_RUN_REQUIRED` | 有已存在但普通权限读不了的目标；请在提权窗口里干跑 |
| `ELEVATED_OWNER_TOKEN_REQUIRED`、`EXPECTED_PLAN_SHA256_REQUIRED`、`PLAN_CHANGED_SINCE_REVIEW` | 执行需要提权、需要计划哈希、计划变了 |
| `RUNNER_PACKAGE_REQUIRED`、`RUNNER_PACKAGE_SHA256_MISMATCH`、`RUNNER_PACKAGE_ENTRY_REFUSED` | 需要 runner 包 / 包不是钉住的那个 / 包里有不安全的路径 |
| `CONTROLLER_ACCOUNT_EXISTS_DIFFERENT`、`CONTROLLER_SID_MISMATCH`、`CONTROLLER_ACCOUNT_MISSING`、`CONTROLLER_ACCOUNT_IN_USE_WITHOUT_SERVICE` | 账户与预期不符 |
| `RUNNER_SERVICE_EXISTS_DIFFERENT`、`RUNNER_SERVICE_WITHOUT_ACCOUNT`、`FOREIGN_RUNNER_SERVICE_IN_CONTROL_ROOT` | 服务与预期不符 / 有别的 runner 在 controller 目录 |
| `DIRECTORY_EXISTS_DIFFERENT:<路径>:<原因>`、`DIRECTORY_TARGET_REFUSED:<路径>`、`DIRECTORY_EXISTS_BEFORE_ACCOUNT:<路径>` | 目录已存在但不一样 / 是文件或链接 / 账户还没有目录却已在 |
| `RUNNER_ROOT_UNEXPECTED:<差异>` | runner 目录里有包外、被改过、缺少或属主不是管理方的文件（只列名字，最多五个） |
| `TOOL_LOCATION_NOT_ADMIN_ONLY:<原因>` | 提权运行的脚本不在只有管理员能改的位置 |
| `REGISTRATION_TOKEN_SHAPE_REFUSED` | 令牌形状不对；发生在任何写入之前，什么都没写 |
| `RUNNER_REGISTRATION_FAILED:<退出码>`、`RUNNER_LOG_CONTAINS_TOKEN:<文件>` | 注册失败（状态 `APPLY_PARTIAL`，提权干跑后接着做）/ runner 日志里出现了令牌 |
| `DISTRIBUTION_HOSTS_GITHUB_RUNNERS`、`WRONG_DISTRIBUTION`、`SCRIPT_LOCATION_REFUSED`、`PARENT_DIRECTORY_REFUSED` | Linux 侧：发行版装有 runner / 不是参数指定的发行版 / 不是 root 独占的副本 / 父目录不对 |

## 测试

```
powershell -NoProfile -ExecutionPolicy Bypass -File work\independent-ci-node-prep-v1\windows\test-prepare-node.ps1
wsl -d <任一发行版> -- bash work/independent-ci-node-prep-v1/linux/test-prepare-node-linux.sh
```

可选：环境变量 `NODEPREP_RUNNER_ZIP` 指向官方 `actions-runner-win-x64-2.337.0.zip`，再核对真实包（钉值、275 个文件条目全部通过路径检查）。

结果：Windows 179/179，Linux 41/41。

Windows 测试覆盖：档案的 20 个拒绝用例；TURING 档案推出的 node profile 与 `node-profile.turing.json` 逐字段相同、摘要与 `src/node-profile.mjs` 相同（有 node 时现算对拍）；DESK-W-591 的完整计划（顺序、标签、服务、未动 runner、包要求）；计划哈希绑定脚本、档案、现有 runner；TURING 实测 ACL 得到 `NOTHING_TO_DO`；35 个主机现状拒绝用例；部分执行后的密码重置；新建目录读回规则（属主是用户、未受保护、多出条目都拒绝）；提权运行位置规则（Owner 文档目录、用户可改目录、用户属主、可追加的脚本都拒绝，本仓库检出目录也拒绝）；临时目录树上的真实事实读取（不存在、目录、文件、junction；runner 目录的空、恰为包、已注册、多出、改动、缺少、属主）；`wsl --list --quiet` 输出解析；规划的 App key 与 ci-admission token 目录链通过 `verify-resident.ps1` 的 `Test-SecretAclChain`（原文抽取，不复制）；`migrate-acl.ps1` 的追加目标都已准备、它要建的都不在这里建；工具文本的静态保证；夹具根里的端到端干跑与执行（错误哈希、无哈希、错误包、离线事实不能用于真机、夹具根在 TEMP 外、二次执行不覆盖、中途停下的 `APPLY_PARTIAL` 回执、回执里的 node profile 通过常驻校验）。夹具里的建账户、注册和建服务是桩，只记录调用。

Linux 测试另覆盖：`/var/lib`、`/root` 下的 runner 注册文件，链接或缺失的父目录，root 独占位置规则对 `/mnt` 副本和用户副本的拒绝。另在 TURING 的 Ubuntu-24.04 以 root 实测：从 `/mnt` 直接运行得到 `SCRIPT_LOCATION_REFUSED`。

离线测试证明不了的（留给现场）：真实 UAC 下的建账户与组成员、`New-Service`、`Runner.Listener configure` 的真实网络注册（包括读 `ACTIONS_RUNNER_INPUT_TOKEN`）、真实 ACL 属主读回、`Get-AccountFact` 的 ADSI 读组、`Get-Postconditions` 本身、WSL 探测在真机上的结果。

## 已知限制与残余

- TURING 上以提权跑过一次干跑（只读），结果 `RUNNER_ROOT_UNEXPECTED`：TURING 的 runner 目录在运行后有包外或改过的文件（根目录一层与包一致，差异在更深层；Owner 取消了第二次 UAC，具体文件名未取得）。对新节点没有影响；对已有 runner 目录，工具一律失败关闭。夹具里 TURING 的 `runnerRoot` 按 `registered` 处理，另有用例覆盖实测的拒绝。
- 以下三项未验证，P3 首次启动 controller runner 时需要逐项核对：
  - “作为服务登录”权限：TURING 的 secedit 导出里没有 clued-control 的显式授权行，服务照常登录（推断是靠默认授予 `NT SERVICE\ALL SERVICES`，未核实）。本工具同样不改本地安全策略。
  - runner 根目录对 controller 只读：运行时若要在根目录写文件，会起不来。
  - `.credentials_rsaparams` 的 DPAPI 范围：TURING 用的是同一模式（提权 configure，再手工建服务），且能运行，多半是机器范围。
- 提权进程会继承 Owner 的 `HKCU\Environment`（例如 `COR_ENABLE_PROFILING`、`DOTNET_STARTUP_HOOKS`）。Owner 上下文里的代码可以预先写进这些变量，脚本层面防不住（审核 r1 指出，未实测）。现场说明用“执行后核对 GitHub 的 runner 列表”来发现令牌是否被冒用；也可以由 Owner 选择在输入令牌期间暂停跑 PR 代码的发行版。
- 部分失败的两种情况，工具不自动处理，交给 Owner 决定（现场说明 0.7）：解包到一半停下（`RUNNER_ROOT_UNEXPECTED:missing:*`）；GitHub 那边已注册、本地没写出 `.runner`（同名 runner 已存在）。
- runner 版本钉 2.337.0（与 TURING 原二进制相同）。GitHub 对关闭自动更新的旧版本有支持期限；注册或今后接活若因版本被拒，需 Owner 决定换版本（改档案的 `runnerPackage` 三项即可）。
- App 私钥、ci-admission token、正式资格、停车位不在本工具（`install-resident.ps1` 的 `-AppPrivateKeyFile` / `-CiAdmissionTokenFile`，各自需 Owner 决定）。
- Linux 侧的 toolchain node、trusted-source、Source v2 安装、systemd/docker 不在本工具；脚本只报告。
