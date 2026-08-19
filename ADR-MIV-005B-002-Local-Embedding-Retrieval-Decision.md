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
- [jinaai/jina-embeddings-v2-base-zh 官方模型卡](https://huggingface.co/jinaai/jina-embeddings-v2-base-zh)（**勘误：官方卡现标注 Apache-2.0，见 §7 R1.1**）

## 7. R1 硬化修订（2026-08-19 产品所有者裁决：方向接受、正式 PASS 暂缓、一次纯文档 R1）

> 本节为 §1–6 的**硬化修订与勘误**：R1.1/R1.2/R1.3/R1.5 对 §2 相应行作出纠正与取代，其余为冻结补充合同。§1–6 原始文本保留（历史提案记录）；以本节为准。

### R1.1 Jina 许可证勘误与排除理由修正

- **勘误**：§2 将 jina-embeddings-v2-base-zh 标为 CC-BY-NC-4.0 有误——[官方模型卡](https://huggingface.co/jinaai/jina-embeddings-v2-base-zh)当前标注 **Apache-2.0**；且官方示例要求 `trust_remote_code=True`（执行模型库自带远程自定义代码）。
- **修正后的排除/降级理由**（不再以「非商用许可证」为由）：
  1. **供应链风险**：`trust_remote_code=True` 意味着运行未经本仓库审计的远程自定义 Python 代码，违反 D3/D10 的供应链与回退纪律，需要额外的独立代码审计才可放行；
  2. **资源占用**：161M 参数 / 768 维 / fp32 权重 ~1.3GB + 推理内存 ~2.6GB，处于预算上限边缘且无量化官方变体；
  3. 双语（中/英）覆盖与 e5-small 的 94 语言相比无额外收益。
- 处置：降级为 **D 级备选**（仅当首选/质量候选均不达标且完成远程代码审计后才可启用，需单独裁决）。

### R1.2 E5 定位与冻结运行合同

- **定位修正**：multilingual-e5-small 只能裁决为「**首轮基准候选**」，不得提前成为生产选型；最终选型由下载授权轮的 calibration/holdout 实测（R1.6）决定。
- **冻结运行合同（以下载实施轮照此落地，偏差即中止）**：
  1. 输入前缀：检索查询加 `query: ` 前缀、入库正文加 `passage: ` 前缀（官方卡要求）；
  2. pooling：attention-mask **mean pooling**（非 CLS、非 max）；
  3. 归一化：pooled 向量做 **L2 normalization**；
  4. 相似度：**cosine**（归一化后即内积，结果一致）；
  5. 精度：**float32 基线**（int8 量化需单独 manifest + 单独裁决，且必须与 fp32 基线校准等价性）；
  6. 最大长度：**512 token**（超出截断，官方卡默认）；
  7. backend 与版本：sentence-transformers 或 onnxruntime 二选一，**具体包版本与 ONNX opset 在下载授权轮冻结进 MODEL-MANIFEST**；
  8. **trust_remote_code=False**（本候选官方卡无需远程代码；任何需要该开关的候选按 R1.1 同等供应链审计处理）。

### R1.3 磁盘口径修正（权重 vs 完整仓库树）与下载白名单

- E5 的单个 `model.safetensors` ≈ 471MB，但官方文件树同时含 pytorch / onnx / tensorflow 等多格式重复副本，**完整树明显大于 471MB**。
- 下载阶段**必须使用文件白名单**，禁止无选择 `snapshot_download` 全仓：
  - pytorch 后端白名单：`config.json`、`tokenizer.json`、`tokenizer_config.json`、`special_tokens_map.json`、`vocab.txt`（如存在）、`model.safetensors`；
  - onnx 后端白名单：`onnx/model.onnx`（或等价导出物）+ tokenizer 文件集；
  - 白名单外文件一律不下载；实测全口径在下载授权轮记录进 MODEL-MANIFEST（预计 pytorch ≈0.5GB、onnx ≈0.25GB，以实测为准）。

### R1.4 准入公式与管道顺序（向量 = MIV-005A 的增量 OR 路径）

- **准入（取代 D7 的「替换式准入」表述）**：
  `admit(o, q) = MIV_005A_admit(o, q) OR cosine(o, q) > τ`
  其中 `MIV_005A_admit` = 显式 tags/entities selector 命中 OR 词法 score > 1/6（**生产合同逐字不变**）；`cosine > τ` 为**新增的增量放行路径**（严格大于，等于 τ 排除）。
- **固定管道顺序（取代 D6 措辞，语义对齐 MIV-005A）**：
  `硬过滤（scope/permission/status/temporal/light）→ 打分（词法 + cosine）→ conflict → 准入（上述 OR 公式）→ 确定性排序 → limit`
- 两条不变量：
  1. **向量不得复活 CONFLICT_LOSER**：conflict 过滤在准入之前，输家在准入阶段不可见；
  2. **向量不得淘汰词法通过对象**：只要 MIV_005A_admit 为真即准入，其 cosine 分数再低也不影响准入（只影响排序位置）。
- hybrid 分数**只用于准入后的排序**，不参与准入判定。

### R1.5 bge-m3 预算越界处置

- bge-m3 fp32 权重 ≈ 2.27GB 已**超过磁盘预算 ≤2GB**，只能保留为**越界对照候选**；除非未来另立量化变体（如 int8）与**独立 MODEL-MANIFEST + 独立裁决**，否则不得进入下载/实施轮。

### R1.6 calibration / holdout 冻结（具体 case ID、种子、有限网格）

- **家族规则**：同一 expected_relevant_ids 或 forbidden_ids 成员相连的 case 属于同一「场景族」（union-find over expected/forbidden IDs）；**同族绝不跨 calibration/holdout**。
- **参数选择排除集**：12 个 paraphrase case 与已知 6 个被过滤正确 ID 所在 case（ps-007、ps-016、cs-008、cs-012）**完全排除于参数选择**，全部进入 holdout 仅作最终验收（其家族成员一并进入 holdout）。
- **划分算法（可复现）**：种子 `20260819`；对剩余家族以 `random.Random(20260819)` 洗牌后按家族完整性贪心填充 calibration 至剩余 case 数的 60%（四舍五入）；实际冻结为 **calibration 53 / holdout 58**。
- **冻结 case ID 列表**：
  - calibration（53）：`cs-001 cs-002 cs-003 cs-005 cs-006 cs-009 cs-010 cs-011 ep-002 ep-007 ep-009 ep-011 ep-012 ep-013 ep-015 io-002 io-003 io-010 io-011 io-012 io-014 io-015 io-016 nm-001 nm-003 nm-004 nm-005 nm-006 nm-007 nm-008 nm-009 nm-012 nm-013 nm-015 ps-004 ps-006 ps-008 sa-003 sa-004 sa-005 sa-006 sa-007 sa-009 sa-010 sa-011 sa-012 tp-001 tp-003 tp-006 tp-010 tp-011 tp-012 tp-013`
  - holdout（58）：`cs-004 cs-007 cs-008 cs-012 ep-001 ep-003 ep-004 ep-005 ep-006 ep-008 ep-010 ep-014 io-001 io-004 io-005 io-006 io-007 io-008 io-009 io-013 nm-002 nm-010 nm-011 nm-014 pp-001 pp-002 pp-003 pp-004 pp-005 pp-006 pp-007 pp-008 pp-009 pp-010 pp-011 pp-012 ps-001 ps-002 ps-003 ps-005 ps-007 ps-009 ps-010 ps-011 ps-012 ps-013 ps-014 ps-015 ps-016 sa-001 sa-002 sa-008 tp-002 tp-004 tp-005 tp-007 tp-008 tp-009`
- **有限 (α, τ) 网格**：α ∈ {0.0, 0.25, 0.5, 0.75, 1.0}，τ ∈ {0.05, 0.10, …, 0.60}（12 档）→ 共 60 个组合；只在 calibration 上选择满足「NO MEMORY 41/41、false_recall_rate_v2 ≤ 0.02、precision_at5_v2 ≥ 0.90」且 critical recall 最大的组合，holdout 复核同门槛；**12 个 paraphrase 与 6 个被过滤 ID 禁入任何选择步骤**。

### R1.7 hybrid 公式与数值纪律（只影响排序）

- `hybrid(o,q) = α · lex_norm(s) + (1−α) · max(0, cosine(o,q))`
  - `lex_norm(s) = s / (s + 1)`（单调压缩到 [0,1)，不依赖任何全局统计，保证可重放）；
  - `cosine` 负值截断为 0；
  - 比较一律**严格大于**；相等按 tie-break。
- tie-break（确定性，全部字段参与）：`(hybrid 降序, priority 权重降序, evidence 权重降序, updated_at 降序, object_id 升序)`。
- 舍入纪律：计算全程使用原始浮点值；**仅在报告层**做 round-half-up 到 4 位小数（与 metrics.py v2 一致）。

### R1.8 向量缓存移出 canonical memory/ 树

- 默认目录改为 **`~/.dsh/vector-cache/cross-memory-system/`**（仓库外），可经 `sync.config.json` 的 `vector_cache_dir` 覆盖；canonical `memory/` 树内不落任何向量文件。
- 声明：缓存**不同步**（sync-memory 白名单外）、**不备份**、**不入 Git**（gitignore + guards 扫描）；目录权限 0700 / 文件 0600（Windows 用等效 ACL）；**未来安装/停用/卸载独立工作项必须包含该目录的清理责任**（写进该工作项的验收清单，本 ADR 不实施）。

### R1.9 索引构建排除（防「召回时过滤但缓存已泄漏」）

- 构建阶段排除：scope=temporary 与会话临时对象、status ∈ {rejected, denied, invalid} 的对象、内容命中 guards 秘密样值的对象、T0/T4 语义下不可见的对象；构建集合 = 召回可见集合（RECALLABLE ∪ HISTORY）∩ 排除项补集。
- T0 / T4 / temporary 查询**永不触发**向量推理或缓存读写。

### R1.10 下载合同（固定 revision、白名单、离线、原子 manifest）

- 固定官方卡 revision + **逐文件 SHA-256**（下载授权轮从官方卡抓取并写入 MODEL-MANIFEST）；仅下载 R1.3 白名单文件；
- 推理**完全离线**（禁运行时网络访问，含无网络环境验收测试）；
- manifest 校验为**原子写**（临时文件 + rename），任何哈希不匹配 → 中止加载、删除本次下载物、整体回退 D10（MIV-005A 路径）。

### R1.11 资源预算（参考硬件与全口径）

- 参考硬件：当前 TURING 机（Windows x64、CPU-only、≥16GB RAM）为唯一首轮验收硬件；
- batch：查询 batch=1；索引构建 batch=32；
- 冷启动（进程内首次加载模型+索引）≤ 30s；热路径单查询 embedding 推理 P95 ≤ 50ms；230 对象全量索引重建 ≤ 60s；
- 磁盘全口径（白名单口径，实测写入 manifest）：E5 pytorch ≈0.5GB + 索引 <10MB（384×4B×230≈0.35MB + 元数据）≤ 2GB 预算内；bge-m3 ≈2.3GB 越界（R1.5）。

### R1.12 最终验收矩阵（补充 paraphrase 底线）

在原 §4 矩阵基础上增加/冻结：

| # | 验收项 | 门槛 |
| --- | --- | ---: |
| 12 | **paraphrase golden 命中** | **≥ 11/12**（holdout 内验收；参数选择全程不接触） |
| 13 | 阈值来源审计 | 仅允许 R1.6 冻结的 60 组合网格 + calibration/holdout 流程 |

其余门槛不变：precision_at5_v2 ≥ 0.90、critical_memory_recall_v2 ≥ 0.95、false_recall_rate_v2 ≤ 0.02、NO MEMORY 41/41、泄漏全 0、token P95 ≤ 650、既有 336 项零回归、原 replay hash `f4266eab…` 与冻结指标不变、回退路径逐字节一致、索引重建/回滚/迁移幂等且 Trace 零泄漏。

### R1.13 本轮纪律

本轮为纯文档 R1：不修改任何生产代码、测试合同、corpus、fixtures、golden、objects、index、同步层或 Clued；不下载模型、不安装依赖、不生成向量索引、不 push / tag / release；不启动 Reflection 或生命周期工作项。`7c3617f` 提案基线保留、不改写。

## 8. 正式裁决记录（2026-08-19 产品所有者裁决）

> 追加记录；§1–7 全部历史内容保持不变。

1. **ADR-MIV-005B-002 R1：接受，正式 PASS**。接受提交 = `a5a3e5c`（本地、未 push）；原提案提交 `7c3617f` 保留、不得改写。
2. **PASS 范围界定（裁决原文要点）**：Embedding ADR 正式 PASS **仅表示设计与实施合同获接受**；**不等于 E5 生产选型**（E5 仍只是「首轮基准候选」）；**不授权**模型下载、依赖安装、探针、索引构建、Embedding 实施或 Reflection。
3. R1 已关闭的阻断项确认：Jina 官方卡确为 Apache-2.0 且示例要求 `trust_remote_code=True`（供应链风险降级成立）；E5 前缀 / attention-mask pooling / L2 归一化合同与官方说明一致；增量 OR 准入、conflict 不可复活、确定性排序、calibration/holdout 隔离、缓存移出 canonical 树、索引前排密、下载白名单与最终验收合同均已冻结；Protocol Deviations 为空，未越过纯文档授权边界。
4. **下一核心优先级 = Truth Integrity Gate T0**（后续单独裁决）。
5. push / tag / release 均不授权；本收口提交（`docs: record formal local embedding ADR PASS`）仅追加本节 + 报告 §8 + `memory/状态.md` 一行，不删除、不改写历史。
