# Clued Zero-Memory Structural Preflight v0.2

**性质：** 结构预演，不是最终 ≥3 Qualified Agent Gate。

**结果：** `FAIL_EXPECTED_BOOTSTRAP_GAPS` — **16/25** 项结构上可回答。

本轮新增结构来源：

- `artifacts/priorities/bootstrap-context.json`
- `docs/governance/priorities/fresh-agent-recovery-contract.md`
- Repository root `README.md` 的多轨入口

| ID | 恢复问题 | 结果 | 证据 / 缺口 |
|---|---|---|---|
| `ZM01` | 当前 Workspace / Project 是什么？ | ✅ | Snapshot identity is Clued governance inventory |
| `ZM02` | 有哪些一级 Track？ | ✅ | 工程与平台；产品与体验；基础研究；商业与增长 |
| `ZM03` | 每条 Track 当前目标是什么？ | ✅ | `bootstrap-context.json.track_goals` 已显式记录四轨目标 |
| `ZM04` | 有哪些当前 Program / Initiative？ | ✅ | 49 items registered |
| `ZM05` | 哪些真正完成？ | ✅ | Snapshot 已记录 `✅ COMPLETED` 项 |
| `ZM06` | 哪些进行中？ | ✅ | Snapshot 已记录 `◐ IN_PROGRESS` 项 |
| `ZM07` | 哪些待验证？ | ✅ | Snapshot 已记录 `🔎 VERIFYING` 项 |
| `ZM08` | 哪些阻塞？ | ✅ | Snapshot 已记录 `⛔ BLOCKED` 项 |
| `ZM09` | 哪些 READY？ | ✅ | Snapshot 已记录 `○ READY` 项 |
| `ZM10` | 每条 Track 的 Priority Frontier 是什么？ | ✅ | Frontier 已记录 |
| `ZM11` | 为什么这样排序？ | ✅ | Item 均有 `why` 语义 |
| `ZM12` | 依据哪些 Canonical Decision / Baseline / Contract？ | ❌ | 已有 source projection，但尚未为全部 Item 规范化 exact source/event/receipt |
| `ZM13` | 谁依赖谁？ | ✅ | `depends_on` 已存在 |
| `ZM14` | 谁阻塞谁？ | ✅ | `blocked_by` 已存在 |
| `ZM15` | 哪些只是影响关系但不是硬依赖？ | ✅ | `bootstrap-context.json.impact_edges` 已区分 typed non-hard impact |
| `ZM16` | 哪些可以并行？ | ✅ | `parallel_policy` + `resource_conflicts` 已显式记录条件并行与共享资源冲突 |
| `ZM17` | 最近什么正式变化触发了 Priority Reconciliation？ | ❌ | 缺 authoritative `trigger_event / PriorityReconciliationReceipt` |
| `ZM18` | 有哪些未批准 Replan Proposal？ | ❌ | Bootstrap Replan Registry 已存在但不是 Canonical；只能回答“本投影未表示 open proposal”，不能证明 Canonical 没有 |
| `ZM19` | 当前 Agent 被授权看到什么？ | ❌ | 缺 principal-specific visibility projection |
| `ZM20` | 当前 Agent 被授权做什么？ | ❌ | 缺 authenticated authority binding / eligible actions |
| `ZM21` | 明确不能做什么？ | ✅ | `authority_projection.forbidden_actions` 已规范化：Repository Projection 不授予生产/数据库/发布/部署/Secret/预算/Canonical 写权限，也不能把 READY 当执行授权 |
| `ZM22` | 哪些高优先项不属于当前 Agent Scope？ | ❌ | 缺 authenticated agent scope binding |
| `ZM23` | Priority Snapshot 是否仍 Current？ | ❌ | Snapshot 明确 `UNKNOWN_UNTIL_CANONICAL_VERIFIED`；尚缺 CurrentnessReceipt / Canonical watermark |
| `ZM24` | Repository / Projection 是否落后？ | ❌ | Repository Projection 已存在，但仍缺与 authoritative Canonical watermark 的比较 |
| `ZM25` | 下一项合法动作是什么？ | ❌ | 已固定解析规则，但仍需要 authenticated Authority + Currentness + resource availability 才能给出合法动作 |

## 当前能安全回答的内容

fresh Agent 仅凭仓库投影现在已经能够恢复：

- Clued 当前四条长期 Track；
- Track 目标；
- 49 个 Program / Priority Item；
- `✅ / ◐ / 🔎 / ⛔ / ○ / ⏳ / ↘ / ☐` 状态；
- Current Priority Frontier；
- Why；
- Hard Dependency / Blocker；
- Non-hard Cross-Track Impact；
- Conditional Parallelism / Resource Conflict；
- Repository Projection 明确禁止推导出的 Authority。

## 仍不能假装知道的内容

剩余缺口主要已经收敛到 **Authority + Currentness + Formal Reconciliation**：

1. 全量 exact Canonical source / Event / Receipt normalization；
2. latest authoritative `trigger_event + PriorityReconciliationReceipt`；
3. authoritative Replan Proposal registry；
4. principal-specific Visibility / Resource×Action + selector/scope；
5. current Agent Scope / Assignment；
6. CurrentnessReceipt / Canonical watermark；
7. Repository projection watermark comparison；
8. eligible-next-action resolution。

## 下一阶段

先补能够自动取得的 Canonical / Authority read projection；取不到时保持 `UNKNOWN / FAIL-CLOSED`，不要求用户人工整理证据。

最终再由系统自动选择至少 3 个 qualified fresh-context Agent Runs，完成 Zero-Memory Multi-Agent Recovery Gate；不写死模型品牌，也不要求用户手工开启多个 Agent。