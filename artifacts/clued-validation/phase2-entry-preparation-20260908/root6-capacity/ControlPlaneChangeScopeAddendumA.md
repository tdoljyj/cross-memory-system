# 补遗 A：`ControlPlaneChangeScope.md` 第四节的推荐作废

**状态：`ADDENDUM_CORRECTS_OWN_RECOMMENDATION_NO_WRITE_PERFORMED`。**

由实施方（`session_012ki2dPxTiJbPmgZu7AD3Nz`）在提交主文件之后、候选 SQL 之前写成。
读取时刻 `2026-09-12T03:2xZ`。**仍未写库、未注册代际、`charged_seconds` 仍为 9906/10506。**

主文件第四节推荐 **A-i：把 Owner 窗口移到 `2026-09-19T00:00:00Z`**，并称它能保住
控制器 `72d9eb92…` 及其已签文档。**该推荐不可行，现予作废。** 理由如下。

---

## 一、先说两件我漏查的东西，以及它们为什么不是漏洞

主文件把「移动 Owner 窗口」写成一行数据变更。查了表级对象之后：

```
TRIGGER accepted_binding_immutable
  BEFORE DELETE OR UPDATE OR TRUNCATE ON clued_control.accepted_binding
  FOR EACH STATEMENT EXECUTE FUNCTION clued_control.deny_mutation()

CHECK accepted_binding_check
  (expires_at <= '2026-09-12 13:14:51+00'::timestamptz AND expires_at > not_before)

CHECK accepted_binding_owner_approval_commit_check
  (owner_approval_commit = '4498102661f626c8e0c489c7d27551acbc8436ea')
```

一条 `UPDATE` 会被触发器拒；即便绕过触发器也会被 CHECK 拒；
而且 Owner 批准 commit 被硬钉着，改窗口不改它等于**拿旧批准背书新窗口**。

我一度把这记成「第七次范围扩大」。**它不是。** `4498102661f6` 是 PR #149 的合并，
其中 `ExplicitOwnerApproval.candidate.json` 有一节 `nw01`，把整套动作预先授权了：

```json
"nw01": {
  "reuse_existing_reviewed_mechanism": true,
  "row": "clued_control.accepted_binding",
  "allowed_changed_fields": ["not_before","expires_at","owner_approval_commit",
                             "subject_sha256","registration_acceptance_sha256",
                             "store_acceptance_sha256","signature_evidence_sha256"],
  "allowed_replaced_checks": ["accepted_binding_check",
                              "accepted_binding_owner_approval_commit_check",
                              "accepted_binding_subject_sha256_check"],
  "temporarily_disabled_trigger": "accepted_binding_immutable",
  "trigger_must_be_restored_same_transaction": true,
  "fail_closed_on_mismatch": true
}
```

**所以「同一事务内临时停用触发器、替换三条 CHECK、改窗口、恢复触发器」是既评审过、既授权的机制**，
不是我以为的破坏性动作。范围没有扩大——**是我不知道这个机制已经存在**。这一条应记为
「实施方查得不足」，不是「新增风险」。

---

## 二、真正的问题：同一份文档把窗口锁死在 24 小时

```json
"window_rule": {
  "not_before_source": "VERIFIED_OWNER_MERGE_COMMIT_COMMITTED_AT",
  "duration_seconds": 86400,
  "expires_at_rule": "not_before + 86400 seconds",
  "rolling": false, "auto_renew": false, "backdate": false
}
```

窗口 = **Owner 合并时刻 + 恰好 86400 秒**，不滚动、不自动续期、不回溯。
实测印证：PR #149 合并于 `2026-09-11T13:14:51Z`，`accepted_binding` 即
`2026-09-11T13:14:51Z .. 2026-09-12T13:14:51Z`，分秒不差。

**`2026-09-19T00:00:00Z` 距今 7 天。这个机制永远给不出这个值。**
Owner 现在合并一份新批准，最远只能到明天此刻。

**A-i 不可行。不是「代价大」，是无法被授权。**

---

## 三、这条错误比它看上去更深

主文件第四节我写过：root6 控制器要求新预算 `expires_at = 2026-09-19T00:00:00Z`
（`expiryForBudget(89) = root6Expiry`）。

`root6Expiry = '2026-09-19T00:00:00Z'` 是**我在构建 root6 时自己定的**。
现在清楚了：**这个值在 Owner 窗口机制下从一开始就无法被满足。**

此前我已更正过一次相关陈述——「把控制器窗口延到 09-19 等于有一周余量」只在仓库侧成立。
当时我把它理解为「数据库窗口更短，所以要赶时间」。**真实情况更重：7 天这个数
在这套机制里根本不是一个可授权的值。** 我在仓库侧单方面造了一个数据库侧不可能兑现的常量，
然后围绕它签了资格文件与运行时受理。

---

## 四、剩下的唯一可行路径

| | 判定 |
| --- | --- |
| A-i：延窗到 09-19 | **不可行**——机制硬上限 24 小时 |
| 改数据库 `:125` 要求 09-19 | **不可行**——`:135` 要求预算 `expires_at ≤ accepted_binding.expires_at` |
| 连 `:135` 一并放宽 | **不采纳**——那是拆掉「预算不得超出 Owner 窗口」这条实质约束，比延窗坏得多 |
| **A-ii：重建控制器，使 `root6Expiry` 落在新 Owner 窗口内** | **唯一可行** |

### A-ii 的真实代价（比主文件第四节估的小）

`root6Expiry` 在控制器里出现三处，只有一处是硬性的：

- `:43` `time(runtime.expires_at) <= time(root6Expiry)` —— 上界，宽松
- `:156` `expiryForBudget(89) = root6Expiry` —— **精确相等，硬**
- `:169` `now < root6Expiry`（`FIXED_OWNER_CUTOFF_NO_DISPATCH`）—— 上界，宽松

**改一个常量即可，三处自动一致。** 但改常量 = 新控制器摘要 = 连带重签：

- `ControllerSourceManifest.candidate.json`（新摘要）
- 资格文件 `f5b18b54…`（钉控制器摘要）
- 运行时受理 `3f3c9cf3…`（钉控制器摘要）
- 以上三者的 Owner 合并

**四份 capacity 文档（proposal / approval v2 / applicability / 043 repair acceptance）不受影响**——
它们钉的是 `capacity_delta`，不是窗口。主文件说「四份文档链要重走一遍」，**估大了**；
实际是三件、一次 Owner 合并。

### 顺序变了：Owner 合并必须先发生

因为新的 `root6Expiry` 等于新窗口末端，而新窗口末端 = **Owner 合并新批准 PR 的时刻 + 24h**，
这个时刻在合并之前不可知（`materialize_exact_timestamps_after_verified_merge: true`）。

所以：

1. Owner 合并新的 `ExplicitOwnerApproval`（沿用 PR #149 的形状）→ 得到 commit C 与时刻 T
2. 事务一：按 `nw01` 停触发器、替换三条 CHECK、写入 `T .. T+24h` 与 `owner_approval_commit=C`、恢复触发器
3. 用 `T+24h` 作为 `root6Expiry` 重建控制器；重签资格与运行时受理；Owner 合并
4. 事务二：改三个函数（主文件第七节的 19 处，其中所有 `2026-09-19T00:00:00Z` 一律换成 `T+24h`，
   所有 `2026-09-12T13:14:51Z` 亦然）
5. 注册 root6（注册体的 `expires_at` 也取 `T+24h`，以满足 `:43` 的 `runtime.expires_at === registered.expires_at`）
6. 第 20 次前推 → Status24 → 预算 → GA → 600 秒 → 19 项观测 → GRR

**第 3 步依赖第 1 步的产出，无法提前。** 这是本轮第一次出现「Owner 动作卡在关键路径中段」。

---

## 五、时间

现在 `2026-09-12T03:2xZ`。当前窗口 `13:14:51Z` 到期，预算真实截止 `13:04:51Z`（约 9.7 小时）。

若走 A-ii，第 1 步一旦完成，时钟重置为 24 小时，当前这个 9.7 小时不再有约束力。
**因此不要为了赶 13:04:51Z 而跳过任何一步。** 继任者第七轮的提醒仍然适用：
**窗口 Owner 可以重开，`SECURITY DEFINER` 函数改坏了不能。**

---

## 六、给继任独立评估者的追加复核项

主文件已请你复核六件事。追加三件，并**撤回其中第（3）项的原措辞**
（那一项问「把窗口移到 09-19 是否正当」——该问题已无意义，因为它不可行）：

- **（7）§二 的 24 小时上限判定是否正确。** `window_rule` 是否真的排除了任何长于 86400 秒的窗口？
  有没有别的机制（另一份 Owner 批准、另一条既有先例）能给出更长的窗口？
  **如果有，A-ii 就不是唯一路径，请指出。**
- **（8）§四 「四份 capacity 文档不受影响」是否成立。** 逐份核实它们钉的是不是只有 `capacity_delta`，
  有没有哪一份间接钉了控制器摘要或窗口。**我这次是往小里估的，按前六次的记录，请重点查。**
- **（9）§一 的 `nw01` 授权是否覆盖本次用途。** PR #149 的批准是为「09-11 那次窗口延续」签的。
  它的 `nw01` 能不能被**第二次**复用来支撑一次新的延窗？
  `reuse_existing_reviewed_mechanism: true` 指的是复用机制，还是复用这一次授权？
  **若是后者，则每次延窗都需要一份新的 Owner 批准文档——那是第 1 步的前提，不能省。**

---

## 边界

未写库、未注册代际、未消耗那唯一一次分配、控制器自 `a573ca9` 起零改动。
本文件作废自己先前的一条推荐，不构成新的推荐，也不是候选 SQL。
