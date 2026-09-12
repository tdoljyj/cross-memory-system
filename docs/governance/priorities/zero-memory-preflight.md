# Clued Zero-Memory Structural Preflight v0.1

**性质：** 结构预演，不是最终 ≥3 Qualified Agent Gate。

**结果：** `FAIL_EXPECTED_BOOTSTRAP_GAPS` — 12/25 项结构上可回答。

| ID | 恢复问题 | 结果 | 证据 / 缺口 |
|---|---|---|---|
| `ZM01` | 当前 Workspace / Project 是什么？ | ✅ | Snapshot identity is Clued governance inventory |
| `ZM02` | 有哪些一级 Track？ | ✅ | 工程与平台；产品与体验；基础研究；商业与增长 |
| `ZM03` | 每条 Track 当前目标是什么？ | ❌ | 缺显式 track_goal / mission |
| `ZM04` | 有哪些当前 Program / Initiative？ | ✅ | 49 items registered |
| `ZM05` | 哪些真正完成？ | ✅ | Snapshot 已记录 `✅ COMPLETED` 项 |
| `ZM06` | 哪些进行中？ | ✅ | Snapshot 已记录 `◐ IN_PROGRESS` 项 |
| `ZM07` | 哪些待验证？ | ✅ | Snapshot 已记录 `🔎 VERIFYING` 项 |
| `ZM08` | 哪些阻塞？ | ✅ | Snapshot 已记录 `⛔ BLOCKED` 项 |
| `ZM09` | 哪些 READY？ | ✅ | Snapshot 已记录 `○ READY` 项 |
| `ZM10` | 每条 Track 的 Priority Frontier 是什么？ | ✅ | Frontier 已记录 |
| `ZM11` | 为什么这样排序？ | ✅ | Item 均有 `why` 语义 |
| `ZM12` | 依据哪些 Canonical Decision / Baseline / Contract？ | ❌ | 尚未为全部 Item 规范化 exact source/event/receipt |
| `ZM13` | 谁依赖谁？ | ✅ | `depends_on` 已存在 |
| `ZM14` | 谁阻塞谁？ | ✅ | `blocked_by` 已存在 |
| `ZM15` | 哪些只是影响关系但不是硬依赖？ | ❌ | typed impact edges 尚未并入主 Snapshot |
| `ZM16` | 哪些可以并行？ | ❌ | 缺 parallel/resource metadata |
| `ZM17` | 最近什么正式变化触发了 Priority Reconciliation？ | ❌ | 缺 trigger_event / reconciliation receipt |
| `ZM18` | 有哪些未批准 Replan Proposal？ | ❌ | 缺 Replan registry |
| `ZM19` | 当前 Agent 被授权看到什么？ | ❌ | 缺 principal-specific visibility projection |
| `ZM20` | 当前 Agent 被授权做什么？ | ❌ | 缺 authority binding / eligible actions |
| `ZM21` | 明确不能做什么？ | ❌ | 缺 normalized forbidden-actions projection |
| `ZM22` | 哪些高优先项不属于当前 Agent Scope？ | ❌ | 缺 agent scope binding |
| `ZM23` | Priority Snapshot 是否仍 Current？ | ❌ | 缺 CurrentnessReceipt / canonical watermark |
| `ZM24` | Repository / Projection 是否落后？ | ❌ | 需要 repository projection + watermark comparison |
| `ZM25` | 下一项合法动作是什么？ | ❌ | 需要 authority + currentness + eligible-next-action resolution |

## 结论

当前 Bootstrap Projection 已能恢复 Track、Program、完成/进行/阻塞/READY 状态、Priority Frontier、Why、硬依赖与 Blocker；但还不能在零记忆条件下安全回答 Authority、Agent Scope、Currentness、Replan、非硬影响、并行资源和“下一项合法动作”。

下一轮优先补：

1. exact canonical source/event/receipt normalization；
2. principal-specific Authority / Visibility / Eligible Action projection；
3. trigger_event + PriorityReconciliationReceipt；
4. impact_edges + parallel/resource metadata；
5. repository projection watermark；
6. 最后再跑自动 ≥3 qualified fresh-context Agent Gate。
