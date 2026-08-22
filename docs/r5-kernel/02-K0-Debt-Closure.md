# Clued Kernel R5 K0 债务关闭与 K2 解锁准备

- 日期：2026-08-22
- 修复分支：`r5-kernel-k2-debt-closure`
- 受测产品提交：`653417a29b8e079b5e49db8dce4480261c728585`
- 上游起点：`main@af135bf7908b483deafb4b35688221397ca00aab`
- 裁决：`K0_DEBT_REMEDIATED / K2_LOCKED`

## 1. 边界

本轮只关闭 K1 收据保留的 12 项 K0 已知债务，不改写 K0 的历史 `NO_GO` 裁决，不解锁 K2，不启用语义召回，不执行 release/deploy，也不修改真实 Binding。

## 2. 修复

1. 正常卸载现在会精确删除 P0-1 原子安装写入的 `bindings/<id>/state.json`，再删除已变空的 Binding 目录；卸载后校验同步覆盖 `state.json` 残留。
2. 新增卸载回归测试，证明 `state.json` 与 Binding 目录均被彻底清除。
3. HEURISTIC H4 不再把某个历史执行环境的特定 doctor FAIL 签名写死为产品前提；与 H1-H3 一致，改在临时沙盒中 mock sync doctor PASS，验证 Controller 对 PASS 的稳定分类。

## 3. 验证结果

- 卸载专项：`12/12 PASS`
- Clued E2E：`8/8 PASS`
- HEURISTIC 关闭测试：`4/4 PASS`
- K1 架构与合同冻结：`9/9 PASS`
- 同步层：`70/70 PASS`
- Memory Engine：`55/55 PASS`
- MIV-005A 合同：`19/19 PASS`
- 全量矩阵：`552 PASS / 0 FAIL / 0 SKIP`（39 个测试文件）
- 最终候选树密钥扫描：451 文件，`0` 命中

新增 1 个卸载回归用例，因此全量测试总数由 K1 的 551 增至 552。K1 历史收据与其 `539 PASS / 12 FAIL / 551 total` 结果保持不变，本报告以增量证据证明 12 项债务已关闭。

## 4. K2 门禁状态

冻结合同列出的前四项条件现已满足：K1 合同通过、K0 回归已修复、新鲜全量回归全绿、密钥扫描零命中。K2 仍保持 `LOCKED`；唯一剩余条件是新的、明确的 K2 授权。
