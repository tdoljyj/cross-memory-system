# 当前运行资格的最小输入

**只读独立审查；不签发运行资格或 GA。** PR23 的 R10 精确签名已由 [IndependentR10SignatureBinding.json](IndependentR10SignatureBinding.json) 核实。Owner 与 R07/R08→R09→R10 的工程接受不再是重复提问或重跑旧检查的理由；应把这些真实决定引用到具体运行 Profile。

## 现在可以直接复用

- 原 Owner PR20 签名限定委托，截止 `2026-09-09T09:28:59Z`；每 GA 最长600秒、单活跃任务、累计控制执行7200秒、证据1GiB、模型/付费为零。后续 merge 不续期。
- 历史 R05/R06 的适用来源，以及 PR22、PR23 固定的当前工程接受；统一 Skill 三个精确摘要已经接受，不修改 Skill，不前置 R13 退役。
- 既有 PQUAL-01–20 预登记期望和禁止项；PQUAL-10只能检查拒绝真实模型动作，PQUAL-18 的后 Entry 正例不在批准范围。
- AppContainer 当前源、STOP/宿主崩溃/UNKNOWN 的限定工程观察。它们不证明完整网络拒绝或任意执行 allowlist；历史 Python harness 未逐次绑定、首次 ACL 失败等限制继续保留。

## 只需要固定这一组实际运行输入

| 输入 | 已有部分 | 尚须真实提供的最小内容 |
| --- | --- | --- |
| Profile/受查物 | `DP-PREENTRY-SKILL-QUALIFICATION` 的既有设计合同和已接受三文件 Skill | 一个精确、独立接受的 Profile 实例：逐项引用已签前置、所选固定 driver/build/config/fixture、合成数据与允许操作；新 Skill 与控制器必须不同。 |
| 实际隔离宿主 | 当前 AppContainer 工程观察 | 固定最终选择的宿主及版本、可执行文件/挂载/工具/网络允许集、凭据不继承、子孙进程与停用/清理的真实证据。若改用恢复后的 Docker，绑定其新宿主对象并只补受影响检查，不继承 AppContainer 的宿主资格。Docker 服务存在或恢复成功本身不是隔离证明。 |
| 具名 issuer/当前控制来源 | 既有 Owner/GitHub 签名基础设施与指定独立评估角色 | 原合同适用的 issuer purpose、audience、Schema 摘要、当前控制信任根代际及核验入口的真实绑定。不得把 repo admin、旧 publication sequence 或 merge SHA 填成根代际。 |
| 撤回/停止 | 既有不可变 Revocation Event 规则、局部 STOP 观察 | Owner/GA 当前事件集合的精确完整性/新鲜性读取，实际四层 Vector 适用性和当前状态源、独立 runner/credential/session 代际，以及撤回/过期到下一动作拒绝、现有动作停止/UNKNOWN 的接线证据。 |
| 持久证据 | 已批准可用私有仓库的隔离工程证据范围 | 精确远端 Intent→原 commit/blob 读回→实际动作→结果/清理追加；同键不同参数拒绝、响应不明按原键核对。子进程无仓库凭据；普通工程 commit 不是 GA。 |
| 预算与执行 | 原委托上限、固定案例 | 一份实际预留/累计/释放状态及受控时钟、单活跃门；具体 GA 绑定已接受全部输入、≤600秒和当前撤回，才执行允许的 PQUAL。过期或 UNKNOWN 不证明进程停止，也不自动释放容量。 |

不要为每个输入增设一套新协议：沿用原 Profile、GateAuthorization、GateResultReceipt、Revocation Event 和 Workflow/Attempt/Evidence 语义。可在已批准范围准备这些精确实现与合成工程记录，交独立评估；准备记录不应自称运行资格。若实际接线要求新建或替换控制信任根，则超出当前授权，不能通过改名规避。

## 隔离 N/A 的实际结论

**受查既有来源没有提供一份已经接受、可直接使用的隔离 N/A Schema 实例。** 这仅限本次真实来源链，不声称所有外部环境都不存在。

原 S06 SHA256 `f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec` 第3010–3012行规定：Vector保留 `vector_schema_version` 及 account、integration-installation、context、binding 四层成对 scope-ref/epoch；只有 Schema 明确允许且有原因时才可写 `not_applicable`。不得省略、置零或伪造无限值；适用 Vector 从当前 Canonical 状态核验，其他代际不能替代它。

`QualificationPhasePolicy.json`（SHA `154a5ca0e3d6786877662b68a173176ecd54712744400805ef4b2a93f5946f22`）仍标 `DESIGN_MODEL_ONLY_NOT_DEPLOYED_POLICY_OR_NEW_KERNEL_WIRE`、`accepted_ref=null`；其“ISOLATED_TEST”不是四层统一 N/A 许可。`TestControllerQualificationPlan.json`（SHA `b482c08ad0cb85fcec388da6505849d58e6b5d22a5982bcfefc7a2a19b204087`）要求真实 authority/host/credential/revocation 接线。原 `ActualQualificationBindings.json`（SHA `61fc5a4ac9e0980e1ccf602d4008a7d1f0b275f20a81cba217384ee80feb3d65`）只是空引用清单；当前工程决定是其可用后继输入，不能把空槽改填假代际。

最小下一动作是先为选定 driver/宿主列出每层是否实际存在、由哪个真实状态源管辖及原合同允许的编码。需要 N/A 的层必须附既有已接受 Schema 的精确规则；目前没有该规则实例可直接引用时，继续固定并评审其在原合同下的具体表达，不启用正式入口、不默认全层 N/A，也不新造控制根。源定位复用 [ControllerSourceBoundary.json](../mapping/ControllerSourceBoundary.json) 和 [AuthorityWiringReview.md](AuthorityWiringReview.md)。

Docker 的恢复与任何新隔离验证由实施者另行处理；本评估者没有恢复环境、运行容器或修改 controller。本次也没有重审投影、复跑旧测试或宣布 R11/Entry 完成。
