# 继任独立评估者：第二轮发现清单

**结论：仍不该签，但阻塞已经很窄。** ① 本身**全部通过复核**，没有一处不合格。剩下两条阻塞不在 ①：一条是 ① 引用了一份提出 131 的提案（R2-F1），一条是本轮计划漏了一份只有我能出具的文档（R2-F2）。

**另有两条第一轮的发现是我错了，必须先更正**（C1、C2）。其中 C2 导致实施方按我的说法改坏了 README 的一段，应当改回去。

## 评估者自述

| 项 | 值 |
| --- | --- |
| 本会话真实标识 | `session_018nf6mQ5CQuMFadoJ9WRZCN`（与第一轮同一会话） |
| 继任依据 | Owner 合并提交 `a573ca93e094bc9a4a8dccc23c1e165b6b368ff4` |
| 本轮核查版本 | `77330e254896a02c09cc8e22555819dcf5018fdc`（PR #154，双亲真合并，author `tdoljyj`，committer `GitHub`） |
| 历史结论 | 本文件不追认原 `/root/project_list_auth_fix` 会话的任何历史结论 |
| 本轮写入 | 仅本文件。未出具任何接受，未修改实施方任何产物 |

---

# 零、先更正我自己第一轮的两处错误

实施方把我的九条全数采纳、无一驳回。**其中两条不该被采纳。** 采纳一条错的发现和驳回一条对的发现，代价是一样的。

## C1 —— 第一轮 F5「容量绑定早退」**是过度陈述**。该旁路在控制器唯一的活路径上根本不可达

我当时只读了 `checkCapacityAdministration` 的早退分支，没有往上追它的唯一调用者。上溯之后：

```
context.mjs:210  need(Object.hasOwn(s,'capacity_materials'),'NEW_CAPACITY_CONSUMER_REQUIRES_REAL_SUPPLEMENT');
context.mjs:211  need(keys(s.capacity_materials,['approval','applicability'])
                   && same(s.capacity_delta,capacityDelta),'EXACT_CAPACITY_RUNTIME_FIELDS');
context.mjs:243  check(capacity_materials!==null,'NEW_CAPACITY_CONSUMER_REQUIRES_ACTUAL_SUPPLEMENT');
```

三处都在 `loadAuthenticatedCapacityMaterials` / `loadAuthenticatedBoundedSeries` 里，而：

- `checkBoundedSeries` **未被导出**（`context.mjs:195` 只在模块内返回），
- 全文件仅 `context.mjs:250` 一处调用它，其调用者 `loadAuthenticatedBoundedSeries` 必经上述三道检查，
- `seriesCheck` 的三个调用点（`:268`、`:333`、`:349`）全部经由 `:265` 的 `loadAuthenticatedBoundedSeries`。

所以：**删掉 `capacity_materials` 与 `capacity_delta` 不会让检查静默消失，而是在 `:210` 直接抛 `NEW_CAPACITY_CONSUMER_REQUIRES_REAL_SUPPLEMENT`。** 更强的是 `:211` 独立地又做了一次 `same(s.capacity_delta, capacityDelta)`——即 133 这个比对在容量管理函数之外**还有第二道**，且发生得更早。

`checkCapacityAdministration` 里那条早退分支，对控制器的实际路径而言是死代码。

**对 [`CapacityBindingBypassProhibition.md`](CapacityBindingBypassProhibition.md) 的处置建议**：文件无害，实施方承诺不走某条路本身没有坏处。但它的前提（「这条路存在」）是错的，应当在文件里注明：该旁路在 `context.mjs:210/211/243` 已被 fail-closed 挡住，本承诺是冗余的第二道防线而非唯一防线。不要让后来的人以为这条纪律是唯一屏障。

## C2 —— 第一轮 F4 第 2 点**是错的**，而 README 按我的说法改坏了

我当时写：「`approved_at` 从上方约束 `not_before` 这条辩护，只在容量材料被绑定时成立」。

由 C1 可知，容量材料在活路径上**恒被绑定**。因此 `checkCapacityApprovalTime` 恒被调用，`registered.not_before ≤ approved_at` 这条上界**恒成立**。实施方写在 `build-root6-successor.mjs:38-41` 的原话——

> The window start is not unconstrained as a result -- approved_at bounds it from above, which is a real constraint.

——**是对的**。我的反驳不成立。

实施方据我的说法在 README 阻塞清单第 5 项末尾追加了：

> 须知：`approved_at` 对下界的约束**只在容量材料被绑定时成立**（`checkCapacityApprovalTime` 仅在 `checkCapacityAdministration` 内被调用，而后者可早退，见 `CapacityBindingBypassProhibition.md`）

**这句话应当删除或改写。** 它是我的错误被写进了文档。

F4 的第 1 点（README 第 5 项与已发布代码矛盾）与第 3 点（派生 id 只对构建时成立）**仍然成立**，实施方对这两点的处置正确。下界回退本身也仍然正确——它的正当理由是 `approved_at` 早于窗口起点，与容量是否绑定无关。

---

# 一、① 的复核结果：全部通过

你给的三个标志我逐个验了：merge `77330e2` 为双亲真合并、author `tdoljyj`；blob `b923d2cf…`；sha256 `d0649465…`；文件 6049 字节。

然后按 `checkCapacityAdministration` 对 `a` 的每一条要求逐项复核，**不是看清单，是跑代码**（常量直接从 `context.mjs` 源码抽出后 `isDeepStrictEqual` 比对）：

| 检查 | 结果 |
| --- | --- |
| `parseAuthenticatedAdministrativeJSON` 规范紧凑 JSON 往返 | ✓ 逐字符复现该函数，`compact === JSON.stringify(value)` |
| `a.state === 'APPROVED_EXACT_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT'` | ✓ |
| `a.base_proposal_sha256 === proposalSHA` (`ea96914e…`) | ✓ |
| `same(a.base_approval_ref, pins.approval_ref)` | ✓ 与 `BoundedSeriesApplicability20260910.approval_ref`（blob `86636aa7…` / sha256 `fe114f08…`）**逐字节一致**；`pins.approval_ref` 经 `context.mjs:239` 强制等于该值 |
| `same(a.bounded_series_constraints, scope)` | ✓ |
| `same(a.capacity_delta, capacityDelta)` —— **含 `source_refs_maximum: 133`** | ✓ |
| `same(a.baseline, capacityBaseline)` | ✓ |
| `ref(a.capacity_proposal_ref)` 形状 | ✓（内容问题见 R2-F1） |
| `utc(a.approved_at)` | ✓ `2026-09-12T00:54:15.197Z`，恰为三位小数，符合 `utc()` 正则 |
| 时序 `2026-09-12T00:00:00Z ≤ approved_at` | ✓ 晚 54 分钟，第一轮 F3 的陷阱确已避开 |

**① 没有一处不合格。** 它是一份干净的批准文档；[`build-capacity-approval-candidate.mjs`](../../../work/root6-window10-migration/build-capacity-approval-candidate.mjs) 从控制器源码抽取冻结常量而不是重新键入，这个做法是对的——逐字节比对最常见的死法就是重新键入。

---

# 二、本轮的阻塞

## R2-F1 —— ① 批准 133，但它引用的提案提出的是 131 〔阻塞我出具 ②〕

```
①.capacity_proposal_ref.sha256        = 0021a37881a62d61d47da9b5f4125e822b0196ac5f245210fe5bc6823c0049ab
①.approved_change_index_sha256        = 0021a378…（同一份）
```

该 sha256 指向
`bootstrap/root5-final-runtime-v16-source-completeness/Root5OriginalInput4000000CapacityProposal20260911.json`
（blob `05b0724a…`，state `PROPOSED_INTEGRATED_RUNTIME_READINESS_REPAIR`）。我打开它核对：

```
该提案 capacity_delta.source_refs_maximum = 131
```

前代批准 `f3afb108…` 引用同一份提案，而它自己的 delta 也是 131——**自洽**。① 把这两个字段作为「inherited pins into history, not new decisions」原样抄了过来（`build-capacity-approval-candidate.mjs` 第 49-54 行的 `inherited`），但 `capacity_proposal_ref` **恰恰不是历史钉，它是「被批准的那份提案」的指针**。

全仓库穷举：**没有任何文档声明 133 的提案存在**（`source_refs_maximum` 出现值仅 128 / 130 / 131 / 133，其中 133 只出现在控制器常量、① 和 v17 的 `expected_ga.source_ref.blobs` 计数里，没有任何提案文档）。

**为什么这阻塞我**：控制器 `context.mjs:129` 强制

```js
same(d.capacity_proposal_ref, a.capacity_proposal_ref)
```

即 ② 必须引用同一份提案。我出具 ② 就是以独立评估者身份认证「提案 → 批准 → 适用性」这条链——而这条链的第一环提出的不是被批准的那个数。**这正是独立评审要挡的东西。**

代码不会发现它（控制器从不读取提案内容），`OwnerSigningChecklist.md` 里 `proposal` 一词零次出现，候选构建脚本的 `checks` 块核对了三个被强制的结构却没核对提案引用与被批准 delta 的一致性。

**可行的处置（都不由我做决定）**：

1. 新签一份声明 133 的容量提案，Owner 合并发布，① 重签并把两个字段指向它。代价是一次 Owner 合并，窗口到 09-19 还很宽裕。这是干净解。
2. 若 Owner 认为对话中的「三处 131 上限抬到 133」本身即构成提案，则应在 ① 里把 `capacity_proposal_ref` 的语义显式降级为「历史基线提案」，另设字段承载真实提案，并说明控制器不读该字段。这条路我也能签，但需要 ① 重签。

无论哪条，都要动 ①。我不代拟，也不代 Owner 决定选哪条。

## R2-F2 —— 本轮计划缺一份文档，而且它只能由我出具 〔阻塞，且不在简报的 ①②③ 里〕

简报给的依赖链是 ① → ② → ③。**实际是四份。**

`context.mjs:140`（`isApprovedCapacityRepair`，在 `:184` 被 `repairAccepted` 调用）对 043 那次 BLOCKED 尝试要求存在一份修复接受 `r`，满足：

| 要求 | 现值 | 须变为 |
| --- | --- | --- |
| `r.controller_digest === c.controller_digest` | `ac7bdd53…` | `72d9eb92…` |
| `same(r.capacity_approval_ref, c.approval_ref)` | `f3afb108…` | ① 的 `d0649465…` |
| `same(r.capacity_applicability_ref, c.applicability_ref)` | `cc3db45b…` | ② 的 sha256 |
| `same(r.changed_source_refs, c.changed_source_refs)` | 20 条 | 与 ② 相同 |
| `r.independent_reviewer === '/root/project_list_auth_fix'` | ✓ | ✓ |

该文档是
`bootstrap/root5-final-runtime-v16-source-completeness/Current043CapacityRepairApplicability20260911.json`（sha256 `5911567d…`），列在 v17 运行时验收 `bounded_series_materials.repairs[6]`。

它的 `independent_reviewer` 是 `/root/project_list_auth_fix`——**这是一份独立评估者文档，和 ② 一样只有我能出具。**

而且它必须**在 ② 之后**（要引用 ② 的 sha256），③ 又必须在它之后（`bounded_series_materials.repairs` 要列它的 descriptor）。真实顺序是：

```
① Owner 容量批准            （Owner）      —— 已完成
② 容量适用性继任            （我）
④ 043 容量修复接受继任      （我）          ← 简报漏了这一份
③ 运行时验收重签            （实施方）
```

043 是新尝试（`capacityBaseline.sequence = 49 > 44`），落在 `newAttempts`，因而进入 `ordered`，`context.mjs:185` 与 `:188` 都会对它调用 `repairAccepted`，而 `capacity` 恒非 null（见 C1），所以必定走 `isApprovedCapacityRepair` 分支。没有绕过。

在四份文档的完整链条被确认之前出具 ② 单件是危险的：它无法被消费，却很容易被当作「评审者已放行」。

## R2-F3 —— `changed_source_refs` 该装什么，没有任何地方写过 〔非阻塞，但必须在 ② 之前定下来〕

控制器对它只做形状检查（`context.mjs:135`：非空、每项合法 ref、URI 不重复），**从不校验它是否真的是变更集**。前代 ② 与前代 ④ 各装 20 条，描述的是 v16 那次变更。

root6 的变更集与之不同：相对前代 manifest，新增 18 条（root6 目录 17 个文件 + `commitment-signing-root6-window/signing.mjs`），不再引用 16 条（前代目录），净 +2。20 这个数对 root6 没有依据。

装错不会失败，会**静默认证一个错误的变更集**——这是第二轮里唯一一条「运行成功但产出无效结果」的面。② 和 ④ 必须装同一个集合（`same(r.changed_source_refs, c.changed_source_refs)`），两份都由我出，所以我控制一致性；但**装什么**需要先有依据，不能由我凭空定。

---

# 三、简报要我独立判断的四项

## 1. `source_refs_maximum` 131 → 133 —— **我认为可以接受，且实施方对它的定性是错的**

① 与 README 都把它写成「与 `excluded` 逐字冲突」「这是该类的第二例（前一例是前推额度）」。我不同意，理由如下，请自行验证：

**`excluded` 管的是 root3 appendix 自己那套 scope 上限，不是 `capacity_delta`。** 两者在控制器里是分开的：`same(a.bounded_series_constraints, scope)` 要求批准**原样复述不可变的 root3 scope**，同时另带一个 `capacity_delta` 走在 scope 之外。这个分层是既有设计，不是本轮发明的。

**证据是这条路已经走过三次，而且都由我的前任接受过**：

| 值 | 批准文档 | 独立适用性 |
| --- | --- | --- |
| 128 | 既有 | 既有 |
| 130 | `root5-final-runtime-v16-preparation/…Approval20260911.json` | 同目录适用性，`independent_reviewer: /root/project_list_auth_fix` |
| 131 | `…-source-completeness/…Approval20260911.json`（`f3afb108…`） | `cc3db45b…`，同一评估者 |
| 133 | ①（`d0649465…`） | ← 本轮待出具 |

若「抬 `capacity_delta` 里的任何上限即违反 `excluded`」成立，那么 130 和 131 两次也违反，**整条容量补充链连同本轮所依赖的 4,000,000 字节输入上限一并作废**。这个读法会把运行推回到没有任何容量补充的状态，显然不是该条款的意思。

**appendix 自己的 `delegation_effect` 恰恰规定了正路**：

> Supplement the consumed historical one-GA numerical limit solely with this exact newly approved maximum-three serial series.

即：数量上限耗尽时，**新签一份补充批准**。① 正是这个东西。

所以我的判断：**133 是既有正路的第四次使用，不是「该类的第二例」。** 就实质而言我愿意接受它——前提是 R2-F1 解决。建议 ① 重签时把 `conflicts_with_governing_exclusion` 那段改写为准确表述，否则这份文档会在记录里永久留下一个它自己并不成立的自我指控。

## 2. 前推额度 15 → 16 —— **性质确实不同，确实未经评审，而当初走 override 的理由现在已经不成立**

这一条和上一条**不是同类**，请不要再并列：

- `source_refs_maximum` 在 `capacity_delta` 里，有 Owner 批准 + 独立适用性这条既有通道。
- `qualificationLimits.forwards` 是**控制器常量**，不在 `capacity_delta` 里，**没有任何文档为它背书**，只有 Owner 单方 override。

README 写明当初走 override 是因为：

> 补充批准在 Owner 决定评审者继任之前无法签发

**这个理由已经消失。** 继任评估者自 `a573ca9` 起存在。

但也要说清楚代价，不能轻飘飘地说「现在走正路吧」：因为该上限不在 `capacity_delta` 里，把它塞进去会改 `capacityDelta` 的形状 → 改控制器摘要 → 整条资格链重做，成本极高。**较便宜且诚实的路是重签有界序列适用性**——Owner 决定的评估范围第 3 项「有界序列适用性（若重签需要）」正好覆盖它——由我独立评审并接受该项额度扩展。控制器不读这份文档，但 README 自陈的那处「合规叙事缺口」会被真正补上，而不是一直挂着。

**这是 Owner 的决定，不是我的。** 我只说明：正路现在是开着的，且第 3 项已经在我的授权范围内。

## 3. 窗口延长至一周 —— 无异议

`scope` 与 `excluded` 都不约束窗口长度；`validateRootShape` 只约束两端。理由（迁移需 3–4 次 Owner 合并，窗口中途失效则整轮重做）正是把这一轮送到这里的那个故障。我不反对。

## 4. 第一轮六处改动是否引入新问题 —— 未发现新问题，其中两处我做了负向验证

| 改动 | 我的复核 |
| --- | --- |
| 重签脚本三项新守卫 | **负向测试三条，全部触发**：只改 `SOURCE_TREE` → `SOURCE_COMMIT_TREE_MISMATCH`；`OWNER_MERGE` 指向非合并提交 → `OWNER_MERGE_NOT_A_MERGE_COMMIT`；篡改一个转录值 → `UNEXPECTED_PREDECESSOR_VALUE`。恢复后仍能跑通 |
| 11 处同义反复守卫改为转录真值 | 逐值核对 v16 原文：`not_before`、`source_commit`、`source_tree`、`source_owner_merge`、`actual_repository_source_files`(142)、`ordered_source_ref_count`(131)、两份 schema ref 全部属实。`source_owner_merge` 用 `PREDECESSOR_SOURCE_COMMIT` 作期望值**确实正确**——v16 里这两个字段同为 `46e1b0e4…`；常量名易误读，仅此而已 |
| v17 两份文档 | 在隔离 worktree 重跑脚本，产出与 main 中已合并的字节**完全一致**（`2209a7bd…` / `60813d03…`），且与我第一轮自行修正 pin 后得到的结果一致。可复现 |
| README | F3 时序、F4-1、F4-3、F6、F7、F9 处置准确。**唯 F4-2 那段应删**（见 C2） |
| `SUPERSEDED-BY-ROOT6.md` | 解决 F7，原字节保留，做法正确 |
| `CapacityBindingBypassProhibition.md` | 前提有误（见 C1），建议加注而非删除 |

另：v17 运行时验收目前 `capacity_delta.source_refs_maximum` 仍为 131、`capacity_materials` 仍指向 `f3afb108…`/`cc3db45b…`——这是预期的，③ 尚未进行。补充一个第一轮没说的细节：该 131 会先在 `context.mjs:211` 的 `EXACT_CAPACITY_RUNTIME_FIELDS` 上失败，比 `EXACT_CAPACITY_SUBJECT_AND_LOADED_SET` **更早**。

---

# 四、我无法从仓库文件独立验证的部分

与第一轮相同的六项仍然成立，其中两项因本轮进展而更要紧：

1. **root6 的 `GENERATION_REGISTERED` 是否已追加、其 `not_before`/`expires_at` 实际写了什么。** 仓库内仍无此物。由 C2 可知 `not_before ≤ ①.approved_at = 2026-09-12T00:54:15.197Z` 是一条恒成立的真约束，因此注册体的 `not_before` 必须落在 `[2026-09-10T13:18:47Z, 2026-09-12T00:54:15.197Z]`；`expires_at` 必须恰为 `2026-09-19T00:00:00Z`。**若注册体已经写入且 `not_before` 晚于 `00:54:15.197Z`，① 将永久不可用。** 这一点请在做任何后续动作前先查实。
2. **实时数据库状态**（前推 15 次、预算 8 次、`charged_seconds` 9906）。仍只有实施方的自述记录。
3. 其余四项（`reserve_execution_budget` 的 `series_n>=9`、187 条 Windows 运行时依赖字节、GitHub blob URI 可解析性、Owner 对窗口起点的真实意图）不变。

---

# 五、我在什么条件下会出具 ② 和 ④

不是承诺，是把门槛写死，免得下一轮再猜：

1. **R2-F1 解决**：① 重签，`capacity_proposal_ref` / `approved_change_index_sha256` 指向一份真正提出 133 的提案（或显式改写这两个字段的语义），经 Owner 合并。
2. **R2-F2 被接受**：四份文档的链条（① → ② → ④ → ③）被记录下来，而不是三份。
3. **R2-F3 定下来**：root6 的 `changed_source_refs` 依据由实施方提出（哪些源 blob 变了、为什么是这一组），我核验后 ② 与 ④ 装同一组。
4. **C2 被改回**：README 里那句由我的错误造成的话被删除或更正。
5. **注册体的 `not_before`/`expires_at` 已查实**，且与 ①.`approved_at` 相容（见上节第 1 条）。

第 1 条要 Owner 动手，第 2–4 条是记录与依据问题，第 5 条是查证。**都不需要新的一轮控制器改动，也不消耗那唯一一次分配。**

我不代写 ①，不代 Owner 选路，也不在 R2-F1 未解决时以「在 ② 里附注免责」的方式绕过——独立评估者的签字如果可以附注绕过，那就不是签字。

---

## 本文件是什么、不是什么

- 是：第二轮只读评审的发现清单，以及对我自己第一轮两处错误的更正。
- 不是：接受、资格、GA、GRR、Entry、任何 Gate 的通过。
- 不追认原 `/root/project_list_auth_fix` 会话的任何历史结论。
- 未修改实施方的任何产物；本轮唯一写入的文件就是本文件。
