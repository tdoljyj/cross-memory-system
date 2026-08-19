# Cross-Memory-System R3 Gate 2 Report

- **生成**：2026-08-19T（UTC，以 commit 时间为准）
- **授权**：产品所有者裁决（有条件授权）——"完成上述三项启动前复核并消除矛盾后，可直接启动 R3 Gate 2"
- **前置复核**：三项启动前复核已完成并提交（`勘误-启动前三项复核.md`，提交 `2397332`）
- **授权范围**：R3-T05（Claim Gate 全面接入）、R3-T06（版本化 Adapter 公共合同）、
  R3-L01~L05（六动作完整生命周期）、三轴状态机器校验、临时 home E2E
- **不授权执行**：push/tag/release、真实 Agent 安装/修复/更新/停用/启用/卸载、
  真实环境试装、Embedding 模型下载、真实 memory/冻结区修改、
  Python 直写 refs/remotes 作为正式方案、Gate 2 正式切换到 ENFORCED（保留给 Gate 3）

## 1. Result

- **PARTIAL**：Gate 2 范围内交付完成；Truth 按 §18 只能标 **ADVISORY/AUDIT**
  （Claim Gate/合同/六动作在隔离环境全绿；真实环境接线与 ENFORCED 正式切换属 Gate 3）
- 已停在边界等待 Gate 3 裁决

## 2. Live Repository Truth（提交后现场复核，2026-08-19T15:43:31Z）

| 项 | Gate 2 启动 | Gate 2 完成 |
|---|---|---|
| local HEAD | `2397332` | `ca87a1234c18b02ac0885579dbfd106ec341dc37` |
| remote main（ls-remote） | `9dcc31b` | `9dcc31b`（未漂移） |
| ahead/behind（rev-list 直算） | 5/0 | **6/0**（9dcc31b..HEAD 线性 6 提交） |
| worktree（porcelain） | 零输出 | 零输出（clean） |
| 真实 memory / 冻结区 | DIFF=0 | DIFF=0 |

## 3. 实现—测试—证据映射（Gate 2 新增 47 项全绿）

| 裁决要求 | 实现 | 测试 |
|---|---|---|
| R3-T05 Claim Gate 全面接入 | `memory_engine/truth/integration.py`（TruthAwareRecall / pre_answer_gate / BypassGuard） | test_truth_integration（15 项） |
| 状态区分 NO_MEMORY/UNVERIFIED/TAMPERED/STALE/DENIED/ENV_UNAVAILABLE | `schema.ANSWER_STATES` + `classify_answer` | 同上 |
| 禁止"无法核验"误报"没有记忆" | classify_answer（无内容→NO_MEMORY；有内容无 receipt→UNVERIFIED） | 同上 |
| 旁路测试（Adapter 无法绕过） | BypassGuard.strict + e2e bypass | test_truth_integration + test_lifecycle_e2e |
| R3-T06 版本化 Adapter 合同 | `memory_engine/truth/adapter_contract.py`（ADAPTER_CONTRACT_VERSION=1，五方法，CapabilityReporter 逐级升降） | test_adapter_contract（10 项） |
| 三轴状态 + 不变量 INV-1..6 | `memory_engine/lifecycle_ctl/states.py`（validate_invariants / check_transition） | test_lifecycle_ctl（17 项） |
| 六动作 install/repair/update/disable/enable/uninstall | `memory_engine/lifecycle_ctl/controller.py`（LifecycleController + journal 恢复 + purge） | test_lifecycle_ctl |
| DISABLED 独立持久可逆 + 禁读写同步 | disable→DISABLED/OFFLINE + assert_operations_allowed | test_lifecycle_ctl + e2e |
| repair 不得 DISABLED→ACTIVE | repair 保持 DISABLED（REMAIN_DISABLED） | test_lifecycle_ctl |
| update staging+校验+原子切换+回滚 | 复用 dist（acquisition + store） | test_lifecycle_ctl（update 失败回滚保留旧版） |
| enable 重新授权+构件+Truth 检查 | auth/artifact/conformance 回调全过才 ACTIVE | test_lifecycle_ctl + e2e |
| uninstall 默认只解绑当前 Agent | UNINSTALLED 保留（幂等）+ purge；多 Binding 零影响 | test_lifecycle_ctl + e2e |
| 幂等 + 中断恢复 | 幂等标记 + journal recover_pending（INSTALLING→BROKEN） | test_lifecycle_ctl |
| 临时 home E2E | tests/test_lifecycle_e2e.py（6 动作全流程 + INV + 旁路 + 多 Binding） | test_lifecycle_e2e（5 项） |

## 4. Truth Integrity（Gate 2 后状态）

- Claim Gate：已接入召回/读取/pre-answer 路径（TruthAwareRecall + pre_answer_gate + BypassGuard）
- 状态区分：7 状态机器可读；无 receipt 不得 VERIFIED；环境故障显式 ENV_UNAVAILABLE
- 旁路：ENFORCED 候选模式下绕过 gate 的读取被阻断（e2e 锁定）
- **档位**：隔离环境候选可达 ENFORCED（conformance 证据链）；**真实环境保持 ADVISORY/AUDIT**；
  Gate 2 未正式切换 ENFORCED（Gate 3 裁决）

## 5. Lifecycle（六动作状态迁移证据）

- 迁移证据：test_lifecycle_ctl + test_lifecycle_e2e 逐动作断言
  （install→ACTIVE/ADVISORY；disable→DISABLED/OFFLINE/UNAVAILABLE；repair 保持；
  enable→ACTIVE（ADVISORY 或 ENFORCED-候选）；uninstall→UNINSTALLED；purge→ABSENT）
- 三轴不变量：每动作后 validate_invariants == []（INV-1..6 机器校验）
- DISABLED 后 read/sync 被 gate 拒绝（CLD-DISABLE-001）
- uninstall 只解绑当前 binding，其他 binding 零影响（e2e multi_binding）
- 幂等：install/disable/uninstall 重复调用返回幂等标记
- 中断恢复：遗留 journal → recover_pending → BROKEN

## 6. Test Evidence（全量）

- 命令：`python .gate0-workspace/run_tests.py`（逐文件隔离，timeout 900s/file，python 3.13.14）
- 汇总：**28 文件 / PASS=360 / FAIL=60 / SKIP=31 / ERROR=0** / nonzero_exit=7
- Gate 2 新增 4 文件：**47 项 / 0 失败**（truth_integration 15 + adapter_contract 10 +
  lifecycle_ctl 17 + lifecycle_e2e 5），全部隔离 fixture
- Gate 1 新增复跑：68 项 / 0 失败（无回归）
- 既有测试：245P/60F/31S（与 Gate 0 基线逐文件一致）
- 严格归因：60 FAIL = **ENV 56 / HEURISTIC 4 / UNKNOWN 0**（attribution-strict.json）；
  31 SKIP = ps1 护栏（与基线一致，无新增）

## 7. Safety Evidence

- 真实 memory（238 文件）与冻结区（8 文件）：逐文件 SHA-256 DIFF=0（提交后复验）
- Secret scan（guards.json patterns，全仓非 gate 工作区）：**0 命中**
- 本地/远端副作用：无 push；无真实 Binding 操作；Gate 2 全部测试在临时目录运行
  （state_root/artifact store 全为 tempfile 隔离）；provider 对真实仓库只读验证
  （snapshot 未创建 .truth-state、porcelain 零输出）

## 8. Deviations / P0 / P1

- Protocol Deviations：**空**
- 未决 P0：无
- 未决 P1：ENV-DEFECT-001/002（环境缺陷，ADR-R3-006 规避方案已冻结，Gate 3 执行）；
  版本矩阵差异（ADR-R3-005 判定正常）；六动作真实环境接线（Gate 3）

## 9. Git Evidence（提交后现场复核）

- Gate 2 提交：`ca87a1234c18b02ac0885579dbfd106ec341dc37`（13 文件，+1988）
- 起止 HEAD：`2397332` → `ca87a12`
- remote main：`9dcc31be2b7f32f3199cfbd44e138d161fc0cfdb`（ls-remote 现场）
- ahead/behind：**6/0**（9dcc31b..HEAD 线性 6 提交）
- worktree：porcelain 零输出（clean）
- 真实 memory / 冻结区：逐文件 hash DIFF=0
- 无 rewrite / 无 push / 无 tag / 无 release

## 10. Next Decision（Gate 3 建议，不自行启动）

1. ENFORCED 正式判定（AUDIT 模式全量证据：无 receipt 成功返回=0、fault injection 全绿、Doctor ALL PASS）
2. 真实环境试装授权（需单独裁决）
3. ENV-DEFECT 规避执行（ADR-R3-006：ls-remote 现场直取 + FETCH_HEAD + 独立状态文件）
4. Adapter 真实接线（workbuddy/codex 端 TruthAwareAdapter 接入）
5. 版本矩阵执行（如需协议升级：manifest 先行）
- 等待产品所有者裁决：授权 R3 Gate 3 / 试装授权 / push 授权（默认 NO）
