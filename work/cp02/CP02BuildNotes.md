# CP-02 生成器构建说明

**状态：草稿。没有产出任何可执行 SQL，没有对库做任何写入。**
本次全部数据库交互都是只读 `select`（project `uscrdifznmlvczcekqpw`，2026-09-13）。

## 产出

| 文件 | 说明 |
| --- | --- |
| `work/cp02/build-cp02-sql.mjs` | 生成器。不连库、不执行，只读一个 JSON、写文本 |
| `work/cp02/cp02-derive.sql` | 只读推导。已实跑，见下 |
| `work/cp02/cp02-apply.DRAFT.sql` | 事务草稿，**NOT FOR EXECUTION**，带两道绊线 |

用法：

```
node work/cp02/build-cp02-sql.mjs                # 生成
node work/cp02/build-cp02-sql.mjs --discriminate # 跑五条判别器
```

可执行的 `cp02-apply.candidate.sql` **在草稿状态下根本不会被写出来**——文件名本身就不存在，
不靠人去读横幅。生成器还会在状态回退成草稿时删掉上一轮遗留的 candidate 文件。

## 先说最要紧的一条：规则表有一个实测缺口（CP02-OF1）

C6 只换了一个字面量，但它所在的是 CP-01 G8/B9 装进去的**三条耦合断言**。
`reserve_gate` 与 `reserve_execution_budget` 各带一份（`append_status_manifest` 无）：

```
(i)   sha256(events where (e->>'sequence')::bigint<=5)          is distinct from '45c6a2cb…'
(ii)  jsonb_array_length(series_view->'root'->'events')         is distinct from 6
(iii) sha256((root - 'events') || {registration_event: (e->>'sequence')::bigint=6})
                                                                is distinct from '72355efd…'
```

C6 换的是 (iii) 里的摘要，仅此而已。root7 注册后 root 的 events 会变成 7 条，于是：

* **(ii) 会直接抛 `series_full_original_root_changed`**，每次调用都抛；
* (iii) 的选择器还是 `sequence=6`，仍然取 root6 的注册事件——不管往里钉什么摘要，
  断言的都不是这个类名所声称的 root7 形状。

实测命中数（只读，2026-09-13）：`is distinct from 6`、`(e->>'sequence')::bigint=6)`、
`(e->>'sequence')::bigint<=5)`、`45c6a2cb…` 四者在两个函数里**各 1 处**，
在 `append_status_manifest` 里各 0 处。

**不拍板**：(ii)(iii) 是落在 M3 载体已授权的
`FULL_ROOT_OBJECT_DIGEST_REPINNED_TO_ROOT7_POST_REGISTRATION_MEASURED_VALUES` 这一类之内
（把 C6 改写成覆盖整块的单一锚点），还是需要再裁一条类，这是审批问题不是编辑问题。
(i) 的 `<=5` 要不要跟着动更是另一个问题——前五条 root 事件本身不变，`<=5` 很可能本来就对。
这三问都留给评审。

生成器把它作为 `OPEN_FINDINGS` 里的一条硬闸：**只要这条还在，就永远只出草稿**。
清掉它的办法是删掉那一条并在本文件写明是哪次裁决清的——而不是自己去加规则。

## 与 CP-01 的世系

事务形状照抄 `work/cp01/cp01-apply.candidate.sql`：单事务、八表 ACCESS EXCLUSIVE、
四个函数 prosrc 摘要在事务头断言（含 `effective_execution_binding()` 这只不许动的）、
漂移即弃、事务内只读回读 + 提交后另开只读会话再读一次、注释里写明禁盲重试。
Round-11 三条守卫（窗口断言、未触及函数合摘要、`accepted_binding` 触发器断言）
前后块各一份，照旧。函数体一个字节都不进仓库：事务内从 `pg_proc` 读、折叠、比对摘要、才 `execute def`。

### 三处刻意偏离，都写在生成器里标了 DEVIATION

1. **零期望步也断言**。CP-01 只发它预期会命中的编辑；CP-02 对每个函数都发满七条规则，
   命中数为 0 的也发。理由是 `CP02PreimageMeasurement.md` 记的那条教训：危险方向是
   规则写错了形式因而什么都匹配不到，"这里不该出现"应当是断言而不是省略。
   代价是事务里多出六个 no-op `replace`。**是否保留，留给评审**。
2. **草稿不写可执行文件名**，且草稿里有两道 `raise` 绊线——一道在 `begin;` 之前，
   一道在事务里的第一条语句。第二道在事务内是故意的：它一炸，后面每条语句都跟着失败，
   忽略第一条报错的客户端也到不了任何 `CREATE OR REPLACE`。
3. **规则表字节钉 `RULES_DIGEST`**。CP-01 没有这一层。

## 生成时的六层校验（按顺序，顺序本身是设计）

结构性/语义性检查**先跑**，好让报错说清到底哪里错了；字节钉**最后跑**，兜住所有没有名字的改动。

1. 形状：七条、id 不重、类在 `cp02.permitted_edit_classes` 内、非空、非 no-op、
   不含 `600 seconds` / `refund` / `capacity`（边界与 `cp02.prohibited`）、不能三个函数全 0。
2. 次序：必须恰好是 `C1,C2,C3,C4,C5a,C5b,C6`；C5a 先于 C5b；C6 最后。
3. 逐条钉死：
   * C1 两侧都得是 `ctrgen_<32 hex>`；
   * C2 的 `to` 必须等于事务里断言的窗口上界，且窗口跨度必须正好 86400 秒；
   * **C3 必须逐字是 `series_f>16` → `series_f>17`，无空格**；
   * **C4 必须逐字是 `>= 89` → `>= 90`，有空格**——同一份 prosrc 里两种空白约定，
     谁也不许从对方类推；
   * C3/C4 两个函数的命中数必须相等（`cp02.prohibited`：不许只抬一侧）；
   * **C5a 必须是 APPEND**：`from` 里每一个 64-hex 成员在 `to` 里都必须还在，且 `to` 正好多一个；
   * C5b 必须是 REPLACE，两侧各正好一个摘要，新值不得等于旧值；
   * C5a 追加的那个，必须**就是** C5b 钉进去的那个（`correction_log` 记的就是这类缺陷）；
   * C6：要么是哨兵，要么是 64-hex 且不等于 `from`。
4. 前像：规则表里的三个摘要必须与生成器独立实测的三个**逐字相等**，不一致就停，不许选边；
   `MUST_REMEASURE_BEFORE_APPLY` 必须为 `true`。
5. `expected_occurrences` 逐条对独立实测证人表核对，任一不符即中止。
6. `RULES_DIGEST` 字节钉。

### 字节钉的口径

`sha256` 覆盖七条规则的**承重元组**：`id / class / operation / from / to / 三个函数的期望命中数`，
用 U+0001 分隔、换行拼接。散文字段（`why`/`adjudicated`/`measured_context`/`correction_log`）
**故意在外**，评审改注释不会炸钉。**只有 C6 的 `to` 在外**——实化 root7 的 root 对象摘要
是唯一预期中的改动，它由自己那条规则单独管。当前值：

```
2264024a5c57558449fbad460888136b0bc341f8e211a923b711cb4266b81b25
```

## 五条判别器（`--discriminate`，实测五条全部按要求失败）

每条都是「改了就必须拒绝」，而且断言报错信息指的是**对的那件事**——
只会拒绝但理由不对的判别器什么都证明不了（第 4 条最初就栽在这上面：
它被"只抬一侧"的规则先截住了，于是把变异改成两侧同时降，才真正测到实测核对这一层）。

| # | 变异 | 被哪一层截住 |
| --- | --- | --- |
| 1 | C1.to 末位改一个十六进制字符 | `RULES_DIGEST`（结构上仍是合法 ctrgen，没有具名规则管得着） |
| 2 | 把 C5a 当替换做 | APPEND 不变式：`drops the historical allow-list member 510f3b90…` |
| 3 | 打乱 C5a/C5b 次序 | 次序检查 |
| 4 | 把 C4 的期望命中数两侧同时从 3 改成 2 | 独立实测证人表 |
| 5 | 把 C6 实化成 `a93bfdda`（注册体 canonicalDigest 那一类） | C6 的哨兵/64-hex 规则 |

生成器最后还会确认**未变异的表仍然能构建**，否则上面每个 PASS 都不算数。

## 活库实测记录（只读，2026-09-13）

前像三个摘要与 `CP02PreimageMeasurement.md` 一致，等于 CP-01 后像：
`d5bba9ef…` / `054c631a…` / `4f9d2be6…`，长度 16424 / 14862 / 3437。

七条规则的命中数与规则表逐格相符：

| | reserve_gate | reserve_execution_budget | append_status_manifest |
| --- | ---: | ---: | ---: |
| C1 | 4 | 4 | 1 |
| C2 | 4 | 5 | 1 |
| C3 | 1 | 1 | 0 |
| C4 | 3 | 3 | 0 |
| C5a | 0 | 0 | 1 |
| C5b | 0 | 0 | 1 |
| C6 | 1 | 1 | 0 |

**生成出来的 `cp02-derive.sql` 已对活库实跑**（只读）：三个函数
`pre_matches` / `all_counts_ok` / `all_steps_ran` 全 true，21 个步骤的 `def_agrees` 也全 true。
长度变化各自可独立解释：`reserve_gate` 16424→16405、`reserve_execution_budget` 14862→14843，
都是 −19，恰好是 64 位摘要换成 45 字符哨兵的差；`append_status_manifest` 3437→3504，+67，
恰好是 C5a 追加 `,'<64 hex>'` 的长度。C1/C2/C3/C4 全是等长替换。
这一跑给出的 `post_prosrc_sha` **不是**要钉的值（C6 还是哨兵），文件里已经写明。

### C5a/C5b 次序：实测结果与直觉不同

按规则表**当前这组完整锚点**，两种次序**是可交换的**：两序都得到后像 `275cb628…`、
两条命中数都仍是 1。原因是 C5a 的锚点以 `)` 收尾而 C5b 那处不以 `)` 收尾，两处文本不相交。
CP-01 的 A1/A2 同理。

所以：**次序是被生成器结构性强制的，不是被摘要分歧强制的**。仍然强制，因为可交换是
**这组字面量**的性质而不是**这两条规则**的性质——C5a 只要写得松一点（8 字符前缀、
光秃秃的摘要），次序立刻决定历史成员活不活得下来，而那正是 `correction_log` 记下的
第一版缺陷。判别器 3 的说明里写了这个实测结论，没有把它说成语义必然。

## 三条 Round-11 守卫：两个值今天钉不了

规则表是一张替换表，不带守卫常量，所以常量放在生成器里（`GUARDS`），每个都带出处。
**两个必须留哨兵**，因为它们今天的实测值已经和 CP-01 钉的不一样了：

| 值 | CP-01 钉的 | 今天实测 | 为什么留哨兵 |
| --- | --- | --- | --- |
| R11-F13 未触及函数合摘要 | `c7af4676…` | `07e8fda5…` | `effective_execution_binding()` 在这 12 个里面，每次绑定前推都会替换它；21 次前推还会再动一次 |
| `effective_execution_binding()` 前像 | `c721b056…` | `633269f1…` | 同上 |

今天的值只作**参考**写在注释里，没有钉进去。钉今天的值等于保证误中止；
钉投影值正是 M3 载体那条 ordering 条款要禁的事。两者都必须**在 apply 前一刻重测**。

触发器断言是结构性的、稳定的，已经钉死：非内部触发器 1 个、
名为 `accepted_binding_immutable`、`tgenabled = O`（实测）。函数总数 15、未触及 12（实测）。

窗口：`[2026-09-13T05:45:14Z, 2026-09-14T05:45:14Z)`。上界取自 C2 的 `to`，
下界取自 C2 的 `why` 里写明的「T 是 M3 合并的 committer.date」。生成器会校验
上界 **等于** C2.to、且跨度**正好** 86400 秒——所以改了 C2 而忘了改窗口守卫会当场被截住。

## 不确定点（单列，不拍板）

1. **CP02-OF1**（上文第二节）。(ii)(iii) 算不算已授权类之内、(i) 的 `<=5` 动不动。
2. **两个 R11 哨兵由谁、在哪一刻重测**，以及要不要把「21 次前推落地之后」
   明文写进 M3 载体的 ordering 条款。生成器只负责在它们还是哨兵时拒绝出可执行文件。
3. **窗口下界 `2026-09-13T05:45:14Z` 未经独立核对**。它来自规则表 C2 的 `why` 所述
   M3 合并 committer.date；生成器只校验了它与 C2.to 的 86400 秒关系，
   **没有**去核对 `f92cd46e` 这个 commit 本身。请评审核验。
4. **零期望步要不要保留**（上文偏离 1）。
5. **守卫常量放生成器还是放规则表**。这次放生成器，是为了不和规则表的并行写者抢同一个文件；
   长期归属未定。
6. **`RULES_DIGEST` 的覆盖口径**（承重元组、散文在外、C6.to 例外）是本次定的。
   若评审要求改成全文件摘要，钉值要重算。
7. **后像摘要何时钉**：必须来自 apply 前一刻那次 `cp02-derive.sql` 只读实跑，
   手填是这整套东西存在的理由所要防的那件事。生成器里 `POSTIMAGE` 现在三个都是 `null`。

## 边界

本次只读 `select`；**没有**任何库写、没有执行任何候选 SQL、没有 `append_event`、
没有预留、没有碰 600 秒相关文字、没有开 PR、没有合并；
没有改 `scripts/phase2-qualification/`、`work/cp01/`、`bootstrap/next-window-m3/nw02/`、
`work/twentyfirst-forward/`。改动只落在 `work/cp02/`，且 `cp02-substitutions.json` 未被修改。

## RULES_DIGEST 重新派生（2026-09-13，父会话）

`2264024a…` → `75c299ca…`。**理由：CP02-OF1 的修复，即 C6 拆为 C6a/C6b/C6c。**

生成器在此之前连拒五次，每一次都拦对了，逐条记下来因为它们各自证明了一条防线是活的：

1. `expected 7 rules … found 9` —— 规则集数目钉。我拆了规则却没声明。
2. `C6a carries class FROZEN_PREFIX_WIDENED_… which is not one of cp02.permitted_edit_classes`
   —— **最重要的一次**。我给三条子规则编了描述性的新类名，等于**自称一个载体没批过的授权**。
   三条现已挂载体原文类 `FULL_ROOT_OBJECT_DIGEST_REPINNED_TO_ROOT7_POST_REGISTRATION_MEASURED_VALUES`
   （载体的 `edit_class_mapping_to_cp01_edit_ids` 把它映射为「the G8/B9 three-assertion guard」
   整组，所以三条同类成立），描述性名字降级到 `sub_role`。
3. `rule order … expected C1,C2,C3,C4,C5a,C5b,C6` —— 顺序钉。顺带把重复的 id 清单并成
   `CANONICAL_ORDER` 单一真相源（两份清单必有一份先过期）。
4. `C6 must be the last rule applied` —— 尾部断言，已推广为「三条 C6 必须是最后三条且连续」。
5. `no measured witness for rule C6a` —— 独立见证表。三项已按实测补齐。

C6 语义断言也随之推广：C6a 与 C6c 各带一个摘要（分别是加宽后的冻结前缀、root 对象摘要），
C6b 只动事件数不带摘要；并新增**「三条要么全实化、要么全留哨兵」**的断言 ——
半实化的守卫正是 CP02-OF1 量到的那种坏法。

### 一处我自己的量测错误（记下来，因为它是最容易骗过人的那种）

首次统计 C6a/C6c 锚点的出现数时得到 0。不是没有 —— 是我**用字符数差除以了手打的除数**，
两个串实际长 27 和 26，我写了 28 和 27，整数除法把真命中抹成 0。
重测时改为 `position()>0` 判定，并把除数改为 `length(<literal>)` 由字面量自身给出。
**出现次数假 0 会让一条规则悄悄匹配不到任何东西**，而"匹配 0 次"在很多写法里不报错。
