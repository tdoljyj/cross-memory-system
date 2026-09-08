# Checkpoint 幂等修复独立复核

**结论：本轮受限修复 PASS；未部署生产。** 独立审阅后运行真实本地 PostgreSQL 一次：12/12 PASS（11 个行为子项及 1 个父项），0 FAIL、0 SKIP。中断续接后确认同套测试/PG 后台进程为 0，未重复启动。完整命令、输出和摘要见 [IndependentReview.json](IndependentReview.json)。

受查迁移 SHA256：`0a4ec410e9475698b1dd2b2f670cbe2532441ed750c798a01d25333e3ebf03ea`。受查测试 SHA256：`d100f98dee396d741c4e16eef4509dbfe85b34f89c185e91f50d6d775387e42c`。

| 边界 | 独立实际结果 |
|---|---|
| 旧缺陷 | 改 payload/context 仍返回旧 duplicate；null base 可绕过旧 CAS，均在迁移前复现 |
| 同参重放 | 新有效 session 可重放原 checkpoint；规范化空格与 JSONB 对象键顺序保持原有效语义 |
| 参数变更 | context/base_version/snapshot/summary/next_action 任一变更均 conflict，无新增 checkpoint/回执 |
| Session 与 Binding | 借用其他 binding 的 session 拒绝；不同合法 binding/用户同 key 保留独立命名空间，仍需通过原 stream CAS |
| 并发 | 同 key 同参只有一次提交及一次重放；同 key 跨 context 只有一次提交，另一项冲突 |
| 撤销与过期 | revoked binding、ended/expired session 无法重放 |
| 原始 base 证据 | null/负数拒绝、bigint 最大值无溢出；旧 null-base 不能用 version-1 冒充原请求 |
| 历史保留 | 重复应用迁移后，受查旧 checkpoint、原回执和函数 grants 均不变 |

独立审阅推动补齐两项边界：null base 的 CAS 绕过，以及由 version-1 推断历史原 base 的不可靠性。最终实现读取唯一且非空的原不可变回执 base，不改写旧证据；新事务锁仅串行现有 owner/binding/key 命名空间。现有 binding/session 验证继续先于重放查询。

本次证明实际本地 PG 函数行为，不替代生产切换后正式 Clued 连接验证。合成 auth 环境、选定迁移链、局部修复范围均明确；不签 R11、Entry、Slice A、模型或真人效率验收。
