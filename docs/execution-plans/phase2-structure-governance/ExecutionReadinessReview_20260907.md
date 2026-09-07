# Phase 2 下一阶段独立核对（2026-09-07）

本报告是任务内技术审查，不是 Step 9、Acceptance 或 Freeze。来源：工作分支 `phase2-naming-surface-inventory`，本地/远端均为 `f6bee6e01b05a65e0548af38b05e144814e6aa53`；初始工作树干净。独立 AlignAndVerify PROJECT 在宿主成功：main `507c69b8f0638ff9202a4eeb140c606f9089e821`、mirror/doctor PASS。该镜像 freshness=historical，本报告不以其中业务状态判断当前 Phase 2。首次调用缺 Python，第二次沙盒身份触发 Git 所有权；宿主重试成功，未把这些错误当断网。

已读固定 21 步基线、AcceptanceAndInvalidation、Step01/02 和 Step03 报告、Naming Scope、13 来源索引和相关元数据说明、scanner/consolidator、仓库及应用 AGENTS，以及精确 v0.2.7.1 ZIP 的选定 `data/*.json`。未执行 ZIP 内脚本，未展开嵌套历史/私人载荷，未改任何 Canonical 业务状态。

## 结论

Step 3 尚不能放行。除四个外部来源缺口，存在实测的第五类：**实际 API/路由、RPC、package/script/module、role/capability/scope 并未得到足够的名称提取和规则覆盖说明**。记录数量、16 个属性齐全与 CI 成功均不能替代这个覆盖要求。

现有 Scope 将文本限定为 selected UTF-8/observed token，但固定基线 Step 3 明列 API/RPC/Route、Package/Module、Registry/Manifest key、Role/Capability/Scope。该实现说明不能静默缩小上位基线。需要有限、来源驱动的提取器与未解析清单；不能反过来声称一个 regex 能理解全部代码语义。

### 可复核反例

`apps/clued-cloud/worker/continuity.ts` 第 1086、1202、1252、1261 行分别声明 `/v1/projects`、`/healthz`、`/mcp`、`/api/bindings`。逐行运行 scanner 的所有 token regex 均提取 0 项。`walk_json_fields` 对 `role/scope/capability` 标量、`capabilities` 字符串数组，以及一般 package name/exports 也提取 0 项。真实 `publicToolPolicies` 的 `context:read`、`context:write`、`audit:read` 值不能依靠 clued/URN/大写命名规则完整取得。路径名的扫描不等价于路由或 package script 的名称扫描。

## 四个来源缺口的处置边界

| 缺口 | 当前判断 | 可接受的最小有证据处置 | 不能作为关闭依据 |
|---|---|---|---|
| Library | 必需来源尚未枚举，当前阻断 | 当前账号的完整元数据导出，或可证明覆盖同一 Library 范围的持久导出；保留逻辑对象与物理副本两种 ID、分页/总数与时间。既有候选包可以证明其精确制品，不证明 Library 里没有额外副本 | 浏览器超时、旧 Library 链接存在、仓库已有同名字节、用户拥有账号 |
| 停用 Supabase 恢复项目 | 项目名称已观察，schema 子范围未观察 | 关联确切项目的既有 schema 备份/导出加生命周期证据；若原有合同与实际证据已证明历史只读/封存，登记真实历史状态及已知名称即可，不必恢复在线实例来制造“当前扫描”。否则需取回元数据 | INACTIVE 自动等于空库/已删除/已退役；无变更证据下把旧备份称为当前完整库 |
| Auth redirects | 当前生产配置的实际标识仍缺，当前阻断 | 授权管理端读取 site URL/redirect allow-list 等名称配置；只保留所需值及来源绑定，实际空列表可作为空结果证据 | 源码默认值、登录成功、库 schema 完整、测试账号说明 |
| 旧 Sites | 旧 URL 已知，但部署身份/历史处置未闭合 | 已有精确 deployment/project/域名绑定、历史迁移或退役回执可完成对应对象的历史处置；若完整枚举的对象分母已经证明，生命周期属性 UNKNOWN 可单独登记，不能把“属性未知”误扩大成整个来源未扫描 | 当前 owner/editor 空列表自动证明旧站点退役；HTTP 不通自动证明删除；为了进入 Step 4 提前实施 Step 14 封存 |

共同规则：区分**对象已枚举但某属性未定**与**来源根本未枚举**。前者可按 Step 3→4/5 的正常分工保留 UNKNOWN；后者不能把不可达改写成 SCANNED/N/A。历史兼容只允许使用已经存在且能证明的状态，不能本轮提前创造封存或删除事实。

## 21 步的可复用映射

| Step | 已有等价输入或实现 | 本轮可据此主张的范围 |
|---|---|---|
| 1 | validation 四 Gate、CloseoutIndex、两组正例与四个定点负例、本地精确包复核 | 限定 validation 技术收口；不是整架构完成 |
| 2 | 已核验结构 v0.1.4、23 行 Map v0.1.1、Scope、输入映射 P2-01/02/03 | 准备条件已核对 |
| 3 | scanner、consolidator、SourceIndex、49,197 条旧运行记录 | 可复用采集与证据框架；五类缺口未清，不放行 |
| 4 | ZIP `StructureCandidateMap.json` 的责任域、`DomainIntegrationContracts.json`、`ArchitectureCandidateModel.json#/contract_allocations` | 责任候选，不是具名授权；多处 `named_owner=null` |
| 5 | ZIP `CurrentArtifactIdentityPolicy.json`、`ArtifactAndReleaseIdentityCrosswalk.json`、CurrentArtifactRegistry、既有 vocabulary registry | 已有版本轴/逻辑身份/历史命名空间规则；Alias/Copy/representation 与当前对象逐项绑定仍需补证 |
| 6 | ZIP `RuntimeConsumerEvidenceContract.json`，现有 `worker/continuity.ts` tools/policies/RPC/REST 映射，Kernel identity-security 与 receipt/capability schemas | 当前部分消费者已有实际机制可接；ZIP 自述 runtime consumers=0、tests=0，不能把领域设计占位作运行接线 |
| 7 | `scripts/verify-generated-artifacts.mjs`、protocol manifest/object/vocabulary registries，现有 source/hash 机制 | 有可复用生成产物核验框架；尚未证明 README/AGENTS/Status/Naming Registry 全部确定性投影 |
| 8 | 既有 validator/harness、现有 completeness tests 与四定点负例模式 | 可复用运行/回执骨架；没有完整 Naming 规则正负例闭包 |
| 9 | ReviewSubjectContract、FreshContextReviewHandoff、原 40/28 条件 | 可用审查要求；当前独立技术核对不代替正式候选审查 |
| 10 | DecisionTemplates、有效用户执行委托 | 可以在证据满足时由接受代理另签精确决定；目前未签 |
| 11 | 原 28 条 StructureFreezeEvidenceMatrix、Map | 冻结义务仍保留；Architecture Acceptance 后另裁，当前未签 |
| 12 | 结构主文 B0–B4、rollback/compatibility/changed-path 设计 | 迁移计划输入，不是已发生迁移 |
| 13 | RuntimeConsumerEvidenceContract、真实 Worker consumers | 迁移后按确切目标复接/实测，不能复用迁移前 PASS 代替 |
| 14 | 历史命名规则、旧 Target disposition/兼容要求、legacy 桥接代码 | 只读兼容可复用；旧写口真实关闭尚需实施证据 |
| 15 | Naming Validator 测试骨架和现有 CI | 需接入实际写入/合入/产物入口；生成报告不等于强制 |
| 16 | 当前四 Gate 实现 | 迁移后以新路径/消费者/精确候选 fresh 重跑 |
| 17 | 结构主文 §5、源摘要、identity/authorization tests | 可用比较原则与代码，仍需受控前后语义对照 |
| 18 | 原 F-MAJ-004、CI receipt/issuer/attempt 模式 | 可用前置合同；需实际 bypass/skipped/neutral/伪造来源拒绝证明 |
| 19 | 固定基线收口合同 | 依赖 11–18 有效证据，尚无可代签的现成结果 |
| 20 | SkillCoexistenceCandidate、既有 clued-continuity 适配器、typed capability 来源 | 参考/兼容输入；正式新 Developer Skill 仍在 Step 19 后 |
| 21 | 同上及现有用户 MCP 合同 | 用户角色投影不继承开发权限；依序制作和验证 |

## Step 4–8 最小实际实现路径

先闭合 Step 3；可并行做下列设计/证据研究，不把 Step 4 实施或准入提前记为完成。

1. **保留现有 source/identity/registry 机制。** 不原地编辑不可变候选 ZIP、历史 SourceIndex 或 protocol v1 的固定机器语义。以一个有限的包外 Naming 候选补充记录精确 source refs、delta 和适用 subject；其作用是补足既有治理事实的 Naming 接线，不是新的全局真相库。
2. **Step 4/5：建议在现有 `artifacts/clued-validation/structure-freeze-prep/naming/` 下用一个 `NamingGovernanceCandidate.json` 承接当前候选的 namespace/domain/delegation、版本轴/alias/representation/copy 映射。** 先引用已存在的 `StructureCandidateMap`、`CurrentArtifactIdentityPolicy` 和 crosswalk，只添加真正缺的具名角色、有限委托、解析约束与 source pointers；不要复制整个商业/架构域合同。名称只是推荐，等价既有文件优先。
3. **Step 6：在同一候选补充中登记 `consumer_bindings`。** 每行绑定已有 `RuntimeConsumerEvidenceContract`、真实 `worker/continuity.ts` 的 consumer symbol/RPC/REST 映射、必要 scope 和 receipt。对于治理工具同样登记 scanner→source manifest、consolidator→source+disposition、validator→候选+规则。需要新增字段时用旁路工程证据封套，不就地放宽不可变 `receipt.schema.json`。领域 `NOT_PERFORMED` 设计继续保持该状态。
4. **Step 7：扩展现有生成核验入口或增加一个只处理该候选的投影子命令。** README/AGENTS/Status 仅其明确的治理事实区从同一 Naming candidate/实际 receipts 生成，正文教程不被当作机器事实全量重写。新机器投影带 source hash；注入错误身份必须失败。现有 `scripts/verify-generated-artifacts.mjs` 可复用 hash/registry 校验，但当前 local-RC 定义不能被新工程候选冒充。
5. **Step 8：在现有 Naming 工具与 CI 中增添治理验证模式和专门负例。** 最小触及 `scripts/clued-naming-inventory-consolidate.py`、`tests/test_naming_inventory_semantic_surfaces.py`/既有测试、`.github/workflows/phase2-naming-surface-inventory.yml`，以及必要的新纯校验子程序。规则覆盖 namespace owner/delegation、alias cycle/目标缺失、copy/source、version axis、typed input/receipt、权限扩大、projection drift、stale/cross-candidate evidence。必须对应实际目标 Gate，不新造一个自填 PASS 的验证器。

当前 Step 3 最小代码修复是来源驱动提取、规则分母和未解析清单；汇总器消费可校验的来源处置输入，不再硬编码“永远四个 gap”，也不能只依据 gap 列表空就 PASS。

## 用户代理授权

已读 `docs/execution-plans/phase2-structure-governance/ExecutionDelegation_20260907.json`。它正确记录任务 ID、原文、用户/代理角色、固定基线摘要、1–21 范围、前置 Gate、终止/撤销、独立审查与禁止推断。无需重复确认既有授权。

后续每个有 Authority 的接受/冻结记录应引用该授权的精确字节/记录 ID，另绑定当次 subject/candidate/commit/artifact、独立 reviewer 身份、证据集、scope/exclusions、有效条件。用户的代理授权是允许有证据后作决定，不是决定已经作出；namespace 的具体新增定义权应在 Step 4 绑定已授任务的有限范围，而非凭拥有测试账号给所有平台对象自授无限权限。独立 Reviewer 与作者分开，接受代理可以消费其证据；前置 Gate 不通过时保留阻断事实。

下一动作：完成 scanner 的缺漏提取与真实反例验证，同时补四个来源或其确切历史处置证据，再重新生成 Step 3 清单并独立核对覆盖分母。
