# Oracle v3 — expected_forbidden_contract 修订规范（canonical）

> 状态：定义冻结（M0-R2）；M0-R3 补冻结 frozen_hard_filter_contract 本体（见 §2.1）。
> 实现待下一授权轮，本文档即实现合同。
> digest：见 `locks/e5-base-candidate-lock.json` 的 `oracle_v3.spec_sha256`（对本文件逐字节 SHA-256）
> 本文件任何修改 = 锁失效，必须重新走授权
> M0-R3 变更记录：① 修正本文件此处的锁字段引用错误（原文误写
> `oracle_v3_spec_digest`，实际 JSON 字段为 `oracle_v3.spec_sha256`）；
> ② frozen_hard_filter_contract 由独立文件逐字节冻结（path + source +
> SHA-256 见 §2.1）。除此之外逐字保留 M0-R2 冻结内容。

## 1. 目的（被修正的缺陷）

Oracle v2 口径规定 eligible expected 来自**被测路径自身的过滤 Trace**，构成自证循环：

> 若 Runtime 硬过滤错误排除一个合法 expected 对象，该对象会同时从 expected 集合中消失，
> 召回缺陷被静默掩盖。

v3 消除该循环：expected 的资格判定与被测路径完全解耦。

## 2. 定义

```
canonical_survivors(case) =
    oracle_v3(
        frozen_fixture_metadata(case),    # 冻结夹具元数据：对象 ID、secret 标记、
                                          # no-memory 标记、绑定关系（来自
                                          # frozen-eval-manifest.json 及其引用的冻结夹具）
        frozen_hard_filter_contract       # 冻结硬过滤合同：secret-first 顺序、
                                          # 过滤条件、判定规则（本体见 §2.1）
    )

eligible_expected(case) =
    frozen_expected(case) ∩ canonical_survivors(case)
```

## 2.1 frozen_hard_filter_contract 本体（M0-R3 冻结）

完整规则正文已冻结为独立机器可读合同：

- path：`locks/frozen-hard-filter-contract.json`
- 权威语义源：`memory_engine/recall_engine.py`、`recall_trace.py`、
  `vector_index.py`、`schema.py`、`temporal.py`、`store.py`、`relevance.py`、
  `hybrid_recall.py`、`memory_eval/schema.py`、`guards.json`
  @ `5c6aa1f95672ec588b24785e1dfd66a69b024dca`（逐文件 SHA-256 见合同
  `authoritative_source.files`）
- 本体 SHA-256：
  `1785469cafa4660bdc6f06e531b93fab6e87f14b7ba6dfe4ea09d884626b3881`
  （同步记录于 `locks/e5-base-candidate-lock.json` 的
  `oracle_v3.frozen_hard_filter_contract.sha256`）

合同内容：判定顺序 P1–P8（短路与参数解析）→ A1–A6（status /
scope+category / temporal / tags / entities / light）→ B1–B7
（invalid / permission / schema / temporary / status / temporal / secret，
first-match-wins）→ SURVIVOR；每条 predicate 的输入字段与 canonical
Trace code、secret 扫描规则（guards.json 模式 + 全对象 JSON 序列化文本）、
`__FAKE_TOKEN__` 替换规则、Trace 相等性比较规则、合同外阶段（conflict /
准入 / 截断 / 回退码）与独立性要求均在合同中逐条固定。

## 3. 独立性要求（硬约束）

1. oracle_v3 的输入**只能**是冻结夹具元数据与冻结硬过滤合同；
   **禁止**读取 Runtime Trace、运行时状态、评分结果或任何被测路径输出
2. oracle_v3 与被测召回路径必须为**两个独立实现**，不允许共享过滤代码
   （复制粘贴共享逻辑同样禁止，避免同源 bug 双侧静默）

## 4. Trace 一致性校验（强制 FAIL 语义）

```
runtime_filter_trace(case) == canonical_oracle_trace(case)   # 逐 case 成立
```

- 不一致 → **该轮评测整体 FAIL**，出具差异报告（case ID、对象 ID、两侧 Trace）
- **禁止**以缩减 expected、跳过 case、放宽校验的方式继续
- 一致才允许用 eligible_expected 进入评分

## 5. sa-004 判定（记录）

sa-004 的 `mem_fx0h0003` 由 oracle_v3 基于**冻结元数据独立判定**为 secret
（`SECRET_DETECTED`），从 eligible_expected 中排除，该 case 因此可满足。
判定依据是独立 oracle，**不是** Runtime Trace；即使 Runtime 从未跑过，结论不变。

## 6. 不变量（零改动项）

- secret-first 硬过滤合同不动（本体已由 M0-R3 冻结为
  `locks/frozen-hard-filter-contract.json`，见 §2.1）
- 硬过滤顺序不动（合同 stage_order：P → A1–A6 → B1–B7 → SURVIVOR）
- frozen_expected 冻结原文不动（eligible_expected 是派生集合，不改写原文）
- 58-case holdout 逐字节密封不动，detail reads = 0
- 质量门槛（ADR-MIV-005B-002 §4）逐字不动
