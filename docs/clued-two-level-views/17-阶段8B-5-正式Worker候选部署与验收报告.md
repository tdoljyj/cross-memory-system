# 阶段 8B-5：正式 Worker 候选部署与验收报告

> 日期：2026-08-24
> 状态：`8B-5 PASS`
> 正式入口：<https://clued.pixelgrav.com>
> Worker：`clued-cloud`

## 1. 授权与边界

用户明确确认 8B-4 并授权进入 8B-5。本轮只允许把已通过 Canary 与低风险批次双读验收的候选部署到正式 Worker，并保持 `PROJECT_VIEWS_V2` 关闭。

本轮没有启用正式 V2、扩大导入范围、修改 Supabase schema/data、创建测试用户、改 DNS/自定义域名、增加 Binding/密钥、合并 PR、删除旧读取路径或删除 Canary。

## 2. 发布输入与回滚点

- 仓库 feature 分支与远端均以 `96e726697b2b221893168eaa701bccceea74e312` 为发布输入。
- `apps/clued-cloud` 最后代码变更为 `9ec6d211983d455e8a488d28f657baed7be09566`；随后提交只补 8B-4 报告与权威状态。
- 发布前正式 deployment 为 `7001b467-e78a-4ca5-abd1-5a630e7e221a`，Version 为 `bf0038c3-1456-4653-bdcf-f962ff962ec4`，100% 流量。
- 本轮即时回滚目标冻结为 `bf0038c3-1456-4653-bdcf-f962ff962ec4`；数据库 additive schema 与 8B-4 五条 canonical records 在 Worker 回滚时保留。
- 发布前正式 Bindings 只有 `ASSETS`、`IMAGES`，不存在 `PROJECT_VIEWS_V2`。

## 3. 发布前门禁

- Wrangler 固定为 `4.125.0`，OAuth 身份与 Worker 写权限有效。
- TypeScript typecheck PASS、ESLint PASS、Vinext build PASS。
- Node 全套 `41/41 PASS`，V2 不变量专项 `14/14 PASS`。
- Memory Engine `55/55 PASS`、engine doctor `ALL PASS（0 WARN）`，Clued 项目记忆路由 `8/8 PASS`。
- Wrangler dry-run PASS；产物 Compatibility Date `2026-08-23`、flag `nodejs_compat`，只包含 `ASSETS`、`IMAGES`。
- 正式旧版本基线：`/healthz` 为 Kernel `0.3.0`；尚无 `/v1/records/config`（HTTP 404）；MCP 的两个 Record 工具不可见；`/v1/records` 为 404；未登录 legacy Memory 为 401；首页为 200。
- Supabase 基线为 Project/Mention/Memory/Event/Receipt `0/0/5/7/10`，Auth user 1、8B-4 批次 Record 5、active Binding 0、active record write 0、RLS-disabled Clued table 0。

## 4. 正式部署

部署使用生成的 `dist/server/wrangler.json`，保留远端变量并启用 strict 冲突检查；没有传入 V2 变量、route、domain 或 secret。

| 项目 | 结果 |
|---|---|
| deployment | `d893cf10-09c1-4f34-a1aa-57e6ec7dcf61` |
| Version | `3b5d1627-e53f-44cf-b26c-26717ebe6e5c` |
| traffic | `100%` |
| message | `Clued 8B-5 formal Worker candidate, V2 disabled` |
| Worker Startup Time | `26 ms` |
| Bindings | `ASSETS`、`IMAGES` |
| Feature flag | `PROJECT_VIEWS_V2` 不存在，缺省关闭 |

## 5. 发布后验收

正式域名和 `clued-cloud.tdoljef.workers.dev` 均通过同一组只读探针：

- `/healthz`：HTTP 200、`status=ok`、Kernel `0.3.1`。
- `/v1/records/config`：HTTP 200、`enabled=false`。
- MCP `tools/list`：两个 Record 工具均不可见；未意外启用 V2 写入口。
- `/v1/records`：HTTP 404。
- 未登录 `/api/memories`：HTTP 401。
- 首页：HTTP 200。

随后对正式域名执行固定 10 轮观察：10/10 均为 Kernel `0.3.1`、V2 false、Record tools 0，失败样本与意外 5xx 为 0。

## 6. 数据与迁移不变性

发布后再次只读核对：

- Project/Mention/Memory/Event/Receipt 仍为 `0/0/5/7/10`。
- 8B-4 批次 Record 保持 5，Auth user 保持 1。
- active Binding 0、active record write 0、RLS-disabled Clued table 0。
- migration history 仍为既有六条，末项为 `20260824131759 map_optimistic_conflicts_to_http_409`；本轮没有数据库 DDL 或 DML。

## 7. 裁决与下一授权点

最终裁决：`8B-5 PASS`。阶段 8B 的五个独立批准点全部完成，正式 Worker 已升级到候选代码，但 Unified Record V2 仍未对正式入口启用。

下一步必须单独批准“正式 V2 启用”：给 `clued-cloud` 设置 `PROJECT_VIEWS_V2=true` 并重新执行正式入口观察。扩大数据导入、PR merge、旧读取路径下线、历史数据删除与 Canary 删除仍不包含在该授权内。
