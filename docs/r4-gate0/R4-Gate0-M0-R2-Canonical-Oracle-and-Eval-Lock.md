# R4 Gate 0 · M0-R2 Canonical Oracle 修正与候选评测锁

> 阶段：M0-R2（小范围修正轮，仅文档与评测锁；无任何下载/实现/评测）
> 授权来源：产品所有者裁决 2026-08-21（M0-R1 裁决 PARTIAL PASS，四项闭合、三项阻断）
> 本文档勘误 M0-R1（`R4-Gate0-M0-R1-Errata-and-Pinning.md`）；未被勘误部分继续有效
> 权威证据：origin/r4-gate0-nogo @ `5c6aa1f95672ec588b24785e1dfd66a69b024dca`
> origin/main @ `8c22c238144225335c08ad8ebbf63ac890f87b55`

---

## 0. 授权边界（M0-R2，照录裁决）

### 允许（一次文档和评测锁修正）

1. 修正 oracle v3 为独立 canonical oracle，并规定 Trace mismatch 必须失败
2. 将所有供应链重放地址固定到完整 revision
3. 修正 Xet/LFS 元数据表述
4. 补记证据分支相对当前 main 为 16/2，相对 286e637 为 19/0
5. 收紧 35-grid NO-GO 的适用范围
6. 生成候选锁文件（revision、六文件哈希、backend、35-grid、holdout manifest digest、oracle v3 digest），在任何下载或结果产生前形成独立本地提交

### 禁止（本轮不授权）

- E5-base 权重下载
- 768 维索引构建
- oracle v3 实现
- calibration 或 holdout
- git push、tag、release
- 修改真实 Binding 或启用 semantic mode

---

## 1. 勘误一（阻断项 1）：oracle v3 改为独立 canonical oracle

**取代 M0-R1 §4.3 全部内容。**

### 1.1 被修正的自证循环

M0-R1 §4.3 原口径：

```
eligible_expected(case) = frozen_expected ∩ survivors(被测路径自身 pre-scoring 硬过滤 Trace)
```

缺陷：如果 Runtime 错误过滤一个合法 expected，该对象会**同时从 expected 中消失**，
召回缺陷被静默掩盖——expected 由被测路径自己的 Trace 定义，构成自证循环。

### 1.2 修正后的定义（canonical）

```
canonical_survivors =
    oracle_v3(frozen fixture metadata, frozen hard-filter contract)

eligible_expected =
    frozen_expected ∩ canonical_survivors
```

随后独立验证（强制 FAIL 语义）：

```
runtime filter Trace == canonical oracle Trace    # 逐 case 成立
```

**不一致必须 FAIL，不能缩减 expected。**

### 1.3 规范正文与摘要

完整规范冻结于 `locks/oracle-v3-spec.md`（独立文件，逐字节 SHA-256 =
`a915d8e7fe4bf1c2c0090b114c26b1f069866e8e95ee2a81fa2a0c2baecf05ac`，见 §6 锁文件），
其硬约束：

- oracle_v3 输入**只能**是冻结夹具元数据 + 冻结硬过滤合同，禁止读取 Runtime
  Trace、运行时状态、评分结果
- oracle_v3 与被测召回路径必须**两个独立实现**，不允许共享过滤代码
  （复制粘贴共享逻辑同样禁止，避免同源 bug 双侧静默）
- Trace mismatch → 该轮评测整体 FAIL，出具差异报告，禁止以缩减 expected /
  跳过 case / 放宽校验继续

### 1.4 sa-004 口径（不变部分）

sa-004 仍应因**独立 oracle 判定**其为 secret 而排除（`mem_fx0h0003` →
`SECRET_DETECTED`），判定依据是冻结元数据，不是 Runtime Trace——即使 Runtime 从未
跑过，结论不变。该 case 因此可满足。**secret-first 合同完全不动**：过滤顺序、
过滤条件、让 secret 对象进入向量候选的禁令，全部逐字保留。

---

## 2. 勘误二（阻断项 2）：供应链重放命令固定到完整 revision

**取代 M0-R1 §8 中所有使用 `tree/main` / `resolve/main` 的命令。**

规则：**全部文件查询、下载和哈希验证必须使用完整 revision
`d128750597153bb5987e10b1c3493a34e5a4502a`**；`main` 只能用于确认"当前指向哪里"，
不能作为下载或重放输入。

修正后的重放命令（本轮已逐条实测通过）：

```bash
# 1. 权威证据与 ahead/behind 验证（本节不变）
git fetch origin
git rev-list --count 286e637..5c6aa1f   # → 19
git rev-list --count 5c6aa1f..286e637   # → 0
git rev-list --count 8c22c238..5c6aa1f  # → 16（相对当前 main）
git rev-list --count 5c6aa1f..8c22c238  # → 2（相对当前 main）

# 2. holdout 密封验证（仅读 manifest 元数据，不变）
git show 5c6aa1f:docs/r4-gate0/evidence/frozen-eval-manifest.json

# 3. E5-base 供应链指纹验证 —— 全部固定 revision
curl -s https://huggingface.co/api/models/intfloat/multilingual-e5-base | jq .sha
#   → d128750597153bb5987e10b1c3493a34e5a4502a（仅用于确认 main 当前指向）
curl -s "https://huggingface.co/api/models/intfloat/multilingual-e5-base/tree/d128750597153bb5987e10b1c3493a34e5a4502a?recursive=true"
#   → 白名单 6 文件的 size 与 Xet/LFS 元数据 SHA-256 逐项比对锁文件
curl -sL "https://huggingface.co/intfloat/multilingual-e5-base/resolve/d128750597153bb5987e10b1c3493a34e5a4502a/config.json" | sha256sum
#   → 9dab198f...（tokenizer_config.json / special_tokens_map.json 同法）

# 4. backend 版本锁验证（不变）
git show 5c6aa1f:docs/r4-gate0/evidence/requirements-gate0b.lock.txt
```

本轮实测记录（2026-08-21，全部走固定 revision 地址）：

| 文件 | 复验结果 |
|------|---------|
| config.json | `9dab198f...` 一致 |
| tokenizer_config.json | `efb5c0d0...` 一致 |
| special_tokens_map.json | `06e405a3...` 一致 |
| tokenizer.json / sentencepiece.bpe.model / model.safetensors | tree API `lfs.oid` 与锁文件一致 |

---

## 3. 勘误三（阻断项 2 附带）：Xet/LFS 元数据表述修正

**取代 M0-R1 §5.2 说明第 2 条。**

原文："#2/#5/#6 为 LFS 文件，SHA-256 取自 HuggingFace 官方 LFS 元数据"——错误原因：
Hugging Face 当前文件页显示这些大文件由 **Xet** 存储，"LFS 元数据"的表述会让实现
依赖错误的存储后端假设。

修正后表述：

> #2/#5/#6 为大文件，SHA-256 取自**官方 Xet/LFS 文件元数据中的 SHA-256**
> （tree API 的 `lfs.oid` 字段）；实现不得假设具体存储后端（LFS 协议或 Xet），
> 一律以官方文件元数据中的 SHA-256 为准，下载授权轮须逐文件复验。

---

## 4. 勘误四：证据分支相对关系补记

M0-R1 只记录了相对 Gate 0 基线的关系。补记当前完整真值（2026-08-21 实测）：

| 比对基准 | ahead | behind | 说明 |
|----------|-------|--------|------|
| `286e637`（Gate 0 基线） | 19 | 0 | Gate 0-A～E 证据链完整包含 |
| `8c22c238`（当前 origin/main） | 16 | 2 | main 的 2 个独有提交不改变 Gate 0 基线口径 |

结论：**并未改变相对 Gate 0 基线的 19/0**；相对当前 main 的 16/2 仅作事实补记，
权威证据仍唯一指定 `r4-gate0-nogo @ 5c6aa1f`。

---

## 5. 勘误五：35-grid NO-GO 措辞收紧

**取代 M0-R1 §6.3 冻结规则第 3 条与 §9 结论第 6 条中的相应表述。**

原文："若 35 组合中 0 qualifying → E5-base 直接 NO-GO，不设网格扩展重试"
——"直接 NO-GO"可被读成对所有可能阈值的模型级结论，超出证据范围。官方模型卡
只说明 cosine 通常分布在 0.7～1.0，不能据此证明"0.90 以上无意义"。

修正后表述：

> 若 35 组合中 0 qualifying → **E5-base 在本次预冻结 35 组合合同下 NO-GO，
> 不扩网格、不重试。**
> 该结论的适用范围仅限本合同（tau 0.60～0.90 × alpha 5 点），不构成对所有
> 可能阈值的模型级证明。

同步收紧 M0-R1 §6.2 设计依据第 4 条："继续上探无意义"降级为设计判断（基于
cosine 集中带的预期），不是官方结论的引证；网格上界 0.90 的选择本身不变、
继续冻结。

---

## 6. 本轮交付：候选评测锁（独立本地提交）

### 6.1 锁文件

`locks/e5-base-candidate-lock.json`，状态 **CANDIDATE**（定义锁，未授权实施），
内容：

| 锁项 | 值 |
|------|-----|
| immutable revision | `d128750597153bb5987e10b1c3493a34e5a4502a` |
| 六文件哈希 | config / tokenizer / tokenizer_config / special_tokens_map / sentencepiece.bpe.model / model.safetensors 逐文件 SHA-256 + size |
| backend | python 3.13.14 / torch 2.13.0+cpu / transformers 5.15.1 / tokenizers 0.22.2 / safetensors 0.8.0 / huggingface_hub 1.28.0 / numpy 2.5.2；requirements-gate0b.lock.txt @5c6aa1f 的 SHA-256 = `e0355a34...` |
| 35-grid | tau {0.60..0.90}×7 × alpha {0.0..1.0}×5 = 35，含 NO-GO 适用范围条款 |
| holdout manifest digest | frozen-eval-manifest.json @5c6aa1f 的 SHA-256 = `c7a195e1e21a476ac949723d65dc8f8594f3931b999974db68561a2838b32ac1` |
| oracle v3 digest | oracle-v3-spec.md 的 SHA-256 = `a915d8e7fe4bf1c2c0090b114c26b1f069866e8e95ee2a81fa2a0c2baecf05ac` |
| 权威证据关系 | 5c6aa1f vs 286e637 = 19/0；vs 8c22c238 = 16/2 |

### 6.2 独立本地提交

- 分支：本地分支（自 `5c6aa1f` 切出），**不 push、不打 tag、不动 main**
- 提交内容：本文档 + `locks/oracle-v3-spec.md` + `locks/e5-base-candidate-lock.json`
- 时序：先于任何 E5-base 下载、索引构建或评测结果存在（本轮全部未发生）
- 下一授权轮（E5-base 实施轮）的一切下载与评测以本锁为输入；锁的任何修改 =
  锁失效，必须重新走授权

---

## 7. 结论与停止点

- oracle v3 已修正为独立 canonical oracle，Trace mismatch 强制 FAIL，自证循环消除
- 供应链重放全部固定到完整 revision；Xet/LFS 表述已修正；六文件哈希在固定
  revision 下复验一致
- 证据分支相对关系已补记：vs 286e637 = 19/0；vs 当前 main 8c22c238 = 16/2
- 35-grid NO-GO 已收紧为"本次预冻结 35 组合合同下"的结论，不作模型级外推
- 候选评测锁已生成并形成独立本地提交（revision / 六文件哈希 / backend /
  35-grid / holdout manifest digest / oracle v3 digest）
- M0-R1 其余未勘误内容（4188df2 结案、E5-small NO-GO 真值 §3、H1 假设、
  holdout 密封声明、磁盘口径 1.0571 GiB、backend 零变更）继续有效
- **M0-R2 到此停止**。E5-base 实施轮（下载 / 索引重建 / oracle v3 实现 /
  calibration）待产品所有者授权后进行
