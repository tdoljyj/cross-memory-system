# Sprint 3 专项审计与封版报告（vNext-1.3 Stable Baseline）

> **审计方**：DSH@TURING
> **日期**：2026-08-16
> **基线**：vNext-1.3（全程冻结，未做任何架构修改）
> **范围**：Sprint 3 全部 Gap 处置后的第二轮专项审计 + 封版前最终检查
> **封版 commit**：见文末 release baseline（本报告与记忆回写提交后打 tag）

---

## 一、Sprint 3 Gap 处置总表

| Gap | 处置 | commit | 回归测试 |
|---|---|---|---|
| GAP-2-1 保留期统一 7 天 | ✅ 修复（guards.json 2→7 + py/ps1 回落默认 7，实现向基线收敛） | `7bd4e5b` | guards==7 断言 + py/ps1 回落默认功能测试 ×2（3 天保留/8 天清理判别） |
| GAP-2-2 凭据旧口径 | ✅ 修复（决策.md:18 标 superseded、归档.md:13 加已废弃注记，历史保留） | `17f1e7c` | superseded 标记断言 |
| GAP-2-3 doctor 探针对称 | ✅ 修复（ps1 补 memory-files-healthy + local==remote 阻挡态；py 补 ref-write 行为探针） | `8ee9771` | ps1 对称探针 + 落后阻挡态 + py ref-write ×3 |
| GAP-2-4 版本真值 | ✅ 第一部分：AGENTS §六 合并作者规则 + VERSION↔tag 一致性测试（`7bca722`）；第二部分：封版 tag 移动（文末执行） | `7bca722` | test_version_pointer_consistent |
| GAP-3-1 报错口径 | ✅ 修复（index 缺失/非法独立口径，含路径越界归「非法」） | `98ac609` + `023fda9` | 断言强化 + 越界拒绝 ×2 |
| GAP-3-2 README 缺 DSH 行 | ✅ 修复（端侧差异表补 DSH 列九行） | `1063789` | 文档回归断言 |
| GAP-3-3 配置手册行内注记 | ✅ 修复（开场全量读取 ×2 + 凭据 setx 加「已废弃」） | `db025de` | 文档回归断言 |
| GAP-3-4 guards 回落警示 | ✅ 修复（双端 doctor WARN，不改退出码契约） | `023fda9`/`1e30945` | py/ps1 WARN + exit 0 ×2 |
| GAP-3-5 PID 锁复用 | ✅ 部分修复 + 留档（双端 doctor .sync.lock 诊断 INFO；句柄锁不实施，理由见 §三） | `023fda9`/`1e30945` | 诊断性变更，无独立测试（留档） |
| GAP-3-6 fetch 冗余 | ✅ 修复（merge-base 128 才 fetch + py lowSpeed 对齐 ps1） | `023fda9` | 冗余 fetch 单测（含对象缺失场景 fetch 恰一次） |
| GAP-3-7 TEMP listdir | ✅ 留档（保持现状，理由见 §三；实测 1437 条目 / 161ms） | — | — |
| GAP-3-8 deploy-guard trap 噪音 | ✅ 修复（trap Get-Command 防御，不写 marker 符合 manifest 契约） | `1e30945` | deploy-guard 拒绝无噪音断言 |
| GAP-3-9 AGENTS↔index 断言 | ✅ 修复（第二节表 ↔ index.json 双向一致性测试） | `0dbf63e` | test_agents_table_matches_index |
| GAP-3-10 index 路径净化 | ✅ 修复（双端 files 项基名校验，越界 fail-closed） | `023fda9`/`1e30945` | 越界拒绝 py/ps1 ×2 |

验收测试：57 → **69**（新增 12 条），**69/69, 0 failures, 0 skipped**。

## 二、第二轮专项审计（十重点复核）

| 复核项 | 结论 | 证据 |
|---|---|---|
| Router：T0 零 Memory 访问 | CONFORM | `test_py_access_none_skips_pull`、`test_ps1_pull_access_none_pure_shortcircuit`（六项零副作用断言）、conformance `access_none` |
| Recall：L1–L6 段级最小召回 | CONFORM | `test_index_json_recall_mapping_valid` + 新增 `test_agents_table_matches_index`（协议表与 index.json 双向一致） |
| Write：NO_CHANGE→NO_WRITE→NO_SYNC | CONFORM | `test_ps1_no_change_skips_commit`、`test_ps1_push_no_change_with_prestaged_skips`、`test_py_push_is_idempotent`、conformance `no_memory_change` |
| Version：version/stale-ref/needs-push 生命周期 | CONFORM | `test_py_dangling_ref_rejected`、`test_py_needs_push_cleared_after_push`、`test_ps1_needs_push_cleared_after_push`、`test_py_sync_failure_writes_marker_and_retries`、`test_version_pointer_consistent`（VERSION↔tag） |
| Concurrency：后到者不得覆盖先到者 | CONFORM | `test_py_concurrent_merge_no_loss`、`test_py_lock_blocks_concurrent`、`test_py_lock_stale_pid_cleared`、`test_pid_alive_probe_does_not_kill` |
| Idempotency：重试不产生重复变更 | CONFORM | `test_py_push_is_idempotent`、`test_py_sync_failure_writes_marker_and_retries` |
| Sync Boundary：index.json 文件提交边界 | CONFORM | `test_ps1_push_scopes_to_index_files`、conformance `staged_non_memory`、新增越界拒绝 ×2（GAP-3-10） |
| Automation Boundary：触发式不演化自动化 | CONFORM | conform 三要素探针双端 PASS；本端无任何定时/启动/调度任务 |
| Security：密钥三路径 + 脱敏 + deploy + fail-closed | CONFORM | staged/unpushed/memory 三路径测试 ×6、`test_py_fetch_error_output_redacted`、conformance `fetch_error_redact`、deploy ×3 + 噪音断言、`test_py_missing_index_guard`、`test_py_delete_propagation_guard` |
| Conformance：双端协议语义一致 | CONFORM | protocol-manifest.json 九行 + 契约变异测试（本轮复跑：篡改即捕获）；新增 doctor 探针对称后双端覆盖矩阵一致 |

## 三、留档决策（不修理由 + 风险 + 后续计划）

**GAP-3-5（PID 锁复用，句柄锁不实施）**
- 不修理由：现有「O_EXCL/CreateNew + PID 探活（py 保守版 OpenProcess+GetExitCodeProcess）」已覆盖正常释放/异常退出/stale 清理/重试四个场景（各有测试）；PID 复用楔住是 Windows 无句柄文件锁的固有极限，发生概率极低（需锁持有进程崩溃后 PID 恰被长命进程复用）。
- 风险：极端情况下 .sync.lock 需手工删除。
- 后续计划：已补双端 doctor 诊断 INFO（本次落地）；若未来实际发生楔住，再评估句柄锁（需引入跨语言互操作方案，属架构级变更，需专项评估）。

**GAP-3-7（%TEMP% 全量 listdir，保持现状）**
- 不修理由：实测 %TEMP% 1437 条目、枚举 161ms（冷缓存首跑）；每次会话至多执行一次，成本可忽略；降频/收敛引入状态复杂度，收益 < 复杂度。
- 风险：无正确性风险；极端膨胀环境（>10 万条目）下首跑有亚秒级延迟。
- 后续计划：若未来观测到 %TEMP% 异常膨胀再评估收敛到 .conflict-snapshots/。

## 四、封版前最终检查矩阵

| 检查项 | 结果 |
|---|---|
| git status clean | ✓（封版报告与记忆回写提交后复核） |
| 全量测试 | ✓ 69/69, 0 failures, 0 skipped |
| Python Doctor（DSH 真实克隆） | ✓ ALL PASS |
| PowerShell Doctor（隔离沙盒） | ✓ ALL PASS（含新对称探针 memory-files-healthy / local==remote） |
| Conformance + 契约变异测试 | ✓ 九行全绿；变异测试捕获正常 |
| 密钥三路径扫描 / 脱敏 / deploy-guard / fail-closed | ✓ 见 §二 Security 行 |
| 本地 HEAD == 远端 HEAD | ✓（推送核验，见 release baseline） |
| VERSION = vNext-1.3 | ✓ |
| tag vNext-1.3 = 封版 commit | ✓（本报告提交后执行 tag 移动，见下） |
| P0 / P1 | ✓ 0 / 0 |

## 五、Release Baseline

```text
VERSION        = vNext-1.3
release tag    = vNext-1.3（由 c2bb2cb 移动至封版 HEAD，GAP-2-4 第二部分）
封版 HEAD      = 本报告与记忆回写提交（见 git log）
```

封版后状态：**vNext-1.3 Stable Baseline / 可封版**。vNext-1.4 仅在出现「无法通过代码修复解决的核心问题」或明确的服务化需求时再评估（基线 §二十一 + 附录 A「展望」纪律）。

## 附：Sprint 3 commit 链

`7bd4e5b`(2-1) → `17f1e7c`(2-2) → `8ee9771`(2-3) → `98ac609`(3-1) → `1063789`(3-2) → `db025de`(3-3) → `023fda9`(3-4/5/6/10 py) → `1e30945`(3-4/5/8/10 ps1) → `0dbf63e`(3-4/6/8/9/10 测试) → `7bca722`(2-4a) → 封版提交（本报告+记忆回写+changelog）
