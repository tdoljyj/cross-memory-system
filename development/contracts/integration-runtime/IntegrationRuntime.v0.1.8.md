# Clued Integration Runtime 实现规格 v0.1.8（插件线 S2c）

**文档 ID：**`CLUED-INTEGRATION-RUNTIME-S2C-IMPL-SPEC-v0.1.8-20260924`（修订自 v0.1.7；变更见 §18）  
**状态：Owner 冻结候选（freeze candidate）/ v0.1.7 增量评审 PASS（0 BLOCKER / 0 MAJOR / 2 MINOR / 6 NIT），v0.1.8 只应用该评审的 2 MINOR 与 6 NIT；显式 Binding 所有权按 Owner Decision `c5574918-936e-4836-a0ba-bfe6696ee450`，撤销范围与 restore 清扫按 Owner Decision `1b034f44-e5b7-414c-a9a1-53b7bf065200`；Owner 门控 OQ 已由 Decision `d11f19ea-c32f-48bd-a570-460347fef110` 裁定**  
**上位基线：**`CLUED-CROSS-HOST-THIN-OPEN-INTEGRATION-DISTRIBUTION-v0.2.6-20260924`（下称“基线”），SHA-256 `2c5950f19ea3e817bdcaf672c50cb9ae461b1db05ea25b188002cc918ddbaaf3`，153,289 bytes；Owner 冻结 Decision `b4a7f879-88d8-4772-ace6-6e8fda591f77`  
**仓库基点：**`tdoljyj/cross-memory-system` `origin/main` `cf1a2809`（PR #334 已合入）；main 上最新迁移 `20260925030000_search_context_cross_scope.sql`。`20260925040000_search_context_followups.sql` 已由 S2a-2 follow-up PR #335 占用（`origin/claude/dreamy-shannon-hffhqh` tip `a6728b90`，尚未合入 main）。本规格的迁移时间戳一律从 `20260926000000` 起（§14.1），并须在 PR 创建时按当时 main 与已知待合入 PR 重新取值  
**Authority 效力：**本文件只是实现规格。它不授予实施、合并、迁移、部署、flag 开启、生产或发布权限；每一项仍需其所属阶段授权（根 `AGENTS.md`、`apps/clued-cloud/AGENTS.md`）。本文件与基线冲突时以基线为准，冲突本身应作为缺陷报告，而不是就地“解释掉”。

---

## 0. 规范用语与标注

- “必须 / 不得 / 应 / 可以”分别对应 MUST / MUST NOT / SHOULD / MAY。
- 【基线 §x】：条款直接来自基线对应章节，本规格只做工程化，不得弱化。
- 【提议】：基线未规定、由本规格提出的实现选择。每个【提议】要么可在不改变基线语义的前提下替换，要么已列入 §16 未决问题（OQ）等待 Owner / 评审裁定。
- 【约定】：沿用本仓库既有工程约定（`clued_private` schema、security definer、M1 Receipt core、CAS、幂等键等）。
- 代码中的枚举值、函数名、表名、错误码均为规范性名称；实现 PR 更名必须同步修订本规格。

关于基线身份的说明：基线文件字节内的状态行仍写作 `TARGETED REVISION CANDIDATE / NOT FROZEN`。依基线 §00 的“外部 Authority 冻结、原对象字节不回改”惯例，v0.2.6 由 Owner 冻结 Decision `b4a7f879-88d8-4772-ace6-6e8fda591f77` 在外部冻结；实现 PR 必须在描述中引用该 Decision ID（OQ-18 已回答）。

---

## 1. 目的

S2c 实现基线 §41.0 中“实现于 S2c”的 Phase A 合同的**首个服务端运行时**：Integration 身份、Installation Request 绑定、Identity Claim、Canonical Truth 规范化、全函数式状态派生、Operability、Effective Capability、Canonical 验证与 READY(profile) 验证分离、Revocation / Reauthorization 分离，以及按 Integration 的能力声明与 Integration Lifecycle 的生命周期部分。

S2c 的完成标准【基线 §41.0、§42.0】：

```text
G-A3  CAPABILITY_OPERABILITY_MODEL_READY                 按 §42 负例 / 性质测试 PASS
G-A7  PROFILE_INDEPENDENT_TOTAL_STATE_DERIVATION_PASS    按 §42 性质测试 PASS
G-A8  READY_VERIFICATION_SEPARATION_PASS                 按 §42 性质测试 PASS
G-A10 INSTALLATION_BINDING_AND_IDENTITY_CLAIM_PASS       按 §42 负例 PASS
G-A11 REVOCATION_REAUTH_SEMANTICS_PASS                   按 §42 G-A11 / G-B7 负例中属于 G-A11 的部分 PASS
G-A9  INSTALLATION_INTEGRATION_LIFECYCLE_CLOSED          以生命周期运行时闭环 PASS（§42 未定义专属负例；本规格 §13.6 给出提议判据）
```

Gate 判定只能以本规格 §13 的可执行测试与仓库证据为准；合同层审阅不得代替负例 / 性质测试【基线 §42.0】。

---

## 2. 范围

### 2.1 S2c 实现的合同（映射基线 §41.0 31 项合同表）

| # | 合同 | 基线章节 | S2c 实现内容 | 本规格章节 |
|---|---|---|---|---|
| 2 | Portability Mapping | §03 | **无**（S4 canonical 布局、S5 打包） | — |
| 6 | Host Capability Model（运行时部分） | §11、§17、§24.1、§25.3、§29.2、§55.1 | Host / Surface / Provider 注册表；Host 与 Adapter 能力上界；“Preserve or Narrow”执行；Host Capability Snapshot 引用。S3 部分（真实 surface 行为验证、Qualification Receipt）不在本阶段 | §5.1、§5.10、§9.3 |
| 7 | Stable Integration Identity Contract | §15 | 稳定 `integration_id`；生命周期内不变 | §5.2 |
| 8 | Provider-qualified Integration Identity Tuple | §15.1 | 六维 Tuple，逐维三态（值 / NOT_APPLICABLE / UNAVAILABLE），`provider` 不可空 | §5.2、§6.1 |
| 9 | Installation Request ↔ Integration Binding | §14、§14.1–§14.3、§14.6 | transient Request；request-local 幂等；一 Request 至多绑定一个 `integration_id` | §5.3、§10.2 |
| 10 | Cross-Request Stable Identity Claim | §14.4 | Claim Store；每个完整 Claim Key 在同一 binding domain 至多一个 current holder | §5.4、§6.3、§10.3 |
| 11 | Late Identity Strengthening / Re-Claim | §14.5 | INCOMPLETE→COMPLETE 原子 re-claim；claim-key 维度变化的原子迁移 | §6.4、§10.4 |
| 12 | Identity Claim Runtime Truth / Capability Closure | §15.2 | `identity_claim_state` 作为 Canonical Truth Input；Claim Store 与 truth 同事务一致 | §5.4、§6.5、§8 |
| 13 | Integration Lifecycle（生命周期部分） | §14、§14.2、§14.6、§37 | 出生、安装完成、首次授权、rebind / reinstall / recovery / adapter migration / verification repair、暂停 / 恢复、升级、supersede。**Connect 切换部分属 S6** | §7.2、§10、§13.6 |
| 14 | Canonical Truth Input / Normalization | §16、§16.1 | 版本化规范化函数；互斥值、缺失、Claim Store 不一致 → `DERIVATION_INPUT_INVALID` | §7 |
| 15 | Profile-independent Total State Derivation | §16、§16.2、§16.3 | 纯函数 `integration_derive_v1`；十状态全覆盖；固定优先级 | §8 |
| 16 | Verification Eligibility / Preclusion Predicate | §16.3 | `verification_eligible`、`verification_precluded_by_blocking_fact` 派生谓词 | §8.3 |
| 17 | BLOCKED State Semantics | §16.2、§16.4 | 版本化 non-reauth blocking predicates | §8.3 |
| 18 | Candidate Ordinary Capability Set | §17 | Profile-independent 交集公式 | §9.2 |
| 19 | Integration Operability Model | §16.6 | Operable 公式 | §9.4 |
| 20 | Effective Capability Model | §17 | Ordinary Effective Capability Set 投影 | §9.4 |
| 21 | Canonical Runtime Verification / READY(profile) Verification Split | §16.5、§21 | 两类验证分表、分函数、分权限；C 类不进入本运行时 | §5.7、§5.8、§10.7、§10.8 |
| 22 | READY Projection Contract | §20 | `READY(profile)` 服务端投影与可选投影 Receipt | §9.5、§10.9 |
| 23 | Revocation / Reauthorization Semantic Split | §37–§39 | 真正 Revocation fail closed；REAUTH_REQUIRED 恢复不扩权；REVOKED 只能显式 restore / regrant | §5.9、§10.10–§10.12 |
| — | 按 Integration 的能力声明（§41.0 S2c 行） | §11、§17、§41.0 | 每个 Integration 的版本化能力声明，只能收窄 | §5.10、§10.6 |

### 2.2 明确不在 S2c 范围

```text
打包与分发：Plugin / App / Connector / Skills 打包、manifest、Directory 提交（S4 / S5）
公共投影：public schema、Core error taxonomy、public capability registry 的 Core-Origin 投影（S2b）
Clued Connect 原生安装切换（Integration Lifecycle 的 Connect 部分，S6）
真实 Host surface 运行行为验证与 Qualification Receipt（S3；S2c 只提供 READY 证据机制）
生产 rollout：任何迁移应用到生产、Worker 部署、flag 开启、阶段授权包（各自授权）
Native UI（S6 之前只提供受 flag 控制的 REST / RPC）
对现有工具调用路径的强制门控（resolve_binding 热路径不改；见 §12.5）
G-B7 “混合来源 Artifact 逐 object class 回溯唯一 Authoring Authority”（S4）
Portability Mapping（#2）的任何部分
```

### 2.3 与既有系统的关系：绑定，不替换

【约定 + 提议】Integration 运行时是现有 Binding / 委托 OAuth v12 之上的**新增** Canonical 层：

1. `public.clued_agent_bindings` 继续是认证凭据载体；`clued_private.authorizations_v12` / `authorization_entries_v12` 继续是授权与资源动作范围的唯一真相源。Integration 只**读取**它们作为 `authentication_state`、`authorization_state`、`oauth_scope_facts`、`resource_action_scope_facts` 的来源（§7.2），不复制、不回写其语义。
2. Integration 与 Binding 的关系是 `integration_connections_v1` 链接（§5.5）：一个 Integration 在任一时刻至多一个 current connection；一个 Binding 至多是一个 Integration 的 current connection。v0.1.4（Owner Decision `c5574918`）：每个被链接过的 Binding 另有唯一所有者 Integration（`integration_binding_owners_v1`），所有权只经 Owner-native 路径转移，撤销按所有权执行。
3. S2c 迁移**不得修改任何既有函数、表、策略或 grant**（§13.7 T-S-3 以 `pg_get_functiondef` 哈希对比证明）。唯一写入既有表的路径是撤销：Integration-level Revocation 在同一事务内撤销该 Integration **拥有**的 Binding 及其同 client 的未拥有 Binding（v0.1.5，NIT-2 / Owner Decision `1b034f44`；已转移给其他 Integration 的 Binding 即使仍有历史链接也不撤销），restore 撤销被取代的旧 Binding（§10.12），均连同其 Authorization（§10.10），其语义与 `clued_authorization_manage_v12(op='revoke')` 相同，并额外写 `authorization_audit_v12` 行（`operation='revoke_integration'`）。
4. Receipt 使用既有 M1 Receipt core（`clued_private.m1_begin_receipt` / `m1_finish_receipt`，`public.clued_audit_receipts`），新增 operation family（§11.3）；不新建第二套 Receipt 表。
5. Currentness core、MTPE、投影、五视图、搜索、导出均不读取 Integration 表；Integration 对象不是 Canonical Record。

---

## 3. 术语

| 术语 | 定义 |
|---|---|
| Integration | 长期对象，主键 `integration_id uuid`，拥有 Identity Tuple 与 Canonical Truth Inputs【基线 §15】 |
| Installation Request | transient bootstrap 对象；只有 request status，没有 `integration_state`【基线 §14、§14.1】 |
| Connection | Integration 与一个 `clued_agent_bindings` 行的链接（§5.5） |
| Principal | `clued_principal_id` = `auth.users.id` = 既有 `user_id` / `owner_id` |
| Binding 调用 | 以 `clued_bnd_` 令牌哈希调用的 RPC（含 raw Binding 与委托 OAuth v12 发放的 Binding） |
| 委托 OAuth 连接 | 存在 `clued_private.authorizations_v12` 行的 Binding |
| Raw Binding | 不存在 `authorizations_v12` 行的 Binding（既有“显式既有授权”语义） |
| Native account session | 直接人类会话，经 `clued_private.authorization_owner_v12()` 校验（JWT 无 `client_id`） |
| Operator | 平台管理员，经 `clued_private.platform_admin_v13` 成员资格 + 直接人类会话校验，代表 Clued / Policy / Security |
| Facts 文档 | `clued.integration-facts.v1` JSON，规范化后的全部 Canonical Truth Inputs（§7.1） |
| Derivation contract | `clued.integration-derivation.v1`，含谓词、优先级、能力交集、策略版本（§8） |
| Subject digest | 绑定验证有效性的主体摘要（§7.4） |

---

## 4. 总体架构

```text
                     ┌─────────────── existing (unchanged) ───────────────┐
                     │ clued_agent_bindings  authorizations_v12 / entries │
                     │ auth.users            clued_continuity_sessions    │
                     │ clued_audit_receipts (M1 Receipt core)            │
                     └───────────────▲──────────────────▲─────────────────┘
                          read-only  │                  │ receipts (new families)
┌────────────────────────────────────┴──────────────────┴──────────────────────────┐
│ clued_private (new, S2c)                                                          │
│  registries ─ hosts / surfaces / providers / binding domains / vocabulary /       │
│               scope map / policy / READY profiles                                 │
│  integrations_v1 ── identity tuple + identity_claim_state + lifecycle columns     │
│  integration_installation_requests_v1 (transient)                                 │
│  integration_claims_v1 (Claim Store, partial-unique CURRENT)                      │
│  integration_connections_v1 (↔ bindings)                                          │
│  integration_facts_v1 / capability_declarations_v1                                │
│  integration_canonical_verifications_v1  ║  integration_ready_verifications_v1    │
│  integration_revocations_v1 / regrants_v1 / reauth_marks_v1                       │
│  integration_identity_snapshots_v1 / operation_log_v1 / derivation_diagnostics_v1 │
│                                                                                   │
│  integration_normalize_v1(id, as_of)  → facts (never reads READY tables)          │
│  integration_derive_v1(facts)         → state / operable / capabilities (pure)    │
│  integration_ready_project_v1(id, profile, as_of) → READY(profile) (separate)     │
└───────────────────────────────▲───────────────────────────────────────────────────┘
                                │ public RPC wrappers (Binding / Native / Operator)
                    Worker (flag CLUED_INTEGRATION_RUNTIME_V1, default off)
```

权威性：**SQL 是唯一权威实现**。`integration_derive_v1` 为 `IMMUTABLE`、不读任何表的纯函数；S2c **不提供** TypeScript 镜像（§8.6）。

---

## 5. 数据模型

所有新表位于 `clued_private`，【约定】：`enable row level security`；`revoke all ... from public, anon, authenticated, service_role`；identity 序列同样 revoke；不创建 public 视图（§5.14）。所有时间戳使用 `timestamptz`，写入使用 `clock_timestamp()`。文中 DDL 为规范性草案：列名、约束与索引语义为规范，写法可在 PR 中调整。

### 5.1 注册表（版本化，只由迁移写入）

注册表行只能由迁移插入或以新版本行替换；不存在运行时写注册表的 RPC。测试专用行（如 `test.*` Host）只能由测试插入，迁移不得包含。

```sql
create table clued_private.integration_hosts_v1 (
  host text primary key check (host ~ '^[a-z][a-z0-9_.-]{2,63}$'),       -- e.g. 'anthropic.claude'
  tenant_dimension text not null check (tenant_dimension in ('REQUIRED','NOT_APPLICABLE')),
  account_dimension text not null check (account_dimension in ('REQUIRED','NOT_APPLICABLE')),
  -- accepted verifiable evidence kinds per dimension; weak kinds are never listed (§6.2)
  tenant_evidence_kinds text[] not null default '{}',
  account_evidence_kinds text[] not null default '{}',
  first_authorization_required boolean not null default true,
  registry_version integer not null check (registry_version >= 1),
  capability_snapshot_ref text not null,   -- e.g. 'v0.2.6 §55.1 2026-09-24'
  created_at timestamptz not null default clock_timestamp()
);

create table clued_private.integration_host_surfaces_v1 (
  host text not null references clued_private.integration_hosts_v1(host),
  surface text not null check (surface ~ '^[a-z][a-z0-9_-]{1,39}$'),   -- chat / cowork / claude_code / web / desktop / mobile / codex ...
  capability_ceiling text[] not null,      -- ⊆ vocabulary; Host Capability upper bound (Preserve or Narrow)
  host_features jsonb not null,            -- {"mcp_tools":bool,"oauth":bool,"skills":bool,"hooks":bool,"subagents":bool}
  registry_version integer not null check (registry_version >= 1),
  primary key (host, surface)
);

create table clued_private.integration_providers_v1 (
  provider text primary key check (provider ~ '^[a-z][a-z0-9_.-]{2,63}$'),  -- e.g. 'clued.oauth.v12', 'clued.binding.v1'
  connection_dimension text not null check (connection_dimension in ('REQUIRED','NOT_APPLICABLE')),
  connection_source text not null check (connection_source in
    ('OAUTH_V12_CLIENT_ID_SHA256','BINDING_ID','HOST_NATIVE_REGISTRY')),
  host_native boolean not null default false,
  registry_version integer not null check (registry_version >= 1)
);

create table clued_private.integration_binding_domains_v1 (
  domain text primary key,                 -- 'clued.default.v1'
  max_current_holders integer not null check (max_current_holders = 1),  -- §14.4 default; >1 needs a new identity dimension first
  registry_version integer not null
);

create table clued_private.integration_capability_vocabulary_v1 (
  capability text primary key check (capability in
    ('context.read','context.write','audit.read','project.read','project.write','evidence.write','development_history.read')),
  vocabulary_version integer not null
);

create table clued_private.integration_scope_capability_map_v1 (
  map_version integer not null,
  oauth_scope text not null check (oauth_scope in ('context:read','context:write','audit:read')),
  resource_action text not null check (resource_action in ('read','write','close','restore','audit','feedback_submit')),
  capability text not null references clued_private.integration_capability_vocabulary_v1(capability),
  primary key (map_version, oauth_scope, capability)
);

create table clued_private.integration_policy_v1 (
  policy_version integer primary key,
  incomplete_identity_ordinary_runtime text not null check (incomplete_identity_ordinary_runtime in ('PERMIT','DENY')),
  qualification_not_evaluated text not null check (qualification_not_evaluated in ('NON_BLOCKING','BLOCKING')),
  default_recovery_policy text not null check (default_recovery_policy in ('PERMITS_REAUTH','FORBIDS_REAUTH')),
  canonical_verification_ttl interval not null,
  installation_request_ttl interval not null,
  preclusion_rule text not null check (preclusion_rule in ('ALL_BLOCKING_PREDICATES')),
  created_at timestamptz not null default clock_timestamp()
);

-- v0.1.1 (MINOR-8): minimum-version compatibility rules; seeded empty in S2c (tests insert their own rows)
create table clued_private.integration_compatibility_rules_v1 (
  host text not null references clued_private.integration_hosts_v1(host),
  adapter_family text not null check (char_length(adapter_family) between 1 and 80),
  min_adapter_version text check (min_adapter_version is null or min_adapter_version ~ '^[0-9]+(\.[0-9]+){0,3}$'),
  min_package_version text check (min_package_version is null or min_package_version ~ '^[0-9]+(\.[0-9]+){0,3}$'),
  below_minimum text not null check (below_minimum in ('HARD_INCOMPATIBLE','DEGRADED')),
  degraded_mask text[],                    -- required iff below_minimum = 'DEGRADED'
  registry_version integer not null check (registry_version >= 1),
  primary key (host, adapter_family, registry_version),
  check ((below_minimum = 'DEGRADED') = (degraded_mask is not null)),
  -- v0.1.2 (NIT-3): a rule constrains at least one version; the mask is validated against the vocabulary
  check (min_adapter_version is not null or min_package_version is not null),
  check (degraded_mask is null or clued_private.integration_capabilities_valid_v1(degraded_mask))
);

create table clued_private.integration_ready_profiles_v1 (
  profile_id text not null check (profile_id ~ '^[a-z][a-z0-9_.-]{2,79}$'),
  profile_version integer not null check (profile_version >= 1),
  required_capabilities text[] not null check (cardinality(required_capabilities) >= 1),
  required_qualification text not null check (required_qualification in ('ANY','QUALIFIED')),
  evidence_rules jsonb not null,           -- per capability: server-observable evidence (§10.8)
  freshness_ttl interval not null,
  primary key (profile_id, profile_version)
);
```

S2c 迁移的初始种子【提议】：

- Hosts：`anthropic.claude`（surfaces `chat`、`cowork`、`claude_code`）、`openai.chatgpt`（`web`、`desktop`、`mobile`、`codex`）、`generic.mcp`（`default`）。`account_dimension='REQUIRED'`、`account_evidence_kinds='{}'`（S2c 没有可验证来源，见 OQ-4），`tenant_dimension='REQUIRED'`、`tenant_evidence_kinds='{}'`。`host_features` 依基线 §24.1、§55.1：`hooks`/`subagents` 仅 `cowork`、`claude_code` 为 true。`capability_ceiling` 为全词表（收窄由声明与授权完成）。
- Providers：`clued.oauth.v12`（`connection_source='OAUTH_V12_CLIENT_ID_SHA256'`）、`clued.binding.v1`（`connection_source='BINDING_ID'`）。
- Binding domain：`clued.default.v1`。
- Scope map v1：见 §9.1。
- Policy v1：`incomplete_identity_ordinary_runtime='PERMIT'`（OQ-3）、`qualification_not_evaluated='NON_BLOCKING'`（OQ-7）、`default_recovery_policy='PERMITS_REAUTH'`、`canonical_verification_ttl='30 days'`、`installation_request_ttl='30 minutes'`、`preclusion_rule='ALL_BLOCKING_PREDICATES'`（OQ-8）。
- READY profiles：**无生产 profile**（S3 定义）；测试自带 profile。
- Compatibility rules：**无种子行**（S2c 没有已知的最低版本要求）；测试自带规则行（T-A9-7）。版本比较由 `clued_private.integration_version_cmp_v1(text, text)`（immutable）按点分数字逐段比较；存在规则但 `adapter_version` / `package_version` 不是点分数字时按 `below_minimum` 处理（fail closed）。v0.1.2（NIT-3）补充：
  - 比较对象是 `integrations_v1.adapter_version` / `package_version`。`declare`（§10.6）在写声明行的同一事务内同步更新这两列与 `adapter_family`，因此它们总等于最新声明；subject digest（§7.4）读同样的列，二者不会分叉；
  - 规则的 `min_package_version` 非空而 Integration 的 `package_version` 为 null → 视为低于最低版本（fail closed）；`min_package_version` 为 null 时不比较 package；
  - `integration_capabilities_valid_v1(text[])`（immutable）以与 §5.1 词表 CHECK 相同的常量列表校验能力名，供 `degraded_mask`、`capability_mask` 与 ceiling 使用。

### 5.2 Integration

```sql
create table clued_private.integrations_v1 (
  integration_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,        -- clued_principal_id
  host text not null references clued_private.integration_hosts_v1(host),
  provider text not null references clued_private.integration_providers_v1(provider), -- never null (§15.1)
  tenant_status text not null check (tenant_status in ('VALUE','NOT_APPLICABLE','UNAVAILABLE')),
  host_tenant_or_workspace_id text check (host_tenant_or_workspace_id is null or char_length(host_tenant_or_workspace_id) between 1 and 255),
  account_status text not null check (account_status in ('VALUE','NOT_APPLICABLE','UNAVAILABLE')),
  host_account_id text check (host_account_id is null or char_length(host_account_id) between 1 and 255),
  connection_status text not null check (connection_status in ('VALUE','NOT_APPLICABLE','UNAVAILABLE')),
  provider_connection_id text check (provider_connection_id is null or char_length(provider_connection_id) between 1 and 255),
  active_binding_domain text not null references clued_private.integration_binding_domains_v1(domain),
  identity_completeness text not null check (identity_completeness in ('COMPLETE','INCOMPLETE')),
  claim_key_sha256 text check (claim_key_sha256 is null or claim_key_sha256 ~ '^[0-9a-f]{64}$'),
  identity_claim_state text not null check (identity_claim_state in
    ('INCOMPLETE_UNCLAIMED','CURRENT_CLAIM_HOLDER','CLAIM_CONFLICT','PENDING_RECONCILE','SUPERSEDED')),
  conflicting_integration_id uuid references clued_private.integrations_v1(integration_id),
  current_identity_snapshot_id uuid not null,
  adapter_family text not null check (char_length(adapter_family) between 1 and 80),
  adapter_version text not null check (char_length(adapter_version) between 1 and 40),
  package_version text check (package_version is null or char_length(package_version) between 1 and 40),
  -- lifecycle_facts / installation_facts (§7.2)
  install_status text not null check (install_status in ('PENDING','COMPLETED')),
  ordinary_runtime text not null default 'PERMITTED' check (ordinary_runtime in ('PERMITTED','PAUSED_BY_OWNER','PAUSED_BY_POLICY')),
  historical text not null default 'NONE' check (historical in ('NONE','SUPERSEDED')),
  superseded_by_integration_id uuid references clued_private.integrations_v1(integration_id),
  recovery_policy text not null check (recovery_policy in ('PERMITS_REAUTH','FORBIDS_REAUTH')),
  first_authorization_required boolean not null,
  first_authorized_at timestamptz,
  -- v0.1.1 (MINOR-12): ceiling covers OAuth scopes AND v12 resource entries, not scopes only
  authorization_ceiling jsonb,             -- {"scopes":[...], "entries":[{resource_kind,resource_id,environment,actions[]}]} | {"scopes":[...],"entries":"LEGACY_UNRESTRICTED"} (§10.11)
  authorization_ceiling_set_at timestamptz,
  policy_version integer not null references clued_private.integration_policy_v1(policy_version),
  version bigint not null default 1 check (version >= 1),                   -- CAS
  created_receipt_id uuid not null,
  last_receipt_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  -- dimension value present iff status = VALUE
  check ((tenant_status = 'VALUE') = (host_tenant_or_workspace_id is not null)),
  check ((account_status = 'VALUE') = (host_account_id is not null)),
  check ((connection_status = 'VALUE') = (provider_connection_id is not null)),
  -- completeness is a function of the three statuses; key present iff complete
  check ((identity_completeness = 'COMPLETE') = (tenant_status <> 'UNAVAILABLE' and account_status <> 'UNAVAILABLE' and connection_status <> 'UNAVAILABLE')),
  check ((identity_completeness = 'COMPLETE') = (claim_key_sha256 is not null)),
  -- v0.1.1 (MINOR-6): INCOMPLETE identities are exactly INCOMPLETE_UNCLAIMED (OQ-19 dropped: no S2c operation merges incomplete Integrations)
  check ((identity_completeness = 'INCOMPLETE') = (identity_claim_state = 'INCOMPLETE_UNCLAIMED')),
  -- CLAIM_CONFLICT and PENDING_RECONCILE both keep the conflicting holder ref (§14.5 "conflicting integration ref")
  check ((identity_claim_state in ('CLAIM_CONFLICT','PENDING_RECONCILE')) = (conflicting_integration_id is not null)),
  check ((authorization_ceiling is null) = (authorization_ceiling_set_at is null)),
  -- v0.1.2 (NIT-2): shape check (scopes ⊆ v12 scopes; entries = "LEGACY_UNRESTRICTED" or a list of well-formed entries)
  check (authorization_ceiling is null or clued_private.integration_ceiling_valid_v1(authorization_ceiling)),
  check ((identity_claim_state = 'SUPERSEDED') = (historical = 'SUPERSEDED')),
  check ((historical = 'SUPERSEDED') = (superseded_by_integration_id is not null))
);
create index integrations_v1_owner on clued_private.integrations_v1(owner_id, created_at desc);
create index integrations_v1_claim_key on clued_private.integrations_v1(claim_key_sha256) where claim_key_sha256 is not null;
```

要点：

1. **没有** `integration_state`、`integration_operable`、`effective_capabilities` 列。它们是只读派生投影，只由 `integration_evaluate_v1` 在读时计算【基线 §15、§16：不得直接写入】。
2. `integration_id` 在行创建时分配，且只在 create-or-bind 事务中创建，该事务同时写入 Request 绑定（§10.3）【基线 §14.1】。
3. 行不物理删除；`on delete cascade` 仅随账户删除。SUPERSEDED / REVOKED 行作为历史对象保留【基线 §14.4、§14.5】。
4. CHECK 约束已排除一部分矛盾组合（如 INCOMPLETE ∧ CURRENT_CLAIM_HOLDER）。§7.3 的规范化校验仍独立执行这些检查（纵深防御；约束被绕过时 fail closed）。

```sql
create table clued_private.integration_identity_snapshots_v1 (
  snapshot_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  owner_id uuid not null,
  tuple jsonb not null,                    -- canonical JSON of the six dimensions + statuses + evidence kinds
  tuple_sha256 text not null check (tuple_sha256 ~ '^[0-9a-f]{64}$'),
  claim_key_sha256 text,
  receipt_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);   -- append-only: no UPDATE/DELETE grants to anyone, and a trigger rejects UPDATE/DELETE
```

### 5.3 Installation Request（transient）

```sql
create table clued_private.integration_installation_requests_v1 (
  request_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_key text not null check (char_length(request_key) between 16 and 160),   -- host/client nonce
  intent text not null check (intent in ('create_or_bind','bind_connection','rebind','reauthorization',
    'reinstall','recovery','adapter_migration','verification_repair','restore')),
  target_integration_id uuid references clued_private.integrations_v1(integration_id),
  created_via text not null check (created_via in ('binding','native_session')),
  creator_binding_id uuid,                 -- provenance only; kept even if the Binding is later deleted
  request_payload jsonb not null,          -- proposed identity facts, adapter/package, surface, provenance
  request_payload_sha256 text not null check (request_payload_sha256 ~ '^[0-9a-f]{64}$'),
  source_provenance jsonb not null,
  callback_provenance jsonb,
  request_status text not null default 'OPEN' check (request_status in ('OPEN','BOUND','CLOSED','ARCHIVED','REJECTED')),
  bound_integration_id uuid references clued_private.integrations_v1(integration_id),
  bound_intent_sha256 text check (bound_intent_sha256 is null or bound_intent_sha256 ~ '^[0-9a-f]{64}$'),
  bound_receipt_id uuid,
  version bigint not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (owner_id, request_key),
  check (request_status <> 'BOUND' or bound_integration_id is not null),
  check (request_status not in ('OPEN','REJECTED') or bound_integration_id is null),
  -- create_or_bind may name no target; every recovery-style intent names exactly one existing Integration
  check (intent = 'create_or_bind' or target_integration_id is not null)
);
```

规则：

1. `request_status` 取值与 `integration_state` 取值集合**不相交**（§13.6 T-A9-1 静态校验）【基线 §14.1】。`EXPIRED` 不存储，而是读时由 `expires_at <= as_of ∧ request_status='OPEN'` 派生。
2. `bound_integration_id` 只能 `null → 值` 一次；此后不可改变。由 `before update` 触发器强制（`installation_request_bound_immutable`）【基线 §14.3：one Request → MUST NOT bind two different `integration_id`】。
3. Request 的 close / expire / archive 不得触碰 `integrations_v1` 或任何 fact 表【基线 §14.6】。
4. `request_key` 相同但 `request_payload_sha256` 不同 → `installation_request_key_conflict`（request rule）。

### 5.4 Claim Store

```sql
create table clued_private.integration_claims_v1 (
  claim_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  active_binding_domain text not null,
  claim_key_sha256 text not null check (claim_key_sha256 ~ '^[0-9a-f]{64}$'),
  claim_key_material jsonb not null,       -- canonical JSON that hashes to claim_key_sha256
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  claim_status text not null check (claim_status in ('CURRENT','RELEASED','SUPERSEDED')),
  claimed_receipt_id uuid not null,
  ended_receipt_id uuid,
  claimed_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  check ((claim_status = 'CURRENT') = (ended_at is null))
);
create unique index integration_claims_v1_one_current_per_key
  on clued_private.integration_claims_v1(active_binding_domain, claim_key_sha256) where claim_status = 'CURRENT';
create unique index integration_claims_v1_one_current_per_integration
  on clued_private.integration_claims_v1(integration_id) where claim_status = 'CURRENT';
```

一致性约束（Claim Store ⇔ Canonical `identity_claim_state`）【基线 §15.2、§16.1 第 4 条、§42 G-A10 末条】：

```text
对每个 integration I，在每个事务提交点：
  I.identity_claim_state = 'CURRENT_CLAIM_HOLDER'
  ⇔ ∃! claim c: c.integration_id = I ∧ c.claim_status = 'CURRENT'
                ∧ c.claim_key_sha256 = I.claim_key_sha256
                ∧ c.active_binding_domain = I.active_binding_domain
```

实现：`clued_private.integration_claim_consistency_v1()` 作为 `constraint trigger ... after insert or update on integrations_v1 / integration_claims_v1 deferrable initially deferred for each row`，违反时 `raise exception 'identity_claim_store_divergence' using errcode='23514'`，整个事务回滚。因此不存在“Claim Store 已冲突但 Canonical Truth 仍可运行”的可观察窗口。规范化函数另行检查同一等式（§7.3 C4/C5），用于约束被绕过（例如 `session_replication_role=replica`）时的 fail closed。

注意（v0.1.1，MINOR-3）：`session_replication_role=replica` 只停用触发器（含本节的 deferred 约束触发器与 FK 触发器），**不**停用 CHECK 约束与唯一索引。因此 replica 模式只能制造触发器层面的不一致（缺 CURRENT 行、键不符、非 holder 却持有 CURRENT 行、connection 指向他人 Binding 等 C4/C5/C7 情形）；被 CHECK 或唯一索引排除的组合（C2、C3、C6、同一 Integration 多条 CURRENT claim、多个 current connection）只能在 facts / 纯函数层测试，或由测试在自己的一次性测试库中显式 `alter table ... drop constraint` / `drop index` 后构造（§13.0）。规范化对这些组合的检查仍保留，作为纵深防御。

### 5.5 Connection（↔ Binding）

```sql
create table clued_private.integration_connections_v1 (
  connection_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  binding_id uuid not null,                -- public.clued_agent_bindings(id); no FK so history survives Binding deletion
  connection_kind text not null check (connection_kind in ('OAUTH_V12','RAW_BINDING')),
  link_status text not null check (link_status in ('CURRENT','HISTORICAL')),
  linked_at timestamptz not null default clock_timestamp(),
  unlinked_at timestamptz,
  scopes_at_link text[] not null,
  provider text not null,                  -- provider-connection identity snapshot at link time (MAJOR-1)
  provider_connection_id text not null,    -- sha256(v12 client_id) or binding_id (§6.2)
  link_authority text not null check (link_authority in
    ('CREATE','SELF','SAME_PROVIDER_CONNECTION','NATIVE_BIND_REQUEST','NATIVE_OWNER_CONFIRMED','NATIVE_ADOPT','NATIVE_RESTORE',
     'NATIVE_RECONCILE','OPERATOR_RESTORE')),  -- NATIVE_RECONCILE: v0.1.4 (MINOR-N14), REBIND_TO_HOLDER;
                                               -- OPERATOR_RESTORE: v0.1.6 (NIT-5), Operator restore
  link_receipt_id uuid not null,
  unlink_receipt_id uuid,
  check ((link_status = 'CURRENT') = (unlinked_at is null))
);
create unique index integration_connections_v1_one_current_per_integration
  on clued_private.integration_connections_v1(integration_id) where link_status = 'CURRENT';
create unique index integration_connections_v1_one_current_per_binding
  on clued_private.integration_connections_v1(binding_id) where link_status = 'CURRENT';

-- v0.1.4 (Owner Decision c5574918, MAJOR-N4): explicit Binding ownership. A Binding is owned by exactly one
-- Integration from its first link. Every connection row (CURRENT or HISTORICAL) of a Binding belongs to its
-- owner at the time the row was written; ownership moves only through Owner-native paths (§10.1).
create table clued_private.integration_binding_owners_v1 (
  binding_id uuid primary key,             -- public.clued_agent_bindings(id); no FK (history survives deletion)
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  owner_id uuid not null,                  -- = integrations_v1.owner_id = binding.user_id at acquisition
  acquired_via text not null check (acquired_via in
    ('FIRST_LINK','NATIVE_OWNER_CONFIRMED','NATIVE_ADOPT','NATIVE_RESTORE','NATIVE_RECONCILE',
     'OPERATOR_RESTORE','REVOCATION_SWEEP')),   -- v0.1.5: OPERATOR_RESTORE (first ownership only, MINOR-N17),
                                                --         REVOCATION_SWEEP (Owner Decision 1b034f44, MAJOR-N5)
  acquired_receipt_id uuid not null,
  acquired_at timestamptz not null default clock_timestamp(),
  version bigint not null default 1
);
create index integration_binding_owners_v1_by_integration
  on clued_private.integration_binding_owners_v1(integration_id);
-- v0.1.5 (MAJOR-N5): lineage lookups by provider-connection identity
create index integration_connections_v1_by_provider_connection
  on clued_private.integration_connections_v1(provider, provider_connection_id);
-- v0.1.7 (NIT-3): Lin / Lin* traversal
create index integration_connections_v1_by_integration
  on clued_private.integration_connections_v1(integration_id);
create index integrations_v1_by_superseded_by
  on clued_private.integrations_v1(superseded_by_integration_id) where superseded_by_integration_id is not null;

create table clued_private.integration_binding_ownership_log_v1 (   -- append-only; trigger rejects UPDATE/DELETE
  transfer_id uuid primary key default gen_random_uuid(),
  binding_id uuid not null,
  from_integration_id uuid,                -- null for every first ownership (any acquired_via), set only on a transfer
  to_integration_id uuid not null,
  acquired_via text not null,
  actor_kind text not null check (actor_kind in ('binding','native_session','operator')),
  receipt_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp()
);
```

所有权规则（v0.1.4，Owner Decision `c5574918-936e-4836-a0ba-bfe6696ee450`；v0.1.5 按 Owner Decision `1b034f44-e5b7-414c-a9a1-53b7bf065200` 补全边界；规范性）：

- **定义（v0.1.5，NIT-7）。**“未撤销（non-revoked）”指 Binding 的 `revoked_at is null`；撤销集合**不**按过期筛选（过期但未撤销的 Binding 同样撤销，撤销它无副作用），因此不依赖“过期时间从不被延长”这一仓库现状。“有效（live）”指未撤销、未过期、账户可用，只用于链接 / 转移的前提。
- **O1 唯一所有者。**每个 Binding 至多一个所有者行（主键）。Binding 第一次获得所有者时插入所有者行，`acquired_via` 取建立它的路径（v0.1.5，NIT-4）：Binding 通道链接 → `FIRST_LINK`；`confirm_rebind` → `NATIVE_OWNER_CONFIRMED`；`adopt_binding` → `NATIVE_ADOPT`；Native restore → `NATIVE_RESTORE`；Operator restore → `OPERATOR_RESTORE`；撤销清扫 → `REVOCATION_SWEEP`。首次所有权的日志行 `from_integration_id = null`。从未获得所有者的 Binding 是“未拥有”的。
- **O2 链接前提。**新写入的 connection 行（CURRENT）只能属于其 Binding 在该事务提交时的所有者；连接被 rebind 替换为 HISTORICAL 时所有权**不变**（OQ-13 已裁定：同 client 重新授权不自动撤销旧 Binding，旧 Binding 仍归 I 所有，撤销 I 时一并撤销）。
- **O3 Binding 通道只能链接未拥有的 Binding，或已归目标 Integration 所有的 Binding。**其他情形 → `binding_owned_by_other_integration`（§10.3 第 6' 步，所有 intent，包括 `CREATE_OR_BIND` 的 `CREATE` 与 `BIND_EXISTING`）。因此一个仍有效的旧 Binding 不能自己“分叉”出新的 Integration 来逃避 I 的撤销（MAJOR-N4）。另外（v0.1.5，Owner Decision `1b034f44` 第 1 条 (b)）：未拥有的 Binding 若其授权早于同一 owner、同一 provider-connection 身份的某个 Integration 的撤销时刻，也不能经 Binding 通道链接或创建（`binding_predates_revocation`，O7）。
- **O4 所有权只经 Owner-native 路径转移：**`confirm_rebind`（`NATIVE_OWNER_CONFIRMED`）、`adopt_binding`（`NATIVE_ADOPT`）、Native `restore`（`NATIVE_RESTORE`）、`reconcile`（`NATIVE_RECONCILE`：`REBIND_TO_HOLDER` 移动的 CURRENT Binding，以及 v0.1.5 起被取代一方的全部未撤销 Binding，§10.5）。Operator 路径**从不**转移所有权（v0.1.5，MINOR-N17：Operator restore 只能使用未拥有或已归 I 的 Binding）；撤销清扫只为**未拥有**的 Binding 建立首次所有权，不是转移。单个 Binding 转移的前提：Binding 属于 owner、有效、非 P5，且**不是**原所有者 J 的 CURRENT connection；否则 `binding_owned_by_other_integration`（v0.1.5 NIT-5 hint：“该 Binding 是另一 Integration 的当前连接；先在那个 Integration 上改用其他连接或通过 reconcile 移动，不要撤销它——撤销会一并撤销这个 Binding”）。例外（reconcile）：reconcile 在同一事务内先解除（或移动）被取代一方的 CURRENT connection，再转移；它批量转移的是被取代一方的全部**未撤销** Binding（包括已过期的），不要求“有效”（v0.1.6，NIT-6）——过期但未撤销的 Binding 也必须跟随所有权，否则会落在任何存续方的撤销集合之外。每次转移更新所有者行（`version+1`）、追加 `integration_binding_ownership_log_v1`，并在 Receipt 中记录 `supplemental.ownership_transfer`（单个或列表）`= {binding_id, from_integration_id, to_integration_id, acquired_via}`，`target_refs` 追加 `{role:'ownership_source', kind:'integration', id: from}`。转移后，原所有者 J 上该 Binding 的 HISTORICAL connection 行保留作历史，但不再计入 J 的撤销集合（撤销集合只看所有者行与 O7 的同 client 未拥有集合）。
- **O5 撤销集合（v0.1.5，Owner Decision `1b034f44` 第 1 条 (a)；v0.1.6 MINOR-N18 / N19 修订）。**Integration-level Revocation 撤销 `Owned(I) ∪ UnownedLineage(I, t_cut)`（§10.10）：
  - `Lin(I)` := I 的全部 connection 行（CURRENT 与 HISTORICAL）的 `(provider, provider_connection_id)` 快照中，provider 的 `connection_source = OAUTH_V12_CLIENT_ID_SHA256` 者（raw Binding 的 `provider_connection_id` 就是它自己的 `binding_id`，一旦链接即被拥有，不存在未拥有的同身份 raw Binding）；
  - `Lin*(I)` := `Lin(I) ∪ ⋃ Lin*(Y)`，Y 取遍 `superseded_by_integration_id = I` 的全部 Integration（递归，v0.1.6 MINOR-N19）。终止性（v0.1.7，NIT-3）：Integration 只能在 `historical = NONE` 时被取代，取代后永远是 SUPERSEDED，因此 `superseded_by` 关系构成森林；实现以集合语义的递归 CTE 计算（`UNION` 去重，或 `CYCLE` 子句），**不设深度上限**；二者即使在被篡改成环的数据上也会终止。撤销、清扫与 restore 路径永不因血缘计算失败（v0.1.8，MINOR-N28：删除 v0.1.7 的“深度上限 64，超限按 C7 fail closed”——超过 64 层的取代链是合法数据，C7 是 §7 的派生码，规范化不计算 `Lin*`）。索引：`integrations_v1(superseded_by_integration_id) where superseded_by_integration_id is not null`（向下遍历，计算 `Lin*` 与 `sibling_integration_ids`），`integration_connections_v1(integration_id)`（全部行，读取 `Lin`）。取代只转移所有权、不写 connection 行，被取代一方的历史 client 身份（例如经跨 client `confirm_rebind` 或以另一 client restore 得到的）由此并入存续方的血缘；
  - `Owned(I)` := 所有者行指向 I、`binding.user_id = I.owner_id`、未撤销的 Binding；
  - `UnownedLineage(I, t)` := `user_id = I.owner_id`、未撤销、没有所有者行、非 P5、有 `authorizations_v12` 行且 `(clued.oauth.v12, sha256(client_id)) ∈ Lin*(I)`、且 `authorizations_v12.created_at ≤ t` 的 Binding。截止时间 `t_cut`（v0.1.6，MINOR-N18）：I 已有 open revocation 行或本次调用物化一行时取 `rev_at(I)`（即该行的 `revoked_at`；本调用物化时 `t_cut := row.revoked_at`，按 O7 的统一回退规则，v0.1.7 NIT-2），只有本次调用插入新的 `INTEGRATION_REVOKE` 行时取本次的 `t_rev`——因此重复撤销不会清扫撤销之后作出的新同意（R13、§39 的“新的授权决定”）；
  - `historical = SUPERSEDED` 的 I 取 `UnownedLineage(I) = ∅`：它的全部未撤销 Binding 已在取代时移交给存续方（§10.5，MINOR-N15），它的血缘经 `Lin*` 并入存续方，由存续方的撤销清扫；
  - 清扫的 Binding 在同一事务内插入所有者行（`REVOCATION_SWEEP`，归 I）并撤销；这补全了 OQ-13 裁定的前提——“同 client 的旧 Binding 随 I 一起撤销”——对从未被链接过的旧 Binding 也成立。
  - 兄弟 Integration 的影响（v0.1.6，MINOR-N22）：同一 owner、同一 client 的两个 Integration（S2c 中所有真实 Host 都是 INCOMPLETE，重复的同 client Integration 是预期状态，§6.5）共享同一血缘。撤销其中一个会清扫 `t_cut` 之前、尚未链接的同 client 授权，其中可能包括本来要给兄弟 Integration 的重连（或共享同一 DCR `client_id` 的另一 surface / 设备，R14）。这是 Decision `1b034f44` 允许的 fail-closed 行为；撤销 Receipt 对每个被清扫的 Binding 列出 `sibling_integration_ids`（同 owner、未撤销、`historical = NONE`、`derived(b) ∈ Lin*(X)` 的其他 X），用户可据此在 Host 中重新连接。只想去掉重复 Integration 时，推荐 `pause` 而不是 `revoke`（§6.5）。
- **O6 锁（v0.1.5，NIT-3 收窄）。**所有者行的**写入**，以及据以作出链接 / 转移 / 撤销决定的读取，都必须在持有该 Binding 行 L1 `FOR UPDATE` 时进行（它是 L1 的一部分：先 Binding 行，再其所有者行，同一 Binding 相邻）。只用于展示或诊断的读取（`status.owned_bindings`、规范化 C7、撤销第 0 / 1 步的无锁发现读）不需要 L1；撤销在第 3 步于锁下复核。
- **O7 撤销前的授权不能新建连接（v0.1.5，Owner Decision `1b034f44` 第 1 条 (b)；v0.1.6 MINOR-N19 / NIT-4 修订）。**记 X 的撤销时刻 `rev_at(X)` := X 的 open revocation 行的 `revoked_at`；X 仅由连接撤销派生 REVOKED 时为 `integration_connection_revoke_adoption_v1(X).connection_revoked_at`；后者为 null（Binding 行缺失、尚未物化）时取求值时的 `clock_timestamp()`（NIT-4）。v0.1.7（NIT-2）统一规则：`rev_at(X)` = X 的撤销行的 `revoked_at`（若存在，包括本调用刚物化的行）；否则 = 一次物化此刻会写入的值（`connection_revoked_at`，为 null 时取物化调用的时间戳：撤销调用为其 `t_rev`，其他写为该调用开始时一次取得的时间戳（v0.1.8 NIT-1，同一调用内的 `R` 截止与 `row.revoked_at` 因此相同））。O5 的 `t_cut`、O7 与物化行三处都按此规则取值。Binding 通道上，**未拥有**的调用方 Binding b 若存在 Integration X 满足 `X.owner_id = b.user_id`、`X.historical = NONE`（被取代的 X 的血缘属于存续方，不单独阻断，MINOR-N19）、`integration_revocation_status_v1(X) ≠ NOT_REVOKED`、`derived(b) ∈ Lin*(X)`、且 `b` 的授权创建时间（`authorizations_v12.created_at`）`≤ rev_at(X)`，则任何链接或创建（所有 intent、所有 outcome）→ `binding_predates_revocation`。在撤销之后于同意页上作出的新批准不受影响（基线 §39 的“new authorization decision”）。

由于跨 provider-connection 身份的链接只能经 Owner 在 Native 会话确认（§10.1“Rebind 授权”），而所有权只能经 Owner-native 路径转移，任何 Binding 都不能通过 Binding 通道夺取另一 Host / 另一 OAuth client 的 Integration，也不能把自己或 I 的凭据移出 I 的撤销范围；O5 / O7 使撤销前签发、从未链接过的同 client 凭据也被撤销，且不能再新建 Integration。

旧 Binding 与撤销：被 rebind 替换的旧 Binding 转为 `HISTORICAL`，仍归 I 所有，**不**自动撤销（OQ-13，Owner Decision `c5574918`；Decision `1b034f44` 补全其前提）；Native / Operator 的 Integration-level Revocation 撤销 `Owned(I) ∪ UnownedLineage(I)`；restore 撤销 `Owned(I)` 中除新 Binding 外的全部 Binding（§10.12，MINOR-N16），`restore_kind='REVOCATION'` 时还清扫 `UnownedLineage(I, t_loss)`（v0.1.6 NIT-2 / MINOR-N21）；Binding 通道的 `revoke_self` 按同样方式只作用于与调用方同一 provider-connection 身份的部分，还有其他身份的 Binding 时只做部分撤销并提示 Owner（§10.10）。

### 5.6 规范化事实（Adapter / Operator / Policy 报告的 truth class）

直接来自既有表或 `integrations_v1` 列的 truth class 不在此存储（见 §7.2 来源表）。本表只承载 `environment_state`、`qualification_state`、`compatibility_state`（显式部分）、`host_state`、`adapter_state`。

```sql
create table clued_private.integration_facts_v1 (
  fact_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  truth_class text not null check (truth_class in
    ('environment_state','qualification_state','compatibility_state','host_state','adapter_state')),
  source text not null check (source in ('adapter','operator','policy','server')),
  value text not null,                     -- class-specific enum (§7.2), checked by integration_fact_value_valid_v1
  capability_mask text[],                  -- required for RESTRICTED / CONDITIONAL / DEGRADED values, null otherwise
  reason text check (reason is null or char_length(reason) between 1 and 500),
  valid_until timestamptz,
  fact_status text not null check (fact_status in ('CURRENT','SUPERSEDED','CLEARED')),
  receipt_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp(),
  check (clued_private.integration_fact_value_valid_v1(truth_class, value, capability_mask))
);
create unique index integration_facts_v1_one_current
  on clued_private.integration_facts_v1(integration_id, truth_class, source) where fact_status = 'CURRENT';
```

同一 class 可有多个来源的 current fact。规范化按 §7.2 定义的**单调收窄格**确定性合并（取最受限者），这不是矛盾；同一 `(integration, class, source)` 至多一条 current 行（唯一索引），因此“同一 truth class 同时出现互斥值”在存储层不可能出现【基线 §16.1 第 5 条】。Adapter 来源只能报告收窄值（§10.6 `adapter_report_cannot_expand`）。

### 5.7 Canonical Runtime Baseline Verification（A 类）

```sql
create table clued_private.integration_canonical_verifications_v1 (
  verification_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  verification_contract text not null check (verification_contract = 'clued.crv.v1'),
  verification_class text not null default 'CANONICAL_RUNTIME_BASELINE' check (verification_class = 'CANONICAL_RUNTIME_BASELINE'),
  result text not null check (result in ('PASS','FAIL')),
  checks jsonb not null,                   -- per-check {id, result, evidence_ref}
  subject_digest text not null check (subject_digest ~ '^[0-9a-f]{64}$'),
  connection_id uuid not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_id uuid not null,
  verified_at timestamptz not null default clock_timestamp(),
  valid_until timestamptz not null
);
create index integration_canonical_verifications_v1_latest
  on clued_private.integration_canonical_verifications_v1(integration_id, verified_at desc);
```

### 5.8 READY(profile) Verification（B 类）

```sql
create table clued_private.integration_ready_verifications_v1 (
  verification_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  verification_class text not null default 'READY_PROFILE_VERIFICATION' check (verification_class = 'READY_PROFILE_VERIFICATION'),
  profile_id text not null,
  profile_version integer not null,
  result text not null check (result in ('PASS','FAIL')),
  checks jsonb not null,
  subject_digest text not null check (subject_digest ~ '^[0-9a-f]{64}$'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_id uuid not null,
  verified_at timestamptz not null default clock_timestamp(),
  valid_until timestamptz not null,
  foreign key (profile_id, profile_version) references clued_private.integration_ready_profiles_v1(profile_id, profile_version)
);
create index integration_ready_verifications_v1_latest
  on clued_private.integration_ready_verifications_v1(integration_id, profile_id, profile_version, verified_at desc);
```

分离规则【基线 §16.5、§20、§21、§42 G-A8】：

1. A、B 两类使用不同表、不同写函数、不同 Receipt family；`verification_class` 列以 CHECK 固定，一行不能同时属于两类。
2. `integration_normalize_v1` 与 `integration_derive_v1` 的函数体不得引用 `integration_ready_verifications_v1`、`integration_ready_profiles_v1`（§13.3 T-A8-1 以 `pg_depend` + `prosrc` 扫描 + 变更测试证明）。
3. B 类写函数不得写 A 类表、`integrations_v1`、`integration_facts_v1`、Binding 或 Authorization 表（§13.3 T-A8-2）。
4. C 类（HOST_QUALIFICATION / RELEASE_ACCEPTANCE）不在 S2c 实现；其结果只有在 S3 以 Operator `fact_set`（`qualification_state`）显式写入时，才被 Canonical truth 消费【基线 §21】。

### 5.9 Revocation / Restore / Reauthorization

```sql
create table clued_private.integration_revocations_v1 (
  revocation_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  revoked_by text not null check (revoked_by in ('USER','USER_VIA_HOST','CLUED','POLICY','SECURITY')),
  reason text not null check (char_length(reason) between 1 and 500),
  revoked_binding_ids uuid[] not null,
  -- v0.1.1 (MAJOR-6 / OQ-2 interim): a connection-level revoke observed by normalization (§7.2) is
  -- materialized here by the next successful write that locks the Integration (v0.1.2 MAJOR-N2, §10.10), never by a read
  revocation_source text not null default 'INTEGRATION_REVOKE' check (revocation_source in ('INTEGRATION_REVOKE','CONNECTION_REVOKE_ADOPTED')),
  -- v0.1.2 (MAJOR-N2) / v0.1.3 (MAJOR-N3, MINOR-N10): provenance of the adopted connection revoke, computed by
  -- integration_connection_revoke_adoption_v1 (§10.1), identical at every materialization site:
  -- {binding_id, audit_operation ('revoke'|'revoke_issuer'|'revoke_self'|'revoke_integration'|null), audit_id|null,
  --  revoking_receipt_id|null, connection_revoked_by ('USER'|'USER_VIA_HOST'|'CLUED'|'POLICY'|'SECURITY'),
  --  connection_revoked_at|null}
  adopted_from jsonb,
  receipt_id uuid not null,               -- the Receipt of the write that created (or materialized) the row
  -- CONNECTION_REVOKE_ADOPTED: revoked_at := adopted_from.connection_revoked_at (v0.1.3 MINOR-N10), never the
  -- materializing transaction's time (except the anomalous missing-Binding case, §10.1)
  revoked_at timestamptz not null default clock_timestamp(),
  restored_by_regrant_id uuid,
  extended_receipt_ids uuid[] not null default '{}',   -- v0.1.3 (NIT-2): Receipts of later superset extensions
  check ((revocation_source = 'CONNECTION_REVOKE_ADOPTED') = (adopted_from is not null))
);
-- v0.1.2 (MAJOR-N2) / v0.1.3 (NIT-2): a before-update trigger allows exactly two kinds of UPDATE, never combined:
--  (a) restore: restored_by_regrant_id null → value, every other column unchanged;
--  (b) extension: requires OLD.restored_by_regrant_id is null and NEW.restored_by_regrant_id is null;
--      revoked_binding_ids := a strict superset and extended_receipt_ids := OLD.extended_receipt_ids || {the extending
--      Receipt}; every other column (integration_id, revoked_by, reason, revoked_at, revocation_source, adopted_from,
--      receipt_id, restored_by_regrant_id) unchanged (§10.10 step 5; v0.1.4 NIT-3 freezes the full list).
-- every other UPDATE and every DELETE is rejected (integration_revocation_immutable).
-- revoked_by / receipt_id keep the first creator; who extended the row is recorded only through extended_receipt_ids
-- and those Receipts' actors. An extension never moves revoked_at, so it never moves restore's t_loss (§10.12).
create unique index integration_revocations_v1_one_open
  on clued_private.integration_revocations_v1(integration_id) where restored_by_regrant_id is null;

create table clued_private.integration_regrants_v1 (
  regrant_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  -- v0.1.1 (MINOR-7): restore also closes a FORBIDS_REAUTH credential loss, which has no revocation row
  restore_kind text not null check (restore_kind in ('REVOCATION','FORBIDS_REAUTH_RECOVERY')),
  revocation_id uuid references clued_private.integration_revocations_v1(revocation_id),
  new_binding_id uuid not null,
  -- v0.1.1 (MINOR-2): authorization_requests_v12 has no created_at; the "new decision" time is
  -- authorizations_v12.created_at (OAuth v12) or clued_agent_bindings.created_at (raw Binding)
  new_authorization_request_id uuid,       -- provenance only: authorizations_v12.request_id (OAuth v12)
  new_authorization_created_at timestamptz not null,
  decided_by text not null check (decided_by in ('USER','OPERATOR')),
  receipt_id uuid not null,
  regranted_at timestamptz not null default clock_timestamp(),
  check ((restore_kind = 'REVOCATION') = (revocation_id is not null))
);

create table clued_private.integration_reauth_marks_v1 (
  mark_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  reason text not null check (reason in ('SCOPE_RECONSENT_REQUIRED','PROVIDER_RECONFIRMATION','CREDENTIAL_INVALIDATED',
    'HOST_SESSION_INVALIDATED','POLICY_RECONSENT')),
  raised_by text not null check (raised_by in ('CLUED','POLICY','SECURITY','SERVER')),
  raised_receipt_id uuid not null,
  raised_at timestamptz not null default clock_timestamp(),
  cleared_at timestamptz,
  cleared_by text check (cleared_by is null or cleared_by in ('REAUTHORIZATION_REBIND','OPERATOR','RESTORE')),  -- RESTORE: v0.1.2 MINOR-N2
  cleared_receipt_id uuid,
  check ((cleared_at is null) = (cleared_receipt_id is null))
);
```

`revocation_state = REVOKED` ⇔ 存在 `restored_by_regrant_id is null` 的行，**或**（OQ-2 保守临时规则，v0.1.2 按 MAJOR-N1 更正）current connection 的 Binding 已被撤销（`revoked_at` 非空或行缺失），无论撤销来自 Clued 连接管理页、Host 的 RFC 7009 断开、凭据持有者自撤，还是无法归因的路径（§7.2 `revocation_source = CONNECTION_USER_REVOKE`）。两个判定由同一个 `clued_private.integration_revocation_status_v1(integration_id)` 计算，规范化与写路径守卫共用它（v0.1.2 MINOR-N8）。任何路径都不能通过删除行或清除 reauth mark 解除 REVOKED；解除只能写 `integration_regrants_v1`（§10.12）【基线 §39】。

### 5.10 能力声明（Host Capability Model 运行时部分 + 按 Integration 的声明）

```sql
create table clued_private.integration_capability_declarations_v1 (
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  declaration_version integer not null check (declaration_version >= 1),
  host_surface text not null,
  declared_capabilities text[] not null,   -- ⊆ surface capability_ceiling (else rejected)
  host_features jsonb not null,            -- ⊆ registry host_features (a host may report fewer, never more)
  adapter_family text not null,
  adapter_version text not null,
  package_version text,
  receipt_id uuid not null,
  declared_at timestamptz not null default clock_timestamp(),
  primary key (integration_id, declaration_version)
);
```

Host 能力项 = `surface.capability_ceiling ∩ latest.declared_capabilities`。无声明时【提议】取 `surface.capability_ceiling`（Preserve），见 OQ-10。声明只能收窄：`declared_capabilities ⊄ capability_ceiling` → `capability_declaration_exceeds_ceiling`【基线 §11、§17：Host Adapter 只能 Preserve or Narrow】。声明不改变 Authorization；声明中超出授权范围的能力不会进入 Candidate Set（交集），也不会触发 REAUTH_REQUIRED（§9.2 注 3）。

### 5.11 运维与证据

```sql
create table clued_private.integration_operation_log_v1 (   -- §14.3 provenance, one row per create/bind/rebind/merge/claim op
  operation_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  actor_kind text not null check (actor_kind in ('binding','native_session','operator','server')),
  actor_binding_id uuid,
  request_id uuid,
  integration_id uuid,
  related_integration_id uuid,             -- conflicting / superseded / holder
  affected_binding_ids uuid[] not null default '{}',   -- v0.1.3 (MAJOR-N3): Bindings revoked by a REVOKE / PARTIAL_REVOKE /
                                                       -- RESTORE_SWEEP / RECONCILE_REVOKE row (v0.1.6 NIT-7)
  operation_type text not null,            -- CREATE / BIND_EXISTING / REBIND / RECLAIM / CLAIM_CONFLICT / RECONCILE / SUPERSEDE /
                                           -- REVOKE / PARTIAL_REVOKE / RESTORE_SWEEP / RECONCILE_REVOKE (v0.1.6) / ...
  identity_snapshot_id uuid,
  source_provenance jsonb not null,
  callback_provenance jsonb,
  result text not null,
  receipt_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp()
);

create table clued_private.integration_derivation_diagnostics_v1 (
  diagnostic_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null,
  derivation_contract text not null,
  facts_sha256 text not null check (facts_sha256 ~ '^[0-9a-f]{64}$'),
  reason_codes text[] not null check (cardinality(reason_codes) >= 1),
  receipt_id uuid not null,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  occurrences bigint not null default 1,
  unique (integration_id, derivation_contract, facts_sha256)
);
```

### 5.12 设置

S2c 不新增运行时设置表。所有策略都在 `integration_policy_v1` 中版本化，并通过 facts 文档（§7.1 `policy`）进入派生，使 `integration_derive_v1` 保持纯函数。

### 5.13 权限

- 表：全部 `revoke all from public, anon, authenticated, service_role`；RLS 启用、无 policy。
- `clued_private.*` 函数：全部 `revoke all ... from public, anon, authenticated, service_role`。
- **S2c 迁移不授予任何 public RPC 的 EXECUTE**（v0.1.1，MINOR-11 / OQ-21 默认）：S2c 新建的 public RPC 在创建后执行 `revoke all ... from public, anon, authenticated, service_role`，flag off 期间无法经 PostgREST 调用。下面三条是**目标 grant**，由开启 flag 的阶段授权随附的单独迁移施加；S2c 测试在测试库中以同样语句显式授予（§13.0）：
  - Binding 路径 public RPC：`grant execute ... to anon, authenticated`（与 `clued_record_mutate` 等一致；由函数内的 token 哈希认证）。
  - Native 路径 public RPC：只 `grant execute ... to authenticated`，函数首行调用 `clued_private.authorization_owner_v12()`。
  - Operator 路径 public RPC：只 `grant ... to authenticated`，首行调用 `authorization_owner_v12()` 并校验 `platform_admin_v13`。
- 全部 `security definer set search_path=''`。`integration_derive_v1`、`integration_candidate_v1`、`integration_facts_validate_v1` 为 `language plpgsql immutable security invoker`，不读表。

### 5.14 Public 视图

【提议】S2c 不创建 public 视图。所有读取经 RPC（§10.9、§10.13），避免 invoker 视图对 private 表授权和 RLS 泄漏。

### 5.15 既有 Binding 的迁移策略

【基线 §43 + `apps/clued-cloud/AGENTS.md` 第 3 条“不得静默批量提升”精神 + 提议】

1. **迁移应用时不创建任何 Integration。**迁移后 `integrations_v1` 为空，无论存在多少 Binding（§13.7 T-S-4）。
2. 采纳只能是逐个 Binding、显式、带 Receipt 的动作：
   - (a) Binding 自身调用 `clued_integration_create_or_bind_v1`（Agent 主动安装）；
   - (b) Owner 在 Native 会话中调用 `clued_user_integration_v1{op:'adopt_binding'}`，逐个指定 Binding 与 `host` / `surface`。
3. 既有 `vendor`、`agent_name`、`client_name` 只作为展示 provenance 保存于 `source_provenance`，**不得**作为任何身份维度或 claim key 输入（弱标识）【基线 §14.4、§15.1】。
4. 已撤销或已过期的 Binding 不能被采纳（`binding_not_adoptable`）。P5 租户 Binding（`organization_id is not null`，含 `role='denied'`）在 S2c 同样不可采纳，也不能作为 create_or_bind 的调用方（`binding_not_adoptable`）：其 `organization_id` / `workspace_id` / `revocation_epoch` / `canonical:*` / `project:*` scope 语义属于 P5 租户模型，S2c 规范化不解释它们（v0.1.1，MINOR-1）。P5 的 `workspace_id` 是 OQ-4 中可评估的“可验证租户来源”候选。
5. 未采纳的 Binding 行为完全不变：`clued_integration_status_v1` 对其返回 `{integration: null, reason: 'NOT_ADOPTED'}`，既有工具照常工作。“无 Integration 的 Binding 何时不再允许普通运行时”不属 S2c（OQ-16）。
6. 只读清点：`clued_user_integration_v1{op:'binding_inventory'}` 列出未采纳的有效 Binding，不写任何行。

---

## 6. Identity Tuple 与 Identity Claim

### 6.1 维度与三态

【基线 §15.1】正式 Tuple：`clued_principal_id × host × host_tenant_or_workspace_id × host_account_id × provider × provider_connection_id`。Claim Key 另加 `active_binding_domain`【基线 §14.4】。

每个可空维度以三态表示【提议，依基线 §15 字段注释】：

| 状态 | 含义 | 对完整性 |
|---|---|---|
| `VALUE` | 有值，且证据种类在注册表的可接受列表内（§6.2） | 计为已确定 |
| `NOT_APPLICABLE` | 注册表声明该 Host / Provider **不存在**此概念（`*_dimension='NOT_APPLICABLE'`） | 计为已确定 |
| `UNAVAILABLE` | 概念存在但当前无法获得可验证值 | 使 Identity 为 `INCOMPLETE` |

- `clued_principal_id`、`host`、`provider` 永远必填，不存在三态。`provider` 不得因 Host 与 Provider 同名而省略【基线 §15.1】。
- 调用方不能自行声明 `NOT_APPLICABLE`：它只能来自注册表。注册表声明 `REQUIRED` 而调用方给出 `NOT_APPLICABLE` → `identity_dimension_not_applicable_mismatch`。
- `identity_completeness = COMPLETE` ⇔ 三个可空维度都不是 `UNAVAILABLE`（由 §5.2 CHECK 约束强制）。

### 6.2 强标识与弱标识

1. 可接受证据种类（`evidence_kind`）【提议】：
   - `OAUTH_V12_CLIENT_ID`：服务端从 `authorizations_v12.client_id` 读取，`provider_connection_id = sha256(client_id)`（provider `clued.oauth.v12`）；
   - `BINDING_ID`：服务端从调用方 Binding 读取，`provider_connection_id = binding_id::text`（provider `clued.binding.v1`）；
   - `HOST_SIGNED_ASSERTION:<scheme>`：S2c 不接受任何 scheme；注册表为空（OQ-4）。
2. `provider_connection_id` **只能由服务端**从调用方凭据推导；调用方提交的值与服务端推导值不一致 → `identity_dimension_evidence_unverified`。
3. 弱证据种类的封闭清单：`EMAIL`、`DISPLAY_NAME`、`HOST_UI_LABEL`、`VENDOR_LABEL`、`AGENT_NAME`、`CLIENT_NAME`、`UNVERIFIED_HOST_ASSERTION`。提交这些种类 → `identity_weak_identifier_forbidden`。对这些种类的值不做任何相似性比较，也不自动 merge【基线 §14.4、§15.1】。
4. 调用方提交的 `host_tenant_or_workspace_id` / `host_account_id`，若证据种类不在注册表列表中，必须记为 `UNAVAILABLE`（原值只进入 `source_provenance`，不进入 Tuple）。

结果：S2c 中接入真实 Anthropic / OpenAI Host 的 Integration 通常处于 `INCOMPLETE_UNCLAIMED`，直到 S3 找到可验证的账户 / 租户来源。这是基线允许的“保持显式分离”【基线 §14.4】，见风险 R1 与 OQ-4。

### 6.3 Claim Key

```text
claim_key_material = canonical_json({
  "schema": "clued.integration-claim-key.v1",
  "clued_principal_id": <uuid>,
  "host": <text>,
  "host_tenant_or_workspace_id": <text> | {"status":"NOT_APPLICABLE"},
  "host_account_id": <text> | {"status":"NOT_APPLICABLE"},
  "provider": <text>,
  "provider_connection_id": <text> | {"status":"NOT_APPLICABLE"},
  "active_binding_domain": <text>
})
claim_key_sha256 = lower(hex(sha256(utf8(claim_key_material))))
```

`canonical_json` 使用 PostgreSQL `jsonb::text`（键排序确定），由 `clued_private.integration_claim_key_v1(...) immutable` 计算。只有 `COMPLETE` 的 Identity 才计算 key；`UNAVAILABLE` 维度永远不以占位值参与 key【基线 §14.4】。

### 6.4 Claim 操作的原子性与锁顺序

全局锁顺序【约定：沿用 v12 “Binding → Authorization → Context”并扩展】：

```text
L1 public.clued_agent_bindings            FOR UPDATE / FOR SHARE（按 id 排序），每个 Binding 行之后紧接其
   integration_binding_owners_v1 行 FOR UPDATE（v0.1.4，§5.5 O6）
L2 clued_private.authorizations_v12       FOR UPDATE / FOR SHARE
L3 integration_installation_requests_v1   FOR UPDATE
L4 pg_advisory_xact_lock(hashtextextended('clued.integration.claim:'||domain||':'||claim_key_sha256, 0))
   多个 key 时按 (domain, claim_key_sha256) 字典序依次加锁
L5 integrations_v1                        FOR UPDATE（按 integration_id 排序）
L6 integration_claims_v1 / integration_connections_v1
```

**L4 永远先于 L5（v0.1.1，MINOR-5）。**任何可能调用 claim 核心的操作（create_or_bind 各 intent、identity_update、reconcile、adopt_binding、confirm_rebind、restore）都按以下前置步骤取锁，不存在“先锁 I 再取 L4”的路径，从而消除 L4/L5 逆序导致的 `40P01` 死锁：

```text
pre-1. unlocked read of I (and of the holder / other party, if any): old key K0, key-relevant columns, version
pre-2. compute the new key K from that read + the operation input (null if the resulting identity is INCOMPLETE)
pre-3. lock L4 for {K0, K, key of the other party} \ {null}, sorted by (domain, claim_key_sha256)
pre-4. lock L5 for I (and the other party), sorted by integration_id
pre-5. re-read under L5; if version or any key-relevant column changed since pre-1
       → integration_version_conflict (40001, retryable; no business write)
```

Claim 算法（被 create-or-bind、identity_update、reconcile、adopt_binding 复用，函数 `clued_private.integration_claim_core_v1`；调用时 pre-1…pre-5 已完成，核心函数自身不再取 L4）：

```text
input: integration I (locked, L5), new key K (or null; L4 already held), domain D
1. if K is null:                                  -- identity incomplete
     release I's CURRENT claim if any (status RELEASED); I.identity_claim_state := INCOMPLETE_UNCLAIMED
     (only allowed when the tuple legitimately lost a dimension through explicit rebind; see §10.4)
2. assert L4(K) (and L4(old key)) are held by this transaction (else raise; programming error)
3. H := CURRENT holder of (D, K)
4. case
   H is null:
     release I's old CURRENT claim (if any, key ≠ K) → RELEASED
     insert CURRENT claim (D, K, I); I.claim_key_sha256 := K; I.identity_claim_state := CURRENT_CLAIM_HOLDER
   H = I:                                          -- idempotent
     no claim change; write new identity snapshot + receipt
   H ≠ I:
     I keeps no CURRENT claim for K; I.claim_key_sha256 := K;
     I.identity_claim_state := CLAIM_CONFLICT; I.conflicting_integration_id := H
     (I's old claim for a different key, if any, is released in the same transaction)
5. all of the above happen in one transaction; the deferred consistency trigger (§5.4) validates at commit
```

唯一索引 `integration_claims_v1_one_current_per_key` 是 L4 之外的后备保证；若仍遇 `23505`，核心函数重读 holder 并按第 4 步重新判定一次，第二次仍冲突则 `raise 'identity_claim_retry_exhausted' using errcode='40001'`。H ≠ I 时核心函数只读取 H、不对 H 加 L5：对 K 的 claim 变化已由 L4(K) 串行化，而 `CLAIM_CONFLICT` 只写 I。需要同时修改 H 的操作（reconcile、create_or_bind 的 `BIND_EXISTING`）在 pre-1 就把 H 作为 other party 纳入 L5 排序。

### 6.5 Claim 状态机

```text
INCOMPLETE_UNCLAIMED ──(identity becomes COMPLETE, key free)──────────────▶ CURRENT_CLAIM_HOLDER
INCOMPLETE_UNCLAIMED ──(identity becomes COMPLETE, key held by H≠I)────────▶ CLAIM_CONFLICT
CURRENT_CLAIM_HOLDER ──(legal rebind changes key; new key free)────────────▶ CURRENT_CLAIM_HOLDER (atomic release+claim)
CURRENT_CLAIM_HOLDER ──(legal rebind changes key; new key held)────────────▶ CLAIM_CONFLICT (old key released in same tx)
CLAIM_CONFLICT       ──(binding asks reconcile; awaiting owner)────────────▶ PENDING_RECONCILE
CLAIM_CONFLICT / PENDING_RECONCILE ──(owner: REBIND_TO_HOLDER)──────────────▶ SUPERSEDED (connection moves to H)
CLAIM_CONFLICT / PENDING_RECONCILE ──(owner: REPLACE_HOLDER)────────────────▶ CURRENT_CLAIM_HOLDER; H → SUPERSEDED (same tx)
CURRENT_CLAIM_HOLDER ──(replaced by another integration via REPLACE_HOLDER)─▶ SUPERSEDED
SUPERSEDED           ── terminal for ordinary runtime; no transition back to runtime-capable states
```

- 不存在“按 email / display name 选赢家”的路径；赢家只能是既有 holder（默认）或 Owner 在 Native 会话中显式选择【基线 §14.5】。
- `SUPERSEDED` 必须同时写 `historical='SUPERSEDED'` 与 `superseded_by_integration_id`（§5.2 CHECK），即基线要求的“受控 lifecycle truth”【基线 §15.2】。实现层不使用 `REPLACED`；若将来引入，也必须在规范化中映射到 `SUPERSEDED`。
- `CLAIM_CONFLICT` 与 `PENDING_RECONCILE` 都保留 `conflicting_integration_id`（§5.2 CHECK，基线 §14.5 要求保留 conflicting integration ref）；进入 `SUPERSEDED` 后以 `superseded_by_integration_id` 记录去向。
- v0.1.1 起 `PENDING_RECONCILE` / `SUPERSEDED` 只存在于 `COMPLETE` 身份上（§5.2 CHECK）。S2c 不提供合并两个 INCOMPLETE Integration 的操作（原 OQ-19 撤销）；重复的 INCOMPLETE Integration 由 Owner 暂停或撤销其一；v0.1.6（MINOR-N22）推荐 `pause`：撤销会按 §5.5 O5 清扫同 client、尚未链接的授权，可能包括给另一个重复 Integration 的进行中的重连（撤销 Receipt 以 `sibling_integration_ids` 列出）。若后续阶段需要显式合并，须新增带 Receipt 的 merge 操作并修订本节。

---

## 7. Canonical Truth Normalization

### 7.1 Facts 文档 `clued.integration-facts.v1`

`clued_private.integration_normalize_v1(p_integration_id uuid, p_as_of timestamptz) returns jsonb`（`stable security definer`）读取 §7.2 的来源，输出：

```json
{
  "schema": "clued.integration-facts.v1",
  "derivation_contract": "clued.integration-derivation.v1",
  "as_of": "2026-09-24T12:00:00Z",
  "policy": { "policy_version": 1, "incomplete_identity_ordinary_runtime": "PERMIT",
              "qualification_not_evaluated": "NON_BLOCKING", "preclusion_rule": "ALL_BLOCKING_PREDICATES" },
  "capability_universe": ["audit.read","context.read","context.write","development_history.read",
                          "evidence.write","project.read","project.write"],
  "identity_state": "VALID",
  "identity_completeness": "COMPLETE",
  "identity_claim_state": "CURRENT_CLAIM_HOLDER",
  "claim_store": "CONSISTENT",
  "authentication_state": "USABLE",
  "authorization_state": "GRANTED",
  "reauth_marks_open": 0,
  "oauth_scope_facts": ["context:read","context:write"],
  "resource_action_scope_facts": { "mode": "ENTRIES", "capabilities": ["context.read","context.write","project.read"] },
  "environment_state": { "value": "AVAILABLE", "mask": null },
  "qualification_state": { "value": "NOT_EVALUATED", "mask": null },
  "compatibility_state": { "value": "COMPATIBLE", "mask": null },
  "revocation_state": "NOT_REVOKED",
  "revocation_source": "NONE",
  "host_state": { "value": "AVAILABLE", "mask": null, "surface_ceiling": ["..."], "declared": ["..."] },
  "adapter_state": { "value": "OK", "mask": null },
  "lifecycle_facts": { "ordinary_runtime": "PERMITTED", "historical": "NONE",
                       "recovery_policy": "PERMITS_REAUTH", "first_authorization_required": true },
  "installation_facts": { "install_status": "COMPLETED", "ever_authorized": true },
  "canonical_runtime_verification_facts": { "status": "VALID", "verification_id": "…", "valid_until": "…" }
}
```

规则：

1. 所有集合按字典序排序、去重；枚举值为大写常量。`facts_sha256 = sha256((facts - 'as_of')::text)`：**哈希输入是去掉 `as_of` 的规范投影**（v0.1.1，MAJOR-3）。时间谓词在规范化时已折叠为枚举值（规则 3），`as_of` 本身不影响派生，因此两次读取只要折叠后的 truth 相同，`facts_sha256` 就相同；诊断去重键 `(integration_id, contract, facts_sha256)` 与“`facts_sha256` 不变”类测试依赖这一点。`as_of` 仍出现在 facts 文档与输出中，仅供审计。
2. facts 文档**不含**任何 READY profile、READY verification、Required Capability Profile 或 UI READY 字段。`integration_facts_validate_v1` 对出现未知顶层键的文档返回 `C1_SCHEMA_INVALID`，因此即使调用方伪造文档，READY 字段也无法进入派生【基线 §16：不得进入 derivation input】。
3. 时间相关谓词（过期、TTL）在规范化时以 `as_of` 求值并写成枚举值；`integration_derive_v1` 本身不读时钟。因此“同一 facts + 同一 contract → 同一 state”是逐字节可复验的【基线 §16.3 第 3 条】。

### 7.2 各 truth class 的来源与规范值域

| truth class | 来源（读） | 规范值域 | 多来源合并 / 说明 |
|---|---|---|---|
| `identity_state` | `auth.users`（`deleted_at`、`banned_until`，同 `authorization_account_v12`）；current connection Binding 的 `user_id = integrations_v1.owner_id` | `VALID` / `INVALID` | 任一失败 → `INVALID` |
| `identity_completeness` | `integrations_v1` 三个维度状态 | `COMPLETE` / `INCOMPLETE` | — |
| `identity_claim_state` | `integrations_v1.identity_claim_state` | 5 值【基线 §15.2】 | — |
| `claim_store` | `integration_claims_v1` 与上行比对 | `CONSISTENT` / `MISSING_CURRENT_ROW` / `UNEXPECTED_CURRENT_ROW` / `KEY_MISMATCH` | 非 `CONSISTENT` 即 C4/C5 |
| `authentication_state` | current connection 的 Binding：无 current connection → `NONE`；Binding `revoked_at` 非空或行缺失 → `INVALIDATED`（v0.1.2：此时 `revocation_state` 同为 REVOKED，§8.4 优先）；Binding 或 `authorizations_v12.expires_at <= as_of` → `EXPIRED`；否则 `USABLE` | `NONE` / `USABLE` / `EXPIRED` / `INVALIDATED` | — |
| `authorization_state` | `authorizations_v12`：无 current connection → `NOT_GRANTED`；按 current connection 的 `connection_kind` 分类（v0.1.3，NIT-7；不按“是否存在 v12 行”推断）：`RAW_BINDING` → `GRANTED_LEGACY`；`OAUTH_V12` 但 v12 行缺失（Binding 删除时级联删除）→ `REVOKED_CONNECTION`；`revoked_at` 非空 → `REVOKED_CONNECTION`；`expires_at <= as_of` → `EXPIRED`；否则 `GRANTED` | `NOT_GRANTED` / `GRANTED` / `GRANTED_LEGACY` / `EXPIRED` / `REVOKED_CONNECTION` | Authentication 与 Authorization 分列【基线 §16.1 第 1 条】 |
| `reauth_marks_open` | `integration_reauth_marks_v1` 中 `cleared_at is null` 的行数 | 整数 ≥ 0 | — |
| `oauth_scope_facts` | current Binding `scopes` ∩ `{context:read, context:write, audit:read}` | ⊆ `{context:read, context:write, audit:read}` | 无连接 → `[]`。v0.1.1（MINOR-1）：非 P5 Binding 上的 `canonical:*` / `project:*` 被丢弃（只收窄，不产生 capability；丢弃列表记入 `sources_read`）；P5 租户 Binding 不可能成为 connection（§5.15 第 4 条） |
| `resource_action_scope_facts` | 委托 OAuth（`connection_kind='OAUTH_V12'`）：`authorization_entries_v12` 的 actions 经 scope map 映射，v12 行缺失 → `{"mode":"NONE"}`；raw Binding（`RAW_BINDING`）：`{"mode":"LEGACY_UNRESTRICTED"}` | `{mode: ENTRIES, capabilities: [...]}` / `{mode: LEGACY_UNRESTRICTED}` / `{mode: NONE}` | raw Binding 沿用“显式既有授权”，请求级检查仍在真实调用时执行【基线 §17 末段】 |
| `environment_state` | `integration_facts_v1`（operator / policy） | `AVAILABLE` / `RESTRICTED{mask}` / `BLOCKED` | 格：`AVAILABLE < RESTRICTED < BLOCKED`；多个 RESTRICTED 取 mask 交集 |
| `qualification_state` | `integration_facts_v1`（operator；S3 写入） | `NOT_EVALUATED` / `QUALIFIED` / `CONDITIONAL{mask}` / `SUSPENDED` | 无 fact → `NOT_EVALUATED`；格：`QUALIFIED < NOT_EVALUATED < CONDITIONAL < SUSPENDED` |
| `compatibility_state` | `integration_compatibility_rules_v1`（§5.1，按 host + adapter_family 取最新 `registry_version`）与 `adapter_version` / `package_version` 比较 + `integration_facts_v1` 显式 fact | `COMPATIBLE` / `DEGRADED{mask}` / `HARD_INCOMPATIBLE` | 格：取最受限 |
| `revocation_state` / `revocation_source` | `integration_revocation_status_v1(id)`（v0.1.2，MINOR-N8；写路径守卫调用同一函数）：(1) `integration_revocations_v1` 是否有未恢复行 → `INTEGRATION`；(2) OQ-2 保守临时规则（v0.1.2 按 MAJOR-N1 更正）：current connection 的 Binding `revoked_at` 非空或行已缺失 → `CONNECTION_USER_REVOKE`，**不看**撤销类审计行的 `operation`。仓库事实：`'revoke'` 来自 Clued 连接管理页（`/oauth/connections/api` → `clued_authorization_manage_v12`）；`'revoke_issuer'` 只来自 Worker 对 RFC 7009 撤销请求（`POST /oauth/token`，带 `token`、无 `grant_type`，provider 已校验撤销客户端凭据及其对该 token 的所有权）的处理，即 Host 侧“断开连接”（`apps/clued-cloud/worker/delegated-oauth.ts` `revocationStorage` → `revokeIssuedBinding`）；`'revoke_self'` Worker 从不调用，只能由持有 token 哈希者直接调用 PostgREST；`'revoke_integration'` 来自本规格 §10.10；无审计行 = 无法归因 | `NOT_REVOKED` / `REVOKED`；source `NONE` / `INTEGRATION` / `CONNECTION_USER_REVOKE` | (1) 优先。审计行只用于物化时记录 provenance（§5.9 `adopted_from`，由 §10.1 的 `integration_connection_revoke_adoption_v1` 计算：`'revoke'` / 无法归因 → `USER`；`'revoke_issuer'` / `'revoke_self'` → `USER_VIA_HOST`；`'revoke_integration'` → 取撤销它的 `integration_revoke` Receipt 的 actor，v0.1.3 MAJOR-N3），不影响派生。只有 `expires_at` 过期与 open reauth mark 走 `credential_lost` → REAUTH_REQUIRED；连接撤销需要显式 restore（§10.12），普通 OAuth rebind 不能清除（§10.3 第 6 步）。审计行无法区分“用户在 Host 中断开”与“Host 的例行撤销”，见 OQ-2 |
| `host_state` | `integration_facts_v1`（adapter / operator）+ 注册表 `capability_ceiling` + 最新声明 | `AVAILABLE` / `DEGRADED{mask}` / `HARD_UNAVAILABLE`，附 `surface_ceiling`、`declared` | 格：取最受限 |
| `adapter_state` | `integration_facts_v1` | `OK` / `DEGRADED{mask}` / `BLOCKED` | 格：取最受限 |
| `lifecycle_facts` | `integrations_v1.ordinary_runtime / historical / recovery_policy / first_authorization_required` | 见 §5.2 | — |
| `installation_facts` | `integrations_v1.install_status`、`first_authorized_at is not null` | `install_status ∈ {PENDING, COMPLETED}`、`ever_authorized: bool` | — |
| `canonical_runtime_verification_facts` | 最新 A 类行（§5.7）与当前 subject digest（§7.4） | `NONE` / `VALID` / `EXPIRED` / `FAILED` / `INVALIDATED` | 无行 → `NONE`；最新行 FAIL → `FAILED`；`subject_digest` 不等 → `INVALIDATED`；`valid_until <= as_of` → `EXPIRED`；否则 `VALID` |

`capability_universe` 取自当前词表版本。`host_state.surface_ceiling` 与 `declared` 在规范化时已解析为集合，使派生不读注册表。

### 7.3 矛盾输入 → `DERIVATION_INPUT_INVALID`

`clued_private.integration_facts_validate_v1(facts jsonb) returns text[]`（immutable）返回原因码；非空即无效【基线 §16.1】：

| 码 | 条件 |
|---|---|
| `C1_SCHEMA_INVALID` | 缺少必需键、出现未知键、枚举值不在值域、集合元素不在词表、mask 要求缺失 |
| `C2_COMPLETE_BUT_UNCLAIMED` | `identity_completeness = COMPLETE ∧ identity_claim_state = INCOMPLETE_UNCLAIMED` |
| `C3_INCOMPLETE_BUT_CLAIM_STATE` | `identity_completeness = INCOMPLETE ∧ identity_claim_state ≠ INCOMPLETE_UNCLAIMED`（v0.1.1 随 §5.2 CHECK 收紧） |
| `C4_CLAIM_STORE_MISSING` | `identity_claim_state = CURRENT_CLAIM_HOLDER ∧ claim_store ∈ {MISSING_CURRENT_ROW, KEY_MISMATCH}` |
| `C5_CLAIM_STORE_UNEXPECTED` | `identity_claim_state ≠ CURRENT_CLAIM_HOLDER ∧ claim_store = UNEXPECTED_CURRENT_ROW` |
| `C6_SUPERSEDED_LIFECYCLE_MISMATCH` | `(identity_claim_state = SUPERSEDED) ≠ (lifecycle_facts.historical = SUPERSEDED)` |
| `C7_CONNECTION_CARDINALITY` | 规范化观察到多于一个 current connection，或 connection 指向他人 Binding，或（v0.1.4）current connection 的 Binding 没有所有者行 / 所有者不是本 Integration |
| `C8_AUTH_WITHOUT_EVER_AUTHORIZED` | `authentication_state = USABLE ∧ authorization_state ∈ {GRANTED, GRANTED_LEGACY} ∧ installation_facts.ever_authorized = false` |
| `C9_CONTRACT_UNKNOWN` | `derivation_contract`、`policy_version` 或 `schema` 未知 |
| `C10_AUTHZ_WITHOUT_AUTHN` | `authentication_state = NONE ∧ authorization_state ≠ NOT_GRANTED`（或反之） |

处理【基线 §16.1】：

```text
DERIVATION_INPUT_INVALID
→ integration_state = null（不是一个新状态）
→ integration_operable = false
→ candidate = ∅，effective = ∅，READY(any profile) = false
→ 在 integration_derivation_diagnostics_v1 中 upsert 一行，并在首次出现时写 M1 Receipt
   （family integration_derivation_invalid，按 (integration_id, contract, facts_sha256) 去重）
→ 写路径：使 Integration 由有效变为无效、或引入新 reason code 的变更被拒绝（`derivation_input_invalid`，§10.1 写后有效性门）；
   revoke 永不因此被拒绝；不增加 reason code 的修复操作允许提交
```

### 7.4 Subject digest

```text
subject_digest = sha256(canonical_json({
  "integration_id", "current_connection_id", "binding_id",
  "adapter_family", "adapter_version", "package_version",
  "claim_key_sha256" (or null), "host_surface" (latest declaration),
  "derivation_contract"
}))
```

A 类与 B 类验证都把 subject digest 记在验证行上。任一输入变化（rebind、reauth、升级、身份变化）都使既有验证 `INVALIDATED`，从而把 Integration 送回 `VERIFYING`，而不是 `INSTALL_PENDING`【基线 §14.2、§37】。

---

## 8. 状态派生

### 8.1 枚举（固定）【基线 §16.2】

```text
INSTALL_PENDING  INSTALLED  AUTH_PENDING  VERIFYING  ACTIVE
DEGRADED  BLOCKED  REAUTH_REQUIRED  INCOMPATIBLE  REVOKED
```

`DERIVATION_INPUT_INVALID` 是派生失败，不是状态。

### 8.2 函数

```sql
clued_private.integration_derive_v1(p_facts jsonb) returns jsonb
  language plpgsql immutable security invoker set search_path=''
```

输出：

```json
{ "valid": true, "reason_codes": [], "derivation_contract": "clued.integration-derivation.v1", "facts_sha256": "…",
  "predicates": { "identity_claim_blocks_ordinary_runtime": false, "verification_precluded_by_blocking_fact": false,
                  "verification_eligible": true, "blocking": [], "degradation": [], "credential_lost": false,
                  "reauth_recoverable": true },
  "candidate_ordinary_capabilities": ["context.read","context.write","project.read"],
  "integration_state": "ACTIVE", "integration_operable": true,
  "effective_capabilities": ["context.read","context.write","project.read"] }
```

`clued_private.integration_evaluate_v1(p_integration_id uuid, p_as_of timestamptz default clock_timestamp())` = `integration_derive_v1(integration_normalize_v1(id, as_of))`，外加无效时的诊断写入（因此为 volatile）。

输出字段（v0.1.2，MINOR-N8，规范性）：

- `valid`、`reason_codes`（有效时 `[]`，无效时为 §7.3 码的有序集合，非空）、`derivation_contract`、`facts_sha256`、`predicates`、`candidate_ordinary_capabilities`、`integration_state`（无效时 null）、`integration_operable`、`effective_capabilities`；
- `integration_evaluate_v1` 另附 `facts`：规范化后的完整 facts 文档（§7.1）。facts 由规范化逐项计算，**即使**校验失败也存在；写路径守卫不得从 `integration_state` / `predicates` 推断撤销（无效时它们为 null / 空），而是调用 `integration_revocation_status_v1`（§5.9、§7.2）。§10.1“写后有效性门”的 `R0` / `R1` 就是两次求值的 `reason_codes`。

### 8.3 谓词（`clued.integration-derivation.v1`）

记 `f` 为已通过 §7.3 校验的 facts。

```text
complete        := f.identity_completeness = COMPLETE
claim_block     := f.identity_claim_state ∈ {CLAIM_CONFLICT, PENDING_RECONCILE, SUPERSEDED}
                   ∨ (complete ∧ f.identity_claim_state ≠ CURRENT_CLAIM_HOLDER)          -- 【基线 §16.3】原文
claim_permits   := ¬claim_block ∧ (complete ? f.identity_claim_state = CURRENT_CLAIM_HOLDER
                                            : f.policy.incomplete_identity_ordinary_runtime = PERMIT)
authn_ok        := f.authentication_state = USABLE
authz_ok        := f.authorization_state ∈ {GRANTED, GRANTED_LEGACY} ∧ f.reauth_marks_open = 0
auth_ok         := authn_ok ∧ authz_ok
installed       := f.installation_facts.install_status = COMPLETED
ever_auth       := f.installation_facts.ever_authorized
credential_lost := ever_auth ∧ ¬auth_ok
lifecycle_ok    := f.lifecycle_facts.ordinary_runtime = PERMITTED ∧ f.lifecycle_facts.historical = NONE
-- v0.1.1 (MAJOR-2): a historical (SUPERSEDED) Integration has no reauthorization path (§15.2, §10.3 step 6)
reauth_recoverable := f.lifecycle_facts.recovery_policy = PERMITS_REAUTH ∧ f.lifecycle_facts.historical = NONE
cand            := Candidate(f, claim_permits, authn_ok, authz_ok)                      -- §9.2

-- non-reauth blocking predicates (versioned list; order irrelevant)
B1_identity_claim     := claim_block
B2_identity_invalid   := f.identity_state = INVALID
B3_lifecycle          := ¬lifecycle_ok
B4_qualification      := f.qualification_state.value = SUSPENDED
                         ∨ (f.qualification_state.value = NOT_EVALUATED ∧ f.policy.qualification_not_evaluated = BLOCKING)
B5_host               := f.host_state.value = HARD_UNAVAILABLE
B6_adapter            := f.adapter_state.value = BLOCKED
B7_environment        := f.environment_state.value = BLOCKED
B8_candidate_empty    := installed ∧ auth_ok ∧ cand = ∅                                  -- phase-qualified, see OQ-1
B9_unrecoverable_auth := credential_lost ∧ ¬reauth_recoverable
blocked               := B1 ∨ … ∨ B9

-- preclusion_rule = ALL_BLOCKING_PREDICATES (policy v1; OQ-8)
verification_precluded_by_blocking_fact := blocked
verification_eligible := installed ∧ auth_ok ∧ ¬claim_block ∧ ¬verification_precluded_by_blocking_fact
                         ∧ lifecycle_ok ∧ f.host_state.value ≠ HARD_UNAVAILABLE ∧ f.adapter_state.value ≠ BLOCKED
crv_valid             := f.canonical_runtime_verification_facts.status = VALID
degraded              := f.host_state.value = DEGRADED ∨ f.adapter_state.value = DEGRADED
                         ∨ f.compatibility_state.value = DEGRADED ∨ f.qualification_state.value = CONDITIONAL
                         ∨ f.environment_state.value = RESTRICTED
```

`verification_precluded_by_blocking_fact`、`verification_eligible` 是派生谓词，不是 truth source，任何 RPC 都不能写入【基线 §16.3】。由定义直接得到 `precluded ⇒ ¬eligible`。

### 8.4 优先级与选择（全函数）

```text
integration_state :=
  REVOKED          if f.revocation_state = REVOKED
  INCOMPATIBLE     elif f.compatibility_state.value = HARD_INCOMPATIBLE
  REAUTH_REQUIRED  elif credential_lost ∧ reauth_recoverable
  AUTH_PENDING     elif installed ∧ f.lifecycle_facts.first_authorization_required ∧ ¬ever_auth
  VERIFYING        elif verification_eligible ∧ ¬crv_valid
  BLOCKED          elif blocked
  DEGRADED         elif installed ∧ cand ≠ ∅ ∧ lifecycle_ok ∧ crv_valid ∧ degraded
  ACTIVE           elif installed ∧ cand ≠ ∅ ∧ lifecycle_ok ∧ crv_valid
  INSTALLED        elif installed
  INSTALL_PENDING  otherwise
```

与基线逐条对照【基线 §16.3 第 1–10 条】：

| 状态 | 基线谓词 | 本规格实现 |
|---|---|---|
| REVOKED | Integration-level Revocation 已执行 | `revocation_state = REVOKED`：open revocation 行（§5.9），**或**（OQ-2 临时规则，偏离字面谓词，待 Owner 裁定）current connection 的 Binding 已被连接级撤销（§7.2 `CONNECTION_USER_REVOKE`）。基线 §16.3 的字面谓词只覆盖前者；后者把用户在 Host / Clued 连接管理页的断开视为 §39 的“user performs … revocation”（v0.1.3，NIT-5） |
| INCOMPATIBLE | hard compatibility failure | `compatibility_state = HARD_INCOMPATIBLE` |
| REAUTH_REQUIRED | 未 revoked / incompatible；既有 Authn/Authz 不可继续使用；Policy 允许恢复 | `credential_lost ∧ PERMITS_REAUTH ∧ historical = NONE`（`credential_lost` 要求曾经授权过；SUPERSEDED 的历史对象没有恢复路径，落入 `B9` → BLOCKED，v0.1.1 MAJOR-2） |
| AUTH_PENDING | 已到授权阶段，首次 Authn/Authz 未完成 | `installed ∧ first_authorization_required ∧ ¬ever_auth` |
| VERIFYING | `verification_eligible` ∧ Canonical 验证未完成 / 失效 / 过期 / 恢复中 | 同左；`FAILED` 也视为未完成（OQ-9） |
| BLOCKED | 任一 non-reauth blocking predicate | `B1…B9` |
| DEGRADED | Candidate≠∅ ∧ lifecycle 允许 ∧ 验证有效 ∧ degradation predicate | 同左 |
| ACTIVE | Candidate≠∅ ∧ lifecycle 允许 ∧ 验证有效 ∧ 无更高谓词 | 同左 |
| INSTALLED | 已安装，未进入确定的首次授权或验证阶段 | `installed` 且以上皆否 |
| INSTALL_PENDING | 已绑定 `integration_id`，安装未完成 | 兜底分支 |

### 8.5 全函数性与确定性论证

1. **恰好一个状态：**对每个通过 §7.3 的 facts，if-chain 的每个条件都是 facts 上的全定义布尔式，且最后一支无条件；故恰好命中一个分支【基线 §16.1 Totality】。
2. **VERIFYING 与 BLOCKED 互斥且无漂移：**`VERIFYING` 要求 `verification_eligible`，而后者要求 `¬precluded = ¬blocked`。因此 `blocked` 为真时 `VERIFYING` 谓词为假，结果不依赖求值顺序【基线 §16.3 第 6、7 条】。
3. **不会错误提升：**`DEGRADED` / `ACTIVE` 分支只在 `¬blocked` 时可达，而 `B4/B5/B6/B8` 覆盖“Qualification suspended / Host hard-unavailable / Adapter blocked / Candidate 为空”【基线 §16.3 第 8 条】。
4. **不掩盖 AUTH_PENDING / VERIFYING / BLOCKED：**`INSTALLED` 分支在这三者之后。
5. **Profile 无关：**facts 模式禁止 READY 字段（§7.1 规则 2），函数签名只接受 facts。
6. **确定性：**函数为 `immutable`，不读时钟与表；集合已规范排序；输出以 `jsonb` 规范化。

`credential_lost` 时状态只能是 REVOKED / INCOMPATIBLE / REAUTH_REQUIRED（`reauth_recoverable`）或 BLOCKED（`B9`，含 SUPERSEDED）：`AUTH_PENDING` 要求 `¬ever_auth`，`VERIFYING` 要求 `auth_ok`，二者都与 `credential_lost` 矛盾。

`installed ∧ auth_ok ∧ ¬blocked` 时有 `cand ≠ ∅`（否则 `B8`），所以 `crv_valid` 时必落在 `ACTIVE` / `DEGRADED`，`¬crv_valid` 时必落在 `VERIFYING`。`INSTALLED` 只在 `installed ∧ ¬auth_ok ∧ ¬ever_auth ∧ ¬first_authorization_required ∧ ¬blocked` 时可达（注册表 `first_authorization_required=false` 的 Host；S2c 仅测试 Host）。

### 8.6 SQL 权威，不设 TypeScript 镜像

- 派生、候选能力、Operability、READY 投影**只**在 SQL 中实现。Worker 只转发数据库结果，不重新计算。
- 若将来 UI / 离线工具需要 TypeScript 镜像，它必须是生成物或以提交的 golden vector 文件（§13.2 P5）逐项比对，并作为 Core-Origin Projection 登记（S2b / S4 范围）。S2c 不创建镜像，以免出现第二个语义实现。

---

## 9. Capability

### 9.1 词表与 scope 映射 v1

词表【基线 §17 示例】：`context.read`、`context.write`、`audit.read`、`project.read`、`project.write`、`evidence.write`、`development_history.read`。

Scope → Capability（`integration_scope_capability_map_v1`, `map_version=1`）【提议，OQ-11】：

| OAuth scope | v12 resource action | capability |
|---|---|---|
| `context:read` | `read` | `context.read`、`project.read`、`development_history.read` |
| `context:write` | `write` | `context.write`、`project.write`、`evidence.write` |
| `audit:read` | `audit` | `audit.read` |

委托 OAuth 的 resource 掩码：某 capability 被允许，当且仅当至少一条 `authorization_entries_v12` 的 actions 含映射 action；`development_history.read` 还要求至少一条 `resource_kind='context'` 的 `read` 条目；`project.*` 要求至少一条 `resource_id` 以 `project:` 开头的 scope 条目。`close` / `restore` / `feedback_submit` 不单独产生 capability。

### 9.2 Candidate Ordinary Capability Set【基线 §17】

```text
Candidate(f) =
    U                                              -- f.capability_universe
  ∩ (f.identity_state = VALID              ? U : ∅)   -- Clued Identity validity
  ∩ (claim_permits                         ? U : ∅)   -- Stable Identity Claim permits ordinary runtime
  ∩ (authn_ok                              ? U : ∅)   -- Authentication usability
  ∩ ScopeCaps(f.oauth_scope_facts)                    -- OAuth Scope
  ∩ (authz_ok                              ? U : ∅)   -- Authorization
  ∩ ResourceCaps(f.resource_action_scope_facts)       -- Resource / Action / Scope (LEGACY_UNRESTRICTED → U; NONE → ∅)
  ∩ EnvCaps(f.environment_state)                      -- Environment (AVAILABLE → U; RESTRICTED → mask; BLOCKED → ∅)
  ∩ PolicyCaps(f)                                     -- Policy / Hard Constraints (PAUSED_BY_POLICY → ∅; else U)
  ∩ HostCaps(f.host_state)                            -- surface_ceiling ∩ declared; HARD_UNAVAILABLE → ∅; DEGRADED → ∩ mask
  ∩ AdapterCaps(f.adapter_state)                      -- OK → U; DEGRADED → mask; BLOCKED → ∅
  ∩ QualCaps(f.qualification_state)                   -- QUALIFIED → U; NOT_EVALUATED → policy; CONDITIONAL → mask; SUSPENDED → ∅
  ∩ CompatCaps(f.compatibility_state)                 -- COMPATIBLE → U; DEGRADED → mask; HARD_INCOMPATIBLE → ∅
  ∩ (f.revocation_state = NOT_REVOKED      ? U : ∅)   -- Revocation permits access
```

注：

1. Candidate 不读取任何 Required Capability Profile 或 READY 验证【基线 §17】。
2. 当完整 Claim Key 已确定时，只有 `CURRENT_CLAIM_HOLDER` 保留 candidate；`CLAIM_CONFLICT / PENDING_RECONCILE / SUPERSEDED` 一律归零【基线 §17、§42 G-A3 第 6 条】。
3. 声明或升级请求超出现有授权的能力只会被交集去掉，不会自动触发 REAUTH_REQUIRED【提议，依基线 §38“普通版本升级不应无意义地让用户反复 OAuth”】。
4. Lifecycle 的 owner 暂停不在 Candidate 中，而在 Operability 与 `B3` 中生效；policy 暂停同时在 `PolicyCaps` 中归零（两处都会导致 Operable=false）。

### 9.3 Host Capability Model（运行时）

- 上界：`integration_host_surfaces_v1.capability_ceiling`；Integration 声明只能收窄（§5.10）。
- Host features（`hooks`、`subagents`、`skills` 等）是 Host Capability Facts，只供 READY profile 在 S3 使用（例如 Cowork / Claude Code 专属 profile）；**不**进入 Candidate，**不**影响 `integration_state`【基线 §24.1、§42 G-E 第 4 条精神】。
- 注册表行携带 `capability_snapshot_ref`；Host 事实变化通过新注册表版本迁移体现，不修改 Core 语义【基线 §2.4、§55.1】。

### 9.4 Operability 与 Ordinary Effective Capability Set【基线 §16.6、§17】

```text
Operable  := cand ≠ ∅ ∧ lifecycle_ok ∧ crv_valid ∧ integration_state ∈ {ACTIVE, DEGRADED}
Effective := Operable ? cand : ∅
```

由 §8.4 可得（并由 §13 性质测试验证）：

```text
Operable = true  ⇒ Effective ≠ ∅
Operable = false ⇒ Effective = ∅
state ∈ {ACTIVE, DEGRADED} ⇒ Operable = true ⇒ Effective ≠ ∅
state ∈ {INSTALL_PENDING, INSTALLED, AUTH_PENDING, VERIFYING, BLOCKED, REAUTH_REQUIRED, INCOMPATIBLE, REVOKED} ⇒ Operable = false
```

Effective Capability 不是预授权缓存：既有请求级 Resource / Action / Scope 检查（`resolve_binding`、`authorization_assert_entry_v12`）在每次真实调用时照常执行【基线 §17 末段】。安装、OAuth、验证、恢复等 bootstrap / repair 操作走 §10 中的独立受限 RPC，不属于 ordinary capability【基线 §16.6】。

### 9.5 READY(profile) 投影【基线 §20】

`clued_private.integration_ready_project_v1(p_integration_id uuid, p_profile_id text, p_profile_version int, p_as_of timestamptz)`：

```text
e := integration_evaluate_v1(id, as_of)                -- Canonical, profile-independent
P := integration_ready_profiles_v1[profile_id, version] -- missing → ready_profile_unknown
r := latest integration_ready_verifications_v1 for (id, profile_id, version)
READY(profile) :=
     e.valid
   ∧ e.integration_operable
   ∧ P.required_capabilities ⊆ e.effective_capabilities
   ∧ (P.required_qualification = ANY ∨ facts.qualification_state = QUALIFIED)
   ∧ r exists ∧ r.result = PASS
   ∧ r.subject_digest = current subject_digest ∧ r.valid_until > as_of      -- freshness / compatibility
   ∧ r.receipt_id exists in clued_audit_receipts ∧ r.evidence_sha256 present -- evidence / receipt present
output: { ready: bool, reasons: [...], integration_state, effective_capabilities,
          canonical_verification_id, ready_verification_id, facts_sha256, profile: {id, version} }
```

- 函数只读 Canonical 结果与 B 类表，**不写**任何 Canonical 表；`BLOCKED / VERIFYING / AUTH_PENDING / REAUTH_REQUIRED / INCOMPATIBLE / REVOKED` 时 `Operable=false`，因此 READY 必为 false。
- 同一 `integration_state` 对不同 profile 可以得到不同 READY 结果；更换 profile 不改变 `integration_state`（§13.3 T-A8-3）。
- 投影 Receipt：调用方可请求 `emit_receipt=true`，在同一请求内写 family `integration_ready_projection` 的 Receipt，内容绑定上面的输出摘要。它就是 S3 所需“同一请求的服务端 READY 回执”（Task 6a515e68）的机制；S2c 不宣称任何生产 profile READY。

---

## 10. 操作（RPC）

### 10.1 公共约定

**授权通道**

| 通道 | 入口形态 | 认证 | 主体 |
|---|---|---|---|
| Binding | `public.clued_integration_<op>_v1(p_token_hash text, p_input jsonb)`，grant `anon, authenticated` | 在事务内按 `token_hash` 锁定并校验 Binding（未撤销、未过期、账户可用）；委托 OAuth 另校验 `authorizations_v12` | Binding 的 `user_id`；actor = Binding |
| Native account session | `public.clued_user_integration_v1(p_input jsonb)`（`op` 分派），grant `authenticated` | `clued_private.authorization_owner_v12()`（直接人类会话，JWT 无 `client_id`） | owner；actor = native_session |
| Operator | `public.clued_admin_integration_v1(p_input jsonb)`，grant `authenticated` | `authorization_owner_v12()` + `platform_admin_v13` 成员资格 | 目标 Integration 的 owner；actor = operator（代表 CLUED / POLICY / SECURITY） |

- Binding 通道**不能**跨 owner：所有 Integration 查找都附带 `owner_id = binding.user_id`；查不到与不属于统一报 `integration_not_owned`（42501，HTTP 403，不泄露存在性）。
- 需要“本 Integration 的 current connection”才可执行的 Binding 操作（`declare`、`report`、`verify`、`status`、`revoke_self`），调用方 Binding 不是 current connection 时报 `integration_connection_required`（42501，403）。
- **授权检查的位置（v0.1.1，MINOR-4）：**调用方认证（Binding / `authorization_owner_v12` / `platform_admin_v13`）、`integration_not_owned`、`integration_connection_required`、`binding_not_owned` 在同一事务内、**`m1_begin_receipt` 之前**执行，以 `42501` 抛出，经 PostgREST 成为 HTTP 403，不写 Receipt。M1 核心的 `exception when others` 会把 Receipt 块内抛出的 `42501` / `40001` / `22023` / `23505` 落为 `rejected` envelope（HTTP 200），因此任何需要 403 的检查都不得放在 Receipt 块内。进入 Receipt 块后，核心函数以已持有的锁复核同一条件；复核失败（并发变化）属于规则拒绝。
- 旧式 Supabase OAuth JWT 的 `clued_oauth_call` 路径已被 v12 退役，S2c 不为其增加分派。

**Rebind 授权（v0.1.1，MAJOR-1）**

`REBIND_CLASS = {REBIND, REAUTHORIZATION, REINSTALL, RECOVERY, ADAPTER_MIGRATION, VERIFICATION_REPAIR, BIND_CONNECTION}`。经 Binding 通道对既有 Integration T 执行 REBIND_CLASS 时：

```text
R := T 的 reference connection
     = T 的 CURRENT connection；没有则取 unlinked_at 最新的 HISTORICAL connection；都没有则 R = ∅
始终要求：Request.host = T.host（否则 integration_host_mismatch；任何通道都不能覆盖，host 是不可变 Tuple 维度）
且以下之一成立：
 (a) SELF                     调用方 Binding = R.binding_id
 (b) SAME_PROVIDER_CONNECTION 调用方派生的 (provider, provider_connection_id) = (R.provider, R.provider_connection_id)，
                              且 provider.connection_source = OAUTH_V12_CLIENT_ID_SHA256（即同一 v12 client_id）；
                              clued.binding.v1 下 provider_connection_id = binding_id，只有 (a) 可能成立
 (c) NATIVE_BIND_REQUEST      R = ∅（T 从未有过任何连接）∧ intent = BIND_CONNECTION
                              ∧ Request.created_via = 'native_session' ∧ Request.target_integration_id = T
                              ∧ (Request.expected_provider_connection_id is null
                                 ∨ 调用方派生的 provider_connection_id = Request.expected_provider_connection_id)
                              （Owner 已在 Native 会话中为 T 打开绑定 Request；不存在可被夺取的既有凭据）
否则 → integration_rebind_requires_owner_confirmation（规则拒绝，无业务写入）
```

`NATIVE_BIND_REQUEST` 的持有者约束（v0.1.2，MINOR-N6）：

- Native 打开 `bind_connection` Request 时可以给出 `expected_provider_connection_id`（对 `clued.oauth.v12` 为 `sha256(client_id)`；存于 `request_payload`，参与 `request_payload_sha256`）。给出时，只有该 OAuth client 的 Binding 能消费该 Request；不符 → `integration_rebind_requires_owner_confirmation`。S6 Connect 在已知 client 时**必须**给出；S2c 中为可选；
- 未给出时，`request_id` 就是单次使用的 bearer secret：只在 Native 打开响应中返回一次；不出现在任何 Binding 通道的 status / list、operation log 的 Binding 可见投影或错误 hint 中；Request 在首次 BOUND 后不可再被其他 Binding 使用（§5.3 第 2 条）；TTL 取 `installation_request_ttl`。

Owner 确认路径：Native `clued_user_integration_v1{op:'confirm_rebind', request_id, binding_id, base_version, idempotency_key}`（`base_version` 为目标 Integration 的 CAS 版本；family `integration_create_or_bind`），由服务端以指定 Binding 作为 connection 执行 §10.3（`link_authority='NATIVE_OWNER_CONFIRMED'`），语义与 `adopt_binding` 相同；`binding_id` 必须属于 owner、有效、非 P5，且未被拥有、已归 T 所有，或可按 §5.5 O4 从另一 Integration 转移（不是其 CURRENT connection）。`CREATE_OR_BIND` 以完整 key 命中 holder（`BIND_EXISTING`）时，调用方的 `provider_connection_id` 与 host 都是 key 的组成部分，因此 (b) 自动成立。

**写后有效性门（v0.1.1，MAJOR-4）**

每个写操作在取得锁之后、业务变更之前求 `e0 := integration_evaluate_v1(I)`（新建 Integration 的 `e0` 视为有效、reason 集为 ∅），业务变更之后在同一事务内求 `e1`。令 `R0`、`R1` 为两者的 `reason_codes` 集合（有效时为 ∅）：

- `revoke`（Native / Binding `revoke_self` / Operator）**永不**因 `R1` 被拒绝：撤销只增加 fail-closed 事实，基线 §39 要求其无条件执行（v0.1.2 起 revoke 也不做 CAS，见下文“CAS”）；
- 其他写操作只在 `R1 ≠ ∅ ∧ R1 ⊄ R0` 时拒绝——即“有效 → 无效”或引入新的 reason code——以 `derivation_input_invalid` rejected Receipt 返回（带 `reason_codes`），业务行回滚到子事务之前；
- 因此修复类操作（`reconcile`、`restore`、`fact_clear`、`lifecycle`、`reauth_clear`、`identity_update`、`recovery_policy`）在 `R1 ⊆ R0` 时允许提交，即使 `R1` 仍非空（逐步修复）；
- `R1 ≠ ∅` 时照常按 §7.3 upsert 诊断。

**连接撤销的物化（v0.1.2，MAJOR-N2；v0.1.3 按 MAJOR-N3、MINOR-N10、NIT-3 修订）**

`integration_revocation_status_v1(I)` 返回 `CONNECTION_USER_REVOKE`（current connection 的 Binding 已撤销，但没有 open revocation 行）时，任何**成功提交**、并对 I 取得 L5 的写操作，在做自己的业务变更之前，于同一事务内先插入 I 的 `integration_revocations_v1` 行。每个物化点（本段、§10.10 第 5 步、§10.12 restore）都调用同一个 `clued_private.integration_connection_revoke_adoption_v1(I)` 计算这一行，因此行内容与由哪个写首先物化无关（v0.1.3，MINOR-N10）：

```text
b := current connection Binding of I
audit := latest authorization_audit_v12 row with binding_id = b and operation ∈ {'revoke','revoke_issuer','revoke_self','revoke_integration'}
adopted_from.binding_id          := b
adopted_from.audit_operation     := audit.operation | null ; adopted_from.audit_id := audit.id | null
adopted_from.connection_revoked_by :=
    'revoke'                 → USER
    'revoke_issuer' | 'revoke_self' → USER_VIA_HOST
    'revoke_integration'     → from the revoking Receipt (v0.1.3 MAJOR-N3): the integration_operation_log_v1 row with
                               operation_type = 'PARTIAL_REVOKE' and b ∈ affected_binding_ids gives its receipt_id
                               (→ adopted_from.revoking_receipt_id); its actor is always the Binding channel → USER_VIA_HOST
                               -- v0.1.4 (NIT-2): the only reachable case. b is I's current connection and therefore owned by I
                               -- (§5.5 O2), so only I's own revoke can have revoked it; a full revoke (Native / Operator /
                               -- revoke_self) always writes a revocation row, which integration_revocation_status_v1 finds
                               -- first, so no materialization happens. The former "operator → revoked_by" branch is removed.
    no audit row             → USER (unattributable)
adopted_from.connection_revoked_at := audit.recorded_at, else clued_agent_bindings.revoked_at of b,
                                      else null (the Binding row is missing: anomalous, only reachable out of band)
row.revoked_by := adopted_from.connection_revoked_by
row.revoked_at := adopted_from.connection_revoked_at; only when it is null, the materializing call's timestamp
                  (a revoke: its t_rev; any other write: its call timestamp, taken once at the start of the call — v0.1.8 NIT-1)
                  — v0.1.7 NIT-2, the single fallback rule
row.revoked_binding_ids := [b] (§10.10 step 5 adds S1; §10.5 REPLACE_HOLDER rule 2 inserts [b_H] ∪ R — v0.1.8 NIT-2)
```

物化行的 `revoked_at` 因此是连接真正被撤销的时间，restore 的 `t_loss`（§10.12）不会因为某个无关的写（例如 Operator `policy_pause`）先物化而后移。行缺失时的回退值使 `t_loss` 取物化时间，这是更严格的一侧（只会拒绝更多的旧授权），记为已知限制。

多方操作（reconcile 的 H）对每个被锁定、且处于 `CONNECTION_USER_REVOKE` 的 Integration 同样处理。之后派生 REVOKED 不再依赖“当前 connection 是谁”。`revoke`（全部通道）、`restore` 与 reconcile `REPLACE_HOLDER` 规则 2 不走这里的单独物化，而是把物化行直接作为自己的撤销行（§10.10 第 5 步、§10.12、§10.5 规则 2；v0.1.8 NIT-2）。

执行物化的写必须在其 Receipt 的 `target_refs` 中列出 `{role:'revocation', kind:'integration_revocation', id: <revocation_id>}`，并在 `supplemental.outcome_flags` 中加入 `REVOCATION_MATERIALIZED`（v0.1.3，NIT-3）。

被拒绝的写（rejected Receipt）其子事务回滚，不留下物化行。这是安全的：被拒绝的写不改变任何状态，而派生的 REVOKED 在 current connection 不变时稳定；能改变 current connection 的路径都对 REVOKED 拒绝，或先物化再继续：§10.3 link（第 6 步拒绝）、§10.5 `REBIND_TO_HOLDER`（v0.1.3 起 I 与 H 都必须 NOT_REVOKED，否则拒绝）、§10.12 restore（先物化）。v0.1.4（所有权模型）：一个 Integration 的撤销只触及它自己拥有的 Binding（§5.5 O5），而另一个 Integration 的 current connection 归那个 Integration 所有（O2），因此一个 Integration 的派生 REVOKED 只能来自针对它自己的 current connection 的撤销。

**Binding 通道的认证与 L1（v0.1.4，MINOR-N13；取代 v0.1.3“链接路径的 L1”）**

- Integration 的 Binding 通道 RPC **不得**调用 `clued_private.resolve_binding` / `resolve_binding_action_v12`（它们对 Binding 行取 `FOR SHARE`，之后再取 `FOR UPDATE` 就是锁升级；同一 Binding 的两个并发调用会互相等待对方释放 SHARE 而 `40P01`）。
- 写 RPC（`create_or_bind`、`identity_update`、`reconcile_request`、`declare`、`report`、`verify`、`revoke_self`）按以下方式认证，对调用方 Binding 行只取**一次** `FOR UPDATE`：
  1. 无锁按 `token_hash` 查出调用方 `binding_id` 与操作所需的其他 Binding id（例如 `revoke_self` 的 S0，§10.10）；
  2. 把调用方与这些 Binding 合在一起，按 `id` 排序一次性取 `FOR UPDATE`（L1，含所有者行），然后取 L2；
  3. 在锁下复核调用方：`token_hash` 仍匹配、未撤销、未过期、账户可用（`authorization_account_v12`）、委托 OAuth 的 `authorizations_v12` 未撤销未过期；失败 → `binding_not_authorized`（42501，仍在 `m1_begin_receipt` 之前）。
  这与既有 `clued_authorization_revoke_self_v12` 的做法一致（一次 `for update` 查 token 行）。读 RPC（`status`）只取一次 `FOR SHARE`，从不升级。
- 每个会建立 connection 或转移所有权的路径（§10.3 的 Binding 调用方、`confirm_rebind`、`adopt_binding`、§10.12 restore 的 `new_binding_id`、§10.5 `REBIND_TO_HOLDER` 移动的 Binding）都在任何 L4 / L5 之前对该 Binding 行及其所有者行取 L1 `FOR UPDATE`。因此 §10.10 持有 L1 的 Binding 在撤销事务结束前既不能被链接，也不能被转移所有权。rebind 使旧 CURRENT connection 转为 HISTORICAL 时**不**需要锁旧 Binding：所有权不变（§5.5 O2），它仍在 I 的撤销集合中（v0.1.4 NIT-1 由此消失）。

**幂等与 Receipt**【约定：M1 Receipt core】

- 每个写操作都要求 `idempotency_key`（8–160 字符），调用 `m1_begin_receipt(user, binding, family, input, received_payload_hash)`：同 key 同 payload 重放返回原 Receipt 的 `canonical_result`（`replayed: true`）；同 key 不同 payload → `IDEMPOTENCY_KEY_CONFLICT`（rejected Receipt）。
- 业务写入、`integration_operation_log_v1`、identity snapshot、Event（若启用，见 OQ-15）与 `m1_finish_receipt` 处于**同一事务**。核心函数以 M1 模式在 `exception when others` 中把规则失败落为 `status='rejected'` 的 Receipt（带 `error_code`），把非规则失败落为 `failed`；两者都不产生业务状态变化。
- 每个写操作结束前都在同一事务内调用 `integration_evaluate_v1`，并按上文“写后有效性门”判定是否拒绝（v0.1.1 起不再拒绝一切无效结果）。
- Receipt `target_refs` 至少含 `{role:'primary', kind:'integration', id}`；涉及 Request、holder、冲突方时追加 `{role:'request'|'holder'|'conflict'|'superseded', …}`。

**CAS**

- `integrations_v1.version` 是 Integration 的 CAS 版本；除下列例外外，所有改变 Integration 的操作都必须提供 `base_version`，不等时拒绝为 `integration_version_conflict`。例外（v0.1.2，MINOR-N1）：
  - **Binding 通道的 `create_or_bind`（含全部 REBIND_CLASS）与 `adopt_binding`** 不接受 `base_version`：CAS 主语是 Request（L3，`OPEN ∧ bound_integration_id is null`），并在 §6.4 pre-5 于 L5 下复核 key 相关列与 `version`（自 pre-1 起有变化 → `integration_version_conflict`）。`confirm_rebind` 由 Owner 基于看到的状态确认，**要求** `base_version`；
  - **`revoke`（全部通道）** 不接受 `base_version`：撤销是单调的（只增加 fail-closed 事实），不能因并发的普通写被拒绝；并发安全由 L5 与 L5 下的连接集重读保证（§10.10 第 2–3 步）。传输（v0.1.1，MINOR-4）：私有核心以 `40001` 抛出；在 Receipt 块内被 M1 处理器落为 `rejected` envelope（`error_code='integration_version_conflict'`，HTTP 200），Worker 渲染为 `{status:'rejected', error:{code, category:'conflict', retryable:true}}`，REST 返回 409；若在 Receipt 块外抛出，public wrapper 按 `20260824123000_map_optimistic_conflicts_to_http_409` 约定捕获 `serialization_failure` 且 `sqlerrm` 为已知冲突码时改抛 `23505`，由 PostgREST 映射为 HTTP 409。`40001` 本身不会被 PostgREST 映射为 409。
- Installation Request 使用 `request.version`（open 之后的 close / archive 需要 `base_version`）。
- `bind` 类操作以 `request_id` 作为 CAS 主语：绑定只能在 `request_status='OPEN'` 且 `bound_integration_id is null` 时发生（行锁 L3）。

**返回体**：统一为 M1 envelope（`status, target_refs, committed_versions, canonical_version, event_ids, evidence_ids, error_code, receipt_id, replayed`）加 `supplemental`（例如 `integration_id`、`outcome`、`evaluation`）。

### 10.2 Installation Request 打开

`public.clued_integration_request_open_v1(p_token_hash, p_input)`；Native：`clued_user_integration_v1{op:'request_open'}`。

| 项 | 规定 |
|---|---|
| 输入 | `request_key`、`intent`、`target_integration_id?`、`host`、`host_surface`、`provider?`（仅 Native 打开的 `create_or_bind` Request 必填且必须已注册，v0.1.1 MINOR-9；Binding 打开时忽略，provider 由服务端从调用方凭据推导）、`tenant{status,value?,evidence_kind?}`、`account{…}`、`adapter_family`、`adapter_version`、`package_version?`、`installation_phase ∈ {STARTED, COMPLETED}`、`source_provenance`、`callback_provenance?`、`expected_provider_connection_id?`（仅 Native 打开的 `bind_connection` Request，§10.1，v0.1.2 MINOR-N6） |
| 授权 | Binding：任何有效、非 P5 的 Binding（可用于自身安装）。Native：owner。`target_integration_id` 必须属于同一 owner。**打开 Request 不授予 rebind 权力**：以 REBIND_CLASS intent 消费 Request 时另按 §10.1“Rebind 授权”判定（MAJOR-1） |
| 幂等 | `(owner_id, request_key)` 唯一：同 key 同 payload 返回既有 `request_id`；同 key 不同 payload → `installation_request_key_conflict` |
| Receipt | **不写** Receipt（Request 是 transient，不改变 Canonical 状态）；Request 行自身保存 provenance。【提议，与 IF 确认令牌签发不写 Receipt 的先例一致】 |
| 过期 | `expires_at = now + policy.installation_request_ttl` |
| 不变量 | 不创建 Integration，不写任何 truth class |

### 10.3 Create-or-bind（原子、并发安全）

`public.clued_integration_create_or_bind_v1(p_token_hash, p_input)`；Native：`clued_user_integration_v1{op:'create_or_bind'}`（只允许 `intent='create_or_bind'`，创建无连接的 Integration，供 S6 Connect 与 AUTH_PENDING 路径使用）与 `{op:'confirm_rebind'}`（§10.1）。

Native `create_or_bind`（无连接，v0.1.1 MINOR-9）：`provider := Request.provider`（必填、已注册）；`connection_status := 'UNAVAILABLE'`（`provider.connection_dimension = 'REQUIRED'`）或 `'NOT_APPLICABLE'`；因此 Integration 在首次 `BIND_CONNECTION` 前为 INCOMPLETE（除非 provider 声明 NOT_APPLICABLE）。之后的 `BIND_CONNECTION`：调用方派生的 provider 必须等于 `T.provider`（否则 `integration_provider_mismatch`），`connection_status` 由 `UNAVAILABLE` 变为 `VALUE`（`provider_connection_id` 由服务端推导），这是一次 late identity strengthening：Tuple 重算，若成为 COMPLETE 则在同一事务内执行 §6.4 claim。

输入：`idempotency_key`、`request_id`、`binding_intent`（`CREATE_OR_BIND` / `BIND_CONNECTION` / `REBIND` / `REAUTHORIZATION` / `REINSTALL` / `RECOVERY` / `ADAPTER_MIGRATION` / `VERIFICATION_REPAIR`；必须与 Request 的 `intent` 一致）。

算法（Receipt family `integration_create_or_bind`；一个事务）：

```text
 1. authenticate caller before m1_begin_receipt (§10.1; Binding: one FOR UPDATE on the caller row + its owner row (L1),
      then L2 — never resolve_binding first (v0.1.4 MINOR-N13); P5 tenant Binding → binding_not_adoptable;
      Native: authorization_owner_v12); Request owner match (else integration_not_owned); then m1_begin_receipt
 2. lock Request (L3), then decide in this order (v0.1.1, NIT-1):
      a. request_status = BOUND:
           bound_intent_sha256 = sha256(canonical_json({binding_intent, request_id, connection_binding_id | null}))
           -- v0.1.2 (NIT-1): connection_binding_id = the Binding this bind linked (Binding caller: itself;
           --   confirm_rebind / adopt_binding: the named binding_id; Native create_or_bind: null). A Host replay by
           --   the Binding the Owner confirmed therefore matches; the replay compares its own caller Binding
             → return the bound integration_id (idempotent success, no new write; allowed even after expires_at)
           otherwise → reject installation_request_bound_to_other_integration
      b. request_status ∈ {CLOSED, ARCHIVED, REJECTED} → reject installation_request_closed
      c. expires_at <= now → reject installation_request_expired
      d. binding_intent ≠ Request.intent → reject installation_request_intent_mismatch
 3. compute the resulting identity tuple and key K (no Integration lock yet):
      Binding caller: provider & provider_connection_id derived by the server from the caller's Binding (§6.2);
      Native caller: provider := Request.provider, connection dimension UNAVAILABLE / NOT_APPLICABLE (see above);
      tenant/account from Request payload (or T's current values for REBIND_CLASS) subject to registry evidence rules;
      weak kinds → reject; K := claim key if COMPLETE else null
 4. if Binding caller: require the Binding is not revoked/expired; O := its owner row (read under L1, §5.5 O6)
      (v0.1.4: the former "not CURRENT of a different Integration" check is subsumed by the ownership check in step 6)
 5. choose target — L4 is always taken before L5 (§6.4 pre-1…pre-5, MINOR-5):
      intent ∈ REBIND_CLASS
          → T := Request.target_integration_id (unlocked read; must be owned); K0 := T.claim_key_sha256
            lock L4({K, K0} \ {null}, sorted); lock T (L5); re-read, changed → integration_version_conflict
      intent = CREATE_OR_BIND ∧ identity COMPLETE
          → lock L4(K); H := current holder of K
             H exists → T := H, lock T (L5)  (outcome BIND_EXISTING)   -- §14.4 "bind the already-claimed current integration_id"
             else     → T := new integration (outcome CREATE)
      intent = CREATE_OR_BIND ∧ identity INCOMPLETE
          → T := new integration (outcome CREATE); no weak-identifier matching
 6. guards on existing T (e0 := integration_evaluate_v1(T) under the locks):
      integration_revocation_status_v1(T) ≠ NOT_REVOKED (open revocation row, or CONNECTION_USER_REVOKE, §7.2)
                                       → reject integration_revoked_requires_explicit_restore   (G-A11)
        -- v0.1.2 (MINOR-N8): read from the revocation helper, never from e0.integration_state / predicates,
        --   which are null / empty when e0 is invalid
      T SUPERSEDED                     → reject integration_superseded
      T.identity_claim_state ∈ {CLAIM_CONFLICT, PENDING_RECONCILE} ∧ the bind would change T's claim key or
        downgrade any dimension (VALUE → UNAVAILABLE)
                                       → reject integration_claim_blocked (resolve by reconcile first, §14.5)  (MINOR-N5)
      Request.host ≠ T.host            → reject integration_host_mismatch                        (MAJOR-1)
      caller provider ≠ T.provider     → reject integration_provider_mismatch                    (MINOR-9)
      Binding caller ∧ intent ∈ REBIND_CLASS ∧ ¬(SELF ∨ SAME_PROVIDER_CONNECTION ∨ NATIVE_BIND_REQUEST)  (§10.1)
                                       → reject integration_rebind_requires_owner_confirmation   (MAJOR-1)
      new connection (caller Binding ≠ T's CURRENT connection Binding) ∧ T.first_authorized_at is not null
        ∧ T.recovery_policy = FORBIDS_REAUTH
                                       → reject integration_recovery_forbidden (explicit restore only, §10.12)  (MINOR-7)
      T.authorization_ceiling is not null ∧ ¬covers(C_eff(T), caller authority)
        ∧ ¬fresh_consent(caller, T)    → reject reauthorization_scope_expansion_forbidden       (§38, §10.11)
        -- v0.1.2 (MINOR-N7) / v0.1.3 (MINOR-N11): C_eff(T) is the ceiling lowered by the v12 reduces made while a
        --   Binding was T's CURRENT connection (below)
 6'. ownership (v0.1.4, Owner Decision c5574918 / MAJOR-N4; applies to every outcome, including CREATE):
      Binding caller ∧ O ≠ null ∧ (outcome = CREATE ∨ O.integration_id ≠ T)
                                       → reject binding_owned_by_other_integration
        -- a live Binding that I owns (CURRENT or HISTORICAL) cannot fork a new Integration or move to another one
      Binding caller ∧ O = null ∧ ∃ X: X.owner_id = caller.user_id ∧ integration_revocation_status_v1(X) ≠ NOT_REVOKED
        ∧ X.historical = NONE ∧ derived(caller) ∈ Lin*(X) ∧ caller authorization created_at ≤ rev_at(X)   (§5.5 O7; v0.1.6)
                                       → reject binding_predates_revocation
        -- v0.1.5 (Owner Decision 1b034f44, MAJOR-N5): a pre-revocation same-client grant that was never linked cannot
        --   create J or link anywhere; X is found through integration_connections_v1_by_provider_connection
        --   (the Integrations whose connection rows carry derived(caller)), then by following superseded_by upward
        --   to the historical = NONE root (v0.1.7 NIT-3)
      confirm_rebind / adopt_binding (named Binding) ∧ O ≠ null ∧ O.integration_id ≠ T:
        O's Integration J has the Binding as CURRENT connection → reject binding_owned_by_other_integration
        otherwise → ownership transfer J → T (§5.5 O4), recorded in step 8
 7. if CREATE: insert integrations_v1 (install_status from installation_phase, recovery_policy from policy,
               first_authorization_required from registry, identity_claim_state INCOMPLETE_UNCLAIMED initially)
 8. link connection (Binding caller or confirm_rebind): previous CURRENT connection of T → HISTORICAL; insert CURRENT link
      with provider / provider_connection_id snapshot and link_authority (CREATE | SELF | SAME_PROVIDER_CONNECTION |
      NATIVE_BIND_REQUEST | NATIVE_OWNER_CONFIRMED | NATIVE_ADOPT);
      ownership (v0.1.4): O = null → insert owner row (T; acquired_via per §5.5 O1: FIRST_LINK for the Binding channel,
      NATIVE_OWNER_CONFIRMED for confirm_rebind, NATIVE_ADOPT for adopt_binding — v0.1.5 NIT-4) + ownership log;
      O = T → no change; transfer from 6' → update owner row, ownership log, Receipt supplemental.ownership_transfer and
      target_refs {role:'ownership_source'}; the outgoing CURRENT Binding of T stays owned by T (§5.5 O2, OQ-13);
      set first_authorized_at if null and auth usable;
      authorization_ceiling := caller authority (scopes + v12 entries) if null, or when step 6 accepted an expansion
      by fresh_consent (ceiling_before / ceiling_after recorded in the Receipt), with authorization_ceiling_set_at := now;
      otherwise, if C_eff(T) ≠ T.authorization_ceiling: authorization_ceiling := C_eff(T),
      authorization_ceiling_set_at := the latest counted reduce's recorded_at (v0.1.2 MINOR-N7; Receipt records both);
      reauth marks open on T are cleared (cleared_by REAUTHORIZATION_REBIND) iff the caller's authorization was created
      after mark.raised_at (authorizations_v12.created_at; raw Binding: clued_agent_bindings.created_at — MINOR-2)
      and covers(ceiling in force after this step, caller authority)
 9. claim (§6.4) when identity COMPLETE (L4 already held): may yield CURRENT_CLAIM_HOLDER or CLAIM_CONFLICT
      (rebind that changes the key releases the old claim in this transaction)
10. apply installation_phase = COMPLETED if requested (monotonic: never COMPLETED → PENDING)
11. Request: request_status := BOUND, bound_integration_id := T, bound_intent_sha256, bound_receipt_id
12. identity snapshot + operation_log (§14.3 fields) + post-write validity gate (§10.1) + finish receipt
```

保证：

- **G-A10 并发：**同一完整 Claim Key 的并发 `CREATE_OR_BIND` 在 L4 上串行化；后到者在第 5 步看到 holder 并绑定到它（`BIND_EXISTING`）。唯一索引兜底。结果：至多一个 current `integration_id`。
- **Request-local 幂等：**同一 Request 重放（刷新、Host callback 重放、OAuth callback 重放）命中第 2 步，返回同一 `integration_id`；同 `idempotency_key` 重放返回同一 Receipt。
- **不重置生命周期：**rebind 类 intent 不修改 `install_status`（除非单调推进到 COMPLETED），不重置为 `INSTALL_PENDING`；状态由当前 facts 重新派生（通常为 `VERIFYING`，因为 subject digest 已变）【基线 §14.2】。
- **弱标识不合并：**INCOMPLETE 身份的 `CREATE_OR_BIND` 总是新建；S2c 不合并 INCOMPLETE Integration（§6.5）。
- **不能跨连接夺取（MAJOR-1）：**Binding 通道只能 rebind 自己的 Integration（SELF）或同一 OAuth client 的 Integration（SAME_PROVIDER_CONNECTION），且 host 必须相同；其他情形只能由 Owner 在 Native 会话中 `confirm_rebind`。
- **不能分叉（v0.1.4，MAJOR-N4）：**已归 I 所有的 Binding（CURRENT 或 HISTORICAL）经 Binding 通道只能链接回 I（第 6' 步）；它不能以 `CREATE_OR_BIND` 新建 J，也不能 `BIND_EXISTING` 到另一个 holder，因此 I 的撤销永远覆盖它。

`covers(C, A)`：`A.scopes ⊆ C.scopes`，且 entries 按下表比较（v0.1.2，NIT-2 补全 `LEGACY_UNRESTRICTED` 与 `ENTRIES` 的组合）：

| `C.entries` | `A.entries` | entries 是否覆盖 |
|---|---|---|
| 列表 | 列表 | A 的每个 v12 entry `(resource_kind, resource_id, environment, actions)` 都存在 C 中同一 `(resource_kind, resource_id, environment)` 的 entry 使 `actions ⊆ C.actions` |
| `LEGACY_UNRESTRICTED` | 任意 | 是（只比较 scopes） |
| 列表 | `LEGACY_UNRESTRICTED` | **否**：不受限的 raw Binding 不被有限 entries 覆盖（只能经 Native `capability_expansion`，§10.11） |

ceiling 的形状由 `integration_ceiling_valid_v1` 以 CHECK 强制（§5.2）：`scopes ⊆ {context:read, context:write, audit:read}`、去重排序；`entries` 为字符串 `"LEGACY_UNRESTRICTED"` 或 entry 列表，每个 entry 的 `resource_kind` / `environment` / `actions` 取 v12 值域，`actions` 非空。交集 `C ∩ A`：scopes 取交集；entries 在两者都是列表时按同一 `(resource_kind, resource_id, environment)` 求 actions 交集并删去空项，一方为 `LEGACY_UNRESTRICTED` 时取另一方。

`C_eff(T)`（v0.1.2，MINOR-N7；v0.1.3 按 MINOR-N11 收紧计数范围）：令 `Red(T)` 为这样的 Binding b 的集合：`authorization_audit_v12` 中存在 b 的 `operation='reduce'` 行 r，`r.recorded_at > T.authorization_ceiling_set_at`，并且 r 发生在 b 是 **T 的 CURRENT connection** 期间，即存在 T 的 connection 行 c（`c.binding_id = b`）满足 `c.linked_at ≤ r.recorded_at < coalesce(c.unlinked_at, 'infinity')`。在 b 为 HISTORICAL（或是另一 Integration 的 current connection）期间做的 reduce 不影响 T 的 ceiling：它收窄的是那个 Binding 本身（已由 v12 在请求级执行），而不是用户对 T 的授权上界；`C_eff(T) := T.authorization_ceiling ∩ ⋂_{b ∈ Red(T)} authority(b)`（authority 读取 b 当前的 `authorizations_v12` scopes 与 `authorization_entries_v12`，即 reduce 之后的值）。v12 `reduce` 只能收窄，因此用户在 Clued 中对 Integration 的任一连接执行 reduce 之后，SAME_PROVIDER rebind 到仍然有效、权限更大的旧 Binding 会被拒绝（除非 `fresh_consent`），而不会悄悄恢复被收窄的范围。`fresh_consent` 的比较时间相应取 `max(T.authorization_ceiling_set_at, Red(T) 中最新 reduce 的 recorded_at)`。`fresh_consent(caller, T)`：调用方 Binding 有 `authorizations_v12` 行且其 `created_at` 晚于上述比较时间——该行只能由 `clued_authorization_approve_v12` 在直接人类会话（`authorization_owner_v12()`）中创建，即用户在同意页上对所列 scope / resource 的再次确认，属于基线 §38 所列“Capability 扩张需要用户再次确认”的合法落点（MINOR-12）。

`C_eff` 窗口判定的精度（v0.1.4，NIT-6）：`linked_at` / `unlinked_at` 与 reduce 的 `recorded_at` 来自不同事务的 `clock_timestamp()`；unlink（rebind）不锁旧 Binding，而 `manage_v12 reduce` 锁 Binding 行。与 unlink 同时发生的 reduce 可能被计入或不计入，结果只在“多收窄一次”与“按 v12 在请求级收窄该 Binding”之间变化，两侧都不扩大授权，接受此不确定性。

输出 `supplemental.outcome ∈ {CREATE, BIND_EXISTING, REBOUND, CLAIM_CONFLICT}`、`integration_id`、`identity_claim_state`、`evaluation`。

### 10.4 Identity strengthening / re-claim

`public.clued_integration_identity_update_v1(p_token_hash, p_input)`；Native：`{op:'identity_update'}`。Family `integration_identity_update`。

- 输入：`integration_id`、`base_version`、新的 `tenant` / `account` 维度（含 `evidence_kind`），可选 `active_binding_domain`（只能为注册表内值）。`provider_connection_id` 不接受调用方输入；它随 connection 变化由 §10.3 重新推导。
- 行为：按 §6.4 pre-1…pre-5 先计算新 key 并取 L4、再锁 I（L5），然后执行 claim 算法：
  - INCOMPLETE → COMPLETE 且 key 空闲 → `CURRENT_CLAIM_HOLDER`；
  - key 已被他人持有 → `CLAIM_CONFLICT`（`conflicting_integration_id` 指向 holder），Candidate 立即为 ∅【基线 §14.5】；
  - key 与当前持有一致 → 幂等成功，写新 identity snapshot 与 Receipt；
  - COMPLETE 的 key 维度合法变化 → 同事务释放旧 claim、声明新 claim，或进入 `CLAIM_CONFLICT`（不存在双 current 窗口）。
- 维度降级（VALUE → UNAVAILABLE）只允许在 `REBIND` / `ADAPTER_MIGRATION` 类 Request 的上下文中，由 §10.3 发起；单独的 identity_update 不能“撤回”已验证维度（`identity_dimension_downgrade_forbidden`）。
- 冲突中不得改身份（v0.1.2，MINOR-N5）：`identity_claim_state ∈ {CLAIM_CONFLICT, PENDING_RECONCILE}` 时，任何会改变 claim key 或降级维度的 identity_update 或 §10.3 bind 都拒绝为 `integration_claim_blocked`；`SUPERSEDED` 时一律 `integration_superseded`。否则冲突方可以靠降级成为 INCOMPLETE_UNCLAIMED（§5.2 CHECK 会清掉 `conflicting_integration_id`），在 policy `PERMIT` 下不经 reconcile 恢复普通运行时，违反基线 §14.5“冲突解决前…不得继续普通 Runtime”与 §15.2。冲突只能经 §10.5 reconcile 解决，或由 Owner 撤销 / 暂停冲突方。
- 在 ordinary runtime 继续之前必须完成 re-claim【基线 §14.5】：由于 claim 状态本身是 truth input，不存在绕过路径。一旦 Identity 成为 COMPLETE 而未 claim，就是 C2 矛盾：§5.2 CHECK 使其不能被提交，§10.1 写后有效性门拒绝任何把有效 Integration 变为 C2 的写入，§7.3 规范化在约束被绕过时 fail closed。

### 10.5 Reconcile

- Binding：`public.clued_integration_reconcile_request_v1(p_token_hash, p_input)`，只能把自身 Integration 从 `CLAIM_CONFLICT` 推到 `PENDING_RECONCILE`（family `integration_reconcile`）。
- Native：`clued_user_integration_v1{op:'reconcile', integration_id, base_version, holder_base_version, resolution}`，`resolution ∈ {REBIND_TO_HOLDER, REPLACE_HOLDER}`：
  - `REBIND_TO_HOLDER`：I 的 current connection 移到 holder H（H 的旧 connection → HISTORICAL，仍归 H 所有）；该 Binding 的所有权 I → H（`acquired_via='NATIVE_RECONCILE'`，§5.5 O4，Receipt 记录 `ownership_transfer`）；新 connection 行 `link_authority='NATIVE_RECONCILE'`（v0.1.4，MINOR-N14）；v0.1.5（MINOR-N15）：I 拥有的其他全部未撤销 Binding 也在同一事务内转移给 H（`NATIVE_RECONCILE`，只转移所有权，不建立 connection 行），因此撤销 H 会一并撤销它们；I → `SUPERSEDED`（`superseded_by = H`）；H 的 subject digest 变化 → H `VERIFYING`。
  - `REPLACE_HOLDER`：H 的 claim → `SUPERSEDED`、H → `SUPERSEDED`（`superseded_by = I`）；I 取得 CURRENT claim。两步在同一事务、同一 L4 锁下完成。v0.1.5（MINOR-N15）：同一事务内先解除 H 的 CURRENT connection（→ HISTORICAL，`unlink_receipt_id` = 本 Receipt），再把 H 拥有的全部未撤销 Binding（包括刚解除的 `b_H`）转移给 I（`NATIVE_RECONCILE`，只转移所有权；I 的 current connection 不变）。这些 Binding 与 I 持有同一完整 claim key（同一 Host 账户与 client），撤销 I 会一并撤销它们；它们之后若要成为 I 的 connection，按 §10.3 的 SAME_PROVIDER rebind 与 ceiling 规则进行。
  - REVOKED 的 H 只能通过 `REPLACE_HOLDER` 被取代，不会被恢复（OQ-6）。
- 锁顺序（v0.1.2，NIT-4 补全 L1；v0.1.5 MINOR-N15 扩展）：先对 I 与 H 各自的 CURRENT connection Binding（`REBIND_TO_HOLDER` 会把 I 的 Binding 移给 H，并把 H 的旧 Binding 转为 HISTORICAL），以及被取代一方拥有的全部未撤销 Binding（将被转移），`REPLACE_HOLDER` 且 H 已撤销时再加上 `UnownedLineage(H, rev_at(H))`（v0.1.6，MINOR-N20），合在一起按 `id` 排序取 L1（含所有者行；L5 下复核该集合未变，变了 → `integration_version_conflict`），再取其 `authorizations_v12`（L2），然后按 §6.4 pre-1…pre-5 对 I 与 H 的 key 取 L4，再按 L5 顺序锁两个 Integration，L5 下复核两者的 CURRENT connection 未变（变了 → `integration_version_conflict`）；两个 `base_version` 都要 CAS。
- `REBIND_TO_HOLDER` 的前置条件（v0.1.3，MAJOR-N3 / NIT-9），在 L5 下按此顺序判定，任一不满足即拒绝、无业务写入：
  1. `integration_revocation_status_v1(I) = NOT_REVOKED`，否则 `integration_revoked_requires_explicit_restore`：已撤销的 I 的连接（无论撤销来自 Integration revoke 还是连接撤销）不得移给 H，否则 H 的有效连接会被替换为一个已撤销的 Binding，H 随即派生 REVOKED；
  2. `integration_revocation_status_v1(H) = NOT_REVOKED`，否则 `integration_revoked_requires_explicit_restore`（REVOKED 的 H 不接收连接，只能经 `REPLACE_HOLDER` 被取代，OQ-6）；
  3. I 有 CURRENT connection，且其 Binding 有效（未撤销、未过期，若为 OAuth 则 `authorizations_v12` 未撤销、未过期），否则 `reconcile_requires_active_connection`。没有可移动的有效连接时，Owner 用 `REPLACE_HOLDER`（若应保留 I），或撤销 / 暂停 I；S2c 不定义“只取代 I、不移动连接”的变体；
  4. （v0.1.4，MINOR-N14）H 的接收守卫与 §10.3 第 6 步相同，记移动的 Binding 为 b、其 authority 为 A(b)：
     - `H.recovery_policy = FORBIDS_REAUTH ∧ H.first_authorized_at is not null` → `integration_recovery_forbidden`（不设例外：Owner 可先撤销 H 再 restore，或由 Operator 改 policy，§10.12 末条）；
     - `H.authorization_ceiling is not null ∧ ¬covers(C_eff(H), A(b)) ∧ ¬fresh_consent(b, H)` → `reauthorization_scope_expansion_forbidden`：Owner 选择 reconcile 方案不是对扩大 scope 的同意（§38）；
     - host / provider 必然相同（I 与 H 持有同一完整 key），仍按 §10.3 复核，不符 → `integration_host_mismatch` / `integration_provider_mismatch`。
- `REBIND_TO_HOLDER` 对 H 的其余效果（v0.1.4，MINOR-N14）与 §10.3 第 8 步相同：`first_authorized_at` 为 null 时设置；ceiling 为 null 时设为 A(b)，经 `fresh_consent` 接受扩大时更新并记录 `ceiling_before` / `ceiling_after`，否则按 `C_eff(H)` 落盘；H 的 open reauth mark 仅在 b 的授权创建晚于 `mark.raised_at` 且 `covers(ceiling, A(b))` 时清除（`cleared_by='REAUTHORIZATION_REBIND'`）。
- `REPLACE_HOLDER`：H 可以是 REVOKED（这正是 OQ-6 允许的取代路径）；存续方 I 必须 NOT_REVOKED（规则 1），因此只有被取代方 H 可能处于 `CONNECTION_USER_REVOKE`，此时按规则 2 物化（v0.1.7 更正 v0.1.6 的“两方中任何一方”，MAJOR-N23），H 的撤销事实在它变为 SUPERSEDED 之后仍以行的形式保留。v0.1.6（MINOR-N20）跨越撤销边界的规则，v0.1.7 修订：
  1. **存续方 I 已撤销**（`integration_revocation_status_v1(I) ≠ NOT_REVOKED`）→ 拒绝为 `integration_revoked_requires_explicit_restore`，hint：先以同一 client 的新授权 restore I（claim key 不变时，restore 在 CLAIM_CONFLICT / PENDING_RECONCILE 中也允许，§10.12，v0.1.7 MAJOR-N23），再 reconcile。否则 H 的有效 Binding 会归一个已撤销的 I 所有却保持有效，破坏“open 行 ⇒ `Owned(I)` 全部已撤销”。
  2. **被取代方 H 已撤销**（open 行或派生；v0.1.7 MINOR-N24 重写）：记 `R := Owned(H) ∪ UnownedLineage(H, rev_at(H))`（在 H 变为 SUPERSEDED、其血缘经 `Lin*` 并入 I 之前求值，与 Decision `1b034f44` 第 1 条一致），同一事务内：
     - H 仅由连接撤销派生（无 open 行）：按 §10.1 **一次**插入物化行，`revoked_binding_ids = [b_H] ∪ R`，`receipt_id` = 本 Receipt，不在同一调用中再扩展（与 §10.10 第 5 步一致）；
     - H 有 open 行且 `R ≠ ∅`：超集扩展该行（`revoked_binding_ids ∪ R`，`extended_receipt_ids` 追加本 Receipt）；`R = ∅`（显式撤销后的常态，`Rev(H) = ∅`）：**不写**该行；
     - 对 `R` 中每个 Binding 按 §10.10 第 7 步撤销（未拥有的按 `REVOCATION_SWEEP` 建立归 H 的所有权），operation log `RECONCILE_REVOKE`；
     - 已撤销的 Binding（`R` 以及 H 此前已撤销的）**留在 H 名下**作为历史，不转移（§10.10 第 7 步：已撤销的 Binding 不再链接或转移）；转移给 I 的只剩 H 的未撤销 Binding，此时为空。
     H 撤销之前签发的凭据因此不会借取代重新获得地位。
     - 已知边界 1b（v0.1.7，NIT-7）：H 血缘上一个 `created_at ≤ rev_at(H)`、但在 reconcile 的 L5 复核之后才提交的同意不在 `R` 中；此后 H 为 SUPERSEDED（O7 排除）、I 为 NOT_REVOKED，O7 不再阻断它。它与边界 1 同类（亚事务窗口、直接人类同意），之后对 I 的撤销（`Lin*(I) ⊇ Lin(H)`）会清扫它。
     - PR 放置（v0.1.7，MINOR-N25）：规则 2 需要撤销写路径（§10.10 第 7 步与清扫），在 PR-4 交付；PR-2 中 `REPLACE_HOLDER` 遇到已撤销的 H 暂时拒绝为 `integration_revoked_requires_explicit_restore`（临时规则，PR-4 移除），T-A11-15(c)(e) 随 PR-4。
  3. H 未撤销 → 按上文转移，不撤销。
- `CLAIM_CONFLICT → PENDING_RECONCILE` 保留 `conflicting_integration_id`（§5.2）。

### 10.6 能力声明、升级与 Adapter / Host 报告

`public.clued_integration_declare_v1(p_token_hash, p_input)`（family `integration_declare`，current connection 专用）：

- 输入：`integration_id`、`base_version`、`host_surface`、`declared_capabilities[]`、`host_features{}`、`adapter_family`、`adapter_version`、`package_version?`。
- 校验：surface 已注册；`declared_capabilities ⊆ capability_ceiling`，否则 `capability_declaration_exceeds_ceiling`；未知能力 → `capability_unknown`；`host_features` 中为 true 的项必须在注册表中也为 true，否则 `host_feature_not_supported`。
- 写入：插入新声明行，并在同一事务内把 `integrations_v1.adapter_family` / `adapter_version` / `package_version` 更新为声明值（v0.1.2，NIT-3：兼容性规则与 subject digest 都读这些列）。
- 升级【基线 §37】：`adapter_version` / `package_version` 变化使 subject digest 变化 → Canonical verification `INVALIDATED` → `VERIFYING`。兼容性规则（注册表最低版本）若判定 `HARD_INCOMPATIBLE` → `INCOMPATIBLE`。升级不修改 Binding scope 与 `authorization_ceiling`，因此不会扩大授权【基线 §37“升级不得自动扩大用户已有 Scope”】。

`public.clued_integration_report_v1(p_token_hash, p_input)`（family `integration_report`，current connection 专用）：

- Adapter 以 `source='adapter'` 报告 `host_state` / `adapter_state` 的 `DEGRADED{mask}` / `HARD_UNAVAILABLE` / `BLOCKED`，或清除**自己此前**的报告。
- Adapter 不能报告 `environment_state`、`qualification_state`、`compatibility_state`，也不能覆盖 operator / policy fact（`adapter_report_cannot_expand`）。
- 单调格合并保证 Adapter 最多“Preserve or Narrow”【基线 §17】。

Operator：`clued_admin_integration_v1{op:'fact_set'|'fact_clear', truth_class, value, mask?, reason, valid_until?}`（family `integration_fact_set`），可写全部五个 class（`source ∈ {operator, policy}`）。S3 的 Qualification 结果经此写入 `qualification_state`。

### 10.7 记录 Canonical Runtime Baseline Verification（A 类）

`public.clued_integration_verify_v1(p_token_hash, p_input{kind:'canonical_baseline', integration_id, base_version, idempotency_key, transport})`，family `integration_verify_baseline`，只允许 current connection 调用。

`clued.crv.v1` 检查项（全部由服务端观察，不接受 Host 自报的 PASS）【提议】：

| id | 检查 | 证据 |
|---|---|---|
| CRV-1 | 调用方 Binding 在本事务内认证成功，`auth_ok` | Binding / Authorization 行锁 |
| CRV-2 | 存在 `public.clued_continuity_sessions` 行：`binding_id` = 调用方、`started_at >= connection.linked_at`（即链接之后的一次成功 `clued_session_resume`） | session id |
| CRV-3 | Worker 注入的 `transport.protocol_version ∈ SUPPORTED_MCP_VERSIONS`，`transport.build_sha` 格式合法（沿用 `__transport_source_commit` 先例；调用方输入中同名字段被 Worker 覆盖）。**弱证据**（v0.1.1，MINOR-11）：grant 开放后直接调用 PostgREST 的调用方可以伪造 `transport`，因此 CRV-3 以 `evidence_strength='WEAK_CALLER_SUPPLIED'` 记录，只能使结果 FAIL（格式不合法），不能作为 PASS 的依据；PASS 只依赖 CRV-1、CRV-2、CRV-4 | transport 摘要 |
| CRV-4 | 当前 subject digest 已计算 | digest |

- 守卫写作 `coalesce(e.valid ∧ e.predicates.verification_eligible, false)`（v0.1.3，NIT-6：facts 无效时谓词为 null / 缺失，按不合格处理）；不成立时拒绝为 `verification_not_eligible`（不写验证行），因此 `BLOCKED` / claim 冲突等状态下无法通过“补验证”被提升【基线 §16.3】。
- 检查失败时写 `result='FAIL'` 行（有 Receipt），规范化得 `FAILED` → `VERIFYING`（OQ-9）。
- 通过时写 `PASS` 行，`valid_until = now + policy.canonical_verification_ttl`。
- 本函数不得读写任何 READY 表（§13.3 T-A8-2 静态扫描）。

### 10.8 记录 READY(profile) Verification（B 类）

`public.clued_integration_verify_v1(p_token_hash, p_input{kind:'ready_profile', integration_id, profile_id, profile_version, idempotency_key})`，family `integration_verify_ready`，只允许 current connection 调用。

- 前置：profile 存在（否则 `ready_profile_unknown`）；Canonical 结果 `Operable = true`（否则 `ready_verification_requires_operable`，不写行）。
- 检查：`evidence_rules` 中每个 required capability 的服务端可观察证据。例如 `context.write` 要求在 `connection.linked_at` 之后存在该 Binding 的 committed M1 Receipt（family ∈ 规则列表）；`context.read` 要求链接后的 resume session；规则由 profile 定义（S3 定稿）。
- 结果写入 `integration_ready_verifications_v1`；**只**写该表、Receipt 与 operation log。不得写 `integration_canonical_verifications_v1`、`integrations_v1`、`integration_facts_v1`、Binding / Authorization 表【基线 §16.5、§20】。

### 10.9 读取状态与有效能力

- Binding：`public.clued_integration_status_v1(p_token_hash, p_input{integration_id?, profiles?: [{id, version}], emit_ready_receipt?: bool, idempotency_key?})`。省略 `integration_id` 时返回调用方 Binding 作为 current connection 的 Integration；没有时返回 `{integration: null, reason: 'NOT_ADOPTED'}`。
- Native：`clued_user_integration_v1{op:'list'|'status'}`。
- 返回：identity（维度状态、脱敏后的值：`provider_connection_id` 只返回前 8 位 hash 前缀）、`identity_claim_state`、`evaluation`（§8.2 输出）、`sources_read`（读取到的来源行 id 与版本）、connections（current 与 historical，含 `link_authority`）、`owned_bindings`（v0.1.4：I 拥有的 Binding id、`acquired_via`、是否有效、最近一次所有权转移的 Receipt）、可选各 profile 的 READY 投影（§9.5），以及基线 §15 建议的审计字段（v0.1.1，NIT-4；均为只读投影，不进入 facts 文档）：
  - `identity_claim_evidence_ref`：最新 identity snapshot id 与其 Receipt id；
  - `canonical_verification_evidence_ref` / `last_canonical_verified_at`：最新 A 类行的 `verification_id`、`receipt_id`、`evidence_sha256` / `verified_at`；
  - `ready_verification_evidence_ref` / `last_ready_profile_verified_at`：仅对请求的 profiles，取最新 B 类行（这两个字段只出现在 READY 投影中，不影响 `integration_state`）；
  - `last_successful_resume`：current connection Binding 最新 `clued_continuity_sessions.started_at`（`started_at >= linked_at`）；
  - `last_successful_tool_use`：current connection Binding 最新 `status='committed'` 的 M1 Receipt 的时间与 id。
- 读操作不写 Canonical 状态；`DERIVATION_INPUT_INVALID` 时写诊断（§7.3）。`emit_ready_receipt=true` 时要求 `idempotency_key`，写 family `integration_ready_projection` 的 Receipt。

### 10.10 Revoke（Integration-level）

| 入口 | 通道 | `revoked_by` |
|---|---|---|
| `clued_user_integration_v1{op:'revoke'}` | Native | `USER` |
| `public.clued_integration_revoke_self_v1(p_token_hash, p_input)` | Binding（current connection；撤销范围受限，见下） | `USER_VIA_HOST` |
| `clued_admin_integration_v1{op:'revoke', revoked_by ∈ {CLUED, POLICY, SECURITY}}` | Operator | 同左 |

Family `integration_revoke`；输入 `integration_id`、`reason`、`idempotency_key`，**不**接受 `base_version`（v0.1.2，MINOR-N1：撤销是单调的）。单一事务：

```text
0. t_rev := clock_timestamp()                                               (v0.1.5; the revocation instant)
   -- v0.1.6 (NIT-9): t_rev is taken before step 1's lock wait on purpose: a grant created while this call waits is a
   --   consent given after the Owner's revoke, i.e. a new decision
   t_cut := (v0.1.6 MINOR-N18) status := integration_revocation_status_v1(I) (unlocked read)
              INTEGRATION            → the open row's revoked_at        (= rev_at(I))
              CONNECTION_USER_REVOKE → rev_at(I) per §5.5 O7 = the revoked_at the step-5 materialized row will carry
                                       (connection_revoked_at; t_rev when that is null — v0.1.7 NIT-2, one rule)
              NOT_REVOKED            → t_rev                            (a new INTEGRATION_REVOKE row will carry revoked_at = t_rev)
   Owned(I)          := non-revoked Bindings owned by I with b.user_id = I.owner_id           (§5.5 O5; v0.1.5 NIT-7:
                        "non-revoked" = revoked_at is null, expiry is not a filter)
   UnownedLineage(I) := UnownedLineage(I, t_cut) per §5.5 O5 — non-revoked, unowned, same owner, v12 grant created
                        ≤ t_cut whose server-derived (provider, provider_connection_id) ∈ Lin*(I)
                        (v0.1.5, Owner Decision 1b034f44 item 1(a), MAJOR-N5; v0.1.6 t_cut / Lin*)
   Rev(I)            := Owned(I) ∪ UnownedLineage(I)
   -- v0.1.4 replaced Eligible / SH / shared_binding_count with ownership; v0.1.5 adds the never-linked same-client grants
1. S0 := Rev(I) (unlocked read). Lock, in one id-ordered pass, S0's Binding rows and their owner rows (if any) FOR UPDATE
   (L1) — for revoke_self the caller is in S0 and is authenticated inside this same pass (§10.1, MINOR-N13) — then L2
2. lock I (L5)                                                              (no CAS, MINOR-N1)
3. recompute status and t_cut under L5; a changed t_cut → abort integration_revoke_connection_set_changed (retryable)
   S1 := Rev(I) re-read under L5 (same t_cut)
   S1 ⊄ S0 → abort integration_revoke_connection_set_changed (40001, retryable; no business write)
   S1 ⊊ S0 is fine (v0.1.3 NIT-4): the missing members were revoked concurrently, or transferred / first-linked elsewhere by
     a transaction that took their L1 before step 1 and therefore committed before this revoke (linearized before it)
   -- a Binding can enter Owned(I) only by a first link on I (needs L5(I)) or an ownership transfer to I (needs L1 on it and
   -- L5(I)); it can leave only by a transfer (needs L1 on it). An unowned Binding can enter UnownedLineage(I) by I gaining
   -- a new connection snapshot (needs L5(I), cannot commit after step 2), by a consent with created_at > t_cut (excluded),
   -- or (v0.1.6 NIT-3 correction) by a consent with created_at ≤ t_cut that commits between the S0 read and step 3: that
   -- one makes S1 ⊄ S0 and causes the retryable abort above; the retry includes it. After steps 1–2 nothing else can
   -- change S1 before this transaction ends
   F := Bindings owned by I with binding.user_id ≠ I.owner_id (a C7 fact, only by out-of-band tampering); never touched, only counted
4. (MAJOR-1 / v0.1.2 MINOR-N3; v0.1.5 MAJOR-N5) revoke_self only: LINEAGE := Bindings in S1 whose identity equals the
   caller's (provider, provider_connection_id) — owned ones by their connection snapshot on I, unowned ones by their
   server-derived identity; for clued.oauth.v12 the same client_id, for clued.binding.v1 only the caller.
   S1 ⊄ LINEAGE → PARTIAL: revoke LINEAGE only (step 7 over LINEAGE), write no revocation row, and return
     outcome PARTIAL_CONNECTION_REVOKE with remaining_binding_count = |S1 \ LINEAGE| and the Owner instruction
     (hint: revoke the whole Integration in Clued). Because the caller is the CURRENT connection, I now derives
     REVOKED by CONNECTION_USER_REVOKE (§7.2); the remaining Bindings stay as they are. Continue at step 7.
5. (v0.1.2 MAJOR-N2; v0.1.3 MINOR-N10; v0.1.4 NIT-3) row := the open revocation row of I, if any
   if none and integration_revocation_status_v1(I) = CONNECTION_USER_REVOKE:
     insert ONE row computed by integration_connection_revoke_adoption_v1(I) (§10.1: revoked_by, revoked_at and
     adopted_from from the adopted connection revoke) with revoked_binding_ids = [current connection Binding] ∪ S1 and
     receipt_id = this Receipt; outcome REVOKED, outcome_flags REVOCATION_MATERIALIZED
     -- the materialized row IS this call's Integration-level revocation row; no second row, and no extension of a row
     -- created in the same call
   elif row exists ∧ S1 = ∅ → no further revocation write; outcome ALREADY_REVOKED
   elif row exists ∧ S1 ≠ ∅ → extension: row.revoked_binding_ids := row.revoked_binding_ids ∪ S1,
                              row.extended_receipt_ids ||= this Receipt (§5.9 trigger (b)); outcome REVOKED
   else                     → insert integration_revocations_v1 (revoked_by = this call's revoked_by, revoked_at = t_rev,
                              revoked_binding_ids = S1, revocation_source = 'INTEGRATION_REVOKE'); outcome REVOKED
6. (v0.1.4: folded into step 5; numbering kept so that references to steps 7–8 stay valid)
7. for each Binding in S1 (PARTIAL: in LINEAGE): if it has no owner row, insert one (integration_id = I,
   acquired_via = 'REVOCATION_SWEEP', first ownership, ownership log row with from_integration_id = null) (v0.1.5 MAJOR-N5);
   set clued_agent_bindings.revoked_at; if authorizations_v12 exists set revoked_at, version+1;
   insert authorization_audit_v12(operation='revoke_integration')   -- same semantics as manage_v12 revoke
   -- step 7 ALWAYS runs over S1 (or LINEAGE) when it is non-empty, including when the row pre-existed
   -- revoked Bindings stay owned by I (history), and a revoked Binding can never be linked or transferred again
   operation_log row: operation_type = 'REVOKE' (PARTIAL: 'PARTIAL_REVOKE'), actor per §10.1 channel,
   affected_binding_ids = the Bindings revoked in this step (the source for 'revoke_integration' provenance, §10.1)
8. evaluate → REVOKED (exempt from the post-write validity gate, §10.1); Receipt records row id ({role:'revocation'}),
   the Bindings revoked by this call (swept_unowned_binding_ids listed separately, each with sibling_integration_ids per
   §5.5 O5, v0.1.6 MINOR-N22), t_cut, foreign_binding_count = |F| and
   outcome ∈ {REVOKED, ALREADY_REVOKED, PARTIAL_CONNECTION_REVOKE}; finish receipt
```

不变量（v0.1.4 所有权模型；v0.1.5 按 Owner Decision `1b034f44` 扩展，可加锁证明）：非 PARTIAL 的 revoke 成功提交后，I 有 open revocation 行，且 `Rev(I) = ∅`——I 拥有的每个 Binding（CURRENT 或 HISTORICAL，包括同 client 重新授权留下的旧 Binding，OQ-13），以及 `t_cut` 之前签发、从未链接过的同 client Binding，都已撤销（v0.1.7 NIT-1）。另一个 Integration **拥有**的 Binding 从不被触及；但尚未链接、可能本要给同 client 兄弟 Integration 的授权会被清扫（§5.5 O5“兄弟 Integration 的影响”，v0.1.6 MINOR-N22，Receipt 列出）。`t_cut` 之后在同意页上新批准的同 client Binding 不受影响（新的授权决定）；对已撤销的 I 再次撤销时 `t_cut = rev_at(I)`，因此不会清扫原撤销之后的新同意（v0.1.6，MINOR-N18）。仅由连接撤销派生的 REVOKED（无行）只保证 current connection 的 Binding 已撤销；其余 Binding 保持有效，但归 I 的不能被 Binding 通道链接到别处（O3），撤销时刻之前的未拥有同 client Binding 不能新建连接（O7），直到一次显式 revoke 把它们一并撤销，或 restore 撤销被取代的旧 Binding（§10.12）。

已知边界 1：一个 `created_at ≤ t_cut`、但在第 3 步之后才提交的 `clued_authorization_approve_v12` 事务（与撤销并发进行的直接人类同意）不在 S1 中，因此不被清扫；它仍受 O7 约束（不能链接或新建），之后的 restore（`REVOCATION`）或再次撤销（`t_cut = rev_at(I)`）会清扫它；在此之前它可调用既有工具，直到 OQ-16 的热路径门控。不改 `approve_v12`（或在撤销中对 `authorizations_v12` 取全表锁）就无法关闭这个亚事务级窗口（T-A11-23）。REPLACE_HOLDER 中的同类窗口记为边界 1b（§10.5 规则 2）。另：PARTIAL `revoke_self` 之后派生撤销的 `rev_at` 取审计行时间，略晚于那次调用的 `t_rev`，是更严格的一侧（v0.1.6，NIT-9）。

- 同事务撤销 Binding，使**所有既有工具**立即 fail closed（`resolve_binding` 已检查 `revoked_at`），不依赖任何新增中间件【基线 §39】。
- 保留 claim：REVOKED Integration 继续持有 CURRENT claim（OQ-6），因此同一完整身份的新 create-or-bind 会命中它并被 `integration_revoked_requires_explicit_restore` 拒绝，而不是静默新建【基线 §14.4、§39】。
- 撤销不删除任何行。
- 跨 owner（v0.1.2，MINOR-N4）：S0 / S1 只含 `binding.user_id = I.owner_id` 的 Binding。所有者行指向他人 Binding 只可能是带外篡改（所有权只在 Binding 属于 owner 时建立或转移），是 C7 矛盾（§7.3）；撤销不触碰它，只在 Receipt 中计数；修复属于运维缺陷处理。
- `revoke_self` 的范围（MAJOR-1 / v0.1.2 MINOR-N3）：Binding 通道只撤销与自己同一 provider-connection 身份的 Binding；调用方自己的凭据**总会**被撤销，不会因为存在其他身份的 Binding 而整体被拒绝。I 拥有的其他身份的 Binding（只可能经 Owner 的 `confirm_rebind` / `adopt_binding` / `restore` 产生）保留，结果为 `PARTIAL_CONNECTION_REVOKE`，提示 Owner 在 Clued 中撤销整个 Integration（第 5–7 步随后撤销剩余 Binding）。只撤销本连接的现有路径（v0.1.2，NIT-5 更正：Worker 不暴露 `clued_authorization_revoke_self_v12`）：用户在 Host 中断开（Host 发 RFC 7009 撤销 → `revoke_issuer_v12`），或在 Clued 连接管理页撤销（`manage_v12 revoke`）；二者都使 Integration 按 §7.2 派生为 REVOKED。Native / Operator 撤销不受此限。
- PARTIAL 之后的记录（v0.1.3，NIT-8）：PARTIAL `revoke_self` 撤销的同身份 Binding（例如 T-A11-8 的 B0）只记录在该次 Receipt 与 `integration_operation_log_v1.affected_binding_ids` 中。之后物化的行只列出 current connection Binding（`revoked_binding_ids=[B1]`），Owner 的显式 revoke 再把仍有效的其余 Binding 加入该行；已被 PARTIAL 撤销的 B0 不会出现在行中。完整的撤销集合 = 行的 `revoked_binding_ids` ∪ 该 Integration 所有 `REVOKE` / `PARTIAL_REVOKE` 日志行的 `affected_binding_ids`，status 按此并集返回。
- 锁等待（v0.1.2，NIT-7）：既有 `clued_private.resolve_binding` 每次工具调用对 Binding 行取 `FOR SHARE`（仓库现状；评审报告写作 UPDATE，已按代码更正）。revoke 第 1 步的 `FOR UPDATE` 会等待进行中的工具调用结束，这是有界等待；L1 在全局锁顺序最前，不会形成死锁。
- **S2c 中 §39 “不自动恢复”的保证层级（MAJOR-5）：**S2c 在 **Integration truth 层**保证不恢复——REVOKED 不能被 rebind / reauth / reinstall / verify / reauth_clear 清除，claim 继续被持有，只有 §10.12 显式 restore 能解除。S2c **不**对既有工具热路径加 Integration 门控（§12.5、OQ-16），因此用户之后在 v12 同意页（`clued_authorization_approve_v12`，必须是直接人类会话 `authorization_owner_v12()`）新批准的 Binding 可以立即调用既有工具，无论它是否链接到任何 Integration。这是基线 §39 所说的“新的授权决定”，不是对已撤销 Integration 的恢复：它不会使该 Integration 离开 REVOKED，也不能被链接到它（§10.3 第 6 步）。Host 缓存、旧 Skill、旧 App、adapter reconnect 持有的旧凭据均已在本事务中撤销：v0.1.5（MAJOR-N5）更正了 v0.1.4 的这一说法——v0.1.4 只覆盖曾被链接过的 Binding；现在撤销集合是 `Owned(I) ∪ UnownedLineage(I)`，因此也覆盖 `t_cut` 之前签发、从未链接过的同 client 凭据（上文“已知边界”除外）；PARTIAL 时为调用方同一身份的凭据。

### 10.11 Reauthorization：标记与清除

- 派生路径（无需标记）：current connection 的 Binding / Authorization **过期**（`expires_at <= as_of`）→ `credential_lost` → `REAUTH_REQUIRED`（若 `reauth_recoverable`，§8.3）。v0.1.2（MAJOR-N1）：v0.1.1 把 `revoke_issuer_v12` 描述为“签发方 / Provider 侧失效”并归入此路径，这与仓库不符——Worker 只在 Host 发来的 RFC 7009 撤销请求（`POST /oauth/token`，带 `token`、无 `grant_type`）中调用它，即 Host 侧的“断开连接”。已删除该归类。
- OQ-2 保守临时规则（v0.1.1 MAJOR-6，v0.1.2 按 MAJOR-N1 更正）：current connection 的 Binding 被**任何**连接级路径撤销——Clued 连接管理页 `manage_v12 revoke`（`operation='revoke'`）、Host 断开 `revoke_issuer_v12`（`'revoke_issuer'`）、直接调用 PostgREST 的 `revoke_self_v12`（`'revoke_self'`）、本规格的部分撤销（`'revoke_integration'`），以及无法归因的撤销（无撤销类审计行或 Binding 行缺失）——都由规范化派生为 `revocation_state = REVOKED`（`revocation_source = CONNECTION_USER_REVOKE`，§7.2），需要 §10.12 显式 restore；普通 OAuth rebind 被 §10.3 第 6 步拒绝。因此 REAUTH_REQUIRED 只来自过期与 reauth mark。代价见 R4 与 OQ-2：审计行无法区分“用户在 Host 中断开”与 Host 的例行撤销，后者也会要求 restore。OQ-2 的最终裁定可以放宽此规则，但不得在裁定前放宽。
- 显式标记：`clued_admin_integration_v1{op:'reauth_mark', reason}`（family `integration_reauth_mark`）；服务端内部（例如 Policy 变更迁移）同样通过 `clued_private.integration_reauth_mark_core_v1`。`integration_revocation_status_v1(I) ≠ NOT_REVOKED` 时的标记请求 → `integration_revoked_requires_explicit_restore`（v0.1.3，NIT-6：不从可能为 null 的 `integration_state` 判断）。
- 清除：
  - 自动：§10.3 第 8 步。条件是一个新 Binding 以 `REAUTHORIZATION` / `REBIND` / `CREATE_OR_BIND`（命中 holder）intent 绑定并通过 §10.1“Rebind 授权”，其授权创建于 `mark.raised_at` 之后（v0.1.1 MINOR-2：比较 `authorizations_v12.created_at`；raw Binding 比较 `clued_agent_bindings.created_at`；`authorization_requests_v12` 没有 `created_at` 列），且 `covers(authorization_ceiling, caller authority)`。Family `integration_create_or_bind`，mark 行记录 `cleared_receipt_id`。
  - Operator：`{op:'reauth_clear', mark_id, reason}`（family `integration_reauth_clear`）；只能清除 reauth mark，**不能**触及 revocation（`reauth_mark_not_open` / 对 REVOKED 无效）。
- 恢复不**自动**扩权【基线 §38】（v0.1.1，MINOR-12）：ceiling 同时覆盖 OAuth scopes 与 v12 resource entries（`covers`，§10.3）。新 Binding 的 authority 超出 ceiling 时：
  - 若 `fresh_consent`（v12 同意页上的直接人类批准，晚于 ceiling 设定时间）→ 接受，这就是 §38 的“用户再次确认”；ceiling 更新为新 authority，Receipt 记录 `ceiling_before` / `ceiling_after` 与 `outcome_flags:['AUTHORITY_EXPANDED_BY_CONSENT']`；
  - 否则（raw Binding、或同意早于 ceiling 设定）→ `reauthorization_scope_expansion_forbidden`。
  - 用户在 Clued 中对某个 Binding 执行的 v12 `reduce`，若发生在该 Binding 是本 Integration 的 CURRENT connection 期间，会降低比较用的 ceiling（`C_eff`，§10.3，v0.1.2 MINOR-N7 / v0.1.3 MINOR-N11 / v0.1.4 NIT-4），并在下一次链接时落盘；对 HISTORICAL Binding 的 reduce 不影响 ceiling。
  - Native `{op:'capability_expansion', integration_id, base_version, new_ceiling}`（family `integration_capability_expansion`）保留为**可选**路径，只用于没有同意页的 raw Binding 或 Owner 预先放宽 ceiling；它不是 v12 路径的必经步骤（OQ-14）。

### 10.12 Restore / Regrant（撤销后显式恢复）

`clued_user_integration_v1{op:'restore', integration_id, base_version, new_binding_id}`（Native，family `integration_restore`）；Operator 可用 `{op:'restore'}`，`decided_by='OPERATOR'`。

- 适用对象：(i) `integration_revocation_status_v1(I) ≠ NOT_REVOKED`（`restore_kind='REVOCATION'`）；(ii) `B9` 且 `recovery_policy = FORBIDS_REAUTH` 的凭据丢失（`restore_kind='FORBIDS_REAUTH_RECOVERY'`，MINOR-7；该路径是 §10.3 第 6 步 `integration_recovery_forbidden` 的唯一 Owner 出口，Operator 也可先以 `{op:'recovery_policy'}` 改为 `PERMITS_REAUTH`）。其他状态 → `lifecycle_transition_invalid`。
- 前置守卫（v0.1.2，MINOR-N2）：`historical = NONE`，否则 `integration_superseded`（`historical=SUPERSEDED` 使 B9 恒真，若不守卫，(ii) 会把新 Binding 链接到已被取代的对象；经 `REPLACE_HOLDER` 被取代的 REVOKED holder 同理）；`identity_claim_state ∈ {CLAIM_CONFLICT, PENDING_RECONCILE}` 时（v0.1.7，MAJOR-N23 选项 (a)）：`restore_kind='REVOCATION'` 且新 Binding 推导出的 claim key K 等于 `K0 = I.claim_key_sha256`（同一 client、Tuple 不变）→ **允许**，restore 后 I 仍处于原 claim 状态、NOT_REVOKED，Owner 随后以 reconcile 解决冲突；会改变 key（K ≠ K0）的 restore，或 `FORBIDS_REAUTH_RECOVERY` → `integration_claim_blocked`。MINOR-N5 守卫只为阻止冲突中改 key；key 不变的 restore 不改变冲突关系，却解开“已撤销 ∧ 冲突”的死锁（REPLACE_HOLDER 规则 1 要求先 restore）。
- `new_binding_id` 必须属于 owner、当前有效、非 P5，不是任何其他 Integration 的 CURRENT connection（所有权规则见下文“事务”），且是**新的授权决定**（v0.1.1 MINOR-2）：委托 OAuth 比较 `authorizations_v12.created_at`，raw Binding 比较 `clued_agent_bindings.created_at`，必须严格晚于失效基准时间 `t_loss`；否则 `restore_requires_new_authorization_decision`。`new_authorization_created_at` 记录所比较的时间。`t_loss` 的定义（v0.1.2，MINOR-N2）：
  - (i)：open revocation 行（含本事务物化的行）的 `revoked_at`；
  - (ii) 且有 current connection：其 Binding / Authorization 的 `expires_at`、`revoked_at` 中已到达（`<= now`）者的最早值，与 open reauth mark 的 `raised_at` 最大值，二者取较晚者；
  - (ii) 且没有 current connection（`ever_authorized` 但连接已被移走）：最新 HISTORICAL connection 的 `unlinked_at`，与 open reauth mark 的 `raised_at` 最大值，取较晚者；
  - 以上都不存在时 → `lifecycle_transition_invalid`（没有可恢复的凭据丢失）。
- 连接撤销派生的 REVOKED（`CONNECTION_USER_REVOKE`，无 revocation 行）：restore 在同一事务内先以 §10.1 的 `integration_connection_revoke_adoption_v1(I)` 插入物化行（与其他物化点完全相同：`revoked_by` / `revoked_at` / `adopted_from` 都来自被采纳的连接撤销，v0.1.3 MINOR-N10），再对该行执行 regrant。`t_loss` 取该行的 `revoked_at`，与“是谁先物化”无关；此前的超集扩展（§10.10 第 6 步）也不移动它。
- 身份与锁（v0.1.3，MINOR-N12）：restore 链接新连接，因此与 §10.3 的链接遵守同一身份规则：
  - 锁顺序：L1（`new_binding_id` 的 Binding 行，以及 v0.1.5 MINOR-N16 起将被撤销的 `Old(I)`，见下文“事务”，合在一起按 `id` 排序，均含所有者行，`FOR UPDATE`；`Old(I)` 在 L5 下复核，增加 → `integration_version_conflict`）→ L2（其 `authorizations_v12`）→ L4 → L5（I），与 §6.4 pre-1…pre-5 一致：pre-1 无锁读取 I 与新 Binding；pre-2 按下一条计算新 key K；pre-3 对 `{K0 = I.claim_key_sha256, K} \ {null}` 排序取 L4；pre-4 锁 I；pre-5 复核（变化 → `integration_version_conflict`），并以已持有的锁复核 `new_binding_id` 未被链接到其他 Integration；
  - provider：服务端按 §6.2 从新 Binding 推导 `(provider, provider_connection_id)`；推导出的 provider ≠ `I.provider` → `integration_provider_mismatch`（例如把 raw Binding restore 到 `clued.oauth.v12` 的 Integration）。host 不可变，新 Binding 不改变它；
  - Tuple 与 key：用新的 `provider_connection_id` 重算 Tuple（tenant / account 维度沿用 I 的现值），写新的 identity snapshot；v0.1.8（MINOR-N27）：`identity_claim_state ∈ {CLAIM_CONFLICT, PENDING_RECONCILE}` 且 K = K0 的 restore **不调用** `integration_claim_core_v1`，`identity_claim_state` 与 `conflicting_integration_id` 保持不变，也不设 `CLAIM_CONFLICT_AFTER_RESTORE`（冲突只由 reconcile 解决）；其他情形完整时计算 K，并以 `integration_claim_core_v1` 执行 claim：K = K0 → 幂等；K 空闲 → 同事务释放 K0、声明 K；K 被其他 Integration 持有 → I 成为 `CLAIM_CONFLICT`（restore 仍提交，状态由派生给出 BLOCKED，Receipt 标注 `outcome_flags:['CLAIM_CONFLICT_AFTER_RESTORE']`，Owner 随后 reconcile）；
  - connection 行记录新的 provider-connection 快照与 `link_authority`（Native `NATIVE_RESTORE`，Operator `OPERATOR_RESTORE`，v0.1.6 NIT-5）；§10.1 写后有效性门照常适用。
- 事务（v0.1.4 恢复：v0.1.3 重写本节时误删了这一条）：插入 `integration_regrants_v1`，（i）时设置 `revocation.restored_by_regrant_id`，链接新 connection（`link_authority` 见下）；新 Binding 的所有权：未拥有 → 建立（Native：`NATIVE_RESTORE`；Operator：`OPERATOR_RESTORE`）；已归 I → 不变；归另一 Integration J 所有：Native restore 在 J 的 CURRENT connection 不是它时转移 J → I（§5.5 O4，Receipt 记录 `ownership_transfer`），是 J 的 CURRENT connection → `binding_owned_by_other_integration`；**Operator restore 一律拒绝**为 `binding_owned_by_other_integration`（v0.1.5，MINOR-N17：Operator 路径不转移所有权，O4 只含 Owner-native 路径）；Operator restore 写入的 connection 行 `link_authority='OPERATOR_RESTORE'`，Native 为 `NATIVE_RESTORE`（v0.1.6，NIT-5）；撤销被取代的旧凭据（v0.1.5，Owner Decision `1b034f44-e5b7-414c-a9a1-53b7bf065200` 第 2 条，MINOR-N16；v0.1.6 MINOR-N21 收窄）：
  - 两种 `restore_kind` 都撤销 `Owned(I) \ {new_binding_id}`（Decision 第 2 条）；
  - 只有 `restore_kind='REVOCATION'` 另清扫 `UnownedLineage(I, t_loss)`：restore 使 I 回到 NOT_REVOKED，O7 对 I 不再生效，若不清扫，`t_loss` 之前签发、从未链接的同 client 授权就会被放行并可新建 J——这正是 Decision `1b034f44` 第 1 条 (a)(b) 针对撤销所禁止的，因此该清扫以第 1 条为依据，属于同一类；`FORBIDS_REAUTH_RECOVERY` 不做此清扫（没有撤销，O7 从未生效，基线 §38 把过期视为重新授权，清扫只会撤销用户其他有效的同 client 会话）；
  - `Lin*(I)` 在链接新 connection **之前**求值（新 Binding 的 client 若是新的，不会让它此前的无关授权被清扫）；
  - `Old(I)` 与新 Binding 一起在第一段 L1 中加锁（见“身份与锁”），清扫的 Binding 按 `REVOCATION_SWEEP` 建立所有权；对 `Old(I)` 中每个 Binding 按 §10.10 第 7 步撤销（Binding 与 Authorization 的 `revoked_at`、审计 `'revoke_integration'`），operation log 行 `operation_type='RESTORE_SWEEP'`、`affected_binding_ids = Old(I)`，Receipt 列出它们（清扫的未拥有 Binding 附 `sibling_integration_ids`，§5.5 O5）。因此 restore 之后，I 上只剩新授权决定对应的 Binding，旧凭据不能再以 SAME_PROVIDER rebind 回到 I（基线 §39：新的 Authority 是重新授予）；`authorization_ceiling := A(new binding)`、`authorization_ceiling_set_at := now`（新决定就是新授权上界；v0.1.4 MINOR-N14：Receipt 记录 `ceiling_before` 与 `ceiling_after`，`ceiling_after` 不被 `ceiling_before` 覆盖时加 `outcome_flags:['AUTHORITY_CHANGED_BY_RESTORE']`；restore 是 Owner 在 Native 会话中对一个晚于失效时间的新授权决定的显式确认，允许据此重设上界）；清除 `raised_at < new_authorization_created_at` 的全部 open reauth mark（`cleared_by='RESTORE'`，`cleared_receipt_id` = 本 Receipt，Receipt 列出被清除的 mark id；v0.1.2 MINOR-N2）——新授权决定晚于这些 mark，正是它们要求的重新确认；晚于新授权的 mark 保留，此时结果仍为 REAUTH_REQUIRED / BLOCKED，Receipt 标注 `outcome_flags:['REAUTH_MARKS_REMAIN']`。然后 evaluate（mark 清空时通常 → `VERIFYING`）。
- 旧 Binding 保持撤销；不存在“解除撤销”旧 Binding 的路径【基线 §39：新的 Authority 是重新授予，而不是旧 Revocation 被静默覆盖】。
- 健康的 `FORBIDS_REAUTH` Integration（v0.1.2，NIT-6）：凭据仍有效时，Owner 的 `confirm_rebind` 会被 §10.3 第 6 步拒绝（`integration_recovery_forbidden`，因为是已授权过的 Integration 上的新连接），`restore` 也不适用（没有凭据丢失）。Owner 想把它移到新连接只有一条显式路径：先 `revoke`，再以新授权 `restore`（两步各有 Receipt）；或由 Operator 把 `recovery_policy` 改为 `PERMITS_REAUTH`。这是有意的：`FORBIDS_REAUTH` 就是“任何连接更换都要经过撤销 / 恢复的显式决定”。

### 10.13 生命周期操作（Native / Operator）

`clued_user_integration_v1{op:'lifecycle', integration_id, base_version, action}`，family `integration_lifecycle`：

| action | 效果 | 约束 |
|---|---|---|
| `installation_completed` | `install_status PENDING → COMPLETED` | 单调；Connect 回调在 S6 复用此核心函数 |
| `pause` | `ordinary_runtime := PAUSED_BY_OWNER` | 仅 owner |
| `resume` | `PAUSED_BY_OWNER → PERMITTED` | 不能解除 `PAUSED_BY_POLICY` |
| `request_close` / `request_archive` | Request 状态变化 | 不改变 Integration【基线 §14.6】 |

Operator：`{op:'policy_pause'|'policy_resume'}` 管理 `PAUSED_BY_POLICY`；`{op:'recovery_policy', value}` 设置 `recovery_policy`。

### 10.14 采纳既有 Binding

`clued_user_integration_v1{op:'adopt_binding', binding_id, host, host_surface, adapter_family, adapter_version, installation_phase, idempotency_key}`（Native，family `integration_adopt_binding`）：内部先以 `created_via='native_session'` 打开一个 `create_or_bind` Request，然后以该 Binding 作为 connection 执行 §10.3（Binding 由 owner 指定，而不是由 Binding 自身调用；`link_authority='NATIVE_ADOPT'`）。所有权（v0.1.4）：未拥有的 Binding 建立所有者行（`NATIVE_ADOPT`）；已归另一 Integration J 所有且不是 J 的 CURRENT connection → 转移 J → I 并记录 `ownership_transfer`；是 J 的 CURRENT connection → `binding_owned_by_other_integration`。P5 租户 Binding 不可采纳（§5.15）。`binding_inventory` 只读，只列出**未拥有**的有效 Binding，不列出 P5 租户 Binding。

### 10.15 操作一览

| 操作 | Binding | Native | Operator | Receipt family | CAS |
|---|---|---|---|---|---|
| request_open | ✔ | ✔ | — | 无（Request 行） | request_key 唯一 |
| create_or_bind | ✔（REBIND_CLASS 受 §10.1“Rebind 授权”约束） | ✔（仅 `create_or_bind`，无连接） | — | `integration_create_or_bind` | Request OPEN + L4 + L5 下复核（无 `base_version`，§10.1） |
| confirm_rebind | — | ✔ | — | `integration_create_or_bind` | Request OPEN + L4 + `base_version` |
| identity_update | ✔（current connection） | ✔ | — | `integration_identity_update` | `base_version` |
| reconcile_request / reconcile | ✔（→ PENDING_RECONCILE） | ✔（resolution） | — | `integration_reconcile` | 双 `base_version` |
| declare | ✔（current connection） | — | — | `integration_declare` | `base_version` |
| report | ✔（current connection） | — | — | `integration_report` | `base_version` |
| fact_set / fact_clear | — | — | ✔ | `integration_fact_set` | `base_version` |
| verify canonical_baseline | ✔（current connection） | — | — | `integration_verify_baseline` | `base_version` |
| verify ready_profile | ✔（current connection） | — | — | `integration_verify_ready` | `base_version` |
| status / list | ✔ | ✔ | ✔ | 可选 `integration_ready_projection` | — |
| revoke | ✔（self；只撤销同一 provider-connection 身份的 Binding，其余保留时为部分撤销） | ✔ | ✔ | `integration_revoke` | 无 `base_version`（单调，v0.1.2 MINOR-N1）；L5 后连接集重读 |
| reauth_mark / reauth_clear | — | — | ✔ | `integration_reauth_mark` / `_clear` | `base_version` |
| restore | — | ✔ | ✔ | `integration_restore` | `base_version` |
| capability_expansion（可选，raw Binding） | — | ✔ | — | `integration_capability_expansion` | `base_version` |
| lifecycle | — | ✔ | ✔（policy） | `integration_lifecycle` | `base_version` |
| adopt_binding / binding_inventory | — | ✔ | — | `integration_adopt_binding` / 无 | Request + L4 + L5 下复核（无 `base_version`） |

---

## 11. 错误码

### 11.1 分类与传输

| 类别 | SQLSTATE | 传输 | Worker 行为 |
|---|---|---|---|
| 授权拒绝 | `42501`，**不**在 `REQUEST_RULE_REJECTIONS` 中；必须在 `m1_begin_receipt` **之前**抛出（§10.1） | PostgREST 错误 | HTTP 403（anon 角色的 401+42501 仍按既有逻辑改写为 403） |
| 请求规则拒绝（事务前） | `42501`，列入 `REQUEST_RULE_REJECTIONS` | PostgREST 错误 | 转为工具结果 `{status:'rejected', error:{code, category:'request_rule', hint?}}` |
| 请求规则拒绝（Receipt 内） | M1 envelope `status='rejected'`，`error_code` = 下表码 | HTTP 200 | Integration 工具适配器把它渲染成与上一行相同的 `request_rule` 形状；hint 取自同一个 `REQUEST_RULE_REJECTIONS` 表（单一 hint 注册表） |
| 输入无效 | `22023` | PostgREST 错误 | HTTP 400 |
| 并发 / CAS（Receipt 内） | 私有核心 `40001` → M1 `status='rejected'`，`error_code` = 冲突码 | HTTP 200 | 工具结果 `{status:'rejected', error:{code, category:'conflict', retryable:true}}`；REST 409 |
| 并发 / CAS（Receipt 外） | 私有核心 `40001` → public wrapper 捕获 `serialization_failure` 且 `sqlerrm` 为已知冲突码 → 改抛 `23505`（`20260824123000_map_optimistic_conflicts_to_http_409` 约定） | PostgREST 错误 | HTTP 409 |
| 系统失败 | 其他 | M1 `failed` / 5xx | 原样 |

规则：Integration RPC **不得**把规则违反以未列入白名单的 `42501` 抛出。§13.8 T-W-4 扫描全部 Integration 迁移中的 `raise exception '<code>' using errcode='42501'`，要求每个 code 恰好属于下表“授权”集合或 `REQUEST_RULE_REJECTIONS`。

### 11.2 码表

**授权（HTTP 403）**

| 码 | 场景 |
|---|---|
| `binding_not_authorized` | 既有：Binding 无效 / 撤销 / 过期 / 账户不可用 |
| `direct_human_session_required` | 既有：Native 通道收到 OAuth 客户端 JWT |
| `integration_not_owned` | Integration 不存在或不属于调用主体（统一，不泄露存在性） |
| `integration_connection_required` | 调用方 Binding 不是该 Integration 的 current connection |
| `platform_admin_required` | Operator 通道非管理员 |
| `binding_not_owned` | adopt / restore 指定的 Binding 不属于 owner |

**请求规则（加入 `REQUEST_RULE_REJECTIONS`）**

| 码 | 场景 | hint（草案） |
|---|---|---|
| `installation_request_expired` | Request 已过期 | 打开新的 Installation Request 后重试 |
| `installation_request_closed` | Request 已 CLOSED / ARCHIVED / REJECTED | 同上 |
| `installation_request_key_conflict` | 同 `request_key` 不同 payload | 为不同安装尝试使用新的 `request_key` |
| `installation_request_bound_to_other_integration` | 同 Request 以不同 intent 绑定另一个 Integration | Request 只能绑定一个 Integration；为新目标打开新 Request |
| `installation_request_intent_mismatch` | `binding_intent` 与 Request `intent` 不符 | — |
| `identity_weak_identifier_forbidden` | 以 email / display name 等弱证据提交身份维度 | 该维度记为 unavailable；不会用弱标识合并 |
| `identity_dimension_evidence_unverified` | 调用方值与服务端推导不符或证据种类不被接受 | — |
| `identity_dimension_not_applicable_mismatch` | 调用方声明 NOT_APPLICABLE 与注册表不符 | — |
| `identity_dimension_downgrade_forbidden` | 单独 identity_update 撤回已验证维度 | 通过 rebind Request 执行 |
| `host_not_registered` / `host_surface_not_registered` / `provider_not_registered` | 注册表缺失 | — |
| `binding_owned_by_other_integration` | v0.1.4（Owner Decision `c5574918`，取代 `binding_already_linked_to_other_integration`）：Binding 通道链接一个归其他 Integration 所有的 Binding（包括用 I 仍有效的旧 Binding 新建 J）；或 Owner-native 路径要转移的 Binding 是其所有者的 CURRENT connection；或 Operator restore 指定了归其他 Integration 所有的 Binding（v0.1.5，MINOR-N17） | 该 Binding 属于另一个 Integration。如需移动，请 Owner 在 Clued 中确认（`confirm_rebind` / `adopt_binding` / restore / reconcile）；若它是那个 Integration 的当前连接，先在那个 Integration 上改用其他连接或通过 reconcile 移动。不要为此撤销那个 Integration：撤销会一并撤销这个 Binding（v0.1.5 NIT-5） |
| `binding_predates_revocation` | v0.1.5（Owner Decision `1b034f44`，MAJOR-N5）：未拥有的调用方 Binding 的授权不晚于同一 owner、`historical = NONE`、已撤销、且 `Lin*` 含该 Binding 身份的某个 Integration 的撤销时刻（§5.5 O7；v0.1.6 起用 `Lin*` 并排除 SUPERSEDED，v0.1.7 NIT-7），却要经 Binding 通道链接或新建 | 这是撤销之前签发的授权，不能用来恢复或新建连接；请在 Host 中重新连接并在同意页上重新批准 |
| `binding_not_adoptable` | Binding 已撤销 / 过期，或是 P5 租户 Binding（`organization_id` 非空，含 `role='denied'`） | S2c 只采纳个人 Binding |
| `integration_rebind_requires_owner_confirmation` | Binding 通道的 REBIND_CLASS 既不是 SELF、也不是同一 provider-connection 身份、也不是 Native 绑定 Request（§10.1） | 请 Owner 在 Clued 中确认该连接（`confirm_rebind`） |
| `integration_host_mismatch` | Request 的 `host` 与目标 Integration 的 `host` 不同 | Host 是身份维度；为该 Host 安装新的 Integration |
| `integration_provider_mismatch` | 调用方派生的 provider 与目标 Integration 的 `provider` 不同 | — |
| `integration_recovery_forbidden` | `recovery_policy = FORBIDS_REAUTH` 的 Integration 上以新连接恢复 | 恢复只能由 owner 在 Clued 中显式 restore |
| `integration_revoked_requires_explicit_restore` | 向 REVOKED Integration rebind / reauth / reinstall / verify / reauth_mark，或 `REBIND_TO_HOLDER` 时 I 或 holder 已撤销（v0.1.3 MAJOR-N3），或 `REPLACE_HOLDER` 的存续方已撤销（v0.1.6 MINOR-N20；PR-2 中另含被取代方已撤销的临时拒绝，v0.1.7 MINOR-N25）；v0.1.2 起包括在 Host 中断开连接（RFC 7009 撤销）之后的重连 | 撤销只能由 owner 在 Clued 中显式恢复（restore；处于 claim 冲突时用同一 client 的新授权，key 不变即可）；重新 OAuth 不会恢复 |
| `integration_superseded` | 目标已 SUPERSEDED（含 v0.1.2 restore 守卫，MINOR-N2） | 使用返回的 `superseded_by` Integration |
| `integration_claim_blocked` | 在 claim 阻断状态下请求 declare / verify 等普通推进；v0.1.2（MINOR-N5 / N2）：CLAIM_CONFLICT / PENDING_RECONCILE 时改变 claim key 或降级维度的 bind / identity_update；v0.1.7（MAJOR-N23）：此时会改变 claim key 的 restore，以及 `FORBIDS_REAUTH_RECOVERY` restore | 先完成 reconcile；若该 Integration 已撤销，先以**同一 client** 的新授权 restore（key 不变时允许），再 reconcile |
| `reconcile_not_applicable` | 非 CLAIM_CONFLICT / PENDING_RECONCILE 的 reconcile | — |
| `reconcile_requires_active_connection` | `REBIND_TO_HOLDER` 时 I 没有 CURRENT connection，或其 Binding / Authorization 已撤销或过期（v0.1.3，MAJOR-N3） | 改用 `REPLACE_HOLDER`，或撤销 / 暂停该 Integration |
| `reauthorization_scope_expansion_forbidden` | 恢复授权时 scope 超出 ceiling | 以原范围重新授权；扩权需 owner 在 Clued 中显式批准 |
| `restore_requires_new_authorization_decision` | restore 使用撤销前的授权 | 先完成一次新的授权，再恢复 |
| `reauth_mark_not_open` | 清除不存在或已清除的 mark | — |
| `capability_declaration_exceeds_ceiling` | 声明超出 Host / Surface 上界 | Host Adapter 只能保持或收窄能力 |
| `capability_unknown` | 不在词表 | — |
| `host_feature_not_supported` | 声明注册表不支持的 Host feature | — |
| `adapter_report_cannot_expand` | Adapter 试图放宽或覆盖 operator / policy fact | — |
| `verification_not_eligible` | `coalesce(valid ∧ verification_eligible, false)` 不成立时请求 Canonical 验证 | 返回阻断原因 |
| `ready_profile_unknown` | profile 或版本不存在 | — |
| `ready_verification_requires_operable` | 非 Operable 时请求 READY 验证 | — |
| `lifecycle_transition_invalid` | 非法生命周期动作（如 COMPLETED → PENDING、resume policy pause）；restore 的对象既未撤销、也没有可恢复的凭据丢失 | — |
| `derivation_input_invalid` | 变更将产生矛盾 truth 集合 | 返回 `reason_codes` |

v0.1.2（MINOR-N3）：`integration_revoke_requires_owner_confirmation` 已删除。`revoke_self` 在还有其他身份的 Binding 时不再报错，而是提交部分撤销并返回 `supplemental.outcome='PARTIAL_CONNECTION_REVOKE'` 与 Owner 提示（§10.10 第 4 步）。

**冲突（HTTP 409；传输见 §11.1 两行）：**`integration_version_conflict`、`installation_request_version_conflict`、`identity_claim_retry_exhausted`、`integration_revoke_connection_set_changed`（v0.1.1，MAJOR-5）。

**一致性（`23514`，事务回滚）：**`identity_claim_store_divergence`（deferred 约束触发器；正常路径不可达，出现即缺陷）。

### 11.3 Receipt family 与 Event

Receipt families（M1 `operation_family`）：`integration_create_or_bind`、`integration_identity_update`、`integration_reconcile`、`integration_declare`、`integration_report`、`integration_fact_set`、`integration_verify_baseline`、`integration_verify_ready`、`integration_ready_projection`、`integration_revoke`、`integration_restore`、`integration_reauth_mark`、`integration_reauth_clear`、`integration_capability_expansion`、`integration_lifecycle`、`integration_adopt_binding`、`integration_derivation_invalid`。

Event【提议，OQ-15】：沿用 IF S5 先例，成功的写操作经 `m1_append_event_row` 追加 `extension:integration:<family>`，`event_scope='global'`，`audit_visibility='audit_only'`。PR-2 必须先证明这些 Event 不改变 resume / work log / checkpoint 待吸收计数 / capture 状态 / 投影；否则改为只写 Receipt 并在 Receipt 中声明 `event_ids = []`。

---

## 12. Worker / MCP 表面

### 12.1 Feature flag

| flag | 位置 | 默认 | 作用 |
|---|---|---|---|
| `CLUED_INTEGRATION_RUNTIME_V1` | Worker env（`ContinuityEnv`） | **未设置 = off** | 控制 Integration MCP 工具的注册与分派、`/v1/integrations*` REST 路由、bootstrap 的 `integration_runtime` 块 |

- 判定函数 `integrationRuntimeEnabled(env)` 与既有 flag 同形：`/^(1|true|on|enabled)$/i`。
- S2c 不得在 `wrangler.production.jsonc` 或任何生产配置中设置该 flag；开启属于单独阶段授权。
- 数据库侧没有 flag：迁移只新增对象，不改变既有函数（§2.3）。v0.1.1（MINOR-11，OQ-21 默认）：**S2c 迁移不向 `anon` / `authenticated` 授予任何 Integration public RPC 的 EXECUTE**（§5.13），因此 flag off 期间它们既不能经 Worker 到达，也不能经 PostgREST 直接调用。这是必要的：这些 RPC 并不只影响 Integration 表——`revoke_self_v1` / Native / Operator `revoke` 会写 `clued_agent_bindings`、`authorizations_v12`、`authorization_audit_v12`。目标 grant 由开启 flag 的阶段授权随附迁移施加。

### 12.2 新工具（仅 flag on 时出现在 `tools/list`）

| 工具 | RPC | 注解（readOnly / destructive / idempotent / openWorld） | 说明 |
|---|---|---|---|
| `clued_integration_install` | `request_open` → `create_or_bind`（两次 RPC，均幂等） | false / false / true / true | 输入 `request_key`、`intent`、`target_integration_id?`、`host`、`host_surface`、tenant / account 维度、adapter / package、`installation_phase`、`idempotency_key` |
| `clued_integration_status` | `status_v1` | true / false / true / true | 可带 `profiles` 与 `emit_ready_receipt` |
| `clued_integration_declare` | `declare_v1` | false / false / true / true | 按 Integration 的能力声明 + 升级 |
| `clued_integration_report` | `report_v1` | false / false / true / true | Adapter / Host 收窄报告 |
| `clued_integration_identity_update` | `identity_update_v1`；`reconcile_request_v1`（`action:'request_reconcile'`） | false / false / true / true | Late strengthening / re-claim |
| `clued_integration_verify` | `verify_v1` | false / false / true / true | `kind ∈ {canonical_baseline, ready_profile}`；Worker 注入 `transport` |
| `clued_integration_revoke` | `revoke_self_v1` | false / **true** / true / true | 用户经 Host 发起的 Integration 撤销；总会撤销调用方同一 provider-connection 身份的 Binding；还有其他身份的 Binding 时为部分撤销，并提示由 Owner 在 Clued 中撤销整个 Integration（§10.10） |

所需 scope：这些是“连接自身”操作，不读写用户 context。现有 `publicToolPolicies` 只能表达 Clued 数据 scope；空数组会被 `publishTool` 描述为“Public metadata call”，这是错误的。【提议】在 S2a 统一注册表中新增策略属性 `connectionSelf: true`，`_meta["clued/requiredScopes"] = []`，`_meta["clued/authentication"] = "binding"`；在 S2a 落地前，Integration 工具组使用 `["context:read"]` 作为最小声明，并在描述中写明“connection-self operation”（OQ-12）。

### 12.3 注册方式（与 S2a 统一注册表一致）

- 新文件 `apps/clued-cloud/worker/integrations.ts`，导出 `integrationTools`、`integrationToolPolicies`、`integrationRpcByTool`、`integrationRuntimeEnabled`。文件组织参照 `information-flow.ts`（后者导出 `informationFlowTools` / `informationFlowRpcByTool`），但有一处不同（v0.1.1，NIT-2）：Information Flow 工具由既有 `recordsV2Enabled` 控制、没有自己的 flag 函数；Integration 工具组必须有独立的 `integrationRuntimeEnabled(env)`，不得复用 `recordsV2Enabled`。
- 若 S2a 的统一工具注册表先合入：以**一个 flag 组**注册（`group: 'integration_runtime', flag: 'CLUED_INTEGRATION_RUNTIME_V1'`），由注册表统一产生 `tools/list`、注解、`rpcByTool` 与 flag 过滤；不得在 `callTool` 中新增分支式特例。
- 若 S2a 尚未合入：按当前模式并入 `tools` / `publicToolPolicies` / `rpcByTool`，在 `publicMcpTools` 与 `callTool` 的 flag 检查中增加 `integrationRuntimeEnabled`；S2a 合入时迁移到注册表（PR-5 描述中登记该债务）。
- Binding 通道：Worker 以 `p_token_hash = sha256(token)` 调用；token 必须以 `clued_bnd_` 开头，否则 403（与 P5 / 开发 context 一致）。
- 错误：`requestRuleRejection` 继续只处理 `42501` + 白名单；新增 `integrationRuleEnvelope(result)`，把 `status='rejected'` 且 `error_code ∈ REQUEST_RULE_REJECTIONS` 的 envelope 渲染成同一形状（§11.1）。

### 12.4 Bootstrap 与 REST

- flag on 时 `bootstrapContract().capabilities.integration_runtime = { enabled: true, contract: "clued.integration-runtime.v1", derivation_contract: "clued.integration-derivation.v1", facts_schema: "clued.integration-facts.v1", capability_vocabulary: [...], tools: [...], states: [...10] }`。flag off 时**不出现该键**，bootstrap 字节与 main 相同（§13.8 T-W-2）。
- Native REST（flag on）：`GET /v1/integrations`、`GET /v1/integrations/{id}`、`POST /v1/integrations/{id}/{revoke|restore|reconcile|lifecycle|identity|capability-expansion}`、`POST /v1/integrations/requests/{request_id}/confirm-rebind`、`POST /v1/integrations/adopt-binding`、`GET /v1/integrations/binding-inventory`、`POST /v1/integrations/requests`。全部转发到 `clued_user_integration_v1`，使用用户 JWT；flag off → 404。
- Operator REST 不在 S2c 暴露；Operator RPC 只经受控运维脚本调用（测试直接调用）。

### 12.5 既有工具不变

- flag off（包括 `production_equivalent`）：`tools/list` 与 `evals/public-mcp/tools-list.baseline.json` 逐字节相同，29 个工具。
- flag on：既有工具的定义、注解、分派、错误映射均不变；只追加 7 个 Integration 工具。
- S2c 不在 `resolve_binding` 或任何既有工具路径上加 Effective Capability 门控。Revocation 的 fail closed 通过同事务撤销 Binding 实现（§10.10），不需要热路径改动。Effective Capability 在既有工具上的强制执行属于后续阶段的单独授权（OQ-16）。

### 12.6 Flag 矩阵

`evals/public-mcp/tool-versions.json` 与 `verify-flag-matrix.ts` 增加 `CLUED_INTEGRATION_RUNTIME_V1` 维度（与 S2a 的“flag 矩阵覆盖全部生产 flag”要求协调）：

| PROJECT_VIEWS_V2 | P5_TENANT_WRITES | CLUED_INTEGRATION_RUNTIME_V1 | 期望工具数 |
|---|---|---|---|
| false | false | false | 18 |
| true | false | false | 29（`production_equivalent`，与 baseline 相同） |
| false | true | false | 23 |
| true | true | false | 34 |
| false | false | true | 25 |
| true | false | true | 36 |
| false | true | true | 30 |
| true | true | true | 41 |

---

## 13. 测试计划

### 13.0 约定

- 数据库测试沿用 `apps/clued-cloud/tests/*-db.test.mjs` 模式：embedded-postgres、stub `auth.uid()` / `auth.jwt()`、按文件名顺序应用全部迁移、每测试独立库。新文件：
  - `tests/integration-runtime-derivation-db.test.mjs`（纯函数性质测试）
  - `tests/integration-runtime-identity-db.test.mjs`（Request / Claim / 并发）
  - `tests/integration-runtime-verification-db.test.mjs`（A/B 分离、READY）
  - `tests/integration-runtime-revocation-db.test.mjs`（Revocation / Reauth）
  - `tests/integration-runtime-lifecycle-db.test.mjs`（G-A9 闭环）
  - `tests/integration-runtime-structure-db.test.mjs`（权限、无既有对象变更）
  - `tests/integration-runtime-transport.test.mjs`（Worker flag、错误映射）
  - fixture：`tests/fixtures/integration-runtime/golden-vectors.v1.json`
- 测试注册表行（`test.complete` Host：`tenant/account_dimension='NOT_APPLICABLE'`，使 claim key 可完整；`test.noauth` Host：`first_authorization_required=false`）只在测试中插入。
- 随机测试使用固定种子：`setseed(0.20260924)`（SQL）与 `mulberry32(20260924)`（Node），失败时打印种子与 facts。
- v0.1.1 补充约定：
  - **固定 `p_as_of`**（MAJOR-3）：凡断言“facts / facts_sha256 / normalize 输出不变”的测试，都以同一个显式 `p_as_of` 调用 `integration_normalize_v1` / `integration_evaluate_v1` / status；另有一例以两个不同 `p_as_of`（不跨越任何 TTL / 过期边界）调用，断言 `facts_sha256` 相同而 `as_of` 不同。
  - **Grant**（MINOR-11）：S2c 迁移不授予 public RPC 的 EXECUTE；测试在应用迁移后执行与目标 grant（§5.13）相同的 `grant` 语句，T-S-2 另在未执行该步骤的库上断言无 grant。
  - **约束绕过**（MINOR-3）：`session_replication_role=replica` 只用于触发器层面的不一致；被 CHECK / 唯一索引排除的组合在 facts 层构造，或在一次性测试库中显式 `drop constraint` / `drop index` 后构造，并在测试名中标明。
- 每个测试 ID 下方列出它证明的基线原文条目（逐字引用）。

### 13.1 G-A3 — Capability / Operability Closure

| ID | 证明的 §42 条目（原文） | 方法 |
|---|---|---|
| T-A3-1 | “`Candidate Ordinary Capability Set = ∅` → `Operable = false`；” | 性质：全部 P1/P2 样本（§13.2）中 `cand=∅ ⇒ ¬operable`；DB：构造 scope / resource / qualification / host 各自令 cand=∅ 的 Integration，读 status |
| T-A3-2 | “`Operable = true` → Ordinary Effective Capability Set 必须非空；” | 性质：`operable ⇒ effective≠∅` |
| T-A3-3 | “`Operable = false` → Ordinary Effective Capability Set 必须为空；” | 性质：`¬operable ⇒ effective=∅`；DB：10 个状态各至少一例 |
| T-A3-4 | “`ACTIVE / DEGRADED` 不得与空 Ordinary Effective Capability Set 并存；” | 性质：`state∈{ACTIVE,DEGRADED} ⇒ effective≠∅`；负例：cand=∅ 且 crv VALID 的 facts 不得得到 ACTIVE / DEGRADED |
| T-A3-5 | “`BLOCKED` 必须与 ordinary runtime non-operable 一致；” | 性质：`state=BLOCKED ⇒ ¬operable ∧ effective=∅` |
| T-A3-6 | “完整 Stable Identity Claim Key 已可确定时，`identity_claim_state != CURRENT_CLAIM_HOLDER` 不得保留 ordinary candidate capability。” | 性质：`complete ∧ claim≠CURRENT ⇒ cand=∅`；DB：`test.complete` 上制造 CLAIM_CONFLICT / PENDING_RECONCILE / SUPERSEDED，候选为空 |

### 13.2 G-A7 — Total Deterministic State Derivation（含性质测试方法）

性质测试方法：

- **P1 谓词层穷举。**`integration_derive_v1` 内部分解为 `integration_predicates_v1(facts)` → 谓词向量，和 `integration_select_state_v1(vector)`。对向量 `(revoked, hard_incompat, credential_lost, recovery_permits, installed, first_auth_required, ever_auth, eligible_inputs…, B1…B9, crv_valid, cand_empty, degraded, lifecycle_ok)` 穷举全部 2^k 组合（k ≈ 22，约 420 万；以 SQL `generate_series` 位运算集合式执行），先滤掉违反谓词依赖的组合（例如 `B8 ∧ ¬installed`），再对剩余组合检查“恰好一个状态”和优先级。
- **P2 事实层分层覆盖。**(a) 单因子：以“全健康”基准 facts 为中心，每个 truth class 逐一取遍值域；(b) 全两两组合：每对 truth class 的值域笛卡尔积，其余取基准值（约 1–2 万组）；(c) 随机：固定种子 250,000 组全域随机 facts（CI），夜间 2,000,000 组。
- **P3 确定性。**每组 facts 求值两次：原顺序，以及键顺序打乱、集合元素逆序的等价 JSON；在两个不同会话中求值；结果与 `facts_sha256` 必须完全相同。DB 层的重复求值使用同一个固定 `p_as_of`（§13.0）。
- **P4 Profile 独立。**derive 签名不接受 profile；DB 层对同一 Integration 插入 / 删除 / 修改任意 READY profile 与 READY verification 行后，以同一个固定 `p_as_of` 调用的 `integration_normalize_v1` 输出字节与 `integration_state` 不变。
- **P5 Golden vectors。**`golden-vectors.v1.json` 至少 60 组人工核对用例，覆盖基线 §16.3 列出的每个示例与本规格每个 blocking predicate；每条用例写明预期状态和依据章节。v0.1.1 必含（MAJOR-2）：`GV-SUPERSEDED-CREDENTIAL-LOST`——`identity_claim_state=SUPERSEDED`、`historical=SUPERSEDED`、`ever_authorized=true`、`authentication_state=NONE`、`authorization_state=NOT_GRANTED`、`recovery_policy=PERMITS_REAUTH`，期望 `integration_state=BLOCKED`、`credential_lost=true`、`blocking ⊇ {B1,B3,B9}`、≠ `REAUTH_REQUIRED`；以及同一 facts 但 `historical=NONE`、claim=`CURRENT_CLAIM_HOLDER` 的对照向量，期望 `REAUTH_REQUIRED`。P1 的谓词向量相应加入 `historical` 位。

| ID | 证明的 §42 条目（原文） | 方法 |
|---|---|---|
| T-A7-1 | “Profile 改变不会改变相同 Canonical truth facts 的 `integration_state`；” | P4；另以 `status(profiles=[A])` 与 `status(profiles=[B])` 对比 |
| T-A7-2 | “READY(profile)-specific verification 改变不会改变相同 Canonical truth facts 的 `integration_state`；” | P4：写 PASS / FAIL / 过期的 READY 验证行，以固定 `p_as_of` 求值，state 与 facts_sha256 不变 |
| T-A7-3 | “同一组合法 normalized truth facts + 同一 derivation contract → 同一状态；” | P3 |
| T-A7-4 | “每组合法 normalized truth facts 恰好派生一个状态；” | P1 + P2：`valid ⇒ state ∈ 10 值`，且谓词层恰一命中 |
| T-A7-5 | “Qualification 全阻断、Host / Adapter 全阻断、Candidate Set 为空、Identity Claim conflict / pending reconcile / superseded 等事实必须落到 `BLOCKED` 或更高优先级合法状态，不得无状态，也不得错误落到 `ACTIVE / DEGRADED`；” | P2：对 `qualification=SUSPENDED`、`host=HARD_UNAVAILABLE`、`adapter=BLOCKED`、`B8`、`claim∈{CONFLICT,PENDING,SUPERSEDED}` 的全部样本断言 `state ∈ {REVOKED, INCOMPATIBLE, REAUTH_REQUIRED, AUTH_PENDING, BLOCKED}`（`VERIFYING` 被 preclusion 排除），`≠ACTIVE/DEGRADED/INSTALLED/INSTALL_PENDING`。Candidate 为空按 OQ-1 的分阶段解释断言（`installed ∧ auth_ok ∧ cand=∅`）；另断言在任何阶段 cand=∅ 都不会得到 ACTIVE / DEGRADED |
| T-A7-6 | “`verification_precluded_by_blocking_fact = true` 与 Canonical Runtime Verification incomplete 同时成立时，必须稳定派生 `BLOCKED` 或更高优先级合法状态，绝不能派生 `VERIFYING`；” | P1/P2：`precluded ∧ crv≠VALID ⇒ state≠VERIFYING ∧ state ∈ {REVOKED, INCOMPATIBLE, REAUTH_REQUIRED, AUTH_PENDING, BLOCKED}` |
| T-A7-7 | “`VERIFYING` 必须证明 `verification_eligible = true`；” | 性质：`state=VERIFYING ⇒ predicates.verification_eligible = true`（输出中携带谓词） |
| T-A7-8 | “同一组 facts 不得因为实现先后顺序不同在 `VERIFYING` 与 `BLOCKED` 间漂移；” | P3 + 变异测试：测试构建一个把 VERIFYING / BLOCKED 分支顺序互换的派生副本，断言它在全部样本上与权威函数一致（证明互斥性不依赖顺序）；DB：同一 Integration 在不同事务顺序下写入相同 facts，结果相同 |
| T-A7-9 | “矛盾 derivation input 必须 fail closed，并产生 `DERIVATION_INPUT_INVALID` Evidence，而不是随意选状态。” | 对 C1–C10 每个码构造 facts：`valid=false`、state 为 null、effective=∅、READY=false；DB 层以 `session_replication_role=replica` 停用触发器制造 C4/C5（C2/C3/C6 只在 facts 层，§13.0），调用 status → 诊断行 + `integration_derivation_invalid` Receipt 各一条；以**不同**的 `p_as_of`（不跨越 TTL 边界）重复调用 → 同一 `facts_sha256`，occurrences+1，不重复 Receipt（MAJOR-3）；写路径把有效 Integration 变为无效或引入新 reason code → `derivation_input_invalid` rejected Receipt，业务行未变；对已无效 Integration 执行不增加 reason code 的修复操作 → 提交成功（MAJOR-4） |
| T-A7-10 | 结构验收：“integration_state is deterministic, derived, read-only, Profile-independent, and total …”【基线 §43】 | 静态：不存在任何名为 `integration_state` / `effective_capabilities` 的列；`integration_derive_v1` 为 immutable。测试创建一个无任何表权限的角色，**显式** `grant execute on function clued_private.integration_derive_v1(jsonb)`（以及它调用的 `integration_facts_validate_v1` / `integration_predicates_v1` / `integration_select_state_v1` / `integration_candidate_v1`）与 `usage on schema clued_private` 给该角色（§5.13 默认对所有角色 revoke，NIT-5），以该角色调用成功，证明函数不读表 |

### 13.3 G-A8 — Verification Separation

| ID | 证明的 §42 条目（原文） | 方法 |
|---|---|---|
| T-A8-1 | “Canonical Runtime Baseline Verification 与 READY(profile) Verification 使用不同 truth classes；” | 静态：两表 `verification_class` CHECK 互斥；`pg_depend` + `prosrc` 扫描证明 `integration_normalize_v1` / `integration_derive_v1` / `integration_candidate_v1` 不引用 READY 表；facts 模式拒绝 READY 键（C1） |
| T-A8-2 | “READY(profile) Verification 不得写入或覆盖 `canonical_runtime_verification_facts`；” | 执行 READY 验证（PASS / FAIL）前后，对 A 类表、`integrations_v1`、`integration_facts_v1`、Binding / Authorization 表做行哈希快照，必须完全相同；静态扫描 B 类写函数体中没有对这些表的 INSERT / UPDATE / DELETE；以 `kind:'ready_profile'` 伪造 `verification_class='CANONICAL_RUNTIME_BASELINE'` 的输入被 C1 / 22023 拒绝 |
| T-A8-3 | “同一 Canonical facts 下更换 READY Profile 不得改变 Canonical State。” | 同一 Integration 以同一个固定 `p_as_of` 分别对 profile X（要求 `context.read`）、Y（要求 `audit.read`，不在 effective 中）投影：READY 不同，`integration_state` 与 `facts_sha256` 相同；新增 profile 版本不改变 state |
| T-A8-4 | 基线 §20：“`BLOCKED` 不得投影为普通使用 READY” 等 | 对 8 个非 Operable 状态，即使存在 PASS READY 验证，READY=false；READY 验证在非 Operable 时被拒绝 |

### 13.4 G-A10 — Binding / Identity Claim

| ID | 证明的 §42 条目（原文） | 方法 |
|---|---|---|
| T-A10-1 | “同一 Installation Request 重放不会产生第二个 `integration_id`；” | (a) 同 `idempotency_key` 重放 5 次 → 同一 Receipt，`replayed=true`；(b) 新 `idempotency_key`、同 `request_id` + 同 intent 重放 → 同一 `integration_id`，Integration 总数 1；(c) Host / OAuth callback 重放（同 `request_key` 重新 open + bind）→ 同一 id；(d) 已 BOUND 的 Request 以不同 `binding_intent` 或不同调用方 Binding 再次 bind → `installation_request_bound_to_other_integration`（BOUND 判定先于 intent 比较，§10.3 第 2 步）；未 BOUND 的 Request 以不符的 `binding_intent` bind → `installation_request_intent_mismatch`；已 BOUND 的 Request 在 `expires_at` 之后同 intent 同调用方重放 → 仍返回同一 id（NIT-1）；v0.1.2（NIT-1）：B3 的 `REBIND` 被拒为需 Owner 确认、Owner `confirm_rebind(request_id, B3)` 之后，B3 以同一 Request、同一 intent 重放 → 返回同一 id（`bound_intent_sha256` 以被链接的 Binding 计算），另一 Binding 重放 → `installation_request_bound_to_other_integration`；(e) 两个连接对同一 Request **并发**重放 20 轮 → 恒为同一 id |
| T-A10-2 | “两个不同 Installation Request 对同一完整 Stable Identity Claim Key 并发 create-or-bind，不得产生两个同时 current 的 `integration_id`；” | (a) 随机交错：`test.complete` Host，两个连接各自 `BEGIN` 后以 `Promise.all` 调用 create_or_bind（不同 `request_id`，同一 key），重复 50 轮：`count(CURRENT claims for K)=1`，两个结果的 `integration_id` 相同（`CREATE` + `BIND_EXISTING`）；(b) 确定性交错：A 调用后不提交，B 调用阻塞（断言 `pg_stat_activity.wait_event_type` 为 `Lock` / advisory），A 提交后 B 返回 A 的 id；(c) A 回滚 → B 成为 `CREATE` 且是唯一 holder；(d) 用两个不同 Binding（同 OAuth client → 同 key）并发 |
| T-A10-3 | “Identity 维度 unavailable 时不得通过弱标识自动 merge；” | 两个 `anthropic.claude` Integration（account UNAVAILABLE），`source_provenance` 中 email / display name / vendor 完全相同 → 两个独立 `INCOMPLETE_UNCLAIMED` id；以 `evidence_kind ∈ {EMAIL, DISPLAY_NAME, HOST_UI_LABEL, …}` 提交维度 → `identity_weak_identifier_forbidden`；静态：claim key 函数输入不包含 provenance 字段 |
| T-A10-4 | “Integration 从 incomplete / unavailable Identity 变为 complete Stable Identity 时，ordinary runtime 继续前必须执行 atomic re-claim / reconcile；” | 带测试钩子的 Host：INCOMPLETE Integration 已 ACTIVE → identity_update 补全 → 同一事务内成为 `CURRENT_CLAIM_HOLDER`；facts 层构造 COMPLETE ∧ INCOMPLETE_UNCLAIMED → C2 → `DERIVATION_INPUT_INVALID`，effective=∅；DB 层在一次性测试库中 `drop constraint`（§5.2 完整性 / claim 状态 CHECK）后直接写成 COMPLETE 但不 claim → normalize 得 C2 → 同样 fail closed（MINOR-3：replica 模式不绕过 CHECK）；正常库中普通写路径不可能提交 COMPLETE ∧ INCOMPLETE_UNCLAIMED（CHECK + 写后有效性门） |
| T-A10-5 | “late identity strengthening 若碰撞到已有 current claim，必须证明最终最多只有一个 current claim holder，冲突方不得继续普通 runtime；” | holder H ACTIVE；I ACTIVE（incomplete）补全到 H 的 key → I `CLAIM_CONFLICT`、BLOCKED、effective=∅，H 不变；两个 incomplete Integration 并发补全到同一 key（50 轮）→ 恰一个 holder |
| T-A10-6 | “COMPLETE identity 的 claim-key 维度合法变化时，旧 claim 释放与新 claim 建立不得产生可观察的双-current窗口；” | A 在事务中执行 rebind（K1→K2）未提交时，观察者查询 K1 / K2 holder：只见旧状态；提交后只见新状态；任一时刻 `count(CURRENT where integration_id=I) ≤ 1`；竞争者在 A 提交前尝试 claim K1 会阻塞在 L4，A 提交后才能获得 K1；另断言 deferred 触发器在人为双 current 的事务上令提交失败（`identity_claim_store_divergence`） |
| T-A10-7 | “`CLAIM_CONFLICT / PENDING_RECONCILE / SUPERSEDED` 必须进入 Canonical `identity_claim_state`，并通过 Candidate Capability → `BLOCKED` → Operable=false → Effective Capability=∅ 的单链 fail closed；” | 对三种状态分别读取 `evaluation.predicates` 与链上各值：`identity_claim_blocks_ordinary_runtime=true`、`candidate=∅`、`state=BLOCKED`（或更高）、`operable=false`、`effective=∅` |
| T-A10-8 | “不允许仅依赖 Claim Store / request middleware / adapter side guard 阻止 ordinary runtime，而让 Canonical State 仍保持 `ACTIVE / DEGRADED`；” | 在 Worker 与数据库均无额外 guard 的配置下（flag on、无 enforcement）断言 claim 冲突的 Integration 的 Canonical state 已是 BLOCKED；静态：派生函数直接消费 `identity_claim_state` |
| T-A10-9 | “Claim Store current holder 与 Canonical `identity_claim_state` 不一致时必须 fail closed 并产生 Evidence / Receipt。” | replica 模式制造三种触发器层面的不一致（缺 CURRENT 行、键不符、非 holder 却有 CURRENT 行）→ `DERIVATION_INPUT_INVALID`（C4/C5）+ 诊断 + Receipt；“同一 Integration 多条 CURRENT 行”被唯一索引 `one_current_per_integration` 排除，只在一次性测试库 `drop index` 后构造（MINOR-3）；正常模式下同样的写在提交时被 deferred 触发器拒绝 |
| T-A10-11 | 安全负例（v0.1.1，MAJOR-1）：任何 Binding 不得夺取另一连接的 Integration | 同一 owner：I_claude（`anthropic.claude`，Binding B1，client C1）与 Binding B2（`openai.chatgpt`，client C2，scopes 更窄）。(a) B2 以 `REBIND` / `RECOVERY` / `ADAPTER_MIGRATION` / `REAUTHORIZATION` / `REINSTALL` / `VERIFICATION_REPAIR` / `BIND_CONNECTION` 指向 I_claude，Request `host='openai.chatgpt'` → `integration_host_mismatch`；Request `host='anthropic.claude'` → `integration_rebind_requires_owner_confirmation`；I_claude 的 current connection 仍为 B1、B1 未变 HISTORICAL、无业务写入；(b) 同 host、不同 client C3 的 Binding B3 → `integration_rebind_requires_owner_confirmation`；(c) 同 client C1 的新 Binding B1' → 允许（`link_authority='SAME_PROVIDER_CONNECTION'`）；(d) `clued.binding.v1` provider 下另一 raw Binding → 需确认；(e) Owner `confirm_rebind` 后 B3 成为 current connection（`NATIVE_OWNER_CONFIRMED`），并有 Receipt；(f) R=∅ 的 Native 创建 Integration：Native 打开的 `bind_connection` Request 可被 Binding 消费（`NATIVE_BIND_REQUEST`），Binding 自行打开的同 intent Request → 需确认；(g) v0.1.2（MINOR-N6）：Native Request 带 `expected_provider_connection_id = sha256(C1)` 时，client C3 的 Binding 消费 → `integration_rebind_requires_owner_confirmation`，C1 的 Binding 消费 → 成功；不带 pin 的 Request 的 `request_id` 不出现在任何 Binding 通道响应中（扫描 status / list / 错误 hint） |
| T-A10-12 | 冲突中不得靠改身份脱离（v0.1.2，MINOR-N5） | `test.*` Host（tenant 维度 REQUIRED，并在测试注册表中接受一种测试证据种类）：I 与 H 同 key，I 处于 `CLAIM_CONFLICT`；I 以 `REBIND` / `ADAPTER_MIGRATION` Request 把 tenant 降级为 UNAVAILABLE → `integration_claim_blocked`；identity_update 改为另一个 tenant 值（改变 key）→ `integration_claim_blocked`；`PENDING_RECONCILE` 同样；I 仍为 BLOCKED、`conflicting_integration_id` 不变；policy `PERMIT` 下 I 的 effective 仍为 ∅ |
| T-A10-13 | 同一 Binding 的并发调用不死锁（v0.1.4，MINOR-N13） | (a) 同一 Binding 对同一 Request 并发 `create_or_bind` 20 路 × 20 轮：无 `40P01`，恒为同一 `integration_id`；(b) 同一 Binding 并发 `revoke_self` ×10：恰一次 `REVOKED`，其余返回 `ALREADY_REVOKED` 或在锁下复核失败的 `binding_not_authorized`，无 `40P01`；(c) `revoke_self` 与同一 Binding 的 `create_or_bind`（REBIND）并发：一方先完成，另一方得到规定的拒绝码，无 `40P01`；(d) 静态：Integration 迁移中 Binding 通道 RPC 的函数体不调用 `resolve_binding` / `resolve_binding_action_v12`，对 `clued_agent_bindings` 只有一处 `for update`（`status` 为 `for share`） |
| T-A10-14 | Binding 所有权（v0.1.4，Owner Decision `c5574918`） | (a) 首次链接建立所有者行（`FIRST_LINK`）与所有权日志行；rebind 后旧 Binding 转为 HISTORICAL 且所有者不变；(b) 归 J 所有的 Binding 经 Binding 通道对 I 执行任何 intent → `binding_owned_by_other_integration`；(c) Owner `confirm_rebind` / `adopt_binding` 一个归 J 所有的 HISTORICAL Binding → 成功，所有者行 J → I、`version+1`，日志行与 Receipt `ownership_transfer`；随后 revoke J 不撤销它，revoke I 撤销它；(d) 同样操作针对 J 的 CURRENT connection → `binding_owned_by_other_integration`；(e) 并发：revoke J 持有该 Binding 的 L1 时，`confirm_rebind` 转移阻塞；revoke 先提交则转移因 Binding 已撤销被拒；(f) 静态：`integration_binding_owners_v1` 只由 §10.3 / §10.5 / §10.12 / §10.14 的函数写入，且写前持有 Binding 行 `FOR UPDATE`；(g) v0.1.5（NIT-4）首次所有权的 `acquired_via` 按路径取值：Binding 通道链接 `FIRST_LINK`、`confirm_rebind` 未拥有 Binding `NATIVE_OWNER_CONFIRMED`、`adopt_binding` `NATIVE_ADOPT`、Native / Operator restore `NATIVE_RESTORE` / `OPERATOR_RESTORE`、撤销清扫 `REVOCATION_SWEEP`，日志 `from_integration_id` 均为 null |
| T-A10-10 | 结构验收：“New Integration gets a stable integration_id before any Canonical Integration State is recorded”【基线 §43】 | 所有 fact / verification / claim / connection 表对 `integration_id` 有 NOT NULL FK；Request 表没有 `integration_state` 类列（只有与之不相交的 `request_status`）；create_or_bind 在同一事务中写 Integration 与 Request 绑定（中途失败注入 → 两者都不存在） |

### 13.5 G-A11 — Revocation / Reauth

§42 “G-A11 / G-B7 既有关键负例”中，“混合来源 Artifact 能逐 object class 回溯唯一 Authoring Authority”属于 G-B7（S4），不在 S2c 判定；S2c 判定 G-A11 条目。

| ID | 证明的条目 | 方法 |
|---|---|---|
| T-A11-1 | §42：“真正 Revocation 不能被 ordinary OAuth retry 清除；” | **固定为 `test.complete` Host + `clued.oauth.v12` provider（v0.1.1，MAJOR-6）**，使新 Binding 与原连接同一 client_id → 同一完整 claim key。ACTIVE → Native revoke → REVOKED，且链接 Binding 的 `revoked_at`、`authorizations_v12.revoked_at` 已设；随后模拟 Host 重新 OAuth（同一 client_id，`clued_authorization_approve_v12` 发放新 Binding），用新 Binding 以 `CREATE_OR_BIND`、`REAUTHORIZATION`、`REINSTALL`、`RECOVERY`、`REBIND`、`ADAPTER_MIGRATION`、`VERIFICATION_REPAIR` 逐一尝试 → 全部 `integration_revoked_requires_explicit_restore`（rejected Receipt），state 仍为 REVOKED；新 Binding 不能以同一完整 key 新建第二个 Integration（`CREATE_OR_BIND` 命中 REVOKED holder） |
| T-A11-1b | 同上，身份不完整时的预期（MAJOR-6） | `anthropic.claude`（account / tenant UNAVAILABLE → INCOMPLETE）+ `clued.oauth.v12`：I 被 revoke 后，新 Binding 以 `CREATE_OR_BIND` → outcome `CREATE`，得到**新的** I2（自己的 `integration_id`、自己的 `integration_create_or_bind` Receipt、自己的 `created_receipt_id`，状态从 INSTALL_PENDING / VERIFYING 开始，不继承 I 的验证、ceiling 或 claim）；I 保持 REVOKED、其 Binding 保持撤销；新 Binding 以 REBIND_CLASS 指向 I → `integration_revoked_requires_explicit_restore`。另以 `test.complete` + `clued.binding.v1` 验证：新 raw Binding 的 `provider_connection_id` 不同 → 新 key → `CREATE`（新 Integration），I 仍 REVOKED。三种预期都写入 gate 证据，结论表述为“REVOKED Integration 不被恢复”，而不是“不会出现新 Integration” |
| T-A11-2 | §39：不得因 Host cache / old Skill / stale App / reinstall / adapter reconnect 恢复 | 旧 Binding 调用任意既有工具 → 403（`binding_not_authorized`）；旧 Binding 调用 verify / declare → 403；Operator `reauth_clear` 不改变 REVOKED；v0.1.5（MAJOR-N5，Owner Decision `1b034f44`）：撤销前经同意页签发、**从未链接**的同 client Binding B_pre（例如 S2c 采纳前就存在的旧 grant，或一次未完成 rebind 的重连）在 Native revoke 后调用任意既有工具 → 403，且获得所有者行（`REVOCATION_SWEEP`，归 I），Receipt 的 `swept_unowned_binding_ids` 含 B_pre；另一 client 的未拥有 Binding、`t_rev` 之后新批准的同 client Binding 均不受影响；v0.1.6（MINOR-N22）：同 owner、同 client 的两个 INCOMPLETE Integration I、I2，给 I2 的重连授权 B_sib 已签发未链接；Native revoke I → B_sib 被清扫（403），Receipt 的 `swept_unowned_binding_ids` 含 B_sib 且其 `sibling_integration_ids` 含 I2；改为 `pause` I → B_sib 不受影响 |
| T-A11-3 | §39：显式 restore 产生新的 Receipt / Provenance | restore 使用撤销前的 Binding → `restore_requires_new_authorization_decision`；使用撤销后新授权的 Binding → regrant 行 + Receipt，state → VERIFYING（不是直接 ACTIVE），旧 Binding 仍被撤销；v0.1.2（MINOR-N2）：撤销前已有一个 open reauth mark → restore 清除它（`cleared_by='RESTORE'`，Receipt 列出 mark id），state 为 VERIFYING；restore 之后再由 Operator 打开的 mark 使结果为 REAUTH_REQUIRED；对 SUPERSEDED 的 REVOKED holder（经 `REPLACE_HOLDER` 被取代）restore → `integration_superseded` |
| T-A11-4 | §38 / §39：`credential invalid / expired but policy permits recovery → REAUTH_REQUIRED` | 令 `authorizations_v12.expires_at` 过去 → REAUTH_REQUIRED（无写入，读时派生）；Operator `reauth_mark` → REAUTH_REQUIRED；**`revoke_issuer_v12` → REVOKED**（`revocation_source=CONNECTION_USER_REVOKE`，≠ REAUTH_REQUIRED；v0.1.2 MAJOR-N1）；`recovery_policy=FORBIDS_REAUTH` 且过期 → BLOCKED；SUPERSEDED 且凭据丢失 → BLOCKED（MAJOR-2） |
| T-A11-4b | OQ-2 保守临时规则（MAJOR-6；v0.1.2 按 MAJOR-N1 重写） | (a) **真实 Host 断开路径**（`tests/integration-runtime-transport.test.mjs` 以 Worker + OAuth provider + 测试库运行）：`test.complete` + `clued.oauth.v12`，I ACTIVE；以该 DCR client 的凭据向 `POST /oauth/token` 发送 RFC 7009 撤销（form `token=<access 或 refresh token>`，无 `grant_type`）→ 断言 `authorization_audit_v12` 新增 `operation='revoke_issuer'`，I 的 state = REVOKED、`revocation_source=CONNECTION_USER_REVOKE`；同一 client_id 经同意页重新授权得到新 Binding，以 `REAUTHORIZATION` / `CREATE_OR_BIND` → `integration_revoked_requires_explicit_restore`，I 仍为 REVOKED（这就是 v0.1.1 会错误地自动清除的路径）；(b) 同样的预期分别用 `manage_v12 {op:'revoke'}`、直接调用 `revoke_self_v12`、以及直接设置 raw Binding `revoked_at`（无审计行）触发；(c) Native restore（新授权晚于撤销）→ 同一事务物化 `CONNECTION_REVOKE_ADOPTED` 行（`adopted_from.audit_operation` 分别为 `'revoke_issuer'` / `'revoke'` / `'revoke_self'` / null，`revoked_by` 分别为 `USER_VIA_HOST` / `USER` / `USER_VIA_HOST` / `USER`）+ regrant 行 + Receipt → VERIFYING；(d) 负例：Worker 刷新令牌轮换与过期清理**不**调用 `revoke_issuer_v12`（审计行数不变，state 按过期规则为 REAUTH_REQUIRED） |
| T-A11-5 | §38：“不得借重新 OAuth 自动扩大 Scope、Capability 或 Authority” | 以相同 scopes / entries 重新授权 → mark 清除，→ VERIFYING → ACTIVE；以**旧的**（`created_at` 早于 ceiling 设定）更大 scopes 的 v12 Binding 绑定 → `reauthorization_scope_expansion_forbidden`；同 scopes 但新增一条 `project:` resource entry 的旧 Binding → 同样拒绝（ceiling 覆盖 entries，MINOR-12）；在 v12 同意页新批准的更大授权（`created_at` 晚于 ceiling 设定）→ 接受，Receipt 含 `ceiling_before/after` 与 `AUTHORITY_EXPANDED_BY_CONSENT`；raw Binding 扩权 → 拒绝，Native `capability_expansion` 后接受 |
| T-A11-6 | §39：`REVOKED` 不得通过普通 `REAUTH_REQUIRED → OAuth` 路径自动清除 | 同时存在 open reauth mark 与 revocation：派生为 REVOKED（优先级）；清 mark 后仍 REVOKED |
| T-A11-7 | §16.3 优先级 | REVOKED 与 INCOMPATIBLE / claim conflict / expiry 并存时恒为 REVOKED |
| T-A11-8 | `revoke_self` 范围（MAJOR-1；v0.1.2 MINOR-N3） | I 的连接历史：B0（client C1）→ B3（client C3，经 Owner `confirm_rebind` 成为 current）→ B1（client C1，再经 Owner `confirm_rebind` 成为 current）；B0、B3 仍有效（HISTORICAL）：B1 `revoke_self` → 提交成功，`outcome=PARTIAL_CONNECTION_REVOKE`、`remaining_binding_count=1`，B0、B1 已撤销、B3 仍有效，无 revocation 行，I 派生 REVOKED（`CONNECTION_USER_REVOKE`）；随后 Owner Native revoke → 物化行，B3 被撤销（与 T-A11-11 同一机制）；无 B3 时 B1 `revoke_self` → 撤销 B0、B1，写 `INTEGRATION_REVOKE` 行，`outcome=REVOKED`；另一 Integration 的 current connection 调用 `revoke_self` 指向 I → `integration_connection_required`（403） |
| T-A11-9 | 撤销无条件 fail closed（MAJOR-4） | 以 replica 模式把 I 变为无效（C4 或 C5），`evaluate` 得 `DERIVATION_INPUT_INVALID`；Native revoke、Operator revoke、`revoke_self` 均提交成功：revocation 行存在、链接 Binding 全部撤销、既有工具 403；修复 claim store 后 state = REVOKED |
| T-A11-10 | 撤销 vs create_or_bind 并发（MAJOR-5；v0.1.2 MINOR-N1 / MAJOR-N2） | (a) 确定性交错：同 client 的新 Binding B2 对 I 执行 `REAUTHORIZATION` 已持有 I 的 L5 未提交；revoke 已锁定 S0={原 Binding}（L1/L2）并在 L5 上阻塞（`pg_stat_activity` 断言）；create_or_bind 提交（`integrations_v1.version` 已增加）后，revoke 返回 `integration_revoke_connection_set_changed`（revoke 不做 CAS，因此不会是 `integration_version_conflict`；无业务写入）；重试 revoke → B2 与原 Binding 均撤销；(b) 反序：revoke 先提交 → create_or_bind `integration_revoked_requires_explicit_restore`；(c) 随机交错 50 轮（失败即重试 revoke）：每轮结束时 revoke 已成功，因此断言 I 有 open revocation 行 ∧ `Rev(I) = ∅`（I 拥有的全部 Binding 与 `t_rev` 之前的未拥有同 client Binding 都已撤销；v0.1.4 所有权模型，v0.1.5 MAJOR-N5）；该不变量只针对显式 revoke 成功之后，仅由连接撤销派生的 REVOKED 由 T-A11-11 覆盖；(d) v0.1.3（NIT-4）：revoke 锁定 S0 后、取 L5 前，S0 的一个成员被并发 `manage_v12 revoke` 撤销 → S1 ⊊ S0，revoke 正常提交（不 abort） |
| T-A11-11 | 派生 REVOKED + 仍有效的 HISTORICAL Binding（v0.1.2，MAJOR-N2） | I：B_old（client C1，HISTORICAL，仍有效；由较早的 reauthorization 留下）、B_cur（client C1，CURRENT）。(a) 对 B_cur 执行 `revoke_self_v12`（另一例用 T-A11-4b(a) 的 `revoke_issuer` 路径）→ I 派生 REVOKED，无 revocation 行，B_old 仍能调用既有工具；(b) Native revoke → 提交成功，恰一条 open 行（`CONNECTION_REVOKE_ADOPTED`，`revoked_binding_ids = {B_old, B_cur}`），B_old 已撤销，B_old 调用任意既有工具 → 403；(c) 再次 Native revoke → `outcome=ALREADY_REVOKED`，无新写入；(d) 变体：(a) 之后先由 Operator `{op:'policy_pause'}` 成功提交 → 同一事务物化行（`revoked_binding_ids={B_cur}`，B_old 仍有效）；再 Native revoke → 同一行扩展为 `{B_cur, B_old}` 并撤销 B_old（不是 idempotent success）；全程 `integration_revocations_v1_one_open` 未被违反 |
| T-A11-12 | 撤销不越过 owner（v0.1.2，MINOR-N4） | 一次性测试库中以 replica 模式让 I 的一个 HISTORICAL connection 与一条所有者行（`integration_id = I`）指向另一用户的有效 Binding X（C7）：Native revoke 提交成功，X 的 `revoked_at` 与其 `authorizations_v12` 不变，Receipt 中 `foreign_binding_count=1`，owner 自己的 Binding 全部撤销 |
| T-A11-13 | reduce 降低 ceiling（v0.1.2，MINOR-N7） | I 的 current B1（scopes `context:read, context:write`），同 client 的旧 Binding B0 仍有效、权限相同；用户在 Clued 对 B1 执行 v12 `reduce`（去掉 `context:write`）；B0 以 `REAUTHORIZATION`（SAME_PROVIDER_CONNECTION）绑定 → `reauthorization_scope_expansion_forbidden`；以同意页新批准（晚于 reduce）的 Binding 绑定 → 接受，`AUTHORITY_EXPANDED_BY_CONSENT`；以权限不超过 reduce 后范围的新 Binding 绑定 → 接受，`authorization_ceiling` 落盘为 `C_eff`，`authorization_ceiling_set_at` = reduce 的 `recorded_at`；v0.1.3（MINOR-N11）HISTORICAL 变体：B0 是 I 的 HISTORICAL connection 时，用户对 B0 执行 `reduce` 收窄到与 B1 不相交的资源集 → current B1 的 SELF `VERIFICATION_REPAIR` / `REAUTHORIZATION` 仍被接受，`C_eff` 不变，open reauth mark 仍可被 B1 的新授权自动清除；同一 reduce 若发生在 B0 仍是 CURRENT 期间（`linked_at ≤ recorded_at < unlinked_at`）则计入 |
| T-A11-14 | 无效 facts 下的撤销守卫（v0.1.2，MINOR-N8） | 一次性测试库中令 I 既有 open revocation 行又处于 C5（replica 模式）：`evaluate` 得 `valid=false`、`integration_state=null`、`reason_codes ⊇ {C5_CLAIM_STORE_UNEXPECTED}`、`facts.revocation_state=REVOKED`；同 client 新 Binding 以 `REAUTHORIZATION` 绑定 → `integration_revoked_requires_explicit_restore`（不是因 `R1 ⊆ R0` 而提交）；connections 表无新 CURRENT 行 |
| T-A11-15 | 取代后的撤销范围（v0.1.3 MAJOR-N3；v0.1.4 所有权；v0.1.5 MINOR-N15） | `test.complete`：I 与 H 同 key，I `CLAIM_CONFLICT`，I 另拥有仍有效的 HISTORICAL B_old。(a) Native `reconcile REBIND_TO_HOLDER` → I 的 current B_I 成为 H 的 CURRENT connection（`NATIVE_RECONCILE`），B_old 也转移给 H（只转移所有权，H 上无 B_old 的 connection 行），Receipt 列出两条 `ownership_transfer`；I SUPERSEDED、`Owned(I)=∅`；H verify → ACTIVE；Native revoke I → 提交成功，不撤销任何 Binding（`UnownedLineage(I)=∅`，因为 I 已被取代），H 仍 ACTIVE；随后 revoke H → B_I 与 B_old 都被撤销。(b) `REPLACE_HOLDER`（I 为存续方）：H 的 CURRENT `b_H` 先解除为 HISTORICAL，再与 H 拥有的其他未撤销 Binding 一起转移给 I；H SUPERSEDED 且无 current connection；revoke I → `b_H` 被撤销，调用既有工具 → 403；(c) v0.1.6（MINOR-N20）/ v0.1.7（MINOR-N24，随 PR-4）H 仅由连接撤销派生 REVOKED（`revoke_issuer`），另有 **H 拥有**、仍有效的 HISTORICAL B_oldH（v0.1.8 NIT-4：与表头中 I 拥有的 B_old 区分）与未链接的撤销前同 client B_pre：`REPLACE_HOLDER` → 同一事务内**一次**插入 H 的物化行，`revoked_binding_ids = {b_H, B_oldH, B_pre}`，`extended_receipt_ids` 为空，operation log `RECONCILE_REVOKE`；B_oldH 与 B_pre 被撤销且**留在 H 名下**（B_pre 为 `REVOCATION_SWEEP` 归 H），无所有权转移给 I；B_oldH 以 SAME_PROVIDER `REBIND` 指向 I → 403；(d) 存续方 I 已撤销 → `integration_revoked_requires_explicit_restore`，所有权与 connection 均不变；(e) v0.1.7（MINOR-N24，随 PR-4）：H 已被显式撤销（有 open 行，`Rev(H) = ∅`）→ `REPLACE_HOLDER` 成功，H 的撤销行完全不变（无扩展、无触发器错误），无撤销写、无所有权转移（PR-2 的临时拒绝由 PR-2 门控测试 T-A11-26 验证，v0.1.8 NIT-3） |
| T-A11-16 | 不能分叉逃避撤销（v0.1.4 MAJOR-N4；v0.1.5 MAJOR-N5 / NIT-6） | `anthropic.claude`（INCOMPLETE）+ `clued.oauth.v12`，Worker 同 client 重新授权不撤销旧 grant（`revokeExistingGrants:false`）：**Path 1**：I 的旧 Binding B_old（HISTORICAL，仍有效，归 I）以 `CREATE_OR_BIND` → `binding_owned_by_other_integration`，Integration 总数不变；B_old 以 `REBIND` 回到 I → 允许（归 I，SAME_PROVIDER_CONNECTION）。**Path 1b**（NIT-6，改在 `test.complete` 上运行，因为 INCOMPLETE 身份不会出现 `BIND_EXISTING`）：归 I 的 B_old 以 `CREATE_OR_BIND` 命中另一 holder → `binding_owned_by_other_integration`。**Path 2**：B_old `REBIND` 到 I（B_cur 转为 HISTORICAL，仍归 I）→ B_cur 以 `CREATE_OR_BIND` → `binding_owned_by_other_integration`。**Path 3（v0.1.5，MAJOR-N5）**：撤销前签发、从未链接的同 client Binding B_pre：(i) Native revoke I 之后 B_pre 以 `CREATE_OR_BIND` → 认证失败 403（已被清扫撤销）；(ii) 只在 Host 中断开（`revoke_issuer`，I 派生 REVOKED、无撤销行、B_pre 未被清扫）之后，B_pre 以 `CREATE_OR_BIND` → `binding_predates_revocation`，Integration 总数不变；断开之后才经同意页批准的 B_new 以 `CREATE_OR_BIND` → `CREATE`（新 J，新授权决定，与 T-A11-1b 一致）。所有路径之后：Native revoke I（或 B_old 的 `revoke_self`，同 client → S1 ⊆ LINEAGE）→ B_old、B_cur、B_pre 都已撤销，调用任意既有工具 → 403；全程没有任何 Binding 的所有者行离开 I |
| T-A11-17 | 已撤销的 I 不能 `REBIND_TO_HOLDER`（v0.1.3，MAJOR-N3 / NIT-9） | fixture（v0.1.8 NIT-6）：`test.complete` + `clued.oauth.v12`（`clued.binding.v1` 下新 raw Binding 必然改变 key，K = K0 不可能）。(a) I `CLAIM_CONFLICT` 且有 open revocation 行 → `REBIND_TO_HOLDER` 被拒为 `integration_revoked_requires_explicit_restore`，H 的 CURRENT connection 不变、H 仍 ACTIVE；(b) I 的 current Binding 经 `revoke_issuer` 撤销（派生 REVOKED，无行）→ 同样拒绝，且拒绝不留下物化行；(c) I 没有 CURRENT connection → `reconcile_requires_active_connection`；(d) I 的 current Binding 已过期 → `reconcile_requires_active_connection`；(e) v0.1.6（MINOR-N20）/ v0.1.7（MAJOR-N23）：上述 (a) 情形下 `REPLACE_HOLDER`（I 为存续方）被拒为 `integration_revoked_requires_explicit_restore`；Owner 以**同一 client** 的新授权 restore I（K = K0，restore 提交成功，I 变为 NOT_REVOKED；v0.1.8 MINOR-N27：I 仍为 `CLAIM_CONFLICT`、`conflicting_integration_id` 不变，Receipt 中**没有** `CLAIM_CONFLICT_AFTER_RESTORE`，claim store 无写入）；随后 `REPLACE_HOLDER` 成功（I 取得 claim，H SUPERSEDED）；PENDING_RECONCILE 变体（v0.1.8）：I 先经 `reconcile_request` 进入 `PENDING_RECONCILE` 再被撤销，同一 client restore 后 I 仍为 `PENDING_RECONCILE`（不回到 `CLAIM_CONFLICT`）、`conflicting_integration_id` 不变、无该 flag；(f) v0.1.7（MAJOR-N23）：同一情形下以另一 client C2 的新授权 restore（K ≠ K0）→ `integration_claim_blocked`，无业务写入，I 仍 REVOKED；`FORBIDS_REAUTH_RECOVERY` 用单独 fixture（v0.1.8 NIT-6）：未撤销、`recovery_policy = FORBIDS_REAUTH`、凭据已丢失（B9）、处于 `CLAIM_CONFLICT` 的 I，restore → `integration_claim_blocked` |
| T-A11-18 | 物化行的时间与物化者无关（v0.1.3，MINOR-N10） | 用户在 t0 于 Host 断开（`revoke_issuer`），t1 经同意页重新授权得到 B_new（其 bind 被拒，不物化）；t2 Operator `policy_pause` 成功提交并物化行：断言行 `revoked_at = t0`（审计 `recorded_at`），Receipt 含 `{role:'revocation'}` 与 `REVOCATION_MATERIALIZED`；随后以 B_new restore → 成功（`t_loss = t0 < t1`）；对照：不经 t2 直接 restore 得到相同的 `revoked_at` 与结果；扩展变体（v0.1.7，MINOR-N26）：fixture 另含 I 拥有、仍有效的 HISTORICAL B_old，从 t2（`policy_pause` 物化行）之后、restore 之前分支（v0.1.8 NIT-5：不经 t2 时 Owner revoke 会自己一次插入行，`extended_receipt_ids` 为空）；Owner revoke（`t_cut = t0`）扩展该行为 `{B_cur, B_old}`，`revoked_at`、`revoked_by` 不变，`extended_receipt_ids` 含该 revoke 的 Receipt，B_old 被撤销，而 B_new（`t1 > t0`，未链接）**未**被触及、仍可调用既有工具；已 restore 的行不能再被扩展（触发器拒绝） |
| T-A11-19 | restore 的 provider 与身份规则（v0.1.3，MINOR-N12） | `clued.oauth.v12` 的 REVOKED I：以 raw Binding restore → `integration_provider_mismatch`，无业务写入；以另一个 v12 client C2 的新 Binding restore（`test.complete`）→ 新 identity snapshot、`provider_connection_id = sha256(C2)`，旧 key 释放、新 key 声明（同事务，`count(CURRENT claims for I) = 1`）；新 key 已被 H 持有 → restore 提交，I 为 `CLAIM_CONFLICT` / BLOCKED，Receipt 含 `CLAIM_CONFLICT_AFTER_RESTORE`；并发：restore 持有 L1(新 Binding) 时，另一 Integration 以该 Binding `CREATE_OR_BIND` 阻塞，restore 提交后返回 `binding_owned_by_other_integration`（该 Binding 已归 I）；v0.1.4（MINOR-N14）：restore 的 Receipt 含 `ceiling_before` / `ceiling_after`，新授权更宽时带 `AUTHORITY_CHANGED_BY_RESTORE`；以归 J 所有且是 J 的 CURRENT connection 的 Binding restore → `binding_owned_by_other_integration`；以归 J 所有的 HISTORICAL Binding restore → 成功并记录 `ownership_transfer` J → I，之后 revoke J 不撤销它；v0.1.5（MINOR-N17）：Operator restore 指定归 J 所有的 HISTORICAL Binding → `binding_owned_by_other_integration`（Operator 不转移所有权），指定未拥有的 Binding → 成功，所有者行 `acquired_via='OPERATOR_RESTORE'`、新 connection 行 `link_authority='OPERATOR_RESTORE'`（v0.1.7 NIT-6；Native restore 的对照为 `NATIVE_RESTORE`），日志 `from_integration_id = null`；v0.1.6（MINOR-N21）：以 client C2 的新 Binding restore 时，`t_loss` 之前签发、未链接的 C2 授权**不**被清扫（`Lin*(I)` 在链接新 connection 之前求值，C2 不在其中） |
| T-A11-20 | `REBIND_TO_HOLDER` 的接收守卫（v0.1.4，MINOR-N14） | I 与 H 同 key：(a) I 的 Binding b 的 authority 宽于 `C_eff(H)`，且 b 的授权早于 H 的 ceiling 设定 → `reauthorization_scope_expansion_forbidden`，无业务写入、所有权不变；(b) b 的授权晚于 H 的 ceiling 设定（fresh consent）→ 接受，Receipt 含 `ceiling_before/after` 与 `AUTHORITY_EXPANDED_BY_CONSENT`；(c) H `recovery_policy=FORBIDS_REAUTH` 且已授权过 → `integration_recovery_forbidden`；(d) 成功路径：新 connection 行 `link_authority='NATIVE_RECONCILE'`；H 的 `first_authorized_at` 为 null 时被设置；H 上早于 b 授权的 open reauth mark 被清除（`REAUTHORIZATION_REBIND`），晚于的保留 |
| T-A11-21 | restore 撤销旧凭据（v0.1.5，Owner Decision `1b034f44` 第 2 条，MINOR-N16） | I 的 current B_cur、HISTORICAL B_old（同 client，仍有效），以及从未链接的同 client B_pre（签发于断开之前）；用户在 Host 中断开（`revoke_issuer` 撤销 B_cur）→ I 派生 REVOKED；Owner 以断开后新批准的 B_new restore → 同一事务内 B_old 与 B_pre 被撤销（B_pre 获得 `REVOCATION_SWEEP` 所有权），operation log `RESTORE_SWEEP` 列出二者，Receipt 列出；之后 B_old 以 `REBIND`（SAME_PROVIDER）指向 I → 认证失败 403；I 为 VERIFYING，`Owned(I)` 中只有 B_new 未撤销；并发：restore 持有 B_old 的 L1 时，B_old 的 `REBIND` 阻塞，restore 提交后失败；v0.1.6（MINOR-N21）：`FORBIDS_REAUTH_RECOVERY` 变体（凭据过期、无撤销）：restore 撤销 `Owned(I) \ {B_new}`（含 B_old），**不**清扫未链接的同 client B_pre，B_pre 仍可调用既有工具 |
| T-A11-22 | 撤销清扫的并发边界（v0.1.5，MAJOR-N5） | (a) 未拥有的同 client B_pre 以 `CREATE_OR_BIND` 已持有其 L1 未提交时，Native revoke I 在 B_pre 的 L1 上阻塞；create_or_bind 先提交（B_pre 归新 J）→ revoke 的 S1 ⊊ S0，提交成功且不撤销 B_pre（按提交顺序线性化在撤销之前）；反序：revoke 先提交 → create_or_bind 在锁下复核认证失败 403；(b) 撤销执行期间提交的新同意（`created_at > t_rev`）不在 S1 中、不被撤销，且之后可以 `CREATE_OR_BIND`（不触发 `binding_predates_revocation`）；(c) `revoke_self` 的 LINEAGE 包含与调用方同 client 的未拥有 Binding，不包含其他 client 的未拥有 Binding |
| T-A11-23 | 撤销与并发同意（已知边界 1，v0.1.6 NIT-8） | `anthropic.claude`（INCOMPLETE）+ `clued.oauth.v12`；在第二个 embedded-postgres 连接中开启事务调用 `clued_authorization_approve_v12` 插入同 client 授权并保持未提交（`created_at ≤ t_rev`；v0.1.7 NIT-4：不需要额外测试钩子），同时让 Native revoke I 运行完成，再提交该同意得到 B_late：B_late 调用既有工具成功（记录为已知边界）；B_late 以 `CREATE_OR_BIND`（INCOMPLETE Host，否则会先命中已撤销的 holder）→ `binding_predates_revocation`；B_late 以 `REBIND` 指向一个未撤销的同 client 兄弟 Integration → `binding_predates_revocation`（指向 I 本身会先在 §10.3 第 6 步得到 `integration_revoked_requires_explicit_restore`）；随后 Operator 再次 revoke I（`t_cut = rev_at(I)`）→ B_late 被清扫、403；另一例改为 restore（`REVOCATION`）→ B_late 被清扫 |
| T-A11-24 | 重复撤销的截止时间（v0.1.6，MINOR-N18） | `anthropic.claude` + `clued.oauth.v12`：t0 用户在 Host 中断开（I 派生 REVOKED）；t1 在同意页重新批准得到未链接的 B_new；t2 Owner Native revoke I → 物化行 `revoked_at = t0`，Receipt `t_cut = t0`，B_new **未**被清扫、仍可调用既有工具；随后以 B_new restore → 成功（`t_loss = t0 < t1`），I → VERIFYING；另一例（v0.1.7 NIT-5，确定性 fixture）：I 在 t_r 被 Native revoke（open 行 `revoked_at = t_r`，`Rev(I) = ∅`），t_a > t_r 时同 client 新批准得到未链接的 B_after；Operator 再次 revoke I → `outcome = ALREADY_REVOKED`，行不变，B_after 未被清扫、仍可调用既有工具；对照：首次撤销（NOT_REVOKED → 新行）以 `t_rev` 为截止，行的 `revoked_at = t_rev` |
| T-A11-25 | 取代链上的血缘（v0.1.6，MINOR-N19） | `test.complete`：Y 的历史 client C3 来自跨 client `confirm_rebind`；Y 经 `REPLACE_HOLDER` 被 X 取代；C3 的未链接授权 B_c3 签发于 X 撤销之前：revoke X → B_c3 被清扫（`Lin*(X) ⊇ Lin(Y)`）；X 已撤销、B_c3 若在撤销后未被清扫（例如仅派生撤销）以 `CREATE_OR_BIND` → `binding_predates_revocation`（O7 用 `Lin*`）；另一例：T-A11-15(a) 中对已取代 I 的撤销之后，H 的同 client 重连授权（签发早于该撤销）链接到 H → 允许（O7 排除 SUPERSEDED 的 X） |
| T-A11-26 | PR-2 临时拒绝（v0.1.8 NIT-3，MINOR-N25；只在 PR-2 构建中存在，PR-4 删除本测试） | `test.complete`：I 与 H 同 key、I `CLAIM_CONFLICT`；fixture 直接插入 H 的 open revocation 行（显式 revoke 在 PR-4 才交付）；`REPLACE_HOLDER` → `integration_revoked_requires_explicit_restore`，无业务写入；H 未撤销时 `REPLACE_HOLDER` 成功 |

### 13.6 G-A9 — 生命周期运行时闭环（提议判据）

§42 未定义 G-A9 专属负例【基线 §42.0】。本规格提议以下判据全部 PASS 即视为“生命周期运行时闭环”，需 Owner / 评审确认（OQ-20）：

| ID | 判据 | 方法 |
|---|---|---|
| T-A9-1 | 无 `integration_id` 则无 Canonical Integration State【§14.1】 | 静态：Request 状态值域与 10 个状态不相交；任何表都没有无 `integration_id` 的状态 / fact 行 |
| T-A9-2 | Binding 发起的完整路径 | open → create_or_bind（`installation_phase=STARTED`）= INSTALL_PENDING → `lifecycle installation_completed` → VERIFYING → verify baseline → ACTIVE → report DEGRADED → DEGRADED |
| T-A9-3 | Native 发起的完整路径（S6 Connect 的前置） | Native 打开 Request（`provider='clued.oauth.v12'`）→ Native create_or_bind（无连接；`connection_status=UNAVAILABLE`，INCOMPLETE）= INSTALL_PENDING → installation_completed = AUTH_PENDING → Native 打开 `bind_connection` Request，Binding 以 `BIND_CONNECTION` 消费（`NATIVE_BIND_REQUEST`）= VERIFYING（`connection_status` → VALUE，`test.complete` 上成为 COMPLETE → re-claim）→ verify → ACTIVE；以 `clued.binding.v1` Binding 消费 → `integration_provider_mismatch`（MINOR-9） |
| T-A9-4 | 10 个状态全部可达，且每个状态至少由一条真实 RPC 序列（不是直接写表）达到 | 覆盖断言；INSTALLED 使用 `test.noauth` Host |
| T-A9-5 | Request 的 close / expire / archive 不改变 Integration【§14.6】 | 比较前后 `integrations_v1` 行、facts_sha256 与 state |
| T-A9-6 | rebind / reauthorization / reinstall / recovery / adapter_migration / verification_repair 不重置为 INSTALL_PENDING【§14.2】 | 每个 intent 一例：state ∈ {VERIFYING, REAUTH_REQUIRED, BLOCKED, DEGRADED, ACTIVE}，`install_status` 不回退 |
| T-A9-7 | 升级【§37】 | adapter_version 变化 → VERIFYING，scope / ceiling 不变，无 REAUTH；测试插入 `integration_compatibility_rules_v1` 行（`min_adapter_version`，`below_minimum='HARD_INCOMPATIBLE'`，MINOR-8）后低于最低版本 → INCOMPATIBLE；再升级 → VERIFYING → ACTIVE；`below_minimum='DEGRADED'` 规则 → DEGRADED（mask 生效） |
| T-A9-8 | 暂停 / 恢复 | owner pause → BLOCKED，effective=∅；resume → ACTIVE（验证仍有效）；owner 不能 resume policy pause |
| T-A9-9 | Supersede 终止 | reconcile `REBIND_TO_HOLDER` 后，旧 Integration I：`identity_claim_state=SUPERSEDED`、`historical=SUPERSEDED`、`predicates.credential_lost=true`、`integration_state=BLOCKED`（**不是** REAUTH_REQUIRED，v0.1.1 MAJOR-2；对应 golden vector `GV-SUPERSEDED-CREDENTIAL-LOST`）；对其 verify（`verification_not_eligible`）/ declare / 任一 REBIND_CLASS 绑定（`integration_superseded`）都不能回到 ACTIVE / DEGRADED / REAUTH_REQUIRED【§15.2】 |
| T-A9-10 | 转移表完备 | 测试维护“(状态, 操作) → 允许的结果状态”表；对每个状态执行每个操作，结果状态必须在表内或是规定的拒绝码；每个成功写都有 Receipt，且 `integration_operation_log_v1` 含 §14.3 的全部字段（actor、request_id、integration_id、identity snapshot、operation type、provenance、result、Receipt、timestamp） |
| T-A9-11 | 采纳既有 Binding 不静默批量提升 | 迁移后 Integration 数为 0；adopt 逐个生效，每个一条 Receipt；未采纳 Binding 的既有工具行为不变；P5 租户 Binding（含 `role='denied'`）adopt / create_or_bind → `binding_not_adoptable`，且不出现在 `binding_inventory`（MINOR-1） |
| T-A9-12 | `FORBIDS_REAUTH` 在写路径生效（MINOR-7；v0.1.2 MINOR-N2 / NIT-6） | Operator 设 `recovery_policy=FORBIDS_REAUTH`；令凭据过期 → BLOCKED（B9）；同 client 新 Binding 以 `REAUTHORIZATION` / `REBIND` / `RECOVERY` → `integration_recovery_forbidden`，state 仍 BLOCKED；以早于 `t_loss`（过期时间）的授权 restore → `restore_requires_new_authorization_decision`；Native restore（`restore_kind='FORBIDS_REAUTH_RECOVERY'`，新授权晚于 `t_loss`）→ regrant 行 + Receipt → VERIFYING；变体：过期前 Operator 打开过一个 reauth mark → `t_loss` 取 mark 的 `raised_at` 与过期时间中较晚者，restore 同时清除该 mark（`cleared_by='RESTORE'`）→ VERIFYING（不是 BLOCKED）；对 `historical=SUPERSEDED` 且 `FORBIDS_REAUTH` 的 Integration restore → `integration_superseded`；健康的 `FORBIDS_REAUTH` Integration 上 Owner `confirm_rebind` → `integration_recovery_forbidden`，Owner 先 `revoke` 再以新授权 `restore` → 成功，两步各一条 Receipt |

### 13.7 结构、权限与“不改变既有对象”

| ID | 断言 |
|---|---|
| T-S-1 | 每个新表 RLS 已启用、对 `public, anon, authenticated, service_role` 无权限；序列同样 |
| T-S-2 | 每个 `clued_private.integration_*` 函数对上述角色无 EXECUTE；**只应用 S2c 迁移**的库中，Integration public RPC 对 `public, anon, authenticated, service_role` 均无 EXECUTE（MINOR-11）；测试施加目标 grant 后恰为 §5.13 所列 |
| T-S-3 | 应用 S2c 迁移前后，所有既有函数的 `pg_get_functiondef` 哈希、既有表列定义、既有 policy / grant 完全相同 |
| T-S-4 | 带 Binding 数据的库应用 S2c 迁移后 `integrations_v1` 为空 |
| T-S-5 | Binding 通道 RPC 在未提供有效令牌哈希时不读不写任何 Integration 行（403 前无副作用） |
| T-S-6 | Integration 操作不改变 resume 输出、work log、checkpoint 待吸收计数、capture 状态、五视图投影与导出（若启用 Event，见 OQ-15） |
| T-S-7 | 既有 `migration-contract.test.mjs` 与全部既有测试通过 |

### 13.8 Worker / 传输

| ID | 断言 |
|---|---|
| T-W-1 | flag off：`tools/list` 与 baseline 逐字节相同；8 行 flag 矩阵工具数符合 §12.6 |
| T-W-2 | flag off：bootstrap JSON 与 main 相同；`/v1/integrations*` → 404；Integration 工具名 → 404 “Unknown …” |
| T-W-3 | flag on：7 个工具的注解、`_meta` 与 §12.2 一致；既有工具定义不变 |
| T-W-4 | 错误分类穷尽：扫描 Integration 迁移中所有 `42501` 的 raise code，每个都恰好属于授权集合或 `REQUEST_RULE_REJECTIONS`；每个规则码在两种传输（raise / rejected envelope）下都渲染为 `category:'request_rule'`；授权码保持 HTTP 403 |
| T-W-5 | `clued_integration_verify` 的 `transport` 由 Worker 注入，调用方同名字段被覆盖 |
| T-W-6 | 非 `clued_bnd_` 令牌调用 Integration 工具 → 403 |

---

## 14. 交付计划

### 14.1 PR 序列

每个 PR 独立可测、只新增对象、不修改既有迁移。迁移时间戳是占位，必须在 PR 创建时重新取值，严格晚于当时 main 上（以及已知待合入 PR 中）最新迁移，并与 M0-D、S2a 等其他线协调，避免同名或乱序。v0.1.5（NIT-1）：`origin/main` = `cf1a2809`（PR #334 已合入），其上最新迁移为 `20260925030000_search_context_cross_scope.sql`；`20260925040000_search_context_followups.sql` 由 PR #335 占用（`origin/claude/dreamy-shannon-hffhqh` tip `a6728b90`，尚未合入；v0.1.6 NIT-1）。占位仍从 `20260926000000` 起，并保留“PR 创建时按当时 main 与已知待合入 PR 重新取值”的规则。

| PR | 内容 | 迁移（占位名） | 证明 |
|---|---|---|---|
| PR-0 | 将本规格（评审后）放入 `development/contracts/integration-runtime/IntegrationRuntime.v0.1.md`；根 `AGENTS.md` 只加一行指针（若需要） | — | Owner / 评审 |
| PR-1 | 注册表（含 compatibility rules）、词表、scope map、policy v1；纯函数 `integration_facts_validate_v1`、`integration_candidate_v1`、`integration_predicates_v1`、`integration_select_state_v1`、`integration_derive_v1`、`integration_version_cmp_v1`；`integration_capabilities_valid_v1`、`integration_ceiling_valid_v1`（v0.1.2）；golden vectors | `20260926000000_integration_runtime_registry_derivation.sql` | G-A3 与 G-A7 的**纯函数 / 性质层**（T-A3-1…6 的性质部分、T-A7-3…9 的函数层、P1/P2/P3/P5）、T-A7-10、T-S-1/2/3。T-A3-1/3/6 的 DB 部分需要 PR-2 的表，移到 PR-2 |
| PR-2 | `integrations_v1`、identity snapshots、Installation Requests、Claim Store + deferred 一致性触发器、connections、Binding 所有权表与所有权日志（v0.1.4）、operation log、diagnostics；revocation / regrant / reauth mark 三张表及其不可变触发器与读侧 `integration_revocation_status_v1`（规范化与 §10.3 第 6 步守卫需要它们；写操作在 PR-4，v0.1.2）；§10.1 连接撤销物化；`REPLACE_HOLDER` 遇到已撤销的 H 暂时拒绝（v0.1.7 MINOR-N25，PR-4 移除；门控测试 T-A11-26，v0.1.8 NIT-3）；`integration_normalize_v1` / `integration_evaluate_v1`；request_open、create_or_bind（含 Rebind 授权与写后有效性门）、confirm_rebind、identity_update、reconcile、adopt_binding、binding_inventory、status（不含 READY）；Receipt families；Event 影响评估（OQ-15） | `20260926010000_integration_runtime_identity_claim.sql` | G-A10（T-A10-5、T-A10-7 中需要 ACTIVE 前置的用例在 PR-3 合入后补跑）、T-A3-1/3/6 的 DB 部分、T-A9-1、T-A9-11、T-S-4/5/6。**不**含 T-A7-1/2（它们需要 PR-3 的 READY 表） |
| PR-3 | A/B 验证表与写 RPC、READY profiles、`integration_ready_project_v1`、READY 投影 Receipt；declare、report、fact_set | `20260926020000_integration_runtime_verification.sql` | G-A8 全部、T-A7-1/2（DB 部分，P4）、T-A9-7 |
| PR-4 | Revocation / regrant / restore / reauth mark / capability_expansion / lifecycle 操作；Operator 入口 | `20260926030000_integration_runtime_revocation_lifecycle.sql` | G-A11（T-A11-3、T-A11-5 需要 PR-3 的 `verify`）、§10.5 `REPLACE_HOLDER` 规则 2（已撤销的被取代方）与 T-A11-15(c)(e)（v0.1.7 MINOR-N25）、T-A9-2（v0.1.2 MINOR-N9：它用到本 PR 的 `lifecycle installation_completed`，因此从 PR-3 移入）、G-A9 其余判据 |
| PR-5 | Worker：`integrations.ts`、flag、工具注册（按 S2a 注册表状态）、REST、bootstrap 块、错误映射、`REQUEST_RULE_REJECTIONS` 追加、flag 矩阵 8 行、`tool-versions.json` | 无 | T-W-1…6；T-A11-4b(a)(d)（经 Worker 的真实 `/oauth/token` 撤销路径，v0.1.2；(b)(c) 属 PR-4）；`public-mcp-protocol` workflow 通过且 baseline 未变 |
| PR-6 | Gate 证据：`apps/clued-cloud/evals/integration-runtime/gate-evidence.mjs` 运行全部 S2c 测试，生成机器证据 JSON（测试 ID → gate 条目 → 结果、commit SHA、种子、样本数），供 G-A3/7/8/9/10/11 判定 | 无 | 证据文件本身 |

依赖（v0.1.1，MINOR-10）：PR-1 → PR-2 → PR-3 → PR-4 → PR-5 → PR-6，严格串行：PR-4 的 T-A11-3 / T-A11-5 需要 PR-3 的 `verify` 才能从 VERIFYING 推进到 ACTIVE，PR-3 与 PR-4 不能并行合入。PR-4 的代码可以与 PR-3 并行编写，但必须在 PR-3 合入后基于新 main 重跑全部测试再合入。PR-5 可在 PR-2 之后先交付工具骨架，但 flag 始终默认关闭，且不施加数据库 grant。

每个 PR 的通用要求：dirty-worktree gate、fetch+merge 后推送、PR 描述写明 base SHA、所列测试结果与“未改变既有对象”证明（T-S-3）；不部署、不应用生产迁移。

### 14.2 生产前置（不属 S2c）

迁移应用到生产、Worker 部署、flag 开启、数据库侧 grant 开放（OQ-21 默认延后，见 §5.13）、首批 Binding 采纳，都需要各自的阶段授权；按基线 §54，从 main 部署 Worker 会一并带上 M0-D 内容，发布批次须列入阶段授权包。

---

## 15. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 真实 Host 很少提供可验证的 `host_account_id` / 租户 ID，导致生产 Integration 长期处于 `INCOMPLETE_UNCLAIMED`，跨 Request 去重只在 `test.complete` 上生效；撤销后同一 Host 的新 OAuth 会得到新的 Integration（T-A11-1b） | 基线允许显式分离；OQ-4 请 Owner 决定 S3 前是否接受某种 Host 断言（P5 `workspace_id` 可作为候选评估）；policy v1 对 INCOMPLETE 允许普通运行时（OQ-3），因此不影响可用性。G-A11 证据如实区分 COMPLETE 与 INCOMPLETE 两种预期（MAJOR-6） |
| R2 | 审计型扩展 Event 可能计入 checkpoint 待吸收事件或 capture 状态，改变既有会话行为 | PR-2 先做 T-S-6；不满足则改为只写 Receipt（OQ-15） |
| R3 | 迁移时间戳与 M0-D 等并行线冲突或乱序 | 占位名；PR 创建时重取并在描述中登记；测试按排序应用全部迁移 |
| R4 | 连接级撤销的语义（REAUTH_REQUIRED 还是 REVOKED）可能与用户意图不符；审计行无法区分“用户在 Host 中断开”与 Host 的例行撤销（v0.1.2，MAJOR-N1） | 临时规则取保守方向：current connection 的任何连接级撤销（Clued 连接管理页 `revoke`、Host RFC 7009 断开 `revoke_issuer`、`revoke_self`、无法归因）→ REVOKED，需在 Clued 中显式 restore；只有过期与 reauth mark → REAUTH_REQUIRED（§7.2、§10.11）。代价：用户在 Host 中断开后重连需要在 Clued 中 restore；Host 若出于例行原因（例如自身卸载、账号登出清理）在**链接新连接之前**撤销当前 token，也会得到 REVOKED 并需要 restore（先链接新连接、后撤销旧 token 的 Host 不受影响，因为只看 current connection）。v0.1.1 此处写的“只有 `revoke_issuer` → REAUTH_REQUIRED”建立在错误的仓库事实上，已更正。OQ-2 裁定可放宽 |
| R5 | `integration_evaluate_v1` 读取多表，若将来进入工具热路径会增加延迟 | S2c 不进入热路径；强制执行阶段需另做性能预算与缓存设计（缓存不得成为 truth） |
| R6 | 规范化依赖 `authorizations_v12` 的现有列语义；v12 变更会悄然改变 facts | 规范化函数写明读取列；v12 任何迁移必须同步提升 `derivation_contract` 或 facts schema 版本；T-S-3 类测试可检测 v12 函数变化 |
| R7 | 数据库侧新 RPC 在 flag off 时若已授予 EXECUTE，就可经 PostgREST 直接调用；它们会写 Binding / v12 表（revoke），且 `transport` 可伪造 | v0.1.1 默认不授予 grant（§5.13、OQ-21）；CRV-3 标为弱证据（§10.7） |
| R8 | S2a 统一注册表未落地导致 PR-5 返工 | 按 §12.3 两种路径编写；注册表合入后迁移 |
| R9 | 大规模性质测试使 CI 时长上升 | CI 25 万样本、夜间 200 万；谓词层穷举以集合式 SQL 执行 |
| R10 | 授权码与规则码混淆导致信息泄露（例如借错误区分 Integration 是否存在） | 不属于 / 不存在统一 `integration_not_owned`；T-W-4 穷尽分类 |
| R11 | 旧 Binding 在 rebind 后仍然有效（OQ-13 已裁定维持），用户可能误以为已替换 | status 返回 historical connections 与 `owned_bindings`；旧 Binding 仍归 I 所有，Native / Operator Integration-level Revocation 撤销 `Owned(I) ∪ UnownedLineage(I)`（v0.1.5，含从未链接的撤销前同 client Binding）；Binding 通道不能把 I 拥有的 Binding 链接到别处（O3），撤销前签发的未拥有同 client Binding 不能新建连接（O7）；restore 撤销被取代的旧 Binding；跨身份 rebind 需 Owner 确认，`revoke_self` 只撤销同身份的 Binding |
| R13 | S2c 的“撤销不自动恢复”只在 Integration truth 层成立；新的 v12 同意（直接人类会话）发放的 Binding 在没有热路径门控时可立即使用既有工具（MAJOR-5） | §10.10 明确该保证层级；新同意是基线 §39 的“新的授权决定”；热路径强制执行在 OQ-16 的后续阶段授权中处理 |
| R14 | 真实 Host 的 OAuth `client_id` 若按安装或会话变化，SAME_PROVIDER_CONNECTION 不成立，普通重新授权会要求 Owner `confirm_rebind`（UX 成本）；反之若多个 surface / 设备共享同一 DCR `client_id`，撤销一个 Integration 会清扫它们尚未链接的同 client 授权（v0.1.6，MINOR-N22） | 保守即安全；撤销 Receipt 列出 `sibling_integration_ids`；去重时推荐 `pause`（§6.5）；S3 以真实 Host 行为核实 client_id 稳定性与共享情况，并在 OQ-5 / OQ-13 中复核 |
| R12 | Operator 通道权限面扩大 | 只经 `platform_admin_v13` 与直接人类会话；不暴露 REST；每个操作带 Receipt |

---

## 16. 未决问题（需 Owner / 评审裁定）

v0.1.4：Owner 已以 Decision `d11f19ea-c32f-48bd-a570-460347fef110` 按推荐选项裁定 OQ-1、OQ-2（A）、OQ-3（PERMIT）、OQ-14、OQ-20、OQ-21，以 Decision `c5574918-936e-4836-a0ba-bfe6696ee450` 裁定 OQ-13 并采纳显式 Binding 所有权；评审已在 v0.1.2 复评中对 OQ-6、OQ-8 签字。下表“推荐选项”列保留作为裁定内容的记录。

v0.1.1 按独立评审的 OQ 评估增加“裁定方”列：**Owner（门控）**的问题会改变派生结果、安全边界或 Gate 判据，列入 §17；**评审**的问题是基线已授权的工程细化，评审签字即可；**Owner（非门控）**是 Owner 决策但不阻塞 S2c Gate。每个 Owner 问题都给出推荐选项；在裁定之前，实现按推荐选项执行。

| # | 问题 | 推荐选项（= 裁定前的临时执行） | 裁定方 |
|---|---|---|---|
| OQ-1 | 基线 §16.3 BLOCKED 示例与 §42 G-A7 要求“Candidate Set 为空 … 必须落到 BLOCKED 或更高优先级合法状态”。但安装 / 授权前（例如 Native 创建、尚未 OAuth 的 Integration）Candidate 必然为空，而 §14 的生命周期又要求先经过 `INSTALL_PENDING` / `INSTALLED`（二者优先级都低于 BLOCKED）。字面执行会使 INSTALL_PENDING 与 INSTALLED 在无授权时不可达 | **推荐 A**：`B8` 限定为“已安装且 Authn/Authz 可用时 Candidate 为空”；任何阶段 Candidate 为空都不会得到 ACTIVE / DEGRADED。备选 B（字面执行）会使 INSTALL_PENDING / INSTALLED 在无授权时不可达，与 §14 矛盾。需 Owner 确认或出基线勘误 | **已裁定**：Owner Decision `d11f19ea-c32f-48bd-a570-460347fef110`，采纳推荐选项（v0.1.4） |
| OQ-2 | 连接级撤销应派生 Integration-level REVOKED（需显式 restore），还是 credential invalidation → REAUTH_REQUIRED（普通 OAuth 重连即可恢复）？v0.1.2 重写（MAJOR-N1）。**仓库事实：**用户在 Host（Claude / ChatGPT）中“断开连接”时，Host 向 `POST /oauth/token` 发 RFC 7009 撤销，Worker 据此调用 `revoke_issuer_v12`（审计 `'revoke_issuer'`）；`revoke_self_v12` Worker 从不调用；`'revoke'` 来自 Clued 连接管理页。**真正的取舍：**一条 `'revoke_issuer'` 审计行无法区分“用户断开”与 Host 的例行撤销（Host 卸载、登出清理、重连流程先撤旧 token 等）。**A（保守）**：一切连接撤销 → REVOKED，需 Clued 中显式 restore；满足 §39“不得因 ordinary OAuth retry 恢复”，代价是 Host 例行撤销也要 restore（UX 成本，且无法按 Host 豁免）。**B（§38 字面）**：`revoke_issuer` 归入 §38“host / provider session invalidation，但没有形成 Integration-level Revocation → REAUTH_REQUIRED”，只有 Clued 侧的 `revoke` 与 Integration revoke → REVOKED；代价是用户在 Host 中断开后，同一 DCR client 的下一次普通 OAuth 会经 SAME_PROVIDER rebind 自动回到 VERIFYING → ACTIVE，这正是 §39 禁止的恢复（若 Host 重连时换新 `client_id`，恢复会停在 `confirm_rebind`，但 Claude / ChatGPT 是否复用 DCR client_id 尚未核实，R14）。**C（按 Host 版本化）**：默认 A；S3 在真实 Host 上核实断开与例行撤销的行为后，由注册表按 Host 标记“该 Host 的 RFC 7009 撤销只表示会话失效”，仅对被标记的 Host 采用 B | **推荐 A**（= 现行临时执行），并把 C 作为 S3 的演进路径；不推荐在 S3 核实前采用 B | **已裁定**：Owner Decision `d11f19ea-c32f-48bd-a570-460347fef110`，采纳推荐选项（v0.1.4） |
| OQ-3 | `INCOMPLETE_UNCLAIMED` 时是否允许普通运行时（基线 §17：“按版本化 Identity / Policy 规则处理”） | **推荐**：policy v1 = `PERMIT`（S2c 中所有真实 Host 都是 INCOMPLETE，DENY 会让其全部 BLOCKED）；由 policy 版本化，S3 可收紧 | **已裁定**：Owner Decision `d11f19ea-c32f-48bd-a570-460347fef110`，采纳推荐选项（v0.1.4） |
| OQ-4 | 哪些 Host 身份证据算“足够强、可验证”（§14.5）；S3 之前是否接受任何 Host 自报的账户 / 租户断言 | **推荐**：S2c 不接受任何 Host 自报断言，account / tenant 记为 UNAVAILABLE；S3 评估 P5 `workspace_id` 与 Host 签名断言作为可验证来源 | Owner（非门控） |
| OQ-5 | provider 命名与 `provider_connection_id` 来源：委托 OAuth 用 `sha256(authorizations_v12.client_id)`（`clued.oauth.v12`；`clued_agent_bindings.oauth_client_id` 对 v12 Binding 为 NULL，不可用），raw Binding 用 `binding_id`（`clued.binding.v1`）。是否需要 Host-native provider 进入 S2c 注册表 | 按提议；Host-native provider 在 S3 / S5 获得真实来源后以注册表新版本加入；S3 核实真实 Host client_id 稳定性（R14） | 评审 |
| OQ-6 | REVOKED Integration 是否继续持有 current claim | 继续持有，直到 Owner restore 或 `REPLACE_HOLDER`；可防止以新 Integration 绕过撤销（符合 §14.4“不能绕过 current claim”与 §39） | 评审（门控）——v0.1.2 复评已签字 |
| OQ-7 | S3 之前 `qualification_state = NOT_EVALUATED` 是否阻断普通运行时 | **推荐**：`NON_BLOCKING`；READY profile 可要求 `QUALIFIED` | Owner（非门控） |
| OQ-8 | preclusion 规则：是否所有 non-reauth blocking predicate 都使 Canonical 验证“不可执行 / 无意义” | policy v1 = `ALL_BLOCKING_PREDICATES`（最保守，也最易证明不漂移；属 §16.3 允许的“实现可以细化”） | 评审（门控）——v0.1.2 复评已签字 |
| OQ-9 | Canonical 验证 `FAIL` 应派生 VERIFYING（验证未完成）还是 BLOCKED | VERIFYING；持续失败只在形成显式 compatibility / adapter fact 后才变为 INCOMPATIBLE / BLOCKED | 评审 |
| OQ-10 | 无能力声明时 Host 能力项取 Surface 上界（Preserve）还是 ∅ | 取上界；否则所有未声明的既有 Host 都会被 BLOCKED | 评审 |
| OQ-11 | Scope → Capability 映射（尤其 `development_history.read`、`project.*`、`evidence.write`） | 按 §9.1；P5 `canonical:*` / `project:*` scope 不映射（P5 Binding 不可采纳，MINOR-1）；需与 S2a / S2b 的 public capability registry 对齐 | 评审 |
| OQ-12 | “连接自身”工具在 `publicToolPolicies` 中的 scope 表达 | S2a 注册表新增 `connectionSelf`；在此之前临时声明 `context:read` | 评审 |
| OQ-13 | rebind / reauth 被替换的旧 Binding 是否自动撤销 | 维持现状：同 client 重新授权不自动撤销旧 Binding（Worker `revokeExistingGrants:false`）；旧 Binding 转为 HISTORICAL 但仍归 I 所有（§5.5 显式所有权），撤销 I 时一并撤销，Binding 通道不能把它链接到别处（O3）。v0.1.5：Owner Decision `1b034f44-e5b7-414c-a9a1-53b7bf065200` 补全了这一裁定的前提——撤销同时清扫从未链接过的撤销前同 client Binding（O5），且这类 Binding 不能新建连接（O7）；restore 撤销被取代的旧 Binding（§10.12）。v0.1.6（MINOR-N22）：由于清扫按 client 血缘进行，撤销一个 Integration 也会撤销给同 client 兄弟 Integration 的尚未链接的授权（Receipt 列出 `sibling_integration_ids`）；只想去掉重复 Integration 时推荐 `pause` | **已裁定**：Owner Decision `c5574918-936e-4836-a0ba-bfe6696ee450`（v0.1.4），前提由 `1b034f44` 补全（v0.1.5） |
| OQ-14 | 扩权路径：REAUTH 恢复能否扩大 ceiling（ceiling 覆盖 scope 与 v12 resource entries） | **推荐（v0.1.1，MINOR-12）**：v12 同意页上晚于 ceiling 设定（v0.1.2：也晚于最近一次 `reduce`，MINOR-N7）的直接人类批准本身就是 §38 的“用户再次确认”，可扩大 ceiling（Receipt 记录前后值）；没有同意页的 raw Binding 与旧授权不得扩权，raw Binding 可选经 Native `capability_expansion`。备选（v0.1：所有扩权都必须先走 `capability_expansion`）比 §38 更严，不推荐。已知限制：v12 同意页目前不提示“这会扩大该 Integration 的上界” | **已裁定**：Owner Decision `d11f19ea-c32f-48bd-a570-460347fef110`，采纳推荐选项（v0.1.4） |
| OQ-15 | Integration 写操作是否追加 `extension:integration:*` 审计 Event（基线与 AGENTS 要求 Canonical 写同时产生 Event + Receipt，但 Integration 不是 Canonical Record） | 若 T-S-6 证明无副作用则追加（IF S5 先例），否则只写 Receipt | 评审 |
| OQ-16 | 没有 Integration 的 Binding 何时不再允许普通运行时；Effective Capability 何时在既有工具上强制执行（与 R13 相关） | 不属 S2c；**推荐**在 S3 / S6 以单独阶段授权决定 | Owner（后续阶段） |
| OQ-17 | `active_binding_domain` 的取值与版本化方式 | 只有 `clued.default.v1`，`max_current_holders = 1`（§14.4 默认） | 评审 |
| OQ-18 | 基线文件字节内状态仍为 NOT FROZEN | **已回答**：Owner 冻结 Decision `b4a7f879-88d8-4772-ace6-6e8fda591f77`；PR-0 与各实现 PR 描述引用它 | 已解决 |
| OQ-19 | 对 INCOMPLETE 身份的 Integration 是否允许 `PENDING_RECONCILE` / `SUPERSEDED` | **已撤销（v0.1.1，MINOR-6）**：没有操作能到达该状态；§5.2 CHECK 收紧为 INCOMPLETE ⇔ INCOMPLETE_UNCLAIMED；合并 INCOMPLETE Integration 需后续新增操作 | 已解决 |
| OQ-20 | G-A9 “生命周期运行时闭环”的判据（§42 未定义负例） | **推荐**：采用 §13.6 T-A9-1…12（v0.1.1 已修正 T-A9-7、T-A9-9，新增 T-A9-12） | **已裁定**：Owner Decision `d11f19ea-c32f-48bd-a570-460347fef110`，采纳推荐选项（v0.1.4） |
| OQ-21 | flag off 时数据库侧新 public RPC 是否应已授予 `anon / authenticated` EXECUTE | **推荐（v0.1.1 默认，MINOR-11）**：不授予；grant 随开启 flag 的阶段授权迁移施加；测试在测试库内显式授予。备选（默认授予）会让写 Binding / v12 表的 RPC 在 flag off 时可经 PostgREST 调用，不推荐 | **已裁定**：Owner Decision `d11f19ea-c32f-48bd-a570-460347fef110`，采纳推荐选项（v0.1.4） |
| OQ-22 | Canonical 验证 TTL（30 天）与 Installation Request TTL（30 分钟）的取值 | 按 policy v1；可由 Owner 调整，不影响语义 | Owner（非门控） |

---

## 17. S2c 完成判定所需证据

1. PR-1…PR-6 已合入 main（各自经评审与 CI），每个 PR 的 T-S-3 证明未改变既有对象。
2. PR-6 生成的证据 JSON：对 §13.1–§13.6 的每个测试 ID 给出 PASS、commit SHA、随机种子、样本数，并把每个测试映射到 G-A3 / G-A7 / G-A8 / G-A10 / G-A11 条目，以及 G-A9 判据（OQ-20 已裁定）。
3. `tools-list.baseline.json` 未改变；`production_equivalent` 仍为 29 个工具；flag 矩阵 8 行通过。
4. Owner 门控问题 OQ-1、OQ-2、OQ-3、OQ-14、OQ-20、OQ-21 已由 Owner Decision `d11f19ea-c32f-48bd-a570-460347fef110` 裁定（v0.1.4 记录），评审门控问题 OQ-6、OQ-8 已在 v0.1.2 复评中签字；剩余条件是这些结论在实现与测试中得到体现，且规格复评通过。
5. 没有任何生产迁移、部署或 flag 开启发生在 S2c 之内；这些动作另有阶段授权。

Gate 结论以 `G-A3 / G-A7 / G-A8 / G-A9 / G-A10 / G-A11 = PASS | FAIL | NOT_EVALUATED` 的形式记录。S2c 结论不得被表述为 READY、Qualification 或 GA【基线 §20、§23、§41.0 S3 行】。

---

## 18. 变更记录

### v0.1.8（2026-09-24）— Owner 冻结候选：只应用 v0.1.7 增量评审 PASS（0 BLOCKER / 0 MAJOR / 2 MINOR / 6 NIT）的意见

基线未改动（SHA-256 `2c5950f1…baaf3`，153,289 bytes）。v0.1.7 已备份为同目录 `IntegrationRuntime.v0.1.7.bak`。除下表所列外无其他改动；派生（§7、§8）与 golden vectors 未改动。

| 发现 | 修订位置 | 修订内容 |
|---|---|---|
| MINOR-N27 | §10.12“Tuple 与 key”、T-A11-17(e) | `CLAIM_CONFLICT` / `PENDING_RECONCILE` 中 K = K0 的 restore 不调用 claim core，`identity_claim_state` 与 `conflicting_integration_id` 不变，不设 `CLAIM_CONFLICT_AFTER_RESTORE`；T-A11-17(e) 增加“无该 flag”断言与 PENDING_RECONCILE 变体 |
| MINOR-N28 | §5.5 O5 `Lin*` 终止性 | 改为集合语义递归 CTE（`UNION` / `CYCLE`），不设深度上限；撤销、清扫、restore 永不因血缘失败；删除“按 C7” |
| NIT-1 | §5.5 O7 统一回退规则、§10.1 物化伪代码 | 非撤销调用的回退时间戳改为“该调用开始时一次取得的时间戳” |
| NIT-2 | §10.1 物化说明与伪代码 | 列出 reconcile `REPLACE_HOLDER` 规则 2 也以自己的 `[b_H] ∪ R` 行物化 |
| NIT-3 | T-A11-15(e)、新增 T-A11-26、§14.1 PR-2 | PR-2 临时拒绝的断言移到 PR-2 门控测试 T-A11-26（直接插入 open 行，PR-4 删除该测试）；T-A11-15(e) 只保留 PR-4 行为 |
| NIT-4 | T-A11-15(c) | H 拥有的旧 Binding 改名 B_oldH，与表头中 I 拥有的 B_old 区分 |
| NIT-5 | T-A11-18 | 扩展变体写明从 t2 物化之后、restore 之前分支 |
| NIT-6 | T-A11-17 | fixture 写明 `test.complete` + `clued.oauth.v12`；`FORBIDS_REAUTH_RECOVERY` 用单独 fixture（未撤销、FORBIDS_REAUTH、凭据丢失、CLAIM_CONFLICT） |

### v0.1.7（2026-09-24）— 按 v0.1.6 增量评审 FAIL（0 BLOCKER / 1 MAJOR / 3 MINOR / 7 NIT）修订，拟冻结

基线未改动（SHA-256 `2c5950f1…baaf3`，153,289 bytes）。v0.1.6 已备份为同目录 `IntegrationRuntime.v0.1.6.bak`。派生（§7、§8）与 golden vectors 未改动。

| 发现 | 修订位置 | 修订内容 |
|---|---|---|
| MAJOR-N23 | §10.12 前置守卫、§10.5 `REPLACE_HOLDER` 引言与规则 1、§11.2（`integration_claim_blocked`、`integration_revoked_requires_explicit_restore`）、T-A11-17(e)(f) | 采用选项 (a)：`CLAIM_CONFLICT` / `PENDING_RECONCILE` 中允许 `restore_kind='REVOCATION'`，前提是 restore 不改变 claim key（K = K0）；改变 key 的 restore 与 `FORBIDS_REAUTH_RECOVERY` 仍为 `integration_claim_blocked`。两处 hint 改为“先以同一 client 的新授权 restore，再 reconcile”，不再互相指向；删除过时的“两方中任何一方处于 `CONNECTION_USER_REVOKE`”说法（存续方必须 NOT_REVOKED）。T-A11-17(e)：先 restore I，再 `REPLACE_HOLDER` 成功；新增 (f)：冲突中改 key 的 restore 被拒 |
| MINOR-N24 | §10.5 规则 2、T-A11-15(c)(e) | `R := Owned(H) ∪ UnownedLineage(H, rev_at(H))`；派生撤销的 H 一次插入物化行 `[b_H] ∪ R`；已有 open 行时只在 `R ≠ ∅` 时扩展，`R = ∅` 不写行；已撤销的 Binding 留在 H 名下，只转移未撤销的（此时为空）。T-A11-15(c) 改为一次插入、无扩展、无转移；新增 (e)：显式撤销的 H、`R = ∅`，行不变 |
| MINOR-N25 | §10.5 规则 2“PR 放置”、§11.2、§14.1 PR-2 / PR-4、T-A11-15(e) | PR-2 中 `REPLACE_HOLDER` 遇到已撤销的 H 暂时拒绝为 `integration_revoked_requires_explicit_restore`（规格写明，PR-4 移除）；规则 2 与 T-A11-15(c)(e) 放到 PR-4 |
| MINOR-N26 | T-A11-18 | 扩展变体的 fixture 增加 I 拥有、仍有效的 HISTORICAL B_old；断言行扩展为 `{B_cur, B_old}`，B_new 不被触及 |
| NIT-1 | §10.10 不变量、§39 说明 | `t_rev` 改为 `t_cut` |
| NIT-2 | §5.5 O5 / O7、§10.1 物化函数、§10.10 第 0 步 | 统一回退规则：`rev_at(X)` = 撤销行的 `revoked_at`（包括本调用刚物化的行，此时 `t_cut := row.revoked_at`）；否则取一次物化此刻会写入的值（`connection_revoked_at`；为 null 时取物化调用的时间戳，撤销调用为其 `t_rev`） |
| NIT-3 | §5.5 O5 `Lin*`、§5.5 索引、§10.3 第 6' 步注释 | 写明 `superseded_by` 构成森林，要求环保护（`CYCLE` 或深度上限 64，超限按 C7 fail closed）；新增 `integrations_v1(superseded_by_integration_id)` 部分索引与 `integration_connections_v1(integration_id)` 全行索引；第 6' 步注释写明 X 经 provider-connection 索引找到后沿 `superseded_by` 上溯到 `historical = NONE` 的根 |
| NIT-4 | T-A11-23 | 用第二个 embedded-postgres 连接保持 `approve_v12` 未提交；`CREATE_OR_BIND` 用 INCOMPLETE Host；`REBIND` 指向未撤销的同 client 兄弟 Integration |
| NIT-5 | T-A11-24 | 再次撤销的变体改为确定性 fixture，期望 `ALREADY_REVOKED` |
| NIT-6 | T-A11-19 | 断言 Operator restore 的 connection 行 `link_authority='OPERATOR_RESTORE'` |
| NIT-7 | §10.5 规则 2（边界 1b）、§10.10 已知边界、§11.2 `binding_predates_revocation` | 记录 `REPLACE_HOLDER` 中的迟提交同意为已知边界 1b（之后对 I 的撤销会清扫）；§11.2 描述更新为 `Lin*` 与排除 SUPERSEDED |

仍保留的已知边界（均已记录且经评审接受）：边界 1 / 1b（与撤销或 reconcile 同刻、迟提交的同意）、边界 2（已持有 L1 的并发 `CREATE_OR_BIND` 线性化在撤销之前）、Binding 行被带外删除时的回退时间、真实 Host 的 DCR `client_id` 行为待 S3 核实。

### v0.1.6（2026-09-24）— 按第六次独立评审 PASS（0 BLOCKER / 0 MAJOR / 5 MINOR / 9 NIT）的全部意见打磨，拟冻结

基线未改动（SHA-256 `2c5950f1…baaf3`，153,289 bytes）。v0.1.5 已备份为同目录 `IntegrationRuntime.v0.1.5.bak`。派生（§7、§8）与 golden vectors 未改动。仓库事实：`origin/main` = `cf1a2809`，最新迁移 `20260925030000`；PR #335 分支 tip `a6728b90`，占用 `20260925040000`；占位仍为 `20260926*`。

| 发现 | 修订位置 | 修订内容 |
|---|---|---|
| MINOR-N18 | §5.5 O5、§10.10 第 0 / 3 / 8 步、不变量、新增 T-A11-24 | 清扫截止时间 `t_cut`：I 已有 open 行或本次物化时取 `rev_at(I)`，只有插入新 `INTEGRATION_REVOKE` 行时取 `t_rev`；第 3 步在 L5 下复核 `t_cut`。重复撤销不再清扫撤销之后的新同意；测试断开 → 重新同意 → Native revoke：B_new 保持有效且可用于 restore |
| MINOR-N19 | §5.5 O5（`Lin*`）、O7、§10.3 第 6' 步、§10.10 第 0 步、新增 T-A11-25 | `Lin*(X) = Lin(X) ∪ ⋃ Lin*(Y)`（Y 取遍被 X 取代者，递归），O5 与 O7 都用 `Lin*`；O7 排除 `historical = SUPERSEDED` 的 X |
| MINOR-N20 | §10.5 `REPLACE_HOLDER` 与锁顺序、T-A11-15(c)(d)、T-A11-17(e) | 存续方已撤销 → 拒绝，先 restore；被取代方已撤销 → 同一事务内撤销其转移的 Binding 并清扫 `UnownedLineage(H, rev_at(H))`，记为 H 撤销行的超集扩展（operation log `RECONCILE_REVOKE`），再转移所有权 |
| MINOR-N21 | §10.12 事务、§5.5 旧 Binding 说明、T-A11-19、T-A11-21 | 两种 `restore_kind` 都撤销 `Owned(I) \ {new}`；`UnownedLineage(I, t_loss)` 清扫只用于 `REVOCATION`，依据为 Decision `1b034f44` 第 1 条；`Lin*(I)` 在链接新 connection 之前求值 |
| MINOR-N22 | §5.5 O5“兄弟 Integration 的影响”、§6.5、§10.10 第 8 步与不变量、R14、OQ-13、T-A11-2 | 写明撤销会清扫给同 client 兄弟 Integration 的未链接授权；Receipt 对每个被清扫的 Binding 列出 `sibling_integration_ids`；去重推荐 `pause` 而非 `revoke` |
| NIT-1 | 文件头、§14.1 | PR #335 tip 更新为 `a6728b90` |
| NIT-2 | §5.5 旧 Binding 说明 | 补上 restore（`REVOCATION`）的 `UnownedLineage` 清扫 |
| NIT-3 | §10.10 第 3 步注释 | 更正：`created_at ≤ t_cut`、在 S0 与第 3 步之间提交的同意也会进入 S1，导致可重试的中止 |
| NIT-4 | §5.5 O7 | `rev_at(X)` 为 null 时取求值时的 `clock_timestamp()` |
| NIT-5 | §5.5 `link_authority` CHECK、§10.12 | 新增 `OPERATOR_RESTORE`，Operator restore 的 connection 行用它 |
| NIT-6 | §5.5 O4 | reconcile 批量转移全部未撤销 Binding（含过期的），明确为例外 |
| NIT-7 | §5.11 注释 | `operation_type` / `affected_binding_ids` 列出 `RESTORE_SWEEP`、`RECONCILE_REVOKE` |
| NIT-8 | 新增 T-A11-23、§10.10 已知边界 | 已知边界 1 的测试：延迟提交的同意可用既有工具、被 O7 拒绝链接、被再次撤销或 restore 清扫 |
| NIT-9 | §10.10 第 0 步注释与已知边界 | 写明 `t_rev` 有意在第 1 步等锁之前取值；PARTIAL 之后派生撤销的 `rev_at` 略晚于 `t_rev`，是更严格的一侧 |

仍保留的已知边界（评审判定可接受）：与撤销同刻、在复核之后提交的同意（边界 1，可用既有工具直到 OQ-16，之后被 restore / 再次撤销清扫）；已持有 L1 的并发 `CREATE_OR_BIND` 线性化在撤销之前（边界 2）；Binding 行被带外删除时物化行取物化时间；真实 Host 的 DCR `client_id` 复用与撤销时机待 S3 核实。

### v0.1.5（2026-09-24）— 按第五次独立评审 FAIL（0 BLOCKER / 1 MAJOR / 3 MINOR / 7 NIT）与 Owner Decision `1b034f44` 修订

基线未改动（SHA-256 `2c5950f1…baaf3`，153,289 bytes）。v0.1.4 已备份为同目录 `IntegrationRuntime.v0.1.4.bak`。评审认定所有权模型本身成立，剩余问题都在模型边界：链接之前（从未链接的凭据）、取代之后、连接撤销后的 restore。Owner Decision `1b034f44-e5b7-414c-a9a1-53b7bf065200`（固定输入）：MAJOR-N5 两项修复都采用；MINOR-N16 由 restore 撤销 `Owned(I) \ {new}`。仓库事实：`origin/main` = `cf1a2809`（PR #334 已合入，最新迁移 `20260925030000`）；PR #335 分支 tip `2ac722ae` 新增 `20260925040000_search_context_followups.sql`。

| 发现 / 决定 | 修订位置 | 修订内容 |
|---|---|---|
| MAJOR-N5（Decision `1b034f44` 第 1 条） | §5.5 定义、O3、O5、O7 与索引、`acquired_via` 增加 `REVOCATION_SWEEP`、§10.3 第 6' 步、§10.10 第 0–8 步、不变量、“已知边界”与 §39 说明（更正 v0.1.4 的“旧凭据均已撤销”）、§11.2 `binding_predates_revocation`、OQ-13、R11、T-A11-2、T-A11-10(c)、T-A11-16 Path 3、新增 T-A11-22 | (a) 撤销集合 `Rev(I) = Owned(I) ∪ UnownedLineage(I)`：`UnownedLineage` 为同 owner、未撤销、未拥有、v12 授权创建于 `t_rev` 之前、服务端推导的 `(provider, provider_connection_id)` 属于 I 某个 connection 快照的 Binding；在 S0 加锁、S1 复核，同事务插入 `REVOCATION_SWEEP` 所有者行并撤销；`revoke_self` 的 LINEAGE 同样包含同 client 的未拥有 Binding；被取代的 Integration 取 `UnownedLineage = ∅`（血缘已移交存续方）。(b) O7：Binding 通道上，未拥有 Binding 的授权不晚于同 owner、同身份的已撤销 Integration 的撤销时刻（open 行的 `revoked_at`，或派生撤销的 `connection_revoked_at`）时，任何链接或新建 → `binding_predates_revocation`；撤销后的新同意不受影响。明确并发边界：已持有 L1 的并发链接线性化在撤销之前；与撤销同刻进行的直接人类同意不被清扫但受 O7 约束 |
| MINOR-N16（Decision `1b034f44` 第 2 条） | §10.12 锁顺序与事务、§5.5 旧 Binding 说明、新增 T-A11-21 | restore 在同一事务内撤销 `Old(I) = Owned(I) \ {new} ∪ UnownedLineage(I, t_loss)`，L1 在 restore 既有锁顺序的第一段按 id 一并取得；operation log `RESTORE_SWEEP`。后半项（`t_loss` 之前的未拥有同 client Binding）是本规格为与 §10.10 一致而补充的，超出 Decision 字面，请复评确认 |
| MINOR-N15 | §5.5 O4、§10.5（`REBIND_TO_HOLDER`、`REPLACE_HOLDER`、锁顺序）、T-A11-15 | 取代时把被取代一方拥有的全部未撤销 Binding 以 `NATIVE_RECONCILE` 转移给存续方（`REPLACE_HOLDER` 先解除 H 的 CURRENT connection），只转移所有权、不建 connection 行；撤销存续方即覆盖它们。采用协调方建议的第一种方案 |
| MINOR-N17 | §5.5 O1 / O4、`acquired_via` 增加 `OPERATOR_RESTORE`、§10.12、§11.2、T-A11-19 | Operator restore 只能使用未拥有或已归 I 的 Binding；未拥有时首次所有权记为 `OPERATOR_RESTORE`；归其他 Integration 的 → `binding_owned_by_other_integration`。O4 保持只含 Owner-native 路径 |
| NIT-1 | 文件头、§14.1 | 更新为 `cf1a2809` / PR #334 已合入 / PR #335 `2ac722ae` 占用 `20260925040000`；占位仍为 `20260926*` |
| NIT-2 | §2.3 第 3 条 | 改为“撤销该 Integration 拥有的 Binding 及同 client 的未拥有 Binding”，已转移出去的不撤销 |
| NIT-3 | §5.5 O6 | O6 只约束所有者行的写入与据以作决定的读取；展示 / 诊断 / 无锁发现读不需要 L1 |
| NIT-4 | §5.5 O1、DDL 注释、§10.3 第 8 步、T-A10-14(g) | 首次所有权的 `acquired_via` 按建立路径取值；首次所有权的日志 `from_integration_id` 均为 null |
| NIT-5 | §5.5 O4、§11.2 hint | hint 不再建议撤销原 Integration（那会撤销要移动的 Binding） |
| NIT-6 | T-A11-16 Path 1b | `BIND_EXISTING` 子用例移到 `test.complete` |
| NIT-7 | §5.5 定义、§10.10 第 0 步 | 撤销集合按“未撤销（`revoked_at is null`）”取，不按过期筛选；不再依赖“过期时间从不延长”的仓库现状 |

仍未解决 / 已知限制：
- 与撤销同刻进行、`created_at ≤ t_rev` 但在撤销复核之后才提交的同意页批准不被清扫（受 O7 约束，但可调用既有工具，直到 OQ-16 的热路径门控）；
- 已持有 L1、在撤销加锁前提交的并发 `CREATE_OR_BIND`（未拥有的撤销前同 client Binding）线性化在撤销之前，其新 J 不受 I 撤销影响；
- restore 清扫 `UnownedLineage(I, t_loss)` 是超出 Decision 字面的补充；
- Binding 行被带外删除时物化行的 `revoked_at` 只能取物化时间；
- Claude / ChatGPT 的 DCR `client_id` 复用与 RFC 7009 撤销时机仍待 S3 核实。

### v0.1.4（2026-09-24）— 显式 Binding 所有权重构，并按第四次独立评审 FAIL（0 BLOCKER / 1 MAJOR / 2 MINOR / 6 NIT）修订

基线未改动（SHA-256 `2c5950f1…baaf3`，153,289 bytes）。v0.1.3 已备份为同目录 `IntegrationRuntime.v0.1.3.bak`。Owner 决定（记录于 Clued）：
- Decision `c5574918-936e-4836-a0ba-bfe6696ee450`：采用显式 Binding 所有权模型；OQ-13 维持“同 client 重新授权不自动撤销旧 Binding”，旧 Binding 仍归 I 所有；
- Decision `d11f19ea-c32f-48bd-a570-460347fef110`：OQ-1、OQ-2（A）、OQ-3（PERMIT）、OQ-14、OQ-20、OQ-21 按推荐选项裁定。

仓库事实：`origin/main` 仍为 `d3c2f950`；`origin/claude/dreamy-shannon-hffhqh` tip 为 `2bd7745a`，仍含 `20260925030000_search_context_cross_scope.sql`。

**结构性变化：**v0.1.2–v0.1.3 的 MAJOR-N2 / N3 / N4 都源于同一问题：一个 Binding 可以先后链接到多个 Integration，却没有“这份凭据归谁”的记录，每次修补都只处理共享的一个方向。v0.1.4 以所有权表取代 v0.1.3 的 `Eligible` / `SH` / `current_elsewhere` / `shared_binding_count` 逻辑：Binding 首次链接即归一个 Integration；Binding 通道只能链接未拥有或已归目标所有的 Binding；所有权只经 Owner-native 路径转移并留 Receipt；撤销 I = 撤销 I 拥有的全部有效 Binding，在所有者行锁下执行。派生（§8）不读所有权，只有 C7 增加了所有者一致性检查，因此 derivation 与 golden vectors 不变。

| 发现 / 决定 | 修订位置 | 修订内容 |
|---|---|---|
| Owner Decision `c5574918` / MAJOR-N4 | §2.3 第 2 条、§5.5（`integration_binding_owners_v1`、`integration_binding_ownership_log_v1`、规则 O1–O6）、§6.4 L1、§7.3 C7、§10.1（认证与 L1、物化说明）、§10.3 第 4、6'、8 步与“不能分叉”、§10.5、§10.9 `owned_bindings`、§10.10 第 0–8 步与不变量、§10.12、§10.14、§11.2（`binding_owned_by_other_integration` 取代 `binding_already_linked_to_other_integration`）、R11、§14.1 PR-2、T-A10-14、T-A11-10(c)、T-A11-12、T-A11-15、T-A11-16（反转并加 Path 2）、T-A11-19 | 所有权模型如上。`CREATE_OR_BIND` / `BIND_EXISTING` / 任何 REBIND_CLASS 在调用方 Binding 归其他 Integration 所有时拒绝，因此 Path 1（旧 Binding 新建 J）与 Path 2（旧 Binding rebind 回 I 后，被替换的当前 Binding 再新建 J）都被拒绝。所有权转移只经 `confirm_rebind`、`adopt_binding`、`restore`、`REBIND_TO_HOLDER`，前提是 Binding 不是原所有者的 CURRENT connection（`REBIND_TO_HOLDER` 除外），每次转移写所有权日志与 Receipt `ownership_transfer`。撤销集合改为 `Owned(I)`，在 Binding 行与所有者行的 L1 下读取与复核；不变量“revoke 后 `Owned(I) = ∅`”可加锁证明 |
| OQ-13（Decision `c5574918`） | §5.5、§16、R11 | 标为已裁定：维持不自动撤销；旧 Binding 仍归 I，撤销 I 时一并撤销 |
| OQ-1、2、3、14、20、21（Decision `d11f19ea`） | 文件头、§16 表与引言、§17 第 4 条 | 标为已裁定并引用 Decision ID；推荐列保留为裁定内容 |
| MINOR-N13 | §10.1“Binding 通道的认证与 L1”、§10.3 第 1 步、§10.10 第 1 步、新增 T-A10-13 | Binding 通道写 RPC 不调用 `resolve_binding`；无锁查出所需 Binding id 后按 id 一次性取 `FOR UPDATE`（含调用方与所有者行），在锁下复核调用方；`status` 只取 `FOR SHARE`。`revoke_self` 的调用方在 S0 的同一次加锁中认证，消除锁升级与乱序。新增同一 Binding 并发 create_or_bind / revoke_self 测试 |
| MINOR-N14 | §5.5 `NATIVE_RECONCILE`、§10.5 前置条件 4 与效果、§10.12 事务、新增 T-A11-20、T-A11-19 | `REBIND_TO_HOLDER` 对 H 施加 §10.3 第 6 步的 `covers(C_eff(H))` / `fresh_consent` 与 `FORBIDS_REAUTH` 守卫（不设例外），`link_authority='NATIVE_RECONCILE'`，定义 H 的 `first_authorized_at`、ceiling 与 reauth mark 处理。restore 设 ceiling 为新 authority，并在 Receipt 记录 `ceiling_before` / `ceiling_after` |
| NIT-1 | §10.10 第 3 步注释、§10.1 | 所有权模型下消失：rebind 的旧 Binding 仍归 I，不需要锁；Binding 只能经持有其 L1 的转移离开 `Owned(I)` |
| NIT-2 | §10.1 物化函数 | 删除不可达的 “operator → revoked_by” 分支：`'revoke_integration'` 出现在 current connection 上只可能来自 I 自己的 PARTIAL `revoke_self`，actor 恒为 Binding 通道 |
| NIT-3 | §10.10 第 5 步、§5.9 触发器注释 | 物化时一次插入 `[b] ∪ S1`，不再扩展本调用刚创建的行；触发器 (b) 冻结除 `revoked_binding_ids` / `extended_receipt_ids` 外的全部列 |
| NIT-4 | §5.5、R11、§10.3 第 6 步注释、§10.11 | 撤销范围改写为“I 拥有的全部 Binding”；reduce 只在 Binding 是 T 的 CURRENT connection 时降低 ceiling |
| NIT-5 | 文件头、§14.1 | 分支 tip 更新为 `2bd7745a`；PR #334 编号来自协调方，本地无 `gh`，未独立核实 |
| NIT-6 | §10.3 `C_eff` 精度说明 | 写明跨事务时间戳与 unlink 无 L1 导致的计数不确定性，两侧都不扩大授权，接受 |
| v0.1.3 回归 | §10.12 | v0.1.3 重写 §10.12 时误删了 restore 的“事务”条（regrant 写入、revocation 关闭、reauth mark 清除），v0.1.4 恢复并补上所有权与 ceiling 记录 |

仍未解决 / 已知限制：
- Binding 行被带外删除时，物化行的 `revoked_at` 只能取物化时间（更严格的一侧）；
- 所有权转移前提“不是原所有者的 CURRENT connection”意味着要把一个正在使用的连接移到另一 Integration，Owner 必须先在原 Integration 上 reconcile 或撤销；这是有意的；
- Claude / ChatGPT 是否复用 DCR `client_id`、何时发 RFC 7009 撤销，仍待 S3 核实（R14；OQ-2 已裁定 A，C 仍是 S3 的演进路径，需要时另行裁定）。

### v0.1.3（2026-09-24）— 按第三次独立评审 FAIL（0 BLOCKER / 1 MAJOR / 3 MINOR / 9 NIT）修订

基线未改动（SHA-256 `2c5950f1…baaf3`，153,289 bytes）。v0.1.2 已备份为同目录 `IntegrationRuntime.v0.1.2.bak`。本轮核对的仓库事实：`origin/main` 仍为 `d3c2f950`；`20260925030000_search_context_cross_scope.sql` 已在 `origin/claude/dreamy-shannon-hffhqh` `8946451d`（PR #334）上，预留得到确认。

| 发现 | 修订位置 | 修订内容 |
|---|---|---|
| MAJOR-N3 | §5.11 `affected_binding_ids`、§7.2 provenance 映射、§10.1 物化函数与“链接路径的 L1”、§10.5 `REBIND_TO_HOLDER` 前置条件、§10.10 第 0–8 步、不变量与“共享 Binding”说明、§11.2（新增 `reconcile_requires_active_connection`，更新 `integration_revoked_requires_explicit_restore`）、OQ-13、T-A11-10(c)、新增 T-A11-15 / 16 / 17 | 采用协调方偏好：撤销排除共享 Binding，而不是连带撤销另一 Integration。`Eligible(I)` 排除已是其他 Integration CURRENT connection 的 Binding，S0 / S1 / LINEAGE 都基于它；共享 Binding 以 `shared_binding_count` 记入 Receipt，status 标注 `current_elsewhere`。所有链接路径先对被链接的 Binding 取 L1 `FOR UPDATE`，使撤销锁住的 Binding 不能在事务内被链接到别处。`'revoke_integration'` 的 provenance 改为按 `integration_operation_log_v1.affected_binding_ids` 找到撤销它的 Receipt，取其 actor（binding → `USER_VIA_HOST`，native → `USER`，operator → 该次 `revoked_by`）。`REBIND_TO_HOLDER` 要求 I 与 H 都 NOT_REVOKED、且 I 有有效的 CURRENT Binding，否则分别拒绝为 `integration_revoked_requires_explicit_restore` / `reconcile_requires_active_connection`。新增三项测试：撤销已取代的 I 时 H 保持 ACTIVE；旧 HISTORICAL Binding 新建的 J 不受 I 撤销影响；已撤销的 I 不能 `REBIND_TO_HOLDER` |
| MINOR-N10 | §5.9 列注释、§10.1 `integration_connection_revoke_adoption_v1`、§10.10 第 5 步、§10.12、新增 T-A11-18 | 三个物化点调用同一函数：`revoked_at := adopted_from.connection_revoked_at`（审计 `recorded_at`，否则 Binding `revoked_at`；Binding 行缺失的异常情形才用物化时间），`revoked_by := connection_revoked_by`。§10.10 第 5 步不再用本次调用的 `revoked_by`，本次调用的 actor 只在 Receipt 与 `extended_receipt_ids` 中。超集扩展不移动 `revoked_at`，因此不移动 `t_loss` |
| MINOR-N11 | §10.3 `C_eff`、T-A11-13 | 只计入 Binding 作为 T 的 CURRENT connection 期间（`linked_at ≤ recorded_at < coalesce(unlinked_at, ∞)`）发生的 reduce；新增 HISTORICAL reduce 的测试变体 |
| MINOR-N12 | §10.12“身份与锁”、新增 T-A11-19 | restore 做 provider 检查（`integration_provider_mismatch`），用新 Binding 重算 `provider_connection_id`、Tuple 与 key，经 claim core 声明（可得 `CLAIM_CONFLICT`，Receipt 标注），锁顺序 L1(新 Binding) → L2 → L4 → L5，遵守 pre-1…pre-5 |
| NIT-1 | 文件头、§14.1 | `20260925030000` 改记为 PR #334 已占用（已推送、未合入 main）；占位仍从 `20260926*` 起 |
| NIT-2 | §5.9 触发器说明与 `extended_receipt_ids` 列 | 超集扩展要求 `OLD.restored_by_regrant_id is null`，且不能与 restore 在同一 UPDATE 中；扩展者记录在 `extended_receipt_ids`（及这些 Receipt 的 actor），`revoked_by` / `receipt_id` 保持首个创建者 |
| NIT-3 | §10.1 物化 | 物化行的写在 Receipt `target_refs` 中列出 `{role:'revocation'}`，并加 `REVOCATION_MATERIALIZED` |
| NIT-4 | §10.10 第 3 步、T-A11-10(d) | 只在 `S1 ⊄ S0` 时 abort；`S1 ⊊ S0` 正常继续 |
| NIT-5 | §8.4 对照表 REVOKED 行 | 写明连接撤销派生 REVOKED 是 OQ-2 临时规则，偏离 §16.3 字面谓词 |
| NIT-6 | §10.7、§11.2 `verification_not_eligible`、§10.11 `reauth_mark` | verify 守卫改为 `coalesce(valid ∧ eligible, false)`；`reauth_mark` 的撤销检查改为 `integration_revocation_status_v1` |
| NIT-7 | §7.2 `authorization_state` 与 `resource_action_scope_facts` | 按 connection 的 `connection_kind` 分类；`OAUTH_V12` 而 v12 行缺失 → `REVOKED_CONNECTION` / `mode: NONE`，不再落入 `GRANTED_LEGACY` / `LEGACY_UNRESTRICTED` |
| NIT-8 | §10.10 “PARTIAL 之后的记录” | 写明 PARTIAL 撤销的同身份 Binding 只在该 Receipt 与 operation log 中；完整撤销集合为行的 `revoked_binding_ids` ∪ 日志 `affected_binding_ids` |
| NIT-9 | §10.5 | I 没有 CURRENT connection（或其 Binding 失效）时 `REBIND_TO_HOLDER` 拒绝为 `reconcile_requires_active_connection`；不定义“只取代、不移动连接”的变体 |

未完全解决 / 已知限制：
- Binding 行缺失（只能在带外删除时出现）时物化行的 `revoked_at` 只能取物化时间；这是更严格的一侧，已记录；
- 共享 Binding 不随 I 的撤销而撤销，这是按协调方偏好的有意选择：Owner 需对 J 单独撤销；
- Claude / ChatGPT 是否复用 DCR `client_id`、何时发送 RFC 7009 撤销，仍待 S3 核实（R14、OQ-2 选项 C）。

§16 Owner 门控问题的推荐选项不变（OQ-1、OQ-2、OQ-3、OQ-14、OQ-20、OQ-21）；评审已对 OQ-6、OQ-8 签字。

### v0.1.2（2026-09-24）— 按第二次独立评审 FAIL（0 BLOCKER / 2 MAJOR / 9 MINOR / 7 NIT）修订

基线未改动（SHA-256 `2c5950f1…baaf3`，153,289 bytes）。v0.1.1 已备份为同目录 `IntegrationRuntime.v0.1.1.bak`。本轮在 `origin/main` `d3c2f950` 上核对的仓库事实：
- `apps/clued-cloud/worker/delegated-oauth.ts`：`revokeIssuedBinding` 是 `clued_authorization_revoke_issuer_v12` 的唯一调用点。它只由 `revocationStorage` 在 `POST /oauth/token`、`application/x-www-form-urlencoded`、带 `token` 且无 `grant_type`（RFC 7009 撤销）时触发，并且在 provider 校验撤销客户端凭据及其对 token 的所有权之后；代码注释写明不用于刷新轮换、过期清理或普通写入。Worker 中没有任何对 `clued_authorization_revoke_self_v12` 的调用；
- `20260907173031_clued_connection_authorization_v12.sql`：`revoke_issuer_v12` 校验 issuer 哈希后撤销 Binding 与 Authorization，写 `'revoke_issuer'`；`revoke_self_v12` 以 token 哈希撤销，写 `'revoke_self'`，grant 给 PostgREST 调用方；`manage_v12` 只接受 `op ∈ {'revoke','reduce'}`；
- 既有 `clued_private.resolve_binding` / `resolve_binding_action_v12` 对 Binding 行取 `FOR SHARE`，不是 `FOR UPDATE`（NIT-7 的前提按代码更正）；
- 迁移：main 上最新为 `20260925020000_record_update_field_merge.sql`；`20260925030000` 不在任何远端 ref 中，按协调约定预留给尚未推送的 S2a-2 search PR。

| 发现 | 修订位置 | 修订内容 |
|---|---|---|
| MAJOR-N1 | §5.9 REVOKED 判定、§7.2 `revocation_state` 行与 `authentication_state` 注、§10.10 `revoke_self` 范围说明、§10.11 前两条、§10.12 `revoked_by` 映射、§11.2 `integration_revoked_requires_explicit_restore`、T-A11-4、T-A11-4b（重写，含真实 `/oauth/token` 路径）、§14.1 PR-5、R4、OQ-2（重写）、§18 v0.1.1 事实与 MAJOR-6 行加更正注 | 已核对：`revoke_issuer_v12` 只由 Host 的 RFC 7009 撤销（Host 侧断开）触发，Worker 从不调用 `revoke_self_v12`。改为：current connection 的**任何**连接级撤销（`revoke` / `revoke_issuer` / `revoke_self` / `revoke_integration` / 无法归因）都派生 REVOKED（`CONNECTION_USER_REVOKE`），审计行只决定物化时的 provenance（`revoke_issuer` / `revoke_self` → `USER_VIA_HOST`，`revoke` / 无法归因 → `USER`）；只有过期与 reauth mark → REAUTH_REQUIRED。T-A11-4 改为期望 `revoke_issuer` → REVOKED；T-A11-4b(a) 走 Worker 的真实撤销路径并断言同 client 重连被拒；(d) 断言刷新轮换 / 过期不触发 `revoke_issuer`。OQ-2 改写为 Owner 可见的真实取舍（A 保守 / B §38 字面 / C 按 Host 版本化），推荐 A，C 作为 S3 演进 |
| MAJOR-N2 | §5.9（`adopted_from`、不可变触发器允许的超集更新）、§10.1 新增“连接撤销的物化”、§10.5、§10.10 第 5–8 步与不变量、T-A11-8、T-A11-10(c)、新增 T-A11-11、§14.1 PR-2 | 物化行就是本次 revoke 的撤销行，`revoked_binding_ids = S1 ∪ {该 Binding}`；第 7 步总对 S1 执行；只有“行已存在且 S1 = ∅”才是幂等成功（`ALREADY_REVOKED`），行已存在但 S1 ≠ ∅ 时扩展同一行并撤销 S1，不违反 one-open 索引。任何成功提交且锁定 I 的写，在看到 `CONNECTION_USER_REVOKE` 时先物化。T-A11-10(c) 的不变量限定为“显式 revoke 成功之后”；新增 T-A11-11：HISTORICAL 仍有效的 Binding + `revoke_self_v12`（及 `revoke_issuer`）+ Native revoke → 全部撤销，并覆盖先被其他写物化、再 revoke 扩展同一行的变体 |
| MINOR-N1 | §10.1 CAS、§10.10 输入与第 2 步、§10.15、T-A11-10(a) | revoke 不再接受 `base_version`（单调，靠 L5 + 连接集重读）；T-A11-10(a) 期望值确定为 `integration_revoke_connection_set_changed`。§10.1 写明 Binding 通道 `create_or_bind` / `adopt_binding` 不带 `base_version`（CAS 主语是 Request + L5 下复核），`confirm_rebind` 带；§10.15 同步 |
| MINOR-N2 | §10.12（前置守卫、`t_loss`、清除 mark）、§5.9 `cleared_by` 增加 `RESTORE`、§11.2、T-A11-3、T-A9-12 | restore 要求 `historical = NONE`（否则 `integration_superseded`）且不在 CLAIM_CONFLICT / PENDING_RECONCILE；定义三种情形下的失效基准时间 `t_loss`（撤销行时间；有 current connection 时取已到达的过期 / 撤销时间与 open mark 时间的较晚者；无 current connection 时取最新 `unlinked_at`）；restore 清除早于新授权的 open mark（Receipt 列出），因此测试期望的 VERIFYING 成立；晚于新授权的 mark 保留并标注 |
| MINOR-N3 | §10.10 第 4 步与范围说明、§5.5、§11.2（删除 `integration_revoke_requires_owner_confirmation`）、§12.2、T-A11-8、OQ-13 | `revoke_self` 总会撤销调用方同一身份的 Binding；S1 ⊄ LINEAGE 时返回 `PARTIAL_CONNECTION_REVOKE`（不写撤销行，Integration 派生 REVOKED），提示 Owner 撤销整个 Integration |
| MINOR-N4 | §10.10 第 1、3、8 步与“跨 owner”说明、新增 T-A11-12 | S0 / S1 只含 `binding.user_id = I.owner_id` 的 Binding；指向他人 Binding 的 connection（C7）不被触碰，只在 Receipt 中计数 |
| MINOR-N5 | §10.3 第 6 步、§10.4、§11.2、新增 T-A10-12 | CLAIM_CONFLICT / PENDING_RECONCILE 时，改变 claim key 或降级维度的 bind / identity_update 一律 `integration_claim_blocked`（SUPERSEDED 为 `integration_superseded`），冲突只能经 reconcile 或撤销 / 暂停解决 |
| MINOR-N6 | §10.1 (c) 与“持有者约束”、§10.2 输入、T-A10-11(g) | Native `bind_connection` Request 可固定 `expected_provider_connection_id`（S6 Connect 必须固定）；未固定时 `request_id` 是单次使用的 bearer secret，不出现在任何 Binding 通道响应中 |
| MINOR-N7 | §10.3 第 6、8 步与 `C_eff` 定义、`fresh_consent` 比较时间、§10.11、新增 T-A11-13、OQ-14 | `C_eff(T) = ceiling ∩ 每个在 ceiling 设定后发生过 v12 reduce 的连接 Binding 的当前 authority`；链接时用 `C_eff` 判定 covers，并把降低后的 ceiling 落盘；`fresh_consent` 须晚于最近一次 reduce |
| MINOR-N8 | §5.9、§7.2（`integration_revocation_status_v1`）、§8.2 输出字段、§10.3 第 6 步、§10.5、§10.12、新增 T-A11-14 | 规定 evaluate 输出含 `reason_codes` 与完整 `facts`；撤销守卫改读共享的 `integration_revocation_status_v1`，不再读不存在的 `e0.revocation_state`，因此“既撤销又无效”的 Integration 也不能被链接 |
| MINOR-N9 | 文件头、§14.1 说明与 PR 表 | 基点更新为 `origin/main` `d3c2f950`（PR #331 已合入，`20260925020000` 在 main）；`20260925030000` 记为预留给未推送的 S2a-2 search PR；占位保持 `20260926*` 并保留 PR 时重取规则。T-A9-2 从 PR-3 移到 PR-4（它用到 PR-4 的 `lifecycle installation_completed`）；PR-2 显式包含 revocation 类表与读侧函数（规范化需要） |
| NIT-1 | §10.3 第 2a 步、T-A10-1 | `bound_intent_sha256` 改用被链接的 Binding（`confirm_rebind` / `adopt_binding` 为指定 Binding），Owner 确认后 Host 的重放不再被判为绑定到其他 Integration |
| NIT-2 | §5.2 CHECK、§10.3 `covers` 表与交集定义 | `C.entries = 列表`、`A.entries = LEGACY_UNRESTRICTED` → 不覆盖；新增 `integration_ceiling_valid_v1` 形状 CHECK |
| NIT-3 | §5.1 compatibility rules CHECK 与种子说明、§10.6 | 至少一个 `min_*` 非空；`degraded_mask` 按词表校验；`package_version` 为 null 而规则要求时 fail closed；比较与 subject digest 都读 `integrations_v1` 的列，`declare` 同事务更新这些列 |
| NIT-4 | §10.5 | `REBIND_TO_HOLDER` 先按 id 对 I 与 H 的 CURRENT Binding 取 L1（再 L2、L4、L5），L5 下复核 |
| NIT-5 | §10.10 `revoke_self` 范围说明 | 不再把用户指向 Worker 不暴露的 `revoke_self_v12`；只撤销本连接的路径为 Host 断开或 Clued 连接管理页 |
| NIT-6 | §10.12 末条、T-A9-12 | 写明健康 `FORBIDS_REAUTH` Integration 的 Owner 路径：先 revoke 再 restore，或由 Operator 改 policy |
| NIT-7 | §10.10 锁等待说明、本节事实 | 按代码更正为 `FOR SHARE`；revoke 的 L1 `FOR UPDATE` 只是有界等待，不会死锁 |

未完全解决 / 仍依赖外部核实：
- Claude / ChatGPT 重连时是否复用 DCR `client_id`，以及它们何时发送 RFC 7009 撤销（用户断开还是例行清理），仍未核实（R14、OQ-2 选项 C 依赖 S3）；
- `20260925030000` 的占用只能按协调约定记录，无法从任何远端 ref 证实。

§17 的 Owner 门控集合不变：OQ-1、OQ-2（已重写）、OQ-3、OQ-14、OQ-20、OQ-21；评审门控 OQ-6、OQ-8 不变。

### v0.1.1（2026-09-24）— 按独立评审 FAIL（0 BLOCKER / 6 MAJOR / 12 MINOR / 5 NIT）修订

基线未改动（SHA-256 `2c5950f1…baaf3`，153,289 bytes）。所引用的仓库事实已在 `apps/clued-cloud/supabase/migrations` 核对：
- `authorizations_v12.created_at` 存在，`authorization_requests_v12` 没有 `created_at`；
- `authorization_audit_v12(id, owner_id, binding_id, request_id, operation, version, selected, recorded_at)` 中，`operation` 没有 CHECK。`manage_v12` 写入 `'revoke'` / `'reduce'`，`revoke_self_v12` 写入 `'revoke_self'`，`revoke_issuer_v12` 写入 `'revoke_issuer'`（v0.1.2 更正：v0.1.1 未核对这些函数的调用方，把 `revoke_issuer` 误当作签发方侧失效，见 v0.1.2 MAJOR-N1）；
- `clued_agent_bindings.created_at` 存在。P5 增加了 `organization_id` / `workspace_id` / `role` / `revocation_epoch` / `expires_at`，并把 scope CHECK 扩展到 `canonical:*`、`project:*`。v12 Binding 的 `oauth_client_id` 写为 NULL；
- M1 `exception when others` 把 `22023` / `23505` / `40001` / `42501` 落为 `rejected`。`20260824123000` 在 public wrapper 中把已知 `40001` 冲突改抛为 `23505`；
- `clued_authorization_approve_v12` 首行调用 `authorization_owner_v12()`（直接人类会话）；
- 最新迁移文件为 `20260925020000_record_update_field_merge.sql`。

| 发现 | 修订位置 | 修订内容 |
|---|---|---|
| MAJOR-1 | §5.5、§10.1（新增“Rebind 授权”）、§10.2、§10.3 第 6/8 步、§10.10 第 4 步与范围说明、§10.15、§11.2、§12.2、§12.4、T-A10-11、T-A11-8、R11、R14 | Binding 通道的 REBIND_CLASS 必须满足 `Request.host = T.host`，并且满足 SELF、SAME_PROVIDER_CONNECTION（同一 v12 `client_id`）或 NATIVE_BIND_REQUEST 三者之一；否则拒绝为 `integration_rebind_requires_owner_confirmation`，由 Owner 通过 Native `confirm_rebind` 确认。connection 行记录 provider-connection 快照和 `link_authority`。`revoke_self` 只撤销同一 provider-connection 身份的 Binding，存在其他仍有效的 Binding 时拒绝为 `integration_revoke_requires_owner_confirmation`。**偏离说明：**host 不一致一律拒绝为 `integration_host_mismatch`，Native 确认也不能覆盖，因为 host 是不可变的 Tuple 维度；换 host 只能新建 Integration。这比“否则需 Native 确认”更严格，与基线 §15.1 一致 |
| MAJOR-2 | §8.3（`reauth_recoverable`、`B9`）、§8.4 与对照表、§8.5 注、P5 golden vector、T-A9-9、T-A11-4 | REAUTH_REQUIRED 要求 `lifecycle_facts.historical = NONE`；SUPERSEDED 且凭据丢失时派生 BLOCKED（B1/B3/B9）。新增 `GV-SUPERSEDED-CREDENTIAL-LOST` 及其对照向量，T-A9-9 改为断言 BLOCKED 且 ≠ REAUTH_REQUIRED |
| MAJOR-3 | §7.1 规则 1、§13.0、P3、P4、T-A7-2、T-A7-9、T-A8-3 | `facts_sha256 = sha256((facts - 'as_of')::text)`；凡是断言结果“不变”的测试都固定 `p_as_of`；新增一个用例：不同 `as_of` 得到同一 hash，并验证诊断去重 |
| MAJOR-4 | §10.1（新增“写后有效性门”）、§7.3 处理、§10.10 第 8 步、T-A7-9、T-A11-9 | 只有写入使结果从有效变为无效，或引入新的 reason code（`R1 ≠ ∅ ∧ R1 ⊄ R0`）时才拒绝；revoke 永不拒绝；修复类操作在 `R1 ⊆ R0` 时允许提交。新增测试：对以 replica 模式构造的无效 Integration 执行撤销 |
| MAJOR-5 | §10.10 第 1–3 步与“保证层级”说明、§11.2、T-A11-10、R13 | 取得 L5 后重读 CURRENT/HISTORICAL 连接集；若有变化，返回可重试的 `integration_revoke_connection_set_changed`。新增 revoke 与 create_or_bind 的确定性、反序和随机并发测试。写明 S2c 中 §39 的“不恢复”只在 Integration truth 层成立；在同意页由直接人类完成的新 v12 批准，就是 §39 所说的“新的授权决定” |
| MAJOR-6 | T-A11-1（固定 `test.complete` + `clued.oauth.v12`）、新增 T-A11-1b、T-A11-4b、§5.9、§7.1/§7.2 `revocation_source`、§10.11、§10.12、R1、R4、OQ-2 | 补上身份不完整时的预期：新建 Integration 并生成自己的 Receipt，旧 Integration 保持 REVOKED；raw provider 的情形也写明预期。OQ-2 的保守临时规则：`authorization_audit_v12.operation ∈ {'revoke','revoke_self'}` 或无法归因的 current connection 撤销，派生为 REVOKED，需要显式 restore，restore 时物化为 `CONNECTION_REVOKE_ADOPTED` 行；只有过期和 `revoke_issuer` 派生为 REAUTH_REQUIRED（v0.1.2 已更正：`revoke_issuer` 是 Host 断开，改为 REVOKED） |
| MINOR-1 | §5.15 第 4 条、§7.2 `oauth_scope_facts`、§10.2、§10.14、§11.2、T-A9-11、OQ-4、OQ-11 | P5 租户 Binding（`organization_id` 非空，包括 `role='denied'`）一律 `binding_not_adoptable`，也不能作为 create_or_bind 的调用方；非 P5 Binding 上的 `canonical:*` / `project:*` 被丢弃，只收窄不扩张，丢弃情况记入 `sources_read`；`workspace_id` 登记为 OQ-4 的候选来源 |
| MINOR-2 | §5.9 regrants、§10.3 第 8 步、§10.11、§10.12 | “新授权决定”的判断改用 `authorizations_v12.created_at`；raw Binding 用 `clued_agent_bindings.created_at`。新增 `new_authorization_created_at` 字段；`new_authorization_request_id` 只作为 provenance |
| MINOR-3 | §5.4 注意、§13.0、T-A10-4、T-A10-9、T-A7-9 | 更正 replica 模式的依据：它只停用触发器。C2、C3、C6 以及多行 CURRENT 的情形改在 facts 层构造，或在一次性库中 drop constraint / drop index 后构造 |
| MINOR-4 | §10.1（授权检查位置、CAS 传输）、§11.1 | 返回 403 的检查放在 `m1_begin_receipt` 之前。Receipt 内的 `40001` 以 `rejected` envelope 返回，Worker 归类为 conflict，REST 返回 409；Receipt 外沿用 `23505` 映射为 409 |
| MINOR-5 | §6.4（pre-1…pre-5，“L4 永远先于 L5”）、§10.3 第 5 步、§10.4、§10.5 | 所有调用 claim 的操作先计算 key，取 L4，再取 L5 并复核；claim 核心不再自行取 L4；H ≠ I 时只读 H |
| MINOR-6 | §5.2 CHECK、§6.5、§7.3 C3、§10.5、OQ-19 | `conflicting_integration_id` 在 CLAIM_CONFLICT 与 PENDING_RECONCILE 中都保留；INCOMPLETE ⇔ INCOMPLETE_UNCLAIMED；撤销 OQ-19 |
| MINOR-7 | §10.3 第 6 步、§10.12（`restore_kind`）、§5.9、§11.2、T-A9-12 | `FORBIDS_REAUTH`：已授权过的 Integration 再以新连接恢复时，拒绝为 `integration_recovery_forbidden`；唯一出口是 Native restore（`FORBIDS_REAUTH_RECOVERY`），或由 Operator 修改 recovery_policy |
| MINOR-8 | §5.1 `integration_compatibility_rules_v1` 与种子说明、§7.2、T-A9-7 | 新增最低版本规则表，迁移中为空；新增版本比较函数，版本不可解析时 fail closed；测试自行插入规则 |
| MINOR-9 | §10.2 输入、§10.3 Native 段与第 3/6 步、§11.2、T-A9-3 | Native 路径下 `provider` 取 Request 的必填字段，connection 维度为 UNAVAILABLE 或 NOT_APPLICABLE；BIND_CONNECTION 要求 provider 一致，并视为一次 late strengthening |
| MINOR-10 | 文件头、§14.1 表与依赖 | 占位时间戳从 `20260926000000` 起；文件头注明 `20260925020000`（pending）和 `20260925030000` 已被占用，并保留在 PR 时重新取值的规则。PR-1 只声明纯函数层证明；T-A7-1/2 移到 PR-3；依赖改为严格串行 PR-1→2→3→4→5→6 |
| MINOR-11 | §5.13、§12.1、§10.7 CRV-3、R7、§14.2、T-S-2、§13.0、OQ-21 | 默认不授予 grant，由测试在测试库中显式授予；CRV-3 标为弱证据，只能导致 FAIL；更正 R7 的前提（revoke 会写入 Binding 和 v12 表） |
| MINOR-12 | §5.2 ceiling 改为 jsonb 并加 `authorization_ceiling_set_at`、§10.3 `covers` / `fresh_consent`、§10.11、T-A11-5、§17、OQ-14 | ceiling 同时覆盖 scope 与 v12 resource entries；v12 同意页上较新的直接人类批准可以合法扩权；`capability_expansion` 降为 raw Binding 的可选路径；OQ-14、OQ-21 加入 §17 门控 |
| NIT-1 | §10.3 第 2 步、T-A10-1(d) | BOUND 的判断先于 intent 比较；BOUND 状态下以相同 intent 和相同调用方重放时，过期后也返回成功；定义 `bound_intent_sha256` 的输入 |
| NIT-2 | §12.3 | 更正导出名；写明 Information Flow 由 `recordsV2Enabled` 控制，Integration 必须使用独立的 `integrationRuntimeEnabled` |
| NIT-3 | 文件头、§0、OQ-18 | 冻结 Decision 为 `b4a7f879-88d8-4772-ace6-6e8fda591f77`；OQ-18 标为已回答 |
| NIT-4 | §10.9 | status 输出补充基线 §15 建议的审计字段，均为只读投影，不进入 facts |
| NIT-5 | T-A7-10 | 测试角色需显式获得 EXECUTE 与 schema USAGE |

OQ 表（§16）增加“裁定方”列：
- OQ-6、OQ-8 改为评审裁定，但仍属门控；
- OQ-18、OQ-19 标为已解决；
- 每个 Owner 问题都给出推荐选项；
- §17 的 Owner 门控集合为 OQ-1、OQ-2、OQ-3、OQ-14、OQ-20、OQ-21。
