# HS-0 合同与接线点准备

**状态：PREPARATION_ONLY。** 仅新增这两份准备文件，不改 Runtime，不运行 Health，不创建 SurgicalGrant、Authority、Canonical 或 wire，不增加主线 P0。

固定基线 `CLUED-KERNEL-HEALTH-SURGICAL-REPAIR-INTEGRATION-v0.1-20260908`，原文 26750 字节，独立复算 SHA256：`44f59133c78e113710d5ee19e89c8a12a1393b15da27bb9290b521e8294a0b26`。原文字节未改。受查仓库源：`f93e09c2d6c0826f3a8f6a1e9016bc5b5f293ae3`。11 个源码文件、33 个精确行号及完整文件摘要保存在 [HS0Preparation.json](HS0Preparation.json)。

## 固定顺序与适用范围

当前适用 R07–R10 P0 收口 → HS-0 正式 Freeze/Acceptance → R11 Shadow → HS-1 只读 Health Shadow → HS-2 非生产 Drill → Slice A 完整验证并执行 HS-2.5 Repairability → Slice A 与 Repairability 接受 → HS-3 → HS-4。当前仅按 §4.1 并行准备，不宣称 HS-0 已完成。

§4 写“R07–R10 / A01–A11 P0 收口”，§4.1 则明确“R07–R10 当前适用 P0”。若把前者解释为包括下游 R11、Slice A、72 次测量和最终验收的全部 A 项，便会与 HS0 在 R11 前形成循环。这里只提交区分当前适用 P0 的解释建议；不静默改顺序、不免除 Gate。若必须改变原固定顺序，需显式后继基线。

## 九个逻辑对象

以下均为逻辑接线准备，未建立 Runtime 合同或第二套权威。Severity 表示风险/紧急程度，RepairClass 表示修复深度/范围；F4+R1 与 F2+R3 都合法，Severity 不扩大权限。

| 对象 | 语义边界 | Hook |
|---|---|---|
| KernelHealthReport | Bounded observation aggregate; cannot replace Canonical truth | H09 |
| HealthFinding | Exact revision/environment/detector/evidence/severity/surface/confidence/action; no auto-repair | H01, H04, H05, H06, H09, H10 |
| FindingSeverity | Risk/urgency F0–F4, independent from repair extent; no automatic privilege expansion | H09 |
| RepairClass | R0–R4 modification depth/scope, independent from severity | H04, H07, H11 |
| ContainmentState | Traceable pre-authorized narrowing only; deny/read-only/disable/pause/revoke/isolate | H01, H11 |
| SurgicalModeState | Future controlled SURGICAL → POST_OP → safe restored state; not installed | H05, H07 |
| RepairBoundary | Allowed Modules/Files/Objects/Actions/Schema/Consumers; exceed boundary stops patch expansion | H01, H04, H05, H11 |
| SurgicalRepairReceipt | Future on-path immutable repair evidence via existing receipt authority, not a second receipt truth | H06 |
| CriticalPostOpVerification | C1–C11 scoped immediate checks, with separate qualified verifier before high-risk full reopening for F4 or R4 | H01, H04, H05, H06, H07, H10 |

RepairBoundary 固定六维：Allowed Modules、Files、Objects、Actions、Schema、Consumers。超范围停止扩大补丁并重新核对影响范围；不再属于最小修复时转 Controlled Repair，可继续保留已授权收窄。当前未实现 enforcement。

§22 建议名称 `KernelSurgicalRepairReceipt` 与 §5.2 的 `SurgicalRepairReceipt` 保持原文身份，作为待接入既有命名/Receipt 合同的问题；此处不发行新别名或第二个 wire 类型。

## 十一类 Hook

这些是现有承载点，不代表已有 Health/Surgical 接线或正式资格。

| Hook | 已核实精确入口 | 当前边界 |
|---|---|---|
| H01 Authorization decision | `apps/clued-cloud/supabase/migrations/20260907173031_clued_connection_authorization_v12.sql:318` | Existing binding/action scope and revocation decisions. Health observation is not wired; no Surgical authority. |
| H02 Entry / qualification | `scripts/phase2-qualification/controller.py:75` | Existing request dispatch and local candidate validation only; formal R11/controller qualification is NOT_IMPLEMENTED by these anchors. |
| H03 Shadow | `scripts/phase2-qualification/controller.py:183` | Only fixed synthetic local candidate execution exists here; actual R11/HS1 Shadow observer is NOT_IMPLEMENTED. |
| H04 Canonical read / write boundary | `apps/clued-cloud/supabase/migrations/20260907131834_clued_search_canonical_records.sql:2` | Existing authorized search/M1 mutation boundaries; Health is observation only, no alternate Canon. |
| H05 State transition | `apps/clued-cloud/supabase/migrations/20260825171129_clued_m1_runtime_contracts.sql:282` | Existing record lifecycle and checkpoint stream CAS; no Surgical/POST_OP state machine. |
| H06 Receipt emission | `apps/clued-cloud/supabase/migrations/20260825171129_clued_m1_runtime_contracts.sql:471` | Existing M1 transaction receipt finalization and checkpoint receipt insert; no SurgicalRepairReceipt emitter. |
| H07 Recovery / rollback | `scripts/isolated_mirror.py:565` | Actual local read-only mirror LKG recovery and candidate read-only reconciliation; not a production runtime/DB rollback qualification. |
| H08 Projection / consumer | `scripts/memory.py:44` | Existing read-only snapshot source/hash validation; complete online Canonical-to-projection rebuild must be bound separately. |
| H09 Observability / error event | `apps/clued-cloud/worker/continuity.ts:973` | Existing protocol/storage error output can feed future scoped signals; no Health cycle, latency aggregation or detector installed. |
| H10 checkpoint / retry / idempotency | `apps/clued-cloud/supabase/migrations/20260908094000_clued_checkpoint_idempotency_binding.sql:3` | Exact repaired SQL and real local PG checks; f93e09c source only, not deployed at this preparation point. |
| H11 configuration / capability disable point | `apps/clued-cloud/worker/continuity.ts:906` | Existing feature gates/revoke and local STOP are candidate containment integration points; no automatic or new grant-authorized containment added. |

## 控制与 Gate 对照

JSON 逐项保留并映射 **C1–C11、SM-01–SM-08、RG-01–RG-10**，每项引用上列源码行号及摘要。全部为 PREPARATION_ONLY；未执行 Health/Post-op/Repairability。现有局部回归只是可复用证据，不替代这些 Gate。

- C1/C7/C8/C9 可引用 checkpoint 真实局部反例与定点回归；C2/C3 接既有授权判断；C4/C5 接 Canonical/state；C6 接既有 Receipt；C10 接实际镜像恢复；C11 的不同合格 Post-op Verifier 尚未绑定。
- SM-01–08 的精确对象、Incident、范围、合格主体、恢复、Boundary、术后检查和 Surgical Receipt 均不得由准备材料签发。
- RG-01–10 覆盖隔离、只读、关闭 capability、revoke、rollback、projection rebuild、replay、blast radius、repair receipt、无隐藏紧急入口。局部镜像回滚不能冒充生产回滚，固定合成 controller 不能冒充合格 Shadow 宿主。

F4 或 R4 的独立关键复核必须先于全面重开高风险 capability；可在复核期间保留 containment/read-only。预授权的安全收窄可先于完整诊断，但此处没有签发这种授权。

## Checkpoint Health Signal

已观察的真实缺陷是：旧实现改变 payload 仍误回 duplicate；跨 context 误回旧 checkpoint 并标注请求 context；JSON null base 绕过旧 CAS。这些来自真实隔离 PG 反例及受查函数，不是已确认的生产事故。修复源 f93e09c 已有 12 项独立 PG 与 2 项迁移链检查证据，准备时尚未部署；本次不重复执行。

**未观察到实际双 checkpoint、双 receipt、重复生产状态修改或用户损害，不把它们写成发生。** 四类监测均为设计待运行：

| 首批监测 | 未来观察判据 |
|---|---|
| Duplicate Commit | Count persisted checkpoint identities per owner/binding/idempotency_key; distinguish request attempts from committed effects. |
| Duplicate Receipt | Compare checkpoint receipt identity/operation/object/version with expected one emitted receipt; replay should reuse rather than create another. |
| Duplicate State Mutation | Correlate actual stream version/target transition and immutable receipt for the same accepted intent; do not infer mutation from an HTTP retry. |
| Idempotency Violation | Detect same-key changed effective payload/context returning duplicate, or a false success/conflict mapping; bind original receipt base and exact request fields. |

后续 HS-1 必须绑定精确 revision/environment/detector/evidence/scope，记录 true positive、false positive、可确认时的 false negative、signal latency、diagnosis latency。没有真实运行数据，不报告健康等级、发生率或 Time-to-Safe-State 数值。

这份准备只回答观察、隔离、恢复能接在哪里。当前主线优先级和资格要求不变，未宣称 CONTRACT_READY、Freeze 或任何 HS 阶段验收结果。
