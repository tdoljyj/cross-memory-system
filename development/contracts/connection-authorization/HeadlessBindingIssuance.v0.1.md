# 无头 Binding 签发 v0.1

Owner Decision `6e0371e3`，Task `364212a1`。迁移 `apps/clued-cloud/supabase/migrations/20261004120000_headless_binding_issuance.sql`。

## 用途

给不能走 OAuth 的客户端（CI、runner、脚本）签发它自己的 Clued Binding 令牌。Claude、ChatGPT 这类支持 MCP OAuth 的客户端照旧在客户端里连接，OAuth 路径（`clued_authorization_prepare/approve/deny/manage_v12`、`/oauth/consent`、`worker/delegated-oauth.ts`）没有改动。

## 规则

1. **只有 Owner 本人能签发。** 两个 RPC 都先调用 `authorization_owner_v12()`：要求直接的账户登录会话，带 `client_id` 的委托 JWT、任何 Binding、anon 都被拒绝。签发入口在 `/oauth/connections` 页面，没有 MCP 工具。
2. **两步确认。** `clued_headless_binding_confirmation_issue_v1` 按 Owner 的选择渲染确认视图，返回 5 分钟有效、绑定当前会话的一次性确认令牌；`clued_headless_binding_issue_v1` 重新渲染视图、比对摘要后才签发。视图在两步之间变了就拒绝（`confirmation_view_stale` 或对应错误），失败的确认令牌立即作废。
3. **最小权限。** Owner 逐项勾选资源（全局、个人资料、自己的项目、自己的开发上下文）和动作，写成 v12 授权条目（`authorization_entries_v12`）；令牌只能做勾选的事。签发后可在同一页面减少权限或撤销（沿用 `clued_authorization_manage_v12`）。
4. **必须有有效期。** 1 到 90 天，页面提供 7、30、90 天。到期由两处保证：`resolve_binding` 和 `binding_live_v1` 读取 `clued_agent_bindings.expires_at` 立即拒绝；`clued_private.binding_expiry_sweep_v1()` 每 5 分钟（生产库 pg_cron 任务 `clued-binding-expiry-sweep`）把到期的 Binding 标记为撤销，使只检查 `revoked_at` 的路径也停止接受。
5. **令牌只出现一次。** 原始令牌在数据库内生成，只在第二步的响应里返回一次，库里只存 SHA-256；重放第二步返回 `token: null`。回执（`HEADLESS_BINDING_ISSUED`）记录 Binding、权限、有效期、确认视图摘要和会话，不含令牌。
6. **轮换。** 第一步可以指定被替换的 Binding（无头令牌，或没有 v12 授权记录的旧 Binding；OAuth 连接不能被替换）。签发后旧 Binding 再保留 1 小时然后失效，它的 Binding 角色（`ci-admission`、`release-door`）在同一事务里移到新 Binding；新权限必须包含角色需要的权限，否则第一步就拒绝。
7. **上限。** 每个 Owner 同时最多 50 个有效的无头 Binding。

## 令牌能用在哪里

- REST：`Authorization: Bearer <令牌>` 调用 `https://clued.pixelgrav.com/v1/…`。
- 数据库 RPC：PostgREST 的 `*_v1(p_token_hash, …)` 传令牌的 SHA-256（`clued-work-admission` 就这样用）。
- `/mcp` 在生产由 OAuth 提供方接管，只接受 OAuth 访问令牌；MCP 客户端请用 OAuth 连接。

## 旧入口

首页的「创建 AI 连接」表单和 `POST /api/bindings` 已下线（返回 410，指向 `/oauth/connections`）。它签发的是全部权限、`context_keys=*`、没有有效期、没有确认的令牌。`GET`、`DELETE /api/bindings`（列出与撤销）保留。

## 上线后

1. 生产迁移和 Worker 发布按 Owner 授权流程进行。
2. 用新工具轮换现有手工创建的 CI Binding（`clued-work-admission`、`clued-release` 等），更新对应 GitHub environment secret（Task `364212a1` 第 5 步）。
3. 用已连接的 Claude 和 ChatGPT 各做一次 `clued_session_resume`，并新增一个 OAuth 连接，确认 OAuth 不受影响（Task `364212a1` 验收条件）。
