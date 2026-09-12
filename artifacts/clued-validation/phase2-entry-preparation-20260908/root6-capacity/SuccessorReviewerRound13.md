# 继任独立评估者 · 第十三轮复核：最终注册体

**评估者身份：`/root/project_list_auth_fix`（与第八至十二轮同一身份）。**
**议题：root6 最终注册体的独立评审。实施方分支 `claude/nice-fermat-njqlmm`，HEAD `1157856`（`9927fc8` 之后新增一条 Owner 次序修订）。`main` = `2c3a6f9`。**

---

## 结论前置：**不通过。我不签发受理。**

**阻断项一条，编号 R13-F3：`signature_binding.signature_evidence_ref` 指向了一份不证明本代签名的文件。**

该字段指向 `ContinuationSubjectSignatureEvidence.json`，而这份文件：
- 证明的是 **Owner 合并 2**（`3887b9e0…`，PR #159），而同一个 `signature_binding` 里的 `owner_merge_commit` 写的是 **Owner 合并 1**（`cbe898d3…`，PR #158）；
- 自述 `kind = EXACT_NW01_CONTINUATION_SUBJECT_SIGNATURE_EVIDENCE`，即 NW-01 续延主体的签名证据，不是代际注册的；
- 自述 `approved_window` = `07:18:16Z .. 07:18:16Z`，**不是** root6 的窗口 `07:05:16Z .. 07:05:16Z`；
- 自述 `authority_effect = NONE_UNTIL_EXACT_NW01_TRANSACTION`，其效力已随 NW-01 用尽。

**这正是第十二轮 R12-F18 里实施方自己拒绝犯的那个错误，只是换了一个字段。** 当时它拒绝把 `independent_acceptance_ref` 指向 `ContinuationRegistrationSubjectAcceptance.json`，理由是「那份文件受理的是续延主体、不是代际注册」，判断完全正确。这一次，`signature_evidence_ref` 指向了同一族文件中的另一份，犯的是同一个形状的错误。

**好消息：正确的那份文件已经在 `main` 里，不需要第四次合并。** 见 R13-F3 第 4 小节。修法只改两个字段、不需要重跑窗口、**且不使我第十二轮的受理失效**（R13-F4 实测：`293da3c5…` 与 `95973246…` 两个值都不变）。

除这一条外，**其余六问全部通过**，包括我逐字节复算的两个新字段中的另一个、被受理主体的完整性、Owner 合并 3 的合格性（含实施方看不到的 `verification` 那一条）、`append_event` 的全部前置条件，以及注册后控制器读取路径的模拟。

---

## 零、取证方式与边界

复核时刻：**2026-09-12 09:44Z – 09:57Z**。

1. **数据库**：全部经 `execute_sql` 的只读 `select`，共 11 次。**没有 `insert`/`update`/`delete`/任何 DDL、没有 `apply_migration`、没有执行任何 `do $$ … $$` 块（含 CP-01 候选里的）。** 只读函数中只调了 `read_execution()` 与 `read_root()`。
2. **未调用**：`append_event`、`reserve_gate`、`reserve_execution_budget`、`append_status_manifest`、`rotate_execution_generation`、`commit_gate_result`、`execution_transition`、`record_effect_intent`、`dispatch_recorded_intent` —— 一次都没有。
3. **一次 GUC 读法说明**：为测 R13-F12 的时区依赖，我用了一次 `set_config('TimeZone','Asia/Shanghai', true)`，**第三个参数 `true` 表示事务内生效**，语句结束即还原。它只改会话参数、不触碰任何数据。复核结束时实测 `TimeZone` 仍为 `UTC`。
4. **离线取证面**：我在会话临时目录里用 `git archive impl | tar -x` 做了一份独立仓库副本，在该副本的 `apps/clued-cloud` 下 `npm install ajv@6.15.0`，在其中运行实施方的 `build-root6-registration.mjs` 与控制器模块。**实施方检出的任何文件未被修改**（复核结束时 `git status` 干净）；敌意测试产生的一个杂散文件已删除并复查。
5. **不采信实施方的输出**：两个新字段的摘要、`prefix_digest`、`predecessor`、`event_set_digest`、`signed_object_sha256`，**全部由我另写的一份 Python canonical 实现独立算出**，再与控制器的 JS 实现交叉核对。快照的同一性由**在数据库内部计算的** sha256 闭合，不是比对文件。

**复核结束时实测（09:56:46Z，`TimeZone=UTC`）**：`charged_seconds` = **9906**、`charged_evidence_bytes` = 2201594803、`execution_current.sequence` = **88**、`execution_events` = **88**、`active_ga_id` = null、`pending_budget_sequence` = null、`clued_control.events` = **5** 行、head 仍 **root5** `ctrgen_e5df4322…`、`root.state` = `STORED_NO_GATE_AUTHORITY`、窗口 `2026-09-12 07:05:16+00 .. 2026-09-13 07:05:16+00`。
**未注册任何代际、未消耗那唯一一次分配、未写库。**

**标注约定**：每条标 **【实测】**（我自己跑出来/量出来的）或 **【读文本】**（只从文本推断）。

---

## 一、第（1）问：那两个我没看过的字段

### R13-F1 ──【实测】`independent_acceptance_ref`：指向对、摘要对、可从 `main` 解析。**通过。**

| 【实测】项 | 值 |
| --- | --- |
| `uri` 末段 blob sha1 | `44a637b870efcfb989f33009f0353512b5fdf7d0` |
| 该 blob 在 `main` 的路径 | `…/root6-capacity/Root6RegistrationAcceptance.json` ✅ |
| 我用 `git cat-file blob` 量出的 sha256 | **`5996ab3efe2b826307cd19dce7d176b5854a40c59c7892e804dde3ad331ac45f`** |
| 注册体所记 `sha256` | 同 ✅ |
| 该 blob 的字节数 | 7286 |

**一条比「在 `main` 里」更强的证据【实测】**：该 blob 在**我的分支**、**实施方分支**、**`main`** 三处是**同一个 git 对象**（`44a637b8…`），不是三份内容相同的副本。**即我第十二轮签发的那份受理，一个字节都没有被改过就进了 `main`。** 这正是第十二轮 R12-F21「缺件二」要求的形状，且比要求的更干净。

我同时复核了第十二轮那条不变式在第六代是否成立：**`independent_acceptance_ref` 必须指向一份 `review_subject_sha256` 等于该代 body 的 `reviewSubjectDigest` 的文件。**
【实测】`reviewSubjectDigest(最终体 body)` = `293da3c5…`，而 `44a637b8…` 那份受理自述的 `review_subject_sha256` 正是 `293da3c5…`。**第六代成立，五代 5/5 的不变式延续为 6/6。** ✅

### R13-F2 ──【实测】`signed_object_sha256`：计算口径对，值对。**通过。**

【实测】控制器 `root-window-validation.mjs:26`：

```js
export function signaturePayloadDigest(root){const value=structuredClone(root);
  delete value.signature_binding; return canonicalDigest(value);}
```

**只删 `signature_binding` 一个键，不删 `independent_acceptance_ref`。** 这与 `:25` 的 `reviewSubjectDigest`（两个键都删）是**不同的口径**，必须分清。注册体的 `algorithm_config.signed_payload_excluded_fields: ["signature_binding"]` 与之一致。

| 【实测】项 | 值 |
| --- | --- |
| 我的 Python 实现算 `signaturePayloadDigest(body)` | **`95973246e3ae8d33fe407960d41e47039399575c59b4f78f83882835e73d9f80`** |
| 控制器 JS 实现算同一值 | **同** ✅ |
| 注册体所记 `signed_object_sha256` | **同** ✅ |

**我做了一次判别性检验，确认这两个口径不会被混淆过去【实测】**：若误用 `reviewSubjectDigest` 的口径（连 `independent_acceptance_ref` 一起删）来算，得到的是 `293da3c5…`。二者取值明显不同，且 `validateRootShape:36` 会当场抛异常。**实施方用的是对的那一个。** ✅

### R13-F3 ──【实测】**`signature_evidence_ref` 指向错误的文件。本轮唯一阻断项。**

#### 1. 指向的是什么

| 【实测】项 | 值 |
| --- | --- |
| `uri` 末段 blob sha1 | `fcddb0acee7056435117fdefdccce55ed5ad1bdc` |
| 该 blob 在 `main` 的路径 | `…/next-window-20260912/ContinuationSubjectSignatureEvidence.json` ✅ 可解析 |
| 我量出的 sha256 | **`954faff130549cebbc6453957d3e86196f8e0c8dd551040bb20e4f9ffb6ed614`** |
| 注册体所记 `sha256` | 同 ✅ |

**即：blob 存在、摘要算对了。错的不是指针的完整性，是指针的对象。**

#### 2. 它与同一个 `signature_binding` 里的 `owner_merge_commit` 自相矛盾

| 【实测】项 | 值 |
| --- | --- |
| 注册体 `signature_binding.owner_merge_commit` | `cbe898d3f5b66f279d78a6b8d583d2c1885d9c89`（Owner 合并 1，PR #158） |
| 被指向文件的 `merge.sha` | **`3887b9e0a2c4e667823031a5294b8d2921fc8d46`（Owner 合并 2，PR #159）** |
| 被指向文件的 `kind` | **`EXACT_NW01_CONTINUATION_SUBJECT_SIGNATURE_EVIDENCE`** |
| 被指向文件的 `approved_window` | **`2026-09-12T07:18:16Z .. 2026-09-13T07:18:16Z`** |
| 注册体 body 的窗口 | `2026-09-12T07:05:16Z .. 2026-09-13T07:05:16Z` —— **不同** |
| 被指向文件的 `authority_effect` | `NONE_UNTIL_EXACT_NW01_TRANSACTION` |

**一个 `signature_binding` 子对象，自称由合并 1 签署，却附上一份证明合并 2 的证据，且该证据自述的窗口与本体的窗口差了 13 分钟。**

#### 3. 这打破了一条五代全部成立的不变式

**不变式：`signature_binding.signature_evidence_ref` 必须指向一份证明「同一个 `signature_binding.owner_merge_commit`」的文件。**

我把这条不变式在全部六代上跑了一遍（做法与第十二轮 R12-F18 相同：从我自己的库内快照取出每代 body，解析 blob sha1 到仓库文件，读出该文件自述的 `merge.sha`）：

| 代 | `owner_merge_commit` | 被指向的文件 | 文件的 `kind` | 文件证明的 merge | 相符 |
| --- | --- | --- | --- | --- | --- |
| 1 | `f47fbae1…` | `IndependentFirstRootPayloadSignatureBinding.json` | `ROOT_SIGNING_PAYLOAD_SIGNATURE_BINDING` | `f47fbae1…` | ✅ |
| 2 | `21bf9c07…` | `IndependentRootGeneration2PayloadSignatureBinding.json` | `ROOT_SIGNING_PAYLOAD_SIGNATURE_BINDING` | `21bf9c07…` | ✅ |
| 3 | `483c278f…` | `NextWindowRootAndNWSignatureEvidence.json` | `ROOT_SIGNING_PAYLOAD_SIGNATURE_BINDING` | `483c278f…` | ✅ |
| 4 | `eabf6500…` | `Root4SignatureEvidence.json` | `ROOT4_SIGNING_PAYLOAD_SIGNATURE_EVIDENCE` | `eabf6500…` | ✅ |
| 5 | `30b85564…` | `Root5SignatureEvidence.json` | `ROOT5_SIGNING_PAYLOAD_SIGNATURE_EVIDENCE` | `30b85564…` | ✅ |
| **6** | **`cbe898d3…`** | **`ContinuationSubjectSignatureEvidence.json`** | **`EXACT_NW01_CONTINUATION_SUBJECT_…`** | **`3887b9e0…`** | ❌ |

**五代 5/5 成立，第六代是第一次断裂。** 顺带：前五代的 `kind` 全部是 `ROOT*_SIGNING_PAYLOAD_SIGNATURE_*` 形态，第六代指向的是 `*_NW01_CONTINUATION_SUBJECT_*` 形态 —— **连命名族都不是同一类。**

#### 4. 正确的那份文件已经在 `main` 里

【实测】我在三条分支上检索了全部提及 `cbe898d3…` 的 JSON，找到 `…/next-window-20260912/OwnerApprovalVerification.json`：

| 【实测】项 | 值 | 与注册体相符？ |
| --- | --- | --- |
| `kind` | `VERIFIED_OWNER_CONTINUATION_APPROVAL` | — |
| `merge.sha` | **`cbe898d3f5b66f279d78a6b8d583d2c1885d9c89`** | ✅ **= `owner_merge_commit`** |
| `merge.verification.verified` / `reason` | **`true`** / `valid` | ✅ |
| `merge.author_login` / `committer_login` | `tdoljyj` / `web-flow` | ✅ |
| `fixed_window` | **`2026-09-12T07:05:16Z .. 2026-09-13T07:05:16Z`**，86400 秒，非滚动 | ✅ **= body 的窗口** |
| `approval_artifacts.approval.blob_sha` / `sha256` | `71bf5384…` / `457e32b0…` | ✅ **= body 的 `owner_approval_ref`** |
| 在 `main`？ | **是**，blob `cad73582f879ed77df94edc13f23af1ebb95fc4d` | ✅ |
| 我量出的 sha256 | **`69e84e741814765067e81dfa5842f46d9887cea2a3c149fc03b422b7bd51cfc1`** | — |

**这份文件在四个可测维度上与注册体对齐：合并 sha、窗口两端、批准件 blob、批准件 sha256。被实际引用的那份在四个维度上全部不对齐。**

**一条旁证，来自实施方自己的文件【实测】**：`work/cp01/cp01-substitutions.json` 的 `window_placeholder_resolution` 把窗口 `T` 的来源写成 `owner_merge: cbe898d3…`，并把 `evidence` 明确指向 **`OwnerApprovalVerification.json`**。**实施方在 CP-01 里用对了这份文件，在注册体里用错了。** 这支持「这是一次取件失误，不是一个有意的语义选择」。

#### 5. 后果与严重性

**等级：阻断。** 理由不是文书洁癖，而是与 R12-F18 完全相同的那一条：

- `append_event` **不校验 body**（我读了线上 `prosrc`，`:13` 只验 `jsonb_typeof(p->'body')='object'`）。这份体写进去就永久烧掉 `ctrgen_5e0440a9…`。
- **控制器事后也抓不到它**（R13-F4）：`signaturePayloadDigest` 把整个 `signature_binding` 删掉，所以 `signed_object_sha256` **不承诺** `owner_merge_commit`，也**不承诺** `signature_evidence_ref`。【实测】我把 `signature_evidence_ref` 换成正确的 `OwnerApprovalVerification.json` 后重算，`signed_object_sha256` **仍是 `95973246…`，一位不变**。
- 因此这不是一个「写错了将来会被拒绝」的错误，而是一个**写错了永远不会被机器发现**的错误 —— 它会作为第六代的永久记录留在链上，并成为第七代 `predecessor.sha256` 所哈希的内容的一部分。**唯一能拦住它的就是这一道人工评审。**

#### 6. 修法（成本极低）

把 `signature_evidence_ref` 改为：

```json
{ "uri": "https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/cad73582f879ed77df94edc13f23af1ebb95fc4d",
  "sha256": "69e84e741814765067e81dfa5842f46d9887cea2a3c149fc03b422b7bd51cfc1" }
```

**【实测】改后三项全部不变**：
- `reviewSubjectDigest` = `293da3c5…` —— **我第十二轮的受理不失效**；
- `signed_object_sha256` = `95973246…` —— 不需要重算（该字段本就不含 `signature_binding`）；
- `validateRootShape` 仍返回 `SHAPE_VALID_ONLY`。

**不需要第四次 Owner 合并**（目标 blob 已在 `main`）。**不需要重开窗口。**

**我保留一个次选方案供 Owner 裁量**：用 `work/twentieth-forward/capture-owner-merge.mjs` 针对 `cbe898d3…` 生成一份专名的 `Root6SignatureEvidence.json`，使 `kind` 也回到前五代的 `ROOT*_SIGNING_PAYLOAD_SIGNATURE_*` 族。**但这需要第四次合并，在剩余约 21 小时里是不必要的代价。** 我认为**首选方案（指向 `OwnerApprovalVerification.json`）已经闭合了全部可测维度**，`kind` 的命名差异不构成语义错误 —— 它确实是一份「已验证的 Owner 合并证据」。

### R13-F4 ──【实测】一条结构性观察：`signature_binding` 不被自己包含的摘要约束。

`signaturePayloadDigest` 删掉整个 `signature_binding`，而 `signed_object_sha256` 就住在 `signature_binding` 里面。**于是 `owner_merge_commit` 与 `signature_evidence_ref` 这两个字段，不被本体系中任何一个摘要承诺。**

这不是本轮引入的，五代皆然，且 `validateRootShape` 返回的 `signature_verified: false` 已经如实披露了这一点。**我不记为缺陷，记为一条必须写进评审结论的事实**：这两个字段的正确性**只能**靠外部解析核验，而 R13-F3 正是这道核验第一次抓到东西。

---

## 二、第（2）问：被受理的那部分有没有被动过

### R13-F5 ──【实测】**没有被动过。而且我验的比「摘要相同」更强。**

实施方声称最终体删掉两个字段后仍摘要为 `293da3c5…`。我没有采信，自己算了三遍：

| 【实测】项 | 值 |
| --- | --- |
| 我的 Python canonical 实现算 `reviewSubjectDigest(最终体 body)` | **`293da3c512f63a9b1f7b3d07fa3282975917cac3bb94ccf831f03707bb3b572b`** ✅ |
| 控制器 JS 实现算同一值 | **同** ✅ |
| 第十二轮我受理的值 | **同** ✅ |
| 我算 `canonicalDigest(已提交的评审主体文件)` | **同** ✅ |

**更强的一条**：我不只比对摘要，还比对了**规范化字符串本身**。
【实测】把最终体 body 去掉 `signature_binding` 与 `independent_acceptance_ref` 之后，与已受理的 `Root6RegistrationReviewSubject.json`（3764 字节，文件 sha256 `06b5135a…`）：

- **键集完全相同**；
- **`canonical()` 输出的字符串逐字符相同**（不是靠摘要相等反推，是直接比较了两个字符串）。

**判定：受理仍然有效。两个新字段是纯增量，被受理的 18 个键一个字节都没动。** ✅

**一条独立的交叉证据【实测】**：我在独立副本里用**我自己的快照**、按诚实参数重跑了 `build-root6-registration.mjs` 的可提交路径，产出与已提交的 `Root6GenerationRegistration.candidate.json` **逐字节相同**（双方 sha256 均为 `372867f6ca6ee5e69aa6ca236ff47eb000ed09f9d91ab2398c89c81d0278a2a5`，5538 字节）。**即这份体确实是那个脚本从那个快照产出的，不是手改出来的。**

---

## 三、第（3）问：Owner 合并 3 是不是一次合格的已验证 Owner 合并

### R13-F6 ──【实测】**是。并且我补上了实施方看不到的那一条。**

实施方自陈其工具未返回 `verification` 字段，所以这一条它没看到。我用 GitHub API 直接取了完整的 commit 对象：

| 【实测】项 | 值 | 判定 |
| --- | --- | --- |
| commit sha | `2c3a6f9d2c654614b0e5198658c8f03e32f36790` | = `main` HEAD ✅ |
| **`commit.verification.verified`** | **`true`** | ✅ **这就是实施方缺的那一条** |
| **`commit.verification.reason`** | **`valid`** | ✅ |
| `verification.verified_at` | `2026-09-12T09:30:13Z` | ✅ |
| `author.login` | **`tdoljyj`**（Owner 本人） | ✅ |
| `commit.committer` | `GitHub <noreply@github.com>`（web-flow） | ✅ 与前五代同一签署路径 |
| 提交信息 | `Merge pull request #161 …「Owner merge 3: make the round-12 acceptance and the signature evidence referenceable from main」` | ✅ 与其宣称用途一致 |
| parents | `03f50199…`（原 `main`） + `9f5b6ff5…`（实施方分支） | ✅ 是一次真正的两亲合并，不是快进 |

**我另用本会话自己的 `git` 对象独立核了签名存在性**：该 commit 带 PGP 签名，签署密钥 `B5690EEEBB952194`（GitHub web-flow 的 RSA 密钥）。本容器无该公钥，故 `git` 本身无法判定有效性 —— **这正是为什么 `verification.verified` 这一条必须从 API 取，而不能只靠本地 `git` 说了算。** 我记为【实测】，来源是 GitHub API。

#### 两个 blob 能否从合并后的 `main` 解析

| 【实测】blob | 在 `main` 的路径 | 结果 |
| --- | --- | --- |
| `44a637b870efcfb989f33009f0353512b5fdf7d0` | `…/root6-capacity/Root6RegistrationAcceptance.json` | ✅ 可解析 |
| `fcddb0acee7056435117fdefdccce55ed5ad1bdc` | `…/next-window-20260912/ContinuationSubjectSignatureEvidence.json` | ✅ 可解析 |

**两个都能解析。**（第二个虽然能解析，但指向它是错的 —— 见 R13-F3。这两件事互相独立：R13-F3 不是「blob 找不到」，而是「找到的不是该找的那份」。）

#### 一条我额外查的：合并 3 是不是纯增量

【实测】`git diff 03f50199 → main`：19 个文件，2677 增 / 2 删。
**其中 `artifacts/` 下的 11 个文件全部是新增（`A`），没有一个是修改（`M`）或删除（`D`）。** 被修改的 4 个全在 `work/` 下（`cp01/*` 三个与 `build-root6-registration.mjs`），属工作脚本，不是已被受理的证据件。

**判定：合并 3 没有改写任何既有证据，是一次合格的、纯增量的、已验证的 Owner 合并。** ✅

---

## 四、第（4）问：R12-F9 / R12-F11 到底闭没闭 —— 敌意测试，不只读代码

### R13-F7 ──【实测】**两条都真闭了。我用实际运行确认，不是读代码。**

先确认守卫写在了够得到的地方【实测】：`assertNoPlaceholder` 定义在 `:120`（两条分支之外），`:276` 在 PENDING 分支对 `reviewSubject` 调用，**`:308` 在可提交分支对 `request` 调用，位置在 `:311` 写文件之前**。方向正确。

但读代码不算数。我跑了：

| # | 【实测】测例 | 结果 |
| --- | --- | --- |
| B1 | 诚实的可提交运行（4 尾参 + 输出路径） | **ACCEPTED**，产出与已提交候选**逐字节相同** ✅ |
| T5 | **可提交路径** + `iaBlob`/`iaSha` 全 0（**R12-F9 原缺陷**） | **REFUSED** `PLACEHOLDER_PASSED_FOR_iaBlob_WHICH_MUST_BE_A_REAL_REFERENCE` ✅ |
| T6 | 可提交路径 + `seBlob`/`seSha` 全 0 | **REFUSED** `PLACEHOLDER_PASSED_FOR_seBlob…` ✅ |
| T6b | 可提交路径 + `oaBlob` 全 0 | **REFUSED** `PLACEHOLDER_PASSED_FOR_oaBlob…` ✅ |
| T2 | `--acceptance-pending` + **恰好 3 个尾参**（**R12-F11 原漏洞**） | **REFUSED** `OUTPUT_PATH_LOOKS_LIKE_A_BLOB_SHA1_SO_AN_ARGUMENT_HAS_SHIFTED` ✅ |
| T1 | `--acceptance-pending` + 4 个尾参 | **REFUSED** ✅ |
| T9 | 可提交路径 + 3 个尾参 | **REFUSED** ✅ |
| T10 | 可提交路径 + 6 个尾参 | **REFUSED** ✅ |
| — | 被拒的 7 次是否留下任何产物文件 | **一个都没有** ✅ |
| H4a | 快照的 head 已是 root6（重复注册） | **REFUSED** `HEAD_IS_NOT_ROOT5 — has root6 already been registered?` ✅ |
| H4b | 快照被截断到 4 个事件 | **REFUSED** `REGISTRATION_COUNT_DIFFERS_FROM_PINNED_READ` ✅ |

**R12-F9 与 R12-F11 均已闭合，且闭合方式是对的**：`assertNoPlaceholder` 现在作用在 `request`（真正会被写出的对象）上，参数个数判据从 `rest.length > 3` 改成了按预期形状白名单（PENDING 下 2 或 3，可提交下 4 或 5）。

### R13-F8 ──【实测】**但仍有四种传参方式能产出一份指向假引用的可提交请求。**

派工明确问：「有没有哪种传参方式仍能产出一份指向假引用的可提交请求？」**答案是有，我跑出来了四种。**

| # | 【实测】测例 | 结果 | 产出的引用 |
| --- | --- | --- | --- |
| **H1** | `iaBlob`/`iaSha` 传**格式合法但虚构**的值（`deadbeef…`，该 blob 不存在） | **ACCEPTED，产出完整可提交请求** ⚠️ | `independent_acceptance_ref` → `deadbeef…` |
| **H2** | **ia 对与 se 对整体对调**（两对都是真值，只是位置互换） | **ACCEPTED，产出完整可提交请求** ⚠️ | ia → `fcddb0ac…`，se → `44a637b8…`（**交叉接错**） |
| **H3** | 输出路径传一个 **64 位十六进制**串 | **ACCEPTED**，写到一个以 sha256 命名的文件 ⚠️ | 内容正确，落点错误 |
| **H4c** | 快照的 `metadata_binding_sha256` 被篡改 | **ACCEPTED，产出完整可提交请求** ⚠️ | `metadata_binding_sha256` 为假值 |

**逐条判定：**

- **H1 —— 守卫的维度选窄了。** 新加的检查只拦**全 0** 这一个特定串（`assert.ok(v !== NON_VALUE_BLOB && v !== NON_VALUE_SHA)`）。任何其他格式合法的十六进制串照过。**它是一个占位符探测器，不是一个引用校验器。** 脚本从头到尾**没有任何一处去确认被引用的 blob 真的存在、或其内容的 sha256 真的等于所传的值** —— 而这恰恰是 R13-F3 那条阻断项所在的维度。
- **H2 —— 这是最值得担心的一条，因为它是最像会真实发生的操作失误。** 两对参数结构上完全可互换（都是 `<40位hex> <64位hex>`），相邻、同形、无标记。第十二轮 T4 测过**对内**顺序颠倒（sha256 在前），被正则拦下了；**对间**整体对调则毫无阻碍。**而 R13-F3 这次抓到的错误，恰好就是 `signature_evidence_ref` 取错了文件** —— 同一个字段，同一类失误。
- **H3 —— 与 R12-F11 的 T2 同形，只是位宽从 40 换成 64。** `:95` 的检查写死 `/^[a-f0-9]{40}$/`。严重性低（内容正确、只是落点错），但它再次说明修法是**逐个特例**的，不是按维度的。
- **H4c —— fail-closed，不构成风险。** 【实测】`append_event` 在 `:18` 比对 `metadata_binding_sha256`，不符即 `raise exception 'binding_mismatch'`，且该检查**在任何 `insert` 之前**，事务回滚、**代际 id 不被烧掉**。脚本没拦是个缺口，但数据库兜住了。

**建议（不阻断，但应在提交前处理 H1/H2）**：在脚本里加一道「被引用的 blob 必须能在 `main` 解析，且其 sha256 必须等于所传值」的核验；并给四对参数加上具名旗标（`--ia-blob` / `--se-blob` …）以消除对间可互换性。**若时间不允许，则必须由评审者在每次构建后手工核验四对引用 —— 本轮我就是这么抓到 R13-F3 的。**

### R13-F9 ──【实测】**一条本轮才看清的事：我第十二轮的受理，结构上无法约束这两个新字段。**

这一条我必须写明，因为它直接决定了本轮评审的必要性。

【实测】我拿 H1（虚构 ia 引用）与 H2（两对引用交叉接错）产出的那两份体，分别送进控制器：

| 体 | `reviewSubjectDigest` | `validateRootShape` |
| --- | --- | --- |
| 正确的最终体 | `293da3c5…` | `SHAPE_VALID_ONLY` |
| **H1（ia 指向不存在的 blob）** | **`293da3c5…`（相同！）** | **`SHAPE_VALID_ONLY`（通过！）** |
| **H2（ia 与 se 交叉接错）** | **`293da3c5…`（相同！）** | **`SHAPE_VALID_ONLY`（通过！）** |

**三份体，两份是错的，但三份的评审主体摘要完全相同，且三份都通过控制器的离线验证器。**

原因是结构性的：`reviewSubjectDigest` 删掉 `signature_binding` **和** `independent_acceptance_ref`（`:25`），`signaturePayloadDigest` 删掉 `signature_binding`（`:26`）且 `signed_object_sha256` 由脚本**重算**，因而对任何输入都自洽。

**结论：**
- 我第十二轮受理的 `293da3c5…`，**对这两个字段一个比特的约束力都没有** —— 这一点我当时已写进受理的 `checks` 最后一条，本轮实测坐实了。
- 控制器的 `validateRootShape` 同样不构成约束。
- **因此，这两个字段的正确性完全依赖于一次人工的外部解析核验，别无他物。** 这正是第十二轮结尾我坚持「最终体必须再走一次独立评审」的理由，而 R13-F3 证明这个坚持不是形式主义 —— 它确实拦下了一条机器永远不会发现的错误。

---

## 五、第（5）问：次序调换之后有没有新的危害

### R13-F10 ──【实测】**Owner 修订的技术主张成立，而且我把它的证据面扩宽了。**

修订的核心论据是「没有可打断的通路：三个被 root5 钉住的函数今天都已不可用」。我独立复核：

【实测】我在 `pg_proc` 里扫了 `clued_control` 全部 **15 个函数**，问「哪些提到 root5 代际 id」：

| 函数 | 提到 `ctrgen_e5df…` |
| --- | --- |
| `reserve_gate` | ✅（**4 处**：`:31`、`:59`、`:80`、`:99`） |
| `reserve_execution_budget` | ✅（**4 处**：`:36`、`:64`、`:85`、`:104`） |
| `append_status_manifest` | ✅ |
| 其余 12 个 | ❌ |

**恰好三个，与修订的表一致。** ✅ 且【实测】`reserve_gate:35` / `reserve_execution_budget:40` 钉的 root 摘要是 `4ddd23b52ba396909640c7bdbc60217b0f34a840d5e950901b20e4b3c17502a0`，而我此刻实测的库内实际值是 **`da8c633d…`** —— **两者不等，这两个函数今天确实是坏的。** 修订「没有通路可打断」属实。

**我把检查扩到了修订那张三行表没覆盖的地方【实测】**：另有 4 个函数调用 `read_root`，它们不按代际 id 钉死，但可能按 root **状态**依赖：

| 函数 | 依赖什么 | 注册 root6 后会不会坏 |
| --- | --- | --- |
| `rotate_execution_generation:18` | 仅 `state = STORED_NO_GATE_AUTHORITY` | **不会**（窗口未关、未撤销，状态不变） |
| `read_execution:2` | 仅内嵌 `read_root` 的输出 | **不会** |
| `commit_gate_result:29` | `a.ga->>'control_trust_root_generation' = r->>'generation_id'` | **今天无影响**：实测 `active_ga_id` = null，无 GA 存在 |
| `execution_transition:39` | 同上 | 同上 |

**这最后两条其实是支持调换的新论据，修订没提到**：`commit_gate_result` 与 `execution_transition` 要求**当前活跃 GA 所钉的代际等于当前 head 代际**。今天没有 GA，所以现在注册 root6 无害；**而如果先建 GA 再注册 root6，那个 GA 会在注册的瞬间失效。** 换言之，**先注册 root6 再走 GA/Status24/预算，次序上是更干净的**，不只是「无新损害」而已。

**判定：「调换不引入新的技术损害」—— 确认，且证据面比修订自陈的更宽。** ✅

### R13-F11 ──【实测 + 读文本】**但调换确实引入了两条第十二轮没考虑到的新风险。派工问的是这个，我不含糊。**

#### 新风险一：**烧毁在前，修复在后 —— 这是一次真实的风险转移，不是纯粹的改进。**

第十二轮我论证调换的好处时，说的是「9d→9f 之间那段只有注册成功才能退出的区间消失了」。**这是对的，但我当时没有把反向的代价说出来。**

| | 旧次序（先 CP-01、后注册） | 新次序（先注册、后 CP-01） |
| --- | --- | --- |
| 若 CP-01 出问题 | 代际 id **尚未烧掉**，可留到下一窗口重来 | 代际 id **已经烧掉**，本窗口作废 |
| 若注册出问题 | 两个函数被永久钉在无法实现的投影值上 | 不会发生（CP-01 尚未应用） |

**新次序把失败的代价从「函数被钉死」换成了「代际被烧掉 + 本窗口作废」。**

我仍然认为**调换是对的**，理由是两边的**概率**不同，不是代价相同：
- 【实测】CP-01 在新次序下钉的是**实测**摘要，「投影 ≠ 实测」这一整类失效在结构上消失；
- 【实测】CP-01 自身没有任何 root 状态前置（我复核了修订的这一主张：`cp01-substitutions.json` 的 21 条编辑分布为 `reserve_gate` 8、`reserve_execution_budget` 9、`append_status_manifest` 4，且其 `preimage_prosrc_sha256` 四项**与我实测的线上 `prosrc` 摘要逐字相同**，说明前像是当前的、不是陈旧的）；
- CP-01 是函数替换，**可重做**；代际注册**不可重做**。把不可重做的一步放在前面，代价是它在成功前得不到「后续步骤确实可行」的确认。

**所以我的表述是**：调换**净收益为正**，但**不是零代价**。**应当在注册之前就把 CP-01 候选准备到「只差填入实测摘要」的程度**，使注册与 CP-01 之间的间隔尽可能短。**修订的 `new_order` 把「finalise CP-01」整个放在注册之后（第 4 步），这在文本上允许一段任意长的间隔。建议明确写入：CP-01 的其余 20 条编辑应在注册前定稿，注册后只填 G8/B9 两处的实测摘要。**

#### 新风险二：**「实测摘要」比听上去脆 —— 它依赖会话时区。**

这是本轮的一条新发现，**第十二轮和 Owner 修订都没有考虑到**。

修订的首要论据是「CP-01 可以钉**实测**摘要而非**投影**摘要，于是整类失效消失」。**「实测」给人一种「量出来的就一定对」的确定感。但这个量值不是唯一的。**

【实测】`reserve_gate:35` / `reserve_execution_budget:40` 的守卫是：

```sql
encode(sha256(convert_to((series_view->'root')::text,'UTF8')),'hex') is distinct from '4ddd23b5…'
```

其中 `series_view->'root'` 就是 `read_root(...)` 的输出。而 `read_root` 的输出里有两处**随会话时区变化**的内容：

1. 它内嵌的 `metadata_binding_sha256` = `sha256(to_jsonb(accepted_binding 行)::text)`，该行含两个 `timestamptz` 列；
2. `events` 数组里每个事件的 `recorded_at`，也是 `timestamptz`（我查了 `clued_control.events` 的列定义确认）。

**我实测了这个依赖，不是推断的：**

| 【实测】会话 `TimeZone` | `expires_at` 渲染为 | `metadata_binding_sha256` |
| --- | --- | --- |
| `UTC` | `2026-09-13T07:05:16+00:00` | **`ee5d85faebda1878b3c676dfcc13ecd35d896e5f390907bce39e79bda83caba5`** |
| `Asia/Shanghai` | `2026-09-13T15:05:16+08:00` | **`dede80773d3a3d335f2e6b110613ff20281b4ac3340109becd453dd31d5eb852`** |

**同一行数据，两个摘要。**

**后果：**
- **对 CP-01（新次序下）**：若注册后在一个非 UTC 会话里「量」root 摘要并钉进 G8/B9，得到的值对所有 UTC 调用者都是错的 —— 而且因为它被称作「实测值」，这个错误**比投影值更难被怀疑**。**新次序把一类失效换成了另一类，而新的那一类伪装得更好。**
- **对本轮的注册本身**：`metadata_binding_sha256` 同样受此影响。**提交 `append_event` 的会话必须是 `TimeZone = UTC`**，否则 `:18` 的比对不符。
- **好消息**：这一条**fail-closed**。【实测】`append_event` 的 `binding_mismatch` 抛在任何 `insert` 之前，**事务回滚、代际 id 不烧**。所以它不会造成不可逆损害，但会造成一次令人困惑的失败。

**建议（应写入运行手册）**：注册与 CP-01 的每一步，**在同一条语句里显式 `select current_setting('TimeZone')` 并记录**，确认为 `UTC` 再继续。这是一行成本。

#### 派工另问：「注册成功但 CP-01 迟迟未应用的那段时间里，有没有什么会恶化？」

**【实测】答：在库的层面，没有任何东西会随时间恶化。** 逐条：

| 会不会恶化 | 【实测】判定 |
| --- | --- |
| 三个被 root5 钉住的函数 | **不会**。它们今天已不可用，注册 root6 后仍不可用，状态不变 |
| `read_root` / `read_execution` | **不会**。注册后 `state` 仍是 `STORED_NO_GATE_AUTHORITY` |
| 已有的 GA / 预算 | **无可恶化者**。`active_ga_id` = null，`pending_budget_sequence` = null |
| `charged_seconds` | **不会**。注册不消耗预算 |
| `accepted_binding` | **不会**。该行受 `accepted_binding_immutable` 触发器保护（`BEFORE DELETE OR UPDATE OR TRUNCATE`），且注册不触碰它 |
| 再次注册 root6 的可能性 | **注册那一刻即归零**，此后恒为零，不随时间变化 |

**真正随时间恶化的只有一样：窗口。** `2026-09-13T07:05:16Z` 之后：
- `read_root` 的 `state` 变为 `EXPIRED_OR_NOT_YET_VALID`；
- 【实测】`readControlUri:52` 要求 `state = STORED_NO_GATE_AUTHORITY`，**于是整个 root 变为不可读**；
- 【实测】`append_event:17` 的窗口断言也会拒绝一切写入。

**即：CP-01 拖得越久，剩给「CP-01 + GA + Status24 + 预算 + 600 秒运行 + GRR」的时间越少，而代际已经烧掉了。** 这不是「某个东西会变坏」，而是「已付出的代价在无法兑现的方向上逼近」。**这是新次序下唯一真正的时间压力，应当明确记录。**

---

## 六、第（6）问：这份体能不能提交给 `append_event`

### R13-F12 ──【实测】**除 R13-F3 那一条以外，全部前置条件我逐条查过，全部满足。**

我从线上读了 `append_event` 的 `prosrc`（`prosrc_sha256` = `8e6a70387c53653888a9e97777e88362f38cb69c01ae15a99826599846378a74`，3771 字符），按它实际的检查顺序逐条核：

**第一组：形状检查（与库状态无关）**

| # | `append_event` 的要求 | 【实测】本体 | 判定 |
| --- | --- | --- | --- |
| `:13` | `p` 是 object 且 `octet_length(p::text) ≤ 65536` | 紧凑序列化 4274 字节 | ✅ 余量充足 |
| `:15` | 顶层键**恰好**为 8 个（排序后） | `body, expected_sequence, generation_id, idempotency_key, kind, metadata_binding_sha256, predecessor_generation_id, root_set_id` | ✅ **一个不多一个不少** |
| `:16` | `root_set_id` = `ctr_414bd3c7…` | 相同 | ✅ |
| `:17-18` | `idempotency_key` 是 string 且 `^[A-Za-z0-9_-]{1,128}$` | `register-root6-window11-20260912`（32 字符） | ✅ |
| `:19-20` | `expected_sequence` 是 **number** 且 `^(0\|[1-9][0-9]{0,14})$` | `5`（JSON number，非字符串） | ✅ |
| `:21` | `body` 是 object | 是 | ✅ |
| `:30` | `kind` 属受支持集合 | `GENERATION_REGISTERED` | ✅ |
| `:32` | `generation_id` 匹配 `^ctrgen_[0-9a-f]{32}$` | `ctrgen_5e0440a95ac8ee257b9e4236cabd275b` | ✅ |

**第二组：与库状态相关（实测于 09:45:14Z 与 09:56:46Z，两次一致）**

| # | 要求 | 【实测】库内 | 本体 | 判定 |
| --- | --- | --- | --- | --- |
| `:22-23` | `accepted_binding` 行存在 | 存在 | — | ✅ |
| `:24` | `clock_timestamp()` ∈ [`not_before`, `expires_at`) | 窗口 `07:05:16Z .. 07:05:16Z(+1d)`，现 `09:56Z` | — | ✅ **开着** |
| `:25-26` | `metadata_binding_sha256` = `sha256(to_jsonb(binding 行)::text)` | **`ee5d85faebda1878b3c676dfcc13ecd35d896e5f390907bce39e79bda83caba5`** | 同 | ✅ **我在库内自己算的** |
| `:29` | `expected_sequence` = `head.sequence` | `5` | `5` | ✅ |
| `:31` | `h.revoked` 为假 | `false` | — | ✅ |
| `:33` | `predecessor_generation_id` = `head.generation_id` | `ctrgen_e5df4322…` | 同 | ✅ |
| `:36` | 该 `generation_id` 从未注册过 | 全表 **0** 次出现 | — | ✅ **未被烧过** |
| `:27` | `idempotency_key` 未被占用 | **0** 行 | — | ✅ |

**第三组：`validateRootShape`（控制器事后会跑的那一道）**

【实测】我在装了 **ajv 6.15.0** 的独立副本里，用控制器**本身的模块**跑了一遍真实的 `validateRootShape(最终体 body)`：

```
RESULT: {"status":"SHAPE_VALID_ONLY","authority_effect":"NONE","signature_verified":false}
```

逐条（`:28`–`:36`）：schema 形状通过、`schema_digest` 精确相符、**Owner 窗口取等号成立**（`expires_at` = 硬上限 `2026-09-13T07:05:16Z`，无余量 —— 沿用 R12-F17）、revocation 新鲜度窗口成立、三个 issuer purpose 互异、issuer audience 全等于 body 的 audience、`signed_object_sha256` = `signaturePayloadDigest`。✅

**第四组：`readControlUri:57`（每次后续读取都会跑的那一道）**

| 要求 | 【实测】 | 判定 |
| --- | --- | --- |
| `body.control_trust_root_generation` = `request.generation_id` | 均为 `ctrgen_5e0440a9…` | ✅ |
| `history.prefix_sequence` = 追加前前缀长度 | `5` = `5` | ✅ |
| `history.prefix_digest` = `canonicalDigest(prefix)` | **`bcc3742e3834776b62f6b4ffff94d93bcad46334afaf63d5b1ae1635ef3ed796`**，我用两套实现各算一遍 | ✅ |
| `body.status` = `REGISTERED` | 是 | ✅ |

**第五组：body 形状与 root5 的一致性**

【实测】root5 body 与 root6 body **顶层键集完全相同，各 20 键，无新增、无缺失**；`append_event` 请求信封的键集与 root5 那次注册**也完全相同**。
逐字段：**10 项逐字未变**（`scope`、`status`、`object_type`、`purpose`、`audience`、`root_set_id`、`schema_digest`、`schema_version`、`issuer_bindings`、`algorithm_config`），**10 项变化**（第十二轮在评审主体上数到的 9 项，加上本轮新增的 `signature_binding`）。与第十二轮 R12-F12 的结论接得上。✅

**第六组：`predecessor` 与 `revocation`**

| 【实测】项 | 我自己算的 | 本体 | |
| --- | --- | --- | --- |
| `predecessor.sha256` = `canonicalDigest(root5 body)` | `92186d46e92ee7d27427de813d14faeb1745fb3c1d08c6280ea86a84b258eff5` | 同 | ✅ |
| `predecessor.generation_id` | `ctrgen_e5df4322…` = 库内 head | 同 | ✅ |
| `revocation.event_set_digest`（空集） | `37517e5f3dc66819…` | 同 | ✅ |
| 五代历史 `prefix_digest` 全部复现 | **5 / 5** | — | ✅ |
| 四代 `predecessor` 方法全部复现 | **4 / 4** | — | ✅ |

**这两组的所有值都由我自己的 Python canonical 实现算出，并与控制器 JS 实现交叉核对，两套一致。快照本身的同一性由数据库内部算出的 sha256 闭合（我实测 `read_root` 文本长度 23266、sha256 `da8c633d…`，与仓库里的 `ReadRootSnapshotAfterNW01.json` 逐字节相同）。**

### R13-F13 ──【实测】我把注册后的控制器读取整个模拟了一遍，并带了否定对照。

只验「提交前的条件」还不够 —— 真正的危险是「写进去之后被控制器拒绝」。所以我构造了追加之后的存储状态（6 个事件、head 改为 root6、sequence 改为 6），喂给控制器真实的 `readControlUri`：

| 【实测】读取 | 结果 |
| --- | --- |
| `<root>` | **OK**，返回 root6 body，`generation_ordinal` = 6 |
| `<root>#history` | **OK**，6 条 |
| `<root>#revocations` | **OK**，0 条 |

**否定对照（证明这个测试不是空跑）**：

| 【实测】篡改 | 结果 |
| --- | --- |
| `prefix_digest` 改掉 | **被拒** |
| `signed_object_sha256` 改掉 | **被拒** |
| `expires_at` **+1 秒** | **被拒**（`Owner window` —— 印证 R12-F17「无余量」） |
| `control_trust_root_generation` 改掉 | **被拒** |

**四项篡改全部被拒，正确的那份通过。判定：这份体在写入后能被控制器正常读出。** ✅

### 第（6）问的总判定

**技术上，这份体的每一道机器可检的关卡都过了 —— 我逐条查过，没有一条不满足。**
**但我不放行，因为唯一一道机器检不出来的关卡没过（R13-F3）。**

**两条必须写进运行手册的操作前提【实测】：**
1. **提交会话的 `TimeZone` 必须是 `UTC`**，否则 `metadata_binding_sha256` 不符（fail-closed，不烧代际，但会失败）。
2. **提交的是文件里的 `request` 对象，不是整个文件。** 该文件是 `{state, warning, request}` 三键包装；整份传入会因顶层键集不符被 `:15` 拒绝（同样 fail-closed）。

---

## 七、第（7）问：时钟

窗口 `2026-09-13T07:05:16Z` 关闭，此刻（09:57Z）尚余约 **21 小时 8 分**。

### 有没有哪一处因为赶而降低了标准 —— 有，一处，就是 R13-F3

**我认为 R13-F3 是一次赶工失误，不是判断失误。** 依据【实测】：实施方在 `work/cp01/cp01-substitutions.json` 里把 `cbe898d3…` 的证据**正确地**指向了 `OwnerApprovalVerification.json`；在注册体里却取了 `ContinuationSubjectSignatureEvidence.json`。**同一个人、同一天、同一个事实，一处用对、一处用错** —— 这是取件时手快，不是不懂。

而它之所以没被自己发现，是因为**第十二轮的闭环检查恰好只覆盖了另一个字段**：R12-F18 为 `independent_acceptance_ref` 建立了「必须指向本代自身评审主体的受理」这条不变式并跨五代验证；**`signature_binding` 没有人建过对应的不变式**。实施方在答复第三节里逐一核对了「两个来源文件是否在 `main`」，**核到了可达性，没核到对应性** —— 而可达性正是容易核的那一半。

**这就是赶的痕迹：优先做了能快速做完的那一半检查。**

### 反过来：哪一条谨慎其实是多余的、可以安全省掉

派工特别想听这一条，我给三条，按可省的把握从高到低排：

**（一）「第三次合并必须带上签名证据文件」这条要求，其实已经可以降级了 —— 而且照它做反而是错的。**
第十一轮 R11-F4 与第十二轮 R12-F20 都强调：`ContinuationSubjectSignatureEvidence.json` 的摘要已入库而文件不在 `main`，第三次合并必须带上它。**这件事做了，而它正是 R13-F3 的来源** —— 因为「这份文件必须进 `main`」被顺手读成了「这份文件就是注册体该引用的那份」。
**真实情况是**：那份文件之所以要进 `main`，是因为 **NW-01 把它的摘要写进了 `accepted_binding.signature_evidence_sha256`**，与 root6 注册体**毫无关系**。**两件事从头到尾就不该放在一起说。** 今后请分开表述。

**（二）为 CP-01 计算「投影 root 摘要」的整条链路可以整个作废 —— 这一条我确认，可以省。**
【实测】依据：注册 root6 不需要 CP-01 先修好（三个被钉住的函数今天已全坏，我扫了全部 15 个函数确认没有第四个）；CP-01 也没有任何 root 状态前置（21 条编辑的前像摘要与线上逐字相同，且无一条钉 head 代际或事件数）。**`derive-projected-root-digest.sql` 及其评审、以及「合并的注册体必须与 CP-01 哈希的那份逐字节相同」那条硬要求，全部可以省掉。** 这是实打实的时间节省，我背书。
**唯一的附加条件**见 R13-F11 风险二：省掉投影之后，「实测」那一步必须显式确认 `TimeZone = UTC`。**省掉一整条链路，换进一行 `current_setting('TimeZone')`。**

**（三）不必为 R13-F3 再走一次第四次 Owner 合并。**
正确的目标 blob `cad73582…` **已经在 `main`**。改两个字段、重跑一次构建、我再核一次引用即可。**不要因为「证据文件应当专名」而去生成 `Root6SignatureEvidence.json` 并再合并一次** —— 那会为一个命名问题花掉一次合并往返。

### 哪些谨慎不能省

- **不能省**：提交前逐条核验四对 blob/sha 引用（本轮抓到 R13-F3 的就是这一步，而脚本至今不做 —— R13-F8 的 H1/H2）。
- **不能省**：注册后对 root 摘要的实测，以及实测时的时区确认。
- **不能省**：`append_event` 提交前再确认一次 `head.sequence` 仍为 5 且 `idempotency_key` 仍未占用（这两项我实测过，但它们随时间可变）。

### 我自己有没有因为赶而降低标准

**没有。** 两个新字段我各自独立解析了 blob 并重新量了 sha256；被受理主体我比对的是规范化字符串本身而不只是摘要；Owner 合并 3 我补上了 API 的 `verification` 字段；第（4）问我跑了 **15 组**实际的敌意测试而不是读代码；第（6）问我模拟了注册后的控制器读取并加了四组否定对照。

第七轮那句照录：**「窗口 Owner 可以重开，`SECURITY DEFINER` 函数改坏了不能。」**
第十二轮我补的那句：**「注册体比函数更甚 —— 代际 id 烧掉就没有第二个了。」**
**本轮再补一句：这份体里有两个字段，任何摘要都不承诺、任何验证器都不检查。它们只被人看。所以这道人工评审不是流程的装饰，它是这两个字段唯一的守卫 —— 本轮它抓到了东西。**

---

## 八、总结判定

| 问 | 判定 |
| --- | --- |
| (1) 两个新字段 | `independent_acceptance_ref` **通过**（blob 三分支同一对象、sha256 自量相符、六代不变式 6/6）；`signed_object_sha256` **通过**（口径与值两套实现各算一遍）；**`signature_evidence_ref` 不通过 —— R13-F3，本轮唯一阻断项** |
| (2) 受理部分有没有被动过 | **没有**。两套实现算出 `293da3c5…`，且规范化字符串**逐字符相同**。受理仍然有效（R13-F5） |
| (3) Owner 合并 3 | **合格**。`verification.verified = true` / `reason = valid`（实施方缺的那一条，由我从 API 补上）、Owner 本人、web-flow、两亲合并；两个 blob 均可从 `main` 解析；`artifacts/` 下纯增量（R13-F6） |
| (4) R12-F9 / R12-F11 | **都真闭了**，11 组敌意测试确认（R13-F7）。**但仍有 4 种传参能产出指向假引用的可提交请求（R13-F8）**，其中 H2「两对参数整体对调」与本轮实际发生的 R13-F3 是同一类失误。**且我的受理与控制器验证器结构上都无法约束这两个字段（R13-F9）** |
| (5) 次序调换 | 技术主张**确认**，证据面比修订自陈的更宽（R13-F10）。**但引入两条新风险：烧毁在前修复在后的代价转移；以及「实测摘要」的会话时区依赖 —— 后者第十二轮和修订都没考虑到（R13-F11）**。注册后 CP-01 未应用期间，库内无物恶化，恶化的只有剩余窗口 |
| (6) 能不能提交 | **机器可检的每一道关卡全部通过**，含 `metadata_binding_sha256`、`prefix_digest`/`prefix_sequence`、`predecessor`、窗口、`idempotency_key`、body 形状、`validateRootShape`，以及注册后控制器读取的模拟（带四组否定对照）。**但因 R13-F3 不放行** |
| (7) 时钟 | 赶工痕迹一处（R13-F3，可达性核了、对应性没核）。**可安全省掉的谨慎三条**，其中投影摘要整条链路作废我明确背书 |

### 一句话回答：这份体能不能提交？

**不能，现在还不能 —— 但差得很少。**

**改一个字段的两个值**（`signature_evidence_ref` → `OwnerApprovalVerification.json` 的 blob `cad73582…` / sha256 `69e84e74…`），**重跑一次构建，我再核一次四对引用，即可放行。**
**不需要第四次 Owner 合并，不需要重开窗口，不使我第十二轮的受理失效**（`293da3c5…` 与 `95973246…` 两个值实测均不变）。

---

## 边界声明

本文件全部数据库结论来自只读 `select`（共 11 次）。**未写库、未注册代际、未消耗那唯一一次分配、未调用任何会写库或消耗预算的函数、未执行任何 `do $$ … $$` 块（包括 CP-01 候选里的 DO 块）。** 唯一一次 GUC 操作是 `set_config('TimeZone', …, true)`（事务内生效、语句结束即还原、不触碰数据），用于取证 R13-F11 风险二；复核结束时实测 `TimeZone` 仍为 `UTC`。

复核结束时实测（09:56:46Z）：`charged_seconds` = **9906**、`charged_evidence_bytes` = 2201594803、`execution.sequence` = **88**、`execution_events` = **88**、`active_ga_id` = null、`pending_budget_sequence` = null、`clued_control.events` = **5** 行、head 仍 **root5**、`root.state` = `STORED_NO_GATE_AUTHORITY`、窗口 `2026-09-12T07:05:16Z .. 2026-09-13T07:05:16Z`。

**取证面**：我在会话临时目录的一份独立仓库副本（`git archive impl | tar -x`）里运行了实施方的 `build-root6-registration.mjs` 与控制器模块，并在该副本的 `apps/clued-cloud` 下 `npm install ajv@6.15.0`（实测 `require.resolve` 落在该副本内，版本 6.15.0）。这些脚本不连数据库。**实施方检出的任何文件未被修改**（复核结束时 `git status` 干净）；敌意测试 H3 产生的一个以 sha256 命名的杂散文件已删除并复查。

**本文件不注册代际、不构成授权、不批准也不合并任何 PR。本轮不签发受理文件** —— 因 R13-F3 阻断，`Root6FinalRegistrationBodyAcceptance.json` **未创建**。最终裁量权在 Owner（`tdoljyj`）。

未实测而仅【读文本】的条目已在正文标注，主要是：运行手册的步骤编号与阶段划分、Owner 次序修订的决策过程本身（我看到的是它的文本与其技术主张，技术主张我独立复核了）、`capture-owner-merge.mjs` 若重跑会产出什么（我没有运行它）、以及 MCP 工具与 GitHub API 的内部实现。

**CI 状态按派工说明不计入**：本仓库 CI 五项长期全红、日志 404，已确认非瞬时；**本文件不把它记作通过，也未尝试修复。**
