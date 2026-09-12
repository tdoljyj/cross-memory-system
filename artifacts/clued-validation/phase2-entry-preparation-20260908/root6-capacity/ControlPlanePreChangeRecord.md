# 控制平面变更前的状态存档（出路 A 第 0 步）

**状态：`PRE_CHANGE_RECORD_NO_CHANGE_APPLIED`。**

Owner 于 2026-09-12 选择出路 A（变更控制平面）。本文件是动手之前的存档：记录四个待变更 `SECURITY DEFINER` 函数的当前 `prosrc` 摘要与规模。**未应用任何变更。**

## 为什么先做这一步

仓库既有惯例（见 `runtime-successor/binding-evidence-successor/alter.candidate.sql`）要求候选 SQL 以逐个断言前代函数 `prosrc` sha256 开头，任何一个漂移即拒绝应用，全部在一个事务内。这些摘要就是那些守卫的取值来源，同时也是「变更前世界长什么样」的唯一记录。

## 四个函数的当前状态（`2026-09-12T02:5x Z` 读取）

| 函数 | 参数 | `prosrc` sha256 | 字符数 |
| --- | --- | --- | --- |
| `append_status_manifest` | `p_raw text, p_sha text` | `94a444b9174251e8f655ea3a04e160898464caf1f94977cbce1590aff726c615` | 3,370 |
| `effective_execution_binding` | （无） | `c721b056a771a3a019d1f0cee862408ba56afcbd4d683f45802e8f51c0580d16` | **107,827** |
| `reserve_execution_budget` | `p_raw text, p_sha text` | `df6087f9d19d99f023a9c789f0c9b34140e92bb82fc00a5dde1d69d9b1aa7d41` | 13,404 |
| `reserve_gate` | `p_raw text, p_sha text` | `a011292416693ef7e44221868669937261c33848a3ff10882d0f4abd97c9ef2e` | 14,966 |

**合计约 139,600 字符的 PL/pgSQL。**

## 规模上必须说清楚的一点

`effective_execution_binding` 有 107,827 字符，因为它**每次绑定前推都追加一个分支**，现已累积 19 个。

这意味着出路 A 无法回避它：

- 若走「抬高两处 `series_f>15`」，第二十次前推仍需要该函数新增第 20 个分支
- 若走「让它直接产出 root6」，则是直接改写它

两条子路都要动这个 10 万字符的函数。

## 变更范围（据终局评估，最少五处）

| 函数 | 待改 |
| --- | --- |
| `reserve_gate` | `series_f>15`；root5 代际；`accepted_binding` 窗口字面量 |
| `reserve_execution_budget` | `series_f>15`；root5 代际；新预算 `expires_at` 字面量；`accepted_binding` 窗口字面量 |
| `append_status_manifest` | root5 代际；旧 schema 摘要 `76bb79f7…`；**已过期的** `expires_at` 字面量 |
| `effective_execution_binding` | root5 控制器摘要 `ac7bdd53`，或新增第 20 个前推分支 |

其中 `series_f>15` 一处需特别记明：**在数据库里抬高它，等于实施那条从未经独立评审、且已被证明建立在错误前提上的 override。** 该项应当由 Owner 单独重新决定，不得作为本次变更的顺带项。

## 尚未完成、且不得跳过的步骤

1. 取回四个函数的完整定义并存档（本文件仅存摘要）
2. 按既有惯例撰写候选 SQL，以四个 `prosrc` 漂移守卫开头
3. **交继任独立评估者复核**
4. Owner 合并
5. 应用，并立即只读回读

## 边界

未应用任何变更。未写库、未注册代际、未消耗那唯一一次分配（`charged_seconds` 仍为 9906/10506）。本文件不接受任何对象、不签发任何资格，也不构成对变更内容的建议。
