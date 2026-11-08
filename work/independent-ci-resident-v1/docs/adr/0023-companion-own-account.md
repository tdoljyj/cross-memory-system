# ADR 0023：M5-b——companion 以专用的非管理员本地账户运行

- 状态：已实施（分支 `claude/m5b-companion-account`，本地提交，未推送、未安装）。只能随一次整套重装（R 类）装上（本文 §5）。独立审核：未做，合入前必须做一次（本文 §11）。
- 日期：2026-11-08
- Owner Decision：`085e7f75`（M5 暂停；“M5-b 另排整块做”）之后，Owner 2026-11-08 决定“现在就做”，方案为 M5-b 专用账户。关联 `df898128`（supervisor 降权，已被审查否决，本文不做）、`be883bf8`/`62922cfe`/`bd594042`（clued-runner 的批处理登录与保存密码任务）。
- 关联：[ADR 0022](0022-companion-headless-implementation.md) §3 方案 A、§9（本文是它的实施）；注册程序修复 `claude/companion-registrar-retry` `70e3b176c`（已合并进本分支）。
- 运维手册：[`../../rollout/M5-COMPANION-HEADLESS-RUNBOOK.md`](../../rollout/M5-COMPANION-HEADLESS-RUNBOOK.md) 第 9 节。

## 摘要

- **背景**：2026-11-08 07:00Z DESK 现场，M5（ADR 0022，B2）的密码任务已能注册并运行，但 Owner `DESK-W-591\Windows` 是管理员，非交互的密码登录拿到的是未经 UAC 过滤的完整令牌，supervisor 按设计拒绝（`SUPERVISOR_ELEVATED_TOKEN_REFUSED`）。降权方案被审查否决。剩下的路是 ADR 0022 §3 方案 A：companion 用一个**非管理员**账户运行。
- **决定**：
  1. 每台节点新建本地账户 `clued-companion`（不复用 clued-runner / clued-control，本文 §2）。
  2. 节点档案的 `ownerSid` / `ownerProfileDirectory` 改为这个账户的 SID 和档案目录（键名不变，本文 §3）。Owner 本人成为安装的 **operator**，记在 `install\companion-account.json`。
  3. 账户密码是随机的，**没有任何人输入、看到或知道**：注册程序每次切换生成一个新的，设到账户上，同一块内存交给任务计划程序，然后清零（本文 §4）。
  4. 常驻 WSL 发行版从 Owner 名下移到这个账户名下：先移动 `ext4.vhdx`（DESK 移到 `D:\clued-resident\wsl\CluedResident-Linux`，C: 回收约 61 GB；TURING 在 C: 内改名），再以该账户身份 `wsl --import-in-place`，最后删掉 Owner 名下的注册项（不用 `--unregister`，它会删文件）（本文 §6）。
  5. 冻结通道 `upgrade-apply.ps1`、`upgrader/src` 一个字节都不改；它们按节点档案工作，档案指向新账户之后，行为自然正确（本文 §7）。
- **Owner 要做的**：每台两次 UAC、**零次输密码**——步骤 P（建账户、存令牌，一次 UAC）和重装启动器（一次 UAC）；中间是 Agent 的打包和 Owner 以前就要做的 Linux A/B（本文 §8）。
- **代价**：桌面通知不再显示（本文 §10 第 1 项）；Owner 和 Agent 不再能直接进常驻发行版的 root，改用 `rearm-resident.ps1 -CompanionRootShell`（提权，一次 UAC，不要密码）；今后重装的 Linux A/B 也要经它运行。

## 1. 现场事实（2026-11-08，只读核对）

| 项 | DESK-W-591 | TURING |
|---|---|---|
| Owner | `Windows` …-1000，Administrators | `Chase` …-1001（档案 `C:\Users\17531`），Administrators |
| clued-runner | …-1005，非管理员；运行 runner 服务 `clued-ci-company-win-01`（执行 GitHub Actions 的 PR 作业）；`be883bf8` 给了 SeBatchLogonRight；`62922cfe`/`bd594042`：它名下有保存密码的维护任务 `\CluedCache-desk-w-591-windows-runner-caches` | …-1013，非管理员；运行 `clued-ci-home-win-01` |
| clued-control | …-1007 = 节点档案 `controllerSid`；运行 `clued-ci-company-win-02`（trusted-main 控制），能读 App 私钥和 ci-admission 令牌 | …-1015 = `controllerSid` |
| 其他非管理员账户 | CodexSandboxOffline/Online | CodexSandboxOffline/Online、Tdoljyj（…-1008） |
| `clued-companion` | 无 | 无 |
| 常驻发行版 | `CluedResident-Linux`，Owner 名下，`C:\Users\Windows\WSL\CluedResident-Linux\ext4.vhdx` 61.4 GB，DefaultUid 0 | `Ubuntu-24.04`，Owner 名下，`C:\Users\17531\AppData\Local\wsl\{7483e0fe-…}\ext4.vhdx` 239 GB，DefaultUid 1000；它也是 TURING 唯一的通用发行版 |
| Owner 名下其他发行版 | CluedCI-Linux（D:）、CluedDev-Linux（D:）、docker-desktop | docker-desktop |
| 磁盘 | C: 剩 46 GB（96%）；D: 剩 2.4 TB | C: 剩 12.8 GB；D: 剩 27 GB |
| 内存 / `.wslconfig` | 64 GB；28GB / 16 CPU / 8GB swap | 16 GB；6GB / 3 CPU / 2GB swap |
| WSL | 2.7.13 | — |

clued-runner、clued-control 名下的计划任务，非提权看不到（任务的 SDDL 不给 Owner 读）。步骤 P 的脚本在同一次提权里只读导出它们，写进日志（本文 §8 第 1 步），不再单独弹框。

## 2. 新建 `clued-companion`，不复用现有账户

- **clued-runner 不行**：它执行 GitHub Actions 的 PR 作业，作业代码来自仓库的分支。companion 如果用它，PR 作业就能拿到常驻发行版的 root、companion 的 GitHub 令牌和 `mailbox\responses` 的写权限，比今天（Owner 会话）还差。另外它名下的维护任务（`62922cfe`）存着它的密码，本文的随机密码每次切换都会改掉这个密码，维护任务就会登录失败。
- **clued-control 不行**：它是 trusted-main 控制账户，能读 App 私钥和 ci-admission 令牌；把 companion 并进去等于把出网的 companion 和这两把秘密放在一个身份里。Source v2 也要求 `ownerSid ≠ controllerSid`（`validateNodeProfile`）。
- **新账户的权限最小**：只在 Users 组；只有 SeBatchLogonRight（密码任务的批处理登录）；拒绝网络登录和远程桌面登录（`SeDenyNetworkLogonRight`、`SeDenyRemoteInteractiveLogonRight`）；不出现在登录界面；密码永不过期、账户自己不能改。保留本地交互登录权，只为 `-CompanionRootShell`（`CreateProcessWithLogonW` 是交互登录）。
- **对现有维护任务没有影响**：不碰 clued-runner、clued-control 的密码、组、权利和任务。

## 3. 节点档案：`ownerSid` 改指 companion 账户（键名不变）

- **为什么不加新键**（例如 `companionSid`）：
  - 冻结通道 `upgrade-apply.ps1` 的 `Assert-NodeProfile` 要求键集合**完全等于**现在的 9 个键，多一个键就拒绝。它不能改。
  - 冻结的 `upgrader/src/plan.mjs` 要求 `policy.companion.userSid === config.ownerSid`，`policy.mjs` 要求它等于 `node.ownerSid`。
  - Source v2 的 `NodeProfileV2` 同样是 9 个固定键，改它就要重新接受 Source。
- **为什么改 `ownerSid` 是对的**：Source v2 对这个字段的定义本来就是“companion、relay、incoming spool 的写入者所用的账户”（`prepare-record.mjs` 注释）；`FormalPublicBoundaryV2.WriterAllowed` 只允许 `ownerSid` 写 `formal-spool\incoming`，而这个目录正是 companion 经 WSL 的 DrvFs 写的，DrvFs 用的是发行版所属用户的令牌。所以 companion 换账户，`ownerSid` 就必须跟着换，否则 Source 会拒绝 incoming 的写入者。`reinstall/tools/node-inputs.py` 也把 `policy.companion.userSid` 注释为“the owner SID the companion runs as”。
- **Owner 本人放在哪**：安装的新参数 `-OperatorSid`（启动器配置的新键 `operatorSid`），安装写 `install\companion-account.json`（`clued.independent-ci.companion-account/1`：`companionSid`、`operatorSid`，管理员专用写）。读它的地方：`rearm-resident.ps1`、`request-upgrade.ps1`、`replace-heartbeat-token.ps1`（谁是 Owner）、`verify-resident.ps1`（核对账户）。没有这个文件的节点和今天完全一样（Owner = `ownerSid`）。
- **安装时的身份**：安装、启动器、Source 的 `migrate-acl.ps1 -Apply` 都要求“当前用户 = Owner 且提权”，现在核对 `-OperatorSid`（`migrate-acl.ps1` 的 `-OwnerSid` 参数只用于这个身份核对，ACL 模型里没有 `{OWNER}`）。Source v2 的 `ResidentScmV2.InstallTimeStableDigest` 只接受 LocalSystem 或提权的 `ownerSid`：安装在 M5-b 节点上改为经一次性 SYSTEM 任务运行 `SwapBroker.exe --stable-digest`（`Invoke-AsSystemOnce`，任务和输出目录用完即删；升级通道的 Compile 本来就以 SYSTEM 运行它）。

## 4. 密码：随机、无人知晓

- `CompanionTaskRegistrar.cs register-account`：核对账户是本机账户、已启用、**不在 Administrators**（含间接组）、不是调用者；核对待验收标记就是父进程的（与 ADR 0022 相同）；用 `RNGCryptoServiceProvider` 在非托管内存里生成 32 个字符（70 个字符的字母表，拒绝采样，四类字符都有，约 196 位）；`NetUserSetInfo` level 1003 设到账户上；同一块内存作为 `VARIANT(BSTR)` 交给 `RegisterTaskDefinition(…, TASK_LOGON_PASSWORD, …)`；清零。输出只有码。
- **取舍**（对比让 Owner 设一个密码并在安全桌面输入）：
  - 得：Owner 一次密码也不用输；没有人能把它用到别处；不会因输错或改密码而登录失败、锁账户；不会过期。
  - 失：没有 `runas`。Owner 进 root 改用 `-CompanionRootShell`：注册程序生成新随机密码，同时更新账户和 companion 任务（运行中的实例不受影响），再以该账户 `CreateProcessWithLogonW` 打开一个 `wsl.exe --distribution <D> --user root` 控制台。一次 UAC，不要密码。
  - 账户的 DPAPI 秘密会随管理员重设密码失效：companion 不用 DPAPI（令牌在 `hosts.yml`，git 经 gh 读它），所以没有影响。
- 管理员重设随机密码之后，任务计划程序存的就是这一个；以后任何时候（例如任务结果是登录失败码）都可以 `-CompanionCredential` 重做，同样不要密码。

## 5. 必须整套重装

- 节点档案变了 → `nodeProfileSha256` 变 → policy、record（`acceptance.json`）、升级代理配置的 `ownerSid` 全变。冻结通道发现 `policy.companion.userSid ≠ config.ownerSid` 或档案哈希不同就拒绝（`CHANNEL_CHANGE_NEEDS_REINSTALL`）。
- 常驻目录的 ACL 是安装时写的，升级通道不改 ACL。
- formal-spool 的 ACL 要跟着换（本文 §7）。
- 所以：照第 29 代的 R 类流程整套重装，配置复用 `D:\w\gen30-package\reinstall-config.desk-w-591.g30.json`（TURING：`C:\w\turing-gen30-package` 下的同名配置），只加 `operatorSid` 和 `companionAccount.wslVhdxDirectory`，并把 `config\node-profile.<node>.json` 的两项换成步骤 P 打印的值。

## 6. 发行版迁移

- 选择：**移动文件 + `wsl --import-in-place`**。
  - 不用 export/import：要打包解包 61 GB / 239 GB，TURING 没有空间，docker 镜像层还要重新解压。
  - 不用 `wsl --manage --move`：它只能改同一个用户名下的位置，不换用户。
  - 不用 `wsl --unregister`：它会删掉 vhdx。Owner 名下的注册项改为直接删 `HKCU\…\Lxss\{guid}`（删之前把它的值写进结果），文件已经在新位置。
- 顺序（`Invoke-CompanionAccountSwitch`，重装启动器最后一步，提权）：
  1. 预检（账户事实、它的档案就是节点档案的目录、它的 gh 配置在、目标路径形状），登记 SYSTEM 回退任务、写待验收标记；
  2. 停掉 companion 任务的实例；`wsl --terminate <D>`（只停这一个发行版），等 vhdx 能被独占打开；
  3. 移动：同一卷改名（TURING）；跨卷时边读边算 SHA-256 写到目标，再读一遍目标算 SHA-256，一致才删源文件（DESK，C: 回收在这一步）；目录和文件设保护的 ACL：SYSTEM、Administrators 完全控制，账户修改；
  4. 删 Owner 名下的注册项（`DefaultDistribution` 指向它时一并删）；
  5. 注册程序 `register-account`：随机密码、companion 任务，外加一次性任务 `\Clued\CluedCIResidentCompanionWslImport`（同一密码，`wsl.exe --import-in-place <D> "<vhdx>"`）；运行它一次，取结果，删除；
  6. 运行 companion 任务，8 分钟内由提权一侧验收（与 ADR 0022 相同：真实令牌是账户的、不提权、会话 0、心跳和 Linux 事实是新进程写的）；
  7. 通过：写 `install\companion-wsl.json`，删标记和回退任务。不通过：companion 任务退回该账户的交互定义（该账户从不交互登录，所以 companion 停着，服务只推迟，不烧任何 head），报告原因；发行版已经在新位置，重跑本步即可（文件和注册都按现状续做）。
- **WSL 虚拟机按用户分**：账户有自己的 WSL VM 和 `.wslconfig`（步骤 P 写，只在没有时写）。DESK 建议 16GB / 8 CPU / 4GB swap（Owner 的 VM 仍跑 CluedCI-Linux 和 CluedDev-Linux，28GB 上限；64 GB 内存够两者同时用），TURING 用 6GB / 3 CPU / 2GB（迁移之后 Owner 名下只剩 docker-desktop）。
- **TURING 的特殊情况**：`Ubuntu-24.04` 是 TURING 唯一的通用发行版，迁走之后 Owner 和 TURING 的 Agent 都不能再直接 `wsl` 进去（只能 `-CompanionRootShell`）。如果那里还有别的用途（家里 Linux runner 单元、日常开发），要先由 TURING 一侧只读确认，或者改为先建一个专用的常驻发行版（像 DESK 的 `CluedResident-Linux`，按 reinstall README 第 8c 节首装），这是另一块工作。D: 只剩 27 GB，TURING 的 vhdx 只能留在 C:，这次**不回收** TURING 的 C:。

## 7. 权限与冻结通道

- 常驻目录（`install-resident.ps1#Get-AclPlan`，`$OwnerSid` = 账户，`$OperatorSid` = Owner；没有账户时 `$op` 为空，计划与以前逐字相同，测试钉住）：

| 目录 | 账户 | Owner |
|---|---|---|
| `bundles`、`mailbox\responses`、`upgrade\mailbox\responses` | 修改 | 只读（以前是修改） |
| `inbox`、`requests` | 只新建 | 只新建 |
| `upgrade\inbox`、`owner\train-review` | 无 | 只新建 / 修改 |
| `secrets\heartbeat`（心跳令牌） | 只读 | 无（以前只读） |
| 其余 Owner 原来能读的目录 | 只读 | 只读 |
| `secrets`、`upgrader`、`broker*`、`helpers`、`stage` | 无 | 无 |

- formal-spool（不在常驻根目录下，单次安装建的；安装的 `companion-account` 步骤）：`incoming` 里 Owner 能写的显式条目移给账户（Source v2 只接受 `ownerSid` 写 incoming，留着 Owner 的写条目会被拒）；`outgoing` 上 Owner 的只读条目保留并复制给账户。
- 冻结通道（不改）：每次升级写 launch 文件时用 `node.ownerProfileDirectory`，于是 gh 配置和 HOME 指向账户档案，正是安装好的 supervisor 要的；核对任务时用 `node.ownerSid`，于是账户的密码任务被认作 `password` 模式；通知任务按 `node.ownerSid` 重注册，于是它属于账户、在账户登录时才运行——**永远不运行**（本文 §10 第 1 项）。
- supervisor 不改：账户不是管理员，密码登录拿到的就是 LUA 令牌，`SUPERVISOR_ELEVATED_TOKEN_REFUSED` 的逻辑原样保留。
- GitHub 令牌：`companion-gh-login.ps1 -Login -ProfileDirectory <账户档案> -AccountSid <账户 SID>`，提权运行，写进账户档案下的 `companion-gh\`，目录 ACL 只有 SYSTEM、Administrators 和账户。Owner 在 GitHub 页面复制令牌，脚本从剪贴板读，Agent 不运行、看不到。
- 收紧的边界（`4fedfc84`）：Owner 会话（含 Agent）不再是常驻发行版的 root，不能写 `mailbox\responses`、`bundles`，读不到心跳令牌和 companion 的 GitHub 令牌，也读不到 companion 的日志（`%LOCALAPPDATA%` 在账户档案里；要看就提权）。

## 8. Owner 的步骤（每台；DESK 先、TURING 后）

0. **决定**（Owner，一次）：接受本文（新账户、档案改指、随机密码、发行版迁移、TURING 的 §6 情况、§10 的缺口），写一条 Decision；批准两台的整套重装（R 类：Decision + Grant）。
1. **步骤 P（第一次 UAC，不输密码）**：先在 GitHub 生成 companion 的经典令牌（只勾 `repo`），点复制；然后在自己的提权窗口运行
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <包>\windows\prepare-companion-account.ps1 -LogDirectory <目录>`。
   它建账户（或只核对已有的）、授权、建档案、隐藏登录图标、写账户的 `.wslconfig`、把剪贴板里的令牌存进账户档案并 `-Check`，同时只读导出 clued-runner / clued-control / 新账户名下的计划任务、相关用户权利和 Owner 的 WSL 注册，全部写进一个日志。屏幕上和日志里没有令牌、没有密码。看到 `COMPANION_ACCOUNT_PREPARED` 即可关窗口。
2. **Agent**：读日志，把 `nodeProfile` 两项写进 `config\node-profile.<node>.json`，在重装配置里加 `operatorSid`（Owner 的 SID）和 `companionAccount.wslVhdxDirectory`，提交、走 CI 合入，`build.ps1 -Final` 打包，`rehearse.py` 预演，W1 暂停旧常驻。
3. **Linux A、B**（Owner，和以往一样以 root 在**自己名下**的发行版里运行，不需要 UAC）：迁移在最后一步才发生，所以这一步照旧。
4. **重装启动器（第二次 UAC，不输密码）**：最后一步是 `rearm-resident.ps1 -CompanionAccount -WslVhdxDirectory <dir>`，自动迁移发行版、注册任务、验收。结果在 `W\launch\terminal.json` 的 `companionHeadless.status`：`COMPANION_HEADLESS_QUALIFIED` 即完成。
5. **验收**：方便时重启一次，不登录（运维手册第 6 节 T1）。

## 9. 回滚

- 切换不通过：自动退回（本文 §6 第 7 步），companion 停着，节点由另一台接班（§41.6a）。修好原因后重跑 `rearm-resident.ps1 -CompanionAccount`（不带 `-WslVhdxDirectory` 也行，它从 `install\companion-wsl.json` 或现状续做）。
- 整体退回 Owner 账户运行：用改动前的节点档案再整套重装一次；发行版要先回到 Owner 名下：`-CompanionRootShell` 里 `shutdown` 之后，提权窗口里 Owner 自己 `wsl --import-in-place <D> <vhdx>`，再删账户名下的注册项（用账户身份，或删账户的 HKU 注册表项）。这是手工步骤，运维手册第 9.5 节写了命令。
- 账户本身：`net user clued-companion /delete`（提权）之前先确认没有任务用它；档案目录要手工删。

## 10. 已知缺口（列为后续任务）

1. **桌面通知不显示**：冻结通道把通知任务注册给 `node.ownerSid`（账户），账户从不交互登录。通知队列照常写（在账户档案里），远端信号（PR 提交状态、KooYomi 节点心跳）不受影响。修法要一个按当前代际找 `notifier-main.mjs` 的、Owner 名下的固定动作任务，并让 Owner 能读账户档案里的队列；下一次能改冻结通道的重装时做。
2. **今后的重装工具**：`rehearse.py` 的 linuxHost 探查和 Linux A/B 都以 Owner 身份 `wsl -d <D> -u root`。M5-b 之后要改为经 `-CompanionRootShell` 或一个以账户身份运行的只读任务。下一次重装之前要改。
3. **只读探针**：`probe-companion-headless.ps1` 读 companion 档案里的 `supervisor.json`、`companion-session.json`，M5-b 之后要提权运行。
4. **TURING**：§6 的通用发行版问题要先由 TURING 一侧确认。

## 11. 测试与审核

- 离线（`windows/test-companion-headless.ps1` 第 9 节，`RegistrarPureTests.cs` 的 M5-b 部分）：随机密码的字母表和拒绝采样均匀、四类字符；账户核对的码；导入任务的定义；`wsl` 迁移计划的全部分支、校验后才删源文件、从不 `--unregister`/`--shutdown`/export/import；账户切换的顺序；预检；verify 的账户核对；没有账户时 ACL 计划逐字不变、有账户时每个目录的归属；formal-spool 条目移交且幂等；启动器、rearm、request-upgrade、gh 登录的身份；步骤 P 的 `-Plan` 只读运行。所有新 P/Invoke 都由 `Marshal.Prelink` 实际绑定一遍。
- 需要真机的：运维手册第 9.6 节（T1–T8 的 M5-b 版本）。
- 独立审核：本分支还没有做。合入前要由没参与的审核员只读审一次注册程序的新模式、迁移函数和安装的 ACL/SYSTEM 步骤。
