# Work Claim Admission v0.1：多 Agent 执行准入与费用保护机制候选

状态：**部分实施。** 第 1–6 步已在生产生效，强制开启。第 7 步实测已完成；独立评审 HOLD_FAIL 的修复已合入；2026-10-03 的复审（Task `869d2db7`）仍为 HOLD_FAIL，修复见下（Owner Decisions `38ddb8cf`、`b0c53143`）。方向由 Owner 接受（Decision `78ca0c07`），不是架构接受。
日期：2026-10-01（状态更新 2026-10-02）
来源：Owner 上传的《Clued 多 Agent 执行协调与费用保护：讨论纪要与既有机制对账》（2026-10-01）的重新评估，以及对纪要第九节源码与合同的只读对账（固定在 commit `f7ba6ff312aa0e90095db1e28f5937920f30de3a`）。
通用化后续：任意资源、一个门卫多个门口、领取模式（独占/拆分/多份）的设计候选见 [GenericWorkClaim.v0.1.md](GenericWorkClaim.v0.1.md)（Task `52739939`）。
治理：起草时受 Global Decision `93eb4e76` 的暂停约束（只读评估与设计豁免）。该约束已由 Decision `78ca0c07`（2026-10-01）取代。各步实施由 Owner 逐步授权。本文件本身不授予实施、合并、部署或权限变更。

### 当前状态（2026-10-02，对照 main `f844d6a`）

- **已上线**：
  - `work_claims_v1` 与 transport、admission hardening、会话上限迁移已应用 clued-prod。
  - Worker 五个认领工具与 resume 的 `active_work_claims` 已发布。
  - `clued-work-admission` 是 `main` 的必需检查，`CLUED_WORK_ADMISSION_ENFORCE=true`。
  - 六个自托管重任务 workflow 有 `admission-gate`，三个重任务的手动触发须经准入。
  - Claude Code 钩子已合入。
  - 各项实现细节见 §4.3、§4.5、§4.6 的「实现」条目。
- **第 7 步**：
  - 验收矩阵实测：PR #467。
  - 独立评审 HOLD_FAIL。修复已合入：PR #472、#479、#480，另有 PR #475、#477。
  - 复审（2026-10-03，Task `869d2db7`，对照 main `cd84acd2`）：fresh-context 只读评审，HOLD_FAIL。
    - 已修好：BLOCKER-1（准入跑 PR 代码）、MAJOR-4（glob 相交）。合并这一关成立：base 代码、environment 持有 token、App 限定来源的必需检查。
    - 新发现（MAJOR）：N1 多份模式的采纳可伪造；N2 任何 Agent 可把别人的认领绑到假 PR、或撑满其 CI 额度；N3 自托管 CI 花费闸可绕过（改过的分支手动触发、旧分支 push、发往非 main 的 PR 冒充准入），且文档夸大；N4 workflow 守卫的 YAML 读法可被引号、flow 写法、4 空格缩进与非字面标签绕过。另有 MINOR N5–N8。
    - 修复（迁移 `20261003200000_work_claims_binding_roles.sql`、`scripts/ci/clued-work-admission.mjs`、`scripts/runner/`）：
      - N1/N2/N5：Owner 在 `/bindings` 页面（Native 两步）标出 CI 准入 Binding 与发布门口 Binding；标出后，带 `pr_ref` 或 `ci_dispatch` 的 verify、合并后采纳只认 CI 准入 Binding（其他返回 `admission_binding_required`），发布门口只认发布门口 Binding。未标出时保持原行为。
      - N3：去掉旧分支的 push 触发；PR 内的 gate 只认本 PR 的准入运行；手动触发的准入记下所核验的提交并计入 CI 额度，重任务只在同一提交上放行。
      - N3 硬拦截：自托管 runner 的开工前检查（`scripts/runner/README.md`，Decision `b0c53143`）。装在 runner 机器上、不在仓库里：改了任何 workflow 的运行要有 base 代码的准入结果，非 main 的 push、发往其他分支的 PR、改了 workflow 的手动触发一律拒绝。由 Owner 在每台 runner 上安装后生效。
      - N4：workflow 必须是守卫能读的写法（否则拒绝）；只有单个字面 `ubuntu-*`/`windows-*`/`macos-*` 标签才算托管 runner；已有的不设闸检查不能新增自托管 job。
      - N6：migrate 的授权资源写明迁移文件；整段事务用 `psql -c` 交给服务器，迁移文件里的 psql 元命令不会执行；授权在凭据检查之后才消费。
      - N7：合并后的采纳任务用单独的并发组。N8：被 workflow 守卫拒绝的 PR 只做只读核验，不计入 CI 额度。
    - 未修：PR 正文可以写别的 Agent 的认领 ID（仓库侧不知道 PR 由谁打开）；按 Task 计量，Task 越多额度越多。
- **尚缺或与本文设计不符**（各条在对应小节标注）：
  - 每认领 CI 分钟预算与 finalize：改为次数上限，不做（§4.5，Owner Decision `a264ea02`）。
  - 备份恢复后 `max(fence)` 会回退，靠恢复后的手工步骤补救（§4.4、§6，Owner Decision `2b23eb0c`）。
  - 同名 check 伪造与 PR 删除 `needs: admission-gate`（§4.6）。
  - 判定只在检查运行时成立，合并时不实时重验（§5）。
- **Owner 设置（2026-10-02）**：
  - 已完成（Owner 自述）：`clued-admission` environment 限 `main`、不设审批人；新只读 token 放入 environment secret，删除仓库 secret，撤销旧 token。
  - 已验证：`clued-work-admission-dispatch` run `37003236812`（main `e2a1c06`）在该 environment 中拿到 token，Clued 以强制模式判 ADMITTED。部署分支限制与仓库 secret 删除无法从 Agent 侧读取，未独立验证。
  - 防同名 check（Owner Decision `37e01bb1`）：仓库侧已就绪（`clued-admission-verified`，§4.6）；Owner 已建 `clued-admission` GitHub App（仅 Checks 读写，只装在本仓库；2026-10-02 删除重建一次，旧私钥随旧 App 作废）并把 App ID 与私钥放进 `clued-admission` environment；`clued-admission-verified` 已在 main ruleset 设为必需检查，来源限定为该 App。

---

## 0. 一句话结论

纪要把问题定义对了，但把修复方向放在了一个不存在的执行点上。它要求"成本准入先于派发"，而派发模型调用的是 Claude Code、Codex 这些第三方 Host，Clued 在它们之前没有任何可控入口。可控的只有三处：Clued 自己的数据库、本仓库的 CI workflow、`main` 的 ruleset。有效机制必须把硬保证放在这三处，把"派发前准入"降级为合规路径，并如实标出不受保护的部分。

---

## 1. 对纪要的重新评估

### 1.1 同意的部分

- 根因定义正确：已有协调语义没有在普通开发的成本派发、受控写入、最终整合三条路径上形成不可绕过的证据链；人的遗漏是触发条件，不是修复方案。
- "已实现 / 历史已运行 / 候选 / 未验证" 的分层正确。全库只读扫描确认：仓库里**没有**任何面向普通工作的通用 claim、lease、admission 或预算预留接到 MCP 工具、Worker 路由、CI 或 hook 上。所有已实现的租约都绑定单一子系统（见第 2 节表）。
- 第六节"检测不等于阻止"、第七节"故意不遵守也必须失败"的验收立场正确。

### 1.2 不同意或需要修正的部分

| 纪要位置 | 问题 | 修正 |
| --- | --- | --- |
| §5.1 成本准入先于派发 | 预设存在一个"可控的调度入口"在模型调用、子任务、下载、构建之前做检查。本次三份 PR 分别来自两个 Claude Code web 会话和一个 Codex 桌面会话，它们各自派发自己的模型调用与本地构建，Clued 在那之前没有任何执行点。纪要自己在 §5.1 末尾承认了这条边界，却仍把它列为第一候选方向。 | 把"派发前准入"拆成两层：Host 内的本地开销（模型 token、本地 npm install／build／test）只能走**合规路径**；跨 Host 共享的开销（自托管 CI runner、CI 内 Supabase 栈、合并到 main）走**硬门禁**。 |
| §5.2 写能力只交给受控执行者 | 对 GitHub 分支写入要求"可信资格门禁"。分支本身是廉价的，Agent 用 Owner 身份推分支无法也无需阻止。 | 分支写入不设门禁；门禁设在 CI 重任务入口和 `main` ruleset 的 required check。 |
| §5.3 继承 WorkLease 候选 §12 的"单 active broker + 本机 SQLite journal" | 那是为单机 DCP 设计的。本次故障是三台机器、三个 Host 并发，单机 SQLite 不是 broker。 | broker 就是 Supabase Postgres。Projection Refresh 已经在它上面跑着 `FOR UPDATE SKIP LOCKED` + lease_id + 30 秒期限 + 有界重试 + watchdog，并有生产运行记录。复用这套，不另起 broker。 |
| §二 事实边界 | 只记录 #443、#444。#445（04:20Z，另一独立 Claude Code 会话）未被吸收，Task 14a81caa v9 的 overlap_check 当时已列出它。 | 事实见 Note `46f46fed`；整合顺序见 Decision `8b22f847`。 |
| §四 根因只说"没有证据链" | 没有指出三个会话是被**同一个信号**（Trivy 在所有 PR 上变红）触发的。这意味着去重的关键不是标题或文件，而是**触发源**：GHSA 编号、失败的 check 名 + base SHA。 | 冲突判定加入 `trigger_refs`（第 4.3 节）。 |
| §四 威胁模型 | 把"故意绕过"与"遗漏"并列，导致验收矩阵偏向对抗场景。实际所有 Host 都由同一 Owner 驱动、用同一 GitHub 身份；真实失败模式是**诚实并发 + 延迟发现**，不是恶意。 | 设计目标按"诚实并发"优化（早发现、低摩擦），硬门禁只在共享资源处防"忘了"和"旧会话继续推"。对抗性保证只在 Clued DB 与 `main` ruleset 两处宣称。 |
| §三 "#444 曾依赖 v4 合同" | 定性为"入口一致性问题"但没有给出机制。Worker 下发的 `/clued-agent.md` 落后仓库 v6 是部署滞后。 | `clued_session_resume` 返回 `contract_version`；Skill 与 hook 比对本地合同版本，不一致时拒绝开工（合规路径）。 |

### 1.3 纪要遗漏的事实

- Storage N4（`20260930200000_storage_read_budget_n4.sql`）已经实现了 admit → reserve → finalize 的每 Binding 滚动小时预算，并以 advisory lock 串行化。这正是纪要 §5.1 要的"同一原子边界预留额度"，只是绑在 Storage 读上。可直接复用其模式。
- `kernel/policy/approval-lease.mjs` 的 reserve → issue → consume 带 fencing_token 与时间窗口，`external-invocation-ledger.mjs` 有 lease 与 fence 校验。它们只被 `evals/kernel-next/*` 引用，没有任何 Worker、迁移或 hook 使用。纪要说"内存参考实现"是对的，但没说清它们的 API 形状可以直接作为 claim RPC 的合同。
- Claude Code 支持 PreToolUse hook，仓库现在只注册了 Stop hook。这是本仓库内 Claude Code 会话唯一能在**开销发生前**拦截的点。
- 2026-10-01 根因审计还观察到：服务端合同已是 v6，但部分客户端暴露的工具参数仍是旧版，新读取方式需走替代路径。这与 #444 用到 v4 合同是同一类问题：版本一致性要在**真实客户端**验收，不能只看服务端自报。`contract_version` 比对（第 4.6 节 L2）只覆盖合同文本，不覆盖工具 schema；工具 schema 漂移需要另一条 bootstrap 侧校验，本设计不展开。

---

## 2. 现状对账表（固定在 f7ba6ff）

| 机制 | 已实现到哪一步 | 作用域 | 可达性 | 能否复用于普通工作 |
| --- | --- | --- | --- | --- |
| Projection Refresh claim／lease／watchdog（`20260923213000/213100/213200`） | 生产：`FOR UPDATE SKIP LOCKED`、lease_id、30 秒期限、max_attempts、过期转 RETRYABLE_FAILURE、apply 侧校验 lease_id + revision + digest | 仅 `global.priority_frontier`、`global.__aggregate__`；专用 Builder Binding | 仅 Worker cron，无 MCP／路由 | **是**：SQL 模式逐字可搬，换成 work_claims 表 |
| Storage N4 读预算（admit／reserve／finalize） | 生产 | 仅 storage 内容读 | MCP `clued_storage_read` | **是**：预算模式 |
| Storage job 与 root fence（`pg_advisory_xact_lock`） | 生产 | 仅 Resource Center 变更 | MCP `clued_storage_submit` | 部分：advisory lock 模式 |
| Context v2 稳定 execution_intent（`20260922143312`） | 生产：同 owner + intent 唯一 Task，身份不可变，在 `clued_record_mutate` 写 Task 时强制 | 所有 Task | MCP `clued_record_mutate` | **是**：claim 必须绑定已存在的 Task id，复用其身份 |
| Currentness admission 用户级 advisory lock（`20260922092932`） | 生产 | session resume／reconcile／checkpoint | MCP | 是：claim 事务复用同一用户锁，避免与 checkpoint 交叉 |
| Kernel Attempt FSM、approval-lease、external-invocation-ledger、durable outbox | 内存实现 + eval 测试；`execution.profile.json` maturity 0.x-experimental、`runtime_selected=false` | 无运行时消费者 | 无 | 作为 RPC 合同形状复用；不作为运行时 |
| Git Connector Write Contract v0.1 + `main` ruleset | 生产：PR 必须、required `gitleaks` + `trivy`、禁强推、bypass 为空 | `main` | GitHub 强制 | **是**：加一个 required check |
| capture guard Stop hook（`scripts/hooks/clued_capture_guard.py`） | 生产：事后检查、每项一次、`CLUED_CAPTURE_GUARD=off` 可关 | 本仓库 Claude Code 会话 | Stop 事件 | 否（事后）；但同一机制可加 PreToolUse |
| WorkLease 候选 v0.1.4 §4.2／§12 | 文档 | — | — | 字段定义可用；broker 选择不用 |
| MCP 工具目录（`worker/continuity.ts:1115-1415`） | 生产 | — | — | 现无任何 claim／lease／admit 工具 |

---

## 3. 可控边界与保证分层

把每个开销和写入点按"谁能物理拦住它"分层。这张表是本设计的诚实边界，任何实施完成声明都不得越过它。

| 层 | 入口 | 谁强制 | 不依赖 Agent 自觉？ | 本设计给的保证 |
| --- | --- | --- | --- | --- |
| L0 | `main` 合并 | GitHub ruleset required check `clued-work-admission` | **是** | 没有有效 claim 覆盖该 PR 的 head、base、变更文件集，就不能合并 |
| L0 | 自托管 CI 重任务（Information Flow E2E、Supabase migration/pgTAP、isolated-candidate、node22-install、model-program harness） | workflow 首个 job `admission-gate`（GitHub 托管 runner，秒级）；runner 机器上的开工前检查（`scripts/runner/`，Owner 安装后） | **装上 runner 检查后是**；只靠 `admission-gate` 时否：在改过 workflow 的分支上手动触发或 push 可以跳过它（复审 N3） | 未被 claim 覆盖的 PR 只跑 gitleaks、trivy 和 gate 本身；改了 workflow 的运行要有 base 代码的准入结果；非 main 的 push 与改了 workflow 的手动触发在开工前被拒 |
| L1 | Clued Canonical 与 claim 表 | Postgres 事务 + CAS + lease | **是** | 同一 write_set／trigger_ref／intent 只有一个有效 claim；过期、fence 不符的写被拒 |
| L2 | Agent 开工前 | agent-contract §1 新增步骤；`clued_session_resume` 返回冲突 claim | 否 | 合规 Agent 在**第一次 Clued 调用**就看到冲突并停下，成本止于一次 resume |
| L3 | Claude Code 本地 `git push`、`gh pr create`、`npm install`／`build`／`test` | PreToolUse hook（仓库 `.claude/settings.json`） | 否（可关、可删、只对本仓库 Claude Code） | 没有 `CLUED_WORK_CLAIM` 环境或 claim 文件时阻止这些命令一次 |
| 无 | Host 在第一次 Clued 调用前的模型 token；Codex／ChatGPT 等无 hook Host 的本地开销；任何不调用 Clued 的工具 | 无 | — | **不保护**。只能事后从 PR／commit 中识别并拒绝整合 |

---

## 4. 机制设计：Work Claim

### 4.1 对象

不新建任务系统。一个 claim 是对**已存在 Canonical Task** 的一次有时限、有 fence 的执行占用。

```
work_claims_v1
  claim_id            uuid PK
  user_id             uuid            -- Owner
  task_id             uuid            -- 必须是该用户的 active Task（复用 execution_intent 身份）
  holder_binding_id   uuid            -- 持有者 Binding（Host 身份）
  holder_session_ref  text            -- client_session_id，仅审计
  base_commit         text            -- 声明的起点 commit
  write_set           text[]          -- 仓库路径或 glob，规范化、排序
  trigger_refs        text[]          -- 规范化触发源：ghsa:GHSA-xxxx、ci:<check>@<base_sha>、issue:<n>、pr:<n>
  fence               bigint          -- 该 task 的单调 epoch；重新获取或接管才 +1
  lease_version       bigint          -- 续期 +1，不改 fence
  issued_at, expires_at, hard_deadline_at   timestamptz
  renewals            int
  progress_ref        text            -- 最近一次续期提交的进展证据（head SHA 或 Receipt id）
  budget              jsonb           -- {ci_minutes_cap, attempts_cap, concurrent_cap_consumed}
  status              text            -- ACTIVE | DRAINING | RELEASED | EXPIRED | SUPERSEDED
  receipt_id          uuid            -- 创建 Receipt
unique (user_id, task_id) where status in ('ACTIVE','DRAINING')
```

claim 的创建、续期、释放、接管都走现有 `clued_private` 事务模式：先 `currentness_user_lock(user_id)`，再 `pg_advisory_xact_lock('work-claim:'||user_id)`，与 Projection Refresh 一致，不与 checkpoint 交叉死锁。

### 4.2 RPC（MCP 工具）

| 工具 | 作用 | 原子性 |
| --- | --- | --- |
| `clued_work_claim` | 输入 task_id（或 `{title, execution_bucket, execution_intent}` 原子创建 Task 后再 claim）、base_commit、write_set、trigger_refs、估算预算。一个事务内：校验 Task 身份与 Binding 读写权；计算冲突（4.3）；无冲突则插入 ACTIVE claim，fence = 该 task 历史最大 fence + 1；返回 claim_id、fence、expires_at、Receipt。有冲突则返回 `work_claim_conflict` 与冲突 claim 的 id、持有者、expires_at、重叠的路径／trigger，不插入。 | 单事务，幂等键 = `<session>:<task_id>:claim` |
| `clued_work_renew` | 必须携带 claim_id + fence + lease_version + **progress_ref**（新 head SHA 或新 Receipt）。progress_ref 与上次相同 → 拒绝 `work_claim_no_progress`。成功只延长 expires_at、lease_version +1，不动 fence。超过 hard_deadline_at 或 renewals 上限 → 拒绝。 | 单事务 |
| `clued_work_release` | 持有者主动释放；带 outcome（completed / abandoned）与证据引用。 | 单事务 |
| `clued_work_verify` | 只读。输入 claim_id、head_sha、base_sha、changed_paths[]；返回 ADMITTED / REJECTED 及原因。供 CI gate 与 required check 调用，使用只读 Binding。实现：可选 `pr_ref` 时首次准入把 claim 绑定到该 PR（一条 Receipt），MCP 工具从迁移 `20261002072000` 一起开放 `pr_ref`；不带 `changed_paths` 时不检查路径，CI 的 PR 检查总会带，手动触发的准入有意不带 | 只读；带 `pr_ref` 时写一条绑定 |
| `clued_work_takeover` | 对 EXPIRED 或 DRAINING claim 发起接管：新 claim 以 fence +1 创建，旧 claim 标 SUPERSEDED。不自动触发，只由新持有者显式调用；Owner 决定或 profile 允许时才可对未过期 claim 强制接管。 | 单事务 |

`clued_session_resume` 增加返回：`contract_version`、`active_work_claims`（本用户所有 ACTIVE claim 的 task_id、write_set、trigger_refs、expires_at）。合规 Agent 在 resume 时就能比对自己的意图。

### 4.3 冲突判定（确定性，不靠语义理解）

两个 claim 冲突，当且仅当满足任一：

1. **同一 task_id**：已有 ACTIVE／DRAINING claim（这是 execution_intent 唯一性的执行层延伸）。
2. **write_set 路径重叠**：规范化后任一路径或 glob 相交。`apps/clued-cloud/package-lock.json` 这类共享文件会直接相交。
3. **trigger_refs 重叠**：任一规范化触发源相同。#443／#444／#445 都会写 `ghsa:GHSA-vcvr-r3jv-pc5j` 或 `ci:trivy@f7ba6ff`，在第二份 claim 时即冲突，与标题无关。

**实现（第 7 步评审修复，2026-10-01，迁移 `20261002050000`，Task `047e663e`）**：第 2 条最初只检查「一侧的 glob 覆盖另一侧的字面路径」，两个 glob 之间不比较，`apps/clued-cloud/**` 与 `**/package-lock.json` 不冲突。现按路径段比较：含 `**` 的段匹配任意多段；两个单段通配只要字面前缀与后缀相容就算相交。判定偏向「相交」：可能把两个实际不共享路径的 glob 判为冲突，不会漏判。

**实现（MINOR 修复，2026-10-02，迁移 `20261002072000`，Task `27b4f5e8`）**：
- 第 3 条按不区分大小写比较：`ghsa:GHSA-x` 与 `ghsa:ghsa-x` 相同。`@` 后都是至少 7 位十六进制、且一方是另一方前缀时也算相同，所以 `ci:trivy@f7ba6ff` 与完整 SHA 冲突。存储的 ref 保留声明时的大小写。
- 第 2 条中 `**/` 也匹配零层目录：`**/package-lock.json` 覆盖根目录的 `package-lock.json`，与 CI 路径过滤的理解一致。

不做：标题相似度、语义去重、自动合并意图（Decision `78ca0c07`）。语义不明确时 Agent 可以用 `clued_search_context` 做有上限的探索，但那不是准入判断。

### 4.4 租约、续期、过期、接管、fence

- **期限来自 profile**，不是无限 TTL：默认 claim 期限 2 小时，hard_deadline 24 小时，最多续期 12 次。数值在 `protocol/.../work-claim.profile.json` 中定义并随测试接受；缺省配置视为失败，不视为无限。
- **续期必须带进展**：heartbeat 不是进展。progress_ref 不变即拒绝续期，到期自然过期。这直接回答"持续 heartbeat 却无进展"。
  - **实现（2026-10-02，迁移 `20261002072000`）**：本 claim 以前任何一次续期用过的 progress_ref 都会被拒，`x,y,x,y` 交替不再通过（`progress_refs` 列记录历史）。
- **幂等键只代表一件工作（迁移 `20261002072000`）**：`clued_work_claim`／`clued_work_takeover` 记下操作、scope、Task（或被接管的 claim）与规范化 write_set 的哈希。
  - 同一个键换了这些内容，返回 `work_claim_idempotency_conflict`，不再返回无关的旧 claim。
  - 键对应的 claim 已不再有效（释放、过期、被接管）时，重放返回 `work_claim_idempotency_spent`。
  - 重试时省略可选字段（trigger_refs、base_commit、会话、租期、预算）仍按重放处理。
- **DRAINING**：持有者声明「已派出、不可取消的动作还在收尾」。它在到期前一直阻止冲突，也不能被接管；到期后才可接管或由持有者释放。
- **过期只拒绝新效果，不证明旧进程停止**：过期后 claim 进入 EXPIRED；旧持有者的分支仍存在，但其 claim_id + fence 在 `clued_work_verify` 下 REJECTED，无法通过 L0。它不能再续期，只能对新 claim 发起"采纳分支"请求（人工或新持有者决定）。
- **fence 单调**：只在 claim 创建与 takeover 时 +1；续期不动。服务恢复、备份回滚不得回退 fence：fence 来源于 `max(fence)+1` 的事务内计算，不来自客户端。
  - **实测（第 7 步，PR #467）与此不符**：从较旧的表副本恢复后 `max(fence)` 会回退。重新签发的 claim 拿到相同 fence 数值，但 claim_id 不同；恢复点之后签发的 claim_id 在 verify 下为 `claim_not_found`。不回退需要表外的单调 fence 来源，或修改本条（Task `27b4f5e8` 第 4 条）。
  - **已知限制（Owner Decision `2b23eb0c`，2026-10-02）**：不改 fence 来源。数据库从备份恢复后、Agent 再开工前，运行 `apps/clued-cloud/scripts/work-claims-after-restore.sql` 一次：恢复回来的 ACTIVE／DRAINING 认领标为 RELEASED（abandoned），所有 fence 加一百万，使新认领与接管拿到的 fence 高于恢复前签发过的任何 fence。步骤写在 `apps/clued-cloud/docs/production-release.md`「After a database restore」，验收测试 `work-claims-acceptance-db` 覆盖。
- **多资源一次性获取**：write_set 整体在一个事务中判定，没有逐路径加锁，没有持锁等锁，不会死锁。
- **优先级不抢占**：Global Frontier 的 Pin 或 priority 变化不自动 takeover 一个 ACTIVE claim。

### 4.5 预算

复用 N4 模式：

- **每 Binding 并发 claim 上限**（默认 3）：一个失控 Host 不能把所有 Task 都占了。
  - **实现（2026-10-02，Owner Decision `533a5286`，迁移 `20261002060001`）**：改为每个会话（Agent 自报的 `holder_session_ref`）最多 3 个活认领、每个 Binding 合计最多 10 个。原因：Owner 的所有 Claude Code 会话共用一个 Binding，原来的「每 Binding 3 个」会让并行会话互相挤占。会话标识是自报的，所以保留 Binding 总上限兜底；没有 `holder_session_ref` 的认领单独算一组。拒绝时 `limit` 字段写明撞到的是哪个上限。
- **每 claim CI 分钟上限**（原设计）：`admission-gate` 在放行重任务前调用 `clued_work_verify` 并上报本次预计分钟数；超出上限返回 REJECTED，重任务不启动。实际消耗由 workflow 完成后以 observed 回写（finalize）。
- **模型 token**：claim 只记录 Agent 自报的估算，标为 `declared_unenforced`。不宣称预留。
- （原设计）取消、失联或 UNKNOWN 时**不释放预留**；只有 finalize 或 takeover 事务才结算。没有分钟预留后不再适用。
- **实现（2026-10-02，Owner Decision `a264ea02`，Task `80aea04a`，迁移 `20261002100000`）**：分钟预算、finalize 与预留结算不做，改为数据库内强制的两个次数上限，不给 CI 可写凭据：
  - `attempts_cap`：一个 Task 在任意 24 小时内最多 10 次新认领或接管；超出时 `clued_work_claim`／`clued_work_takeover` 返回 `work_claim_budget_exhausted`，`limit` 为 `max_claims_per_task_24h`，附 `claims_last_24h` 与 `retry_after`。已签发认领的幂等重放不受影响。
  - 每 claim 的 PR head 上限：带 `pr_ref` 与 `head_sha` 的 verify 在放行时把该 head 记入 `admitted_heads`；一个 claim 最多放行 20 个不同 head，再来新 head 判 REJECTED（`claim_head_cap_reached`），重任务不跑。同一 head 重跑或每小时复核不计数；不带 `pr_ref` 的 verify（手动触发、Agent 自查）不记录。
  - `budget` 字段仍原样保存、不校验；模型 token 不计。
- **替代（2026-10-03，Decision `136a000e`）**：上面两个次数上限由 [GenericWorkClaim.v0.1.md §10](GenericWorkClaim.v0.1.md) 取代：新认领次数改为令牌桶（迁移 `20261003050000`），每 claim 的 head 上限改为每 Task 任意 24 小时 40 个 head（迁移 `20261003180000`，Task `bb9f1e36`，拒绝原因 `task_ci_head_cap_reached`）。

### 4.6 执行层细节

**L0a：`main` required check `clued-work-admission`**

- 一个无路径过滤的 workflow，GitHub 托管 runner，只做一次 HTTPS 调用 `clued_work_verify`（只读 Binding 放在 GitHub secret）。
- 输入：PR head SHA、base SHA、变更文件集（`gh api .../files`）、PR body 或最后一个 commit trailer 中的 `Clued-Work-Claim: <claim_id>`。
- 判定：claim ACTIVE 或 DRAINING 且未过期；holder 不校验 GitHub 身份（都是 Owner），校验 fence 为该 task 当前最大；变更文件集 ⊆ write_set；base_sha 等于或晚于 claim.base_commit。任一不满足 → 失败并写明原因。
  - **实现（2026-10-02，Owner Decision `36b50981`，Task `d95ee6ea`）**：「base_sha 等于或晚于 claim.base_commit」改为只提示。claim 的 base_commit 比 PR 的 base 新时，检查摘要写一条 `base_behind_claim` 提示，仍放行。原因：base_commit 由 Agent 自报，这条比较拦不住错误的 claim；Codex 在新 main 上重新认领而分支仍基于旧 main 时，#441 因此被拒三次。base_commit 在仓库里找不到（`claim_base_unknown`）仍拒绝。
- **Owner 在 GitHub 网页直接改文件开的 PR**（Owner Decision `36b50981`）：同样需要 claim，没有豁免。Agent 与 Owner 共用一个 GitHub 账号，CI 分不出是谁改的，豁免会被 Agent 用来绕过。做法：网页改动前让任一 Agent 为该 Task 建 claim，把 `Clued-Work-Claim: <claim_id>` 贴进 PR 正文；改正文会重跑检查。
- 范围扩张（变更文件超出 write_set）→ 失败，提示先 `clued_work_renew` 携带扩大的 write_set（扩大时重新做冲突判定）。
- 加入 ruleset required 列表后，这条和 gitleaks、trivy 一样是无过滤 check，不会出现"等不到"的问题。
- 同一 check 顺带输出一张汇总表：按本 PR 变更路径判定哪些路径过滤的 workflow **适用**、各自在当前 head 上的结论、哪些**不适用**。这就是 2026-10-01 根因审计第 4 项要的"始终返回结果的汇总检查"，不必另开一个。
- 自报 JSON、伪造签名不算：check 由 workflow 从 Clued 实时查询，Receipt 在 Clued 侧。**同名 check 未覆盖**：PR 可以新增一个同名 job，见下文「仍未覆盖」。
- **实现偏离（第 3 步，2026-10-01，PR #454）**：生产的 `/mcp` 由委托 OAuth provider 接管，只接受 OAuth access token，直接的 `clued_bnd_` Binding token 会被 401 拒绝；因此 CI 不走 MCP，而是直接调 Clued 数据库 PostgREST 的 `clued_work_verify_v1`（公开 publishable key + Binding token 的 SHA-256，由数据库 `resolve_binding` 鉴权，与 Worker 内部走的是同一条路）。强制与否不跟随 `CLUED_WORK_CLAIMS_V1`，而是 Owner 的仓库变量 `CLUED_WORK_ADMISSION_ENFORCE=true`：未打开时 check 只做 advisory（有 claim 就把判定写进 summary，没有则报 NOT_ENFORCED，一律放行），避免迁移一应用就拦住所有 PR 而 Agent 还无法建 claim；打开后缺 trailer、REJECTED、RPC 缺失、token 被拒、传输错误一律 fail closed。

- **实现（第 7 步评审修复，2026-10-01，Owner Decision `64d9b418`，Task `95a93218`／`21a77b34`）**：
  - 评审发现原 check 在 `pull_request` 事件下运行 PR 自带的 workflow 与脚本，PR 可以改写判定。现改为 `pull_request_target`：workflow 与 `scripts/ci/clued-work-admission.mjs` 取自 base 分支，不 checkout、不执行 PR 代码，PR 只经 API 读取，每次运行重新读取，因此修改正文（`edited`）或重跑都看到当前 trailer 与 head。没有 `pull_request` 触发：改动本 workflow 文件的 PR 也由 base 分支上的版本判定。
  - 每次 verify 带 `pr_ref`（`owner/repo#n`）。第一个判定为 ADMITTED 的 PR 把 claim 绑定到自己（一条 `work_claim_bind_pr` 回执），之后其他 PR 引用同一 claim 返回 `claim_bound_to_other_pr`。这是 verify 唯一的写入，在 CI 持有的只读 Binding 下进行。接管或新 claim 从未绑定开始。
  - `clued-work-admission-reverify.yml` 每小时检查一次：对最近一次 admission 运行通过的未合并、非草稿 PR 重新判定，claim 已过期、释放、被接管或绑定到别的 PR 时重跑那次运行，使必需检查变红。判定过期的窗口因此不超过约一小时，合并时并不实时重验。
  - PR 文件列表少于 `changed_files`（API 3000 文件上限）时强制模式判 REJECTED（`changed_files_truncated`）。
  - **仍未覆盖**：
    - PR 可以新增另一个 workflow，其 job 也叫 `clued-work-admission`，两者都是 GitHub Actions 的 check run。**处理（Owner Decision `37e01bb1`，2026-10-02）**：仓库属个人账号且私有，没有组织 required workflows。准入 workflow 在判定后用 Owner 的专用 GitHub App 再发一个 `clued-admission-verified` check（`--mode app-check`，App 私钥只在 `clued-admission` environment 中）。Owner 建好 App、在 main ruleset 把该 check 设为必需并限定来源为该 App 后，PR 无法冒充。App 未配置时这一步只提示、不发检查。
    - L0b 的 `admission-gate` 仍是 PR 定义的 job，PR 可以删掉 `needs:`。**处理（同一决定）**：准入检查读取 PR 新增或改动的 workflow：base 上已有闸的 workflow，或新加的含自托管 job 的 workflow，必须保留与 `GATE_JOB_SHA256` 一致的 `admission-gate` job，其余每个 job 都 `needs` 它，且 `if:` 为闸条件 `&&` 一个整体括号组；否则判 REJECTED（`workflow_gate:<文件>:<原因>`），PR 无法合入。闸 job 改为检出 base 分支（或默认分支）代码，PR 改脚本也绕不过。已知代价：被拒的 PR 上，重任务在拒绝前可能已经跑过一次。base 上已有、本来不加闸的轻量 workflow（Owner Decision `75abfe80`）不在检查范围。修改闸 job 本身需两步：先在 `GATE_JOB_SHA256` 中加入新摘要并合入，再改各 workflow。
    - 任何同仓 PR 的 workflow 都能引用仓库 secret，所以 `CLUED_CONTEXT_READ_TOKEN` 只能靠 environment 限定加轮换保护。
- **实现（token 隔离，2026-10-02，Task `95a93218`，PR #479）**：
  - `admission-gate` 不再调用 Clued，也不再拿 `CLUED_CONTEXT_READ_TOKEN`（它跑的是 PR 的代码）。它等待本 head 上 `clued-work-admission.yml` 最新一次 `pull_request_target` 运行结束，只在该运行成功时放行；其他事件或其他 head 的运行不算。强制模式下等不到运行、到期仍未结束（默认 480 秒）或 GitHub API 出错都不放行；advisory 模式从不拦截。来自 fork 的 PR 可能拿不到仓库变量，所以闸对 fork PR 一律按强制处理，只跟随准入运行的结果；准入运行在 base 仓库读变量，advisory 时总是成功（Task `27b4f5e8` 第 11 条，2026-10-02）。
  - 只有跑 base 分支代码的 workflow 引用该 token：`clued-work-admission.yml`、`clued-work-admission-reverify.yml`，以及 PR #480 起的 `clued-work-admission-dispatch.yml`。三者都在 `clued-admission` environment 中运行。Owner 已（2026-10-02）将该 environment 的部署分支限定为 `main`、不设审批人，把 token 移为 environment secret、删除仓库 secret 并轮换；此后PR 新增或改写的 workflow（运行在 `refs/pull/N/merge`）即使声明该 environment 也拿不到 token。
  - 仓库检查（`scripts/ci/clued-work-admission.test.mjs`）断言只有上述 workflow 引用 `secrets.CLUED_CONTEXT_READ_TOKEN`。
  - 仍未覆盖：同名 check 伪造（见上）。另外 PR 可以改写自己的 workflow、删掉 `needs: admission-gate`：闸是 PR 自己的 job，只能控制合规 PR 的花费，不是强制边界。
- **实现（加闸范围与手动触发，2026-10-02，Owner Decision `75abfe80`，Task `29128827`）**：
  - 新增加闸：`public-mcp-behavior.yml`、`public-mcp-protocol.yml`（装依赖、起本地 MCP，behavior 还起数据库）。`model-program-*`、`mps03-native-agent`、`multitrack-governance-projection`、`node-profile-policy` 是几秒的 Python 校验，不加闸：闸任务本身的开销与等待超过它们。
  - 手动触发：Agent 用 Owner 账号，「只许 Owner 触发」不等于要求认领。`clued-g4-database`、`information-flow-e2e`、`clued-connection-authorization` 的 `workflow_dispatch` 现在要带 `admission_run_id`。流程两步：
    1. 在默认分支触发 `clued-work-admission-dispatch.yml`，参数 `workflow`（上述三者之一）、`ref`、`claim_id`（可选 `scope`）。它在 `clued-admission` environment 中持有 token，向 Clued 校验该 claim（`clued_work_verify_v1`，带 ref 的 head，不带 changed_paths），运行名为 `admit <workflow> <ref> <claim_id>`；不在默认分支时 job 不运行。
    2. 在该 ref 上触发重任务 workflow，`admission_run_id` 填第 1 步的 run id。其 `admission-gate`（无 token）只在该运行是默认分支上的 `workflow_dispatch`、成功、30 分钟内、运行名指向本 workflow 与本 ref 时放行。
  - 一次准入在 30 分钟内可用于同一 workflow 与 ref 的多次触发；claim 本身仍须有效（第 1 步校验时）。push 与定时事件不经此闸。
  - 合同 v12（`skills/clued/references/agent-contract.md` §1.7）写入这两步，并写明准入只在检查运行时判定、每小时复核（Task `ace2fb96`）。合同文本随 Worker 下发，Worker 发布前已部署的服务仍下发 v11。缺 `admission_run_id` 时闸的提示写明做法。

**L0b：重任务 workflow 的 `admission-gate` job**

- `information-flow-e2e.yml`、`clued-g4-database.yml`、`clued-cloud-node22-install.yml`、`clued-connection-authorization.yml`、`public-mcp-behavior.yml`、`public-mcp-protocol.yml` 这些自托管重任务加一个前置 job，与 L0a 同一脚本；`needs: admission-gate` 且 `if: needs.admission-gate.outputs.admitted == 'true'`。
- 未 admitted 的 PR 仍跑 gitleaks、trivy（它们是 required，且便宜），其余跳过并在 check summary 写"未被 claim 覆盖"。
- 这一层挡住的是本次事故中真实烧掉的东西：三份 PR 各自触发了 Information Flow E2E（12 分钟）、Supabase 栈、isolated-candidate。

**L1：Clued DB**

- 全部 RPC 为 `security definer`，revoke 客户端直接执行，与现有 `clued_private` 模式一致。
- claim、续期、释放、接管与 PR 绑定只写 `clued_audit_receipts`，不写 Event（Owner Decision `8f98387a`，2026-10-02，Task `27b4f5e8` 第 8 条）。原设计要求同时写 Event；改为只写 Receipt，因为写 Event 会让每次认领、续期、释放都使其他会话的 checkpoint 变 STALE 并刷满工作日志。谁在做什么由 resume 的 `active_work_claims` 提供。

**L2：合规路径**

- agent-contract §1 增加："任何会修改仓库文件、运行构建或测试、派发子任务的工作，先 `clued_work_claim`。返回冲突时停止，向 Owner 报告冲突 claim；不得换标题、换 Task、换 request key 重试。"
- `clued_session_resume` 返回 `contract_version`；Skill 比对本地 `agent-contract.md` 版本行，不一致则拒绝开工并说明。
- Agent 在 PR body 与最后一个 commit 的 trailer 写 `Clued-Work-Claim: <id>`。

**L3：Claude Code SessionStart + PreToolUse hook**

- SessionStart hook 调用 Clued 只读 API 取 `active_work_claims`，以附加上下文注入第一轮。模型在消耗第一个 token 之前就看到"谁在做什么、改哪些文件、何时到期"。这是本仓库内 Claude Code 会话能做到的最早一刻，仍属合规层：hook 可关、Host 可换。

- PreToolUse hook：匹配 Bash 中的 `git push`、`gh pr create`、`npm (ci|install|run build|test)`、`pytest`、`node --test`，以及 `mcp__github__create_pull_request`、`push_files`。2026-10-02 起（Task `27b4f5e8` 第 10 条）另匹配：任意 `npm run` 与 `npx` 脚本；`gh workflow run`、`gh run rerun` 与 MCP `actions_run_trigger`（启动 CI）；远程会话 `create_session`、`Workflow` 与非只读的 `Agent` 子任务（Explore、Plan 等只读子代理除外）；对仓库文件的 `Edit`／`Write`／`NotebookEdit`（`.clued/`、`.git/` 与仓库外路径除外）。没有 `CLUED_WORK_CLAIM` 环境变量或 `$CLAUDE_PROJECT_DIR/.clued/work-claim.json`（由 `clued_work_claim` 成功后写入）则阻止一次并提示先 claim。
- 与 Stop hook 同样可关、可删；标为 L3，不进任何"不可绕过"声明。
- **实现（第 6 步，2026-10-01，Owner Decision `9297922c`）**：`scripts/hooks/clued_work_claim_guard.py` 一个脚本按 `hook_event_name` 服务三个事件，由 `.claude/settings.json` 注册。SessionStart 注入 §1.7 规则与本 checkout 记录的有效认领；设了只读 Binding token `CLUED_CONTEXT_READ_TOKEN` 时，另经 PostgREST `clued_work_claims_active_v1`（公开配置读自 `app/supabase-public-config.ts`，只发 token 的 SHA-256）读取该用户全部有效认领，失败只降级为提示。PostToolUse 在 `clued_work_claim`／`renew`／`takeover`／`release` 成功后更新 `.clued/work-claim.json`（已 gitignore）。PreToolUse 在上述命令与 `mcp__*__create_pull_request`／`push_files`／`create_or_update_file` 前检查：没有有效认领、也没有 `CLUED_WORK_CLAIM` 时，「发布」与「花钱」两类各在每个会话拦一次。`CLUED_WORK_CLAIM_GUARD=off` 关闭。PreToolUse 不校验认领是否覆盖改动路径，这由 CI 的 `clued-work-admission` 负责。

### 4.7 不保护什么（必须原样写进任何完成声明）

- Host 在第一次调用 Clued 之前消耗的模型 token。
- 在 Host 本机运行的 install／build／test（除 Claude Code + hook 未关闭的情况）。
- 不调用 Clued、不开 PR 的工作（它们也不会消耗共享资源）。
- Owner 临时禁用 ruleset 期间的合并。
- 直接数据库／Storage／部署工具的管理员路径：各自有独立授权，本设计不覆盖。生产迁移的重复执行（2026-10-01 #435 迁移在 02:47 与 03:13 被两个会话各跑一次）由独立的迁移原子入口承接（Project Task `a15cb2d2`，候选、已暂停）；work claim 只保证改迁移文件的开发工作不重复，不保证迁移只被应用一次。两者互补，不合并。

---

## 5. 在 #443／#444／#445 上回放

| 时间 (UTC) | 事件 | 有本机制时 |
| --- | --- | --- |
| 04:0x | 会话 A（#443 作者）因 Trivy 变红决定附带升级 Next | 合规路径：`clued_work_claim(task=依赖守卫 Task, write_set += package.json/lock, trigger_refs += ghsa:GHSA-vcvr-r3jv-pc5j)` → ACTIVE，fence 1 |
| 04:1x | 会话 B（Codex，#444）开始安装依赖 | 合规路径：resume 已返回 A 的 claim 含同一 ghsa；或 `clued_work_claim` 返回 `work_claim_conflict`。B 停在 resume／claim，成本为零次构建。若 B 不合规继续推 PR：L0b 不跑重任务，L0a 不可合并 |
| 04:20 | 会话 C（Claude Code，#445）独立开出 | 同 B。C 的 gitleaks 失败本来就会跑；Information Flow E2E、Supabase、isolated-candidate 不会启动 |
| 之后 | A 的 claim 到期未续 | A 的 PR 无法合并；要么 A 续期带新 head，要么 B／C 对 EXPIRED claim 发起 takeover 并采纳 A 的分支 |

**实际（2026-10-02）**：「A 的 PR 无法合并」只在检查运行时成立。`clued-work-admission` 通过后，claim 过期并不会让已有的绿色检查自动变红。`clued-work-admission-reverify.yml` 每小时重跑一次，claim 已不再准入时把检查变红。所以在这次重跑前约一小时内，PR 仍可合并。

纪要第二节的三种情况：不同标题（trigger_refs 相交）、中途扩大范围（#443 扩大 write_set 时 renew 重新判冲突）、不同分支同一 lockfile（write_set 相交）都在 4.3 的三条规则内。

---

## 6. 验收矩阵映射（纪要第七节 → 测试点）

| 纪要故障／绕过 | 测试点 | 层 |
| --- | --- | --- |
| 无 Task、伪造 claim、漏报 write_set | `clued_work_verify` 对不存在／伪造 claim_id、变更文件 ⊄ write_set 返回 REJECTED；gate job 不放行 | L0／L1 |
| 重演 443／444：不同标题、同意图或同 lockfile | 两个 Binding 并发 `clued_work_claim`，相同 trigger_ref 或相交路径，恰一个 ACTIVE（barrier 测试，复用 projection-refresh-pipeline-db 的并发模式） | L1 |
| 同时领取、响应丢失后重试 | 同幂等键重试返回原 claim；不同键同资源返回 conflict | L1 |
| 过期 owner、网络分区、服务重启 | 过期 claim 的 fence 在 verify 下 REJECTED；takeover 后 fence +1；备份恢复后 `max(fence)` 不回退（迁移测试）。**实测：前两项通过；备份恢复后会回退，按已知限制由恢复后脚本补救，见 §4.4** | L1 |
| 持续 heartbeat 却无进展 | progress_ref 不变的 renew 被拒；到 hard_deadline 自动 EXPIRED | L1 |
| 非幂等请求成功但回包丢失 | claim 创建用幂等键；CI gate 对同一 head 重复查询返回同一判定 | L1／L0 |
| 多资源反序竞争、cleanup 崩溃 | write_set 整体一次事务；无逐路径锁；EXPIRED 清理不删 ACTIVE 行 | L1 |
| raw 工具修改后尝试整合、篡改 Receipt 或 verifier | 无 trailer 或 trailer 指向他人 claim 的 PR 在 L0a 失败；verifier 从 Clued 实时查，不读 PR 自报 | L0 |
| 权限撤销、approval 过期、预算耗尽 | Binding 撤销后 renew／claim 失败；预算超限 verify 返回 REJECTED 且无自动追加。**实测：Binding 撤销项通过（PR #467）；预算未实现，按 Decision `a264ea02` 改为次数上限，见 §4.5** | L1／L0 |

测试用可控时钟（`clock_timestamp` 由测试夹具注入或用 `pg_sleep` 边界）、并发 barrier、真实行计数与 Receipt。

---

## 7. 与 Owner 要求逐条对应

| Owner 要求 | 本设计 |
| --- | --- |
| 许可有时效，故障不能永久霸占任务 | 2 小时期限、24 小时 hard_deadline、12 次续期上限，全部来自 profile；过期自动 EXPIRED |
| 能崩溃恢复、接管，避免死锁与无界重试 | takeover 以 fence +1 接管；write_set 单事务获取；attempts_cap 有界。**实现（Owner Decision `a264ea02`）**：每 Task 24 小时最多 10 次认领或接管，每 claim 最多放行 20 个 PR head；CI 分钟不计（Task `80aea04a`） |
| 不能把 Agent 自觉遵守作为安全前提 | L0 由 GitHub ruleset 与 workflow 强制，L1 由 Postgres 强制；L2／L3 明确标为合规层 |
| 不能直到提交时才发现重复 | 合规 Agent 在 resume／claim 即发现（第一次 Clued 调用）；不合规 Agent 在 CI 第一个 job 被挡住重任务，而不是等到合并 |
| 先复用既有机制 | claim 表与 RPC 逐字复用 Projection Refresh 的 lease／attempt SQL 模式；预算复用 N4；身份复用 execution_intent；fence 语义复用 kernel approval-lease；门禁复用现有 ruleset |

---

## 8. 实施顺序

第 1–7 步均已执行。第 7 步的复审未做（Task `869d2db7`）；其余状态见文首「当前状态」。以下为原计划，保留原文。

1. 迁移（Task `ca767208`）：`work_claims_v1` 表 + 五个 RPC + Event／Receipt 接线；DB 测试覆盖第 6 节矩阵。
2. Worker（Task `ed816cd8`）：五个 MCP 工具；`clued_session_resume` 增加 `contract_version` 与 `active_work_claims`。
3. CI（Task `f6311ff5`）：`clued-work-admission.yml`（无过滤）+ 重任务 workflow 的 `admission-gate` job；只读 Binding secret。
4. ruleset（Decision `b12d4703`）：把 `clued-work-admission` 加入 required（Owner 操作）。
5. 合同（Task `29ad7d4e`）：agent-contract v7 §1 新增 claim 步骤；Skill 与 Worker 下发同步。
6. hook（Task `178ff66c`）：PreToolUse 候选。
7. 独立评审 + 第 6 节矩阵实测（Task `2a5ae9ce`；修复后复审 Task `869d2db7`）。

每一步都是独立 PR，每一步合入前都要先按本设计 claim 自己的 write_set。第 1 步之前，本文件只是候选。

---

## 9. 证据

- 全库只读扫描（2026-10-01，本会话委派的只读 agent）：MCP 工具目录 `apps/clued-cloud/worker/continuity.ts:1115-1415` 无 claim／lease／admit 工具；`lease_id`／`lease_expires_at` 列仅存在于 projection refresh job 表；kernel lease／budget 模块仅被 `evals/kernel-next/*` 引用；`.claude/settings.json` 仅 Stop hook。
- Projection Refresh 实现说明：`apps/clued-cloud/docs/model-program-m0/post-commit-projection-refresh.md`；精确 key 租约：`apps/clued-cloud/supabase/migrations/20260923213100_projection_refresh_exact_key_lease.sql`。
- N4 预算：`apps/clued-cloud/supabase/migrations/20260930200000_storage_read_budget_n4.sql`。
- execution_intent：`apps/clued-cloud/supabase/migrations/20260922143312_context_v2_execution_intent_identity.sql`。
- Kernel：`kernel/policy/approval-lease.mjs`、`kernel/domain/attempt-fsm.mjs`、`kernel/runtime/external-invocation-ledger.mjs`；`protocol/continuity/v1/profiles/execution.profile.json`（`runtime_selected=false`）。
- Git Connector 合同：`development/contracts/repository/GitConnectorWriteContract.v0.1.md`。
- WorkLease 候选：`artifacts/clued-validation/structure-freeze-prep/acceptance-20260907/step2/package-inputs/Clued_Phase2_结构准备设计_候选_v0.1.4_20260906.md` §4.2、§12。
- PR 事实：Clued Note `46f46fed-f464-487b-8c4d-ca97436ab140`；整合顺序 Decision `8b22f847-9a32-4ea7-8f8e-03654d0b1d6f`；暂停与豁免 Decision `93eb4e76-bc36-452b-9813-a521a5b648d3` v3。
