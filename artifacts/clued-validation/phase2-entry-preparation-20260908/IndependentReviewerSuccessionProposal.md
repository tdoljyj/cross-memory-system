# Owner 独立评估者继任决策建议

**PROPOSED — NOT AUTHORIZED — NOT ACTIVATED**。只请求一项身份指派，不签发资格、不接受任何对象、不改既有根/pins/已接受来源。核查版本：`93acc0c`（分支 `claude/nice-fermat-njqlmm`）。

## 为什么必须由 Owner 决定

[原 bootstrap 授权](AuthorityUnblockProposal.md)把独立验收绑定在“当前真实任务 `/root/project_list_auth_fix`”上，并明确要求：**审阅者参与实现或无法保持独立性则停止，不自行换人**。

该身份是一个**任务/会话工作目录**，不是服务、工具或人。原文的措辞是“当前真实任务”，其存在“由本次协作列表确认”。会话结束后该目录即不复存在：本次核查确认 `/root/project_list_auth_fix` 在当前执行环境中不存在，且仓库内没有任何可重新调起它的入口。

因此这不是“找不到工具”，而是**被指派的评估者主体已经消失**。原规则禁止实施方自行更换评估者，所以只有 Owner 能决定继任。实施方（本次为准备四份窗口继任主体的 Claude Code 会话 `session_012ki2dPxTiJbPmgZu7AD3Nz`）不得自任评估者，也不得代为指派。

## 现状：卡在哪一步

[包3 零成本预检](bootstrap/root5-final-runtime-v16/Package3ZeroCostPreflightReport.json)确认：全部 v16 时效文件绑定在已作废窗口 `2026-09-11T10:21:05Z`。控制器在执行时直接卡死这些窗口，GA 的到期时间必须不晚于资格文件到期时间，而该时刻已过，**数学上签不出任何 GA**。

已按最小差异原则准备四份**窗口继任审查主体**（`state` 一律为 `PREPARED_..._NOT_ACCEPTED`，`acceptance_issued: false`）：

| 主体 | 前置 SHA256 | 提议文档 SHA256 |
| --- | --- | --- |
| ScopedRoot5FinalControllerQualification | `dfe6299d…67203a2` | `0391776b…ee749c46` |
| ExactRoot5FinalPreentryControllerRuntimeAcceptance | `bc509203…e459c37` | `eaa329e3…090572f5` |
| CurrentNonPerformanceApplicability | `dcb35bef…9b5b8c` | `02f0cdd9…6d18a5b9` |
| Root5StopCurrentSourceApplicability | `9913e3fd…966427f7` | `ad927c01…50b18e04` |

逐键深度比对证明见 [WindowSuccessorSubjectsDeltaVerification.json](bootstrap/root5-final-runtime-v16/WindowSuccessorSubjectsDeltaVerification.json)，结论 `all_clean: true`：差异全部落在各自申报的有效期字段、`supersedes` 与 `successor_delta` 上，`state`、`independent_reviewer` 及其余每一个 digest 与引用逐字节继承。**这些只是提议，未被任何人接受。**

## 唯一待 Owner 决定的变更

指派一个继任独立评估者主体，承接原 `/root/project_list_auth_fix` 在**本用途内**的评估资格。批准本身不接受任何对象、不签发 GA、不推进运行。

| 要素 | 最小具体约束 |
| --- | --- |
| 继任主体 | `<SUCCESSOR_IDENTITY — 由 Owner 填写>`。必须是与实施方不同的真实任务/会话，**未参与** controller 实现，**未参与**本次四份窗口继任主体的准备。准备这四份主体的 `session_012ki2dPxTiJbPmgZu7AD3Nz` 因此不具备资格，不得自任。 |
| 身份标识处理 | 控制器源码硬校验 `independent_reviewer` 字符串（`/root` 与 `/root/project_list_auth_fix`）。若 Owner 授权继任者以该字符串出具证词，须在本决定中写明该标识自此**代表由 Owner 指派的评估者角色**，而非某个已结束的会话；否则须改控制器源码，那将改变 controller digest 并触发整条资格链重做。两条路都必须显式选择，不得默认沿用。 |
| 评估范围 | 仅限：上述四份窗口继任主体、后续 StatusManifest generation 24 主体、以及为重新指向新资格/运行时验收摘要所需的第二十次绑定前推材料。**不含**任何 GA、GRR、Entry、性能资格或范围扩大。 |
| 独立性与只读 | 继任者只读实施方产出与源码，独立提出发现；不代写、不修补、不替实施方决定。发现未解决即不得出具接受。若继任者被卷入实现或无法保持独立，停止并回到 Owner，**仍不得自行再换人**。 |
| 不冒用历史身份 | 继任者不得声称自己是原 `/root/project_list_auth_fix` 会话，也不得冒用历史 `evidence_review` 身份。其出具的每份接受须记录：继任依据（本决定的 Owner 合并提交）、自身真实任务标识、以及“本接受不追认原会话任何历史结论”。 |
| 既有证据不受影响 | 原 `/root/project_list_auth_fix` 已出具的历史接受按原字节保留，不被本决定追认、撤销或重写。第十九次绑定前推（sequence 88）与已入库的 Status23（generation 23）均已发生，不因本决定改变。 |
| 仍然不变的边界 | 不重复应用 SQL9、不新增容量、不退款、不复用旧预算；不创建新 trust root、新签名身份、付费/模型预算或生产权限；不把 CI 未启动记为通过；不把准备性审查当成 19 项真实 observation。分配最后 600 秒前，四份继任接受、Status24 与第二十次前推必须全部真实完成。 |

## 可由 Owner 批准的决定文字

> 我以 Clued 治理规则 Owner 身份，指派 `<SUCCESSOR_IDENTITY>` 继任本文件限定范围内的独立评估者职责，因原指派主体 `/root/project_list_auth_fix` 作为任务会话已不存在。继任者未参与 controller 实现、未参与本次四份窗口继任主体的准备，只读评估并独立出具接受或发现。〔选择其一：**授权** / **不授权**〕其以 `independent_reviewer` 标识 `/root/project_list_auth_fix` 出具证词；该标识自此代表由我指派的评估者角色，不代表任何已结束会话。评估范围仅限四份窗口继任主体、StatusManifest generation 24 主体及第二十次绑定前推材料，不含 GA、GRR、Entry 或任何范围扩大。历史接受按原字节保留，不被追认或撤销。本指派不接受任何对象，不签发任何资格，也不视为任何 Gate 已通过。

## 若 Owner 不批准

则本轮资格运行在当前证据下无法继续：四份窗口继任主体将保持未接受，Status24 与第二十次前推无从进行，最后 600 秒预算不得分配。已完成的部分（第十九次前推、Status23、包3 预检结论）按原字节封存，不作废也不追加。这不是可以靠工程手段绕开的缺口——缺的是一个合格的、非实施方的评估主体。
