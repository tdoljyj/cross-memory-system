# P0 → P1 优先级建议（不含实现）

> 本文只提出 P1 优先级，不授权也未实施 P1–P6。

## P1-1（最高）：统一一次请求内 Remote Head 解析

- 证据：Remote 未变 cold/warm 的 `ls-remote` 平均分别为 2.00 / 2.00 次/请求。
- 建议验收：同一请求只解析一次具体 Commit SHA；新请求、重试、TTL 失效仍重新查询；F01 正负路径与 G01 不变量不削弱。
- 禁止：缓存跨请求 PASS、跳过 Remote Head、用 mtime/本地 tracking ref 替代远端真实 Ref。

## P1-2（高）：让 fetch/merge 只由统一 align 入口负责

- 证据：Remote Ahead warm 观察到 `fetch` 1.00 次/请求、`merge` 1.00 次/请求，同时仍有前置 Remote Head 查询。
- 建议验收：Fast-forward 与真分叉继续用双向 ancestor 判定；真分叉保留证据并阻断；不得引入 rebase/reset/force push。
- 边界：开发工作树隔离与 Mirror 原子切换是 P3，不应混入 P1。

## P1-3（中）：冻结错误分类与阶段证据格式

- 将 Remote UNAVAILABLE、dirty worktree、Git divergence 分为独立错误类型，保留退出码、阻断位置和远端/本地版本证据。
- 先建立 F01/F05/F06 的控制与故障回归门禁，再评估任何去重收益。

## 不进入 P1 的观测

- T1/T3 读取范围、Snapshot no-op/Backup、Canonical-first 分别属于 P4/P3/P4；本轮只登记，不建议在 P1 顺手实现。
