---
title: Clued Phase 2 结构准备设计候选
version: v0.1.4
artifact_id: CLUED_PHASE2_STRUCTURE_PREPARATION_CANDIDATE_V0_1_4
status: CANDIDATE_NOT_FROZEN
classification: CONFIDENTIAL
architecture_candidate: CLUED_ARCHITECTURE_CONVERGENCE_V0_2_5
frozen_target_map_ref: null
structure_freeze_decision: NOT_ISSUED
implementation_authorization: NONE
---

# Clued Phase 2 结构准备设计候选 v0.1.4
### 目标共同设计；仓库、开发控制面和用户数据分开实施

## 1. 文档任务与成熟度

本候选把架构责任落到目标结构、开发控制、身份/权限、迁移批次、兼容和回滚设计。它是**责任级设计候选，不是可直接执行的文件移动清单，也不是FrozenTargetMap**。架构接受必须在结构冻结之前，两个决定独立绑定。现在只编制文件，不创建仓库目录、不移动文件、不更新current、不修改数据库或用户Bundle。

S09确认的“同一用户实例兼任开发实例”仍为已否决方案。两类Skill可以同机共存，并不重新批准同一用户实例承担开发控制。源码在同一仓库可以组织两个角色投影，运行数据和授权仍必须分域。

## 2. Current Layout观察及不能推断的内容

本轮通过GitHub连接器GET main与该Commit的根Tree；选定Commit/Tree与精确v0.2.4绑定相同。未执行本机Git对齐或私有快照读取：

```text
repository: tdoljyj/cross-memory-system
main commit: 507c69b8f0638ff9202a4eeb140c606f9089e821
tree: 354e011fc68f3205e6a49708fd1e5f06037d025d
main protected: false
main required_status_checks: off / empty
commit signature: inherited observation; not a new acceptance attestation
```

`data/RepositoryEvidenceObservation.json`是所选返回字段的人工结构化转录，不冒充逐字节API原始响应；根Tree返回在显示中截断。此前相对更早S15的artifacts差异只作历史记录；本轮所选Commit/Tree与精确v024相同，不由旧S15证明当前运行或保护状态。

没有进行完整递归库存、逐blob代码审查、完整rulesets或管理员保护端点核验、工作流重跑、Secret读取、生产访问或memory正文读取。因此不能据此宣称所有保护策略均不存在、全部代码正确或已完成CurrentToTarget逐文件映射。`main protected=false`至少说明不能把该分支的已启用保护作为本次冻结依据。

S15记录root skills含clued-continuity且未见clued-kernel-developer；这是特定位置历史观察，不是全机/全部仓库/各host安装的不存在证明。任何安装/弃用判断必须另取精确制品与运行入口证据。

冻结及迁移前必须再次绑定当前精确Commit/Tree；若main变化，重新评估受影响路径、Consumer及源摘要，不默默沿用本次观察。

## 3. 三个命名空间与候选目标结构

### 3.1 共同设计、强隔离

| 命名空间 | 可以保存 | 不保存/不拥有 |
|---|---|---|
| Repository / Design & Code | 合同/Schema、实现、受控非敏感配置、测试、机制和投影源码、工程Evidence引用 | 用户Canonical、生产Secret、开发运行租约的未经治理副本 |
| DCP Control | 工作项/claim/lease、审查关系、精确基线、阻塞、风险及Receipt导航 | 私人印记事实、用户token、业务付款权 |
| User Canonical / Bundle | 用户业务主记录及授权只读物化Bundle | 仓库当前开发状态、CI发布凭据、Agent工作分配 |

物理后端允许同一平台的不同隔离实例或不同平台，但必须证明namespace、tenant、role、credential、policy、manifest、pointer、ID、生命周期、保留与导出边界。仅有目录前缀不足以证明安全。

### 3.2 候选树

下列名称只是`CANDIDATE_TARGET_MAP_V0_1_1`的一致提案，不称已经存在或已经冻结：

```text
repository/
  AGENTS.md                         精确Authority Router最小入口
  CURRENT_STATUS.md                 生成投影，不是手工第二状态源
  README.md / VERSION               可读入口 / 各自类型轴
  protocol/                         保留既有定义；新增版本独立治理
  kernel/                           权威核心实现
  apps/ / cloud/                    产品与部署实现；本次不改行为
  config/                           Schema与非敏感样例
  scripts/ / tests/ / evals/         实际工具、E2E与最小回归
  .github/                          workflow/check约束投影
  docs/                             被审设计与历史索引
  artifacts/                        可入库的工程制品/引用
  legacy/                           明确兼容及历史角色
  development/
    contracts/                      DCP工作项/lease/status合同
    authority-index/                精确受审来源和Gate导航
    projections/                    从真实工程来源生成的当前状态
  mechanisms/                       厂商无关Mechanism源码（未来授权后）
  integrations/<vendor>/
    development/                    开发角色投影源码
    public-user/                    普通用户角色投影源码

DCP_CONTROL_STORE                   独立逻辑运行命名空间，单broker本地SQLite候选待接受
USER_CANONICAL_STORE                 用户业务唯一主记录
USER_BUNDLE_STORE                    私有只读版本投影
```

现有`memory/`与`skills/`不因为候选树少列就自动删除。前者在受控兼容期保持用户只读语义，任何抽离/历史清理另授权；后者在精确身份和旧新映射完成前保留原制品。迁移脚本不得按文件扩展名或“看起来旧”批量搬迁。

### 3.3 当前→候选目标责任地图

`data/StructureCandidateMap.json`有23条责任记录，覆盖根路由、状态、协议、内核、应用/云端、配置、文档、脚本、测试/CI、旧Skill、制品、memory、历史，以及新增DCP/Mechanism/角色投影等责任。每条保存旧职责、新owner、authority、读写、兼容、回滚与退役条件。

这些记录是路径/模式级候选，不是完整CurrentToTarget file manifest。后续需对所有实际文件、导入、脚本参数、CLI入口、测试、CI、文档链接、发布打包和用户导出consumer逐一展开；未映射项不允许静默忽略。

v3.3与仓库结构v1.1的旧Target分别作为历史设计来源，不再各自宣称当前最终目标。冻结前必须把三列并排：实测Current / 旧Target责任 / 唯一新Target，然后给每条KEEP/MOVE/COMPATIBILITY/RETIRE/DEFER及其理由和证据。此处不会把尚未完成的逐项展开冒称已完成。

## 4. 独立Development Control Plane

### 4.1 事实owner与投影

| 事实 | 权威来源候选 | 生成式投影的权限 |
|---|---|---|
| Commit/Tree/PR内容与合并 | GitHub/Git精确对象与审查记录 | 引用、校验、显示，不捏造merge |
| 实际CI执行 | 固定workflow/run/job/attempt及其Evidence | 聚合适用检查，不把无关queued suite当通过 |
| 某Agent当前获准的工作claim | 单writer DCP Control Journal及原子lease决定 | 显示owner/scope/期限，不能改JSON就自领权限 |
| 架构/结构/实施接受 | 精确外部决定＋适用authority | 状态路由，不改原候选正文 |
| 用户业务事实 | 用户Canonical/所属业务域 | DCP默认无权读取正文来“补状态” |

选择单writer逻辑控制journal，所有claim/renew/release操作进行`expected_revision`原子检查；具体后端本版提出单broker本地SQLite候选，仍待独立接受与真实资格验证。不默认新建数据库或Supabase工程，也不假设Git分支就是分布式锁。可用Git记录审计快照，但租约取得必须有可证明的唯一裁决。

### 4.2 WorkItem / WorkLease最小合同候选

WorkItem：work_id、program_id、stage_id、goal、scope/write_set、base_commit/tree、contract/version_vector、authorizations、owner_role/named_actor、lease_ref、dependencies、status_events、definition_of_done、budget、Evidence sink、rollback_ref。

WorkLease：dcp_work_id、actor、execution_context、allowed_write_set、base_revision、dcp_broker_generation、dcp_lease_version、dcp_fencing_stream_id/token、issued_at/expires_at、renewal_policy、revocation_epoch_vector引用、CAS receipt。并发抢同一write-set只允许一份有效claim；没有原子成功Receipt就无写权。子工作项可并行，但父子授权范围不能扩张，冲突资源保持互斥。

状态候选：DRAFT、READY、CLAIMED、RUNNING、BLOCKED、REVIEW_PENDING、ACCEPTED、CLOSED、CANCELLED，由事件投影。Claim只是工作分配，不是代码质量接受或生产许可。用户业务FSM不复用这套开发工作状态。

### 4.3 CurrentStatus与staleness

Status投影必须带generated_at、source_observed_at、source revisions/digests、authoritative refs、owner、scope、blockers、Evidence/PR/Gate导航和有效期限。lease过期、依赖改变、source不可读或latest无法核对时显示STALE/UNKNOWN，不用旧snapshot继续动作。

不固定一个全系统TTL数值；各类动作的freshness由风险Profile决定，在实施前接受并测试。配置缺失不能用无限TTL。开发工作日志写DCP，不写用户memory；开发知识可在脱敏和受控授权后另形成经验候选，不直接混入个人长期事实。

## 5. 责任转移与语义不变

每项转移必须回答旧职责、接管者、authority、读写路径、Evidence、Gate、Pointer、兼容和回滚。只有目录迁移完成，没有这些回答，判`BLOCKED / RESPONSIBILITY_TRANSFER_INCOMPLETE`。不得再次出现memory变成用户快照后开发协作无人接管。[S09 §9]

`ResponsibilityTransferClosureReceipt`至少绑定每条实际迁移记录、精确前后制品、消费者迁移证据、接受者及限制；`CanonicalSemanticNoChangeReceipt`证明结构改造没有改变用户Canonical、授权、状态机或序列化/身份语义。

语义不变不是“diff没有数据库文件”。应比较固定合同与Schema摘要、Rule/FSM/Gate映射、有效读写接口、fixture/真实E2E结果、输出与错误语义、权限、指针解析和幂等行为。结构变更引入业务语义变化时，停止将其作为纯迁移；另开不可变合同修订与独立授权。

## 6. 仓库迁移、用户Bundle升级和回滚批次

所有批次此时都未获执行授权。

| 批次 | 允许设计的变化 | 不能混入 | 必需退出证据 |
|---|---|---|---|
| B0只读盘点 | 完整目录/consumer/authority清单，排除私人正文读取 | 修改或删除历史 | 精确库存、差异/冲突图、已授权读取范围 |
| B1工程入口与索引 | 根router/status/typed refs，开发合同与投影位置 | G1自动切换、用户数据写入 | 前后摘要、机器/可读一致性、旧入口兼容 |
| B2必要路径迁移 | 已冻结CurrentToTarget列出的非语义移动 | 借移动改规则/模型/商业语义 | build/import/CLI/CI/packaging/链接的真实证据 |
| B3责任和控制cutover | DCP写入owner/lease、authority和pointer受控转移 | 新Skill默认Active | Responsibility及CanonicalSemanticNoChange |
| B4后续Mechanism/Skill | 仅在前三批与适用前置通过后独立授权 | 偷跳Shadow/旧新治理 | Mechanism、Projection、Shadow、治理、切换与弃用Receipt |
| U独立用户数据合同 | 数据需求证明后再设计/执行Bundle升级 | 与repo批次共享回滚命令 | 数据授权、双读/校验、scope/删除/恢复及用户迁移Receipt |

用户Bundle轻度（Schema/Manifest）、中度（增加对象/关系/索引）或重度（重新组织）尚未选择。现有Global/Project五视图优先保持兼容；只有实际读取需求证明不充分，才提出更重迁移。页面美观不构成改Canonical或重写用户目录的理由。

回滚分工程代码/控制指针与用户数据两类。工程回滚固定旧Commit/Tree、兼容入口、配置版本和control generation；不能顺便覆盖用户新数据。Pointer移动需CAS和当前批准；已公开或产生外部副作用的内容按HRPG处理，不声称目录回退即可完全撤销。

兼容窗口候选为cutover后至少14天且至少2个真实新入口任务、所有已知consumer确认；实际窗口、退役时点、支持者和容量仍须冻结前绑定；未知consumer阻断退役，不默认零天或永久支持。只读/停写窗口是否需要取决于经过接受的写路径方案，不能把本文件当停机授权。

## 7. 结构冻结Gate设计与当前阻断

必须先取得精确ArchitectureConstitutionAcceptanceDecision，含或绑定已接受HRPG及P2-ARCH-SKILL-COEXISTENCE-001范围。然后单独签Phase2StructureFreezeDecision，绑定接受决定摘要、唯一FrozenTargetMap、完整CurrentToTargetMap、责任图、typed vector、治理合同、兼容与回滚方案和所有适用关闭证据。

结构冻结需要的检查不是随意创造的新CI标签。应选出实际workflow文件/修订、job/check identity、触发范围、运行参数、Evidence摘要、失败行为、强制执行配置与可信issuer，并验证跳过/绕过不能造成接受。当前没有提供这些已接线证据。

GitHub多个候选reviewer并不自动等于多方会签，且私有仓库能力可能受套餐影响；不依赖未核实的套餐功能。可评估现有可用强制机制或外部等价门禁，但必须独立接受并验证其不能被普通开发动作绕过。该设计不授权升级账户、付费或改仓库保护。[EXT-01]

当前明确冻结阻断包括：完整递归Current/旧Target/新Target与consumer图未完成；实际required-check强制执行未绑定；DCP后端原子性与失败恢复尚未接受；具名职责/预算和治理接受未绑定；原Mandatory Closure Sets仍未独立关闭。**因此本包不是“结构冻结就绪”的证明。**

## 8. Mechanism、Skill和11项Readiness衔接

结构冻结只确定责任和目标，不提前冻结新的Development Mechanism实现。仓库/DCP整改和语义不变后，才能冻结厂商无关Mechanism，再投影两类Skill。共同安装能力是强制要求，但并非必须共用进程、数据或credential。

新投影必须真实Shadow/Comparative验证，核对旧Skill的职责、权力、authority读取、Gate、Evidence、恢复、人工治理及跨厂商一致性。切换和Activation使用精确revision pointer；旧clued-kernel-developer有单独DeprecationReceipt。找不到旧制品不产生N/A；固定计划修改必须新版本受审。

11项Readiness：

1. RepositoryDevelopmentMigrationReceipt
2. ResponsibilityTransferClosureReceipt
3. CanonicalSemanticNoChangeReceipt
4. DevelopmentMechanismFreezeReceipt
5. DevelopmentSkillProjectionReceipt
6. DevelopmentSkillShadowValidationReceipt
7. DevelopmentSkillGovernanceClosureReceipt
8. DevelopmentSkillCutoverReceipt
9. DevelopmentSkillActivationReceipt
10. LegacyDevelopmentSkillDeprecationReceipt
11. Phase2EntryDevelopmentReadinessDecision

以上本包全为NOT_ISSUED。Entry通过后仍需要各切片及模型M0自己的实施授权，不以排列顺序产生权限。

## 9. 测试策略与审查交接

STRUCT-01～08覆盖孤儿职责、旧路径漂移、混入用户数据、候选冒充current、lease竞争、stale、强制保护缺失及独立回滚；另消费COEX/HRPG和原RG适用集合。实际迁移须优先跑真实build/CLI/用户入口/开发路由E2E，不把本包文件一致性断言当运行证明。

审查者应先检查架构责任是否合理，再检查每个物理迁移记录可否安全实施。如果只能接受责任方案而证据不足，应分别报告`DESIGN_ACCEPTABLE_WITH_OPEN_ITEMS`与`STRUCTURE_FREEZE_NOT_ISSUED`，不能把限制藏在附件中仍签完整冻结。

当前作者交付结论：责任级结构准备候选形成，完整逐文件冻结包及迁移工程仍未完成。无需用户重新确认已给出的设计范围；下一步是本精确候选的独立审查和按审查意见补齐冻结前证据，而不是立即执行B1或M0。


## 10. 本版继承的库存与旧Target承接边界

本次交付`OldTargetDisposition.json`，逐行解析S06 §5和S12 §4中的每条旧目标路径，保留原行/层级/摘要并分配新的职责和候选处理。它证明旧目标责任没有整段丢弃，不证明旧图中每条路径今天存在。来源文档中的“已实现厂商”等时点陈述不外推为当前host资格。

`CurrentToTargetDesign.json`继承v0.2.1已经选取并绑定同一Commit的14个根Tree和7个精确workflow blob。后者可以展开已读工作流的命令引用，但尚未逐一取得package script、import/CLI/打包/文档/发布consumer全部字节；未知consumer显式保留为未解析节点，绝不写成零消费者。当前仍不是完整递归file manifest，也不声称全图无孤儿或FrozenTargetMap已经产生。

物理路径保持候选，不为漂亮目录做无必要改名；保留现有protocol/kernel等责任，新增DCP/Mechanism/role-projection逻辑界面。旧clued-operator、clued-continuity和clued-kernel-developer是不同命名，不因看似相近而合并身份。对厂商实际封装可保留原生布局，通过role manifest隔离职责；须有精确接受，不能先搬后解释。

## 11. exact checks、强制性与持久回执

本版继承前任对gitleaks、trivy、public-mcp-protocol、public-mcp-behavior、public-mcp-gate-receipt、memory-publication-gate、clued-g4-database七个工作流精确Git blob的观察；本轮读取七个工作流目录元数据，只重新取memory-publication-gate正文；其余正文为历史继承。身份包含path/blob/job/event及候选/基线SHA，不只取可伪造的显示名。数据库job_id与显示名不同，push触发仍限定历史功能分支而非main；memory检查有路径过滤。实际适用性由可信完整changeset和已接受规则判断，不把缺失、skipped或queued当执行通过。

候选要求一个始终运行的可信聚合器，显式核对依赖job实际结果、issuer、attempt、当前候选SHA、配置和原始Evidence。聚合器代码与强制策略尚未实现或安装。GitHub对skipped/neutral的显示语义不构成本项目真实测试PASS；这也是避免只看“四绿”标签的原因。[REV-EXT-CHECKS]

现有public-mcp-gate-receipt工作流只打印临时回执摘要，没有以该步骤证明完整回执被长期保存或签名。后续必须取得完整receipt、受控持久locator、bytes/digest及适用issuer信任链。新报告不补造原回执正文，不把hash当签名。

分支保护或独立强制门禁均需证明实际拒绝与旁路边界；外部门禁若只限制release消费，不能冒称阻止任意main push。套餐、管理员旁路和self-hosted隔离未经证明不作默认假设。[REV-EXT-ENV] 本次不更改保护或工作流，不新开CI运行。

## 12. DCP原子claim、租约与恢复候选

选择单active broker＋同机本地SQLite控制journal，事务内检查expected_revision、write-set互斥、幂等键和授权，持久提交后才回应claim成功。SQLite单writer机制支持该候选论证；WAL不作为网络文件系统多机共享方案。[REV-EXT-SQLITE-ISO; REV-EXT-SQLITE-WAL] 这里只是方案选择，不创建DCP数据库或第三方项目。

真正互斥不止是数据库有一行lease：所有副作用必须通过受控写端校验有效fencing token、owner、上下文、授权及期限。worker不能持有旁路写credential。续期只增加lease_version；重新获取/转移才增加同stream token。过期或失联只拒绝新写，不证明旧进程停止，不自动释放容量；保持draining/quarantined，取得可信停止/结果核对及CAS/Fencing证据后释放。此处继承S06 RUNNER-CAPACITY-01，不新增相反规则。

崩溃后先RECOVERING并核对inflight Intent/外部目标；备份恢复不得回退有效token/epoch后继续写，受保护高水位或新可信broker generation无法证明时保持只读阻断。10项故障情形及后续资格条件见DCPAtomicLeaseDesign。实际竞争、持久性、重启、target fencing和旁路验证全部未执行。

## 13. 缺口不是允许提前迁移的理由

MigrationEvidencePlan明确B0元数据/隐私范围、B1入口、B2路径、B3DCP与语义、B4Skill以及独立U用户数据各阶段的证据和授权来源。历史访问默认NONE，只提出最小审查范围，不借“泄露检查”全量打开个人记忆。原关闭集合保持，不把未来迁移当成本轮已经完成的证据，也不绕过先架构接受、后结构冻结。

FIX-05从v0.2.1继承的是责任/旧Target映射、选定current元数据、CI强制设计、DCP原子性和取证计划；完整Current/consumer图、实际强制证据与具名执行资源仍缺。本结构修订不申请立即执行迁移，也不是冻结就绪声明。

## 14. 资格测试隔离在结构中的落点与未取得证据

结构设计还必须给前Entry资格测试绑定独立controller、未激活候选Skill装载位置、测试主体/临时资源、凭据/进程/日志隔离、Evidence sink、停止与清理责任。Controller资格和被测候选资格不是同一对象，测试区不得写正式ACTIVE/default用户指针。具体当前叶子路径、所有消费者和唯一目标仍待完整盘点，本段没有宣称已经生成FrozenTargetMap。

前EntryProfile并不允许在结构冻结前迁移或运行测试。其启动需要有效R05–R10；新候选这里只给结构/治理审核者提供精确需求。Profile guard与阶段图的联合校验属于离线设计证据，不替代强制门禁、实际隔离、DCP原子性、历史访问审查或真实人员容量。

结构冻结仍由单独Phase2StructureFreezeDecision裁决，先绑定有效架构接受，再核实原8条件和完整Current/Target/consumer/责任/版本/治理/兼容/回滚证据。12项架构条件与8项结构条件重叠5项，不相加为20独立问题；跨阶段处置只能由有权者明示，本作者不减免任何原条件。

## 15. 稳定 Map 身份与产品设计消费者的新增接入

当前机器 target_map_id 与正文统一为 CANDIDATE_TARGET_MAP_V0_1_1。该逻辑 Map 的23责任行原样继承精确 v0.2.2，未改变其物理行语义；本文件修订 v0.1.4 和逻辑 Map 修订是不同版本轴。它仍是 CANDIDATE_NOT_FROZEN，frozen_target_map_ref=null。没有通过升级文件名制造一个新的 FrozenTargetMap。

ProductImpactAdoption 单独建立 PRU-I01–I10 对本版主文、Charter、结构、治理与原合同分配的设计消费位置；不把十个职责占位称为十个已发现的实现调用点。PRU-R06 仅由 DC01/DC05 承担原有责任：制品/版本与权益接口、当前使用记录/私人实例和必要迁移映射；实际 current/target 路径、唯一具名 Owner、接受记录仍待 CF05/OD10 完成。

本轮选定工程观察以 data/RepositoryEvidenceObservation.json 为准（旧RepositoryReadEvidence_v023仅历史），旧14根树观察只作为历史继承。七工作流目录元数据和四个既有成功 check-run 不形成全部门禁闭包。rulesets 查询不可用并不证明无外部门禁；完整当前叶子、旧Target、新Target、consumer、唯一责任、兼容窗、回滚与强制性仍需补齐。没有敏感载荷访问或真实迁移。

StructureFreezeEvidenceMatrix 原样承接 F-MAJ-001/003/004/011/014/016/017/018 及各原子条件，当前仅作冻结前准备，不签结构冻结。它要求有效架构接受的精确 ID/摘要/范围/当前有效状态；本字段未取得时不可用产品接受或作者检查替代。后续任何 Map 语义变化须新修订、完整差分及适用审查。

## 16. v0.2.5职责接收与仍未冻结的物理结构

本版新增10领域合同在逻辑职责层承接24商业差分。逻辑Map 23行与CANDIDATE_TARGET_MAP_V0_1_1不变；新设计对象字段不是已存在表、目录、服务或消费者。全部13设计接收目标可由ArchitectureIntakeCompletion核对；不能用其中13行冒充全运行consumer库存。

原8组28冻结条件逐字保留于StructureFreezeEvidenceMatrix。当前仍等待有效ArchitectureConstitutionAcceptanceDecision，未开展结构冻结实体裁决。原封包OBS在新包作者范围修复：根checksum只排除根自身，包含所有嵌套同名清单；这不是旧包字节被修好。

本文原S编号、旧Root Tree/工作流/资格说明在精确v024来源命名空间中解析。对应未修订合同以InheritedDesignContracts绑定，当前新对象和机器引用以CurrentArtifactRegistry为准。
