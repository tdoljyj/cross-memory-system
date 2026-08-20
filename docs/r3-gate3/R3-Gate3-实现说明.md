# R3-Gate3 实现说明：生产接线、ENFORCED conformance、ENV-DEFECT 规避

- **依据**：产品所有者裁决 ——"确认接受，R3 Gate 3 正式启动"
- **起始基线**：`3f82797`（Gate 3 起始勘误基线；现场复核 ahead/behind 8/0、线性、porcelain 零输出）
- **归因口径**：ENV 60 / HEURISTIC 0 / UNKNOWN 0（四项 HEURISTIC 已证明并入 ENV）
- **边界**：Truth 保持 ADVISORY/AUDIT；仅临时 Binding 可 ENFORCED；仓库实现只能
  ENFORCED-CAPABLE；真实环境试装/真实 Binding 切换未授权；不 push/tag/release/真实 purge；
  不修改 canonical memory/冻结区/真实 Agent 配置。

---

## A. 生产代码路径接线（裁决 A 项）

### A1. 生产入口清单与零旁路证明（`memory_engine/truth/entry_inventory.py`）

```
PRODUCTION_ENTRIES（五入口，机器可读）：
  adapter.read        → 守卫 TruthAwareRecall.recall
  adapter.recall      → 守卫 TruthAwareRecall.recall
  adapter.write       → 守卫 BypassGuard.call
  adapter.sync        → 守卫 BypassGuard.call
  adapter.pre_answer  → 守卫 pre_answer_gate
```
`verify_zero_bypass(adapter)`：逐入口检查（入口存在 + `_gate_marker` 证明受保护），
任何未受保护入口 → `BypassFound`（旁路检出）。

### A2. 真实 Adapter 接线（`adapters/truth_adapter.py`）

`TruthEnabledAdapter(TruthAwareAdapter)`：
- read / recall：经 `TruthAwareRecall`（无有效 receipt → UNVERIFIED；ENFORCED 候选阻断）；
- write / sync：经 `BypassGuard` + lifecycle `assert_operations_allowed`（DISABLED 拒绝）；
- pre_answer：经 `pre_answer_gate`（环境故障 → ENV_UNAVAILABLE）；
- `_gate_marker`：供入口清单逐入口证明受保护（零旁路）。

### A3. 负向测试（test_production_wiring，10 项全绿）

| 场景 | 断言 |
|---|---|
| 入口缺失（未接线） | 旁路检出 |
| 旁路（_gate_marker=False） | BypassFound |
| 旧版本合同（contract_version=0） | 拒绝（fail-closed） |
| 错误版本 revision | conformance 降级（≠ENFORCED） |
| **恶意自报能力**（声明 ENFORCED 但证据不足） | 降级 ADVISORY（声明不作数） |
| read/pre_answer 门禁化 | 无 receipt→UNVERIFIED；env 故障→ENV_UNAVAILABLE |
| 版本矩阵读取 | 五命名空间可读、无同命名空间冲突 |

### A4. 版本矩阵执行（ADR-R3-005 执行层，只读）

`read_version_matrix`：产品（VERSION=vNext-2.0）/ 协议（protocol-manifest=vNext-1.3）/
组件（clued PROTOCOL_VERSION=0.3.0）/ Adapter 合同（=1）/ artifact schema（=1）。
跨命名空间差异（vNext-2.0/vNext-1.3/0.3.0）判定为**正常状态，不强制统一**。

## B. ENFORCED conformance（裁决 B 项）

### B1. .truth-state 强化存储（`memory_engine/truth/truth_state.py`）

- 原子写：tmp + os.replace（无 .tmp 残留）；
- 权限受限：尽力 chmod 0600（Windows 由用户目录 ACL 保证）；
- **强绑定**：binding_id + adapter + revision + evidence_digest（state_digest 防篡改）；
- **fail-closed**：缺失（STATE_MISSING）/ 损坏（STATE_CORRUPT）/
  被替换（STATE_TAMPERED）/ 绑定不符（STATE_MISMATCH）一律抛错；
- **不是单一真值来源**：只存 conformance 证据快照；最终档位由 ConformanceVerifier
  综合（binding 状态 + receipt + 证据新鲜度 + 快照）生成。

### B2. ConformanceVerifier（`memory_engine/truth/conformance.py`）

- **Adapter 的 CapabilityReporter 仅声明**；最终档位由外部验证器生成；
- 判定链：receipt 有效 → .truth-state 强绑定 → 证据新鲜 → 声明 vs 实际 → 分层档位；
- 恶意自报（声明 ENFORCED 但证据不足）→ 降级（summary 记录"声明=X → 最终=Y"）。

### B3. fault injection 全套（test_truth_state_conformance，13 项全绿）

| 场景 | 结论 |
|---|---|
| 无 receipt | 降级 ADVISORY |
| receipt 过期 / 篡改 | 降级 ADVISORY |
| .truth-state 缺失 / 损坏 / 被替换（TOCTOU） | fail-closed 降级 |
| revision / adapter 不匹配 | 降级 |
| conformance 证据过期 | 降级（summary 含原因） |
| 隔离 Binding 全证据链 | **ENFORCED**（临时 Binding） |
| 真实环境全证据链 | **AUDIT**（未授权切换） |
| disable 后读写同步 | 拒绝（CLD-DISABLE-001） |
| update 回滚 + journal 中断恢复 | INSTALLING→BROKEN |
| 原子写 | 无 .tmp 残留、读回一致 |

## C. ENV-DEFECT 规避（裁决 C 项，ADR-R3-006 执行）

test_env_equivalence（6 项全绿，临时 bare remote + 克隆，等价测试不扩 skip）：

| 验证 | 结果 |
|---|---|
| ls-remote 现场直取远端真值 | = seed HEAD（唯一 current 事实源） |
| 明确 SHA 直算 ahead/behind | 删除 refs/remotes/ 后仍可算（等价规避） |
| FETCH_HEAD 读取 | fetch 后普通文件可读（非 refs/remotes） |
| 独立状态文件（.truth-state） | 记录 LKG，不写 refs/remotes/origin/main |
| 远端不可达 | 只报 LKG（最后一次已验证状态），不编造当前值 |
| 代码面 | provider 无 update-ref / 无 write_ref / 用 ls-remote |

## 分层结论（Gate 3 门槛）

| 对象 | 结论 |
|---|---|
| 仓库 revision / Adapter 实现 | **ENFORCED-CAPABLE**（conformance 全过 + 零旁路 + 入口清单闭合） |
| 临时 home 通过 conformance 的测试 Binding | **ENFORCED**（隔离环境） |
| 用户真实环境 Binding | **ADVISORY/AUDIT**（等待单独试装授权） |

**不推导**：不从一个临时 Binding 的通过推导所有 Adapter/环境/产品已 ENFORCED。

## 测试结果（Gate 3 新增）

- test_production_wiring：10 项 / 0 失败
- test_truth_state_conformance：13 项 / 0 失败
- test_env_equivalence：6 项 / 0 失败
- **合计 29 项全绿**；Gate 1（68）/ Gate 2（47）回归零失败
- 全量（31 文件）结果见 R3-Gate3-Report §Test Evidence
