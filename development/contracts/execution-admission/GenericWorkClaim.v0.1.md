# Generic Work Claim v0.1：任意资源、一个门卫多个门口、领取模式

状态：**设计已合入（PR #501）；§7.2 第 1 步已上生产；§10 第 1、3 步已上生产。** 本文不授予实施、迁移、发布、合并或权限变更；每一步实施由 Owner 逐步授权。

- 第 1 步（Owner 授权 2026-10-02，Task `e9a10dbb`）：迁移 `20261002210000_work_claims_resource_kinds.sql`，测试 `apps/clued-cloud/tests/work-claims-resource-kinds-db.test.mjs`。
  - 登记了 `repo`、`storage`、`record` 三个 kind，当前只有"认领时冲突"这一个门口。
  - 只含裸路径的写集判定结果与 v1 完全相同。
  - verify 的覆盖判定保持字面：裸路径只被裸路径覆盖，`repo:` 不覆盖。GitHub 门口在第 5 步知道仓库身份后再放开。
  - kind 至少两个字符：单个字母加冒号（`C:/Clued/...`）是 Windows 盘符，按裸路径处理（生产里已有这种写集）。根目录文件名以两个以上字符加冒号开头（如 `ab:foo`）的变更路径会被当作未登记的 kind，verify 报错，按 fail closed 处理。
  - 已应用 clued-prod（2026-10-02，生产版本 `20261002181833`）。
- §10 次数与花费上限（2026-10-03，Decision `136a000e`，Task `c8778299`）：取代 v1 的每 Task 每 24 小时 10 次与每认领 20 个 head。第 1 步（令牌桶）迁移 `20261003050000_work_claims_rate_buckets.sql`、测试 `apps/clued-cloud/tests/work-claims-rate-buckets-db.test.mjs`（Decision `d3d0bbe8`，Task `00af11e4`），已应用 clued-prod（2026-10-03，生产版本 `20261003051745`）。第 3 步（合同 15 与认领工具说明）：Decision `c1fe7cca`，Task `12a42be8`。被拒回执补全（续期、接管前置检查与幂等重放的拒绝）：迁移 `20261003070000_work_claims_reject_receipts_renew_takeover.sql`、测试 `apps/clued-cloud/tests/work-claims-reject-receipts-db.test.mjs`（Decision `bd4243b6`，Task `91272c5d`），生产迁移尚未应用，需 Owner 另行授权。
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
- 不做语义去重、标题相似度：冲突仍按资源标识确定性判定（v1 §4.3 原则不变）。
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
| Clued 写工具（默认门口） | Worker 与数据库，写入事务内 | `collision_only`（Decision `2a7391ff` 第 1 条） | 未实施（§4） |
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

"别人"按认领判，不按 Binding 判：同一 Binding 下的另一个会话持有的认领也算别人，因为 Owner 的所有 Claude Code 会话共用一个 Binding（Decision `533a5286`）。

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

**花费**：每一份都是一次新认领，计入每 Task 每 24 小时 10 次的上限；每份各自受每认领 20 个 head 的上限约束。§10 实施后：每一份从 Task 令牌桶取一个令牌，各份的 head 合计计入该 Task 的 CI 计量。

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

1. 资源模型与相交：规范化、相交、kind 登记表与测试。不接门口，行为不变。
2. 默认门口：Clued 存储写工具接入 `collision_only`。生产迁移与 Worker 发布各需 Owner 授权。
3. 多份模式：`claim_mode`、Native 开启页、`copy_index`、`work_claim_adopt`，以及准入 workflow 的合并后采纳运行。
4. 合同与提示：agent-contract 新版本、resume 返回的认领带资源 kind。
5. 官方托管 GitHub App（Task `4d694640`）：按 §3 实现 GitHub 门口传话口。

---

## 8. 不保护什么（随实施声明原样保留）

- v1 §4.7 列出的全部（Host 在首次调用 Clued 前的模型 token、本机 install/build/test、不经 Clued 也不开 PR 的工作、ruleset 被临时关闭期间、管理员直连路径）。
- 不经过 Clued 写工具、也没有传话口的写入：Agent 直接用其他连接器改文档、发邮件、改日程，门卫看不见。
- `collision_only` 门口下，两个都**没有**认领的 Agent 同时写同一份资源：门卫放行两者，由资源自身的版本机制（Drive revision、Record CAS）兜底。
- 多份模式在 GitHub 上：从第一份合并到采纳记录完成之间合并的第二份（§5.3）。
- 判定只在门口调用时成立；认领之后的过期、被接管，只影响之后的写入。

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

### 10.7 分步（每步单独请 Owner 授权）

1. 迁移：令牌桶状态表与两个桶、`work_claim_rate_limited`、被拒回执；从 profile 删 `max_claims_per_task_24h`；豁免按届时 Owner 定的设计接到令牌桶上。DB 测试含历史回放、合成循环与豁免放行。
2. 迁移：GitHub CI 计量表与每 Task 24 小时 head 上限，取代 `max_heads_per_claim`。
3. 合同与工具说明：agent-contract §1.7、错误表、`clued_work_claim` 工具描述；Worker 发布。
4. 生产应用与 Worker 发布。
