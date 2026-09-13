# 第 21 次前推生成器：构建记录

产出（本目录，只生成不执行，全程未写库）：

| 文件 | 作用 |
| --- | --- |
| `build-twentyfirst.mjs` | 第 21 次前推的 compact 事务生成器（模板＝第 20 次的真 SQL） |
| `derive-getter-module.mjs` | 由第 20 次的 getter 构造器派生第 21 次的（上界 `<20` → `<21`） |
| `exact-getter-f12-window12.candidate.mjs` | 上面那一条替换的产物，5295 字节，`a4c6ad9b…` |
| `smoke-input-21.mjs` | 造一份**只用于真实生成、不可执行**的第 21 次输入 |

已有且未改动：`derive-n20.mjs`、`n20.derived.json`、`TwentyFirstForwardPrep.md`。
`work/twentieth-forward/` 与 `scripts/phase2-qualification/` 全程只读。

## 1. from 侧的来源：一条规则一条依据

模板是 `artifacts/…/step14-execution/forward20.real.sql`（`a66b104e…`，23047 字节，用前验摘要）。
第 20 次生成器把 15 个 from 值写成 `const N19` 常量块；这里一个都没有手打。来源分三类：

**(A) `n20.derived.json` 的 13 个字段** —— 由 `derive-n20.mjs` 从归档 SQL 逐项唯一性提取。
生成器启动时用 `execFileSync` **重跑一次派生**，与 json 逐字段 deepEqual，不一致即中止
（实测：把 json 里 `next_seq` 改成 90，生成器报 `N20_JSON_DISAGREES_WITH_RERUN_DERIVATION`）。

| 规则 | from 来源 |
| --- | --- |
| do tag | `T20.tag` = `$nf20$`，并断言 = `$nf${this_forward}$` |
| v_new target / v_norm digest | `T20.v_new_sha256` / `T20.v_norm_sha256` |
| getter def digest | `T20.getter_definition_sha256` |
| rows sha / catalog sha | `T20.rows_sha256` / `T20.catalog_sha256` |
| reserve_execution_budget / reserve_gate / append_status_manifest | `T20.*`（三条控制面 prosrc 闸） |
| guard exception | `T20.guard_exception` |
| window | `T20.window`，2 处 |
| **whitelist replace** | `T20.guard_pre` / `T20.guard_post`，并断言二者 = `guardOf(19)` / `guardOf(20)` |
| insert seq+key / cas update / readback ev / readback compare / expected_rows seq | `T20.prev_seq`(88)、`T20.next_seq`(89)、`T20.key` |
| event exception | `T20.event_exception` |

**(B) 模板里按「角色」现场提取的 4 项**（json 不带，第 20 次生成器靠行号 `lines[21]/[50]/[68]`；
行号在 19→20 之间就已经动过，角色没动）：

| 项 | 锚点 | 实测 |
| --- | --- | --- |
| execution_current 前像字面量 | `execution_current x where root_id='ctr_…') is distinct from '` | 唯一，373 字节 |
| 事件 request_body 字面量 | `request_body:='` | 唯一，4110 字节 |
| 前绑定 / 后绑定两个 jsonb | **各自 raise 的异常名**：`exact_current_and_previous_binding_required` / `exact_successor_getter_or_binding_required` | 各 729 字节，互不相同 |
| 后像 prosrc 摘要 | `convert_to(prosrc,…) … effective_execution_binding()'::regprocedure) is distinct from '` | 唯一，`633269f1…` |

前后两个绑定字面量**语法完全相同**（都是 `effective_execution_binding() x) is distinct from '…'`），
第 20 次生成器靠行号 + 「不是另一个」区分，R21-F4 就是这里漏了一条规则。这里改为按各自守卫抛出的
异常名定位 —— 那是唯一给字面量赋予含义的东西。

**(C) 构造器**。`buildExactGetter` 的自校验上界必须由 `<20` 升到 `<21`（window8 `<18`、
window9 `<19`、window11 `<20` 的既定惯例）。`work/twentieth-forward/` 本窗不可改，所以派生到本目录，
并且**生成器启动时在内存里重做同一次替换、与磁盘上的模块逐字节比对**，手改过的构造器进不来
（实测：把模块挪走，报 `MISSING_GETTER_MODULE`）。

## 2. 两处只有真实生成才会暴露的问题（都已改）

### 2.1 两条绑定规则的顺序依赖 —— replay 永远看不见

第一次真实生成直接炸在 `OCCURRENCE_COUNT:successor binding guard: expected 1, found 2`。

原因：**第 21 次的 previous_binding 就是第 20 次的 new_binding**。先改前绑定那一处，模板里立刻
出现两份与后绑定字面量相同的串，后绑定规则就数到 2。第 20 次生成器躲过这件事，只是因为它的
`line69 final binding` 恰好排在 `line22 previous binding` 前面 —— 顺序是对的，但没有任何东西
守着这个顺序。

replay 下两条规则都是恒等替换，无论怎么排都数到 1，**所以 `--replay` 通过完全不能说明问题**。
这正是勘察记录里第十八轮那条重复规则的同构。

改法不是调顺序，是让顺序不再要紧：两条规则的 from/to 各自带上自己守卫的异常名后缀，
两条规则再也不可能匹配到对方的位置。

### 2.2 白名单残留检查的语义

第二次真实生成炸在 `TWENTIETH_LITERAL_SURVIVED:whitelist post-image`。这是我的检查写错了：
第 20 次的**后像** `(1..20)` 正是第 21 次的**前像**，它合法地出现 1 次；必须归零的是第 20 次的
前像 `(1..19)`。两条现在都与本次的前像 `guardOf(existing)` 比较，含义才对得上。

### 2.3 派生构造器时的字符数断言

照抄第 20 次的 `19→20 改两个相邻字符`，在 `20→21` 上直接失败（只改 1 个字符）。
断言起作用了，改为断言个位数字这唯一一处。

## 3. 实测记录

活库只读实测（project `uscrdifznmlvczcekqpw`，全部 select，零写入）：

```
sequence = 89        existing_forwards = 20        charged_seconds = 9906（未动）
effective_execution_binding().controller_sha256 = 68133f2d…（第 20 次的 new_binding）
pg_get_functiondef 摘要 = 9b6518b9…     prosrc 摘要 = 633269f1…（= 第 20 次的 prosrc_after）
accepted_binding.expires_at = 2026-09-13T07:05:16Z（实测时已过期）
reserve_gate / reserve_execution_budget / append_status_manifest prosrc 摘要与第 20 次一致（CP-02 还没跑）
```

于是 prev_seq=89 / next_seq=90 **是活库量出来的**，不是写死的；生成器另断言活库 sequence 必须
等于 `T20.next_seq`（第 20 次 CAS 的落点，同样来自归档）。

**没有把 108KB 的 getter 定义从库里拉出来**：`smoke-input-21.mjs` 用第 19 次的定义 + 第 20 次自己的
输入离线重建第 20 次的输出，再断言其摘要 = 活库实测的 `9b6518b9…`，body 摘要 = `633269f1…`。两条都过，
所以输入里的 `previous_getter_definition_raw` 与活库逐字节相同。

命令与结果：

```
node work/twentyfirst-forward/derive-n20.mjs                       → 13 字段，与 json 一致
node work/twentyfirst-forward/derive-getter-module.mjs --write     → a4c6ad9b…，改动字符偏移 [891]
node build-twentyfirst.mjs <input20.real.json> --replay --out-sql … → cmp 与 forward20.real.sql 字节相同
node smoke-input-21.mjs --live live.json --out input21.smoke.json  → 591106 字节
node build-twentyfirst.mjs input21.smoke.json --out-sql …          → 23059 字节，sha256 0d9b63ca…
node build-twentyfirst.mjs input21.cp02hypo.json --dry-run         → 末行 rollback;，commit 计 1
node build-twentyfirst.mjs <input20.real.json>（不带 --replay）      → REAL_RUN_MUST_BE_THE_TWENTY_FIRST，拒绝
```

真实生成产物只写在会话临时目录，未入库、未提交、未执行。

## 4. 验收：真实生成一次后，逐项核对（57 项独立检查全过）

独立于生成器自身断言，另写脚本对产物 `forward21.smoke.sql` 逐项数：

**已就位**：`$nf21$` 2 处；`replace(v_norm,'(1..20)','(1..21)')` 1 处；`(1..21)` 1 处；
片段 `if n=20 then …` / `offset 20 limit 1` / `exact_bounded_forward_21_required` 各 1 处；
`insert … ,90,'<key>'` 1 处；`set sequence=90 … and sequence=89` 1 处；`e.sequence=90;` 1 处；
`to_jsonb(90::bigint)` 1 处；`exact_real_twenty_first_forward_event_required` 1 处；
v_norm 闸 = `e2bf20c8…`（＝第 20 次的 v_new，链条对得上）；v_new 闸 = 本次目标 1 处；
getter 定义闸 = `9b6518b9…`；prosrc 后像闸 1 处；rows 摘要 = 活库 `795f2159…`；
容量守卫异常名 1 处、窗口 2 处；**六份材料的 sha256 全部出现在事件体与片段里**；
前绑定字面量 = 活库 effective binding，后绑定 controller = F12 清单摘要 `73c05cad…`（确实搬了控制器）；
结构：71 行、`begin;` 开、`commit;` 收、commit 恰 1；与第 20 次相比 50 行逐字节未动。

**第 20 次专属字面量残留 = 0**，逐项：`$nf20$` 0；`exact_real_twentieth_forward_event_required` 0；
`exact_bounded_forward_20_required` 0；`root6-linux-controller-forward-68133f2d617718c8`（旧幂等键）0；
`offset 19 limit 1` 0；`if n=19 then …` 0；`(1..19)` 0；旧 v_norm `f97d8585…` 0；
旧 getter 定义 `6cbfe002…` 0；旧 rows `3544cf46…` 0；旧 prosrc 后像 `633269f1…` 0；
seq 89/88 的 insert / CAS / readback / expected_rows 四处 0；
**外加**：产物里每一个 64-hex 摘要都可追溯到本次输入，untraceable = 0。

**合法沿用的 3 项**（生成器把它们列进 `identity_replacements` 而不是当残留）：
`e2bf20c8…`（第 20 次的 v_new，现在是第 21 次的 v_norm）、`e88ca499…`（catalog 摘要本来就没被
第 20 次改动）、`(1..20)`（第 20 次的后像＝第 21 次的前像）。

CP-02 还没跑，所以窗口、容量守卫名、三条控制面 prosrc 摘要与第 20 次相同，也被列为
identity。为了证明这不是漏替换，另跑了一次**假定 CP-02 已生效**的变体（窗口挪到
`2026-09-14T05:45:14Z`、守卫名换成 `accepted_root7_f12_window12_capacity`、三条摘要换成显然合成的
值）：这 5 项残留全部归零，identity 只剩上面那 3 项。

## 5. 不确定的、我没拍板的

1. **`exact_real_twenty_first_forward_event_required` 的拼法**。ORDINAL 表里 20 → `twentieth`
   能用归档对上（生成器有这条断言），**21 → `twenty_first` 没有任何实物可对**，是本轮自己取的名，
   却会写进要执行的事务。若有别处约定（`twentyfirst` / `twenty_first`），以那边为准。
2. **`n20.derived.json` 缺 `prosrc_after`**。第 19 次那套常量有 15 个字段，派生出来的是 13 个，
   差的一个就是它（另一个差异是 `guard_pre/post` 换了形式）。现在由生成器从模板现场提取，
   锚在 prosrc 上（不是 `pg_get_functiondef`，那是同一函数的另一个摘要）。要不要回填进派生器，
   归 `derive-n20.mjs` 的作者定，我没有改它。
3. **`derive-n20.mjs` 的 `event_exception` 正则是 `exact_real_([a-z]+)_forward_event_required`**。
   等第 22 次拿第 21 次当模板时，`twenty_first` 带下划线，这条会匹配不到而 REFUSED。
   不是本轮的问题，但下一轮一定会撞上。
4. **「活库 sequence 必须 = 89」这条断言的松紧**。含义是「第 20 次之后没有别的东西消费过序列」。
   若存在非前推事件也推进 `execution_current.sequence`，这条会误拦。fail closed，我按保守留着。
5. **`charged_seconds` / `charged_evidence_bytes` / `active_ga_id` / `pending_budget_sequence`
   四项与第 20 次前像比对后不等即中止**；三个 generation id 只记录不拦（本次实测都没轮换）。
   第 20 次生成器是把 9906 / 2201594803 写死在源码里的，这里改成从模板前像字面量里读。
6. **构造器模块名 `exact-getter-f12-window12.candidate.mjs`** 只是沿用「根/窗」命名习惯的猜测，
   内容与命名无关（就是第 20 次模块改一个数字）。
7. **smoke 输入不是执行前像**：MCP 工具是 read committed 且非 `transaction_read_only`，
   真实捕获查询自带的那条 settings 守卫被摘掉才取到值；六份材料取的是当前 F12 树在本 commit 的
   内容，不是评审过的发布集；幂等键是 `smoke-not-for-execution-…`。**产物仅供核对，不得执行。**
8. **真实生成的前置仍未到位**：NW-02、root7 注册、CP-02 的 `series_f>17` 都还没完成，
   且实测窗口 `2026-09-13T07:05:16Z` 已过期。生成器本身不检查这些 —— 它只生成。
