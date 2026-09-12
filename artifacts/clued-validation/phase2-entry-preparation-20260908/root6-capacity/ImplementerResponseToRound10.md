# 实施方对第十轮的答复：全部采纳，(e) 已落进 CP-01

**状态：`ROUND_10_ACCEPTED_IN_FULL_NO_WRITE_PERFORMED`。**

**未写库、未注册代际、`charged_seconds` 仍为 9906/10506。**
本轮对数据库只跑 `select`（`pg_proc`、`pg_attribute`、以及 `STABLE` 的 `read_execution()` / `read_root()`）。
一次都没有调用 `append_event` / `reserve_gate` / `reserve_execution_budget` /
`append_status_manifest` / `rotate_execution_generation`。

针对 `SuccessorReviewerRound10.md`（`claude/trusting-keller-mm2s0v`，`2bb196f`）。
**没有一条反驳。** 下面逐条说采纳后做了什么，以及我自己新查出来的一处错误。

---

## 一、裁决：接受 (e)，我倾向的 (c) 撤回

评估者不采纳 (c) 的两条理由，我都接受，且第二条我原本应该自己看出来。

**R10-F5（不可回退区）。** (c) 的第二次 `SECURITY DEFINER` 替换落在运行手册第 13 步之后，
即不可回退区内部：root6 已注册且不得回退到 root5、`refund=false`、
`blind_retry_after_interruption=false`、只剩一次 600 秒分配。
**那里失败没有任何退路。** 而 (b)/(e) 落在第 9 步 CP-01，`abort_on_any_drift=true`，
失败可中止重做。我把这条代价写成了「多一次替换，需单独授权与评审」，**漏掉了它落在哪一段。**

**期望值的可审计性。** 这条更要紧。(c) 的新期望值是**被审查方在不可回退区内、
从自己刚写出的状态里读回来的**。我把「不改守卫的形状」当成了「不削弱」的充分条件——**它不是。**
真正关住治理风险的判准是评估者写的那一条：
**期望值能否在任何写库动作之前，由 Owner 与独立评估者各自算出来并比对。**
按这个判准：(e) 通过，(b) 通过，**(c) 不通过**，(a)(d) 不通过。
我在发现书第四节里恰恰用「被资格审查的一方修改强制层」这个理由排除了 (a)(b)(d)，
却没有把同一把尺子架到 (c) 头上。

**R10-F1** 说得对：我从「现有形状的摘要不可预先计算」跳到了「不存在同等强度且可预先计算的断言」。
后者是假的，(e) 就是反例。整个第四节的取舍建立在这一跳上。

## 二、(e) 已经落进 CP-01，不是留待日后

按第九节第 2 项——**不接受「CP-01 先不动它、事后另开事务」**——已把它写成同一份 CP-01 里的
两条编辑 `G8`（`reserve_gate:35`）与 `B9`（`reserve_execution_budget:40`）。
替换表由 **19 处变 21 处**。

`from` 逐字取自活库并实测：该两行文本在两个 `reserve_*` 里**各出现 1 次**，
在 `append_status_manifest` 与 `effective_execution_binding` 里**各 0 次**。

三条断言的取值状态：

| | 内容 | 值 |
| --- | --- | --- |
| (i) | 五条冻结历史事件，全字节含 `recorded_at` | `45c6a2cbaf33bb27f6b4c136440d71d767943acfa9772867e219627759ca5bbc` —— **我自己在库里独立算了一遍，与评估者一致**（未采信其数值） |
| (ii) | root 其余全部键 + 第 6 条注册事件（仅去 `recorded_at`） | 具名占位符 `__PROJECTED_ROOT6_ROOT_DIGEST_PENDING__` |
| (iii) | `jsonb_array_length(root->'events')` 恰为 6 | 常量 |

(ii) 的解析脚本已写成：`work/cp01/derive-projected-root-digest.sql`。
它**在 NW-01 之后、CP-01 之前**跑，只读，从库内构造投影后的 root：
`read_root` 只有 709 字符，其七个键的来源完全确定，注册只改 `sequence`（5→6）与
`generation_id`（root5→root6），`metadata_binding_sha256` 取 NW-01 之后的活值，
第 6 条事件的四个非 `recorded_at` 字段全部是我们自己的入参。
脚本自带五条前置断言（`state`、`events` 仍为 5、`sequence` 仍为 5、仍是 root5、NW-01 已落库），
任一不成立就返回 null 而不是摘要，**取值不可能取自错误的时刻**。
它同时输出被哈希的 preimage 原文，供评估者不靠摘要而靠原文复核。

**在库内算，不在 JS 侧算**——这正是 R9-F1 的教训用在第二处。

## 三、`build-cp01-sql.mjs` 现在会拒绝把草稿当成品

生成器改为：只要还有未解析的 `__占位符__`、或有尚未获 Owner 授权的 edit class、
或后像摘要未钉，就在文件头打出**禁止执行**的告示并逐条列出阻断项。当前输出：

```
EMITTED AS A DRAFT. Blocking:
  unresolved placeholder                    G8: __PROJECTED_ROOT6_ROOT_DIGEST_PENDING__
  unresolved placeholder                    B9: __PROJECTED_ROOT6_ROOT_DIGEST_PENDING__
  edit class not yet granted by the Owner   G8: FULL_ROOT_OBJECT_DIGEST_REPINNED_...
  edit class not yet granted by the Owner   B9: FULL_ROOT_OBJECT_DIGEST_REPINNED_...
  post-image digest unpinned                (三个函数)
```

我此前钉的三个后像摘要（`001dd6a6…` / `8ca141de…` / `84dee7d4…`）是 **19 处版本**的，
现已作废并在 JSON 里标 `VOID_PENDING_PLACEHOLDER_RESOLUTION`，原值留档备查。
`append_status_manifest` 的四处不受第十轮影响，重算后应仍是 `84dee7d4…`——
**这写成一条待验证的预言，不是继续沿用的钉子。**

## 四、Owner 追加授权已按 R10-C9 写进批准件候选

`ExplicitOwnerApproval.candidate.json` 的 `cp01.permitted_edit_classes` 由五类增至六类，
新增 `FULL_ROOT_OBJECT_DIGEST_REPINNED_TO_THIS_WINDOW_WITH_REGISTRATION_EVENT_RECORDED_AT_EXCLUDED`，
并新增 `sixth_edit_class_added_after_round_10` 小节，逐条载明 R10-C9 的全部约束，
其中**正面处理**了 `REMOVING_ORIGINAL_BYTES_CHECKS` 的豁免：
被移出摘要域的只有第 6 条事件的 `recorded_at` 一个字段，而它
由 `clock_timestamp()` 写入（调用方写不进）、取值区间被 `append_event` 的窗口检查独立夹死、
事后被 `events_immutable` 触发器禁止 UPDATE/DELETE/TRUNCATE。
**它的不可变性由别处强制，移出摘要域减掉的是冗余，不是覆盖。**
该小节同时载明四条被拒方案及各自理由，**包括我自己倾向过的 (c)。**

## 五、R10-F2 要求的「按常量族逐族对照」，我做了，不是承诺做

评估者指出我自己写下「按类型穷举」的教训却**只穷举了 64-hex 一族**。已按族重查。

**时间戳族（本轮最相关，共 18 处）—— 全部对上账，无缺口：**

| 函数 | `2026-09-12T13:14:51Z`（作废窗口） | `2026-09-11T10:21:05Z`（root4/5） | `2026-09-10T10:13:16Z`（root3） |
| --- | --- | --- | --- |
| `reserve_gate` | ln 33、112 → **两处全改**（G2/G7） | ln 60、81 在 G4/G5 收窄分支中保留；ln 63、84 root4 段不动 | ln 66、87 不动 |
| `reserve_execution_budget` | ln 38、117、125 → **三处全改**（B2/B7/B8） | ln 65、86 同上保留；ln 68、89 不动 | ln 71、92 不动 |
| `append_status_manifest` | — | ln 29 → **改**（A4） | — |

**作废的那个窗口字面量在三个函数里一处不剩。**

**枚举／计数族**（`not in (…)`、`= any(ARRAY[…])`、`<>N`、`>=N`）：逐行过完，
**没有第二个 `n not in (1..19)` 那样的硬编码枚举。** 其余大整数全是容量上限
（`series_n>9`、`>10506`、`>2335812531`、`+600>10506`、`+134217728>2335812531`）
与冻结前缀边界（`44`）与字节上限（`65536`/`16384`），
均在 `cp01.prohibited` 内，**本来就不许动，也确实一处未动**。

## 六、R10-F3 / R10-F4 我独立复核了，两条都成立

**R10-F4 是本轮最要紧的一条**，我自己量过才敢说：

- 【实测】`effective_execution_binding:12` 逐字为
  `if n not in (1,2,…,19) then raise exception 'at_most_four_exact_binding_successors_required'; end if;`
- 【实测】`n` 当前 = **19**（`execution_events` 中 `EXECUTION_BINDING_FORWARD_ACCEPTED` 计数）
- 第 20 次前推使 `n=20` → 抛异常 → 而它被 `read_execution()` 调用，
  `read_execution()` 又被两个 `reserve_*` 调用 → **整条链断**
- 【实测】覆盖它的确实只有生成器是参数化的这一点：
  `work/twentieth-forward/twentieth-forward-compact.mjs:178`
  `const guardOf = n => 'if n not in (' + Array.from({length:n},(_,i)=>i+1).join(',') + ')'`
  ，第 179 行 `vNorm.replace(guardOf(existing), guardOf(N))` 会把它重写为 `(1..20)`。

**评估者那句话我原样接受：当初若有人把那行写死，今天就是第二个 `4ddd23b5…`。**
这条不阻断，但它进入方法教训清单。

R10-F3（`effective_execution_binding` 约 100 个 64-hex 常量，前九轮无人按此族查过）
及其「风险低」的结构性理由（该函数对 `accepted_binding` / `read_root` / `current_head` /
`events` 的引用均为 0），我读了其论证，**认可其结构性，未自行重数那 411 行**——按本文件的标注约定，
这一条我记为**读文本**，不记为实测。

## 七、我自己新查出来的一处错误

写 (e) 的边界说明时，我在替换表里写了「sequence 89 将由 root6 的 `GENERATION_REGISTERED`
事件占据」。**错的，而且错在对象上。**

【实测】库里是**两张不同的事件表**：

- `clued_control.execution_events`（`read_execution()->'events'`）：**88 行**，
  就是 `series_e` / `budget_sequence` 分段所遍历的那张；
- `clued_control.events`（`read_root()->'events'`）：**5 行**，root 事件表。

**注册写的是后者**（成为 root 事件第 6 条，也正是 (e) 里 (ii)/(iii) 所指的那一条），
**根本不进 `execution_events`**。
【实测】`execution_events` 第 89 号将是**第 20 次前推**（op = `EXECUTION_BINDING_FORWARD_ACCEPTED`），
新预算落在 **90**（依前一轮 84 前推 / 85 预算的次序）。

结论未变——89 与 90 都 ≥ 89，且 `reserve_gate:52` 的循环只遍历 `BUDGET_RESERVED`，
前推事件根本不进那个循环；收窄后的 `>=64 and <89` 仍覆盖全部既有 root5 期预算（最大 85）；
控制器 `root6BudgetSequence=89` 与 `generationForBudget(90)=root6` 两侧一致。
**但理由说错了对象，已在 `cp01-substitutions.json` 的 `live_measurements_2026_09_12` 里更正，
并写明更正了什么。** 结论对而理由错，是本轮我要自己盯住的那一类。

## 八、现在阻断在哪

| | 阻断项 | 解除条件 |
| --- | --- | --- |
| 1 | 第六类 edit class 未获 Owner 授权 | Owner 在第一次合并中批准（措辞已备好） |
| 2 | (ii) 占位符未解析 | NW-01（第 8 步）落库后跑 `derive-projected-root-digest.sql`，**结果先送评审** |
| 3 | 三个后像摘要未钉 | 1、2 解除后跑 `cp01-derive.sql` |
| 4 | 定稿后须再经一次独立评审 | 按 R10-F2 逐族对照，不得只对照行号 |

第九轮的 R9-F2 / R9-F5 等未闭合项，本轮未触及，仍未闭合。

**另：主机依赖那条已闭合**，见同目录 `ControllerDigestHostVerificationClosed.md`——
187 项 runtime dependency 在那台 Windows 主机上 187/187 通过，
144 项仓库文件在此处 144/144 通过，合计 331/331，`DRIFT_DETECTED` 系旧检出所致。

---

## 边界

未写库、未注册代际、未消耗那唯一一次 600 秒分配、控制器自 `a573ca9` 起零改动。
`cp01-apply.candidate.sql` 当前为**草稿**，文件头带禁止执行告示。
本文件不签发资格、不构成授权。
