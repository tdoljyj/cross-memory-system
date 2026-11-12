# 常驻独立 CI · 当前架构

- 基线：分支 `claude/train-strict-permanent` 提交 `c933238b5`（strict 永久开模式，Owner 决定 `9e2511fe`）。
- 范围：本文只写这个基线上**实际生效**的设计。
  - 历史理由、复审记录、事故经过都在 [`../DESIGN.md`](../DESIGN.md)。它已冻结为档案，按节号回查。
  - 为什么这样设计，见 [adr/](adr/)。
  - 怎么操作，见 [runbook.md](runbook.md)。
  - 术语见 [glossary.md](glossary.md)。
- 路径约定：
  - `R/`：常驻层 `work/independent-ci-resident-v1/`；
  - `CI/`：Source v2 `work/actions-hosted-migration/independent-ci-v1/src/`；
  - `<root>`：节点上的 `C:\ProgramData\CluedIndependentCI\resident`。
- 每节开头的"代码"一行列出该节对应的文件。DESIGN 的节号放在"档案"一行。

---

## 1. 它做什么

常驻 CI 在每台 CI 节点上常驻运行，替代原来"每批由 Owner 点一次 UAC"的独立 CI。

- **输入**：PR 的 head（由轮询器自动发现）。
- **输出**：
  - 六项必需检查：`kooyumi-work-admission`、gitleaks、trivy、contract-placement，以及两项控制检查 `kooyumi-admission-verified`、`kooyumi-merge-slot`。
  - 合并列车开着时，由它决定"下一个合进 main 的是谁"，只给那一个 PR 发合并位的绿。
- **人工**：每批 0 次 UAC、0 次 root。Owner 只在以下场合出现：
  - 安装或整套重装；
  - 批准原地升级。可以由自动审批代批，见 [ADR 0012](adr/0012-upgrade-auto-approval.md)；
  - 未知失败之后复位；
  - 急停后恢复。

几条贯穿全文的不变量，详见 §13：

1. **每个作业最多执行一次**：同一个 head 的同一项检查只真跑一次（[ADR 0003](adr/0003-execute-once.md)）。
2. **fail closed**：认不出的失败一律 HALT，等 Owner 复位（[ADR 0004](adr/0004-fail-closed-halt.md)）。
3. **PR 代码只当数据**：执行器只从管理员专用目录加载代码，用户可写目录里的东西只当数据（[ADR 0001](adr/0001-permission-separation.md)）。
4. **常驻服务不联网、不读秘密**：联网的核验和发布只在 `.\clued-control` 身份下的阶段助手里做。
5. **测什么就落什么**：strict 永久开，合入的树等于测过的树（[ADR 0007](adr/0007-strict-permanent.md)）。

---

## 2. 组件总览

代码：`R/src/service-main.mjs`、`R/src/companion-main.mjs`、`R/windows/*.cs`、`R/linux/systemd/`、`R/upgrader/src/`
档案：DESIGN §3、§8、§9、§34、§42

```
                         ┌───────────────── GitHub（App 5368905 发检查；Owner 的 gh 登录只读 + 少量固定写） ─────────────┐
                         │                                                                                              │
   KooYomi / Native ◀────┼──── 通用助手（.\clued-control，Session 0）：实时准入、发布、撤绿、角色探测                       │
   （ci-admission、       │            ▲  只由交换代理以"换 runner 二进制 → 启动一次 → 换回"的方式拉起                       │
    合并队列、Grant）      │            │                                                                                 │
                         │   CluedCISwapBroker（LocalSystem）◀── broker\requests\ ── CluedCIResident 常驻执行器（虚拟账户） │
                         │                                                          │  ▲          不联网、不读秘密           │
                         │                                                          │  │ mailbox\（只新建文件）             │
                         │                                                          ▼  │                                    │
                         └──── companion（Owner 登录会话，不提权）：轮询、bundle、泵、PR 页面、心跳、升级信箱 ──── wsl.exe ──▶ WSL：clued-ci-* unit（root，沙箱）
                                                                                                     
   CluedCIUpgrader（LocalSystem）：原地升级的唯一执行者，只认 Owner 对精确包哈希的 Grant
```

| 组件 | 身份 / 会话 | 能做 | 不能做 | 代码 |
|---|---|---|---|---|
| **常驻执行器** `CluedCIResident` | `NT SERVICE\CluedCIResident` 虚拟账户，Session 0，非管理员，只保留 `SeChangeNotifyPrivilege`，按服务 SID 封掉出站 | 全部调度决定：读触发、排队、预留、驱动各段、分类失败、归档、写账本和回执、写状态 | 联网、读秘密、加载用户目录里的代码、对 runner 服务有任何权限 | `src/service-main.mjs`、`src/executor.mjs`、`windows/ResidentServiceHost.cs` |
| **交换代理** `CluedCISwapBroker` | LocalSystem | 把 runner 服务的二进制路径在"原始"和"已安装、哈希在白名单里的通用助手"之间切换，带 nonce 启动一次，等它停下再换回；Owner 中止时向这一次交换的助手发一次 SCM 停止 | 改账户、启动类型、依赖、DACL；运行白名单外的东西；杀进程 | `windows/SwapBroker.cs`、`CI/resident-v2/windows/ResidentScmV2.cs` |
| **通用助手** | 以 runner 服务的账户 `.\clued-control` 运行 | 读 App 私钥和 ci-admission token；对 GitHub、KooYomi 做全部实时核验和发布 | 加载 `<root>\source\<ciSourceManifestSha256>\` 以外的代码 | `CI/resident-v2/`（`invoke-stage.mjs`、`FormalPublicBoundaryV2.cs`、`entry-runtime.mjs`） |
| **companion** | Owner 本人，计划任务 `\Clued\CluedCIResidentCompanion`，不提权。现装版本 AtLogOn 触发、Interactive 令牌；第 29 代（ADR 0022，未安装）改为密码登录、会话 0，由监督进程 `bin\CluedCompanionSupervisor.exe` 拉起 | WSL 保活；用 Owner 的 git 凭据打 bundle；在两端 spool 之间搬运 bridge 记录；启动固定的 Linux unit；轮询 PR；写 PR 页面状态和 Windows 通知；发节点心跳；搬运升级信箱 | 任何授权判断；任意命令（只有固定 argv）；写执行器的 `state\` 和 `owner\` | `src/companion-main.mjs`、`src/companion.mjs` 等，见 §9 |
| **Linux unit** | WSL 内 root，systemd oneshot 模板，沙箱加固 | `clued-ci-worker@`（扫描 worker）、`clued-ci-wsprep@`（建工作区）、`clued-ci-archive@`（归档）；每个都由 root 自己实测前提 | 让 PR 内容驱动执行代码 | `linux/systemd/`、`linux/bin/clued-ci-resident-linux` |
| **升级代理** `CluedCIUpgrader` | LocalSystem | 原地升级：暂存、停服、切换、启动、校验，失败自动回滚 | 在没有 Owner Grant 的情况下改任何东西 | `upgrader/src/`、`windows/UpgraderServiceHost.cs`、`windows/upgrade-apply.ps1` |
| **服务端（KooYomi / Native）** | Supabase 上的 RPC，用每节点的 ci-admission Binding 调用 | 准入评估、合并队列（车头、touch、adopt、return、保活）、角色持有、心跳与自动接班看门狗、Grant | — | `apps/clued-cloud/supabase/migrations/`（不在本目录） |

三个账户（常驻、代理、clued-control）互相隔离。常驻服务能让代理做的，只有"对一个已钉住的阶段包启动一次助手"这一件事。见 [ADR 0001](adr/0001-permission-separation.md)。

---

## 3. 安装布局与数据通道

代码：`R/windows/install-resident.ps1`（目录与 SDDL）、`R/src/inbox.mjs`、`R/src/mailbox.mjs`、`R/src/store.mjs`
档案：DESIGN §3.2、§8.3、§31、§33

### 3.1 目录

`<root>` 下的目录（SDDL 见 `install-resident.ps1` 的目录表）：

| 目录 | 谁写 | 谁读 | 内容 |
|---|---|---|---|
| `resident\<residentManifestSha256>\` | 安装（管理员） | 所有人 | 常驻层代码，按内容寻址 |
| `source\<ciSourceManifestSha256>\` | 安装 | 常驻、clued-control、Owner | Source v2 代码 |
| `bin\`、`helpers\`、`runtime\` | 安装（在节点上用 csc 编译） | 各服务 | 服务宿主、交换代理、作业宿主、通用助手、钉住的 `node.exe` |
| `config\`、`install\` | 安装 | 常驻、Owner | `policy.json`（哈希写进服务启动参数）、`broker.json`、`companion.json`、安装回执 |
| `inbox\` | Owner 会话进程（只能新建） | 常驻 | 触发记录 |
| `requests\` | Owner 会话进程（只能新建） | 常驻 | 暂停、暂停接新、立即探测、撤车头 |
| `owner\` | **只有 Administrators 能建文件** | 常驻 | 复位、恢复、中止、排空、放行熔断，以及升级代理的 resume、`retention-keep.json` |
| `owner\train-review\` | Owner（**不需要提权**，与 `owner\` 不同；已接受的残余风险） | 常驻、clued-control | 影子数据复核标记；最坏只让影子记录的 90 天清理提前开始 |
| `mailbox\requests\`、`responses\` | 常驻 / companion | 对方 | 执行器与 companion 之间的固定种类请求和回答，以及心跳 |
| `broker\requests\`、`responses\` | 常驻 / 代理 | 对方 | 交换请求 `{stage, nonce, deadline, configSha256}`、`.taken`、`.stop` |
| `outbox\<batchId>\` | 常驻 | companion、Linux unit | 公开批次描述符 `resident-batch-descriptor/3` |
| `stage\`、`work\` | 常驻 | clued-control | 每段封存的输入、导出的批次 |
| `bundles\` | companion（Owner） | ws-prep | 每批的 git bundle、种子库 `_seed\seed.git` |
| `state\` | 常驻（`state\v2\*` 由 clued-control 写，这些子目录及其授权由 Source v2 `resident-v2/migrate-acl.ps1` 在安装时建立） | Owner 只读 | 账本、HALT/PAUSE、排队表、回执链、`status.json`、已执行记录、绿色台账 |
| `upgrade\` | 升级代理 | 常驻、companion、Owner | `current.json`、`status.json`、`inbox\`（Owner 只能新建）、`mailbox\` |
| `secrets\` | 安装 | SYSTEM、Administrators | 升级令牌；`secrets\heartbeat\`（心跳令牌，Owner 只读） |

App 私钥和 ci-admission token 不在 `<root>` 下，放在 `C:\ProgramData\CluedControl\trusted\` 和 `C:\ProgramData\CluedIndependentCI\secrets\`，只有 clued-control 能读（DESIGN §30.5）。

### 3.2 通道规则

- **只新建，格式精确**：所有通道都只新建文件，字段集合精确，有字节上限。
  - 写侧先写临时名再换名（`store.mjs#writeNewAtomic`），读侧就不会读到半截文件。
  - inbox 和 requests 对 Owner 只能新建、不能换名，所以由读者等：文件为空或大小在变时等 30 秒（`INBOX_UNFINISHED_GRACE_MS`）。
- **读后归档**：读过的文件改名进处置目录，从不删除。
- **owner 目录的授权来自 ACL**：
  - 每个请求点名 Owner 审过的那份 HALT、PAUSE 或账本记录的确切字节摘要，服务按比较交换执行；
  - 已处理的请求按文件名和字节摘要两种方式记下，重放不会生效；
  - 写进 `requests\` 的复位或恢复请求一律拒绝。

---

## 4. 一批的流程

代码：`R/src/executor.mjs`（`tickInner`、`schedule`、`runBatch`）、`R/src/engine-windows.mjs`、`CI/resident-v2/derive-batch.mjs`、`CI/resident-v2/invoke-stage.mjs`
档案：DESIGN §5、§7、§18

### 4.1 一个 tick

执行器空闲时每 15 秒一个 tick，有活时每 2 秒一个（`service-main.mjs`）。顺序固定：

1. **崩溃恢复**（HALT 时也做）：
   - 未终结、又不是可恢复等待的账本条目 → `FAILED_UNKNOWN`，烧号，HALT；
   - 内容读不了的条目 → 原样隔离到 `ledger-quarantine\`。
2. **Owner 请求**（`takeOwnerRequests`，读 `owner\`）。
3. **版本状态**（`versionsRefresh`）：两侧不一致时加暂停接新，见 §11.3。
4. **排队表按账本结算**（`reconcileQueue`）。
5. 第 10、11、12 段的中断恢复；撤销维护。
6. **HALT 检查**：HALT，或者还有未归档的未知现场 → 停。
7. **已执行记录回填**（只在安装后的首次启动做）。
8. **`requests\`**：暂停、暂停接新、立即探测、撤车头。
9. **PAUSE**：PAUSE 时只跑角色探测；列车开着时，第 10 段以只撤模式运行；然后返回。
10. **读触发进排队表**（`intake`）。
11. **停靠批次**（`resumeParked`）：停在 B、到了尝试时间的批次跑一次第 8 段。
12. **调度**（`schedule`）：取下一个候选批次，预检后跑。
13. 什么都没跑时，依次做：角色探测、排队观察、第 10 段。

### 4.2 预检（不联网、不读秘密）

依次检查：

- head 是否已烧，是否已执行；
- 冷却期、各项额度；
- `validUntil`；
- 已安装 Source 和常驻层每个文件的哈希（有漂移就 HALT）；
- companion 心跳（`companion.heartbeatMaxAgeMs`，没有心跳就推迟 `COMPANION_NOT_READY`）；
- 节点模式、暂停接新、熔断、停靠名额、列车门。

### 4.3 段与账本记录

账本目录是 `state\ledger\<batchKey>\`，每个文件 CreateNew，从不改写。

| 步骤 | 账本记录 | 说明 |
|---|---|---|
| 预留 | `00-reserved.json` | 带 `origin`：queued、backoff-retry、waiting-retry、new-trigger、restored、attempt2 等 |
| 导出 | — | Source v2 `derive-batch.mjs` 从"已安装 Source + 触发数据"确定性导出批次包，写描述符 |
| 第 0 段 | — | companion 运行 `build-bundle.ps1` 打 bundle。失败 → 只关 Windows 侧，释放 |
| 第 1 段 | — | Native 工作准入（见 §4.4）。未准入、不当班（`NODE_ROLE_NOT_HELD`），以及能证明什么都没写的 `GITHUB_TRANSIENT_UNAVAILABLE` / `NATIVE_ADMISSION_UNAVAILABLE`（`STAGE1_TRANSIENT_RELEASE_CODES`）→ 释放；其他失败 → 烧号 |
| 开始 | `10-started.json` + `state\ledger-heads\<headKey>.json` | 这一步烧号 |
| 资格冻结 | `14-qualification-hold.json` | 只收紧的转发资格冻结标记（`relay-qualification-hold.mjs`），存在就挡住这个 head；转发关着时不出现 |
| 托管等待 | `15-relay-wait.json` | 停靠点 A。转发关着时立即通过 |
| 计划 | `20-plan-intent.json`、`25-plan.json` | 每个角色本地跑还是转发。转发关着时全部本地 |
| 工作区 | — | `clued-ci-wsprep@<batchId>`：root 预检、`git fsck --strict`、建工作区。从这里开始进入 Linux 独占区 |
| 第 2–7 段 | — | 每个本地角色先执行，再发布。第 4、6 段之前做角色间归档（只移协议记录） |
| 收尾归档 | — | 两端只改名归档最后一个角色的协议记录 |
| 停靠点 B | `70-parked.json` | 退出独占区，第 8 段按"尝试"跑 |
| 第 8 段尝试 | `71-try-NN.json` / `72-tried-NN.json` | 没就绪且零副作用 → 回到 B |
| 中止 / 自我结束 | `80-owner-abort.json` / `81-self-abort.json` | 见 §8 |
| 终态 | `90-terminal.json` | `COMPLETED`、`FAILED_CLEAN`、`FAILED_UNKNOWN`；释放时为 `NOT_EXECUTED`，整个目录移入 `state\ledger-unexecuted\` |
| 复位后 | `95-archived.json` | 未知现场已归档 |

每一段在 Windows 侧的调用链（`engine-windows.mjs#runStage` → `CI/resident-v2/invoke-stage.mjs`）：

1. 封存这一段的输入到 `stage\`；
2. 往 `broker\requests\` 写交换请求；
3. 代理把 runner 换成通用助手，启动一次；
4. 助手以 clued-control 身份跑这一段的入口，写原生回执和结局记录；
5. 代理换回原始二进制，回复；
6. 三份记录（代理回复、助手回执、入口结局）合成一个**阶段事实** `resident-stage-fact/2`。

失败码来自 `CI/resident-v2/stage-fact.mjs` 的稳定目录，`R/src/classify.mjs` 逐项镜像它（`test/attempts.test.mjs` 保证两边一致）。

Linux 段（2/4/6）额外经过：

1. 段前内存闸：`engine-windows.mjs#memoryGate`，hv_sock 环形缓冲至少 64 块，最多等约 6 分钟；
2. refs 闸门：第一个 Linux 段前运行 `build-bundle.ps1 -CheckRefs`，bundle 之后有新推送就干净结束；
3. 版本兜底：两侧不一致时报 `UPGRADE_VERSION_SKEW`；
4. companion 的泵：在两端 formal-spool 之间搬运 issue → challenge → response → result，并启动 worker unit。

trivy 的扫描结果缓存（M4，DESIGN §68）：同一棵树、同样的工具与数据已经真跑并签过名的成功结论，在 24 小时内直接复用，不再启动三个扫描器容器；准入、扫描许可与签名照做。第 28 代起默认打开，根目录 `/var/lib/clued-independent-ci/scan-result-cache`，placement 与 gitleaks 不缓存（[ADR 0021](adr/0021-trivy-scan-result-cache-default-on.md)）。

### 4.4 第 1 段：准入

代码：`CI/formal-work-admission-check-v2/`、`CI/full-admission-v2.mjs`、`scripts/ci/clued-work-admission.mjs`

clued-control 用本节点的 ci-admission Binding 做完整的 Native 准入，核对：

- PR 是 open 的，head 和 base 正确；
- claim 是 ACTIVE，fence 和 epoch 一致；
- write_set 覆盖全部改动；
- Task 的 CI 计量没超；
- 改到受保护路径时，有对确切 head 的 `repo.protected_change` Grant。Grant 只能来自 Owner 登录的页面，或 Owner 的自动审批开关。

准入通过后发布 `kooyumi-work-admission`，写后再读回核对（等 10/30/60 秒，`reverified`）。认领租约不足 90 分钟时，由 CI 自动延长（`claim-assist-native.mjs`）。

几种结局：

- 本节点不当班 → `NODE_ROLE_NOT_HELD`：释放，节点转 STANDBY（§10.1）；
- 队首 PR 的普通批次第 1 段绑定了认领 → 让位（`TRAIN_FRONT_CLAIM_BOUND`，§7.3）。

### 4.5 第 8 段：控制检查对

代码：`CI/independent-control-checks-v2/publisher.mjs`、`train-rules.mjs`、`train-strict.mjs`、`green-ledger.mjs`、`claim-assist-native.mjs`

每次尝试最多核对 90 秒（`STAGE8_CHECK_MS`）。

**写之前**，以下全部满足才发绿：

- 完整准入重新通过；
- claim 在 KooYomi 合并队列的队首、合并位有效；
  - 不在队列时，CI 自动入队（`merge_queue_join`）；
  - 租约不足 180 分钟时，CI 自动延长；
- main 的规则可读：六项必需检查都钉在 App 5368905、strict 为真、合并方式只有 merge；
- GitHub 试合并的父提交恰好是 [T, H]，树等于测过的树；
- 列车开着时，当前车头路径成立（`strictFrontHeadDecision`，§7.4）；
- 绿色台账先记下 intent。

**写之后**：读回核对。PR 已被合入、合并提交恰为 [T, H] 且树相同，算成功（`settledMerged`）。

没就绪时零副作用退出，码在 `STAGE8_NOT_READY_REASONS`。批次回到 B，按退避或队首 1 分钟再试（§6.3）。

---

## 5. 一次性与烧号

代码：`R/src/ledger.mjs`、`R/src/executed-heads.mjs`、`R/src/attempts.mjs`、`CI/effect-journal.mjs`
档案：DESIGN §6.1、§16.1、§7.2

见 [ADR 0003](adr/0003-execute-once.md)。四层防重：

1. **账本按 head 烧号**：`10-started` 之前 CreateNew `state\ledger-heads\<headKey>.json`。
   - `headKey` 由 (repo, H, Source, attempt) 算出，车头批次再加 S；
   - 与 base、PR 号、claim 都无关。
2. **已执行记录**（与 Source 无关）：
   - 第 R、3、5、7、8 段之前写 `state\executed-heads\<键>\…`。写不进就不跑这一段；
   - 已执行的 head 一律忽略（`HEAD_ALREADY_PUBLISHED_NO_RETRY`）；
   - 安装后首次启动，从本机账本和带入的旧 state 回填。回填完成之前不跑任何批次。
3. **作业身份与 effect journal**：
   - 作业 id 不含 claim；
   - effect journal（`state\v2\effects-*`）永不归档，跨批次也"只发布一次"。
4. **K(head, role)**：同一 head 上同一角色只有一个发布者。

attempt 2：

- 只在 attempt 1 以 `FAILED_CLEAN` 结束、码是干净的暂时码、失败在第 1 段、工作区准备或第 2 段（发布之前）时排一次（`attempts.mjs#ATTEMPT2_STAGES` 里的 0 指工作区准备，不是打 bundle）。
- 延迟 `automaticAttempt2.delayMs`（10 分钟）。没有 attempt 3。
- 车头批次的 attempt 2 计入该 head 的两次车头批次。

---

## 6. 排队、调度与额度

代码：`R/src/queue.mjs`、`R/src/executor.mjs#schedule`、`R/src/breaker.mjs`、`R/src/ledger.mjs#usage`、`R/src/policy.mjs`
档案：DESIGN §17、§18、§36、§53

### 6.1 排队表

`state\queue\queue.json`，每个 PR 一行，整体替换写入。它只是调度视图：账本说不能跑的，排队表说什么都没用。

- **状态**：QUEUED、RUNNING、WAITING、BACKOFF、PARKED、STOPPED、DONE。活行最多 100 行（`queueDepth`）。
- **到达序号**：由执行器读到触发时编号，每个 tick 最多读 16 个（`inboxMaxFiles`）。
- **新提交**：
  - 旧提交还在等 → 直接替换，不评估、不烧号；
  - 旧提交正在跑 → 在安全点 `before-stage-1` / `before-relay-plan` / `before-workspace` 凭一次实时读确认后结束；
  - 停在 B 的批次 → 每个 tick 实时读一次，确认 head 已变就以 `SUPERSEDED_AT_SAFE_POINT` 结束。
- **读不出**：文件改名留存，换一个新的 `generation` 重建。poller 看到 generation 变了会重新提议所有 PR。

### 6.2 调度顺序与退避

每个 tick 依次：停靠批次 → 到期的 attempt 2 → 到期的等待重试和新触发 → 其余按到达先后。一次最多看 16 行。

| 情形 | 退避 |
|---|---|
| 释放后 | 排到队尾，10 → 20 → 40 分钟。同一 head 24 小时最多释放 2 次 |
| 等待类（`OWNER_REVIEW_REQUIRED`、`TASK_CI_HEAD_CAP_REACHED` 等） | WAITING，10 → 20 → 40 → 80 → 120 分钟，之后每 120 分钟 |
| 网络类（`classify.mjs#networkFailure`） | 固定 10 分钟，计入独立的每 head 每天 36 次 |

### 6.3 停靠

- **停靠点 A**：第 1 段（和托管等待）之后、工作区准备之前。
  - 只有托管转发打开时才会真正停在这里；
  - 恢复时距预留超过 30 分钟就重打 bundle；超过 100 分钟以 `PARKED_BUNDLE_TOO_OLD` 结束。
- **停靠点 B**：第 1–7 段跑完、两端收尾归档之后、第 8 段之前。
  - 停在 B 的批次什么都没在运行，执行器照常跑别的批次；
  - **独占区**：从工作区准备到收尾归档，期间不插入别的段，一个 tick 最多跑一个独占区。

B 上的第 8 段尝试：

| 规则 | 值 |
|---|---|
| 平时的退避 | 10 → 20 → 40 → 80 → 120 分钟 |
| 上次在合并队列第 1 位 | 1 分钟后再试（`PARK_HEAD_RETRY_MS`），连续最多 15 分钟（`PARK_HEAD_STREAK_MS`） |
| 计数的尝试上限 | `park.stage8MaxTries` = 12 |
| 停留上限 | `park.maxMs` = 24 小时 |
| 全部停靠批次第 2 次及以后的尝试 | 24 小时 ≤ `park.stage8RetriesPer24h` = 100 |
| 名额 | A 加上 B 中前 2 位 ≤ `park.maxParked` = 4；B 中其他 ≤ `maxParkedOutsideTop2` = 8；满了就 `DEFERRED PARKING_FULL` |
| 第 8 段零副作用的暂时失败（`NATIVE_ADMISSION_UNAVAILABLE`、`GITHUB_TRANSIENT_UNAVAILABLE`） | 停在 B 最多 3 次，间隔 1 / 3 / 10 分钟，第 4 次烧号 |
| main 移动（`RESIDENT_BASE_MOVED`）、超出上限 | 中性结束 |

**排队观察**（`queueWatchMaintenance`）：空闲、当班、所有打开的批次都在停靠点时运行，用角色探测的 `watchPr` 读合并队列。停在 B 的批次一到队首就提前尝试。

- 读取节奏：前 30 分钟每 30 秒，到 2 小时每 2 分钟，之后每 5 分钟。

### 6.4 额度（策略 `/10` 的取值）

额度一律从账本推算（`ledger.mjs#usage`）。

| 额度 | 值 |
|---|---|
| 执行批次 `maxBatchesPer24h` | 72 |
| 评估 `maxEvaluationsPer24h` | 96 |
| 每个 PR 的批次 `perPrBatchesPer24h` | 6 |
| 等待重试 `waitingRetriesPer24h` | 48 |
| 新触发重评 `reevaluationsPerPrHeadPer24h` | 6 |
| 每个 head 的释放 `releasesPerHeadPer24h` | 2（网络类另计 36） |

按风险分档：第 1 段在 `10-started` 之前干净结束、零副作用、证明没发布的烧号，算"评估档"，不计执行次数（DESIGN §36）。

### 6.5 熔断

代码：`R/src/breaker.mjs`

- **打开**：连续 3 次，或 1 小时内 4 次计入的失败（失败对照表 `breaker: counts`）。
- **打开后**：不开任何新批次，试跑间隔 30 → 60 → 120 分钟。
  - 网络原因：10 分钟后试跑；连续 2 次探测成功就提前试跑。
- **半开**：一次放一批，不选刚失败的那些 PR。
- **关闭**：试跑越过上次失败的位置。
- **Owner 提前放行**：`rearm-resident.ps1 -Request ReleaseBreaker`，只让试跑提前，不关熔断（runbook §3.5）。

---

## 7. 合并列车（strict 永久开）

代码：
- 常驻层：`R/src/train.mjs`、`R/src/executor.mjs`（`trainMaintenance`、`trainGate`、`enqueueFront`、`trainFrontYield`、`resumeParked`）、`R/src/policy.mjs`（`train`）
- Source v2：`CI/independent-control-checks-v2/train-maintenance.mjs`、`train-facts.mjs`、`train-sweep.mjs`、`train-rules.mjs`、`train-strict.mjs`、`CI/resident-v2/train-run.mjs`

档案：DESIGN §41、§60–§62、§65

### 7.1 现在的模式

现场已装策略为 `train.enabled = on`（Decision `0ac620fa`：保持开车、不再回退；仓库里的示例 `config/policy.v10.example.json` 仍是 `shadow`，现场策略不在仓库里）。`train.sweep` 没写时取 `audit`（`TRAIN_SWEEP_DEFAULT`）。Owner 决定 `78a3052f` 要求装机策略显式写 `sweep: audit`。

- **strict 永久开，合并方式只有 merge**（[ADR 0007](adr/0007-strict-permanent.md)）。GitHub 只合入包含 main 尖端 T 的 H，此时 merge(T, H) 的树就是 H 的树，测什么落什么。
- **全量清扫不挡任何事**（[ADR 0008](adr/0008-full-sweep-audit.md)），每天最多一轮后台审计（`AUDIT_EVERY_MS` 24 小时）。
- `gate` 模式保留为回退路径：一次 UAC 把策略写成 `train.sweep: "gate"`，回到旧的接管门（DESIGN §65.5）。
- **落地方式 `train.landing`**（第 28 代，[ADR 0018](adr/0018-bors-landing.md)、[ADR 0019](adr/0019-train-batch-member-chain.md)）：默认 `github-merge`，第 8 段写 `kooyumi-merge-slot` 绿，由 GitHub 合并，和上面说的完全一样。`push` 是 bors 式落地：第 8 段在全部实时准入通过后，把测过的 S 快进推上 main；第 10 段组批（`train.batchMax`，默认 1）、生成累积合并、二分，并 adopt 每个成员。`push` 要求 `sweep` 是 `audit` 或 `off`，并且要先完成 ADR 0018 第 8 节的 App 权限、规则集和工作流前提；Owner 决定按 ADR 0010 的触发条件再打开。代码在 `CI/independent-control-checks-v2/train-landing.mjs`、`train-landing-port.mjs`。

### 7.2 车头与 S

**车头**是 KooYomi 合并队列第 1 位的认领绑定的 PR。

- 服务端在车头离开时一次写定下一个车头；
- 车头后面的认领按 Task 优先级排，同优先级按入队时间（Decision `3dcb583b`）；
- 排位开关每个 merge ref 一个，默认 `fifo`。

**S** 是车头 PR 在当前 T 上的 GitHub 试合并提交。

- 只有 on 模式第 10 段的 `OPEN_FRONT_BATCH` 能产生带 S 的排队行（`queue.mjs#offerFront`）；
- 每个 head 最多两次车头批次（`FRONT_BATCHES_PER_HEAD`）；
- 车头批次全部本地跑（`RELAY_TRAIN_FRONT_LOCAL`），作业 `job/3` 带 S；bundle 里 S 放在 `refs/clued-test/<S>`。

### 7.3 稳态流程

1. PR 推送 → companion 轮询发现 → 普通批次（S = H）。
2. 队首 PR 的普通批次第 1 段完成后，Native 报这个认领已进入队首（`mergeQueue: entered, state: head`，位置 1）。批次让位（`trainFrontYield`）：
   - 以 `TRAIN_FRONT_CLAIM_BOUND` 结束，释放为 `TRAIN_FRONT_BOUND`，**不烧号**；
   - 设 `trainUrgent`，下一次第 10 段立即运行。
3. 第 10 段（on）决定 `OPEN_FRONT_BATCH(pr, H, S)`：
   - 前提：读到 strict 为真、规则钉值正确、各节点 Source 一致、试合并父提交是 [T, H]、没有待撤销的绿；
   - 写 strict-front 观察；
   - 对合并位 `touch running`，时钟最长 90 分钟，受 `slotHardCapMinutes` 约束。
4. 车头批次跑第 1–7 段，停到 B。
5. 第 8 段之前，证明剩余不足 3 分钟时先跑一次第 10 段刷新（`frontProofShort`）。
6. 第 8 段发 `kooyumi-merge-slot` 绿 → `touch green`，服务端给 30 分钟合并时间。
7. 合并执行器按 merge 方式合入。之后第 10 段核对合并提交恰为 [T, H]、树等于 S 的树，然后 `adopt` 认领：
   - 树不同 → `TRAIN_LANDED_TREE_MISMATCH`，锁 PAUSE 并通知 Owner。

非队首 PR 的普通批次照常跑第 1–7 段，停在 B。在列车模式下，只有车头批次能拿到合并位的绿。

车头 PR 换了新 head（[ADR 0016](adr/0016-front-requeue-on-new-head.md)）：旧 head 的车头批次在第 8 段遇到 `REQUIRED_CHECK_FAILED` 时会还位，认领因此离开队列。新 head 的普通批次第 1 段 SETTLED 后，如果本节点最新的车头批次记录是这个 PR 的另一个 head、同一个认领，而 Native 说认领不在队列，就用 CI 身份 `merge_queue_join` 重新入队（`claim-assist-native.mjs#stage1FrontRequeue`）。入队应答说是队首、位置 1 时，照第 2 步让位。

### 7.4 第 8 段的当前车头路径

`strictFrontHeadDecision` 在写前、写后各复核一次，要求：

- 实时读到 strict 为真；
- 六项检查钉在 App 5368905；
- holder 和 claim generation 一致；
- Source 一致；
- Native 不是 frozen；
- ticket、current、settlement 都对得上；
- 试合并 [T, H] 的树等于 S 的树；
- strict-front 观察属于本节点当前职责（`onSince`）且没过期（`sweepFreshMs` 15 分钟）。

任何一条不满足，就以 `TRAIN_SINGLE_GREEN_NOT_PROVEN`（零副作用）停在 B。

### 7.5 第 10 段

- **运行条件**：只在空闲 tick 运行。
  - 平时每 10 分钟一次（`maintenanceEveryMs`），每天最多 200 次（`maintenanceMaxPerDay`）；
  - `trainUrgent` 时立即运行；
  - 上一轮是 `TRAIN_SOURCE_MISMATCH` 或 `TRAIN_SOURCE_UNREADABLE` 时，2 分钟后重核（`TRAIN_RECHECK_MS`）。
- **合同**：train-run `/3`（带 `sweep`），train facts `/2`。
- **只在 ACTIVE 节点跑 on**，其他节点的状态写 `NOT_ON_DUTY`。PAUSE 或暂停接新期间跑只撤模式（revoke-only）；HALT 时不跑。

主要决定（`train.mjs#DECISIONS`）：

| 决定 | 含义 | 执行器的反应 |
|---|---|---|
| `OPEN_FRONT_BATCH` | 开车头批次 | 写带 S 的排队行 |
| `TRAIN_FRONT_BATCH_RUNNING` | 车头批次在跑 | 等。只因行忙被拒过的，会再提交一次（`frontRetry`，回执 `train-front-reoffered`） |
| `FRONT_NEEDS_MAIN_MERGE` | 车头落后 main（BEHIND） | PR 页面提示持有者合 main。自动更新分支尚未实现（Decision `78a3052f` 第 2 项） |
| `TRAIN_FRONT_NOT_PROVEN` | 这一轮写不出 strict-front 观察 | 不开批次，下一轮再看 |
| `TRAIN_SOURCE_MISMATCH` / `_UNREADABLE` | 24 小时内有心跳的节点 Source 不一致 / 读不出 | 推迟所有新批次，2 分钟后重核，通知 Owner |
| `TRAIN_STRICT_OFF` | 读到 strict 被关 | 锁 PAUSE，通知 Owner |
| `TRAIN_LANDED_TREE_MISMATCH` | 落地的树不等于 S 的树 | 锁 PAUSE，通知 Owner |
| `TRAIN_TAKEOVER_SWEEP_PENDING` | 只在 main 被改写、scope all 轮没扫完时出现 | 推迟所有新批次 |
| `TRAIN_REVOKE_UNCONFIRMED` | 撤绿没读回确认 | 第 8 段不发新绿 |
| `FRONT_ADOPTED` / `FRONT_RETURNED` / `FRONT_FAILED_REPORTED` | 合入后 adopt / PR 关闭后 return / 车头最终失败上报 | 记回执 |

### 7.6 撤绿与清扫

- **撤一条绿**：只按 check run id。GET 核对（App、名字、head、结论）→ 改成 failure → 读回 → 30 秒后再读回，才记 `revoked`。
- **撤谁**：
  - 不在 main、又不是车头当前 head 的绿；
  - main 在列车之外移动后，车头自己的旧绿；
  - Owner 的撤车头请求（`rearm-tool.mjs request-revoke-head`）。
- **增量清扫**：每次第 10 段都做。范围是本节点的绿色台账、KooYomi 发布流水，以及上次以来更新过的 PR。
- **全量清扫**：`audit` 下每天最多一轮，不挡任何事，`fullSweepSinceOn` 恒为假。
- **main 被改写**（记下的 main 不再是当前 main 的祖先）：
  - 接管门关上（`TRAIN_TAKEOVER_SWEEP_PENDING`），立即开一轮 scope all，扫完再放行；
  - 这一条在 `audit` 和 `off` 下都保留（Decision `78a3052f` 第 1 项）。

### 7.7 列车的保护

| 情形 | 第 8 段 | 第 10 段 | companion 兜底（`ruleset-backstop.mjs`） |
|---|---|---|---|
| strict 被关 | 不发绿，停在 B | `TRAIN_STRICT_OFF`，锁 PAUSE | 立即写暂停请求并发紧急通知；STANDBY 节点也暂停 |
| 规则读不到 | `RULESET_UNREADABLE`，停在 B | 不开批次 | — |
| 落地树不对 | — | `TRAIN_LANDED_TREE_MISMATCH`，锁 PAUSE | — |
| 试合并树不对 | `TRAIN_TEST_MERGE_TREE_DIFFERS`，干净结束 | — | — |

### 7.8 合并位与认领租约

| 项 | 值 | 位置 |
|---|---|---|
| 认领租约 / 硬截止 / 续期次数 | 2 小时 / 24 小时 / 12 次 | 服务端 |
| 第 1 段后 CI 自动延长 | 剩余 < 90 分钟时 | `claim-assist-native.mjs#STAGE1_LEASE_MINUTES` |
| 第 8 段 CI 自动延长 | 剩余 < 180 分钟时 | `STAGE8_LEASE_MINUTES` |
| 第 8 段 CI 自动入队 | 不在队列时 `merge_queue_join` | `claim-assist-native.mjs` |
| 第 1 段 CI 重新入队 | 车头 PR 的新 head：最新车头批次是本 PR 另一个 head、同一认领，且不在队列时（ADR 0016） | `claim-assist-native.mjs#stage1FrontRequeue` |
| running 时钟 | `touch running` 后最长 90 分钟，受 `slotHardCapMinutes`（默认 120）约束 | 第 10 段 |
| 第 10 段队位续期 | 已绑定的队首在等车头、或它的车头批次在跑/停靠，队位剩余 < 20 分钟时 `touch running` 一次；每轮最多一次合并位写入（ADR 0017） | `train-maintenance.mjs#renewFrontSlot` |
| 绿之后的合并时间 | 30 分钟 | 服务端 |
| 服务端保活 | 延长排队认领，不越过硬截止 | `clued_private.work_claim_merge_queue_keepalive_v1`（CI 命令门操作 `merge_queue_keepalive`） |

开车头批次前，如果剩余时间小于 `frontBatchBudgetMs` 加一次第 8 段尝试，就不开（`TRAIN_FRONT_BUDGET_SHORT`）。

合并位只由持有者续期和 `touch`（上表的 running/green）推后；`lease_extend` 和 keepalive 只延长租约。认领成为队首到第 10 段开车头之间原先没有延长（ADR 0016 的残余），第 28 代由第 10 段的队位续期补上（[ADR 0017](adr/0017-stage10-front-slot-renewal.md)）。

---

## 8. 失败、重试与停机

代码：`R/src/classify.mjs`、`R/src/failure-table.json`、`R/src/archive.mjs`、`R/src/executor.mjs`（`fail`、`proofFor`、`publicationRetryable`、`prepareExecutionRetry`、`provenCleanEnd`）
档案：DESIGN §6、§16.3、§27、§28、§44、§49–§59

### 8.1 分类

见 [ADR 0004](adr/0004-fail-closed-halt.md)。

静止证明在失败时从两端**现取**（`executor.mjs#proofFor`）：

- **Windows**：`sc.exe` 回读到原始二进制、STOPPED、pid 0、账户仍是 clued-control；阶段的作业树为 0；本服务没有在跑的子进程。
- **Linux**（root 工具原样转交）：
  - 所有 clued-ci unit 都是 inactive；
  - 每个 unit 的 cgroup `populated 0`；
  - 带 nonce 标签的容器全部是 exited 或 dead；
  - 没有残留进程。

`classify.mjs#decideFailure` 按失败对照表（段、码、结局原因、诊断码）给出类别和处置：

| 处置 | 条件 | 结果 |
|---|---|---|
| release | 只在 `10-started` 之前；Windows 证明齐全；有 `safeToRerun` 或代理说没启动 | 不烧号，排回队列 |
| burn | 白名单码且两端证明齐全 | `FAILED_CLEAN`，两端只改名归档，继续处理别的 PR |
| halt | 其余一切 | `FAILED_UNKNOWN`，烧号，HALT，现场不动 |

### 8.2 自动恢复（全部是"能证明没有副作用"时才做）

| 机制 | 适用 | 次数 / 间隔 | 代码 |
|---|---|---|---|
| 只读请求有界退避 | GitHub GET 遇 5xx 或网络错误；Native 读 | 1 / 2 / 4 / 8 秒，每进程两段各 20 秒 | `CI/read-retry.mjs` |
| 发布段原地重跑 | 第 3/5/7 段零副作用、`safeToRerun`；或写后核对读不到而撤回（`PUBLICATION_REVOKED` 且 `republishSafe`，重跑时以新效果键重新发布，最多 3 次，[ADR 0015](adr/0015-republish-after-unavailable-withdrawal.md)） | 30 秒、90 秒、5 分钟 | `executor.mjs#publicationRetryable`、`CI/staged-check-publisher-v2.mjs` |
| 扫描段原地重跑 | 第 2/4/6 段：内存闸、证明没发布、干净拒绝 | 60 秒、300 秒 | `classify.mjs#executionRetryable` |
| 自动收尾 | 第 2/4/6 段泵失联但能证明没发布 | 收为 `BRIDGE_ABANDONED_UNPUBLISHED`；第 2 段可排 attempt 2 | `provenCleanEnd` |
| 第 8 段暂时失败 | 见 §6.3 | 3 次 | `stage8Try` |
| 超时后重问 | 只读探测、幂等动作 | 最多问 3 次（`READ_RETRIES` = 2） | `companion.mjs#runRead` |
| 第二次打包 | 停靠点 A 重打 bundle 遇网络错误 | 1 分钟、5 分钟 | `REBUNDLE_NETWORK_RETRY_MS` |
| 写后采用副本 | GitHub 写收到 5xx | 读回找到完全一致的副本就采用，永不重发 | `CI/staged-check-publisher-v2.mjs#createOrAdopt` |
| 角色探测中断恢复 | 第 11 段被重启打断 | 连续少于 `roleProbe.interruptedMax`（3）次 | `executor.mjs#roleProbeRecover` |

### 8.3 HALT、PAUSE、暂停接新、中止、排空

| 控制 | 谁能发 | 写到哪 | 作用 | 怎么结束 |
|---|---|---|---|---|
| HALT | 系统 | `state\HALT.json` | 一切停下（崩溃恢复和 Owner 请求照做） | Owner 复位（Rearm） |
| PAUSE | 任何 Owner 会话进程；列车或兜底也会写 | `requests\` → `state\PAUSED.json` | 批次之间一切停下 | Owner 恢复（Resume），或升级代理自己的 resume |
| 暂停接新 | 任何 Owner 会话进程；系统持有者 `dual-active`、`version-skew`、`unreadable` | `requests\` → `state\INTAKE-PAUSE.json` | 只是不开新批次 | 最长 2 小时自动失效；同一持有者提前恢复 |
| 中止（Abort） | 提权 Owner | `owner\` | 在安全点结束一个批次 | — |
| 排空（Drain） | 提权 Owner | `owner\` | 结束所有停靠批次（按中止路径） | — |
| 放行熔断 | 提权 Owner | `owner\` | 熔断试跑立即到期 | — |
| 远程急停 | Owner | KooYomi 页面 | 撤销 ci-admission Binding，所有批次 fail closed | 换 token |

复位的过程：

1. 服务实测两端静止；
2. 把所有未归档的 `FAILED_UNKNOWN` 和隔离条目只改名归档（原因 `rearm-unknown-failure` / `rearm-quarantine`），标记 `95-archived`；
3. 按比较交换清除 HALT，HALT 文件改名进 `state\halts\`。

复位从不重跑出事的 head。

中止的安全点：

- P0：tick 开始，针对停在 A 或 B 的批次；
- P1：每一步开始前；
- P2：第 2/4/6 段运行中，每 5 秒看一次 `owner\`。

P2 的停止路径：经代理写 `.stop`，助手走自己的停止路径（只终止它自己的作业对象），再取消 companion 的泵。干净时记 `FAILED_CLEAN OWNER_ABORTED`；静止证明不成立时照旧 HALT。

### 8.4 归档

- **只改名、不删除、只碰白名单**：bridge 定义的记录对，加上 `outgoing/active.lock`。
- 不遍历目录；拒绝 junction 和多重硬链接；改名前后都核实父目录。
- **Windows 侧**：Source v2 `archive-windows-spool.ps1` 持有父目录句柄执行，从不提权运行。
- **Linux 侧**：`clued-ci-archive@<batchId>_<reason>`，用 `renameat2(RENAME_NOREPLACE)`。每个实例名对应一个只新建的状态文件，所以重跑幂等。
- **保留**（DESIGN §35）：成功类和失败类分开算，各保留最新的 20 GiB，且至少保留 10 个。`owner\retention-keep.json` 不存在时一个都不删。

---

## 9. companion

代码：`R/src/companion-main.mjs`（各通道）、`companion.mjs`、`poller.mjs`、`pr-status.mjs`、`node-duty.mjs`、`ruleset-backstop.mjs`、`companion-heartbeat.mjs`、`panel-dispatch.mjs`、`admission-rerun.mjs`、`merge-reconcile.mjs`、`upgrade-mailbox.mjs`、`roles-public.mjs`、`runner.mjs`、`windows/CompanionJobHost.cs`
档案：DESIGN §16.6、§24–§26、§39、§43、§56.5、§63

companion 单实例锁。现装版本由 Owner 登录时启动；第 29 代起由计划任务的固定动作 `bin\CluedCompanionSupervisor.exe` 按管理员专用的 `config\companion-launch.json` 启动并退避重启（ADR 0022 §4.2）。每个通道有自己的 Runner，一个通道卡住不影响别的通道。每个子进程都建在作业宿主（`bin\CluedCompanionJobHost.exe`）自己的作业对象里，超时后整棵树一起结束。

| 通道 | 周期 | 做什么 |
|---|---|---|
| 信箱 | 持续 | 打 bundle（第 0 段）、refs 闸门、建工作区、Linux 归档与静止证明、泵（第 2/4/6 段）、`pr-head` 实时读、内存读数 |
| 咨询 | 1 分钟 | 轮询：用 Owner 的 gh 登录，带 ETag 条件请求读 `git/ref/heads/main` 和 open PR，只提议已跟上 main 的 head；写 PR 页面状态（`resident-queue/<node> (info only)`）；发 Windows 通知；每 5 分钟做一次规则集兜底 |
| 升级信箱 | 5 秒 | 把升级代理的请求交给冻结的 Linux 升级工具；刷新 Linux 版本事实和角色公开副本 |
| 心跳 | 30 秒检查，每 1 分钟发一次（ADR 0025） | 用本节点专用的心跳令牌上报自身状态（§10.3） |
| 面板触发 | 30 秒 | 当班节点每 5 分钟对算力面板发一次 `workflow_dispatch` |
| 准入补跑 | 1 分钟 | `admission-gate` 以 `ADMISSION_PENDING` 结束时，用 Owner 的 gh 登录点一次 "Re-run all jobs"，每个 head 最多一次（Decision `207c0cd0`） |
| 合并对账 | 30 秒 | 唤醒原合并控制器（`clued-merge-reconcile.yml`），不做任何合并判断。**默认关闭**：只有 companion.json 写了 `mergeReconcile.enabled=true` 的包才运行，仓库里现有配置都没有打开 |
| 信箱心跳 | 每 10 秒 | 执行器据此判断 companion 是否活着；超过 120 秒没更新算失联（信号 D） |

安全边界：

- companion 只执行在代码里由已校验的 id 拼出的固定 argv，没有 shell；
- 它搬运的记录由两端各自校验签名；
- 它对执行器只能"让批次停下或少做"，放行永远由第 1 段和第 8 段的实时核验决定；
- 恶意的 Owner 会话最多能谎报 Linux 静止，下一批 ws-prep 的 root 预检会拒绝（DESIGN §3.3）。

现在的限制：现装版本的 companion 要靠 Owner 登录才运行（AtLogOn，Interactive），无人登录时冷启动链没有闭合。Owner 已决定改为 B2 方案（[ADR 0011](adr/0011-companion-without-logon.md)），第 29 代已实施，未安装（[ADR 0022](adr/0022-companion-headless-implementation.md)）：

- companion 任务：Owner 本人、密码登录、LUA；触发器只有开机加 30 秒和每 15 分钟一次；SDDL 里 Owner 只有读。密码由 `CluedCompanionTaskRegistrar.exe` 在安全桌面上收取，切换后 8 分钟内由提权一侧实测，不通过就自动退回 InteractiveToken。
- 通知：6 处 Windows 通知改为写 `%LOCALAPPDATA%\CluedIndependentCI\notify-queue\`，由登录时运行的 `\Clued\CluedCIResidentNotifier`（`src/notifier-main.mjs`）显示；它还提示登录失败码、无心跳、反复重启。
- 升级通道：升级、回滚、Recover 不再注册 companion 任务，只写 launch 文件并重启子进程（`upgrader/src/machine.mjs` 的 `write-companion-launch`）。
- GitHub：companion 用只限本仓库的细粒度令牌，放在 `%LOCALAPPDATA%\CluedIndependentCI\companion-gh\`，读不到就不启动。
- 状态：`executor.companion.firstBeatAfterServiceStartMs`；服务启动 10 分钟仍无心跳时出 `companion-absent`。
- 上线只能整套重装（R 类），步骤见 [`../rollout/M5-COMPANION-HEADLESS-RUNBOOK.md`](../rollout/M5-COMPANION-HEADLESS-RUNBOOK.md)。

---

## 10. 多节点

代码：`R/src/executor.mjs`（`nodeMode`、`roleProbeMaintenance`）、`R/src/role-probe.mjs`、`R/src/node-duty.mjs`、`R/src/companion-heartbeat.mjs`、`R/src/node-identity.mjs`
档案：DESIGN §23、§29、§30、§41.6、§41.6a

设计按任意多个节点来做（Decision `d6eef30e`）。今天有两个节点：`turing` 和 `desk-w-591`。

### 10.1 节点模式

- 启动或复位后是 UNCERTAIN（行为同 STANDBY），角色探测立即到期。
- 第 11 段只读调用 `clued_work_merge_slot_holders_v1`：
  - held → ACTIVE；
  - not-held → STANDBY；
  - uncertain → 保持原模式。
- 非 ACTIVE 时不开新批次（`NODE_STANDBY` / `NODE_ROLE_UNCERTAIN`），触发照常读进排队表，在途批次照常跑完。
- 探测间隔（[ADR 0025](adr/0025-smooth-handover.md)）：UNCERTAIN 和 STANDBY 每 1 分钟；空闲的 ACTIVE 每 5 分钟（不超过新持有的 5 分钟激活延迟，所以空闲的旧节点总在新节点当班之前转待命）；不确定时 1、2、4、5 分钟退避，不短于本模式间隔；批次以 `NODE_ROLE_NOT_HELD` 等结束时立即探测。
- 每次探测是一次经交换代理的换跑（约 4 秒，写 2 条回执），不是单纯的服务端查询。
- 真正挡住"两个节点同时发布"的是服务端的 ci-admission 角色（每批第 1 段、第 8 段实时核验）。节点模式和 PR 页面上的当班状态都只是提示。

### 10.2 节点身份

安装回执里钉着 `nodeIdentity`（`node-identity.mjs`），只有公开编号和指纹：节点名、App 私钥的 key id 和公钥指纹、ci-admission 连接 id 和 token 指纹、资格 ref。

- 每个节点有自己的 App 私钥。**不要删别的节点的私钥**，删了那个节点会立刻报 `github_http_401`。
- 新装的节点一律是 STANDBY（`roleAssumption=NONE`）。

### 10.3 心跳与自动接班

见 [ADR 0013](adr/0013-multi-node-failover.md)。

- companion 每 1 分钟发心跳（ADR 0025），失败后 30 秒重发，状态变化或本机时钟往回跳时立即补发。上报内容：`ciSourceManifestSha256`、模式、HALTED / PAUSED / INTAKE_PAUSED、服务是否在运行。
- 服务端看门狗（`pg_cron` 每分钟）**只在当班节点失联时**交接，条件包括：
  - 5 分钟没有心跳，或连续 5 分钟报服务没在运行（ADR 0025，迁移 `20261112130500`；以前 30 分钟）；
  - 最近一条自报不是 HALTED、PAUSED 或未到期的暂停接新；
  - 目标是有资格、5 分钟内有心跳、沉默期间至少 2 次心跳、STANDBY 且最近探测为 not-held、健康、Source 全一致的备用节点，按 Owner 定的次序取第一个；
  - 6 小时冷却。
- 交接 5 分钟后生效，写回执 `CI_ADMISSION_AUTO_HANDOVER`。接班节点在算力面板 Issue 里 @Owner。
- 接班节点的 companion 从心跳回答里得知这次自动交接；接班核对不再被别的节点在交接之前写的“当班”挡住（那是已证实沉默的节点的最后一句），交接之后写的照旧上锁（`node-duty.mjs#dutyCut`）。
- 时序：计划内（旧节点空闲）约 5–6 分钟；当班节点失联约 9–12 分钟（`test/handover-timing.test.mjs`）。

### 10.4 Source 一致

24 小时内有心跳的节点 Source 必须相同，否则第 10 段 `TRAIN_SOURCE_MISMATCH`：所有新批次推迟，2 分钟后重核。所以两台按顺序升级时，中间会有一段推迟。做法见 runbook §5.1。

---

## 11. 升级与安装

代码：`R/upgrader/src/`（`machine.mjs`、`plan.mjs`、`grant-client.mjs`、`generations.mjs`）、`R/windows/request-upgrade.ps1`、`R/windows/upgrade-apply.ps1`、`R/rollout/`、`R/reinstall/`、`R/tools/build-package.mjs`、`R/windows/install-resident.ps1`、`R/windows/verify-resident.ps1`
档案：DESIGN §12、§30、§34、§40、§42、§58、§63

### 11.1 三类改动

| 类别 | 改到什么 | 怎么上 | Owner 要做的 |
|---|---|---|---|
| R：冻结通道 | 升级代理自己的文件和它导入的常驻模块、`upgrade-apply.ps1`、Linux 升级工具；目录布局、ACL、账户、SDDL、服务、秘密、节点身份 | 整套重装（`reinstall/`） | Decision + UAC + root + Grant |
| U：原地 | 常驻 `src/*.mjs`、按内容寻址的 `windows\*` 工具、服务宿主和代理的 C#、Source v2（含 Windows C# 和 Linux bundle）、`policy.json`、`companion.json` | 原地升级 | Decision + Grant；Grant 可由自动审批代批 |
| T：工具 | `reinstall/`、`rollout/`、`tools/` 的构建侧 | 下次打包时生效 | 无 |

### 11.2 原地升级

见 [ADR 0014](adr/0014-in-place-upgrade.md)。

1. 打包：`rollout/build-upgrade.ps1`，见 runbook §2。同一输入构建两次，包 sha 必须相同；节点身份不变。
2. 请求：Agent 在 Owner 会话里非提权运行已装的 `request-upgrade.ps1`，只往 `upgrade\inbox\` 新建一个请求文件。
3. 升级代理（`machine.mjs`）依次执行：
   - ACCEPT；
   - 申请 Grant `ci.resident_upgrade`，资源 `ci-resident:<node>/<包 sha>`；
   - 加暂停接新、等批次结束（最多 `DrainMaxMinutes`）、PAUSE；
   - 两侧暂存、停服、切换、启动、校验；
   - 用 `owner\` 下的 `resident-upgrade-resume/1` 解除自己的 PAUSE；
   - 保留 3 代。
4. 失败：停服之后任何一步失败都自动回滚到上一代，结局 `ROLLED_BACK_PAUSED`（保持暂停并通知）。回滚也失败为 `ROLLBACK_FAILED`，需 Owner 提权运行已装副本 `<root>\upgrader\<sha>\windows\upgrade-apply.ps1 -Recover -OpId <opId>`（默认预演，加 `-Apply` 才执行，见 runbook §2.6）。
5. Grant 的批准：
   - 自动审批开关开着时，服务端按高风险规则自动批准，写 `OWNER_GRANT_GIVEN`（principal `owner_auto_approve`）；
   - 当前已上线的迁移是 `20261106100000_resident_upgrade_auto_approve_v1.sql`：**每节点 24 小时自动批一次**，超出转人工；
   - Owner 已决定放宽到每天 6 次（Decision `56371a46`），迁移在 Task `3b4f1f12` 中，等发布批准。
6. 多节点滚动：`rollout/rollout.mjs plan / observe / next`。顺序是先升待命节点、再移交、后升原当班节点，一次只升一个。当班节点不出现在 `UPGRADE` 里；唯一例外是没有可接班节点、Owner 明确同意暂停 CI 时的 `--allow-active-upgrade`。

### 11.3 版本一致

每个 tick 读 `upgrade\current.json`、Linux 版本事实和 `upgrade\status.json`，在 `status.json` 的 `versions` 里显示（`status.mjs`）。

- `consistent === false` 时：
  - 加持有者为 `version-skew` 的暂停接新；
  - 预检全局推迟（`VERSION_SKEW`）；
  - 第一个 Linux 段前兜底拒绝（`UPGRADE_VERSION_SKEW`）。
- 事实超过 15 分钟或读不到时为 `null`，什么都不动。

### 11.4 整套重装

`reinstall/` 工具链：打包 → 非提权只读预演 `rehearse.py`（24 小时内必须得到 `REHEARSAL_PASS`）→ 生成提权启动器和 Linux root 脚本。安装由 `install-resident.ps1 -Apply -ExpectedPlanSha256 <审过的计划>` 完成，1 次 UAC。

安装会做这些事：

- 钉住 Source 清单、常驻层清单、`policy.json`、服务宿主哈希、代理的助手白名单；
- 在节点上编译 C#；
- 迁移 ACL；
- 放置秘密（只新建，从不覆盖）；
- 带入旧 state 供回填。

前提：

- controller 账户有"作为服务登录"权限；
- 没有未终结的批次（`INSTALL_REQUIRES_NO_OPEN_BATCH_REARM_FIRST`）。

校验用已装副本的 `verify-resident.ps1` 和 `verify-resident-linux.sh`。细节见 [`../reinstall/README.md`](../reinstall/README.md)。

---

## 12. 可观察性

代码：`R/src/status.mjs`、`R/src/receipts.mjs`、`R/src/pr-status.mjs`、`R/tools/rearm-tool.mjs`、`R/tools/verify-receipts.mjs`
档案：DESIGN §16.6、§17.6、§29.4、§34

| 来源 | 位置 | 说明 |
|---|---|---|
| 状态快照 | `<root>\state\status.json`（合同 `/7`） | 每 15 秒整体重写。它只是视图，执行器的决定从不读它。字段有 `executor`（state、since、reason）、`current`（正在跑的批次和段）、`pending`（逐行排队视图）、`queue`（代、活行数、停靠满、hold）、`breaker`、`intakePause`、`node`、`train`（enabled、sweepMode、frontReadyMode、last、sweep）、`versions`、`notices`。`writtenAt` 停了说明执行器停了 |
| 回执链 | `<root>\state\receipts\<8 位序号>-<type>.json` | 哈希串起来的审计记录，每条有 `at`；按月封存到 `receipts\archive\`。常用类型：`stage-terminal`、`batch-terminal`、`batch-unexecuted`、`train-run-intent` / `train-run`、`node-mode`、`owner-request*`、`paused`、`intake-*`、`service-start`、`resident-upgraded` |
| 账本 | `<root>\state\ledger\<key>\` | 一批的权威记录 |
| 排队表 | `<root>\state\queue\queue.json` | 每个 PR 一行 |
| PR 页面 | commit status `resident-queue/<node> (info only)` | 当班、停摆码、排第几、停靠原因。不是必需检查 |
| Windows 通知 | Owner 桌面 | HALT、状态超过 5 分钟没更新、熔断、源码不一致、strict 被关等，每个事件键只弹一次 |
| companion 日志 | `%LOCALAPPDATA%\CluedIndependentCI\companion-log\relay-YYYYMMDD.jsonl` | 每次中继尝试、bundle 拒绝。代理账户读不到，只能在 Owner 会话里看 |
| 只读查看 | `rearm-resident.ps1`（不带参数、不提权）→ `rearm-tool.mjs inspect` | HALT 内容和摘要、未终结批次的 `abortTargets`、熔断、暂停接新、升级状态 |

---

## 13. 安全模型与不变量

档案：DESIGN §2、§3.3、§4

**要防的**：Owner 用户会话里的任意进程，包括 Agent 和被利用的工具。它们必须做不到以下任何一件：

- 拿到管理员或 SYSTEM；
- 读到 App 私钥或 ci-admission token；
- 让常驻服务或代理在它们的目录之外写、删、改名；
- 绕过任何门禁；
- 让一个已开始过的 head 再次执行；
- 伪造 Owner 的授权（复位、恢复、Grant）。

**接受的边界**：Owner、root 是受信管理员。WSL root 能从 Owner 用户会话直接拿到，所以 Linux 侧的事实最多和 Owner 会话一样可信。设计只保证两点：

- 事实是 root 工具实测出来的，测不出就算失败；
- companion 只原样转交 root 工具的输出。

| 不变量 | 怎么保证 |
|---|---|
| I1 可信源码变更需要 Owner 接受 | 安装或升级钉住清单；每批开始前重算哈希，有漂移就 HALT；原地升级要 Owner 对精确包哈希的 Grant |
| I2 每个作业最多执行一次 | §5 的四层防重 |
| I3 fail closed | 白名单分类，认不出就 HALT；执行器自己从不重跑出事的 head；自动重试只在能证明没有副作用时做 |
| I4 PR 代码只当数据 | 代码只从管理员专用目录加载；gitleaks、trivy、ws-prep 不执行 PR 内容；contract-placement 在加固容器里跑 PR 测试（既有范围，未扩大） |
| I5 常驻层不读秘密 | 常驻服务、交换代理、companion、Linux unit 都不读 App 私钥和 ci-admission token |
| I6 测什么落什么 | strict 永久开、只留 merge；第 8 段核对试合并树；第 10 段核对落地树 |
| I7 两个节点不同时发布 | 服务端 ci-admission 角色；每批第 1、8 段实时核验 |

---

## 14. 已实现但默认关闭、或只设计未实现的部分

这些部分不属于当前生效的设计，只列出来方便查找。

| 内容 | 状态 | 依据 |
|---|---|---|
| 托管转发（第 R 段，gitleaks、trivy 用 GitHub 托管运行的结果） | 已实现，`relay.enabled=false`，托管工作流已停用 | Decision `928e6638`、规则 `41ab823a`；DESIGN §7.5 |
| `train.sweep = gate`（接管全量清扫挡住一切） | 回退路径，平时不用 | DESIGN §65.5 |
| 车头落后时自动更新分支 | Owner 已决定重新启用合并执行器，只给 BEHIND 的车头做 update-branch，尚未实现 | Decision `78a3052f` 第 2 项 |
| 升级自动审批每节点每天 6 次 | 已决定，迁移等发布 | Decision `56371a46`，Task `3b4f1f12` |
| companion 无登录运行（B2） | 第 29 代已实施，未安装；须整套重装 | Decision `9dc130c7` 第 3 项，Task `59f8ef81`，[ADR 0022](adr/0022-companion-headless-implementation.md) |
| companion 换细粒度 GitHub 令牌 | 第 29 代已实施，未安装；令牌由 Owner 生成并存入 | Decision `9dc130c7` 第 4 项，[ADR 0022](adr/0022-companion-headless-implementation.md) §11 |
| 准入票据（M1） | 不做，设计存档 | Decision `9dc130c7` 第 1 项，[ADR 0009](adr/0009-no-admission-ticket.md) |
| bors 式列车（`train.landing = push`、`batchMax > 1`） | 第 28 代已实现，默认 `github-merge`、1；等 ADR 0010 的触发条件满足、上线前提做完再开 | Task `7d86cf41`，[ADR 0010](adr/0010-bors-preauthorized.md)、[0018](adr/0018-bors-landing.md)、[0019](adr/0019-train-batch-member-chain.md) |
| 备用节点预检（L3） | 评估后不做 | [ADR 0020](adr/0020-standby-prechecks-not-implemented.md) |
| 三个扫描并行 | 分析结论：常驻层做不到，需要 Source 级多角色扫描段 | DESIGN §45 |
| 写后失败撤回后重发（方案 A） | 不建议做 | DESIGN §50 |

---

## 15. 代码索引

| 关注点 | 常驻层 `R/` | Source v2 `CI/` |
|---|---|---|
| 服务入口与 tick | `src/service-main.mjs`、`src/executor.mjs#tickInner` | — |
| 策略 | `src/policy.mjs`、`config/policy.v10.example.json` | — |
| 账本与烧号 | `src/ledger.mjs`、`src/executed-heads.mjs` | `effect-journal.mjs`、`job-v2.mjs` |
| 排队与熔断 | `src/queue.mjs`、`src/breaker.mjs` | — |
| 段的调用 | `src/engine-windows.mjs` | `resident-v2/invoke-stage.mjs`、`derive-batch.mjs`、`stage-fact.mjs` |
| 失败分类 | `src/classify.mjs`、`src/failure-table.json`、`src/attempts.mjs` | `resident-v2/stage-fact.mjs` |
| 归档 | `src/archive.mjs`、`linux/bin/clued-ci-resident-linux` | `resident-v2/archive-windows-spool.ps1` |
| 第 1 段 | — | `formal-work-admission-check-v2/`、`full-admission-v2.mjs` |
| 扫描与发布 | — | `worker-v2.mjs`、`staged-check-publisher-v2.mjs`、`resident-v2/` 下的 bridge |
| 第 8 段 | — | `independent-control-checks-v2/publisher.mjs`、`train-rules.mjs`、`green-ledger.mjs`、`claim-assist-native.mjs` |
| 列车 | `src/train.mjs`、`src/executor.mjs` | `independent-control-checks-v2/train-*.mjs`、`resident-v2/train-run.mjs` |
| 节点 | `src/role-probe.mjs`、`src/node-identity.mjs`、`src/node-duty.mjs`、`src/companion-heartbeat.mjs` | — |
| companion | `src/companion*.mjs`、`src/poller.mjs`、`src/pr-status.mjs`、`src/runner.mjs`、`windows/CompanionJobHost.cs` | — |
| Owner 请求 | `windows/rearm-resident.ps1`、`tools/rearm-tool.mjs`、`src/intake-pause.mjs`、`src/resident-requests.mjs` | — |
| 升级 | `upgrader/src/`、`windows/request-upgrade.ps1`、`windows/upgrade-apply.ps1`、`rollout/`、`src/upgrade-mailbox.mjs` | — |
| 安装 | `windows/install-resident.ps1`、`windows/verify-resident.ps1`、`linux/*.sh`、`tools/build-package.mjs`、`reinstall/` | `resident-v2/prepare-record.mjs` |
| 状态与回执 | `src/status.mjs`、`src/receipts.mjs`、`tools/verify-receipts.mjs` | — |
