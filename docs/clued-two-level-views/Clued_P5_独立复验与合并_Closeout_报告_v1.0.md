# Clued P5 独立复验与合并 Closeout 报告 v1.0

## 1. Closeout 裁决与固定边界

`PASS / P5_CLOSEOUT_ACCEPTED`

本报告只对 P5 多租户隔离与并发写的五轮独立复审、四次普通线性修复、最终候选、fast-forward-only 合并及 Closeout 前独立复验进行不可变封存。P5 已完成仓库实现、验证与合并；P6、生产访问、部署、数据库交付变更、Tag、Release、Snapshot/Manifest/Current Pointer/VERSION 修改和语义召回启用均不在本轮授权范围。

固定事实：

- P4 Closeout / P5 固定基线：`8327b6b0429ce69aa95be05fc83bb0e4950625ea`
- P5 最终候选及 Closeout 前远端 `main`：`9a5c55f5b63721aa29fd7754d0790ab5ff0995d7`
- 最终候选唯一父提交：`5f242e89aabcbf0700eb03a5d298d2b026f2f8fc`
- 最终候选 Tree：`89504916d28feb6809768f48d2df310244f871b2`
- 功能分支：`codex/p5-tenant-isolation-concurrent-writes`
- P5 合并方式：`git merge --ff-only`
- 合并裁决：`PASS / P5_FF_MERGE_COMPLETED`

本报告的普通线性 Closeout Commit 必须以 `9a5c55f5b63721aa29fd7754d0790ab5ff0995d7` 为唯一父提交，且 Commit diff 只能新增本报告。Closeout Commit、报告 Blob 与报告 SHA-256 由提交后回执记录，避免报告自引用。

## 2. 完整五 Commit 线性链

完整 P5 提交链：

`8327b6b0429ce69aa95be05fc83bb0e4950625ea`

→ `5aa069b5f594789bf564af67ebfaf1f6b67c332c`
`P5 tenant isolation and concurrent writes [Codex@TURING]`

→ `8fef81a32a761d89c196095c2fe758b33f9e4da6`
`P5 secure gateway and commit failure closure [Codex@TURING]`

→ `53baca6b2746993b1a7ac2fc116d506817fbb902`
`P5 fix concurrent attempt replay [Codex@TURING]`

→ `5f242e89aabcbf0700eb03a5d298d2b026f2f8fc`
`P5 fix expired Attempt reissue [Codex@DESK-W-591]: migration tests evidence report`

→ `9a5c55f5b63721aa29fd7754d0790ab5ff0995d7`
`P5 fix Attempt reissue linearization [Codex@TURING]`

五条 P5 Commit 均为单父普通 Commit；第一条的唯一父提交为固定基线，后续每条的唯一父提交均为链中前一条。相对固定基线，最终候选 ahead 5、behind 0，P5 范围内 merge commit 数为 0。累计变更统计为 25 files changed、4516 insertions、18 deletions。

## 3. P5 正式范围 F15–F18、F22–F24、F28、F29

- F15：两个独立写方使用同一 Base Version 真实并发；仅一方提交，另一方返回带 expected/actual version 的 `CANONICAL_CAS_CONFLICT`，Canonical Version 只增加一次。
- F16：同 Idempotency Key、同正文的串行、并发、首响应丢失与终态重试返回同一 canonical result，不重复 Mutation、Event、Receipt 或 Idempotency。
- F17：同 Idempotency Key、不同正文返回 `IDEMPOTENCY_PAYLOAD_CONFLICT`，拒绝且审计，不泄露已提交 canonical result，不增加写能力。
- F18：Mutation、Event、Receipt、Audit、CAS、幂等唯一约束或真实 deferred commit failure 任一提交点失败时，业务 Mutation 原子回滚；可信失败结果由独立 failed Receipt/Idempotency 封存并确定性重放。
- F22：Binding 撤销、Role 降权、Scope 缩小、Policy/Revocation Epoch 变化后，下一次在线请求必须 fresh resolve 并立即拒绝；Session 缓存不得延长权限。
- F23：Workspace 切换使原 Context 立即失效；新 Workspace 只有在 Organization、Workspace、Context、Role、Scope、Purpose 与 Policy 全部重新授权后才可写。
- F24：跨 User、Tenant/Organization、Workspace、Project/Record ID 的伪造同时被服务层授权和真实 PostgreSQL RLS 独立拒绝并审计。
- F28：`GIT_DIVERGENCE` 与 `CANONICAL_CAS_CONFLICT` 使用不同错误类型和证据域；二者均不得自动 merge、覆盖或伪装成另一类冲突。
- F29：Canonical Mutation 是唯一业务写；退休 Markdown/Git 写入口 fail closed，Git、`memory/`、Bundle、Index、Snapshot 保持不变，离线只产生 Pending Intent。

## 4. 五轮独立复审裁决

1. 第一轮：`FAIL / P5_INDEPENDENT_REVIEW_BLOCKED_BY_ANON_RPC_GATE_BYPASS_AND_FORGEABLE_COMMIT_FAILURE`
2. 第二轮：`FAIL / P5_SECOND_INDEPENDENT_REVIEW_BLOCKED_BY_CONCURRENT_ATTEMPT_REPLAY_REGRESSION`
3. 第三轮：`FAIL / P5_THIRD_INDEPENDENT_REVIEW_BLOCKED_BY_EXPIRED_OPEN_ATTEMPT_PERMANENT_LOCKOUT`
4. 第四轮：`FAIL / P5_FOURTH_INDEPENDENT_REVIEW_BLOCKED_BY_ATTEMPT_REISSUE_LINEARIZATION_GAP`
5. 第五轮：`PASS / P5_FIFTH_INDEPENDENT_REVIEW_ACCEPTED_FOR_FF_MERGE`

前四轮的 FAIL 均被保留为历史事实，没有被最终 PASS 擦除。每次修复都通过新增普通单父 Commit 前进，没有 amend、rebase、squash、force push、merge commit 或历史重写。

## 5. 四个阻断问题、修复 Commit 与关闭证据

### 5.1 匿名 RPC 绕过与可伪造 commit-failure

根因：第一候选把 public `SECURITY DEFINER` P5 RPC 直接授予 `anon`；持有 Binding Token 的调用者可绕过 Worker 的功能门、Binding-only 路由、Schema/大小校验与未来启停边界。旧 `clued_p5_record_commit_failure` 还接受调用者提供的任意错误，测试依赖夹具手工补记，无法证明真实 Worker 自动闭环，且允许伪造失败污染 Idempotency Key。

修复 Commit：`8fef81a32a761d89c196095c2fe758b33f9e4da6`。

关闭方式与证据：

- 从 `PUBLIC`、`anon`、`authenticated`、`service_role` 撤销全部 8 个 public P5 RPC 的直接 `EXECUTE`；
- 建立 `NOLOGIN`、`NOINHERIT`、`NOBYPASSRLS`、非超级用户的最小权限 `clued_p5_gateway`，仅允许 Worker 经服务端 Gateway JWT 调用 public P5 RPC；
- Gateway 无 Attempt 表权限、无 private mutation core 权限；Binding raw token、Gateway token、数据库密码不进入代码、证据或日志；
- Attempt 由服务端签发，并不可伪造地关联 Organization、Workspace、User、Binding、Request Hash、Idempotency Key、Target 与 Base Version；这里的 Correlation 是受保护的关联合同，不是调用者可自填的可信事实；
- 真实 deferred commit failure 由 Worker 捕获，经 `attempt_resolve → record_commit_failure` 在新事务自动补记；原 Mutation/Event/成功 Receipt 全回滚，失败 Receipt/Idempotency 只产生一份；
- `binding_revocation_role_scope_evidence.jsonl`、`transaction_rollback_evidence.jsonl`、`supabase_advisors_evidence.jsonl` 与 `p5_raw_results.jsonl` 封存 Gateway-only、撤权、不可伪造 Attempt/Correlation 和自动补记结果。

### 5.2 合法双 Worker 并发 Attempt replay 回归

根因：两个相同 Worker 请求可共享同一个 open Attempt。第一方完成后，第二方收到包装为 HTTP 成功 JSON 的 `P5_ATTEMPT_ALREADY_CONSUMED`；Worker 只在 transport exception 时 resolve，因而没有返回第一方保存的 canonical result。虽然没有重复副作用，但违反 F16 的“合法重试结果完全相同”。

修复 Commit：`53baca6b2746993b1a7ac2fc116d506817fbb902`。

关闭方式与证据：

- `clued_p5_mutate` 对 Attempt `FOR UPDATE`，先做 Organization/Workspace/User/Binding/Request Hash/Idempotency/Target/Base Version mismatch-first 校验，再对 completed/failed 返回已保存 canonical result；
- Worker 同时处理 transport exception 与包装的终态竞态结果，并只在 exact match、terminal status 和对象型 canonical result 完整时 resolve；
- completed、failed、首响应丢失、同正文、异正文、伪造 Attempt、跨 Binding、缺失结果与未知状态全部有 fail-closed 或 exact replay 结果；
- `worker_concurrent_attempt_replay_evidence.jsonl` 证明两个真实 Worker 共享同一 open Attempt、响应完全相同、只产生一次副作用，mismatch 先于终态结果且不泄露。

### 5.3 expired open Attempt 永久锁死

根因：Attempt 唯一索引只覆盖 `status='open'`，但 Worker 在 `attempt_begin` 后中断时，过期行仍永久为 open；相同完整请求的新 INSERT 被阻断，fallback SELECT 又只接受未过期行，造成未产生业务副作用的请求永久返回 `P5_ATTEMPT_UNAVAILABLE`。

修复 Commit：`5f242e89aabcbf0700eb03a5d298d2b026f2f8fc`。

关闭方式与证据：

- 引入显式 `expired` 生命周期；过期 open Attempt 原子变为 expired 并保留审计历史；
- `attempt_begin` 先 fresh resolve、mismatch/hash 校验和过期转换，再重查永久 Idempotency，最后才签发或共享唯一 replacement Attempt；
- 行锁跨过 expires_at 时，等待方在锁释放后重新判断，completed/failed 不被错误改写；
- 旧 expired ID 的 mutate/resolve/commit-failure 均 fail closed 且不泄露 Attempt-local result；完整合法请求可取得新 Attempt，终态结果仍从永久 Idempotency replay；
- `expired_attempt_reissue_evidence.jsonl` 证明单 Worker、双 Worker、行锁交错、completed/failed TTL、旧 ID 失效与完整请求恢复全部闭环。

### 5.4 Attempt successor 重发线性化窗口

根因：旧实现最后一次 Idempotency 重查与 replacement INSERT 之间仍有窗口，且唯一索引只覆盖 open。B 可在最后重查后暂停，A 创建并完成 successor；A 退出 partial unique index 后，B 再 INSERT 第二个 open capability。

修复 Commit：`9a5c55f5b63721aa29fd7754d0790ab5ff0995d7`。

关闭方式与证据：

- 每个 Attempt 增加不可变 `issuance_parent`；首代为 `root`，replacement 指向直接 predecessor；
- 永久唯一槽固定为 `(organization_id, workspace_id, binding_id, operation_family, idempotency_key, issuance_parent)`，不带 `status='open'` 条件；
- successor 转为 completed、failed 或 expired 后仍永久占用 predecessor 的唯一签发槽，INSERT 本身成为数据库线性化点；
- `attempt_begin`、`mutate`、`record_commit_failure` 共享同一跨生命周期约束，冲突分支只复用 winner 或永久 canonical result，不再签发第二能力；
- `attempt_reissue_linearization_evidence.jsonl` 证明 committed/failed 两类精确交错、异正文、跨 Binding 和 successor 再过期后的下一代重发全部关闭。

## 6. Tenant/Workspace/RLS 与在线授权边界

P5 的隔离不是单层字符串检查，而是完整的双层纵深防御：

- Worker/服务层每次在线请求 fresh resolve User、Organization/Tenant、Workspace、Context Key、Binding、Role、Scope、Purpose、Policy Version、Expiry 与 Revocation Epoch；
- PostgreSQL RLS 独立约束 Organization、Workspace、Project/Record、Actor 与 Binding 可见性和写权限；
- F24 分别证明服务层拒绝与直接数据库 RLS 拒绝，两层任一失败均不能读取或写入其他租户数据；
- F22/F23 证明撤权、降权、Scope 缩小、Policy 变化与 Workspace 切换在下一在线请求即时生效，Session 缓存、旧 Context 或旧 Attempt 不得续权；
- Owner、Editor、Reader、Denied 与 user/agent_binding/service_account/automation Actor 分别受 Role、Scope 与审计合同约束。

## 7. CAS、幂等、事务原子性与 Attempt 终态

- CAS：两个独立连接同 Base Version 并发时恰好一个 committed、一个 canonical conflict，最终版本只加一，winner Event/Receipt 只一组。
- 幂等：同 Key 同正文的串行、并发、网络丢失和终态重试 exact replay；同 Key 异正文拒绝且不增加 Attempt；不同 Binding 使用隔离 lineage，不泄露或复用对方能力。
- 原子性：Mutation、Event、Receipt、Audit 和 Idempotency 在权威事务中保持原子；提交失败时 Mutation/Event 为 0，failed Receipt/Idempotency 各 1。
- committed 精确交错：B 在最终 Idempotency 重查后、replacement INSERT 前暂停；A 完成并提交；B 恢复后命中永久 issuance slot并返回 A 的同一 committed result。最终为 1 个 expired predecessor、1 个 completed successor、0 个 open Attempt，Mutation/Event/Receipt/Idempotency 各 1。
- failed 精确交错：相同暂停点下 A 发生真实 deferred commit failure 并由 Worker 自动补记；B 返回同一 failed result。最终为 1 个 expired predecessor、1 个 failed successor、0 个 open Attempt，Mutation/Event 各 0，failed Receipt/Idempotency 各 1。
- successor 再过期：replacement 自然过期后，以其 ID 作为下一代 `issuance_parent`；每代最多一个 successor。最终 lineage 为 expired → expired → completed，完整重试从永久 Idempotency replay，业务副作用仍只有一份。

## 8. Closeout 前独立复验与最终冻结结果

Closeout 前在固定候选上重新执行并通过：

| 门禁 | 结果 |
| --- | --- |
| 请求级 `AlignAndVerify -Access PROJECT` | PASS，`snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155`，local/remote 均为最终候选，内含 mirror + doctor |
| P1 专项 | PASS，15/15 |
| P2 专项与文档契约 | PASS，29/29 |
| P3 专项 | PASS，22/22 |
| P4 专项 | PASS，33/33 |
| v1.6 root cutover | PASS，5/5 |
| Python 专项合计 | PASS，104/104 |
| P5 Cloud contracts | PASS，2/2 |
| P5 真实 PostgreSQL/RLS/并发/Worker | PASS，1 test，292 assertions，36 scenarios，15 migrations；临时测试实例，`production_access=false` |
| Cloud verified build | PASS，Vite 8.2.2 |
| Cloud 全量离线回归 | PASS，66/66 |
| TypeScript typecheck | PASS |
| ESLint | PASS，0 error；2 个既有 warning |
| 冻结评测合同 | PASS，19/19 |
| Recall Trace 合同 | PASS，19/19 |
| 冻结回放 | PASS，111 cases，secret leaks=0 |
| 候选 `git diff --check` | PASS |
| 12 项冻结证据 Blob/SHA-256 | PASS，逐项重算完全匹配 |
| v1.1 验收报告 Blob/SHA-256 | PASS，逐项重算完全匹配 |

真实 PostgreSQL复验只在测试进程创建并销毁的临时实例中执行；未连接、迁移或修改任何现有本地数据库或生产数据库。首次沙盒账号初始化在进入 PostgreSQL 前因 `uv_os_get_passwd ENOMEM` 失败，随后以相同测试在正常 Windows 用户上下文通过；该入口环境失败未触及数据库和产品逻辑。Cloud build/lint 的首次沙盒入口同样因用户级缓存目录权限未进入产品逻辑，使用既有 Git Bash 标准 PATH 和正常用户上下文后通过。

冻结回放保持：corpus hash `1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`；replay hash `f4266eabd2bed94da36c5fa7d99fba17a3493418b849da3dfcfcee7e2842159c`；critical memory recall v2 `0.7763`；false recall rate v2 `0.3444`；stale、scope leakage、superseded leakage、no-memory violations、secret leaks 均为 `0`。

最终候选 v1.1 验收报告：

- 路径：`docs/clued-two-level-views/Clued_P5_多租户隔离与并发写_验收报告_v1.1.md`
- Git Blob SHA：`1e5ffcd89f1343e52e172eb1171effe8277253a3`
- SHA-256：`56b5fcb09d1ba3dd15d29ff0af186ef6b1d470852576f73de81374f3fa4cf82b`

## 9. 十二项冻结证据复核

以下证据在最终候选、fast-forward 合并后 `main` 与 Closeout 前复核中，Git Blob 和逐字节 SHA-256 完全一致：

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

`SHA256SUMS` 覆盖全部 11 份 JSONL；自身 Blob 与 SHA-256 单独列出。独立临时复跑中 `p5_raw_results.jsonl`、Advisors 与 Tenant/RLS 证据逐字节重现；其他场景证据含新生成的 UUID/Attempt/Receipt/Event ID，因此以合同断言、场景结果和冻结 Blob/SHA 双重门禁，而不要求跨运行字节相等。冻结目录本轮未写入。

## 10. Fast-forward-only 合并事实

P5 合并前固定拓扑为：远端 `main` 指向 `8327b6b0429ce69aa95be05fc83bb0e4950625ea`，功能分支指向 `9a5c55f5b63721aa29fd7754d0790ab5ff0995d7`，merge-base 为固定基线，功能分支 ahead 5、behind 0，P5 范围内无 merge commit。

记录的唯一合并命令为：

`git merge --ff-only 9a5c55f5b63721aa29fd7754d0790ab5ff0995d7`

随后使用普通 push 将远端 `main` fast-forward 到最终候选。Closeout 前重新读取远端真实引用，`main` 与 `codex/p5-tenant-isolation-concurrent-writes` 均精确指向最终候选。Git 对象拓扑证明合并未产生 merge commit、额外功能 Commit、squash、rebase、amend、force push 或历史重写；功能分支未被修改。

合并裁决：

`PASS / P5_FF_MERGE_COMPLETED`

本轮 Closeout 只在已合并候选上新增一条普通报告 Commit；该审计 Commit 不属于 P5 功能实现或合并历史。

## 11. 本轮唯一变更、工作树与未执行事项

提交前状态：

- 主 `main` 工作树干净；
- P5 第二轮历史独立复审 detached 工作树干净；
- Closeout detached 工作树在新增本报告前干净；
- 本地与远端功能分支均精确指向最终候选，未移动、未改写；
- staged diff 必须且只包含 `docs/clued-two-level-views/Clued_P5_独立复验与合并_Closeout_报告_v1.0.md`。

本轮 Closeout：

- 只新增上述一份报告；
- 未修改任何 P5 实现、Migration、Worker、测试、冻结证据、既有验收报告、Snapshot、Manifest、Current Pointer 或 `VERSION`；
- Closeout Commit 为普通单父线性 Commit，唯一父提交为最终候选；
- 未 amend、rebase、squash、force push，未创建 merge commit或历史重写。

明确未执行且仍未授权：

- P6；
- 生产访问、生产数据库 Migration、生产部署或任何生产状态变更；
- 对任何现有本地数据库执行 Migration；独立复验只使用测试进程创建并销毁的临时 PostgreSQL 实例；
- Tag、Release；
- Snapshot、Manifest、正式 Current Pointer、根 `VERSION` 的生成、修改、切换或发布；
- 语义召回启用；
- P5 功能分支修改。

P5 至此完成五轮独立复审、四次线性修复、fast-forward-only 合并与不可变 Closeout。完成 Closeout Commit 和普通 push 后立即停止；P6 继续保持未授权。

`PASS / P5_CLOSEOUT_ACCEPTED`
