# 第 13–20 步执行单

**状态：`PREPARATION_ONLY_NO_WRITE_PERFORMED`。**

本会话未写库、未注册代际、未预留预算、未跑 600 秒、未签发 GA、未合并任何 PR。
对活库只发了 `select`（含 `read_execution()`、`effective_execution_binding()`、`pg_proc` 只读查询）。
本文件不接受任何对象、不签发资格、不构成授权。

准备基线：分支 `claude/nice-fermat-njqlmm` head **`4e5459b`**，`main` = `2c3a6f9`。
控制平面项目是 **`uscrdifznmlvczcekqpw`（clued-auth-test）**，**不是 `clued-prod`**——
`clued-prod` 里没有 `clued_control` schema，连错库是一个真实的误操作入口，故写在最前面。

边界复核（【实测】2026-09-12T23:5xZ，与任务书所述逐项一致）：
`charged_seconds` 9906/10506、`charged_evidence_bytes` 2201594803、`events` 5 行、
`execution_events` 88 行、`execution_current.sequence` 88、`gate_attempts` 14、`control_objects` 23、
head `ctrgen_e5df432221344996afc04b5638121d96`(root5)、root `sequence` 5、
`active_ga_id` NULL、`pending_budget_sequence` NULL、
`accepted_binding` 窗口 `2026-09-12T07:05:16Z .. 2026-09-13T07:05:16Z`、
`ctrgen_5e0440a95ac8ee257b9e4236cabd275b` 未注册。**一次性资源一个都没花掉。**

---

## 零、先说三条阻断项：按现有材料，第 13 步不应执行

任务书要求「为 13–20 步各给出可直接执行的东西」。**该给的我都给了**（第二节起，逐步逐件）。
但准备过程中有三件事必须先讲，因为它们不是「还差一份文档」，而是**第 13 步之后的路走不通**。
第 13 步烧掉代际 id 且没有回头路（`append_event:36` `generation_reuse_or_rollback`），
所以这三条的结论是：**在它们闭合之前不要跑第 13 步。**

### BLOCKER-1：冻结的控制器自己把 GA 的构造封死在 133，而它的清单收在 142

这是第二十二轮 R22-F2（`SourceRefCeilingExceededDecision.md`）那一条，**它没有被两份批准件关掉。**

【实测】冻结控制器 `scripts/phase2-qualification/control-context-verifier-root6-linux-successor/`：

| | 值 |
| --- | --- |
| `ControllerSourceManifest.candidate.json` 的 sha256 | `389fee9b…a98ec` ✓ 与冻结摘要一致 |
| `files` 条数 | **314** ✓ 与任务书一致 |
| 其中 `REPOSITORY_SOURCE` | 153 条 |
| 去重 sha256 | 141 |
| 加清单自身 blob（`source_ref.blobs` 必含） | **142** |

而**同一份冻结控制器**在三处仍然写着 133：

```
context.mjs:113   capacityDelta = {... source_refs_maximum:133 ...}
context.mjs:134   need(... s.expected_ga.source_ref.blobs.length<=133, 'CLOSED_SOURCE_REF_MAXIMUM')
source-publication.mjs:25  need(... refs.length<=133 ..., 'COMPLETE_BOUNDED_SOURCE_SET')
```

两份 Owner 批准件（`1866d6c2`／`071eb09b`，即
`Root6LinuxController160SourceRefApproval20260913.json` 与 `.v2.json`）把
`capacity_delta.source_refs_maximum` 抬到 160 —— 但**它们是文档，强制在代码里**。
按当前字节，`planSourceBatches` 在收到 142 个 ref 时抛 `COMPLETE_BOUNDED_SOURCE_SET`，
`verifySourcePublication` 走不完，**没有任何合法 GA 能为这个控制器构造出来**。

**而且这一条是循环的**，必须说清楚：把 133 改成 160 要改 `context.mjs` 与 `source-publication.mjs`
→ 改清单里这两个文件的 sha256 → **改清单字节 → 改控制器摘要 → `389fee9b` 不再是摘要**。
而 `389fee9b` 正是那份容量提案与两份 Owner 批准件所钉的 `controller_digest`
（【实测】全仓只有 5 个文件提到 `389fee9b`，全是路线 C 的这几份文书）。
**也就是说：批准件只在控制器仍写 133 时有效，而控制器写 133 时批准件没有用。**

我不替 Owner 选解法。可选的形状有三种，代价不同，但**都必须在第 13 步之前落地**：
(a) 改代码到 160 后重新冻结，容量提案与两份批准件按新摘要重出（多一次签名，回到路线 C 的起点）；
(b) 走路线 B 把清单收敛到真实加载集（56 模块／53 blob，余量足），同样改摘要、同样要重签，但不需要新提案；
(c) 论证 133 这三处不在 GA 路径上 —— 我复现过 `verifySourcePublication`，**它在，这条不成立。**

### BLOCKER-2：`389fee9b` 没有资格化件，也没有运行时受理件

【实测】`context.mjs:76`：

```js
check(qualification.state==='ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION'
   && qualification.controller_digest===binding.controller_sha256 && …,'EXACT_CONTROLLER_QUALIFICATION');
```

绑定里的 `qualification_sha256` 必须指向一份 `controller_digest` 等于绑定 `controller_sha256` 的文档。

- `bootstrap/root6-runtime-v18/` 的两份【实测】钉的都是 **`3a58eb87…`（window11 控制器）**，不是 `389fee9b`。
- 活库 `effective_execution_binding()` 现在给出的是 `qualification_sha256 = dfe6299d…`，
  对应 root5 v16，钉 `ac7bdd53…`。
- `bootstrap/root6-runtime-v19/` **在本分支不存在**。

任务书说另有会话正在签发 root6-runtime-v19 的资格化＋运行时受理。**那两份到手之前，第 14 步的
新绑定构造不出来，第 17 步的 GA 也过不了 `reserve_gate`。** 它们的摘要是第 14 步的入参，见 §4。

### BLOCKER-3：本宿主缺 `gh`，且 dockerd 未运行 —— 第 17–20 步在此容器上跑不了

【实测】`HostProvisioning.json` 钉四个二进制，本容器：

| 路径 | 钉的 sha256 | 本容器 |
| --- | --- | --- |
| `/opt/node22/bin/node` | `81925c09…` | ✓ 一致 |
| `/usr/bin/python3.11` | `f56a5885…` | ✓ 一致 |
| `/usr/bin/docker` | `18c2a16d…` | ✓ 一致 |
| `/usr/local/bin/gh` | `f687dc93…` | **缺失** |

`trusted-github.mjs` 每次 API 调用前重算 `gh` 的 sha256，**缺了就一个调用都发不出去**；
而 `verifySourcePublication` 要发若干次（commits / compare / trees / blobs）。
另【实测】`/var/run/docker.sock` 不存在、`docker ps` 连不上守护进程，**600 秒容器起不来**。

这两项是宿主配置，不是控制器缺陷（`HostProvisioning.json` 的 `attribution_rule` 正是为此写的）。
**但它们必须在第 16 步预留预算之前确认，不是之后**——理由见 §7。

---

## 一、顺序：以 `OwnerOrderingAmendment.json` 为准，不以手册散文为准

`ExecutionRunbook.md` 第五阶段/第六阶段的散文**已被改判**。现行顺序由
`bootstrap/next-window-20260912/OwnerOrderingAmendment.json` 确定（Owner 在会话中授予，
`amends` = 批准件的 `generation_registration.must_not_precede`，`from: CP_01_APPLIED_AND_READ_BACK` → `to: NONE`）：

| 本单编号 | 手册编号 | 事项 | 可回退 |
| --- | --- | --- | --- |
| **13** | 13 | `append_event` 注册 root6 | **不可** |
| **13a** | —（修正案新增第 3 项） | 从库里**实测** root6 的 root digest，解 CP-01 的 G8/B9 占位符 | 是（只读） |
| **CP-01** | 9 | 三个函数 21 处编辑，独立评审后 apply + 回读 | 是（`CREATE OR REPLACE` 可改回） |
| **14** | 14 | 第 20 次前推 | **不可** |
| **15** | 15 | Status24 追加 | 是（同一代际可重提，见 §6） |
| **16** | 16 | 预算预留（唯一一次） | **不可** |
| — | —（修正案第 6 项） | 第二次宿主复验 | 是 |
| **17** | 17 | GA 签发 | 不可（消耗 GA 额度） |
| **18** | 18 | 600 秒运行 | **不可** |
| **19** | 19 | **20 项** PQUAL 观测 | 视结果 |
| **20** | 20 | GRR | 不可 |

**CP-01 的位置：在第 13 步之后、第 14 步之前。** 这是修正案 `new_order` 第 4 项，
也和第十三轮的结论一致。它依赖两件东西，都只在第 13 步之后存在：

1. **G8／B9 的 (ii) 占位符**。`work/cp01/cp01-apply.candidate.sql` 里【实测】仍有 4 处
   `__MEASURED_ROOT6_ROOT_DIGEST_PENDING__`，`cp01-substitutions.json` 的
   `postimage_prosrc_sha256` 是 `null`、状态 `VOID_PENDING_PLACEHOLDER_RESOLUTION`。
   解法是第 13a 步，**实测而非投影**——修正案把这一整类「投影≠实际」的失效模式消掉了。
2. 因此 CP-01 的三个后像 prosrc 摘要也只在 CP-01 生成之后才知道，而那正是第 14 步的入参。

**CP-01 必须先于第 14 步，这一点不是风格问题。** 【实测】活库：

```
reserve_gate:48                if series_n>9 or series_f>15 or …
reserve_execution_budget:53    if series_n>9 or series_f>15 or …
```

而【实测】`series_f`（`sequence>44` 且 `operation='EXECUTION_BINDING_FORWARD_ACCEPTED'`）**现在正好是 15**。
第 20 次前推会把它变成 16 → `>15` 成立 → **预算预留与 GA 签发同时抛错**。
CP-01 的 G3／B3（`BINDING_FORWARD_CAP_SERIES_F_15_TO_16`）把这两处抬到 16，
**所以先 CP-01 再前推是对的；顺序颠倒会让第 14 步永久毁掉第 16、17 步。**

CP-01 的 21 处编辑（`reserve_gate` 8、`reserve_execution_budget` 9、`append_status_manifest` 4）
的 `line` 字段【实测】与活库行号逐一对上（例：G3 = 第 48 行、B3 = 第 53 行、A3 = 第 28 行、A4 = 第 29 行），
`from` 锚文本也逐字对上。**CP-01 的替换表相对活库仍然有效，不需要重导。**
A1／A2 钉的 `510f3b90…`【实测】等于本控制器 `status-manifest.root5.schema.json` 的 sha256（与 window11 同文件），
**也不需要重导。**

---

## 二、Owner 合并：必须是哪一个、什么形状

`verifySourcePublication`（`source-publication.mjs:44`）是硬约束，逐条抄它的判据：

```js
const publication = verifyOwnerMergeArtifact({commitSha:ownerMerge, artifactPath:manifestPath, raw});
const comparison = api('…/compare/'+sourceRef.commit+'...'+ownerMerge);
need(comparison.base_commit?.sha===sourceRef.commit
  && comparison.merge_base_commit?.sha===sourceRef.commit
  && ['ahead','identical'].includes(comparison.status),'SOURCE_ANCESTOR_OF_ACTUAL_OWNER_MERGE');
…
for (const source of sources) {                      // manifest.files 里 role==='REPOSITORY_SOURCE' 的 153 条
  …
  for (const current of [tree, mergeTree]) {         // 源树 与 合并树，两棵都要
    const matches = current.tree.filter(e=>e.path===source.path);
    need(matches.length===1 && matches[0].type==='blob'
      && matches[0].mode==='100644' && matches[0].sha===blob,'SAME_EXACT_CLOSED_SOURCE_IN_BOTH_TREES');
  }
}
```

而 `ownerMerge` 不是自由参数：`context.mjs:310` 传的是
`material.runtime_acceptance.publication.commitSha`，且 `context.mjs:309` 另有
`need(result.ga.target_revision === material.runtime_acceptance.publication.commitSha)`。

**所以 Owner 要合并的是「一个」提交，它必须同时满足三件事：**

1. 它**发布运行时受理件**（root6-runtime-v19 的 `Exact…ControllerRuntimeAcceptance`），
   即该文件按其 `publication.artifactPath` 出现在这个合并的树里；
2. 它的树里有 `ControllerSourceManifest.candidate.json`，字节等于 `389fee9b…`；
3. 它的树里有全部 **153** 条 `REPOSITORY_SOURCE` 路径，每条**恰好一次**、`type=blob`、
   `mode=100644`、blob sha 与源树相同；
4. `sourceRef.commit`（GA 里写的源提交）是它的 **merge base**，且 compare 状态为 `ahead` 或 `identical`
   —— 即源提交是这个合并的祖先。合并本分支即满足，`sourceRef.commit` 取被合并的分支 head。

**现在差多少：【实测】153 条里有 22 条不在 `origin/main` 上**，全部在
`scripts/phase2-qualification/control-context-verifier-root6-linux-successor/` 下
（`cli.mjs`、`context.mjs`、`source-publication.mjs`、`ControllerSourceManifest.candidate.json`、
`selftest-runtime-pins.mjs`、`check-digest-pins.mjs`、`build-linux-manifest.mjs`、
`read-source-blobs-linux.mjs`、`HostProvisioning.json`、`bridge.py`、`fixed_host.py`、
`parent600.py`、`grr.mjs`、`host-effect.mjs`、`original-inputs-blob.mjs`、`request-denials.mjs`、
`result-terminal.mjs`、`root-window-validation.mjs`、`historical-component-observations.mjs`、
`tool-entry.functions.js`、两份 `*.schema.json`）。
其余 131 条在 `main` 上且 blob 与 head `4e5459b` **完全一致**；`mode` 全为 `100644`；
153 条相对本 checkout 的**本地字节 153/153 一致**。

**给 Owner 的一句话版本**：合并那个 Linux 控制器目录连同 root6-runtime-v19 的两份文书，
一次合并，落到 `main`；不要分两次合并控制器与受理件，否则「发布受理件的那个提交」
与「含全部源字节的那个提交」不是同一个，`verifySourcePublication` 会在
`SAME_EXACT_CLOSED_SOURCE_IN_BOTH_TREES` 或 `ACTUAL_RUNTIME_PUBLICATION_TARGET` 上拒。

**注意 BLOCKER-1 与本节的相互作用**：若按 (a)/(b) 改控制器以解 133，则清单字节变、
`389fee9b` 变、153 条的内容与条数都可能变，**本节的 22 条清单要重算**。
所以正确次序是：先定 BLOCKER-1 的路线 → 重新冻结 → 再谈 Owner 合并。

---

## 三、第 13 步：注册 root6

**可回退：不可。** 消耗的是代际 id `ctrgen_5e0440a95ac8ee257b9e4236cabd275b` —— 永久。
`append_event:36` 禁止同一代际再注册，`events` 表只追加（`events_immutable` 禁 UPDATE/DELETE/TRUNCATE），
写错了库会收下、控制器会拒、这个 id 报废，且**没有第二个 id**。

### 关于任务书那一句的直说

任务书要求「核对注册体是否仍与冻结控制器摘要一致，不一致就明说」。
**明说：注册体里没有控制器摘要这个字段，所以无所谓一致或不一致。**
【实测】`Root6GenerationRegistration.candidate.json` 通篇不含任何
`controller_digest`／`controller_sha256`；它是一个 `ControlTrustRootSet`，钉的是
`schema_digest = 87f094fa…`。控制器摘要是**绑定**（`execution_binding`）的字段，
由第 14 步的前推来搬，不由注册体携带。任务书这一句是把两件东西接在了一起。

注册体确实要核的三件，我都核了，**三件全过**：

| 核什么 | 期望 | 【实测】 |
| --- | --- | --- |
| `schema_digest` | = `accepted_binding.schema_sha256` | `87f094fa…` = `87f094fa…` ✓ |
| `metadata_binding_sha256` | = `append_event:17` 现场算的 `sha256(to_jsonb(accepted_binding 行)::text)` | 两边都是 `ee5d85fa…ba5` ✓ |
| `expected_sequence` | = `current_head.sequence` | 5 = 5 ✓ |

并且 **R13-F3 已修，我独立复现**：`signature_binding.signature_evidence_ref` 指向 blob
`cad73582…`，【实测】该 blob 即
`bootstrap/next-window-20260912/OwnerApprovalVerification.json` —— 证明的是
**合并 1（`cbe898d3…`）**，与同一 `signature_binding` 里的 `owner_merge_commit` 一致。
第十三轮驳回的那个错配（指向 `ContinuationSubjectSignatureEvidence.json`／证明合并 2）已不存在。

`request` 的键集【实测】恰为 `append_event:7` 要求的 8 个
（`body, expected_sequence, generation_id, idempotency_key, kind, metadata_binding_sha256,
predecessor_generation_id, root_set_id`），`body` 是 object，
`idempotency_key = register-root6-window11-20260912` 合 `^[A-Za-z0-9_-]{1,128}$`，
序列化 4274 字节 ≪ `append_event:5` 的 65536 上限。

### 要执行的东西

```
# 生成（只写一个文件，不访问数据库）
node artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/steps13to20/build-step13-sql.mjs
# → steps13to20/step13-exec.sql 与 steps13to20/step13-readback.sql，同一次运行生成，不会互相漂移
```

**不要手抄那 4 KB JSON 进 SQL。** 这是本程序唯一一处事后无法审计的转录：
`append_event` 不校验 body，抄错一个字节库照收，代际就烧在一个控制器会拒的 body 上。
生成器带断言（键集、类型、大小、代际 id、前驱 id、root_set_id、`$step13$` 标签冲突）。

执行体（`steps13to20/step13-exec.sql`）：

```sql
select clued_control.append_event($step13${…reviewed request…}$step13$::jsonb) as append_event_result;
```

**参数化处**：无。第 13 步没有任何「尚不可知」的值；全部来自已评审的候选件。

### 前置检查（紧邻执行之前）

`steps13to20/step13-pre.sql`，只读。它把 `append_event` 里**能拒这个请求的每一道闸门**
提前跑一遍，逐条对应源码行号。期望输出：**除 `observed_at` / `window_remaining` 外每一列都是 `t`。**

【实测】2026-09-12T23:58:04Z 全部为 `t`，`window_remaining = 07:07:11`：

```
ab_row_present t | window_active t | metadata_binding_matches t | head_sequence_is_5 t
root_not_revoked t | predecessor_is_root5 t | generation_not_yet_used t | idempotency_key_free t
events_still_5 t | allocation_unspent t | execution_sequence_88 t | no_active_ga t | no_pending_budget t
```

**任何一列为 `f` 则第 13 步不得执行。** 其中两列的含义要单独讲：

- `generation_not_yet_used = f` → 代际**已经烧掉了**。不是重试问题，是已经发生了。转 §3 的回读。
- `idempotency_key_free = f` → 有一次尝试已经到了 insert。**不要再跑执行体**，直接回读。

`window_remaining` 不是布尔但要看：`append_event:16` 与 `:22` **各查一次窗口**，
`:22` 在拿到 `current_head` 行锁之后重查。留足余量，不要在 `expires_at` 前几秒动手。

### 紧随其后的回读

`steps13to20/step13-readback.sql`，只读。**执行体返回异常、返回空、或被切断时同样要跑 —— 尤其是那时。**
这是唯一能知道写有没有落地的办法。回读把已评审的 `request` 原样嵌进去做 `jsonb` 相等比较，
所以「是不是那个 body」由字节回答，不靠核对摘要。

成功的期望形状：

```
landed t | body_is_the_reviewed_one t | event_sequence 6
head_generation_now ctrgen_5e0440a95ac8ee257b9e4236cabd275b | head_sequence_now 6 | events_rows_now 6
charged_seconds 9906 | execution_sequence 88 | active_ga_id NULL | pending_budget_sequence NULL | exec_event_rows 88
```

后五列是「除 `events` 与 `current_head` 之外什么都没动」的断言。

### 中止条件（什么叫停，而不是重试）

| 回读结果 | 判定 |
| --- | --- |
| `landed f` | **没有写入，代际未烧。** 事务没开始或已回滚。重跑前置；若仍全 `t`，可用**同一份生成文件**再试一次。 |
| `landed t` 且 `body_is_the_reviewed_one t` | 成功。转第 13a 步。 |
| `landed t` 且 `body_is_the_reviewed_one f` | **停止整个程序。** 代际已烧在一个错 body 上，控制器会拒。不要试图修正：`append_event:36` 禁止重注册，`events` 不可改。记录状态并停。 |
| 前置里 `events_still_5 f` / `allocation_unspent f` / `execution_sequence_88 f` | **漂移，中止，不重试。** 有别的东西动了库，先查清是谁。 |

**`append_event` 的幂等语义**（`:23–25`）：同 key 且 `request` 完全相同 → 返回既有行，不重复插入；
同 key 但 `request` 不同 → 抛 `idempotency_conflict`。所以同一份生成文件重放本身是安全的。
**但标准作业仍是「先回读再决定」，不是「直接重放」**——因为在读之前你并不知道上次是哪种情况。

---

## 四、第 13a 步：实测 root6 的 root digest

**可回退：是**（纯只读）。

要执行的东西 —— **已存在，不需要我新写**：

```
work/cp01/measure-root6-root-digest.sql
```

它跑的就是 CP-01 的 G8／B9 守卫在运行时会求的那个表达式（用 `read_execution()`，
与守卫里 `series_view` 的来源一致，而不是 `read_root()`），并且**自带前置断言**：
不满足就返回 `safe_to_pin=false` 与 `refused_because`，而不是给一个来自错误时刻的摘要。

前置（它自己查，无须另写）：`root.events` 长度 = 6、head = root6、`root_set_id` 符合、
root `sequence` = 6、第 6 号事件是 root6 的 `GENERATION_REGISTERED`、
五条历史事件摘要仍 = `45c6a2cb…5bbc`。

【实测】最后一项现在就成立：我在注册之前算过五条历史事件的摘要，
得到 `45c6a2cbaf33bb27f6b4c136440d71d767943acfa9772867e219627759ca5bbc`，
与 G8 的 `frozen_prefix_digest` 逐字相同。**这一项不会因为注册而改变**，
所以若第 13a 步报它不成立，问题不在注册，而是有人动了历史事件。

输出用法：`pin_this_value` 那一列的值，填进 `cp01-substitutions.json` 中 G8／B9 的
`__MEASURED_ROOT6_ROOT_DIGEST_PENDING__`（4 处），然后**重新生成**
`cp01-apply.candidate.sql`（`node work/cp01/build-cp01-sql.mjs`，不要手改生成物），
再把三个后像 prosrc 摘要由 `cp01-derive.sql` 的只读运行填进 `postimage_prosrc_sha256`。

中止条件：`safe_to_pin=false` → 不要把任何值填进 CP-01。读 `refused_because`。
**不要用 `whole_root_digest` 代替 `pin_this_value`** —— 前者含 `recorded_at`，后者按 G8 的裁定
把第 6 号事件的 `recorded_at` 排除在摘要域之外，两者必然不同，混用会让 CP-01 的守卫永远为假。

---

## 五、第 14 步：第 20 次前推

**可回退：不可。** 消耗：追加一条 `execution_events`（第 89 号）、CAS 改 `execution_current.sequence`
88→89、`CREATE OR REPLACE` 替换 `effective_execution_binding()`（`SECURITY DEFINER`）。

### `control_plane` 的三个后像摘要在什么时刻、以什么方式变为已知

任务书问的是这个，答案要精确。`twentieth-forward-compact.mjs:87–101` 在非 `--replay` 下
要求 `input.control_plane` 具备五个字段。**其中只有三个是 CP-01 之后才知道的**，
另两个现在就知道 —— 任务书把五个都算作未知，这一点要修正：

| 字段 | 何时可知 | 怎么知 |
| --- | --- | --- |
| `reserve_gate_prosrc_sha256` | **CP-01 提交并回读之后** | `select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='clued_control.reserve_gate(text,text)'::regprocedure` |
| `reserve_execution_budget_prosrc_sha256` | 同上 | 同式，换 `reserve_execution_budget(text,text)` |
| `append_status_manifest_prosrc_sha256` | 同上 | 同式，换 `append_status_manifest(text,text)` |
| `accepted_binding_expires_at` | **现在已知** | NW-01 已在 2026-09-12T08:13Z 落地。【实测】活库 = `2026-09-13T07:05:16+00`，即 `2026-09-13T07:05:16Z` |
| `guard_exception_name` | **现在已知**，是实施方自选的标签 | 只受 `^[a-z0-9_]{1,80}$` 约束。它是前推事务里比对 `execution_current` 两条 CHECK 定义失败时抛的名字（第十九次用 `accepted_root5_window9_capacity_repair_required`）。CP-01 不规定它 |

「提交并回读之后」要落到实处：**这三个值必须来自 CP-01 事务 COMMIT 之后的一次独立只读查询**，
不能来自 `cp01-derive.sql` 预算出的期望值。理由是本程序的标准作业（每次写后立即只读回读），
也因为期望值与实际值相等这件事本身就是要被验证的东西，不能拿来当输入。
查询文件：`steps13to20/step14-control-plane-digests.sql`（我新写的，见该文件）。

另有一条**不在任务书里但会在第 14 步拦下来的事**，一并讲：
前推事务的守卫【实测】还比 `execution_current` 的两条 CHECK 定义，且这两个字面量**不在**
`twentieth-forward-compact.mjs` 的替换规则里，原样从第十九次的模板带过来。
我核了活库：

```
execution_current_charged_seconds_check         CHECK (charged_seconds >= 1410 AND charged_seconds <= 10506)
execution_current_charged_evidence_bytes_check  CHECK (charged_evidence_bytes >= 19264968 AND charged_evidence_bytes <= '2335812531'::bigint)
```

**与模板里的字面量逐字相同**，所以这一条现在是通的。但 CP-01 之后要**再核一次**：
若 CP-01 或别的什么动了这两条 CHECK，前推会抛 `guard_exception_name` 并回滚（fail-closed，
不会留痕），代价是流程停在第 13 步刚过之后。`steps13to20/step14-pre.sql` 里含这一项。

### 两个必须先修的脚本缺陷

**(1) `build-twentieth-input.mjs` 造不出真正的输入。** 【实测】最后一行：

```js
control_plane: rehearsal ? { …占位符… } : null,
…
assert.ok(input.control_plane, 'A REAL input needs control_plane supplied; only --rehearsal fills it');
```

非 `--rehearsal` 时 `control_plane` 恒为 `null`，紧接着的断言必然失败。
**脚本没有任何接受 CP-01 后像摘要的入口**（没有 `--control-plane <file>` 之类）。
所以「真实输入」这条路在当前字节下是断的，必须先给它加一个入口。
我没有改这个脚本 —— 它在第 14 步的不可回退区内、且带自检语义，
**改它应当走独立评审，而不是由准备会话顺手改掉。** 这一条我只报告。

**(2) 同一脚本会把资格化件与运行时受理件留在第十九次的值上。** 【实测】它
`structuredClone(prev.source_materials)` 之后**只替换 `controller_manifest` 一个键**：

```js
const materials = structuredClone(prev.source_materials);
materials.controller_manifest = { … };      // 只有这一个
```

而 `twentieth-forward-compact.mjs:163–170` 的 `newBinding` 从 `materials` 取五个摘要：

```js
const newBinding = {...p.previous_binding,
  controller_sha256: materials.controller_manifest.ref.sha256,       // → 389fee9b
  scope_sha256:      materials.scope.ref.sha256,
  qualification_sha256: materials.qualification.ref.sha256,          // → 仍是 dfe6299d（root5 v16）
  runtime_acceptance_sha256: materials.runtime_acceptance.ref.sha256, // → 仍是 bc509203
  gate_sha256: …, gate_version: …};
```

结果是一个「root6 Linux 控制器 + root5 v16 资格化」的绑定。
它会**被 `context.mjs:76` 拒**（`qualification.controller_digest` 是 `ac7bdd53`，
不等于绑定的 `389fee9b`），也过不了 `reserve_gate:126`。
**第 14 步必须同时搬 `qualification` 与 `runtime_acceptance`**，即 root6-runtime-v19 的两份
（BLOCKER-2）。这正是该脚本头部自己警告的那一类「缺一条替换规则」的错误，
只是这次在输入构造侧而不是 SQL 生成侧。**同样只报告，不代改。**

### 要执行的东西（在上述两项修好、且 v19 两份到手之后）

```
# 0) 抓活体预映像 —— 只读，repeatable read，且必须 60 秒内用掉
#    steps13to20/step14-preimage-capture.sql
#    输出存成 preimage.json，并把 previous_getter_definition_raw 一并带上

# 1) 造输入（需要先给脚本加 control_plane 入口，见上）
node work/twentieth-forward/build-twentieth-input.mjs preimage.json --out input.json

# 2) 先排练：全流程生成 + 执行 + rollback，不留痕
node work/twentieth-forward/twentieth-forward-compact.mjs input.json --dry-run --out-sql dry.sql

# 3) 确认后生成真品
node work/twentieth-forward/twentieth-forward-compact.mjs input.json --out-sql real.sql
```

**60 秒是硬约束，要写进作业流程。** 【实测】`twentieth-forward-compact.mjs:127`：

```js
const age = Date.now() - Date.parse(p.observed_at);
assert.ok(age >= 0 && age < 60000, 'FRESH_ACTUAL_PREIMAGE_REQUIRED — capture is …s old');
```

所以第 0→3 步必须在一分钟内连续做完。**排练要用一份单独的、可以过期的抓取**，
真品要用一份新抓的；不要拿排练那份去生成真品。

**参数化处**（真正尚不可知的）：`control_plane` 的三个 prosrc 摘要 —— 来源见上表，
只能来自 CP-01 提交后的只读查询。其余全部由脚本从活库与仓库现场测得。

**另外每一轮都要真生成一次，不能只 `--replay`。** 脚本头部写明了原因，我复述因为它影响作业：
第十八轮加过一条与既有规则字节相同的替换规则，`--replay` 下两者都是恒等替换所以看不见，
而真实运行会让生成器直接 `OCCURRENCE_COUNT` 失败、**第 20 次前推根本生成不出来**。
「排练能复现」不是验收证据。

### 前置检查

`steps13to20/step14-pre.sql`（只读）。期望：除 `observed_at` 外全 `t`。覆盖：
CP-01 三个后像摘要**已不等于**前像（即 CP-01 真的落了）、`series_f` 仍 15、
`execution_current.sequence` 仍 88、`charged_seconds` 仍 9906、`active_ga_id` NULL、
`pending_budget_sequence` NULL、head 已是 root6、root `sequence` 6、
`effective_execution_binding()` 的 `controller_sha256` 仍是 `ac7bdd53`（前推尚未搬）、
`effective_execution_binding()` 的 prosrc 仍是 `c721b056`（= 第十九次的产物，
生成器 `:138` 会断言归一化后的 getter 等于 `f97d8585`）、两条 CHECK 定义仍是模板里的字面量。

### 紧随其后的回读

`steps13to20/step14-readback.sql`（只读）。期望：`execution_events` 89 行、
第 89 号事件的 `idempotency_key` 等于生成时打印的那个、
`execution_current.sequence` 89、`series_f` **16**、
`effective_execution_binding().controller_sha256` = `389fee9b…`、
`qualification_sha256` = v19 资格化件的 sha256、
`charged_seconds` 仍 **9906**（前推不花预算）、`active_ga_id` 仍 NULL。

### 中止条件

- 生成器任何 `assert` 失败 → **不要改生成物去绕过它。** 每一条断言都对应一个已经发生过的真实缺陷。
- `--dry-run` 排练失败 → 停，修输入或脚本，重新排练。排练不留痕，可以反复做。
- 真实事务抛异常 → 它是单个 `do $$…$$` 块加 `begin/commit`，**抛异常即整体回滚，不留痕**。
  先跑回读确认 `execution_events` 仍 88 行、`sequence` 仍 88，再决定。**确认之后**才可重新生成重试
  （要重抓预映像，因为 60 秒早过了）。
- 事务被切断、回读显示 89 行**但** `sequence` 仍 88（或任何半截组合）→ **停止。**
  这不该发生（同一事务内），出现即说明关于原子性的假设错了，先查清再说。
- 回读显示 `charged_seconds` ≠ 9906 → **停止。** 前推不该动预算。

---

## 六、第 15 步：Status24 追加

**可回退：是**（在同一代际与窗口内可重提；`append_status_manifest` 的重复提交按既有对象处理）。

**它在 CP-01 之前是不可能的，CP-01 之后才成为可能。** 这一点要写清楚，因为
`TerminalAssessment.md` 第七节 B 曾判定「Status24 在任何路径下都已无法追加」——
那个判定在 CP-01 之前是对的，CP-01 的 A3／A4 正是解这个双重死结的：

【实测】活库 `append_status_manifest` 第 28、29 行：

```
or obj->>'control_trust_root_generation' is distinct from 'ctrgen_e5df432221344996afc04b5638121d96'
or (obj->>'expires_at')::timestamptz is distinct from '2026-09-11T10:21:05Z'::timestamptz
```

第 29 行要求 `expires_at` **恰好等于一个已经过去的时刻**，而别处又要求它晚于当前时刻 —— 无解。
CP-01 的 A3 把代际改为 root6、**A4 把该字面量改为 `2026-09-13T07:05:16Z`**，死结解开。
另外 A1／A2 把 status manifest 的 `schema_digest` 允许集扩到 `510f3b90…`
（A1 加进三元允许集、A2 把新对象的严格相等移到它），**A2 必须在 A1 之后执行**
（A2 的锚文本里还含 root5 的摘要）。

要执行的东西：`select clued_control.append_status_manifest(<raw>, <sha>)`。
**`<raw>` 尚不存在于本分支**：Status24 的签署主体（交付件 F）有五项待定钉要填齐并逐项复核，
且它必须钉 CP-01 之后的 `schema_digest` 与新窗口。**这一件我无法在不发明值的前提下备好，
因此按任务书的规定只用一行说明并跳过**：Status24 的 manifest 原文不存在，缺 v19 摘要与五项待定钉。

前置与回读的形状写在 `steps13to20/step15-pre.sql` 与 `step15-readback.sql` 里，
它们不依赖 manifest 内容（查的是 CP-01 已落、代际已是 root6、窗口仍有效、
`control_objects` 计数与追加前后的差恰为 1）。

中止条件：抛 `series_*` 或代际／窗口类异常 → 说明 CP-01 的 A3／A4 没有真正生效，
**回到 CP-01 的回读**，不要重试追加。

---

## 七、第 16 步：预算预留 —— 唯一一次，零余量

**可回退：不可。** 消耗的是那唯一一次 600 秒分配。
【实测】`reserve_execution_budget:138`：`c.charged_seconds+600>10506` → 9906+600 = 10506，
**不大于**，恰好通过。上界等于用完后的值，**没有第二次**。

【实测】真实截止：`reserve_execution_budget:117`

```
or clock_timestamp()+interval '600 seconds'>='2026-09-12T13:14:51Z'::timestamptz
```

该字面量由 CP-01 的 B2／B7／B8 改为本窗口，故 CP-01 之后真实截止为
**`2026-09-13T07:05:16Z` 减 600 秒 = `2026-09-13T06:55:16Z`**。
另【实测】`:125` 要求新预算的 `expires_at` **恰好等于**同一个窗口字面量
（`series_exact_new_budget_expiry_required`），`:135` 另要求它不晚于 `accepted_binding.expires_at`。
**两条合起来：新预算的 `expires_at` 必须恰为 `2026-09-13T07:05:16Z`，一秒不差。**

### 「17 到 20 已知可执行」在这里能是什么意思

任务书问得对：600 秒那一段**不能排练**，所以「已知可执行」不可能是「已经跑过一遍」。
它只能是下面这组**可在预留之前逐项判定**的条件。我把能测的都测了：

| # | 条件 | 可否在预留前判定 | 现状 |
| --- | --- | --- | --- |
| 1 | 宿主四个二进制字节齐备 | **能**，`sha256sum` | **不齐：`/usr/local/bin/gh` 缺失**（BLOCKER-3） |
| 2 | dockerd 可用、能创建容器 | **能**，起一个无关的小容器再删 | **不可用**：`/var/run/docker.sock` 不存在 |
| 3 | 331/253 项宿主 manifest 复验通过 | **能**，`verify-manifest-against-host.mjs` | 未在本容器跑（gh 缺失会让 `check-digest-pins` 先拒，见 `HostProvisioning.json` 的 `attribution_rule`） |
| 4 | `verifySourcePublication` 能跑通 | **能，而且必须在预留前跑通** | 现在不能：BLOCKER-1（133 vs 142）+ 22 条不在 `main` |
| 5 | GA 能构造出来并通过 `reserve_gate` 的形状检查 | **部分能**：GA 的构造是离线的，可先离线构造并核对 `context.mjs:70/76` 的字段相等 | 不能：BLOCKER-2，v19 两份不存在 |
| 6 | 第 19 步的 20 项观测有正式命令 | **能** | 未定，见 §10 |
| 7 | 600 秒本身跑得通 | **不能** | —— |

**所以「已知可执行」的诚实定义是：1–6 全部为真，且 7 无法预先证明。**
第 7 项不可排练这件事不能靠「小心一点」补偿；它意味着**预留是在一个残余风险上做的决定**，
而 1–6 正是把残余风险压到只剩第 7 项的全部手段。任何一项没做而去预留，
就是把本可事先排除的失效模式也押在这一次分配上。

**一句话作业规则**：1–6 逐项留下可核的输出（不是口头确认），再预留。
其中第 2 项和第 4 项最容易被跳过，因为它们「看起来属于后面的步骤」——
它们恰恰是不能留到后面的两项。

要执行的东西：`select clued_control.reserve_execution_budget(<raw>, <sha>)`。
`<raw>` 由控制器在 `NEXT_ALLOCATION` 通路上产出，**不是手写的 JSON**；
其 `expires_at` 必须恰为 `2026-09-13T07:05:16Z`（见上）。

前置：`steps13to20/step16-pre.sql`。**这是全套里最不能省的一份**，因为错误的代价是
那一次分配。期望全 `t`，含：`charged_seconds` = 9906 且 +600 不超 10506、
`clock_timestamp() + 600s < 2026-09-13T07:05:16Z` 且**留有余量**、
`pending_budget_sequence` NULL、`active_ga_id` NULL、`series_f` ≤ 16、
CP-01 后像三个摘要与 CP-01 回读时记录的值逐字相同（即 CP-01 之后没人再动过这三个函数）、
head 是 root6。

回读：`steps13to20/step16-readback.sql`。期望 `pending_budget_sequence` 非 NULL、
`charged_seconds` 的变化与预留语义一致、并把预留出来的 `expires_at` 读回来核对**恰为**
`2026-09-13T07:05:16Z`。

中止条件：**任何异常都不要重试。** 抛异常意味着某个 `series_*` 守卫不满足，
重试只会再抛一次；而如果它其实部分生效了，重试会把 `charged_seconds` 推过上界。
先回读，读清 `pending_budget_sequence` 与 `charged_seconds`，再判断。
`charged_seconds` 已经不是 9906 且没有对应的成功预留 → **停止程序**，那一次分配已经损失。

---

## 八、第 17 步：GA 签发

**可回退：不可**（消耗一次 GA 额度；`reserve_gate:48` 的 `series_n>9`）。

要执行的东西：`select clued_control.reserve_gate(<ga_raw>, <sha>)`，
`<ga_raw>` 由控制器产出，**其 `target_revision` 必须等于运行时受理件的发布提交**：
【实测】`context.mjs:309` `need(result.ga.target_revision === material.runtime_acceptance.publication.commitSha)`,
而同一个 commit 又被 `context.mjs:310` 作为 `ownerMerge` 交给 `verifySourcePublication`。
**即 §2 里那个「一个提交」。**

`reserve_gate` 会另外查（【实测】`:126`）：
`g->>'controller_digest'` = `b.controller_sha256` 且 `g->>'scope_digest'` = `b.scope_sha256`，
其中 `b` 是 `effective_execution_binding()` 的产出 —— 也就是第 14 步搬过之后的绑定。
`:138`：`(g->>'expires_at') - start_time` 不超 600 秒。

**参数化处**：GA id —— 由 `reserve_gate` 在成功时产生并写入 `execution_current.active_ga_id`，
**在此之前不存在，也无法预知**。第 19 步与第 20 步都要用它，取法见 §10。

前置 `steps13to20/step17-pre.sql`：`pending_budget_sequence` 非 NULL（第 16 步已预留）、
`active_ga_id` NULL、`series_f` ≤ 16、`series_n` ≤ 9、绑定的 `controller_sha256` = `389fee9b…`、
`qualification_sha256` = v19 资格化件、窗口仍有效且距 `expires_at` 还有 600 秒以上余量。

回读 `steps13to20/step17-readback.sql`：`active_ga_id` 非 NULL（**把它记下来**）、
`gate_attempts` 增 1、GA 的 `deadline - issued_at` ≤ 600 秒、`charged_seconds` 未变。

中止条件：抛异常 → 回读确认 `active_ga_id` 仍 NULL、`gate_attempts` 未增，
再判断是否重试。`gate_attempts` 增了而 `active_ga_id` 仍 NULL → 一次失败尝试已记账，
**不要立刻重试**，先查 `gate_attempts` 最后一行的拒因。

---

## 九、第 18 步：600 秒运行

**可回退：不可。** 消耗那一次分配的 600 秒。

要执行的东西：经固定可信入口启动控制器，**不能直接 `node cli.mjs`**。
【实测】`tool-entry.functions.js:67–85` 的 Linux 入口依次做：
校验 `/usr/bin/python3.11` 的 sha256 = `f56a5885…` →
用 `python3.11 -I -S -B` 逐文件校验清单 →
校验 `/opt/node22/bin/node` 的 sha256 = `81925c09…` →
`NODE_OPTIONS= NODE_PATH= exec /opt/node22/bin/node …/cli.mjs`。

`cli.mjs` 从 stdin 读两行 JSON（各 ≤ 4 MiB）：第一行是 material，
返回 `NEED_COMMITTED_DISPATCH` 与一个 `challenge`；第二行必须带回同一个 `challenge`。
自带 600000 毫秒看门狗，超时输出 `VERIFIER_PROCESS_DEADLINE` 且
`state` 为 `UNKNOWN`（若 dispatch 可能已存在）或 `BLOCKED`。

**`state: 'UNKNOWN'` 是本步最重要的输出形态**：它意味着「效果可能已经发生，也可能没有」。
遇到它**不要重试**，转第 19/20 步的只读观测去判定实际状态。

前置 `steps13to20/step18-pre.sql` + 宿主侧检查（**不是 SQL 能查的**）：
四个二进制字节齐备（含 `gh`）、dockerd 可用、`active_ga_id` 非 NULL 且与第 17 步记下的一致、
距 GA `deadline` 还有 600 秒以上。

回读 `steps13to20/step18-readback.sql`：只读，读 `execution_current`、
`gate_attempts` 最后一行、`charged_seconds` 的变化。

中止条件：`BLOCKED` 且 `capacity_released:false` → 分配未释放，读清状态再说。
`UNKNOWN` → 如上，只读判定，**绝不重试**。

---

## 十、第 19 步：20 项 PQUAL 观测

**是 20 项，不是 19。** 【实测】`artifacts/…/cases/QualificationCases.json`：
`source_specification_count: 20`，`cases` 数组 20 个，id 为 `PQUAL-01` … `PQUAL-20`，
源自 `work/slice-a-contracts/QualificationRegressionSpecifications.json`（`source_commit f3d00661`）。
`ExecutionRunbook.md` 与 `OwnerOrderingAmendment.json` 两处写「19 项」，**两处都错**，
`HostLossTerminalRecord.md` 写的 20 是对的。本单按 20 计。

### `formal_command` 待确认那一条，解成什么

【实测】现值：

```json
"formal_command": "待确认：实际受权 controller 尚未存在；禁止把本地候选 CLI 换 mode 当正式执行。"
"local_command": "python artifacts/…/cases/verify_candidate.py --controller scripts/phase2-qualification/controller.py --out-dir <…>"
```

它待确认的**不是措辞，是两个前提**：(i) 受权控制器存在（= BLOCKER-2 闭合，v19 两份签发），
(ii) 有已签发的 GA（= 第 17 步完成）。两者都到位之后，正式命令的形状是确定的，因为
`local_command` 那条路被明文禁止（「禁止把本地候选 CLI 换 mode 当正式执行」）：

**正式命令不是一条新命令，而是第 18 步那同一个可信入口的 20 次 `CURRENT_DISPATCH`**，
每次 material 的差别只在 case 的 `inputs`（`fault_variants` 与 `phase_profile_purpose`），
且每次都携带同一个 `<GA_ID>`。也就是：

```
# 对 PQUAL-01 … PQUAL-20，逐个：
printf '%s\n%s\n' "$MATERIAL_JSON" "$FRESH_JSON" | <tool-entry 固定入口>
#   MATERIAL_JSON.operation      = 'CURRENT_DISPATCH'
#   MATERIAL_JSON.ga_raw         = 第 17 步签出的 GA 原文（含 <GA_ID>）
#   MATERIAL_JSON.observation    = 每次新抓的活库观测
#   其余 material 键（runtime_acceptance / controller_qualification / gate_definition /
#   profile_signing_payload）为 v19 的那几份，20 次相同
```

**`<GA_ID>` 的唯一来源**：第 17 步 `reserve_gate` 成功后写入
`clued_control.execution_current.active_ga_id`。取法：`steps13to20/step19-ga-id.sql`（只读）。
**不要从任何文档里抄 GA id**，它在第 17 步之前不存在。

**我不把上面这段写成一份可直接 `bash` 的脚本，原因要说明**：material 的完整键集依赖
v19 两份文书的实际内容（`publication.commitSha`、各自 sha256），那些值现在不存在。
写一个填着占位符的脚本，和写一个填着猜测值的脚本，在 3 点钟的区别不够大。
`steps13to20/step19-material-shape.md` 里给了逐键的来源表，到手即可填。

前置 `steps13to20/step19-pre.sql`：`active_ga_id` 非 NULL 且等于第 17 步记下的值、
距 GA `deadline` 仍有余量。
回读：每一项观测之后跑 `steps13to20/step19-readback.sql`（`gate_attempts` 增量、
`execution_events` 未意外增长、`charged_seconds` 变化符合预期）。

中止条件：【实测】`reserve_gate:90`／`reserve_execution_budget:95`
`if series_a->>'phase'='PASS' then raise exception 'series_first_pass_stops'`
—— **第一个 PASS 就会让后续通路停下**。这不是故障，是设计；作业上要预期它，
不要把它当成需要重试的错误。

---

## 十一、第 20 步：GRR

**可回退：不可。**

要执行的东西：同一个可信入口，`material.operation = 'GRR'`，
并提供 `material.grr_raw`。【实测】`context.mjs:297` 走 `parseExact(material.grr_raw)`，
`result-terminal.mjs:11` 与 `grr.mjs` 做结果语义检查；
若 `terminal.result` 属于 `FAIL/BLOCKED/STALE`，`seriesOperation` 转为 `RESULT_RECONCILIATION`
而不是 `CURRENT_DISPATCH`。落库经 `clued_control.commit_gate_result(<raw>,<sha>,<decision_sha>)`。

**参数化处**：`<GA_ID>`（同 §10）、20 项观测的实际结果、以及 GRR 自身的原文。

**GRR 必须写进去的内容**，这一条不是可选项，`ExecutionRunbook.md` 第七节与第九轮的追加都要求：

1. 本次资格运行的强制层（`clued_control` 的 `SECURITY DEFINER` 函数、`accepted_binding` 的约束与
   不可变触发器）在运行前由**被资格审查的一方**修改；此前另有一次同类修改（2026-09-11）
   无 PR、无独立评审、未经迁移表记录。措辞见 `SuccessorReviewerRound8.md` 第五节
   —— **该文件不在本分支**，在 `claude/trusting-keller-mm2s0v`（连同其 AddendumA），执行前应取到手边。
2. 「Owner 已批准」这一事实的验证，是对 GitHub API `verification.verified` 与 `reason:'valid'` 的转述；
   `capture-owner-merge.mjs` 与 `trusted-github.mjs` 都只检查 `signature`／`payload` **存在**，
   未验证 payload 与 commit 的对应关系，也未验证签名本身。
3. 控制器摘要即其 manifest 摘要。**本次要按 Linux 控制器重述这一句**：314 条里
   【实测】161 条是 `RUNTIME_DEPENDENCY`、路径是本容器的绝对路径
   （如 `/home/user/cross-memory-system/apps/clued-cloud/node_modules/ajv/lib/ajv.js`）。
   原措辞讲的是「那台 Windows 机器上的 200 MB」，现在要讲的是
   **「某个一次性容器里的那 161 个文件」**，而这个容器按其性质会被回收。
   若这些字节未在运行前后复验，GRR 对控制器身份的断言只在一个未经验证的假设下成立。
4. 宿主丢失与 Linux 移植这一整段经过（`HostLossTerminalRecord.md`、
   `LostInputsRecoveryAnalysis.md`），以及由此产生的「新链而非续走」这一性质。
5. 本单 §0 的三条阻断项在 GRR 出具时的实际状态 —— 逐条写清是闭合了还是被绕过了。

前置／回读：`steps13to20/step20-pre.sql` 与 `step20-readback.sql`。
中止条件：`commit_gate_result` 抛异常 → 回读 `gate_attempts` 与 `control_objects`，
确认是否已落；**不要重复提交** —— GRR 的重复提交语义没有被独立验证过，本单不假设它幂等。

---

## 十一之二、本单自身的验证记录

任务书要求「没有任何需要临场即兴的东西」。为此本单的每一份 SQL 都做过下面这些，
【实测】结果如下：

| 验证 | 结果 |
| --- | --- |
| 每一份 `.sql` 在活库上通过解析与规划（`prepare` / `deallocate`，或直接只读执行） | **全部通过**，无语法或列名错误 |
| `step13-pre.sql` 的 13 列 | 2026-09-12T23:58:04Z **全为 `t`**，`window_remaining` 07:07:11 |
| `step13-readback.sql` 只读实跑 | `landed=false`（注册尚未发生，符合预期），并证明那段 4 KB dollar-quoted jsonb 字面量能正确解析与转型 |
| 注册体 `request` 的键集 vs `append_event:7` 要求的 8 键 | 逐一相同 |
| 注册体 `metadata_binding_sha256` vs `append_event:17` 现场算的值 | 两边都是 `ee5d85fa…ba5` |
| `cp01-pre.sql` 的三处锚点行号 vs `cp01-substitutions.json` | G3 第 48 行、B3 第 53 行、A4 第 29 行，逐一对上 |
| CP-01 的 `2026-09-12T13:14:51Z` 字面量在两个 reserve 函数中的出现次数 | **5 次**，与替换表的 G2／G7／B2／B7／B8 恰好对应 |
| A1／A2 钉的 `510f3b90…` vs 本控制器 `status-manifest.root5.schema.json` | 相同 |
| G8 的 `frozen_prefix_digest` vs 活库五条历史事件摘要 | 都是 `45c6a2cb…5bbc` |
| `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` 的输出 vs 生成器对 `accepted_binding_expires_at` 的正则 | 得 `2026-09-13T07:05:16Z`，合 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$` |
| 注册体 JSON 里是否含 `$`、反斜杠、单引号 | 三者皆无，故 dollar-quoting 安全；生成器的断言已扩到两个标签 |

两处为消除凌晨的失败模式而收紧的地方，一并记下：

1. `step16-readback.sql` 原先按 `request->'body'->>'expires_at'` 读预留出来的窗口。
   【实测】上一条 `BUDGET_RESERVED` 事件（第 85 号）的 body 形状是 `{raw:"<JSON 字符串>", sha256:…}`，
   所以改为 `(request->'body'->>'raw')::jsonb->>'expires_at'`。按原写法会恒为 NULL，
   而那一列正是用来确认「预留出来的 `expires_at` 恰为 `2026-09-13T07:05:16Z`」的。
2. 第 19／20 步里按 `ga_id` 取 `gate_attempts` 的标量子查询，若某个 `ga_id` 有两行会直接报错。
   已一律加 `order by sequence desc limit 1`。**前置文件在该报警时应当给出答案，而不是抛异常。**

---

## 十二、按任务书列项的对照表

| 要求 | 交付 |
| --- | --- |
| 13–20 各步的确切命令／SQL，作为仓库里的文件 | `steps13to20/`；第 13 步由 `build-step13-sql.mjs` 生成，第 13a 步复用既有 `work/cp01/measure-root6-root-digest.sql` |
| 每步紧邻之前的只读前置及其期望输出 | `steps13to20/step*-pre.sql`，期望写在文件头与本单各节；第 13 步的 13 列**已在活库实测全为 `t`** |
| 每次写后紧邻的只读回读及其期望形状 | `steps13to20/step*-readback.sql`；第 13 步的回读与执行体由同一次生成，嵌入已评审 `request` 做 `jsonb` 相等比较 |
| 中止条件（何时停而非重试） | 各节末「中止条件」；被切断的写一律先回读，不盲重试 |
| 可回退性一词及不可回退时消耗什么 | §一的表格与各节开头 |
| 第 13 步：注册体与冻结摘要是否一致 | **注册体不含控制器摘要**，见 §3 起首；应核的三项已核，三项全过；R13-F3 已修并独立复现 |
| 第 14 步：POST-CP-01 摘要何时、如何变为已知 | §5 的表；**五个字段里只有三个是后像未知**，另两个现已可知 |
| CP-01 现在的位置与依赖 | §1；在 13 之后、14 之前；依赖 13a 的实测值；其替换表相对活库仍有效（行号与锚文本逐一对上） |
| 第 16 步：「17–20 已知可执行」能是什么意思 | §7 的七项表；诚实定义是「1–6 为真，7 无法预证」 |
| 第 19 步：20 项与其正式命令 | §10；20 项已实测确认；正式命令解为第 18 步同一入口的 20 次 `CURRENT_DISPATCH` 带同一 GA |
| Owner 要合并什么、什么形状 | §2；**一个**提交同时承载受理件与全部 153 条源；现差 22 条 |
| 因依赖不存在而无法备好的 | Status24 的 manifest 原文（§6 一行说明）；第 19 步 material 的完整键集（§10 给了来源表） |

---

## 边界

未写库、未注册代际、未预留预算、未跑 600 秒、未签发 GA、未追加 Status24、未合并任何 PR、
未执行任何 `do $$ … $$` 块。对活库只发 `select`。未修改控制器任何字节
（`389fee9b` 在本会话前后一致）。未修改 `work/twentieth-forward/` 与 `work/cp01/` 下任何文件
—— §5 指出的两处脚本缺陷只报告、不代改，理由写在该节。
本文件不签发受理、不构成授权，也不解除任何一项前置条件。最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。
