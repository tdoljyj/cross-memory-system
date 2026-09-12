# Clued 多轨优先级治理引擎 v0.2.1 · 固定语义持久化投影

**Baseline ID：** `CLUED-MULTI-TRACK-PRIORITY-GOVERNANCE-ENGINE-v0.2.1-20260912`  
**治理状态：** `OWNER-FIXED DESIGN BASELINE / FROZEN / NOT IMPLEMENTED`  
**本文件身份：** `POST-DECISION PERSISTENT PROJECTION / NOT A NEW AUTHORITY`  
**投影生成日期：** 2026-09-12

> 本文件不是伪造的历史原件，也不声称自己就是原始 Canonical Event / Receipt。
> 它用于把已经由 Owner 明确固定的 v0.2.1 语义持久化，使 fresh Agent 不必依赖私人聊天记忆。
> Authority 仍来自原 Owner 决定及未来绑定的 Canonical Event / Receipt。

## 1. 核心定义

Clued 多轨优先级治理引擎是：

> 一个基于当前正式现实、可配置长期轨道、跨轨依赖、Authority、资源、完成状态和执行约束，持续维护并解释“现在最应该推进什么”，并把所选工作自动转化为最低必要成本执行计划的动态治理系统。

它不是 Todo List、普通 Roadmap、单一项目管理器，也不是一张静态 P0/P1/P2 列表。

## 2. 多轨结构

平台支持用户自定义：

- Track 数量；
- Track 名称与目的；
- Track Scope；
- Owner；
- Priority Policy；
- Automation Policy；
- Success Metrics；
- Resource Profile；
- Cross-Track Relations。

层级：

`Workspace → Governance Profile → Track → Subtrack → Program / Initiative / Priority Item`

官方模板只用于初始化，不形成 Authority。

## 3. Clued Dogfood 初始四轨

1. **Engineering & Platform / 工程与平台**
2. **Product & Experience / 产品与体验**
3. **Foundational Research / 基础研究**
4. **Business & Growth / 商业与增长**

Brand / Visual 当前作为 Product & Experience 子轨，不强制升一级 Track。

## 4. Priority 语义

不同 Track 可以使用不同优先级规则，例如：

- 工程：Correctness、Security、Blocker、Dependency、Risk、Reliability；
- 产品：User Value、Strategic Value、Validation、Adoption、Timing；
- 研究：Foundational Importance、Open Question Severity、Engineering Dependency、Research Leverage；
- 商业：Strategic Value、Revenue Potential、Market Timing、Validation Need。

系统不建立虚假的统一 1-N 总排行榜，而维护 **Current Priority Frontier**。

## 5. Cross-Track Graph

至少支持：

`DEPENDS_ON / BLOCKS / UNLOCKS / INFORMS / CONSTRAINS / VALIDATES / SUPERSEDES / CONFLICTS_WITH / USES_RESULT_OF / RESOURCE_COMPETES_WITH / PRODUCTION_APPLICABLE_TO`

此前“理论成果 → 工程应用映射”继续作为 Cross-Track Graph 的一等关系类型存在。

## 6. Canonical Change 与动态重排

以下正式变化可触发 Priority Reconciliation：

- Decision committed；
- Baseline frozen；
- Contract changed；
- Research stable result accepted；
- Verification completed；
- Item completed；
- Authority changed；
- Resource availability changed；
- Milestone / Deadline / Risk / Dependency changed。

流程：

`Canonical Trigger → Classification → Impact Detection → Dependency/Blocker Recalculation → Completion Update → Local Priority Recalculation → Resource/Cross-Track Analysis → Priority Diff → Authority Evaluation → New Snapshot`

## 7. Authority 边界

多轨引擎不得建立第二套 Authority。

它直接复用 Clued 已确认的：

`成员 → 一个或多个项目组 → 项目组权限`

权限表达：

`Resource × Action + selector / scope`

Owner Ownership Authority 与普通 Operational Permission 分离。

Agent 可以分类、分析、生成 Priority Diff 和 Replan Proposal，但重大优先级变化不得静默应用。

## 8. 完成态

用户可见至少：

- `☐ NOT_STARTED`
- `○ READY`
- `◐ IN_PROGRESS`
- `⏳ WAITING`
- `⛔ BLOCKED`
- `🔎 VERIFYING`
- `↘ DEFERRED`
- `✅ COMPLETED`
- `⊘ CANCELLED`

`✅ COMPLETED` 只有在适用的：

`Completion Criteria + Exact Target + Deliverable/Implementation + Required Verification + Required Gate + Evidence + Receipt/Closeout`

成立后才能产生。

完成项保留历史，退出当前 READY / Frontier，但继续参与依赖、审计、进度和可复现性。

## 9. Projection

统一关系：

`Canonical Multi-Track State → Projection Compiler → Repository / 印记空间 / Agent Context / Console / API / Public Integration Projection`

所有 Projection 都不是 Authority。

本地修改 Projection 不反向改变 Canonical，应被检测为 `PRIORITY_PROJECTION_DRIFT`。

## 10. 公开集成仓库与 Thin Skills

采用：

`Closed Core + Thin-Open Integration`

Public / Internal / Operator Skills 必须分离。

公共导出采用 Explicit Allowlist Export。

普通用户长期 Runtime 不依赖 Repository；Repository 属于 Integration / Distribution / Developer Control Plane。

## 11. Clued Connect / Integration Lifecycle

长期生命周期包括：

`Install / Update / Repair / Reauthorize / Verify / Revoke / Status`

每个 Agent / Installation 使用独立 Binding，不自动继承其他 Agent Authority。

READY 必须来自真实 Verification，而不是 Agent 自报。

## 12. SDD 与 Execution Plan

关系固定为：

`Canonical Reality → Multi-Track Priority Governance → Selected Priority Item → Execution Plan Generation → Clued SDD → Human/Agent Execution → Review/Verification/Evidence/Receipt → Canonical Transition → Priority Reconciliation`

- 多轨引擎负责“现在做什么”；
- Execution Plan Generation 负责把被选事项变成最低必要成本、可分派、可复核、可追踪的验收执行计划；
- SDD 负责“如何可靠完成”。

Execution Plan Generation 不等于 SDD Technical Plan。

## 13. 执行计划原则

优先级：

`用户当前明确指令 > 已确认验收范围 > 成本效率`

但只在当前可变 Scope 内成立，不得突破：

`Frozen / Canonical Contract / Safety / Authority / Security / Compliance`

默认：

- P0 详细展开；
- P1/P2 可裁剪；
- 复用已有环境、数据、脚本和日志；
- 禁止无变化机械重试；
- Evidence 不足不得 PASS；
- 局部未知不得阻断所有无关路径。

## 14. 最小用户负担

根原则：

> 系统能够自动完成的检查、测试、比较、重试、Evidence 生成与报告，不得转嫁给用户。

Human Burden：

- H0 完全自动；
- H1 一次简单确认；
- H2 必要 Authority / 价值判断；
- H3 外部系统强制人工步骤。

H3 被视为产品体验债务。

## 15. Zero-Memory Multi-Agent Recovery

最终正式测试至少使用：

`qualified_agent_runs >= 3`

具体 Agent / Provider / Model 不写死。

要求：

- fresh context；
- isolated execution；
- automated orchestration；
- automated evidence；
- canonical fact agreement；
- completion state agreement；
- priority state agreement；
- authority resolution；
- eligible next action resolution；
- manual user test labor not required。

## 16. Bootstrap 与 Dogfood

正式 Runtime 建成前使用 Bootstrap Registry，作为机器可读治理投影，不是第二 Canonical。

M0 必须建立 Current Governance Inventory，而不是只登记多轨引擎自己。

多轨引擎自身登记为：

`CLUED-GOV-MTPE-001`

并由多轨机制持续 Dogfood。

## 17. Health / Recovery

多轨引擎自身必须覆盖：

- classification failure；
- dependency cycle；
- graph corruption；
- policy conflict；
- stale graph；
- projection lag；
- snapshot corruption；
- concurrent replan；
- partial reconciliation；
- authority revoked mid-replan；
- resource state stale；
- reconciliation timeout。

保留 Last Known Good Snapshot；Currentness 无法证明时，高风险正式动作 fail-closed。

## 18. 固定解释边界

1. `Execution Plan Generation ≠ SDD Technical Plan`。
2. `VERIFYING → ✅ COMPLETED` 仅在 deterministic completion contract、required evidence/gates/receipt 与既有 Authority 全满足时可自动发生。
3. 重大变化仅在现有 Delegated Authority / Policy 不足以覆盖时才请求用户 / Owner，不得增加不必要人工负担。
4. 本基线冻结不改变当前 Kernel Phase 2 顺序，也不产生生产实施 Authority。
