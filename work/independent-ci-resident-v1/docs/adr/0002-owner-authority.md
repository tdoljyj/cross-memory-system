# ADR 0002：Owner 授权由每批 UAC 换成三层

- 状态：生效
- 日期：2026-10-21
- Owner Decision：`0d84ddbb` 第 1 项
- 档案：DESIGN §0、§4

## 背景

每批一次 UAC 既慢，也挡不住真正的风险（见 [ADR 0001](0001-permission-separation.md)）。

Agent 用的就是 Owner 的 GitHub 身份，所以 GitHub 上的批准证明不了 Owner 本人在场（resident constraint `22c20e14`）。

## 决定

Owner 的授权分三层，三层都无法从普通用户会话伪造：

1. **安装时的一次 UAC**。钉住确切的 Source 清单、常驻层清单、`policy.json`（哈希写进服务启动参数）、服务宿主哈希和代理的助手白名单。这就是对这个 Source 的常设授权。换 Source 要 Owner 接受，再走原地升级或重装。
2. **每批第 1 段的 KooYomi 实时准入**。检查 claim、fence、write_set、计量。改到受保护路径时，要对确切 head 的 `repo.protected_change` Grant，它只能来自 Owner 登录的页面，或 Owner 的自动审批开关。之后每段的发布都照旧实时复验。
3. **急停**。任何 Owner 会话进程都能暂停，只有提权的 Owner 能恢复；Owner 也可以在 KooYomi 撤销 ci-admission Binding，所有批次立即 fail closed。

复位、恢复、中止只能由提权的 Owner 写进 `owner\`（只有 Administrators 能建文件）。每个请求点名审过的确切字节摘要，服务按比较交换执行。

## 理由

- KooYomi 的 Owner Grant 只能来自 Owner 登录的页面，是现成的、能证明 Owner 本人的通道。
- 没选每批一个 Grant：它需要服务端迁移、新门禁和生产发布；而自动审批开着时，它退化成"多一条审计记录"。

## 后果

- 每批 0 次人工。
- Owner 只在安装或升级、复位、恢复、中止时出现。
- 原地升级以后也改为 Grant（[ADR 0014](0014-in-place-upgrade.md)），可以由自动审批代批（[ADR 0012](0012-upgrade-auto-approval.md)）。
