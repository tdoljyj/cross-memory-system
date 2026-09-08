# Clued Phase 2 Kernel Stability Hardening 横向接入执行方案 v0.1

- 文档类型：横向接入执行方案（Design + Execution Plan）
- 日期：2026-09-08
- 状态：FORMAL EXECUTION BASELINE / FROZEN（正式固定；执行时必须绑定本文件精确 SHA-256）
- Baseline ID：`CLUED-PHASE2-KERNEL-STABILITY-HARDENING-INTEGRATION-v0.1-20260908`
- 适用范围：Clued Phase 2 / Kernel Next 相关结构治理、开发控制面迁移、Runtime Consumer 接线、Shadow、Health、非生产 Repairability 验证
- 直接约束：不得改变当前已经固定的 Phase 2 21 步治理顺序；不得新增 A12/A13 等新的大批 P0；不得抢占当前 R07–R10 / A01–A11 P0 收口优先级；不得建立第二套 Authorization、Receipt、Canonical Store 或 Surgical Authority。
- 冻结规则：2026-09-08 最终复核通过后，本 Baseline 仅绑定本文件精确字节；任何后续内容修改必须升版、重新复核并重新计算 SHA-256，不得以同名不同字节文件替代。

---

## 0. 执行结论

本方案不是在 Phase 2 后面新增一个“稳定性阶段”，也不是再建立一套独立 Kernel。

它的定位固定为：

> **Kernel Stability Hardening 是贯穿 Phase 2 的横向质量、安全与可恢复性约束。Structure Freeze 前定义“稳定意味着什么”，Structure Freeze 后实现“怎样保证稳定”，Runtime 接线后观察“实际上稳不稳”，非生产 Evidence 完整后验证“发生故障还能不能安全恢复”。**

唯一推荐执行形态：

```text
Phase 2 Step 1–4
风险盘点，不大改架构
        ↓
Step 5–8
Stability Contract Draft + 负例设计
        ↓
Step 9–11
独立审查 → Architecture Acceptance → Structure Freeze
        ↓
Stability Contract Freeze / 与 HS-0 对齐
        ↓
Step 12–16
真正实施 Kernel Hardening
        ↓
R11 Shadow
        ↓
HS-1 Kernel Health Shadow
        ↓
Step 17–18
Tooling / Console / Evidence / Named Approval
        ↓
HS-2 非生产 Surgical Drill
        ↓
Slice A 验收 + HS-2.5 Repairability Gate
        ↓
Step 19–20
冻结后治理 / 第一批 Product Input
        ↓
Step 21
Architecture Re-acceptance / Release Gate
        ↓
仅在既有条件全部满足后
HS-3 Controlled Surgical Lane
```

当前最高优先级仍然保持：

```text
R07–R10 / A01–A11 P0 收口
```

本方案当前只允许在不阻塞上述收口的前提下开展准备、盘点、合同草案和负例设计。

---

# 1. 目的

本方案解决的不是“让服务永远不报错”，而是把 Clued Kernel 的稳定性工程化，使其具备以下性质：

1. 同一个逻辑操作无论被提交一次还是重复提交多次，都不会产生重复 Canonical Fact。
2. 客户端超时、网络重试、Worker 重放、checkpoint 重复提交不能静默扩大副作用。
3. 并发写入不能使用 last-write-wins 静默覆盖 Canonical State。
4. 非法状态迁移不能进入 Canonical Store。
5. Authorization 异常、不确定或失配时默认 fail-closed。
6. 每一个高价值 Canonical Mutation 都能绑定可复验的 Receipt。
7. Projection、Cache、Search Index、Mirror 等派生层出现漂移时能够被发现，而不能反向成为 Canonical Truth。
8. 故障发生时可以快速进入 Safe State，并把事故半径控制在最小范围。
9. Kernel 的“可修复性”可以通过非生产演练证明，而不是依赖事故发生后临时手工改库。
10. Stability、Health、Surgical 三者复用同一套 Identity / Authorization / Receipt / Finding / Evidence 语义，不形成第二套控制面。

---

# 2. 非目标

本方案明确不做以下事情：

- 不重写整个 Kernel。
- 不因为稳定性目标增加 A12、A13 等新的大批 P0。
- 不改变 Phase 2 已固定的 21 步治理顺序。
- 不提前开放生产 Surgical Authority。
- 不建立 Break-glass 永久超级权限。
- 不允许 Health 或 Stability 层直接创造新的业务事实。
- 不允许 MCP、Skill、Console、Agent、Worker 获得独立于 Kernel 的 Authority。
- 不把 Projection、Search、Cache、Receipt Mirror 变成第二 Canonical Store。
- 不为了“容错”允许 silent repair、silent overwrite、silent privilege expansion。
- 不把计划内开发、重构、Migration、版本升级伪装成 Surgical Repair。
- 不要求当前 P0 在 Phase 2 Structure Freeze 前一次性实现全部 S1–S7。

---

# 3. 稳定性的正式定义

Clued Kernel 的稳定性不以 `/health = 200`、进程不崩溃或“最近没事故”为充分条件。

本方案把 Kernel Stability 定义为以下七项能力的交集：

```text
Kernel Stability
=
Deterministic Command
∩ Idempotent Retry
∩ Concurrency Safety
∩ State / Invariant Safety
∩ Receipt Traceability
∩ Fail-Closed Containment
∩ Detectable / Repairable Operation
```

对应七个能力域：

- `S1 — Deterministic Command`
- `S2 — Idempotency / Retry Safety`
- `S3 — Revision CAS / Concurrency Safety`
- `S4 — Canonical State Machine & Invariants`
- `S5 — Receipt / Replay / Traceability`
- `S6 — Fail-Closed & Blast-Radius Control`
- `S7 — Stability Signals & Repairability`

这七项是方案内的能力域，不是新的 Phase 2 大阶段，也不是新的 Authority。

---

# 4. 根原则

## 4.1 单一 Canonical 写链

所有真实 Canonical Mutation 最终必须经过同一语义链：

```text
Request / Trigger
↓
Command Envelope
↓
Identity / Authentication
↓
Authorization Decision
↓
Mutation Preconditions
↓
Expected Revision / CAS
↓
Invariant Check
↓
State Transition Decision
↓
Canonical Commit
↓
Receipt
↓
Projection / Outbox / Derived Views
```

任何以下路径在 Step 14 以后都不得绕过这条链：

- API 直接改数据库；
- MCP 直接改数据库；
- Console Admin hidden write；
- Agent 自己拼状态；
- Worker 使用特殊 SQL 修改 Canonical State；
- Legacy endpoint 绕过 Authorization / CAS / Invariant；
- Projection 回写 Canonical Truth。

## 4.2 Stable-by-construction 优先于 Crash-recovery

优先级固定为：

```text
先阻止非法状态形成
>
再检测异常
>
再安全收窄
>
最后才修复
```

## 4.3 Fail-closed 优先于猜测继续

当 Kernel 无法确定以下任一条件时，不得“尽力继续写”：

- Principal Identity；
- Authorization；
- Target Canonical Identity；
- Expected Revision；
- State Transition Legality；
- Required Registry / Policy Revision；
- Receipt Binding；
- Critical Invariant。

允许的安全结果包括：

```text
DENY
CONFLICT
READ_ONLY
PAUSE
DISABLE
ISOLATE
REVOKE
RETRY_LATER
```

禁止结果包括：

```text
SILENT_ALLOW
SILENT_OVERWRITE
BEST_GUESS_MUTATION
AUTO_PRIVILEGE_EXPANSION
```

## 4.4 稳定性不能扩大 Authority

`idempotency_key`、`operation_id`、retry token、checkpoint identity、Receipt ID、Health Finding ID 都不是授权凭据。

实际 Authority 始终由既有 Kernel Authorization 决定。

---

# 5. S1 — Deterministic Command

## 5.1 目标

把“一个副作用操作”从模糊 HTTP/Tool 调用提升为可唯一识别、可比较、可复验的 Kernel Command。

## 5.2 Command Envelope 最小合同

适用的 Canonical Mutation 应具备等价于以下语义字段：

```text
command_id
operation_id
idempotency_key
actor_principal_id
subject_principal_id              # 如适用
capability / action
scope
resource_type
target_object_id                  # create 时可为空或使用预分配 identity
environment
expected_revision                 # create 可表达 EXPECT_ABSENT
command_schema_revision
policy / registry binding         # 按既有治理模型绑定
correlation_id
request_fingerprint
issued_at / observed_at           # 仅用于证据，不参与不安全的业务猜测
```

具体字段名可由现有代码风格调整，但语义不得缺失。

## 5.3 operation_id 与 command_id

推荐区分：

- `operation_id`：用户或上层系统认为的“同一个逻辑操作”。
- `command_id`：一次具体 Command 实例身份。

同一个逻辑操作因网络重试产生多个传输请求时，不应因此产生多个 Canonical Operation。

## 5.4 request_fingerprint

对影响幂等语义的关键输入生成确定性 fingerprint。

同一个 `idempotency_key`：

- fingerprint 相同：视为同一逻辑操作重试；
- fingerprint 不同：必须拒绝为 `IDEMPOTENCY_KEY_REUSE_CONFLICT` 或等价错误；不得把第二份 payload 当成更新。

---

# 6. S2 — Idempotency / Retry Safety

## 6.1 基本不变量

对于同一逻辑 Canonical Operation：

```text
execute once
≡
execute N times
```

这里的“等价”至少包括：

- Canonical State 不重复；
- Revision 不无意义增加；
- Receipt 不产生互相冲突的多个成功事实；
- 外部副作用不会因 transport retry 被重复放大；
- Projection 最终与单次执行相同。

## 6.2 Idempotency Record

需要存在 durable 的幂等记录或等价能力，至少表达：

```text
idempotency_scope
idempotency_key
request_fingerprint
operation_id
status
canonical_result_identity
receipt_identity
first_seen_at
last_seen_at
terminal_outcome
```

推荐状态：

```text
NEW
ACCEPTED / IN_PROGRESS
COMMITTED
FAILED_RETRIABLE
FAILED_TERMINAL
```

状态名可调整，但语义必须确定。

## 6.3 重试行为

### 已 COMMITTED

重复请求不得再次执行 Canonical Mutation，应返回同一逻辑结果与原 Receipt 引用。

### IN_PROGRESS

不得启动第二个独立副作用执行。可返回 `IN_PROGRESS`、等待既有结果或通过受控机制继续同一 operation。

### FAILED_RETRIABLE

只有在能够证明此前未形成 Canonical Commit，且仍满足 Authorization / Revision / Preconditions 的情况下，才允许受控重试。

### FAILED_TERMINAL

同一 operation 不得通过简单 retry 变成新的隐式写操作；需要新的合法 command identity 或显式修复路径。

## 6.4 checkpoint 专项规则

当前已知的 checkpoint 重复提交 / retry / idempotency 风险必须作为第一批 Stability Finding。

逻辑 checkpoint 应具备稳定身份，不得把 transport request 当成 checkpoint identity。

推荐不变量：

```text
同一 logical checkpoint
+ 同一 accepted payload
→ 返回同一 canonical checkpoint / receipt

同一 logical checkpoint
+ 不同 payload
→ CONFLICT

旧 checkpoint revision
→ STALE_REVISION / CONFLICT
```

不得通过重复提交产生两个语义上互相冲突的“同一 checkpoint 已接受”事实。

---

# 7. S3 — Revision CAS / Concurrency Safety

## 7.1 禁止 Silent Last-Write-Wins

对适用 Canonical Object 的 mutation，必须使用 revision precondition 或等价 CAS 语义。

更新：

```text
expected_revision == current_revision
```

否则：

```text
REVISION_CONFLICT
```

创建：

```text
EXPECT_ABSENT
```

或等价唯一性前置条件。

## 7.2 并发结果

两个 writer 同时基于 revision 7 提交：

```text
Writer A: expected=7 → commit revision 8
Writer B: expected=7 → conflict
```

Writer B 不得自动把自己的 payload 覆盖到 revision 9，除非重新读取新状态、重新授权、重新形成合法 Command。

## 7.3 CAS 与 Authorization 的顺序

Authorization、CAS、Invariant、Commit 的具体事务实现可因存储层不同而变化，但最终必须证明：

- 不存在 TOCTOU 导致越权写；
- 不存在 Authorization 已变化但旧 command 在未定义边界后继续扩大副作用；
- 不存在 stale revision 静默成功。

---

# 8. S4 — Canonical State Machine & Invariants

## 8.1 状态不能由 Consumer 自由拼接

每个关键 Canonical Object 应具有：

```text
allowed_states
allowed_transitions
transition_preconditions
terminal / irreversible boundaries
required_authority
required_evidence
```

## 8.2 非法迁移

任何非法迁移必须：

```text
DENY / INVALID_TRANSITION
```

并留下适用的审计/诊断证据。

不得出现：

```text
if unknown_state:
    force_update(...)
```

之类的生产兜底。

## 8.3 最低根不变量

至少覆盖：

1. Authorization invariant
2. Canonical object identity invariant
3. Revision monotonicity / CAS invariant
4. State-machine invariant
5. Receipt-to-operation binding invariant
6. Projection derived-from-canonical invariant
7. Idempotency invariant
8. Scope narrowing invariant
9. Authority non-expansion invariant
10. Environment isolation invariant

## 8.4 不变量执行层级

建议分为：

```text
Static / Schema
↓
CI / Contract Tests
↓
Runtime Precondition
↓
Transactional Constraint
↓
Shadow Consistency Check
↓
Health Finding
```

能用数据库唯一约束、FK、CHECK、transactional CAS 证明的，不要只依赖应用层 if。

---

# 9. S5 — Receipt / Replay / Traceability

## 9.1 Receipt 是结果证据，不是第二 Authority

Receipt 必须描述一次已发生的授权决策与状态变化，但 Receipt 本身不能反向授予新权限。

## 9.2 Canonical Mutation Receipt 最低绑定

至少能复验：

```text
receipt_id
operation_id
command_id / command identity
actor
subject             # 如适用
authorization decision reference
resource / target identity
previous_revision
new_revision
previous_state hash / identity
new_state hash / identity
transition
policy / registry revision binding
result
commit identity / transaction evidence
correlation_id
created_at
```

## 9.3 Replay 的含义

本方案中的 replay 优先指：

> 使用历史 Command / Receipt / Canonical Evidence 验证“系统是否会得到相同决策与状态结论”。

Replay 默认不能再次制造真实副作用。

若存在真正的 effect replay，必须另有明确的幂等和 Authority 合同。

## 9.4 外部副作用

对于无法与 Canonical DB Commit 同事务完成的外部副作用，优先使用：

```text
Canonical Transaction
=
Canonical State
+ Durable Effect Intent / Outbox
+ Operation / Receipt Binding
```

外部 effect executor 必须自身幂等，并把 effect result 绑定回既有 operation，而不是创建第二个业务事实。

---

# 10. S6 — Fail-Closed & Blast-Radius Control

## 10.1 目标

事故第一 KPI 不是“所有功能最快恢复”，而是：

```text
Time-to-Safe-State
```

## 10.2 允许的预授权安全收窄

在既有 Health / Surgical 合同允许范围内，可使用：

```text
Deny
Read-only
Disable
Pause
Revoke
Isolate
```

但不得：

- 扩权；
- 创建新的业务真相；
- 修改未知范围的数据“尝试修好”；
- 绕过 Registry / Policy / Hard Constraint；
- 让 SurgicalGrant 成为永久超级权限。

## 10.3 Blast Radius 维度

稳定性设计必须支持按以下维度收窄：

```text
environment
resource_type
resource_id / scope
capability / action
consumer
principal
worker / queue
projection
region / deployment unit   # 如适用
```

优先局部隔离，不做全局无差别停机；但在边界无法确定时，宁可更大范围 fail-closed，也不能继续未知写入。

---

# 11. S7 — Stability Signals & Repairability

## 11.1 Stability Signal 不新造 Severity 体系

Stability Signal 应进入既有 Health Finding / FindingSeverity 体系，不建立第二套 F1–F4 或风险等级。

## 11.2 第一批信号

至少观察：

```text
DuplicateOperationRate
IdempotencyHitRate
IdempotencyConflictRate
RetryRate
RetryAmplification
CheckpointReplayRate
RevisionConflictRate
IllegalTransitionAttempt
UnauthorizedMutationAttempt
ReceiptMismatch
MissingReceipt
ProjectionDrift
CanonicalProjectionLag
StaleWriterAttempt
FailClosedActivation
SafeStateEntryLatency
```

## 11.3 Health 的语义

R11 / HS-1 不只问：

```text
process alive?
database reachable?
```

还必须问：

```text
Authorization 仍然一致吗？
Canonical Identity 仍然唯一吗？
Revision 是否出现异常覆盖？
State Machine 是否出现非法状态？
Receipt 是否能绑定真实 mutation？
Projection 是否偏离 Canonical？
Retry 是否制造重复事实？
checkpoint 是否出现语义重复？
```

---

# 12. 与 Phase 2 固定 21 步的精确接入

以下 21 步顺序不得修改：

1. phase2-v027-validation 最后收口
2. Structure Freeze Preparation
3. 全量 NamingSurfaceInventoryManifest
4. NamespaceOwnershipManifest + 显式 Namespace Delegation + Domain Registry Ownership
5. Version Axis / Vocabulary / Alias / Logical Object / Representation / Copy Identity Closure
6. 当前所有 Receipt / Authorization / Consumer 的 typed 身份盘点与接线
7. README / AGENTS / Status / Manifest / Registry 确定性投影与一致性验证
8. Naming Validator — Pre-Acceptance Evidence Mode + 全部负例
9. 独立 Structure / Architecture Review
10. ArchitectureConstitutionAcceptanceDecision
11. Phase2StructureFreezeDecision
12. Repository / Development Control Plane 物理迁移
13. 全部目标运行消费者接线
14. 历史名称封存、旧写入口关闭
15. Naming Validator — Post-Migration Enforcement Mode
16. 运行时只读证据与治理对象对齐核验
17. 开发者工具链与 Console 接线（非生产）
18. 真实证据补齐与具名批准（六组原请求）
19. Phase 2 结构冻结后续治理与例外机制
20. 结构冻结后第一批产品输入合并（不含生产数据）
21. 结构冻结后第一批架构接受复验与发布 Gate

## 12.1 Step 1–4：只做风险盘点

允许：

- Canonical mutation inventory；
- checkpoint / retry / duplicate 风险登记；
- direct write / hidden write 入口识别；
- 当前 operation identity / revision / receipt 缺口登记。

不允许：

- 因本方案重构整个 Kernel；
- 宣称 Stability Contract 已冻结；
- 新增生产 Authority；
- 阻塞当前 P0，只因为未来 S1–S7 尚未全部实现。

## 12.2 Step 5–8：Stability Contract Draft

随着 Version / Identity / Receipt / Authorization / Consumer typed identity 收敛，起草并验证：

- CommandEnvelope
- OperationIdentity
- IdempotencyContract
- ExpectedRevisionContract
- StateTransitionContract
- CanonicalMutationContract
- ReceiptDeterminismContract
- FailClosedContract
- StabilitySignalContract

同时准备全部关键负例。

此阶段仍是 DRAFT，不得写 `CONTRACT_READY`。

## 12.3 Step 9–11：审查与 Structure Freeze

Structure / Architecture Review 必须检查 Stability Draft 是否：

- 与正式 identity 轴一致；
- 不建立第二 Authorization；
- 不建立第二 Receipt；
- 不引入双 Canonical Store；
- 能被 Step 12–16 的 Runtime 实现承接。

只有在 Phase2StructureFreezeDecision 完成后，才适合冻结本轮 Stability Contract。

## 12.4 Step 11 后：Stability Contract Freeze / HS-0 对齐点

这是最重要的插入点：

```text
Phase2StructureFreezeDecision
↓
Stability Contract Freeze
↓
HS-0 Health / Surgical Contract & Hook Freeze 对齐
↓
Step 12 Physical Migration
```

如果当前主线的 P0 收口条件尚未满足，则仍不得提前宣称 HS-0 `CONTRACT_READY`，也不得开放 Surgical Authority。

## 12.5 Step 12：Physical Migration

开始真正实施：

- 统一 Command 入口；
- operation identity；
- durable idempotency；
- expected revision / CAS；
- state transition enforcement；
- Receipt binding；
- durable outbox（如适用）；
- fail-closed hooks。

所有实施先在当前允许的非生产/开发控制面范围内进行，不因为本方案自行扩大生产变更范围。

## 12.6 Step 13：Runtime Consumers Rewired

所有目标消费者逐步改走统一 Kernel Mutation 路径：

```text
API
MCP
Console
Agent
Worker / Job
Internal Tool
```

每个 Consumer 必须证明：

```text
Consumer Capability
⊆ Human / Service Principal Authority
∩ Kernel Policy
∩ Scope
∩ Environment
```

Consumer 不能自己实现“更宽松”的 retry、state transition 或 direct write。

## 12.7 Step 14：旧写入口关闭

该步是 Kernel Stability 的关键强制点。

必须识别并关闭：

- legacy canonical mutation endpoint；
- direct DB canonical writes；
- bypass CAS writes；
- bypass authorization writes；
- hidden admin writes；
- projection-to-canonical reverse write；
- historical alias 仍可写 current object 的入口。

若旧入口因迁移尚需短期保留，必须：

- 明确 owner；
- 明确 expiry；
- 明确 read-only / compatibility 语义；
- 不得保留为无期限 bypass。

## 12.8 Step 15：Enforcement Mode

把关键规则从：

```text
WARN / LOG
```

升级到：

```text
DENY / CONFLICT / FAIL_CLOSED
```

但必须在目标 Consumer 接线完成后再 enforce，避免先切断合法主路径。

## 12.9 Step 16：Runtime / Governance Alignment

验证：

```text
Canonical Identity
=
Governance Identity
=
Runtime Target Identity

Canonical Mutation
↔ Receipt
↔ Projection
```

并确认 Stability 的核心实现 S1–S6 已经形成可运行闭环。

## 12.10 Step 16 后：R11 Shadow

开始真实 Shadow 观察，不自动修生产。

主要统计：

- Duplicate / retry；
- Idempotency conflicts；
- Revision conflicts；
- Illegal transition attempts；
- Authorization mismatch；
- Receipt mismatch；
- Projection drift；
- checkpoint replay；
- Safe-state activation。

## 12.11 R11 后：HS-1 Kernel Health Shadow

R11 回答：

> 发生了什么信号？

HS-1 回答：

> 这个信号意味着什么、严重度是什么、可能原因是什么、建议怎样收窄？

HS-1 仍然只做：

```text
Detect
Classify
Diagnose
Report
```

不得自动生产修复。

## 12.12 Step 17：Developer Tooling / Console

非生产开发工具和 Console 可以接入：

- Stability dashboard；
- operation trace；
- receipt trace；
- revision conflict viewer；
- projection drift view；
- checkpoint duplicate diagnostics；
- fail-closed reason；
- Health Finding projection。

Console 是可信投影和受控操作入口，不成为新的 Kernel Authority。

## 12.13 Step 18：Evidence + Named Approval

形成可复验 Evidence：

- Consumer mutation matrix；
- direct-write closure evidence；
- idempotency tests；
- concurrency tests；
- state-machine negative tests；
- receipt binding evidence；
- projection drift evidence；
- fail-closed evidence；
- reviewer / approver identity。

## 12.14 Step 18 后：HS-2 非生产 Surgical Drill

主动制造受控故障：

1. 同一 command 连续提交多次；
2. Commit 成功后客户端 timeout，再 retry；
3. 两个 writer 使用相同 expected_revision；
4. stale revision write；
5. checkpoint 重复提交；
6. 同 idempotency key 不同 payload；
7. illegal state transition；
8. Authorization 在操作边界变化；
9. Receipt persistence failure simulation；
10. Projection delay / drift；
11. Worker duplicate delivery；
12. Canonical commit 与外部 effect 间的 kill-point。

必须证明：

```text
不产生重复 Canonical Fact
不静默覆盖
不越权
不进入非法状态
能够检测
能够安全收窄
能够形成可验证证据
```

## 12.15 Slice A + HS-2.5 Repairability Gate

适用 Slice 必须同时证明：

```text
Detectable
Diagnosable
Containable
Repairable
Verifiable
Evidence-completable
```

只有既有 Slice A 与 Repairability 条件全部 PASS，才允许按 Health / Surgical 既定方案评估 HS-3。

## 12.16 Step 19–20

进入冻结后治理与 Product Input 时：

- 新能力必须接统一稳定性合同；
- 新 Consumer 不得恢复 direct-write；
- 新 Product Action 不得绕过 CAS / State / Receipt；
- Exception 必须有 owner、scope、expiry、evidence；
- Product Input 不得要求 Kernel 为赶进度关闭关键不变量。

## 12.17 Step 21

最终复验至少检查：

- Structure Freeze 后没有重新出现双 identity；
- 新 Consumer 没有绕过统一写链；
- Stability Contract 与 Health / Surgical Hook 一致；
- 关键负例仍然 PASS；
- Shadow 未出现未解释的严重漂移；
- Release Gate 不把“测试通过”误写为“生产已安全”。

---

# 13. 当前 R07–R10 / A01–A11 的接入规则

本方案对当前 P0 的规则只有三条：

## 13.1 不新增大包

不得创建：

```text
A12 Kernel Stability
A13 Idempotency Rewrite
A14 Retry Platform
```

等新的大批 P0。

## 13.2 只对“当前正在触碰的风险”做就地闭合

若现有 P0 已经涉及：

- checkpoint；
- canonical mutation；
- retry；
- receipt；
- authorization；
- revision；
- state transition；

则必须避免继续引入已知重复写、越权、silent overwrite 等缺陷。

但不要求当前 P0 在 Structure Freeze 前实现完整未来版 Command Engine。

## 13.3 checkpoint 问题登记为第一批 Stability Finding

当前 checkpoint duplicate / retry / idempotency 问题应：

- 进入风险清单；
- 明确触发条件；
- 明确是否会产生重复 Canonical Fact；
- 明确当前临时 containment；
- 在 Step 5–8 纳入正式 Idempotency Contract；
- 在 R11 / HS-1 形成可观测 Signal；
- 在 HS-2 形成强制故障演练场景。

---

# 14. 事务边界

## 14.1 理想原子边界

对单 Canonical Store 内可原子完成的 mutation，优先保证：

```text
Authorization binding / precondition evidence
+ CAS
+ Canonical State Change
+ Idempotency terminal state
+ Receipt binding
```

在一个可证明的一致性边界内完成。

## 14.2 外部 Effect

如果还要调用外部系统：

```text
Canonical Commit
+ Outbox / Effect Intent
```

先形成 durable intent，再由幂等 worker 执行。

禁止：

```text
先调外部系统成功
→ 本地 commit 失败
→ retry 又调一次
```

但没有任何 operation binding 的实现。

---

# 15. Authorization 与 Retry 的关系

Retry 不能成为权限逃逸机制。

规则：

1. 已 COMMITTED operation：不得重新执行；只允许按当前可见性规则返回已有结果/Receipt。
2. 尚未跨越 Canonical Commit Point 的 retry：必须继续满足适用 Authorization / Preconditions。
3. Authority 已撤销且 operation 尚未完成关键副作用：默认停止未提交部分，除非既有合同明确规定不可回退的 commit boundary。
4. 返回历史 Receipt 也要遵守 Receipt / Resource 的读取权限。
5. 不允许“拿到旧 idempotency key 就可以继续写”。

---

# 16. 错误语义

推荐稳定的错误类别，不要求具体 HTTP code 在本版固定：

```text
AUTHORIZATION_DENIED
IDEMPOTENCY_KEY_REUSE_CONFLICT
OPERATION_ALREADY_COMMITTED
OPERATION_IN_PROGRESS
REVISION_CONFLICT
INVALID_STATE_TRANSITION
INVARIANT_VIOLATION
CANONICAL_IDENTITY_MISMATCH
RECEIPT_BINDING_FAILURE
PROJECTION_DRIFT_DETECTED
SAFE_STATE_ACTIVE
RETRY_LATER
```

错误必须可机器识别，不应主要依赖自然语言字符串。

---

# 17. Shadow 指标与 SLO 候选

本方案 v0.1 不强行写死未经真实基线测量的数值阈值。

先收集基线，再冻结阈值。

需要统计的方向：

- duplicate command / 1k mutation；
- retry-after-timeout；
- idempotency dedupe success；
- idempotency conflict；
- revision conflict；
- illegal transition；
- unauthorized mutation attempt；
- receipt missing / mismatch；
- projection drift rate；
- mean / p95 safe-state entry latency；
- finding detection latency；
- false-positive rate；
- checkpoint duplicate suppression rate。

只有经过 R11 Shadow 的真实样本后，才适合把其中一部分升级成硬 SLO / Gate。

---

# 18. 强制负例测试矩阵

至少包含以下测试：

| ID | 场景 | 预期 |
|---|---|---|
| ST-N01 | 同一 command 连续提交 10 次 | 仅一个 Canonical 结果，返回同一逻辑 Receipt |
| ST-N02 | commit 成功、响应丢失、客户端 retry | 不重复 commit |
| ST-N03 | 同 idempotency key、不同 payload | 明确 conflict |
| ST-N04 | 两 writer 同 expected_revision | 仅一个成功，另一个 revision conflict |
| ST-N05 | stale revision write | 拒绝 |
| ST-N06 | 非法 state transition | 拒绝且可诊断 |
| ST-N07 | 未授权 Consumer 直接 mutation | 拒绝 |
| ST-N08 | 旧 direct-write endpoint | Step 14 后不可用于 current Canonical write |
| ST-N09 | checkpoint exact duplicate | 幂等返回，不重复事实 |
| ST-N10 | checkpoint identity 相同但内容不同 | conflict |
| ST-N11 | Receipt 写入/绑定异常 | 不得产生不可证明的 silent success |
| ST-N12 | Projection 延迟 | Canonical 不受影响，Shadow 能检测 |
| ST-N13 | Projection 内容与 Canonical 不一致 | 发现 drift，不反向覆盖 Canonical |
| ST-N14 | Worker duplicate delivery | 外部 effect / canonical effect 不重复 |
| ST-N15 | Authorization 在未提交 operation 中撤销 | 未提交部分 fail-closed |
| ST-N16 | kill at CAS/commit boundary | 最终状态只能是确定的 pre 或 post，不得半写 |
| ST-N17 | kill at outbox boundary | effect intent 可恢复且不重复业务事实 |
| ST-N18 | Health unavailable | 不自动扩大写能力；核心 Kernel 行为按既有安全策略运行 |

---

# 19. Acceptance Checks

以下是本方案内部验收检查，不是新的 Phase 2 P0 编号：

- `KSH-C01`：全部目标 Canonical Mutation Consumer 已盘点。
- `KSH-C02`：Step 14 后不存在未受控 current direct-write 路径。
- `KSH-C03`：适用 mutation 有稳定 operation identity。
- `KSH-C04`：重复相同 operation 不产生重复 Canonical Fact。
- `KSH-C05`：同 idempotency key 不同 payload 必须 conflict。
- `KSH-C06`：stale expected_revision 必须拒绝。
- `KSH-C07`：非法 State Transition 必须拒绝。
- `KSH-C08`：Authorization 不确定时 fail-closed。
- `KSH-C09`：Canonical Mutation 可绑定唯一可复验 Receipt。
- `KSH-C10`：timeout + retry 不重复提交。
- `KSH-C11`：并发 writer 不 silent overwrite。
- `KSH-C12`：Projection drift 可发现且不能改写 Canonical。
- `KSH-C13`：checkpoint replay / duplicate 场景通过。
- `KSH-C14`：外部 effect（如适用）具备 operation-bound idempotency。
- `KSH-C15`：Safe State 可按 scope 收窄而不扩权。
- `KSH-C16`：R11 Shadow 有可用稳定性信号与误报统计。
- `KSH-C17`：HS-1 能把关键稳定性异常转成既有 Finding / Severity。
- `KSH-C18`：HS-2 非生产演练证明 detect / contain / repair / verify。
- `KSH-C19`：F4 或适用 R4 的重新全面开放遵守独立 Post-op Verifier 要求。
- `KSH-C20`：Deferred Evidence 在 Incident 正式关闭前可补齐，不阻塞先进入 Safe State。

---

# 20. 证据包要求

稳定性 Evidence Pack 至少包括：

```text
01-mutation-inventory
02-consumer-write-path-matrix
03-command-contract
04-idempotency-contract
05-revision-cas-contract
06-state-machine-invariants
07-receipt-binding-evidence
08-direct-write-closure-evidence
09-negative-test-results
10-concurrency-test-results
11-retry-timeout-test-results
12-checkpoint-idempotency-results
13-projection-drift-results
14-fail-closed-results
15-shadow-metrics
16-health-findings
17-surgical-drill-results
18-repairability-verification
19-reviewer-approver-record
20-sha256sums-manifest
```

具体文件名可调整，但证据语义不得丢失。

---

# 21. Migration / Rollout 策略

## 21.1 先建立可观察性，后强制；正式 R11 仍在 Step 16 后

推荐：

```text
Inventory
↓
Draft Contract
↓
Pre-enforcement Instrumentation / Local Warning
（仅 Step 12–14 的局部遥测、日志与兼容性告警；不是正式 R11）
↓
Consumer Migration
↓
Legacy Closure
↓
Enforcement
↓
Runtime / Governance Alignment（Step 16）
↓
R11 Shadow
```

这里的 `Pre-enforcement Instrumentation / Local Warning` 只用于在迁移和关闭旧入口前发现接线问题，不得宣称进入 R11，也不得产生 Health/Surgical Authority。正式 `R11 Shadow` 的时点保持第 12.10 节既定顺序：**Step 16 完成之后**。

不允许在 Consumer 尚未接新路径时直接开启全局硬拒绝，造成不必要主线中断。

## 21.2 历史数据

不得为了“看起来干净”批量重写历史 Receipt / Canonical History。

历史不满足新合同的对象应：

- 标记 legacy provenance；
- 建 compatibility projection / adapter（如必要）；
- 保留原始证据；
- 新写入进入新合同；
- 只有具有确定性迁移依据时才执行历史 migration。

## 21.3 Rollback

Rollback 不能重新开放已经证明不安全的 direct-write。

实现回滚优先退回：

```text
read-only
previous enforced kernel revision
consumer disable
queue pause
```

而不是退回“旧的不安全写入口”。

---

# 22. 与 Kernel Health / Surgical Repair 的边界

两者关系固定为：

```text
Stability Hardening
= Prevent + Limit

Health
= Detect + Classify + Diagnose + Report

Surgical
= Contain + Repair + Verify + Recover
```

## 22.1 Stability 不取代 Health

即使 S1–S6 全部实现，也必须继续做 R11 / HS-1，因为现实系统仍会出现：

- dependency failure；
- code regression；
- data drift；
- operational error；
- latent bug；
- unexpected concurrency；
- external provider inconsistency。

## 22.2 Health 不取代 Stability

不能因为有 Health，就接受：

- duplicate write；
- silent overwrite；
- no-CAS mutation；
- invalid state；
- no Receipt；
- direct DB write。

## 22.3 Surgical 不成为常规开发通道

Surgical Lane 禁止用于：

- 计划内开发；
- 普通重构；
- 常规升级；
- 预定 migration；
- 为赶进度绕 Gate。

---

# 23. Executor 状态语言

当前执行者报告进度时，建议只使用可验证状态，不使用模糊“差不多完成”：

```text
NOT_STARTED
INVENTORIED
DRAFTED
UNDER_REVIEW
CONTRACT_FROZEN
IMPLEMENTING
SHADOWING
EVIDENCE_READY
DRILL_PASS / DRILL_FAIL
REPAIRABILITY_PASS / REPAIRABILITY_FAIL
```

其中：

- `CONTRACT_FROZEN` 不等于 HS-0 `CONTRACT_READY`，除非既有 HS-0 前置条件同时满足。
- `IMPLEMENTING` 不等于 Production Ready。
- `SHADOWING` 不允许自动 production repair。
- `DRILL_PASS` 仅代表指定非生产 Drill 范围。
- `REPAIRABILITY_PASS` 仅代表适用 Slice，不自动授权 HS-3。

---

# 24. 执行者禁止事项

当前执行者不得：

1. 因本方案新增 A12/A13 等大批 P0。
2. 修改 Phase 2 21 步顺序。
3. 在 Step 11 / Structure Freeze 前把 draft contract 写成最终不可变 Kernel Contract。
4. 在现有 P0 未收口时宣称 HS-0 `CONTRACT_READY`。
5. 提前创建生产 SurgicalGrant。
6. 创建隐藏 admin/direct DB write 作为“紧急兜底”。
7. 允许 MCP / Console / Agent 自己决定 Authorization。
8. 允许 retry 绕过新的 Authorization / CAS / State precondition。
9. 用 last-write-wins 解决 Canonical concurrency。
10. 用 Projection / Cache 内容覆盖 Canonical Truth。
11. 发生 Receipt binding failure 时返回 silent success。
12. 为了通过测试而删除真实冲突、重复请求或 failure injection 场景。
13. 在没有真实 Shadow 数据前拍脑袋固定过严或过松的 SLO 数值。
14. 把 Health Finding 自动升级成生产写权限。
15. 把 Surgical Lane 用作常规 migration / refactor 捷径。

---

# 25. 最终完成定义

本方案不能仅凭“代码已合并”宣称完成。

适用 Slice 的完成至少需要：

```text
Structure aligned
∩ Command identity working
∩ Idempotency working
∩ CAS working
∩ State / invariant enforcement working
∩ Receipt binding working
∩ Legacy write paths closed
∩ Shadow evidence available
∩ Health diagnosis available
∩ Non-production drill passed
∩ Repairability verified
```

同时仍需服从 Phase 2、Slice A、HS-2.5、Step 21 及后续 Release Authorization 的既有 Gate。

---

# 26. 当前立即执行清单

在当前 R07–R10 / A01–A11 P0 收口期间，只立即执行以下非阻塞动作：

1. 建立 Canonical Mutation Inventory。
2. 建立 Runtime Consumer Write Path Inventory。
3. 把 checkpoint duplicate / retry / idempotency 问题登记为 Stability Finding Candidate。
4. 标出所有已知 direct write / legacy write / bypass path。
5. 标出现有 operation identity / idempotency / revision / Receipt 能力是否存在。
6. 起草 S1–S7 Contract，不冻结。
7. 起草 ST-N01–ST-N18 负例，不要求当前全部实现。
8. 不新增大 P0，不阻塞当前 P0 收口。

当前阶段禁止：

```text
HS-0 CONTRACT_READY
Production Surgical Authority
Production auto-repair
Break-glass superuser
```

---

# 27. 后续唯一推荐顺序

```text
当前 R07–R10 / A01–A11 P0 收口
↓
Phase 2 Step 1–4：风险盘点
↓
Step 5–8：Stability Contract Draft + Negative Cases
↓
Step 9：Independent Structure / Architecture Review
↓
Step 10：ArchitectureConstitutionAcceptanceDecision
↓
Step 11：Phase2StructureFreezeDecision
↓
Stability Contract Freeze
↓
满足既有前置条件后完成 HS-0 Contract & Hook Freeze
↓
Step 12：Command / Idempotency / CAS / State / Receipt 实现
↓
Step 13：Runtime Consumers Rewired
↓
Step 14：Legacy / Direct Write Closure
↓
Step 15：Enforcement
↓
Step 16：Runtime / Governance Alignment
↓
R11 Shadow
↓
HS-1 Kernel Health Shadow
↓
Step 17：Developer Tooling / Console 非生产接线
↓
Step 18：Evidence + Named Approval
↓
HS-2 Non-production Surgical Drill
↓
Slice A Full Acceptance + HS-2.5 Repairability Gate
↓
Step 19：Post-freeze Governance / Exceptions
↓
Step 20：First Product Inputs
↓
Step 21：Architecture Re-acceptance / Release Gate
↓
只有既有全部条件 PASS 后
HS-3 Controlled Surgical Lane
↓
HS-4 Continuous Health
```

---

# 28. 一句话执行原则

> **先让非法状态难以产生，再让异常能够被看见；先把系统快速收窄到安全状态，再谈修复；所有重试、并发、状态迁移和修复都必须服从同一 Canonical Identity、Authorization、Revision、Invariant 与 Receipt 体系。**

---

# 29. 给当前执行者的接入说明

本文件应作为现有 Phase 2 / Kernel 主线的横向接入执行方案使用，而不是替换任何已经固定的主线 Baseline。执行时必须保持：

```text
现有 P0 优先
21 步顺序不变
Structure Freeze 前只准备合同
Step 12–16 才实施 Hardening
R11 / HS-1 只读 Shadow
HS-2 只做非生产 Drill
Repairability PASS 不自动授权 HS-3
```

如本方案与已经固定的更高优先级 Kernel / Phase 2 / Authorization / Health-Surgical Baseline 存在冲突，以既有更高优先级 Baseline 为准，并将冲突作为 Review Finding 报告，不得由执行者自行扩权解决。
