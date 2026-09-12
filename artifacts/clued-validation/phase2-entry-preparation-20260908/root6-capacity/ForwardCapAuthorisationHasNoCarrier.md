# 撤回：`series_f` 走「换发补充适用性文件」这条正路，技术上不通

**状态：`RETRACTS_MY_OWN_ACCEPTANCE_NO_WRITE_PERFORMED`。**

**未写库、未注册代际、`charged_seconds` 仍为 9906/10506。**

第八轮评估者在其第五节建议：`context.mjs:164` 要求
`appendix.independent_reviewer === '/root/project_list_auth_fix'`，而
`OwnerForwardCapExtensionOverride.json` 自承选择 override 的唯一理由是该评审身份不存在；
本轮 Owner 已授权继任评估者以该字符串签发，**故「换发补充适用性文件」这条正路是通的**，
不该再走 override 捷径。

我在 `ImplementerResponseToRound8.md` 第四节写了「采纳」。**现予撤回。**
动手准备之前先查了这条路能否承载 forwards 授权，答案是不能。

---

## 一、前推限额到底由什么决定

主源，`control-context-verifier-root6-window10-successor/context.mjs`：

```js
// :18  控制器里一个独立的冻结常量
export const qualificationLimits=Object.freeze({
  allocations:9, forwards:16, seconds:10506, evidenceBytes:2335812531,
  originalInputBytes:4000000, publicationBytes:8388608});

// :176  真正执行限额的那一行
need(budgets.length<=qualificationLimits.allocations
  && newAttempts.length<=qualificationLimits.allocations
  && forwards.length<=qualificationLimits.forwards,
  'NINE_ALLOCATIONS_AND_GAS_SIXTEEN_FORWARDS_MAXIMUM');
```

**前推限额取自 `qualificationLimits.forwards`，不取自任何签名文档。**

---

## 二、三个可能的载体，逐个排除

### （1）`BoundedSeriesApplicability`（评估者建议的那份）——**装不下**

`context.mjs:164` 要求 `same(appendix.scope, scope)`——appendix 的 `scope`
必须与控制器的 `scope` 常量**逐字段相同**。实测 `BoundedSeriesApplicability20260910.json`
（`f8ed552e…`，2,615 B）的 `scope` 确与控制器 `:151` 逐字段相同，其中：

```json
"maximum_new_forward": 3
```

两件事因此同时成立：

- **新换发的 appendix 的 `scope` 仍必须是这一份**，否则 `same()` 失败。
  也就是说它只能继续声明 `maximum_new_forward: 3`。
- **控制器根本不用 `scope.maximum_new_forward` 限制前推**——用的是 `qualificationLimits.forwards`。
  实测已执行 **15** 次前推，是 `scope` 所写 3 的五倍，而控制器一次都没有拦。

appendix 的 15 个顶层字段里**没有任何一个能表达前推限额**。
换发一份新的，只会得到一份同样说 `maximum_new_forward: 3` 的文件。

顺带：该文件的 `excluded` 明文含 `"cap extension"`——**这份文件不但装不下这个授权，还明文排除它。**

### （2）容量补充层 `capacity_delta`——**没有这个字段**

`context.mjs:113` 的 `capacityDelta` 共 20 个字段，全部为字节尺寸、计数与布尔标志：

```
original_input_bytes_before/after, original_input_kind_before/after, ga_raw_bytes,
control_request_and_grr_bytes, evidence_index_bytes, first_frame_bytes, second_frame_bytes,
publisher_request_bytes, publisher_response_bytes, source_batch_response_bytes,
source_refs_maximum, root_strict_json_bytes, original_field_count,
original_nineteen_oracles_unchanged, old_signed_objects_rewritten, new_root,
new_signing_identity, refund
```

**含 `forward` 的字段：零个。**

这正是 `source_refs_maximum`（131→133）与 forwards（15→16）的关键差别：
前者在 `capacity_delta` 里，有 proposal → approval → capacity applicability 三级文档承载；
**后者没有任何一级。**

### （3）`scope` 本身——**不能改**

`scope` 被 appendix、approval、runtime acceptance 三处 `same()` 钉住，
且它是 root3 时代的原始边界。改它等于作废整条链。

---

## 三、结论与更正

**`qualificationLimits.forwards` 是一个没有任何文档载体的控制器常量。**
把它从 15 改到 16，在仓库侧就是改一个数字；数据库侧对应的 `series_f > 15` 是另一个独立的数字。
两侧都没有签名文档钉住它是 15 还是 16。

因此：

- 评估者的建议**不适用于本项**。它对 `source_refs_maximum` 那类是对的（那类确有载体），
  对 forwards 不成立。我采纳得太快——**在验证载体存在之前就接受了一条建议**，
  这与我此前「全盘接受九条 finding、其中两条本应回推」是同一个毛病。
- `OwnerForwardCapExtensionOverride.json` 走 override，**并不是因为选错了路，而是因为没有别的路**。
  它真正的缺陷是另外两条，评估者 R8-F4 说得对：
  1. 从未经独立评审
  2. 其授权范围只写了「`context.mjs` 里的一个常量」，实施方把它外推到了数据库强制层

## 四、正确做法（替代被撤回的那条）

不换发 appendix。改为：

1. **授权载体已经就位**：`bootstrap/next-window-20260912/ExplicitOwnerApproval.candidate.json`
   中的 `forward_cap_extension` 小节，已明确写成 cap extension 而非维护，
   已载明 override 的两条缺陷，已说明它**不授予任何新的执行容量**
   （`series_n`、`charged_seconds ≤ 10506`、`charged_evidence_bytes ≤ 2335812531` 一个未动，
   移窗前后都只剩一次 600 秒分配）。
   **该小节同时覆盖仓库侧常量与数据库侧 `series_f`**，堵住 R8-F4 指出的外推。
2. **缺的只是独立评审意见**：请继任评估者以 `/root/project_list_auth_fix` 身份，
   对该小节单独出具意见。这补上 R8-F4 的第 1 条缺陷，且不需要一条走不通的正路。
3. Owner 在第一次合并中一并批准。

## 五、一条应当记下的结构性观察

`qualificationLimits` 的六个值**全部**没有文档背书。其中
`seconds:10506` 与 `evidenceBytes:2335812531` 恰好等于 `execution_current` 的两条表级 CHECK 上界
——那两个在数据库侧有强制；`allocations:9` 对应 `series_n>9`。
**唯独 `forwards:16` 与数据库侧的 `series_f>15` 此刻不一致**，是六个值里唯一一个两侧不同步的。

这不改变本文结论，但说明：**仓库侧那个常量表，一直是靠与数据库侧数字巧合一致来「生效」的，
而不是靠文档授权。** 这一点此前无人记录，也请评估者复核。

---

## 边界

未写库、未注册代际、未消耗那唯一一次分配、控制器自 `a573ca9` 起零改动。
本文件撤回实施方自己此前的一条采纳，不构成新的授权，也不是候选 SQL。
