# 补遗 C：第 20 次前推的真实形状，与补遗 B 第 14 步的更正

**状态：`ADDENDUM_CORRECTS_STEP_14_NO_WRITE_PERFORMED`。**

**未写库、未注册代际、`charged_seconds` 仍为 9906/10506。**

补遗 B 的执行顺序第 14 步只写了「第 20 次绑定前推」，没有说明它的形状。
范围文件第五节说「不必手改那 107 KB，`buildForward` 从活库读回上一版 getter 增量构造」——
**那句话对，但它描述的是 candidate 的形状，不是实际执行的形状。** 本补遗更正。

---

## 一、第 19 次实际执行的不是 candidate

`root5-window9-corrected-binding/` 下有两份 SQL：

| 文件 | 字节 | 含 `CREATE OR REPLACE FUNCTION` | 回执如何记载 |
| --- | --- | --- | --- |
| `ActualNineteenthForward.sql` | 126,164 | **1 处** | `full_candidate_sql`，注明「Not the text sent to the database」 |
| `ActualNineteenthForward.executed-compact.sql` | 23,083 | **0 处** | `executed_sql` |

`ActualNineteenthForwardReceipt.json` 的 `artifacts.full_candidate_sql.note` 逐字写着：

> "Output of the unmodified buildExactGetter plus the buildForward template.
> **Not the text sent to the database; see executed_sql.**"

**实际执行的是那份 23 KB 的。**

## 二、23 KB 如何替换一个 107,827 字符的函数

不是靠内联函数体，而是靠**让数据库自己拼**：

1. 从活库读出当前 getter 的 `prosrc`
2. 在库内做与 `buildExactGetter` 完全相同的两处改动——把
   `if n not in (1..18)` 改成 `(1..19)`，并把结尾 `return next result;\nend $$;`
   替换为新分支加结尾
3. **断言重建结果的摘要等于离线算出的值**，不等即拒：

```sql
if encode(sha256(convert_to(v_new,'UTF8')),'hex') is distinct from
   'f97d85852a722697cd66b3e73ae79e40144c907a51b85fe5d7a3631aa9eda354'
then raise exception 'reconstructed_successor_getter_mismatch';end if;
execute v_new;
```

那个 `f97d8585…` 正是 `ActualNineteenthForwardPreparation.json` 的 `getter_sha256`，
也就是 **candidate 那 126 KB 文件里 getter 部分的摘要**。

**所以两份并不矛盾，是一个锚定关系**：candidate 离线算出目标字符串的摘要，
compact 在库内重建同一字符串并以该摘要为准入条件。107 KB 从头到尾没有经过网络，
也没有经过任何人的手，而重建结果必须逐字节等于离线预期。

这个设计比范围文件第五节描述的更好，应当照搬而不是另创。

## 三、对补遗 B 第 14 步的更正

第 14 步应读作：

> **14. 第 20 次绑定前推，采用 compact 形状**（照 `ActualNineteenthForward.executed-compact.sql`）：
> 单事务内读回当前 getter → 库内重建 → 断言摘要等于离线预期 → `execute` → 追加
> `EXECUTION_BINDING_FORWARD_ACCEPTED` 事件（sequence 89）→ `execution_current.sequence` CAS
> 由 88 改 89 → 全表回读比对。
>
> 离线预期摘要由 `work/twentieth-forward/exact-getter-root6-window11.candidate.mjs`
> 的 `buildExactGetter` 算出，其忠实性已由 `selftest-reproduce-nineteenth.mjs` 证明：
> 用第 19 次的记录入参重建，产出逐字节复现活库当前 `prosrc`（`c721b056…`，107,827 字符）
> 与回执记录的 SQL 摘要（`f97d8585…`）。

## 四、尚缺的一件，及其风险定级

**第 20 次的 compact 事务生成器尚未编写。**

需要说明一件事，因为它决定了这一件的做法：
第 19 次那份 compact **是手工重写的，没有生成器**。回执的 deviation
`CAPTURE_FRAGMENT_REAUTHORED` 记着，原模板 `LockedInstall.v3.template.sql`
在本仓库与环境中都不存在、无法恢复，故该片段被「written fresh」。

因此第 20 次无法「复现第 19 次的 compact 逐字节」——它本来就不是生成出来的。
可用的锚定只有两个，都必须用上：

1. **离线摘要锚**：生成器内嵌的目标摘要，必须等于 `buildExactGetter` 对第 20 次入参算出的值；
   而该函数的忠实性已由活库锚定自检证明。
2. **形状锚**：事务的守卫、CAS、回读结构逐条对照
   `ActualNineteenthForward.executed-compact.sql`，差异逐条列出并说明理由。

**风险定级：这是整条链里最危险的一件之一。** 它真正写库——替换一个
`SECURITY DEFINER` 函数、追加一条不可删除的事件、CAS 改 `execution_current.sequence`。
`events` 与 `execution_events` 都只追加不修改，写错的事件删不掉。
它应当在独立评审之后再执行，且执行前必须有一次仅含守卫、不含写入的空跑。

---

## 五、生成器已编写，并以第 19 次为锚通过回放（第四节的更新）

`work/twentieth-forward/twentieth-forward-compact.mjs` 以**实际执行过的** compact 为模板，
只替换 23 处第 19 次专属字面量，每处钉住出现次数；未列出的每一个子句与执行过的那份逐字节相同。

**回放自检**：喂入第 19 次自己的记录入参，产出必须与
`ActualNineteenthForward.executed-compact.sql` **逐字节相同**——已通过，
sha256 `23cab1118cc5c707…`，23,083 字节。回放把每处替换都变成恒等替换，
任何一处导出方式有偏差都会以字节不等暴露出来。它确实暴露了两处：

- 第 69 行那 729 字节的 `new_binding` JSON 同时是第 51 行 `request_body` 的子串，
  裸匹配在回放里计数为 2。改为带上下文锚定。
- `String.replaceAll` 以字符串作替换值时把 `$$` 解释为字面 `$`，`end $$;` 变成了 `end $;`
  ——**一个字节**，只有回放抓得到。原 `buildForward` 与 `buildExactGetter` 都用函数替换器
  `() => value` 防的正是这个，我漏了。已改。

写生成器之前先验证了三件事，都成立：compact 的 `v_norm` 摘要可由记录的
`pg_get_functiondef` 捕获推出；**归一化可往返**（第 18 次的离线 getter 摘要等于活库归一化值，
故第 20 次的 `v_norm` 摘要可预知为 `f97d8585…`）；compact 里手写的片段与
`sqlEscape(buildExactGetter 片段)` 逐字节相同（5572 → 5630 字节，差的 58 个是转义引号）。

**`--dry-run`**：整个事务是 `begin;` 与 `commit;` 之间的一个 `do` 块，把结尾的 `commit;`
换成 `rollback;` 即得到一次**完整**排练——所有守卫、库内重建、摘要准入、`execute`、
事件插入、序列 CAS、全表回读全部执行，然后一个都不留。
Postgres 的 `CREATE OR REPLACE FUNCTION` 是事务性的，该事务也不消耗任何 sequence。
这比第四节要求的「仅含守卫的空跑」更强。

## 六、第六份材料缺件：Status24 的签署主体受理

第 19 次前推的六份 `source_materials` 里，`independent_acceptance` 是
`bootstrap/root5-final-runtime-v16/Status23Acceptance.json`，
state `ACCEPTED_EXACT_STATUS23_SIGNING_SUBJECT_NOT_STORED`，钉住
`status_manifest_id sm_78056a94…`——**评估者对 Status23 签署主体的受理，在 Status23 入库之前签发**。

第 20 次前推对应地需要 **Status24 签署主体受理**。它不存在。
`bootstrap/root6-runtime-v17/` 只有资格与运行时受理两份。

它必须：由继任评估者签发；引用重签后的运行时受理；有一次 Owner 合并（前推的
`source_acceptance_refs.independent_acceptance.publication.commitSha` 要指向它）。
它不依赖 NW-01，所以**可以并入第三次 Owner 合并**（补遗 B 第 12 步，与注册体同批），
不需要第四次合并——但它**尚未编写**，且不能由实施方编写。

生成器对这份材料不做任何假设：给什么就钉什么。**缺它，第 20 次前推的入参就凑不齐。**

## 边界

未写库、未注册代际、未消耗那唯一一次分配、控制器自 `a573ca9` 起零改动。
本文件更正补遗 B 的一步，不接受任何对象、不签发任何资格、不构成授权。
第五节的生成器已编写并通过回放；第六节的材料**尚缺**。
