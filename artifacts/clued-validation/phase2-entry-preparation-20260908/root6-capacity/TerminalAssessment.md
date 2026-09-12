# 终局评估：本轮资格运行在现有控制平面下无法完成

**状态：`TERMINAL_ASSESSMENT_NO_WRITE_PERFORMED`。**

由实施方（`session_012ki2dPxTiJbPmgZu7AD3Nz`）撰写，采纳继任独立评估者（`session_018nf6mQ5CQuMFadoJ9WRZCN`）第七轮复核。所有主张均已由实施方独立重算确认，未采信转述。

**未进行任何数据库写入。未注册任何代际。`charged_seconds` 仍为 9906/10506，那唯一一次分配未被消耗。**

## 一、真正的锁不是代际钉

实施方上一份文档把阻塞定性为「四处 root5 代际钉」。**该定性不完整，而且不是主因。** 继任者指出真正的锁，实施方重算确认：

```sql
-- reserve_gate 与 reserve_execution_budget，各一处
series_f > 15  →  raise
```

实测序列 ≥45 的前推数为 **15**。第 16 次前推会让**预算预留与 GA 签发同时抛错**。

而 `reserve_gate` 要求 GA 的 `controller_digest` 与 `controller_qualification_ref.sha256` 逐字段等于 `effective_execution_binding()` 的产出——即 `ac7bdd53`（root5 控制器）与 `dfe6299d`（root5 v16 资格）。**移动这个绑定唯一的办法是追加一次前推，而前推额度已满。**

结论：**绑定永远停在 root5 控制器上。把四处代际钉全改成 root6 也一样。**

## 二、第三条路不存在

三步闭合，每步独立成立：

1. 任何运行必须先经 `reserve_gate` 取得 GA
2. 它能签出的 GA 被锁死为「root5 代际 + `ac7bdd53` 控制器」
3. 摘要为 `ac7bdd53` 的控制器自己写着
   `need(Date.parse(now) < Date.parse('2026-09-11T10:21:05Z'), 'FIXED_OWNER_CUTOFF_NO_DISPATCH')`
   ——**昨天即已失效**

两片钳口各自成立：数据库只肯签 root5 的 GA，root5 控制器自己拒绝在昨天之后调度。

继任者另行排除的候选路径（实施方确认其推理）：

- `rotate_execution_generation` 只动 runner / credential / session 三个代际，`field not in (...)` 即抛错，**不碰根代际**
- 只做 `RESULT_RECONCILIATION`、先预算后前推、改 `accepted_binding` 数据延窗、复用 Status23 —— 均在其文件中逐条记明为何不行

## 三、改 `accepted_binding` 延窗也被封死

```sql
(select expires_at from clued_control.accepted_binding where root_id=root)
  is distinct from '2026-09-12T13:14:51Z'::timestamptz
  →  raise 'series_current_root_window_mismatch'
```

两个函数各一处。**改数据延窗会让预算与 GA 立刻抛错。**

## 四、与代际无关的第二条独立矛盾

```sql
if v->>'expires_at' is distinct from '2026-09-12T13:14:51Z'
  then raise 'series_exact_new_budget_expiry_required'
```

新预算的 `expires_at` 必须**精确等于** `2026-09-12T13:14:51Z`，而 root6 控制器的 `expiryForBudget(seq>=89)` 要求 `2026-09-19T00:00:00Z`。**即便代际问题全部解决，这一条仍然无解。**

## 五、被推翻的一整条治理线索

数据库在 `reserve_gate` 与 `reserve_execution_budget` 两处将前推额度钉死为 15。这推翻了：

- `OwnerForwardCapExtensionOverride.json`
- 控制器的 `qualificationLimits.forwards: 16`
- `README` 治理事项二
- 继任者第二、三轮关于该额度的全部分析

它们共同的前提是「抬额度技术上可行，只是没有背书文档」。**该前提是错的：它根本执行不了。**

继任者当时拒绝背书的结论碰巧站得住，但它给出的不是真正的理由——真正的理由当时无人知晓。实施方向 Owner 陈述该额度「只欠一份背书文档」，同样是错的。

## 六、真实截止时刻，以及它为何不重要

```sql
clock_timestamp() + interval '600 seconds' >= '2026-09-12T13:14:51Z'  →  raise
```

故预留预算的真实截止为 **`2026-09-12T13:04:51Z`**，非此前所述的 13:14:51Z。

**但在控制平面变更落地之前，这个截止没有意义。** 继任者的提醒应当照录：窗口 Owner 可以重开，`SECURITY DEFINER` 函数改坏了不能。**不要因为这个时钟仓促动手。**

## 七、两条出路，都比先前描述的重

**A. 变更控制平面。** 不是「改四处代际钉」。至少还要：

- 让绑定能移动：在数据库里抬高两处 `series_f>15`（**这等于实施那条从未被独立评审、且已被证明是错误前提的 override**），或改 `effective_execution_binding` 直接产出 root6
- 新预算 `expires_at` 字面量
- `accepted_binding` 窗口字面量

**最少五处，跨三个 `SECURITY DEFINER` 函数。** 这是控制平面的实质性变更，需要新的 Owner 授权与独立评审，且远超本轮迄今任何一次改动。

**B. 放弃 root6 回到 root5。** 数据库侧同样不通：`append_status_manifest` 硬性要求 status manifest 的 `expires_at` **精确等于** `2026-09-11T10:21:05Z`，同时另有检查要求它晚于当前时刻——**双重无解，与 root6 无关**。Status24 在任何路径下都已无法追加。

## 八、停在注册之前是对的

- 注册 root6 会把 `current_head.generation_id` 改为 root6 → `reserve_execution_budget`、`reserve_gate` 立即抛错（均要求 root5），root5 控制器的 `CURRENT_ROOT_GENERATION_REQUIRED` 亦失败
- `append_event` 的 `generation_reuse_or_rollback` 会拒绝重新注册 root5 —— **没有回头路**

**root5 通路会被打断，root6 通路不会打开，且不可回退。**

## 九、应当记下的

仓库侧达成了四份文档齐备、七轮独立复核、控制器零漂移。这些工作本身是扎实的，每一轮抓到的问题都是真的。

**但七轮都在同一侧找。** 实施方在第一轮就该查执行路径，而不是在唯一一次不可逆写入之前才查。

继任者在其第七轮中写道：「实施方写『从第一轮起就没有人问过数据库那边准备好了吗』——这个『没有人』包括我。我把它写进『无法验证』六次，当成需要标注的盲区，而不是需要消除的盲区。」

**这句应当保留。** 一个被反复标注的盲区，如果六轮都没有人试图消除它，那么标注本身就成了掩护。

## 边界

未写库、未注册、未消耗分配、控制器自 `a573ca9` 起零改动。本文件不接受任何对象、不签发任何资格、不构成对出路 A 的建议或授权。
