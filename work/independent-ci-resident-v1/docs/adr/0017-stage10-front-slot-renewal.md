# ADR 0017：第 10 段为等车头的队首续期合并位

- 状态：生效（第 28 代，未安装）
- 日期：2026-11-08
- Owner Decision：无单独编号；Owner 在第 28 代任务中要求补这个缺陷（“缺陷必须修”）。
- 来源：[ADR 0016](0016-front-requeue-on-new-head.md) 末节“仍然存在的真正 45 分钟窗口”；2026-11-07 夜间现场需要人手续期。
- 代码：`CI/src/independent-control-checks-v2/train-maintenance.mjs#renewFrontSlot`（`SLOT_RENEW_BELOW_MS` = 20 分钟）。
- 测试：`CI/test/train-sweep.test.mjs`，“gen 28 field gap”和另外两例 gen 28（修复前三例都失败；第一例修复前第三轮就是 `NO_FRONT`，车头丢了）。

## 背景

合并位只有两种方式能推后到期时间：持有者续期，和 `clued_work_merge_slot_touch_v1`。常驻 CI 原来只在三处调用 touch：

- 第 10 段 `openFront` 的 touch running；
- 车头批次第 1 段的 touch running；
- 第 8 段的 touch green。

认领成为队首（`merge_slot_at`）以后，到第 10 段 `OPEN_FRONT_BATCH` 之前，没有任何调用会延长合并位。下面两种情况都会让合并位在 45 分钟后到期，车头随之丢失：

- 第 10 段长时间排不到，因为别的 PR 的批次占着执行器；
- 第 10 段一直给出不 touch 的结论，例如 `TRAIN_TAKEOVER_SWEEP_PENDING`、`TRAIN_SWEEP_INCOMPLETE`、`TRAIN_REVOKE_UNCONFIRMED`、`TRAIN_FRONT_NOT_PROVEN`。

车头批次已经开了、但在第 8 段停靠很久时，也有同样的问题：openFront 给的 90 分钟 running 时钟会走完。

## 决定

第 10 段（只在 on 模式、当班、本轮没有请求 PAUSE 时）在得出结论之后，如果下面各条**全部**成立，就用 CI 身份调一次 `touch running`。写法与 openFront 相同：`{pr, headSha, ciState: 'running', hardCapMinutes: slotHardCapMinutes}`。

1. holders 正好一个，并且已经绑定到本仓库的 PR。Native 的 touch 按 `bound_pr` 匹配，未绑定的队首走 §62.4 的绑定路径。
2. PR 开着、没有合并、head 已知。
3. head 上没有绿：
   - GitHub 上没有 App 5368905 的 `kooyumi-merge-slot` 成功；
   - Native 的 CI 状态不是这个 head 的 green。第 8 段的 30 分钟 green 时钟是留给合并的，touch running 会把它换掉。
4. 二者满足其一：
   - **车头批次在跑或停靠**：本节点这个 head、这个认领的最新车头批次，执行器还没报告结束（没有对应的 frontOutcome），而且 Native 的 CI 时钟正跑在这个 head 上；
   - **在等车头**：`wouldDo` 是 `OPEN_FRONT_BATCH`，并且硬上限还够车头批次的预算，也就是 `frontBatchBudgetMs` + 一次第 8 段尝试 + 余量。这个预算和 `frontBatchPlan` 用的相同。
5. 合并位剩余不足 20 分钟，但还活着。touch 不会让已经到期的合并位复活。
6. 硬上限（从取得合并位起算）比当前到期时间更晚，否则 touch 推不动它。
7. 本轮还没有写过合并位：openFront 的 touch running 和 touch failed 都算。**每轮最多一次。**

应答处理：

- 应答说不当班：结论改为 `NOT_ON_DUTY`，不做账本清理；
- 推后了：`actions.touchedRunning = true`。facts 契约不变，常驻层只拿它做展示；
- 读不了：按“可能写了”计入 sideEffects，下一轮读结果。

## 理由

- **这正是 touch 的本意**：“CI 正在它的 PR 上报告”。常驻 CI 正在为这个车头工作，要么在等它的车头批次，要么车头批次在跑。
- **约束全部保留**：
  - 服务端照旧受硬上限约束（从取得合并位起 60–180 分钟）和认领租约约束；
  - 20 分钟的阈值让每个 90 分钟时钟至多续一次；
  - 每轮最多一次 touch，不会和 openFront、touch failed 叠加。
- **空闲的车头不续**：草稿、已关闭、冲突、没合入 main、已经绿、硬上限内已经开不了车头批次（永远 `TRAIN_FRONT_BUDGET_SHORT`）的，都照旧到时让位，后面的认领不会被拖住。
- **只改 Source v2**：
  - 不改服务端；
  - 不改 train-run / train-facts 契约；
  - 不改常驻层和 C# 边界。

## 后果

- 第 10 段的 Native 写入次数有变化：等车头且剩余不足 20 分钟的轮次多一次 touch。下面这些钉住写入次数的测试已逐个改过，并写明是续期：
  - `train-sweep.test.mjs` 的 “an unconfirmed revocation”；
  - “full sweep: segmented over runs” 的第一轮；
  - “front batch refused” 的 torn 一例。

  `train-strict-front`、`train-run` 和常驻层的列车测试（`train-on`、`train-takeover-front`、`engine-v2` 等）不受影响，它们的合并位剩余都大于 20 分钟。
- 已知残余：
  - 一次没报 frontOutcome 就结束的车头批次（基础设施失败），本来就“按在跑处理，直到 running 时钟或合并位结束”。现在续期会让它保持到硬上限，最多 180 分钟，第二次尝试要等到那时。上限由服务端保证。
  - `FRONT_NOT_BOUND`（队首未绑定 PR）不能用 touch 续期，仍靠 §62.4 的绑定尽快完成。
- 回滚：去掉 `renewFrontSlot` 的调用即可，没有状态迁移。
