# Clued P5 多租户隔离与并发写验收报告 v1.0

最终裁决：

`PASS / P5_TENANT_ISOLATION_CONCURRENT_WRITES_ACCEPTED_FOR_INDEPENDENT_REVIEW`

## 1. 固定基线与执行边界

- 仓库：`tdoljyj/cross-memory-system`
- 固定远端 `main` 与 P4 Closeout：`8327b6b0429ce69aa95be05fc83bb0e4950625ea`
- P5 功能分支：`codex/p5-tenant-isolation-concurrent-writes`
- 分支起点与唯一预期父提交：`8327b6b0429ce69aa95be05fc83bb0e4950625ea`
- P5 证据目录：`artifacts/clued-validation/p5/8327b6b0/`
- 本轮只修改 P5 所需的 Clued Cloud Worker 合同、Supabase Migration、本地真实 PostgreSQL Harness、测试依赖、证据与本报告。

本轮未连接或修改生产 `clued-prod`，未执行部署、P6 Shadow/Canary/回滚、Continuity Runtime、Plan/Run/Step、n8n、UI、公开插件、账号页、产品导航、Tag、Release、Snapshot、Manifest、正式 Current Pointer、根 `VERSION`、语义召回、force push、rebase、squash、amend、merge commit、历史重写或 `main` 合并。

## 2. 实现摘要

P5 以追加式 Supabase Migration 建立 Organization、Workspace、Membership、Binding 扩展、Session 扩展、Idempotency、Event、immutable Receipt、Audit 与 Pending Intent 合同。现有个人 M1 行继续按旧 owner 边界读取；P5 行必须同时携带 Organization、Workspace 与 `private|workspace` visibility，并且只允许通过受控服务 RPC 权威写入。

每次在线请求均在数据库内重新读取并精确验证：

1. User；
2. Organization/Tenant；
3. Workspace；
4. Context Key；
5. 独立 Agent Binding；
6. Role；
7. Scope；
8. Purpose；
9. Policy Version；
10. Revocation Epoch；
11. Binding 与 Membership Expiry；
12. Binding、Membership、Organization 与 Workspace 当前状态。

Session 只保存当时的 Organization、Workspace、Context、Purpose、Policy Version 与 Revocation Epoch；下一次请求仍先重验 Binding 与 Membership，再验证 Session。Session 不是授权缓存，无法绕过撤销、降权、Scope 缩小、Policy 变化或 Workspace 切换。

Cloud Worker 新增受 `P5_TENANT_WRITES` 显式开关控制的 P5 Tool/RPC 映射。开关默认关闭；P5 操作只接受 `clued_bnd_` 独立 Binding Token。OAuth 用户 Token 不得替代 Agent Binding。未执行部署或生产启用。

## 3. CAS、幂等与事务合同

### 3.1 F15 提交点 CAS

Canonical Record/Project 更新使用单条条件更新：目标 ID、Organization、Workspace、visibility 和精确 `version = base_version` 必须同时命中，随后 `version = version + 1`。没有用顺序调用模拟并发；验收使用两个独立 PostgreSQL 连接、两个独立用户和两个独立 Agent Binding 同时提交相同 Base Version。

结果：

- 两端 Base Version 均为 `1`；
- 只有一个事务 committed；
- 另一端返回 `CANONICAL_CAS_CONFLICT`；
- 冲突证据含 `expected_version=1` 与 `actual_version=2`；
- 最终版本只增加一次；
- 只有一条成功 Event 和一份 committed Receipt；
- 失败端未覆盖胜者。

### 3.2 F16/F17 幂等

幂等唯一键为 Organization + Workspace + Binding + Operation Family + Idempotency Key，服务端保存稳定 JSONB Payload Hash。

已覆盖：

- 同 Key、同正文串行重试：返回同一业务结果；
- 同 Key、同正文真实并发重试：唯一约束竞争后返回同一业务结果；
- 网络结果丢失后重试：返回原结果；
- 同 Key、不同正文串行冲突：`IDEMPOTENCY_PAYLOAD_CONFLICT`；
- 同 Key、不同正文真实并发冲突：一方成功，另一方拒绝；
- Mutation、成功 Event 与 committed Receipt 均无重复业务副作用。

### 3.3 F18 原子回滚

Mutation、成功 Event、immutable Receipt 与成功 Audit 位于同一 PL/pgSQL 子事务。失败时子事务整体回滚，外层只保存失败 Receipt、失败 Audit 与确定性的 Idempotency 结果；不会生成成功状态、成功 Event 或 committed Receipt。

真实故障注入覆盖：

1. Mutation 后、Event 前失败；
2. Event 后、Receipt 前失败；
3. Receipt 写入失败；
4. Receipt 后失败；
5. Audit 写入失败；
6. CAS 失败；
7. 幂等唯一约束竞争；
8. Deferred Constraint 导致事务 commit 失败。

每个失败场景均证明旧版本与正文完整、不存在部分 Mutation、不存在孤立成功 Event、不存在 committed Receipt、相同请求重试结果确定。commit-time 失败导致整个外层事务回滚，随后由新的平台审计事务记录 `TRANSACTION_COMMIT_FAILED`，不伪造成功 Receipt。

## 4. 授权、撤销与 Workspace

### 4.1 身份矩阵

| 维度 | 夹具与结果 |
| --- | --- |
| 用户 | 5 个独立用户：Owner、Editor、Reader、Denied、Tenant B Owner |
| Organization/Tenant | Tenant A、Tenant B |
| Workspace | Tenant A / Workspace A、Workspace A2；Tenant B / Workspace B |
| Role | `owner`、`editor`、`reader`、`denied` |
| Agent Binding | 9 个独立 Binding；F15 使用 Owner 与 Editor 两个独立 Binding |
| Actor | `user`、`agent_binding`、`service_account`、`automation` 均产生可区分 Audit |
| Context Key | `project:p5` 与切换后的 `project:p5:a2` |
| Scope | `canonical:read/write`、`project:read/write`、`audit:read` |
| Purpose | `project_delivery` |
| 变化 | Binding 撤销、Role 降权、Scope 缩小、Policy Version 变化、Workspace 切换 |

### 4.2 F22/F23

- 已撤销 Binding 携带旧 Session 再试：下一在线请求返回 `P5_BINDING_REVOKED`，Canonical 版本不变，拒绝有 Audit。
- Reader 尝试权威写入：`P5_SCOPE_DENIED`。
- Denied 尝试权威写入：`P5_ROLE_WRITE_DENIED`。
- Editor 被降为 Reader：下一请求 `P5_ROLE_CHANGED`。
- Membership Scope 缩小：下一请求 `P5_SCOPE_DENIED`。
- Organization Policy Version 改变：旧 Policy Version 请求 `P5_POLICY_VERSION_CHANGED`。
- Workspace A 切到 Workspace A2：旧 Session 全部结束，旧 Context 立即失效；新 Workspace、新 Context、新 Revocation Epoch 重新开 Session 后才可写入。

## 5. 服务层与真实数据库 RLS

真实 RLS 验收没有使用 Mock、内存字典或只扫描 Policy 文本。测试在本机临时原生 `PostgreSQL 18.4 x86_64-windows` 实例中从空库按顺序应用全部 11 份 Supabase Migration，再使用真实 `authenticated` Role、`auth.uid()`、JWT `app_metadata` Binding 身份和 PostgreSQL Row Level Security 执行查询。

RLS 辅助函数只把 JWT 中的 Binding/Organization/Workspace/Context/Purpose/Policy/Epoch 当作待核对身份，不把它们当授权结论；每次仍联表读取当前 Binding、Membership、Organization 与 Workspace。撤销、Expiry、Role、Scope、Purpose、Policy Version 与 Revocation Epoch 均由数据库当前行决定。

F24 结果：

- 服务层伪造 Tenant B Record ID：`P5_TARGET_SCOPE_DENIED`；
- 服务层伪造其他用户 private Record ID：`P5_TARGET_SCOPE_DENIED`；
- 服务层伪造 Tenant B Project ID：`P5_TARGET_SCOPE_DENIED`；
- 三个服务层拒绝均产生 Audit，目标旧状态不变；
- RLS 合法 Owner 可读 Workspace 共享 Record 与自己的 private Record；
- RLS 合法 Editor 可读共享 Record，但不可读 Owner private Record；
- 伪造 Tenant/Workspace Claim 返回零行；
- 临时授予列 UPDATE 仅用于故障注入时，跨租户直接写仍由真实 RLS 拒绝/影响零行；测试后立即撤销该临时 Grant；
- Migration 最终撤销 authenticated 对 `clued_memories`、`clued_projects`、Binding 与 Session 的直接写 Grant，防止形成第二业务写路径。

测试数据库位于任务临时目录，绑定本机临时端口；`production_access=false`。未连接 Supabase 生产项目，未执行远端 Migration、部署或生产 RLS 修改。

## 6. F28、F29 与离线写入

F28 把冲突域分开：

- Canonical 并发：`CANONICAL_CAS_CONFLICT`，证据域 `canonical_store`，含 expected/actual version；
- Git 分叉：`GIT_DIVERGENCE`，证据域 `git_history`，含 Base/Local/Remote Commit；
- 两者均声明 `auto_merge=false`，Git 还声明 `auto_overwrite=false`；
- 同时制造两类冲突后，Canonical 胜者保持不变。

F29 控制场景经 `clued_p5_mutate` 原子提交 Canonical Mutation、Event 与 Receipt。故障场景调用退休的本地业务写入口 `memory.py add`，返回退出码 `2` 和 `local_snapshot_is_read_only`。调用前后：

- `memory/` Tree Digest 不变；
- `artifacts/clued-two-level-snapshots/` Tree Digest 不变；
- 开发工作树状态逐字节不变；
- Canonical Store 未因退休入口发生变化；
- 没有 Markdown/Git 双写。

离线写入只可生成 `clued_pending_intents.status='pending'`；返回明确 `server_confirmed=false`、`canonical_mutated=false`、`event_created=false`、`receipt_created=false`。Schema 用 CHECK 将该表状态固定为 `pending`。

## 7. 回归门禁

| 门禁 | 结果 |
| --- | --- |
| P1 专项 | PASS，15/15 |
| P2 专项与文档合同 | PASS，29/29 |
| P3 专项 | PASS，22/22 |
| P4 F10–F14/F20/F21/U02/U03/U05 | PASS，33/33 |
| Root cutover / no dual-write | PASS，5/5 |
| Python 全量 | PASS，104/104 |
| P5 Worker/Migration 静态合同 | PASS，2/2 |
| P5 真实 PostgreSQL/RLS/并发测试 | PASS，1/1 test，102/102 assertions |
| Cloud verified build | PASS |
| Cloud 离线回归 | PASS，66/66 |
| `memory.py doctor` | PASS，710 个 Manifest 文件，`snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155` |
| `sync-memory.py doctor` | PASS，Repository Snapshot 与 Local Mirror |
| NONE/T0 | PASS，`sources_read=[]`、`verification_context=null`，未创建 Context，未读 Git/Memory/网络 |
| Python `py_compile` | PASS |
| Python `compileall` | PASS |
| `git diff --check` | PASS |

黄金集合同在任务临时目录中使用冻结 runner 加只读外壳复跑，未写仓库：

- 19/19 PASS；
- 111 cases；
- corpus hash：`1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`；
- replay hash：`f4266eabd2bed94da36c5fa7d99fba17a3493418b849da3dfcfcee7e2842159c`；
- critical memory recall v2：`0.7763`；
- false recall rate v2：`0.3444`；
- stale recall：`0`；
- current scope leakage：`0`；
- no-memory violations：`0`；
- secret leaks：`0`。

P4 Canonical-first、Freshness、确定性 T1 与语义召回的生产开关均未改变；语义召回继续保持禁用。

## 8. 证据清单

| 文件 | Git Blob SHA | SHA-256 |
| --- | --- | --- |
| `binding_revocation_role_scope_evidence.jsonl` | `849fa6404a562d3c2bd7f460f9284c0e206c77d1` | `e3a50f10828227b8f0b9011a156b1a6aad4f46dbc570efd3ed31202b06253106` |
| `concurrent_cas_evidence.jsonl` | `89b2f2dc3c43dff3a27c55d04aee4b98798c9f6f` | `fcb623da6d5b402f46856ebc3bab3a8565cf4048a9145b3e8d7f362fba9c9c23` |
| `git_canonical_conflict_evidence.jsonl` | `fca38c32360ecae2c1edac0a1cb0b88686a9ca92` | `8ac81ab77ead0482b26dfc4743249fe52344ce5d0f5f83e46643ce844fd8d9b0` |
| `idempotency_retry_evidence.jsonl` | `2be2d3419cc47d19fae7c0e9b9927aad41e348ad` | `d087ea19d926bfb1e0d23b918e12383514fa231a84874b3dffaee54febe9c3d0` |
| `p5_raw_results.jsonl` | `8998fef7a82b4ae459cb6ee885ca501f6cfa4beb` | `d86890278a2f883932cfd64d3c95b26c18b0a5126a119e00dc985422a7c89eef` |
| `tenant_workspace_rls_evidence.jsonl` | `dd4f22f24ce2c5aad99f186e5ceee5946cb3fc52` | `9458ef213894fbf5fccddac79b0c2d6f51bfb60bdcf18a43517a53c126aa7aba` |
| `transaction_rollback_evidence.jsonl` | `d052983e89b2ed463b340668548764bf5eec63aa` | `9d8791a0acc81054e89827b3f6102dab13b7b7a3dd22de11350432dbb73a0257` |
| `SHA256SUMS` | `dc6c2cb8eb307bac2c64b40b326125f2b7a3b892` | `be38105fbb325c82c064287c9fe6653f7e6d1255fb6d052ec235ceba80364109` |

`SHA256SUMS` 逐项覆盖七份 JSONL 证据，其自身 SHA-256 与 Git Blob 另行记录。

## 9. 精确变更文件

P5 候选仅包含以下 16 个文件：

1. `apps/clued-cloud/package.json`
2. `apps/clued-cloud/package-lock.json`
3. `apps/clued-cloud/worker/continuity.ts`
4. `apps/clued-cloud/worker/p5.ts`
5. `apps/clued-cloud/supabase/migrations/20260827031728_clued_p5_tenant_isolation_concurrent_writes.sql`
6. `apps/clued-cloud/tests/p5-cloud-contracts.test.mjs`
7. `apps/clued-cloud/tests/p5-real-postgres.test.mjs`
8. `artifacts/clued-validation/p5/8327b6b0/p5_raw_results.jsonl`
9. `artifacts/clued-validation/p5/8327b6b0/tenant_workspace_rls_evidence.jsonl`
10. `artifacts/clued-validation/p5/8327b6b0/binding_revocation_role_scope_evidence.jsonl`
11. `artifacts/clued-validation/p5/8327b6b0/concurrent_cas_evidence.jsonl`
12. `artifacts/clued-validation/p5/8327b6b0/idempotency_retry_evidence.jsonl`
13. `artifacts/clued-validation/p5/8327b6b0/transaction_rollback_evidence.jsonl`
14. `artifacts/clued-validation/p5/8327b6b0/git_canonical_conflict_evidence.jsonl`
15. `artifacts/clued-validation/p5/8327b6b0/SHA256SUMS`
16. `docs/clued-two-level-views/Clued_P5_多租户隔离与并发写_验收报告_v1.0.md`

没有修改 P1–P4 实现、测试或原始证据；没有修改 `memory/`、Snapshot、Manifest、Current Pointer 或 `VERSION`。

## 10. sources_read

仓库内来源：

- `AGENTS.md`
- `apps/clued-cloud/AGENTS.md`
- `skills/clued-continuity/SKILL.md`
- `docs/clued-two-level-views/Clued_校验不变量与去重矩阵_v1.1.md`
- `docs/clued-two-level-views/Clued_单一数据源与两级五视图架构方案_v1.6.md`
- `docs/clued-two-level-views/Clued_P4_独立复验与合并_Closeout_报告_v1.0.md`
- `apps/clued-cloud/worker/continuity.ts`
- `apps/clued-cloud/worker/records.ts`
- `apps/clued-cloud/worker/projects.ts`
- `apps/clued-cloud/supabase/migrations/202608230001_clued_continuity.sql`
- `apps/clued-cloud/supabase/migrations/202608230002_mandatory_continuity.sql`
- `apps/clued-cloud/supabase/migrations/202608250005_oauth_mcp_binding.sql`
- `apps/clued-cloud/supabase/migrations/20260825171129_clued_m1_runtime_contracts.sql`
- `cloud/postgres/README.md`
- `cloud/postgres/migrations/0001_cloud_data_foundation.up.sql`
- 精确 Clued Project Object `0597aa60-9b98-4da6-a4ab-63d7705b632f` 及其 State/Task/Decision 标准视图；未加载无关项目。

当前官方来源：

- Supabase Row Level Security 指南：`https://supabase.com/docs/guides/database/postgres/row-level-security`
- Supabase Changelog：`https://supabase.com/changelog`
- PostgreSQL Row Security Policies：`https://www.postgresql.org/docs/current/ddl-rowsecurity.html`
- PostgreSQL Transaction Isolation：`https://www.postgresql.org/docs/current/transaction-iso.html`
- Cloudflare Workers Best Practices：`https://developers.cloudflare.com/workers/best-practices/workers-best-practices/`

## 11. 最终裁决

P5 的 F15–F18、F22–F24、F28、F29 已在非生产临时真实 PostgreSQL 中通过控制、并发、故障注入、服务层和 RLS 双层验收；P1–P4、Python、Cloud、doctor、NONE、黄金集与编译门禁均无回归。候选可推送独立功能分支，等待第一轮独立复审，不得合并 `main`。

`PASS / P5_TENANT_ISOLATION_CONCURRENT_WRITES_ACCEPTED_FOR_INDEPENDENT_REVIEW`
