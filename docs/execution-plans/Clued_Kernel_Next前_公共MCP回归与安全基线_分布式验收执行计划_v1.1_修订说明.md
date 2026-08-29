# Clued Kernel Next 前公共 MCP 回归与安全基线分布式验收执行计划 v1.1 修订说明

状态：`APPROVED`

批准日期：2026-08-29（Asia/Shanghai）

批准者：验收计划 Owner（用户明确授权）

基于：`Clued_Kernel_Next前_公共MCP回归与安全基线_分布式验收执行计划_v1.0.md`

## 1. 修订原因

v1.0 将 GitHub Required Checks 写为 A11 的不可妥协通过条件，但没有披露：私有仓库的平台级 Branch Protection/Ruleset 在 GitHub Free 下不可用。候选仓库的只读 API 已返回 403，并明确要求升级付费套餐或公开仓库。

验收计划不得以未披露的付费能力作为唯一通过路径，也不得要求为规避成本而公开包含真实项目历史的私有仓库。因此 v1.1 以平台无关、可机器复算的 Gate Receipt 替代付费 Required Checks，同时保留四门禁 fail-closed、安全证据与 Owner 独立授权边界。

v1.0 记录保持不变；任何 v1.1 裁决必须标明所依据的计划版本，不得追溯改写 v1.0 的历史状态。

## 2. A11 替代条款

对于不提供私有仓库 Required Checks 的免费托管套餐，A11 的“目标分支 Required Check 名称与四个固定名称 4/4 一致”替换为以下全部条件：

1. 候选 PR 必须在同一精确 40 位 Git Commit SHA 上运行四个唯一检查：
   - `public-mcp-protocol`
   - `public-mcp-behavior`
   - `gitleaks`
   - `trivy`
2. Gate Receipt 验证器必须通过 GitHub Checks API 查询该精确 SHA，不得接受分支名、旧提交、其他 PR 或手工声明的结果。
3. 四个检查必须全部存在、状态为 `completed`、结论为 `success`。`neutral`、`skipped`、`cancelled`、缺失、运行中、超时或任何失败均不得签发 PASS。
4. Gate Receipt 必须包含候选 SHA、PR、四个 Check Run ID/URL/结论、核验时间和合同版本，并生成 SHA-256 摘要。
5. 四类一次性受控失败必须分别证明对应检查非零退出；失败 Fixture 不得合并到候选分支。
6. Workflow 不得包含 `continue-on-error`、无条件成功或吞掉退出码的路径。
7. Gate Receipt 只证明技术门禁；`merge_authorized` 和 `deployment_authorized` 必须固定为 `false`。合并或部署仍需验收计划 Owner 针对精确 SHA 的后续独立明确授权。

## 3. v1.1 A11 通过标准

A11 在以下条件同时满足时可判为 PASS：

- 干净候选四门禁 4/4 成功；
- 四类受控失败 4/4 能使对应门禁失败；
- 静态检查确认不存在失败吞噬；
- Gate Receipt 对候选精确 SHA 签发 `PASS`，摘要可复算；
- Evidence 明确记录仓库套餐限制与本替代控制；
- 本轮合并数和部署数均为 0。

平台级 Required Checks 在 GitHub Free 私有仓库下记为 `NOT_APPLICABLE_BY_APPROVED_V1_1_SUBSTITUTION`，不再单独阻断 v1.1 裁决。

## 4. 完整性底线修订

v1.0 §5.3 第 9 条替换为：

> A11 四门禁未在同一精确候选 SHA 上 4/4 成功、受控失败不能使对应门禁失败、Gate Receipt 缺失或不可复算、存在失败吞噬，或没有 Owner 独立合并授权边界。

其余 P0 条款保持不变。尤其是 A03 生产 OAuth + PKCE 只读验收、A12 完整 Evidence 闭环和 A13 在 A12 后的独立复验不得因本修订而跳过或降级。

## 5. 安全与权限边界

本修订不授权合并、部署、生产访问、Binding/Secret/DNS/Schema/Migration 变更，也不把 CI 绿色等同于发布授权。
