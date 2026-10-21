# TURING 独立 CI 常驻执行机制 · 设计与草稿 v0.7（Source v2 与托管转发已离线实现，未安装）

- 日期：2026-10-21（UTC）
- KooYomi：项目 0597aa60；本工作 Task `79c32815`；Owner 决定 Decision `0d84ddbb`（四项选择）；父 Task `253d0382`。
- 修订历史：
  - v0.2：按第一次独立复审（FAIL：1 个 BLOCKER、7 个 MAJOR）逐项修正；
  - v0.3：按复核（FAIL：BLOCKER 清零，M1、M6、M7 还有残留）再修；
  - v0.4：按第三轮复核（FAIL：残留全部关闭，但修正本身引入 2 个 MAJOR，另有 1 个旧的代理 MAJOR）再修；
  - v0.5：按第四轮复核（FAIL：代理 MAJOR 只修了一半，隔离与 HALT 不是崩溃一致的）再修；
  - v0.6（2026-10-21）：P1 完成，Source v2（S1–S14）在分支 `claude/pr-a-s-core-20261021` 上离线实现并测试（§7.1）；按 Owner Decision `1b5d3687` 加入自动 attempt 2（§7.2）和 50 GB 归档提醒（§7.3），D2–D7 随之关闭（§15）。主机上还什么都没装，主机验证见 §13.2 P2。
  - v0.7（2026-10-21）：PR-A 集成，分支 `claude/pr-a-integration-20261021`。托管转发接进常驻执行器（免费分钟设计 S19–S22，§7.5）：第 1 段之后有上限地等托管提示，`20-plan-intent`，第 R 段（第 9 段），`25-plan`，只为 LOCAL_REQUIRED 的角色跑本地段。同时补上 v0.6 §7.4 列出的缺口：v2 发布者按 diff 并入转发改动、合并闸门的 v2 控制检查消费者、Linux 侧 Source v2 安装脚本、Source 闭包重算（§7.6）。转发默认关闭（`relay.enabled=false`），主机上仍然什么都没装。按复审要求，托管等待不阻塞：每个 tick 只判断一次，等待中暂停、STOP、HALT 和 Owner 请求照常生效，锁存活记录照常刷新，重启后从保存的 t0 继续（§7.5）。

  第五轮复核 **PASS**（没有剩余的 BLOCKER 或 MAJOR）。五轮对照见 §13.3–§13.7。
- 依据（只读）：
  - PR884 head 041eaadf 的 `work/actions-hosted-migration/independent-ci-v1/`。下文 `CI/` 指这个目录，`CID/` 指 `CI/src/control-install-delta-v2/`。
  - b24 的实际脚本：`%TEMP%\ccs-f14-b24\`、`b24\`、`ws-prep-b24\`、`lis-f11\`、`ar-b19\`。
  - 同组设计笔记：`ci-claim-decoupling-design.md`（claim 解耦）、`parallel-linux-roles-design.md`（并行）。
- 没碰的东西：`C:\ProgramData`、`/opt`、`/etc`、`/var/lib/clued-independent-ci`、`Temp\ci884-retry`、claim 842cf499 及其 write_set、任何服务，也没运行 WSL。草稿只在 `work/independent-ci-resident-v1/` 下新建文件。

---

## 0. 结论

1. **能做到每批 0 次 UAC、0 次 root，而且整体比现在更安全。** 今天每批要点 UAC，根本原因不在安全需要，而在两件事：
   - 每批的绑定包由 Agent 在用户可写的 `%TEMP%` 里手工生成；
   - 执行它的是 Owner 的完整管理员令牌。

   UAC 是唯一能拦住“被改过的包以管理员身份运行”的环节（§1.3）。常驻后：
   - 每批的包由已安装的可信代码从“已安装 Source + 只当数据的触发记录”确定性导出；
   - 执行身份降为最小权限的虚拟服务账户；
   - 唯一能改 runner 服务配置的，是一个只会做一件事的 SYSTEM 交换代理（§8.2）。
2. **Owner 的授权换成了三层，都无法从普通用户会话伪造**（Decision `0d84ddbb` 第 1 项）：
   - **安装时那一次 UAC**：钉住确切的 Source、常驻层和策略，这就是对这个 Source 的常设授权；换 Source 仍要 Owner 接受并重装。
   - **每批第 1 段的 KooYomi 实时准入**：claim、fence、write_set、head 上限；改到受保护路径还要对确切 head 的 `repo.protected_change` Grant，这个 Grant 只能来自 Owner 登录的页面或 Owner 的自动批准开关。
   - **急停**：任何人都能暂停，只有 Owner 能恢复；Owner 也可以在 KooYomi 撤销 ci-admission Binding，所有批次立即 fail closed。
3. **常驻有一个硬前提：claim 不能再钉在安装配置里。** 所以常驻和同组的 claim 解耦（A-strict）要合成**一个 Source v2**（§7）。
4. **人工步骤**（§12）：
   - 每批：0 次 UAC，0 次 root，0 次 5 分钟内写文件；
   - 干净失败：自动归档后继续；
   - 未知失败：HALT，Owner 用 UAC 发一个复位请求，由服务自己完成归档和解锁；
   - Source 变更：Owner 接受后，1 次 UAC 加 1 次 root。
5. **草稿状态**（v0.7，详见 §13.1）：
   - 常驻层：Node 单元测试 **107/107**、Python **15/15**、离线演练 **35/35**（新增一个月的免费分钟情形和等待中的急停）；
   - Source v2（`CI/`）：Node **137 通过 + 1 跳过**、Python **6/6**、PowerShell 离线用例 **35 个**（归档 13、ACL 迁移 12、bundle 10）、C# 纯逻辑 **88 条断言**；`scripts/ci/clued-work-admission.test.mjs` **97/97**；
   - 主机演练（§13.2 P2）还没开始，所以可安装性、ACL 掩码、unit 加固、真实的 SCM/WSL/Docker 路径，以及托管运行的 OIDC 声明值，都还没在真机上证明。
6. **托管转发（v0.7，§7.5）**：有免费分钟时，gitleaks 和 trivy 由第 R 段核验 GitHub 托管运行后以 App 5368905 发布同名检查，本地只跑 contract-placement 和三项 kooyumi 检查；分钟用完时自动回到全本地。转发随策略默认关闭，只有 Owner 改策略（一次 UAC）才打开。

---

## 1. 现状：每批要人做什么，为什么

### 1.1 一批的人工步骤（b24 的实际做法）

| # | 步骤 | 谁做 | 权限 | 依据 |
|---|---|---|---|---|
| R | rNN 修复安装：换 Source 叶子、重绑 8 个配置；归档上一批的助手 exe 和 `.bak`，否则下一批 CreateNew 冲突 | Agent 生成，Owner 运行 | **UAC** | `ccs-f14/derive-f14.py`、`repair-claim-config.ps1:99-131` |
| L | Linux 重绑或重装：claim、Source、工具链哈希一变就要 | Agent 生成，root 运行 | **root** | `lis-f11/RUN-ORDER.md` |
| B | 生成绑定包：每批复制上一批脚本，改字面量，重钉哈希，然后非作者复审 | Agent | 无 | `ccs-f14-b24/derive-b24.py` |
| W | ws-prep：Windows 非提权打 bundle，Linux root 建工作区 | Agent、root | **root** | `ws-prep-b24/` |
| U | 启动 launch-activation-bNN | Owner | **UAC** | `launch-activation-b24.ps1:32` |
| 8 | 第 8 段：5 分钟内续租 claim 并写 `native-queue-ready.json` | Agent | 无 | `CID/batch/run-batch.ps1:80` |
| F | 失败：UAC 停批次、UAC 盘点、root 盘点、`wsl --shutdown`、root 归档 Linux、UAC 归档 Windows | Owner、root | **2×UAC + root + WSL 重启** | `ar-b19/` |

### 1.2 为什么要提权

- **Windows**：所有特权步骤都以 Owner 账户（…-1001）的提权令牌运行。`FixedScm.cs:34` 写死要求 TURING、SID …-1001 和 Administrator。提权要做的事有：
  - 换 runner 服务 `actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02` 的 ImagePath，再换回来（`FixedScm.cs:121-127`）；
  - 启动、停止这个服务；
  - 建 `Global\` 互斥量和事件；
  - 写 ProgramData 里受保护的 Public 文件（`invoke-io.ps1:17-33`）。

  runner 服务本身以非管理员 `.\clued-control`（…-1015）在 Session 0 运行。App 私钥和 ci-admission token 只由它的 node 子进程读取。
- **Linux**：每一步都是 Windows 用 `wsl.exe --user root` 单独拉起的。`wsl --user root` 只需要 Owner SID，不需要 Windows 管理员（`relay-public.ps1:60`）。

### 1.3 UAC 今天真正在防什么

提权后的 `run-batch.ps1` 从 `%TEMP%\bNN\...` 读取并执行脚本，而且只校验它自己的哈希（`run-batch.ps1:55`）。能写用户目录的进程，只要在 UAC 之前换掉文件，就能拿到管理员执行。今天挡住它的只有“点之前看一眼哈希”。

常驻设计从结构上去掉这个风险：代码只从管理员专用目录加载，用户目录里的东西只当数据。

---

## 2. 目标与不变量（逐条对照见 §13）

- **I1 可信源码变更**仍需 Owner 接受并重装（UAC + root）。执行器每批开始前重算已安装 Source 与常驻层每个文件的哈希，有漂移就 HALT。
- **I2 每个作业最多执行一次**，绑定确切的 head、base 和 Source；claim 和 fence 在批次内不变：
  - 现有的作业身份、effect journal、bridge 防重放全部保留，而且 **effect journal 永远不会被归档走**（§6.4）；
  - 新增按 **head** 烧号：同一 (repo, head, Source, attempt) 一旦开始，不论 base、PR 号还是 claim 怎么变，永不再开始。
- **I3 fail closed，不自动重试**：
  - 执行器自己从不重跑；
  - 未准入的评估要有新的触发记录，受冷却期和独立的每日上限约束；
  - 未知失败锁住 HALT。
- **I4 PR 代码只当数据**：gitleaks、trivy、ws-prep 不执行 PR 内容。现有 contract-placement 会在加固容器里运行 PR 的测试（§14 R1），本设计不扩大这个范围。
- **I5 不读秘密**：常驻服务、交换代理、companion、三个 unit 都不读 App 私钥和 ci-admission token。结果签名密钥仍只由现有 worker 在签结果时读取。
- **I6 不新增付费**：全部在 TURING 本机运行。

---

## 3. 总体架构

### 3.1 主体与权限

| 主体 | 身份 / 会话 | 能做 | 不能做 |
|---|---|---|---|
| **Owner（安装者）** | Owner SID 提权，UAC | 安装、升级、卸载；向 `owner\` 目录写复位或恢复请求 | 每批不再出现；复位时也不移动任何文件 |
| **CluedCIResident 常驻执行器**（新） | `NT SERVICE\CluedCIResident` 虚拟账户，Session 0，非管理员 | 读已安装 Source；写自己的 state、work、outbox；向交换代理提请求；经 Source v2 的句柄工具归档 formal-spool | 对 runner 服务**没有任何权限**；读秘密；加载用户目录里的代码；联网 |
| **CluedCISwapBroker 交换代理**（新） | LocalSystem | 只做一件事：把 runner 的二进制路径在“原始”和“已安装、哈希在白名单里的通用助手”之间切换，带 nonce 启动一次，等它停止，再换回 | 改账户、启动类型、依赖、DACL；运行白名单以外的东西；杀进程 |
| **clued-control**（现有，不变） | `.\clued-control`，Session 0 | 跑阶段助手、读秘密，对 GitHub 和 KooYomi 做所有实时核验和发布 | — |
| **companion 伴随进程**（新） | Owner 本人的登录会话，计划任务，**不提权** | WSL 保活；用 Owner 自己的 git 凭据打 bundle；用现有 `relay-public.ps1` 搬运 bridge 记录；`systemctl start` 三个固定 unit；轮询 PR 生成触发记录 | 任何授权判断；任意命令（只有固定 argv）；写执行器的 state 和 owner 目录 |
| **Linux unit**（新） | WSL 内 root，systemd oneshot 模板，带沙箱加固 | worker（不变的 `linux-worker.mjs`）、ws-prep、归档；各自用 root 实测前提 | 由 PR 内容驱动执行代码 |

### 3.2 数据通道（全部 create-only，格式精确；`src/mailbox.mjs`、`src/inbox.mjs`）

```
Agent / companion 轮询器 ──写──▶ resident\inbox\            触发记录 {repo, pr, headSha, baseSha}（只是数据）
任何 Owner 会话进程     ──写──▶ resident\requests\          暂停请求（只能停）
提权的 Owner（UAC）     ──写──▶ resident\owner\             复位或恢复请求（只有 Administrators 能建文件）
常驻执行器              ──写──▶ resident\mailbox\requests\  给 companion 的固定种类请求
companion               ──写──▶ resident\mailbox\responses\ 回答 + 心跳（不可信，只用于分类）
常驻执行器              ──写──▶ resident\broker\requests\   给交换代理的请求 {stage, nonce, deadline}
交换代理                ──写──▶ resident\broker\responses\  交换结果
常驻执行器              ──写──▶ resident\outbox\<batchId>\descriptor.json  公开批次描述（companion 和 Linux unit 只读）
常驻执行器              ──写──▶ resident\state\             账本、head 烧号、HALT/PAUSE、哈希链回执（Owner 只读）
```

### 3.3 威胁模型（复审 M5 之后补充）

- **要防的**：Owner 用户会话里的任意进程，包括 Agent 和被利用的工具。它们必须做不到：
  - 拿到 Windows 管理员或 SYSTEM；
  - 读到 App 私钥或 ci-admission token；
  - 让常驻服务或交换代理在它们的目录之外写、删、改名；
  - 绕过某个门禁；
  - 让一个已开始过的 head 再次执行；
  - 伪造 Owner 的授权（复位、恢复、Grant）。
- **已接受的边界**（resident constraint 4fedfc84）：Owner、root、chase 是受信管理员。WSL root 能从 Owner 用户会话直接拿到（`wsl -u root`），所以 Linux 侧的一切事实，包括现有 worker 的结果签名，最多和 Owner 用户会话一样可信。本设计在这一层只保证两点：
  - 事实是 root 工具实测出来的，不是假设的；测不出来就当作失败（fail closed）；
  - companion 只原样转交 root 工具的输出，自己不产生证明值。

  后果：恶意的 Owner 用户会话可以谎报 Linux 静止。谎报的最坏结果是在 Linux 不干净时继续往下走，而下一批 ws-prep 的 root 预检会拒绝。这和今天的接受边界一致，不是新开的口子。

---

## 4. Owner 授权从 UAC 换成了什么

### 4.1 三层授权

1. **安装时**：Owner 在 UAC 下运行 `install-resident.ps1 -Apply -ExpectedPlanSha256 <审过的计划>`。
   - 钉住的内容：
     - Source 清单；
     - 常驻层清单；
     - `policy.json`：仓库、只对 main、六项检查、执行和评估两套限速、串行、禁止自动重试；
     - 两个服务宿主的哈希；
     - 交换代理的助手白名单。
   - 策略文件哈希写进服务启动参数，只有管理员能改。
   - KooYomi 里的接受 Decision 是 Agent 写的记录，单凭它证明不了 Owner 本人在场，所以接受仍然落在安装这一次 UAC 上。
   - `policy.validUntil` 可选：为空表示直到 Source 变更或卸载；设了就是复核期限，到期 HALT。
2. **每批**：第 1 段由 clued-control 用 ci-admission Binding 做完整的 Native 准入，和今天、和 GitHub 托管路径相同：
   - PR 是 open 的，head 和 base 正确；
   - claim 是 ACTIVE，fence 和 epoch 一致，不需要 lease_key，没有在交接中；
   - write_set 覆盖所有改动；
   - Task 的 CI 计量没超；
   - 受保护路径要有 `repo.protected_change` Grant，资源为 `repo:<owner>/<name>/<head>`。

   Grant 只能来自 Owner 登录的 KooYomi 页面，或 Owner 的自动批准开关（`20261013023000_owner_auto_approve_persistent_switch.sql`，main 上默认开启）。之后每段的 issue、每次回调、每次发布都照旧实时复验（A-strict）。
3. **急停、恢复与复位**：

   | 动作 | 谁能做 | 怎么做 |
   |---|---|---|
   | 暂停 | 任何 Owner 会话进程 | 往 `requests\` 写暂停请求；批次之间生效，从不中断正在跑的段 |
   | 恢复 | 只有提权的 Owner | `rearm-resident.ps1 -Request Resume -ExpectedPausedSha256 <审过的>`。脚本用纯 PowerShell 往 `owner\` 写一个带时间和 nonce 的请求，不启动任何其他程序；服务按比较交换执行 |
   | 复位（未知失败后） | 只有提权的 Owner | `rearm-resident.ps1 -Request Rearm -ExpectedHaltSha256 <审过的> -Reason …`，写法同上。服务实测两端静止，对**每一个还没归档的未知失败批次**只改名归档，再按比较交换清除 HALT |
   | 远程急停 | Owner | KooYomi 页面撤销 ci-admission Binding；重新启用要换 token（UAC） |
   | 卸载 | Owner | UAC |

   `owner\` 的授权来自目录 ACL：只有 Administrators 能建文件，服务只能读。每个请求都点名 Owner 审过的那份 HALT 或 PAUSE 的确切字节，过期或重放的请求比较交换失败。

   服务把已处理过的请求同时按文件名和字节摘要记下：
   - 按文件名记：旧请求在计数之前就被跳过，所以永远挤不掉新请求；
   - 按摘要记：同一份请求换个名字也不会处理两次。

   请求自带时间和 nonce，所以被拒后再发一次（哪怕理由相同）就是一个新请求。

### 4.2 谁能触发，怎样防伪造

触发记录只说“请看看 PR n 的 head h（base b）”。写 inbox 的是 Owner 会话里的进程。

| 攻击者能做的事 | 结果 |
|---|---|
| 写任意触发记录 | 格式精确、键不对就拒、每个 ≤1KB；只接受策略里的仓库；不携带路径、命令、claim 或包。最坏结果：对真实且已准入的 head 跑 CI（本来就会跑）；对未准入的 head 浪费一次约 45 秒的评估，受冷却期、单 head 每日上限和全局评估上限约束，**不占用执行额度** |
| 大量灌入 | 每次只读 N 个；按 (pr, head, base) 合并；先进先出；评估和执行各有每日上限 |
| 换 base 或 PR 号重放已执行的 head | 按 head 烧号，直接忽略（`HEAD_ALREADY_EXECUTED_NO_RETRY`） |
| 伪造 GitHub 或 KooYomi 事实、Owner Grant、扫描结果 | 做不到：clued-control 通过 TLS、用 App 私钥和 ci-admission token 实时获取；Grant 只来自 Owner 页面；结果有 Ed25519 签名 |
| 往 `owner\` 写复位或恢复请求 | 做不到：只有 Administrators 能建文件。写进 `requests\` 的恢复请求会被忽略（演练第 15 步） |
| 改已安装的代码或策略 | 做不到：目录只有管理员能写，每批重算哈希 |
| 在 spool 里放 junction 或硬链接，诱导归档移动别的文件 | 归档只碰精确白名单里的记录名，不递归；拒绝链接和多重硬链接；改名前后都核实父目录。主机上由 Source v2 基于句柄的工具执行，而且**从不提权运行**（§6.4，复审 X1） |
| 冒充 companion 乱答 | 见 §3.3：只能谎报 Linux 静止，后果被 root 预检挡住 |
| 让批次反复失败，以 HALT 拒绝服务 | 能做到，但方向是安全的 |

### 4.3 为什么不用 GitHub 审批

Agent 在这台机器上用的就是 Owner 的 GitHub 身份（resident constraint 22c20e14 的禁止条款），GitHub 上的批准证明不了是 Owner 本人。KooYomi 的 Owner Grant 只能来自 Owner 登录的页面（合同 §6.6）。

### 4.4 为什么没选每批 Grant（Decision `0d84ddbb` 第 1 项）

它需要服务端迁移、新的门禁 RPC 和生产发布；而且自动批准开着时，它退化成“多一条审计记录”。需要时可以作为附加层，接在第 1 段之后。

---

## 5. 一批的流程

```
companion 轮询（每 5 分钟，用 Owner 的 gh 登录）或 Agent ──▶ inbox 里的触发记录
执行器 tick（空闲每 15 秒一次）：
  崩溃恢复（每 tick 都做，HALT 时也做）：未终结的条目（包括“目录已建、记录没写”的） → FAILED_UNKNOWN、烧掉 head、HALT
      例外（v0.7）：只在等托管信号的批次（有 15-relay-wait、没有 20-plan-intent）什么都没在运行，不关，由 tick 继续
  处理 owner\ 里的复位 / 恢复请求
  HALT? → 停；处理暂停请求；处于 PAUSED → 停
  取最早的触发记录；预检（不联网、不读秘密）：
      head 是否已烧、冷却期、执行和评估上限、validUntil、Source 哈希、companion 心跳
  预留（00-reserved）→ 导出批次（Source v2 确定性导出）→ 写公开描述符
  companion 打 bundle（只用 Owner 的读凭据，不发布任何东西）
      失败 → 收尾 → 释放成 NOT_EXECUTED
  第 1 段 Native 准入（经交换代理，以 clued-control 身份运行）
      未准入 → 收尾 → 释放成 NOT_EXECUTED
      其他失败 → 烧掉 head
  10-started + head 烧号（只做转发的批次同样烧号）
  15-relay-wait（CreateNew：t0 和导出的批次）
  托管等待（v0.7，§7.5）：读 companion 最新的托管提示，按 hosted-wait.decide 有上限地等；转发关闭时不等。
      等待不阻塞：结论是 WAIT 时本 tick 返回 WAITING；之后每个 tick 先做崩溃恢复、Owner 请求、HALT、暂停，
      再从保存的 t0 重新判断。等待期间 tick 不取新触发，也不跑 attempt 2
  20-plan-intent（CreateNew：转发候选、本地角色及其原因）
  有候选时跑第 R 段（第 9 段，通用助手以 clued-control 运行转发入口）→ 每个候选 RELAYED 或 LOCAL_REQUIRED(原因)
      发布不确定或计划行不干净 → UNKNOWN → 烧号、HALT，这个批次此后不再为任何角色跑本地段
  25-plan（CreateNew：已转发的角色、要本地执行的角色）
  有本地 Linux 角色时，companion 启动 clued-ci-wsprep@<batchId>（root 预检、fsck --strict、建工作区）
  只为 LOCAL_REQUIRED 的角色跑执行段和发布段（每段：node invoke-stage.mjs → 交换代理 → 通用助手 → 一个阶段事实，S1/S11/S12）：
      第一个本地 Linux 段之前，companion 运行 build-bundle.ps1 -CheckRefs：bundle 之后有推送 → 干净的暂时性失败（§7.2）
      后面的本地 Linux 段（只可能是第 4、6 段）之前，两端先做角色间归档（只移协议记录，和今天 run-batch.ps1:81 的语义一致）
      Linux 段：companion 泵 issue → worker unit → challenge/response → result（逻辑同 run-batch.ps1:86-89）
  本地角色跑完后再读一次提示：托管运行这时才成功的，只记 relay-late-ignored
  第 8 段：控制助手自己轮询 Native 合并队列，直到 claim 成为队首或超出窗口（§10.2）
  收尾：两端只改名归档最后一个角色的协议记录 → 90-terminal COMPLETED → 回执
  干净失败且满足 §7.2（暂时性码、第 1 或 2 段、attempt 1）→ 记下 attempt 2 意图；延迟到期后它先于新触发运行
  批次之间：最多每小时量一次归档大小，超过 50 GB 写提醒回执（§7.3）
```

---

## 6. 一次性、锁、失败、归档、HALT 与复位

### 6.1 一次性

- **账本**（`src/ledger.mjs`）：
  - `state\ledger\<key>\` 下依次是 `00-reserved`、`10-started`、`90-terminal`，每个文件 CreateNew，从不改写；
  - `key` 由 repo、PR、head、base、Source、attempt 算出。
- **按 head 烧号**：`10-started` 之前先 CreateNew `state\ledger-heads\<headKey>.json`；`headKey` 只由 repo、head、Source、attempt 算出。第 1 段的任何失败（未准入除外），以及所有未知失败，也会烧掉 head。
- **原有防护全部保留**：作业身份、effect journal（`not_sent`、`uncertain`、`revoked` 都是终态）、bridge 的 issueId、nonce、回调窗口（Source v2 起 120 秒，见 S7）、签名结果。effect journal（`<64hex>.json`、`observations.jsonl`）不在归档白名单里，所以跨批次仍在原处，“只发布一次”跨批次成立（演练第 19 步）。
- **attempt 默认是 1**。attempt 2 只有一种来源：§7.2 的自动 attempt 2（Owner Decision `1b5d3687`），每个 head 最多一次，没有 attempt 3。attempt 是作业身份、批次键和 head 键的一部分，所以 attempt 2 的作业 id 与 attempt 1 的完全不同；attempt 1 已结算的作业 id 永远不会再跑。

### 6.2 锁

- **执行器单实例锁**（`src/instance-lock.mjs`）：
  - 目录原子创建，持有者每 tick 刷新一次存活记录；
  - pid 已不在：锁改名保留，交给崩溃恢复判断；
  - pid 还在而且存活记录新鲜：拒绝启动；
  - pid 还在但存活记录过期（pid 复用或挂起）：拒绝启动，交给 Owner 查看；
  - 服务停止从不杀进程：宿主只写 `STOP-REQUESTED`，执行器在批次之间退出。
- **串行**：`maxConcurrent` 只能是 1；交换代理有自己的全局互斥量；Linux `formal-role.lock` 不变；Linux guard 要求同时只有一个 clued-ci unit 活动。
- **companion**：有子进程超时未退时进入 busy，不接新请求，也不发心跳。

### 6.3 失败分类（`src/classify.mjs`，白名单，Decision `0d84ddbb` 第 4 项）

清理证明在**失败发生时从两端现取**（`executor.proofFor`），不沿用阶段的自报，也不默认为真：

- **Windows（引擎）**：
  - `sc.exe` 回读：原始二进制、Manual、STOPPED、pid 0、账户仍是 clued-control；
  - 阶段自己的进程树事实；
  - 本服务没有仍在运行的子进程。
- **Linux（root 工具，原样转交）**：
  - 所有 clued-ci unit 都是 inactive；
  - 每个 unit 的 cgroup `cgroup.events` 为 `populated 0`。只认 cgroup v2，读不到就算不静止；
  - 带 nonce 标签的容器（`docker ps -a`）全部是 exited 或 dead；
  - 没有进程的命令行包含 worker 或 run 目录。

分类结果：

- **NOT_ADMITTED**：只在第 1 段，并且 Windows 证明齐全。释放键，不烧 head。
- **CLEAN**：白名单里的失败码，并且两端证明都齐全。两端只改名归档，记 FAILED_CLEAN，烧掉 head，继续处理别的 PR。其中“干净的暂时性”码（`TRANSIENT_CODES`）在满足 §7.2 的条件时排一次 attempt 2。
- **UNKNOWN**：其余全部。记 FAILED_UNKNOWN，烧掉 head，写 HALT，不动现场。

Source v2（S11）之后，阶段的失败码来自已安装 Source 的稳定目录 `CI/src/resident-v2/stage-fact.mjs`：交换代理的回复（SYSTEM）、通用助手的原生回执（clued-control）和 node 入口的结局记录（clued-control，回执里有它的哈希）三者合成一个码。常驻层的 `classify.mjs` 逐项镜像这份目录，测试保证两边完全一致（`test/attempts.test.mjs`）：

| 类别 | 码 |
|---|---|
| 未准入（只在第 1 段） | `NATIVE_NOT_ADMITTED`、`OWNER_REVIEW_REQUIRED`、`PROTECTED_CHANGE_NOT_UP_TO_DATE`、`PATHS_OUTSIDE_WRITE_SET`、`CLAIM_NOT_CURRENT`、`TASK_CI_HEAD_CAP_REACHED`、`CLAIM_HEAD_CAP_REACHED`、`CI_BUDGET_EXHAUSTED`、`WORKFLOW_CHANGE_NOT_AUTHORIZED`、`PR_NOT_OPEN_OR_CHANGED` |
| 干净、暂时性 | `NATIVE_ADMISSION_UNAVAILABLE`、`GITHUB_TRANSIENT_UNAVAILABLE`、`BRIDGE_TRANSPORT_TIMEOUT`、`REMOTE_REFS_CHANGED_SINCE_BUNDLE`、`ARCHIVE_PRECONDITION_NOT_MET` |
| 干净、终局 | `STAGE_PACKAGE_REFUSED`、`STAGE_INPUT_RESULT_MISSING`、`BROKER_RUNNER_NOT_ORIGINAL_STOPPED`、`BROKER_REQUEST_EXPIRED`、`BROKER_REQUEST_REFUSED`、`STAGE_HELPER_PREFLIGHT_REFUSED`、`STAGE_CHILD_REFUSED`、`STAGE_CHILD_TIMEOUT`、`RESIDENT_QUEUE_HEAD_NOT_REACHED`、`BATCH_CLAIM_CHANGED`、`NATIVE_POLICY_UNSUPPORTED`、`PUBLICATION_BLOCKED`、`PUBLICATION_REVOKED`、`EVIDENCE_REFUSED`、`WORKSPACE_PREPARATION_REFUSED` |
| 永远未知 | `BROKER_RESPONSE_UNCONFIRMED`、`STAGE_HELPER_NOT_STOPPED_IN_TIME`、`STAGE_ORIGINAL_NOT_RESTORED`、`BROKER_CONFIGURATION_CONFLICT`、`NATIVE_RECEIPT_UNCONFIRMED`、`STAGE_CHILD_TREE_UNCONFIRMED`、`STAGE_OUTCOME_MISSING`、`PUBLICATION_UNCERTAIN`、`RECONCILIATION_REQUIRED`、`EVIDENCE_IDENTITY_CONFLICT`、`ADMISSION_CONFIGURATION_REFUSED`、`BROKER_UNCONFIRMED`、`BROKER_BUSY` |
| 第 R 段（v0.7） | 干净、终局：`RELAY_STAGE_REFUSED`（转发入口在观察和写入之前拒绝，或第 R 段的包导出被拒）；永远未知：`RELAY_PUBLICATION_UNCERTAIN`、`ROLE_ALREADY_PUBLISHED_ON_HEAD`、`RELAY_PLAN_UNCONFIRMED`。崩溃恢复时，有 `20-plan-intent` 而没有 `25-plan` 的条目以 `RELAY_STAGE_INTERRUPTED` 关闭并 HALT |
| PR-A 复审（v0.7） | 本地发布被 K 拒绝（`role_already_published_on_head`）在任何段都映射为 `ROLE_ALREADY_PUBLISHED_ON_HEAD`（未知）。发布者对没有码的异常给出的默认原因（`publication_operation_unconfirmed`、`*_OPERATION_UNCONFIRMED`）不再算暂时性，只有明确的传输事实才映射为 `GITHUB_TRANSIENT_UNAVAILABLE` 或 `NATIVE_ADMISSION_UNAVAILABLE`。refs 闸门没有明确答复时是 `REFS_GATE_UNCONFIRMED`（干净、终局，常驻侧码）；Windows 段成功而 companion 没确认泵时，只接受固定的泵码（`engine-windows.mjs#PUMP_CODES`，都不是暂时性码），其余一律 `COMPANION_PUMP_UNCONFIRMED`（未知） |

`BROKER_BUSY` 是未知：另一个控制工具持有变更互斥量，这是 Owner 必须看到的意外并发。结局记录缺失、或者回执与结局对不上，一律 `STAGE_OUTCOME_MISSING`。

### 6.4 归档（只改名，不删除；复审 X1）

- **只碰白名单**：bridge 定义的记录对，加上 `outgoing/active.lock`：
  - Windows 侧：`incoming` 下是 result 和 challenge-NN，`outgoing` 下是 issue、response-NN、active.lock；
  - Linux 侧是镜像。

  不遍历目录，所以 `incoming\` 下植入的 junction 永远不会被跟进；每个叶子必须是单链接的普通文件，大小有上限；改名前后都核实两个父目录是真目录、真实路径没被重定向，并重算哈希（`src/archive.mjs`；植入 junction、硬链接、父目录被替换三种情况都有测试）。
- **Windows formal-spool 在主机上**由 Source v2 的 `resident-v2/archive-windows-spool.ps1` 执行。它沿用现有已审的 `VerifyInstallFiles.HoldMetadata/ExactPath` 句柄做法（`advance-functions.ps1:41-51`），持有父目录句柄，所以目录无法被替换。`archive.mjs` 是这份白名单的参考实现和离线实现。**归档代码从不以提权身份运行**：复位时提权的那一步只写一个请求文件。
- **Linux**（`clued-ci-archive@<batchId>_<reason>`）：
  - root 先自己证明静止；
  - `between-roles-N` 只移协议记录；其他原因还会移 `formal-role.lock`、所有 `runs/*`、本批工作区和 ws-prep 目录；
  - 移动用 `renameat2(RENAME_NOREPLACE)`；
  - 每个实例名对应一个 create-only 的状态文件，同一实例跑第二次直接返回上次的结果；
  - 要移哪些工作区，由描述符的**内容**重算作业 id（与 `prepare-workspaces.py` 同一公式），描述符自带的 `linuxJobIds` 只用来比对，不一致就拒绝；描述符用一个 `O_NOFOLLOW` 句柄读，长度取自这个句柄（MINOR-8）；
  - Source v2（S14，教训 b22/b28）：目标是归档目录里的**扁平名字**（`incoming-<叶子>`、`outgoing-<叶子>`、`run-<名字>`、`workspace-<作业 id>`、`ws-prep-<批次>`、`formal-role.lock`），不再建 `runs/`、`workspaces/` 子目录（`runs/` 前缀把 b28 弄坏过）；“完成型”范围（`between-roles-N`、`success-close`）遇到未知叶子、半对记录或还被持有的 `formal-role.lock` 时一个都不移，原样留给失败路径；失败范围照原样归档并报告留在原处的东西；目录树移动前清点、移动后核对；中途失败写持久的 partial 状态（`verified: false`），不会是“没有状态”。
- **目录名**：失败用 `failed-<key12>-<reason>-<12hex>`，收尾和角色间用 `archive-…`，都必须是新目录。

### 6.5 HALT 与复位

- HALT 只升不降。
- 复位由**服务自己执行**：
  1. Owner 先不提权地查看。`rearm-resident.ps1` 不带参数时拒绝在提权状态下运行，所以它启动的 node 从不持有管理员令牌。能看到 HALT 内容和哈希、该批次账本、回执链头。
  2. 然后提权写复位请求，纯 PowerShell，不启动其他程序。
  3. 服务实测两端静止，对**所有还没归档的 FAILED_UNKNOWN 条目**逐一归档（不论 HALT 来自某个阶段、崩溃恢复还是循环异常），每个都标记 `95-archived`；然后按比较交换清除 HALT。HALT 文件改名进 `state\halts\`，旁边记下谁、何时、为什么。

  可以重复执行：
  - Windows 工具第二次运行找不到东西可移；
  - Linux 同一实例第二次运行直接返回上次的已核实结果（复核 M6d）。

  静止证明不成立，或摘要过期，复位被拒绝并留下回执（演练第 11 步）。
- 账本条目的**内容**无法读取（写到一半、不是合法 JSON、类型不对、多了硬链接）时，标为 UNREADABLE。其他 I/O 错误（文件被占用、权限、磁盘）视为暂时性错误，直接抛出，下一 tick 重试，所以绝不会因为暂时性错误隔离一个正常的条目。恢复时：
  - 能关闭就关闭；
  - 关不掉就原样移到 `ledger-quarantine\`。移动之前，先用还能解析的预留记录把 head 烧掉。

  被隔离的条目仍在复位的视野内：它的现场归档之前，HALT 清不掉（`REARM_REQUIRES_QUARANTINE_ARCHIVED`）。

  恢复本身失败时，先锁 HALT，仍处理 Owner 的请求。HALT 写不进去的话，这一 tick 也不会执行任何候选（复核 M6e，第三轮复核 MAJOR 2）。
- **崩溃一致性**（第四轮复核 N1）：
  - 先锁 HALT，再写任何终态或隔离记录（恢复路径和未知失败路径都是如此）；
  - 隔离时先写标记，再移动目录；
  - 复位的视野包括每一个隔离目录和每一个标记：缺了一半、内容损坏的都算“未归档”，批次 id 用这次隔离自己的 nonce 生成一个唯一替身；
  - **持续闸门**：只要还有一个未归档的未知失败或隔离现场，执行器就保持 HALT（HALT.json 丢了会重新锁上），`clearHalt` 也会拒绝；
  - HALT.json 本身损坏时仍算 HALT，摘要按原始字节计算，Owner 可以照常复位。
- 复位归档用固定原因 `rearm-unknown-failure`（隔离条目用 `rearm-quarantine`），不从失败码推导。只有恰好是 `between-roles-4` 或 `between-roles-6` 才是“只移协议记录”，其他原因一律归档整个批次现场（第三轮复核 MAJOR 1）。
- 复位不会重跑出事的 head。
- 崩溃恢复每个 tick 都先做，所以 HALT 时遗留的未终结条目会被先关掉，复位不会被卡住（复审 M6）。
- 回执链每次追加都从最后一个文件重新取链头，其他进程追加也不会让链分叉或卡住。

---

## 7. 对现有 Source 的必要改动（Source v2）

下列改动都在 `CI/` 里。v0.5 时它们属于 claim 842cf499 的 write_set；v0.6 已在新分支上、用新的 claim 实现（§7.1）。与 claim 解耦 A-strict 合成了一个版本。

| 编号 | 改动 | 位置 | 原因 |
|---|---|---|---|
| S1 | **交换代理取代“提权 Owner 改服务配置”**：`FixedScm` 的换二进制、启动一次、还原，移进 `CluedCISwapBroker`（草稿 `windows/SwapBroker.cs`）。常驻账户对 runner 服务零权限；PID 握手在代理与助手之间完成 | `FixedScm.cs`、`ScmPidHandshake.cs`、`invoke-control.ps1` | 复审 M2：把改配置权委派给常驻账户就等于 SYSTEM |
| S2 | 互斥量和事件的 DACL 改为代理 SID（SYSTEM）和常驻 SID | `FixedScm.cs:36-51`、`ScmPidHandshake.cs:17-34` | 同上 |
| S3 | Public 文件的精确 ACL 模型加入常驻 SID；ProgramData ACL 迁移工具 `resident-v2/migrate-acl.ps1`（安装时调用） | `invoke-io.ps1:17-33`、`formal-spool-acl.ps1` | 常驻账户要写 spool 和 state |
| S4 | 参数化导出 `resident-v2/derive-batch.mjs`：把 derive-bNN、bind、glue、prepare-payload、derive-fixed-batch 收进可复审的代码；输入只有已安装 Source、安装记录和触发记录 | `CID/prepare-payload.mjs`、`derive-fixed-batch.ps1` | 去掉手工生成和每批复审 |
| S5 | 接受窗口不再 ≤24h、≤claim 截止，改为跟安装走（或用 `validUntil`） | `prepare-payload.mjs:45`、`invoke-functions.ps1:41-46`、`FormalPublicBoundary.cs:121`、`run-batch.ps1:79` | 否则每天都要 UAC |
| S6 | claim 解耦 A-strict：作业身份去掉 claim，实时解析，批次内不变；Linux 角色策略和 qualification 去掉 currentClaim | 同组设计 §5 | 换 claim 不再重装 |
| S7 | bridge 泵移到 companion，协议和记录不变 | `run-batch.ps1:86-89` → `src/companion.mjs` | 服务账户看不到 WSL |
| S8 | 第 8 段：控制助手内部轮询 Native 合并队列，上限为 min(合并位 45 分钟, claim, 接受)；删掉 5 分钟 marker | `run-batch.ps1:80`、`independent-control-checks-v1/startup.mjs`、`stages.json` | §10.2 |
| S9 | ws-prep 参数化：`resident-v2/prepare-workspaces.py --batch <id>` 读公开描述符，按内容重算作业 id；`build-bundle.ps1 -BatchId` | `ws-prep-b24/` | 每批不再生成脚本 |
| S10 | Linux worker 的 node 路径与 qualification 的 `nodeExecutable` 对齐 | `run-batch.ps1:87`、`qualification.mjs:72` | Linux 调研发现两者不一致 |
| S11 | stage fact 带稳定的 `failure_code`，补齐 classify 白名单 | `invoke-control.ps1:55-73` | 区分干净与未知 |
| S12 | **通用助手**：8 个阶段助手不再每批用编译期常量 `ExpectedConfigSha256` 重编译，改为一次安装、哈希进交换代理白名单。代理请求带 `configSha256`，作为第二个启动参数传给助手，由助手自己核对公开输入；助手只从 `source\<sha>` 加载代码 | `derive-fixed-batch.ps1:29-32`、`FormalPublicBoundary.cs:34` | S1 的前提；去掉每批 rNN 归档助手 |
| S13 | **effect journal 搬离 spool**：搬到 `state\effects`（或保持原位但写进归档白名单的排除说明），任何归档都不得移动它 | `formal-work-admission-check-v1/publisher.mjs:150`、`independent-control-checks-v1/publisher.mjs` | 复审 M4：“只发布一次”要跨批次成立 |
| S14 | **基于句柄的 spool 归档工具** `resident-v2/archive-windows-spool.ps1`：白名单与 `src/archive.mjs` 一致，复用 `Archive-WindowsProtocol` 的句柄原语，支持 `between-roles-N`、`success-close` 和失败原因 | `advance-functions.ps1:41-51` | 复审 X1 |

### 7.1 S1–S14 的实现（P1，离线完成，分支 `claude/pr-a-s-core-20261021`）

`CI/` 下的路径省略前缀；`R/` 指 `work/independent-ci-resident-v1/`。v1 的文件一个都没改，v2 全部是新文件（`staged-check-publisher-v2.mjs` 是 `staged-check-publisher.mjs` 的副本加上列出的改动，两者可以按 diff 对齐）。

| 编号 | 变成了什么 | 位置 |
|---|---|---|
| S1 | SYSTEM 交换代理：请求只有 5 个字段（`swap-broker-request/2`），助手路径固定、哈希钉在 `config\broker.json`（`swap-broker-config/1`，哈希是代理的第二个启动参数）；领取标记、早于启动的请求不执行、停在助手上的 runner 换回原始二进制；忙时不碰任何状态 | `R/windows/SwapBroker.cs`、`src/resident-v2/windows/ResidentScmV2.cs`、`ScmPidHandshakeV2.cs`、`src/resident-v2/broker-protocol.mjs` |
| S2 | PID ACK 事件归 SYSTEM；代理沿用 v1 的变更互斥量（同名、同 DACL：SY、BA、Owner），所以和 v1 控制工具互斥。常驻账户从不打开互斥量或事件，所以不需要给它 ACE（这一点与 v0.5 的表述不同） | 同上 |
| S3 | ACL 模型 `acl-model.json` 只追加 ACE（spool 本层 `0x1200a5`，incoming/outgoing 本层 `0x1200e1` 加文件只读 `0x120089`），新建 `state\v2\*`；`migrate-acl.ps1` 只写 DACL、CAS、可重复；bridge v4 的 `formal-spool-acl.ps1` 只放行这些精确掩码；b22 的 ACL 判据（文件 id、所有者、排序后的允许 ACE 集合不变）移植进归档工具 | `src/resident-v2/acl-model.json`、`migrate-acl.ps1`、`worker/protected-job-bridge-v4/formal-spool-acl.ps1` |
| S4 | 确定性导出：输入只有已安装的免 claim 安装记录和触发主体，输出 8 个密封阶段包（计划、作业、阶段行、工作清单），同输入同字节；`source-closure.json` 是算出来的 Source 闭包（有测试重算） | `src/resident-v2/derive-batch.mjs`、`prepare-record.mjs`、`record.mjs`、`stage-package.mjs`、`source-closure.mjs` |
| S5 | 安装记录不带 claim、PR 或作业；`validUntil` 为空表示直到 Source 变更或卸载；没有 24 小时或 claim 截止上限；Linux qualification v2 的 `expiresAt` 也可以为空（绑定到 Source） | `prepare-record.mjs`、`record.mjs`、`worker/qualification-v2.mjs` |
| S6 | 作业契约 `job/2`：id = sha256(["clued.independent-ci.job/2", repo, pr, head, base, sourceManifestSha256, role, attempt])，没有 claim；完整准入 `full-admission/2` 从 PR trailer 实时解析 claim；第 1 段以“只能新建”的方式记下批次 claim 代次（claimId、fence、epoch），之后每个阶段、每次 bridge 回调都必须是同一代次（续租只改 `expires_at`，算同一代次）；Linux 角色策略 v3 和 qualification v2 没有 currentClaim | `src/job-v2.mjs`、`full-admission-v2.mjs`、`admission-facts-v2.mjs`、`batch-claim-v2.mjs`、`worker/formal-fixed-role-policy-v3/`、`formal-gitleaks-v4/`、`formal-trivy-v4/`、`formal-contract-placement-v2/`、`worker-v2.mjs` |
| S7 | bridge v4：协议 `/2`、签名结果 `/2`、新增干净的 `blocked` 记录（Linux 在扫描器碰到 PR 之前干净结束时发出（含 trivy 缓存准备的干净拒绝：缓存容器只挂缓存目录，快照已删；这类干净拒绝是终局，不自动重试），Windows 发行方据此干净结束，不再等到截止）；一轮回调的窗口 120 秒（`protocol.mjs` `CALLBACK_WINDOW_MS`；30 秒在 TURING 上实测不够：PR #889 第 2 阶段一轮 34 秒、约 47 秒，Owner 决定 dd7378d2）；发行方的回复若已过本轮截止就不再回复、等 Linux 的 `blocked` 干净结束，不再 UNCERTAIN；Windows 归档白名单含 `incoming\blocked`；发行方是一个 v2 阶段入口；relay 从已安装的 `resident\source\<sha>` 副本运行；companion 先用一次 root `ls`（约 0.15 秒）看 Linux 哪条记录就绪，再调 relay（每次约 5 秒），先收 challenge、再收 result、再收 blocked；一轮回调失败后把 Linux 的 `blocked` 交给发行方一次 | `worker/protected-job-bridge-v4/*`、`R/src/companion.mjs` |
| S8 | 控制助手每 30 秒只读核一次合并队列，窗口 = min(合并位 45 分钟, claim, validUntil, 阶段上限减 7 分钟)，满足就发一对检查，否则 `RESIDENT_QUEUE_HEAD_NOT_REACHED`，什么都不发 | `src/independent-control-checks-v2/` |
| S9 | `prepare-workspaces.py --batch <id>` 读公开描述符 `/2`，按内容重算作业 id，核对已安装 Source 和角色策略 v3；`build-bundle.ps1 -BatchId` 打 bundle，`-CheckRefs` 是第 2 段前的“bundle 之后没有推送”闸门 | `src/resident-v2/prepare-workspaces.py`、`build-bundle.ps1`、`R/src/engine-windows.mjs` |
| S10 | 一个 Node：worker unit、relay、自检和角色策略都用 `/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node`，策略 v3 要求 `nodeExecutable` 等于它 | `worker/qualification-v2.mjs`、`protected-job-bridge-v4/relay-public.ps1`、`R/linux/systemd/clued-ci-worker@.service` |
| S11 | 稳定的失败码目录（§6.3），由代理回复、原生回执和入口结局合成 | `src/resident-v2/stage-fact.mjs`、`invoke-stage.mjs`、`stage-inputs.mjs`、`R/src/classify.mjs` |
| S12 | 一个通用助手 `controller-formal-generic-v2.exe`，安装时用已安装的 Source 编译一次，哈希钉进 `broker.json`；参数是 (nonce, configSha256)，助手自己核对阶段目录里的公开输入，只从 `resident\source\<ciSourceManifestSha256>` 加载代码；入口写结局记录，回执带它的哈希 | `src/resident-v2/windows/FormalPublicBoundaryV2.cs`、`FormalSession0V2.cs`、`entry-runtime.mjs`、`held-record.mjs`、`hold-record.ps1`、`R/windows/install-resident.ps1` |
| S13 | effect journal 和观测日志搬到 `state\v2\effects-scan`、`effects-work-admission`、`effects-control`，批次 claim 在 `state\v2\batch-claims`，都不在任何归档白名单里 | `src/resident-v2/layout.mjs`、三个 v2 发布者 |
| S14 | 基于句柄的 Windows spool 归档（扁平名字、完成型范围的拒绝、失败范围原样归档、带回执的归档目录）；Linux 工具同样改为扁平名字（§6.4） | `src/resident-v2/archive-windows-spool.ps1`、`R/linux/bin/clued-ci-resident-linux` |

两个 Source 清单哈希不要混：

- `sourceManifestSha256`（常驻策略）是**已安装文件清单** `source-installed-manifest.json` 的哈希，用于完整性校验和批次键；
- `ciSourceManifestSha256`（策略 `/2` 新增）是**安装记录的** `source-manifest.json` 的哈希，是每个作业的 `sourceManifestSha256`，也是已安装 Source 的目录名 `resident\source\<它>`（通用助手只从这里加载代码）。

### 7.2 自动 attempt 2（Owner Decision `1b5d3687`）

同一 head 的 attempt 2 自动发生一次，必须同时满足（`R/src/attempts.mjs`）：

1. attempt 1 以 **FAILED_CLEAN** 结束：两端清理证明齐全，现场已归档；
2. 失败码是**白名单里的干净暂时性码**：网络或传输超时、GitHub 5xx 或暂不可用、Native 准入暂不可用、bundle 之后有推送（`REMOTE_REFS_CHANGED_SINCE_BUNDLE`）、归档前提暂未满足；
3. **还没有角色发布过**：失败的是第 1 段（工作准入；它自己的检查按 attempt 区分，attempt 2 用新的作业 id 重新证明）、第 2 段（第一个扫描执行），或二者之间的工作区准备。从第 3 段起扫描或控制角色已经（或可能已经）发布，永远不重试；
4. 策略 `automaticAttempt2.enabled` 为 true；等待 `delayMs`（默认 10 分钟）之后，仍然要过同样的预检（冷却、上限、validUntil、Source 哈希、companion 心跳）。

永远不重试：UNKNOWN（任何 HALT）、可能已有的发布、证据身份冲突、闸门拒绝（未准入、claim 变了、扫描发现问题、准入被拒）、attempt 2 本身。账本在 `ledger-attempt2\<attempt1 键>.json` 以“只能新建”的方式记下意图，所以每个 attempt 1 最多一次；attempt 2 有自己的批次键和 head 键。这是对执行器的唯一一处必要改动（`executor.mjs`：失败路径排程、`tick` 里先跑到期的 attempt 2）。

v0.7 按 PR-A 复审补强（每一条都有先失败、后通过的离线复现测试，`R/test/review.test.mjs`）：

- **预留时消费意图**：预留 attempt 2 之前，先以“只能新建”的方式写 `<attempt1 键>.consumed.json`。之后 attempt 2 不论以什么结局收场，意图都已结束；包括未准入（NOT_ADMITTED）和 bundle 不可用（BUNDLE_UNAVAILABLE），这两种结局会把账本条目释放回 ABSENT。没有新的触发，就不会再评估第 1 段（I3）。在“消费”和“预留”之间崩溃，只会丢掉这次 attempt 2，是安全的方向。
- **绑定已安装的 Source**：意图的主体 Source 不等于已安装的 Source（重装之后）时，关闭意图（`ATTEMPT2_SOURCE_CHANGED`），从不运行。
- **K 不含 attempt**：K(head, role) 既不含 base，也不含 attempt（契约 `role-publication/2`），所以同一 head 上一个角色在所有 attempt、批次和 Source 安装之间最多发布一次。这不损失任何东西，因为 attempt 2 只跟在什么都没发布的第 0–2 段失败之后。
- **回执失败时取消意图**：`attempt2-scheduled` 回执写不进去时，先关闭意图再 HALT，复位永远跑不到它。
- **推迟不挡路**：到期的 attempt 2 若只是被推迟（DEFERRED），不再挡住其他 PR 的触发。
- **未知不会变成暂时性**：没有码的异常、没有答复的 refs 闸门、companion 的自由文本码，都不会被归为暂时性码（§6.3），所以不会触发 attempt 2。

“bundle 之后有推送”在两处被发现，都在任何东西运行之前：第 2 段前 companion 的 `build-bundle.ps1 -CheckRefs`；以及 gitleaks 适配器在建 run 目录之前核对所有新鲜的 ref tip、head、base 都已在工作区对象库里（`refsInStore`，失败就是干净的 `BLOCKED`，经 bridge 的 `blocked` 记录回到 Windows）。

### 7.3 归档保留提醒（50 GB）

归档只改名、从不删除。服务在批次之间最多每小时量一次：Windows spool 的 `archive-*`、`failed-*` 目录、常驻层自己的 `work\` 和 `bundles\`，以及 companion 转来的 Linux spool 归档大小（`clued-ci-resident-linux archive-usage`）。合计达到策略 `retention.reminderBytes`（50 GB）时，每天最多写一条 `archive-retention-reminder` 回执（`deletesAnything: false`），由 Owner 决定移走或删除什么（`R/src/retention.mjs`）。读不到的部分会让测量标为不完整，但只会让提醒更容易发出，不会相反。

### 7.4 留给中继集成（S19–S22）的接口与未完成项

v0.6 只实现 S1–S14。中继集成要调用的接口（都已存在、有测试）：

- **阶段 R / 常驻执行器**：`engine.runStage(batch, stage)` → `{ok, code, proof, factsSha256}`；底层是 `node CI/src/resident-v2/invoke-stage.mjs --batch-dir --stage --work-manifest-sha256 --batch-key`（输出阶段事实 `/2`，退出码 0 或 41），失败码全在 §6.3 的目录里；新增的阶段要在 `STAGES_V2`（`layout.mjs`）、代理的 `StageMilliseconds`（`SwapBroker.cs`）、`FormalPublicBoundaryV2.cs` 的阶段表和常驻策略的 `stageRunMilliseconds` 里同时登记，并给 `ENTRY_V2` 加入口、给 `stage-fact.mjs` 加码、让 `classify.mjs` 镜像（测试会拦住不一致）；
- **hosted-wait**：等待只读，模式同 S8（`independent-control-checks-v2/publisher.mjs` 的 `waitForQueueHead`：轮询、窗口、`RESIDENT_QUEUE_HEAD_NOT_REACHED`）；
- **companion 提示**：新请求种类要加进 `mailbox.mjs` 的 `KINDS` 和 `REQUEST_FIELDS`（精确字段），`companion.mjs#handle` 只执行固定 argv，回复只经 `validateResponse` 的固定字段（v0.6 新增了 `usage`）；
- **classify / policy / receipts**：新码进 `stage-fact.mjs` 再镜像到 `classify.mjs`；策略 `/2` 的字段是精确集合（`exactKeys`），加字段要同时改 `policy.mjs`、`config/policy.example.json` 和 `test/helpers.mjs`；回执类型是自由的 `receipts.append(type, body)`；
- **代理白名单**：v0.6 只有一个助手，名字固定 `controller-formal-generic-v2.exe`，哈希在 `broker.json`；再加助手要扩展 `broker.json` 的 `helper` 字段和 `SwapBroker.LoadConfig` 的精确检查。

v0.6 时没有做的（不在 S1–S14 内，或需要中继步骤一起定），v0.7 的处理见 §7.6：

- `scripts/ci/clued-work-admission.mjs` 的合并闸门仍通过 `independent-control-checks-v1/consumer.mjs` 读 **v1** 控制检查；v2 控制对需要一个 v2 消费者并接进评估器。**v0.7 已做**；
- `staged-check-publisher-v2.mjs` 是 v1 文件的副本，合并时要按 diff 对齐。**v0.7 已做**；
- A2 的 guarded claim（`lease_key_required`）仍然拒绝，没有放开。v0.7 仍然如此；
- Linux 侧 Source v2 的安装（`/opt/clued-independent-ci/source-v2`、`roles-v3/*.json`、`formal-source-manifest-v2.json`）。**v0.7 已写成脚本**；qualification v2 的签发仍是单独的主机步骤。

### 7.5 托管转发接进常驻执行器（S19–S22，v0.7）

依据：免费分钟设计 §4.1–§4.3 的 S19–S22、§7（切换逻辑、`20-plan-intent`/`25-plan`、幂等、合并位时序）、§11（测试）。转发核心（S15–S18：登记表、OIDC 验签、观察、第 R 段、`publishHosted`、K(head, role)）已在 PR-A 里，本节只讲接线。`R/` 指 `work/independent-ci-resident-v1/`，`HR/` 指 `CI/src/hosted-relay-v1/`。

**一批的顺序**（`R/src/executor.mjs#drive`）：

1. 预留 → 导出 → bundle → 第 1 段 → `10-started`（烧号）。和 v0.6 一样，第 1 段之前的失败仍按 v0.6 处理。
2. **托管等待**（`R/src/hosted-wait.mjs#decide`）。按本任务的定序，等待放在第 1 段之后（免费分钟设计 §4.2 原本放在预留之前）：
   - t0 是读到并预留这个触发的时刻，`10-started` 之后立刻和导出的批次一起写进 `15-relay-wait`（CreateNew）；
   - **等待不阻塞**（复审要求：急停永远不能被等待拖住）。每次判断只读一次提示：结论是 WAIT 时，tick 返回 WAITING。服务循环照常每轮先刷新单实例锁的存活记录、检查 STOP，再跑下一个 tick；
   - 下一个 tick 先做崩溃恢复，再处理 Owner 的请求，然后看 HALT 和暂停，最后才从保存的 t0 重新判断这个批次。所以等待中写入的暂停请求在下一个 tick 就生效，批次停在第 R 段和所有本地段之前；只有 Owner 的恢复请求能让它继续，继续时仍按保存的 t0 计算上限；
   - 等待中的批次（有 `15-relay-wait`、没有 `20-plan-intent`）什么都没在运行，所以它是“可继续”的，不是崩溃现场：恢复不关它，复位不因它而被拒绝（等待中锁上的 HALT 经 Owner 复位清除后，批次继续等），服务重启后从保存的 t0 和批次继续，不重新导出、不重跑第 1 段。`relay-waiting` 回执只在开始等待时写一次；
   - 上限照 §7.2：没有任何运行等 10 分钟，排队等 15 分钟，运行中等 job 超时加 10 分钟，总上限 60 分钟；
   - 任何角色的提示是 BILLING_REFUSED 就立刻开始，全部本地；
   - `relay.enabled=false` 时不等、不跑第 R 段。
3. **`20-plan-intent`**（CreateNew）：转发候选、本地角色和每个本地角色的调度原因，还有等了多久、提示的摘要、提示是否被拒。
4. **第 R 段**（第 9 段，只有候选非空时才跑）：
   - 执行器先请引擎为这些候选导出第 R 段的包（`derive-batch.mjs --relay-roles`，CreateNew 写进同一个批次目录）；
   - 然后照常经交换代理和通用助手运行 `HR/relay-entry-v2.mjs`；
   - 阶段事实带回每个角色一行（`HR/relay-plan.mjs`），执行器逐行核对（`R/src/classify.mjs#relayPlanFromRows`）：行必须正好对应候选，且只能是干净的 RELAYED 或 LOCAL_REQUIRED（原因在白名单里）。
5. **`25-plan`**（CreateNew）：已转发的角色（check run id、external id、证明摘要），以及要本地执行的角色和原因。来源有两种：第 R 段给的 `RELAY_NOT_ATTESTED_*` 或 `RELAY_ROLE_NOT_RELAYABLE`，执行器自己的调度原因（`RELAY_DISABLED`、`RELAY_HINT_BILLING_REFUSED`、`RELAY_HINT_NOT_ELIGIBLE`、`RELAY_HINT_HOSTED_NOT_SUCCESS`、`RELAY_WAIT_TIMED_OUT`、`RELAY_ROLE_NOT_RELAYABLE`）。
6. **只为 `25-plan` 里的本地角色**按固定角色顺序跑执行段和发布段：
   - 有本地 Linux 角色时才做 ws-prep；
   - 第一个本地 Linux 段之前做 refs 闸门；
   - 之后的本地 Linux 段之前做角色间归档，原因只会是 `between-roles-4` 或 `between-roles-6`。
7. 本地角色跑完后再读一次提示：本地已经开始之后托管才成功的角色，只记 `relay-late-ignored`，绝不转发。
8. 第 8 段 → 收尾。没有本地 Linux 角色时，收尾不碰 WSL。

**不变量**：

- 只做转发的批次也在 `10-started` 烧号。
- 转发的角色从不获得本地运行：它的阶段包虽然在导出时已经确定性地生成（作业 id 是内容 id），但它的执行段和发布段从不被调用，作业 id 也从不交给 bridge 或用于发布。
- `RELAY_PUBLICATION_UNCERTAIN`、`ROLE_ALREADY_PUBLISHED_ON_HEAD`、`RELAY_PLAN_UNCONFIRMED` 一律 UNKNOWN：烧号、HALT，这个批次不再跑任何本地段，也不写 `25-plan`。
- 崩溃恢复：有 `20-plan-intent`、没有 `25-plan` 的条目，可能已经 begin 了某个角色的键，所以以 `RELAY_STAGE_INTERRUPTED` 关闭为 FAILED_UNKNOWN 并 HALT。
- 第 R 段的干净失败（`RELAY_STAGE_REFUSED`）是终局：烧号、归档，不排 attempt 2。
- **attempt 2**（`R/src/attempts.mjs`）照 v0.6 的规则（只有第 1、2 段，以及二者之间的工作区准备），另加一条：attempt 1 只要转发过任何角色就不排；第 R 段本身（第 9 段）不在可重试的段里。
- K(head, role) 跨路径互斥：转发入口和本地 v2 扫描发布者用同一个 journal（`state\v2\effects-scan`），所以同一 head 上同一角色只会有一个发布者，跨批次、跨 attempt 也成立（K 不含 base 和 attempt，见 §7.2）。v1 one-shot 的本地路径不拿 K（复审 MAJOR：它有自己的 journal，K 在那里排除不了任何东西；而 v1 作业按 claim、fence、base 区分，拿 K 只会让同一 head 上的第二个 v1 作业永远 BLOCKED）。v1 发布者只有在调用方显式要求（`localRoleMutex`）时才在本地路径拿 K。
- 转发的重入：本键已结算时，不再只读回，而是像 `publish()` 一样重新核对 PR head、受保护事实与 claim、新鲜的 Native 准入并读回；有漂移就撤销一次已知检查，从不重发。K 已被同一角色在本 head 上**已结算的转发**持有时（托管重跑出了更新的 run 或 run attempt），结果落到那次已结算的发布（重新核对，不再发布），不再 HALT；只有本地持有或未结算的转发持有才仍是 HALT。
- 每次继续一个等待中的批次之前，都重跑开批次时的检查（`validUntil`、已安装 Source 与常驻层的哈希、批次主体的 Source 等于已安装的 Source）。任何漂移都失败关闭：FAILED_UNKNOWN 加 HALT（`RESIDENT_SOURCE_DRIFT` 或 `RESIDENT_INSTALL_AUTHORITY_EXPIRING`），不会跑第 R 段和本地段。`install-resident.ps1` 在有任何未终结批次时拒绝安装，包括等待中的批次（`INSTALL_REQUIRES_NO_OPEN_BATCH_REARM_FIRST`，与 `uninstall-resident.ps1` 相同）。
- 其他复审修正：v1 one-shot 的必需钉值加入 v1 发布者现在加载的 `hosted-relay-v1/attest.mjs`、`registry.mjs`、`oidc.mjs`。第三轮复审又发现漏了 `full-admission.mjs` 导入的 `independent-control-checks-v1/queue-facts.mjs`，所以 `V1_REQUIRED_SOURCE` 现在就是 `runtime/one-shot.mjs` 的完整静态加载闭包：静态导入和相对模块的 `new URL(...)` 文件引用，逐层展开，包括评估器和它导入的 `scripts/ci` 模块与来源目录（H5 安装记录本来就钉了这些文件）。评估器的动态导入（控制检查的 consumer）只在设置了 `CLUED_EXECUTION_PROVIDER` 时运行，one-shot 不会用到，所以不算在内。`pr-a-review.test.mjs` 重新计算这个闭包，必须和列表完全相同；v2 的 Native verify 和 v1 一样带 10 秒超时；准入登记的注释写明 contract-placement 的托管执行从不转发（`RELAYABLE_ROLES` 只有 gitleaks、trivy）。PR-B 工作流里那句“5368905 在核验后发布 contract-placement”的注释在冻结字节里，要在 PR-B 改。
- **托管作业执行的仓库脚本被遮蔽（复审 BLOCKER）**：托管 gitleaks 作业持有 `id-token: write`，并从 PR 检出运行 `python3 scripts/ci/reviewed_gitleaks.py`。不带 `-I` 时，Python 会把 `scripts/ci` 放在 `sys.path` 首位，所以 PR 只要加一个 `scripts/ci/argparse.py`，就能在扫描之前运行自己的代码，比如改掉磁盘上的 `.gitleaks.toml`。这样转发会发布一个假的绿色检查，之后 K 还会挡住受信的本地角色。修正如下：
  - 登记表的每个角色新增 `forbiddenChangePrefixes`（目录前缀；gitleaks 是 `scripts/ci/`，trivy 不执行仓库脚本，所以为空），并且计入 `closureSha256`；
  - E3 对改动落在这些前缀下的 PR（新增、修改、删除，改名时两端都算）判 NOT_ELIGIBLE（`E3_EXECUTED_PATH_CHANGED`），角色回本地，提示模式也一样；
  - `build-registry.mjs` 从托管作业的 `run:` 步骤读出执行的仓库脚本：每个 Python 调用都必须带 `-I`（包括 `-c`），拒绝 `-m`，拒绝用 Node 运行仓库脚本；执行的脚本必须在 closure 里，它的目录必须被角色前缀或全局前缀（`.github/`）覆盖，否则拒绝构建。
  - 现在提交的生产登记表建于这些规则之前，会被拒绝，所以转发失败关闭（第 R 段 `RELAY_STAGE_REFUSED`）。它对应的 PR-B 提交也会被新构建器拒绝（Python 没有 `-I`）。PR-B 要改用 `python3 -I -B` 重新冻结，再用这个构建器重建登记表，转发才可能打开。PR-B 后来又重新冻结了几次，其中一次修了复审 BLOCKER：托管 gitleaks 扫描 PR 的工作树时，会受 PR 自己的 `.gitattributes` 和 `.gitleaksignore` 影响。现在托管 gitleaks 扫描的是本地角色的同一份输入。每次冻结后，登记表都用当前构建器从冻结的 PR-B 提交重建（只有 gitleaks、trivy；用的是哪个提交，看 `registry.json` 的 `sourceCommit`）。PR-B 前后本地角色认的工作流字节见 §7.7。
- **复审的转发 MINOR**（随 PR-B 的重新冻结一起）：
  - 托管作业用到的本地 action（`uses: ./<目录>`）必须整个钉住：`build-registry.mjs` 从托管作业读出这些目录，目录里的每个文件都必须是普通文件，并且在角色的 closure 里（`RELAY_REGISTRY_LOCAL_ACTION_NOT_PINNED`）；目录必须存在并且有 `action.yml`（`RELAY_REGISTRY_LOCAL_ACTION_MISSING`），还必须被禁改前缀覆盖（`RELAY_REGISTRY_LOCAL_ACTION_NOT_COVERED`）；路径有 `..`、空段或不以 `./` 开头时，扫描直接拒绝。`registry.spec.json` 两个角色的 closure 因此加上 `ci-temporary-storage` 的 `check-workflows.mjs` 和 `coverage.json`。从冻结的 PR-B 提交重建的登记表里，两个角色都带着这两个钉值（这两个文件在 `.github/` 下，E3 本来就不转发改动它们的 PR）。如果以后规格又加了钉值而登记表还没重建，旧登记表仍然有效，测试只核对同一个 PR-B 提交按新规格重建时只多出 closure 钉值；
  - 任意深度的 `.gitattributes` 都不能改：E3 对每个转发角色加一条写在代码里的禁改路径规则 `**/.gitattributes`（`FORBIDDEN_CHANGE_GLOBS`，不依赖登记表），命中时判 NOT_ELIGIBLE（`E3_PROTECTED_PATH_CHANGED`），角色回本地。原来只禁了根目录的 `.gitattributes`；
  - 托管检查的应用：托管作业名下的 check run 只能来自 GitHub Actions（app `15368`）。原来 E5 只是跳过其他应用的 run；现在这个 head 上只要有一个同名的 run 来自别的应用，就判 ATTESTATION_FAILED（`E5_FOREIGN_APP_RUN`），即使旁边还有一个成功的 Actions run，角色也回本地；
  - trivy 的 checks 包摘要不再靠手抄：托管 trivy 作业在 env 里写 `CHECKS_DIGEST: sha256:…`，本地 trivy 角色在已安装的 Source 清单里钉 `formalTrivy.checksPin.digest`。现在 `build-registry.mjs` 从托管作业读出 `CHECKS_DIGEST`，写进登记表的 `roles.trivy.checksDigest`；托管作业里必须正好有一个这样的值，并且确实用在 `trivy-checks@$CHECKS_DIGEST` 上，否则拒绝构建。第 R 段（`relay-entry-v2.mjs` 的 `installedInputPins`）从安装记录取本地钉值，和登记表比较：不相等，或者登记表里没有这个值（这个规则之前建的登记表），trivy 就是 LOCAL_REQUIRED（`RELAY_ROLE_NOT_RELAYABLE`，detail 分别是 `checksDigest_differs_from_installed_role` 和 `checksDigest_not_registered`），而且不为它读任何东西。gitleaks 不受影响；
  - 提交里所有的 `.gitattributes` 都钉进 closure：构建器列出登记表提交里每一个 `.gitattributes`（任意深度），钉进 gitleaks 和 trivy 的 closure，不用在规格里手列。main 以后改了其中任何一个，head 上的字节就和登记表不同，E4 判 NOT_ELIGIBLE（`E4_CLOSURE_MISMATCH`），重新钉值之前不再转发。仓库现在有 18 个，每次观察要为它们多读一些目录树（同一次观察里按树缓存）。main 上以后新增的 `.gitattributes` 不在钉值里：新增它的 PR 本身因为 E3 不转发，重建登记表之后它也会被钉住；
  - `requireCheckRunIdClaim` 仍是 `false`：令牌带了 `check_run_id` 声明时，它必须等于这次 check run 的 id；没带时现在照样接受。演练 L1 一旦确认托管令牌带 `check_run_id`，就必须把它改成 `true` 并重建登记表，之后没有这个声明的令牌一律拒绝。

**第 R 段在 Source v2 里**：

| 件 | 内容 | 位置 |
|---|---|---|
| 阶段表 | 第 9 段，种类 `hosted-relay`，入口角色 `relay-publisher`，作业角色是 gitleaks、trivy 的非空有序子集，运行上限 15 分钟；`FORMAL_STAGES_V2` 仍是批次导出的 8 段 | `CI/src/resident-v2/layout.mjs` |
| 第 R 段的包 | `deriveRelayStage`：从已有的 `batch.json` 重新导出主体并核对作业 id，再只为候选生成 `stage-09/`，同输入同字节 | `CI/src/resident-v2/derive-batch.mjs` |
| 入口 | `relay-entry-v2.mjs`：登记表按 held record 的钉值核对字节；OIDC 验签器的 JWKS 缓存在 `state\relay\jwks\`；观察器走已安装的检查端口；发布者是 v2 扫描发布者（批次 claim 代次） | `HR/relay-entry-v2.mjs` |
| 结局 | `relay-plan.mjs`：第 R 段的结果 → 结局记录的 `relay` 行（COMPLETE → `RELAY_COMPLETE`；HALT → `UNCERTAIN` 加码；REFUSED → `BLOCKED`）；`stage-fact.mjs` 为第 9 段校验这些行并带进阶段事实 | `HR/relay-plan.mjs`、`CI/src/resident-v2/stage-fact.mjs`、`stage-inputs.mjs` |
| 通用助手 | C# 阶段表加第 9 段：入口 `relay-publisher`，作业是 gitleaks/trivy 的非空有序子集（`SelectedJobRoles`），时间窗 15 分钟 | `CI/src/resident-v2/windows/FormalPublicBoundaryV2.cs` |
| 交换代理 | `StageMilliseconds` 加第 9 段；`broker.json` 仍只钉一个通用助手 | `R/windows/SwapBroker.cs` |
| ACL | 新建 `state\relay`、`state\relay\jwks`（clued-control 修改，常驻 SID 无权限） | `CI/src/resident-v2/acl-model.json` |

**常驻层的其他改动**：

- **策略 `/3`**（`R/src/policy.mjs`）：
  - `relay` 是精确的键集：`enabled`、`roles`（gitleaks、trivy 的非空有序子集）、`wait`（`signalMs`、`queueMs`、`runSlackMs`、`totalMs`、`pollMs`、`jobTimeoutMs`）；
  - `stageRunMilliseconds` 第 9 项是第 R 段；
  - 批次预算在转发打开时加上等待上限和第 R 段；
  - 样例策略 `relay.enabled=false`（Owner 决定：OIDC 声明的实际取值要等免费分钟恢复后才能测）；打开它就是改策略，换策略哈希，一次 UAC。
- **可转发角色**等于登记表的 `RELAYABLE_ROLES`（gitleaks、trivy）。contract-placement 永远本地，也从不等它（`hosted-wait.mjs`，测试与登记表对照）。
- **回执**（`R/src/receipts.mjs#RELAY_RECEIPTS`）：
  - `relay-attested`：角色、check run id、external id、证明摘要；
  - `relay-local-fallback`：角色、原因、来源（`stage-r` 或 `resident`）；
  - `relay-billing-refused`：角色、原因；
  - `relay-late-ignored`：角色。
  - 另有 `relay-plan-intent`，以及第 9 段的 `stage-terminal`。转发关闭时不写逐角色的转发回执。
- **classify**：镜像第 R 段的码和 `LOCAL_REASONS`，测试保证与 Source 一致。

**companion 的提示模式（S20）**：

- 轮询器对它提交过的每个 PR head，在首次提交后的 2 小时内，每次轮询都观察一次托管运行（`R/src/poller.mjs`）。
- 观察用已安装 Source 的 `HR/observe.mjs` 和 `HR/stage.mjs#hostedHint`（提示模式，不验签），走 Owner 自己的 gh 登录。gh 端口只读（`R/src/gh-read-port.mjs`）：固定 argv `gh api --method GET`，回复按检查端口同样的规则规范化。
- 结果写成 `clued.independent-ci.hosted-hint/1` 记录（`R/src/hosted-hints.mjs`）：每角色一个状态，≤ 2 KB，只是数据。只在状态变化时写一个新文件 `mailbox\responses\hosted-hint-<pr>-<head12>-<序号>.json`（CreateNew）。
- 服务只读该 head 最新的那一个（`Mailbox#latestHint`），用 `parseHint` 解析。损坏的、别的 head 的、含不可转发角色的提示，都当作“没有提示”。
- 提示只能让批次多等或少转发，不能让任何东西发布。
- 提示模式默认关闭：`companion.json` 的 `hints.enabled` 由打包工具按策略的转发开关设定。

**没有实现的**（离线做不了，或要主机数据）：

- 免费分钟设计 §7.5 的“开始前合并位剩余不足 20 分钟就推迟”：执行器不联网，读不到 `merge_slot_until`。第 8 段仍按 S8 自己等队首；只做转发的批次从第 1 段到第 8 段通常只要几分钟。
- 长阶段（最长 45 分钟）运行期间，执行器照旧要等阶段结束才处理暂停、STOP 和 Owner 请求，单实例锁的存活记录也要等阶段结束才刷新。这是 v0.6 就有的行为，等待不再加长它。

### 7.6 v0.6 缺口的补齐（v0.7）

- **v2 发布者并入转发改动**（`CI/src/staged-check-publisher-v2.mjs`，按 diff 对照 v1 提交 `b5a7db45`）：
  - 证明分两种：`signed`（Linux 签名结果）和 `hosted`（`clued.independent-ci.hosted-attestation/1`，写之前由已安装的验证器用新鲜事实重新核验）；
  - `publishHosted` 用 v2 作业（内容 id，`createdAt` 不进 id），主体里的 claim 代次必须等于批次 claim，否则 `hosted_claim_changed`，角色回本地；
  - 本地发布和转发发布在 begin 自己的键之前都先 begin K(head, role)。
- **合并闸门的 v2 消费者**：
  - `CI/src/independent-control-checks-v2/consumer.mjs`：从 stage 1 写的 batch-claim 记录找到批次，按内容重算控制作业，读 `state\v2\effects-control` 里已结算的条目；写入前后各做一次新鲜的完整准入，并核对持久的生产者身份 `sourceBindingSha256`（v2 发布者现在也写这个值）；
  - 同一 head 只认最新的判断（`NEWER_CONTROL_JUDGEMENT_PRESENT`），所以一个 head 只算一个批次；
  - `clued-work-admission.mjs` 在 `CLUED_EXECUTION_PROVIDER=independent-control-checks-v2` 时走它（`gate` 和 `appChecksOnHead` 两处）；
  - 不是以 clued-control 身份在 Windows 上运行时，一个文件都不打开就拒绝（`CONTROL_CONSUMER_V2_PRINCIPAL_REQUIRED`）。
- **Linux 侧 Source v2 安装**（`R/linux/bin/clued-ci-install-source-v2`）：
  - `package`：任何用户、离线，把安装记录的 `source-manifest.json`、三份角色策略 v3、三份已签名的 qualification v2 和该提交的 git bundle 打成包，每个字节都钉值；
  - `--plan`、`--apply <planSha256>`：只能由 Linux 上的 root 显式调用；计划绑定包清单哈希和主机事实（目标都不存在、钉住的 node 和 git 在、角色锁空闲）；
  - 只能新建：检出到受信目录并核对每个钉住的文件，然后写源清单、qualification、角色策略（策略最后写），再用钉住的 node 逐个角色做 `loadQualifiedPolicyV2` 就绪检查，最后写回执；
  - 不读私钥，不签 qualification。签发仍是单独的主机步骤（P2）。打包工具把它放进包里并报告哈希，它不是 unit guard 的钉值。
- **Source 闭包重算**（`CI/src/resident-v2/source-closure.json`）：加入 `HR/` 的入口、登记表、观察、OIDC、计划行，以及 v2 消费者。`github.mjs`、`effect-journal.mjs`、v2 发布者原本就在闭包里；字节在安装时由 `prepare-record.mjs` 按闭包重新钉值，仓库里不存哈希。

### 7.7 PR-B 前后的受信工作流字节（v0.7）

本地正式角色会在已安装的受信检出里核对三份托管工作流的字节：gitleaks 角色核对 `.github/workflows/gitleaks.yml`，trivy 角色核对 `trivy.yml`，contract-placement 角色核对角色策略里的 `workflowSha256` 和 Source 清单里 `contract-placement.yml` 的钉值。原来每份工作流只钉一个值，就是 PR-B 之前 main 上的字节。这样 PR-B 落地以后，从新 main 安装的 Source 会被它自己的角色拒绝（`TRUSTED_REVIEW_SOURCE_CHANGED`）。另外 `formal-gitleaks-v3-required-history.test.mjs` 直接读工作树，合入 PR-B 后也会失败。

现在每份工作流钉成一个**精确的集合**，不用通配，并且所有地方都从**同一张表**取值：`CI/worker/trusted-workflows.mjs`。

- 表的每一行是一份工作流的一个审过的版本：字节的 sha256（作为键）、git blob（对照提交审查用）、来源（`main <提交>` 或 `pr-b <提交>`）。表格式不对就在加载时拒绝（`TRUSTED_WORKFLOW_TABLE_INVALID`），不会接受半张表。每份工作流两行：一行是 main 上的字节，一行是冻结的 PR-B 提交里的字节。现在是哪两个提交、哪些哈希，以 `CI/worker/trusted-workflows.mjs` 为准，这里不重复。
- PR-B 重新冻结时，只要一条命令：`node CI/test/fixtures/repin-trusted-workflows.mjs --repo . --main <main> --pr-b <新的 PR-B 提交>`。它从这两个提交的 git 对象读字节，改写表里 BEGIN/END 标记之间的行，同时重写测试夹具 `CI/test/fixtures/trusted-workflows.json`。加 `--check` 时不写文件，只报告是否一致。main 还是这些字节时，main 的行保留。
- 从这张表取集合的地方：gitleaks 准备（v3、v4）、trivy 计划（`required-trivy-v2`、`-v3`）、placement 适配器（v1、v2）、角色策略（v2、v3），以及经 placement 适配器的签名结果（bridge v3、v4）。表是纯数据，没有导入，也不读文件。它在所有要核对导入闭包的清单里：gitleaks 适配器的 `SOURCE_FILES`、trivy 适配器（v2、v3、v4）和 placement 适配器的 `CLOSURE`、策略的 `COMMON_SOURCE`、bridge v3/v4 的 `REQUIRED_SOURCE_PATHS`、`source-closure.json`（已重算）。
- 规则：
  - Source 清单在安装时由 `prepare-record.mjs` 按受信检出钉值，每份工作流只能声明一个值；
  - 这个值必须在集合里，受信检出里的文件也必须正好是这个值，否则 gitleaks 报 `TRUSTED_REVIEW_SOURCE_PIN_REQUIRED` 或 `TRUSTED_REVIEW_SOURCE_CHANGED`/`_DRIFT`，trivy 报 `ORIGINAL_TRIVY_WORKFLOW_SOURCE_REQUIRED` 或 `_DRIFT`；
  - placement 角色策略里的 `workflowSha256` 必须在集合里，并且等于清单里的钉值（`ORIGINAL_WORKFLOW_REQUIRED`）；
  - 准备记录和观察记录写入实际用到的那个值，不再写常量。签名结果和角色策略只接受集合里的值。助手 `reviewed_gitleaks.py` 和 `.gitleaks.toml` 仍然各钉一个值，PR-B 没有改它们。
- 本地角色读的是已安装的受信检出，不读被检查的 head，所以 head 上是哪一版工作流都不影响本地角色。转发路径按登记表核对 head：head 上不是登记表里 PR-B 的字节时，E4 判 NOT_ELIGIBLE（`E4_CLOSURE_MISMATCH`），角色回本地。
- 两条路径用同一张表：
  - Source v2：gitleaks v4、trivy v4 加 `required-trivy-v3`、placement v2、策略 v3、bridge v4；
  - H5 one-shot 回退：gitleaks v3、trivy v3 加 `required-trivy-v2`、placement v1、策略 v2、bridge v3。现在装着的 H5 从它冻结的安装树运行，用的是旧字节，所以不需要新值；但只要从 PR-B 之后的 main 重新安装 H5，就需要新值。为了这种情况，H5 也接受这组值。
- 不改的部分：
  - H4 的 `formal-gitleaks-v2`（bridge v2）不在任何一条路径上，保持单值钉。`formal-trivy-v2` 仍然只认一个值，即 `required-trivy-v2` 的 `WORKFLOW_SHA256`，它取的是表里 main 的那一行；它也加载这张表，所以表在它的 `CLOSURE` 里。bridge v2 的固定清单（`independent-control-checks-v1/closure.mjs`）不改；
  - `required-gitleaks/prepare.mjs` 现在只是为了 `noLinks` 被导入，也保持单值钉；
  - `src/control-install-delta-v2/*.json` 是历史安装记录，不改；`worker/linux-formal-install-v1/manifest.json` 是历史的候选记录（`SOURCE_CANDIDATE_NOT_INSTALLED`），它记下的依赖哈希早已和仓库不同，也不改；
  - `src/control-install-delta-v2/prepare-payload.mjs` 是 H5 安装增量的绑定器，它和自己的部署钉值、`manifest.json` 里的字节钉值一起冻结，所以仍然只接受旧的 placement 值。从 PR-B 之后的 main 重新安装 H5，本来就要做一个新的安装增量，新值到那时再带上；
  - Source v2 的 `prepare-record.mjs` 只检查 placement 的 `workflowSha256` 是不是 64 位十六进制。它和清单钉值是否一致，由 placement 角色在运行时检查（`ORIGINAL_WORKFLOW_REQUIRED`，失败关闭）；
  - `scripts/ci` 里的准入登记（A1）已经同时登记了两版 blob；`merge-admission-r9-source.json`、`clued-control-workflow-source(s)` 不钉这三份工作流。
- 测试从 `CI/test/fixtures/trusted-workflows.json` 读两版的精确字节，并核对 blob 和 sha256，不读工作树：
  - `trusted-workflow-pins.test.mjs` 9 个：表与夹具一致（用夹具数据重新生成，表和夹具都逐字节相同）；本地有这两个提交时，夹具字节就是它们的 git 对象；格式不对的表拒绝加载；每个模块的集合和闭包；gitleaks 声明钉；trivy 计划；placement 角色档案；gitleaks v4 准备；
  - `formal-gitleaks-v3-required-history.test.mjs` 新增 1 个：两版都接受；换版、篡改、未声明、重复声明都拒绝，并且拒绝时没有任何输出；
  - `resident-v2-bridge.test.mjs` 新增 1 个：策略 v3 和 v4 签名结果下的 placement。

---

## 8. Windows：服务账户与权限边界

### 8.1 常驻服务

- `CluedCIResident`，账户 `NT SERVICE\CluedCIResident`（`S-1-5-80-` 加服务名的 SHA-1），SID 类型 unrestricted。
- 延迟自动启动。失败后每天最多重启一次（`failureflag 1`，非崩溃的失败也会触发），目的是让崩溃恢复把 HALT 落盘，不是重试批次。
- 服务自身的 DACL：只有 SYSTEM 和 Administrators 能控制。
- **必需特权只有 `SeChangeNotifyPrivilege`**（`sc privs`，PR-A 复审 MAJOR-1）：SCM 从服务令牌里去掉其余所有特权，尤其是默认带的 `SeImpersonatePrivilege`。宿主启动时再读一次**真实令牌**：多出任何特权就拒绝启动，并把令牌里的特权写进 `state\service-token.json`；安装回执和 `verify-resident.ps1` 都核对它和 `sc qprivs`。
- **出站网络被封**（MINOR-5）：防火墙规则 `CluedCIResident-BlockOutbound` 按服务 SID 限定（`-Service CluedCIResident`），覆盖服务的所有 node 子进程；GitHub 读取全在 companion（Owner 自己的登录）里，runner（clued-control）不受影响。只在 Windows 防火墙开启时生效，`verify-resident.ps1` 同时检查规则和三个配置文件都开着。
- 宿主 `ResidentServiceHost.cs`：启动前校验 node 和入口文件的哈希；环境变量清空，只留固定几项，不继承句柄；停止时只写 `STOP-REQUESTED`，从不杀执行器。

### 8.2 交换代理

- `CluedCISwapBroker`，LocalSystem，自动启动；失败后自动重启（60 秒、再 300 秒，每天重置，非崩溃的失败也算），重启从不重复被打断的切换（领取标记）。
- **特权最小化**（MAJOR-1）：必需特权只有 `SeChangeNotifyPrivilege` 和 `SeCreateGlobalPrivilege`，启动时同样核对真实令牌并写 `broker\token.json`。说明：LocalSystem 的 **SID** 仍是 SYSTEM，所有按 DACL 授给 SY 的权利都还在，这一点改不了；能去掉的是特权（`SeTcb`、`SeDebug`、`SeImpersonate`、`SeAssignPrimaryToken`、`SeBackup`、`SeRestore`、`SeTakeOwnership`、`SeLoadDriver` 等）。代理只需要 SCM 的 DACL 授权和它自己的文件。
- **只信 SYSTEM 和 Administrators**（MINOR-3）：变更互斥量的所有者和 ACE、以及可以接受的 runner 服务 DACL 管理者，都只认 SY 和 BA，不再认 Owner 的用户 SID（实测 runner 的 SDDL 里本来就没有 Owner ACE）；runner DACL 里任何其他主体有改配置、启动、停止、删除、改 DACL/所有者或通用写/执行/全部权利，都拒绝。v1 提权工具若带 Owner ACE 建了同名互斥量，代理会拒绝（fail closed），所以 `broker.json` 也改为 `/2`，不再含 Owner SID。
- **有界读取与不中断**（MINOR-2）：请求先按文件长度判断（≤ 4096 字节），再读，最多读 4097 字节；枚举请求目录失败不会结束工作线程，单个请求出错只影响它自己。
- 每个请求的处理：
  1. 只接受 `{contract, stage, nonce, deadline, configSha256}` 这 5 个字段；截止时间距现在不足 2 分钟的请求直接拒绝，也不切换。
     **每个请求最多执行一次，崩溃和重启也不例外**：
     - 动手前先以“只能新建”的方式写一个 `responses\<id>.taken` 领取标记；
     - 有领取标记、没有回复的请求（切换被打断），只答复 `BROKER_REQUEST_INTERRUPTED_NOT_REPEATED`；
     - 代理这个进程启动之前就已存在的请求，只答复 `BROKER_REQUEST_PREDATES_START`。

     所以重启之后，代理绝不会把同一阶段再启动一次（第四轮复核 MAJOR 3）；
  2. 助手路径固定为 `helpers\controller-formal-generic-v2.exe`（S12：一个通用助手），不取自请求；
  3. 助手哈希必须等于 `config\broker.json` 里钉住的值，这个文件的哈希写在代理的启动参数中；它还钉住原始二进制和 runner 的稳定配置摘要（安装时用刚编译的代理只读求出）。`verify-resident.ps1` 核对代理的二进制路径、这个配置哈希参数，以及 `broker.json` 与它一致；
  4. 换之前确认 runner 是原始二进制、Manual、STOPPED、账户 clued-control；
  5. `ChangeServiceConfigW` 只传二进制路径，其余参数全部是 `SERVICE_NO_CHANGE` 或 null，所以账户、密码、启动类型改不了；
  6. 带 nonce 启动一次，等它停止；
  7. 只有停止了才换回原始二进制，没停止的不动，如实报告。
  8. 每轮循环都检查一次：如果 runner 停在某个已安装的助手二进制上（比如崩溃发生在“停止”和“还原”之间，或者助手过了截止时间后才停），就把原始二进制换回去。还在运行的助手不碰，账户等其他配置也不改。
- 被攻破的常驻账户最多只能“启动已审的助手跑自己的作业输入”，到不了 SYSTEM，也不能以 clued-control 身份运行任意代码。

### 8.3 目录 ACL

所有者都是 Administrators，DACL 受保护；掩码要在测试机上再核一遍。

| 目录 | 常驻 SID | Owner | clued-control |
|---|---|---|---|
| `resident\`、`bin`、`config`、`install`、`resident\<sha>`、`runtime` | 读、执行 | 读、执行 | — |
| `owner` | 读 | 读（只有提权的 Owner 能建文件） | — |
| `source\<sha>` | 读、执行 | 读、执行 | 读、执行 |
| `helpers` | 读、执行 | — | 读、执行 |
| `record`（免 claim 安装记录） | 读、执行 | 读、执行 | 读、执行 |
| `stage`（每段的密封输入） | 修改 | — | 读、执行 |
| `bundles`（companion 打的 bundle） | 读、执行 | 修改 | — |
| `state\v2\*`（S13，ACL 迁移新建） | `receipts` 只读 | — | 修改 |
| `state`、`work`、`outbox` | 修改 | 只读 | `work` 可读、执行 |
| `broker\requests` | 只能新建文件、列目录、读（没有 DELETE，MINOR-2） | — | — |
| `broker\responses` | 只读（代理是 SYSTEM，自己写） | — | — |
| `inbox`、`requests` | 修改 | 只能新建文件；已有的文件只读（MINOR-9） | — |
| `mailbox\requests` | 修改 | 只读 | — |
| `mailbox\responses` | 只读 | 修改（回答 + 心跳） | — |

- “只能新建”的投放目录（`inbox`、`requests`、`broker\requests`）：目录 ACE 只给新建文件，文件上的继承 ACE 只给读，另加一条 OWNER RIGHTS（`OW`）ACE，去掉文件所有者隐含的 WRITE_DAC，所以文件建好之后谁也改不了它的内容（创建它的那个句柄保留创建时要的权限，这条 NTFS 行为在 P2 确认）。离线测试逐条检查这些 ACE（`windows/test-resident-windows.ps1`）。
- 安装记录在 `install\`，常驻 SID 只读，所以常驻账户篡改不了卸载时要用到的东西。
- runner 服务**完全不修改**：安装和卸载都要求它的 SDDL 与安装时记录的一字不差。
- 真机首装补的两条（2026-10-21，TURING）：
  - `resident\` 根目录给 clued-control 一条只针对本目录的 `0x120080`（READ_CONTROL、SYNCHRONIZE、读属性），不继承。通用助手打开每个输入之前，会先以 READ_CONTROL 打开它的每一级父目录（`FormalPublicBoundaryV2.Parents`），之前根目录不给 clued-control 任何权限，助手在预检里以服务退出码 20 退出。安装计划已包含这一条（`Get-AclPlan ''`）。
  - v1 的 `C:\ProgramData\CluedIndependentCI\state` 原来给 clued-control 一条 `(A;OICI;0x1301bf;;;clued-control)`，作用于目录本身。v2 助手只允许 clued-control 在 `state\v2` 以下有写权限（v1 允许整个 `state`），它打开 `state\v2` 的父目录 `state` 时，以 `UNTRUSTED_PUBLIC_MUTATION_RIGHT_REFUSED` 拒绝。真机上这条 ACE 已改为仅继承（`OICIIO`，子目录权限不变），另加一条只针对本目录的读和列目录（`0x1200a9`）。改之前，在提权环境下用真实的 `FormalPublicBoundaryV2` 对真实路径跑过一遍，唯一的拒绝就是这一条；改之后通过。代价是 v1 一次性工具不能再在 `state` 本身下新建条目，v1 的角色策略也在 2026-10-21 18:45Z 到期。新主机安装前要满足这条前提：clued-control 在 `state` 本身没有写、删除和改权限的权利。`migrate-acl.ps1` 和 `acl-model.json` 属于 Source 闭包，本次不改。
  - companion 以 Owner 身份（不提权）运行桥的转交（`relay-public.ps1`，以及 `formal-spool-acl.ps1 -RelayReadOutgoing`）。转交前它要以 READ_CONTROL 打开 spool 的每一级父目录，但 Owner 原来对 `C:\ProgramData\CluedIndependentCI` 和 `formal-spool` 没有任何权限（v1 的转交在每批 UAC 里提权运行）。第一次真实的第 2 段因此以 `RELAY_REFUSED_NO_RETRY`（`PUBLIC_TRANSFER_UNCONFIRMED`）结束。真机上已给这两个目录各加一条 Owner 的 `(A;;0x120080;;;Owner)`，只针对本目录，不继承，不读内容，也没有写权限。之后用 Owner 不提权实测：三处的 `formal-spool-acl.ps1` 转交检查都通过，每一级父目录都能 hold 住。新主机安装前要满足这条前提。

### 8.4 companion 计划任务

- `\Clued\CluedCIResidentCompanion`：主体 Owner，Interactive，RunLevel Limited（不提权），AtLogOn 触发；任务 DACL 只让 SYSTEM 和 Admins 修改。
- 限制：只在 Owner 登录时运行，锁屏也算登录。重启后没有登录，执行器只推迟、不执行。

### 8.5 提权脚本只从已安装副本运行，并且不把令牌交给用户环境（复核 M1）

- **运行位置**：verify、rearm、uninstall 会先检查 `$PSCommandPath` 位于 `resident\resident\<sha>\windows\` 下（管理员专用），否则拒绝。调用方式统一为 `powershell.exe -NoProfile -NonInteractive -File <已安装副本>`。
- **模块路径**：每个提权脚本开头把 `$env:PSModulePath` 重置为系统模块目录，`ScheduledTasks` 按全路径导入，用户模块目录不会参与自动加载。
- **不把管理员令牌交给 node**：
  - 提权的复位或恢复不启动 node；
  - verify 需要 node 校验回执链时，用清空后的固定环境启动，所以 `NODE_OPTIONS` 之类的用户变量不起作用；
  - inspect 只在不提权时运行。
- **编译**：install 在管理员专用的 `bin\` 里运行 csc，带 `/noconfig`，所有引用都写全路径。
- **安装脚本自身**：install 只运行一次，必须从 Owner 在提权窗口里核过哈希的副本运行（计划会打印 `installScriptSha256`，那是脚本自报的值，Owner 要用 `Get-FileHash` 独立核对）。

---

## 9. Linux：systemd unit

- **为什么用 systemd**（Decision `0d84ddbb` 第 3 项）：
  - 每个作业有独立的 cgroup，cgroup v2 的 `cgroup.events` 一项就能证明整棵子树的进程都已退出，不再需要重启内核；
  - oneshot 模板不常驻 root 进程；
  - 日志进 journald。
- **三个模板**（`linux/systemd/`）：`clued-ci-worker@<jobId>`、`clued-ci-wsprep@<batchId>`、`clued-ci-archive@<batchId>_<reason>`。共同约束：
  - 不 enable，只由 companion 显式 start；
  - `TimeoutStartSec=infinity`、`Restart=no`、`SendSIGKILL=no`：systemd 从不因超时杀作业；
  - docker 依赖用 `Wants=` 而不是 `Requires=`，docker 重启不会把停止信号传给作业；
  - 每个 unit 的 `ExecStartPre` 都是 guard：
    - 按安装路径校验所有钉住的文件：工具本身、unit 文件，以及 unit 实际执行的外部入口（node、`linux-worker.mjs`、`prepare-workspaces.py`）；
    - 校验实例名；worker 的实例名必须等于 `incoming/issue.json` 里的作业；
    - 同一时刻只允许一个 clued-ci unit 活动。
- **加固**（MINOR-7 之后 wsprep 和 archive 也有 `CapabilityBoundingSet=CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH`、`SystemCallFilter=@system-service` 外加拒绝 `@privileged @mount @debug @module` 等、`RestrictNamespaces=yes`）：`NoNewPrivileges`、`ProtectSystem=strict`、`ReadWritePaths=/var/lib/clued-independent-ci`（worker 另加 trivy 角色的缓存根 `-/var/lib/clued-independent-ci-trivy-cache`，`-` 表示缓存根不存在时不让所有 worker 单元在命名空间建立时失败：它与状态根平级，trivy 在那里取 `prepare.lock`、暂存并激活 DB 与 checks 代；首次常驻 trivy 作业因它只读在第一个容器之前以 EROFS 结束）、`PrivateTmp`、`PrivateDevices`、`ProtectKernel*`、`RestrictAddressFamilies=AF_UNIX`、`IPAddressDeny=any`、最小 CapabilityBoundingSet。`PrivateTmp`、`ProtectHome` 可能影响 docker CLI 的配置或挂载，每一项都要在 P2 演练里确认。
- **启用 systemd 与 cgroup v2**：
  - `/etc/wsl.conf` 没有 `[boot] systemd=true` 时：先把原文件复制为 `wsl.conf.before-resident-<UTC>`，再原子替换。已有 `[boot]` 段但没有 systemd 时，脚本拒绝，由 Owner 手动编辑，不自动合并段落。
  - 替换后需要 Owner 做一次 `wsl --shutdown`，再用保存的计划运行 `--continue-after-boot`。
  - 要求 cgroup v2，没有就拒绝（§15 D6）；要求 `docker.service`（§15 D4）。
- **WSL 保活**：companion 维持一个 `wsl --exec /bin/sleep infinity`。

---

## 10. ws-prep 与第 8 段

### 10.1 ws-prep

1. 执行器在导出时写公开描述符 `outbox\<batchId>\descriptor.json`。
2. companion 在第 1 段**之前**用 Owner 的 git 凭据运行 `build-bundle.ps1 -BatchId`，规则同今天：只用 https、关闭 hooks、refs 等于 ls-remote、main 等于 base、按 SHA 取已审查提交。
3. 第 1 段准入之后写 `10-started`。
4. companion 启动 `clued-ci-wsprep@<batchId>`，由 root：按内容重算作业 id、核对已安装 Source 和角色策略、密封 bundle（ls-remote 时间不超过 2 小时）、`fsck --full --strict`、只允许 100644 和 100755 的 blob、建 root:root 0700 工作区。MINOR-7：候选的 head 树先在对象库里核对模式（只许 100644、100755），**然后**才检出，检出带 `core.symlinks=false`、`core.protectNTFS`、`core.protectHFS`，所以 root 从不写出符号链接或子模块。（以非 root 身份检出没有采用：工作区必须是 root:root，换身份要加 chown 步骤，留作 P2 评估。）

全程不执行 PR 内容。

### 10.2 第 8 段

- 今天：5 分钟内要写 ready marker，而 marker 只做格式检查，不是授权；真正的核验是控制发布者实时读合并队列（`queue-facts.mjs:2-7`）。
- Source v2（S8）：删掉 marker；控制助手每 30 秒用 ci-admission Binding 只读核一次：该 claim 是队首、合并位没过期、tip 等于 base。满足就发布一次；到窗口上限仍不满足，就以 `RESIDENT_QUEUE_HEAD_NOT_REACHED` 干净失败。
- claim 持有者只需按合同 A.6 让就绪的 PR 留在合并队列里，续租由机制自治（resident constraint a8ff16a7）。

---

## 11. 审计回执

- **本地哈希链**（`src/receipts.mjs`）：每条记下上一条字节的 SHA-256，删除、改序、改字都会被发现。每次追加都重新取链头。凡涉及某个触发或请求文件的回执，都记下当时读到的那份字节的 SHA-256，所以之后改动归档副本能被查出来。
- **安装和卸载回执**：在 `install\`，只有管理员能写。复位与恢复由服务写回执（`owner-request` 或 `owner-request-refused`）。
- **KooYomi**：执行器、代理和 companion 都没有 KooYomi 写凭据，这是刻意的，不新增秘密。由 Agent 按合同 §3 把关键事件写成 Note，引用回执链头哈希（observed）。

---

## 12. 安装、校验、卸载，以及人工步骤对照

| 动作 | 命令 | 权限 |
|---|---|---|
| 安装记录 | `node CI/src/resident-v2/prepare-record.mjs --inputs … --source-root <checkout> --closure CI/src/resident-v2/source-closure.json --out …`（每次 Source 接受做一次） | 普通 |
| 打包 | `node tools/build-package.mjs --out … --policy … --companion … --node … --record <上一步输出> --source-root <checkout> --source-files <闭包里的路径> --linux-external-pins …` | 普通 |
| Windows 预检 | `install-resident.ps1 -PackageRoot … -ExpectedPackageManifestSha256 … -OwnerSid … -ControllerSid …`（只读，打印计划及其哈希） | 普通 |
| Windows 安装 | 同上，加 `-Apply -ExpectedPlanSha256 <复审过的>` | **UAC 1 次** |
| Linux 安装 | `install-resident-linux.sh --plan` 之后 `--apply <sha>`；需要启用 systemd 时，再 `wsl --shutdown`，然后 `--continue-after-boot <sha>`。MINOR-6：`--apply` 先把包里的文件复制进新的 root 0700 暂存目录，从这份副本算计划、只从这份副本安装；计划绑定脚本自身的哈希和每个包文件（含 `manifest.json`）；整个程序是一个函数，不再 `exec "$0"` 从磁盘重读 | **root 1 次**，可能加 1 次 WSL 重启 |
| Linux Source v2 安装（v0.7） | 先由 root 签 qualification v2（单独审查的步骤）；`clued-ci-install-source-v2 package …`（普通、离线）打包，然后 `--plan <包>`，再 `--apply <包> <planSha256>` | **root 1 次**（与上一行可在同一次 root 会话里） |
| 校验 | 已安装副本的 `verify-resident.ps1`、`verify-resident-linux.sh`（只读） | 提权才能看服务 DACL |
| 卸载 | 已安装副本的 `uninstall-resident.ps1`：先计划，再 `-Apply`；`uninstall-resident-linux.sh` 同理。要求没有未终结批次、执行器进程已不在；删两个服务和任务；runner 保持原样；**整个目录改名保留** | UAC + root |

| | 今天每批 | 常驻后每批 |
|---|---|---|
| UAC | 启动 1 次，rNN 通常再 1 次 | 0 |
| root | ws-prep 1 次，换 claim 时 Linux 重绑 | 0 |
| 5 分钟内写 queue-ready | 1 次 | 0 |
| 每批脚本生成与复审 | 多份 | 0（复审移到 Source v2 一次） |
| 干净失败 | 2×UAC + root + WSL 重启 | 0 |
| 未知失败 | 2×UAC + root + WSL 重启 | UAC 1 次，只写复位请求 |

---

## 13. 测试、演练与复审

### 13.1 已运行（离线，没碰主机）

v0.7 补充（2026-10-21，PR-B 前后的工作流字节 §7.7，转发复审 MINOR §7.5）：

- 第三轮复审 MINOR 之后：Source v2 **159 通过 + 1 跳过**（新增 `hosted-relay-stage.test.mjs`、`hosted-relay-registry.test.mjs`、`hosted-relay-attest.test.mjs` 各 1 个：trivy checks 摘要、所有 `.gitattributes` 钉值、E4；`pr-a-review.test.mjs` 的 v1 钉值用例改为核对完整的传递闭包）；Python **6/6**；常驻层 **107/107**、Python **23/23**、演练 **35/35**；准入 **98/98**。下面几条是这一轮之前的数目。
- Source v2：`node --test test/*.test.mjs worker/image-identity.test.mjs` **156 通过 + 1 跳过**（新增 `trusted-workflow-pins.test.mjs` 9 个；`formal-gitleaks-v3-required-history.test.mjs`、`resident-v2-bridge.test.mjs`、`hosted-relay-registry.test.mjs` 各 1 个；`hosted-relay-attest.test.mjs` 的 E3、E5 用例加了 `**/.gitattributes` 和其他应用的 run）；Python **6/6**。
- 常驻层：`node --test test/*.test.mjs` **107/107**；Python **23/23**；`node drill/offline-drill.mjs` **35/35**。
- `node --test scripts/ci/clued-work-admission.test.mjs` **98/98**。
- 临时分支：在结果上合入当时冻结的 PR-B 提交，上面几组的数目完全一样。`scripts/ci` 全部测试：node 801 通过、29 失败，Python 78 个里 2 个出错；这 31 个在 main（`8710e92c`）上同样失败（main 上 node 777 通过、32 失败，Python 74 个里 2 个失败、2 个出错），没有新增失败，PR-B 还修好了 main 上的 5 个。

v0.7（2026-10-21，转发集成之后）：

- 常驻层：`node --test test/*.test.mjs` **107/107**（含 `review.test.mjs` 7 个复审复现用例）。新增：
  - `relay.test.mjs` 16 个：段序 1 → R → 本地子集 → 8；`20-plan-intent`/`25-plan`；不阻塞的有上限等待；等待中暂停（停在第 R 段之前，只有 Owner 能恢复，按保存的 t0 继续）；等待中 Owner 复位；等待中重启（不重跑第 1 段）；服务循环每轮刷新锁、等待中照样响应 STOP；账单拒绝立即全本地；同一 head 内转发与本地混合；发布不确定 HALT 且不再有本地段；计划行不干净；第 R 段崩溃恢复；托管晚到；转发后不排 attempt 2；损坏的提示；
  - `hints.test.mjs` 6 个：提示映射；经 Source 观察器（提示模式）到邮箱再到执行器解析的端到端；邮箱的提示文件；轮询器的观察窗口；gh 只读端口；引擎的第 R 段和动态选项。
- 常驻层 Python **15/15**（新增 4 个 Linux Source v2 安装器用例）；`node drill/offline-drill.mjs` **35/35**（新增 12 步：一个月的免费分钟情形、回执类型和顺序、等待中的急停与 Owner 恢复）。
- Source v2：`node --test test/*.test.mjs` **137 通过 + 1 跳过**（含复审用例：`pr-a-review.test.mjs` 5 个，`hosted-relay-stage.test.mjs` 新增 2 个，结算转发的漂移撤销、v1 本地路径不拿 K；新增 `hosted-relay-v2.test.mjs` 12 个：第 R 段的包导出、计划行、阶段事实、第 9 段 invoke-stage、v2 发布者的 K 互斥与 claim 代次）；Python **6/6**；`test-migrate-acl.ps1` **12 例**；`test-pure-v2.ps1` **88 条**断言；`SwapBroker.cs` 编译通过。
- `node --test scripts/ci/clued-work-admission.test.mjs` **97/97**（含合入的 A1 重新登记用例和 2 个 v2 消费者用例）。

v0.6（2026-10-21，Source v2 实现之后）：

- 常驻层：`node --test test/*.test.mjs` **67/67**（新增 attempt 2、目录镜像、引擎 v2、companion v2、保留提醒、打包 v3）；`python -I -B -m unittest discover -s test -p "test_*.py"` **11/11**（扁平名字、完成型范围拒绝、树核对、partial 状态、archive-usage）；`node drill/offline-drill.mjs` **23/23**（新增 3 步：bundle 之后推送 → attempt 2 → 完成；第 3 段之后的同类失败不重试）。
- Source v2：`node --test CI/test/*.test.mjs CI/worker/image-identity.test.mjs` **84 通过 + 1 跳过**（原有 44+1 不变；新增合约、阶段、准入、发布者、bridge v4、闭包）；`python -I -B -m unittest discover -s test -p "test_*.py"`（在 `CI/` 下）**6/6**；`windows/test-archive-windows-spool.ps1` 13 例、`test-migrate-acl.ps1` 11 例、`test-build-bundle.ps1` 10 例，都只在 `%TEMP%` 的夹具里运行；`test-pure-v2.ps1` 编译通用助手和测试宿主（scratch）并跑 **78 条**断言；`SwapBroker.cs` 连同 `ResidentScmV2.cs`、`ScmPidHandshakeV2.cs` 编译通过；所有新增和改动的 PowerShell 脚本语法检查 0 错。

v0.5 时的记录：

- `node --test test/*.test.mjs`：**53/53**。覆盖：
  - 账本：一次性、按 head 烧号（base 或 PR 变了也烧）、未完成条目；
  - HALT 比较交换、崩溃恢复（HALT 时也做）、Owner 复位与恢复请求（过期摘要、没有静止证明都拒绝）、伪造的恢复请求被忽略；
  - 回执：防篡改，其他进程追加也不分叉；
  - 归档：白名单、junction、硬链接、父目录重定向、effect journal 留在原处；
  - 先打 bundle 再跑第 1 段；第 1 段的其他失败也烧号；
  - 清理证明现取（Linux 忙、Windows 有子进程，都 HALT）；
  - 评估和执行分开限速；
  - 邮箱格式、companion 的固定 argv、泵的顺序、心跳位置；
  - 轮询器、sc 回读解析（含账户）、单实例锁的存活记录、打包（目标路径白名单、Linux 安装路径、外部入口）。
- `python -I -B -m unittest discover -s test -p "test_*.py"`：**9/9**，覆盖 Linux 工具：实例名、unit 静止、`cgroup.events` 与容器状态都 fail closed、角色间归档只移协议记录、不在名单的名字和多链接文件、改名前后哈希。
- `node drill/offline-drill.mjs`：**20/20**。
- 4 个 PowerShell 脚本语法检查 0 错；3 个 shell 脚本 `bash -n` 通过；`ResidentServiceHost.cs` 和 `SwapBroker.cs` 编译通过（输出在 scratch）。这些都只证明语法正确，没有在主机上执行。

### 13.2 还要做的验证（按顺序，每步前 Owner 都有一次 go/no-go）

- **P1**：实现 Source v2（S1–S14）及其 Source 内单元测试。**v0.6 已离线完成**（§7.1、§13.1）。
- **P2 必须在主机上证明、离线证明不了的东西**（Source v2 之后的清单）：
  - 交换代理以 SYSTEM 真实切换、启动一次、还原；`--stable-digest` 在提权安装时的读取；与 v1 互斥量的真实互斥；PID ACK 事件；`BROKER_BUSY` 时不碰状态；
  - 通用助手在 Session 0 以 clued-control 启动 node 入口、写回执、进程树清理；`hold-record.ps1` 的句柄租约；
  - ACL：迁移工具真实写入的掩码（含 SDDL 规范形式）、常驻 SID 能做而且只能做的事、`formal-spool-acl.ps1` v4 对迁移后 ACL 的放行；b22 判据在真实 spool 上；
  - 四个入口对真实 GitHub 和 Native：批次 claim 记录、续租、队列等待、检查发布与回读、证据冲突撤销；
  - Linux：角色策略 v3 与 qualification v2 的签发（需要用 Linux 结果密钥对新的 v2 载荷签名，这是安装步骤）、`/opt/clued-independent-ci/source-v2` 与 `formal-source-manifest-v2.json`、三个 v4/v2 适配器在 root 和 Docker 下运行、`refsInStore`、`blocked` 记录、`releaseClean`；
  - relay v4 从 `resident\source\<sha>` 运行、bundle 清单哈希、challenge 优先的泵顺序；
  - Linux 工具的扁平归档在真实目录上、`ROLE_LOCK_HELD_PRESERVED` 与 partial 状态、`archive-usage`；
  - 安装脚本：record、stage、bundles 目录、助手编译、`broker.json`、ACL 迁移的调用。
  - **v0.7 转发集成新增的主机项**：
    - 托管运行的 OIDC 声明实际取值（免费分钟设计 L1：pull_request 事件下 `sha`/`workflow_sha` 是否就是合并提交，`base_ref`、`head_ref`、`runner_environment`、`check_run_id` 是否存在）；注解能否完整容纳 JWT、5368905 能否读到（L2）；`refs/pull/N/merge` 移动后旧合并提交能否按 SHA 读到（L3）；clued-control 环境访问 `token.actions.githubusercontent.com` 的网络路径（L4）。这些要等免费分钟恢复后才能测，所以转发默认关闭；
    - 第 9 段经真实交换代理和通用助手运行：stage 表、时间窗、`relay-publisher` 入口、子集作业的 C# 校验；
    - `state\relay\jwks` 的真实 ACL 和 JWKS 文件缓存；
    - 转发入口用 held record 核对登记表字节，在真实安装记录上运行；
    - companion 提示模式在 Owner 会话里加载已安装 Source 的观察器，gh 只读端口对真实 API 的分页和规范化；
    - 等待中的服务循环在真机上的行为（WAITING 的休息间隔、锁存活记录、STOP），以及等待中重启后从 `15-relay-wait` 继续；
    - v2 消费者以 clued-control 运行（评估器调用路径、held record、batch-claim 扫描的上限）；
    - Linux Source v2 安装：先由 root 用 Linux 结果密钥签 qualification v2（单独审查的步骤），再 `--plan`/`--apply`；在真实 WSL 上验证 bundle 克隆、文件属主和权限、`loadQualifiedPolicyV2` 就绪检查、以及 `prepare-workspaces.py` 对受信检出的核对。
- **P2**：主机隔离演练。演练名包括 `CluedCIResidentRehearsal`、`CluedCISwapBrokerRehearsal`，以及专门的哑 runner 服务 `CluedCIRehearsalRunner`。要验证的点：
  - 代理只改二进制路径、账户不变；
  - 常驻账户对哑 runner 没有任何权限；
  - ACL 掩码；
  - Linux unit 名加 `-rehearsal` 后缀，使用独立的 state 根；
  - cgroup v2 和每一项加固；
  - 真实容器跑三角色。

  不碰正式 runner、正式 spool 或正式凭据。
- **P3**：独立复审 Source v2、安装计划和 ACL。
- **P4**：Owner 接受 Source v2，然后 Windows 安装（UAC）、Linux 安装（root），再只读校验。
- **P5**：第一个常驻批次选一个低风险 PR，观察整条回执链。

### 13.3 v0.1 的独立复审（FAIL）与 v0.2 的修正

| 发现 | 修正 |
|---|---|
| **X1** 归档按路径遍历、改名 Owner 可写的目录树，可被 junction 利用；复位时还以提权身份运行 | 只碰精确白名单，不递归；拒绝链接和多链接文件；核实父目录。主机上换成基于句柄的 Source v2 工具（S14）。复位只写请求，归档由服务以受限身份完成 |
| **M1** install 在哈希之后又重读清单；`target` 没有校验；提权脚本从用户目录运行 | 清单只读一次，哈希和解析用同一缓冲区；每个文件读一次、比对、写同一份字节；`target` 白名单；提权脚本只从已安装副本运行 |
| **M2** 把改配置权委派给常驻账户等于 SYSTEM | 常驻账户对 runner 零权限；交换代理只改二进制路径，只用白名单里的助手（S1、S12） |
| **M3** 主线一动，失败的 head 就换个键自动重跑；换 PR 号也一样 | 按 (repo, head, Source, attempt) 烧号 |
| **M4** 第 1 段已发布检查后，bundle 失败却被当作“未执行”释放；effect journal 被收尾归档走 | 先打 bundle 再跑第 1 段；第 1 段除未准入外的失败都烧号；effect journal 不在白名单里（S13） |
| **M5** 清理证明不完整：Linux 半边来自 companion 自报；Windows 独占阶段写死为 true；cgroup 判断 fail open；docker 只看 running | 失败时现取两端证明；`cgroup.events` 加 cgroup v2，读不到就不静止；`docker ps -a` 要求全部 exited 或 dead；补上威胁模型（§3.3） |
| **M6** 卡死：循环异常留下未终结条目，HALT 时又跳过恢复；其他进程追加回执会让链头过期 | 每 tick 先恢复（含未完成条目）；复位由服务执行；回执每次追加都重取链头 |
| **M7** 多处接线缺失：心跳路径不可写、没写描述符、Linux 钉的是包内路径、缺角色间归档、复位和校验的路径写错、Linux 续装时重算计划 | 心跳移到 `responses\`；导出时写描述符；Linux 清单按安装路径并包含外部入口；第 4、6 段之前做角色间归档；复位改为请求文件；校验路径修正；续装用保存的计划 |
| MINOR | 有界读取（一个句柄，不留检查与读取之间的空隙）；回执记字节哈希；安装记录放进管理员专用目录；`Wants=`；每个归档实例一个状态文件；卸载核对执行器进程；`failureflag`；锁的存活记录；`wsl.conf` 保留原件、不合并段落；`COMPUTERNAME` |

---

## 14. 风险与残余问题

- **R1 contract-placement 会在容器里运行 PR 的测试和构建**（`container-entry.mjs:33-70`）。这是现状，隔离只有容器：uid 65532、无网络、只读、cap-drop ALL、不挂密钥。本设计不扩大它，但对这个角色，“PR 代码只当数据”并不成立。
- **R2 Linux 用同一把 Ed25519 密钥签 qualification 和结果**，任何 root 进程都能读到。常驻前后一样。可以后续拆成两把。
- **R3 磁盘增长**：只改名、不删除，工作区副本会一直累积。需要 Owner 定保留规则（§15 D5）。
- **R4 companion 依赖 Owner 登录。** 没有登录时只推迟，不会出错。
- **R5 常驻 SID 被攻破**：能让代理启动已审的助手跑任意作业输入，助手里的 node 代码照样做实时准入；还能拒绝服务。拿不到 SYSTEM，也不能以 clued-control 身份运行任意代码。交换代理本身是 SYSTEM 级的新攻击面：它的输入只有 5 个字段，助手路径由阶段号推出，按阶段名精确比对白名单，只返回固定错误码。
- **R6 trivy 缓存的 `prepare.lock`**，在不确定结局下会留下（`cache.mjs:160`），复审时确认 Linux 归档是否要把它纳入。
- **R7 ACL 掩码与 SDDL 规范形式**：P2 时确认。
- **R8 时钟**：bridge 的回调窗口（120 秒）跨 Windows 和 WSL 两个时钟。常驻后 VM 不再冷启动，风险变小，但没有消除。
- **R9 先进先出按文件名排序**：触发记录的文件名由生产者定，可以抢到队头；后果被评估上限约束。冷却中的 head 不会挡住后面的 PR。
- **R10 提权 .NET 进程继承 Owner 的环境变量**（例如 `COR_ENABLE_PROFILING`）：今天每批的 UAC 启动就有这个问题，常驻后只剩安装、升级、卸载、复位、恢复这几次提权。本设计对自己启动的子进程清空了环境，对 PowerShell 本身清理了模块路径；`powershell.exe` 自己的进程环境挡不住，这是现有 Windows 行为。
- **R11 归档后的触发副本仍归 Owner 所有**：Owner 仍可改动或删除它们，回执里记的字节摘要能发现改动，但挡不住。另外，“中等完整性的进程能否给只读文件建硬链接”要在 P2 确认；能建的话，账本条目会被标为 UNREADABLE 并隔离（M6e 已覆盖）。

---

### 13.4 复核（v0.2 → v0.3，FAIL：BLOCKER 已清零，3 个 MAJOR 有残留）

| 发现 | 修正 |
|---|---|
| **M1 残留**：提权的 rearm、verify 用继承的用户环境启动 node（`NODE_OPTIONS` 可导致提权）；`ScheduledTasks` 按用户 PSModulePath 自动加载；csc 从当前目录解析引用 | 提权的请求写入改用纯 PowerShell；inspect 只在不提权时运行；verify 用清空的环境启动 node；PSModulePath 重置，模块按全路径导入；csc 在 `bin\` 里运行，带 `/noconfig` 和全路径引用；新增 R10 |
| **M6a**：`owner\` 只增不减，处理过 8 个之后再也读不到新请求 | 已处理的请求按文件名跳过，跳过发生在计数之前（测试：12 个过期请求之后，第 13 个仍被执行） |
| **M6b**：同样理由的重试被静默丢弃 | 请求带时间和 nonce；重复的摘要会写 `owner-request-duplicate` 回执 |
| **M6c**：崩溃或循环异常导致的 HALT 不带 key，复位什么都没归档 | 复位归档所有还没归档的 FAILED_UNKNOWN 条目，并标记 `95-archived`（测试断言两端归档确实执行了） |
| **M6d**：Linux 归档实例无法重试 | 同一实例再运行，返回上次的已核实结果 |
| **M6e**：`recover()` 抛异常就挡住所有 Owner 请求 | 无法读取的条目标为 UNREADABLE，关不掉就隔离；恢复失败时先锁 HALT，仍处理 Owner 请求 |
| **M7 新增**：`RegisterTaskDefinition` 用了标志 1（只校验） | 改为 6（`TASK_CREATE_OR_UPDATE`），并回读主体和运行级别 |
| 次要 | 代理请求增加 `configSha256`，白名单按阶段名精确匹配，只返回固定错误码；目录创建时就带最终 ACL；`--continue-after-boot` 核对已安装清单与保存的计划；阶段证明里出现的字段必须为 true；冷却中的 head 不挡队列 |

### 13.5 第三轮复核（v0.3 → v0.4，FAIL：上轮残留全部关闭，但修正引入 2 个 MAJOR，另有 1 个旧 MAJOR）

| 发现 | 修正 |
|---|---|
| **MAJOR 1** 复位用失败码当归档原因；失败码以 `between-roles` 开头时，Linux 只移协议记录，留下 `formal-role.lock`、`runs/` 和工作区，却报告已核实 | 复位归档原因固定为 `rearm-unknown-failure` 或 `rearm-quarantine`；Linux 工具和 `archive.mjs` 只把恰好 `between-roles-[46]` 当作协议范围（Node 和 Python 测试都覆盖） |
| **MAJOR 2** 隔离绕过烧号和“复位必须先归档”；任何 I/O 错误都会让条目变成 UNREADABLE | 只有内容错误才算 UNREADABLE；隔离前先烧 head；隔离条目在归档前挡住 `clearHalt`；复位会归档隔离条目的现场（找不到批次描述符时不动工作区）；测试确认隔离后同一 head 不会再跑 |
| **MAJOR 3** 过期的代理请求仍会执行，并把 runner 留在助手二进制上 | 截止时间不足 2 分钟或已过期的请求直接拒绝；每轮循环把“停在已安装助手上”的 runner 换回原始二进制 |
| 次要 | Owner 请求读取失败 3 次才作废这个文件名；恢复失败且 HALT 写不进时不执行候选；计数器遇到损坏记录时按“已计入”处理，不会卡住；`inspect` 显示 HALT 涉及的全部 key、待归档项和隔离项；计划任务回读要求主体 SID 与 Owner 完全一致；`earlier_result` 不再泄漏文件句柄 |

### 13.6 第四轮复核（v0.4 → v0.5，FAIL：MAJOR 3 只修了一半，新增 N1）

| 发现 | 修正 |
|---|---|
| **MAJOR 3**（未关闭）：重启后代理先于常驻服务启动，还会处理切换中断的请求，把同一阶段的助手再启动一次；普通用户就能重启机器 | 动手前先写只能新建的领取标记；有标记没回复的请求，以及代理启动前就存在的请求，一律只答复、不执行（C# 编译通过；行为要在 P2 演练里确认） |
| **N1**：隔离和 HALT 不是崩溃一致的；标记文件损坏时复位会卡住 | 先锁 HALT 再写终态；先写标记再移动；复位的视野包括每个目录和每个标记，损坏的也算；新增持续闸门；`clearHalt` 同时要求两类现场都已归档；损坏的 HALT.json 也能复位（新增 3 个测试） |
| 次要 | 隔离的替身批次 id 改用隔离自己的 nonce（保证唯一）；`unexecutedSince` 遇到损坏记录不再抛异常 |

### 13.7 第五轮复核（v0.5，PASS）与剩余次要项

结论：MAJOR 3 和 N1 都已关闭，没有新的 BLOCKER 或 MAJOR。复审代理确认：

- 领取标记只有代理能写；
- 创建时间的判断只会往安全的方向出错；
- 新增的检查不会让 HALT 永远清不掉。

PASS 之后又修了三个次要项。这三处只经过测试验证（53/53），没有再复审：

- 损坏的 PAUSED.json 按 HALT 的规则处理，新增 1 个测试；
- Linux 工具的 `intent`、`receipt` 和状态文件写完后 fsync；
- `.taken` 写穿到磁盘。

留到 P2 主机演练时处理的次要项（都朝安全方向失败）：

- 最后一条回执写坏时服务起不来；
- `ledger-quarantine` 里出现意外的名字时会被忽略（目前只有常驻服务会写这个目录）；
- 有人持有 state 文件不放时，可以反复制造孤立的隔离标记（只是拒绝服务）；
- Windows 的“没有残留进程”证明只看本进程的子进程：服务异常退出时，超时的子进程会成为孤儿；
- 交换代理、`recover()` 的 HALT 顺序、Linux 缺描述符时的复位分支都还没有离线测试。

### 13.8 PR-A 独立复审（权限边界）的修正（分支 `claude/pr-a-priv-fixes-20261021`）

| 发现 | 修正 | 测试 |
|---|---|---|
| **MAJOR-1** 常驻服务保留默认服务特权（含 `SeImpersonatePrivilege`），安装不设、校验不查 | `sc privs CluedCIResident SeChangeNotifyPrivilege`；代理 `SeChangeNotifyPrivilege/SeCreateGlobalPrivilege`；两个宿主启动时读真实令牌、多余就拒绝、写记录；安装回读 `sc qprivs` 和令牌记录进回执；verify 核对两者 | `test-resident-windows.ps1`（`sc qprivs` 解析、令牌记录判定）；`BrokerPureTests.cs`（真实读本进程令牌、允许名单判定） |
| **MINOR-2** 先读后限长；`broker\requests` 给了 DELETE；枚举不在 try 里；代理没有失败动作 | `ReadBounded`（先看长度，最多读 4097 字节）；目录 ACE 只能新建、文件只读、OW；枚举和单个请求都包在 try 里；`sc failure` + `failureflag` | `BrokerPureTests.cs`（4096 可、4097 和 512 MB 拒绝）；ACE 逐条检查 |
| **MINOR-3** 互斥量和 runner DACL 信任 Owner 用户 SID | 管理者只有 SY、BA；`broker.json` `/2` 去掉 Owner SID；DACL 里非 SY/BA 的控制权一律拒绝 | `PureTestsV2.cs`：实测 SDDL 通过，Owner/IU/SU 带 8 种控制权各被拒绝，Owner 当所有者被拒绝，互斥量带 Owner ACE 或 Owner 所有者被拒绝 |
| **MINOR-4** verify 不查服务 DACL、代理路径和配置哈希；安装不查 `sc` 退出码 | verify 比对两个服务的 `sdshow`（安装时记入回执）、代理二进制路径 + 配置哈希参数、`broker.json` 哈希、失败动作；安装里每个改动性的 `sc` 调用都经 `Invoke-Sc` 检查退出码 | 静态检查：除只读的 `qc/queryex/sdshow` 外没有未检查的 `sc` 调用；`Invoke-Sc` 遇非零退出码抛出 |
| **MINOR-5** 常驻服务可以出网 | 按服务 SID 的出站阻断规则；卸载时删除；verify 检查规则和防火墙开启 | 计划与安装脚本内容检查；规则本身要在 P2 主机上确认 |
| **MINOR-6** Linux 安装从可变的包目录复制、计划不绑定清单、`exec "$0"` | 暂存副本、计划绑定脚本与所有包文件、单进程完成 | `test_linux_privilege.py`（计划内容、硬链接拒绝、顺序与无 `exec`、`bash -n`） |
| **MINOR-7** wsprep、archive 缺能力/系统调用/命名空间限制；检出前不查模式 | 两个 unit 的 `CapabilityBoundingSet`、`SystemCallFilter`、`RestrictNamespaces`；先查模式、`core.symlinks=false` 检出 | unit 内容测试；模式检查在检出之前 |
| **MINOR-8** Linux 归档信任描述符里的作业 id | 按内容重算，不一致拒绝；`O_NOFOLLOW` 句柄读取 | 与 `prepare-workspaces.py` 的公式交叉验证；伪造列表、内容改动、坏格式都拒绝 |
| **MINOR-9** `inbox`、`requests` 对 Owner 不是只能新建 | 目录只给新建文件，文件只读，OW | ACE 逐条检查 |

主机上仍要确认（P2）：`sc privs` 之后两个服务的真实令牌、`SeCreateGlobalPrivilege` 对代理是否必需、出站规则对服务子进程生效、创建句柄在只读继承 ACL 下仍可写入、WSL 内核上的 seccomp 过滤和能力边界不影响 git、docker CLI 和 systemctl。

## 15. 需要 Owner 决定的事

- **D1 是否按本设计进入 Source v2 实现（P1）**，以及是否把本草稿提交为 PR（只含 `work/independent-ci-resident-v1/` 新文件）。
- **D2 `validUntil`**：**已决定**（Decision `1b5d3687`）：为空，直到 Source 变更或卸载。
- **D3 同一 head 的 attempt 2**：**已决定**（Decision `1b5d3687`）：自动 attempt 2 一次，只针对白名单里的干净暂时性失败、而且还没有角色发布过（§7.2）。
- **D4 Docker 由 systemd 管理**：**已确认**主机上已是 `docker.service`，不需要迁移代码。
- **D5 工作区保留规则**（R3）：**已决定**：只改名、从不删除；超过 50 GB 写提醒回执（§7.3）。
- **D6 cgroup v2**：**已确认**主机上 WSL 已启用 systemd 和 cgroup v2，不需要迁移代码。
- **D7 交换代理**：**已接受**（Decision `1b5d3687`）`CluedCISwapBroker`。

---

## 附录 A：草稿文件

| 文件 | 作用 |
|---|---|
| `src/canonical.mjs`、`store.mjs` | 规范 JSON、哈希、CreateNew、有界读取、只改名 |
| `src/ledger.mjs` | 账本、按 head 烧号、未执行释放、HALT/PAUSE 比较交换 |
| `src/receipts.mjs` | 哈希链回执 |
| `src/trigger.mjs`、`inbox.mjs` | 触发记录格式、有界收件箱、Owner 请求目录 |
| `src/classify.mjs` | 失败分类白名单 |
| `src/policy.mjs` | 安装策略 |
| `src/executor.mjs` | 常驻状态机 |
| `src/archive.mjs` | 协议记录白名单归档（参考实现与离线实现） |
| `src/mailbox.mjs`、`companion.mjs`、`poller.mjs`、`runner.mjs` | companion 协议、泵、轮询、不杀进程的运行器 |
| `src/service-ports.mjs`、`engine-windows.mjs`、`service-main.mjs`、`companion-main.mjs`、`instance-lock.mjs` | 真实端口与入口（引擎依赖 Source v2，缺了就 `SOURCE_V2_REQUIRED`） |
| `windows/install-resident.ps1`、`verify-resident.ps1`、`uninstall-resident.ps1`、`rearm-resident.ps1` | 安装、校验、卸载、复位与恢复请求 |
| `windows/ResidentServiceHost.cs`、`SwapBroker.cs` | 两个服务宿主 |
| `linux/systemd/*.service`、`linux/bin/clued-ci-resident-linux`、`linux/*-resident-linux.sh` | Linux 三个 unit、root 工具、安装、校验、卸载 |
| `tools/rearm-tool.mjs`、`verify-receipts.mjs`、`build-package.mjs` | 查看与请求、回执校验、打包 |
| `config/*.example.json` | 策略与 companion 配置样例 |
| `test/*.test.mjs`、`test/test_linux_tool.py`、`drill/offline-drill.mjs` | 测试与离线演练 |
| `src/attempts.mjs`、`src/retention.mjs` | v0.6：自动 attempt 2 的判定（§7.2）、50 GB 归档提醒（§7.3） |
| `src/hosted-wait.mjs`、`src/hosted-hints.mjs`、`src/gh-read-port.mjs` | v0.7：托管等待与提示解析、companion 的提示模式、gh 只读端口（§7.5） |
| `linux/bin/clued-ci-install-source-v2` | v0.7：Linux 侧 Source v2 安装（§7.6） |
| `CI/src/hosted-relay-v1/relay-entry-v2.mjs`、`relay-plan.mjs`、`CI/src/independent-control-checks-v2/consumer.mjs` | v0.7：第 R 段入口、计划行、v2 控制检查消费者 |
| `CI/src/resident-v2/*`、`CI/src/*-v2.mjs`、`CI/src/formal-work-admission-check-v2/`、`CI/src/independent-control-checks-v2/`、`CI/runtime/one-shot-v2.mjs`、`CI/worker/*-v2|v3|v4/`、`CI/worker/protected-job-bridge-v4/` | v0.6：Source v2 本体（§7.1） |
