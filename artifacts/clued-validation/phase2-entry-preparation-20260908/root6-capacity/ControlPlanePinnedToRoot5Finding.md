# 发现：控制平面的存储过程钉死在 root5，root6 迁移在数据库侧从未可行

**状态：`BLOCKING_FINDING_NO_WRITE_PERFORMED`。**

由实施方（`session_012ki2dPxTiJbPmgZu7AD3Nz`）在**执行 root6 注册之前**的最后核查中发现。**未进行任何数据库写入。** 提交给继任独立评估者复核。

> **这个结论太重，不该只有一个人看过。** 它意味着仓库侧六轮复核做出的全部成果，在数据库侧从一开始就无法执行。实施方可能读错了某处，请独立证伪。

## 一句话

root6 迁移改的是**仓库里的控制器源码**。但 Clued 控制平面的四个 `SECURITY DEFINER` 存储过程**各自硬编码了 root5 的代际 id 或控制器摘要**，它们不在仓库里，六轮复核从未检查过它们。

## 证据：四处硬钉（原样截取自 `pg_get_functiondef`）

### 1. `append_status_manifest` —— Status24 无解

```sql
if obj->>'schema_digest' is distinct from
     '76bb79f7278905122474f86fe195cb803e3cb5185a4a50899403fa5567726ae0'
 or obj->>'control_trust_root_generation' is distinct from
     'ctrgen_e5df432221344996afc04b5638121d96'
 or (obj->>'expires_at')::timestamptz is distinct from
     '2026-09-11T10:21:05Z'::timestamptz
then raise exception 'ordinary_root5_status_schema_required'
```

数据库**只接受 root5 的 status manifest**，且必须用旧 schema 摘要 `76bb79f7…`、必须声明**昨天已过期**的 `2026-09-11T10:21:05Z`。

而 `context.mjs:310` 要求 `sm.control_trust_root_generation === generation`（root6），`:308` 要求 schema 等于本地 root6 副本（`5e315000…`）。

**互斥无解。** 数据库只肯存 root5 状态，控制器只肯接受 root6 状态。

### 2 与 3. `reserve_execution_budget` 与 `reserve_gate` —— 预算与 GA

两者含同一段：

```sql
or series_view->'root'->>'generation_id' is distinct from
     'ctrgen_e5df432221344996afc04b5638121d96'
```

即**活动根代际必须是 root5**。

### 4. `effective_execution_binding` —— 绑定解析

```sql
value->'new_binding' is distinct from
  '{"controller_sha256":"ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa", ...}'::jsonb
```

钉住的是 **root5 控制器摘要**，不是 root6 的 `72d9eb92…`。

## 为什么注册 root6 会让情况**更糟**，而且不可回退

`append_event` 成功后执行：

```sql
update clued_control.current_head set sequence=h.sequence+1,
  generation_id = case when kind='GENERATION_REGISTERED' then gen else h.generation_id end, ...
```

于是 `current_head.generation_id` 变为 root6，`read_execution()->'root'->>'generation_id'` 随之变为 root6。

后果：

- `reserve_execution_budget` 抛错（要求 root5）
- `reserve_gate` 抛错（要求 root5）
- root5 控制器的 `CURRENT_ROOT_GENERATION_REQUIRED` 也失败（活动头不再是 root5）

**root5 通路被打断，root6 通路并未打开。运行彻底搁浅，且注册不可回退。**

这正是本次核查要防的事。**未执行注册。**

## 另一条此前未被记录的时钟

`append_event` 受 `clued_control.accepted_binding` 的窗口管辖：

```sql
if clock_timestamp() < b.not_before or clock_timestamp() >= b.expires_at
  then raise exception 'owner_window_inactive'; end if;
```

实测：`accepted_binding` 窗口为 **`2026-09-11T13:14:51Z .. 2026-09-12T13:14:51Z`**，查询时刻 `2026-09-12T02:35:32Z`，`append_allowed_now = true`。
`reserve_execution_budget` 与 `reserve_gate` 亦各含两处 `2026-09-12T13:14:51Z`。

**实施方此前把控制器窗口延长到 `2026-09-19T00:00:00Z`，并向 Owner 陈述「一周余量、不用赶」。该陈述只在仓库侧成立，对数据库侧毫无作用。** 数据库侧的真实截止是 `2026-09-12T13:14:51Z`。这是实施方的疏漏，在此更正。

## 复核请求

请独立证伪或确认下列各项：

1. 四处硬钉是否确如上述（建议直接 `pg_get_functiondef` 自行截取，不要采信本文引用）
2. 注册 root6 是否确实会同时打断 root5 通路且不打开 root6 通路
3. `accepted_binding` 与三个函数的窗口值
4. **是否存在实施方没想到的第三条路**——既不改数据库函数，也不回到已过期的 root5

## 已知的两条路，都不轻

**A. 变更控制平面** —— 把四个存储过程的 root5 钉改为 root6。这是 `SECURITY DEFINER` 函数的 schema 变更，是本轮迄今最重的一次改动，需要新的 Owner 授权与独立评审。注意 `append_status_manifest` 还钉着一个**已过期的时间戳**，即便不迁移 root6，Status24 也已经无法追加。

**B. 放弃 root6** —— 但 root5 的控制器窗口 `2026-09-11T10:21:05Z` 已过期，那正是整件事的起点。

## 应当记下的一句

仓库侧做到了四份文档齐备、六轮独立复核、控制器零漂移。但**从第一轮起就没有人问过「数据库那边准备好了吗」**。实施方应当在动手迁移之前先查执行路径，而不是在最后一步之前才查。

## 边界

未写入数据库。未消耗那唯一一次分配（`charged_seconds` 仍为 9906/10506）。未注册任何代际。控制器自 `a573ca9` 起未改动一个字节。
