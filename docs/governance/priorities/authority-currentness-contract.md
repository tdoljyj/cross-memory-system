# Authority / Currentness Projection Contract

**Status:** `BOOTSTRAP CONTRACT CANDIDATE / NOT AUTHORITY / NOT FROZEN`

本合同定义 fresh Agent 如何在**不从 Repository 推导权限**的前提下，把 Clued 现有真实 Binding / Authorization / Membership / Receipt 基础设施投影成多轨治理所需的：

`Principal → Visibility → Effective Actions → Currentness → Eligible Next Action`

Repository 只保存解析合同和非敏感 Projection；Token、Secret、真实授权主体和完整授权结果不得写入仓库。

## 1. 已存在的真实 Authority 基础设施

生产 `clued-prod` 当前可只读确认以下能力已经存在：

- `public.clued_resolve_binding(p_token_hash text, p_required_scope text)`
- `public.clued_authorization_status_v12(p_token_hash text)`
- `public.clued_project_access_v13(p_input jsonb)`
- `clued_private.authorization_effective_actions_v13(p_binding uuid, p_kind text, p_id text, p_environment text)`
- `clued_private.project_context_membership_v13(p_actor uuid, p_context uuid, p_environment text, p_membership uuid)`
- `clued_private.project_memberships_v13`
- `clued_private.authorizations_v12`
- `clued_private.authorization_entries_v12`

因此 Multi-Track 不创建第二套 IAM / Authorization Engine。

## 2. Authority Resolution

一个 fresh Agent 在需要执行而不仅是读取公开/仓库投影时，必须按以下顺序解析：

```text
Runtime credential / token
        ↓
resolve_binding(required_scope)
        ↓
Principal + Binding + granted scopes
        ↓
authorization_status
        ↓
Project Membership / Access
        ↓
effective Resource × Action for exact resource + environment
        ↓
Track visibility filtering
        ↓
Priority-item execution eligibility
```

任何一步为 unknown / expired / revoked / mismatched：

`AUTHORITY_CURRENTNESS = FAIL_CLOSED`

## 3. Resource × Action Projection

多轨不得把 `READY`、高 Priority 或 Assignment 当作 Authority。

最终可执行动作必须是以下交集：

```text
Priority Item Requested Actions
∩ Binding Scopes
∩ Project Membership / Group Permission
∩ Effective Authorization Entries
∩ Environment
∩ Policy / Gate
∩ Currentness
```

如果结果为空：

`eligible_actions = []`

而不是请求用户手工判断权限。

## 4. Visibility Projection

Agent 可见多轨对象必须经过：

```text
Principal
∩ Resource × Action
∩ selector / scope
∩ Track Visibility
∩ Context Relevance
∩ Policy
```

不同 Agent 可以合法看到不同 Track / Item 子集。

Zero-Memory 跨 Agent 一致性要求只比较**共享授权交集内的事实**；越权范围必须正确 redaction / unknown，而不是泄漏后再比较。

## 5. Currentness 不是单一全局数字

当前生产库存在多个不同作用域的版本/水位，例如：

- Canonical mutation / audit receipt 的 `canonical_version`；
- Context Stream / Head 的 `version`；
- Repository memory snapshot 自己的 Canonical/version pointer；
- Priority Snapshot / Projection 自己的 snapshot identity。

这些数字**不能相互直接比较**。

正式 Currentness 判断使用：

```text
Dependency Manifest
+
Scope-specific Watermarks
+
Exact Source Identity
+
Authority / Policy version where applicable
```

只有相关依赖变化才使对应 Priority Context 失效。

## 6. Priority Currentness Projection

推荐输出：

```json
{
  "principal": "opaque-runtime-principal-ref",
  "binding": "opaque-binding-ref",
  "environment": "non-production|production|...",
  "visible_tracks": [],
  "visible_items": [],
  "effective_actions": [],
  "forbidden_actions": [],
  "assignment_scope": [],
  "priority_snapshot_ref": "...",
  "dependency_manifest": [],
  "watermarks": {},
  "currentness": "CURRENT|STALE|UNKNOWN",
  "eligible_next_actions": [],
  "reason_codes": []
}
```

仓库不得保存 credential/token_hash。

## 7. Eligible Next Action

“下一项合法动作”不能由 Priority 单独决定。

```text
Current Priority Frontier
∩ READY / IN_PROGRESS legal state
∩ Dependency satisfied
∩ Resource available
∩ Assignment / Scope
∩ Effective Resource × Action
∩ Environment
∩ Currentness = CURRENT
```

若 Currentness 或 Authority 不能证明：

```text
eligible_next_actions = []
status = INDETERMINATE_FAIL_CLOSED
```

## 8. Repository-only Fresh Agent

只读取 Repository、但还没有 Clued Runtime credential 的 Agent 必须回答：

```text
Principal = NOT_RESOLVED
Runtime Authority = NOT_ESTABLISHED
Production / Canonical write authority = NONE_INFERABLE_FROM_REPOSITORY
Eligible side-effect action = NONE
```

它仍可读取其 GitHub 访问范围内的治理 Projection，并可做只读分析。

## 9. Runtime Fresh Agent

真正的 Zero-Memory final gate 必须在已授权测试身份下自动完成：

1. authenticate；
2. resolve Binding；
3. resolve visible Tracks / Items；
4. resolve effective Resource × Action；
5. verify scope-specific currentness；
6. compute eligible next action；
7. 输出结构化结果与 Evidence；
8. 至少 3 个动态 Qualified fresh-context Agent Runs 对共享授权交集进行一致性比较。

该流程必须自动运行，不要求用户手工开启多个 Agent 或整理证据。

## 10. 安全边界

禁止：

- 把 Repository `README` / JSON 当 Authority；
- 在仓库存 token / secret；
- 用 `READY` 推导执行权限；
- 把某个 Canonical Version 与无关 Context Head Version 直接比较；
- Currentness UNKNOWN 时执行高风险副作用；
- 因缺少 Runtime Binding 就要求用户手工证明数据库权限。
