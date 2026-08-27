# Clued P5 多租户隔离与并发写验收报告 v1.1

本报告记录 P5 第四轮独立复审阻断项的普通线性修复、全量回归与第五轮独立复审候选事实。

实施方裁决：

`PASS / P5_ATTEMPT_REISSUE_LINEARIZATION_READY_FOR_FIFTH_INDEPENDENT_REVIEW`

该裁决仅表示修复候选与证据已就绪，不替代第五轮独立复审。

## 1. 固定拓扑与边界

- 仓库：`tdoljyj/cross-memory-system`
- 固定 `main` / P4 Closeout：`8327b6b0429ce69aa95be05fc83bb0e4950625ea`
- P5 第四轮固定候选：`5f242e89aabcbf0700eb03a5d298d2b026f2f8fc`
- 本轮唯一父提交：`5f242e89aabcbf0700eb03a5d298d2b026f2f8fc`
- 功能分支：`codex/p5-tenant-isolation-concurrent-writes`
- 证据目录：`artifacts/clued-validation/p5/8327b6b0/`

本轮只追加一个普通线性修复 Commit；不 amend、rebase、squash、force push，不移动或合并 `main`。未执行 P6、生产访问、部署、Tag、Release、Snapshot、Manifest、Current Pointer、根 `VERSION` 或语义召回变更。最终 Commit、Tree 与本报告 Blob/SHA 在提交后回执中记录，以避免自引用循环。

## 2. 第四轮复审阻断与根因

第四轮裁决：

`FAIL / P5_FOURTH_INDEPENDENT_REVIEW_BLOCKED_BY_ATTEMPT_REISSUE_LINEARIZATION_GAP`

旧实现第二次读取 Idempotency 后才 INSERT replacement Attempt；唯一索引只覆盖 `status='open'`。因此 B 可在最后一次读取后暂停，A 创建同一 successor 并完成 Mutation，A 的 Attempt 退出 partial unique index 后，B 的 INSERT 不再冲突并创建第二个 open capability。

现有双 Worker 屏障先等待两个 `attempt_begin` 都结束再 mutate，无法覆盖该交错。

## 3. 线性修复合同

### 3.1 永久 successor issuance slot

新增 additive Migration `20260827084500_p5_attempt_reissue_linearization.sql`：

- Attempt 增加非空 `issuance_parent`；新 lineage 的首个 Attempt 使用 `root`，replacement 使用其直接 predecessor Attempt ID；
- 新增永久唯一索引 `(organization_id, workspace_id, binding_id, operation_family, idempotency_key, issuance_parent)`；
- 索引不含 `WHERE status='open'`，因此 successor 从 open 变为 completed、failed 或 expired 后仍永久占用 predecessor 的唯一签发槽；
- 既有 Attempt 以 `legacy:<attempt-id>` 无歧义回填；迁移后下一次 replacement 从最新 Attempt ID 进入永久 lineage，不改写历史状态。

该约束把 INSERT 本身变为数据库线性化点。若 B 在最后一次 Idempotency 读取后暂停，而 A 已完成并提交，B 恢复 INSERT 仍会与 A 的永久 issuance slot 冲突。冲突分支只复用 winner 或读取已形成的永久 canonical result，不会创建新 capability；因此不是“INSERT 后补查”式窗口修补。

### 3.2 跨函数共享

`attempt_begin` 签发的每个 Attempt 都携带不可变 issuance slot；`mutate` 与 `record_commit_failure` 消费并更新的正是该 Attempt 行。终态转换不释放唯一槽，三个函数因此共享同一个跨生命周期数据库约束：

- committed：winner Attempt 保持唯一，B replay 同一 committed `canonical_result`；
- failed：deferred commit failure 回滚后由 Worker 自动调用 `attempt_resolve` 与 `record_commit_failure`，winner Attempt 保持唯一，B replay 同一 failed `canonical_result`；
- open successor 再次自然过期：其 ID 成为下一代唯一 `issuance_parent`，每代最多一个 successor；
- 永久 Idempotency 已形成：同正文 retry 直接 replay，不增加 Attempt；不同正文返回 `IDEMPOTENCY_PAYLOAD_CONFLICT`，不增加 capability；不同 Binding 使用独立 lineage。

请求与 Binding 的 fresh resolve、mismatch-first、旧 ID expiry fail-closed、Attempt-local 结果不泄露、Gateway-only EXECUTE 与 RLS/撤权边界均保持不变。

## 4. 确定性真实数据库交错

测试使用两个真实 Worker 调用、两个独立 Continuity Session、独立 PostgreSQL 连接和数据库内暂停点。暂停点仅在既有 `clued.p5_test_faults=on` 测试门启用时生效，位置精确位于 `attempt_begin` 最后一次 Idempotency 读取完成后、replacement INSERT 执行前。

固定顺序：

1. B 完成最后一次 Idempotency 重查并等待事务级测试锁；
2. A 执行 `attempt_begin → mutate`，完成 committed 或 deferred-commit failure 自动补记并提交；
3. 测试确认 B 在 A 提交期间仍停在 INSERT 前；
4. 释放 B；B 的 INSERT 命中永久 issuance slot，随后返回 A 的 exact canonical result；
5. 每个 race 最终为 1 个 expired predecessor + 1 个 terminal successor、0 个 open Attempt、1 个 non-expired successor。

committed 终态为 Mutation/Event/Receipt/Idempotency 各一份；failed 终态为 Mutation/Event 各零份、failed Receipt/Idempotency 各一份。两种终态的 Worker A/B 响应逐对象完全相同。另行覆盖相同正文重试、不同正文、跨 Binding、以及 replacement 自然过期后的第三代重发。

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
| P5 真实 PostgreSQL/RLS/并发/Worker | PASS，1 test，292 assertions，36 scenarios，15 migrations |
| Cloud verified build | PASS，Vite 8.2.2 / vinext build |
| Cloud 全量离线回归 | PASS，66/66 |
| TypeScript typecheck | PASS |
| ESLint | PASS，0 error；2 个既有 warning |
| 请求级 AlignAndVerify | PASS，`snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155`；内含 mirror + doctor |
| NONE/T0 | PASS，`sources_read=[]`、`verification_context=null` |
| Supabase security advisors | PASS |
| 冻结评测合同 | PASS，19/19 |
| Recall trace 合同 | PASS，19/19 |
| 冻结回放 | PASS，111 cases，secret leaks=0 |
| Python compileall | PASS |
| `SHA256SUMS` 逐项重算 | PASS |

冻结回放保持：corpus hash `1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`；replay hash `f4266eabd2bed94da36c5fa7d99fba17a3493418b849da3dfcfcee7e2842159c`；critical memory recall v2 `0.7763`；false recall rate v2 `0.3444`；stale、scope leakage、superseded leakage、no-memory violations、secret leaks 均为 `0`。

## 6. 冻结证据

| 文件 | Git Blob SHA | SHA-256 |
| --- | --- | --- |
| `attempt_reissue_linearization_evidence.jsonl` | `e4e3ca2674c9eae0482ebee49188f6e4abc21a44` | `febb0b414d387303cbb0dc08ad6b5f4e25e36a3a10d1e3fc8955d06cdcec3ac1` |
| `binding_revocation_role_scope_evidence.jsonl` | `33bf1c40ad97772fd9976ac83aaf837bf8c07194` | `173716bed5d3e974ff454c9b84ec695693469f4855cc06a39a6eeebea7b10d57` |
| `concurrent_cas_evidence.jsonl` | `602e0d0210e2de4886ac57c9924b6810481a6f87` | `228cf301a1e668f5fc6fd68b94f612ff1816bcdcfcf42001387518d70ba5ac7d` |
| `expired_attempt_reissue_evidence.jsonl` | `fd0344069ca49407b2f072271b74be511b53f653` | `32bf4f81b1d07c60203a7b1909a1ac38a7d85b7e06419577024bbdee24fd68de` |
| `git_canonical_conflict_evidence.jsonl` | `8351bc754369058794fd116e90c2924984a17e9d` | `6730b39c9db04f671bf3dec9c90ed20718cf5fe47b61c3697b6e4facc1487f27` |
| `idempotency_retry_evidence.jsonl` | `6b8fd929b21fbf01e7ee380e4f24c947965076bb` | `06cac222dcf945a229e2077bf634f9540af1afbef057c3d37838473571957b5f` |
| `p5_raw_results.jsonl` | `5a048919b530249a5851f02e109466dbb80cb2b1` | `4e84a279ae77cb79cc8acea6fea7499e67d386014c23319f32f35a1f57cea8bd` |
| `supabase_advisors_evidence.jsonl` | `463f1b8ec19de64de5a432fa4ca7f77b04a280d0` | `27121e15d5a97787e620ad8a9620271a483aa07d0ea482916c2c4234b8f84383` |
| `tenant_workspace_rls_evidence.jsonl` | `dffe0365794c5127e41ebdcc008ac36dfc8c147b` | `dafaff61c147623a6add9b6db7a2e7558c6a9e42af6708748e7cfb3e9ccf5e0d` |
| `transaction_rollback_evidence.jsonl` | `97cad7f1b30a9f750d469b78d1b8b1070bd66d0f` | `fb20ca6afc40f8df1f31b2f6276fd0b7ccbca34ac5b3a29b1a6e293579689b37` |
| `worker_concurrent_attempt_replay_evidence.jsonl` | `68e068d14b66412125c03d9994c49de5305763f1` | `75d3d90a5467e3e6daf45d3f2b8f99f1099658ccc6a0293b3b0d41f995db5cca` |
| `SHA256SUMS` | `9043e0db89c2e72d0046cd962a4a1f76c79e62cb` | `3ff32caf7364d71808547846396edde3709e9a311e50d044e4321c93fb2b2b6a` |

`SHA256SUMS` 覆盖全部 11 份 JSONL；自身 Blob 与 SHA-256 单独列出。证据不包含 Binding raw token、Session token、数据库密码或生产凭据。

## 7. 本轮精确变更范围

本轮新增/修改 14 个路径：

1. `apps/clued-cloud/supabase/migrations/20260827084500_p5_attempt_reissue_linearization.sql`
2. `apps/clued-cloud/tests/p5-cloud-contracts.test.mjs`
3. `apps/clued-cloud/tests/p5-real-postgres.test.mjs`
4. `artifacts/clued-validation/p5/8327b6b0/attempt_reissue_linearization_evidence.jsonl`
5. `artifacts/clued-validation/p5/8327b6b0/binding_revocation_role_scope_evidence.jsonl`
6. `artifacts/clued-validation/p5/8327b6b0/concurrent_cas_evidence.jsonl`
7. `artifacts/clued-validation/p5/8327b6b0/expired_attempt_reissue_evidence.jsonl`
8. `artifacts/clued-validation/p5/8327b6b0/git_canonical_conflict_evidence.jsonl`
9. `artifacts/clued-validation/p5/8327b6b0/idempotency_retry_evidence.jsonl`
10. `artifacts/clued-validation/p5/8327b6b0/p5_raw_results.jsonl`
11. `artifacts/clued-validation/p5/8327b6b0/transaction_rollback_evidence.jsonl`
12. `artifacts/clued-validation/p5/8327b6b0/worker_concurrent_attempt_replay_evidence.jsonl`
13. `artifacts/clued-validation/p5/8327b6b0/SHA256SUMS`
14. `docs/clued-two-level-views/Clued_P5_多租户隔离与并发写_验收报告_v1.1.md`

未修改既有 P5 Migration、P1–P4 实现/测试/原始证据、`worker/continuity.ts`、`worker/p5.ts`、`memory/`、Snapshot、Manifest、Current Pointer 或 `VERSION`。

## 8. sources_read

- `AGENTS.md`
- `apps/clued-cloud/AGENTS.md`
- `skills/clued-continuity/SKILL.md`（安装目录未暴露，按仓库 fallback 使用）
- `memory/global/{state,task,decision}.md`
- Clued 相关 Project State/Task/Decision 的 T2 召回结果
- `docs/clued-two-level-views/Clued_校验不变量与去重矩阵_v1.1.md`
- `docs/clued-two-level-views/Clued_单一数据源与两级五视图架构方案_v1.6.md`
- P5 四份既有 Migration、Worker continuity 实现、P5 contracts 与真实 PostgreSQL 测试
- P5 v1.0 验收报告及固定候选证据

## 9. 最终边界

第四轮指出的 recheck/INSERT 线性化窗口已由跨状态永久 issuance slot 闭合，并由 committed/failed 两类精确真实数据库交错证明。候选只可推送现有 P5 功能分支并等待第五轮独立复审；不得合并 `main`，不得执行 P6。

`PASS / P5_ATTEMPT_REISSUE_LINEARIZATION_READY_FOR_FIFTH_INDEPENDENT_REVIEW`
