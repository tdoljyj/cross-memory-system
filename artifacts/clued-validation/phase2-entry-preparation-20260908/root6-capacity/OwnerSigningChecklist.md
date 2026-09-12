# Owner 待签清单：root6 容量批准

**状态：`CANDIDATE_AWAITING_OWNER`。** 本清单与同目录的 [`CapacityApprovalCandidate.json`](CapacityApprovalCandidate.json) 由实施方起草。**候选文件不是批准**，它是一张表格；只有你补全四个字段并合并之后，它才成为批准。

## 为什么需要它

root6 控制器把 `capacityDelta.source_refs_maximum` 从 131 改为 **133**。该常量在三处被 `same()` 逐字节比对，全部为 131：

1. Owner 签署的容量批准 `f3afb108…` ← **本清单要解决的**
2. 独立容量适用性 `cc3db45b…` ← 继任评估者出具
3. 运行时验收自身的 `accepted_subject.capacity_delta` ← 实施方重签

三份缺一，运行在第一道容量检查上就失败。

## 你只需要填四个字段

候选文件里其余全部已按控制器强制值填好，并已自检通过（`capacity_delta`、`baseline`、`bounded_series_constraints` 三项与控制器常量的 `canonicalDigest` 完全一致）。

| 字段 | 说明 |
| --- | --- |
| `approved_at` | UTC 时间戳。**必须 ≥ `2026-09-12T00:00:00Z`，且早于继任者的 `accepted_at`，且早于运行时刻** |
| `authority` | 授权依据的类型 |
| `approval_text` | 你的批准原话 |
| `source` | 该批准出自何处 |

`limitations` 已从前代继承，你可以改。

## 关于前代的做法，必须先说清楚

前代那份批准（`f3afb108…`）的字段是：

```
authority      = "user_explicit"
approval_text  = "不要一直问我了，我授权你替我批准，直到完成此任务"
source.kind    = "CURRENT_CONVERSATION_USER_DELEGATION"
```

也就是说——**上一份容量批准是实施方援引你在对话里的一句概括性授权、代你起草并代批的。**

我不打算默认照抄这个做法，理由有二：

1. 这一次批准的实质内容是**一次 cap extension**，而它与治理文档的明示排除条款逐字冲突（见下）。用一句"我授权你替我批准，直到完成此任务"去覆盖一次明知与排除条款冲突的扩容，是把概括授权当成了具体授权。
2. 本系统在别处使用的权威形式是 **owner-merge 签名链**，比对话记述强得多。这份文件本来就要经你合并，那就让合并本身成为权威依据。

**如果你选择沿用 `user_explicit` 的写法，那也是你的决定，只是请明确说一句**，我会把「本批准沿用概括性对话授权，未针对该 cap extension 单独取得具体授权」如实写进文件。

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

## 步骤

1. 编辑 `CapacityApprovalCandidate.json`，把四个 `<<OWNER_MUST_COMPLETE>>` 换成实际值
2. 删除 `candidate_status` 与 `authority_effect` 两个字段（它们只是候选态标记，控制器不读，但留着会让文档自称"尚未生效"）
3. 提交并开 PR，**创建合并提交**（非 squash / 非 rebase），base `main`，由你本人在 GitHub 上合并
4. 合并后把 merge commit 告诉我，我核验签名链并把新批准的 blob / sha256 交给继任者

## 之后会发生什么

你的批准落地后，继任独立评估者才能出具容量适用性（它必须引用你这份批准的 blob 与 sha256——`same(d.approval_ref, s.capacity_materials.approval.ref)`）。适用性出具后，实施方重签运行时验收。三者齐备，运行才可能开始。

**你也可以不批。** 不批则本轮在现有证据下无法继续，已完成部分按原字节封存。这是你那份交接文档本来就写了的出路。

---

预算现实不变：`charged_seconds` 为 10506 上限中的 9906，**恰好只剩一次分配，没有重试**。
