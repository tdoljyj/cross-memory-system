# Database Caller Authentication v0.1：库里只存校验值、Worker 不走 anon、G6 运输证明

状态：**Proposed，部分已定（Owner 2026-10-08 Decision `1427642f`：接受设计 A 与 7 天备份；第 1 步先单独上线；设计 C 先做第 3 步只读核实，再选 C1 或 C2）。** 本文不授予任何迁移、Worker 发布、规则集或合同版本改动的权限；每一步实施由 Owner 单独批准，每步一个 PR。
日期：2026-10-08
来源：审计 P0-4 Task `9a4d6d2c` 的步骤 4（库里存的哈希不再等于口令、G6 门不再信任客户端提交的提交号）与步骤 5（Worker 脱离 anon）；Owner Decision `8a7e345f`（2026-10-08，两步合并为一份设计稿，只写方案）。前置工作：步骤 1 卫生迁移 `20261007120000_db_security_hygiene.sql`（Decision `eed7154f`，已在生产），以及 [docs/maintenance/database-security.md](../../../docs/maintenance/database-security.md) 的「Left for later」。
对照基线：main `b290d0dd`（2026-10-08），生产库 `clued-prod` 2026-10-08 只读核对（安全检查：anon 可执行的 SECURITY DEFINER 函数 84、authenticated 69、search_path 可变 0、`rls_enabled_no_policy` 118、泄露密码保护关闭）。

---

## 0. 一句话结论

**先做 A：库里不再存「调用方送来的那个值」，改存它的再一次哈希（校验值），调用方一行不改。** 今天调用方送 `p_token_hash = sha256(token)`，库里存的也正是这个值，所以谁读到这一列谁就能冒充；改成库里存 `sha256(p_token_hash)`、函数比对时现算一次，读到列也没用，而 Worker、CI、钩子、冻结合同里的 `p_token_hash = sha256(token)` 约定全部不变。**再做 C：Worker 用自己的数据库角色调用，anon 只留给 CI 的少数门口函数**，这样持有令牌的人也绕不过 Worker 的开关、校验和范围收窄，G6 门的 `__transport_source_commit` 也随之只能由 Worker 提供（B）。A 是一个迁移、零调用方改动；C 要 Worker 发布和逐函数改授权，先核实 Worker 角色凭据怎么签发再定选项。

---

## 1. 范围与非目标

**范围**

- 所有以「调用方提交的哈希」作凭据的数据库函数：Binding 令牌（`p_token_hash`）、服务端发行方密钥（`p_issuer_hash`）、授权批准时写入的 `p_binding_hash`，以及 Resource Center 的 `clued_rc*_` 令牌。
- Cloudflare Worker 访问 PostgREST 时使用的数据库角色。
- `clued_mcp_currentness_g6_gate` 对 `__transport_source_commit` 的信任。
- 已登录用户（`authenticated`）对凭据列的读取。

**非目标**

- 不改令牌格式、签发方式、有效期或撤销语义（[HeadlessBindingIssuance.v0.1.md](../connection-authorization/HeadlessBindingIssuance.v0.1.md)）。
- 不改人类会话（Supabase Auth JWT，`authenticated`）的路径；Console 照旧。
- 不改 Owner Grant 的授权语义：门口函数照旧经 `clued_private.resolve_binding` 认证 Binding，只是比对方式变了（见 §9 对 MergeAdmission §1 非目标的说明）。
- 不处理 Worker 自身被攻破、数据库超级用户、Supabase 控制台账号被盗（§11）。
- 不含泄露密码保护（P0-4 步骤 3，Owner 控制台设置）与 mtpe 测试 schema 清理（步骤 2，Decision `8a7e345f` 定为以后再做）。

---

## 2. 现状基线

### 2.1 谁在调用数据库、拿什么凭据

| 调用方 | 走法 | 数据库角色 | 凭据 |
|---|---|---|---|
| Worker，Binding 路径（66 个 RPC：`clued_mcp_*`、记录、项目、信息流、认领、消息、Owner 请求、模型、集成等） | `fetch /rest/v1/rpc/*`，`apikey` 与 `Authorization` 都是 publishable key（`worker/continuity.ts` `supabaseRequest`） | `anon` | `p_token_hash = sha256(Binding 令牌)` |
| Worker，发行方路径（10 个存储与授权后台 RPC） | 同上 | `anon` | `p_issuer_hash = sha256(CLUED_STORAGE_CONNECTOR_ISSUER 或 CLUED_AUTHORIZATION_ISSUER_TOKEN)` |
| Worker，两者都要（`clued_storage_read_v1`、`clued_storage_staging_v1`） | 同上 | `anon` | 两个哈希 |
| Worker，P5（8 个 `clued_p5_*`） | `Authorization: Bearer CLUED_P5_GATEWAY_TOKEN` | `clued_p5_gateway`（NOLOGIN，授予 `authenticator`） | 网关 JWT + `p_token_hash` |
| Worker，人类会话转发（33 个 `clued_user_*` 等，及 7 个带发行方哈希、5 个带原始发行方密钥 `p_issuer_secret` 的） | `Authorization: Bearer <用户 JWT>` | `authenticated` | 用户 JWT（+ 发行方哈希或原始密钥） |
| CI 准入 `scripts/ci/clued-work-admission.mjs` | publishable key | `anon` | `sha256(CLUED_ADMISSION_CLUED_TOKEN)`：`clued_owner_grant_admission_door_v1`、`clued_work_verify_v1`、`clued_work_claim_adopt_v1`、`clued_work_merge_slot_return_v1` |
| CI 发布 `scripts/ci/clued-release-grant.mjs` | publishable key | `anon` | `sha256(CLUED_RELEASE_TOKEN)`：`clued_owner_grant_door_consume_v1` |
| 钩子 `scripts/hooks/clued_work_claim_guard.py` | publishable key | `anon` | `sha256(CLUED_CONTEXT_READ_TOKEN)`：`clued_work_claims_active_v1` |
| Console `app/supabase-browser.ts` | supabase-js + 用户会话 | `authenticated` | 用户 JWT |
| 部署核验 `scripts/verify-currentness-transport.mjs` | 直连 Postgres（`CLUED_ATTESTATION_DATABASE_URL`） | 登录角色 | 数据库口令；写 G6 运输证明行 |

Worker 里没有 `service_role` 或 `sb_secret_` 密钥。

### 2.2 库里怎么认证

- Binding：`clued_private.resolve_binding`（及 `resolve_binding_action_v12`、`integration_auth_binding_v1`、`storage_binding_v1`、`p5_resolve_binding`）执行 `where token_hash = p_token_hash`，再查撤销、范围、账号状态与 v12 授权。另有约 15 个函数直接内联比对 `token_hash = p_token_hash`（如 `clued_authorization_status_v12`、`clued_project_list_v2`、`clued_mcp_search_context` 的预检、`clued_storage_connections_v1`、`clued_resource_center_*_v1`）。
- 发行方：`authorization_issuer_v12` 与 18 个存储函数内联比对 `issuer_hash = p_issuer_hash`；发行方行在部署时带外写入，没有轮换机制，只有 `revoked_at`。
- 已经安全的先例：会话令牌（`resolve_session` 收原始 `clued_ses_` 令牌、库内 `extensions.digest`）、租约钥匙（`work_claim_lease_key_hash_v1`）、`p_issuer_secret` 函数（库内 `sha256(convert_to(secret,'UTF8'))`）。这些列存的值不能直接拿来调用。

### 2.3 存放「可直接使用的哈希」的列

`public.clued_agent_bindings.token_hash`、`clued_private.authorization_issuers_v12.token_hash`、`authorization_requests_v12.issuer_hash`、`clued_private.storage_oauth_apps_v1.issuer_hash` 及引用它的 `issuer_hash` 外键列、`resource_center_bindings_v1.token_hash`、`resource_center_writer_bindings_v1.token_hash`、`resource_center_mutations_v1.authority_token_hash`、`resource_center_renewals_v1.token_hash`、`resource_center_rotations_v1.old_*_hash`。准确清单以 §8 第 2 步的目录查询为准（判定规则见 §4.2）。

生产核对（2026-10-08）：`authenticated` 对 `clued_agent_bindings.token_hash` 与 `clued_continuity_sessions` 有 SELECT（RLS 只放行本人的行）；`anon`、`service_role` 都没有；三者对 `clued_private` 都没有 USAGE。

---

## 3. 威胁模型：三个问题

| 编号 | 问题 | 谁能利用 | 后果 |
|---|---|---|---|
| T1 | 库里存的值就是调用凭据 | 读到凭据列的任何人：已登录用户经 Data API 读本人 Binding 的 `token_hash`（Console 页面一旦有 XSS 就整表外泄）、数据库备份或导出、日志、误授权 | 拿哈希 + 公开的 publishable key 即可以该 Binding 或发行方身份调用；发行方哈希可驱动存储后台任务 |
| T2 | 持有有效令牌者可绕过 Worker 直连 PostgREST | Owner 自己的 Agent、CI，或任何偷到令牌的人 | 跳过 Worker 的功能开关、输入校验、`clued_bnd_` 前缀检查、集成运输事实（`protocol_version`、`build_sha`）、上下文包预算、结果清洗、Resource Center 的 `request_sha256` 校验；伪造 G6 的 `__transport_source_commit`（`/healthz` 公布了它） |
| T3 | 84 个 SECURITY DEFINER 函数可从互联网直接调用 | 任何人（publishable key 是公开的） | 每次调用都要执行到哈希比对才被拒；面随新功能增长（10-07 为 78，10-08 为 84）；`anon` 有 3 秒语句超时，但仍是可被消耗的入口 |

T1 不依赖 T2/T3：即使只有 Worker 能调用，读到哈希的人只要再拿到 Worker 的数据库凭据就能冒充任何 Binding。所以 A 与 C 互补，不互相替代。

---

## 4. 设计 A：库里只存校验值（解决 T1）

### 4.1 定义

- **证明值（proof）**：调用方提交的值，即今天的 `p_token_hash` / `p_issuer_hash` / `p_binding_hash`，等于 `sha256(原始令牌)` 的 64 位小写十六进制。**定义与调用方完全不变。**
- **校验值（verifier）**：`clued_private.credential_verifier_v1(p_proof text) returns text`，`immutable`、`search_path=''`，先检查 `^[0-9a-f]{64}$`（不合格则返回 null，使比对失败），再返回 `encode(extensions.digest('clued.credential-verifier.v1:' || p_proof, 'sha256'), 'hex')`。带域前缀，避免与库里其他 `sha256` 值混用。
- 证明值有 256 位熵（令牌是 32 字节随机数），所以不需要加盐或慢哈希；校验值不可逆推出证明值。

### 4.2 改什么

一个迁移，一个事务：

1. 新建 `credential_verifier_v1`。
2. 对 §2.3 每一列执行 `update … set col = clued_private.credential_verifier_v1(col) where col ~ '^[0-9a-f]{64}$'`。列名不变、唯一索引不变（映射是单射）。旧 OAuth 绑定里那些没有原始令牌的随机 `token_hash` 也一并变换，结果同样无人能用。
3. 所有比对处把右侧换成校验值：`token_hash = clued_private.credential_verifier_v1(p_token_hash)`、`issuer_hash = clued_private.credential_verifier_v1(p_issuer_hash)`。函数用 `pg_get_functiondef` 重写的先例见 `20260922142533_context_v2_frontier_source_contract.sql`；对 5 个解析器和约 35 个内联比对函数，按函数显式重建比全局正则替换更稳。
4. 所有写入处改写校验值：`clued_authorization_approve_v12` 写入的 `p_binding_hash`、无头签发（库内生成令牌后计算证明值再算校验值）、Resource Center 令牌签发与轮换、集成 `create_or_bind`、发行方行的带外写入运行手册（[connection-authorization-rollout.md](../../../apps/clued-cloud/docs/connection-authorization-rollout.md) 与 [resource-center-account-connection.md](../../../docs/maintenance/resource-center-account-connection.md) 改为写 `credential_verifier_v1(sha256(secret))`）。
5. 判定一列是否在范围内的规则：**有函数拿它与调用方提交的哈希参数比对**，就在范围内；若函数先在库内对原始输入求哈希再比对（会话令牌、租约钥匙、确认令牌等），就不在范围内。

### 4.3 守卫

- 新增数据库测试：遍历 `pg_proc`（`public` 与 `clued_private`），对函数体做文本检查，凡出现把 `p_token_hash`、`p_issuer_hash`、`p_binding_hash` 直接与列比对、而没有经过 `credential_verifier_v1` 的，测试失败。以后新增函数漏写也会被拦下。
- 现有 `test:db`（1000 余项）全部重跑：漏改的比对点会让对应函数一律拒绝（失败即关闭），测试能发现。
- 迁移后的生产核对（只读）：随机抽一个仍在用的 Binding，经 Worker 调用成功；把它的库内列值当 `p_token_hash` 直接调用 `clued_work_claims_active_v1`，必须被拒。

### 4.4 对其他东西的影响

- Worker、CI、钩子、Console：**零改动**。
- 冻结合同 IntegrationRuntime v0.1.8 §10.1、§11 写的是「Worker 以 `p_token_hash = sha256(token)` 调用」与「按 `token_hash` 锁定」，仍然成立；只需在 ERRATA 记一条说明存储形式（§10）。
- 回退：校验值不可逆，所以迁移前把旧值复制到 `clued_private.credential_proof_backup_v1(table_name, row_id, column_name, old_value, delete_after)`，`delete_after = now() + 7 天`，到期由现有清理任务删除。能读这张私有表的人本来就能读整个库，复制不扩大暴露面。回退迁移按备份逐列还原并恢复旧函数定义。

### 4.5 顺带的小口子

`authenticated` 对 `clued_agent_bindings.token_hash` 与 `clued_continuity_sessions.token_hash` 的 SELECT 改为列级授权，不含这两列（后者存的是库内对原始会话令牌求的哈希，本身不能用来调用，收回只为不无谓暴露）。Worker 的 Binding 列表（`select=id,vendor,agent_name,scopes,context_keys,created_at,last_used_at,revoked_at`）与撤销（`PATCH revoked_at`）都不读这两列。A 完成后这两列即使被读到也无用，这一步是纵深防御，可以先于 A 单独上线。

---

## 5. 设计 B：G6 运输证明（T2 的一部分）

现状：Worker 只在调用 `clued_currentness_g6_gate` 时注入 `__transport_source_commit = 构建 SHA`；库里把它与 `clued_private.currentness_transport_attestations`（只由部署核验脚本经直连 Postgres 写入）比对，最多返回 `transport_precheck_ready`，Worker 再把结果提升为 `closed`。直连调用者可以填 `/healthz` 公布的 SHA 通过比对，但拿不到 `closed`。

方案：**不单独改函数，随 C 一起收口。** C 完成后该函数只授予 Worker 角色，`__transport_source_commit` 只能来自 Worker，库里的比对就是可信的；同时在函数开头加角色断言（`current_user = '<Worker 角色>'`，否则拒绝），防止以后误授权。C 之前的这段时间，直连调用者最多拿到非权威的 `transport_precheck_ready`，风险低。

备选：把运输事实放进 Worker 角色凭据的声明里（如 JWT `app_metadata.source_commit`），库里读 `auth.jwt()`。每次部署都要换凭据，代价高于收益，不推荐。

---

## 6. 设计 C：Worker 不走 anon（解决 T2、T3）

### 6.1 选项

| 选项 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **C1 Worker 专用角色 + Worker 持有的 JWT（推荐，待核实签发方式）** | 新建 NOLOGIN 角色 `clued_worker_gateway`，授予 `authenticator`；Worker 以 `Authorization: Bearer <Worker JWT>`（`role` 声明为该角色）调用；Worker 用的函数从 `anon` 收回、授予该角色 | 先例 `clued_p5_gateway` 已在生产运行；PostgREST 在执行函数前就按授权拒绝，函数体不跑；安全检查里的 anon 数降到个位数；每个函数仍要 Binding 证明，等于「Worker 凭据 + Binding 证明」两道 | JWT 是长期凭据，需要轮换手段；签发依赖项目 JWT 签名设置（旧的 HS256 共享密钥还是新的非对称签名密钥），`CLUED_P5_GATEWAY_TOKEN` 怎么签发的仓库里没有记录 |
| C2 PostgREST 预请求函数 + Worker 请求头密钥 | 配置 `pgrst.db_pre_request`：读请求头 `x-clued-worker-proof`，与库内校验值比对，设事务级 GUC `clued.caller = 'worker'`；Worker 用的函数开头断言该 GUC | 不依赖 JWT；两个校验值并存即可无缝轮换 | 角色仍是 anon，函数仍对互联网开放、执行到断言才拒；安全检查仍报 anon；每个请求（含 Console）多一次函数调用；84 个函数都要加断言 |
| C3 Supabase secret key（`service_role`） | Worker 改用 `sb_secret_` | 最省事 | `service_role` 绕过 RLS，且本项目已把它从几乎所有函数收回；Worker 密钥一旦泄露即等于整个库，**否决** |
| C4 Worker 直连 Postgres（Hyperdrive + 登录角色） | 不经 PostgREST | 完全不暴露 Data API | 改动 131 个调用点与连接管理，超出本审计范围，**否决** |

推荐 C1：§6.4 的核实表明 Owner 可以导入专用私钥签发并独立轮换 Worker JWT；Owner 若不愿在控制台导入密钥，则用 C2。

### 6.2 C1 细节

- 角色：`clued_worker_gateway`，NOLOGIN，`grant clued_worker_gateway to authenticator`，`statement_timeout` 与 `anon` 一致或略长（由迁移设定）。
- 凭据：Worker 机密 `CLUED_DB_GATEWAY_TOKEN`，`role` 声明为 `clued_worker_gateway`，有效期一年（`exp`），不进仓库、不进 Clued 记录。
- 签发（第 3 步核实结论，见 §6.4）：Owner 在本机用 `supabase gen signing-key --algorithm ES256` 生成一把专用私钥，在项目「JWT signing keys」页导入为新密钥并放在只验证、不签发的状态（Previously used），**不点 Rotate**，这样 Supabase Auth 继续用现有密钥给用户签会话；再用这把私钥在本机签 Worker JWT（头部 `alg: ES256`、`kid` 为该密钥）写入 Cloudflare 机密。私钥导入 Supabase 后不可再导出；Owner 本机另存一份用于签发，不进仓库、不进 Cloudflare、不进 Clued。
- 轮换：导入一把新的只验证密钥、签新凭据、发布 Worker、确认流量切换后吊销旧密钥。只影响 Worker 凭据，不影响用户会话。吊销后各组件的密钥缓存最多约 20 分钟才失效，紧急吊销时同时收回该角色的函数授权。
- Worker 改动：`supabaseRequest` 在没有 `userToken` 时用 `CLUED_DB_GATEWAY_TOKEN` 作 `Authorization`，`apikey` 仍是 publishable key；`delegated-oauth.ts` 的 `bindingRpc` 与两个存储后台文件同样处理。人类会话转发不变。
- 过渡：第 4 步先把这些函数**同时**授予 `anon` 与新角色并发布 Worker；确认生产流量全部带新凭据后（Worker 日志与 Supabase API 日志按角色统计），第 5 步再收回 `anon`。
- G6：见 §5。

### 6.3 CI 与钩子

CI 与钩子直接调用的函数保留 `anon`（「anon 白名单」）。理由：这些是专为 CI 设计的门口，调用方没有 Worker 凭据，也不该有；A 之后它们只认证明值，T1 已解决；它们的输入不经 Worker 校验本来就是设计如此。

- 规则：**白名单 = `scripts/ci/**` 与 `scripts/hooks/**` 直接调用的 RPC**，不写死名单。数据库测试从这两个目录的源码里提取 `/rest/v1/rpc/<name>` 与 RPC 名常量，`anon` 可执行的 SECURITY DEFINER 函数集合必须等于这个集合；新增 CI 调用的 RPC 只要出现在 CI 源码里就自动进入白名单，反过来 Worker 专用函数误授 `anon` 会被测试拦下。
- 2026-10-08 的集合：`clued_owner_grant_admission_door_v1`、`clued_owner_grant_door_consume_v1`、`clued_work_verify_v1`、`clued_work_claim_adopt_v1`、`clued_work_merge_slot_return_v1`、`clued_work_claims_active_v1`，加上 MergeAdmission 第 3 步（PR #631，Task `3576d10d`）新增的 `clued_work_merge_slot_touch_v1`、`clued_work_merge_slot_holders_v1`。MergeAdmission 第 4、5 步（Task `38e0c90d`、`91039d74`）若再加 CI 调用的 RPC，按同一规则进入白名单。
- 其中 Worker 也在用的（如 `clued_work_verify_v1`、`clued_work_claims_active_v1`）同时授予 Worker 角色。白名单的来源规则写进迁移注释与 [docs/maintenance/database-security.md](../../../docs/maintenance/database-security.md)。

### 6.4 第 3 步核实结论（2026-10-08，只读）

- 生产项目已改用 JWT 签名密钥体系：近 24 小时与 10-01 全天的请求日志里，所有用户会话 JWT 都是 `ES256`、同一 `kid`（`c86f0e85-…`），签发方为项目 Auth。即用户会话由 Supabase 托管的非对称私钥签发，私钥不可导出。
- 所以 Owner 无法拿项目现有密钥签 Worker JWT，但可以按 Supabase 文档「How to create (mint) JWTs」导入自己生成的私钥（§6.2）。导入的密钥只用于验证 Worker 凭据，轮换不牵动用户会话——这消除了原先担心的「轮换要让所有用户重新登录」。
- P5 网关凭据 `CLUED_P5_GATEWAY_TOKEN`：两段日志窗口里都没有 `clued_p5_gateway` 角色的请求，它的签名方式与有效期查不到（Worker 机密不可读）。若它由旧的 HS256 共享密钥签发，一旦旧密钥被吊销 P5 路径就会失效；这与本文无关，只作提示。
- 结论：C1 可行，推荐 C1；需要 Owner 在控制台做一次导入密钥的操作（Agent 做不了）。

### 6.5 与 MergeAdmission 的关系（避免重复与冲突）

[MergeAdmission.v0.1.md](../execution-admission/MergeAdmission.v0.1.md) 的 §13 各步（Task `ada1334c` 下，第 2 步 Task `745c288f`（部署验收 Task `fb97ebd5`）、第 3 步 Task `3576d10d`、第 4 步 Task `38e0c90d`、第 5 步 Task `91039d74`）与本文改的是同一批 CI 门口与 `clued_work_*` 函数周边，分工如下：

| 方面 | MergeAdmission 管 | 本文管 | 不冲突的理由 |
|---|---|---|---|
| CI 准入脚本、runner 钩子、工作流、策略文件 | 是 | 否 | 本文不改 `scripts/ci/**`、`scripts/runner/**`、`.github/**`；A 让调用方零改动 |
| `clued_work_*` 函数的业务逻辑（合并位、队列、上报） | 是 | 否 | 这些函数都经 `clued_private.resolve_binding` 认证；A 只改解析器与少数内联比对函数，不重写 `clued_work_*` 的函数体，双方迁移不会互相覆盖 |
| Binding 认证方式（解析器、存储形式） | 否（§1 非目标：不改 Owner Grant 信任根） | 是 | A 不改门口的判定语义与授权表，只改比对形式 |
| 哪些函数授予 `anon` | 新增的 CI RPC 授予 `anon`（如 #631） | 第 5 步收回 Worker 专用函数的 `anon` | 白名单按 §6.3 的规则由 CI 源码推出，MergeAdmission 新增的 CI RPC 自动在内 |

顺序：两边的迁移谁先上线都可以。A 上线后，守卫测试（§4.3）要求以后的迁移不再内联比对调用方提交的哈希；MergeAdmission 后续迁移只要沿用 `resolve_binding`（现有写法），就不受影响。本文第 2、5 步的 PR 各自在描述里列出与当时在途 MergeAdmission PR 的交叉检查结果。

---

## 7. 不改的东西与已有先例

- 原始秘密在库内求哈希的先例：`p_issuer_secret` 函数、会话令牌、租约钥匙。A 没有沿用「改传原始令牌」的做法，因为那要改约 110 个函数签名、131 个 Worker 调用点、CI、钩子和冻结合同，而只存校验值得到同样的存储安全性、调用方零改动。
- 专用数据库角色的先例：`clued_p5_gateway`（P5）、`clued_storage_source_reader_v2`、`clued_projection_watchdog`。

---

## 8. 分步实施（每步一个 PR，每步单独请 Owner 批准）

1. **列级授权**：收回 `authenticated` 对 `clued_agent_bindings.token_hash` 与 `clued_continuity_sessions.token_hash` 的 SELECT，其余列照旧；数据库测试固定 Console 与 Worker 用到的列仍可读。一个小迁移，需要 `migration.production` 授权。归属 Task `9a4d6d2c`。
2. **校验值迁移（设计 A）**：先用目录查询列出全部比对点与写入点作为 PR 附件，再写迁移、`credential_verifier_v1`、守卫测试、7 天备份表与回退迁移，更新两份运行手册；`test:db` 全绿、守卫测试通过后请 Owner 批准生产迁移；迁移后按 §4.3 只读核对。归属 Task `9a4d6d2c`，依据 Decision `8a7e345f`。
3. **核实 Worker 凭据签发（只读）**：查清生产项目 JWT 签名方式与 `CLUED_P5_GATEWAY_TOKEN` 的签发与有效期，写成结论交 Owner 选 C1 或 C2。不改任何东西。归属 Task `9a4d6d2c`。
4. **Worker 角色上线（过渡）**：建角色、给 Worker 用的函数加授新角色（`anon` 暂留）、Worker 改带新凭据并发布；按角色统计确认生产调用全部切换。需要 `migration.production` 与 `release.production` 授权。归属 Task `9a4d6d2c`。
5. **收回 anon**：Worker 用的函数收回 `anon`，只留 §6.3 白名单；G6 门加角色断言；数据库测试固定 anon 集合等于白名单；更新 database-security.md 的预期数字。归属 Task `9a4d6d2c`。
6. **合同文字**：IntegrationRuntime v0.1.8 是冻结文件，§5.13（grant `anon, authenticated` → Worker 角色）与 §10.1、§11（存储形式）改动经 ERRATA 记录并需 Owner Decision；同步 HeadlessBindingIssuance「令牌能用在哪里」、WorkClaimAdmission §4.6、OwnerCredential §9、StorageNormalUse §6.2 的措辞。归属 Task `9a4d6d2c`。

第 1、2 步与第 3–5 步互不依赖，可以并行；第 6 步跟随第 2、5 步。

---

## 9. 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| 第 2 步漏改某个比对点，该函数对所有调用一律拒绝 | 目录查询清单 + 守卫测试 + 全量 `test:db`；失败即关闭，不会放行错误调用 | 补一个前向修复迁移；必要时用备份表还原 |
| 第 2 步漏改某个写入点，新签发的令牌存了证明值而不是校验值，无法使用 | 守卫测试同样检查写入；签发路径有现成数据库测试 | 前向修复，并对受影响的行重算 |
| 第 2 步触及 Owner Grant 门口所依赖的 `resolve_binding` | MergeAdmission §1 的非目标是「不改信任根」，本方案不改门口的判定语义与授权表，只改比对形式；第 2 步 PR 需要在描述里点明，并跑 Owner 授权相关全部测试 | 同上 |
| 第 4、5 步顺序错，Worker 被拒，线上全部 MCP 调用失败 | 先加授、后发布、按角色统计确认、最后收回；收回前保留 24 小时观察 | 重新授予 `anon`（一条迁移，几秒生效） |
| C1 的 JWT 泄露 | 仍需 Binding 证明才能调用业务函数；发行方函数仍需发行方证明 | 轮换凭据（§6.2 的运维代价） |
| 冻结合同措辞与实现不一致 | 第 6 步走 ERRATA | — |

---

## 10. 需要 Owner 决定

1. 是否接受设计 A（只存校验值、调用方不改），以及 7 天备份表。
2. Worker 角色选 C1 还是 C2：第 3 步结论见 §6.4，推荐 C1。
3. §6.3 的 anon 白名单规则（由 CI 与钩子源码推出，不写死名单）是否可以。
4. 第 1 步是否先单独上线。

---

## 11. 不保护什么

- 数据库超级用户、Supabase 控制台账号、直连数据库口令（`CLUED_ATTESTATION_DATABASE_URL`）被盗：这些本来就能改任何函数与授权。
- Worker 被攻破：Worker 收得到原始令牌，也持有 Worker 角色凭据。
- 令牌在客户端被盗：A 让库里的值无用，但被盗的原始令牌（或其 `sha256`）照样能用，直到撤销。
- 对 anon 白名单函数的请求洪泛：仍由 `anon` 的 3 秒超时与 Supabase 平台限流兜底。

---

## 12. 引用

- 审计与前置：Task `9a4d6d2c`，Decision `8a7e345f`、`eed7154f`；`apps/clued-cloud/supabase/migrations/20261007120000_db_security_hygiene.sql`；[docs/maintenance/database-security.md](../../../docs/maintenance/database-security.md)。
- 解析器：`20260907173031_clued_connection_authorization_v12.sql`（`resolve_binding`、`authorization_issuer_v12`），`20261005090000_integration_runtime_identity_claim.sql`（`integration_auth_binding_v1`）。
- G6：`20260922094719_bug_20260922_002_g6_full_gate.sql`、`20260922142533_context_v2_frontier_source_contract.sql`；`apps/clued-cloud/worker/continuity.ts` 的 `__transport_source_commit` 注入。
- P5 网关角色：`20260827050750_p5_gateway_attempt_commit_failure.sql`。
- 合同：[IntegrationRuntime.v0.1.8.md](../integration-runtime/IntegrationRuntime.v0.1.8.md) §5.13、§10.1、§11；[HeadlessBindingIssuance.v0.1.md](../connection-authorization/HeadlessBindingIssuance.v0.1.md)；[WorkClaimAdmission.v0.1.md](../execution-admission/WorkClaimAdmission.v0.1.md) §4.6；[OwnerCredential.v0.1.md](../owner-authorization/OwnerCredential.v0.1.md) §6、§9；[MergeAdmission.v0.1.md](../execution-admission/MergeAdmission.v0.1.md) §1；[StorageNormalUse.v0.1.md](../storage/StorageNormalUse.v0.1.md) §6.2。
