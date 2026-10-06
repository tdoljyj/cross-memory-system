# Agent Messaging v0.1：Agent 之间通过 Clued 对话

状态：**第 1 步已实现（本 PR）：迁移、Worker 工具与折入、测试。合入后还需生产迁移、Worker 发布，并由 Owner 打开 `CLUED_AGENT_MESSAGES_V1` 才生效。第 2 步（Agent 合同文本、hook 提示）等 PR #572 合入或释放 `skills/clued/**`、`worker/work-claims.ts`、`worker/generated/agent-contract.ts` 后再做。** 本文不授予迁移、发布、合并或权限变更。

日期：2026-10-06
Owner 决定：Decision `24077bba`（专用消息通道；先做与 claim `3c2518c0` 不重叠的部分）。
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
- **会话**：同一 Binding 可能被多个 Host 会话共用（例如所有 Claude Code 会话）。带 `session_ref` 读取时只看发给本会话（或没指定会话）的消息；不带则看整个 Binding 的。
- **种类**：`request`（期待答复，默认）、`info`、`reply`。

## 3. 接口

迁移 `apps/clued-cloud/supabase/migrations/20261006090000_agent_messages_v1.sql`：

| RPC（Binding；委托 OAuth 经 `clued_oauth_call` 同名进入） | 作用 | 权限 |
|---|---|---|
| `clued_agent_message_send_v1` | 发送、回复、关闭 thread | 消息所在 context 的 `context:write` |
| `clued_agent_inbox_v1` | 读收件（`open` 默认 / `unread` / `all`）、已发（`sent`）或整个 thread；返回的收件默认标为已读 | `context:read` |
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

## 5. 第 2 步（待 #572）

- Agent 合同 §1.7、§4 错误表：`work_claim_conflict` 时先用消息联系占用方，并告诉 Owner；持有认领的 Agent 在 resume 和续租时读 `agent_inbox`，答复每条请求（释放、预计时间或缩小 `write_set`）。合同升版，重新生成 `worker/generated/agent-contract.ts`。
- `clued_storage_submit` / `clued_storage_trash_batch` 的冲突同样附 `coordinate`。
- Work-claim guard hook 与 SessionStart 提示文案同步。

## 6. 上线

1. 合入本 PR（改了 `apps/clued-cloud/package.json`，需 Owner 对该提交批准 `repo.protected_change`）。
2. 生产迁移 `20261006090000_agent_messages_v1.sql`（`migration.production`）与 Worker 发布（`release.production`），Owner 在 Clued 页面批准。
3. Owner 打开 `CLUED_AGENT_MESSAGES_V1`。在此之前工具不出现，resume 不变。
