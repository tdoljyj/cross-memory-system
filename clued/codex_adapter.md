# Clued v0.1 · Codex 参考适配器（Codex Agent Adapter）

> 本文件是 Codex 智能体在对话中接入 Clued 的参考适配器指令。核心逻辑
> （生命周期、认证、熔断、Pending Journal、恢复、卸载）全部在可复用核心
> `clued/` 中实现，本适配器只做意图 → 命令映射与状态呈现，禁止在对话提示
> 词里重写认证/同步逻辑（协议 §16.1.6 / §23）。

## 0. 适配器职责（协议 §16.1）

1. 识别明确的安装、状态、同步和卸载意图；
2. 为当前 Codex 实例解析稳定的 agent instance 标识：
   `agent-type=codex`、`agent-instance=<机器名>:codex`（如 `TURING:codex`）；
3. 为每个新对话生成/接收新的 `session_id`（UUIDv4，不得跨对话复用）；
4. 在第一次 Memory Access 前调用 `auth check`；
5. 根据机器可读状态选择在线、降级或锁定路径；
6. 把用户操作转换为核心命令，不自行实现第二套同步逻辑；
7. 将降级、待同步和冲突状态用自然语言准确呈现；
8. 支持在对话中卸载当前 Binding；
9. 卸载后移除自己的 hook/instruction/tool registration；
10. 不更改其他 Codex 实例或其他 Agent 的 Binding。

## 1. 命令入口

Clued 核心已随仓库部署；Codex 端执行：

```text
python "<克隆根>\clued.py" <command> ... --json
```

`--json` 模式下 stdout 只输出一个 JSON 信封（协议 §13.1）；诊断在 stderr。
信封字段：`ok / code / state / message / data / actions / retry_after_seconds`。
`ok=false` 时退出码非零（§13.2）。

## 2. 意图识别表（§1.1 / §6.1）

| 用户表达 | 命令 |
|---|---|
| “安装 Clued” / “给我装 Clued” | `install --agent-type codex --agent-instance <id> --session-id <sid> --json` |
| “检查 Clued 状态” / “Clued 状态” | `status --json`（无需认证，§7.1 MAY） |
| “连接我的 Clued” / “Clued 还能用吗” | `auth check --binding-id <id> --session-id <sid> --json` |
| “立即同步 Clued” / “重新连接” | `sync --binding-id <id> --session-id <sid> --json` |
| “从这个智能体卸载 Clued” | `uninstall --binding-id <id> --session-id <sid> --json`（默认 detach-current-agent） |
| 记忆读/写 | `memory recall/add/update/supersede/delete ... --binding-id <id> --session-id <sid> --json` |

**红线**：用户只是询问 Clued（“这是什么/怎么用”）时禁止自动安装（§6.1）；
安装前必须说明：为“当前智能体”创建独立 Binding、同节点其他智能体不会自动
安装、使用当前 Canonical Store、需要一次标准认证、不会把密码/令牌保存到对话。

## 3. 会话与 Binding 管理

- 每个新对话生成新 `session_id`（UUIDv4），对话内复用；新对话必须新 id
  （协议 §5.1 / §7.1 不可跨会话复用）；
- 本机 Binding 从 `status --json` 的 `data.bindings` 解析：取
  `agent_type=codex` 且 `agent_instance_label` 匹配当前实例的 `binding_id`；
- 同一 Codex 实例重复安装 → 核心返回 `ALREADY_INSTALLED`（轻量验证）；
  出现多个同实例 Binding → 核心返回 `BINDING_CONFLICT`，适配器必须如实
  呈现并停止，不得自行选一个覆盖（§6.5）。

## 4. 状态呈现模板（§16.3）

| 核心状态 | 向用户呈现 |
|---|---|
| `ONLINE_SYNCED` | Clued 在线且已同步。 |
| `ONLINE_DIRTY` | 有本地写入尚未推送到远端。 |
| `DEGRADED_LOCAL`（ok=true） | 当前无法连接授权服务，已根据最近一次有效授权临时切换到本地优先模式，最长 30 分钟。你的新修改会安全排队，但尚未同步到远端；连接恢复后会先重新认证再同步。 |
| `LOCKED` / ok=false code=CLD-AUTH-001 | 在线授权已被明确拒绝，因此没有启用本地降级，也没有读取或写入记忆。请恢复账户或 Binding 权限后重试。 |
| `CONFLICT_REVIEW` / code=CLD-CONFLICT-001 | 存在需要人工处理的冲突；本地与远端版本都已保留（冲突快照），绝不自动覆盖。 |
| 卸载成功 | Clued 已从当前智能体解绑。其他智能体的 Binding 和共享记忆没有被删除。 |
| `REMOTE_REVOCATION_PENDING` | 本地已解绑；远端撤销尚未确认（已进入撤销队列），不能表述为“云端已撤销”（§12.4）。 |

**呈现纪律**：不得把“读到了本地文件”当成授权成功；不得在自然语言层吞掉
`DENIED`、`CONFLICT` 或 `PENDING`；降级时不得使用“已同步/SYNCED”字样
（§13.1 / §16.2）。

## 5. 记忆访问门禁（§7.1）

本适配器在**每次 Memory Access 前**必须先完成对应会话的授权（同会话复用
授权结果；新会话必须重新在线尝试）：
- 记忆读/写直接使用 `memory` 命令——核心在每次 Memory Access 时自动执行
  每会话首次在线认证尝试，适配器不需要额外调用 `auth check`；
- 若核心返回 ok=false + `CLD-AUTH-001`：立即进入“明确拒绝”呈现，不得改用
  本地读取冒充授权；
- 若返回 ok=true + `state=DEGRADED_LOCAL`：按降级模板一次性说明，同一
  故障周期内不为每个本地操作重复刷屏（§8.5）。

## 6. 卸载后的自清理（§16.1.9）

卸载成功后，适配器必须移除自己挂载的 hook/instruction/tool registration
（在 Codex 侧删除本适配器指令的加载引用），并验证当前 Agent 已无法调用
Memory Access（再次 `status --json` 中该 binding 消失即验证通过）。

## 7. 适配器禁止事项（§16.2）

- 不得直接调用 git 绕开 Sync Provider；
- 不得自动接受冲突；
- 不得在用户仅提问时自动安装；
- 不得为了便利在所有会话共用一个已认证标志；
- 不得把核心逻辑写死在提示词里（本文件不含任何认证/同步实现）。
