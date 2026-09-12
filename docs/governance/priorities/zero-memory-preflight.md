# Clued Zero-Memory Structural Preflight v0.3

**性质：** 结构预演，不是最终 ≥3 Qualified Agent Runtime Gate。

**结果：** `FAIL_EXPECTED_RUNTIME_GAPS` — **20/25** 项在“Repository + 明确 Runtime Resolver Contract”条件下可安全恢复或解析。

本轮新增结构来源：

- `docs/governance/priorities/authority-currentness-contract.md`
- `artifacts/priorities/authority-currentness-contract.json`
- `artifacts/priorities/projection-watermark.json`
- 生产 `clued-prod` 只读 Schema 映射：Binding / Authorization / Membership / Development Grant / Receipt

> 结构 PASS 不等于当前 Agent 已经取得真实 Authority。需要真实 Principal 的项，Repository-only 状态必须返回 `NOT_RESOLVED / FAIL_CLOSED`；最终 Gate 仍要在授权测试身份中自动执行。

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
| `ZM12` | 依据哪些 Canonical Decision / Baseline / Contract？ | ❌ | 关键 source 已 materialize，但尚未为全部 49 项规范化 exact Canonical Event / Receipt / digest |
| `ZM13` | 谁依赖谁？ | ✅ | `depends_on` / cross-track map |
| `ZM14` | 谁阻塞谁？ | ✅ | `blocked_by` |
| `ZM15` | 哪些只是影响关系但不是硬依赖？ | ✅ | `bootstrap-context.json.impact_edges` |
| `ZM16` | 哪些可以并行？ | ✅ | `parallel_policy + resource_conflicts` |
| `ZM17` | 最近什么正式变化触发了 Priority Reconciliation？ | ❌ | 尚无 authoritative `trigger_event / PriorityReconciliationReceipt` |
| `ZM18` | 有哪些未批准 Replan Proposal？ | ❌ | Bootstrap Registry 能表示本投影，但尚不能证明 Canonical authoritative registry 无 open proposal |
| `ZM19` | 当前 Agent 被授权看到什么？ | ✅ | 已定义 exact runtime resolver：Binding → Authorization → Membership → Development Grant → visibility；Repository-only 正确结果为 `NOT_RESOLVED` |
| `ZM20` | 当前 Agent 被授权做什么？ | ✅ | `authorization_effective_actions_v13` + Binding/Membership/Grant intersection 已进入合同；无真实 credential 时 `eligible_actions=[]` |
| `ZM21` | 明确不能做什么？ | ✅ | Repository 不授予生产/数据库/部署/发布/Secret/预算/Canonical 写权限；READY/Assignment 均不等于 Authority |
| `ZM22` | 哪些高优先项不属于当前 Agent Scope？ | ✅ | `development_grants_v14` 提供 context/binding/actions/object/field/history/version/expiry scope；Runtime 未绑定时返回 `SCOPE_NOT_RESOLVED` |
| `ZM23` | Priority Snapshot 是否仍 Current？ | ❌ | Currentness 模型已定义，但缺该 Priority Snapshot 的 authoritative `CurrentnessReceipt / dependency watermark verification`；当前安全答案为 `UNKNOWN` |
| `ZM24` | Repository / Projection 是否落后？ | ✅ | `projection-watermark.json` 可检测仓库投影自身 drift；它明确不冒充上游 Canonical Currentness |
| `ZM25` | 下一项合法动作是什么？ | ❌ | 计算公式已固定，但必须有真实 Authority + Development Grant + resource availability + `currentness=CURRENT` 才能产出 side-effect action |

## 当前已经能安全恢复的内容

fresh Agent 现在可以仅靠 Repository + Resolver Contract 知道：

- Clued 四条长期 Track 与目标；
- 49 个 Program / Priority Item；
- 完成 / 进行 / 验证 / 阻塞 / READY / WAITING / DEFERRED 状态；
- Current Priority Frontier 与 Why；
- Hard Dependency / Blocker；
- Typed non-hard impact；
- Conditional parallelism / shared-resource conflict；
- Repository Projection 是否发生内部 Drift；
- 应到哪里解析 Principal / Binding / Membership / Development Grant / Effective Actions；
- 未认证时必须返回什么 fail-closed 结果；
- Repository 明确不能授予哪些 Authority。

## 剩余 5 项

现在缺口只剩：

1. `ZM12` — 全量 exact Canonical source / Event / Receipt normalization；
2. `ZM17` — authoritative `trigger_event + PriorityReconciliationReceipt`；
3. `ZM18` — authoritative Replan Proposal registry；
4. `ZM23` — Priority Snapshot CurrentnessReceipt / dependency watermarks；
5. `ZM25` — 在真实授权测试身份下计算 eligible next action。

## Final Gate 边界

`20/25` 是结构与解析合同的 Bootstrap 成熟度，不是最终通过。

最终仍必须由系统自动选择至少 3 个 qualified、fresh-context、隔离 Agent Runs，在合法测试 Binding / Authority 下执行 Zero-Memory Recovery；模型/Provider 不写死，用户不手工开 Agent、不复制粘贴结果、不整理 Evidence。
