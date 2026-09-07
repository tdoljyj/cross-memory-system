# Clued Phase 2：Step 1 / Step 2 证据核对

核对日期：2026-09-07。依据：[每步验收与证据失效表](AcceptanceAndInvalidation.md)和[用户固定执行基线](FixedExecutionBaseline_20260907.md)。性质：已授权的技术核对与证据记录，Authority effect = NONE，不签发 Architecture Acceptance、Structure Freeze、产品 Release 或 Canonical 业务状态。

## 结论

**Step 1：限定 validation lane 的技术收口证据已核实，具备进入 Step 2 准备工作的技术条件。** 当前候选完整取回并自行重算身份；在本机使用原验证器复核四 Gate，全部 PASS；GitHub 原正例、四个定点负例以及 validation HEAD 的补充正例均已核对真实执行和回执。没有发现推翻该限定收口声明的冲突。

**Step 2：准备合同及本轮补充映射已核对，技术准入判定为 READY_FOR_NEXT_STEP，可进入 Step 3 的只读 Naming 盘点。** 结构候选、目标责任映射、迁移范围、语义边界与审查合同已从精确包中找出并保存；本报告第 1 节与第 3 节承接新增 Naming 范围及证据要求。原 40/28 条件保留在其原有验收阶段，不因 Step 18 的迁移后复验而延期。此判定不签发接受/冻结决定，也不表示 Step 3 已完成。

一个明确下一动作：**以包含本次补充的新源提交为对象，按现有九类 Scope 继续 Step 3，优先补全外部来源的元数据盘点与未知项处置。** 盘点候选的 CI 成功不等于九类全量收口。本次交付止于统一表、Step 1/2 核对及证据保全。

## 1. 本次对象与来源

| 对象/版本轴 | 确切值 | 解释 |
|---|---|---|
| main 工程观察 | `507c69b8f0638ff9202a4eeb140c606f9089e821`，tree `354e011fc68f3205e6a49708fd1e5f06037d025d` | 本轮远端查询与包内工程观察的 commit 一致；包内所选元数据并非完整当前库存 |
| validation 收口分支 | `59ed841b8264ea4e246d595bc425d44373cee615` | 原 CloseoutIndex 所在提交；实际补充正例 run 34069453639 |
| 本次受查 naming 分支 | `c39cfd68c09a5e970a2abcdbcb50a089a27b5ba5` | 验收工具/盘点输入的来源。相对 main 新增 11 个路径，未改原有实现；本次产物加入后此 commit 仍作为明确历史受查对象 |
| validation 语义候选/封包修订 | v0.2.7 / v0.2.7.1-manifest-repair | 不将外包版本自动当作内部逻辑对象版本 |
| 正式候选文件 | `Clued_Phase2_三轨修订与补证_完整审查候选包_v0.2.7.1_Manifest修复_20260906.zip` | 246612118 bytes，960 members；SHA256 `6e51374a6caedb4f84d2b6bb9fe05cd695b25732833f9d0217c341f17e1c1649`，本轮重新取回并自行重算 |
| 原包修订前任 | v0.2.7 原包，SHA256 `72b9481ebdedbe995a8073156679560163db3955f69da4509d9d488626e16c98` | identity 中明确登记；本轮未另下载这个旧外包，因此“修复仅改两个清单、所有 payload 相比旧外包不变”不在本次独立字节对比结论内 |
| 包内架构逻辑 Subject | `CLUED_ARCHITECTURE_CONVERGENCE_V0_2_5` | 由包内 ReviewSubjectContract、README、结构候选共同定义；保留原逻辑 ID，不机械随封包升号 |
| 架构唯一直接前任 | v0.2.4；`Clued_Phase2_三项设计候选_完整审查包_v0.2.4_20260905.zip` | 168491377 bytes，440 members，SHA256 `4aae92c37813772e983a14537be52ca8b428af666e644b72d40084ccd592d68b`；本地 Provenance gate 对嵌套原件实际复核 |
| Mapping 设计输入 | v0.4.3，SHA256 `18ed0482bfb639b4fcc8cdce45782b2649b127609f65286c7328cd143dc93dbd` | 本地 Provenance gate 复核；不是架构直接前任 |
| 结构准备文档 | `Clued_Phase2_结构准备设计_候选_v0.1.4_20260906.md` | 包内原文，SHA256 `ae858e6e25431f6464a9d5b1227bc439e9f2db792de33d4f9ed659a3270ad3a0` |
| 目标责任 Map | `CANDIDATE_TARGET_MAP_V0_1_1`，23 行 | 文档修订 v0.1.4；Map row revision v0.1.1；状态 CANDIDATE_NOT_FROZEN。不是 FrozenTargetMap |
| 新 Naming 范围 | `CLUED_NAMING_SURFACE_INVENTORY_SCOPE_20260907` | 精确绑定前任 validation 收口、当前外包摘要和九类表面；authority_effect=NONE |

**各版本轴并存并非自动冲突。** 上表与第 3 节共同构成本次准备输入的等价映射：精确 ZIP 提供原候选和治理合同；Naming Scope 以同一 ZIP 摘要及 validation 收口为前任输入；新固定基线和验收表规定接下来的顺序与检查方式。这是准备输入关系，不自动宣布旧候选已经通过新 Naming 规则、旧观察已覆盖新增路径，也不代替未来 Freeze Decision 的精确 subject 绑定。

正式外包仍由私库 Release `phase2-v0271-candidate-20260906` 的 asset `547244810` 提供。本次处理下载超时后从同一来源续传，完整摘要核对通过；没有更改、重新封包或发布该候选。两份正例都证明修复后的包内部完整性成立，未额外宣称旧外包差分已经重验。

## 2. Step 1：S01 核对结果

| 要求 | 结果与证据 | 未包含的声明 / 对下一步影响 |
|---|---|---|
| S01-01 精确对象与前任 | VERIFIED：外包大小/摘要/成员数；包内架构 subject、SourceLock、前任与 Mapping 的版本轴；本地对嵌套原件实际复核 | 旧外包修复差分仅 DOCUMENTED。它不改变已实测的当前包四 Gate 结果；本报告不以旧差分零变化作为新的准入证明 |
| S01-02 实现与运行绑定 | VERIFIED：7 个相关 commit 的 validator/harness/workflow/identity/source 精确 Git blob 一致；自行重算源码 SHA；run/job/receipt 来源与对象一致 | 这是已观察 GitHub 服务及当前 Git 对象范围的身份核对，不是正式不可绕过证明 |
| S01-03 四 Gate 正例 | VERIFIED：原正例 34069116734、HEAD 正例 34069453639 的真实执行与回执；本机只读复核四 Gate 全 PASS | 本地回执 GitHub 字段为 null，另以 LocalRecheckBinding 绑定源 commit、工具摘要、命令及 exit 0；不伪造 CI run |
| S01-04 定点负例 | VERIFIED：四个不同 case 的目标 Gate/实际失败原因/exit 1/基础包 before-after 摘要符合；原始回执与负例 manifest 自行重算一致 | 只证明四种定点防护，未声称规则的全部错误组合穷尽；变异大包未留存，保留原 harness、参数和负例说明，可依精确基础包重建 |
| S01-05 可重取与留存 | VERIFIED：5 个原 artifact ZIP、5 份回执、4 份负例 manifest 重新下载并重算匹配；HEAD 补充回执另存；本次精确副本保全至私库证据目录 | 旧 Library 副本未实读，仍为 DOCUMENTED；本次新增受控副本补充可取回入口，不改写原索引或复刻 Authority。HEAD artifact ZIP 摘要只来自 API，回执内容已自行重算 |
| S01-06 义务与入口 | VERIFIED（限定 lane）：最终 control=none；最后两次正例正常；历史红灯是预期负例；原 index 仅声明 validation lane；下表保留后续义务 | 收口不等于 40 项架构条件、28 项结构条件或产品运行已完成；允许准备 Step 2，不允许据此越过 Step 2 进入全量盘点晋级 |

### 实际运行明细

Gate 顺序为 Identity / Manifest / Provenance / ProductIncrementInput。

| Case | GitHub Run | 实际 Gate 结果 | 核对要点 |
|---|---|---|---|
| 原正例 | [34069116734](https://github.com/tdoljyj/cross-memory-system/actions/runs/34069116734) | PASS / PASS / PASS / PASS | 目标 gate step 实际执行，回执及 artifact 摘要自行核验 |
| identity 负例 | [34068788695](https://github.com/tdoljyj/cross-memory-system/actions/runs/34068788695) | FAIL / SKIPPED / SKIPPED / SKIPPED | 基础候选追加 24 bytes；大小不匹配，后续按规则停止 |
| manifest 负例 | [34068853770](https://github.com/tdoljyj/cross-memory-system/actions/runs/34068853770) | PASS / FAIL / PASS / PASS | 漏记 00_README.md，目标覆盖检查失败 |
| provenance 负例 | [34068945665](https://github.com/tdoljyj/cross-memory-system/actions/runs/34068945665) | PASS / PASS / FAIL / PASS | 错误架构前任摘要触发身份一致性失败 |
| product input 负例 | [34069016068](https://github.com/tdoljyj/cross-memory-system/actions/runs/34069016068) | PASS / PASS / PASS / FAIL | requirements 36 改为 37，计数一致性失败 |
| validation HEAD 正例 | [34069453639](https://github.com/tdoljyj/cross-memory-system/actions/runs/34069453639) | PASS / PASS / PASS / PASS | c39 与此 run 所用验证实现相同；本次补充证据，不改旧 index |
| 本地精确包复核 | 非 GitHub run | PASS / PASS / PASS / PASS | exit 0；本地原始回执及 source binding 一起保全 |

后续义务保持：包内独立整合审查待进行，40 项架构条件和 28 项结构条件未由本报告关闭，54 个产品 case 等未执行声明保留，实际运行消费者绑定未因输入 Gate PASS 从 0 变为已完成。这些是后续阶段的工作，不能混成“validation 四 Gate 失败”。

## 3. Step 2：S02 等价合同核对

先搜索仓库，再直接检查精确外包。包内原件保存于[证据目录](../../../artifacts/clued-validation/structure-freeze-prep/acceptance-20260907/step2/package-inputs/)，每份文件均有原包路径、大小、SHA256 和字节一致性记录。

| 要求 | 已核对的等价材料 | 准备要求状态及剩余范围 |
|---|---|---|
| S02-01 入口及精确 Subject | validation closeout；ReviewSubjectContract；SourceLock；结构主文；新 Naming Scope | VERIFIED：第 1 节明确包、逻辑 subject、Map、观察与新增 Scope 的关系；本报告作为准备补充，不签发新的已接受 subject |
| S02-02 当前/目标逻辑结构 | 结构主文 §§2–4；RepositoryEvidenceObservation；StructureCandidateMap | VERIFIED：main 所选现状和 23 行责任级候选目标。c39 相对 main 的 11 个新增控制路径及本次新增文件进入下一轮盘点；完整叶子库存不提前要求在本步骤完成 |
| S02-03 Naming/Namespace 范围 | 新 Naming Scope 九类表面、隐私排除和终态；结构主文三命名空间隔离及域职责 | VERIFIED：受控类别和排除明确；下方 P2-02 规定新增 Naming 的证据边界。具名 owner/delegation 留给 Step 4 |
| S02-04 历史兼容/新写边界 | 结构主文兼容与退役规则；Map 各行 read_write_boundary/retirement_condition；旧入口保持声明 | VERIFIED：准备合同明确历史读取、未来写入和旧消费者迁移前不得退役；实际封存尚未执行，是 Step 14 的职责 |
| S02-05 迁移边界 | 结构主文 B0–B4/U 分区、Map rollback/compatibility、原迁移证据计划引用 | VERIFIED：Repository/DCP 与独立用户数据迁移边界可定位；U 不因当前工作获准。旧批次仅作设计参考，实施顺序以固定 21 步为准 |
| S02-06 输入索引 | CurrentArtifactRegistry、SourceProvenance、SourceLock、包 manifest、新 Naming Scope | VERIFIED：原包索引保留；第 1 节与 P2-01 补充共同输入及角色，EvidenceManifest 绑定本次副本与外部 Git 来源。无需修改旧不可变包 |
| S02-07 语义不变边界 | 结构主文语义比较维度；Map 对 Canonical 不变、权限与回滚的约束 | VERIFIED：已有比较范围与禁止变化原则；P2-02 明确 Naming 不得绕过这些约束或借归一化隐藏语义变化。实际前后对照属于 Step 17 |
| S02-08 Review Evidence Contract | ReviewSubjectContract；FreshContextReviewHandoff；ArchitectureAcceptanceEvidenceMatrix；StructureFreezeEvidenceMatrix | VERIFIED：原 12 组 40 条架构要求与 8 组 28 条结构要求、独立性和 Authority 边界保持；P2-02 补充新 Naming 的证据类别，P2-03 保留原阶段义务并区分迁移后复验 |

上述 VERIFIED 仅说明对应准备合同已读取和核对，不把合同中的未来实现、审查或冻结要求标为已执行。

### 本轮完成的有限准备映射

**P2-01 输入关系。** 第 1 节的每个对象均保留原版本轴与角色：旧包 Registry/manifest 只证明其原包成员，新增 Scope/固定基线/验收表/本报告作为包外准备补充一起引用。现状比较点为 main507 的受限工程观察，c39 新增 11 个路径及本次新增路径进入新的盘点分母；23 行 Map 是责任级候选目标。精确摘要与来源由 EvidenceManifest、step1/code-bindings.json、step2/package-inputs/SOURCE_MAP.json 交叉定位。未来候选内容改变适用 I1；不能拿本次原对象上的准备结论直接接受不同候选。

**P2-02 新 Naming 对范围、语义及审查的补充。** 下表直接承接固定基线，不新增授权，也不要求在 Step 2 提前完成规则实现或 21×40/28 的全量逐项矩阵。

| 准备约束 | 本轮范围 / 禁止变化 | 后续必须提供的证据及首次使用阶段 |
|---|---|---|
| 覆盖分母 | Scope 的九类受控表面；只为盘点读取所需元数据，保留凭据值及私人正文排除；历史原件不改写。UNKNOWN 不冒充不适用 | Step 3 形成来源集合、完整枚举/分页、摘要、未知与适用性证明；新增文件也计入 |
| Namespace / Domain / Delegation | 三类顶层命名空间及目标责任域是候选边界；新命名不能自行授予 owner、能力或跨域解释权 | Step 4 提供具名归属和委托依据；Step 9 审查来源、作用域、撤销及冲突处理 |
| 版本轴 / 词汇 / Alias / 逻辑对象 / 表示 / 副本 | 六类身份分别解释；逻辑 ID 不机械随封包升号；历史名、duplicate suffix 和物理位置不生成新 Authority | Step 5 给出各自规则及关联，Step 7 投影检查，Step 8 正负例；Step 9 检查歧义与漏覆盖 |
| typed 及 Canonical 语义 | 结构变化不得改变身份、授权、义务、状态机、读写、序列化或消费者错误行为；alias/归一化不得隐藏 owner、scope、subject、version axis、前任、结果和权限差异。真语义变更停止作为纯迁移处理 | Step 6 当前合同/接线，Step 8 适用正负例；Step 17 比较固定合同/Schema、Rule/FSM/Gate、接口、fixture/E2E、输出/错误、权限、指针及幂等行为 |
| Review 输入与留存 | 新 Naming 证据按 E1–E6 绑定精确对象、工具/规则和来源；原 ReviewSubjectContract 的独立性及原 40/28 条件保持。数量不等于覆盖 | Step 8 锁定适用规则→检查→证据矩阵；Step 9 同时审查新 Naming 规则和原条件；Step 10/11 按各自原要求裁定。正式审查前不能用本准备表替代完整覆盖证据 |

**P2-03 原冻结前义务与迁移后复验。** F-MAJ-004 的四项原条件完整保留：exact required check set、branch/rules protection 或等价外部不可变 Gate Receipt、签名 tag/attestation 或透明签名制品、merged duplicate branch 清理及回执。原 28 条仍在 Architecture Acceptance 后分别裁定并于 Freeze 前满足；本报告不把其中任何一项延期到 Step 18，不把纯设计描述充作其要求的执行证据。Step 18 对迁移后的实际入口另做 fresh 不可绕过证明。两者可并存；保持原义务不需要先签延期决定。若以后发现某条原条件只能依赖迁移后结果，或确需改变原义务，应在受影响的接受/冻结之前提出明确问题并由既有有权角色处置，不能自行豁免。

据上述等价材料与有限补充，S02 的八项**准备条件**均已核对，本次技术准入结论为 **READY_FOR_NEXT_STEP（仅进入 Step 3 的既定范围）**。未来完整规则矩阵、运行证据和独立审查仍在对应步骤验收；它们尚未发生不构成本步骤的失败。保全的子报告保留核对过程及较早暂定判断，最终准入判断以本主报告的明确范围为准。

## 4. 证据保全与本次变更的失效影响

证据根：[acceptance-20260907](../../../artifacts/clued-validation/structure-freeze-prep/acceptance-20260907/)。EvidenceManifest.json 记录全部保全文件及本次文档摘要。Receipt/负例 manifest/五个 ZIP/包内选定治理原文保持来源字节；API 元数据是本次工具返回的语义快照，不声称原始 HTTP 报文。

根验证器、harness、workflows、候选 identity/source、旧 closeout index、历史产物和只读 memory 快照均未修改。本次仅新增执行补充、核对证据、原文保全和文档导航。两个新增目录单独关闭文本换行转换，保证原件及所登记摘要对应的字节在 Git 往返后仍一致；不改仓库全局属性。

按 I1/I8，本次新增路径改变仓库命名表面。因此 c39 的盘点结果仍证明原对象上的扫描，不再冒称覆盖新增文件后的全部当前路径；后续盘点需取含本次提交的新源对象重新生成。它不改变原 validation 外包或验证器，也不使历史四 Gate 实际发生的结果消失。

原工作区遗留的 V17 ZIP 未提交差异没有被更改。本次在现有 naming 分支的独立干净副本制作，向该分支持久化；未合并 main、未打产品 tag、未发布新 Release、未做服务/数据库/用户数据写入。

## 5. 核对限制

- 本轮不是基线 Step 9 的正式独立审查，未对全部业务合同或运行安全作完整评估。
- 未验证旧 Library 副本、未重新比较 v0.2.7 原外包与 manifest 修订包；这些边界在 S01 明确，不扩大 current candidate Gate 结论。
- 原四种定点负例使用已核验的真实 CI 证据，本轮未无理由重跑全部负例；本地额外运行的是精确候选的四 Gate 正例。
- 历史 memory 镜像校验通过但 freshness=historical，仅用于上下文，不作为 Phase 2 当前进度依据；本次报告不写入 Canonical 业务状态。
