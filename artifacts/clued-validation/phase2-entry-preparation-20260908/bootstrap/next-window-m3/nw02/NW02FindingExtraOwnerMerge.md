# NW02-F1：计划 v2 漏列了一次 Owner 合并（实测 NW-01 先例证实）

**结论：NW-02 链条需要一次计划里没有的 Owner 合并。Owner 剩余动作从 3 次变为 4 次。**

## 证据（只读实测，非回忆）

`nw01-execution/NW01Parameters.json` 明确记着**两个不同的合并**：

| 角色 | 提交 | PR |
| --- | --- | --- |
| 批准（窗口来源）| `cbe898d3…` | **158** |
| 主体件签名取证 `subject_signature_merge` | `3887b9e0…` | **159** |

即 NW-01 当年是：Owner 先合并「提案+批准」（158），再合并「主体件+两份受理件」（159），
而 `ContinuationSubjectSignatureEvidence.json` 捕获的是**后者**。

而 `NextWindowPlanV2Window12Cycle.md` 的「需要 Owner 的动作」只列了：
M3 合并、M4 合并、root7 注册授权、预算预留授权、600 秒授权 —— **没有第二次续窗合并**。

## 为什么现在才发现

M3（PR 164）对应 NW-01 的 158（批准）。M4（PR 165）合并的是 F12 实化与九件重出 ——
那是 window12 循环特有的一步，**NW-01 世系里没有对应物**，所以把它当成「第二次合并」
会张冠李戴：M4 合并时 NW-02 主体件尚未定稿（`subject_sha256` 是 06:30 之后才算出的
`80c2bbeb…`），它不可能捕获一份当时还不存在的文书。

## 连带修正：骨架里的哨兵命名会误导

`ContinuationSubjectSignatureEvidence.skeleton.json` 里 22 处哨兵前缀写作 `__PENDING_M4_*__`
（`M4_MERGE_SHA`、`M4_PR_NUMBER`…）。M4 已用于 F12/重出那次合并，沿用会让实化者
把 `ecd4028` 填进去 —— **那是错的合并**，而且填进去不会有任何闸门报错（本文书只被哈希，
不被形态校验，同 NW02AdjudicationsRound1 对 subject 的实测结论）。
已统一改名为 `__PENDING_SUBJECTMERGE_*__`（22 处，计数断言通过），使其指称的是
「发布本主体件与两份受理件的那次合并」而非任何既有编号。

## 修正后的 Owner 剩余动作（4 次）

| # | 动作 | 前置 |
| --- | --- | --- |
| 1 | **续窗合并**（发布 NW-02 主体件 + 两份受理件）| 两份受理件须由**独立评审**出具（骨架里 7 处 `__REVIEWER_TO_WRITE__`，起草方不得自写自受）|
| 2 | root7 注册执行授权（烧代号，不可回滚）| NW-02 已执行、M-续窗已合并 |
| 3 | 预算预留授权 | CP-02、第 21 次前推 |
| 4 | 600 秒授权 | Status24 |

## 尚未做（诚实边界）

主体件已定稿（`subject_sha256 = 80c2bbeb648076997101343629e4fe4e6ed7318fb94489699ac503bbb9507d41`）。
两份受理件仍待独立评审出具；签名取证件待续窗合并后按世系脚本 `--as signature` 捕获；
`nw02-parameters.json` 的前像标着 `MUST_REMEASURE_BEFORE_APPLY`，执行前必须重测
（`rows_sha256` 随任何动作而变）。
