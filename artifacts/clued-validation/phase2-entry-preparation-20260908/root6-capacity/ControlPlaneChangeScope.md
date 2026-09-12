# 出路 A 的完整变更范围（侦察完毕，未写任何库）

**状态：`CHANGE_SCOPE_RECONNAISSANCE_COMPLETE_NO_WRITE_PERFORMED`。**

由实施方（`session_012ki2dPxTiJbPmgZu7AD3Nz`）撰写，交继任独立评估者复核。
读取时刻 `2026-09-12T03:12:57Z`。**未写库、未注册代际、`charged_seconds` 仍为 9906/10506，那唯一一次分配未被消耗。**

本文件的每一条都取自主源（`pg_proc.prosrc`、`clued_control.events`、仓库内文件），
未采信任何此前文档的转述。**下文有三处更正了此前文档中的错误。**

---

## 零、先说范围又错了

`TerminalAssessment.md` 第七节写「**最少五处，跨三个 `SECURITY DEFINER` 函数**」。

实测：**19 处编辑，跨 3 个函数，外加 1 项数据变更、1 次绑定前推、1 份尚不存在的注册文档。**

这是我第六次把范围估小。前五次记录在案（三层→5；5 处跨 5 文件→8 跨 7；三份文档→四份；四处代际钉→至少五处跨三函数；外科替换字面量→结构性重做代际链）。**这一次的教训与前五次相同：我在读完全部主源之前就报了数字。** 本文件是在读完之后写的。

---

## 一、被证伪的省事方案：root5-window10

动手之前我先试图证明「根本不需要 root6」。理由看起来很强：仓库里 `root5-window5`、
`root5-window5-forward11`、`root5-final` 三个控制器**共用同一个代际** `ctrgen_e5df4322…`，
窗口 5 到窗口 9 都是**不换代际、只换窗口、用一次前推移动绑定**。按此先例，
「root5-window10」才是既定写法，root6 是我多造的。

若成立，数据库侧三个函数的代际钉全都不用动。

**它不成立。** 主源（`clued_control.events`）：

| sequence | generation | not_before | expires_at |
| --- | --- | --- | --- |
| 3 | `ctrgen_2e778ca6…` (root3) | 2026-09-09T10:42:01.414Z | 2026-09-10T10:13:16Z |
| 4 | `ctrgen_9cf53fa5…` (root4) | 2026-09-10T10:52:14.921Z | 2026-09-11T10:21:05Z |
| 5 | `ctrgen_e5df4322…` (root5) | 2026-09-10T13:18:47Z | **2026-09-11T10:21:05Z** |

控制器 `context.mjs:61`：

```js
currentWindow(body.not_before, body.expires_at, now);
// :47  function currentWindow(start,end,now){check(time(start)<=now&&now<time(end),'EXPIRED_OR_NOT_YET_VALID');}
```

`body` 是**最后一条 `GENERATION_REGISTERED` 事件的 body**。root5 的那条声明
`expires_at = 2026-09-11T10:21:05Z`，昨天已过。`now < expires_at` 为假。

**任何声明代际 root5 的控制器都会在 `:61` 挂在 `EXPIRED_OR_NOT_YET_VALID`，与它自己的窗口常量无关。**
事件表只追加不修改，那条注册事件改不了。要拿到一个仍然有效的注册窗口，
只能追加一条新的 `GENERATION_REGISTERED` —— 即换代际。

**root6 是必要的。省事方案不存在。** 这一条请重点复核：它是整个出路 A 的地基。

---

## 二、更正此前文档的三处错误

1. **`append_status_manifest` 不止一处 schema 钉。** 第 8 行还有一个三元素白名单
   （`6ba12ed5…`/`e6bf45a0…`/`76bb79f7…`），第 27 行才是严格相等。两处都要动。
2. **root6 的 status schema 摘要是 `510f3b90cdb026c8c4d44ffac2647502ff8003cdd972850dbe042edbd6c310ef`**，
   不是我先前记的 `5e315000…`。已由 `ControllerSourceManifest.candidate.json` 与
   `ExactRoot5FinalPreentryControllerRuntimeAcceptance.json`
   的 `accepted_subject.control_schema_refs.StatusManifest.sha256` 双向确认。
3. **`effective_execution_binding` 不需要手写。** 见第五节。

---

## 三、三个代际分段是「区间」，不是「等值」

此前文档只说「历史分段」，没说清结构。实测（`reserve_gate` 第 58-66 行，
`reserve_execution_budget` 同构）：

```sql
or ((series_e->>'sequence')::bigint >= 64 and (
     series_budget->>'root_generation' is distinct from 'ctrgen_e5df4322…'   -- root5
     or series_budget->>'expires_at'   is distinct from '2026-09-11T10:21:05Z'))
or ((series_e->>'sequence')::bigint >= 59 and (series_e->>'sequence')::bigint < 64 and (
     … root4 … '2026-09-11T10:21:05Z'))
or ((series_e->>'sequence')::bigint < 59 and (
     … root3 … '2026-09-10T10:13:16Z'))
```

**`>= 64` 没有上界。** root6 的新预算落在 sequence ≥ 89，会被这条捕获，
并被要求声明 root5 代际 + 一个昨天的到期时刻。

所以每处都是**两步**：把 `>= 64` 收窄为 `>= 64 and < 89`，再新增 `>= 89 → root6` 分支。
这正是控制器 `generationForBudget` / `expiryForBudget` 的 PL/pgSQL 复刻：

```js
// root6 context.mjs:155-156
const generationForBudget = s => s>=89 ? root6Generation : s>=64 ? root5Generation : s>=59 ? root4Generation : scope.root_generation;
const expiryForBudget     = s => s>=89 ? '2026-09-19T00:00:00Z' : s>=59 ? '2026-09-11T10:21:05Z' : '2026-09-10T10:13:16Z';
```

**这三个分段在每个函数里各出现三次**（预算体、GA deadline、终局回执），两个函数共 **6 处结构性新增**。

---

## 四、Owner 窗口必须一并前移，否则无解

这是决定整个变更形状的一条，此前只被记为「新预算 `expires_at` 字面量」。

- 数据库要求新预算 `expires_at` **精确等于** `'2026-09-12T13:14:51Z'`（`reserve_execution_budget:125`）
- 且要求它 **≤ `accepted_binding.expires_at`**（`:135`）
- root6 控制器要求它 **等于 `2026-09-19T00:00:00Z`**（`expiryForBudget(89)`）

`accepted_binding` 实测为 `2026-09-11T13:14:51Z .. 2026-09-12T13:14:51Z`。
所以只改函数里的字面量不够——`:135` 会把 09-19 的预算挡回来。**Owner 窗口本身必须移到 `2026-09-19T00:00:00Z`。**

两条子路，实施方推荐前者：

- **A-i（推荐）**：把 `accepted_binding.expires_at` 移到 `2026-09-19T00:00:00Z`，
  并同步两个函数里三处 `'2026-09-12T13:14:51Z'` 字面量。
  控制器 `72d9eb92…` 及其四份已签文档、七轮复核、零漂移**全部保留**。
- **A-ii**：保留 09-12 窗口，**重建控制器**使 `expiryForBudget(89) = '2026-09-12T13:14:51Z'`。
  这会作废资格文件 `f5b18b54…`、运行时受理 `3f3c9cf3…` 及其 Owner 合并，四份文档链要重走一遍。

A-i 另有一个不是理由的好处，但应当说破：它把预算预留的真实截止从**今天 13:04:51Z（约 10 小时后）**
推到 09-19，使后续每一步都不必赶时间。继任者第七轮的提醒照录：
**「窗口 Owner 可以重开，`SECURITY DEFINER` 函数改坏了不能。不要因为这个时钟仓促动手。」**

---

## 五、`effective_execution_binding`：不必手写，走既定前推

此前文档担心要动这个 107,827 字符的函数。**不必。**

仓库里有一条走过 19 次的流水线（`ActualEighthForward.sql` … `ActualNineteenthForward.sql`，
逐次 +5.6 KB，正是每次追加一个分支）。第 19 次的生成器 `nineteenth-forward.candidate.mjs`
里，`buildForward` 的新 getter 是从**活库里读回的上一版 getter** 增量构造的：

```js
previous_getter_definition_raw: Buffer.from(envelope.getter_definition_base64, 'base64').toString('utf8')
```

那 107 KB 从头到尾不经我手。

**但生成器不能原样重跑**，两个依赖在本环境不存在：

- `LockedInstall.v3.template.sql`（模块加载期读取并断言 `de218d86…`）——
  第 19 次的回执已记明「exists nowhere in this repository or environment and could not be recovered」
- 第 5–15 次的 `Actual*ForwardInput.json`（`C:/Users/Windows/…` 路径下的历史链自检）

可重建，且自检可以更强。计划：

1. `captureQuery` 从 `ActualNineteenthForwardInput.json` 的 `actual_preimage.query` 取回（原样，不重打）
2. `capture` 片段从 `ActualNineteenthForward.sql` 取回
3. `buildExactGetter` 用现存的 `exact-getter-root5-window9.candidate.mjs`（5,295 B，在仓库里）
4. **自检替换为活库锚定**：用 `ActualNineteenthForwardInput.json` 里记录的第 19 次入参重跑
   `buildExactGetter`，断言产出的函数体 sha256 等于**活库当前的** `c721b056a771a3a019d1f0cee862408ba56afcbd4d683f45802e8f51c0580d16`。
   这比 Windows 历史链自检更强：它证明构造器能逐字节重现**现在正在生产里跑的那个函数**。

若第 4 步复现不出 `c721b056…`，**停止，不要绕过**——那说明构造器与线上不一致。

---

## 六、`series_f > 15`：Owner 已批，但要记明它是什么

```sql
select count(*) into series_f from jsonb_array_elements(series_events) e
  where (e->>'sequence')::bigint > 44 and e->'request'->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED';
if series_n > 9 or series_f > 15 …then raise
```

实测 15。第 20 次前推使其为 16 → `reserve_gate` 与 `reserve_execution_budget` **同时抛错**。

Owner 已于本轮批准抬高（「批，改吧」）。仍应照录 `ControlPlanePreChangeRecord.md` 的定性：
**在数据库里抬高它，等于实施那条从未经独立评审、且已被证明建立在错误前提上的 override。**

实施方考虑过一条绕开它的路并**主动否决**：直接 `CREATE OR REPLACE effective_execution_binding`
让它径直产出 root6 绑定，则无需前推、`series_f` 停在 15、无需抬额度。
否决理由：那是**绕过事件日志静默改写绑定解析器**，比抬额度更坏——
前推是追加式的、有 `events` 记录、有回执。**宁可抬额度并记明，不要静默改写。**
此项请继任者独立判断是否同意。

---

## 七、完整变更清单（19 处编辑 + 1 数据 + 1 前推 + 1 缺件）

行号为 `pg_proc.prosrc` 内的行序，取自 `2026-09-12T03:12Z` 的读取。

### 数据变更（1）

| 目标 | 现值 | 目标值 |
| --- | --- | --- |
| `accepted_binding.expires_at` | `2026-09-12T13:14:51Z` | `2026-09-19T00:00:00Z` |

`not_before` 保持 `2026-09-11T13:14:51Z` 不动。

### `reserve_gate`（7）

| # | 行 | 内容 |
| --- | --- | --- |
| 1 | 31 | 活动头代际 root5 → root6 |
| 2 | 33 | `accepted_binding` 窗口字面量 → `2026-09-19T00:00:00Z` |
| 3 | 48 | `series_f>15` → `series_f>16` |
| 4 | 58-60 | `>=64` 收窄为 `>=64 and <89`；新增 `>=89 → root6 + expires_at '2026-09-19T00:00:00Z'` |
| 5 | 79-81 | 同上，GA：`>=89 → root6 + deadline <= '2026-09-19T00:00:00Z'` |
| 6 | 98-99 | 同上，终局回执：`>=89 → root6` |
| 7 | 112 | `clock_timestamp()+600s >= '2026-09-12T13:14:51Z'` → `'2026-09-19T00:00:00Z'` |

### `reserve_execution_budget`（8）

| # | 行 | 内容 |
| --- | --- | --- |
| 1 | 36 | 活动头代际 root5 → root6 |
| 2 | 38 | `accepted_binding` 窗口字面量 → `2026-09-19T00:00:00Z` |
| 3 | 53 | `series_f>15` → `series_f>16` |
| 4 | 63-65 | 预算分段：收窄 + 新增 `>=89 → root6` |
| 5 | 84-86 | GA 分段：收窄 + 新增 |
| 6 | 103-105 | 终局回执分段：收窄 + 新增 |
| 7 | 117 | `+600s >= '2026-09-12T13:14:51Z'` → `'2026-09-19T00:00:00Z'` |
| 8 | 125 | 新预算 `expires_at` 精确值 → `'2026-09-19T00:00:00Z'` |

### `append_status_manifest`（4）

| # | 行 | 内容 |
| --- | --- | --- |
| 1 | 8 | 白名单加入 root6 status schema `510f3b90…` |
| 2 | 27 | 严格 schema 摘要 `76bb79f7…` → `510f3b90…` |
| 3 | 28 | 代际 root5 → root6 |
| 4 | 29 | `expires_at` 精确值 `2026-09-11T10:21:05Z` → `2026-09-19T00:00:00Z` |

第 33-35 行**不动**：它们要求 `expires_at > clock_timestamp()` 且 `<= accepted_binding.expires_at`。
把第 29 行改为 09-19、同时把 `accepted_binding` 移到 09-19，双重矛盾即自然解开——
**Status24 之所以无法追加，是因为 09-11 那次窗口迁移只改了另外两个函数、漏了这一个。
它不是设计出来的约束，是一次没做完的迁移。**（依据见第八节。）

### `effective_execution_binding`（0 处手改）

第 20 次绑定前推，按第五节的流水线，移到：
控制器 `72d9eb92cf287ee6fda1fdbb97d90d02ed7f0e368398cba4ddb517233413d145`、
资格 `f5b18b549dd3f32e30c13c826d70079de5ed830a5e86d8ae376beb84c3e8ab0b`、
运行时受理 `3f3c9cf3357422d41e37cee5f7e95a5ea98f70b9a76b92284f77c14070519194`。

### 缺件（1）

**root6 的 `GENERATION_REGISTERED` 事件 body 尚不存在。** 仓库里没有任何 root6 注册文档。
它必须声明 `control_trust_root_generation = ctrgen_5e0440a9…`、
`not_before`/`expires_at` 覆盖「现在 .. 2026-09-19T00:00:00Z」、
`history.prefix_sequence = 5`、`history.prefix_digest = canonicalDigest(events[0..5])`
（控制器 `:59`），并通过 `validateRootShape`。**这份文档要新写、要签、要 Owner 合并。**

---

## 八、一条此前无人记录的先例，它同时是佐证和警告

`ActualNineteenthForwardReceipt.json` 的 `deviations_from_original_pipeline[2]`
（`CONTROL_FUNCTION_HASHES_REBASELINED`）记着：

> `reserve_execution_budget` 与 `reserve_gate` **在 2026-09-11 的 08:59 与 17:02 UTC 之间，
> 于本仓库之外被重写**，属同一次 owner 驱动的窗口迁移。
> …
> **「This rewrite has no corresponding pull request or published evidence in this repository.」**

两层意义，都要说：

- **佐证**：改这些 `SECURITY DEFINER` 函数在本轮**不是先例之外的事**，已经发生过一次。
- **警告**：那一次**没有 PR、没有独立评审、没有发布证据**，而且**做漏了**——
  `append_status_manifest` 的哈希 `94a444b9…` 自 09-11 07:20 起至今未变，
  它仍钉着旧窗口 `2026-09-11T10:21:05Z`。Status24 从 09-11 10:21:05Z 起就已无法追加，
  比 root6 这件事更早。**上一次「顺手改一下控制平面」的直接后果，就是这次的阻塞之一。**

本次变更**不得重复那个做法**：必须有候选 SQL、有 `prosrc` 漂移守卫、有独立评审、有 Owner 合并、有回读回执。

---

## 九、既定惯例要求的事务形状

依 `runtime-successor/binding-evidence-successor/alter.candidate.sql` 与
`ActualNineteenthForward.sql` 的开头：单事务、`lock table … access exclusive`、
以逐个前代 `prosrc` sha256 断言开头，任一漂移即拒绝。取值（`2026-09-12T03:12Z` 读取，
与 `ControlPlanePreChangeRecord.md` 一致，零漂移）：

| 函数 | `prosrc` sha256 |
| --- | --- |
| `append_status_manifest(text,text)` | `94a444b9174251e8f655ea3a04e160898464caf1f94977cbce1590aff726c615` |
| `effective_execution_binding()` | `c721b056a771a3a019d1f0cee862408ba56afcbd4d683f45802e8f51c0580d16` |
| `reserve_execution_budget(text,text)` | `df6087f9d19d99f023a9c789f0c9b34140e92bb82fc00a5dde1d69d9b1aa7d41` |
| `reserve_gate(text,text)` | `a011292416693ef7e44221868669937261c33848a3ff10882d0f4abd97c9ef2e` |

后两个与第 19 次前推重定基后的期望值逐字相同，**说明控制平面自 09-11 17:35 起未再漂移**。

---

## 十、执行顺序（顺序本身是安全条件）

1. 三个函数 + `accepted_binding` 在**一个事务**里变更（含四道漂移守卫）
2. 立即只读回读并存档
3. 注册 root6（`append_event`，需第七节那份缺件）
4. 第 20 次绑定前推
5. Status24（须引用 `3f3c9cf3…`）
6. 预算预留（唯一一次，不得重试）
7. GA 签发（`target_revision` = 运行时受理的合并 `9abd270505e8429e763d91dab8d03eaae0a2028e`）
8. 600 秒运行
9. 19 项 PQUAL 观测
10. GRR

**第 1 步必须早于第 3 步。** 变更后的函数要求活动头为 root6；注册之前它们对 root5 已不成立。
中间没有任何步骤调用它们，所以这个顺序是安全的——但反过来（先注册再改函数）会
让 root5 通路先断、root6 通路后开，中间是不可回退的空档。

---

## 十一、必须记在案的治理问题

实施方两次提出、两次未获回答，按此前承诺无论如何记录：

**如果实施方为了让自己的运行通过，重写了控制平面的执行层，那么最终的 GRR 证明了什么？**

本轮的形状是：仓库侧的控制器由实施方构建，数据库侧的强制层现在也由实施方改写，
且改写的内容恰好是「让这个控制器能跑」。七轮独立复核**全部只看了仓库侧**。
第八节那条先例说明，控制平面此前已被无评审地改过一次，并且改漏了。

这不构成停止的理由——Owner 已明确选择出路 A 并授权抬高 `series_f`。
但 GRR 的措辞里应当写明：**本次资格运行的强制层，在运行前由被资格审查的一方修改过。**

---

## 边界

未写库、未注册代际、未消耗那唯一一次分配（`charged_seconds` 仍为 9906/10506）、
控制器自合并 `a573ca9` 起零改动。本文件不接受任何对象、不签发任何资格、不构成授权，
也**不是候选 SQL**——候选 SQL 应在本文件通过继任独立评估者复核之后再写。
