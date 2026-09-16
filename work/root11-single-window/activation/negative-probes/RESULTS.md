# 第 11 代 reserve_gate 负向探针结果

在离线复制品上跑（ICU `en-US` 重建 + 2026-09-16T05:10Z 生产快照 + 迁移 01 + 第 11 代活化）。
**24 条探针全部通过，外加 1 条正向。** 生产库未被触碰。

## 正向

| 用例 | 结果 |
|---|---|
| 合法 GA | `{"status":"RESERVED"}`，attempt PENDING、`budget_sequence=136`、控制器 `fc6ca175…` |

## A 组：只改 GA 输入（12 条）

| 用例 | 变异 | 实际错误 |
|---|---|---|
| N03_NONEMPTY_REPAIR_REFS | `revocation_epoch_vector.repair_refs` 放一条 | `root10_exact_accepted_scope_or_zero_repairs_required` |
| N04_FIXED_DRIFT_controller_digest | 固定字段漂移 | 同上 |
| N04_FIXED_DRIFT_scope_digest | 固定字段漂移 | 同上 |
| N04_FIXED_DRIFT_schema_digest | 固定字段漂移 | `root10_complete_fixed_and_late_bound_ga_contract_required` |
| N04_FIXED_DRIFT_issuer_ref | 固定字段漂移 | 同上 |
| N05_STATUS_WRONG_GENERATION | Status 引用指向第 10 代那份 | `exact_stored_status_manifest_required` |
| N06_BUDGET_WRONG_SEQUENCE | 预算引用指向 117 号 | `root11_exact_prior_committed_budget_required` |
| N07_599_SECONDS | 窗口 599 秒 | `root10_exact_600_second_ga_window_required` |
| N07_601_SECONDS | 窗口 601 秒 | 同上 |
| N14_MISSING_FIELD | 删掉 `dominant_role` | `root10_complete_fixed_and_late_bound_ga_contract_required` |
| N14_EXTRA_FIELD | 多加一个字段 | 同上 |
| N14_BAD_TARGET_REVISION | `target_revision` 不是 40 hex | 同上 |

## B 组：签发之后（3 条）

| 用例 | 变异 | 实际错误 |
|---|---|---|
| N01_CHANGED_BYTES_SAME_IDEMPOTENCY | 同幂等键、改一个字节 | `idempotency_conflict` |
| N02_SECOND_GA | 再签第二个 GA | `root10_exact_single_ga_preimage_required` |
| N10_EXACT_REPLAY | 原样重放 | 返回 `DUPLICATE`（不是错误，是幂等） |

## C 组：改库里的历史（9 条，每条单独重置复制品）

| 用例 | 变异 | 实际错误 |
|---|---|---|
| N11a_ROOT_PREFIX_DRIFT | 改根事件第 6 号 | `series_full_original_root_changed` |
| N11b_EXECUTION_PREFIX_DRIFT | 改执行事件第 44 号 | `series_original_44_events_changed` |
| N12_HISTORICAL_BUDGET_DRIFT | 改第 46 号预算的 `root_generation` | `root10_exact_single_ga_preimage_required` |
| N13_GA6_CLOSURE_DRIFT | 改第 111 号的 `decision_raw` | 同上 |
| N08_HISTORICAL_ATTEMPT_DRIFT | 改六个钉死 attempt 之一的收据 | `series_original_six_attempts_changed` |
| N09_NONTERMINAL_HISTORICAL_PHASE | 把一个历史 attempt 改成 RUNNING | `root10_exact_single_ga_preimage_required` |
| **N16_TERMINATED_PHASE_DRIFT** | 把被终止的 attempt 改成 BLOCKED | 同上 |
| **N17_TERMINATED_RECEIPT_INJECTED** | 给被终止的 attempt 塞一张收据 | 同上 |
| **N18_TERMINATION_EVENT_DRIFT** | 改第 131 号终止事件的 `counters_unchanged` | 同上 |

最后三条是专门针对迁移 01 开出的那个例外设计的：它必须窄到**改一个字节就失效**。结果确认如此。

## 两条没在这里覆盖的

- **N15_CONTAINER_PHASE_MACHINE_DRIFT** 测的是 `execution_transition` 的容器相位机，
  不属于 `reserve_gate`，本轮未改动那个函数。
- C 组的 update 都要临时停用不可变触发器。**这类操作只在复制品上做，生产库上绝不做。**
