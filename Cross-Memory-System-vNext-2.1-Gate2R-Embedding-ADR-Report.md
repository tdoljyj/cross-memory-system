# Cross-Memory-System vNext-2.1 Gate 2R Embedding ADR 报告（提案，待裁决）

- 授权：产品所有者裁决——Embedding ADR 仅限设计与选型；本轮零实施、零下载、零依赖、零生产改动
- 基线：`9a6610e`（MIV-005B 收口 HEAD）
- 上游结论：MIV-005B 词法审计 PASS / 生产 NO-GO（纯 BM25 0.71 / 0.9342 / 0.29 / NO MEMORY 39-41）；10/12 paraphrase 完全零词面重叠 → 词法路线不可达质量门槛
- 状态：**ADR 待裁决**

## 1. 候选模型调研（依据官方模型卡与许可证，2026-08-19）

| 候选 | 许可证 | 维度 | 参数 | 磁盘(fp32) | 语言 | CPU 内存预估 | 结论 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| BAAI/bge-m3 | MIT | 1024 | ~568M | ~2.27GB | 100+ 语言 | ~4–5GB | 质量候选（资源占用高） |
| intfloat/multilingual-e5-small | MIT | 384 | ~118M | ~470MB | 94 语言 | ~1GB | **首选候选** |
| paraphrase-multilingual-MiniLM-L12-v2 | Apache-2.0 | 384 | ~118M | ~471MB | 50+ 语言 | ~1GB | 替代备份 |
| jinaai/jina-embeddings-v2-base-zh | CC-BY-NC-4.0 | 768 | 161M | ~1.3GB | 中英 8K | ~2.6GB | 不建议（非商用许可证风险） |

- 官方卡链接：[bge-m3](https://huggingface.co/BAAI/bge-m3) · [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) · [MiniLM-L12-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) · [jina-v2-base-zh](https://huggingface.co/jinaai/jina-embeddings-v2-base-zh)
- revision 与逐文件 SHA-256：在**下载授权轮**从官方模型卡抓取并写入 MODEL-MANIFEST（bge-m3 官方卡 revision 示例 `2ab44ec5c6ffa948890dcd605b723be45690d220`）；任何与官方卡不符 → 中止下载。本报告不预先固化哈希（下载被本轮禁令禁止，预先固化未经核对的哈希反而构成虚假供应链证据）。

## 2. 架构设计要点（决策详情见 ADR-MIV-005B-002）

1. **事实源不变**：Memory Object 仍是唯一事实源；向量索引 = 本地派生缓存 `memory/vector-cache/`（gitignored、可删除、可重建）。
2. **模型不入 Git、不上传第三方**：模型文件 gitignored + guards 扫描；云端 Embedding API 排除；推理全本地。
3. **硬过滤不可绕过**：scope/permission/status/temporal/light 先于一切打分；向量只对硬过滤后的候选集取分。
4. **拟议顺序**：硬过滤 → hybrid 打分（词法 + cosine 固定加权）→ hybrid ranking → conflict → 向量准入（单一全局 >τ）→ limit → context packing（conflict→admission→limit 相对顺序与 MIV-005A 一致）。
5. **单一全局准入门**：hybrid_score > τ（严格大于、全语料唯一）；禁止永远返回 top-k / case 特判 / 按项目调阈值。
6. **阈值校准（预先声明）**：111 冻结 case 按类别分层 60/40 划分 calibration/holdout（固定种子）；calibration 上 (α∈{0,0.25,0.5,0.75,1.0} × τ∈0.05..0.60) 网格选择满足「NO MEMORY 41/41、false_recall ≤0.02、precision ≥0.90」且 recall 最大的组合；holdout 复核同门槛；**12 个 paraphrase 只作最终验收输入，禁止参与网格选择**。
7. **索引生命周期**：行键 = object_id + 内容 hash + model_version；supersede/delete/update → dirty 标记 → 增量重算/全量重建；manifest 版本迁移不匹配 → 全量重建；回滚 = 删缓存 + 关开关，完整回到 MIV-005A 路径。
8. **失败回退**：模型缺失/损坏/推理异常/索引缺失 → 本次查询整体回退 MIV-005A 词法+>1/6 路径 + reason code；绝不部分混合结果；开关默认 off。
9. **Trace**：只记录 ID、model_version、revision 前 12 位、数值与 reason code，零正文/向量泄漏。
10. **实施包**：`memory_engine/embedding_adapter.py` + `memory_engine/vector_index.py` + 测试（未来实施轮另行授权依赖与下载）。

## 3. 资源预算

磁盘 ≤ 2GB；推理内存 ≤ 2.5GB（e5-small 档）/ ≤ 6GB（bge-m3 档，需单独批准）；冷启动 ≤ 30s；单查询 embedding P95 ≤ 50ms；230 对象索引重建 ≤ 60s；prompt token 预算不变（P95 ≤ 650）。

## 4. 生产门槛（最终验收矩阵）

precision_at5_v2 ≥ 0.90；critical_memory_recall_v2 ≥ 0.95；false_recall_rate_v2 ≤ 0.02；NO MEMORY 41/41；scope/project/superseded/stale/secret 泄漏全 0；token P95 ≤ 650；既有 336 项全绿；原 replay hash `f4266eab…` 与冻结指标不变；回退路径逐字节一致；索引重建/回滚/迁移幂等且零对象改动；阈值来源仅限预先声明的 calibration/holdout 网格。

## 5. 风险登记

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 许可证不合规（jina CC-BY-NC） | 高 | 默认排除；仅 MIT/Apache-2.0 候选 |
| 供应链被篡改 | 高 | 官方卡 revision 固定 + 逐文件 SHA-256 + MODEL-MANIFEST + 下载单独授权 |
| 阈值对 paraphrase 过拟合 | 高 | 分层 holdout 复核；12 例禁入网格选择；网格与种子预先声明 |
| CPU 延迟超预算 | 中 | e5-small 首选 + int8 量化 + P95≤50ms 预算 + 超限回退词法 |
| 回退路径不一致 | 中 | 整体回退（禁混合结果）+ 逐字节等价测试 |
| 向量缓存与 Object 漂移 | 中 | 内容 hash 行键 + manifest 版本迁移 + 全量重建 + Object 优先 |

## 6. 本轮证据（待裁决前实测）

- 基线 `9a6610e`，工作克隆 0/0、clean；本轮仅新增本报告 + ADR-MIV-005B-002 + 状态.md 一行
- 既有 336 项全绿；原 replay hash `f4266eabd2bed94d…` 与全部冻结指标不变；doctor 三件套 ALL PASS；密钥扫描 0 命中；本地 ahead/behind = 1/0；未 push / tag / release

**状态：ADR 待裁决。**
