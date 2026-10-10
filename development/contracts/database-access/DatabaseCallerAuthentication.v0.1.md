# Database Caller Authentication v0.1：库里只存校验值、Worker 不走 anon、G6 运输证明

状态：**设计已选定，剩余实施待验证。** Owner 2026-10-08 Decision `1427642f` 接受设计 A 与 7 天备份，第 1 步先单独上线；Decision `096df8b8` 一并收紧 Binding 表的插入、修改、删除，并把「无 v12 授权记录即放行」列为后续一步；Decision `2ec964af` 选定第 2 步的「写入自动转换」（§4.7）。Owner 2026-10-09 Decision `818a9b05-4115-4143-8874-da7bdf6f9c4b`（Receipt `21190495-ac1b-45c8-a858-a7451c39c754`）是原设计与顺序依据：2b 身份与凭据分开、增加摘要版本；两把发行方凭据逐把切换，验证后立即停用对应旧凭据；C1 按两阶段方案开发，与 2b 并行，Owner 配合导入签名密钥。Owner 2026-10-10 Decision `23d196f2-a6d5-4116-9d18-8c4091ddf925@1`（Receipt `158ee731-4672-4cc8-8793-c0c450c14586`）仅将本次 P0-4 的生产观察时间下限改为至少 6 小时，其余顺序和门保持；适用条件与起止时间见 §6.2，不推广为全产品规则。第 1、2a、7a/7b 已完成上线的范围不重做；2b、C1 与第 6 步合同勘误仍待各自实现、验证和收口。设计选择与开发授权不代替精确生产迁移、Worker 发布、权限收回或冻结合同勘误所需的授权。
日期：2026-10-10（原现状基线保留 2026-10-08 的核对边界）
来源：审计 P0-4 Task `9a4d6d2c` 的步骤 4（库里存的哈希不再等于口令、G6 门不再信任客户端提交的提交号）与步骤 5（Worker 脱离 anon）；Owner Decision `8a7e345f`（2026-10-08，两步合并为一份设计稿，只写方案）。前置工作：步骤 1 卫生迁移 `20261007120000_db_security_hygiene.sql`（Decision `eed7154f`，已在生产），以及 [docs/maintenance/database-security.md](../../../docs/maintenance/database-security.md) 的「Left for later」。
对照基线：main `b290d0dd`（2026-10-08），生产库 `clued-prod` 2026-10-08 只读核对（安全检查：anon 可执行的 SECURITY DEFINER 函数 84、authenticated 69、search_path 可变 0、`rls_enabled_no_policy` 118、泄露密码保护关闭）。

---

## 0. 一句话结论

**A 让库里只存校验值，调用方继续提交原来的证明值。** `p_token_hash = sha256(token)` 的调用约定不变；库内格式按 §4.7 的 `cv1:` 域分离校验值，读到列值不能直接冒充。2a 已处理 Binding 与 Resource Center 令牌；剩余 2b 把固定发行方身份与可轮换凭据分开，保留历史摘要、登记与回执，为新登记增加摘要版本，逐把停用旧凭据。**C 已选 C1：Worker 用专用数据库角色。** 2b 与 C1 可并行开发；C1 先加授新角色、发布 Worker，旧权限仍保留，本次 P0-4 至少观察 6 小时并通过 §6.2 的验收门、确认流量切换后再收回 Worker 专用 RPC 的旧权限，anon 只留 CI/钩子的门口白名单。G6 的角色限制随第二阶段收口。

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

### 4.5 已登录用户对凭据表的直接权限（第 1 步）

生产核对（2026-10-08）：`authenticated` 对 `public.clued_agent_bindings` 有 SELECT、INSERT、UPDATE、DELETE（RLS 只放行本人的行，表上没有触发器），对 `public.clued_continuity_sessions` 有 SELECT。这些权限比迁移文件建出来的多（迁移只授 SELECT），来源不在仓库里。再加上 `clued_private.authorization_assert_entry_v12` 对没有 `authorizations_v12` 记录的 Binding 直接放行（§4.6），拿到 Owner 登录会话的人可以：读到能直接调用的 `token_hash`；自己插入一个全权限、不过期、不经确认、没有授权审计的 Binding；把现有 Binding 的 `token_hash` 改成自己知道的值来接管它；把已撤销的 Binding 改回有效。

Worker 用用户会话直接访问这张表只有两处（`worker/continuity.ts`）：列表（`select=id,vendor,agent_name,scopes,context_keys,created_at,last_used_at,revoked_at`）与撤销（`PATCH revoked_at`）。所以迁移 `20261008150000_credential_table_privileges_v1.sql`：

- 收回 `authenticated` 对两张表的表级权限，改为列级 SELECT，覆盖除 `token_hash` 外的所有列；
- 不再授予 INSERT、DELETE；UPDATE 只授 `revoked_at` 一列；
- 触发器 `clued_agent_bindings_session_revoke_only`：当前角色是 `authenticated` 时只允许「未撤销 → 已撤销」，拒绝撤销后再改回或挪动时间；SECURITY DEFINER 函数以属主身份执行，不受影响；
- 可重复执行（经 plpgsql EXECUTE 跑第二遍无变化）。数据库测试 `credential-table-privileges-db.test.mjs` 固定上述行为，并做过变异检查（去掉触发器即失败）。

`clued_continuity_sessions.token_hash` 存的是库内对原始会话令牌求的哈希，本身不能用来调用，收回只为不无谓暴露。A 完成后 `clued_agent_bindings.token_hash` 即使被读到也无用，这一步是纵深防御，同时堵住插入与改写。

### 4.6 「无 v12 授权记录即放行」（后续一步）

`authorization_assert_entry_v12` 在找不到 `authorizations_v12` 记录时直接返回（注释写的是「Existing non-migrated raw bindings keep their explicit existing grant」）。生产 62 个 Binding 中 17 个没有 v12 授权记录，其中 3 个仍有效：两个 2026-08-29 的旧 OAuth 审计 Binding（`c0cc5abf`、`b3603c56`，旧 OAuth 路径已一律拒绝，应已不可用）与 Projection Builder（`05effaa9`，`context:read`，`*`，Worker 机密 `CLUED_PROJECTION_BUILDER_TOKEN` 在用）。第 1 步之后已登录会话再也插不进新的这类行，但这条放行规则本身仍在。关闭它分两个 PR（Owner 2026-10-09 Decision `29bff239`，见 §8 第 7 步）。

2026-10-09 生产只读核实修正了原计划：

- 两个旧 OAuth 审计 Binding 自 2026-08-29 起未再使用，可以直接撤销。
- Projection Builder 在用（`projection_refresh_attempts` 已成功 5870 次），而 `clued_private.projection_refresh_builder_binding` 明确要求 Builder Binding **没有** `authorizations_v12` 记录（Builder 的权限来自 `projection_builder_grants`，不受委托授权限制）。所以 Decision `29bff239` 不给 Projection Builder 补 v12 授权（补了会打断投影刷新）。改为：放行规则只留给持有有效 `projection_builder_grants` 的 Binding，并且只放行 `scope` `global` 的只读；其余找不到记录一律拒绝。
- 仓库中 73 个数据库测试直接插入没有 v12 记录的 Binding，靠这条放行通过；关闭它要同时把这些测试改成带 v12 授权的 Binding。

7b 的实现（Decision `d0458559`，取代上面「改成带 v12 授权的 Binding」与「持有 `projection_builder_grants`」两处细节）：

- 迁移 `20261009050000_close_v12_raw_binding_fallback_v1.sql` 新建 `clued_private.raw_binding_grants_v1`（`binding_id`、`context_key`、`actions`、`reason`），只有数据库所有者能写。`authorization_assert_entry_v12` 找不到 v12 授权时，只在这张表列出该 Binding、动作在 `actions` 内、且 `scope` 与 `context_key` 相同时放行，其余一律 `resource_action_not_authorized`。
- 迁移只写一行：Projection Builder（`05effaa9`），`global`，`read`。它的三个刷新 RPC 只调用 `resolve_binding(…, 'context:read', 'global')`。用这张表而不是 `projection_builder_grants`，是因为后者按投影键授权，不表达「能读哪个 scope」。
- 数据库测试大多用 `context_keys = '*'` 的 Binding 跨多个 context 调用，而 v12 条目必须逐个列出 context，所以测试不改成 v12 授权。测试在应用完迁移后调用 `tests/raw-binding-grants-fixture.mjs` 的 `allowRawTestBindings`：它只在测试库里装一个触发器，给没有 v12 授权的 Binding 写一行 `context_key` 为空（任意资源）的授权，行为与本迁移之前相同。`context_key` 为空的行只由测试写；生产行都写明一个 scope。
- `tests/raw-binding-grants-guard.test.mjs` 要求每个直接插入 Binding 的测试调用该工具、自己写授权行，或用 `raw-binding-grants:` 注释说明为何不需要（例如只应用本迁移之前的迁移）；并检查该触发器不出现在迁移和 Worker 里。


### 4.7 第 2 步的实现方式（Decision `2ec964af`，取代 §4.1、§4.2 的相应细节）

目录查询（2026-10-08）显示，§4.2 第 4 点的「所有写入处改写校验值」要改约 45 个写入函数和约 150 个直接往凭据列写种子的测试文件，与在途 PR 冲突面大。Owner 选定：

- **校验值格式**：`'cv1:' || sha256('clued.credential-verifier.v1:' || 证明值)`。前缀让校验值与 64 位十六进制的证明值在格式上可区分。`credential_verifier_v1` 对不是证明值的输入（含 NULL）返回 `'cv0:'`，它与任何存储值都不相等，也不会让 `<>` 比较变成 NULL 而放行。
- **写入自动转换**：每个在范围内的列有 `credential_verifier_normalize_v1` 触发器（BEFORE INSERT/UPDATE OF 该列）：写入的若是证明值，就换成校验值；已是校验值则不动，所以复制已存值（如轮换时把旧值写进 `resource_center_rotations_v1`）不会被二次哈希。写入函数与测试照旧写证明值。列上的格式约束改为 `^cv1:[0-9a-f]{64}$`。
- **比对**：所有与调用方证明值的比较改为与 `credential_verifier_v1(证明值)` 比较。
- **内部转交**：有些函数把库里存的凭据当作证明值交给另一个函数（`clued_oauth_call` 的全部工具、存储云端执行器、Resource Center 写入日志）。它们改传 `credential_internal_proof_v1(存储值)`：一个随机的 64 位十六进制证明值，`credential_verifier_v1` 只在本事务内把它映射回该校验值。映射放在事务级设置 `clued.credential_internal_v1` 里，PostgREST 调用方无法设置；被调函数的格式检查不用改。`clued_oauth_call` 在解析出 Binding 后把 `v_binding.token_hash` 换成内部证明值一次，以后新加的工具照旧写 `v_binding.token_hash` 即可。
- **守卫**：迁移末尾与 `credential-verifier-db.test.mjs` 检查：没有函数把在范围内的列与 `p_*` 参数（或 `h`、`reader_hash`、`writer_hash`）直接比较（`set` 赋值除外，触发器会转换）；测试还检查没有函数把 `x.token_hash` 当参数交给另一个函数（除非先换成内部证明值）。
- **分两步**：
  - **2a**：Binding（`clued_agent_bindings.token_hash`）与 Resource Center 令牌列（`resource_center_bindings_v1`、`resource_center_writer_bindings_v1`、`resource_center_renewals_v1` 的 `token_hash`，`resource_center_rotations_v1` 的 `old_*_hash` 与 `request` 里的新哈希，`resource_center_mutations_v1.authority_token_hash`）。迁移 `20261008210000_credential_verifier_v1.sql`。
  - **2b**：发行方列（`authorization_issuers_v12.token_hash`、`authorization_requests_v12.issuer_hash`、各 `storage_*.issuer_hash`）。`storage_client_request_digest_v2` 与 `storage_client_redirect_identity_v3` 把 `issuer_hash` 算进已存的不可改登记摘要；`storage_oauth_connection_consent_v1` 与 `storage_onboard_activate_v1` 把发行方证明值写进了不可改回执；`storage_verified_result_v2` 把它存进持久化核验 JSON。因此不能只替换列值，选定设计见 §4.8。

§4.3 的生产核对与 §4.4 的 7 天备份照旧；备份另存被改写函数的原定义（`credential_function_backup_v1`），回退步骤见 [database-security.md](../../../docs/maintenance/database-security.md)。

### 4.8 2b：固定发行方身份、凭据代与摘要版本（Decision `818a9b05`）

本节属于既有 Task `9a4d6d2c` 的 2b，不创建新任务；设计已选定，实现和生产验收仍待证明。

- **身份与凭据分开。** 每个发行方使用非秘密、固定的 `issuer_id`；发行方凭据单独分代，认证列只存 `credential_verifier_v1(证明值)`。凭据代必须绑定同一发行方身份及其原有用途、Owner/连接/授权范围，不得因轮换扩大范围。身份、凭据代 ID、校验值各有不同职责；`issuer_id` 和代 ID 本身不能用于认证。
- **先认证再解析身份。** 入口仍接收原有证明值，resolver 先校验凭据代的校验值、有效性及撤销状态，再得到固定 `issuer_id`；后续内部检查按该身份映射到历史标识。历史登记使用过的旧 `issuer_hash` 只作历史身份/摘要输入，不得成为新的认证后门；直接提交旧证明值、存储校验值、固定 ID 或代 ID均不能代替有效的新证明值。
- **旧摘要保持原字节。** 已有登记、回执和摘要原位保留，不重写不可变对象、不把重新计算的摘要伪装成原摘要。旧登记继续按原摘要算法及原输入字节核验；其历史凭据标识的存在不代表该凭据现在仍有效。
- **新摘要显式换代。** 新登记增加摘要版本，摘要绑定固定的非秘密 `issuer_id`，不得包含原始秘密、证明值或校验值。版本选择与身份映射由服务端受控数据确定；缺失、未知版本、错配身份或错配范围失败关闭，不允许调用方自行选择旧版来绕过新认证。新回执及持久化核验 JSON 记录非秘密的身份、凭据代与摘要版本所需引用，不再落入可认证证明值。具体字段名与摘要域在 2b PR 固定并接受复审。
- **逐把切换与立即停旧。** `CLUED_AUTHORIZATION_ISSUER_TOKEN`、`CLUED_STORAGE_CONNECTOR_ISSUER` 分别处理：生成新代、把新秘密放入原受控机密位置、切换对应调用、验证该路径成功后立即停用该路径的旧代，再处理另一把。每次必须有新凭据成功及旧凭据被拒的证据；不得轮换一把后顺带撤销另一把，也不得在验证失败时继续下一把。旧秘密已出现的历史回执保留，但轮换后不能再认证；回退不得恢复已停用旧代的认证权，应前向修复或签发新的代。
- **恢复边界。** §4.4 的七天凭据备份与回退仅适用于历史 2a。2b 采用前向修复，不把已停用旧代或历史证明值恢复成认证授权；`issuer_function_sources_v1` 是迁移重放所需的版本化实现来源，不是七天凭据回退备份。登记兼容性、新登记、存储接入/读取/刷新/执行、OAuth 批准/撤销以及逐把轮换的验收需使用现有共用数据库测试工具，具体测试范围由实现 PR 明列。

---

## 5. 设计 B：G6 运输证明（T2 的一部分）

现状：Worker 只在调用 `clued_currentness_g6_gate` 时注入 `__transport_source_commit = 构建 SHA`；库里把它与 `clued_private.currentness_transport_attestations`（只由部署核验脚本经直连 Postgres 写入）比对，最多返回 `transport_precheck_ready`，Worker 再把结果提升为 `closed`。直连调用者可以填 `/healthz` 公布的 SHA 通过比对，但拿不到 `closed`。

方案：**随 C1 第二阶段收口，第一阶段不能提前加只许 Worker 的断言。** 第二阶段把 G6 入口只授予 Worker 角色，并校验 PostgREST 已认证的调用角色，防止以后误授权；`__transport_source_commit` 仍由 Worker 注入，不把调用方输入当作可信运输事实。2026-10-09 核对的 G6 是 SECURITY DEFINER、属主 `postgres`，因此函数内部的 `current_user` 是函数属主，不能用 `current_user = 'clued_worker_gateway'` 判断原调用者。实现须采用与真实 PostgREST 调用一致、不能由请求参数伪造的角色上下文，或在 invoker 外层完成判定，并证明新角色通过、anon/authenticated/伪造输入被拒、函数属主不误作调用角色；具体方式在 C1 PR 固定。第一阶段仍保留旧授权与非权威 `transport_precheck_ready` 行为；只有第二阶段权限收回与角色守卫验证完成后才声明该边界收口。

备选：把运输事实放进 Worker 角色凭据的声明里（如 JWT `app_metadata.source_commit`），库里读 `auth.jwt()`。每次部署都要换凭据，代价高于收益，不推荐。

---

## 6. 设计 C：Worker 不走 anon（解决 T2、T3）

### 6.1 选项

| 选项 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **C1 Worker 专用角色 + Worker 持有的 JWT（Owner 已选，Decision `818a9b05`）** | 新建 NOLOGIN 角色 `clued_worker_gateway`，授予 `authenticator`；Worker 以 `Authorization: Bearer <Worker JWT>`（`role` 声明为该角色）调用；先加授、发布与观察，第二阶段才收回 Worker 专用 RPC 的旧授权 | 先例 `clued_p5_gateway`；PostgREST 在执行函数前按授权拒绝；每个函数仍要原有 Binding/发行方证明 | 需要 Owner 导入专用签名密钥、独立轮换与真实调用证据；现有 P5 凭据不是新角色凭据的替代品 |
| C2 PostgREST 预请求函数 + Worker 请求头密钥 | 配置 `pgrst.db_pre_request`：读请求头 `x-clued-worker-proof`，与库内校验值比对，设事务级 GUC `clued.caller = 'worker'`；Worker 用的函数开头断言该 GUC | 不依赖 JWT；两个校验值并存即可无缝轮换 | 角色仍是 anon，函数仍对互联网开放、执行到断言才拒；安全检查仍报 anon；每个请求（含 Console）多一次函数调用；84 个函数都要加断言 |
| C3 Supabase secret key（`service_role`） | Worker 改用 `sb_secret_` | 最省事 | `service_role` 绕过 RLS，且本项目已把它从几乎所有函数收回；Worker 密钥一旦泄露即等于整个库，**否决** |
| C4 Worker 直连 Postgres（Hyperdrive + 登录角色） | 不经 PostgREST | 完全不暴露 Data API | 改动 131 个调用点与连接管理，超出本审计范围，**否决** |

Owner 已选 C1，并配合导入签名密钥（Decision `818a9b05`）；C2 保留为历史备选，不因实施不便自行切换方案。

### 6.2 C1 细节

- 角色：`clued_worker_gateway`，NOLOGIN，`grant clued_worker_gateway to authenticator`，`statement_timeout` 与 `anon` 一致或略长（由迁移设定）。
- 凭据：Worker 机密 `CLUED_DB_GATEWAY_TOKEN`，`role` 声明为 `clued_worker_gateway`，有效期一年（`exp`），不进仓库、不进 Clued 记录。
- 签发（第 3 步核实结论，见 §6.4）：Owner 在本机用 `supabase gen signing-key --algorithm ES256` 生成一把专用私钥，在项目「JWT signing keys」页导入为新密钥并放在只验证、不签发的状态（Previously used），**不点 Rotate**，这样 Supabase Auth 继续用现有密钥给用户签会话；再用这把私钥在本机签 Worker JWT（头部 `alg: ES256`、`kid` 为该密钥）写入 Cloudflare 机密。私钥导入 Supabase 后不可再导出；Owner 本机另存一份用于签发，不进仓库、不进 Cloudflare、不进 Clued。
- 轮换：导入一把新的只验证密钥、签新凭据、发布 Worker、确认流量切换后吊销旧密钥。只影响 Worker 专用签名密钥，不轮换用户会话正在使用的密钥。[Supabase JWT Signing Keys 文档](https://supabase.com/docs/guides/auth/signing-keys) 的约 20 分钟指 JWKS discovery 的边缘/客户端缓存（自定义缓存可更长），**不代表 Data API 吊销延迟**；Supabase 产品不依赖这层缓存。生产验收必须核对旧 JWT 经真实 Data API 被拒，不能用固定等 20 分钟代替；紧急处置可同时收回专用角色的函数授权。
- Worker 改动覆盖下面五个数据库调用入口，`apikey` 仍为 publishable key，服务调用的 `Authorization` 使用 `CLUED_DB_GATEWAY_TOKEN`；缺失或无效的新凭据失败关闭，不回退 publishable key/anon。人类会话转发与 P5 独立网关凭据路径保持原语义。

  | 调用入口 | 覆盖范围 |
  |---|---|
  | `worker/continuity.ts` 的 `supabaseRequest` | 无 `userToken` 的 Binding/发行方/存储后台调用；显式用户 JWT 与 P5 调用不能被新凭据覆盖 |
  | `worker/delegated-oauth.ts` 的 `bindingRpc` | OAuth 已签发 Binding 的状态查询 |
  | `worker/delegated-oauth.ts` 的 `revokeIssuedBinding` | 发行方执行 Binding 撤销 |
  | `worker/storage-access-digest-backfill.ts` 的 PostgREST 调用 | 存储访问摘要回填 |
  | `worker/storage-queued-dispatch.ts` 的 PostgREST 调用 | 排队存储作业 sweep/分派 |

- **阶段 1（第 4 步）**：建角色、把 Worker 使用的 RPC 加授给新角色，保留原有授权；完成上述五入口切换、Owner 导入签名密钥、部署及按角色统计的生产核验。本阶段不收回 anon，不提前启用只接受 Worker 的 G6 角色守卫；迁移、凭据配置与 Worker 发布分别使用实际阶段授权。
- **阶段 2（第 5 步）**：阶段 1 验证完成后，本次 P0-4 至少观察 6 小时（Decision `23d196f2@1`）；只有 Worker 日志与 Supabase API 日志证明相关生产流量已切换、五入口均覆盖、CI/钩子白名单仍正常，并取得收回权限的实际授权后，才收回 Worker 专用 RPC 的旧授权，启用 §5 的 G6 角色守卫。第二阶段验证 anon 集合等于 §6.3 白名单、非 Worker 角色不能直调专用入口；Native/Operator 的用户会话 RPC 保留其既有授权。开发可与 2b 并行，这个生产观察与收权次序不可省略。
- **本次观察的适用边界**：原 Decision `818a9b05@2` 已被取代，保留为设计与顺序的历史依据；当前 Decision `23d196f2-a6d5-4116-9d18-8c4091ddf925@1`（Receipt `158ee731-4672-4cc8-8793-c0c450c14586`）完整继承其身份、逐把轮换与 C1 精确门，仅调整原 P0-4 Task `9a4d6d2c` 的观察时间下限。观察仍从 `2026-10-10T11:51:46Z`（北京时间 `2026-10-10 19:51:46`）起算，新的最早时间为 `2026-10-10T17:51:46Z`（北京时间 `2026-10-11 01:51:46`），不另起算、不倒推提前。6 小时只是时间下限：结束前核验新通道实际读写、自然后台任务、授权撤销与过期拒绝、系统稳定性；未通过或缺证时继续观察，不冒称通过。正常后台无待办可返回空结果，不强制造非空回填或重新分派作业，也不把空结果称为已完成这些非空业务。新 Source 的影响按真实变化重验。此决定不授予生产迁移、发布或收权，不免除最终验收与 Owner 接受，不自动恢复已有 OFF 续签设置，不因满 6 小时自动关闭 Task 或 Goal；五入口、Native/P5、CI、G6 兼容与生产收权、ERRATA、最终接受及完整 Goal 的既有义务均保留，不推广为全产品规则。
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
- 当时结论：C1 可行、推荐 C1。2026-10-09 Owner 已选 C1 并配合导入专用密钥（Decision `818a9b05`）；导入完成、真实 Data API 验签与切流仍须实施证据，设计选择不证明已完成这些操作。

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

1. **凭据表直接权限**（§4.5）：列级 SELECT 不含 `token_hash`；收回 INSERT、DELETE；UPDATE 只留 `revoked_at` 并只许撤销。迁移 `20261008150000_credential_table_privileges_v1.sql` 与数据库测试随本 PR 提交，需要 `migration.production` 授权。归属 Task `9a4d6d2c`，依据 Decision `096df8b8`。
2. **校验值迁移（设计 A）**：按 §4.7 分两步。**2a** Binding 与 Resource Center 令牌：迁移 `20261008210000_credential_verifier_v1.sql`、`credential_verifier_v1`、内部证明值、守卫测试、7 天备份与回退；已上线范围不重做。**2b** 按 §4.8 采用固定发行方身份、凭据代与新摘要版本；保留历史登记/回执/摘要原字节，逐把切换两把发行方密钥，各自验证后立即停旧；补齐运行手册与新旧认证、摘要兼容证据。归属 Task `9a4d6d2c`，依据 Decision `8a7e345f`、`2ec964af`、`818a9b05`；生产迁移与轮换仍须精确阶段授权。
3. **核实 Worker 凭据签发（只读）**：查清生产项目 JWT 签名方式与 `CLUED_P5_GATEWAY_TOKEN` 的签发与有效期，写成结论交 Owner 选 C1 或 C2。不改任何东西。2026-10-08 已完成，结论见 §6.4。归属 Task `9a4d6d2c`。
4. **C1 阶段 1，Worker 角色上线（过渡）**：按 §6.2 建角色、加授、切换五个调用入口，Owner 导入签名密钥，Worker 使用新凭据发布；旧授权保留，G6 不提前收紧；按角色统计确认生产调用切换。需要 `migration.production` 与 `release.production` 授权。归属 Task `9a4d6d2c`，依据 Decision `818a9b05`。
5. **C1 阶段 2，收回旧权限**：阶段 1 验证后，本次 P0-4 至少观察 6 小时、通过 §6.2 的验收门并取得本阶段授权；Worker 专用函数收回旧角色的执行权，anon 只留 §6.3 白名单；G6 门校验真实调用角色，不使用 SECURITY DEFINER 内的 `current_user`；验证白名单与失败关闭，更新预期数字。归属 Task `9a4d6d2c`，原设计与顺序依据 Decision `818a9b05`，本次观察时间下限依据 Decision `23d196f2@1`。
6. **合同文字**：跟随 2b 与 C1 第二阶段收口。IntegrationRuntime v0.1.8 字节不变，§5.13、§10.1、§11、§12.3 的授权/存储/运输语义改动只经 ERRATA，并需最终 Owner Decision；同步 HeadlessBindingIssuance「令牌能用在哪里」、WorkClaimAdmission §4.6、OwnerCredential §9、StorageNormalUse §6.2 的措辞。现有 ERRATA 到 004，后继编号提交时复核；可先准备候选，不提前写 `in force`，不把本设计选择当成冻结合同已勘误。归属 Task `9a4d6d2c`。
7. **关闭「无 v12 授权记录即放行」**（§4.6），分两个 PR，各需 `migration.production` 授权。归属 Task `9a4d6d2c`，依据 Decision `096df8b8`、`5f60b7ba`、`29bff239`。
   - **7a**：迁移 `20261009040000_revoke_legacy_audit_bindings_v1.sql` 撤销 `c0cc5abf`、`b3603c56`（只撤销仍与核实时一致的行），每次撤销记入 `authorization_audit_v12`（operation `legacy_binding_revoke`）。不改测试。
   - **7b**：迁移 `20261009050000_close_v12_raw_binding_fallback_v1.sql`：`authorization_assert_entry_v12` 找不到 v12 授权时，只按 `clued_private.raw_binding_grants_v1` 放行，迁移只给 Projection Builder 一行（`global` 只读）。直接插入 Binding 的数据库测试改为调用共用工具 `allowRawTestBindings`，guard 测试防止新增测试漏掉。实现细节见 §4.6，依据 Decision `d0458559`。

已完成的第 1、2a、7a/7b 不重做。按原设计与顺序依据 Decision `818a9b05`，2b 与 C1 两阶段实现可并行开发、分别复审；C1 的第 4 步部署验证 → 本次 P0-4 至少 6 小时生产观察且通过 §6.2 的验收门（Decision `23d196f2@1`）→ 第 5 步授权收权严格串行；第 6 步跟随 2b 与第 5 步的实际证据及最终 Owner Decision。开发并行不授予提前轮换、发布或收权。

---

## 9. 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| 第 2 步漏改某个比对点，该函数对所有调用一律拒绝 | 目录查询清单 + 守卫测试 + 全量 `test:db`；失败即关闭，不会放行错误调用 | 补一个前向修复迁移；必要时用备份表还原 |
| 第 2 步漏改某个写入点，新签发的令牌存了证明值而不是校验值，无法使用 | 守卫测试同样检查写入；签发路径有现成数据库测试 | 前向修复，并对受影响的行重算 |
| 第 2 步触及 Owner Grant 门口所依赖的 `resolve_binding` | MergeAdmission §1 的非目标是「不改信任根」，本方案不改门口的判定语义与授权表，只改比对形式；第 2 步 PR 需要在描述里点明，并跑 Owner 授权相关全部测试 | 同上 |
| 第 4、5 步顺序错，Worker 被拒，线上全部 MCP 调用失败 | 先加授、后发布、按角色统计确认、最后收回；本次 P0-4 收回前保留至少 6 小时观察且通过 §6.2 的验收门 | 重新授予 `anon`（一条迁移，几秒生效） |
| C1 的 JWT 泄露 | 仍需 Binding 证明才能调用业务函数；发行方函数仍需发行方证明 | 轮换凭据（§6.2 的运维代价） |
| 冻结合同措辞与实现不一致 | 第 6 步走 ERRATA | — |

---

## 10. 需要 Owner 决定

1. **已定**：设计 A 与 7 天备份（Decision `1427642f`）、第 1 步先行并收紧插入/修改/删除（Decision `096df8b8`）、自动转换与 2a/2b 拆分（Decision `2ec964af`）。
2. **已定**：2b 固定身份与凭据分离、新摘要版本、历史原字节保留；两把凭据逐把验证后立即停旧（Decision `818a9b05`，§4.8）。
3. **已定**：C1 两阶段与 2b 并行开发、Owner 配合导入签名密钥的原设计与顺序保留（Decision `818a9b05`）；本次 P0-4 至少 6 小时生产观察且通过 §6.2 的验收门后，才进入取得阶段授权后的旧权限收回（Decision `23d196f2@1`）。时间下限调整不代替最终验收或生产授权。
4. **待精确阶段确认**：2b 实现的具体摘要版本/字段和轮换包、C1 的实际 RPC 白名单/调用角色守卫及两阶段迁移发布包，以及第 6 步冻结合同 ERRATA 的最终 Owner Decision。设计选择不把未核验实现升级成接受或生产授权。

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
