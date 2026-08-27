# Clued P5 多租户隔离与并发写验收报告 v1.0

本报告记录 P5 第三轮独立复审阻断项的普通线性修复、重新验收与第四轮独立复审候选事实。

最终裁决：

`PASS / P5_EXPIRED_ATTEMPT_REISSUE_FIX_ACCEPTED_FOR_FOURTH_INDEPENDENT_REVIEW`

## 1. 固定拓扑与边界

- 仓库：`tdoljyj/cross-memory-system`
- 固定 `main` / P4 Closeout：`8327b6b0429ce69aa95be05fc83bb0e4950625ea`
- P5 第三轮固定候选：`53baca6b2746993b1a7ac2fc116d506817fbb902`
- 本轮修复提交的唯一父提交：`53baca6b2746993b1a7ac2fc116d506817fbb902`
- 功能分支：`codex/p5-tenant-isolation-concurrent-writes`
- 证据目录：`artifacts/clued-validation/p5/8327b6b0/`

本轮只追加一个普通线性修复 Commit；不 amend、rebase、squash、force push，不移动或合并 `main`。未执行 P6、生产访问、部署、Tag、Release、Snapshot、Manifest、Current Pointer、根 `VERSION` 或语义召回变更。

## 2. 第三轮复审与根因

第三轮裁决：

`FAIL / P5_THIRD_INDEPENDENT_REVIEW_BLOCKED_BY_EXPIRED_OPEN_ATTEMPT_PERMANENT_LOCKOUT`

`clued_p5_gateway_attempts` 的唯一索引只覆盖 `status='open'`。Worker 若在 `attempt_begin` 后中断，旧 Attempt 到期时 status 仍永久为 open；后续相同请求的新 INSERT 被该行阻断，fallback SELECT 又只接受 `expires_at>now()`，最终持续返回 `P5_ATTEMPT_UNAVAILABLE`。该请求尚未产生业务副作用，却被永久锁死。

原过期测试只通过旧 Attempt ID 调用 mutate，未验证相同完整请求能否在到期后取得新 Attempt。

## 3. 修复合同

### 3.1 明确的 expired 生命周期

Migration `20260827072012_p5_expired_attempt_reissue.sql` 将 Attempt status CHECK 扩展为：

`open / completed / failed / expired`

过期 open Attempt 不删除，原子改为 `expired` 并继续保留审计历史。completed/failed 不因 TTL 被重写；它们的旧 Attempt ID 到期后失效，但永久业务结果仍由 Idempotency 记录保存。

### 3.2 attempt_begin 同事务重发

`clued_p5_attempt_begin` 采用固定顺序：

1. fresh-resolve 完整请求与 Binding；
2. 验证 Target、Base Version、Idempotency Key 并计算 Request Hash；
3. 精确匹配 Organization、Workspace、Binding、Operation、Idempotency Key、Request Hash，将 `status='open' AND expires_at<=now()` 原子改为 expired；
4. 若旧 Mutation 持有行锁，UPDATE 等待，PostgreSQL 在锁释放后对已提交行重新判断，不会把 completed/failed 改为 expired；
5. 等待后再次读取永久 Idempotency；若旧 Mutation 已完成，直接 replay，不创建新 Attempt；
6. 无永久结果时，用现有 partial unique index 与 `ON CONFLICT DO NOTHING` 创建或共享唯一新 open Attempt；两个同时重试者只能得到同一个新 ID。

终态 Attempt 缺少永久 Idempotency 结果被视为损坏并 fail-closed，绝不从 Attempt-local `canonical_result` 旁路释放或创建潜在重复写。

### 3.3 四个 Attempt RPC 的统一顺序

`attempt_begin`、`attempt_resolve`、`mutate`、`record_commit_failure` 均先验证完整请求与 Binding。带 Attempt ID 的三个 RPC 再逐项验证 Organization、Workspace、User、Binding、Request Hash、Idempotency Key、Target Kind/ID、Base Version，然后检查 expiry，最后处理 open/completed/failed/expired。

- mismatch 永远先于 expiry/status，不向伪造或跨 Binding 请求泄露结果；
- 旧 expired ID 的 mutate/resolve/commit-failure 均返回 `P5_ATTEMPT_EXPIRED`，且响应不含 `canonical_result`；
- 未到期的 completed/failed 精确重放保持兼容；
- 到期的 completed/failed 旧 ID fail-closed，但新的完整 `attempt_begin` 仍从 Idempotency replay 原规范结果；
- commit-failure 的失败类别校验在请求、expiry 与 status 之后，不得抢先旁路身份检查。

### 3.4 确定性并发证明

真实 PostgreSQL/Worker 回归新增三类确定性场景：

- 单一 expired open Attempt：完整重试取得不同的新 open ID，旧行明确为 expired，新 Attempt 完成 Mutation，Mutation/Event/Receipt/Idempotency 各一份；
- 两个真实 Worker 同时重试同一 expired open Attempt：双阶段屏障证明两者共享唯一新 Attempt，响应完全相同，不出现 `P5_ATTEMPT_UNAVAILABLE` 或重复副作用；
- 旧 Mutation 行锁跨越 expires_at：重试的 expiry UPDATE 明确等待；Mutation 提交后 completed 状态不被覆盖，等待者重查 Idempotency 并 replay，替代 Attempt 数为 0。

原第二轮并发 replay、mismatch-first、completed/failed canonical replay、首响应丢失、commit-failure 自动补记、跨 Binding/伪造 Attempt 防泄露、Gateway 最小权限与 8 RPC 撤权全部继续成立。

## 4. P5 真实矩阵

验收使用临时本地原生 PostgreSQL 18.4，从空库顺序应用 14 份 Supabase Migration；没有 Mock、内存字典或 Policy 文本替代数据库执行。

- 5 个用户、2 个 Tenant、3 个 Workspace、Owner/Editor/Reader/Denied、10 个独立可撤销 Binding；
- F15–F18、F22–F24、F28、F29 与第三轮新增 expired/terminal TTL/行锁场景；
- 跨 User/Tenant/Workspace/Binding/Target/正文的伪造和 mismatch；
- 同 Base Version CAS、同/异 Idempotency Key、rollback/commit failure、真实 RLS 与撤权矩阵；
- `anon`、`authenticated` 的 8 个 P5 RPC 均 permission denied，`service_role` 也无 P5 RPC EXECUTE；
- `clued_p5_gateway` 仅有 public RPC EXECUTE，无 Attempt 表权限、private core 权限、LOGIN、INHERIT 或 BYPASSRLS；
- Supabase CLI security advisors 实际执行并 PASS；
- `production_access=false`，未连接或访问生产。

## 5. 重新执行的门禁

| 门禁 | 结果 |
| --- | --- |
| P1 专项 | PASS，15/15 |
| P2 专项 | PASS，29/29 |
| P3 专项 | PASS，22/22 |
| P4 专项 | PASS，33/33 |
| v1.6 root cutover | PASS，5/5 |
| Python 专项合计 | PASS，104/104 |
| P5 Cloud contracts | PASS，2/2 |
| P5 真实 PostgreSQL/RLS/并发/Worker | PASS，1 test，260 assertions，31 scenarios，14 migrations |
| Cloud verified build | PASS，Vite 8.2.2 / vinext build |
| Cloud 全量离线回归 | PASS，66/66 |
| TypeScript typecheck | PASS |
| `memory.py doctor` | PASS，710 Manifest files，`snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155` |
| `sync-memory.py doctor` | PASS，local read-only mirror aligned |
| NONE/T0 | PASS，`Memory Access = NONE; skipping pull`；专项断言 `sources_read=[]`、`verification_context=null` |
| Supabase security advisors | PASS |
| 冻结黄金集合同 | PASS，19/19 |
| 冻结回放 | PASS，111 cases，secret leaks=0 |
| Python compileall | PASS |
| `git diff --check` | PASS |
| 凭据扫描 | PASS，0 命中 |

冻结黄金集在任务临时运行目录重建 `memory/` 与 `guards.json` 依赖视图后重跑：corpus hash `1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`；replay hash `f4266eabd2bed94da36c5fa7d99fba17a3493418b849da3dfcfcee7e2842159c`；critical memory recall v2 `0.7763`；false recall rate v2 `0.3444`；stale、scope leakage、superseded leakage、no-memory violations、secret leaks 均为 `0`。

Windows 环境记录：首次 Cloud build 因系统 `bash.exe` 指向未安装 WSL 而未启动构建，随后使用已安装 Git Bash 运行同一 `scripts/build-verified.sh` 并 PASS；P4 首次运行遇到子进程编码解码错误，显式 `PYTHONUTF8=1 / PYTHONIOENCODING=utf-8` 后 33/33 PASS。两项均为入口环境问题，不是产品测试失败。

## 6. 冻结证据

| 文件 | Git Blob SHA | SHA-256 |
| --- | --- | --- |
| `binding_revocation_role_scope_evidence.jsonl` | `88595a8b082b52d5c7c802447738a942d521ad3f` | `04a459d35c79b41be4d1b2b0f2a6f64268a625e32c82939b0ee46202ab107b60` |
| `concurrent_cas_evidence.jsonl` | `14372e950c29da9c202bb3c4d304ee39f91c9755` | `4a8038cd05c6e290f96f30661ab0957f6009814b5a651db2771f5c30e8cd05bd` |
| `expired_attempt_reissue_evidence.jsonl` | `0bb51ea13e13f14bc7c16d1674f6c6a8c858710a` | `029976d825e0dcf03e44bb68f15e42bb742efcb6bcea54125a7895b471f01b57` |
| `git_canonical_conflict_evidence.jsonl` | `1426cace8674793dae4f4a82fdf4e52d4719cd96` | `7056acc3a7ab739be48fc259af1bfe42304d65b267125610b13fa9841ee7f678` |
| `idempotency_retry_evidence.jsonl` | `699ba84f23b3c4ed4cf00385e3dbd6b9ced6fb11` | `c69348e0386f8ac74a1a62118126ec6059047ff633e44e472469c325351b8b53` |
| `p5_raw_results.jsonl` | `edb4200ec80cbe9ef05357c6bdb604012a3c2bac` | `81ce007c6cc4b18f6a1a36c69dce87adb7a3d78f241f5f597a7d4cf13edc071a` |
| `supabase_advisors_evidence.jsonl` | `463f1b8ec19de64de5a432fa4ca7f77b04a280d0` | `27121e15d5a97787e620ad8a9620271a483aa07d0ea482916c2c4234b8f84383` |
| `tenant_workspace_rls_evidence.jsonl` | `dffe0365794c5127e41ebdcc008ac36dfc8c147b` | `dafaff61c147623a6add9b6db7a2e7558c6a9e42af6708748e7cfb3e9ccf5e0d` |
| `transaction_rollback_evidence.jsonl` | `f2c6bb15130f15a22e72e46b920f336839a61cb1` | `df95f643fcd70141c62c33b9768e9347e67bae7e89e570ab4eead36b6123d90b` |
| `worker_concurrent_attempt_replay_evidence.jsonl` | `74f238e23abab9e2581149ebf87d38cb1a87ba7e` | `333584de558267f7ef570b2a720c9a37a7a493e8854acbfbd72c7c43a99f98eb` |
| `SHA256SUMS` | `1720a94ad65d3a4fd3c18f130d083667ad2caba2` | `501b43748e7364b2d0686cd79ab292895a2dca136b29073414cf605c7fce06ab` |

`SHA256SUMS` 覆盖全部 10 份 JSONL；其自身 Blob 与 SHA-256 单独列出。Advisors 与 Tenant/RLS 证据重新执行后字节未变化，其 Blob/SHA 因此与固定候选相同。

## 7. 本轮精确变更文件

修复提交只包含 13 个路径：

1. `apps/clued-cloud/supabase/migrations/20260827072012_p5_expired_attempt_reissue.sql`
2. `apps/clued-cloud/tests/p5-cloud-contracts.test.mjs`
3. `apps/clued-cloud/tests/p5-real-postgres.test.mjs`
4. `artifacts/clued-validation/p5/8327b6b0/binding_revocation_role_scope_evidence.jsonl`
5. `artifacts/clued-validation/p5/8327b6b0/concurrent_cas_evidence.jsonl`
6. `artifacts/clued-validation/p5/8327b6b0/expired_attempt_reissue_evidence.jsonl`
7. `artifacts/clued-validation/p5/8327b6b0/git_canonical_conflict_evidence.jsonl`
8. `artifacts/clued-validation/p5/8327b6b0/idempotency_retry_evidence.jsonl`
9. `artifacts/clued-validation/p5/8327b6b0/p5_raw_results.jsonl`
10. `artifacts/clued-validation/p5/8327b6b0/transaction_rollback_evidence.jsonl`
11. `artifacts/clued-validation/p5/8327b6b0/worker_concurrent_attempt_replay_evidence.jsonl`
12. `artifacts/clued-validation/p5/8327b6b0/SHA256SUMS`
13. `docs/clued-two-level-views/Clued_P5_多租户隔离与并发写_验收报告_v1.0.md`

未修改 P1–P4 实现/测试/原始证据、既有 P5 Migration、`worker/continuity.ts`、`worker/p5.ts`、`memory/`、Snapshot、Manifest、Current Pointer 或 `VERSION`。

## 8. sources_read

仓库来源：`AGENTS.md`、`apps/clued-cloud/AGENTS.md`、仓库 fallback `skills/clued-continuity/SKILL.md`（已安装 Skill catalog 未暴露该 Skill）、两级五视图架构与校验不变量文档、P4 Closeout、三份既有 P5 Migration、P5 Worker/测试、M1 runtime contracts、Cloud PostgreSQL foundation。

当前官方来源：

- Supabase Changelog：`https://supabase.com/changelog`
- Supabase Database Functions：`https://supabase.com/docs/guides/database/functions`
- Supabase Securing your API：`https://supabase.com/docs/guides/api/securing-your-api`
- PostgreSQL Explicit Locking：`https://www.postgresql.org/docs/current/explicit-locking.html`
- PostgreSQL Transaction Isolation：`https://www.postgresql.org/docs/current/transaction-iso.html`
- Cloudflare Workers Best Practices：`https://developers.cloudflare.com/workers/best-practices/workers-best-practices/`
- 最新 Workers types：`@cloudflare/workers-types@5.20260827.1`

## 9. 最终裁决

第三轮阻断的 expired open Attempt 永久锁死已由显式生命周期、原子过期、行锁后 Idempotency 重判和唯一新 Attempt 重发闭环修复。真实 PostgreSQL 与双 Worker 屏障证明合法完整重试可恢复、旧 ID fail-closed、终态永久幂等结果不丢失、并发无重复副作用。原 P5 安全收紧与 P1–P4 无回归。

候选只可推送现有 P5 功能分支并等待第四轮独立复审，不得合并 `main`。

`PASS / P5_EXPIRED_ATTEMPT_REISSUE_FIX_ACCEPTED_FOR_FOURTH_INDEPENDENT_REVIEW`
