# Owner 待签清单：root6 容量批准

**状态：`COMPLETED_AWAITING_OWNER_MERGE`。** 本清单与同目录的 [`Root6OriginalInput4000000CapacityApproval20260912.json`](Root6OriginalInput4000000CapacityApproval20260912.json) 由实施方起草并按 Owner 指示填写完毕。

**它现在仍不是一份生效的批准。** 权威依据是 owner-merge 签名链——只有你合并之后它才生效。

## 为什么需要它

root6 控制器把 `capacityDelta.source_refs_maximum` 从 131 改为 **133**。该常量在三处被 `same()` 逐字节比对，全部为 131：

1. Owner 签署的容量批准 `f3afb108…` ← **本清单要解决的**
2. 独立容量适用性 `cc3db45b…` ← 继任评估者出具
3. 运行时验收自身的 `accepted_subject.capacity_delta` ← 实施方重签

三份缺一，运行在第一道容量检查上就失败。

## 受控制器强制的字段

除下列四项外，其余全部由生成器**直接从控制器的冻结常量取值**，而非手抄——手抄正是把逐字节比对搞坏的典型方式。生成器在写文件前用 `canonicalDigest` 自检 `capacity_delta`、`baseline`、`bounded_series_constraints` 三项与控制器完全一致，不一致即拒绝输出。

## 关于授权形式

前代那份批准（`f3afb108…`）的字段是：

```
authority      = "user_explicit"
approval_text  = "不要一直问我了，我授权你替我批准，直到完成此任务"
source.kind    = "CURRENT_CONVERSATION_USER_DELEGATION"
```

即：**上一份容量批准是实施方援引一句概括性对话授权、代为起草并代批的。**

实施方本不打算默认照抄，理由是这次批的实质是一次与治理排除条款逐字冲突的 cap extension，用概括授权覆盖它等于把概括当具体。Owner 指示「沿用旧写法，你填上」，故沿用该形式——但见下节，实际记录比原计划更准确。

## 这次批准实际上在批什么

**唯一的实质变化是 `source_refs_maximum: 131 → 133`**，其余 19 个字段与前代逐字节相同（已自检确认）。

133 从哪来：131 + 两个新文件。那两个文件是为了**避免原地修改**一个被 64 份产物钉住哈希的共享 signing 模块而新增的副本。

**必须知道的冲突**：`BoundedSeriesApplicability20260910.json` 的 `excluded` 字段逐字包含

> Production, paid/model budget, Gold, A03-A11 formal business measurement, new root or identity, **cap extension**, automatic retry, refund.

抬高一个上限就是 cap extension。代码不拦它（`context.mjs:165` 只执行三个布尔值，`excluded` 是散文），但冲突不因此消失。这与你此前已批准的前推额度 15→16 是**同一性质的第二次**。

候选文件的 `what_changed_from_predecessor` 字段里已把这段冲突如实写入，`independently_reviewed: false`。

## 时序（硬约束，来自代码）

```
2026-09-12T00:00:00Z ≤ 你的 approved_at
                     ≤ 继任者的 accepted_at
                     ≤ 运行时刻
                     <  2026-09-19T00:00:00Z
```

三者须**依次递增**。不得盖同一时间戳再倒排顺序。当前已在窗口内，所以取"现在"即可。

## 已完成的填写

Owner 指示「沿用旧写法，你填上」，四个字段已由实施方填入：

| 字段 | 值 |
| --- | --- |
| `approved_at` | `2026-09-12T00:54:15.197Z`（在窗口内） |
| `authority` | `user_explicit`（沿用前代形式） |
| `approval_text` | `行 按你的建议来` |
| `source.messages` | 三条实际对话原文，各自批准了什么已逐条标注 |

**一处比原计划更准确的记录**：此前打算写「未针对该 cap extension 单独取得具体授权」。实际不然——实施方的建议里逐字写了「三处 131 上限抬到 133」，Owner 以「行 按你的建议来」批准。**该扩容在被批准之前已被指名**，因此文件记的是这一事实，而非一句泛泛的概括授权。

文件另含 `conflicts_with_governing_exclusion` 字段，逐字引用与之冲突的 `excluded` 条款，并标注 `independently_reviewed: false`。

已核验（控制器 `REAL_EXACT_CAPACITY_APPROVAL_REQUIRED` 六项 + 时序两项，8/8 通过）：

```
sha256   d06494658f1c9ee90e83951ab7a4ff33306ac9ff978f2d3a200baf50f2a8b0d7
blob_sha b923d2cf2c97b3a6707ea3714b81a990fa6858c8
bytes    6049
```

**注意：上述 blob_sha 只有在文件字节不再变动时才有效。** 若合并前又改动，须重算。

## 剩下要 Owner 做的

1. 开 PR，**创建合并提交**（非 squash / 非 rebase），base `main`，由你本人在 GitHub 上合并
2. 合并后把 merge commit 告诉实施方，核验签名链后把新批准的 blob / sha256 交给继任评估者

## 之后会发生什么

你的批准落地后，继任独立评估者才能出具容量适用性（它必须引用你这份批准的 blob 与 sha256——`same(d.approval_ref, s.capacity_materials.approval.ref)`）。适用性出具后，实施方重签运行时验收。三者齐备，运行才可能开始。

**你也可以不批。** 不批则本轮在现有证据下无法继续，已完成部分按原字节封存。这是你那份交接文档本来就写了的出路。

---

预算现实不变：`charged_seconds` 为 10506 上限中的 9906，**恰好只剩一次分配，没有重试**。
