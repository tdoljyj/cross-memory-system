# Cross-Memory-System vNext-2.1 Gate2R MIV-005A 报告

> 阶段：Gate 2R 第二阶段 MIV-005A（相关性准入门 + 指标合同 v2.0）
> 状态：**PASS（本地实施验收通过；未 push）**——产品所有者裁决仅授权本地、单一目的提交；完成后停止等待对结果与 push / MIV-005B 的下一次裁决
> 执行基线：`97ca58b81b0960c9aa4aa1f2ca10c05f565c174d`（origin/main == HEAD，ahead/behind 0/0，远端只读复核一致）
> 报告日期：2026-08-19
> 关联 ADR：`ADR-MIV-005A-001-Relevance-Threshold-and-Metric-v2.md`（ACCEPTED，本报告为其验收证据）

## 1. 授权与边界（照录裁决）

- MIV-006 = PASS 已关闭；**MIV-005A 授权实施**；MIV-005B / Reflection / Temporal / Embedding ADR / 模型下载 / push / PR / tag / release **均不授权**。
- 先修正指标合同：v1 `precision_at5` 在冻结语料（70 正例 / 76 golden / 单例 ≤3 relevant）下理论上限 = 76÷(70×5) = 0.2171，原定 Precision@5 ≥90% 数学不可达。
- 冻结物证不变：corpus hash = `1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`；fixtures SHA-256 = `AD84011C4B341C5D5BD4C1FB3C16C7EB4F27FEE3DBC353650CC809E9CC15407A`；111 场景、94 夹具、golden 零改动。

## 2. 实现清单（仅限裁决允许修改的文件）

| 文件 | 变更 |
| --- | --- |
| `memory_engine/relevance.py`（新增） | 准入门纯判定模块：threshold=1/6、strict_greater_than、selector 放行、适用边界（显式 layers / 空 query 生效；默认层路由与 MIV-006 硬隔离 mode 不叠加）。无文件/网络副作用 |
| `memory_engine/recall_engine.py` | 在 conflict 之后、limit 之前插入准入门（只过滤、不改排序）；`skipped.relevance_below_threshold` 计数；全部排除 → NO_MEMORY。候选生成 / 分词 / 评分权重 / 排序零改动 |
| `memory_engine/recall_trace.py` | Trace 新增 `relevance_policy_version`、`relevance_threshold`（value/float/comparison/selector_bypass）、`RC_RELEVANCE_BELOW_THRESHOLD`；全排除时顶层 `reason_codes: [NO_MEMORY]`；excluded 仍只含 memory_id + reason_codes（零内容/秘密） |
| `memory_eval/metrics.py`（新增） | 指标合同 v2.0：`precision_at5_v2` / `hit_rate_at5` / `false_recall_rate_v2` / `critical_memory_recall_v2` + non_paraphrase / paraphrase 切片；v2 比率四舍五入（half-up，58/64=0.90625→0.9063） |
| `memory_eval/runner.py` | `metric_contract_version=2.0`；v1 字段顶层保留 + `legacy_v1` / `legacy_v1_fields` 显式标记；报告渲染补 v2 段 |
| `tests/test_memory_eval.py` | **v1 断言全部保留**，新增 6 项 v2 断言（合同版本 / NO MEMORY 41/41 / 冻结预期指标 / 泄漏全 0 / token P95 / 6 个过滤 ID） |
| `tests/test_relevance_admission.py`（新增） | 15 项引擎级准入门测试（严格大于 / selector 放行 / 空 query / 适用边界 / explain 等价 / Trace 字段 / conflict 顺序 / 阈值一致 / 零泄漏 / 排序不变 / 计数） |
| `ADR-MIV-005A-001-Relevance-Threshold-and-Metric-v2.md`（新增） | 本 ADR |
| 本报告（新增） | 验收证据 |

冻结区零改动：`memory/objects/**`、`memory/index.json`、`.clued/**`、corpus / fixtures / golden、`memory_eval_baseline/**`、同步层、Clued、协议清单、既有 295 项断言语义。

## 3. 测试矩阵

| 套件 | 结果 |
| --- | --- |
| 既有 295 项（test_acceptance 70 + clued 124 + test_memory_v2 55 + test_recall_trace 19 + test_memory_eval 13 + test_project_scope 14） | **295/295 PASS，0 skip** |
| 新增 test_relevance_admission 15 项 | 15/15 PASS |
| 新增 test_memory_eval v2 断言 6 项 | 6/6 PASS |
| **合计** | **316/316 PASS，0 skip，0 fail** |

隔离重测：全套在 cms-miv006 工作克隆（HEAD=97ca58b + 本地 MIV-005A 提交）直跑；评测夹具物化于临时目录，真实 memory/objects 与 object-index.json 前后字节级一致（既有断言覆盖）。

## 4. 验收口径对照（冻结预期 vs 实测）

| 指标 | MIV-005A 门槛 | 实测 | 判定 |
| --- | --- | --- | --- |
| 既有 295 项测试 | 全 PASS，0 skip | 295/295 PASS，0 skip | ✅ |
| NO MEMORY | 41/41，correctness=1.0，violations=0 | 41/41，1.0，0 | ✅ |
| nm-002 / nm-006 | 均返回空结果 | 均 `[]`（nm-002 分数恰为 1/6，严格 > 排除） | ✅ |
| 非 paraphrase precision_at5_v2 | 1.0000 | **1.0000** | ✅ |
| 非 paraphrase false_recall_rate_v2 | 0.0000 | **0.0000** | ✅ |
| 非 paraphrase critical recall | 0.9063（58/64） | **0.9063（58/64）** | ✅ |
| 非 paraphrase hit_rate_at5 | 0.9483（55/58） | **0.9483（55/58）** | ✅ |
| 全语料 precision_at5_v2 | 0.6556 | **0.6556（59/90）** | ✅ |
| 全语料 false_recall_rate_v2 | 0.3444 | **0.3444（31/90）** | ✅ |
| 全语料 critical recall | 0.7763（59/76） | **0.7763（59/76）** | ✅ |
| paraphrase | 1/12 PASS、11/12 FAIL | 1/12（pp-011）、11/12 | ✅ |
| scope/project/superseded/stale/secret leakage | 全部 0 | 0 / 0 / 0 / 0.0 / `[]` | ✅ |
| token P95 | 不增加且 ≤650 | **50**（control=50，持平；≤650） | ✅ |
| latency P95 | 同机 control 的 ≤120% | **0.624ms**（control 0.708ms，88.1%） | ✅ |

### 4.1 同机 control 对比（97ca58b 基线 vs MIV-005A）

| 指标 | control（97ca58b） | MIV-005A |
| --- | --- | --- |
| precision_at5（legacy_v1，语义不变） | 0.1857 | 0.1761 |
| critical_memory_recall（legacy_v1） | 0.8553 | 0.7763 |
| false_recall_rate（legacy_v1） | 0.35 | 0.3444 |
| NO MEMORY correctness / violations | 0.9512 / 2 | 1.0 / 0 |
| estimated_prompt_tokens_p95 | 50 | 50 |
| recall_latency_ms_p95 | 0.708 | 0.624 |
| replay hash | fa3c0533… | f4266eab… |

### 4.2 已接受的 recall 下降（6 个正确 ID，留待 MIV-005B / 后续 ADR 恢复）

| case | 过滤 ID | Trace reason |
| --- | --- | --- |
| ps-007 | `mem_fx0c0001`, `mem_fx0c0002`, `mem_fx0c0003` | RELEVANCE_BELOW_THRESHOLD |
| ps-016 | `mem_fx0c0015` | RELEVANCE_BELOW_THRESHOLD |
| cs-008 | `mem_fx0f0011`（其对手 `mem_fx0f0009` 按 CONFLICT_LOSER 排除，无“输家复活”） | RELEVANCE_BELOW_THRESHOLD |
| cs-012 | `mem_fx0f0011` | RELEVANCE_BELOW_THRESHOLD |

非 paraphrase critical recall 64→58（0.9063）、hit_rate 55/58 为**本阶段已接受的安全优先权衡**；**MIV-005A PASS 不代表 Gate 2R 质量达标**（Precision@5≥90% / critical recall≥95% / false recall≤2% 仍是 Gate 2R 总目标，召回恢复留给 MIV-005B）。

## 5. 失败/差距样本（15 例，均只含 ID 与 reason code，零内容/秘密）

- `ps-007` missed ×3（RELEVANCE_BELOW_THRESHOLD）；`ps-016` missed ×1；`cs-008` missed ×1 + critical `explicit_wins`；`cs-012` missed ×1；
- paraphrase 11 例（pp-001…010、pp-012）missed=golden ×1、critical=`paraphrase_hit_top5`、extra=阈值之上的同类别候选（paraphrase 内容不共享词面 token，属 MIV-005B 能力缺口）；
- pp-011（“回答要结论先行”）score=4/6 > 1/6 → PASS（1/12）。

## 6. 治理与后续

- 仅本地、单一目的提交（3 个：引擎+测试 / 评测指标 / 文档+状态登记）；未 amend / squash / rebase / push / PR / tag / release。
- 远端保持 `97ca58b`，工作克隆 ahead=N（本地提交），canonical 克隆 `~/.dsh/projects/cross-memory-system` 保持 0/0 干净。
- 完成后停止，等待对 MIV-005A 结果、是否 push、是否启动 MIV-005B 的下一次裁决。

---

## 7. 勘误 MIV-005A-R1（2026-08-19 产品所有者裁决：PARTIAL / CONTRACT_DEVIATION）

> 本节为**追加勘误**，不删除 / 不修改第 1–6 节的原始 PASS 记录（本报告第 4 节的验收口径照录当时实测，第 7 节起为 R1 后的修正口径）。

### 7.1 裁决要点（照录）

- 接受：1/6 阈值与指标结果；Metric Contract v2.0；「conflict 后、limit 前执行准入」为安全性合同修正（正式顺序：硬过滤 → 评分与排序 → conflict 裁决 → relevance admission → limit → context packing）；316 项全绿及冻结证明（暂接受）。
- **不接受**：仅显式 layers 应用准入门；默认 tier 路由、MIV-006 mode 绕过准入。未通过原因 = 指标全绿不能证明默认产品路径已获得正确 NO MEMORY（`tier→默认 layers` / `project_only` / `session_only` 仍可能返回同类别无关对象）。
- 授权 MIV-005A-R1 整改；不授权 push / MIV-005B / Embedding ADR / Reflection / Temporal / tag / release。

### 7.2 R1 整改与全量实测

- 实现：删除 `relevance.gate_active()` / `NEW_SCOPE_MODES` 与 `recall_engine.layers_explicit`，准入门对所有到达准入阶段的召回路由（显式 layers / 默认 tier→layer / project_only / session_only）统一生效；T0 / T4 / temporary 提前短路与零读取保持不变；conflict → admission → limit 顺序不变。
- 新增 `tests/test_relevance_admission_r1.py` **10 项：10/10 PASS**（默认 tier 相关命中 / 无关 NO MEMORY / 显式 layers ≡ tier-derived / project_only 正反例 / session_only 正反例 / conflict loser 三路由不复活 / explain 等价 / Trace reason code / tags+entities selector 全路由一致）。
- 既有 316 项：**306 PASS / 10 FAIL**（详见 ADR-MIV-005A-001 §9.3 逐项表）：test_relevance_admission 2（旧「不叠加」边界断言）、test_project_scope 1（project_only 视图中 global 零重叠对象可见）、test_memory_v2 7（T1/T2 默认路由召回、superseded/history、temporal 1/6 边界、project scope filter、acceptance project state）。
- 不受影响：test_acceptance 70、clued 124、test_memory_eval 19（冻结 corpus 显式 layers → 冻结指标与 NO MEMORY 41/41 不变）、test_recall_trace 19。
- 按裁决未修改任何旧断言、未重新增加隐式绕过；**整改 commit 未提交**，停止等待「是否授权测试合同演进」的裁决。MIV-005A 改判 PASS 的条件（316 + 新增全绿）当前不满足。

### 7.3 测试合同演进与本地验收（2026-08-19 产品所有者裁决：授权两提交；本地验收通过、等待正式裁决）

> 追加勘误。第 1–6 节与 §7.1/§7.2 的全部 PASS / 整改失败记录保留不变；本节只记录授权后的演进，不构成正式 PASS（HOLD 未解除）。

- **授权边界**：接受 R1 实现方向、当前仍为 HOLD；2 项旧「准入绕过」测试翻转为新合同（明确断言默认 tier 路由与新 scope mode 同样执行 score > 1/6）；其余 8 项不得把预期改成 `[]`，优先调整测试查询使目标对象满足相关性门槛、保留原语义（tier / project isolation / current vs history / superseded / temporal）；不得修改阈值、评分算法、生产数据或冻结 fixtures。
- **fix 提交** `fix: apply relevance admission across recall routes (MIV-005A-R1)`：R1 生产代码（删除 `gate_active` / `NEW_SCOPE_MODES` / `layers_explicit`，全路由统一准入）+ 新增 `tests/test_relevance_admission_r1.py` 10 项（10/10 PASS）+ 10 项旧测试合同演进：`test_relevance_admission.py` 2 项翻转为 `test_gate_applied_default_tier_layers` / `test_gate_applied_new_scope_modes`；`test_project_scope.py` 1 项（「引擎」→「引擎 git」）与 `test_memory_v2.py` 7 项调整查询，逐项调用与语义见 ADR-MIV-005A-001 §9.5。
- **docs 提交** `docs: correct MIV-005A applicability evidence`：本 §7.3 + ADR §9.5 + `memory/状态.md` 追加一行；只追加历史勘误，不删除此前 PASS / 整改失败记录；只记录「本地验收通过、等待正式裁决」。
- **本地验收（等待正式裁决，非正式 PASS）**：
  - 全量 **326/326 PASS、0 skip**（test_acceptance 70、clued 124、test_memory_eval 19、test_memory_v2 55、test_project_scope 14、test_recall_trace 19、test_relevance_admission 15、test_relevance_admission_r1 10）；
  - 冻结评测复跑：replay hash `f4266eab…` 与冻结基线一致；corpus hash、111 例 verdicts、全部冻结指标不变（全语料 precision_at5_v2=0.6556 / false_recall=0.3444 / critical recall=0.7763；非 paraphrase 1.0000 / 0.0000 / 0.9063（58/64）/ hit_rate 0.9483；paraphrase 1/12；泄漏全 0；token P95=50）；latency 为运行时计时、非冻结指标（复跑 P95=0.624ms ≤ control 0.708ms 的 120%）；
  - doctor 三件套 ALL PASS（canonical 克隆 0/0 @ `97ca58b`：`memory.py doctor` ALL PASS（0 WARN）、`clued.py doctor --json` ok=true、`sync-memory.py doctor` ALL PASS；工作克隆 `memory.py doctor` 亦 ALL PASS）；
  - 密钥扫描 0 命中（guards 模式、全仓 346 文件）；冻结区 / 同步层 / Clued / 协议清单零改动（diff 仅 2 个引擎文件 + 4 个测试文件 + 本文档 / ADR / 状态.md）；
  - 远端仍为 `97ca58b`，工作克隆 ahead/behind = 5/0，worktree clean；未 push / tag / release；MIV-005B 未启动；README 卸载/停用支持为后续独立工作项，本轮未夹带。
- **状态**：本地验收通过，**等待 MIV-005A 正式裁决**（HOLD 未解除，不得视为正式 PASS）。

## 8. 正式裁决：MIV-005A PASS（2026-08-19 产品所有者裁决）

> 追加记录；第 1–6 节与 §7 的全部历史记录（含 §7.2 的整改失败与等待授权记录）保持不变。

- **裁决结论**：**MIV-005A 正式 PASS**。接受实现 HEAD = `e89c036`；R1 全路由统一准入 PASS；326 项测试 PASS；冻结评测与 replay hash PASS。
- **BASELINE_DRIFT 解决**：Codex 端推送 `51093d3`（docs：installation guide and lifecycle work item，README.md + memory/待办.md）后按本报告 §6/ADR §8 停止并回报；产品裁决接受其为授权文档提交、新执行基线 origin/main=`51093d3`，授权唯一 merge commit；`e89c036`（父提交=`543f3be`+`51093d3`，仅引入 README.md 与 memory/待办.md）正式解决漂移，合并后复验全通过（6/0、326/326、replay hash `f4266eab…`、doctor 三件套、密钥扫描 0）。
- **冻结验收结果（接受 HEAD `e89c036`）**：326/326 PASS、0 skip；replay hash `f4266eabd2bed94d…` 不变；全语料 precision_at5_v2=0.6556 / false_recall=0.3444 / critical recall=0.7763；非 paraphrase 1.0000 / 0.0000 / 0.9063（58/64）/ hit_rate 0.9483（55/58）；paraphrase 1/12；泄漏全 0；token P95=50；latency 非冻结（复跑 ≤ control 120%）。
- **收口**：授权纯文档收口提交 `docs: record formal MIV-005A PASS`（ADR §10 + 本 §8 + `memory/状态.md` 一行）与普通 fast-forward push 至 origin/main（未推送范围 = 既有 MIV-005A 链 + 授权 merge + 收口提交）；push 后 local HEAD = remote main、0/0；不 tag / release；MIV-005B 与安装/停用/卸载独立工作项暂不授权。
