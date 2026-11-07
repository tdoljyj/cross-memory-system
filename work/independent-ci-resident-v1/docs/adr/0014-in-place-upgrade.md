# ADR 0014：原地升级通道

- 状态：生效
- 日期：2026-10-29（常驻层接线）；2026-10-31（升级包沿用已装的接受 ref）
- Owner Decision：
  - `dda41297`：建立原地升级通道。第 3 项为失败自动回滚。
  - `3ce5200c`：升级连接规则。其第 2 项后来被 [ADR 0012](0012-upgrade-auto-approval.md) 取代。
  - `b1dd8a84`：升级包沿用现装包的接受 ref。
- 关联：Task `018da927`
- 档案：DESIGN §34、§42

## 背景

起初，换一次 Source 就要整套卸载重装：一次 UAC、一次 root、先排空，Owner 前后约 12 个步骤。重装之后也没有上一代可以回滚。

## 决定

- 每个节点装一个升级代理 `CluedCIUpgrader`，以 LocalSystem 运行。它只认 Owner 在 KooYomi 上对精确包哈希的批准（Grant 资源为 `ci-resident:<node>/<包 sha>`）。
- 升级流程：
  1. ACCEPT；
  2. 取得 Grant；
  3. 暂停接新，等在跑的批次结束，进入 PAUSE；
  4. Windows 和 Linux 两侧暂存新版本；
  5. 停服、切换、启动；
  6. 校验；
  7. 自己解除 PAUSE；
  8. 保留最近 3 代。
- 停服之后，任何一步失败都会自动回滚到上一代，保持暂停，并通知 Owner。
- 升级代理本身和它导入的模块是冻结的。包里改到了这些文件，就会被拒（`UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL`），只能整套重装。
- 打包工具在仓库里（`rollout/build-upgrade.ps1`）。同一输入构建两次，必须得到同一个包 sha。多节点滚动编排用 `rollout/rollout.mjs`。

## 理由

- 升级变成对一个精确哈希的批准，信任模型与人工比对哈希相同。
- 有了自动回滚，升级失败的代价从"节点停摆"降为"留在上一代并暂停"。

## 后果

- 普通的一代升级不再需要 UAC。
- 涉及冻结范围的改动，要攒到下一次整套重装再上（见 `rollout/INSTALL-BATCHES.md`）。
- 节点身份、目录布局、ACL、秘密都不走这个通道。
