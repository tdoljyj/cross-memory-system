# Owner Credential v0.1：范围授权与直达确认链接

状态：**设计已合入（PR #505）；第 1–3、5 步已上线；第 4 步（Task `2a31ca2a`）已实现，需生产迁移、Worker 发布和 Owner 设置后生效；第 6 步（Task `832658e0`，等宿主支持）未做。** 本文不授予实施、迁移、发布、合并或权限变更；每一步实施由 Owner 逐步授权。

- 第 1 步（Owner 授权 2026-10-02，Task `3b7adacc`）：迁移 `20261002220000_owner_grants_v1.sql`，测试 `apps/clued-cloud/tests/owner-grants-db.test.mjs`。
  - Agent 侧：`clued_owner_request_v1`、`clued_owner_request_status_v1`（Binding）。
  - Owner 侧（Native 登录会话）：`clued_owner_request_view_v1`、`clued_owner_grant_confirmation_issue_v1` + `clued_owner_grant_v1`、`clued_owner_request_reject_v1`、`clued_owner_grant_revoke_v1`、`clued_owner_grants_list_v1`。
  - 门口消费：内部函数 `clued_private.owner_grant_consume_v1`。尚无门口调用它，现有行为不变。
  - "只批一次"的授权 24 小时内有效、只能用一次；Owner 直接发起（不经请求）的授权一律给任何 Agent。
  - 生产迁移已应用（2026-10-03，生产版本 `20261003005742`，Decision `ec16a36d`）。
- 第 2 步（Owner 授权 2026-10-03，Task `9cabcfa0`）：
  - MCP 工具 `clued_owner_request`（`apps/clued-cloud/worker/owner-requests.ts`，开关 `CLUED_OWNER_REQUESTS_V1`）：只带 `request_id` 时查状态，否则创建请求；结果带绝对链接 `confirm_url`。只接受 Binding（委托 OAuth 到这里已换成它的 Binding），账号或旧 OAuth 令牌被拒。
  - 确认页 `/confirm/<id>`：打开即按默认选择（"管一段时间"，时长取 Agent 建议，否则 4 小时；只给发起的 Agent）签发确认；改选择就重新签发，只有页面上显示的那一版能被批准。点"批准"时若确认快过期，先按同样选择重签，只有 Clued 渲染出的内容完全相同才提交。Agent 说明单独一栏，标"未核实"。未登录可在页内登录。
  - 授权列表页 `/grants`：有效授权的剩余时间和已用次数、一键撤销，以及等待确认的请求链接。
  - 测试：`tests/owner-requests-transport.test.mjs`、`tests/owner-grants-ui.test.mjs`。
  - §4 第 3 条"放宽或收窄范围"后来补上（Task `fcd55008`，见下）。
  - 已发布（2026-10-03，发布 run 37089156567），Owner 已开 `CLUED_OWNER_REQUESTS_V1`。
- 放宽或收窄范围（§4 第 3 条，Task `fcd55008`，Owner Decision `c4e82dee`）：迁移 `20261003190000_owner_grants_scope_choice.sql`，测试 `tests/owner-grants-scope-db.test.mjs`、`tests/owner-grants-ui.test.mjs`。
  - 选"管一段时间"时，请求里的每个资源单独一行：取消勾选即收窄（至少留一行），从下拉选 Clued 给出的上级通配即放宽（`owner_grant_scope_options_v1`：逐级到 `**`，`repo:` 最宽到 `<owner>/<name>/**`，`record:` 不能放宽）。不能手填、不能换资源类型；所选不在可选项里返回 `owner_grant_resources_not_offered`。
  - 批准的仍是 Clued 按所选资源渲染、两步令牌绑定的那一版；"只批这一次"仍只覆盖请求里的资源。
- 第 3 步（Owner 授权 2026-10-03，Task `13bb5d2c`）：迁移 `20261003030000_work_claims_owner_grants.sql`，测试 `tests/work-claims-owner-grants-db.test.mjs`。
  - 超过每 Task 认领上限时，`work_claim_issue` 先认旧豁免（到期为止），否则在认领自己的事务里消费 `work_claim.extra_claims` 授权（资源 `record:<task_id>`、Task 限定、每次认领或接管用一次），认领 Receipt 记下授权 ID 与第几次。
  - 都没有就拒绝，拒绝里带上这个 Binding 对该 Task 的待确认请求（没有就新建，建议 24 小时、5 次），Worker 补上绝对链接 `owner_request.confirm_url`；原来的 `owner_exemption_path` 不再返回。
  - 新豁免停发：`clued_work_claim_exemption_confirmation_issue_v1` 返回 `work_claim_exemption_retired`；迁移前已发出的第 1 步令牌仍可确认。`/work-claims/exemption` 改为说明页，指向 `/grants`。
  - 已上线（2026-10-03）：生产迁移版本 `20261003035202`（Decision `a9cb070a`），发布 run 37094621010。
- 第 4 步（Owner 授权 2026-10-03，Task `2a31ca2a`）：迁移 `20261003170000_owner_grants_release_door.sql`，测试 `tests/owner-grants-release-door-db.test.mjs`、`scripts/ci/clued-release-grant.test.mjs`、`tests/production-release-gate.test.mjs`。
  - 门口函数 `clued_owner_grant_door_consume_v1`（Binding，`context:write`）：只接受登记了 `release-workflow` 门口的动作；按动作与资源找授权，不看受权方和 Task（Owner 选择）。用掉一次记 `OWNER_GRANT_USED` Receipt（`door: release-workflow`）。没有授权就复用或新建这个 Binding 的待确认请求（建议 1 次、24 小时）并返回。
  - 发布 workflow：job 进 `clued-release` environment；新增 `migrate` 模式（输入 `migrations`，逗号分隔的文件名）；`deploy` 与 `migrate` 先跑 `scripts/ci/clued-release-grant.mjs`。
  - 授权检查先只提示（Owner 选择）：Owner 设仓库变量 `CLUED_RELEASE_GRANT_ENFORCE=true` 后才拦。
  - Agent 合同升到第 20 版，§6.6 写明发布与迁移前按提交申请授权。
- 第 5 步（Owner 授权 2026-10-03，Task `340693ee`）：Agent 合同升到第 14 版，§6.6 写明 Owner 批准只来自 Owner 本人登录的页面、`confirm_url` 原样交给 Owner、不得自称已批准、被拒或过期就停；§4 错误表的 `work_claim_budget_exhausted` 改为先给 `owner_request.confirm_url`。尚无门口消费的动作（发布、迁移）仍按 §6.4 需要明确授权。Worker 发布后服务端 `/clued-agent.md` 才是第 14 版。
日期：2026-10-02
Task：`17ab25b3`（Global）。Owner 决定：方向与优先级见 Task `17ab25b3` v3，规则见 Decision `6fa79397`，待定三条见 Decision `667f588b`（§11）。
相关：[GenericWorkClaim.v0.1.md](../execution-admission/GenericWorkClaim.v0.1.md)（门卫与资源模型）、[NativeWriteSurfaces.v0.1.md](../information-flow/NativeWriteSurfaces.v0.1.md)（现有 Owner 本人确认面）。

---

## 0. 一句话结论

Owner 的话经过 Agent 转达，就不能当凭证：Agent 能看到口令，也能偷换被批准的事。凭证只能来自 Agent 碰不到的通道，也就是 Owner 本人登录的 Clued 网页（手机浏览器同样可用）。

在这个前提下，本文做两件事来减少 Owner 的负担：

1. **范围授权（Owner Grant）**：确认一次，管一段时间、一类动作、一个范围。默认 4 小时，最长 7 天，可随时撤销。
2. **直达确认链接（Owner Request）**：需要确认时，Agent 给出一个链接，打开就是那一条确认，一点完成。

首批接入两类动作：生产发布与生产迁移、认领豁免（Decision `6fa79397`）。

宿主签名作为长期方向，只预留接口：Claude、Codex 等宿主若对用户亲手输入的消息签名，对话里说的"同意"就能直接当凭证。

---

## 1. 问题与边界

### 1.1 为什么对话里的话不能当凭证

- **Agent 看得到口令**：Owner 在对话里打出的任何口令，Agent 都能看到，之后可以冒用。
- **Agent 能偷换被批准的事**：Owner 以为在批准 A，Agent 拿着这句"同意"去做 B。
- **Clued 只能看到 Agent 转来的内容**：在 Clued 看来，"Owner 说同意"和"Agent 声称 Owner 说同意"没有区别。

Agent 写进 Clued 的 `authority=user_explicit` 记录也一样：它记录的是 Agent 的声明，不是 Owner 的证明。Clued 已经区分这两者：`human_confirmed` 只来自 Native 确认的标记，Agent 写的记录永远拿不到（NativeWriteSurfaces S3）。

### 1.2 对话弹窗的定位

宿主的选择弹窗（AskUserQuestion）仍是 Owner 做决定的主要方式（常驻约束 `2dca3cf1`）。它的结果记成 `user_explicit`，用于偏好、方向和低风险决定。

凡是有门口能拦住的动作，以本文的授权为准，弹窗记录不能代替。

### 1.3 能保护的范围

授权只在"门口"生效，门口包括 Clued 自己的写入面，以及装了传话口的外部动作（GenericWorkClaim §3）。Agent 绕开所有门口直接做的事，授权管不到，见 §9。

---

## 2. 现有基础（复用，不另起）

| 已有机制 | 用途 | 本文复用的部分 |
| --- | --- | --- |
| `clued_private.native_confirmation_tokens` | Information Flow S3、S4、S5，认领豁免的两步确认 | 两步确认：发一次性令牌（5 分钟），令牌绑定会话和确认视图摘要，消费时写入 |
| `clued_private.work_claim_exemptions_v1`（PR #500） | 一个 Task 24 小时内多领最多 5 次 | 本身就是一种范围授权；页面要手填任务 ID，没有直达链接 |
| `clued_private.storage_client_grants_v1` | 云盘：某 Binding、某连接、某几类动作、到期时间 | 授权对象的形状：受权方、动作、范围、到期、撤销、Receipt |
| 发布 workflow 的 `source-capture` 模式 | 只接受"已批准的授权请求 UUID 与 SHA-256" | 外部 workflow 引用 Owner 已批准请求的先例 |
| `authorization_owner_v12`、"15 分钟内登录" | Native 面只认 Owner 本人登录态，拒绝委托 OAuth 和 Binding | 沿用"只认 Owner 本人登录态"；"15 分钟内登录"不用于授权与确认请求（§11 第 2 条） |

---

## 3. 对象

### 3.1 范围授权（Owner Grant）

```
owner_grants_v1
  id                 uuid
  user_id            uuid           -- Owner
  grantee            binding_id | 'any_agent'   -- 默认发起请求的宿主，页面可选任何 Agent（§11 第 1 条）
  action             text           -- 动作类，登记在 owner_grant_actions（§3.3）
  resources          text[]         -- GenericWorkClaim 的资源写法，如 repo:o/n/**、record:<id>
  task_id            uuid null      -- 可选：只对某个 Task 生效
  max_uses           int null       -- 可选：最多用几次
  uses               int
  granted_at, expires_at            -- 默认 4 小时，最长 7 天（Decision 6fa79397）
  revoked_at         timestamptz null
  token_id           uuid           -- 对应的 native_confirmation_tokens
  receipt_id         uuid
  request_id         uuid null      -- 来自哪个确认请求（§3.2）
```

规则：
- **只能经 Native 两步确认创建**：没有 MCP 工具、OAuth 路径或 Binding 路径，Agent 给自己授权不了。
- **撤销立即生效**：Owner 在页面上撤销后，之后的每一次使用都会被拒。
- **使用就是消费**：门口在自己的写入事务里调用 `owner_grant_consume(user, grantee, action, resources, task)`。找到一条有效且覆盖本次资源的授权，就把 `uses` 加 1 并写一条 Receipt，Receipt 里带上授权 ID；找不到就拒绝，并返回 `owner_confirmation_required` 和一个确认请求（§3.2）。
- **资源覆盖**沿用 GenericWorkClaim 的规则：同一个 kind 按路径规则判断是否覆盖，不同 kind 之间永不覆盖。

### 3.2 确认请求（Owner Request）

```
owner_requests_v1
  id                 uuid
  user_id, binding_id               -- 谁发起的
  action, resources, task_id        -- 结构化：要做什么、动哪里
  suggested_grant    {expires_in, max_uses} null   -- Agent 建议的授权范围
  agent_note         text null      -- Agent 的说明，页面标注"未核实"
  status             pending | approved_once | granted | rejected | expired
  grant_id           uuid null
  created_at, expires_at            -- 请求本身 24 小时内有效
```

- Agent 用 MCP 工具 `clued_owner_request` 创建请求（需 `context:write`），返回 `request_id` 和直达链接 `https://clued.pixelgrav.com/confirm/<request_id>`。
- 同一个工具可以查询状态，也可以由门口在拒绝时自动创建。
- Agent 只能发起请求，不能批准请求。

### 3.3 动作登记

动作类登记在 `owner_grant_actions`，做法与 GenericWorkClaim 的 kind 登记表相同：
- 只有已登记的动作才能被授权，也才能被请求；
- 每个动作写明哪个门口会消费它。

首批动作：
- `release.production`：运行发布 workflow 的 deploy 模式；
- `migration.production`：经 workflow 应用迁移到生产库；
- `work_claim.extra_claims`：替代认领豁免。

---

## 4. 流程

1. Agent 要做一件需要 Owner 批准的事：
   - 已有有效授权：门口直接放行并记一次使用，**Owner 不用做任何事**。
   - 没有授权：门口拒绝，并返回确认请求和链接。Agent 也可以事先主动创建请求。
2. Agent 把链接发给 Owner。在对话里，链接就是弹窗文字的一部分。
3. Owner 在电脑或手机浏览器打开链接，看到确认页（§5），有三个选择：
   - **只批这一次**：生成一条 `max_uses=1` 的授权，只覆盖这次请求的资源。
   - **批这一类，管一段时间**：时长默认 4 小时，可选到 7 天；范围默认等于请求的资源，Owner 可以在页面上放宽或收窄。
   - **拒绝**。
4. Agent 重试，门口消费授权后放行。

Owner 同一天内同类的确认，只需要在第一次时选"管一段时间"。

---

## 5. 确认页

- **主体由系统生成**（Decision `6fa79397` 第 2 条）：页面上"要批准什么"一栏（动作、资源、Task、期限、次数）由 Clued 按结构化字段渲染，Agent 改不了措辞。
- **Agent 说明单独一栏**：`agent_note` 显示在下方，标注"Agent 说明（未核实）"。
- **本人确认**：沿用 Native 两步令牌。令牌绑定当前登录会话和确认视图摘要，5 分钟有效，一次性。只要求 Owner 本人有效的登录会话，不要求最近登录时间（§11 第 2 条）。
- **页面和交互**：
  - 手机尺寸可用：按钮够大，内容不横向滚动。
  - 直达：URL 里只带 `request_id`，打开即见，不用手填任何 ID。
- **授权列表页**：列出有效授权（剩余时间、已用次数），一键撤销。

---

## 6. 首批接入

### 6.1 生产发布与生产迁移

现状：
- 发布 workflow 只校验 `github.actor == repository_owner`。Agent 用的就是 Owner 的 GitHub 身份，所以这条区分不了 Owner 和 Agent。
- 生产迁移由 Agent 直接用 Supabase MCP 的 `apply_migration` 执行，不经过任何门口。
- 目前的"授权"只是对话弹窗加一条 `user_explicit` Decision。

设计：
- **发布 workflow 新增 `migrate` 模式**：
  1. 从 main 的这次提交读取尚未应用的迁移文件；
  2. 用 `secrets` 里的生产数据库连接应用迁移；
  3. 逐个核对 `md5(statements)` 与文件一致；
  4. 写出证据。

  有了这个模式，迁移不再需要 Agent 直接连生产库。
  每个文件和它的 `schema_migrations` 行在同一个事务里写入（`statements` 就是文件原文）；已登记过的名字拒绝，不重放。连接串是 `clued-release` environment 里的 `CLUED_MIGRATION_DATABASE_URL`。
- **`deploy` 与 `migrate` 的第一步是授权检查**（传话口）：
  - 调用 Clued 的 `clued_owner_grant_door_consume_v1`，动作分别是 `release.production`、`migration.production`，资源是 `repo:tdoljyj/cross-memory-system/<40 位提交>`。
  - 调用使用 `clued-release` environment 里的 Binding token（`CLUED_RELEASE_TOKEN`）。这个 environment 限 `main`，与 `clued-admission` 的做法相同。
  - 门口只看动作和提交，不看是哪个 Agent 申请的、挂在哪个 Task 上（Owner 选择 2026-10-03）。
  - 没有授权时在运行摘要里给出确认链接；Owner 设 `CLUED_RELEASE_GRANT_ENFORCE=true` 之后才失败，之前只提示（Owner 选择 2026-10-03）。
- **`backup` 与 `preflight` 不需要授权**：它们不改变生产。

**Owner 需要做的设置**：
- 新建 `clued-release` environment（部署分支只限 `main`），放入 `CLUED_RELEASE_TOKEN`（一个有 `context:write` 的 Binding token）和 `CLUED_MIGRATION_DATABASE_URL`。
- 在 `/bindings` 页面把这个 Binding 标为"发布门口"（Task `869d2db7`，Decision `38ddb8cf`）。标出后只有它能在发布门口消费授权，其他 Agent 的 Binding 不能抢先用掉。
- 试跑一次确认能消费授权后，设仓库变量 `CLUED_RELEASE_GRANT_ENFORCE=true`。
- 建议把 Agent 使用的 Supabase 连接改为只读（Supabase MCP 支持只读模式）。否则 Agent 仍能绕过 workflow 直接改生产，§9 写明了这一点。

### 6.2 认领豁免

- 豁免改为 `work_claim.extra_claims` 授权：
  - 范围是 `task_id`，`max_uses` 为额外次数，时长沿用 24 小时；
  - 现有 `work_claim_exemptions_v1` 中尚未过期的行保留到过期（最长 24 小时），新豁免一律走授权（§11 第 3 条）。
- 被每 Task 次数上限拒绝时，`clued_work_claim` 的错误直接带上确认请求链接。Owner 打开链接即可，不用再手填任务 ID。

---

## 7. Agent 侧用法（合同增补）

- 门口返回 `owner_confirmation_required` 时，Agent 把链接原样发给 Owner，并说明要做的事。
- Agent 不得用对话中的"同意"代替授权，也不得对同一件事换个说法重复请求。
- 门口能拦住的动作，不再用对话弹窗来"授权"。弹窗仍用于方向、偏好等没有门口的决定。

---

## 8. 宿主签名（预留，未实施）

接口预留为 `owner_attestations`：
- `type = host_signed_message`
- `host`、`key_id`、`message_digest`、`signature`
- 被批准的结构化内容摘要

Clued 维护一张"受信宿主公钥"表，由 Owner 在 Native 页面登记。验签通过的消息等同于一次"只批这一次"的确认。

这要等宿主提供用户消息签名才能启用。在那之前，本节不产生任何行为。

---

## 9. 不保护什么（随实施声明原样保留）

- 没有门口的动作，例如 Agent 直接调用的外部工具，或本机命令。
- Agent 绕过发布 workflow、直接用有写权限的数据库连接修改生产。需要 Owner 把该连接设为只读才能堵上（§6.1）。
- Owner 自己在确认页上批准了不该批准的事。系统生成的主体能减少误导，但无法替 Owner 判断。
- 授权期内的滥用：在授权覆盖的范围和时长内，Agent 的每次使用都会放行。授权越宽，风险越大，所以默认 4 小时、最长 7 天，并且可以随时撤销。
- 对话弹窗与 `user_explicit` 记录：仍只是 Agent 的声明（§1.2）。
- 别人拿到 Owner 已登录的电脑或手机：因为不要求最近登录（§11 第 2 条），在登录会话有效期内可以替 Owner 点确认。设备锁屏与退出登录是 Owner 自己的防线。

---

## 10. 分步实施（每步单独请 Owner 授权）

1. **数据与核心函数**（Task `3b7adacc`）：`owner_grant_actions`、`owner_grants_v1`、`owner_requests_v1`、Native 两步确认、`owner_grant_consume`，以及测试。不接任何门口。
2. **确认页与授权列表页**（Task `9cabcfa0`）：直达链接、手机可用、撤销；新增 MCP 工具 `clued_owner_request`。Worker 发布需 Owner 授权。
3. **认领豁免迁到授权**（§6.2，Task `13bb5d2c`）。
4. **发布 workflow**（Task `2a31ca2a`）：新增 `migrate` 模式和授权检查步骤（§6.1）。Owner 需建 `clued-release` environment，并建议把 Supabase 连接设为只读。
5. **合同增补**（§7，Task `340693ee`）：agent-contract 新版本。
6. **宿主签名**（§8，Task `832658e0`）：等宿主支持后再做。

---

## 11. Owner 已定（2026-10-02，Decision `667f588b`）

1. **受权方**：默认授权给发起请求的那个 Agent 宿主（Binding），确认页可选"任何 Agent"。Owner 的所有 Claude Code 会话共用一个 Binding（Decision `533a5286`），所以授权对这些会话都有效。
2. **不要求最近登录**：授权与确认请求只要求 Owner 本人有效的登录会话，不检查最近一次登录的时间。仍拒绝委托 OAuth 与 Binding，仍用一次性两步令牌。现有 Information Flow S3/S4/S5 与认领豁免的 15 分钟规则不在本决定范围内，保持不变。
3. **旧豁免**：现有认领豁免记录保留到过期，新豁免一律走授权。
