# Work Claim Admission v0.1：多 Agent 执行准入与费用保护机制候选

状态：**CANDIDATE / NOT IMPLEMENTED / NOT REVIEWED**
日期：2026-10-01
来源：Owner 上传的《Clued 多 Agent 执行协调与费用保护：讨论纪要与既有机制对账》（2026-10-01）的重新评估，以及对纪要第九节源码与合同的只读对账（固定在 commit `f7ba6ff312aa0e90095db1e28f5937920f30de3a`）。
治理：Global Decision `93eb4e76-bc36-452b-9813-a521a5b648d3` v3（暂停新增实施与评审派发；本次只读评估与机制设计豁免）。本文件不授予实施、合并、部署或权限变更；不是架构接受。

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
| L0 | 自托管 CI 重任务（Information Flow E2E、Supabase migration/pgTAP、isolated-candidate、node22-install、model-program harness） | workflow 首个 job `admission-gate`（GitHub 托管 runner，秒级） | **是** | 未被 claim 覆盖的 PR 只跑 gitleaks、trivy 和 gate 本身；重任务不启动 |
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
| `clued_work_verify` | 只读。输入 claim_id、head_sha、base_sha、changed_paths[]；返回 ADMITTED / REJECTED 及原因。供 CI gate 与 required check 调用，使用只读 Binding。 | 只读 |
| `clued_work_takeover` | 对 EXPIRED 或 DRAINING claim 发起接管：新 claim 以 fence +1 创建，旧 claim 标 SUPERSEDED。不自动触发，只由新持有者显式调用；Owner 决定或 profile 允许时才可对未过期 claim 强制接管。 | 单事务 |

`clued_session_resume` 增加返回：`contract_version`、`active_work_claims`（本用户所有 ACTIVE claim 的 task_id、write_set、trigger_refs、expires_at）。合规 Agent 在 resume 时就能比对自己的意图。

### 4.3 冲突判定（确定性，不靠语义理解）

两个 claim 冲突，当且仅当满足任一：

1. **同一 task_id**：已有 ACTIVE／DRAINING claim（这是 execution_intent 唯一性的执行层延伸）。
2. **write_set 路径重叠**：规范化后任一路径或 glob 相交。`apps/clued-cloud/package-lock.json` 这类共享文件会直接相交。
3. **trigger_refs 重叠**：任一规范化触发源相同。#443／#444／#445 都会写 `ghsa:GHSA-vcvr-r3jv-pc5j` 或 `ci:trivy@f7ba6ff`，在第二份 claim 时即冲突，与标题无关。

**实现（第 7 步评审修复，2026-10-01，迁移 `20261002050000`，Task `047e663e`）**：第 2 条最初只检查「一侧的 glob 覆盖另一侧的字面路径」，两个 glob 之间不比较，`apps/clued-cloud/**` 与 `**/package-lock.json` 不冲突。现按路径段比较：含 `**` 的段匹配任意多段；两个单段通配只要字面前缀与后缀相容就算相交。判定偏向「相交」：可能把两个实际不共享路径的 glob 判为冲突，不会漏判。

不做：标题相似度、语义去重、自动合并意图。语义不明确时 Agent 可以用 `clued_search_context` 做有上限的探索，但那不是准入判断。

### 4.4 租约、续期、过期、接管、fence

- **期限来自 profile**，不是无限 TTL：默认 claim 期限 2 小时，hard_deadline 24 小时，最多续期 12 次。数值在 `protocol/.../work-claim.profile.json` 中定义并随测试接受；缺省配置视为失败，不视为无限。
- **续期必须带进展**：heartbeat 不是进展。progress_ref 不变即拒绝续期，到期自然过期。这直接回答"持续 heartbeat 却无进展"。
- **过期只拒绝新效果，不证明旧进程停止**：过期后 claim 进入 EXPIRED；旧持有者的分支仍存在，但其 claim_id + fence 在 `clued_work_verify` 下 REJECTED，无法通过 L0。它不能再续期，只能对新 claim 发起"采纳分支"请求（人工或新持有者决定）。
- **fence 单调**：只在 claim 创建与 takeover 时 +1；续期不动。服务恢复、备份回滚不得回退 fence：fence 来源于 `max(fence)+1` 的事务内计算，不来自客户端。
- **多资源一次性获取**：write_set 整体在一个事务中判定，没有逐路径加锁，没有持锁等锁，不会死锁。
- **优先级不抢占**：Global Frontier 的 Pin 或 priority 变化不自动 takeover 一个 ACTIVE claim。

### 4.5 预算

复用 N4 模式：

- **每 Binding 并发 claim 上限**（默认 3）：一个失控 Host 不能把所有 Task 都占了。
  - **实现（2026-10-02，Owner Decision `533a5286`，迁移 `20261002060000`）**：改为每个会话（Agent 自报的 `holder_session_ref`）最多 3 个活认领、每个 Binding 合计最多 10 个。原因：Owner 的所有 Claude Code 会话共用一个 Binding，原来的「每 Binding 3 个」会让并行会话互相挤占。会话标识是自报的，所以保留 Binding 总上限兜底；没有 `holder_session_ref` 的认领单独算一组。拒绝时 `limit` 字段写明撞到的是哪个上限。
- **每 claim CI 分钟上限**：`admission-gate` 在放行重任务前调用 `clued_work_verify` 并上报本次预计分钟数；超出上限返回 REJECTED，重任务不启动。实际消耗由 workflow 完成后以 observed 回写（finalize）。
- **模型 token**：claim 只记录 Agent 自报的估算，标为 `declared_unenforced`。不宣称预留。
- 取消、失联或 UNKNOWN 时**不释放预留**；只有 finalize 或 takeover 事务才结算。

### 4.6 执行层细节

**L0a：`main` required check `clued-work-admission`**

- 一个无路径过滤的 workflow，GitHub 托管 runner，只做一次 HTTPS 调用 `clued_work_verify`（只读 Binding 放在 GitHub secret）。
- 输入：PR head SHA、base SHA、变更文件集（`gh api .../files`）、PR body 或最后一个 commit trailer 中的 `Clued-Work-Claim: <claim_id>`。
- 判定：claim ACTIVE 或 DRAINING 且未过期；holder 不校验 GitHub 身份（都是 Owner），校验 fence 为该 task 当前最大；变更文件集 ⊆ write_set；base_sha 等于或晚于 claim.base_commit。任一不满足 → 失败并写明原因。
- 范围扩张（变更文件超出 write_set）→ 失败，提示先 `clued_work_renew` 携带扩大的 write_set（扩大时重新做冲突判定）。
- 加入 ruleset required 列表后，这条和 gitleaks、trivy 一样是无过滤 check，不会出现"等不到"的问题。
- 同一 check 顺带输出一张汇总表：按本 PR 变更路径判定哪些路径过滤的 workflow **适用**、各自在当前 head 上的结论、哪些**不适用**。这就是 2026-10-01 根因审计第 4 项要的"始终返回结果的汇总检查"，不必另开一个。
- 自报 JSON、同名 check、伪造签名不算：check 由 workflow 从 Clued 实时查询，Receipt 在 Clued 侧。
- **实现偏离（第 3 步，2026-10-01，PR #454）**：生产的 `/mcp` 由委托 OAuth provider 接管，只接受 OAuth access token，直接的 `clued_bnd_` Binding token 会被 401 拒绝；因此 CI 不走 MCP，而是直接调 Clued 数据库 PostgREST 的 `clued_work_verify_v1`（公开 publishable key + Binding token 的 SHA-256，由数据库 `resolve_binding` 鉴权，与 Worker 内部走的是同一条路）。强制与否不跟随 `CLUED_WORK_CLAIMS_V1`，而是 Owner 的仓库变量 `CLUED_WORK_ADMISSION_ENFORCE=true`：未打开时 check 只做 advisory（有 claim 就把判定写进 summary，没有则报 NOT_ENFORCED，一律放行），避免迁移一应用就拦住所有 PR 而 Agent 还无法建 claim；打开后缺 trailer、REJECTED、RPC 缺失、token 被拒、传输错误一律 fail closed。

- **实现（第 7 步评审修复，2026-10-01，Owner Decision `64d9b418`，Task `95a93218`／`21a77b34`）**：
  - 评审发现原 check 在 `pull_request` 事件下运行 PR 自带的 workflow 与脚本，PR 可以改写判定。现改为 `pull_request_target`：workflow 与 `scripts/ci/clued-work-admission.mjs` 取自 base 分支，不 checkout、不执行 PR 代码，PR 只经 API 读取，每次运行重新读取，因此修改正文（`edited`）或重跑都看到当前 trailer 与 head。只有改动本 workflow 文件的 PR 还会经 `pull_request` 触发一次，同样只执行 base 代码。
  - 每次 verify 带 `pr_ref`（`owner/repo#n`）。第一个判定为 ADMITTED 的 PR 把 claim 绑定到自己（一条 `work_claim_bind_pr` 回执），之后其他 PR 引用同一 claim 返回 `claim_bound_to_other_pr`。这是 verify 唯一的写入，在 CI 持有的只读 Binding 下进行。接管或新 claim 从未绑定开始。
  - `clued-work-admission-reverify.yml` 每小时检查一次：对最近一次 admission 运行通过的未合并、非草稿 PR 重新判定，claim 已过期、释放、被接管或绑定到别的 PR 时重跑那次运行，使必需检查变红。判定过期的窗口因此不超过约一小时，合并时并不实时重验。
  - PR 文件列表少于 `changed_files`（API 3000 文件上限）时强制模式判 REJECTED（`changed_files_truncated`）。
  - **仍未覆盖**：
    - PR 可以新增另一个 workflow，其 job 也叫 `clued-work-admission`，两者都是 GitHub Actions 的 check run。要堵住需要 PR workflow 无法使用的检查身份（GitHub App，或 required workflows），属 Owner 在仓库外的设置。
    - L0b 的 `admission-gate` 仍是 PR 定义的 job，PR 可以删掉 `needs:`。
    - 任何同仓 PR 的 workflow 都能引用仓库 secret，所以 `CLUED_CONTEXT_READ_TOKEN` 只能靠 environment 限定加轮换保护。

**L0b：重任务 workflow 的 `admission-gate` job**

- 现有 `information-flow-e2e.yml`、`clued-g4-database.yml`、`clued-cloud-node22-install.yml`、`model-program-*.yml` 等自托管重任务加一个前置 job，与 L0a 同一脚本；`needs: admission-gate` 且 `if: needs.admission-gate.outputs.admitted == 'true'`。
- 未 admitted 的 PR 仍跑 gitleaks、trivy（它们是 required，且便宜），其余跳过并在 check summary 写"未被 claim 覆盖"。
- 这一层挡住的是本次事故中真实烧掉的东西：三份 PR 各自触发了 Information Flow E2E（12 分钟）、Supabase 栈、isolated-candidate。

**L1：Clued DB**

- 全部 RPC 为 `security definer`，revoke 客户端直接执行，与现有 `clued_private` 模式一致。
- claim 行的创建同时写 Event + Receipt，复用现有 mutation contract。

**L2：合规路径**

- agent-contract §1 增加："任何会修改仓库文件、运行构建或测试、派发子任务的工作，先 `clued_work_claim`。返回冲突时停止，向 Owner 报告冲突 claim；不得换标题、换 Task、换 request key 重试。"
- `clued_session_resume` 返回 `contract_version`；Skill 比对本地 `agent-contract.md` 版本行，不一致则拒绝开工并说明。
- Agent 在 PR body 与最后一个 commit 的 trailer 写 `Clued-Work-Claim: <id>`。

**L3：Claude Code SessionStart + PreToolUse hook**

- SessionStart hook 调用 Clued 只读 API 取 `active_work_claims`，以附加上下文注入第一轮。模型在消耗第一个 token 之前就看到"谁在做什么、改哪些文件、何时到期"。这是本仓库内 Claude Code 会话能做到的最早一刻，仍属合规层：hook 可关、Host 可换。

- PreToolUse hook：匹配 Bash 中的 `git push`、`gh pr create`、`npm (ci|install|run build|test)`、`pytest`、`node --test`，以及 `mcp__github__create_pull_request`、`push_files`。没有 `CLUED_WORK_CLAIM` 环境变量或 `$CLAUDE_PROJECT_DIR/.clued/work-claim.json`（由 `clued_work_claim` 成功后写入）则阻止一次并提示先 claim。
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

纪要第二节的三种情况：不同标题（trigger_refs 相交）、中途扩大范围（#443 扩大 write_set 时 renew 重新判冲突）、不同分支同一 lockfile（write_set 相交）都在 4.3 的三条规则内。

---

## 6. 验收矩阵映射（纪要第七节 → 测试点）

| 纪要故障／绕过 | 测试点 | 层 |
| --- | --- | --- |
| 无 Task、伪造 claim、漏报 write_set | `clued_work_verify` 对不存在／伪造 claim_id、变更文件 ⊄ write_set 返回 REJECTED；gate job 不放行 | L0／L1 |
| 重演 443／444：不同标题、同意图或同 lockfile | 两个 Binding 并发 `clued_work_claim`，相同 trigger_ref 或相交路径，恰一个 ACTIVE（barrier 测试，复用 projection-refresh-pipeline-db 的并发模式） | L1 |
| 同时领取、响应丢失后重试 | 同幂等键重试返回原 claim；不同键同资源返回 conflict | L1 |
| 过期 owner、网络分区、服务重启 | 过期 claim 的 fence 在 verify 下 REJECTED；takeover 后 fence +1；备份恢复后 `max(fence)` 不回退（迁移测试） | L1 |
| 持续 heartbeat 却无进展 | progress_ref 不变的 renew 被拒；到 hard_deadline 自动 EXPIRED | L1 |
| 非幂等请求成功但回包丢失 | claim 创建用幂等键；CI gate 对同一 head 重复查询返回同一判定 | L1／L0 |
| 多资源反序竞争、cleanup 崩溃 | write_set 整体一次事务；无逐路径锁；EXPIRED 清理不删 ACTIVE 行 | L1 |
| raw 工具修改后尝试整合、篡改 Receipt 或 verifier | 无 trailer 或 trailer 指向他人 claim 的 PR 在 L0a 失败；verifier 从 Clued 实时查，不读 PR 自报 | L0 |
| 权限撤销、approval 过期、预算耗尽 | Binding 撤销后 renew／claim 失败；预算超限 verify 返回 REJECTED 且无自动追加 | L1／L0 |

测试用可控时钟（`clock_timestamp` 由测试夹具注入或用 `pg_sleep` 边界）、并发 barrier、真实行计数与 Receipt。

---

## 7. 与 Owner 要求逐条对应

| Owner 要求 | 本设计 |
| --- | --- |
| 许可有时效，故障不能永久霸占任务 | 2 小时期限、24 小时 hard_deadline、12 次续期上限，全部来自 profile；过期自动 EXPIRED |
| 能崩溃恢复、接管，避免死锁与无界重试 | takeover 以 fence +1 接管；write_set 单事务获取；attempts_cap 有界 |
| 不能把 Agent 自觉遵守作为安全前提 | L0 由 GitHub ruleset 与 workflow 强制，L1 由 Postgres 强制；L2／L3 明确标为合规层 |
| 不能直到提交时才发现重复 | 合规 Agent 在 resume／claim 即发现（第一次 Clued 调用）；不合规 Agent 在 CI 第一个 job 被挡住重任务，而不是等到合并 |
| 先复用既有机制 | claim 表与 RPC 逐字复用 Projection Refresh 的 lease／attempt SQL 模式；预算复用 N4；身份复用 execution_intent；fence 语义复用 kernel approval-lease；门禁复用现有 ruleset |

---

## 8. 实施顺序（候选，不启动）

1. 迁移：`work_claims_v1` 表 + 五个 RPC + Event／Receipt 接线；DB 测试覆盖第 6 节矩阵。
2. Worker：五个 MCP 工具；`clued_session_resume` 增加 `contract_version` 与 `active_work_claims`。
3. CI：`clued-work-admission.yml`（无过滤）+ 重任务 workflow 的 `admission-gate` job；只读 Binding secret。
4. ruleset：把 `clued-work-admission` 加入 required（Owner 操作）。
5. 合同：agent-contract v7 §1 新增 claim 步骤；Skill 与 Worker 下发同步。
6. hook：PreToolUse 候选。
7. 独立评审 + 第 6 节矩阵实测。

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
