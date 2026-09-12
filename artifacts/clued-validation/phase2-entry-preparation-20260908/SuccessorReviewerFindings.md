# 继任独立评估者：第一轮发现清单

**结论：不该签。** 下列 F1、F2 各自独立阻塞，均未解决；F3 在本次评审进行期间由阻塞降级为时序约束（见该条）。按[交接简报](SuccessorReviewerBrief.md)「发现未解决即不得出具接受」，本轮不出具任何接受。本文件是发现，不是接受。

## 评估者自述

| 项 | 值 |
| --- | --- |
| 本会话真实标识 | `session_018nf6mQ5CQuMFadoJ9WRZCN` |
| 继任依据 | Owner 合并提交 `a573ca93e094bc9a4a8dccc23c1e165b6b368ff4`（PR #153，双亲真合并，author `tdoljyj`，committer `GitHub`，base `main`），该提交携带 [OwnerIndependentReviewerSuccessionDecision.md](OwnerIndependentReviewerSuccessionDecision.md) |
| 与实施方的关系 | 非实施会话 `session_012ki2dPxTiJbPmgZu7AD3Nz`，非其 subagent；未参与 root6 控制器产生、窗口选择、前推额度 override 决定或任一待审文档的起草 |
| 历史结论 | 本文件不追认原 `/root/project_list_auth_fix` 会话的任何历史结论 |
| 核查版本 | `a573ca93e094bc9a4a8dccc23c1e165b6b368ff4`，工作区干净 |

---

# 一、会导致运行失败的发现

## F1 —— 被指名的唯一阻塞点没有被修，且迁移工具根本没尝试修 〔阻塞〕

控制器冻结常量 `capacityDelta.source_refs_maximum` 已改为 **133**（`context.mjs:113`）。该常量在 `checkCapacityAdministration` 中被**三次逐字节比对**：

| 检查 | 代码 | 被比对的文档 | 该文档当前值 |
| --- | --- | --- | --- |
| `EXACT_CAPACITY_SUBJECT_AND_LOADED_SET` | `same(s.capacity_delta,capacityDelta)` | 运行时验收 `accepted_subject.capacity_delta` | **131** |
| `REAL_EXACT_CAPACITY_APPROVAL_REQUIRED` | `same(a.capacity_delta,capacityDelta)` | Owner 签署容量批准 `f3afb108…` | **131** |
| `EXACT_INDEPENDENT_CAPACITY_APPLICABILITY` | `same(d.capacity_delta,capacityDelta)` | 独立容量适用性 `cc3db45b…` | **131** |

全仓库**没有任何文档声明 133**（穷举 `source_refs_maximum` 全部出现处：128×21、130×9、131×8，133×0）。

`reissue-acceptances.mjs` 从不触碰 `capacity_delta`。这不是推断——我在隔离 worktree 中修正其过期 pin 后实际跑通了它，产出的 v17 运行时验收为：

```
capacity_delta.source_refs_maximum = 131          ← 控制器要求 133
capacity_materials.approval.sha256 = f3afb108…    ← 仍指向 131 的批准
capacity_materials.applicability.sha256 = cc3db45b… ← 仍指向 131 且钉住 ac7bdd53 的适用性
expected_ga.controller_digest = 72d9eb92…          ← 这一项对了
expected_ga.source_ref.blobs = 133                 ← 这一项也对了
```

即：**即使脚本能跑，产物也过不了第一道容量检查。** 且三份文档中，容量批准需要新的 Owner 签署，容量适用性需要新的独立接受（即我），运行时验收需要两者的新引用——存在真实的依赖顺序，不是三处并行改数字。

`build-root6-successor.mjs:43-48` 的注释已正确写明「both must be reissued」（第 48 行），但没有任何脚本执行它。Owner 决定的评估范围第 2 项「容量适用性继任文档」**不存在**，无从评审。

## F2 —— `reissue-acceptances.mjs` 以当前字节无法运行 〔阻塞〕

脚本钉住的三个 git 对象来自 PR #152，而控制器在 PR #153 里又改了：

| 常量 | 脚本值 | 实际 |
| --- | --- | --- |
| `SOURCE_COMMIT` | `4d33717…`（Build the root6 successor controller source） | 该提交早于 #153 的控制器改动 |
| `SOURCE_TREE` | `16fa4d16…` | 其中 manifest blob 为 `f856b536…`，当前为 `c27f9421…` |
| `OWNER_MERGE` | `7ac27f3…`（PR #152） | 携带当前控制器的是 `a573ca9…`（PR #153） |

实测（隔离 worktree，未触及仓库）：

```
Error: SOURCE_TREE_DOES_NOT_CONTAIN_THIS_CONTROLLER:16fa4d165d1285b02cbe9444e49dd826827dccbb
```

抛出且不写任何文件。**守卫本身是对的，应记一功**——它正是实施方补的那条真实守卫，并且确实拦住了。问题是常量在 #153 之后没跟着更新，于是 Owner 决定评估范围的第 2、4 项都没有产物。

**守卫覆盖不全（残留风险）**：该守卫只校验 `SOURCE_TREE`。`SOURCE_COMMIT` 与 `OWNER_MERGE` 不在守卫内。

- 若有人更新 `SOURCE_TREE` 而漏掉 `SOURCE_COMMIT`，守卫通过，但运行时 `source-publication.mjs:36` 的 `ACTUAL_SOURCE_COMMIT_TREE`（要求 `commit.commit.tree.sha===sourceRef.tree`）失败——**而这发生在 GA 签发之后的 600 秒计费窗口内**。
- `OWNER_MERGE` 常量在运行时不被读取（`verifySourcePublication` 用的是 `material.runtime_acceptance.publication.commitSha`），所以它只是文档字段与事实不符，不会致运行失败。这一点应写清，免得下一轮把力气花错地方。

## F3 —— 容量材料的签署时序是严格有序的，且窗口刚刚才打开 〔时序约束，本文件写作期间状态发生了变化〕

三条 `currentWindow` 门（`context.mjs:61/72/77`）分别要求注册体、运行时验收、资格文档的 `not_before <= now`。三者的 `not_before` 计划值均为 `2026-09-12T00:00:00Z`（运行时验收与资格文档由 `reissue-acceptances.mjs` 的 `NOT_BEFORE` 常量写入；注册体尚不存在，该值由 README 第 88 行规定），因此整轮运行在该时刻之前无法开始。

叠加 `context.mjs:44`：

```js
check(time(registered.not_before)<=time(approvedAt) && time(approvedAt)<=time(now) && …,
      'CAPACITY_APPROVAL_CURRENT_ROOT5_TIME');
```

以及 `d.accepted_at >= a.approved_at`，得到一条**严格且不可回溯**的时间序：

```
2026-09-12T00:00:00Z  ≤  Owner 容量批准 approved_at
                      ≤  独立容量适用性 accepted_at
                      ≤  运行时刻  <  2026-09-19T00:00:00Z
```

**状态变化，如实记录**：本次评审开始时为 `2026-09-11`，当时这条构成硬阻塞——那一天签发的任何容量批准或容量适用性，其 `approved_at` / `accepted_at` 都早于 `registered.not_before`，将**永久**过不了 `CAPACITY_APPROVAL_CURRENT_ROOT5_TIME`（注册体一旦写入即固定，改它要换代际）。审查进行期间时刻越过了 `2026-09-12T00:00:00Z`，本文件定稿时为 `2026-09-12T00:00:21Z`。因此：

- **该陷阱已经解除**，窗口现已打开，F1 所需的两次签署从现在起可以满足这条不等式。降级为时序约束，不再是阻塞。
- **没有造成实际损失**：我确认 F1 涉及的三份 133 文档**一份都还不存在**，所以没有任何材料被错误地签在 09-11。
- **约束本身仍然有效且严格**：`Owner 容量批准 approved_at` ≤ `独立容量适用性 accepted_at` ≤ `运行时刻`，三者必须依次递增且全部落在 `[2026-09-12T00:00:00Z, 2026-09-19T00:00:00Z)` 内。不能为了省事把三份文档盖同一个时间戳再倒排顺序。
- 仓库内没有任何一处记录了这条时序。它是从 `context.mjs:44`、`:47`、`:61/72/77` 与 `d.accepted_at >= a.approved_at` 交叉推出来的，不写下来下一轮还得再推一次。

（另有一条例外路径见 F4：把注册 `not_before` 提前到 `2026-09-10T13:18:47Z`。控制器允许，但那样「Owner 批准的窗口是 09-12 起」这句话就不成立了。既然窗口已经打开，这条路已无必要，更不应再走。）

---

# 二、会导致「运行成功但产出无效结果」的发现

## F4 —— 窗口下界回退：批准窗口只剩一端受约束，而「派生 id」这条保证是装饰性的

`root-window-validation.mjs:31` 在 #152 里被收紧为 `>= 2026-09-12T00:00:00Z`，#153 又**回退**为 `>= 2026-09-10T13:18:47Z`。

回退本身有正当理由（收紧会让 F3 的不等式无解，这一点实施方诊断正确）。问题是回退之后：

1. **README 的 8 项阻塞清单第 5 项仍然逐字主张必须收紧下界**，并已经写明后果：「无任何其他检查钉住 `body.not_before`，root6 可合法声明早至 `2026-09-10T13:18:47Z` 的起点」。该分析**现在成立**，而 README 未更新，测试反而把弱化后的行为写成了期望（`root6-readiness.test.mjs`：「the Owner window ceiling moved and the lower bound did not」）。

2. `build-root6-successor.mjs:38-41` 的辩解——「`approved_at` 从上方约束它，这是一条真实约束」——**只在容量材料被绑定时成立**。`checkCapacityApprovalTime` 只在 `checkCapacityAdministration` 内部被调用，而该函数在 `accepted_subject` 不含 `capacity_materials` 时**直接 return null**（`context.mjs:120-121`）。见 F5：这条早退路径是存在的。

3. **代际 id 的派生是真的，但运行时从不校验。** 我独立复算确认：
   `sha256("clued/root6-generation/v1\n" + ctrgen_e5df4322… + "\n2026-09-12T00:00:00Z\n2026-09-19T00:00:00Z\n")[:32]` = `5e0440a95ac8ee257b9e4236cabd275b` ✓
   但 `context.mjs` 里它只是一个硬编码字符串常量。以 `not_before = 2026-09-10T13:18:47Z` 注册、同时沿用该 id，控制器每一项检查都会通过——而这个 id 的派生式却宣称窗口起点是 09-12。「复核者可以自行确认该 id 不是为迁就任何东西挑出来的」这句保证，因此只对**构建时**成立，对**注册时**不成立。

## F5 —— 容量绑定早退：删掉两个字段即可让整块容量治理静默消失 〔本轮最危险的路径〕

```js
const s=runtime?.accepted_subject, has=s&&Object.hasOwn(s,'capacity_materials');
if(!has){need(!Object.hasOwn(s??{},'capacity_delta')&&capacity_materials===null,
              'CAPACITY_PARTIAL_BINDING_FORBIDDEN'); return null;}
```

若 v17 运行时验收**同时**去掉 `capacity_materials` 与 `capacity_delta`，该函数返回 `null`，于是以下检查**全部不再执行**：

- `same(s.capacity_delta, capacityDelta)` —— F1 的 133 比对，消失
- `CLOSED_SOURCE_REF_MAXIMUM`（`blobs.length<=133`）—— 消失
- `EXACT_INDEPENDENT_CAPACITY_APPLICABILITY`（含 `d.controller_digest===s.expected_ga.controller_digest`）—— 消失
- `CAPACITY_APPROVAL_CURRENT_ROOT5_TIME` —— 消失（这也是 F4 第 2 点的机制）
- `ACTUAL_043_BLOCKED_TERMINAL_REQUIRED`、`CAPACITY_NO_BASELINE_REFUND_OR_REWIND` —— 消失

并且 `repairAccepted` 会**降级**：

```js
const repairAccepted=(r,a,strictArray)=>{
  if(capacity && a.ga_id===capacityBaseline.failed_ga_id) return isApprovedCapacityRepair(r,a,capacity);
  …通用路径，只要求 state==='ACCEPTED_EXACT_SAME_SCOPE_QUALIFICATION_REPAIR' 且 scope_unchanged===true…
```

`capacity` 为 `null` 时，043 那次 BLOCKED 尝试从「须有经批准的容量修复」掉到「任何同范围修复接受即可」。

**实施方没有做这件事。** 我把它写下来，是因为它是解决 F1 最省力的一条路——F1 的正路要一次新的 Owner 签署加一次新的独立接受，而这条路只要删两个键。走这条路，运行会成功，产出的凭据却不携带任何容量授权，4,000,000 字节输入上限与 133 条源引用都将处于无背书状态。

**这条路必须被明确禁止，而不是留给下一轮临场判断。**

## F6 —— README 规定的注册值会使运行必然失败

README 是本次迁移唯一的文字操作手册。它在两处仍写着旧窗口：

- 第 13 行：「窗口为 Owner 批准的 `2026-09-12T00:00:00Z` .. `2026-09-13T00:00:00Z`」
- 第 88 行：root6 的 `GENERATION_REGISTERED`「其 `not_before` 与 `expires_at` 须**精确**为 `2026-09-12T00:00:00Z` 与 `2026-09-13T00:00:00Z`」

而控制器与重签脚本用的是 `2026-09-19T00:00:00Z`。按 README 注册的后果：

```
check(runtime.expires_at===registered.expires_at && …, 'CAPACITY_CURRENT_ROOT5_EXPIRY')
       2026-09-19T00:00:00Z  !==  2026-09-13T00:00:00Z   → 失败
```

正确值可由三个约束夹出唯一解：`budget-evidence.mjs:18` 要求 `budget.expires_at <= root.expires_at`，`expiryForBudget(seq>=89)` 要求 `budget.expires_at === 2026-09-19T00:00:00Z`，`context.mjs:44` 要求 `runtime.expires_at === registered.expires_at <= 2026-09-19T00:00:00Z`。故 `registered.expires_at` **必须恰为 `2026-09-19T00:00:00Z`**。README 说的 09-13 会直接废掉这次注册，而注册是不可回退的。

README 第 5 项阻塞（见 F4）同样与已发布代码相矛盾。简报自陈实施方曾把编造的因果链写进 README 并已更正；这里是同一类问题的第二次发生。

---

# 三、瑕疵

## F7 —— 两套互斥的迁移方案同时活在 main 里，都没有被标记作废

`root5-final-runtime-v16/*.WindowSuccessorSubject.json` 四份文档仍在 main，状态 `PREPARED_…_NOT_ACCEPTED`，内容为：

```
controller_digest = ac7bdd53…（已死的 root5 摘要）
root_generation   = ctrgen_e5df4322…（root5）
expires_at        = 2026-09-12T13:14:51Z（与 root6 的 09-19 互斥）
```

同时 `Package3ZeroCostPreflightCorrection.json` 记录了它们的 4 项缺陷，状态**全部为 `NOT_YET_FIXED`**（预盖 `accepted_at`、覆盖 `supersedes` 丢溯源、覆盖 `successor_delta`、未变字段计数错误）。而 main 里的 `IndependentReviewerSuccessionProposal.md` 仍把这四份当作评审对象在描述。

root6 方案已经取代它们，但仓库里没有任何一处这么说。任何按继任建议书（而非按交接简报）行事的人，会去评审并可能接受四份钉住死摘要的文档。

## F8 —— 19 处 `setPath` 守卫中仍有 11 处是同义反复，且过期的三项恰好全在这一侧

`reissue-acceptances.mjs` 的 `setPath(doc,label,path,expected,next)` 在 `expected` 与当前值不符时抛错。以下 11 处传入的 `expected` 就是 `doc` 的当前值，因而恒真：

| 文档 | 字段 |
| --- | --- |
| qualification | `not_before`、`source_ref`、`source_commit`、`source_tree`、`source_owner_merge`、`actual_repository_source_files`、`ordered_source_ref_count` |
| runtime_acceptance | `not_before`、`expected_ga.source_ref`、`control_schema_refs.StatusManifest`、`control_schema_refs.GateResultReceipt` |

合计 11 处同义反复；真实守卫 8 处（qualification 4：`controller_digest`、`root_generation`、`authority_basis.root_generation`、`expires_at`；runtime_acceptance 4：`controller_digest`、`expires_at`、`expected_ga.control_trust_root_generation`、`expected_ga.controller_digest`）。11 + 8 = 19。

这与简报自陈的「19 个字段中有 11 个是同义反复」**数量完全一致**——即这 11 处一处都没有改成真实守卫。因此脚本 `changes` 报告里这 11 行的 `from → to` 是自我实现的，「本脚本是对着这份前代文档写的」这条保证只覆盖 19 个字段中的 8 个。**值得注意的是，实际过期的恰好是 `source_commit` / `source_tree` / `source_owner_merge` 这三个——全部落在同义反复的一侧**，靠的是另加的那段 `git ls-tree` 守卫才抓到（见 F2）。简报称「已补真实守卫」，指的是那段守卫；这 11 处并未转为真实守卫。

## F9 —— 单进程内驻留第二套 signing 白名单与第二个 `checkCurrentSemantics`（既有结构，非本次回归）

从 root6 `cli.mjs` 出发的静态导入闭包共 34 个模块，其中同时载入：

```
…/commitment-signing-root6-window/signing.mjs   （允许 root6，正确）
…/commitment-signing/signing.mjs                （makeCommitment 硬钉 ctrgen_dd30fbc7…）
```

第二条路径为 `root6/result-terminal.mjs → root6/original-inputs-blob.mjs → scenario-observations/request-denials-packed.mjs → request-denials.mjs → runtime600/context.mjs → runtime600/trusted-github.mjs → commitment-signing/signing.mjs`。

我确认它在 root6 路径上**休眠**：`request-denials-packed.mjs` 只被用到 `decodeOriginalInputs`，而调用旧 `checkCurrentSemantics` 的是同文件另一个导出 `observeRequestDenials`，本路径不触发。root5 前代结构相同，故**不是本次引入的回归**，不构成阻塞。记录在此是因为：同一进程里同时驻留一份旧的代际白名单和一份旧的 `checkCurrentSemantics`，未来任何一次「顺手复用一下那个函数」都会在最后 600 秒里炸。

---

# 四、我独立验证为「正确」的部分

这些是实施方做对了的，逐项自查过，不是转述：

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| 控制器摘要 `72d9eb92…` | `sha256(ControllerSourceManifest.candidate.json)` | ✓ 一致 |
| 代际 id 是派生而非挑选 | 独立复算 sha256 派生式 | ✓ 一致 |
| `133` 这个数对不对 | 1（manifest）+ 144（REPOSITORY_SOURCE）− 12（内容重复的 blob）= 133；前代同法 1+142−12 = 131 | ✓ 精确吻合，不是拍的 |
| manifest 声明的字节是否为真 | 144 条仓库内条目逐条比对 `bytes` 与 `sha256` | ✓ 0 处不符 |
| `root6BudgetSequence=89` 是否会重分类历史 | `GENERATION_REGISTERED` 位于 `root.events`，与 `execution.events` 是两个序列空间；后者最高为 88 | ✓ 不重分类任何历史预算/尝试 |
| 额度算术 | 前推 15 < 16；预算 8 < 9；`5106+600×8 = 9906`，`+600 = 10506` 恰为上限 | ✓ 恰好一次分配，无重试余地 |
| 21/21 readiness 测试 | 我自己跑的 `node --test`，非转述 | ✓ 21 pass / 0 fail |
| 前代目录未被改动 | `sha256` 比对 = `ac7bdd53…` | ✓ |
| 共享 signing 模块未被原地修改 | `commitment-signing-next-window/signing.mjs` 不含 root6 代际 | ✓ 新增副本而非原地改，正确 |
| 两份 schema 的改动范围 | 逐行 diff | ✓ 仅代际 const，各 2 处 / 1 处 |
| 两份未被消费的适用性文档被略过 | 独立确认 root6 控制器源码中无任何引用 | ✓ 略过是对的，不是遗漏 |
| `source-publication.mjs` 死 manifest 路径 | 已改指 root6 目录 | ✓ 简报列为最危险的一项，已修 |
| `tool-entry.functions.js` 启动路径 | 已从 `root5-final-successor` 改指 root6（2 处） | ✓ |

---

# 五、我无法从仓库文件独立验证的部分

按简报要求明确列出。下列各项我**只能转述实施方的记录**，不构成我的确认：

1. **实时数据库状态**。前推序列（45…88 共 15 次）、预算序列（8 次）、`current.sequence`、`charged_seconds = 9906`——全部出自 `OwnerForwardCapExtensionOverride.json` 中实施方自述的只读查询。我没有数据库访问。F1/F3 的结论不依赖这些数字，但「恰好只剩一次分配」这一前提依赖。
2. **root6 的 `GENERATION_REGISTERED` 是否已追加**，以及若已追加，其 `not_before`/`expires_at` 实际写了什么。F3 与 F4 的走向完全取决于此。
3. **`reserve_execution_budget` 的 `series_n>=9` 拒绝**。SQL 侧逻辑，仓库内无对应源码。
4. **manifest 中 187 条 `RUNTIME_DEPENDENCY`**（`C:/Program Files/…`、node_modules、node.exe/gh.exe/docker.exe 摘要）。绝对 Windows 路径，本环境不存在，按构造即为未校验携带。占 331 条中的 56%。
5. **GitHub blob URI 是否可解析**。`source_ref.blobs` 的 133 个 URI 需要 API 调用才能确认；我只验证了其 blob sha1 由本地字节正确导出。
6. **Owner 的真实意图是 09-12 起还是更早**。F4 指出控制器允许更早；仓库里没有任何文件记录这个选择。这是 Owner 的事，不是我能替他判断的。

---

# 六、要解除阻塞需要发生什么

不是我的工作，写出来是为了让下一步不必再推一遍依赖顺序。按此序，缺一不可：

1. 修正 `reissue-acceptances.mjs` 的 `SOURCE_COMMIT` / `SOURCE_TREE` / `OWNER_MERGE`（F2），并把守卫扩展到覆盖 `SOURCE_COMMIT` 与 `SOURCE_TREE` 的配对关系。
2. 更正 README 第 13、88 行的窗口值与第 5 项阻塞的结论（F6、F4）；把窗口下界回退这一决定及其后果显式记录，而不是让代码与手册各说各话。
3. 明确记录 root6 注册体的 `not_before` 取值及其依据（F4）；`expires_at` 只有 `2026-09-19T00:00:00Z` 一个解（F6）。
4. **在 `2026-09-12T00:00:00Z` 之后**，Owner 重签携带 `source_refs_maximum: 133` 的容量批准（F1、F3）。
5. 其后由我（或 Owner 另行指派的继任者）评审并出具携带 133、且 `controller_digest = 72d9eb92…` 的容量适用性接受（F1、F3）。
6. 让 `reissue-acceptances.mjs` 同时更新 `accepted_subject.capacity_delta` 与 `capacity_materials` 的两个引用（F1）。
7. 重跑脚本，产出 v17；届时我评审资格文档与运行时验收继任文档。
8. 之后才轮到 StatusManifest generation 24 与第二十次绑定前推——两者目前**在仓库中均不存在**，Owner 决定评估范围的第 5、6 项无物可审。

**第 4、5 步不得用删除 `capacity_materials` / `capacity_delta` 的方式绕过（F5）。**

---

## 本文件是什么、不是什么

- 是：一次只读评审的发现清单。
- 不是：接受、资格、GA、GRR、Entry、任何 Gate 的通过，也不是对 root6 方案总体可行性的背书。
- 不追认原 `/root/project_list_auth_fix` 会话的任何历史结论。
- 未修改实施方的任何产物；本轮唯一写入的文件就是本文件。
