# Stability 接入准备

状态：**PREPARATION_ONLY**。独立复算用户正式源文件 SHA256 为 `936cb966a75765ca156f5706237467b940ea32891bbc98c2c21ec9a8b8ec06a0`，38666 字节，匹配指定基线。已对齐受查仓库 `260b085f4af94305c9bbc846dc3629dabb46a33b`。源文件由主控原字节归档，本路未修改。

本轮只复用既有 CapabilityMap、HS0Preparation 和 checkpoint 独立 PG 证据，没有重跑测试、读取 Gold、修改运行时或创建权限。逐项路径、摘要、Hook 引用和缺口见同目录 `StabilityPreparation.json`。合同名均为源文规定的逻辑草案，不是新 wire schema、Authority 或 Canonical 对象。

| 范围 | 已有可复用能力 | 本轮草案与实际缺口 |
|---|---|---|
| S1 确定性命令 | RPC、mutation、checkpoint 入参 | CommandEnvelope / OperationIdentity；全消费者 operation、环境、policy、registry 绑定未完整证明 |
| S2 幂等重试 | checkpoint 同参重放、参数冲突、同键并发实证 | IdempotencyContract；原 Receipt 引用返回、精确十次重放、丢响应、外部副作用仍待核实 |
| S3 CAS | checkpoint 非空 base、旧版冲突 | ExpectedRevisionContract；不同操作同 revision 竞争、提交前撤权、真实 kill 边界待执行 |
| S4 状态不变量 | M1 lifecycle / mutation 校验 | StateTransitionContract / CanonicalMutationContract；全对象状态矩阵与适用消费者覆盖未完整 |
| S5 Receipt | 既有 Receipt、checkpoint 原不可变回执绑定 | ReceiptDeterminismContract；完整最低字段映射、回执写失败、实际 outbox 边界待补 |
| S6 收窄与失败拒绝 | 授权、撤权、scope 与工具开关 | FailClosedContract；精确收窄/恢复主体与作用域未绑定；不提前全局硬拒绝 |
| S7 稳定性信号 | 既有错误、投影校验、checkpoint 修复观察 | StabilitySignalContract；Health 尚属准备，未运行 R11/HS1、SLO 测量、HS2 或 Repairability |

ST-N01–18 全部保留源编号与原预期，均为 **DRAFTED_NOT_EXECUTED**。ST-N03/09/10 可复用 checkpoint 修复的真实本地 PG 证据，但不因此签发整个新 ST 场景。ST-N04 所需“不同操作同 revision”不能用已有“同键 commit+duplicate”替代；ST-N15 所需运行中撤权不能用已撤权凭据拒绝替代；ST-N02/11/16/17 的故障边界没有被普通成功测试证明。ST-N12/13/18 所需在线 Health/Shadow 故障观察尚不存在。

既有 CapabilityMap 的 checkpoint 幂等缺口仅在已修复的精确源范围被后续 checkpoint 证据取代；其他能力缺口及生产是否部署均不能由此推导。只记录已观察到的错误 duplicate、跨 context 错误标注及历史 null CAS 绕过，没有声称发生过真实生产事故、双提交或双 Receipt。

当前继续优先完成 R07–R10 / A01–A11 当前适用 P0。准备无需新增授权；正式 Freeze 需先明确新旧基线的适用对象与冲突处置，且满足原有接受条件。R11 仍需实际合格 controller/actor、已接受 profile、精确动作授权、运行配置及停止/撤权/预算/证据落点；本次全部未替代。HS2 只在已有条件满足后按精确非生产注入/恢复授权执行，HS3 不因准备或 Repairability 单项通过而自动获权。

**Step12–14 Local Warning 不是 R11；合同草案不是 Freeze；历史 Naming/Skill 接受不是新 S1–S6 运行时验收。** 具体顺序冲突及未生效的最小修订建议见 `ReviewFindings.md`。
