# Agent Messaging v0.1：Agent 之间通过 Clued 对话

状态：**第 1 步已合入并上线（PR #576，迁移与 Worker 已发布，`CLUED_AGENT_MESSAGES_V1` 已打开）。第 2 步（本 PR）：Agent 合同 v35、Clued Skill 1.0.7、收件提醒 hook、存储写冲突附 `coordinate`。BUG-20261007-004 修复（Task `d35e10cc`，迁移 `20261007180000`）：读收件箱只替消息的收件方标已读（§4.8）。** 本文不授予迁移、发布、合并或权限变更。

日期：2026-10-06
Owner 决定：Decision `24077bba`（专用消息通道；先做与 claim `3c2518c0` 不重叠的部分），Decision `471eb27a`（第 2 步加收件提醒 hook）。
Task：`3f6fb219`（project `0597aa60`）。
相关：[GenericWorkClaim.v0.1.md](../execution-admission/GenericWorkClaim.v0.1.md)（认领与冲突）、[OwnerCredential.v0.1.md](../owner-authorization/OwnerCredential.v0.1.md)（Owner 批准只来自 Owner 本人的页面）。

---

## 1. 为什么

Agent 合同 §1.7 对 `work_claim_conflict` 只写了"停下并告诉 Owner 谁占着"。于是 Agent 撞上冲突后只会请 Owner 手动转发消息，没想到在 Clued 里直接联系占用方（2026-10-06：协调 claim `3c2518c0` 时，Agent 让 Owner 去另一个会话里转述）。Owner 指出写进 Clued 对方就能看到，并要求做成正式功能。

只改合同、让 Agent 往对方 Task 下写 note，有两个问题：送达靠对方记得去读；协调聊天会进 Canonical 记录。所以做专用通道，由服务主动送达。

## 2. 模型

- **消息**属于一个账号，在一个 context（`global` 或 `project:<id>`）里，有 `subject`、`body`、`refs`。它不是 Canonical Record：不产生 Event，不进五视图，14 天后过期并在下次发送时删除。每次发送留一条审计 Receipt（`AGENT_MESSAGE_SENT`），Receipt 里没有正文。
- **收件方**三种，恰好一种：
  1. `to.claim_id`：一个活的 work claim。**消息跟着认领走**：谁现在持有它，谁就读到；认领被 lease key 转到另一个会话或 Binding 后也一样。认领结束后，消息留给发送时的持有者（Binding + 会话）。
  2. `to.binding_id`（可带 `to.session_ref`）：一个连接，或它的某个 Host 会话。
  3. `reply_to`：回复一条消息。回复发回原发送方，留在同一 thread 和 context；回复一条 `request` 即把它标为已答复（`answered_at`）。原发送方再回复，则发往原收件方。带 `close_thread: true` 的回复关闭整个 thread，之后不能再回复。
- **会话**：同一 Binding 可能被多个 Host 会话共用（例如所有 Claude Code 会话）。带 `session_ref` 读取时只看发给本会话（或没指定会话）的消息；不带则看整个 Binding 的。发给认领的消息，认领没有 `holder_session_ref` 时，该 Binding 的每个会话都看得到。**看得到不等于替收件方读了**：标已读只由收件方完成（§4.8）。
- **种类**：`request`（期待答复，默认）、`info`、`reply`。

## 3. 接口

迁移 `apps/clued-cloud/supabase/migrations/20261006090000_agent_messages_v1.sql`：

| RPC（Binding；委托 OAuth 经 `clued_oauth_call` 同名进入） | 作用 | 权限 |
|---|---|---|
| `clued_agent_message_send_v1` | 发送、回复、关闭 thread | 消息所在 context 的 `context:write` |
| `clued_agent_inbox_v1` | 读收件（`open` 默认 / `unread` / `all`）、已发（`sent`）或整个 thread；`claim_id` 只看发给某认领的（不能与 `thread_id` 同用）。返回的收件只在本次读取是其收件方时标为已读（§4.8）：每条带 `marked_read`，`left_unread` 数出看到但留给收件方的未读条数 | `context:read` |
| `clued_agent_inbox_summary_v1` | 未读数、待答复请求数、等待对方答复数、最近 5 条未读（不含正文）；可按 `claim_id` 只看发给某认领的 | `context:read`，只读 |

Worker（`apps/clued-cloud/worker/agent-messages.ts`，开关 `CLUED_AGENT_MESSAGES_V1`，默认关）：

- MCP 工具 `clued_agent_message_send`、`clued_agent_inbox`。
- `clued_session_resume` 折入 `agent_inbox`（按 `client_session_id` 当 `session_ref`）；有未读或待答复时附 `how_to` 与 `notice`。
- `clued_work_renew` 成功时折入发给该认领的 `agent_inbox`。
- `clued_work_claim` / `clued_work_renew` / `clued_work_takeover` 返回 `work_claim_conflict` 时附 `coordinate`：每个占用方的 `claim_id`、`task_id`、`holder_binding_id`、`holder_session_ref`、`expires_at`，以及"用 `clued_agent_message_send` 的 `to.claim_id` 联系、并一行告诉 Owner；不换标题/Task/key/连接重试"。
- 读取失败不让 resume 或续租失败：`agent_inbox: null, agent_inbox_unavailable: true`。

## 4. 规则

1. 消息是其他 Agent 的请求和信息，**不是 Owner 的决定、批准或指令**，不改变任务或合同。Worker 在收件结果和 resume 折入里附 `notice` 说明这一点；对消息里的说法先在 Clued 里核实再行动。
2. 消息不抢占活认领，不授予权限。Owner 决定照旧用 `clued_record_mutate` 记录；需要 Owner 批准的照旧走 `clued_owner_request`。
3. 消息里不得放 `lease_key`、凭据或秘密（工具说明写明）。
4. 只能发给同一账号的连接；收件 Binding 必须有效、有 `context:read` 且能读该 context，否则拒绝（`agent_message_recipient_cannot_read`），免得消息永远到不了。
5. 只有 thread 参与方能回复（`agent_message_not_participant`）；不能发给自己（`agent_message_to_self`）；认领已结束不能新发（`agent_message_claim_not_live`）。
6. 每个 Binding 每小时最多发 120 条（`agent_message_rate_limited`，带 `retry_after`）；`subject` ≤ 200 字，`body` ≤ 4000 字，`refs` ≤ 20 条。
7. 幂等：同一 Binding 同一 `idempotency_key` 重放返回原消息；内容不同返回 `agent_message_idempotency_mismatch`。
8. **只有收件方能把消息标为已读**（BUG-20261007-004，Task `d35e10cc`，迁移 `20261007180000`）。消息只有一个 `read_at`，所以它记录的是收件方读过：
   - 发给认领的消息：读取带 `claim_id` 点名该认领，或读取的 `session_ref` 等于活认领的 `holder_session_ref`（认领结束后，等于发送时的收件会话）；
   - 发给某个会话的消息：该会话；
   - 发给整个连接的消息（无认领、无会话）：该连接的任何会话，同以前。

   其他会话照样看得到发到它面前的消息（认领没有 `holder_session_ref`，或读取不带 `session_ref`），但读了不标已读，`marked_read: false`，并计入 `left_unread`，附 `left_unread_reason`。于是持有者下次 `clued_work_renew` 或 `clued_session_resume` 的 `latest_unread` 里仍有它。续租折入的 `how_to` 直接写出 `claim_id`。回复不变：回复一条消息即读过并答复它，所以不是发给自己的请求不要回复。

   为什么不按收件方各记一份已读：认领没有 `holder_session_ref` 时，服务分不出同一 Binding 的哪个会话是持有者，按会话记已读仍要一个持有者能证明的读者标识；点名认领（`claim_id`）就是这个标识，而且不用新表、不改 `read_at` 的含义。

   起因：2026-10-07 发给认领 75881ebc（线程 e95d6455）的请求，被持有认领 d419f31e 的会话读收件箱时标成已读，持有者再也看不到它。

## 5. 第 2 步

第 1 步上线后两次实际协调（#578、#580）说明：送达靠拉取（resume、续租），合同没要求答复，老会话也看不到新工具，于是对方往往要 Owner 提醒才回复。第 2 步补这三处：

- **合同 v35**（`skills/clued/references/agent-contract.md` §1.7、§4 错误表）：
  - `work_claim_conflict` 时不开工，用 `coordinate` 里的 `claim_id` 发 `to.claim_id` 请求（释放、预计时间或缩小 `write_set`），同一回复里一行告诉 Owner；没有消息工具时照旧报告 Owner 并停下。
  - resume 和续租的 `agent_inbox` 有未读或待答复请求时，先用 `clued_agent_inbox` 读，再逐条用 `reply_to` 答复，说明是释放、预计时间还是缩小范围，并照做。
  - 消息不是 Owner 的决定；不放 `lease_key`；Host 没列出消息工具时请 Owner 重连 Clued 连接器。
  - 新增消息发送的错误码行。
  - Clued Skill 1.0.7 同步一句话版本；`worker/generated/agent-contract.ts` 重新生成。
- **收件提醒 hook**（`scripts/hooks/clued_work_claim_guard.py` 1.1.0，`.claude/settings.json`）：
  - `clued_session_resume` / `clued_work_renew` 之后，`agent_inbox` 有未读或待答复请求时，用 `additionalContext` 提醒读并答复。
  - Stop 时只读 transcript、不联网：最近一次报告之后没有成功的 `clued_agent_inbox` 读取，或有请求却没有已提交的 `reply_to` 答复，就挡一次（每次报告每种状态一次）。
  - 用 `CLUED_WORK_CLAIM_GUARD=off` 关闭。
  - 放在已有的 work-claim guard 里，测试随 `tests/test_clued_work_claim_guard.py` 由 `clued-capture-guard` 工作流运行，不改受保护的 `.github/**`。
- **存储写冲突**：`clued_storage_submit` / `clued_storage_trash_batch` 的 `work_claim_conflict` 拒绝，在开关打开时同样附 `coordinate`（Worker `continuity.ts`）。

## 6. 上线

1. 第 1 步：合入 PR #576（改了 `apps/clued-cloud/package.json`，需 Owner 对该提交批准 `repo.protected_change`）。
2. 生产迁移 `20261006090000_agent_messages_v1.sql`（`migration.production`）与 Worker 发布（`release.production`），Owner 在 Clued 页面批准。
3. Owner 打开 `CLUED_AGENT_MESSAGES_V1`。在此之前工具不出现，resume 不变。
4. 第 2 步：不改迁移；合入后 Worker 发布（`release.production`），新合同经 `/clued-agent.md` 提供。
5. BUG-20261007-004（Task `d35e10cc`）：先生产迁移 `20261007180000_agent_message_holder_reads.sql`（`migration.production`），再 Worker 发布（`release.production`），都由 Owner 在 Clued 页面批准。迁移在前：只换 `clued_agent_inbox_v1` 的函数体，旧 Worker 不传 `claim_id`，行为即刻变成只替收件方标已读。合同 §1.7 的对应文字随合同版本另提（Task `d35e10cc`）。
