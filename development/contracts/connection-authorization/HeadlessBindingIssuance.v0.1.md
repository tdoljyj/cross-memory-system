# 无头 Binding 签发 v0.1

Owner Decision `6e0371e3`，Task `364212a1`。迁移 `apps/clued-cloud/supabase/migrations/20261004120000_headless_binding_issuance.sql`、`20261004170000_headless_legacy_binding_revoke.sql`。

## 用途

给不能走 OAuth 的客户端（CI、runner、脚本）签发它自己的 Clued Binding 令牌。Claude、ChatGPT 这类支持 MCP OAuth 的客户端照旧在客户端里连接，OAuth 路径（`clued_authorization_prepare/approve/deny/manage_v12`、`/oauth/consent`、`worker/delegated-oauth.ts`）没有改动。

## 规则

1. **只有 Owner 本人能签发。** 两个 RPC 都先调用 `authorization_owner_v12()`：要求直接的账户登录会话，带 `client_id` 的委托 JWT、任何 Binding、anon 都被拒绝。签发入口在 `/oauth/connections` 页面，没有 MCP 工具。
2. **两步确认。** `clued_headless_binding_confirmation_issue_v1` 按 Owner 的选择渲染确认视图，返回 5 分钟有效、绑定当前会话的一次性确认令牌；`clued_headless_binding_issue_v1` 重新渲染视图、比对摘要后才签发。视图在两步之间变了就拒绝（`confirmation_view_stale` 或对应错误），失败的确认令牌立即作废。
3. **最小权限。** Owner 逐项勾选资源（全局、个人资料、自己的项目、自己的开发上下文）和动作，写成 v12 授权条目（`authorization_entries_v12`）；令牌只能做勾选的事。签发后可在同一页面减少权限或撤销（沿用 `clued_authorization_manage_v12`）。
4. **必须有有效期。** 1 到 90 天，页面提供 7、30、90 天。有效期只记在 v12 授权（`authorizations_v12.expires_at`）上，与迁移 `20260927232454` 的约定一致，`clued_agent_bindings` 不加有效期列。到期由两处保证：经过 `resolve_binding` 的调用由 `authorization_assert_entry_v12` 立即拒绝；`clued_private.binding_expiry_sweep_v1()` 每 5 分钟（生产库 pg_cron 任务 `clued-binding-expiry-sweep`）把到期的无头 Binding 标记为撤销，使只检查 `revoked_at` 的路径最多 5 分钟后也停止接受。
5. **令牌只出现一次。** 原始令牌在数据库内生成，只在第二步的响应里返回一次；历史签发实现写入 SHA-256 证明值，P0-4 2a 生效后的认证列存带域的 `cv1:` 校验值，由受控触发器转换该证明值。客户端证明仍为 `sha256(token)`，存储校验值不能直接用于认证；重放第二步返回 `token: null`。回执（`HEADLESS_BINDING_ISSUED`）记录 Binding、权限、有效期、确认视图摘要和会话，不含令牌。
6. **轮换。** 第一步可以指定被替换的 Binding（无头令牌，或没有 v12 授权记录的旧 Binding；OAuth 连接不能被替换）。签发后旧 Binding 再保留 1 小时然后失效（退役时间记在 `clued_private.binding_retirements_v1`，无头的旧 Binding 同时缩短其授权有效期；到点由同一个清扫撤销），它的 Binding 角色（`ci-admission`、`release-door`）在同一事务里移到新 Binding，每条角色记录保留原来的生效时间和用途（主备 C10，Task `bb13efb5`，迁移 `20261023010000`），所以轮换不会缩短移交后的 5 分钟等待；新权限必须包含角色需要的权限，否则第一步就拒绝。
7. **上限。** 每个 Owner 同时最多 50 个有效的无头 Binding。
8. **撤销旧方式创建的 Binding。** 没有 v12 授权记录的旧 Binding，`clued_authorization_manage_v12` 撤销不了，改由 `clued_headless_binding_revoke_v1` 在同一页面撤销：同样只接受 Owner 本人的直接登录会话，只能撤销自己名下、仍有效、没有 v12 授权记录的 Binding（无头令牌和 OAuth 连接仍走 `manage_v12`）。它不结束这个 Binding 的角色：角色锁在已撤销的 Binding 上，直到 Owner 在 `/bindings` 给有效的 Binding 标上或取消（迁移 `20261004220000`，与 `manage_v12` 撤销一致；常驻执行器的停车位靠的正是这一点）。回执 `LEGACY_BINDING_REVOKED` 写明保留的角色（`roles_kept`），v12 审计记录为 `legacy_revoke`。被轮换、等待退役的旧 Binding 也可以这样提前撤销。

## 令牌能用在哪里

- REST：`Authorization: Bearer <令牌>` 调用 `https://clued.pixelgrav.com/v1/…`。
- 数据库 RPC：客户端仍提交 `p_token_hash = sha256(token)`；数据库按带域的 `cv1:` 校验值认证 Binding，并复核其角色、授权、撤销和有效期。C1阶段2生效后，CI/钩子直接走 publishable key/anon 的范围仅为实际 CI/钩子源码核定的公开 RPC 集合；当前为精确CI8，G6不在其中。其他 Worker manifest 内的 Binding RPC 经 Worker 以 `clued_worker_gateway` JWT 运输，不向无头客户端发放该 JWT，也不因持有 Binding 令牌而允许直调全部 public RPC。REST仍使用原始 Binding bearer，生产 `/mcp` 仍只接受当前OAuth访问令牌；Native签发/撤销仍只接受 Owner 的直接登录会话。
- `/mcp` 在生产由 OAuth 提供方接管，只接受 OAuth 访问令牌；MCP 客户端请用 OAuth 连接。

## 旧入口

首页的「创建 AI 连接」表单和 `POST /api/bindings` 已下线（返回 410，指向 `/oauth/connections`）。它签发的是全部权限、`context_keys=*`、没有有效期、没有确认的令牌。首页的连接列表也已下线：OAuth 连接、无头令牌和旧 Binding 都在 `/oauth/connections` 查看和撤销，首页只留指向这个页面的链接。`GET`、`DELETE /api/bindings` 接口暂时保留，页面不再调用；`DELETE` 直接写 `revoked_at`，不写回执、不结束角色。

## 上线后

1. 生产迁移和 Worker 发布按 Owner 授权流程进行。
2. 用新工具轮换现有手工创建的 CI Binding（`clued-work-admission`、`clued-release` 等），更新对应 GitHub environment secret（Task `364212a1` 第 5 步）。
3. 用已连接的 Claude 和 ChatGPT 各做一次 `clued_session_resume`，并新增一个 OAuth 连接，确认 OAuth 不受影响（Task `364212a1` 验收条件）。
