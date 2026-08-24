# ADR：Clued 两级五视图单一数据源

> 状态：**ACCEPTED / 用户已确认**
> 日期：2026-08-24  
> 确认：用户于 2026-08-24 明确回复“确认 ADR，进入阶段 2”。
> 适用范围：Clued Cloud 的 Global / Project 两级视图，以及 State / Task / Decision / Archive / Log 五类视图。

## 1. 背景与目标

Clued 需要让同一条业务记录可按全局或项目上下文查看，同时避免 UI、API、MCP、Markdown 各自维护一份事实。本 ADR 冻结语义与不变量；物理表结构、迁移 SQL 和界面实现留到确认后的阶段 2。

## 2. 决策摘要

1. **单一业务记录源**：State、Task、Decision、Archive 共用一套 Unified Record 逻辑集合；Global 与 Project 是查询范围，不是两份数据。
2. **事件独立**：Log 来自 append-only `clued_context_events`，只记录发生过什么，不定义当前事实。
3. **项目注册独立**：`clued_projects` 只管理项目身份与生命周期；`clued_project_mentions` 只保存候选/证据，不属于五视图记录。
4. **一个写服务**：UI、API、MCP 只能调用同一事务写服务，不能绕过它直接维护业务表。
5. **Markdown 降级为镜像**：长期只读导出/灾备；只允许一次受控导入，不持续双写。
6. **先契约后迁移**：本 ADR 被用户确认前，不修改 schema、迁移、API、MCP、UI 或生产环境。

## 3. 权威对象

| 对象 | 权威职责 | 明确不负责 |
|---|---|---|
| `clued_projects` | 项目 ID、名称、生命周期、合并指向 | 五视图正文 |
| `clued_project_mentions` | 候选项目及证据 | 已确认项目、五视图事实 |
| Unified Record | State / Task / Decision / Archive 当前或历史业务记录 | 事件流、技术审计 |
| `clued_context_events` | 追加式业务事件 | 当前状态或下一步 |
| `clued_memory_audit` / receipts | 技术审计、幂等与调用证据 | 用户业务视图 |

Unified Record 的最低逻辑字段：

`id, user_id, scope, project_id, record_type, record_key, title, body, status, priority, source_ref, version, supersedes_id, restored_from_id, created_at, updated_at, archived_at`

阶段 2 的优先物理方向是**增量扩展现有 `clued_memories`**，而不是建立十张“全局/项目 × 五视图”表。最终 SQL 映射必须在迁移设计中再次核验。

## 4. 两级视图

- Global：查询该用户全部 Unified Records；可按项目、类型、状态过滤。
- Project：在同一集合上增加 `project_id = :project_id` 过滤。
- 同一条项目记录在 Global 与 Project 中的 `id`、`version` 和正文完全相同。
- `scope = global` 的记录无 `project_id`；项目记录必须有已确认且归属当前用户的 `project_id`。
- 项目改名只更新项目名称，不改项目 ID 或记录 ID。

## 5. 五视图语义与不变量

### State

- 每个用户/范围/项目/`record_key` 最多一个 current State。
- State 可引用 `next_task_id`，但不得复制下一步任务正文。
- 当前事实必须从 Unified Record 查询，不得通过扫描 Log 推导。

### Task

- 状态机：`backlog → ready → in_progress → done`，并允许进入 `blocked` 或 `cancelled`；非法跳转由写服务拒绝。
- “每个项目一个 Now”是默认查询/展示规则，不做数据库硬唯一约束，以免阻断批量迁移与恢复。
- 任务完成与相关 State 前移必须在同一事务中成功或回滚。

### Decision

- 决策被改变时创建新记录；旧记录标记 `superseded`，新记录通过 `supersedes_id` 指向旧记录。
- 不覆盖或物理删除旧决策。

### Archive

- Archive 是不可变的闭环摘要或引用，不是 Event 的副本。
- 默认长期保留，直到用户显式删除或未来另有保留策略。
- 恢复归档时创建新的 current 记录，并通过 `restored_from_id` 关联原归档；原归档保持不变。

### Log

- `clued_context_events` 追加写，正常业务路径不更新、不删除。
- 事件可记录谁在何时对什么对象做了什么，但不能成为 State、Task 或 Decision 的当前事实源。

## 6. 项目生命周期

### Candidate

- mention/candidate 未确认前，不能创建任何五视图记录。
- 确认后创建稳定项目 ID；驳回只关闭候选，不产生项目或业务记录。

### Rename

- 仅名称变化；项目 ID、记录 ID、历史事件引用保持稳定。

### Merge

- `merged_into_project_id` 保存源项目到目标项目的映射，源项目和原记录 ID 均保留。
- 合并后的新写入只能落到目标项目。
- 查询通过合并闭包解析 effective project，不复制所有正文。
- 若源、目标同时有 current State，目标保持 current，源 State 归档并写入合并事件；不得把源正文覆盖或拼接进目标正文。

## 7. 唯一写路径

每次写入执行以下事务：

1. 验证用户身份。
2. 验证记录/项目归属与 scope。
3. 获取必要的记录锁。
4. 校验 expected version 与 idempotency key。
5. 变更一个业务意图所需的 Unified Record。
6. 在同一事务追加业务 Event 与技术 Audit/receipt。
7. 返回记录 `id` 和新 `version`。

任何一步失败，业务记录、Event 和 Audit/receipt 必须一起回滚。UI、公开 API 和 MCP 都只调用这个服务。

## 8. 并发与冲突

- 更新/删除必须携带 expected version；不匹配返回显式冲突，不静默覆盖。
- 幂等键只能重放相同操作；同键不同 payload 必须拒绝。
- 项目合并、决策替代和任务完成等多记录操作必须加锁并原子提交。

## 9. 安全边界

- 暴露到 Data API 的表显式授予最低权限并开启 RLS；RLS 不替代 grants。
- 用户数据策略使用用户所有权，并同时定义 UPDATE 的 `USING` 与 `WITH CHECK`。
- 视图使用 `security_invoker`；事务核心若采用 SECURITY DEFINER，应放在非暴露 schema、固定 `search_path`，撤销默认执行权限，再仅授权包装入口。
- 浏览器不得持有 service role；跨用户与跨项目访问必须被数据库和服务层双重拒绝。

## 10. 发布与回滚边界

- 功能标志：`project_views_v2`，默认关闭。
- 阶段 2 先做 additive schema 与 dry-run；阶段 3 才迁移，阶段 4 才切写，阶段 5 才切读。
- 每一阶段都必须保留“关标志 + 恢复旧 Worker + 回滚当阶段迁移/映射”的路径。
- 切换前保留旧读路径；不得在同一发布中同时删除旧表、旧接口和 Markdown 镜像。

## 11. 代价与取舍

- 统一集合降低重复写入与身份漂移，但需要更严格的类型约束和索引。
- Log 不承载当前真值，使查询和回滚可预测，但事件回放不再是默认读模型。
- Merge 不复制正文避免重复数据，但查询必须解析项目合并闭包。
- “一个 Now”作为产品规则而非硬约束，更容易迁移和恢复，但服务层必须有确定排序与告警。

## 12. 确认门

本 ADR 已获用户确认，允许进入阶段 2 的现有实现映射与最小数据变更评审。阶段 2 仍不应用 schema、不迁移数据、不修改 API/MCP/UI、不部署；通过 G2 后才允许进入阶段 3 的失败测试实现。
