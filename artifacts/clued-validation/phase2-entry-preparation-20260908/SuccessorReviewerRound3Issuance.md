# 继任独立评估者：第三轮 —— 出具 ② 与 ④

**结论：签。** 两份文档已出具：

| | 文档 | sha256 | blob | 字节 |
| --- | --- | --- | --- | --- |
| ② | [`root6-capacity/Root6CurrentController4000000CapacityApplicability20260912.json`](root6-capacity/Root6CurrentController4000000CapacityApplicability20260912.json) | `a6693eea2ae4cf6790588e56a81fe03739b258f0dc0d4b8fe3fa2e7ba62a3f48` | `3fc15c3c688fb975fd17c3566a5eca740e9df375` | 12684 |
| ④ | [`root6-capacity/Root6Current043CapacityRepairAcceptance20260912.json`](root6-capacity/Root6Current043CapacityRepairAcceptance20260912.json) | `329e70ae5e6d8e153b38d0a4dc180e536636f0b67a09dbd1e6dc10d4a8fa7fac` | `8628a225d351f7b9672f7935f12d0be0644844da` | 7607 |

`accepted_at` 同为 `2026-09-12T01:31:02.664Z`，晚于 ①v2 的 `approved_at`（`2026-09-12T00:54:15.197Z`）36 分钟，落在 `[2026-09-12T00:00:00Z, 2026-09-19T00:00:00Z)` 内。

**两份都还没有权威。** 它们经 Owner 合并、并被重签的运行时验收绑定之后才生效。

## 评估者自述

| 项 | 值 |
| --- | --- |
| 本会话真实标识 | `session_018nf6mQ5CQuMFadoJ9WRZCN`（三轮同一会话） |
| 继任依据 | Owner 合并提交 `a573ca93e094bc9a4a8dccc23c1e165b6b368ff4` |
| 本轮核查版本 | `62c01190f390125d26590dee20eafeacc776a37f`（① 的 Owner 合并为 `01ea76755526c2d20b93dc56b06ed6f24be801c1`，PR #155，双亲真合并，author `tdoljyj`，committer `GitHub`） |
| 历史结论 | ② 与 ④ 均载明：**本接受不追认原 `/root/project_list_auth_fix` 会话的任何历史结论** |
| 本轮写入 | ②、④，以及生成器与验证器两个脚本。**未修改实施方任何产物**（`git status` 仅列出 `root6-capacity/` 下这两份与 `work/successor-reviewer/`） |

---

# 一、R2-F1 已解除，逐项复核

你给的四个标志全部吻合：merge `01ea767` 双亲真合并；批准 v2 blob `4b9b8c73…` / sha256 `80d0566a…`（7833 字节）；提案 blob `63a1fa29…` / sha256 `8befb8fd…`（4146 字节）；`approved_at` 未变。

指针对齐是**我自己从字节重算的**，不是读它的声明：

```
提案实际 sha256          = 8befb8fd8f89c76759611361a44942b0b8a8800ca2ef753d4f33d7c8ed679149
提案实际 blob sha1       = 63a1fa29e3771f60b610a4538e5a7ff0bc7620a0
①v2.capacity_proposal_ref → 二者逐字节一致                                    ✓
①v2.approved_change_index_sha256 → 等于提案 sha256                            ✓
提案 capacity_delta === 控制器 capacityDelta（含 133）                         ✓
①v2 capacity_delta === 控制器 capacityDelta                                   ✓
提案 capacity_delta === ①v2 capacity_delta                                    ✓
```

其余各项与第二轮一致：`state`、`base_proposal_sha256`、`base_approval_ref`（= appendix `approval_ref`）、`bounded_series_constraints`（= scope）、`baseline`、规范紧凑 JSON 往返，全部通过。

**`approved_at` 保持不变，我认为是对的。** Owner 的实质决定（「行 按你的建议来」，其中逐字包含「三处 131 上限抬到 133」）发生在那一刻；错的只是一个指针，提案文档是事后对同一决定的誊写。改日期反而会谎报决定时刻。机械上两种选择都能过 `CAPACITY_APPROVAL_CURRENT_ROOT5_TIME`，所以这是诚实性问题而非合规问题，保持不变更诚实。

## R3-F1 —— ①v2 内部有一处自相矛盾 〔瑕疵，不阻塞，建议下次一并修〕

同一份文档里：

- `what_changed_from_predecessor.conflicts_with` 仍写着「…Raising a cap is a cap extension.」，且 `independently_reviewed: false`；
- `governing_exclusion_analysis` 写着该读法已被评审者驳回、此处采纳撤回。

一份文档同时主张并撤回同一条断言。控制器不读这两个字段，所以不影响运行；但它会在记录里永久留下一个它自己并不成立的自我指控。建议下次触动 ①v2 时把 `conflicts_with` 改写为指向 `governing_exclusion_analysis` 的结论。我**没有**因此拒签——这是措辞，不是效力。

---

# 二、R2-F3 的处置：我停止等待依据，改为自己定规则并写进文档

第二轮我把「`changed_source_refs` 装什么」列为出具前置，并说「需要实施方提出依据」。**这个前置条件我自己撤回了**，理由如下。

我去追前代那 20 条的来源，结果是：

- 10 条落在 root5 控制器目录（含 manifest 本身，其 sha256 即当时的控制器摘要）；
- **另外 10 条是真实的 git 对象（`git cat-file` 可取、sha256 全部吻合），但在本仓库里对应不到任何路径。** 逐条打开看，是一个 Windows 管理工作树（`C:/Users/Windows/Documents/Codex/2026-09-10/kernel-phase2-final-admin`）里的源文件。
- 前代 ② 自己的 `source_set_semantics` 写的是「current controller and exact candidate **external sources**」——那个 external 的一半，前任评估者看得见，我看不见。

所以这不是「实施方还没给依据」，而是**这条惯例的另一半不在本仓库内，谁也给不了我**。继续等下去是把一件不可能的事挂成阻塞。

`changed_source_refs` 是**评估者自己的断言**，控制器只查形状（`context.mjs:135`），不与 manifest 或源闭包交叉校验。既然是我的断言，就该装我真正核验过、并且敢担保的东西，并把规则写在文档里——第二轮我担心的「静默认证一个错误的变更集」，正是靠把规则写进文档来消除的。

**规则 R6（已写入 ② 的 `source_set_semantics`）**：root6 窗口迁移引入的、我在第一轮逐字节核验过的 blob，共 19 条：

| | 内容 | 条数 |
| --- | --- | --- |
| (a) | root6 `ControllerSourceManifest.candidate.json` 本身，领头（其 sha256 即控制器摘要 `72d9eb92…`），与前代排序一致 | 1 |
| (b) | 该 manifest 声明的、路径位于 root6 控制器目录内的全部 `REPOSITORY_SOURCE`，按 manifest 顺序 | 17 |
| (c) | 新增的 `commitment-signing-root6-window/signing.mjs` | 1 |

按 blob URI 去重。**不声明任何 off-repo 源，因为一条都没评审过。**

② 里明写了这一点比前代**窄**，以及窄在哪里。这是一处有意的、披露过的不连续，不是遗漏。

---

# 三、我怎么确认这两份文档真能过控制器

没有靠「对着表填」。两层：

**第一层，生成器内的前置断言**（[`work/successor-reviewer/issue-capacity-applicability-and-repair.mjs`](../../../work/successor-reviewer/issue-capacity-applicability-and-repair.mjs)）。`capacityDelta`、`capacityBaseline`、`scope`、`proposalSHA`、`previous_evidence_sink_ref` 的硬编码 sha256、`capacityRepairState`、root6 代际——**全部从 `context.mjs` 源码抽取，一个都没有重新键入**。每个 ref 都由它所指文件的实际字节导出 blob sha1 与 sha256。写盘前跑完控制器的每一项比较，任一不符即 `REFUSING_TO_ISSUE:` 抛出、不产出文件。

**第二层，独立验证器**（[`work/successor-reviewer/verify-issued-documents.test.mjs`](../../../work/successor-reviewer/verify-issued-documents.test.mjs)），**不导入生成器、不重写判断**：它按 reason string 从 `context.mjs` 里**原样截取** `need(...)` 的条件表达式，用控制器自己的辅助函数求值，作用在已落盘的字节上。改写一句比较就不算检查那句比较。

生成器是**确定性**的：`accepted_at` 是钉住的常量而非读时钟，重跑逐字节复现同样的摘要。（初版读了 `new Date()`，重跑即换摘要——我拿同一把尺子量自己时发现的，已改。）

16 项测试全部通过，每条正向断言都配了负向：

| 被截取的控制器表达式 | 正向 | 负向（必须被拒） |
| --- | --- | --- |
| `EXACT_INDEPENDENT_CAPACITY_APPLICABILITY` | ✓ | 评估者身份改成 `/root` → 拒 |
| 同上 | | `capacity_proposal_ref` 换回那份声明 131 的提案（即 R2-F1 的病灶）→ 拒 |
| `CAPACITY_ONLY_EXPLICIT_DELTA` | ✓ | `source_refs_maximum` 改回 131 → 拒；混入 `scope_unchanged` 键 → 拒 |
| `CAPACITY_ACCEPTANCE_TIME` | ✓ | `accepted_at` 提前 **1 毫秒**至批准之前 → 拒 |
| `CAPACITY_EXACT_CURRENT_CONTROLLER_SCOPE` | ✓ | 换回 `ac7bdd53…` → 拒 |
| `CAPACITY_EXACT_EVIDENCE_SUCCESSOR` | ✓ | evidence sink 等于其前代 → 拒 |
| `CAPACITY_EXACT_CHANGED_SOURCE_REFS` | ✓ | URI 重复 → 拒；空集 → 拒 |
| `CLOSED_SOURCE_REF_MAXIMUM` | ✓ | （v17 的 `source_ref.blobs` 实测 133） |
| `isApprovedCapacityRepair` 整式 | ✓ | 旧控制器摘要 / 旧批准 ref / 旧适用性 ref / 与 ② 不一致的 `changed_source_refs` / `scope_unchanged` 键 / 错误评估者身份 —— **六种全部被拒** |

另外四项：两份文档都通过 `parseAuthenticatedAdministrativeJSON` 的规范紧凑 JSON 往返；④ 指向的适用性 sha256 与落盘字节一致；两份都指向 ①**v2** 而非被取代的 v1；`changed_source_refs` 19 条**逐条在本仓库内解析得到实际文件**（规则 R6 的自证）。

---

# 四、我在 ② 里写死的三件事，请下一步照做

这些不是建议，是 ② 自身的条款：

**1. ③ 必须绑 v2，不能绑 v1。** 两份批准文档现在都在 main：被取代的 `d0649465…`（指向声明 131 的提案）与 `80d0566a…`。② 与 ④ 都只认后者。③ 的 `capacity_materials.approval.ref` 若绑了 v1，`same(d.approval_ref, s.capacity_materials.approval.ref)` 直接失败。② 的 `binding_requirement_for_the_runtime_acceptance` 字段写明了这一条。

**2. 两条仓库外前置条件，我无法验证，写进了 ② 的 `preconditions_outside_this_repository`：**

- root6 的 `GENERATION_REGISTERED` 体，其 `not_before` **不得晚于 `2026-09-12T00:54:15.197Z`**（`context.mjs:44` 要求 `registered.not_before ≤ approved_at`，而注册体一旦写入不可改）；
- 其 `expires_at` **必须恰为 `2026-09-19T00:00:00Z`**（由 `root-window-validation.mjs:31`、`context.mjs:44`、`budget-evidence.mjs:18`、`context.mjs:179` 共同夹定）。

**若注册体与其中任一条冲突，② 不适用，不得被消费。** 仓库里没有这个体，我也没有数据库访问；这是一条有意写下的适用边界，不是我漏查。

**3. 前推额度 15 → 16 不在本次接受范围内。** ② 的 `what_is_not_accepted` 逐字写明：该上限是控制器常量，既不在 appendix 的 scope 里也不在 `capacity_delta` 里，无任何文档背书，**不因我签了 ② 而被一并背书**。README 现在的定性是准确的；补法（重签有界序列适用性）仍待 Owner 决定。

---

# 五、我实质上背书了什么

签字不是盖章，把范围说清楚：

**背书**：对 root6 控制器 `72d9eb92…`，`capacity_delta.source_refs_maximum` 可以是 133 而非 131。依据是 ①v2 与其提案（两者都声明 133，且 `capacity_delta` 与控制器冻结常量逐字节相同），以及 133 这个数在算术上精确——1 份 manifest + 144 条声明的仓库源 − 12 条内容重复的 blob = 133，与前代由 142 得 131 是同一构造。这三件我在第一轮都独立算过。

**治理立场**（已写入 ② 的 `governing_exclusion_position`）：`excluded` 管的是 root3 appendix 自己那套 scope 上限；`source_refs_maximum` 在 `capacity_delta` 这个补充层，同一机制已走过 128→130→131 三次，每次都有 Owner 批准加一份独立适用性。按逐字读法那三次也违规，整条链连同本轮依赖的 4,000,000 字节上限一并作废——归谬成立，故该读法不成立。这是我签 ② 的理由，不是实施方的说法。

**不背书**：任何 GA、GRR、Entry、gate 结果、资格通过、运行准入；前推额度；任何进一步的 cap extension、新 trust root、新签名身份、付费/模型预算或生产权限；以及实施方的任何结论——② 与 ④ 里每一个被强制的值都是我从源头取的，并在写盘前跑过控制器的比较。

---

# 六、还剩什么

| | 事项 | 谁 | 状态 |
| --- | --- | --- | --- |
| ① | 容量批准 v2 + root6 容量提案 | Owner | ✓ 已合并（`01ea767`） |
| ② | 容量适用性 | 我 | ✓ 本轮出具，待 Owner 合并 |
| ④ | 043 容量修复接受 | 我 | ✓ 本轮出具，待 Owner 合并 |
| ③ | 重签运行时验收（`capacity_delta`→133、`capacity_materials` 指向 ①v2 与 ②、`bounded_series_materials.repairs` 以 ④ 替换 `5911567d…`） | 实施方 | 待办 |
| — | root6 `GENERATION_REGISTERED` 追加（须满足第四节第 2 条） | 实施方/Owner | 待办，不可回退 |
| — | StatusManifest generation 24 | 实施方 | 待办，须在 ③ 定稿后 |
| — | 第二十次绑定前推 | 实施方 | 待办 |
| — | 前推额度 15→16 的背书文档 | Owner | 未决 |

③ 定稿后请交回：④ 的 descriptor 必须出现在 `bounded_series_materials.repairs` 中，且其 `ref` 与 ④ 的实际字节一致；这一条我会再核一次。

预算现实不变：`charged_seconds` 9906 / 10506，**恰好只剩一次分配，没有重试**。本轮出具没有消耗它，也没有改动控制器。

---

## 本文件是什么、不是什么

- 是：第三轮的出具记录，以及 ② 与 ④ 的验证证据。
- 不是：GA、GRR、Entry 或任何 Gate 的通过；也不是对 root6 方案整体可行性的背书。
- ② 与 ④ 均载明不追认原 `/root/project_list_auth_fix` 会话的任何历史结论。
- 未修改实施方的任何产物。
