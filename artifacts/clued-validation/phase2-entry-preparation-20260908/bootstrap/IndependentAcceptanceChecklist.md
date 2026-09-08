# 非生产 bootstrap 独立接受核对清单

**CHECKLIST_ONLY — NO_ACCEPTANCE_ISSUED**。用户已明确批准“这份非生产资格启动方案”，不再索取同范围重复批准；本清单不把批准、代码存在或本地测试通过当成资格。指定评估者为 `/root/project_list_auth_fix`，实施者为 `/root/controller_candidate`；评估者只读实现并提出发现，不代写 controller 或其资格执行逻辑。

## 固定依据

- 获批 [AuthorityUnblockProposal.md](../AuthorityUnblockProposal.md)：提交 `6e8849cbfb296079a6c10fd53c338f28934ba0bb`，SHA256 `2860a0884a2a33bfd57a03789f1d6eab02f7e0d4a8a3725f1d4b640737e0cc3d`。用户批准是真实收到的指令；对应 Owner 补充决定的签名合并与实施证据尚待提供，当前不填虚构引用。
- 本机 `work/slice-a-contracts/TestControllerQualificationPlan.json`：`b482c08ad0cb85fcec388da6505849d58e6b5d22a5982bcfefc7a2a19b204087`。
- 同目录 `QualificationPhasePolicy.json`：`154a5ca0e3d6786877662b68a173176ecd54712744400805ef4b2a93f5946f22`；`QualificationRegressionSpecifications.json`：`8d35a391a728703a527cfef3137867bb80c70a0a78bd869051fe47406192dafe`。
- 同目录 `ReadinessAndGateCandidate.json`：`6d8adc8e29c3be0cd18e25925851559494f94384f79f8a2e530a68f3802d4ceb`；既有来源索引见 [ControllerSourceBoundary.json](../mapping/ControllerSourceBoundary.json)。这些原候选的历史状态不自动成为现行接受。

只使用原合同的 Profile、GateAuthorization、GateResultReceipt 与既有字段；本表检查编号不创造控制类型。限定 Profile 为 `DP-PREENTRY-SKILL-QUALIFICATION`，purpose 为 `SKILL_COEXISTENCE_QUALIFICATION`，环境为 `ISOLATED_TEST`，被测对象只能为 `UNQUALIFIED_QUARANTINED_TEST_SUBJECT_ONLY`。

## 接受检查

每项须记录实际证据位置、不可变版本/摘要、观察时间、核查结果与适用范围。缺失、冲突、过期或只提供候选自述均拒绝该项；不得用最终总分掩盖必需项缺失。

| 项目 | 必须独立核查的事实 | 拒绝条件与边界 |
| --- | --- | --- |
| Owner 授权来源 | 补充决定精确引用获批文件及用户指令；通过真实 GitHub API 核对仓库 `tdoljyj/cross-memory-system`、PR 已合并、merge SHA、`merged_by=tdoljyj`、`committer=web-flow`、`verification.verified=true/reason=valid`、签名 payload 的 tree/双亲与提交一致；从该 tree 读取并哈希决定全文。 | 签名真实但对象/用途不同仍拒绝。GitHub 管理权限、旧 TM19 接受或旧签名不替代本次限定授权；不改旧 pins、根、Frozen Registry。 |
| 时间与主体 | 以实际 PR `merged_at` 固定24小时总窗口的起止；核对实际 actor/issuer/audience 与两任务角色，评估者未参与实现且不由被测 Skill 产生。 | 未知身份、超窗口、转授或实现/验收合流即拒绝。评估资格仅源于已核验的新 Owner 补充决定，不自称原已合格。 |
| R05–R10 前置 | R05 ArchitectureConstitutionAcceptanceDecision → R06 Phase2StructureFreezeDecision → R07 实际迁移及责任/Authority/Evidence/Gate/Pointer/Compatibility/Rollback闭合 → R08 当前受查范围的语义验证 → R09 厂商无关机制冻结 → R10 精确新 Skill 投影；逐件核查接受主体、精确摘要、范围、依赖、期限/失效条件及实际接线。 | 使用 [ReadinessMapping](../mapping/ReadinessMapping.json)、[变化复核](../mapping/ChangeApplicabilityReview.json) 和 [针对性检查](../mapping/TargetedChecks.json) 做适用性证据，不把它们改称正式阶段决定。不能仅凭21步收口、旧 Naming Freeze 或 CI 绿色替代当前缺项。实际新 Skill 测试必须前置完整；controller不得依赖R11/R13/R14自证。 |
| Profile 与计划 | 独立接受的 Profile/计划精确继承原合同用途、前置与禁止项；逐项绑定适用 PQUAL 的真实刺激、期望、断言、可执行步骤和证据出口。原始状态与未执行项保留。 | 不能用文档字段 `allowed=true`、静态图无环或回放输出代替真实运行行为；不得把 Slice A 改名为资格测试。 |
| runner/build/config/依赖 | 源码、构建命令、产物、依赖、配置及宿主运行时摘要成完整闭合集合；独立读取实际运行的文件，证明与受查清单一致；记录真实执行入口。 | 当前 `noop/wait/fixture_write` 或 AppContainer 探针单独存在不等于已完成 Skill 资格驱动器。存在未绑定动态加载、任意命令入口或摘要漂移即拒绝。 |
| fixtures、Skill 与机制 | 只接受固定合成输入；哈希 fixtures、Skill完整文件集、机制、目标修订及允许的精确步骤；测试对象与 controller 分开，Skill输出不能决定自身资格或改变授权。 | 输入含真实用户载荷/生产凭据、未锁定 fixture、借候选改自身控制配置或写 ACTIVE/default/发布指针即拒绝。安装摘要一致不等于隔离执行已发生。 |
| 宿主、allowlist 与双向隔离 | 真实 OS token/隔离标识、父子进程及后代边界、文件与网络访问结果；正控制证明探针有效，负控制证明不允许的访问确实被拒绝。可执行文件、参数、工具、网络端点和凭据 audience 逐项固定；证明宿主与测试主体之间无非授权凭据穿越。 | 空环境不替代文件/网络隔离；超时不等于网络拒绝。禁止真实模型调用/外发/下载/训练/评测、任意宿主 shell、生产端点、付费或公开分发。只能固定白名单驱动器动作。 |
| 预算与预留 | 每次副作用前有真实可核验的预算预留与剩余量；本次零模型/付费预算、最多1活动隔离测试、累计2小时受控执行、1GiB新增本地证据；达到边界前拒绝并记录。 | 配置中的数字不是预留证据；无并发占用控制、超额、默认为USD5获批或到期自动释放资源均拒绝。 |
| 停止与进程树 | 真实 STOP/撤回触发、下一副作用被阻止、活动进程及受管后代退出观察；终止失败保留占用与证据，不能报告完成。 | 单个探针子进程的退出不证明完整执行树可停止；缺 stop channel、只发终止请求无退出结果或误终止无关进程均拒绝。 |
| 撤回、generation 与 GA | 核对实际授权源的当前撤回状态、`revocation_epoch_vector`，分别维护 controller/credential/session/target/policy 的 generation/摘要；每个副作用前检验。每个GA `expires_at-issued_at≤600秒`，且不超过Owner总窗口；同scope续期重查有效授权/剩余预算，纯续期不增fencing，重新取得才新fence。 | 本地任意可改 `control.json` 不等于合法撤回源；未知/离线、过期、旧generation或更强凭据自动重试均拒绝。过期不证明进程停止。 |
| 持久证据与失败路径 | 先写不可变Intent并取得持久化证据，再执行；结果绑定真实目标、调用及执行记录。固定实际 sink/权限/留存和读回，证明中断后可取回；原始失败不可覆盖。 | 仅stdout、仅配置sink URL、仅本机fsync不冒充已要求的远端持久性。sink失败阻止新副作用；未授权清理或删除失败历史即拒绝。 |
| UNKNOWN 与幂等 | 真实注入部分成功、丢响应或中断；用既有幂等键持久Intent核对目标，结果不明则停止新动作；同键改参数拒绝，禁止盲重试、重复终态GRR和提前释放容量。 | `UNKNOWN`仅为执行观察，不新增GRR结果值；遵循原接受值 PASS/FAIL/BLOCKED/STALE，不能为让报表全绿强行终态。 |
| 最终适用性 | 资格记录、GA和实际结果共同绑定独立评估、Profile、全部摘要、阶段证据、actor/issuer/scope/purpose/audience、预算/stop/sink、时间和generation；由主控仅依据真实接受执行/发布。 | 不把测试Evidence、资格、GRR或清理结果外推为原11 Readiness、R11、Entry、模型或生产接受。所有结论必须保留适用范围和未执行项。 |

## PQUAL 精确范围及顺序

PQUAL-01–17、19–20仅运行其适用于前 Entry 的已接受隔离步骤。正常允许路径必须使用真实有效前置与授权；缺项/越权/漂移等负例只能由已授权测试驱动器在隔离对象上注入，不能以伪造生产决定实施“测试”。

- PQUAL-10 可证明越权模型动作被拒绝；**所有真实模型动作不在此次授权内**，回放不得标为实时调用。
- PQUAL-18 后 Entry 正例要求 R14、独立 Slice A 授权及 `DP-ISOLATED-E2E`，**本次不执行该正例**。前 Entry 越序拒绝的证据单列，不记为其正例通过或20/20完整正例。
- 先核验Owner签名与授权，再独立接受实际控制器/Profile；在R05–R10与每次GA等全部实际前置满足后，才运行被测Skill。不能让被测Skill或R11结果倒推controller资格。
- 对本批准用途内的后继对象，保留旧对象与失效原因，固定新摘要、独立评估、重新精确签发；不重复询问用户。出现超用途/环境/动作、总窗口到期或指定独立性失效则停止；技术缺项保持拒绝，不能靠增加权限遮盖。

收到实际签名合并与完整实施清单后，逐项给出有证据的接受、发现或缺项结论；**当前仅完成核对清单，未签发资格、GA或正式接受。**
