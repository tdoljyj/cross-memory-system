# ADR-MIV-005B-001：MIV-005B 词法可行性审计（确定性 BM25 探针）

- 状态：**本地审计完成；结论 = 单一固定词法策略不满足 Gate 2R 指标门槛 → 如实报告词法上限并停止，不接入生产召回**
- 日期：2026-08-19
- 授权依据：产品所有者裁决——授权 MIV-005B 词法可行性审计（两本地提交、不 push）；不授权直接修改生产召回
- 基线：`ac51480`（MIV-005A 正式 PASS 收口 HEAD），0/0、worktree clean

## 1. 背景与动机

现有证据显示 paraphrase 正确内容与查询没有共享词面 token；纯 BM25 对零重叠文档原则上无法产生有效分数。必须先证明本地词法路线的实际能力上限，避免为追指标偷偷加入同义词表或调坏 MIV-005A 的 >1/6 准入门。

## 2. 决策：探针设计（固定参数、零可调）

| 项 | 决策 |
| --- | --- |
| tokenizer | `memory_engine.conflict.tokenize`（现有冻结 tokenizer：CJK 字符 bigram + 拉丁/数字词，返回集合） |
| BM25 参数 | k1 = 1.2，b = 0.75（裁决固定值） |
| tf | 集合存在性（tokenizer 返回集合 → 出现即 1，不做频率重数） |
| doclen / avgdl | 对象 token 集合大小 / 全部 94 个冻结合成夹具的均值 |
| IDF 语料 | 全部 94 个冻结合成夹具（`tests/fixtures/memory_eval/fixtures.json`，与 case 无关、固定） |
| 假设管道 | 状态 → scope/category → temporal → selector → light → conflict → **纯 BM25 排名（替代 `_match_score` 与 >1/6 准入门）** → Top-limit；T0 零读取短路保持 |
| 排序 tie-break | 沿用生产 `_rank_key`（priority/evidence/updated_at）+ 末位 id（确定性） |
| 禁止 | synonym map、query 特判、embedding、模型下载、网络访问、第三方分词库 |
| 输出纪律 | 只输出 ID 与数值，零记忆正文/秘密泄漏 |

实现：`memory_eval/bm25_probe.py`（仅评测，不接入 `memory_engine/**`）+ `tests/test_bm25_probe.py`（10 项冻结合同测试）。

## 3. 实测结果（111 个冻结 case，探针 replay hash `4e4562f13c6ad35f…`）

### 3.1 假设策略指标 vs Gate 2R 门槛

| 指标（假设策略 = 纯 BM25、无准入门） | 实测 | 门槛 | 判定 |
| --- | ---: | ---: | --- |
| precision_at5_v2（全语料） | **0.71** | ≥ 0.90 | ❌ |
| critical_memory_recall_v2（全语料） | **0.9342** | ≥ 0.95 | ❌ |
| false_recall_rate_v2（全语料） | **0.29** | ≤ 0.02 | ❌ |
| NO MEMORY | **39/41**（nm-002、nm-006 仍会返回对象） | 41/41 | ❌ |
| scope/project/superseded 泄漏 | **0**（hard filters 保留） | 0 | ✅ |
| stale recall | **0.0** | 0 | ✅ |
| **全部门槛** | **未达成（all_thresholds_met = False）** | 全部 | ❌ |

切片（诚实记录词法在「有词面重叠」场景的能力上限）：

| 切片 | precision_at5_v2 | critical_memory_recall_v2 | false_recall_rate_v2 | hit_rate_at5 |
| --- | ---: | ---: | ---: | ---: |
| non_paraphrase（99 例） | 0.9697 | 1.0 | 0.0303 | 1.0 |
| paraphrase（12 例） | 0.2059 | 0.5833 | 0.7941 | 0.5833 |

关键洞察：非 paraphrase 切片接近满分（共享词面 token 时词法路线有效）；**瓶颈完全在 paraphrase 与 NO MEMORY**——0.9342 的 recall 是「无准入门时永远返回 top-k」的假象，代价是 NO MEMORY 39/41 与 false_recall 0.29。

### 3.2 12 个 paraphrase case 的 token overlap / BM25 处境

完全零重叠 **10/12**（裁决前证据「11 个零重叠」实测修正为 10 + ps-016 非 paraphrase 1 例，合计全语料「正确 ID 全部零重叠」11/111）：pp-004 仅共享 1 个 token（bm25 3.0645、rank 4、不进 top5）；pp-011 共享 4 token（bm25 15.3042、rank 1）。零重叠 case 的正确 ID 一律 bm25=0（部分仅靠 tie-break 进入 top-k，非语义命中）。逐例表见《Cross-Memory-System-vNext-2.1-Gate2R-MIV005B-Audit-Report.md》§3。

### 3.3 被 MIV-005A 过滤的 6 个正确 ID（纯 BM25 下的处境）

| case | id | overlap | bm25 | rank | top5 |
| --- | --- | ---: | ---: | ---: | --- |
| ps-007 | mem_fx0c0001 | 0 | 0.0 | 3 | Y |
| ps-007 | mem_fx0c0002 | 0 | 0.0 | 2 | Y |
| ps-007 | mem_fx0c0003 | 1 | 2.824 | 1 | Y |
| ps-016 | mem_fx0c0015 | 0 | 0.0 | 1 | Y |
| cs-008 | mem_fx0f0011 | 1 | 0.2519 | 1 | Y |
| cs-012 | mem_fx0f0011 | 0 | 0.0 | 2 | Y |

6 个中 **4 个零重叠 → bm25=0**（纯词法无法产生有效分数，top5 命中仅来自无准入门时的 top-k 填充与 tie-break）；仅 mem_fx0c0003（ps-007）与 mem_fx0f0011（cs-008）各有 1 个共享 token、rank 1。

### 3.4 nm-002 / nm-006 与 41 个 NO MEMORY

- nm-002：12 个查询 token、1 个候选 positive_bm25、would_return = 是（返回 `mem_fx0d0002`）；
- nm-006：7 个查询 token、1 个候选 positive_bm25、would_return = 是（返回 `mem_fx0a0005`）；
- 其余 39 个 NO MEMORY 例（含 T0 零读取短路的 nm-001/nm-007）：纯 BM25 不返回对象 → 保持正确。
- 即：无准入门时 NO MEMORY 由 41/41 退化为 **39/41**——生产上的正确 NO MEMORY 是 MIV-005A 准入门（score ≤ 1/6 排除）提供的，纯 BM25 排名自身没有「无关=不返回」的判定。

## 4. 结论（裁决分流 = 不达标分支）

**单一固定词法策略（现有 tokenizer + BM25 k1=1.2/b=0.75）无法同时达到 precision_at5_v2 ≥ 0.90、critical_memory_recall_v2 ≥ 0.95、false_recall_rate_v2 ≤ 0.02、NO MEMORY 41/41**：实测 0.71 / 0.9342 / 0.29 / 39-41。词法路线上限 = non_paraphrase 切片 0.9697 precision / 1.0 recall（共享词面时有效），paraphrase 切片 0.2059 / 0.5833 / 0.7941（零重叠不可解）。

因此：

1. **如实报告词法上限并停止，不修改生产代码**（`memory_engine/**`、>1/6 阈值、conflict→admission→limit 顺序零改动）；
2. Reflection 仍不启动；
3. Embedding / 语义路线 ADR 需下一次单独裁决；
4. 不申请生产接入授权。

## 5. 冻结与合规证据

- 原 replay hash `f4266eabd2bed94d…` 与全部冻结指标不变（`python -m memory_eval` 复跑一致）；
- 既有 326 项测试全绿 + 新增 `tests/test_bm25_probe.py` 10 项（探针重放 hash 两次运行完全一致：`4e4562f13c6ad35f3bba604f8638bfd9973c85924c36ea9f89362008a6bad563`）；
- 硬边界零改动：`memory_engine/**`、corpus、fixtures、golden、objects、index、`memory_eval_baseline/**`（v1 基线）、同步层、Clued、协议清单 diff 为空（本轮仅新增 2 文件 + 2 文档 + 状态.md 一行）；
- doctor 三件套 ALL PASS、密钥扫描 0 命中。

## 6. 正式裁决记录（2026-08-19 产品所有者裁决）

> 追加记录；第 1–5 节全部历史内容保持不变。

1. **MIV-005B 词法可行性审计：PASS（正式）**。
2. **本地词法 / BM25 生产接入：NO-GO**——关键结论被接受：
   - 纯 BM25 的高 recall 依赖零分候选进入 top-k，不是真实相关性恢复；
   - 10/12 paraphrase 完全零词面重叠，当前 tokenizer + BM25 无法解决；
   - 去除准入门会使 NO MEMORY 退化为 39/41、false recall 升至 0.29，不可进入生产；
   - 不允许为挽救词法路线加入 query 特判、手工同义词或降低 >1/6 门槛。
3. **Gate 2R 质量目标尚未达到；Reflection 继续阻断**。
4. **后续路线 = Embedding ADR**：本轮不授权实施，不授权模型下载。
5. **生命周期独立工作项（安装/停用/卸载）继续排队，不启动**。
6. 授权纯文档收口提交 `docs: record MIV-005B lexical NO-GO`（本 §6 + 审计报告 §8 + `memory/状态.md` 一行，只追加）与普通 fast-forward push（未推送范围 = `a4c2250` + `da9d550` + 收口提交）；push 后 local HEAD = remote main、0/0；不 tag / release；不启动 Reflection、Embedding 实施、模型下载或安装/停用/卸载工作项。
