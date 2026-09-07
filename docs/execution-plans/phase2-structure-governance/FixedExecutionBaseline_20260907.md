# Clued Phase 2 结构治理与 Naming Integrity 固定执行基线

> 文档状态：**FIXED EXECUTION BASELINE**  
> 当前精确位置：**Step 1 — `phase2-v027-validation` 最后收口**  
> 适用范围：Clued Phase 2 的结构治理、命名完整性、Repository / Development Control Plane 迁移、Gate 重跑以及 Developer Skill / User Skill 的进入顺序。  
> 核心约束：**以下 21 步不得擅自压缩、重排、跳步，也不得把后续步骤提前描述为已完成。**

---

## 0. 这份基线解决什么问题

Clued Phase 2 当前不是直接进入大规模实现，也不是先搬仓库、再补治理。

这一阶段的目标是：

1. 先把当前真实候选、命名、命名空间、逻辑对象、版本轴、表示方式、复制身份和 typed identity 全部闭合；
2. 再证明 README / AGENTS / Status / Manifest / Registry 等公开和机器可读投影一致；
3. 在物理迁移之前取得可重复的 Pre-Acceptance 证据；
4. 经过独立 Structure / Architecture Review；
5. 形成正式的 `ArchitectureConstitutionAcceptanceDecision`；
6. 再形成 `Phase2StructureFreezeDecision`；
7. 只有结构冻结正式成立之后，才允许开始 Repository / Development Control Plane 的真实物理迁移；
8. 迁移后重新接线全部目标消费者，封存历史名称、关闭旧写入口；
9. 再以 Post-Migration Enforcement 模式重新运行 Naming Validator、Phase 2 Gate 和 Canonical Semantic No-Change 验证；
10. 最终完成 Naming Integrity Closeout；
11. 最后才制作 Developer Skill 和 User Skill，并且它们只是稳定治理事实和权限合同的薄投影层，不是 Authority 的来源。

因此，Phase 2 的结构治理不是“整理目录”，而是：

> **先把逻辑身份与治理事实闭合，再冻结结构；冻结后才迁移；迁移后重新证明；证明完成后才把结果投影进 Skill。**

---

# 一、固定的 21 步执行顺序

## Step 1 — `phase2-v027-validation` 最后收口

### 目标

完成当前 `phase2-v027-validation` 的最后闭环，确认该验证对象的真实状态、证据、未关闭项和后继入口。

### 需要明确的内容

- 精确受审对象是什么；
- 唯一直接前任是什么；
- 当前 Candidate / Commit / Run / Artifact 的绑定关系；
- 哪些 Gate 已真实运行；
- 哪些只是文档设计支持；
- 哪些是待审、未知、失败或未执行；
- 哪些真实缺陷仍未关闭；
- 是否存在阻断进入 Structure Freeze Preparation 的缺口；
- 现有 Receipt、Artifact、日志、CI 结果是否能重复定位；
- 是否存在“报告写 PASS，但真实执行没有发生”的 Authority 漂移。

### 输出

至少应形成或确认：

- `phase2-v027-validation` 精确 Closeout 状态；
- 已完成 / 未完成 / 阻断项清单；
- 真实证据索引；
- 当前有效 Candidate / Commit / Artifact / Receipt 绑定；
- 下一步进入 Structure Freeze Preparation 的入口说明。

### Gate

只有当 `phase2-v027-validation` 已经完成真实收口，才能进入 Step 2。

### 禁止事项

在 Step 1 未完成前，不得：

- 宣称 Structure Freeze 已开始；
- 宣称 Repository 结构已冻结；
- 提前进行目标物理迁移；
- 关闭历史命名；
- 把 Naming Validator 说成已经进入 Post-Migration Enforcement；
- 开始正式 Developer Skill / User Skill 制作；
- 把未执行或待审内容写成 PASS。

---

## Step 2 — Structure Freeze Preparation

### 目标

建立 Phase 2 Structure Freeze 的前置治理工作区与受控入口。

这一步不是“冻结”，而是：

> **为未来能够合法、可验证地冻结结构准备完整输入。**

### 主要工作

- 明确本次 Freeze 的精确 Subject；
- 明确当前逻辑结构与目标逻辑结构；
- 明确哪些内容属于 Naming Surface；
- 明确哪些 Namespace 受本轮治理；
- 明确哪些对象只是历史兼容，不再作为新写入目标；
- 明确目标 Repository / Development Control Plane 的迁移边界；
- 建立 Freeze Preparation 的输入 Registry；
- 明确本轮不允许改变的 Canonical Semantics；
- 明确独立 Review 所需的 Evidence Contract。

### 输出

建议形成：

- `StructureFreezePreparationManifest`
- `StructureFreezeReviewSubjectContract`
- `StructureFreezeEvidenceRequirements`
- `SemanticNoChangeBoundary`
- `MigrationScopeDraft`

### Gate

只有当 Freeze 的精确对象、范围、禁止变化内容和证据要求都确定，才进入全量命名盘点。

---

## Step 3 — 全量 `NamingSurfaceInventoryManifest`

### 目标

建立 **全量 Naming Surface 清单**，避免只治理少数目录或 JSON，而漏掉真正影响身份解析的名称表面。

### Naming Surface 至少包括

- Repository 目录名；
- 文件名；
- Package / Module 名称；
- Schema 名称；
- Table / Collection 名称；
- API / RPC / Route 名称；
- Registry key；
- Manifest key；
- Artifact type；
- Receipt type；
- Authorization type；
- Consumer type；
- Role / Capability / Scope 名称；
- Namespace；
- Domain ID；
- Program ID；
- Stage ID；
- Candidate ID；
- Run ID；
- Commit / Revision / Version 标识；
- Environment 名称；
- Workflow / Job / Required Check 名称；
- README / AGENTS / Status 中的人类可读名称；
- 历史 Alias；
- 兼容入口；
- 旧写入口；
- 对外暴露名称；
- 内部控制面名称。

### 每条记录至少应包含

- 当前名称；
- canonical name；
- object type；
- namespace；
- owner；
- source；
- consumer；
- 是否仍可写；
- 是否只读历史；
- 是否需要 alias；
- 是否需要迁移；
- 是否需要 deprecate；
- 是否存在冲突；
- 是否存在歧义；
- 是否存在多个名字指向同一对象；
- 是否存在同一名字指向不同对象。

### 输出

`NamingSurfaceInventoryManifest`

### Gate

必须达到：

- Naming Surface 覆盖完整；
- 未知项显式标记；
- 冲突项有后续处置路径；
- 不允许用“应该差不多全了”进入下一步。

---

## Step 4 — `NamespaceOwnershipManifest`
### + 显式 Namespace Delegation
### + Domain Registry Ownership

### 目标

回答三个问题：

1. **谁拥有这个 Namespace？**
2. **谁可以在其中定义新对象？**
3. **谁可以授权别人代为定义？**

### 核心原则

Namespace 不是字符串前缀，而是治理边界。

必须显式区分：

- Namespace Owner；
- Delegated Maintainer；
- Read Consumer；
- Write Consumer；
- Publisher；
- Reviewer；
- Migration Executor；
- Historical Compatibility Reader。

### Namespace Delegation

任何委托必须明确：

- delegator；
- delegatee；
- namespace；
- capability；
- scope；
- start condition；
- end condition；
- revocation；
- approval requirement；
- prohibited actions。

不得因为某个 Agent、Skill 或开发工具“能访问仓库”，就自动推定其拥有 Namespace 定义权。

### Domain Registry Ownership

同时明确：

- 每个 Domain 的 canonical registry；
- Registry Owner；
- 谁可以新增 / 修改 / retire Domain；
- Domain 与 Namespace 的映射；
- Domain ID 是否稳定；
- 历史名称如何解析；
- 是否存在跨 Domain 冲突。

### 输出

- `NamespaceOwnershipManifest`
- `NamespaceDelegationManifest`
- `DomainRegistryOwnershipManifest`

### Gate

任何无 Owner、无 Delegation、无 Registry 归属的核心 Namespace，都不得进入 Freeze。

---

## Step 5 — Version Axis / Vocabulary / Alias / Logical Object / Representation / Copy Identity Closure

### 目标

完成 Clued 当前结构治理中最容易发生身份漂移的六类闭合。

---

### 5.1 Version Axis Closure

必须区分：

- 产品版本；
- 架构版本；
- 映射版本；
- Schema 版本；
- Artifact 版本；
- Skill 版本；
- Runtime 版本；
- Candidate revision；
- Migration revision；
- Protocol version。

不同版本轴不得混用。

例如：

- v0.4.3 映射版本不能被当作架构直接前任版本；
- Skill vNext 不能冒充 Kernel 版本；
- Artifact revision 不能自动等价于产品 release version。

---

### 5.2 Vocabulary Closure

所有核心术语必须明确 canonical definition。

重点包括：

- Candidate
- Artifact
- Receipt
- Authorization
- Consumer
- Publisher
- Gate
- Run
- Commit
- Subject
- Direct Predecessor
- Logical Object
- Representation
- Copy
- Alias
- Namespace
- Domain
- Scope
- Authority
- Acceptance
- Verification
- Release

同一词不能在不同文档中指不同东西。

---

### 5.3 Alias Closure

所有 Alias 必须明确：

- alias → canonical target；
- 是否只读兼容；
- 是否允许新写入；
- 生命周期；
- retire 条件；
- 是否允许反向解析；
- 是否可能多义。

核心原则：

> Alias 可以帮助旧消费者继续读取，但不能成为新的身份真相源。

---

### 5.4 Logical Object Closure

必须定义：

> “什么情况下两个不同文件、不同路径、不同表示仍然是同一个逻辑对象？”

例如：

- JSON 和 Markdown 是否是同一 Decision 的两个 representation；
- ZIP 中的副本和包外文件是否还是同一 Artifact；
- Registry 条目与 Canonical Store 中对象之间是什么关系；
- Copy 是否保留同一 logical object identity；
- 重新生成但字节不同是否还是同一对象。

---

### 5.5 Representation Closure

同一 Logical Object 可能有：

- canonical machine-readable representation；
- human-readable projection；
- transport package；
- read-only mirror；
- compatibility projection。

必须明确：

- 哪个是 canonical；
- 哪些只能派生；
- 是否允许反向编辑；
- 投影不一致时谁胜出。

---

### 5.6 Copy Identity Closure

必须回答：

- 复制后是否保持原 object ID；
- 是否产生新的 copy ID；
- copy 是否允许写；
- 是否允许重新签发；
- 是否允许产生新的 Authority；
- copy 与 source Artifact 如何绑定。

### 输出

建议形成：

- `VersionAxisRegistry`
- `CanonicalVocabularyRegistry`
- `AliasRegistry`
- `LogicalObjectIdentityContract`
- `RepresentationContract`
- `CopyIdentityContract`

### Gate

存在关键身份歧义时，不进入 typed consumer 接线。

---

## Step 6 — 当前所有 Receipt / Authorization / Consumer 的 typed 身份盘点与接线

### 目标

把当前所有关键运行身份从“自然语言描述”升级为明确 typed identity。

### Receipt

至少明确：

- receipt_type；
- subject；
- producer；
- run_id；
- candidate_id；
- commit；
- artifact；
- gate；
- result；
- timestamp；
- evidence references；
- authority effect；
- scope。

### Authorization

至少明确：

- authorization_type；
- issuer；
- subject；
- grantee；
- capability；
- scope；
- constraints；
- expiry；
- revocation；
- required evidence；
- whether reusable。

### Consumer

至少明确：

- consumer_type；
- consumer_id；
- exact input contract；
- accepted namespace；
- accepted version axis；
- required receipt；
- required authorization；
- failure behavior；
- unknown behavior；
- whether it can publish；
- whether it can mutate canonical state。

### 核心原则

不得继续依赖：

> “这个 Workflow 大概消费这个文件”  
> “这个 Agent 应该知道它能做什么”

而必须形成：

> **精确 consumer → 精确 typed input → 精确 authorization → 精确 receipt requirement → 精确 gate**

### 输出

- `TypedReceiptRegistry`
- `TypedAuthorizationRegistry`
- `TypedConsumerRegistry`
- 真实接线映射。

### Gate

关键 Consumer 未绑定精确身份和权限时，不进入投影一致性阶段。

---

## Step 7 — README / AGENTS / Status / Manifest / Registry 确定性投影与一致性验证

### 目标

保证不同面向的 Clued 状态表达都来自同一 Canonical Truth，而不是各自手写后逐渐漂移。

### 需要验证的投影

至少包括：

- README；
- AGENTS；
- Status；
- Manifest；
- Registry；
- 机器可读 identity files；
- human-readable governance docs；
- Workflow 引用；
- Tool routing 配置；
- Consumer binding。

### 确定性投影原则

必须做到：

> Canonical Source  
> → deterministic projection  
> → README / AGENTS / Status / Manifest / Registry

而不是：

> README 自己写一份  
> AGENTS 自己写一份  
> Status 再写一份  
> 最后靠人工记忆判断哪个是真的。

### 验证项

- 相同对象是否使用相同 canonical identity；
- current / historical 是否混淆；
- accepted / pending 是否混淆；
- authority / recommendation 是否混淆；
- version axis 是否一致；
- namespace owner 是否一致；
- alias 是否一致；
- direct predecessor 是否一致；
- consumer binding 是否一致。

### 输出

- deterministic projection implementation 或 specification；
- projection consistency report；
- mismatch inventory；
- zero-drift evidence。

### Gate

关键投影存在漂移时，不进入 Pre-Acceptance Validator。

---

## Step 8 — Naming Validator — Pre-Acceptance Evidence Mode
### + 全部负例

### 目标

在结构冻结之前，用 Validator 提供可重复的接受证据。

此时 Validator 的定位是：

> **Evidence Producer**

而不是最终生产 Enforcement。

### 正例验证

至少应覆盖：

- canonical name；
- namespace ownership；
- alias resolution；
- logical object identity；
- representation；
- copy identity；
- version axis；
- typed receipts；
- typed authorization；
- typed consumers；
- deterministic projections；
- direct predecessor；
- current/historical distinction。

### 负例必须主动构造

例如：

- namespace owner 缺失；
- 同名不同对象；
- 一对象多个 canonical name；
- alias 指向不存在目标；
- alias 被误当成新写入口；
- current 文档引用 historical identity；
- direct predecessor 错绑；
- version axis 混用；
- receipt 缺 subject；
- authorization scope 越界；
- consumer 读取未授权 namespace；
- README 与 Registry 不一致；
- copy 冒充 original；
- representation 冒充 canonical；
- pending 状态被投影为 accepted；
- 未执行结果被投影为 PASS。

### 核心要求

Validator 必须证明：

> **真实错误能够让目标 Gate 失败。**

只跑绿色正例不算完成。

### 输出

- Pre-Acceptance Validator report；
- positive fixtures；
- negative fixtures；
- failure evidence；
- reproducibility instructions；
- exact exit code；
- run identity；
- receipt / artifact。

### Gate

只有当真实负例能稳定击穿目标规则，且正例稳定 PASS，才进入独立 Review。

---

## Step 9 — 独立 Structure / Architecture Review

### 目标

由与作者工作上下文分离的 Reviewer，对 Structure Freeze 候选进行独立审查。

### 独立审查重点

- Naming Surface 是否完整；
- Namespace Ownership 是否闭合；
- Alias 是否安全；
- Version Axis 是否存在混用；
- Logical Object / Representation / Copy identity 是否精确；
- Typed Receipt / Authorization / Consumer 是否足够；
- deterministic projection 是否真实；
- Validator 是否能发现真实错误；
- 负例是否有针对性；
- 是否仍存在绕过路径；
- Freeze 后是否会改变 Canonical Semantics；
- 是否存在未关闭结构缺口。

### 独立性要求

Reviewer 不能只复述作者结论。

需要：

- 独立检查器或独立推导；
- 精确受审对象；
- 精确 Candidate / Commit / Artifact；
- 明确 review scope；
- 明确 findings；
- 明确 pass / revise / blocked；
- 不能自动产生最终用户 Authority。

### 输出

`IndependentStructureArchitectureReview`

### Gate

只有独立 Review 达到接受条件，才允许准备正式 Architecture Constitution Acceptance。

---

## Step 10 — `ArchitectureConstitutionAcceptanceDecision`

### 目标

形成架构宪法层面的正式接受决定。

这是一个 Authority-bearing Decision，不是普通报告。

### 决定至少绑定

- exact subject；
- candidate；
- commit；
- direct predecessor；
- independent review；
- evidence；
- accepted scope；
- excluded scope；
- unresolved obligations；
- effective authority；
- consumer rights；
- prohibited inference。

### 必须明确

该 Decision 接受什么：

- Naming Constitution；
- Namespace ownership；
- identity rules；
- typed contracts；
- deterministic projection；
- Validator evidence；
- review conclusions。

也必须明确不接受什么：

- 未执行 runtime behavior；
- 未获授权的生产行为；
- 未验证的迁移结果；
- 尚未发生的 enforcement；
- Skill 本身。

### Gate

`ArchitectureConstitutionAcceptanceDecision` 正式成立后，才可以进入 Freeze Decision。

---

## Step 11 — `Phase2StructureFreezeDecision`

### 目标

正式冻结 Phase 2 的目标逻辑结构。

这一步之后，才可以说：

> **Phase 2 Structure Freeze 已成立。**

### Freeze 的内容

应明确冻结：

- canonical namespaces；
- ownership；
- domain registry；
- version axes；
- vocabulary；
- logical object rules；
- representation rules；
- copy identity rules；
- typed receipt / authorization / consumer contract；
- target repository logical structure；
- deterministic projection contract；
- migration target。

### Freeze 不等于

- 已完成物理迁移；
- 已关闭旧写入口；
- 已完成 production enforcement；
- 已重跑全部 Gate；
- 已完成 Skill；
- 已发布。

### 输出

`Phase2StructureFreezeDecision`

### Gate

只有该 Decision 成立后，Step 12 的物理迁移才合法进入。

---

# 二、Post-Freeze Migration & Enforcement

## Step 12 — Repository / Development Control Plane 物理迁移

### 目标

把已经被冻结并被接受的目标逻辑结构映射到真实 Repository / Development Control Plane。

### 工作内容

- 路径迁移；
- package / module 调整；
- registry relocation；
- manifest relocation；
- workflow path 更新；
- developer control plane 更新；
- compatibility layer 建立；
- old → new mapping；
- migration receipts；
- rollback plan。

### 原则

> 先冻结逻辑真相，再迁移物理表示。

不得在迁移过程中顺手重写未授权语义。

### 输出

- migration plan；
- actual migration diff；
- migration receipt；
- changed-path manifest；
- rollback data。

---

## Step 13 — 全部目标运行消费者接线

### 目标

让真实运行消费者切换到冻结后的 canonical structure。

### Consumer 包括

- validators；
- workflows；
- CI jobs；
- registry readers；
- artifact producers；
- receipt producers；
- authorization checkers；
- developer tooling；
- runtime adapters；
- release tooling；
- future Skill projections 所依赖的 control plane。

### 必须验证

每个 Consumer：

- 读取正确 namespace；
- 读取正确 canonical identity；
- 使用正确 version axis；
- 不再依赖旧写入口；
- fail closed；
- unknown 不冒充 success；
- receipt 绑定正确；
- authorization scope 正确。

### 输出

`TargetConsumerBindingManifest`

---

## Step 14 — 历史名称封存、旧写入口关闭

### 目标

正式结束双写、隐式兼容写入和历史名称继续生长。

### 需要区分

- historical read compatibility；
- canonical read；
- canonical write；
- forbidden write；
- deprecated alias；
- sealed alias。

### 原则

旧名称可以在必要时：

- 被读取；
- 被解析；
- 被审计；

但不得继续：

- 产生新 canonical state；
- 创建新对象；
- 绕过新 namespace ownership；
- 绕过 authorization；
- 形成第二真相源。

### 输出

- `HistoricalNameSealManifest`
- `LegacyWriteClosureReceipt`

---

## Step 15 — Naming Validator — Post-Migration Enforcement Mode

### 目标

把 Validator 从前置 Evidence 工具升级为迁移后的真实 Enforcement。

### 与 Step 8 的区别

Step 8：

> 证明目标治理设计能够被接受。

Step 15：

> 证明真实迁移后的 Repository / Control Plane 正在强制执行这些规则。

### 必须覆盖

- 新写入；
- CI；
- local check；
- PR check；
- workflow；
- artifact creation；
- receipt generation；
- registry update；
- namespace mutation；
- alias mutation；
- version axis mutation。

### 输出

- Post-Migration Enforcement report；
-真实 CI / local / workflow evidence；
- exit codes；
- receipts；
- negative-case evidence。

### Gate

Pre-Acceptance PASS 不能替代这里的 PASS。

---

## Step 16 — 现有四个 Phase 2 Gate 重跑

### 目标

在迁移后的真实结构上重新运行现有四个 Phase 2 Gate。

### 核心要求

- 使用迁移后的真实路径；
- 使用迁移后的真实 consumer；
- 使用冻结后的 canonical identity；
- 不允许继续引用 pre-migration 旧结果代替；
- 每个 Gate 都绑定 exact Candidate / Commit / Run / Artifact / Receipt。

### 输出

四个 Phase 2 Gate 的 fresh rerun evidence。

### Gate

任何一个 required Gate 未真实 PASS，都不能进入 semantic no-change closeout。

---

## Step 17 — Canonical Semantic No-Change PASS

### 目标

证明本轮结构治理与物理迁移没有偷偷改变已经接受的 Canonical Semantics。

### 需要证明

虽然：

- 路径变了；
- 文件可能移动；
- module 名可能统一；
- alias 被封存；
- registry 被重建；
- projection 被确定化；

但：

- accepted business meaning 不变；
- accepted product meaning 不变；
- accepted architecture meaning 不变；
- authority boundaries 不变；
- permissions 不扩大；
- consumer obligations 不减少；
- existing accepted contracts 不被悄悄改写。

### 验证方式

可以包括：

- canonical object comparison；
- semantic hash / normalized comparison；
- contract comparison；
- accepted decision binding comparison；
- before / after typed graph comparison；
- negative-case regression。

### 输出

`CanonicalSemanticNoChangeDecision` 或等价 PASS Artifact。

---

## Step 18 — 不可绕过 required check 或等价强制证明

### 目标

证明 Naming Integrity / Structure Governance 不是“建议运行的脚本”，而是不能轻易绕过的强制条件。

### 可接受证明形式

例如：

- protected required check；
- merge gate；
- signed release gate；
- server-side enforcement；
- equivalent control plane enforcement；
- 权限隔离；
- publisher-only path；
- write path 必经 validator；
- CI + release artifact binding。

### 必须验证

- 普通 contributor 能否绕过；
- 本地不运行脚本是否仍能合入；
- 直接改 Registry 是否可绕过；
- 直接改 Manifest 是否可绕过；
- Workflow 是否能被轻易跳过；
- stale receipt 是否可复用；
- 다른 Candidate 的 PASS 是否可冒用；
- admin 例外是否被记录并审计。

### 输出

`RequiredCheckNonBypassEvidence`

---

## Step 19 — Naming Integrity Closeout

### 目标

正式关闭 Phase 2 Naming Integrity 工作。

### Closeout 前必须满足

- Freeze Decision 已成立；
- migration 完成；
- target consumers 已接线；
- historical names 已封存；
- old write path 已关闭；
- Post-Migration Validator PASS；
- 四个 Phase 2 Gate fresh PASS；
- Canonical Semantic No-Change PASS；
- required check 不可绕过或等价强制证明成立；
- Receipt / Artifact / Authorization / Consumer typed graph 完整；
- open findings 有明确 disposition。

### 输出

`NamingIntegrityCloseoutDecision`

### Authority 含义

只有到这里，才可以说：

> **Phase 2 的 Naming / Structure Governance 已完成闭环。**

在此之前，不得把 Skill 当成稳定事实来源。

---

# 三、Skill 阶段

## Step 20 — Developer Skill

### 目标

把已经稳定的 Clued 开发治理机制投影成薄 Developer Skill。

### Developer Skill 应主要声明

- 可以调用什么；
- 可以读取什么；
- 可以修改什么；
- 哪些 Namespace 可写；
- 哪些 Role / Capability / Scope 可用；
- 哪些动作必须批准；
- 哪些动作必须产生 Receipt；
- 哪些 Gate 必须 PASS；
- 哪个角色可以 publish；
- 失败时停止 / 回滚 / 降级规则；
- 哪些 Consumer contract 必须满足。

### Developer Skill 不应重新承载

- 大段通用思考方法；
- 模型本身已经掌握的标准工程方法；
- 全量历史；
- 宪法本体；
- Authority 本体。

### 核心原则

> Developer Skill 是已稳定 Mechanism 的投影，不是开发权限的来源。

---

## Step 21 — User Skill

### 目标

形成面向普通用户安装和使用的 User Skill。

### User Skill 应主要声明

- 用户可以做什么；
- User Skill 可以访问什么；
- 私人数据边界；
- 允许调用哪些 Clued capability；
- 哪些操作必须明确用户授权；
- 哪些操作只是建议；
- 哪些操作可以真实执行；
- 哪些操作必须等待 Gate；
- 哪些 Receipt 对用户可见；
- 失败 / 未知 / 断连时如何表达。

### 权限原则

Developer Skill 与 User Skill 可以同时安装、协作，但：

- 权限不叠加；
- User Skill 不继承开发权限；
- Developer Skill 不默认取得真实用户私人数据；
- 实际动作由 `Role / Capability / Scope Routing` 决定；
- Skill 只是 Clued Mechanism 的投影，不是权力来源。

---

# 四、固定阶段边界

## A. 当前收口阶段

### Step 1

`phase2-v027-validation` 最后收口

当前真实位置就是这里。

---

## B. Pre-Freeze / Pre-Acceptance

### Step 2–11

```text
Structure Freeze Preparation
        ↓
NamingSurfaceInventoryManifest
        ↓
NamespaceOwnershipManifest
        ↓
Version / Vocabulary / Alias / Identity Closure
        ↓
Typed Receipt / Authorization / Consumer
        ↓
Deterministic Projection
        ↓
Naming Validator — Pre-Acceptance Evidence
        ↓
Independent Structure / Architecture Review
        ↓
ArchitectureConstitutionAcceptanceDecision
        ↓
Phase2StructureFreezeDecision
```

### 关键规则

在 `ArchitectureConstitutionAcceptanceDecision` 与 `Phase2StructureFreezeDecision` 成立前：

- 不得宣称结构已冻结；
- 不得开始正式物理迁移；
- 不得关闭旧写入口；
- 不得把 Validator 的前置 PASS 当作迁移后 Enforcement PASS；
- 不得开始正式 Skill 定稿。

---

## C. Post-Freeze Migration & Enforcement

### Step 12–19

```text
Repository / Dev Control Plane Migration
        ↓
Target Consumers Binding
        ↓
Historical Name Sealing
        ↓
Post-Migration Enforcement
        ↓
4 Phase 2 Gates Rerun
        ↓
Canonical Semantic No-Change
        ↓
Non-Bypass Enforcement Evidence
        ↓
Naming Integrity Closeout
```

### 核心规则

冻结之后才迁移。

迁移之后必须重新证明。

旧的 Pre-Acceptance PASS 不能替代新的 Post-Migration PASS。

---

## D. Skill Projection

### Step 20–21

```text
Naming Integrity Closeout
        ↓
Developer Skill
        ↓
User Skill
```

Skill 只能消费已稳定的：

- governance facts；
- typed contracts；
- role；
- capability；
- scope；
- namespace；
- receipt；
- gate；
- control plane；
- authority boundary。

Skill 不得自己定义新的 Authority。

---

# 五、整个 Phase 2 结构治理的核心不变量

## 1. 精确对象

任何 Review、Gate、Receipt、Decision 都必须绑定：

- exact subject；
- exact candidate；
- exact direct predecessor；
- exact commit；
- exact run；
- exact artifact。

不得用“最新版”“当前版本”“大概这个包”代替。

---

## 2. 状态不能混淆

必须明确区分：

- NOT_EXECUTED
- PENDING_REVIEW
- UNKNOWN
- FAILED
- PASSED
- ACCEPTED
- VERIFIED
- RELEASED
- SUPERSEDED
- REJECTED

未执行不等于失败，也不等于成功。

Review PASS 不等于用户接受。

用户接受不等于实现。

实现不等于验证。

验证不等于发布。

---

## 3. Authority 必须显式

任何 Authority Effect 都必须来自明确机制，例如：

- 用户决定；
- 合格 Acceptance Decision；
- 授权合同；
- Gate；
- Publisher role；
- Release authority。

不得来自：

- Skill 自述；
- Agent 自述；
- README 文字；
- 模型判断；
- 工具品牌；
- “以前一直这样做”。

---

## 4. 最小修订优先

发现问题时优先：

- 定点修订；
- 保留直接前任；
- 保留历史证据；
- 保留 diff；
- 保留失败历史。

不因为一个命名问题就重建全部结构。

---

## 5. 负例是必要证据

Naming Integrity 不能只靠“正例全部绿”。

必须证明：

> 错误 Namespace、错误 Alias、错误 direct predecessor、越权 consumer、错误 Receipt、投影漂移等真实错误会让目标 Gate 失败。

---

## 6. Canonical Truth 只有一个

README、AGENTS、Status、Manifest、Registry 都必须是 Canonical Truth 的确定性投影。

不能形成多个并行“当前真相”。

---

## 7. Skill 最后做

Skill 是：

> 模型能力  
> → 极短方法核  
> → Clued 动态上下文包  
> → 项目特有合同与边界  
> → 工具与权限  
> → Gate / Receipt / Evidence

中的薄能力适配层。

Skill 不应再成为 Clued 的核心知识仓库或权限系统。

---

# 六、当前精确状态

当前仍然是：

> **Step 1 — `phase2-v027-validation` 最后收口**

尚不能声称：

- Structure Freeze Preparation 已完成；
- `NamingSurfaceInventoryManifest` 已完成；
- Namespace Ownership 已闭合；
- Naming Validator Pre-Acceptance 已 PASS；
- Architecture Constitution 已接受；
- Phase 2 Structure 已冻结；
- Repository 已迁移；
- 历史名称已封存；
- Post-Migration Enforcement 已完成；
- 四个 Phase 2 Gate 已在迁移后重跑；
- Canonical Semantic No-Change 已 PASS；
- required check 已证明不可绕过；
- Naming Integrity 已 Closeout；
- Developer Skill / User Skill 已进入正式制作。

---

# 七、一句话固定版

> **Clued Phase 2 当前先完成 `phase2-v027-validation` 收口；随后按 Naming 全量盘点 → Namespace 与身份闭合 → typed Receipt / Authorization / Consumer → 确定性投影 → Pre-Acceptance Validator + 负例 → 独立审查 → Architecture Constitution Acceptance → Structure Freeze → 真实迁移 → 全消费者接线 → 封存旧名与关闭旧写入口 → Post-Migration Enforcement → 四 Gate 重跑 → Canonical Semantic No-Change → 不可绕过证明 → Naming Integrity Closeout → Developer Skill → User Skill 的顺序推进。**
