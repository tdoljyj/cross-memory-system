# P0 实测分类

| ID | 实测分类 | P0 证据 | 裁决 |
|---|---|---|---|
| D01 | 真重复 | Remote 未变 warm 平均 `ls-remote` 2.00 次/请求 | P1 可优先统一为一次请求内查询，但每个需新鲜度的请求仍至少一次 |
| D02 | 真重复/条件边界 | Remote Ahead 可观察外部预检后，pull 再次查询并执行 fetch/merge | 只建议 P1 统一入口；工作树隔离属于 P3，不越权实现 |
| D03 | 表面重复 | Manifest 源损坏与复制后目标损坏在不同 Fixture 边界均独立阻断 | 两侧哈希必须保留，不去重 |
| D04/D05/D18 | 条件重复 | doctor/recall 每个新进程都重新完整验证；内部 hash 阶段无法单独计时 | 只能在未来请求内 Context 且满足全部失效条件时讨论；不属于 P1 实现 |
| D06/D07 | 不必要工作 | T1 warm `sources_read` 中位数=16.0；T3=15.0 | 证实读取范围热点；归属 P4，本轮不实现 |
| D08/D19 | 架构热点/非等价来源 | 在线 Canonical current 无授权测量接口；Snapshot status 只能证明离线投影 | 不得以 Git/Snapshot 指标替代 Canonical current |
| D10 | 条件重复 | Remote 未变 warm 仍生成 Backup 的记录数=20/20 | 归属 P3；P0 只记录成本与现象 |
| D11–D16/D21 | 表面重复 | 未触碰生产 Auth/RLS/CAS/Event/Receipt/发布边界 | 保留独立不变量，不以缺测推断可去重 |
