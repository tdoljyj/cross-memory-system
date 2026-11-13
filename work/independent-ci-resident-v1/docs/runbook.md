# 常驻独立 CI · 运维手册

- 基线：`c933238b5`。机制见 [architecture.md](architecture.md)，术语见 [glossary.md](glossary.md)。
- 节点上的根目录记作 `<root>`，即 `C:\ProgramData\CluedIndependentCI\resident`。
- 已装常驻层目录记作 `<res>`，即 `<root>\resident\<residentManifestSha256>`，哈希可在 `<root>\install\install-receipt.json` 查到。

## 0. 先记住的六条

1. **Owner 请求一律走 `owner\` 目录。**
   - 复位（Rearm）、恢复（Resume）、中止（Abort）、排空（Drain）、放行熔断（ReleaseBreaker）只认提权写进 `<root>\owner\` 的请求。
   - 写进 `requests\` 的同类请求会被拒（`rejected`），什么都不发生。
   - 正确的写法只有两种：已装的 `rearm-resident.ps1 -Request …`（提权），或已装的 `rearm-tool.mjs request-…`（提权）。
2. **只运行已装副本。** `rearm-resident.ps1` 不在 `<root>\resident\` 下运行会直接报 `RUN_THE_INSTALLED_COPY`。
3. **查看不提权，请求要提权。**
   - 不带 `-Request` 运行时，脚本拒绝提权（`INSPECT_RUNS_NOT_ELEVATED`）；
   - 带 `-Request` 运行时必须提权（`ELEVATED_OWNER_TOKEN_REQUIRED`）。
4. **摘要要现查现用。** 每个请求都带 Owner 审过的那份 HALT、PAUSE 或账本记录的摘要。中间状态一变，请求就因摘要过期被拒，要重新查看、重新请求。
5. **两台节点必须跑同一个 Source。** 按"先装 shadow 或待命节点 → 核对两台一致 → 再装当班节点"的顺序装（§5.1）。
6. **Owner 只负责授权。** 启动、运行、观察、记录都由 Agent 做（Decision `830e9178`）。需要 UAC 时，Agent 准备好确切命令，Owner 只点批准。

---

## 1. 日常查看

### 1.1 一条命令看全貌（不提权）

```powershell
powershell.exe -NoProfile -NonInteractive -File <res>\windows\rearm-resident.ps1
```

它调用 `rearm-tool.mjs inspect`，什么都不写。输出包括：

- HALT 内容和 `haltSha256`；
- PAUSE 内容和 `pausedSha256`；
- 每个未终结批次的 `abortTargets`：批次键、最新账本记录名、摘要；
- 熔断（`breaker`）、暂停接新（`intakePause`）、升级通道（`upgrade`）；
- 回执链头。

### 1.2 状态快照

`<root>\state\status.json`（合同 `/7`）只是视图，可以随便读：

| 字段 | 看什么 |
|---|---|
| `writtenAt` | 15 秒内应该在动。停了说明执行器停了 |
| `executor.state` / `executor.reason` | IDLE、RUNNING、PARKED、DEFERRED（原因如 `INTAKE_PAUSED`、`PARKING_FULL`、`NODE_STANDBY`、`TRAIN_SOURCE_MISMATCH`）、PAUSED、HALTED |
| `current`（顶层） | 正在跑的批次：pr、headSha、attempt、stage、since |
| `queue` / `pending` | `queue` 是代、活行数、停靠满、hold；逐行视图在顶层 `pending` |
| `node.mode` / `node.source` | ACTIVE / STANDBY / UNCERTAIN；已装 Source 的前 12 位 |
| `train.enabled` / `sweepMode` / `last.decision` / `frontReadyMode` | 列车模式；第 10 段最近的决定 |
| `versions.consistent` | 两侧版本是否一致 |
| `notices` | 当前提示 |

### 1.3 回执与账本

- 回执：`<root>\state\receipts\<8 位序号>-<type>.json`，每条有 `at` 和 `body`。
- 校验整条链（只读）：

  ```powershell
  <root>\runtime\node.exe <res>\tools\verify-receipts.mjs <root>\state\receipts
  ```

- 一批的权威记录：`<root>\state\ledger\<key>\`。
- 排队表：`<root>\state\queue\queue.json`。
- companion 的中继和 bundle 原因：`%LOCALAPPDATA%\CluedIndependentCI\companion-log\relay-YYYYMMDD.jsonl`，只能在 Owner 会话里看。

### 1.4 PR 页面

commit status `resident-queue/<node> (info only)` 显示当班、停摆码、排第几、停靠原因。它不是必需检查，只是提示。

---

## 2. 装包与升级

### 2.1 先判断类别

看 `git diff --name-only <已装提交>..<新提交>`（见 [`../rollout/INSTALL-BATCHES.md`](../rollout/INSTALL-BATCHES.md)）：

| 改到的文件 | 类别 | 做法 |
|---|---|---|
| `upgrader/src/*`、`windows/upgrade-apply.ps1`、`windows/UpgraderServiceHost.cs`、Linux 升级工具，**以及升级代理导入的常驻模块**（按导入闭包计，当前是 `src/canonical.mjs`、`inbox.mjs`、`instance-lock.mjs`、`intake-pause.mjs`、`store.mjs`、`upgrade-mailbox.mjs`）；ACL、账户、目录布局、秘密、节点身份 | R | 整套重装（[`../reinstall/README.md`](../reinstall/README.md)），要 UAC 加 root |
| 其余常驻 `src/*.mjs`、`windows/` 下其他文件、Source v2、`policy.json`、`companion.json` | U | 原地升级（下面 2.2–2.5） |
| 只改 `reinstall/`、`rollout/`、`tools/` | T | 不用装 |

改了 Source v2 Windows C# 或升级通道时，先在本机以 LocalSystem 跑一次 `windows/test-upgrade-system.ps1`（一次 UAC）。

### 2.2 打包（Agent，不提权）

先把提交推到 GitHub 分支。`-Final` 会核对提交在远端（`SOURCE_COMMIT_NOT_ON_GITHUB_PUSH_THE_BRANCH_FIRST`）。

```powershell
# 草稿（占位 Decision）
powershell -NoProfile -File rollout\build-upgrade.ps1 -Config reinstall\config\<node>.json -Commit <40hex> -InstalledPackage <现装包目录>
# 正式
powershell -NoProfile -File rollout\build-upgrade.ps1 -Config reinstall\config\<node>.json -Commit <40hex> -InstalledPackage <现装包目录> -Final -DecisionRef <uuid> -ReceiptRef <uuid> -Tag <t>
```

- `-Config`：节点本机从已装状态生成的配置（`rollout/fleet/install.mjs`）；仓库里没有任何节点的配置或档案。
- `-InstalledPackage` 必须是节点现在跑的包：它的清单哈希要等于 `upgrade\current.json` 的 `packageManifestSha256`。
- 同一输入构建两次，包 sha 必须相同；节点身份和节点档案不能变。
- 输出一行 JSON：包目录、包 sha、`grantResource`、预检结论，以及 request 命令。
- 角色副本优先用 companion 写的 `upgrade\mailbox\responses\roles-public.json`（DESIGN §63），不用 UAC 导出。
  - 报 `ROLES_PUBLIC_COPY_MISSING` 或 `_OTHER_GENERATION` 时回退到配置里的 `linux.installedRoles`；
  - 回退也不行时，按旧流程导出一次。
- 失败后用同一个 `-Tag` 重跑即可：上一次失败留下的输出会被自动改名放到 `failed-attempts\`。只有已经完成过（产生了 precheck 文件）的尝试才要换 `-Tag`，否则报 `ATTEMPT_ALREADY_COMPLETE_USE_ANOTHER_TAG`。

### 2.3 预检（不提权）

```powershell
node rollout\precheck.mjs --root C:\ProgramData\CluedIndependentCI\resident --package <包目录> --package-sha <hex> --acceptance <uuid> --installed-package <现装包目录>
```

| 结论 | 含义 |
|---|---|
| `PRECHECK_PASS` | 可以请求 |
| `PRECHECK_PASS_EXCEPT_UNREADABLE_SLOTS` | 只有非提权读不到的槽没核对，可以请求 |
| `PRECHECK_REFUSED` | 先看 `code`：升级代理的 ACCEPT 拒绝了这个包（节点身份、stateCompat、接受 ref 等），按码修正后重新打包 |
| `PRECHECK_REFUSED`，`code` 为 `UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL` | 改到了冻结文件（看 `changedFrozenFiles`），只能整套重装 |
| `warnings` | 进行中的 op、HALT、两侧不一致、本节点当班（要先移交）。这些会变，只是提醒 |

### 2.4 请求与批准

1. Agent 在 Owner 会话里**非提权**运行已装的脚本：

   ```powershell
   powershell -NoProfile -File <res>\windows\request-upgrade.ps1 -PackageRoot <包目录> -ExpectedPackageManifestSha256 <hex> -AcceptanceDecisionRef <uuid> [-DrainMaxMinutes 10..120] [-Note <text>]
   ```

   取消（只在升级代理还没暂存之前有效）：

   ```powershell
   request-upgrade.ps1 -Cancel -RequestId <uuid>
   ```

2. 批准：
   - Owner 的自动审批开关开着时，服务端自动批。当前规则是**每节点 24 小时一次**，Decision `56371a46` 已决定放宽到每天 6 次，等迁移发布（Task `3b4f1f12`）；
   - 超出次数或开关关闭时，Owner 打开 `<root>\upgrade\status.json` 里的 `confirmUrl` 批准一次。
3. 观察：`<root>\upgrade\status.json` 的 `op.state`、`phase`、`code`，或者 1.1 的 inspect。

### 2.5 多节点滚动

```powershell
node rollout\rollout.mjs plan    --out rollout.json --decision <uuid> --package <node>=<dir> [--package <node>=<dir> ...]
node rollout\rollout.mjs observe --root C:\ProgramData\CluedIndependentCI\resident --out observation.<node>.json   # 每个节点各跑一次
node rollout\rollout.mjs next    --plan rollout.json --observation observation.<node>.json [...]
```

`next` 每次只给一个下一步：

| 结果 | 怎么做 |
|---|---|
| `UPGRADE <node>` | 按 2.4 请求 |
| `HANDOVER <from> → <to>` | Owner 在 `/bindings` 一键移交，5 分钟后生效。之后带 `--handover-issued-at <ISO>` 再调 `next` |
| `WAIT` | 过一会儿重新 observe |
| `BLOCKED` | 报告 Owner：回滚、被拒、HALT、两个当班等。处理完后用 `--ack-op <opId>` 确认 |
| `DONE` | 完成 |

当班节点不出现在 `UPGRADE` 里，顺序是：先升待命节点 → 移交 → 再升原当班节点。唯一例外：没有可接班的节点，且 Owner 明确同意暂停 CI 时，协调者加 `--allow-active-upgrade`，结果带 `ciPause: true`。

### 2.6 升级失败

| 结局 | 节点状态 | 处理 |
|---|---|---|
| `REFUSED` / `GRANT_REJECTED` / `GRANT_EXPIRED` | 不变 | 看 `code`，修好后重新打包请求 |
| `DEFERRED` | 不变 | 正在排空或有 HALT。Grant 之后 24 小时内会自动重试 |
| `ROLLED_BACK_PAUSED` | 回到上一代，**保持暂停** | 查原因；修好后重新升级。或者确认上一代可以继续用，就用 `Resume` 解除暂停（§3.3） |
| `ROLLBACK_FAILED` | 停止或暂停 | Owner 提权运行**已装副本** `<root>\upgrader\<sha>\windows\upgrade-apply.ps1 -Recover -OpId <opId>`：不带 `-Apply` 只是预演，看过输出再加 `-Apply`。它停掉升级代理、常驻服务和交换代理，把两个服务和 companion 任务指回 `upgrade\current.json` 所说的那一代，什么都不启动；服务保持暂停，记录在 `upgrade\ops\<opId>\recover-<UTC>.json`。之后协调者 `--ack-op` |

### 2.7 装完之后的核对

1. 运行已装的 `verify-resident.ps1`。只是 unreadable 时会报 `RESIDENT_PARTIALLY_VERIFIED_RUN_ELEVATED`，提权再跑一次。
2. 检查 `status.json`：
   - `versions.consistent = true`；
   - `node.source` 是新 Source；
   - `writtenAt` 在动。
3. 两台节点都装完后，确认两边 `node.source` 相同（§5.1）。
4. 列车 on 的节点：等第一次第 10 段，`train.last.decision` 不应是 `TRAIN_SOURCE_MISMATCH`。

---

## 3. Owner 请求

下面所有命令都运行**已装副本**，写进 `<root>\owner\`，一次只新建一个文件。服务在下一个 tick 处理，结果写进回执：成功是 `owner-request`，拒绝是 `owner-request-refused`，重复是 `owner-request-duplicate`。

### 3.1 查看（不提权）

```powershell
powershell.exe -NoProfile -NonInteractive -File <res>\windows\rearm-resident.ps1
```

记下要用的摘要：`haltSha256`、`pausedSha256`，以及 `abortTargets` 里的 `batchKey` 和 `ledgerEntrySha256`。

### 3.2 复位（HALT 之后）

```powershell
# 提权
powershell.exe -NoProfile -NonInteractive -File <res>\windows\rearm-resident.ps1 -Request Rearm -ExpectedHaltSha256 <haltSha256> -Reason "<原因>"
```

服务的处理：

1. 实测两端静止；
2. 把所有未归档的未知失败现场和隔离条目只改名归档；
3. 按比较交换清除 HALT。

出事的 head 保持烧号，要再跑只能推新提交。

| 拒绝情形 | 怎么办 |
|---|---|
| 静止证明不成立 | 看回执里哪一端没静止：Windows 侧助手没停，或 Linux 侧 unit 或容器还在。等它结束后重新请求 |
| 摘要过期（HALT 内容变了） | 重新查看，用新摘要再请求 |
| `REARM_REQUIRES_QUARANTINE_ARCHIVED` | 有隔离现场还没归档。复位请求会一并归档，重试即可 |

### 3.3 恢复（PAUSE 之后）

```powershell
# 提权
powershell.exe -NoProfile -NonInteractive -File <res>\windows\rearm-resident.ps1 -Request Resume -ExpectedPausedSha256 <pausedSha256>
```

恢复之前，先弄清是谁写的 PAUSE：看 `PAUSED.json` 的 `reason`，以及回执 `paused`。

| PAUSE 原因 | 恢复前要做的 |
|---|---|
| `train-maintenance: TRAIN_STRICT_OFF` | 先把 main 规则集的 strict 开回 |
| `train-maintenance: TRAIN_LANDED_TREE_MISMATCH` | 先查清落地的树为什么不等于测过的树 |
| companion 兜底（strict 被关） | 同上，先开回 strict |
| 升级代理（`ROLLED_BACK_PAUSED`） | 见 §2.6 |
| 某个 Owner 会话写的暂停请求 | 确认原因已消除 |

升级代理的暂停平时由它自己用 `upgrade-resumed` 解除，不需要 Owner 干预。

### 3.4 中止一个批次

```powershell
# 提权
powershell.exe -NoProfile -NonInteractive -File <res>\windows\rearm-resident.ps1 -Request Abort -BatchKey <batchKey> -ExpectedLedgerEntrySha256 <ledgerEntrySha256> -Reason "<原因>"
```

- **只在安全点生效**：
  - tick 开始时，针对停在 A 或 B 的批次；
  - 每一步开始前；
  - 第 2/4/6 段运行中。
- **会因摘要过期被拒的情形**：第 1 段和第 R 段运行期间写的请求，结束时账本会新增记录，摘要必然过期，被拒为 `OWNER_ABORT_LEDGER_CHANGED_SINCE_REVIEW`。这时等这一段结束，重新查看，再请求。
- **其他拒绝码**：
  - `OWNER_ABORT_BATCH_NOT_OPEN`：批次已经结束；
  - `OWNER_ABORT_ALREADY_ACCEPTED`：这个批次的中止已经接受过；
  - `OWNER_ABORT_UNARCHIVED_SCENE_PRESENT`：还有别的未归档现场，先复位；
  - `OWNER_ABORT_SOURCE_DRIFT`：已安装字节与策略不符；
  - `OWNER_ABORT_NOT_AT_SAFE_POINT`：tick 开始时批次未终结却不在停靠点（只在崩溃恢复本身失败时可能出现）。
- **结果**：
  - 干净时记 `FAILED_CLEAN OWNER_ABORTED`，head 烧号，从不排 attempt 2；
  - 静止证明不成立时 HALT，按 3.2 复位。

### 3.5 放行熔断

```powershell
# 提权
powershell.exe -NoProfile -NonInteractive -File <res>\windows\rearm-resident.ps1 -Request ReleaseBreaker -Reason "<例如：网络已恢复>"
```

- 熔断器为 open 时，它让试跑立即到期，并解除全部环境类停止。
- 它**不关**熔断器：open 的试跑仍要越过上次失败的位置才算关闭。
- 熔断器已 closed 时，同一入口还可在修复环境后重新放行环境类 `release-cap` 停止项；先核实该项未执行、未发布且没有现存批次。回执标记 `closed-environment-recovery`，列出放行和跳过的项，不重置熔断计数或历史。后续仍经过正常冷却、日额度、资格和准入检查。
- closed 时没有上述停止项，或熔断器处于 half-open 时，仍拒绝为 `BREAKER_NOT_OPEN`。请求不会重跑已执行或已发布的 head；重复提交同一请求不会再次放行。

### 3.6 其他请求（`rearm-tool.mjs`）

先设两个变量：

```powershell
$node = "<root>\runtime\node.exe"
$tool = "<res>\tools\rearm-tool.mjs"
```

| 请求 | 命令 | 提权 | 写到哪 |
|---|---|---|---|
| 排空（结束所有停靠批次；只在当班节点上主动放弃仍成立的批次时用，重装不需要：不当班节点按 ADR 0027 不留批次） | `& $node $tool request-drain --root <root> --reason <r> --by <Owner SID>` | 是 | `owner\` |
| 暂停接新（最长 2 小时） | `& $node $tool request-intake-pause --root <root> --reason <r> [--minutes 1-120] [--holder owner]` | 否 | `requests\` |
| 提前结束暂停接新 | `& $node $tool request-intake-resume --root <root> --reason <r> [--holder owner\|dual-active\|unreadable]` | 否 | `requests\` |
| 立即探测角色 | `& $node $tool request-probe --root <root> --reason <r>` | 否 | `requests\` |
| 撤车头的绿 | `& $node $tool request-revoke-head --root <root> --reason <r>` | 否 | `requests\` |
| 标记影子数据已复核 | `& $node $tool mark-train-shadow-reviewed --root <root> --ref <text>` | 否（`owner\train-review\` 与 `owner\` 不同，未提权的 Owner 可写，这是已接受的残余风险） | `owner\train-review\` |
| 暂停（急停） | 任何进程往 `requests\` 写 `{"contract":"clued.independent-ci.resident-pause/1","reason":"…"}` | 否 | `requests\` |

请求的时效：
- 立即探测、撤车头、排空：超过 1 小时才被读到的请求会被拒绝；
- 暂停接新：读到时已过期，或 `requestedAt` 比执行器时钟超前 5 分钟以上，都会被拒绝。

暂停接新和暂停都在批次之间生效，从不打断正在跑的段。

---

## 4. 其他批准

| 什么 | 谁批 | 在哪 |
|---|---|---|
| 原地升级 `ci.resident_upgrade` | 自动审批开关代批（每节点每天限次），否则 Owner | `upgrade\status.json` 的 `confirmUrl` |
| 受保护路径改动 `repo.protected_change` | Owner 登录的 KooYomi 页面，或自动审批开关 | 绑在确切 head 上。只合进 main 带来的新 head 沿用旧批准（Decision `a0d93cd0`） |
| ci-admission 移交 | Owner | `/bindings` 一键移交（5 分钟后生效）；自动接班的总开关、资格和次序也在这里 |
| 生产迁移、Worker 发布 | Owner 逐次批准 | 发布流程 |
| UAC（整套重装、恢复、复位、中止、排空、放行熔断） | Owner 本人 | Agent 准备命令，Owner 点批准 |

---

## 5. 常见卡住情形

每条按"现象 → 确认 → 处理"写。

### 5.1 源码不一致（`TRAIN_SOURCE_MISMATCH`）

- **现象**：
  - 列车开着，执行器 `DEFERRED TRAIN_SOURCE_MISMATCH`，什么批次都不开；
  - PR 页面写"合并列车的 Source 不一致，等 Owner 处理"；
  - Windows 通知"常驻节点的 Source 不一致"。
- **原因**：24 小时内发过心跳的节点里，有节点跑着别的 `ciSourceManifestSha256`。最常见的情况是两台按顺序升级，先装好的一台在等另一台。
- **确认**：比较两台 `status.json` 的 `node.source` 和 `versions.windows`。
- **处理**：
  1. 把落后的节点升到同一个包（§2.4）。
  2. 不用做别的：上一轮是 `TRAIN_SOURCE_MISMATCH` 时，第 10 段 2 分钟后自动重核（`TRAIN_RECHECK_MS`），对端装好后很快恢复。
  3. 下次的顺序：**先装 shadow 或待命节点，确认它好了，再装开车的当班节点**。这样不一致的窗口最短，也不会挡住正在开车的节点。
- **注意**：
  - 已退役、但 24 小时内还发过心跳的节点也算在内；
  - Source 读不出时是 `TRAIN_SOURCE_UNREADABLE`，同样推迟、同样 2 分钟重核。

### 5.2 停车批次卡死

- **现象**：
  - 第 10 段一直报 `TRAIN_FRONT_BATCH_RUNNING`，执行器却是 IDLE，几十分钟不开任何批次；
  - `queue.json` 里该 PR 那一行的 `running` 是**旧 head** 的停车批次，`current` 是新 head。
- **原因**（现场 #1035，DESIGN §65.9）：旧 head 的车头批次在第 8 段失败（例如 `REQUIRED_CHECK_FAILED`），停在 B。PR 推了新 head 后，第 10 段为新 head 开车头批次，但这一行被旧批次占着，提交被拒（`TRAIN_FRONT_PR_BUSY`），之后第 10 段一直以为车头批次在跑。
- **当前代码的自动处理**（`c933238b5` 起）：
  - 被新提交取代的 B 点停车批次，先于接管门就在安全点结束（`SUPERSEDED_AT_SAFE_POINT`，回执 `batch-superseded`）；
  - 为车头让路时结束旧 head 的停车批次（回执 `train-front-supersedes`）；
  - 只因行忙被拒的车头批次会再提交一次（回执 `train-front-reoffered`）；
  - 同一 head 的普通批次停在 A 或 B 时，由车头接替（回执 `train-front-takes-over`，结局 `TRAIN_FRONT_TAKES_OVER`）。
- **确认**：
  1. 看 `queue.json` 该行的 `running.headSha`、`current.headSha`；
  2. 在回执里找上面四种。
- **手工处理**（节点装的是这次修复之前的代码，或者自动处理没生效）：
  1. 不提权查看，在 `abortTargets` 里找到旧 head 的批次键和摘要；
  2. 提权中止它（§3.4）。停在 B 的批次在下一个 tick 开头就是安全点；
  3. 中止干净后这一行被释放，下一次第 10 段会开新 head 的车头批次。
- **不要做**：不要手工改 `queue.json`，也不要删账本文件。排队表只是视图，账本只能只新建。

### 5.3 合并队位或租约过期

- **现象**：停在 B 的批次第 8 段反复是 `RESIDENT_MERGE_QUEUE_NOT_JOINED` 或 `RESIDENT_QUEUE_HEAD_NOT_REACHED`；或者车头批次跑完时合并位已经过期。
- **原因**：
  - 车头批次的 running 时钟最长 90 分钟（受 `slotHardCapMinutes` 约束）。批次超时，合并位就在第 8 段之前过期；
  - 认领租约（2 小时）到期，认领离开了合并队列；
  - 认领从没进过合并队列。
- **确认**：
  - `status.json` 的 `train.last`（决定、车头）；
  - PR 页面上的租约提醒（"请现在续租"）、通知 `CLAIM_LEASE_SHORT`；
  - 回执 `stage8-not-ready` 的 `failureCode`。
- **自动处理**：
  - 第 8 段遇到"不在队列"时 CI 自动入队（`merge_queue_join`）；
  - 租约不足 180 分钟时 CI 自动延长；
  - 第 1 段之后租约不足 90 分钟时也延长；
  - 排队观察在队首变化后约 30 秒内提前尝试第 8 段。
  - 第 28 代起：已绑定的队首在等车头、或它的车头批次在跑/停靠时，合并位剩余不足 20 分钟，第 10 段就 `touch running` 一次（[ADR 0017](adr/0017-stage10-front-slot-renewal.md)），不必再人手续期。
- **手工处理**：
  1. 回执或日志里出现 `CLAIM_ASSIST_NOT_DEPLOYED`（服务端没有入队、延租动作）时，由认领持有者用 `clued_work_renew` 续租，并带上 merge ref 重新入队。
  2. 车头批次因为合并位剩余时间不够没开（`TRAIN_FRONT_BUDGET_SHORT`）时，PR 页面会请持有者让位子过期后重新入队。每个 head 最多两次车头批次，用完（`TRAIN_FRONT_ATTEMPTS_USED`）就要推新提交。
  3. 硬截止（24 小时）到了，认领不会被保活，要重新认领。
- **相关**：车头批次跑到第 8 段时 strict-front 证明刚好过期（`TRAIN_SINGLE_GREEN_NOT_PROVEN`）。当前代码会在第 8 段之前剩余不足 3 分钟时先刷新一次（`frontProofShort`，回执 `train-front-proof-refresh`），一般不用人管。

### 5.4 Owner 请求没有生效

| 现象 | 原因 | 处理 |
|---|---|---|
| 请求文件出现在 `<root>\state\requests-archive\rejected\` | 把复位、恢复、中止写进了 `requests\` | 用已装的 `rearm-resident.ps1 -Request …` 提权重写，写进 `owner\` |
| 脚本报 `RUN_THE_INSTALLED_COPY` | 运行的是仓库里的副本 | 运行 `<res>\windows\rearm-resident.ps1` |
| 脚本报 `ELEVATED_OWNER_TOKEN_REQUIRED` / `INSPECT_RUNS_NOT_ELEVATED` | 提权状态不对 | 查看不提权，请求提权 |
| 回执 `owner-request-refused` | 摘要过期、格式不对、批次已结束、静止不成立 | 看 `failureCode`。重新查看、用新摘要再请求；新请求自带新的时间和 nonce |
| 回执 `owner-request-duplicate` | 同样的字节换了个名字又写了一次 | 不用处理 |
| 回执 `owner-request-refused`，只带文件名 | 文件连续读失败 3 次后作废 | 重新写一次请求 |
| 回执里没有任何记录 | 执行器没在跑（`writtenAt` 不动） | 先确认服务在运行（§5.9） |

### 5.5 HALT

1. 不提权查看：HALT 的 `code` 和 `facts`。
   - 超时类 HALT 有只读核对提示（`pr-status.mjs#haltHint`），PR 页面也会显示；
   - 归档类看 `windowsArchiveCode`。
2. 确认现场确实静止：
   - Windows：runner 服务回到原始二进制、STOPPED；
   - Linux：`systemctl list-units 'clued-ci-*'` 全部 inactive，没有带 nonce 标签的容器。
3. 按 §3.2 复位。
4. 同一个码反复出现时，按"缺陷必须修"登记 Task。不要靠反复复位过日子。

常见码：

| 码 | 起因 |
|---|---|
| `PUBLICATION_UNCERTAIN`、`NEGATIVE_COMPENSATION_*` | 发布结果不确定 |
| `ROLE_ALREADY_PUBLISHED_ON_HEAD` | 同一 head 的角色已经在别处发布过，看 `detail` |
| `COMPANION_HEARTBEAT_LOST`、`LINUX_WORKER_ENDED_WITHOUT_RECORD` | 泵或 worker 失联，又不满足自动收尾条件 |
| `RESIDENT_SOURCE_DRIFT` | 已装字节被改。先按安装清单恢复文件，再复位 |
| `ROLE_PROBE_INTERRUPTED`、`ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED` | 角色探测出问题。后者常见原因是 controller 账户缺"作为服务登录"权限 |
| `TRAIN_STAGE_INTERRUPTED` | 第 10 段被打断 |
| `EXECUTOR_RESTARTED_WITH_OPEN_BATCH` | 重启时有未终结的批次，且不能证明安全：同一次开机里执行器崩溃、发布段已开始、或两端 15 分钟内没静止（DESIGN §71）。能证明的会自动以 `EXECUTOR_RESTARTED_UNPUBLISHED` 干净关闭并重跑一次，不 HALT |

### 5.6 PAUSE

看 §3.3 的原因表。列车开着时，PAUSE 期间第 10 段仍以只撤模式运行，这是正常的。

### 5.7 版本不一致（`version-skew`）

- **现象**：暂停接新的持有者里有 `version-skew`；执行器推迟（`VERSION_SKEW`）；第一个 Linux 段报 `UPGRADE_VERSION_SKEW`。
- **原因**：本节点 Windows 和 Linux 两侧的代或 Source 不同，常见于升级的中途或失败之后。
- **处理**：
  - 看 `status.json` 的 `versions` 和 `upgrade\status.json`；
  - 等升级完成或回滚，两侧一致后持有者自动解除；
  - 手工 `request-intake-resume` 没用，下一个 tick 会被重新加上。

### 5.8 熔断打开

- **现象**：执行器不开新批次；PR 页面写熔断和下次试跑时间。
- **处理**：
  1. 看回执 `breaker-opened` 里的失败位置。
  2. 如果是网络原因，网络恢复后 10 分钟内会自动试跑；连续 2 次探测成功会提前试跑。
  3. 确定故障已经消失，又不想等的，用 §3.5 放行。
  4. 同一位置反复失败时，查根因。

### 5.9 执行器或 companion 不在

| 现象 | 处理 |
|---|---|
| `writtenAt` 不动 | 服务没在跑。看服务状态和事件日志（服务失败后每天最多自动重启一次）；单实例锁拒绝启动时看 `state\locks\` |
| 执行器 `DEFERRED COMPANION_NOT_READY` | companion 心跳过期。现装版本的 companion 只在 Owner 登录时运行（AtLogOn），先确认 Owner 已登录（锁屏也算），计划任务 `\Clued\CluedCIResidentCompanion` 在运行。装了 M5（第 29 代）并切到密码登录之后不需要登录：看通知或 M5 手册第 5 节的排查表 |
| companion 起不来 | 看是否报 `COMPANION_JOB_HOST_UNAVAILABLE`、`COMPANION_SCRIPT_NOT_IN_SOURCE`。在 Owner 会话里跑一次已装的 `test-job-host.ps1 -Wsl` |

无人登录时 companion 不可用，这是现装版本的已知限制。Owner 已选定 B2 方案（[ADR 0011](adr/0011-companion-without-logon.md)），第 29 代已实施、未安装（[ADR 0022](adr/0022-companion-headless-implementation.md)）。上线、改密码、换令牌、排查和真机验收都在运维手册 [`../rollout/M5-COMPANION-HEADLESS-RUNBOOK.md`](../rollout/M5-COMPANION-HEADLESS-RUNBOOK.md)：

- 上线只能整套重装（R 类，§2.1）：M5 换了冻结的升级通道 `upgrade-apply.ps1` 和 `upgrader/src/machine.mjs`。重装之前先由 Owner 生成并存入 companion 专用的细粒度令牌（手册 §1.3–§1.5），没有它 companion 不启动。
- Windows 密码只在安全桌面（屏幕变暗、和 UAC 同一画面）的凭据框里输入，而且只在自己刚启动提权命令、点过 UAC 之后。通知从不叫人输密码。
- 改了 Windows 密码：提权运行 `rearm-resident.ps1 -CompanionCredential`（手册 §4.1）；手动退回登录方式：`-CompanionInteractive`（手册 §4.3）。

### 5.10 main 被改写，列车冻结

- **现象**：第 10 段 `TRAIN_TAKEOVER_SWEEP_PENDING`；状态页写"main 被改写，合并列车在重扫全部 PR 和提交，扫完前不发绿"。
- **处理**：
  - 这是有意保留的冻结（Decision `78a3052f` 第 1 项）。等这一轮 scope all 扫完，大约几小时，不需要操作；
  - 查清 main 为什么被改写，这本身是事故；
  - 冻结期间**不要回退**到更早的代。

### 5.11 车头落后 main（`FRONT_NEEDS_MAIN_MERGE`）

strict 开着，GitHub 不会合入落后的车头。目前由 PR 持有者自己把 main 合进分支（merge 方式）。机器人自动 update-branch 已经决定、尚未实现（Decision `78a3052f` 第 2 项）。

### 5.12 准入超时，重型检查都被跳过

- **现象**：`admission-gate` 以 `ADMISSION_PENDING` 结束，必需检查缺失。
- **自动处理**：companion 会用 Owner 的 gh 登录点一次 "Re-run all jobs"，每个 head 最多一次，回执合同 `admission-rerun/1`。
- **需要 Owner 补跑的情形**：结果为 unsent、refused 或 unknown 时，Owner 会收到通知，按提示手工补跑一次。

### 5.13 升级重启后开车慢

- **现象**：升级重启后，第一次 on 模式的第 10 段迟迟不来。
- **当前代码的处理**：暂停解除后，如果上一轮是只撤模式，下一次第 10 段立即到期（缺陷 `b0426896` 已修）。
- **还慢时**：看是不是在等 `TRAIN_SOURCE_MISMATCH` 重核（§5.1）。

### 5.14 本地验证跟常驻 CI 抢机器

`scripts/ci/local-verify.mjs` 看到 `status.json` 的 `current` 非空时，会在每个套件开始前等待：每 30 秒看一次，最多等 90 分钟。急用时加 `--no-yield`，但会拖慢正在跑的批次。

---

## 6. 实测方法

### 6.1 首绿时间（从推送到合并位的绿）

1. **t0**：推送时间，或者排队行 `current.firstAt`（`queue.json`）。
2. **首绿**：

   ```bash
   gh api "repos/tdoljyj/cross-memory-system/commits/<H>/check-runs?check_name=kooyumi-merge-slot" --jq '.check_runs[] | [.app.id,.conclusion,.completed_at] | @tsv'
   ```

   只认 App 5368905 的 success。
3. **分开记录**（DESIGN §62.3）：允许开批的时刻、第 1–7 段用时、第 8 段首绿、实际可合并的时刻。不要只报一个总数。
4. **冷启动和接管后的首次绿**，两种情形要分别测。参考：第 22 代冷启动首绿是 35 分 09 秒（Note `eea57601`）。

### 6.2 分段耗时

每段结束有一条 `stage-terminal` 回执（`body.key`、`body.stage`、`ok`、`failureCode`），批次的起止有 `batch-reserved`、`batch-started`、`batch-parked`、`batch-terminal`。不提权运行：

```powershell
& <root>\runtime\node.exe -e "const fs=require('fs'),p=require('path');const d=process.argv[1],k=process.argv[2];for(const f of fs.readdirSync(d).filter(n=>n.endsWith('.json')).sort()){const r=JSON.parse(fs.readFileSync(p.join(d,f)));if(r.body&&r.body.key===k)console.log(r.at,r.type,r.body.stage??'',r.body.ok??'',r.body.failureCode??'')}" <root>\state\receipts <batchKey>
```

- 相邻两行时间相减就是每段耗时；
- 第 10 段看 `train-run-intent` 到 `train-run`；
- 已封存的月份在 `receipts\archive\<nnnn>-<yyyy-mm>\` 下，要另外读。

参考数据：第 1–7 段 13–15 分钟；第 8 段约 1 分钟；wsprep 约 15 秒；每轮挑战往返 15–17 秒（DESIGN §62、§64）。

### 6.3 现场实测的要求

- 目标场景要有端到端测试，修复前失败、修复后通过（任务 `bf57ff10` 的验收口径）。
- 现场再分段实测一次。CI 绿和独立审查都不能代替这一步。
- 实测数据写进 Clued Note，带批次键和 head。

---

## 7. 2026-11-07 的教训汇总

| 坑 | 一句话 | 见 |
|---|---|---|
| 源码不一致 | 两台按顺序升级时先装好的那台被 `TRAIN_SOURCE_MISMATCH` 挡住。先装待命节点，确认一致，再装当班节点；现在 2 分钟自动重核 | §5.1 |
| 停车批次卡死 | 旧 head 的车头批次停在 B 占着行，新 head 开不出来。新代码自动结束；旧代码用 Abort 手工结束 | §5.2 |
| 合并队位过期 | 车头批次超过 90 分钟或认领租约到期，第 8 段等不到队首。CI 自动入队、延租；服务端没部署时由持有者续租重新入队 | §5.3 |
| Owner 请求走错目录 | 复位、恢复、中止写进 `requests\` 会被拒。只用已装的 `rearm-resident.ps1` 提权写进 `owner\` | §0、§5.4 |
| 装包把全量扫描清零 | 已由 strict 永久开解决：全量扫描不再挡任何事，装包不影响开车 | [ADR 0008](adr/0008-full-sweep-audit.md) |
| 改了被锁定的文件忘了重新生成登记 | CI 的 `pinned-registries` 套件几秒内报出来并给出修复命令；推送前用 `local-verify --affected` 自查是可选的，不挡推送（Task `f4a02c4b`、`390ad276`） | [ADR 0032](adr/0032-ci-both-platforms.md) |
