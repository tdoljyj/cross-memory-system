# R4 Gate 0 · E5-base 实施轮报告（供应链 / oracle v3 / 768 维索引 / 35-grid calibration）

> 阶段：E5-base 实施轮（授权执行轮：下载 / 索引构建 / oracle v3 实现 / calibration）
> 授权来源：产品所有者裁决 2026-08-21（M0-R3 正式 PASS，df15e1e 与 4e6cca1 接受；
> 授权启动 E5-base 实施轮，范围照录于 §0）
> 权威证据：r4-gate0-nogo @ `5c6aa1f95672ec588b24785e1dfd66a69b024dca`
> origin/main @ `8c22c238144225335c08ad8ebbf63ac890f87b55`（16/2，未动）
> 本轮工作基线：r4-gate0-m0-r2 @ `4e6cca120c7f57d0f1fa1d29002a87922e22facb`（M0-R3 提交）

---

## 0. 授权范围（照录裁决要点）

允许：六文件白名单下载（固定 revision，逐文件校验大小与 SHA-256，禁止替换
revision 或增加文件）；trust_remote_code=False / 固定 backend / 完全离线加载；
独立实现 oracle v3（只消费冻结夹具与 frozen hard-filter contract，禁止调用或
复制 Runtime 过滤实现）；仓库外、不同步、可删除、可完整重建的 768 维 float32
派生索引；53-case calibration（冻结 35-grid、一次主运行、一次确定性复验）；
CONFLICT_LOSER 永不复活；任何 digest / Runtime Trace / canonical Trace 不一致
立即 FAIL；35 组合 0 qualifying → 本合同下 NO-GO（不扩网格、不重试）。

禁止（全程遵守）：读取/运行 58-case holdout、查看 pp-001~012、Gate 0-F、
修改真实 Binding、启用 semantic mode（生产）、push/tag/release、rebase/merge
任一 main、修改网格/门槛/fixture/expected/冻结合同。

---

## 1. 供应链：六文件白名单下载与逐文件校验

模型目录（仓库外）：`~/.workbuddy/vector-cache/cross-memory-system/models/
d128750597153bb5987e10b1c3493a34e5a4502a/`，全部经固定 revision resolve 端点
下载（`main` 仅用于确认当前指向，实测 sha = d128750…，一致）。

| 文件 | size | SHA-256 实测 vs 锁 | 结论 |
|------|------|--------------------|------|
| config.json | 694 | `9dab198f…31bac4` 一致 | OK |
| tokenizer.json | 17082660 | `62c24cdc…b75626` 一致（tree API lfs.oid 同） | OK |
| tokenizer_config.json | 418 | 实测 `efb5c0d0…997cd3fe833216da15` vs 锁 `…996cd3f…` | **见 §1.1** |
| special_tokens_map.json | 280 | `06e405a3…18067f` 一致 | OK |
| sentencepiece.bpe.model | 5069051 | `cfc8146a…db2865` 一致（tree API lfs.oid 同） | OK |
| model.safetensors | 1112201288 | `a18a44fa…de09a7` 一致（tree API lfs.oid 同） | OK |

whitelist_total_bytes = 1134354391 实测一致；无白名单外文件下载。

### 1.1 发现（非静默披露）：tokenizer_config.json 锁记录单字符笔误

候选锁（@4e6cca1）记录的 tokenizer_config.json SHA-256 第 49 位 hex 与固定
revision 权威字节不符（锁 `…37597d996cd3f…` vs 实测 `…37597d997cd3f…`）。

权威性证据链（本轮实测）：

1. 同一固定 revision 两次独立下载，字节完全一致（哈希稳定）
2. 下载字节的 git blob SHA-1 = `6de1940d16d38be9877bf7cc228c9377841b311f`，
   与 HF 仓库该 revision 的 paths-info API oid **精确一致**（git 内容寻址，
   排除下载损坏 / CDN 污染 / revision 漂移的一切可能）
3. 其余 5 文件锁值全部精确一致；三个大文件的官方 Xet/LFS 元数据（tree API
   lfs.oid）亦全部一致
4. size（418）与锁一致；文件内容为标准 XLMRobertaTokenizer 配置 JSON

定性：**锁记录抄写笔误**（M0-R1/R2 复验记录只比对了前缀 `efb5c0d0…`，
完整 64 位从未被逐字符比对过）。供应链本身无恙。

处置：锁文件与锁内 digest **一字未动**（遵守"不得静默修改锁文件和 digest"）；
本轮 manifest（MODEL-MANIFEST.json，模型目录内仓库外派生物）按实测权威值
构建，并在 manifest 的 `lock_discrepancy` 字段逐字段记录该差异与证据。
**该差异提交产品所有者裁决**：接受实测值并授权勘误（修锁），或维持锁原文
（则本轮供应链校验按字面为 5/6 一致 + 1 项已定性笔误披露）。本轮 calibration
的全部结果不受影响（模型字节权威性独立于锁记录笔误成立）。

---

## 2. Backend 环境（锁逐项复现）

本机全新 venv（`C:\Users\17531\vg0b`，仓库外）：

| 锁项 | 锁记录 | 实测 | 结论 |
|------|--------|------|------|
| python | 3.13.14 (Windows AMD64) | 3.13.14 (MSC v.1944 64 bit AMD64) | 一致 |
| torch | 2.13.0+cpu | 2.13.0+cpu | 一致 |
| transformers | 5.15.1 | 5.15.1 | 一致 |
| tokenizers | 0.22.2 | 0.22.2 | 一致 |
| safetensors | 0.8.0 | 0.8.0 | 一致 |
| huggingface_hub | 1.28.0 | 1.28.0 | 一致 |
| numpy | 2.5.2 | 2.5.2 | 一致 |

requirements-gate0b.lock.txt（SHA-256 = `e0355a34…db155c6`，实测与锁一致）
35 项全部按精确版本安装。加载参数：`trust_remote_code=False` +
`local_files_only=True`，加载前经 MODEL-MANIFEST 完整 fail-closed 校验
（schema / canonical self-hash / 模型 ID / 固定 revision / 合同字段 / backend
packages / 六文件白名单 size+SHA-256 / 额外文件拒绝），hidden_size 严格
核验 = 768。

---

## 3. Canonical Oracle v3 实现

- 位置：`memory_eval/e5_base/oracle_v3.py`（新增文件；SHA-256 =
  `3163ab4ff3d589f1968a0c1bdb55e939ca78a3a042f439b5d37151e34068df`）
- 输入：冻结夹具元数据（`__FAKE_TOKEN__` → `ghp_`+A×24 物化替换后）+
  frozen-hard-filter-contract.json 本体（SHA-256 实测 =
  `1785469cafa4660bdc6f06e531b93fab6e87f14b7ba6dfe4ea09d884626b3881`，
  与锁一致，构造时强制校验）
- 实现：P1–P8 前置条件 → A1–A6 → B1–B7 first-hit-wins 判定链；词表与
  secret_patterns 从合同 vocabularies 读取；A2 双 code（scope code 在前）；
  B3 按合同 predicate 文本完整转写（不调用 memory_engine.schema）；
  B7 = json.dumps(ensure_ascii=False) 全对象序列化 × 五模式 re.search
- **独立性**：零 import memory_engine（全文件唯一非标准库依赖为空）；
  与被测路径（memory_engine.recall，经 gate0_calibration._recall 调用）
  为两套独立代码
- 判定链自检（实施前独立通过）：secret → SECRET_DETECTED；T0 短路零评估；
  T3 light → PRIORITY_FILTERED + limit=min(3)；global 模式下 session 对象 →
  SCOPE_MISMATCH

---

## 4. 768 维派生索引（仓库外 / 可删除 / 可完整重建）

- 位置：`~/.workbuddy/vector-cache/cross-memory-system/indexes/e5-base-eval/`
  （仓库外，validate 双向包含检查通过；不入 git，不同步）
- 内容：`vectors.f32`（28 对象 × 768 维 × float32 = 86016 bytes）+
  `object_ids.json` + receipt 内嵌指纹
- 准入口径：预嵌入硬过滤（B1–B7，与 Gate 0-C 索引构建语义一致）；
  53-case 去重 fixture 45 个，28 个通过（与 E5-small 轮 passage count =
  28 完全同口径；25 个去重 query 同口径）
- 指纹：vectors.f32 SHA-256 = `dde75de23c343aeded684f99adfaf767bb3003c3b
  23e2d27b59aa718b0f65f79`；主运行与复验**逐字节一致**（同 digest）
- 磁盘口径：86016 bytes < 锁预算 715776 bytes（预算按全语料 233 对象上限
  预冻结，calibration bundle 实际 28 对象，在预算内）；模型 + 索引合计
  ~1.057 GiB，符合 budget_limit 2 GiB

---

## 5. Calibration 主运行（53-case × 35-grid × 一次）

- 被测路径：`memory_engine.recall(..., semantic_mode="test", alpha, tau)`
  （runner 复用 E5-small 轮 `gate0_calibration.py`，其 SHA-256 =
  `0dd8e8b3f39f2209cca75410e9b5e712bde8de8c0a6abf8f3e7fad677a61c1ed`，
  与 Gate 0-E receipt 记录逐字节一致 = 未被修改）
- 网格：候选锁冻结 35 组合（tau {0.60..0.90}×7 × alpha {0.0..1.0}×5），
  runner 读取锁值并与代码内冻结期望双校验，一致
- 评分口径：**eligible_expected = frozen_expected ∩ canonical_survivors**
  （oracle v3）；53 case 中唯一被 oracle 排除的 expected 对象 = sa-004 的
  `mem_fx0h0003`（独立判定 SECRET_DETECTED，oracle v3 spec §5 预期行为）

### 5.1 Trace 一致性（强制 FAIL 语义，全部通过）

| 校验项 | 结果 |
|--------|------|
| canonical oracle Trace vs Runtime 硬过滤 Trace（逐 case × 逐 fixture × 35 grid 点） | **mismatch = 0** |
| Runtime 硬过滤 Trace 跨 35 grid 点一致性 | 一致（alpha/tau 不影响硬过滤） |
| CONFLICT_LOSER 被向量路径复活 | **0 次**（显式检查 + FORBIDDEN_LEAKAGE 双保险） |
| 证据泄漏扫描（synthetic secret 样值） | 0 命中 |
| holdout detail reads | 0 |

oracle 结果 digest（canonical JSON SHA-256）=
`8e8e2622ee5f930f92861c6dba2ac1fe7f9e78a18fce57490d4af02ffc145564`。

### 5.2 硬门槛结果（ADR-MIV-005B-002 §4 逐字口径，零放宽）

**Result: PASS — 35 组合中 10 个 qualifying。**

冻结选择（selection key 与 E5-small 轮一致）：**alpha = 1.00，tau = 0.90**

| 门槛 | 要求 | 实测 | 判定 |
|------|------|------|------|
| precision_at5_v2 | ≥ 0.90 | 1.0（29/29） | PASS |
| critical_memory_recall_v2 | ≥ 0.95 | 1.0（29/29，eligible 口径） | PASS |
| false_recall_rate_v2 | ≤ 0.02 | 0.0（0/29） | PASS |
| NO MEMORY | 全对 | 26/26 | PASS |
| forbidden leakage（scope/project/superseded/stale/secret） | 0 | 0 | PASS |
| engine error | 0 | 0 | PASS |
| lexical expected preservation | = 1.0 | 1.0（29/29） | PASS |
| prompt token P95 | ≤ 650 | 45 | PASS |

网格结构（决策边界）：tau ≤ 0.80 的全部 25 组合因
`FALSE_RECALL_GT_0_02 + NO_MEMORY_NOT_ALL_CORRECT` 淘汰（E5-base cosine
集中带使低门槛向无关对象开放 VECTOR_ADMIT）；tau ∈ {0.85, 0.90} 的全部
10 组合 qualifying，alpha 不影响资格（词法排序主导，向量仅作准入门）。

关键 case 行为：sa-004 的 secret 对象经 oracle 独立排除后该 case 首次可满足
（E5-small 轮该 case 为 LEXICAL_BASELINE_EXPECTED_LOST 的直接根因）；
nm-006 的 `mem_fx0a0005` 在 tau=0.90 下不被 VECTOR_ADMIT，NO MEMORY 正确保持
（E5-small 轮 tau=0.60 时被错误召回的直接对照）。

### 5.3 与 E5-small NO-GO 的关系

E5-small（60-grid）在全部组合 0 qualifying 下 NO-GO；E5-base（35-grid，
高区间网格 + oracle v3 eligible 口径）10/35 qualifying 且全部硬门槛达标。
两个结论互不覆盖：E5-small 的 NO-GO 属其自身 60 组合合同；E5-base 的 PASS
属本 35 组合合同。**均不构成模型级外推。**

---

## 6. 确定性复验

独立重跑一次完整 calibration（新进程、同模型、同锁、同离线环境）：

- 35-grid 原始结果、逐 case returned/eligible/forbidden/reason codes、
  8 项指标、qualifying 集合、winner、oracle 结果 digest、模型 manifest
  digest、向量表 digest（`2fe408db…39d54c55`）、vectors.f32 文件 SHA-256
  **全部一致**
- 比对剥离：latency_ms / grid_elapsed_seconds / index_dir /
  rebuild_command / run_label（延迟与运行参数不纳入确定性比较，
  E5-small 轮同口径）
- 比对器：`memory_eval/e5_base/calibration.py::compare_receipts`
  （22 个确定性字段域）；证据：
  `evidence/e5-base-calibration-replay-verification.json`
  （`deterministic_replay_ok: true`，mismatched_fields = []）

---

## 7. Digest 清单（本轮实测）

| 项 | SHA-256 |
|----|---------|
| frozen-hard-filter-contract.json（锁校验通过） | `1785469cafa4660bdc6f06e531b93fab6e87f14b7ba6dfe4ea09d884626b3881` |
| oracle-v3-spec.md（锁校验通过） | `11ce893465f4a25f0f3d2e3fd933b643713fcb90acbeec69de978132164ab83f` |
| frozen-eval-manifest.json（锁校验通过，零内容解析） | `c7a195e1e21a476ac949723d65dc8f8594f3931b999974db68561a2838b32ac1` |
| requirements-gate0b.lock.txt（锁校验通过） | `e0355a341138fb90abeb0826fdeef0acfeba4eb2dea2c4d673ed127c2db155c6` |
| e5-base-candidate-lock.json（未修改） | `9ee354192a4fbe42a15c2a84874548d83e5c92b233f4bfb6f56c724afc644814` |
| MODEL-MANIFEST.json（模型目录，仓库外） | `c5e145a140d851cb72905c2a5b7ed9f052c45084a0a07e3476cfa516f1607b5e` |
| oracle 判定结果（canonical JSON） | `8e8e2622ee5f930f92861c6dba2ac1fe7f9e78a18fce57490d4af02ffc145564` |
| calibration 向量表（内存表 digest） | `2fe408db68586809c673771635398659aebeb4b0c567d3256eed931e39d54c55` |
| vectors.f32（落盘索引） | `dde75de23c343aeded684f99adfaf767bb3003c3b23e2d27b59aa718b0f65f79` |
| oracle_v3.py | `3163ab4ff3d589f1968a0c1bdb55e939ca78a3a042f439b5d37151e34068df` |
| embedder.py | `ef186eef2e07d930a36b29efbda5a47dba0722820e2b16751649cabbbe131b20` |
| calibration.py | `bac9c6f2f77f758975f389f12e98b0f355500d474197ba405a7d73cd26f7978f` |
| gate0_calibration.py（复用，未修改） | `0dd8e8b3f39f2209cca75410e9b5e712bde8de8c0a6abf8f3e7fad677a61c1ed` |

零修改验证：`git diff 4e6cca1 -- memory_engine/ guards.json tests/ <既有
memory_eval 文件>` = 空。本轮只新增 `memory_eval/e5_base/`（3 文件）与
`docs/r4-gate0/` 证据文档。

---

## 8. 禁令遵守声明

- 58-case holdout：零读取、零运行、零内容解析（仅对 frozen-eval-manifest
  做字节级哈希校验；holdout_detail_reads = 0）
- pp-001~012：未查看（全部密封于 holdout，本轮无任何访问路径）
- Gate 0-F：未运行（calibration 全门槛 PASS 是申请前提，申请另行裁决）
- 真实 Binding：未修改（semantic_mode 仅以 "test" 参数进入被测路径，
  生产配置零触碰）
- push / tag / release：未执行（本轮全部产出为本地提交）
- rebase / merge 任一 main（local ffba74b / origin 8c22c238）：未执行
- 网格 / 门槛 / fixture / expected / 冻结合同：零修改（35-grid 从锁读取并
  双校验；8 项硬门槛逐字复用 E5-small 轮 checks）

---

## 9. 结论与停止点

1. E5-base 供应链六文件按固定 revision 下载完成：5/6 逐字节精确一致，
   tokenizer_config.json 存在**锁记录单字符笔误**（已由 git blob 内容寻址
   定性，字节权威性成立，差异完整披露于 §1.1，待产品所有者裁决修锁与否）
2. canonical oracle v3 已独立实现并以零 import memory_engine 的独立性
   运行：53 case × 全部夹具 × 35 grid 点的 Runtime Trace 比对
   **mismatch = 0**，自证循环正式消除于实施层
3. 768 维 float32 派生索引建立于仓库外（可删除、可完整重建），主/复验
   字节级一致
4. **53-case calibration 主运行 + 确定性复验全部完成：Result = PASS，
   10/35 qualifying，冻结选择 alpha=1.00 / tau=0.90，八项硬门槛全绿**
5. 遗留裁决点：①tokenizer_config.json 锁笔误的勘误授权（§1.1）；
   ②Gate 0-F / 58-case holdout 运行授权（须在本轮 PASS 基础上另行申请）
6. **E5-base 实施轮到此停止。** 不申请解释权、不扩网格、不动 holdout；
   后续任何一步均待产品所有者裁决

---

## 10. 勘误后记（2026-08-22 勘误轮，产品所有者裁决 2026-08-21 授权）

> 裁决：修锁获批（tokenizer_config.json 锁值按实测值勘误）；calibration
> CONDITIONAL PASS；Gate 0-F 暂不授权。授权一次最小勘误轮：修锁 +
> 连带 digest 更新 + 供应链守卫重跑 + 同 53 cases / 35-grid / 代码 /
> 缓存重跑主运行与确定性复验。本节为追加记录，§1–§9 原文零改动。

- **锁勘误**：候选锁 tokenizer_config.json SHA-256 第 49 位 hex `6`→`7`
  （`…37597d996cd3f…` → `…37597d997cd3f…`），锁文件 8198 字节中仅 1 个
  字节变化；旧锁 digest `9ee35419…4814` → 新锁 digest
  `50ab5689cf4378441177d1af0773b59fbd5a2dc62ff866df7a76b0ea0ad0cd23`
- **manifest 重建**（模型目录仓库外派生物）：lock_discrepancy 例外移除
  （活跃 manifest 零 discrepancy，无可绕过校验的例外）；trust_root 改为
  勘误后锁内容寻址；self_hash 重算。旧 manifest digest `c5e145a1…07b5e`
  → 新 manifest digest
  `2c9d6487b39576684d6593d33a52f8603087bf5775b51cddf8f907dd1eeba960`
- **供应链守卫重跑**：fail-closed 校验 PASS；锁 / manifest / 磁盘字节
  三方 6/6 完全一致，discrepancy = 0
- **calibration 重跑**（环境预检 + 主运行 + 确定性复验）：Result = PASS，
  10/35 qualifying，冻结选择 alpha=1.00 / tau=0.90 不变；新旧运行逐 case
  verdict、顺序、reason code、35 项决策、最终选择**完全一致**；叶子差异
  恰 5 处且全部在预期集合（锁勘误、manifest 重建 ×2、运行时 HEAD、
  实施轮遗留 calibration_code 披露项），零预期外差异
- **实施轮遗留发现（非静默披露）**：原始 receipts 记录的
  calibration_code_sha256（`bac9c6f2…`，运行时版本）与 db1d5c9 提交内
  文件（`39e76734…`）不一致——运行时版本在提交前被改动且从未入库；
  行为等价由勘误轮双重完整重跑证明，勘误后 receipts ↔ 提交代码一致性
  就此修复
- **禁令遵守**：fixture / expected / oracle v3 / 网格 / 门槛 / 择优 /
  calibration 实现 / holdout 与 pp-001~012 / main·tag·release / 真实
  Binding 全部零触碰；未执行 push
- 完整勘误记录：`docs/r4-gate0/evidence/e5-base-lock-erratum.json`
- 重跑一致性比较证据：`docs/r4-gate0/evidence/e5-base-erratum-rerun-comparison.json`
- §7 digest 清单中 `e5-base-candidate-lock.json` 与 `MODEL-MANIFEST.json`
  两行由上述勘误值取代；其余各行（含全部代码文件与冻结合同、oracle
  spec、holdout manifest、requirements lock）在勘误轮逐字节复测不变

---

## 11. R2A 勘误后记（2026-08-22 R2A 轮，产品所有者裁决 2026-08-22 授权）

R2 = R2A（合同样值勘误，本节）+ R2B（锁定环境 manifest 重生成与 calibration
重跑，独立子提交）。授权边界照录：禁止运行一次性 E5-base holdout、禁止启动
正式 Shadow 计数、禁止修改真实 Binding、禁止修改 case / oracle 语义 / 参数 /
网格 / 门槛、禁止 push / tag / release。

- **修复对象**：`tests/test_acceptance.py::test_repo_files_do_not_self_match_secret_patterns`
  FAIL——冻结合同 `secret_marker_substitution` 字段中合成令牌样值以连续字面
  形态写出（`ghp_` 前缀 + 24 连续大写 `A`），自命中 secret_patterns 模式 1
  （该失败已在 gate0-continuation-status-68c0e4f.json 的 gate_0_g.blockers
  如实记录，当时因 TURING 锁定环境不在场未修）
- **勘误本体**：该括号内样值描述改写为乘积记法描述形态；替换规则本体
  （`'__FAKE_TOKEN__'` → `'ghp_' + 'A'×24`）与全部过滤语义零变化；
  oracle 消费面（contract_type / status / vocabularies）不触及该描述文本
- **digest 链更新**（新旧值与逐字段改动范围见
  `docs/r4-gate0/evidence/e5-base-r2a-erratum.json`）：
  - frozen-hard-filter-contract.json：`1785469c…` → `f79b6a0f…`
  - oracle-v3-spec.md：`11ce8934…` → `1ff8b9a0…`（§2.1 digest + 头部变更记录）
  - e5-base-candidate-lock.json：`50ab5689…` → `66e1ab24…`
    （lock_version 保持 2；结构 / 模型 / 网格 / 门槛字段逐字段不变）
  - supply_chain.py pin：EXPECTED_LOCK_SHA256 → `66e1ab24…`（LOCK_FROZEN_COMMIT
    保持 baa9bb6 历史锚点，内容寻址优先，无提交哈希循环依赖）
  - tests/test_e5_base_supply_chain.py：真实锁 pin 断言更新 + 旧 digest
    不得残留断言新增（18/18 PASS）
- **manifest 与运行产物**：MODEL-MANIFEST.json 与 calibration
  receipts/results/replay 连带更新全部归 R2B（本提交零运行产物）
- **禁令遵守**：fixture / expected / oracle v3 代码 / calibration 实现 /
  embedder / 网格 / 门槛 / 择优 / holdout 与 pp-001~012（零读取）/ Shadow
  计数（未启动）/ 真实 Binding / main·tag·release 全部零触碰；未 push

---

## 12. R2B 重跑后记（2026-08-22 R2B 轮，R2A 33cfe42 之下）

R2B = 锁定环境（vg0b venv，与 R1B 同一 TURING Python/backend、同 E5-base
模型目录与缓存）下 manifest 重生成 + main/replay 双运行重跑。运行前删除
模型目录中锚定旧锁的 MODEL-MANIFEST.json（删前实测 `8e768a6e…`），由
calibration 经 build_manifest 从勘误后候选锁自动重建。

- **manifest 重建**：schema v2，锚定 `66e1ab24…`，新 SHA-256
  `4a87ee46…`（2343 字节）；evidence 内字节拷贝
  `docs/r4-gate0/evidence/e5-base-model-manifest.json` 与模型目录运行时
  副本逐字节一致；零 discrepancy 字段
- **main 运行**：PASS；53 cases / 35-grid 全跑；qualifying 10/35；
  最终选择 alpha=1.00 / tau=0.90 不变；holdout_detail_reads = 0
- **replay 复验**：独立索引目录重建后重跑；deterministic_replay_ok =
  true（22 个确定性字段，mismatched_fields = []）
- **receipts git_head** = R2A（`33cfe42`）
- **跨轮一致性（R2B vs R1B）**：确定性差异仅 `integrity` 与
  `runtime.model` 两块；leaf 级恰为预期 6 项（git_head、候选锁、合同
  digest、spec digest、manifest digest ×2），unexpected leaf diffs = 0；
  verdict 级差异仅 latency_ms；oracle_results `8e8e2622…`、vector table
  `2fe408db…`、vectors.f32 `dde75de2…`、calibration_code `39e76734…`、
  oracle_v3_code `3163ab4f…`、embedder_code `60bf99f2…` 全部不变
  （完整比较见 `docs/r4-gate0/evidence/e5-base-r2-record.json`）
- **测试**：供应链 18/18（vg0b + 系统 Python 双环境）；
  test_gate0_calibration 5 PASS；test_vector_index 15 PASS；
  test_embedding_adapter 29 PASS（vg0b，torch 在场零跳过）；
  test_hybrid_recall 12 PASS；test_recall_trace 19 PASS；secret scan
  在全部证据文件定稿后重跑 PASS（R2A 修复经 R2B 全量验证）
- **receipts markdown 变更**：main / replay 两份 receipt 各仅 line 11
  Model manifest SHA-256 一行变化（`8e768a6e…` → `4a87ee46…`）
- **禁令遵守**：holdout 与 pp-001~012 零读取、Shadow 计数未启动、
  真实 Binding 零触碰、case / oracle 语义 / 参数 / 网格 / 门槛零变化、
  未 push / tag / release

---

## 13. R3A 勘误后记（2026-08-22 R3A 轮，产品所有者裁决 2026-08-22 授权）

R3 = 微型 R3（R3A trust-root provenance 修正，本节）+ R3B（锁定环境
manifest 重建与 calibration 重跑，独立子提交）。授权边界照录：禁止运行
一次性 E5-base holdout、禁止启动正式 Shadow 计数、禁止修改真实 Binding、
禁止修改候选锁 / frozen contract / oracle spec / 模型文件 / case / 网格 /
门槛 / 择优规则、禁止 push / tag / release、禁止 amend。

- **修复对象**：R2B 重建的 MODEL-MANIFEST.json 的 trust_root 为
  「candidate-lock @ baa9bb6（SHA-256 = 66e1ab24…）」——该
  (commit, bytes) 组合**不可重放**：`git show baa9bb6:…lock.json` 的
  整文件 SHA-256 = `50ab5689…`（R2A 勘误前旧锁字节），≠ `66e1ab24…`
- **根因**：R2A 更新锁字节与 EXPECTED_LOCK_SHA256 pin 时，将
  LOCK_FROZEN_COMMIT 当作「历史锚点」保持 baa9bb6 不动；build_manifest()
  把该常量写进 trust_root，产生「baa9bb6 + 66e1ab24」错误组合。附随
  不一致：r2-record.json 中 trust_root 描述为「@ R2A 33cfe42」而 manifest
  实际字节为「@ baa9bb6」
- **勘误本体**：supply_chain.py 的 LOCK_FROZEN_COMMIT 由 `baa9bb6…`
  改为 `33cfe424d01727c3a16b8e5bbe9fd7d02ca16dfc`——首次实际包含候选锁
  `66e1ab24…` 字节的提交（即 R2A 提交本身）；EXPECTED_LOCK_SHA256
  保持 `66e1ab24…` 不变，守卫逻辑零改动
- **provenance 证明**（新增
  `tests/test_e5_base_supply_chain.py::test_lock_frozen_commit_provenance`，
  每次测试运行时实测复证）：
  - `git show 33cfe42:docs/r4-gate0/locks/e5-base-candidate-lock.json`
    的 SHA-256 == `66e1ab24…`（当前 (commit, bytes) 组合可重放）
  - `git show baa9bb6:…` 的 SHA-256 == `50ab5689…` ≠ `66e1ab24…`
    （R2 旧组合不可重放的直接证明）
  - 工作树锁字节 == pin（三方一致）
- **零变化面**：候选锁（`66e1ab24…`，lock_version 2）/ frozen contract
  （`f79b6a0f…`）/ oracle spec（`1ff8b9a0…`）/ oracle_v3.py /
  calibration.py / gate0_calibration.py / embedder.py / 模型文件 / case /
  网格 / 门槛 / 择优规则全部零字节改动
- **测试**：供应链 19/19 PASS（vg0b + 系统 Python 双环境；原 18 项全
  保持 PASS + 新增 provenance 测试 PASS）；test_real_lock_pinned_in_code
  新增旧锚点 baa9bb6 全哈希不得残留断言；文件头过期说明更新（原
  「真实锁 SHA-256 == 50ab5689…」为 R2A 遗留过期描述）
- **manifest 与运行产物**：MODEL-MANIFEST.json 因 trust_root 字符串内
  锚点值变化而失效（self_hash 不可复现），由 R3B 删除重建——trust_root
  精确为「candidate-lock @ 33cfe42（SHA-256 = 66e1ab24…）」；evidence
  字节拷贝与 receipts/results 由 R3B 连带更新（本提交零运行产物）
- **勘误完整记录**：`docs/r4-gate0/evidence/e5-base-r3a-erratum.json`
- **禁令遵守**：holdout 与 pp-001~012 零读取、Shadow 计数未启动、
  真实 Binding 零触碰、未 push / tag / release、未 amend
