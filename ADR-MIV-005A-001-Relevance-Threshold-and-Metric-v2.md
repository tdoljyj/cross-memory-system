# ADR-MIV-005A-001 · Relevance Threshold and Metric v2（相关性准入门与指标合同 v2.0）

> 状态：ACCEPTED（2026-08-19 产品所有者裁决：MIV-005A 正式授权实施；MIV-006 = PASS 已关闭；MIV-005B / Reflection / Temporal / Embedding ADR / 模型下载 / push / PR / tag / release 均不授权）
> 依据：产品所有者裁决文书（MIV-005A 冻结实现合同 + 验收口径）；执行计划《Cross-Memory-System_vNext-2.1_Memory-Intelligence_下一阶段执行计划.md》Gate 2R 路线（MIV-006 → MIV-005A → MIV-005B）
> 执行基线：`97ca58b81b0960c9aa4aa1f2ca10c05f565c174d`（origin/main == HEAD，ahead/behind 0/0，经 ls-remote 远端只读复核）
> 审计日期：2026-08-19

## 1. 背景与问题

1. **v1 Precision@5 数学不可能达标**：`precision_at5` 按“每个正例 hit/5”计算。冻结语料 70 个正例、76 个 golden relevant ID、单例最多 3 个 relevant ID，理论上限 = 76 ÷ (70×5) = **0.2171**。原定 “Precision@5 ≥90%” 在该公式下不可达——指标合同必须先修正，才能度量真实质量。
2. **v1 false_recall 重复计数**：`false_items = len(extra) + len(forbidden_hits)` 对同一对象既算 extra 又算 forbidden，条目级口径不一致。
3. **NO MEMORY violations=2**（nm-002 / nm-006）：无 golden 的负例返回了无关对象（分数恰在阈值边界附近），“无记忆就不得编造”合同被破坏。
4. 需要一道**只做相关性准入**的过滤：不改候选生成、分词、评分权重或排序；为 MIV-005B（词法/BM25）之后的召回恢复留出可逆边界。

## 2. 审计事实（实现前证据）

1. **召回流水线**（`recall_engine.py`）：硬过滤（scope/status/permission/temporal/category/tags/entities/priority）→ `_match_score` → `_rank_key` 排序 → `_conflict_filter` → `limit` → 约束附带。准入门插在 **conflict 之后、limit 之前**（§3 D3 有裁决性证据）。
2. **`_match_score`** = 关键词重合（overlap/|q_tokens|）+ 标签/实体精确命中（每个 +1.5）+ 类别名出现在 query（+1.0）。
3. **nm-002 的分数恰为 1/6**：query “用户最喜欢的编程语言是什么” 12 个 bigram 与夹具 `mem_fx0d0002`（“用户喜欢看科幻电影”）重叠 {用户, 喜欢} = 2/12 = **1/6**。裁决文书“严格 >，等于 1/6 必须排除”是决定性条款：换成 ≥ 会直接放行 nm-002。
4. **既有测试的兼容约束**：`test_memory_v2.py` 的 T1/T2/T3 默认层路由召回（“我是谁”“项目进度”等）与 `test_project_scope.py` #1（project_only 视图中 global 零重叠对象可见）都断言**零重叠候选仍可见**——这是 v2.0 / MIV-006 的既有合同，295 项既有测试必须全 PASS（验收硬门槛），因此准入门必须定义适用范围边界（§3 D4），而非全局无条件叠加。
5. **冻结物证不变**：corpus hash = `1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`；fixtures SHA-256 = `AD84011C4B341C5D5BD4C1FB3C16C7EB4F27FEE3DBC353650CC809E9CC15407A`；111 场景、94 夹具、golden 零改动。
6. **v1 基线**（`memory_eval_baseline/` 冻结）：precision_at5=0.1857、critical recall=0.8553、false_recall=0.35、NO MEMORY 正确率 0.9512（violations=2：nm-002/nm-006）、paraphrase 1/12 PASS。

## 3. 决策

### D1：阈值与比较方式（冻结）

- threshold = **1/6**；comparison = **strict_greater_than**（`score > 1/6`；`score == 1/6` 必须排除）。
- 无任何按 case / 类别 / 项目的特殊阈值；无 synonym map / BM25 / Embedding / tokenizer 改造 / 排序调权。
- `layers` / `categories` 只是候选路由，**不构成相关性证据**。

### D2：准入规则（冻结）

```
admit(obj) = 显式 tags/entities selector 命中(obj)  OR  score > 1/6
```

- 显式 selector（查询携带 tags/entities 参数）是调用方的确定性意图表达，命中即放行（score 低于阈值也返回）。
- 空 query 且无显式 selector → **NO MEMORY**（全部候选 score=0，一律低于阈值被排除）。

### D3：准入门位置 = conflict 之后、limit 之前

裁决文书流程图为 “_match_score ↓ relevance admission ↓ conflict/ranking/limit”，但**冻结语料预期值给出了裁决性证据**：cs-008 的夹具对（`mem_fx0f0009` “用户喜欢静态类型语言” vs `mem_fx0f0011` “用户现在的首选语言是 Python”，后者 contradicts 前者）中，胜者 f0011 分数 = 1/11 < 1/6、输家 f0009 分数 = 7/11 + 1.5 > 1/6。

- 若准入门在 conflict **之前**：f0011 先被排除 → 输家 f0009 失去裁决对象而“复活”返回 → 全语料 precision_at5_v2 = 59/91 ≈ 0.6484，与验收预期 0.6556 不符。
- 若准入门在 conflict **之后**：f0009 按 `CONFLICT_LOSER`、f0011 按 `RELEVANCE_BELOW_THRESHOLD` 双双排除 → 全语料 precision_at5_v2 = **59/90 = 0.6556**，与验收预期精确吻合。

因此实现顺序为：硬过滤 → `_match_score` → 排序 → conflict → **relevance admission** → limit → context packing。conflict/ranking/limit 本身零改动（输家复活漏洞由本顺序天然杜绝）。

### D4：适用边界（Gate 2R 兼容合同）

准入门适用范围（threshold 本身对所有查询完全一致；边界差异是**适用范围**而非阈值特例）：

| 查询路径 | 准入门 | 依据 |
| --- | --- | --- |
| 显式 `layers` 的定向召回（非空 query） | **生效** | 评测/定向召回的确定性语义合同；全部冻结语料门禁 case 走此路径 |
| 空 query（任何 mode，无显式 selector） | **生效** | 裁决硬规则：空 query 且无显式 selector → NO MEMORY |
| 默认 tier→layer 映射的非空 query | 不叠加 | v2.0 既有路由合同（`test_memory_v2` T1/T2/T3 断言零重叠候选可见） |
| MIV-006 硬隔离 mode（project_only / session_only / temporary）的非空 query | 不叠加 | scope 硬过滤即该查询的显式分区 selector，分区合同可见性不变（`test_project_scope` #1 等 14 项断言） |

### D5：Trace 合同（加法扩展）

- 新增顶层字段：`relevance_policy_version = "1.0"`；`relevance_threshold = {value: "1/6", float, comparison（声明严格大于）, selector_bypass: ["tags","entities"], layers_categories_not_relevance_evidence: true}`（所有 Trace，含 T0/T4/temporary 空 Trace）。
- 新增 reason code：`RELEVANCE_BELOW_THRESHOLD`（排除类，集中枚举）。
- 全部候选被准入门排除 → Trace 顶层 `reason_codes: ["NO_MEMORY"]`。
- 被排除候选**零内容/秘密泄漏**（excluded 条目仍只含 `memory_id + reason_codes`）。
- explain=True/False 的 selected IDs 与顺序**完全一致**（准入门不依赖 explain）。

### D6：指标合同 v2.0（metric_contract_version = 2.0）

- `precision_at5_v2`：全部实际返回 Top-5 条目中 relevant 的比例（聚合口径：Σ relevant-in-top5 ÷ Σ top5 条目数）。
- `hit_rate_at5`：正例（golden 非空）中至少一个 golden 进入 Top-5 的比例。
- `false_recall_rate_v2`：错误返回对象数 ÷ 全部返回对象数；每个对象只计一次（wrong = (returned − expected) ∪ (returned ∩ forbidden)，修正 v1 extra+forbidden 重复计数）。
- `critical_memory_recall_v2`：与 v1 critical_memory_recall 同公式（golden 命中 / golden 总数），在 v2 上下文输出并附带 non_paraphrase / paraphrase 切片。
- v2 比率一律**四舍五入（round-half-up）到 4 位**：58/64 = 0.90625 → 0.9063（对齐验收口径；Python 内置 round 半偶会得 0.9062）。
- **v1 字段顶层继续输出**并在 `legacy_v1` 命名空间与 `legacy_v1_fields` 清单中显式标记；v1 语义与公式不变、不回写历史（`memory_eval_baseline/**` 冻结）。
- 自本版本起，“Precision@5 ≥90%”统一指 `precision_at5_v2`。

### D7：已接受的全局 recall 下降（安全优先权衡）

准入门过滤 6 个非 paraphrase 正确 ID：`mem_fx0c0001/mem_fx0c0002/mem_fx0c0003`（ps-007）、`mem_fx0c0015`（ps-016）、`mem_fx0f0011`（cs-008 与 cs-012 各 1 次）→ 非 paraphrase critical recall 64→58（0.9063）、hit_rate_at5 = 55/58。这些 ID 的恢复留给 MIV-005B（词法/BM25）或后续 ADR。**MIV-005A PASS 不代表 Gate 2R 质量达标**（Precision@5≥90% / critical recall≥95% / false recall≤2% 仍是 Gate 2R 总目标）。

## 4. 不变量

1. 候选生成、分词、评分权重、排序零改动（`_match_score` / `_rank_key` / `_conflict_filter` 未动）。
2. T0 真零读取、temporary 零长期读取、T4 立即写入语义不变。
3. 冻结区零改动：`memory/objects/**`、`memory/index.json`、`.clued/**`、corpus / fixtures / golden、`memory_eval_baseline/**`、同步层（sync-memory.py/ps1）、Clued、协议清单、既有 295 项断言语义。
4. 准入门是纯判定（新模块 `memory_engine/relevance.py` 无文件/网络副作用），失败不抛（score 缺失按 0.0 处理 → 排除，fail-closed）。

## 5. 迁移与回滚

- 纯加法：新增 `memory_engine/relevance.py`；`recall_engine.py` 插入一段过滤；`recall_trace.py` 加法扩展字段。无对象写入、无迁移。
- 回滚 = revert 对应 commit 即恢复 97ca58b 行为（无数据迁移、无历史重写）。

## 6. 测试计划

- 既有 **295 项测试全 PASS、0 skip**（Gate 1 基线 281 + MIV-006 14；断言语义零改动）。
- 新增 `tests/test_relevance_admission.py` 15 项：严格大于（==1/6 排除）、selector 放行、空 query NO MEMORY、全排除 NO_MEMORY、适用边界（默认层路由 / 新 mode 不叠加）、explain 等价、Trace 新字段、conflict 之后准入（输家 CONFLICT_LOSER + 门槛下胜者 RELEVANCE_BELOW_THRESHOLD）、类别间阈值一致、被排除候选零泄漏、排序不变、skipped 计数。
- `tests/test_memory_eval.py` 保留全部 v1 断言、新增 6 项 v2 断言（metric_contract_version=2.0 / NO MEMORY 41/41 / 冻结预期指标 / 泄漏全 0 / token P95 ≤650 / 6 个过滤 ID 的 reason code）。

## 7. 验收口径（冻结语料、冻结夹具、冻结 golden）

| 指标 | MIV-005A 门槛 |
| --- | --- |
| 既有 295 项测试 | 全 PASS，0 skip |
| NO MEMORY | 41/41，correctness=1.0，violations=0 |
| nm-002 / nm-006 | 均返回空结果 |
| 非 paraphrase precision_at5_v2 | 1.0000 |
| 非 paraphrase false_recall_rate_v2 | 0.0000 |
| 非 paraphrase critical recall | 0.9063（58/64） |
| 非 paraphrase hit_rate_at5 | 0.9483（55/58） |
| 全语料 precision_at5_v2 | 0.6556 |
| 全语料 false_recall_rate_v2 | 0.3444 |
| 全语料 critical recall | 0.7763（59/76） |
| paraphrase | 1/12 PASS、11/12 FAIL |
| scope/project/superseded/stale/secret leakage | 全部 0 |
| token P95 | 不增加且 ≤650 |
| latency P95 | 同机 control 的 ≤120% |

## 8. 治理边界

- 仅本地、单一目的提交；不 amend / squash / rebase / push / PR / tag / release。
- 远端若不再是 `97ca58b` → 立即以 **BASELINE_DRIFT** 停止。
- PASS 后仅允许 `memory/状态.md` 追加一行登记；完成后停止，等待对结果与 push / MIV-005B 的下一次裁决。
