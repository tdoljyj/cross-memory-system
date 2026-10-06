# Generic Work Claim v0.1：任意资源、一个门卫多个门口、领取模式

状态：**设计已合入（PR #501）；复审 7 的文档更正见 §4.1、§8、§10.6；§7.2 第 1–4 步已上生产（第 3 步多份模式 2026-10-03 随 PR #523 与 Worker 发布上线）；§10 第 1、3 步已上生产。** 本文不授予实施、迁移、发布、合并或权限变更；每一步实施由 Owner 逐步授权。

- 第 1 步（Owner 授权 2026-10-02，Task `e9a10dbb`）：迁移 `20261002210000_work_claims_resource_kinds.sql`，测试 `apps/clued-cloud/tests/work-claims-resource-kinds-db.test.mjs`。
  - 登记了 `repo`、`storage`、`record` 三个 kind，当前只有"认领时冲突"这一个门口。
  - 只含裸路径的写集判定结果与 v1 完全相同。
  - verify 的覆盖判定保持字面：裸路径只被裸路径覆盖，`repo:` 不覆盖。GitHub 门口在第 5 步知道仓库身份后再放开。
  - kind 至少两个字符：单个字母加冒号（`C:/Clued/...`）是 Windows 盘符，按裸路径处理（生产里已有这种写集）。根目录文件名以两个以上字符加冒号开头（如 `ab:foo`）的变更路径会被当作未登记的 kind，verify 报错，按 fail closed 处理。
  - 已应用 clued-prod（2026-10-02，生产版本 `20261002181833`）。
- 第 2 步（Owner 2026-10-03 选定，Decision `6214c17f`，Task `b244a345`）：迁移 `20261003080000_work_claims_storage_door.sql`，Worker `worker/storage-agent-tools.ts` 与 `worker/continuity.ts`，测试 `apps/clued-cloud/tests/resource-center-storage-work-claim-db.fixture.mjs` 与 `resource-center-agent-tools.test.mjs`。PR #518 合并，已应用 clued-prod（2026-10-03，生产版本 `20261003071945`），Worker 已发布（release run 37106011605）。与 §4.2 的不同与补充：
  - 门卫是 `clued_private.work_claim_gate_v1`（§3.1 的判定，`mode` 支持 `collision_only` 与 `require_claim`），被拒时返回 `{status:"rejected", error_code, ...}` 而不抛异常，并写一条 `WORK_CLAIM_REJECTED` 回执（`attempted_operation` 为 `clued-storage:storage_submit` 或 `clued-storage:storage_trash_batch`）。
  - 门卫放在权限判定与重放检查之后：只有已获授权的 Binding 看得到认领；已有 job 的重放照常返回，不被拒。
  - 目录移动的目标也按 `<目标目录>/**` 计；带新名字的 untrash 另计目标路径；adopt 不改 Drive，不过门卫。
  - 认领的 write_set 不能含空白，含空格的文件名用通配覆盖（如 `storage:<connection>/20_P/**`）。
  - 门卫读已提交的认领，不加认领锁：与写入同时提交的认领可能看不到这次写入。legacy 模式连接（`clued_storage_jobs_v1`）不过门卫，生产没有这种连接。
- 第 3 步（Owner 2026-10-03 选定，Task `5d379c50`）：多份模式，分两个 PR。
  - 第一个 PR（数据库）：迁移 `20261003120000_work_claims_multi_copy.sql`，测试 `apps/clued-cloud/tests/work-claims-multi-copy-db.test.mjs`。
    - 赛马记在新表 `clued_private.work_claim_task_modes_v1`（不放 Task 的 `type_fields`：Binding 能改 `type_fields`，而开启只许 Owner）。开启走 Native 两步：`clued_work_claim_multi_confirmation_issue_v1`（返回建议份数，最近 7 天写过回执的不同宿主数，至少 2）+ `clued_work_claim_multi_enable_v1`。份数 2 到 Task 令牌桶容量（8）；Task 已有活认领或已开过赛马则拒绝。
    - 认领表加 `copy_index`、`outcome`；"每 Task 一个活认领"唯一索引只管独占认领，另加"每份一个活认领"。赛马未决出时，认领按最小空位取份，接管沿用原份；份满返回 `work_claim_copies_full`，在扣令牌与用授权之前。
    - 同 Task 的各份互不冲突（任务相同或资源相交都不算），与其他 Task 照常冲突；每份照常扣 Task 与 Binding 令牌。
    - 采纳：存储门口在写入的同一事务里，份写到共享资源即采纳；GitHub 由 `clued_work_claim_adopt_v1(pr_ref, merge_sha)` 采纳绑定该 PR 的那一份（用准入环境的只读 Binding，与 verify 绑定 PR 同理）。其余各份 `outcome=not_adopted`，活的转 SUPERSEDED；各门口返回 `copy_not_adopted`。采纳后该 Task 回到独占。
    - verify 对份不比较 fence（各份共用 Task 的 fence 序列），改看是否出局。
    - PR #522 合并（6f7f1ec0）；Owner 在 clued-prod SQL Editor 应用（2026-10-03，生产版本 `20261003144411`，连接器对 `drop index` 等确认超时，未能由 Agent 应用）。
  - 第二个 PR（PR #523，合并 697bab17，Worker 发布 run 37132984242）：
    - 开启页 `/work-claims/race`（`apps/clued-cloud/app/work-claims/race/page.tsx`，测试 `work-claim-race-ui.test.mjs`），从"我的授权"页进入：填任务、范围、份数（2–8）与共享资源（每行一个），预览里显示建议份数，确认后开启。页面直接以登录会话调 Native RPC，不经 Worker。
    - 准入 workflow 加 `closed` 类型：原检查 job 跳过 `closed`；新 job `clued-work-adopt` 只在已合并时运行（base 分支当前代码、`clued-admission` 环境），`scripts/ci/clued-work-admission.mjs --mode adopt` 从 PR 正文（或 head 提交）读认领与范围，调 `clued_work_claim_adopt_v1(scope, pr_ref, merge_sha)`。没有认领尾注的 PR 不调用；不是份的 PR 得到 `no_copy_for_pr`，什么都不变；已被别份抢先得到 `copy_not_adopted`，只警告。
    - Agent 合同 18：§1.7 加多份模式说明，错误表加 `copy_not_adopted`、`work_claim_copies_full`。
    - Worker 已发布，合同 18 经 `/clued-agent.md` 与 resume 的 `contract_version` 下发。
- 第 4 步（Owner 2026-10-03 选定，Task `ae40c8fe`，已上线，后续由合同 17 取代）：Agent 合同 16，§1.7 写明 `write_set` 的类型资源（`storage:`、`repo:`、`record:`）、Clued 存储写入检查认领与 `work_claim` 用法，错误表加入存储门卫的拒绝码；`clued_work_claim` 的 `write_set` 说明同步。resume 返回的认领仍是原样的 `write_set`，未另加资源 kind 字段（kind 已在条目前缀中）。合并与 Worker 发布各需 Owner 授权。
- §10 次数与花费上限（2026-10-03，Decision `136a000e`，Task `c8778299`）：取代 v1 的每 Task 每 24 小时 10 次与每认领 20 个 head。第 1 步（令牌桶）迁移 `20261003050000_work_claims_rate_buckets.sql`、测试 `apps/clued-cloud/tests/work-claims-rate-buckets-db.test.mjs`（Decision `d3d0bbe8`，Task `00af11e4`），已应用 clued-prod（2026-10-03，生产版本 `20261003051745`）。第 3 步（合同 15 与认领工具说明）：Decision `c1fe7cca`，Task `12a42be8`。被拒回执补全（续期、接管前置检查与幂等重放的拒绝）：迁移 `20261003070000_work_claims_reject_receipts_renew_takeover.sql`、测试 `apps/clued-cloud/tests/work-claims-reject-receipts-db.test.mjs`（Decision `bd4243b6`，Task `91272c5d`），已应用 clued-prod（2026-10-03，生产版本 `20261003063641`）。第 2 步（GitHub CI 按 Task 计量，Task `bb9f1e36`）：迁移 `20261003180000_work_claims_task_ci_metering.sql`、测试 `apps/clued-cloud/tests/work-claims-ci-metering-db.test.mjs`；verify 带 `pr_ref` 与 `head_sha` 时，每个新 head 记一行 `work_claim_door_usage_v1`（门口 `github-ci`），该 Task 任意 24 小时内最多 40 个，超出判 `task_ci_head_cap_reached` 并给出 `ci_retry_after`；profile 的 `max_heads_per_claim` 换成 `github_ci_heads_per_task_24h`。同一迁移顺带修好旧豁免状态函数对已删参数的读取（Task `6414f530`）。合同 21 写明到上限后换认领无用。生产应用与 Worker 发布由 Owner 另行授权。
- §10.8 续接（2026-10-06，Owner Decision `754dff5d`，Task `a881f82b`）：迁移 `20261006180000_work_claims_continuation.sql`、测试 `apps/clued-cloud/tests/work-claims-continuation-db.test.mjs`。合同与工具说明（Task `5966ce77`）、生产应用（Task `aec7f28f`）各需 Owner 授权。
日期：2026-10-02
Task：`52739939`（Global）。Owner 决定：门卫原则见 Task `52739939` v3，四条规则见 Decision `2a7391ff`，三条待定见 Decision `357fce4f`（§9）。
前置：[WorkClaimAdmission.v0.1.md](WorkClaimAdmission.v0.1.md)（v1 认领、准入检查与 GitHub 门口，已在生产生效）。本文只写在 v1 之上要扩什么，v1 已有的租约、fence、续期进展、幂等规则原样沿用，不重复；v1 的次数上限由 §10 候选取代。
后续：官方托管 Clued GitHub App（Task `4d694640`）是本文 §3 中 GitHub 门口的产品化传话口，按本文接口实现。

---

## 0. 一句话结论

v1 的领取本身就与 GitHub 无关，但它声明的范围只能是仓库路径，能强制它的只有 GitHub 合并与 Claude Code 钩子。要服务各种职业、各种任务的用户，需要做三件事，且只做这三件：

1. **资源**：`write_set` 从仓库路径推广到任意资源（`kind:value`），旧的裸路径照常有效。
2. **门卫**：判定只有一个（`clued_work_verify` 的推广），Clued 自己的写工具是默认门口，零配置；Clued 管不到的地方只装传话口。
3. **模式**：独占（默认）、拆分（v1 已可用）、多份（新增，Owner 开启，写回即采纳）。

用户侧的结果：只用一个 Agent 的用户感觉不到这套机制；多个 Agent 撞到同一份资源时，后来的那个被拦下，并被告知谁在做、什么时候到期。

---

## 1. 范围与非目标

**范围**
- 资源标识、规范化与相交规则（§2）。
- 唯一判定与门口分层（§3）。
- 默认门口（Clued 写工具）的拦截规则（§4）。
- 领取模式：独占、拆分、多份（§5）。
- 用户无感的行为约定（§6）。
- 与 v1 的兼容和分步实施（§7）。

**非目标**
- 不新建任务系统：认领仍挂在已有 Canonical Task 上。
- 不做语义去重、标题相似度（Decision `2a7391ff`）：冲突仍按资源标识确定性判定（v1 §4.3 原则不变）。
- 不替代各门口自有的授权：例如 Clued 存储的 Owner 授权等级、GitHub ruleset。门卫只回答"这件事有没有和别人撞"，不回答"你有没有权限做"。
- 不保护 Clued 和传话口都看不到的写入（§8）。

---

## 2. 资源模型

### 2.1 标识

一个资源写成 `kind:value`。`kind` 为小写字母开头、2 到 32 位的 `[a-z0-9-]`（单个字母加冒号是 Windows 盘符，按裸路径处理）；`value` 是该类资源内的路径，`/` 分段，可带 `*`（单段）与 `**`（任意多段，含零段）。

| kind | value | 例子 | 首个门口 |
| --- | --- | --- | --- |
| （无前缀，旧格式） | 仓库相对路径 | `apps/clued-cloud/**` | GitHub 合并、Claude Code 钩子 |
| `repo` | `<owner>/<name>/<仓库相对路径>` | `repo:tdoljyj/cross-memory-system/apps/**` | GitHub 合并、Claude Code 钩子 |
| `storage` | `<connection_id>/<登记根下路径>` | `storage:2f1c…/客户/合同/**` | Clued 存储写工具 |
| `record` | `<canonical record id>` | `record:52739939-a719-…` | `clued_record_mutate`（见 §4.3） |
| 其他 kind | 由对应门口定义 | `calendar:…`、`mail-thread:…`、`customer:…` | 该门口上线时登记 |

规则：
- **新 kind 必须由门口登记**：一个 kind 只有在某个门口会用它判定时才接受；未登记的 kind 在认领时拒绝（`work_claim_resource_kind_unknown`），避免 Agent 编出没人检查的范围、以为自己受了保护。
- **`storage` 用登记根下的路径**，不用 Drive 文件 ID：路径才能表达"这个文件夹整棵"；文件被移动时，移动这一写入本身要过门卫（源与目标路径都算资源）。
- **`repo` 写全仓库名**，因为同一用户可能有多个仓库；旧格式的裸路径视为"仓库未指明"。

### 2.2 规范化

- 裸路径：沿用 v1 `work_claim_normalize_paths`，不变。
- `kind:value`：`kind` 转小写；`value` 按 v1 路径规则规范化（去首尾空白、去 `./` 与首部 `/`、合并重复 `/`、拒绝空段、`..`、空白与控制字符）。
- 判别：`^[a-z][a-z0-9-]{1,31}:` 开头的条目按 `kind:value` 解析；不匹配的按裸路径（包括 `C:/…` 盘符路径）。仓库里首段带冒号、冒号前有两个以上字符的路径（如 `ab:foo`）会被误判为 kind，因未登记而被拒；这种情况写成 `repo:` 形式。

### 2.3 相交

两个资源相交，当且仅当：

1. 同 kind：按 v1 的路径段算法比较 `value`（`**` 跨段且可为零段；两个单段通配按前后缀相容判定；偏向判"相交"）。
2. 裸路径与 `repo:`：去掉 `repo:` 资源的 `<owner>/<name>/` 前缀后按 1 比较。"仓库未指明"意味着它可能是任何仓库，所以保守判为可能相交。
3. 其他不同 kind 之间：永不相交。

`trigger_refs` 相交规则不变（v1 §4.3 第 3 条）。

---

## 3. 一个门卫，多个门口

### 3.1 唯一判定

判定逻辑、认领数据、Receipt 都只在 Clued 数据库里，只有一份。v1 的 `clued_work_verify_v1` 推广为：

```
work_claim_gate(user, door, resources[], claim_id?, mode)
  → ADMITTED | REJECTED{reason, conflicts[{claim_id, task_id, holder, expires_at, overlap[]}]}
```

- `door`：调用方是哪个门口，只用于审计与按门口选 `mode`，不改变规则。
- `mode`：
  - `require_claim`：写入方必须出示有效认领，且该认领覆盖全部 `resources`（v1 GitHub 门口的现行规则）。
  - `collision_only`：未出示认领时，只要没有别人的活认领覆盖这些资源就放行；出示了认领时按 `require_claim` 检查该认领本身。
- 规则只在这一个函数里，门口不得自带规则。改规则只改这里，所有门口同时生效。

### 3.2 门口分层

| 门口 | 位置 | 模式 | 现状 |
| --- | --- | --- | --- |
| Clued 写工具（默认门口） | Worker 与数据库，写入事务内 | `collision_only`（Decision `2a7391ff` 第 1 条） | 存储已实施（§7.2 第 2 步），未上生产 |
| GitHub 合并：本仓库 | 传话口：`clued-work-admission` + `clued-admission` App + 必需检查 | `require_claim` | 已生效 |
| GitHub 合并：其他用户 | 传话口：官方托管 Clued GitHub App（Task `4d694640`） | 默认 `collision_only`，仓库可切到 `require_claim`（Owner 已定，§9 第 3 条） | 未实施 |
| Host 本地（Claude Code） | 传话口：PreToolUse 钩子 | 只提示和拦一次（L3） | 已生效，可关 |

**传话口**指：它不保存认领、不含规则，只把"谁要动哪些资源"交给 §3.1 的判定，再把结果转成那扇门能懂的形式（GitHub 的检查结论、钩子的拦截）。

**收回原则**：一件写入能经 Clued 写工具完成的，优先让它走 Clued，而不是再给外部门口装传话口。

---

## 4. 默认门口：Clued 写工具

### 4.1 拦截规则（`collision_only`）

Agent 经 Clued 写入时，门卫只拦撞车（Decision `2a7391ff` 第 1 条）：

- 没有人领这份资源：直接写，不要求先领。只用一个 Agent 的用户完全无感。
- 别人的活认领（ACTIVE 或 DRAINING、未过期）覆盖这份资源：拒绝，返回 `work_claim_conflict` 和冲突认领的 Task、持有者、到期时间、重叠的资源。不排队、不重试。
- 写入方出示了自己的认领（`claim_id` + `fence`）：该认领须有效且覆盖本次资源，否则拒绝（与 v1 一致：认领不能"顺便"覆盖它没声明的东西）。

"别人"按认领判，不按 Binding 判：同一 Binding 下的另一个会话持有的认领也算别人，因为 Owner 的所有 Claude Code 会话共用一个 Binding（Decision `533a5286`）。这只在写入方**不出示**认领时成立（复审 7 m4 更正）：持有者按 Binding 记，`active_work_claims` 把 `claim_id`、`fence`、`lease_version` 给同一用户的所有会话，所以同一 Binding 的任何会话都能出示、续期、释放或改为 DRAINING 另一个会话的认领。这是有意的（合同 §1.7：任何会话都能续期），同一 Binding 的会话之间因此彼此不受保护，只防误撞、不防故意。

另一个 Binding 只有出示认领的私有租约钥匙（`lease_key`，迁移 `20261005190000`，WorkClaimAdmission §4.4）才能续期或释放它；续期会把认领转到出示方的 Binding。钥匙只在认领与接管的回答里出现一次，其他 Binding 从活跃列表、resume、冲突或回执里都拿不到。

### 4.2 Clued 存储（首个默认门口）

`clued_storage_submit` 与 `clued_storage_trash_batch` 在建 job 之前、同一事务内调用门卫：

| 操作 | 涉及资源 |
| --- | --- |
| create | `storage:<connection>/<destination_path>` |
| replace | `storage:<connection>/<path>` |
| rename、move（文件） | 源路径与目标路径 |
| move（目录） | `storage:<connection>/<源目录>/**` 与目标路径 |
| trash、untrash | 该条目路径（目录为 `/**`） |

被拒的 job 不建、不占用 Owner 授权次数与批量确认条目，与现有"提交前拒绝"一致。输入新增可选 `work_claim: {claim_id, fence}`。

### 4.3 Canonical Record

Record 已经有 CAS（`base_version`）：两个 Agent 同时改同一条 Record，后到的会因版本不符被拒。所以 `record:` 资源第一阶段只用于认领声明，以及让别人在 resume 时看到"这条 Record 有人在改"，`clued_record_mutate` 不接入门卫（Owner 已定，§9 第 1 条）。

---

## 5. 领取模式

### 5.1 独占（默认）

即 v1：同一 Task 同时只有一个活认领；资源或触发源相交的认领互相冲突。

### 5.2 拆分并行（v1 已可用）

父 Task 拆成子 Task，各自认领，资源不相交才放行；全部子 Task 完成后关闭父 Task。不需要新机制。设计只补一条约定：子 Task 的 `relations` 写明父 Task，父 Task 本身不被认领。

### 5.3 多份（赛马、会审）

**开启**（Decision `2a7391ff` 第 4 条）：只有 Owner 能把一个 Task 设为多份。
- 走 Native account-session RPC（Clued 页面或 Owner 登录态），与 Information Flow 的 Owner 确认面同一类（[NativeWriteSurfaces.v0.1.md](../information-flow/NativeWriteSurfaces.v0.1.md)）；不提供 MCP 工具，Agent 用 Binding 开不了。
- Task 上记录 `claim_mode = {mode: "multi", copies: N, enabled_by_receipt}`。

**份数**（Decision `2a7391ff` 第 3 条，Owner 原话"要看连接了几个 agent 才能给个比较合理的数字"）：
- Owner 开启时页面给出建议值：最近 7 天连接过 Clued 的**不同 Agent 宿主**数（按 client registration 计，Claude、Codex、ChatGPT 等各算一个），至少 2。
- Owner 可在 2 到硬上限之间改选。硬上限 = 每 Task 每 24 小时最多 10 次新认领（v1 `max_claims_per_task_24h`）；§10 实施后改为 Task 令牌桶容量（8）。同一宿主开多个并行会话也可以各占一份，所以建议值只是建议，不是限制。

**并存**：
- 多份 Task 允许最多 N 个活认领同时存在，每个带 `copy_index`（1..N）。它们之间不因"同一 Task"或资源相交而冲突；与其他 Task 的认领照常冲突。
- 每份在自己的**草稿区**里产出：GitHub 上是各自的分支和 PR；Clued 存储里是该份专属的草稿路径（建议 `…/_copies/<task>/<copy_index>/`，由认领时声明）。写草稿区按普通规则过门卫，不算写回。

**采纳**（Decision `2a7391ff` 第 2 条，写回即采纳）：
- 写回 = 一份产出写入该 Task 的**共享资源**（Owner 开启多份时在页面填写，随 `claim_mode` 记录；GitHub 上即合并进 main）。
- 第一份通过门口写回的认领在同一事务内被标为 ADOPTED；Task 记下 `adopted_claim_id`；其余各份立即变为 SUPERSEDED（`outcome = not_adopted`），之后任何门口对它们判 REJECTED（`copy_not_adopted`），不能再写回。产出原样保留作对比。
- GitHub 上，合并发生在 GitHub，门卫在检查时还不知道哪份会被合并。处理：
  1. 准入检查对多份 Task 的每个 PR 都可以放行（各自的认领绑定各自的 PR）。
  2. 准入 workflow 增加 `pull_request_target: closed` 且已合并时的一次运行（base 代码、`clued-admission` 环境），调用 `work_claim_adopt(pr_ref, merge_sha)`：只接受已绑定该 PR 的认领，把它标为 ADOPTED，其余各份作废。
  3. 其余 PR 的检查在下一次复核（每小时）或立即重跑时变红，合并不了。
  4. 窗口：从第一份合并到采纳记录完成之间，Owner 若手快再合并第二份，第二份会被合进去。这与 v1"判定只在检查运行时成立"同一类限制，写进 §8。
- 写回本身仍由有权限的人或工具执行：门卫只记录"这一份是被采纳的"，不替任何人合并或写入。

**花费**：每一份都是一次新认领，从 Task 令牌桶取一个令牌；各份的 head 合计计入该 Task 的 CI 计量（§10.4，迁移 `20261003180000`）。

---

## 6. 用户无感

- **自动领取**：Agent 开始一件会写入的工作时自己领、结束时自己释放（v1 合同 §1.7 已要求）；用户不需要做任何事。
- **撞车提示**：被拒时，Clued 返回的信息足够让 Agent 用一句话告诉用户：哪件任务、哪个 Agent、改的是什么、什么时候到期；Agent 不得换标题、换 Task 重试（v1 规则）。
- **到期即放**：持有者失联时认领按租约到期，资源自动放开，不需要用户清理。
- **门口不需要配置**：默认门口在 Clued 里；只有用户要让 GitHub 也强制时，才装官方 App 并勾一个必需检查。

---

## 7. 兼容与分步实施

### 7.1 数据与接口改动（概要，非迁移文本）

| 项 | 改动 | 兼容性 |
| --- | --- | --- |
| `write_set` 规范化 | 接受 `kind:value`；未登记 kind 拒绝 | 旧裸路径不变 |
| 相交函数 | 按 kind 分组，裸路径与 `repo:` 按 §2.3 | 旧认领判定结果不变 |
| kind 登记表 | 新表，记录 kind、所属门口、上线 Receipt | 新增 |
| 判定函数 | `clued_work_verify_v1` 推广为 §3.1，旧入口保留为 `require_claim` 包装 | GitHub 门口无感 |
| Task `claim_mode` | Native RPC 设置，Agent 只读 | 默认独占 |
| 认领表 | 新列 `copy_index`、`outcome`；"每 Task 一个活认领"唯一索引改为仅对独占 Task 生效 | 独占 Task 行为不变 |
| `work_claim_adopt` | 新 RPC，供写回门口调用 | 新增 |
| 存储写工具 | 建 job 前调用门卫，新增可选 `work_claim` 输入 | 无冲突时行为不变 |
| 合同 | agent-contract §1.7 补"资源写法、撞车提示、多份草稿区" | 合同版本 +1 |

### 7.2 分步（每步单独请 Owner 授权）

1. 资源模型与相交（Task `e9a10dbb`）：规范化、相交、kind 登记表与测试。不接门口，行为不变。
2. 默认门口（Task `b244a345`）：Clued 存储写工具接入 `collision_only`。生产迁移与 Worker 发布各需 Owner 授权。
3. 多份模式（Task `5d379c50`）：`claim_mode`、Native 开启页、`copy_index`、`work_claim_adopt`，以及准入 workflow 的合并后采纳运行。
4. 合同与提示（Task `ae40c8fe`）：agent-contract 新版本、resume 返回的认领带资源 kind。
5. 官方托管 GitHub App（Task `4d694640`）：按 §3 实现 GitHub 门口传话口。

---

## 8. 不保护什么（随实施声明原样保留）

- v1 §4.7 列出的全部（Host 在首次调用 Clued 前的模型 token、本机 install/build/test、不经 Clued 也不开 PR 的工作、ruleset 被临时关闭期间、管理员直连路径）。
- 不经过 Clued 写工具、也没有传话口的写入：Agent 直接用其他连接器改文档、发邮件、改日程，门卫看不见。
- `collision_only` 门口下，两个都**没有**认领的 Agent 同时写同一份资源：门卫放行两者，由资源自身的版本机制（Drive revision、Record CAS）兜底。
- 多份模式在 GitHub 上：从第一份合并到采纳记录完成之间合并的第二份（§5.3）。
- 判定只在门口调用时成立；认领之后的过期、被接管，只影响之后的写入。
- 同一 Binding 的会话之间（复审 7 m4，§4.1）：能出示、续期、释放彼此的认领。
- GitHub 门口：PR 正文可以写别人的认领，用它合并或把它绑到自己的 PR（WorkClaimAdmission §4.7）。多份模式里也能借此决定采纳哪一份。

---

## 9. Owner 已定（2026-10-02，Decision `357fce4f`）

1. `record:` 资源第一阶段**不接入** `clued_record_mutate` 的门卫，靠 Record 自带的 CAS（§4.3）。
2. 多份模式的共享资源由 **Owner 开启多份时在页面填写**，随 `claim_mode` 记录（§5.3），不取 Agent 声明的范围。
3. 官方 GitHub App 的门口**默认 `collision_only`**，仓库所有者可在 App 设置里切到 `require_claim`（§3.2）。本仓库保持 `require_claim`。

---

## 10. 次数与花费上限（候选，取代 v1 的次数上限）

状态：**第 1 步已上生产；第 3 步（合同与工具说明）随 Agent 合同 15 发布。** Owner 定方向（2026-10-03，Decision `136a000e`，Task `c8778299`），参数可在审阅时调整。迁移、合同改动、生产应用与发布各自另行授权。

第 1 步实现与本节设计的两处不同：
- 拒绝沿用 `work_claim_budget_exhausted`，不新增 `work_claim_rate_limited`：`limit` 为 `task_claim_rate` 或 `binding_claim_rate`，另带 `task_bucket`、`binding_bucket`（tokens、capacity、refill_seconds）、`retry_after` 与 `owner_request`。现行合同和 Agent 对这个错误码的处理（等到 `retry_after` 或把确认链接交给 Owner）原样适用，所以第 1 步不必同时改合同；合同 15 再把 `limit` 的新取值写进错误表。
- 第 1 步的被拒回执只覆盖 `work_claim_issue` 里的拒绝：冲突、活认领并发上限、令牌桶。迁移 `20261003070000` 补上续期的全部拒绝、接管前置检查（认领不存在、不可接管、仍有效）与认领/接管幂等重放的拒绝（`work_claim_idempotency_conflict`、`work_claim_idempotency_spent`）；释放的拒绝仍不写。同一 Binding、context、Task、错误码与 `limit` 一分钟内只写一条；不知道 Task 时（认领 id 不存在）以请求的认领 id 为对象。

### 10.1 为什么改

v1 用一个数管三件事：每 Task 任意 24 小时最多 10 次新认领或接管（`max_claims_per_task_24h`），每认领最多 20 个 PR head（`max_heads_per_claim`）。2026-10-03 的生产数据（`clued-prod` 只读，2026-10-01 起 83 次认领、42 个 Task、3 个 Binding）说明这个数量错了东西：

- 只有 M2 Task `1502fd80` 撞过上限。它的 27 次认领来自"每一步开一个新会话、领一次、做完就释放"的宿主习惯（Binding `2222eabb` 19 个会话、`22911ec1` 7 个会话），是 Owner 推动的正常工作，不是失控。
- 计数不区分正常推进和失控循环，于是合同只好要求宿主"一次认领续期到底"来迁就计数，又为撞上限加了豁免页和 Owner 授权。规则在约束宿主习惯，而不是约束花费。
- 认领本身几乎不花钱。花钱的是门口后面的东西：CI 运行、存储读写、模型调用。

Owner 定的原则：规则要能支撑不同宿主的习惯，要成本低、周全、合理、有效，并且适用于任何资源类型，不只是 GitHub。

### 10.2 三件事分开

| 要管的事 | 怎么管 | 依据谁的数据 |
| --- | --- | --- |
| 协调：谁在做什么 | 认领、租约、fence、冲突判定（v1 与本文 §2–§5）。**不设次数上限。** "按步领、做完就放"和"一次认领续期到底"都合规 | 服务端 |
| 花费：真正花钱的地方 | 由花钱的那个门口按自己的单位计量、封顶（§10.4） | 门口自己观察，不靠 Agent 自报 |
| 失控：看不见的花费（模型 token）停不下来 | 令牌桶限制"开工"的速度（§10.3） | 服务端记录的认领时间 |

都不看释放时报的 `completed` 或 `abandoned`，也不要求完成证据：结果由 Agent 自报，而"放弃"多数是诚实地停下来等 Owner 或环境，不是失控。

### 10.3 令牌桶：限制开工速度

**开工**指一次新认领（`clued_work_claim` 签发）或接管（`clued_work_takeover`）。续期、释放、verify、同一幂等键的重放、被拒的尝试都不算开工。

每个桶有容量 `capacity` 和补充间隔 `refill_seconds`：

1. 桶一开始是满的。
2. 每次开工取走 1 个令牌。
3. 每过 `refill_seconds` 补 1 个，补满为止。
4. 桶里不足 1 个时拒绝开工，返回 `work_claim_rate_limited`，`limit` 写明哪个桶，`retry_after` 是下一个令牌到来的时间。

两个桶，开工时都要有令牌，同时扣：

| 桶 | capacity | refill_seconds | 失控时的最大值 | 防什么 |
| --- | --- | --- | --- | --- |
| 每 Task | 8 | 3600（每小时 1 个） | 8 + 24 = 每天约 32 次 | 一个 Task 上的认领、放弃、再认领循环 |
| 每 Binding | 30 | 900（每 15 分钟 1 个） | 30 + 96 = 每天约 126 次 | 一个宿主换着 Task 刷 |

对照 v1：

- 被拦后最多等一个补充间隔（Task 桶 1 小时），不再等到 24 小时窗口里最早的几次过期。
- 正常工作快慢交替，空闲时桶自动补满；失控循环的特征是快，几分钟一次、连续不停，很快就会掏空桶。

**历史回放**（上述 83 次认领按时间顺序回放）：

- 按上表参数，0 次被拦。
- M2 Task 最紧的时候桶里还剩约 2.2 个令牌。Binding 桶按更紧的容量 12、每 15 分钟补 1 个回放也是 0 次被拦，三个 Binding 最少都还剩 8 个以上。
- 合成循环每 3 分钟开工一次：第 24 分钟第一次被拦，之后每小时只放行 1 次，24 小时共放行 31 次。

**实现要点**（概要，非迁移文本）：

- 状态表 `work_claim_rate_buckets(user_id, bucket_kind, key_id, tokens numeric, updated_at)`，在现有 `work_claim_lock` 内读改写：`tokens = least(capacity, tokens + elapsed/refill_seconds)`，不足 1 拒绝，否则减 1。没有行时视为满桶。
- 参数放进 `work_claim_profile_v1`：`task_bucket_capacity`、`task_bucket_refill_seconds`、`binding_bucket_capacity`、`binding_bucket_refill_seconds`，删除 `max_claims_per_task_24h`。
- 被拒写回执（Decision `136a000e` 第 4 条，Task `91272c5d`），用来校准参数。

### 10.4 门口计量：花费在花钱的地方封顶

门口登记表（与 §2.1 的 kind 登记同一思路）增加计量项：每个门口声明自己计量的单位、作用范围、窗口和上限，或明确声明不计量。判定仍只在 §3.1 的唯一门卫里做。

| 门口 | 单位 | 范围与窗口 | 上限（建议） | 说明 |
| --- | --- | --- | --- | --- |
| GitHub CI 重任务 | 放行的不同 PR head | 每 Task、任意 24 小时 | 40 | 取代每认领 20 个 head：分成几次认领都合并计。同一 head 重跑与每小时复核不重复计。历史最多 7 个 |
| Clued 存储读取 | 字节与次数 | 每 Binding、滚动 1 小时 | 沿用 N4 现值 | 已在生产（`20260930200000_storage_read_budget_n4.sql`），只登记、不改 |
| Clued 存储写入 | — | — | 不另计 | 每次写入已经过 Owner 授权等级与批量确认 |
| Canonical Record | — | — | 不计 | 写入便宜，有 CAS |
| 以后的门口（日历、邮件、外部 API 等） | 上线时登记 | 上线时登记 | 上线时登记 | 未登记计量的门口必须明确写"不计量"，不能默认不限 |

实现要点：GitHub 计量需要按时间计 head，`admitted_heads` 数组没有时间。新增 `work_claim_door_usage(user_id, door, task_id, binding_id, unit_key, used_at)`，`unique(door, task_id, unit_key)`，verify 放行新 head 时插入一行，计数取该 Task 24 小时内的行数。

### 10.5 与其他机制的关系

- **合同**：agent-contract §1.7 删去"不要在一步或一轮结束时释放再认领"和"每 Task 24 小时 10 次"两句，改为：两种做法都可以；被 `work_claim_rate_limited` 拒绝时等到 `retry_after` 或告诉 Owner，不得换 Task、换幂等键或换 Binding 绕过。
- **多份模式**（§5.3）：每一份取一个 Task 令牌，所以份数硬上限 = Task 桶容量（8）；各份的 head 合计计入 Task 的 CI 计量。
- **认领豁免（保留，Decision `00b6dcf4`）**：豁免与令牌桶并存。已上线的 Owner 授权 `work_claim.extra_claims`（迁移 `20261003030000_work_claims_owner_grants.sql`）在令牌桶上线前照常使用。令牌桶下豁免怎么做另行设计，由 Owner 定：触发条件、放行几次或补几个令牌、是否沿用 `work_claim.extra_claims`、旧豁免机制（`20261002190000`，已不能新发豁免）的表与页面如何处理。一种候选：任一桶不足 1 个令牌时，消费一次该 Task 的授权放行这次开工，不扣令牌；没有授权时拒绝，并返回确认请求与链接。
- **并发上限**（每会话 3 个、每 Binding 10 个活认领）：不变。它们限制同时占用，不是次数。

### 10.6 不保护什么

- 一个循环如果每次间隔超过 1 小时，Task 桶拦不住它；这样每天最多二十几次，花费有限，由被拒回执和 Owner 查看发现。
- 模型 token 仍然看不见。令牌桶只限制开工速度，不计 token。
- Agent 不认领直接干活：与 v1 相同，只有门口（GitHub 合并、CI 重任务、Clued 写工具）拦得住。
- 参数是按 2026-10-01 到 10-03 的数据定的，样本小；上线后按被拒回执调整。
- 对抗性耗尽（复审 7）：令牌桶按「诚实并发」设计。任一 Binding 可以反复认领并释放别人的 Task，耗尽该 Task 的桶（8 个，每小时补 1 个）；同一 Binding 的会话也可以用不同的 `holder_session_ref` 占满该 Binding 的 10 个活认领。只能事后从回执发现。

### 10.7 分步（每步单独请 Owner 授权）

1. 迁移（Task `00af11e4`，Decision `d3d0bbe8`）：令牌桶状态表与两个桶、`work_claim_rate_limited`、被拒回执；从 profile 删 `max_claims_per_task_24h`；豁免按届时 Owner 定的设计接到令牌桶上。DB 测试含历史回放、合成循环与豁免放行。
2. 迁移（Task `bb9f1e36`）：GitHub CI 计量表与每 Task 24 小时 head 上限，取代 `max_heads_per_claim`。
3. 合同与工具说明（Task `12a42be8`）：agent-contract §1.7、错误表、`clued_work_claim` 工具描述；Worker 发布。
4. 生产应用与 Worker 发布：第 1 步迁移由 Decision `927b2ac8` 授权上线，Worker 发布见 Task `12a42be8`；第 2 步的生产应用归 Task `bb9f1e36`。

### 10.8 续接：同一会话接着做，不算开工（Owner Decision `754dff5d`）

**为什么**：§10.3 假设"按步认领"和"一条认领续租到底"两种做法都容得下，但 Task 桶每小时只回 1 个令牌，按步认领实际只撑得住每小时 1 步。Task `1502fd80`（第一方模型 M2）2026-10-06 6 小时认领 22 次，令牌在 10-03 到 10-06 被用完 6 次，每次都靠 Owner 批准 `work_claim.extra_claims` 放行（note `4ac547cb`）。

**规则**：一次新认领（不是接管，也不是赛跑副本）同时满足下面几条，就是"续接"：

1. 上一条认领是这个 Task 最新的一条（之后这个 Task 没有别的认领），由同一 Binding 持有，并且两条带同样的 `holder_session_ref`。没带会话标识的认领不续接。
2. 上一条由持有者自己以 `completed` 释放，没有用租约钥匙，没有被 Owner 交接，不是赛跑副本，并且释放时带的 `evidence_ref` 在这一串里没出现过。
3. 新认领在那次释放后 `continuation_window_seconds`（900 秒）之内发起，并且离这一串的硬截止还有至少 1 分钟。
4. 上一条存续期间没有人在等它，具体是三种情况：
   - 没有别的持有者或会话因冲突被拒时点过它的名；持有者自己同一会话的冲突不算，比如没放下一步就先认领下一步。
   - 没有人想接管它、因为它还有效而被拒。
   - 没有别的会话给它发过 Agent 消息请求（`kind=request`；`info` 不算）。

   前两种记在 `contested_at` 上。

续接的效果：

- 不从 Task 桶和 Binding 桶取令牌，不动用 Owner 授权，也不占旧豁免的次数。
- 沿用这一串第一条认领的 `hard_deadline_at`，所以一串续接和一条续租到底的认领一样，最长 24 小时。新认领的续租次数从 0 开始，租约取"2 小时"和"硬截止"中较早的那个。
- 认领、它的 Receipt 和回答都写明 `continued_from`（上一条的 `claim_id`）。fence 照常加 1。

不满足时照旧算开工：令牌够就取令牌；令牌不够时拒绝，拒绝里多一个 `continuation`，用 `reason` 说明为什么没算续接：`no_session_ref`、`prior_other_holder`、`prior_not_completed`、`prior_race_copy`、`prior_handed_over`、`prior_released_by_other`、`window_passed`、`chain_deadline_reached`、`no_new_evidence`、`prior_contested`、`prior_requested`。

这只对免费续接这一条路要求"已完成"和新证据；默认的开工路径和 §10.2 第 1 条一样，不看做完没有，也不要证据。

**为什么这样设条件**：

- 新证据：防"认领 → 失败 → 再认领"的死循环（§10.3 令牌桶本来防的就是它）。`abandoned` 之后再认领照常取令牌。证据是自报的，服务端不核实，所以这条只防意外循环，防不住故意造假。
- 同一会话：同一用户的 Claude Code 会话共用一个 Binding（Decision `533a5286`），只看 Binding 会把别的会话的认领错连成一串。
- 冲突和请求：有人在等时不免费拿回，不能让等的人一直拿不到。
- 不碰赛跑：副本编号按空位分配，续接可能换号。

**按 Task `1502fd80` 的历史回放**（clued-prod 只读，2026-10-01 到 10-06，110 条认领）：

- 按现有规则，Task 桶共有 21 次开工令牌不够（实际被拒 6 次，因为每次授权能用 5 次）。
- 不看会话标识时，35 条满足续接，48 条接在 `abandoned` 之后，27 条是别的情况。只有这 35 条不取令牌，回放下来令牌一次也不缺。
- 按会话标识严格相同，只有很少几条满足：M2 每一步都自己编一个新的 `holder_session_ref`（真实会话 id 再拼上步骤名），10-06 09:53 之后干脆不填。所以要让续接对 M2 生效，它得按合同 §1.7 填 Host 的真实会话 id，每一步都不变。这一条写进合同（Task `5966ce77`）。

**实现**：

- `work_claims_v1` 加 `continued_from`、`chain_evidence_refs`（这一串用过的释放证据）和 `contested_at`。
- `work_claim_reject_log_v1` 给这些认领标 `contested_at`：拒绝里列出的冲突认领（调用方自己 Binding 和会话的除外，会话标识由 `work_claim_issue` 以 `requester_session_ref` 传入），以及接管时因为还有效而被拒的那条。不管这次回执有没有因为一分钟去重而省掉，都照样标；别的事务正锁着的行跳过，不等。
- `work_claim_continuation_v1` 做判断；`work_claim_issue` 在令牌桶之前调它。只看认领行的条件先判；释放回执只在窗口之内查。这一串只存释放证据的 md5，不存原文。
- 旧豁免的次数（`work_claim_issue` 与 `work_claim_exemption_status_v1`）不算续接认领。`continued_from` 有部分索引。
- profile 加 `continuation_window_seconds`。`work_claim_view` 加 `continued_from`，所以幂等重放回答的 `claim` 里也带它；回答顶层的 `continued_from` 只在新发出的认领里有。

**不保护什么**：

- 证据和会话标识都是自报的。一个会编证据、编固定会话 id 的循环，每 15 分钟内至少释放一次，就能在 24 小时内不取令牌地反复认领。好在这一串不会超过 24 小时，被拒回执和认领页面上的 `continued_from` 能看出来。
- 迁移前发生过的冲突没有 `contested_at`，所以上线时还活着的认领不会因为以前的冲突被挡。
- 租约自己过期（不是释放）后再认领，不算续接。
- Agent 消息不在认领锁里写。和释放几乎同时发出的请求，可能晚于续接判断提交，这一次就挡不住。
- 不填会话标识的存储写入撞上冲突，也会把冲突认领标成被等待，包括它自己的认领。这是保守的做法。

**分步（每步单独请 Owner 授权）**：

1. 迁移与 DB 测试（Task `a881f82b`）：本 PR。把这个 DB 测试加进 CI 要改受保护的工作流，另开小 PR 做（Task `6970b90a`）。
2. 合同 §1.7 与 `clued_work_claim` / `clued_work_release` 工具说明（Task `5966ce77`）：写明续接条件、填真实会话 id、完成时带新的 `evidence_ref`，并写明 `continuation.reason`。在合同 36 合入之后做。
3. 生产应用迁移（Task `aec7f28f`）。只改数据库，不用发布 Worker；回答里新增的字段原样透传。
