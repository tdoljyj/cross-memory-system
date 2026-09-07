# Clued Context Ownership / Publication v1.1 交付索引

原始日期：2026-09-07。最新处置：2026-09-08。

**状态：`SUPERSEDED_BEFORE_ACTIVATION`。**

本目录保留为历史实现、验证与迁移证据。原 v1.1 的独立发布任务及其核心场景——“Developer 先以独立连接保存开发 Context，之后 Dogfood/User 登录，再通过 Owner Grant + Project Link 将既有开发历史桥接给独立 User Binding”——已被后继的**账户登录后 Clued MCP 显式连接授权**方案取代，不再继续按本目录原发布流程上线或签发完成回执。

## 后继任务

真实后继候选为：

- 分支：`feat/clued-unified-skill-authorization`
- 当前候选提交：`3dbda2396f1a8fdc78336950a8caa0b6bd81c15d`
- 提交说明：`Unify Clued skill and add explicit connection authorization candidate`
- 后继说明：`apps/clued-cloud/docs/connection-authorization-rollout.md`

后继模型以同一个经过认证的人类 Clued/Supabase 账户为身份基础。每次 MCP/OAuth 连接必须独立显式同意，并获得精确的 `resource / action / environment` 权限；Skill 不产生权限，工作流名称也不能扩大权限。Developer 能力因此属于账户登录后的可选连接授权，而不是一个需要日后再桥接回 User 的脱离账户身份。

## 2026-09-08 生产处置事实

在确认本任务被后继方案取代之前，v1.1 数据库迁移已经被执行到正式 Supabase `ccxsikzwxlolxqlosril`。生产 migration history 中记录为：

`20260907140346 clued_context_ownership_publication_v11`

随后对以下 10 个 v1.1 业务表做只读计数核验，**全部为 0 行**：

- `clued_private.context_spaces_v11`
- `clued_private.context_records_v11`
- `clued_private.context_record_versions_v11`
- `clued_private.context_grants_v11`
- `clued_private.context_links_v11`
- `clued_private.context_acceptances_v11`
- `clued_private.context_publications_v11`
- `clued_private.context_publication_heads_v11`
- `clued_private.context_feedback_v11`
- `clued_private.context_operations_v11`

因此当前只有数据库结构进入生产，没有 v1.1 Context、Grant、Link、Acceptance、Publication、Feedback、Operation、Receipt/Event 业务依赖被创建。

同时：

- `main` 已包含实现提交 `5344d320ecee49655999bdf1f473406d38387fad`；
- 没有可验证证据证明正式 Worker `clued-cloud` 已部署该 v1.1 提交；
- 没有证据证明旧 `CONTEXT_OWNERSHIP_V11` 发布流程已完成限定启用；
- 没有新建 v1.1 production Grant / Link；
- 没有完成旧方案要求的 Developer + User 双连接生产验收；
- 没有签发旧 v1.1 的最终 Production Release Receipt。

## 停止与保留规则

从本决定生效起：

1. **停止**旧 v1.1 独立发布任务的 Worker 部署、旧式能力启用、Grant/Link 桥接、双连接验收和最终 Release Receipt。
2. **不得**为了清理状态而 DROP 已落库的 v1.1 表、函数或历史 migration，也不得 force/reset 仓库历史。
3. v1.1 已落库结构保持未消费状态，直到后继授权任务明确决定哪些底层结构继续复用、哪些需要通过前向 migration 退役。
4. 后继授权候选当前明确把 `CONTEXT_OWNERSHIP_V11` 作为开发 Context 工具的底层依赖之一。因此，`SUPERSEDED_BEFORE_ACTIVATION` 指向的是**旧独立发布/桥接任务与其验收语义**，不等于宣告所有 v1.1 schema 或 Context 工具必须删除。
5. 任何后续生产启用必须以新的连接授权候选及其接受/发布 Gate 为准，不能拿本目录旧计划或旧测试结果冒充新授权体系已经通过。

## 历史实现和证据

原实现仍可作为后继设计的历史输入与底层证据：

| 材料 | 历史用途 |
|---|---|
| [完整方案](Design-v1.1.md) | v1.1 设计与 37 个验收场景 |
| [低成本执行计划](ExecutionPlan.md) | 37 场景映射 16 个 P0 组 |
| [范围与发布边界](ScopeAndRelease.md) | 原精确起点、目标、待验事项及回退 |
| [适配合同](AdapterContract.md) | 原 Developer/User 接线合同 |
| [浏览器验证](BrowserValidation.md) | 原 Owner 登录与浏览器操作证据 |
| [独立范围审查](evidence/IndependentScopeReview.md) | 原能力与既有冻结对象边界 |
| [独立实现验收](evidence/IndependentValidation.md) | 原本地实现验收及未通过范围 |
| [数据库结构化证据](evidence/DatabaseEvidence.json) / [运行日志](evidence/database-regression.log) | 原 PostgreSQL 基线 |
| [接口及旧回归](evidence/api-regression.log) | 原接口和 continuity 回归 |
| [构建清单](evidence/BuildManifest.json) / [构建](evidence/build.log) / [类型](evidence/typecheck.log) / [静态检查](evidence/lint.log) | 原构建与静态证据 |
| [源码清单](evidence/SourceManifest.json) | 原源码摘要与迁移版本绑定 |
| [废止决定](evidence/SupersessionDecision_20260908.md) | 2026-09-08 后继取代与生产停线决定 |

历史 PASS 只对各自原受验对象有效；它们不能自动升级为新统一 Skill / MCP 连接授权体系的接受、部署或 Authority Effect。
