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

  - v0.8（2026-10-21）：Owner 中止当前批次（§6.5，Task `56cd9edc`）。一段卡住时 Owner 用一次 UAC 写中止请求，服务在安全点停下正在跑的扫描签发段（经交换代理和助手现有的停止路径），实测两端静止后只改名归档，记 FAILED_CLEAN `OWNER_ABORTED`；证明不成立时照旧 HALT。这一版有自己的独立复审（§13.9），和下面说的五轮复核无关。
  - v0.9（2026-10-22）：排队、限额与故障保护的第一期“看得清，不白烧”（§16，Task `12ada80e`，设计说明 v0.6 加 §9）。包括：
    - 与 Source 无关的已执行记录，重装时带入旧账本并回填；
    - 阶段结果的诊断一路传到执行器；
    - 机器可读的失败对照表；
    - GitHub 暂时错误映射；
    - poller 只提议跟上 main 的提交；
    - status.json、PR 页面状态和 Windows 通知；
    - 批次认领记录的身份去掉 createdAt。

    独立复核结论是“修复后可接受”：没有 BLOCKER，1 个 MAJOR，7 个 MINOR，全部已在 PR 内修正（§16.9）。

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
| **Owner（安装者）** | Owner SID 提权，UAC | 安装、升级、卸载；向 `owner\` 目录写复位、恢复或中止请求 | 每批不再出现；复位时也不移动任何文件 |
| **CluedCIResident 常驻执行器**（新） | `NT SERVICE\CluedCIResident` 虚拟账户，Session 0，非管理员 | 读已安装 Source；写自己的 state、work、outbox；向交换代理提请求；经 Source v2 的句柄工具归档 formal-spool | 对 runner 服务**没有任何权限**；读秘密；加载用户目录里的代码；联网 |
| **CluedCISwapBroker 交换代理**（新） | LocalSystem | 只做一件事：把 runner 的二进制路径在“原始”和“已安装、哈希在白名单里的通用助手”之间切换，带 nonce 启动一次，等它停止，再换回；Owner 中止时向这一次交换的助手发一次 SCM 停止（§6.5） | 改账户、启动类型、依赖、DACL；运行白名单以外的东西；杀进程 |
| **clued-control**（现有，不变） | `.\clued-control`，Session 0 | 跑阶段助手、读秘密，对 GitHub 和 KooYomi 做所有实时核验和发布 | — |
| **companion 伴随进程**（新） | Owner 本人的登录会话，计划任务，**不提权** | WSL 保活；用 Owner 自己的 git 凭据打 bundle；用现有 `relay-public.ps1` 搬运 bridge 记录；`systemctl start` 三个固定 unit；轮询 PR 生成触发记录 | 任何授权判断；任意命令（只有固定 argv）；写执行器的 state 和 owner 目录 |
| **Linux unit**（新） | WSL 内 root，systemd oneshot 模板，带沙箱加固 | worker（不变的 `linux-worker.mjs`）、ws-prep、归档；各自用 root 实测前提 | 由 PR 内容驱动执行代码 |

### 3.2 数据通道（全部 create-only，格式精确；`src/mailbox.mjs`、`src/inbox.mjs`）

```
Agent / companion 轮询器 ──写──▶ resident\inbox\            触发记录 {repo, pr, headSha, baseSha}（只是数据）
任何 Owner 会话进程     ──写──▶ resident\requests\          暂停请求（只能停）；暂停接新请求（§20：最长 2 小时，同一持有者可提前结束）
提权的 Owner（UAC）     ──写──▶ resident\owner\             复位、恢复或中止请求（只有 Administrators 能建文件）
常驻执行器              ──写──▶ resident\mailbox\requests\  给 companion 的固定种类请求
companion               ──写──▶ resident\mailbox\responses\ 回答 + 心跳（不可信，只用于分类）
常驻执行器              ──写──▶ resident\broker\requests\   给交换代理的请求 {stage, nonce, deadline}
交换代理                ──写──▶ resident\broker\responses\  交换结果
常驻执行器              ──写──▶ resident\broker\requests\<id>.stop        Owner 中止：停下这一次交换的助手（§6.5）
交换代理                ──写──▶ resident\broker\responses\<id>.stop.json 这份停止请求的处理结果
常驻执行器              ──写──▶ resident\mailbox\requests\<id>.cancel.json Owner 中止：companion 停止这个请求的泵
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
   | 暂停接新 | 任何 Owner 会话进程 | `node tools\rearm-tool.mjs request-intake-pause --root <root> --reason …`，写进 `requests\`：只不开新批次，在跑和停靠的批次照常，最长 2 小时自动失效；同一持有者的 `request-intake-resume` 可提前结束（§20） |
   | 恢复 | 只有提权的 Owner | `rearm-resident.ps1 -Request Resume -ExpectedPausedSha256 <审过的>`。脚本用纯 PowerShell 往 `owner\` 写一个带时间和 nonce 的请求，不启动任何其他程序；服务按比较交换执行 |
   | 复位（未知失败后） | 只有提权的 Owner | `rearm-resident.ps1 -Request Rearm -ExpectedHaltSha256 <审过的> -Reason …`，写法同上。服务实测两端静止，对**每一个还没归档的未知失败批次**只改名归档，再按比较交换清除 HALT |
   | 中止当前批次 | 只有提权的 Owner | `rearm-resident.ps1 -Request Abort -BatchKey <键> -ExpectedLedgerEntrySha256 <审过的> -Reason …`，写法同上。服务只在安全点执行：停下正在跑的扫描签发段，实测两端静止，只改名归档，记 FAILED_CLEAN `OWNER_ABORTED`；证明不成立时照旧 HALT（§6.5） |
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
  - 持有者来自上一次开机：不管 pid 还在不在，都按过期处理。锁改名保留，附一份 `earlier-boot.json`，交给崩溃恢复判断（Task `d80fd886`）。持有者记录和存活记录都写开机以来的毫秒数 `uptimeMs`（Node 的 `os.uptime()`，在 Windows 上就是 `GetTickCount64`）。这个数每次开机从零开始，一次开机之内只增不减，所以记录里的数比现在大、而且差值超过 60 秒，就是上一次开机写的。只看 pid 和存活记录不够：重启后旧 pid 可能已经分给了别的进程，重启前一分钟写的存活记录按墙钟看也还新鲜。判断只朝一个方向：认不出来时退回下面几条规则，最坏是拒绝启动，不会让两个执行器同时运行。快速启动（Fast Startup）不会把这个数归零，服务进程也不重启，这时这条规则不触发；
  - pid 已不在：锁改名保留，交给崩溃恢复判断；
  - pid 还在而且存活记录新鲜：拒绝启动；
  - pid 还在但存活记录过期（pid 复用或挂起）：拒绝启动，交给 Owner 查看；
  - 服务停止从不杀进程：宿主只写 `STOP-REQUESTED`，执行器在批次之间退出。
  - 每个宿主进程最多请求一次停止（`ResidentStopGate`，Task `fe6cd7bc`）。SCM 停止、关机、执行器自己退出，三者谁先到谁算。只有 SCM 停止、并且执行器还在运行时，才写 `STOP-REQUESTED`（只能新建）。执行器自己退出时，宿主直接停服务，什么都不写。修复前，Exited 处理器调用的 `ServiceBase.Stop()` 会重入 `OnStop`：执行器已经把 `STOP-REQUESTED` 改名进 `state\locks` 之后，宿主又建一个，下一次启动随即停止（2026-10-21 15:51Z 实测，Note `fdf7e62a`）。
  - 停止请求的内容是 `{"contract":"clued.independent-ci.stop-request/1","uptimeMs":<GetTickCount64>}`，记下发出时本次开机已过的毫秒数，执行器据此判断它是不是上一次开机发出的（Task `d80fd886`）。只有"文件已经在了"（`ERROR_FILE_EXISTS`、`ERROR_ALREADY_EXISTS`）才算已经请求过；其他错误都让这次停止明确失败，并交还停止权，下一次停止会重新请求。文件建好就算请求成立，即使内容没写进去：空文件可能是内容还没写进去的一瞬间，也可能是写入失败留下的，执行器都照样停下。
  - 关机时不写 `STOP-REQUESTED`。Windows 只给服务几秒（TURING 上 `WaitToKillServiceTimeout` 是 5 秒），空闲的执行器每 15 秒才看一次，来不及确认。留下的文件会让重启后的第一次启动以 0 退出，不触发失败重启，常驻服务就一直停着。不写的话，执行器随系统结束，下次启动按崩溃恢复处理：空闲时没有未结束的批次，什么都不用做；批次中途被结束的，由崩溃恢复照常处理（执行器若恰好在这几秒里醒来并开始新批次，也是这样）。
  - 宿主启动时不清理残留的 `STOP-REQUESTED`。它可能仍是给一个没有宿主的旧执行器的：批次超过了宿主的 20 秒等待，宿主已报 STOPPED，执行器还在跑。宿主不重做单实例锁的存活判断，就分不清这种情况和已死执行器的残留；改名会让那个执行器收不到停止。
  - 执行器在每个 tick 之前（包括第一个）读请求内容（`src/stop-request.mjs`，最多读 4097 字节），每次都现取本机的 `uptimeMs`。只有能解析的 `stop-request/1`、而且 `uptimeMs` 比现在大、差值超过 60 秒，才算上一次开机的请求：它是重启前发出、没等到确认的，不是给这个执行器的。执行器先写 `service-stop-prior-boot` 回执，记下两边的 uptime，再把它改名为 `state\locks\prior-boot-stop-<ms>-<pid>`（`<ms>` 是墙钟毫秒），然后继续运行。这条回执写不进去时不改名；改名失败时尽力补一条 `service-stop-prior-boot-failed` 回执。两种情况都以错误退出（exit 4，宿主报 1064，按 §8.1 每天最多重启一次）。修复前，重启后的第一次启动会随即以 0 退出，不触发失败重启，常驻服务就一直停着。
  - 其他请求照常执行，执行器停下：本次开机的、空的、残缺的、超长的、读不了的、格式不对的，都算。已死执行器的残留（SCM 停止之后、确认之前，执行器崩溃、被杀或自己出错退出）就是这样，由下一个执行器确认一次：`service-start`、`service-stop` 两条回执，改名进 `state\locks`，不删除。再下一次启动正常运行。
  - 还有两种情况没有覆盖。一是判断只朝一个方向：服务延迟启动，执行器第一次看时开机已有几分钟；上一次开机里，开机时长不超过（这次第一次看时的开机时长 + 60 秒）时写下的请求认不出来，照常执行，第一次启动以 0 退出，和修复前一样。二是残留还在时（从服务报 RUNNING 到执行器第一次看，几秒钟）来的 SCM 停止，会看到"文件已经在了"，什么都不写；执行器随后把残留改名，这次停止就丢了。宿主等 20 秒后报 STOPPED，执行器没有宿主，继续运行，SCM 再也停不了它；下一次启动会被单实例锁拒绝，Owner 能看到，手工建 `STOP-REQUESTED` 或结束进程。
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

v0.9 起，释放还是烧号由机器可读的失败对照表 `src/failure-table.json` 决定，见 §16.3。上表的三类码不变；对照表按（段、码、结局原因、诊断码）再细分。

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

#### Owner 中止当前批次（v0.8，Task `56cd9edc`）

- **为什么**：某一段卡住时，今天只能等这一段的截止时间（第 2 段、第 8 段最长 45 分钟）。2026-10-21 的实例：companion 的 bridge 转发被拒（`RELAY_REFUSED_NO_RETRY`），Windows 扫描签发段一直等 Linux 的回应，直到自己的截止时间。
- **请求** `clued.independent-ci.resident-owner-abort/1`，字段恰好是 `contract`、`batchKey`、`ledgerEntrySha256`、`reason`、`by`、`requestedAt`、`nonce`：
  - 由已安装的 `rearm-resident.ps1 -Request Abort -BatchKey <键> -ExpectedLedgerEntrySha256 <摘要> -Reason …` 提权写进 `owner\`。纯 PowerShell，只新建一个文件，不启动其他程序；两个摘要参数只收小写十六进制。授权和复位、恢复相同（目录 ACL），已处理的请求同样按文件名和字节摘要记下；
  - `ledgerEntrySha256` 是该批次账本**最新一条记录**原始字节的 SHA-256，取 `00-reserved`、`10-started`、`15-relay-wait`、`20-plan-intent`、`25-plan` 中最后存在的一个。各段只写回执、不写账本，所以本地段卡住期间这个值不变；
  - 不提权的查看（`rearm-resident.ps1` 不带参数）对每个未终结批次列出键、记录名和摘要（`abortTargets`）。
- **只在安全点生效**：
  - P0：tick 开始时，只针对正在等托管信号的批次，这时什么都没在运行；
  - P1：同一批次每一步开始之前：第 1 段、每次托管等待判断、建工作区、每个本地段、第 8 段；
  - P2：第 2、4、6 段**运行中**。这三段的入口是扫描签发者（`scanner-issuer`），不发布任何检查。段运行时执行器每 5 秒看一次 `owner\`。

  其余步骤不在运行中打断：导出、打 bundle、第 1 段（发布 work-admission）、发布段 3、5、7、第 8 段（发布控制检查）、第 R 段（发布转发检查）、各次归档和收尾。中止等它们自己结束，在下一个安全点生效。有两处例外：第 1 段结束时账本会新增 `10-started` 和 `15-relay-wait`，第 R 段结束时会新增 `25-plan`，所以在这两段运行期间写的请求，摘要到下一个安全点时已经过期，会以 `OWNER_ABORT_LEDGER_CHANGED_SINCE_REVIEW` 拒绝，批次照常往下走。Owner 要在这两段结束后重新查看，再请求一次。批次先自己走到了终态的，请求在下一 tick 以 `OWNER_ABORT_BATCH_NOT_OPEN` 拒绝。第 8 段成功之后不再有安全点。
- **接受**：比较交换（批次未终结、最新记录的摘要与请求一致）通过后，先只新建 `80-owner-abort.json`，再写 `owner-abort-accepted` 回执。从这一刻起这个批次不会再往下走，也不再算可恢复的等待。之后的回执写失败时，P2 的轮询从账本里认出这次接受，照样请求停止。
- **P2 的停止路径**（每一步都只新建文件，都绑定在这一批次的这一段上，各自单独重试，一步失败不挡另一步）：
  1. 执行器在 `broker\requests\` 里找**正在进行的那一次交换**：代理已领取（有 `.taken`）、还没回复、段号相同、`configSha256` 等于这一批次该段包的计划哈希（从批次钉住的 work manifest 读出）。恰好一个时，在旁边新建 `<id>.stop`，字段恰好是 `contract`、`requestId`、`nonce`、`stage`、`configSha256`。执行器记下这个请求 id，交换被回复之后照样能读停止回执；
  2. 代理在这次交换的等待循环里每秒看一次（§8.2 第 9 条），条件全部满足时向 runner 服务发 `SERVICE_CONTROL_STOP`，并把结果写进只新建的停止回执 `broker\responses\<id>.stop.json`（`STOP_SENT`、`HELPER_ALREADY_STOPPING` 或某个拒绝码）。这个控制实际只生效一次：万一因为超时又发了一次，助手也只是再置一次同一个标志、终止同一个作业对象，没有别的作用；
  3. 通用助手按它现有的停止路径处理（`STOP_REQUESTED`，服务退出码 92）：只终止并排空**它自己建的作业对象**，写原生回执，报告 STOPPED。代理照常换回原始二进制并回复。执行器和代理都不杀任何进程，也不碰来历不明的进程树；
  4. 只有停止回执是 `STOP_SENT`，或者这一段在 Windows 侧的调用（invoke-stage 子进程）已经带着阶段事实返回之后，执行器才给 companion 写 `mailbox\requests\<泵请求 id>.cancel.json`。带着阶段事实返回有三种：代理已经回复，不论回复码是什么（助手已停，或助手根本没启动）；调用在找代理之前就拒绝了这一段；调用等不到代理的回复而放弃，那时代理和泵自己的截止时间都已过。这三种情况下发行方都不再等泵能带来的任何东西。泵在下一个等待步骤以 `COMPANION_PUMP_CANCELLED` 结束，不再做 blocked 转交：取消之后不再发起任何 relay 调用（每次调用之前都先查取消，正在进行的那一次最多一个回调窗口（120 秒，`RELAY_TIMEOUT_MS`，§7.9），先等它结束），blocked 转交的每一步之前也查；以失败结束时，不论停在哪一步，回复都是 `COMPANION_PUMP_CANCELLED`（取消时恰好已经正常走完的，照实回复成功）；读不出的取消文件按没有取消处理；它只停止搬运，从不停止或杀掉 Linux worker，取消若随 issue 转交一起到达，就不再启动 worker。在这之前，泵和它的 blocked 转交都和没有中止时完全一样，所以停止没送达时，这一段的结局不会比不中止更差；调用一返回，这一段也不会再为泵多等到截止时间；
  5. 还没调用的段（例如还在 refs 闸门上）直接不调用，以 `OWNER_ABORT_REQUESTED` 结束。
- **结束**（P0、P1、P2 相同）：
  1. 运行中被停下的段，结局码必须在白名单里（`classify.mjs#OWNER_ABORT_STAGE_ENDINGS`），而且该段自己的 Windows 证明齐全（作业树为 0、原始二进制已还原）。白名单是：本来就干净的码；`OWNER_ABORT_REQUESTED`；`COMPANION_PUMP_CANCELLED`；入口被停下、来不及写结局时的 `STAGE_OUTCOME_MISSING`。最后一个只在停止回执是 `STOP_SENT` 时才算，其他情况下它照旧是未知；
  2. 两端现取静止证明，与失败分类同一套；不成立就每 20 秒再取，最多 9 次；
  3. head 记为已烧（第 1 段之前中止的批次也一样，旧触发不会再把这个 head 启动）；两端只改名归档，固定原因 `owner-aborted`。它不是协议范围，所以整批现场都归档，effect journal 留在原处；
  4. 记 `90-terminal` FAILED_CLEAN，码 `OWNER_ABORTED`，事实里有安全点、被停的段、该段的结局码、停止回执的码、请求摘要和两端的归档目录；回执 `batch-terminal` 和 `owner-request`（`kind: abort`）。从不排 attempt 2。
- **HALT 语义不变**：
  - 段的结局不在白名单、静止证明不成立（`OWNER_ABORT_QUIESCENCE_UNPROVEN`）、归档未核实，都照旧记 FAILED_UNKNOWN 并锁 HALT，现场不动，等 Owner 复位；
  - 中止不清除也不绕过 HALT。HALT 时仍可中止正在等待的批次，HALT 保持；但只要还有别的未归档现场，P0 中止就拒绝（`OWNER_ABORT_UNARCHIVED_SCENE_PRESENT`），因为 `owner-aborted` 是整批范围的归档，不能把别的现场一起移走；Owner 先复位；
  - tick 开始时接受到一半就失败（`80-owner-abort` 已写）：这个批次当场以未知关闭并 HALT；另有一道闸门，`takeOwnerRequests` 之后只要还有未终结、又不是可恢复等待的条目，这个 tick 就锁 HALT（`OWNER_ABORT_UNCONFIRMED`），不再跑任何候选。这种请求的回执是 `owner-abort-unconfirmed`，不是拒绝：账本已经接受了它，下一 tick 的恢复以 `OWNER_ABORT_INTERRUPTED` 关闭这个批次。已经干净结束的中止，汇总回执写失败也不会被记成拒绝或未确认；
  - 段运行中接受到一半就失败、留下读不全的 `80-owner-abort`（账本条目成了 UNREADABLE）：段结束后立即锁 HALT（`OWNER_ABORT_UNCONFIRMED`），后面的发布段一个也不跑。读不全的条目没法再写终态，下一 tick 的崩溃恢复把它原样隔离（`LEDGER_ENTRY_UNREADABLE`），复位时以 `rearm-quarantine` 归档；
  - 服务在中止中途重启：`80-owner-abort` 让这个批次不再算可恢复的等待，崩溃恢复以 `OWNER_ABORT_INTERRUPTED` 关闭并锁 HALT。服务若在记下这个请求之前就死了，恢复之后再读到它时，回执是 `owner-abort-unconfirmed`（`OWNER_ABORT_BATCH_NOT_OPEN`），不是拒绝；只有这次中止自己干净结束（`FAILED_CLEAN` `OWNER_ABORTED`）才算已了结。
- **中止从不**发布、撤回或重跑任何检查，从不杀进程，也不放宽任何门禁。
- **拒绝**（回执 `owner-request-refused`，请求记为已处理）：格式不对（`OWNER_REQUEST_REFUSED`）；批次已终结或不存在（`OWNER_ABORT_BATCH_NOT_OPEN`）；这个批次的中止已经接受过（`OWNER_ABORT_ALREADY_ACCEPTED`）；摘要过期（`OWNER_ABORT_LEDGER_CHANGED_SINCE_REVIEW`）；还有别的未归档现场（`OWNER_ABORT_UNARCHIVED_SCENE_PRESENT`）；tick 开始时已安装的 Source 或常驻层字节与策略不符（`OWNER_ABORT_SOURCE_DRIFT`：归档工具从已安装 Source 运行，漂移的字节一个也不执行）；tick 开始时批次未终结却不在等待（`OWNER_ABORT_NOT_AT_SAFE_POINT`，只在恢复本身失败时可能出现）。段运行中读到的、针对别的批次的中止原样留着，由下一 tick 处理。
  漂移检查只加在 P0 中止上。复位运行同一套归档工具，但不做这项检查，这是以前就有的情况，本次没有改动。
- **窄竞争**：停止恰好落在助手刚放行、子进程还没进作业对象，或者子进程刚正常结束、助手还没停下的那几毫秒里时，助手回执会显示树未确认（`STAGE_CHILD_TREE_UNCONFIRMED`），或结局与停止冲突（一般是 `PUBLICATION_UNCERTAIN`）。按上面的规则这算未知并 HALT。代理在助手启动后 5 秒内不发停止，以缩小前一种情况。
- **生效要重装 Windows 常驻包**（Task `0f6035b6`）：交换代理要重新编译，执行器和 companion 要更新。Source v2（`CI/`）和 Linux 侧都没有改动，安装记录和 `ciSourceManifestSha256` 不变。

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

### 7.8 发行方准入的暂时性拒绝（Task `36744266`，PR #899）

发行方（`CI/worker/protected-job-bridge-v4/windows-issuer.mjs`）每次都重新跑一遍完整准入：签发前一次，每轮回调（admission 和 remote-refs）各一次，收到签名结果后再一次。拒绝分两类。

**暂时性拒绝**：没有任何闸门说“不”。只有两种，见 `RETRY_WAITS_MS`：

- `full_admission_observation_expired`：主机慢，观测超过了 30 秒的新鲜度上限。立即重评，一次准入最多评估 3 次。次数与改动前相同；首次准入现在也受下面的截止约束，以前不限时。
- `full_admission_unavailable`：`full-admission-v2.mjs` 的兜底接住了一个异常，多半是 GitHub 或 KooYomi 的调用失败。分别等 1、2、4 秒后重评，一次准入最多评估 4 次。
  - 本地的确定性故障也会落到这里。重试有上限，不会多出副作用。
  - 但它的结局变了：在 Linux 准备之前的回调轮里，它现在落成干净的 `BRIDGE_TRANSPORT_TIMEOUT`（在第 2 段，满足 §7.2 的条件时可能自动 attempt 2），不再立即 HALT 引起 Owner 注意。

一次准入的两种原因共用一个计数器：第 n 次评估之后等多久，看最近一次的原因在第 n 项上的值；没有第 n 项就放弃。所以混合序列最多评估 4 次。例如 unavailable、unavailable 之后来了 stale，第 3 次就放弃。

**其他所有拒绝**照旧立即失败关闭，不重评。

规则：

- 每次重评都是一次新的完整准入。只有新鲜、完整的 ADMITTED 才会被用来签发或回复，所以重试不放松任何闸门。每次评估前后仍核对持有的租约。
- 只有当等待结束于本次准入的截止之前，才去等。截止分三种：
  - 签发前：阶段窗口减一个回调窗口（`stageDeadline - CALLBACK_WINDOW_MS`），给 Linux 侧至少留一轮；
  - 回调时：本轮 challenge 的截止；
  - 收到结果后：issue 的 `expiresAt`。
  这个约束只管等待，最后一次评估本身可能越过截止。
- 回调轮里，如果到了截止或次数用完，暂时性拒绝还在，发行方本轮就不回复，走 late 路径（S7）。Linux worker 过了截止就不再收回复。结局要看是哪一轮：
  - Linux 还没准备任何东西的那几轮：placement 和 trivy 的 challenge-01，gitleaks 的 challenge-01、02。它写干净的 `blocked`（`BRIDGE_CALLBACK_DEADLINE`），阶段以 BLOCKED 结束。
  - 之后的轮次，例如 placement 的 challenge-02：容器启动前的再次准入，这时运行目录已经建好。它以 UNCERTAIN 结束，不写 `blocked`。
    - 发行方的结局仍是 UNCERTAIN（PUBLICATION_UNCERTAIN），与改动前相同。
    - 不同的是它来得更晚：发行方在本轮截止之后再等最多两个窗口，或者等到 issue 过期，取先到者。比改动前最多约晚 6 分钟（本轮剩下的时间加两个窗口）。
    - reason 变成 `BRIDGE_LATE_BLOCKED_UNCONFIRMED` 或 `BRIDGE_RESULT_DEADLINE`。
  - PR #894 第 6 阶段（2026-10-21，Note `d2f6c567`）正是后一种：一次 `full_admission_unavailable` 立即 UNCERTAIN，常驻执行器随即 HALT。让它不再重演的是轮内重试，不是 late 路径。
- 改动文件的读取（`github.readChangedPaths`）在 `full-admission-v2.mjs` 的兜底之外，所以 `issuerEvaluate` 按兜底的方式映射它的失败：
  - PR 已不在作业的 head 和 base 上打开（`pr_subject_changed`）时，记为 `full_admission_subject_changed`，与 `evaluatePr` 自己发现时相同，不重评；
  - 其他失败（多半是 GitHub 在端口自己的重试之后仍然失败）记为 `full_admission_unavailable`，`phase` 为 `changed_paths`，照上面的规则重试。
  - 这是一处分类变化：端口自己的确定性拒绝（`pr_files_page_limit`、`invalid_pr_files`、`incomplete_pr_files`、`pr_files_changed`、`invalid_pr_subject`）和 `github_http_403` 也落到这里。以前它们以自己的 code 结束（第 2、4、6 段多为 `STAGE_CHILD_REFUSED`；其他失败里的 5xx 为 `GITHUB_TRANSIENT_UNAVAILABLE`），在回调轮里直接 UNCERTAIN。现在在签发前的首次准入里用尽重试后是 `NATIVE_ADMISSION_UNAVAILABLE`（暂时性，第 2 段可能 attempt 2），在回调轮里照上面的规则走 late。影响小：第 1 段已经读过同一 head 和 base 的改动文件。把这些码重新分出来归入 Task `576231fa`。
- 收到签名结果后的那次准入也按同样的规则重试。
  - 用尽时仍是 UNCERTAIN：结果已经在手，但准入没有得到确认。
  - 重试只把等待限制在窗口内，最后一次评估可能越过 issue 的 `expiresAt`。越过时不算成功，记为 `BRIDGE_RESULT_DEADLINE`（UNCERTAIN）。
- 放弃一次暂时性准入时，发行方把 `{transientAdmission, evaluations, phase}` 放进结局的 `admissionDiagnostic`，好让走了 late 的一轮看得出是准入出的问题。它记的是本次运行中放弃过的暂时性准入，是上下文，不一定就是最终 reason 的成因。
  - PR #898 之后，结局记录的写入（`CI/src/resident-v2/stage-inputs.mjs#writeOutcome`）用 `sanitizeAdmissionDiagnosticV2` 净化它，只留已知的准入诊断字段：`transientAdmission`、`evaluations` 被丢掉，`phase` 只在 `DIAGNOSTIC_PHASES` 里时保留（`changed_paths` 不在其中）。让这两个字段进入结局记录是 Task `31f044d5`。
  - 诊断字段本身不影响分类：失败对照表（§16.3）只看 status、reason 和诊断里的原因码，发行方的诊断没有原因码。
- **签发前的首次准入也重试**（这是本节的决定）。理由：
  - 这时还没签发，Linux 侧什么都没开始，重试没有副作用；
  - 第 4、6 段（trivy、placement）的首次准入失败虽然是干净的 `NATIVE_ADMISSION_UNAVAILABLE`，但第 3 段以后不会自动做 attempt 2（§7.2），所以一次抖动就会丢掉整批；段内重试不算新的 attempt，与 §7.2 不冲突；
  - 代价有界：最多 4 次评估，外加 7 秒等待，并给 Linux 侧留一个回调窗口。用尽时结局与以前相同：`BLOCKED`、`full_admission_unavailable`、零副作用（改动文件读取的失败除外，见上）。
  - 实测：PR #892 批次 `2bf6b12c` attempt 2 第 4 段，2026-10-21 17:36Z。发行方拿到 spool 锁后，没写 issue 就结束了；同一分钟 GitHub 短暂不可用，大概率是签发前的 `full_admission_unavailable`。
  - 这种结局之后，companion 的 relay 泵仍在 `R/src/companion.mjs` 里等 issue，一直等到请求截止，那次白等了约 30 分钟常驻时间。发行方阶段已经以 sideEffects 0 结束时立即取消它，是 Task `c18eac1d`。
- 第 1 段的工作准入是另一个入口，不归本节管。它的 `NATIVE_ADMISSION_UNAVAILABLE` 仍由 attempt 2 处理（§7.2）。
- 仍不经过这条规则的暂时性失败：gitleaks 的 remote-refs 回调里，refs 读取失败是 `REMOTE_REFS_UNAVAILABLE`，回调中仍立即 UNCERTAIN（Task `576231fa`；改动文件读取的重试已在 PR #899 完成）。
- 测试：`CI/test/resident-v2-bridge.test.mjs` 新增 9 个。重试、截止、首次准入上限、late 路径、`issuerEvaluate` 映射、结果后的过期检查、`diagnostic` 和 `phase` 类型检查都做过变异检查；评估结果为 null 时 `phase` 读取的空值保护（`facts?.`）没有测试守着，去掉它仍然失败关闭，只是 reason 变成 `FORMAL_BRIDGE_UNCONFIRMED`。
  1. unavailable 之后来了 ADMITTED，就回复；结果后的那次准入也一样；
  2. 到本轮截止仍是 unavailable，走 late；
  3. 4 次用完，本轮还有时间，也走 late；
  4. unavailable 之后的真正拒绝照旧 UNCERTAIN；
  5. 混合原因共用一个计数器；结果后的准入重试用尽是 UNCERTAIN；等待中租约失效，立即失败；
  6. 首次准入重试，以及它的上限（窗口减一轮）；首次准入的真正拒绝照旧 BLOCKED；
  7. `issuerEvaluate` 的映射；
  8. 改动文件读取在回调轮里失败一次后重试并回复；
  9. 结果后的准入越过 issue 窗口时为 UNCERTAIN。
- 四轮独立只读审核均为 PASS（0 BLOCKER、0 MAJOR）：`8b1f6f7b`、`105adffc`、`5410d563`，以及自举安装审核 `11af4710` 第 4、5 条修复后的 `18c0afc5`。审核记录在 PR #899 正文里。

### 7.9 搬运变慢时的回调（Task `576231fa`，Owner 决定 `6f1fb753`）

**根因**（2026-10-23，只读核实）：三次被记成“签发方卡住”的事故里，签发方其实都按时作答了。慢的是 companion 的一次搬运调用（relay-public.ps1）：平常 4–6 秒，偶尔 25–45 秒。

- PR #915 第 4 段（批次 `a0a76a17`）：签发方 07:20:38Z 写出 response-04，SendResponse(4) 约 30 秒后才在 Linux 侧校验。这时响应里的准入已超过 30 秒新鲜期，Linux 拒收。companion 以 `RELAY_REFUSED_NO_RETRY` 停泵；worker 在本轮截止写 uncertain，因为扫描已经跑过。
- PR #911 第 4 段（批次 `0d379e72`）：签发方 04:57:30Z 写出 issue，SendIssue 用了约 43 秒，超过 companion 原来固定的 40 秒，泵当作失败停下，worker 没有启动。
- PR #908 第 1 次：response-02 同样没送到 Linux。那一轮在准备之前，所以 worker 写了 `blocked`，干净结束。
- 泵停下以后，签发方等到 issue 过期，以 `BRIDGE_RESULT_DEADLINE` 结束（UNCERTAIN），常驻侧判 `PUBLICATION_UNCERTAIN` 并 HALT。
- 证据：Windows 侧桥记录的时间（Owner 一次 UAC 的只读收集）、Linux 侧归档与 journal、companion 的 relay-stage 答复。搬运慢在哪一步没有记录可查。

**改动**：

- 回调 response 里的准入按签出时刻判新鲜，和 issue 一样（`CI/worker/protected-job-bridge-v4/protocol.mjs#validateResponse`）：签出时准入不超过 30 秒；response 只要在自己的窗口内到达（不晚于本轮 challenge 的截止，最多 120 秒）；claim 在到达时仍有效（response 的 `expiresAt` 不晚于 `claimExpiresAt`，且晚于到达时刻）。
- Linux 适配器对每轮回调结果自己的复核（`validateFormalAdmissionV2`）也一样：worker 把每个 response 的签出时间和过期时间记在它交给适配器的那份准入事实上（`linux-worker.mjs#callbackValue`、`admission-facts-v2.mjs#noteBridgeResponseTimes`）。在这个 response 有效期内，30 秒从签出时刻算；过了有效期，或者不是从回调来的事实，照旧从当前时刻算。Windows 侧的调用方从不登记，行为不变。
- remote-refs 回调的 refs 快照仍按到达时刻判 30 秒，不在这次决定范围内。
- companion 每次搬运调用最多等一个回调窗口（`RELAY_TIMEOUT_MS` = 120 秒），不再固定 40 秒。Runner 从不杀子进程，提前放弃并不能腾出 Runner，只会让泵以没用的答复结束。Owner 中止时，正在进行的那次调用最多多等这么久。
- 不变：每轮仍重新做完整准入；绑定 nonce、序号与批次 claim 代际；发布阶段（3、5、7、8）自己再做完整准入，已发布的检查不重复、不伪造。
- 仍未处理（后续）：泵在扫描执行段停下、companion 已给出 Linux 静止证明时，常驻侧要等签发方到期才 UNCERTAIN→HALT，应尽早停下签发方并干净结束。

---

## 8. Windows：服务账户与权限边界

### 8.1 常驻服务

- `CluedCIResident`，账户 `NT SERVICE\CluedCIResident`（`S-1-5-80-` 加服务名的 SHA-1），SID 类型 unrestricted。
- 延迟自动启动。失败后每天最多重启一次（`failureflag 1`，非崩溃的失败也会触发），目的是让崩溃恢复把 HALT 落盘，不是重试批次。
- 服务自身的 DACL：只有 SYSTEM 和 Administrators 能控制。
- **必需特权只有 `SeChangeNotifyPrivilege`**（`sc privs`，PR-A 复审 MAJOR-1）：SCM 从服务令牌里去掉其余所有特权，尤其是默认带的 `SeImpersonatePrivilege`。宿主启动时再读一次**真实令牌**：多出任何特权就拒绝启动，并把令牌里的特权写进 `state\service-token.json`；安装回执和 `verify-resident.ps1` 都核对它和 `sc qprivs`。
- **出站网络被封**（MINOR-5）：防火墙规则 `CluedCIResident-BlockOutbound` 按服务 SID 限定（`-Service CluedCIResident`），覆盖服务的所有 node 子进程；GitHub 读取全在 companion（Owner 自己的登录）里，runner（clued-control）不受影响。只在 Windows 防火墙开启时生效，`verify-resident.ps1` 同时检查规则和三个配置文件都开着。
- 宿主 `ResidentServiceHost.cs`：启动前校验 node 和入口文件的哈希；环境变量清空，只留固定几项，不继承句柄；停止时只写 `STOP-REQUESTED`，内容写明本次开机的 `GetTickCount64`，每个进程最多一次，关机时和执行器自己退出时都不写（§6.2）；从不杀执行器。离线测试：`windows/test-resident-windows.ps1` 第 6 节（`HostPureTests.cs`，用真实宿主加假执行器）；第 7 节核对本机 node 的 `uptimeMs()` 和 `GetTickCount64` 读的是同一个时钟。执行器把上一次开机的请求改名留存、不执行（§6.2，`test/stop-request.test.mjs`）。

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
  9. **Owner 中止**（v0.8，§6.5）：交换进行中，代理每秒看一次 `requests\<id>.stop`。只有同时满足下面几条才发 `SERVICE_CONTROL_STOP`（实际只生效一次，重复送达没有副作用），句柄只开 `SERVICE_STOP | SERVICE_QUERY_STATUS`：
     - 五个字段（`contract`、`requestId`、`nonce`、`stage`、`configSha256`）都等于这一次交换；
     - 段号是 2、4 或 6；
     - runner 正以代理自己观察到的 PID 运行（RUNNING）；
     - 助手已启动 5 秒以上。

     这一秒怎么做由纯函数 `StopRequest.Decide` 决定（`BrokerPureTests` 逐条覆盖）：启动中或宽限期内先等；已在停止或已停止记 `HELPER_ALREADY_STOPPING`；PID 不对记 `BROKER_STOP_NOT_THIS_HELPER`；否则发送。可能过去的失败重试 10 秒，之后才落定：读不全或格式不对（停止请求可能还在写）、共享冲突或 SCM 状态读一时失败（`BROKER_STOP_UNCONFIRMED`）、`ControlService` 没被接受（`STOP_NOT_ACCEPTED`）。结果（`STOP_SENT`、`HELPER_ALREADY_STOPPING` 或某个拒绝码）只新建写进 `responses\<id>.stop.json`，执行器据此决定是否取消泵、是否接受入口没写结局的结束。助手自己排空作业对象后停下，代理照常还原并回复，回复格式不变。代理仍然不杀任何进程。
- 被攻破的常驻账户最多只能“启动已审的助手跑自己的作业输入”，或让自己发起的扫描签发段提前结束；到不了 SYSTEM，也不能以 clued-control 身份运行任意代码。

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
- **安装和卸载回执**：在 `install\`，只有管理员能写。复位、恢复与中止由服务写回执（`owner-request` 或 `owner-request-refused`）。中止另有 `owner-abort-accepted`（已接受）、`owner-abort-stop-requested`（已写代理停止请求）和 `owner-abort-unconfirmed`（已接受、没能完成，见 §6.5）。
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
| 卡住的段 | 等到这一段的截止时间（最长 45 分钟） | UAC 1 次，只写中止请求；服务在安全点停下、两端证明静止后归档、继续；证明不成立时照旧 HALT，等复位（§6.5） |

---

## 13. 测试、演练与复审

### 13.1 已运行（离线，没碰主机）

v0.8 补充（2026-10-21，Owner 中止 §6.5，基于 main `8c2bfdcc`，推送前合入 main `fbb4a8d9`，含 §13.9 复审之后的修正）：

- 常驻层：`node --test test/*.test.mjs` **160/160**。新增 `abort.test.mjs` 32 个、`abort-ports.test.mjs` 13 个，覆盖：
  - 请求合同与结局白名单（入口没写结局只在 `STOP_SENT` 之后才接受）；`rearm-resident.ps1` 写出的字段与服务的校验一致，只收小写十六进制；
  - 等待中的批次在 tick 开始时中止；第 2 段运行中中止，只停这一段；发布段不被打断，在下一段之前生效；第 1 段之前中止；
  - 摘要过期、批次已终结、还有别的未归档现场、tick 开始时不在等待，都被拒；段运行中读到的别的批次的中止留给下一 tick；重复请求只记为重复；查看列出中止目标；
  - 静止证明不成立时 HALT，之后照常复位；有界复查内静止也算数；停下的段结局不干净时 HALT；停止没送达、入口没写结局时 HALT；HALT 时中止不清 HALT；tick 开始时接受到一半失败，当场 HALT，不再启动别的批次；接受回执写失败时照样请求停止；中止中途重启以 `OWNER_ABORT_INTERRUPTED` 关闭并 HALT；
  - 引擎只把停止请求绑定在这一次交换上，还没调用的段不调用；先写代理停止，`STOP_SENT` 之后才取消泵，取消失败不挡代理停止；泵被取消时跳过 blocked 转交，取消随 issue 转交一起到达时不启动 worker。
  - 第二轮复审之后：接受到一半失败、以未知关闭也失败时，闸门照样不跑别的批次，回执记为 `owner-abort-unconfirmed` 而不是拒绝；已接受过的中止再请求被拒；tick 开始时 Source 漂移就拒绝；段运行中写出读不全的 `80-owner-abort` 时，段结束后 HALT，下一 tick 隔离，复位以 `rearm-quarantine` 归档；停止没送达时，这一段的调用一返回就取消泵，不再等泵的截止时间；段结束后补写“已请求停止”的回执；中止的未知结局带上安全点和请求摘要。
  - bootstrap 安装源复审之后：relay 调用失败时取消已经写好，泵只等完那一次调用（最多 40 秒）就以 `COMPANION_PUMP_CANCELLED` 结束，不做 blocked 转交，也不再调 relay（ReceiveResult、ReceiveChallenge、ReceiveBlocked，超时和被拒各一）；blocked 转交途中收到取消，在下一个等待步骤结束；取消时已经写好的 response 不再转发。之后的复审又补了：列目录、或 relay 回答“没有”之后，不再发起下一次 relay 调用（没有列表时、主循环里、blocked 转交里各一）；失败的 SendIssue、blocked 转交自己被拒的 ReceiveBlocked 也回复 `COMPANION_PUMP_CANCELLED`；读不出取消文件时，泵和没有中止时完全一样。
  - 推送前的最终核对之后：服务记下请求之前就死了、恢复关闭批次之后再读到这个请求，回执记为 `owner-abort-unconfirmed` 而不是拒绝；`FAILED_CLEAN` 已写、`batch-terminal` 回执写失败时不记成未确认；tick 开始时接受到一半失败，汇总回执是 `owner-request`（`HALTED`），不是拒绝。
- 常驻层 Python **25/25**（在 Git Bash 里运行；在 PowerShell 里有 3 个 Linux 安装器用例因为解析到另一个 `/bin/bash` 而以 127 失败，与本次改动无关）；`node drill/offline-drill.mjs` **37/37**（新增 2 步：第 2 段卡住时 Owner 中止，之后这个 head 不再运行）。
- `windows/test-resident-windows.ps1` **71 条**断言，其中 C# 纯逻辑 **28 条**（新增 18 条：停止请求只认这一次交换和扫描签发段，`StopRequest.Decide` 的每种状态）；`SwapBroker.cs` 编译通过。

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

### 13.9 Owner 中止的独立复审（v0.8）

- 对象：提交 `bd10671a`（基于 main `8c2bfdcc`）。复审者没有参与修改，在新上下文里只读核验，自己跑了全部离线测试，另写 4 个探针（只在临时目录）复现问题。
- 结论 **PASS**：0 BLOCKER，0 MAJOR，7 MINOR，8 NIT。下列修正都在之后的提交里，再由复审核对修正后的确切对象：
  - M1：tick 开始时接受到一半失败，批次既未终结又不算等待，同一 tick 还会启动别的批次。现在当场以未知关闭并 HALT，另加 `takeOwnerRequests` 之后的闸门；
  - M2：入口没写结局的结束，原来只要接受过中止就算干净。现在必须有代理的 `STOP_SENT` 回执，停止回执的码记进终态事实；
  - M3：第 1 段和第 R 段期间写的请求必然因摘要过期被拒，原文写成“下一个安全点生效”。已改正 §6.5；
  - M4：原来先取消泵、后发代理停止，停止没送达时这一段反而更糟。现在先写代理停止，`STOP_SENT` 之后才取消泵；每一步单独重试；代理对一时的读、状态和 `ControlService` 失败也重试 10 秒；
  - M5：接受回执写失败时，轮询再也认不出这次接受，从不请求停止。现在从账本的 `80-owner-abort` 认出；
  - M6：HALT 期间的 P0 中止做整批范围的归档，只靠“到不了”保护。现在只要还有别的未归档现场就拒绝；
  - M7：补上上面各条和段运行中别的批次的中止、`OWNER_ABORT_NOT_AT_SAFE_POINT`、脚本写出的请求字段、`StopRequest.Decide` 的用例；
  - NIT：§6.5 里被转义吃掉的 `\r` 已恢复；静止复查改写为“最多 9 次”；写明第 1 段之前中止也会烧 head；已接受过的中止改用 `OWNER_ABORT_ALREADY_ACCEPTED`；companion 在 issue 转交和启动 worker 之间也检查取消；脚本对两个摘要参数做区分大小写的检查；本版本条目注明有自己的复审。代理的停止回执现在由执行器读取（N5）。
- 第二轮复审（对象：提交 `8c3ac363`，新的复审者，新上下文）结论 **PASS**：0 BLOCKER，0 MAJOR，M1–M6 确认修好，M7 部分修好；新提 3 个 MINOR、6 个 NIT。下列修正在之后的提交里，再交复审核对：
  - MINOR 1：段运行中写出读不全的 `80-owner-abort`，条目成了 UNREADABLE，段结束后批次照样跑发布段。现在段结束后按 `OWNER_ABORT_UNCONFIRMED` 记为未知并 HALT；读到 UNREADABLE 时不再把请求当过期拒掉；
  - MINOR 2：交换已被回复（助手自己先停了，或者停止回执是 `HELPER_ALREADY_STOPPING`）之后，泵再也取消不了，这一段要等泵到截止时间。现在 Windows 侧一结束就取消泵；
  - MINOR 3：补上闸门（接受到一半失败、以未知关闭也失败）和 `OWNER_ABORT_ALREADY_ACCEPTED` 的用例；
  - NIT：停止控制写成“最多送达一次”，代理注释说明一次超时送达的停止会以 `HELPER_ALREADY_STOPPING` 落定；`STOP_SENT` 的含义写准确；未知终态带上安全点、段和停止回执的码，闸门的 HALT 写出相关键；`owner-abort-stop-requested` 回执写失败后下次再写；tick 开始时的中止先核对已安装 Source 没有漂移（`OWNER_ABORT_SOURCE_DRIFT`）；§12 和窄竞争的文字补全。`-ExpectedHaltSha256`、`-ExpectedPausedSha256` 的大小写检查是这次之前就有的问题，本次不改。
- 第三轮复审（对象：提交 `7008d943`，又一位新的复审者）结论 **PASS**：0 BLOCKER，0 MAJOR；第二轮的 MINOR 1、2 确认修好，MINOR 3 部分修好；新提 1 个 MINOR、6 个 NIT。复审者用变异副本核对了闸门、`unconfirmed` 分支和 `windowsEnded`。下列修正在之后的提交里：
  - MINOR：闸门的用例原来测不到闸门（第一次写 HALT 就已经挡住了这一 tick）。现在让那一次 HALT 写入失败，断言 HALT 码是 `OWNER_ABORT_UNCONFIRMED`、`keys` 是这个批次、后面的 PR 没有运行；把闸门去掉，这个用例就失败。另补 `pendingAbort` 里 `OWNER_ABORT_ALREADY_ACCEPTED` 的用例；
  - NIT：§6.5 写准读不全的 `80-owner-abort` 的真实去向（HALT，下一 tick 隔离）；“Windows 侧结束”写成“调用已返回”；停止控制写成“实际只生效一次，重复送达没有副作用”；各条未知路径都带上安全点、段、停止回执的码和请求摘要；段先结束时也补写 `owner-abort-stop-requested` 回执；写明复位不做漂移检查。
- 第四轮复审（对象：提交 `4cd6dded` 相对 `7008d943` 的增量，又一位新的复审者）结论 **PASS**：增量里 0 BLOCKER、0 MAJOR，上一轮的 MINOR 和 6 个 NIT 中的 5 个确认修好（闸门用例经变异核对）。新提的都是 NIT，下列修正在之后的提交里：`requestStop` 注释和 §13.1 的“Windows 侧结束”改成“调用带着回复返回”，`windowsEnded` 挪到超时检查之后；补上段后补写回执、中止未知结局带事实的用例（两处都经变异核对）；读不全条目的用例延伸到下一 tick 的隔离和复位；`takeOwnerRequests` 遇到已接受、未完成的中止时记 `owner-abort-unconfirmed`，不再记成拒绝。复审者另指出，`unknown()` 遇到读不全的条目时不写终态记录，却仍写 `batch-terminal` 回执；这是这次之前就有的写法，本次不改。
- 第五轮复审（对象：提交 `81bb9f99` 相对 `4cd6dded` 的增量，又一位新的复审者）结论 **PASS**：0 BLOCKER、0 MAJOR、0 MINOR，4 个 NIT，新加的断言都经变异核对。之后的提交修正了这 4 个 NIT：干净结束的中止汇总回执写失败时，不再被记成未确认；补上“接受记录点名的是别的请求时照常拒绝”的用例；`windowsEnded` 的注释和 §6.5 第 4 步写全三种返回情况；`owner-abort-unconfirmed` 写进 §6.5 和 §11。
- 最终核对（对象：合入 main `fbb4a8d9` 之后的 head `514b4fc8`，含第五轮之后的修正和 Task `fe6cd7bc` 的几行，又一位新的复审者）结论 **PASS**：0 BLOCKER、0 MAJOR、1 MINOR、1 NIT。
  - MINOR：§6.2、§8.1 和附录里 Task `fe6cd7bc` 的几行写的是 PR #895 的宿主行为，那个 PR 还没合并。这是与该任务约定的做法（Clued 线程 `a137c18f`，option a）；PR 描述写明了这个依赖，两处改动都要等同一次重装（Task `0f6035b6`）才到主机。
  - NIT：服务记下请求之前就死了、恢复关闭批次之后再读到这个请求时，回执被记成拒绝。之后的提交改为 `owner-abort-unconfirmed`，只有这次中止自己的 `FAILED_CLEAN` `OWNER_ABORTED` 才算已了结；新增的两个用例都经变异核对。
- bootstrap 安装源复审（`11af4710`，发现 3，MINOR）：取消在一次 relay 调用失败期间写好时，泵仍做 blocked 转交，约 150–190 秒后才回复，回复码是 `RELAY_REFUSED_NO_RETRY`，与上面 §6.5 第 4 步不符。没有找到会导致 HALT 的路径（签发段事实不成立时，引擎不看泵的码）。之后的提交修正：内层 catch 先查取消，blocked 转交每一轮都查取消，转发 response 之前也查一次；新增 3 个用例。
  - 这次修正的独立复审（又一位新的复审者）结论 **PASS**：0 BLOCKER、0 MAJOR、1 MINOR、2 NIT。MINOR 和第一个 NIT 在这次修正之前就有；第二个 NIT 是这次修正在内层 catch 里加的取消检查带进来的。MINOR：每轮只查一次取消，列目录或 relay 回答“没有”之后，同一轮里仍会再调 relay，可能把 blocked 记录转过去。NIT：取消时停在失败的 SendIssue 或 blocked 转交自己的 ReceiveBlocked 上，回复的是原错误码；读取消文件出错时会跳过 blocked 转交。之后的提交修正：泵的每次 relay 调用之前都查取消（blocked 转交里也是），取消后不论停在哪一步都回复 `COMPANION_PUMP_CANCELLED`，读不出取消文件按没有取消处理；新增 3 个用例。

## 15. 需要 Owner 决定的事

- **D1 是否按本设计进入 Source v2 实现（P1）**，以及是否把本草稿提交为 PR（只含 `work/independent-ci-resident-v1/` 新文件）。
- **D2 `validUntil`**：**已决定**（Decision `1b5d3687`）：为空，直到 Source 变更或卸载。
- **D3 同一 head 的 attempt 2**：**已决定**（Decision `1b5d3687`）：自动 attempt 2 一次，只针对白名单里的干净暂时性失败、而且还没有角色发布过（§7.2）。
- **D4 Docker 由 systemd 管理**：**已确认**主机上已是 `docker.service`，不需要迁移代码。
- **D5 工作区保留规则**（R3）：**已决定**：只改名、从不删除；超过 50 GB 写提醒回执（§7.3）。
- **D6 cgroup v2**：**已确认**主机上 WSL 已启用 systemd 和 cgroup v2，不需要迁移代码。
- **D7 交换代理**：**已接受**（Decision `1b5d3687`）`CluedCISwapBroker`。

---

## 16. 排队、限额与故障保护·第一期：看得清，不白烧（v0.9，Task `12ada80e`）

- 依据：设计说明 v0.6 加 §9（资料中心 `10_E_工程与平台/CI基础设施/常驻执行器排队限额与故障保护_设计说明_v0.6_20261022.md`，sha256 `540c83f7…`）。
- 第二期是另一个 PR，同在 Task `12ada80e` 下：排队表、只跑最新、等待类退避、释放并重新排队、熔断、兜底数值。

### 16.1 与 Source 无关的已执行记录（v0.6 §2，§9 第 6、7 项）

- **问题**：账本按 (repo, head, Source, attempt) 烧号，所以换 Source 后每个 head 都算新的。没发布过检查的 head 这样没问题；发布过的不行。2026-10-22 r2 重装后 state 是新的，#896 的 21d6d7e3 又被准入，第 3 段 `ROLE_ALREADY_PUBLISHED_ON_HEAD`，执行器 HALT（Note `1550fef8`）。
- **记录**（`src/executed-heads.mjs`）：
  - 位置：`state\executed-heads\<键>\<来源>-<批次键前 16 位>.json`，只能新建；
  - 键是 (repo, head) 摘要的前 32 位，与 Source、attempt 都无关；
  - 只有目录、没有文件（写到一半）也算已执行。
- **什么时候写**：
  - 执行器在第一个可能发布检查的段之前写，即第 R、3、5、7、8 段（`executor.mjs#beforePublication`）；
  - 写不进去时，那一段不跑，以 `EXECUTED_HEAD_RECORD_UNCONFIRMED` 干净烧号。
- **回填**（每次安装后第一次启动做一次）：
  - 来源有两个：本 state 的账本，以及安装带入的旧 state（§16.1 末）。
  - 按 `mayHavePublished` 判定，保守地算“可能已发布”的有：
    - COMPLETED、FAILED_UNKNOWN、隔离；
    - 有转发计划；
    - 第 3 段及以后的 FAILED_CLEAN；
    - 第 3 段之后的 Owner 中止；
    - 账本条目缺失或未结束。
  - 只在第 1、2 段或工作区准备就结束的 head 不记，所以换 Source 后它们照旧能跑。
  - 完成后写 `BACKFILL-COMPLETE.json`。完成之前不跑任何批次，等待中的批次和 attempt 2 也不跑。
  - 出错时：
    - 清单缺失、格式不对、带入的文件不见或被改：HALT；
    - I/O 暂时错误：`BACKFILL_PENDING`，下个 tick 再试；从第一次失败起持续 `BACKFILL_PENDING_MAX_MS`（30 分钟）仍失败就 HALT（`EXECUTED_HEADS_BACKFILL_UNAVAILABLE`），不会无限重读，杀毒或备份软件锁几分钟文件也不会触发 HALT；
    - 解析不了的记录（包括写到一半的 0 字节文件）：计数（`unreadable`）后跳过，最后一道防线仍是发布者的 K(head, role)。
- **预检**：已执行的 head 一律忽略（`HEAD_ALREADY_PUBLISHED_NO_RETRY`），不论 Source、PR 号还是 base。要再跑，只能推新提交。
  - 唯一例外是同一 head 的 attempt 2：如果这个 head 唯一的记录文件是 attempt 1 自己在第 R 段之前写的那条（`executed-heads.mjs#onlyRelayRecordOf`），并且 attempt 1 的账本也表明它在第 0、1 或 2 段以 FAILED_CLEAN 结束、计划里没有转发任何角色（`executor.mjs#relayedNothing`），照常运行。记录按（来源、批次键）只建一次，单看文件分不出后面的段有没有跑过，所以要再核账本。
- **安装带入旧账本**（`install-resident.ps1` 第 1b 步 carry-forward）：
  - 来源是父目录下每个 `resident-uninstalled-*\state`：`ledger-heads`、账本的 00/10/25/80/90 记录、`executed-heads`；
  - 每个文件读一次、算哈希、CreateNew 写进 `state\backfill\<n>\`，并逐个列进只有管理员能写的 `install\backfill-manifest.json`。`<n>` 是序号，保证路径远低于 Windows 的 260 字符上限；
  - 遇到任何链接，在写入任何东西之前就拒绝安装；旧 state 超过 256 个（回填能读的上限）时也一样（`CARRY_FORWARD_TOO_MANY_STATES`）；
  - 0 字节的记录照样带入、列进清单（字节数 0），回填时计为 unreadable，回执的 `carriedSources` 里有每个来源的 `empty` 数；
  - 清单的每个来源还列出旧 state 里全部 `executed-heads\<键>` 目录（`heads`），包括没有记录文件的。回填为每个键建目录，不管记录能不能解析：目录本身就表示这个 head 可能已发布。否则一条写到一半的空记录会让这个 head 在再下一次重装时丢掉；
  - 旧 state 原样不动；
  - 计划只写规则，不列具体文件：旧 state 要等卸载改名之后才知道。具体文件记在安装回执和清单里。dry run 另外输出 `carryForwardPreview`，不进计划哈希；
  - `verify-resident.ps1` 新增两项检查：`backfill-manifest`，以及 `executed-heads-backfilled`（最多等 90 秒）。

### 16.2 阶段结果的诊断传到执行器（v0.6 §2，§9 第 4 项）

- **Source 侧**：
  - entry outcome（`stage-inputs.mjs#writeOutcome`）和阶段事实（`stage-fact.mjs#outcomeFacts`）都带上：
    - status、reason、sideEffects、mayHavePublished；
    - 清洗过的准入诊断：verdict、reasonCodes、nativeReasonCodes、`ciRetryAfter`、合并队列入队事实（Native 视图的 `state:'none'` 记为不在队列里，不是未知）；
    - scheduling；
    - entry 自己的 `safeToRerun`。
  - `full-admission-v2.mjs` 的拒绝诊断多了 `ciRetryAfter` 和 `mergeQueue`（`queue-facts.mjs#mergeQueueEntryV2`）。
  - 可选的 `scheduling` 监听在每次到达 Native 的评估后被告知这两个事实，只告知，不影响准入。
  - 准入事实合同（`ADMISSION_FIELDS_V2`）不变，所以 Linux 侧和适配器不受影响。
- **常驻侧**：`engine-windows.mjs#parseStageOutcome` 按固定形状重新校验，不合格就丢弃，只会少释放，不会多释放。结果写进三处：
  - `stage-terminal` 回执的 `outcome` 摘要；
  - 账本终态，或未执行记录里的 class、retry、breaker、reason、reasonCodes、nativeReasonCodes、ciRetryAfter、safeToRerun、brokerNoLaunch；
  - 状态快照。

### 16.3 机器可读的失败对照表（v0.6 §1，§9 第 1、2 项，§7 次要 6、7）

- **表本身**：`src/failure-table.json`，每个失败码一行；段或结局原因会改变结论的地方另加行。
  - 输入：（段、阶段、码、结局原因、诊断码）。
  - 输出：
    - 类别：not-admitted、waiting、deterministic-pr、unmapped-stage-1、transient、environment、clean-final、queue、abort、unknown；
    - 处置：release、release-if-safe、burn、halt；
    - 重试规则：new-trigger、attempt2、new-commit、owner-rearm；
    - 熔断输入：counts 或 neutral。第二期才用，现在先记下。
  - 匹配：最具体的行胜出，同样具体时取靠前的一行。没有行 = 未知，HALT。
- **释放的前提**（`classify.mjs#decideFailure`）：
  - 只在 10-started 之前，也就是第 1 段；
  - Windows 一半的清理证明齐全；
  - 以下二者之一：
    - 已绑定结局里 Source 自己给的 `safeToRerun`，绝不由原因码推断；
    - broker 明确说“没有发起启动、原样已恢复”，即 `broker_no_launch`，原因记为新的释放原因 `BROKER_NOT_LAUNCHED`。
- **其余一律烧号**：完整的两端证明下记 CLEAN，否则 UNKNOWN。
  - 确定性的 PR 问题即使带着 `safeToRerun` 也烧号，例如 `pr_files_page_limit`、PR 已关闭、文件过多、`PROTECTED_CHANGE_NOT_UP_TO_DATE`。
  - 没映射的第 1 段原因（`unmapped-stage-1`）烧号，并计入熔断。包括 Native 拒绝但没有原因码，或原因码本 Source 不认识（`unknown_reason`）。Native 有名字的未准入原因列在对照表的 `reasonCodesWithin` 里，测试保证 Source 的每个诊断码都有归属。
  - 诊断码里只要带确定性的 PR 码（`classify.mjs#DETERMINISTIC_REASON_CODES`，与 Source 的 `DETERMINISTIC_PR_REASON_CODES` 相同，含 `protected_change_not_up_to_date`），不论归成哪个码都不释放。这是常驻侧自己的检查，不只靠 Source 的标记。
- **Source 什么时候给 `safeToRerun`**：拒绝发生在首次准入的 boundary 里面（还没有批次认领记录，真实效果键下什么都没写），并且原因不是确定性的 PR 问题（`DETERMINISTIC_PR_REASONS`、`DETERMINISTIC_PR_REASON_CODES`，测试保证与对照表一致）。
- **未准入码的优先级**（`stage-fact.mjs#notAdmittedCode`）：`protected_change_not_up_to_date` 排第一。不是最新 main 的 head 无论 Native 还说了什么都过不了，所以它和 `owner_review_required` 同时出现时归为 `PROTECTED_CHANGE_NOT_UP_TO_DATE`，不归为等待。
- **与 v0.8 相比的行为变化**：
  - 第 1 段的未准入码只在有 `safeToRerun` 时释放；
  - 第 1 段 broker 没启动时释放；
  - `PROTECTED_CHANGE_NOT_UP_TO_DATE`、`PR_NOT_OPEN_OR_CHANGED` 在第 1 段改为烧号。
- **第一期的边界**：释放后不会自动重新排队，要有新的触发；现有的 10 分钟冷却和每天 3 次上限照旧适用，每个释放原因的规则见 `UNEXECUTED_REASON_RULES`。释放并重新排队、按行重试、等待类和熔断按 v0.6 §2 在第二期一起上线（Task `12ada80e`）。

### 16.4 Source 侧的其他修正（v0.6 §1、§2，§9 第 3、5 项）

- **批次认领记录**（`batch-claim-v2.mjs`）：
  - 身份不再包含 createdAt，同一内容和 attempt 的后一批读到的就是同一条记录；
  - 认领代（claim、fence、epoch）照旧比较；
  - 核查结果：控制端 `consumer.mjs` 不受影响。它用记录自己的字段重新导出作业，而作业 id 本来就不含 createdAt。有测试覆盖。
- **GitHub 暂时错误**：`github_http_5xx`、`github_http_429`、`github_transport_unconfirmed` 映射为 `GITHUB_TRANSIENT_UNAVAILABLE`。
  - 只在 BLOCKED 且零副作用时映射，可能写到 GitHub 的写入永远不算暂时；
  - 403 有歧义，不映射。

### 16.5 poller 只提议跟上 main 的提交（v0.6 §2，§7 次要 12）

- **条件**：PR 的 `base.sha` 等于 main 尖端，并且 compare（main...head）的 `behind_by` 为 0（`poller.mjs#upToDate`）。两个固定提交的 compare 结果会缓存。
- **限量**：每次 compare 最多 15 秒；每轮最多 10 次没缓存的 compare，其余的这一轮记为 `compare-unavailable`（不提议），下一轮再比。超时的 compare（子进程还在跑，Runner 仍忙）结束这一轮的 compare，不占名额，并且 15 分钟内不再比这一个，排在它后面的 PR 下一轮照常比。
- **不提议的 PR**：在 `lastPass` 里给出提示：
  - `merge-main`：head 不含 main；
  - `push-any-commit`：已含 main，但 GitHub 的 base.sha 还是旧的，推任意一个提交即可。
- 2026-10-22 有 9 个 base 过期的 head 就是这样在第 1 段被烧掉的。

### 16.6 状态快照、PR 页面状态、Windows 通知（v0.6 §2，§7 次要 2、3、10；Decision `38936534`）

- **`state\status.json`**（`src/status.mjs`）：
  - 内容：执行器状态、正在跑的批次和段、排队的触发（及等待原因）、最近结果、额度、HALT、回填情况；
  - 整体替换（临时文件加改名），由服务的定时器每 15 秒重写一次。所以长阶段里 `writtenAt` 也在走，只有它停了才表示执行器停了；`changedAt` 只在内容变化时更新；
  - 它只是视图，执行器的任何决定都不读它。
- **PR 页面**（`src/pr-status.mjs`，companion）：
  - 每个打开的 PR 的当前 head 挂一条 commit status，上下文是 `resident-queue (info only)`。只写状态，不发评论，所以不改 PR 的更新时间；
  - 起决定作用的是写之前实时读 main 的规则：名字一旦出现在必需检查里就不写，并通知一次；读不到规则时也不写。本仓库只用规则集保护 main，经典分支保护返回 404（2026-10-22 核实），所以读规则能看到全部必需检查。固定的 ` (info only)` 后缀只是让重名不太可能，矩阵作业也可能起这种名字；
  - 只有状态或文字变化时才写，每轮最多 20 条；“已提议”这类泛泛的文字不会覆盖已写过的状态；写失败的 head 10 分钟内不再试。
- **Windows 通知**：在 Owner 会话里弹出，每个事件键只弹一次。事件有：
  - HALT；
  - 状态超过 5 分钟没更新；
  - 某个 PR 提交排队超过 1 小时，按（PR、提交、原因）各一次；
  - 状态名与必需检查重名。

  文字都是固定模板加稳定码。
- 去重记录放在 Owner 自己的 `%LOCALAPPDATA%\CluedIndependentCI\`，不放在常驻目录。
- `companion.json` 的 `status` 可以分别关掉这两项，默认都开。
- **两条线**（`companion-main.mjs#lane`）：companion 自己的动作（邮箱：bundle、工作区、Linux 归档和静止证明、转发泵）和咨询性工作（poller、PR 页面状态、通知）各走一条线，各用自己的 Runner。
  - Runner 从不杀子进程，所以一个卡住的 gh 只会占住它自己那条线；服务要的证明（例如 2 分钟期限的 `linux-quiescence`）照常应答，GitHub 再慢也不会让邮箱请求过期，进而导致不该有的 HALT（独立复核 M1）。
  - 咨询性的每次调用最多 15 秒，每轮 PR 页面加通知最多 60 秒，超时后这一轮不再发起新调用。
  - 调用超时或 Runner 仍忙时，这一轮就此结束；没做成的事不记为已做或失败：没弹出的通知下一轮再弹，没写成的 PR 状态不进 10 分钟的失败名单。
  - 通知先于 PR 页面：通知只在本机，不应排在慢的 GitHub 后面。
  - 之前“泵送桥接段时 PR 页面和通知要等泵结束”的限制因此不再存在。

### 16.7 policy 合同

- 第一期没有新设置，合同仍是 `/3`，`validatePolicy` 不变（上限 48/96）。
- 重装时 policy 沿用现行临时值 48/96（Decision `a17b3a7a`）。
- 第二期新增第一个设置时升到 `/4`（Task `12ada80e`）。

### 16.8 测试

- **常驻层**：Node 191/191，新增 `failure-table`、`executed-heads`、`stage-outcome`、`status`、`pr-status` 五个测试文件。其中必需的一条：全新 state 加旧账本存档（只带账本、不带 executed-heads，与第一期之前的安装一样），曾经发布过检查的 head 不再准入，包括第 3 段遇到 `ROLE_ALREADY_PUBLISHED_ON_HEAD` 而 HALT 的那种；回填完成前不跑任何批次。
- **离线演练**：40 步，新增重装后回填的三步。
- **PowerShell**：`windows/test-install-carry.ps1`，36 条断言，含 node 用真实回填读安装写出的清单（含 0 字节的账本记录、0 字节的已执行记录和没有记录的键）、dry run 预览每个旧 state 一项、链接拒绝和超过 256 个旧 state 的拒绝；`windows/test-resident-windows.ps1` 不变，仍通过。
- **Source v2**：Node 173 项通过、1 项跳过，新增 `resident-v2-quota-phase1.test.mjs`，并在准入和发布者测试里加了用例。

### 16.9 独立复核与修正

结论“修复后可接受”：没有 BLOCKER；第一期的三条安全要求成立（发布过检查的 head 不再准入，回填完成前不跑批次，第 1 段只凭 Source 的 `safeToRerun` 或 broker 的“没有发起启动”释放）。发现的问题都在本 PR 内修正：

| 编号 | 问题 | 修正 |
|---|---|---|
| M1 | 新增的 PR 页面状态、通知和 compare 与邮箱共用一个 Runner，GitHub 慢时会让 `linux-quiescence` 过期，导致 UNKNOWN 和 HALT | 两条线各用自己的 Runner；单次 15 秒、每轮 60 秒；compare 每轮最多 10 次；写失败 10 分钟内不重试（§16.5、§16.6） |
| MINOR 1 | `owner_review_required` 加 `protected_change_not_up_to_date` 会被当成等待而释放 | `notAdmittedCode` 把后者排第一；Source 的确定性码表加上它；常驻侧遇到确定性码一律不释放（§16.3） |
| MINOR 2 | Native 没有原因码或原因未知时会被释放 | 有名字的原因列入对照表，其余归 `unmapped-stage-1` 烧号并计入熔断（§16.3） |
| MINOR 3 | dry run 的 `carryForwardPreview` 把所有旧 state 合成一项 | 先赋值再 foreach，测试直接运行安装脚本里的那一行 |
| MINOR 4 | 旧 state 里有 0 字节记录时整个安装被拒 | 照样带入并列入清单，回填计为 unreadable（§16.1） |
| MINOR 5 | 第 R 段跑过但没转发任何角色时，attempt 2 被自己的已执行记录挡住 | 预检对 attempt 2 放行 attempt 1 自己的第 R 段前记录（§16.1） |
| MINOR 6 | 回填的非 ResidentError 失败会无限 `BACKFILL_PENDING` | 连续 10 次后 HALT（§16.1） |
| MINOR 7 | Native 的 `state:'none'` 被当成未知 | 记为不在队列里（§16.2） |
| NIT | 必需用例里声明的 HALT 场景没执行；名字形状的说法不准；PowerShell 侧没有 256 个来源的限制；写失败每分钟重试 | 场景已执行并断言；注释改准；安装前拒绝；10 分钟内不重试 |

修正提交的第二次独立复核：上面各项都已修好；修正本身带出 2 个 MINOR、3 个 NIT，没有 BLOCKER 或 MAJOR，也都已修正：

| 编号 | 问题 | 修正 |
|---|---|---|
| MINOR-A | 带入的空的或写坏的 executed-heads 记录在回填时被跳过，这个 head 的“可能已发布”在下一次重装时丢掉 | 清单列出每个旧 state 的 executed-heads 键，回填为每个键建目录，不管记录能否解析（§16.1） |
| MINOR-B | 咨询线的调用超时后，同一轮后面的调用被 Runner 以“忙”拒绝，拒绝被当成真实结果：HALT 通知的键被占掉、PR 状态被标失败、compare 名额被扣 | 超时或忙时这一轮结束，不占键、不标失败、不扣名额；超时的 compare 15 分钟内跳过；通知先于 PR 页面（§16.5、§16.6） |
| NIT 1 | attempt 2 放行只看记录文件，单看文件分不出后面的段 | 另核 attempt 1 的账本（§16.1） |
| NIT 2 | 常驻侧的合并队列状态没有 `none` | 加上，并有测试保证与 Source 一致 |
| NIT 3 | 确定性码推翻等待行时，账本仍记 waiting；回填只容忍约 2.5 分钟的暂时错误 | 账本和状态记实际生效的 deterministic-pr / new-commit；改为按时间计（30 分钟） |

---

## 17. 额度第二期·第 1 步：执行器自己的排队表、等待与熔断（v1.0，Task `6451a55d`）

- 依据：设计说明《常驻执行器额度第二期（含合并列车）设计说明 v0.5》（资料中心 `10_E_工程与平台/CI基础设施/`，sha256 `bd20941b…`）§4.1–§4.7、§4.10、§6 第 1 步；Owner 决定 `6c69755a`、`e1e19e2e`。
- 本步不改 Source v2、不改 KooYomi 服务端、不碰合并列车与停靠（§4.8、§4.9、§5 是第 2 步以后）。

### 17.1 排队表（`src/queue.mjs`，设计 §4.1）

- **位置与写法**：`state\queue\queue.json`，每次变化整体替换（临时文件、刷盘、改名），和 `status.json` 一样。这相当于设计里的“只新建的日志加定期压缩的快照”在每次写入时都压缩：崩溃后读到的是旧的或新的一份，不会是半份。内容没变时不写（空闲 tick 每 15 秒一次，不产生写入）。
- **只是视图**：排队表决定“下一个试谁”，不决定“能不能跑”。能不能跑仍由账本（烧号、已执行记录、预留）和第 1 段的 Native 准入决定；排队表与账本不一致时以账本为准：
  - 每个 tick 开头，排队表里标着“在跑”而账本已结束的行，按账本的结局结算（`executor.mjs#reconcileQueue`）；HALT 时也做，状态页因此显示账本的实际结果；
  - 内容读不出（形状不对、JSON 坏了）的排队表改名留存（`queue.unreadable-<时间>-<随机>.json`，不删除），重新开始，并换一个 `generation`。状态快照带出 `generation`，poller 看到它变了就把所有打开、跟上 main 的 PR 重新提议一遍，排队表就从 poller 和账本重建。I/O 错误（被杀毒软件锁住等）不算读不出：服务启动失败，下次再试，不重建。
  - 重建后的排队表里熔断从“半开”开始：失败位置记为“到跑完为止”，下一次计入的失败立刻重新打开，只有跑完一批才关闭；释放上限照样从账本核对（17.3），所以重建不会多放过任何东西。
- **每个 PR 一行**：当前提交（head、base、到达序号、首次到达时间）、正在跑的提交、被替换过的提交（最多 8 个）、见过的提交（最多 32 个）、状态、原因码、下次可试时间、退避级数、新触发、PR 更新时间、来源（`origin`）。
- **状态**：`QUEUED`、`RUNNING`、`WAITING`（等待类退避）、`BACKOFF`（被释放、按行退避）、`STOPPED`（烧号，或达到释放上限）、`DONE`。停靠的 `PARKED` 在第 2 步。
- **深度**：活着的行（QUEUED、RUNNING、WAITING、BACKOFF）最多 `limits.queueDepth`（100）；超过时新的 PR 被拒（`trigger-refused`，`QUEUE_DEPTH_EXCEEDED`）。`DONE`、`STOPPED` 满 24 小时的行被压缩掉。

### 17.2 到达序号、取代与新触发（设计 §4.2；v0.6 §3、§9 第二期 1、5）

- 收件箱里的触发每个 tick 都读进排队表（每 tick 最多 `inboxMaxFiles` 个），序号由执行器读到时自己编。排队表写成功之后才把触发文件归档；写不成就留在收件箱，下次再读；两者之间崩溃也一样。同一触发再读一次不改变任何东西。
- **这个 PR 没见过的提交**：
  - 当前提交还在等（QUEUED、WAITING、BACKOFF）：替换它，旧的进“被替换过”，不评估、不烧号；
  - 当前提交正在跑：新提交成为当前提交，跑着的批次在下一个安全点决定（17.4）。
- **见过的提交**：不替换任何东西（companion 重启后又提议旧提交、poller 一轮里读到的旧 head）。
- **新触发**（触发合同 `/2`，见 17.6）：当前提交的触发没有 `prUpdatedAt`（Agent 自己写的），或者比这一行记下的新，就是新触发。它让等着下次重试的行（WAITING、BACKOFF，以及因释放上限停住的 STOPPED）在 10 分钟冷却后到期：
  - 计入 96 的评估名额；每个（PR，提交）每天最多 `limits.reevaluationsPerPrHeadPer24h`（6）次，超过就丢掉这次新触发，状态写 `REEVALUATION_CAP`；
  - 通知 Owner 一次（每个 PR 提交一次）。
  - 停住的行（烧号，或达到释放上限）只有新提交才会再跑（设计 §4.5）。新触发只作用于还在等下次重试的行。
  - 来自未来的 `prUpdatedAt`（收件箱是不受信任的）按现在算，不会让以后的编辑都“不算新”。
- **PR 关闭又重新打开**：关闭时这一行结束（`PR_CLOSED`，不算烧号）；poller 再提议同一个 head 时重新排队，能不能跑由账本决定。
- **证伪后恢复**：第 1 段或打包以 `PR_NOT_OPEN_OR_CHANGED`、`REMOTE_REFS_CHANGED_SINCE_BUNDLE`、`BUNDLE_UNAVAILABLE`、或 `STAGE_CHILD_REFUSED`（`pr_subject_changed`、`pr_files_changed`）结束时，companion 实时读一次 PR（17.5）：
  - PR 已关闭：这一行结束（`PR_CLOSED`）；
  - 看到的 head 在“被替换过”里，并且账本与已执行记录都说它没烧：恢复为当前提交（恢复的是实际看到的那个，不是序号最新的那个）；
  - 其他情况不动，等 poller 提议。

### 17.3 调度、退避与额度（设计 §4.3–§4.5、§4.7；v0.6 §7 次要 4）

- **每个 tick 的顺序**：崩溃恢复、Owner 请求、HALT、回填、暂停照旧在最前；然后读收件箱；然后等托管的批次（第 2 步改为停靠）；然后：
  1. 到期的 attempt 2；
  2. 到期的等待重试和收到新触发的行（按到期时间）；
  3. 其余按到达先后（被释放的行排到队尾）。
  一次最多看 16 行。只对某一行生效的推迟（冷却、本 PR 今日批次已满、等待预算用完、重评上限、释放上限）只挡这一行，并在 5 分钟后（冷却则在冷却结束时）再看它；全局的推迟（今日执行额度已满、companion 没就绪、熔断）结束这一轮。评估额度已满只挡它管的评估：这一轮后面到期的等待重试照样跑（等待有自己的预算）。
- **释放后重排**：释放的前提不变（第一期：只在 10-started 之前，Source 的 `safeToRerun` 或 broker 的“没有发起启动”，§16.3）。释放后这一行排到队尾，按行退避 10 → 20 → 40 分钟，不再需要新触发。同一个 head 24 小时内计数的释放最多 `limits.releasesPerHeadPer24h`（2）次：达到这个数的那次释放就让这一行停住（`STOPPED`，释放上限），通知一次，只有推新提交才会再跑。预检也从账本核对这个上限（`RELEASE_CAP_REACHED`），所以排队表重建以后也不会多评估一次；等待、新触发、attempt 2，以及熔断关闭时解除的行（`origin: lifted`，见 17.7）不受它约束。
- **等待类**：失败对照表 `class: waiting` 的释放（`OWNER_REVIEW_REQUIRED`、`TASK_CI_HEAD_CAP_REACHED`、只含 `merge_slot_required`、`merge_slot_missing`、`evaluation_not_completed` 的 `NATIVE_NOT_ADMITTED`；混着确定性 PR 码的不算，§16.3）进 `WAITING`，退避 10 → 20 → 40 → 80 → 120 分钟，之后每 120 分钟；`TASK_CI_HEAD_CAP_REACHED` 按 KooYomi 给的 `ci_retry_after`（不早于 10 分钟、不晚于 24 小时）。等待不受释放上限约束。
- **额度一律从账本推算**（`ledger.mjs#usage`）：`00-reserved.json` 新增 `origin`（`queued`、`backoff-retry`、`waiting-retry`、`new-trigger`、`restored`、`attempt2`；旧记录没有这个字段，按 `queued`）。排队表丢了，额度也不会清零。
  - 执行（`maxBatchesPer24h`，72）：24 小时内 `ledger-heads` 的记录（含第 1 段烧号）。到上限推迟、通知一次、不丢弃。
  - 评估（`maxEvaluationsPer24h`，96）：没有执行的预留，不含等待重试（它有自己的预算）、环境类与暂时类的结局（它们归熔断管）、取代（SUPERSEDED、broker 没启动、打包失败）。新触发引起的重评计入。
  - 等待重试（`waitingRetriesPer24h`，48）：`origin = waiting-retry` 的预留。用完后等待行停在 `WAITING_BUDGET_EXHAUSTED`，状态可见，通知一次。
  - 新触发重评（`reevaluationsPerPrHeadPer24h`，6）：每个（PR，提交）`origin = new-trigger` 的预留。
  - 每个 PR 的批次（`perPrBatchesPer24h`，6）：车头批次不受限是第 3 步的事。
  - 每个 head 的释放（`releasesPerHeadPer24h`，2）：不含等待、取代，也不含熔断没关时的环境类释放。
  - 为了不每个 tick 读遍整个账本，`usage` 先按文件修改时间跳过窗口前（留 1 小时余量）就写完的条目，放进来的每条再按记录里的时间判断。
- **`UNEXECUTED_REASON_RULES`**（v0.6 §7 次要 6）：每个释放原因写明 10 分钟冷却是否适用（取代不适用，其余适用）和用哪个上限代替第一期的“每个 key 每天 3 次”（`unexecutedMaxPer24h` 随 policy `/4` 去掉）。新增释放原因 `SUPERSEDED`。

### 17.4 正在跑的批次被取代（设计 §4.2；v0.6 §3）

- **第 1 段之前**（打包之后、`before-stage-1` 安全点）：再读一次收件箱；这个 PR 有了更新的提交，就关闭批次、以 `SUPERSEDED` 释放（PR 页面码 `BATCH_SUPERSEDED`）：什么都没跑，不烧号，旧 head 回到“被替换过”，新提交下一个跑。这里按到达顺序判断就够（v0.6 §3）。
- **第 1 段之后**：只在 Linux 准备之外的两个安全点（`before-relay-plan`，每次恢复等托管的批次时也在这里；`before-workspace`）判断，而且只凭实时读：
  - companion 读到 PR 已关闭，或 head 已不是这个批次的 head：执行器自己结束批次，走 Owner 中止的同一条路（§6.5）：
    1. 先只新建 `81-self-abort.json`。从这一刻起这个条目不再是可恢复的等待：中途崩溃时，重启后的恢复把它当现场，`FAILED_UNKNOWN SUPERSEDE_INTERRUPTED` 加 HALT，与 `80-owner-abort` 的 `OWNER_ABORT_INTERRUPTED` 相同，绝不会在归档到一半的现场上接着跑；
    2. 两端静止证明（最多 5 分钟复查），不全就 `SUPERSEDE_QUIESCENCE_UNPROVEN`：UNKNOWN 加 HALT，现场不动；
    3. 烧号、两端只改名归档（固定原因 `superseded`）、`FAILED_CLEAN SUPERSEDED_AT_SAFE_POINT`（终态记 `stage: 1`，已执行记录的回填因此判它没有发布，§16.1；第 R 段转发过角色的，由转发计划判为已发布）。对熔断中性，从不排 attempt 2。
  - 读到的 head 仍是这个批次的 head：排队表里那个“更新的提交”被证伪，退回“被替换过”，批次继续。
  - 没有答复：继续跑（实时读只用来拦下，不用来放行，也不因读不到而拦下）。
  - 等托管的批次每个 tick 都会恢复一次：同一个批次最多每 10 分钟实时读一次（`SUPERSEDE_LIVE_READ_MS`），读不到时的回执也一样。
  - ws-prep 之后到最后一个 Linux 段之间不判断；已过第 3 段的批次照旧跑完。
- **attempt 2**：到期时这个 PR 已有更新的提交，先实时读一次：
  - 读到 head 已变或 PR 已关闭：关闭这次 attempt 2（`ATTEMPT2_SUPERSEDED`）；
  - 读到 head 仍是 attempt 1 的：排队表里那个“更新的提交”被证伪，退回“被替换过”，attempt 2 照常跑；
  - 读不到：attempt 2 照常跑，由第 1 段判断。
  attempt 2 不走“第 1 段之前按到达顺序释放”（只有实时读能作废它，v0.6 §3）。
- 为什么 SUPERSEDED_AT_SAFE_POINT 不改 Source：安全点上没有任何段在跑，Source 看不到这个结局；它和 `OWNER_ABORTED` 一样是常驻层自己的码，登记在失败对照表（`clean-final`、`burn`、`new-commit`、`neutral`）。所以第 1 步只改常驻层，重装时 Linux 一侧的 Source v2 不变。

### 17.5 实时读 PR：companion 的 `pr-head`（设计 §4.2；v0.6 §9 第二期 5）

- 新的邮箱请求 `pr-head {batchId, pr}`，答复多一个 `pull` 字段 `{number, state: open | closed | merged, headSha}`，形状精确校验，只有 `pr-head` 的答复可以带它，PR 号必须等于请求的号。
- companion 用 Owner 自己的 gh 登录，固定参数 `gh api --method GET repos/<repo>/pulls/<n> --jq …`，在邮箱那条线上运行（30 秒上限，服务端等 2 分钟）。没有读端口或读不到就答 `PR_HEAD_UNAVAILABLE`，从不猜。
- 它的答复只能让批次停下或让一个提交重新排队；放行永远由第 1 段的 Native 准入决定。

### 17.6 触发、状态与 PR 页面（设计 §4.2、§4.10）

- **触发合同 `/2`**：可选的 `prUpdatedAt`（ISO 时间），poller 填 PR 的更新时间。`/1` 照常读，等同于没有 `prUpdatedAt` 的 `/2`。合并相同触发的 `coalesce` 去掉了，排队表自己合并。
- **状态快照 `/2`**：`pending` 改为排队表的视图（每行的状态、原因、在能跑的行里排第几、下次重试时间、**估计**开始时间：前面每批按 22 分钟，只是估计），另有 `queue`（generation、活行数）、`breaker`、`notices`。
- **PR 页面**（`pr-status.mjs#describe`）：排第几、预计何时开始、为什么没跑（冷却、本 PR 今日批次已满、额度已满、熔断中及试跑时间）；等待中及约何时自动重试；未准入或未执行后的自动重试；停住及怎样再跑；HALT、暂停照旧优先。
- **通知**：排队超过 1 小时（每个 PR、提交、原因一次；停住和已完成的行不算）；执行器的通知（`queue.mjs#notice`，每个键一次）：新触发、某行停住、等待预算用完、执行额度已满、熔断打开及试跑时间。

### 17.7 熔断（`src/breaker.mjs`，设计 §4.6；v0.6 §4、§9 第二期 6、7）

- **计数**：每个批次结束给熔断一个事件：结束的位置（打包、第 1 段、第 R 段、工作区准备、第 2–8 段、跑完），以及对照表那一行的 `breaker`（counts 计入，neutral 不计）。被忽略、被推迟的不算事件；Owner 中止不算。
- **打开**：连续 3 次计入的失败（中间有批次跑完，或越过了最近一次失败的位置，就不算连续），或 1 小时内 4 次。打开后不开任何新批次（含 attempt 2），试跑间隔 30 → 60 → 120 分钟，之后每 120 分钟，不锁死。状态与通知写明下次试跑时间。
- **半开**：到点后一次放一批试跑；试跑不选刚才失败的那些 PR（除非没有别的可选）。
- **失败位置**：打开它的那些失败里最靠后的位置（试跑要越过每一个失败的地方），以及它们是不是都只碰 Windows。
- **关闭**：试跑跑完；或越过了失败位置；或在那个位置以中性结果结束（第 1 段那一类故障，KooYomi 给出明确答复，含明确拒绝，就是这种情况）。没碰 Linux 的结局（第 1 段、第 R 段的结局，所有角色都转发的跑完）不能关闭 Linux 位置引起的熔断。关闭时，因环境类释放达到上限而停住的行自动解除（`origin: lifted`，下一次不受释放上限约束）。
- **试跑失败**（计入）：再打开，换下一档间隔。其他结局（中性但在失败位置之前、释放、忽略）不下结论，保持半开，下一个候选就是下一次试跑。
- 第 1 段之后的失败，试跑与否都烧号（v0.6 §9 第二期 7）。

### 17.8 policy 合同 `/4`

- 新增 `limits.perPrBatchesPer24h`、`waitingRetriesPer24h`、`reevaluationsPerPrHeadPer24h`、`releasesPerHeadPer24h`、`queueDepth`，以及 `breaker {consecutive, windowCount, windowMs, backoffMs}`；`maxBatchesPer24h` 上限放到 72；去掉 `unexecutedMaxPer24h`。
- 设计 §4.7 把第二期全部设置列在一张 `/4` 表里；实现上每一步只加自己用到的设置、各用自己的合同号（第 2 步的停靠、第 3 步的列车各升一号），装上的 policy 只写它的代码会做的事。
- 重装时的取值（设计 §4.7）：72 / 96 / 6 / 48 / 6 / 2 / 100，熔断 3 / 4 / 1 小时 / 30、60、120 分钟。在这之前 48/96（Decision `a17b3a7a`）继续有效。

### 17.9 实测核对

- PR 页面的 commit status 不改 PR 的 `updated_at`（2026-10-22 核对 #902：最近一条 `resident-queue (info only)` 在 13:46:46Z，PR 的 `updatedAt` 仍是 13:07:36Z），所以 poller 不会因为自己写的状态又提议一次。

### 17.10 测试

- **常驻层**：Node 255 项全部通过（含合入的 F2 #905 的测试）。新增：
  - `test/queue.test.mjs`：序号与取代、见过的提交不替换、跑着时的新提交、证伪与恢复、等待与释放的退避、释放上限、新触发与冷却、深度只数活行、24 小时压缩、熔断解除环境类停住、读不出时改名留存并换 generation、状态视图；
  - `test/breaker.test.mjs`：位置、打开（连续与 1 小时窗口）、试跑间隔、试跑不选失败的行、关闭条件、只碰 Windows 的规则、policy `/4` 的界限；
  - `test/scheduler.test.mjs`：调度顺序与只挡一行的推迟、额度从账本来、等待预算、熔断打开与试跑关闭、第 1 段前的取代释放、第 1 段后的实时读（确认、证伪、无答复）、证伪后恢复、被取代的 attempt 2、重启后排队表与账本对齐。
  - 原有测试按新行为更新：同一 PR 再提议已执行过的 head 现在由排队表认出（不再预留），“不再运行”改由另一个 PR 号验证账本仍然挡住。
- **离线演练**：46 步，新增等待行自动重试、打包期间被取代、熔断打开与试跑关闭。
- Python 25 项、`windows/test-resident-windows.ps1`、`windows/test-install-carry.ps1` 照常通过。

### 17.11 独立复核与修正

第一次复核结论 REJECT：1 个 BLOCKER、2 个 MAJOR、9 个 MINOR、若干 NIT，都是局部问题，不需要重新设计。已执行记录、只在 10-started 之前释放、HALT 先于终态、`mayHavePublished` 的判定都经复核确认成立。修正如下：

| 编号 | 问题 | 修正 |
|---|---|---|
| B1 | `service-main.mjs` 没有创建排队表，装上后服务起不来 | 打开 `state\queue` 并传给执行器；测试按执行器要求的端口核对服务入口 |
| M1 | 执行器自己结束批次时没有先写记录，中途崩溃后会在归档到一半的现场上恢复等待 | 先写 `81-self-abort.json`；可恢复判断排除它；恢复时 `SUPERSEDE_INTERRUPTED` 加 HALT（17.4） |
| M2 | attempt 2 只凭到达顺序就被作废，实时读证伪也照样作废 | 证伪时把更新的提交退回“被替换过”；attempt 2 不走按顺序释放（17.4） |
| m1 | 评估额度满时，一个收到新触发的行挡住后面到期的等待 | 评估额度只挡评估（17.3） |
| m2 | 熔断的“只碰 Windows”规则没有输入 | 按结局是否到过 Linux 准备判断（17.7） |
| m3 | 失败位置只记最后一次 | 取打开时各次失败里最靠后的位置（17.7） |
| m4 | 排队表重建会清掉熔断和释放上限；I/O 错误也会触发重建 | 只有内容错误才重建；重建后熔断半开；预检从账本核对释放上限（17.1、17.3） |
| m5 | 释放上限差一：实际允许 3 次 | 达到 2 次就停（17.3） |
| m6 | 排队表写失败时触发仍被归档 | 写成功之后才归档（17.2） |
| m7 | 新触发能让释放上限停住的行再跑，偏离设计 | 按设计：停住的行只有新提交才会再跑（17.2） |
| m8 | 未来时间的 `prUpdatedAt` 会让以后的编辑都不算新触发 | 按现在算（17.2） |
| m9 | 等托管期间每个 tick 都可能实时读一次、写一条回执 | 每个批次最多每 10 分钟一次（17.4） |
| NIT | 账本里已不在的预留一律按释放结算；关闭的 PR 记成烧号；释放上限停住的行被新提交替换时旧 head 不进“被替换过”；注释与代码不一致；排队表满时没有通知；状态写入是否改 PR 更新时间未核实 | 按它自己的未执行记录结算（等待仍是等待）；关闭不算烧号；进“被替换过”；注释改正；每天通知一次；已实测核对（17.9） |

复核还指出缺的测试，都已补上：服务入口的端口、自我结束中途崩溃与静止证明不全、`before-workspace` 安全点、等托管期间被取代、attempt 2 证伪和无答复、重建后释放上限仍然有效、熔断关闭解除环境类停住、执行器层面的重评上限与评估额度、执行额度推迟不丢弃并只通知一次、写不成排队表时触发留在收件箱、熔断的失败位置与“只碰 Windows”规则。

第二次复核（确认性）结论 ACCEPT-WITH-FIXES：B1 要等服务入口接上排队表才能合入（本 PR 已接上，当时 `service-main.mjs` 还被另一个认领占着），其余各项都确认已修；修正本身没有带来安全上的退步，只新带出 1 个 MINOR（文字不一致）和几条 NIT，已在 `2c32d5a6` 修正：

| 编号 | 问题 | 修正 |
|---|---|---|
| N1（MINOR） | 停住的说明写“修正后编辑 PR 可再试”，与 m7 的修正（停住的行只有新提交才会再跑）不一致 | 改为“请修正后推新提交” |
| N2（NIT） | 排队表一直写不进时，新触发留在收件箱里，没有任何提醒 | 连续 3 个 tick 写不进就通知一次并写回执；排队之前就被拒绝的触发不等排队表、照常归档 |
| NIT | 实时读按批次节流 10 分钟，第二个新提交要等 | 按（批次，最新提交）节流 |

## 18. 额度第二期·第 2 步：停靠（v1.1，Task `6451a55d`）

- 依据：设计说明 v0.5（资料中心 `10_E_工程与平台/CI基础设施/`，sha256 `bd20941b…`）§4.3、§4.7、§4.8、§4.9、§6 第 2 步；Owner 决定 `e1e19e2e` 第 4 项（非列车模式的第 8 段 = 停靠等候，`stage8.mode = park`）、`c32676f4`（等托管结果时不占住执行器）。
- 本步改 Source v2 的第 8 段（只多了零副作用的“没就绪”退出），所以重装要 UAC 加 Linux root。不改 KooYomi 服务端，不碰合并列车（§5 是第 3 步以后）。

### 18.1 两个停靠点与 Linux 独占区（设计 §4.3）

- **Linux 独占区**：一个批次从工作区准备开始，到它最后一个 Linux 段结束、两端收尾归档完成为止。独占区内不插任何别的段，执行段和紧跟的发布段之间也不插；一个 tick 最多跑一个独占区，独占区内从不停靠。
- **停靠点 A**：第 1 段（和第 R 段的等托管）之后、工作区准备之前（`15-relay-wait.json`，与以前相同）。
- **停靠点 B**：最后一个角色段之后、两端收尾归档之后、第 8 段之前（`70-parked.json`）。收尾归档从第 8 段之后挪到了第 8 段之前：第 8 段只碰 Windows，停在 B 的批次 Linux 侧什么都没有。
- 停在任一停靠点的批次什么都没在运行；执行器在它停着时照常跑别的批次。账本原来的“只能有一个等待中的批次”（`RELAY_WAIT_MORE_THAN_ONE_BATCH`）去掉，改由执行器按 `park.maxParked` 限制（18.5）。

### 18.2 停靠点 A：等托管不占执行器（设计 §4.8）

- 每个 tick 开头（崩溃恢复、Owner 请求、HALT、暂停之后），每个停在 A 的批次读一次托管提示、按保存的 t0 判断；结论是“继续”就照 18.1 一口气跑到停靠点 B（或结束）；都还在等就接着调度别的行。总上限仍是 60 分钟，从 t0 算，被别的批次推迟的时间也算在内。
- **bundle 太旧**：设计 §4.3 第 3 条要求停靠批次恢复时 bundle 超过 100 分钟就在工作区准备前由 companion 重新打 bundle。companion 的 `build-bundle.ps1` 现在每个批次只能建一次（只新建），重新打需要第二代 bundle，而托管转发要到 11 月 Owner 实测才打开，停靠点 A 今天不会走到。所以本步只做保护：工作区准备之前，若离预留（早于 bundle）已超过 100 分钟（`BUNDLE_MAX_AGE_AT_WORKSPACE_MS`），以 `PARKED_BUNDLE_TOO_OLD` 干净结束（clean-final、中性、Linux 上什么都没跑；除非第 R 段转发过角色，否则未发布，换 Source 重装后可再跑，同一 Source 下要推新提交）。
- **打开转发的前提**：上面的保护只在转发关着时代价为零。转发一开，等托管期间暂停、HALT 或执行器忙超过 100 分钟都会烧号；另外第 2 段的 refs 检查对 bundle 之后仓库有任何推送的批次都会失败。所以打开转发之前，必须先做重新打 bundle（或在 10-started 之前释放），见 Task `4012c1b9`。
- 安装授权 `validUntil` 将在一个批次预算内到期时，停在 A 或 B 的批次都以 `PARKED_AUTHORITY_EXPIRING` 中性结束，不 HALT（A 上只跑过第 1 段，未发布；现行策略 `validUntil` 为空，实际不会触发）。

### 18.3 停靠点 B：第 8 段按“尝试”跑（设计 §4.9）

- 第 7 段（或最后一个角色段）之后：两端收尾归档、写 `70-parked.json`（只新建：批次、归档数、本地角色、时间），然后马上跑第一次尝试。
- **一次尝试**：先写 `71-try-NN.json`（只新建），再跑第 8 段；结果：
  - 发布成功：`90-terminal` COMPLETED，与以前相同；
  - 没就绪、零副作用（`BLOCKED`、`sideEffects 0`、`mayHavePublished false`、Windows 静止证明齐全），且码是 `RESIDENT_MERGE_QUEUE_NOT_JOINED` 或 `RESIDENT_QUEUE_HEAD_NOT_REACHED`：写 `72-tried-NN.json`（码、下次时间、在合并队列的位置），批次回到 B；
  - `RESIDENT_BASE_MOVED`（main 尖端已不等于批次的 base；`strict` 开着时这个 head 再也合不进去）、计数的尝试到 `park.stage8MaxTries`、或停在 B 超过 `park.maxMs`：立即以这个码中性结束（FAILED_CLEAN，head 已执行：第 3、5、7 段已发布，要推新提交），从不 attempt 2。`park.maxMs` 不靠尝试：每个 tick 开头，停得超过它的批次不跑任何段，按上次没就绪的码结束（第 8 段重试额度用完时也一样；暂停期间 tick 不走到停靠批次，恢复后的第一个 tick 结束它）。账本每个批次最多记 99 次尝试（`MAX_TRIES`），第 99 次无论答复如何都是最后一次；
  - 其他任何结局（包括写了日志之后的失败）照以前的第 8 段失败处理，不算尝试。
- **可继续**：B 上每个 `71` 都有对应的 `72` 才可继续；有 `71` 没有 `72` 是第 8 段中崩溃的现场，恢复时照旧 FAILED_UNKNOWN 加 HALT。尝试记录有缺号（有第 n+1 次没有第 n 次、有结果没有尝试）是内容不对，整条读不出（UNREADABLE）。
- Owner 中止对 B 上的批次在 tick 开头（P0）生效，中止请求核对的是最新一条尝试记录的哈希；`80-owner-abort`、它的回执和终态都记安全点 `parked`，回填时按“已发布”算。

### 18.4 Source v2：第 8 段一次只查一下

- `publisher.mjs`：`STAGE8_CHECK_MS = 90_000`。一次运行只看第一次观察加窗口内的几次轮询，不再在段里等最长 45 分钟。没就绪时在写任何日志之前零副作用退出，并说明原因（`STAGE8_NOT_READY_REASONS`）：
  - `RESIDENT_BASE_MOVED`：观察到的合并位尖端不等于作业的 base，立即退出（等也没用）；
  - `RESIDENT_MERGE_QUEUE_NOT_JOINED`：调度事实说 claim 根本不在合并队列里；
  - `RESIDENT_QUEUE_HEAD_NOT_REACHED`：在队列里还不是队首，或窗口内没得到有效观察（队列位置未知）。
- 等不出结果的答复立即结束这次运行，不再等到窗口结束（`QUEUE_WAIT_FINAL_REASONS`）：claim 变了或缺失，Native 拒绝，PR 已关闭或 head、base 变了，Native 策略不支持。它们在 `stage-fact.mjs` 里各有终止码（`PR_NOT_OPEN_OR_CHANGED`、`BATCH_CLAIM_CHANGED`、`NATIVE_POLICY_UNSUPPORTED`），都是零副作用的干净终止。claim 不活跃、租约过期或核对超过 30 秒（`full_admission_native_changed`）不算：续租后 claim 的代数不变，还能通过，而终止会烧掉第 3、5、7 段已发布的 head，所以照旧在窗口内等，结束为“还不是队首”；`PR_NOT_OPEN_OR_CHANGED` 还会让排队表做一次实时读。受保护改动因为落后 main 被拒（`protected_change_not_up_to_date`），记为 `RESIDENT_BASE_MOVED`。
- `startup.mjs` 把 `checkMs` 传给 `queueWindow`；`stage-fact.mjs` 把两个新码列进干净终止码，常驻层 `classify.mjs` 照抄（有测试保持一致）。

### 18.5 退避、名额与额度（设计 §4.7、§4.9）

- **退避**：第 n 次没就绪之后等 10 → 20 → 40 → 80 → 120 分钟（之后每 120 分钟）。上次尝试时 claim 已是合并队列第 1 位：1 分钟后再试（`PARK_HEAD_RETRY_MS`）；连续在第 1 位的尝试最多这样持续 15 分钟（`PARK_HEAD_STREAK_MS`），之后回到退避。在第 1 位的尝试不计入 `park.stage8MaxTries`（否则还没轮到队首就用完次数、白白烧号），但计入每天的第 8 段重试额度和账本的 99 次上限。退避按计入的尝试次数算，所以一段第 1 位的连续尝试之后，下一次是 10 分钟后，不是 2 小时后。代价：claim 一直停在第 1 位却总不成为队首时，这个批次大约每 10 分钟试一次，约 14 小时后到 99 次结束，最多用掉一天 100 次重试额度里的 98 次，别的停靠批次就要等额度的滚动窗口（可能到 `park.maxMs` 才结束）。第 1 位停这么久本身就不正常，状态页和通知会显示额度用完。
- **提示**：poller 的触发（带 `prUpdatedAt`）带着这个停靠批次还没因它提示过的 main 尖端（main 移动了），或是该批次自己的 PR 的新触发（作者入队后又改了 PR，重读已经见过的触发不算），就让那个批次的下一次尝试马上到期；每个批次最多每 5 分钟一次（`PARK_NUDGE_MS`），每个 main 尖端只提示一次。Agent 自己写的触发可以带任何 base，不用来提示。提示只会提前尝试，从不结束什么；结论只来自尝试本身读到的 main 和队列。
- **名额**：停在 A 的、以及停在 B 且上次尝试时在合并队列前 2 位的批次，合计最多 `park.maxParked`（4）个；B 上不在前 2 位的另有上限 `park.maxParkedOutsideTop2`（8）。任一个满了就不开新批次（含 attempt 2），状态 `DEFERRED PARKING_FULL`，只挡开新批次，停靠批次照常尝试（否则新批次跑完整个独占区，在第一次尝试就以 `PARKED_OVER_CAPACITY` 结束、白白烧号）。前 2 位之外的上限设为 0 时什么都不挡：那里不停靠，某次尝试后不在前 2 位的批次以 `PARKED_OVER_CAPACITY` 中性结束。main 每次移动都会让停靠批次在下一次尝试以 `RESIDENT_BASE_MOVED` 结束，所以名额一般很快空出来。
- **熔断半开时**：有批次停在 A（等托管）就不开试跑批次，一次只有一个试跑。
- **额度**：一个批次只在开始时计一次执行（72）；第 8 段的再次尝试不算执行也不算评估，单独计数：所有停靠批次的第 2 次及以后的尝试，24 小时合计不超过 `park.stage8RetriesPer24h`（100），从账本的 `71` 记录数（`ledger.usage().stage8Retries`）。用完时当天不再尝试，状态页和 Windows 通知各说一次。
- 调度顺序（设计 §4.3）：崩溃恢复、Owner 请求、HALT、暂停照旧最前；然后停在 A 的批次各判断一次、到期的 B 跑一次尝试（每个 tick 最多一次）；然后 attempt 2、等待重试、其余按到达序号。

### 18.6 Owner 排空与重装（设计 §4.9 末条）

- 卸载脚本照旧拒绝有未结束批次的状态（`UNINSTALL_REQUIRES_NO_OPEN_BATCH_REARM_FIRST`）。停靠批次是未结束的，所以重装前要先排空：
  ```
  node tools\rearm-tool.mjs request-drain --root <root> --reason <text> --by <Owner SID>
  ```
  写进 Owner 请求目录（只有 Owner 会话能写），服务在下一个 tick 开头把每个停在 A 或 B 的批次按 Owner 中止的路径逐个结束（各自写 `80-owner-abort`，指向这个请求），`OWNER_ABORTED`，安全点 `waiting` 或 `parked`。
- 排空和 Owner 中止有同样的保护：本 tick 的崩溃恢复成功、已安装的字节没有漂移、没有别的批次未归档的现场（Owner 中止的归档在两端都是全范围的，会把别人的现场一起移走）。有现场时先复位（复位会归档它），再排空。排空遇到第一个不是干净 `OWNER_ABORTED` 的结局就停下。请求写下后超过 1 小时才被读到就拒绝（`OWNER_DRAIN_REQUEST_STALE`）：Owner 决定的是当时停着的那些批次。中途停下时，回执照常写出已结束的批次、剩下几个和停下的原因（`remaining`、`stoppedBy`）。后面的条目已接受中止、却在结束途中失败时也一样，回执另写出这个条目（`unconfirmed`）。这个条目可能还开着，也可能已经结束、只是没写完收尾，`remaining` 把它算在剩下里。本 tick 一定以 HALT 停住：要么是结束途中先写下的失败码，要么是 Owner 请求之后那道检查的 `OWNER_ABORT_UNCONFIRMED`。
- **漂移时**：停靠批次的每一种结束（按时间、授权将到期、被新提交取代）在动归档工具之前都先核对已安装的字节；漂移就 `FAILED_UNKNOWN RESIDENT_SOURCE_DRIFT` 加 HALT，不归档。排空在漂移时也拒绝。所以因为字节漂移而要重装时：先把已安装的文件按安装清单恢复（漂移消失），Owner 复位，再排空，然后重装。另一条路是等停靠批次在下一次尝试时各自 HALT 结束（结束后不再算未结束的批次），但每次 HALT 都要 Owner 复位，而复位会跑归档工具、不核对漂移，所以只有第一条路能保证“绝不用漂移的字节归档”。
- 代价：B 上的批次 head 已发布，排空后要推新提交；A 上的未发布，重装后可再跑。所以重装尽量选没有 B 上批次的时候。
- 本步的重装本身不受影响：现在装的是第一期，没有停靠批次（转发关着，A 也走不到）。

### 18.7 熔断

- 停到 B 时，熔断按“第 1–7 段都通过”记一个事件（到过 Linux 就不是“只碰 Windows”）。
- 之后每次尝试、以及在 B 上的结束（包括按时间结束、被新提交取代），都是只碰 Windows 的第 8 段事件：不能关闭 Linux 位置引起的熔断；没就绪是中性的。
- 停到 B 时给熔断的这一个事件只是视图：写不成（例如回执写失败）也不改变已经停好的批次。

### 18.8 排队表、状态与 PR 页面（设计 §4.10）

- 排队表的行多了 `PARKED`：批次停在 B，`running` 保留。状态视图给出下次尝试的时间和合并队列位置。
- **停在 B 时 PR 有了新提交**：B 本身就是安全点。每个 tick 开头，排队表里有更新提交的停靠批次做一次实时读（同 17.4，每个批次对每个最新提交最多每 10 分钟一次）：确认 PR 的 head 已变（或 PR 已关闭）就以 `SUPERSEDED_AT_SAFE_POINT` 结束（自我结束记录、两端静止证明、只改名的归档、烧号；终态记 `stage 8`，回填按“已发布”算），新提交接着排；实时读还是停靠的 head 就留在 B，行照旧是 `PARKED`；没有答复也留在 B。新提交不必等停靠批次的尝试用完。
- PR 页面（`resident-queue (info only)`）：
  - 没入队：“已测通：现在加入合并队列，<时间>再查第 8 段”；
  - 已入队：“已测通，在合并队列第 N 位：等成为队首，<时间>再查第 8 段”；
  - 不知道位置：“已测通：等合并队列，<时间>再查第 8 段”（不说已在队列里）；
  - main 移动后结束：“main 已移动：请合入最新 main 并推新提交”；
  - 停靠名额满时排队的行：“排队第 N 位：停靠的批次已满，等它们结束”（不给按空闲执行器估的开始时间）。名额满不满每个 tick 都写进状态（`queue.parkingFull`），不只在推迟新批次的那个 tick；HALT、暂停或回填中的 tick 不更新它，那时 PR 页面先显示停机、暂停或回填的文字。
- 停靠中的 PR 有了还没测的新提交时，新提交在状态里显示为跑着的批次后面的提交，不显示“已测通”。
- 执行器状态多了 `PARKED`；通知多了“今日第 8 段重试额度已用完”。

### 18.9 policy 合同 `/5`

- 新增 `stage8 { mode: 'park' }`（设计的备选 `grace15` 没有实现，Owner 选的是 park）和 `park { maxParked 4, maxParkedOutsideTop2 8, maxMs 24 小时, stage8MaxTries 12, stage8RetriesPer24h 100 }`。其余与 `/4` 相同。

### 18.10 与设计的差异

- `grace15` 没有实现（Owner 已选 park）。
- 停靠点 A 的重新打 bundle 改为 `PARKED_BUNDLE_TOO_OLD` 保护（18.2）；它是打开转发的前提，Task `4012c1b9`。
- 状态页只显示最后一个判断过的 A 批次为“运行中”（只在转发打开时会有几个 A 批次）；随打开转发一起改。
- “车头是停靠点 B 上的批次”时立即跑第 8 段：非列车模式下由“上次在第 1 位就 1 分钟后再试”和提示实现；列车模式的第 10 段是第 3 步。

### 18.11 测试

- **常驻层**：Node 282 项全部通过（含第 1 步与 F2 #905）。新增 `test/park.test.mjs`（27 项）：排空在后面的条目结束途中失败时的回执与 HALT、A 上授权将到期时漂移也 HALT、交替的 main 尖端各只提示一次，第 99 次尝试结束、漂移时各种结束都 HALT 不归档、名额满写进每个状态、第 1 位连续尝试后的退避、排空中途停下的回执，排空的保护（别的现场、漂移、恢复失败、过期请求）与 A 上的排空、B 上取代不关熔断、中止记 `parked`、PR 页面文字、按时间结束、第 1 位的尝试、提示、前 2 位之外满了不开新批次、半开时 A 上有批次不试跑、熔断记录失败不影响停靠，以及停在 B 时有新提交（实时读确认就结束、否认就留下），收尾归档在第 8 段之前、10/20 分钟退避后跑完、第 1 位 1 分钟后再试、main 移动立即结束且不 attempt 2、次数与时间上限、写了之后的结局不算尝试（UNKNOWN 照旧 HALT）、尝试中崩溃是现场而静止时重启可继续、Owner 中止与排空、名额（`PARKING_FULL`、`PARKED_OVER_CAPACITY`）、提示与第 8 段额度、授权将到期、熔断只碰 Windows、停靠点 A 的 bundle 太旧。原有测试按新行为更新（等托管期间暂停 80 分钟，仍在 bundle 的 100 分钟内）。
- **离线演练**：50 步，新增停在 B 时别的 PR 照常跑、第 1 位 1 分钟后再试并跑完、main 移动后结束、Owner 排空后没有未结束批次（之后的重装演练照常）。
- **Source v2**：185 项（184 通过、1 跳过）：第 8 段的三个没就绪码，等不出结果的答复立即结束，落后 main 的受保护改动记为 main 已移动。
- Python 25 项、`windows/test-resident-windows.ps1`、`windows/test-install-carry.ps1` 照常通过。

### 18.12 独立复核与修正

独立复核结论 ACCEPT-WITH-FIXES：0 个 BLOCKER（复核专门试了已发布的 head 被重跑或释放、漏掉的 HALT、两个独占区重叠、崩溃后从半个现场恢复，都不会发生），3 个 MAJOR、14 个 MINOR、4 条 NIT。修正如下：

| 编号 | 问题 | 修正 |
|---|---|---|
| M1 | 排空没有 Owner 中止的保护：HALT 时、有别的批次未归档的现场时、字节漂移时照样归档 | 同样的保护，加 1 小时时效；遇到第一个不干净的结局就停（18.6） |
| M2 | B 上被新提交取代时，熔断按到过 Linux 记，会关掉 Linux 位置引起的熔断 | 记为只碰 Windows（18.7） |
| M3 | 第 8 段把 PR 已关闭或已推送、claim 失效当成可重试的“还不是队首” | 立即以各自的终止码结束（18.4） |
| m1 | A 上授权将到期时仍 HALT | 与 B 一样中性结束（18.2） |
| m2 | B 上的中止在 `80-owner-abort` 里记成 `waiting` | 记 `parked`（18.3） |
| m3 | 停靠 PR 还没测的新提交显示“已测通” | 显示为跑着的批次后面的提交（18.8） |
| m4 | `park.maxMs` 只在尝试时检查 | 每个 tick 开头检查（18.3） |
| m5 | 第 1 位的 1 分钟重试计入 12 次上限 | 不计入，连续最多 15 分钟（18.5） |
| m6 | 受保护改动落后 main 时显示 `BATCH_CLAIM_CHANGED` | 记为 `RESIDENT_BASE_MOVED`（18.4） |
| m7 | 每个触发都会提示，包括重读的 | 只在 main 新尖端或该 PR 的新触发时提示（18.5） |
| m8 | 停靠名额满时 PR 页面没有说明，还在估开始时间 | 新文字，不估时间（18.8） |
| m9 | 前 2 位之外满了仍开新批次，跑完再以 `PARKED_OVER_CAPACITY` 烧号 | 不开新批次（上限为 0 时除外）（18.5） |
| m10 | 排空请求没有时效 | 超过 1 小时拒绝（18.6） |
| m11 | 熔断半开时，A 上的试跑批次还没结束就能开第二个试跑 | A 上有批次时不试跑（18.5） |
| m12 | 停到 B 时写熔断失败会把停好的批次变成 FAILED_UNKNOWN | 只是视图，失败不影响（18.7） |
| m13 | 不知道位置时说“在合并队列中” | 说“等合并队列”（18.8） |
| m14 | `PARKED_BUNDLE_TOO_OLD` 代替重新打 bundle | 复核认为现在安全可接受；列为打开转发的前提（18.2，Task `4012c1b9`） |
| N1–N4 | 注释里的命令名；`PARKED_BUNDLE_TOO_OLD` 的说明在转发过角色时不对；读不出的尝试记录按评估计；A 批次的状态显示 | 前两条已改；N3 影响可忽略（下一次恢复就隔离该条目）；N4 随打开转发改（18.10） |

确认性复核结论 ACCEPT-WITH-FIXES：0 个 BLOCKER、0 个 MAJOR。M1–M3 与大部分 MINOR 确认已修，m7、m8 修了一部分；新提出 3 个 MINOR 和 5 条 NIT。修正如下：

| 编号 | 问题 | 修正 |
|---|---|---|
| m15 | 第 1 位的尝试不计次数后，第 100 次尝试会撞上账本的 99 次上限而 HALT | 第 99 次就是最后一次（18.3） |
| m16 | 按时间结束、授权将到期、B 上被取代这几种结束不核对字节漂移就归档 | 先核对，漂移就 UNKNOWN 加 HALT（18.6） |
| m17 | claim 不活跃或核对过期也被当成终止，会烧掉已发布的 head | 照旧在窗口内等（18.4） |
| m7（续） | 任何触发的 base 都会提示，两个交替的旧 base 每 5 分钟提示一次 | 只用 poller 的触发，每个 main 尖端提示一次（18.5） |
| m8（续） | “停靠已满”的文字只在推迟新批次的那个 tick 出现 | 每个 tick 写进状态（18.8） |
| N5 | 因漂移重装时排空和卸载都拒绝 | 写明出路（18.6） |
| N6 | 第 1 位连续尝试之后下一次在 2 小时后 | 按计入的次数退避（18.5） |
| N7 | GitHub 已更新 PR 的 base 时显示 `PR_NOT_OPEN_OR_CHANGED` 而不是“main 已移动” | 只是文字，未改：两种情况都要推新提交 |
| N8 | 新的几种结束在归档前不写只新建的意图记录 | 未改：中途崩溃只会重复同一个结束（复核确认无害） |
| N9 | 排空中途停下记成“请求被拒” | 照常写出已结束的批次和剩下几个（18.6） |

最后一次核对（`331d0b22` → `360068bc`）结论 ACCEPT：上面各项都按要求修好，或做了有记录的安全选择；没有新的 BLOCKER、MAJOR、MINOR，只有 6 条 NIT：两处缺测试（A 上授权将到期时的漂移检查、按 main 尖端去重的提示）已补；状态里 `parkingFull` 在 HALT、暂停时不更新、第 1 位长时间不成为队首时的额度消耗、漂移时第二条出路的代价，都已写进上文；排空在后面的条目上 `unknown()` 或 Owner 中止本身失败时仍记成“请求被拒”：已改为照常写出已结束的批次，并写出停下的条目（`unconfirmed`，18.6），有测试。这一处的独立复核 ACCEPT-WITH-FIXES（0 BLOCKER、0 MAJOR）：唯一的 MINOR 是本 tick 以哪个码 HALT 的说法，已改；余下 4 条 NIT 未改：后面条目上的读取失败仍记“请求被拒”、`remaining` 含未确认的条目、第一个条目接受后失败时与单条中止的回执说法不一致，这三条只影响回执；第四条是原有的：同一 tick 里再读到一个排空或中止请求时，它的全范围归档可能顺带移走那个已接受、未结束条目的现场（要 Owner 在同一 tick 写两个请求，未实测）。

## 19. 额度第二期·第 3a 步：第 8 段加固与绿色台账（v1.2，Task `6451a55d`）

设计 v0.5 的第 3 步（列车深度 1 代码，`train.enabled=off`）按 Owner Decision `0bb98194` 拆成三个 PR：3a 第 8 段加固与绿色台账（本节）；3b 作业合同 `/3` 与按试合并提交 S 测试；3c 第 10 段与常驻层列车调度。本节只改 Source v2 的第 8 段和常驻层的失败码，列车一直是关的（Source 里固定为 `off`，3c 才接策略）。

### 19.1 第 8 段写之前多核对两件事（设计 §5.3 第 3、5 条）

在批次认领成为合并队列队首之后、写任何日志之前，第 8 段现读两样 GitHub 事实（`independent-control-checks-v2/train-rules.mjs`）。

- **main 的规则**：`GET /repos/{repo}/rules/branches/main`（Metadata 读权限，安装令牌本来就有）。
  - 读不到、没有 `required_status_checks` 规则（规则集被停用）、六项必需检查里有一项缺失或不再钉 integration 5368905（灾备切换），都是 `RULESET_UNREADABLE`。在本次运行的 90 秒窗口内反复读，读不到就停靠重试。
  - 多个规则集按最严的算：任一条要求 `strict` 就算开；合并方式取所有 `pull_request` 规则都允许的交集。读不出合并方式的 `pull_request` 规则按“未知”算（不算只有 merge），不因此判规则读不到：合并方式只对列车有用（复核 N6）。
  - `strict` 关着而本节点不在列车模式：`STRICT_OFF_WITHOUT_TRAIN`，立即停靠，并通知 Owner（每天一次）。
  - 列车模式下 `strict` 关着而合并方式不只有 merge：`MERGE_METHODS_NOT_MERGE_ONLY`（3a 用不到，写好供第 5 步起用）。
- **GitHub 的试合并**：`pull.merge_commit_sha` 指向的提交必须恰好两个父提交 [T, H]（T 是批次测过的 main 尖端，H 是 PR head），树等于测过的树。
  - 关车时测过的树就是 H 自己的树：H 含 T，试合并不改变内容（3b 起列车模式下才是 S 的树）。
  - 还在算（`mergeable` 为空）、不可合并、还没有试合并、父提交还是旧的（GitHub 刚看到 main 或 head 变化，还没重算）：`TRAIN_TEST_MERGE_NOT_READY`，在窗口内反复读，然后停靠重试。
  - 父提交对、树不同：`TRAIN_TEST_MERGE_TREE_DIFFERS`，立即结束（这个 head 的第 3、5、7 段已发布，要推新提交），通知 Owner（每个 head 一次）。
  - 只按父提交和树比较，不按 SHA：GitHub 重新生成 `refs/pull/<n>/merge` 时 SHA 会变，父提交和树不变（设计审核 n-m5）。
  - 任何一次读取失败都按没就绪处理，不当成段失败：这些事实会自己变，执行器再试即可。

两件事都成立才继续：照旧先发 `kooyumi-admission-verified`，再发 `kooyumi-merge-slot`。

### 19.2 绿色台账（设计 §5.4 第 4 条）

- 每一次 `kooyumi-merge-slot` 成功都记进只新建的台账 `state\v2\green-ledger\`（`green-ledger.mjs`；`acl-model.json` 新增这个目录，只有 clued-control 能写）。
- 记录按（提交、check run id、阶段）分文件：`intent`（写之前，必须记上）、`posted`、`settled`、`merged`、`revoked`。文件名带时间、作用键、阶段和随机数，先写临时文件、同步，再用硬链接放到正式名字下并删掉临时文件：链接不会覆盖已有文件，改名在 Windows 上会（复核 N2）。崩溃不会留下半条记录。列出时，文件名里的时间、作用键和阶段必须和内容一致，否则报出。
- `intent` 在这一对检查的任何一个写出之前就记：记不上就什么都不写（`GREEN_LEDGER_UNAVAILABLE`，停靠重试）。所以发布结果不确定的绿也在台账里。之后几个阶段是事后补记，崩溃时可能缺，日志和 `intent` 仍然指得出那条检查。
- 台账打不开（例如 ACL 迁移漏了这个目录）也是 `GREEN_LEDGER_UNAVAILABLE`，停靠，不会把 head 烧掉（复核 M2）。只有写绿时才要求台账；只读的合并门消费者不需要它（复核 M1）。
- 3a 只记录。3c 的第 10 段读它，在发新绿之前撤销所有旧绿（设计 §5.4）。台账随安装带入，但正确性不依赖带入：3c 每次安装后都做一次全量清扫。

### 19.3 写之后（设计 §5.3 第 7 条）

- **PR 已被合入**：auto-merge 在 `kooyumi-merge-slot` 变绿几秒内就会合入，第 8 段写之后的核对会因为 PR 不再打开而失败。以前这被当成“授权变了”，把刚发的绿撤成失败。现在先问 GitHub：PR 已合入，合并提交恰好是 [T, H]、树等于测过的树，就算成功（`SETTLED`，`settledMerged`，日志记下合并提交），不撤销，台账记 `merged`。合并提交不对（不同的父提交或树，或者 squash、rebase 合入），照旧撤销。不论是写后核对先看到合入，还是 GitHub 的回答先看到，结果都一样（复核 M3）。已经记为成功之后，日志写失败也不会把它改成撤销（复核 N3）。
- **PR 还开着**：写之后再看一次试合并。确定变成了别的父提交或别的树，撤销（`TRAIN_TEST_MERGE_CHANGED_AFTER_WRITE`）；读不到或还在算，不据此撤销，照旧由 Native 的写后核对决定。规则集写之后不再读：它管的是“发不发新绿”，写之后一次读取失败不值得撤销一个有效的绿。

### 19.4 常驻层

- 新码进了 `classify.mjs` 的干净终止码表和失败对照表，与 Source 的 `stage-fact.mjs` 一致（测试交叉核对）。`RULESET_UNREADABLE`、`STRICT_OFF_WITHOUT_TRAIN`、`MERGE_METHODS_NOT_MERGE_ONLY`、`TRAIN_TEST_MERGE_NOT_READY`、`GREEN_LEDGER_UNAVAILABLE` 是第 8 段没就绪的码，批次停在 B，按第 2 步的退避再试；`TRAIN_TEST_MERGE_TREE_DIFFERS` 是干净终止，中性，不做 attempt 2。
- 新的通知种类 `stage8-rules`：`STRICT_OFF_WITHOUT_TRAIN`、`MERGE_METHODS_NOT_MERGE_ONLY`（每天一次）和 `TRAIN_TEST_MERGE_TREE_DIFFERS`（每个 head 一次）弹 Windows 通知给 Owner。
- PR 页面：停靠行写明原因（“已测通：main 的 strict 已关而列车未开，暂不发合并位（已通知 Owner）”“已测通：等 GitHub 算好试合并”等）；树不同的结束写“试合并与测过的树不同，未发合并位：请推新提交（已通知 Owner）”。

### 19.5 为什么装上是安全的

- 只会更严：多出来的核对都在写之前、零副作用；今天的规则集（`strict` 开、六项钉 5368905）和今天的 PR（head 含 main 尖端）下，它们都成立，第 8 段照常发绿。
- 写之后已合入不再撤销，是把一个错误的撤销改掉；合并提交不对时照旧撤销。
- 台账写不进就不发绿，最坏是停靠重试，不会多发绿。
- 改了 Source v2（第 8 段、GitHub 端口、布局、ACL 模型），所以要两侧重装（Linux root 加 Owner 的 UAC）。

### 19.6 测试

- **Source v2**：195 项（194 通过、1 跳过）。
  - `test/train-rules.test.mjs`（5 项）：规则集的各种情况（停用、缺项、钉错、聚合、合并方式交集、格式不对）、不同模式下的判断、试合并的判断（还在算、不可合并、父提交顺序与新旧、树不同、重新生成的 SHA）、已合入的判断、绿色台账（只新建、先 intent、列出、撕裂文件与外来文件报出）、GitHub 端口的规则读取。
  - `test/resident-v2-publishers.test.mjs` 新增 5 项：规则集挡住发绿、试合并、台账先于写（没有台账或台账打不开都不发绿）、写之后已合入算成功（合并提交不对、squash、回读失败照旧撤销，不论哪次读取先看到合入）、写之后试合并确定变了就撤销，读不到或还在算不撤销。
- **常驻层**：Node 286 项全部通过（`park.test.mjs` 新增 4 项：发布者、阶段事实和执行器三份第 8 段码表一致，新码停靠并通知，树不同中性结束，PR 页面与通知文字）。离线演练 51 步（新增“strict 关着、列车未开：停靠并通知，strict 开回后跑完”）。
- Python、`windows/test-resident-windows.ps1`、`windows/test-install-carry.ps1` 照常通过。

### 19.7 独立复核

独立复核（只读，对 head 8b941833，在 `git archive` 副本上跑测试和变异）：ACCEPT-WITH-FIXES，0 BLOCKER、0 MAJOR、4 MINOR、6 NIT。

- 八个问题都答“是”：今天装上只会更严、GitHub 回答的形状对、写后已合入在真实流程里走得到、令牌的 Metadata 读权限是隐含的、台账可靠、常驻层停靠与通知正确、测试覆盖到位、3a 范围没有缺项。23 个变异被测试抓到，2 个漏网（S1、S2），已补测试。
- 已改：M1、M2（台账只在写绿时要求，打不开就停靠）、M3（squash 等错误方式合入，两条路径都撤销）、M4（补两项测试）、N1（三份码表交叉核对）、N2（硬链接，名字与内容一致）、N3（成功之后的日志失败不再撤销）、N6（合并方式读不出按未知算）。
- 不在本 PR 改：
  - N4：第一次用 App 令牌读 `rules/branches` 会发生在第一次真实的第 8 段。重装核验加一次现读，`403` 在批次跑之前就能看到。
  - N5：检查说明里写出车头、main@T、S 与它的树（设计 §5.3 第 6 条）放到 3c，和第 10 段一起做。
  - N2 的台账清理：3c 的第 10 段负责。

## 20. 主备 C6：暂停接新（Task `6444f88a`）

来源：《常驻执行器主备部署·设计说明 v0.4》§5.4 第 1 步、§9 C6（Owner 接受：Decision `bd86149e`）。同时关闭审核遗留 N3 里本 Task 负责的部分（status.json 的“排空”字段），以及 N1 里 C6 负责的续期办法。代码在 `src/intake-pause.mjs`，测试在 `test/intake-pause.test.mjs`。

### 20.1 是什么，不打断什么

- **暂停接新**：只要有一个持有者的暂停在生效，执行器就不从排队表开任何新批次。排队的行、到期的 attempt 2、等待重试的行都不开。
- **不打断**：
  - 正在跑的批次照常跑完；
  - 停在 A 的批次每个 tick 照常判断（状态的 `current` 照常显示它），停在 B 的照常按时尝试第 8 段；
  - 被新提交取代、Owner 中止、排空照常结束停靠批次；
  - 触发照常读进排队表，不丢；停靠批次照常看到 main 移动和本 PR 的新提交。
- 设计原文叫“排空请求”。第二期第 2 步已经有一个“排空”（§18.6，结束停靠批次），为免混淆，实现和文档里都叫“暂停接新”（intake pause）。

### 20.2 和暂停、排空、Owner 中止的区别

| | 暂停接新（本节） | 暂停（PAUSE） | 排空（§18.6） | Owner 中止（§6.5） |
|---|---|---|---|---|
| 作用 | 不开新批次 | 批次之间一切停下，停靠批次也不动 | 一次性结束所有停靠批次 | 结束一个批次 |
| 谁能写 | 任何 Owner 会话进程（`requests\`，不提权） | 任何 Owner 会话进程（`requests\`） | 提权的 Owner（`owner\`） | 提权的 Owner（`owner\`） |
| 怎么结束 | 到时自动失效（最长 2 小时）；或同一持有者的恢复请求 | 只有提权 Owner 的恢复请求 | — | — |

四者可以同时生效，各按各的规则。暂停更强：暂停期间 tick 停在暂停那一步；Owner 恢复暂停后，暂停接新如果还没到时，照常生效。暂停接新的恢复请求不能恢复暂停。

### 20.3 请求

```
node tools\rearm-tool.mjs request-intake-pause  --root <root> --reason <text> [--minutes 1-120] [--holder owner]
node tools\rearm-tool.mjs request-intake-resume --root <root> --reason <text> [--holder owner]
```

- 写进 `requests\`（和暂停一样，任何 Owner 会话进程都能写，不需要 UAC）。合同：
  - `clued.independent-ci.resident-intake-pause/1`：`holder`、`minutes`（1–120 的整数）、`reason`、`requestedAt`、`nonce`；
  - `clued.independent-ci.resident-intake-resume/1`：`holder`、`reason`、`requestedAt`、`nonce`；
  - 字段严格，多一个少一个都拒绝。
- **时限**：结束时间 = min(`requestedAt` + 分钟数, 执行器当前时间 + 2 小时)。
  - 读到时已过结束时间（例如 HALT 期间写的请求，复位后才读到），拒绝 `INTAKE_PAUSE_REQUEST_EXPIRED`；
  - `requestedAt` 比执行器时钟超前 5 分钟以上，拒绝 `INTAKE_REQUEST_CLOCK_SKEW`；
  - 到时自动失效，不需要任何人操作，写回执 `intake-pause-ended`。HALT 和暂停期间也照样按时失效；
  - 系统时钟往回跳时，结束时间按“现在 + 2 小时”封顶并写回，暂停不会超过 2 小时。代价：时钟追上之前，同一持有者新写的请求时间比已记下的更早，会被拒 `INTAKE_REQUEST_SUPERSEDED`（Owner 不能提前恢复，C5 也续不了期）。影响以 2 小时为限。
- **持有者**（小写字母开头，最多 32 个字符；`unconfirmed` 保留不用）：
  - 每个持有者只认它最新的一句话（按 `requestedAt`）。比它已有的更早的请求（乱序或重放的文件）拒绝 `INTAKE_REQUEST_SUPERSEDED`；
  - 续期：同一持有者再写一份暂停请求，结束时间重新算，开始时间不变；
  - 恢复请求只结束这个持有者自己的暂停，不动别的持有者；从没出现过的持有者的恢复请求不留记录，不占位置；
  - 任何一个持有者的暂停在生效，暂停接新就生效；
  - 最多记 8 个持有者。新的持有者需要位置时，最旧的已结束记录让位；8 个都还可能在生效时拒绝 `INTAKE_PAUSE_HOLDERS_FULL`（那时本来就在暂停）。结束的记录在它最后一句话 2 小时后丢弃（那时再旧的请求也已过期）。
- 约定的持有者：
  - `owner`（默认）：Owner 手工暂停，例如计划内切换；
  - `dual-active`：C5 的 companion 在双活停机时用。锁住期间定期续写（剩余不足 90 分钟就续，间隔远小于 2 小时）；三种解除情况之一出现时写恢复请求。这样 Owner 的计划内暂停和 companion 的锁互不解除。
- **为什么放在 `requests\`，不放 `owner\`**：它只会让执行器少做事（不开新批次），最长 2 小时。设计 §5.4 要的就是“任何 Owner 会话进程都能写”。
- **谁能提前恢复**：同样是任何 Owner 会话进程，写上持有者的名字就行。这是有意的，理由如下：
  - 提前恢复只是回到平常的服务。真正挡住重复发布的是服务端的 ci-admission 角色（停车位、Z1）和 C4 的 GitHub 回读，它们都不受影响；
  - Owner 账号下的 Agent 本来就能伪造 PR 页面状态（例如对方的“已交班”）来解除 C5 的双活锁。设计 §5.2 已接受这类伪造的后果只是可用性。提前恢复没有给它更多能力；
  - 急停仍然是暂停（PAUSE），只有提权的 Owner 能恢复。
  - 所以 §3.2 里“`requests\` 只能停”的说法要补一句：暂停接新可以由同一持有者提前结束（见本节）。

### 20.4 状态、回执与显示

- **状态文件**：`state\INTAKE-PAUSE.json`，服务自己的状态（只有常驻服务能改），整体替换（临时文件、刷盘、改名）。
  - 格式不对时：先把原文件只新建地复制一份保留（`INTAKE-PAUSE.unreadable-<时间>-<随机>.json`），再整体替换成持有者 `unreadable` 的 2 小时暂停，写回执 `intake-pause-unreadable`。失败时偏安全，又有上限：替换写成之前崩溃，下次还会读到坏文件，照样暂停。Owner 看过保留的副本后，可以用 `--holder unreadable` 的恢复请求提前结束。
  - 读写出 I/O 错误时，进入一段“不确定”：
    - 期间不开新批次（`DEFERRED` / `INTAKE_PAUSE_UNCONFIRMED`）；
    - status.json 的 `intakePause` 显示持有者 `unconfirmed`，所以 C5 不会把本节点当成当班；
    - 每段只写一次回执 `intake-pause-unconfirmed`；
    - 读错误在下一次读成功时结束，写错误要等下一次写成功才结束（读得出、写不进的状态接不住 Owner 的暂停）。写错误期间每个 tick 把当前状态重写一次当作探测，所以短暂的锁（例如杀毒扫描）一过就结束；
    - 连续 30 分钟还没结束就 HALT（`INTAKE_PAUSE_STATE_UNAVAILABLE`），和回填一直失败时一样。HALT 只在开新批次前那道闸门处写下，同一 tick 里不会再跑别的；所以队列为空时不会因此 HALT（不挡任何批次，status 一直显示 `unconfirmed`），一有排队的行，满 30 分钟就 HALT。
  - 写不进状态的请求留在 `requests\`，下个 tick 再读，最多 3 次。3 次都不行就拒绝并写回执（`INTAKE_PAUSE_UNCONFIRMED`），所以积下的请求永远不会把后面的暂停请求挤出每 tick 读的那 16 个（独立审核 M1）。
- **回执**：
  - `intake-paused`（holder、until、renewed、reason、请求摘要）；
  - `intake-resumed`（holder、held）；
  - `intake-request-refused`（失败码）；
  - `intake-pause-ended`（到时失效）；
  - `intake-pause-unreadable`；
  - `intake-pause-unconfirmed`。
  - 状态已经写成、回执却写不进时，请求照样算已处理，不当成拒绝。
- **status.json 合同升到 `/3`**：新增 `intakePause`。
  - 没有生效的暂停时为 `null`；否则是最晚结束时间，以及每个持有者的名字、开始和结束时间。不含理由文字：理由来自用户会话，只进回执；
  - 执行器在有排队的行时停在 `DEFERRED`，原因 `INTAKE_PAUSED`。有批次停在 A 时，tick 的结果仍是 `WAITING`；
  - HALT 和暂停期间这个字段也照样更新；
  - C5 判断“当班”时，`intakePause` 不为 `null` 就不算当班（设计 §5.2 的“排空”）；
  - 执行器和 companion 来自同一份安装，一起升级；旧版 companion 读不了 `/3`，只会通知“读不到状态”。
- **PR 页面**：排队的行写“排队第 N 位：暂停接新中，最晚 hh:mmZ 恢复”。它排在熔断和停靠名额满之前，和执行器的判断顺序一致。停靠和等待的行照旧。
- **`rearm-tool inspect`**：多了 `intakePause`（服务最后写下的状态，只读）。文件读不出时如实写出原因，`inspect` 本身不失败。

### 20.5 计划内切换怎么用（设计 §5.4 第 1 步）

1. 在当班节点写 `request-intake-pause --minutes 120 --reason <切换原因>`。
2. 等 status.json 的 `current` 为空（停在 A 的批次也显示在这里）。停在 B 的批次只会再尝试第 8 段：可以等它们结束；要马上结束就排空（§18.6，它们的 head 已发布，要推新提交）。
3. 再按设计 §5.4 移交角色。切换完成后，旧节点上的暂停到时自动失效，或写 `request-intake-resume` 提前结束。

### 20.6 与设计的差异

- 名称：设计叫“排空请求”，实现叫“暂停接新”（见 20.1）。
- 设计只说“最长 2 小时自动失效”。实现另加了持有者和提前恢复，供 C5 的双活停机续期和解除用（审核遗留 N1）。谁能提前恢复见 20.3。

### 20.7 测试

`test/intake-pause.test.mjs`（22 项）：
- 请求格式；时限与自动失效；过期、超前和乱序的请求；
- 持有者互不解除与续期；持有者上限、让位与恢复请求不占位置；时钟往回跳；
- 状态文件读不出时保留副本并暂停 2 小时；
- 执行器层面：
  - 排队不开、到时恢复；
  - 停在 A 的批次照常判断并留在 `current`；停在 B 的批次照常尝试第 8 段；到期的 attempt 2 等暂停结束；
  - 和暂停、排空同时生效；暂停期间到时失效；
  - 每个持有者只解除自己的；
  - 拒绝的请求写回执并归档；写不进状态的请求 3 次后拒绝，后面的暂停请求照样读到；
  - 一直读不出时显示 `unconfirmed`、只写一次回执、30 分钟后 HALT；短暂写不进在下一次写成功时结束，不 HALT；
- status.json `/3` 与 PR 页面文字；Owner 工具写进 `requests\`、`inspect` 显示；命令行的 `--minutes`。

`test/status.test.mjs` 的键列表加 `intakePause`。

## 21. 额度第二期·第 3b 步：作业合同 `/3`，按测试提交 S 建工作区（v1.2，Task `6451a55d`，子 Task `a3548216`）

Owner Decision `0bb98194` 把设计 v0.5 的第 3 步拆成三个 PR，这是第二个，对应设计 §5.7 和 §5.2“怎么测”。列车仍然是关的：所有批次的测试提交 S 都等于 head H，装上后工作区和今天一模一样。

### 21.1 作业合同 `/3`

- 作业 id = sha256(JSON(["clued.independent-ci.job/3", repo, pr, headSha, baseSha, testSha, sourceManifestSha256, role, attempt]))。`testSha` 就是测试提交 S，紧跟在基础 T 之后。
- 作业多一个字段 `testSha`。`makeJobV2` 不给 `testSha` 时取 `headSha`。现在只有一处会给：批次推导（`derive-batch.mjs`）。
- 模块和导出名保留 V2（指 Source v2），只改合同字符串。
- subject（签名结果、作用键和发布者用的那组字段）不加字段：它的 `id` 已经绑定 S，所以一个 S 的结果不会被当成另一个 S 的结果。这样准入、发布者、桥和中继都不用改。
- 公式有五份副本，一起改：`job-v2.mjs`、`prepare-workspaces.py`、`linux/bin/clued-ci-resident-linux`、`FormalPublicBoundaryV2.cs`、`formal-contract-placement-v2/container-entry.mjs`。复核实测五份逐项相同，Node、Python 和 .NET 三种序列化逐字节一致。测试核对它们相等：Node 对 Python、Linux 工具对 ws-prep、C# 对 Node 推出的批次、容器入口对 `jobIdV2`。
- `/2` 作业一律拒绝。C# 核对同一批的作业时也比较 `testSha`，和 JS 的 `sameBatchV2` 一致。

### 21.2 描述符 `/3` 和工作区

- 批次推导的结果带 `testSha`。常驻层把它抄进公开描述符 `resident-batch-descriptor/3`，并核对它等于 head，所以 S 只由推导决定。
- ws-prep、companion 的打包脚本和 Linux 的归档工具只认 `/3`。ws-prep 和打包脚本要求 `testSha == headSha`（`TEST_COMMIT_NOT_HEAD`）。卸载会把整个 resident 目录连 outbox 一起改名，所以重装之后不会再有 `/2` 描述符要归档。
- trivy 和 contract-placement 的候选工作区检出 S：先核对 S 的树只有普通文件，再检出，再核对 HEAD 是 S，H 和 T 都在库里。gitleaks 照旧扫 H 的提交历史。
- worker（`worker-v2.mjs`）按 `job.testSha` 核对检出，另核对 H 和 T 在库里。
- placement 的密封候选：HEAD 是 S，打包 S、H、T。容器里的构建标签和 `check_contract_placement.py --head` 都用 S，也就是 T..S 的改动。S = H 时和今天相同。

### 21.3 留给 3c 的（S ≠ H，复核 M1 补全）

设计 §6 规定第 4–7 步不再改 Source。S ≠ H 只出现在列车模式的车头批次，下面每一项都要在开车之前装上：

- **S 的来源**：只取自第 10 段的受信实时读取，经阶段事实交给执行器。subject、批次认领记录（`batch-claim-v2.mjs`）和账本 batch key 都带上 S。`makeJobV2` 去掉默认值，所有调用点显式传 S，否则漏传会被默认值藏住（复核 m1）。
- **第 8 段测过的树**：`independent-control-checks-v2/publisher.mjs` 的 `trainFacts` 现在读 H 的树，要改成读 `job.testSha` 的树。这个文件在 3a 之后先给主备 C4 用，所以放在 3c 改。
- **控制消费者**（`consumer.mjs`）：重推作业时读记录里的 S；不能再用受保护脚本传进来的 `pr.base.sha` 去和 T 比较。
- **对 `base.sha` 做等值比较的地方**都要按设计 §5.7 放宽：只要求 PR 打开、head 相同、base 分支是 main，`base.sha` 只记为读到的事实。涉及：
  - `full-admission-v2.mjs` 的 `samePr`；
  - `staged-check-publisher-v2.mjs` 的写前核对；
  - `github.mjs` 的 `exactPr`；
  - 两个发布者对 packet `baseSha` 的检查；
  - `protected-controller-ports-v2/refs.mjs` 的 `samePr`。
  关车时 head 含 main 尖端，保留今天的核对只会更严，所以 3b 不放宽。
- **中继**：`publishHosted` 自己推作业时要带 S；`relay-entry-v2.mjs` 的 subject 和第 R 段推导也要带 S；E8 改为核对 S 的树。
- **打包与 ws-prep**：
  - companion 按 SHA 取 S。bundle 的引用命名空间要和 gitleaks 的“引用等于 bundle”核对一起设计。
  - GitHub 重新生成试合并后，旧的 S 可能取不到。这算批次开始前的暂时原因（设计 §5.2 n-m6，不计释放上限），回到第 10 段重读 S。
  - ws-prep 核对 S 恰好有两个父提交 [T, H]。凡是核对“还是不是那个 S”，都按父提交和树比较，不按 SHA。
- 撤掉三处 S = H 守卫：`engine-windows.mjs` 的推导核对、`prepare-workspaces.py` 的 `TEST_COMMIT_NOT_HEAD`、`build-bundle.ps1` 的 `TEST_COMMIT_NOT_HEAD`，并改掉钉住它们的测试。设计 §5.3 第 4、6、8 条和 §5.4 属于第 10 段，也在 3c。
- **测试**：用 S ≠ H 作固定输入，跑通第 1–8 段的单元路径（准入、桥签发、发布者写前核对、第 8 段、消费者），worker 用 HEAD = S ≠ H 的 git 工作区，并测密封候选的 HEAD 和打包内容。

### 21.4 为什么装上是安全的

- 关车时 S = H：作业 id 变了，工作区、测试输入和签名结果的内容都和今天一样。复核核实，placement 打包的内容和以前逐字节相同。
- 不会重跑：已执行记录和 K(head, role) 按 head 记，不按作业 id。作业 id 本来每次重装都会变，因为身份里有 `sourceManifestSha256`。
- 合同在两侧一起换：Windows 的 Source v2、C# 边界、Linux 的 ws-prep、worker、容器入口和 Linux 常驻工具都在同一次重装里换。没换的一侧会拒绝另一侧的 `/3` 作业，这是失败关闭，不会写出检查。
- 按 Owner Decision `72ed7fb4`，3b 合入后不单独重装，3c 合入后两侧一起装。两侧必须一起装、一起回退：只换一侧时，Linux 归档读不懂另一侧的描述符，执行器 HALT（失败关闭，复核 r2 n2）。重装清单要写明这一条。

### 21.5 测试

- Source v2：201 项（200 通过、1 跳过）。新增 `test/job-v3.test.mjs`，共 6 项：
  - 合同和身份；
  - S 默认等于 H，另一个 S 是另一个作业；
  - 拒绝 `/2` 和坏 S；
  - 容器入口推出同一个 id；
  - 容器用 S 构建并检查 T..S；
  - 打包脚本只认 `/3`，并拒绝 S ≠ H。
- `test/test_prepare_workspaces_v2.py`：Node 和 Python 对 S ≠ H 的 id 一致；拒绝 `/2` 描述符、缺 S、坏 S 和 S ≠ H（`TEST_COMMIT_NOT_HEAD`）。
- 常驻层：
  - `test_linux_privilege.py` 核对 Linux 工具和 ws-prep 的公式一致，拒绝 `/2` 和缺 S；
  - 新增一项归档测试，从 outbox 按真实读取路径读描述符（复核 B1）；
  - 核对先查 S 的树再检出、检出 S、HEAD 核对 S。
  - `engine-v2.test.mjs` 核对描述符是 `/3`、S 来自推导，推导给出别的 S 就拒绝。
- 常驻层 Node 286 项、离线演练 51 步、Python 照常通过。
- C#：`test-pure-v2.ps1` 共 140 项断言，新增几项拒绝：S 改了、合同串改成 `/2`、`/2` 作业。

### 21.6 独立复核

- 第一轮（3177b549）：ACCEPT-WITH-FIXES，1 BLOCKER、1 MAJOR、4 MINOR、5 NIT。
  - B1：Linux 工具新加的合同表和 outbox 路径常量同名，归档会读不到描述符；不修就装，第一个跑 Linux 角色的批次就会 HALT。已修：只认 `/3`，不再要合同表；加了走真实读取路径的测试。
  - M1：3c 清单补全，见 §21.3。
  - m1 写进 3c。m2 已修。m3 补了能现在补的测试，其余写进 3c。m4 已修：理由不成立，`/2` 兼容已去掉。
  - NIT：过时注释已改；C# 合同串单独测；打包脚本的拒绝有测试；S 只由推导决定。
- 第二轮（ef98de49）：ACCEPT，0 BLOCKER、0 MAJOR、1 MINOR、5 NIT。
  - B1 彻底修好，没有引入新问题。上一轮存活的变异里，ws-prep 检出、HEAD 核对、打包脚本的拒绝、构建标签、`--head` 和 C# 合同串，现在都能抓到。
  - 已改：m1（推导结果的 `testSha` 加了跨层断言）、n1（outbox 路径与 `layout.mjs` 的 `LINUX_DESCRIPTORS` 相等）、n2 和 n5（写进 §21.4、§21.3）、n4（过时注释）。
  - n3（打包脚本只有源码断言；C# 同批核对没有测试）留到 3c，和 S ≠ H 的测试一起补。

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
| `src/service-ports.mjs`、`engine-windows.mjs`、`service-main.mjs`、`companion-main.mjs`、`instance-lock.mjs`、`stop-request.mjs` | 真实端口与入口（引擎依赖 Source v2，缺了就 `SOURCE_V2_REQUIRED`） |
| `windows/install-resident.ps1`、`verify-resident.ps1`、`uninstall-resident.ps1`、`rearm-resident.ps1` | 安装、校验、卸载、复位与恢复请求 |
| `windows/ResidentServiceHost.cs`、`SwapBroker.cs` | 两个服务宿主（`HostPureTests.cs`：宿主停止处理的离线测试） |
| `linux/systemd/*.service`、`linux/bin/clued-ci-resident-linux`、`linux/*-resident-linux.sh` | Linux 三个 unit、root 工具、安装、校验、卸载 |
| `tools/rearm-tool.mjs`、`verify-receipts.mjs`、`build-package.mjs` | 查看与请求、回执校验、打包 |
| `config/*.example.json` | 策略与 companion 配置样例 |
| `test/*.test.mjs`、`test/test_linux_tool.py`、`drill/offline-drill.mjs` | 测试与离线演练 |
| `src/attempts.mjs`、`src/retention.mjs` | v0.6：自动 attempt 2 的判定（§7.2）、50 GB 归档提醒（§7.3） |
| `src/hosted-wait.mjs`、`src/hosted-hints.mjs`、`src/gh-read-port.mjs` | v0.7：托管等待与提示解析、companion 的提示模式、gh 只读端口（§7.5） |
| `linux/bin/clued-ci-install-source-v2` | v0.7：Linux 侧 Source v2 安装（§7.6） |
| `CI/src/hosted-relay-v1/relay-entry-v2.mjs`、`relay-plan.mjs`、`CI/src/independent-control-checks-v2/consumer.mjs` | v0.7：第 R 段入口、计划行、v2 控制检查消费者 |
| `CI/src/resident-v2/*`、`CI/src/*-v2.mjs`、`CI/src/formal-work-admission-check-v2/`、`CI/src/independent-control-checks-v2/`、`CI/runtime/one-shot-v2.mjs`、`CI/worker/*-v2|v3|v4/`、`CI/worker/protected-job-bridge-v4/` | v0.6：Source v2 本体（§7.1） |
| `src/failure-table.json`、`src/executed-heads.mjs`、`src/status.mjs`、`src/pr-status.mjs`、`windows/test-install-carry.ps1` | v0.9：失败对照表、与 Source 无关的已执行记录与回填、状态快照、PR 页面状态与通知、安装带入旧账本的离线测试（§16） |
| `CI/src/independent-control-checks-v2/train-rules.mjs`、`green-ledger.mjs` | v1.2：第 8 段的 main 规则与试合并核对、绿色台账（§19） |
| `CI/src/job-v2.mjs`（合同 /3）、`CI/test/job-v3.test.mjs` | v1.2：作业身份加测试提交 S，描述符 /3，工作区检出 S（§21） |
