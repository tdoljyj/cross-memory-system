# Clued Kernel Health & Surgical Repair 接入执行方案 v0.1

**中文名称：** Clued 内核健康体检与手术式快速修复接入执行方案  
**英文名称：** Clued Kernel Health & Surgical Repair Integration Execution Plan  
**版本：** v0.1  
**日期：** 2026-09-08  
**状态：** **FIXED / EXECUTION BASELINE**  
**Baseline ID：** `CLUED-KERNEL-HEALTH-SURGICAL-REPAIR-INTEGRATION-v0.1-20260908`  
**适用阶段：** 当前第二阶段正式开发入口补齐（R07–R10）→ R11 Shadow → Slice A 完整验收 → 后续受控真实运行  
**执行对象：** 当前 Clued Kernel / Development Control Plane 执行者  
**重要边界：** 本方案是横向接入能力，不替代当前 R07–R10 / A01–A11 主线，不新增一条与当前主线竞争的“大工程”。

---

## 1. 当前状态与本方案定位

当前 Clued 仍处于第二阶段正式开发入口的补齐阶段（R07–R10），尚未进入 R11 真实 Shadow，也尚未完成完整 Slice A 验收。

当前已知执行状态：

- A01 已完成；
- A02 / A03 部分完成；
- A04–A11 仍有 8 项 P0 需要收口；
- 当前主要缺口包括：
  1. 正式资格、Shadow、切换及 Entry 收口；
  2. 来源接入、候选确认、上下文编译、撤回恢复等核心能力；
  3. 第三真实会话闭环、24 场景、3 次共 72 次测量；
  4. 人工效率指标与独立最终验收；
- 当前仍在修复检查中发现的 `checkpoint` 重复提交漏洞，并准备一次性解开资格入口的授权方案。

此前完成的命名 / 结构治理 21 步属于上游结构基础，不等价于整个第二阶段已经完成。

因此，本方案不允许打断当前主线，也不允许将 Kernel Health / Surgical Repair 误扩展成 A12、A13、A14 等新的大批 P0。

本方案的正确定位是：

> 作为 Kernel 的横向 Health + Repairability 能力，分阶段接入现有 Authorization、Shadow、Recovery、Receipt、Gate、Observability 和运行入口。

---

# 2. 总体目标

建立一套长期机制，使 Clued Kernel 能够：

```text
平时持续体检
↓
尽早发现问题
↓
快速定位
↓
必要时先止血 / 隔离
↓
进入最小手术范围
↓
快速修复
↓
执行生命级术后验证
↓
恢复安全运行
↓
再完成完整复盘和长期修正
```

总体设计原则：

> 平时治理要严，事故修复要短。

事故状态下第一优化目标：

> **Time-to-Safe-State — 从确认问题到恢复“可证明安全状态”的时间。**

紧急修复不是取消治理，而是把正常治理压缩成：

> **Surgical Minimum Controls — 手术所必需的最小控制集。**

---

# 3. 当前阶段绝对不能做的事情

在 R07–R10 / A01–A11 主线尚未收口之前，禁止因为本方案提前：

- 建立生产级 Emergency Superuser；
- 建立永久 Break-glass 权限；
- 创建能够绕过正式 Authorization 的隐藏入口；
- 允许 Agent 自主修改 Canonical / Authority；
- 对生产数据库建立未经当前主线验收的新写路径；
- 让 Surgical Mode 直接自动修复生产问题；
- 把普通功能开发伪装成 Emergency Hotfix；
- 为本方案新增一长串 P0，从而阻塞当前 R07–R10 主线。

理由：

```text
正式 Authorization / Entry 尚未完全闭合
+
提前新增 Emergency Entry
=
正门未修好，先打开新的侧门
```

---

# 4. 总体接入顺序

正式执行顺序：

```text
当前：R07–R10 / A01–A11 P0 收口
↓
HS-0  Health / Surgical Contract & Hook Freeze
       只固定合同、对象和接线点
       不开放真实 Surgical Authority
↓
R11 Shadow
↓
HS-1  Kernel Health Shadow
       只读体检 / Finding / Diagnosis
↓
HS-2  Surgical Drill
       非生产模拟止血、手术、回滚、术后验证
↓
Slice A 完整验收
↓
HS-2.5 Repairability Gate
       证明系统可隔离、可恢复、可回滚、可重放
↓
Slice A 验收通过
↓
HS-3 Controlled Surgical Lane
       才允许实现真正受控的 SurgicalGrant /
       Containment / Minimum Repair / Post-op
↓
后续稳定运行
↓
HS-4 Continuous Health & Real Incident Operation
```

### 4.1 HS-0 的并行边界

为了不让本方案反过来阻塞当前 P0，允许在 R07–R10 期间**并行准备**：

```text
合同草案
Hook Point Inventory
只读观察点确认
Post-op Check 草案
```

但必须同时满足：

```text
不改变 Runtime 行为
不新增 Authority
不新增生产写入口
不改变当前 P0 优先级
```

并且：

> **HS-0 可以提前准备，但不得在 R07–R10 当前适用 P0 收口前宣称 `CONTRACT_READY`；正式 Freeze / Acceptance 位于 R07–R10 收口之后、R11 进入之前。**

因此不存在“HS-0 抢在当前 P0 前成为新主线”的解释空间。

---

# 5. HS-0：当前立即执行的最小接入

## 5.1 目的

HS-0 的任务不是实现“手术系统”。

在当前 R07–R10 期间，可以做 HS-0 的非阻塞准备；其正式 Freeze / Acceptance 仍遵守第 4 章顺序。

目的只有两个：

1. 固定未来 Health / Surgical 的合同对象；
2. 确认这些对象将接到现有 Kernel 的哪些 Hook Point。

HS-0 必须足够小，不应拖慢当前 P0 收口。

## 5.2 必须固定的核心对象

至少固定以下逻辑对象：

```text
KernelHealthReport
HealthFinding
FindingSeverity
RepairClass
ContainmentState
SurgicalModeState
RepairBoundary
SurgicalRepairReceipt
CriticalPostOpVerification
```

建议状态：

### Kernel Overall Health

```text
HEALTHY
DEGRADED
UNHEALTHY
CRITICAL
BLOCKED
```

### Finding Severity

```text
F0 INFORMATIONAL
F1 MINOR
F2 MAJOR
F3 CRITICAL
F4 EMERGENCY
```

### Repair Class

```text
R0 无代码/数据修改
R1 Runtime / Cache / Projection
R2 单模块代码 / 配置
R3 跨模块 / Schema Migration
R4 Canonical / Authority Repair
```

`FindingSeverity` 与 `RepairClass` 必须保持正交：

```text
Severity
= 问题有多危险 / 多紧急

RepairClass
= 修复会触碰多深 / 多大范围
```

因此可能存在：

```text
F4 + R1
紧急问题，但可以通过安全配置回退快速止血

F2 + R3
当前不紧急，但长期修复需要跨模块 Migration
```

默认处置映射：

```text
F0 / F1 → Report / Observe / Normal Maintenance
F2      → Controlled Repair；必要时局部 Containment
F3      → Containment + Surgical Candidate
F4      → Immediate Fail-closed Containment + Surgical Candidate
```

这只是默认处置，不允许由 Severity 自动扩大 Authority。

## 5.3 HS-0 Hook Point Inventory

当前执行者应识别现有代码中的最小接线点：

- Authorization decision；
- Entry / qualification；
- Shadow；
- Canonical read / write boundary；
- State transition；
- Receipt emission；
- Recovery / rollback；
- Projection / consumer；
- Observability / error event；
- checkpoint / retry / idempotency；
- configuration / capability disable point。

本阶段只要求回答：

> “未来 Health 和 Surgical 能从哪里观察、从哪里隔离、从哪里恢复？”

不要求真实开放紧急写能力。

## 5.4 HS-0 验收

HS-0 只有以下结果才算完成：

- 对象名称和语义明确；
- 没有和当前 Kernel 既有对象形成第二套 Authority；
- Hook Point 有真实代码位置或正式接口承载；
- 没有建立生产 SurgicalGrant；
- 没有绕开当前 Entry / Authorization；
- 没有新增长期 P0 阻塞主线。

**HS-0 Exit：PASS_FOR_R11_SHADOW_ONLY**

---

# 6. R11：HS-1 Kernel Health Shadow

R11 是这套机制第一次真正运行的阶段。

## 6.1 核心原则

HS-1：

```text
Detect
Classify
Diagnose
Report
```

默认不做：

```text
Repair
Mutate Canonical
Expand Authority
```

## 6.2 第一批 Health 检查

### A. Vital Signs

至少：

- success rate；
- error rate；
- timeout rate；
- p50 / p95 / p99 latency；
- retry rate；
- duplicate attempt；
- queue / lock / connection pressure；
- dependency failure。

### B. Canonical Integrity

至少：

- duplicate canonical identity；
- dangling reference；
- broken predecessor；
- illegal lineage；
- registry / canonical divergence；
- missing required receipt；
- projection divergence。

关键目标：

```text
Critical Canonical Integrity Violation = 0
```

### C. Authorization Health

至少：

- Unauthorized Allow；
- False Deny；
- Privilege Expansion；
- Scope Escape；
- expired grant still effective；
- revoked grant still effective；
- client / agent / MCP authority expansion。

最关键：

```text
Unauthorized Allow = 0
Privilege Expansion = 0
```

### D. State Machine Health

至少：

- illegal transition；
- partial transition；
- duplicate transition；
- transition without authorization；
- transition without receipt；
- replay divergence。

### E. Receipt Health

至少：

- missing receipt；
- invalid target；
- actor mismatch；
- revision mismatch；
- unverifiable receipt。

### F. checkpoint / retry / idempotency

鉴于当前已发现 `checkpoint` 重复提交漏洞，HS-1 必须把：

```text
Duplicate Commit
Duplicate Receipt
Duplicate State Mutation
Idempotency Violation
```

列为第一批真实监测项。

## 6.3 HS-1 误报控制

Health System 自己不能成为噪音源。

因此 R11 必须记录：

```text
true_positive
false_positive
false_negative（能确认时）
signal_latency
diagnosis_latency
```

不允许：

```text
一个 warning
=
自动升级成 F4
```

## 6.4 HS-1 输出

每次 Shadow 周期至少产生：

```text
KernelHealthReport
+
HealthFinding[]
```

Finding 必须绑定：

- exact target revision；
- environment；
- detector；
- evidence reference；
- severity；
- affected surface；
- current confidence；
- recommended next action。

---

# 7. HS-2：Surgical Drill（非生产）

HS-2 的任务不是修真实生产事故，而是证明：

> 真出事故时，我们有能力按“麻醉 → 止血 → 小手术 → 验证 → 恢复”完成。

HS-2 进入前至少要求：

```text
HS-1 的只读 Health / Finding 路径已经可运行
+
Drill 环境没有未解释的 Critical Drift
+
Drill 不需要生产 Emergency Authority
```

## 7.1 Drill 场景

至少覆盖：

1. Projection Drift；
2. checkpoint duplicate submission；
3. Consumer retry / duplicate request；
4. expired / revoked Grant；
5. invalid state transition；
6. dependency timeout；
7. partial transaction failure；
8. known-safe rollback；
9. capability disable / read-only containment。

## 7.2 Drill 标准链

```text
Synthetic Finding
↓
Severity Classification
↓
Containment
↓
Exact Target Identity
↓
Impact Snapshot
↓
Repair Boundary
↓
Minimum Repair Candidate
↓
Targeted Verification
↓
Apply
↓
Critical Post-op Verification
↓
按 Drill 场景：
  ├─ 保持修复态并验证 Restore-to-Service
  └─ 或执行 Rollback → 验证 Known Safe State
```

Rollback 必须被演练，但不要求每个单次 Drill 在已经验证修复成功后再无意义地来回切换状态。

## 7.3 Drill 必须测量

至少：

```text
Time to Detect
Time to Contain
Time to Diagnose
Time to Safe State
Repair Duration
Rollback Duration
Blast Radius
Scope Creep
Post-op Result
```

## 7.4 Drill 禁止事项

- 不使用真实生产破坏性数据；
- 不创建长期 Emergency Authority；
- 不证明“Agent 能自动修生产”；
- 不允许 Drill 结果覆盖正式 Slice A 验收。

---

# 8. Slice A 验收增加 Repairability Gate

本方案不建议为 Slice A 新增一整套复杂 Gate。

只增加一个横向：

> **Repairability Gate**

它必须回答以下问题。

## RG-01 Isolation

受影响模块能否局部隔离？

## RG-02 Read-only

受影响写路径能否快速切成只读 / deny？

## RG-03 Capability Disable

高风险 Capability 能否快速关闭？

## RG-04 Authorization Revoke

Grant / capability 是否可以被快速 revoke？

## RG-05 Rollback

当前正式 Revision 是否存在可验证回滚路径？

## RG-06 Projection Rebuild

Projection 错误时能否从 Canonical 重建？

## RG-07 Replay

需要重放的关键路径能否确定性 Replay？

## RG-08 Blast Radius

是否能计算或至少确定受影响对象 / consumer / scope？

## RG-09 Receipt

修复动作是否能产生可验证 Repair Receipt？

## RG-10 No Hidden Emergency Path

当前不存在绕过正式 Authorization 的隐藏紧急写入口。

只有这些通过后，系统才算：

```text
不仅能运行
而且出事以后可救
```

---

# 9. Slice A 通过后：HS-3 Controlled Surgical Lane

只有以下前置条件满足后，才允许 HS-3：

```text
A01–A11 适用 P0 已关闭
+
R11 Shadow 已完成
+
HS-1 Health Shadow 可用
+
HS-2 Surgical Drill PASS
+
Slice A 完整验收 PASS
+
Repairability Gate PASS
```

---

# 10. Surgical Minimum Controls

任何真实 Surgical Repair 无论多紧急，都不得取消：

## SM-01 Exact Target Identity

必须绑定精确：

- commit / build / artifact digest；
- environment；
- config revision；
- schema revision（适用时）。

禁止用 `latest`。

## SM-02 Exact Incident / Finding

必须存在明确 Incident / Finding 身份。

## SM-03 Exact Affected Scope

必须最少知道：

- subsystem；
- environment；
- capability；
- object / selector；
- consumer（适用时）。

## SM-04 Authorized Surgical Actor

执行者必须是已资格化主体。

## SM-05 Recovery Strategy

必须有：

- rollback；
- snapshot；
- previous revision；
- transaction rollback；
- containment-only fallback；

至少一种明确恢复策略。

## SM-06 Repair Boundary

必须定义：

```text
Allowed Modules
Allowed Files
Allowed Objects
Allowed Actions
Allowed Schema
Allowed Consumers
```

## SM-07 Critical Post-op Verification

术后生命级检查必须立即执行。

## SM-08 Surgical Receipt

必须产生不可丢失的修复记录。

---

# 11. Containment / “麻醉”机制

真实事故首先优化：

> Stop Damage Expansion

## 11.1 Fail-closed Containment 可以先于完整诊断

对于 F4 或正在持续扩大损害的 F3，**止血不得被完整 RCA、完整 Blast Radius 或完整修复方案阻塞**。

只要该动作来自预先授权的安全收窄能力，就允许优先执行：

```text
Deny
Read-only
Disable
Pause
Revoke
Isolate
```

此类快速 Containment 必须满足：

```text
只收窄，不扩权
只阻止继续损害，不创造新的 Canonical 业务事实
可追踪
可恢复
绑定 Incident / Environment / Scope
```

因此：

> Exact Target Identity、Repair Boundary 等是正式“动刀”前的最低控制；安全的 fail-closed 止血动作可以更早发生。

这保证“麻醉 / 止血”不会因为等待完整诊断而失去意义。

可用动作按现有能力逐步实现：

```text
Disable Capability
Read-only
Deny Specific Write
Freeze Affected Scope
Isolate Consumer
Pause Worker
Revoke Grant
Reject Risky Transition
Stop Retry Loop
```

原则：

> 尽量只让病灶区域安静，不把整个 Clued 一起停掉。

---

# 12. SurgicalGrant

HS-3 后才允许实现真实 SurgicalGrant。

必须：

```text
Incident-bound
Scope-bound
Environment-bound
Action-limited
Time-limited
Non-delegable
Auto-expiring
```

建议至少绑定：

```text
incident_id
principal
environment
target
scope
allowed_actions
repair_class
reason
issued_at
expires_at
```

约束：

```text
SurgicalGrant
⊆
pre-qualified emergency authority envelope
⊆
Policy / Registry / Hard Constraint
```

SurgicalGrant 的含义是**激活预先资格化、已被根策略允许的紧急能力**，不是临时绕过根策略，也不是凭事故创造新的超级权限。

它不能：

- 突破 tenant / project / environment 硬边界；
- 绕过不可委托动作；
- 把 Agent 临时权限变成永久真人权限；
- 在 Incident 结束后继续有效；
- 成为新的永久超级管理员入口。

---

# 13. Minimum Necessary Repair

Surgical Lane 只用于真实 Finding / Incident，不得用于：

```text
计划内功能开发
普通重构
常规依赖升级
预定 Migration
为了赶进度而跳过正常 Gate
```

Surgical Mode 中只允许：

> 修当前疾病所必需的最小原因。

例如问题在：

```text
authorization.evaluate_scope()
```

允许：

- 对应函数；
- 对应规则；
- 必要配置；
- 定向测试。

禁止顺便：

- 重构整个 Authorization；
- 修改 Naming；
- 大规模依赖升级；
- 重写 Registry；
- 修改不相关 Receipt schema；
- 清理历史技术债。

---

# 14. Surgical Change Budget

每次 Surgical Repair 建立：

```text
RepairBoundary
```

如果修复中发现实际改动超出原 Boundary：

```text
STOP
↓
重新计算 Blast Radius
```

不能让“快速修复”无限长大。

如果已经演变为：

```text
多个模块
+ Schema
+ API Contract
+ 多 Consumer
+ Authority Model
```

则必须退出 Surgical Mode，转：

```text
CONTROLLED_REPAIR
```

事故期间可以继续保持 Containment。

---

# 15. 修复优先级

优先使用侵入性最低方式：

```text
1. Disable / Isolate
2. Restart / Reconnect
3. Rebuild Projection
4. Config Revert
5. Code Patch
6. Schema Migration
7. Canonical Correction
8. Authority Root Repair
```

越往下越不应追求“几分钟内直接改完”。

---

# 16. Critical Post-op Verification

真实手术后，无需立即跑全部正常发布 Gate，但以下不可延期：

## C1
原始 Finding 是否已关闭。

## C2
Unauthorized Allow = 0。

## C3
Privilege Expansion = 0。

## C4
没有新增 Canonical Critical Violation。

## C5
受影响 State Transition 合法。

## C6
Receipt 可生成、可验证。

## C7
受影响 Read / Write Smoke Test 通过。

## C8
适用时 Replay Deterministic。

## C9
checkpoint / retry / idempotency 未出现新的重复副作用。

## C10
Recovery / Rollback Path 仍可用。

## C11 — F4 / R4 独立术后验证

若事故属于：

```text
F4
或
R4
```

则：

> 手术执行本身不得为了等待完整独立 Review 而被无限推迟；但在重新全面开放受影响的高风险 Capability 前，必须由与 Surgical Executor 不同的合格 Post-op Verifier 完成关键独立复核。

在独立复核完成前，可以保持：

```text
Containment
Read-only
Restricted Capability
```

而不是为了“尽快恢复全部功能”取消最后一道关键验证。

---

# 17. POST_OP

手术完成不得直接：

```text
SURGICAL
→
HEALTHY
```

必须先进入：

```text
POST_OP
```

POST_OP 期间：

- 提升监控密度；
- 观察原 Finding；
- 观察新 Critical Finding；
- 观察 Authorization；
- 观察 Canonical drift；
- 观察 duplicate / retry；
- 对相关 Capability 必要时保留限制。

退出条件：

```text
Original Finding Closed
+
Critical Checks PASS
+
No New Critical Finding
+
No New Canonical Divergence
+
No New Authorization Violation
```

之后才能恢复：

```text
NORMAL / HEALTHY
```

---

# 18. Surgical Abort / Rollback

以下任一情况必须停止继续扩大 Patch：

- Target Identity 不确定；
- Blast Radius 明显扩大；
- 第二个未知 Critical Finding 出现；
- Repair Candidate 无法稳定复现；
- 不可逆修改且无 Recovery Point；
- Post-op Critical Check FAIL；
- Canonical Divergence 加重；
- Authorization 风险加重。

优先：

```text
Rollback
↓
Known Safe State
↓
重新诊断
```

禁止：

```text
Patch 1
↓
Patch 2
↓
Patch 3
↓
Patch 4
```

直到没人知道系统当前状态。

---

# 19. Canonical / Receipt 修复规则

## 19.1 Canonical 不做静默重写

错误历史必须：

```text
Original State
↓
Finding
↓
Repair Decision
↓
Correction / Superseding Operation
↓
Repair Receipt
```

## 19.2 Receipt 不回写历史

已有 Receipt 默认不可变。

需要纠错时：

```text
Old Receipt
保持不变
↓
Finding
↓
Correction / Superseding Receipt
```

## 19.3 Migration

禁止直接手工批量 UPDATE 代替正式修复身份。

至少：

```text
Migration Identity
↓
Dry Run
↓
Affected Object Count
↓
Apply
↓
Verification
↓
Repair Receipt
```

---

# 20. 自动化边界

第一阶段不允许自动生产 R3 / R4 Repair。

未来可逐步自动化：

```text
R0 / R1
```

例如：

- known-safe restart；
- projection rebuild；
- consumer reconnect；
- cache clear；
- safe config revert。

R3 / R4 默认仍需明确人类/正式 Authority 决策。

---

# 21. 角色槽位

不把本机制绑定某个固定模型或工具。

逻辑角色：

```text
Health Observer
Incident Coordinator
Surgical Executor
Post-op Verifier
Recovery Authority
```

实际 Candidate 可以是：

- Human；
- Clued Agent；
- External Agent；
- Automation。

但必须服从真实 Qualification + Authorization。

---

# 22. 证据与 Receipt

事故期间不要求执行者先写长报告。

On-path 必须自动留下：

```text
incident_id
finding_id
exact target
actor
surgical grant ref
affected scope
pre-state / recovery ref
repair boundary
repair candidate identity
actual changed artifacts
post-op verification
rollback state
final status
timestamps
```

建议正式对象：

```text
KernelSurgicalRepairReceipt
```

完整 RCA / Architecture Review / 长期治理可在系统稳定后补齐。

“后补”不等于“可永久不补”。Deferred Evidence：

```text
不得阻塞 Time-to-Safe-State
但必须在 Incident 正式 Close 前完成
```

并且在同一受影响子系统的下一次正常高风险 Release / Migration 前，未完成的关键 Follow-up 必须被显式处理或形成新的受控阻断决定。

---

# 23. 事故后的 Follow-up

恢复安全后再进入：

```text
Root Cause Analysis
↓
为什么原机制没有发现
↓
长期 Prevention
↓
必要 Architecture Correction
↓
Full Regression
↓
Evidence Completion
↓
关闭 Incident
```

必须避免：

```text
“先恢复服务”
=
“问题永远结束”
```

---

# 24. 长期核心指标

Kernel Health：

```text
Critical Integrity Violations
Unauthorized Allow
Privilege Expansion
Illegal Critical Transition
Missing Required Receipt
Replay Divergence
Projection Drift
```

Repairability：

```text
Time to Detect
Time to Contain
Time to Diagnose
Time to Safe State
Time to Verified Recovery
Rollback Success Rate
Surgical Success Rate
Post-op Failure Rate
Blast Radius
Scope Creep Rate
Evidence Completion Lag
```

最高优先 KPI：

```text
Time to Safe State
```

---

# 25. 当前执行者的具体任务清单

## 现在：R07–R10

执行：

- [ ] 不改变现有 P0 优先级；
- [ ] 在不阻塞 P0 的前提下建立 HS-0 合同草案；
- [ ] 列出 Hook Point；
- [ ] 明确 HealthFinding / Severity / RepairClass；
- [ ] 明确 RepairBoundary；
- [ ] 明确 Post-op Critical Checks；
- [ ] 对 `checkpoint` 重复提交漏洞补充 idempotency health signal；
- [ ] 确认当前不存在新增 Emergency bypass；
- [ ] 仅做 HS-0 Preparation，不在当前 P0 收口前宣称 `CONTRACT_READY`。

不要执行：

- [ ] 不创建生产 SurgicalGrant；
- [ ] 不自动修复；
- [ ] 不改变生产 Authority；
- [ ] 不额外扩成新大工程。

## R11

- [ ] 开启 HS-1 Health Shadow；
- [ ] 形成真实 KernelHealthReport；
- [ ] 统计 Finding 误报；
- [ ] 覆盖 Authorization / Canonical / State / Receipt / checkpoint；
- [ ] 执行 HS-2 Surgical Drill；
- [ ] 记录 Time-to-Safe-State。

## Slice A 验收

- [ ] 执行 Repairability Gate RG-01–RG-10；
- [ ] 独立验证关键 repairability；
- [ ] 未通过不得把真实 Surgical Lane 视为 Ready。

## Slice A 之后

- [ ] 实现 Surgical Eligibility；
- [ ] 实现 SurgicalGrant；
- [ ] 实现 Containment Actions；
- [ ] 实现 RepairBoundary Enforcement；
- [ ] 实现 SurgicalRepairReceipt；
- [ ] 实现 POST_OP；
- [ ] 实现真实 rollback / recovery 验证。

---

# 26. 执行完成判定

本方案不能用一句：

```text
“Health 功能写完了”
```

判定完成。

分阶段状态：

```text
HS-0 CONTRACT_READY
HS-1 SHADOW_HEALTH_VERIFIED
HS-2 SURGICAL_DRILL_VERIFIED
HS-2.5 REPAIRABILITY_ACCEPTED
HS-3 CONTROLLED_SURGICAL_LANE_READY
HS-4 OPERATIONAL
```

只有每一步有真实 Evidence 后才能升级状态。

---

# 27. 对当前主线的保护规则

本方案必须服从以下硬规则：

> **不得因为新增 Health / Surgical 能力而延误当前 A01–A11 P0 收口。**

> **不得把 Surgical Mode 设计成第二套 Kernel。**

> **不得把 SurgicalGrant 设计成第二套 Authorization。**

> **不得把 Health Detector 设计成第二套 Canonical Truth。**

正确关系：

```text
Health
观察现有 Kernel

Surgical
受控操作现有 Kernel

Authorization
仍然决定谁能做什么

Canonical
仍然决定什么是真实状态

Receipt
仍然记录实际发生了什么
```

---

# 28. 给当前执行者的最终执行指令

请按以下优先级执行：

```text
Priority 1
继续完成当前 R07–R10 / A01–A11 P0 收口

Priority 2
在不阻塞主线的前提下完成 HS-0
只做合同与 Hook Point Freeze

Priority 3
进入 R11 后运行 HS-1 Health Shadow

Priority 4
在非生产 Shadow 环境运行 HS-2 Surgical Drill

Priority 5
Slice A 完整验收时执行 Repairability Gate

Priority 6
只有 Slice A 和 Repairability 均通过后
才实现真正 Controlled Surgical Lane
```

不得提前跳到 Priority 6。

---

# 29. 最终原则

本方案的目标不是创造更多治理负担。

目标是：

```text
平时严谨
↓
早发现

事故发生
↓
快速止血

真正修复
↓
手术刀式最小改动

术后
↓
只做生命级关键验证

安全恢复
↓
再完成完整复查
```

最终应形成一个：

> **能早发现、能局部隔离、能快速止血、能精确小修、能安全回滚、能术后证明、能恢复运行、又不会因为治理流程把一次短故障拖成长事故的 Clued Kernel。**


---

# 30. 固定身份与变更规则

本文件固定接受身份：

```text
Baseline ID:
CLUED-KERNEL-HEALTH-SURGICAL-REPAIR-INTEGRATION-v0.1-20260908

Status:
FIXED / EXECUTION BASELINE
```

本 v0.1 固定后：

- 当前执行者可按本文件直接执行；
- 不得静默修改本文件字节并继续沿用同一固定身份；
- 后续若发现需要改变执行顺序、Authority 边界、Surgical Minimum Controls、Repairability Gate 或 HS-3 进入条件，应生成显式后继版本；
- 普通实现细节在不改变本文件合同语义的前提下，可由执行者在现有主线内完成，不要求为每个代码细节升版本；
- 本文件不宣称 HS-0～HS-4 已实现，仅固定“应该何时、以什么边界实现”。

