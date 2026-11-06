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
companion 轮询（每 60 秒，条件请求，§39；用 Owner 的 gh 登录）或 Agent ──▶ inbox 里的触发记录
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
- **companion**：每个子进程都建在作业宿主自己的作业对象里，超时后宿主终止并排空这个作业，companion 接着处理下一个请求（§24）。只有宿主本身还没结束时才 busy，这时不接新请求，也不发心跳。

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
| S8 | 控制助手每 30 秒只读核一次合并队列（第 12 代：观察通过后还会经 CI 命令门入队、延长租约，见 §56.4），窗口 = min(合并位 45 分钟, claim, validUntil, 阶段上限减 7 分钟)，满足就发一对检查，否则 `RESIDENT_QUEUE_HEAD_NOT_REACHED`，什么都不发 | `src/independent-control-checks-v2/` |
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
- Linux 适配器对每轮回调结果自己的复核（`validateFormalAdmissionV2`）也一样：worker 把每个 response 的签出时间和过期时间记在它交给适配器的那份准入事实上（`linux-worker.mjs#callbackValue`、`admission-facts-v2.mjs#noteBridgeResponseTimes`）。在这个 response 有效期内、且不晚于 claim 到期，30 秒从签出时刻算；过了这个时间，或者不是从回调来的事实，照旧从当前时刻算。适配器先校验端口交来的那个对象，再克隆；克隆出的对象不带登记。Windows 侧的调用方从不登记，行为不变。
- 所以 Linux 侧用上一份准入时，它最多比 `observedAt` 晚约 150 秒（签出前 30 秒，加一个回调窗口），以前是 30 秒。
- remote-refs 回调的 refs 快照仍按到达时刻判 30 秒，不在这次决定范围内。gitleaks 的 remote-refs 一轮走的是同样的搬运，变慢时仍会被拒（那一轮在准备之前，所以以干净的 `blocked` 结束，#908 就是这样）。
- companion 每次搬运调用最多等一个回调窗口（`RELAY_TIMEOUT_MS` = 120 秒），不再固定 40 秒。（写本节时 Runner 从不杀子进程，提前放弃并不能腾出 Runner，只会让泵以没用的答复结束；§24 起，到这个时限由作业宿主连同进程树一起结束，§25 再按到达核对裁定。）Owner 中止时，正在进行的那次调用最多多等这么久。
- relay-public.ps1 等 wsl 子进程的上限从 30 秒改为 90 秒。它的 `finally` 本来就会一直等到子进程结束，这个上限只决定一个慢了、但已经做完的子进程算不算成功。以前超过 30 秒就是 `UNCERTAIN_LOCKS_RETAINED_NO_RETRY`，companion 照样报 `RELAY_REFUSED_NO_RETRY`。
- 生效要重装两侧：桥 v4 的文件按字节受理（relay-public.ps1 每次搬运前逐字节核对 manifest），companion 配置里的 `bridgeManifestSha256` 也随之更新。
- 不变：每轮仍重新做完整准入；绑定 nonce、序号与批次 claim 代际；发布阶段（3、5、7、8）自己再做完整准入，已发布的检查不重复、不伪造。
- 仍未处理（后续）：
  - 泵在扫描执行段停下、companion 已给出 Linux 静止证明时，常驻侧要等签发方到期才 UNCERTAIN→HALT，应尽早停下签发方并干净结束。
  - 搬运慢在哪一步仍不知道：relay 的输出（`status`、`failureCode`）没有留下来，下次出事故时无从查起。
  - `windows-issuer.mjs` 里“迟到后再等两个窗口”的说明，假设的是一次 ReceiveBlocked 很快；搬运调用长到接近 120 秒时，这两个窗口可能不够用。

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
   - **传输卡住**（Task `4d3aaa64`）：2026-10-23 PR #916 的批次，fetch 经本地代理拉到 47 MB 后连接卡死。git 没有低速限制，一直等到服务侧 35 分钟期限才以 `BUNDLE_UNAVAILABLE` 失败，同一时间网络正常。现在所有 git 调用都带 `http.lowSpeedLimit=1000`、`http.lowSpeedTime=60`：连续 60 秒低于 1000 字节/秒，git 自己中止。到 companion 的 30 分钟时限时，作业宿主还会连同作业一起结束它（§24）；低速限制让这件事早得多。
   - **重来一次**：三个联网步骤（全部 heads 和 tags 的 fetch、ls-remote、按 SHA 取已审查提交）之一由 git 失败时，整个对象库重建一次（`Fetch-Store`）。第 2 次在新的 bare 库 `fetch-2.git`（只新建）里从头走每一步、每一项核对；第 1 次留下的东西（半截 pack、refs）原样留着，从不再读。限制：只重来一次；只在脚本开始后 10 分钟内失败才重来，第 2 次因此至少还有 20 分钟（整次建 bundle 平时 40–100 秒，见过最长 283 秒；companion 等 30 分钟）；脚本自己的拒绝（main 变了、对象库里缺提交等）和 git 没能启动都不重来（refs 不等只有下一条那一种例外）；不读 stderr，所以会重复的联网失败（凭据、GitHub 上已没有的已审查提交）也会多花一次。回执和失败答复记 `storeAttempts`，以及第 1 次停在哪一段、哪一步（`firstAttempt`）。
   - **fetch 与 ls-remote 之间有人推送**（2026-11-04 06:21Z PR #990：两步之间仓库里任一分支被推送，抓到的 refs 与 ls-remote 不等，抛 `FETCHED_REFS_DIFFER_FROM_LS_REMOTE`，被当成 `BUNDLE_UNAVAILABLE` 计入断路器，PR 要等退避重试）：只对**全部 heads 和 tags 的 fetch 之后紧接着的那一项**「抓到的 refs == ls-remote」不一致重来，`Build-Store` 在那一处记下不一致（`$refsDiffer`：不等的 ref 个数和至多 8 个名字），其余两处同码的核对（取已审查提交 / 取 S 之后）仍是终局。每次重来都是新的 bare 库（`fetch-2.git`、`fetch-3.git`，只新建）从 fetch 重新开始，每一步每一项核对照旧；总共至多 3 次尝试（`$MaxStoreAttempts`，其中联网步骤失败的重来至多 1 次），与上面相同的 10 分钟窗口；3 次都不一致，或其间 main 不再是 base（`REMOTE_MAIN_BASE_CHANGED`）等，答复的仍是原错误码。不放宽任何核对。`storeAttempts` 记尝试次数（1–3），`firstAttempt` 另带 `refsDiffer`（第 1 个被放弃的尝试）。第 6 代审核的观察：之后被放弃的尝试原来不记；现在回执和失败答复多一个 `failedAttempts`（每个被放弃并重来的尝试一项：序号、`reason`、停在哪一段和哪一步、`failedAfterSeconds`，refs 不等时带 `refsDiffer`），读回执的各处只取自己要的键，不受影响；结束这次运行的最后一次失败仍是答复自己的 `reason`。
   - **限速出网**（2026-11-04，第 7 代，PR #992 的打包 08:32–08:43 连续失败两次，随后因放行次数上限停下）：DESK 出网整体限速约 2.5 Mbit/s，实测 120–300 KB/s 且间歇卡顿，仓库约 64 MB。第一次已抓到 58 MB，因卡顿低于 1000 B/s 超过 60 秒被中止，之后每次都从新的 bare 库从零重抓。改动：`http.lowSpeedTime` 由 60 改为 300 秒，`http.lowSpeedLimit` 仍是 1000 B/s（约为最慢速率的 1%，仍是“基本没有进展”）。账：一次完整传输 64 MB ÷ 300 KB/s ≈ 213 秒，÷ 120 KB/s ≈ 533 秒（外加卡顿）；死连接 300 秒后被放弃，所以第 1 次仍在 600 秒窗口内失败，第 2 次有至少 20 分钟（companion 等 30 分钟，`timeoutMs: 30 * 60_000`）。结果：最慢速率下可靠完成 1 次完整传输，2 次要第 1 次在窗口内失败且速度偏快；最快速率下可完成 2 次，第 3 次（`$MaxStoreAttempts`）因 10 分钟窗口基本不会开始。代价：真死的连接现在最多多耗 4 分钟才被放弃（总共不超过约 15 分钟，仍在 30 分钟内）。`CI/test/resident-v2-build-bundle.test.mjs` 钉住 300 秒，并钉住“低速窗口 × 2 ≤ 重试窗口”和“30 分钟 − 重试窗口 ≥ 两倍最慢一次传输”。
   - **不从零重抓（设计；第 2 档“持久种子库”第 8 代已实现，见下；第 1、3 档未做）**：现有设计要求每次尝试用全新的 bare 库，拒绝 alternates、shallow、grafts，是为了让最终的库只含 git 自己从远端收来并校验过的对象。三档，由小到大：
     1. **同批次复用（推荐先做）**：只在上一次尝试已完整跑完全部 heads/tags 的 fetch 之后才失败时（refs 不等、取已审查提交失败、取 S 失败）。新库仍是 `git init --bare`（全新、无 alternates），先 `git fetch <上一次的库的路径>`（本地传输，`-c transfer.fsckObjects=true -c fetch.fsckObjects=true`，每个对象重新哈希，连通性由 fetch 自己检查），写入固定命名空间 `refs/clued-seed/*`，再对 GitHub 做一次 fetch（git 把种子 refs 当 have，只传增量）；两次 fetch 之间和所有核对之前删掉 `refs/clued-seed/*`，所以 ref 集合核对（`Split-Refs` 拒绝陌生 ref）、`FETCHED_REFS_DIFFER_FROM_LS_REMOTE`、`REMOTE_MAIN_BASE_CHANGED`、bundle 头核对一项不少。可信面：对象来自本脚本在同批次目录里新建的库，信任边界与现在相同。收益：race 重试和后段失败不再重传 64 MB；**传输中途失败救不了**：git 不能续传 pack，`tmp_pack_*` 是半截流，不可复用，所以这次 PR #992 的场景（第 58 MB 处卡死）靠 300 秒窗口，不靠这一档。
     2. **持久种子库**（`resident\seed.git`，只由脚本维护）：每次构建都从种子本地 fetch（同上校验），再对远端 fetch 增量，平时只传几 MB；限速下每个批次省 4–9 分钟。种子只在本次构建**全部核对通过且 bundle 头核对通过之后**才用已验证的新库更新（`git fetch` 进种子，持锁，失败不影响结果）；种子损坏或缺失一律退回无种子的现路径，种子只是加速，不是信任来源。取舍：(a) 种子目录与 `resident\bundles` 同一 ACL（Owner 可写、root 经 /mnt/c 读）；能写它的人本来就能改 bundle 和回执，所以不增加新的信任边界，但不得放在用户可写的临时目录；(b) 对象的真伪全靠 SHA-1 内容寻址和 fsckObjects，一个被投毒的种子最多带来“多出来的、不被任何 ref 引用的对象”，`bundle create` 只打包 ref 可达的对象，也不会进 bundle；让 ref 指向一个伪造对象需要 SHA-1 碰撞，与从网络收到的对象同样的暴露面；(c) 远端强推重写历史后，种子留着旧对象，同样不可达、不进 bundle，但会增长，需要在种子上定期 `repack -a -d`（`gc.auto=0` 仍成立，显式触发、持锁）并设大小上限，超过就丢弃重建；(d) 并发的 `-Rebundle` 和下一批次要对种子加互斥锁；(e) 回执没有放种子的位置，是否用过种子不进回执（要记就得加字段，需 Owner 决定）。
     3. **分段 fetch**（不推荐）：用 `--depth` 逐步加深再 `--unshallow`，让每段完成后留在库里；复杂、传输总量更大，中间状态含 shallow 文件（最终核对前必须消失），与现有“拒绝 shallow”的检查冲突，收益被前两档覆盖。
     结论：先做第 1 档（风险最小，覆盖第 6 代 race 重试在限速下每次重传 64 MB 的问题），第 2 档需要 Owner 对种子目录的 ACL 和保留策略做决定后再做。
   - **持久种子库（第 8 代已实现，第 2 档；Task `c59e697c` 的后续，Owner 默认值）**：`build-bundle.ps1` 在 `resident\bundles\_seed\seed.git` 留一份上一次**已验证**批次的对象，下一批只从 GitHub 补增量。
     - **位置与权限**：放在 `bundles\` 之下，继承 `bundles\` 的 ACL（`install-resident.ps1#Get-AclPlan`：常驻服务账户读执行，Owner 修改）。写它的是 companion（Owner 的登录会话，非提权）。常驻服务账户和 Linux root（经 /mnt/c）只读，Linux 一侧从不读种子（ws-prep 只读 `bundles\<批次>`）。**不需要新的 ACL 条目、不需要重装目录**。注意：和 Owner 默认值里“只有常驻服务账户能写”不同，bundles 本来就是 Owner 会话写的；种子与 bundles 同一信任面，不增加新的信任边界（能写它的人本来就能改 bundle 和回执）。`retention.mjs#measureWindows` 会把它算进 bundles 的字节数，磁盘余量提醒照旧。
     - **怎么用（一次“带种子”的尝试）**：仍是一个全新的 bare 库（`init --bare --template=`，没有 alternates，没有 shallow）。先 `git fetch <种子路径> +refs/heads/*:refs/clued-seed/heads/* +refs/tags/*:refs/clued-seed/tags/* +refs/reviewed/*:refs/clued-seed/reviewed/*`（本地 fetch：每个对象由 index-pack 重新哈希，fetch 自己做连通性检查；`protocol.file.allow=always` 只给这一次调用，不进 `$Common`），再对 GitHub 做和以前一模一样的全量 heads/tags fetch——git 把 `refs/clued-seed/*` 当 have，只传种子里没有的对象。之后删掉 `refs\clued-seed`，用 git 核对没有任何 `refs/clued-seed/` 引用留下（包括 packed-refs），再做一次 `rev-list --objects --quiet --branches --tags` 连通性检查，然后**原样**进入 ls-remote 相等、main==base、reviewed 提交按 SHA 取、S 取与父提交核对、bundle 头核对等全部现有检查。bundle 仍只打包 `--branches --tags --glob=refs/reviewed/* --glob=refs/clued-test/*` 可达的对象。回执字段不变（`storeAttempts`、`firstAttempt` 照旧）；脚本的应答多一个 `seed` 对象（used、reason、discarded、primeSeconds、updated、seedBytes、error），companion 不读它。
     - **为什么一个恶意 PR 污染不了后续批次**：(1) 种子只在一次批次**全部检查通过、bundle 与回执写完之后**更新，来源是那次已验证的 bare 库，经本地 fetch（`+refs/heads/*`、`+refs/tags/*`、`+refs/reviewed/*`，`--prune`），从不来自 PR 检出、工作区或任何执行 PR 内容的东西；整个过程没有检出、没有 hooks（`core.hooksPath` 指向不存在的目录，种子本身没有 hooks 目录）。(2) 对象按内容寻址：种子里的对象被本地 fetch 重新哈希，被改动的对象要么哈希对不上名字（缺对象，连通性检查失败，丢种子），要么就是 SHA-1 碰撞，暴露面与从网络收到的对象相同。(3) 种子决定不了任何 ref：新库里的 heads/tags 全部来自 GitHub 的 fetch，随后与同一时刻的 ls-remote 逐项比较；种子的 ref 在比较之前就被整体删除，种子里的“假分支”最多留下一个不可达对象。(4) 不可达对象进不了 bundle（`bundle create` 只打包 ref 可达的对象），Linux 一侧对 bundle 仍做 `fsck --full --strict` 与模式检查。(5) 种子的 config 会被 git 在服务本地 fetch 时读取，所以每次使用前都核对：只允许 `core.repositoryformatversion=0`、`core.bare=true`、`filemode/symlinks/ignorecase/logallrefupdates` 这几个键，出现 `core.fsmonitor`、`uploadpack.packObjectsHook`、`include.path` 等任何别的键就丢弃；同样检查它是真目录（不是 junction/符号链接）、没有 alternates / http-alternates / shallow / grafts / commondir / gitdir / worktrees、没有 hooks 文件。
     - **种子坏了不会让打包失败**：种子只会多出一次尝试，不会多出一次拒绝。带种子的尝试不会是最后一次（`$n -le $MaxStoreAttempts-2`）。种子自己的步骤失败（本地 fetch 失败、形状不对、锁被占用、删引用或连通性检查失败）统一成 `SEED_UNUSABLE`：丢弃种子（锁被占用时不丢），紧接着一次不带种子的尝试，和今天的全新全量 fetch 完全一样；这一次不占网络重试名额。带种子的尝试里 GitHub 步骤的 `GIT_STEP_FAILED`：若时间窗口允许网络重试，重试不带种子（种子保留）。refs 在 fetch 与 ls-remote 之间被推送的竞态重试仍然带种子（出问题的不是种子）。脚本自己的拒绝（`REMOTE_MAIN_BASE_CHANGED` 等）不因种子而重试。种子更新在回执写完之后、`try/catch` 里：任何失败只丢种子，打包结果与退出码不变。
     - **种子命中后，GitHub 上已经没有的已审提交不再让构建失败（审核第 8 代，建议 6；行为，不是放宽）**：已审提交（`[reviewed].commits`，来自 hash 钉死的 gitleaks toml）是按 SHA 取的（`fetch-reviewed`）。不带种子时，GitHub 已经不再提供的提交（被强推掉、被删的分支）使这一步失败，整次构建失败。带种子时，种子在上一次**全部检查通过**的构建里已经装下了这些对象，种子预取把它们（连同连通性）带进本次新库，git 对已完整在本地的对象不再向远端要，于是这一步成功。检查没有少：toml 钉死的已审集合仍要逐个 `cat-file -t` 为 commit、`rev-list --objects` 通过 `refs/reviewed/*`、`EXACT_REVIEWED_REF_SET_REQUIRED` 与 bundle 头里的已审 refs 仍要和期望完全一致；对象内容经 index-pack 重新哈希。**局限：** 这是由 git 的取法得出的行为，离线测试没有单独钉它；而且它让“GitHub 上已没有的已审提交”在种子存在期间不再暴露，种子被丢弃（`SEED_*`、`REMEASURE_DUE` 之后的无种子测量、体积超限）后又会恢复为失败，诊断时要记得这一点。
     - **种子锁与丢弃（审核第 8 代，建议 3）**：种子锁（`seed.lock`）只由拿到它的一方改种子。过期（半小时）锁的接管整个包在 try 里，接管失败（锁被占着打开、删不掉、被别人抢先建出）按“忙”处理，返回 false，不抛异常；`Seed-Discard` 自己拿不到锁（锁在别人手里）就**不删**种子，只把本次的 `seedUse` 关掉并在答复里写 `error=SEED_DISCARD_SKIPPED_LOCK_HELD_BY_ANOTHER`，`discarded` 保持 false；已经持有锁的调用方（`Seed-Update`）直接删。`Seed-Lock`/`Seed-Unlock` 维护 `$seedLockHeld`。
     - **何时用**：仅当上一次**不带种子**的完整 fetch 用了至少 90 秒（`$SeedMinFullFetchSeconds`）才用种子（网络正常时整个 fetch 只要 5–11 秒，而一次带种子的启动要重新哈希整个历史，约 20–40 秒，反而慢）。测量记在 `bundles\_seed\seed-meta.json`（只是建议性的：伪造它只能开关种子，两条路径都是安全的）。测量超过 24 小时就让下一批不带种子跑一次重新测量。种子无论是否使用都会在成功批次后更新，网络变慢时马上可用。
     - **大小与维护**：只留一份；`fetch.unpackLimit=1` 让增量保留为包；包数超过 12 就 `repack -a -d`（同时丢掉不可达对象）；超过 1 GiB 就丢弃并用当次已验证的库重建，不花网络。锁文件 `seed.lock` 只创建、不等待；占用中（或不到 30 分钟）就本次不用/不更新种子，超过 30 分钟视为崩溃遗留并接管。删除一律用 `Remove-Tree`（不跟随链接、先去掉只读属性），不用 `Remove-Item -Recurse`。
     - **预计节省**：限速网络（120–300 KB/s，约 64 MB）一次完整传输 213–533 秒，带种子后变成本地重哈希（估计 20–40 秒）加一次增量 fetch（一个 PR 通常几 MB，约 10–40 秒），每批省约 3–8 分钟（限速下的“第 7 代、PR #992”批次打包加第 1 段共 8.0 分钟，其中打包是大头）。bundle 的第二代（`-Rebundle`，停靠点 A 之后）也用同一个种子。网络正常时不启用，无退化。
     - **测试**：`windows/test-build-bundle.ps1`（107 → 183 例）：门控各分支；无种子时与以前一样；从已验证库建种子（refs 与 `fsck --full --strict`）；带种子的 bundle 与回执同形；种子里放“假分支/假标签/假 reviewed 引用”和只存在于种子的提交：新库 ref 集合仍等于 ls-remote，该提交不在 bundle 里（把 bundle 克隆出来逐个核对）；alternates / shallow / grafts / commondir / hooks / 各种危险 config / 缺 HEAD / `objects` 是 junction（junction 目标内容不受影响）都被丢弃并不带种子完成；种子的包被改坏时，本地 fetch 失败后同一批次用第二次尝试完成；锁被占用、陈旧锁接管、年轻锁不动；GitHub fetch 卡住后重试不带种子；竞态重试带种子、第三次不带；主检查的拒绝仍是终局；种子更新对不存在的库、超过上限、包数过多的处理；整个脚本作为进程跑：首批建种子、变慢的测量下下一批带种子且回执同形。`test/resident-v2-build-bundle.test.mjs` 增 5 个钉住：位置与常量、尝试顺序与 `protocol.file` 不进 `$Common`、没有 alternates/共享对象、种子只会多尝试不会多拒绝、回执不含种子、删除不跟随链接。
     - **安装**：`build-bundle.ps1` 是 Source v2 脚本（companion 配置的 `bundleScript`），生效要随第 8 代的 Source 清单一起重装；没有新的 ACL、服务或 Linux 侧改动。
   - 代价：`--quiet` 时服务器准备 pack 的阶段没有进度输出，只有心跳包。这一段若超过低速窗口（现为 300 秒，见下一条），也会被当成卡住。平常整个 fetch 只要 5–11 秒；真遇上了，就落到上面那一次重来。
   - `-CheckRefs` 的 ls-remote 也带低速限制，但不重来：它失败就是 `REMOTE_REFS_UNAVAILABLE`，由常驻侧照旧分类。
   - 慢但不停（一直略高于 1000 字节/秒）的传输：脚本本身没有总时限，到 companion 的时限由作业宿主连同进程树一起结束；邮箱通道不再停摆，第 0 段失败只关 Windows、不 HALT（§24，Task `8e1f07d3`）。
   - 测试：`windows/test-build-bundle.ps1` 从脚本的语法树取出 `Invoke-Git`、`Build-Store`、`Fetch-Store`，对一个本地 file:// 远端和一个只接受连接、从不回应的回环端口跑真实 git（低速窗口在测试里改成 2 秒）：卡住后在新库里成功、已审查提交那一步卡住、不卡、两次都卡（没有第 3 次）、过了 10 分钟才卡（不重来）、脚本自己的拒绝（不重来）；另把脚本复制一份、只换常驻目录、远端和 git 路径，跑完整主块、`-CheckRefs` 和同一批次的第二次运行（只新建），共 50 例。`CI/test/resident-v2-build-bundle.test.mjs` 在任何主机上钉住这些固定值。
   - 生效要重装（Source v2 文件）。
3. 第 1 段准入之后写 `10-started`。
4. companion 启动 `clued-ci-wsprep@<batchId>`，由 root：按内容重算作业 id、核对已安装 Source 和角色策略、密封 bundle（ls-remote 时间不超过 2 小时）、`fsck --full --strict`、只允许 100644 和 100755 的 blob、建 root:root 0700 工作区。MINOR-7：候选的 head 树先在对象库里核对模式（只许 100644、100755），**然后**才检出，检出带 `core.symlinks=false`、`core.protectNTFS`、`core.protectHFS`，所以 root 从不写出符号链接或子模块。（以非 root 身份检出没有采用：工作区必须是 root:root，换身份要加 chown 步骤，留作 P2 评估。）

全程不执行 PR 内容。

### 10.2 第 8 段

- 今天：5 分钟内要写 ready marker，而 marker 只做格式检查，不是授权；真正的核验是控制发布者实时读合并队列（`queue-facts.mjs:2-7`）。
- Source v2（S8）：删掉 marker；控制助手每 30 秒用 ci-admission Binding 只读核一次（第 12 代：观察通过后还会经 CI 命令门入队、延长租约，见 §56.4）：该 claim 是队首、合并位没过期、tip 等于 base。满足就发布一次；到窗口上限仍不满足，就以 `RESIDENT_QUEUE_HEAD_NOT_REACHED` 干净失败。
- claim 持有者只需按合同 A.6 让就绪的 PR 留在合并队列里，续租由机制自治（resident constraint a8ff16a7）。（第 12 代：CI 准入 Binding 本身不能续租，常驻会提醒持有者续租，并在 Native 支持时经 CI 命令门入队、延长租约，见 §56.1、§56.3、§56.4。）

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
  - bootstrap 安装源复审之后：relay 调用失败时取消已经写好，泵只等完那一次调用（当时最多 40 秒，§7.9 起最多 120 秒）就以 `COMPANION_PUMP_CANCELLED` 结束，不做 blocked 转交，也不再调 relay（ReceiveResult、ReceiveChallenge、ReceiveBlocked，超时和被拒各一）；blocked 转交途中收到取消，在下一个等待步骤结束；取消时已经写好的 response 不再转发。之后的复审又补了：列目录、或 relay 回答“没有”之后，不再发起下一次 relay 调用（没有列表时、主循环里、blocked 转交里各一）；失败的 SendIssue、blocked 转交自己被拒的 ReceiveBlocked 也回复 `COMPANION_PUMP_CANCELLED`；读不出取消文件时，泵和没有中止时完全一样。
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
- **R6 trivy 缓存的 `prepare.lock`**，在不确定结局下会留下（`cache.mjs:160`），复审时确认 Linux 归档是否要把它纳入。（2026-11-05 已实际发生；第 10 代：可证明失效时自动回收并留回执，见 §53.11。）
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
  - 只有状态或文字变化时才写，每轮最多 20 条；“已提议”这类泛泛的文字不会覆盖已写过的状态；写失败的 head：要写的文字变了下一轮就重写，同样的文字 2 分钟后再写（第 12 代，§56.8；原为 10 分钟）。
- **Windows 通知**：在 Owner 会话里弹出，每个事件键只弹一次。事件有：
  - HALT；
  - 状态超过 5 分钟没更新；
  - 某个 PR 提交排队超过 1 小时，按（PR、提交、原因）各一次；
  - 状态名与必需检查重名。

  文字都是固定模板加稳定码。
- 去重记录放在 Owner 自己的 `%LOCALAPPDATA%\CluedIndependentCI\`，不放在常驻目录。
- `companion.json` 的 `status` 可以分别关掉这两项，默认都开。
- **两条线**（`companion-main.mjs#lane`）：companion 自己的动作（邮箱：bundle、工作区、Linux 归档和静止证明、转发泵）和咨询性工作（poller、PR 页面状态、通知）各走一条线，各用自己的 Runner。
  - 一个卡住的 gh 只会占住它自己那条线；服务要的证明（例如 2 分钟期限的 `linux-quiescence`）照常应答，GitHub 再慢也不会让邮箱请求过期，进而导致不该有的 HALT（独立复核 M1）。§24 起，两条线的子进程都由作业宿主在时限处连同它的作业一起结束，卡住的 gh 也只占到时限为止。
  - 咨询性的每次调用最多 15 秒，每轮 PR 页面加通知最多 60 秒，超时后这一轮不再发起新调用。
  - 调用超时或 Runner 仍忙时，这一轮就此结束；没做成的事不记为已做或失败：没弹出的通知下一轮再弹，没写成的 PR 状态不进失败名单（第 12 代起，同样的文字 2 分钟后重写，文字变了下一轮就重写，§56.8）。
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

- `publisher.mjs`：`STAGE8_CHECK_MS = 90_000`。一次运行只看第一次观察加窗口内的几次轮询（第 12 代：入队成功后再观察一次，可以越过窗口，见 §56.4），不再在段里等最长 45 分钟。没就绪时在写任何日志之前零副作用退出，并说明原因（`STAGE8_NOT_READY_REASONS`）：
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
  - （第 12 代：被观察的行和租约提醒见 §56.2、§56.3）
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

## 22. 额度第二期·第 3c-1 步：第 10 段（只读）与影子模式（v1.2，Task `6451a55d`，Decision `2eea28a1`）

Owner Decision `2eea28a1` 把 3c 拆成两步。3c-1 只做影子模式（设计 v0.5 §6 第 4 步）要的部分。今晚装上后 `train.enabled=shadow`：第 10 段只读，不撤销、不写 KooYomi、不改发绿规则，第 8 段仍按关车规则走。开车所需（撤销、清扫、车头批次、S ≠ H、C9）在 3c-2。

### 22.1 第 10 段怎么跑（设计 v0.5 没写打包方式，这里补）

- 第 10 段是批次之外的一个正式段，照旧由通用助手以 clued-control 运行，经 SwapBroker 和 C# 边界，上限 5 分钟。
- 一次运行叫一次“列车维护”（train run）。它的阶段包和批次的阶段包同一套格式（计划、作业列表、工作清单、密封），区别只在作业：
  - 作业合同 `clued.independent-ci.train-run/1`，字段 `contract, id, repo, runId, mode, sourceManifestSha256, createdAt`；id = sha256(JSON([合同, repo, runId, mode, sourceManifestSha256]))。
  - `runId` 是常驻层生成的 16+12 位十六进制（和批次 id 同形），`batchKey` 由它推出；`mode` 只能是 `shadow`（3c-2 才放开 `on`）。
  - 作业角色 `train-run`，入口角色 `train-maintenance`，阶段号 10，种类 `train`，不属于任何批次的八段。
- `derive-batch.mjs --train-run <runId> --train-key <key> --mode shadow --out <新目录>` 推出这个包，放在 `resident\work\train\<runId>`。常驻层 `engine-windows.mjs` 的 `runTrainStage` 照第 R 段的做法推导、调用、解析；run key 和 run id 是新的随机值，推导只核对形状。
- C# 边界（`FormalPublicBoundaryV2.cs`）和 SwapBroker：阶段表加第 10 行（入口 train-maintenance、上限 5 分钟、作业角色 train-run）；第 10 段的作业按 train-run 合同校验（`ValidateTrainRun`：mode 只能是 shadow，run id 必须等于计划的 batchId，id 按公式重算），其他段不变。
- 结果：入口写出 `status: 'TRAIN_FACTS'` 和 `train` 事实（`stage-inputs.mjs` 的 `writeOutcome` 像第 R 段的 `relay` 那样单独校验这一块）；`stage-fact.mjs` 认这个成功状态。

### 22.2 第 10 段在影子模式下读什么、算什么（设计 §5.5 第 1、2、8 条）

1. KooYomi `clued_work_merge_slot_holders_v1`（CI 身份）：车头的认领、PR、`merge_slot_until`、`taken_at`、CI 状态。它同时是当班探测：回答 `admission_binding_required` 就记“不当班”，其余照读。
2. GitHub：main 尖端；车头 PR 的状态、head、草稿、`mergeable`、`merge_commit_sha` 与它的父提交和树；head 是否含 main 尖端（compare）；main 的规则（`strict`、合并方式、六项钉 5368905）。
3. 绿色台账：列出全部记录，按 head 汇总最后阶段；对“成功且还没撤销”的，查它是否已在 main 里。
4. 算出“如果开车会做什么”（设计 §5.2、§5.6）：没有车头；车头是别的 scope 的认领；车头不能跑（草稿、关闭）；车头需要作者先合 main（受保护且落后、冲突、`strict` 开着且落后）；车头已绿等合并；会开车头批次（T、S 与它的两个父提交）；以及会撤销哪些旧绿（台账里不在 main 里、又不是车头当前 head 的成功）。
5. 每次运行写一条只新建的影子记录（`state\v2\train-shadow\`，`acl-model.json` 新增，只有 clued-control 能写），供第 4 步统计：车头变绿到合入的空档、第 2 位的等待、车头首次运行失败率、每个 PR 平均几个 head、GitHub 在 main 移动后多久重算试合并。统计离线从记录里算，不进执行器。
6. 影子模式不做的：不撤销、不调用 touch/adopt/return、不改第 8 段、不开车头批次、不做 GitHub 全量枚举（GraphQL 强推事件留给 3c-2 的清扫）。

### 22.3 常驻层

- 策略 `/6` 新增 `train`（第 10 段上限钉在 300000，C# 边界和 SwapBroker 只允许 5 分钟）：`enabled`（`off`/`shadow`；`on` 在 3c-2 之前拒绝）、`nonFrontRuns`（只认 `true`，即今天的做法）、`maintenanceEveryMs`（默认 10 分钟）、`maintenanceMaxPerDay`（默认 200，设计 §4.7）。
- 执行器（`executor.mjs#trainMaintenance`）：`enabled=shadow` 时，一次节拍里调度没有跑任何批次（结果是空闲或只有推迟，停靠中的批次不算在跑），且离上次第 10 段超过 `maintenanceEveryMs`，就跑一次。暂停接新（队列为空时也查，见 §22.7 M1）、PAUSE、HALT 时都不跑：执行器的 PAUSE 本来就只留读触发这一件事，3c-1 不改它的含义（设计 §4.3 说暂停只停发绿，那是为 3c-2 的清扫准备的，到时再定）。第 10 段也守开批次前的两条：安装授权在本段上限加余量（`limits.stageMarginMs`，不少于助手固定的 180 秒）内到期就不跑，Source 或常驻字节漂移就 HALT（`RESIDENT_SOURCE_DRIFT`）。运行期间状态显示 `RUNNING TRAIN_MAINTENANCE`。
- 计数和中断：第 10 段没有账本条目，由回执链代替。运行前写 `train-run-intent`，结束写 `train-run`（runId、是否成功、失败码、会做什么、车头 PR、main、会撤几个）。每个进程启动后第一次节拍从回执链读最近的记录（`receipts.mjs#latest`）：取最近 24 小时的 intent 时刻计数，到 `maintenanceMaxPerDay` 就停到窗口滚动；如果最新的一条是没有 `train-run` 收尾的 intent（运行中途崩溃或被停），先 HALT `TRAIN_STAGE_INTERRUPTED`，再补一条收尾回执，所以只停一次；这一步放在 HALT 检查之前，已经停着时发现的中断也当场收尾，复位一次就够。回执链读不到时所有批次都等（排除不了没收尾的 intent），暂时性错误最多 30 分钟，之后 HALT `TRAIN_RECEIPTS_UNREADABLE`。
- 失败：只有 Windows 证明齐全、结果里没有副作用，并且是白名单里的干净码（classify.mjs）、引擎自己在 broker 之前的拒绝（`TRAIN_STAGE_REFUSED`）或一个绑定的零副作用 BLOCKED 结果（也包括写完 TRAIN_FACTS 后撞上 5 分钟上限的）时，才算干净失败：只记 `train-run` 回执，不进熔断，下次照跑。清理没证实（Windows 进程树或 runner 原服务没确认）或调用抛异常 HALT `TRAIN_STAGE_CLEANUP_UNCONFIRMED`；有副作用、可能已发布或不是干净码（如 `BROKER_BUSY`）HALT `TRAIN_STAGE_OUTCOME_UNCONFIRMED`。
- 阶段事实（`stage-fact.mjs`）：第 10 段只有 `TRAIN_FACTS`、零副作用、`mayHavePublished=false` 且事实通过 `validateTrainFacts` 才算成功，事实随阶段事实带回；其余都是现有的 `STAGE_OUTCOME_MISSING`，不新增失败码；这个结局干净与否由执行器按证明和绑定的结果判断（见下一条“失败”）。
- 状态快照（合同 `/5`，即 C5 的 `/4` 加这一块）多一个 `train`：`enabled`（策略里的模式）和 `last`（最近一次成功运行的摘要，`train.mjs#trainSummary`）。PR 页面（`pr-status.mjs`）只在最近 30 分钟内的运行看到的车头正是这个 PR 的这个 head 时，把“列车影子（只记录，不执行）：……”接在执行器原来那句后面；失败、出错时不加。和 C5 的当班视图一起时，这行只出现在本节点当班或有结果的 head 上；备用节点、停滞和双活提示整句替换描述，这行随之不显示。
- companion 规则集兜底（设计 §6 末，`ruleset-backstop.mjs#companionBackstop`，`companion-main.mjs` 每轮 poll 调一次）：用 Owner 的只读 gh 读 `rules/branches/main`；读到 `strict=false` 而状态快照里 `train.enabled` 不是 `on`（读不到也算不是），就往用户可写的 `requests\` 写一个暂停请求并弹紧急通知；读到六项不再全部钉 5368905 或没有 `required_status_checks`，只弹通知。每类每天一次，记在 companion 自己的存储里（`pr-status.mjs#LocalStore`，`backstop:` 键）。读不到规则什么都不做（第 8 段自己会以 `RULESET_UNREADABLE` 停靠）。

### 22.4 为什么装上是安全的

- 第 10 段只读：没有任何 GitHub 或 KooYomi 写，失败了也只是少一条影子记录。
- 第 8 段的发绿规则不变（列车模式仍是 off；影子只读不发绿）。
- 策略 `/6` 的 `train.enabled` 在测试里默认 `off`；策略样例写 `shadow`，今晚装的就是它。
- 规则集兜底只会写暂停请求（只能停），不会多发绿。
- 一处行为变化：开着 shadow 时，暂停接新的状态一直读不到，空队列也会在 30 分钟后 HALT `INTAKE_PAUSE_STATE_UNAVAILABLE`（第 10 段要过这道门）；关着列车时不会。

### 22.5 留给 3c-2 的

- 开车要做的部分：第 8 段的单绿规则（设计 §5.3 第 4 条）、检查说明（第 6 条）、`touch green`（第 8 条）；不依赖日志的撤销、增量与全量清扫（含 GraphQL 强推事件和失败关闭）、台账清理；车头批次调度（S 来自第 10 段）、请合 main、硬上限、touch、adopt、return；§21.3 所列的 S ≠ H 各项；C9（接手时清扫、撤别人的检查前核角色、撤自己的不要求角色）。
- 保留：`retention.mjs` 只量 spool 归档、`work\` 和 `bundles\` 的字节，不管回执链、`state\v2\receipts`、`train-shadow`、broker 文件和 `resident\stage`。第 10 段每天约 280 条回执，现装节点约每天 590 条，回执链增长快约一半；每次启动读全部回执、每次追加列出整个目录。开车（3c-2）之前要定这些目录的保留办法。
- **列车调度要支持优先级或截止时间**（Owner Decision `349f6e42`：常驻 CI 的排队协调改由合并列车承担，不另写协调机器人）。实际例子：主备 C5 改的是 3c 要用的文件，必须在某个时刻前合入，只按先来后到排的列车不知道这种期限。3c-2 设计时定来源（PR 标签、认领字段或 KooYomi Task 的截止时间）和规则（截止时间先于先来后到，且不能让车头之外的 PR 插队绕过“只有一个绿”）。

### 22.6 测试

- Source v2：`train-run.test.mjs`（作业合同、id 公式、阶段行、`--train-run` 推导与封包、invoke-stage 端到端：只有 TRAIN_FACTS + 零副作用 + 合格事实才算成功），`train-facts.test.mjs`（当班探测、车头事实、会做什么、会撤哪些旧绿），C# 纯测试第 10 段（入口、阶段表、`ValidateTrainRun` 拒 on、拒别的计划、拒别的 repo、train-run 不能当 /3 作业）。`source-closure.json` 重新生成，只多了五个新文件。
- 常驻层：`train.test.mjs`（到期规则、摘要、状态副本、PR 页面行；执行器：空闲才跑、关车/PAUSE/每日上限不跑、失败只记回执、清理没证实或抛异常 HALT、漂移 HALT、中断的 intent 在下次启动 HALT 一次且计数跨重启），`ruleset-backstop.test.mjs`（规则读法、只暂停不恢复、每天一次、companion 接线），策略 /6 与各段上限的旧测试随之更新。
- 离线演练多三步（第 52–54 步）：空闲时跑一次第 10 段只留两条回执；有 PR 时先跑批次，那一拍不跑第 10 段，十分钟后的空闲拍再跑；第 10 段清理没证实就 HALT。

### 22.7 独立审核（规则 01d4ba7d）

第 1 轮（预览树 fb97b65d：main c955068d + C4 #915 + 3c-1）：ACCEPT-WITH-FIXES，1 MAJOR、6 MINOR、5 NIT。确认成立的：第 10 段对 GitHub 和 KooYomi 没有写（只有安装令牌的签发是 POST，holders RPC 在迁移里是只读的），第 8 段不变，兜底只能暂停，两处 HALT 都在收尾回执之前，C# 边界和 SwapBroker 只认一个 train-run/1，阶段事实的成功条件，策略拒 `on`，批次预算不含第 10 段，closure 只多五个文件，状态与 PR 页面行对坏字节安全。

- M1 队列为空时 `schedule()` 在暂停接新的门之前就回空闲，第 10 段照跑：`trainMaintenance` 自己先过一次暂停接新的门（读不到状态也算挡住）；测试补“空队列 + 暂停接新”。
- m2 授权到期只看了本段上限，没加助手要求的 180 秒余量：改为上限加 `limits.stageMarginMs`；策略把第 10 段上限钉在 300000（C# 和 SwapBroker 都只允许 5 分钟）；测试补边界两侧。
- m3 执行器没看第 10 段的结果：现在只有 Windows 证明齐全、结果里没有副作用、并且是白名单里的干净码（classify.mjs）、引擎自己在 broker 之前的拒绝或一个绑定的 BLOCKED 结果时才算干净失败；有副作用、可能已发布、`BROKER_BUSY` 之类一律 HALT（`TRAIN_STAGE_OUTCOME_UNCONFIRMED`）；测试逐类覆盖。
- m4 回执链读不到时只挡第 10 段：现在挡所有批次（排除不了没收尾的 intent），暂时性错误最多 30 分钟（与回填同一上限），拒绝立刻，之后 HALT `TRAIN_RECEIPTS_UNREADABLE`；测试补。
- m5 `test-migrate-acl.ps1` 的步数从 3a 起就过时（12）：改为 14，并核对 green-ledger 和 train-shadow 两个目录只有 clued-control 能写；离线跑通 14 条。
- m6 测试缺口：补了暂停接新、授权余量、HALT 先于收尾回执（回执写失败时 HALT 仍在）、读不到回执链；`train-facts.test.mjs` 那条永远不会失败的只读断言换成按顺序核对每次读；新增接线测试：真的 GitHub 端口和 KooYomi 端口配一个只答读请求的 fetch，除令牌签发和 holders RPC 外全是 GET。SwapBroker 第 10 行没有单独的 broker 测试，由 C# 纯测试的阶段表断言和 `StageMilliseconds` 长度覆盖。
- m7 运维上的取舍，不需要 Owner 另行决定：第 10 段运行中重启会 HALT 一次、要复位，这和任何一段运行中崩溃一样（复位前核对两台主机都静止）。每次运行留约 13 个小文件和 2 条回执：第 1 轮答复说由 `retention.mjs` 管，第 2 轮指出这不对（它只量 spool 归档、`work\`、`bundles\`），已更正，保留办法列入 §22.5，3c-2 之前定。
- NIT：兜底改为先记“今天已处理”再弹通知，通知失败不再每轮写暂停请求；`receipts.mjs` 注释改指 `trainRecover`；第 10 段运行期间状态显示 `RUNNING TRAIN_MAINTENANCE`；窄窗口里崩溃可能 HALT 两次（`halt` 幂等，无害）；`trainRunKey` 只给测试和推导核对用，常驻层用自己的随机数。

第 2 轮（预览树 b18f30bd）：ACCEPT-WITH-FIXES，2 MINOR、6 NIT，不挡今晚装。第 1 轮的 M1、m2、m3、m4、m5 已关；m6 部分关；m7 的复位理由成立。新的失败规则对追到的每种结局都对：GitHub 或 KooYomi 暂时读不到（绑定的 BLOCKED）、broker 启动前拒绝、助手预检拒绝、没有结果的子进程超时、引擎自己推导被拒，都保持干净；只有未知或没证实的结局 HALT。

- m1 干净规则里走 classify 的那一支没有测试：补了 `BROKER_REQUEST_EXPIRED`、`BROKER_REQUEST_REFUSED`、`STAGE_HELPER_PREFLIGHT_REFUSED`、无结果的 `STAGE_CHILD_TIMEOUT`（都不 HALT），以及证明不齐的一例（HALT）。
- m2 §22.7 m7 说第 10 段的文件由 `retention.mjs` 管，不对：已更正，保留办法列入 §22.5。
- NIT：写完 TRAIN_FACTS 后撞上限的运行不再 HALT；授权余量不低于助手固定的 180 秒，策略里的 300000 也加了测试；SwapBroker 和 C# 边界的阶段表加了一致性测试（第 1 轮 m6.3 的理由不对，已补）；已经停着时发现的中断当场收尾，复位一次就够；过时的注释和本节文字已改；回执链暂读不到的那几分钟里，停在 A 点的批次暂时不显示在 PR 页面上，只在进程启动时遇到暂时性读错误才会发生，接受。
- 补测：调度推迟（companion 没就绪）时第 10 段照跑、已停机启动时什么都不跑。

第 3 轮（接合审核，预览树 3c9fe384 = 3c-1 + C5 #918 head 29deb110 + C4 #915 head 514b6e67）：ACCEPT-WITH-FIXES，1 MINOR、4 NIT，不挡推送。3c-1 的补丁在 C5、C4 的代码里位置正确，两边的东西没有丢也没有换序，运行时配合正常；状态 `/5` 里 C5 的 `node` 和 3c-1 的 `train` 并存；兜底从真实的 `/5` 状态读到 `shadow`；closure 在 C4 之上只多五个文件。

- m1 companion 报告器里的列车影子行、执行器填 `status.train.last` 没有测试：两处都补了（报告器：车头 PR 有这一行，别的 PR 没有；执行器：一次运行后状态里有模式和摘要）。
- NIT：停机时补写收尾回执失败不再让服务退出（HALT 已在，下次启动再补）；本节写明状态合同 `/5` 以及与当班视图一起时这行在哪些 head 上出现；附录 A 补了 3c-1 的文件；交班后 `已交班` 文字下可能留一行旧的影子说明，它本来就只记录，接受。

### 22.8 Source31 CI 引导资格指针（Task `6451a55d`）

本 PR 的普通 Source 引导继续按精确登记的工作流、Role 与 Source 组合核验。此次受查 Source 为 `31e757ac2d613c9e76d0b7e416d906fd9c7d48be`，Owner 接受依据为 Decision `ae3538a1-627d-49d4-b13a-bdf6d1223856` / Receipt `cf26ce6a-e6f7-4204-9195-9c3a55310e41`。

2026-10-24 的双端标准安装与验证证据见 Canonical Note `7abd3c63-3bd7-42bf-8f36-670bf84552fb` 第 44 版：Linux readiness 原 SHA256 为 `eb11e62ab0494c2efa8bb6ebf505816ed12add61d0e81b52353f0233a86785d3`，Windows 正式完成回执原 SHA256 为 `598dd9f11122e38adebd03cf8cda7353d341c45fa4b51fd4a24c6f390baa3f76`。完整安装回执、独审与保留证据由该记录引用，仓库保留此短指针。

本 PR 的交付范围仍为 3c-1 shadow；正式六项检查、受保护合并及其后 3c-2/C9 和第 4–7 步的当前状态由 Task `6451a55d` 跟踪，Source 安装证据不替代这些 Gate。

## 23. 主备 C5：PR 页面节点状态、接班核对与双活停机（Task `ade5df89`）

C5 的代码已由 PR #918 合入。本节说明 `src/node-duty.mjs`、`src/pr-status.mjs` 与 `src/status.mjs` 的行为：companion 在 Owner 登录会话里显示各节点的当班情况，提醒无人接手的 PR，并用 C6 的暂停接新请求锁住发现双活的本节点。PR 页面和本地状态都是提示；真正的发布互斥仍由服务端 ci-admission 角色与 C4 的 GitHub 写后核对承担。

### 23.1 节点身份与状态快照

- C5 在状态合同 `/4` 加入 `node`；当时的合同是 `/5`（§22 的 `train` 与 `node` 并存）；C3 起是 `clued.independent-ci.resident-status/6`，`node` 多一个 `source`，由执行器从启动时就写（§29.4）。`node` 包含 `name`、`mode`（`ACTIVE`、`STANDBY`、`UNCERTAIN`）及 `probe`（时间、`held` / `not-held` / `uncertain`、连续失败数与失败起点）。它是执行器写出的视图，不是角色授权。
- `node=null` 保留单节点兼容行为：按 ACTIVE 显示，名字用 companion 的 `status.node`，默认 `turing`；没有已知节点的角色探测，就不做接班核对。节点名为 1–32 位小写字母、数字或中划线，首尾不能是中划线。
- `status.json` 每 15 秒整份重写；超过 5 分钟未更新按停滞处理。companion 只读执行器状态，在 Owner 自己的 LocalStore 保存页面写入、提醒与双活锁；暂停和恢复通过 `requests\` 传递。

### 23.2 每个节点写自己的页面状态

节点使用 commit status `resident-queue/<node> (info only)`；备用提醒另用 `resident-standby (info only)`。旧名 `resident-queue (info only)` 不再写，也不作为别的节点当班的依据。读不到 main 的 required checks，或任一待写 context 与其重名时，本轮不写页面状态；正常读取结果缓存 30 分钟，比较时忽略大小写和首尾空白。

| 文字开头 | 含义与写入范围 |
|---|---|
| `当班：` | 本节点自己的当前批次或排队中的这个 head，且状态新鲜、执行器不是 STOPPED / STARTING，没有 HALT、PAUSE、暂停接新或 open 熔断，角色模式也不是 UNCERTAIN。排队中的 QUEUED、PARKED、WAITING、BACKOFF 都算本节点接手的 head。 |
| `停摆（CODE）：` | 自己接手的 head 不满足上述条件，显示固定原因码，如 STATUS_STALE、EXECUTOR_STOPPED、INTAKE_PAUSED、BREAKER_OPEN、NODE_ROLE_UNCERTAIN 或实际 HALT 码。 |
| `双活停机：` | 本节点持有双活锁；自己的在跑或排队 head 提示停止取新触发，并请 Owner 在 KooYomi 收回其中一个节点的 ci-admission。 |
| `已交班：` | 节点变成 STANDBY 后，对本地记得在最近 30 分钟写过当班或双活文字的 head 补写；若其后已有结果，保留结果文字。其余旧状态不成批改写。 |
| 结果或提示文字 | 自己跑过、排过的 head 可显示结果；ACTIVE 一侧仍可写“落后 main”提示。它们都不算当班。STANDBY 不写新的排队、结果或落后 main 提示，只补交班和备用提醒。 |

别的节点只认 Owner 当前 GitHub 账号、精确节点 context 和固定模板；同一 head 上每个节点以**最新一条**为准。最新结果、已交班或无法识别的文字不会让更早的“当班”复活。只有最新的“当班”或“双活停机”在 30 分钟窗口内才阻止接班。

相同的当班、双活和停摆文字每 14 分钟可重写一次，保持存活时间；该 head/context 的本地累计写入数达到 900 后停止这种定时刷新，变化的文字仍可写。companion 重启后，对本地记得最近 30 分钟写过当班或双活、仍打开且本轮没有重新描述的 head，补 `停摆（NODE_RESTARTED）`，写成功才销账。

### 23.3 备用提醒与接班时间

STANDBY 对符合触发条件的打开 PR 检查三种情况：对方持续写停摆至少 10 分钟且最新状态仍在 30 分钟窗口内；对方最新当班或双活文字已超过 30 分钟没刷新；或本 companion 看到这个 head 已至少 30 分钟、没有节点当班，且查明 App `5368905` 没有发布名为 `kooyumi-work-admission` 的 check-run。最后一项判断的是检查是否存在，不是它是否通过；读不到检查结果不当作没有检查。

提醒写在备用 context，并发 Windows 通知，建议 Owner 移交 ci-admission；它不会自行移交。每个 `(PR, head, reason)` 在本地保留窗口内只提醒一次，相关记忆保留 24 小时。一个 head 的 statuses 成功读到后缓存 5 分钟；读取失败不更新缓存时间，可以在下一轮报告时再试（正常轮询约 1 分钟）。每轮最多尝试读 10 个 head，并受读取前的预算检查约束。

时间口径与通知一致：移交后，对方空闲或停摆时，本节点下一次角色探测通常在 15 分钟内接班；对方仍在跑批时，要等它发现角色已失去并写“已交班”。这不是固定的最长接班时间。确定的 ACTIVE / STANDBY 转换及连续至少三次不确定的角色探测也有通知，UNCERTAIN 本身不算一次确定模式转换。

### 23.4 接班核对及其边界

每次新的 `held` 角色探测确认本节点 ACTIVE、且没有双活锁时，companion 对本轮看到的打开 PR heads 做接班核对。每轮最多读 10 个；未读完则后续轮继续（第 12 代：核对进行中来了新的探测也不重来；核对在读完时结束，或在角色不再被确认、上锁时丢掉；节点一直 ACTIVE 时新核对最多每 15 分钟开始一次；刚转为 ACTIVE（包括从 UNCERTAIN 回到 ACTIVE）、执行器重新启动（状态里的 pid 变了）或上一次核对被丢掉时立即开始，见 §56.2）。单个 head 读取失败后等 5 分钟再试，连续三次失败就跳过这个 head，让核对可以结束；Owner GitHub login 读不到时只等待，不计入这三次。

发现另一节点的最新当班或双活文字仍在 30 分钟窗口内，就建立本地锁：原来已 ACTIVE 的记 `dual-active`，新接班的记 `takeover-refused`。两者都暂停本节点接新并通知 Owner。核对进行中本身不是执行器的准入闸门，锁在整轮核对结束并确认冲突后建立。

每个 head 的 statuses 读取只取最新一页（`per_page=100`），没有全历史分页；核对还会受网络、报告器预算、本地记忆丢失和上述跳过规则影响。因此“没看到当班”只表示这次有界读取没发现，不能证明另一节点没有角色或没有工作，也不能替代服务端角色与发布核对。

### 23.5 双活锁的维持与三种解除

锁住时通过 C6 写 `holder=dual-active`、120 分钟的暂停接新。状态显示该持有者剩余不超过 90 分钟时续写；正常状态下两次写请求至少隔 5 分钟，状态停滞或读不到时至少隔 60 分钟。它只影响接新，当前及停靠批次仍按 C6 的原规则处理；Owner 自己的暂停持有者互不解除。

锁只通过下面三种情况解除：

1. 本节点成为已知的 STANDBY：释放自己的 `dual-active` 持有者，并补写交班。
2. 对方在曾观察到它当班的某个 head 上，最新状态变为“已交班”：释放本节点的持有者。此类复查至少隔 5 分钟；两边都写“双活停机”不会互相解锁，单纯过了 30 分钟也不解锁。
3. Owner 用 `rearm-tool request-intake-resume --holder dual-active` 复位：companion 需看到新鲜状态、快照的 `writtenAt` 严格晚于最近暂停请求的 `holdAt + 60_000`、原暂停结束时间仍未到、该持有者已消失，且没有 `unconfirmed` / `unreadable` 持有者；连续两次观察至少隔 1 分钟才确认。这是代码依据时间和持有者状态作出的推断，这项判定不核对请求 ID 或消费回执；独立定时器在长阶段运行时也会更新快照时间，时间条件本身不能证明执行器已读过请求。确认期间不续写暂停。暂停自然到期或状态读不清不算 Owner 复位。

### 23.6 报告器边界

报告器每轮最多写 20 条页面状态、显示 5 条通知；单个外部调用超时 15 秒，页面写失败后冷却 2 分钟，要写的文字变了下一轮就重写（第 12 代，见 §56.8；原为 10 分钟）。受 `inBudget()` 保护的通知、逐 head 扫描和页面写入路径会检查本轮已用时间是否小于 60 秒，已启动的调用可以越过这一时点；读取 required contexts 之前没有这项预算检查，需实际读取规则时即使前面的通知已耗尽预算，仍可能发起一次规则 GET。因此 60 秒不是所有调用的统一启动硬上限。它在 companion 独立的 advisory lane 运行；先显示本地通知，再做节点核对与页面写入。超时留下未结束子进程时本轮停止发起后续调用，下一轮等待原 Runner，不把尚未完成的动作记成成功。

本节记录 C5 已合入代码的行为；主机安装、节点资格和真实移交仍按各自的授权与验证流程办理。

## 24. companion 子进程超时：作业对象收尾，第 0 段不靠 companion 收尾（Task `8e1f07d3`）

这是设计层面的改动：companion 的 Runner 不再沿用“从不杀子进程”。下面写清改的范围、理由和边界，已经过独立审核（§24.8）。服务自己的 Runner 不变。

### 24.1 现象与链路

- 2026-10-23，PR #916 的批次：companion 跑 `build-bundle` 到 30 分钟上限，答复 `BUNDLE_UNAVAILABLE`，可它起的进程树（powershell 加 4 个 git）还在（Note `d1c2eac3`）。
- 链路（main `c955068d` 只读核实）：
  1. `runner.mjs` 从不杀子进程，超时后 Runner 一直 busy，直到子进程自己结束；
  2. `companion-main.mjs` 的 `lane` 在 busy 时什么请求都不取，整条邮箱通道停摆，心跳也停；
  3. 执行器在第 0 段失败时调 `closeOrThrow`，`engine.closeBatch` 要向 companion 要 `archive-linux` 的结果。没人答，6 分钟后过期，报 `UNEXECUTED_CLOSE_UNCONFIRMED`，09:14Z HALT。
- 恢复靠 Owner 结束遗留进程并 rearm（Decision `901a8968`）。一次 HALT 要 Owner 点一次 UAC。
- Task `4d3aaa64`（`build-bundle.ps1` 低速超时 + 在新库里重做一次）写本节时仍未合入 main，现随集成 PR 合入（原 PR #928，§10.1）。即使有了它，下面几种情况仍会走到这条链路：慢而不断的传输、git 卡在 curl 之外（例如凭据助手弹窗）、companion 的其他子进程（wsl、relay、gh）超时。

### 24.2 决定：companion 的每个子进程都建在它自己的作业对象里

- **宿主** `windows/CompanionJobHost.cs`，安装时编译为 `bin\CluedCompanionJobHost.exe`（只有管理员能写，Owner 可读可执行）。调用方式：`<nonce> <时限毫秒> <绝对路径的程序> [参数...]`。
  1. 新建一个作业对象，标志是 `KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION`（`0x2400`）。不许脱离：没有 `BREAKAWAY_OK`，也没有 `SILENT_BREAKAWAY_OK`。node 直接起子进程时，子进程所在的 libuv 作业标志是 `0x3c00`，即这两项再加两个脱离许可。所以崩溃的子进程仍然立即结束，不会在错误报告里挂到时限。
  2. 子进程**直接建在这个作业里**：
     - 用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 创建（Windows 10 1607 起可用；TURING 是 Windows 11），同时挂起（`CREATE_SUSPENDED | CREATE_NO_WINDOW`）；
     - 宿主用 `IsProcessInJob` 核实它确在作业里，然后才恢复运行；
     - 所以子进程从来不在这个作业之外，连运行前也不在，它起的一切进程也都在作业里；
     - 内核不确认它在作业里时，就地结束这个还没运行过的子进程，不会恢复它（`CHILD_JOB_UNCONFIRMED`）。
  3. 子进程只继承三个句柄：NUL 作 stdin，加上宿主自己的 stdout 和 stderr（用 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 限定）。
     - companion 读到的输出和直接起子进程时一样；
     - 环境变量和当前目录沿用宿主自己的，也就是 companion 原来给子进程的那一份；
     - 参数按 libuv 的规则重新加引号，子进程拿到的参数逐字相同（测试覆盖空格、引号、结尾反斜杠和空串）。
  4. 子进程自己结束，或者超过时限时：
     - 宿主终止这个作业（`TerminateJobObject`），然后等到内核计的作业存活进程数为 0（`ActiveProcesses = 0`），并且子进程的退出码已知；
     - 等待期间如果还有进程，每 500 毫秒再终止一次作业；
     - 最多等 30 秒。
  5. 报告是宿主在 stderr 上写的最后一行：`clued-job-host <nonce> {...}`，合同 `clued.independent-ci.companion-job-host-report/1`。
     - 字段恰好是 `started`、`failure`、`childPid`、`timedOut`、`exitCode`、`leftover`（等待结束时作业里还活着的进程数）、`activeProcesses`、`totalProcesses`、`treeZero`；
     - 退出码：子进程自己结束时取它的退出码，超时 121，没起子进程 120，其他 122。
- **原则和 §6.5 的通用助手相同**：只终止并排空自己建的作业对象。作业外的进程一个都不看、不碰，也不按父进程号遍历进程树（父进程号可能被复用，这正是原规则要防的“来历不明的进程树”）。宿主一结束，作业随之关闭，内核结束作业里剩下的每个进程（`KILL_ON_JOB_CLOSE`），这仍然只涉及这一棵树。
- **TURING 实测**：作业里实际有哪些进程（`JobObjectBasicProcessIdList`）。
  - wsl：`System32\wsl.exe` → `Program Files\WSL\wsl.exe` → `wslhost.exe` → `conhost.exe`；
  - git：`cmd\git.exe` → mingw `git.exe` → `git-remote-http(s).exe`；
  - powershell、node 各带一个 `conhost.exe`。

  这些进程都随这次调用自己结束。子进程退出后剩下的，只有一个正在退出的 conhost。没有哪个需要在调用之后继续存在，所以每次调用后都排空作业不会伤到 WSL 或 git。
- **Linux 一侧**：结束 wsl.exe 时，它直接起的 Linux 进程也立即结束（审核实测：`sleep` 和 `sh -c 'exec sleep'` 都是）。只有 systemd unit 继续运行，Linux worker 从不受影响。Linux 的静止事实仍然只来自 root 工具。
- **半路被结束的子进程，各自的后果**：
  - `build-bundle.ps1`：每批一个只新建的 `bundles\<batchId>\`，残留不会再读；下一批用新的 batchId。
  - `-CheckRefs`、gh：只读。
  - `relay-public.ps1`：
    - 它自己的规则是：wsl 子进程 90 秒没结束就报 `PUBLIC_TERMINAL_UNCONFIRMED_LOCKS_RETAINED`，然后不杀 wsl，一直持着父目录锁，直到 wsl 结束。宿主在 companion 的时限（`RELAY_TIMEOUT_MS`，120 秒）处覆盖这条规则：relay、它起的 wsl.exe 和 Linux 上的 `relay-record.mjs` 一起结束，写方和锁同时消失；
    - 这个脚本自己有界的部分（Add-Type、哈希，加 5+90+5 秒）在 120 秒内做完。被覆盖的只是“wsl 一直不结束、就一直持锁”这一段，也就是卡死的情形；
    - 两侧都是先写数据并落盘，最后才新建 ready 标记：Windows incoming 用 `CreateNew`，Linux incoming 由 `relay-record.mjs` 用 `wx` 加 fsync。半路结束，最多留下一份没有标记的数据，读方不会取它；同一条记录也不会再转一次（`EXISTING_RECORD_PRESERVED_NO_RETRY`）。泵原来把搬运超时当成 `RELAY_REFUSED_NO_RETRY`；§25 起，被结束的调用归 AMBIGUOUS，由到达核对裁定是否已到、能否再试。
  - `systemctl start --wait`：unit 由 systemd 继续运行；其余 wsl 调用都是只读工具。
- **Runner**（`src/runner.mjs`，只有 companion 给它 `jobHost`）：
  - 起子进程时实际起的是宿主：`[宿主, nonce, 时限, ...argv]`。时限只收 1 秒到 1 小时。
  - 结果按报告来：
    - 自己结束并排空：返回它的退出码和输出，报告行从 stderr 里去掉；
    - 自己结束、但剩下的进程没排空：仍返回它的退出码，另加 `tree: 'unconfirmed'`；
    - 超时：`timedOut`，`tree` 是 `'zero'` 或 `'unconfirmed'`；
    - 没有报告、nonce 不对、报告有失败码、退出码对不上：`JOB_HOST_UNCONFIRMED`，从不当成功。
  - stderr 照常最多留 4 MiB；另有一份末尾 4 KB，专门用来找报告，所以子进程写了很多 stderr 也不影响。
  - 宿主自己超过“时限 + 60 秒”还没结束时，Runner 结束这个宿主。宿主是它自己的直接子进程，句柄一直在它手里，不存在进程号复用。宿主一结束，它的作业就关闭。
  - companion 的 Runner 只在宿主运行期间 busy。结束请求被系统拒绝时（`error` 事件，有 pid），仍然 busy，直到宿主真的结束；只有宿主根本没起来（没有 pid）时才立即空闲。
  - 启动时，companion 经宿主跑一个固定的无害子进程（`cmd /d /c exit 0`）。没跑起来、退出码不是 0 或没排空，companion 就不启动（`COMPANION_JOB_HOST_UNAVAILABLE`），不发心跳，执行器不开批次；不会在心跳正常的情况下让每个请求都悄悄失败。
- **服务自己的 Runner 不变**：从不杀子进程，超时后 busy。Windows 侧的证明（`windowsTreeZero`）依赖这一条。

### 24.3 邮箱通道不再停摆

- 子进程超时后，宿主在时限之后最多 30 秒排空作业，Runner 随即空闲，`lane` 接着处理下一个请求。`linux-quiescence` 等证明用 root 工具的新鲜事实回答；泵在 relay 超时之后，它的 blocked 转交也能真正发出去。
- `lane` 仍会 busy 的情况只剩一种：宿主进程本身还活着，或者作业里有一个结束不了、又还握着输出管道的进程。这是原规则用在宿主上。这时心跳停，执行器不开新批次（`COMPANION_NOT_READY`）。
- 两条 lane 都用宿主，所以 gh 卡住也不会让 PR 页面状态一直停着。
- **答复 `/2`**：`clued.independent-ci.resident-companion-response/2` 多一个字段 `jobTree`：
  - `null`：每个子进程都自己结束并已排空，或者根本没起子进程；
  - `'zero'`：某个子进程的作业不得不由宿主结束（超过时限，或子进程起来之后宿主报了失败），并且作业里没有剩下的进程；
  - `'unconfirmed'`：宿主没能证明这一点，包括剩下的进程没排空、宿主没给报告。

  这只是记录，两端的证明都不依赖 companion 自己的进程树。companion 和服务来自同一个安装包，一起升级；重装前要先卸载，卸载会结束 companion 进程（`uninstall-resident.ps1`），邮箱里不会留着两种版本的答复。

### 24.4 第 0 段失败不靠 companion 收尾

- 第 1 段之前，这一批的东西都没到 Linux：
  - 描述符和 bundle 都只在 Windows 上（`outbox\<batchId>\`、Owner 的投放目录 `resident\bundles\<batchId>\`）；
  - 第 1 段不起 Linux worker（policy `linuxWorker: false`）；
  - 工作区准备在第 1 段之后才做。

  所以第 1 段之前释放的批次，收尾只归档 Windows：`closeOrThrow(batch, { linux: false })`。这包括 bundle 失败，也包括第 1 段之前被新提交取代。这个参数原来就有，第 R 段把所有重角色都转出去时用的就是它。
- 释放不再等 companion 的任何答复。companion 忙着、刚结束或根本不在，都不会再把第 0 段失败变成 `UNEXECUTED_CLOSE_UNCONFIRMED` 和 HALT。Windows 归档用的是服务自己的 `archive-windows-spool.ps1`，不经过 companion。
- `batch-unexecuted` 回执多记一项 `companionJobTree`，取自 bundle 答复的 `jobTree`。
- 宿主自己还没结束时，companion 的 Runner 仍然 busy，不发心跳，下一批不会开始（既有闸门）。

### 24.5 没有做的，以及理由

- **`build-bundle.ps1` 自设总时限**：不需要。宿主在每个子进程的时限到点时结束它的整棵树，覆盖 bundle、`-CheckRefs`、工作区准备、relay、gh。卡住的传输按 Task `4d3aaa64`（§10.1）约 60 秒就会由低速超时先处理。脚本自设时限只能多报一个阶段名，却要改 Source v2、要重装 Source，所以没做。本改动不动 Source v2：安装记录和 `ciSourceManifestSha256` 都不变。
- 第 1 段失败后的释放（`NOT_ADMITTED` 等），仍然两端归档，没有改。
- 第 1 段之前的安全点上，Owner 中止仍要 companion 的静止证明和 `archive-linux`（`executor.mjs`，Owner 中止的结束步骤），没有改。有了宿主，companion 在这时也总能回答。
- 崩溃恢复对未终结批次仍然 HALT（`EXECUTOR_RESTARTED_WITH_OPEN_BATCH`），没有改。
- **残余**：
  - `tree: 'unconfirmed'` 之后 companion 照常往下走。依据是作业已经终止并随宿主关闭，这是内核的保证，不是观察到的事实。
  - `archive-linux` 在 companion 里最坏是 5 分钟加 30 秒，再加排空，可能超过服务的 6 分钟。超过时服务按没有答复处理，结局和原来一样。

### 24.6 安装与生效

- `install-resident.ps1` 的 `service-hosts` 步骤：
  - 从已安装的常驻副本 `resident\<sha>\windows\CompanionJobHost.cs` 编译 `bin\CluedCompanionJobHost.exe`；
  - 编译器与其他宿主相同，参数和通用助手一样（`/target:winexe /platform:x64`，只引用 `System.dll`）；两个服务宿主是 `/target:exe`；
  - 回执记 `companionJobHostSha256`，安装计划多一项 `companionJobHost`；
  - `verify-resident.ps1` 核对这个哈希；
  - `windows/test-job-host.ps1` 用同一组参数编译，并逐字核对安装脚本的编译行、回执钉值和 verify 那一行。
- companion 用固定路径 `<root>\bin\CluedCompanionJobHost.exe`，`companion.json` 不变。找不到宿主时 companion 不启动（`COMPANION_JOB_HOST_REQUIRED`），所以宿主和 companion 必须一起装。
- 要重装 Windows 常驻包才生效。Source v2 和 Linux 都不用重装。
- 安装后的核验：在 Owner 自己的非提权会话里跑一次 `windows/test-job-host.ps1 -Wsl`，这和 companion 的环境只差计划任务那一层作业。`test-job-host.ps1` 第 4 步把联机用例再跑一遍，这次 node 本身就跑在外层宿主的作业里（`IsProcessInJob` 为真，`CREATE_BREAKAWAY_FROM_JOB` 报错误 5），每个内层宿主都要在这层作业下面建子进程。
- `verify-resident.ps1`：没有这项钉值或没有宿主 exe 的安装（§24 之前装的），这一项记 false，不会让整个 verify 抛异常中断。
- `uninstall-resident.ps1`：改名常驻目录之前，除了已安装的 node，也等 companion 的作业宿主结束。宿主随 node 的作业关闭而结束，但这是异步的。

### 24.7 测试

- `test/job-host.test.mjs`：
  - 报告只认最后一行、这个 nonce、恰好这些字段；
  - 自己结束时退出码、输出原样，报告从 stderr 去掉；
  - 超时并排空后 Runner 立刻空闲，下一个子进程马上开始；
  - 排空没确认、没有报告、没起子进程（含建了没确认结束的）、退出码对不上、报告带失败码、nonce 不对，各自给出该有的 `tree` 和拒绝码；只有自己结束的子进程才会是 code 0；
  - stderr 超过 4 MiB 仍能找到报告；
  - 宿主超过时限加 60 秒时，Runner 只结束宿主，并且在宿主结束前保持 busy；结束被拒绝时同样保持 busy；宿主没起来时立即空闲；
  - 时限越界、宿主路径不对，什么都不起；
  - 服务的 Runner 照旧不杀、超时后 busy；
  - `lane` 在一次超时之后继续回答；
  - companion：超时的 bundle 答 `jobTree: 'zero'`，同一轮里 `linux-quiescence` 用 root 工具的事实回答；relay 超时后 blocked 转交只发一次；
  - 答复 `/2` 的 `jobTree` 只收三种值；服务端口把它原样传给执行器；
  - 执行器：第 0 段失败只关 Windows，不向 companion 要任何东西。即使 `archive-linux` 和静止证明都会失败，也照样干净释放、不 HALT，回执带 `companionJobTree`。第 1 段之前被取代同样只关 Windows。
  - 启动探针：真跑了、排空了才算；没报告、没起子进程、没排空、退出码不是 0 都拒绝启动。
- 联机用例（`CLUED_JOB_HOST_EXE` 指向编译好的宿主时运行）：
  - 参数逐字到达，输出和退出码原样；
  - 超时的子进程和孙进程都结束，Runner 随即能跑下一个；
  - 子进程退出后留下的孙进程（包括 detached 的）也结束，作业外的进程照常运行；
  - powershell 跑 git，连到一个只接受、不回应的本地端口卡住：到时限整棵树结束，那个 git 不在了；
  - `-Wsl` 时还跑真实的 wsl（含超时的 `sleep 30`）、powershell 和 git。
- `windows/test-job-host.ps1`：解析三个脚本；核对安装与校验脚本里的那几行；用安装时的参数编译宿主；参数不对时退出码 120 并写报告；原样转发；再带联机用例跑上面的 node 测试；skipped 数必须找到；联机用例嵌套在外层宿主里再跑一遍；核对卸载会等宿主。
- 另做过一次探针：作业里的子进程读到的作业标志是 `0x2400`。

### 24.8 独立审核

第 1 轮（新上下文、只读，审 `b4377086`）：有条件 PASS，没有 BLOCKER。x64 结构体布局、句柄名单、失败路径（不会恢复不在作业里的子进程，不会误报成功）、引号还原、服务 Runner 不变、第 0 段 `linux:false`，都核对无误。修正如下：

- MAJOR：安装与校验的改动必须和本改动进同一个 PR；“编译参数与其他宿主相同”不对，已改为与通用助手相同。
- MINOR：
  1. 作业标志补上 `DIE_ON_UNHANDLED_EXCEPTION`，否则崩溃会变成慢超时；
  2. 原先挂起的子进程在 `CreateProcess` 和 `AssignProcessToJobObject` 之间不在任何作业里。宿主若恰在此时被结束，会留下握着管道的孤儿，lane 又会停摆。已改为 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 直接建在作业里，再用 `IsProcessInJob` 核实；
  3. Runner 在结束宿主被拒绝时不再清 busy；
  4. 文档：§6.2、§16 和附录 A 里“companion 的 Runner 从不杀子进程”的说法一起改；`unconfirmed` 的来源写全；Task `4d3aaa64` 尚未合入；Linux 一侧和 relay 规则被覆盖的事实；Owner 中止仍要 companion；stderr 的 4 MiB 与 4 KB。
- NIT：排空时重复终止作业；没起来的子进程没确认结束时保留 `tree`；为 stdout、stderr 新建的 NUL 句柄已关闭。

第 2 轮（新上下文、只读，审 `d3c155b9`，与 main `f0a401d4` 比）：PASS，没有 BLOCKER 或 MAJOR。第 1 轮的修正都在代码里，并且正确。与 main 的合并（C1a/C1b 节点档案、3c-1、邮箱 torn-read 修正）解冲突正确；安装、计划、回执、verify 一致。审核另外实测：wsl 被结束后 Linux 一侧的进程（包括孙进程）都不在了；node 在外层宿主的作业里时，内层宿主照常工作。修正如下（在 `23f31976`）：

- MINOR：verify 遇到 §24 之前的安装记 false，不抛异常；companion 启动时经宿主跑一次探针。
- NIT：卸载等待宿主结束；jobTree 各个取值的条件写准；skipped 数必须找到；联机用例嵌套再跑一遍。
- 没有改的：stderr 到 4 MiB 上限时可能留下半行报告，只影响外观。

## 25. 中继稳健：逐次分类、有界重试、本地日志（Task `241de382`，设计 r3 第一部分）

依据：常驻容错设计 r3（`DESIGN.r3.md`，sha256 `8d4627a2…3289`，三轮独立审核最终 PASS，KooYomi Note `178957cb`）第一部分；Owner Decision `7303ab04` 把它与 §24 放进同一个 PR、先装。只改常驻层（`src/companion.mjs`、`src/companion-main.mjs`、`src/engine-windows.mjs`、`src/failure-table.json`），不改 Source v2、`relay-public.ps1` 或 Linux 工具。

### 25.1 为什么

伴侣的 `relay()` 原来对“暂无记录”以外的任何失败都回 `RELAY_REFUSED_NO_RETRY`，泵随即放弃。Linux worker 等不到回调就自己退出，Windows 发行器等满段截止，以 `BRIDGE_RESULT_DEADLINE` 结束，常驻判 `PUBLICATION_UNCERTAIN` 并 HALT（10-21 #891，10-23 #911、#915、#918，10-28 #929、#928）。其中很多次只是一次 wsl.exe 或 VM 层的抖动，几秒内就失败了，再试一次就会成功。

### 25.2 每次尝试的分类（`classifyRelayAttempt`，表里没有的一律 PERMANENT）

| 类别 | 判定 | 处理 |
|---|---|---|
| OK | `code 0`，`PUBLIC_RECORD_TRANSFERRED`，`terminalConfirmed` | 返回 true |
| NOT_YET | `childError.reason ENOENT`，`terminalConfirmed` | 返回 false（不变） |
| NO_CHILD | runner `RUNNER_SPAWN_FAILED`；或 `JOB_HOST_UNCONFIRMED` 且没有 `tree` 键、没有超时；或回执 `PUBLIC_TRANSFER_UNCONFIRMED` 且 `processId`、`exitCode` 都是 null | 最多再试 1 次（可能是持久问题，如 spool 的 IO 或 ACL） |
| CHILD_FAILED | `PUBLIC_CHILD_EXIT_REFUSED_NO_RETRY` 且 `childError` 为 null（wsl.exe 或 VM 层，或 OOM）；或 `PUBLIC_CHILD_REFUSED_NO_RETRY` 且 reason ∈ {EBUSY, EMFILE, ENFILE, EINTR, FORMAL_RELAY_STDIN_TIMEOUT}、stage ∈ {OPERATION, CONTEXT, STDIN, TRANSPORT, PACKET} | 先做 §25.3 的核对；Send* 还要先确认 Linux 上没有残留的 relay-record |
| AMBIGUOUS | 作业宿主超时结束且 `tree zero`；`PUBLIC_TERMINAL_UNCONFIRMED_LOCKS_RETAINED`、`PUBLIC_OUTPUT_UNCONFIRMED_NO_RETRY`、`PUBLIC_STDIN_UNCERTAIN_NO_RETRY`；`childError.reason EEXIST` | §25.3：已到 → true；一半 → 永久失败；没到（Send* 还要求没有残留进程）→ 再试 |
| EXISTING | Receive* 的 `EXISTING_RECORD_PRESERVED_NO_RETRY` | 只有完整的同名记录才算已到，其他一律永久失败 |
| PERMANENT | 其余一切：身份、位置、清单类；`FORMAL_SPOOL_ACL_REFUSED`；`PUBLIC_PARENT_*`、`PUBLIC_INPUT_*`、`PUBLIC_READY_CHANGED`、`PUBLIC_RECORD_*`、`PUBLIC_IMPORT_UNCONFIRMED_NO_RETRY`；`childError` 的其他 reason，或 stage 为 BINDING、RECORD、COMPLETE；`tree unconfirmed`；runner 的其他拒绝；回执无法解析 | `RELAY_REFUSED_NO_RETRY`（码和失败表行都不变） |

- OK 与 NOT_YET 按字段读取，和改动前一样；可能导致重试的类别（NO_CHILD 的回执形状、CHILD_FAILED、AMBIGUOUS、EXISTING）还要求回执的 `contract` 是 `clued.independent-ci.formal-public-relay-receipt/2`，因为它们的安全论证依赖 /2 的语义。
- 作业宿主报 `tree unconfirmed` 时，即使回执写着已转移，也判 PERMANENT（设计 r3 §1.6：不在没证明结束的进程上叠新调用）。这比改动前严：改动前这种回执算成功。

### 25.3 到达核对与残留进程检查

一个记录名在一段里只用一次，两端都只新建、先写数据再写 ready，所以“到没到”直接看目标：

- Receive*：Windows `formal-spool\incoming`（现有的 `fileExists` 端口）。数据与 ready 都在 = 已到；都不在 = 没到；其他 = 一半。
- Send*：Linux `formal-spool/incoming`，新增固定 argv `ls -1 -A -- /var/lib/clued-independent-ci/formal-spool/incoming`。
- 残留进程：新增固定 argv `pgrep -f -a protected-job-bridge-v4/relay-record.mjs`。退出码 1 = 没有；0 = 2 秒后再看一次，仍有就永久失败；其他退出码 = 永久失败。作业宿主结束了 Windows 一侧的 powershell 和 wsl.exe，但没有证明 Linux 一侧的 relay-record 也随之退出，所以每次 Send* 重试前都查。
- 一半的记录：新码 `RELAY_PARTIAL_RECORD_PRESERVED`，加入 `PUMP_CODES` 和失败表（halt，`owner-rearm`，与 `RELAY_REFUSED_NO_RETRY` 同行为）。不删、不覆盖。
- 核对本身失败（`ls`、`pgrep` 的非预期退出码，或子进程没有被证明结束）：不重试，按永久失败处理。两个新调用都走作业宿主，各 15 秒上限。

### 25.4 次数、超时与预算

每次尝试的超时仍是 `RELAY_TIMEOUT_MS`（120 秒），不缩短：在“数据已写、ready 未写”之间结束 relay-public 会留下一半的记录。所以只有失败得快的那一次后面才有时间重试。

| 调用 | 最多尝试 | 间隔 | 下一次只在 |
|---|---|---|---|
| `SendIssue`、`ReceiveResult`、`ReceiveBlocked` | 3 | 3 s、8 s | 距段截止（请求的 `deadline`）还有 ≥ 150 s |
| `ReceiveChallenge` | 2 | 3 s | `now ≤ firstSeen + 120 s − 60 s` |
| `SendResponse` | 2 | 2 s | `now ≤ 挑战记录自己的 deadline − 15 s` |

- 任何调用的重试都不会在段截止之后发起：那时服务已不再等这个答复。
- `firstSeen`：泵第一次在 Linux outgoing 里列到这个挑战的时刻；记下后不再改，之后某次列表失败也照用。从没列到过（列表一直失败）时，用这次调用开始的时刻代替。估错只会让应答晚到（发行器有“迟到”处理），影响的是活性，不是安全。
- `SendResponse` 的预算读 Windows incoming 里那条挑战记录的 `deadline` 字段（公开字节，只读这一个字段，只用来决定要不要再试）；读不到就不重试。
- 每次尝试前都先做取消检查（Owner 中止优先）。泵里的 `ReceiveBlocked` 只有在永久失败后才记为“已拒绝”；只是重试用完时，失败后的“交出 blocked 记录”仍会再试一次。
- 没有给预算的调用（例如测试或将来的新调用）不会重试。

### 25.5 本地日志

- 每次尝试一行：`{at, mode, seq, attempt, ms, runner:{code, timedOut, tree, refused}, receipt:{status, failureCode, exitCode, processIdPresent, terminalConfirmed, childError}, class, stderrTail}`。只记码与计数；码不合格式的字段记为 null。
- `stderrTail`：powershell stderr 的尾部，最多 512 个字符，只留可打印 ASCII，`C:\Users\<名>` 换成 `%USERPROFILE%`，32 位以上的十六进制串换成 `<hex>`，40 位以上像 base64 的串换成 `<b64>`，连续空白折成一个。
- 位置：Owner 自己的配置目录 `%LOCALAPPDATA%\CluedIndependentCI\companion-log\relay-YYYYMMDD.jsonl`（UTC 日期），与 PR 页面状态的本地记忆同处。
  - 这与设计 r3 §1.5 写的 `resident\companion-log` 不同：伴侣不提权，常驻目录只由安装器和服务写；放在 Owner 目录下不必改安装脚本和 ACL。
- 只追加；单个文件到 2 MB 时写一行 `LOG_TRUNCATED` 后当天不再写；每天第一次写时删除 14 天以前的文件。日志写失败一律忽略，从不影响判断。
- 邮箱的应答合同不变，泵失败时的答复码不变；要查原因看这份日志。

### 25.6 不变的

- 不增加任何发布路径，不碰 GitHub，不用 App 凭据。
- 不杀 Linux worker；Windows 一侧只由作业宿主结束伴侣自己起的子进程（§24）。
- 失败表仍是白名单。新码不进 `classify.mjs` 里与 Source 镜像的数组。
- 不需要 Source 或 Linux 工具重装；随 §24 一次常驻层 Windows 重装（Owner 一次 UAC，同一次 UAC 重签 policy 文件里的 `residentManifestSha256`）。

### 25.7 测试与残余

- `test/relay-retry.test.mjs`：分类表逐行（含“看起来相近但带 `tree` 键的 `JOB_HOST_UNCONFIRMED`”和 BINDING 段的 EBUSY 都是 PERMANENT）；三类预算的边界；Send* 的残留进程与到达核对（含核对本身失败）；一半的记录；EXISTING；NO_CHILD 只重试一次；取消优先；日志的字段、脱敏、2 MB 上限与 14 天清理；泵里 `ReceiveBlocked` 用完重试后仍能交出 blocked 记录。
- `test/job-host.test.mjs`：“一次中继调用超过上限”改为超时真的耗掉 120 秒、Windows incoming 里没有记录，结果仍是 `RELAY_REFUSED_NO_RETRY`。
- 离线演练新增 `relay-flap-under-load`：第 3 轮 `ReceiveChallenge` 第一次 2 秒内失败，第二次成功，泵答 ok，这一段成功，不 HALT。
- 残余：
  - 像 10-28 #929 那样 wsl.exe 卡满 90 秒的，这里救不了，交给设计 r3 第二、三部分。
  - `pgrep` 不存在或误配了别的进程：检查失败或判“有残留”，都按不重试处理，与改动前相同。
  - 伴侣的“已到达”判断只用来少跑一次中继；记录的真假仍由两端各自校验。

## 26. 通道断了就快速结束：泵观察者、桥停止、信号 A–D（设计 r3 第二部分）

依据：常驻容错设计 r3（`DESIGN.r3.md`，sha256 `8d4627a2…3289`）第二部分，以及最终复核 `REVIEW.r3.md` 的 MINOR 1。只改常驻层（`src/engine-windows.mjs`、`src/companion.mjs`、`src/companion-main.mjs`、`src/mailbox.mjs`、`src/executor.mjs`、`src/classify.mjs`、`src/failure-table.json`），不改 Source v2、`relay-public.ps1` 或 Linux 工具。设计稿引用的是 main `f0a401d4` 的行号，代码已因 #933、#934 移动，以下全部按名字定位。

### 26.1 为什么

10-28 #929：第 2 段第 3 轮中继失败后，泵在约 2.5 分钟内就答复了失败，worker 两分钟后无记录退出，可 Windows 发行器一直等到 45 分钟的段截止，最后 `PUBLICATION_UNCERTAIN` → HALT。引擎要等阶段子进程整个结束才读泵的答复；伴侣的心跳在泵运行期间又一直不更新。

### 26.2 四个信号

| 信号 | 谁发现 | 条件 | 泵代码 |
|---|---|---|---|
| A 泵死了 | 引擎的泵观察者 | 泵以 `ok:false` 答复，代码属于 `PUMP_DEAD_CODES`（`PUMP_CODES` 以外的码按 `COMPANION_PUMP_UNCONFIRMED` 算）。不含 `FORMAL_WORKER_TERMINAL_UNCONFIRMED`、`COMPANION_PUMP_CANCELLED` | 泵自己的码 |
| B worker 跑过并结束，却没留记录 | 伴侣的泵 | 有“跑过”的证据，且 unit 现在是 `inactive`/`failed`，并且之后这次列表里既没有 blocked、result，也没有待搬的挑战 | `LINUX_WORKER_ENDED_WITHOUT_RECORD` |
| C worker 一直没启动 | 伴侣的泵 | `start --no-block` 后 5 分钟，既无证据，也从没列到过任何记录 | `LINUX_WORKER_NOT_STARTED` |
| D 伴侣挂了 | 引擎的泵观察者 | 泵没答复，心跳超过 `PUMP_HEARTBEAT_STALE_MS`（120 s）没更新（从本段开始算起） | `COMPANION_HEARTBEAT_LOST` |

- **B 的证据**（处理设计审查 MAJOR 1）：新固定 argv `unitFacts` = `systemctl show --property=ActiveState,InvocationID,ExecMainStartTimestampMonotonic <unit>`，按 `KEY=VALUE` 逐行解析，替代原来只读 `ActiveState` 的 `activeState`（泵结束后的“worker 已终止”核对也改用它）。证据任一即可：看到过 `activating/active/deactivating`；`failed`；`InvocationID` 非空且启动时间 > 0；本段已搬过挑战。泵自己记住“跑过”（unit 结束后可能被回收）。启动后立即查一次，之后每 15 s 一次。单独的 `inactive` 永远不算结束。
- **列表必须是结束之后取的**：先读 unit 事实、判定结束，再列 Linux outgoing；这时列表就是定论。列表失败（`null`）不算定论。列表里还有 blocked、result 或下一个挑战的，照常搬运。
- **D 的心跳来自独立定时器**：`companion-main.mjs` 的 `startHeartbeat()` 每 10 s 调一次 `mailbox.beat()`，整个包在 try/catch 里，永远不抛进泵或 lane；`step()` 开头那次也包住了。**只在 `probeJobHost` 成功之后才启动**（复核 r3 MINOR 1：作业宿主不能用就没有心跳，执行器就不开批）。
  - 代价（复核 r3 已接受）：心跳不再反映 mailbox lane 是否卡住，执行器 `heartbeatMaxAgeMs` 的开批前检查也看不出 lane 卡死；每个子进程都被作业宿主限时（§24），所以 lane 不会无限卡住。
- **D 先写取消，再停**：观察者先给这个 `relay-stage` 请求写取消（原因 `heartbeat-lost`），写成功才认定 D；被计划任务重启的伴侣看到取消，泵一开始就回 `COMPANION_PUMP_CANCELLED`，不开第二个泵（`pump()` 开头新增一次取消检查）。

### 26.3 泵观察者与桥停止（`engine-windows.mjs`）

- `invoke()` 发出 `relay-stage` 后，`observePump()` 与阶段子进程并行运行，每 `BRIDGE_POLL_MS`（5 s）读一次泵的答复和心跳。它只读写邮箱和 broker 的文件，不起任何进程（服务的 Runner 正忙着跑阶段），只对第 2/4/6 段启用。
- A 或 D 之后**宽限 `BRIDGE_STOP_GRACE_MS`（60 s）**，阶段仍在跑，就每轮调用 `bridgeStop()`，直到读到 broker 的回执。
- `bridgeStop()` 与 Owner 中止的 `requestStop()` 共用新抽出的 `stageStop()`：找到本批本段唯一在途的 swap，只新建 `.stop`（已存在即同一个停止，所以两者交错只会有一个 stop 文件），记住它，读 broker 回执。`bridgeStop()` **不**写 `80-owner-abort`，**不**置中止标志，**不**取消泵。
- 阶段结束后的结局：
  - 被桥停下，broker 回执 `STOP_SENT`，阶段事实的 Windows 进程树为零，**并且发行器没有绑定 outcome**（阶段码 `STAGE_OUTCOME_MISSING`）：`BRIDGE_STAGE_STOPPED_PUMP_LOST`；
  - 停止送达的同一刻发行器已绑定 outcome：保留 outcome 自己的码（实现审核 MAJOR 1）。“永不干净”的码不能借改写变成可收尾的结局，干净的码也不必再过静止证明；
  - 发行器自己先结束了：它自己的码；
  - 其他：阶段事实的原码。
  - 这一段若有 Owner 中止（`requestStop` 已被调用），一律保留阶段自己的码，由中止路径决定（Owner 中止优先）。
- **桥事实**随结果返回，写进 `stage-terminal` 回执：`bridge: { pumpCode, stopRequestId, stopCode, stageCode, pumpQuiet }`。
- **泵安静**（推广 c18eac1d）：阶段没成功、泵还没答复时，写取消（原因 `stage-ended`），最多等 `PUMP_QUIET_MS` = `RELAY_TIMEOUT_MS + 60 s`。阶段成功时不取消，照旧等答复。D 已成立时不等（伴侣被视为已死），只看一眼。

### 26.4 邮箱、执行器、失败表

- `CANCEL_REASONS` = `owner-abort`、`stage-ended`、`heartbeat-lost`，写取消和读取消两侧都校验。伴侣对所有原因一样处理（停止中继，回 `COMPANION_PUMP_CANCELLED`）；只有账本里的 `80-owner-abort` 才走 Owner 中止。取消文件的合同 `/1` 不变。
- `mailbox.beat()` 改为同一时刻只写一次（定时器和 `step()` 都会调用，不再共用同一个临时文件）。
- **一个请求只开一个泵**（实现审核 MINOR 1）：伴侣开泵时先在 `responses\` 下只新建 `<requestId>.pump.json`（合同 `clued.independent-ci.resident-companion-pump-mark/1`）。伴侣在泵运行中（取消写下之前）重启，看到这个标记就回 `COMPANION_PUMP_UNCONFIRMED`，不再搬 issue、不再启动 worker；服务把它当泵死（信号 A）。标记写不出来也不开泵。`pending()` 和提示读取都不会把它当答复。
- **心跳定时器的位置**（实现审核 MAJOR 2）：在伴侣全部初始化（作业宿主探针、提示配置、状态配置与节点名、本地存储、keepalive）完成之后、两条通道开跑之前才启动，通道结束时清掉。入口出错直接 `process.exit(4)`，不会留下一个只发心跳、不干活的伴侣。
- 执行器在第 2/4/6 段的中止轮询里，从 `engine.bridgeState()` 读观察者看到的东西，各写一次回执 `bridge-pump-lost`、`bridge-stop-requested`；轮询没赶上的，阶段结束后按结果里的桥事实补写。
- 新码：`LINUX_WORKER_ENDED_WITHOUT_RECORD`、`LINUX_WORKER_NOT_STARTED`、`COMPANION_HEARTBEAT_LOST`（加入 `PUMP_CODES`），`BRIDGE_STAGE_STOPPED_PUMP_LOST`（阶段码）。失败表四行都是 `unknown/halt/owner-rearm/counts`；不进 `classify.mjs` 里与 Source 镜像的四个数组（交叉测试强制）。烧头、熔断计入、日额度不变、不进 attempt 2。
- `OWNER_ABORT_STAGE_ENDINGS` 加入 `BRIDGE_STAGE_STOPPED_PUMP_LOST`，与 `STAGE_OUTCOME_MISSING` 同样只在 `STOP_SENT` 时成立：Owner 中止若恰在桥停止结束阶段的同一刻被接受，不会因此变成 HALT；两台主机的静止证明照样要过。

### 26.5 与设计稿的差异（都是更保守或必要的补充）

1. **信号 C 多两个前提**：最近一次 unit 事实必须真的读到（读失败不算“没启动”）；Linux outgoing 曾经列到过任何记录就不再判 C。
2. **B、C 不做 blocked 交接**：B 的定论列表里没有 blocked，C 的 worker 没跑过，交接只会白等 150 s。
3. **桥事实多两个字段**：`stopRequestId`（回执要用）和 `pumpQuiet`（§27 第 5 条要用）。
4. **D 只在取消写成功后成立**；D 成立后，阶段结束时不再等泵答复；阶段若在 D 之后成功，结局码是 `COMPANION_HEARTBEAT_LOST`。
5. **回执由执行器写**：引擎没有回执端口（服务入口不在本次改动范围），所以 `bridge-pump-lost`、`bridge-stop-requested` 由执行器的轮询和阶段后的补写产生。
6. **`OWNER_ABORT_STAGE_ENDINGS` 加入 `BRIDGE_STAGE_STOPPED_PUMP_LOST`**（26.4 末条），设计稿没写，为“Owner 中止优先”在竞态下也成立。这个码只在“`STOP_SENT` 且没有绑定 outcome”时出现（26.3），所以中止接受它的范围与 M2 规则（`STOP_SENT` 下的缺 outcome）相同，没有扩大。
7. **泵标记**（26.4）：设计稿没有。没有它时，伴侣在 120 s 内重启会对同一请求再开一个泵（改动前就有的行为，不会发布，但可能 HALT）。
8. **两处比以前更保守，会 HALT**（实现复审第 2 轮 NIT）：伴侣写下泵标记后崩溃并重启，回 `COMPANION_PUMP_UNCONFIRMED`，按信号 A 停掉阶段；原来的 worker 若还在扫描，5 分钟内拿不到静止证明就 HALT（以前第二个泵也许能救回这一段，现在换成“一个请求只有一个泵”）。`STOP_SENT` 下阶段码若是 `STAGE_CHILD_TIMEOUT` 这类没有 outcome 的非 `STAGE_OUTCOME_MISSING` 码，保留原码并 HALT，不再改写成可收尾的结局。

### 26.6 测试

- `test/bridge-observer.test.mjs`：unit 事实的解析与证据；`inactive` 无证据不结束（MAJOR 1）；`activating` 后 `inactive` 且列表空 → `LINUX_WORKER_ENDED_WITHOUT_RECORD`，不做交接；`failed` 结束；结束但列表里还有 result、blocked 照常搬；列表失败不算定论；只有 `InvocationID` 不算；5 分钟无证据 → `LINUX_WORKER_NOT_STARTED`，事实读失败或列到过记录不判；泵死 60 s 内不写 stop、之后写且只写一个；`FORMAL_WORKER_TERMINAL_UNCONFIRMED`、`ok:true`、`COMPANION_PUMP_CANCELLED` 从不停止；第 1、3、5、7、8、9、10 段从不观察、从不停止；心跳 120 s 不更新 → 先取消（`heartbeat-lost`）后停止、之后不等；慢而健康的中继（120 + 60 + 15 s）不触发 D；泵安静的取消与上限；没有 `STOP_SENT` 不改码；与 Owner 中止两种顺序交错都只有一个 stop 文件、中止优先；重启的伴侣看到取消不开第二个泵；重启的伴侣在取消之前看到泵标记也不开第二个泵，标记写不出来不开泵；三个取消原因两侧校验；心跳定时器、`beat()` 不重叠、`step()` 的 beat 失败不影响答复；定时器在探针和全部初始化之后启动、随通道结束清掉，入口出错直接退出；停止送达时已绑定 outcome（“永不干净”的码、干净的码、带 outcome 的缺 outcome 码）保留原码；Owner 中止在引擎读过中止状态之后、桥停止结束阶段时才被接受：只有“`STOP_SENT` 且缺 outcome”算干净的中止结局，已绑定的“永不干净”码照旧 HALT。
- 已有的伴侣测试里，`ActiveState` 的模拟输出改成 `KEY=VALUE` 三行。
- 离线演练 `incident-20261028-replay`（见 §27.6）：中继失败到阶段结束 217 s（不超过 5 分钟）。

## 27. 自动收尾：证明没发布就干净结束（设计 r3 第三部分，Task `d2974298`；Owner Decision `eaa7d5e4`）

依据：设计 r3 第三部分；Owner Decision `eaa7d5e4` 选了 O-2（第 2 段可以有一次自动 attempt 2），不做 4b、4c 和只读 GitHub 探针。只改常驻层，不需要 Source、不加第 11 段、不读 GitHub、不加 policy 开关。

### 27.1 为什么能证明没发布

第 2/4/6 段唯一运行的 Windows 进程是扫描发行器，它没有写 Check 的口；Linux worker 没有 GitHub 凭据；签名结果只能经同一批次的第 3/5/7 段变成检查，执行器进了 `fail()` 就不会再跑它们。所以“有没有发布”只依赖这些结构事实，加上伴侣伪造不了的 Windows 事实（broker 的 `STOP_SENT`、helper 原生回执的作业树为零、服务自己的 SCM 读回）。Linux 静止只决定能不能马上开下一批，与今天所有带 Linux 的 `FAILED_CLEAN`（包括 Owner 中止）同一信任等级。

### 27.2 触发条件（全部满足才走；`classify.mjs#scannerAbandonEligible` 加执行器自己的检查）

1. 第 2/4/6 段，phase 为 `stage`。
2. **先看泵代码**：`bridge.pumpCode` 不属于 `PUMP_CODES_UNPROVABLE` = `COMPANION_HEARTBEAT_LOST`、`COMPANION_REQUEST_EXPIRED`、`COMPANION_HANDLER_UNCONFIRMED`，不论阶段码是什么（为 null 时不受限）。
3. 失败码属于 `SCANNER_ABANDON_ENDINGS`：`PUBLICATION_UNCERTAIN`；`STAGE_OUTCOME_MISSING` 和 `BRIDGE_STAGE_STOPPED_PUMP_LOST`（仅当 `stopCode === 'STOP_SENT'`）；阶段成功但泵没确认时的 `RELAY_REFUSED_NO_RETRY`、`RELAY_PARTIAL_RECORD_PRESERVED`、`COMPANION_PUMP_UNCONFIRMED`、`FORMAL_WORKER_TERMINAL_UNCONFIRMED`、`LINUX_WORKER_ENDED_WITHOUT_RECORD`。这些码在失败表里全是 halt 行，所以它从不改动一个本来干净的判定。
4. 阶段自己的证明 `windowsTreeZero && serviceOriginalStopped`。
5. 泵已安静（`bridge.pumpQuiet`：答复过，或取消后答复了）。
6. 当前没有 HALT、`driftCode()` 为空、账本条目是 `STARTED` 且不在中止或自我中止路径上。没有桥事实一律不走。

### 27.3 流程（与 `ownerAbort` 共用 `provenCleanEnd()`）

在 `fail()` 里，失败表判为 UNKNOWN、头已烧（`fail()` 前面已烧，这里不再烧）之后，满足 27.2 就改走 `abandonScannerStage()`：

1. `abortQuiescence()`：最多 9 次、间隔 20 s、总共不超过 5 分钟。不完整 → `unknown(原码, 'scanner-abandon-quiescence-unproven')`，HALT，现场不动。
2. 归档：Windows 与 Linux 都只改名，原因段固定 `scanner-abandoned`；未确认 → `FAILURE_ARCHIVE_UNCONFIRMED`，HALT。
3. 终结记录 `FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED`，facts：`originalCode、outcomeReason、pumpCode、stopCode、stageCode、stage（数字）、basis: 'scanner-abandon-quiescence-proven'、batchId、windows、linux、class、retry、breaker`；回执 `batch-terminal`（`class: environment`）。
4. 第 2 段：一次自动 attempt 2（O-2）。

`ownerAbort` 与它共用 `provenCleanEnd()`（静止 → [烧头] → 归档 → 终结 → 回执），中止的行为不变（回归测试覆盖）。崩溃安全：终结记录写下之前任何一处崩溃，账本都是“STARTED 没有终结”，下一个 tick 的恢复照旧判 UNKNOWN 并 HALT，不需要意图文件。

### 27.4 失败表、attempt 2、executed-heads、额度

- 失败表两行：`BRIDGE_ABANDONED_UNPUBLISHED` 第 2 段 `environment/burn/attempt2/counts`，其他段 `environment/burn/new-commit/counts`。
- attempt 2（Owner Decision `eaa7d5e4`，O-2）：常驻层白名单 `ATTEMPT2_RESIDENT_CODES = { BRIDGE_ABANDONED_UNPUBLISHED: [2] }`，`attempts.mjs#attempt2Decision` 据此放行，仍要求 attempt 1、`FAILED_CLEAN`、没有已转发的角色；`classify.mjs` 的失败表校验相应放宽：这个码只有在“恰好是名单所列段”的行上才可以写 `attempt2`。第 4/6 段永远不进 attempt 2，attempt 2 自己也不会再有 attempt 3。
- executed-heads：第 2 段 → `mayHavePublished` 为 `published:false`（换 Source 后可重跑；同 Source 下账本已烧头）；第 4/6 段 → `true`（第 3 段已发布，执行器在第 3 段前已记录）。
- 熔断计入；日额度不变；自动逻辑只决定写不写 HALT，从不写或清除 `HALT.json`。

### 27.5 与设计稿的差异

1. **白名单放在 `classify.mjs`**：设计稿说放在 `attempts.mjs`。`attempts.mjs` 引用 `classify.mjs`，而失败表在 `classify.mjs` 加载时就要用到这个名单，放在 `attempts.mjs` 会形成加载环。`attempts.mjs` 照样导出它，判定也在 `attempts.mjs`。
2. **“当前没有 HALT”的检查**用 `ledger.halted()` 读取，与每个 tick 开头的读取完全相同。设计 §5 第 3 条说自动逻辑“从不读写或清除 `HALT.json`”，这里理解为不写、不清除；这次读取只会让它更保守（有 HALT 就不走，照旧 HALT）。
3. **状态板**：`status.json` 的合同 `/5` 只放码，不放文字，所以没有改 `status.mjs`；最近结局里就是 `FAILED_CLEAN` + `BRIDGE_ABANDONED_UNPUBLISHED`（`class environment`，第 2 段 `retry attempt2`）。PR 页面的文字在 `pr-status.mjs`，不在本次改动范围；它现有的 `FAILED_CLEAN` 文字已带上这个码（第 2 段显示“将自动第二次尝试”）。如需专门的“已证明未发布，干净结束”一句，另开一个小改动。
4. 回执多一个字段 `originalCode`，终结记录多 `stageCode`、`class/retry/breaker`，便于事后查。
5. **烧头记录里的码**（实现审核 NIT 1）：`fail()` 在判断能否收尾之前就烧头，烧头记录（create-only）的 `failureCode` 是当时的原码；收尾成功时终结记录是 `BRIDGE_ABANDONED_UNPUBLISHED`，其中 `originalCode` 等于烧头记录的码，两处按它对应。收尾过程中抛异常时，HALT 用异常的码（与其他失败处理的“未确认”路径相同），原码留在 HALT 的 context 里。

### 27.6 测试

- `test/scanner-abandon.test.mjs`：资格矩阵（11 段 × 23 个码 × 3 种 stop 码 × Windows 一半 × 泵安静 × 6 种泵码），泵码优先；新码都不在 Source 镜像数组里；10-28 结局在第 2 段 → `FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED`、归档 `scanner-abandoned`、`mayHavePublished=false`、回执齐全、一次 attempt 2；attempt 2 跑一次，再收尾也没有 attempt 3；第 4/6 段不进 attempt 2、`mayHavePublished=true`；5 分钟内静止不成立 → HALT 且保留原码；归档失败 → HALT；已 HALT、字节漂移、泵不可证明、泵没安静、没有 `STOP_SENT` → 都 HALT，`clearHalt` 从未调用；在静止、Windows 静止、静止轮询的等待、两边归档、终结记录各处注入崩溃 → 下一个 tick 恢复时 HALT；Owner 中止回归与优先。
- `test/failure-table.test.mjs`：交叉测试改为“attempt2 恰好属于临时码，或白名单码在其所列段上”；新码有覆盖所有段的行。
- 离线演练，真实的伴侣泵、邮箱、Windows 引擎和执行器跑在虚拟时钟上：
  - `incident-20261028-replay`：第 3 轮 `ReceiveChallenge` 卡 90 s 后失败，泵答 `RELAY_REFUSED_NO_RETRY`，60 s 宽限后桥停止，`FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED`，没有 HALT，排了一次 attempt 2；
  - 变体：worker 一直 active → 静止证明在 5 分钟上限内不成立 → HALT，保留原码；
  - 变体：伴侣在失败时挂了 → 心跳过期、写 `heartbeat-lost` 取消、桥停止、快速 HALT，不走收尾。

## 28. 第 8 段零副作用临时失败不烧头（设计 r3 4a，PR #930）

依据：设计 r3 §4.3（4a）；Owner Decision `eaa7d5e4`：3 次、间隔 1/3/10 分钟，写死在代码里（不升级 policy 合同）。另含复核 r3 NIT 2。

### 28.1 规则（`executor.mjs#stage8Try`）

- 与 `STAGE8_NOT_READY_CODES` 并列新增 `STAGE8_TRANSIENT_PARK_CODES` = `NATIVE_ADMISSION_UNAVAILABLE`、`GITHUB_TRANSIENT_UNAVAILABLE`。
- 条件：现有的 `zero`（`BLOCKED`、`sideEffects 0`、`mayHavePublished false`、Windows 一半证明）、码在表里、不满足 `final`、此前临时停车少于 `STAGE8_TRANSIENT_MAX_TRIES`（3）次。
- 满足就停在 B 点：间隔 `STAGE8_TRANSIENT_RETRY_MS` = 1、3、10 分钟；第 4 次走今天的 `fail()`（烧头，计入熔断），最坏情况与今天一样。
- 每次停车：`kind 'parked'`、`klass 'transient'`、`breaker 'neutral'`；回执 `stage8-transient-parked`。照样计入 `stage8MaxTries`、`park.maxMs`、`stage8RetriesPer24h`，这些先到就按现有规则结束。
- 安全性同设计：同一批次、同一个封装好的第 8 段包、每次新 nonce；某次失败若其实在 `journal.begin` 之后，下一次试读到没 settle 的条目回 `RECONCILIATION_REQUIRED`，HALT；认领代变了是 `BATCH_CLAIM_CHANGED`。

### 28.2 队列位置（复核 r3 MINOR 3、NIT 2）

- `72-tried` 记录的 `position` 写真实值（临时失败时为 null），所以这次试照常计入次数，也不会被当成队首试。
- 另记 `transient: true` 和 `assumedPosition`：真实值有就用真实值，否则取上一次试的位置，再否则取上一次的 `assumedPosition`，都没有就填 1（按设计 §4.2，这个结局只会在判定已到队首之后出现）。它只用于两件事：豁免 `maxParkedOutsideTop2` 的容量检查；状态板显示（PARKED 结果和队列行的 `queuePosition`）。
- `parkedCounts()`（NIT 2）：临时停车的批次按 `assumedPosition` 计数（通常 1，算在前两名之内），不会把别的未就绪批次挤成 `PARKED_OVER_CAPACITY`。
- 代价照设计：一个临时停车批次的认领最多在合并队列队首占约 14 分钟（1 + 3 + 10 分钟加三次试各自的运行时间）。

### 28.3 与设计稿的差异

1. 回执用了新的类型名 `stage8-transient-parked`（与 `stage8-not-ready` 分开，便于数），并带 `assumedPosition` 和第几次停车。
2. `assumedPosition` 的取值链多了一步“上一次的 `assumedPosition`”：连续两次临时失败时，第二次的上一次真实位置是 null。

### 28.4 测试

- `test/park.test.mjs`：`NATIVE_ADMISSION_UNAVAILABLE`/`GITHUB_TRANSIENT_UNAVAILABLE` 依次停 1、3、10 分钟，第 4 次烧头；#930 重放（停 1 分钟后同一批次 `COMPLETED`，1–7 段只跑一次）；位置为 null 时沿用上一次或按 1，`maxParkedOutsideTop2: 0` 也不会 `PARKED_OVER_CAPACITY`，计数按假定位置；`sideEffects>0`、`mayHavePublished`、`UNCERTAIN`、Windows 一半缺失 → 不停车；`stage8MaxTries`、`maxMs` 先到 → 按现有规则结束；下一次试 `RECONCILIATION_REQUIRED` → HALT；认领代变化 → `BATCH_CLAIM_CHANGED`。
- 离线演练：#930 重放（PR 936：attempt 1 第 2 段 `REMOTE_REFS_CHANGED_SINCE_BUNDLE`，attempt 2 的第 8 段第 1 次 `unavailable`，停 1 分钟，第 2 次 `COMPLETED`）。

### 28.5 §26–§28 共同的安装与不变量

- 只需一次常驻层 Windows 重装（与 §24、§25 同一次即可；同一次 UAC 里重签 policy 文件的 `residentManifestSha256`），不碰 policy 合同、Source 或 Linux 工具。
- 不增加发布路径；证明不了就 HALT；自动逻辑不写、不清除 `HALT.json`；不增加 GitHub 读写，不在新地方用 App 凭据；不杀未知进程（Linux worker 照旧不被结束，Windows 侧只用审过的 broker 停止通道）；executed-heads 只增不减；失败表仍是白名单。

## 29. 主备 C3：节点模式与 NODE_ROLE_NOT_HELD（Task `17b703a0`）

依据：《常驻执行器主备部署·设计说明 v0.4》§5.2、§8.2、§9 C3，以及 C3 方案草稿。C2（本文末节“C2”）已经有空闲时的角色探测，并留下一个输入口 `roleProbeMode`。C3 让执行器自己维护这个模式，并按它行动。代码：`src/executor.mjs`（`nodeMode()`、`setNodeMode()`、`nodeGate()`、`roleProbeMaintenance()`）、`src/role-probe.mjs`（`urgent`）、`src/classify.mjs`、`src/failure-table.json`、`src/ledger.mjs`、`src/status.mjs`；Source 一侧是 `resident-v2/stage-fact.mjs`。测试在 `test/node-mode.test.mjs` 等（§29.8）。

### 29.1 为什么

- 两个节点各有一个常驻执行器。同一时间只有持有 ci-admission 角色的节点能发布，这由服务端保证。
- C2 之前，执行器不知道自己有没有这个角色。C2 能探测，但探测结果不改变任何行为。
- 不当班的节点于是照样取触发、开批次，直到第 1 段才被拒。那个拒绝（`admission_binding_required`）被当成一般的未准入：占评估额度，占这个头的释放次数，和别的原因同时出现时甚至烧头。
- C3 之后，节点自己知道模式。不当班就不开批次，也不为此消耗任何额度。

### 29.2 规则

1. **三种模式**：`ACTIVE`、`STANDBY`、`UNCERTAIN`（`this.roleProbeMode`）。
   - 进程启动（包括重启）后是 `UNCERTAIN`，探测立即到期（`roleProbe.urgent`）。
   - Owner 复位（re-arm 清除了 HALT）之后同样回到 `UNCERTAIN`，探测立即到期。
   - `UNCERTAIN` 的行为等同 `STANDBY`。状态里写 `UNCERTAIN` 而不写 `STANDBY`，是为了 companion 在每次重启时不把“当班”改成“已交班”再改回来；C5 把它读成“停摆 NODE_ROLE_UNCERTAIN”，正好对应“刚启动，还没确认”。
2. **探测结果怎样改模式**：
   - held → `ACTIVE`；
   - not-held → `STANDBY`；
   - uncertain → 保持原模式。启动后还没有确定结果时，仍是 `UNCERTAIN`。连续三次不确定的通知是 C2 已有的。
   - not-held 是安全方向，先生效再写回执。held 要等探测结果回执写成之后才生效。
   - 每次模式转换写一条回执 `node-mode`（`from`、`to`、`why`）。回执写不出来不影响模式。
3. **不是 ACTIVE 时调度什么也不开**：不取排队行，不开 attempt 2，不做 waiting-retry。
   - `schedule()` 返回 `DEFERRED`，原因 `NODE_STANDBY` 或 `NODE_ROLE_UNCERTAIN`。
   - 这个结果算“安静”，探测维护（和第 10 段）照常运行。
   - 触发照常读进排队表，不丢。方案里的“不取新触发”，在这里的意思是不从队列取行去开批次，和暂停接新（§20）一致。
   - 在途批次照常续跑：停在 A 的批次每个 tick 照常判断，停在 B 的照常尝试第 8 段，去留由实时准入决定。停在 A 的批次仍是 tick 的结果，状态里的 `current` 也不消失（和暂停接新一样）。
4. **节点闸门排在暂停接新之前**，也排在“队列为空就是 IDLE”之后。所以不是 ACTIVE 的节点显示 `NODE_*` 的原因，探测不会被暂停接新挡住。空队列时仍是 `IDLE`。
5. **探测间隔**：`UNCERTAIN` 用 `STANDBY` 的 15 分钟，空闲的 `ACTIVE` 用 30 分钟；`urgent` 时不等。任何一次探测结果（包括 uncertain）都清掉 `urgent`，所以不确定时不会每个 tick 探一次。
   - 探测只在没有 HALT、没有暂停、没有批次正在跑某一段时进行。
   - **停在 A、B 的批次不挡探测，当节点不是 `ACTIVE`，或这次探测是 `urgent` 时**（`probeAtParking()`；2026-10-29 复核 M1）。空闲 `ACTIVE` 节点的定期探测保持 C2 的做法：账本里有任何打开的批次就不探。
   - 为什么可以：C2 要求账本里没有打开的条目，是因为探测要经交换代理切换一次 runner 服务，不能和正式的段抢。但 tick 是串行的，探测只在 tick 里运行，不会与本执行器自己的段重叠。停在 A、B 的批次没有进程，没有 broker 请求，Linux 是空的（§18.1）。不在停靠点的打开条目（崩溃现场）在每个 tick 开头已被恢复处理成 HALT，到不了探测这一步。
   - 为什么要这样：重启或复位之后，停靠的批次（最长 `park.maxMs`，24 小时）否则会让节点一直是 `UNCERTAIN`，拿不到任何新触发；§29.9 说的“单节点行为和以前一样”也不成立（第 2 批的重装本身就是一次重启）。
   - 定期探测仍不在停靠批次旁边运行，因为停靠可以很久，每 30 分钟切换一次 runner 会一直打断它。（第 12 代：排队观察例外，见 §56.2。）
6. **立即探测**：第 1 段以外的批次以下面这些码结束时，标 `urgent`，下一个安静 tick 就探测。
   - NOT_ADMITTED 家族的码（`PR_NOT_OPEN_OR_CHANGED` 在任何段都可能出现）；
   - `PUBLICATION_BLOCKED`；
   - `BATCH_CLAIM_CHANGED`（见 §29.7 第 5 条）。
   - 第 1 段的未准入不标：那是对 PR 的回答。`NODE_ROLE_NOT_HELD` 直接转 `STANDBY`。
7. **没有探测能力就没有模式**。只有引擎有 `runRoleProbe` 时（真实的 Windows 引擎有）模式才生效。没有的引擎（测试里的假引擎、离线演练）保持原来的单节点行为：没有闸门，状态里 `node` 为 `null`，不写 `node-mode` 回执。
8. 已知的限制（C2 起就有，C3 没改）：空闲 `ACTIVE` 节点在暂停接新期间如果队列里有行，tick 的结果是 `INTAKE_PAUSED`，这个结果不算安静，探测不运行。下一次实时准入仍然会决定。

### 29.3 NODE_ROLE_NOT_HELD

- **Source**（`resident-v2/stage-fact.mjs`）：
  - `NOT_ADMITTED_CODES` 末尾加 `NODE_ROLE_NOT_HELD`；
  - `notAdmittedCode` 把 `admission_binding_required` 排在第一位，映射到这个码。节点不当班时对 PR 什么也没说，不能因为同时有别的原因（例如 `protected_change_not_up_to_date`）就烧头；
  - `formal-work-admission-check-v2/publisher.mjs`（2026-10-29 复核 B1）：入口自己的“可重跑”标志 `safeToRerun` 原来在任何确定性 PR 码同在时都是 false，而常驻只认这个标志，所以 `NODE_ROLE_NOT_HELD` 与 `protected_change_not_up_to_date`（或 `changed_files_truncated`）同在时放不掉，头被烧。现在 `notOnDuty(reason, diagnostic)` 为真（原因是第一次评估的 `full_admission_rejected`，诊断里有 `admission_binding_required`）时，标志不再受 `deterministicPrFault` 影响（`refusalSafeToRerun()`）。
  - 这条路径上什么也没发布：被拒的是边界里的第一次评估（`step === 'boundary'`），没有记批次认领，真正的 effect key 下什么也没写（只有一条 diagnostic-only 的日志，用新 key，状态 `not_sent`），`sideEffects` 为 0，所以 `mayHavePublished` 为 false。发布者“知道不当班”的唯一办法就是 Native 的这条拒绝原因。
- **常驻侧**：
  - `classify.mjs` 的 `NOT_ADMITTED_CODES` 同样加在末尾（和 Source 逐项相同，交叉测试强制）；
  - 失败表：`NODE_ROLE_NOT_HELD` 第 1 段 `node-role / release-if-safe / new-trigger / neutral`；其他段和别的未准入码一样是 `clean-final`（第 1 段之后不会出现，但每个码在每一段都要有一行）；
  - 新的类 `node-role` 加进 `FAILURE_CLASSES_V1`；
  - `decideFailure` 对 `node-role` 行不再套“diagnostic 里有确定性 PR 码就改成烧”的覆盖。
- **账**：
  - `ledger.mjs#usage` 不把这种释放计入评估，也不计入这个头的释放次数，也不计入“新触发重评估”（`reevaluations`，每个提交每天 6 次；复核 m1）；
  - 执行器 `afterBatch` 同样不把它计入释放上限，所以这一行不会因此变成 `STOPPED`。
- **执行器**：失败表判为 `node-role`，节点就转 `STANDBY`。释放的条件不变（`release-if-safe`：要有阶段结果自己的 safeToRerun 或 broker 的未启动，要有 Windows 一半的证明）；没有这些时照旧烧，但节点仍然转 `STANDBY`，因为“不当班”这个事实不依赖那次释放。
- **兼容旧 Source**：新常驻配没有这个码的 Source 时，`admission_binding_required` 仍以 `NATIVE_NOT_ADMITTED` 加原因码到达。失败表在 `NATIVE_NOT_ADMITTED` 的最前面加一行：第 1 段、`reasonCodesAny: [admission_binding_required]`，同样是 `node-role`，节点转 `STANDBY`。同分时前一行优先，所以它排在“确定性 PR 码”那一行前面。
  - 头放不放，看旧 Source 自己的标志：只有这一个原因时标志是 true，放；与确定性原因同在时旧发布者的标志是 false，常驻只认这个标志，所以仍然烧头（和 C3 之前一样），节点照样转 `STANDBY`。这一点常驻一侧改不了，想要旧 Source 也不烧，只能装新 Source。（复核前的文字和测试说旧 Source 同在时也放，那是错的：真实的旧发布者写不出这样的事实。）
- **安装**：Source 的改动要随下一个被接受的 Source 一起装（Owner 闸门，不在本 PR 内）。

### 29.4 status.json 合同 `/6`

- `node` 现在是 `{ name, source, mode, probe }`：
  - `name`：`policy.node.nodeName`；
  - `source`：已安装的 `ciSourceManifestSha256` 的前 12 位十六进制，**这是 C3 新增的唯一字段**；
  - `mode`、`probe`（`at`、`result`、`failures`、`failingSince`）：C5 已有，C3 只是改由执行器维护。
- 启动时就写（`UNCERTAIN`，`probe` 为 `null`），不再等第一次探测。
- 读取一侧（`parseStatus`）**同时接受 `/5` 和 `/6`**，其他合同一律拒绝。
  - 两个合同的顶层键相同，`/6` 只在 `node` 里多一个 `source`，读 `/5` 不会读错东西。
  - 安装窗口里，新的 companion 可能先读到旧执行器写下的最后一份 `/5`。严格只认 `/6` 时它会通知“读不到状态”；同时认两个，它显示的是那份文件真实的内容（通常是 `STOPPED` 或已过期）。
  - 反过来，旧的 companion 读不了 `/6`，只会通知“读不到状态”，和以前每次升级合同时一样（§20.4）。这一边我们改不了。
  - 写的一侧只写 `/6`。
- `node-duty.mjs` 不检查合同号（它拿到的是 `parseStatus` 的结果），读法不变；`nodeOf()` 的返回值不变。`NODE_SOURCE` 正则放在 `node-duty.mjs`，`status.mjs` 引用，两边用同一个定义。
- 测试里 `parseStatus` → `nodeOf` → `stallCode` 对拍：启动时读成 `NODE_ROLE_UNCERTAIN`，探测 held 后是当班，not-held 后是 `STANDBY`。

### 29.5 N3：排空与熔断字段

- 不加新字段。熔断是 `status.breaker`（第二期 `/2`），暂停接新是 `status.intakePause`（C6 `/3`），C5 的 `node-duty.mjs` 判断“当班”时已经读这两项（`BREAKER_OPEN`、`INTAKE_PAUSED`）。
- 补的只是测试（`test/node-mode.test.mjs` 的 N3 一项）：
  - 熔断打开时执行器写出 `breaker`（状态、`openedAt`、`nextTrialAt`）；
  - 暂停接新和暂停（PAUSE）同时生效时写出 `intakePause`；
  - HALT 时两项仍在；
  - 每一步 `parseStatus` 之后 `stallCode` 都给出对应的“不当班”原因。
- **N3 以这些测试关闭**。

### 29.6 N2：运行中的节点最晚什么时候发现角色没了

| 情况 | 最晚发现 |
|---|---|
| 空闲的 ACTIVE | 30 分钟（空闲探测周期） |
| 跑批 | 当前段剩余的时间，加一次探测（约 1 分钟） |

- 实时准入只在段开始、签发、回调和第一次发布前发生。所以跑批的节点要等当前段结束才发现：扫描段最长 45 + 6 分钟，托管等待最长 60 分钟。
- 之后下一次实时准入失败，批次干净结束，§29.2 第 6 条标 `urgent`，下一个安静 tick 探测，转 `STANDBY`。
- 停在 B 的批次也不探测。它的下一次第 8 段尝试（退避最长 120 分钟）的实时准入失败后，批次结束，随后立即探测。
- **对外口径**：空闲 ≤ 30 分钟；跑批 = 当前段剩余时间（≤ 60 分钟）+ 一次探测（约 1 分钟）。
- **长段和等待托管期间不补探测**，理由：
  - 探测要用交换代理，会和正式阶段抢；
  - 这段时间里旧节点即使还在跑，也发不出新检查：下一次实时准入就被挡（设计 v0.4 §6.5 的 150 秒例外除外）；
  - 安全仍由服务端的角色加 5 分钟的等待保证，不靠这个探测。

### 29.7 与方案和设计的差异（给 C8 的设计文字修正）

1. **设计 §5.2 “最长约 45 分钟”要改**成 §29.6 的口径：空闲 ≤ 30 分钟，跑批 = 当前段剩余时间（≤ 60 分钟）+ 一次探测。
2. **排队行回到 QUEUED**（方案原文）实现为 `BACKOFF`。排队表的释放一律进 `BACKOFF` 并回到队尾（10、20、40 分钟），要得到 `QUEUED` 需要改 `queue.mjs`，不在本 Task 认领的文件里。差别很小：节点不是 ACTIVE 时，到期的行也只是被闸门挡住；回到 ACTIVE 后到期的行马上就能跑。这类释放不计释放次数，所以不会因它 `STOPPED`。如需改成 `QUEUED`，另开一个小改动。
3. **“不取新触发”**实现为不开新批次，触发仍读进排队表（§29.2 第 3 条）。理由：收件箱有界（每 tick 读 16 个），不读会让最旧的 16 个一直挡在前面；读进队列后，同一 PR 的新提交会取代旧的，重新当班时队列是新的。代价：重新当班的节点可能把对方已经跑完的提交再评估一遍，第 1 段的 GitHub 回读（C4，`HEAD_PUBLISHED_ON_GITHUB`）会干净地结束它们。
4. **UNCERTAIN 用 STANDBY 的 15 分钟间隔**，不是 C2 末节说的“没有 C3 输入时用 ACTIVE 的 30 分钟”。那句话在 C3 之后过时：节点现在总是从 `UNCERTAIN` 开始。
5. **立即探测的码多了 `BATCH_CLAIM_CHANGED`**。Source 把第 1 段之后被拒的实时准入（`full_admission_rejected`）映射为 `BATCH_CLAIM_CHANGED`（`outcomeFailureCode`），只列方案里的两类会漏掉最可能的那一种。猜错的代价是多一次只读探测。
6. **`parseStatus` 同时接受 `/5` 和 `/6`**（§29.4），方案只说 `/5 → /6`。
7. **失败表在 `NATIVE_NOT_ADMITTED` 前面多一行**，并且 `node-role` 行不受“确定性 PR 码改成烧”的覆盖（§29.3）。
8. **回执**：新增 `node-mode`；`role-probe-intent` 的 body 多一个 `urgent`。两者都不影响 C2 的恢复逻辑（它只读 `role-probe-intent` 和 `role-probe-result` 的 `intentSeq`、`state`）。
9. 第 10 段（合并列车维护）在 `STANDBY` 时仍可运行：它向服务端问自己是否当班，不当班就记 `NOT_ON_DUTY`，不需要模式再拦一次。

### 29.8 测试

- `test/node-mode.test.mjs`（26 项）：
  - 启动、重启、复位都从 `UNCERTAIN` 开始，探测立即运行，held 之前不取触发；
  - not-held → `STANDBY`，15 分钟间隔，后来 held 回到 `ACTIVE`；
  - uncertain 保持原模式（启动时仍是 `UNCERTAIN`，`ACTIVE`、`STANDBY` 各一）；
  - 没有探测能力的引擎保持单节点行为；
  - 第 1 段 `NODE_ROLE_NOT_HELD`（含与 `protected_change_not_up_to_date`、`changed_files_truncated` 同在，标志用真实发布者的 `refusalSafeToRerun` 算）和旧 Source 的写法：`STANDBY`、释放、不计评估和释放、连续三次也不 `STOPPED`、排队行进入 `BACKOFF`；没有 safeToRerun 时照旧烧但仍转 `STANDBY`；旧 Source 与确定性原因同在时（标志 false）烧头、仍转 `STANDBY`；
  - 第 1 段以外的 `PUBLICATION_BLOCKED`、`BATCH_CLAIM_CHANGED`、`PR_NOT_OPEN_OR_CHANGED` 之后下一个安静 tick 立即探测；第 1 段的未准入和无关的干净结束不触发；有批次停在 B 时：定期探测（`ACTIVE`、不 urgent）不运行，urgent 的探测运行；
  - `STANDBY` 时：停在 B 的批次照常尝试第 8 段并完成，停在 A 的批次续跑到完成且 `current` 不消失，新 PR 和到期的重试不开；到期的 attempt 2 和 waiting-retry 不开，回到 `ACTIVE` 后各自运行；
  - 状态 `/6`：`node` 的字段、`parseStatus` 与 `node-duty` 对拍、`/5` 仍可读、其他合同拒绝、不合格的 `source` 当作没有；
  - M1：重启、复位之后有批次停在 B 或 A，节点仍在下一个安静 tick 探测并离开 `UNCERTAIN`；
  - m1：node-role 释放不计新触发重评估；m2：node-role 释放的 attempt 2 退回同一个 attempt 2（同一个 key，没有 attempt 3），别的释放仍花掉它，账本的规则；
  - N3：熔断、暂停接新写出，暂停和 HALT 时仍在。
- `test/failure-table.test.mjs`：`NODE_ROLE_NOT_HELD` 与旧 Source 写法的失败表行和 `decideFailure`，事实经真实的 `refusalSafeToRerun`、`writeOutcome`、`outcomeFacts`；交叉测试（`attempts.test.mjs` 与本文件）要求两个 `NOT_ADMITTED_CODES` 逐项相同。
- `test/role-probe.test.mjs`：`urgent`。`test/status.test.mjs`：`setNode` 与 `/6`。
- 原有两项因 C3 改了：C2 的“探测不在批次中运行”要先把节点设成 `ACTIVE`（启动时是 `UNCERTAIN`）；失败表的“确定性 PR 码”一项按类找行。
- Source：`test/resident-v2-stage.test.mjs` 里 `notAdmittedCode` 的优先级与 `NODE_ROLE_NOT_HELD`；`test/resident-v2-publishers.test.mjs` 里发布者在 `admission_binding_required` 与各确定性原因同在时 `safeToRerun` 为 true，经 `writeOutcome`、`outcomeFacts` 到 `outcomeFailureCode`。
- 离线演练不用改（它的引擎没有探测能力）。

### 29.9 安装与不变量

- 需要先接受新的 Source（它的 `stage-fact.mjs` 变了），再做一次常驻层 Windows 重装，同一次 UAC 里重签 policy 里的 `residentManifestSha256` 和 `ciSourceManifestSha256`。policy 合同不变（`/7`）。
- 重装后每个节点从 `UNCERTAIN` 开始，第一个安静 tick 探测。探测用的是 Source 的第 11 段（C2）；按 C2 的实现，探测拿不到有效事实就 HALT（`ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED`），所以装的 Source 必须带第 11 段。
- 单节点、没有做过 parking 的部署：服务端对所有 Binding 开放，探测得到 held，节点变 `ACTIVE`，行为和以前一样，只多了启动时的一次探测。重启时有批次停在 A、B 也一样：探测不等它们结束（§29.2 第 5 条）。
- 不增加发布路径，不增加 GitHub 读写，不碰 App 凭据；模式只会让执行器少做事，从不让它多做事。

### 29.10 node-role 释放与 attempt 2（复核 m2）

- attempt 2 在预定之前就被消费（`consumed` 记录是 create-only，先于预定，PR-A 复核 MAJOR 1）。所以 attempt 2 的第 1 段若遇到 `NODE_ROLE_NOT_HELD`，原先它就白白花掉了：节点之后回到 `ACTIVE`，也不再有 attempt 2。
- **选择：退回同一个 attempt 2**，因为这种释放对 PR 什么也没说，而且改动很小：
  - 账本：`consumed.json` 之后的再次消费写 `consumed-2.json`、`consumed-3.json`…；新的 `reopenAttempt2` 写 `reopened-1.json`…（create-only）。意图“待办”当且仅当没有 `closed` 记录、且消费次数等于退回次数。`consumeAttempt2` 在已消费未退回时拒绝（`ATTEMPT2_NOT_PENDING`），`reopenAttempt2` 在没有未退回的消费或已关闭时拒绝（`ATTEMPT2_NOT_REOPENABLE`）；
  - 执行器：只有失败表判为 `node-role`、已经释放、而且这一批是 attempt 2 时，才调用（`reopenAttempt2`），并写回执 `attempt2-reopened`。别的释放（例如 `PATHS_OUTSIDE_WRITE_SET`）照旧花掉 attempt 2；
  - key 不变（attempt 2 的批次 key 和头 key 本来就含 attempt 编号），所以永远不会有 attempt 3：attempt 2 自己的结局不排新的 attempt；
  - 释放后仍适用 10 分钟的冷却（`NOT_ADMITTED` 释放记录），并且 `STANDBY` 时 attempt 2 不开。
- 释放写成之后、退回之前崩溃，attempt 2 就丢了：和今天所有 attempt 2 的崩溃窗口一样，偏向安全的一边。退回失败（吞掉异常）同样只是保持“已花掉”。
- 测试：`test/node-mode.test.mjs` 的 m2。

### 29.11 2026-10-29 独立复核的修正一览

| 项 | 修正 |
|---|---|
| B1 | Source 发布者：不当班时标志不受确定性原因影响（§29.3）；真实路径的测试；撤回“旧 Source 同在时也放”的说法 |
| M1 | 节点不是 `ACTIVE` 或探测 urgent 时，停靠批次不挡探测（§29.2 第 5 条） |
| m1 | node-role 释放不计新触发重评估（§29.3） |
| m2 | 退回同一个 attempt 2（§29.10） |
| n1 | 内存闸的睡眠被 Owner 中止叫醒（§32.2） |

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
| `src/mailbox.mjs`、`companion.mjs`、`poller.mjs`、`runner.mjs` | companion 协议、泵、轮询、运行器（服务的不杀子进程；companion 的经作业宿主，§24） |
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
| `src/train.mjs`、`src/ruleset-backstop.mjs` | v1.2：第 10 段的到期规则、状态摘要与 PR 页面行；companion 规则集兜底（§22） |
| `CI/src/resident-v2/train-run.mjs`、`CI/src/independent-control-checks-v2/train-*.mjs`、`merge-slot-native.mjs` | v1.2：第 10 段的作业合同、入口、事实、影子记录与合并位只读读取（§22） |
| `windows/CompanionJobHost.cs`、`windows/test-job-host.ps1`、`test/job-host.test.mjs` | companion 的作业宿主（安装时编译为 `bin\CluedCompanionJobHost.exe`）与它的离线、联机测试（§24） |
| `test/relay-retry.test.mjs` | 中继逐次分类、到达核对、有界重试与本地日志（§25） |
| `test/node-mode.test.mjs` | 主备 C3：节点模式、NODE_ROLE_NOT_HELD、立即探测、status `/6`、N3（§29） |
| `test/bridge-observer.test.mjs`、`test/scanner-abandon.test.mjs` | 泵观察者、桥停止、信号 A–D、心跳定时器（§26）；自动收尾与第 2 段的 attempt 2（§27）；第 8 段临时停车见 `test/park.test.mjs`（§28） |

## C2：主备角色的独立只读探测（代码候选，未做 P4 现场验收）

- stage 11 `role-probe` 经过当前 record/2、完整 node-profile、固定 Source、原 SwapBroker 与同一个 generic helper。新增 60 秒子进程上限；原 stages 1–10、各自 deadline、互斥与清理语义不变。只在 ledger 无任何 open batch（包括 hosted wait/parked；C3 起，节点不是 ACTIVE 或探测 urgent 时停靠的批次不算，§29.2 第 5 条；第 12 代：排队观察例外，见 §56.2）、非 HALT/PAUSE、安装与 Source 未漂移时调用；本地 tick 串行，runner 非 original-stopped 时不提交 broker 请求，原全局互斥仍非等待取得，不抢占其他 controller。
- 新 `role-probe-run/1` 只含 repository、随机 runId、Source/node-profile pin 与时间，不含 PR/head/claim/attempt。plan/3 的 `batchKey/batchId` 仅复用现有技术相关键；不会 reserve/markStarted/burn/evaluate/写 CI 批次，也不创建 Linux 工作区或调用 companion。stage fact 的 manifest pin 是 resident 与 invoker 独立计算的 `role-probe-intent/1` 原 canonical bytes 的 SHA。
- controller entry 只打开固定 `ci-admission.token`，验证原 token fingerprint 与完整 profile 的 controller SID；不打开 App key，只调用 `clued_work_merge_slot_holders_v1`，10 秒请求界限、64 KiB 回复界限、拒重定向。`status:ok` 无 reason 为 held，`admission_binding_required` 为 not-held，其他为 uncertain。服务端的 `binding_not_authorized` / `authorization_revoked_or_expired` 不足以区分具体撤销、过期或权限不适用，因此仅输出 `ROLE_PROBE_CONNECTION_UNAUTHORIZED`，不伪造细分原因。
- **parking holder 是解释 held 的硬前提。** 没有任何有效角色条目时，服务也可向所有 Binding 开放；holders RPC 无法证明已 parking。部署/启用主备前必须另有 Owner 的实际 parking 证据，本代码不能用 empty holders 或 held 代替。C2 不变更节点模式、不授 CI 执行权限；C3 负责启动状态、角色与失败后的模式转换。C2 的明确 mode 输入决定 STANDBY 15 分钟、ACTIVE idle 30 分钟。（C3 之后：节点启动是 UNCERTAIN，用 STANDBY 的 15 分钟间隔，启动、复位和疑似失去角色时立即探测；见 §29。）
- 三态事实只有在同 nonce、plan/config、Source、完整 Native 回执、原始 outcome SHA、精确 jobId 与 Windows tree-zero/original-stopped 全部相符后有效。连接失效通知一次，连续三次 uncertain 通知一次，确认 held/not-held 后重置；本地 receipt 保留次数与间隔，重启不能重置不确定记录。中断、缺清理或错误绑定沿原 UNKNOWN/HALT 保留现场，不放通任何旧 head/retry。
- C2 receipt 不进入批次 failure-table 的 release/burn/attempt2 规则。没有新 secret、App、Node 身份泛化；旧 /1 TURING 六生产入口保留原字节，当前 stage 11 只在完整 record/2 Source 中可达。离线纯测试不代替实际 P4 的双节点服务影响、日约 96 次切换、parking、撤销与过期验收。

## 30. 主备 C7：节点身份与 STANDBY 安装

Task `088ab175`；设计 v0.4 §7.1–§7.4、§9 C7、§10 P3。

### 30.1 范围；合入不等于安装

- 本节是代码、离线测试和文档。**合入它不会安装或重装任何机器**，不会生成、读取、复制或删除任何真实的私钥或 token，不改连接，不改规则集。
- 安装、公司节点的正式资格（设计 §12 第 5 项）、公司节点的新 App 私钥和新连接，都是 Owner 的动作，各自另行授权。UAC 只有 Owner 本人能点。
- 离线测试证明不了的：UAC 下真实创建文件时的属主与 ACL 读回、在 Program Files 之外运行包里的 `node.exe`、真实公司机器。这些留给 P3 的现场核对（`verify-resident.ps1`）。

### 30.2 节点身份 `nodeIdentity`

- 安装计划和回执都带一份节点身份：节点名；这个节点的 App 私钥编号和公钥指纹（`appKeyId`、`appPublicKeySha256Base64`）；ci-admission 连接 id 和 token 指纹（`ciPrincipalBindingId`、`ciTokenPinSha256`）；`ciPrincipalRoleRef`；七项正式资格引用（`resident-v2/prepare-record.mjs` 的 `REFS`）；Owner 的接受 Decision 与回执（`ownerDecisionRef`、`ownerReceiptRef`）。共 16 个字段，**只有公开的编号和指纹**，没有私钥或 token。
- 来源：包里的 `record\installation.json` 和 `record\acceptance.json`。两份文件都按包清单的哈希核对字节，从同一份字节解析；`installation.json` 的 `acceptanceSha256` 必须等于 acceptance 字节的哈希。两份文件里重复出现的四项（连接 id、token 指纹、公钥指纹、`ciPrincipalQualificationRef`）必须一致。
- 失败码：`NODE_IDENTITY_FIELDS_REQUIRED`（缺字段或形状不对）、`NODE_IDENTITY_ACCEPTANCE_PIN_MISMATCH`、`NODE_IDENTITY_RECORDS_DISAGREE`。
- 三处实现，由同一份用例文件 `test/fixtures/node-identity-cases.json` 约束（两个节点：TURING 的节点档案加假指纹、一个公司夹具；39 个拒绝用例）：JS `src/node-identity.mjs`，`install-resident.ps1` 和 `verify-resident.ps1` 里的 `Get-NodeIdentity`（两份文字相同，测试逐字比较）。
- `tools/build-package.mjs` 打包时独立导出一次，把 `nodeIdentitySha256` 写进包清单（合同仍是 `resident-package/3`，多一个必填字段）；安装脚本从同一批字节再导出一次，不一致就 `PACKAGE_NODE_IDENTITY_CHANGED`。Owner 审的包清单哈希因此覆盖了「这个包装的是哪个节点」。

### 30.3 `ciPrincipalRoleRef` 的含义

- 形状不变，仍是 UUID。含义改为：Owner 认可**这个连接可以持有** ci-admission 的那条 Decision（资格，设计 §7.2）。它不再是「此刻持有」的依据：公司节点以 STANDBY 装好时还没有角色，每次切换后也会过时。
- 此刻是否持有，**只**以角色探测（C2/C3）的答案为准。`prepare-record.mjs` 的注释已改写；节点身份里的这一项只是资格引用，没有任何字段表示「持有」。
- `control-install-delta-v2/prepare-payload.mjs` 是已退役的 v1 绑定器，没有改：它的字节被同目录 `manifest.json` 钉住，`.gitleaks.toml` 里还有按它的行号记的复核指纹。它里面的 `ciPrincipalRoleRef` 是写死的 TURING 值，按上面的含义读即可。

### 30.4 版本

- 安装计划 `resident-install-plan/5` → `/6`，回执 `resident-install-receipt/4` → `/5`。原因：新字段 `nodeIdentity`、`nodeIdentitySha256`、`installationSha256`、`roleAssumption` 和 `secrets`。C1 带来的 `node` 保留。
- `verify-resident.ps1` 只认 `/5`；旧回执得到 `INSTALLED_NODE_PROFILE_REFUSED`，和 C1 一样要重装一次才能过。这次重装与 §24–§28 的 Windows 重装是同一次。

### 30.5 App 私钥与 ci-admission token 的放置（设计 §7.1、§7.2）

- 两个可选参数：`-AppPrivateKeyFile`、`-CiAdmissionTokenFile`。Owner 在那台机器上下载私钥、建连接拿到 token；它们**不经过 Agent、聊天、KooYomi、仓库或网盘**。计划和回执只记指纹。
- 目标（运行时读取的路径，测试逐字比较）：`C:\ProgramData\CluedControl\trusted\controller-checks-app.pem`，`C:\ProgramData\CluedIndependentCI\secrets\ci-admission.token`。属主 Administrators，保护的 DACL：SYSTEM、Administrators 完全控制，`.\clued-control` 只读。文件创建时就带最终描述符，之后读回核对。
- 流程（全部在写任何东西之前，干跑与 `-Apply` 都做）：
  1. 来源文件只读一次进内存：普通文件、不是链接、大小有界（私钥 ≤ 16 KiB，token ≤ 4 KiB）、读的过程中没有变化。
  2. 指纹由包里钉住的 `runtime\node.exe` 运行包里的 `tools\secret-fingerprint.mjs` 计算，但**不在包目录里运行**（复核 MINOR-1，见 30.10）。两个文件各读一次、按包清单核对哈希，把**同一批字节**写进本脚本自己新建的目录再从那里运行；node 用清空的固定环境运行；秘密走 stdin，不进命令行，工具只打印指纹。
  3. 指纹必须等于安装记录的钉值；公式就是运行时每次启动用的那两个（`entry-runtime.mjs#controllerPrincipal`），测试里对拍。不符：`APP_KEY_FINGERPRINT_MISMATCH`、`CI_TOKEN_FINGERPRINT_MISMATCH`；工具拒绝（不是 RSA 私钥、不是 token）：`APP_KEY_UNREADABLE`、`CI_TOKEN_UNREADABLE`；来源文件不合格：`*_SOURCE_REFUSED`。
  4. 目标已存在：`*_TARGET_EXISTS_NOT_OVERWRITTEN`，**从不覆盖**。目标目录是链接：`*_TARGET_DIRECTORY_REFUSED`。
- 因为要建那个 Owner 属主的目录，只要提供了私钥或 token 文件，**干跑也要提权的令牌**（`ELEVATED_OWNER_TOKEN_REQUIRED_FOR_SECRETS`）；没提供文件的干跑不变，不需要。
- 放置本身是 `-Apply` 的一步 `node-secrets`（在公司的计划任务之后、runner 未变核对之前）：放的正是被计算过指纹的那些字节，`CreateNew`。没有提供参数就什么都不放。内存里的字节在放置后清零，放置后读回比对用的那份副本比对完立刻清零（`Test-BytesEqualClear`，复核 NIT-2），任何一次拒绝也先清零已读入的字节。
- 目录：`CluedControl\trusted` 属于 controller 安装，**必须已存在**（`*_TARGET_DIRECTORY_MISSING`）；`CluedIndependentCI\secrets` 不存在且提供了 token 时由本安装创建一次（创建即带 ACL）。
- 这个脚本不删任何东西：Owner 下载的那份私钥或 token 副本，装完后由 Owner 自己删（脚本输出里有一句提醒）。
- 卸载不碰这两个文件（它们不在 `resident\` 里）。重装时目标已存在，不传参数即可；传了会被拒绝。

### 30.6 `verify-resident.ps1` 核对什么

- `node-identity`：回执里的节点身份等于从**已安装**记录（`record\installation.json`、`acceptance.json`，两者都由回执钉哈希）重新导出的那份；两份记录文件互相一致；回执的 `roleAssumption` 是 `NONE`。
- `node-secrets-receipt`：回执说放了的，指纹等于记录的钉值；说没放的，没有指纹。
- `app-key-file`、`ci-admission-token-file`：文件存在、不是链接、属主是管理员、读者只有 SYSTEM、Administrators 和档案里的 `controllerSid`、controller 能读且没有写权。规则取自运行时自己的 `runtime/verify-install-acl.ps1`。
- `app-key-directories`、`ci-admission-token-directories`（复核 MINOR-2）：放文件的目录（`CluedControl\trusted`、`CluedIndependentCI\secrets`）和一路到盘符根的每一级上级，逐级按运行时同一条规则（`Test-SecretAclChain`）：属主都是管理方（SYSTEM、Administrators、TrustedInstaller）；放文件的目录自身及其下，除管理方和 controller 外没有人有读数据权；没有非管理方持有替换权（删除、改权限、取得所有权、删子项），在「保护根」（放文件目录的上一级）及其下还不得有写权；链接一律拒绝。只对 `Allow`、非仅继承的条目判断（与运行时相同）。结果：`absent`、`link-refused`、`owner-refused`、`writable-ancestor`、`secret-reader`，读不了记 `unreadable`。这样新节点预建的、继承了 Users 读取的 `trusted\`，不会过了 verify 却在运行时因 `SECRET_READER_REFUSED` 失败。
- **不读内容**：指纹在安装时核对过，运行时每次入口启动又核对（不符以 `ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED` 失败关闭）。
- 没提供参数、文件还没放的安装：这两项为 false（`absent`），整体结论是未通过。这是「节点还不能干活」的如实报告，不是安装错误。
- `controller-service-logon-right`（2026-10-30 起）：档案里的 `controllerSid` 有「以服务身份登录」权限，可以是直接授予，也可以经本机组获得。要提权才能读（`secedit /export /areas USER_RIGHTS`）；不提权时记为 `unreadable`。见 §30.8。
- 与系统语言无关（2026-10-30，DESK-W-591 上 `sc qfailure` 输出的是「重新启动」而不是 RESTART，误报失败）：
  - `broker-failure-actions` 改为读 SCM 自己的注册表值 `FailureActions`（`SERVICE_FAILURE_ACTIONS`），与安装器设的值逐项比对：复位 86400 s，动作依次为重启 60000 ms、重启 300000 ms、无 300000 ms；另要求 `FailureActionsOnNonCrashFailures = 1`。
  - `resident-sid-type` 改为读 `ServiceSidType = 1`（UNRESTRICTED）。
  - 其余仍读 sc.exe 文本的检查只依赖不随语言变化的字段名和数字（`START_TYPE`、`STATE`、`PID`、`SERVICE_START_NAME`、`BINARY_PATH_NAME`、`Se*Privilege` 名、SDDL）。

### 30.7 STANDBY 安装（公司节点，设计 §7.2、§10 P3）

- 新连接**不标** ci-admission。安装不假定任何角色：计划与回执里 `roleAssumption = 'NONE'`，`verify-resident.ps1` 拒绝别的值；包里没有 trigger、账本、请求或状态文件；配置里没有角色或模式字段。
- 安装之后，角色探测读 `ci-admission.token`，发一次只读 RPC，服务答 `admission_binding_required`，即「没有」；没有任何 GitHub 请求，没有发布。App 私钥这时不会被读（探测入口只开 token）。服务端一旦把角色标给这个连接，**同一份安装**就探测为「有」：角色在服务端，不在安装里。
- 执行器启动后先按 UNCERTAIN 等于 STANDBY 处理（不取触发、不开批次）由 C3 实现（§29）。本节只保证安装侧不预设角色、不留下会触发发布的东西。
- 切换时才标角色（设计 §5.4），是 Owner 在 KooYomi 的动作。

### 30.8 公司节点安装清单里的其他项

- **WSL 主机调优**（Task `f995d832`：P1 sysctl 和 P1b 内存保护）：`linux/host-tuning/README.md`。在公司节点的 Linux root 步骤旁做，不属于 Windows 安装脚本。
- 新节点的基础目录是前提，本安装不建：`C:\ProgramData\CluedControl`（controller 安装，含载体 runner 的原二进制）和 `C:\ProgramData\CluedIndependentCI\{formal-spool,state}`（`migrate-acl.ps1` 要求已存在）。这些由设计 §10 P2 的节点准备步骤负责，C8 手册要写明。
- **controller 账户必须有「以服务身份登录」**（`SeServiceLogonRight`，本地安全策略「用户权限分配」）。载体 runner 服务以 `.\clued-control`（档案的 `controllerSid`）运行，交换代理每一段都要启动它；没有这项权限，SCM 拒绝启动（事件 7041），第一次角色探测就 HALT（`ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED`）。DESK-W-591 在 2026-10-30 就是这样停下的。
  - 节点准备时直接授予该账户（例如 `secpol.msc` →「本地策略」→「用户权限分配」→「作为服务登录」）。
  - `install-resident.ps1 -Apply` 在写任何东西之前只读核对：缺这项权限拒绝（`CONTROLLER_SERVICE_LOGON_RIGHT_MISSING`），读不到用户权限也拒绝（`USER_RIGHTS_UNREADABLE`）。
  - 干跑把结果报在计划之外的 `preflight.controllerServiceLogonRight`，不改计划和计划哈希；不提权时这一项为 `unreadable-not-elevated`。
  - 本机账户和组在 `secedit` 导出里写成名字，不是 `*SID`。TURING 在 2026-10-31 的实际一行是 `SeServiceLogonRight = clued-runner,clued-control,*S-1-5-80-0,*S-1-5-83-0`。核对时把名字用 `NTAccount.Translate` 解析成 SID 再比较，名字和 `*SID` 两种写法都认。解析不出来的名字：在授予一行里不算授予，在拒绝一行里按拒绝算（失败关闭）。此前的版本只认 `*SID`，TURING 上已有的授权因此被误判为缺失；当晚改用内置组 Replicator（`S-1-5-32-552`）绕行（Note `427b6c83`），这次修复装上以后可以撤掉。
  - `verify-resident.ps1` 也核对这一项（§30.6）。
- **不要删除任何已有的 GitHub App 私钥。** 每个节点各有自己的一把（`appKeyId` 和指纹钉在该节点的安装记录里）；删掉哪一把，那个节点的检查发布立即 `github_http_401`。TURING 的 4918220 在 2026-10-30 就是这样被删的。新节点只新增一把；要更换某个节点自己的私钥，走只改记录的重装（`reinstall/README.md` §8b）。
- **已知限制：Linux 半边没装时，`executor.rearm` 没有合法路径。** 节点只装了 Windows STANDBY、没有 Linux 半边时，执行器一旦 HALT（例如上一条的角色探测），复位所需的 Linux 一侧事实（version facts、两侧一致）不存在，无法合法 rearm。按 Owner Decision `e5b42e52`，DESK-W-591 保持 HALTED，直到 Z1 装好 Linux 半边和它自己的结果签名钥。这里只记录，不改代码。

### 30.9 测试

| 文件 | 内容 |
|---|---|
| `test/node-identity.test.mjs` | 两个节点（TURING 档案、公司夹具）各自导出身份并核对哈希；39 个拒绝用例（字段、acceptance 钉值、两份文件不一致）；身份里没有私钥、token 或角色字段；真实 `assembleRecord` 导出的两份记录 |
| `test/secret-fingerprint.test.mjs` | 指纹公式与运行时对拍；非私钥、非 token、空、超长一律只打印一个码；进程方式：秘密走 stdin，输出里没有秘密 |
| `test/standby-install.test.mjs` | 公司包的身份钉在清单里；STANDBY 安装不带状态、不带角色、安装脚本没有网络调用；角色探测答「没有」且只发一次只读 RPC，没有 GitHub 请求；密钥与 token 路径与运行时一致 |
| `windows/test-resident-windows.ps1` §4d、§4e | 同一份用例跑 PowerShell 两份实现；包侧；回执核对；密钥文件描述符规则；用真实 node 和本仓库的工具、一个临时 RSA 私钥和一个编造的 token 做指纹核对和创建即带 ACL 的放置（断言 148 → 294）。复核修正后 §4d-2 和 §4e 另加：上级目录链的规则（16 个拒绝、4 个放行、活链三种）、读回副本清零、新建目录的值与行为、包目录里的 DLL 不被加载、提权要求（共 +47，370 → 417） |

- 离线、只用临时目录和夹具；那把 RSA 私钥由测试在内存或临时目录里生成，是一次性夹具，不是任何真实密钥。

### 30.10 独立复核的修正（2 个 MINOR、1 个 NIT；C7 本身 0 BLOCKER、0 MAJOR）

- **MINOR-1，不在包目录里运行 node.exe。** 以前指纹计算直接运行 `$PackageRoot\runtime\node.exe`。包目录通常非管理员可写，而 node.exe 会先从自己所在目录加载 WINMM、IPHLPAPI、USERENV、dbghelp 这类不在 KnownDLLs 里的 DLL；非提权进程可以往 `runtime\` 放一个 DLL，让它以管理员身份被加载，还能从 stdin 读到秘密。包清单的哈希只管清单里列的文件，管不到多出来的文件。
  - 做法（取复核建议的“拷贝”一种）：`Get-SecretFingerprint` 把 node.exe 和工具各读一次、按清单核对哈希，把同一批字节写进 `New-SecretWorkDirectory` 新建的目录，从那里运行，结束后删除该目录。目录在 `C:\Windows\Temp` 下，名字随机（`clued-secret-check-<32 位十六进制>`），属主 Administrators，DACL 受保护，只有 SYSTEM 和 Administrators（`O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`，写在脚本顶部的 `$SecretWorkSddl`）。非管理员在 `C:\Windows\Temp` 里没有删除或改名他人对象的权利，也进不去这个目录，名字又猜不到。创建后读回 DACL（和属主）核对，不符 `SECRET_WORK_DIRECTORY_ACL_MISMATCH`，已存在 `SECRET_WORK_DIRECTORY_EXISTS`。进程的 DLL 搜索顺序是新目录、System32；工作目录是 System32，环境清空。
  - 取代了原来的“包文件保持打开”（`Open-PackageFileHeld` 已删除）：现在运行的文件在管理方独占的目录里，不再需要靠打开句柄防改。
  - 计划多一个字段 `secretsFingerprintDirectory`（只有提供了私钥或 token 文件时才有：父目录、SDDL、事后删除），计划合同仍是 `/7`（`/7` 还没有装到任何机器上）。脚本说明里“从不删除”的例外多了这一个：只删自己刚建的这个目录。
  - 测试里有对照：往一个 node.exe 旁边放 `WINMM.dll` 等四个假 DLL，从那里运行的 node 确实起不来；同样四个文件放在**包**的 `runtime\` 里（清单管不到它们），指纹仍然算对。
- **MINOR-2，verify 检查放文件的目录和上级。** 见 30.6 的两个新检查。规则取自 `runtime/verify-install-acl.ps1` 的 `-ReadFile` 分支，不比它严也不比它松；`C:\`、`C:\ProgramData` 这类系统上级只受“替换权”一条约束（它们本来允许 Users 在里面建东西）。没有要求 controller 对每一级有 READ_CONTROL（运行时需要，但那要算组成员的有效权限，这里不做）。
- **NIT-2，读回副本清零。** `Write-NewSecret` 不再自己留一份读回的字节；比对和清零都在 `Test-BytesEqualClear` 里。

## 31. 信箱原子写与少开 wsl.exe

Task `32d10618`（信箱原子写）与 Task `463e8148`（companion 少开 wsl.exe，来自 WSL order-7 缓解设计 Task `7c2e4386` / Decision `941f9146` §2 D2）。只改常驻层（`src/store.mjs`、`mailbox.mjs`、`inbox.mjs`、`companion.mjs`、`companion-main.mjs`、`ruleset-backstop.mjs`），不改 Source、安装脚本、Linux 工具、policy 合同。两件事互相独立，放在一起只是因为都动 companion 与信箱。

### 31.1 信箱：为什么（Task `32d10618`）

两个症状，同一个根因：`writeNew` 先 `open(wx)` 建文件、再写、再 `sync`，读的一方可以在中间打开它，读到空文件或半截 JSON。

1. `Mailbox.latestHint` 直接读最新的托管提示文件。读到空文件抛 `HOSTED_HINT_REFUSED`，服务端口接住后回 null（“没有提示”）；读到半截 JSON，`parseHint` 拒绝。两种结局都让这一轮按没有提示处理（计划意图里记 `hintRefused`；等待窗口已到时，这个 head 就按“全部本地”排程），白等或白跑一次。
2. companion 的 `writeTrigger` 是 `fs.writeFile(..., { flag: 'wx' })`，同样先建后写。执行器恰在空档读 inbox 时，把触发当成 `INBOX_ENTRY_SHAPE_REFUSED` 归档到 `rejected`，触发就丢了；轮询器的 `sent` 记忆让它在 PR 更新或 main 变化前不再重发。

两者都不会 HALT。10-23 的 `archive-linux` 应答被拒（Task `67ae9ccb`）是同一个根因，当时只修了请求和应答的读者。

### 31.2 写侧：先写临时名，再整体换名（`store.mjs#writeNewAtomic`）

- 字节先写进同目录的 `.tmp-<12 位十六进制>-<目标名>` 并 `sync`，再用一次 `rename` 给它目标名；目标要么不存在，要么完整。写失败或换名失败，临时文件被删。
- **仍然 create-only。** Windows 的 `fs.rename` 会覆盖已有目标；硬链接（`link` + `unlink`）倒是拒绝已有目标，却让文件有一刻两个名字，`readBounded` 的 `nlink === 1` 身份检查会把它当成被改过的文件拒绝，读者就会 HALT。所以换名前后各看一次目标，已有就拒绝（`CREATE_ONLY_TARGET_EXISTS`，与 `writeNew` 同码）。两次检查之间仍有一个窗口：同一个名字有第二个写者时，后到者会覆盖先到者。下面这些名字都只有一个写者：请求号是 UUID，一个请求只有一个应答，提示序号来自 companion 的同一条顾问通道，取消文件重复写只是同义写。**会被两个写者争的名字不用这个原语**：泵标记 `<requestId>.pump.json` 的独占创建本身就是认领，没有人读它的内容，仍用 `writeNew`。单写者的前提：companion 的计划任务设为 `MultipleInstances = 2`（IgnoreNew，`install-resident.ps1` 的 `companion-task`），同一时刻只有一个 companion 进程；服务端有实例锁（`instance-lock.mjs`）。评审（NIT-3）提过另一种做法：先独占创建一个空占位文件，再把临时文件换名覆盖它，这样是严格的 create-only。没有采用：目标名会有一刻是空文件，正是这一节要消除的空档（读者与测试都得改成容忍空文件）；占位之后崩溃，这个名字会被一个空文件永远占着（应答槽或请求槽卡死）。所以保留单写者前提，由上面的名单和计划任务的 IgnoreNew 承担。
- 换名遇到 `EPERM`/`EBUSY`/`EACCES`（杀毒或索引器短暂占着新文件）重试，间隔 20、50、100、250、500 ms，之后抛出。以前这些路径没有换名，所以这是新增的失败面；失败的 `respond` 会让 `step()` 抛出、下一轮重新处理同一个请求，重试把这种情况压到最低。
- 临时名不会被任何读者当成记录：`pending()` 只认 `^[0-9a-f-]{36}\.json$`，`poll`/`cancelled` 按确切名读，提示列表要求 `hosted-hint-…` 前缀与序号。`Mailbox.open` 顺手清掉超过 1 小时的 `.tmp-` 残留（崩溃留下的），目录写不了就留着。`beat()` 的临时名也改用这个形状，换名失败时删除。
- 只用在写者有换名权利的目录：`mailbox\requests`（服务写）和 `mailbox\responses`（companion 写，心跳早就这样换名）。

用到它的：`Mailbox.send`、`cancel`、`respond`、`writeHint`。

### 31.3 读侧

- **`latestHint`**：取最新的至多 3 个提示文件，从新到旧，返回第一个**完整**的（`readBounded` 之后 JSON 能解析）。最新的是空文件或半截时（安装期间旧版 companion 还在跑），上一个完整的提示就是当前值，下次再读就读到新的；只有一个且没写完则回 null（“还没有提示”）。完整的 JSON 但形状不对的照旧交给 `parseHint` 拒绝；超长、链接、身份不符照旧抛出。内容根本不是 JSON 的最新文件分不清是“没写完”（JSON 的前缀本身也不是 JSON）还是写坏了，按没写完处理，用上一个完整的提示；以前这种文件会到 `parseHint` 被拒并记 `hintRefused`，现在静默跳过（评审 NIT-1），提示只是排程线索，所以接受。读到上一个观察而不是最新的，最多让排程晚一个 tick；提示从来不是授权，第 R 段自己会再验证。
- **inbox 与 requests 不能原子发布。** 这两个目录对 Owner 是只能新建：目录 ACE 只有 `0x1000a2`（新建文件、遍历），文件上的继承 ACE 和 OWNER RIGHTS 只给读（`install-resident.ps1` 的 `Get-AclPlan`，§8.3 末尾的“只能新建”一条，`test-resident-windows.ps1` 的 `owner-folder-add-file-only`、`owner-files-read-only`）。companion 在 inbox 里没有 DELETE，也没有 DELETE_CHILD，所以既不能写临时名再改名，也不能覆盖。改这条 ACL 会撤销 MINOR-9 的性质（触发和请求建好后不能再被改写），也属于安装脚本，本次不动。
- 所以由读者等：`Inbox.read` 遇到空文件（`empty`）或读取中尺寸变了（`size-changed`）时，**不列出、不拒绝、留在原处**，下一轮再读；从第一次遇到它的那一轮算起满 `INBOX_UNFINISHED_GRACE_MS`（30 s，读者自己的时钟，`Inbox.open(dir, archive, clock)` 可注入）仍没写完，才像以前一样列为 `INBOX_ENTRY_SHAPE_REFUSED`（执行器归档到 `rejected`，写者在建与写之间崩溃就是这样收场）。`requests\`（暂停请求）走同一个读者，所以紧急暂停请求也不会因空档被丢。
- 只等 `empty` 与 `size-changed`，**不**因为 JSON 不完整而等：触发与请求最多 1 KB，由 `writeNew` 一次 `write` 写出，空档里只会是“空”；而完整但不是 JSON 的文件（`{not json`）今天立即被拒，已有测试依赖这一点，把它们当成“还没写完”会让垃圾文件多占 30 s。
- 偏离验收第 2 条的前半句：“写触发的任何时刻，inbox 里都没有空的或不完整的触发文件”在 inbox 里做不到（见上），做到的是后半句：读者在这个空档里从不拒绝一个有效的触发。`companion-main` 的 `writeTrigger`、`writeRequest` 与 `ruleset-backstop` 的 `writePauseRequest` 现在都走同一个 `Inbox.drop`（`writeNew`，名字 `Inbox.fileName`），触发多了结尾换行与 `sync`，其余不变。

### 31.4 检查过的写路径

| 路径 | 结论 |
|---|---|
| `Mailbox.send`（服务 → `mailbox\requests`） | 改为 `writeNewAtomic` |
| `Mailbox.cancel`（服务 → `mailbox\requests`） | 改为 `writeNewAtomic`；已存在仍是同一个取消 |
| `Mailbox.respond`（companion → `mailbox\responses`） | 改为 `writeNewAtomic`；第二个应答被拒，第一个保留 |
| `Mailbox.writeHint`（companion → `mailbox\responses`） | 改为 `writeNewAtomic` |
| `Mailbox.claimPump` | **保留 `writeNew`**：独占创建就是认领，无人读内容 |
| `Mailbox.beat` | 原本就是临时名 + `rename`；临时名改成共享形状（会被清理），失败时删除 |
| 读者 `pending`、`poll`、`cancelled`、`heartbeat`、`latestHint` | `pending`/`poll` 本来就把未写完的文件当“还没有”（Task `67ae9ccb`），保留给旧版写者；`latestHint` 见 31.3；`cancelled`/`heartbeat` 读不到就当没有 |
| `companion-main` 的 `writeTrigger`（→ `inbox`） | 改走 `Inbox.drop`；读者等（31.3） |
| `companion-main` 的 `writeRequest`（→ `requests`，主备的双活保持请求，经 `node-duty.mjs` 的端口） | 同上 |
| `ruleset-backstop.writePauseRequest`（→ `requests`） | 改走 `Inbox.drop` |
| `companion-main` 的 `createRelayLog`（追加到 Owner 配置目录的 jsonl） | 不是信箱，常驻没有读者；追加写，最后一行可能不完整，不影响判断 |
| `pr-status.mjs` 的 `LocalStore.save`（Owner 配置目录） | 本来就是临时名 + `rename`，只有 companion 自己读 |
| `tools/rearm-tool.mjs` 写 `requests\`、`owner\` | 不在本次范围（`tools/`）；它写的 `requests\` 由 31.3 的读者保护，`owner\` 是只有提权 Owner 能建文件的目录 |
| `broker\requests`（引擎 → 交换代理） | 不在本次范围（读者是 `SwapBroker.cs`）；常驻对它也只有新建权利，没有换名权利 |

`test/mailbox-atomic.test.mjs` 末条用源码检查守住：`mailbox.mjs` 只剩一处 `writeNew(`（泵标记），`companion-main.mjs` 没有 `flag: 'wx'`。

### 31.5 少开 wsl.exe（Task `463e8148`）

**问题。** 泵每一段 Linux 阶段里，约每秒用一个新的 `wsl.exe` 列一次 `outgoing`，设计 r3 又加了每 15 s 一次的 `unitFacts`。每个 `wsl.exe` 要开六条 hv_sock 通道，每条占一块 order-7（宿主调优 P1 之后是 order-5）的连续内存，碎片化时这就是 wsl.exe 卡住的原因（10-28）。一个跑满 45 分钟的段就是两千多次启动。

**没有采用常驻列表通道。** 一个长驻的 `wsl.exe` 子进程要和现有约束共处，而这几条都过不去：companion 的 `Runner` 一次只跑一个子进程，且 `run()` 只在子进程结束时返回，没有流式输出；作业宿主不转发 stdin，并且在上限（最长 1 小时）到时结束整个 job；而“等目录变化再打印”的 Linux 程序，在固定 argv、不用 shell 的前提下，基础镜像里没有（`inotifywait` 不在其中）。要做就得给 root 工具加一个子命令、重装 Linux 侧、再给作业宿主加流式读取，三件都在本次范围之外（Task `463e8148` 只改 Windows 常驻层）。

**采用的：按安静时间退避的列表间隔。**

- 间隔 = `clamp(安静时间 / 2, 1 s, 15 s)`（`listingDelayMs`）。“安静时间”从最近一次事件算起：阶段开始、列表内容变了、中继搬过一条记录（`eventAt`）。事件之后每秒列一次，安静下来逐渐拉长到 15 s。
- 上限 15 s = `WORKER_FACTS_EVERY_MS`：安静时一轮同时做列表与 `unitFacts`，各 15 s 一次。每次睡眠还被截到下一次读 `unitFacts` 之前，所以信号 B、C 的读取节奏不变（仍是启动后立即一次、之后每 15 s 一次）；B 的“结束后取的下一次列表是定论”顺序不变，C 的 5 分钟不变。
- 列表失败（`names === null`）仍是 100 ms 后重试并用中继本身探测，没有变。
- 交接 blocked 记录（`handOverBlocked`）原来每秒列一次，最长 150 s：改为同一公式，上限 5 s（`HANDOVER_LISTING_CAP_MS`），窗口不变。
- 泵结束后等 worker unit 消失的循环原来每 0.5 s 读一次 `unitFacts`，最长 30 s：改为 0.5、1、2 s 然后每 2 s，同样的 30 s 上限，最多约 17 次。
- 测试可以传端口 `listingDelay`，`() => 1000` 就是改动前的节奏；生产不传。
- 一次一个子进程、作业宿主限时、固定 argv 三条约束原样保留：没有新的子进程种类，没有新的 argv。

**每个回合增加的最坏延迟，以及为什么仍在预算之内。**

| 项目 | 以前 | 现在 | 预算与理由 |
|---|---|---|---|
| 挑战从产生到被发现 | ≤ 约 1 s + 一次列表（0.3 s） | 刚有事件后 ≤ 约 1–2 s；安静时 ≤ 15 s + 一次列表。测试里实测 0.1–14.6 s | 回调窗口 `CALLBACK_WINDOW_MS` = 120 s。中继一次通常 4–6 s、观察到过 25–45 s。最坏再加 15 s = 窗口的 12.5%；“收挑战 45 s + 签发器评估约 10 s + 回送 45 s”的双长尾加 15 s 是 115 s，仍在 120 s 内 |
| ReceiveChallenge 的重试预算（§25.4） | `firstSeen + 120 s − 60 s`，`firstSeen` 是第一次列到的时刻 | `firstSeen` 取**下界**：挑战一定还不存在的最晚时刻。依次是：没列到它的最近一次成功列表的开始时刻；一轮回调之后，那一轮 `SendResponse` 开始的时刻（worker 拿到响应 k 之后才会产生挑战 k+1，两个回调可以紧挨着）；都没有时，要求启动 worker 的时刻。列表失败时沿用这个下界，不把失败列表的时刻当作看到它的时刻，也不记入 `firstSeen` | 下界永远不晚于创建时刻，所以重试窗口 `下界 + 60 s` 不晚于“创建时刻 + 60 s”，§25.4 留给签发器评估与回送的 60 s 储备不被吃掉，列表失败时也一样。窗口会早于创建时刻结束多少，取决于下界早出多少：安静时 ≤ 一个列表间隔；紧挨着的回调加慢中继时，是上一次 `SendResponse` 的时长（慢到 40 s 时窗口在挑战产生后还开约 20 s，第一次尝试快速失败的重试仍在窗口内）。这部分不是“与列表间隔无关”，间隔大时窗口更短，但永远不会在挑战出现之前就已关上 |
| SendResponse 的重试预算 | 挑战记录自己的 `deadline − 15 s` | 不变 | 读的是挑战记录里的字段，与列表无关 |
| result / blocked 的发现 | ≤ 约 1 s | ≤ 15 s | result 不赶时间；blocked 交接只是让签发器以 BLOCKED 而不是 UNCERTAIN 结束，不论早晚 |
| 信号 B | 结束后 ≤ 15 s 内发现 | 同样（读取节奏不变） | `test/wsl-starts.test.mjs` 检查读取间隔不超过 15 s 加一轮 |
| 信号 C | 启动后 5 分钟（306 s） | 5 分钟（301 s） | 仍在第一次满 5 分钟的读取上触发 |
| Owner 取消 / 泵安静 | 泵 ≤ 约 1 s 后看到取消 | 睡眠中 ≤ 15 s 后看到 | 服务等泵安静最多 `PUMP_QUIET_MS` = 180 s；取消后泵再做一次 30 s 的静止检查，合计远小于它 |
| 心跳 | 独立定时器 | 不变 | 与泵节奏无关 |

**wsl.exe 启动次数**（`test/wsl-starts.test.mjs`：虚拟时钟，假宿主，每次 wsl.exe 调用 0.25 s，每次中继调用 5 s；只数 companion 直接起的 `wsl.exe`。每次中继调用另外由 powershell 起至少一个 `wsl.exe`，两种节奏下典型段都是 8 次，不变）：

| 场景 | 列表 | `unitFacts` | 启动与静止 | 合计 以前 → 现在 | 倍数 |
|---|---|---|---|---|---|
| 典型段（247 s，三轮回调） | 165 → 35 | 17 → 17 | 2 → 2 | 184 → 54 | 3.4 |
| 20 分钟的段 | 932 → 100 | 81 → 82 | 2 → 2 | 1015 → 184 | 5.5 |
| 近 45 分钟的段（段上限） | 2065 → 196 | 175 → 178 | 2 → 2 | 2242 → 376 | 6.0 |
| 5 分钟里 worker 一直没起（信号 C） | — | — | — | 263 → 49 | 5.4 |
| 交接 blocked，记录 100 s 后出现 | 约 100 → 24 | — | — | — | 4 |

**目标没有达到：** Task `463e8148` 要的是约两个数量级，这里只有列表本身 4.7–10.5 倍、整段 3.4–6 倍。两个约束把轮询式方案卡在这里：每个 `unitFacts` 读取都是一次 `wsl.exe`，信号 B、C 的节奏要求保留，所以每 15 s 一次的下限还在（占现在总数的三成到五成）；挑战的发现延迟不能拉过窗口的一成多一点，所以列表间隔也不能超过 15 s。再往下要靠推送式的通道（上文没有采用的那一条：Linux 侧“目录有变化就返回”，把整个阶段的列表降到约一两次启动），需要 Owner 另行决定是否排这一步。

### 31.6 测试

- `test/mailbox-atomic.test.mjs`（15 条，含评审 NIT-1：最新文件不是 JSON 时用上一个完整的提示）：`writeNewAtomic` 的 create-only、目标在写的途中出现、失败清理、瞬时 `EPERM` 重试；send、respond、cancel、writeHint 在“建/写/刷盘/换名前/换名后”每一步，目录里没有空的或不完整的目标文件，`pending`、`poll`、`cancelled`、`latestHint` 此刻都不抛错、不拒绝，且在换名前看不到新记录；第二个应答与第二个取消的语义；临时名不被当成请求、应答、提示、取消，旧的被清理、新的和别的名字不动；心跳；半写的提示（0、1、一半、差两字节）时 `latestHint` 返回旧的完整值，写完后返回新的，经执行器的 `hint()` 也不是 `refused`；只有一个且未写完回 null；完整但形状不对、超长照旧；`Inbox.drop` 过程中读者不列空文件、不拒绝，写完后读到并能被 `parseTrigger` 解析；超过宽限期的空文件照旧被拒；执行器里空触发不被归档、写完后批次运行、从未写完的 30 s 后被拒；空的暂停请求不丢，写完后 `PAUSED`；源码检查。
- `test/wsl-starts.test.mjs`（10 条）：步调公式；上表各场景的前后启动数；挑战发现延迟不超过上限加一次列表；ReceiveChallenge 的预算锚点从不晚于挑战产生时刻；信号 B 的读取间隔与结束后的发现时间；信号 C 的 5 分钟；终止等待的退避；交接 blocked 的间隔。
- `test/relay-anchor.test.mjs`（5 条，评审 MAJOR-1、MAJOR-2）：紧挨着的两个回调加 40 s 的 `SendResponse`（新、旧两种列表节奏）：挑战 2 的锚点等于那次 `SendResponse` 的开始、不晚于创建、重试窗口在挑战出现时仍开着，第一次快速失败后确实重试并完成；锚点从启动、上一次成功列表、上一次响应取最晚者；列表失败（15 s 超时）时锚点仍是失败之前最后一次成功的列表，同样能重试；一次列表都没有时锚点是启动 worker 的时刻。五条在修改前的代码上都失败。
- 离线演练不用改：`incident-20261028-replay` 与 `relay-flap-under-load` 的假宿主不依赖列表节奏，61 步仍全过。

### 31.7 偏离、残余与安装

- 偏离：验收第 2 条前半句（31.3）；约两个数量级的目标没有达到（31.5）。
- 残余：写者在建与写之间崩溃的空触发，30 s 后仍被归档到 `rejected`，和以前一样，poller 在 PR 更新前不会重发；读者只等 `empty`/`size-changed`，更长的触发若被拆成多次写才可能露出前缀，现在的写法做不到；`writeNewAtomic` 在同一个名字上有第二个写者时后到者覆盖先到者（31.2 的名单里没有这样的名字）。
- 未能在真机验证：`mailbox\requests` 上服务账户的 `rename`（ACL 的 `0x1301bf` 含 DELETE，心跳在 `mailbox\responses` 已证明 companion 一侧可行）；杀毒对新文件的短暂占用只有重试这一层保护，没有真机数据；wsl.exe 启动数只在虚拟时钟的假宿主里数过，没有在真机上数。
- 混合版本：新服务配旧 companion，`latestHint` 与 `pending`/`poll` 仍容忍未写完的文件；旧服务配新 companion，邮箱文件一律完整，inbox 的空档与以前相同（旧读者仍会拒绝，写者没变）。
- 安装：只需一次常驻层 Windows 重装（与 §24–§28 同一次即可），不碰 policy、Source、Linux 工具与安装脚本。

## 32. 段前内存闸与“main 已移动”干净结束

依据：第 2 批（Owner Decision `afd23e7e`）。A 是 Task `25851665`（WSL order-7 缓解设计 Task `7c2e4386`，Decision `941f9146` §2 B2）；B 是 Task `ea32aaf9` 的修法 1（Owner Decision `d8e3dea4`）。只改常驻层：`src/companion.mjs`、`src/mailbox.mjs`、`src/engine-windows.mjs`、`src/classify.mjs`、`src/failure-table.json`、`src/executor.mjs`（只多记一项回执字段）。不改 Source v2、Linux 工具或 `companion-main.mjs`。

### 32.1 A 为什么

- Windows 到 WSL 的每条 hv_sock 通道，都要一块空闲的环形缓冲块，阶数由 socket 默认值决定：默认是 order 7，装了 P1 是 order 5。每个 wsl.exe 开六条通道。
- 所有 zone 都没有这么大的空闲块时，wsl.exe 卡住或失败。扫描段里这会让中继失败，段以 UNCERTAIN 结束，烧掉 head（10-22、10-28）。
- `linux/host-tuning/clued-wsl-memguard` 每 60 s 算一次同样的数（`ring_order`、`blocks_at_least`），低于 `LOW_BLOCKS`（64）就整理内存。但它只管修，不管段开不开始。

### 32.2 A 的做法：调用扫描段之前读一次，低就等，等不到就干净拒绝

1. **读数**（伴侣）：新请求种类 `memory-ready`（字段只有 `batchId`），固定 argv，一次 wsl.exe：`/usr/bin/cat -- /proc/sys/net/core/rmem_default /proc/sys/net/core/wmem_default /proc/buddyinfo`，以 root 运行，经作业宿主，15 s 上限。
   - `parseMemoryFacts` 与 memguard 的算法逐项相同：每个方向夹在 6 到 64 页，合成一次分配求阶数；各 zone 中不小于这个阶数的空闲块相加；超过 order 10 的列不计。
   - 答复只给事实 `memory: { order, blocks }`，阈值由服务判断。读不到（退出码不为 0、超时、作业树、文本不合格式）答 `LINUX_MEMORY_UNREADABLE`。
   - 答复合同升到 `/3`，多一个字段 `memory`，只有 `memory-ready` 的答复里可以不为 null。做法与 §24.3 的 `/2`（`jobTree`）相同：伴侣和服务来自同一个安装包，一起升级。新请求种类不升请求合同，与 `pr-head` 的先例相同。
2. **闸门**（引擎 `memoryGate()`）：只对第 2/4/6 段，在 Owner 中止检查之后、发 `relay-stage` 与调用 `invoke-stage.mjs` 之前。这时这一段的 issue 还不存在，泵也还没开。
   - 读数 ≥ `MEMORY_GATE_MIN_BLOCKS`（64）：照常调用这一段。正常情况下只多一次 wsl.exe，不等。
   - 读数低：每 60 s（memguard 的周期）再读一次，最多 7 次读数（`MEMORY_GATE_CHECKS`），约 6 分钟（`MEMORY_GATE_WAIT_MS`，再加最后一次读的时间）。期间一旦够数，就在同一批里照常调用这一段。
   - 到上限仍然低：段不调用，返回 `LINUX_MEMORY_NOT_READY`。Windows 一半的证明是“什么都没起”加服务自己的 SCM 读回。
   - 等待中 Owner 中止被接受：停止等待，返回 `OWNER_ABORT_REQUESTED`，走中止路径。60 秒的睡眠由 `requestStop` 立刻叫醒（`gateSleep`），醒来先看中止、再读，所以中止不会最多晚 60 秒才被看到，也不会多读一次 wsl.exe（2026-10-29 复核 n1）。
   - 每次检查最多一次 wsl.exe；每次读最多等 60 s 答复。
3. **记录**：闸门的事实（次数、阶数、块数、等了多久、结果）随段结果返回，执行器写进这一段 `stage-terminal` 回执的 `memoryGate`。
4. **失败表**：新码 `LINUX_MEMORY_NOT_READY` 只进 `failure-table.json` 和常驻侧名单（`RESIDENT_CLEAN`、`ATTEMPT2_RESIDENT_CODES`），不进与 Source 镜像的四个数组。
   - 第 2 段：`environment / burn / attempt2 / counts`；
   - 其他段：`environment / burn / new-commit / counts`。

### 32.3 各段的结局与“不烧头”的确切含义

- 第 1 段之后，`markStarted` 已经记下 attempt 1 的 head 键。所以闸门拒绝不会再多烧什么；这里“不烧头”指这个提交还能再跑。
- **第 2 段**：`FAILED_CLEAN LINUX_MEMORY_NOT_READY`，归档原因 `linux-memory-not-ready`，不 HALT。
  - executed-heads 按第 2 段记为未发布，换 Source 也能重跑；
  - 同一 Source 下由一次自动 attempt 2 重跑这个提交（它自己的 head 键，`automaticAttempt2.delayMs` 之后）；
  - 例外与 §27 相同：attempt 2 自己再被拒绝，不会有 attempt 3；第 R 段已转发过角色时，不进 attempt 2；
  - 这一条把 attempt 2 名单扩到一个新的常驻码。依据是 Decision `1b5d3687` 的规则（发布之前、干净的临时失败），做法与 Owner Decision `eaa7d5e4` 对 `BRIDGE_ABANDONED_UNPUBLISHED` 的处理相同。
- **第 4、6 段**：第 3 段已经发布，这个 head 不可能“不烧”。闸门在这里做两件事：
  - 先在原地等 memguard。多数情况下这一段随后照常运行，批次完成；
  - 等不到时以 `FAILED_CLEAN LINUX_MEMORY_NOT_READY` 结束（`new-commit`，计入熔断），而不是开段后多半落成 UNCERTAIN 再 HALT。PR 要推新提交才会再跑，与第 3 段之后的任何干净失败相同。
- 拒绝之后照常要两台主机的完整清理证明（`proofFor`），归档也照常经伴侣（`archive-linux`）。证明不完整仍然 HALT，与每个干净码相同。

### 32.4 阈值：64

- 一个扫描段开头几分钟里离不开的 wsl.exe 调用：SendIssue 的中继、启动 worker、头两轮回调（admission 与 remote-refs）的 ReceiveChallenge 和 SendResponse、unit 事实的读取、首次列表，约 10 次。每次六条通道。最坏情况下，用过的块来不及在 memguard 下一遍（≤ 60 s）之前合并回来，需要约 60 块。
- 64 正好是 memguard 的 `LOW_BLOCKS`：低于它，memguard 已经在整理。闸门和守护用同一个数，闸门等的正是守护在修的时候；memguard 每 10 分钟的状态行也就直接说明闸门多常会等。
- 健康时的块数是几百到几千（`test/test_host_tuning.py` 的 HIGH 样本，order 7 时 2356 块），故障时是 0（10-22 13:22Z）。64 只在接近悬崖时才挡。

### 32.5 读不到时：照常运行，不拒绝、不 HALT

- 闸门只凭证据拒绝：至少一次合格的低读数，并且之后没有一次够数的读数。
- 第一次就读不到（伴侣不答、答复不合格式、伴侣报 `LINUX_MEMORY_UNREADABLE`、邮箱抛错）：这一段立即照常调用，和没有闸门时完全一样，回执里 `ready` 为 null。
- 理由：读不到什么也证明不了。把它当成拒绝，任何伴侣故障或格式问题都会让每个扫描段被拒，批次永远过不了第 2 段；当成照常运行，最坏就是今天的行为，§25–§27 照常兜底。
- 已经有过低读数之后又读不到：不算“够了”，继续在上限内等，到上限按低处理。这时读不到更可能是内存更紧了。
- 所以读数失败从不无限阻塞（次数和时间都有上限），也从不自己造成 HALT。
- 残余：内存已经耗尽到连闸门自己的 wsl.exe 都起不来时，闸门读不到，只能照常运行，结果与今天相同。闸门管的是块数在 [6, 64) 之间、“快到悬崖”的状态。

### 32.6 B：“main 已移动 / 主体已变”在第一次发布之前

逐个核对了能在第一次发布（第 3 段；第 R 段转发过角色则更早）之前结束批次、意思是“main 移动或主体变了”的码。结论：它们都已是干净结束；唯一会 HALT 的那一种（10-22 #887 的结局）已由设计 r3 第三部分（§27）覆盖。本节没有为 B 改代码。

| 在哪里 | 到常驻时的码 | 失败表 / 处理 | 结果 |
|---|---|---|---|
| bundle：`build-bundle.ps1` 发现 main 不再是 base（`REMOTE_MAIN_BASE_CHANGED`） | `BUNDLE_UNAVAILABLE` | `release`（第 1 段之前） | `NOT_EXECUTED`，头不烧 |
| 工作区：`prepare-workspaces.py` 的 `REMOTE_MAIN_BASE_CHANGED`（核对的是 bundle 头与描述符，不是实时的 main） | `WORKSPACE_PREPARATION_REFUSED` | `environment / burn` | `FAILED_CLEAN` |
| 第 2 段之前的 refs 闸门 | `REMOTE_REFS_CHANGED_SINCE_BUNDLE` | `transient / attempt2` | `FAILED_CLEAN`，attempt 2 |
| 第 1 段：PR 变了、main 越过了 head、文件两次读不一致 | `PR_NOT_OPEN_OR_CHANGED`、`PROTECTED_CHANGE_NOT_UP_TO_DATE`、`STAGE_CHILD_REFUSED`（`pr_subject_changed` 等） | `deterministic-pr / burn` | `FAILED_CLEAN` |
| 第 1 段发布之后的复核被拒 | `PUBLICATION_REVOKED` | `clean-final` | `FAILED_CLEAN` |
| 第 2 段签发之前：refs 或准入发现主体变了 | `PR_NOT_OPEN_OR_CHANGED`（`full_admission_subject_changed`）、`BATCH_CLAIM_CHANGED`（`full_admission_rejected` 等） | `deterministic-pr` / `clean-final` | `FAILED_CLEAN` |
| 第 2 段：worker 的干净 blocked 记录 | `REMOTE_REFS_CHANGED_SINCE_BUNDLE`（透传）或 `STAGE_CHILD_REFUSED` | `transient` / `clean-final` | `FAILED_CLEAN` |
| 第 2 段签发之后：回调轮的准入或 refs 读取发现 main 移动（`REFS_MAIN_BASE_CHANGED` 变成 `full_admission_subject_changed`），发行器以 UNCERTAIN 结束（10-22 #887） | `PUBLICATION_UNCERTAIN` | `halt` 行 | **§27 覆盖**：泵被取消（`stage-ended`）后答复、两台主机静止，得 `FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED`，第 2 段 attempt 2；证明不了才 HALT |
| 第 2 段：worker 在 main 移动后没留记录就退出 | 信号 B、桥停止、`BRIDGE_STAGE_STOPPED_PUMP_LOST` | `halt` 行 | **§27 覆盖**，同上 |

- **Owner 要的说明**：10-22 #887 的 HALT 就是表里倒数第二行。设计 r3 第三部分把它收成 `FAILED_CLEAN`。这部分已在本分支（`146d8adf`）上，随第 2 批一起装上才生效。
- 第一次发布之后，同样的码照旧：发布段（3/5/7）的 `PUBLICATION_UNCERTAIN` 仍然 HALT；干净码仍是 `FAILED_CLEAN`（`new-commit`）；第 4/6 段的 UNCERTAIN 由 §27 照旧收尾（`new-commit`）。
- 没有改 Source，也没有码需要只在常驻侧改分类。
- 残余，供 Owner 决定（Owner Decision `d8e3dea4` 的修法 1 范围之外）：§27 收尾的码对“main 已移动”并不贴切。`BRIDGE_ABANDONED_UNPUBLISHED` 计入熔断，并在第 2 段排一次 attempt 2；同一 base 的 attempt 2 会在 bundle 处遇到 `REMOTE_MAIN_BASE_CHANGED`，以 `BUNDLE_UNAVAILABLE` 释放（也计入熔断）。结果仍然干净、不 HALT，只是多跑一次 bundle、熔断多计两次。如要改成不计熔断、不排 attempt 2，可按结局里的 `outcomeReason`（`full_admission_subject_changed`）再做一个小改动。

### 32.7 与任务说明的差异

1. 闸门放在引擎的 `invoke()` 里，紧挨着调用扫描段，而不是在第 4/6 段的“角色间归档”之前。好处是离 issue 最近，Owner 中止已检查过；代价是角色间归档（两次 wsl.exe）不受闸门保护。块数在 [6, 64) 时这两次调用通常仍能成功。
2. 时间上限是“约 6 分钟，再加最后一次读”：最后一次读在第 6 次等待之后开始。离线演练实测 7 次读、366 s。
3. B 没有改代码（见 32.6），只加了钉住现状的测试。这些测试在 `146d8adf` 上就能通过，因为 §27 已在其中；10-22 那一行在没有 §27 的 main 上会 HALT。

### 32.8 测试与演练

- `test/memory-gate.test.mjs`（13 项）：
  - A：阶数与块数用 memguard 的 buddyinfo 样本（order 7、order 5、夹紧、超过 order 10 的列、各种不合格式）；伴侣只起一次固定 argv 的 wsl.exe，答复 `/3` 带 `memory`，读不到答 `LINUX_MEMORY_UNREADABLE`；`memory` 只在 `memory-ready` 的答复里出现，只收 `{ order, blocks }`；
  - A：够数时第 2/4/6 段照常运行（一次读，然后泵与调用），第 1/3/5/7/8 段从不读；低两次后够数，等两分钟后同一批照常运行；一直低，得 `LINUX_MEMORY_NOT_READY`，没有调用、没有泵、7 次读，时间也有上限；读不到，立即照常运行；先低后读不到，继续等到上限再拒绝；等待中 Owner 中止，得 `OWNER_ABORT_REQUESTED`，睡醒后不再多读；一个永远睡不醒的睡眠也会被 `requestStop` 叫醒；
  - A（执行器）：第 2 段拒绝，`FAILED_CLEAN`、不 HALT、未发布、attempt 2 排上并能完成，回执带 `memoryGate`；第 4/6 段，`FAILED_CLEAN`、没有 attempt 2、记为已发布；Linux 证明不完整仍 HALT；新码每一段都有行，不在 Source 镜像数组里；
  - B：上表每个第一次发布之前的码，`FAILED_CLEAN`、不 HALT、未发布；bundle 得 `NOT_EXECUTED`；第一次发布之后照旧。
- 改了的已有测试：`engine-v2`（发送顺序多一个 `memory-ready`）、`job-host`（合同 `/3`）、`failure-table`（常驻码名单）、`scanner-abandon`（attempt 2 名单）、`bridge-observer` 与 `abort-ports`（假邮箱对 `memory-ready` 不给读数）。
- 离线演练：
  - 三个事故重放里，闸门在第 2 段之前各读一次、不等；
  - 新增 `memory-low`：VM 一直没有 order 7 的空闲块，第 2 段从未调用，`FAILED_CLEAN LINUX_MEMORY_NOT_READY`，不 HALT，两边归档 `linux-memory-not-ready`，排上一次 attempt 2。

### 32.9 安装与不变量

- 随第 2 批的一次常驻层 Windows 重装生效（同一次 UAC 里重签 policy 的 `residentManifestSha256`）。不改 policy 合同、Source 或 Linux 工具。
- 闸门不依赖 memguard 是否已装：没装时照样能读，只是低读数等不来整理，到上限就干净拒绝。
- 不增加发布路径，不碰 GitHub，不用 App 凭据；伴侣只多一个只读的固定 argv。闸门只会让执行器晚开或不开一个扫描段，从不让它多做事；证明不了照旧 HALT；自动逻辑不写、不清除 `HALT.json`。

## 33. r4 首次 HALT 的三项修复

依据：2026-10-29 刚重装的 TURING 常驻在 PR #935 那一批上第一次 HALT（`UNEXECUTED_CLOSE_UNCONFIRMED`）。协调会话只读诊断出三件事；本节是对应的三项修复（第 2 批，代码、离线测试和本节，不装、不推）。

### 33.1 现象与根因

1. 已装的 `config\companion.json` 里 `bundleScript`、`relayScript` 指向 `source\0146f406…`（旧 Source），而机器上只装了 `source\03a75f76…`。第 0 段因此报 `BUNDLE_UNAVAILABLE`。`tools/build-package.mjs` 只替换占位符；`validateCompanionConfig` 和 `verify-resident.ps1` 都不看这两条路径。
2. 关闭一个没执行的批次要跑 `archive-windows-spool.ps1`（Source resident-v2），它以服务账户 `NT SERVICE\CluedCIResident` 运行，调用 `NodeProfileV2.LoadProtectedProfile`。后者对档案文件的**每一级上级目录**用 `CreateFileW` 以 `0x20080`（READ_CONTROL | FILE_READ_ATTRIBUTES）打开（`NodeProfileV2.cs:124`、`:138-139`）。`C:\ProgramData\CluedIndependentCI` 当时给 SYSTEM F、Administrators F、Owner `0x120080`（只此目录）、clued-control RX，**没有**服务账户；而 `...\resident` 和 `...\resident\record` 是给了的。归档拒绝，`closeBatch` 返回 `verified=false`。
3. 归档脚本自己的拒绝码没有带进回执和终止记录，只留下 `UNEXECUTED_CLOSE_UNCONFIRMED`，诊断因此很慢。

### 33.2 (a) companion 的 Source 脚本路径必须在已装的 Source 里

- `src/companion.mjs`：
  - `COMPANION_PATH_KEYS`（五个带路径的键）、`NON_SOURCE_PATH_KEYS`（`wslExe`、`powershellExe`、`windowsSpool`）、`SOURCE_SCRIPT_KEYS`（其余：`relayScript`、`bundleScript`）。**带路径的键默认就是 Source 脚本**：以后新增一个路径键，不点名为“非 Source”就要受同一条规则约束。这是“其他任何 Source 脚本路径”的做法（现在配置的键集合固定，所以目前只有这两条）。
  - `sourceDirectory(root, ciSourceManifestSha256)` 给出 `<root>\source\<hash>\`；`assertSourceScripts(c, { root, ciSourceManifestSha256 })` 要求每条 Source 脚本路径以它开头（不分大小写，同 Windows），其余部分是普通名字链：段只含 `[A-Za-z0-9_.@-]`，不为空，不为 `.` 或 `..`；因此没有正斜杠、冒号（数据流）和空格。
  - 拒绝码固定：`COMPANION_SCRIPT_NOT_IN_SOURCE`，`detail` 只放键名（`relayScript` 或 `bundleScript`），不放路径和哈希；另有 `COMPANION_SOURCE_HASH_INVALID`、`COMPANION_SOURCE_ROOT_INVALID`。
  - `validateCompanionConfig(c, source = null)`：给了 `source`（`{ root, ciSourceManifestSha256 }`）才查路径，不给则与以前完全一样，所以其余套件里用任意路径的夹具配置不受影响。已有检查的次序和码不变。
- `tools/build-package.mjs`：占位符 `<sourceManifestSha256>` 改用 `replaceAll`；替换后用**这个包自己的** `ciSourceManifestSha256`（`record\source-manifest.json` 的哈希，也是 `source\<hash>\` 目录名）和固定安装根 `RESIDENT_INSTALL_ROOT` 调 `validateCompanionConfig`。输入文件里手写了别的 Source 的哈希（这次事故的样子），构建就以 `COMPANION_SCRIPT_NOT_IN_SOURCE` 失败，不会产出包。写了这个包自己哈希的字面路径同样可以。
- `src/companion-main.mjs`：启动时读已装的 `record\source-manifest.json` 算哈希，用 `{ root: --root, ciSourceManifestSha256 }` 校验配置。配置指向别的 Source，伴侣不启动（`config\companion.json` 本来就由任务命令行里的 `--config-sha256` 钉住；这一步补的是它与已装 Source 的对应关系）。这一步在心跳之前，所以失败的伴侣不发心跳。
- `windows/verify-resident.ps1`：新检查 `companion-source-scripts`（`Test-CompanionSourceScripts`）：两条脚本路径在 `<root>\source\<record\source-manifest.json 的哈希>\` 下、名字链合规、而且文件存在（是文件，不是目录）。detail 只有固定码加键名：`COMPANION_SCRIPT_NOT_IN_SOURCE:<key>`、`COMPANION_SCRIPT_MISSING:<key>`、`COMPANION_SOURCE_HASH_INVALID`、`COMPANION_CONFIG_UNREADABLE`。
- 两边对同一份案例负责：`test/fixtures/companion-source-cases.json`（4 个接受、19 个拒绝，含事故里的两种、占位符未替换、`..`、空段、斜杠、数据流、兄弟目录、别的根）。JavaScript 侧在 `test/r4-first-halt.test.mjs`，PowerShell 侧在 `windows/test-resident-windows.ps1` 的 4f。

### 33.3 (b) CI 根目录给服务账户一条 READ_CONTROL

- 授予的东西与 Owner 在那里已有的一条完全一样：`(A;;0x120080;;;S-1-5-80-…)`，即 `NT SERVICE\CluedCIResident`（SID 与计划里 `...\resident` 用的是同一个字符串，`Get-ServiceSid`），**只此目录、不继承、无数据权、无写权、无删除、无改权限**。没有授予任何更宽的东西。
- 做法放在安装计划里，不放在 Source 的 `acl-model.json`：`Get-AclPlan` 只能“新建带最终 ACL 的目录”，而这个目录早已存在（v1 一次性安装建的）；`acl-model.json` 的追加要到安装中途（服务建好之后）才跑，目录不合格时安装已经做了一半。放在安装计划里，演练（不带 `-Apply`）就能看到并拒绝。
  - 安装计划 `resident-install-plan/6` → `/7`：新字段 `parentAcl`：`{ path, sid, ace, mask, inheritance, present, before }`。`before` 是那个目录现在的 DACL；计划哈希因此钉住“我看到的是这样”。
  - `Get-ParentAclState`：目录必须存在、是真目录（不是链接）、DACL 受保护；服务 SID 在上面没有 ACE，或恰好有这一条（`present`，例如 Owner 已用 icacls 手工加过）。别的任何服务 SID 的 ACE（更宽、带写、带继承、拒绝）都是 `PARENT_ACL_HAS_OTHER_RESIDENT_ACES`。其他码：`PARENT_ACL_TARGET_MISSING`、`PARENT_ACL_TARGET_REFUSED`、`PARENT_ACL_UNREADABLE`（读不了那个目录的 DACL：Owner 自己那条 READ_CONTROL 不在）、`PARENT_ACL_NOT_PROTECTED`。
  - 新步骤 `parent-acl`，在 `directories` 之后、`package-copy` 之前：`Add-ParentAce` 重新读 DACL，与计划的 `before` 不同则 `PARENT_ACL_CHANGED_SINCE_PLAN`（什么都不写）；否则只写 DACL 一节（不写所有者、组、SACL），在原 SDDL 末尾追加这一条；读回要求：服务 SID 恰好这一条、原有每条 ACE 都在、总数多一。`present` 时什么都不写（幂等）。口径（第 2 轮复审 NIT）：写回的是 .NET 规范化后的整条 DACL（同一 SID 的可合并 ACE 会合并、按 SID 重排、带 AI 标志），“原有 ACE 都在”按规范化后的视图比较，即有效访问权限不变，与 `migrate-acl.ps1` 的做法相同；不保证磁盘上的字节顺序不变。回执多一个 `parentAcl: { path, sid, ace, wrote }`（回执合同不变，仍是 `/5`，字段只增不减）。
  - 这是安装脚本唯一对**已有**目录追加的 ACE；脚本头部“不覆盖、不删除、不改 ACL”的说明已写明这个例外。
- `verify-resident.ps1`：新检查 `ci-root-resident-read-control`（`Test-ParentAclRule`）：读 `C:\ProgramData\CluedIndependentCI` 的**现场** ACL，服务 SID 恰有一条允许 ACE，掩码 `0x120080`，标志为 0（不继承）。多了、少了、更宽、带继承、是拒绝，都不过。读的是现场而不是回执，所以手工加的也算。读不到记 `unreadable`（与其他需要提权的检查相同）。`Get-ServiceSid` 在安装与 verify 里逐字相同（测试钉住）。
- **`formal-spool-acl.ps1`（桥 v4）**：它也调 `LoadProtectedProfile`，但它不以服务账户运行：`-RelayReadOutgoing` 要求当前 SID 是 Owner，`-AllowControllerWrite` 要求是 clued-control，否则以 `FIXED_PUBLIC_SPOOL_REQUIRED` 退出。所以这条服务 ACE 不是为它加的，也不影响它：Owner 的上级目录访问靠 Owner 自己那条（§8.3 的前提），clued-control 靠它的 RX。反过来，它沿路检查上级目录的“可写祖先”时，服务这条 `0x120080` 不含任何写、删除、改权限的位，不会触发 `WRITABLE_ANCESTOR_REFUSED`。`LoadProtectedProfile` 的另外两个调用者：`relay-public.ps1`（Owner 的伴侣）和 `archive-windows-spool.ps1`（服务账户，本次事故）；SwapBroker 用 `ReadBrokerConfig`，以 LocalSystem 运行，SYSTEM 在那里是 F。
- `NodeProfilePublicFileV2.ValidateBootstrapAcl` 不会因这一条拒绝：它只拒非管理方持有的写、删除、改权限、改所有者位（受保护树里还拒绝 `Write`），`0x120080` 都不含。

### 33.4 (c) 归档自己的码带进回执和终止记录

- `src/engine-windows.mjs`：
  - `windowsArchiveCode(r, v)`：脚本打印的 `code`（符合 `CODE`）→ 否则 Runner 的 `refused` 码 → 否则超时给 `WINDOWS_ARCHIVE_TIMED_OUT` → 否则 `WINDOWS_ARCHIVE_UNCONFIRMED`。不符合 `CODE` 的字符串（自由文本、路径、系统消息）一律丢弃，用后面的固定码。
  - `archiveWindows` 现在也解析脚本**非零退出时**的标准输出（脚本失败时打印 JSON 判决，退出码 2；以前只在退出 0 时解析，失败的码就丢了）。返回 `{ verified, directory, moved, archiveCode }`，`verified` 时 `archiveCode` 为 `null`。退出 0 但输出不是判决，仍然抛 `WINDOWS_ARCHIVE_UNCONFIRMED`（没改）。`verified` 仍要求退出 0。
  - `closeBatch` 返回 `{ verified, archived, archiveCode }`（Windows 一半没过才有码；Windows 过了而 Linux 没过，码为 `null`：它不说 Linux 的事）；`archiveFailure` 返回 `archiveWindows` 的结果。
- `src/executor.mjs`：
  - 归档检查改用 `archiveCheck(ok, code, windows)`：失败时抛的 `ResidentError` 带 `windowsArchiveCode`（只有在 `windows.verified !== true` 且码符合 `CODE` 时）。涉及 `REARM_WINDOWS_ARCHIVE_UNCONFIRMED`（两处）、`FAILURE_ARCHIVE_UNCONFIRMED`（三处）、`SUCCESS_PATH_ARCHIVE_UNCONFIRMED`、`UNEXECUTED_CLOSE_UNCONFIRMED`。
  - 所有把这类错误交给 `unknown()` 的 `catch` 都把 `archiveFacts(error)` 并进 `extra`；`unknown()` 把 `windowsArchiveCode` 写进 **HALT 的 facts**（两次 `haltWith`）、**`FAILED_UNKNOWN` 终止记录的 facts**（本来就展开 `extra`）和 **`batch-terminal` 回执**；`halt` 回执跟着 HALT 的 facts 带上它。重新武装时归档被拒，`owner-request-refused` 回执带上它。
  - 没有归档码、或码不符合 `CODE`：所有记录与以前逐字节相同（测试断言键不存在）。
- 这次事故重放后，HALT 记录会是：`code: UNEXECUTED_CLOSE_UNCONFIRMED`，`facts: { key, basis: 'failure-handling-unconfirmed', windowsArchiveCode: 'PROFILE_HANDLE_OPEN_REFUSED' }`（`PROFILE_HANDLE_OPEN_REFUSED` 是 `NodeProfileV2` 的 `Deny` 码，由脚本的 catch 取出）。
- 不做的事：不改 Source 的归档脚本，不加自由文本，不把 Linux 的码也塞进来（Linux 一半的码本来在伴侣答复里，不在本次范围）。

### 33.5 与任务说明的差异

1. 任务说明写“安装 ACL 计划（`Get-AclPlan`）加这一条”。`Get-AclPlan` 的键都是 `$Root`（`...\resident`）之下**新建**的目录，父目录放不进去；所以新增 `parentAcl`（计划字段）和 `parent-acl`（步骤），不改 `Get-AclPlan` 本身。计划合同 `/6` → `/7`；回执合同不动。
2. 没有 JS 镜像：计划只有 PowerShell 一份。JS 侧的文本级测试只钉住形状（掩码、没有继承位、步骤顺序、唯一的 `SetAccessControl`）；行为在 `test-resident-windows.ps1` 里对草稿目录实测。
3. 没有改 `work/actions-hosted-migration/independent-ci-v1` 下任何文件（任务说明允许改，但没有需要）。

### 33.6 测试与演练

- `test/r4-first-halt.test.mjs`（新，14 项）：共享案例（JS 侧）；拒绝不泄路径；键分类；`validateCompanionConfig` 带与不带 Source；伴侣启动的文本钉住；包构建（占位符、字面的本包哈希、两种旧 Source、别的根）；安装/verify 的文本级事实；`windowsArchiveCode`；`archiveWindows`/`closeBatch`/`archiveFailure` 的码（含退出 2、垃圾输出、自由文本码、超时、Runner 拒绝）；执行器四条路径（没执行的关闭、失败归档、成功路径、重新武装）和“没有码则记录不变”。
- `windows/test-resident-windows.ps1` 新增 4f（76 项，294 → 370）：verify 的 Source 脚本检查对同一份案例（含文件缺失、目录不是脚本、坏哈希、另一个 Source），以及 verify 主流程里的那几行原样对草稿安装根跑一遍（旧 Source 的配置哪怕文件存在也不过；配置不是回执钉的那份；脚本缺失）；`Get-ServiceSid` 与已知 SID 一致、安装与 verify 逐字相同；`parent-acl` 在草稿目录（受保护 DACL，像真的那样）上：计划状态、追加、恰好 `0x120080`/无继承/无数据与写权、与 Owner 那条相同、原有 ACE 全留、仍受保护、所有者不变、verify 接受；幂等；手工加的算已有；更宽、带写、带继承、读数据、拒绝五种都被计划和 verify 拒绝；不受保护、缺失、文件、链接被拒；计划后变了被拒且什么都没写。
- 其余：`node --test`、离线演练、`test-install-carry.ps1`、PowerShell 离线测试全部通过，数量见任务报告。

### 33.7 生效与不变量

- 都要随第 2 批的一次常驻层 Windows 重装才在这台机器上生效。重装时 `parent-acl` 会把那条 ACE 加上；如果 Owner 事先已手工加了完全相同的一条（`icacls C:\ProgramData\CluedIndependentCI /grant "NT SERVICE\CluedCIResident:(Rc,S,RA)"` 得到的就是 `0x120080`、不继承），计划里 `present = true`，步骤什么都不写。本次没有对机器做任何事，这条命令也没有运行。
- 新主机的前提不变：CI 根目录要先有 Owner 自己的 `0x120080`（§8.3）；安装不替 Owner 加这一条。
- 没有新的发布路径，不碰 GitHub、凭据或网络；不读写 `HALT.json`；服务账户只多一条只读的、只此目录的 `0x120080`。

## 34. 原地升级通道：常驻层接线

依据：KooYomi Task `018da927`（Owner 决定 `dda41297`、`3ce5200c`）的实现规格 §B4。本节只讲常驻层（`CluedCIResident`、companion、打包与 Owner 工具）为升级通道做的接线；升级代理 `CluedCIUpgrader`（`upgrader/`）、Windows 执行面（`windows/upgrade-apply.ps1` 等）和 Linux 升级工具（`linux/bin/clued-ci-upgrade-linux`）各有其规格，这里只写常驻层与它们之间的接口。代码与离线测试，不装、不推。

### 34.1 常驻层给升级代理留的观察面（规格 A11，冻结）

以后的常驻版本必须保留：`state\PAUSED.json` 的原字节与 `source.requestSha256`；ledger 里没有 `90-terminal.json` 的条目数；`state\status.json` 的 `executor.state`、`current`、`writtenAt`；回执文件名，以及 `service-start`、`train-run-intent`、`train-run` 三种回执的 body；`requests\` 里暂停与 intake 的合同；`owner\` 里的 `clued.independent-ci.resident-upgrade-resume/1`。

### 34.2 升级代理的恢复请求（`src/executor.mjs`）

- 合同 `clued.independent-ci.resident-upgrade-resume/1`：`{pausedSha256, opId, generation, requestedAt, nonce}`，校验用 `src/upgrade-mailbox.mjs#validateUpgradeResume`（与升级代理写请求用同一个函数）。
- **只从 `owner\` 读**（只有管理员和 SYSTEM 能在里面建文件，升级代理以 LocalSystem 运行）。同样的字节放进用户可写的 `requests\`，那里只认暂停与 intake 合同，按“格式不对”拒收，不会恢复。
- 和 Owner 的恢复一样按 `pausedSha256` 做比较交换（`Ledger.resume`）：`PAUSED.json` 变过就 `PAUSE_CHANGED_SINCE_REVIEW`，回执 `owner-request-refused`，仍然暂停。成功时 `PAUSED.json` 照旧改名进 `halts\`，旁边的 `.resume.json` 记 `by: "CluedCIUpgrader"`；回执是 `upgrade-resumed`：`{requestSha256, pausedSha256, opId, generation}`（不再另写 `owner-request`）。同一份字节再来是 `owner-request-duplicate`。

### 34.3 每个 tick 的两侧版本（status `/7`）

- `src/status.mjs`：status 合同升到 `/7`，顶层多一个 `versions`：`{generation, windows:{packageManifestSha256, residentManifestSha256, ciSourceManifestSha256, policySha256}, linux:null|{observedAt, generation, ciSourceManifestSha256, manifestSha256, pinsOk}, consistent:true|false|null, upgrade:null|{opId, state, phase, since, code, confirmUrl}}`。读者接受 `/5`、`/6`（没有 `versions`，读作 null）和 `/7`；`/7` 缺 `versions`、`/6` 多 `versions` 都拒。写入和读回都过 `parseVersions`：不合形状的字段显示为 null，从不信任（`confirmUrl` 只收 https、无引号空格、有长度上限）。
- 来源（`readVersionState`，每个 tick 现读，宽松：缺失、写了一半、形状不对都当“未知”，从不报错、从不 HALT）：`upgrade\current.json`（代数与包）、`upgrade\mailbox\responses\version-facts.json`（companion 写的 Linux 事实）、`upgrade\status.json`（升级代理的状态）。`windows` 一项取自执行器自己的 policy 和命令行上的 policy 哈希，不取自文件。`consistent` 就是 `upgrade-mailbox.mjs#consistent(current, facts, now)`：两侧代数、CI Source、Linux 清单相同且 pins 成立为 true；事实超过 15 分钟、没有 `current.json`、没记 Linux 一半为 null。
- 新的 notice 种类：`version-skew`（键带两侧代数）、`upgrade-grant-pending`（键带 opId）、`upgrade-deferred`（opId 加码）、`upgrade-rolled-back`、`upgrade-rollback-failed`（当前 op 或 `recent` 里的结局，每个 op 一次）。companion 把它们转成 Windows 通知（`src/pr-status.mjs`）；等批准的通知里给出确认页地址。
- `service-main.mjs` 把同一个读取函数作为执行器的 `versions` 端口，引擎用它的 `view`。没有端口（测试、别的引擎）时执行器什么都不显示，也不加任何 hold。

### 34.4 版本不一致的 intake hold

- 只在 `consistent === false` 时加：holder `version-skew`，120 分钟，剩余不足 90 分钟时续期（与 `dual-active` 相同的规则，规格 A10）。它就是 intake pause 里执行器自己的一句话（`IntakePause.apply`，回执 `intake-paused`，`reason: UPGRADE_VERSION_SKEW`），所以 PAUSE、HALT 和其他 holder 都不受影响；Owner 可以手动解除，版本仍不一致时下一个 tick 会再加上。
- `consistent === true` 时解除（`intake-resumed`，`reason: VERSIONS_CONSISTENT`）；`null`（未知）既不加也不解，已有的 hold 到点自己结束。
- 放在 tick 里 Owner 请求之后、排程之前，所以版本不一致时不开新批次；正在跑或停靠的批次不受影响（这是 intake pause 的本义）。

### 34.5 版本闸：预留之前的全局延后，第一个 Linux 段之前的兜底

节点自己的版本偏差不应由 PR 付代价，所以主闸放在**预留之前**，引擎里的闸只兜竞态。

- **主闸**：`src/executor.mjs#precheck`（只读、无密钥、无网络的预检）在决定预留之前现读一次版本（`versionSkewNow`）；`consistent === false` 就返回全局延后 `VERSION_SKEW`：本轮排程到此结束，不预留、不写 ledger、不烧号、不计入任何每日额度或放行上限，行仍在排队表里，版本一致后照常运行。`null`、端口出错或没有端口：照旧。它与 34.4 的 hold 互补：hold 在 tick 开头按那一刻的读数加上（之后读到偏差的同一个 tick 里 hold 还没有写，或者 hold 写不进 intake 状态），预检的现读把这个窗口也关上；attempt 2 走同一个预检。
- **兜底**：`src/engine-windows.mjs#runStage` 在第一个 Linux 段（`firstLinux`，第 2、4 或 6 段）之前再现读一次；`consistent === false` 就不调用该段，返回 `UPGRADE_VERSION_SKEW`（Windows 一半的证明：树为零、原始服务已停；失败路径照常补 Linux 静默）。`null`、`true`、端口出错或没有端口：照旧往下走（refs 闸等）。只有第一个 Linux 段会问。只有“批次已预留并开始后、第一个 Linux 段之前”才变成不一致的竞态会走到这里。
- `src/failure-table.json` 为兜底码加两行：`stages [2,4,6]` 与 `any`，`class environment`、`disposition burn`、`retry new-commit`、`breaker neutral`。第 2 段以后的干净结束只能烧掉：失败表自己的校验（`classify.mjs#validateFailureTable`）只允许第 0、1 段出现 release（10-started 之后不存在放行），所以规格原写的 `release-if-safe` 加 `new-trigger` 会让模块加载失败，烧掉的提交 `new-trigger` 也不会再跑。`test/failure-table.test.mjs` 的 `RESIDENT_CODES` 已加入该码。

### 34.6 service-start 的代数与 `resident-upgraded` 回执（`src/service-main.mjs`）

- `service-start` 的 body 是 `{policySha256, pid, generation}`，`generation` 取自 `upgrade\current.json`，读不到为 null。
- 上一条 `service-start` 有代数、这一次也有、两者不同，就紧接着追加 `resident-upgraded`：`{fromGeneration, toGeneration, opId, packageManifestSha256, policySha256}`（opId 与包取自同一份 `current.json`）。回滚也是代数变化（`toGeneration < fromGeneration`）。任何一边未知都不写，所以首次安装（g1）、通道之前的老回执、读不到的 `current.json` 都不会被说成升级。

### 34.7 companion 的升级邮箱 lane（`src/companion.mjs`、`src/companion-main.mjs`）

- 第三个 lane，自己的 Runner（20 分钟的 Linux stage 不会挡住常驻邮箱和咨询工作），每 5 秒看一次 `upgrade\mailbox\requests\`。目录不存在（通道之前的安装）时 lane 每次重试打开，companion 其余部分照旧；companion 从不建这些目录。
- 每个请求按 `upgrade-mailbox.mjs#upgradeToolArgs` 生成参数，再由 `argv(cfg).upgradeTool` 以固定前缀（`wsl.exe --distribution … --user root --exec /usr/bin/env -i …`）和固定路径 `/opt/clued-independent-ci/upgrade-v1/bin/clued-ci-upgrade-linux` 运行。参数先过 `upgradeToolArgvOk`：每个元素是 `[a-z0-9-]` 的单个记号，拼起来必须完全匹配六种之一（`version-facts`；`stage --op --package --generation --linux-manifest`；`switch --op --from --to --linux-manifest`；`rollback --op --from --to`；`verify --op --generation`；`retain --op --keep --generation`，即 `linux-upgrade-retain {keep, generation}`，keep 只收 2..10，形状与 B3 工具和 `upgradeToolArgs` 一致），否则 `COMPANION_UPGRADE_TOOL_ARGS_INVALID`，什么都不运行。
- 工具的一行 JSON 按 `responseFromTool` 原样写回 `responses\<requestId>.json`（`/1` 冻结，以后的 companion 都要原样应答）；超时或起不来的子进程是 exit -1/null，永不算成功。**截止时间已过的请求不运行**（升级代理可能已当作“没有应答”继续了），应答 `UPGRADE_MAILBOX_REQUEST_EXPIRED`。读不了的请求文件不动，由升级代理自己超时。
- Linux 事实每 5 分钟整文件替换写一次 `responses\version-facts.json`；每次 switch、rollback 之后（不论结果）立刻再写；被请求的 `linux-version-facts` 应答也顺带写入。读失败 60 秒后再试。

### 34.8 包 `/4`（`tools/build-package.mjs`）

- 合同 `clued.independent-ci.resident-package/4`，在 `/3` 上加：`nodeProfileSha256`、`windowsLayout`（`clued.independent-ci.resident-layout/1`）、`stateCompat`（`--state-compat`，默认 `{schema:1, readableBySchemas:[1]}`，用 `validateStateCompat` 校验）、`acceptance:{decisionRef}`（等于 policy 的 `ownerAcceptance.decisionRef`，必须是 UUID）。
- `linux`：`manifestSha256`（`linux/manifest.json` 的哈希，仍是 `/2`）；`sourceV2`（`--source-v2` 给出 `{commit, bundle, rolesDerivedSha256}`；bundle 复制到 `linux/source-v2/source.bundle`，单独点名，不列入 `files`；三个 role 的派生哈希是输入，由 Linux 升级工具的 stage 重新派生核对）；`files` 列出 `linux/` 下其余每个文件及其字节数。冻结的升级工具和签名器复制到 `linux/upgrade-v1/bin/`，并生成 `linux/upgrade-v1/manifest.json`（`clued.independent-ci.linux-upgrade-tool-manifest/1`，按安装路径钉住两个文件），供 `install-resident-linux.sh --apply-upgrade-v1` 使用。
- `upgrader`：`{manifestSha256, files}`，升级代理冻结副本 `upgrader\<manifestSha256>\` 的清单（`clued.independent-ci.resident-upgrader-manifest/1`）。副本保持本仓库的相对布局，使 `upgrader/src/*.mjs` 里的 `../../src/…` 导入能解析：`upgrader\src\*`、它们按相对导入（传递闭包）用到的 `src\*`（只这些，导入跑出 `src/` 或 `upgrader/src/` 就拒）、`windows\upgrade-apply.ps1`。**总是**计算，所以升级包名出构建它的升级代理，升级代理遇到不同的就 `UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL`；被冻结的常驻模块（`canonical`、`store`、`inbox`、`intake-pause`、`upgrade-mailbox` 等）一改，就需要全量重装。
- `upgrader\` 下的安装目标只在 `--fresh-install` 时写进 `files`（升级包里出现就是 `CHANNEL_CHANGE_NEEDS_REINSTALL`）：副本、`upgrader\bin\UpgraderServiceHost.cs`、`upgrader\runtime\node.exe`（同一个 node.exe）、`upgrader\config\upgrader.json`（`--upgrader-config`，合同 `clued.independent-ci.resident-upgrader-config/1`，`nodeProfileSha256` 必须是本包的）。不加 `--fresh-install` 时所有目标仍落在 `/3` 的白名单里。
- 升级代理入口因此是 `upgrader\<manifestSha256>\upgrader\src\upgrader-main.mjs`（相对导入决定，见上）。
- 升级代理运行 `upgrade-apply.ps1` 时，环境变量只有 `upgrader/src/windows-port.mjs#APPLY_ENV` 这两项：`SystemRoot` 和固定的 `PATHEXT=.COM;.EXE;.BAT;.CMD`，不继承别的变量。少了 `PATHEXT`，Windows PowerShell 5.1 会不执行任何原生 .exe（不报错、没有输出、`$LASTEXITCODE` 为空），于是 csc、sc.exe 等每个动作都失败。原地升级 op `8c5efb1a` 就是因此被拒的（Note `ee73b1a0`）。回归测试 `upgrader/test/units.test.mjs`（windows port (live)）在 Windows 上用真实的 `WindowsPort` 和 powershell.exe 按全路径跑一次 `cmd.exe`。`upgrade-apply.ps1` 调用每个程序都用全路径，所以不需要 PATH。环境里也没有 TEMP，csc 的临时文件会落在 `GetTempPath()` 的回退目录 `C:\Windows\`（LocalSystem 可写）。这一点还没在真机上验证，第一次真实的 Compile 就是验证。不改成 `C:\Windows\Temp`，因为普通用户能在那个目录里创建文件。升级代理是冻结副本，这项修复只能随整套重装生效（Decision `0b8cab03`）。

### 34.9 Owner 工具

`tools/rearm-tool.mjs inspect` 多一项 `upgrade`：当前代数与包、升级代理的 op（状态、阶段、码、等批准时的确认页、`pausedBy`）、最近的结局、保留的各代、Linux 事实，以及两侧是否一致（读已装的 `config\policy.json`；读不到就只显示文件、不判断一致）。只读，不需要提权。

### 34.10 测试

- `test/upgrade-wiring.test.mjs`：status `/7` 的读写与 `/5`、`/6` 兼容、形状复核；`consistent` 的真、假（代数、Source、清单、pins）与未知（过期、缺文件、写了一半）；五种 notice 与通知文字；skew hold 的加、不续、续期、null 不动、一致后解除，没有端口或端口出错时不动；预检的 `VERSION_SKEW` 全局延后（不预留、不烧号、偏差消失后同一提交照常运行）；upgrade-resume 只认 `owner\`、比较交换、拒绝与重复、`by`；`service-start` 的代数与 `resident-upgraded`（升级与回滚，未知不写），回执链仍然完整；引擎闸（2、4、6 段、未知照旧、只问第一个 Linux 段）；失败表行；companion 的 argv 校验（六种形状接受、二十种拒绝）与 lane 的每个 kind、工具码透传、switch/rollback 后立即刷新、过期不运行、超时与非 JSON 不算成功、失败重试间隔、目录缺失；inspect。
- `test/package.test.mjs`：`/4` 的各键、规范字节、Linux 段（含 bundle 与升级工具清单）、升级代理副本与闭包（不含未导入的模块、同一树两次构建哈希相同）、`--fresh-install` 的目标和安装白名单、各类输入拒绝；并用升级代理的 `validatePackageManifest` 复核。
- `test/status.test.mjs`、`test/node-mode.test.mjs` 改为 `/7`；`test/failure-table.test.mjs` 加码。

### 34.11 不变量

- 常驻服务不运行升级代理、不写 `upgrade\` 下任何文件；它只读三份文件，只在自己的 intake 状态里加或解 `version-skew` 这一个 holder。
- 版本信息只用于显示、hold、预检的全局延后和第一个 Linux 段前的兜底闸，从不让任何东西更早开始；未知永远当作“不动”。
- companion 仍只运行固定 argv；新增的只是一个冻结路径的 root 工具和六种逐字校验的参数形状。

## 35. 归档保留与瘦身、trivy 缓存回收、C: 余量提醒、无心跳不量 Linux（Task `4aedda54`；Task `018da927` 子项 b、c）

### 35.1 归档保留规则（`src/retention.mjs`，Linux 侧 `clued-ci-resident-linux archive-prune`，同一规则）

- 分两类，各自独立计算：**成功类** `archive-*`、`completed-*`；**失败类** `failed-*`（失败、HALT、Owner 中止的归档都以 `failed-` 开头）。名字必须匹配 `^(archive|completed|failed)-[0-9A-Za-z-]{1,90}$`，其他名字（`incoming`、`outgoing`、未知名字）永远不进计划。
- 每类保留最新（目录修改时间，同时按名字）的 20 GiB，且无论多大都至少保留最新 10 个；超出部分从最旧的删。每轮最多删 16 个（其余记为 `deferred`，下一轮再删）。数值是常量（Owner 给定），**不进 policy**：policy 合同不变。
- 50 GB 总提醒（`archive-retention-reminder`）照旧。
- Windows spool（`C:\ProgramData\CluedIndependentCI\formal-spool`）由服务自己执行；Linux spool（`/var/lib/clued-independent-ci/formal-spool`）由 root 工具执行，经邮箱新请求 `archive-prune`（响应合同 `/4` 多一个 `prune` 字段，形状由 `mailbox.mjs#validatePrune` 精确校验）。两边的计划函数用同一份案例 `test/fixtures/retention-cases.json` 约束。

### 35.2 例外：Owner 的保留清单

常驻侧没有可靠办法查询 KooYomi 里哪些 Task、Bug、Evidence 还没关闭、引用了哪个归档，所以改用**显式保留清单**：`C:\ProgramData\CluedIndependentCI\resident\owner\retention-keep.json`（`owner\` 只有提权的 Owner 能写，服务只读；名字不是 Owner 请求的名字形状，`OwnerInbox` 不会读它）。合同 `clued.independent-ci.archive-retention-keep/1`：`{ contract, keep: [{ name, spool: windows|linux|any, ref }] }`，`ref` 写引用它的 Task/Bug/Evidence id 或 `owner`，只记录不解释；最多 2000 条、256 KB。Linux 工具经 `/mnt/c/...` 读同一个文件。被列出的归档不删，单独计量（回执 `protected`：目录数、字节数、是否量全；Windows 回执另列名字，最多 64 个）。Owner 关闭相关 Task 后自己从清单里删掉那一行。

**清单不存在时一个都不删**（`RETENTION_KEEP_LIST_MISSING`，独立复核 M2）：未知的清单从不当作空清单。安装或重装之后，由 Owner 写下这个文件（可以是 `{"contract":"clued.independent-ci.archive-retention-keep/1","keep":[]}`）才开始删除，这一步就是对删除的显式授权；之前回执每天一条说明原因。Linux 工具只把 `FileNotFoundError` 当作“不存在”，其他读错误一律是读不到（复核 m3）。

### 35.3 安全措施（任何一条不满足都不删，写回执说明）

- **只在批次之间、且无未关闭批次**时执行：服务循环的 `betweenBatches`（IDLE/DEFERRED/PAUSED/WAITING）里，`idle` 再查：没有子进程在跑、没有 HALT、账本里没有非终止条目（运行中、等待、停车 A/B 都算）、没有未归档的现场。Linux 侧另要 root 自己证明静止（`quiescence`），且必须有新鲜的 companion 心跳。
- 先算计划再执行；每个要删的目录在删之前重新清点，字节数或条目数变了（`RETENTION_CHANGED_SINCE_PLAN`）、出现链接就停。
- 只删 spool 根下、名字匹配三种已知模式的目录；spool 根本身必须是真目录且真实路径未被重定向（`RETENTION_SPOOL_REDIRECTED`）。
- fail-closed：某类里任何一个目录大小读不到（`RETENTION_SIZE_UNREADABLE`）或含符号链接/联接点/特殊文件（`RETENTION_LINK_REFUSED`），该类本轮一个都不删；保留清单读不到或不合合同（`RETENTION_KEEP_LIST_UNREADABLE`/`_INVALID`），整个 spool 不删；删除自己写（深度优先，遇到链接就停，从不跟进），权限错误记 `RETENTION_PERMISSION_REFUSED` 并停止本轮。
- Windows 上服务账户对 spool 根只有“新建子目录”，但对它自己建的归档目录有修改权（含 DELETE），所以能删它自己的归档；Owner 早年手工建的 `completed-*` 等会以 `RETENTION_PERMISSION_REFUSED` 停下，留给 Owner。

### 35.4 回执

- `archive-retention-prune`：`{ spool, rule, refused, classes: { success|failure: { directories, bytes, deleteDirectories, deleteBytes, refused } }, protected, deferred, deleted: [{ name, class, bytes }], deletedBytes, stopped: { name, code, partial } | null, deletesAnything }`。有删除的每轮都写；被拒或中途停的同一原因每天最多一条。Linux 工具另在 `/var/lib/clued-independent-ci/resident/retention/` 写一份本地持久回执（含保护名单全文）。
- `disk-space-reminder`：C: 可用空间低于 30 GiB 时每天最多一条 `{ drive: 'C:', freeBytes, thresholdBytes, action: 'owner-free-disk-space', blocksAnything: false }`；读不到就不提醒，从不阻断。

### 35.5 成功归档瘦身（`clued-ci-resident-linux`）

- 归档合同 `resident-linux-archive/3`：`success-close` 的计划带 `slimCandidates: true`。所有移动都核实之后，归档里的 `workspace-<作业 id>/candidate` 和 `run-<名字>/candidate` 各写一份 `candidate.slim.json`（合同 `resident-linux-archive-slim/1`：提交 SHA、整树清单哈希、文件数、字节数、`restoreFrom: git`），再删掉那棵树（三份候选树约 660 MB，单个成功归档约 850 MB → 约 190 MB）。提交 SHA 取候选检出的分离 HEAD；`run-placement-<作业 id>` 的候选没有 `.git` 时取同一作业工作区的提交。
- 提交 SHA 未知（`SLIM_COMMIT_UNKNOWN`）、含特殊文件、含链接而 rmtree 不能防符号链接攻击、删除失败的，树原样保留并在 `slimKept` 里报告；瘦身失败不影响归档本身的 `verified`。
- 失败归档、角色间归档保持完整。Windows 侧归档（`archive-windows-spool.ps1`、`src/archive.mjs`）只搬协议记录，本来就没有候选树，不改。

### 35.6 trivy 缓存回收（`worker/formal-trivy-v3/cache.mjs`）

现装的是角色策略 v3 → `formal-trivy-v4/adapter.mjs`，它没有自己的 cache.mjs，用的就是 v3 的，所以只改这一个文件（`formal-trivy-v2/cache.mjs` 只属于已退役的 v2 策略，没改）。`promote()` 在指针改名、父目录 fsync、读回确认之后调用 `reclaimCache`：删掉该种类（db 或 checks）在 `staging/` 下的全部副本（准备锁在手，没有别的准备在用），以及 `generations/` 下除当前和上一代之外的该种类各代；只碰名字形状正确的目录，另一种类不动，链接只删链接本身。回收失败只记录在返回值 `reclaimed` 里，不让提升失败，下次提升再试。

### 35.7 无心跳不量 Linux（Task `018da927` 子项 c）

`RetentionWatch` 先问 `companionReady`（心跳年龄不超过 `policy.companion.heartbeatMaxAgeMs`，与执行器开批用同一标准）。没有心跳时不发 `archive-usage`、也不发 `archive-prune`，Linux 部分记为 `skipped: COMPANION_HEARTBEAT_ABSENT`；以前这一步要等满 3 分钟超时，期间主循环不动。

### 35.8 verify-resident.ps1 的结论（Task `018da927` 子项 b）

结论抽成 `Get-VerifyVerdict`，“需要提权再跑”只认值是字符串且恰为 `'unreadable'` 的检查（`-is [string] -and -ceq`）。原来 `-eq` 左边是 `$true` 时会把字符串转成布尔，任何通过的检查都算“读不到”，所以任何失败都报 `RESIDENT_PARTIALLY_VERIFIED_RUN_ELEVATED`。

### 35.9 测试

- `test/retention.test.mjs`（新）：共享案例；保留清单；Windows 一轮（删最旧、保护、最新 N 个、其他名字不动）；联接点、清单坏、spool 被重定向都不删；无心跳不调测量、主循环一轮立即返回；只在 idle 时删、回执频率；C: 提醒；`archive-prune` 经邮箱的形状；service-main 接线。
- `test/verify-verdict.test.mjs`（新）与 `windows/test-resident-windows.ps1` 新增 4g（7 项）：失败原因不是 unreadable 时不报 RUN_ELEVATED。
- `test/test_linux_tool.py` 新增 `Retention`（共享案例、清单、一轮、链接、计划后变化、成功瘦身、失败归档完整与提交未知时保留）。
- `independent-ci-v1/test/formal-trivy-cache-reclaim.test.mjs`（新）：保留当前与上一代、首次提升、另一种类与其他形状不动、链接不跟进、失败只报告、越界拒绝、回收在读回之后。

### 35.10 生效与不变量

需要常驻层 Windows 与 Linux 重装（companion 与服务一起，响应合同 `/4`），trivy 回收需要 Source 重装。删除只发生在上面的条件下；没有新的发布路径，不碰 GitHub、凭据或网络。

## 36. 按风险分档计每日额度（Task `12ada80e`，来自 c0ff5167；Decision `ca70ea31`）

### 36.1 为什么

第 1 段被干净拒绝、证明没有任何发布的批次（例如 2026-10-21 那 8 个旧 PR 的 `STAGE_CHILD_REFUSED`）照样烧号，也照样写一条 `ledger-heads` 记录，于是 `usage()` 把它算成一次执行，占掉 48 批的执行额度；同一个条目又在批次账本里算一次评估。Owner 决定（`ca70ea31`）第 3 批只做按风险分档的机制，数值保持临时的 48/96，等算力面板有实际数据再调。

### 36.2 两档

- **评估档（低风险）**：同时满足以下几条的第 1 段结局——10-started 之前；对照表判为 CLEAN（两端清理证明齐全）；绑定的阶段结果 `sideEffects` 为 0 且 `mayHavePublished` 为 false。照样烧号（这个 head 永不再跑），但烧号记录的 `burnedBy` 带 `quotaTier: 'evaluation'`；`usage()` 不把它计入执行（`started`），另计 `lowRiskBurns`，它的批次条目照常计一次评估；它仍计入本 PR 每天的批次上限 `startedByPr`（复核 m4：一个 PR 不能用第 1 段被拒的提交耗尽全局评估额度）。
- **执行档**：其余一切——10-started 的记录、其他烧号、没有 `quotaTier` 的旧记录、读不出的记录。与以前相同。
- 另外，从未 10-started 却以 FAILED_CLEAN / FAILED_UNKNOWN 结束（即烧号）的批次条目，不论对照表类别（环境、暂时类也一样）都计一次评估：它在执行档里不再出现时必须在别处被计数。执行档的烧号仍同时计执行与评估，与以前一样严格。

### 36.3 看得见的推迟

全局推迟（今日执行额度已满、评估额度已满、companion 没就绪）每个原因每个 UTC 日写一条 `batch-deferred` 回执，带当时的 `started`、`evaluations`、`lowRiskBurns`。之前只有状态页能看出执行器为什么不动。

### 36.4 不变的

上限值（48/96，policy `/7` 不变）、烧号与已执行记录、第 1 段释放的前提（只认 `safeToRerun` 或 broker 没启动）。

### 36.5 测试

`test/risk-tier.test.mjs`：低风险烧号只计评估且 head 不再跑；可能发布、有副作用、没有绑定结果、第 3 段失败、Linux 一侧不干净都仍是执行档；低风险烧号不占执行额度，额度满时回执每天只写一次。`test/executor.test.mjs` 的 `usage()` 形状随 `lowRiskBurns` 更新。

## 37. 停靠点 A 重打 bundle（Task `4012c1b9`）

### 37.1 为什么

停在 A（等托管结果）的批次恢复时可能已过很久：第 1 代 bundle 的 refs 过期，第 2 段的 refs 闸门几乎必然失败；超过 100 分钟则以 `PARKED_BUNDLE_TOO_OLD` 结束（§18.2）。托管转发打开之前要补上。现在转发仍关着（Decision `b0087f98` 第 4 项：实测推到第 3 批装好之后），所以本节在今天的批次上不会触发。

### 37.2 做法

- 执行器：只对从停靠点 A 恢复的批次（`resumeWaiting` 进来的，复核 M1），在工作区准备之前、距预留超过 `REBUNDLE_AFTER_MS`（30 分钟）时，向 companion 发邮箱请求 `rebuild-bundle`，写一条 `batch-rebundled` 回执。
  - 成功：照常准备工作区，ws-prep 用第 2 代。
  - companion 答 `REMOTE_REFS_CHANGED_SINCE_BUNDLE`（main 已不是 T，或没有任何分支还指着 H）：第 0 段干净的暂时性结局，对照表照旧（attempt 2 可跟进）。
  - 其他拒绝或没有答复：照旧 `PARKED_BUNDLE_TOO_OLD`。没有等过的批次（例如打包和第 1 段本身就慢）和没有该端口的旧 companion 都照旧按 100 分钟判断，行为与以前完全相同。
- `build-bundle.ps1 -Rebundle`：只在第 1 代完整（回执可读、同一批次与描述符、没有 `generation` 字段）时运行，写到 `bundles\<batchId>\gen-2\`（必须不存在：最多两代），检查与第 1 代相同；另要求有分支仍指着 H（`REMOTE_HEAD_MOVED`）。回执多 `generation: 2`、`previousBundleSha256`、`previousRefListSha256`。`-CheckRefs` 与 `-Rebundle` 互斥（`ONE_MODE_REQUIRED`）。
- `-CheckRefs` 与 `prepare-workspaces.py` 用最新的完整一代：`gen-2\` 存在就必须有回执，且回执绑定第 1 代的精确 bundle；`gen-2\` 没有回执一律拒绝（`BUNDLE_GENERATION_INCOMPLETE`），绝不退回第 1 代。
- force-push 掉了 head 的情形在取 head 对象时就失败（git 步骤），按“其他拒绝”处理。

### 37.3 状态页（第 2 步复核 N4）

几个批次可以同时停在 A。状态的 `pending` 里，每个停在 A 的批次所在的行原因写 `PARKED_A`，不只靠 `current` 显示一个。

### 37.4 测试

`test/rebundle.test.mjs`（执行器：等过之后重打一次再准备工作区；超过 100 分钟也能继续；refs 变了干净结束、Linux 上什么都没做；其他拒绝照旧；没等过的批次不重打；两个停在 A 的批次都显示；companion 的固定命令与结论映射）；`test-build-bundle.ps1` 加 10 条（第 2 代、`-CheckRefs` 读第 2 代、不能第 3 代、互斥、没有第 1 代、第 2 代不完整、head 被推进），共 80 条；`test_prepare_workspaces_v2.py` 加 `bundle_generation`。

### 37.5 安装

`build-bundle.ps1`、`prepare-workspaces.py` 属 Source v2，邮箱新请求属常驻层：必须一起装（同一次两侧重装）。

## 38. 额度第二期·第 3c-2a 步：车头批次测 GitHub 试合并提交 S（S ≠ H 全链路，Task `6451a55d`）

3c-2 分两步。3c-2a 只把 S ≠ H 从头到尾接通（§21.3 所列各项）；开车要的部分（第 8 段单绿、撤销与清扫、车头批次调度、优先级与期限、C9）在 3c-2b。3c-2a 装上后没有任何地方会产生 S ≠ H 的批次：subject 里的 `testSha` 只由 3c-2b 的车头调度写入，触发文件不接受这个字段。

### 38.1 S 怎么走

- **subject 与 batch key**：车头批次的 subject 多一个 `testSha`（S，必须是 40 位十六进制且不等于 head）；其他 subject 没有这个字段。batch key 只在字段存在时把 `testSha` 加进摘要，所以今天所有的 key 不变。常驻层 `ledger.mjs#batchKey` 和 Source v2 `derive-batch.mjs#residentBatchKey` 是同一个公式，测试核对两边相等。head key（每个 head 只执行一次，不变量 I2）对 S = H 的 subject 不含 S；车头批次（S ≠ H）的 head key 按 (H, S) 算，所以一个 head 跑过普通批次后仍可跑车头批次（§41 第 3–5 步实现，Task `b42419de`）。
- **推导**：`engine-windows.mjs#derive` 把 subject 的 `testSha` 一并传给 `derive-batch.mjs`；推导结果里的 S 必须等于 subject 的 S（没有就等于 head），描述符 `/3` 写推导出的 S。
- **作业 `/3`**：`makeJobV2` 去掉 S 的默认值，每个调用点都显式传 S（复核 m1）。`isTrainFrontJobV2` = S 与 H 都是合法 SHA 且 S ≠ H。
- **批次认领记录**：S = H 的批次照旧写合同 `/1`，逐字节不变；S ≠ H 写 `/2`，在 `baseSha` 后多一个 `testSha`。`/1` 永远表示 S = H。控制消费者从记录本身取 S（`recordTestShaV2`），按记录的 T 和 S 重推作业。
- **第 8 段**：`trainFacts` 读的是 `job.testSha` 的树，S = H 时就是 head 的树，和今天一样。

### 38.2 base.sha 只在 S ≠ H 时放宽（设计 §5.7）

列车模式下 H 不必含 main 尖端，GitHub 的 `base.sha` 也只在推送时更新。所以只有车头批次不再要求 PR 的 `base.sha` 等于批次 base T，只要求它是合法 SHA；S = H 的批次（以及没有 S 的 v1 作业）照旧要求相等。涉及：

- `full-admission-v2.mjs#samePr`：第一次读到的 `base.sha` 记为本次准入的 PR base；第二次读 GitHub、评估结果和 Native 的 `base_sha` 都必须与它相同，否则 `full_admission_subject_changed` / `full_admission_native_changed`。准入事实里的 `baseSha` 仍是作业的 T。
- `staged-check-publisher-v2.mjs` 写前核对、`github.mjs#exactPr`（同一次调用前后两次读到的 `base.sha` 必须相同）、`protected-controller-ports-v2/refs.mjs#samePr`。`github.mjs` 也被 v1 一次性发布者加载，所以判断写在本文件里，不引入 `job-v2.mjs`（v1 的加载闭包不变）。
- 不改的：两个发布者对 packet `baseSha` 的检查（packet 由 `readChangedPaths` 按作业的 T 生成，本来就相等）；`refs.mjs` 里 main 必须等于 T；控制发布者的合并位 `tip` 等于 T（属 3c-2b）。

### 38.3 打包与 ws-prep

- `build-bundle.ps1`：去掉 `TEST_COMMIT_NOT_HEAD`。S ≠ H 时，在 `Build-Store` 里取完已审核提交之后按 SHA 取 S，放在 `refs/clued-test/<S>`（只能这一个名字、最多一个），核对它是提交、父提交恰好是 [T, H]，再读一次全部引用。这一步的 git 标签 `fetch-test` 算网络步骤，和其他网络步骤一样可在新库里整体重试一次。bundle 加 `--glob=refs/clued-test/*`，头部和 `list-heads` 都核对这个引用；回执多 `testSha`、`testRefPrefix`、`testRefCount`（S = H 时为 0）、`testRefListSha256`。GitHub 重算试合并后旧的 S 可能取不到：这一步失败，属于批次开始前的失败（BUNDLE_UNAVAILABLE，不计释放上限）；回第 10 段重读 S 由 3c-2b 的调度负责。
- `prepare-workspaces.py`：去掉 `TEST_COMMIT_NOT_HEAD`。回执必须带上面四个字段，`testRefCount` 必须等于应有的个数；bundle 头部的测试引用必须正好是应有的那一个（S = H 时为空）。普通克隆不映射 `refs/clued-test/`，所以两个候选在克隆后再单独取这个引用；镜像库核对引用集合包含它，并核对 S 是提交、父提交恰好是 [T, H]。

### 38.4 中继不带车头批次

托管中继在 GitHub 的 runner 上测 head，它的 subject 里没有 S。车头批次（S ≠ H）一律不走中继：`derive-batch.mjs#deriveRelayStage` 拒绝带 `testSha` 的 subject（`RESIDENT_RELAY_TEST_COMMIT_REFUSED`），`relay-entry-v2.mjs#relaySubject` 也拒绝 S ≠ H 的作业（`RELAY_TEST_COMMIT_REFUSED`）。这与 §21.3 的原计划（中继也带 S、E8 核 S 的树）不同：车头批次只在本地跑，需要中继时由 3c-2b 的调度让它等或回第 10 段。

### 38.5 为什么装上是安全的

- 没有任何地方产生 S ≠ H 的 subject，所有放宽都只在 S ≠ H 时生效。S = H 的批次：作业 id、批次认领记录 `/1`、batch key、各处 base 核对都和今天一样。
- bundle 回执多了四个字段，ws-prep 要求它们。所以 `build-bundle.ps1` 和 `prepare-workspaces.py` 必须一起装（同一个 Source），不能只装一个。

### 38.6 测试

- Source v2：`s-not-h.test.mjs`（S ≠ H 的判定和 base 放宽；批次认领 `/2` 与 `/1` 不变；控制消费者按记录的 S 重推、不按传入的 base 匹配；subject 与 batch key；推导出的作业都测 S；中继两处拒绝；`refs.mjs` 放宽 base 但 main 仍须等于 T），`resident-v2-admission.test.mjs`（准入：S ≠ H 时三处读到的 base 一致就准入，不一致就拒；S = H 仍要求等于 T），`resident-v2-publishers.test.mjs`（第 8 段按 S 的树发绿；S 取不到不发绿；扫描发布者 S ≠ H 时不比 base），`test_prepare_workspaces_v2.py`（真实 git：试合并 S 放进 `refs/clued-test/<S>`，解析、父提交核对、候选取引用；回执字段），`job-v3.test.mjs`（S 没有默认值）。
- 常驻层：`s-not-h-resident.test.mjs`（`ledger.mjs` 与 `derive-batch.mjs` 的 batch key 有无 S 都相等），`engine-v2.test.mjs`（S 随 subject 传给推导，描述符写 S，推导报别的 S 就拒）。
- `build-bundle.ps1`：`test-build-bundle.ps1` 加 S ≠ H 一例（本地仓库里造一个 [T, H] 的合并提交作 S）。

### 38.7 独立审核（规则 01d4ba7d）

第 1 轮：ACCEPT-WITH-FIXES（1 BLOCKER、1 MAJOR、3 MINOR、7 NIT）。S = H 的作业 id、认领记录 `/1`、batch key、描述符和 bundle 字节（空的 `--glob=refs/clued-test/*` 不改 bundle）逐一核对不变；三种语言的引用前缀、引用列表哈希、父提交顺序一致。处理：

- B1：受保护的 `scripts/ci/clued-work-admission.test.mjs` 有两处调用没传 S。已补；同一个测试的控制对部分原本就因 3a（第 8 段读规则集和试合并）和 C4（已在 GitHub 上的角色不再发布）在 main 上失败，一并跟上。本 PR 因此属于受保护层。
- M1：`job-v3.test.mjs` 钉的 `TEST_COMMIT_NOT_HEAD` 文本、`test-build-bundle.ps1` 缺 `$TestPrefix`，随 bundle 部分一起改，并补 S ≠ H 的用例（见 38.6）。
- m2：补了 `github.mjs#exactPr` 的三种情形、bundle 头里第二个测试引用；n1（每个候选都核 S 的父提交）、n4（S 进歧义键和第 2 次尝试的主体核对）、n6 已改。

### 38.8 留给 3c-2b 的（开车之前必须做，Task `a3701d3d`）

- **车头批次不走中继**（审核 m1）：执行器 `relayPlan` 对带 `testSha` 的 subject 一律留在本地，在写 `20-plan-intent` 之前决定；现在要到第 R 段推导才拒绝，批次会白白失败。
- **S ≠ H 只在列车开着时被接受**（审核 m3）：今天 base 的放宽只看作业本身。第 1 段和第 8 段的发布者在 `train.enabled` 不是 `on` 时拒绝 S ≠ H 的作业。
- **读到的 base 一致**（n2）：`refs.mjs` 和 staged 发布者也要求各自前后两次读到的 `base.sha` 相同。
- **把读到的 PR base 记进准入事实**（n3，设计 §5.7 “只记为读到的事实”）：今天只在 `evaluationSha256` 里。
- **S 被 GitHub 重算掉**（n7）：第 8 段按 SHA 读 S，GitHub 重新生成试合并后可能读不到，批次会一直“没就绪”。调度遇到这种情况回第 10 段重读 S、开新批次；或者 ws-prep 把 S 的树带给第 8 段，按（父提交、树）比较。
- **回执合同仍是 `/1`**（n5）：新 ws-prep 要求回执的四个测试字段，所以 `build-bundle.ps1` 和 `prepare-workspaces.py` 必须同一次装上（重装清单写明）。
- **还缺的 S ≠ H 测试**（§21.3 的测试一条）：桥签发、HEAD = S ≠ H 的 worker 工作区、placement 密封候选的 HEAD 和打包内容（S、H、T）、C# 同批核对（`PureTestsV2.cs` 现在在 #927 手里）。

### 38.9 并入第 3 批（2026-10-29）

- 3c-2a 的三个本地提交（基于 main `f0a401d4`）普通合并进第 3 批集成分支（基于 SourceB `43883c31`），无冲突；随后应用了原先等 #928 的 bundle 补丁（审核 M1）。
- 合并带出两处跟进：SourceB 新加的 Native 发布测试仍依赖 `makeJobV2` 的 S 默认值，已显式传 S；`test-build-bundle.ps1` 的“父提交顺序反了”用例原先用 merge 造 W，因 c1 是 c2 的祖先只会快进，W 就是 head，用例从未真正生效，改用 `commit-tree` 造 [H, T]。
- 38.8 各项仍属 3c-2b，未在第 3 批实现。


## 39. 新 PR 每 60 秒发现一次，条件请求（Decision `1b99e7e4`，Task `a3701d3d` 第 3 批）

- **为什么**：companion 的 poller 原来 5 分钟看一次 open PR，新 head 最多晚 5 分钟才进队。改为 60 秒；不做 webhook。
- **做法**（`src/poller.mjs`、`src/companion-main.mjs`）：
  - `POLL_EVERY_MS` 从 5 分钟改为 60 秒；ruleset 兜底（§22.3）单独计时，仍是 5 分钟（`BACKSTOP_EVERY_MS`），不随轮询变密。PR 页状态与通知仍每分钟一次（`REPORT_EVERY_MS`）。
  - 每轮两次读都改为 REST 条件请求：`repos/<repo>/git/ref/heads/main` 与 `repos/<repo>/pulls?state=open&base=main&per_page=50`（原来的 `gh pr list` 走 GraphQL，不能带 ETag）。第一次不带条件；之后带上一次 200 的 `If-None-Match: <ETag>`。没变时 GitHub 回 304：按 GitHub 的条件请求规则，带授权的 304 不计入 REST 主额度；本轮沿用上次的结果，不会重复提出已提过的 head。
  - `gh api --include` 在 304 时退出码为 1，但仍打印状态行和响应头，所以只看状态行。只认 200 与"有缓存时的 304"；其余（无应答、别的状态、body 形状不对、304 却没有缓存）照旧是 `POLLER_PULLS_UNAVAILABLE` / `POLLER_MAIN_TIP_UNAVAILABLE`，本轮作废、下一分钟再来。
  - ETag 要回填进 argv，所以只保留 GitHub 的形状（`ETAG`：可带 `W/`，引号内 1–128 个 `[0-9A-Za-z_-]`）；其他形状一律不保存，下一次不带条件。
  - REST 的字段映射回原来的形状（`number`、`head.sha`→`headRefOid`、`base.sha`→`baseRefOid`、`draft`→`isDraft`、`body`、`updated_at`→`updatedAt`），后面的过滤（草稿、claim trailer、与 main 同步、compare 缓存与预算）不变。`lastPass.reads` 记本轮 200 与 304 各几次。
- **额度**：没变时每分钟 2 次 304（一天约 2880 次，按 GitHub 的规则不计额度；本机实测过一次 304，剩余额度同时少 1，同一账号另有调用，未能单独确认）。原来按 5 分钟一轮的两类调用不随轮次变密：GitHub 没答上的 compare 对同一 (main, head) 隔 `COMPARE_RETRY_MS`（5 分钟）才再问；提示模式下同一 head 的观察（每次几次读）隔 `HINT_OBSERVE_EVERY_MS`（5 分钟）一次。答上的 compare 照旧缓存。
- 304 只在 gh 退出码为 1 时采用（gh 对 304 退出 1，对 200 退出 0），超时、拒绝或其他退出码都不算。
- REST 的 PR 对象比 GraphQL 大（带完整的 head/base repo），50 个约 1 MB 量级，仍在 Runner 的 4 MiB 输出上限内；不变的分钟只有响应头。
- **测试**：`test/poller-conditional.test.mjs`（节奏常量；连续两轮 304、If-None-Match 的 argv 逐字、PR 被编辑后 200 只提一次；main 移动；两条读各四种拒绝与退出码不为 1 的 304；200 不带 ETag 时丢掉旧 ETag；坏 ETag 不回填；compare 失败与提示观察的 5 分钟节流；路由字面值；`parseIncluded` 的 CRLF/LF 与拒绝）；`test/gh-rest-stub.mjs` 供其余 poller 测试按 REST 形状作答。

## 40. 整套重装工具链收进仓库，以及对已装现场的全量只读预演（Decision `19baf5ec`，Task `a3701d3d`）

位置：`reinstall/`，详见 `reinstall/README.md`。

**原状**：整套重装（打包、提权启动器、Linux 第 A/B 步 root 脚本）原先在仓库外的 `s34-reinstall\r4-work` 里，每一版都从上一版打补丁派生。r7 打第 3 批时连续三次被拒，原因都是照搬了上一版的假设：Linux 常驻 manifest 沿用了已装的外部钉值；角色派生不允许 Source 钉值变化；启动器只认卸载计划 /2。

**现在**：
- 所有工具都按一份构建配置生成（`clued.independent-ci.reinstall-config/1`：节点档案、提交、Owner 的 Decision 和回执、base 包、节点公开指纹、已装状态副本）。节点相关的值不再写在代码里。
- 启动器模板就是 r7 f4 实际跑过的文本，sha 钉住，不再打补丁；主机名改为钉值 `$NodeHostname`。
- Linux 脚本期望的"已装状态"取自节点自己的 Linux version facts 和第 1 代记录。
- 角色派生与冻结工具的 `derive_role` 一样，重钉 5 个 Source 文件。
- 一致性核对：用新工具链以 a0e15a91 和 r7 的 ref 重新打包，得到 9d774173，与 TURING 现装的包逐字节相同；Linux 脚本与 r7 final2 相比，只多出 `OLD_GENERATION` 和名称上的改动。

**预演**（`reinstall/rehearse.py`，非提权、只读）：直接运行已装的卸载 dry-run 和 verify，读取 status、升级状态、第 1 代记录和 Linux version facts，核对 root 复制的已装副本，检查包的外部钉值，在节点的 WSL 里以普通用户运行角色派生。任何不一致都记为 finding。

预演必须对同一个包、同一提交、同一配置得出 `REHEARSAL_PASS`，否则 final 启动器（`launcher/generate.py`）和 final 版 Linux 脚本（`linux/prep.py`）都拒绝生成。上面三次被拒各有回归测试（`reinstall/test/test_rehearse.py`）。

独立审核后补上的几处：
- root 脚本钉住的 toolchain node、结果公钥和 v1 HEAD 原是 TURING 的常量，现在取自配置 `linux.host`；预演用 root 只读运行 `check-host.py` 并核对 v1，提前抓住另一节点上第 A 步会出现的拒绝。
- `draft*` 版 Linux 脚本本身拒绝运行。
- 进入 root shell 和提权 PowerShell 的值都要过严格字形（shell 值经过 quote，PowerShell 只接受可打印 ASCII）。
- 提取出的树每次使用前都与提交逐个 blob 核对。
- 与 base 包不同的节点必须给出全部六项身份值。
- 预演报告 24 小时内有效，由 Linux 脚本生成（`prep.py`）时检查，此时节点还未变动。

**新节点**：`config/node-profile.desk-w-591.json`（取自 Note `85717e8f`）。用 `build.ps1 -PackageOnly` 只出包；首装不使用这里的重装启动器和 Linux 脚本。

**§41 第 8 步补的两处**（2026-10-31，改了启动器模板和 root 脚本生成器，按 `reinstall/README.md` 第 1 节要重新做一次完整的独立审核）：
- 心跳令牌（§41.6a）：配置可选 `heartbeat`（`tokenFile`，可另给 `bindingId`）。启动器只在配置了时给安装器传 `-HeartbeatTokenFile`（和 `-HeartbeatBindingId`），提权的带令牌计划必须恰好多出这一项。没配置的节点行为不变。模板 sha 换成 `5ff3a1c1`。
- 没有 Source v1 的节点（Z1 首装）也能整套重装：`linux.host.v1SourceHead` 可为 null。此时 root 脚本要求节点上确实没有 v1，签名的来历改用节点自己已装、已签的 roles-v3 qualification（`linux/tools/sign-qualification-no-v1.mjs`），其余核对不变。有 v1 的节点生成的脚本逐字节不变。
- 心跳令牌换新或补装：今天只能整套重装（安装器只做全新安装，升级通道不碰 `secrets`）。不重装的办法需要一个新的提权小工具，见 `reinstall/README.md` 第 4 节。

**不在本节**：节点身份冻结全部接受 ref（Note `45e0ed29`）；升级器调用 csc 时没有 TEMP。这两项随下一次整套重装一起做。

## 41. 合并列车开车（第 3c-2b 步）：单绿、撤绿与清扫、车头调度、优先级、多节点当班与守队程序（Task `a3701d3d`，Decisions `263f9701`、`3dcb583b`）

Owner 2026-10-31 的决定：`263f9701` 现在做 3c-2b，批量测试与二分（Task `7f205c71`）排在它之后；`3dcb583b`（取代 `a5ea4be3`）定了排位用 Task 优先级；`86008583` 的守队程序和 `b30b1b79` 第 3 项的常驻层改动随同一轮安装（全部常驻节点）上线。本节只是设计。下文的“现状”都对照 main `35c41fd6`。本节的 Source B 指 `work/actions-hosted-migration/independent-ci-v1/src/`（Source v2），Source A 指 `scripts/ci/` 里的 Native 端口、撤销控制器和 `clued-work-admission.test.mjs`。

Owner 要做的全部事情：① 授权服务端迁移（发布流程：备份 → migrate），之后在 `/bindings` 上把要参与自动接班的常驻节点（今天是 TURING 与 DESK-W-591）的连接标为“可自动接班的常驻节点”并排好次序，并为每个节点建一个只能发心跳的连接，下载令牌，随该节点的 UAC 安装用 `-HeartbeatTokenFile` 装上（41.6a）；② 两个 protected-change Grant：Source A、守队程序；③ 每个常驻节点安装的 UAC（各加 Linux root），之后再一次 UAC 把策略改成 on；④ 开车前复核一次影子数据；⑤ 接受 MergeAdmission v0.2（含 41.1 列出的改动）；⑥ 接受合同草稿并给发布 Grant；⑦ 在规则集里关 `strict`、合并方式只留 merge；⑧ 打开排位开关；⑨ 定 `nonFrontRuns`（UAC）；⑩ 影子复核之后打开自动接班总开关（41.6a）。

### 41.1 范围与顺序

受保护的路径以 `scripts/ci/merge-admission-policy.mjs:49-72` 为准：`.github/**`、`scripts/ci/**` 在内；迁移目录和 `work/**`（含 C# 边界与 SwapBroker）不在；合同的 `.md` 属文档层。

| 步 | 内容 | 重装 | 受保护 | Owner |
|---|---|---|---|---|
| 1 设计 | 本节，独立审核（规则 01d4ba7d） | 否 | 否 | 无 |
| 2 服务端 | 一次迁移：记下车头与按优先级排位（41.5）、排队认领保活（41.4）、节点心跳函数与记录、holders 回答的 `nodes`、清扫水位（41.6、41.6a）、ci-admission 自动接班的资格标记、次序、总开关（默认关）与看门狗（41.6a）；`/bindings` 页面加资格、次序、总开关、心跳连接，都走两步确认 | 否 | 否 | 授权迁移；标记资格；建心跳连接 |
| 3 Source A | Native 写端口（touch、adopt、return、保活、清扫水位，CI 身份），`clued-work-admission.test.mjs` 跟上 | 随第 8 步 | 是 | protected-change Grant |
| 4 Source B | 第 8 段单绿、第 10 段 on 与只撤模式、清扫、两处 `binding` 改动；train-run `/2`（`frontOutcome`）；C# 边界接受 on 与 train-run `/2` | 随第 8 步，两侧 | 否 | 无 |
| 5 常驻层 | 策略 `/8`、车头调度、`relayPlan`、C9、两种请求文件、保留；companion 的心跳与自动接班的 @Owner 评论（41.6a）；安装参数 `-HeartbeatTokenFile` 与 `secrets\heartbeat\`；HALT、PAUSE、暂停接新在 latch 的同一 tick 写进状态 | 随第 8 步，Windows | 否 | 无 |
| 6 文档 | 下面列的 v0.2 与合同草稿改动；GitConnectorWriteContract、`docs/maintenance/independent-ci.md` | 否 | 否（文档层） | 接受 v0.2；接受草稿、发布 Grant |
| 7 守队程序与算力面板 | 41.8；算力面板认自动接班评论的标记、不重复 @（`scripts/ci/self-hosted/compute_panel.py`，41.6a） | 否 | 是（`.github/**`、`scripts/ci/**`） | protected-change Grant |
| 8 安装 | 一轮安装覆盖全部常驻节点（今天是 TURING 与 desk-w-591；同一个包，§40 工具链，含 #949），策略 `/8` 但 `train.enabled=shadow`；这一轮里还没装上的节点保持 STANDBY，不标自动接班资格 | 是：每个节点各 UAC 加 Linux root | 否 | UAC |
| 9 影子与改 on | 影子清扫演练、Owner 复核，然后改策略为 on | 只改策略（UAC） | 否 | 复核；UAC |
| 10 清扫 | 41.9 第 5 条 | 否 | 否 | 无 |
| 11 关 strict | 关 `strict`、只留 merge，打开排位开关，定 `nonFrontRuns` | 否 | 否 | Owner |

- 第 2–6 步合入后今天的行为不变：`/7` 策略照旧拒 `on`（`policy.mjs:131`），新代码只在 `train.enabled=on` 时走；保活只由 on 模式的第 10 段调用；迁移记下的车头就是今天算出的车头，排位开关默认 `fifo`（41.5）。
- 第 7 步不同：守队程序一合入就在非列车模式下开始合并、更新队首的分支，这是 `86008583` 要的新行为（41.8）。
- **MergeAdmission v0.2 要改的**：§2.2 表里“KooYomi 合并队列（FIFO，队首持位）”改为车头之后按 Task 优先级（`3dcb583b`）；§4.1 第 5 步改为先以 shadow 安装、再改 on（41.9）；§4.3 第 2 步写明用“撤车头”请求（41.3）；§5 加两条：保活让排队认领最多活到 24 小时硬截止，Agent 改自己 Task 的优先级就能往前排（41.10）。
- **合同草稿要改的**：第 46、50 行 “join again at the back” 改为按优先级重新排位；第 47、51 行写清 auto-merge 与守队程序的分工（51 行说执行器从不合并，守队程序会合车头）；“renew about once an hour” 和 “Train version 1 needs no server change” 因保活和服务端改动不再成立；“Not changed” 一节里的 FIFO；Agent 能不能改自己 Task 的优先级。

### 41.2 单绿

- **现状**：第 8 段只给队首发绿（`publisher.mjs:89-92` `queueHeadReady`：持位、`merge:<repo>:main`、`tip` 等于 T、`until` 未过、是队首），写前读规则集和试合并（`publisher.mjs:131-146`），规则集按 `trainMode` 判（`train-rules.mjs:58-62`）。生产的发布者不传 `trainMode`（`startup.mjs:28`），所以一直是 `off`（`train-rules.mjs:13`）。检查说明只有一句“Complete Native control and exact subject verified”和观察哈希（`publisher.mjs:243`），没有车头、main@T、S（§19.7 N5）。没有任何地方调用 touch（`merge-slot-native.mjs:6`）。S ≠ H 的放宽只看作业本身（`job-v2.mjs:66-70`）。
- **清扫证明绑定车头**：第 10 段（on）开车头批次之前，同一次运行里先做增量清扫并确认（41.3），再写清扫证明，证明绑定（PR、H、车头认领、它成为车头的时刻 `since`、main 尖端 T）。只有确认完的运行才给出 `OPEN_FRONT_BATCH`。
- **`trainHeadReady`**：列车开着时，在 `queueHeadReady` 之外再要求（设计 §5.3 第 1、4 条）：
  - 作业是车头批次，S 等于第 10 段给这个 head 定的 S；
  - 同一次运行里 holders 正好一个、位置 1、`bound_pr` 是这个 PR；
  - `state\v2\train-sweep\` 里最新的证明的（PR、H、认领、T）等于这个作业的（T 即作业的 base），写于这个认领成为车头之后，不早于 `train.sweepFreshMs`（15 分钟），结论是“除车头当前 head 外没有未撤的绿”；
  - 本节点在改 on 之后（或接班之后）以 on 模式完成过一次全量清扫，其中的撤销全部两次读回确认；影子模式的清扫不算。接班时也可以用 41.6 的水位加增量代替。这与 41.7 兜底读的 `sweep` 是同一份记录；
  - 台账里没有未确认的撤销；
  - 写之前现读一次 `pulls?state=all&sort=updated&direction=desc`：证明之后有车头以外的 PR 更新过（新推送、重新打开、改 base），就不发绿。
  - 任一条不满足：零副作用 `TRAIN_SINGLE_GREEN_NOT_PROVEN`，批次停在 B，等下一次第 10 段。
- `startup.mjs:28` 把已装策略的 `train.enabled` 作为 `trainMode` 传给发布者；只有 `on` 时 `rulesetDecision` 才接受 `strict=false` 加只有 merge。
- **检查说明**（设计 §5.3 第 6 条）：summary 写 `front PR #<n>, head <H>, main@<T>, tested <S> (tree <树>)`，S = H 时写 `tested head`。这是给第 10 段、审核和 Owner 在 GitHub 上直接读出 T 与 S 用的；撤销不依赖它：`revokeCheck` 读回比较的是这次撤销自己写的标题和说明（`github.mjs:350-358`）。
- **touch green**：第 8 段（`independent-control-checks-v2/startup.mjs:17` 已持有节点的 CI Binding 令牌）settled 之后、同一次运行内，先读 holders 确认这个认领仍是位置 1，再调 `clued_work_merge_slot_touch_v1`（`ci_state: green`，`hard_cap_minutes` 取策略）。服务端对同一 head 只认第一次 green，给 30 分钟合并（迁移 `20261010112852`:145，`20261009010000`:69），仍受硬上限和租约约束。touch 失败不撤绿、不改结局，只记日志和回执。
- **列车关着时拒绝 S ≠ H**（§38.8 m3）：第 1 段（`formal-work-admission-check-v2/publisher.mjs`）和第 8 段在 `trainMode` 不是 `on` 时，对 `isTrainFrontJobV2` 的作业零副作用拒绝 `TRAIN_FRONT_JOB_WITHOUT_TRAIN`（干净终止，进 `stage-fact.mjs` 与 `classify.mjs` 的码表）。§38.8 的 n2（`refs.mjs` 和 staged 发布者前后两次读到的 `base.sha` 相同）、n3（读到的 PR base 写进准入事实）在同一个 PR 里做。
- **验收**：on 加 `strict` 关加只有 merge 时发绿；off、shadow 下 `strict` 关仍是 `STRICT_OFF_WITHOUT_TRAIN`；以下各自零副作用不发绿：两个 holder，证明属于别的 PR、别的 H、别的 T 或上一任车头，证明早于成为车头的时刻或过期，证明之后别的 PR 有更新，改 on 之后没有以 on 模式完成全量清扫（只有影子清扫也算没有），台账有未确认撤销；说明逐字；touch green 只在 settled 后调一次，失败不撤；S ≠ H 作业在 off、shadow 下第 1、8 段都拒；三份码表一致。

### 41.3 撤绿与清扫

- **现状**：
  - 按 id 撤销已有：`github.mjs:350-358` 的 `revokeCheck` 把检查改成 failure，读回一次，核对 id、App，以及结论和说明等于这次撤销写的；第 8 段的补偿撤销用它（`publisher.mjs:200`）。
  - 台账只记录（`green-ledger.mjs:14` 五个阶段）。影子只算“会撤哪些”（`train-facts.mjs:56-65`），每次最多比 30 个 head（`train-maintenance.mjs:23`），也不撤车头自己的绿。
  - PAUSE 时第 10 段不跑：tick 在 `executor.mjs:1096-1097` 就返回 PAUSED，第 10 段在其后（`:1117`）。
  - 第 12 段 `revocation-maintenance` 排在 HALT、PAUSE 检查之前（`executor.mjs:1075-1081`），有单独接受的资格（`revocation-run.mjs:29-38`，记录里的 `revocationMaintenanceQualification`）、intent/result 回执和退避（`revocation-maintenance.mjs:12`、`:37-58`）。它撤的是 KooYomi 发布流水要求撤的：按 Native 的 `revocations_list` 列出独立发布（`scripts/ci/clued-independent-revocation-controller.mjs` 的 `readIndependentRevocationBatch`），核对控制器已停后逐条对账（`scripts/ci/clued-independent-revoker.mjs:73-104`）。它不读绿色台账，不看合并队列和 main，读回只有一次。
- **撤一条**：只按 check run id。先 GET 这一条，核对 App 5368905、名字 `kooyumi-merge-slot`、head、结论 success（已是 failure 就记为已撤）；改成 failure，说明写原因；读回一次；30 秒后再读回一次，仍是 failure 才算确认，台账记 `revoked`（detail 带两次读回的时刻）。任何一步读不到或不符：这次撤销未确认，第 10 段结局 `TRAIN_REVOKE_UNCONFIRMED`，证明写“未确认”，第 8 段因此不发新绿，下一次第 10 段再来（MergeAdmission v0.2 R-c）。
- **撤谁**：
  - 不在 main、又不是车头当前 head 的绿；
  - 车头自己的绿，当 main 在列车之外移动了（main 尖端不等于这条绿的 T，台账的 `baseSha`；v0.2 R-b 第 3 条）。车头不出队，下一次第 10 段按新的 main 重开车头批次，计入这个 head 的两次上限（41.4），用完要推新提交；
  - Owner 的“撤车头”请求（v0.2 §4.3 第 2 步）：`requests\` 新合同 `clued.independent-ci.resident-revoke-head-request/1`，与 PAUSE 请求写在同一处；下一次第 10 段或只撤运行撤掉车头当前 head 的绿并两次读回确认，结果写进状态；超过 1 小时的请求拒绝。
- **增量清扫**（每次第 10 段）：
  - 本节点台账里最后阶段是 posted、settled 或 merged 的 head；
  - KooYomi 独立发布流水里 `kooyumi-merge-slot` 的发布（`work_claim_publications_v1` 有 `head_sha` 与 `check_run_id`，迁移 `20261011131755`；身份里有检查名，迁移 `20261029050000`）：每个常驻节点发的都在里面，所以它是撤销的来源，不只是对照。别的节点的台账没有直接通道，由流水代替：本节点的台账加上流水，就覆盖了所有节点的台账（41.10）；
  - 自上次清扫以来 GitHub 上更新过的 PR（`pulls?state=all&sort=updated&direction=desc`，翻到上次清扫的时刻为止）：当前 head、PR 的全部提交（普通推送换下的旧 head 在里面）、强推前后的提交（GraphQL `HeadRefForcePushedEvent`），重新打开或改了 base 的 PR 同样处理。
  - 对这些提交列出 App 5368905 的 `kooyumi-merge-slot` 成功，按上面“撤谁”处理；在 main 里的（判法同 `train-maintenance.mjs:59`）不撤。去掉 30 个的截断：列不完就是清扫不完整。
- **全量清扫**（第 15 代起按 §60 选择每轮读什么）：所有 PR（open 与 closed，全部分页）的当前 head、全部提交、强推前后的提交，加上本节点台账和整条发布流水，逐个列 App 5368905 的 `kooyumi-merge-slot`，按“撤谁”处理。REST 的 `pulls/{n}/commits` 最多返回 250 个提交：超过的 PR 算不完整，整轮作废并通知 Owner（GraphQL 是否同样限 250：未核实）。一次第 10 段 5 分钟放不下，所以分段：游标存在 `state\v2\train-sweep\`（clued-control，只新建，写法同台账）；一轮从开始到完成不得超过 `train.fullSweepMaxMs`（暂定 6 小时，第 9 步的影子演练实测后定），超了作废重来；完成时写证明（开始与完成时刻、main 尖端、车头、读过的 PR 与提交数、撤了几个、是否全部确认）。
- **读不到就失败关闭**：任何一页不完整（分页没到底、`complete` 不是 true、GraphQL 报错、限额、流水读不全）整轮作废，不写“干净”的证明；状态和 PR 页面显示“清扫未完成”。
- **台账清理**（§19.7 N2）：一个作用键最后阶段是两次读回确认的 `revoked`，或 `merged` 且 head 已在 main，超过 14 天就整组移到 `green-ledger\closed\<yyyy-mm>\`（同一 ACL）；列出只看顶层。台账只是来源之一，清理错了由流水和 GitHub 枚举兜住。
- **只撤模式**：train-run 的 mode 加 `revoke-only`。PAUSE 时执行器在 `executor.mjs:1096-1097` 返回 PAUSED 之前跑它（v0.2 §4.3），节奏同第 10 段。它管“撤谁”的三种（旧绿、main 在列车外移动后的车头绿、撤车头请求），做增量清扫、写证明；不开批次，不 touch、adopt、return，不保活。HALT 时不跑（41.10）。
- **第 12 段能不能复用**：调度外壳可以照搬（排在 HALT、PAUSE 检查之前，intent/result 回执，退避，只在空闲时）。撤销本身不复用：它的来源只有 KooYomi 流水里待撤的条目，资格要另行接受，读回只有一次，管不到强推、main 移动和台账。现装节点上第 12 段的资格是否已接受、是否在跑：未核实（41.10）。
- **验收**：一次撤销在 GET、改写、第一次读回、30 秒后读回各失败一例（不记 `revoked`，证明未确认，第 8 段不发绿）；增量清扫找到强推前的旧绿、普通推送换下的旧 head 的绿、只在别的节点发过的绿（来自流水，三个以上节点时每个节点各一例）、重新打开和改了 base 的 PR；main 在列车外移动时撤车头的绿；撤车头请求在 PAUSE 下生效、过期拒绝；超过 250 个提交的 PR 让全量作废；缺一页作废，超时重来；HALT 下不跑；清理只移确认过的组。

### 41.4 车头调度

- **现状**：只有影子判断：`decideShadow`（`train-facts.mjs:42-52`）给出 `OPEN_FRONT_BATCH`、`FRONT_NEEDS_MAIN_MERGE` 等，执行器只记进状态（`train.mjs:27-32`）；`runTrainStage` 只接受 shadow（`engine-windows.mjs:435`）；第 10 段只在调度没跑批次的拍子里跑，批次进行中不跑（`executor.mjs:1110-1117`）。中继在推导时才拒绝带 S 的 subject（`derive-batch.mjs:121`、`relay-entry-v2.mjs:54`），而 `relayPlan` 在那之前已写 `20-plan-intent`（`executor.mjs:2159-2165`）。第 8 段按 SHA 读 S（`publisher.mjs:140`、`:143`）。持有节点 CI Binding 令牌（`controllerPrincipal`，`resident-v2/entry-runtime.mjs:45-54`）的只有第 1、8、R、10、12 段的入口（第 11 段的探测另有自己的读取）；第 3、5、7 段的发布者没有。KooYomi 的队列在读取时按入队时间算（迁移 `20261009080000`:90），车头的各个时钟都不超过认领租约（同文件 `:60-69`）；touch、adopt、return 只认 ci-admission 角色的 Binding，都在 CI 签名白名单里（迁移 `20261010161848`:96-104）；常驻层的 Native 端口只有 holders（`merge-slot-native.mjs:9`）。认领租约 2 小时、硬截止 24 小时、续期 12 次（`20261009010000`:57-59），`expires_at <= hard_deadline_at` 是表约束（`20261001060000`:46）。
- **S 的来源**：只取 on 模式第 10 段的 `OPEN_FRONT_BATCH` 事实（T = main 尖端，H，S = 试合并，父提交 [T, H] 与它的树），而且是清扫确认之后的（41.2）。执行器据此往排队表写一行带 `testSha` 的 subject，这是唯一的产生者；触发文件仍不接受 `testSha`。受保护层的车头 H 必须含 T，否则是 `FRONT_NEEDS_MAIN_MERGE`，不开批次（MergeAdmission v0.2 §2.4）。
- **中继**：`relayPlan` 在写 `20-plan-intent` 之前，把带 `testSha` 的 subject 的全部角色留在本地（原因 `RELAY_TRAIN_FRONT_LOCAL`，§38.8 m1）。
- **S 被 GitHub 重算掉**（§38.8 n7）：GitHub 重新生成试合并后，旧 S 可能取不到。bundle 时取不到是 `BUNDLE_UNAVAILABLE`（§38.3，批次开始前，不计释放上限）；第 8 段按 SHA 读 S 时取不到（404），新码 `TRAIN_TEST_COMMIT_GONE`，与父提交已不是 [T, H] 一样：这一批干净结束，下一次第 10 段重读 S、开新批次，算这个 head 的第二次车头批次；第二次还不行就结束，要推新提交。读取的暂时性错误仍按 `TRAIN_TEST_MERGE_NOT_READY` 停靠。
- **硬上限**：报 running 之前，位子按续期时钟到 `greatest(merge_slot_at, since) + 2700 秒`（`20261009080000`:60-69 的 `until_from`），所以一个已等了 40 分钟的车头，批次第 1 段还没跑完位子就会过期。因此开车头批次的那一次第 10 段（它持有令牌）在清扫确认之后，先按“假如现在报 running”算剩余：`least(now + 90 分钟, since + slotHardCapMinutes, 保活后的 expires_at) − now`，`since` 是这个认领成为车头的时刻。剩余至少是 `train.frontBatchBudgetMs` 加一次第 8 段尝试（90 秒加助手余量）时，才报 `touch running`、再读一次 holders 确认 `until` 已按 running 时钟后移，然后给出 `OPEN_FRONT_BATCH`；不够就不报、不开，PR 页面请持有者让位子过期后重新入队（合同草稿 Change 3）。每个 head 最多两次车头批次（含 attempt 2 和上面两种重开）；车头批次计入每日额度（§36）。
- **谁调用、用哪个令牌**：都由通用助手以 clued-control 运行 Source B 的入口，用节点自己的 CI Binding 令牌（`controllerPrincipal`）；每次调用之前，同一次运行里先读 holders，要求不是 `admission_binding_required`，并且（保活以外）这个认领是位置 1、`bound_pr` 是这个 PR：
  - `touch running`：两次。第一次在开车头批次的那一次第 10 段（上一条“硬上限”）；第二次在车头批次的第 1 段（`formal-work-admission-check-v2/startup.mjs:14`），它的检查 settled 之后，刷新 running 时钟；`hard_cap_minutes` 都取 `train.slotHardCapMinutes`（60–180）。第 2–7 段没有令牌，不再刷新：批次从第 1 段起超过 90 分钟时（第 2–7 段上限合计 130 分钟，`layout.mjs:83-88`），位子在第 8 段之前过期，这一批以没就绪结束、不发绿。实际批次约 20 分钟（v0.2 §5），接受这个残余。
  - `touch green`：第 8 段 settled 之后（41.2）。
  - `touch failed`：第 3、5、7 段没有令牌，所以由批次结束后的第一次第 10 段报，但依据是执行器自己的账本，不是 GitHub 上的检查：train-run 作业（合同升 `/2`，C# 边界同步）带上 `frontOutcome`（PR、H、S、attempt、终局码）。执行器只在这一批是车头批次、账本说它已最终失败（不会再有 attempt 2）、失败属于 PR 本身（失败表 `deterministic-pr`，不是基础设施）时才填。第 10 段再核 holders 里这个认领仍是位置 1、PR 当前 head 仍是 H，才报 failed；服务端退位并发 CI 失败通知（迁移 `20261010112852` 的 failed 分支）。在此之前位子按 running 时钟占着，最多多占一个 `maintenanceEveryMs`。
  - adopt：第 10 段看到车头 PR 已合入、合并提交恰好 [T, H]、树等于 S 的树，调 `clued_work_claim_adopt_v1`（`pr_ref`、`merge_sha`）。树不同：`TRAIN_LANDED_TREE_MISMATCH`，写 PAUSE 请求、通知 Owner、不 adopt（v0.2 §3.3 第 2 条）。
  - return：第 10 段看到车头 PR 关闭未合入，调 `clued_work_merge_slot_return_v1`。车头换了 head 不 return：新 head 原位当车头，旧绿撤销。
  - 保活：第 10 段每次运行一次（下一条）。
  - 只有 ACTIVE 节点（41.6）。写端口加进 `merge-slot-native.mjs`（Source B）和 Native 端口（Source A）。
- **服务端（一次迁移）**：
  - adopt_v1、return_v1、touch_v1 不改（`20261006120000`:189、:223，`20261010112852`:79）。
  - **排队认领保活**：新函数 `clued_work_merge_queue_keepalive_v1(p_token_hash, {scope, repository, pr_refs})`，只认 ci-admission 角色的 Binding（同 touch），加进 CI 签名白名单。`pr_refs` 是调用方刚从 GitHub 读到、仍打开的 PR，最多 50 个。函数在 `work_claim_lock` 下先调 `work_claim_expire_due`：过期是惰性的（`20261001060000`:157-165），而队列把过了 `expires_at` 的 ACTIVE 认领照样算在内（`20261009080000`:74-76），所以不先过期就会把已过期的租约续活。然后只对这个 scope、这个仓库 merge ref 的队列里（41.5 记下的车头和算出的等候者）、`expires_at > now`、`bound_pr` 在列表里的认领：`expires_at := greatest(expires_at, least(now + lease_seconds, hard_deadline_at))`。不改 `lease_version`、续期次数、`progress_refs`、fence、`merge_slot_at` 和 CI 时钟；不碰已过期、已出队、不在队列里的认领；永远不超过 24 小时硬截止（表约束也挡着）。每个认领每小时最多一条回执 `WORK_CLAIM_QUEUE_KEPT_ALIVE`。到了硬截止的认领照旧过期出队；PR 页面提前 2 小时提醒持有者重新认领（按优先级重新排位）。盲区：别的 scope（例如 global）里的排队认领不在常驻层运行的 scope 里，holders 看不到，也不被保活（v0.2 §5 末条的同一盲区）。
  - **记下车头、按优先级排位**：41.5。
  - **节点 Source 记录**：41.6。
- **验收**：S 只来自清扫确认之后的第 10 段；带 S 的 subject 在 `20-plan-intent` 之前就留在本地；S 取不到时干净结束、重读、算第二次；开批次的第 10 段先报 running，剩余时间按 running 时钟、硬上限和租约算，不够不开（等了 40 分钟的车头也不会在第 1 段过期）；running 在开批次的第 10 段和第 1 段、green 在第 8 段、failed 在批次后的第 10 段，各自先核 holders；failed 只按 `frontOutcome` 报，非车头批次的失败、还会有 attempt 2 的失败、基础设施失败都不报；树不同就停车、不 adopt；return 只在关闭未合入时；STANDBY 和不当班的运行不写 KooYomi。§38.8 列的 S ≠ H 测试补齐：桥签发、HEAD = S ≠ H 的 worker 工作区、placement 密封候选的 HEAD 与打包内容（S、H、T）、C# 同批核对（`PureTestsV2.cs`）。迁移的 DB 测试：保活先过期再续、不复活已过期的租约、不动续期次数和 fence、不过硬截止、只认 ci-admission、不在队列里的认领不动、回执限频。

### 41.5 优先级（Decision `3dcb583b`，取代 `a5ea4be3`）

- **来源**：PR 的工作认领所指 KooYomi Task（认领的 `task_id`）的记录优先级 `public.clued_memories.priority`：`smallint`，默认 0，取值 0–100（迁移 `20260824014005`:11、:64）；Task 列表的索引按 `priority desc` 排（同文件 :95-98），所以数值大为高。2026-10-31 生产里在用的 Task 取值为 0、5、40。Task 没有截止日期字段（同日只读核对：表列与 `type_fields` 都没有），`a5ea4be3` 选的“截止日期”因此作废，Owner 改选优先级。
- **只排车头后面**：车头不受影响，任何 PR 都不能排到车头前面，所以绕不过“只有一个绿”（§22.5）。
- **次序**：优先级高的在前；同一优先级按入队时间，再按 claim_id。等候者的次序每次读取时按 Task 当时的优先级算。
- **车头在交接时定下**：今天的队列在读取时按入队时间算（`20261009080000`:90-91）；`work_claim_merge_queue_v1` 只记最后一个离开的条目（`head_left_at`、`left_queued_at`、`left_claim_id`，同文件 :35-42），出队靠与它比较入队次序，当前车头没有记下。迁移给这张表加两列（当前车头 claim、`since`），给认领加出队时刻。每次读队列的调用（认领视图、holders、touch、verify、保活）先在 `work_claim_lock` 下检查记下的车头是否已离开（释放、过期、去掉 merge ref、位子过期）；离开了就在同一次写里按当时的次序选出下一个车头并记下，离开者记出队时刻；新车头的位子按 `since` 算已经过期的，同样记出队、再选下一个。之后的读取只读记下的车头，不再重选。改优先级、切换 `fifo`/`priority` 都不改变当前车头，只影响下一次交接。
- **迁移时**：把迁移那一刻按今天规则算出的车头原样记下；开关为 `fifo` 时，下一个车头按入队时间选，结果与今天逐条相同。
- **开关**：每个 merge ref 一个，默认 `fifo`，Owner 在新合同发布、关 `strict` 的同一天打开（41.9）。开关放在哪、谁能改：41.10。
- **谁能改优先级**：Agent 能改自己 Task 的优先级，就能把自己往前排（41.10）。
- **验收**：车头永不被换（改优先级、切开关之后都一样）；交接时一次写定下一个车头，之后的读取不变；优先级高的先成车头；同优先级按入队，再按 claim_id；连续几个位子过期时逐个记出队；开关为 `fifo` 时现有队列 DB 测试原样通过。

### 41.6 多节点当班与备用（C9）

- **现状**：节点模式 ACTIVE、STANDBY、UNCERTAIN，不是 ACTIVE 就不开批次（`executor.mjs:366`、`:173`）；但 DEFERRED 是“安静”的结果，第 10 段照跑（`executor.mjs:169-170`、`:1117`）。没有角色时 holders 答 `admission_binding_required`，影子记 `NOT_ON_DUTY`（`merge-slot-native.mjs:5`、`train-maintenance.mjs:31-32`）。§34.4 的版本不一致只比一个节点的 Windows 与 Linux 两侧。PR 页面状态不带 Source（`pr-status.mjs`），`status.mjs:20` 的 `source` 是本机 `status.json` 里的，别的节点读不到：今天没有比较各节点 Source 的数据。
- **只有 ACTIVE 跑 on**：on 模式和只撤模式的第 10 段只在 ACTIVE 上跑；STANDBY、UNCERTAIN 不跑，状态写 `NOT_ON_DUTY`。影子模式照旧每个节点都跑、只读。
- **接班先清扫**：STANDBY → ACTIVE 之后、第一次发布（任何一段）之前，先完成接班清扫。服务端按节点记“全量清扫水位”：一个节点以 on 模式完成全量清扫、撤销全部确认时，第 10 段报一次（完成时刻、GitHub `updated` 游标、main 尖端），只认 ci-admission。接班节点从 holders 回答里读到最近一条水位：有，就从水位起做增量清扫，加上整条发布流水和本节点台账，一般一次第 10 段就能完成；没有水位才做全量清扫（最长 `fullSweepMaxMs`）。接班清扫期间调度推迟 `TRAIN_TAKEOVER_SWEEP_PENDING`，不发绿，但只撤和保活照跑，排队的认领不会因此过期。
- **撤别人的先核角色**：要撤的检查不在本节点台账里（别的节点发的，例如来自流水），同一运行内先读一次 holders；答 `admission_binding_required` 就不撤，本轮结论“不当班”。本节点台账里的（自己发的）撤销不要求角色：撤销只会更严（R-c）。
- **全部常驻节点同一个 Source**：开车的安装用同一个包，覆盖全部常驻节点（41.9）。数据来源放在服务端：41.6a 的心跳带节点名和 `ciSourceManifestSha256`，服务端按节点记下；holders 的回答加一个 `nodes` 字段，列出每个有资格的连接与最近 24 小时发过心跳的节点的名字、Source、自报状态、最近心跳时刻，以及看门狗最近一次运行的时刻。接班的节点（自动或 Owner 手动移交都一样）有了角色后，在第一次 on 运行时从这个回答里读其余每个节点的 Source：24 小时内有心跳的节点里只要有一个不同，就不跑 on 模式的第 10 段并通知 Owner；没有记录（第一次开车）照常。
- **验收**：STANDBY 不跑 on；接班清扫完成之前不发布，有水位走增量、没有水位走全量，期间只撤和保活照跑；撤别人的要角色、撤自己的不要；手动和自动接班时 Source 不同都不接 on，没有记录照常。

### 41.6a ci-admission 自动接班（Decision `199cf3de`，取代 `06cd3dd4`、`231a5dd9`）

- **现状**：交接只有 Owner 的一键移交：Native 两步 `clued_binding_role_handover_confirmation_issue_v1`、`clued_binding_role_handover_v1`（迁移 `20261023010000`:370、:419），第 2 步要求同一 Native 会话的一次性确认；检查在 `binding_role_handover_check_v1`（:332-349：来源持有且不是停车位，目标有效、有 `context:read`、还没有 ci-admission，交接后不会有第二个常驻节点持有者）；交接在 advisory 锁 `clued-binding-role:<owner>:ci-admission` 下做（:457）；新记录 5 分钟后生效（`binding_role_activation_delay_v1`，:55）。服务端今天不记任何节点的活动，节点现有的 KooYomi 调用也都当不了心跳：
  - 常驻服务按服务 SID 封了出站（§8，`CluedCIResident-BlockOutbound`）；
  - 第 11 段探测在 ACTIVE 上 30 分钟一次（`role-probe.mjs:7`），要求没有 HALT、没有 PAUSE、没有未结束的批次（`executor.mjs:1158`），暂停接新时被挡（`:1112`），字节漂移时先 HALT 返回（`:1161-1162`），代理忙时推迟（`:1170`）；
  - 第 10 段在列车关着时不跑（`executor.mjs:1316`、`train.mjs:18`），间隔可设到 60 分钟（`policy.mjs:132`）；
  - 批次的独占区里不插任何段（§18.1）。
- **触发只有一种：失联**（Decision `199cf3de`）。HALT 不再触发接班。
- **专用心跳**：
  - 谁发：companion（Owner 登录会话里的计划任务，§8.4，本来就能出网），每 10 分钟一次，与列车模式、PAUSE、HALT、批次进行与否都无关。它不经代理、不跑任何段，没有 GitHub 副作用。companion 本来就要在线，节点才能干活（打 bundle、轮询，§3 的表），所以它的心跳就是“这个节点还能工作”。
  - 用什么：每个节点一个只能发心跳的连接（新 scope，只能调心跳函数，读不了 context，也做不了别的），由 Owner 在 `/bindings` 上建，挂到该节点的 CI 连接名下（两步确认）。服务端把令牌绑定到这个节点，载荷里的节点名一律不用。
  - 令牌放哪：今天的 secrets 目录不给 Owner 读（`install-resident.ps1` 的 `Get-AclPlan`），安装脚本和 `companion.json` 也没有心跳令牌的位置。新增安装参数 `-HeartbeatTokenFile`：Owner 从 `/bindings` 下载令牌，随 UAC 安装放进新目录 `secrets\heartbeat\`（SYSTEM 与 Administrators 完全控制，Owner 只读），companion 从那里读。选这个、不选 SYSTEM 代发：companion 本来就在 Owner 会话里，代发要再加一个提权组件和一条通道。代价是 Owner 会话里跑的 Agent 也读得到令牌。可以接受，因为它只能发心跳：拿到它的人既不能读 context，也不能碰 CI、GitHub 或认领。残余风险：他能伪造自报 `HALTED` 或 `PAUSED`，让这个节点永不被自动交出；或者连续 30 分钟伪报“服务没在运行”，促成一次交接。后者只会交给 Owner 标过资格、心跳健康的某个其他节点，受 6 小时冷却和“不自动交回”约束，并且有回执和 @Owner。
  - 令牌出问题不当失联处理：companion 连续 3 次心跳失败，或令牌过期、被拒，就发 Windows 通知请 Owner 换令牌。服务端照常按失联判断（它分不出来），所以 Owner 要在 30 分钟内处理，或先关总开关。
  - 调什么：CI 门的动作 `ci_node_heartbeat`（经 `clued_work_verify_v1`，第 2 步 b 迁移 `20261031090000_merge_train_failover_v1.sql`；最初设想的单独函数 `clued_ci_node_heartbeat_v1` 未采用）。时刻由服务端写，节点改不了。另记自报：`ciSourceManifestSha256`（取自状态快照的 `versions.windows.ciSourceManifestSha256`，即执行器实际在跑的 Source，不取 companion 自己的配置）；模式（`ACTIVE`、`STANDBY`、`UNCERTAIN`）；最近一次探测结果；`HALTED`（任何码；`haltCode` 与时刻取自 `status.halt`，它只有 `{code, at}`，出事批次的 PR 与 head 取自 `status.current`，都供 Owner 看）；`PAUSED`；`INTAKE_PAUSED`（带 `until`，服务端截到 `now + 200 分钟`）；服务是否在运行（companion 查 SCM）；状态快照的年龄。只认每个节点最新的一条自报。
  - 状态及时：执行器在 HALT、PAUSE、暂停接新 latch 的同一 tick 把它写进状态快照；companion 看到状态变了就立即补发一次心跳，不等 10 分钟。
  - 报不出状态的情况：服务停了、服务进程不在了（快照很旧）、字节漂移检出到 HALT 写下之间、快照读不出。这些情况下心跳照发，状态写 `UNKNOWN`，并带“服务是否在运行”和快照年龄；服务端只按下面“失联”的第二种情形判断它们，不因单独一次 `UNKNOWN` 交接。代理忙只影响探测，不影响心跳。
  - 快照的新旧：服务进程里已有的 `startStatusTimer`（`status.mjs:162`，`service-main.mjs:96`）每 15 秒重写一次快照，不靠 tick，所以长段里快照照样是新的。快照新只能证明服务进程活着，不能证明执行器没卡住；卡在一段里的执行器由那一段自己的上限和 HALT 处理，不算失联。
  - holders 不改：入参不变（`20261010112852`:169 拒绝多余入参），不写任何记录；第 11 段探测仍是 `role-probe-entry.mjs:1` 说的只读入口，结果仍要求 `sideEffects === 0`（`executor.mjs:1173`），照今天的规则跑，不挪位置。holders 的回答在角色检查之后加 `nodes`、清扫水位和看门狗时刻，只有持有者读得到。
- **资格**：Owner 在 `/bindings` 上把连接标为“可自动接班的常驻节点”，并给出次序（新的每连接字段，例如 `resident_failover_rank`，空表示不可自动接班）。设置、取消和改次序与 `clued_binding_role_set_v1` 一样走两步一次性确认（`20261023010000`:248 起，确认核对在 :270-282），回执记谁、何时、次序。今天标两个：aa4969fb（TURING）与 44dc0846（DESK-W-591）；以后加节点时由 Owner 一并标；取消标记就退出。没标的连接永远不会被自动选中。
- **总开关**：每个账户一个“自动接班”开关，默认关，改它同样走两步确认。第 2 步迁移时各节点还跑旧包、不发心跳，所以要等第 9 步影子复核之后、每个标了资格的节点都装上新包并正常发心跳，Owner 才打开（41.9）。关着时看门狗照算、照告警，不交接。
- **看门狗**：`pg_cron` 每分钟跑一次 `clued_private.ci_admission_failover_tick_v1()`，作业名 `clued-ci-admission-failover`，写法同 `20261004120000`:366 的 `cron.schedule`。交接要同时满足：
  - 总开关开着，常驻节点持有者 X 是有资格的连接；
  - X 失联，两种情形都算：
    - 最近一次心跳早于 30 分钟前（3 个间隔）。Owner 注销也落在这里：companion 随之停下（§8.4，AtLogOn），而节点没有 companion 干不了活（打 bundle、轮询），所以算失联；
    - 心跳还在来，但连续 30 分钟每一条都报“服务没在运行”或“快照超过 30 分钟”（机器开着、服务进程不在了）；中间只要有一条报服务在运行且快照新鲜，计时就重来；
  - X 在被标资格之后、并且在总开关打开之后，至少发过一次心跳。从没发过心跳的持有者（旧包、刚标资格、心跳连接还没建）不算失联，只告警；
  - 接收端当时在工作：X 沉默的这 30 分钟里，Y 至少有 2 次心跳到达服务端。否则可能是服务端或网络中断了 30 分钟以上，恢复后 Y 的心跳先到；这种情况只告警，不交接。第二种失联不受这一条限制（X 自己的心跳在来）；
  - X 最近一条**读得出的**自报不是 `HALTED`（任何码）、`PAUSED`，也不是未到期的 `INTAKE_PAUSED`：`UNKNOWN` 不算读得出，往前找最近一条读得出的。这样的持有者永不被自动交出，两种失联都一样。暂停是 Owner 或兜底的决定：树不同时的自动 PAUSE（41.4）、companion 兜底的暂停（41.7）、回退第 1 步（41.9）；
  - 冷却：目标 Y 不能是 6 小时内（冷却时间）把角色交出去的节点，自动交出和 Owner 手动交出都算，交出时刻取该节点最近一条已结束的持有记录的结束时间。冷却只排除这一个节点，其余健康的已标资格节点照常可选。被自动交出的节点另有“不自动交回”（见下）排除，所以冷却实际管的是 Owner 手动交接之后的 6 小时；
  - 存在目标 Y：有资格、不是持有者、20 分钟内有心跳、自报模式是 `STANDBY` 且最近一次探测结果为 `not-held`、自报状态不是 `HALTED`、`PAUSED`、`INTAKE_PAUSED`、`UNKNOWN`、Source 与 X 最近记下的相同，并与其余 24 小时内有心跳的常驻节点都相同（这里的常驻节点指所有发心跳的常驻节点，不只是标了资格的；全部常驻节点同一个 Source，与 41.6 开车条件一致；没有记录的节点不比）。按 Owner 的次序取第一个这样的 Y。这就是“目标节点在线”的核对。
- **交接**：与一键移交同一条服务端路径：把 `clued_binding_role_handover_v1` 的核心拆成一个私有函数，一键移交和看门狗都调它。核心函数显式接收 owner（`pg_cron` 里没有 `authorization_owner_v12()`），取同一把 advisory 锁（`20261023010000`:457），同样过 `binding_role_handover_check_v1`；X 的记录当场结束，Y 得到用途 `resident-node`、5 分钟后生效的记录；停车位和别的持有者不动；任何时候至多一个常驻节点持有者。
- **审计与通知**：每次自动交接写回执 `CI_ADMISSION_AUTO_HANDOVER`，主体记“服务端看门狗”（不是 Native 会话），带 X、Y 和所有标了资格的节点的最近心跳与自报；同时写一条 KooYomi Note。算力面板只有 GitHub 令牌（`scripts/ci/self-hosted/compute_panel.py` 文件头），读不到 KooYomi；Y 可能没有打开的 PR，Y 的执行器在新记录生效前的 5 分钟里也没有角色。所以由 Y 的 companion 直接转达：心跳的回答带上这次自动交接，companion 用 Owner 的 gh 登录在算力面板的 Issue 里发一条带标记的评论（`<!-- clued-auto-handover:<回执 id> -->`，每个回执只发一次），评论里 @Owner；算力面板认这个标记，把它列进自己的动态，不重复 @。
- **看门狗自己活着**：每次 tick 记下时刻，心跳的回答带上它；companion 读到超过 5 分钟没有 tick，就在 PR 页面状态里写“自动接班看门狗未运行”，并发 Windows 通知。
- **不自动交回**：被自动交出的 X 不再被自动选中，直到 Owner 做过一次涉及 X 的手动交接（交给 X，或从 X 交出）；这只解除 X 自己，不解除别的节点。Owner 随时可以用一键移交改回。
- **没有可用目标**：不交接，只告警：回执 `CI_ADMISSION_FAILOVER_NO_TARGET` 与 KooYomi Note，每小时最多一次，`/bindings` 页面显示。例：A 自动交给 B 后 B 又失联，而 A 是其余唯一健康的已标资格节点；A 被“不自动交回”排除，于是落到这一条，B 继续持有，等 Owner 处理。三个以上节点也一样：A→B→C 之后候选用完就停在这里，不会来回抖。
- **旧节点上跑着的批次**：X 的记录结束后，它下一次实时准入（第 1 段或第 8 段的 Native 准入）被拒，按 §29 转 STANDBY，批次干净结束；X 已发布、还没合入的绿由 Y 的接班清扫撤掉（41.6：水位加增量，加整条流水）。交接后的 5 分钟里没有持有者，第 8 段不会发新绿。
- **验收**（DB 测试）：
  - 选择：没标资格的连接永远不被选中；按 Owner 的次序选；第一个不健康（心跳过期、不是 STANDBY、探测不是 not-held、HALTED、PAUSED、UNKNOWN、Source 不同）时选下一个；没有可用目标时不交接、只告警且限频；总开关关着时不交接。
  - 触发：29 分钟没心跳不触发、30 分钟触发；X 沉默期间 Y 只有 0 或 1 次心跳（服务端或网络中断）时只告警不交接，2 次才交接；X 在标资格之后或总开关打开之后从没发过心跳时只告警；心跳照来但连续报“服务没在运行”或“快照超过 30 分钟”，29 分钟不触发、30 分钟触发，中间夹一条正常心跳就重新计时；单独一次 `UNKNOWN` 不触发；自报 HALTED（任何码）、PAUSED 或未到期 INTAKE_PAUSED 的持有者，两种失联都永不被交出；最新一条是 `UNKNOWN` 时按之前最近一条读得出的自报判断（之前是 HALTED 或 PAUSED 就不交出，是 ACTIVE 就照常判断）；`INTAKE_PAUSED` 的 `until` 被截到 200 分钟；只认最新自报；冷却期内不选 6 小时内交出过角色的节点，但照常交给其余健康节点（三节点用例：Owner 手动把 A 交给 B，6 小时内 B 失联，交给 C，不交回 A）；被自动交出的连接不被自动选回，Owner 做过涉及它的手动交接后恢复，且只恢复它自己；候选用完时（A→B，B 失联，只剩被排除的 A）只告警不交接。
  - 交接与权限：交接后至多一个常驻节点持有者，停车位不动，新记录 5 分钟后生效；核心函数在 cron 下拿到显式 owner 和同一把锁；回执主体是看门狗；资格、次序、开关、心跳连接都要两步确认；心跳连接调不了心跳以外的任何函数；心跳记到令牌所绑的节点上，载荷里的节点名不起作用；节点改不了心跳时刻；holders 入参不变、不写记录。
  - 常驻层：心跳在 HALT、PAUSE、暂停接新、批次进行中、列车关着时照发；状态变化时立即补发；服务停了时心跳照发、状态 `UNKNOWN`、报服务没在运行；一个 45 分钟的长段里快照照样每 15 秒刷新，不被当成服务进程不在；Owner 注销后心跳停止；自报的 Source 取自 `versions.windows`，改 companion 配置不影响它；HALT 时 PR 与 head 取自 `current`；连续 3 次心跳失败或令牌过期时发 Windows 通知；`-HeartbeatTokenFile` 装进的目录 Owner 只读、别的普通用户读不到；Y 的 companion 在算力面板 Issue 发带标记的 @Owner 评论，每个回执只一次，面板不重复 @；看门狗超过 5 分钟没 tick 时告警；X 在下一次准入被拒后转 STANDBY。

### 41.7 策略 `on` 与保留

- **现状**：策略合同 `/7`（`policy.mjs:46`），`train.enabled` 只有 off、shadow，`on` 拒 `POLICY_TRAIN_ON_NOT_SUPPORTED`（`policy.mjs:66`、`:131`）；train-run 只接受 shadow（`train-run.mjs:16`、`FormalPublicBoundaryV2.cs:164`）；train facts 和常驻层摘要只认 shadow（`train-facts.mjs:85`、`train.mjs:28`、`:49`）；兜底只看“不在列车模式”（`ruleset-backstop.mjs:36`）。
- **合同 `/8`**：`train.enabled` 加 `on`；新字段 `slotHardCapMinutes`（60–180）、`frontBatchBudgetMs`、`sweepFreshMs`（默认 900000，即 15 分钟）、`fullSweepMaxMs`。`nonFrontRuns` 在 `/8` 起接受 `false`，但开车时仍写 `true`，关 `strict` 时由 Owner 改（v0.2 §2.2）。train-run 的 mode 加 `on`、`revoke-only`，影子模式下第 10 段也跑清扫但只记录不撤（41.9 第 2 条）；C# `ValidateTrainRun` 同步改；SwapBroker 第 10 行不变（仍 5 分钟）。train facts 升 `/2`，带清扫、证明与做了什么。
- **状态与兜底**：状态快照的 `train` 加 `sweep`（最近一次全量清扫完成的时刻、是否在这次开车或接班之后、结论）。companion 兜底：`strict=false` 而（不是 on，或 on 但全量清扫还没完成），就写暂停请求、紧急通知，文字加“清扫没完成”（v0.2 §4.1 末段）。
- **保留**（§22.5）：回执链和 `state\v2\receipts` 按月分段，启动只读当前段和索引；`train-shadow` 在开车前复核之前一条不删，之后留 90 天；`train-sweep` 的证明留 90 天；`green-ledger\closed\` 留 1 年。安全措施同 §35.3。实现（Task `b42419de`）：常驻层回执链在 `receipts.mjs` 按月封存；`state\v2\` 下这几类由 clued-control 写，常驻服务删不了，所以清理和 `state\v2\receipts` 的月度归档放在 Source B 的 `resident-v2/state-retention.mjs`，由第 10 段每天最多跑一次；outcome 仍写在平铺目录（读者按平铺路径找），过了月份且超过 7 天才移进 `<yyyy-mm>\`。Owner 的复核标记放在 `resident\owner\train-review\`（clued-control 可读）。
- **验收**：`/7` 策略照旧拒 on；`/8` 各字段的边界；C# 与 JS 同表；影子模式的清扫不写 GitHub；兜底在三种组合下的动作；复核之前影子记录一条不删。

### 41.8 守队程序，以及随车的常驻层改动

- **守队程序（Decision `86008583`）**：main `35c41fd6` 的 `.github/workflows/` 里还没有它。它在 `.github/**` 下，要 protected-change Grant。
  - 每次运行先读 `rules/branches/main`。读不到、没有 `required_status_checks`（应急停用）或 `CLUED_MERGE_ADMISSION_STATE` 是 `frozen`：什么都不做，两种模式都一样。
  - 非列车模式（`strict` 开）：定时工作流，用现有的 clued-admission App；打开的 PR 当前 head 上六项必需检查加项目 CI 都绿，就钉住 head 合入；队首的分支落后时更新它的分支。
  - 列车模式（`strict` 关）：不再更新任何分支；只合车头：当前 head 带 App 5368905 的 `kooyumi-merge-slot` 成功、六项加项目 CI 全绿的那个 PR，钉住 head，`merge_method` 只用 merge。符合条件的 PR 多于一个（违反 R-b）就什么都不合、通知 Owner。只测车头时项目 CI 是否都会在车头上跑：未核实。
  - 验收：两种模式各自的合并与更新分支；`strict` 关时绝不更新分支、绝不 squash 或 rebase；两个候选时不合；规则集停用、读不到或 `frozen` 时两种模式都不动。
- **每次发布的 binding（Decision `b30b1b79` 第 3 项）**：第 8 段 `publisher.mjs:106-112` 和第 1 段 `formal-work-admission-check-v2/publisher.mjs:84-87` 的 binding 都含整个 `mergeSlot`（含 `until`）和 `claimExpiresAt`。持有者在批次中途续期、保活或 touch 改了位子时钟，写前写后两次 binding 就不同，批次作废；`scripts/hooks/clued_work_claim_guard.py:918-921` 因此要求推送之前先入队、续够租约。两处都改为与 `sourceBinding`（`publisher.mjs:115-119`）一样只比 `state`、`ref`、`tip`、`queueHead`，去掉 `claimExpiresAt`。新鲜度仍要求租约没过（第 8 段 `publisher.mjs:86`，第 1 段同文件 :83）。之后钩子里 90 分钟租约的要求可以放宽（文档跟进）。
- **“立即探测”请求**：`requests\` 新合同 `clued.independent-ci.resident-probe-request/1`，只调 `roleProbe.markUrgent()`（`role-probe.mjs:28`），不直接改模式；超过 1 小时的请求拒绝；读后改名归档。
- 这几项与打包 Node 的改动 #949（main 上已合入，`a5345586`）同一轮安装（全部常驻节点）。#949 截至 2026-10-31 还没有装在任何节点（今天的 TURING 与 DESK 都还跑旧包）。
- **验收**：第 1、8 段各有一例批次中途续期、保活或 touch 不再作废发布；`tip` 或 `queueHead` 变了照旧作废；请求只置 urgent；过期请求拒绝。

### 41.9 开车步骤与回退

1. **合同**：Owner 接受 MergeAdmission v0.2（Decision，含 41.1 列出的改动）；合同草稿按 41.1 改完、独立审核，Owner 接受并给发布 Grant，KooYomi 发新版本。迁移已应用，排位开关仍是 `fifo`。
2. **以 shadow 安装全部常驻节点**：一轮安装，同一个包（§40 工具链，预演 `REHEARSAL_PASS`），含 Source A、B、常驻层和 #949；策略 `/8`，`train.enabled=shadow`；这一轮里没装上的节点保持 STANDBY、不标自动接班资格，装上后再标。§38.8 n5：bundle 回执合同升 `/2`（带四个测试字段），新 ws-prep 只认 `/2`，`build-bundle.ps1` 与 `prepare-workspaces.py` 装错一个就以合同不符明确拒绝；重装清单写明两者同装。影子模式下第 10 段照跑增量和全量清扫但不撤：记下会撤的每一条，实测一轮全量清扫的调用数和时长（用来定 `fullSweepMaxMs`）。
3. **影子复核**：从 `train-run` 回执和 `train-shadow` 记录离线算出会撤几个、车头首次运行失败率、全量清扫时长，以及 §22.2 第 5 条的其余各项，交 Owner 复核一次；`nonFrontRuns` 的选择也用这份数据（v0.2 §2.2）。同时核对每个常驻节点的心跳在 holders 回答的 `nodes` 里正常、看门狗在走；Owner 这时才打开自动接班总开关（41.6a）。
4. **改 on**：Owner 一次 UAC 把策略改成 `train.enabled=on`、`nonFrontRuns=true`。选在没有 PR 等合并的时候：之后的清扫会撤掉说明里没有 main@T 的旧绿。
5. **清扫**：ACTIVE 节点以 on 模式做一次全量清扫（设计第 5 步），撤销全部两次读回确认，完成时写服务端水位（41.6）；再在列车模式下做一次，确认除车头外没有绿（第 6 步）。影子模式的清扫不算。STANDBY 不清扫，接班时按水位做增量（41.6）。清扫失败就停在这一步。
6. **Owner**：在规则集里同一次保存关 `strict`、合并方式只留 merge；打开排位开关；`nonFrontRuns` 改成自己选的值（UAC）。
7. **头 10 次合入**：第 10 段每次核对落地的树等于 S 的树并写回执，汇总报给 Owner；不符就 `TRAIN_LANDED_TREE_MISMATCH` 停车。

**回退**（v0.2 §4.2）：Owner 写暂停请求 → 只撤模式的第 10 段确认没有别的绿（需要时加撤车头请求）→ `strict` 开回 → `train.enabled=off`（UAC），排位开关回 `fifo`（当前车头不变）。守队程序读到 `strict` 开就回到非列车模式，不用另改。任何一步失败就停在原地，不关 `strict`。

**验收**：离线演练加几步：shadow 安装后清扫只记录不撤；改 on 后清扫完成之前不发绿；清扫失败停在第 5 步；`strict` 关后一个车头合入、adopt、下一个车头开批次；main 在列车外移动时车头的绿被撤；回退之后列车停，第 8 段在 `strict` 开时照旧发绿。

### 41.10 待审问题

1. 第 12 段在现装节点上的资格是否已接受、是否在跑（未核实）；只撤模式要不要像第 12 段的 `allowWhileHalted` 那样在 HALT 下也跑。
2. 保活的形式：本节选“常驻层报告打开的 PR，服务端延长”。另一种是服务端按“在队列里、绑了 PR、没被 adopt 或 return”自己延长，不需要调用方，但 PR 关了而没人调 return 时会一直占位到硬截止。
3. 排位是否只认 Owner 设的优先级：Agent 能改自己 Task 的优先级，就能往前排；合同草稿要写明 Agent 能不能改。
4. 排位开关放在哪（服务端表还是 Owner 的 Native 设置）、谁能改。
5. 别的节点的台账没有直接通道，本节用 KooYomi 流水代替；要不要把台账也同步到服务端。读流水用第 12 段已用的 `revocations_list` 通道还是新的只读函数（`revocations_list` 是否列出已对账的发布：未核实）。
6. 全量清扫的量：PR 已到 #951，由第 9 步的影子演练实测；超过 250 个提交的 PR 怎么枚举（GraphQL 的上限未核实）。
7. 回执链分段的做法，以及现装节点已有回执怎么迁过去。
8. 车头全绿时由 Agent 的 auto-merge 还是守队程序合入：两者都是钉 head 的 merge，重复无害；合同草稿是否还保留 Agent 开 auto-merge 这一步，与草稿一起定。
9. `binding_role_admits_v1` 也放行用途为“其他”的 ci-admission 连接（WorkClaimAdmission §4.4 的 C10 一条），它们也能调 touch、adopt、return 和保活；要不要限定为 `resident-node`。
10. 自动接班：冷却 6 小时是否合适；告警与 @Owner 经 Y 的 PR 页面转达，Y 不在线时 Owner 只能从 KooYomi 和 `/bindings` 看到。

## 42. 原地升级通道 v2：换 Source 不卸载重装、失败自动回滚、任意多个节点滚动升级（Task `018da927`；相关 `09052ffe`、`1abde401`、`6451a55d`）

依据：Owner 两个首要目标“全部算力可调度”“完整的 CI/CD”（Decision `afec9be8`），排序 `02e4374a` 第 4 项；通道本体的决定 `dda41297`、`3b7a45ed`、`b1dd8a84`、`19baf5ec`；任意多个节点的常设规则 `d6eef30e`。本节不改 §34 以前的任何结论，只回答一个问题：**通道已经装在节点上了，为什么 2026-10-31 的 TURING 换 Source 仍然要整套卸载重装（约十二个 Owner 步骤：暂停、Linux A、Linux B（root）、UAC 启动器、rearm、登记）**，以及怎样把这些缺口补上。

### 42.1 现状核查：通道能做什么、卡在哪里

**已经有、并且装在 TURING 上的**（升级代理 `upgrader/`、`windows/upgrade-apply.ps1`、`UpgraderServiceHost.cs`、`request-upgrade.ps1`、Linux `clued-ci-upgrade-linux`、常驻层接线 §34）：

- 一次升级的完整状态机（`upgrader/src/machine.mjs` 文件头）：ACCEPT（核包、白名单 plan）→ Grant（KooYomi 页面批准 `ci.resident_upgrade`，资源 `ci-resident:<node>/<包 sha>`）→ intake hold → 等批次自然结束 → 暂停并确认 → 两侧增量暂存 → 停服 → 两侧切换 → 启动 → verify → 恢复 → 保留 3 代。
- verify、启动或切换失败自动回滚到上一代（`ROLLED_BACK_PAUSED`，节点保持暂停并通知，Decision `dda41297` 第 3 项）；回滚也失败才要 Owner（`ROLLBACK_FAILED`）。
- 每一步只新建 journal 记录，断电、重启后从 journal 续跑；包只当数据读一次；签名 Source、包哈希、policy 的三个 manifest 钉值、SCM binPath 钉值全部保留（§34.8）。
- 唯一一次真机使用（op `8c5efb1a`，第 3 批）因为调用 PowerShell 时缺 `PATHEXT` 在 stage-windows 被拒并干净撤回（Note `ee73b1a0`）；修复 `a0e15a91` 已随 r7 和 10-31 的整套重装装上。

**卡住的地方**（逐条有出处；“轨”见 42.2）：

| # | 缺口 | 出处 | 后果 | 处理 |
|---|---|---|---|---|
| a | **仓库里没有升级包的打包工具**。`reinstall/build.ps1` 只出 `--fresh-install` 包、按新 Decision 写全部 record ref；第 3 批那套“沿用 ref、打 bundle、派生角色、对现场跑 ACCEPT 预检”的 r6 脚本在仓库外，已不存在 | `reinstall/build.ps1`；笔记 `a3701d3d-r6-原地升级包` | 每次换 Source，现成能走的路只有整套重装 | 轨 1：`rollout/build-upgrade.ps1`、`rollout/precheck.mjs` |
| b | **节点身份冻结了全部接受 ref**：`src/node-identity.mjs:16-19` 把 sourceAcceptanceRef、ownerPackageAcceptanceRef、installationReceiptRef、ownerDecisionRef 等算进 `nodeIdentitySha256`，而 `upgrader/src/plan.mjs:60` 要求新包的身份等于已装的 | Note `45e0ed29`；Decision `b1dd8a84`、`19baf5ec` 第 2 项 | 新的 Owner 接受写不进 record，只能写进 policy 的 `ownerAcceptance`、包的 `acceptance.decisionRef` 和 Grant | 轨 1：按 `b1dd8a84` 沿用已装 ref（工具自动做、自动核对）；轨 2：身份 `/2` 只含机器身份 |
| c | **通道冻结范围太大**：升级包永远带上“构建它的升级代理”的清单（§34.8），代理代码 = `upgrader/src/*` + 它传递导入的 `src/canonical`、`store`、`inbox`、`intake-pause`、`upgrade-mailbox`、`instance-lock` + `windows/upgrade-apply.ps1`；Linux 升级工具和签名器同理 | `plan.mjs:56`；`clued-ci-upgrade-linux:725-728` | 只要这几个常驻模块有一字改动，整批改动都要整套重装（`UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL`），而且要到 ACCEPT 才知道 | 轨 1：预检提前报出并列出是哪几个文件（Windows 副本，以及 Linux 工具、签名器和工具清单）；轨 2：代理自更新（42.5.3） |
| d | **一次升级 = 一个节点 × 一个包 × 一个 Grant**；移交 ci-admission 只有 Owner 在 `/bindings` 的一键移交（Native 两步确认，§41.6） | `upgrader/src/request.mjs:47-52`；`20261023010000`:370、:419 | N 个节点要 N 次页面批准，外加一次移交 | 轨 1：N 次批准 + 1 次移交，都不用 UAC；轨 2 + 服务端 PR-0b：一次 rollout Grant，自动计划内移交 |
| e | **没有滚动编排**：没有任何东西阻止在当班节点上升级；顺序（先待命、后当班）只写在运行手册里 | `docs/maintenance/independent-ci.md`“升级顺序” | 一次误操作就停 CI | 轨 1：`rollout/rollout.mjs next` 只给出合规的下一步；轨 2：升级代理自己的当班闸 |
| f | 升级代理调用 csc 时没有 TEMP，临时文件落在 `C:\Windows\` | §34.8 末段；Decision `19baf5ec` 第 2 项 | 未真机验证；第一次真实 Compile 才知道 | 轨 1：第 2 阶段烟测专门核对；轨 2：固定的管理员专用临时目录 |
| g | **单向的状态变化**（例如 §41 的回执按月分段）：plan 要求新旧两版互相读得懂对方的 state| `upgrader/src/plan.mjs:73-76` | 这类包在 ACCEPT 被拒（`UPGRADE_STATE_COMPAT_REFUSED`），否则回滚后旧代读不懂新状态 | 规则：先扩后缩，拆成两次升级（42.4.4）；不放宽检查 |
| h | 秘密（心跳令牌换新、补装）不在通道里 | `reinstall/README.md` 第 4 节 | 换令牌仍要整套重装 | 不在本节；另立 Task：提权小工具 |
| i | 10-31 重装踩到的 SeServiceLogonRight 检查（PR #965）、登记工具（PR #966）、代数 adopt 都在**首装路径**上 | `install-resident.ps1`；`registration/` | — | 原地升级不碰账户、权限、服务、登记；代数 +1，不 adopt |
| j | 整套重装把两侧都重新 adopt 为第 1 代，没有可以回退的上一代 | 安装波清单第 5 节 | 重装之后的第一次失败不能自动回滚 | 通道用起来之后自然消失：第 2 代起总有上一代 |

结论：**通道本身在 TURING 上是可用的**（只要改动不碰 c 列的冻结文件、不需要新秘密、state 双向兼容）。今晚之所以整套重装，直接原因是 a（没有打包工具），其次是 b、c、d、e 没人收拾。

### 42.2 两条轨

- **轨 1（PR #970，已合入 `850e538f`；装上即用，不需要再装任何东西）**：`rollout/` 工具链，用**节点上已装的**升级代理。每个节点每次升级：Owner 在页面点一次批准；滚动升级再加一次 `/bindings` 移交；没有 UAC，没有 root 步骤。
- **轨 2（代码另一个 PR，随下一次已经要做的整套重装装上；之后通道自己也能原地升级）**：身份 `/2`、升级代理的当班闸和 rollout Grant 客户端、代理自更新、固定 TEMP。配套服务端 PR-0b（clued-cloud 迁移，走 `migration.production`）：rollout Grant 资源与计划内移交。轨 2 装上之后：一次 rollout 只要 Owner 在页面点一次。

两条轨的信任模型相同：只认 Owner 在 KooYomi 页面上对**精确哈希**的批准；包只当数据；签名 Source 和全部现有钉值保持强制；Agent 不能自开 Grant、不能替 Owner 点。

### 42.3 轨 1：`rollout/` 工具链（非提权、只读主机、只在 workDir 下新建文件）

#### 42.3.1 打包：`rollout/build-upgrade.ps1`

```
build-upgrade.ps1 -Config <reinstall-config.json> -Commit <40hex> -InstalledPackage <现装包目录> [-Final -DecisionRef <uuid> -ReceiptRef <uuid>] [-StateCompat <file>]
```

与 `reinstall/build.ps1` 共用同一份构建配置和 `reinstall/tools/` 下同一组工具（`tree.py`、`record-inputs.py`、`check-record.mjs`、`node-inputs.py`、`linux-pins.py`），区别只有这几处：

1. **record 的接受 ref 沿用现装包**（Decision `b1dd8a84`）：`rollout/tools/upgrade-config.py` 把构建配置的 `basePackage` 换成现装包，`record-inputs.py` 不带任何 `--ref` 运行，于是 9 个 ref、`acceptedAt` 和 `validUntil` 都原样取自现装包的 record。新包的 `nodeIdentitySha256` 必须等于现装包的，否则 `UPGRADE_NODE_IDENTITY_WOULD_CHANGE`（例如换了 App 私钥或 CI 连接：那要整套重装）；节点档案同理（`UPGRADE_NODE_PROFILE_WOULD_CHANGE`）。
   - 这样做的两个后果要知道：沿用的 `validUntil` 接近到期时，升级包也随之到期；新 Source 的角色 policy 和 qualification（Linux stage 用 `derive_role` 按 `controllerRelay.sourceAcceptanceRef` 派生）写的仍是**首装时**的 Source 接受 ref。新接受只在 policy、包的 `acceptance`、request、Grant 和 KooYomi 里。轨 2 的身份 `/2`（42.5.1）消除这两点。
2. **Owner 对这次升级的接受**只写进 policy 的 `ownerAcceptance`（`-DecisionRef`、`-ReceiptRef`，由 `node-inputs.py`），再由 build-package 写进包的 `acceptance.decisionRef`，最后进 request 和 Grant。
3. **现装包必须就是节点上正在跑的那一代**：它的 `package-manifest.json` 哈希等于节点 `upgrade\current.json` 的 `packageManifestSha256`（Owner 可读），record 的节点就是配置的节点，并且它是带升级代理的 `/4` 包；否则分别是 `INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION`、`INSTALLED_PACKAGE_IS_FOR_ANOTHER_NODE`、`INSTALLED_PACKAGE_NOT_AN_UPGRADER_PACKAGE`。
4. **不带 `--fresh-install`**；带 `--source-v2`：
   - bundle：新建的裸仓库只放 `refs/heads/accepted` 指向该提交，`git bundle create` 一次（重建时复用同一个文件），`git bundle verify`，`list-heads` 必须恰好是这一行；
   - `rolesDerivedSha256`：`rollout/tools/roles-derived.py` 先确认提交树里的冻结 Linux 工具字节等于节点 version facts 的 `upgradeToolSha256`，再载入它，用**它自己的** `derive_role` 和 `canonical_bytes`，对配置里 root 复制的现装 `roles-v3` 副本（每个 policy 和 qualification 文件都按 version facts 核对哈希；facts 必须是 1 小时内的）和新提交的文件（`git ls-tree` 必须是普通文件、`cat-file` 不能为空，与 stage 的 `read_regular` 一致）计算。stage 会用同一段代码再算一次核对（`ROLES_DERIVED_MISMATCH`）；
   - 外部钉值：`linux-pins.py pins`（source-v2 下取新提交的文件），构建后 `linux-pins.py check`。
5. `stateCompat` 默认取现装包的值（经 Python 原样复制，避免 PowerShell 5.1 把单元素数组变成数字）；Source 改了 state 格式时由作者用 `-StateCompat` 显式给出，预检核对双向可读（42.4.4）。
6. 同一份输入（同一个 bundle 文件）再构建一次，包 sha 必须相同。
7. 最后自动跑一次预检（42.3.2），输出一行 JSON：包目录、包 sha、`grantResource`、预检结论；final 且预检通过时给出可以直接运行的 request 命令（用**已装**常驻目录里的 `request-upgrade.ps1`，路径带引号）。

DRAFT（不带 `-Final`）时 policy 用占位 Decision，预检照跑；final 拒绝占位值。

#### 42.3.2 预检：`rollout/precheck.mjs`（ACCEPT 的只读预演）

```
node rollout/precheck.mjs --root C:\ProgramData\CluedIndependentCI\resident --package <dir> --package-sha <hex> --acceptance <uuid> --installed-package <现装包目录>
```

- **用节点上真正会做决定的代码**，而且在信任它之前不执行包里的任何代码：
  1. 已装回执 `install\install-receipt.json` 的 `upgrader.manifestSha256` 必须等于现装包的；新包声称的值不同，就是 `PRECHECK_REFUSED` / `UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL`，并与现装包的升级代理清单逐文件比较，列出变化（`changedFrozenFiles`）。作者据此把这些改动挪到轨 2 的自更新，或者接受整套重装。
  2. 冻结的 Linux 升级工具、签名器和它们的清单（`clued-ci-upgrade-linux` 的 `UPGRADE_FILES`）逐个与现装包比较，不同就是同一个码（`detail: linux-upgrade-tool`），否则 Linux stage 会在 Owner 批准之后拒绝。
  3. 包里升级代理副本的每个文件按清单核对哈希，再用**本检出自己的** `canonical.mjs` 算出副本清单的哈希，必须等于已装的。只有到这一步，包里的副本才逐字节就是节点上冻结的那份；预检这时才 import 它的 `readPackageOnce`、`buildPlan` 和 `Generations`，与 ACCEPT 走同一段代码。
- 节点状态：`upgrade\current.json`、`install\install-receipt.json`、各槽的现值哈希和内容寻址目录。升级代理配置是管理员专用的，不读；它要的 `node`、`nodeProfileSha256`、`ownerSid` 从已装的 `config\policy.json` 取，两者由同一份节点档案写出（残余：两者若不一致，节点的答案可能不同）。
- 非提权读不到的槽（例如 `helpers\controller-formal-generic-v2.exe`）列在 `unreadableSlots` 里，用占位哈希继续算下去；结论是 `PRECHECK_PASS_EXCEPT_UNREADABLE_SLOTS`。升级代理以 LocalSystem 运行，读得到。
- 另外核对 version facts 的 `upgradeToolSha256` 等于包里的工具。只记 `warnings`、不拒绝的：进行中的 op、HALT、`versions.consistent` 为 false、Linux 有暂存代、pins 不成立、Linux 代数不是当前代、本节点当班（要先移交）。这些会变，ACCEPT 之后由状态机处理（延后或拒绝）。
- 不写任何东西；输出 `clued.independent-ci.upgrade-precheck/1`。

#### 42.3.3 滚动升级：`rollout/rollout.mjs`

一次 rollout = 同一个 Owner 接受、同一个 Source（全部节点的 `ciSourceManifestSha256` 相同，只有节点档案和身份不同）、每个节点一个包。

```
node rollout/rollout.mjs plan    --out <rollout.json> --decision <uuid> --package <node>=<dir> [--package <node>=<dir> ...]
node rollout/rollout.mjs observe --root <ROOT> --out <observation.json>                       # 在每个节点上、非提权
node rollout/rollout.mjs next    --plan <rollout.json> --observation <file> [...] [--now <ISO>] [--allow-active-upgrade] [--handover-issued-at <ISO>]
```

- `plan`：用升级代理的 `readPackageOnce` 读每个包一次并核对：节点名唯一；包的节点（record 的 `node.nodeName`）就是 `<node>`；全部包的 `ciSourceManifestSha256`、`sourceManifestSha256` 相同，`acceptance.decisionRef` 等于 `--decision`。写出 `clued.independent-ci.rollout-plan/1`：`{contract, decisionRef, createdAt, ciSourceManifestSha256, sourceManifestSha256, nodes: [{node, packageManifestSha256, residentManifestSha256, grantResource}]}`（节点按名字排序），以及它的规范哈希 `rolloutSha256`。
- `observe`：每个节点的 Agent 在本机非提权运行，记下本节点的 `state\status.json`（`node.name`、`node.mode`、`halt`、`paused`、`versions.consistent`、`writtenAt`）、`upgrade\current.json`（代数、包 sha）、`upgrade\status.json`（进行中的 op、最近的结局及其时刻）。只读，读不到的文件列在 `unreadable` 里，从不猜。输出 `clued.independent-ci.rollout-observation/1`，经共享笔记或 KooYomi 交给协调者。
- `next`：**纯函数**，输入 plan、各节点最近的 observation 和时钟，按下面的顺序给出唯一的下一步：

| 结果 | 条件 |
|---|---|
| `BLOCKED ROLLOUT_NODE_NOT_IN_PLAN` | 观察到 plan 以外的节点 |
| `WAIT` | 缺某节点的 observation，或它不完整，或超过 15 分钟（`ROLLOUT_OBSERVATION_*`） |
| `BLOCKED ROLLOUT_RESIDENT_NOT_WRITING_STATUS` | 常驻的 `status.json` 比 observation 早 15 分钟以上 |
| `BLOCKED ROLLOUT_NODE_HALTED` | 有节点 HALT |
| `BLOCKED ROLLOUT_NODE_ROLLED_BACK` / `ROLLOUT_NODE_UPGRADE_REFUSED` | 某节点最近的结局是 ROLLBACK_FAILED（不论何时）；或者它还没到目标包，而结局为 ROLLED_BACK_PAUSED，或 REFUSED、GRANT_REJECTED、GRANT_EXPIRED、STALE、CANCELLED，时刻不早于 plan 的 `createdAt`（更早的属于上一次 rollout，改好包重新 plan 即可；没有时刻的按本次算）。升级代理一直保留最后一个结局，所以 Owner 看过（ROLLBACK_FAILED 要先提权 `-Recover`）之后，协调者用 `--ack-op <opId>` 确认那一个 op，它就不再阻塞 |
| `WAIT ROLLOUT_UPGRADE_IN_PROGRESS` | 有节点的升级 op 还在进行 |
| `BLOCKED ROLLOUT_TWO_ACTIVE`、`WAIT ROLLOUT_NODE_UNCERTAIN` | 两个当班（移交请求后 15 分钟内是 `WAIT ROLLOUT_HANDOVER_PENDING`：角色移动时两边可能短暂都报 ACTIVE）；有节点处于 UNCERTAIN（移交生效前后常见） |
| `DONE` | 每个节点都到了目标包、`consistent` 为 true、没有暂停，并且恰好一个当班节点在 plan 里（否则 `WAIT ROLLOUT_VERSIONS_NOT_CONSISTENT`、`BLOCKED ROLLOUT_NODE_PAUSED`、`BLOCKED ROLLOUT_NO_ACTIVE_NODE_IN_PLAN`） |
| `UPGRADE <node>` | 还没到目标包、STANDBY、未暂停的节点里名字最小的一个（还没到目标包的待命节点都暂停着：`BLOCKED ROLLOUT_STANDBY_PAUSED`） |
| `HANDOVER <from> → <to>` | 待命节点全部到了目标包，当班节点还没有；`<to>` 是已到目标包、`consistent`、未暂停的待命节点里名字最小的。协调者请 Owner 移交时记下时刻，用 `--handover-issued-at` 传入：之后 15 分钟内同一步是 `WAIT ROLLOUT_HANDOVER_PENDING`，不会再弹第二次 |
| `BLOCKED ROLLOUT_NO_STANDBY` / `ROLLOUT_NO_HEALTHY_UPGRADED_STANDBY` | 根本没有待命节点；有待命节点，但没有一个已升级且健康 |

- 当班节点从不出现在 `UPGRADE` 里。只有一个节点、没有待命节点时，`next --allow-active-upgrade` 才会给出 `UPGRADE <当班节点>`，并标 `ciPause: true`；这个开关只在 Owner 选了“接受暂停 CI”之后由协调者加上（弹窗）。
- 一次只升一个：保证任何时刻至少有一个节点没在升级、可以接班；任意多个节点都按同一规则推进（`d6eef30e`）。
- 执行 `UPGRADE <node>`：该节点的 Agent 在 Owner 会话里非提权运行 build-upgrade 输出的 request 命令；Owner 在 `upgrade\status.json` 的 `confirmUrl` 页面批准一次。执行 `HANDOVER`：Owner 在 `/bindings` 一键移交（5 分钟后生效）。两者都由协调者以弹窗请 Owner 授权，Agent 不替 Owner 点。

#### 42.3.4 轨 1 的 Owner 动作

| | 今天的整套重装（每节点） | 轨 1（每次 rollout） | 轨 2 + PR-0b（每次 rollout） |
|---|---|---|---|
| UAC | 2（启动器、rearm） | 0 | 0 |
| Linux root | 2（A、B），出错再加 resume | 0 | 0 |
| 页面批准 | 0 | 每节点 1 次 | 全部节点 1 次 |
| 移交 | 当班节点 1 次 | 1 次 | 0（计划内移交由 rollout Grant 授权） |
| 停 CI | 当班节点重装期间 35–65 分钟（不先移交时） | 0 | 0 |

### 42.4 轨 1 的边界与规则

1. **能走轨 1 的改动**：常驻层（`resident\<sha>\`）、CI Source（`source\<sha>\`、Linux `source-v2`、`resident-v1`、角色重钉）、policy、companion 配置、record 文件、由已装 Source 编译的服务宿主和 helper。
2. **不能走轨 1、预检会提前报出的**：升级代理代码及其传递导入的 6 个常驻模块、`upgrade-apply.ps1`、Linux 升级工具和签名器、节点档案、节点身份（换钥、换连接）、目录布局、ACL、账户、SDDL、服务、秘密。
3. **改冻结模块的作者规则**：能不改就不改；必须改时把改动单独成一批，等轨 2 的自更新，或并入下一次已计划的整套重装。不要和普通 Source 改动混在一起，否则整批都被拖进重装。
4. **state 先扩后缩**：要改 state 格式时拆成两次升级。第 1 次（扩）：新代码能读新旧两种格式，仍只写旧格式，`stateCompat` 双向可读；第 2 次（缩）：开始写新格式，旧格式的读法保留到下一次。每一次都能自动回滚到上一代。§41 的回执按月分段这类一次到位的改动，只能整套重装。
5. **Grant 资源仍是 `ci-resident:<node>/<包 sha>`**，一个 op 一次；同一包重复请求重放同一次使用；被拒或过期的要新 Grant。

### 42.5 轨 2：随下一次整套重装装上的通道改动（代码另一个 PR；本 PR 只写设计）

#### 42.5.1 节点身份 `/2`

- `nodeIdentitySha256` 只覆盖机器身份：`nodeName`、`appKeyId`、`appPublicKeySha256Base64`、`ciTokenPinSha256`、`ciPrincipalBindingId`、`ciPrincipalRoleRef`、`hostQualificationRef`、`ciPrincipalQualificationRef`。
- 每次接受都会变的 `sourceAcceptanceRef`、`ownerAuthorizationRef`、`publisherQualificationRef`、`ownerPackageAcceptanceRef`、`installationReceiptRef`、`ownerDecisionRef`、`ownerReceiptRef` 仍写在 record 里，随包更新，但不进身份。升级代理改为核对它们等于包的 `acceptance`；今天的 `acceptance` 只有 `{decisionRef}`，所以包合同要升一版，`acceptance` 加上回执 ref（`receiptRef`）。
- 同时改 `install-resident.ps1:364`、`verify-resident.ps1:217` 的 PowerShell 规范化（`ConvertTo-NodeIdentityCanonical`）和 `build-package.mjs`；合同名换成 `/2`，读者只认装它的那一版。

#### 42.5.2 当班闸与 rollout Grant（升级代理）

- 请求 `/2` 可选 `rollout: {rolloutSha256}` 和 `admission: "standby-only" | "allow-active"`（默认 standby-only）。
- 新的延后码 `UPGRADE_NODE_HOLDS_ADMISSION`（deferred）：hold 之前和每个排空周期开头读常驻 `state\status.json` 的 `node.mode`；不是 STANDBY 就延后（`allow-active` 除外）。`status.json` 是常驻自报的，所以只认 `writtenAt` 在 2 分钟内、`node.probe.at` 在 20 分钟内的读数，过期按“不是 STANDBY”处理；排空结束、停服（STOP）之前再读一次。滚动顺序因此由每个节点自己保证，不依赖协调者。
- 有 `rollout` 时 Grant 资源是 `ci-rollout:<rolloutSha256>`；升级代理先核对 plan 里有本节点、本节点的包就是请求的包，再向门要这次使用。
- 当班节点在 `NODE_HOLDS_ADMISSION` 延后、而 plan 里其余节点的心跳都报目标 Source（§41.6a 的 holders `nodes`）时，调用 PR-0b 的计划内移交，把角色交给已升级的待命节点；生效后自己变成 STANDBY，下一个周期继续升级。

#### 42.5.3 升级代理自更新（“龙骨”）

- 冻结的只剩一小块：`UpgraderServiceHost.cs` 和管理员专用的 `upgrader\keel.json`（`{active, previous, trial: null | {sha, opId, deadline}}`）。
- 新的 op 种类“升级代理自身”：包只带升级代理副本（以及 Linux 升级工具，见下）；资源仍经同一个 Grant 门。正在跑的代理把新副本放到 `upgrader\<newSha>\`，写 `keel.trial`，经 SCM 重启自己；宿主按 keel 启动新副本。
- 新副本在 10 分钟内必须在 journal 写下自检通过（重读 journal、读配置、对一个空 op 跑一遍 decide）；超时或崩溃三次，宿主把 keel 改回 `previous` 并重启，旧代理记 `ROLLED_BACK`。回滚永远由上一份已证明可用的代理执行。
- Linux 升级工具同样分代：`/opt/clued-independent-ci/upgrade-tools/g<N>/`，由当前工具新增的 `stage-tool`、`switch-tool` 子命令装，companion 的固定 argv 指向 `upgrade-tools/current/` 下的固定文件名（不是链接；切换是改名）。签名器同理。
- 这之后，c 列的冻结模块也能原地升级：先一次“升级代理自身”，再一次普通升级。

#### 42.5.4 TEMP

`APPLY_ENV` 加 `TEMP`、`TMP` = `ROOT\upgrader\tmp`（安装时建，管理员和 SYSTEM 专用），不再落到 `C:\Windows\`。

#### 42.5.5 服务端 PR-0b（clued-cloud，另一个会话、另一个 PR，走 `migration.production`）

- `ci.resident_upgrade` 接受第二种资源 `ci-rollout:<64hex>`：一个 Grant 可被**不同的** resident-upgrade 连接各消费一次（每个连接的 `agent_name` 就是节点名，PR-0 已要求）；同一连接同一 op 重放；Owner 页面显示 rollout 的哈希和节点名单。名单来自请求时第一个节点带上的 plan 公开内容，服务端必须**自己**按同一规范形式重算 `rolloutSha256` 并与资源比对，不一致就拒绝；否则页面上的名单就只是 Agent 说的。
- 计划内移交 `ci_admission_rollout_handover_v1`：经 CI 门，只接受当班节点 resident-upgrade 连接的调用，要求同一 rollout Grant 有效；目标的心跳在 15 分钟内且报 rollout 的 Source；内部走一键移交同一个核心函数、同一把 advisory 锁、同一个检查（§41.6 第 3392 行的拆分），写回执 `CI_ADMISSION_ROLLOUT_HANDOVER`。
- 在 PR-0b 生产应用之前，轨 2 的升级代理照旧用 `ci-resident:` 资源（每节点一次批准），移交照旧由 Owner 点。

### 42.6 失败与回滚（两条轨相同）

| 发生在 | 结局 | 节点状态 | rollout |
|---|---|---|---|
| ACCEPT、Grant 之前 | REFUSED / GRANT_REJECTED / GRANT_EXPIRED / CANCELLED | 不变，照常运行 | BLOCKED `ROLLOUT_NODE_UPGRADE_REFUSED`；改好包、重新 plan 后重来 |
| 排空、暂停、HALT | DEFERRED，自动重试至 Grant 后 24 小时（之后 STALE） | 不变 | 进行中：WAIT；STALE：BLOCKED `ROLLOUT_NODE_UPGRADE_REFUSED` |
| 暂存被拒 | REFUSED（暂存撤回） | 不变 | BLOCKED `ROLLOUT_NODE_UPGRADE_REFUSED` |
| 停服之后的切换、启动、verify、两侧不一致 | **自动回滚到上一代**，ROLLED_BACK_PAUSED | 上一代，保持暂停并通知 | BLOCKED `ROLLOUT_NODE_ROLLED_BACK`；其余节点不动 |
| 回滚也失败 | ROLLBACK_FAILED | 停止或暂停 | BLOCKED；Owner 提权 `upgrade-apply.ps1 -Recover`，看过后协调者 `--ack-op` |

一个 rollout 中途停下时，已经升级的节点留在新代、没升级的留在旧代。影子模式下 Source 不同没关系；on 模式下第 10 段在 Source 不一致时不运行并通知（§41.9）。要整体退回，就对旧包再做一次 rollout（新的 Owner 接受、新的 Grant）。

### 42.7 分阶段上线计划（安装和合入都由协调会话和 Owner 来做）

| 阶段 | 做什么 | Owner | 通过标准 |
|---|---|---|---|
| 0 | 合入轨 1 PR（只有工具和设计，主机不变）：#970，已于 2026-11-01 合入（`850e538f`） | 合入 | CI 六项必需检查 |
| 1 | 只读演练：在 TURING 上对一个只改文档的提交 N+1 跑 `build-upgrade.ps1` DRAFT 和预检。先确认从 10-31 安装的提交到 N+1 之间，升级代理副本和三个冻结 Linux 文件都没有变（预检的 `changedFrozenFiles` 为空）；变了就说明下一次只能走整套重装或轨 2（2026-10-31 核对：10-31 安装所用的 `eaca4eab` 到 main `86deb896`（含 #972、#965）之间，这些文件没有改动） | 无 | `PRECHECK_PASS_EXCEPT_UNREADABLE_SLOTS`；同一输入两次构建 sha 相同 |
| 2 | 烟测：在**待命**节点上把 N+1 原地升级上去 | 接受（弹窗）、页面批准 1 次 | SUCCEEDED、第 2 代、`resident-upgraded` 回执、两侧一致；记下 csc 的 TEMP 是否正常（42.1 f） |
| 3 | 回滚演练：同一待命节点，用一个从不合入的分支打包，故意让 verify 失败（例如常驻入口启动即退出） | 页面批准 1 次；回滚后恢复 1 次 | 自动 ROLLED_BACK_PAUSED、回到第 2 代、RESIDENT_VERIFIED、全程回执 |
| 4 | 真实的 Source 改动按 `rollout.mjs` 两个节点滚动：待命节点 → 移交 → 原当班节点 | 接受、每节点批准 1 次、移交 1 次 | `next` = DONE；期间无 HALT、无批次丢失；两节点 Source 相同 |
| 5 | 轨 2 PR 和 PR-0b：随下一次已计划的整套重装（两个节点）装上 | 按整套重装 | 之后一次 rollout 只点一次 |

验收对照 Task `018da927`：1 由阶段 2（清点只哈希新包与几份清单，分钟级）；2 由阶段 2 的暂停确认与首轮训练后 verify（已在状态机里）；3 由阶段 3；4 由阶段 4；5 由 §34.4 的版本闸（已在）加阶段 4 观察；6 的 b593aa03 三项已在第 3 批落地（§35）；7 由各 PR 的独立审核。

### 42.8 测试

- `rollout/test/rollout.test.mjs`：`plan` 的各类拒绝；`next` 表格的每一行，两个、三个、一个节点（三个节点时一次只给一个 UPGRADE，待命按名字；HANDOVER 只给已升级、一致、未暂停的待命节点；回滚后 BLOCKED，而已到目标包的旧回滚不算；observation 过期或缺为 WAIT；只有一个节点时不带开关为 BLOCKED、带开关给出 `ciPause`）；`observe` 只读、读不到就列出。
- `rollout/test/precheck.test.mjs`：包里带着本树**真实的**升级代理副本（`upgraderCopy`），所以做决定的就是被测代码：PASS（plan 与 ACCEPT 相同，节点根目录逐字节不变）、读不到的槽、冻结模块改动（列出 `src/store.mjs`）、副本被篡改（import 之前拒绝）、身份、state、接受、同包、Linux 工具变更。
- `rollout/test/test_upgrade_tools.py`：`upgrade-config.py` 沿用现装包、包不是当前代、包是别的节点；`roles-derived.py` 的结果等于冻结 Linux 工具 stage 时 `derive_role` 的结果（用该工具自己的离线 fixtures），以及工具不同、角色副本过期、manifest 不是包的、新提交缺钉住文件。
- 不改升级代理、常驻、Linux 工具、重装工具链的任何字节：diff 只在 `rollout/` 和本节。

## 43. 算力面板的 5 分钟触发（Task `b42419de`，Decision `7eb98011`；Note `9477974e`）

完整说明在本分支的设计说明里；这里只记代码的合同。

- **为什么**：GitHub 对本仓库的定时触发大量丢弃，`clued-compute-panel.yml` 的 `*/5` 实际约 6 小时一次。由持有 ci-admission 的节点在 main 上 `workflow_dispatch` 它，cron 留作兜底。
- **`src/panel-dispatch.mjs`**：companion 的一条独立通道（`companion-main.mjs`，自己的 `Runner`，每 30 秒一看），自己的记忆文件 `companion-panel-dispatch.json`（Owner 档案）。没有新凭据：同一个 Owner 的 `gh` 登录；写只有一条固定 argv `gh api --method POST repos/<repo>/actions/workflows/clued-compute-panel.yml/dispatches -f ref=main`，另有一次读取该 workflow 在 main 上最近 5 次运行（`--include`，用 GitHub 的 `Date` 头算年龄）。
- **当班**：`status.json` 新鲜（≤ 5 分钟）、`node.name` 是本节点、`node.mode === 'ACTIVE'`、没有 `dual-active` 持有者；否则零调用。HALT、PAUSE 不阻止（面板正要显示它们）。
- **不重复**：main 上任何事件、年龄不到 4 分钟的运行占住这个时隙（另一节点、cron、上一次）；加上并发组 `cancel-in-progress` 作最后一层。第 6 代审核后收紧了同一次读取间隔内的双触发：POST 之前再读一次运行列表；节点在接班时、以及跟随一个不是自己发的运行时，各多等一个由节点名决定的时间（`staggerMs`：0 至 57 秒，每 3 秒一档），两个节点不会在同一秒醒来；剩下的只是两个节点同档又在同一次读取的往返里，由并发组收拢。每小时最多 20 次，跨重启有效；这条上限有自己的截止时间，不再和"下一次尝试"的时钟回拨保护混用（原来上限期间每 30 秒多写一次记忆文件），时钟被拨回后落在未来的发送记录不计入。
- **仓库钉死**：`PANEL_REPO`（`tdoljyj/cross-memory-system`）写在代码里，`companion.json` 的 `repo` 不一致时不建触发器（`companion-main.mjs`），`tools/build-package.mjs` 在触发器开着而 `repo` 不一致时拒绝打包（`PACKAGE_PANEL_DISPATCH_REPO_MISMATCH`）。记忆文件多一个 `dutyLog`（最近 10 次当班状态变化和原因），用来事后弄清漏掉一个 5 分钟时隙的原因。
- **退避与告警**：失败后 1、2、4、8、15 分钟重试；连续 3 次失败、403/404/422（第一次）、当班但 15 分钟没有运行，各弹一次 toast；之后出现新运行弹一次"已恢复"。下一次读取时必须看到上一次触发产生的运行，否则记为 `DISPATCH_NO_RUN`。
- **开关**：`companion.json` 可选键 `panelDispatch: { enabled }`，缺省开；其余不可配置。`tools/build-package.mjs` 校验。
- **测试**：`test/panel-dispatch.test.mjs`（17 个，假 GitHub）。
- **不做**：不改 workflow 文件和 `compute_panel.py`；面板自身的"上次运行过久"告警是后续项。

## 44. 超时之后不白白 HALT：只读探测与幂等动作的有界重问（Tasks `576231fa`、`4d3aaa64`、`8e1f07d3` 的余项）

第 7 代的一项。只改常驻层（`src/companion.mjs`、`src/pr-status.mjs`），不改 Source、Linux 工具、policy 合同或失败表；失败码、烧头、熔断、日额度和 attempt 2 的规则一概不变。

### 44.1 三个任务在第 6 代（`da854a2d`）里已经修到哪

| Task | 缺陷 | 第 6 代里 | 本节之后的余项 |
|---|---|---|---|
| `8e1f07d3` | companion 子进程超时后不收尾，邮箱通道停摆，第 0 段失败要向 companion 要 Linux 答复而 HALT | §24：作业对象宿主；`fail()` 对第 0 段只关 Windows（`closeOrThrow(batch, { linux: false })`）。已在第 6 代内（`executor.mjs#fail`） | 无代码余项；§24.8 第 2 轮文字另议 |
| `4d3aaa64` | `build-bundle` 的 git 拉取低速卡 35 分钟 | `build-bundle.ps1`：`http.lowSpeedLimit/Time`、网络步骤 600 秒内整库重做一次、`FETCHED_REFS_DIFFER_FROM_LS_REMOTE` 重试（#990） | `-CheckRefs`（第 2 段前的 refs 门）只问一次 `ls-remote`，没有答复就烧头（`REFS_GATE_UNCONFIRMED`） |
| `576231fa` | 回调丢失：中继调用变慢，泵停，签发方等到期限而 UNCERTAIN→HALT；签发侧读 refs / 改动文件的暂时性错误 | §25 中继逐次分类与有界重试；§26 泵观察者与桥停止；§27 自动收尾（`BRIDGE_ABANDONED_UNPUBLISHED`）；`3e93f1f5` 签发侧 refs 有界重试、签发时刻新鲜度、改动文件拒绝分类 | 泵之外、companion 自己的**只读探测**与**幂等动作**仍是“一次超时＝没有答案＝HALT”（下节） |

### 44.2 余下的触发条件（今天仍会发生）

wsl.exe 一次调用在负载高时要 25–45 秒（§25、§26）。companion 里这几个调用的上限比它短或相当，所以一次**只是慢**的读就被当成“没有证明”：

1. `quiescence`（30 秒）：读超时，证明是 false。`prepare-workspaces` 失败后读一次，超时＝`WORKSPACE_PREPARATION_UNCONFIRMED`；泵结束时的证明读超时＝阶段按“未静止”处理；两者都落在失败表的 halt 行或 `cleanup-proof-incomplete`。
2. `archive-linux`：`systemctl start --wait` 5 分钟、`archive-status` 30 秒，任何一个超时＝`LINUX_ARCHIVE_UNCONFIRMED` → 执行器 `FAILURE_ARCHIVE_UNCONFIRMED`（干净失败变 HALT）。
3. `prepare-workspaces` 的 `start --wait` 20 分钟到点：作业宿主结束的是 wsl.exe，**systemd 里的单元继续跑**。companion 只读一次静止，单元还在收尾就是 `UNCONFIRMED` HALT，尽管几十秒后它就静止了。
4. `check-refs`：一次 `ls-remote`，没有答复（git 低速限制、代理拒绝）→ `REFS_GATE_UNCONFIRMED`，干净但头烧掉。
5. 泵的 `start --no-block` 30 秒超时：任务已排进 systemd，单元已经在跑，仍按 `LINUX_WORKER_START_UNCONFIRMED` 停泵。
6. 泵结束后等 worker 单元 `inactive/failed`：窗口 30 秒，单元读每次 15 秒超时，慢的主机上只够读两次，读不到就 `FORMAL_WORKER_TERMINAL_UNCONFIRMED`。

第 6 代的 §25–§27 只处理了泵里的中继调用和扫描阶段的收尾，不覆盖以上六处。

### 44.3 规则与修法

总则：**能证明超时没有副作用的才重问**。重问的只有（a）只读探测，（b）工具自己保证幂等的动作；有副作用的动作（启动 worker、启动 wsprep）一次也不重复。“无法证明”的照旧 HALT。

- **“没有答案”的定义**（`timedOutGone`）：子进程超时，且作业宿主已把它的树排空（`tree: 'zero'`），或是没有宿主的普通超时。树**没有被证明消失**（`tree: 'unconfirmed'`）、拒绝、启动失败、退出码非 0，都不是“没有答案”，不重问。
- **`runRead`**：只读探测超时后最多再问 `READ_RETRIES` = 2 次（共 3 次）。用于：`quiescence`、`archive-status`、worker 启动超时之后的单元事实读。任何一次有答案（哪怕是“没静止”）立即结束。
- **`archive-linux`**：`start --wait` 超时后**再启动一次同一个实例**。Linux 工具对同一实例是幂等的（`clued-ci-resident-linux#earlier_result`：重复的实例返回先前已核实的结果，什么也不移动）；单元仍在跑时 `start --wait` 加入等待。至多两次。`verified` 仍要求退出码 0 加工具自己的回执。
- **`prepare-workspaces`**：超时后**不再启动**，只用 `quiescence`（只读，已带重问）每 20 秒问一次，最多 `WSPREP_QUIET_WAIT_MS` = 5 分钟，且不越过请求截止前 60 秒。静止了就是原来的 `WORKSPACE_PREPARATION_REFUSED`（头烧掉、两侧归档、计入熔断）；仍不静止就是原来的 `WORKSPACE_PREPARATION_UNCONFIRMED` 并 HALT。非超时的失败（退出码 1）不等，行为不变。
- **`check-refs`**：只有明确的 `REMOTE_REFS_UNCHANGED`/`REMOTE_REFS_CHANGED_SINCE_BUNDLE` 结束这个门；没有答复时再问一次（第一次用时不超过 `CHECK_REFS_SECOND_TRY_MAX_MS` = 3 分钟，树未被证明消失不问）。两次都没有答复，仍是 `REMOTE_REFS_UNAVAILABLE` → `REFS_GATE_UNCONFIRMED`，头照样烧。这是同一次检查的读操作重试，不是第二次检查：`networkWrite` 为 false。
- **泵的 `start --no-block`**：超时**不重启**（对已经跑过的实例再 start 会再跑一遍 worker）。改读单元事实（`runRead`）：有“跑过”的证据（`workerRanEvidence`：activating/active/deactivating、failed、或有 InvocationID 加启动时间）就当启动成功；没有证据，照旧 `LINUX_WORKER_START_UNCONFIRMED`。实例名带本作业的 job id，只有这个泵会启动它。
- **泵结束后等单元结束**：读到单元仍在忙，仍是原来的 30 秒；读本身没有答案时，等待可延到 `TERMINAL_NOANSWER_CAP_MS` = 120 秒（总共），再不行才 `FORMAL_WORKER_TERMINAL_UNCONFIRMED`。

### 44.4 证据与恢复提示

- **证据**：每一次因超时而再问，都在 companion 本地日志（§25.5，同一个 `relay-YYYYMMDD.jsonl`）写一行固定键的 `{ kind: 'retry', op, attempt, ms, runner: { code, timedOut, tree, refused } }`（`retryLogEntry`），只有码和数字，没有路径和文字。HALT 之后可以对照看是哪个探测、几次没有答复、各用了多久。
- **恢复提示**：PR 页面 / 通知的 HALT 文字（`pr-status.mjs#haltHint`）对超时型的码补一句固定的“复位前先只读核对什么”：归档类（`FAILURE_ARCHIVE_UNCONFIRMED`、`UNEXECUTED_CLOSE_UNCONFIRMED`、`BETWEEN_ROLES_ARCHIVE_UNCONFIRMED`、`LINUX_ARCHIVE_UNCONFIRMED`）、`WORKSPACE_PREPARATION_UNCONFIRMED`、worker 类（`FORMAL_WORKER_TERMINAL_UNCONFIRMED`、`LINUX_WORKER_START_UNCONFIRMED`、`LINUX_WORKER_NOT_STARTED`、`LINUX_WORKER_ENDED_WITHOUT_RECORD`）、子进程类（`STAGE_INVOKER_TERMINAL_UNCONFIRMED`、`STAGE_CHILD_TREE_UNCONFIRMED`，指向 Decision `901a8968` 的做法）、companion 类（`COMPANION_REQUEST_EXPIRED`、`COMPANION_HANDLER_UNCONFIRMED`、`COMPANION_HEARTBEAT_LOST`、`COMPANION_PUMP_UNCONFIRMED`）。其他码的文字不变。提示只说要读什么，不授权任何动作，复位仍是 Owner 的。

### 44.5 没有放宽什么

- 失败的 head 照旧烧：`check-refs` 两次都没有答复仍烧头；wsprep 超时后静止仍是 `REFUSED`（烧头、计入熔断），不是“重来”。
- 同一提交的同一检查只真跑一次：没有任何动作被重复；`archive` 的第二次是工具定义的“重放先前结果”，wsprep 和 worker 一次也不重启。
- 证明没有变弱：`archive` 的 `verified` 条件不变；`quiescence` 仍是 root 工具自己的回答；“树未证明消失”的超时从不重问；`FORMAL_WORKER_TERMINAL_UNCONFIRMED` 的上限只多出读不到答案的时间，读到“仍在忙”就仍是 30 秒。
- 不碰 `HALT.json`，不读写 `C:\ProgramData`，不增加 GitHub 读写，不杀任何进程。

### 44.6 仍然 HALT 的（有意）

阶段子进程超时但树没有被证明排空（`STAGE_INVOKER_TERMINAL_UNCONFIRMED`、`STAGE_CHILD_TREE_UNCONFIRMED`）；Windows 服务没有读回原样（`SCM_READBACK_NOT_ORIGINAL`）；两次重问之后仍无答案的归档或静止；worker 单元一直在忙；`COMPANION_REQUEST_EXPIRED`/`COMPANION_HEARTBEAT_LOST`（companion 本身不可信，§27.2 第 2 条）。这些都靠提示里的只读核对加 Owner 复位。

### 44.7 测试与安装

- `test/halt-timeouts.test.mjs`（9 个）：`timedOutGone` 的边界；`quiescence` 重问与“未证明消失的树只问一次”；`archive-linux` 的两次启动上限、退出码非 0 不重问、状态读重问；`check-refs` 的定论、两次上限、长读不再问；`prepare-workspaces` 的静止等待（不重启、受截止约束、退出码 1 不等）；`start --no-block` 超时（有证据继续、无证据照旧、永不重启）；单元读无答案的 120 秒上限与“仍在忙”的 30 秒；日志行的键；HALT 提示。
- 安装：常驻层 Windows 包的改动（companion 与 PR 页面），随第 7 代一并装；Source v2、Linux 工具、policy 合同不变。

## 45. 三个扫描并行？分析结论：常驻层不能安全做到，最小的可行办法是 Source 级的“多角色扫描段”（Task `c59e697c`，第 8 代，分析稿，未改任何运行代码）

范围：基于第 7 代 `b88ee755`。任务要求在常驻节点内让 gitleaks、trivy、contract-placement 的执行段（第 2、4、6 段）并行，再按现有顺序发布。本节逐项核对共享资源，结论是：**只改常驻层，任何并行都会被下面五处单例挡住；没有任何一处能靠“只把发布串行”绕开**，因为发布段（第 3、5、7 段）本身也要占同一个交换槽。没有写并行的代码：并行逻辑放在常驻层就是死代码，放进 Source 就是一次 Source 变更（新 Source 清单、Owner Decision、UAC、Grant），要先由 Owner 选。

### 45.1 五处单例（读代码得到的事实）

| # | 资源 | 证据 | 为什么挡并行 |
|---|---|---|---|
| 1 | Windows 交换槽 | 每一段（含发布段）都是一次经交换代理的整段换手：原 runner 服务被停、换成通用助手，段结束再读回 `serviceOriginalStopped`；`maxConcurrent` 只能是 1，交换代理有全局互斥量，`Runner.run` 在子进程未退出时拒绝新子进程（`RUNNER_BUSY_WITH_UNFINISHED_CHILD`）；发行方（`windows-issuer.mjs`）整个 Linux 扫描期间都占着它回答回调 | 同时只能有一个发行方会话；两个扫描段无法同时换手。**发布段也要换手，所以它既不能与扫描段重叠，也没有“只串行发布”这一档可选** |
| 2 | Linux 角色锁 | `formal-fixed-role-policy-v3/policy.mjs:28,107-110`：固定路径 `/var/lib/clued-independent-ci/formal-role.lock`，`wx` 新建，第二个 worker 直接失败；`prepare-workspaces.py:43`、归档、安装与重装脚本都把它当唯一一份 | 第二个 worker 起不来 |
| 3 | Linux 单 unit 守卫 | 每个 unit 的 `ExecStartPre` guard 要求其他 `clued-ci-*@` unit 全部 inactive/failed（`clued-ci-resident-linux:19,138-142`）；`quiescence` 与归档也按“同一时间只有一个”核对 | 第二个 unit 的守卫失败 |
| 4 | formal-spool | 一个目录对：`incoming/{issue,response-01..32}`、`outgoing/{result,blocked,challenge-01..32,active.lock}`，名字固定，`active.lock` 独占（`mailbox.mjs:51`），归档白名单就是这些名字（`clued-ci-resident-linux:83-84`）。回调序号 1..32 是**每个 issue 自己的**序号，所以序号本身不冲突；冲突的是三个角色共用同名文件 `issue.json` / `result.json` / `active.lock` | 三个角色共用一个目录就互相覆盖或互相拒绝 |
| 5 | companion 邮箱 lane 一次一个请求 | `companion-main.mjs#lane`：邮箱 lane 有自己唯一的 Runner，`runner.busy` 时不取新请求（咨询类工作在另一条 lane，不能借用）；`relay-stage`（泵）是邮箱 lane 上的一个长请求，泵期间 `memory-ready`、`check-refs`、归档等其他邮箱请求都排在它后面 | 即使 1–4 解决，三个泵也没有并发的载体 |

另外：`ROLE_STAGES`、`POSITIONS`、`PUBLICATION_STAGES`、批次导出的 8 段工作清单、C# 通用助手的阶段表、`source-closure.json` 都按“第 2、4、6 段各一个角色”钉死，改阶段结构 = 改 Source。

### 45.2 其余五项核对

- **WSL 内存（`.wslconfig` memory=28GB）**：不是瓶颈。gitleaks、trivy 容器固定 2 GiB / 2 CPU / 128 pids（`policy.mjs` `FIXED_SCANNER_RESOURCES_REQUIRED`），contract-placement 是 node-entry 容器；三者同时最多约 6 GiB 外加 docker 与页缓存。**真正要防的是 §32 的 hv_sock 环形缓冲块**：它看的是连续空闲块数（64 块阈值），不是总内存；三个泵同时开 wsl.exe，用块的速度约三倍。并行方案的内存闸必须在合并段之前读一次，并按角色数留量（阈值待实测，不能沿用 64）。CPU：每个扫描 2 核，要先量 DESK 的 `nproc` 再定，否则三个 2 核容器互相拖慢，收益缩水。
- **发布顺序与 ledger/烧头**：今天第 3 段发布之后才跑第 4 段，所以第 4 段失败时 gitleaks 的检查已在 GitHub 上、head 已被 `executed-heads` 记为“可能已发布”（`beforePublication` 在第 3、5、7 段前写，`PUBLICATION_STAGES`）。扫描先全部跑完再发布，则任一扫描失败都发生在第一次发布**之前**：PR 上没有半截检查，head 仍按“失败的 head 永远烧掉”烧（第 1 段后的 `markStarted`），语义不变且更干净。**必须新增的一条规则**：自动 attempt 2 今天只对第 1、2 段的暂时性码开放，是因为那时最多 gitleaks 跑过一半；并行后可能 trivy 已经**跑完并出了合格结果**而 gitleaks 失败，attempt 2 会让 trivy 对同一提交再真跑一次，违反“同一提交的同一检查只真跑一次”。所以：只要有任一角色已收到合格的签名结果，就不进 attempt 2。
- **断路器**：`POSITIONS` 用“批次结束的位置”区分 Linux/Windows-only 位置（`LINUX_POSITIONS`）。合并后的扫描段只有一个位置；它失败属于 Linux 位置，关闭规则（“走过失败的位置”）照旧，但同一批里多角色同时失败只能计一次，否则一批让熔断数多算。
- **第 3、5、7 段发布前的 Native 完整准入，以及合并槽/认领的观察时间点**：现有设计里每个发布段自己在开头做一次完整准入，用的是实时读到的认领答复（`one-shot-v2.mjs` `serverAnswerCurrent`），不复用任何旧观察；发行方的 issue 窗口是 `min(段上限, 认领租约, 验收 validUntil, 持有租约)` 且 `issue.expiresAt ≤ claimExpiresAt`（`protocol.mjs:94`），每次回调都在同一认领代下重新准入。所以并行**不会**让发布使用过期观察：每个发布段仍然实时重核。会变的有两点，都要写进设计而不是靠运气：(1) 三个 issue 在同一时刻签发，共享同一个较早的 `claimExpiresAt`，串行时后面的角色拿的是更晚的认领读数；(2) 第一个发布段要等最慢的扫描结束才开始，gitleaks 的结果等待时间变长（缩短的是总时长，不是这一项）。净效果是 PR 从第 1 段到最后一次发布的总跨度缩短，合并槽过期的暴露窗口变小；但这两点必须由测试固定：发布段拿到的结果若超过其 issue 窗口，按现有码干净失败，不放宽任何检查。今天遇到的“合并槽在两次观察之间过期、发布被撤回”发生在第 3 段与第 8 段之间（§41.3 撤绿），与扫描并行无关；并行不改第 8 段，也不改撤绿规则。

### 45.3 最小可行方案（Source 级，供 Owner 选择，未实现）

只有这样才能在 1–5 处都不放宽的前提下并行：**新增一个“多角色扫描段”，一次换手、一个发行方会话、三个 Linux worker 并发；发布段 3、5、7 保持原样、原顺序、原绑定。** 先例：第 9 段（托管转发）已经支持“按行序取非空角色子集”的变长作业清单，可以照它建模。

1. Linux：锁改为每角色一个（`formal-role-<role>.lock`），guard 改为“每个角色至多一个 worker，且 wsprep/archive 与任何 worker 互斥”；spool 改为 `formal-spool/<role>/{incoming,outgoing}`；归档白名单、`quiescence`、`prepare-workspaces.py`、安装/重装/校验脚本同步改（`ROLE_LOCK_PRESENT` 等）。
2. Windows：`windows-issuer.mjs` 在一个会话里对三个邮箱各自发 issue、轮询回调、收结果；`formal-spool-acl.ps1`、`archive-windows-spool.ps1` 改成三个子目录；C# 通用助手阶段表加新段（`FormalPublicBoundaryV2.cs`，编译后的二进制，哈希写在安装记录里）。
3. 常驻层：`relay-stage` 泵要能并发三路（companion 主循环改成可并发，或一个泵多路复用三个角色）；执行器 `continueBatch` 里 `ROLE_STAGES` 循环改成“一个扫描段，然后按 3、5、7 顺序发布”；内存闸、`POSITIONS`、`ATTEMPT2` 规则、回执（`stage-terminal` 每角色一条）、状态页、失败表按 §45.2 调整。
4. 保持不变：失败的 head 永远烧；同一提交同一检查只真跑一次（上面的 attempt 2 新规则）；发布顺序和绑定；生产库只读；不放宽任何安全检查。
5. 范围：约 15–25 个 Source 文件加一个已编译助手，改动会改变 Source 清单，必须随第 8 代的 Source 变更一起走独立审核、Decision、UAC、Grant。代价不小，不是一次本地提交能完成并让人放心的东西。

### 45.4 能省多少（估算，未实测）

并行只缩短“三个扫描的执行时间之和”到“最长的一个”再加一次换手；换手本身省下两次。设 gitleaks、trivy、placement 的实际执行时间为 g、t、p（分钟），节省 ≈ g + t + p − max(g, t, p) + 约 1–2（少两次换手与中间归档）。**我这里没有读 `C:\ProgramData` 的回执，拿不到真实的 g、t、p**；按设计里的段上限（45/30/10 分钟，是上限不是典型值）无法推算。请取最近几个批次的 `stage-terminal` 回执时间戳算出来；若典型值是 g≈8、t≈8、p≈2，节省约 10–12 分钟（每 PR 30–40 分钟里的约 25–30%）。

**对比：同样大小的、风险更低的省时项**：设计 §10.1 的“持久种子库”（`resident\seed.git`，只在 `build-bundle.ps1`，不改扫描结构）按 §10.1 自己的估算在限速网络下每个批次省 4–9 分钟，且不需要多角色改造；它需要 Owner 就种子目录的 ACL 与保留策略做决定。建议先做它，再决定是否值得做 §45.3。（第 8 代已按此建议实现种子库，见 §10.1；实测的各段耗时：限速网络批次 `0c226c90`，打包加第 1 段 8.0 分钟，gitleaks 5.4、发布 0.5，trivy 5.3、发布 0.5，placement 3.1、发布 0.6，第 8 段约 1.5，合计约 25 分钟；网络正常批次 `ed2ae9b2`，打包加第 1 段 2.4 分钟，gitleaks 5.4、trivy 4.6、placement 2.4，合计约 17 分钟。按这组数，三扫描并行最多省 g+t+p−max = 5.4+5.3+3.1−5.4 ≈ 8.4 分钟，种子库在限速网络下省 3–8 分钟，且改动远小得多。）

### 45.5 测试与验证

本节没有改运行代码，所以没有新增测试。第 7 代基线在本工作树上重跑：常驻套件 802 个测试 / 796 pass / 0 fail / 6 skipped；`independent-ci-v1` 套件 517 个测试 / 516 pass / 1 fail，失败的是 `resident-v2-bridge.test.mjs` 的 “issuer: an answer that would be late…”（`BRIDGE_BYTE_BOUND`），**两套同时跑时出现，单独连跑三次均 36/36 通过**，是负载下的时间敏感测试，与本节无关。两套**顺序**重跑的最终数字：常驻套件 802 / 796 pass / 0 fail / 6 skipped；`independent-ci-v1` 套件 517 / 517 pass / 0 fail。

## 46. 第 7 代独立审核的两条建议修（Decision `4f5f35d3`：发现的缺陷全部修掉）

审核对 §44 与 `build-bundle.ps1` 的低速窗口给出 PASS-WITH-FIXES，两条建议都在本节修掉。

### 46.1 重问必须装得进请求自己的期限（`archive-linux`、`check-refs`）

- **缺陷**：§44 让 `archive-linux` 的 `start --wait` 超时后再启动一次，每次 5 分钟；服务侧这个请求的期限只有 6 分钟（`service-ports.mjs` 的 `TIMEOUTS` 与 `engine-windows.mjs#archiveLinux` 各写死一份）。第一次超时已用满 5 分钟，第二次启动和状态读到点时服务早已按“没有答案”走 `FAILURE_ARCHIVE_UNCONFIRMED` HALT，重问没有减少任何一次 HALT，还白占约 11 分钟的 companion 通道。`check-refs` 同形：第一次读至多 3 分钟时才问第二次，第二次至多 5 分钟，合计 8 分钟，请求期限也是 6 分钟。
- **期限只在一处定**：`mailbox.mjs` 导出 `ARCHIVE_LINUX_REQUEST_MS` = 14 分钟（两次 5 分钟的启动 + 3 次 30 秒的状态读 + 余量）和 `CHECK_REFS_REQUEST_MS` = 9 分钟（至多 3 分钟的第一次 + 5 分钟的第二次 + 余量）。服务端口和引擎都用它们，不再各写一份 6 分钟。这两个动作只出现在收尾与第 2 段前的 refs 门，多等几分钟不碰任何新的写动作。
- **companion 自己再按请求期限卡一道**（防御：按更短期限发来的请求，包括升级中新旧版本交错时）：`archive-linux` 的第二次启动只在“期限 − 现在 − `ARCHIVE_STATUS_RESERVE_MS`（100 秒，留给状态读）”不少于 `RETRY_MIN_ROOM_MS`（60 秒）时才做，超时取 5 分钟与剩余的较小者；`check-refs` 的第二次读取同理，留 10 秒余量。剩余不够就不做，没做的重问也不写 `retry` 日志。结论不变：没有定论的仍是 `LINUX_ARCHIVE_UNCONFIRMED` / `REMOTE_REFS_UNAVAILABLE`，头仍然烧掉。
- **未放宽任何检查**：`verified` 仍要退出码 0 加工具自己的回执；第二次启动仍只重放同一实例的既有结果（幂等）。

### 46.2 低速窗口放宽后重试窗口没跟着放宽（`build-bundle.ps1`）

- **缺陷**：`http.lowSpeedTime` 放宽到 300 秒后，`RetryWithinSeconds` 仍是 600。限速下一次完整传输要 213–533 秒，在传输末尾（约 480–533 秒）卡死的第一次尝试要到约 780–833 秒才失败，已过 600 秒窗口，不再重试，直接失败。
- **改动**：`RetryWithinSeconds` 600 → 900（15 分钟）。最慢速率下末尾卡死也在 533 + 300 = 833 秒内失败，仍在窗口内；第二次尝试至少还有 15 分钟（companion 等 30 分钟），够一次最慢的完整传输加一次卡顿（833 秒）。窗口仍是有界的，不是无限重试；最多一次整库重做的规则（`$MaxStoreAttempts`、`FETCHED_REFS_DIFFER_FROM_LS_REMOTE` 的重试）不变。
- **测试**：`test-build-bundle.ps1` 的常量、“刚好在窗口内 / 窗口外”的边界改为 900；`resident-v2-build-bundle.test.mjs` 钉住常量，并新增“最慢完整传输 + 低速窗口 ≤ 重试窗口”和“30 分钟 − 重试窗口 ≥ 最慢传输 + 低速窗口”。

### 46.3 测试

- `test/request-deadline.test.mjs`（4 个）：两个期限只在 `mailbox.mjs` 定且服务/引擎使用；真实期限下两次启动都超时仍在期限内回答；6 分钟、9 分钟与刚好够/差 1 毫秒的期限下第二次启动的有无与超时；`check-refs` 的第二次读取的超时与“剩余不够就不读”。
- 安装：与 §44 一起随第 7 代的修订装；Source 里只有 `build-bundle.ps1` 变了。

### 46.4 一个测试的偶发失败也一并修掉

`issuer-refs-transient.test.mjs` 的 “a slow refs collection” 在负载下偶发失败：测试把 `Date.now` 加偏移 35 秒来模拟慢收集，而测试自己的 `waitFor`（等 Linux 侧文件）也用被偏移的 `Date.now` 当期限，Linux 侧文件晚几毫秒写出时等待立即到期。`waitFor` 改用模块加载时取下的真实时钟。生产代码没有改。

## 47. 两台主机的时钟：跨主机时间比较有明确容差，时钟误差不再是永久失败（2026-11-04，PR #992 批次 `9c995a5f`，Decision `4f5f35d3`）

### 47.1 现象与已证实的部分

- 2026-11-04T10:36:44.357Z（日志里的 `at` 是调用**开始**时间；调用持续 53.3 s，约 10:37:38 结束），companion relay 的 `SendIssue`（seq 0）失败：runner code 2，receipt `PUBLIC_CHILD_REFUSED_NO_RETRY`，`exitCode` 2，`childError` 为 null，分类 PERMANENT；随后 `BRIDGE_ABANDONED_UNPUBLISHED`，自动安排 attempt 2。这是 1275 次 relay 调用（10-31 至 11-04）里唯一一次非 OK；其余 1274 次里，中位数 3.4 s，p99 13 s，最慢一次 46 s（成功）；`SendIssue` 共 85 次，次慢一次 29 s（成功）。慢本身不是失败的原因，慢的调用大多成功。
- 拒收的是哪个进程、哪一行：Windows 侧 `relay-public.ps1` 读到 Linux 子进程（`wsl.exe … node relay-record.mjs --import-issue`）的 stderr 非空，即抛 `PUBLIC_CHILD_REFUSED_NO_RETRY`；退出码 2 与 `relay-record.mjs#main` 的 catch 一致，说明子进程跑到了并抛出一个带代码的拒绝。**子进程具体抛的是哪个代码，现存证据里没有**：`Safe-ChildError` 只放行 28 个代码，列表之外的一律丢成 `childError: null`，日志的 `stderrTail` 记的是 runner 自己的 stderr（空）。所以不能说这次就是时钟。
- `--import-issue` 路径里读 Linux 时钟（`Date.now()`）的比较只有：`protocol.mjs#validateIssue`（`issuedAt <= now`、`expiresAt > now`，issuedAt 由 Windows 盖章）、`policy.mjs#validateSelectedFacts` 与 `qualification-v2.mjs`（`qualifiedAt <= now`；当前资格的 qualifiedAt 是 09:38:05Z，无 expiresAt）。没有别的。

### 47.2 对时钟本身的测量（只读）

- 采样 160 s：Linux 的 realtime 减 monotonic 在第 132 s 一次性 +444 ms（timesyncd 的步进阈值是 0.4 s）；Windows 没有步进，但在以约 −1.3 ms/s 的速率被 W32Time 微调（160 s 里 −204 ms）。
- Linux 减 Windows 的偏差，10 次采样（往返 62–74 ms）：+277 … +434 ms，即 Linux **走在前面**约 0.3–0.4 s。
- Linux journal：17:30（+08:00）以来 61 次 `systemd-resolved: Clock change detected`，多数相隔 32 s；`systemd-journald: Time jumped backwards` 在 18:29:47、18:31:25、18:36:45；10:36:45.09 → 10:36:44.42 是一次 −0.67 s 的回跳，与失败的调用几乎同时。
- 原因：WSL 发行版里 `systemd-timesyncd` 在运行（`wsl.conf` 里 `systemd=true`），向 `ntp.ubuntu.com` 校时，轮询间隔卡在最小值 32 s；样本质量很差（延迟 388 ms，jitter 250–800 ms，频率修正 −110 ppm），偏差一过 0.4 s 就步进。出网从今天起限速约 2.5 Mbit/s，这些样本是在限速的链路上测的。Windows 侧 W32Time 的源是 `time.aws.com`，stratum 5，轮询 64 s，root delay 0.27 s，root dispersion 0.40 s，同样受这条链路影响。Windows 的 System 日志（Kernel-General 事件 1、Time-Service）在 17:00–19:00（+08:00）查不到时钟被设置的事件。
- 结论：两边时钟不同步、Linux 每分钟步进一两次，每次 0.4–0.7 s，是实测事实；但在 `SendIssue` 路径上，签发到子进程检查之间至少隔着一次 relay（平时 ≥ 3 s，这次 ≥ 数秒到 50 s），远大于 0.7 s，所以单凭这个量级的偏差解释不了这次的 `BRIDGE_ISSUE_EXPIRED`。**这次拒收的真正原因未证实**；候选还有 WSL 在这 53 s 里卡住时子进程碰到的资源错误（EAGAIN、ENOMEM、ETIMEDOUT 都不在放行列表里）。因此本节的改动分三层：让下一次一眼看出原因，让跨主机时间比较有容差，让时钟类和卡顿类的拒绝可重试。

### 47.3 代码改动

1. **容差**：`protected-job-bridge-v4/protocol.mjs` 的 `BRIDGE_CLOCK_SKEW_MS`（= `clock-skew.mjs` 的 `CLOCK_SKEW_MS` = 5 s，Decision `1100a0ed` 已经用于准入事实）。只放宽时钟差会把有效戳变成拒收的那个方向：“对方主机的戳不晚于本机现在 + 5 s”和“戳不早于引发它的戳 − 5 s”（issue、challenge、response、blocked）。所有上界不动：窗口结束 `expiresAt/deadline`、`now − at ≤ CALLBACK_WINDOW_MS`、`end − at ≤ CALLBACK_WINDOW_MS`，所以没有哪个包比以前多活一毫秒。取值依据：实测偏差 0.3–2.0 s（47.6），5 s 是它的 2.5 倍以上，不是更多；同一主机内的戳互相比较仍然精确；5 s 小于最短的一跳 relay（约 3 s 到数秒）的量级，不会让“先后”检查失去意义，也与准入事实用的是同一个数，不引入第二个容差。
2. **放行列表**：`relay-public.ps1#Safe-ChildError` 增加 `BRIDGE_ISSUE_EXPIRED`、`BRIDGE_CHALLENGE_EXPIRED`、`BRIDGE_RESPONSE_EXPIRED`、`BRIDGE_BLOCKED_TIME_INVALID`、`EAGAIN`、`ENOMEM`、`ETIMEDOUT`；子进程固定形状的拒绝里，代码格式合法但不在列表中的，报成 `FORMAL_RELAY_CODE_UNLISTED`（形状不变，不带任何新文字），不再丢成 null。
3. **分类**：`companion.mjs#classifyRelayAttempt`：时间类代码（上面四个）在 `CONTEXT`、`BINDING` 阶段（子进程写之前）按 `CHILD_FAILED` 处理；`EAGAIN`、`ENOMEM`、`ETIMEDOUT` 与既有的瞬时 errno 一样只在 `OPERATION…PACKET` 阶段。`CHILD_FAILED` 的后续不变：Send* 先要求 Linux 没有残留的 relay-record 进程（`pgrep`），再看记录是否已到（到了就算成功、不重复导入；半截就保留并永久失败），次数与间隔是各调用原有的（SendIssue 3 次，3 s、8 s），预算不变。`FORMAL_RELAY_CODE_UNLISTED` 和其他 BRIDGE 拒绝（身份、绑定、claim）仍是 PERMANENT。
4. 单调时钟：这条路径上的戳本来就必须跨主机比较（一台盖章、另一台检查），没有可替换成单调时钟或单一时钟源的地方；准入事实的新鲜度已经在 Decision `1100a0ed` 里改成本机单调时钟。

### 47.4 让时钟稳定的方案（只写方案，未改任何系统设置）

- **Linux（主因）**：不要让 WSL 发行版自己从互联网校时。停用并禁用 `systemd-timesyncd`，改用 Hyper-V 提供的主机时间：内核已有 `/dev/ptp_hyperv`（`clock_name` 为 `hyperv`），装 `chrony`（Ubuntu 24.04 有 4.5）并配置 `refclock PHC /dev/ptp_hyperv poll 3 dpoll -2 offset 0`，去掉 `pool`/`server`，`makestep 1.0 3`。这样 Linux 时钟跟 Windows 主机走，两边只差毫秒级，且不依赖被限速的出网。
- **Windows**：W32Time 目前从 `time.aws.com` 取时，root dispersion 0.40 s，持续微调。限速期间可把 `MaxPollInterval` 调高、给出 2 个以上的源，或换成延迟更低的源；这是次要的，Linux 一旦跟主机走，影响只剩 Windows 自己的绝对准确度（本系统不依赖它与 UTC 的绝对差，除了与 GitHub 的比较，已有 5 s 容差）。相关任务 `1a6ce931`。
- **验证**：改完之后用同样的采样（realtime 减 monotonic 的跳变，Linux 减 Windows 的偏差）连续看 1 小时：不应再有大于 100 ms 的步进，偏差应在 50 ms 以内；`journalctl | grep "Clock change detected"` 的频率应降到接近 0。
- 这些要改系统设置，需要 Owner 决定；本次没有动。

### 47.5 测试与安装

- `test/resident-v2-bridge.test.mjs` 新增 3 个：协议在容差内接受、超出 1 ms 拒绝（issue、challenge、response、blocked，时钟往回跳与往前跳）；到期一侧不放宽、先后检查超出容差仍拒收；`Safe-ChildError`（Windows PowerShell 5.1 实跑）报时间类代码、把未列出的代码报成 `FORMAL_RELAY_CODE_UNLISTED`、形状不对的仍丢弃。
- `test/relay-retry.test.mjs` 新增分类行与一个端到端：时间类拒绝后重试成功；记录已到就不重复导入、半截保留；一直拒绝则耗尽该调用的次数后以非永久的 `RELAY_REFUSED_NO_RETRY` 结束。
- 安装：改了 Source v2 的 `protocol.mjs` 与 `relay-public.ps1`（新的 bridge manifest 与 CI Source 哈希），以及 companion 的 `companion.mjs`，随第 8 代一并装。

### 47.6 假设检验：Windows 64 s 轮询 → 主机时间微调 → WSL 经 Hyper-V 时间同步跟着跳（只读实测，2026-11-04 19:0x +08:00）

背景：任务 `1a6ce931`（Decisions `4bd3144f`、`1100a0ed`）把 Windows 的 W32Time 改成 `time.aws.com,0x9 ntp.aliyun.com,0xb`、轮询固定 64 s（`MinPollInterval=MaxPollInterval=6`，`SpecialPollInterval=64`），目的是让 Windows 与 AWS 上的 Supabase 对时。问：这会不会让 WSL 经 Hyper-V 时间同步每 30–60 s 跳一次？**不成立**，依据：

1. **步进间隔是 32 s，不是 64 s。** 230 s 的探针里，Linux 的 realtime 相对 monotonic 在第 11、43、76、108、141、173、206 秒各跳一次，间隔 32/33 s；另一次 100 s 的采样跳在第 5、38、70 秒。这正是 `systemd-timesyncd` 的最小轮询间隔（`PollIntervalMin=32s`，一直卡在最小值）。journal 里 `Clock change detected` 也是 32 s 的倍数（10:25:27.96、10:25:59.84、10:26:31.84、10:27:36.8、10:28:08.7、10:28:40.8、10:29:12.7）。Windows 的轮询是 64 s，对不上。
2. **每次步进与一次 NTP 应答同时发生。** 探针每 3 s 读 `timedatectl show-timesync` 的 `PacketCount`：每一次步进之后 1–3 s 内都看到计数加一。
3. **步进离开主机时钟，不是靠近。** 探针同时读 `/dev/ptp_hyperv`（Hyper-V 给出的主机时间）：Linux 减主机在每次步进前约 −0.2 s，步进后约 +0.8～+1.0 s，两次步进之间以约 −33 ms/s 回落。如果是主机同步在起作用，这个差应当被拉向 0；它被推向 +1 s。
4. **Windows 自己不步进。** Kernel-General 事件 1 与 Time-Service 在 17:00–19:00 查不到；`UtcNow − Stopwatch` 100 s 里只漂了 +107 ms（约 1 ms/s）。Hyper-V 的时间同步只在虚拟机启动或恢复时给 SYNC。
5. 所以 Linux 是被 `timesyncd` 从 `ntp.ubuntu.com` 拖着走的。100 s 里 Linux 比 Windows 多走了 2.4 s（差从 −0.37 s 变成 +2.0 s），每次步进约 +1.1 s，方向总是向前。最合理的解释是限速链路的排队：出网被限到约 2.5 Mbit/s 且排队很深，NTP 请求在上行队列里多等了约 1–2 s，服务器盖章晚了，客户端算出的偏差整体偏正，`timesyncd` 就把时钟往前拨。`timedatectl` 显示该源的 delay 388 ms、jitter 250–800 ms，与之一致。这是推断，没有抓包验证。

Windows 一侧也在受同一条链路的影响，但不是 WSL 乱跳的原因：`w32tm /query /status /verbose` 在 19:05 显示相位偏移 0.65 s、root dispersion 0.81 s（早些时候 0.40 s）、root delay 0.27 s；配置里 `PhaseCorrectRate=1`（默认 7，1 是最快）、`MaxAllowedPhaseOffset=1`（超过 1 s 才步进，否则按斜率修正）、`MinPoll=MaxPoll=6`。也就是说每 64 s 拿一个质量很差的样本，并用最快的速度去追它，所以 Windows 的时钟会以每秒几毫秒到几十毫秒的速率被拧来拧去（实测 −1.3 ms/s、+1 ms/s）。这让 Windows 对 AWS 的绝对准确度并不比 0.3–0.8 s 好，64 s 的积极轮询在这条链路上没有换来精度。

### 47.7 让两者同时满足的方案（只写方案，未改任何系统设置；需要 Owner 批准）

目标：Windows 对 Supabase 仍然准；WSL 对 Windows 不乱跳；两台主机的差在毫秒级。

1. **WSL 跟着 Windows 主机，不再自己校时（决定性的一条）。** 停用并禁用发行版里的 `systemd-timesyncd`，装 `chrony`（Ubuntu 24.04 有 4.5-1ubuntu4.2），只用主机时钟做源：`refclock PHC /dev/ptp_hyperv poll 3 dpoll -2 offset 0`，不写 `pool`/`server`，`makestep 1.0 3`（只在启动的前 3 次允许步进），其余全部按斜率修正。这样 WSL 的时钟 = Windows 的时钟（毫秒级），Windows 慢慢修正时 WSL 平滑地跟，永远不会因为互联网上的坏样本自己跳。这也满足“WSL 内部只做单调调整”。
2. **Windows 对 AWS 保持，但别追噪声。** 保留 `time.aws.com` 作为首选（Decision `1100a0ed` 的目的）；把 `PhaseCorrectRate` 从 1 改回 3–7，使每个样本的影响被摊开；`MaxPollInterval` 可放宽到 8–10（256–1024 s），64 s 不必保留，因为这条链路上每个样本的误差远大于 64 s 内的漂移；`MaxAllowedPhaseOffset` 保持 1 s。要在 Supabase 一侧仍有保证，已有的 5 s 容差（`clock-skew.mjs`）和“KooYomi 的戳不与本机时钟比较”（Decision `1100a0ed`）继续有效。
3. **治本：别让 NTP 在限速队列里排队。** 对 UDP/123 做优先（或不进限速），或者让限速的设备用公平队列（fq_codel/CAKE）。排队深度消除后，Windows 与 Linux 的样本偏差都会回到几十毫秒。
4. **验证**（实施后连续 1 小时）：Linux realtime 相对 monotonic 不应出现 > 100 ms 的跳变；Linux 减 Windows 的差保持在 50 ms 以内；`journalctl | grep -c "Clock change detected"` 接近 0；`w32tm /query /status` 的相位偏移和 root dispersion 下降。
5. 采用 1 之后，`timesyncd` 的 32 s 步进消失，47.3 的容差只需应付 Windows 自身的缓慢修正。

### 47.8 提交 5b3f02bf 在这个根因下是否足够

不够，是缓解，不是修复。(1) 实测 Linux 与 Windows 的差在 100 s 内就走到 +2.0 s，而且只要上行排队还在，每 32 s 再加约 1.1 s；5 s 容差只有 2.5 倍余量，限速更紧或排队更深时会被超过，再放大容差等于放宽安全检查，不应该。(2) 时间类拒绝可重试只在时钟在两次尝试之间回到容差内时才有用；偏差持续时，重试 3 次后仍然失败，只是不再标成永久。(3) 这次 `SendIssue` 的拒收原因仍未证实（47.2），所以不能说时钟是它的原因；下一次同类失败会因为 `childError` 现在可见而被识别。要根治，必须做 47.7 的 1。

## 48. 扫描发布（第 3、5、7 段）的授权绑定不再含合并槽状态（第 8 代；11-04 PR #992 的两次撤回）

**缺陷。** `staged-check-publisher-v2.mjs#boundary` 的 `bindingSha256` 含整个 `native.mergeSlot`（`state`、`until`、`observed`……）。写检查前后各算一次，不同就 `stop('authorization_binding_changed', true)`，已发的检查被撤成 failure（`REVOKED`，`sideEffects` = 2：一次创建、一次撤销补丁），`PUBLICATION_REVOKED` 是 `clean-final / burn / new-commit`，整个 head 烧掉。认领在发布的几秒内加入或退出合并队列、续期或 touch 挪动了位子时钟、位子到期变 `missing`，都会让前后两次不同。扫描结果和合并槽没有关系：第 8 段（`control-merge-slot`）和 `kooyumi-merge-slot` 检查才需要它。

**当初为什么放进去。** `git log -S`：`da843484`（10-19，“integrate reviewed independent checks”）把 v1 发布者的绑定做成“Native 这次观察到的全部授权事实”的快照；设计文档里没有任何一处把合并槽当作扫描发布的安全前提（扫描发布者没有 CI Binding 令牌，不读 holders，§41.5）。§41.8 已经对第 8 段和第 1 段做了同类改动（只比 `state`、`ref`、`tip`，不比 `until`、`claimExpiresAt`），理由相同；扫描发布者当时漏了。防“用过期合并授权发布”的是别处：Native 完整准入（认领 ACTIVE、租约未过、围栏、纪元、`admittedFactsMatchJobV2`）和 `fresh(...)` 租约检查，以及第 8 段自己的 `LIVE_ACTUAL_MERGE_SLOT_REQUIRED`；一个扫描检查绿不等于可以合并。

**改动。** 扫描角色（`SCANNER_ROLES_V2`：gitleaks、trivy、contract-placement）的绑定里，合并槽只留 `{ref, tip}`（哪个槽、读的是 main 的哪个 tip），去掉 `state`、`until`、`observed`（`slotBindingFor`）。main 移动仍然作废。其余一律不动：subject、认领代次、执行策略、PR base、模式、Owner 审核、refs、CI 主体、签名者、检查定义、guarded 的 head 授权；槽的形状仍必须完整（`full_admission_incomplete`）；租约过期、Native 不再准入（`full_admission_not_proven`）照旧撤销。其他角色走到这个发布者时仍绑整个槽（fail closed）；第 8 段不变。

**租约和合并槽过期的关系（残余）。** 槽“从不晚于认领租约”（`20261009080000`:60-69）：租约过期时槽也同时过期。如果某次“槽过期”其实是租约到期，发布仍会被拒——这是对的（`protected_lease_expired` / `lease_expired_*` / 准入失败），本改动不碰。

**没有把撤回改成可重试（BACKOFF）。** 见任务回执：写后漂移时 GitHub 上已有一个 failure 检查（`sideEffects` ≥ 1），不可撤回，K(head, role) 与效果键也禁止重发，必须烧；写前漂移本来就是 `BLOCKED`、`sideEffects` 0、没有任何外部痕迹，而其原因（subject、认领、资格变化）是确定性的，等也不会变好；跨阶段重试需要保存签名结果、新增等待类和 Source/C# 边界改动，不在本次范围。

**查实 #992 head 580f5dd8 第 3 段的 `full_admission_not_proven`（回执 `00001217-stage-terminal.json`，批次 key `d118b857…`）。** 能读到的证据：第 1 段 09:47:31Z SETTLED，`mergeQueue` 为 head、位置 1；第 2 段 09:52:39Z 收到结果；第 3 段 09:53:41Z `REVOKED`，`sideEffects` 2（创建加撤销），`reason` 为 `full_admission_not_proven`，**`reasonCodes` 为空**——扫描发布者把 `evaluatePr` 的失败原因压平成了这一个码，诊断被丢掉了（第 1 段发布者没有这个毛病）。Source 自己的观察日志和 journal（`state2effects-scan`）在普通用户读不到的目录里，所以**真实原因没法从回执确定**。从代码能排除的：仓库里的 Native 服务端 verify 和本地 evaluator 都不把合并槽状态放进 verdict，所以“槽过期”本身不会让准入变成未证明（本节的绑定放宽修的是另一个、可以确定的缺陷：槽状态翻转触发 `authorization_binding_changed`，即 #992 的第二次撤回）。同日更可疑的线索是 GitHub 本身不稳：09:37:11Z 的 train-run 就是 `GITHUB_TRANSIENT_UNAVAILABLE`，而评估器内部的任何 GitHub 读取错误（`githubJson` 不重试）都被 `evaluatePr` 吞成 `full_admission_unavailable`，在发布者里又被压平成 `full_admission_not_proven`——这与 #992 第三例（502）是同一条路径。已做的补救：①§49 的有界读重试覆盖评估器的 GitHub 读取；②扫描发布者现在把 `evaluatePr` 的原因（`admissionReason`）和脱敏诊断（`admissionDiagnostic`）写进撤销的 journal 记录和阶段结果，下一次回执里就有诊断码；③`full_admission_unavailable` 造成的撤回标题写“verification unavailable”。**是不是又一个缺陷：是**——“诊断被压平”本身是缺陷（已修）；**结案（主会话，Decision `4f5f35d3`）：** 主会话在 09:54:35Z 用 `clued_work_verify` 查过认领 `796078d6…`，当时是 `ACTIVE`，`expires_at` 为 11:07:28Z，所以“认领租约在 09:53 前后到期”被排除；结合 09:37 的 `GITHUB_TRANSIENT_UNAVAILABLE`，按 GitHub 暂时不可读、被压平成 `full_admission_not_proven` 结案，不再需要读 `state2`。

**托管中继发布也适用（审核第 8 代，建议 5）。** `slotBindingFor` 在 `boundary()` 里调用，而 `boundary()` 是本地发布（`publish`）和托管中继发布（`publishHosted`，`kind: 'hosted'` 的 `fresh` 边界，写前和写后各一次）共用的，所以中继路径上扫描角色（gitleaks、trivy、contract-placement）同样只绑槽的 `ref` 与 `tip`，槽的 `state`、`until`、`observed` 的变化不再使中继发布撤销；其余绑定字段、完整准入、租约新鲜度在中继路径上同样没动，非扫描角色（第 8 段等）仍绑整个槽。中继路径与本地路径的这一规则是同一个函数，不是两套；这条路径没有单独的离线测试（`publishHosted` 需要已安装的中继验证器），由 `slotBindingFor` 的单元测试与共用的 `boundary()` 覆盖。

测试：`test/scan-publish-merge-slot.test.mjs`（加入队列、退出队列、过期、仅 until 变化、不再需要等 7 种槽变化 × 3 个扫描角色都 `SETTLED`；其余每个绑定字段变化仍撤销；第 8 段的槽或队首变化仍撤销；撤销诊断保留）。

## 49. GitHub 暂时错误（5xx、网络）不再烧头：只读请求有界指数退避；写后无法核对时的收尾与措辞（第 8 代；11-04 PR #992 head df85e68d）

**事故。** attempt 2（批次 dcc34762）第 1 段：写入准入检查之后的复核（`boundary` → 读 PR / 变更文件 / 检查清单）里 GitHub 回了一个 502，`github_http_502`。发布者已经把检查写在 head 上，于是按“复核失败”撤销（`REVOKED`，`sideEffects` 2），标题却写成 “Work admission authorization changed”，head 烧掉（`PUBLICATION_REVOKED`，clean-final / burn）。502 说明不了授权有任何变化。根因有两个：`github.mjs` 只重试网络错误，从不重试 HTTP 状态；评估器自己的 GitHub 读取（`githubJson`）完全不重试。

**改动。**
1. `src/read-retry.mjs#withReadRetry`，由 `controllerPorts` 包在控制器的 fetch 外面（所以发布者的 GitHub 端口和评估器的读取一起受益）：只对 GET，在 500/502/503/504 或网络错误（`TypeError: fetch failed`，cause 为网络码）时重试，延迟 1、2、4、8 秒，同一个包装（即同一段进程）的总等待不超过 20 秒，每次重试前调用 `live()`（段的期限或停止请求会结束等待）；重试用新的 30 秒超时。POST/PATCH 与所有 Native RPC（POST）原样透传，**从不重试**；501、4xx（含 403、429）、重定向、不是网络错误的拒绝都原样返回。用尽后返回最后一次的答复或错误，下游看到的仍是 `github_http_5xx` / `github_transport_unconfirmed`，分类不变。每次重试向观察日志写一条 `github_read_retry`。20 秒是被扫描发布者的 60 秒观察预算（`PUBLICATION_OBSERVE_BUDGET_MS`）约束出来的：重试不能把写前阶段拖过 `guardNewPublication`。 **预算口径（审核第 8 代，建议 4）：** ① 每次尝试（含第一次）的超时是 `min(30 秒, 段租约剩余时间)`，等待若会越过租约终点就不开始；租约终点由 `runEntry` 放在 `live.deadlineAt`，`controllerPorts` 传给包装。② 20 秒的等待预算是**每个进程两段**：第一个检查写入（`POST /check-runs`）或撤回（`PATCH /check-runs/…`）返回后预算清零，所以写前的边界读和写前探测最多用掉 20 秒，写后的核对仍有完整的 20 秒；写后总等待上限因此是 20 秒而不是“写前剩下的”。写前这一段仍受 60 秒观察预算约束（写后不受，它受租约终点约束）。
2. 写前用尽：发布者本来就返回 `BLOCKED`、`sideEffects` 0、没有任何外部痕迹，`outcomeFailureCode` 映射为 `GITHUB_TRANSIENT_UNAVAILABLE`（评估器内部吞掉的 GitHub 错误是 `full_admission_unavailable` → `NATIVE_ADMISSION_UNAVAILABLE`）。**失败表改了**（Owner 决定 `4f5f35d3`，主会话代答）：这两个码在**第 1 段**、入口自己的 `safeToRerun` 为真（没有记批次认领、没有写任何东西）时是 `environment / release-if-safe / new-trigger`——放回队列、按 10/20/40 分钟退避重来、**不烧 head**，也**不花掉 attempt 2**（attempt 2 批次被放掉时，把同一个 attempt 2 还回去，同 node-role 的办法，`reopenAttempt2(key, failureCode)`）。旧结论“第 1 段的暂时错误走 attempt 2”不再成立的理由：attempt 2 是 head 唯一的自动二次机会，而这类故障对 PR 什么也没说；入口已经证明什么都没写，释放正是铁律允许的“证明没有副作用”的情形。入口不带标志（例如已记批次认领）时仍烧头并走 attempt 2。`refusalSafeToRerun` 同时覆盖第 1 段第一步（读 GitHub 上已有的检查）里用尽的 GitHub 暂时错误。**第 3、5、7、8 段不能同样处理：** 释放只在 10-started 之前（失败表校验和 `decideFailure` 都这样规定），而第 2 段的扫描已经真跑过，放回去重跑等于同一提交同一检查跑两次；第 8 段本来就有自己的停靠重试（`STAGE8_TRANSIENT_PARK_CODES`）。第 3、5、7 段要做到“写前用尽也不烧”，必须保留已签名的结果并只重发发布，见 §50，已在 §51 实现为“原地重跑发布段”。
3. 写后用尽（检查已在 GitHub 上，`sideEffects` ≥ 1）：仍然撤销（一个无法核对的 success 不能留着；失败检查已在 head 上，head 必须烧），但标题改为 “… check withdrawn: verification unavailable”，摘要写明“GitHub 读不到，未观察到授权变化”；原因码仍是 `github_http_502`。真实的授权漂移仍写 “authorization changed”（`src/withdrawal-text.mjs`，第 1、8 段和扫描发布者三个 v2 发布者共用）。“读不到”的集合（`verificationUnavailable`）与读重试的集合一致：`github_http_500/502/503/504`、`github_transport_unconfirmed`，加上评估器内部吞掉的 `full_admission_unavailable`；429、501 等不在其内，仍按“authorization changed”的老措辞（审核第 8 代，建议 2）。撤销自己的身份读取或 PATCH 也失败时，结果是 `UNCERTAIN`（`NEGATIVE_COMPENSATION_*`，`PUBLICATION_UNCERTAIN`，HALT 等 Owner 对账），不猜、不盲写。

测试：`test/github-read-retry.test.mjs`（13 例）；`test/failure-table.test.mjs`、`test/node-mode.test.mjs`（第 1 段释放、还回 attempt 2）。

## 50. 写后失败怎么不烧 head：设计（只设计，未实现；需要独立审核和 Owner 批准）（Decision `4f5f35d3`；承接 §49）

**问题。** 检查已写到 head 上之后（`sideEffects` ≥ 1），GitHub 读不到、核对没做完，现行做法是撤回（我们自己的 PATCH，结论 `failure`；GitHub 没有 “withdrawn” 这个结论值，可用的是 success/failure/neutral/cancelled/skipped/timed_out/action_required），head 烧掉。问题是：因“verification unavailable” 撤回的检查，能不能在同一个 head 上安全重发？

**不变量（任何方案都必须保持）。** ① 同一提交的同一检查只真跑一次：重发只能用同一份已签名结果（证据摘要 `evidenceSha256` 相同），绝不重跑扫描；② K(head, role) 与效果键的语义：一个角色在一个 head 上同时只有一个“活的”发布者，已结算/已撤销的记录不被覆盖；③ 授权必须重新证明：重发前走一次完整的新 `before` 边界；④ 不放宽任何与安全相关的绑定；⑤ 生产库只读，Native 状态只经现有端口。

**方案 A：撤回之后在同一 head 上重发。** 要点与阻碍：
1. 日志：增加终态 `withdrawn`（区别于 `revoked`），只在 (a) 原因属于“读不到”集合（`verificationUnavailable`），(b) 撤回 PATCH 已读回确认为非 success，(c) 本次没有其他外部写入 时记录；`revoked` 仍是真漂移的不可逆终态。重发只允许一次，且仅第 3、5、7 段。
2. 外部 id 与检查身份：`identity()` 以 (app, head, name, external_id) 唯一识别一个检查；同一 external_id 会让 `discoverKnown`/读回遇到两个匹配（`check_discovery_unconfirmed`）。重发需要新的 external_id 代次后缀，旧检查（failure）留在 head 上。
3. **服务端阻碍（需要迁移和 Owner 批准）：** `work_claim_independent_identity_valid_v1`（迁移 `20261029050000`）把 `effect_key`、`publication_key` 固定为 job id 的函数（`native-independent-publication/1`）。同一 job 的第二次发布在 Native 看来是同一个发布身份，会撞幂等键（`work_claim_publication_idempotency_conflict`），而撤销已经走 Native 的撤销发件箱（`independent_revocation_heads`）。所以在 active 策略下，重发需要 Native 先支持“同一 job 的发布代次”，这是服务端合同变化；在 staged 策略（没有 Native 票据，今天的现状）下没有这一条，但 active 一旦打开就会撞上。
4. **GitHub 语义（必须先实验证实，不能假设）：** 必需检查是按（名称，App）取最新一次 check run，还是任何一次 failure 都挡住合并？我没有证据，不能在设计里当成事实。
5. 证据保留：已签名结果在批次被判 FAILED_CLEAN 时随工作目录归档（`failed-<批次>-publication-revoked-*`）；重发需要它仍可读且摘要不变。
6. 常驻层：第 3、5、7 段目前没有“停靠”：失败即 FAILED_CLEAN。要重发就要给发布段加停靠（类似第 8 段的 `queue.park`、`STAGE8_TRANSIENT_PARK_CODES`），重新起这一段的 broker 运行，并保证期间 Linux worker 状态不被清理。
7. 与托管转发（stage R）的 K 互斥：本地路径重发时，K 必须仍由本地持有，转发不能插进来。

结论：A 动 Source（发布者、日志、重发入口）、常驻层（停靠、归档保留）、Native（active 策略下的发布代次）三处，每处都是安全边界，必须独立审核，Native 部分还要 Owner 批准迁移；GitHub 对 failure + 之后 success 的合并语义也要先实验。**不建议现在做。**

**方案 B：缩短写后风险窗口（写前先确认 GitHub 可达）。** 在 `before` 边界通过、`authorized` 记账之后、`createCheck` 之前，做一次与写后核对同样的只读探测（PR、检查清单，各一次，走 §49 的有界重试）。探测失败就在写前以 `BLOCKED`、`sideEffects` 0 结束（第 1 段按 §49 被释放，不烧）；通过则写后核对撞上故障的概率显著下降（故障多是成片的）。代价：多两次只读请求、延后写入几百毫秒；不改任何安全绑定，也不改合同。**局限：** 它只是把一部分“写后撤回”换成“写前失败”，第 3、5、7 段的写前失败今天仍是烧头（见 §49 第 2 点），所以 B 对第 3、5、7 段单独不够，必须和 C 一起。

**方案 C：第 3、5、7 段的写前停靠（不写任何东西时重发布）。** 写前失败（`sideEffects` 0，没有 K、没有效果键、没有 GitHub 痕迹）时，不判 FAILED_CLEAN，而是把这一批停靠，保留已签名结果，按 10/20/40 分钟退避只重跑**发布段**。它不需要 A 的任何服务端或 K 变化（什么都没写过），同一份结果只发布一次（`proveNoEffects` 已有的“journal 无记录 + 角色互斥无记录 + 远端清单无匹配”三重否定证明可以直接复用，见 `runtime/one-shot-v2.mjs`）。要审核的点：停靠期间的工作目录与 Linux worker 状态保留、签名结果的有效期（`verifyResultV2` 的时间窗）、每日额度与断路器计数、与 attempt 2 的关系（停靠中的批次不再触发 attempt 2）。

**建议顺序：** §49（已做）→ B + C（一起，一次独立审核；它们让绝大多数“GitHub 抖动”在不写任何东西的情况下被吸收）→ 仍剩下的写后故障继续撤回并烧头（现状，措辞已诚实）→ 只有当实测证明 B+C 之后仍有可观的写后撤回，再考虑 A（含 Native 迁移）。**需要独立审核的部分：** B+C 的所有 Source 与常驻层改动、A 的全部。**需要 Owner 批准的部分：** C 对第 3、5、7 段“停靠而不是烧头”的策略变化；A 的 Native 迁移与 GitHub 合并语义实验。

**方案 A 的验证实验（先做实验，不在第 8 代实现；Decision `4f5f35d3`，另立项）。** 目标是回答两个事实问题，答案出来前不写任何实现。两个实验都在测试仓库或一次性测试 PR 上做，不碰生产库，不用生产的 CI 主体与令牌。
1. **GitHub：「failure 之后再来 success」的合并语义。** 在一个一次性测试仓库里建一个与生产同形的规则集（必需检查 `gitleaks`，`integration_id` 固定为一个测试 App，`strict` 开），开一个 PR。步骤：①该 App 创建 check run `gitleaks`（head H，external_id E1，`success`），读 PR 的 `mergeable_state` 与 `GET /repos/{r}/commits/{H}/check-runs`、`/status`；②PATCH 成 `failure`，再读；③同一 App 对同一 H、同名创建第二个 check run（external_id E2，`success`），再读：合并按钮（`mergeStateStatus`：`CLEAN` / `BLOCKED`）、`GET /repos/{r}/pulls/{n}` 的 `mergeable_state`、REST `merge` 调用是否被规则集拒绝（用一次性分支，合并后丢弃）；④反过来：先 `success` 再创建第二个 `failure`。记录：必需检查按“最新一个”还是“任一失败”判定；两个同名 check run 同时存在时 API 的 `check_name` 过滤、`filter=latest` 与 `filter=all` 各返回什么（我们的 `discoverKnown`/`readback` 用 `filter=all`，有两个匹配就 `check_discovery_unconfirmed`）；⑤把 `failure` 换成 `neutral` / `cancelled` / `skipped` 重复③，看哪种“撤回”结论不会挡合并。通过标准：一份带原始 API 应答的实验记录，明确“最新为准 / 任一失败即挡”和每种结论的结果；只有“最新为准”或某个结论不挡时，A 才可能成立。
2. **Native：幂等键。** 在 Supabase 测试项目（或迁移套件的 pgTAP / 本地 Postgres）上，用 `work_claim_independent_identity_valid_v1` 与 `publication_begin_independent`、`publication_finish`、`publication_abort_independent`、`independent_revocation_heads` 走：①同一 job 身份、同一 `publication_key` 的第二次 `publication_begin`（预期 `work_claim_publication_idempotency_conflict` 或返回既有发布）；②第一次发布走到撤销（出现在撤销发件箱）之后，同一身份的第二次 `publication_begin` 是被拒（`work_claim_revocation_stale` / `work_claim_publications_unresolved`）还是被允许；③`publication_key` 能否带代次（目前 `expected_key` 由 job id 与 effect_key 固定推出，`identity_valid` 要求相等，所以预计需要迁移）；④撤销头列表（`independent_revocation_heads`）对“同一头上的第二次成功发布”如何处理。通过标准：一份对每个动作的实际返回与错误码的记录，以及“要支持发布代次，迁移需要改哪几个函数”的清单。
两个实验的产出（原始应答、结论、清单）一起交给独立审核；A 的设计只有在 ①给出“最新为准”或可用的非挡合并结论，且 ②Native 要么本来允许、要么有明确的迁移方案并被 Owner 批准 时才继续。

## 51. B + C 的实现：写前探测，以及第 3、5、7 段在什么也没写时被重跑（第 8 代；Decision `4f5f35d3`）

**B（写前探测）。** 第 1 段（`formal-work-admission-check-v2`）在记批次认领之前、扫描发布者（`staged-check-publisher-v2`）在记任何 journal 与 K 之前，各再读一次写后核对要用的东西：PR 和 head 的检查清单（走 §49 的有界读重试）。读不到就在那里结束：`BLOCKED`、`sideEffects` 0、没有批次认领、没有效果键记录、没有 K、GitHub 上什么也没有，并带 `safeToRerun: true`。这把一部分“写后撤回、烧头”换成了“写前干净结束”。第 1 段的这一步（`step = 'probe'`）按 §49 被释放，不烧；第 3、5、7 段按 C。

**C（第 3、5、7 段重跑发布段）。** 没有做成“停靠”。理由：第 3、5 段处在 Linux 独占区里（准备工作区到最后一个 Linux 段，设计规定独占区里不停靠，`executor.mjs` 顶部），停靠要先关闭整批，而关闭后第 2 段的扫描结果就不在手边了。可行而且安全的做法是在批次里原地重跑**同一个发布段**：`invokeStage` 每次都从自旋池 `incoming/result.json` 重新读同一份已签名结果、用新 nonce 起新的 Source 进程；第 4 段之前（between-roles 归档之前）这份结果一直在。所以：
- 入口的判定（唯一依据，常驻层不按码推断）：扫描发布者在第一个 try 里结束（没有 journal、没有 K、没有写），原因是只读来源暂时不可用（`github_http_500/502/503/504`——正好是 §49 读重试重试的那四个状态——、`github_transport_unconfirmed`、`native_claim_observation_unavailable`，或 `full_admission_not_proven` 且其内部原因是 `full_admission_unavailable`；429、501 与其余 5xx 不在其内：它们读重试不重试，也不带这个标志，也不改撤回措辞），则在结果里写 `safeToRerun: true`。写前失败之外、任何已记 journal 的失败、签名结果被拒、角色已在 GitHub 上、授权真变化，都不带这个标志。
- 常驻层（`executor.mjs#publicationRetryable`）：只对第 3、5、7 段，且仅当结果是干净的 `BLOCKED`、`sideEffects` 0、`mayHavePublished` false、入口的 `safeToRerun` 真、Windows 树归零、runner 读回为原始二进制时，等 30 秒、90 秒、5 分钟各重跑一次（最多三次，共 7 分钟，在段自己的 15 分钟上限内），每次之前先看 Owner 的 abort。每次重跑和每次结果都写 `stage-terminal` 回执，重跑前写 `publication-retry` 回执。三次用完仍不行，按原来的路径结束（`GITHUB_TRANSIENT_UNAVAILABLE` / `PUBLICATION_BLOCKED`，烧头）。
- 不变量：K(head, role) 与效果键语义不变（重跑的每一次都是“什么也没写过”的干净开始，Source 按原规则取得 K、写 journal）；同一检查不真跑两次（重跑的是发布段，同一份签名结果，`evidenceSha256` 相同，第 2/4/6 段不再运行，测试钉了 `[1,2,3,3,3,4,...]`）；授权每次从头重新证明（完整的 `before` 边界）。
- 代价与风险：第 3、5 段的重跑会让 Linux 独占区和 Windows 交换槽多占最多 7 分钟（单批，阶段本来就允许 15 分钟）；这段时间里常驻层不处理别的事件（同步睡眠）。**我无法在这里验证：** Windows 助手/broker 对同一阶段的重复调用（`invokeStage` 的代码路径支持，第 8 段的多次尝试就是这样用的，但没有对真实 broker 做过实测）；这需要在装机的节点上做一次受控演练（人为让 GitHub 读失败一次）再放开。
- 需要独立审核和 Owner 批准：C 改变了第 3、5、7 段“写前失败即烧头”的策略；B 改了两个发布者的写前顺序。

## 52. gitleaks 审核放行 732 → 733：只放行 d94cd486 的一行（第 9 代；Decision `98fec682`）

**背景。** PR #991（`gitleaks.yml` 中间代 `ba469065` 及其登记）的登记提交 `d94cd486e29a7362888fc32cd807ceb38890acb6`（分支 `claude/gitleaks-midgen-reviewed-hold`）把该代的 `gitleaks.yml` 压成一行 JSON 字符串，写进 `scripts/ci/clued-gated-proof-profiles.json` 的第 3829 行。gitleaks 8.30.1 的 `curl-auth-user` 规则把这一行里前面的 `curl` 和后面 docker 的 `--user=65532:65532` 连成一次命中。这是误报：被匹配的 `65532:65532` 是 `docker run` 的数字 uid:gid，不是凭据。同一行字节在已放行的 `cc353e29` 里就是第 3829 行（整行连 LF 的 sha256 前 16 位 `1d46d7f51f8c0d32`），但放行是按完整指纹（提交:路径:规则:行号）的，`cc353e29` 的两条对 `d94cd486` 不生效，常驻 gitleaks 因此判 failure。

**决定。** Owner Decision `98fec682`（Clued，project `0597aa60-9b98-4da6-a4ab-63d7705b632f`）选方案 1：把放行**精确**扩展到 `d94cd486` 的这一行，钉进第 9 代。只加一条：

`d94cd486e29a7362888fc32cd807ceb38890acb6:scripts/ci/clued-gated-proof-profiles.json:curl-auth-user:3829`，kinds `["EXACT_ESCAPED_JSON_DOCKER_UID_GID"]`（与 `cc353e29` 两条相同）。

**为什么只放这一条。** `d94cd486` 对该文件只加了 gitleaks 一个来源（42 行，没有 trivy），所以只有一处命中；`cc353e29` 的第二条（trivy，5538）在 `d94cd486` 里不存在，不放。不改任何规则，不加全局、路径或正则放行。同一内容出现在别的提交里（例如 `e14db576`、`59fff541`，同一登记内容的其他提交）仍然被拒：放行绑定的是提交哈希，不是内容。

**实现（与 `cc353e29` 两条同一条证明路径，推广到“每个提交一份钉值”）。**
- `.gitleaks.toml`：`clued-reviewed-count: 733`，末尾追加那一条记录（前 732 条记录字节不变，新增常量 `PRIOR_732_RECORD_LINES_SHA256`；旧的 `ORIGINAL_730_RECORD_LINES_SHA256` 与两条一组的检查保持）。
- `reviewed_gitleaks_historical.py`：每个已审核提交有自己的钉值表 `COMMITS`（目录、角色规格、单提交补丁的 sha256 和 blob）；`d94cd486` 的规格是 `cc353e29` 的 gitleaks 规格换提交（同一索引、行号、列区间、解码行区间、来源 blob、角色），另外两条规格都新增“整行字节（连 LF）”的 sha256 钉值，`verify` 逐条比较它，证明两个提交的第 3829 行逐字节相同（有篡改该钉值被拒的测试）。`verify` 仍然要求：目录/角色规格/补丁的字节与 blob 钉值一致，补丁里该行是新增行，规则命中恰一处且列区间一致，被匹配的是 `docker run` 的数字 uid:gid，来源与角色定义对得上。
- `reviewed_gitleaks.py`：`EXPECTED_COUNT = 733`；按位置分段检查（前 730 / cc353e29 两条 / d94cd486 一条）；自检的四个历史回归（新提交、另一路径、另一行、真正的 curl 凭据）保留；“新提交”这一项另外显式用 `d94cd486` 自己的目录字节在一个新提交里再跑一遍，并要求报告里有该提交自己的发现（按 Commit 字段，不是只看文件名）。
- `selftest-shim.mjs`：自检里的 git 垫片只多放行一条精确的 `d94cd486^ d94cd486` 目录补丁命令，其他提交对一律拒绝（新增测试覆盖）。
- `prepare.mjs`：`SOURCE_PINS`、`REVIEWED_COMMITS`、`REVIEWED_HISTORY_PROOF` 全部由工具从真实 git 对象算出，不是手算（见下表）。

| 钉值 | 第 8 代（732） | 第 9 代（733） |
|---|---|---|
| `.gitleaks.toml` sha256 | `f21a46cb2a0c…` | `55d9299006dd…` |
| `reviewed_gitleaks.py` sha256 | `4441bbee3b02…` | `a604c77c92aa…` |
| `reviewed_gitleaks_historical.py` sha256 | `d395d46b18aa…` | `ed2a19865017…` |
| `REVIEWED_COMMITS` findings / commits | 732 / 103 | 733 / 104 |
| 审核提交集合 sha256 | `576a86a6061e…` | `702a8d6c6cab…` |
| `files_at_commits` | 174 | 175 |
| `verified_git_objects` | 130 | 130（只由验收文件里的对象号决定，不变） |
| 审核 ignore sha256 | `61b4af25bf5a…` | `51d18a93ba78…` |

**验证。** 用 CI 发行版里钉死的镜像 `ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0…bbb7`（`CluedCI-Linux`，`--network none`、只读、`--cap-drop ALL`）和由新 `.gitleaks.toml` 生成的审核 ignore，对真实提交对象各扫一次：`d94cd486` 在 732 的 ignore 下 1 个发现（`curl-auth-user:3829`，即线上失败），在 733 的 ignore 下 0 个；`e14db576`、`59fff541` 在 733 下仍各 1 个发现（被拒）；`cc353e29` 在两份下都是 0 个。助手的物理自检（四个历史回归、`d94cd486` 自己的目录在新提交里的那一步、以及既有各项）在同一镜像里通过：`wsl -d CluedCI-Linux`，钉死的镜像，每次 `docker run --network none`，临时目录；最终字节（助手 `a604c77c…`、历史模块 `ed2a1986…`、`.gitleaks.toml` `55d92990…`）下共 14 次物理扫描，`d94cd486` 那一步是第 13 次，报告里 14 项回归键全为 true。最后一次运行的报告落盘在 `work/independent-ci-resident-v1/evidence/gitleaks-733-physical-selftest.json`（只含自检返回的键值、镜像摘要、被测字节的 sha256、每次扫描的序号/网络模式/退出码/发现数，不含匹配文本或凭据）。运行历史：第一次尝试没有跑完——临时仓库里还没有调度提交和 role-probe 提交的对象，自检读 `fd101915` 时抛 ValueError，不是检测失败；补进这两个提交后重跑通过；用最终字节（助手 `a604c77c…`、历史模块 `ed2a1986…`）共跑了 4 次（其中一次专门数扫描：14 次、全部 `--network none`，d94cd486 那一步是第 13 次；最后一次生成上述落盘报告），结果相同。

**后果与没做的（各项都有检查办法）。**
1. **托管的 `gitleaks.yml` 及其登记没有改。** 它写死的 `.gitleaks.toml`、助手、提交集合、ignore 的摘要仍是 732 那一组（和提交 `8d2f207e` 放行 role-probe 那次一样，先改常驻 Source，托管那一代另行冻结）；要让托管路径也认这一条，需要新的 `gitleaks.yml` 代、新的登记（`clued-gated-proof-*`、`trusted-workflows`、`hosted-relay registry`、`gitleaks-732.yml` 夹具等）和独立审核。常驻 Source 用 `prepare.mjs` 里的钉值，不执行也不读 `gitleaks.yml` 里的这些摘要。
2. **证明依赖 `d94cd486` 及其父提交 `8ea4da40` 在对象库里。** `verify_history` 读该提交的目录、角色规格和单提交补丁；`build-bundle.ps1` 按已装 Source 的 `.gitleaks.toml` 把每个审核提交按哈希从 origin 取成 `refs/reviewed/<sha>`，常驻准备再把它的整个闭包打包。`d94cd486` 目前只在 PR #991 的分支 `claude/gitleaks-midgen-reviewed-hold` 上可达（`cc353e29` 已在 main 里，没有这个依赖）。**检查项：#991 合入（或 `d94cd486` 在 main 上可达）之前不得删除或改写该分支**；否则 GitHub 可能不再按哈希提供它，打包或助手 fail closed。提示在哪里看得到（实测过的路径，不夸大）：(a) **`build-bundle.ps1` 的拒绝应答**是删分支后最早的失败处（阶段 `fetch-reviewed-commits-by-sha` 的 `GIT_STEP_FAILED`，或 `reviewed-store-readback` 的 `REVIEWED_COMMIT_NOT_IN_STORE`/`EXACT_REVIEWED_REF_SET_REQUIRED`），应答里新增 `hint` 字段（`reason` 仍是稳定错误码，`storeAttempts…` 起的键序不变）：当已审核集合含 `d94cd486` 时写出该提交、其父 `8ea4da40` 和分支名。git 的 stderr 不读，所以提示不能说“缺的就是它”，只说“集合里有它，只在该分支可达，分支被删或改写请恢复”；其他阶段、其他原因或不含该提交时 `hint` 为 null（`Branch-Only-Hint`，PS 5.1 测试 6 例）。直接运行脚本时应答在 stdout 可见；**常驻运行时脚本由 companion 启动，`companion.mjs` 的 `build-bundle`/`rebuild-bundle` 在退出码 2 且应答里的 `hint` 与固定文案精确相等时写一条 `bundle-refusal` 日志**（本机 `companion-log\relay-<日期>.jsonl`，字段只有 `at`/`kind`/`op`/`reason`/`hint`）。**只记录与固定文案精确相等的 hint**：固定文案是 `build-bundle.ps1` 的 `Branch-Only-Hint` 表里的那一条字面量，`companion.mjs` 的 `BUNDLE_BRANCH_ONLY_HINT` 是同一串，测试逐字节断言两边相同；任何其他 hint（不论字符是否“合法”）一律丢弃，脚本的其他输出一律不记，`reason` 只在是普通错误码时记；对请求的应答仍是 `BUNDLE_UNAVAILABLE`，日志失败不影响应答；`halt-timeouts.test.mjs` 覆盖固定文案被记录、两边一致、各种不是固定文案的值（含路径、URL、令牌形状）被丢弃、成功时不记、日志失败）。(b) Node 准备阶段 `REVIEWED_COMMIT_NOT_IN_STORE` 的**错误消息**（`notInStoreMessage`，只有缺失集合含该提交时才加提示，测试覆盖）；但适配器 `safe()` 对外只透出错误码，所以操作者看到的仍是码，消息只在直接调用准备函数或日志里可见。(c) Python 助手 `_ensure_reviewed_commits` 的 ValueError 带提示，但 `main()` 把所有 ValueError 压成固定文案 “Reviewed-finding verification failed; raw data intentionally withheld”（`--prepare-candidate` 与 `--output` 两条路径都是），所以 CLI 对外看不到。因此真正面向操作者的提示只有 (a)（直接运行脚本看 stdout，常驻运行时看 companion 日志）；`BRANCH_ONLY`（历史模块）、`BRANCH_ONLY_REVIEWED`（`prepare.mjs`）与 `Branch-Only-Hint` 内的表是同一份清单，分支合入后三处一起删。
3. **同样内容的其他提交再出现就再需要 Owner 决定。** 例如 #991 分支被改写（rebase）后，新的提交哈希需要新的一条（733 → 734）。
4. 这一条只对 `curl-auth-user` 在这一行有效；真正的 `curl --user 身份:口令` 仍被检出（自检的 `genuine_curl_credential_detection`）。
5. **在新的托管代冻结、registry 重新登记之前，不能以本提交（或其后代）为 frozenCommit 构建 cutover 计划。** `hosted-relay-v1/registry.json` 仍钉着 732 代的 `.gitleaks.toml`、`reviewed_gitleaks.py`、`reviewed_gitleaks_historical.py` 摘要（`f21a46cb…`/`4441bbee…`/`d395d46b…`），`scan-start-cutover-plan.mjs` 对 frozenCommit 与 registry 的 sourceCommit 都核对闭包，任何带 733 新字节的提交会抛 `CUTOVER_FROZEN_CLOSURE_DRIFT`。`qualification/scan-start-cutover-plan.test.mjs` 因此固定使用 `2640dce9`（闭包仍等于 registry 钉值的最后一个提交，它的下一个提交开始 733 重新钉值），不再用 `HEAD`。扫描许可切换线要先登记 733 的托管代（新 `gitleaks.yml`、新登记、registry 重建），再用新的冻结提交构建 cutover 计划。

6. **合并 main 之后的现状（第 12 代打包时，2026-11-06，合并 main `4eb9064b`、`f4494b77`）。** 本节的 733 由 main #997 的字节取代：`scripts/ci/reviewed_gitleaks.py` 为 `e7748d75…`、`reviewed_gitleaks_historical.py` 为 `76560405…`（`.gitleaks.toml` 仍是 `55d92990…`），`formal-gitleaks-v4/required-history/prepare.mjs` 的 `SOURCE_PINS` 钉的就是这三份。上文钉值表与“验证”段写的“最终字节”`a604c77c…`/`ed2a1986…` 和 `evidence/gitleaks-733-physical-selftest.json` 记录的是合并前的候选字节：那份证据只证明当时的候选，不证明现在树里的助手，文件按证据不可变的规矩保留不改。PR #991 已合入，`d94cd486` 在 main 上可达，第 2 条的检查项已完成：`BRANCH_ONLY`、`BRANCH_ONLY_REVIEWED`（main 已删）和 `build-bundle.ps1` 的 `Branch-Only-Hint` 表三处都已清空（表为空，函数恒返回 null），`companion.mjs` 的 `BUNDLE_BRANCH_ONLY_HINTS` 也为空，任何 hint 一律不记。cutover 测试固定的提交改为 main 的 `94d70bc1`（main 上闭包仍等于 732 代钉值的最后一个提交），不再是 `2640dce9`。

## 53. 网络抖动容错（第 10 代；Task `125a5162`、`5cee3629`；Decision `4f5f35d3`：发现的缺陷全部修掉）

**事故（2026-11-05，PR #989）。** DESK-W-591 到 GitHub 的线路间歇性断开（curl 56 SSL unexpected eof，约 100 KB/s）。head `82239f97`：两次批次都 `BUNDLE_UNAVAILABLE`（每次两个新裸库只收到 2 KB / 18 KB 就断），两次释放用完 release-cap，行被 STOPPED。head `7af40318`：第 1 段写入准入检查后读 GitHub 核对失败（`full_admission_unavailable`），检查被撤回，`PUBLICATION_REVOKED` 判 clean-final，head 烧掉。熔断器把同一次断流计 3 次，02:48:58Z 打开、冷却 30 分钟，期间列车演练和角色探测都能访问 GitHub，仍干等到 03:19；第 2 次尝试 03:19:10Z 已领取、03:20:29Z 已开跑，status.json 和 03:20:10Z 发到 GitHub 的状态仍是“熔断中，约 03:18Z 试跑”。两个 head 都只能靠 Owner 批空提交恢复。日志里看不到打包为什么失败。

**总原则。** 只有能证明“是线路、不是别的”的失败才享受网络待遇（`classify.mjs#networkFailure`，53.3）；凡是可能重复出现的确定性失败（引用不合格、main 移动、提交缺失、超时、凭据被拒、评估器异常）一律照旧计 release-cap、走原来的退避阶梯和熔断级别。网络待遇本身也有上限（每 head 每天的网络释放上限，53.3），持续断网不会失控。

### 53.1 打包拒绝的原因可见（`companion.mjs#bundleRefusalLogEntry`）

以前只在拒绝答复里的 `hint` 恰好等于 §52 那条固定文案时才记一条日志，其余全部丢弃。现在**每一次**没有写出 bundle 的 `build-bundle` / `rebuild-bundle` 都写一条 `bundle-refusal`（本机 `companion-log\relay-<日期>.jsonl`），字段固定，只有代码和计数：`status`、`reason`、`stage`、最后一个 git 步骤（`label`、`exitCode`、`stderrChars`：只是 stderr 的字符数，不是内容）、`storeAttempts`、`failedAttempts`（最多 3 个：序号、原因、阶段、git 步骤、秒数；refs 竞态只记个数，不记 ref 名）、`seed`（`used`、`reason`、`discarded`、`networkFailureNoted`）、runner 自己的事实（退出码、是否超时、进程树、拒绝码）。每个值都过自己的模式（大写代码、小写步骤名、范围内的整数），不符合的记 null；脚本输出里的路径、`created` 目录、`seed.error` 文本、任何自由文本一律不记。没有可解析的答复（超时、崩溃）也记一条，脚本字段全为 null。`hint` 仍只在逐字节等于固定文案时记录（自 §52 第 6 条起固定文案列表为空，任何 hint 都不记）。日志失败不影响答复。

companion 对执行器的答复：拒绝的原因是整仓 `fetch` 或 `ls-remote` 在 git 里失败时答 `BUNDLE_NETWORK_UNAVAILABLE`（`bundleNetworkRefusal`），其余一切仍答 `BUNDLE_UNAVAILABLE`。按 SHA 取的 `fetch-reviewed`、`fetch-test` 不算：同一次尝试里它们总在整仓 `fetch` 和 `ls-remote` 都成功之后才运行（测试钉住这个顺序），失败更可能是 GitHub 已不再提供那个提交（§52 的分支被删、车头的试合并被 GitHub 丢弃），它们仍是确定性的、计普通 cap（脚本自己照旧重试它们）。答复合同（`resident-companion-response/4`）不变：只是 `code` 的取值多了一个；第 9 代的 companion 只会答 `BUNDLE_UNAVAILABLE`，执行器当作非网络处理（安全的一侧）。执行器的失败码仍是 `BUNDLE_UNAVAILABLE`。

### 53.2 网络失败后的重试走种子（`build-bundle.ps1`）

- 一次 GitHub 步骤在 git 里失败（`Network-Step-Failed`），不论这次会不会重试，都把失败时间写进 `seed-meta.json` 的新字段 `lastNetworkFailureAtUnix`（`Seed-Note-Network-Failure`：持种子锁、锁忙就跳过、任何异常都吞掉，原有测量字段原样保留；种子被丢弃时这条记录保留下来，它说的是线路不是种子）。
- `Seed-Wanted`：6 小时内（`$SeedAfterNetworkFailureSeconds=21600`）有网络失败记录时 `RECENT_NETWORK_FAILURE`，用种子，优先于 `NETWORK_FAST` 和 `REMEASURE_DUE`；时间在将来的记录被忽略（meta 仍然只是建议性的，伪造它只能开关种子）。
- 同一次构建里的网络重试：开始时通过形状检查的种子（`$seedAvailable`，丢弃或锁忙后为假）即使测量说“网络快”也启用（`SEEDED_AFTER_NETWORK_FAILURE`）；带种子的尝试里 GitHub 步骤失败后，重试**仍带种子**（以前改成不带种子，在同一条坏线路上整仓重拉 64 MB）。
- **不变量“带种子的尝试永远不是最后一次”保持**：带种子的网络重试又在 GitHub 步骤失败时（网络重试名额已用），只要仍在 900 秒窗口内，再给一次**不带种子**的尝试（`UNSEEDED_AFTER_SEEDED_NETWORK_FAILURE`），所以最坏是“不带种子失败 → 带种子失败 → 不带种子”，最多 3 次尝试，不会有第 4 次；没有种子的构建仍只有一次网络重试。种子自己出问题仍是 `SEED_UNUSABLE`：丢弃种子并紧接一次不带种子的尝试。所有核对（ls-remote 相等、main==base、已审提交逐个读回、S 的父提交、bundle 头）一项不少；回执字段不变，答复的 `seed` 对象多一个 `networkFailureNoted`。

### 53.3 网络类失败不烧 head（只在策略 /9 下）

- **什么算网络**（`classify.mjs#networkFailure`，从最具体的事实判断，绝不只看类别）：`BUNDLE_UNAVAILABLE` 且 companion 答的是 `BUNDLE_NETWORK_UNAVAILABLE`；`GITHUB_TRANSIENT_UNAVAILABLE` 且原因是 GitHub 500/502/503/504 或无答复（429 限流不算）；`NATIVE_ADMISSION_UNAVAILABLE` 且原因是显式的 Native 读用尽、慢线路上观察不完整或过期（`full_admission_mode_unknown`、`full_admission_observer_unknown`、`full_admission_observation_expired`：与 Source 写后重读的原因同一组，写前写后口径一致，`clock-skew.mjs` 的新鲜度只有 30 秒，慢线路上很容易过期），或 `full_admission_unavailable` 并且诊断说捕获的是传输故障（`transport: true`，见 53.6）；`ADMISSION_VERIFICATION_UNAVAILABLE`（Source 只把“可通过的原因”映射到它）。`BROKER_*`、其他打包拒绝、凭据或评估器异常都不算。结论写进释放记录和失败事实（`network`），回执 `batch-unexecuted` 也带上。
- **计数**：策略有 `breaker.network`（/9）时，网络释放计入 `ledger.mjs#usage` 的 `networkReleasesByHead`（不论熔断器状态），**不计** `releasesPerHeadPer24h`；上限是 `breaker.network.releasesPerHeadPer24h`（示例 36，即每 10 分钟一次可持续 6 小时；熔断器打开时实际重试更稀），到上限行以“环境停止”（`stopClass: environment`）停下，熔断器关闭、只读探测重新看到外面（53.4）或 Owner 放行时解除（`liftEnvironmentStops`）。网络释放的退避固定 10 分钟（`queue.mjs#NETWORK_BACKOFF_MS`，`levelKind: network`），这样网络恢复后 10 分钟内一定重跑。其余释放（包括非网络的环境类）**完全照旧**：计 release-cap（熔断器非 closed 时的环境类照旧不计）、10/20/40 阶梯、两次即 STOPPED。
- /7、/8 策略下没有任何变化（`usage` 不分开网络释放，执行器照旧计数）。所以第 10 代的“网络不烧 head”随新策略 /9 一起生效。

### 53.4 熔断：网络类试跑 10 分钟、同一根因不叠加、探测提前试跑、Owner 提前放行

数值在已签策略里，所以新增**策略合同 /9**（`policy.mjs`）：/8 全部字段加 `breaker.network = { trialDelayMs, earlyTrialProbes, releasesPerHeadPer24h }`。`trialDelayMs` 1 分钟到 `breaker.backoffMs[0]`（只能缩短）；`earlyTrialProbes` 1–10；`releasesPerHeadPer24h` 1–144（53.3）。示例 `config/policy.v9.example.json` = 已装的 /8 值 + `network: { trialDelayMs: 600000, earlyTrialProbes: 2, releasesPerHeadPer24h: 36 }`。/7、/8 原样接受、行为不变（Owner 放行在任何合同下都可用）。

- **网络原因**（`breaker.mjs`）：打开熔断的那组失败全部带 `network`（执行器把 `networkFailure` 的结论随批次结局交给熔断器）时 `cause = 'network'`，试跑等 `trialDelayMs`（10 分钟）。混有任何别的失败就是 null，用原来的 30/60/120。第 9 代带过来的状态（条目没有这个标志）不会被当成网络原因。
- **同一根因不叠加**：网络原因的熔断，试跑又以网络失败结束时按同一级重开，还是 10 分钟，一次断流不会把冷却叠到 60、120（所以网络只需要一个延迟值，不再是一组）；它的代价由每 head 的网络上限兜住。试跑以别的失败结束则按原规则升一级，原因变为 null，之后照原阶梯。
- **只读探测提前试跑**：熔断器 open 且原因为网络时，角色探测得到**确定答复**（`held` / `not-held`；`uncertain` 也是探测自身读不到时的结果，算失败）、第 10 段的摘要带回 main 的提交（真的读到了 GitHub；不当班的运行什么也不读，`mainSha` 为 null，算失败）各算一次成功，失败的探测把计数清零；连续 `earlyTrialProbes` 次成功、**且其中至少一次是读到 GitHub 的第 10 段**（角色探测只读 Native；11-05 断的正是到 GitHub 的线路，Native 能答复不说明 GitHub 能到）时试跑立即到期（已经到期就保持），只解除**网络上限**造成的停止（`queue.mjs#liftNetworkStops`；其他环境停止，例如在普通 cap 停下的确定性打包拒绝，仍等熔断器关闭）、把网络退避中的行设为立即到期（`queue.mjs#wakeNetworkRows`），回执 `breaker-early-trial`（含 `lifted`、`woke`），持久化到队列文件。half-open、closed 或非网络原因的熔断器不听探测。
- **Owner 提前放行**：`windows/rearm-resident.ps1 -Request ReleaseBreaker -Reason <文字>`（提权，同 Rearm）在 `owner\` 写 `clued.independent-ci.resident-owner-breaker-release/1`（`by`、`reason`、`requestedAt`、`nonce`；`tools/rearm-tool.mjs request-release-breaker` 写同一形状，`inspect` 输出新增 `breaker`）。服务让 open 的熔断器的试跑立即到期，并像熔断器关闭时那样解除**所有**环境停止、唤醒网络退避的行（Owner 已判断故障消失），回执 `owner-request`（kind `breaker-release`，含理由、原试跑时间、级别、原因、`lifted`、`woke`）；**不关闭**熔断器，试跑仍要越过失败的位置。熔断器不是 open 时拒绝（`BREAKER_NOT_OPEN`），拒绝回执 `owner-request-refused` 里也记下理由和请求人（`kind`、`by`、`reason`），迟到或重复的请求什么也不改。

### 53.5 状态显示与实际一致

- 执行器新端口 `statusFlush`（`service-main.mjs` 传状态定时器的 `flush`）：批次领取时（`driveReserved` 开头）立即把当前批次、`RUNNING`、队列行 RUNNING 写进 status.json；熔断器的门把 open 改成 half-open（试跑开始）时立即写队列、熔断器视图并 flush。定时器正在写时请求的 flush 不再丢弃：写完后立即再写一次（`startStatusTimer`）。以前 `reportQueue` 在门之前调用，整个批次期间 status.json 都显示 open 和一个已经过去的试跑时间。
- PR 页（`pr-status.mjs#describe`）：熔断器 open 但试跑时间已到，显示“熔断后的试跑时间已到，即将开始”；half-open 显示“熔断后的试跑阶段，一次只跑一批”（half-open 只说明允许试跑，不声称正在跑；正在跑的那一批对自己的 PR 显示“运行中”）；都不再显示“熔断中”。网络原因的 open 显示“（网络故障）”。status 解析保留 `breaker.cause`（只认 `network`）。
- companion（`companion-main.mjs`）：距上次发帖超过 5 秒后，最多每 5 秒读一次 status.json；`statusSignature`（第 12 代起还包括排队行，见 §56.8；当前批次的 PR、head、attempt、段，熔断器状态与试跑时间，暂停接新，HALT，PAUSE；只用 `parseStatus` 真有的字段）一变就立即发 PR 页状态（`reportDue`），否则仍每分钟一次；`reporter.pass` 的限额与“只写变了的内容”不变。

### 53.6 写后读确认失败：有限次退避重读，仍失败则判 transient 并安排第 2 次尝试

- **可通过的原因**（`withdrawal-text.mjs#admissionVerificationRetryable`）：GitHub 读不到（500/502/503/504、无传输）；`full_admission_unavailable` **且**诊断 `transport: true`（`full-admission-v2.mjs#transportFault`，按评估代码实际抛出的形状判断：Source `github.mjs` 带码的 `github_http_500/502/503/504`、`github_transport_unconfirmed`；裸网络错误、超时；`githubJson` 的 “GitHub API … returned 502” 和 Native RPC 的 “Clued … returned 503” 或 “… returned 503: <细节>”；凭据被拒、401/403/429、评估器异常都不是，诊断里 `transport: false`）；观察不完整或过期（`full_admission_mode_unknown`、`full_admission_observer_unknown`、`full_admission_observation_expired`、写后的 `NATIVE_OBSERVATION_EXPIRED_AFTER_WRITE`；写前这些本来就是 transient）。`transport` 布尔值进 Source 与常驻两侧的诊断白名单（`admission-facts-v2.mjs`、`engine-windows.mjs#parseStageOutcome`），不带任何文本。
- Source（`formal-work-admission-check-v2/publisher.mjs#reverified`）：写入后的核对（新的 after 边界：Native + GitHub、绑定与写前比较、读回、新鲜度）以可通过的原因失败时，等 10、30、60 秒后**从头**再做一次核对；不开始会越过“首次核对开始后 3 分钟”（`VERIFY_WAIT_WINDOW_MS`）的等待，也不开始会让持有记录到期前剩不到 2 分钟（`VERIFY_REVOKE_RESERVE_MS`，给撤回留的时间；`startup.mjs` 传 `deadlineAt`）的等待，所以最后一次核对最晚在写入后约 3 分钟开始，整个结局远在第 1 段 15 分钟上限内。每次等待前后都 `assertLive`（持有记录的租约与进程）；它拒绝时撤回也做不了，结局是 `UNCERTAIN`（交给对账，与任何租约丢失相同，测试断言了这一点）。绑定变化、读回不一致、凭据被拒等真实拒绝立即终局。已结算批次重跑时的读回（`previous` 路径）同样处理。撤回措辞：可通过的原因写 “verification unavailable”（含观察过期这几种），不是传输故障的 `full_admission_unavailable`（凭据被拒、评估器异常）写 “verification failed”（评估失败，未观察到授权变化），真实变化仍写 “authorization changed”。
- 重读用完、时间窗或期限不够时仍照旧撤回；`stage-fact.mjs#outcomeFailureCode` 把**第 1 段**、原因可通过的 `REVOKED`（用结果里绑定的诊断判断）映射为 transient 码 `ADMISSION_VERIFICATION_UNAVAILABLE`（Source `TRANSIENT_CODES` 与常驻 `classify.mjs#TRANSIENT_CODES` 同一列表，测试钉住）。失败表新行：`transient / burn / attempt2 / counts`（`stages: "any"`，因为表要求每个码对每段都有一行；只有第 1 段会产生它）。于是 attempt 1 结束为 FAILED_CLEAN，自动安排唯一的第 2 次尝试（10 分钟后，新 job id、新 external_id；`published-on-github` 只拦同一 attempt 的准入检查，第 1 段也不在“可能已发布”记录的段里），不用新提交。其他段的 `REVOKED`（角色检查已在 head 上）和第 1 段的非可通过原因仍是 `PUBLICATION_REVOKED`，clean-final。第 2 次尝试再失败按原规则烧头。
- Native 的 Task CI 计量按 head 计一次（迁移 `20261003180000`：同一 head 再验证不重复计），所以重读和第 2 次尝试都不多花额度。

### 53.7 runner hook（Task `5cee3629`）：不属于这一代 Source，在哪里修

- 代码在 `scripts/runner/clued-runner-job-started.work-handover-native-admission-v1.mjs`（组件 `hook.runner-job-started` 1.0.1，`config/clued-components.json` 钉了 `content_sha256`），由每台自托管 runner 的 `ACTIONS_RUNNER_HOOK_JOB_STARTED` 在每个作业前运行。它**不在**常驻 CI Source 的闭包里：`source-closure.json` 只把旧的 `scripts/runner/clued-runner-job-started.mjs` 作为门禁的钉住输入，native-admission 这个 hook 文件不在其中，常驻层和 Source v2 都不加载它。所以第 10 代没有改它。
- 缺陷所在：`github()` 每个 GitHub 请求只发一次，`fetch failed` 或超时直接抛到 `main()`，被写成 `check failed: …` 并（enforced 时）拒绝作业；对改了工作流的 PR，Native 分支只认 `runnerAttempt === 1`，重跑（attempt 2）被拒，close/reopen 又因准入早于新 run 被判陈旧，所以一次网络抖动就用掉唯一一次运行，只能推新提交。
- 应该在哪里修：在 `scripts/runner/` 出一个新的 hook 后继版本（例如 `…work-handover-native-admission-v2.mjs`，组件 1.0.2）：对只读 GET 做有界重试（5xx 与网络错误，指数退避，总时长在 `CLUED_RUNNER_HOOK_WAIT_SECONDS` 之内，令牌签发请求单独有界），并同时设计 `5cee3629` 正文里的恢复路径（同一 head 的准入在 reopen 后的首个 run 可用，或常驻层对已完成 head 在 reopen 时补发一次新的准入；都必须保持“一个提交一个检查只真跑一次”）。然后按该组件自己的流程：更新 `config/clued-components.json` 版本与摘要、`qualify-native-admission-candidate.mjs`、独立审核、精确 Source 接受、合入后由 Owner 在每台 runner 上按受保护机器流程安装，并用真实作业启动日志做资格确认。这是一条仓库 PR（主线），与常驻 Source 安装分开。

### 53.8 安装第 10 代时要 Owner 批准的内容

1. **新策略 /9**：已签策略改动的字段只有 `contract`（`…resident-policy/8` → `/9`）和新增的 `breaker.network.trialDelayMs = 600000`、`breaker.network.earlyTrialProbes = 2`、`breaker.network.releasesPerHeadPer24h = 36`；其余数值与已装的 /8 相同（安装时的 `sourceManifestSha256`、`ciSourceManifestSha256`、`residentManifestSha256` 和 `ownerAcceptance.decisionRef` 照每次安装更新）。新策略哈希需要 Owner 的 Decision、Grant 与一次 UAC。
2. **行为变化**（需要 Owner 决定接受，全部只在 /9 下生效的标 /9）：
   - /9：网络释放（53.3 的判定）不计 `releasesPerHeadPer24h`，改计每 head 每天 36 次的网络上限，退避固定 10 分钟（原 10/20/40）；到上限是可自动解除的环境停止。
   - /9：网络原因的熔断试跑等 10 分钟（原 30），同一断流的失败不升级；只读探测连续 2 次真正到达外面、其中至少一次读到 GitHub 时试跑立即到期，解除网络上限的停止并唤醒网络退避的行。
   - 所有策略：Owner 的 `ReleaseBreaker` 让试跑立即到期，并像熔断器关闭那样解除所有环境停止、唤醒网络退避的行。
   - 所有策略：companion 对整仓 `fetch` / `ls-remote` 的 git 失败答 `BUNDLE_NETWORK_UNAVAILABLE`；打包拒绝全部进本机日志（只有代码和计数）。
   - 所有策略：网络重试与之后 6 小时的构建用种子（种子仍只是建议性的，核对不变）；带种子的网络重试再失败时多一次不带种子的尝试（最多 3 次）。
   - 所有策略：第 1 段写后核对在可通过的原因下有界重读；仍失败时撤回并转为 transient → 自动第 2 次尝试（原为 clean-final 烧头）。`full_admission_unavailable` 的诊断多一个 `transport` 布尔值。
   - 所有策略：状态立即刷新与 PR 页措辞；撤回措辞多一种 “verification failed”。
   - 所有策略：trivy 缓存（53.11）：断流但容器移除已确认的 DB/checks 下载算干净失败（DB 继续下一次尝试并可回退到 72 小时内的旧 DB），时间不够时跳过下载走回退；旧的 `prepare.lock` 在可证明失效时自动回收（回执写在缓存根的 `reclaimed/` 下），否则有界等待后干净拒绝。
3. 不需要：ACL 变化、Native 迁移、托管工作流登记、companion 答复合同变化（`seed-meta.json` 在已有的 `bundles\_seed\` 下）。trivy 缓存根下会新建一个 `reclaimed/` 目录（0700，root，与缓存根同属 Linux 侧受保护目录，只在第一次回收时创建）。

### 53.9 测试

- `windows/test-build-bundle.ps1`（PS 5.1，184 → 225 例）：网络失败记录与时间窗、种子在“网络快”时被网络重试启用、带种子的网络重试、带种子重试再失败后的不带种子尝试与“绝无第 4 次”、无种子时仍只有一次网络重试、重试时种子损坏、锁被占用、脚本自己的拒绝不记录；整个脚本作为进程对一个关闭的本机端口运行（GitHub 不可达）：拒绝答复里的原因、阶段、git 步骤、三次尝试、`networkFailureNoted`，答复不含 URL。
- `test/halt-timeouts.test.mjs`：拒绝日志只含代码和计数、各种越界值为 null、不泄露路径/令牌/URL/ref 名、字段名与 `build-bundle.ps1` 一致；`BUNDLE_NETWORK_UNAVAILABLE` 只给整仓 `fetch` / `ls-remote` 的 git 失败（脚本里它们先于按 SHA 的取回，测试钉住顺序）。
- `test/net-tolerance.test.mjs`（新，22 例）：策略 /9 的校验与示例；`networkFailure` 的每个分支（含诊断 `transport` 经常驻解析保留）；熔断器的网络延迟、不叠加、混合原因、/7 /8 不变、旧状态、探测（含已到期再到期、只有 Native 答复不提前）、Owner 放行；角色探测经 `roleProbeMaintenance` 真跑（uncertain 清零、held 计数但不单独提前）；探测只解除网络上限的停止、Owner 放行解除全部环境停止；`ADMISSION_VERIFICATION_UNAVAILABLE` 的分类与第 2 次尝试（执行器端到端完成）；**模拟断流 45 分钟**：没有 head 被烧、没有行 STOPPED、不计 release-cap、不花 evaluation，网络恢复后第一个 PR 在 10 分钟内重新跑、三个 PR 都在 12 分钟内跑完；确定性打包拒绝仍两次即停、熔断器不标网络；网络上限停下的行在第 10 段读到 main 后被解除并跑完；/8 策略下行为与第 9 代相同；第 10 段读不到 main、角色探测 uncertain 都不算成功；Owner 放行的回执、拒绝回执里的理由；status flush 与定时器补写、PR 页文字、companion 立即重发与读取节流。
- Source：`test/github-read-retry.test.mjs`（写后一次 5xx 重读后结算；Native 传输故障一次重读后结算；持续读不到、Native 传输故障、观察过期、mode 读不到的撤回与映射；非传输的 `full_admission_unavailable` 不重读、不转 transient、措辞 “verification failed”；`transportFault` 用评估代码真实抛出的错误形状判定；时间窗、期限与租约丢失的具体结局）、`test/resident-v2-quota-phase1.test.mjs`（`transport` 穿过两侧过滤）、`test/resident-v2-build-bundle.test.mjs`（钉住新的重试规则）。
- 既有测试按新口径修改：`queue`（网络释放的上限、退避与唤醒）、`core`（usage 分开计数，/8 照旧）、`engine-v2`（诊断白名单含 `transport`）、`failure-table`。
- Source：`test/formal-trivy-cache-network.test.mjs`（新，10 例，53.11）：断流（移除已确认）的 DB 尝试是干净失败、四次后回退到 72 小时内的旧 DB；超过 72 小时或没有 DB 是干净的 BLOCKED；只有移除未确认才 UNCERTAIN；新鲜的 DB 不下载；时间不够时跳过并回退；旧锁回收（含真实目录上的回执、残留删除、锁在判断后变化则不删、奇怪的锁没有 pid、链接与陌生条目不可验证）；回收条件不满足时有界等待后干净拒绝；真实端口拒绝测试钩子。
- 平台：Windows 上全部 node、python、PS 套件；Linux 平台用 `--import` 预加载把 `process.platform` 设成 `linux` 跑全部 node 套件。逐个提交比对过（最近一次是本节所在提交的前一个提交 `1c6440aa`，最终提交另在汇报里给出）：失败的 15 例与未改动的第 9 代基线（`0521cb9f`）完全相同，都是平台假设（Windows 控制器守卫 `FORMAL_WINDOWS_CONTROLLER_REQUIRED`、NTFS 上的 POSIX 权限位），本代没有新增；新增的测试在两种平台下都通过。

### 53.10 没做的与局限

- runner hook（53.7）不在本代。
- 模拟断流是离线测试（假 companion、假引擎、假时钟）；真实 broker、真实 GitHub 断流下的表现要在装机后观察（`bundle-refusal` 日志、`batch-unexecuted` 的 `network`、`breaker-early-trial` 回执）。
- 探测提前试跑依赖第 10 段在当班运行（读到 main）或角色探测到期；都不跑时等 10 分钟或 Owner 放行。
- 整仓 `fetch` / `ls-remote` 以外的取回失败一律当确定性失败（53.1）：如果线路恰好在按 SHA 取回时断开，这一次会计普通 cap（脚本自己仍会在窗口内重试一次）。
- Linux 预加载无法模拟 POSIX 文件权限与 Windows 平台守卫，真实 Linux 上的那 15 例没有在本机验证（本机的两个 WSL 发行版都属于 CI，不碰）。

### 53.11 trivy 第 4 段：DB 下载被断流打断、旧的准备锁（第 8、9 项；2026-11-05 head `46f6e452`、`429d0e27`）

**事故。** `46f6e452`：第 4 段的 DB 下载容器在约 100–700 KB/s、间歇断开的线路上超时；容器已被移除（清理确认），但 `runCacheContainer` 把超时记为 `unknown`，缓存准备于是判 `UNCERTAIN`（`DB_EXECUTION_OR_CLEANUP_UNKNOWN`）并**保留** `prepare.lock`；随后 `LINUX_WORKER_ENDED_WITHOUT_RECORD` → `BRIDGE_ABANDONED_UNPUBLISHED`，第 3 段已发布，不能有第 2 次尝试，head 烧掉。`429d0e27`：那把保留的锁（风险清单 R6）让之后每一次 trivy 准备都被 `EEXIST` 拒绝，又烧掉一个 head，直到 Owner 手工删锁（`owner-recovery/trivy-prepare-lock-20261105.json`）。

**改动（`worker/formal-trivy-v3/cache.mjs`）。**
1. **干净失败。** DB 或 checks 容器结局不明（超时、断线、退出读不到），但**移除已确认**时，它只能写过自己新建的 staging 目录（唯一的可写挂载 `/cache`），而 staging 只在成功并核对后才会被提升，所以这是一次干净的失败尝试：DB 继续下一次尝试（4 次：两个仓库各 2 次，规则不变），四次都失败时走已有的“72 小时内旧 DB 回退”（`databaseDecision`）；checks 是干净的 `BLOCKED`（`PINNED_CHECKS_DOWNLOAD_FAILED`），锁释放。只有移除**没有**确认的，才照旧 `UNCERTAIN` 并保留锁。
2. **时间预留。** 只在作业还剩 `DB_ATTEMPT_MS`（310 秒，一次下载的上限）+ `SCAN_RESERVE_MS`（420 秒，扫描 300 秒加核对与清理）时才开始一次 DB 下载；没时间的尝试记为 `skipped: NO_TIME_LEFT` 的失败，由同一条回退规则决定。以前四次下载可能吃光 25 分钟，扫描没有时间，或以 `CACHE_AUTHORITY_EXPIRED` 结束。
3. **新鲜的 DB 直接用。** 不变：当前 DB 可用且 `NextUpdate` 未到时不下载（`databaseDecision` 的第一条）。
4. **旧锁回收。** 拿锁遇到 `EEXIST` 时读旧锁（`readLockState`：不跟随链接；只有 `lock()` 写出的 `{pid, nonce}` 形状才有 pid）。同时满足：锁里的 pid 已不存在（`process.kill(pid, 0)` 得 `ESRCH`；锁由 worker 进程自己写，pid 不存在即该角色的 worker 进程已结束）、没有任何带 `clued.verify.nonce` 标签的容器（`docker container ls --all`）、`staging/` 下每一项都是 `db-`/`checks-` 形状的真实目录（`stagingLeftovers`）——才回收（`reclaimStaleLock`）：先把锁用一次原子 rename 认领到缓存根的 `reclaimed/claim-<随机>`（同一把锁只有一个回收者能成功），核对认领到的仍是判断时那一份字节与 inode（不是就放回并拒绝）；再写一条持久、只创建的回执（`clued.independent-ci.trivy-cache-lock-reclaimed/1`：时间、锁的摘要与 pid、认领文件名、将要删除的残留 `stagingToRemove`、三条证明）；再删残留（不跟随链接）；最后写完成记录（`…-done/1`，实际删掉的 `stagingRemoved`），然后正常拿锁继续。拿锁遇到 `EEXIST` 而再读时锁已消失，立即重试拿锁，不等一个轮询周期。任何一条不满足（pid 还在、有容器、残留不可验证、锁形状不对）都不回收：每 15 秒再看一次，最多 5 分钟（且不越过下载与扫描的预留），之后干净地 `BLOCKED`（`CACHE_PREPARATION_LOCK_BUSY`），绝不 `UNCERTAIN`、绝不保留锁。
5. 测试钩子只经 `fixtureCachePort`；`actualCachePort` 先拒绝带钩子的选项（`ACTUAL_CACHE_HOOKS_REFUSED`），并在构造时把四个输入复制成冻结副本，之后调用方再改选项对象（加钩子、换存储或 docker 客户端）都影响不到准备过程。真实存储对象本身在打品牌之前冻结，方法不能被替换。回收竞争中输掉的一方（认领那一次 rename 得到 ENOENT，或 rename 报告成功但随后认领文件并不存在——并发 rename 时某些系统会这样，实测 Windows 上出现过——即对方已认领：`CACHE_LOCK_CLAIM_LOST`）不算错误，回到拿锁；认领之后的任何错误照常抛出、干净拒绝。

### 53.12 第 4、6 段失败为什么不能有第 2 次尝试，以及不用新提交的恢复路径（安全说明）

- **原因。** 第 3 段（gitleaks 发布）已经在 head 上发布了角色检查。第 2 次尝试会以新的 job id 从第 1 段重来：第 1 段的 `published-on-github` 读回会看到 gitleaks 角色检查而以 `HEAD_PUBLISHED_ON_GITHUB` 结束；即使绕开它，第 2 段也会对同一提交再真跑一次 gitleaks 并再发布一次，违反“同一提交的同一检查只真跑一次”与 K(head, role) 的语义（§50 的不变量 ①②）。所以 `attempt2Decision` 只允许第 0、1、2 段，`BRIDGE_ABANDONED_UNPUBLISHED` 在第 4、6 段是 `new-commit`。这条不放宽。
- **本代的做法（快修）。** 从源头消除这两类失败（53.11）：断流的 DB 下载不再变成 `UNCERTAIN`/保留锁，能回退就回退；旧锁可证明失效时自动回收。剩下的第 4、6 段失败（例如锁确实被占用、72 小时内没有可用 DB）仍按原规则结束。
- **不需要新提交的恢复路径（第 11 代已实现，见 §54；与这里的原设想有出入）。** 在**同一批次内**原地重跑执行段（第 4 或 6 段）。实现的条件以 §54.1、§54.2 为准：§27 的静止与“未发布”证明、或干净的环境拒绝，两台主机静止，按 `retry-stage-N-K` 归档，有界次数与退避，安装授权要够用。原设想里“读 GitHub 确认该角色没有检查”没有实现：第 5、7 段还没有跑，本批次不可能已有该角色的检查；扫描许可也不需要（`NATIVE_SCAN_START_REQUIRED = false`）。独立审核的结论见第 11 代的汇报。

## 54. 第 4、6 段同批次原地重跑（第 11 代；Decision `4f5f35d3`：发现的缺陷全部修掉；承接 §53.12；第 14 代起含第 2 段，见 §59）

第 4 段（trivy）和第 6 段（contract-placement）是执行段：只在 Linux 上真跑扫描器，把签名结果放进 spool，**自己不发布任何检查**；检查由其后的第 5、7 段发布。第 3 段已经发布了 gitleaks，所以这两段失败后不能有第 2 次尝试（§53.12）。

本代的做法：环境类失败、并且能证明什么都没发布时，**在同一批次内**有界重跑该段。不烧 head，也不需要新提交。

**与 §50 不变量 ① 的关系（如实说明）。** ① 原文是“同一提交的同一检查只真跑一次，绝不重跑扫描”，本节重跑的正是扫描。本节保持的是：

- **只发布一次：** 第 5、7 段各只跑一次；
- **K(head, role)：** 一个角色在一个 head 上只有一个发布者。

重跑扫描的依据，是 §27 那类结构性的“未发布”证明，与 O-2（Owner Decision `eaa7d5e4`：第 2 段的一次自动 attempt 2）属于同一类。O-2 当时明确说第 4、6 段不进 attempt 2；本节没有改 attempt 2，而是在批次内重跑，出发点是第 11 代的任务（主会话下发，Decision `4f5f35d3`）。把“重跑扫描”扩展到第 4、6 段，需要 Owner 在安装第 11 代时确认。

### 54.1 规则（`classify.mjs#executionRetryable`，纯函数）

只适用于第 4、6 段（`EXECUTION_RETRY_STAGES`；第 14 代起含第 2 段，只限放弃证明，见 §59），并且 Windows 一半的证明（`windowsTreeZero` 且 `serviceOriginalStopped`）必须齐全。满足下列之一才重跑：

- **memory-gate：** 内存闸门在调用之前就拒绝了（`LINUX_MEMORY_NOT_READY`），本段什么都没跑。
- **abandoned-unpublished：** §27 的扫描放弃证明成立（`scannerAbandonEligible`：结束码在允许表里、泵的码可证明、需要时有 `STOP_SENT`、泵已安静）。例子是 11-05 head `46f6e452` 的 `LINUX_WORKER_ENDED_WITHOUT_RECORD`。
- **clean-refusal：** 结果为 `BLOCKED`，`sideEffects` 为 0，`mayHavePublished` 为 false，原因在 `EXECUTION_RETRY_BLOCKED_REASONS` 中（`LINUX_PREPARATION_REFUSED`、`BRIDGE_CALLBACK_DEADLINE`、`REMOTE_REFS_UNAVAILABLE`、GitHub/Native 读不到的那组网络原因）。`full_admission_unavailable` 只有带 `transport` 标记时才算。
  - 这一类不要求 `pumpQuiet`。原因：伴随进程按顺序处理请求，重跑之前的静止证明（`linux-quiescence`）排在旧泵之后才执行，所以能证明旧泵和 worker 都已结束。
  - **与 Source 注释的分歧（如实说明）：** `LINUX_PREPARATION_REFUSED` 是 Windows issuer 对 Linux 端所有干净拒绝的统称。其中有环境原因（准备锁、DB 或 checks 下载被网络切断），也有确定性的配置拒绝（`DIRTY_SOURCE_NOT_QUALIFIED`、`QUALIFIED_JOB_CONTEXT_MISMATCH`、资格过期）。Source 的注释说干净拒绝“是最终结果，不自动重试”（`windows-issuer.mjs`、`formal-trivy-v4/adapter.mjs`），那是指 Source 自己不重试。常驻层在批次内有界重跑，对确定性的拒绝只是白跑最多两次、约 6 分钟加两次运行，与安全无关；分不清的时候按“可能是环境”处理。如果要让 Linux 端把可重试的原因单独透传出来，需要改 Source 的拒绝格式，另立任务。

关于 PR 本身的拒绝一律不重跑：PR 关闭或变了、refs 移动、未准入、`github_http_403/429` 等。`UNCERTAIN`、有副作用或可能已发布的结束，除了放弃证明能覆盖的情形，也一律不重跑。

### 54.2 执行器（`executor.mjs`，阶段循环）

第 4、6 段失败后，在原有的结束路径之前，最多重跑 2 次（`EXECUTION_RETRY_MS = [60 s, 300 s]`）。每次重跑都是独立的一次段运行，有自己的上限。

**重跑之前（`prepareExecutionRetry`），依次要求：**

1. 没有 HALT，没有漂移（`driftCode`）。
2. **安装授权覆盖得了**（`executionRetryFitsAuthority`）：`validUntil` 不早于“现在 + 等待 + 静止证明与两边归档的上限（5 分钟 + 2×14 分钟）+ 本段及之后每一段的上限加余量”；等待之后再查一次，那时只算后面各段。批次开始时的 `batchBudgetMs` 没有算重跑，所以这里另算；不够就不重跑。
3. 两台主机都静止（中止用的有界证明 `abortQuiescence`）。
4. 两台主机上的 `retry-stage-N-K` 归档都已核实，并且返回的目录名正是这个原因（`archiveNamedFor`）。
   - K 是第几次重跑，所以**每次重跑都是独立的归档实例**。Linux 工具对已经跑过的实例只回放上次结果、不移动任何东西；如果两次重跑共用一个原因，第二次就会是回放。
   - Windows 走失败现场范围，只移动桥协议记录。
   - Linux 走 `stage-retry` 范围：移动协议记录、角色锁和 `runs/*`，保留工作区。
5. 写一张 `execution-retry` 回执，带上段、第几次、等待、依据、失败码、原因、归档原因和两边的目录。

任何一步不成立，就写 `execution-retry-refused`（带停在哪一步，以及已经做好的归档目录），然后按原路径结束：放弃证明成立时仍是 `FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED` new-commit，静止证明不成立仍是 HALT。

**等待与重跑：**

- 等待期间，状态页的阶段显示为 `retry-wait`。
- 等待之后先查 Owner 中止，再查一次 HALT、漂移和授权（`executionRetryStillAllowed`）。
- 然后以 `{ betweenRoles: false, firstLinux: <与首跑相同>, again: K }` 重跑：
  - 不做 between-roles 归档，这一步已由重跑归档完成；
  - 如果本段是批次里第一个 Linux 段，refs 闸门和版本检查照样再过一遍。
- 引擎在每次调用这一段时，都会忘掉上次运行留下的停止请求（`stageStopFor`）。这样本次的停止（Owner 中止或桥停止）会找到并写入**本次**的 swap，不会拿上次的 `STOP_SENT` 当作本次的证据。
- 重跑的 `stage-terminal` 回执带 `executionRetry`。

**之后：**

- 只有重跑成功，循环才往下走到第 5 或第 7 段。它们照常只跑一次，发布的是这次成功运行的签名结果。Windows 失败现场归档会移走旧的 `incoming/result*`，所以第 5、7 段读到的只可能是本次的结果。
- 两次重跑都用完，就按原规则结束，此时 head 记为已发布（第 3 段已经发布）。

**局限：** 批次 claim 的租期由持有者续期，之后每一段都会实时核验。重跑把批次拉长后，如果 claim 在中途过期：在段开始前过期，后面的段会干净地拒绝；在 issue 写出之后、扫描中途过期，可能以未确认结束，走放弃证明烧 head，最坏是 HALT。这和以前一个很长的批次碰上 claim 过期的结果相同。常驻层读不到这个租期，所以没有把它算进重跑前的检查。

### 54.3 同一个作业再跑一次：哪些东西会挡住，怎么处理

重跑用的是同一个 `jobId`（批次行是固定的）。逐项核对：

- **Windows 调用器：** 每次调用都用新的随机 nonce 建 stage 目录，broker requestId 和签发方的 issueId 也是新的；`NATIVE_SCAN_START_REQUIRED = false`，没有一次性的 Native 扫描许可。
- **Linux 角色锁**（`policy.mjs#SERIAL_LOCK`，用 `wx` 创建）：worker 没留记录就结束时会留下这把锁，`stage-retry` 把它移入归档。Linux 侧的桥锁 `outgoing/active.lock` 和旧的 `incoming/issue.json` 也在协议记录里，一并移走。
- **contract-placement 的运行目录** `runs/placement-<jobId>`：用非递归 `mkdir` 创建，已存在会 EEXIST。由 `stage-retry` 移走 `runs/*`。trivy 的运行目录名是随机的。
- **工作区：** 容器的 bind 挂载全部只读（通用 runner 用 `readonly`；trivy 的 `docker.mjs` 逐一核对 `RW === !readOnly`），可写的只有 trivy 的 `/cache`。所以失败的那次改不了工作区，重跑直接沿用。trivy 缓存遗留的准备锁由 §53.11 回收。
- **systemd 单元** `clued-ci-worker@<jobId>`：`Type=oneshot`、`Restart=no`，处于 failed 的单元可以再次 start。
- **伴随进程的“已运行”证据（本代发现并修掉的缺陷）：**
  - 问题：上次运行留下的单元事实（failed，或 inactive 加上次的 InvocationID 和启动时间）原来会被 `workerRanEvidence` 当成“这次已运行”。`start --no-block` 之后，systemd 在负载下可能几秒后才真正启动；这期间泵读到旧事实，判为“已运行并已结束”，列表为空时就误报 `LINUX_WORKER_ENDED_WITHOUT_RECORD`。而新 worker 其实正要开始，最终静止证明失败，导致 HALT。
  - 修法：重跑时 relay-stage 请求带 `again`（只允许第 4、6 段，第 14 代起含第 2 段（§59），取值 1 或 2；首跑永远不带，见 `mailbox.mjs#validateRequest`）。泵在启动之前先读一次单元事实作为基线，只认相对基线的变化（`companion.mjs#workerRanSince`）：运行中的状态，或者新的 InvocationID 并且有新的主进程启动时间或已 failed。
  - 基线读不到时，只认运行中的状态，记录照常算证据。这是失败即关闭：最坏情况是快速结束的 worker 被报成 `LINUX_WORKER_NOT_STARTED`，之后仍要过静止证明。
  - 首跑不读基线，行为与原来完全一样，也不多一次 wsl.exe 调用。
- **引擎缓存的停止请求：** 见 54.2，每次调用时清掉。

### 54.4 归档（`linux/bin/clued-ci-resident-linux`）

只有 `retry-stage-4-1`、`retry-stage-4-2`、`retry-stage-6-1`、`retry-stage-6-2` 这四个确切原因保留工作区（第 14 代起加上 `retry-stage-2-1`、`retry-stage-2-2`，见 §59），范围记为 `stage-retry`，前缀 `failed`。它不算完成范围，所以：

- 半对照样移走并报告；
- 未知的叶子留在原处（`remainderLeftInPlace`），只报告。

其他原因的行为不变。Windows 的 `archive-windows-spool.ps1` 和离线参照 `archive.mjs` 不用改：这些原因符合通用格式，走失败现场范围，只移动协议记录。

本批次更早角色的 `runs/*`（例如第 2 段 gitleaks 的运行目录）会一起进入这次重跑的归档，不再出现在 success-close 归档里。这只是证据换了位置，没有删除任何东西。

### 54.5 策略与安装

不改签名策略（仍是 /9），也不新增策略字段；重跑次数和等待时间是代码常量。安装与第 10 代相同：Owner 批 Grant、点 UAC，由主会话负责。另外需要 Owner 确认本节开头所说的“第 4、6 段批次内重跑扫描”。

### 54.6 测试

`test/execution-retry.test.mjs`：

- 纯规则。
- 第 4 段 worker 断了一次之后重跑成功：阶段序列为 `[1,2,3,4,4,5,6,7,8]`，第 5 段只跑一次，两边都归档为 `retry-stage-4-1`，回执齐全。
- 第 6 段两次干净的环境拒绝：等待 1 分钟和 5 分钟，归档原因依次为 `-1`、`-2`。
- 重跑用完：按原样结束，head 被烧。
- 不重跑的情形：关于 PR 的拒绝、第 2 段（第 14 代起第 2 段的放弃会重跑，见 §59）、静止不成立（HALT）、归档没有核实、归档目录不是本次原因的（模拟回放），这些都会写 refused 回执并列出已做的 Windows 归档。
- 内存闸门。
- 重跑之前或等待期间出现 HALT 或漂移。
- 安装授权不够。
- 引擎每次调用都忘掉上次的停止。
- mailbox 对 `again` 的字段规则；引擎把 `again` 传给泵，其他段拒绝 `again`，首个 Linux 段重跑时保留 refs 闸门。
- `workerRanSince`。
- 泵的模拟：旧证据会误报结束；新证据会一直跟到记录。另外覆盖真结束、从未启动、基线读不到三种情况。

其他文件：

- `test/scanner-abandon.test.mjs`、`test/memory-gate.test.mjs`：第 4、6 段在原有结束之前先重跑两次，每次是独立的归档原因。
- `test/test_linux_tool.py`：`retry-stage-N-K` 保留工作区，移动协议记录、角色锁和 runs；其他原因（含 `retry-stage-4`、`retry-stage-4-3`）不保留。

## 55. 外部依赖的断流容错排查（第 11 代第 2 项；Decision `4f5f35d3`）

逐一排查常驻 CI 及其 Source 在网络中断时的表现。原则是“默认网络会抖动”：瞬时故障在有界时间内等待或重试；一时说不清的情况，既不当成功，也不当成 PR 本身的失败。凡是改动的地方，都配了断流模拟测试。

### 55.1 改动

1. **GitHub 写请求收到 5xx（`github.mjs`）。**
   - 500/502/503/504 说明不了写入是否生效，网关可能在写入落地之后才报错。现在把它当作“回复被截断”处理：按 external_id 或 check id 读回 GitHub 上的副本。
   - 读回在端口重试窗口里剩下的每个延迟点各做一次，因为副本可能稍后才出现。找到就采用（要求完全一致：App、名称、head、external_id、结论、title、summary），**永远不重发**。读回失败或一直没有副本，就保留原来的 5xx 码。其他状态码照旧不读回。
   - 端口里另外两个本身就是读的 POST（安装令牌的签发、GraphQL 的 force-push 读取），遇到 5xx 时会像连接中断一样在窗口内重发。
2. **Native 读请求（`read-retry.mjs#readPost`、`entry-runtime.mjs#nativeReadPost`、`role-probe-entry.mjs`）。** 下面三类请求按 GET 的方式重试，预算和截止时间与 GitHub 读请求相同；重试记录为 `native_read_retry`。
   - `clued_work_verify_v1` 的普通观测：没有 action、没有 `pr_ref`、`ci_dispatch` 缺省或为 false。这是服务端自己对观测的定义（迁移 `20261017215600`），也就是 native.current 的认领核验。
   - 带只读 action 的调用：`revocations_list`、`independent_revocation_heads`。
   - merge-slot 的 holders RPC，包括 role probe（每次尝试仍是 10 s）。

   **不在此列**的有两类：准入评估器的 verify（带 `pr_ref`，会绑定 PR、写一行执行准入，属于写入）；其他所有 action。

   native.current 的往返时限从第一次发送算起，为 30 s（`clock-skew.mjs`）。重试拖到超过这个时限再拿到的答复，仍按原规则拒绝。这样做偏保守。
3. **trivy checks bundle（`formal-trivy-v3/cache.mjs`）。** 第一次下载干净地失败（容器已确认删除）后，只要剩余时间还够一次下载加一次扫描，就在同一段内再试一次（`CHECKS_ATTEMPTS = 2`）。两次都失败，仍是 BLOCKED `PINNED_CHECKS_DOWNLOAD_FAILED`，接着由 §54 的段重跑处理。
4. **refs 闸门（`companion.mjs`、`engine-windows.mjs`、`executor.mjs`）。**
   - 只有当每次读都只是“线路问题”时，伴随进程才回答 `REMOTE_REFS_NO_ANSWER`。线路问题指：ls-remote 在 git 里失败（`GIT_STEP_FAILED`，`ls-remote-check`），或读超时且没有结论、进程树确认已消失（`zero`）。
   - 其他情况仍回答 `REMOTE_REFS_UNAVAILABLE`，引擎不会再问：脚本自己的拒绝、进程树未确认消失（`unconfirmed`）、未超时却没有结论。
   - 对 `REMOTE_REFS_NO_ANSWER`，引擎在 1 分钟后、5 分钟后各再问一次；这期间本段什么都没跑。
     - 等待可被 Owner 中止立即唤醒，中止后本段以 `OWNER_ABORT_REQUESTED` 结束（与 `invoke()` 相同）。
     - 每次等待之后，执行器都要再确认：没有 HALT、没有漂移、安装授权仍覆盖下一次读 refs（`CHECK_REFS_REQUEST_MS`）以及本段和之后各段（`gateWaitStillAllowed`）。不满足时说明原因：`halt`、`drift`、`authority`。
   - 闸门做了什么写进本段的 `stage-terminal` 回执：`refsGate { asks, waitRefused }`，只有问过不止一次或中途停问时才写。
   - 最终仍没有答复，就结束为 `REFS_GATE_UNCONFIRMED`。这时记录中带 `refsNoAnswer`，熔断器会把它算作网络原因（`classify.mjs#networkFailure`）。如果是执行器的检查叫停的，则不算网络原因。
5. **runner hook。** 在单独的分支 `claude/runner-hook-admission-retry`（组件 1.0.2），说明见该分支的 README。
6. **测试的偶发失败。** `formal-trivy-cache-network.test.mjs` 里有两处：
   - 回执名的正则漏掉了以 e 结尾的随机 id，约 1/16 的概率失败；
   - NTFS 按句柄改名，两个重叠的改名可能先后都报告成功。现在只在按路径改名的文件系统上测真正的并发，Windows 上只测“后到者落空”。

   `registration-core` 的偶发失败见第 3 项。
7. **docker 镜像。** 新增断言：所有容器的创建参数都带 `--pull=never`，包括扫描器（`verify-worker.mjs`、`linux-launcher.mjs` 的两种模式）和联网的 trivy 缓存容器。镜像只在安装时加载，运行期间从不从网络拉取。

### 55.2 依赖表

| 依赖 | 改前 | 改后 | 断流模拟测试 |
|---|---|---|---|
| GitHub 读 | GET 遇 5xx 或网络错误时有界重试（§49） | 不变 | `github-read-retry.test.mjs`：“read retry: …” 系列 |
| GitHub 写 | 传输中断时读回，只有连接阶段的失败才补发；收到 5xx 时不读回，于是撤回、烧 head 或 UNCERTAIN | 收到 5xx 也在窗口内多次读回，GitHub 上有副本就采用，永不重发；本身是读的 POST 遇 5xx 会重发 | `github.test.mjs`：“a 502 to the check POST after GitHub stored the run …”、“a 503 … never sent again”、“a 504 to the revocation PATCH …”、“a 504 … only at the second read-back …”、“a 5xx to a POST that is a read …” |
| Clued/Native 读 | 只有认领观测会重试；current、两个列表 action、holders、role probe 都只读一次 | 都按读请求重试；评估器的 verify 和所有写类 action 不重试 | `github-read-retry.test.mjs`：“controllerPorts: the Native claim verification …”、“role probe: …”、“read retry: a POST the caller names a read …” |
| Clued/Native 写 | 只发一次 | 不变，见 55.3 | — |
| git：首次打包 | 网络重试，加种子回退（§53.2） | 不变 | `resident-v2-build-bundle.test.mjs`：“one retry of the network steps …” |
| git：第二次打包 | 网络失败时结束为 `PARKED_BUNDLE_TOO_OLD`，烧 head | **不变**，见 55.3（脚本不支持重来） | `rebundle.test.mjs`：“any other refusal (or no answer) of the second bundle …” |
| git：refs 闸门 | 两次读都没有答复就是 `REFS_GATE_UNCONFIRMED`，烧 head | 线路问题在 1 分钟、5 分钟后各再问一次；最终失败算作网络原因 | `dependency-cuts.test.mjs`：“refs gate: …”三条、“companion: REMOTE_REFS_NO_ANSWER only when …” |
| docker 镜像 | 运行时 `--pull=never` | 不变，新增断言 | `formal-trivy-cache-network.test.mjs`：“docker: every container … --pull=never” |
| trivy DB | 4 次下载，全部失败则回退到 72 小时内的 DB（§53.11） | 不变 | `formal-trivy-cache-network.test.mjs`：“a DB download cut off by the network …” |
| trivy checks bundle | 只下载一次 | 段内再试一次，之后接 §54 的段重跑 | 同一文件：“checks bundle: …”两条 |
| WSL 桥泵 | 中继在预算内重试；重跑时会把旧单元的事实误判为本次已运行 | 以重跑前的基线为准（§54.3） | `relay-retry.test.mjs`；`execution-retry.test.mjs`：“the pump of a run again …” |
| 第 4、6 段执行 | 环境类失败就烧 head | 批次内重跑（§54） | `execution-retry.test.mjs` |
| 伴随进程 mailbox 与心跳 | 心跳丢失时停止，随后 HALT | 不变，见 55.3 | `bridge-observer.test.mjs`：“signal D …”；`request-deadline.test.mjs` |
| runner hook（GitHub 读） | 一次读失败就拒绝作业 | 读请求有界重试，等待按墙钟计 | 分支 `claude/runner-hook-admission-retry`：`clued-runner-job-started.test.mjs` 中的 “transient reads: …”、“clock: …” |

### 55.3 不改的部分及理由（后续任务）

下面标为“后续任务”的三项，已由主会话在 Clued 登记（project `0597aa60`），任务 ID 写在各项末尾。

- **第二次打包（停靠点 A 的重新打包）。**
  - 原因：`build-bundle.ps1 -Rebundle` 在取数之前就建立 `gen-2\`。断网后脚本回答 `PARTIAL_STATE_PRESERVED_NO_RETRY` 并保留 `gen-2\`；再跑一次会以 `FIXED_TARGET_ALREADY_EXISTS` 拒绝。脚本头部也写明 “never twice”。所以常驻层这边的重试不可能成功，第 11 代没有做（审查时发现后已撤下）。
  - 要修，只能改 Source：把没有 receipt 的 `gen-2\` 在 create-only 与 reparse 检查之下改名移开（例如 `gen-2-failed-<n>`），让 `Current-Receipt` 忽略它，并补 PowerShell 测试。这属于 Source 改动，需要单独送审，是**后续任务**（Clued `3e2e12d7-f266-46db-9a77-1026b41e7d58`）。
- **Native 写类 RPC**，逐项说明：
  - `publication_finish`、`publication_reconcile`、`independent_legacy_drain_finish`：服务端按发布 id 加 check run id 重放并返回原 receipt，回复丢失后再发一次本身是安全的。但发布者在“发出之后”的状态机（回执日志、`discoverKnown`）需要一并设计“再发 finish”这一步，才能不烧 head。
  - `publication_begin_independent`：回复丢失已有恢复路径（`adoptOpenTicket`）。
  - `scan_start_independent`：一次性的 burn key，按设计“丢失的回复永远不给第二次启动”；真正缺的是只读的读回。
  - 以上都要按 §50 的方式设计并经 Owner 批准，列为**后续任务**（Clued `21fbe23b-7e65-4e07-9a02-36e0c307363c`）。
- **发布者遇到完全一致的副本时撤回**（`discoverKnown`）：55.1 第 1 项的多次读回缩小了这个窗口。如果副本在端口窗口之后才出现，发布者仍会撤回它、烧 head。把“采用完全一致的副本”的逻辑搬到发布者里，属于发布状态机的改动，列为**后续任务**（Clued `a7951534-a9e9-4c82-a1a0-b4c1cec48e5f`）。
- **伴随进程请求无应答、心跳丢失导致 HALT**：这时状态未知，Linux 上可能还有进程在跑。按设计必须停下，交给 Owner 处理，不能猜。
- **`ci_nodes_status`**：只读，但它走 Source A 的端口（`clued-merge-train-native.mjs`），不经过本节的 `readPost`。保守起见，本代不动。

## 56. 推送后全自动（第 12 代；Task `c9dea57b`；Decision `4f5f35d3`：发现的缺陷全部修掉）

目的：一个 PR 推送之后，少等、少人手。范围有四项：

1. 第 8 段因 `RESIDENT_MERGE_QUEUE_NOT_JOINED` 停靠时，自动入队。
2. 入队以后第 8 段马上重试。
3. 认领快过期而批次还在跑时，提醒或自动续租。
4. 必需测试的准入超时后自动补跑。

第 2 项全部、第 3 项的提醒部分在本分支实现（56.2、56.3）。第 1 项、第 3 项的自动续租、第 4 项均已由 Owner 决定：入队选 A、批准 CI 延长租约（Clued Decision“第 12 代‘推送后全自动’设计决定”），补跑改选 C（Decision `207c0cd0` v2，由伴随进程点）。Native 侧在从 main 切出的分支上实现；常驻侧调用 CI 命令门新 action 的客户端和补跑都在本分支（56.4、56.5）。

### 56.1 查到的事实（决定方案的前提）

- **常驻 CI 拿不到续租所需的东西。**
  - 常驻 CI 在 Native 的身份是 CI 准入 Binding（`secrets\ci-admission.token`）。它能调用的只有：`clued_work_verify_v1`、`clued_work_merge_slot_touch_v1`、`clued_work_merge_slot_return_v1`、`clued_work_merge_slot_holders_v1`（以及列车的保活、水位）。
  - 加入合并队列的唯一办法，是持有者用 `clued_work_renew` 把 `merge:<repo>:main` 放进 `trigger_refs`（`apps/clued-cloud/worker/work-claims.ts`）。不是持有者 Binding 的调用方，必须带上认领的 `lease_key`。
  - `lease_key` 按合同只留在认领方会话里，不能写进文件、提交、记录或日志。续租还要求一个新的 `progress_ref`。
  - 结论：不改 Native，常驻 CI 既不能入队，也不能续租。
- **批次中途续租不会作废批次。** 批次认领（`batch-claim-v2.mjs`）只比较 claim id、fence、epoch；续租只改 `expires_at`，算同一代。第 8 段的 binding 也已不含 `until` 和 `claimExpiresAt`（Decision `b30b1b79` 第 3 项，§41.8）。
  - 所以“批次跑着时请持有者续租”是安全的提醒。
  - 钩子 `scripts/hooks/clued_work_claim_guard.py` 里“renewing during the batch voids it”的说法已经过时，是文档后续（不属于本分支）。
- **常驻 App 不能补跑 workflow。** `github.mjs#credential` 要求安装令牌的权限集合恰好是 `checks:write`、`contents:read`、`pull_requests:read`（另有只读的 `actions_variables`、`environments`），没有 `actions:write`。
- **今天入队后要等多久。**
  - 停靠后，没入队的批次按 `PARK_RETRY_MS`（10、20、40、80、120 分钟）重试。
  - 第 10 段（每 `train.maintenanceEveryMs`，即 10 分钟，只在空闲的 tick）读到队首是本批的 PR 时，会提前一次（`hintParkedHead`）。
  - 所以持有者入队后，通常要等到下一次第 10 段，约 10 分钟。

### 56.2 第 2 项：排队观察（queue watch，已实现）

- **观察谁。** 停靠在 B、最后一次尝试的原因是 `RESIDENT_MERGE_QUEUE_NOT_JOINED` 或 `RESIDENT_QUEUE_HEAD_NOT_REACHED` 的批次（`QUEUE_WATCH_CODES`）。要求同时满足：
  - 不是 §28 的暂时性停靠；
  - 不在第 1 位的 60 s 连试之中（第 1 位的尝试在 `PARK_HEAD_STREAK_MS` 的 15 分钟内本来就 60 s 一次；连试结束、重新按退避之后，第 1 位也照样观察）；
  - 下次尝试不在 30 s 之内；
  - 没超过 `park.maxMs`；
  - 当天第 8 段重试额度没用完。
- **在什么时候观察**（`executor.mjs#queueWatchMaintenance`）：
  - 只在什么也没跑的 tick 上，且节点为 ACTIVE、没有 PAUSE、所有打开的批次都停在停靠点。
  - 暂停接新期间（暂停生效，或暂停状态读不出）一律不观察，不论这个 tick 的排队有没有到期的行；列车开、接管扫描还没做完（停靠批次被扣着）时也不观察：观察之后的尝试跟不上。暂停结束后照常观察。
  - 只在已安装的 Source 整条路径都认得观察时（见下文“Source 与安装”）。
  - 时钟比上一次角色探测的结束时间或上一次观察结果还早时，不观察，等时钟追上。
- **节奏。**
  - 一次观察与上一次角色探测（观察或普通探测）**结束**之间至少隔 `QUEUE_WATCH_MS`（30 s）。所以两次探测不会挤在同一个 tick，慢的探测之后也不会紧接着再观察。别的换跑不在这个间隔里：定时的角色探测按它自己的节奏，可能紧跟在一次观察之后；第 10 段也可能夹在中间或紧挨着。
  - 每个批次自己的间隔随它在 B 停的时间变长（`QUEUE_WATCH_RAMP_MS`）：前 30 分钟 30 s，到 2 小时为止 2 分钟，之后 5 分钟。
  - 观察没有确定答复（uncertain，或者 runner 正忙而延期）时，这个批次的下一次观察至少再等 30 s、2 分钟、5 分钟、10 分钟（`QUEUE_WATCH_FAIL_MS`，按连续失败次数）。
  - 几个批次按各自到期的先后轮流。每天最多 `QUEUE_WATCH_MAX_PER_DAY`（1440）次，只数真正发出的换跑；这个计数只在内存里，重启后清零。
  - 因为不空闲或安装授权快到期而没能开始的观察，不算数，`QUEUE_WATCH_MS` 内也不再试。
  - 每次换跑都带着角色探测原有的风险：没有确认事实就 HALT。按上面的节奏，一个批次在 B 停 2 小时，最多约 105 次换跑，之后每小时 12 次。
  - 观察和普通角色探测一样先写 `role-probe-intent`：换跑中途主机重启、断电或执行器崩溃，下次启动时以 `ROLE_PROBE_INTERRUPTED` 停机（`executor.mjs#roleProbeRecover`），要 Owner 复位。正常停服务（`STOP-REQUESTED`）会等当前 tick 跑完，不会触发。第 11 代 ACTIVE 时停靠批次旁边不跑定时探测，现在批次停在 B 的前 30 分钟每次探测结束 30 s 后又观察，探测时间占比升高，这类停机的机会也随之升高。是否接受这个代价、或改成观察中断不停机，交 Owner 决定；本代不改恢复规则。（第 13 代：Owner Decision `2907d858` 改成自动恢复，见 §57.1。）
- **探测多回答什么。**
  - Source v2 的 `role-probe-run/2` 多一个 `watchPr` 字段；意图清单相应变成 `role-probe-intent/2`。
  - 探测本来就读一次 `clued_work_merge_slot_holders_v1`。在值班的情况下，如果唯一的持槽者绑定的正好是 `<repo>#watchPr`，就回答 `ROLE_PROBE_HELD_WATCHED_HEAD`（`merge-slot-native.mjs#parseRoleProbe`）。
  - 只多一位信息，而且只关于常驻自己问的 PR：PR 号不发给 Native，持有者名单也不出 entry（C2 的约束不变）。
  - 不带观察时，作业和意图仍是 /1，逐字节不变。
- **看到之后做什么**（`watchAnswered`）：
  - 只有答复从“不是队首”（或还没答过）变成“是队首”时，这个批次的尝试才马上到期，但离上次尝试结束不少于 `PARK_HEAD_RETRY_MS`（60 s）。
  - holders 一直说“是队首”而第 8 段一直说没准备好（两者读的东西不同，例如队列条目已失效而槽位还在）时，只提前一次，之后照批次自己的退避。所以观察不会让 head 比以前更快烧掉。
  - 答复先变成“不是队首”、再变回“是队首”时，再提前一次。
  - 尝试本身照旧计入各项预算。观察本身不向 GitHub 或 Native 写任何东西（只写它自己的角色探测回执），也不算尝试。
- **其余照角色探测处理。**
  - 意图和结果回执上分别多 `watchPr`、`watch {pr, head}`。
  - 有确定答复（held、not-held）时，照常记账并更新节点模式。记账时存成普通的 `ROLE_PROBE_HELD`（`role-probe.mjs#roleBookFact`），所以上一代读回去也认得。
  - 观察的 uncertain 答复不记进角色账：观察比定时探测频繁得多，一次 90 s 的网络抖动不该让 Owner 收到“连续三次无法确认”；定时探测仍照原样计数。但对熔断器，它和别的探测一样算一次失败（只是打断连续成功的计数，不通知 Owner），网络还在抖时不会凑够提前试跑的条件。
  - 探测途中时钟往回跳了，就不记账。
  - 没有确认事实就 HALT（`ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED`）；忙时只延期。
  - 不带观察的探测如果说“观察到队首”，不算事实。
- **断流。** holders 读不到时，探测回答 `ROLE_PROBE_UNCERTAIN`：不提前尝试，不 HALT，按 `QUEUE_WATCH_FAIL_MS` 退避，批次照原来的退避重试。
- **效果。**
  - 持有者加入合并队列（队列空时立即成为队首），或前面的认领合入以后，第 8 段在下一次观察（停靠后的前 30 分钟内约 30 s，之后几分钟）加一个 tick 内重试，不用再等 10 分钟以上。
  - 状态里的 `pending` 行多一个 `watched` 标记。只有被观察的行，PR 页面才写“排到队首后几分钟内查第 8 段（最晚约 HH:MM）”；不观察时（Source 太旧、STANDBY、额度用完）保持第 11 代的文字。
  - 这个标记只在最近 `QUEUE_WATCH_VIEW_MS`（90 s）内有空闲 tick 确认过时才算数。任何批次工作（新批次、从 A 继续往下跑的批次、第 8 段尝试、第 2 次尝试）每到一段，标记立即作废并重写一次排队行（批次只是停在 A 等托管信号时不算，那时观察照常进行），所以另一个批次在跑、观察根本跑不了的时候，页面回到第 11 代的文字。每个空闲 tick 都先刷新这个标记，再看节奏；在这个 tick 里刷新过、又没有被批次工作作废的标记，一直有效到这个 tick 结束时写的状态，所以观察本身慢、或者同一个 tick 里观察之后又跑了第 10 段，都不会让它在观察照常进行时失效。
  - 观察每次答 held 都会更新 `node.probe.at`，也就是“确认本节点持有角色”的探测。伴随进程的接班核对（§23.4）不因此每轮重来：核对进行中来了新的探测，照样读下去（角色不再被确认或上锁时才丢掉，丢掉的不算间隔）；节点一直 ACTIVE 时，新的核对最多每 `TAKEOVER_RECHECK_MS`（15 分钟）开始一次（`node-duty.mjs`），所以打开的 PR 多于一轮能读的 10 个时核对也能做完，GitHub 读取量和第 11 代同一量级。

### 56.3 第 3 项的提醒部分：认领租约快到期（已实现）

- **租约从哪来。**
  - Native 每次准入都会报告认领的 `expires_at`。Source v2 的调度事实多一个 `claimExpiresAt`（`admission-facts-v2.mjs#schedulingFactsV2`、`sanitizeSchedulingV2`）。拒绝诊断的形状不变。
  - 第 1 段和每次第 8 段尝试的结果都带调度事实。常驻在这两处记下这个批次最新的租约结束时间（`executor.mjs#noteLease`）。
  - CI 在这两段延长过租约（56.4）时，结果里带的是 Native 对延长的答复中的新结束时间；答复说延长了却没给时间，就不带（宁可不显示，也不显示旧的、会误报的时间）。
  - 同时写进账本：停靠点 A 的等待记录、停靠点 B 的停靠记录、每次第 8 段尝试的记录（包括 §28 的暂时性停靠）。
  - 重启后，在停靠批次的任何处理之前，按“最新尝试记录 → 停靠记录 → 等待记录”的顺序恢复。
  - 第 3、5、7 段的发布者不带调度事实，所以这几段之间的续租要到第 8 段才看得到。
- **什么算快到期**（`status.mjs#leaseShort`）：
  - 正在跑的批次：剩余时间少于“平均一批还剩的时间（从开始算 `LEASE_BATCH_ESTIMATE_MS`，22 分钟）+ `LEASE_MARGIN_MS`（30 分钟，留给第 8 段和合入）”；
  - 停靠在 B 的批次：剩余时间少于 `LEASE_MARGIN_MS`；
  - 停靠在 A 的批次（等托管信号，整批还在前面）：按刚开始跑的批次算；
  - 已过期：单独标出。
  - `expires_at` 是 Native 的时间，余量远大于 §47 的时钟容差。
  - 这个结束时间是上一次第 1 段或第 8 段尝试时 Native 说的（停在 B 时最多是 2 小时前）。持有者之后自己续了租，常驻看不到。所以提醒的说法不超过这一点：快到期时写“请现在续租（已续租可忽略）”；过了这个时间写“按上次读到的租约，认领已于 HH:MM 到期（已续租可忽略）”，给 Owner 的通知标题是“可能已到期”，不再建议重新认领、推新提交（那会丢掉一个已经过了 1–7 段的批次）。
- **怎么提醒。**
  - PR 页面上，运行中或停靠的文字后面加“；认领约 HH:MM 到期，请现在续租（已续租可忽略）”或“；按上次读到的租约，认领已于 HH:MM 到期（已续租可忽略）”。持有者在 PR 的检查里就能看到。
  - 停靠在 A、又不是状态里“当前批次”的行（A 可以同时停好几个），PR 页面写“运行中：等待托管信号”，同样带提醒。停在 A 的批次不论是不是当前批次，都按刚开始跑的批次算剩余时间；从 A 继续往下跑的批次从继续的那一刻算（状态 `current.leaseFrom`）。PR 页面和 Owner 通知用同一个起点。
  - 只有正在跑的批次才按“运行中”判断；第 1 段被拒、已经退回排队的批次不算（它的行仍可能在排队，但没有批次在跑）。
  - 状态板多一条通知 `lease-short`（批次每到一段都重算一次），每个租约结束时间和状态（快到期、已过期）各一个 key，只在状态板上还没有这个 key 时才加。伴随进程按 key 记住已弹过的通知（14 天），所以同一个 key 只给 Owner 弹一次 Windows 通知。
  - 状态 `current` 和 `pending` 行都多一个 `claimExpiresAt` 字段。
  - 批次结束（排队行不再是活的）后，记下的租约就丢掉；正在跑的批次即使它那一行已显示更新的提交，租约也保留到批次结束。
  - 同一个 head 的新一次尝试开始时，先丢掉之前记下的租约（例如上一次第 1 段被拒、批次退回排队时记下的），等这次的第 1 段从 Native 读到新的结束时间；否则可能拿几小时前的旧值误报“已到期”。
- 只是提醒：执行器的任何决定都不读它；没有事实时什么也不显示，不猜。

### 56.4 第 1 项入队、第 3 项自动续租（Owner 已决定：入队选 A，批准 CI 延长租约；Decision `207c0cd0` v3：走现有的 CI 命令门；v4：入队信任准入检查）

- **Native 侧**在从 main 切出的分支 `claude/native-ci-claim-assist` 上实现（本节对照的合同提交是 `e02ae378`，当时分支已普通合并 main `ea57e45b`；之后主会话又合并了更新的 main 准备推送，合同没有变；`script.independent-native-publication` 升到 1.1.5，agent contract 升到 54）。生产迁移和部署由主会话逐步请 Owner 批准，本会话不碰生产。
- 不新增 anon 函数（CI 面保持 CI8），而是在现有的 CI 命令门 `clued_work_verify_v1` 上加两个 action，只给 Owner 标记的 CI 准入 Binding（已启动、没撤销、用途为 resident-node 或 unspecified；不是 CI 准入 Binding 的有效令牌得到 `{status:'rejected', error_code:'admission_binding_required'}`，无效令牌得到 42501，只能报心跳的连接得到 `heartbeat_connection_only`）。两者要求的认领都是：在这个 scope 里、`bound_pr` 正是这个 PR、仍然有效（ACTIVE、未过期、没有待交接、没被更新的 fence 取代、不是没被采用的副本），并且这个 head（40 位十六进制，服务端统一转成小写；常驻客户端只发小写）在当前执行纪元里、对这个 PR、目标分支 main 有一条执行准入记录：
  - `merge_queue_join {action, scope, pr_ref, head_sha}`：把 `merge:<repo>:main` 加进 `trigger_refs`（排到队尾；失效或出队后重新排队，与持有者续租时相同）。不动租约、fence、`lease_version`、`progress_ref`、持有者、续租次数、执行纪元；已在队列里就什么也不写；`trigger_refs` 已满时干净地拒绝（`trigger_refs_full`）。写一条 Receipt `WORK_CLAIM_MERGE_QUEUE_JOINED_BY_CI`。
  - `lease_extend {action, scope, pr_ref, head_sha, minutes}`：`minutes` 为 1..180，到期时间改为 least（max（原到期，现在 + minutes），认领的硬上限 24 h）。已过期的认领不复活，每个认领 5 分钟内最多真正延长一次。同样不动 `lease_version` 和 fence，所以持有者下一次 `clued_work_renew` 不会因 CAS 被拒。写一条 Receipt `WORK_CLAIM_LEASE_EXTENDED_BY_CI`。
- **持有者续租的三处改动**（前两处是 Owner 认定的缺陷，一并修了；第三处是审查中发现的）：
  - 持有者续租显式提供 `trigger_refs` 时，整个列表被替换，包括 **CI 加上的** `merge:<repo>:main`；不带该引用就退队，工作认领保持 ACTIVE。不传 `trigger_refs` 则保留原引用和排位。成功续租退队后清除 CI 引用标记；拒绝续租不改变有效标记。CI 重新排队中的临时退队仍保留标记。
  - 第 8 段入队、续期、发布前，读取完整的当前 head check-runs 和 live 必需检查配置，按 context、App pin 和最新 id 判断终态失败。支持本仓库当前提供者：App 5368905 的六项 Native check-runs，以及 GitHub Actions App 15368 的项目 CI（现行 ci-suites、clued-cloud-tests、migration-verify）。确认失败不入队、不延长，已入队则归还槽位；新重跑中或成功覆盖旧失败，非必需检查不影响队列。规则引入 legacy、未固定 App 或未知提供者时，不把缺少 check-run 当成功，返回不可确认并停止入队/延长；已确认的其他必需检查失败优先退位。只确认失败才自动退位，短暂读取故障不误退健康队首。无需读取传统 statuses，也不增加 GitHub App 权限。
  - 持有者续租时，新的到期时间取 least（max（现有到期，现在 + 2 h），硬上限），不会把 CI 延长的租约截短。
  - CI 把租约延到硬上限后，持有者的续租照样接受（记下进度、引用和写集，到期时间保持在上限），不再以 `work_claim_hard_deadline` 拒绝；没有 CI 延长时，到了上限仍照旧拒绝。
- **入队的另一个效果**：入队改变 `trigger_refs`，和持有者续租一样：受保护的认领之前的执行准入摘要会对不上，直到 head 再验证一次。第 8 段的每次观察都会经准入评估器再 verify 一次（带 `target_branch`），所以入队后的下一次观察就会重新对上。入队成功后，这次尝试马上再观察一次，即使它的 90 s 已经用完（仍受这一段自己的期限约束），把执行准入重新记上；这次观察若碰上一时的 GitHub 或 Native 故障，就等下一次尝试再记。这次观察时如果已经排到队首，就照常发布。这次观察失败时，答复按“已在队列里、位置不明”给出（`RESIDENT_QUEUE_HEAD_NOT_REACHED`），不说没入队。
- **常驻侧（本分支）**：Source v2 的 `claim-assist-native.mjs`。
  - 第 8 段（`publisher.mjs#waitForQueueHead`）：Native 说认领不在合并队列里时，每次尝试调用一次入队，然后在同一次尝试 90 s 的轮询里继续等队首；队列空时，这次尝试就能通过。租约剩余少于 `STAGE8_LEASE_MINUTES`（180 分钟，Native 允许的最大值：最长 120 分钟的退避加 30 分钟提醒余量还有富余，所以 CI 能续上时不会在下一次尝试前误提醒）时，每次尝试延长一次。一开始就已在队首、马上可以发布的尝试不再入队，但同样延长一次（在队首和合入链的检查之后、答复“已就绪”之前）。已在队首、但合入规则或合并列车说还没准备好（例如单绿证明没成立）的尝试，在答复“没准备好”之前也延长一次。队首已就绪、之后因暂时性故障（读回检查、发布时 Native 一时读不到等）没发布成的答复，照样带回租约结束时间（包括延长后 Native 答复的新时间），但不带合并队列位置，所以 §28 的暂时性停靠计数不变。绿灯账本写不进（`GREEN_LEDGER_UNAVAILABLE`）不是 §28 的暂时性码，常驻按排位安排下次尝试，所以它带回完整的调度事实（含队首位置和延长后的租约），队首照样 60 s 后重试、不计次。
  - 两者都放在“main 已移动”（`RESIDENT_BASE_MOVED`）的检查之后：合不进去的批次不去占队列的位置。
  - **调用方的义务（Decision `207c0cd0` v4）**：服务端入队时不查 Owner Grant，而是信任准入检查。所以常驻只在本次运行里完整准入（包括需要时的 Owner 审查）刚通过之后才调用：第 8 段只在一次观察通过 `factsValid` 之后，第 1 段只在发布成功（SETTLED）之后。入队不等于合并：合并仍要过必需检查，而必需检查本身要求 Grant。测试覆盖了“准入没通过的观察不入队、不延长”。
  - 第 1 段（`formal-work-admission-check-v2/startup.mjs`）：发布成功（SETTLED）后，租约剩余少于 `STAGE1_LEASE_MINUTES`（90 分钟，一批加第 8 段）时延长一次。
  - 这两种写都不是发布：不写 GitHub 检查，不写 Native 发布记录，后面的段和合并闸门都不把它当授权。所以它们不计入这一段的 `sideEffects`。要是计入，一次本该干净的第 8 段“没准备好”会变成失败，反而烧 head。
  - 两种写都是幂等的，由服务端限次。失败只写观察日志，端口从不抛错，写日志失败也不影响结果。失败包括：门还不认识这两个 action（22023 `work_claim_ci_command_invalid`，记作 NOT_DEPLOYED）、拒绝、5xx 或断流（记作 UNREACHABLE，包括读 200 答复正文时断流）、超过 64 KiB 的答复、配置或参数不对。结果与没有它们时完全一样：持有者照常可以自己续租，56.3 的提醒照常显示。
  - 这两个 POST 不被 entry 的读重试（`read-retry.mjs`）重发：`nativeReadPost` 只把门的两个读 action 当作读。
  - 入队、延长都不使批次作废：批次认领只比较 claim id、fence、epoch。

### 56.5 第 4 项：准入超时后自动补跑（Owner 选 C：由伴随进程点；Decision `207c0cd0` v2）

- **现状。**
  - `clued-required-tests.yml` 的 `admission-gate` 最多等 600 s（`INDEPENDENT_GATE_WAIT_SECONDS`），等常驻第 1 段发出 `kooyumi-work-admission`。
  - 常驻忙时第 1 段来晚了，gate 就以 `ADMISSION_PENDING` 结束，重型 job 跳过，必需检查缺失。
  - #993 已经允许“Re-run all jobs”在同一 head 上补跑一次（`independentRepairRerun`）。缺的是谁来点：今天要 Owner 手动点。
- **做法**（`src/admission-rerun.mjs`，伴随进程里自己的 lane、自己的 Runner、自己的记忆文件 `companion-admission-rerun.json`）：
  - 伴随进程用 Owner 会话里的 gh 登录（它本来就用这个登录写 PR 状态）点一次“Re-run all jobs”：`gh api --method POST repos/<repo>/actions/runs/<id>/rerun`。不新增 workflow，不要新令牌，不给常驻 App 加权限。
  - 只在本节点 ACTIVE、没有 HALT、状态文件是最近 5 分钟（`STATUS_STALE_MS`）内写的时候（更旧的状态证明不了角色：执行器可能已停、另一节点已接手；面板触发和 PR 状态也这样读），只看本节点跑过或排过的 head（状态里的 current、排队行、最近结果），且这个 head 是轮询器看到的开着的 PR。
  - 每分钟一步；同一个 head 至多每 2 分钟看一次，从第一次看到起看 12 小时；每步至多看 5 个 head。
  - 一个 head 只要还是候选，它的记录就一直留着（不论多久），所以 12 小时的窗口不会重新开始，“永久放弃”也不会忘。记录里还记着它最后一次是候选的时间（至多每小时更新一次）。不是候选时，记录只在两种情况下去掉：完整的一步（状态新、本节点 ACTIVE、没有 HALT、轮询器已经看到开着的 PR）里它不在候选之列；或者它最后一次是候选已过 24 小时。伴随进程刚启动（轮询器还没跑过）、节点暂时 STANDBY 或 UNCERTAIN、HALT、状态过旧，都不算完整的一步。所以伴随进程刚启动、节点暂时 STANDBY 或 UNCERTAIN、HALT 时，12 小时的窗口和“永久放弃”的结论都不会被重置。
- **点之前必须全部满足**（判断从未合入的 76481044 搬来，`decide`）：
  1. 恰好一个开着的、目标为默认分支、来自本仓库的 PR 的 head 正是它，并且 App 5368905 在这个 head 上最新的 `kooyumi-work-admission` 是 completed/success、绑定这个 PR（第 1 段已发出准入；同 `independentAdmissionCheck`）。
  2. 这个 head 的 `clued-required-tests` pull_request 运行全部 completed，没有排队或在跑的尝试。
  3. 这个 head 的任何运行、任何尝试里，除 gate 外没有 job 真跑过（都是 completed/skipped）。
  4. gate 自己的补跑规则（`repairAllowed`，照搬 #993 的 `independentRepairRerun`）允许下一个尝试：之前每个尝试只跑了 gate，gate 以 `ADMISSION_PENDING`、`RERUN_REFUSED` 或 GitHub 5xx/连不上的 ERROR 结束。手动点过、但什么也没跑的补跑不占这一次。
  5. 点之前再读一次：PR 仍开着、仍是这个 head，运行仍是 completed、仍是同一个尝试。
  - 从不点“Re-run failed jobs”或单个 job。新尝试里的 gate 会再判一次，这一侧从来不是放行重型 job 的依据。
- **最多一次，断流时也不重复。**
  - 每个 head 一条回执（`clued.independent-ci.admission-rerun/1`：PR、head、run、尝试号、结果、时间）。先把 `intent` 写到盘上，再发请求，发完写结果：`sent`、`unsent`、`refused` 或 `unknown`（见下文“告知”）。
  - 这个 head 只要有任何回执（包括请求的答复丢了、或在两次写之间崩溃，只剩 `intent`），就再也不点。伴随进程启动后看到只剩 `intent` 的回执，把它改记成 `unknown`，给 Owner 弹一次“结果不确定”。
  - 第二次写（记下结果）失败时，这一步结束时或之后的某一步再写，直到写进去；在那之前盘上的 `intent` 照样挡住再点。`intent` 本身写不进时不发请求，这一步别的改动（新 head 的窗口起点、最终结论）也留到下一步写。把只剩 `intent` 的回执改记成 `unknown` 时写不进，就保持 `intent`、先不通知，下一步再改。
  - gh 起不来（`unsent`）、GitHub 拒绝（`refused`）、超时或结果无法确认（`unknown`），都只记下来，不重试，给 Owner 弹一次通知，说明情况和要不要手动补跑。
  - 回执写不进去就不发请求。记忆文件存在却读不出来、不是 JSON、或形状不完全对，这个 lane 什么也不做（忘掉回执可能导致点两次）；之后每一步重读一次，仍读不出时给 Owner 弹一次通知。回执保留 14 天。
  - 读 GitHub 失败（断流、非 0 退出、不是 JSON）时什么也不点，2 分钟后重新读。
  - 回执丢了（例如重装），还有 gate 自己的规则兜底：补跑的那次尝试里重型 job 真跑了，就不会再允许。
- **告知。**
  - 点成功后给 Owner 弹一次通知；这个 head 在 PR 页面上的基础文字前面加“已自动补跑一次必需测试；”（`pr-status.mjs#withRerunLine`）。这一句放在值班词（当班、双活停机、已交班、停摆）之后：别的节点只在文字开头读值班词（`node-duty.mjs#parseDutyStatus`），看门狗那一句仍在最后。
  - 请求的结果分四种记进回执，各给 Owner 一句话：`sent`（已补跑）；`unsent`（gh 没有启动，请求没到 GitHub）；`refused`（GitHub 以 HTTP 4xx 拒绝）；`unknown`（超时、作业宿主无法确认、或没有 HTTP 答复的失败：GitHub 可能已经开始，请到 PR 页面看）。不论哪种都不再自动点。
- **两处已知约束：以后任何新 workflow 都会碰到**（在未合入的 76481044 里实测发现）：
  - 已安装在每台 runner 上的 hook `scripts/runner/clued-runner-job-started.mjs` 只放行 main 上的 push、schedule、workflow_run、pull_request_target、workflow_dispatch，不放行 `check_run`。要用 `check_run` 触发，得先做 hook 的后继版本，并在每台 runner 上重装。
  - 每个新 workflow 都必须登记进 `.github/actions/ci-temporary-storage/coverage.json`。这个文件被 gitleaks/trivy 的 scan-start 策略钉住（`hosted-relay-v1/registry.json` 的冻结闭包，生产 Worker `ci-scan-start-v1.ts` 会核对）。所以加任何一个 workflow，都得重新钉值并部署生产 Worker，否则之后 PR 的 scan start 会被拒（`clued-cloud` 的 `ci-scan-start-worker.test.mjs` 会失败）。
  - 后者已立为 Clued 任务 `259a20c6-1e77-46fb-8ef1-8d8386d38ffc`（“新 workflow 登记要重钉 scan-start 策略并部署，应改成不需要部署”）。

### 56.6 策略、Source 与安装

- **策略。** 不改（仍是 /9），没有新的策略字段。观察的节奏和上限是代码常量。
- **Source v2 改动：**
  - `role-probe-run.mjs`：新增 /2；
  - `windows/FormalPublicBoundaryV2.cs`：session 0 助手自己的作业检查也认 /2（`RoleProbeRunId` 与 JS 的 id 一致，`watchPr` 为 1..9999999999）；
  - `invoke-stage.mjs`：`--watch-pr`、意图 /2；
  - `role-probe-entry.mjs`；
  - `merge-slot-native.mjs#parseRoleProbe`；
  - `admission-facts-v2.mjs`：`claimExpiresAt`；
  - `independent-control-checks-v2/claim-assist-native.mjs`（新）、`independent-control-checks-v2/publisher.mjs`、两个 `startup.mjs`：入队与延长租约（56.4）；
  - `resident-v2/source-closure.json`：重新生成，多了 `claim-assist-native.mjs`。
- **常驻改动：**
  - `executor.mjs`：观察、租约；
  - `role-probe.mjs`；
  - `engine-windows.mjs`；
  - `status.mjs`：`claimExpiresAt`、`lease-short`、`leaseShort`，排队行的 `watched`、`network`、`heldBy`，`queue.hold`，`parseStatus` 读出 `pid`；
  - `pr-status.mjs`；
  - `queue.mjs`、`ledger.mjs`：网络退避标记、租约写进等待和停靠记录（56.3、56.8）；
  - `admission-rerun.mjs`（新）、`companion-main.mjs`：伴随进程的补跑 lane（56.5）；
  - `node-duty.mjs`：接班核对的间隔（`TAKEOVER_RECHECK_MS`，§23.4、§56.2）。
- **安装。** 随第 12 代一起，由 Owner Grant 和 UAC 完成，本会话不安装。
  - 旧的 Source 不认识 `--watch-pr`，会以 `STAGE_PACKAGE_REFUSED` 拒绝；那样角色探测没有事实，会 HALT。
  - 所以执行器只在已安装的 Source 整条路径都认得 `role-probe-run/2` 时才观察（`engine-windows.mjs#queueWatchSupported`，读一次已安装的 `role-probe-run.mjs` 和 session 0 助手的 `windows/FormalPublicBoundaryV2.cs`，两者都认得才算）。读不到或不认得，就不观察，一切照第 11 代。读到内容或文件不存在时，结论保持到服务进程结束（已安装的 Source 运行中不会变）；其他读错误（文件被杀毒软件或备份占用）只算这一次不观察，`QUEUE_WATCH_SUPPORT_RETRY_MS`（5 分钟）后再读。

### 56.7 测试

- 常驻：
  - `test/queue-watch.test.mjs`：
    - 没入队时每 30 s 观察一次；成为队首后马上尝试，远早于 10 分钟；
    - 排在第 2 位的也观察，第 1 位在 60 s 连试之中不观察；
    - 断流时回答 uncertain，不提前、不 HALT；
    - 没有确认事实就 HALT，忙时只延期；
    - 不带观察的“队首”回答不算事实；
    - STANDBY、PAUSE、即将到期、超过 `maxMs`、超过日上限时都不观察；
    - Source 不认得观察时（或读不到）不观察；
    - holders 与第 8 段说法不一时只提前一次，答复变化后才再提前；
    - 时钟往回跳不抛错、不观察；慢的探测之后不在同一 tick 再观察；节奏随停靠时间放慢；第 8 段额度用完时不观察；
    - 记账存 `ROLE_PROBE_HELD`。
  - `test/lease-reminder.test.mjs`：
    - `leaseShort` 的边界；
    - 引擎只保留合法的时间；
    - PR 页面上运行中、停靠的提醒文字，没有事实时不显示；
    - Owner 通知只发一次；
    - 执行器从第 1 段、第 8 段取租约，重启后恢复（暂时性停靠的尝试记录、停靠记录）；
    - 未被观察的停靠行保持第 11 代文字；
    - 断流时没有事实、没有通知；
    - 批次结束后忘掉租约。
  - `test/engine-v2.test.mjs`：观察时意图 /2、带 `--watch-pr`；PR 号不合法时不观察；只有认得 /2 的已安装 Source 才算支持观察。
  - `test/admission-rerun.test.mjs`：
    - 只点一次，回执先于请求落盘，告诉 PR 页面和 Owner，重启后也不再点；
    - 断流：请求失败、超时、起不来只记 `unsent`、`refused` 或 `unknown`，不重点；读失败时不点，2 分钟后重读再点一次；
    - 只剩 `intent` 时不点；回执写不进或记忆文件读不出时不点；
    - 重型 job 跑过、gate 因别的原因拒绝时永久放弃；尝试在跑、准入还没到（或别的 App、没绑定、失败）、没有开着的 PR、fork、别的目标分支时暂不点；
    - 点之前 PR 或运行变了不点；手动补跑过但什么也没跑时仍可点；有别的 head 的 job 时不点；
    - 只在 ACTIVE、只看本节点碰过的 head；gh 端口的参数、路由、分页。
- Source v2：
  - `test/role-probe-watch.test.mjs`：
    - /1 不变、/2 的 id 绑定 PR；
    - 只有恰好一个、绑定这个 PR 的持槽者才算队首；
    - entry 不把 PR 发给 Native；
    - 断流时回答 uncertain；
    - CLI 拒绝不合法的 `--watch-pr`；
    - Windows 上用 PowerShell 编译 `FormalPublicBoundaryV2.cs`，确认 C# 接受同一个 /2 作业、算出同一个 id，/1 不变。
  - `windows/PureTestsV2.cs`（`test-pure-v2.ps1`）：/2 的接受与拒绝（PR 号绑进 id、范围、缺字段、/1 不许带 `watchPr`、合同固定）。
  - `test/claim-assist-native.test.mjs`：发送的是 CI 令牌的哈希、scope、PR、head，不发令牌本身；未部署、拒绝、5xx、断流、坏答复都有名字，不抛错；分钟数越界不发；只有租约不够时才延长。
  - `test/resident-v2-publishers.test.mjs`：第 8 段不在队列时入队一次、租约短时延长一次，仍是干净的“没准备好”；门还不认识这两个 action 或断流时，结果与没有它们时一样。
  - 调度事实相关的已有测试按新形状更新。
- 各轮审查后补的测试（两边都有，文件名写在条目里；没写文件名的在常驻的 `test/` 下）：
  - 第二轮审查后补的：
    - 延长后报告的是 Native 答复的新结束时间；
    - main 已移动时不入队、不延长；写日志抛错不影响结果；
    - 答复超过 64 KiB、配置或参数不对时不抛错；
    - 两个 POST 经过 entry 的 fetch 只发一次；
    - 第 1 段只在 SETTLED 且租约不够时延长；
    - 第 1 位连试结束后也观察；`watched` 标记过期；没能开始的观察不计数；
    - 停靠在 A 的行带提醒。
  - 第三、四轮审查后补的：
    - 补跑那一句在值班词之后，看门狗那一句在最后（经伴随进程的整次写状态验证）；
    - 补跑记忆文件形状不对时不点、只告诉一次、能读后继续；请求结果分 unsent、refused、unknown；
    - 12 小时窗口不因保存、伴随进程重启、STANDBY 或 HALT 而重置；
    - Native 答复里没有租约结束时间时忘掉旧值，重启后取最新的那条记录；
    - 观察答“不在值班”时即使没记账也转 STANDBY；被延期的观察不计数；
    - 签名随 `watched`、`claimExpiresAt`、`network` 变化；客户端拒绝不是 40 位小写十六进制的 head。
  - 第五、六轮审查后补的：
    - 每次有答复的观察都告诉熔断器（`queue-watch.test.mjs`）；
    - 停在 A 的批次在 HALT、PAUSE 时照实说（`lease-reminder.test.mjs`）；
    - 租约时间可能是旧的：过期提醒不建议推新提交（`lease-reminder.test.mjs`）；
    - 准入没通过的观察不入队、不延长（`resident-v2-publishers.test.mjs`）。
  - 第九、十轮审查后补的（`admission-rerun.test.mjs`）：
    - 一直是候选的 head 过了 24 小时也不重新开窗口；
    - 伴随进程刚启动（轮询器还没跑）、状态过旧时，记录不丢、结论不忘；
    - 超过 5 分钟的状态不算 ACTIVE 的证明，什么也不点。
  - 第十一、十二轮审查后补的：在最后一次轮询时入队成功，也会马上再观察一次；这次观察时已是队首的，照常发布两个检查（`resident-v2-publishers.test.mjs`）。
  - 第十三至十七轮审查后补的：
    - 另一个批次开始后，停靠行不再显示为被观察；位次不明的被观察行也用被观察的文字（`queue-watch.test.mjs`、`lease-reminder.test.mjs`）；
    - 运行中的批次在中途就收到租约提醒（`lease-reminder.test.mjs`）；
    - 从 A 继续的批次：停靠行不再显示为被观察；它那一行已显示更新提交时仍保留租约（`queue-watch-wait-path.test.mjs`）；
    - 批次停在 A 的安静 tick 里，停靠行的“被观察”标记不闪（`queue-watch-wait-path.test.mjs`）；
    - 停在 A 的当前批次按刚开始算；从 A 继续的批次从继续时算，PR 页面和通知一致；第 1 段被拒、退回排队的批次不发“运行中”的提醒；CI 续上租约时下一次尝试前不误提醒（`lease-reminder.test.mjs`）。
  - 第十八、十九轮审查后补的：
    - 停在 A 的在跑批次，它那一行已显示更新的提交时，也从现在算，发一次 `CLAIM_LEASE_SHORT`（`lease-reminder.test.mjs`）；
    - 上一次尝试被拒时记下的旧租约，在同一个 head 的下一次尝试开始时丢掉，不误报“已到期”（`lease-reminder.test.mjs`）；
    - 一开始就在队首的第 8 段尝试，租约短时同样延长一次，不入队，照常发布（`resident-v2-publishers.test.mjs`）。
  - 第二十轮审查后补的：
    - 网络退避到期后被按行延期压住时，PR 页面写延期，不写网络和已过的时间（`pr-status-refresh.test.mjs`）；
    - 队首已就绪、延长后遇到暂时性故障的答复带回新的租约结束时间、不带队列位置（`resident-v2-publishers.test.mjs`）；常驻按它停靠，不误提醒（`lease-reminder.test.mjs`）；
    - 暂停接新期间（没有到期行时也一样）和接管扫描扣着停靠批次时不观察，暂停结束后恢复（`queue-watch.test.mjs`）。
  - 第二十一、二十二轮审查后补的（`pr-status-refresh.test.mjs`）：
    - 到期的退避或等待不写已过的时间；被按行延期压住时写延期，非自动解除的不写“自动重试”；自己的时间还没到的行被延期时保留原来的文字和时间；
    - 延期过了期限不再算压住；熔断这类整条队列的闸门优先于按行延期；有别的批次在跑时写“当前批次结束后”；
    - 签名随 `heldBy` 和停靠位满不满变化。
  - 第二十三轮审查后补的（`pr-status-refresh.test.mjs`）：当日执行批次或评估额度用完时，到期的退避行和排队行写额度的文字，等待行不受评估额度限制；排队行延期期间写“排队中”，过期后写位次和预计时间；签名随额度满不满变化。
  - 第二十四轮审查后补的：整条队列的延期（例如两端版本不一致）对到期的退避行和排队行都写延期的文字，签名随它变化；“排队超过 1 小时”的通知写压住这一行的闸门；没有调度读额度时，额度每分钟读一次（`pr-status-refresh.test.mjs`）；入队后的那次观察失败时不报没入队（`resident-v2-publishers.test.mjs`）。
  - 第二十五轮审查后补的（`pr-status-refresh.test.mjs`）：批次停在 A 时合并列车的闸门仍在状态里、排队行写闸门，调度越过后清掉；时间还没到的退避行被延期时，通知用行自己的原因。
  - 第二十六轮审查后补的（`pr-status-refresh.test.mjs`）：从 A 继续跑的批次期间和之后不再显示之前调度遇到的整条队列延期；HALT 时“排队超过 1 小时”的通知用行自己的原因。
  - 第二十七轮审查后补的：慢的观察、观察后同一 tick 又跑第 10 段时，本 tick 的状态仍是被观察（`queue-watch.test.mjs`）；每 30 s 一次角色确认时接班核对仍能做完、新核对有间隔（`node-duty.test.mjs`）；读 200 答复正文时断流记作 UNREACHABLE（`claim-assist-native.test.mjs`）；队首就绪后绿灯账本写不了时带回完整的调度事实（第二十八轮改正，`resident-v2-publishers.test.mjs`）。
  - 第二十八轮审查后补的：队首的 `GREEN_LEDGER_UNAVAILABLE` 带回完整的调度事实，常驻 60 s 后按队首重试、不计次（`resident-v2-publishers.test.mjs`、`park.test.mjs`）；角色不再被确认而丢掉的接班核对不推迟下一次核对，ACTIVE→STANDBY→ACTIVE 与伴随进程重启后立即核对（`node-duty.test.mjs`）。
  - 第二十九轮审查后补的：已在队首、规则或列车说没准备好时也延长租约（`resident-v2-publishers.test.mjs`）；ACTIVE→UNCERTAIN→ACTIVE、执行器重启后立即做接班核对，一直 ACTIVE 时仍有间隔（`node-duty.test.mjs`）；补跑结果写不进时之后再写，只剩 `intent` 的回执记成 `unknown` 并通知一次（`admission-rerun.test.mjs`）。
  - 第三十轮审查后补的（`admission-rerun.test.mjs`）：`intent` 写不进时，这一步的其他改动在下一步写进；改记 `unknown` 写不进时保持 `intent`、不通知，下一步再改并通知一次。
  - 第三十一轮审查：只改注释和 DESIGN（租约常量的注释；观察中断时 `ROLE_PROBE_INTERRUPTED` 停机的风险写进 §56.2），没有新测试。
  - 第三十二轮审查后补的：常驻和 Source 两边对角色探测意图 /1、/2（`watchPr` 取边界值）的哈希逐字节一致（`engine-v2.test.mjs`）；§56.6 的改动清单补上 `node-duty.mjs` 和 `status.mjs` 的新字段。
  - 第三十三轮审查后补的：读已安装 Source 时一时出错，不会让观察在整个进程里关掉，5 分钟后再读（`engine-v2.test.mjs`）。

### 56.8 缺陷 `050560ac`：批次没执行、转入退避后，PR 页面仍停在“运行中”

- **现象。**
  - PR 998 head `67b0c70a` 在 10:58 领取批次，PR 页面写了“当班：运行中：第 0 段”。
  - 11:04 打包遇到网络失败（`BUNDLE_UNAVAILABLE`，network），这一行转成 BACKOFF，11:14 重试。
  - GitHub 上 `resident-queue/desk-w-591` 的状态一直停在“运行中”。
- **原因。**
  - 执行器在 tick 结束时清掉了 `current`，排队行也是 BACKOFF，`describe` 本来会写“未准入或未执行……自动重试”。
  - 但伴随进程那次写 GitHub 很可能也碰上了同一次断网，写失败了。写失败的 head 要等 `POST_RETRY_MS`（10 分钟）才再写。到 11:14 批次又跑起来，要写的又是“运行中：第 0 段”，与上一次写成功的一样，于是什么也不写。
  - 另外，伴随进程只在 `current`、熔断、暂停、HALT 变化时立即重读状态（`statusSignature`），排队行变了（转入 BACKOFF、STOPPED，重试时间）要等下一次每分钟的轮询。
- **修法**（`pr-status.mjs`、`queue.mjs`、`status.mjs`）：
  - `statusSignature` 加上排队行的 PR、head、状态、原因、下次时间，以及 `watched`、`claimExpiresAt`、`network`、`heldBy`，再加上停靠位满不满（`queue.parkingFull`）：批次没执行、转入退避或停住、重新排上、被延期压住、提醒出现，都立刻触发一次写。熔断打开或关上本来就在签名里。
  - 写失败的 head：要写的文字一变，下一次轮询就再写；同样的文字在 `POST_RETRY_MS` 之后再写，从 10 分钟改为 2 分钟。
  - 网络原因的退避（`queue.mjs` 的 `levelKind === 'network'`）在状态的 `pending` 行上带 `network` 标记。PR 页面写明原因和下次时间，例如“网络问题，打包失败，约 11:14Z 自动重试，不用推新提交”。原因文字按 `classify.mjs#networkFailure` 的几个代码给出；其他退避仍是原来的文字。
  - 退避或等待的行被按行的延期压住时（`queue.mjs#defer`：行的状态不变），排队视图仍给出行自己的原因，另用 `heldBy` 字段写延期的代码；延期只在它的期限（`deferUntil`）之内算压住，过了期限这一行又是候选。PR 页面：
    - 自己的时间还没到（例如新提交触发后提前成了候选，又被延期）：照旧写原来的文字和时间，那个时间的重试照样会跑；
    - 时间已到、被状态里看得到的整条队列的闸门压住（暂停接新、熔断、停靠位满、当日执行批次额度用完，退避行还有当日评估额度用完，以及调度遇到的整条队列的延期：companion 没就绪、两端版本不一致、托管资格窗口未确认、合并列车的接管扫描或 Source 问题，记在状态的 `queue.hold`（`executor.mjs#SCHEDULE_HOLDS`），从遇到它的那次调度一直保留到某次调度越过它，或有批次开始干活（新批次、从 A 继续的批次、第 8 段的尝试、第二次尝试：这时排队的行等的是它，下一次调度再判断）；只是停在 A 等托管信号时仍保留；额度看状态的 `limits`，由读额度的那次调度写入，没有调度读到时由每个 tick 的报告最多每分钟读一次）：先写那个闸门的文字，和排队的行一样，例如“排队第 1 位：执行器熔断中（网络故障），约 12:04Z 试跑”“排队第 1 位：今日执行批次额度已满，明天继续”；被延期压住、不在可跑的行里时写“排队中：……”，不写“第 ? 位”；
    - 时间已到、没有看得到的闸门、被按行延期压住：写延期本身，例如“排队中：本 PR 今日批次已满，之后自动重试”；不是到时自己解除的延期（`RELAY_QUALIFICATION_HELD`）不写“自动重试”；
    - 时间已到、没被压住：前面还有批次时写预计开始的时间（“约 HH:MMZ 自动重试”）；有别的批次在跑时写“当前批次结束后自动重试”；否则写“即将自动重试”。都不写已经过去的时间。
  - 排队（QUEUED）的行也一样：没有可跑的位次时写“排队中：……”（例如“排队中：冷却中（10 分钟）”）；按行延期过了期限后不再写延期的原因，回到“排队第 N 位，预计 HH:MM 开始”；当日额度用完时写额度的文字，不给预计开始时间。
  - 签名还随当日两个额度满不满、执行器的整条队列延期变化。
  - “排队超过 1 小时”的通知仍按（PR、提交、原因）各一次，原因取 PR 页面上压住这一行的东西：到期的行先看整条队列的闸门，再看按行延期，再看行自己的原因；自己的时间还没到的退避或等待行用行自己的原因，和页面一样；HALT 或 PAUSE 时不看整条队列的闸门，只用行自己的延期或原因（页面这时写停机或暂停）。按行延期过期、改由停靠位满之类的闸门压住时，通知写那个闸门（例如“停靠的批次已满”），不写“前面还有批次”。
- **测试**（`test/pr-status-refresh.test.mjs`）：
  - 网络退避的文字；非网络退避的文字不变；
  - 签名随排队行变化，行不变时签名也不变；
  - 断网时写失败，文字一变马上重写，同样的文字 2 分钟后重写。

## 57. 第 13 代：中断自动恢复、发布时事实过期、第 11 代遗留（Owner Decision `2907d858`；Decision `4f5f35d3`：发现的缺陷全部修掉）

分支 `claude/resident-gen13`，从第 12 代的 `c217fe6e` 切出。

### 57.1 角色探测被中断后自动恢复（Task `6104ca37`，Owner Decision `2907d858`）

- **以前**：角色探测（排队观察也是一次角色探测）写了 `role-probe-intent`、还没写结果时主机重启、断电或执行器崩溃，下次启动以 `ROLE_PROBE_INTERRUPTED` 停机，要 Owner 复位（§56.2）。
- **现在**（`executor.mjs#roleProbeRecover`）：
  - 数连续中断的次数：这一次，加上之前每个被记成“中断、未停机”的探测，一直数到一次正常结束的探测（或一次 Owner 复位过的停机）为止。
  - 次数少于策略的 `roleProbe.interruptedMax`，且 Windows 一侧满足复位时同样的要求（`engine.windowsQuiescence`：本进程没有换跑在进行，原始 runner 服务已停），就自己恢复。重启后的新进程看不到崩溃前那个进程留下的子进程：遗留的换跑如果还占着 broker，紧接着的新探测会得到 `BROKER_BUSY`，以 `ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED` 停机，不会在换跑进行中改判角色。恢复时：把这次意图记成 `interrupted: true, halted: false` 的结果；角色账回到上一次正常结束的探测（中断那次的半截结果一概不用）；探测设为立即到期，角色重新判定（判定规则不变）；给 Owner 一条通知 `role-probe-interrupted`（每次中断一条）。
  - 否则照旧停机，结果记成 `interrupted: true, halted: true`（Owner 复位后从头数）。读不到安静与否也停机。停机的结果同样带着上一次正常结束的探测的角色账，复位后再被中断时恢复的不是空账（审查第 1 轮 NIT）。
  - 上一次启动已经为这次意图写下 `ROLE_PROBE_INTERRUPTED` 停机、还没写结果就崩溃：下次启动按已作的决定补记 `halted: true` 的结果，不发通知，不当作一次未停机的中断（审查第 1 轮 MINOR 1）。
  - 节点已因别的原因停机时，照样补记恢复结果，但不发“已自动恢复”的通知，Owner 看到的是那次停机（审查第 2 轮 NIT）。
  - 写下恢复结果后、新探测跑之前又停了：下次启动看到最后一条是“中断、未停机”的结果，探测仍设为立即到期（快照不保存这个标记；审查第 2 轮 NIT）。
- **策略 /10**（`policy.mjs`）：/9 的全部字段加 `roleProbe.interruptedMax`（1–10）。1 表示第一次中断就停机，即 /9 及以前的行为；/9 及以前没有这个字段，行为不变。示例 `config/policy.v10.example.json` = /9 示例 + `roleProbe.interruptedMax = 3`。
- 测试：`test/probe-interrupt.test.mjs`。

### 57.2 发布时 Native 准入事实超过 30 秒不再撤回绿（Task `7b21f820`）

- **现象**：2026-11-05 PR #1001 head `5abcb6f5`，第 5 段发了 trivy 绿之后，核对时 `protected_facts_expired_during_admission`，撤回、作废 head。原因：活的授权是不超过 `FRESH_MS`（30 s）的 Native 答复（Decision `1100a0ed`），而完整准入评估本身就可能超过 30 s；受保护事实是在准入之前观察的。
- **修法**（Source v2 `staged-check-publisher-v2.mjs`），30 s 的界限不放宽：
  - **准入之后**（`liveFacts`）：受保护事实过期就再观察一次，做和第一次一样的全部核对（主体、批次认领、资格、部署引用），认领代次必须和准入观察到的相同。`observeFacts` 本身拒绝到手时就不新鲜的答复，所以一次就够，没有第二次。只有真的授权变化（换了认领代次、租约过期、资格或主体变化）才停下或撤回。
  - 这次再观察读不到（Native 无答复、或窗口用完）有自己的码 `protected_facts_reobservation_unavailable`：写前是干净的 BLOCKED、可重跑；写后照旧撤回。它不是准入之前那种可在同一窗口里再试一次的耗尽，所以外层的可恢复发布者不会把它当成不明结果（UNCERTAIN 会让节点停机；审查第 2 轮 MAJOR A）。外层发布者给出的 UNCERTAIN 一律不带 `safeToRerun`。
  - **写之前、记任何东西之前**：准入答复已过 30 s（写前的步骤慢了）：`native_admission_aged_before_write`，干净的 BLOCKED，可重跑（§51 的 `safeToRerun`）。生产端口本来就拒绝用过期的准入答复写（`prepareNativePublication`），重新观察受保护事实救不了它。日志之后到写之间仍有原来的 `lease_expired_before_write`。
  - **写后读回之后**（`liveAfterWrite`）：准入答复在读回期间过了 30 s：重新做一次完整的边界核对（观察、PR、路径、准入），绑定（`bindingSha256`、证据）必须与写时完全相同；变了，或新答复仍不新鲜，照旧撤回（`authorization_binding_changed` / `lease_expired_after_write`）。
- **生产里的观察窗口：写前 60 s，写后另给 60 s**（Owner Decision `36946d8b`；审查第 1 轮 MAJOR 1–3）。生产的发布者外面是 `createRecoverableCheckPublisherV2`。
  - **这是对 Task `a3ad42a9` 审过的界限的修改。** 原来一次发布的所有受保护观察，写前写后，共用一个 60 s 期限（`PUBLICATION_OBSERVE_BUDGET_MS`）。这样两次准入都要 40 s 时永远写不出去（每次都 BLOCKED，重跑仍一样），准入 5 s + 56 s 时写了又撤回。Owner 决定：写前的 60 s 不变，决定所用事实的新鲜度不放宽；写后核对单独给 60 s。
  - **写前**（不变）：`PUBLICATION_OBSERVE_BUDGET_MS` 只管写之前的观察，它的单次恢复（第二轮观察）、审计记录（`publication-recovery-audit/1` 的 `clock` 仍是这个窗口）和写时的 2 s 预留（`guardNewPublication`，不足就 UNCERTAIN）都不变。
  - **写后**（`runtime/one-shot-v2.mjs#protectedAuthority`）：检查发出之后（`createCheck` 经过外层发布者），写后核对的观察（写后的边界核对，以及读回期间准入过期时那一次完整重评）共用自己的窗口 `PUBLICATION_POST_WRITE_OBSERVE_BUDGET_MS`（60 s），从写后第一次观察开始计时。每次观察仍有自己的 30 s（`OBSERVE_BUDGET_MS`）。写后核对在这个窗口里做不完，照旧撤回。观察次数计数（`observationCalls`、`verifyRequests`）写前写后合计；结果日志多三项：`maxPostWriteObservationMs`、写后窗口已用和剩余（`postWriteObservationElapsedMs`、`postWriteObservationRemainingMs`，写后还没观察时为 null；`observationBudgetRemainingMs` 仍是写前窗口的；审查第 6 轮 NIT 3）。
  - **60 s 管的是写后的观察，不是写后的总时长**（审查第 6 轮 MINOR 2）。一个还没核对的绿检查在 GitHub 上挂着的最长时间是这几段之和：端口自己的读回（§55.1）；创建回复丢失时找副本（§57.4：等待共 35 s，加三次 GitHub 读，每次受 §49 的有界读重试限住）；写后观察窗口 60 s；窗口里最后一次观察之后的准入评估和读回。最后这段不受窗口限：准入评估不会在窗口到期时被截断，它按自己的超时跑完；跑完后事实若超过 `FRESH_MS`（30 s）就要再观察，窗口已过就撤回。所以这一段的长度就是那一次准入本身的时长（例如一次 90 s 的准入，会让还没核对的绿检查再挂 90 s 才被撤回），加读回（审查第 7 轮 MINOR 3）。找副本的读不占写后窗口：60 s 只管写后的观察，从写后第一次观察起算。这一点已由 Owner 确认（Decision `36946d8b` v2，2026-11-06），由测试 `the window of the confirmation starts at its first observation` 守住。
  - **写之前、记任何东西之前多查一步**（`staged-check-publisher-v2.mjs#writeFits`）：写前窗口剩下的要放得下写入本身：`WRITE_MARGIN_MS`（5 s：角色键、journal 和外层要求的 2 s 预留）加 `WRITE_NATIVE_CALLS`（2）次 Native 调用（`prepareNativePublication` 里的当前授权核对 `native.current`，它和受保护观察是同一个 verify RPC；active 策略下还有 Native 的 begin），每次按这一轮发布者尝试写前最慢的一次 Native verify 尝试的用时估计（`slowestNativeReadMs`；有答复的和超时的都算，超时说明线路至少这么慢；`native.current` 是同一个 RPC；审查第 6、7 轮 MAJOR 1）。恢复的第二轮从零重新计（只看它自己的观察），所以第一轮的超时或慢答复不会拦住审过的第二轮（G10 测试；审查第 7 轮 MINOR 1）。以前共用窗口时这一步的余量是“写前边界的时长加 5 s”，随线路快慢自然变大；分开窗口后改成按实测往返估，否则写前离期限不远、线路又慢时，会在外层的 2 s 预留处变成 UNCERTAIN、节点停机。比估计还慢的写入步骤仍由 `guardNewPublication` 兜住（不变，UNCERTAIN）。写后窗口要放得下写后核对，估计为写前那次边界核对从它第一次观察起（含这次观察本身的重试和等待）用掉的时间（`windowUsedMs` 的差，窗口自己的单调钟；没有窗口时用墙钟；托管中继在第一次观察之前的 GitHub 读不算，写后不再做；审查第 2、3 轮 MINOR 1）加 `CONFIRMATION_MARGIN_MS`（5 s，读回和两次边界之间的步骤）。任一放不下就不写：`publication_window_short_before_write`，干净的 BLOCKED。本地发布可重跑（重跑有自己的新窗口）；托管中继的 BLOCKED 照中继的规则退回本地运行该角色（角色键不在别人手里时；已在别人手里则返回 REFUSED，中继阶段以 `ROLE_ALREADY_PUBLISHED_ON_HEAD` 停机，行的 `detail` 是原因，见下文）。决定第一个条件的是写前窗口一共用掉多少（含恢复的第一轮和写前探测），不只是这一次边界核对；两个条件分开写，窗口长度不同时也对（审查第 6 轮 NIT 1）。
  - **托管中继重验别人已结算的发布**（审查第 6 轮 MAJOR 1）：同一 head 上同一角色已由中继另一个运行结算时，`publishHosted` 拿不到角色键，转而重验那次发布，这是写前窗口里又一次完整的边界核对。窗口剩下的放不下一次和写前那次一样长的边界（`boundaryFits`，加 `CONFIRMATION_MARGIN_MS`）时，中继什么都不写，不去撤回那个合法的已结算检查（以前共用窗口时，写前的检查本身就留了这么多时间），并如实返回 `REFUSED role_already_published_on_head`（`detail` 为 `publication_window_short_before_write`）：角色键确实在另一次运行手里。中继阶段因此以 `ROLE_ALREADY_PUBLISHED_ON_HEAD` 停机（HALT，Owner 复位），不把这个角色交给本地：本地发布会被同一个角色键拒绝，白跑一次扫描之后照样是这个停机码（审查第 7 轮 MINOR 2）。
  - **角色键之前的其他拒绝也一样**（审查第 8 轮 MINOR 1）：`publishHosted` 在拿角色键之前因任何原因拒绝（写前窗口放不下写入、准入过期、再观察读不到、证明未确认等）时，先读一下角色键；它已在别的持有者手里（同一角色已由中继另一次运行或本地发布持有），就同样返回 `REFUSED role_already_published_on_head`，`detail` 是原来的拒绝原因，阶段停机，不交给本地白跑（以前共用窗口时写前检查放不下，正是走的这条白跑的路，结局是同一个停机码）。角色键读不到时照旧返回 BLOCKED。
  - 中继阶段写停机行时，`detail` 取发布者给的原因（`published.detail`，没有才用 `reason`），所以 Owner 看到的是 `publication_window_short_before_write` 之类的真正原因，而不是看起来像双持有者冲突的 `role_already_published_on_head`（`hosted-relay-v1/stage.mjs`；审查第 8 轮 MINOR 2）。
  - 这几种停机只在同一 head 上同一角色已有持有者、又来了它的更新中继运行时出现。
  - 写前这三种暂时情况（`native_admission_aged_before_write`、`publication_window_short_before_write`、`protected_facts_reobservation_unavailable`）在阶段事实里都是暂时码 `NATIVE_ADMISSION_UNAVAILABLE`（`stage-fact.mjs#outcomeFailureCode`，只在什么都没写的干净 BLOCKED 上），与准入前的观察耗尽相同。其中再观察读不到和准入过期常驻算作线路故障（`classify.mjs#NETWORK_NATIVE_REASONS`）；窗口放不下不算，它说明写前那次边界核对长，单是完整准入慢就会反复出现（审查第 3 轮 MINOR 3、第 4 轮 MINOR 1）。这只影响阶段 3/5/7 烧 head 时熔断记的原因：网络原因的熔断按第 10 代的试运行节奏，其他原因逐级退避。这几个码只出现在阶段 3/5/7/9，不会走到放行，所以与网络放行上限无关（审查第 4 轮 NIT）。
  - 写后因 Native 读不到（`native_claim_observation_unavailable`、`protected_facts_reobservation_unavailable`）而撤回的检查，标题和说明写“verification unavailable”，不写“authorization changed”（`withdrawal-text.mjs`；阶段 1 的重读判断和 `safeToRerun` 用的读集合不变；审查第 3 轮 NIT）。
  - 生产接线下的结果（`test/stale-facts-production-wiring.test.mjs`）：准入 5 s + 35 s（#1001 的情形）、5 s + 40 s、40 s + 40 s、5 s + 56 s：结算；写前准入 56 s：不写、BLOCKED 可重跑；5 s + 61 s：写后超窗，撤回；写前写后各 34 s 的慢线路：结算（共用窗口时不写）；写前 Native 往返 9 s、准入 30 s：只因写入余量不够而不写，往返 6 s：结算；两次 9.5 s 超时、1 s 答复、准入 25 s：不写（超时计入估计）；第一轮被三个慢 504 用尽、第二轮立即答复、准入 10 s：结算（第二轮自己估计）；5 s + 40 s 且创建回复丢失、副本 25 s 后才出现：结算（写后窗口从写后第一次观察起算；从写入起算就会撤回；审查第 6 轮 MINOR 1）。中继重验：`test/hosted-relay-v2.test.mjs`（发布者层面和经过中继阶段两层）。
  - 以前写前离期限不足 2 s 时由 `guardNewPublication` 在日志处拒绝（UNCERTAIN）；现在 `writeFits` 先拒绝，什么都没记（BLOCKED、可重跑），`guardNewPublication` 留作最后一道。
- 测试：`test/stale-facts-publish.test.mjs`（慢准入、写后慢读回的完整重评、重评见到真变化或仍不新鲜、写前准入过期、再观察仍不新鲜或读不到、`writeFits` 的两个条件及估计含第一次观察）、`test/stale-facts-production-wiring.test.mjs`（生产接线：两个窗口、再观察 503 或准入超过整个窗口时干净 BLOCKED、写后慢读回的完整重评、外层 UNCERTAIN 不带 `safeToRerun`、生产端口拒绝过期准入）、常驻 `test/publication-recovery.test.mjs`（写后答复超时或超出写后窗口时撤回并记补偿；写与写后核对之间过了写前期限仍结算；写前窗口的恢复和审计不变）。

### 57.3 停靠点 A 的第二次打包断网后可重试（Task `3e2e12d7`）

- **以前**：`build-bundle.ps1 -Rebundle` 在取数前就建了 `gen-2\`；断网后留下没有 receipt 的 `gen-2\`，再跑被 `FIXED_TARGET_ALREADY_EXISTS` 拒绝，批次以 `PARKED_BUNDLE_TOO_OLD` 结束，烧 head。
- **Source**：`-Rebundle` 先把没有 receipt 的 `gen-2\` 改名为第一个空着的 `gen-2-failed-<n>\`（n 1–3，只改名、不删除；必须是真目录，不是链接或文件；用完返回 `REBUNDLE_FAILED_GENERATIONS_EXHAUSTED`）。有 receipt 的 `gen-2\` 照旧不能再建。`-CheckRefs` 和 `prepare-workspaces.py` 只认 `gen-2\`，不读 `gen-2-failed-*`。
  - 改名之前先查批次根目录是真目录、不是链接（审查第 2 轮 NIT）。
  - 输出如实（审查第 1、2 轮 NIT）：成功和失败的答复都带 `setAside`（这次改名到哪，没有为 null）；改名本身就是一次写，之后被拒的第二代是 `PARTIAL_STATE_SET_ASIDE_BY_NEXT_REBUNDLE`（第一代仍是 `PARTIAL_STATE_PRESERVED_NO_RETRY`）；`automaticRetryAllowed` 只在 `-Rebundle` 且整体 fetch 或 ls-remote 失败时为 true，与常驻实际重建的条件（companion `BUNDLE_NETWORK_STEPS`）相同。companion 只读 `reason` 和 `git`，不受影响。
- **常驻**：companion 的 `rebuild-bundle` 对网络步骤失败答 `BUNDLE_NETWORK_UNAVAILABLE`（与第一次打包相同）；执行器在同一批里等 `REBUNDLE_NETWORK_RETRY_MS`（1 分钟、5 分钟）再建，每次一条 `rebundle-retry` 回执。其他拒绝不重建。
  - 每次等之前，已装授权（策略 `validUntil`）要放得下等待、一次重建和随后准备工作区的上限（`REBUILD_BUNDLE_REQUEST_MS` 35 分钟、`PREPARE_WORKSPACES_REQUEST_MS` 25 分钟；审查第 2 轮 MINOR 2）和从第一个本地阶段起的全部阶段；等之后，像执行重试一样再查：没有 HALT、Source 没漂移、授权仍放得下重建和后面的阶段（`gateWaitStillAllowed`）。不满足就记 `rebundle-retry-refused`（`step`）并照旧结束（审查第 1 轮 MINOR 3）。
  - 等待期间每 `ABORT_POLL_MS` 看一次 Owner 中止，有就立即结束等待，在等待之后的安全点照常中止（`retryWait`；发布重试、执行重试的等待也一样，审查第 1 轮 NIT）。
  - 网络仍不通、最终失败时，结尾带网络标记（`batch-rebundled` 的 `network: true`，`classify.mjs#networkFailure` 对 `PARKED_BUNDLE_TOO_OLD` 加 `bundleNetwork`），与第一次打包和第 10 代的网络容错一致（审查第 1 轮 MINOR 6）。
- 测试：`windows/test-build-bundle.ps1`（改名、上限、完整的不动、链接和文件拒绝、端到端重建、`setAside`、断网时第二代的状态和 `automaticRetryAllowed`）、`test/rebundle.test.mjs`（重建、仍不通、网络标记、HALT/漂移/授权到期停止重建、等待中中止）、`test/halt-timeouts.test.mjs`。

### 57.4 发布者采用稍后才出现的完全一致副本（Task `a7951534`）

- **以前**：创建检查的回复丢了（5xx），端口自己的读回（§55.1）在窗口里没看到副本，发布者就去找；找到同身份的副本也会撤回、烧 head。
- **现在**（`staged-check-publisher-v2.mjs#createOrAdopt`）：创建失败、且失败可能已落地（端口归为 `retryable` 且不是证明未发出的：5xx 或发出后的传输失败）时，发布者在 `ADOPT_READ_DELAYS_MS`（立即、再过 10 s、再过 25 s）再读 head 的检查。读到的列表要和 `discoverKnown` 要求的一样可信（完整、有上限、编号唯一、都在这个 head 上）；找到恰好一个、和发出的内容完全一致（App、名称、head、external_id、completed、结论、title、summary）的副本就采用，照常做写后核对和结算；**永远不重发创建**。没有、不一致或多个：照旧（找到不一致的就撤回）。明确的拒绝（4xx）或证明未发出的失败不等、不找。
- 这些读在检查发出之后、写后第一次观察之前，不用写后核对的窗口（§57.2，Owner Decision `36946d8b`），由 `ADOPT_READ_DELAYS_MS` 的等待（共 35 s）和每次读自己的 §49 有界读重试限住（审查第 6 轮 MINOR 2；写后总时长见 §57.2）。原来写前写后共用窗口时，每次等待前要查窗口还放不放得下写后核对（审查第 1 轮 MAJOR 3），现在不再需要。采用之后的写后核对照 §57.2 在自己的窗口里做，做不完照旧撤回。
- 哪些失败要找副本由 `adoptReadAllowed` 决定（有单元测试，含 Native 句柄这一支）。
- 端口证明从未发出的、以及 Native 发布（`active` 策略，句柄 `native: true`）不走这里：Native 发布的创建包含 Native 的 begin、带标记的 POST 和 Native 的 finish，它的运行时有自己的恢复（按票据找检查再 finish，不再 POST），在这里采用会跳过 finish。这一部分属于 57.5。
- 测试：`test/publisher-adopt-copy.test.mjs`、`test/stale-facts-production-wiring.test.mjs`（生产接线下 10 s、25 s 后出现的副本被采用；写前边界慢时找副本的读照样都做）。

### 57.5 Native 写类 RPC 回复丢失时的读回与安全重发（Task `21fbe23b`，只设计，等 Owner 批准）

只做了调研和要批准的点，没有实现。结论：`publication_finish`、`publication_reconcile`、`independent_legacy_drain_finish` 对完全相同的重发会重放原来的结果；`publication_begin_independent` 只在 `controller_id` 也相同时重放；`scan_start_independent` 的重发得到 `consumed` 和 `launch_allowed: false`，不是重放，所以只有它要新迁移加只读读回（审查第 1 轮 NIT 更正）。问题在客户端把所有非 200 归成一个码、从不重发，finish 或 begin 的回复一丢就烧 head。逐项事实、四个批准点（A1 finish、A2 reconcile/drain、A3 begin、A4 scan_start）和需先做的实验见共享笔记 `gen13-21fbe23b-approval-points.md`（交主会话统一问 Owner）。

### 57.6 升级不再接受 GitHub 上没有的 Source 提交（Task `3edfc598`）

- **以前**：第 9 代用只在本地分支上的提交 `0521cb9f` 构建并安装，每个批次读 `<sourceCommit>:.gitleaks.toml` 时都失败，`BUNDLE_UNAVAILABLE`。
- **构建**：`rollout/build-upgrade.ps1 -Final` 在核对完提交树之后跑 `rollout/tools/source-on-github.py`。仓库地址取自这个提交自己的 `build-bundle.ps1`（`$Url`，每个批次的包都从它取），并且必须等于构建配置 companion 输入的 `repo`，两者不一致就拒绝（`BUILD_BUNDLE_URL_NOT_THE_COMPANION_REPO`；审查第 2 轮 NIT）。工具把这个仓库所有分支的提交（`--filter=tree:0`，只要提交）取进一个临时裸库，再看这个提交在不在分支到达的提交列表里（`rev-list --all --missing=allow-promisor`）。从不按 SHA 去查它：临时库是部分克隆，git 会按需去远端补取缺的对象，连不可达的也能取到（`GIT_NO_LAZY_FETCH` 只有 git 2.44 起才认，留作第二道）。取数有上限（600 s，外加 git 的低速中止），挂住就是读不到，超时时连同它启动的 `git-remote-https` 整个进程树一起结束，临时目录才删得掉。git 用 `build-bundle.ps1` 同一个固定路径（Git for Windows），没有时才用 PATH 里的。不在：`SOURCE_COMMIT_NOT_ON_GITHUB_PUSH_THE_BRANCH_FIRST`；读不到：`SOURCE_COMMIT_ON_GITHUB_UNCONFIRMED`。草稿包不查。提交号必须是 40 位小写十六进制（`COMMIT_MUST_BE_40_LOWERCASE_HEX`；PowerShell 的 `ValidatePattern` 不分大小写）。
- **打包**：`build-bundle.ps1` 先单独查已装的 Source 提交，取到的库里没有就以 `SOURCE_COMMIT_NOT_ON_REMOTE` 拒绝（以前是 git 步骤失败）。这个码进 companion 的本机日志（`bundle-refusal` 的 `reason`）。
- **运维**：companion 日志在 Owner 自己的配置目录 `%LOCALAPPDATA%\CluedIndependentCI\companion-log\relay-YYYYMMDD.jsonl`（§23 的位置，UTC 日期），由 Owner 在自己的会话里读，代理账户读不到；看到 `SOURCE_COMMIT_NOT_ON_REMOTE` 就把那个提交所在的分支推到 GitHub。
- 测试：`rollout/test/test_upgrade_tools.py`（`SourceOnGithub`：不带 `GIT_NO_LAZY_FETCH` 也判对，已手工验证；挂住的取数连子进程一起结束）、`windows/test-build-bundle.ps1`。

### 57.7 其他

- **`b26468dc`**（ci-scan-start-bridge 9 个测试在非 Windows 上失败）：main #989 把 issuer 上下文改成按需构造、驱动 issuer 的测试加了 WINDOWS 跳过，第 12 代补了剩下的一条。第 13 代加一条测试，证明生产路径在非 Windows 上仍以 `FORMAL_WINDOWS_CONTROLLER_REQUIRED` 拒绝。模拟 Linux 下：6 通过、5 跳过；Windows：11 通过。
- **`38140843`**（模拟 Linux 下 6 个 POSIX 权限测试失败）：在真 Linux（CluedDev-Linux，`c217fe6e`）上实跑，19 通过、1 跳过、0 失败。测试改为先探一下文件系统是否真的遵守 POSIX 权限位，不遵守（模拟 Linux）就带原因跳过；真 Linux、Windows 照常跑。
- **`c7064327`**（scan-start-prereg 在 gen8 Source 上失败）：已过时。原因是第 8 代起的常驻分支带着从未进 main 的 Codex 退役 home-linux-01 目录改动；第 12 代合并时已恢复成 main（§52 第 6 条、合并提交说明），`c217fe6e` 在真 Linux 上这个测试 16/16 通过。

- **`0fdb6f7b`**（两条 issuer 测试在机器繁忙时偶发失败：`issuer-refs-transient.test.mjs` 报 `BRIDGE_BYTE_BOUND`，`resident-v2-bridge` 的 “Linux clean blocked record”）：根因在测试，不在产品。issuer 写桥文件是先建文件、再写字节、最后写 `.ready.json` 标记（`mailbox.mjs#exclusive`），真 Linux 侧只在标记写完后才读；测试里模拟 Linux 侧的 `waitFor` 却在文件一出现就读。线程池繁忙时字节还没写进去，读到空文件，`decode` 报 `BRIDGE_BYTE_BOUND`。用一个让数据写入比建文件晚 300 ms 的预载可以稳定复现（两文件 21 个失败）。修法：两个测试文件的 `waitFor` 照真协议等标记完整，再读它指定的字节并核对长度和摘要；没有加大超时，没有进 known-failures。复现预载下 49/49，叠加满载 CPU 连跑 20 次全过。

- **`rollout/tools/roles-derived.py` 缺副本时给拒绝码**（打第 12 代包时发现）：每一代安装都会在 Linux 侧重新派生并重签角色文件，所以每一代打包前都要由 root 把**这一代**现装的 roles-v3 导出一份（`tools/derive-public-export.py` 生成导出脚本，Owner 以 UAC 运行一次）。导出还没运行时 public-six 目录是空的，原来会抛出 Python 的 `FileNotFoundError`；现在报 `INSTALLED_ROLES_COPY_MISSING`（带角色和文件名），读不了报 `INSTALLED_ROLES_COPY_UNREADABLE`；version facts 缺失或不是 JSON 也统一报 `LINUX_VERSION_FACTS_REFUSED`。测试见 `rollout/test/test_upgrade_tools.py` 的 `test_roles_copy_missing`。

- **`roles-derived.py` 不再往提交树里写字节码缓存**（打第 12 代 Final 包时发现，2026-11-06）：它载入树里冻结的 `linux/bin/clued-ci-upgrade-linux` 时，Python 顺手写下 `linux/bin/__pycache__`。`build-upgrade.ps1` 对同一提交的下一次尝试有意复用这棵树、并逐个 blob 核对（`tree.py`），于是被 `TREE_NOT_THE_COMMIT_FILES` 拒绝（第 12 代先打 DRAFT、再打 Final 时就是这样）。`python -I` 不认 `PYTHONDONTWRITEBYTECODE`，所以工具自己在载入前设 `sys.dont_write_bytecode`。旧工具已经弄脏的树要先改名放到一边（不删），脚本会重新解出一棵。测试：`test_the_tree_is_left_as_it_was`。

- **`test/fixtures/repin-trusted-workflows.mjs` 不带参数时不再算失败**（第 13 代全量测试时发现）：在 Source v2 目录里直接跑 `node --test`，默认匹配规则把 `test/` 下所有文件都当测试，这个要带参数的开发工具因此以 2 退出，成了一个假失败。现在由测试运行器（子进程带 `NODE_TEST_CONTEXT`）完全不带参数地运行时，它打印用法、说明自己不是测试，以 0 退出；人或脚本不带参数或参数给错仍以 2 退出，不会把用错当成功（审查第 6 轮 NIT 5）。没有移出 `test/`：被钉住的运行时文件 `worker/trusted-workflows.mjs` 的生成标记里写着这个路径。测试：`test/trusted-workflow-pins.test.mjs`。直接跑 `node --test` 现在全部通过（审查第 6 轮 NIT 6）。

### 57.8 安装第 13 代时要 Owner 批准的内容

1. **新策略 /10**：已签策略改动的字段只有 `contract`（/9 → /10）和新增的 `roleProbe.interruptedMax = 3`；其余与已装的 /9 相同（安装时的三个 manifest 哈希和 `ownerAcceptance.decisionRef` 照每次安装更新）。
2. **行为变化**：/10 下观察或探测被中断最多自动恢复 2 次（第 3 次连续中断停机）；所有策略下：发布时受保护事实过期改为再观察一次、不撤回；写后核对另有 60 s 观察窗口（写前 60 s 不变，Owner Decision `36946d8b`），写前窗口放不下写入或写后窗口放不下写后核对就不写（BLOCKED、可重跑）；写后读回期间准入过期改为完整重评一次；写前这几种暂时情况在阶段事实里是暂时码 `NATIVE_ADMISSION_UNAVAILABLE`（以前是终局的 `PUBLICATION_BLOCKED`；其中两种算线路故障，见 §57.2）：本地发布（阶段 3/5/7）带 `safeToRerun`，在同一批里按 §51 重跑（30 s、90 s、300 s），三次都失败照样烧 head，不走 attempt 2（`attempts.mjs` 只许阶段 0–2）；托管中继（阶段 9）照中继规则退回本地运行该角色，但角色键已在别的持有者手里时，中继阶段以 `ROLE_ALREADY_PUBLISHED_ON_HEAD` 停机（行的 `detail` 是真正的原因，例如 `publication_window_short_before_write`），不再交给本地白跑一次扫描；第二次打包断网后在同批重建两次（每次先查 HALT、漂移和授权）；重试的等待中 Owner 中止立即生效；稍后出现的完全一致副本被采用；`-Final` 构建要求 Source 提交在 GitHub 分支上。
3. **组件**：`script.independent-native-publication` 1.1.7 → 1.1.8（发布者改动；1.1.7 已随 #1006 发布）。
4. **对审过界限的修改（Owner 已决定）**：写后核对单独给 60 s（Owner Decision `36946d8b`），修改了 Task `a3ad42a9` 写前写后共用 60 s 的界限；写前 60 s、它的恢复和审计不变（§57.2）。Owner 已确认（Decision `36946d8b` v2）：60 s 管写后的观察，从写后第一次观察起算；创建回复丢失时找副本的读在它之前、不占它（写后总时长见 §57.2）。

## 58. 常驻升级纳入 Owner 自动审批（Task `ceeaa7c3`；Owner Decision `f8aff2f9`，取代 Decision `3ce5200c` 第 2 项）

- **以前**：`ci.resident_upgrade` 永不自动批准（`3ce5200c` 第 2 项），每次升级 Owner 都要在确认页点一次。
- **现在**（迁移 `20261106100000_resident_upgrade_auto_approve_v1.sql`）：`ci.resident_upgrade` 接入现有的 Owner 自动审批开关，和 `release.production`、`migration.production` 一样按高风险规则处理：
  - 开关开着时，门（`owner_grant_resident_upgrade_door_v1`）为它打开或找到的请求调用 `owner_auto_approve_request_v1`。批准范围：一次、一次使用、24 小时，只给发起请求的连接，只限精确的节点与包。批准后在同一次调用里直接消费。
  - 回执用现成的：`OWNER_GRANT_GIVEN`，principal `owner_auto_approve`；门照常写 `OWNER_GRANT_USED`，内容不变（这次 Grant 从哪来，看它的 `auto_approve_id`）。门的答复和发布门一样带 `auto_approved: true`。/grants 页照常显示"来源 自动审批"，撤销也照旧。
  - 本动作自己的一条规则：**同一节点 24 小时内最多自动批准一次**。
    - 按 Grant 资源里的节点名算，不按连接算：同一节点重新标记的新连接也共用这 24 小时。
    - 从请求打开的时刻算：在某次自动批准之后、或它之前 24 小时内打开的请求，直到被决定或过期，都只能由 Owner 批准，升级代理再怎么反复询问也不会变成自动。这样反复重试的失败升级或打错的包会交到 Owner 手里。
  - 开关关着时全部走人工。
- **不变的部分**：
  - `3ce5200c` 的第 1、3、4、5 项不变：每节点独立升级连接、HALT 时延后、stateCompat 不能回读就在 ACCEPT 拒、时间参数 24h/120/60。
  - `connection.permission`（会自我提权）和 DatasetSplit 的 4 项（会伪造 Owner 认定）仍然只能人工批准。
- **升级代理不改**：`upgrader/src/grant-client.mjs` 里"永不自动批准"那段注释没动。`upgrader/src/*` 是冻结通道（§34.8、§42.1 c），改任何一个字节都会让之后的包变成 `UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL`。客户端本来就只是轮询门：门返回已消费就继续，它不区分这次 Grant 是 Owner 点的还是开关给的。所以注释的语义以本节为准，等轨 2 的代理自更新（§42.5.3）时再改。
- **测试**：
  - `apps/clued-cloud/tests/resident-upgrade-auto-approve-db.test.mjs`：开关开着时自动通过并当场消费；同一 op 重放；同节点 24 小时内第二次走人工；窗口内打开的请求在窗口过后再问仍走人工；同一节点的新连接共用窗口；另一节点、过了 24 小时都会再自动；开关关着走人工，重新打开后同一 op 能通过；撤销；被拒或过期的请求不会自动批；回执内容；connection.permission 与 DatasetSplit 仍是人工。
  - `owner-grants-resident-upgrade-door-db`：把开关关掉后，验证人工路径。
  - `owner-auto-approve-db`：covers 和 excluded 两个列表。

## 59. 第 14 代：第 2 段中继在主机繁忙时被放弃，改为同批次有界重跑（缺陷 `e0a5630d`；Decision `4f5f35d3`：发现的缺陷全部修掉）

**现象。** 11-04、11-05（#1005）、11-06（#1007）三次，第 2 段 gitleaks 的中继被放弃：主机同时跑 local-verify 或 CPU 压力时，`relay-public.ps1` 每次调用的 `wsl.exe --exec` 从约 3 s 变成 1 分钟以上或挂住；companion 把这种慢当终局（超时且进程树未确认、或子进程 stderr 不是中继 JSON → PERMANENT），泵报 `RELAY_REFUSED_NO_RETRY` → 常驻停止该段 → `BRIDGE_STAGE_STOPPED_PUMP_LOST` → 批次 `FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED`，只剩唯一一次 attempt 2；attempt 2 再碰上繁忙就烧 head（#1005 即如此）。

### 59.1 修法一：第 2 段也走 §54 的同批次重跑（只限放弃证明）

- `classify.mjs#EXECUTION_RETRY_STAGES` 由 `[4, 6]` 改为 `[2, 4, 6]`；第 2 段**只**接受 `abandoned-unpublished` 依据（`scannerAbandonEligible` 成立：结束码在 §27 允许表里、泵的码可证明、需要时有 `STOP_SENT`、Windows 一半证明齐全、泵已安静），否则 `EXECUTION_RETRY_STAGE2_NOT_ABANDONED`（Windows 一半证明不全时先报 `EXECUTION_RETRY_WINDOWS_PROOF_INCOMPLETE`）。第 2 段的内存闸门拒绝和干净拒绝不在这里重跑，仍走原路径（内存闸门：§32 的 attempt 2）。
- 签发者自己的 `PUBLICATION_UNCERTAIN`（Source 把有副作用或可能已发布的结果都映射成它）也在 §27 允许表里，所以同样重跑，与第 4、6 段和 attempt 2 一致。
- “什么都没发布”的依据与 §27 相同：第 2 段唯一的 Windows 进程是扫描签发者，写不了检查；Linux worker 没有 GitHub 凭据；签名结果只有经同批第 3 段才变成检查，而第 3 段只在第 2 段成功之后才跑一次。重跑之前照 §54.2：无 HALT、无漂移、授权够、两台主机静止、两边 `retry-stage-2-K` 归档核实、写 `execution-retry` 回执；任何一步不成立就写 `execution-retry-refused` 并按原路径结束。
- 等待 60 s、300 s，最多 2 次（`EXECUTION_RETRY_MS`，不变）。第 2 段是批次第一个 Linux 段，重跑时 refs 闸门和版本检查照样再过（`firstLinux`）。
- 第 2 段是批次的第一个 Linux 段，重跑前还要再过它自己的闸门。如果闸门在什么都没跑之前就拒绝了重跑（refs 闸门没有应答 `REFS_GATE_UNCONFIRMED`，或版本不一致 `UPGRADE_VERSION_SKEW`），批次按被放弃的那次运行结束（`STAGE2_RETRY_KEEPS_ABANDONED`），即与不重跑时一样：`BRIDGE_ABANDONED_UNPUBLISHED`，并保留那一次 attempt 2。原因：这两个码都会烧 head（new-commit），重跑不能让批次比不重跑结束得更差（独立审查 MINOR 1）。这时写一张 `execution-retry-refused` 回执（`step: 'gate'`、重跑的码、`kept: 'abandoned'`；refs 闸门无应答时带 `refsNoAnswer`），然后结束。这一结束算环境失败，不算网络失败（熔断器不按网络处理），与第 14 代之前相同。
- 静止证明不成立（例如 worker 一直活着）时，先是重跑前的静止证明被拒（`execution-retry-refused`），再是放弃路径自己的静止证明，然后才 HALT。两次各有 5 分钟上限，所以最坏约 10 分钟才 HALT，以前约 5 分钟。
- 两次都用完：与以前完全相同，`FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED`，并且仍有那一次 attempt 2（attempt 2 里同样有两次批次内重跑）。
- 同一个作业再跑一次（照 §54.3 逐项核对 gitleaks）：运行目录 `runs/gitleaks-<jobId>` 重跑会冲突，由 `stage-retry` 归档移走；对保留工作区的 git 命令带 `--no-optional-locks`，不改工作区；`NATIVE_SCAN_START_REQUIRED = false`，没有一次性的 Native 许可。gitleaks 在 intent 和 outcome 里写 `automaticRetryAllowed:false`，指的是 Source 自己不重试；常驻层的重跑（与 attempt 2 一样）在此之上另有 §27 的证明。
- 随之放开的守卫：`engine-windows.mjs#runStage` 和 `mailbox.mjs#validateRequest` 允许第 2 段带 `again`（1 或 2）；Linux 工具 `retry-stage-[246]-[12]` 保留工作区（`stage-retry` 范围）。§54.3 的同一单元重跑处理（`workerRanSince` 基线）对第 2 段同样适用。
- 与 §50 不变量 ① 的关系：第 2 段重跑扫描已由 O-2（Owner Decision `eaa7d5e4`，attempt 2）覆盖；本节只是把它提前到同一批次内，发布仍只一次（第 3 段只跑一次）。
- 没有改 companion 的中继分类（缺陷描述的 B 方案）：批次内重跑已覆盖“什么都没写”的放弃情形，且不放宽任何“已写入不得重发”的规则；不改签名策略（仍是 /10），不新增策略字段。

### 59.2 修法二：local-verify 让路（`scripts/ci/local-verify.mjs`，不在常驻包内）

常驻在跑批次（`C:\ProgramData\CluedIndependentCI\resident\state\status.json` 的 `current` 非空；WSL 内读 `/mnt/c/...` 同一文件）时，local-verify 在每个套件开始前等待，Windows 和 Linux 两侧都等；每 30 s 看一次，每 5 分钟打印一次原因；每一侧整次运行合计最多等 90 分钟（不是每个套件），用完照常继续并说明；Linux 子进程的超时相应加 90 分钟；`--no-yield` 关闭（传给 Linux 侧）。文件不存在、读不了、不是 JSON、5 分钟没重写（服务停了，页面停在最后一次）或 `current.phase` 是 `relay-wait`（批次停在停靠点 A 等托管中继，本机什么都没跑；不看执行器的 `WAITING`：从 A 继续的批次跑第 2–7 段时，页面上还是上一个 tick 的 `WAITING`）都算空闲。Linux 侧用 WSL 的时钟比 Windows 写的 `writtenAt`：主机睡眠后 WSL 时钟若快了 5 分钟以上，Linux 侧会当页面过期而不等；接受这个小风险（Windows 侧照样等）。等待时保留自己的运行名额，排在后面的运行也跟着等。工具自己的并发测试带 `--no-yield`，不会在常驻 CI 里等常驻。

### 59.3 测试

- `test/execution-retry.test.mjs`：第 2 段纯规则（放弃 → 重跑，含签发者自己的 `PUBLICATION_UNCERTAIN`；内存闸门、干净拒绝、未 `STOP_SENT`、泵不安静、泵不可证明、无桥事实、放弃证明覆盖不到的有副作用或可能已发布的结束、Windows 证明不全 → 不重跑；第 3 段不重跑）；第 2 段放弃一次后重跑成功（阶段序列 `[1,2,2,3,…,8]`，第 3 段只跑一次，`retry-stage-2-1` 归档，重跑保留 refs 闸门，无 attempt 2）；重跑用完按原样结束并排 attempt 2；干净拒绝不重跑；重跑后以内存闸门或 refs 移动结束时停止重跑、按各自的码结束并排 attempt 2；重跑被 refs 闸门（无应答）或版本不一致在调用前拒绝时，按被放弃的那次运行结束并保留 attempt 2；mailbox 与引擎的 `again` 规则含第 2 段。
- `test/scanner-abandon.test.mjs`：第 2 段的 10-28 结束先重跑两次再 `FAILED_CLEAN`；attempt 2 也各有两次重跑；静止证明不成立时先写 refused 再 HALT。
- `drill/offline-drill.mjs`（incident-20261028-replay）：
  - 结果：真实的 companion 泵、引擎和执行器下，第 2 段重跑两次，每次结束都一样，最后 `FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED`、不 HALT、排一次 attempt 2；回执里有两张 `execution-retry`，两边都有 `retry-stage-2-1/2` 归档，内存闸门在每次调用前各读一次（共 3 次）。
  - 每次运行从中继失败到该段结束都在 5 分钟内，逐次检查。worker 一直活着的变体：重跑在静止这一步被拒，之后 HALT，从该段结束到 HALT 不超过两个 5 分钟上限。
  - 模拟里的 worker 在每次 start 时重置自己的记录，这代替了 Linux 侧的 retry-stage 归档；Windows 侧的 retry-stage 归档会移走 `issue.ready.json`，模拟里也随之清掉。
  - 演练的模拟世界原来只能跑一次第 2 段：签发者每次调用都用同一个 broker 请求号，旧的 `.stop` 让重跑一开始就结束，而这次运行找不到在途的 swap、没有 `STOP_SENT`，于是 HALT（PR #1015 的 ci-suites 就是这样失败的）。现在改成与生产一致：`invoke-stage.mjs` 每次调用用 `randomUUID()`；worker 单元每次 `start` 都是一次新运行，有新的 InvocationID 和启动时间。
- `test/test_linux_tool.py`：`retry-stage-2-1/2` 保留工作区，`retry-stage-2-3`、`retry-stage-3-1` 不保留。
- `scripts/ci/local-verify.test.mjs`：`--no-yield`；`residentBusy`（空闲、缺文件、半写、有批次、停在 A 的 `relay-wait`、从 A 继续时页面仍是 `WAITING`、`retry-wait`、页面过期、页面无时间）；`yieldToResident`（空闲不等、等到空闲、到上限继续、保持运行存活、按剩余额度截断、额度用完不等）；`verifySuites` 每个套件先让路、整次运行共用一份额度、`--no-yield` 时不问；Linux 脚本传 `--no-yield`。

### 59.4 安装

常驻代码改动（`classify.mjs`、`executor.mjs` 注释、`engine-windows.mjs`、`mailbox.mjs`、Linux 工具）；`upgrader/src/` 及其传递依赖（`canonical`、`store`、`upgrade-mailbox`、`intake-pause`、`inbox`、`instance-lock`）一个字节未动。组件：`script.independent-native-publication` 1.1.9 → 1.1.10（它的文件清单含 `engine-windows.mjs`、`executor.mjs`；`clued_components.py bump` + `update`，并重新生成 `components.ts`）。行为变化需 Owner 在安装第 14 代时确认：第 2 段放弃后同批次内最多再跑两次扫描；每次重跑本身也可能以自己的停机类结束收场（例如签发者未确认），所以一个 head 第 2 段的运行次数从最多 2 次（首跑加 attempt 2）变为最多 6 次。

## 60. 第 15 代：全量清扫平时只读必要的部分；main 被改写或没有记录时照旧读全部（Owner Decision `fb39ec73` v2：方案 c、c1、a）

**为什么改。** 原来的全量清扫读所有 PR（开着的和关着的）的全部提交和强推前后的提交，约 1000 个 PR，一轮要 4.5–5.5 小时，有两次碰到 6 小时上限被放弃，主机负载也重（Task 67b41719 的影子数据）。开车（train=on）要先完成一轮全量清扫。Owner 定的原则是：平时要快，但任何时候都不能比原来的全量清扫弱。

### 60.1 每轮读什么（`train-sweep.mjs#fullSweepHeads`，Source）

列表和游标不变：仍按 `pulls?state=all&sort=created&direction=asc` 分页，游标（`nextPage`、`nextIndex`）照旧。这个列表只在末尾增长，所以游标稳定；第 14 代留下的进行中游标，到第 15 代会接着用。每轮有一个 `scope`。

**`scope: all`**：与第 14 代以前完全相同，读所有 PR 的全部提交和强推前后的提交。

**`scope: current`**（平时）逐类处理：

| PR | 读什么 | 为什么够用（与 `all` 相比漏了什么、由谁兜住） |
|---|---|---|
| 开着的 | 全部提交和强推前后的提交（超过 250 个提交，整轮作废） | 与 `all` 相同。 |
| 已合并、合进 main | 只读强推事件（每个 PR 一次 GraphQL，不读提交列表），判每次强推前后的提交 | 它的提交都在 main 里，判了也不撤；强推换下的 head 从没进 main，其中可能有旧绿，所以要读。复现见下面的"强推前的 head"。 |
| 已合并、合进别的 base | 与开着的 PR 相同，读全部 | 它的提交不一定在 main 里。 |
| 关闭未合并 | 只判当前 head | 重新打开后，当前 head 当场就能合，所以必须撤（#936 的实例，见下）。它的历史（更早的提交、强推前的 head）要合进 main，必须先推送或新开 PR，这都会更新 PR，由增量清扫兜住（见 60.3）。 |
| 状态不明（既非开着，也非"关闭且是否合并明确"） | 不猜，整轮作废（`TRAIN_PULLS_INCOMPLETE`） | 失败即关闭。 |

强推事件读不全，整轮作废（`TRAIN_FORCE_PUSHES_INCOMPLETE`），与开着的 PR 一样。一轮可以分在多次第 10 段里做完。

**实例一：#936（关闭未合并 PR 的当前 head）。** #936 在 10-29 关闭、未合并，当前 head 是 `df659f1c94`。上面 App 5368905 的 `kooyumi-merge-slot` 现在仍是 success（check run 123183250791），这个 head 比 main 多 31 个提交、不在 main 里。影子记录里，它只在全量清扫的分段中出现过（6 次），增量清扫从没找到它：它不在发布流水里，也不在台账里，#936 也早已不再更新。

**实例二：强推前的 head（独立审查 MAJOR 1）。**
1. 开车前，PR 的 head H1 拿到了绿；
2. rebase 后强推成 H2，再以 merge commit 合并。此时 H2 在 main 里，H1 从没进过 main；
3. 开车之后，有人在 H1 上建分支、开 PR 并打开 auto-merge。strict 关着，必需检查都是绿的，于是在下一次第 10 段之前就合入了。

`current` 读已合并 PR 的强推事件，撤掉 H1，测试里有这个复现。

### 60.2 什么时候读全部（方案 c1，`train-maintenance.mjs`）

- **main 被改写过。**
  - 怎么判断：每次第 10 段都把这次看到的 main 尖端记进本模式的清扫状态（`mainSha`）。下一次运行先比较：上次的尖端不是当前 main 的祖先（compare 的 `behindBy` 不为 0，或 GitHub 已经没有那个提交、返回 404），就是被改写过。
  - 判定之后：
    - 跨运行的"已在 main 里"缓存（`inMain`）立即作废。这是第 14 代以前就有的隐患：main 被改写后，缓存会把已经离开 main 的 head 当成仍在 main 里，于是不撤。
    - 正在进行的一轮和已经完成的一轮都作废（`TRAIN_MAIN_REWRITTEN`）。
    - 记下 `allPending: TRAIN_MAIN_REWRITTEN`，直到一轮 `all` 完成才清掉。
  - 各模式怎么处理：
    - on 模式立刻开一轮 `all`，期间是 `TRAIN_TAKEOVER_SWEEP_PENDING`：单绿证明里 `fullSweepSinceOn` 为 false，第 8 段不发绿。执行器看到事实里 `allPending` 为 `TRAIN_MAIN_REWRITTEN`，就把"接班已完成"置回 false，所以这期间无论某次运行的决定是什么（清扫不完整、撤销未确认……），都不开新批次；这一轮完成后，原有的判断会把它置回 true（独立审查第 2 轮 MINOR 1）。
    - 只撤模式（PAUSE 下）只作废，下一次 on 运行再开这一轮。
    - 影子模式同样重开。
  - 为什么要读全部：运维文档 `docs/maintenance/independent-ci.md` 第 93 行写明，main 万一被强推回旧提交，"以前已合入、带着六项绿的 head 不再在 main 里，从它新开一个 PR 就能在清扫之前合入"。这时已合并 PR 的提交已经不在 main 里，`current` 读不到它们。
  - 为什么不能只判已合并 PR 的当前 head（方案 c3）：main 被改写后，离开 main 的不只是这些 head，还有它们更早的提交（以前的 head、普通推送换下的提交）。这些提交以前因为在 main 里从没被撤过，上面可能还有绿。只判当前 head 就漏掉了它们，所以 c3 不完整。
- **没有记录：** 本模式的状态里还没有 main 尖端，例如第一次运行（只撤运行写下的第一条记录也算）、第一次 on 模式的全量清扫，或者状态是第 15 代以前写的。这时历史未知：
  - 缓存同样作废；
  - 记下 `allPending: TRAIN_NO_MAIN_RECORD`；
  - 直到一轮 `all` 完成之前，开始的每一轮都是 `all`。
- **读不出：** main 的历史读不出（compare 失败，404 除外）时：
  - 这次运行的清扫算不完整（`TRAIN_MAIN_HISTORY_UNREADABLE`），不发绿；
  - 不开新一轮、也不结束任何一轮，什么都不记，下次运行再比；
  - 这次也不信任缓存。
- **采样的局限：** 每次第 10 段只看一次 main。如果 main 在两次运行之间被改写、又恢复到原来的尖端之后，就看不出来。原来的做法同样看不到。
- **Owner 在哪里看到：**
  - 每轮的 `scope`、`scopeReason`，以及 `allPending`，记在全量清扫记录里（`train-sweep-store.mjs` 的 full 记录，即全量清扫的证明），也带进第 10 段的事实；
  - 常驻状态 `train.sweep` 里有 `fullScope`、`fullScopeReason`、`fullAllPending`。main 被改写时 `fullSinceOn` 为 false，companion 的兜底和接班记录读的正是它；
  - 由此带来的一个后果：main 被改写的那一刻如果 strict 是关的，companion 的兜底会立即写暂停请求（宽限期从 onSince 算起，通常早已过去）。暂停期间只跑只撤模式，它不跑全量清扫的分段，所以扫全部那一轮要等 Owner 先把 strict 开回 true、再恢复执行器才会进行，完成之后才能再关 strict。这与运维手册的要求一致：回退时 strict 本来就要开着（第 93 行）。
  - PR 页面和车头那一行写"main 被改写，合并列车在重扫全部 PR 和提交，扫完前不发绿"。
  - 第 8 段读的单绿证明（proof）格式不变。
- **记录格式向后兼容：** 第 14 代写的记录（没有新字段）照样能读，读作"没有 main 记录、没有挂起、本轮 `scope` 为 `all`"；新旧字段混用的记录拒收。
  - 第 14 代留下的进行中一轮会以 `all` 接着扫完，并清掉 `TRAIN_NO_MAIN_RECORD`。它前面的分段用的是第 14 代的缓存，所以"历史未知时用新缓存扫全部"只对这一轮剩下的部分成立。这是可以接受的：那一轮是第 14 代的完整枚举，若在升级时重开，要再花最多 5 小时。
- **回退到第 14 代：** 第 14 代的读取器会把第 15 代的记录当作不完整、忽略掉，退回最新的旧记录（游标更早，会重扫）。但如果当时 `fullAllPending` 正挂着 `TRAIN_MAIN_REWRITTEN`，旧记录里可能有一轮"开车后已完成"的清扫，第 14 代会据此当作接班已完成、照常发绿，而不重扫。所以挂着这个原因时不要回退；非回退不可，就让 strict 一直开着，直到在第 14 代下完成一轮全量清扫。

### 60.3 剩下的窗口（Owner 已接受）

有人在一个**不是任何 PR 当前 head 的旧提交**上新开 PR，或者推送一个已关闭 PR 的分支并重新打开它，然后在下一次第 10 段的增量清扫之前合入。具体是：

- 关闭未合并 PR 的历史提交，以及它们强推前的 head。

（已在 main 里的提交不撤，这不算窗口：在它上面开 PR，合进来的东西 main 里已经有了。）一个已合并 PR 的 head 先被普通推送换下、之后又在一次 rebase 中被强推掉（H0 → 推送 H1 → 强推 H2），它既不在提交列表里，也不在强推事件里；原来的全量清扫同样漏它，不是本代的退步。

原来开车时那一轮全量清扫会先把关闭未合并 PR 历史上的旧绿撤掉，所以这是本代新接受的窗口（Owner Decision `fb39ec73` v2，方案 c）。新开 PR、推送和重新打开都会更新 PR，下一次第 10 段的增量清扫就会撤掉（测试覆盖了重新打开和新 PR 两种情形）。窗口的长度是到下一次第 10 段为止；批次进行中第 10 段不跑，所以可能长达几十分钟。

### 60.4 测试

**Source**：`work/actions-hosted-migration/independent-ci-v1/test/train-sweep.test.mjs`。测试数据按真实情况设置：强推前的 head 不在 main 里。

- **main 快进（`current`）：**
  - 撤的：开着的 PR 的旧提交；关闭未合并 PR 的当前 head（#936 那种形状）；已合并 PR 强推前的 head；合进 release 的 PR 的提交；
  - 不撤的：关闭 PR 的历史；在 main 里的 head；
  - 读取：提交列表只读开着的 PR 和合进别的 base 的 PR，已合并 PR 只读强推；
  - 这次的 main 尖端记进状态；
  - 强推事件读不全、或 PR 合并状态不明，整轮作废。
- **复现：** H1 拿到绿 → 强推成 H2 → 合并 → 开车后的 `current` 轮撤掉 H1、保留 H2。
- **没有 main 记录（`all`）：**
  - 所有 PR 的全部提交，与以前相同；
  - 第 14 代的进行中记录能读，以 `all` 从原游标接着扫；
  - 缓存不被信任；
  - 只撤运行写下的第一条记录之后，第一轮 on 仍是 `all`。
- **main 被改写：**
  - 缓存作废，离开 main 的已合并 PR 的提交被撤；进行中的轮次从头重开为 `all`；
  - 开车后已完成的接班清扫作废：期间是 `TRAIN_TAKEOVER_SWEEP_PENDING`，不开车头批次，证明里 `fullSweepSinceOn` 为 false；跨多次运行完成后恢复，并清掉挂起；
  - 只撤模式只作废，下一次 on 再开这一轮。
- **main 历史读不出：**
  - 这次不完整，不开新一轮，记录不变；
  - 缓存里的 head 重新判定，已被撤；
  - 404 按改写处理。
- **增量清扫仍兜住：**
  - 先关闭、后重新打开的 PR，它历史里的旧绿；
  - 新 PR 指向带旧绿的提交。
  - 在 PR 更新之前，增量清扫什么都不读。
- **存储：** 第 14 代和第 15 代的记录都能读，混用和越界的值拒收。

**常驻层**：

- `test/train-on.test.mjs`：
  - 新字段带进状态；main 被改写时 `fullSinceOn` 为 false；旧 Source 的事实显示为空，越界的值不显示，Source 也拒收；
  - 接班完成之后 main 被改写：之后的运行即使决定是"清扫不完整"或"撤销未确认"，也延后新批次；扫全部那一轮完成后放行。
- `test/train.test.mjs`：车头那一行的文字。
- `test/pr-status.test.mjs`：PR 页面的延后文字。

### 60.5 安装

- **Source 改动：** `train-sweep.mjs`、`train-maintenance.mjs`、`train-sweep-store.mjs`、`train-facts.mjs`。
- **常驻改动：** `train.mjs`（状态视图和车头那一行的文字）、`pr-status.mjs`（PR 页面文字）、`executor.mjs`（main 被改写时"接班已完成"置回 false）。
- **组件：** `script.independent-native-publication` 从 1.1.11（main 的 #1018 已升到 1.1.11）升到 1.1.12，因为它的文件清单里有本代改到的常驻文件；并重新生成了 `components.ts`。
- `upgrader/src/` 及其传递依赖一个字节未动；不改签名策略的字段。第 15 代与 train=on 的策略一起安装，由主会话安排。
- **注意：** 开车后的第一轮 on 模式全量清扫还没有 main 记录，按 60.2 是 `all`，耗时与以前相同；之后各轮才是 `current`。

## 61. 第 16 代候选：strict coverage 与有界空闲续扫

本节保留第16代的覆盖策略与实现历史。第17代当前front的strict路径见§62；多绿并存本身不构成未经测试树合入的反例。

Task `98bddf93-f1ed-4983-b39e-bcbe10be1672`；基于 #1022 的 main `fcf22ff9`。
本节描述待独立实现审查、正式 Source 接受及安装的候选；不改变已装策略，不代表已满足 30 分钟或 1–2 小时目标。

### 61.1 首绿前的覆盖

`strict=true` 只要求主线 T 是 head H 的祖先，不能证明旧 H 属于本轮车头。因此不能仅凭 strict 放行，也不能只清理当前打开的 PR。

首绿前完整枚举 §60 的相应 `all` / `current` 候选范围，保留 open 历史、强推两端、closed-current 等原有边界。比较方向是 `T <= H`：只有能证明不满足该关系的旧 head，才可以在 strict 开启时延后撤绿。未知比较、枚举不完整、eligible 非车头撤销未双读回，均不生成就绪证明。原全量轮及其 `sinceOn`、游标、`allPending` 继续独立推进。

证明使用独立 strict kind/schema，不向 exact `train-sweep-proof/1` 偷加字段。旧 v1 投影仍如实写 `fullSweepSinceOn=false`；旧 Source/Resident 不认识新能力时仍等待真实 full。较新的损坏证明不回退到旧身份的绿灯证明。

### 61.2 证明与发布授权分层

Stage10 的 coverage 是非授权事实，绑定 repo/T/Source、onSince、可信 job settings、front PR/H/claimId/since、候选范围及撤销确认、新鲜期限。holders 没有提供 fence/epoch，不能虚构这些字段。

Stage8 用既有 full-admission 的真实 `observedClaim` / `batchClaim` 重新建立本次 generation 的例外绑定，并核验 live holder、最新 front-batch、job S、实际 test merge/tree 与 live required-check/App pins/strict。旧 batch 的 fence/epoch 变化必须由原 `sameClaimGeneration` 拒绝；同一有效非例外 coverage 可被新 batch 重新验证，旧 runtime 授权绝不继承。发布前后 Native current、ticket、settlement 和补偿流程保持。

coverage 先于 `openFront` 写出，不依赖尚不存在的 S；S 由其后的原 front-batch 和 Stage8 闭合。strict 为 false、不可读、pins 不合格时，新 coverage 无效，仍要求原真实 full 路径。main 改写继续原暂停、撤 front 并读回、关 auto-merge、冻结到 full 的流程。

### 61.3 常驻门禁与恢复

`trainTakeoverDone` 只表示真实 full 完成。有限就绪只允许匹配 T/H/claim/since/S 的那一行通过等待，不全局放开队列；Source Stage8 仍作最终实时检查。状态分别显示 `frontReadyMode`、`fullPending`、`backgroundAllPending`。

重启不从磁盘直接恢复轻量发布授权，先由 Source 刷新；front/Source/onSince/settings/期限变化使相应缓存失效。新证明可唤醒匹配的 parked front，重复的同一无进展结果不会反复 urgent 消耗预算。main 单调前进只允许重新绑定后的 Source 结果复用非例外覆盖，不迁移旧 front 例外。

### 61.4 required-all 的空闲续扫

原 routine `maintenanceEveryMs` 路径保留。新增独立的 required-all continuation 原因：只推进已经必需且未完成的 `scope=all` 轮，Source 事实新鲜、真实游标/双确认撤销有进展、provider 预算允许且执行器空闲时，每 tick 至多调用一次原 protected Stage10。已知 urgent、可运行 front 与原角色、暂停、HALT、Source 漂移、授权期限及阶段上限门禁优先；不把后台工作冒充 urgent，完成后不自动开始无限新轮。

所有调用先写 `train-run-intent`，失败与中断也计滚动 24h 总账 C（仍不超过 policy 的 200）。额外调用单独计账：`E=max(0,C-ceil(24h/maintenanceEveryMs))`，默认 `200-144=56`。E 用尽退回原周期，C 用尽连 urgent 也等待。它保留 routine 的理论全天次数，不保证无限 urgent 永不耗尽。旧回执没有额外标签按旧调用处理；回执损坏仍按原拒绝/中断恢复规则。

### 61.5 provider 计量与停止条件

controller 最底层 fetch 统计真实 GitHub HTTP 尝试，包括读重试、token mint 和传输重试；Native 请求不混入。分别记录 REST core 与 GraphQL 的 limit/remaining/reset，另读已有 installation 凭据允许的 `/rate_limit` 初始化，不增加 token 权限。

额外续扫需要两资源观测均不超过 60 秒、reset 未到且各剩余超过该窗口一半。保留的另一半仅是后台的保守分区，不停止原正常/前台工作，不保证其他进程共享凭据时绝不触顶。缺失、陈旧、低额、Retry-After、GraphQL HTTP200 限流错误或无进展都停止加速。维护调用读预算后，还会在本次进程内遵守 provider 已返回的 Retry-After/耗尽 reset：期限前不再发后续请求；不能完成的撤销读回仍保持未确认。未选择维护模式的 publisher 不改变请求路径。观测故障只使额外能力未知，不能把成功的旧 publisher 请求变成失败。

GitHub 的资源额度和 secondary 限制分开；遵守响应中的 reset/Retry-After，不能把高层 port 调用数等同于 HTTP/GraphQL cost。依据：[REST 限流](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[GraphQL 限流](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)。

### 61.6 验证与未承诺的可用性

必须用真实 `runTrain`、create-only store、Resident 行门禁及 fixture publisher/merge 演练“已有待合 PR → 启动 → 枚举/撤绿 → coverage → 恢复精确 front → Stage8 → green → 模拟合入”，记录时间线、请求数、前后台状态和拒绝原因；另测 strict 关闭、重开/改写、代次变化、损坏记录、额度/时钟/重启边界。纯模型只补充范围等价性，不替代调用链演练。

保留的条件包括：完整候选枚举的实际工作量、main 改写到 full 的冻结、超过 250 commits/分页拒绝、200/day 与共享 provider 额度、Source 不一致、网络/角色/授权丢失、人工 HALT/Grant、Owner 登录后 companion 才可工作及丢失合并事件的旧恢复依赖。无法从本次局部优化推导所有场景 30 分钟内可合入；目标 1–2 小时必须以实测限定数据量、资源和故障假设。尚有需要 Owner 接受或另项修复的残余时，不宣称全 Task/SLO 通过。

## 62. 第17代候选：当前front的strict路径与独立历史清扫

Task `98bddf93-f1ed-4983-b39e-bcbe10be1672`，基于main `08e2efd5`。Owner决定 `496c92ba` 澄清 `9cfba8d6`：合入并独审通过后可先在DESK/TURING安装shadow，不阻塞合并；安装后在真实仓库分别实测冷启动和接管首次绿，两项均不超过30分钟，才另行将train切到on。任一未达标则保持关闭，可回退。本节描述候选，不是实测计时通过；模型不能代替验收。

### 62.1 调整的是等待历史覆盖，不是当前发布准入

第16代的旧图反例只证明strict不能保证只剩一个绿，不能单凭它推出strict持续开启时会合入未经测试的树。严格检查、required检查来源、既定合并规范与Runbook持续成立时，当前front可采用独立的strict当前subject路径。它仍运行现有试合并提交S的本地角色；每次发布保持实时T/H/S/tree、当前Source、duty、holder、真实Native claim generation、Owner准入、ticket/current/settlement和补偿检查。

`sweep.strictFrontReadiness` 是合同 `clued.independent-ci.train-strict-front-readiness/1` 的调度观察，显式 `historyCoverage=false`，绑定repo/T/Source/settings/onSince/front PR/H/claim/since及有界时效。只有自身耐久enqueue记录绑定的S可用，不能让其它行绕过等待。它不表示旧绿已全部枚举或撤销，不改 `sweep.complete`、旧v1 `proofWritten`、`fullSweep.sinceOn` 或 `trainTakeoverDone` 的原义。重启、Source/duty/身份/期限变化后，先由Source刷新；磁盘上的轻量观察不恢复发布授权。

### 62.2 快路径必须单独拒绝的状态

strict关闭、不可读或App pin不符时不得使用本路径。Native既有ADMITTED可能允许frozen下的精确Owner批准，因此快路径每个发布边界还要显式拒绝frozen，不能把ADMITTED当作非frozen证明；原完整full路径的Owner语义不变。

受保护full记录较新的损坏、同时间矛盾、main anchor未重新校准，以及已知main改写未完成full时，均不允许回退旧记录放行。真正空store仅代表历史未知，仍依赖Owner已接受的冻结Runbook与Native非frozen，不能声称机器已证明历史无改写。已有未确认撤销、legacy strict pending和不可读账本要独立保留；旧v1 `clean=false, unconfirmed=0` 可仅表示历史扫描未完，不能伪改clean，也不能将它等同已写撤销失败。

关闭strict前先完成真实full仍是Owner操作前提。Stage8只阻止后续绿，companion的异步通知/暂停不能作为GitHub改规则前的同步硬门禁。main改写继续冻结到真实full，禁止用快路径或重装清状态绕过。旧授权已撤但静态check仍绿的暴露属于单独风险；不能假设所有原生合并入口都实时理解Native，也不能把尚未证实的坏合入当作现场事实。

撤销结果使用独立的 `pending-revocations/1` 受保护记录在固定 App 约束下保存精确 check ID 和 head；普通、strict 及 off-duty 的自身检查撤销均先耐久写入 intent，再执行负面更新。目标不绑定会变的 Source 或 front，跨轮继续按精确 ID 双读回并确认账本后才耐久清除；清除写失败仍视为待确认。原每轮20个目标、截止时间与外部检查的实时 duty 权限保持不变。较新的 full、v1 和 front 证明必须按写入顺序一致，同毫秒但不同 run 的矛盾记录不能回退采用旧证明。

升级前若只有未确认数量而没有可恢复的目标 ID，不能由下一次 partial 的零值洗掉。迁移记录保留不能关联到目标的旧未确认计数，并要求新的真实 `scope=all` 完成后才解除；这类恢复不保证30分钟。累计 `full.unconfirmed` 仍是指标，不充当当前待确认目标集合，也不伪造 full 完成。

### 62.3 清扫进展和验收

完整§60 all/current历史范围继续保留，快路径不删除force-push端点、closed-current或旧候选。已必需的current覆盖可与all相同有界续跑：真实耐久进展、同滚动200总账/E56额外账、同额度时效/hold和前台优先；routine current轮不获得无限加速。已知未确认撤销不能因前台先跑而丢失；前后台耗时与停止原因分别计量。

验收分开记录历史覆盖、允许开批、本地扫描、Stage8真实首绿和实际可合并。旧PR的14分钟与15分34秒发布间隔只是样本，不能加在模型上冒充第17代实测。必须覆盖cold/current、普通partial旧投影、frozen、strict切换、main改写、损坏最新记录、claim/Source/front/S变化和重启负例；局部测试通过不表示现场30分钟目标或安装条件已满足。
