# Clued Zero-Memory Structural Preflight v0.4

**性质：** 结构预演，不是最终 ≥3 Qualified Agent Runtime Gate。

**结果：** `FAIL_EXPECTED_RUNTIME_GAPS` — **21/25** 项在“Repository + Source Registry + Runtime Resolver Contract”条件下可安全恢复或解析。

本轮新增：

- `artifacts/priorities/source-registry.json`
- `docs/governance/priorities/source-registry.md`
- 49 / 49 Priority Item 的 normalized exact source / derivation chain

> 结构 PASS 不等于当前 Agent 已经取得真实 Authority，也不等于所有 Canonical Receipt 已齐。缺失 Receipt 必须显式返回 pending / not normalized。

| ID | 恢复问题 | 结构结果 | 证据 / 当前边界 |
|---|---|---|---|
| `ZM01` | 当前 Workspace / Project 是什么？ | ✅ | Snapshot identity is Clued governance inventory |
| `ZM02` | 有哪些一级 Track？ | ✅ | 工程与平台；产品与体验；基础研究；商业与增长 |
| `ZM03` | 每条 Track 当前目标是什么？ | ✅ | `bootstrap-context.json.track_goals` |
| `ZM04` | 有哪些当前 Program / Initiative？ | ✅ | 49 items registered |
| `ZM05` | 哪些真正完成？ | ✅ | Snapshot 已记录 `✅ COMPLETED` |
| `ZM06` | 哪些进行中？ | ✅ | Snapshot 已记录 `◐ IN_PROGRESS` |
| `ZM07` | 哪些待验证？ | ✅ | Snapshot 已记录 `🔎 VERIFYING` |
| `ZM08` | 哪些阻塞？ | ✅ | Snapshot 已记录 `⛔ BLOCKED` |
| `ZM09` | 哪些 READY？ | ✅ | Snapshot 已记录 `○ READY` |
| `ZM10` | 每条 Track 的 Priority Frontier 是什么？ | ✅ | Frontier 已记录 |
| `ZM11` | 为什么这样排序？ | ✅ | Item 均保留 Why / Priority 语义 |
| `ZM12` | 依据哪些 Canonical Decision / Baseline / Contract？ | ✅ | `source-registry.json` 为 49/49 Item 绑定 primary/supporting source、exact SHA/Ref、Authority state 与 Receipt state；缺 Receipt 不伪造 |
| `ZM13` | 谁依赖谁？ | ✅ | `depends_on` / cross-track map |
| `ZM14` | 谁阻塞谁？ | ✅ | `blocked_by` |
| `ZM15` | 哪些只是影响关系但不是硬依赖？ | ✅ | `bootstrap-context.json.impact_edges` |
| `ZM16` | 哪些可以并行？ | ✅ | `parallel_policy + resource_conflicts` |
| `ZM17` | 最近什么正式变化触发了 Priority Reconciliation？ | ❌ | 尚无 authoritative `trigger_event / PriorityReconciliationReceipt` |
| `ZM18` | 有哪些未批准 Replan Proposal？ | ❌ | Bootstrap Registry 能表示本投影，但尚不能证明 Canonical authoritative registry 无 open proposal |
| `ZM19` | 当前 Agent 被授权看到什么？ | ✅ | exact runtime resolver：Binding → Authorization → Membership → Development Grant → visibility；Repository-only 返回 `NOT_RESOLVED` |
| `ZM20` | 当前 Agent 被授权做什么？ | ✅ | Effective Resource×Action + Binding/Membership/Grant intersection；无 credential 时 `eligible_actions=[]` |
| `ZM21` | 明确不能做什么？ | ✅ | Repository 不授予生产/数据库/部署/发布/Secret/预算/Canonical 写权限；READY/Assignment 均不等于 Authority |
| `ZM22` | 哪些高优先项不属于当前 Agent Scope？ | ✅ | `development_grants_v14` 提供 context/binding/actions/object/field/history/version/expiry scope；Runtime 未绑定时 `SCOPE_NOT_RESOLVED` |
| `ZM23` | Priority Snapshot 是否仍 Current？ | ❌ | Currentness 模型已定义，但缺该 Priority Snapshot 的 authoritative `CurrentnessReceipt / dependency watermark verification`；当前安全答案为 `UNKNOWN` |
| `ZM24` | Repository / Projection 是否落后？ | ✅ | `projection-watermark.json` 可检测仓库投影自身 drift；不冒充上游 Canonical Currentness |
| `ZM25` | 下一项合法动作是什么？ | ❌ | 公式已固定，但必须有真实 Authority + Development Grant + resource availability + `currentness=CURRENT` 才能产出 side-effect action |

## ZM12 Source Registry 语义

Fresh Agent 现在可以执行：

```text
Priority Item
→ source-registry item_source_map
→ primary source
→ exact SHA-256 / repository ref
→ supporting / derived-from sources
→ authority_state
→ canonical_receipt state
```

如果 `canonical_receipt=PENDING / NOT_NORMALIZED / PARTIALLY_UNAVAILABLE`，必须原样报告，不能转换为“已 Canonical Freeze”。

## 剩余 4 项

1. `ZM17` — authoritative `trigger_event + PriorityReconciliationReceipt`；
2. `ZM18` — authoritative Replan Proposal registry；
3. `ZM23` — Priority Snapshot CurrentnessReceipt / dependency watermark verification；
4. `ZM25` — 在真实授权测试身份下计算 eligible next action。

## Final Gate 边界

`21/25` 仍只是 Bootstrap 结构成熟度。

最终必须由系统自动选择至少 3 个 qualified、fresh-context、隔离 Agent Runs，在合法测试 Binding / Authority 下执行 Zero-Memory Recovery；模型 / Provider 不写死，用户不手工开 Agent、不复制粘贴结果、不整理 Evidence。