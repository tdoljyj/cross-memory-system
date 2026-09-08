# Checkpoint 幂等定点修复

现有正式 RPC `public.clued_mcp_commit_checkpoint(text,jsonb)` 存在真实缺陷：同一 binding 重新 resume 后，旧幂等键即使改变 summary 或 context，仍返回旧 checkpoint 的 `duplicate`。旧函数还允许 `base_version=null` 绕过 CAS 比较。本次只读检查了生产函数定义，未操作生产数据。

一次性本地 PostgreSQL 先加载原迁移，重现上述错误，再应用唯一向前迁移 `20260908094000_clued_checkpoint_idempotency_binding.sql`。既有 Worker 直接映射到此 RPC，没有另行比较这些字段的保护层。

修复保留 `(user, binding, key)` 命名空间和有效新 session 的同参重放。重复键按原始 context、snapshot、规范化 summary/next_action 及不可变原 Receipt 的 base_version 校验。变参返回 `conflict/idempotency_key_conflict`；空/负 base 拒绝。不能用 `version-1` 推测旧错误 null-base 请求的原 base，缺少唯一有效 Receipt 也不冒充同参重放。事务级锁串行化同命名空间的相同键，防并发跨 context 双提交。

新的数据库测试 `apps/clued-cloud/tests/checkpoint-idempotency-db.test.mjs` 运行结果为 **12 PASS、0 FAIL、0 SKIP**（11 子项加父项），覆盖修复前反例、五类变参、语义同参重放、bigint 极值、历史 null-base、借用其他 binding 的 session、不同合法 binding 独立操作、两类并发、撤销/过期和重复迁移。原 checkpoint、原 Receipt 与 RPC GRANT 均比对保持不变。

本地验证命令（在 `apps/clued-cloud`）：

```text
node --test --test-force-exit tests/checkpoint-idempotency-db.test.mjs
```

精确源码与检查摘要见 [Result.json](Result.json)。本修复尚未部署生产，不签发 Entry、controller 资格或 Slice A 结果；这是已有服务的一项一致性修复。独立审查另行记录。
