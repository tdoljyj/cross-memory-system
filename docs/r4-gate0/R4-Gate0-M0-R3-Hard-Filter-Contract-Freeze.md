# R4 Gate 0 · M0-R3 Canonical Hard-Filter Contract 冻结（微型锁修正）

> 阶段：M0-R3（一次微型锁修正，仅锁文件与文档；无任何下载/实现/评测）
> 授权来源：产品所有者裁决 2026-08-21（M0-R2 PARTIAL PASS：原三项阻断闭合，
> 新阻断一项 = canonical hard-filter contract 没有被精确固定）
> M0-R2 交付（df15e1e）未勘误部分继续有效
> 权威证据：r4-gate0-nogo @ `5c6aa1f95672ec588b24785e1dfd66a69b024dca`
> origin/main @ `8c22c238144225335c08ad8ebbf63ac890f87b55`

---

## 0. 授权边界（M0-R3，照录裁决要点）

允许：冻结完整 canonical hard-filter contract（可内嵌 spec 或独立 JSON）；锁中
记录 path + commit/source + SHA-256；明确每条 predicate、输入字段、判定顺序及
canonical Trace code；保持 oracle 与 Runtime 两套独立实现；修正
`oracle_v3_spec_digest` → `oracle_v3.spec_sha256`；更新 oracle spec digest 及
候选锁；新增独立提交（父提交必须为 df15e1e，不得 amend）；仓库口径写清
local refs/heads/main 与 origin/main 且不得统称 main。

禁止（不变）：模型下载、oracle 实现、768 维索引、calibration/holdout、
push/tag/release、修改真实 Binding、rebase/merge 当前 main。

---

## 1. 本轮交付

| 文件 | 状态 | 说明 |
|------|------|------|
| `locks/frozen-hard-filter-contract.json` | 新增（冻结） | 硬过滤合同本体，机器可读 JSON |
| `locks/oracle-v3-spec.md` | 修正 | 字段引用修正 + 挂接合同（§2.1） |
| `locks/e5-base-candidate-lock.json` | 更新（v2） | digest 更新 + 合同挂接 + 仓库口径 |
| 本文档 | 新增 | 修正记录与验证口径 |

## 2. 合同内容摘要

- 判定顺序：**P1–P8**（T0/T4/temporary 零读取短路、project_only fail-closed、
  want_categories 解析、statuses_admissible、light=(tier==T3)、
  boundary_active=(semantic_mode≠off AND NOT include_history)）→
  **A1–A6**（status → scope+category → temporal → tags → entities → light）→
  **B1–B7**（invalid → permission → schema → temporary → status → temporal →
  secret，first-match-wins）→ **SURVIVOR**。第一个命中的 stage 产生 verdict。
- 裁决书点名的六族全部覆盖：permission（B2 ACCESS_DENIED）、status（A1
  STATUS_* 词表 + B5）、temporal（A3 TEMPORAL_EXPIRED/NOT_YET_VALID + B6）、
  light（A6 PRIORITY_FILTERED，唯一激活 case = nm-014/T3）、scope（A2 可见性
  矩阵 + SCOPE/PROJECT/SESSION_MISMATCH）、secret（B7 SECRET_DETECTED）。
- 每条 predicate 的输入字段、canonical Trace code、A2 的双 code 产出顺序、
  secret 扫描文本（全对象 JSON 序列化）与模式表（guards.json @5c6aa1f 五条）、
  `__FAKE_TOKEN__` → `ghp_` + A×24 替换规则均逐条固定。
- B5/B6 在 recall 顺序内因 A1/A3 先行不可达（防御性重复），但在向量表预嵌入
  过滤（`_initial_exclusion_reasons` 独立调用）中可达——合同对此显式记录，
  防止实现者两处歧义。
- 合同外阶段显式列举：CONFLICT_LOSER、MIV-005A 准入、hybrid alpha/tau 准入、
  LIMIT/LOAD 截断、HYBRID_* 回退码、顶层 NO_MEMORY 族。
- 独立性：禁止 import/调用/复制 Runtime 过滤函数；合同与钉定源码分歧时以源码
  为准并判合同失效，禁止实现者裁量。

## 3. 权威语义源与基线差异（实测 2026-08-21）

合同语义源钉 @5c6aa1f，逐文件 SHA-256 记录于合同 `authoritative_source.files`。
与 frozen-eval-manifest.json 的 engine_sources 基线（Gate0-A-Run2，HEAD 6ee9b4b）
存在两处**有意差异**，已在合同 `hash_note` 逐项说明：

| 文件 | @5c6aa1f（合同钉定） | manifest 基线（6ee9b4b） | 差异 |
|------|---------------------|--------------------------|------|
| recall_engine.py | `c927964b…` | `3e7b59fa…` | Gate 0-D 语义边界 + hybrid 接线新增；词法链 A1–A6 逐行未变（diff 实测） |
| store.py | `8dd39526…` | `2b2a6db6…` | save_object 增加 vector dirty-marker；secret 扫描函数未变 |
| vector_index.py / hybrid_recall.py | `500585d0…` / `0e07125e…` | （不在基线内） | Gate 0-C/D 新增文件，合同直接钉 @5c6aa1f |

其余（recall_trace / schema / temporal / relevance / memory_eval.schema /
guards.json）与 manifest 钉定逐字节一致。

## 4. digest 一览（本轮实测）

| 锁项 | SHA-256 |
|------|---------|
| frozen-hard-filter-contract.json（新增冻结） | `1785469cafa4660bdc6f06e531b93fab6e87f14b7ba6dfe4ea09d884626b3881` |
| oracle-v3-spec.md（M0-R3 修正后） | `11ce893465f4a25f0f3d2e3fd933b643713fcb90acbeec69de978132164ab83f` |
| oracle-v3-spec.md（M0-R2 旧值，作废） | `a915d8e7fe4bf1c2c0090b114c26b1f069866e8e95ee2a81fa2a0c2baecf05ac` |
| frozen-eval-manifest.json（不变） | `c7a195e1e21a476ac949723d65dc8f8594f3931b999974db68561a2838b32ac1` |
| requirements-gate0b.lock.txt（不变） | `e0355a341138fb90abeb0826fdeef0acfeba4eb2dea2c4d673ed127c2db155c6` |

## 5. 仓库口径（2026-08-21 实测）

| ref | 哈希 | 说明 |
|-----|------|------|
| local `refs/heads/main` | `ffba74bfba27143411c664aa963f54e298cebe43` | 与 origin/main 分叉，两者不得统称 main |
| `origin/main` | `8c22c238144225335c08ad8ebbf63ac890f87b55` | ls-remote 实测 |
| 证据分支 r4-gate0-nogo | `5c6aa1f95672ec588b24785e1dfd66a69b024dca` | 5c6aa1f vs 286e637 = 19/0；vs 8c22c238 = 16/2 |
| 本轮分支 r4-gate0-m0-r2 | M0-R2 = `df15e1e`（父 5c6aa1f）；M0-R3 = df15e1e 的唯一子提交（本提交，不 amend） | |

## 6. 验证命令（产品所有者复验用）

```bash
git rev-parse refs/heads/main origin/main r4-gate0-m0-r2~1 r4-gate0-m0-r2
# → ffba74bfba… / 8c22c238… / df15e1e03… / <M0-R3 提交>
git show r4-gate0-m0-r2:docs/r4-gate0/locks/frozen-hard-filter-contract.json | sha256sum
# → 1785469caf…
git show r4-gate0-m0-r2:docs/r4-gate0/locks/oracle-v3-spec.md | sha256sum
# → 11ce893465…
git show r4-gate0-m0-r2:docs/r4-gate0/locks/e5-base-candidate-lock.json | python -m json.tool > /dev/null && echo LOCK_JSON_OK
# 合同语义源钉定复验
git show 5c6aa1f:memory_engine/recall_engine.py | sha256sum   # → c927964bc…
git show 5c6aa1f:memory_engine/vector_index.py  | sha256sum   # → 500585d09…
```

## 7. 结论与停止点

- canonical hard-filter contract 已作为独立机器可读 JSON 冻结，path + 语义源
  commit + 逐文件 SHA-256 + 本体 SHA-256 全部入锁；oracle 的两个输入
  （frozen fixture metadata、frozen hard-filter contract）至此均已固定
- 锁字段引用错误已修正（`oracle_v3.spec_sha256`），oracle spec digest 与候选
  锁已按授权更新（lock_version 2）
- 仓库口径已写清：local main（ffba74b）与 origin/main（8c22c238）分列，不统称
- 独立性要求保持：oracle 与 Runtime 两套实现，禁止调用/复制 Runtime 过滤函数
- 全部禁令不变；**M0-R3 到此停止**。E5-base 实施轮（下载 / 索引重建 /
  oracle v3 实现 / calibration）待产品所有者授权后进行
