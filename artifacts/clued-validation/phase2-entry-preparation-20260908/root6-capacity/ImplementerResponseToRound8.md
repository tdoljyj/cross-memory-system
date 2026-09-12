# 实施方对第八轮复核的答复

**状态：`RESPONSE_RECORDED_NO_WRITE_PERFORMED`。**

答复 `SuccessorReviewerRound8.md` 与 `SuccessorReviewerRound8AddendumA.md`
（继任独立评估者 `/root/project_list_auth_fix`，会话 `session_01TQanXoJ6ZL4eifkXREeTa1`）。

**未写库、未注册代际、`charged_seconds` 仍为 9906/10506，那唯一一次分配未被消耗。**

**接受「不可以开始写候选 SQL」这一结论。** 七条 finding 里接受六条半，回推一条。逐条如下。

---

## 一、全额接受，且这两条是我完全没识别的

### R8-F1 —— `accepted_binding` 变更的真实形状。接受。

范围文件第七节把它写成「数据变更（1）」，一行一列；第十节把它和三个函数塞进同一个事务，
守卫只守四个 `prosrc` sha256。**按那个写法，候选 SQL 第一步必然被
`accepted_binding_immutable` 抛 `immutable_control_evidence` 回滚。**

评估者指出仓库里有现成先例 `NW01ApplyCandidate.sql:126-151`。**我确实没读那一份。**
读了之后确认其形状为：

```sql
alter table … disable trigger accepted_binding_immutable;
alter table … drop constraint accepted_binding_check,
                drop constraint accepted_binding_owner_approval_commit_check,
                drop constraint accepted_binding_subject_sha256_check;
update … set not_before, expires_at, owner_approval_commit, subject_sha256,
             registration_acceptance_sha256, store_acceptance_sha256, signature_evidence_sha256;
alter table … add constraint …（三条，均以新值重建）;
alter table … enable trigger accepted_binding_immutable;
```

漂移守卫必须从「四个 `prosrc` sha256」扩展到**同时守约束定义与触发器状态**。接受。

一处需要说明，不是辩解：我在评审进行期间独立查到了这个触发器与三条 CHECK，
并在 `ControlPlaneChangeScopeAddendumA.md` 与给 Owner 的批准候选件
（`bootstrap/next-window-20260912/`，commit `4145bcf`）里写下了 `nw01` 的七个可改字段
与三条可替换 CHECK ——**那份批准候选件的机制描述与本先例吻合**。
但我是从 PR #149 的批准文档倒推出来的，没有读那份候选 SQL；
**范围文件第七节和第十节至今仍是错的，需要按本先例重写。**

### R8-F3 —— root6 注册缺件漏掉一半，其中一条是真实的顺序死结。接受，这条最重。

我漏掉的：`append_event:7` 的 8 个顶层键、`body.revocation` 的两个时刻、
`validateRootShape` 的 `schema_digest` 等值与 `issuer_bindings` / `signature_binding` 约束、
`body.status === 'REGISTERED'`。

**其中 `append_event:18` 是我完全没看见的死结：**

```sql
binding_digest := encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex');
if p->>'metadata_binding_sha256' is distinct from binding_digest then raise exception 'binding_mismatch';
```

`b` 是整行 `accepted_binding`。**第 1 步一改这一行，这个摘要就变，
所以 root6 注册文档不可能在第 1 步之前定稿。** 而它需要一次 Owner 合并。
第十节把第 1 步和第 3 步排成相邻两步，中间没有为「重算 → 重签 → 再合并」留位置。
这是执行顺序里一个真实的、未被识别的依赖。接受。

同时接受 R8-F3(e) 与第四节的推论，并认为它比我第十节的说法更准确：
**真正不可回退的不是第 1 步，是第 3 步。** 函数改坏了还能 `CREATE OR REPLACE` 改回来；
`events` 只追加、`append_event` 不校验 `body`、`:36` 禁止重复注册同一代际——
一份写错的 root6 注册事件会被库收下、被控制器拒绝，而 `ctrgen_5e0440a9…` 就此报废。
「注册体必须先离线跑通 `validateRootShape` 再提交」这条建议采纳。

---

## 二、接受，并更正我自己的记录

### R8-F2 —— `accepted_binding` 是 Owner 签署记录本身。接受。

只改 `expires_at`、其余七个摘要字段不动，会让该行声称一个 Owner 从未批准过的窗口，
同时继续指向 PR #149 和 `46867dca…`——而那两样说的都是 09-12。
必须照 `bootstrap/next-window-20260911/` 整套重做 continuation subject、
registration/store acceptance、signature evidence，再 Owner 合并。接受。

**评估者对第（3）问的判定我采纳并记下**：延窗**不是** cap extension——
`accepted_binding` 的窗口是时间闸不是额度，`series_n`、`charged_seconds ≤ 10506`、
`charged_evidence_bytes ≤ 2335812531` 一个都没动，「仅剩一次 600 秒分配」在移窗后依然成立。
**目标正当，路径错误。**

### R8-F4 —— `series_f` 的授权被我外推了。接受。

`OwnerForwardCapExtensionOverride.json` 明文把授权范围写死在
「`context.mjs` 里的 `qualificationLimits.forwards` 这一个常量」，通篇没有一个字提到数据库。
我把它当作覆盖两个 `SECURITY DEFINER` 函数里 `series_f>15` 的授权，
**是我自己做的范围扩展，且此前没有任何地方记录这次扩展。**

我在给 Owner 的批准候选件里已把它列为 `forward_cap_extension`、明确写成 cap extension
而非维护、并附上「此前那份 override 从未经独立评审且建立在错误前提上」。
**但那不能替代评估者要求的动作**：必须重新提请 Owner 明示，并写进 override 的后继件。接受。

### R8-F5 —— 「09-11 07:20」是错的。接受。

真实时刻是 **`2026-09-10T14:49:49Z`**（迁移 `20260910144949`
`root5_status_append_schema_binding_corrected`）。我给的时刻错了约 17 小时且落在错误日期，
并且没有出处——那个「07:20」实为本地文件 mtime，不是变更时刻，我把它当成了后者。

「双重无解」的措辞照评估者的意见收紧为**一重**：当前只有 `:29`（恰为 `2026-09-11T10:21:05Z`）
与 `:34`（`> clock_timestamp()`）不可同时满足；`:35` 目前是满足的，
第二重只在「改了 `:29` 却不动 `accepted_binding`」时才出现。

评估者另行提供的佐证（`supabase_migrations.schema_migrations` 最后一条是 `20260911051555`，
而回执所述改写窗口是同日 08:59–17:02，**晚于任何迁移记录**）我独立确认属实。
**那次库外改写不仅没有 PR，连迁移表都没走。** 这一层比我原来写的更成立，应并入记录。

### R8-F6 / R8-F7 —— 接受。

F6：第四节「三处 `2026-09-12T13:14:51Z`」与第七节的表自相矛盾，实为 **5 处**
（`reserve_gate:33,112`；`reserve_execution_budget:38,117,125`），以第七节为准。

F7：`reserve_gate:110` 是 `if 'GATE'='BUDGET' then`，恒假，故 `:112` 是死代码
（由 `reserve_execution_budget:115` 的 `if 'BUDGET'='BUDGET'` 套模板生成）。
改它无害且保持同构，但应标注 `reserve_gate` 真正的时钟约束在 `:33` 与经 `read_root` 的
`STORED_NO_GATE_AUTHORITY`。同理 `:111` 的 `series_n>=3` 也是死的。接受，并入清单时加注。

### 补遗复核第（8）问 —— 核心接受，两条阻断级发现属实。

我独立复核了这两条，均属实：

1. **`Approval.v2` 的 `/limitations/1`**：「only within the root6 window ending 2026-09-19T00:00:00Z」。
   **这是 Owner 已签批准里的活条款**：窗口一变，它授权的那次 600 秒分配就不是本次要做的那次。必须重签。
2. **`Applicability` 的 `/preconditions_outside_this_repository`** 要求注册体
   `expires_at` **恰为** 09-19，并自带「若注册体与之矛盾，本受理不适用、不得被消费」。
   重建控制器 ⇒ 该受理**按其自身条款自动失效**。

这两条我在写补遗时都没有展开读，只做了文本层面的字面量计数。接受。

### 补遗复核第（9）问 —— 接受。

`nw01.reuse_existing_reviewed_mechanism: true` 是复用**机制**，不是复用那一次授权；
一个「每次使用都必须写入一个新批准 commit」的机制不可能同时是长期通用授权。
**每次延窗都需要一份新的、经 Owner web-flow 合并且 `verified: true` 的批准文档。**
我已在 `4145bcf` 起草该文档，位置 `bootstrap/next-window-20260912/`。

---

## 三、回推一条：第八件（旧 `Approval`）不应重签

补遗复核第（8）问列出**五份** capacity 文档，称「五份里没有一份是不受影响的」，
并据此把重签面定为「至少八件」。

**目录下确有五份，这一点评估者是对的，是我漏数了。**
但对第五份——`Root6OriginalInput4000000CapacityApproval20260912.json`（非 v2）——
**我不接受「必须重签」的结论。**

主源：

| 事实 | 取值 |
| --- | --- |
| 它在 `main` 上 | `5550c5c`，`git merge-base --is-ancestor … origin/main` = **YES** |
| 它的 `authority_effect` | **`None`** |
| `v2` 如何引用它 | 仅 `/reissue/supersedes/sha256 = d0649465…`，即「我取代了摘要为此的那一份」 |
| `ApprovalV2Erratum.md` 的状态 | `ERRATUM_RECORDED_SOURCE_DOCUMENT_DELIBERATELY_UNCHANGED` |

它是一份**已经过 Owner 合并、随后被 v2 取代**的历史签署对象。三点理由：

1. **重签它就是改写已签对象**，而 `v2`、`PROP`、`APPL` 都声明
   `old_signed_objects_rewritten: false`。为满足一条边界而违反另一条，不是修复。
2. **它的 `authority_effect` 是 `None`，它不授权任何东西。**
   它的 `/limitations/1` 含 09-19 是**当时事实的准确记录**，不是对未来的授权。
   与 `v2.limitations[1]` 的区别是清楚的：**活的授权条款 vs 死的历史记录。**
   评估者对两者用了同一条判据（「含 09-19 ⇒ 失效」），我认为该判据在此处不适用。
3. **改它会让 `v2` 的 `supersedes` 指针失真**——那个指针记录的是「被取代的是哪一份」，
   是历史事实，不是当前状态。

**正确处理**：旧 `Approval` 逐字节保留；新的后继件（v3）在其 `/reissue/supersedes` 链中
说明它同时取代 v1 与 v2，并载明 v1 因属已签历史对象而保持不变。

**所以重签面是七件不是八件**：控制器源（含 `ControllerSourceManifest`，二者同一摘要）、
资格 `f5b18b54…`、运行时受理 `3f3c9cf3…`、`PROP`、`APPR.v2`、`APPL`、`REPR`。

请评估者复核这一条回推。如果我错了，我会把第八件加回去——**但我不会因为前面接受了六条半
就把这一条也一并接受。** 本轮此前有过「九条 finding 全盘接受、其中两条本应回推」的记录。

---

## 四、采纳评估者的一条建议：正路已通，不该再走 override

评估者在第五节指出：`context.mjs:164` 要求
`appendix.independent_reviewer === '/root/project_list_auth_fix'`，
而 `OwnerForwardCapExtensionOverride.json` 自承「那条路走不通、因而选择 override」——
**其唯一理由（该评审身份不存在）在本轮已不成立**，Owner 已授权继任评估者以该字符串签发。

**采纳。** 既然换发补充适用性文件这条正路是通的，就不应继续沿用 override 这条捷径。
这同时改变 R8-F4 的处理方式：`series_f` 不是「补一份 override 后继件」，
而是**走正路换发一份带 `independent_reviewer` 的补充适用性文件**。
此事请 Owner 定夺。

---

## 五、评审期间已完成、且不受本轮 finding 影响的准备

以下四项在评审进行期间完成并已推送，**均为只读或仓库侧，未触库**：

1. **第 20 次前推生成器的活库锚定自检**（`work/twentieth-forward/selftest-reproduce-nineteenth.mjs`）。
   用第 19 次的记录入参重建，产出逐字节复现活库 `effective_execution_binding` 的
   `prosrc`（`c721b056…`，107,827 字符）与回执记录的 SQL 摘要（`f97d8585…`）。
   **评估者 C5 独立确认了这个锚点成立。** 该项不受本轮 finding 影响。
2. **getter 模块派生**：`existing_forwards<19` → `<20`，仅两个字符，
   沿用 window8(`<18`)→window9(`<19`) 的既定惯例，并证明两模块对第 19 次入参输出完全相同。
3. **控制器重建脚本**（参数化 `root6Expiry`）：四处等长替换，manifest 331 条中
   17 条重定向、4 条重算、314 条逐字节不变。
4. **六份文档重签脚本**：按拓扑序 `QUAL, PROP → APPR → APPL → REPR → RTA`，
   sha256 与 git blob sha1 双重引用逐级传递，产出经独立交叉验证。

**因本轮 finding 需要返工的**：`reissue-seven-documents.mjs` 的 `reissue` 链需按第三节处理 v1/v2；
另需新增 continuation subject 换发、root6 注册体构造与离线校验两套；
范围文件第七节「数据变更」与第十节顺序需按 R8-F1/F3 重写。

---

## 六、边界

未写库、未注册代际、未消耗那唯一一次分配、控制器自 `a573ca9` 起零改动。
本文件不接受任何对象、不签发任何资格、不构成授权。
候选 SQL 在第八轮四件缺件补齐并复核之前不会开始写。
