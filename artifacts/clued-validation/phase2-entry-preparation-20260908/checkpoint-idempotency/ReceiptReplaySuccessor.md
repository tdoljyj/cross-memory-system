# Checkpoint 重放原 Receipt 引用：向前修复候选

**LOCAL_ENGINEERING_CANDIDATE；未部署生产。** 原 `20260908094000_clued_checkpoint_idempotency_binding.sql` 字节不变。本后继不新增 P0、业务权限、Receipt 类型或 Gate 授权。

现行《Clued 单一数据源与两级五视图架构方案 v1.6》§9.5（源文件第 962、992 行）已经要求精确幂等重放返回原 Receipt，§9.3 第 926 行同样要求不新增成功 Event、返回原 Receipt。现有 C04 typed Receipt 范围明确包括 `clued_mcp_commit_checkpoint`。首次 `committed` 响应本来就包含 `receipt_id`，但已经验证唯一原 Receipt 的 `duplicate` 分支未返回它。因此这是既有返回契约缺口；Stability §6 不是本次新增要求的来源。

新迁移 `20260908102500_clued_checkpoint_replay_receipt.sql` 只在已有聚合查询中取回原 Receipt ID，并在原先所有一致性检查通过后把该 ID 加入 duplicate 响应。仍要求恰好一份、原 base_version 可确认且所有有效参数相同；缺失、多份或变参都返回原有 conflict，不泄露 Receipt ID。既有 namespace、会话/Binding 鉴权顺序、状态字段、CAS、持久记录和权限不变。

真实本地 Postgres 回归为 **7/7 PASS，0 skipped**（1 个父测试、6 项定点子测试）：

- 先加载原已批准迁移，复现 duplicate 丢失已有原 Receipt ID。
- 旧 checkpoint 在多个新有效会话中返回相同原 Receipt；新提交与其重放也返回相同 Receipt。
- snapshot、summary、next_action、base_version、context 变参继续 conflict；零份和两份 Receipt 的合成旧 checkpoint 均 fail closed。
- 每次重放及拒绝前后，checkpoint/对应 Receipt 计数、完整 stream/head 状态一致；旧行与 Receipt 原内容不变。
- 重复应用新向前迁移后，函数 `proacl`、`prosecdef`、`proconfig` 保持一致。

测试只使用临时本地数据库与合成账号，结束时停止并清理该精确数据库目录。生产观察来自主控，本执行者未查询或修改生产；实际生产发布及任何受影响接受的后继绑定仍由主控串行处理。

最小复核入口（`apps/clued-cloud` 目录）：

```text
node --test tests/checkpoint-replay-receipt-db.test.mjs
```

精确源码、测试、旧迁移及合同摘要见 [ReceiptReplaySuccessor.json](ReceiptReplaySuccessor.json)。原本地测试不改写；该新测试独立保留遗漏字段的反例。
