# R3-Gate2 实现说明：Claim Gate 全面接入、Adapter 合同、三轴状态、六动作生命周期

- **依据**：产品所有者裁决（有条件授权 R3 Gate 2）——"完成上述三项启动前复核并消除矛盾后，可直接启动 R3 Gate 2"
- **前置复核**：已完成并提交（`勘误-启动前三项复核.md`，提交 2397332）
- **执行边界**：全部实现在隔离环境（临时目录）验证；不触碰真实 memory/冻结区；
  不 push/tag/release；不 amend/rebase；不把 Python 直写 refs/remotes 作为正式方案。

---

## 1. R3-T05：Truth Claim Gate 全面接入（`memory_engine/truth/integration.py`）

| 裁决要求 | 实现 |
|---|---|
| Claim Gate 接入所有召回/读取/绑定/pre-answer 路径 | `TruthAwareRecall` 包装召回；`pre_answer_gate` 统一入口；`BypassGuard` 旁路守卫 |
| 验证 receipt 缺失/过期/篡改/revision 不一致时 fail-closed | `ClaimGate.check` + `TruthReceipt.validate`（test_truth_integration 12 项断言） |
| 旁路测试（Adapter 无法绕过 Claim Gate） | `BypassGuard.strict`（ENFORCED 候选模式）阻断未带 receipt 标记的访问；e2e `test_e2e_adapter_bypass_blocked` |
| 状态区分 | `ANSWER_STATES`：NO_MEMORY / UNVERIFIED / TAMPERED / STALE / DENIED / ENV_UNAVAILABLE / VERIFIED |
| 禁止"无法核验"误报"没有记忆" | `classify_answer`：无内容→NO_MEMORY；有内容+无 receipt→UNVERIFIED（≠NO_MEMORY）；环境故障→ENV_UNAVAILABLE |

## 2. R3-T06：版本化 Adapter 公共合同（`memory_engine/truth/adapter_contract.py`）

- `ADAPTER_CONTRACT_VERSION = 1`；五方法 `query/receipt/claim_gate/capability/lifecycle`；
- `validate_adapter` fail-closed（版本不匹配/缺方法/无 capability → ContractViolation）；
- `CapabilityReporter`：UNAVAILABLE→ADVISORY→AUDIT→ENFORCED 逐级保守升级 + demote 降级；
- `TruthAwareAdapter`：query 走 TruthPlanner，读取经 TruthAwareRecall（不直 Git、不自判 PASS）；
- Adapter 不得暴露 git 直连方法（合同层探测）。

## 3. 三轴状态模型（`memory_engine/lifecycle_ctl/states.py`）

| 轴 | 状态集 | 机器校验 |
|---|---|---|
| Binding Lifecycle | ABSENT / INSTALLING / ACTIVE / DISABLED / BROKEN / UNINSTALLING / UNINSTALLED | 转移矩阵（INV-5） |
| Session & Sync | ONLINE / DEGRADED / OFFLINE / DENIED | INV-3（DISABLED 不得 ONLINE） |
| Truth Capability | UNAVAILABLE / ADVISORY / AUDIT / ENFORCED | INV-1/4/6 |

不变量 INV-1..6 由 `validate_invariants` 机器校验（test_lifecycle_ctl 17 项锁定）：
- INV-1：DISABLED/UNINSTALLED 不得携带 ENFORCED；
- INV-2：repair 不得把 DISABLED 改 ACTIVE；
- INV-3：disable 后禁止读/写/同步；
- INV-4：ACTIVE 不自动等于 ENFORCED（ENFORCED 需 conformance 证据）；
- INV-5：一切迁移命中转移矩阵；
- INV-6：UNINSTALLED 清理（purge）前 truth 非 ENFORCED。
**禁止语义**：不把"已安装"当 ACTIVE（ABSENT/INSTALLING 与 ACTIVE 严格区分）；
不把"在线/ACTIVE"当 ENFORCED（Truth 轴独立）。

## 4. R3-L01~L05 六动作（`memory_engine/lifecycle_ctl/controller.py`）

| 动作 | 语义（裁决要求） | 实现要点 |
|---|---|---|
| install | 安装事务，默认 ADVISORY（不得直接 ENFORCED） | ABSENT→INSTALLING→ACTIVE；幂等 ALREADY_INSTALLED |
| repair | 不得意外把 DISABLED 改 ACTIVE | BROKEN→ACTIVE；DISABLED 保持 DISABLED（REMAIN_DISABLED） |
| update | staging→完整校验→原子切换→失败回滚 | 复用 dist ArtifactAcquisition + AtomicArtifactStore；失败保留旧 revision |
| disable | 独立、持久、可逆；禁用读/写/同步 | ACTIVE→DISABLED + session=OFFLINE + truth=UNAVAILABLE；`assert_operations_allowed` 拒绝 |
| enable | 重新授权+构件+Truth 能力检查 | auth_check/artifact_check/conformance 全过才 ACTIVE；conformance 过→ENFORCED（隔离候选） |
| uninstall | 默认只解绑当前 Agent | UNINSTALLED 状态保留（幂等 ALREADY_UNINSTALLED）；其他 binding 零影响；purge 清理 |

- 幂等：install/disable/uninstall 重复调用返回幂等标记，不报错；
- 中断恢复：操作 journal（begin/stage/end），`recover_pending()` 将遗留 INSTALLING→BROKEN；
- 每 Binding 独立状态文件（隔离），不触碰共享 Core / canonical memory / 冻结区。

## 5. 临时 home E2E（`tests/test_lifecycle_e2e.py`，5 项）

- `test_e2e_full_six_actions_with_invariants`：六动作全流程 + 每步 INV 校验 + 多 Binding 隔离；
- `test_e2e_enforced_candidate_in_isolated_env`：conformance 证据链 → enable 后 ENFORCED（仅隔离候选）；
- `test_e2e_adapter_bypass_blocked`：伪制 Adapter 旁路读取被阻断，带 receipt 通过；
- `test_e2e_fake_adapter_contract_and_lifecycle`：合同五方法 + lifecycle 走控制器；
- `test_e2e_multi_binding_isolation`：多 Binding 共享与隔离。

## 6. 测试结果

- **Gate 2 新增 4 文件 47 项：0 失败**（truth_integration 15 + adapter_contract 10 + lifecycle_ctl 17 + lifecycle_e2e 5）；
- Gate 1 8 文件 68 项复跑：0 失败（无回归）；
- 全量（28 文件）结果见 Gate 2 报告 §Test Evidence。

## 7. 边界确认（裁决逐项）

- [x] 临时 home/临时仓库/伪制 Adapter 中验证 ENFORCED 候选
- [x] 默认及真实环境保持 ADVISORY/AUDIT（本实现无真实环境切换）
- [x] Gate 2 不正式切换到 ENFORCED（裁决保留给 Gate 3）
- [x] 不修改真实 memory/objects/**、canonical index 或冻结区
- [x] 不下载 Embedding 模型或模型权重
- [x] 不 push/tag/release；不 amend/rebase/改写历史
- [x] 不把 ENV-DEFECT 的 Python 直写 ref 作为正式解决方案
