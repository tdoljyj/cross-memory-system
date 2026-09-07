# 代码级 Gap Audit 报告（vNext-1.3 基线冻结）

> **审计方**：DSH@TURING（第三接入端）
> **日期**：2026-08-16
> **基线**：vNext-1.3（架构基线冻结，本审计不改架构；架构回退触发条件见第四节，未出现）
> **版本真值核对**（AGENTS v3.1 硬性 check-list 先行）：`git ls-remote origin main` = 本地 `rev-parse HEAD` = `51f13510f88aa70ff5e8f51c01f9a0e0e5f024f0`，工作树 clean
> **方法**：十模块逐项核对「基线写的 vs 代码做的」；每条结论附实现位置（文件:行）或自动化测试名；验收基线：`tests/test_acceptance.py` 57/57 全绿、py doctor（DSH 真实克隆）ALL PASS、ps1 -Doctor（隔离沙盒）ALL PASS、conformance 契约变异测试已执行
> **审计结论先行**：**P0 = 0，P1 = 0**；P2×4、P3×10（全部为治理/文档/检测面/优化项，不违反核心不变量）；十模块核心不变量 **CONFORM**。按 Step 5 门禁条件，**满足进入 Sprint 3**。

---

## 一、逐模块核对表（基线 ↔ 代码）

### 1. Memory Router

| 检查项 | 结论 | 证据 |
|---|---|---|
| T0–T4 分类真实执行（协议层） | CONFORM | 仓库 AGENTS.md v3.1 §一（T0–T4 分类 + 默认 NONE）；DSH 端 `~/.dsh/AGENTS.md` 每会话注入（本会话 system-reminder 为证）；conform 探针三要素双端 PASS |
| NONE 零 Memory 访问（机制层） | CONFORM | py `cmd_pull` NONE 纯短路（sync-memory.py:611-614，任何副作用之前）；ps1 进程级短路（sync-memory.ps1:64-68，Sprint1-1）；`test_py_access_none_skips_pull` + `test_ps1_pull_access_none_pure_shortcircuit`（含 git 身份/TEMP/锁/marker 六项零副作用断言）；conformance `access_none` 行 |
| Router 在 Memory 读取之前执行 | CONFORM | AGENTS §一「判断发生在读取记忆之前」；协议文本双端一致（doctor 协议新鲜度 + conform 探针） |
| 隐式全量加载 | CONFORM | 触发式禁令（AGENTS §三 机制性质注：禁定时/启动/调度自动化）；标准三件套=画像+状态+决策（非五文件全量）；配置手册旧「开场全量」表述已有文件级过期警示（GAP-3-3 为行内注记缺失，非行为问题） |

### 2. Recall / Recall Planner

| 检查项 | 结论 | 证据 |
|---|---|---|
| L1–L6 映射与 index.json 一致 | CONFORM | `memory/index.json` recall 字段与 AGENTS §二 表逐项核对一致；`test_index_json_recall_mapping_valid`（段名逐字存在性 + AGENTS 引用 index.json 断言） |
| 最小必要召回（无「命中即读整个文件」） | CONFORM | index.json 段级映射 + 双端协议「按需只读对应标题段」；标准三件套为协议明确定义的最小集 |
| index.json 唯一事实源 | CONFORM | 双脚本同步护栏读 index.json files 清单（py memory_files / ps1 Get-MemoryFileList）；doctor 双端 index 召回段名运行时校验；`test_doc_guard_wording_consistent` 防硬编码口径复活 |

### 3. Memory Change Detector

| 检查项 | 结论 | 证据 |
|---|---|---|
| 无变化 NO-OP（不 commit/push/Sync Event/Invalidation） | CONFORM | ps1 staged 名单收窄 index 文件集 + commit 限 pathspec（P0-1）；py 无 commit 职责 + push up-to-date 不产生新提交；`test_ps1_no_change_skips_commit`、`test_ps1_push_no_change_with_prestaged_skips`、`test_py_push_is_idempotent`；conformance `no_memory_change` 行（双端 no-op + 远端不变） |
| 「看起来没变化但产生提交」路径 | CONFORM（已关闭） | P0-1 实证三场景修复 + 附录 B 重放失效 + conformance `staged_non_memory` 行 |

### 4. Version / Persistence

| 检查项 | 结论 | 证据 |
|---|---|---|
| git commit = version 语义；push 后远端真值核验 | CONFORM | 双端 push 后 ls-remote/祖先判定核验（py confirm_no_divergence / ps1 Confirm-RemotePushed）；`test_conformance_remote_verification` |
| stale / dangling ref | CONFORM | py check_ref_valid（40-hex + cat-file 对象存在 + 与 ls-remote 哈希比对）；restore_tracking_ref 写前 object_exists 验对象（防悬空）；`test_py_dangling_ref_rejected`；doctor tracking ref 自愈（AUTO-HEALED） |
| 本地领先/落后处理 | CONFORM | 领先：pull=读不内嵌 push，写 .needs-push（py:650-657 / ps1:737-743）；落后：doctor 阻挡态（py:922-935）；push 前 fetch+merge 对齐（双端） |
| 旧状态覆盖新状态 | CONFORM | push 前脏检查 + fetch+merge + 冲突 abort + base/ours/theirs 快照；`test_py_concurrent_merge_no_loss`（A/B 变更均不丢）；ps1 pending-writeback 阻断 stale 工作区回写 |
| 标记生命周期闭环 | CONFORM | .sync-failed 成功清除 / .needs-push push 成功清除（py:727 / ps1:948-949）；`test_py_needs_push_cleared_after_push`、`test_ps1_needs_push_cleared_after_push`、`test_py_sync_failure_writes_marker_and_retries` |

### 5. Concurrency / Conflict

| 检查项 | 结论 | 证据 |
|---|---|---|
| non-fast-forward 识别 + fetch+merge 安全 | CONFORM | push 被拒→fetch+merge→重推一轮（双端）；核验统一 merge-base --is-ancestor（非 ==） |
| 后到者不得覆盖先到者 | CONFORM | 附录 B 用例 F 许可偏差（merge 收敛保留两端语义）为基线明示；实测 `test_py_concurrent_merge_no_loss` |
| 冲突快照可靠 / merge 失败可恢复 | CONFORM | .conflict-snapshots/ 三阶段快照 + merge --abort + .sync-failed 可重试；`test_ps1_pull_pending_writeback_keeps_extras_and_backup`（备份保留 + 非 index 文件不删） |
| 并发互斥 | CONFORM | .sync.lock 跨进程锁（py O_EXCL + OpenProcess/GetExitCodeProcess 保守探活；ps1 CreateNew + Get-Process）；`test_py_lock_blocks_concurrent`、`test_py_lock_stale_pid_cleared`、`test_pid_alive_probe_does_not_kill`（探活不杀进程） |

### 6. Idempotency

| 检查项 | 结论 | 证据 |
|---|---|---|
| 相同内容重复执行 NO-OP | CONFORM | `test_py_push_is_idempotent`（重复 push 远端不变）；ps1 staged 空检查 |
| retry 不产生重复 commit | CONFORM | `test_py_sync_failure_writes_marker_and_retries`（失败→修复→重试，无重复提交）；G 用例「同一操作只产生一次变更」 |
| staged 状态不导致重复提交 | CONFORM | ps1 push staged 名单限 index 文件集（P0-1）；conformance `staged_non_memory` 行（预 staged 状态保留、不卷入） |

### 7. Sync Layer

| 检查项 | 结论 | 证据 |
|---|---|---|
| 双端只与 Canonical Store 协同（无跨端直连） | CONFORM | deploy-guard：py 拒 .codex（sync-memory.py:976-984）、ps1 拒 .workbuddy/.dsh（sync-memory.ps1:34-40）；`test_py_deploy_guard_blocks_codex_path`、`test_ps1_deploy_guard_blocks_workbuddy_path`、`test_ps1_deploy_guard_blocks_dsh_path`；conformance `foreign_mirror` 行；DSH 真实克隆跑 ps1 实测被拒 |
| index.json files 清单 = 复制/删除/提交边界 | CONFORM | ps1 只复制/提交 index 文件（P0-1 + 全面评估修复⑤）；`test_ps1_push_scopes_to_index_files`（非 index 不复制/不删除/不提交） |
| 非 memory 文件意外提交 | CONFORM（已关闭） | P0-1 pathspec 提交 + conformance `staged_non_memory` 行 |
| 删除传播 fail-closed | CONFORM | index 缺失/空清单/文件空 → 拒绝同步（py memory_dir_healthy / ps1 Test-MemoryFilesHealthy，双端 pull/push 前后双检）；`test_py_delete_propagation_guard`、`test_py_missing_index_guard` |

### 8. Cache / Version Truth

| 检查项 | 结论 | 证据 |
|---|---|---|
| 本地 = Cache/镜像，读前对齐 | CONFORM | AGENTS §三缓存语义「本地镜像只是 Cache，仓库是唯一事实源」；读前 pull 即版本校验 |
| cache version vs remote version 比较 | CONFORM | ls-remote + 祖先判定；`test_py_pull_aligns_to_remote`（pull 后本地==远端，旧缓存不生效） |
| stale cache 不直接消费 | CONFORM | 版本真值核对硬性 check-list（评估/审计类任务 ls-remote 先行，本次审计即按此执行）；doctor 落后阻挡态 |
| 不引入定时/启动/调度自动化 | CONFORM | 触发式禁令三要素双端 conform（doctor 探针 PASS）；本端未创建任何周期任务 |

### 9. Security / Guard

| 检查项 | 结论 | 证据 |
|---|---|---|
| token 全路径脱敏 | CONFORM | py redact / ps1 Redact-Text（guards.json 全模式含 AKIA/私钥头/Bearer）；fetch 错误路径 P0-4 修复；`test_redact_covers_all_guards_patterns`、`test_py_fetch_error_output_redacted`、conformance `fetch_error_redact` 行（双端输出与 .sync-failed 均无令牌） |
| staged blob 扫描 | CONFORM | py find_secret_leak_staged / ps1 Find-SecretLeakStaged 均读 `git show :<path>`（Sprint1-2/Sprint2）；`test_py_push_refuses_staged_secret_index_blob`、`test_ps1_push_refuses_staged_secret_non_memory`；conformance `staged_secret` 行 |
| 未推送 commit 扫描 | CONFORM | py find_secret_leak_unpushed / ps1 Find-SecretLeakUnpushed（Sprint1-3/Sprint2-A）；conformance `committed_non_memory_secret` 行（双端 block + 远端不变） |
| deploy-guard 覆盖所有端 | CONFORM | 见 §7；三端覆盖矩阵：py×.codex 拒、ps1×.workbuddy/.dsh 拒、py×.dsh 本端合法 |
| PortableGit / 错误路径阻断 | CONFORM | git_is_safe / Test-GitClientSafe（push/pull 硬阻断）+ doctor 检查 |
| missing index / 空 files 清单 fail-closed | CONFORM | 见 §7 删除传播 |

### 10. Protocol Conformance

| 检查项 | 结论 | 证据 |
|---|---|---|
| manifest 与双脚本行为一致 | CONFORM | protocol-manifest.json 九行契约 + conformance 测试逐行测量（57/57 含 9 行） |
| conformance 覆盖 manifest | CONFORM | `test_protocol_manifest_wellformed`（每行必有 test_conformance_<id>）；契约变异测试（篡改期望 → 捕获）已执行 |
| Python / PowerShell 核心语义分歧 | CONFORM（分歧已关闭） | Sprint2-A 关闭 ps1 未推送令牌扫描缺口；九行矩阵双端同结论 |

---

## 二、Gap 清单（P2 / P3，Sprint 3 处置）

> P0/P1 均为 0——按「优先修代码，不轻易改基线」原则，本轮无需修复，以下全部登记待 Sprint 3。

### P2（4 项，Sprint 3 优先处理）

| # | 问题 | 位置 | 影响 | 处置建议 |
|---|---|---|---|---|
| GAP-2-1 | **保留期口径漂移**：guards.json `backup_retention_days: 2`（唯一事实源，双脚本实际读取）vs 基线 :16/:662 与 待办.md:26 写「>7 天」 | guards.json:11；架构基线文档-vNext-1.3.md:16/662 | 文档承诺 7 天恢复窗口，实际 2 天即删 | **决策点**：按原始意图统一为 7（改 guards.json + 口径测试），或文档统一为 2。需用户定夺 |
| GAP-2-2 | **决策.md:18 凭据旧口径未 superseded**（「令牌存 GITHUB_PAT_TOKEN…setx 同步」vs 同文件 :25「不 setx」直接冲突）；配置手册:403、归档:13 为历史快照残留 | memory/决策.md:18/25 | 协议层自相矛盾，新会话可能复活 setx 长期令牌行为 | 决策.md:18 标 superseded 指向 :25；历史快照两处加「已废弃」行内注记 |
| GAP-2-3 | **doctor 探针集不对称**：ps1 -Doctor 缺「memory files healthy（按 index.json）」与「local==remote 落后/分叉阻挡态」两项探针；py doctor 缺 ps1 的「ref write persists」行为探针。README:83-84 将其写成通用排查项，与实际探针集不符 | sync-memory.ps1 Invoke-DoctorMode / sync-memory.py cmd_doctor | 检测面不一致：ps1 端删除传播护栏状态与本地落后状态不被 doctor 暴露 | 双端补齐三项探针（对齐行为，不改语义）+ 各 1 条 doctor 回归 |
| GAP-2-4 | **tag 指针落后 HEAD 30 提交**（P0×6 + Sprint1×3 + Sprint2×3 等实质变更均未被 tag 覆盖）；合并作者规则未定义；1.0/1.1/1.2 无 tag | git tag vNext-1.3 → c2bb2cb | 带外真值源失去对当前实现的锚定 | Sprint 3 收尾：全量测试 + doctor + 专项审计后重建 release baseline（VERSION = tag = 封版 HEAD）；合并作者规则写入 AGENTS §六 |

### P3（10 项，Sprint 3 按序处理）

| # | 问题 | 位置 | 处置建议 |
|---|---|---|---|
| GAP-3-1 | py index.json 损坏时报「缺少必需文件」（未区分索引缺失/非法/文件缺失三口径；ps1 已区分前两种） | sync-memory.py:621-623 | 报错口径区分 |
| GAP-3-2 | README 端侧差异表缺 DSH 行（仅接入方表登记） | README.md:61-73 | 补 DSH 列 |
| GAP-3-3 | 配置手册残留「开场完整读取四文件」行（有文件级警示，缺行内注记） | 配置手册-v4:62/101 | 加「已废弃」行内注记 |
| GAP-3-4 | guards.json 缺失时双脚本回落内置默认（单一事实源存在隐性第二份） | py:328-334 / ps1:282-294 | doctor 增加 guards.json 缺失警示（不改变回落语义） |
| GAP-3-5 | PID 锁复用固有缺陷（py 保守探活 vs ps1 Get-Process 语义差异） | py:341-373 / ps1:235-262 | 锁内容加时间戳/进程名核对，或句柄锁 |
| GAP-3-6 | py pull 路径 fetch 两次（fetch_and_merge + confirm_no_divergence）；py 固定 60s 超时无 lowSpeed（ps1 有 lowSpeed 无总超时） | sync-memory.py:473/588/170-178 | 复用 FETCH_HEAD + lowSpeed 对齐 |
| GAP-3-7 | %TEMP% 全量 listdir（每次 pull/push/doctor） | py:514-535 / ps1:380-398 | 清理收敛 .conflict-snapshots/ 或降频 |
| GAP-3-8 | ps1 deploy-guard 拒绝路径的 trap 噪音（Set-SyncFailed 未定义错误；exit 码与护栏输出正确，无功能影响） | sync-memory.ps1:34-40 + trap | 护栏输出提前于 trap 定义或容忍该噪音 |
| GAP-3-9 | AGENTS §二 表与 index.json 无自动化一致性断言（当前内容一致） | AGENTS.md:31-38 | 加「AGENTS 表 ↔ index.json」一致性测试（防手改漂移） |
| GAP-3-10 | index.json files 项无路径净化（`../x.md` 可逃逸 memory 目录） | py:238-271 / ps1:168-180 | join 前 basename 校验 |

---

## 三、架构回退检查（Step 3）

| 允许修改基线的触发条件 | 是否出现 |
|---|---|
| 架构存在无法通过代码修复解决的逻辑矛盾 | 否 |
| 架构存在 P0 数据安全问题 | 否（P0=0） |
| 架构无法满足已定义核心不变量 | 否（十模块核心不变量 CONFORM） |
| 两个核心规范之间存在无法调和的冲突 | 否（基线第十二节表述矛盾属文档漂移，已 P0-6 修复） |
| Git+文件映射无法可靠实现某项核心能力 | 否（附录 A 映射逐项验证成立） |

**结论：无需修改 vNext-1.3。** 所有发现均为「代码/文档没跟上基线」而非「基线本身有缺陷」；统一进入 Sprint 3 按「优先修代码」原则落地。Vector DB / Embedding / Recall Score / 服务化等一律不进范围（与基线附录 A「展望」一致）。

---

## 四、门禁结论（Step 5）

```text
P0 = 0 ✓
P1 = 0 ✓
→ 正式满足进入 Sprint 3 的条件
```

Sprint 3 职责（按计划）：实现/验证/回归为主——P2×4（GAP-2-1 保留期决策点需用户定夺 2 天 vs 7 天；GAP-2-2 superseded；GAP-2-3 doctor 探针集补齐；GAP-2-4 封版 release baseline）+ P3×10 按优先级落地，逐项独立 commit + 回归，全部完成后对照「Sprint 3 完成条件」九节清单核验，最后全量测试 + 双端 doctor + 专项审计 + VERSION/tag/HEAD 真值统一 → 封版。

## 附：验证基线

- 版本真值：本地 = 远端 = `51f13510f88a` ✓
- `tests/test_acceptance.py`：**57/57, 0 failures, 0 skipped**（含 conformance 9 行 + 契约变异测试）
- py doctor（DSH 真实克隆）：ALL PASS；ps1 -Doctor（隔离沙盒）：ALL PASS
- 工作树 clean；无 .sync-failed / .needs-push / .pending-writeback / .sync.lock 残留
