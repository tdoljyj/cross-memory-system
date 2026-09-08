# Owner 单次非生产 bootstrap 决策建议

**PROPOSED — NOT AUTHORIZED — NOT ACTIVATED**。只提出一项前向规则变更，不签发资格、不改既有根/pins/已接受来源。核查版本：`950a40b18d637d0f924a835efd93a09950fc7b81`。

**结论：已查来源没有“不改变现有控制授权用途即可正式 bootstrap”的路径。** [QualificationPlan 的精确来源边界](mapping/ControllerSourceBoundary.json)要求现行合法控制信任根、合格独立评估者，并明确“**不新建 trust root**”；S06 原文 SHA256 为 `f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec`。现有 [TM19 接受](../../../docs/execution-plans/phase2-structure-governance/RequiredCheckNonBypassEvidence_20260907.json)仅覆盖精确命名治理发布/读取；[publication.py](../../../scripts/naming-governance/publication.py) 第263–301行绑定 GitHub `web-flow` 验签、双亲合并、`merged_by`、旧 subject/source/sequence 及接受/Freeze 摘要，明文禁止旧签名授权另一个受查对象。不能把它直接改称 controller 资格。

主控本次只读实证确认 GitHub 登录为 `tdoljyj`，私有仓库 `tdoljyj/cross-memory-system` 的 admin/maintain/pull/push/triage 均为 true；这是身份和仓库权限证据，**不证明控制资格签发权**。[原执行委托](../../../docs/execution-plans/phase2-structure-governance/ExecutionDelegation_20260907.json)又限定21步命名治理，不能补出新的签发用途。

## 唯一待 Owner 决定的变更

以 **Clued 治理规则 Owner** 身份，批准一次服务于既有 `PRE_ENTRY_SKILL_QUALIFICATION` 的非生产首次 bootstrap 例外：允许既有可验证的 GitHub 身份/签名设施承载这一新增的、严格限域的控制授权用途；覆盖构建固定资格测试驱动器、独立接受其资格，以及在前置条件满足后隔离加载精确摘要的新 Skill 测试对象、执行适用的 PQUAL-01–20 动作。**这属于语义层控制信任/签发范围变更，不是现有 TM19 权限的自动延伸。** 用前向补充决定保留旧规则和适用边界，不重写 S06、旧 Policy 或 Frozen Registry。

本次使用原合同 `DP-PREENTRY-SKILL-QUALIFICATION` / `SKILL_COEXISTENCE_QUALIFICATION`，不另造协议。来源为本机 `work/slice-a-contracts/QualificationPhasePolicy.json`（SHA256 `154a5ca0e3d6786877662b68a173176ecd54712744400805ef4b2a93f5946f22`）和 `QualificationRegressionSpecifications.json`（SHA256 `8d35a391a728703a527cfef3137867bb80c70a0a78bd869051fe47406192dafe`）。它们目前仍是未接受候选；Owner 批准允许完成对应独立接受，不自动把候选改成已接受。

建议批准范围如下，批准本身不会激活控制器：

| 要素 | 最小具体约束 |
| --- | --- |
| 真实身份与签名 | Owner 使用已核实的 `tdoljyj` 身份，沿现有 GitHub PR → `web-flow` 已验证签名合并的基础设施固定补充决定。只复用签名来源、树/父提交/仓库/合并主体核验方法；不让旧发布验证器接受新 subject，不建立本机新密钥或改旧 pins。签名仅证明来源与字节，权限来自 Owner 明确批准的补充决定。 |
| 实现与独立验收 | 实施者为当前真实任务 `/root/controller_candidate`；拟由当前真实任务 `/root/project_list_auth_fix` 独立验收，后者未参与 controller 实现、本次仅只读其源码。两任务存在由本次协作列表确认，不声称平台认证或既有控制资格。Owner 的补充决定须绑定两任务身份、源输入和独立性，并只授予后者此用途内的 bootstrap/Profile/精确测试对象评估资格。它可接受符合证据的对象及同范围后继，主控只能依据接受签发/执行，不能覆盖否决。审阅者参与实现或无法保持独立性则停止，不自行换人；不冒用历史 `evidence_review` 身份。 |
| 精确受查物 | 从现有 [controller.py](../../../scripts/phase2-qualification/controller.py) 与 [AppContainerProbe.cs](../../../scripts/phase2-qualification/windows-isolation/AppContainerProbe.cs) 出发，允许补成固定 PQUAL 资格驱动器。每次签发前必须独立接受真实 runner/build/依赖、Profile、计划、源码/config、合成 fixtures、精确工具/网络/可执行文件 allowlist、Skill/mechanism 摘要、宿主、预算预留、证据 sink、停止/撤回/恢复机制及 R05–R10 有效证据。现有两个部件尚未接线，`noop/wait/fixture_write` 只是起点，不是最终可用资格执行器。未来摘要不得预填。 |
| 有限签发与连续推进 | Owner 一次授权覆盖上述同用途建设、独立评估、精确签发和隔离资格执行；被测 Skill 只能为 `UNQUALIFIED_QUARANTINED_TEST_SUBJECT_ONLY`，不得参与为自己或 controller 签资格。驱动器只能执行独立接受的固定 PQUAL 步骤；无任意 shell/宿主命令入口。源码/配置/fixtures 等漂移使旧 grant 失效，必须前向固定并独立接受后继对象、重新核验/签发对应精确 GA；同范围内不再逐步问 Owner，不复用旧摘要或冒称无漂移。超出用途、环境、动作边界或转授仍需新决定。 |
| 期限、预算与停用 | Owner 总委托窗口建议自已验证合并起最多24小时；**每个运行 GA 仍须遵守原合同最长600秒**，同 scope 续期也必须重查现行授权与剩余预算，不借续期增加 fencing。零模型/付费预算；本次建议最多1个活动隔离测试、累计2小时受控执行、1GiB新增本地证据，各次预算先固定并预留。到期、撤回、独立 generation 变化或状态未知即拒绝；到期不证明进程停止、不自动释放占用。每个副作用前核验撤回；STOP、已观察的进程树终止、持久 intent/result、UNKNOWN 核对而不盲重试必须先有实际证据。子进程不继承 GitHub/生产凭据。 |
| 默认边界 | 仅 `ISOLATED_TEST`、合成输入与被隔离的精确 Skill；原 Profile 禁止真实用户载荷、生产凭据、模型调用/外发/下载/训练/评测、经济权益、公开分发、候选指针写入。不得激活/default 新 Skill、改 Canon/业务 Binding/生产权限或把 Slice A 实施改名为 qualification。不以本批准、测试结果或清理完成外推原11 Readiness、R09/R10/R11/Entry。原始观察与失败证据保留。 |

**不能用批准替代的技术条件：** [现有控制器说明](../../../scripts/phase2-qualification/README.md)明确尚无 OS 隔离资格；[AppContainer 实测](../../../scripts/phase2-qualification/windows-isolation/README.md)只证明有限文件/令牌边界与单个子进程停止，网络超时不等于网络拒绝，尚未证明完整子进程树、持久远端证据/撤回链。必须先补实际实现和独立观察，再决定能否签发；未补齐就保留未合格。现有本地 `control.json` 不被提升为合法远端控制信任根。

**PQUAL 的原合同例外不能隐去：** PQUAL-01–17、19–20 中适用于前 Entry 的固定隔离动作/负例可在上述条件下运行；测试真实的是执行/拒绝机制，不是用文档字段模拟通过。PQUAL-10 允许验证越权模型动作被拒绝，**不允许真实模型动作**，未授权部分仍为 NOT_EXECUTED。PQUAL-18 的“正常后 Entry 实施”正例明确要求 R14、独立 Slice A 授权和 `DP-ISOLATED-E2E`，本次不覆盖；可以检查前 Entry 越序拒绝，但不得记成 PQUAL-18 正例通过。若某个剩余案例必须真实模型或后 Entry 执行，保留未执行并提出另一个范围决定，不能改名绕过。

可由 Owner 批准的决定文字：

> 我以 Clued 治理规则 Owner 身份批准本文件限定的、总窗口最多24小时的首次非生产 bootstrap，服务于既有 PRE_ENTRY_SKILL_QUALIFICATION；允许构建固定资格驱动器、隔离加载精确摘要的新 Skill 并执行适用 PQUAL 动作。使用既有 tdoljyj/GitHub 签名来源，不改旧根/pins。由 /root/controller_candidate 实施，授权未参与实现的 /root/project_list_auth_fix 在本次限定用途内独立接受 Profile、实际驱动器及精确测试对象；主控据真实接受和完整前置证据签发每次最长600秒的精确 GA 并连续推进。同范围后继先独立接受、重新签发，不再逐步问我；不得覆盖否决或扩大范围。无生产凭据、真实用户数据、模型/付费动作、任意宿主命令、公开分发或 Slice A 越序；PQUAL-18 后 Entry 正例不在此次授权内。本批准不激活 Skill，也不视为任何 Gate 已通过。

若 Owner 不接受上述**新增 bootstrap 授权用途**，则必须提供已有合法控制资格链与已合格评估者的真实引用；现有工程和 GitHub 管理权限不能替代它。此二者之间不存在已核实的免变更捷径。
