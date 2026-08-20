# R3-Gate3-A 生产接线证据（重点交付物）

- **授权**：产品所有者 ——"授权继续执行 Gate 3-A：生产路径接线。完成后重点提交：
  生产入口清单、逐入口 Claim Gate 覆盖、旁路阻断证明，以及 Adapter 自报能力
  不能自行升级 ENFORCED 的测试证据。"
- **状态**：实现 + 隔离测试全绿（test_production_wiring 10 项 / 0 失败）

---

## 1. 生产入口清单（PRODUCTION_ENTRIES，机器可读）

`memory_engine/truth/entry_inventory.py`：

| # | 入口 | 守卫（Claim Gate 覆盖） | 语义 |
|---|---|---|---|
| 1 | adapter.read | TruthAwareRecall.recall | 读取前门禁：无有效 receipt → UNVERIFIED（≠NO_MEMORY） |
| 2 | adapter.recall | TruthAwareRecall.recall | 召回前门禁（同 read 路径） |
| 3 | adapter.write | BypassGuard.call + lifecycle.assert_operations_allowed | 写入前：binding 状态 gate（DISABLED 拒绝）+ receipt 标记 |
| 4 | adapter.sync | BypassGuard.call + lifecycle.assert_operations_allowed | 同步前：同 write（DISABLED 拒绝同步） |
| 5 | adapter.pre_answer | pre_answer_gate | 回答前统一入口：环境故障 → ENV_UNAVAILABLE；无 receipt → UNVERIFIED |

**逐入口 Claim Gate 覆盖**：`TruthEnabledAdapter`（adapters/truth_adapter.py）五个方法
逐一接线，且 `_gate_marker(name)` 返回每个入口是否实际受保护（供清单校验）。

## 2. 旁路阻断证明（verify_zero_bypass）

- `verify_zero_bypass(adapter)`：逐入口检查（入口存在 + 可调用 + `_gate_marker=True`）；
- 任何入口缺失 / 不可调用 / 未受保护 → `BypassFound`（旁路检出）；
- 测试证据（test_production_wiring）：
  - `test_zero_bypass_with_truth_adapter`：TruthEnabledAdapter → **checked=5 / bypass=0**；
  - `test_bypass_detected_when_entry_unguarded`：模拟 `_gate_marker=False` → BypassFound；
  - `test_negative_missing_entry`：入口被遮蔽为不可调用 → BypassFound。

## 3. Adapter 自报能力不能自行升级 ENFORCED（测试证据）

`ConformanceVerifier`（memory_engine/truth/conformance.py）设计：
- **CapabilityReporter 只提供声明**（`adapter.capability()`）；
- **最终能力档位由外部 ConformanceVerifier 生成**：绑定 revision + 合同版本 +
  receipt 有效性 + .truth-state 强绑定 + conformance 证据新鲜度 + 声明 vs 实际；
- 判定链任一环节失败 → 降级（ADVISORY）；真实环境 → 最多 AUDIT；
  隔离 + 全证据链 → ENFORCED（临时 Binding）。

测试证据（test_production_wiring）：
- `test_negative_malicious_self_report`：Adapter 恶意声明 `capability() == "ENFORCED"`，
  但无 receipt + 无 conformance evidence → 最终档位 **ADVISORY**；
  summary 记录"声明=ENFORCED → 最终=ADVISORY"（声明不作数）。
- `test_negative_wrong_revision`：revision 不匹配 → 降级（≠ENFORCED）。
- `test_negative_old_contract_version`：旧版本合同 → 拒绝（fail-closed）。

## 4. 版本矩阵执行（ADR-R3-005）

`read_version_matrix`（只读）：
- 产品 VERSION=vNext-2.0；协议 protocol-manifest=vNext-1.3；
  组件 clued PROTOCOL_VERSION=0.3.0；Adapter 合同=1；artifact schema=1；
- 跨命名空间差异判定为正常状态，不强制统一（test_version_matrix_read_and_consistent）。

## 5. 测试汇总（Gate 3-A）

| 文件 | 项数 | 失败 |
|---|---|---|
| tests/test_production_wiring.py | 10 | 0 |

（其余 Gate 3-B/C 证据见 R3-Gate3-实现说明.md 与 R3-Gate3-Report.md）
