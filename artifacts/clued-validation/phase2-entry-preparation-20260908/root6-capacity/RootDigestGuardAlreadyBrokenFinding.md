# 发现：`reserve_gate` 与 `reserve_execution_budget` **此刻已经坏了**，且新守卫无法预先写死

**状态：`BLOCKING_FINDING_NO_WRITE_PERFORMED`。**

由实施方在**开写 CP-01 候选 SQL、取三个函数完整 `prosrc` 时**发现。
**未写库、未注册代际、`charged_seconds` 仍为 9906/10506。**

第九轮放行候选 SQL 时列的输入是「19 处编辑」。**那个清单漏了两处，
而这两处不是补一行就完事——它们让 CP-01 现有的授权范围不够用。**

---

## 一、事实

`reserve_gate` 与 `reserve_execution_budget` 各含一条守卫（两个函数逐字相同）：

```sql
if encode(sha256(convert_to((series_view->'root')::text,'UTF8')),'hex')
   is distinct from '4ddd23b52ba396909640c7bdbc60217b0f34a840d5e950901b20e4b3c17502a0'
then raise exception 'series_full_original_root_changed'; end if;
```

其中 `series_view := clued_control.read_execution()`，而实测
`read_execution()->'root'` **就等于** `read_root('ctr_414bd3c7…')`（`= true`）。

**该摘要此刻的实际值是 `e7624fda1441e309bfa3bdd2afb8a00f8636199ab201b3e5ecfadf46214bc109`，
不是守卫期望的 `4ddd23b5…`。**

> 顺带一个交叉印证：`e7624fda…` 正是第九轮评估者导出 `read_root` 快照时算出的 sha256。
> 两条互不相干的路径得到同一个值。

**即：这两个函数现在就会抛 `series_full_original_root_changed`。
与 root6 无关，与本轮任何计划无关——它们已经坏了。**

## 二、为什么至今无人发现

`root` 对象含七个键：`authority_effect`、`events`、`generation_id`、
**`metadata_binding_sha256`**、`root_set_id`、`sequence`、`state`。

其中 `metadata_binding_sha256` **就是整行 `accepted_binding` 的摘要**
（实测 root 里的值与 `sha256(to_jsonb(accepted_binding_row)::text)` 相同，均为 `356416e8…`）。

09-11 那次库外窗口迁移改了 `accepted_binding` → `metadata_binding_sha256` 变
→ `root` 摘要变 → **这条守卫从那一刻起就不成立**。而那次迁移没有更新它。

时间线对得上，且解释了为什么没人撞上：

| 事件 | 时刻 |
| --- | --- |
| 最后一次成功 `BUDGET_RESERVED` | `2026-09-11 03:47:18Z` |
| 库外改写 `reserve_gate` / `reserve_execution_budget` | 同日 `08:59–17:02Z` |
| 最后一次前推（不经这两个函数） | `2026-09-11 17:35:39Z` |

**改写之后，这两个函数一次都没有被成功调用过。** 守卫坏在那里，无人触发。
第八、第九轮都只读函数文本、没有（也不应该）真的去调用，所以读不出来。

**这是 09-11 那次无 PR、无评审、未过迁移表的改写留下的第二个坑。**
第一个是 `append_status_manifest` 被整个跳过。同一次事故，两处后果。

## 三、为什么不能像其它 19 处那样「换个字面量」

新值必须是**注册 root6 之后**的 `root` 摘要——因为 `reserve_*` 是在注册之后才被调用的
（运行手册第 16、17 步）。而那个值**不可预测**：

- `root.metadata_binding_sha256` 会被 NW-01 改变（第 8 步），这一层尚可推算；
- 但 `root.events` 在注册后多出第 6 条，**其元素含 `recorded_at`**
  （实测 `event_element_keys = [idempotency_key, recorded_at, request, root_id, sequence]`），
  而 `recorded_at` 由数据库 `clock_timestamp()` 生成。

**一个含插入时刻的字段进了摘要，摘要就无法在插入之前算出来。**

## 四、这超出了 CP-01 现有的授权范围

`ExplicitOwnerApproval.candidate.json` 的 `cp01.permitted_edit_classes` 是五类：
代际钉、序列区间、窗口字面量、status schema 摘要、`series_f` 上限。
**这条守卫一类都不属于。** 无论怎么处理它，都需要 Owner 追加授权。

四条可能的路，实施方**不做选择，列出供 Owner 与评估者裁决**：

| | 做法 | 代价 |
| --- | --- | --- |
| **(a)** | 摘要改为对**排除 `events` 后**的 root 计算 | 放宽守卫：root 的历史不再被这条覆盖 |
| **(b)** | 摘要改为对**剥掉每个事件 `recorded_at` 后**的 root 计算 | 同样改形状，但保留事件内容 |
| **(c)** | CP-01 **不动这条**；注册 root6 之后、任何 `reserve_*` 调用之前，用第二个受守卫的小事务把它更新为**届时从库内读出的实际值** | 不放宽任何守卫；代价是多一次 `SECURITY DEFINER` 替换，需单独授权与评审 |
| **(d)** | 改为断言 root 的结构化字段（`generation_id`、`sequence`、`state`、`root_set_id`）而非整体摘要 | 语义更清楚，但仍是改形状 |

**实施方倾向 (c)**，理由只有一条：它是四条里**唯一不削弱守卫**的。
(a)(b)(d) 都在「让守卫能通过」的方向上改守卫本身，而那正是本轮治理问题最敏感的地方——
**被资格审查的一方修改强制层，使自己的运行通过。** (c) 至少保持这条守卫的强度不变，
只是把它的取值推迟到能诚实取到的那一刻。

但 (c) 也有代价必须说明：它在注册与预算之间插入第二次函数替换，
**那段时间里两个函数是坏的**——虽然那段时间内本来就不调用它们，
但「先注册、再修函数、再预算」这个次序需要独立评审确认没有别的路径会撞上。

## 五、还应当查而未查的

这条守卫是靠**取完整 `prosrc` 逐字读**才发现的，此前所有扫描
（`ctrgen_`、窗口字面量、`series_f`、`>= 64`）都扫不到它——**它只是一个 64 位十六进制串。**

因此我把三个函数里**每一个** 64 位十六进制常量都取出来逐个判定了
（`regexp_matches(prosrc,'[0-9a-f]{64}','g')`，共 6 个）。
下表每一行都是**实测**，不是从守卫逻辑推断——在库里重算了各自的表达式与期望值比对
（`2026-09-12T05:5xZ`）：

| 摘要 | 出现于 | 守的是什么 | 实测 |
| --- | --- | --- | --- |
| `4ddd23b52ba39690…` | `reserve_gate`、`reserve_execution_budget` | `read_execution()->'root'` 整体 | **不成立**（实际 `e7624fda…`） |
| `7f28f748c5ca671b…` | 同上两个 | 前 44 条 `execution_events` | 成立 |
| `b5ed3460a9447b82…` | 同上两个 | 六次原始尝试 | 成立 |
| `76bb79f727890512…` | `append_status_manifest` ×2 | root5 status schema（严格 + 白名单） | 已在 19 处清单内 |
| `6ba12ed51b3fc0e4…` | `append_status_manifest` | 白名单成员 | 历史值，不动 |
| `e6bf45a014926fe5…` | `append_status_manifest` | 白名单成员 | 历史值，不动 |

**六个里只有一个坏了，就是第一行。** 另外两条摘要守卫不受注册 root6 影响
（`execution_events` 的前 44 条与六次原始尝试都不会因注册而变），可以原样保留。

这张表本身也是一条方法教训：**此前所有扫描都是按模式找的**
（`ctrgen_`、窗口字面量、`series_f`、`>= 64`），而这条守卫只是一个 64 位十六进制串，
一个模式都不匹配。**按类型穷举，比按已知模式搜索，多找出一个阻断级问题。**

---

## 边界

未写库、未注册代际、未消耗那唯一一次分配、控制器自 `a573ca9` 起零改动。
全部为只读 `select`（含 `STABLE` 的 `read_execution()` / `read_root()`）。
本文件不接受任何对象、不签发任何资格、不构成授权，也不选择第四节任何一条路。
