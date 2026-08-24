# 阶段 8B-3：独立 Canary 与 Smoke 验收报告

> 日期：2026-08-24  
> 状态：`8B-3 PASS`  
> 生产项目：`clued-prod`  
> 独立 Canary：<https://clued-cloud-canary.tdoljef.workers.dev>

## 1. 授权与裁决边界

用户明确授权应用生产 Supabase 冲突映射 migration、取消卡住的 `clued_user_record_write` Canary 会话、清理全部临时测试数据，并继续完成 8B-3。

本轮只允许修复 Data API 冲突语义、部署独立 Canary、执行 smoke/audit 与稳定性观察。生产 Worker、`clued.pixelgrav.com` 域名、正式流量、正式 Binding/密钥、旧数据导入、PR 合并和旧路径删除均不在本轮授权范围。

## 2. 生产 Supabase 冲突映射

已应用 migration `20260824131759 map_optimistic_conflicts_to_http_409`。它只替换四个 public Data API wrapper：

- `clued_record_write(text,jsonb)`
- `clued_user_record_write(jsonb)`
- `clued_project_update(text,jsonb)`
- `clued_user_project_update(jsonb)`

private transaction core 仍以 SQLSTATE `40001` 表达乐观锁冲突；public wrapper 仅将已知的 `record_version_conflict` / `project_version_conflict` 映射为 SQLSTATE `23505`，由 PostgREST 返回 HTTP `409`。其他 serialization failure 原样抛出。四个函数均保持 `SECURITY DEFINER`、空 `search_path` 与原最小授权边界。

迁移前卡住的后端 PID `168931` 已按授权取消。迁移后直接 SQL 探针立即返回 `23505 record_version_conflict`，不再进入 Supavisor/PostgREST 的 serialization retry 循环。

## 3. 独立 Canary 部署

| 项目 | 结果 |
|---|---|
| Worker | `clued-cloud-canary` |
| deployment | `999dc223-655d-413b-a84c-6652e42ed6c6` |
| version | `5c47e7fd-8819-47d1-86e0-d6aa7f97e435` |
| traffic | `100%`，仅 Canary 自身 |
| Kernel | `0.3.1` |
| Feature flag | `PROJECT_VIEWS_V2=true` |
| Bindings | `ASSETS`、`IMAGES` |
| Custom domain | 无 |

Canary 额外把数据库已知 `P0002 project_not_found` / `record_not_found` 从上游 5xx 收敛为客户端安全的 HTTP `404`；仅匹配这两个精确业务错误，其余数据库错误不改写。该变更尚未部署到生产 Worker。

## 4. 自动化与构建门禁

- Wrangler dry-run PASS。
- TypeScript typecheck PASS。
- ESLint PASS。
- Vinext build + Node 测试 `41/41 PASS`。
- V2/migration/record API 专项 `28/28 PASS`。
- 新增合同测试确认四个 wrapper 的 409-compatible SQLSTATE、最小授权，以及已知 P0002 的 404 映射。

## 5. 真实 Canary Smoke

使用两个一次性 Auth 身份执行完整闭环，结果如下：

| 验收项 | 结果 |
|---|---|
| 创建 State / 两条 Task / Decision | PASS |
| 更新 Task | PASS |
| stale version 冲突 | HTTP `409`，1,292 ms |
| 归档并恢复 Task | PASS |
| supersede Decision | PASS |
| 完成 Task + 原子推进 State | PASS |
| Global / Project 五视图及最终 owner read | 11 次 authenticated read，全部 PASS |
| 跨用户读取 | HTTP `404` |
| 跨用户写入 | HTTP `403` |
| 成功 record write | 9 次 |
| 意外 5xx | 0 |

成功项目的数据库审计快照为 6 条 canonical Record、9 条 Event、9 条 committed Receipt、0 条 pending Receipt。State、archive/restore、task completion、Decision supersede 及双方引用关系全部符合不变量。

## 6. 清理与生产基线

所有临时项目、Record、Event、Receipt 与两组测试 Auth 身份已按外键/审计触发器顺序清理。最终确认：

- 临时测试邮箱：0
- 临时 Project / Memory：0 / 0
- active record-write backend：0
- RLS disabled 的 Clued 表：0
- 生产 Project/Mention/Memory/Event/Receipt：`0/0/0/2/5`

首轮清理曾因审计触发器与删除顺序发生阻塞；该事务未形成残留，随后先解除自引用、在用户仍存在时删除 Memory，再删除 Auth 身份，清理完成。

## 7. Advisor 复核

- Security Advisor：23 WARN、0 ERROR。其中 22 条为既定 public wrapper 可执行面提示（anon 12、authenticated 10），另 1 条为项目级 leaked-password protection 配置提示；private core 动态隔离与最小授权验收均通过。
- Performance Advisor：8 WARN、21 INFO。WARN 为既有 `auth_rls_initplan`；INFO 为 14 条未索引外键与 7 条新/空表索引未使用提示，当前不阻断 Canary。

## 8. 生产不变性

- 正式 Worker deployment `7001b467-e78a-4ca5-abd1-5a630e7e221a`、version `bf0038c3-1456-4653-bdcf-f962ff962ec4`、100% 流量保持不变。
- 正式 Bindings 仍只有 `ASSETS`、`IMAGES`，未增加 `PROJECT_VIEWS_V2`。
- `clued.pixelgrav.com` 仍只绑定 `clued-cloud`；Canary 无自定义域名。
- 正式公网 `/healthz` 始终返回 Kernel `0.3.0`。

## 9. 执行中发现并闭环的问题

1. SQLSTATE `40001` 经 Data API 触发重试，造成 Canary 请求与一个后端会话卡住：取消会话并应用精确冲突映射后闭环。
2. 直接插入的一次性 Auth 测试行缺少空字符串 token 默认值，登录返回数据库错误：只修正测试行，未改 Auth schema 或产品逻辑。
3. 跨用户项目读取的 `P0002 project_not_found` 被 PostgREST 表达为 500：在 Canary Worker 精确收敛为 404，并补单测。
4. Wrangler 在 Cloudflare 已确认部署后因本地日志文件描述符未退出：以 Cloudflare deployment/version API 二次确认发布成功，未重复部署。

## 10. 30 分钟观察与最终裁决

从 `2026-08-24T13:49:40Z` 至 `2026-08-24T14:24:12Z` 执行固定 61 轮只读探针，持续 `2,078.4` 秒（34 分 38 秒）：

- Canary `/healthz`：61/61 为 `status=ok`、Kernel `0.3.1`。
- Canary `/v1/records/config`：61/61 为 `enabled=true`。
- Canary 未认证 Record read：61/61 为 HTTP `401`。
- 生产 `/healthz`：61/61 为 `status=ok`、Kernel `0.3.0`。
- 失败样本：0；意外 5xx：0；版本或开关漂移：0。

正式窗口前的一次旧 Schannel 单次探针在第 19 轮发生本机 TLS 握手失败，因此整段观察被废弃并重新起算；没有选择性删掉失败轮。正式窗口使用短重试，曾记录 3 次可重试的本机 TLS 传输提示，同轮最终业务探针均成功，不计为服务失败。

最终裁决：`8B-3 PASS`。生产冲突映射、独立 Canary、完整 smoke、跨用户权限、审计、清理和稳定性观察均闭环，生产 Worker 与正式流量保持不变。

唯一下一步是等待用户明确“确认 8B-3，进入 8B-4”。8B-4 只允许导入 5–10 条低风险记录并执行双读校验，不自动切换正式流量。
