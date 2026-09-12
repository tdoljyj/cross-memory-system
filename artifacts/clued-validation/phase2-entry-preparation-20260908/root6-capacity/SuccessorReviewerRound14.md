# 第十四轮独立评审：Linux 后继控制器的资格化评审

**状态：`BLOCKED_NOT_QUALIFIED_NO_WRITE_PERFORMED`。**

**裁定：不予资格化。四条阻断项，全部为实测，任一条都足以使控制器在运行时抛错或使清单声明不成立。**

未写库、未注册代际、未消耗那唯一一次 600 秒分配、未调用任何会写库或消耗预算的函数、未执行任何 `do $$ … $$` 块。
【实测】边界复核：`charged_seconds` = **9906**（上界 10506）、`charged_evidence_bytes` = 2201594803、`current_head.generation_id` = `ctrgen_e5df432221344996afc04b5638121d96`（root5）、`sequence` = 5、`revoked` = false、`clued_control.events` = 5 行、`execution_events` = 88 行、`gate_attempts` = 14 行、`active_ga_id` = null、`pending_budget_sequence` = null。**全部未动。**

未起 600 秒容器、未走 GA 通路、未签发 GA。未修改实施方检出的任何文件；测试产物在临时目录，用完已删。未合并任何 PR、未批准任何东西。最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。

评审对象：实施方分支 `claude/nice-fermat-njqlmm` head `755d744`，`main` = `2c3a6f9`。
本评估者分支 `claude/trusting-keller-mm2s0v`（第十轮至第十三轮同一条）。

---

## 零、先说结论

| 问 | 实施方的主张 | 本轮裁定 |
| --- | --- | --- |
| (1) 删提案读取零损失 | 是 | **确认**。而且独立见证比它说的多得多 |
| (2) 基线替代方案如实描述降级 | 残余缺口只有 1815–1917 | **部分成立**。对 `execution_events` 偏保守（实际更窄），对 `gate_attempts` **错误且偏乐观** |
| (3) 钉的摘要值对不对 | 15 个值 | **全部确认**，我自己从活库取数、自己算了一遍 |
| (4) `canonical` 重复定义一致 | 逐字节一致 | **确认**，495 字节同 sha256 |
| (5) shell 改写同序同义 | 五步同序同义 | **五步同序，但清单覆盖被削弱**（见 F4 / F5） |
| (6) 253 条诚实 | `ALL_ENTRIES_VERIFIED` 253/253 | **不成立**。方法对，但漏了真正被执行的那一类文件 |
| (7) 容器可复现性 | 未验 | **我验了**。207/253 逐字节一致、0 不匹配、46 缺失 |
| (8) 能不能资格化 | —— | **不能。四条阻断项** |

**四条阻断项**（详见第八节）：

- **R14-F1** `host-effect.mjs` / `fixed_host.py` 仍钉 Windows `python.exe` 的摘要 → 每次 `invokeFixedHost` 必抛。
- **R14-F2** `parent600.py` 的 `ENDPOINT` 仍是 Windows 命名管道 → docker 客户端实测 **段错误崩溃**，600 秒运行一步都走不了。
- **R14-F3** `trusted-github.mjs` 仍钉 Windows `gh.exe` 的摘要 → 第一次 GitHub 读取即抛 `GITHUB_CLI_BYTES_DRIFT`。
- **R14-F4** 清单钉了 57 个**不会被执行**的 `.py`，漏了 57 个**实际被执行**的 `.pyc`；前代钉了 44 个 `.pyc`。这不是遗漏，是**可绕过**。

三条 F1/F2/F3 是同一个形状：**改了路径，没改与该路径配套的摘要/协议**。提交说明里三处都写了"已重钉"或"只需重钉"，但都没有真的重钉。

---

## 一、(1) 删掉提案文件的读取，是不是真的零损失

**【实测】是。而且我不采信实施方的复述，自己读了原 `context.mjs`。**

原 `control-context-verifier-root6-window11-successor/context.mjs` 里 `proposal_raw` 的**全部**出现位置，`grep` 全文，无遗漏：

| 行 | 用法 |
| --- | --- |
| 158 | `checkBoundedSeries({pins,proposal_raw,…})` 形参 |
| 161 | `need(sha(proposal_raw)===proposalSHA,'EXACT_APPROVAL_PROPOSAL_BYTES')` |
| 246 | `fs.readFileSync('C:/…/Phase2Bounded…Proposal20260910.md','utf8')` |
| 248 | `check(sha(proposal_raw)===boundedSeries.proposalSHA && …)` |
| 250 | 作为实参传入 |

**没有第六处。内容从未被 `JSON.parse`、从未被 `split`、从未被取子串、从未进入任何 `same()` 比较。** 两处用途都只是把它的 sha256 与常量 `proposalSHA` 比较。

而 `proposalSHA` 这个常量在新控制器里被**四处**交叉核对，全部来自已合并物料（`material()` 解出的批准件与适用性声明）：

```
:124  a.base_proposal_sha256 === proposalSHA     （容量批准）
:129  d.base_proposal_sha256 === proposalSHA     （容量适用性）
:200  approved.proposal_sha256 === proposalSHA   （用户批准）
:201  appendix.proposal_sha256 === proposalSHA   （行政适用性）
```

【实测】`ea96914e218460339508bc51eff0d10de41e1a94cfa3a0a544a85a132219791b` 在仓库中的独立见证：
**`origin/main` 上的 19 份已合并 artifact**（实施方只说了四份，实际 19 份），外加 **9 代控制器源码**。逐份核过 `git ls-tree origin/main`，全部在 main 上。

**结论：`:246` 的读取与 `:161`、`:248` 的两个 `need`/`check` 删除后，判定强度不变。零损失，不构成降级。** 实施方这一条主张成立。

【实测】新控制器全目录 `grep`，对两份丢失文件只剩 `context.mjs:150` 一行注释，无任何代码引用；`baselineSHA` / `baseline_raw` / `proposal_raw` 标识符全部消失；`C:/` 在 `.mjs`/`.py`/`.js` 中零命中。

---

## 二、(2) 基线替代方案是否如实描述了它的降级

这是本轮最实质的一问。**答案分两半，而 Owner 决定书只写了其中一半。**

### 2.1 `xmin` 能不能被抹掉 —— 能，而且证据是易腐的

**【读文本 + 实测】能。** PostgreSQL 冻结元组时，`HeapTupleHeaderGetXmin()` 对已冻结元组返回 `FrozenTransactionId`（即 2），所以 `select xmin` 在 `VACUUM FREEZE` 之后会**一律读成 2**，原值不可恢复。

【实测】当前状态：

| 量 | 值 |
| --- | --- |
| `execution_events` 中 `xmin = 2`（已冻结）的行 | **0** |
| `relfrozenxid`（`execution_events`） | 1808 |
| `age(relfrozenxid)` | 333 |
| `autovacuum_freeze_max_age` | 200000000 |
| `vacuum_freeze_min_age` | 50000000 |
| `last_vacuum` / `last_autovacuum` | **null / null**（从未 vacuum 过） |

**所以：自动冻结在可预见的将来不会发生**（差六个数量级）。**但任何有表属主权限的人执行一次 `VACUUM FREEZE`，这份证据立刻、永久消失。**

**这一点 Owner 决定书完全没有提。** 而它至关重要，因为该决定书只记了聚合值（`max_xmin_first44`、`min_xmin_after44` 等），**没有记逐行值**。一旦冻结，任何人都无法再复核这份"实测"。

**建议（可操作）：把逐行证据现在就落盘。** 我已在第九节附上全部 88 行的 `(sequence, xmin, recording_transaction_id, ctid)`。

### 2.2 一个实施方没用上的、更强的见证：`recording_transaction_id`

【实测】`clued_control.execution_events` 有一列 `recording_transaction_id`（`xid8`），由应用在插入时写入。

**88 行中 `xmin <> recording_transaction_id` 的行数：0。**

意义有三层：

1. 这是**第二条独立见证**。`UPDATE` 会抬高 `xmin` 但不会自动改这一列，改写者必须在同一条 `UPDATE` 里一并伪造它。
2. 它是**普通列，不随 `VACUUM FREEZE` 消失**。所以冻结之后它仍然在。
3. **它在投影里**——`read_execution()` 用 `to_jsonb(e)`，整行入 JSON，所以 `recording_transaction_id` **已被 `BASELINE_EVENTS_DIGEST` 钉住**（我在第三节验算时确认该键存在于每个事件对象）。

**因此今天这次"xmin == recording_transaction_id，0 处不符"的测量，是把易腐的物理证据绑定到耐久的应用列上的唯一时刻。它必须被记录下来。** 这是本轮最重要的一条建议。

### 2.3 一个实施方没用上的、把缺口几乎压没的证据：`ctid` 物理顺序

【实测】把 88 行按 `(ctid 块, 偏移)` 排序，与按 `sequence` 排序：**逆序对 0 处，完全一致。** `xmin` 逆序对同样 0 处。

堆页占用（第九节有完整数据）：

```
块0 偏移 1–16   → sequence 1–16
块1 偏移 1–17   → sequence 17–33
块2 偏移 1–17   → sequence 34–50
块3 偏移 1–17   → sequence 51–67
块4 偏移 3–15   → sequence 68–80      ← 缺 4/1、4/2
块5 偏移 1,3–6,8–10 → sequence 81–88  ← 缺 5/2、5/7
```

**空槽恰好 4 个。** 【实测】`pg_stat_user_tables`：`execution_events` `n_tup_ins = 92`、`n_tup_upd = 0`、`n_tup_del = 0`、`n_dead_tup = 4`。**92 − 88 = 4，与空槽数一字不差**，这四个是回滚事务留下的。

推论（这是纯物理事实，不依赖 `pg_stat`）：

> 对前 44 行中任意一行的 `UPDATE`，**无论发生在什么时候、包括原始写入窗口之内**，都会把新版本放到当时的堆插入点，并在原位留下一个死槽。要让观测到的"sequence 与 ctid 完全同序、且只有 4 个空槽"仍然成立，改写必须发生在该行插入之后、下一行插入之前，**并且**新版本要恰好落在下一个槽位——而那会把后续每一行整体后移一格，产生第 5 个空槽。**观测中没有第 5 个空槽。**

**所以 `ctid` 证据实际上把 `execution_events` 的"窗口内改写"缺口压到了空集**（前提：从未 `VACUUM`——实测 `last_vacuum`/`last_autovacuum` 均为 null，死槽从未被回收）。

**Owner 决定书对 `execution_events` 的界定不是错的，是偏保守的。** 真实覆盖比它写的更好。这一条对实施方有利，我照实记。

### 2.4 但对 `gate_attempts`，决定书的界定是**错的**，而且方向是偏乐观

这是本轮对 (2) 的核心发现。

【实测】`pg_stat_user_tables`：`gate_attempts` `n_tup_ins = 14`，**`n_tup_upd = 90`**。

**这张表本来就是被反复原地更新的**（创建 → 决策 → 附回执 → 撤销）。所以：

- 每一行的 `xmin` 反映的是**它最后一次被更新的事务**，不是插入事务。
- **`xmin` 单调性论证在这张表上根本不成立，也无法成立。** 不是实施方没测，是没有可测的东西。
- 【实测】`gate_attempts` 的 `ctid` 也不单调（偏移依次为 7,15,5,2,11,20,14,13,4,3,10,14,18,8），因为更新会就近复用空间。**物理证据同样归零。**

而 Owner 决定书的 `residual_gap_stated_exactly` 写的是：

> "A rewrite performed inside the original writing window itself — transactions 1815 to 1917 … About 22 hours, **entirely before the qualification preparation work began**."

**这句话对 `execution_events` 成立，对 `gate_attempts` 不成立，而被替代的检查有一半正是 `gate_attempts`（`ALL_SIX_ORIGINAL_ATTEMPTS_AND_RECEIPTS_UNCHANGED`）。** 逐条：

| | 决定书所述 | 【实测】实际 |
| --- | --- | --- |
| 缺口事务上界 | 1917 | 十四行的最后写入事务为 1824…**2120** |
| 缺口时间上界 | 2026-09-09T16:04:46Z | 十四行 `expires_at` 最晚 **2026-09-11T03:57:50Z** |
| "全部在资格准备工作开始之前" | 是 | **否**。其中八行是 2026-09-10 / 09-11 创建的，正在准备期之内 |
| 第六次原始 attempt（`ga_c5041817…`，`budget_sequence` 41） | 应 ≤ 1917 | `xmin` = **1918**，已越过所述上界 |

**准确的表述应当是：`gate_attempts` 侧的残余缺口，是每一行从插入到其回执落定为止的那段可变期**，逐行不同，最晚延伸到 2026-09-11。

### 2.5 缺口其实被另一样东西封住了 —— 这一点实施方也没说

【实测】`guard_gate_bytes()` 源码的最后一条分支：

```sql
or (old.receipt_raw is not null and to_jsonb(new) is distinct from to_jsonb(old))
```

**一旦 `receipt_raw` 非空，整行的任何一个字段都不能再改。**

【实测】14 行全部 `receipt_raw is not null`。**所以 14 行现在全部被触发器完全冻结。**

**这是比 xmin 更强的一条前向保证，而且它恰好补上了 2.4 的缺口的"从今往后"那一半。** 实施方引用了这个触发器的名字，但没有读它做了什么，因而没有拿到这条论据。

### 2.6 还有两条实施方没想到的残余缺口

**(a) 三个不变性触发器是 `tgenabled = 'O'`，不是 `'A'`。**

【实测】`execution_events_immutable`、`gate_attempt_no_delete`、`gate_bytes_immutable` 的 `tgenabled` 全部为 `'O'`（origin）。`'O'` 的含义是：在 `session_replication_role = 'replica'` 下**不触发**。任何能 `SET session_replication_role` 的角色，可以在三个触发器完全沉默的情况下 UPDATE / DELETE 这些表。

决定书把这三个触发器列为"substitute_evidence_measured_not_asserted"，**没有这条限定**。改成 `'A'`（`ALTER TABLE … ENABLE ALWAYS TRIGGER`）是一行 DDL，但那是写操作，不在本轮权限内，只作建议。

**要点：钉死的摘要不依赖触发器。** 即使触发器被绕过，`BASELINE_EVENTS_DIGEST` 与 14 个 attempt 摘要仍然会在控制器里当场发现改写。所以真正的前向保护是摘要，不是触发器——**资格声明应当这样写，而不是把触发器列为主要证据。**

**(b) 触发器至少在一张表上demonstrably没有覆盖全部历史。**

【实测】`accepted_binding` 的触发器 `accepted_binding_immutable` 是 `BEFORE DELETE OR UPDATE OR TRUNCATE … deny_mutation()`（任何 UPDATE 一律抛异常），而 `pg_stat_user_tables` 记录该表 `n_tup_ins = 1`、**`n_tup_upd = 4`**。

只读证据不足以判定这 4 次更新是**早于触发器创建**还是**在触发器被绕过时发生**；我不臆测。但无论哪一种，结论相同：**"不变性触发器保护了全部历史"这个前提，在本库里至少有一张表上是可证伪的。** 决定书对触发器的援引应当相应降权。（`pg_stat` 计数器可被 `pg_stat_reset()` 清零，也会在崩溃后丢失，所以本条只作为提示，不作为结论。同理，2.3 的 `n_tup_upd = 0` 只是佐证，真正的证据是 `ctid` 顺序。）

### 2.7 对 (2) 的裁定

**基线替代的"技术底座"比实施方主张的更结实（2.3、2.5），但它对残余缺口的描述是不完整且偏乐观的（2.4、2.6）。**

这不构成阻断项——降级本身 Owner 已裁定接受。但 **`OwnerBaselineSubstitutionDecision.json` 的 `residual_gap_stated_exactly` 与 `how_wide_that_is` 两段必须更正**，否则 Owner 是在一份把缺口说窄了的陈述上签的字。更正内容见 2.4 表格。

**另外必须在资格声明里写明一句实施方没写的话：新控制器在运行时并不读 `xmin`。** 它钉的是 2026-09-12 这一刻的内容摘要，所以它的运行时检查严格地是"自 2026-09-12 起未被改写"。"此前也未被改写"这个更强的断言，完全依赖一次带外的、人工的、易腐的测量。**这个分界应当写进资格文件本身，而不是只存在于一份 JSON 决定书里。**

---

## 三、(3) 钉的那些摘要值对不对 —— 自己取数、自己算

**【实测】15 个值全部正确，逐个复现。**

### 3.1 投影形状是先查清楚的，不是猜的

【读文本】`scripts/phase2-qualification/nonproduction-control-store/runtime-successor/control-objects-successor/install.candidate.sql` 中的 `clued_control.read_execution()`：

```sql
'attempts', (select jsonb_agg(to_jsonb(a) order by a.ga_id) from clued_control.gate_attempts a where …),
'events',   (select jsonb_agg(to_jsonb(e) order by e.sequence) from clued_control.execution_events e where …)
```

即整行 `to_jsonb`，事件按 `sequence` 排、attempt 按 `ga_id` 排。我按同一表达式取数。

### 3.2 取数与校验

【实测】只读 SQL，`root_id = 'ctr_414bd3c724264a83894b0c55cf2ab878'`：

| | 字符数 | md5（库内算 / 落盘后算） |
| --- | --- | --- |
| 前 44 条事件 `jsonb_agg::text` | 624,523 | `19dd50bdd93b2b3119194e171dc843f8` / **一致** |
| 14 个 attempt `jsonb_agg::text` | 1,832,525 | —— |

库内 `md5()` 与落盘后重算一致，**排除了传输过程失真**。事件对象键集：`idempotency_key, recorded_at, recording_transaction_id, request, root_id, sequence`（6 个）；attempt 对象键集 16 个，含 `phase`、`receipt_raw`、`revoked`、`budget_sequence`。

### 3.3 算法用的是控制器自己的那一份

我把 `context.mjs` 里的 `canonical` / `canonicalDigest` **逐字符复制**到独立脚本，用 Node v22.22.2 跑（不是我的复述、不是 Python 重写）。

### 3.4 结果

```
BASELINE_EVENT_COUNT   钉 44                    实测数组长度 44                  ✅
BASELINE_EVENTS_DIGEST 钉 64b2ba3e…dff07
                       实测 64b2ba3ef6bfe2755b78e03b19d6a6b6ea5a0e3735c4b9328e9be2c4715dff07  ✅
```

14 个 attempt 摘要，**逐个比对，14/14 全中，0 处不符**：

| ga_id | 钉 = 实测 |
| --- | --- |
| `ga_04377008dc04437d9ee9d28a3c79ff3a` | `c851e3df…3dc2` ✅ |
| `ga_165dc2e72b62414a8023e726d8114f28` | `8533394e…ca65` ✅ |
| `ga_18ce0e28e92f448c967fae1c92de7100` | `2f0f0f1a…1165` ✅ |
| `ga_1d52f4778d494399b12aea54fe4a189e` | `48703fc0…ae6d` ✅ |
| `ga_41643fece183424daf7f05b8b2868f8e` | `49d78fae…ba91` ✅ |
| `ga_4e7ce4ad385e4f5aa633bcea2ddb71ce` | `5b5b51e4…1d79` ✅ |
| `ga_6abb193a56304029a788f7cb624a0d35` | `4ccc9e6a…d713` ✅ |
| `ga_6de636122e9c4fb782c0dc12fd223a9b` | `ba335193…adc8` ✅ |
| `ga_71a1d946fca34c1e9e700c80a546b3ad` | `79510f0e…079e` ✅ |
| `ga_87882f42d0b4460f8430d73239386c35` | `fb1db0d4…1fa3` ✅ |
| `ga_8eb410609e294d899806a319e6615f2b` | `048af9ac…e3bb` ✅ |
| `ga_a7a420f7de4a4037b9dcb5cd7dae796e` | `ea9c3b24…2828` ✅ |
| `ga_c5041817c641487f827cc4ed5e0fc9ad` | `978f4310…92e0` ✅ |
| `ga_e56ca0eb07304f2fbcf60eb8f29f3889` | `a557151c…dac4` ✅ |

**(3) 通过。这一条实施方做对了，而且做得干净。**

### 3.5 但换算法带来了一处语义变化，注释把方向说反了

`context.mjs` 的注释写着：

> "All fourteen attempts are pinned, where the lost baseline pinned six. **Strictly stronger**…"

**"strictly stronger" 不准确。** 内容上确实更强（钉 14 比钉 6 多），但 `newAttempts` 的定义随之改变，**三处派生检查因此变松**：

```js
// 原： newAttempts = x.attempts.filter(a => !base.attempts.some(p => p.ga_id===a.ga_id))   ← 排除 6 个
// 新： newAttempts = x.attempts.filter(a => BASELINE_ATTEMPT_DIGESTS[a.ga_id]===undefined) ← 排除 14 个
```

| 受影响的检查 | 方向 |
| --- | --- |
| `:176` `newAttempts.length <= 9` | **变松**（原 8 个计数，现 0 个） |
| `:188` `newAttempts.every(terminal)` | **变松**（8 个不再被要求终态） |
| `:188` `!newAttempts.some(a => a.phase==='PASS')`（`FIRST_FORMAL_PASS_CANCELS_REMAINING`） | **变松**（8 个 PASS 不再拦） |

**【实测】现状下三处的实际影响为零，理由逐条给死：**

1. 14 个 attempt 的 `phase` 分别是 BLOCKED×11、FAIL×1、STALE×1、BLOCKED（共 14，**无一为 PASS**）。所以 `FIRST_FORMAL_PASS_CANCELS_REMAINING` 当前不可能被绕过。
2. 14 行的 `phase` 已被摘要钉死（`phase` 在 `to_jsonb(a)` 的键集里）。任何一行改成 PASS 都会先撞 `ALL_FOURTEEN_BASELINE_ATTEMPTS_AND_RECEIPTS_UNCHANGED`。**放松被钉死的摘要中和掉了。**
3. 14 行全部 `receipt_raw` 非空且 `phase` 为终态，`terminal()` 无可放松者。
4. 真正的约束不在这里：【实测】`sequence > 44` 的事件里 `BUDGET_RESERVED` 共 **8** 条，`qualificationLimits.allocations = 9`，且 `x.current.charged_seconds === 5106 + 600×8 = 9906` 与库内一致。**`budgets.length` = 8/9 才是紧约束，`newAttempts.length ≤ 9` 在剩余的一次分配内永远先于它触顶。**（`EXECUTION_BINDING_FORWARD_ACCEPTED` 15 条，上限 16。）

**结论：这是一处真实的检查放松，当前被摘要钉死完全中和，但注释里的 "strictly stronger" 应当改掉**，换成"内容上更强，三处派生守卫上更弱，后者由摘要钉死中和"。不列为阻断项，列为必须更正的表述。

---

## 四、(4) `canonical` 重复定义是否与 `root-window-validation.mjs` 完全一致

**【实测】完全一致。逐字符比对，不是目视。**

从两处各自抽出 `function canonical(value){` 到 `return JSON.stringify(value);\n}\n` 的整段：

```
root-window-validation.mjs : 495 字节  sha256 8bf54a9f568e19f0f6df939f002756201b818abe3a2d2578d7a222e0eb32a9fb
context.mjs (linux 后继)   : 495 字节  sha256 8bf54a9f568e19f0f6df939f002756201b818abe3a2d2578d7a222e0eb32a9fb
                                       → IDENTICAL
```

`canonicalDigest` 两处：

```
RWV : export function canonicalDigest(value){return crypto.createHash('sha256').update(canonical(value)+'\n','utf8').digest('hex');}
CTX : const canonicalDigest=value=>boundedCrypto.createHash('sha256').update(canonical(value)+'\n','utf8').digest('hex');
```

差异只有两点，**都不影响计算结果**：

1. 声明形式：`export function` vs `const` 箭头函数。
2. crypto 绑定名：`crypto`（RWV 顶层 `import crypto from 'node:crypto'`）vs `boundedCrypto`（`context.mjs:11` `import boundedCrypto from 'node:crypto'`）。**同一个模块的默认导出，同一个对象。**

摘要计算表达式 `update(canonical(value)+'\n','utf8')` **逐字符相同**：`+'\n'` 在、编码 `'utf8'` 在、算法 `'sha256'` 在、输出 `'hex'` 在。

第 3.4 节的实测是这条的交叉验证：我用 `context.mjs` 那一份算出的 `BASELINE_EVENTS_DIGEST` 与钉值相同；第七节我又用 `root-window-validation.mjs` 那一份算 `reviewSubjectDigest`/`signaturePayloadDigest` 也与钉值相同。**两份实现在真实数据上各自复现了各自的钉值。**

**"不 import 而重写一份以免改动模块图"这个理由成立**：`context.mjs` 的 import 清单不变，控制器的模块闭包不扩大。代价是两份定义会各自漂移——【实测】现在没有漂移。**建议在资格声明里把这 495 字节的 sha256 `8bf54a9f…` 作为一条不变量钉住**，这样以后任一侧改动都会当场暴露。

**(4) 通过。**

---

## 五、(5) `tool-entry.functions.js` 的 shell 改写是否与原 PowerShell 同义

### 5.1 五步逐条对照：同序，且四条同义或更严

| # | 原 PowerShell | 新 sh + python3.11 | 判定 |
| --- | --- | --- | --- |
| 1 | `(Get-FileHash $taskManifest).Hash.ToLowerInvariant() -ne '${expected}'` → `ACTUAL_CONTROLLER_SOURCE_MANIFEST_DRIFT` | `test "$(sha256sum "$MAN" \| cut -d" " -f1)" = "${expected}"` → 同名错误、`exit 1` | **同义** |
| 2 | `object_type -ne 'ControllerSourceManifest' -or qualification_issued -ne $false -or files.Count -lt 30` → `EXACT_SOURCE_MANIFEST_REQUIRED` | `d.get("object_type")!="ControllerSourceManifest" or d.get("qualification_issued") is not False or len(d.get("files",[]))<30` → 同名 | **更严**，见 5.2 |
| 3 | `foreach` 每条：绝对路径原样 / 否则 `Join-Path $taskRepo`；比 `Length` 与 `FileHash` → `EXACT_CONTROLLER_SOURCE_BYTES_DRIFT` | `for e in d["files"]`：`os.path.isabs` / 否则 `os.path.join(repo,…)`；比 `len(b)` 与 `sha256` → 同名 | **同义** |
| 4 | `Get-FileHash 'C:/Program Files/nodejs/node.exe' -ne '3602f2bb…'` → `FIXED_NODE_BYTES_DRIFT` | `sha256sum /opt/node22/bin/node = 81925c09…` → 同名 | **同义**，且钉值正确（见 5.3） |
| 5 | `$env:NODE_OPTIONS=''; $env:NODE_PATH=''; & node.exe …/cli.mjs` | `cd "$REPO"; NODE_OPTIONS= NODE_PATH= exec /opt/node22/bin/node …/cli.mjs` | **同义** |

**顺序一致：摘要 → 形态 → 逐文件 → node 字节 → 清空环境后启动。没有被重排、没有被合并、没有被跳过。**

`set -eu` + 每步 `|| { …; exit 1; }` + python 的 `sys.exit("MSG")`（退出码 1、消息进 stderr）使失败一律中止，不会漏到第 5 步。

### 5.2 第 2 步实际上更严了

PowerShell 的 `-ne $false` 走的是 PowerShell 的弱比较：`0 -ne $false` 为 **False**（0 强制为假），字符串 `'false' -ne $false` 也为 **False**（$false 转成字符串 "False"，PS 字符串比较不区分大小写）。也就是说**原版会接受 `qualification_issued` 为 `0` 或 `"false"`**。
Python 的 `is not False` 是同一性判断，只有字面 `false` 通过。**新版更严，方向正确。**

### 5.3 第 4 步的钉值我验了，是对的

【实测】`sha256sum /opt/node22/bin/node` = `81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90`，与第 4 步内联钉值、与清单条目三者**完全一致**，字节数 124,679,552 也一致。
**这是三处"改路径"里唯一一处摘要也跟着改对了的。** 另外三处没有（F1/F2/F3）。

### 5.4 "被校验的运行时不是做校验的运行时"——这个理由成立吗？

**部分成立，但它没有覆盖实施方以为它覆盖的东西。**

**成立的部分**：python3.11 确实不是被启动的 node。node 的字节在第 4 步由 `sha256sum`（coreutils）核，在第 3 步由 python 再核一遍——**node 有两条互相独立的见证**。这一条实施方说对了。

**不成立的部分：python3.11 自己在清单里（`/usr/bin/python3.11`，6,639,992 字节，`f56a5885…`），而第 3 步是 python3.11 在核这份清单。一个被篡改的 python3.11 完全可以对自己的那条报"匹配"。这确实是循环。**

但**这个循环不是新引入的**：【实测】前代清单 331 条里包含 `C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`，以及它的 .NET 运行时 `mscorlib.dll`、`System.dll`。**前代的校验者也在自己的清单里。** 所以这一条是**持平，不是退步，也不是改进**——实施方把它当成一条改进理由来写，是不准确的。

**真正退步的是另一件事**：前代把 `powershell.exe` + `mscorlib.dll` + `System.dll` **钉进了清单**；新版执行第 1 步与第 4 步的 `/bin/sh`（→ dash）、`sha256sum`、`cut`、`test` **一个都不在清单里**。也就是说，**新版里"清单摘要"和"node 字节"这两步，完全跑在未被钉住的二进制上。** 这与 F4 合并成阻断项 R14-F4/F5（见第八节）。

### 5.5 一处不影响判定但需记录的差异

`REPO=/home/user/cross-memory-system` 与 `workdir` 均硬编码实施方检出的绝对路径，`fixed_host.py:70` 的 `source = Path('/home/user/cross-memory-system/skills/clued')` 同理，清单里 45 条 node_modules 也以该前缀落钉。**前代同样硬编码了 Windows 检出路径，所以这是持平。** 但它与 (7) 叠加：控制器不仅绑定镜像，还绑定**检出路径**。资格声明应把这条路径写成显式前提。

**(5) 裁定：五步同序，第 2 步更严，第 4 步钉值正确；"校验者不是被校验者"的理由是持平而非改进；清单覆盖被削弱（转 F4/F5）。**

---

## 六、(6) 新清单 253 条是否诚实

### 6.1 先说方法：方法是对的，而且我复现了

【实测】我用实施方的 `build-linux-manifest.mjs` 里同一段代码，在**我自己的容器**里重新枚举 Python 闭包：

```
parent600.py  闭包 59 个 /usr/lib/python3.11/ 下的文件 → 与清单 59 条完全对上，不在清单中者 0
fixed_host.py 闭包 53 个                                → 不在清单中者 0
bridge.py     闭包 47 个                                → 不在清单中者 0
```

**"实际 import 后读 `sys.modules`"比前代的手工列举可靠，我确认这一点，并确认 `parent600.py` 的闭包是另外两个入口的超集。** 这条做得好。

### 6.2 但 331 → 253 少掉的 78 条里，有两类是**这台机器真的需要而漏了**的

#### 漏项一（阻断）：57 个 `.pyc` —— 真正被执行的字节不在清单里

【实测】

```
/usr/lib/python3.11/__pycache__ 存在，170 个 .pyc
清单里的 57 个 stdlib .py：
    有对应 __pycache__ .pyc 的      : 57 / 57
    其中当前有效（因而被实际加载）  : 57 / 57
    这 57 个 .pyc 在清单里的         : 0
```

逐项核过 `argparse` / `json` / `hashlib`：`__cached__` 指向 `__pycache__/*.cpython-311.pyc`，文件存在；`argparse` 的 pyc 头：`MAGIC_OK True`、`flags 0`（时间戳式）、`pyc.mtime 1772529983 == src.mtime`、`pyc.size 100579 == src.size`、`CACHE_VALID True`。

**`-B` 只禁止*写*字节码，不禁止*读*。** 所以 CPython 加载的是 `.pyc`，清单钉的 57 个 `.py` **一个都不会被执行**。

**这不是"少钉了几个文件"，这是**绕过**：** 时间戳式 `.pyc` 的校验字段（mtime、size）就写在 `.pyc` 头里，由攻击者完全控制。**只改 `.pyc`、不碰 `.py`，可以塞进任意代码并让全部 253 条校验通过。**

**【实测】前代清单包含 44 个 `.pyc`**（`C:/…/Python312/Lib/__pycache__/*.cpython-312.pyc`）。**所以这是对前代的明确退步，不是环境差异。**

#### 漏项二（阻断）：执行第 1 / 第 4 步的 shell 与工具

【实测】前代清单含 `powershell.exe`、`mscorlib.dll`、`System.dll`（PowerShell 及其运行时）。
新清单**不含** `/bin/sh`（→ `dash`）、`sha256sum`、`cut`、`test`、`env`。
而第 1 步（清单摘要）和第 4 步（node 字节）**完全由这些未钉住的二进制执行**。

### 6.3 其余 78 条的去向 —— 这部分是诚实的

| 前代条目 | 新环境 | 判定 |
| --- | --- | --- |
| 106 条 `AppData/…/Python312/` 树（含 `python.exe`、`python312.dll`、`python3.dll`、`_hashlib.pyd`、`_uuid.pyd`、44 个 `.pyc`、Lib 源码） | Linux 上对应 `/usr/bin/python3.11` 单文件 + 59 条 stdlib | 大体对应，**但 `.pyc` 那 44 条没有对应物**（漏项一） |
| `docker.exe` / `gh.exe` / `node.exe` | `/usr/bin/docker`、`/usr/local/bin/gh`、`/opt/node22/bin/node` | 对应，符号链接已解析 ✅ |
| `powershell.exe` + `mscorlib.dll` + `System.dll` | 无对应物 | **漏项二** |
| Docker Desktop / GitHub CLI 的 Windows 配置与插件 | 本机确实没有 | **合理，真的不需要** |

【实测】动态库层面：`/usr/bin/python3.11` **不**链接 `libpython3.11.so`（解释器为静态内嵌），所以前代 `python312.dll` 在这里**没有对应缺口**——这一条对实施方有利，我照实记。`libm/libz/libexpat/libc/ld-linux`、node 的 `libstdc++/libgcc_s`、`_hashlib.so` 与 `sha256sum` 共用的 `libcrypto.so.3` 均未钉——**但前代也没钉 Windows 侧的等价物，属持平**，只作提示。

### 6.4 我自己跑了一遍 `verify-manifest-against-host.mjs`

【实测】在**我这个容器**里，`--map /=/`：

```
state    MANIFEST_HOST_VERIFICATION
verdict  DRIFT_DETECTED
counts   verified 207,  mismatched 0,  missing 46,  uncheckable_here 0
```

**实施方报的 `ALL_ENTRIES_VERIFIED` 253/253 在他们那个容器里是真的，在下一个容器里就不是了。** 这正好是 (7)。

另：该脚本的 `gh_exe` 那一行报 `NOT_IN_MANIFEST` 并回显 `trusted_github_mjs_pin: e2efa10a…` —— 实施方在提交说明里把它解释成"只是因为它找文件名以 gh.exe 结尾的条目"。**那个解释是对的，但它掩盖了真问题**：回显出来的 `e2efa10a…` 正是仍然钉在 `trusted-github.mjs` 里的 Windows 摘要（见 R14-F3）。**脚本把阻断项打印在屏幕上了，被当成了误报。**

**(6) 裁定：方法可靠、大部分删减诚实、Python 闭包枚举我逐条复现通过；但漏了两类这台机器真的需要的文件，其中 `.pyc` 一类构成可绕过。不通过。**

---

## 七、(7) 容器的可复现性 —— 实施方没验，我验了

**这是本轮唯一一个我能直接做实验的问题：我这个会话本身就是"下一个容器"。**

### 7.1 实验结果

【实测】对四个宿主二进制：

| 清单条目 | 字节数 | 本容器 |
| --- | --- | --- |
| `/opt/node22/bin/node` | 124,679,552 | **存在，sha256 `81925c09…` 完全一致** |
| `/usr/bin/docker` | 44,320,674 | **存在，sha256 `18c2a16d…` 完全一致** |
| `/usr/bin/python3.11` | 6,639,992 | **存在，sha256 `f56a5885…` 完全一致** |
| `/usr/local/bin/gh` | 50,098,328 | **不存在** |

全量：**207 条逐字节一致、0 条不匹配、46 条缺失。**

**46 条缺失 = 45 条 node_modules + 1 条 `gh`。**

### 7.2 45 条 node_modules：可复现，我测了

【实测】`apps/clued-cloud/node_modules` **被 `.gitignore` 排除，不在版本控制里**（`apps/clued-cloud/.gitignore:4:/node_modules`），本容器里不存在——实施方是在自己容器里 `npm install` 出来的。

但 `apps/clued-cloud/package-lock.json` 在版本控制里，钉着 `ajv 6.15.0`、`fast-deep-equal 3.1.3`、`uri-js 4.4.1`、`json-schema-traverse 0.4.1`、`fast-json-stable-stringify 2.1.0`，均带 `integrity`。

我在临时目录执行 `npm install --no-save --ignore-scripts ajv@6.15.0`，然后逐条比对清单里的 45 条：

```
node_modules entries: 45   identical: 45   mismatched: 0   missing: 0
```

**45/45 逐字节复现。这一类是可恢复的**，代价是把 `npm ci`（或按 lockfile 版本安装）写进控制器的启动前提。

### 7.3 1 条 `gh`：不可复现

清单钉 `/usr/local/bin/gh`，50,098,328 字节，`f687dc93…`。它**不是镜像自带的**，是实施方下载安装的。清单里**没有记录来源 URL、没有记录版本号、没有记录上游发布摘要**。

**所以任何人拿到这份清单，都无法重新做出一个能通过校验的 `gh`。** 它随实施方那个容器一起消失了——**与那台 Windows 机器消失的方式一模一样，只是规模小。**

### 7.4 对 (7) 的判断与建议

**结论（实测，非推测）：镜像提供的部分跨容器逐字节可复现；手工装进容器的部分不可复现。**

这比 `LinuxHostFeasibilityFinding.md` 第五节的悬而未决更好也更坏：好在 207 条零漂移证明了"容器镜像不可变"这个假设是**对的**；坏在**清单里混进了不来自镜像的条目**，而这一类恰好继承了 Windows 宿主"会自动更新/无法重建"的全部毛病。

**建议，三条，按优先级：**

1. **把 `gh` 从"手工安装物"变成"有来源钉的安装物"。** 在控制器目录里加一份 `host-provisioning.json`：release tag、下载 URL、tarball 的上游 sha256、解包后二进制的 sha256。这样它与 node_modules 同级——**可复现，而非不可复现**。
2. **资格声明的有效期不应绑定在会话上，应绑定在"启动前复验通过"上。** 绑定单个会话在操作上等于每次都要重签资格；更好的形式是：资格声明写明"本资格以清单 253 条在启动时全部复验通过为条件"，并把 `verify-manifest-against-host.mjs --map /=/` 的 `ALL_ENTRIES_VERIFIED` 作为 `tool-entry.functions.js` 之前的**第 0 步**。（第 1–3 步已经实质上做了这件事，所以这条主要是把"资格何时有效"写清楚，而非增加检查。）
3. **在清单里给每条 `RUNTIME_DEPENDENCY` 加一个 `provenance` 字段**：`IMAGE`（镜像自带，跨容器可复现——本次实测 207 条属此类）/ `LOCKFILE`（由 lockfile 可重建——45 条）/ `MANUAL`（手工安装，不可复现——1 条）。**这样清单自己就说明白了它有多少条是靠不住的。** 现在这个信息只存在于我这份复核里。

**(7) 裁定：已由实测回答。不单独构成阻断项，但 `gh` 那一条与 R14-F3 是同一个洞的两面。**

---

## 八、(8) 综合裁定 —— 不予资格化

**不签发 `ScopedControllerQualification`，不签发运行时受理。** 阻断项如下。

### R14-F1【阻断】python 解释器摘要没有重钉，控制器必抛

【实测】

```
host-effect.mjs:6   const python='/usr/bin/python3.11';            ← 路径改了
host-effect.mjs:15  sha(fs.readFileSync(python)) !== '4d6f5f81a4bca11191c4c7c6b43632694d0a4ce74e068619d8fdc161d469859a'
                        → throw 'EXACT_PYTHON_BRIDGE_BYTES_REQUIRED'   ← 摘要没改，仍是 Windows python.exe 的

fixed_host.py:40    PYTHON = Path('/usr/bin/python3.11')           ← 路径改了
fixed_host.py:41    PYTHON_SHA = '4d6f5f81a4bca…'                  ← 摘要没改
fixed_host.py:195   if observation.digest(PYTHON) != PYTHON_SHA:
                        raise observation.Unknown('Fixed watchdog interpreter drift')
```

`/usr/bin/python3.11` 的实际 sha256 是 **`f56a588548dd013906ae1dcd1b6faa417f4e204da634ff354840d9643e78ff9e`**，与**控制器自己的清单条目一致**。

**即：控制器的清单说这个文件是 `f56a5885…`，控制器的代码要求它是 `4d6f5f81…`。自相矛盾。**

后果：`invokeFixedHost` 的**第一次**调用（`CREATE`）即抛 `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED`；`arm_watchdog` 抛 `Fixed watchdog interpreter drift`。**600 秒运行的容器创建这一步就过不去。**

（`bridge.py` 的另一半钉值 `60e4cfac…` 我核过，**是对的**：`sha256sum bridge.py` = `60e4cfac015c15fd53921a61a6566f740e7414f218120b0bdbc17bf17be64fd7`。所以这条抛错只会由 python 那一半触发。）

**修法**：`host-effect.mjs:15` 与 `fixed_host.py:41` 两处改为 `f56a588548dd013906ae1dcd1b6faa417f4e204da634ff354840d9643e78ff9e`。改完控制器摘要变，下游全部要重签。

### R14-F2【阻断】Docker 端点仍是 Windows 命名管道，客户端实测崩溃

【实测】

```
parent600.py:39   DOCKER   = '/usr/bin/docker'                                  ← 改了
parent600.py:40   ENDPOINT = 'npipe:////./pipe/dockerDesktopLinuxEngine'        ← 没改
parent600.py:124  prefix = [DOCKER, '--host=' + ENDPOINT, '--config=' + …]      ← 每一次 docker 操作都走这里
```

我在本容器直接跑：

```
$ /usr/bin/docker --host='npipe:////./pipe/dockerDesktopLinuxEngine' version
panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x58 pc=0x5644e8650c20]
goroutine 1 [running]:
github.com/docker/cli/vendor/github.com/moby/moby/client.(*Client).ClientVersion(…)
```

**不是"失败"，是段错误崩溃。** Linux 上的 docker 客户端无法处理 `npipe://` 方案。

这一条格外要紧，因为 `LinuxHostFeasibilityFinding.md` 把"Docker 能跑、镜像拿得到"当成已解决。**那两件事确实解决了——但都是用裸 docker 命令和 `validation.py` 验的，没有一次经过 `parent600.py` 自己的 `prefix`。** 这与实施方本轮三次"一条命令失败 ⇒ 一整类能力不存在"是同一个毛病的镜像：**一条命令成功 ⇒ 一整类能力存在。**

**修法**：`ENDPOINT` 改为 `unix:///var/run/docker.sock`（或删掉 `--host=` 改用 `DOCKER_HOST`）。**并且必须实测一次 `parent600.py` 自己的 `prefix` 能跑通，不能再用旁路验证代替。**

### R14-F3【阻断】`gh` 摘要没有重钉，首次 GitHub 读取即抛

【实测】

```
trusted-github.mjs:5   const gh='/usr/local/bin/gh';                                    ← 路径改了
trusted-github.mjs:6   const expectedGh='e2efa10a5d2ce93cac9bc4b676932b62947c0967c01c8f2c3a9cb4437ad358d3';  ← 没改
trusted-github.mjs:13  check(sha(fs.readFileSync(gh))===expectedGh,'GITHUB_CLI_BYTES_DRIFT');  ← 每次 api() 都重算
```

`e2efa10a…` 是 Windows `gh.exe`（41,775,416 字节）。清单钉的 Linux `gh` 是 `f687dc93…`（50,098,328 字节）。**又一次自相矛盾。**

后果：`api()` 在每次调用前重算，**第一次调用即抛**。而 `readBlobRef` 与 `verifyOwnerMergeArtifact` 都走 `api()`，`loadAuthenticatedCapacityMaterials` 又必须走它们（`context.mjs:280` `check(capacity_materials!==null,'NEW_CAPACITY_CONSUMER_REQUIRES_ACTUAL_SUPPLEMENT')`）。**这条在容器创建之前就会拦死，比 F1 还早。**

提交说明写的是 "gh is downloadable …, needing only a re-pinned digest since the old one is the Windows exe"——**诊断完全正确，动作没做。**

叠加 7.3：`/usr/local/bin/gh` 在新容器里不存在，所以就算重钉了摘要，也还要先解决"这个 `gh` 从哪来、凭什么是它"。

**修法**：先按建议 7.4-①把 `gh` 的来源钉住，再把 `expectedGh` 改成那个来源产出的实际摘要。

### R14-F4【阻断】清单钉了不会被执行的字节，漏了会被执行的字节

见 6.2 漏项一。**57 个被实际加载的 `.pyc` 不在清单；清单里的 57 个 `.py` 不会被加载。前代钉了 44 个 `.pyc`。**

**这不是完整性瑕疵，是完整性检查的绕过路径**：时间戳式 `.pyc` 的校验字段由文件本身携带，改 `.pyc` 而不碰 `.py`，253 条全绿。

**修法二选一**：
- (a) 把 `.pyc` 加进清单（前代做法，57 条），或
- (b) 启动时设 `PYTHONDONTWRITEBYTECODE` **并不足够**——必须让解释器不读 `.pyc`。可行做法是把 stdlib 的 `__pycache__` 移出 `sys.path` 可达范围，或改用 `--check-hash-based-pycs always` 配合基于哈希的 `.pyc`。**(a) 更简单，也与前代一致。**

### R14-F5【阻断】执行第 1、4 步的 shell 与工具不在清单

见 6.2 漏项二。前代钉了 `powershell.exe` + `mscorlib.dll` + `System.dll`；新版的 `/bin/sh`（dash）、`sha256sum`、`cut`、`test` 一个都不在。**清单摘要校验与 node 字节校验这两步跑在完全未钉住的二进制上。**

**修法**：把 `/bin/dash`（`/bin/sh` 的 realpath）、`/usr/bin/sha256sum`、`/usr/bin/cut`、`/usr/bin/test`（或改用 `[` / shell 内建以减少外部依赖）加进清单，与前代对齐。

### 需要更正、但不阻断的项

| 编号 | 内容 |
| --- | --- |
| R14-N1 | `OwnerBaselineSubstitutionDecision.json` 的 `residual_gap_stated_exactly` / `how_wide_that_is` 把 `gate_attempts` 侧的缺口说窄了。更正依据见 2.4。**Owner 在一份不准确的缺口陈述上签了字，应当重新过目。** |
| R14-N2 | `context.mjs:170` 注释 "Strictly stronger" 不准确。内容更强、三处派生守卫更弱，后者被摘要钉死中和。见 3.5。 |
| R14-N3 | `LinuxHostFeasibilityFinding.md` 第五节"容器可复现性尚未验证"已由本轮实测回答：207/253 逐字节一致、0 不匹配、46 缺失（45 可由 lockfile 重建、1 不可）。 |
| R14-N4 | Owner 决定书援引的三个不变性触发器是 `tgenabled='O'`，可被 `session_replication_role='replica'` 绕过；且 `accepted_binding` 的 `n_tup_upd=4` 说明该类触发器至少在一张表上未覆盖全部历史。见 2.6。 |
| R14-N5 | `xmin` 证据易腐（`VACUUM FREEZE` 后 `xmin` 一律读成 2），而决定书只记了聚合值。**第九节的逐行数据应当并入决定书或另存为证据文件。** |
| R14-N6 | 建议把 `canonical` 那 495 字节的 sha256 `8bf54a9f568e19f0f6df939f002756201b818abe3a2d2578d7a222e0eb32a9fb` 作为不变量写进资格声明，防止两份定义日后各自漂移。 |
| R14-N7 | 清单 45 条 node_modules 以实施方检出的绝对路径 `/home/user/cross-memory-system/…` 落钉，`tool-entry.functions.js` 的 `REPO` 与 `fixed_host.py:70` 同样硬编码该路径。**前代同样绑定 Windows 检出路径，属持平**，但应在资格声明里写成显式前提。 |

### 还没走到、但资格化之后立刻会撞上的两条（提前告知，不列为本轮阻断项）

1. **新控制器不在 `main` 上。** 【实测】`git ls-tree origin/main scripts/phase2-qualification/control-context-verifier-root6-linux-successor/` 为空。而 `ScopedControllerQualification` 的 `source_ref.blobs` 是 GitHub blob URI，`readBlobRef` 通过 API 取。**资格签发之前，控制器必须先合并进 `main`。** 这意味着比 `Status24ChainDependencyFinding.md` 的排期**多一次 Owner 合并，且排在最前面。**
2. **控制器摘要会变。** 新清单 sha256 = `9c04acdebf5fa550db41739e470df98dd758578f2ed0008011a66dbdda832b22`（52,858 字节），前代 = `3a58eb873902d1625fa6b1f2d252efed78b205e3cb04cc356f064aacd4172dae`。修完 F1–F5 之后它还会再变一次。**钉 `controller_digest` 的两份文件与据此重签的七份文档，要等 F1–F5 全部落定之后再一次性重签，不要分两轮。**

---

## 九、附：`execution_events` 逐行 xmin 证据（为 `VACUUM FREEZE` 之后留底）

【实测】测于 2026-09-12，`pg_snapshot_xmin(pg_current_snapshot())` = 2141。格式 `sequence:xmin:recording_transaction_id:ctid块/偏移`。
**测量时 `xmin = 2`（已冻结）的行数为 0；`xmin <> recording_transaction_id` 的行数为 0；`ctid` 与 `sequence` 逆序对 0 处；`xmin` 逆序对 0 处。**

```
1:1815:1815:0/1    2:1819:1819:0/2    3:1822:1822:0/3    4:1823:1823:0/4
5:1828:1828:0/5    6:1830:1830:0/6    7:1831:1831:0/7    8:1836:1836:0/8
9:1837:1837:0/9   10:1844:1844:0/10  11:1845:1845:0/11  12:1847:1847:0/12
13:1848:1848:0/13 14:1849:1849:0/14  15:1850:1850:0/15  16:1855:1855:0/16
17:1856:1856:1/1  18:1862:1862:1/2   19:1864:1864:1/3   20:1865:1865:1/4
21:1866:1866:1/5  22:1867:1867:1/6   23:1871:1871:1/7   24:1872:1872:1/8
25:1878:1878:1/9  26:1881:1881:1/10  27:1883:1883:1/11  28:1885:1885:1/12
29:1886:1886:1/13 30:1887:1887:1/14  31:1888:1888:1/15  32:1889:1889:1/16
33:1890:1890:1/17 34:1891:1891:2/1   35:1892:1892:2/2   36:1893:1893:2/3
37:1894:1894:2/4  38:1895:1895:2/5   39:1896:1896:2/6   40:1907:1907:2/7
41:1910:1910:2/8  42:1912:1912:2/9   43:1915:1915:2/10  44:1917:1917:2/11
--- 以上为被 BASELINE_EVENTS_DIGEST 钉住的前 44 条 ---
45:1926:1926:2/12 46:1928:1928:2/13  47:1930:1930:2/14  48:1932:1932:2/15
49:1934:1934:2/16 50:1938:1938:2/17  51:1940:1940:3/1   52:1943:1943:3/2
53:1944:1944:3/3  54:1945:1945:3/4   55:1946:1946:3/5   56:1948:1948:3/6
57:1950:1950:3/7  58:1958:1958:3/8   59:1959:1959:3/9   60:1970:1970:3/10
61:1971:1971:3/11 62:1992:1992:3/12  63:1999:1999:3/13  64:2004:2004:3/14
65:2009:2009:3/15 66:2015:2015:3/16  67:2027:2027:3/17  68:2040:2040:4/3
69:2045:2045:4/4  70:2045:2045:4/5   71:2053:2053:4/6   72:2060:2060:4/7
73:2062:2062:4/8  74:2067:2067:4/9   75:2067:2067:4/10  76:2074:2074:4/11
77:2075:2075:4/12 78:2078:2078:4/13  79:2078:2078:4/14  80:2088:2088:4/15
81:2090:2090:5/1  82:2099:2099:5/3   83:2099:2099:5/4   84:2109:2109:5/5
85:2111:2111:5/6  86:2118:2118:5/8   87:2118:2118:5/9   88:2135:2135:5/10
```

空槽：`4/1`、`4/2`、`5/2`、`5/7`，共 4 个，与 `n_tup_ins(92) − 88 = 4` 及 `n_dead_tup = 4` 吻合（回滚事务残留）。
`recorded_at`：第 1 条 `2026-09-08T18:33:58.784674Z`，第 44 条 `2026-09-09T16:04:46.752051Z`，第 45 条 `2026-09-10T01:35:48.642228Z`。

`gate_attempts` 十四行（`xmin` 为**最后一次更新**的事务，非插入事务，见 2.4）：

```
ga_18ce0e28… bs=1  BLOCKED revoked=true  xmin=1824  ga_a7a420f7… bs=5  BLOCKED revoked=true  xmin=1838
ga_6de63612… bs=11 BLOCKED revoked=true  xmin=1857  ga_87882f42… bs=18 BLOCKED revoked=true  xmin=1873
ga_165dc2e7… bs=27 FAIL    revoked=true  xmin=1898  ga_c5041817… bs=41 BLOCKED revoked=true  xmin=1918
ga_04377008… bs=46 BLOCKED revoked=true  xmin=1935  ga_4e7ce4ad… bs=51 BLOCKED revoked=true  xmin=1951
ga_1d52f477… bs=59 STALE   revoked=false xmin=1972  ga_6abb193a… bs=68 BLOCKED revoked=false xmin=2047
ga_71a1d946… bs=73 BLOCKED revoked=false xmin=2068  ga_41643fec… bs=77 BLOCKED revoked=false xmin=2080
ga_e56ca0eb… bs=81 BLOCKED revoked=false xmin=2101  ga_8eb41060… bs=85 BLOCKED revoked=false xmin=2120
```

**十四行全部 `receipt_raw` 非空 ⇒ 现已被 `guard_gate_bytes` 整行冻结（2.5）。无一为 PASS（3.5）。**

---

## 十、一并处理的两项

### 10.1 R13-F3 的修复 —— 确认正确，三条不变量确实保持

【实测】`Root6GenerationRegistration.candidate.json` → `request.body.signature_binding`：

```json
{
  "owner_merge_commit": "cbe898d3f5b66f279d78a6b8d583d2c1885d9c89",
  "signed_object_sha256": "95973246e3ae8d33fe407960d41e47039399575c59b4f78f83882835e73d9f80",
  "signature_evidence_ref": {
    "uri": "https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/cad73582f879ed77df94edc13f23af1ebb95fc4d",
    "sha256": "69e84e741814765067e81dfa5842f46d9887cea2a3c149fc03b422b7bd51cfc1"
  }
}
```

指向物身份核实：

```
artifacts/…/bootstrap/next-window-20260912/OwnerApprovalVerification.json
  git hash-object : cad73582f879ed77df94edc13f23af1ebb95fc4d   ← 与 uri 中的 blob 一致
  sha256          : 69e84e741814765067e81dfa5842f46d9887cea2a3c149fc03b422b7bd51cfc1  ← 与 ref.sha256 一致
  git ls-tree origin/main 同路径 → 同一 blob                    ← 已在 main 上，API 取得到
```

**内容核实 —— 这才是 R13-F3 的实质**，逐条对上：

| R13-F3 指出的毛病 | 新指向物 |
| --- | --- |
| 旧的证明的是 Owner 合并 2（`3887b9e0…`），而 `owner_merge_commit` 是合并 1（`cbe898d3…`） | `merge.sha` = `cbe898d3f5b66f279d78a6b8d583d2c1885d9c89` = `owner_merge_commit`，**同一次合并** ✅ |
| 旧的自述 `kind = EXACT_NW01_CONTINUATION_SUBJECT_SIGNATURE_EVIDENCE`（NW-01 续延主体，非代际注册） | `kind = VERIFIED_OWNER_CONTINUATION_APPROVAL`，`status = VERIFIED` ✅ |
| 旧的 `approved_window` 不是 root6 的窗口 | `fixed_window` = `2026-09-12T07:05:16Z` → `2026-09-13T07:05:16Z`，**正是 root6 窗口**（`root6Expiry` 与 `validateRootShape` 的上界均为 `2026-09-13T07:05:16Z`） ✅ |
| 旧的 `authority_effect = NONE_UNTIL_EXACT_NW01_TRANSACTION`，效力已随 NW-01 用尽 | `authority_effect = FIXED_WINDOW_SCOPE_APPROVED_ONLY; NO_DATABASE_EFFECT`，**未被耗尽** ✅ |

另：`merge.verification.verified = true` / `reason = "valid"` / `committer_login = "web-flow"` / `author_login = "tdoljyj"`，PR #158，`merged_by = tdoljyj`；该文件自陈 `verification_method.is_the_controller_verification = false`（是第二实现，不替代控制器自己的验证）——**这个自我限定是诚实的，我确认。**

**三条不变量 —— 用真正的 `root-window-validation.mjs` 跑出来的，不是复述：**

```
reviewSubjectDigest    : 293da3c512f63a9b1f7b3d07fa3282975917cac3bb94ccf831f03707bb3b572b  ← 与第十二轮受理所钉一致 ✅
signaturePayloadDigest : 95973246e3ae8d33fe407960d41e47039399575c59b4f78f83882835e73d9f80
signed_object_sha256   : 95973246e3ae8d33fe407960d41e47039399575c59b4f78f83882835e73d9f80  ← 两者相等 ✅
validateRootShape      : {"status":"SHAPE_VALID_ONLY","authority_effect":"NONE","signature_verified":false}  ✅
```

（跑法：把 `root-window-validation.mjs` 与 `control-trust-root-set.schema.json` 连同 ajv 复制到临时目录按相同相对布局运行，未改动实施方检出的任何文件，产物已删。schema 的 sha256 `87f094fa…` 与 `Root6RegistrationAcceptance.json` 的 `schema_sha256` 一致。）

**裁定：R13-F3 已正确修复，三条不变量全部保持。第十二轮对被受理主体的受理（`reviewSubjectDigest` = `293da3c5…`）仍然有效，未被这次修改触动。**

**但注意**：R13-F3 的解除**不等于**注册体现在可以提交。第八节两条"提前告知"仍然在前面挡着，`HostLossTerminalRecord.md` 第五节的三条理由也有两条仍然成立（17–20 步走不通、注册只会把干净的停止状态变成半截状态）。

### 10.2 `Status24ChainDependencyFinding.md` 的结论在新控制器下是否还成立

**【读文本 + 实测】成立，且需要往前再加一次合并。**

该发现的因果链是：第 20 次前推要 Status24 受理 → Status24 受理要钉 `runtime_function_acceptance` → 其 root6 对应物是"CP-01 应用之后、对其实测后像的独立受理" → CP-01 未应用，该文件结构上不存在。

**这条链上没有任何一环与控制器实现相关。** 它全部关于 CP-01 与 root6 注册。**换控制器不改变它。第四次 Owner 合并仍然是结构性必需，仍然必须排在 CP-01 应用之后，仍然不能并入第三次。**

**但新控制器在它*前面*加了一次：** 见第八节"提前告知"第 1 条——新控制器目录不在 `main` 上，而资格声明的 `source_ref.blobs` 是 GitHub blob URI。**控制器必须先合并，才谈得上被资格化。** 所以修订后的次序，在原 `Status24ChainDependencyFinding.md` 第三节的 `13` 之前要插一段：

```
12a  修复 R14-F1…F5
12b  【评估者】新控制器资格化评审（本轮的重做）
12c  【Owner】合并：新控制器 + 其资格 + 其运行时受理 + 据新 controller_digest 重签的下游文档
13   注册 root6                                   ← 不可回退
…（其余不变，13d / 13f 仍由独立评估者签发，第四次合并仍在 CP-01 之后）
```

### 10.3 顺带更正一处 —— `HostLossTerminalRecord.md` 对 CP-01 的说法过重

`HostLossTerminalRecord.md` 第二节写：控制器改一个字节，"CP-01 的 A1 / A2 两处编辑（钉的正是本控制器携带的 schema 摘要 `510f3b90…`）"随之失效。

【实测】`510f3b90…` 是 **`status-manifest.root5.schema.json` 这个文件本身的 sha256**，不是控制器摘要：

```
status-manifest.root5.schema.json       window11 = 510f3b90cdb026c8…   linux = 510f3b90cdb026c8…   逐字节相同
gate-result-receipt.root5.schema.json   window11 = fae1e8562fa1a551…   linux = fae1e8562fa1a551…   逐字节相同
```

**两份 schema 在新控制器里一个字节都没变。所以 CP-01 的 A1 / A2 两处编辑不需要因为换控制器而重做。** 需要重签的是钉 `controller_digest` 的那两份（资格与运行时受理）及据此重签的七份文档，**不包括 CP-01 的 schema 摘要钉。** 这使重建的工作量小于终局记录的估计。

---

## 十一、对实施方的一句话

本轮实施方做对的三件事都很硬：**摘要算法是逐字节复制的（不是重写）、摘要值是真的（我自己算了一遍，15/15）、Python 依赖是实际 import 出来的（不是猜的，我三个入口各复现一遍，0 处遗漏）**。这些是扎实的工作。

四条阻断项里有三条是**同一个动作没做完**：把路径从 Windows 改到 Linux 时，**配套的摘要没跟着改**。`node` 那一处改对了，`python`、`gh`、`docker 端点`三处没有。三处的提交说明里都写着"已重钉"或"只需重钉"——**说明诊断没有问题，是从诊断到动作之间掉了。**

这与本轮已经记下的三次错误（Docker、镜像、派工表）形状不同但根因相同：**在一处做对了判断，没有把同一条判据推到它该覆盖的全部位置。** 换路径的地方有四处，检查了一处。

第四条 `.pyc` 不属于这一类，它是一个真的不容易想到的问题——但前代清单里那 44 个 `.pyc` 就是答案，**它在你重建清单时被丢掉了，而丢掉它的那一步（用 `sys.modules` 的 `__file__` 枚举）恰好只会返回 `.py`**。方法本身是好的，它只是看不见这一类。

**还有一条建议，与代码无关：** 你在 `LinuxHostFeasibilityFinding.md` 里写下"在说做不到之前，至少要把同类的其它入口试一遍"。这条同样适用于反方向——**在说做得到之前，至少要让被声称能跑的那条路径自己跑一次。** `parent600.py` 的 docker 调用从头到尾没有被执行过一次，而验证它只需要一条命令。

---

## 边界（再述）

未写库、未注册代际、未消耗那唯一一次 600 秒分配、未预留预算、未调用 `append_event` 或任何会写库／消耗预算的函数、未执行任何 `do $$ … $$` 块。全部 SQL 为 `select`。
`charged_seconds` 仍 9906（上界 10506），`current_head` 仍 root5 / sequence 5。
未起 600 秒容器、未走 GA 通路、未签发 GA。未修改实施方检出的任何文件；临时产物在临时目录，已删除。
**本文件不签发资格、不签发运行时受理、不构成授权、不批准也不合并任何 PR。** 最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。
