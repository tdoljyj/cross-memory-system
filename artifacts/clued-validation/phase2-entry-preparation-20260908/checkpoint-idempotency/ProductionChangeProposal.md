# Checkpoint 幂等修复：具体生产变更

目标仅为现有 Supabase 项目 `ccxsikzwxlolxqlosril` 的 `public.clued_mcp_commit_checkpoint(text,jsonb)`，使用已经提交的向前迁移 `apps/clued-cloud/supabase/migrations/20260908094000_clued_checkpoint_idempotency_binding.sql`，SHA-256 `0a4ec410e9475698b1dd2b2f670cbe2532441ed750c798a01d25333e3ebf03ea`。不改历史 checkpoint / Receipt、表结构、现有 GRANT、Binding、密钥或 Worker。此为普通一致性修复，不使用 Surgical Lane。

实际问题：同一 Binding/幂等键变更 context 或内容仍误报旧成功，且旧 RPC 的 null base 可绕过版本检查。修复要求同参返回原逻辑结果/Receipt，变参冲突，合法新 session 可恢复；无效 base 拒绝，并发同键只提交一次。

已完成检查：维护者与独立真实 PostgreSQL 各12 PASS / 0 FAIL / 0 SKIP；完整仓库与生产安装形状的迁移链2/2通过；保持历史数据和授权的对比通过。生产只读复查确认旧函数定义仍为 `4108527277332f9c45741e064d1f5d29b48ee215ad2c394146910429d421b059`，`SECURITY DEFINER`、空 search_path 和原 GRANT 一致。

执行步骤：

1. 部署前重新比对精确文件摘要与生产原函数，源或目标变更则停下核对，不能覆盖未知后继。
2. 经既有 Supabase `apply_migration` 应用这个单函数向前迁移，保留部署返回。失败不得声称已生效。
3. 只读核对生产实际定义、签名/search_path/GRANT；随后通过正式 Clued 连接保存本任务真实接续 checkpoint，回读成功版本与Receipt，同键同参恢复返回同结果，同键变参必须冲突。不得经管理员SQL伪造业务checkpoint或Receipt。
4. 记录真实部署与回读证据。若出现非预期结果，停止依赖该变更的后续写入并诊断；不盲目恢复已知存在幂等缺陷的旧写路径，不扩权或清理历史证据。

需确认的原因：前次明确生产批准指向项目列表修复与 Worker `clued-cloud`；本次新的 checkpoint 数据库函数变更没有包含在该具体批准中。用户批准的非生产 bootstrap 也明确排除生产变更。批准此具体部署不代表 Phase 2、R11、Entry 或 Surgical 验收通过。
