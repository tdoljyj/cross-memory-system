# Clued 单一数据源与两级五视图架构方案

- 版本：v1.6
- 日期：2026-08-25
- 状态：架构合同；生产 Canonical Store 已存在，本文定义的真实目录迁移尚未执行
- 当前适用范围：Clued 个人用户画像、全局级五视图、项目级五视图、Canonical Record、Project、Event、Receipt、证据、索引、仓库镜像与可移植 Bundle
- 非当前范围：团队工作区、多成员协作、组织级权限与通知确认；相关内容仅作为附录中的未来扩展，不阻塞本方案落地

## 1. 结论

Clued 采用“**一个权威数据源、三个信息层级、两级五视图**”结构：

- 一个权威数据源：生产环境中的 Clued Cloud Canonical Store。
- 三个信息层级：用户画像、全局级工作、项目级工作。
- 两级五视图：全局级五视图与项目级五视图。
- `profile.md` 是画像视图，不属于工作五视图。
- `objects/`、`events/` 是某个已提交快照的结构化导出。
- Markdown 是从结构化快照生成的只读派生视图。
- Index 是可重建的查询加速结构，不是事实源。

核心原则：

> 业务信息只写一次。Profile、Global、Project、Markdown、索引和 UI 只通过同一个 canonical ID 查询、引用和展示，不保存互相独立的重复正文。

本方案首先解决个人用户跨 AI、跨项目和跨设备的连续性。团队协作不得通过重新解释现有 Global 的含义来实现，而应在未来增加独立的 Workspace 层级。

## 2. 当前实施边界

### 2.1 v1.6 的规范性目标

v1.6 保留完整目标合同，但不要求所有能力在第一次目录整理中同时上线。完整目标包括：

1. 明确 Clued Cloud Canonical Store 是生产唯一事实源。
2. 建立 `profile/global/projects` 目录合同。
3. 明确 Record、Project、Event、Receipt、Evidence、Object、Markdown 与 Index 的关系。
4. 明确 State、Task、Decision、Archive、Log 的职责边界。
5. 明确同一 canonical ID 的作用域提升、降级、合并与只读引用。
6. 明确 Record、Project、Event、Receipt 和 Evidence 的独立写入合同。
7. 明确 CAS、幂等、成功事务、失败审计与一致快照。
8. 实现可失败恢复、可重复运行、可回滚的目录迁移。
9. 保持个人用户数据由 `user_id + RLS` 隔离。

### 2.2 分级落地，不降低最终完整度

实施分为三个门禁，详细步骤见第 15 节：

| 门禁 | 目标 | 完成后允许声明 |
|---|---|---|
| M0：安全目录落地 | 从现有 Canonical Store 或已验证 Bundle 只读生成目标目录；保留全部可依法保留的身份/序列位置与获授权原件，敏感内容使用可核对桩；不做语义合并，不改数据库 Schema | “两级五视图目录基线已落地”，并注明来源快照及是否验证为生产当前版本 |
| M1：运行时合同闭环 | 验证或补齐 Record、Project、Event、Receipt、Evidence、CAS、幂等、Scope、授权及已有重定向读取；新建 Record/Project Merge 按真实需求启用 | “个人级两级五视图架构已闭环”，并列出未启用的可选合并能力 |
| M2：按能力启用 | Event Rollup、冷存储、持久快照版本库、自动修复、索引分片和语义辅助 | “M2：`<具体能力>` 已启用”；仅全部通过时才可作总体声明 |

M0 是最低安全落地点，不是删减版目标。被延后的能力必须保留在 M1/M2 合同和验收标准中，不能静默消失；同时也不能因为 M2 尚未实现而阻塞当前目录整理。

已有生产能力不要求为了满足本文重新实现。若现有 API、数据库事务、RLS 或测试已经满足某条 M1 合同，可以用可复核证据直接通过该门禁。

本文的实体名和操作名是逻辑合同，不强制一实体一张新表、一合同一个新端点或拆成微服务。现有表、RPC、Worker 或 Adapter 只要能证明相同输入、原子性、授权、版本与输出语义，即可复用；物理重构不能被当成 M0/M1 的隐含前置条件。

### 2.3 当前规模下可延后但不可遗忘的能力

以 2026-08-25 已验证的个人数据规模（4 个 Project、262 条 Record）为当前裁剪依据，下列能力进入 M2：

- Event Rollup 与 Event 冷存储；M0/M1 直接保留 Raw Event。
- Bundle Index 分片；当前只生成一个 `index.json`。
- 多版本长期保留、自动清理和后台发布协调；M0 只保留完成原子切换所需的当前/上一版本。
- Reconciler、Sweeper、自动告警和无人值守修复；M0 失败时停止发布并保留报告。
- 语义自动去重、自动 Scope 提升和自动合并；M0 只报告候选，不执行语义变更。
- Workspace/Team 与组织级权限。

### 2.4 本版本不阻塞于以下产品能力

下列能力合理，但不属于两级五视图目录迁移的完成条件：

- 团队租户和组织工作区；
- `tenant_id + role + project_membership` 权限系统；
- 团队决策广播和确认；
- 团队级通知中心；
- 多租户索引分片；
- 跨组织 Bundle；
- 多成员 Profile 共享。

这些能力统一放入附录 A。它们不能阻塞当前个人级结构落地，也不能改变 Profile 和 Global 已确定的语义。

## 3. 权威数据与派生关系

### 3.1 生产环境唯一事实源

在本文的目标合同中，生产唯一事实源为 Clued Cloud Canonical Store，逻辑上包括：

1. Canonical Record：状态、任务、决策、画像事实、一般长期记录及其生命周期状态。
2. Event：操作、变化、失败、撤销与冲突的事件流水。
3. Receipt：每次写入及幂等重放的审计回执。
4. Project：稳定的项目身份、确定程度、进度状态、别名与合并关系。
5. Evidence Metadata：证据位置、哈希、来源、归属和访问范围。

上述是目标逻辑模型，不等于声明每个字段、实体或操作已经按本文形式部署。现有实现是否满足等价的原子性、授权、版本和审计语义，由 M1 的可复核证据与合同测试确认；本文自身不能作为“生产已实现”的证明。

#### 3.1.1 术语约束

本文不使用“Canonical Object”作为泛化术语，避免它与 `objects/` 目录混淆。统一使用：

| 术语 | 准确定义 |
|---|---|
| Canonical Store | 生产环境中保存权威业务实体的整体数据层 |
| Canonical Record | `state`、`task`、`decision`、`profile_fact`、`note` 等长期业务记录；归档由生命周期状态派生，不是独立事实副本 |
| Project | 具有稳定 `canonical_project_id` 的项目身份实体，不是 Canonical Record 的 `record_type` |
| Event | 与 Record 分离的只增事件实体，记录操作、结果、失败和变化 |
| Event Stream | 可选排序扩展：同一已验证所有者、同一精确 Event Scope 与同一 stream generation 下的已提交 Event 序列；仅作为实际启用 M2 Rollup 的前置门禁，未启用 Rollup 时不强制 |
| Receipt | 写入、重放、合并和证据关联的审计回执 |
| Evidence Metadata | 原始材料的结构化元数据；正文或二进制保存在受控存储中 |
| `objects/` | Canonical Record 与 Project 的导出快照目录，不是生产在线写入目标 |
| Entity `version` | 单个 Record 或 Project 的正整数 CAS 版本；只在该实体成功变更时递增 |
| `canonical_version` | Canonical Store 一次已提交一致读点/事务版本，用于冻结跨实体快照；不等同于任一实体 `version` |
| Event `committed_canonical_version` | 该 Event 所在事务的提交版本；在 Bundle 中位于 Event `data`，可能早于外层代表冻结读点的 `canonical_version` |
| `snapshot_version` | 某次 Bundle 构建身份，由 canonical 读点、生成器、配置、策略与构建时点确定；不作为在线写入 CAS |

“Object”一词仅用于 `objects/` 快照目录或已有产品名“Memory Object”的兼容表达；实现合同必须进一步落到上述具体实体，不得把 Canonical Record、Project 与快照文件混成同一种类型。

生产环境使用 `user_id + RLS` 隔离不同用户。服务端必须从已验证身份中取得 `user_id`，不得信任客户端自行提交的所有者字段。

Git 仓库、Markdown、本地 JSON 和索引均不得取代生产数据库成为在线事实源。

### 3.2 仓库镜像与可移植 Bundle

仓库镜像或 Bundle 是某个 `snapshot_version` 的只读、可移植导出：

- `objects/`：Canonical Record 与 Project 的结构化快照。
- `events/raw/`：Rollup 未启用时为每个导出范围内 Event 保存经过 4 节 Actor 脱敏的授权完整投影或策略要求的省略桩；启用后保存仍在明细保留期内的授权投影或桩。
- `events/rollups/`：M2 可选；启用保留策略后，由一段连续 Event 范围生成的结构化保留期摘要。
- `evidence/`：原始材料、附件、引用与旧格式文件。
- Markdown：从 Object、Raw Event 与已启用的 Event Rollup 确定性生成的阅读视图。
- Index：从相同输入确定性生成的单一 Bundle 查询索引。
- Manifest：快照版本、生成状态、数量和文件哈希。

在生产系统中，Canonical Store 是权威源；在一个已经导出的只读 Bundle 内，`objects/` 与 `events/` 是重建 Markdown 和 Index 的权威输入。

这两句话不冲突：Bundle 只能描述导出时的生产快照，不能通过手工修改后自动反向覆盖生产。

如果未来支持离线编辑，必须另行设计经过授权、校验、CAS 和审计的 Import 流程；本方案不允许将修改后的 Bundle 直接当成生产写入。

默认个人 Bundle 不导出完整 Receipt 账本，只在 Object、Event 和 Manifest 中保留必要的 `receipt_id` / `export_receipt_id` 引用。默认 Bundle 也不导出 `profile` 或 `audit_only` Event 的敏感 payload：它为每个此类 Event 保留 ID、提交版本、内容哈希、`omitted_reason` 以及源中真实存在的可选 Stream/sequence 桩；只有用户显式请求受保护审计导出且目标存储满足保护要求时才包含完整内容。完整 Receipt 与敏感审计 Event 只能通过受保护的审计 API/MCP 或单独授权的审计导出获得。该边界不改变它们在 Canonical Store 中的权威性，也不造成可依法保留的 Event 身份缺口。

M0 不要求旧数据先满足 v1.6 新 Schema。任何缺少新字段的 Record、Project、Event 或 Evidence Metadata 都使用通用兼容信封，禁止补造 `request_hash`、`receipt_id`、`audit_visibility`、Scope 或其他历史上不存在的字段：

```yaml
kind: legacy_record | legacy_project | legacy_event | legacy_evidence
legacy_id: original-stable-id
legacy_schema_version: string | null
legacy_record_type: original-record-type | null
inline_payload: original-payload-if-authorized | null
protected_payload_ref: protected-source-ref | null
content_hash: sha256
missing_required_fields: []
migration_status: preserved | pending_review
omitted_reason: sensitive | unauthorized | secret_detected | null
```

如果原 payload 允许导出，则 `inline_payload` 原样保存；如果命中隐私、授权或凭据限制，只保存哈希、受保护引用与 `omitted_reason`，不能为了“完整复制”把敏感内容写进 Bundle。M1 完成明确映射前，兼容信封不得被当成符合新 Schema 的当前事实。

### 3.3 Bundle 隐私边界

Bundle 必须满足：

1. 每次只导出一个已授权用户可见的数据范围。
2. 导出接口复用生产读取授权，不得绕过 RLS。
3. `manifest.json` 不保存邮箱、真实姓名、原始 `user_id`、Token、Cookie、Client Secret 或 Service Role Key。
4. 审计关联使用不透明的 `export_receipt_id`；如确需区分数据所有者，只能使用不可反查身份的 `owner_ref`。
5. Evidence 按所属 Record 的访问范围导出，不因位于 `evidence/` 而降低保护级别。
6. Bundle 的传输、落盘和删除遵循用户授权及数据保留政策。
7. 导出前执行凭据、隐私和授权扫描；禁止导出的原件仍保留在 Canonical Store 或受保护 Evidence 存储，Bundle 只生成哈希、受保护引用和 `omitted_reason` 桩。
8. `profile`、`audit_only` Event 默认按 3.2 节生成省略桩；显式审计导出必须单独记录授权范围、目标保护级别与审计 Receipt。

## 4. 最终目录结构

机器路径统一使用小写英文；中文产品界面显示“画像、全局级、项目级、状态、任务、决策、归档、日志”。

```text
memory/
├── profile.md                 # 用户画像，只读派生视图
│
├── global/                    # 全局级五视图
│   ├── state.md
│   ├── task.md
│   ├── decision.md
│   ├── archive.md
│   └── log.md
│
├── projects/                  # 项目级五视图
│   └── {canonical_project_id}/
│       ├── state.md
│       ├── task.md
│       ├── decision.md
│       ├── archive.md
│       ├── log.md
│       └── redirect.json      # 仅目标链可验证的 merged 源使用，并替代上述五视图
│
├── objects/                   # Canonical Record / Project 结构化快照
│   ├── records/{record_id}.json
│   ├── projects/{canonical_project_id}.json
│   └── legacy/{record|project|project_redirect}/{legacy_id}.json
├── events/                    # Event 与可选保留期摘要快照
│   ├── raw/                   # `{event_id}.json`；仅排序扩展启用后，无 ID 擦除桩可进 tombstones/{stream_id}/{sequence}.json
│   └── rollups/               # 可选；M2 启用保留策略后生成 Event Rollup
├── evidence/                  # 原始材料、附件、引用、旧格式证据与迁移报告
│   ├── items/{evidence_id}/  # metadata.json + 授权 payload 或 omitted.json
│   ├── legacy/               # 允许导出的旧文件；敏感项使用受保护引用桩
│   └── migration/            # 随 Bundle 发布的迁移报告；可用单一合并文件
├── manifest.json              # 快照版本、数量、哈希与生成状态
└── index.json                 # 单一 Bundle 派生索引：ID 定位、Scope 过滤与轻量召回
```

该目录描述一个用户授权范围内的快照。未来团队工作区不通过把 `global/` 改成团队全局来实现，见附录 A。

未合并 Project 目录必须包含五个 Markdown 且不得包含 `redirect.json`；具有可验证最终目标的 merged 源目录只包含 `redirect.json`，保存源 ID、最终目标 ID、逐段 merge-time Project version/Receipt 和内容哈希，不再生成五视图。Project 的完整实体快照仍只在 `objects/projects/`，因此 redirect 只是派生路径 tombstone，不是第二份项目事实。历史 merged 声明若连最终目标链都无法验证，则不得生成可跟随 redirect，按本节兼容规则暂时保留五视图和待评审提示。

所有结构化快照文件统一使用以下外层信封；`event_rollup` 与 `project_redirect` 虽是派生物，也使用同一信封，但其 `data` 分别遵循 12.1 节和本节下方的专用 Schema：

```yaml
kind: record | project | event | event_stub | erasure_tombstone | evidence_metadata | event_rollup | project_redirect | legacy_project_redirect | legacy_record | legacy_project | legacy_event | legacy_evidence
schema_version: positive-integer
snapshot_version: opaque-version
canonical_id: opaque-id | null-for-unmapped-legacy-or-policy-erasure
canonical_version: opaque-version-or-integer | null-for-legacy
data: entity-payload-or-legacy-envelope
```

- 对尚未完成 ID 映射的兼容项，`canonical_id` 允许为 `null`，但必须以原始 `legacy_id` 定位；不得为了满足新信封而伪造 canonical ID。只有删除政策禁止保留 Event ID 的 `erasure_tombstone` 也可为 `null`，并改由已有 Stream/sequence 路径定位。
- Record 与 Project 只能分别写入 `objects/records/`、`objects/projects/`；旧 Record/Project 兼容信封进入 `objects/legacy/`。
- 旧 Event 兼容信封进入 `events/raw/{legacy_id}.json`；旧 Evidence Metadata 兼容信封进入 `evidence/items/{legacy_id}/metadata.json`，旧 Evidence payload 或文档进入 `evidence/legacy/`。不得把 Event 或 Evidence 兼容项塞入 `objects/`。
- 缺少新版 merge Receipt/version 证明的旧 Project redirect 使用下方 `legacy_project_redirect`，不得伪造标准 `project_redirect` 字段。
- Raw Event 进入 `events/raw/{event_id}.json`；Rollup 进入 `events/rollups/{rollup_id}.json`。
- 启用 Event Stream 排序扩展且擦除政策禁止保留原 Event ID 时，`erasure_tombstone` 使用 `events/raw/tombstones/{event_stream_id}/{event_sequence}.json`；其路径只表达非识别性连续位置。未启用该扩展时不得补造 Stream/sequence，依法擦除只按第 12 节记录允许保留的删除边界。
- Evidence Metadata 固定为 `evidence/items/{evidence_id}/metadata.json`。其 `data` 至少包含 `evidence_schema_version`、`evidence_id`、类型、内容哈希、MIME、大小、捕获/记录时间、由 Record 反向解析得到的 `referenced_by` / `derived_scopes`，以及 `export_disposition=included|omitted`。获授权 payload 与其同目录；不能导出的 payload 使用 `omitted.json` 保存哈希、受保护引用和原因。
- 默认 Bundle 中被隐去正文的当前 Event 使用同路径的最小连续性桩：`kind=event_stub`。文件外层保存 `snapshot_version` 和代表 Bundle 冻结读点的 `canonical_version`；`data` 保存下方专用 Schema 的 Event `committed_canonical_version`、ID、Scope、可见性、哈希、省略原因及源中真实存在的可选 Stream/sequence 字段。两种版本语义不同，不使用同名字段双写。桩不得包含敏感 `target_refs`、错误详情或 Evidence 正文。依法擦除后如政策允许保留非识别性连续元数据，则改为 `kind=erasure_tombstone`，`content_hash` 可为 `null`。
- 所有路径必须由规范化、路径安全的 opaque ID 构成；原始标题、用户名或外部文件名不得直接作为目录身份。
- 每个结构化文件的 `snapshot_version` 必须与 Manifest 一致；Index 只引用上述路径，不复制 `data` 正文。

merged 源的 `redirect.json` Schema 固定为：

```yaml
kind: project_redirect
schema_version: positive-integer
snapshot_version: opaque-version
canonical_id: source-canonical-project-id
canonical_version: bundle-frozen-store-version
data:
  source_project_id: canonical-project-id
  final_target_project_id: canonical-project-id
  redirect_path:
    - source_project_id: canonical-project-id
      source_committed_version: positive-integer
      target_project_id: canonical-project-id
      target_committed_version: positive-integer
      merge_receipt_id: opaque-receipt-id
  closure_hash: sha256
  content_hash: sha256
```

`redirect_path` 按源到最终目标排序：第一段 source 必须等于外层 `canonical_id`，每段 target 必须等于下一段 source，最后一段 target 必须等于 `final_target_project_id`，且不得重复 Project ID。每段 version 是该 Merge Receipt 记录的事务提交后版本，不随目标 Project 之后的普通名称、进度或别名更新而变化；最终目标或 closure 改变时必须重建全部反向可达 redirect。`closure_hash` 覆盖完整规范化 `redirect_path`；`content_hash` 对除 `data.content_hash` 自身外的完整信封使用确定性 canonical JSON 计算。路径必须与 Canonical Project 关系、Receipt 引用、`index.json.by_id` 和 Manifest 版本一致，否则标准 tombstone 不可发布。

旧数据已能从 Canonical Project 关系证明无环 source→final target，但缺少部分历史 merge Receipt/version 时，使用兼容 tombstone：

```yaml
kind: legacy_project_redirect
schema_version: positive-integer
snapshot_version: opaque-version
canonical_id: source-canonical-project-id
canonical_version: bundle-frozen-store-version
data:
  source_project_id: canonical-project-id
  final_target_project_id: canonical-project-id
  original_redirect_chain: [ordered-canonical-project-id]
  missing_proof_fields: [field-id]
  proof_status: legacy_preserved
  protected_source_ref: protected-ref | null
  content_hash: sha256
```

`legacy_project_redirect` 不得补造 Receipt 或 version；其 `content_hash` 覆盖除自身外的完整信封，Index 必须标记 legacy proof。只有 source、无环链与最终目标能从冻结输入直接验证时，它才可位于 `projects/{source_id}/redirect.json` 并参与只读解析。若最终目标或链本身仍有歧义，兼容信封改存 `objects/legacy/project_redirect/{source_id}.json`、进入 `pending_review`，源项目暂时保留五视图并显示“合并关系待确认”，不能撤下目录或猜测路由。

Event 连续性桩的 `data` Schema 固定为：

```yaml
event_id: opaque-event-id | null-only-when-erasure-policy-forbids-retention
event_stream_id: opaque-event-stream-id | null-when-ordering-extension-disabled
stream_generation: nonnegative-integer | null-when-ordering-extension-disabled
event_sequence: positive-integer | null-when-ordering-extension-disabled
committed_canonical_version: event-transaction-store-version | null-only-for-erasure-tombstone
event_scope: profile | global | project:{id}
audit_visibility: audit_only | work_log
content_hash: sha256 | null-only-for-erasure-tombstone
omitted_reason: sensitive | audit_only | unauthorized | erased
erased_at: ISO-8601 | null
erase_receipt_id: opaque-receipt-id | null
```

`event_stub` 必须有 Event ID 与内容哈希；三项 Stream/sequence 字段必须全为空或全非空，不得部分补造。`erasure_tombstone` 是否保留 Event ID、内容哈希或序列位置由第 12 节政策决定。两者仍使用外层 `snapshot_version` / `canonical_version`，且不得携带 Event 正文或目标详情。

Canonical Event 与 Bundle Event 必须使用不同的授权投影，防止把生产身份字段直接写进仓库：

- Canonical Event 按 9.3 节保存服务端 `actor_user_id` / `actor_binding_id`，其 `content_hash` 覆盖完整 Canonical Event。
- `kind=event` 的完整 Bundle 投影必须移除原始 `actor_user_id` 与 `actor_binding_id`，改为 `actor_kind=self|agent_binding|system` 和可选 `actor_ref`。Canonical Event 的 `actor_user_id=null, actor_binding_id=system` 必须投影为 `actor_kind=system, actor_ref=null`；数据所有者仍由受保护的 RLS/owner 关系表达，不能冒充执行 Actor。其他 `actor_ref` 只能是本 Bundle 范围内、使用未导出密钥派生的不可逆引用，不能等于生产 ID。
- 完整 Bundle Event 把 Canonical Event 的哈希保存为 `canonical_content_hash`，并另存 `export_content_hash`；后者对移除 `export_content_hash` 自身后的授权投影使用 9.0 节 canonical JSON 计算。Manifest 文件哈希再覆盖整个导出文件。这样既能核对来源身份，又能验证脱敏后的实际字节，不要求把原始 Actor 字段导出。
- 完整 Bundle Event 的 `data.committed_canonical_version` 保留 Event 事务提交版本；结构化文件外层 `canonical_version` 始终等于 Manifest 的 Bundle 冻结读点，二者不得互相覆盖或强制相等。
- `event_stub.data.content_hash` 表示对应 Canonical Event 哈希；桩本身由 Manifest 文件哈希保护。若保留该哈希也违反删除政策，则只能使用 `erasure_tombstone` 并置空，不能用导出投影哈希冒充原 Canonical 哈希。

## 5. 三个信息层级

### 5.1 Profile：用户画像

`profile.md` 回答“用户是谁”，包括：

- 身份与职业；
- 能力与长期经历；
- 表达、工具和工作偏好；
- 长期约束与明确否决项；
- 与具体项目无关的稳定事实。

Profile 不是工作五视图之一，但属于 Clued 连续性恢复的核心入口。它默认仅对用户本人及其明确授权的 AI Binding 可见。

Profile Record 的创建、修改、撤销和依法执行的擦除仍会按适用保留政策产生 `event_scope=profile`、`audit_visibility=audit_only` 的最小 Event，用于受保护的审计与恢复，但这些 Event 不生成 `profile/log.md`，也不自动进入 `global/log.md`。完整内容仅可通过经过授权的审计 API/MCP 工具、产品中的个人记忆历史入口或显式受保护审计导出读取；默认 Bundle 只含不可反查敏感正文的连续性桩。

### 5.2 Global：用户全局级五视图

Global 的含义固定为“**该用户跨项目的全局工作控制面**”，不得解释为团队或组织全局。

| 视图 | 职责 |
|---|---|
| `state.md` | 用户全局状态、项目注册表、跨项目优先级、阻塞与健康摘要 |
| `task.md` | 用户全局任务、各项目任务入口、排序与当前唯一重点 |
| `decision.md` | 跨项目、产品级和长期有效决策 |
| `archive.md` | 已关闭项目、阶段、任务和被替代决策的终态摘要与 canonical ID 引用 |
| `log.md` | `event_scope=global` 的 Event 查询视图；跨项目时间线由运行时联合查询提供，不复制 Project Event |

Global 可以聚合项目摘要和引用，但不得复制项目正文。

### 5.3 Projects：项目级五视图

项目级负责单个项目的完整工作上下文：

| 视图 | 职责 |
|---|---|
| `state.md` | 项目阶段、进展、阻塞、当前目标与唯一下一步 |
| `task.md` | 项目任务队列、优先级、状态与依赖 |
| `decision.md` | 仅影响该项目的正式决策及理由 |
| `archive.md` | 项目内已关闭阶段、完成任务和被替代方案 |
| `log.md` | 未合并项目按自身 Scope 过滤；合并目标还联合其 Project merge closure 中的源项目历史 Event，并按 Event ID 去重 |

项目有两个用户可编辑的业务维度：

```yaml
certainty_status: unconfirmed | confirmed
progress_status: active | paused | completed | archived
```

另有一个仅由系统命令维护的身份解析状态：

```yaml
lifecycle_status: active | merged
merged_into_project_id: canonical-project-id | null
```

普通 Project Mutation 不能直接提交 `lifecycle_status=merged`；只有 9.2 节的显式 Project Merge 可以设置它。

项目从未确定转为已确定时，只更新同一个 Project 实体的 `certainty_status`，不得改变 `canonical_project_id`，不得复制目录、正文或历史。

`certainty_status` 变化必须通过 9.2 节 Project Mutation：执行 CAS、产生 Event 与 Receipt、递增 version，并触发 6.2 节定义的受影响视图重渲染。

由于机器路径始终使用 `projects/{canonical_project_id}/`，确定程度变化不得改变项目路径，也不应使稳定的“路径 → canonical_project_id”身份映射失效。必须失效的是所有依赖 `certainty_status` 的派生查询和缓存，包括：未确定/已确定项目列表、Global 项目注册表、项目分组与筛选、相关 Task/Archive 聚合以及 Index 条目。客户端不得把这些派生缓存当作项目当前状态的事实来源。

## 6. 唯一写入与视图生成

### 6.1 唯一写入方向

```text
用户或 Agent 请求
    ↓
统一写入服务
    ├── 身份与授权校验
    ├── CAS / 幂等校验
    ├── 写入 Canonical Record / Project
    ├── 追加 Event
    └── 生成 Receipt
          ↓
提交 canonical version
          ↓
Snapshot Builder 生成同版本 Object / Event 快照
          ↓
Renderer 生成 Markdown、Manifest 与 Bundle Index
```

禁止以下写入方式：

- 直接编辑 Markdown 后再抽取 Object；
- 同时写 Object 和 Markdown 两份正文；
- 通过修改 Index 改变业务数据；
- 用 Log 中的旧文字反推当前状态、待办或决策；
- 用修改后的仓库快照直接覆盖生产数据；
- 绕过统一写入服务和 RLS 直接写 Canonical Record。

图中“追加 Event”适用于会改变 Record/Project、关系、Scope 或工作历史的操作。尚未关联、保持所有者私有的 Standalone Evidence Ingest 没有合法工作 Scope，只原子写入 Evidence 与 committed Receipt；首次关联时才由 Record Mutation 产生 Event。

### 6.2 Markdown 生成机制

Renderer 只重新生成受影响的视图：

| Canonical 变化 | 受影响视图 |
|---|---|
| Profile Record 变化 | `profile.md` |
| Global Record 变化 | 对应 `global/*.md` |
| Project State 变化 | 按 `effective_project_id` 重建项目 `state.md`；阶段、当前目标、阻塞或健康摘要变化同时重建 `global/state.md` |
| Project Task 变化 | 按 `effective_project_id` 重建项目 `task.md`；`execution_bucket`、priority、依赖、阻塞或生命周期变化同时重建 `global/task.md`，其中 now/blocked 变化还重建 `global/state.md` |
| Project Decision/Note 变化 | 按 `effective_project_id` 重建对应项目 `decision.md` 或 Index；只有被显式 Global Record 引用的摘要依赖变化才重建相应 Global 视图，不复制正文 |
| Project Record 进入终态 | 按有效 Scope 重建项目 `archive.md` 及受影响的当前视图；若它曾驱动 Global 项目入口、阻塞或任务聚合，同时重建对应 Global `state.md` / `task.md` / `archive.md` |
| Project 实体的名称、确定程度、进度、别名或合并关系变化 | 普通变化重建对应项目与 Global 聚合；合并变化重建新旧 merge closure 中全部源 `redirect.json`、最终目标五视图/Log、Global `state.md` 及受影响的 Global `task.md` / `archive.md`、Log 路由和 Index |
| `audit_visibility=work_log` 且 `event_scope=global` 或 `project:{id}` 的 Event 追加 | Global 使用精确 global Scope；Project 使用自身 Scope，加目标项目 merge closure 中的不可变源项目历史范围 |
| `audit_visibility=audit_only` 或 `event_scope=profile` 的 Event 追加 | 不生成 Markdown Log；仅更新生产环境受保护的审计检索索引。默认 Bundle Index 只定位省略桩，不索引敏感 payload |
| Global Record 的生命周期进入 completed、cancelled、superseded、archived、revoked | 同一 canonical ID 进入 `global/archive.md` 查询结果，并从相应当前视图退出 |
| Profile Record 进入非 active 生命周期 | 从 `profile.md` 当前画像移除；保留 Canonical、Event、Receipt 与授权审计读取，不生成 `profile/archive.md` |
| 可召回字段变化 | 对应 Bundle Index 条目 |

每个 Markdown 条目必须保留 canonical ID 和版本，例如：

```text
- `record-id` — 标题：结论或摘要 [lifecycle_status=active; version=13]
```

Markdown 可以展示摘要、排序和关联关系，但不得包含可被单独维护的第二份权威正文。

M0 Renderer 必须是模板化、确定性的：只读取已存字段，使用固定排序、转义和截断规则，不在构建时调用生成式模型补摘要、分类或改写正文。缺少摘要时展示 canonical title/受限摘录或明确的“待评审”占位；任何模型建议只能进入候选报告，不能悄悄改变正式视图语义。

### 6.3 stale 的准确语义

如果 Canonical Store 已提交成功，但快照或 Markdown 渲染失败：

1. Canonical 写入保持有效，不回滚成旧业务数据。
2. 尚未发布的候选快照写入 `status=failed, views_stale=true` 的候选 Manifest 或等价失败报告。
3. 不切换正式快照指针，不宣称 Markdown 或 Bundle 已更新。
4. M0 由操作者使用同一 canonical version 显式幂等重建；M2 启用后可由 Reconciler 执行。
5. M0 保存失败报告并停止发布；M2 的自动重试必须有上限和退避，超过阈值生成运维告警。

原业务写入的 committed Receipt 不得因 Renderer 后续失败而改成 failed。M0 离线生成失败只写本地迁移失败报告，不要求数据库 Receipt；M1 在线 Renderer 失败另写最小化系统失败 Receipt，如需 Event 则使用 `audit_visibility=audit_only`。两种情况都只更新派生状态 `views_stale`。

`views_stale` 只描述派生快照、Markdown、仓库镜像或 Bundle，不描述 Canonical Store。

`views_complete` 另行描述是否仍有会影响当前 Profile、State、Decision 或 Now Task 的 `pending_review` 项；它不能用 `views_stale=false` 代替。结构正确但尚有此类待评审项的离线工件可以是 `views_stale=false, views_complete=false`，但不得成为当前生产镜像。

- API/MCP/UI 直接读取 Canonical Store 时，返回最新 canonical data，不应因为 Renderer 失败而标记业务数据过期。
- Snapshot、Mirror 或 Export 接口读取派生物时，必须返回其 `snapshot_version` 和 stale 状态。
- 禁止让生产 UI 依赖 Markdown 作为在线事实源。

### 6.4 Index 分层与单文件合同

必须区分生产检索索引与 Bundle Index，但一个 Bundle 在 M0/M1 只使用一个 `index.json`：

| 索引 | 用途 | 是否出现在 Bundle |
|---|---|---|
| 生产检索索引 | 在线查询、召回和过滤，可按用户或项目分片 | 否 |
| Bundle Index | 单个快照内的 ID 定位、Scope 过滤和轻量文本召回 | 是，仅 `index.json` |

`index.json` 至少包含三个逻辑分区：

```json
{
  "schema_version": 1,
  "snapshot_version": "opaque-version",
  "by_id": {},
  "by_scope": {},
  "by_status": {},
  "search": {}
}
```

- `by_id` 保存 canonical ID 到 Object 路径、类型、存储 Scope、有效 Scope、生命周期、最终重定向目标和视图引用的映射。
- `by_scope` 保存 Profile、Global 和各 Project 的有效过滤入口；Project merge 后按同一 merge closure 计算，同时保留按原存储 Scope 审计定位的非默认入口。
- `by_status` 至少保存 `pending_review`、legacy compatibility 与 merged redirect 的 ID 列表，确保未进入当前视图的对象仍可定位。
- `search` 保存可重建的轻量检索字段，不保存第二份权威正文。
- Event 范围定位如有需要，作为 `index.json` 的可选分区存在，不另建 `object-index.json`。
- Index 只能从 canonical data 或同版本 Object/Event 快照重建。
- M0 允许每次全量重建单个 `index.json`；增量更新、分片和多文件索引进入 M2。
- Index 损坏不得阻塞 canonical data 的读写；其版本与 Snapshot 不一致时必须拒绝使用。

## 7. 五视图职责合同

### 7.1 State

State 保存当前有效事实：

- 当前阶段和状态；
- 已验证的系统目标；
- 当前阻塞；
- 当前项目或全局健康摘要；
- 由当前 Scope 唯一 `execution_bucket=now` Task 派生的 canonical Task ID。

State 不保存完整历史，不通过旧日志推导当前事实，也不另写“下一动作”正文或关系字段。当前唯一执行项的权威内容和执行分桶属于 Task；Renderer 查询同 Scope 的唯一 active `now` Task 并只展示其 canonical ID。

### 7.2 Task

Task 是执行入口，保存：

- 任务身份和范围；
- active Task 的 `Now / Next / Blocked / Later` 执行分桶；
- 优先级、依赖、完成条件；
- 当前唯一执行项。

Global Task 只负责跨项目排序和项目入口；项目内部详细任务仍由同一个 canonical task ID 在项目视图中展示，不复制正文。

`Done` 不是第二个可写状态：它由 `lifecycle_status=completed` 派生；`cancelled` 等其他终态同样由生命周期进入 Archive。每个**有效 Scope**最多只能有一个 active Task 处于 `execution_bucket=now`：未合并项目的有效 Scope 等于存储 Scope，Project merge closure 内全部源 Scope 的有效 Scope 都是最终目标。写入服务必须按有效 Scope 使用数据库约束或等价串行化事务保证唯一；State 只派生展示该 Task ID。

### 7.3 Decision 与 Log

Decision 是正式决策快照：

- 低频产生；
- 保存结论、理由、适用范围和替代关系；其 active/superseded/revoked 状态由 Record 生命周期唯一表达；
- 使用新版本修改；
- 通过 9.1.1 节原子命令正向保存 `relations.supersedes`，反向 `superseded_by` 由索引确定性派生，保留决策演进而不双写关系或留下半替代状态。

Log 是 Event 的时间查询视图：

- 由实际操作自动产生；
- 逻辑上只增不改；
- 保存目标、动作、结果、证据、错误和时间；
- 不决定当前事实、任务、优先级或有效决策。

`global/log.md` 只消费 `event_scope=global`。未合并 Project 的 `log.md` 只消费精确的 `event_scope=project:{id}`；Project 合并后，目标 Log 额外联合 merge closure 中各源项目在合并前形成的不可变 Event 流，并按 Event ID 去重。经旧 ID 发生的合并后新 Event 已使用目标有效 Scope，不再写入源流。该联合只是派生读取，不复制或改写 Event。产品如需“所有互不相关项目的全部活动”，仍应在运行时联合查询，不把 Project Event 再复制进 `global/log.md`。Profile Event 属于个人敏感审计数据，不生成工作五视图中的 Log，按 5.1 节的授权审计路径读取。

已启用排序扩展的单一 Event Stream 严格按 `event_sequence` 排序。未启用或历史 Event 缺少该字段时，以 `occurred_at`、`event_id` 作确定性显示排序；合并目标联合多个历史流时，优先使用 `occurred_at`、可用的 `event_stream_id` / `event_sequence`、`event_id`。这些键只保证稳定显示，不补造因果关系，也不宣称不同流之间存在比 Canonical Store 提供的更强全序关系。

一次正式决策会同时产生：

1. 一条 Decision Record；
2. 一条“作出、修改或撤销决策”的 Event。

两者通过 canonical ID 关联，不保存互相独立的两份决策正文。

判断测试：

> 如果删除这条内容会让人不知道“现在正式采用什么及为什么”，它属于 Decision；如果删除后只会失去“什么时候发生了什么”的证据，它属于 Log/Event。

### 7.4 Archive 与 Evidence

| 判断问题 | 结果 | 归属 |
|---|---|---|
| 它曾经是有效状态、任务、决策、阶段或方案吗？ | 是 | Archive |
| 它是支撑结论的用户原话、截图、附件、链接、文件或原始输出吗？ | 是 | Evidence |

Archive 是同一批业务实体的生命周期查询视图，不是新的 `record_type`，也不创建第二份事实正文。进入 Archive 时：

- Task 保留原 `record_type=task` 和 canonical ID，更新完成状态与关闭字段；
- Decision 保留原 `record_type=decision`，通过 `superseded` 和替代关系进入 Archive；
- State 保留原 `record_type=state`，以 archived/superseded 生命周期退出当前 State；
- Project 保留原 Project ID，更新 `progress_status=completed|archived`；
- 如需收尾说明，写入原实体的 `closure_summary`、`closed_at`、`closed_reason`，不得复制成独立 `archive_snapshot` 正文。

`archive.md` 只展示这些原实体的 canonical ID、最终摘要、关闭原因和关系。已有旧 `Archive` / `archive_snapshot` Record 在 M0 以 `kind=legacy_record` 兼容信封原样保留，相关旧文档进入 Evidence；不再生成一份改写后的 Archive 正文。只有在 M1 完成人工确认后，才允许归一为原类型加生命周期状态。

Project 不使用 Record 的 `lifecycle_status` 决定归档：`progress_status=completed|archived` 使其摘要进入 `global/archive.md`，Project 的身份 `lifecycle_status` 仍为 active；`closure_summary`、`closed_at`、`closed_reason` 写回 Project 自身。它不会被复制成 Record，也不自动撤下项目目录；项目目录仍承载该项目自己的 Archive 与 Log。只有显式 Project Merge 且 9.2 节 closure 验证通过后，源身份才变为 merged，目录退化为指向目标的 tombstone。

Evidence 是原始依据，包括：

- 用户原话；
- 截图和附件；
- 外部网页或文件引用；
- 原始测试输出；
- 迁移前旧 Markdown；
- 尚未被验证为当前事实的材料。

Evidence 不能直接决定当前 State、Task 或 Decision，只能由 canonical Record 通过 `source_refs` 引用。

## 8. 作用域分类与提升

### 8.1 分类规则

| 信息 | Canonical Scope | 允许的 Record 类型 | 默认视图 |
|---|---|---|---|
| 用户身份、能力、长期偏好、长期约束 | `profile` | `profile_fact`、`note` | `profile.md`；`note` 默认只进 Index/引用 |
| 用户跨项目的状态、任务和决策 | `global` | `state`、`task`、`decision`、`note` | `global/`；`note` 默认只进 Index/引用 |
| 仅影响单个项目的信息 | `project:{id}` | `state`、`task`、`decision`、`note` | `projects/{id}/`；`note` 默认只进 Index/引用 |

例如“用户不喜欢长回复”属于 Profile，不属于 Global State。项目需要使用该偏好时，只引用同一个 canonical ID。

### 8.2 不复制原则

项目中发现跨项目信息时，不创建第二条正文。允许两种操作：

1. 修改同一 canonical ID 的 scope；
2. 保留原 scope，并在其他视图建立只读关系引用。

是否提升取决于语义是否真正跨项目，而不是某条记录被多少个视图展示。

**必要条件**：该信息脱离原 `project_id` 后仍然成立，并且含义、适用对象和有效性不发生变化。必要条件不成立时禁止提升，只能保留原 scope 或建立只读引用。

以下只能作为辅助证据，不能单独授权提升：

1. 至少两个不同项目通过同一个 canonical ID 只读引用该信息；
2. 原项目完成或归档后，该信息仍作为当前有效信息被使用，而不仅仅是出于历史审计需要；
3. 存在与目标 scope 一致的明确 `source_refs`、authority 和 confidence。

目标 Scope 按信息主体判定：

| 信息主体 | 目标 Scope |
|---|---|
| 用户身份、能力、稳定偏好、长期约束 | `profile` |
| 用户跨项目的当前状态、任务或决策 | `global` |
| 原项目的历史、结果、决策或证据 | 保留 `project:{id}`，必要时进入项目 Archive |

项目 Record 提升为 Profile 时，必须由用户显式发出 `reclassify_scope` 命令；该命令本身视为用户确认，可免二次人工复核。仅仅因为原内容带有 `authority=user_explicit`，系统也不得自主提升。`observed`、`inferred` 或 `imported` 内容必须进入 `pending_review`，在确认前只能作为候选或引用，不能写成稳定画像事实。

评审或迁移工具必须记录：必要条件是否成立、使用了哪些辅助证据、为何选择目标 Scope。不得仅凭引用数量或模型主观判断放行。

### 8.3 提升事务

```text
project scoped record + base_version
    ↓ reclassify_scope
CAS、目标 Scope/类型兼容校验
    ↓
同一 canonical ID，必要时原子转换 record_type/schema，version + 1
    ↓
同一数据库事务追加含 before/after 的 scope_changed Event 与 Receipt
    ↓
提交 canonical version
    ↓
构建并原子发布同一 snapshot_version
```

约束：

1. `reclassify_scope` 必须携带 `base_version`；所谓“提升”只是目标 Scope 更高的重分类，不另设第二套写入命令。
2. 普通 update/close/restore 不得改变 `record_type` 或 Scope。`reclassify_scope` 可以在同一事务改变 Scope；若原类型不满足 8.1 节兼容矩阵，还必须显式提交兼容的目标 `record_type`、`record_schema_version` 与转换理由并通过完整 Schema 校验，不能只换目录。
3. Record、Scope、必要的类型转换、来源关系、Event 与 Receipt 在同一数据库事务提交；Event 的 `change_summary` 保存原/目标 Scope 与类型，不复制敏感正文。
4. canonical ID 始终不变。
5. Project 与 Global/Profile 的 Markdown 变化必须随完整快照一起发布，不能逐文件切换。
6. 渲染失败时，正式快照保持上一完整版本；候选快照整体标记失败。

## 9. 并发、版本、幂等与授权

### 9.0 所有写入合同共享的请求规则

所有外部写入先经过有界原始信封捕获，再做身份、Schema、授权与规范化：

1. 对外部请求，服务端在解析业务 Schema 前对完成传输解码且通过大小上限的原始请求字节计算 `received_payload_hash`；对 Renderer 等内部命令，则对进入执行器前、包含操作族与业务参数的规范内部命令信封计算该哈希。该哈希只进入受保护 Receipt/安全审计，不进入默认 Bundle。无法建立身份或连安全信封都无法解析的外部请求只进入平台安全审计，不创建用户 Receipt。
2. Schema 校验成功后才计算 `request_hash`。其材料只包含 `operation`、目标或预分配 ID、`base_version`、业务 payload 和会改变业务语义的选项；排除 `request_hash` 自身、认证凭据、HTTP Header、追踪字段、客户端时间、重试次数以及所有服务端生成字段。`idempotency_key` 是查找键，不进入哈希材料。
3. 先应用 Schema 默认值；缺失字段与显式 `null` 保持不同语义。对象键按 Unicode 码点升序排列；普通数组保持提交顺序。Schema 声明为集合时，`aliases` 先做 NFC 规范化、再按 Unicode 码点排序并去重；`source_refs`、`evidence_refs` 与 `relations.*` 按 canonical ID 排序并去重；`source_decisions` 按 `id` 排序并拒绝重复 ID，同时保留各自 `base_version`；`target_refs` 按 `role + kind + id` 排序并去重，`artifact_refs` 按 `kind + id + content_hash` 排序并去重。
4. 字符串使用 Unicode NFC 与 LF 换行；数字使用无多余零的十进制表示并禁止 `NaN` / Infinity；最终以无 BOM、无无意义空白的 UTF-8 canonical JSON 计算 SHA-256。
5. 服务端必须计算 `request_hash`；客户端可以省略该字段。客户端如提交它，只能作为一致性声明，不能替代服务端计算，不一致时以 `REQUEST_HASH_MISMATCH` 拒绝。Receipt 与已规范化请求产生的 Event 只保存服务端计算值。只有需要在客户端预校验哈希的 SDK 才必须实现 canonical JSON；其他调用方只需提供幂等键。所有实现 canonical JSON 的 SDK、API、MCP 与迁移工具共享同一组 golden test vectors（固定输入与期望哈希样例），保证跨实现结果一致。
6. 外部请求若在业务 Schema 规范化前失败，例如非法 JSON、错误编码、超限或非法数值，只进入受保护的平台安全审计，保存 correlation ID、`received_payload_hash`（可计算时）与错误码；不创建用户 Receipt/Event，也不占用业务幂等键。修正后的合法请求可以复用原键。Canonical Receipt 从身份已建立且请求成功规范化后开始生成。
7. 规范请求的 `idempotency_key` 唯一性边界是“已验证用户 + 操作族”。相同键和相同 `request_hash` 返回原结果；相同键但不同哈希拒绝。已规范化的 rejected/failed 结果也按原结果重放；调用方若要发起新的业务尝试必须使用新键。

`actor_user_id` 与 `actor_binding_id` 均由已验证认证上下文派生，不是可信请求正文。兼容 API 即使接收 `actor_binding_id` 提示，也必须与 Token Binding 完全匹配，否则拒绝；Event 与 Receipt 中保存的是服务端派生值。

### 9.1 Canonical Record 写入合同

用户或 Agent 创建、修改、关闭、恢复或重分类 Canonical Record 时，使用 Record Mutation 合同。每次请求至少携带：

```yaml
operation: create | update | close | restore | reclassify_scope
id: canonical-record-id | null-on-server-assigned-create
record_type: state | task | decision | profile_fact | note
record_schema_version: positive-integer
lifecycle_status: active | completed | cancelled | superseded | archived | revoked
scope: profile | global | project:{id}
base_version: null-on-create | positive-integer-on-existing-record
idempotency_key: request-id
request_hash: sha256 | omitted-client-assertion
source_refs: [evidence-id] | unchanged  # [] 表示无引用
source_unavailable_reason: string | null | unchanged
mutation:
  title: string | unchanged
  content: string-or-structured-content | unchanged
  type_fields: object-validated-by-record-type-and-schema | unchanged
  relations: object-of-canonical-id-references | unchanged
  closure_summary: string | null | unchanged
  closed_reason: string | null | unchanged
reclassification_reason: string | null
authority: user_explicit | observed | inferred | imported
observed_at: ISO-8601 | null
confidence: 0.0-1.0 | null
confidence_reason: string
```

约束：

- 新建时规范值为 `base_version=null`；服务端在同一幂等键下只创建一次并返回 `version=1`。旧 Adapter 可以在入口把 `0` 归一化为 `null`，但不得把 `0` 存入 canonical schema。
- create 使用的预分配 `id` 如果已经存在且不是精确幂等重放，必须拒绝，不能转成 update。
- create 必须提供完整 `mutation`、显式 `source_refs` 列表（可为空）和 `source_unavailable_reason`（可为 `null`），不得出现 `unchanged`；其他操作使用显式 patch 语义，未提供字段保持原值，显式 `null` 才表示清空允许为空的字段。
- 操作边界固定如下：create 只能以 `lifecycle_status=active` 创建；update 与 `reclassify_scope` 只作用于 active Record 且不得改变生命周期；close 只能把 active Record 置为该类型 Schema 允许的 `completed|cancelled|superseded|archived|revoked` 终态并生成 `closed_at`；终态 Record 对普通 update 只读，restore 只能把允许恢复的终态置回 active 并令当前 `closed_at=null`；merged 只能由 9.6 节产生。终态到终态的转换必须先 restore 或使用另行定义的显式命令，不能借 update 绕过。
- 对 Decision，`lifecycle_status=superseded` 只能由 9.1.1 节 `decision_supersede` 写入；普通 close 不得选择它，普通 restore 也不得把 superseded Decision 恢复为 active。撤销替代关系需要未来独立的多目标 CAS 命令，同时处理 replacement 与全部 source；v1.6 未定义该命令，因此当前通过新 Decision 再次替代来修正，而不能单边复活旧结论。
- `record_schema_version + record_type` 共同决定 `type_fields` 与 `relations` 的校验规则：Task 的 active 执行分桶放入 `type_fields`、依赖放入 `relations.depends_on`；Decision 只正向保存 `relations.supersedes`，反向关系由 Index 派生；State 当前事实使用公共 `content`，下一步由同 Scope 的唯一 active `now` Task 派生。不得散落为未定义顶层字段。
- `content_hash` 由服务端在 Mutation 应用后计算，不要求客户端预先推导；`request_hash` 对规范化请求计算，两者用途不同。Record 的哈希材料包含类型、Scope、生命周期、正文、类型字段、关系、来源引用/不可用原因、authority、观察/关闭与置信度语义，排除 `content_hash` 自身、版本号、Receipt/Actor、记录时间和更新时间，再复用 9.0 节 canonical JSON 规则，避免递归哈希与无业务变化的哈希漂移。
- 修改、关闭、恢复和重分类必须提交当前正整数 `base_version`。缺失、非正数或过期版本都显式拒绝，不能解释成“最后写入获胜”。
- create/update/close/restore 提交的 `record_type` 与 Scope 必须满足 8.1 节矩阵；除 `reclassify_scope` 外，现有记录请求中的两字段必须与存储值一致。`reclassify_scope` 必须提供非空 `reclassification_reason`，必要的类型转换还必须提高或匹配目标 `record_schema_version`，禁止降级到不兼容 Schema。
- 任何把 active Task 设为 `execution_bucket=now` 的 create/update/restore/reclassify 都必须锁定并检查其有效 Scope；若该 Scope 已有另一条 active now Task，则以 `NOW_CONFLICT` 拒绝且不产生业务变更。不能只对原始 `scope` 建唯一约束而忽略 Project merge closure。
- `id` 可以由客户端预分配，也可以在 create 时由服务端生成；同一 `idempotency_key + request_hash` 重放必须返回同一个 canonical ID。
- `source_refs` 可以为空，但 `observed`、`inferred`、`imported` 类型必须至少提供一项 Evidence；确实无法取得来源时，必须提交非空 `source_unavailable_reason`。有 Evidence 时该原因通常为 `null`，不得用笼统原因绕过可获得的证据关联。
- create 允许直接携带非空 `source_refs`，但每个 Evidence 必须已经摄取完成，并在 create 的同一事务按 9.4 节完成所有者/授权校验；`record_created` Event 直接携带这些 Evidence 引用，不再追加重复的 `evidence_linked` Event。后续添加或移除引用使用 update + 正整数 CAS。
- `authority=user_explicit` 只能由可验证的用户输入或用户确认产生；Agent/系统不得通过普通 update 把 observed/inferred/imported 自行抬升为 user_explicit。此限制由服务端检查，不依赖 Prompt 自律。
- `confidence` 对 `inferred` 必须是 `0.0-1.0`；用户明确陈述可固定为 `1.0`；来源无法提供可信置信度时允许为 `null`，但必须通过 `confidence_reason` 说明，不能省略该字段。
- `observed_at` 表示事实发生或被观察的时间；未知时为 `null`，不得用写入时间冒充观察时间。
- 完成、归档或被替代时更新原 Record 的生命周期及 `closure_summary` / `closed_at` / `closed_reason`，不得创建新的 `archive_snapshot` 正文。
- `lifecycle_status=merged` 只能通过 9.6 节合并命令产生，普通 Mutation 不得直接提交。

服务端从已验证会话或 Token 中取得 `user_id`，不得接受客户端通过请求正文指定数据所有者。服务端在提交时生成并保存：

```yaml
recorded_at: server-generated-on-create ISO-8601
updated_at: server-generated-on-each-success ISO-8601
closed_at: server-generated ISO-8601 | null
version: 1-on-create | base_version-plus-1
actor_user_id: verified-user-id
actor_binding_id: server-derived-authorized-binding-id
receipt_id: generated-receipt-id
```

Mutation 应用后的 Canonical Record 至少具有下列稳定存储投影；Renderer 与 Object 导出只能消费该投影，不得猜测未定义字段：

```yaml
id: canonical-record-id
record_schema_version: positive-integer
record_type: state | task | decision | profile_fact | note
lifecycle_status: active | completed | cancelled | superseded | archived | revoked | merged
scope: profile | global | project:{id}
title: string | null
content: string-or-structured-content | null
type_fields: object-validated-by-record-type-and-schema
relations:
  depends_on: [canonical-task-id]
  supersedes: [canonical-record-id]
  related_records: [canonical-record-id]
source_refs: [evidence-id]
source_unavailable_reason: string | null
closure_summary: string | null
closed_reason: string | null
closed_at: server-generated ISO-8601 | null
authority: user_explicit | observed | inferred | imported
observed_at: ISO-8601 | null
recorded_at: immutable-server-create-time ISO-8601
updated_at: server-generated-latest-success-time ISO-8601
confidence: 0.0-1.0 | null
confidence_reason: string
version: positive-integer
receipt_id: opaque-receipt-id
content_hash: sha256
```

`title` 与 `content` 是公共正文；`type_fields` 只保存类型专属值。v1.6 的最低类型字段为：Task 的 `execution_bucket=now|next|blocked|later`、`priority`、`completion_criteria`；Decision 的 `rationale`；State 的 `state_kind`；Profile Fact 的 `fact_kind`；Note 的 `note_kind`。每个 `{record_type, record_schema_version}` 必须解析到不可变、可测试的 JSON Schema 或等价代码 Schema，唯一规定这些字段的类型、必填性、默认值和枚举；Schema 可以是随服务版本发布的代码文件，不要求新建注册表服务。生成器配置必须包含所用 Schema 集合的版本/哈希，合同测试必须以同一 Schema 校验 create、update 与导出。Task 的 Done、Decision 的 superseded/revoked 等终态只由 `lifecycle_status` 表达；依赖与替代关系统一放在 `relations`，下一任务由 Task 分桶派生，禁止在 `content`、`type_fields` 和顶层重复维护。

这些字段共同保证正文、关系、来源、授权范围、时间和置信度可以跨 AI、设备和快照恢复。create 的 `version=1`；其他成功 Mutation 的 `version=base_version+1`。

`record_type` 的完整枚举为：

```text
state | task | decision | profile_fact | note
```

`archive_snapshot` 不再是可新写入类型；Archive 由原 Record 的生命周期状态派生。既有 `Archive` / `archive_snapshot` 仅作为迁移兼容输入，在 Object 快照中使用 `kind=legacy_record` 兼容信封保存原 ID、原文、来源和 `legacy_record_type`；不得把旧类型塞入新的 `record_type` 枚举，也不得自动升级为当前事实。

`event`、Receipt、Evidence 和 Project 均不是 `record_type`，不得通过在此字段中提交额外枚举值绕过各自的写入合同。

普通 Record Mutation 不提供物理 hard delete。业务失效使用 close 到 `revoked|archived|cancelled` 等终态；账号删除或法定擦除属于独立、需安全与合规评审的数据主体请求流程，不能用 update/close 绕过。v1.6 只规定第 12 节的删除结果与最小留存不变量，不定义可由普通 Agent 调用的 `erase_data` 请求接口；该接口必须另立规范后才能启用。

#### 9.1.1 Decision Supersede 多目标合同

正式用新 Decision 替代一条或多条 active Decision 时，禁止用多个普通 Record Mutation 拼接，必须使用单一多目标命令：

```yaml
operation: decision_supersede
source_decisions:
  - id: canonical-decision-id
    base_version: positive-integer
replacement:
  id: canonical-record-id | null-on-server-assigned-create
  record_schema_version: positive-integer
  scope: global | project:{id}
  title: string
  content: string-or-structured-content
  type_fields:
    rationale: string
  relations:
    supersedes: [exact-source-decision-ids]
    related_records: []
  source_refs: []
  source_unavailable_reason: string | null
  authority: user_explicit | observed | inferred | imported
  observed_at: ISO-8601 | null
  confidence: 0.0-1.0 | null
  confidence_reason: string
supersede_reason: string
idempotency_key: request-id
request_hash: sha256 | omitted-client-assertion
```

规则：

1. `source_decisions` 至少一条、ID 不重复，全部属于同一用户、`record_type=decision`、`lifecycle_status=active`，并与 replacement 具有同一有效 Scope；每个 source 都必须通过 CAS。
2. replacement 是全新的 active Decision，create 语义与 9.1 节相同，初始 `version=1`；`relations.supersedes` 必须与 source ID 集合完全一致。预分配 ID 已存在且不是精确重放时拒绝。
3. 同一事务创建 replacement，把全部 source 置为 `lifecycle_status=superseded` 并写入服务端 `closed_at` / `closed_reason`，追加一条含全部 source/target refs 的 `decision_superseded` Event，并生成 committed Receipt；Event 使用 replacement 的有效 Scope，多个 source Scope 放入 `change_summary`，不能硬塞进单值 `origin_scope`。任一校验失败则全部回滚。
4. 普通 Decision create/update 若提交非空 `relations.supersedes` 必须拒绝；文字修正可以普通 update，但正式替代必须走本命令。`superseded_by` 始终从 replacement 的正向关系派生，不存回 source。
5. Receipt 的操作族为 `decision_supersede`，`base_versions` 覆盖全部 source，`committed_versions` 覆盖全部 source 与 replacement；精确重放返回原 result envelope，不再创建或关闭任何 Decision。

### 9.2 Project Mutation 合同

Project 是独立身份实体，不能复用 Record Mutation。普通创建、修改、完成、归档和恢复至少携带：

```yaml
operation: create | update | complete | archive | restore
canonical_project_id: opaque-id | null-on-server-assigned-create
project_schema_version: positive-integer
base_version: null-on-create | positive-integer-on-existing-project
idempotency_key: request-id
request_hash: sha256 | omitted-client-assertion
mutation:
  name: string | unchanged
  certainty_status: unconfirmed | confirmed | unchanged
  progress_status: active | paused | completed | archived | unchanged
  aliases: [] | unchanged
  closure_summary: string | null | unchanged
  closed_reason: string | null | unchanged
```

Project 合并使用显式双目标命令：

```yaml
operation: project_merge
source_canonical_project_id: opaque-id
source_base_version: positive-integer
target_canonical_project_id: opaque-id
target_base_version: positive-integer
idempotency_key: request-id
request_hash: sha256 | omitted-client-assertion
merge_reason: string
```

规则：

1. Project create 的 `base_version` 规范值同样为 `null`，成功后初始 `version=1`，且 `mutation` 必须完整；update/complete/archive/restore 使用显式 patch，缺失或 `unchanged` 保持原值。create 可用 `progress_status=active|paused` 且 `closed_at=null`；update 只能在 active/paused 间变化，不能写 completed/archived；complete 固定写 completed；archive 固定写 archived；restore 只把 completed/archived 恢复为 active。complete/archive 由服务端生成 `closed_at` 并接受收尾字段，restore 令当前 `closed_at=null`，但可保留上次收尾说明供审计。完成、归档和恢复不能伪装成普通 update。同一 `idempotency_key + request_hash` 必须返回同一 Project ID。预分配 ID 已存在且不是精确重放时必须拒绝。现有 Project 的 update/complete/archive/restore 必须使用正整数 CAS，merged 源拒绝所有普通 Mutation。
2. Project ID 一经创建保持稳定；名称、别名、确定程度和进度变化不得改变 `projects/{canonical_project_id}/` 路径身份。
3. Project merge 的 source/target 必须不同、属于同一用户，且两者 `lifecycle_status` 均为 active。若任一方 `progress_status=active|paused`，保留 target 也必须为 active/paused；若双方均为 completed/archived，进度终态必须相同。命令同时校验两边版本并禁止循环。源 Project 设置 `lifecycle_status=merged` 与 `merged_into_project_id`，变为只读重定向；目标 Project 的 `merge_generation` 加一。source 与 target 的 `version` 均递增，使 closure 依赖与缓存有明确失效信号。旧 Project ID 由服务端和 `index.json.by_id` 稳定解析到最终目标，Record 正文和 canonical ID 均不复制。
4. 合并后，原 `scope=project:{source_id}` 的 Record 保留原 Scope 作为来源事实，并通过 Project merge closure 得到 `effective_project_id=target_id`，在目标 Project 五视图中继续可读。merge closure 是 Renderer 与 Index 的显式依赖：任何源 Record 后续 Mutation、源关系变化或 closure 变化都必须失效并重建目标视图和目标 Scope Index。若 B 合入 C 时已有 A→B，则 A 的最终目标也变化；本次影响集必须包含新旧 closure 中所有反向可达源 Project，重建它们的 `redirect.json`、目标视图/Log 与 Index，不能让 A 继续缓存 B。合并前源 Event 通过 7.3 节的联合规则进入目标 Log；合并后经旧 ID 发生的新 Event 直接使用目标有效 Scope。只有全部源 Record 的有效解析、目标视图/Log 呈现和 ID 引用校验通过后，才停止渲染源 Project 五视图；停止后仍保留最小只读 tombstone 路径或 ID 解析结果指向目标。任何真正的 Scope 改写必须另走显式 Record Mutation 与 CAS。
5. Project Merge 提交前必须在同一串行化事务中计算合并后的 effective closure；若其 active Task 中有两条或以上 `execution_bucket=now`，以 `NOW_CONFLICT` 拒绝。用户先显式降级多余 now Task 后才能重试，合并命令不得替用户猜选下一步。
6. 成功的普通 Project 变更在一个数据库事务中更新 Project、追加成功 Event 并生成 committed Receipt；Project Merge 在同一事务更新源重定向与目标 `merge_generation`、追加双目标 Event 并生成包含两边 committed version 的 Receipt。
7. 失败或拒绝不得伪装成成功事务；按 9.3、9.5 和 9.7 节在回滚后通过独立审计事务记录。

成功后的 Project 至少持久化以下稳定投影：

```yaml
canonical_project_id: opaque-id
project_schema_version: positive-integer
name: string
certainty_status: unconfirmed | confirmed
progress_status: active | paused | completed | archived
lifecycle_status: active | merged
merged_into_project_id: canonical-project-id | null
aliases: []
closure_summary: string | null
closed_reason: string | null
closed_at: server-generated ISO-8601 | null
merge_generation: nonnegative-integer
version: positive-integer
recorded_at: immutable-server-create-time ISO-8601
updated_at: server-generated-latest-success-time ISO-8601
receipt_id: opaque-receipt-id
```

create 时 `merge_generation=0`；普通 Mutation 不直接修改它且 `lifecycle_status` 固定为 `active`，只有 Project Merge 能写入 `merged` 或递增目标的 `merge_generation`。

某目标 Project 的 merge closure 定义为“该目标本身，加上所有直接或传递地最终解析到该目标的源 Project ID 集合”。每个已合并源只能解析到一个最终目标，写入时必须拒绝循环。M1 必须能读取已有的无环中间重定向，并以 visited-set 防循环、解析最终目标；路径压缩可延后，但若执行也必须经 CAS 与审计。Renderer、Index 与 Log 联合查询必须使用同一 closure 解析函数和版本，不能各自维护不同名单。

### 9.3 Event 追加合同

Event 是独立实体，不是 Canonical Record。正常情况下，它由服务端在 Record、Project、Evidence 关联、Scope 变化、合并、删除、失败或权限操作发生时自动追加。

Event 至少包含：

```yaml
event_id: opaque-event-id
event_schema_version: positive-integer
event_stream_id: server-derived-owner-scope-and-generation-stream-id | null-until-ordering-extension-enabled
stream_generation: nonnegative-integer | null-until-ordering-extension-enabled
event_sequence: server-generated-gapless-positive-integer-within-stream | null-until-ordering-extension-enabled
committed_canonical_version: store-version-after-event-transaction
event_type: record_created | record_updated | record_closed | record_restored | decision_superseded | project_created | project_updated | project_completed | project_archived | project_restored | project_merged | scope_changed | record_merged | evidence_linked | evidence_unlinked | operation_failed | system_operation_failed | extension:{namespace}:{name}
target_refs: []  # zero or more items shaped as {role: primary|source|target|evidence, kind: record|project|evidence|system, id: opaque-canonical-id}
event_scope: profile | global | project:{id}
origin_scope: profile | global | project:{id} | null
change_summary: [] | null
idempotency_key: request-id
request_hash: sha256-of-normalized-request
actor_binding_id: server-derived-authorized-binding-id | system
actor_user_id: verified-user-id | null-when-system
occurred_at: server-generated ISO-8601
result: success | failure
receipt_id: opaque-receipt-id
audit_visibility: audit_only | work_log
evidence_refs: []
artifact_refs: []  # [{kind: evidence|record_version|project_version|export, id: opaque-id, content_hash: sha256}]
error_code: string | null
content_hash: sha256-of-canonical-event
```

`target_refs` 与 `change_summary` 的 item Schema 固定为：

```yaml
target_ref:
  role: primary | source | target | evidence
  kind: record | project | evidence | system
  id: opaque-canonical-id
change_summary_item:
  field: registered-field-id-or-JSON-pointer
  before: scalar-or-canonical-id-or-null-or-redacted
  after: scalar-or-canonical-id-or-null-or-redacted
```

`change_summary` 只允许上述 item 数组；复杂正文、凭据和敏感值必须使用 `redacted`，必要的完整差异只通过授权版本工件引用恢复。字段 ID/JSON Pointer 的合法集合由 `event_schema_version` 对应的不可变 Schema 定义。

规则：

1. Event 自身只增不改，不使用 `base_version` 对 Event 做 CAS。
2. M1 基础 Event Schema 强制除三项可选 Stream/sequence 字段和显式标为可空/空数组的字段之外的全部上列字段，尤其包括 `event_type`、`result`、`audit_visibility`、Receipt/Actor、Scope、提交版本与内容哈希；这才能安全决定 Log 路由并重建 Raw Event。Event Stream 排序扩展仅是实际启用 Rollup 的前置门禁，未启用 Rollup 时保持可选：启用后 `event_stream_id` 由“已验证所有者 + 当时的精确 `event_scope` + stream generation”派生且不暴露原始用户 ID，`event_sequence` 在 Event 提交事务中原子分配为流内无缺口序号，回滚不得消耗正式序号。扩展未启用时三项字段必须同时为 `null`。`committed_canonical_version` 是持久化该 Event 的事务提交后可见的 Store 版本；`content_hash` 对除自身外的完整 Canonical Event 使用 9.0 节 canonical JSON 规则计算。
3. 成功 Event 如果由 Record 或 Project 变化产生，必须先对目标实体执行 CAS；目标实体、成功 Event 与 committed Receipt 在同一个成功事务提交；排序扩展已启用时，流序号也在该事务内分配和提交。
4. 已成功规范化请求在授权、CAS 或业务规则阶段失败时，业务事务必须回滚或根本不开始。失败 Event 不能声称与已回滚的业务写入“同事务提交”；它只能在随后独立的失败审计事务中追加，并取得自己的 `committed_canonical_version`；排序扩展已启用时再原子取得 `event_sequence`。规范化前失败按 9.0 节只写平台安全审计，不生成用户 Receipt/Event。
5. `operation_failed` 默认 `audit_visibility=audit_only`。只有它代表需要跨会话恢复的真实执行失败、已验证用户、可安全确定 Scope 且不会泄露目标存在性时，才允许设为 `work_log`；普通冲突、非法请求和越权尝试不得污染工作 Log。
6. 纯系统运行事件可以通过受限的内部 `append_event` 命令写入；该命令不修改业务 Record，但仍需权限、幂等键和 Receipt。系统事件必须使用 `actor_binding_id=system, actor_user_id=null`；用户/Agent 事件必须同时具有服务端派生的 verified user 与 authorized binding，禁止一半为空或客户端伪造组合。
7. 用户或普通 Agent 不得使用 `record_type: event` 主动伪造业务操作历史。
8. 相同业务操作的幂等重放不得追加第二条成功 Event；服务端返回原 Receipt，并在响应层标记重放。
9. 合并 Event 的 `target_refs` 必须同时包含 `role=source` 与 `role=target`；Project Merge Event 使用目标 Project Scope，并以 `origin_scope` 保存源 Project Scope；Record Merge Event 使用保留目标的有效 Scope。可披露目标的单目标操作至少包含一个 `role=primary`。身份未建立或目标存在性不可披露的失败 Event 允许为空。`change_summary` 只保存改变的字段名、枚举、canonical ID 与 before/after 值，不复制正文或凭据；Scope/类型变化必须在此记录前后值。Project 合并后，经旧 Record ID 发生的新 Event 使用目标 Project 的有效 Scope 作为 `event_scope`，并在 `origin_scope` 保留源 Scope；合并前的历史 Event 保持不可变。
10. 三类 Evidence 引用不得混用：`target_refs(kind=evidence)` 只表示本操作直接改变或关联的 Evidence 目标，link/unlink 时与 Record 一起出现；`evidence_refs` 只表示支撑该 Event 的既有 Evidence，不是被修改目标，且不得与同一 Event 的 Evidence target ID 重复；`artifact_refs(kind=evidence)` 只表示带 `content_hash` 的不可变版本/合并快照工件，不代表普通 source relation。服务端必须按该边界去重和校验。
11. 仅缺少 Stream/sequence 的 Event 仍符合 M1 基础 Schema，继续留在 Raw Event、不伪造顺序，也不得进入 Rollup。缺少任一其他 M1 必需字段的历史 Event 必须使用 `kind=legacy_event` 兼容信封；特别是无法证明 `audit_visibility` 时默认只进入 pending-review/授权审计路径，不得猜测后渲染到工作 Log。
12. 未在当前 `event_schema_version` 注册的普通 `event_type` 必须拒绝。扩展类型只能使用 `extension:{namespace}:{name}`，并由更高或兼容的 versioned Event Schema 定义 payload；消费者不认识扩展类型时必须保留和按通用字段展示，不能丢弃。Project Merge 固定使用 `project_merged`。

### 9.4 Evidence 摄取与关联合同

Evidence 不是 Canonical Record 的 `record_type`。原始文件、截图、网页快照、用户原话或测试输出通过独立 Evidence Ingest 合同进入受控存储，至少生成：

```yaml
evidence_id: opaque-evidence-id
evidence_schema_version: positive-integer
evidence_type: user_quote | file | image | web_ref | test_output | legacy_document
idempotency_key: request-id
request_hash: server-computed-sha256
storage_ref: protected-storage-ref
content_hash: sha256
mime_type: string | null
size_bytes: nonnegative-integer | null
captured_at: ISO-8601 | null
recorded_at: server-generated ISO-8601
actor_binding_id: server-derived-authorized-binding-id
receipt_id: opaque-receipt-id
```

规则：

1. Evidence Ingest 本身不使用 Record 的 `base_version`，但必须执行授权、原始字节哈希与幂等，并在同一事务原子提交 Evidence 与 committed Receipt；未关联 Evidence 没有 `profile|global|project` 工作 Scope，因此不强制生成 Event。摄取完成但未关联的 Evidence 始终保持所有者私有。
2. 将 Evidence 连接到 Record 时，必须先验证 Evidence 存在、同属一名用户且当前 Binding 有权读取。Record create 可在 `base_version=null` 的同一事务直接建立初始 `source_refs`，只产生 `record_created` Event；已有 Record 的新增/移除引用通过正常 update Mutation 与正整数 CAS，产生 `evidence_linked|evidence_unlinked` Event。两者 Receipt 的操作族均为 `record_mutation`，不生成第二张“Evidence Link Receipt”。
3. Evidence 不保存可由多个 Record 竞争写入的单一 `inherited_scope`。当前 `referenced_by` 与 `derived_scopes` 由所有可导出引用 Record 的 `source_refs` 反向确定性计算；这里“可导出”包括 active 及 completed/cancelled/superseded/archived/revoked 等仍需 Archive/审计恢复的终态，排除 merged redirect、依法擦除和当前调用方无权导出的 Record。同一 Evidence 可被多个 Scope 引用而不复制 payload。
4. 每次读取或导出同时校验 Evidence 自身所有者授权与当前引用 Record 的可见性。Bundle 只导出至少被一条已授权导出 Record 引用的 Evidence；默认策略按所有引用中的最严格保护要求处理 payload，未获授权时仅生成 `omitted.json` 桩。未关联 Evidence 不进入 Markdown、Bundle 或 Index。
5. Event 和 Receipt 只保存 `evidence_id`、哈希和必要元数据，不重复敏感正文。

### 9.5 Receipt 合同

Receipt 是不可变的请求结果回执，不是 Event，也不是业务 Record。每次已建立身份、成功规范化且不是精确重放的请求尝试都生成一个可定位的 Receipt；精确幂等重放返回原 Receipt。身份尚未建立或规范化前失败的请求只进入平台安全审计，不归入任何用户 Bundle。

```yaml
receipt_id: opaque-receipt-id
receipt_schema_version: positive-integer
operation: record_mutation | decision_supersede | project_mutation | record_merge | project_merge | evidence_ingest | append_event | export | renderer_rebuild | extension:{namespace}:{name}
status: committed | rejected | failed
idempotency_key: request-id
request_hash: server-computed-sha256
received_payload_hash: server-computed-sha256
actor_user_id: verified-user-id | null
actor_binding_id: server-derived-authorized-binding-id | system | null
target_refs: []
base_versions: {}
committed_versions: {}
canonical_version: opaque-store-version-of-receipt-transaction
event_ids: []
evidence_ids: []
artifact_refs: []
related_receipt_id: opaque-receipt-id | null
error_code: string | null
response_hash: sha256-of-canonical-result-envelope
recorded_at: server-generated ISO-8601
```

规则：

`target_refs` 复用 9.3 节的 `{role, kind, id}` 结构；`artifact_refs` 复用 `{kind, id, content_hash}`，用于不可变 Evidence/版本/导出工件，不保存正文。`base_versions` 与 `committed_versions` 都是以 canonical target ID 为键的对象，create 的 base 值为 `null`，未被业务事务修改的 CAS-only target 不进入 `committed_versions`。

1. 需要 Event 的成功业务 Mutation 生成 `status=committed` Receipt，并与目标实体和成功 Event 同事务提交。Standalone Evidence Ingest 按 9.4 节只原子提交 Evidence 与 Receipt，不伪造 Scope Event。
2. 完全相同的 `idempotency_key + request_hash` 重放不重复业务写入，也不新增 Event 或 Receipt；返回原 Receipt 及由其 `status + target_refs + committed_versions + canonical_version + event_ids + evidence_ids + artifact_refs + error_code` 构成的原 canonical result envelope，并在响应层标记 `replayed=true`。`response_hash` 对该 envelope 计算。接口若额外返回实体的当前展开投影，必须标记为 supplemental，不得伪装成原提交版本。这样 M1 无需先建设完整多版本响应仓库。
3. 同一幂等键但 `request_hash` 不同必须拒绝，并在独立失败审计事务中生成 `status=rejected` Receipt；`related_receipt_id` 指向占用该幂等键的原 Receipt。
4. 权限、Schema、CAS 或业务前置条件失败不产生 committed Receipt；回滚后以独立事务写入 `rejected` 或 `failed` Receipt。其 `canonical_version` 只标识失败审计事务的 Store 版本，`committed_versions` 必须为空，因此 Receipt 的存在不表示业务实体变更成功。
5. Receipt 只保存目标引用、版本、哈希、错误码和必要审计元数据，不保存 Record/Evidence 敏感正文。
6. 在身份无法验证或目标存在性不可披露时，只进入最小化安全审计；`actor_user_id`、目标 ID 和用户 Event 必须省略或不可逆脱敏。
7. 每张 Canonical Receipt 都必须具有非空 `idempotency_key`、服务端 `request_hash` 与 `received_payload_hash`；规范化前失败不创建 Canonical Receipt，按 9.0 节留在平台安全审计。
8. 未在当前 `receipt_schema_version` 注册的普通 `operation` 必须拒绝；扩展操作只能使用 `extension:{namespace}:{name}` 并由 versioned Receipt Schema 定义。Renderer/快照重建使用 `renderer_rebuild`，不伪装成用户 Record Mutation。

`rejected` 表示可预期的授权、Schema、幂等、CAS 或业务前置条件拒绝；`failed` 表示服务端、存储或依赖发生非预期故障。两者都不得携带业务实体的 committed version，但保留自身审计事务的 `canonical_version`。

### 9.6 Record 合并重定向合同

Record 合并必须使用显式双目标命令：

```yaml
operation: record_merge
source_record_id: canonical-record-id
source_base_version: positive-integer
target_record_id: canonical-record-id
target_base_version: positive-integer
idempotency_key: request-id
request_hash: sha256 | omitted-client-assertion
merge_reason: string
merged_source_snapshot_ref: immutable-evidence-or-version-ref | null-on-server-created
merged_source_snapshot_hash: sha256 | null-on-server-created
```

`merged` 是 Canonical Record 存储层的 `lifecycle_status`，不是新的 `record_type`。被合并 Record 保留原 `record_type` 和 canonical ID，但其普通读取投影不再暴露可独立使用的正文，成为只读重定向记录：

```yaml
id: old-canonical-record-id
record_type: original-record-type
lifecycle_status: merged
merged_into: retained-canonical-record-id
title: null
content: null
type_fields: {}
merged_at: server-generated ISO-8601
merge_reason: string
merged_source_snapshot_ref: immutable-evidence-or-version-ref
merged_source_snapshot_hash: sha256
merge_receipt_id: generated-receipt-id
version: previous-version + 1
```

规则：

1. 合并命令同时携带 source 与 target 的 `base_version`，两者均通过 CAS 后才允许提交。
2. source 与 target 必须不同、属于同一用户、具有相同 `record_type` 与兼容 Schema，且两者在请求开始时都不是 merged redirect；跨 Scope 重复项必须先完成明确分类。若任一方为 active，保留 target 必须为 active；若双方都为终态，其 `lifecycle_status` 必须相同。生命周期不兼容时先用显式业务命令处理，merge 不得让当前 State/Task/Decision 因选择终态 target 而静默消失。
3. 客户端可以让两个 snapshot 字段同时为 `null`，由服务端在合并事务中创建 source 的不可变版本/受保护 Evidence；也可以同时提交已有引用与声明哈希。两字段不得一空一非空。两种路径都由服务端在当前授权下解析并自行计算、校验最终哈希；客户端引用只是声明，不能直接信任，也不能指向可变 Bundle 路径。`request_hash` 只覆盖客户端提交值，最终服务端 ref/hash 写入 source redirect，并以 `{kind,id,content_hash}` 写入 Event/Receipt 的 `artifact_refs`。无法证明该引用持久且可审计时不得清空普通正文。
4. `merged_into` 写入时必须指向当时的有效 Record 并拒绝循环。读取端在 M1 必须支持已有无环中间重定向，以 visited-set 解析最终 Record，`index.json.by_id` 必须缓存直接最终 ID。合并写能力启用后，目标可再次合并；此时所有反向可达 redirect 都属于派生失效集，必须在同一快照重建其 Index 最终目标。路径压缩属于可选 canonical 优化，执行时仍需 CAS、Event 与 Receipt，不能静默改写重定向历史。
5. 合并操作在同一事务中更新 source、确认 target、关联已验证快照引用、追加同时带 source/target 引用的 `record_merged` Event 并生成 Receipt。
6. 读取旧 ID 时返回重定向元数据和最终 canonical ID；普通读取不返回旧正文，授权审计可通过快照引用恢复合并前证据。
7. `lifecycle_status=merged` 的 Record 不进入 State、Task、Decision、Archive 正文视图或普通检索结果，只在 `index.json.by_id` / `by_status` 保留 ID 解析和审计关系。

Record Merge 只改变 source redirect；target 作为 CAS 校验和锁定对象，其实体 `version` 不递增，除非同一命令还定义了明确的 target 业务变更。Receipt 的 `base_versions` 记录两边，`committed_versions` 只记录实际变更的 source，避免用无内容变更制造 target 版本噪声。

### 9.7 服务端执行顺序与失败分支

以下顺序适用于 Canonical Record 与 Project 的状态变更。纯 Event 追加和 Evidence 摄取分别遵循 9.3、9.4 节，不得机械套用 Record 的 `base_version` 规则。

成功路径：

1. 验证用户、Binding、Scope、对象权限、请求 Schema 和幂等键。
2. 先用 `idempotency_key + request_hash` 查找既有结果；精确重放直接返回原 canonical result envelope 与原 Receipt，不再执行 CAS，因此不会因目标后来升级而误报版本冲突。
3. 非重放 create 要求 `base_version=null`；其他操作验证当前正整数版本。
4. 开启业务事务，在同一事务中写入 Record/Project、成功 Event 与 committed Receipt，并递增每个实际被修改实体的版本；仅用于 CAS 锁定且正文/关系未改变的引用目标不虚增版本。Project Merge 按 9.2 节明确修改两边，Record Merge 按 9.6 节只修改 source。
5. 全部成功后提交；任一项失败则整个业务事务回滚。

失败或拒绝路径：

1. 业务事务回滚或不启动，业务实体版本保持不变。
2. 随后开启独立失败审计事务，写入最小化 `rejected|failed` Receipt；只有请求已成功规范化且满足 9.3 节隐私条件时才同时追加 `operation_failed` Event。
3. 失败审计事务不能反向改变原业务请求结果，也不能伪造目标版本已递增。
4. 若失败审计自身不可用，系统仍返回原业务错误，同时产生运维告警；恢复补录前必须重新查询该“用户 + 操作族 + idempotency_key + request_hash”。仅当仍不存在 canonical Receipt 时才可补原 failed Receipt；若客户端重试已产生 committed/rejected/failed Receipt，晚到恢复只写平台运维审计并关联现有 Receipt，不再创建第二个用户 Receipt/Event，也不重放业务写入。

### 9.8 安全边界

授权必须由可信服务端强制执行：

- Supabase RLS：数据行隔离的最后防线。
- API 服务端：身份、Scope、字段和业务操作校验。
- MCP 服务端：Binding、OAuth Scope、工具权限和撤销校验。

UI 和 Skill 必须正确展示并遵守授权结果，但它们不是安全边界。不得依赖隐藏按钮、Prompt 指令或客户端过滤防止越权。

权限撤销必须在后续服务端请求中立即生效，不得因 Markdown、缓存或 Index 滞后继续返回受保护内容。

## 10. 快照与原子发布

### 10.1 发布模型

多个文件无法通过逐个覆盖或普通的“两次 rename”获得跨文件原子性。M0 不要求先建设永久多版本服务，但正式读取必须使用以下两种发布模式之一。

文件系统模式：

```text
export-work/
├── staging/{snapshot_version}/memory/...   # 候选，不供正式读取
├── published/{snapshot_version}/memory/... # 已验证不可变版本
└── current.json                            # 单文件原子指针
```

`current.json` 至少包含 `pointer_schema_version`、`snapshot_version`、相对 `bundle_path`、`manifest_sha256` 与 `previous_snapshot_version`。读取者先完整读取并校验该单文件，再按其路径读取 Manifest；不得先扫描 `published/` 猜测“最新”目录。

Git 模式：候选在正式工作树之外生成并校验，随后创建包含完整目录的单个 commit，再原子更新目标 ref。正式消费者必须按 ref 解析出的 commit SHA 读取 Git tree；如果消费者直接读取可变工作树，则必须改用文件系统模式或显式读锁，不能把“单个 commit”误称为工作树原子性。

发布步骤：

1. 从同一 canonical version 读取全部目标 Object 和 Event。
2. 在 staging 生成完整 `memory/`、`index.json` 和 Manifest。
3. 校验记录数量、ID 集合、引用、Schema 和文件哈希。
4. 将候选版本标记为 `ready`，并把完整候选目录移入 `published/{snapshot_version}/`；该目录此后不可原地修改。
5. 文件系统模式通过“写临时指针文件 → fsync 文件 → 单文件 rename → fsync 父目录”原子替换 `current.json`；Git 模式原子更新 ref。两种方式都不得让正式读取者看到半新半旧目录。
6. 声明“当前生产镜像”前再次读取 Canonical Store 当前版本。若已不同，候选只能标记为历史快照，不能作该声明；默认应放弃候选并从新版本重建。没有 live Store 访问的离线输入天然只能是 `historical_offline`，可完成带版本和限定语的 M0 结构基线，但不得更新生产正式指针/ref 或冒充当前生产状态。
7. 发布后按正式入口重新读取 Manifest 和关键哈希；失败时把指针/ref 恢复到上一完整版本。

确定性构建必须固定排序、UTF-8、LF 换行和 JSON 序列化规则。`generated_at` 由显式 `build_epoch` 注入；重复构建比较时使用相同 `build_epoch`，不得用运行时当前时间破坏字节级一致性。

### 10.2 M2 持久版本库

当出现定时导出、多消费者、并发发布或长期版本保留需求时，再把 M0 的最小当前/上一版本机制扩展为：

```text
snapshot-store/
├── versions/
│   ├── {snapshot_version_a}/memory/...
│   └── {snapshot_version_b}/memory/...
└── current.json               # 只指向一个 ready 且已验证的版本
```

该模型是 M2 的运维增强，不阻塞 M0。启用后，读取者必须先解析单一指针，再读取对应完整版本，仍不得跨版本拼接文件。

### 10.3 失败恢复

候选快照生成失败时：

- 不替换正式目录，也不更新正式版本指针；
- 上一完整快照继续可读；
- 保存失败原因、首次失败时间和重试次数；
- M0 由操作者使用同一输入显式幂等重跑，不要求常驻后台服务；
- M2 可增加 Reconciler、Sweeper、退避重试和告警，但不得影响 Canonical Store 的正常读写。

## 11. Manifest 与 Bundle Index 合同

以下是可发布 `status=ready` Manifest 的最低完整 Schema：

```json
{
  "schema_version": 5,
  "snapshot_version": "opaque-version",
  "canonical_version": "opaque-version",
  "bundle_scope": "user",
  "owner_ref": "optional-opaque-ref",
  "export_receipt_id": null,
  "migration_run_id": "opaque-local-run-id",
  "status": "ready",
  "baseline_claim": "current",
  "source_verification": "live_rechecked",
  "views_stale": false,
  "views_complete": true,
  "generated_at": "ISO-8601",
  "generator_version": "renderer-version",
  "generator_config_hash": "sha256",
  "export_policy_version": "opaque-version",
  "build_epoch": "ISO-8601",
  "event_rollups_enabled": false,
  "receipt_export": "references_only",
  "index": {
    "path": "index.json",
    "schema_version": 1
  },
  "canonical_counts": {
    "projects": 0,
    "records": 0,
    "events": 0,
    "evidence": 0,
    "referenced_receipts": 0
  },
  "snapshot_counts": {
    "objects": 0,
    "raw_events": 0,
    "raw_event_stubs": 0,
    "erasure_tombstones": 0,
    "event_rollups": 0,
    "evidence_items": 0,
    "legacy_items": 0,
    "pending_review": 0
  },
  "source_inventory_hash": "sha256",
  "destination_map_hash": "sha256",
  "event_stream_ordering_enabled": false,
  "raw_event_inventory_hash": "sha256",
  "event_stream_coverage_hash": null,
  "receipt_refs_hash": "sha256",
  "reports": [
    {
      "path": "evidence/migration/opaque-version/migration-report.json",
      "sha256": "..."
    }
  ],
  "files": [
    {
      "path": "global/state.md",
      "sha256": "...",
      "snapshot_version": "opaque-version"
    }
  ]
}
```

Manifest 规则：

- `bundle_scope` 描述导出包的覆盖边界，当前固定为 `user`；它与 Canonical Record 的 `scope=profile|global|project:{id}` 是两个不同维度，不得共用枚举或数据库字段。
- `owner_ref` 可省略，且不得等同于邮箱或原始用户 ID。
- `canonical_counts.evidence` 只统计进入授权导出闭包的 Evidence；未关联或未授权 Evidence 不写 ID，只在受保护 Receipt/本地报告中按排除原因聚合计数。
- M0 本地/离线导出允许 `export_receipt_id=null`，但必须有唯一 `migration_run_id`；M1 经服务端授权的正式 Export 必须生成 `export_receipt_id`。
- `status` 状态机固定为 `building -> ready|failed`；`failed` 不得回写为 `ready`，重试产生新的候选或在同一逻辑构建 ID 下从干净 staging 重新构建。`building|failed` 只存在于 staging，可只保存 Schema/快照/Canonical 版本、生成器、`views_stale`、错误码与失败报告引用，不要求伪造尚未完成的文件哈希和数量；只有满足上方完整 Schema、`status=ready` 且 `views_stale=false` 的快照才允许成为正式版本。
- `baseline_claim` 取 `current|historical_offline`，`source_verification` 取 `live_rechecked|bundle_only`。`views_complete` 表示当前 Profile/State/Decision/Now Task 是否均能无猜测地路由和渲染，与“是否落后于 Canonical Store”的 `views_stale` 是两个维度。只有 `current + live_rechecked + views_complete=true` 才能更新生产正式 `current.json`/Git ref 并声明“M0 当前生产镜像”；离线 Bundle 输入可以生成不可变 `historical_offline + bundle_only` 快照并通过“M0 结构基线”门禁，但声明必须带 `snapshot_version`、“未验证为生产最新”以及适用的“不完整视图”限定。
- 所有正式文件必须属于同一 `snapshot_version`。
- `build_epoch` 是本次快照的固定构建时点；`generated_at` 必须等于或确定性派生自它，不能读取构建进程的当前墙钟时间。同输入重复构建必须复用该值。
- `snapshot_version` 必须由 `canonical_version + generator_version + generator_config_hash + export_policy_version + build_epoch + baseline_claim + source_verification + views_complete` 确定性派生，或在同一逻辑构建重试中显式复用；`migration_run_id` 同样在幂等重试与字节一致性测试中复用。同一 `snapshot_version` 禁止在 `historical_offline` 与 `current` 之间或完整/不完整视图之间原地改写。否则不能宣称相同输入字节级一致。
- `event_rollups_enabled=false` 时，`event_rollups` 必须为 `0`，所有在导出范围内的 Event 身份通过 `events/raw/` 的授权投影或连续性桩保留；`events/rollups/` 可以为空或不存在。
- `raw_events` 统计 `events/raw/` 下的 Event 身份及依法允许保留的序列位置总数，包含授权完整投影、连续性桩与合法擦除桩；`raw_event_stubs`、`erasure_tombstones` 分别单独统计两类桩。它们必须与 Canonical Event 清单、删除政策和 `raw_event_inventory_hash` 一致。
- `receipt_export=references_only` 表示 Bundle 只保留 Receipt 引用；完整回执账本不在默认 Bundle 中。
- `referenced_receipts` 与 `receipt_refs_hash` 不导出 Receipt 正文，也不把全部用户 Receipt 计入 M0 的实体去向要求。`live_rechecked` 构建必须证明这些 ID 在冻结读点可解析；`bundle_only` 只能证明源 Bundle 内引用集合完整，并必须把外部可解析性标为未验证。
- `source_inventory_hash` 与 `destination_map_hash` 覆盖源清单、目标去向、兼容信封、Evidence 引用和省略桩，必须证明源集合与目标集合完全对应。
- `raw_event_inventory_hash` 始终必填，覆盖按 Event ID 稳定排序的 ID、`committed_canonical_version`、完整项/桩标记、Canonical 内容哈希，以及政策允许保留的删除边界；无 ID 边界按规范路径或已有 Stream/sequence 排序。它是 M0/M1 的 Event 完整性证明，不要求新建序号。`event_stream_ordering_enabled=false` 时 `event_stream_coverage_hash=null`。启用排序扩展后，后者覆盖每个 Event Stream 的 `stream_id`、`stream_generation`、首尾序号、Event ID 顺序、完整项/桩标记、内容哈希与 stream reset 边界；无序号历史 Event 必须逐 ID 留在 Raw inventory，不能伪装成连续流。
- `snapshot_counts.pending_review` 必须与 `index.json.by_status.pending_review` 及迁移报告一致。存在未决但不影响当前工作的历史项时，M0 声明必须附带数量；存在未决当前 Profile、Decision、State 或 `Now` Task 时不得声明当前生产镜像，只能发布带“当前视图不完整”限定的离线结构工件。
- `reports` 中的文件属于发布与回滚单元，必须列入 `files` 哈希清单，不能只留在临时 staging。
- `files` 覆盖 Bundle 内除 `manifest.json` 自身之外的全部正式文件，避免递归自哈希；Manifest 必须在其他文件哈希固定后最后生成。如需校验 Manifest 本身，使用 Bundle 外的 detached checksum 或签名，并由发布指针引用。
- 任一文件哈希、数量或 ID 集合不一致时，候选版本不得发布。

Bundle Index 规则：

- 一个 Bundle 只有一个规范索引文件 `index.json`，不得同时维护职责重叠的 `object-index.json`。
- 只能从该 Bundle 的 Object、Raw Event 与已启用的 Event Rollup 重建。
- M0 可以每次全量重建；增量更新和分片属于 M2。
- 缺失或损坏不影响 Object、Raw Event 与已启用 Rollup 的可读性。
- 与 Manifest 版本不一致时必须拒绝作为权威结果。
- 不得通过编辑 Index 添加、删除或修改业务信息。

## 12. Event 留存与隐私删除

Event 在业务语义上只增不改：不能静默修改历史操作，也不能为了让结果“看起来正确”删除失败记录。

物理存储必须遵循数据保留和用户删除政策：

1. 近期 Event 保存在热存储，用于恢复、审计和冲突处理。
2. 超过保留周期的 Event 可以进入冷存储或压缩摘要。
3. 用户删除账号或行使数据擦除权时，必须删除或不可逆匿名化可识别内容。
4. 如因安全或合规必须保留极少量审计元数据，应与正文分离、最小化并明确保留期限。
5. 经另行安全评审的删除/匿名化流程执行时必须生成最小审计 Receipt，但不得在审计中再次复制被删除的敏感正文；本节不是普通 Agent 的删除 API Schema。

因此，“Event 逻辑上只增不改”不等于“任何数据永远不能删除”。

排序扩展已启用且删除政策允许保留非识别性连续元数据时，被擦除 Event 的原序号位置改为 `erasure_tombstone`，仅保存 Stream/sequence、擦除时间、最小 Receipt 引用，以及政策允许时的原 opaque Event ID；不保存 target、正文、原内容哈希或可反查身份的数据。保留 Event ID 的 tombstone 只可在政策允许时维持对既有 Rollup 的 ID 定位；因为缺少原 Canonical Event hash，它不能作为新 Rollup 的输入。若允许保留序号但禁止保留 Event ID，则该无 ID tombstone 成为旧 Stream 的最后一个 Raw 位置，随后递增 generation 创建新 Stream。排序扩展尚未启用时不得为删除补造 Stream/sequence；只在 `raw_event_inventory` 与受保护平台审计中记录政策允许的删除边界。若连连续元数据也不允许保留，则只记录允许保留的流关闭/删除事实。任何 Rollup 都不得跨越重置边界，也不得把“依法重置”误报为普通数据缺口。

### 12.1 Event Rollup 与 Log 视图的一致性

Event Rollup 与 Event Stream 排序扩展属于 M2 可选能力。M0/M1 在当前规模下为导出范围内的全部 Event 保留 Raw 授权投影、连续性桩或 legacy 信封，不需要先生成 Rollup 或迁移历史序号。只有当 Event 达到明确保留期、Bundle 体积或读取性能阈值后，才启用本节合同；无法补证连续序号的历史 Event 永久留在 Raw 层也符合完整性要求。

启用后，Event 超出明细保留期可以生成 Event Rollup。Rollup 是由一段连续 canonical Event 范围生成的、带覆盖证明的保留期派生物，不是新的业务事实源。

Bundle 中的结构化位置为：

```text
events/
├── raw/{event_id}.json
├── raw/tombstones/{event_stream_id}/{event_sequence}.json
└── rollups/{rollup_id}.json
```

每个 Rollup 至少包含：

```yaml
kind: event_rollup
schema_version: positive-integer
snapshot_version: opaque-version
canonical_id: rollup-id
canonical_version: bundle-frozen-store-version
data:
  rollup_id: opaque-id
  event_stream_id: opaque-event-stream-id
  stream_generation: nonnegative-integer
  event_scope: profile | global | project:{id}
  audit_visibility: audit_only | work_log | mixed
  from_committed_canonical_version: opaque-version
  to_committed_canonical_version: opaque-version
  first_event_sequence: positive-integer
  last_event_sequence: positive-integer
  first_event_id: opaque-id
  last_event_id: opaque-id
  covered_event_count: positive-integer
  covered_event_ids: [opaque-event-id]
  covered_event_ids_hash: sha256
  source_canonical_content_hash: sha256
  content_hash: sha256
  retention_policy_version: opaque-version
  generated_at: ISO-8601
  summary: structured-summary
```

处理规则：

1. Rollup 只能覆盖一个 `event_stream_id` 中按 `event_sequence` 连续且不重叠的已提交 Event 范围；必须满足 `last_event_sequence - first_event_sequence + 1 = covered_event_count`，且前后相邻 Rollup 的边界连续。v1.6 的 `covered_event_ids` 固定为按 sequence 升序的普通数组，不接受压缩 union；`covered_event_ids_hash` 对该 ID 数组直接使用 9.0 节 canonical JSON 与 SHA-256 计算。`source_canonical_content_hash` 对同一顺序的 `[{event_id, event_sequence, canonical_event_hash}]` 数组使用相同算法计算：在线 Canonical Event 取 `content_hash`，完整 Bundle Event 取 `canonical_content_hash`，Event stub 取 `content_hash`，三者必须相等；`export_content_hash` 和 Manifest 文件哈希绝不作为源事实哈希。缺少 Canonical Event hash 的 erasure tombstone 不能新建 Rollup。仅有时间戳或 opaque Event ID 不能作为连续性证明。外层 `snapshot_version` 与 `canonical_version` 必须分别等于 Bundle Manifest 的快照版本与冻结读点；`data.to_committed_canonical_version` 是覆盖范围内最后一个 Event 的提交版本，语义不同，不要求与外层相等。`data.content_hash` 对除自身外的完整信封使用确定性 canonical JSON 计算。
2. 只有 `audit_visibility=work_log` 且 `event_scope=global|project:{id}` 的 Event 才进入 `log.md`；启用 Rollup 后，Log 从 `events/raw/` 与 `events/rollups/` 联合确定性生成，明细保留期内展示原始 Event，超出保留期后展示清晰标记的摘要区间。
3. 只有 Rollup 生成、范围校验、哈希校验和候选快照验证全部通过后，原始 Event 才能按照保留政策进入冷存储、删除或匿名化。
4. Rollup 生成失败、范围重叠、范围缺口或哈希不一致时，不更新正式快照；按 6.3 节处理候选视图失败。
5. Bundle Index 中依赖 Event 明细的条目必须重建；Index 不保存已超出保留期的原始正文。
6. 用户删除账号或行使数据擦除权时，Rollup 与原始 Event 遵守同一删除或不可逆匿名化要求，不能用摘要规避用户删除。
7. `audit_visibility=mixed` 的 Rollup 必须分别保存可展示和仅审计计数/摘要；Renderer 只能消费 `work_log` 部分，不能把仅审计失败泄漏到 Markdown。默认 Bundle 对敏感摘要使用与 Raw Event 相同的省略策略。
8. 缺少可证明 `event_stream_id` / `event_sequence` 的任何 Event 必须继续保留在 Raw Event，不得为了进入 Rollup 补造序号。
9. `generated_at` 使用持久化的 Rollup 生成时点或显式 `build_epoch`，摘要算法/配置版本必须进入 `retention_policy_version` 或生成器配置哈希；不得在 Bundle 重建时读取当前墙钟或临时调用未版本化模型，破坏相同输入的可复现性。

Event Scope 的消费规则：

| `event_scope` | Markdown 消费视图 | 其他读取路径 |
|---|---|---|
| `profile` | 不生成 `log.md` | 仅授权审计 API/MCP 或个人记忆历史入口 |
| `global` | `global/log.md` | 授权审计 API/MCP |
| `project:{id}` | 未合并时仅对应项目 `log.md`；作为合并源时，其合并前历史范围由目标项目按 merge closure 联合消费；跨无关项目活动仍由运行时联合查询，不写入 `global/log.md` | 授权审计 API/MCP |

## 13. 命名与本地化

### 13.1 机器路径

统一使用小写英文：

- `profile.md`
- `global/`
- `projects/`
- `state.md`
- `task.md`
- `decision.md`
- `archive.md`
- `log.md`
- `objects/`
- `events/`
- `evidence/`

### 13.2 产品界面

| 机器名 | 中文 UI | 英文 UI |
|---|---|---|
| `profile` | 画像 | Profile |
| `global` | 全局级 | Global |
| `projects` | 项目级 | Projects |
| `state` | 状态 | State |
| `task` | 任务 | Tasks |
| `decision` | 决策 | Decisions |
| `archive` | 归档 | Archive |
| `log` | 日志 | Log |

文件路径是稳定机器合同，UI 文案通过本地化层转换，不通过重命名目录实现多语言。

## 14. 写入路由合同

| 信息类型 | Canonical 实体或写入机制 | Scope | 默认消费视图 |
|---|---|---|---|
| 身份、能力、偏好、长期约束 | Record：`profile_fact` | `profile` | `profile.md` |
| 当前有效状态 | Record：`state` | `global` 或 `project:{id}` | 对应 `state.md` |
| 可执行任务 | Record：`task` | `global` 或 `project:{id}` | 对应 `task.md` |
| 正式决定及理由 | Record：`decision` | `global` 或 `project:{id}` | 对应 `decision.md` |
| 其他长期说明 | Record：`note` | `profile`、`global` 或 `project:{id}` | 默认只进入 Index；被其他 Record 通过 ID 引用，不自动塞入五视图 |
| 完成、失效、被替代 | 保留原 Record 类型和 ID，更新 `lifecycle_status` 与关闭字段 | 原业务 Scope | Global/Project 进入对应 `archive.md`；Profile 从 `profile.md` 退出并仅保留授权审计读取，不生成 `profile/archive.md` |
| 项目身份、确定程度、进度、别名 | 独立 Project Mutation | 项目实体自身 | Project `state.md` 与 Global 项目注册表 |
| 操作与变化事件 | 独立 Event，由服务端追加 | `event_scope` 使用目标有效 Scope | Global 使用精确 Scope；Project 合并目标额外联合 merge closure 的源历史；Profile 仅审计读取 |
| 请求结果与幂等重放 | 独立 Receipt | 继承请求授权边界 | 不生成 Markdown；通过审计读取，Bundle 默认只保留引用 |
| 原始材料与引用 | 独立 Evidence Ingest，通过 Record 的 `source_refs` 关联 | `derived_scopes` 由全部有效引用反向计算；未关联时保持私有 | 至少被一条已授权导出 Record 引用时才进入 `evidence/`，payload 服从最严格保护策略 |
| 重复 Record 重定向 | 保留原 `record_type`，设置 `lifecycle_status=merged` 与 `merged_into` | 完成分类后的目标 Scope | 不渲染正文，仅保留 ID 解析和审计 |

Canonical Record 的 `record_type` 必须使用 9.1 节枚举。Project、Event、Receipt、Evidence 和合并状态使用各自合同，不得塞入 `record_type` 扩展枚举。

## 15. 分级实施与迁移门禁

### 15.1 M0：无语义变更的安全目录落地

M0 只解决“真实 `memory/` 为什么还没有两级五视图目录”这一直接问题。它读取现有 Canonical Store 或已验证的 User Memory Bundle，不改数据库 Schema、Record 语义或生产在线读写路径。M0 有两个可区分的声明：任何已验证输入都可完成“M0 结构基线”；只有 live recheck 通过的 Canonical Store 快照才能额外声明“M0 当前生产镜像”。

为降低首轮落地门槛，M0 可以由一个本地、单进程、一次性工具完成，最多只需四个可重复调用的动作：`build(冻结快照, staging, build_epoch)`、`validate(staging)`、`publish(ready_snapshot)` 和 `rollback(previous_snapshot)`。离线结构基线只需把验证通过的版本发布为不可变、可定位工件，不切换生产正式入口，因此无需执行生产 rollback；只有替换正式入口时才强制 publish/rollback 演练。不要求微服务、消息队列、后台调度器、增量索引或新数据库表；动作的输入输出、退出码和报告必须可自动测试，不能用手工复制替代正式入口的原子发布。

M0 最终只发布一个正式 `evidence/migration/{snapshot_version}/migration-report.json`，其中包含 `source_inventory`、`destination_map`、`raw_event_inventory`、`pending_review` 和 `validation` 分区；实现可在 staging 内用多个临时文件生成这些分区，但发布前必须合并，且不得要求部署额外服务。`duplicate_candidates` 是可选分区，因为 M0 按原 ID 全量保留且不执行相似度识别。报告不是 Canonical Record，也不进入五视图，但必须列入 Manifest、随 Bundle 原子发布并一起回滚；`source_inventory`、`destination_map`、`raw_event_inventory` 分别对应 Manifest 专项哈希，`pending_review` 对应计数与 Index，`validation` 由整份报告的文件哈希保护。为避免递归，`validation` 不保存报告自身或最终 Manifest 的哈希；Manifest 在报告固定后生成并哈希报告，Manifest 自身再由发布指针的 detached checksum 校验。

执行步骤：

1. 冻结输入的 canonical version、Project/Record/Event 数量与 ID 集合、被导出 Record 引用且获授权的 Evidence 数量与 ID、被引用 Receipt ID 集合、源文件哈希、导出策略、目标分支和回滚点。未关联或未授权 Evidence 不属于 Bundle 源集合，只在受保护导出 Receipt/本地报告记录按原因聚合的排除数量，不泄露其 ID，也不从 Canonical Store 删除。
2. 在同一文件系统的 staging 目录生成 `profile.md`、Global 五视图、每个未合并有效 Project 的五视图、每个目标链可验证的既有 merged 源 `redirect.json`、`objects/`、`events/raw/`、`evidence/items/`、`evidence/legacy/`、`evidence/migration/`、`manifest.json` 和单一 `index.json`。目标链不明的历史 merged 声明按第 4 节保留五视图、兼容信封与待评审提示。
3. 导出源集合内的 Project、Record、Event 和 Evidence 按原 ID 1:1 保留；依法已擦除 Event ID 时只保存政策允许的既有序列位置或删除边界，禁止补造。符合新 Schema 的实体正常导出，缺字段实体按 3.2/4 节使用对应 `legacy_*` 兼容信封分流，旧 `Archive` / `archive_snapshot` 使用 `kind=legacy_record`。同一个 canonical ID 在多个视图出现时只引用同一个 Object，不复制正文。
4. 第一轮不执行语义去重、Scope 提升/降级或 Record/Project 合并，也不生成新的 `merged_into`。
5. 如 M0 选择执行重复识别，只输出候选：只有 `content_hash + record_type + scope + source_refs` 完全一致的记录才能列为“高置信候选”；其他相似项只列为“待评审”，两类都不自动合并。没有真实合并需求时可完全跳过此步骤，不影响 ID 和正文完整性。
6. 无法机械确定类型或 Scope 的记录保留在 Object 和 Evidence 中，并进入 `pending_review` 报告；不得猜造 Project ID。若它属于当前 Profile、Decision、State 或 `Now` Task，离线结构工件必须使用明确占位并标记 `views_complete=false`，不得发布为当前生产镜像；解决后才能生成完整当前视图。
7. 旧 Markdown、旧索引和原始材料先执行隐私/凭据/授权扫描；允许导出的原样进入 `evidence/legacy/` 并保存 SHA-256，禁止导出的只保存哈希、受保护引用和 `omitted_reason` 桩。任何旧材料都不参与当前事实仲裁，也不从 Canonical Store 删除。
8. M0 为全部范围内 Event 在 `events/raw/` 导出经 Actor 脱敏的授权投影、连续性桩或依法保留的 erasure tombstone；默认对 `profile` / `audit_only` Event 使用桩。`events/rollups/` 为空或不存在，Manifest 明确 `event_rollups_enabled=false`。
9. 生成器固定稳定排序、UTF-8、LF、JSON 序列化、`build_epoch`、配置哈希、导出策略版本、`snapshot_version` 与逻辑 `migration_run_id`；相同输入和构建时点的幂等重跑必须字节级一致。
10. 自动校验 100% ID、数量、引用、路径、Schema 和文件哈希；人工只处理结构异常、待评审当前记录和抽样渲染检查，不对未改变语义的 262 条记录重复做全面语义审批。
11. 若目标声明为当前生产镜像，发布前必须重新读取 Canonical Store 当前版本；与冻结版本不一致时默认放弃候选并重建，不能以 `views_stale=false` 冒充当前目录。纯离线 Bundle 无法执行该比较时，只生成带版本限定的 `baseline_claim=historical_offline` 结构基线。
12. 使用失败注入证明候选失败不会替换正式入口；只有通过 live recheck 的当前候选才按 10.1 节用单文件 `current.json` 指针或原子 Git ref 更新生产正式入口。离线结构基线可保存到不可变 `published/{snapshot_version}` 或等价版本工件，但不得切换生产正式入口；禁止依赖普通非空目录替换获得原子性。
13. 仅当本次会替换正式入口时执行回滚演练，确认可以恢复旧目录、路由和发布单元；只新增离线版本工件时，以删除入口引用而不删除工件的可恢复性测试替代。

M0 完成门禁：导出源集合中的每个 Project、Record、Event 和 Evidence 都有且只有一个可解释去向；明确排除的 Evidence 未被复制或删除。没有丢失、新增事实、静默改写、半新半旧目录或 Markdown 反向写入。Bundle-only 完成后声明“基于 `<snapshot_version>` 的 M0 两级五视图结构基线已落地，未验证为生产最新”；若 `views_complete=false`，还必须追加“当前视图不完整，含 `<pending_review_count>` 个待评审项”。只有 live recheck、`views_complete=true` 与正式入口切换都通过后，才可声明“M0 当前生产镜像已落地”。两者都不能据此声称 M1/M2 已完成。

### 15.2 M1：运行时合同闭环

M1 验证现有生产能力或补齐以下缺口：

1. Record Mutation、Decision Supersede、Project Mutation、Event Append、Receipt 和 Evidence Ingest 合同全部可执行并有合同测试；Event 的稳定 ID、Store 提交版本、Scope 与内容哈希可验证。无缺口 Stream 序号仅作为实际启用 M2 Rollup 的前置门禁，未启用 Rollup 时可保持关闭。
2. create 使用 `base_version=null`；所有现有实体修改执行正整数 CAS。
3. 需要 Event 的成功业务 Mutation 原子提交目标实体、成功 Event 与 committed Receipt；Standalone Evidence Ingest 原子提交 Evidence 与 Receipt，首次关联才产生 Event。
4. 拒绝或失败先回滚业务事务，再用独立失败审计事务写 Receipt；Failure Event 遵守最小披露规则。
5. 幂等重放返回同一 canonical result envelope 和原 Receipt，不重复目标实体、成功 Event 或 Receipt。
6. Archive 不创建独立事实：Record 按自身 `lifecycle_status` 派生，Project 按 `progress_status=completed|archived` 与 Project 收尾字段派生；旧 Archive 兼容数据在人工确认后归一，不生成第二份权威正文。
7. Evidence 摄取与 Evidence 关联分别测试；后者必须通过目标 Record Mutation 和 CAS。
8. Scope 变化只接受显式命令。M1 必须正确读取、解析已有 Record/Project redirect；没有真实合并需求时可以不启用新建合并写能力，重复实体继续按原 ID 保留且禁止自动/静默合并。启用任一合并写能力时，必须完整实现第 9 节对应合同，所有语义候选人工确认。
9. Renderer、Manifest、单一 Index、授权撤销、RLS、Binding Scope、跨用户隔离和失败恢复测试通过。
10. UI/API/MCP 始终读取 Canonical Store；Markdown 失败不影响在线读写。

M1 完成门禁：新的已授权会话可以恢复当前状态、最近操作、撤回结论、阻塞、证据和唯一下一步；对每个已启用的 M1 写操作，合同测试能证明成功、冲突、失败和重放路径，现有 redirect 读取测试必须始终通过。完成后可以声明“个人级两级五视图架构已闭环”，并明确列出尚未启用的可选合并写能力。

### 15.3 M2：按触发条件启用规模化能力

以下能力不按文档版本强制上线，而按真实阈值触发：

- Event 达到明确保留期或 Bundle 体积阈值后，启用 Rollup、冷存储和覆盖证明。
- 单个 `index.json` 的体积或查询延迟超过已定义 SLO 后，启用索引分片；不得仅因“未来可能变大”提前拆分。
- 出现定时导出、多消费者或并发发布后，把 M0 的当前/上一版本与单一 `current.json` 机制扩展为多版本保留、并发发布协调、GC、Reconciler、Sweeper 和告警。
- 具备人工标注集、可逆预览、误合并恢复和可量化精度门禁后，才允许语义辅助去重、合并或 Scope 提升；默认仍需人工确认。
- 出现真实多成员授权需求后，才进入 Workspace/Team 扩展。

M2 未启用不降低 M0/M1 的数据完整性、安全性或可恢复性。

### 15.4 执行授权边界

本文只定义合同，不授权真实目录迁移、数据库变更、Worker 部署、删除旧文件、commit、push、tag 或 release。每个外部写动作必须在对应门禁通过后按用户授权范围执行。

## 16. 验收标准

### 16.1 M0 验收：目录基线

1. Clued Cloud Canonical Store 保持生产唯一事实源，M0 没有数据库写入或 Schema 变更。
2. `profile.md` 存在且不被误算为工作五视图；Global 和每个未合并有效 Project 均具有 State、Task、Decision、Archive、Log；目标链可验证的既有 merged 源只含标准或 `legacy_project_redirect` tombstone，目标链不明的历史声明则保留带待评审提示的五视图且不可跟随错误路由。
3. Global 固定表示个人跨项目全局，不表示团队全局。
4. 导出源集合中的每个 Project、Record、Event 和 Evidence ID 都有且只有一个可解释去向；未关联/未授权 Evidence 有按原因聚合的排除计数且未被删除；没有丢失、静默改写或新增事实。
5. M0 不执行语义合并、Scope 变更或新建 `merged_into`；候选只进入报告。
6. Markdown 没有独立可写正文；同一 canonical ID 的正文只存在于一个 Object，视图只展示稳定引用与派生摘要。
7. 全部导出范围内 Event 身份及依法允许保留的既有序列位置位于 `events/raw/`，并按策略保存授权投影、连续性桩或 erasure tombstone；数量、ID、Canonical/导出内容哈希和删除边界可由 Raw inventory 与 Manifest 核对，缺少历史序号的 Event 逐 ID 保留且不补造序号。未启用相关能力时，Manifest 明确为 `event_rollups_enabled=false`、`snapshot_counts.event_rollups=0`、`event_stream_ordering_enabled=false`、`event_stream_coverage_hash=null`。
8. 旧 Markdown、旧索引和原始材料的清单完整：获授权原件保存在 `evidence/legacy/`，敏感或未授权项以哈希、受保护引用和省略原因桩表示；任何一项都不能覆盖当前事实。
9. Bundle 只有一个 `index.json`，包含 ID 定位、Scope 过滤和轻量召回分区，并能完全重建。
10. Manifest Schema 5、Object、Raw Event、Markdown 与 `index.json` 使用同一 `snapshot_version`。
11. `bundle_scope` 与 Record/Event Scope 分离；默认 Receipt 只导出引用。
12. 相同输入、固定 `build_epoch`、配置/策略版本、`snapshot_version`、逻辑 `migration_run_id`、稳定排序与序列化规则下，两次生成字节级一致。
13. 声明当前生产镜像前，Canonical Store 当前版本仍等于候选冻结版本、`views_complete=true`；不一致或不完整时已重建/评审。无 live Store 比对的 Bundle-only 构建明确标记 `historical_offline`、未切换生产正式入口，只按限定语声明 M0 结构基线；`views_complete=false` 时还明确披露当前视图不完整及待评审数量。
14. 候选生成失败不会替换正式入口；不存在半新半旧状态。
15. 若替换生产正式入口，`current.json` 单文件指针或 Git ref 原子发布和回滚演练通过，可恢复旧目录、路由和发布单元；纯离线结构基线只验证不可变版本工件可定位、可复现且未触碰正式入口。
16. Bundle 不包含邮箱、Token、Cookie、Service Role Key、原始用户 ID 或未授权 Evidence 原件；所有省略项都有可核对桩。

### 16.2 M1 验收：运行时合同

1. Record、Project、Event、Receipt 和 Evidence 使用彼此独立的写入合同；`event`、Receipt、Evidence 或 Project 不能伪装成 `record_type`。
2. 新 Record/Project 使用 `base_version=null` 并从 `version=1` 开始；更新、关闭、恢复、重分类以及已启用的合并操作使用精确正整数 CAS。
3. 幂等检查先于 CAS；精确重放不因实体后来升级而失败，也不重复业务实体或成功 Event。
4. 需要 Event 的成功 Mutation 在同一事务提交目标实体、成功 Event 与 committed Receipt；Standalone Evidence Ingest 只提交 Evidence 与 committed Receipt。
5. 权限、Schema、CAS 或业务规则失败不改变实体；失败 Receipt 和可选 Failure Event 在独立审计事务写入。
6. `operation_failed` 默认仅审计；普通冲突、非法请求和越权尝试不进入工作 Log。
7. Receipt Schema、服务端 `request_hash` / `received_payload_hash`、目标引用、版本、错误码和精确重放返回原 Receipt 的行为可验证，且不保存敏感正文；规范化前失败只进入平台安全审计。
8. Archive 不是 `record_type`；Record 通过 Record 生命周期进入 Archive，Project 通过 `progress_status=completed|archived` 进入 Global Archive；`archive_snapshot` 被拒绝为新写入类型。
9. Decision Supersede 原子创建 replacement、CAS 关闭全部 source、写单一 Event/Receipt；普通 Mutation 无法留下“新决策已替代但旧决策仍 active”的半状态。
10. `state|task|decision|profile_fact|note` 的类型、Scope、`source_refs` / `source_unavailable_reason`、authority、观察时间、记录时间和 confidence 状态可恢复。
11. Evidence Ingest 独立执行授权、哈希、幂等和 Receipt；Record create 可在同一事务关联已授权 Evidence，已有 Record 的关联变化必须通过 update 与 CAS。
12. Scope 提升或降级不复制正文并保持 canonical ID；非明确来源的 Profile 提升进入人工评审。
13. 服务端与 Bundle Index 对已有 Record/Project redirect 使用 visited-set 稳定解析最终 ID、拒绝循环，并区分标准证明与 `legacy_project_redirect`；目标链不明的兼容项不得参与路由。启用 Record/Project 合并写能力时，双版本 CAS、Record 合并前不可变正文快照及对应 Event/Receipt 合同全部通过；未启用时重复实体保持原 ID，禁止自动合并。
14. Project 的确定程度、进度和别名变化更新受影响的 Project/Global 视图和 Index，但不改变未合并 Project 的 canonical path。启用 Project Merge 时，合并变化还更新完整 closure，并在提交前拒绝多 now Task 冲突。
15. `global/log.md` 只消费 global Event；未合并 Project Log 消费精确 Project Event。存在已有 redirect 或启用 Project Merge 时，合并目标按 merge closure 联合源历史并按 Event ID 去重；无关项目联合查询不写回 Global Log。
16. Profile/audit-only Event 或 Rollup 不生成 Markdown Log；默认 Bundle 只含连续性桩，完整内容只能通过受保护审计路径或显式受保护审计导出读取。
17. Renderer 失败不改变原 committed Receipt；在线 API/MCP/UI 仍读取最新 Canonical Store，派生快照保持上一完整版本并标记 stale。
18. RLS、Binding Scope、撤销、跨用户隔离和 Bundle 权限测试通过。
19. 新的已授权会话能够恢复当前状态、最近操作、撤回结论、阻塞、证据和唯一下一步。

### 16.3 M2 验收：启用时适用

1. Rollup 启用后，每个可 Rollup 的旧 Event ID 都能定位到唯一 Rollup；同一 Event Stream 内的无缺口序号、连续范围、数量、哈希、隐私删除和 Log 重建测试通过。无法证明序号的 Event 继续保留为 Raw Event。
2. 持久版本库启用后，`current.json` 只指向 ready 快照；并发发布、自动重试、清理和告警不会产生跨版本拼接。
3. 索引分片启用后，仍能从同版本快照完全重建，不跨用户或 Workspace 泄漏。
4. 语义辅助启用前具备人工标注、可逆预览、误合并恢复和精度门禁；失败时不得自动改写 canonical truth。
5. 团队多租户能力未完成，不影响 M0/M1 被按各自范围正确声明完成。

## 17. 完成定义

声明必须带门禁，不再使用含糊的“全部完成”：

- 只完成本文修订：称为“v1.6 架构合同已定义”。
- 通过 16.1 的离线/Bundle-only 条目：称为“基于 `<snapshot_version>` 的 M0 两级五视图结构基线已落地，未验证为生产最新”；若 `views_complete=false`，必须再注明当前视图不完整及待评审数量。
- 通过 16.1 且完成 live recheck 与正式入口发布：称为“M0 当前生产镜像已落地”。
- 通过 16.1 的“当前生产镜像”路径并同时通过 16.2：称为“M1 个人级两级五视图架构已闭环”。
- 通过实际启用项对应的 16.3：称为“M2 对应规模化能力已启用”。

M2 默认必须点名具体能力；只有第 15.3 节所有已定义能力都已启用且通过对应验收，才可总体声明“规模化与长期运维能力已启用”。

仅有 Renderer 单元测试、新建空目录或未发布候选，不能声明 M0 完成。M2、Workspace、组织权限和协作通知未实现，不阻塞 M0/M1，但必须明确标注未启用。

## 附录 A：未来 Workspace / Team 扩展

本附录为非阻塞设计方向，不属于 v1.6 的 M0/M1 当前验收标准。

### A.1 不重新定义 Global

未来团队能力增加独立 Scope：

```text
memory/
├── profile.md
├── global/                    # 用户个人全局
├── projects/                  # 用户拥有或参与的项目视图
└── workspaces/
    └── {workspace_id}/        # 团队共享层，独立权限和视图合同
```

是否让 Workspace 也采用五视图，需要另行 ADR；不得直接让现有 `global/` 变成团队全局。

### A.2 未来授权模型

团队版可以增加：

```yaml
workspace_id: 团队工作区边界
user_id: 成员身份
role: owner | admin | member | viewer
project_membership: 成员与项目的授权关系
record_visibility: private | project | workspace | explicit_acl
```

约束：

1. Profile 默认私有。
2. 从 Profile 向团队共享信息必须由用户显式授权，并使用记录级可见性。
3. RLS、API 和 MCP 服务端是授权强制边界。
4. UI 和 Skill 只反映授权结果，不承担安全职责。
5. 团队权限撤销必须立即影响后续在线请求。

### A.3 团队导出与索引

团队版 Bundle 需要：

- 每次只导出一个 Workspace 或一个明确授权子集；
- 复用服务端权限检查；
- 按成员可见项目过滤；
- 生产索引按 Workspace 和 Project 隔离；
- 禁止跨 Workspace 检索结果泄漏；
- Manifest 仍不保存邮箱、Token 或可直接识别的用户身份。

### A.4 决策协作

Decision 广播、未读状态和确认机制属于产品协作能力，可以通过 Event、Notification 与独立确认表实现，但不属于数据一致性的必要条件，也不应阻塞个人级目录迁移。

CAS 解决并发写入冲突；通知与确认解决协作者感知问题，两者必须保持分离。

## 附录 B：v1.2 变更记录

相对 v1.1，本版本完成以下收敛：

1. 将当前方案重新定位为个人用户两级五视图合同，把团队多租户移至非阻塞附录。
2. 明确 `profile.md` 是画像入口，不属于工作五视图。
3. 固定 Global 为用户跨项目全局，不再承担租户或团队全局语义。
4. 明确生产 Canonical Store、Bundle Object/Event 与 Markdown 的三级权威关系。
5. 修正 stale 语义：只影响派生快照，不影响 Canonical API/MCP/UI 读取。
6. 将跨文件“同时切换”具体化为完整版本目录加单一版本指针。
7. 从 Bundle Manifest 移除原始用户身份，改用不透明 Receipt 和可选 Owner Ref。
8. 区分生产检索索引和 Bundle Index，消除单文件索引与多租户分片的冲突。
9. 将 Event 的逻辑只增不改与合规删除、匿名化和保留政策分开。
10. 明确 RLS、API、MCP 服务端是安全边界，UI 和 Skill 不是授权防线。
11. 将模糊的 Profile 类型收敛为可测试的 `profile_fact`。
12. 将团队决策广播和确认从当前验收标准移出，防止目录迁移范围失控。
13. 重写迁移阶段与完成定义，确保“合同完成”不再被误报为“真实迁移完成”。

本方案不授权生产数据库变更、Worker 部署、真实目录迁移、删除旧文件、合并、push、tag 或 release。实际执行必须在迁移事务、dry-run、回滚和权限测试全部通过后获得单独授权。

## 附录 C：v1.3 变更记录

相对 v1.2，本版本补齐以下执行细节：

1. 5.3 节明确 `certainty_status` 变化视为普通 canonical 写入，并要求客户端路径缓存随 version 变化失效，防止旧路径缓存被当作事实源。
2. 8.2 节把“语义是否真正跨项目”的判断细化为三条可测试信号，避免作用域提升依赖纯主观判断。
3. 阶段 2 增加重复正文合并计划的人工抽样审核步骤，并写入完成门禁，弥补 dry-run 无法验证语义合并正确性的缺口。
4. 新增 12.1 节，明确 Event 冷存储/摘要化与 `log.md`、Bundle Index 一致性的处理规则，填补原文未说明的空白。

## 附录 D：v1.4 变更记录

相对 v1.3，本版本完成以下修正：

1. 修正 `certainty_status` 变化时的缓存失效对象：稳定的 canonical path 不变，仅失效项目分组、Global 聚合和相关 Index 等派生缓存。
2. 补充 Project 实体变化的 Renderer 路由，确保项目确定程度和进度变化同步更新 Global 与 Project 视图。
3. 将“脱离原项目后语义仍成立”设为 Scope 提升必要条件；引用数量和长期查询需求仅作为辅助证据。
4. 明确 Profile、Global、Project Archive 的目标 Scope 判定，并要求非用户明确来源的画像候选进入 `pending_review`。
5. 使用 `merged` + `merged_into` 保留旧 ID 去向，消除“合并重复正文”与“ID 集合一致”的冲突。
6. 将语义审核门禁量化：所有合并候选及高风险类型 100% 审核，其余按分层比例审核，发现误判时扩大到整层。
7. 新增 `events/raw/`、`events/rollups/` 和 Event Rollup Schema，明确其为带覆盖证明的保留期派生物，而不是新的 canonical 事实源。
8. 补齐 canonical 写入的 `record_type`、`scope`、`source_refs`、`authority`、时间和置信度字段合同。

本版本完成的是架构合同修正，不代表迁移已实现，也不授权生产数据库变更、Worker 部署、真实目录迁移、删除旧文件、合并、push、tag 或 release。

## 附录 E：v1.5 变更记录

相对 v1.4，本版本完成以下修正：

1. 将第 2.1 节的规范性版本引用更新为 v1.5。
2. 移除未定义的“Canonical Object”泛化术语，并新增 Canonical Store、Record、Project、Event、Receipt、Evidence Metadata 与 `objects/` 的术语边界。
3. 将写入合同拆分为 Canonical Record Mutation、Event Append 和 Evidence Ingest；明确 Event 不属于 `record_type`，自身不执行 CAS。
4. 明确 Evidence 是独立摄取实体，只有关联到 Record 的 `source_refs` 变更才执行 Record CAS。
5. 正式定义 `merged` 为原 Record 的 `lifecycle_status`，并补齐无正文重定向 Schema、双版本 CAS、禁止循环和链路压平规则。
6. 明确 Profile Event/Rollup 只进入受保护审计读取路径，不生成 `profile/log.md` 或 `global/log.md`。
7. 将 Manifest Schema 升级为 4，并把 `scope` 改为 `bundle_scope`，与 Record/Event Scope 明确分离。
8. 将上述规则补入写入路由表和 29 条验收标准。

本版本完成的是架构合同修正，不代表迁移已实现，也不授权生产数据库变更、Worker 部署、真实目录迁移、删除旧文件、合并、push、tag 或 release。

## 附录 F：v1.6 变更记录

相对 v1.5，本版本完成以下修正与降门槛整理：

1. 新增独立 Project Mutation 与 Project Merge 合同，明确 create/update 的版本语义、双目标 CAS、稳定 ID 与重定向行为。
2. 新增正式 Receipt Schema，明确 committed、rejected、failed、请求哈希、目标版本、精确重放返回原 Receipt 和默认 Bundle 导出边界。
3. 将 create 的规范 `base_version` 固定为 `null`、初始版本固定为 1；现有实体变更必须使用正整数 CAS，并把幂等查找放在 CAS 之前。
4. 拆开成功业务事务和失败审计事务：成功实体、Event、Receipt 同事务；失败先回滚，再独立写失败 Receipt 和受限 Failure Event。
5. 取消 `archive_snapshot` 新写入类型；Archive 改为 Record 生命周期与 Project `progress_status` 的派生查询视图，关闭摘要写回原实体。
6. 合并 `index.json` 与 `object-index.json`，一个 Bundle 只保留单一可重建索引；Manifest Schema 升级为 5。
7. 明确 `global/log.md` 与 Project Log 的 Scope；Project 合并目标只联合 merge closure 的源历史，无关项目活动仍在运行时联合查询并按 Event ID 去重。
8. 增加固定 `build_epoch`、排序、UTF-8、LF 和 JSON 序列化规则，消除动态时间戳与字节级幂等之间的冲突。
9. 将实施拆为 M0/M1/M2：M0 只做无语义变更的安全目录落地；M1 闭合运行时合同；M2 按阈值启用 Rollup、持久版本库、自动修复、分片和语义辅助。
10. 第一轮迁移禁止自动语义合并、Scope 迁移和新建 `merged_into`；重复项只报告候选，获授权旧文件保留为 Evidence，敏感或未授权项保留哈希、受保护引用与省略原因桩。
11. 当前 4 Project / 262 Record 规模不再被 Rollup、索引分片、常驻 Reconciler 或全面语义复核阻塞，同时完整目标合同仍被保留。
12. 为 Record、Project、Event、Evidence 补齐通用 legacy 信封与按 kind 分流规则；未映射旧实体不再被迫伪造 canonical ID。
13. Event 补齐 `committed_canonical_version`、多目标引用及可选的按精确 Scope 派生 Stream；M1 以 Raw inventory 保证完整，只有实际启用 M2 Rollup 时才强制无缺口流序号与连续覆盖证明。
14. 规范服务端 `request_hash` 的字段范围、缺失/null 语义、Unicode、排序、集合和 JSON 序列化；客户端可省略哈希声明，Actor 身份统一由认证上下文派生。
15. 默认 Bundle 对 Profile/audit-only Event 使用连续性桩，保持 Event ID、提交版本及源中已有排序元数据，同时不把敏感审计正文泄漏到仓库快照。
16. 明确 Manifest 不哈希自身，以 Raw Event inventory 作为 M0/M1 必需证明、Event Stream 覆盖哈希作为 M2 可选证明，并把 M0 收敛为可由单进程工具完成的最多四个 build/validate/publish/rollback 动作。
17. 新增原子 Decision Supersede 多目标合同，消除 replacement 已生效而 source 仍 active 的半状态。
18. 将 Project Archive 明确为 `progress_status` 派生；Standalone Evidence Ingest 不伪造工作 Scope/Event，Evidence Scope 由授权引用反向计算。
19. M0 最终只发布一个合并迁移报告；Bundle-only 可先完成带版本和完整性限定的结构基线，只有 live recheck 与 `views_complete=true` 才可声明当前生产镜像。
20. 新建 Record/Project Merge 改为按真实需求启用；M1 始终要求安全读取已有 redirect，但没有合并需求时不强制建设写能力。
21. Project redirect 改为可重算的逐段 `redirect_path`，并为缺少历史 Receipt/version 的旧数据增加 `legacy_project_redirect`，禁止补造证明或错误撤下源目录。
22. 区分 Bundle 冻结读点与 Event 事务提交版本；Canonical Event 的原始 Actor 字段在 Bundle 中替换为不可逆引用，并分别保存 Canonical/导出内容哈希。
23. 规范化前失败只进入平台安全审计，Canonical Receipt 从身份已建立且请求成功规范化后开始，删除仅服务复杂失败分支。

本版本只更新方案文档，不代表 M0 真实目录迁移已经执行，也不授权数据库变更、Worker 部署、删除旧文件、commit、push、tag 或 release。
