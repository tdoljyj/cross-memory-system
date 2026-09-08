# 隔离 Profile 现有状态源映射

**READ_ONLY_SOURCE_MAPPING；未创建数据库、未执行测试、未签资格。** 受查 HEAD 为 `2ff9f9cee4b651d58c4762216392b92eb48e227e`。本次只读现有迁移与 fixture；已有真实运行证据按原范围复用，不把本次静态定位称为新一轮验证。

**可以复用真实隔离 PostgreSQL 与 OAuth/MCP 应用链，不能直接声称已具备 S06 四层 RevocationEpochVector。** 合成账号、客户端、Context 和 Binding 已存在；缺的主要是 integration-installation 的独立主体，以及 account/context/binding 各层一致、单调、完整的 epoch 语义和读取合同。不是必须把所有层改成 N/A，也不能把已有不同含义的版本改名凑齐。

## 首选已有 fixture

`apps/clued-cloud/tests/authorization-end-to-end.test.mjs:26` 已组合真实 OAuth 库→实际 `worker/delegated-oauth.ts`→实际应用 RPC→迁移后的 embedded PostgreSQL。第39–57行创建合成 `auth.users`、Project、issuer、Context和隔离连接；第70–100行经过注册、PKCE、逐连接授权、MCP 正负调用、原 Event/Receipt、重放和撤回；第105–121行覆盖邀请成员、隔离开发投影和成员撤回。这条链比只 stub RPC 的 `delegated-oauth-transport.test.mjs` 更适合做后续隔离状态源基础。

边界：第19–24行 `MemoryKV` 仅进程内 Map，没有持久化或 TTL 实现；第58–68行 HTTP/Auth 由本地适配器映射到 SQL，账号JWT claim由fixture设置。它不是实际 Supabase登录、受信宿主或远端持久sink。文件的全迁移遍历应在后续受查 Profile 中固定为精确迁移集合，避免新增迁移静默改变对象。

## 四层逐项定位

| S06 层 | 已有真实隔离实体/状态 | 可复用读取和负例 | 精确适用差距 |
| --- | --- | --- | --- |
| account | `auth.users.id`；project-list fixture第24行另建 `banned_until/deleted_at`，第79–81行实际更新并验证拒绝 | v12迁移第544–553行 `authorization_account_v12` 在事务内锁定账号；业务 RPC 与 `clued_authorization_status_v12`调用此检查 | 没有独立 `account_epoch`。禁用/恢复时间不是不可回退的epoch；E2E fixture最小auth表本身也没有这两列，须明确选取已有增强fixture范围。合成账号只控制测试业务对象，不能充当真实Owner/issuer资格。 |
| integration-installation | v12 `authorization_requests_v12.client_id/issuer_hash`、`authorizations_v12.client_id/resource`；OAuth库注册客户端与MemoryKV token状态 | v12第60–66行 `authorization_issuer_v12`核查issuer是否撤回；connection fixture第153–163行验证issuer绑定、撤回幂等及已撤issuer不能发起请求 | 没有独立 installation 实例/稳定scope-ref/单调 `integration_installation_epoch`。OAuth client_id是客户端身份，issuer是发起授权主体，request_id是单次请求；三者都不能直接改名为安装实例。issuer撤回测试只证明该调用链的实际拒绝，不证明安装层全链撤回。 |
| context | v14 `development_spaces_v14.id/project_id/environment/version/cursor`；`development_grants_v14.revoked_at/expires_at/version`；v13 membership同类状态 | `clued_development_owner_v14(context_create)`建真实test Context；`clued_development_call_v14(context_list/record_list)`及v13 `authorization_assert_entry_v12`、`authorization_effective_actions_v13`核查精确Context/环境/成员/权限 | space版本与记录cursor不是 `context_epoch`；grant/member撤回是特定访问边，不等于Context全局单调撤回。未提供完整context层epoch当前读取RPC。 |
| binding | `clued_agent_bindings.id/revoked_at/scopes/context_keys`；v12 `authorizations_v12.version/expires_at/revoked_at`和明确entries；若装P5另有旧 `revocation_epoch`列 | v12第266–298行 `clued_authorization_manage_v12`实际reduce/revoke；第421–434行status返回active/binding_id/version/expiry；v13实际resolver/entry检查在业务事务内执行 | v12 revoke只改binding时间与authorization版本，reduce改entries/scopes/version，没有同步推进P5旧epoch。authorization version包含多种修改，不能未经合同映射直接叫binding_epoch。status输出不是四层Vector。 |

`project-list-authorization-db.test.mjs:35–43` 的 authenticated/anon 连接、真实prepare/approve和第65–99行降权、账号禁用、成员撤回，可复用作受控状态变化输入。其migration选择排除了P5，因此不可假定测试库天然有P5 epoch列。

## P5 的四数不能代替所需四层

`20260827031728_clued_p5_tenant_isolation_concurrent_writes.sql` 给 organization、workspace、membership、binding 各自 `revocation_epoch`；第281–285行 `p5_effective_epoch` 使用 `greatest(...)`，第344–347行resolver比对这个单一标量。层含义不同，且最大值会掩盖其他层小于最大值的增长，无法作为S06逐层scope-ref/epoch校验。这里只指出对本 Profile 的不适用，不改旧冻结实现、不把其既有P5测试判成失败。

受查迁移与测试中没有 `revocation_epoch_vector`、`account_epoch`、`integration_installation_epoch`、`context_epoch` 的现成实现。现有业务授权RPC能真实读取本库当前访问状态，但没有一个RPC返回符合S06的完整四层向量。不得把业务status.active布尔值或最大epoch包装后冒称完成原合同。

## 最小 Profile 输入建议

1. 复用E2E真实库/应用链和上述账号禁用、Binding降权、Context成员撤回fixture；固定源码、迁移集合、数据库版本、合成对象ID与生命周期、允许RPC和只读当前状态查询。运行时数据库只保存本次合成测试对象，不接生产连接，不读真实用户数据。
2. 将现有表的原始字段作为**明确标注的测试业务状态**供当前规则判定；driver管理员只用于隔离fixture置备，候选只可调用受限业务入口。保留真实Owner签名、独立接受和GA控制链在测试业务身份之外。不能由fixture中的auth.uid或issuer哈希给driver授予资格。
3. 对要求S06 Vector的正式执行，先补齐这一具体数据契约差距：真实installation实例与其scope映射；account/context/binding层独立单调epoch及所有相关撤回路径的原子更新/读取；每层scope ID、Vector Schema和控制代际分别绑定。准备只能在已批准隔离工程范围内，原合同表达与实现须独立接受后启用。不存在的层仍须合法Schema依据，不能默认N/A；本映射不创建该Schema或代际。
4. 在完整Vector可核验之前，可继续受授权的静态准备及固定合成业务正负fixture；不能把已有业务撤回试验升级为控制器资格。实际PQUAL还需最终宿主隔离、持久Intent、预算预留、停止/UNKNOWN、时间与Owner/GA当前撤回接线。Docker/WSL安装或恢复属于其他受派工作，本评估者没有执行。

## 精确来源摘要

以下路径相对于仓库根；SHA256绑定本次实际读取字节。

| 路径 | SHA256 |
| --- | --- |
| `apps/clued-cloud/tests/authorization-end-to-end.test.mjs` | `9a7a2785d810a25ba6583c5fc1afe7ecf1eefe528cc75142d142ecd036dec5c1` |
| `apps/clued-cloud/tests/project-list-authorization-db.test.mjs` | `6669eed654d40dd777f0742d28c248878b7cd2f43c39bd0b25f5eda1c642241e` |
| `apps/clued-cloud/tests/connection-authorization-db.test.mjs` | `5c3799b6a5298cbc01b5b7f2236428eff10b474f31d76219b5f30915c2bfce28` |
| `apps/clued-cloud/supabase/migrations/20260907173031_clued_connection_authorization_v12.sql` | `6f1379187f1f36c836e99f6cf2083334e733fcb10cd59f789797b9e3c5225f8d` |
| `apps/clued-cloud/supabase/migrations/20260907173030_clued_development_context_runtime_v14.sql` | `74749dbb6718784e0ed8b54edad5f47a18f44d986e319b86f0b47123355a74f6` |
| `apps/clued-cloud/supabase/migrations/20260907173032_clued_project_invitations_v13.sql` | `82d625ee3b3fabac7b8fadba6660aa30c336d60698723d49b5e586b490db0ca5` |
| `apps/clued-cloud/supabase/migrations/20260827031728_clued_p5_tenant_isolation_concurrent_writes.sql` | `a9cfcbb7983eaef94d891556226e32f15d168fce1628a6f3c6f82a683df2d4d3` |

S06四层依据和已接受工程父对象继续引用 [CurrentRuntimeProfileInputsReview.md](CurrentRuntimeProfileInputsReview.md) 与 [IndependentR10SignatureBinding.json](IndependentR10SignatureBinding.json)，不重复签发或改历史接受。
