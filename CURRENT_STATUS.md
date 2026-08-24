# Clued 仓库当前状态

最后核对：2026-08-25
权威仓库：`tdoljyj/cross-memory-system`
仓库基线：`vNext-2.0`

## 生产事实

- Clued Kernel `0.3.1` 正式 V2 已启用，语义合同为 `two-level-five-view-v1`。
- Supabase 是唯一生产 canonical store；Global/Project 是同一 Record 表的查询层，五视图是类型/事件过滤。
- 正式写路径为认证 Record → 同事务 Event + Receipt → 派生视图；Markdown 不接受双写。
- 最近只读生产快照：0 个 Project、0 个 Mention、5 条 Memory、7 条 Event、10 条 Receipt。
- 本状态不授权新的 migration、Binding、DNS、Worker deploy、tag 或 Release。

## User Memory Bundle v1

- `memory/` 已被定义为单用户可携带 Bundle/golden sample，不是在线多租户数据面。
- 合同：`clued.user-memory-bundle@1.0.0`；机器合同位于
  `apps/clued-cloud/schemas/user-memory-bundle-v1.schema.json`。
- 实际导出 `umb_fdb167fd46d84c16047af70d`：4 个 Project、262 条 Record；校验与 dry-run PASS。
- Bundle 专项 4/4、应用测试 45/45、TypeScript、ESLint、生产构建全部 PASS。
- 生产专用账号导入当前停在公开 Auth 邮件限流门禁；目标用户未创建、生产 Record 零写入。

## 边界

- 不用 service role 或 SQL 绕过用户认证/RLS，不直写 `auth.users`。
- 不把 `index.json`、对象索引、routes、session 或审计 evidence 当成用户正文。
- 不把访问令牌、用户 ID 或 service-role 凭据写入 Bundle、仓库或回执。
- 相同 Bundle 使用确定性 idempotency key；恢复后必须做二次重放与计数/RLS复核。

## 下一动作

等待 Supabase 内置邮件服务项目级窗口恢复，然后完成专用用户邮箱确认、262 条认证导入、同 Bundle 重放及生产只读验收。门禁恢复前不改变生产 Auth 配置。
