# ADR 0016：车头 PR 换了新 head，在新 head 的第 1 段重新入队并让位

- 状态：生效（第 28 代，未安装）
- 日期：2026-11-08
- 缺陷：`1b31b06b`。现场：
  - #1037：2026-11-07 15:30–16:09，常驻回执 3768–3812；
  - #1035：11:56–12:41，回执 3606–3627。
- 代码：
  - `CI/src/independent-control-checks-v2/claim-assist-native.mjs`：`stage1FrontRequeue`，以及 `joinQueue` 的 `mergeQueue`；
  - `CI/src/independent-control-checks-v2/train-sweep-store.mjs#latestFrontBatch`；
  - `CI/src/formal-work-admission-check-v2/startup.mjs`。
- 测试：
  - `R/test/train-takeover-front.test.mjs`，“field #1037 (1b31b06b)” 两例（端到端）；
  - `CI/test/claim-assist-native.test.mjs`，gen 28 两例。

## 背景（根因，按回执核实）

1. 旧 head `118f90a1` 的车头批次 (H, S) 在第 8 段读到 `REQUIRED_CHECK_FAILED`。
   - 第 8 段按既有规则还了合并位：`publisher.mjs#waitForQueueHead` 的“失败的工作要把位置让给下一个认领”，调用 `clued_work_merge_slot_return_v1`。
   - 还位会把 merge ref 从认领的 trigger_refs 里拿掉（`work_claim_merge_slot_return_core_v1`），认领因此离开队列。
   - 回执 3768 的 `mergeQueue` 在还位后就是 `entered:false`。
2. 推新 head `26ac75e4` 后，旧批次在停车点以 `SUPERSEDED_AT_SAFE_POINT` 结束，这一步是对的。
   - 新 head 的普通批次第 1 段拿到的 Native 事实是 `mergeQueue.entered=false`（回执 3777）。这个事实**是真的**。
   - Native 的 `work_claim_merge_queue_view_v1` 按认领判断，不按 head：只要认领没有 merge ref，它就返回 null，`queue-facts.mjs#mergeQueueEntryV2` 把 null 规范成 `entered:false`。
   - “认领一直是队首”这个印象来自之后的状态：新 head 第 8 段在 15:47 重新入队，16:09 才到队首（回执 3808）。
3. 所以 §62.6 的让位没有触发，第 1–7 段白跑了约 13 分钟，车头批次在推送 36 分钟后才开。
4. #1035 是同一条链：
   - 11:56 第 8 段 `REQUIRED_CHECK_FAILED` 还位；
   - 12:20 推新 head；
   - 第 10 段一直说 `NO_FRONT`，直到 12:41 人手续期，认领才重新入队。

## 决定

新 head 的第 1 段 SETTLED 之后（`startup.mjs`，紧接在 `stage1WithLease` 后面），如果下列条件**全部**成立，就用 CI 身份 `merge_queue_join` 重新入队：

- 列车 on；
- 这不是车头作业；
- Native 刚说认领不在队列（`entered:false`）；
- 本节点最新的一次车头批次记录（`latestFrontBatch`）是**这个 PR 的、另一个 head 的、同一个认领的**。

入队位置在队尾，和第 8 段入队相同。Native 的入队应答带有认领的 `merge_queue` 视图，用它替换第 1 段结局里的 `mergeQueue`：

- 应答说是队首、位置 1：常驻层照 §62.6 让位，第 10 段立刻 `OPEN_FRONT_BATCH(新 head)`；
- 应答说队里还有别人：认领排在他们后面，状态是 `waiting`，常驻层不让位，普通批次照旧跑；
- 应答没有视图：按“在队里、位置未知”处理，同样不让位。

任何失败都只记日志（`native_front_requeue`），第 1 段结局保持原样。常驻层不改。

## 为什么是这个改法

- **“改用认领自己的队列位置”不成立**：认领确实不在队里了。
- **“不还位”不行**：车头失败后如果一直占着队首，后面的认领要等到 45 分钟超时或硬上限才能轮到。
- **在第 1 段入队是最小的改法**：
  - 这是第 8 段本来就会做的同一个动作，只是提前到“刚证明这个 head 的准入”之后。CI 门的服务端照旧要求该 head 在当前 epoch 有执行准入。
  - 入队之后的事全部沿用现有逻辑：第 1 段的队列事实、§62.6 让位、第 10 段开车头，以及第 8 段的实时 strict/holder/claim generation 检查。

## 不会让非队首 PR 错误让位

- 只有本节点最新车头批次记录里的那个 PR 会在第 1 段入队。
  - 从没当过车头的 PR，不会在这里入队，自然也不会在这里让位，照旧在第 8 段入队（保护测试 “a PR that was never the train front”）。
  - 别的 PR 的车头批次更新时，旧车头不再满足条件。
- 让位条件一条没放宽：仍然要 Native 自己说是队首、位置 1，最新一次第 10 段是 on、当班、strict。入队排在队尾，队里有别人就不是队首。
- 队列事实只用于调度，从不当授权。入队不是合并。车头批次照常跑第 1–8 段，绿只能由第 8 段在全部实时条件成立时发出。
- 记录读不了（有更新的撕裂记录）就当作没有，不入队。

## 关于“合并队位 45 分钟到期，第 10 段看不到队首”

**常驻 CI 什么时候为认领延长队位。** 能推后合并位到期时间的只有两样：持有者续期，和 `clued_work_merge_slot_touch_v1`（文档里说的 “while CI reports on its PR”）。常驻 CI 只在三处调用 touch：

- 第 10 段 `openFront` 的 touch running：给 90 分钟，受 `slotHardCapMinutes` 约束；
- 车头批次第 1 段的第二次 touch running；
- 第 8 段的 touch green：给 30 分钟。

第 1/8 段的 `lease_extend` 和第 10 段的 keepalive 只延长认领租约，不延长合并位。

**今晚两次的真实原因不是 45 分钟计时。** 是第 8 段在 `REQUIRED_CHECK_FAILED` 时还了位。证据是回执 3606/3608 和 3768/3770：还位后 `mergeQueue` 立刻变成 `entered:false`。认领不在队里，`merge_slot_ci`（`work_claim_merge_slot_ci_view_v1`）对它自然是空的，因为这个视图只对活着的队首返回对象。#1035 的 `merge_slot_ci` 一直为空，原因就在这里。人手续期带着 merge ref，认领重新入队，所以续期“修好了”。本 ADR 的第 1 段重新入队覆盖了这两次：新 head 一到，第 1 段就重新入队。

**仍然存在的真正 45 分钟窗口（本 ADR 未改；第 28 代已由 [ADR 0017](0017-stage10-front-slot-renewal.md) 修复）。** 认领成为队首（`merge_slot_at`）之后，到第 10 段 `OPEN_FRONT_BATCH` 的 touch 之前，没有任何调用延长合并位。这种情况发生在第 10 段长时间轮不到（别的 PR 的批次占着执行器），或者第 10 段一直给出不 touch 的结论（`FRONT_NOT_BOUND`、`TRAIN_FRONT_BUDGET_SHORT` 等）时。§62.4/§62.6 让第 10 段在绑定后立即到期，这个窗口通常只有几分钟。

建议的最小修法（只改 Source v2 `train-maintenance.mjs`）：on、当班、恰好一个已绑定的 holder、它的 PR 开着、且本节点有它在跑或停靠的批次时，如果 `mergeSlotUntil` 剩余不足约 20 分钟，就 touch running 一次。这正是 “CI 正在它的 PR 上报告”，仍受硬上限和租约约束。没有在跑批次时不延长，空闲 PR 照旧到时让位。

本次没做，理由有二：现场两次都不是这个窗口；它会改变第 10 段多个已钉住测试的写入计数，需要单独审查。
