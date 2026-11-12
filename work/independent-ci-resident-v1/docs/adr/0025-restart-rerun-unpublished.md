# ADR 0025：重启打断的批次，能证明没发布就自动重跑一次

- 状态：已实施（分支 `claude/restart-rerun-open-batch`，未安装）
- 日期：2026-11-12
- Owner Decision：沿用 `1b5d3687`（唯一的自动 attempt 2）、`eaa7d5e4`（常驻码可选 attempt 2）；Owner 2026-11-12 指派本任务
- 档案：DESIGN §71（§6.2、§6.5、§7.2、§27）
- 代码：`R/src/executor.mjs#recover`、`#restartedUnpublished`、`#lockHeldInEarlierBoot`；`R/src/service-main.mjs`；`R/src/classify.mjs#ATTEMPT2_RESIDENT_CODES`；`R/src/failure-table.json`
- 测试：`R/test/restart-rerun.test.mjs`

## 背景

2026-11-12 TURING 在批次中途重启。崩溃恢复记 `EXECUTOR_RESTARTED_WITH_OPEN_BATCH`，整机 HALT。Owner 要点 UAC 复位，再推空提交。

HALT 当初的理由：

- 新进程看不到旧进程留下的子进程；
- 检查可能已发布或发布到一半；
- attempt 2 只能在发布之前排。

## 决定

崩溃恢复对一种情形改为 `FAILED_CLEAN EXECUTOR_RESTARTED_UNPUBLISHED`，烧 attempt 1 的 head，排唯一的 attempt 2，不 HALT。条件全部成立才走这条路：

1. **上一次开机。** 服务接管执行器锁之前，用单实例锁同一条规则判断锁的持有者来自上一次开机。只有本进程第一次恢复时看到的条目算数。
2. **普通中断。** 不在停靠点 B，不在 Owner 中止或自己收尾的途中，第 R 段不在半截。
3. **没发布。** 没有已转发的角色。这个 head 没有 `executed-heads` 记录（每个发布段开始前先写这条记录）；例外是本批次自己“第 R 段之前”的那一条，且计划什么都没转发。
4. **没有 HALT，没有字节漂移。**
5. **两端现取静止证明。** 最多等 15 分钟，等 companion 和 WSL 起来。

任何一条不成立，照旧 HALT。

## 理由

- 进程：上一次开机的 Windows 进程已被内核全部结束；Linux 的证明每次现取。
- 发布：发布段开始前的“只能新建”记录是持久证据，写到一半也算“可能已发布”。
- 只执行一次：attempt 2 仍然至多一次，只在发布之前。

三条安全保证都没有削弱。

## 后果

- 节点在第 0–2 段（含工作区准备）重启：不再 HALT，不用 UAC，不用推空提交，约 10 分钟后 attempt 2 自动重跑。
- 在第 R 段、第 3 段及以后重启：照旧 HALT。同一次开机里执行器自己崩溃：照旧 HALT。attempt 2 又被重启打断：干净关闭但不再重跑，要推新提交。
- 开机后的第一个 tick 最坏阻塞 15 分钟，等两端静止。
- `instance-lock.mjs`、`upgrader/src` 都没改，升级器的冻结副本不变。
