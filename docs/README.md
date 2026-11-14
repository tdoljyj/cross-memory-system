# BeamingFace 工程文档导航

本目录只承载仍需要留在 Git 中的工程文档、合同、迁移/回滚材料、验证证据与历史追溯资料。它**不是 BeamingFace（原 Clued）当前运行状态或业务 Canonical Truth 的来源**。

先看：

- [仓库根 README](../README.md)：产品、生产架构、Currentness / Projection、数据世代与仓库地图。
- [AGENTS.md](../AGENTS.md)：Agent / Coding Agent 的仓库操作、最小读取、Currentness 与 Git 纪律。
- [External Document Archive](./EXTERNAL_DOCUMENT_ARCHIVE.md)：已迁往 Google Drive 的研究、战略、品牌、评审、Closeout 等叙事资料边界。

## 状态语义

- 仓库 Markdown、JSON、SQL、Snapshot 和历史 Gate 材料都不能仅凭“文件存在”升级为 CURRENT、Frozen 或 Production Authority。
- 当前/下一步状态必须经过对应 Canonical Record / Decision / Event / Receipt、Runtime Evidence 与 Currentness / reconciliation 验证。
- 目录名中的 `current`、`final`、`accepted`、`freeze`、`baseline` 等词只描述该文件在其原始阶段中的语义；不得脱离版本、来源和后继关系解释为今天的在线状态。
- 历史 FAIL、被替代版本、旧 Gate 和迁移证据仍可能具有审计价值，因此默认保留，但不作为当前入口。

## 目录导航

| 路径 | 内容 | 当前使用方式 |
|---|---|---|
| [`clued-two-level-views/`](./clued-two-level-views/) | 两级五视图、单一数据源、Bundle、迁移/回滚与相关验收材料 | 架构/迁移参考；在线 Current Truth 仍来自认证 BeamingFace 服务 |
| [`r5-kernel/`](./r5-kernel/) | R5 Kernel 架构、合同、Debt Closure、Cloud Data Foundation、Gate/Evidence | 历史/阶段性 Kernel 工程资料；不要据此直接判断当前 Kernel 状态 |
| [`r5.1/`](./r5.1/) | R5.1 Beta Candidate、限制与 Receipt | 历史验收与追溯 |
| [`r3-gate0/`](./r3-gate0/) · [`r3-gate1/`](./r3-gate1/) · [`r3-gate3/`](./r3-gate3/) | R3 各 Gate 的 ADR、Schema、Baseline 与 Evidence | 封存/追溯，不作为当前运行入口 |
| [`execution-plans/`](./execution-plans/) | 历史和阶段性执行计划、Phase 2 结构治理验收/失效规则与 Evidence | 仅在核对精确版本/Authority 后使用；计划文件本身不授予当前执行权 |
| [`history/`](./history/) | 已退出当前入口但仍需保留的旧架构、配置和冲突记录 | 历史只读，不作为当前事实 |
| [`maintenance/`](./maintenance/) | 仓库维护、分支清理等工程记录 | 仓库维护证据 |
| [`EXTERNAL_DOCUMENT_ARCHIVE.md`](./EXTERNAL_DOCUMENT_ARCHIVE.md) | Google Drive 外迁边界、目录与校验说明 | 查找已外迁叙事资料时使用 |

## 常用精确入口

这些文件仍有明确工程用途，但其标题中的阶段/状态词不自动代表当前在线状态：

- [R5 Kernel Architecture and Contract Freeze](./r5-kernel/01-Architecture-and-Contract-Freeze.md)
- [R5 K0 Debt Closure](./r5-kernel/02-K0-Debt-Closure.md)
- [两级五视图单一数据源架构方案 v1.6](./clued-two-level-views/Clued_单一数据源与两级五视图架构方案_v1.6.md)
- [两级五视图 ADR](./clued-two-level-views/01-ADR-两级五视图单一数据源.md)
- [Phase 2 Acceptance & Invalidation](./execution-plans/phase2-structure-governance/AcceptanceAndInvalidation.md)

## CI 检查的范围

[`clued-cloud-tests`](../.github/workflows/clued-required-tests.yml) 在每个 PR 和每次推送 `main` 时运行 lint、账本校验、类型检查、构建及单元测试，不按路径过滤；同一工作流里的 `ci-suites` 按改动路径选跑仓库其余测试套件。

代码、依赖、配置、被排除的治理文档路径、数据库安全与迁移账本文档仍走完整应用检查；比较数据缺失、分类失败或身份不一致也会回到完整检查。准入、扫描和其它适用检查各自执行。

## 文件放置原则

仓库只保留与代码、协议/合同、ADR、Schema/Migration、测试/Fixture、Runbook、Skill、构建/部署配置、当前执行控制或可复现机器 Evidence 直接相关的文档。

产品研究、战略、商业、品牌、视觉、汇报、会议/对话整理、历史评审、验收/Closeout 长报告和办公类资料统一放 Google Drive；不要重新在 `docs/` 中建立一套叙事资料中心。

新增文档前先判断：

1. 是否直接服务工程执行、验证、审计或发布？
2. 是否需要固定路径被代码、测试或合同引用？
3. 是否属于长期叙事/研究/汇报内容，应该进入资料中心？
4. 是否会因为文件名或位置让读者误以为它是“当前状态”？

无法证明需要留在仓库的叙事资料，不新增到 `docs/`。

## 清理原则

只删除能够明确证明同时满足以下条件的内容：

- 已有正式后继；
- 不再承担合同、测试、迁移、回滚、审计或固定路径引用；
- 删除不会破坏历史可追溯性。

“旧”本身不是删除理由；“文件存在”也不是当前性的证明。
