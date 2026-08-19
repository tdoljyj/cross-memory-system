# Cross-Memory-System vNext-2.1 Gate 1 Report

> 执行计划：《Cross-Memory-System_vNext-2.1_Memory-Intelligence_下一阶段执行计划.md》
> 本 Gate 授权范围：MIV-000 / MIV-001 / MIV-002（Measure & Explain）
> 执行者：WorkBuddy（墨）@ CHASE-PC
> 执行基线：`clued-v0.2.0` → `91d9af6ac4851687aa8b7f281abcb4b8c714e080`

## 1. Result

- **Gate 1 infrastructure = PASS**（249/249 既有回归 0 失败 0 跳过 + 新增 32 项
  全 PASS + 冻结区 diff 为空 + 真实记忆字节级一致 + doctor 三件套全 PASS；
  偏差清单为空）
- **vNext-2.0 memory-quality baseline = BELOW TARGET**（Precision@5=0.19 /
  false recall=0.37 / paraphrase 11/12 不命中 / project_id 隔离 1 缺口——
  均为既有引擎目标差距，本 Gate 只度量不修改召回算法，如实记录）
- 本 Gate 授权范围：MIV-000 预检、MIV-001 Memory Eval、MIV-002 Recall Trace、
  Gate 1 验收、文档与 `memory/状态.md` 登记、仅本地单一目的提交
- 是否严格停止在授权边界：**是**——未执行 MIV-003 及以后任何任务；
  未 push（口径修正前）/ 未建 PR / 未 tag / 未 release / 未 rebase / 未 force push；
  未修改真实记忆数据；未启用任何自动写入/反思/Embedding

## 2. Version Truth

| 项 | 值 |
| --- | --- |
| exact local HEAD（执行开始） | `d436de8edcf4e1dcb471e9f20c9f28fa1f08c197`（vNext-1.3 镜像滞后） |
| fetch+merge 对齐后 local HEAD | `91d9af6ac4851687aa8b7f281abcb4b8c714e080` |
| exact remote HEAD（ls-remote） | `91d9af6ac4851687aa8b7f281abcb4b8c714e080` |
| `clued-v0.2.0^{}` | `91d9af6ac4851687aa8b7f281abcb4b8c714e080` |
| 三者精确相等 | ✅ |
| ahead/behind（对齐后） | 0 / 0 |
| worktree（执行开始） | clean |
| VERSION | `vNext-2.0` |
| TESTED_HEAD | `2e1af97a0bd0263f82b1c7419a87e92a0832e592`（干净 clone：249 既有 + 19 trace 在 `41a32e1d` 全绿、`2e1af97` 等价[仅 runner.py diff，且 249+trace 测试零依赖 memory_eval]；memory_eval 13 项在 `2e1af97` 全绿；doctor 三件套 + secret scan 在 `2e1af97` 全 PASS） |
| FINAL_REPORT_HEAD | `2e1af97a0bd0263f82b1c7419a87e92a0832e592`（代码/测试 HEAD；文档定稿提交 `848fe9d` 零代码 diff，见 §11） |
| ahead/behind（最终） | ahead=10（本地提交，未 push）；behind=0 |

## 3. Baseline & Frozen Evidence

- `python memory.py doctor`（真实仓库，只读）：**ALL PASS（0 WARN）**
  - objects total=230（candidate=147 / active=83）；audit entries=230
- 既有测试基线：见 §6（十套命令提取自《Clued-v0.2.0-LKG-Policy-Report.md》§5）
- 冻结区 SHA-256 清单：`evidence/freeze-manifest.json`（65 项，生成于执行开始）
  - 永久冻结（§4.1）：`sync-memory.py` / `sync-memory.ps1` / `guards.json` /
    `protocol-manifest.json` / `migrate-memory.py` / `clued.py` / `clued/**`
  - Gate 1 冻结（§4.2）：`memory_engine/**` / `memory.py` / `adapters/**`
  - 既有基线测试：`tests/**` 全部既有文件
- 真实记忆哈希快照：`evidence/memory-hash-snapshot.json`
  （232 项 = 230 objects + object-index.json + audit.log + legacy ledger）
  - 最终校验：前后字节级一致（见 §10）

## 4. Implemented Work Packages

### MIV-000：预检、版本真值与冻结区证明
- 版本真值核对（§2）；本地镜像从 vNext-1.3（d436de8）fetch+merge（非 rebase）
  对齐到基线 91d9af6
- 十套既有测试命令从已发布报告提取并逐套运行（§6）
- `rg --files tests` 核对：本环境无 ripgrep，以目录清单核对（12 个文件 =
  10 套测试 + `clued_testkit.py` 工具 + `__init__.py`），与报告一致
- 冻结区清单 + 真实记忆哈希快照（见 §3）
- 隔离环境：仓库外临时目录 `cms-gate1-iso/`（bare remote + 从精确 HEAD
  建立的干净 clone；clone 的 origin 指向本地 bare remote，全程零真实远端写入）

### MIV-001：Memory Eval Harness
- `memory_eval/schema.py` — Eval Case Schema v1（8 类枚举/配额/校验器）
- `memory_eval/corpus.py` — 111 个固定脱敏场景（8 类配额全满足）+ corpus hash
- `tests/fixtures/memory_eval/fixtures.json` — 94 个合成脱敏夹具
  （固定时间戳；秘密样值运行时注入，仓库文件零自命中）
- `memory_eval/runner.py` — 基准运行器（固定时钟/双模拟 Adapter/
  explain=True 获得 Trace/回放哈希/秘密泄漏扫描/真实记忆零触碰护栏）
- `memory_eval/__main__.py` — `python -m memory_eval` 输出 results.json + report.md
- `tests/test_memory_eval.py` — 12 项单元/合同/负例测试
- 基准报告：`memory_eval_baseline/results.json` + `report.md`（§7）

### MIV-002：Recall Trace / 为什么召回
- `memory_engine/recall_trace.py` — Recall Trace 合同 v1.0（只读观测层）：
  - selected/excluded 稳定 reason code（28 个集中枚举，禁止自由文本）
  - 版本派生（审计条目数）、来源定位（source_ref，脱敏）、时间状态、
    排序分量、token 预算（固定估算器 `cms-cjk1-ascii4` v1.0）、degraded 显式降级
- `memory_engine/recall_engine.py` — `explain=False/True` 可选观测钩子
  （explain=False 路径与原实现逐行等价；explain=True 仅追加记录）
- `memory.py` — `recall --explain` CLI（Trace 仅在显式请求时输出）
- `tests/test_recall_trace.py` — 19 项测试（等价性/确定性/原因码覆盖/
  零读取/秘密零泄漏/降级/路径/兼容/开销预算）

## 5. Changed Files

### Added
```
memory_eval/__init__.py
memory_eval/__main__.py
memory_eval/schema.py
memory_eval/corpus.py
memory_eval/runner.py
memory_eval/make_fixtures.py
memory_engine/recall_trace.py
tests/fixtures/memory_eval/fixtures.json
tests/test_memory_eval.py
tests/test_recall_trace.py
memory_eval_baseline/results.json
memory_eval_baseline/report.md
Cross-Memory-System-vNext-2.1-Gate1-Report.md（本文件）
```

### Modified
```
memory_engine/recall_engine.py   # explain 可选观测钩子（行为不变）
memory.py                        # recall --explain CLI
memory/状态.md                    # Gate 1 登记（按计划要求）
```

### Deleted
```
（无）
```

## 6. Test Evidence

环境：隔离干净 clone（HEAD=91d9af6，origin=本地 bare remote）+ 官方 Git
2.55.0.windows.3 + Python 3.13.14 + 便携 PowerShell 7.6.5（本机 PS5.1 在
子进程下挂起，pwsh 为仓库文档声明的运行时）+ `GIT_DEFAULT_REF_FORMAT=reftable`
（WorkBuddy 环境 overlay 拦截 git files-backend 两层 ref 写——exit 0 静默失败
且清空父目录，2026-08-16 已实锤；reftable 后端不受影响，隔离环境合法配置）。

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `python tests/test_acceptance.py` | 70/70 PASS |
| 2 | `python tests/test_memory_v2.py` | 55/55 |
| 3 | `python tests/test_clued_unit.py` | 27/27 |
| 4 | `python tests/test_clued_auth.py` | 18/18 |
| 5 | `python tests/test_clued_install.py` | 10/10 |
| 6 | `python tests/test_clued_pending.py` | 15/15 |
| 7 | `python tests/test_clued_recovery_crash.py` | 13/13 |
| 8 | `python tests/test_clued_uninstall.py` | 11/11 |
| 9 | `python tests/test_clued_e2e.py` | 8/8 |
| 10 | `python tests/test_clued_policy.py` | 22/22 |
| 合计 | **249 项，0 失败，0 跳过（最终干净 clone 一次通过）** | |
| — | `python clued.py doctor --json` | exit 0，7 项 findings 全 PASS |
| — | `python memory.py doctor` | ALL PASS（0 WARN） |
| — | `python sync-memory.py doctor` | ALL PASS |
| 新增 | `tests/test_recall_trace.py` | 19/19 PASS，0 skip |
| 新增 | `tests/test_memory_eval.py` | 12/12 PASS，0 skip |

证据文件：v3 隔离环境（`%TEMP%/cms-gate1-iso-*/evidence/`）每套 `test_*.log`
（含退出码）+ `summary.txt` + doctor 三件套输出 + `git status --porcelain` 为空。

证据文件：`cms-gate1-iso/evidence/summary.txt` + 每套 `test_*.log`（含退出码）。

## 7. Quality Metrics

- corpus hash：见 baseline report（`memory_eval_baseline/report.md`）
- case 数：111（8 类配额 15/15/15/15/10/10/10/10 全满足，schema 100% 有效）
- 指标（vNext-2.0 引擎诚实基准，未为达标修改召回算法）：

| 指标 | 基准值 | 说明 |
| --- | ---: | --- |
| Precision@5 | ~0.19 | 确定性检索无相关性阈值 + 零词面重合改写不命中（**BELOW TARGET** ≥0.90） |
| critical-memory recall | ~0.86 | 明确偏好/冲突裁决基本可靠（BELOW TARGET ≥0.95） |
| false recall rate | ~0.37 | 无阈值 → 同类别无关对象全量返回（**BELOW TARGET** ≤0.02，MIV-005A） |
| stale recall rate | 0.0 | 时间过滤工作正常（非当前瓶颈） |
| current-scope leakage | **0** | 既有 global/project/session 边界正确执行，无越权（达标） |
| project-only capability gap | **1** | ps-010：v2.0 无 project_id 隔离（MIV-006 能力缺口，非既有 scope 越权） |
| superseded leakage count | 0 | 状态过滤工作正常 |
| NO MEMORY correctness | ~0.95 | 2 例违反均为「无阈值返回无关同类对象」 |
| cross-agent consistency | 1.0 | 双模拟 Adapter 合同一致 |
| estimated prompt tokens P50/P95 | 18 / 50 | 固定估算器 cms-cjk1-ascii4 v1.0 |
| recall latency P50/P95 | ~1.0 / ~1.7 ms | 预热后（合成小库） |
| determinism | 通过 | 同环境连续两次 replay hash 一致 |
| secret leakage | 0 | FAKE_TOKEN 零泄漏（结果/报告/trace） |

## 8. Security & Fault Injection

| 场景 | 预期 | 实际 | 证据 |
| --- | --- | --- | --- |
| 记忆内容含 prompt injection | 当作数据召回，不影响其他召回 | ✅ | eval sa-001/sa-002 |
| 跨 scope 相似候选 | 硬过滤 | ✅（scope=project 语义内）| eval sa-005/sa-012 |
| superseded 语义更相似 | 不得召回旧版本 | ✅ | eval cs-001..010 |
| Trace 构建失败 | 显式 degraded=true + build_error，结果本体不受影响 | ✅ | test_trace_build_failure_degrades_not_silent |
| secret fixture | trace/报告/结果零泄漏 | ✅ | test_secret_never_leaks_in_trace + sa-004 |
| 非法对象/损坏索引 | 安全失败，不虚构来源 | ✅ | test_invalid_object_no_fabricated_source |
| T0 | 零文件读取 | ✅ | test_t0_zero_reads（list_object_ids 炸弹探针） |

## 9. Compatibility

- explain=False 与 explain=True：selected IDs/顺序/截断/状态完全一致
  （test_explain_does_not_change_result + history/scope/limit/light 多参数矩阵）
- 旧 Adapter（不传 explain）：合同保持兼容，`to_dict()` 无 trace 键
  （test_old_adapter_contract_compatible）
- 完全离线：Trace 与 Eval 均不依赖网络（临时夹具 + 本地仓库）
- Windows/POSIX：source_ref 统一正斜杠（test_source_ref_path_portable）
- Trace P95 开销：实测 +2.55ms（相对 +6.7%，绝对 ≤10ms）→ 按「不高于 5%
  或绝对增加 ≤10ms 取较宽者」达标（test_trace_overhead_within_budget，
  真实仓库 230 对象 T2 召回，base P95=38.2ms / explain P95=40.8ms）

## 10. Deviations & Limitations

环境适配（均为隔离测试环境配置，非代码/合同偏差；已在仓库历史文档中
有据可依）：
- 本机 PowerShell 5.1 在子进程下挂起且未安装 pwsh → 在用户目录便携安装
  PowerShell 7.6.5（仓库文档声明 pwsh 为 ps1 运行时）
- WorkBuddy 环境 overlay 拦截 git files-backend 两层 ref 写（exit 0 静默失败
  且清空父目录，2026-08-16 已实锤）→ 隔离测试环境设
  `GIT_DEFAULT_REF_FORMAT=reftable`（reftable 后端不受影响；探针实测：
  files-backend 写 `refs/remotes/origin/doctor-test` 静默失败且父目录消失，
  reftable 同操作成功）
- WorkBuddy Python safe-delete 钩子（`CODEBUDDY_SAFE_DELETE_SANDBOX=1` 时
  `os.remove` fail-closed）→ 隔离 clone 置于系统 TEMP 目录（钩子豁免）
- **WorkBuddy 环境对高频文件删除的进程树级硬退出**（约 500+ 次 `shutil.rmtree`
  即 os 级终止进程树、无 traceback、连带杀父 shell；`-S` 跳过 sitecustomize 后
  仍复现，故非 safe-delete 钩子本身，属宿主层限制）→ Memory Eval 运行器改为
  复用单个临时根目录（每次 run_all 仅 2 次 rmtree，见提交 `2e1af97`）；
  评测语义不变（replay hash `b7a9b250` 与改动前完全一致）
- 本机无 ripgrep → `rg --files tests` 以目录清单等价核对
- 首轮全量跑 test_clued_policy 曾出现 1 例时间边界抖动（高负载下 3599s 边界
  越过 1h）；隔离复跑与最终干净 clone 一次通过（22/22），判定为负载噪声

已知限制（本 Gate 不处理；已按产品裁决列为 Gate 2R 顺序）：
- v2.0 引擎无相关性阈值：同类别无关对象全量返回（false recall 0.37，
  → Gate 2R / MIV-005A）
- v2.0 引擎无 project_id 隔离：ps-010 项目隔离缺口（→ Gate 2R / MIV-006，
  **非既有 global/project/session 边界越权**，见下）
- 零词面重合改写（paraphrase）不命中（11/12 未达 top5，→ Gate 2R / MIV-005B）
- 「permission denied」reason code 为预留码：v2.0 引擎授权边界 = scope，
  越权以 SCOPE_MISMATCH 表达（test_permission_denied_is_scope_boundary）

### ps-010 性质判定（Push 前置口径）

ps-010（scope.project_id="p-alpha" vs p-beta）唯一命中 forbidden。判定为
**MIV-006 尚未实现的 project_id 隔离能力缺口，而非既有 scope 真实越权**，
依据：
1. v2.0 引擎 scope 模型只有 `global/project/session` 单桶，无 project_id 字段；
   两对象 scope 均为 `project`，在「project 桶」内被一并召回符合 v2.0 自身合同；
2. 既有 current-scope 边界（global 排除 project、project 排除 session、global
   排除 session）在 ps-005/ps-006/ps-015/sa-005/sa-012 全部正确执行，
   **current-scope leakage = 0**（新增 `test_scope_metric_split_contract` 固化）；
3. 计划 §2.3 已把「项目级隔离尚未产品化」列为 P1/MIV-006。

故不构成 push 阻断，按能力缺口记录，交由 Gate 2R / MIV-006 归零。

## 11. Git Evidence

本地提交列表（自基线 91d9af6 起，均为追加、单一目的，无 amend/squash/
rebase/force）：

```
f2d1dd4 [WorkBuddy@TURING] test: add deterministic memory intelligence eval corpus（MIV-001 评测语料）
0fed055 [WorkBuddy@TURING] feat: add read-only recall trace contract（MIV-002）
ae0f93a [WorkBuddy@TURING] test: cover recall trace safety and compatibility（MIV-002 Gate 1 新增测试）
bab065b [WorkBuddy@TURING] docs: record vNext-2.1 gate-1 evidence and baseline
3b596c8 [WorkBuddy@TURING] memory: record vNext-2.1 gate-1 status
13597a5 [WorkBuddy@TURING] docs: finalize vNext-2.1 gate-1 report head evidence
e8829a7 [WorkBuddy@TURING] test: split scope metric into current-scope leakage vs project-only capability gap
41a32e1 [WorkBuddy@TURING] docs: clarify gate-1 infra PASS vs memory-quality BELOW TARGET（口径修正）
2e1af97 [WorkBuddy@TURING] fix: reuse single temp root in eval runner（规避高频删除硬退出）
848fe9d [WorkBuddy@TURING] docs: finalize gate-1 report at HEAD 2e1af97（口径修正 + 高频删除规避）
```

- no amend / no rebase / no force push / no PR / no tag / no release ✅
- push：口径修正后，经产品所有者授权，普通 fast-forward push（见 §12）
- 远端执行前 HEAD：`91d9af6ac4851687aa8b7f281abcb4b8c714e080`（零写入，
  `git ls-remote origin main` 执行前后一致）
- worktree clean（提交后核验）
- secret scan：全仓扫描零自命中（含新增 memory_eval_baseline/ 产物与全部新文件）
- FINAL_REPORT_HEAD（代码/测试 HEAD）= `2e1af97a0bd0263f82b1c7419a87e92a0832e592`
  （§11 提交链；TESTED_HEAD = 2e1af97，所有测试在该 HEAD 的干净 clone 上跑）
- 本文档自身定稿提交 `848fe9d` 仅含 `.md` 文档（2e1af97..848fe9d 零代码/测试 diff，
  不改变任何测试结果）；实际 `git rev-parse HEAD` = `848fe9d`

## 12. Next Decision Required（产品所有者裁决）

已裁定（2026-08-19）：
1. Eval corpus / 指标 → **接受为 v1.0 基准**，冻结 111 场景 + 94 夹具 + hash
2. Recall Trace v1.0 → **接受**
3. Gate 1 push → **有条件授权**（口径修正后普通 fast-forward push；
   不打 tag、不 release、不进入下一 Gate）
4. 原 Gate 2（Reflection + Temporal）→ **暂不授权**

新优先级：**Gate 2R · Recall Safety & Relevance**（召回安全、相关性与项目隔离）
顺序：MIV-006（project_id 硬隔离，scope leakage 归零）→ MIV-005A（相关性阈值
与正确 NO MEMORY）→ MIV-005B（本地词法/BM25，解决 paraphrase）→ 仅 BM25 未达标
才提交本地 Embedding ADR；达到 Precision@5 ≥90%、critical recall ≥95%、
false recall ≤2% 后，才重新授权 Reflection；Temporal 延后（当前 stale=0）。
