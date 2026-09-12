# 本目录中的四份 `*.WindowSuccessorSubject.json` 已被 root6 方案取代

**状态：`SUPERSEDED_DO_NOT_REVIEW_DO_NOT_ACCEPT`。**

由实施方记录，回应继任独立评估者（会话 `session_018nf6mQ5CQuMFadoJ9WRZCN`）F7 项发现：两套互斥的迁移方案同时活在 main 里，都没有被标记作废。

## 被取代的文件

- `ScopedRoot5FinalControllerQualification.WindowSuccessorSubject.json`
- `ExactRoot5FinalPreentryControllerRuntimeAcceptance.WindowSuccessorSubject.json`
- `CurrentNonPerformanceApplicability.WindowSuccessorSubject.json`
- `Root5StopCurrentSourceApplicability.WindowSuccessorSubject.json`
- `WindowSuccessorSubjectsDeltaVerification.json`（上述四份的差异核验）

## 为什么不得评审或接受

这四份文档钉住的值与当前方案**互斥**：

| 字段 | 这四份文档 | root6 方案 |
| --- | --- | --- |
| `controller_digest` | `ac7bdd53…`（已死的 root5 摘要） | `72d9eb92…` |
| `root_generation` | `ctrgen_e5df4322…`（root5） | `ctrgen_5e0440a9…` |
| `expires_at` | `2026-09-12T13:14:51Z` | `2026-09-19T00:00:00Z` |

接受其中任何一份，都会把一条指向已废弃控制器的绑定引入证据链。

此外 [`Package3ZeroCostPreflightCorrection.json`](Package3ZeroCostPreflightCorrection.json) 记录了这四份自身的四项缺陷（预盖 `accepted_at`、覆盖 `supersedes` 丢失溯源、覆盖 `successor_delta`、未变字段计数错误），状态**全部为 `NOT_YET_FIXED`**。它们不会被修复，因为整个方案已被取代。

## 取代它们的是什么

root6 窗口迁移，见 [`work/root6-window10-migration/README.md`](../../../../../work/root6-window10-migration/README.md)。
控制器 `scripts/phase2-qualification/control-context-verifier-root6-window10-successor/`，经 Owner 合并 `a573ca93e094bc9a4a8dccc23c1e165b6b368ff4` 发布。

其中两份文档（`CurrentNonPerformanceApplicability`、`Root5StopCurrentSourceApplicability`）**本来就不被控制器读取**——root6 控制器源码中无任何引用，继任评估者已独立确认。当初为它们准备继任主体是白做的工。

## 同时失效的旧提案

`../../IndependentReviewerSuccessionProposal.md` 仍把这四份当作评审对象在描述，且其 `<SUCCESSOR_IDENTITY>` 占位符从未填写。它已被
[`../../OwnerIndependentReviewerSuccessionDecision.md`](../../OwnerIndependentReviewerSuccessionDecision.md) 取代，后者经 `a573ca9` 合并生效。

**按旧提案行事的人会去评审这四份钉着死摘要的文档。** 这正是本文件存在的理由。

## 文件本身按原字节保留

不删除、不改写。它们是曾经做过什么的记录，只是不再是待办事项。
