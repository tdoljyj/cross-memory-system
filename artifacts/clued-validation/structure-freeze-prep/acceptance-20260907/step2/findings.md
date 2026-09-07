# Step 2 等价证据核对：仓库 + 精确候选包

> 更新：已完成精确候选包中治理资料的限定读取。下方原“仓库部分”的 UNKNOWN / MISSING_WITHIN_SEARCH 是包内读取前的阶段记录；最终应以文末“包内核对后的更新判定”为准。包内存在实质等价资料，不能继续声称没有目标结构、Namespace 划分、迁移范围或语义不变合同。

核对日期：2026-09-07。本报告只核对指定 Git 候选中的文件和定义，不签发 Acceptance、Freeze 或 Step 2 PASS，不把文档中的状态声明升级为真实执行证据。

## 范围与状态语义

- 只读副本：`C:/Users/Windows/Documents/Codex/2026-09-07/ni-6/work/phase2-governance-check`。
- 本地精确 HEAD 已核对：`c39cfd68c09a5e970a2abcdbcb50a089a27b5ba5`；tree：`f686f0e78f99776a7e8969ce9d34d7f5d716419f`；工作树 clean。
- Scope 引用的前任：`59ed841b8264ea4e246d595bc425d44373cee615`。远端/同步的新鲜核对由父代理独立持有；本子报告不复制或复用其 RequestVerificationContext，不作 Canonical 当前进度认证。
- 按要求先读根 `AGENTS.md`。未以仓库 memory 快照或历史私人记录作为 Step 2 证据。宽关键词搜索发现一个历史 dry-run 包含预览字段后，将其加入后续排除；未引用或沉淀其中内容。
- `VERIFIED`：本子任务实际核对了限定命题的文件内容、绑定或哈希；不表示整个步骤执行 PASS。
- `DOCUMENTED`：有可复用定义/声明，但本轮所需精确范围绑定、覆盖或实施证明不足。
- `UNKNOWN`：所需来源在外部或包内，尚未读取，不能断言存在或缺失。
- `MISSING_WITHIN_SEARCH`：在已搜索的仓库非 memory 文件中没有找到等价证据；不是全局不存在。

依据用户的 21 步基线 Step 2 第 95–103 行的九项主要工作逐项核对。建议文件名不是强制产物名；下面按语义和证据绑定判断。

## 九项核对

| Step 2 要件 | 状态 | 可复用的具体证据 | 尚待证明 / 阻断条件 |
|---|---|---|---|
| 精确 Freeze Subject | DOCUMENTED；包内补证 UNKNOWN | `NamingSurfaceInventoryScope.json:3–15` 固定 record、repo、前任 validation commit/run 和精确候选 SHA；`candidate-identity.json:2–22` 有文件名、字节数、成员数、semantic candidate、package revision、前任包和修复边界；`candidate-source.json:4–40` 有唯一 Release Asset ID、哈希和 Library 副本绑定。 | 这些绑定的是 validation lane 候选和命名盘点输入，尚未找到一份将本轮 Freeze 精确 subject 与这些输入明确关联、并覆盖目标结构的等价合同。`data/ReviewSubjectContract.json` 在外部候选包，待读，不能按未展开误判缺失。 |
| 当前与目标逻辑结构 | DOCUMENTED（局部现状）；目标映射 MISSING_WITHIN_SEARCH | `README.md:20–34` 描述当前 memory 导出目录及 representation 边界；根 `AGENTS.md` 定义 Canonical Store、只读快照、写路径。`protocol/continuity/v1/contracts/directory-layout.md:3–12` 只提供 v15 的规则投影与声明边界；`protocol/.../manifest.json` 的 scope 为 `V15_G1_LOCAL_MACHINE_CONTRACT_ONLY`。 | 不能把 memory 目录合同或 v15 条件性协议当作本轮 Repository / Development Control Plane 的完整目标结构。需可定位的 current → target 逻辑对象/控制面边界映射；包内若存在，应精确复用。 |
| Naming Surface 范围 | VERIFIED（范围合同存在且内容明确；非盘点完成） | `NamingSurfaceInventoryScope.json:25–70` 明确九类必需表面：tracked paths、selected text identifiers、GitHub metadata、人/Agent 入口投影、Library metadata、Supabase identifiers、Cloudflare/deployment identifiers、Skill/mechanism/adapter/provider、Candidate/Decision/Evidence/Receipt/Authorization。`:72–99` 定义隐私/凭据排除及终态、禁止收口状态。 | 可直接复用为 Step 2 的 naming scope。范围的存在不表示 Step 3 已覆盖全部来源，也不替代目标结构、语义边界、Review 合同。 |
| 本轮受治理 Namespace | DOCUMENTED；枚举绑定 MISSING_WITHIN_SEARCH | Scope `:19–21` 给出单 Owner 的目标规则、跨版本轴禁止推断、未知解析 fail closed；`:25–70` 给出需发现的服务/对象表面；扫描器 `:61–69` 定义若干阶段 token 的识别式，`:77–85` 涵盖 namespace/domain/program/stage 字段。 | 未找到本轮 Namespace 的枚举或明确可判定的成员范围、当前/未来/历史适用范围。扫描模式不是 Namespace Ownership，也不是治理范围的完整证明。Step 2 无需提前完成 Step 4 的授权闭合，但必须先能判断哪些 Namespace 属于本轮。 |
| 仅历史兼容、不再新写对象 | DOCUMENTED（规则与部分已有类别） | 根 `AGENTS.md` 的 Authority/storage 和 Canonical writes 段定义仓库 memory、legacy 对象及旧本地写路径；`README.md:34,45` 和 `docs/README.md:14–17,27` 区分历史资料与当前事实；Scope `:22` 禁止改写历史字节，`:84–90` 包含 `SEALED_HISTORICAL` / `READ_ONLY_COMPATIBILITY`。 | 规则可以复用，但尚未找到与本轮 Freeze Subject 绑定的具体对象/类别清单、兼容读入口和新写目标边界。此项只要求准备阶段明确边界，不代表现在就执行 Step 14 关闭旧写入口。 |
| Repository / Development Control Plane 迁移边界 | DOCUMENTED（禁止动作边界）；目标正向范围 MISSING_WITHIN_SEARCH | Scope `:15–23,101–108` 明确本轮只盘点，不授权 rename/migration、Registry Root Catalog、Acceptance、Freeze、Skill；扫描器 `:4–10,758–765,873–881` 同样限制；工作流 `:154–173` 静态检查输出不能声称发生迁移或越过只读边界。 | “当前不得迁移”不等于“已定义将来迁移什么”。需本轮目标仓库/控制面正向范围、排除项和 current → target 的预期转换边界；不能自行从源码目录推定。 |
| Freeze Preparation 输入 Registry | DOCUMENTED（若干强绑定输入可复用）；完整注册表 MISSING_WITHIN_SEARCH | Scope `:8–15` 绑定前任；`candidate-identity.json`、`candidate-source.json`、`ValidationLaneCloseoutIndex.json` 提供输入身份和证据引用；扫描器 `:839–856` 定义 source lock（repo/branch/commit/tree/scope/scanner hashes）；工作流 `:149–182` 检查绑定和产物哈希。 | 不要求新建一个特定命名 Registry，也不必重造上述输入。需要把本轮 Freeze 所需输入集合明确列出并绑定其角色、身份、版本、前任、引用范围和未决项；现有来源分散，未找到完整聚合合同。 |
| 禁止改变的 Canonical Semantics | DOCUMENTED（既有不变量）；本轮精确边界 MISSING_WITHIN_SEARCH | 根 `AGENTS.md` 与 `README.md:7–10,34,45,49` 定义唯一在线 Canonical Store、只读投影、正式认证写路径、Event/Receipt、禁止双写；`protocol/continuity/v1/README.md:13–17,34–40,63,201–212` 明确已有 Bundle 合同不能原地改写、未来协议不自动证明实现。 | 这些是有价值的稳定输入，但尚未找到与本轮 Freeze Subject 绑定的 accepted semantics/权限/consumer obligations 清单、允许物理变化和不能归一化忽略的字段，以及比较前基线。无需在 Step 2 提前运行 Step 17，但应提前固定其比较边界。 |
| 独立 Review 的 Evidence Contract | DOCUMENTED（validation/provenance 机制）；结构 Review 合同 UNKNOWN | `scripts/phase2-v027-validate.py:136–168` 读取包内 SourceProvenance、SourceLock、PredecessorPackageBinding、MappingAcceptanceIntake、ReviewSubjectContract 并比较直接前任、映射输入和原始副本；`ValidationLaneCloseoutIndex.json:5–7,221–229` 限定 validation lane 与无 Authority 效果。 | 不能把 Step 1 的 validation provenance 合同直接等同为本轮 Step 9 的 Structure Review Evidence Contract。应读取包内 ReviewSubjectContract 和相关规则，核对是否明确本轮 subject、独立审查范围、所需输入、结果状态、finding 处置与 Authority 边界。 |

## 重要解释

1. `NamingSurfaceInventoryScope` 已是实际可复用的 Step 2 输入，不应该因为没有叫 `StructureFreezePreparationManifest` 就全部推倒重做。
2. 该 Scope 自述 `FIXED_INPUT_FOR_STRUCTURE_FREEZE_PREPARATION`、`authority_effect=NONE`，其内容不能单独证明 Step 2 整体准备完成。
3. Scope 的终态允许 `MIGRATED / REMOVED / SEALED_HISTORICAL`，同时 `renaming_or_migration_authorized=false`；这不自动构成矛盾。可用于记录先前已经发生且有证据的现状，但不能由盘点器凭该终态列表获得新迁移/删除/封存权限。应在实施口径中明确这一区别。
4. 此轮未重跑盘点器，也未使用父代理的 CI PASS 替代本轮静态证据。源码 `:843` 明确输出 `INVENTORY_CANDIDATE_NOT_CLOSEOUT`；`:823–835` 明确外部三类快照为 pending 的输出逻辑。实际运行产物的状态和覆盖由父代理的独立证据核对负责。
5. 仓库 `structure-freeze-prep/` 当前仅跟踪 Naming Scope，按语义搜索也未找到完整 Step 2 聚合合同；但外部精确候选包含更多资料，故总判断为“Step 2 准备门槛尚未被本子报告证明”，不是“Step 2 已失败”或“所有准备材料不存在”。

## 搜索范围与未读范围

- 枚举非 memory 的结构/命名/架构/迁移相关文件及 ZIP 路径；搜索 `StructureFreeze*`、`SemanticNoChange*`、`MigrationScope*`，并搜索相应自然语言语义词，不仅按建议文件名判断。
- 重点读：根 AGENTS/README/CURRENT_STATUS、docs 导航、Phase 2 candidate identity/source/closeout index、Naming Scope、两份验证/盘点脚本相关段、Naming 工作流、protocol 目录合同与声明边界。
- 不以 `CURRENT_STATUS.md` 的 2026-08-25 声明或旧 R3/R5 文档作当前 Phase 2 状态事实；它们至多是待清理的投影/历史分类输入。
- 目录枚举显示仓库跟踪 `artifacts/v17-audit-inputs-20260904/Clued-Kernel-Next-V17-Local-RC-20260903.zip`；未读该包，不将其名称或内容猜测为本轮目标结构证据。
- 外部精确候选：Release Asset `547244810`，预期 `246612118` bytes、`960` members、SHA-256 `6e51374a6caedb4f84d2b6bb9fe05cd695b25732833f9d0217c341f17e1c1649`。本子任务提交此版时未读该包；父代理正在下载和核验，包内结论须另行补充。
- 包内重点待查路径来自实际 validator 代码：`data/ReviewSubjectContract.json`、`data/SourceLock.json`、`data/SourceProvenance.json`、`data/PredecessorPackageBinding.json`、`data/MappingAcceptanceIntake.json`；以及由包内目录表定位的结构、迁移、语义与 Review Evidence 文件。不得仅因路径存在就视为要求已满足。

## 本轮计算的主要来源 SHA-256

| 路径（相对指定副本） | SHA-256 |
|---|---|
| `AGENTS.md` | `75d0788ff62a20d2d211115a66ab20fc38519a14fad890ab9a3d6f821e821793` |
| `README.md` | `d5f6ec6e821b9b1c71b0433e072804f48109ff55fc53f52b3a088b4205ecdaff` |
| `CURRENT_STATUS.md` | `af52a717b2c37ebabf81a7123244aa3dd9a91042ea87037fd026925e8111f722` |
| `docs/README.md` | `f26b990489b1093a80080e75421daea03adbaa0064fcb44da51326362bdd77e0` |
| `artifacts/clued-validation/structure-freeze-prep/naming/NamingSurfaceInventoryScope.json` | `e8209cd50d6e066bf0b64b93c7c634816cf381a289c3dcd7cc8dda9cbac43af0` |
| `artifacts/clued-validation/phase2-v027/candidate-identity.json` | `b9378cc1c40fe196b2c2496464e7a19e0af783078c2f08ac35a5bc242735a9f9` |
| `artifacts/clued-validation/phase2-v027/candidate-source.json` | `b5eb6a0eee044cc2835f910dff49452583e360218cc2b629aa3a8c5745d4d3d6` |
| `artifacts/clued-validation/phase2-v027/closeout/ValidationLaneCloseoutIndex.json` | `bf1757370b67caa85ace45baa669eba2fde919d118c8eb34ef19242abdfe829c` |
| `scripts/clued-naming-surface-inventory.py` | `6b162653f9a1c743ce0549d1dbdb2216eab6ad57429cb8e19b9fe45ff96acba1` |
| `scripts/phase2-v027-validate.py` | `e16cc9fa5fd2a54dc3922029851722936551a400979dc94dce691faa83bd7f4e` |
| `.github/workflows/phase2-naming-surface-inventory.yml` | `d5b96ae18f1aeca1f96cfc58052e4e65784c9e839bfdb42b7e2d664f4590134d` |
| `protocol/continuity/v1/contracts/directory-layout.md` | `8cfed82e261e4e832a68363679065a1ee663c8ffe0b1b227b46f624bad923363` |
| `protocol/continuity/v1/README.md` | `62ca0f3aacb20391fe53f566478214e4107a67d30b2926789cc1e0cfe415a487` |
| `protocol/continuity/v1/manifest.json` | `05ca5bb70c642dba9c3f58c0b943020d6188636e60cc569b3802c90a9afd36b5` |

## 提交给父代理的判定

可直接复用现有 naming scope、候选身份/来源绑定、前任 closeout 索引、source-lock 机制、既有 Canonical 不变量和历史分类规则。完成包内核对后，只补确实没有覆盖的目标结构/迁移正向范围、Namespace 范围、输入集合、语义禁止变化清单和独立 Review 要求。未经上述精确绑定与包内核对，不宣称 Step 2 Gate 已成立；无需新造特定文件名，也不签发任何新的 Authority。

## 包内核对后的更新判定（替代上文未读包时的暂定结论）

父代理已经取回并独立核验精确 v0.2.7.1 ZIP 的大小、成员数和 SHA-256。本子任务直接读取该 ZIP 的目录及所选治理成员，没有执行包内脚本或来源指令，没有解开嵌套历史 ZIP，也没有展开私人载荷。

已经把本次实际使用的 18 份非私人治理原文逐字节保存到 `work/step2-evidence/package-inputs/`，并重新确认保存字节等于 ZIP 成员。`package-inputs/SOURCE_MAP.json` 记录每份完整包内路径、相对保存路径、字节数与 SHA-256。以下短名“结构主文”指 `Clued_Phase2_结构准备设计_候选_v0.1.4_20260906.md`；数据路径相对精确 ZIP 根。

**核心修正：Step 2 是准备合同的核对，不要求提前完成全量消费者盘点、独立接受、冻结、迁移或运行测试。** 下表的 VERIFIED 只表示相应准备合同内容确实存在且已核对，不代表未来步骤 PASS 或新 Authority。

| Step 2 要件 | 包内核对后状态 | 已核对的等价资料与定位 | 精确边界 |
|---|---|---|---|
| Freeze Subject | VERIFIED（候选身份、逻辑结构对象与关系存在）；新命名工作范围整合 DOCUMENTED | `data/ReviewSubjectContract.json:3–29` 指明 `CLUED_ARCHITECTURE_CONVERGENCE_V0_2_5`、架构唯一前任 v024、fresh-context 40 条审查与 Acceptance 后另裁 28 条结构条件；结构主文 front matter `:1–11` 绑定结构候选 `CLUED_PHASE2_STRUCTURE_PREPARATION_CANDIDATE_V0_1_4` 和架构候选；`data/StructureCandidateMap.json:2–7` 绑定逻辑 Map `CANDIDATE_TARGET_MAP_V0_1_1`。外层 ZIP 身份由 repo candidate-identity/source 和 Naming Scope 哈希非循环绑定。 | ReviewSubjectContract 是架构候选的审查合同，不只是 Step 1 验证报告；但也不是已成立的 Freeze Decision。稳定逻辑 V025、结构文档 v0.1.4、Map v0.1.1 和 ZIP v0.2.7.1 是不同轴，不能因号不同直接认定错绑。新 Naming 范围的受审输入集合需要在父报告中明确承接，不能以旧 40/28 条自动证明新 Naming 规则均已验收。 |
| Current / Target 逻辑结构 | VERIFIED（责任级准备设计） | 结构主文 `:22–41` 固定观测的 main commit/tree 与限制；`:55–95` 有候选树和 23 行当前责任→目标责任地图；`data/StructureCandidateMap.json:8–423` 是 23 行实质记录，含旧职责、目标、owner domain、读写、兼容、回滚与退役条件。 | `complete_current_file_inventory=false` 是其真实成熟度，不因此判 Step 2 没有逻辑结构。完整叶子与消费者展开属于后续盘点/冻结前证据，不得被冒称现已完整。 |
| Naming Surface | VERIFIED（范围合同） | repo `NamingSurfaceInventoryScope.json:25–99` 的九类表面、排除、终态/未知规则；包内结构主文 `:89–95,193–199` 要求导入、CLI、脚本、测试、CI、链接、打包及发布等消费者逐一展开。 | 范围定义不等于 Step 3 全量覆盖 PASS。 |
| 受治理 Namespace | VERIFIED（准备阶段的顶层逻辑范围） | 结构主文 `:43–53` 明确 Repository / Design & Code、DCP Control、User Canonical / Bundle 三命名空间的允许数据与禁止归属；`:82–84` 明确 DCP_CONTROL_STORE、USER_CANONICAL_STORE、USER_BUNDLE_STORE；Map 的 `new_owner_domain` 给出 ROOT_ROUTER、DCP、AUTHORITY_CORE、PRODUCT_PROJECTION、PLATFORM、DEVELOPMENT、MECHANISM、USER_DATA 等责任归属候选。 | 不要求 Step 2 已完成所有叶子 namespace 所有权和 delegation；那是 Step 3/4 工作。顶层责任域设计不冒充已具名授权。 |
| 历史兼容 / 非新写对象 | VERIFIED（类别与准备约束） | 结构主文 `:87–95,195–199` 明确现有 memory/skills 不因目标树省略而删除、legacy 旧规则与历史责任保留、逐条 KEEP/MOVE/COMPATIBILITY/RETIRE/DEFER；Map TM-09、13、14、15、16 规定历史设计、旧 Skill、artifact、memory 和 legacy 的候选处理。`SourceProvenance.json` 的 interpretation 与 744 个 source copies 明确历史源在各自原 namespace 解释。 | 只是明确如何分类/保留历史；未执行 Step 14 旧写口封闭。 |
| 迁移边界 | VERIFIED（准备合同） | 结构主文 `:133–150` 把 B0 盘点、B1 工程入口、B2 必要路径、B3 DCP/责任 cutover、B4 Mechanism/Skill 与独立 U 用户数据合同分开；每批列允许变化、不能混入事项和退出证据。`:18` 限定本包只编制、不移动、不写数据库/Bundle；`:147–150` 分离工程回滚与用户数据。 | 批次是设计参考，不授权现在执行，也不得取代用户新固定的 21 步顺序。私人数据迁移不纳入仓库迁移的隐含授权。 |
| 准备输入 Registry | VERIFIED（已有等价注册机制） | `data/CurrentArtifactRegistry.json:1–5` 与 `/artifacts` 注册 52 个当前设计/审查对象及字节/哈希/role；SourceLock、SourceProvenance、PredecessorPackageBinding、MappingAcceptanceIntake 绑定架构前任、映射输入、来源包与引用；StructureCandidateMap 指向 StructureFreezeEvidenceMatrix、RepositoryEvidenceObservation 和设计接收关系。 | 可复用这些来源而不重造 Registry。Naming Scope 是后来的新增输入，应与这组来源在验收表中列为同一准备范围的输入；不能因为较早 Registry 未收录后来 repo 文件就修改旧不可变候选。 |
| Canonical Semantic No-Change Boundary | VERIFIED（准备合同） | 结构主文 `:125–131` 明确禁止改变用户 Canonical、授权、状态机、序列化/身份语义；比较固定合同/Schema、Rule/FSM/Gate、读写接口、fixture/E2E、输出/错误、权限、指针和幂等行为；有语义变化则另开不可变合同修订，停止当纯迁移处理。 | Step 2 有明确的语义禁止变化边界；具体 before/after 证据留给后续验证。不能因这些运行证据当前未执行，倒推 Step 2 边界缺失。 |
| 独立 Review Evidence Contract | VERIFIED（既有架构/结构审查合同）；新 Naming 全覆盖映射 DOCUMENTED | ReviewSubjectContract `:18–29`、`review/FreshContextReviewHandoff_v025.md:3–17,28–30`、结构主文 `:152–160,184–191,201–209,231–247` 定义精确对象、独立审查、真实 issuer/run/job/attempt/evidence、28 项结构条件与不冒签边界；StructureFreezeEvidenceMatrix `:18–104` 保留 8 组 28 条，ArchitectureAcceptanceEvidenceMatrix 保留 12 组 40 条。 | 这些是实质准备证据，不因独立 Review 尚未执行而判缺失。但原 40/28 条与用户新 21 步中的 Naming、Alias、Copy、typed identity 全面要求并非天然一一等价；新审查应附需求→证据映射，避免仅复用旧条件数量声称覆盖。 |

### 观测版本的边界核对

包内 RepositoryEvidenceObservation 绑定 main `507c69b8f0638ff9202a4eeb140c606f9089e821` 与 tree `354e011fc68f3205e6a49708fd1e5f06037d025d`。本子任务本地核对 `507c69b..c39cfd6` 的名字级 diff：只有 11 个新增路径，分别为两份 Phase 2 workflow、三份验证/盘点脚本及六份 validation/Scope 输入；没有修改原有目录/实现文件。它解释了旧观测与现分支的差别，但不把旧 selected-current 观察升级为现分支完整扫描。新增的这些命名表面应进入当前盘点。

### 剩余事项如何归属

- **属于准备证据整合**：父报告应显式列出精确 ZIP → V025 架构 subject → v0.1.4 结构文档 → v0.1.1 Map → main507 观测 → c39 新增控制文件 → 20260907 Naming Scope 的关系；并将新 Naming 的审查要求附到已存在的结构 Evidence Contract。无需伪造一个已签 Freeze Subject 或修改旧候选。
- **属于 Step 3–11，不能提前拿来阻断 Step 2 的合同存在性**：完整叶子/消费者盘点、具名 namespace owner/delegation、身份闭合、投影实现、Validator 正反例、独立审查、Acceptance、FrozenTargetMap。
- **属于后续实施，不能提前要求做完**：DCP 原子性/恢复实测、真实迁移、Enforcement、回滚演练、全部未来 Gate 和 Skill。
- 本报告没有替父代理判断是否已完成“新 Naming 范围与旧候选的全部适用性整合”，但明确纠正“目标结构/迁移范围/语义边界都不存在”的过严推断。**九项准备要件均有可定位的实质合同输入；整体 Step 2 是否可记 VERIFIED，应按这一组等价证据的共同范围绑定判断，而不是要求未来步骤先 PASS。**

### 精确跨阶段适用问题：F-MAJ-004 与新 Step 18

**应标 `DOCUMENTED / CROSS_STAGE_APPLICABILITY_UNRESOLVED`，不可自动认定互相矛盾，也不可由作者把原条件豁免到 Step 18。**

- 包内 `data/StructureFreezeEvidenceMatrix.json:40–49` 的 F-MAJ-004 原四条件是：冻结 exact required check set；配置 branch/rules protection 或等价外部不可变 Gate Receipt；采用签名 tag/attestation 或透明签名制品；清理 merged duplicate branch with receipt。其原子条件未关闭，state 为 `RETAINED_PENDING_VALID_ARCHITECTURE_ACCEPTANCE_THEN_SEPARATE_ADJUDICATION`。
- 结构主文 `:231,241,247` 明确冻结需核实原 8 组 28 条，不允许自行减免。新 21 步基线则在 Step 18（原文 `:991–1024`）要求迁移后真实控制面的不可绕过证明。
- **可并存的解释**：冻结前已经存在面向受审候选/既有入口的可信检查集、保护或不可变签名证据；迁移完成后，Step 18 再对新的实际入口验证该约束没有失效。新 Step 18 是最终目标结构上的新证明，并没有明确禁止冻结前建立其他保护。因此不能只凭“都提 required check”判定循环依赖。
- **仍需明确的地方**：F-MAJ-004 每一原条件究竟面向 pre-freeze candidate、旧运行入口，还是迁移后的正式入口；各自所需证据、生效范围与重跑条件。如果把旧条件解释为必须先证明“迁移后的全部正式入口不可绕过”才能 Freeze，就会依赖 Step 12–18；该解释不能由本报告擅自采用。
- **未发现已签的逐条件处置**：`data/ArchitectureAcceptanceEvidenceMatrix.json` 明示 `authorized_stage_dispositions_issued=0`；`review/DecisionTemplates_NOT_ISSUED.json:22–39` 的 ConditionStageDisposition 是未签空模板。`data/AuthorizationRequests_NOT_GRANTED.json:207–245` 的 `AREQ-STAGE-DISPOSITION` 也为 NOT_GRANTED，且仅列 F-MAJ-007/C2、F-MAJ-017/C3、F-MAJ-018/C3、F-MAJ-018/C4，没有 F-MAJ-004。不能拿这份未签请求当成把 F-MAJ-004 移到 Step 18 的授权。
- 此项是 **Step 2 需要显式记录的 Evidence Contract 适用性问题**，并可能阻断后续按完整原条件签发 Freeze；它不是要求此刻实施保护、签名 tag 或删除分支。先在本轮验收表说明前置条件与最终证明的适用范围；若实质改变原条件，必须由具备权限的明确决定处理，不能由盘点或研究报告代签。
