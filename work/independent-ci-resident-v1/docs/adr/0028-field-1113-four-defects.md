# ADR 0028：11-13 真机四个缺陷：恢复立即上状态、删备班提醒、staged 下移交认领可用、恢复后先跑第 10 段

- 状态：已实现（分支 `claude/resident-four-defects`，未安装）；缺陷 2 未修，见末节
- 日期：2026-11-13
- Owner Decision：统领原则（`42d5bf8d`：最终系统极简、低耗、高效，错误从机制上堵死）
- 证据：DESK 回执链 2026-11-13 03:28–05:09Z（`state/receipts` 00000001–00000120）；生产库只读查询 `clued_private.work_claim_execution_policy_v1.activated_at` 为空（执行策略仍是 staged）
- 代码：`src/executor.mjs`（`reportLedgerLatches`、tick 中欠下的第 10 段）、`src/node-duty.mjs`、`src/pr-status.mjs`；CI Source `src/admission-facts-v2.mjs#effectiveGuard`、`src/full-admission-v2.mjs`、`runtime/one-shot-v2.mjs`、`src/resident-v2/entry-runtime.mjs`
- 测试（修复前都失败）：`test/owner.test.mjs` “a resume reaches the status before the batch it lets run”；`test/pr-status.test.mjs` “ADR 0028: a STANDBY writes no reminder …”；`test/node-duty.test.mjs` “ADR 0028: a STANDBY reminds of nothing …”；`test/train-takeover-front.test.mjs` “field 2026-11-13 (PR #1085): after a resume the scans of the queue head run once …”；CI `test/resident-v2-admission.test.mjs` “… a handed-over claim runs while staged …”、`test/resident-v2-publishers.test.mjs` “one-shot v2: the protected observation …”

## 1. 解除暂停后 PR 页面仍报“停摆（PAUSED）”

时间线：03:29:58 暂停；03:32:14 Owner 恢复（`owner-request`）；同一 tick 03:32:16 预留 #1085 的批次，跑到 03:46:45 第 8 段；tick 结束才 `reportTick`，状态里的 `paused` 这时才变 false。PR 页面 03:32–03:46:25 一直是“停摆（PAUSED）”（03:46:25 是 14 分钟一次的刷新），03:46:55 转“当班”。

根因：PAUSE、HALT 在锁存的那一 tick 就写进状态（`reportLatch`），解除却只在 tick 末尾由 `reportTick` 从账本读回；一个 tick 可以包含整批运行。companion 的签名（`statusSignature` 含 `paused`）和 5 秒间隔没有问题。

修法：`reportLedgerLatches()`——tick 处理完 Owner 请求后立即按账本写 HALT/PAUSE（设置和解除同一路径），`reportTick` 也用它。

## 2. 备班 PR 提示（`resident-standby/<node>`）：删除

结论：与服务端看门狗和当班节点自己的提示完全重复，删掉，不修。

| 提醒原因 | 已经有谁说 |
|---|---|
| 当班节点写“停摆”≥10 分钟 | 当班节点自己的 PR 页面文字（停摆（CODE））和它自己的通知（HALT、状态过旧）；PAUSED、INTAKE_PAUSED、熔断、启动中都是 Owner 的操作或自己会消失的状态，提醒只是噪声（11-13 就是误报：DESK 在跑，TURING 报“停摆 10 分钟”到 03:49 还没撤） |
| 当班文字 30 分钟没刷新（节点死了） | 看门狗：持有者 5 分钟没心跳就交接（约 5–7 分钟，ADR 0026）；总开关关时写 `CI_ADMISSION_FAILOVER_WITHHELD`（`switch_off`）告警 |
| 30 分钟没人接手、没有准入检查 | 同上：当班节点活着就会排队并写自己的文字；不活就是看门狗的情形 |

删掉的：§5.3 的三种判定、提醒文字和通知、每 5 分钟逐 head 的 statuses/check-runs 读、`seen`/`reminded`/`toasts` 记忆、`othersOnHead` 的停摆起点。留下的只有一条收尾：本节点以前写下、还在 pending 的提醒，在 head 仍打开时写一次 success（“备用提醒已取消（ADR 0028）”），否则 GitHub 把 PR 当 UNSTABLE（PR #1027）。

## 3. 网页移交过的认领报 NATIVE_POLICY_UNSUPPORTED

时间线：#1086 04:48:25 第 1 段 `NATIVE_POLICY_UNSUPPORTED`（environment、burn，head 作废）；换新认领后 04:55、05:06 `CLAIM_NOT_CURRENT`（新提交没 authorize_head，属正常的等待类，授权后自动重评）。

根因：`full-admission-v2.mjs` 用 `supportedNativeExecution(execution_policy, lease_key_required)`，staged 只接受 `lease_key_required=false`。网页移交会把认领（及同 Task 以后的认领）设为需钥匙；而生产执行策略至今是 staged（`activated_at` 为空），这时 Native 根本不按钥匙或头授权把关（`work_claim_verify_v1` 只在 `lease_key_required and execution_enabled` 时要求头授权），照样 ADMITTED。常驻比 Native 更严，把一个按设计可运行的认领判成不支持。

修法：`effectiveGuard(policy, leaseKeyRequired)`——守卫只在 active 时生效；staged 下需钥匙的认领按 `guarded=false` 运行，与其它 staged 认领完全一样（V2 事实合同不变，工人适配器、签发方不变）。active 下照旧：需钥匙就必须带持有者的头授权，否则仍是不支持。第 1 段（full admission）、发布者（one-shot v2）和各段的 native.current 复核用同一个函数，三处一致。

落后 main（12:33 草稿转 Ready 被拒、需人推合并提交）：属于已登记的搁置项“合并执行器只给落后车头更新分支”；本 ADR 不另起机制。

## 4. 车头严格路径重复跑

时间线：03:32:14 恢复，同一 tick 预留 #1085 的普通批次（head 734cd84），第 1–7 段 03:33–03:46 全绿，第 8 段停在 B（`TRAIN_SINGLE_GREEN_NOT_PROVEN`，train on 下普通批次永远拿不到合并位）；04:07 第 10 段开车头批次，`TRAIN_FRONT_TAKES_OVER`，车头批次在 S（树与 H 相同，main 未动）上 04:09–04:18 把 gitleaks、trivy、contract-placement 又跑一遍。

根因：§62.6 已规定队首 PR 的普通批次在第 1 段后让位，只跑车头批次；让位条件读“最近一次第 10 段”。暂停期间第 10 段只跑 revoke-only，恢复后欠下的 on 模式第 10 段（`trainResumeOwed`，缺陷 b0426896）只在 tick 空闲时才跑，而恢复所在 tick 先排了批次。让位读到的是 revoke-only 那一轮，于是没让位。

修法：tick 在做任何批次工作（停靠批次、调度）之前，先跑恢复欠下的那一轮第 10 段。之后调度和让位读到的是当前列车状态：队首的扫描只在车头批次上跑一次。

为什么不做“同树直接复用结果”：trivy 已按树缓存（ADR 0021）；gitleaks 扫的是提交历史、contract-placement 在容器里运行候选代码并能读到提交历史和提交号（DESIGN §68.1、§68.7），按树复用不完整、会放过东西。本次的重复不是缺缓存，而是本不该跑的普通批次跑了；从根上让它不跑。

## 5. 缺陷 2（合并位从“成为车头”起计时）：未修，需要服务端改动

`TRAIN_FRONT_BUDGET_SHORT` 的上限不是客户端决定的：服务端 `work_claim_merge_slot_until_from_v1` 把位子截在 `since + merge_slot_hard_cap_seconds`（`since` = 成为车头的时刻），触碰（touch running）和持有者续租都推不过它，Agent 合同也写明“the slot ends merge_slot_hard_cap_minutes after you became head”。所以“等节点期间不计入”或“系统自动重新入队”都要改服务端迁移（例如上限从车头批次第一次报 running 起算，或给 CI 一个重新入队动作）并改 Agent 合同，需要 Owner 决定和发布授权。

11-13 那次是第 4 条触发的：如果恢复时先跑第 10 段，03:32 还剩 76 分钟，够开车头批次（需要 64.5 分钟），不会 BUDGET_SHORT。第 4 条修好后，只有 CI 停摆超过约 55 分钟才会再遇到。
