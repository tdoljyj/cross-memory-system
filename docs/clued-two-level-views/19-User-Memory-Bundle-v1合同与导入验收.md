# Clued User Memory Bundle v1 合同与导入验收

> 日期：2026-08-25
> 合同：`clued.user-memory-bundle@1.0.0`
> 目标：把私有仓库 `memory/` 固化为一个真实单用户的可移植数据包与生产级验收样本，但不把 Git 变成 Clued 多租户数据面。

## 1. 架构裁决

`memory/` 可以代表一个真实用户的完整记忆包；不能成为 Clued Worker 的在线生产存储目录。

- `memory/objects/*.json` 是本源系统唯一结构化正文来源，导出为 `records.jsonl`。
- 五份 legacy Markdown、授权项目日志与审计日志只进入 `evidence/`，只读且不提升为 current truth。
- `index.json`、`object-index.json`、`contexts/routes.json`、`contexts/README.md` 与 `session/` 是系统合同、派生索引或临时上下文，不进入用户业务数据。
- Clued 在线生产 canonical store 继续是 Supabase；租户边界继续是 `user_id + RLS`。
- 导入只调用现有认证 `/v1/projects*` 与 `/v1/records`，不使用 service role、不直写表、不绕过 RLS，不创建 Markdown 正文副本。

## 2. Bundle 目录

```text
manifest.json
projects.jsonl
records.jsonl
Global/{State,Task,Decision,Archive,Log}.md
Projects/{source-project-id}/{State,Task,Decision,Archive,Log}.md
evidence/{画像,状态,决策,待办,归档}.md
evidence/contexts/projects/clued/日志.md
evidence/audit/audit.log
```

`records.jsonl` 是 Bundle 内唯一可导入正文。Global/Projects Markdown 每条只保存稳定 ID 引用：

```text
- `{id}` — {title}: {conclusion-or-reference} [status={status}; version={version}]
```

## 3. 保守映射

| Memory Engine category | Clued Record type |
|---|---|
| `state` | `state` |
| `todo` | `task` |
| `decision`、`constraint` | `decision` |
| `history` 或 superseded object | `archive_snapshot` |
| `identity`、`preference`、`project` 及其他 | `note` |

`machine` scope 降为 Global；`project` scope 必须引用 Bundle 内已有的 `source_project_id`。存在结构化项目对象本身构成 material-work evidence，因此专用测试用户中的对应项目可以通过项目生命周期 API 以 `confirmed` 创建；不得猜造额外项目、别名或自动 merge。

状态映射服从 Clued 的类型状态域：active State → `current`，active Task →
`in_progress`，active Decision/Note → `active`；candidate Task → `backlog`，其余
candidate → `archived`，避免候选信息冒充 current truth；原始状态始终保留在
`source_status`。history/superseded object 统一进入 `archive_snapshot/archived`。

## 4. 完整性与安全

- Bundle ID 来自 `projects.jsonl + records.jsonl` 的 SHA-256，不由时间戳或输出路径决定。
- `manifest.json` 为所有正文、镜像与 evidence 文件记录字节数和 SHA-256；校验失败时禁止导入。
- Bundle 禁止携带 `user_id`、access token 或 service-role 字段。
- 每个 Project/Record 的 idempotency key 由 Bundle ID 与 source ID 确定生成；相同 Bundle 重放不得产生第二份数据。
- 导入器默认 dry-run；只有显式 `--execute` 且 token 仅通过环境变量提供时才产生网络写入。
- 导入前强制验证正式 `/v1/records/config` 为 `enabled=true` 且合同版本为 `two-level-five-view-v1`。
- 导入后按 Global/Project 与 Record type 重新读取，并核对 canonical UUID、record key、title、content、status 与 version。

机器可读合同：`apps/clued-cloud/schemas/user-memory-bundle-v1.schema.json`。

## 5. 命令

```bash
npm run bundle:export -- \
  --memory ../../../memory \
  --output <private-output-directory> \
  --source-commit <40-char-git-commit> \
  --created-at <iso-timestamp>

npm run bundle:validate -- --bundle <private-output-directory>
npm run bundle:import -- --bundle <private-output-directory>

CLUED_ACCESS_TOKEN=<dedicated-user-token> npm run bundle:import -- \
  --bundle <private-output-directory> \
  --endpoint https://clued.pixelgrav.com \
  --execute \
  --receipt <private-receipt-path> \
  --target-mirror <private-target-mirror-directory>
```

## 6. 当前验收

### 6.1 本地合同与工具：PASS

- 实际 Bundle：`umb_fdb167fd46d84c16047af70d`。
- Payload：4 个 Project、262 条 Record；Global 246、Project 16。
- Record type：Archive 121、Decision 42、Note 63、State 22、Task 14。
- 导出后完整性校验 PASS；默认导入 dry-run 明确报告 `network_writes=0`。
- Bundle 专项测试 4/4 PASS；应用测试 45/45 PASS；TypeScript、ESLint、生产构建 PASS。

### 6.2 生产专用测试用户：AUTH GATE BLOCKED（零数据写入）

2026-08-25 通过公开 Supabase Auth signup 创建隔离测试用户时，生产 Auth 返回
`over_email_send_rate_limit`。Auth 日志确认是内置邮件服务的项目级发送窗口，SQL
复核确认目标邮箱未生成 `auth.users` 行，因此没有半成品账号；导入器没有获得用户
JWT，也未调用任何生产写 API。

恢复纪律：等待认证邮件窗口恢复后继续公开 signup → 邮箱确认 → 用户 JWT → 认证
API 导入 → 同 Bundle 重放 → 计数/RLS/幂等性复核。不得为绕过该门禁改用 service
role、直写 `auth.users`、关闭邮箱确认或修改生产 Auth 配置。Supabase 官方说明其内置
邮件服务对所有触发邮件的端点合计限制为每小时 2 封：
<https://supabase.com/docs/guides/auth/rate-limits>。
