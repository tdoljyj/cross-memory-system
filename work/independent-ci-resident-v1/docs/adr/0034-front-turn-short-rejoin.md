# ADR 0034：车头这一轮不够跑一批时，第 10 段自动让同一认领原地重排（turn_short）

- 状态：已实现（分支 `claude/front-slot-turn-short`，未发布、未安装；迁移待应用，两侧上线先后无所谓）
- 日期：2026-11-19
- 设计：Fable 2026-11-19《车头位子“时间不够跑一批”要人手放弃重排 — 修法设计》
- Owner Decision：统领原则（`42d5bf8d`）；全自动，不为难用户（`2a06b57c`）
- 代码：Source v2 `independent-control-checks-v2/train-maintenance.mjs`（`frontBatchPlan`、第 10 段）、`merge-slot-native.mjs`（`yieldSlot` 的 `reason`）；服务端迁移 `20261119120000_merge_queue_yield_turn_short_v1.sql`；常驻层只改文案（`src/train.mjs`、`src/failure-table.json`）
- 测试：Source v2 `test/train-sweep.test.mjs`（turn_short 三组）；服务端 `apps/clued-cloud/tests/merge-queue-yield-turn-short-db.case.mjs`（在 `work-claims-reject-receipts-db.test.mjs` 登记）

## 1. 现场（2026-11-19，北京时间）

认领 28ab365c 07:32:36 取得车头位子（硬上限 120 分钟），先给 #1169 用了 64 分钟，08:38:46 改绑 #1173。开一批车头要剩余 ≥ 64.5 分钟（`frontBatchBudgetMs` 60 + 第 8 段 1.5 + 余量 3），08:40:24 起每轮都是 `TRAIN_FRONT_BUDGET_SHORT`，直到有人手动放弃、重认领、重新授权 head、改 PR 正文。升级暂停（08:44–08:48）在第一次 BUDGET_SHORT 之后，不是原因。

## 2. 根因

位子的硬上限从认领取得车头那一刻起算；一轮里过了 55.5 分钟还没开出当前 PR 的批次，这一轮就永远开不了，而系统里没有自动出口：`renewFrontSlot` 不再续这样的位子，它在硬上限之前闲置过期，“到硬上限过期后自动重排”接不住；`merge_queue_yield` 只在 PR 落不了地时调用，且没人排队时服务端拒绝（`nobody_waiting`）。

## 3. 决定

- 服务端：`merge_queue_yield` 加可选 `reason`，`cannot_land`（缺省，行为不变）或 `turn_short`。`turn_short` 时没人等也重排，沿用 `work_claim_merge_rejoin_v1`（回执 why=`turn_short`）：有人等排到他们后面，独自一人立刻又是车头、拿到完整新一轮。其他取值 22023。
- 第 10 段：`frontBatchPlan` 标出“硬上限不够”这一种 BUDGET_SHORT（`turnShort`）；同时要求新一轮装得下一批（上限与 90 分钟 running 时钟都 ≥ 所需）。开批那一步遇到它、本轮没写过位子时调 `yieldSlot({pr, headSha, reason:'turn_short'})`，成功则结论 `FRONT_RETURNED`，下一轮正常 `OPEN_FRONT_BATCH`。租约不够、`since` 读不到、车头批次在跑、配置本身装不下一批，都不调。服务端没有该入参（应答读不懂）则不计写入，结论仍是 BUDGET_SHORT。
- 文案：`TRAIN_FRONT_BUDGET_SHORT` 改为“系统会自动重新排队，无需操作”。

认领不变：不放弃、不重认领、不重新 authorize_head、不改 PR 正文。一处覆盖全部成因（同认领换 PR、暂停、执行器忙、清扫久）。

## 4. 否决

- 暂停期间冻结位子计时：现场证明暂停不是原因，还要服务端知道节点暂停状态。
- 只在常驻侧做：独自排队时现有 yield 被拒，`merge_queue_join` 对在位车头返回 `already_queued`；“还位再入队”是两次非原子写。
- 重排后同一轮立刻开批：严格车头证明绑定 `since`，重排后要重证；为省 ≤10 分钟不值得。

## 5. Owner 动手清单

空。不碰受保护路径；迁移走发布工作流 migrate 模式（Decision `40dad0c0`）；节点更新走通用升级。

## 6. 上线后的验证

生产回执里出现一次 BUDGET_SHORT 后，下一轮无人干预变成 `FRONT_RETURNED` → `OPEN_FRONT_BATCH`，审计回执有 why=`turn_short`。
