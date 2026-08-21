# Oracle v3 — expected_forbidden_contract 修订规范（canonical）

> 状态：定义冻结（M0-R2）。实现待下一授权轮，本文档即实现合同。
> digest：见 `locks/e5-base-candidate-lock.json` 的 `oracle_v3_spec_digest`（对本文件逐字节 SHA-256）
> 本文件任何修改 = 锁失效，必须重新走授权

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
                                          # 过滤条件、判定规则
    )

eligible_expected(case) =
    frozen_expected(case) ∩ canonical_survivors(case)
```

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

- secret-first 硬过滤合同不动
- 硬过滤顺序不动
- frozen_expected 冻结原文不动（eligible_expected 是派生集合，不改写原文）
- 58-case holdout 逐字节密封不动，detail reads = 0
- 质量门槛（ADR-MIV-005B-002 §4）逐字不动
