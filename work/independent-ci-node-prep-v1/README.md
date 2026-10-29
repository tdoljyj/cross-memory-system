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

步骤（按顺序；已存在且完全一致的跳过）：

1. `account`：建本地账户 `clued-control`。描述 `Dedicated trusted-main CI control`，不进任何组（连 Users 也不进），密码永不过期、用户不可改密码；密码在内存里随机生成，只交给建账户和建服务两处，不显示、不保存。（与 TURING 实测一致。）
2. 目录（Owner = Administrators，受保护 DACL；取值见下表，照 TURING 实测）：`CluedControl`、`trusted`、`temp`、`runner`、`runner\_diag`、`runner\_work`。
3. `runner-extract`：把钉住的官方 runner 包解到 `CluedControl\runner`（逐个 CreateNew，逐个核哈希；文件继承 runner 目录：controller 只读）。
4. `runner-package-copy`：同一批字节另存 `CluedControl\runner-package.zip`（与 TURING 相同）。
5. `runner-register`：Owner 在提权窗口里输入 GitHub 注册令牌（`Read-Host -AsSecureString`，所有检查通过之后、第一次写入之前才问；只在计划含此步时问）。以 `Runner.Listener.exe configure --unattended --url https://github.com/tdoljyj/cross-memory-system --name <runner 名> --labels clued-controller-windows-v1 --work _work --disableupdate` 注册；**不带 `--runasservice`**，所以 runner 不会被启动、不会接活。标签 = 默认的 self-hosted、Windows、X64 加 `clued-controller-windows-v1`，即 `scripts/ci/clued-control-workflow-source.mjs` 的 `MAIN_SECRET_CONTROLLER_ROUTE`（测试逐字核对）。输出里令牌被替换成 `<token>`。
6. `runner-service-file`：`runner\.service`，内容就是服务名（TURING 的 63 字节文件即此）。
7. `service`：用 `CreateServiceW` 建 `<runnerService>`：`"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"`、`.\clued-control`、手动启动、显示名 `Clued dedicated trusted-main controller`、不启动。密码只在内存里交给 SCM，不上命令行。（TURING 的服务也是手工建的：无失败动作、无描述。）
8. 目录：`CluedIndependentCI`、`formal-spool`、`formal-spool\outgoing`、`formal-spool\incoming`、`state`、`state\temp`。

| 目录 | DACL（都另有 SYSTEM、Administrators 完全控制） |
|---|---|
| `CluedControl`、`trusted`、`runner` | controller 读+执行（OICI） |
| `CluedControl\temp`、`runner\_diag`、`runner\_work`、`state\temp` | controller 修改（OICI） |
| `CluedIndependentCI`、`formal-spool` | Owner `0x120080` 仅本目录；controller 读+执行（OICI） |
| `formal-spool\outgoing` | Owner 读（OICI）；controller 修改（OICI） |
| `formal-spool\incoming` | Owner 修改（OICI）；controller 读（OICI） |
| `state` | controller 本目录读、子项修改（OICIIO） |

不建的：`state\v2*`、`state\relay*`（`migrate-acl.ps1` 建）、`CluedIndependentCI\secrets` 和两个秘密文件、`resident\`（`install-resident.ps1` 建）；常驻服务 SID 的 ACE（`install-resident.ps1` 的 parent-acl 步和 `migrate-acl.ps1` 追加）。v1 遗留的 `inbox`、`source`、`verify-spool` 新节点不需要。

已存在的目录：只有授予的权限与计划完全相同才接受（继承来的与显式的视为相同；只额外接受上面那两个工具给常驻服务 SID 追加的那几条），属主必须是管理方；其他一律拒绝，不改。所以一台已装好的节点（TURING 的实测 ACL）干跑得到 `NOTHING_TO_DO`。

只新建、不覆盖、不删除：文件一律 `CreateNew`；目录创建前再查一次不存在。唯一改动已有对象的情况：`clued-control` 已存在、从未登录过、而它的 runner 服务还没建（上一次执行在建账户之后中断，比如令牌输错），计划会写明 `account-password-reset`，因为建服务需要密码而密码从不保存。账户登录过就拒绝（`CONTROLLER_ACCOUNT_IN_USE_WITHOUT_SERVICE`）。

不碰现有 runner：计划列出所有现有 `actions.runner.*` 服务（名字、二进制、账户、启动方式），执行后逐一核对没变（`otherServicesUnchanged`）；任何其他 runner 的二进制在 `CluedControl` 下就拒绝。脚本里没有删除、改 ACL、启动服务、改组成员的调用（测试做静态检查）。

WSL：干跑（非提权）列出发行版；对**正在运行**的发行版，读它是否装有 GitHub runner（runner 单元、带 `.runner` 的目录、Runner.Listener 进程）、docker socket、`/run/WSL`、`[interop]` 设置；**不启动**已停止的发行版。这些观察不进计划哈希。提权运行从不进入任何发行版（跑 PR 代码的发行版若开着 interop，能借提权令牌起 Windows 进程）。

### 执行后

回执（`node-prep-receipt/1`）给出每步结果、controller SID、（档案有发行版时）常驻用的 node profile 及摘要，以及后置核对：账户、六个路径（即现场第 1 步检查的 `CluedControl`、`trusted`、`runner\bin\RunnerService.exe`、`CluedIndependentCI`、`formal-spool`、`state`）、我们的服务 Stopped/Manual/原二进制/clued-control/PID 0、其他 runner 服务未变。任何一项不满足，状态是 `NODE_PREP_POSTCONDITION_FAILED`。

## Linux 侧做什么（`prepare-node-linux.sh`）

在 Owner 选定的发行版里以 root 运行（`wsl -d <发行版> -u root -- bash ...`）。`--plan` 只读；`--apply <hash>` 只执行那份计划。

- 只建 `/var/lib/clued-independent-ci`、其下 `formal-spool`、`runs`、`workspaces`，`/var/lib/clued-independent-ci-trivy-cache`，`/opt/clued-independent-ci`，`/etc/clued-independent-ci`，全部 root:root 0700（TURING 实测相同）。已存在的必须正好是这样，否则拒绝；`mkdir` 不带 `-p`（父目录必须已在）。
- 计划绑定脚本字节、发行版名、每个目录的现状。`WSL_DISTRO_NAME` 必须等于 `--distribution`。
- **装有 GitHub runner 的发行版一律拒绝**（`DISTRIBUTION_HOSTS_GITHUB_RUNNERS`）：有 `actions.runner.*` 单元、有带 `.runner` 的 runner 目录、或有 Runner.Listener 进程。这比 TURING 现状严：TURING 的 Ubuntu-24.04 里还留着已退役 home-linux-01 的 `/opt/actions-runner/.runner`（单元已 disabled、未运行），本脚本在那里会拒绝。新节点按隔离要求（4fedfc84）不与 PR 代码共用发行版。
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
| `RUNNER_ROOT_UNEXPECTED:<差异>` | runner 目录里有包外或被改过的文件（只列名字，最多五个） |
| `REGISTRATION_TOKEN_SHAPE_REFUSED`、`RUNNER_REGISTRATION_FAILED:<退出码>` | 令牌形状不对 / 注册失败（重跑干跑即可接着做） |
| `DISTRIBUTION_HOSTS_GITHUB_RUNNERS`、`WRONG_DISTRIBUTION` | Linux 侧：发行版装有 runner / 不是参数指定的发行版 |

## 测试

```
powershell -NoProfile -ExecutionPolicy Bypass -File work\independent-ci-node-prep-v1\windows\test-prepare-node.ps1
wsl -d <任一发行版> -- bash work/independent-ci-node-prep-v1/linux/test-prepare-node-linux.sh
```

可选：环境变量 `NODEPREP_RUNNER_ZIP` 指向官方 `actions-runner-win-x64-2.337.0.zip`，再核对真实包（钉值、275 个文件条目全部通过路径检查）。

Windows 测试覆盖：档案的 20 个拒绝用例；TURING 档案推出的 node profile 与 `node-profile.turing.json` 逐字段相同、摘要与 `src/node-profile.mjs` 相同（有 node 时现算对拍）；DESK-W-591 的完整计划（顺序、标签、服务、未动 runner、包要求）；计划哈希绑定脚本、档案、现有 runner；TURING 实测 ACL 得到 `NOTHING_TO_DO`；34 个主机现状拒绝用例；部分执行后的密码重置；规划的 App key 与 ci-admission token 目录链通过 `verify-resident.ps1` 的 `Test-SecretAclChain`（原文抽取，不复制）；`migrate-acl.ps1` 的追加目标都已准备、它要建的都不在这里建；工具文本的静态保证；夹具根里的端到端干跑与执行（错误哈希、无哈希、错误包、离线事实不能用于真机、夹具根在 TEMP 外、二次执行不覆盖、回执里的 node profile 通过常驻校验）。夹具里的建账户、注册和建服务是桩，只记录调用。

离线测试证明不了的（留给现场）：真实 UAC 下的建账户与组成员、`CreateServiceW`、`Runner.Listener configure` 的真实网络注册、真实 ACL 属主读回。

## 已知限制与残余

- TURING 上以提权跑过一次干跑（只读），结果 `RUNNER_ROOT_UNEXPECTED`：TURING 的 runner 目录在运行后有包外或改过的文件（根目录一层与包一致，差异在更深层；Owner 取消了第二次 UAC，具体文件名未取得）。对新节点没有影响；对已有 runner 目录，工具一律失败关闭。夹具里 TURING 的 `runnerRoot` 按 `registered` 处理，另有用例覆盖实测的拒绝。
- “作为服务登录”权限：TURING 的 secedit 导出里没有 clued-control 的显式授权行，服务照常登录。本工具同样不改本地安全策略。若 P3 时服务因登录权限起不来，另行处理。
- runner 版本钉 2.337.0（与 TURING 原二进制相同）。GitHub 对关闭自动更新的旧版本有支持期限；注册或今后接活若因版本被拒，需 Owner 决定换版本（改档案的 `runnerPackage` 三项即可）。
- App 私钥、ci-admission token、正式资格、停车位不在本工具（`install-resident.ps1` 的 `-AppPrivateKeyFile` / `-CiAdmissionTokenFile`，各自需 Owner 决定）。
- Linux 侧的 toolchain node、trusted-source、Source v2 安装、systemd/docker 不在本工具；脚本只报告。
