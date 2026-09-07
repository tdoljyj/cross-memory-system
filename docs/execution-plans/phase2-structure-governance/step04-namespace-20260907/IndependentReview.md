# Step 4 候选独立审查

**结论：`SUPPORTED_FOR_SCOPED_STEP4_ACCEPTANCE`。** 经一处局部补齐，候选满足本轮 Namespace Ownership、Delegation 和 Domain Registry 的最小管理归属要求。当前仍是候选；本报告没有签发 Step 4 接受、Freeze 或运行时授权。

复用了 `CandidateChecks.json` 已有的 23 个原 Map 行恰好一次、138 个来源引用一致等检查；仅比对候选摘要与本次修改涉及的关系，没有重扫全库或完整 ZIP。10 个管理分组均有用户/项目 Owner、已有 Codex 任务委托及八种角色区分；委托具备范围、能力、起止、撤销、批准要求和禁止动作；8 个 Domain 均有管理 Owner、维护者、生命周期权限、稳定标识和历史解析规则。

本次发现并修复的唯一缺项：原候选只有全部为 null 的运行时 Domain Registry 字段，没有单独指定**本轮治理归属登记位置**。已在 `DomainRegistryOwnershipManifest.candidate.json` 明确提出本轮管理归属登记视图，增加 8 个精确 Domain 行引用及 10 组双向 Namespace/Domain 引用，并在 `KeyConflicts.candidate.json` 记录层级区别。原 `StructureCandidateMap` 继续是结构定义来源，原 23 行未变；运行时 Registry 和 issuer 字段仍不被授权。该治理登记只有在有权接受者按最终摘要作出限定 Step 4 接受后生效。

可直接按已有全权委托代为确认的事项：用户作为本轮管理 Namespace/Registry Owner；已授权 Codex 任务作为范围内维护者、私库制品发布者及接受代理；上述治理登记和映射。依据是明确的项目所有者上下文与 `ExecutionDelegation_20260907.json`，不是“能够访问仓库”的推定，不需逐字段再次向用户确认。

以下义务按原顺序继续，不阻断本轮 Step 4 管理归属确认：Step 5 的 canonical vocabulary、版本轴、alias 和 Map/IMC 身份交叉关系；Step 6 的实际 program issuer、consumer、输入、权限与 receipt 接线；Step 9 实际独立审查者绑定。真正需要启用或修改某个外部/私有运行时 Namespace 时，才核对其精确合同与实际权限。不能为填表而恢复历史引擎或建设尚不适用的全域运行时 Registry。

最小判据依据固定基线第 198–202、208–217、223–232、240–246 行，以及 `AcceptanceAndInvalidation.md` 的 Step 4 行：Owner 有归属、委托可追溯、登记关系一致、未授权者不能据此定义有效身份。管理层接受不代替未来程序权限；若具体核心 Namespace 的有效授权在 Freeze 前仍缺失，才阻断其相关 Freeze/生效动作。

最终摘要与检查结果保存在 `IndependentReview.json` 和更新后的 `CandidateChecks.json`。后者 SHA256：`2773d3f274fb9c61094be66bccff7b880a47ba16db993ded121fe9ec2a8af36a`。没有修改当前仓库代码、原结构输入或生产服务。
