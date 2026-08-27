# Clued P5 多租户隔离与并发写验收报告 v1.0

本报告记录 P5 第一轮独立复审阻断项的线性修复、重新验收与第二轮独立复审候选事实。

最终裁决：

`PASS / P5_SECURITY_FIX_ACCEPTED_FOR_SECOND_INDEPENDENT_REVIEW`

## 1. 固定拓扑与边界

- 仓库：`tdoljyj/cross-memory-system`
- 固定 `main` / P4 Closeout：`8327b6b0429ce69aa95be05fc83bb0e4950625ea`
- P5 第一候选：`5aa069b5f594789bf564af67ebfaf1f6b67c332c`
- 本轮修复提交的唯一父提交：`5aa069b5f594789bf564af67ebfaf1f6b67c332c`
- 功能分支：`codex/p5-tenant-isolation-concurrent-writes`
- 证据目录：`artifacts/clued-validation/p5/8327b6b0/`

本轮只追加一个普通线性修复 Commit；不 amend、rebase、squash、force push，不移动或合并 `main`。未执行 P6、生产访问或生产数据库、部署、Tag、Release、Snapshot、Manifest、Current Pointer、根 `VERSION` 或语义召回变更。

## 2. 第一轮复审与根因

第一轮裁决：

`FAIL / P5_INDEPENDENT_REVIEW_BLOCKED_BY_ANON_RPC_GATE_BYPASS_AND_FORGEABLE_COMMIT_FAILURE`

根因有两项：

1. 第一候选把 public `SECURITY DEFINER` P5 RPC 直接授予 `anon`，持有 Binding Token 的调用者可自行计算 Token Hash 后绕过 Worker，进而绕过 `P5_TENANT_WRITES`、Binding-only 路由、JSON Schema、请求大小和未来 P6 启停边界。
2. 旧 `clued_p5_record_commit_failure` 接受普通调用者提供的任意 `p_error`。测试在事务失败后由夹具手工调用它，Worker 没有真实自动补记链路；因此调用者可伪造 `TRANSACTION_COMMIT_FAILED` 并污染 Idempotency Key。

## 3. 修复合同

### 3.1 Gateway 最小权限边界

- 从 `PUBLIC`、`anon`、`authenticated`、`service_role` 撤销全部 8 个 public P5 RPC 的直接 `EXECUTE`。
- 新增 `clued_p5_gateway`：`NOLOGIN`、`NOINHERIT`、`NOBYPASSRLS`、非超级用户；只拥有 P5 public RPC 的 `EXECUTE` 和 public schema `USAGE`。
- Gateway 无 P5 Attempt 表权限，也不能直接执行 private mutation core。
- Worker 仅从服务端 Secret `CLUED_P5_GATEWAY_TOKEN` 取得专用 Gateway JWT；源码、客户端、证据和日志均不含该 Token、`service_role` Secret 或数据库密码。
- Binding Token 仍只作为待核对身份，Worker 只向数据库传输其 SHA-256；它不再充当数据库 RPC 执行凭据。
- `P5_TENANT_WRITES=false` 时，Worker 在进入任一 RPC 前返回 404；匿名、publishable key、authenticated 或有效 Binding Token 直调数据库均因 SQLSTATE `42501` 被拒绝且零 Mutation。`true` 控制场景走实际 Worker → Gateway → PostgreSQL 并成功。

### 3.2 真实 commit-time failure 闭环

Worker mutation 流程为：

1. 经 Gateway 创建服务端 Attempt；
2. Attempt 绑定 Organization、Workspace、User、Binding、Request Hash、Idempotency Key、Target、Base Version，并带短期 Expiry；
3. 使用同一 Attempt 发起权威 Mutation；
4. 数据库 commit/transport failure 被 Worker 捕获；
5. Worker 经受保护通道在新事务中解析仍为 `open` 的 Attempt；
6. 只有精确匹配且未消费的 Attempt 才可生成一份 failed Idempotency、immutable failed Receipt 与 failed Audit；
7. Attempt 原子变为 `failed`，同请求重试确定性返回同一失败结果。

真实 deferred constraint commit failure 在数据库事务提交点发生。原 Mutation、Event、成功 Receipt 和成功 Audit 整体回滚；测试夹具没有手工调用补偿函数，补记由实际 Worker 自动完成。

`clued_p5_record_commit_failure` 不再接受任意 `p_error`；只接受数据库合同定义的 `database_commit_failure` 或 `transport_failure` 分类，并必须携带服务端创建的一次性 Attempt。以下场景全部 fail-closed、零 Idempotency/Receipt/Audit 污染，且不影响后续合法 Mutation：

- 无 Attempt 或伪造 Attempt；
- 已消费 Attempt 重复使用；
- Request Hash / 正文不匹配；
- 跨 Binding、Organization、Workspace、Target 或 Idempotency Key；
- 不可信 failure kind。

## 4. P5 不变量与身份矩阵

F15–F18、F22–F24、F28、F29 原合同继续成立：每次在线访问重验 User、Organization/Tenant、Workspace、Context Key、Agent Binding、Role、Scope、Purpose、Policy Version、Expiry 与 Revocation Epoch；Auth、服务层授权和真实数据库 RLS 保持独立纵深防御。

矩阵覆盖：

| 维度 | 覆盖 |
| --- | --- |
| 用户/租户 | 5 个用户，Tenant A / Tenant B |
| Workspace | Tenant A 的 Workspace A/A2，Tenant B 的 Workspace B |
| Role | Owner、Editor、Reader、Denied |
| Binding | 9 个独立且可撤销 Binding；并发双方使用独立 Binding |
| Context/Scope/Purpose | 不同 Context Key；read/write/audit Scope；`project_delivery` Purpose |
| 动态变化 | 撤销、Role 降权、Scope 缩小、Policy 变化、Workspace 切换 |
| 伪造 | 跨用户、跨租户、跨 Workspace 的 Record/Project 读写 |
| Actor | user、agent_binding、service_account、automation 分别审计 |

F15 使用两个独立连接和同一 Base Version 真实并发：仅一个提交，另一方返回含 expected/actual version 的 `CANONICAL_CAS_CONFLICT`；最终版本只增一，只有一组成功 Event/Receipt。F16/F17 覆盖同 Key 同正文串行/并发/网络结果丢失重试，以及同 Key 不同正文串行/并发冲突。F18 覆盖 Mutation 后、Event 前，Event 后、Receipt 前，Receipt 写入，CAS，幂等唯一约束，Audit 和真实 commit failure。F22/F23 覆盖撤销、降权、缩 Scope 和 Workspace 切换后的下一在线请求。F24 的服务层与真实 RLS 分别独立拒绝伪造。F28 区分 `GIT_DIVERGENCE` 与 `CANONICAL_CAS_CONFLICT`。F29 保持 Git、Markdown、Bundle、Index 和 `memory/` 只读，离线只产生 Pending Intent。

## 5. 独立数据库权限与 Advisors

验收使用临时本地原生 PostgreSQL 18.4，从空库顺序应用 12 份 Supabase Migration；没有 Mock、内存字典或只读 Policy 文本替代真实执行。

- 逐一以 `anon` 调用 8 个 P5 RPC：8/8 `permission denied`。
- 逐一以 `authenticated` 调用 8 个 P5 RPC：8/8 `permission denied`。
- `service_role` 无 P5 RPC `EXECUTE`。
- 有效 Binding Token 不能替代 Gateway JWT 绕过 Worker。
- Gateway Role 权限、角色属性、private core 与 Attempt 表隔离均通过。
- Supabase CLI `db advisors --type security --level warn --fail-on error --output-format json` 实际执行并 PASS；结果哈希和字节数写入独立证据。
- `production_access=false`，未连接 `clued-prod`。

## 6. 重新执行的门禁

| 门禁 | 结果 |
| --- | --- |
| P1 专项 | PASS，15/15 |
| P2 专项 | PASS，29/29 |
| P3 专项 | PASS，22/22 |
| P4 专项 | PASS，33/33 |
| Python 全量 | PASS，104/104 |
| P5 Cloud contracts | PASS，2/2 |
| P5 真实 PostgreSQL/RLS/并发/Worker | PASS，1 test，144/144 assertions，18 scenarios |
| Cloud verified build | PASS |
| Cloud 离线回归 | PASS，66/66 |
| `memory.py doctor` | PASS，710 Manifest files，`snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155` |
| `sync-memory.py doctor` | PASS |
| NONE/T0 | PASS，`sources_read=[]`、`verification_context=null`、零 Context/Git/Memory/网络读取 |
| Python compileall | PASS |
| `git diff --check` | PASS |
| 凭据扫描 | PASS |
| Supabase security advisors | PASS |

冻结黄金集在任务临时目录重跑：合同 19/19；回放 111 cases；corpus hash `1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`；replay hash `f4266eabd2bed94da36c5fa7d99fba17a3493418b849da3dfcfcee7e2842159c`；critical memory recall v2 `0.7763`；false recall rate v2 `0.3444`；stale、scope leakage、no-memory violations、secret leaks 均为 `0`。

## 7. 最终证据

| 文件 | Git Blob SHA | SHA-256 |
| --- | --- | --- |
| `binding_revocation_role_scope_evidence.jsonl` | `253a85afbc3ad3ca780916042f234f11dcbb6853` | `9f9caadbe7f904c306b5e3664e8dd8a575b620118153c8fa55ddee587b738db1` |
| `concurrent_cas_evidence.jsonl` | `d82db6bb45f81db60d6b42f8688ca20796b3f816` | `a52d9d57f4b13955a3e5a0b21d69b9bcb2c76e49d1ca92b1be55a4a83efd3779` |
| `git_canonical_conflict_evidence.jsonl` | `06b459f45d213c82781acda0d03223cebceace66` | `95e3f0636250f5194640d87c2f46c2bb172c63b0b04841c71da1d826afdbddba` |
| `idempotency_retry_evidence.jsonl` | `272b3c05f57244ea4a95ccdd60a9654428d7b36a` | `1e9295aa34afdc3de64d315dc72ba5828eba73fc7567dc4a7b381c77743789fe` |
| `p5_raw_results.jsonl` | `62020f948345cf3ef3cf55140aad1b3ab9819ee8` | `2023c0d848a1a350598d2509d1503d78a41e3f34e4e2525d12283dde524a60dc` |
| `supabase_advisors_evidence.jsonl` | `463f1b8ec19de64de5a432fa4ca7f77b04a280d0` | `27121e15d5a97787e620ad8a9620271a483aa07d0ea482916c2c4234b8f84383` |
| `tenant_workspace_rls_evidence.jsonl` | `dffe0365794c5127e41ebdcc008ac36dfc8c147b` | `dafaff61c147623a6add9b6db7a2e7558c6a9e42af6708748e7cfb3e9ccf5e0d` |
| `transaction_rollback_evidence.jsonl` | `ccdc181bf8c4ffc6343a75da3720fab8fdd3dc3e` | `9c5466d333a448e0de7d7da029c1f17237c4b38c5838f52d69b770232e6b9606` |
| `SHA256SUMS` | `f1228083674b89fb1a4afad5a7869c39f1583833` | `23280489762b5b3a71ed38ba4f3c48d147d38b47580c6f4ed58bc7a5976ff15f` |

`SHA256SUMS` 覆盖全部 8 份 JSONL；其自身 Blob 与 SHA-256 单独列出。

## 8. 本轮精确变更文件

修复提交只包含 16 个路径：

1. `apps/clued-cloud/supabase/migrations/20260827031728_clued_p5_tenant_isolation_concurrent_writes.sql`
2. `apps/clued-cloud/supabase/migrations/20260827050750_p5_gateway_attempt_commit_failure.sql`
3. `apps/clued-cloud/worker/continuity.ts`
4. `apps/clued-cloud/worker/p5.ts`
5. `apps/clued-cloud/tests/p5-cloud-contracts.test.mjs`
6. `apps/clued-cloud/tests/p5-real-postgres.test.mjs`
7. `artifacts/clued-validation/p5/8327b6b0/p5_raw_results.jsonl`
8. `artifacts/clued-validation/p5/8327b6b0/tenant_workspace_rls_evidence.jsonl`
9. `artifacts/clued-validation/p5/8327b6b0/binding_revocation_role_scope_evidence.jsonl`
10. `artifacts/clued-validation/p5/8327b6b0/concurrent_cas_evidence.jsonl`
11. `artifacts/clued-validation/p5/8327b6b0/idempotency_retry_evidence.jsonl`
12. `artifacts/clued-validation/p5/8327b6b0/transaction_rollback_evidence.jsonl`
13. `artifacts/clued-validation/p5/8327b6b0/git_canonical_conflict_evidence.jsonl`
14. `artifacts/clued-validation/p5/8327b6b0/supabase_advisors_evidence.jsonl`
15. `artifacts/clued-validation/p5/8327b6b0/SHA256SUMS`
16. `docs/clued-two-level-views/Clued_P5_多租户隔离与并发写_验收报告_v1.0.md`

未修改 P1–P4 实现/测试/原始证据、`memory/`、Snapshot、Manifest、Current Pointer 或 `VERSION`。

## 9. sources_read

仓库来源：`AGENTS.md`、`apps/clued-cloud/AGENTS.md`、`skills/clued-continuity/SKILL.md`、两级五视图架构与校验不变量文档、P4 Closeout、P5 Worker/测试/Migration、M1 runtime contracts、Cloud PostgreSQL foundation。

当前官方来源：

- Supabase Database Functions：`https://supabase.com/docs/guides/database/functions`
- Supabase Securing your API：`https://supabase.com/docs/guides/api/securing-your-api`
- Supabase Row Level Security：`https://supabase.com/docs/guides/database/postgres/row-level-security`
- Supabase Changelog：`https://supabase.com/changelog`
- PostgreSQL Row Security：`https://www.postgresql.org/docs/current/ddl-rowsecurity.html`
- PostgreSQL Transaction Isolation：`https://www.postgresql.org/docs/current/transaction-iso.html`
- Cloudflare Workers Best Practices：`https://developers.cloudflare.com/workers/best-practices/workers-best-practices/`
- Cloudflare Workers Secrets：`https://developers.cloudflare.com/workers/configuration/secrets/`

## 10. 最终裁决

第一轮阻断的匿名 RPC 绕过与可伪造 commit-failure 均已按最小权限、一次性 Attempt 和实际 Worker 自动补记闭环修复；原 P5 主体及 P1–P4 无回归。候选只可推送现有功能分支并等待第二轮独立复审，不得合并 `main`。

`PASS / P5_SECURITY_FIX_ACCEPTED_FOR_SECOND_INDEPENDENT_REVIEW`
