# 术语表

本文收常驻 CI 的专门词汇。每条给出一句定义，以及最常见的代码位置或文档章节。

- 当前架构：[architecture.md](architecture.md)
- 运维手册：[runbook.md](runbook.md)
- 决定记录：[adr/](adr/)

路径约定：
- `R/` 指常驻层 `work/independent-ci-resident-v1/`；
- `CI/` 指 Source v2 `work/actions-hosted-migration/independent-ci-v1/`；
- `<root>` 指节点上的 `C:\ProgramData\CluedIndependentCI\resident`。

## 提交与批次

| 术语 | 定义 | 代码 / 章节 |
|---|---|---|
| **H** | PR 的 head 提交，也就是作者推上去的那个提交。 | `ledger.mjs#batchKey` |
| **T** | 批次测的 main 尖端（作业的 base）。 | 同上 |
| **S** | 测试提交（`testSha`）。普通批次 S = H；车头批次的 S 是 GitHub 的试合并提交，父提交恰好是 [T, H]。S 只能由第 10 段的 `OPEN_FRONT_BATCH` 产生，触发文件不能带 S。 | `queue.mjs#offerFront`，architecture §7.2 |
| **触发记录** | inbox 里的一条数据，内容是 `{repo, pr, headSha, baseSha[, prUpdatedAt]}`，意思只是"请看看这个 head"。它不带路径、命令、claim 或包。 | `trigger.mjs`，合同 `resident-trigger/2` |
| **批次（batch）** | 对一个 (repo, PR, H, T, S, Source, attempt) 的一次预留。它从 `00-reserved` 开始，到 `90-terminal` 结束。 | `ledger.mjs` |
| **批次键（batch key）** | 上面那组字段的摘要，也是账本目录 `state\ledger\<key>\` 的名字。 | `ledger.mjs#batchKey` |
| **作业（job）/ 作业 id** | 一个角色在一个批次里的一次执行。id = sha256(`job/3`, repo, pr, H, T, S, Source, role, attempt)，不含 claim。 | `CI/src/job-v2.mjs` |
| **attempt / attempt 2** | 作业身份的一部分，默认是 1。attempt 2 是同一 head 唯一一次自动重试，只在第 1 段、工作区准备或第 2 段（都在发布之前）干净的暂时失败之后才有，没有 attempt 3。 | `attempts.mjs`，[ADR 0003](adr/0003-execute-once.md) |
| **第 N 段** | 批次里固定编号的一步，见下表。 | `policy.mjs#FIXED_STAGES` |

段号一览：

| 段 | 内容 | 谁运行 |
|---|---|---|
| 0 | companion 打 bundle（用 Owner 的读凭据） | companion |
| 1 | Native 工作准入，发布 `kooyumi-work-admission` | 交换代理 → 通用助手（clued-control） |
| 2 / 4 / 6 | gitleaks / trivy / contract-placement 的扫描执行。入口是 `scanner-issuer`，在 WSL 里由 worker unit 运行 | 同上 + companion 泵 + Linux unit |
| 3 / 5 / 7 | 上面三项各自的发布段（`check-publisher`） | 交换代理 → 通用助手 |
| 8 | 控制检查对：`kooyumi-admission-verified` 和 `kooyumi-merge-slot`，也就是合并位的绿 | 同上 |
| R（9） | 托管转发。已实现，策略默认关 | 同上 |
| 10 | 列车维护（train-maintenance）：决定车头、撤绿、清扫。批次之外运行 | 同上 |
| 11 | 角色探测（role-probe）：本节点此刻是否持有 ci-admission。批次之外运行 | 同上 |
| 12 | 撤销维护（revocation-maintenance）。批次之外运行 | 同上 |

## 一次性与烧号

| 术语 | 定义 | 代码 / 章节 |
|---|---|---|
| **烧号 / 烧头（burn）** | 在 `state\ledger-heads\` 里 CreateNew 一条 head 记录。从此这个 (repo, H, Source, attempt[, S]) 永不再开始，要再跑只能推新提交。 | `ledger.mjs#headKey` |
| **已执行记录（executed heads）** | 与 Source 无关的"这个 head 可能已经发布过检查"的记录，换 Source 也照样挡住。 | `executed-heads.mjs` |
| **释放（release）** | 批次没真正执行就结束，不烧号，排回队列。只允许发生在 `10-started` 之前，而且要有 Source 给出的 `safeToRerun`，或者交换代理明确说"没启动"。 | `classify.mjs#decideFailure` |
| **K(head, role)** | 发布层的最后一道防重：同一 head 上同一角色只有一个发布者，跨批次、跨 attempt 都成立。 | `CI/src/staged-check-publisher-v2.mjs` |
| **effect journal** | 发布的幂等日志。它永不归档，所以"只发布一次"跨批次也成立。 | `state\v2\effects-*` |

## 失败与停机

| 术语 | 定义 | 代码 / 章节 |
|---|---|---|
| **NOT_ADMITTED / CLEAN / UNKNOWN** | 失败的三类：<br>- NOT_ADMITTED：第 1 段未准入，释放；<br>- CLEAN：白名单码，且两端都证明已静止，归档后继续；<br>- UNKNOWN：其余一切，烧号，HALT。 | `classify.mjs` |
| **失败对照表** | 机器可读的表，按（段、码、原因、诊断）给出类别、处置（release / release-if-safe / burn / halt）、重试规则和熔断输入。 | `src/failure-table.json` |
| **静止证明（quiescence）** | 失败时从两端现取的清理事实，不沿用阶段的自报：<br>- Windows：runner 回到原始二进制且已停，作业树为 0；<br>- Linux：unit 全部 inactive，cgroup 空，容器已退出，没有残留进程。 | `executor.mjs#proofFor` |
| **HALT** | 只升不降的停机锁，只有 Owner 复位能清除。只要还有未归档的未知现场，就保持 HALT。 | `state\HALT.json`，`ledger.mjs` |
| **复位（Rearm）** | Owner 提权写请求。服务实测两端静止，把所有未归档的未知现场只改名归档，再按比较交换清除 HALT。 | `rearm-resident.ps1 -Request Rearm` |
| **暂停（PAUSE）** | 急停，批次之间生效。任何 Owner 会话进程都能发，只有提权的 Owner 能恢复（Resume）。 | `state\PAUSED.json` |
| **暂停接新（intake pause）** | 只是不开新批次，在跑的和停靠的批次照常。最长 2 小时自动失效。按持有者（holder）区分，例如 `owner`、`dual-active`、`version-skew`。 | `intake-pause.mjs` |
| **中止（Abort）** | Owner 在安全点结束一个批次，干净时记 `FAILED_CLEAN OWNER_ABORTED`。 | `rearm-resident.ps1 -Request Abort` |
| **排空（Drain）** | Owner 一次结束所有停靠批次，一般在重装之前做。 | `rearm-tool.mjs request-drain` |
| **熔断（breaker）** | 批次失败计数器：连续 3 次，或 1 小时内 4 次计入的失败，就打开，打开后不开新批次，按退避放一批试跑。 | `breaker.mjs` |
| **ReleaseBreaker** | Owner 提前放行熔断试跑。它不关闭熔断器。 | `rearm-resident.ps1 -Request ReleaseBreaker` |
| **安全点 P0 / P1 / P2** | 中止允许生效的时机：<br>- P0：tick 开始；<br>- P1：每一步开始前；<br>- P2：第 2/4/6 段运行中。 | `executor.mjs` |
| **现场（scene）** | 失败批次留在两端、还没归档的协议记录和工作区。 | `ledger.mjs#unarchivedScenes` |

## 排队与停靠

| 术语 | 定义 | 代码 / 章节 |
|---|---|---|
| **排队表** | 执行器自己的队列 `state\queue\queue.json`，每个 PR 一行。它只决定"下一个试谁"，能不能跑以账本为准。 | `queue.mjs` |
| **取代（supersede）** | 同一 PR 来了新提交：<br>- 还在等的旧提交直接被替换；<br>- 正在跑的批次在安全点以 `SUPERSEDED_AT_SAFE_POINT` 结束。 | `executor.mjs` |
| **停靠点 A（停车点 A）** | 第 1 段（和托管等待）之后、工作区准备之前。记录是 `15-relay-wait.json`。只有托管转发打开时才会真正停在这里。 | architecture §6.3 |
| **停靠点 B（停车点 B）** | 第 1–7 段跑完、两端收尾归档之后、第 8 段之前。记录是 `70-parked.json`。批次在这里按"尝试"反复跑第 8 段，直到拿到合并位的绿或结束。 | architecture §6.3 |
| **尝试（try）** | 停在 B 的批次跑一次第 8 段。先写 `71-try-NN.json`，没就绪时写 `72-tried-NN.json`。 | `executor.mjs#stage8Try` |
| **独占区** | 从工作区准备到最后一个 Linux 段和收尾归档结束。这段时间里不插入别的批次的段。 | architecture §6.3 |
| **排队观察（queue watch）** | 空闲时读一次合并队列。停在 B 的批次一到队首，就提前尝试第 8 段。 | `executor.mjs#queueWatchMaintenance` |

## 合并列车

| 术语 | 定义 | 代码 / 章节 |
|---|---|---|
| **合并列车（train）** | 由常驻 CI 决定"下一个合进 main 的是谁"，只给它发合并位的绿。`train.enabled` 取 `off` / `shadow` / `on`。 | `train.mjs`，`CI/.../train-maintenance.mjs` |
| **车头（front）** | KooYomi 合并队列第 1 位的认领绑定的 PR 和它当前的 head。同一时刻只有车头能拿到 `kooyumi-merge-slot` 绿。 | architecture §7 |
| **车头批次（front batch）** | 测 S（S ≠ H）的批次。head 键按 (H, S) 计算，每个 head 最多两次。 | `FRONT_BATCHES_PER_HEAD` |
| **绑定批次 / 让位** | 队首 PR 的普通批次第 1 段完成认领绑定后，以 `TRAIN_FRONT_CLAIM_BOUND` 结束（释放，不烧号），把位置让给车头批次。 | `executor.mjs#trainFrontYield` |
| **单绿** | 任意时刻只有车头的当前 head 有合并位的绿。strict 永久开以后，它不再是"落地的树等于测过的树"的前提（[ADR 0007](adr/0007-strict-permanent.md)）。 | |
| **撤绿** | 按 check run id 把一条合并位的绿改成 failure，两次读回确认后才记 `revoked`。 | `train-maintenance.mjs` |
| **清扫（sweep）** | 找出并撤掉不该存在的绿：<br>- 增量清扫：每次第 10 段都做；<br>- 全量清扫：枚举所有 PR，分 `scope current` 和 `scope all`；<br>- 在 `train.sweep=audit` 下，全量清扫每天最多一轮，只作后台审计。 | `train-sweep.mjs` |
| **`train.sweep`** | 取值 `gate` / `audit` / `off`，默认 `audit`：<br>- `audit`：strict 永久开，全量清扫不挡任何事；<br>- `off`：同 `audit`，但不跑全量；<br>- `gate`：回退路径，接管全量清扫挡住一切普通批次。 | `policy.mjs#TRAIN_SWEEP_DEFAULT` |
| **strict** | GitHub 规则集里的 `strict_required_status_checks_policy`，即"分支必须是最新的"。按 Owner 决定 `9e2511fe` 永久开。 | [ADR 0007](adr/0007-strict-permanent.md) |
| **strict-front 观察 / 证明** | 第 10 段写下的"当前车头可以发绿"的观察（合同 `train-strict-front-readiness/1`），有效期 `sweepFreshMs`（15 分钟）。第 8 段写前写后都会复核它。 | `strictFrontHeadDecision` |
| **frontProofShort** | 车头批次在第 8 段之前，如果证明剩余有效期不足 3 分钟（`FRONT_PROOF_MARGIN_MS`），先跑一次第 10 段刷新。 | `executor.mjs` |
| **接管（takeover）** | 一个节点开始担任 on 模式职责（改成 on、或从 STANDBY 转 ACTIVE）。在 `audit` 下，接管门从职责一开始就开着，只有 main 被改写时才关。 | `trainTakeoverDone` |
| **onSince** | 本节点这一段 on 模式职责开始的时刻。它记在回执 `train-duty` 里，重启后照旧。 | `executor.mjs` |
| **trainUrgent** | 让下一次第 10 段立即到期的内存标志。证明过期、绑定结束、暂停解除后的首轮都会设它。 | `executor.mjs` |
| **只撤模式（revoke-only）** | PAUSE 或暂停接新期间，第 10 段只撤绿、不开批次。 | `train.mjs#RUN_MODES` |
| **合并位（merge slot）/ 合并队位** | KooYomi 合并队列里车头的位子：<br>- running：车头批次在跑，时钟最长 90 分钟；<br>- green：第 8 段发了绿，服务端给 30 分钟合并时间；<br>- failed：车头批次最终失败。 | `clued_work_merge_slot_*_v1` |
| **保活（keepalive）** | 服务端延长排队认领的租约，不越过 24 小时硬截止。 | `clued_work_merge_queue_keepalive_v1` |
| **守队程序** | `.github` 里的合并执行工作流。列车模式下只合车头，只用 merge 方式。 | `scripts/ci/clued-merge-executor.mjs` |
| **bors 式** | 让列车自己把测过的合并提交快进推上 main，支持批量测试、失败二分和并行预测。Owner 已预授权，等触发条件满足再做。 | [ADR 0010](adr/0010-bors-preauthorized.md) |

## 节点

| 术语 | 定义 | 代码 / 章节 |
|---|---|---|
| **节点** | 装了一套常驻 CI 的一台 Windows 机器加它的 WSL，例如 `turing`、`desk-w-591`。设计按任意多个节点来做（Decision `d6eef30e`）。 | `node-profile.mjs` |
| **当班 / 备用（ACTIVE / STANDBY）** | 节点模式：<br>- ACTIVE：当班，此刻持有服务端的 ci-admission 角色；<br>- STANDBY：备用，不开新批次；<br>- UNCERTAIN：刚启动或复位后还没确认，行为同 STANDBY。<br>角色在服务端，不在安装里。 | `executor.mjs#nodeMode`，`role-probe.mjs` |
| **角色探测** | 第 11 段只读调用 `clued_work_merge_slot_holders_v1`，判断本节点 held / not-held / uncertain。 | `role-probe.mjs` |
| **NODE_ROLE_NOT_HELD** | 第 1 段因为本节点不当班而被拒。释放，节点转 STANDBY。 | `failure-table.json` |
| **心跳** | companion 每 1 分钟用本节点专用的"只能发心跳"令牌上报自身状态，供服务端看门狗判断失联（3 分钟没有心跳算失联，ADR 0025）。 | `companion-heartbeat.mjs` |
| **自动接班** | 服务端看门狗只在当班节点失联时，把 ci-admission 交给一个健康的、Source 一致的备用节点（Decision `199cf3de`）。HALT 不会触发自动接班。 | [ADR 0013](adr/0013-multi-node-failover.md) |
| **双活停机** | PR 页面上看到别的节点也在当班时，本节点写持有者为 `dual-active` 的暂停接新。 | `node-duty.mjs` |
| **源码不一致** | 24 小时内发过心跳的节点里，有节点跑的 `ciSourceManifestSha256` 不同。第 10 段报 `TRAIN_SOURCE_MISMATCH`，所有新批次推迟，2 分钟后重核。 | `train.mjs#TRAIN_RECHECK_MS` |
| **版本不一致（version skew）** | 本节点 Windows 和 Linux 两侧装的代或 Source 不同。执行器加持有者为 `version-skew` 的暂停接新，第一个 Linux 段也会拒绝。 | `status.mjs#versions` |

## 安装与升级

| 术语 | 定义 | 代码 / 章节 |
|---|---|---|
| **Source v2 / CI Source** | 批次实际执行的那套可信代码（`CI/src/`），按清单钉住安装在 `<root>\source\<ciSourceManifestSha256>\`。 | |
| **常驻层（resident layer）** | `R/src`、`R/windows` 等，安装在 `<root>\resident\<residentManifestSha256>\`。 | |
| **`sourceManifestSha256` / `ciSourceManifestSha256`** | 两个不同的哈希：<br>- 前者是已安装文件清单的哈希，用于完整性校验；<br>- 后者是安装记录的哈希，同时是作业身份里的 Source 和 Source 目录名。 | `policy.mjs` |
| **代 / 第 N 代（generation）** | 有两种用法：<br>- 代码代际：一次发布的常驻层加 Source 组合，例如"第 22 代"；<br>- 升级通道代数：`upgrade\current.json` 的 `generation`，每次原地升级加 1。<br>两者不是同一个数。 | |
| **原地升级** | 节点上已装的升级代理（`CluedCIUpgrader`）按 Owner 对精确包哈希的批准，暂存、切换、校验新的一代，失败自动回滚。 | `upgrader/src/machine.mjs`，[ADR 0014](adr/0014-in-place-upgrade.md) |
| **整套重装** | 卸载再安装，要一次 UAC 加 root。只有改到冻结的升级通道时才需要。 | `reinstall/` |
| **冻结模块** | 升级代理自己的文件和它导入的常驻模块。改它们就不能原地升级（`UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL`）。 | `upgrader/src/plan.mjs` |
| **Grant** | Owner 在 KooYomi 页面对一个精确资源的一次性批准，例如 `ci.resident_upgrade`、`repo.protected_change`。可以由 Owner 的自动审批开关代批。 | |
| **装包 / 打包** | 用 `rollout/build-upgrade.ps1`（原地升级）或 `reinstall/build.ps1`（重装）构建一代包。 | runbook §2 |
| **shadow / on** | `train.enabled` 的取值：<br>- shadow：第 10 段只读记录"如果开车会做什么"；<br>- on：真正开车。 | |

## 通道与身份

| 术语 | 定义 | 代码 / 章节 |
|---|---|---|
| **常驻执行器** | `NT SERVICE\CluedCIResident` 服务里的 node 进程，负责一切调度决定。它不联网，不读秘密。 | `service-main.mjs`，`executor.mjs` |
| **交换代理（swap broker）** | LocalSystem 服务 `CluedCISwapBroker`，只做一件事：把 runner 服务换到通用助手，启动一次，再换回原始二进制。 | `windows/SwapBroker.cs` |
| **通用助手** | `helpers\controller-formal-generic-v2.exe`，以 `.\clued-control` 身份运行一段的入口。它读秘密，并做所有实时核验与发布。 | `CI/src/resident-v2/` |
| **companion（伴随进程）** | Owner 登录会话里的非提权计划任务，负责：<br>- WSL 保活、打 bundle、搬运 bridge 记录（泵）；<br>- 轮询 PR、写 PR 页面状态；<br>- 发心跳；<br>- 跑升级信箱等。<br>它只是运输者，从不做授权判断。 | `companion.mjs`，`companion-main.mjs` |
| **泵（pump）** | companion 在第 2/4/6 段中，在 Windows 和 Linux 的 formal-spool 之间搬运 issue / challenge / response / result 记录，并启动 worker unit。 | `companion.mjs` |
| **信箱（mailbox）** | 执行器和 companion 之间的只新建文件通道，路径是 `<root>\mailbox\requests\` 和 `responses\`。 | `mailbox.mjs` |
| **owner 目录** | `<root>\owner\`，只有 Administrators 能建文件。复位、恢复、中止、排空、放行熔断这些请求只认这里。写进 `requests\` 的同类请求会被拒绝。 | `inbox.mjs#OwnerInbox` |
| **requests 目录** | `<root>\requests\`，任何 Owner 会话进程都能新建文件，只收"只能让系统更保守"的请求：暂停、暂停接新、立即探测、撤车头。 | `executor.mjs#takePauseRequests` |
| **回执链（receipts）** | `state\receipts\` 下按序号哈希串起来的审计记录。每个月封存一次。 | `receipts.mjs` |
| **status.json** | 执行器状态快照（合同 `/7`），每 15 秒整体重写。它只是视图，执行器的任何决定都不读它。 | `status.mjs` |
| **App 5368905** | `clued-ci-checks-turing-20261018`，发布六项必需检查和控制检查的 GitHub App，只有 `checks: write`。 | |
| **App 5164952** | clued-admission App，有 `contents: write`，合并执行器用它做 update-branch。 | |
