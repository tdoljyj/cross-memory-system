# P0 局限与不可观测项

## UNOBSERVABLE

- 未调用生产 Clued Canonical/Auth/Binding/Scope/RLS 接口，因此在线 `latest/current`、撤销、租户隔离与服务端 CAS 不能从本 Harness 量化。
- 现有 Python 命令没有外部阶段边界；流式哈希、复制、原子 rename 和 Backup 的纯耗时不能可靠拆分。报告仅给出 Git Trace2 阶段与剩余聚合时间。
- 无内核级文件访问追踪器，因此 T0 的“零文件读取 syscall”不可直接证明；可证明的是命令早退、零 Git 子进程与零文件状态变化。
- Windows 页缓存未清空；cold 表示新进程及（适用时）新 Fixture/空 Mirror，不等价于物理冷盘。
- 复制中途的纳秒级竞态注入无法在不改核心/不加埋点的条件下稳定完成；以复制后副本损坏并运行同一 Validator 作为外部可重复负测。
- Backup 删除、Legal Hold、Erasure 与同机并发策略属 P3/G09/G10 目标态，本轮不执行。
- 网络结果受当时 GitHub 与本机代理/链路影响，只代表本次运行窗口。

## BLOCKED_BY_BASELINE

- 本次固定 Commit 的一次性 Clone 未出现 `legacy-root-entry:session`；未创建、修复或删除该条目。

## 脱敏

- 原始结果中的邮箱、Token、Bearer、Client Secret、Owner Ref、UUID 和用户目录均已替换为占位符。
- 未记录原始 Supabase User ID 或稳定跨范围身份映射。
