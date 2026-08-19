# Cross-Memory-System vNext-2.1 Gate 2R Phase 1 Report（MIV-006）

> 执行计划：《Cross-Memory-System_vNext-2.1_Memory-Intelligence_下一阶段执行计划.md》§MIV-006（第 551–569 行）
> 本阶段授权范围：仅 MIV-006（Project-only Scope 硬隔离）；不执行 MIV-005A/B
> 执行者：DSH @ TURING
> 执行基线：`725df3d9d49cf7e58e34549c9af49e71b783f94b`（Gate 1 封板后 HEAD == origin/main；`ffba74bf` 为其直接父提交，产品所有者裁决以 725df3d 为 Gate 2R 基线）
> 批准：ADR-MIV-006-001（含 D7 冻结语料对齐）经产品所有者批准后实施

## 1. Result

- **MIV-006 = PASS**
- 本 Gate 授权范围：project scope 硬隔离（global / project_only / session_only / temporary）
- 是否严格停止在授权边界：**是**——未执行 MIV-005A/B 及任何其他任务；未 push / 未 tag / 未 release / 未 rebase / 未 force push；真实记忆零修改

## 2. Version Truth

| 项 | 值 |
| --- | --- |
| exact local HEAD（执行开始） | `725df3d9d49cf7e58e34549c9af49e71b783f94b` |
| exact remote HEAD（ls-remote + GitHub API 双源） | `725df3d9d49cf7e58e34549c9af49e71b783f94b` |
| `ffba74bf`（授权文本基线） | HEAD 的直接父提交（`merge-base --is-ancestor` exit 0）；裁决见 ADR §0 |
| ahead/behind | 0 / 0 |
| worktree（执行开始） | clean |
| VERSION | `vNext-2.0` |
| TESTED_HEAD / FINAL_REPORT_HEAD / HEAD | 同一本地提交（见 §11；未 push） |

## 3. Baseline & Frozen Evidence

- `python memory.py doctor`（真实仓库，只读）：**ALL PASS（0 WARN）**；objects total=230（candidate=147 / active=83）；audit=230
- `python clued.py doctor --json`：`ok=true`（protocol 0.3.0）
- `python sync-memory.py doctor`：**ALL PASS**（remote==local==725df3d；working tree clean）
- 真实记忆哈希快照：执行前 238 文件（workspace `gate2r-miv006-memory-hash-before.json`）
- 最终校验：238/238 SHA-256 字节级一致，0 新增、0 变化（§5）
- 冻结区：永久冻结区与 Gate 1 冻结区文件零改动（§5 diff 清单）

## 4. Implemented Work Packages（MIV-006 → ADR-MIV-006-001 D1–D8）

| 决策 | 文件 → 符号 → 合同 → 测试 |
| --- | --- |
| D1 schema | `memory_engine/schema.py` → `validate_object`（project_id 类型校验）、`new_object(project_id=None)`（仅非空时输出键，字节兼容）→ 可选 `project_id`（null 或非空字符串；schema_version 保持 1）→ `test_project_id_validation` |
| D2 硬过滤 | `memory_engine/recall_engine.py` → `_scope_ok()`、`recall(project_id=, session_id=)` → project_only/session_only/temporary 查询 mode；硬过滤先于打分；缺 ID fail-closed `ValueError`；temporary 零长期读取（不读 index.json / objects）→ `test_project_a_cannot_read_project_b` / `test_session_only_visibility` / `test_temporary_mode_zero_reads` / `test_fail_closed_missing_ids` |
| D3 写路径 | `memory_engine/write_engine.py` → `EPHEMERAL_SCOPES` 门（fail-closed `EPHEMERAL_SCOPE_NOT_PERSISTED`，零副作用）、`candidate_lookup` 分区去重、SUPERSEDE 继承 project_id；`adapters/cli_adapter.py` supersede 继承 → `test_session_only_and_temporary_no_long_term_write` / `test_candidate_lookup_project_partitioned` / `test_supersede_inherits_project_id` / `test_project_switch_does_not_copy_objects` |
| D4 Trace | `memory_engine/recall_trace.py` → `PROJECT_MISMATCH/SESSION_MISMATCH/PROJECT_OK/SESSION_OK/TEMPORARY_MODE` reason codes；`TraceRecorder(project_id=, session_id=)`（session_id 仅非空输出，legacy JSON 字节不变）；excluded 仅 memory_id + reason_codes → `test_trace_out_of_scope_only_safe_metadata` / `test_explain_equivalence_new_modes` |
| D5 约束防泄漏 | `recall_engine._attach_constraints` 对 project_only/session_only 施加同源硬过滤（legacy 不变）→ `test_adapter_cannot_bypass_hard_filter` |
| D6 合同透传 | `memory.py`（recall `--project-id/--session-id`；add `--project-id`）、`adapters/cli_adapter.py`（**kwargs 透传）、`memory_eval/schema.py::scope_to_engine` → `("project_only", project_id)` 元组、`memory_eval/runner.py` 原样传入（不 mock scope 决策）→ `test_scope_mapping_contract` / `test_adapter_cannot_bypass_hard_filter` |
| D7 语料对齐 | `tests/fixtures/memory_eval/fixtures.json` 9 个 project 夹具补 `project_id`（0c0001/2/3/9/10/12/13/16 → p-alpha；0c0006 → p-beta）；golden 零改动；corpus hash 不变 `1bc23744…` → `test_scope_metric_split_contract`（gap 1→0） |
| D8 断言演进 | `tests/test_memory_eval.py` 两处断言（gap==0；scope 映射元组）随 ADR 演进 |

## 5. Changed Files

### Added
```
ADR-MIV-006-001-Project-Scope-Isolation.md
tests/test_project_scope.py（14 项）
Cross-Memory-System-vNext-2.1-Gate2R-MIV006-Report.md（本文件）
```

### Modified
```
memory_engine/schema.py            # D1：project_id 可选字段（加法兼容）
memory_engine/recall_engine.py     # D2/D5：新查询 mode + 硬过滤 + 约束防泄漏
memory_engine/recall_trace.py      # D4：reason codes + trace.scope 合同
memory_engine/write_engine.py      # D3：临时/会话写入门 + 分区去重 + 继承
memory.py                          # D6：CLI 参数透传
adapters/cli_adapter.py            # D3/D6：supersede 继承 project_id
memory_eval/schema.py              # D6：scope_to_engine 元组合同
memory_eval/runner.py              # D6：project_id 原样传入引擎
tests/fixtures/memory_eval/fixtures.json  # D7：9 夹具补 project_id（golden 零改动）
tests/test_memory_eval.py          # D8：两处断言演进（gap 0、映射元组）
```

### Deleted
```
（无）
```

- `memory/` 全部 238 个文件：**零改动**（git diff -- memory/ 为空 + 前后哈希一致）
- 冻结区（sync-memory.py/ps1、guards.json、protocol-manifest.json、migrate-memory.py、clued.py、clued/**）：**零改动**

## 6. Test Evidence

环境：真实克隆（HEAD=725df3d）+ Python 3.12.10 + Git 2.55.0.windows.3；全部套件
`PYTHONUTF8=1` 运行（见 §10 环境适配说明）。隔离评测在临时目录进行（eval runner 自带真实记忆零触碰护栏）。

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `python tests/test_acceptance.py` | 70/70 PASS，0 skip |
| 2 | `python tests/test_memory_v2.py` | 55/55 |
| 3 | `python tests/test_clued_unit.py` | 27/27 |
| 4 | `python tests/test_clued_auth.py` | 18/18 |
| 5 | `python tests/test_clued_install.py` | 10/10 |
| 6 | `python tests/test_clued_pending.py` | 15/15 |
| 7 | `python tests/test_clued_recovery_crash.py` | 13/13 |
| 8 | `python tests/test_clued_uninstall.py` | 11/11 |
| 9 | `python tests/test_clued_e2e.py` | 8/8 |
| 10 | `python tests/test_clued_policy.py` | 22/22 |
| 11 | `python tests/test_recall_trace.py` | 19/19 |
| 12 | `python tests/test_memory_eval.py` | 13/13 |
| 13 | `python tests/test_project_scope.py`（新增） | 14/14 |
| 合计既有 | 281 项（249 + 19 + 13）全部 PASS，0 失败 0 跳过 | |
| 合计新增 | 14 项全部 PASS | |
| — | `python memory.py doctor` | ALL PASS（0 WARN），exit 0 |
| — | `python clued.py doctor --json` | ok=true，exit 0 |
| — | `python sync-memory.py doctor` | ALL PASS |

> 口径说明：Gate 1 报告记录「249+19+12=280」；基线 HEAD 725df3d 实测
> `test_memory_eval.py` 为 13 项（Gate 1 报告定稿时口径为 12），本报告按
> 实测 281 项记录，全部通过。

证据文件：`%USERPROFILE%\Documents\20260817\gate2r-test-run1.log`、
`gate2r-test-run2.log`（含每套退出码）。

## 7. Quality Metrics（固定语料 111 例，--out 独立目录，未覆盖冻结基线）

- corpus hash：`1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`（与 Gate 1 基准一致，证明 golden 零改动）
- fixtures.json SHA-256：`BB51EF71…` → `AD84011C4B341C5D5BD4C1FB3C16C7EB4F27FEE3DBC353650CC809E9CC15407A`（仅 D7 九个 `project_id` 字段）

| 指标 | Gate 1 基准 | MIV-006 后 | 判定 |
| --- | ---: | ---: | --- |
| current_scope_leakage_count | 0 | **0** | ✅ 达标 |
| project_only_capability_gap_count | 1 | **0** | ✅ 归零（ps-010 转 PASS） |
| superseded_leakage_count | 0 | 0 | ✅ |
| secret leakage | 0 | 0 | ✅ |
| Precision@5 | 0.19 | 0.1857 | 不变（MIV-005A/B 范围外，如实记录） |
| false recall rate | 0.37 | 0.35 | 不变（同上） |
| paraphrase 未命中 | 11/12 | 11/12 | 不变（同上） |
| cross-agent consistency | 1.0 | 1.0 | ✅ |
| replay hash | b7a9b250… | `fa3c0533ce18…` | 因 trace.scope 携带真实 project_id + PROJECT_OK 码而演进（预期，见 §9） |

## 8. Security & Fault Injection

| 场景 | 预期 | 实际 | 证据 |
| --- | --- | --- | --- |
| A 项目不可读 B 项目（同桶高分候选） | 硬过滤 | ✅ | test_project_a_cannot_read_project_b（PROJECT_MISMATCH） |
| B 项目内容不可影响 global recall | 排除 | ✅ | test_project_content_does_not_affect_global_recall |
| 管理员/Adapter 绕过 | 不可能 | ✅ | test_adapter_cannot_bypass_hard_filter（CLIAdapter 调用仍过滤；跨项目约束不附着） |
| temporary/session-only 长期写入 | 拒绝且零副作用 | ✅ | test_session_only_and_temporary_no_long_term_write（对象/审计/索引零变化） |
| 越界候选 Trace 泄漏内容/秘密 | 零泄漏 | ✅ | test_trace_out_of_scope_only_safe_metadata（excluded 仅 memory_id+reason_codes） |
| temporary 查询触发长期读取 | 零读取 | ✅ | test_temporary_mode_zero_reads（炸弹探针） |
| 缺 project_id/session_id 静默降级 | fail-closed | ✅ | test_fail_closed_missing_ids |
| project 切换静默复制对象 | 不复制 | ✅ | test_project_switch_does_not_copy_objects |

## 9. Compatibility

- legacy mode（global/project/session）：`test_legacy_scope_modes_unchanged` 固化逐字节不变（含"已分区对象在 legacy project 模式仍可见"）
- explain=False/True：新 mode 下 selected IDs/顺序/trace scope 合同一致（`test_explain_equivalence_new_modes`）；legacy 调用 trace JSON 字节不变（project_id/session_id 默认 None、session_id 仅非空输出）
- 旧 Adapter：`cli_adapter.read/recall(**kwargs)` 透传，未请求新参数时行为不变
- 回滚：`git revert` 单一提交即可；无数据迁移；引擎回滚后 ps-010 回到"能力缺口"状态与 Gate 1 基线一致
- 离线：全部测试与评测零网络依赖（临时夹具 + 本地仓库）

## 10. Deviations & Limitations

1. **环境适配（非代码偏差）**：本机 Python 3.12 + GBK 控制台导致
   `sync-memory.py` 的 `✓` 打印在子进程管道下抛 `UnicodeEncodeError`，
   连带 clued 测试以 CLD-SYNC-002 快速失败；以 `PYTHONUTF8=1` 运行后
   全部通过（与 Gate 1 报告的 PowerShell 5.1/UTF-8 环境适配同性质，
   测试断言零改动）。
2. **D9 单提交口径**：计划要求语料变更"单独提交"，Gate 2R 授权边界要求
   "只做本地单一目的提交"；取更保守的授权边界——MIV-006 全部变更收敛于
   一个本地提交，语料对齐在提交正文单独说明并给出前后哈希。
3. **eval 套件计数口径**：基线 HEAD 实测 test_memory_eval.py 为 13 项
   （Gate 1 报告定稿写 12），按实测 281 记录。
4. **`memory/状态.md` 未登记**：遵守授权边界「真实记忆零修改」，Gate 2R
   登记留待 push 授权后单独执行。
5. 已知限制（非本阶段范围）：Precision@5 0.1857 / false recall 0.35 /
   paraphrase 11/12 未命中 → MIV-005A/B；session 运行期 store 未实现
   （session_only 写入 fail-closed 拒绝，见 ADR D3）。

## 11. Git Evidence

- 本地提交：1 个（`feat: hard project/session scope isolation (MIV-006)`，
  作者 DSH@TURING）
- no amend / no rebase / no force push / no PR / no tag / no release ✅
- **no push**：远端执行前后 HEAD 均为 `725df3d9d49cf7e58e34549c9af49e71b783f94b`
  （执行前后 `git ls-remote origin main` 不变）
- worktree clean（提交后核验）
- secret scan：新增文件零自命中（guards.json 模式；`test_repo_files_do_not_self_match_secret_patterns` 通过）

## 12. Next Decision Required（产品所有者裁决）

1. 是否接受 MIV-006 验收证据；
2. 是否授权 push（默认否）；
3. push 授权后是否补 `memory/状态.md` Gate 2R 登记（本阶段按「真实记忆零修改」未执行）；
4. 是否授权 Gate 2R 下一阶段（MIV-005A 相关性阈值与 NO MEMORY，仍不包含 MIV-005B）。
