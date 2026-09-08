# 已有空 runtime 的 600 秒后继

`alter.candidate.sql` 只 CREATE OR REPLACE 原 `reserve_execution_budget(text,text)` 和 `reserve_gate(text,text)`。四处 180 常量变为 600：固定预留秒数、总额度比较、一次扣款、完整 GA 有效期上限。没有建表、删行、修改权限或重建 Root。

事务内前置检查锁住原 Root 与五张空 runtime 表，验证固定项目、真实当前 gen2/sequence2、Owner 期限以及两个函数原 `prosrc` 摘要。主控仍须保全并对比实际 14 函数定义/权限、Root 三表和空表状态；源码快照不能代替实际数据库观察。`PriorInstalledFunctionSources.json` 保全原 Root 三函数和原 runtime 十一函数来源。

总 7200 秒/1 GiB、一次预留的 128 MiB、新键幂等和旧历史、单 pending/active、未知保留额度以及 Owner 结束时间不变。真实 seed 使用已核 prior 1500 秒/287700424 字节；不重置为零，不二次扣除同一预算。候选不能部署或签发；本次独立定点 PostgreSQL 结果由独立接受者记录。
