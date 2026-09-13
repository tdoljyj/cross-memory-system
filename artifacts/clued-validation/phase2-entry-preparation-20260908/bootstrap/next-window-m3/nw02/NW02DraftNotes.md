# NW-02 续窗主体件与配套：起草说明（会话 J，2026-09-13）

**状态：`DRAFT_ONLY_NO_WRITE_NO_EXECUTION_NO_PR_NO_MERGE`。**
本轮只写文件。未写库、未 `append_event`、未预留、未跑 600 秒、未开 PR、未合并。
未动 `scripts/phase2-qualification/`、`bootstrap/root7-runtime-v20/`、`work/f12/`。
对活库只做了**两次只读 select**（下文逐条给出用途与时刻），没有任何写。

产出（全部在本目录）：

| 文件 | bytes | sha256 | 性质 |
|---|---|---|---|
| `ContinuationRegistrationSubject.canonical.json` | 4917 | `c6b354a80b1c5c625df63726854a7525a91528f5820731936d06ac77d4cedf57` | 候选主体件，**带 5 个未决哨兵** |
| `ContinuationRegistrationSubjectAcceptance.skeleton.json` | 2967 | `785fec9473bf15c05a119f787a75fa26d4538363a1d22089913b022a3c07a925` | 骨架，**须独立评审出具** |
| `ContinuationControlStoreAcceptance.skeleton.json` | 4160 | `478cdbc4937dc09e07ba7c06ebec388c3fff773e09241df2624d5e11ba41b4f4` | 骨架，**须独立评审出具** |
| `ContinuationSubjectSignatureEvidence.skeleton.json` | 5159 | `0a3dfa951ad1e170f8d2e3e8df0b2196d2b85563abc14105d1ee4fffed2f79bc` | 骨架，生成器可出，**须待 M4 合并后** |
| `nw02-parameters.json` | — | — | 生成器参数（前像为草稿基线） |
| `build-nw02-sql.mjs` | — | — | 生成器，**只生成不执行** |
| `NW02Applied.sql` | 19863 | `c064f919f80df253b1c69209938f078b804992156d58e317c9702a7bc01c119e` | `--draft` 产物，**首 11 行是不可执行横幅** |
| `NW02Preflight.sql` | 7324 | `4df42c989cacdaf2bac47d7b48dada2923b31b341d31d51ad986602439f08721` | 纯 SELECT，17 条守卫 |

**这四个 sha256 一个都不得进库。** 三份是骨架、一份带哨兵；生成器在没有 `--draft` 时拒绝出文件
（实测见 §5 的 S12）。

---

## 1. 四个 sha256 各指向哪份文书 —— 实测，不是推断

活行的四个摘要字段与 NW-01 四份文书的对应关系，逐条用 `sha256sum` 复算过：

```sh
A=artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-20260912
sha256sum $A/ContinuationRegistrationSubject.canonical.json        # 64ae7adc… = 活行 subject_sha256
sha256sum $A/ContinuationRegistrationSubjectAcceptance.json        # 5eb9c845… = 活行 registration_acceptance_sha256
sha256sum $A/ContinuationControlStoreAcceptance.json               # 89e4a851… = 活行 store_acceptance_sha256
sha256sum $A/ContinuationSubjectSignatureEvidence.json             # 954faff1… = 活行 signature_evidence_sha256
```

四个值与任务交待的实测活行一字不差，也与 `nw01-execution/NW01Parameters.json` 的
`postimage.binding` 一致。**摘要是「文件整字节的 sha256」，不是某个内部字段的摘要。**

规范化实测（`ContinuationRegistrationSubject.canonical.json`）：
`json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)` + 一个尾随 `\n`，
重新序列化后 **3320 字节、逐字节相同、sha256 相同**。本目录的 NW-02 主体件按同一规则产出，
同样验过 round-trip（4917 字节，逐字节相同）。
`blob_sha` 实测就是 `git hash-object`：`git hash-object $A/ContinuationRegistrationSubject.canonical.json`
→ `120fa16787d52d2aed6f9bfd54c6b516a92af423`，与 NW-01 证据件里记的一致。

## 2. 自指 / 循环怎么解 —— **没有循环，是一条严格的链**

这是任务点名要搞清的一条。答案是：**四份文书构成有向无环图，不存在自指。**

```
ContinuationRegistrationSubject.canonical.json
        │  （主体件不引用其余三份中的任何一份，也不含自己的摘要）
        ├────────────────────────────────┐
        ▼                                │
ContinuationRegistrationSubjectAcceptance.json   （引用 subject 的 path+sha256+bytes）
        │                                │
        ├────────────────────────────────┤
        ▼                                ▼
ContinuationControlStoreAcceptance.json  （引用 subject + registration acceptance）
        │
        ▼
ContinuationSubjectSignatureEvidence.json （引用上面三份的 path+blob_sha+sha256+bytes，不引用自己）
        │
        ▼
accepted_binding 的四个摘要字段（NW-02 事务写入）
```

两处**看起来**像循环、实际不是，都用 NW-01 的字节核过：

1. **「主体件里写了批准该主体件的合并」** —— 不是自指。主体件 `approval.owner_approval_commit`
   指的是**载体（授权文书）的合并**，NW-01 是 `cbe898d3`（PR 158）；而**装载主体件本身的合并**
   是另一个，NW-01 是 `3887b9e0`（PR 159），只出现在**证据件**里。两者不同，链不闭合。
   NW-02 同构：`owner_approval_commit = f92cd46e…`（M3 / PR 164，已合并），装载主体件的 M4 尚未开。
2. **「证据件记了三份文书的 blob_sha，而 blob 又来自装载它们的合并」** —— 证据件**不记自己的
   blob**。它是链上最后一环，先合并三份文书，再对那次合并取证，证据件自身随后入库/随后合并。

**真正的约束不是循环，是次序**（见 §4）。

## 3. 逐字段依据

### 3.1 主体件（`ContinuationRegistrationSubject.canonical.json`）

| 字段 | 值 | 依据 |
|---|---|---|
| `not_before` / `expires_at` | `2026-09-13T05:45:14Z` / `2026-09-14T05:45:14Z` | M3 载体 `window_rule.not_before_source` 第 34 行 = `VERIFIED_OWNER_MERGE_COMMIT_COMMITTED_AT`，+86400s。实测：`git log -1 --format=%cI f92cd46` → `2026-09-13T13:45:14+08:00` = `05:45:14Z`；GitHub API commit 对象 `committer.date` 同值 |
| `approval.owner_approval_commit` | `f92cd46e42e20e1fa305c573964e0597230c0b65` | `git rev-parse f92cd46`；PR 164 `merge_commit`，`merged_by=tdoljyj`，`merged_at=2026-09-13T05:45:14Z`（与 committed_at 差 0 秒） |
| `approval.approval_path` / `approval_sha256` | M3 载体 / `e1fcd30a…` | `git show f92cd46:…/ExplicitOwnerApprovalM3.candidate.json \| sha256sum`。**与 `f12-issuer/Root7*IssuerPurposeMetadata.candidate.json` 的 `authority_basis.actual_owner_approval_sha256` 同值** —— 即「取合并时的载体字节（含其占位符）」这一口径已有先例，不是本会话新造 |
| `approval.committer` / `merged_by` | `web-flow` / `tdoljyj` | GitHub API commit `committer.login`；PR 164 `merged_by` |
| `approval.verification` / `verification_ref` | **哨兵** | 见 §6 开放点 2 |
| `approval.proposal_path` / `proposal_sha256` | **哨兵** | 见 §6 开放点 3 |
| `current_control_root.*` | root6：seq 6 / `ctrgen_5e0440a9…` / ordinal 6 / `revoked=false` / `signed_object_sha256=95973246…` | **只读实测**（2026-09-13T06:04:42Z）：`current_head` 单行 seq=6 gen=`ctrgen_5e0440a9…`；ordinal 与 signed_object 取自 `events[sequence=6].request.body`（`generation_ordinal`=6，`signature_binding.signed_object_sha256`=`95973246…`）。**沿 NW-01 先例取活头，不取待注册代际** —— 见 §6 开放点 1 |
| `execution_baseline.sequence` | `89` | 只读实测 `execution_current.sequence`。**NW-01 是 88**，已前移一格；照抄会在第一个 DO 块失败 |
| `execution_baseline.charged_*` | `9906` / `2201594803` | 只读实测，与 NW-01 同值 |
| `execution_baseline.*_ceiling` | `10506` / `2335812531` | M3 载体 `budget_effect.charged_seconds_ceiling_unchanged` / `charged_evidence_bytes_ceiling_unchanged`；`forward_cap_extension.grants_additional_execution_capacity=false` |
| `execution_baseline.remaining_authorized_*` | `600` / `134217728` | M3 载体 `budget_effect.remaining_allocations_before_and_after=1`；10506−9906=600 |
| 九个冻结字段（`root_set_id`/`schema_sha256`/`protocol_mapping_sha256`/…） | 原值 | 只读实测活行；NW-02 不得改动（生成器 S2） |
| `window_maintenance.exception` | `NW-02` | M3 载体 `nw02` 条款（第 76 行起） |
| `window_maintenance.application_ordinal` | `5` | NW-01 为 4，本次为第五次施用 |
| `window_maintenance.changed_fields` / `changed_checks` | 七 / 三 | M3 载体第 80–96 行，与 NW-01 逐项相同 |
| `window_maintenance.guards_added_beyond_nw01` | 两条 | M3 载体第 110–113 行；**新增子键**，见 §6 开放点 1 |
| `window_generation_and_controller.*` | F12 `73c05cad…` + root7 `ctrgen_26769cc7…` | 任务交待；F12 值实测于 `bootstrap/root7-runtime-v20/ScopedRoot5FinalControllerQualification.json:5`，root7 代际见 M3 载体第 119 行。**整个顶层键是 NW-01 形态里没有的**，见 §6 开放点 1 |

### 3.2 前像（`nw02-parameters.json` 的 `preimage`）

两次只读 select，时刻 `2026-09-13T06:04:42Z` 与 `06:05:04Z`。**四个目录摘要全部与 NW-01 不同**：

| 项 | NW-01 钉的值 | 本次实测 |
|---|---|---|
| `rows_sha256` | `4c7cda83…` | `795f2159…` |
| `catalog_sha256` | `a19f3b5f…` | `6cef1483…` |
| `getter_definition_sha256` | `6cbfe002…` | `9b6518b9…` |
| `getter_prosrc_sha256` | `c721b056…` | `633269f1…` |

后三项变化的原因是 CP-01 在两窗之间替换了控制面函数。这四个值**再次说明前像必须重测**：
把 NW-01 的值抄过来，事务会在第一个 DO 块 fail closed —— 这是好事，但把它当成「候选已就绪」
就是错的。`rows_sha256` 覆盖 `events` / `execution_events` / `gate_attempts`，**只要有任何动作
它就变**，所以本参数文件里的前像是**给评审看形状的草稿基线**，标了 `MUST_REMEASURE_BEFORE_APPLY`。

不变的两项：`constraint_count=16`，`conname_digest=12b67839…`（十六个约束名未变）。
触发器实测：非内部触发器**恰好一个**，`accepted_binding_immutable`，`tgenabled='O'`，定义串与
NW-01 逐字相同。属主 `postgres`，ACL `{postgres=arwdDxtm/postgres}`。

## 4. 产出次序与依赖图

```
[已完成] M3 合并 f92cd46e (T=2026-09-13T05:45:14Z)
[已完成] F12 实化冻结 73c05cad / 九件按 F12 重出
    │
    ├─(a) 补出 M3 的 OwnerApprovalVerification 等价件  ← 开放点 2，主体件卡在这里
    ├─(b) 定 proposal_path                            ← 开放点 3
    ├─(c) 定主体件形态（多出来的顶层键留不留）           ← 开放点 1
    │
    ▼
[1] 主体件定稿 → subject_sha256 落定
    ▼
[2] 独立评审出具 ContinuationRegistrationSubjectAcceptance.json → registration_acceptance_sha256
    ▼
[3] 独立评审出具 ContinuationControlStoreAcceptance.json（引用 [1][2]）→ store_acceptance_sha256
    ▼
[4] M4：把 [1][2][3] 合并进 main（Owner 合并）
    ▼
[5] 生成器抓取 M4 取证 → ContinuationSubjectSignatureEvidence.json → signature_evidence_sha256
    ▼
[6] 重测活库前像 → 重跑 build-nw02-sql.mjs（**严格模式**，不带 --draft）
    ▼
[7] 独立评审审 NW02Applied.sql 的字节
    ▼
[8] 紧贴着跑 NW02Preflight.sql（17 条全 true，中间不插任何动作）
    ▼
[9] Owner 单独放行 → 执行 NW02Applied.sql → 另一会话只读回读并存档
    ▼
[10] 之后才是 root7 注册（M3 `nw02.ordering.nw02_before_generation_registration=true`，载体第 98 行）
```

**哪几份必须独立评审、哪几份生成器可出：**

- **必须独立评审**：`ContinuationRegistrationSubjectAcceptance.json`、
  `ContinuationControlStoreAcceptance.json`。两者的实质内容是**判断**（「这份主体件适合签署」、
  「这个事务形状可接受」），而主体件与事务都是本会话产出的。自出自受就是自证。
  两份骨架的 `decision` / `state` / `review_basis` / `review_independence` 一律留
  `__REVIEWER_TO_WRITE__`，**本会话没有替评审填一个字**。
  M3 载体经 `nw02.reuse_existing_reviewed_mechanism` 继承了 NW-01 的
  `fresh_independent_review_required_before_apply=true`。
- **生成器可出**：`ContinuationSubjectSignatureEvidence.json`。它每个字段都是对 GitHub API 响应
  的**量测**加仓库字节的摘要，没有判断成分，自出不构成自证。NW-01 的同名件就是
  `work/twentieth-forward/capture-owner-merge.mjs` 出的。但它**必须等 M4**。
- **附带说明**：`NW02Applied.sql` / `NW02Preflight.sql` 生成器可出，但**执行前必须独立评审字节**
  （NW-01 是 R11 第 8 步，收据 `authorisation.independent_review`）。

**哪些必须等 M4 才拿得到：** 证据件的 `merge.sha` / `merge.tree` / `merge.parents`、`pr.*`、
三份文书的 `blob_sha`（GitHub blob API 的 uri 形态要求 blob 已在远端）、`api_bundle_sha256`、
以及 `merge.verification.{verified,reason,verified_at}`。骨架里这些全部是 `__PENDING_M4_*__`。

## 5. 自验与可失败演示

「不可能失败的验证」已十五例。本会话的生成器有 14 条自验断言，**每条都演示了一次可失败路径**：

```sh
node artifacts/.../nw02/build-nw02-sql.mjs --demo-falsifiability
```

实测输出（14/14，退出码 0）：每条 `--tamper=<id>` 只污染该条断言读的那一个输入，
生成器随即以该条断言自己的 id 拒绝。S12 的演示同时证明了严格模式确实拦得住骨架。

**本轮新发现一条「不可能失败的验证」（第 16 例），已修正并留在代码里：**

`build-nw01.mjs` 与本生成器都有一句 `postimage.owner_approval_commit !== preimage.owner_approval_commit`
（「还是上一个批准提交」）。它**永远不可能是先报错的那一条**：把它设回前像值，七个可变字段就只
变了六个，`S3` 先拦。首次演示时 `--tamper=S6` 吐出的正是 `[S3]` 而不是 `[S6]`——这就是证据。
处理：把 S6 的 tamper 改成非 40-hex 值（现在演示的是格式子句，确实由 S6 拒绝），并在源码里把那句
标注为 **NOT INDEPENDENTLY FALSIFIABLE**、说明它只作 S3 被削弱时的纵深防御、**不得计作一条守卫**。
`work/nw01/build-nw01.mjs` 里的同一处冗余同样存在，本会话没有去改它（NW-01 已执行完毕，改它属于
扩大改动）。

**生成的 SQL 里新增的两族守卫（M3 载体第 110–113 行要求）：**

| 守卫 | 出处 | 位置 | 实测行号（`NW02Applied.sql`） |
|---|---|---|---|
| 窗口断言 `clock_timestamp()` 在 `[T, T+86400)` | R11-F12 | 前块 + 后块 | 51 / 207 |
| 非内部触发器**恰好一个** | R11-F13 | 前块 + 后块 | 129 / 260 |
| 那一个触发器**就是我们的** | R11-F13 | 前块 + 后块 | 134 / 265 |

R11-F12 的由来实测在 `NW01ExecutionReceipt.json:48`：十六条守卫里只有它随时间翻转，而它**不在事务里**，
当时靠「紧贴着跑 preflight」的操作纪律顶住。R11-F13 的由来在同文件 `:76`：NW-01 校了所指触发器的
定义和启用状态，但没人拦得住**第二个**非内部触发器存在；收据当时自己写明「这条断言仍然该进事务」。
`NW02Preflight.sql` 也补了对应的只读列 `sole_non_internal_trigger_ok`（第 56 行），守卫数从 16 → 17。

生成器另有两条**对渲染结果本身**的检查（不是对参数）：S13 数守卫在两块里各出现一次，
S14 断言写入侧不含任何前像摘要、前置块不含任何后像摘要。二者都各自演示过可失败路径。

## 6. 我拿不准的点 —— 列出来，不拍板

### 开放点 1：主体件的形态该不该动（**影响 subject_sha256，进而影响全部四个摘要**）

任务交待「代际相关处指向 root7 `ctrgen_26769cc7…`，控制器摘要用 F12」。照办时撞上两件事：

- **NW-01 的 `current_control_root` 指的是活头，不是待注册代际。** 实测：NW-01 执行时活头是 root5
  （`NW01Parameters.preimage.head.generation_id = ctrgen_e5df4322…`），主体件 `current_control_root`
  写的就是 root5；而那一窗里随后注册的是 root6。**同构地，NW-02 的活头是 root6**（只读实测 seq 6 /
  `ctrgen_5e0440a9…`），root7 要到第 [10] 步才注册。把 `current_control_root` 写成 root7 会
  与同一份候选里 `NW02Preflight.sql` 的 `root_head_ok` 守卫**自相矛盾**。
- **NW-01 形态里根本没有控制器摘要字段。** 我比对了 `next-window-20260911` 与 `next-window-20260912`
  两版主体件，**顶层键集合完全相同**（21 个）。两窗未变的形态，本窗要不要变，不该由起草方定。

我采取的处置（**请评审推翻或确认**）：`current_control_root` 保持活头 root6 不动；另加**一个**顶层键
`window_generation_and_controller`，装 F12 摘要、root7 代际与序数、两份 f12-issuer 件与两份
root7-runtime-v20 件的 path+sha256，并显式写 `generation_registered_by_this_subject: false`、
`nw02_precedes_generation_registration: true`。顶层键因此是 **22 个**。
另在 `window_maintenance` 下加了 `guards_added_beyond_nw01` 子键。

三个可选方案与代价：

| 方案 | 形态 | 代价 |
|---|---|---|
| A（本稿） | 21 + 1 顶层键 | 两窗稳定的形态被打破，须评审背书 |
| B | 严格 21 键，F12/root7 不进主体件 | 与任务交待不符；F12 与 root7 只在 SQL 与参数件里出现，主体件不自述本窗代际 |
| C | 21 键，但把 root7/F12 塞进 `current_control_root` | **我认为不可取**：它会写下一个当时并不成立的事实，且与 preflight 的 `root_head_ok` 冲突 |

无论选哪个，**subject_sha256 都不同**，链上三份都要重出。**我没有权限替这件事定案。**

### 开放点 2：M3 没有 `OwnerApprovalVerification.json` 的等价件（**硬阻塞**）

NW-01 主体件的 `approval.verification` = `"verified:true;reason:valid"`，
`approval.verification_ref` 指向 `next-window-20260912/OwnerApprovalVerification.json`（sha `69e84e74…`）。
`next-window-m3/` 下**没有**对应文件，`find` 全仓也没有。

我拿不到的那一项：**`commit.verification.verified` / `.reason`**。本会话可用的
`get_commit` 工具返回的提交对象里**不含 `verification` 子对象**，我没有别的只读途径去量它。
`committer.login=web-flow`、`author.login=tdoljyj`、`committed_at`、PR 164 的 `merged_by` / `merged_at`
我都量到了并写进了参数件的 `window.source_measurement`，但**签名是否 verified 我没有量到，就不写**。

所以主体件里这三处是哨兵：`__PENDING_M3_MERGE_VERIFICATION_STRING__`、
`__PENDING_M3_OWNER_APPROVAL_VERIFICATION_PATH__`、`__PENDING_M3_OWNER_APPROVAL_VERIFICATION_SHA256__`。
**须先补出这份取证件**（照 NW-01 的 `work/twentieth-forward/capture-owner-merge.mjs` 世系），
主体件才谈得上定稿。

### 开放点 3：`proposal_path` / `proposal_sha256` 指哪一份

NW-01 指向同目录的 `OwnerApprovalProposal.md`（sha `c760f73b…`）。M3 没有同名件。候选有三：

| 候选 | sha256 | 我的看法（仅供参考） |
|---|---|---|
| `root6-capacity/NextWindowPlanV2Window12Cycle.md` | `73489f68fccb2a98b23fd8ac362d2b600f4e946584eb210176b48dc5ed3f8cb6` | M3 载体反复以它为「源表」，最接近「提案」的角色 |
| `bootstrap/next-window-m3/M3DraftNotes.md` | `eb025d4dbdad4ffbae43115cff905f93280715d30f4584f5314bcec6b50cc9e6` | 是起草说明，不是向 Owner 的提案 |
| PR 164 的正文 | 无仓内字节 | 内容上最像提案，但**不是仓库对象，取不到稳定摘要** |

留哨兵，未选。

### 开放点 4：证据件的 `approved_window` 写哪一个窗

NW-01 的证据件 `approved_window` 写的是 **M 合并（PR 159）的时刻** `07:18:16Z…`，
而同窗 `accepted_binding` 写的是 **M1 合并（PR 158）的时刻** `07:05:16Z…`，两者差 13 分钟，
证据件自己在 `merge_timestamps.why` 里把这个差记了下来而不当失败。
NW-02 里 M3 与 M4 是两次合并，差值现在无法预知。骨架里两处都留了 `__PENDING_M4_*__`，
并把这条写进了骨架的 `approved_window.note`。**该沿 NW-01 写 M4 窗、还是改写 M3 物化窗，未定。**

### 开放点 5：`nw02-parameters.json` 里的 `subject_signature_merge` 是空的

NW-01 的参数件有 `subject_signature_merge.commit = 3887b9e0` / `pr = 159`。NW-02 的 M4 还没开，
所以是 `__PENDING_M4_*__`。这不是疏漏，是次序使然（§4 第 [4] 步）。

### 顺带量到、但不属 NW-02 管辖的一条（交给注册体的人核）

只读实测：`events` 共 6 行，`sequence` 为 **1..6**，第 6 行 `idempotency_key=register-root6-window11-20260912`、
`kind=GENERATION_REGISTERED`、`generation_ordinal=6`；而**该行 request 里的 `expected_sequence` 是 5**。
也就是说 `expected_sequence` 记的是**追加前的头序号**。据此 M3 载体第 124 行给 root7 写的
`expected_sequence: 6` 与活库状态**是对得上的**（我一开始怀疑它差一，量完发现不差）。
唯一仍存疑的是同一条款第 146 行 `history_prefix_sequence: 6` 配的那句
「canonicalDigest over live root events **0..6**」——活库里没有 sequence 0。这可能只是对一个 6 元
数组下标的写法，也可能不是。**不是 NW-02 的事，我不改也不断言**，只把量到的摆在这里。

## 7. 可复现命令

```sh
cd <repo> && git checkout claude/nice-fermat-njqlmm
D=artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/nw02

sha256sum $D/*.json $D/*.sql            # 对上 §0 的表
node $D/build-nw02-sql.mjs              # 严格模式：必须拒绝（S12），退出码 1
node $D/build-nw02-sql.mjs --draft      # 重出两个 SQL，字节应与已提交的一致
node $D/build-nw02-sql.mjs --demo-falsifiability   # 14/14，退出码 0
```

只读 select 的原文见 `nw02-parameters.json` 的 `preimage`，两次时刻分别是
`2026-09-13T06:04:42Z`（活行 / 头 / 执行 / 约束 / 触发器 / 属主）与
`2026-09-13T06:05:04Z`（rows、catalog、getter 四摘要 + events 列表）。
