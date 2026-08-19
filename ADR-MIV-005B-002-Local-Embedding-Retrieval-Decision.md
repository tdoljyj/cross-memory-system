# ADR-MIV-005B-002：本地 Embedding 检索选型与设计决策（提案，待裁决）

- 状态：**提案（ADR 待裁决）**——本轮仅设计+选型，零实施、零下载、零新增依赖、零生产/测试改动
- 日期：2026-08-19
- 授权依据：产品所有者裁决——授权 Embedding ADR，仅限设计与选型；Reflection 继续阻断；词法/BM25 生产接入 NO-GO
- 基线：`9a6610e`（MIV-005B 收口 HEAD），0/0、worktree clean
- 前置事实（MIV-005B 审计）：纯 BM25 0.71 / 0.9342 / 0.29 / NO MEMORY 39-41；10/12 paraphrase 完全零词面重叠 → 词法路线不可达质量门槛

## 1. 决策问题

是否以及如何引入**本地 Embedding 向量检索**作为第二路相关性信号，在**不破坏 MIV-005A 已接受的合同**（硬过滤先于打分、conflict→admission→limit、单一全局 >1/6 式准入、Trace 零泄漏、冻结评测不变）的前提下，向 Gate 2R 质量门槛（precision_at5_v2 ≥ 0.90、critical_memory_recall_v2 ≥ 0.95、false_recall_rate_v2 ≤ 0.02、NO MEMORY 41/41、泄漏全 0、token P95 ≤ 650）逼近。

## 2. 候选模型选型（依据官方模型卡与许可证）

| 候选 | 官方模型卡 | 许可证 | 维度 | 参数 | 磁盘（fp32） | 语言 | 本地 CPU 内存预估 | revision/哈希策略 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
| **BAAI/bge-m3** | [huggingface.co/BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) | MIT | 1024（稠密；另含稀疏/多向量可选，本方案只用稠密） | ~568M | ~2.27GB | 100+ 语言，中英强 | 推理内存 ~4–5GB；CPU 冷启动与每查询延迟最高 | 官方卡 revision 示例 `2ab44ec5c6ffa948890dcd605b723be45690d220`；最终 revision + 逐文件 SHA-256 在下载授权轮从官方卡抓取并写入 MODEL-MANIFEST |
| **intfloat/multilingual-e5-small**（推荐首选） | [huggingface.co/intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) | MIT | 384 | ~118M | ~470MB（int8 量化 ~235MB） | 94 语言，中英覆盖 | 推理内存 ~1GB；CPU 友好，官方生态有 ONNX 导出 | 同上：下载授权轮从官方卡抓取 revision + 逐文件 SHA-256 |
| **sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2** | [huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) | Apache-2.0 | 384 | ~118M | ~471MB | 50+ 语言，中英覆盖 | 推理内存 ~1GB | 同上 |
| **jinaai/jina-embeddings-v2-base-zh** | [huggingface.co/jinaai/jina-embeddings-v2-base-zh](https://huggingface.co/jinaai/jina-embeddings-v2-base-zh) | **CC-BY-NC-4.0（非商用）** | 768 | 161M | ~1.3GB | 中英双语，8K 上下文 | 推理内存 ~2.6GB | 同上 |

选型结论（D1）：
1. **首选候选 = multilingual-e5-small**：MIT、体积最小、CPU 友好、多语言（适配记忆正文中的 UE/git/Blender/Python 等拉丁词与中文混合）、存在官方 ONNX 生态（如 Xenova/multilingual-e5-small）便于纯 CPU 推理。
2. **质量候选 = bge-m3**：中英检索质量更高、1024 维，但资源占用 4–5 倍；仅当 e5-small 在校准数据上不达标且资源预算允许时启用。
3. **MiniLM L12-v2 为替代备份**（Apache-2.0，与 e5-small 同档位）。
4. **jina-v2-base-zh 因 CC-BY-NC-4.0 列为不建议**：本系统存在「公开版去敏模板」等潜在分享场景，非商用许可证构成合规风险；除非后续单独裁决接受该限制，否则不进入默认候选。
5. **最终模型选择不在本轮锁定**：由下一轮（下载与实施授权轮）的 calibration/holdout 实测决定（D7）；本 ADR 固定候选集、评估方法与验收门槛。

## 3. 约束与设计决策

- **D2 数据源**：Memory Object（`memory/objects/*.json`）仍是唯一事实源；向量索引只是**本地派生缓存** `memory/vector-cache/`（gitignored、可随时删除、可从 objects 全量重建）。任何不一致以 Object 为准。
- **D3 供应链与 Git 纪律**：模型文件（含 ONNX）**绝不提交进 Git**（gitignore + guards 扫描覆盖）；模型下载与供应链校验（官方卡 revision 固定 + 逐文件 SHA-256 核对 + MODEL-MANIFEST 落盘记录）**必须单独授权**，本 ADR 不授权下载。
- **D4 隐私边界**：原始记忆正文**不得上传任何第三方**；云端 Embedding API（OpenAI/Cohere/Voyage 等）**不在本阶段范围**；推理全部本地进行。
- **D5 硬过滤不可绕过**：scope / permission / status / temporal / light 等硬过滤永远先于任何打分（沿用 MIV-005A 合同）；向量召回只能对**硬过滤后的候选集**取分，不得引入独立的未过滤候选通道。
- **D6 拟议管道顺序**（明确，实施轮照此落地）：
  `硬过滤（scope/permission/status/temporal/light）→ 混合打分（词法 `_match_score` 与向量 cosine 的固定加权）→ hybrid ranking → conflict 过滤 → 向量准入（单一全局阈值）→ limit → context packing`
  即 conflict 仍在 admission 之前、admission 仍在 limit 之前（MIV-005A 顺序合同不变）；仅把「打分」从纯词法替换为 hybrid，把准入阈值从词法 >1/6 替换为 hybrid >τ。
- **D7 单一全局准入门**：`hybrid_score > τ`（严格大于，全局唯一），τ 对全部 case/类别/项目一致；**禁止永远返回 top-k、case 特判、按项目调阈值**；等于 τ 必须排除（沿用严格大于语义）。
- **D8 阈值校准方法（预先声明，禁止对 12 个 paraphrase 调参）**：
  1. 111 个冻结 case 按类别**分层随机 60/40 划分 calibration / holdout**（固定随机种子与划分脚本随实施提交入库，划分结果一次性冻结）；
  2. 在 **calibration** 上对 τ 做粗网格扫描（0.05→0.60，步长 0.05，hybrid 权重 α 同样在 {0.0,0.25,0.5,0.75,1.0} 网格内、且 α、τ 全语料唯一）；
  3. 选择满足「NO MEMORY 41/41、false_recall_rate_v2 ≤ 0.02、precision_at5_v2 ≥ 0.90」且 critical recall 最大的 (α, τ)；
  4. 在 **holdout** 上复核同一组门槛（防止过拟合）；
  5. **12 个 paraphrase case 只作为最终验收输入，不参与任何网格选择**；违反本条即终止实施。
- **D9 索引生命周期**：
  - 索引行键 = object_id + 内容 hash + model_version；索引 manifest = {schema_version, model_version, revision, (α,τ), objects 内容哈希集}；
  - supersede / delete / update → 写路径标记对应行 dirty，读路径在增量上限内重算，超过上限触发全量重建；
  - 版本迁移：manifest 任一字段与当前配置不符 → 全量重建（旧缓存原子替换，失败保留旧缓存并回退 D10）；
  - **回滚 = 删除 `memory/vector-cache/` + 关闭 embedding 开关**，完整回到 MIV-005A 路径，无状态残留。
- **D10 失败回退**：模型文件缺失 / 哈希不匹配 / 损坏 / 推理异常 / 索引缺失 → **本次查询整体回退到当前 MIV-005A 路径**（词法 + >1/6），Trace 追加 reason code（只含 ID/数值/版本），**绝不部分混合两路结果**；embedding 开关默认关闭，验收通过前不改变任何默认行为。
- **D11 Trace 纪律**：只记录 memory_id、model_version、revision 前 12 位、hybrid/lexical/cosine 数值与 reason code；**不得输出正文或向量数值**。
- **D12 实施包（未来实施轮，另行授权）**：拟新增 `memory_engine/embedding_adapter.py`（本地推理封装）+ `memory_engine/vector_index.py`（派生缓存）+ `tests/test_embedding_retrieval.py`；运行时依赖（onnxruntime 或 torch，仅本地推理）与模型下载同轮单独授权；CLI/开关 `--embedding=off|on`（默认 off）。
- **D13 资源预算**：磁盘 ≤ 2GB（模型 + 索引）；推理内存 ≤ 2.5GB（e5-small 档）或 ≤ 6GB（bge-m3 档，需单独批准）；冷启动 ≤ 30s；单查询 embedding 推理 P95 ≤ 50ms（本机 CPU）；230 对象级索引全量重建 ≤ 60s；prompt token 预算不变（P95 ≤ 650，向量检索不改变上下文打包内容）。

## 4. 生产门槛与最终验收矩阵（不达标即 NO-GO，无豁免）

| # | 验收项 | 门槛 |
| --- | --- | ---: |
| 1 | precision_at5_v2（全语料） | ≥ 0.90 |
| 2 | critical_memory_recall_v2 | ≥ 0.95 |
| 3 | false_recall_rate_v2 | ≤ 0.02 |
| 4 | NO MEMORY | 41/41 |
| 5 | scope/project/superseded/stale/secret 泄漏 | 全部 0 |
| 6 | token P95 | ≤ 650 |
| 7 | 既有 336 项测试 | 全绿（含原 326 + probe 10） |
| 8 | 原 replay hash `f4266eab…` 与冻结指标 | 不变 |
| 9 | 回退路径（模型缺失/损坏/索引缺失） | 结果与 MIV-005A 路径逐字节一致 + reason code |
| 10 | 索引重建 / 回滚 / 版本迁移 | 幂等、零对象改动、Trace 零泄漏 |
| 11 | 阈值来源审计 | 只能来自预先声明的 calibration/holdout 网格（D8） |

## 5. 决策

本 ADR 为**提案**：批准后下一轮才允许（单独裁决）模型下载 + 供应链校验 + calibration 实测；实施、开关切换与 push 同样需后续单独裁决。本轮不修改任何生产代码、测试合同、corpus、fixtures、golden、objects、index、同步层或 Clued。

## 6. 引用

- [BAAI/bge-m3 官方模型卡](https://huggingface.co/BAAI/bge-m3)（MIT）
- [intfloat/multilingual-e5-small 官方模型卡](https://huggingface.co/intfloat/multilingual-e5-small)（MIT）
- [sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 官方模型卡](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2)（Apache-2.0）
- [jinaai/jina-embeddings-v2-base-zh 官方模型卡](https://huggingface.co/jinaai/jina-embeddings-v2-base-zh)（CC-BY-NC-4.0）
