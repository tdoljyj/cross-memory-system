# Clued P5 多租户隔离与并发写验收报告 v1.0

本报告记录 P5 第二轮独立复审阻断项的线性修复、重新验收与第三轮独立复审候选事实。

最终裁决：

`PASS / P5_CONCURRENT_ATTEMPT_REPLAY_FIX_ACCEPTED_FOR_THIRD_INDEPENDENT_REVIEW`

## 1. 固定拓扑与边界

- 仓库：`tdoljyj/cross-memory-system`
- 固定 `main` / P4 Closeout：`8327b6b0429ce69aa95be05fc83bb0e4950625ea`
- P5 第二轮候选：`8fef81a32a761d89c196095c2fe758b33f9e4da6`
- 本轮修复提交的唯一父提交：`8fef81a32a761d89c196095c2fe758b33f9e4da6`
- 功能分支：`codex/p5-tenant-isolation-concurrent-writes`
- 证据目录：`artifacts/clued-validation/p5/8327b6b0/`

本轮只追加一个普通线性修复 Commit；不 amend、rebase、squash、force push，不移动或合并 `main`。未执行 P6、生产访问、部署、Tag、Release、Snapshot、Manifest、Current Pointer、根 `VERSION` 或语义召回变更。

## 2. 第二轮复审与根因

第二轮裁决：

`FAIL / P5_SECOND_INDEPENDENT_REVIEW_BLOCKED_BY_CONCURRENT_ATTEMPT_REPLAY_REGRESSION`

两个完全相同的并发 Worker 请求可能从 `clued_p5_attempt_begin` 取得同一个 open Attempt。第一方完成后，第二方原先在 `clued_p5_mutate` 中得到包装为 HTTP 成功 JSON 的 `P5_ATTEMPT_ALREADY_CONSUMED`；Worker 只对 RPC transport exception 调用 `attempt_resolve`，因而没有返回第一方已保存的 `canonical_result`。这避免了重复副作用，却违反 F16 对合法并发重试“规范结果完全相同”的要求。

## 3. 修复合同

### 3.1 数据库终态回放

Migration `20260827062132_p5_concurrent_attempt_replay.sql` 替换 public `clued_p5_mutate`：

1. 先 fresh-resolve Binding 并对 Attempt `FOR UPDATE` 加行锁；
2. 在读取或返回任何 `canonical_result` 前，逐项验证 Organization、Workspace、User、Binding、Request Hash、Idempotency Key、Target Kind/ID 和 Base Version；
3. 精确匹配且 status=`open` 时执行 private Mutation；
4. 精确匹配且 status=`completed` 或 `failed` 时直接返回已保存的 `canonical_result`；
5. `expired`、未知状态或终态缺少 `canonical_result` 明确 fail-closed；
6. mismatch 检查永远先于 completed/failed 结果返回，不向伪造 Attempt ID 或跨 Binding 请求泄露规范结果。

Gateway 最小权限和 8 个 P5 RPC 的撤权合同保持不变：`PUBLIC`、`anon`、`authenticated`、`service_role` 仍不能直接执行 P5 RPC；只有 `clued_p5_gateway` 可执行 public P5 RPC，且不能读写 Attempt 表或执行 private mutation core。

### 3.2 Worker 防御性解析

`callP5Mutation` 同时处理 transport exception 和 SQL 包装的 HTTP 200 竞态结果。若 mutate 返回 `P5_ATTEMPT_ALREADY_CONSUMED` 或等价终态，它必须调用 `attempt_resolve`：只有精确匹配且 resolved status 为 `completed`/`failed`、并存在对象型 `canonical_result` 时才返回规范结果；`open`、mismatch、expired、未知、缺失结果或歧义状态一律 fail-closed。防御路径不会调用 commit-failure 补记，也不会把 resolve details 中的规范结果附入错误响应。

### 3.3 确定性真实并发屏障

真实 Worker → Gateway → PostgreSQL 测试新增双阶段同步屏障：两个 Worker 请求必须都完成 `attempt_begin`，均观察到同一个 open `attempt_id`，随后两个 mutate 都抵达竞争闸门，最后才同时释放。测试不依赖调度时序。

覆盖并证明：

- 相同正文并发请求的两个 Worker 响应逐字节相同，均为 committed canonical result；
- Mutation、Event、Receipt、Idempotency 各一份，Canonical Version 只增加一次；
- 合法重试者不暴露 `P5_ATTEMPT_ALREADY_CONSUMED`；
- completed Attempt 并发重放与 failed Attempt 并发重放；
- 首次响应丢失后的完整 Worker 重试；
- 相同 Idempotency Key、不同正文仍拒绝；
- 伪造/跨 Binding Attempt 无法取得 completed 或 failed `canonical_result`；
- mismatch 先于 completed/failed 返回；
- expired、未知或终态缺少结果均 fail-closed；
- 兼容旧 Gateway 返回 consumed JSON 时，Worker 经 `attempt_resolve` 返回 canonical result。

## 4. P5 不变量与真实矩阵

F15–F18、F22–F24、F28、F29 原合同继续成立。验收使用临时本地原生 PostgreSQL 18.4，从空库顺序应用 13 份 Supabase Migration；没有 Mock、内存字典或 Policy 文本替代真实执行。

- 5 个用户、2 个 Tenant、3 个 Workspace、Owner/Editor/Reader/Denied、9 个独立可撤销 Binding；
- 跨 User/Tenant/Workspace/Binding/Target/正文的伪造和 mismatch；
- 同 Base Version CAS、同/异 Idempotency Key、rollback/commit failure、RLS 与撤权矩阵；
- 逐一验证 `anon`、`authenticated` 的 8 个 P5 RPC 均 permission denied，`service_role` 也无 P5 RPC EXECUTE；
- Supabase CLI security advisors 实际执行并 PASS，结果哈希写入冻结证据；
- `production_access=false`，未连接或访问生产。

## 5. 重新执行的门禁

| 门禁 | 结果 |
| --- | --- |
| P1 专项 | PASS，15/15 |
| P2 专项 | PASS，29/29 |
| P3 专项 | PASS，22/22 |
| P4 专项 | PASS，33/33 |
| Python 专项合计 | PASS，104/104 |
| P5 Cloud contracts | PASS，2/2 |
| P5 真实 PostgreSQL/RLS/并发/Worker | PASS，1 test，211/211 assertions，26 scenarios，13 migrations |
| Cloud verified build | PASS，Vite 8.2.2 / vinext build |
| Cloud 离线回归 | PASS，63/63；连同 P5 3 tests 为 66/66 |
| TypeScript typecheck | PASS |
| `memory.py doctor` | PASS，710 Manifest files，`snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155` |
| `sync-memory.py doctor` | PASS，local read-only mirror aligned |
| NONE/T0 | PASS，`Memory Access = NONE; skipping pull`；专项断言 `sources_read=[]`、`verification_context=null` |
| Supabase security advisors | PASS |
| Python compileall | PASS |
| `git diff --check` | PASS |
| 凭据扫描 | PASS，0 命中 |

P3 的最终专项运行使用普通 Git checkout，因为该专项显式检查 `.git/index`；产品修复仍在固定父提交的隔离 worktree 中完成。冻结黄金集在任务临时运行目录重建依赖视图后重跑：合同 19/19；回放 111 cases；corpus hash `1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`；replay hash `f4266eabd2bed94da36c5fa7d99fba17a3493418b849da3dfcfcee7e2842159c`；critical memory recall v2 `0.7763`；false recall rate v2 `0.3444`；stale、scope leakage、superseded leakage、no-memory violations、secret leaks 均为 `0`。

## 6. 冻结证据

| 文件 | Git Blob SHA | SHA-256 |
| --- | --- | --- |
| `binding_revocation_role_scope_evidence.jsonl` | `972bfde54bbbf161bc384d384e5835eff18eac01` | `a1f3567a5d8991c318f87c58646403762df9d66ca75cf7e296f70d018b2cf6c1` |
| `concurrent_cas_evidence.jsonl` | `1acb08340670dc1a0d797b08ea57b264b4cf7d7d` | `c2b3417ff29e12a4d5ab7ebc9aba14d0145782f53e9bcdfca8c9d983a2f71bf3` |
| `git_canonical_conflict_evidence.jsonl` | `be82e144c30fe631a2a3819646b8dbae9b814bf0` | `24407560290ae5f0e91bbadea4ed78b0fcd99ee5c223e860ac42043554491ec2` |
| `idempotency_retry_evidence.jsonl` | `368b71d1c91e3cc13be9839a93b918423737206a` | `4481f704f78e251ab2095fe7a093b3a195f59d572f9f33a6b78c36743a449acc` |
| `p5_raw_results.jsonl` | `df90f241ee6b66505892697363a112a5fb9852ff` | `ed2652712596fa5a671834a685d1ed29a389aab887f4d4d61db81ce7582c701d` |
| `supabase_advisors_evidence.jsonl` | `463f1b8ec19de64de5a432fa4ca7f77b04a280d0` | `27121e15d5a97787e620ad8a9620271a483aa07d0ea482916c2c4234b8f84383` |
| `tenant_workspace_rls_evidence.jsonl` | `dffe0365794c5127e41ebdcc008ac36dfc8c147b` | `dafaff61c147623a6add9b6db7a2e7558c6a9e42af6708748e7cfb3e9ccf5e0d` |
| `transaction_rollback_evidence.jsonl` | `02726f3b2226e23a785edd9a9444917a632ffa4a` | `2d0d22b1d486c7a8fce73bca5d32c06d404dea3390ae5ef158d9d8c97cdc41d5` |
| `worker_concurrent_attempt_replay_evidence.jsonl` | `6d70717499ddf2c508cb0ee2bb169f72cea2cf44` | `a26a576a85f53e0057c86d7859c2d2f2a5b08cca60178c333d89422364d9ebc7` |
| `SHA256SUMS` | `28215ea6bdea05b330d672eded3a7a21629b599d` | `c673059af3e37593e6b214bbc69ab6ea2f50992c9b79401fb5d0f286cc7acd9a` |

`SHA256SUMS` 覆盖全部 9 份 JSONL；其自身 Blob 与 SHA-256 单独列出。Advisors 与 Tenant/RLS 证据重新执行后字节未变化，故 Blob 与前一候选相同。

## 7. 本轮精确变更文件

修复提交只包含 13 个路径：

1. `apps/clued-cloud/supabase/migrations/20260827062132_p5_concurrent_attempt_replay.sql`
2. `apps/clued-cloud/worker/continuity.ts`
3. `apps/clued-cloud/tests/p5-cloud-contracts.test.mjs`
4. `apps/clued-cloud/tests/p5-real-postgres.test.mjs`
5. `artifacts/clued-validation/p5/8327b6b0/binding_revocation_role_scope_evidence.jsonl`
6. `artifacts/clued-validation/p5/8327b6b0/concurrent_cas_evidence.jsonl`
7. `artifacts/clued-validation/p5/8327b6b0/git_canonical_conflict_evidence.jsonl`
8. `artifacts/clued-validation/p5/8327b6b0/idempotency_retry_evidence.jsonl`
9. `artifacts/clued-validation/p5/8327b6b0/p5_raw_results.jsonl`
10. `artifacts/clued-validation/p5/8327b6b0/transaction_rollback_evidence.jsonl`
11. `artifacts/clued-validation/p5/8327b6b0/worker_concurrent_attempt_replay_evidence.jsonl`
12. `artifacts/clued-validation/p5/8327b6b0/SHA256SUMS`
13. `docs/clued-two-level-views/Clued_P5_多租户隔离与并发写_验收报告_v1.0.md`

未修改 P1–P4 实现/测试/原始证据、旧 P5 Migration、`worker/p5.ts`、`memory/`、Snapshot、Manifest、Current Pointer 或 `VERSION`。

## 8. sources_read

仓库来源：`AGENTS.md`、`apps/clued-cloud/AGENTS.md`、仓库 fallback `skills/clued-continuity/SKILL.md`（已安装 Skill catalog 未暴露该 Skill）、两级五视图架构与校验不变量文档、P4 Closeout、P5 Worker/测试/Migration、M1 runtime contracts、Cloud PostgreSQL foundation。

当前官方来源：

- Supabase Database Functions：`https://supabase.com/docs/guides/database/functions`
- Supabase Securing your API：`https://supabase.com/docs/guides/api/securing-your-api`
- Supabase Row Level Security：`https://supabase.com/docs/guides/database/postgres/row-level-security`
- Supabase Changelog：`https://supabase.com/changelog`
- PostgreSQL Row Security：`https://www.postgresql.org/docs/current/ddl-rowsecurity.html`
- PostgreSQL Transaction Isolation：`https://www.postgresql.org/docs/current/transaction-iso.html`
- Cloudflare Workers Best Practices：`https://developers.cloudflare.com/workers/best-practices/workers-best-practices/`
- Cloudflare Workers Secrets：`https://developers.cloudflare.com/workers/configuration/secrets/`

## 9. 最终裁决

第二轮阻断的并发 Attempt replay 回归已由数据库终态 canonical replay、mismatch-first 防泄露和 Worker 防御 resolve 三层修复；确定性真实并发屏障证明合法并发重试得到完全相同规范结果且只产生一次副作用。原 P5 安全收紧与 P1–P4 无回归。候选只可推送现有 P5 功能分支并等待第三轮独立复审，不得合并 `main`。

`PASS / P5_CONCURRENT_ATTEMPT_REPLAY_FIX_ACCEPTED_FOR_THIRD_INDEPENDENT_REVIEW`
