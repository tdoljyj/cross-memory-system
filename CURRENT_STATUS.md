# Clued 仓库当前状态

最后核对：2026-08-25
权威仓库：`tdoljyj/cross-memory-system`
仓库基线：`vNext-2.0`

## 生产事实

- Clued Kernel `0.3.1` 正式 V2 已启用，语义合同为 `two-level-five-view-v1`。
- Supabase 是唯一生产 canonical store；Global/Project 是同一 Record 表的查询层，五视图是类型/事件过滤。
- 正式写路径为认证 Record → 同事务 Event + Receipt → 派生视图；Markdown 不接受双写。
- 当前账号已确认 4 个 Project、262 条 Unified Record；原始 Memory/Event/Receipt 审计证据继续保留。
- 当前线上 deployment `a536f79d-c9f5-4764-8274-be05f3cc5a3c` / Version `928bb6ec-cdc2-4a9a-a630-87a1685e7915` 已冻结为本轮发布前回滚点。

## User Memory Bundle v1

- `memory/` 已被定义为单用户可携带 Bundle/golden sample，不是在线多租户数据面。
- 合同：`clued.user-memory-bundle@1.0.0`；机器合同位于
  `apps/clued-cloud/schemas/user-memory-bundle-v1.schema.json`。
- 实际导出 `umb_fdb167fd46d84c16047af70d`：4 个 Project、262 条 Record；校验、dry-run、认证导入、认证回读与确定性重放 PASS。
- 导入结果为 262 个稳定 canonical ID、262 个稳定版本；重放生成 262 个不同 Event ID 与 262 个不同 Receipt ID，业务记录不重复。
- 匿名隔离 401/401 PASS；第二个已确认账号缺失，因此 Bundle finalizer 的跨用户专项仍明确标为 pending，不冒充已完成。
- 阶段 5 的 26 条 manual-review 已处置：25 条指向现有 canonical records，1 条标记为已被当前正式 V2 状态取代的历史证据；新增生产 Record 为 0。

## 边界

- 不用 service role 或 SQL 绕过用户认证/RLS，不直写 `auth.users`。
- 不把 `index.json`、对象索引、routes、session 或审计 evidence 当成用户正文。
- 不把访问令牌、用户 ID 或 service-role 凭据写入 Bundle、仓库或回执。
- 相同 Bundle 使用确定性 idempotency key；恢复后必须做二次重放与计数/RLS复核。

## 当前发布动作

- 旧账户页 Memory CRUD 已移除；`/api/memories` 与 `/api/memories/audit` 改为明确的 HTTP 410，并指向 `/v1/records`。
- 本轮不删除历史行、审计回执、Supabase schema、Canary、DNS、Binding、route 或 secret。
- 代码门禁、PR 合并、正式部署与发布后只读观察正在执行；最终 deployment/version 记录在验收报告与项目日志。
