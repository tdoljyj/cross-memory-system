# ADR 0022：companion 不靠登录的实施——密码登录的计划任务、监督进程、通知拆分与新升级通道

- 状态：已实施（第 29 代，未安装）。只能随一次整套重装（R 类：Decision + UAC + Grant）装上，不能走原地升级（本文 §4.0）。装好后 companion 任务先是 InteractiveToken 加监督进程，Owner 在安全桌面输一次密码之后才切成密码登录。
- 日期：2026-11-07（设计）；2026-11-08（实施与三轮独立审核）；第 29 代合入
- Owner Decision：`9dc130c7` 第 3 项（M5 采用 B2）、第 4 项（companion 改用细粒度 GitHub 令牌）；`ad709155`（批准本次修改升级器 `upgrader/src/machine.mjs`、`windows-port.mjs`）
- 关联：[ADR 0011](0011-companion-without-logon.md)（决定）；Task `59f8ef81`；优化方案 Task `bf57ff10` 的 M5
- 来源：设计稿 `e19dbb41`、实现分支 `claude/companion-headless-impl` 提交 `1af0910bd`。该分支把本文写成常驻 DESIGN 的 §65，与 main 上冻结档案的 §65（strict 永久开模式）撞号，而 DESIGN 已在 §70 冻结，所以合入时改为本 ADR。代码注释里的 “ADR 0022 §n” 指本文第 n 节；正文里的 §8.4、§24、§41.6a 等仍指冻结的 DESIGN。
- 运维手册：[`../../rollout/M5-COMPANION-HEADLESS-RUNBOOK.md`](../../rollout/M5-COMPANION-HEADLESS-RUNBOOK.md)

## 摘要

- **背景**：companion 是 AtLogOn、InteractiveToken 的计划任务。Owner 没登录（重启后、注销后）时它不在，执行器以 `COMPANION_NOT_READY` 推迟一切，冷启动到能干活没有时间上界；Owner 没登录时的原地升级也拉不起它（本文 §1）。
- **决定**：
  - companion 任务改为 Owner 本人、密码登录（`TASK_LOGON_PASSWORD`）、LUA；触发器只有开机加 30 秒和每 15 分钟一次，没有 LogonTrigger、没有 RestartOnFailure；SDDL 里 Owner 只有读（本文 §4.1）。
  - 任务的动作固定为管理员专用 `bin\` 里的 `CluedCompanionSupervisor.exe`，它按管理员专用的 launch 文件启动 companion，核对哈希、拒绝重解析点、环境用白名单、退避重启永不放弃（本文 §4.2）。
  - 通知改为写队列，由只在登录时运行的新任务 `\Clued\CluedCIResidentNotifier` 显示（本文 §4.3）。
  - 密码只由 `CluedCompanionTaskRegistrar.exe` 在安全桌面上收取，直接交给任务计划程序，不进 PowerShell；切换先写待验收标记并登记 SYSTEM 回退任务，8 分钟内由提权一侧实测，不通过就自动退回（本文 §4.4）。
  - 新升级通道不再注册 companion 任务：升级、回滚、Recover 只写 launch 文件、重启子进程（本文 §4.4）。
  - companion 用只限本仓库的细粒度令牌，放在它自己的 gh 配置里（本文 §11）。
- **理由**：只有通知需要交互桌面，其余都只要 Owner 的身份、档案和 DPAPI 能用的登录（本文 §2）；B2 不换账户，ACL、发行版、令牌、出网都不变（本文 §3、§4.6）。
- **后果**：任务计划程序里多存一份 Owner 的 Windows 密码，SYSTEM 和管理员能还原出明文，需要 Owner 明确接受（本文 §4.6、§5）；改密码后要再切换一次；冷启动到能执行 ≤ 10 分钟，快速启动恢复 ≤ 20 分钟，都不需要登录（本文 §4.5）；上线和真机验收见运维手册。

## 详细设计（原分支 DESIGN §65，节号改为本文节号）

### 1. 现状与问题

- 现在的任务（§8.4）：`\Clued\CluedCIResidentCompanion`。
  - 配方：`install-resident.ps1#Register-CompanionTask`，冻结升级通道 `upgrade-apply.ps1` 用的是同一配方。
  - 2026-11-07 在 DESK-W-591 只读回读：主体 Owner SID，`LogonType=InteractiveToken`，RunLevel LUA，只有一个 `LogonTrigger`，`RestartOnFailure` 3 次、间隔 1 分钟，`IgnoreNew`。
  - 动作：`conhost --headless node resident\<sha>\src\companion-main.mjs …`。
- 后果：
  1. 开机后没人登录：三个 SCM 服务（`CluedCIResident`、`CluedCISwapBroker`、`CluedCIUpgrader`）在跑，companion 不在。执行器只推迟（`companionReady` 要新鲜心跳），不出错，也不干活。
  2. Owner 注销：companion 随交互会话结束。节点心跳 30 分钟后算失联，触发接班（§41.6a）。
  3. 崩溃：任务计划程序最多补 3 次，之后要等下一次登录。
  4. Owner 没登录时的原地升级：`upgrade-apply.ps1#Invoke-RestartCompanion` 的 `$task.Run()` 拉不起 InteractiveToken 任务，结果是 `COMPANION_NOT_STARTED`。回滚时 `machine.mjs` 进入有界等待，节点停着（`restart-companion`）。
  5. 冷启动到能执行没有时间上界：取决于 Owner 什么时候登录。

### 2. companion 到底用了 Owner 会话的什么

逐项核对源码。“需要什么”一栏区分两件事：

- **身份**：Owner 的 SID、已加载的用户档案和 HKCU、能解开 DPAPI 的登录；
- **交互桌面**：能显示窗口和通知的会话。

| # | 用到的东西 | 在哪里 | 需要什么 |
|---|---|---|---|
| 1 | **WSL 发行版归属**。发行版按 Windows 用户注册在 HKCU `Lxss` 下，vhdx 在 Owner 档案里：DESK 是 `CluedResident-Linux`，位于 `C:\Users\Windows\WSL\CluedResident-Linux`；TURING 是 `Ubuntu-24.04`。所有 root 工具都经 `wsl --distribution <D> --user root --exec …` 运行，另有保活进程 `wsl --exec /bin/sleep infinity` | `companion.mjs#argv`（`wsl(...)`、`keepalive`）、`companion-main.mjs#keepalive` | 身份、HKCU |
| 2 | **DrvFs**：Linux 经 `/mnt/c` 读写 bundles、formal-spool、upgrade 的 staged，用的是发行版所属用户的 Windows 令牌，所以 ACL 里写的是 Owner SID | §8.3，`install-resident.ps1#Get-AclPlan` | 身份 |
| 3 | **git 凭据**：`credential.helper = !gh auth git-credential`，令牌在 gh 的 keyring 里（凭据管理器，用户 DPAPI）。`build-bundle.ps1` 在不提权时用它 fetch 私有仓库，提权就拒绝（`NON_ELEVATED_RUN_REQUIRED`） | Source `resident-v2/build-bundle.ps1` | DPAPI 能用的登录（带密码凭据）；不需要桌面 |
| 4 | **gh 登录**。**不是只读**，和第 3 项是同一个令牌，scope 为 `repo`、`workflow`、`gist`、`read:org`（`gh auth status` 只看 scope，没看令牌）。<br>读：poller、`pr-head`、main 的分支规则、提示模式的 check-runs。<br>写：`POST statuses`（`pr-status.mjs`）、`POST actions/runs/<id>/rerun`（`admission-rerun.mjs`）、`POST …/dispatches`（`panel-dispatch.mjs`）、`POST issues/<n>/comments`（`companion-heartbeat.mjs#ghHandoverPort`） | 见左 | 同第 3 项 |
| 5 | **Windows 通知**：`toastArgv` 起 PowerShell 调 WinRT toast，共 6 处：PR 状态、节点心跳、算力面板、合并核对、补跑、规则兜底 | `pr-status.mjs#toastArgv` 和它的调用方 | **交互桌面**。唯一一项必须有登录会话的 |
| 6 | **用户可写目录**。<br>Owner 档案 `%LOCALAPPDATA%\CluedIndependentCI\`：`companion-lock`、`companion-log`，以及 5 个记忆文件。<br>常驻目录里 Owner SID 可修改的：`bundles`（含 `_seed`）、`mailbox\responses`（答复和心跳）、`upgrade\mailbox\responses`、`owner\train-review`（不是 companion 用的）。<br>Owner 只能新建的：`inbox`、`requests`、`upgrade\inbox`。<br>Owner 能读的秘密：`secrets\heartbeat`（节点心跳令牌） | `companion-main.mjs`、`Get-AclPlan` | 身份、档案 |
| 7 | **身份自检**：`USERPROFILE == node.ownerProfileDirectory`（`COMPANION_NODE_IDENTITY_CHANGED`）；`companionProcessAlive` 假定进程用的是 Owner 不提权的令牌；`build-bundle.ps1` 拒绝提权 | `companion-main.mjs` | 身份、档案 |
| 8 | **出网**：服务按服务 SID 封了出站（§7），所以节点上只有 companion 出网（GitHub、Supabase 心跳）。代理设置是用户级的 | §7 | 身份、档案 |

结论：

- 只有第 5 项要交互桌面。第 1–4 项和第 6–8 项要的是“Owner 本人的身份、已加载的档案、DPAPI 能用的登录”，不要求有人坐在桌面前。
- Agent 以 Owner 账户运行，所以第 1、3、4、6 项今天 Agent 就够得着，这在 §3.3 和 resident constraint `4fedfc84` 里是已接受的边界。
- 同一用户的进程还能经环境变量（HKCU 里的 `NODE_OPTIONS`）、`~/.gitconfig`、调试或注入影响 companion，这也在已接受的边界之内。companion 只是搬运，不是权威（§3.3）。
- M5 的任何方案都不能放宽这些边界；收紧它们是另一件事（本文 §3 的方案 A）。

### 3. 方案比较

**A. 专用低权限本地账户（例如 `.\clued-companion`），以计划任务或服务运行**

- 不可行的子方案：
  - gMSA：要求 AD 域，两台节点都是工作组（`net accounts`：`WORKSTATION`）。
  - 虚拟账户或 LocalSystem：WSL 不支持 LocalSystem；虚拟账户拥有不了按用户注册的发行版，也没验证过；DrvFs 的身份会变成服务 SID。
  - 所以 A 只能是一个普通本地账户。
- 安全：最好。
  - Owner 会话（含 Agent）不再是常驻发行版的 root，也拿不到 companion 的 GitHub 凭据。
  - 如果 ACL 一并迁移，Owner 会话也写不了 `mailbox\responses`。
  - 要存的密码是一个**非管理员**账户的密码。
  - 整体上是把 `4fedfc84` 收紧。
- 影响：
  - 节点档案加 `companionSid`、`companionProfileDirectory`。
  - §8.3 里 companion 用的 Owner SID 条目全部换成新 SID。
  - 发行版迁到新账户，用 `wsl --import-in-place` 或导出再导入，docker 镜像、systemd 单元、`/var/lib/clued-independent-ci` 都跟着走。
  - 新账户要有自己的 GitHub 凭据，这是一个新秘密，Agent 看不到。
  - 所有在 Owner 会话里执行 `wsl -d <D> -u root` 的手册都要改为用 `runas` 加密码：reinstall A/B、`linux/host-tuning`、`install/verify-resident-linux.sh`、`make-result-key.sh`。Owner 也就没有了直接进 root 诊断的路。
- Owner 一次性操作：至少 6 步，好几次要输密码。
  1. 建账户、设密码；
  2. 授予批处理登录或服务登录权限；
  3. 迁移发行版；
  4. 在新账户下 `gh auth login`；
  5. 带新档案重装；
  6. 改掉 Linux 运维习惯。
- 失败与恢复：用密码登录时，问题和 B2 一样，只是账户价值低；用 S4U 时没有 DPAPI，GitHub 凭据只能放进加了 ACL 的明文文件。
- 结论：作为加固候选，记为 M5-b（本文 §9）。如果 Owner 不接受 B2 的代价 3（存管理员密码），就应改走 A。

**B. 不换账户：同一个 Owner 账户，改为非交互登录（“不管用户是否登录都要运行”）**

- **B1 S4U（不存密码）**：不推荐。
  - S4U 登录没有密码凭据，用户 DPAPI 解不开；任务计划程序界面自己也注明“只能访问本地资源”。第 3、4 项会失败。
  - 绕过它就得把 gh 令牌改成明文文件存储，等于把同一个秘密放到更差的地方。
  - WSL 在 S4U 下能不能用没有验证。
  - 优点：不存密码，不会触发账户锁定。
- **B2 密码登录（`TASK_LOGON_PASSWORD`）**：推荐的底座。
  - 和今天相比，身份、档案、DPAPI、令牌、ACL、发行版、出网都不变，只是没有桌面，所以通知要拆出去（方案 C）。
  - 代价有四个：
    1. Owner（管理员账户）的密码要交给任务计划程序保存。它存在 SYSTEM 的凭据库里，受机器 DPAPI 保护，**SYSTEM 和任何管理员都能还原出明文**。今天任何地方都没有存这个密码。
    2. Owner 一改密码，任务就登录不上。
    3. 存的密码失效时，每次触发都是一次失败登录，可能把 Owner 自己的账户锁住。DESK 的策略是阈值 10、观察窗口 10 分钟、锁定 10 分钟。
    4. 没有密码就无法改写这个任务的定义，所以自动路径（SYSTEM 升级器）一律不能再注册它。
  - 本文 §4 逐项处理这些代价，代价 1 需要 Owner 明确决定（本文 §5）。

**C. 拆成“要会话的部分”和“不要会话的部分”**

- 本文 §2 已经说明，只有通知要会话，所以只拆分去不掉对登录的依赖。
- 把 WSL 操作挪进服务也不行：服务账户够不到 Owner 的发行版，而且封了出站。
- 所以 C 只作为 B2 的组成部分：companion 只写通知队列，另起一个只在登录时运行的通知任务。

**D. 其他**

- D1 自动登录后锁屏：不推荐。注销问题照旧，密码同样要存，开机到锁屏之间控制台是解锁的。
- D2 Linux 一侧改用 Hyper-V 常驻虚拟机：bridge、资格、运维要整套重做，超出 M5 范围。
- D3 由常驻服务拉起交互任务：没人登录时根本没有会话。

**推荐：B2 + C，加上一个稳定的监督进程、不会锁账户的触发器，以及在安全桌面上输入的凭据（本文 §4）。B2 的代价 1 不被接受时，改走 A（M5-b）。**

### 4. 推荐方案

#### 4.0 先决条件：M5 必须整套重装

- 冻结的升级通道每次升级、回滚、Recover 都会按 InteractiveToken 加 conhost 的配方重注册 companion 任务：`upgrade-apply.ps1:125-126`、`:172-177`，`machine.mjs` 第 652、744 行，`upgrade-apply.ps1:732`。
- `upgrade-apply.ps1` 属于冻结范围（§34.8、§42.1 c、`rollout/INSTALL-BATCHES.md` 的 R 类），改一个字节就会被拒：`UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL`。
- 所以：
  - M5 不能走原地升级。只能随一次整套重装（R 类：Decision + UAC + Grant）装上，同时换掉 `upgrade-apply.ps1` 和 `upgrader/src/machine.mjs` 里 companion 的那一步。
  - 新通道里不再有 `registerCompanionTask`。升级、回滚、Recover 只改 launch 文件、重启 companion 子进程（本文 §4.4）。
  - 在 M5 装好之前，**不能**单独把任务切成密码登录。否则下一次升级、回滚或 Recover 会把它悄悄改回 InteractiveToken，存的凭据也跟着丢失。

#### 4.1 companion 计划任务：只在提权路径里写，自动路径永不改写

- 名称不变：`\Clued\CluedCIResidentCompanion`。
- 主体：Owner SID，`LogonType=Password`（1），`RunLevel=LUA`（0）。
- 触发器：
  - `BootTrigger`，Delay `PT30S`；
  - `TimeTrigger`，`Repetition.Interval=PT15M`，无限期。
  - **不要 `LogonTrigger`**：密码失效时，Owner 的每次登录都会多一次失败尝试。
- 设置：
  - `IgnoreNew`；
  - **不要 `RestartOnFailure`**，重启交给监督进程；
  - `StartWhenAvailable=true`，`ExecutionTimeLimit=PT0S`，两项电池设置为 false。
- **SDDL：`D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;<Owner>)`**：
  - Owner 只给读，**不给执行**（今天是 FRFX）。这样 Owner 会话（含 Agent）不能反复 `Run` 去刷失败登录，以此锁住账户；
  - 通知任务能读 `State` 和 `LastTaskResult`；
  - 需要手动拉起时，从提权窗口操作。
  - 相应地，`replace-heartbeat-token.ps1` 的提示要改成“在提权窗口里重启任务”。
- **动作固定**：`<root>\bin\CluedCompanionSupervisor.exe "<root>"`，不含代际哈希。
- **锁定的账**：
  - 计数在最后一次失败后经过一个观察窗口（10 分钟）清零。
  - 自动触发里只有开机和每 15 分钟一次两类，间隔都大于观察窗口。同一窗口里最多有：开机 1 次、重复 1 次、SYSTEM 升级器重启 1 次、Owner 提权手动运行若干次。
  - 规则：`verify-resident.ps1` 不提权读 `net accounts`。必须满足下面两条之一，否则记 `COMPANION_LOCKOUT_MARGIN_INSUFFICIENT` 为不通过：
    - 阈值 = 0（不锁定）；
    - 阈值 ≥ 6，且观察窗口 < 15 分钟。

#### 4.2 监督进程 `CluedCompanionSupervisor.exe`（新，C#）

- 编译：随安装编译进管理员专用的 `bin\`，做法与作业宿主（§24）相同：`/noconfig`、引用写全路径、`winexe`。
- **launch 文件**：只读管理员专用的 `config\companion-launch.json`。
  - 合同 `clued.independent-ci.companion-launch/1`，有界，键固定：`generation`、`nodeExe` 及其 sha256、`entry` 及其 sha256、`configSha256`。
  - 写入方（安装器、新的升级通道）用“临时文件 + `MoveFileEx(REPLACE_EXISTING|WRITE_THROUGH)`”原子替换。
  - 监督进程读取时：
    - 用 `FILE_FLAG_OPEN_REPARSE_POINT` 打开，拒绝重解析点；
    - 从 root 到文件逐级核对，任何一级是 junction 或符号链接都拒绝；
    - 核对所有者是 Administrators，DACL 里 Owner 只有读执行。
  - 两个目标文件以 `FILE_SHARE_READ`（不含写和删）打开，持有句柄核对哈希，**持有到子进程启动之后**，避免核对和使用之间被换掉。
  - 任何一项不对都不启动，退避后重读。
- **子进程**：
  - 启动方式：`node.exe <entry> --root <root> --config-sha256 <sha>`，加 `CREATE_NO_WINDOW`。
  - **环境用白名单**，从任务给的环境里只保留：`SystemRoot`、`windir`、`ComSpec`、`PATHEXT`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`HOMEDRIVE`、`HOMEPATH`、`USERNAME`、`USERDOMAIN`、`COMPUTERNAME`、`TEMP`、`TMP`、`ProgramData`、`ProgramFiles*`、`NUMBER_OF_PROCESSORS`、`PROCESSOR_*`，以及代理变量 `HTTP(S)_PROXY`、`NO_PROXY`。
    - `PATH` 重设为系统目录加 gh 和 git 的安装目录（取自 companion 配置）；
    - `NODE_*`、`GIT_*`、`GH_*`、`PSModulePath` 等一律不传。
  - 局限：同一用户还能改 `~/.gitconfig`，或者调试、注入这个进程，这仍在本文 §2 所说的已接受边界之内。白名单只关掉最省事的那条路，不是新的权威。
  - 作业对象：子进程放进监督进程自己的作业对象，`KILL_ON_JOB_CLOSE`。监督进程结束时 companion 一起结束。作业宿主的嵌套作业不受影响，WSL 里已启动的 systemd 单元也不受影响。
  - 监督进程用 `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)`，只引用系统 DLL。
- **重启**：
  - 子进程退出后依次等 5、10、20、40 秒，之后每次 60 秒，永不放弃；连续运行满 10 分钟后退避清零。
  - **launch 文件的 `generation` 变了就立即启动**，不退避，这样升级时等新进程的时限够用。新通道的等待时限也从 30 秒放宽到 90 秒。
  - 退出码和时刻记进 `%LOCALAPPDATA%\CluedIndependentCI\supervisor.json`，至多 50 条。这个文件只是给人看的，没有任何判断依赖它。
- **令牌自检**：
  - 监督进程启动时读自己的令牌。`TokenElevationType` 为 Full，或 Administrators 处于启用状态（不是 deny-only），就以 `SUPERVISOR_ELEVATED_TOKEN_REFUSED` 退出。
  - companion 加同样的检查：`COMPANION_ELEVATED_TOKEN_REFUSED`。
  - 这样任务被设成“最高权限”时，不会带着管理员令牌运行。
- 单实例：沿用 companion 的实例锁，加上任务的 `IgnoreNew`。

#### 4.3 通知拆分（方案 C）

- **companion 一侧**：6 处 `toastArgv` 改为同一个 `notify(key, title, body)`，写进 `%LOCALAPPDATA%\CluedIndependentCI\notify-queue\`。
  - 一条一个文件，只新建；文本按 `toastArgv` 截断到 400 字；
  - 上限 500 个文件、2 MB，超出就丢掉最旧的，并记一条“已丢弃 N 条”；
  - “已通知”的记忆改为“已入队”。
- **通知任务 `\Clued\CluedCIResidentNotifier`（新）**：
  - 配置：InteractiveToken、LUA、AtLogOn。动作是 `conhost --headless node resident\<sha>\src\notifier-main.mjs`。它不存密码，新通道可以照常改写。
  - 每 5 秒显示一次队列里的通知，显示完删除。
  - 登录时和之后每 5 分钟检查一次，各情况的提示：
    - companion 任务的 `LastTaskResult` 落在登录失败的码里（`0x8007052E`、`0x8007052F`、`0x80070530`、`0x80070532`、`0x80070533`、`0x80070569`、`0x80070775`）：出“companion 无法登录（码 X）”；
    - 心跳超过 5 分钟没更新：出“companion 无心跳”；
    - 反复重启：出“companion 反复重启”。
- **通知队列可以被伪造**：Owner 会话可写这个目录，今天它们本来也能直接弹通知。所以：
  - 任何通知文本**都不叫人输入密码或凭据**，只给出码和手册里的章节号。
  - 运行手册明文规定：只在自己亲手启动提权命令、点过 UAC 之后，**而且只在安全桌面上**的凭据框里输入密码（本文 §4.4）。在普通桌面上弹出的“凭据框”一律当作伪造。
- 没人登录时，队列有界累积，下次登录时显示。远端信号不依赖会话：PR 页的提交状态和 KooYomi 节点心跳。

#### 4.4 凭据输入、安装、复位、升级通道、校验、卸载

- **凭据输入：一个专用的 C# 小程序 `CluedCompanionTaskRegistrar.exe`**
  - 随安装编译进管理员专用的 `bin\`，只在提权时运行；不提权就拒绝。
  - 用 `CredUIPromptForWindowsCredentials` 加 `CREDUIWIN_SECURE_PROMPT`，在**安全桌面**上弹凭据框（和 UAC 同一个桌面，中等完整性的进程既画不上去，也读不到）。
  - 用户名预填为 Owner；`LookupAccountName` 解析出的 SID 必须等于节点档案里的 `ownerSid`，否则拒绝。
  - `CredUnpackAuthenticationBuffer` 把密码解到固定的非托管缓冲区，直接作为 `VARIANT(BSTR)` 交给 `ITaskFolder::RegisterTaskDefinition(…, TASK_LOGON_PASSWORD, sddl)`，随即用 `SecureZeroMemory` 清零缓冲区和 BSTR。
  - 密码从不进入 PowerShell，所以不受 Transcription、ScriptBlock 日志或命令历史影响；也不进文件、计划、回执、日志、环境变量或命令行。
  - 程序只输出码：`REGISTERED`、`CREDENTIAL_NOT_GIVEN`、`ACCOUNT_MISMATCH`、`LOGON_REJECTED`（注册时任务计划程序会核对密码）等。
  - 调用它的 PowerShell 脚本保持 §8.5 的 `-NoProfile -NonInteractive`。
- **安装（整套重装）**：
  - 步骤 `companion-launch`：写 launch 文件。计划、回执和 verify 都钉它的哈希。
  - 步骤 `notifier-task`：注册通知任务。
  - 步骤 `companion-task`：先按“InteractiveToken + 固定的监督进程动作”注册，不要密码。这一步保证即使后面中止，也和今天一样能用。
  - 步骤 `companion-headless`（重装启动器的最后一步）：与下面的复位模式是同一段代码。
- **复位**：`rearm-resident.ps1 -CompanionHeadless`，用于重装的最后一步或以后重做。
  1. 只读预检：
     - `Lsa\DisableDomainCreds` 必须为 0；
     - 锁定余量符合本文 §4.1；
     - Owner 账户 `PasswordRequired`/`PasswordExpires` 记为事实；
     - Microsoft 账户节点拒绝：`COMPANION_HEADLESS_MSA_UNSUPPORTED`。
  2. **先写管理员专用的待验收标记** `install\companion-headless-pending.json`，记录开始时间和退回所用的定义。
  3. 运行注册小程序，在安全桌面上输一次密码。
  4. 在提权一侧 `Run` 任务。
  5. 8 分钟内**由提权一侧直接核对**，不采信 Owner 可写目录里的自报：
     - 用任务实例找到监督进程和 node 子进程的 PID，`OpenProcessToken` 读它们的真实令牌：不是提权令牌，Administrators 为 deny-only，会话号 = 0，镜像路径等于 launch 文件里的路径；
     - companion 的心跳在这段时间里更新过；
     - 常驻服务读到的 Linux 侧事实刷新过，即服务邮箱里一条只读的 root 工具应答。
  6. 通过就删除标记。不通过就按标记里的定义退回 InteractiveToken（不需要密码），删除标记，报告 `COMPANION_HEADLESS_QUALIFICATION_FAILED` 以及没通过的项。
  - 中途被打断（窗口被关、机器重启）时，标记还在。`verify-resident.ps1` 和下一次 `rearm` 一看到超过 15 分钟的标记，就先执行退回，不会停在没验收过的密码模式。
  - 心跳和 Linux 事实这两个信号仍然可以被 Owner 会话伪造（在已接受的边界之内）。伪造的后果只是“没验收也当成通过”，之后 companion 实际没在干活，服务只会推迟，不会因此获得任何权限。Agent 也能故意结束进程，逼它退回，这只影响可用性，和今天结束 companion 一样。
  - `-CompanionCredential`：改密码后用，只换密码，同样有标记和核对。
  - `-CompanionInteractive`：手动退回。
- **新的升级通道**（随 M5 重装进入冻结范围）：
  - 升级、回滚、Recover 都把 `register-companion-task` 换成 `write-companion-launch`：
    1. 原子替换 launch 文件；
    2. 结束 companion 的 node 子进程和作业宿主（沿用 `Get-CompanionProcesses` 的循环），**不碰任务本身**；
    3. 监督进程看到新的 `generation` 后立即拉起；
    4. 在 90 秒内核对新进程的命令行（`--config-sha256`、`resident\<sha>`）。
  - 如果监督进程本身不在（任务没运行），由 SYSTEM `Run` 任务。密码任务可以这样运行，不需要密码。
  - 发现任务定义不是本文 §4.1 的定义时，**不重注册**，只记 `COMPANION_TASK_NEEDS_OWNER`，服务一侧照常完成升级。
  - 回滚也一样，只写回上一代的 launch 文件。
  - 通知任务照常重注册。
- **verify-resident.ps1**：
  - 核对：任务定义（LogonType=1、RunLevel=0、主体、固定动作、两个触发器、没有 RestartOnFailure、SDDL 中 Owner 为 FR）、launch 文件和两个目标文件的哈希、通知任务、锁定余量。
  - `LastTaskResult` 不在登录失败的码里。
  - 待验收标记不存在，或者已按上面的规则退回。
  - 记录 Owner 账户的密码有效期（`PasswordExpires`）和 C: 的 BitLocker 状态，作为事实（提权时）。
- **uninstall-resident.ps1**：先结束监督进程，再删两个任务。存的凭据随任务一起删除。

#### 4.5 冷启动的时间上界

- 启动链：开机 → 任务计划程序 → `BootTrigger` 加 30 秒 → 批处理登录并加载档案 → 监督进程核对 → companion 核对配置并探测作业宿主（≤ 30 秒）→ 第一次心跳 → 保活进程冷启动 WSL 虚拟机。
- 上界：
  - 正常冷启动：第一次心跳 ≤ 5 分钟，WSL 就绪 ≤ 8 分钟，**能执行 ≤ 10 分钟**（验收门槛）。
  - 任务没被开机触发的情形，比如快速启动（DESK 已开 Hiberboot）恢复时 `BootTrigger` 不触发，由 15 分钟的重复触发兜底：**≤ 20 分钟**。
  - 都不需要任何人登录。
- 可观测：status.json 增加 `companion.firstBeatAfterServiceStartMs`。服务启动 10 分钟后还没有心跳时出 `companion-absent`，在下次登录时显示；远端由节点心跳过期反映（§41.6a）。

#### 4.6 安全论证（如实列出得失）

- **没变的**：
  - 同一个账户、同一个 LUA 令牌，并且由提权一侧实测；
  - ACL、发行版、gh/git 令牌（仍在 keyring）、出网都不变；
  - 不新增 GitHub 或 Supabase 令牌；
  - Owner 会话能做的事不增加。
- **变好的**：
  - Owner 会话不能再运行或结束 companion 任务（SDDL 从 FRFX 改成 FR）；
  - companion 的环境改成白名单；
  - 会话 0 没有能被关掉的窗口，不会再出现 2026-10-21 那样关窗口结束 companion 的事；
  - Owner 注销、重启都不再让节点停摆。
- **新增的秘密（需要 Owner 明确接受）**：
  - Owner 的 Windows 密码保存在任务计划程序的凭据库里（SYSTEM 的 DPAPI），**SYSTEM 和管理员能还原出明文**。
  - Agent 看不到它：不在任何 Owner 可读的地方，输入时在安全桌面上。
  - 但它可以被间接够到，路径有两条：
    1. 一个按 `f8aff2f9` 自动审批、以 SYSTEM 执行的升级包；
    2. 一次 UAC 绕过（本机 `ConsentPromptBehaviorAdmin=5` 是默认值，Owner 是管理员）。
  - 这两条路径今天就能拿到 App 私钥、ci-admission 令牌和整台机器，所以爆炸半径没有扩大。真正多出来的是：这个密码一旦泄露，能在别处登录 Owner 的账户。
  - 对策：
    - 这个密码必须是本机专用、不在别处复用的密码；
    - Microsoft 账户节点不适用（会拒绝，见复位的预检）；
    - 建议开 BitLocker，防离线窃取；
    - Owner 不接受这项代价就改走 M5-b（存的是一个非管理员账户的密码）。
- **其他风险与对策**：
  1. 锁住账户：靠触发器间隔、SDDL 不给 Owner 执行权、verify 核对余量。
  2. 改密码：通知任务和 verify 能检测；恢复只需一次复位。
  3. companion 在 Owner 不在时运行：和今天“已登录、锁屏、人不在”完全一样（§8.4 锁屏也算登录）。
  4. 伪造凭据框或通知钓鱼：用安全桌面加运行手册规则（本文 §4.3）。Owner 可以自行开启“凭据输入需要可信路径”（`EnableSecureCredentialPrompting`），这是 Owner 做的系统设置，不强制。

### 5. Owner 一次性要做的事

1. **决定**：是否接受本文 §4.6 的“新增的秘密”。接受就继续；不接受就改走 M5-b。决定写成一条 Decision。
2. **前提**（Agent 只读核对后告诉 Owner）：
   - Owner 账户要有非空、本机专用的密码。DESK 的 `PasswordRequired` 为 False，看不出是不是空密码；如果是空的，由 Owner 在系统设置里设一个。
   - Microsoft 账户节点不适用。
   - 建议开 BitLocker。
3. **批准 M5 的整套重装**：照 R 类流程，Decision + Grant。
4. **运行重装启动器**：在自己的提权窗口里运行（点一次 UAC）。最后一步会在**安全桌面**上弹出 Windows 凭据框，输一次自己的 Windows 密码。之后脚本自己验收；8 分钟内不通过就自动退回原来的登录方式，并说明原因。
5. **验收**：方便时重启一次，不登录，10 分钟后再登录（或让 Agent 读 status.json）。

以后只有改了 Windows 密码才要再操作一次：在提权窗口运行 `rearm-resident.ps1 -CompanionCredential`，点 UAC，在安全桌面上输入密码。

### 6. 实施前要核实的前提（P0，`-CompanionHeadless` 在现场核对）

- Q1 会话 0 的密码批处理登录里 WSL 能用：
  - `wsl --distribution <D> --user root --exec /bin/true`；
  - `/mnt/c` 能读 bundles；
  - 发行版里的 `docker.service`（§9，不是 Docker Desktop）可达。
- Q2 同一用户在批处理会话和交互会话里启动的是同一个发行版实例：`boot_id` 相同；Owner 在控制台 `wsl -d <D> -u root` 不会因为 vhdx 被占用而失败。
- Q3 DPAPI 能用：`gh auth status` 能通过；经 gh 凭据助手的 `git ls-remote` 能成功。
- Q4 令牌是 LUA：提权一侧用 `OpenProcessToken` 实测，`build-bundle.ps1` 里的 `IsInRole` 为假。
- Q5 注销交互会话不影响批处理会话（T2）。
- Q6 快速启动的行为（T7）。

Q1 或 Q2 不成立，就不发 B2，改走 M5-b 或 D2，并重新设计。

### 7. 验收测试

- **T1 无人登录冷启动**：重启，不登录。
  - 第一次心跳在服务启动后 ≤ 10 分钟，节点心跳连续。
  - 端到端：期间由别的节点推一个小 PR，本节点在无人登录时**完整跑完一个批次**。
- **T2 注销**：companion 运行时注销。
  - companion PID 不变，心跳空档 < 30 秒，正在跑的批次不受影响。
  - 再登录时不出现第二个 companion，通知任务清空队列。
- **T3 崩溃**：
  - 结束 node：10 秒内拉起；连续结束 6 次，退避封顶 60 秒，不放弃。
  - 结束监督进程：companion 随之结束，15 分钟内由重复触发拉起。
  - 期间服务只推迟，不烧任何 head。
- **T4 凭据失效**：
  - 改密码但不复位，然后重启：`LastTaskResult=0x8007052E`；两小时内事件 4740 为 0，4625 至多每 15 分钟 1 次；登录后看到通知；`-CompanionCredential` 之后 5 分钟内有心跳。
  - **在 Owner 会话里连续 `schtasks /run` 10 次**：被拒绝（没有执行权），账户不会被锁。
  - GitHub 令牌被撤销：companion 照常运行，按现有分类报 `BUNDLE_UNAVAILABLE`。
- **T5 升级、回滚、Recover 之后**：任务的 XML 哈希不变，仍是密码模式；新代际在 90 秒内运行。
- **T6 复位中途被打断**：在第 5 步关掉窗口，然后运行 verify：先按标记退回，任务回到 InteractiveToken。
- **T7 快速启动**：关机再开机，不登录，≤ 20 分钟能执行。
- **T8 安全**：
  - Owner 会话改不了 launch 文件、`bin\`、任务；
  - 把 launch 文件路径上的某一级换成 junction（提权测试机）会被拒绝；
  - 真实任务被设成“最高权限”时，监督进程拒绝启动；
  - 开着 PowerShell Transcription 和 ScriptBlock 日志跑一遍复位，转录和事件日志里没有密码；
  - 伪造通知队列，不会引出任何“请输入凭据”的文字；
  - 在普通桌面上不会出现凭据框。
- **离线测试**：
  - `SupervisorPureTests.cs`：退避、launch 文件校验、重解析点、哈希不符、拒绝提权令牌、环境白名单；
  - `RegistrarPureTests.cs`：SID 不符时拒绝，输出只有码；
  - node 测试：通知队列的上限，结果码的映射；
  - `test-resident-windows.ps1`：任务 XML 回读和 SDDL；
  - `test-upgrade-windows.ps1`：钉住新通道对 companion 任务从不调用 `RegisterTaskDefinition`，回滚和 Recover 只写 launch 文件。

### 8. 实施估时

| 项 | 人日 |
|---|---|
| 监督进程（C#）与纯测试 | 1–1.5 |
| 注册小程序（CredUI 安全桌面、COM 注册）与测试 | 1 |
| 通知队列、`notifier-main.mjs` 与测试 | 1 |
| install、rearm（标记与提权核对）、verify、uninstall | 1.5 |
| 新升级通道（`upgrade-apply.ps1`、`machine.mjs` 的 companion 步骤）与测试 | 1 |
| 令牌自检、status 字段 | 0.5 |
| 独立审核与修复 | 1 |
| 合计开发 | 7–7.5 |
| 现场（整套重装 + T1–T8，含多次重启） | 每台约 1 天日历时间，DESK 先，TURING 后 |

### 9. 不在 M5 里做的

- **M5-b 专用账户**（方案 A）：
  - 收益：把 Agent 从常驻发行版的 root、companion 的 GitHub 凭据和 `mailbox\responses` 写权限中隔开；需要存的只是一个非管理员账户的密码。
  - 前提：Owner 决定收紧 `4fedfc84`，并接受 Linux 运维改用 `runas`。
- **gh 令牌范围**：现在用的是 Owner 的全范围令牌（`repo`、`workflow`）。建议另立任务，改为只限本仓库的细粒度令牌，只给 contents 读、statuses 写、actions 写、issues 写，由 Owner 决定。

### 10. 独立安全审核（r1 → r2）

审核员是 general-purpose 子代理，只拿到设计稿和代码路径，全程只读。下表是它的意见和这一版的处理。

| 级别 | 意见 | 处理 |
|---|---|---|
| BLOCKER | 升级器属于冻结通道。每次升级、回滚、Recover 都会按 InteractiveToken 重注册 companion 任务。r1 的“过渡包走自动升级”和“升级器不改任务”都做不到 | 接受。新增本文 §4.0：M5 改为整套重装，一并替换冻结通道里 companion 的步骤；装好之前禁止单独切换；删掉过渡包；本文 §5 改为 R 类流程 |
| MAJOR | 密码在普通桌面上输入，通知可伪造，构成钓鱼入口 | 接受。改用注册小程序 + `CREDUIWIN_SECURE_PROMPT` 安全桌面；通知文本不叫人输凭据；运行手册加规则；可选的可信路径策略由 Owner 决定 |
| MAJOR | `Get-Credential` 与 §8.5 的 `-NonInteractive` 冲突，PowerShell 字符串清不掉 | 接受。密码不再进 PowerShell，由 C# 小程序在非托管缓冲区里处理后清零；脚本保留 `-NonInteractive`；T8 检查转录 |
| MAJOR | 存下的是一个能还原的新秘密，“只有 SYSTEM 能读”不准确，经 SYSTEM 升级包或 UAC 绕过可以间接拿到 | 接受，如实改写本文 §3 和本文 §4.6，列为 Owner 决定项（本文 §5 第 1 步）；要求本机专用密码；Microsoft 账户节点拒绝；不接受就走 M5-b |
| MAJOR | 继承 Owner 的环境（`NODE_OPTIONS`）可以注入代码，“无法让它运行别的东西”不成立；验收信号是自报的 | 接受。环境改成白名单；改正措辞，并写明同用户注入在已接受边界之内；复位改由提权一侧 `OpenProcessToken` 实测 |
| MAJOR | Owner 有 FRFX，能反复 Run 来锁住账户；锁定的账没有和阈值比较 | 接受。SDDL 中 Owner 改为 FR；去掉 LogonTrigger；verify 同时比较阈值和窗口；T4 加连续 Run 的用例 |
| MAJOR | 复位中断会停在没验收过的状态，验收信号可伪造 | 接受。加管理员专用的待验收标记，verify 和下一次复位先退回；改由提权一侧核对；写明伪造的后果只影响可用性 |
| MINOR | 事实错误：`Run()` 在 `Invoke-RestartCompanion`；密码存在任务计划程序凭据库而不是 LSA 秘密；漏了 `owner\train-review` | 已改正（本文 §1、本文 §3、本文 §2） |
| MINOR | 升级器只等 30 秒，退避最长 60 秒 | 换代时立即启动；新通道等 90 秒 |
| MINOR | 缺 `0x8007052F`、`0x80070530` | 已补上 |
| MINOR | 密码过期，以及 TURING 账户 | verify 记 `PasswordExpires`；预检拒绝 Microsoft 账户 |
| MINOR | docker 是哪一个 | Q1 写明是发行版里的 `docker.service`，不是 Docker Desktop |
| MINOR | launch 文件要原子替换，junction 要逐级查 | 已写进本文 §4.2 |
| 建议 | 补安全验收 | 新增 T6、T8 |

### 11. 实施记录（分支 `claude/companion-headless-impl`；只在本地提交，未安装、未切换）

按本文 §4 和本文 §10 实施，另加 Owner 的追加决定：companion 改用只限本仓库的细粒度令牌，放在它自己的 gh 配置里。

**实现了什么**

- `windows/CompanionSupervisor.cs`（监督进程）、`windows/CompanionTaskRegistrar.cs`（安全桌面凭据框 + 经 vtable 调 `RegisterTaskDefinition`，另有只读的 `token-facts`、`vtable-selftest`）。两者只由安装编译进 `bin\`（`install-resident.ps1#Invoke-CompanionSupervisorCompile`），升级通道不重编、不替换。
- `windows/companion-headless.ps1`：共用函数（launch 文件、两个任务、锁定余量、待验收标记、提权一侧验收、切换流程）。`rearm-resident.ps1` 的 `-CompanionHeadless`、`-CompanionCredential`、`-CompanionInteractive` 和 `verify-resident.ps1` 从安装副本点载它；`install-resident.ps1`、`upgrade-apply.ps1` 各带一份同文副本，由 `test-companion-headless.ps1` 钉住。
- 安装新步骤：`companion-supervisor`、`companion-launch`、`notifier-task`、`companion-task`（InteractiveToken + 监督进程）。重装启动器最后一步 `Step-CompanionHeadless` 调已安装的 `rearm-resident.ps1 -CompanionHeadless`。
- 新升级通道：`RegisterCompanionTask` 换成 `WriteCompanionLaunch`（只写 launch 文件、重注册通知任务；任务定义不对只记 `COMPANION_TASK_NEEDS_OWNER`）；`RestartCompanion` 只结束 node 子进程和作业宿主，监督进程不在时由 SYSTEM `Run`，等 90 秒；Recover 同样只写 launch 文件。`upgrader/src/machine.mjs`、`windows-port.mjs` 相应改名。
- companion：`notify-queue.mjs`（6 处通知改为入队）、`notifier-main.mjs`（通知任务）、`companion-session.mjs`（拒绝提权令牌、专用 gh 登录失败关闭、给探针的会话事实）、`companion-presence.mjs`（首次心跳与 `companion-absent`）。
- `windows/companion-gh-login.ps1`（Owner 本人存入令牌、只读核对）、`windows/probe-companion-headless.ps1`（只读探针）、运维手册 `rollout/M5-COMPANION-HEADLESS-RUNBOOK.md`。

**与设计稿不同或补充的地方**

1. status 字段放在 `executor.companion.firstBeatAfterServiceStartMs`，不是顶层 `companion`：顶层多一个键会让旧代际的读者（回滚后的 companion）整份拒收。
2. verify 把 InteractiveToken 加监督进程的定义也算合格（安装后、退回后都是它），锁定余量只在密码模式下判不通过。否则一次退回之后，每次升级的 Verify 都会失败并回滚。
3. launch 文件比本文 §4.2 多三个固定键：`ghConfigDir`、`homeDir`、`pathDirs`，供监督进程设置 companion 专用的 `GH_CONFIG_DIR`、`HOME` 和 `PATH`。`HOME` 是因为 `build-bundle.ps1` 会删掉 git 的全部 `GIT_*` 变量，`home\.gitconfig` 只能经 `HOME` 生效。
4. launch 文件和目标文件的所有者接受 Administrators 或 SYSTEM：升级通道以 SYSTEM 写它。写权限只许 SYSTEM、Administrators、TrustedInstaller。
5. 原子替换用 `ReplaceFile`（`[IO.File]::Replace`），它保留被替换文件的 ACL；第一次创建用 `MoveFile`。
6. 代际记录的 `companionTaskArguments` 现在存的是 node.exe 之后的 companion 参数（由 launch 文件推出），回执的 `companionTaskAction` 是 `{ node.exe, 这串参数 }`。
7. 提权一侧验收里的“Linux 侧事实”取 `upgrade\mailbox\responses\version-facts.json` 在切换开始后被重写过（companion 启动即以 root 跑一次只读工具）。
8. 令牌直接写进专用目录的 `hosts.yml`，不用 `gh auth login`：gh 的凭据管理器条目按“主机 + 账号”区分，与 `GH_CONFIG_DIR` 无关，同一账号再登录会动到 Owner 和 Agent 共用的那一条。companion 只认 `github_pat_` 开头的令牌，读不到专用配置就不启动。
9. 只读探针不能自己开一个密码登录的会话（那要密码），所以后台那一半读 companion 在会话 0 里记下的 `companion-session.json`（boot_id、docker）和 `supervisor.json`（会话号）；切换前显示 `not-yet`。真正的现场核对是切换本身：8 分钟内不通过就自动退回。
10. 监督进程放开 node.exe 句柄的时机是子进程恢复运行之后；entry 和它导入的模块由 node 之后再读，真正保证它们不被换掉的是逐级核对过的管理员专用目录 ACL。

**实现后的独立审核（general-purpose 子代理，只拿到代码和设计稿，只读）**

| 级别 | 意见 | 处理 |
|---|---|---|
| BLOCKER | 验收的起点在凭据框之前，旧的交互实例在 Owner 输密码期间继续写心跳和 version-facts，新进程一出现就会被判通过 | 改正。起点改到旧实例结束、任务不再处于运行状态之后；心跳和 version-facts 必须晚于新 node 子进程自己的启动时间，子进程早于切换起点也不算 |
| MAJOR | 待验收标记只在提权 verify 或再次切换时才回退；验收中重启或脚本出错，未验收的密码任务会一直跑 | 改正。写标记的同时登记一次性的 SYSTEM 回退任务 `\Clued\CluedCIResidentCompanionFallback`（开机后 2 分钟、开始后第 16 分钟），由已安装的 `companion-headless-fallback.ps1` 回退超过 15 分钟的标记并删除自己；验收通过即删除 |
| MAJOR | 直接运行 rearm 时，注册小程序（.NET）会继承 HKCU\Environment 里的 `COR_ENABLE_PROFILING` 等变量，可被注入探查器截获密码 | 改正。注册小程序一律以清空后的固定环境启动（只有 SystemRoot、windir、SystemDrive、PATH）；预检发现这类变量（进程环境或 HKCU\Environment）就拒绝：`COMPANION_HEADLESS_INJECTION_VARIABLES` |
| MINOR | 升级通道的 Verify（SYSTEM）遇到过期标记会重注册 companion 任务 | 改正。SYSTEM 运行的 verify 不碰任务，只确认回退任务在；Owner 提权运行的 verify 仍按本文 §4.4 先退回 |
| MINOR | Stop 之后立即 Run，IgnoreNew 可能忽略这次 Run | 改正。Run 前等任务不再处于运行状态（至多 30 秒） |
| MINOR | 异常路径上含密码的 BSTR 未清零就释放 | 改正。`finally` 里按 `SysStringByteLen` 清零再释放 |
| MINOR | 白名单从任务环境带入 SystemRoot、ComSpec、PATHEXT 等，可被 HKCU 覆盖 | 改正。这几项改为固定值，另加 SystemDrive |
| MINOR | 剪贴板历史和云剪贴板里可能留有令牌 | 改正。脚本另调 WinRT 的 `ClearHistory()`；手册提醒云剪贴板 |
| MINOR | 专用 hosts.yml 运行中丢了令牌时，gh 会回落到共享凭据里 Owner 的令牌 | 改正。companion 每 2 分钟复查一次，不通过就退出，由监督进程重启，启动检查拒绝（失败关闭） |
| MINOR | 任务安全描述符的所有者没有钉死 | 部分处理。`Get-CompanionTaskFacts` 记下所有者（`sdOwner`）作为事实；是否能在注册时指定所有者要在真机上确认，列入 T8 |
| MINOR | 登录失败码不全；注册小程序漏了 `0x80070530` | 改正。补 `0x80070530`、`0x80070531`、`0x80070701`、`0x80070773` |
| MINOR | “账户不会被锁”说过头 | 改正手册措辞：任务本身不会锁账户；同用户的程序本来就能靠输错密码锁账户 |
| MINOR | 令牌作为参数传给 PowerShell 函数，模块日志可能记下 | 改正。令牌只交给 .NET 方法 |
| MINOR | 不提权 verify 遇到过期标记记为失败 | 保留（需要提权才能退回）；手册 T6 写明提权，或等回退任务 |
| 建议 | `BY_HANDLE_FILE_INFORMATION` 结构偏移、探针的 `writesAnything`、文件头注释 | 已改 |
| MINOR | 用户档案目录的正则不接受空格等字符 | 保留：与节点档案自己的校验（`Assert-NodeProfile` / `validateNodeProfile`）是同一条规则，两台节点（`C:\Users\Windows`、`C:\Users\17531`）都符合 |
| MINOR | `standby-install.test.mjs` 放宽了原来的 `\bgh\b` 禁止规则 | 理由：安装和 verify 现在要写出 gh 的安装目录和 companion 专用 gh 目录（launch 文件的 PATH、GH_CONFIG_DIR、HOME），这条测试原本防的是“安装时联网”，所以改为禁止运行 gh（gh 子命令、调用 gh 可执行文件），联网类调用的禁止规则不变 |
| 建议 | 密码在 RPC 缓冲区和任务计划程序服务一侧的副本无法清零 | 接受，属于固有残留 |
| 建议 | `suspiciousText` 容易绕过 | 接受：它只是减少误导，真正的规则是“只在安全桌面输入” |

**复核（同一审核员，第二轮，只读）**

| 级别 | 意见 | 处理 |
|---|---|---|
| MAJOR | 回退任务按“开始后第 16 分钟”触发，凭据框停留时间却没有上限：可能在切换进行中回退，之后留下没有标记也没有回退任务的未验收密码模式 | 改正。标记记下切换进程的 PID 和启动时刻；只有标记超过 15 分钟**而且**该进程已不在，才算“被放弃”并回退（回退任务、提权 verify、下一次切换都用同一规则）；另一个切换仍在进行时，新的切换拒绝（`COMPANION_HEADLESS_SWITCH_IN_PROGRESS`）；验收通过时删除标记不再因文件已不存在而报错 |
| MINOR | 先写标记后登记回退任务 | 改正：先登记回退任务，再写标记 |
| MINOR | 回退任务的时间触发器不重复，结果无处可查 | 改正：每 15 分钟重复；结果写入 `install\companion-headless-fallback.json` |
| MINOR | SYSTEM verify 只看回退任务是否存在 | 改正：还要求它的 LastTaskResult 为 0、运行中或从未运行 |
| MINOR | StartBoundary 依赖区域设置 | 改正：用 InvariantCulture |
| MINOR | `-CompanionInteractive` 和提权 verify 的回退路径没有先等任务停止 | 改正：统一用 `Invoke-CompanionStopAndFallback` |
| MINOR | 手册 T8 没写所有者检查；ClearHistory 会清空全部剪贴板历史 | 改正手册 |

**第三轮复核**：上一轮的 MAJOR 和 7 条 MINOR 确认已解决，没有新的 BLOCKER、MAJOR、MINOR。两条低优先级建议：

1. 切换进程在凭据框开着时被意外结束，回退之后 Owner 才输入密码，会留下没有标记的密码模式。已改：注册小程序在交出密码前核对标记仍在、标记里的 PID 就是它的父进程且启动时刻相同，否则拒绝（`PENDING_MARKER_*`）。
2. 不提权的 verify 读不到切换进程的启动时刻，进行中的切换会显示成“需要提权运行”。只影响显示，保留。
