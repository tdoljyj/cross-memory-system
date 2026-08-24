# 阶段 8B-2：生产 Additive 迁移与验收报告

> 日期：2026-08-24  
> 状态：`8B-2 PASS`  
> 生产项目：`clued-prod`  
> 功能开关：`PROJECT_VIEWS_V2` 仍关闭

## 1. 裁决

8B-2 通过。生产已按顺序应用 `project_lifecycle_v1` 与 `unified_record_v2` 两条增量 migration；新增表、视图、RLS、授权和 private transaction core 均通过目录检查、pgTAP、legacy CRUD、审计与事务回滚验收。

本轮没有导入旧数据，没有部署 Worker/Sites，没有修改 DNS、Binding、密钥或流量，也没有启用 `PROJECT_VIEWS_V2`。现有 Worker 继续运行 Kernel `0.3.0`，新增 schema 处于“已存在、未被旧 Worker 使用”的兼容状态。

## 2. 生产前置条件

- Git 本地与远端功能分支均为 `7491640980fb46b06e4c03809d32c031cf4da912`，`origin/main` 是该分支祖先；两条 migration 相对发布候选 `79c13023a50a46f015fe921c74c55bf84f381ef5` 无差异。
- `project_lifecycle_v1.sql`：24,383 bytes，SHA-256 `bc5889fac81cf0d6c318a5a18dfb3cc6d07911a678bcb779fc3295c7206c5f59`。
- `unified_record_v2.sql`：25,912 bytes，SHA-256 `0178e27aeee4717ccd81f5f693db308a97f5104c5810b4657fd120bb44e406c3`。
- 8B-1 AES-256-GCM 密文与 key 文件存在且非空，明文文件不存在；临时恢复项目仍为 `INACTIVE`。
- 迁移前生产只有三条旧 migration；项目表和 V2 对象不存在，所有 Clued 表 RLS 开启，关键数据为 Memory/Event/Receipt `0/2/5`。
- Worker 冻结点仍为 deployment `7001b467-e78a-4ca5-abd1-5a630e7e221a`、version `bf0038c3-1456-4653-bdcf-f962ff962ec4`、100% 流量；Bindings 只有 `ASSETS`、`IMAGES`。

## 3. Migration 执行

按固定顺序应用，均由 Supabase migration 接口登记历史：

| 顺序 | 生产 migration | 结果 |
|---:|---|---|
| 1 | `20260824113622 project_lifecycle_v1` | PASS |
| 2 | `20260824113636 unified_record_v2` | PASS |

两份 SQL 均为 additive 设计；出现的 `DROP POLICY IF EXISTS` 只用于原位替换策略，不删除表、列或业务数据。

## 4. Schema、RLS 与授权验收

- `clued_projects`、`clued_project_mentions` 已存在且 RLS 开启。
- `clued_records_v2`、`clued_global_work_v2`、`clued_project_resolution_v2` 已存在。
- `clued_private.record_write_core(uuid,uuid,jsonb)` 与 `record_list_core(uuid,jsonb)` 已存在。
- 所有 `public/clued_private` 下的 `clued_*` 表均无 RLS disabled 项。
- private record core 对 `public`、`anon`、`authenticated` 的 EXECUTE 全部为 false。
- 对外包装器保持最小边界：token record wrappers 只对 `anon` 开放，user record wrappers 只对 `authenticated` 开放。
- 项目表与 Memory 均为 0 行；原生产 Event/Receipt 保持 `2/5`，没有迁移时数据改写。

## 5. 动态验收与回滚证据

1. Unified Record V2 pgTAP 在生产事务中执行并回滚：`16/16 PASS`；最后一项确认 Record、Event、Receipt 使用同一事务关联。
2. 迁移后 legacy Memory create/read/update/delete 全部 PASS，触发审计严格为 3 条；测试事务随后 `ROLLBACK`。
3. 探针用户和探针 Memory 清理计数均为 0。
4. 回滚后生产计数保持：Project/Mention/Memory/Event/Receipt = `0/0/0/2/5`。
5. Schema 回滚策略不执行破坏性反向 DDL：保持功能开关关闭并继续使用旧 Worker 即可；新增表和函数可留作未使用兼容对象。

## 6. Advisor 与兼容性

- Security Advisor：23 WARN、0 ERROR。22 条为预期的 `SECURITY DEFINER` 包装器可执行性提示（anon 12、authenticated 10），另 1 条为项目级 leaked-password protection 配置提示；private core 权限与动态隔离测试均符合设计。
- Performance Advisor：8 WARN、32 INFO。8 条 `auth_rls_initplan` 均位于既有 continuity 策略；新 schema 相关项只有空表/新索引尚未使用及 `clued_events_project_fkey` 覆盖索引建议，当前 0 条新 Record、功能关闭，不构成 8B-2 阻断。
- RLS 与 View 设计依据 Supabase 当前文档：Postgres 15+ 可使用 `security_invoker` 使视图遵循底层 RLS；私有 `SECURITY DEFINER` core 不置于对外 schema。参考：<https://supabase.com/docs/guides/database/postgres/row-level-security>。

## 7. Worker 不变性

- 迁移后 Worker deployment、version、100% 流量、compatibility date/flags 与 Bindings 均与迁移前一致。
- `PROJECT_VIEWS_V2` 仍不存在。
- 公网 `/healthz` 返回 `status=ok`、`version=0.3.0`、`canonicalStore=supabase`。
- 未部署代码、未切 canary、未改域名、DNS、Binding 或密钥。

## 8. 下一步边界

唯一下一步是等待用户明确“确认 8B-2，进入 8B-3”。8B-3 只允许部署独立 canary Worker 并运行 smoke test；生产域名与正式 Worker 流量继续不变，旧数据导入、正式启用和 PR 合并仍需后续独立批准。
